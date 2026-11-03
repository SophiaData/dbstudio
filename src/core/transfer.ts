/**
 * 流式导出任务的跨进程契约（renderer ⇄ main ⇄ driver-host）。
 *
 * ===== 这一层要解决的真实矛盾 =====
 *
 * 导出十万行时，**数据不能经过渲染进程**。DBeaver 在单进程内可以直接把
 * ResultSet 交给导出器逐行读；我们是多进程的，一旦让行先落到 renderer
 * 再回传给 main 写文件，内存占用就与总行数成正比——这正是 Beta 退出门槛里
 * 明确禁止的「renderer 内存随总行数线性增长」。
 *
 * 所以链路是：
 *
 *   renderer ──startTransfer──▶ main(TransferManager) ──open/read──▶ driver-host
 *        ▲                          │  持有文件句柄                        │
 *        └───getTransferProgress───┘  逐批拉取、边拉边写                   │
 *
 * renderer 只知道「任务 id + 进度」，**永远看不到行数据**。
 *
 * ===== 为什么本轮用「分页读取」而不是「真实流式游标」=====
 *
 * 现有 adapter 的 `fetchResultPage` 是**重新执行** `SELECT * FROM (原 SQL) LIMIT n OFFSET m`
 * （见 `src/drivers/sqlite/results.ts` 文件头）。这意味着：
 *
 *   - 它**不是快照**：导出过程中底层表若被并发修改，分页之间的行可能重复或遗漏。
 *   - 它**不是快照**这件事必须被如实告知，不能把导出的文件说成"某时刻的数据"。
 *
 * 本轮接受这个限制，并在契约里用 `consistency: 'live-paged'` 显式标注，
 * 让 UI 与用户都能看到"这是一次分页读取的结果，不保证是时间点快照"。
 * 真正的流式游标（SQLite `iterate()` / PG `DECLARE CURSOR`）留到后续阶段：
 * 它要改 adapter 契约与取消语义，不是"顺手加一个方法"能覆盖的。
 *
 * ===== 内存有界 =====
 *
 * 导出全程只持有**一个批次**的行（`batchSize` 行）。行读完即写、随即丢弃，
 * 内存占用与总行数无关。
 *
 * ===== 截断值一律拒绝 =====
 *
 * 结果集通道会把超长文本截断到 `MAX_CELL_TEXT_CHARS`（1000 字符）、
 * BLOB 截断到 256 字节预览。导出若拿到这种值还照写，产出的文件就是**错的**
 * （用户以为导出了完整数据，实际是预览）。所以：
 *   - 遇到 `truncated: true` 的单元格 → 任务失败，并明确说明是哪个列/行；
 *   - 不做"悄悄写预览"，也不做"截断后照写"。
 *
 * 完整值需要按单元格回查（`fetchCellValue`），而回查在分页模式下
 * 同样要重跑 SQL、且行号可能已经错位——所以本轮**不做**自动回查，
 * 直接拒绝并把限制写清楚。
 *
 * ===== SQLite 文本里的 NUL：由驱动在数据库侧拒绝 =====
 *
 * 上面的 `truncated` 标记只覆盖**通道层**的截断（长文本 / 大 BLOB）。
 * 但 SQLite 的 `node:sqlite` 绑定层还有**另一处**截断，
 * 它发生在值到达我们之前，因此 `truncated` 标记根本不会出现：
 *
 *   存 `a\0b`（含 NUL 字节的 TEXT）→ `SELECT v` 返回的 JS 字符串是 `"a"`，
 *   而 `hex(v)` 仍是 `610062`（原始三字节）。
 *
 * 也就是说 NUL 之后的内容在**驱动绑定层**就被丢掉了。值到达导出层后，
 * 与 `truncated` 检查都看不到任何异常；如果只靠 JS 侧检查，
 * 会**静默**写出少了后半截的内容。
 *
 * PostgreSQL 不受影响：服务端直接拒绝含 NUL 的字符串
 * （`ERROR: null character not permitted`），值根本进不来。
 *
 * SQLite 驱动因此在数据库侧验证：把查询结果按列位置包进 CTE，并用
 * `typeof(value) = 'text' AND instr(value, char(0)) > 0` 检查原始值。
 * 发现 NUL 时整页查询失败，错误会带行号、列名和 U+0000 原因；
 * 首批、后续分页以及导出使用的游标读取都经过这条路径。
 * BLOB 中的 0x00 不受影响，因为它本来就能完整往返。
 */

import type { CsvColumn, CsvError, CsvRow } from './csv'
import type { CellValue } from './resultset'

/** 导出格式。四种，与计划书 P2.1 的验收清单一致。 */
export type TransferFormat = 'csv' | 'jsonl' | 'json' | 'sql-insert'

/** 导出格式的合法取值集合。宿主与主进程共用同一份，避免两边各写一个字面量。 */
export const TRANSFER_FORMATS: readonly TransferFormat[] = ['csv', 'jsonl', 'json', 'sql-insert']

/** 导出结果的一致性语义。 */
export type TransferConsistency =
  /**
   * 逐页重新执行的读取结果（当前实现）。
   *
   * 导出期间底层数据若发生并发修改，**不同批次看到的不是同一个时刻的数据**，
   * 行可能重复或缺失。这是分页读取的固有限制，不是 bug——但必须诚实标注，
   * 绝不能把导出文件描述成"快照"。
   */
  | 'live-paged'

/**
 * 任务状态。终态是 completed / failed / cancelled 三者之一。
 *
 * `committing` 表示已进入**不可取消**的原子发布阶段（临时文件已就绪，
 * 正在 rename 到目标路径）。单独暴露它，是为了让 UI 能诚实地告诉用户
 * "这一步已经无法取消"，而不是让用户点了取消却发现文件还是写出来了。
 */
export type TransferStatus =
  | 'queued'
  | 'running'
  | 'committing'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 任务进度快照。renderer 只读这个结构，永远读不到行数据。 */
export interface TransferProgress {
  readonly taskId: string
  readonly status: TransferStatus
  /** 已从源读取的行数。 */
  readonly rowsRead: number
  /** 已写入目标文件的字节数。 */
  readonly bytesWritten: number
  /** 已读取的批次数。 */
  readonly batches: number
  /** 失败/取消原因；其它状态为 undefined。 */
  readonly message?: string
  /** 目标文件路径（任务创建时确定，便于 UI 显示进度时告知写到哪里）。 */
  readonly destinationPath: string
  /** 一致性语义，恒为 'live-paged'（见文件头说明）。 */
  readonly consistency: TransferConsistency
  /** 目标文件的最终路径；成功前为 undefined（失败/取消时目标文件保持原样）。 */
  readonly committedPath?: string
}

/** 导出来源。表来源与查询来源二选一。 */
export interface TransferSource {
  /**
   * 对象节点 id（`connection:c1|table:users`）。
   *
   * **表来源**：由驱动宿主解析成 SELECT 语句与 INSERT 目标。
   * 主进程不解析驱动私有的 id 编码（PG 的 id 带 schema），这是既定边界。
   */
  readonly nodeId?: string
  /** 查询来源：自由 SQL。必须配合 `nodeId`（连接根节点）或 `connectionId` 定位连接。 */
  readonly sql?: string
  /** 连接 id（`c1`）。与 `nodeId` 同时给出时必须指向同一个连接，否则拒绝。 */
  readonly connectionId?: string
}

/** 导出选项。 */
export interface TransferOptions {
  /** CSV / JSONL / JSON 是否写表头。默认 true。 */
  readonly includeHeader?: boolean
  /**
   * NULL 的文本表示。默认 `''`（CSV 语义）。
   *
   * 显式拒绝空字符串之外还需要谨慎的取值：写入 SQL INSERT 时，
   * NULL 必须写成 `NULL` 关键字而不是任何文本，所以 `nullText` **只影响
   * CSV / JSONL / JSON**；`sql-insert` 恒用 `NULL`。
   */
  readonly nullText?: string
  /** 每批行数。默认 200，上限 1000（与 adapter 的页大小上限一致）。 */
  readonly batchSize?: number
  /** CSV 行分隔符。默认 `\r\n`（RFC 4180）。 */
  readonly newline?: '\r\n' | '\n'
  /** JSON 缩进。默认 2（与既有导出行为一致）。仅对 `json` 生效。 */
  readonly jsonIndent?: number
}

/** 导出请求（渲染进程 → 主进程）。 */
export interface TransferRequest {
  readonly source: TransferSource
  readonly format: TransferFormat
  /** 目标文件绝对路径。临时文件由主进程在**同目录**创建。 */
  readonly destinationPath: string
  readonly options?: TransferOptions
}

/**
 * 导出目标（INSERT 的落点）。
 *
 * `kind` 是必需的：视图不能作为 INSERT 目标，
 * 把视图当表导出会生成一条注定失败的 INSERT。
 */
export interface TransferTarget {
  readonly schema?: string
  readonly name: string
  readonly kind: 'table' | 'view'
}

/**
 * 驱动宿主对「对象节点」的解析结果。
 *
 * 由 adapter 提供（可选方法 `resolveTransferSource`），因为**驱动私有的
 * id 编码只有驱动自己懂**：PostgreSQL 的表 id 是 `table:<schema>.<name>`，
 * 主进程若自己去切冒号就会把 `schema.name` 整体当成表名，
 * 生成出 `SELECT * FROM "public.users"` 这种错的 SQL。
 */
export interface TransferSourceResolution {
  /** 读取该对象所需的 SELECT 语句。 */
  readonly sql: string
  /** INSERT 落点（视图也有，但 kind 会是 'view'）。自由 SQL 来源没有这个字段。 */
  readonly target?: TransferTarget
}

/** 导出任务在主进程内的最终结果（等待任务结束时返回）。 */
export interface TransferResult {
  readonly taskId: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly rowsRead: number
  readonly bytesWritten: number
  readonly destinationPath: string
  /** 成功时的最终路径；失败/取消为 undefined。 */
  readonly committedPath?: string
  readonly message?: string
}

// ---------------------------------------------------------------------------
// CSV 导入（P2.3）
// ---------------------------------------------------------------------------

/** 导入任务状态。终态是 completed / failed / cancelled。 */
export type ImportStatus =
  | 'queued'
  | 'running'
  | 'committing'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * 导入请求（renderer → main）。
 *
 * `targetColumns` 按 CSV 列位置一一对应，而不是按表头名字自动猜：
 * CSV 表头与数据库列名经常不同（例如 `email` → `email_address`），
 * 自动猜错会把值写进错误列。长度必须与 CSV 列数一致；本阶段不支持跳过列。
 */
export interface ImportRequest {
  /** 目标表节点 id（`connection:c1|table:users`），由驱动解析表名。 */
  readonly targetNodeId: string
  /** 本机 CSV 文件的绝对路径。文件只由主进程读取，内容不进入 renderer。 */
  readonly sourcePath: string
  /** 字段分隔符，必须是单个字符。 */
  readonly delimiter: string
  /** NULL 标记文本；只有未加引号且完全相等的字段才会被当作 NULL。 */
  readonly nullText: string
  /** CSV 是否有表头。 */
  readonly hasHeader: boolean
  /** CSV 列位置 → 目标表列名；长度必须等于 CSV 列数。 */
  readonly targetColumns: readonly string[]
  /** 每批写入数据库的行数。 */
  readonly batchSize: number
}

/** previewImport 请求；仅包含文件读取与 CSV 解析参数，不包含目标表或列值。 */
export interface ImportPreviewRequest {
  /** 本机 CSV 文件的绝对路径。文件内容只在主进程读取。 */
  readonly sourcePath: string
  /** 字段分隔符，必须是单个字符。 */
  readonly delimiter: string
  /** NULL 标记文本。 */
  readonly nullText: string
  /** CSV 是否有表头。 */
  readonly hasHeader: boolean
  /** 样例行上限；省略时使用默认值，不能超过硬上限。 */
  readonly sampleRowLimit?: number
}

/** previewImport 返回的有界 CSV 预览；不会包含完整文件内容。 */
export interface ImportPreview {
  readonly sourcePath: string
  readonly columns: readonly CsvColumn[]
  readonly sampleRows: readonly CsvRow[]
  readonly errors: readonly CsvError[]
  readonly errorCount: number
  readonly totalRows: number
  readonly truncated: boolean
  readonly delimiter: string
  readonly nullText: string
  readonly hasHeader: boolean
}

/** 兼容调用方对请求名称的简写。 */
export type PreviewImportRequest = ImportPreviewRequest

/** 一条待写入的 CSV 数据行。`rowNumber`/`lineNumber` 都从 1 开始。 */
export interface ImportBatchRow {
  /** 逻辑数据行号（不含表头与空白行），用于给用户定位。 */
  readonly rowNumber: number
  /** 物理行号（含表头与引号内换行）。仅用于诊断，不参与 SQL。 */
  readonly lineNumber?: number
  /** 值顺序必须与批次 `columns` 完全一致。 */
  readonly values: readonly CellValue[]
}

/** 驱动单次批量写入请求。 */
export interface ImportBatch {
  /** 从 0 开始的批次序号。 */
  readonly batchIndex: number
  /** 目标表的真实列名（由驱动白名单校验后规范化）。 */
  readonly columns: readonly string[]
  /** 非空批次。 */
  readonly rows: readonly ImportBatchRow[]
}

/** 驱动批量写入结果。 */
export interface ImportBatchResult {
  readonly rowsImported: number
  /** 为 true 表示该批次结束后事务仍打开，等待 commit/rollback。 */
  readonly inTransaction: boolean
}

/** 导入进度与失败位置。renderer 永远拿不到 CSV 行值。 */
export interface ImportProgress {
  readonly taskId: string
  readonly status: ImportStatus
  readonly totalRows: number
  readonly rowsImported: number
  readonly batches: number
  readonly sourcePath: string
  readonly targetNodeId: string
  readonly message?: string
  /** 逻辑数据行号；文件级错误为 undefined。 */
  readonly row?: number
  /** 物理行号。 */
  readonly line?: number
  /** CSV 列位置，从 1 开始。 */
  readonly column?: number
  /** CSV 列名或目标列名。 */
  readonly columnName?: string
}

/** 导入任务终态结果。 */
export interface ImportResult {
  readonly taskId: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly totalRows: number
  /** 成功提交的行数；失败/取消且回滚成功后为 0。 */
  readonly rowsImported: number
  readonly batches: number
  readonly sourcePath: string
  readonly targetNodeId: string
  readonly message?: string
  readonly row?: number
  readonly line?: number
  readonly column?: number
  readonly columnName?: string
}

// ---------------------------------------------------------------------------
// 主进程侧注入契约（TransferManager 的依赖注入接口）
// ---------------------------------------------------------------------------

/**
 * 一个已打开的导出来源。
 *
 * ===== 为什么是「拉取式」而不是「推送式」=====
 *
 * 推送式（宿主不停往 main 推行）要求宿主与 main 之间有一套带背压的流协议；
 * 拉取式（main 每次要一批）天然有背压：main 写完上一批才去要下一批。
 *
 * 本轮采用拉取式，`batchSize` 就是背压窗口。将来换成真实流游标时，
 * 只需把 `read()` 换成从流里取一批，TransferManager 的其余部分不动。
 */
export interface TransferSourceHandle {
  /** 结果集列名。SQL INSERT 用它生成列清单。 */
  readonly columns: readonly string[]
  /** 方言 id。主进程据此决定标识符引用与字符串字面量规则。 */
  readonly dialectId: string
  /**
   * INSERT 目标（表名 / schema）。
   *
   * 缺省表示"来源不是一张具体的表"（自由 SQL），
   * 此时 `sql-insert` 格式必须被拒绝——不能凭空编一个表名。
   */
  readonly target?: TransferTarget
  /**
   * 读下一批。返回 `done: true` 表示已到末尾（`rows` 为空数组）。
   *
   * 实现必须保证：**批次内的行是完整的**（未截断的值要么给全，要么拒绝）。
   * 驱动绑定层可能先于 `CellValue.truncated` 截断值时（例如 SQLite TEXT
   * 中的 NUL），驱动必须做数据库侧验证并明确失败，不能返回看似完整的半截值。
   */
  read(): Promise<{
    readonly rows: readonly (readonly CellValue[])[]
    readonly done: boolean
  }>
  /** 关闭源（释放游标/语句句柄）。必须幂等。 */
  close(): Promise<void>
}

/**
 * 打开一个导出来源。
 *
 * `batchSize` 是**请求的批大小**，实现可以 clamp 但不能无限放大——
 * 批大小直接决定主进程的内存占用。
 */
export type OpenTransferSource = (
  source: TransferSource,
  batchSize: number
) => Promise<TransferSourceHandle>

// ---------------------------------------------------------------------------
// 值 → 文本 / SQL 字面量
// ---------------------------------------------------------------------------

/** 默认批大小。与 adapter 的默认页大小一致（200）。 */
export const DEFAULT_TRANSFER_BATCH_SIZE = 200
/** 单批行数上限。与 adapter 的 MAX_PAGE_SIZE 一致，避免主进程内存被单批撑爆。 */
export const MAX_TRANSFER_BATCH_SIZE = 1000
/** 单批行数下限。 */
export const MIN_TRANSFER_BATCH_SIZE = 1

/**
 * 规范化批大小。
 *
 * 越界一律**拒绝**而不是静默 clamp：批大小是调用方显式给出的契约，
 * 静默改掉会让"我请求 5000 行"变成"其实只读了 1000 行"却无人察觉。
 */
export function normalizeTransferBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TRANSFER_BATCH_SIZE
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`批大小必须是整数，收到 ${String(value)}`)
  }
  if (value < MIN_TRANSFER_BATCH_SIZE || value > MAX_TRANSFER_BATCH_SIZE) {
    throw new Error(
      `批大小必须在 ${MIN_TRANSFER_BATCH_SIZE} ~ ${MAX_TRANSFER_BATCH_SIZE} 之间，收到 ${value}`
    )
  }
  return value
}

/**
 * 截断检测：导出遇到被截断的值必须**失败**，不能写预览。
 *
 * 返回被截断的位置（列下标与行下标），用于错误消息——只说"有截断值"，
 * 用户根本不知道是哪一列的问题。
 */
export function findTruncatedCell(
  rows: readonly (readonly CellValue[])[],
  rowOffset: number
): { row: number; column: number } | null {
  for (let r = 0; r < rows.length; r += 1) {
    const cells = rows[r]
    if (cells === undefined) continue
    for (let c = 0; c < cells.length; c += 1) {
      const cell = cells[c]
      if (cell === undefined) continue
      if ((cell.kind === 'text' || cell.kind === 'blob') && cell.truncated) {
        return { row: rowOffset + r, column: c }
      }
    }
  }
  return null
}

/** CSV 字段转义（RFC 4180）：含 `,` `"` CR LF 的字段整体加双引号，内部双引号翻倍。 */
export function csvEscapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/** BLOB → 十六进制文本（不带 0x 前缀）。 */
export function blobToHex(cell: Extract<CellValue, { kind: 'blob' }>): string {
  const bytes = Uint8Array.from(Buffer.from(cell.previewBase64, 'base64'))
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0').toUpperCase()
  return out
}

/**
 * 值 → 文本（CSV / JSONL / JSON 用）。
 *
 * NULL 返回 null，由调用方决定写什么（CSV 写空串或 nullText，JSON 写 null）。
 *
 * NUL（U+0000）在这里**原样保留**：
 *   - JSON 用 `JSON.stringify` 编码，它会把 NUL 转义成 `\u0000`，
 *     这是标准 JSON，转义后不丢数据；
 *   - CSV 里 NUL 是合法的字段内容，替换成别的字符会**静默改数据**，
 *     所以保持原样（导入端若不支持 NUL，那是导入端要显式处理的事）。
 *
 * 只有 SQL INSERT 会拒绝 NUL（见 `cellToSqlLiteral`）：那里的问题不是
 * "表示不了"，而是 PG 服务器根本不接受含 NUL 的字符串字面量。
 */
export function cellToTransferText(cell: CellValue | undefined): string | null {
  if (cell === undefined) return null
  switch (cell.kind) {
    case 'null':
      return null
    case 'text':
      return cell.text
    case 'number':
      return String(cell.value)
    case 'boolean':
      return cell.value ? 'true' : 'false'
    case 'blob':
      return '0x' + blobToHex(cell)
    default: {
      const never: never = cell
      throw new Error(`无法导出的单元格值: ${JSON.stringify(never)}`)
    }
  }
}

/**
 * 值 → JSON 值（`json` / `jsonl` 用）。
 *
 * 类型映射与既有导出保持一致：数字保持 number（不转字符串），
 * BLOB 变成 `"0x..."` 字符串（JSON 没有二进制类型），NULL 是 `null`。
 */
export function cellToJsonValue(cell: CellValue | undefined): unknown {
  if (cell === undefined) return null
  switch (cell.kind) {
    case 'null':
      return null
    case 'text':
      return cell.text
    case 'number':
      return cell.value
    case 'boolean':
      return cell.value
    case 'blob':
      return '0x' + blobToHex(cell)
    default: {
      const never: never = cell
      throw new Error(`无法导出的单元格值: ${JSON.stringify(never)}`)
    }
  }
}

/**
 * 值 → SQL 字面量。
 *
 * ===== 为什么 PostgreSQL 用 `E'...'` =====
 *
 * PG 默认 `standard_conforming_strings = on`，此时反斜杠在普通字符串字面量里
 * **不是**转义符。用 `E'...'`（转义字符串）能消除这个歧义：
 * 它在 `standard_conforming_strings` 开与关两种设置下语义一致。
 *
 * SQLite **不支持** `E'...'` 语法，且它的反斜杠本来就不是转义符，
 * 所以 SQLite 用普通 `'...'`。这不是"发明不安全 SQL"，而是方言差异。
 *
 * 单引号一律翻倍（`'` → `''`），两个方言都成立。
 */
export function cellToSqlLiteral(cell: CellValue | undefined, dialectId: string): string {
  if (cell === undefined) return 'NULL'
  switch (cell.kind) {
    case 'null':
      return 'NULL'
    case 'number':
      // NaN / Infinity 不是合法 SQL 数字。写成 NULL 会改变语义，
      // 但让整条 INSERT 报错更糟——这里选择让语句失败（由上层看到明确错误）。
      if (!Number.isFinite(cell.value)) {
        throw new Error('该行包含非有限数值（NaN/Infinity），无法生成合法的 SQL 字面量')
      }
      return String(cell.value)
    case 'boolean':
      // SQLite 没有 BOOLEAN 类型，只有 0/1；PostgreSQL 有真正的布尔类型。
      // 写 1/0 到 PG 的 boolean 列会被拒（integer → boolean 没有赋值转换），
      // 所以这里**按方言区分**，不做"统一用 1/0"的想当然处理。
      if (dialectId === 'postgresql') return cell.value ? 'TRUE' : 'FALSE'
      return cell.value ? '1' : '0'
    case 'blob':
      // BLOB 字面量：SQLite 用 X'..'，PG 用 E'\\x..'（bytea）。
      if (dialectId === 'postgresql') {
        return `E'\\\\x${blobToHex(cell)}'`
      }
      return `X'${blobToHex(cell)}'`
    case 'text': {
      /**
       * NUL（U+0000）一律拒绝。
       *
       * 为什么不能原样写进 SQL 字符串字面量：
       *   - PostgreSQL 服务器端**不允许**字符串字面量里含 NUL 字节，
       *     写出来的语句会直接报错（invalid byte sequence），
       *     而且错误发生在"文件已导出、用户拿去执行"的时候——太晚了；
       *   - SQLite 能存，但导出文件再被别的工具读回时，NUL 常被当作字符串结束符，
       *     造成静默截断。
       *
       * 所以这是"无法安全表示"的情况：**明确拒绝**，
       * 而不是发明一个会被下游误解的转义写法。
       */
      if (cell.text.includes('\u0000')) {
        throw new Error(
          '该行的文本值包含 NUL（U+0000）字符，无法安全地表示为 SQL 字符串字面量，已中止导出。'
        )
      }
      if (dialectId === 'postgresql') {
        // E'' 字符串里反斜杠必须转义成两个，否则 \n 之类会被解释成控制字符。
        const escaped = cell.text.replace(/\\/g, '\\\\').replace(/'/g, "''")
        return `E'${escaped}'`
      }
      if (dialectId === 'mysql') {
        // MySQL 默认把反斜杠当转义符（NO_BACKSLASH_ESCAPES 关闭时），
        // 必须先把 \ 翻倍，再处理引号，否则 `\n` 会变成换行。
        const escaped = cell.text.replace(/\\/g, '\\\\').replace(/'/g, "''")
        return `'${escaped}'`
      }
      const escaped = cell.text.replace(/'/g, "''")
      return `'${escaped}'`
    }
    default: {
      const never: never = cell
      throw new Error(`无法导出的单元格值: ${JSON.stringify(never)}`)
    }
  }
}

/**
 * 按方言规则引用标识符。
 *
 * SQLite 与 PostgreSQL 都是双引号 + 内部翻倍（`"a""b"`）。
 * 未知方言**拒绝**——绝不猜一种引用规则去拼标识符，
 * 那会在错误的方言上生成语法错误甚至错误的表名。
 */
export function quoteTransferIdentifier(name: string, dialectId: string): string {
  if (dialectId === 'mysql') return `\`${name.replaceAll('`', '``')}\``
  if (dialectId !== 'sqlite' && dialectId !== 'postgresql') {
    throw new Error(`未知的方言 "${dialectId}"，无法安全地引用标识符，已拒绝生成 SQL`)
  }
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * 生成 INSERT 语句的表名部分。
 *
 * **必须 schema 限定**：PG 里 `public.users` 与 `audit.users` 是两张表，
 * 只写表名会把数据插到 `search_path` 命中的第一张同名表上——
 * 这是"看起来成功、其实写错地方"的典型。SQLite 没有 schema 层，
 * 但可以写成 `"main"."users"`（main 是 SQLite 的默认 schema，合法且更明确）。
 */
export function buildInsertTarget(target: TransferTarget, dialectId: string): string {
  if (target.name.trim() === '') {
    throw new Error('INSERT 目标表名为空，已拒绝生成 SQL')
  }
  if (target.kind !== 'table') {
    throw new Error(
      `INSERT 目标「${target.name}」不是表（kind=${target.kind}），` +
        '无法生成 INSERT 语句，已拒绝导出。'
    )
  }
  if (dialectId === 'sqlite') {
    return `${quoteTransferIdentifier('main', dialectId)}.${quoteTransferIdentifier(target.name, dialectId)}`
  }
  if (dialectId === 'postgresql' || dialectId === 'mysql') {
    if (target.schema === undefined || target.schema.trim() === '') {
      throw new Error(
        `${dialectId === 'mysql' ? 'MySQL' : 'PostgreSQL'} 的 INSERT 目标必须带 schema/database 限定名：` +
          '同名表可能存在于多个库，只写表名会插入到当前库的同名表上。已拒绝生成 SQL。'
      )
    }
    return `${quoteTransferIdentifier(target.schema, dialectId)}.${quoteTransferIdentifier(target.name, dialectId)}`
  }
  throw new Error(`未知的方言 "${dialectId}"，无法安全地生成 INSERT 语句，已拒绝`)
}
