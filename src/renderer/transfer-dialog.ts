/**
 * P2.2 导出向导。
 *
 * ============================================================================
 * 它解决的问题：P2.1 把「流式导出」做成了后端能力，但界面里**没有入口**
 * ============================================================================
 *
 * P2.1 交付的是 `startTransfer / getTransferProgress / cancelTransfer / waitTransfer`
 * 四个 API 和主进程里的 `TransferManager`。但渲染进程里原本的「导出」按钮
 * （`tabs.ts` 的「导出全部」、`main.ts` 的「导出已加载行」）走的是**另一条老路**：
 * 把结果集拉进渲染进程内存拼字符串再下载。
 *
 * 那条路有三个绕不开的问题：
 *   1. 内存随总行数增长（跨进程全量搬运）；
 *   2. 有 5 万行硬上限，超了直接中止；
 *   3. 只能写 CSV/JSON/INSERT/Markdown，且**写不到用户指定的路径**。
 *
 * 所以这个文件的作用是：把 P2.1 的能力**接到界面上**，并把「导出」这件事
 * 收口到一个向导里（表、结果集、自由 SQL 都进同一个向导）。
 *
 * ============================================================================
 * 设计边界：纯逻辑与 DOM 分开
 * ============================================================================
 *
 * 文件分成两半：
 *   - **纯函数**（`buildTransferRequest` / `validateTransferForm` /
 *     `formatBytes` / `describeProgress` / `pickDefaultFileName` …）：
 *     不碰 DOM、不碰 API，可以在 Node 里直接单测。转义、路径、格式选择这类
 *     "一字之差错全表"的逻辑必须能被反复验证，所以不放进 DOM 代码里。
 *   - **DOM 装配**（`openTransferWizard`）：只做界面与调用顺序。
 *
 * ============================================================================
 * 为什么向导**不**自己写文件，而是把路径交给主进程
 * ============================================================================
 *
 * 渲染进程**不能**持有文件句柄（contextBridge 只传结构化克隆的值），
 * 而且让渲染进程写文件会绕过「同目录临时文件 → 原子 rename」这条提交语义。
 * 文件句柄只在主进程，所以也只有主进程能保证「失败时目标文件完好无损」。
 *
 * 因此向导做的事是：收集参数 → 调 `startTransfer` → 轮询 `getTransferProgress`
 * → 必要时 `cancelTransfer` → 结束时 `waitTransfer` 拿终态。
 * **渲染进程永远拿不到行数据**，内存不随总行数增长。
 *
 * ============================================================================
 * 关于「目标路径选择」
 * ============================================================================
 *
 * 调系统文件对话框需要主进程开一条新的 IPC 通道（`dialog.showSaveDialog`）。
 * 本轮**不**开这条通道——理由是它会扩大跨进程能力面，而这不是导出向导的必需项：
 * 用户可以直接填绝对路径（向导会给出默认文件名与目录提示）。
 * 等真的需要「浏览…」按钮时再单独加一条 `chooseSavePath` 通道，
 * 那时 main/preload/api 三处要同步改，属于独立的一次改动。
 *
 * 本轮把这条限制**明确写在界面上**（"路径由主进程写入"），
 * 而不是做一个假的「浏览」按钮点了没反应。
 */

import type { BackendClient } from '../backend/backend-client'
import { inspectSqlParameters, type SqlParameterDialect } from '../core/sql-parameters'
import type { SqlParameter, SqlParameterValue } from '../core/resultset'
import type {
  TransferFormat,
  TransferOptions,
  TransferProgress,
  TransferRequest,
  TransferResult,
  TransferSource
} from '../core/transfer'
import {
  DEFAULT_TRANSFER_BATCH_SIZE,
  MAX_TRANSFER_BATCH_SIZE,
  MIN_TRANSFER_BATCH_SIZE
} from '../core/transfer'

// ============================================================================
// 纯逻辑区（可被 Node 直接单测）
// ============================================================================

/** 向导支持的全部格式。与 core/transfer.ts 的 TRANSFER_FORMATS 一致。 */
export const WIZARD_FORMATS: readonly TransferFormat[] = ['csv', 'jsonl', 'json', 'sql-insert']

/** 格式的展示名与默认扩展名。 */
export const FORMAT_LABELS: Readonly<Record<TransferFormat, string>> = {
  csv: 'CSV',
  jsonl: 'JSON Lines（每行一个 JSON 对象）',
  json: 'JSON（整个数组）',
  'sql-insert': 'SQL INSERT 语句'
}

/** 格式的默认文件扩展名（不含点）。 */
export const FORMAT_EXTENSIONS: Readonly<Record<TransferFormat, string>> = {
  csv: 'csv',
  jsonl: 'jsonl',
  json: 'json',
  'sql-insert': 'sql'
}

/** 默认文件名的基准部分。 */
export const DEFAULT_FILE_BASE_NAME = 'dbstudio-export'

/**
 * 向导表单的取值。**全部是字符串**（布尔除外）。
 *
 * 为什么不用 number 直接存：表单控件（`<input>`）的值一律是字符串，
 * 提前在表单层保持字符串，可以把"用户输入了非法值"这件事**如实保留**到
 * 校验阶段再报错，而不是在 `parseInt` 时悄悄变成 `NaN` 或 `0`。
 * （`parseInt('abc')` 是 `NaN`，`Number('12abc')` 是 `12`——后者会把
 * "12abc" 悄悄当成 12，用户以为设了 12。）
 */
export interface TransferFormValues {
  readonly format: string
  readonly destinationPath: string
  readonly batchSize: string
  readonly includeHeader: boolean
  readonly nullText: string
  readonly newline: string
  readonly jsonIndent: string
}

/** 导出来源的描述。 */
export type WizardSource =
  | {
      readonly kind: 'table'
      /** 表/视图的节点 id（`connection:c1|table:users`）。 */
      readonly nodeId: string
      readonly name: string
    }
  | {
      /**
       * 视图来源。
       *
       * 为什么视图要和表分开：**视图没有可插入的落点**，
       * 所以 `sql-insert` 格式对视图根本不适用。
       *
       * 早先把视图也标成 `kind: 'table'`，结果向导层的
       * "SQL INSERT 需要表来源" 这条规则对视图不触发，
       * 用户只能在提交之后由主进程报错——白等一趟。
       */
      readonly kind: 'view'
      /** 视图的节点 id（`connection:c1|view:v_users`）。 */
      readonly nodeId: string
      readonly name: string
    }
  | {
      readonly kind: 'sql'
      /** 连接根节点 id（`connection:c1`），用于定位连接。 */
      readonly connectionNodeId: string
      readonly sql: string
      readonly name: string
      /**
       * 该查询的绑定参数。
       *
       * ===== 为什么必须跟着来源一起传 =====
       *
       * 参数值**不拼进 SQL**（见 core/sql-parameters.ts），
       * 所以一个带参数的查询"只有 SQL 文本"是跑不起来的。
       *
       * 早先这里没有这个字段，向导把来源降级成 `{ nodeId, sql }`，
       * 结果导出带 `:id` 的查询时报"缺少参数 id"——
       * 而界面上显示的来源还是那句带占位符的 SQL，看着完全正常。
       *
       * 有了它，主进程就能用同样的绑定值重放这条查询，
       * 导出结果与用户屏幕上看到的一致。
       */
      readonly parameters?: readonly SqlParameter[]
      /**
       * 该连接的方言。
       *
       * 决定参数占位符的形态（`:name` / `?` / `$1`）与字面量的转义规则，
       * 所以内联参数时必须要它。
       */
      readonly dialect: SqlParameterDialect
    }

/** 校验失败时的结果。 */
export interface TransferFormError {
  /** 出错的字段（用于在界面上高亮）。 */
  readonly field:
    | 'format'
    | 'destinationPath'
    | 'batchSize'
    | 'nullText'
    | 'newline'
    | 'jsonIndent'
    | 'source'
    | 'parameters'
    | 'general'
  readonly message: string
}

/** 校验结果。`ok` 为 false 时 `errors` 一定非空。 */
export type TransferFormValidation =
  | { readonly ok: true; readonly request: TransferRequest }
  | { readonly ok: false; readonly errors: readonly TransferFormError[] }

/**
 * 判断某个格式是否有「表头**行**」这个概念。
 *
 * ===== 这里曾经是错的 =====
 *
 * 早先这里对 `csv / jsonl / json` 都返回 true，理由是
 * core/transfer.ts 的契约注释写着「CSV / JSONL / JSON 是否写表头」。
 *
 * 但契约注释说的是**参数形状**（这三个格式都接受 `includeHeader`），
 * 不是**实际效果**。主进程的写出器里：
 *   - CSV   —— `includeHeader` 决定有没有第一行列名；
 *   - JSONL —— 没有表头行，列名通过每行的**对象键**表达，永远都在；
 *   - JSON  —— 同上，列名永远是对象的键；
 *   - SQL   —— 列名永远出现在 INSERT 的列清单里。
 *
 * 所以对 JSONL / JSON 那个复选框是个**假开关**：取消勾选，文件一模一样。
 * 让用户面对一个"看起来有用、其实没有"的控件，比禁用它更糟。
 *
 * 现在只有 CSV 返回 true；其余格式在界面上禁用并说明原因。
 */
export function formatSupportsHeaderRow(format: TransferFormat): boolean {
  return format === 'csv'
}

/**
 * 表头行选项对当前格式的说明文案。
 *
 * 禁用控件时必须告诉用户**为什么**——否则用户会以为界面坏了。
 */
export function describeHeaderRowOption(format: TransferFormat): string {
  switch (format) {
    case 'csv':
      return 'CSV 的第一行是列名。取消勾选则只写数据行。'
    case 'jsonl':
    case 'json':
      return 'JSON / JSON Lines 始终包含列名（作为对象的键），没有独立的表头行。'
    case 'sql-insert':
      return '列名始终出现在 INSERT 语句的列清单里，没有独立的表头行。'
    default: {
      const never: never = format
      return String(never)
    }
  }
}

/** SQL INSERT 不支持自定义 NULL 文本（NULL 必须是关键字）。 */
export function formatSupportsNullText(format: TransferFormat): boolean {
  return format !== 'sql-insert'
}

/** JSON 缩进只对 `json` 有意义。 */
export function formatSupportsJsonIndent(format: TransferFormat): boolean {
  return format === 'json'
}

/** 该格式是否是自由 SQL 来源不可用的（SQL INSERT 需要明确的表落点）。 */
export function formatRequiresTableSource(format: TransferFormat): boolean {
  return format === 'sql-insert'
}

/**
 * 该来源能否生成 INSERT 语句。
 *
 * SQL INSERT 需要一个**可插入的表**：
 *   - 表来源：可以（主进程知道 schema 与表名）；
 *   - 视图来源：不可以（视图没有可插入的落点）；
 *   - 自由 SQL：不可以（连表名都没有）。
 *
 * 为什么单独抽成一个函数：视图与自由 SQL 的**拒绝理由不同**，
 * 界面上要说清楚"为什么这个组合不行"，而不是笼统一句"不支持"。
 */
export function sourceSupportsInsert(source: WizardSource): boolean {
  return source.kind === 'table'
}

/**
 * 说明「来源 × 格式」为什么不能导出。
 *
 * 返回 null 表示这个组合是允许的。
 *
 * 存在的意义：把"能不能导出"这件事在**向导层**判完，
 * 让用户当场看到原因，而不是提交之后由主进程报错——
 * 那时候用户已经填完一整套表单了。
 */
export function describeIncompatibleSource(
  source: WizardSource,
  format: TransferFormat
): string | null {
  if (format !== 'sql-insert') return null
  if (sourceSupportsInsert(source)) return null
  if (source.kind === 'view') {
    return (
      `SQL INSERT 导出需要「表」来源：视图「${source.name}」没有可插入的落点，` +
      '无法生成 INSERT 语句。'
    )
  }
  return 'SQL INSERT 导出需要「表」来源：自由 SQL 结果没有表名，无法确定 INSERT 目标。'
}

/**
 * 参数化 SQL 的来源判定。
 *
 * ===== 这条规则防的是什么 =====
 *
 * SQL 编辑器支持参数（`:name` / `?` / `$1`），参数值**不拼进 SQL**，
 * 而是单独绑定。所以一个带参数的查询，**光有 SQL 文本是跑不起来的**。
 *
 * 早先的向导把来源降级成 `{ nodeId, sql }`，把 `options.parameters` 丢了，
 * 结果导出时报"缺少参数 id"，而用户在界面上看到的来源还是那句带 `:id` 的 SQL。
 *
 * 现在参数必须**跟着来源一起走**（见 `WizardSource` 的 sql 分支），
 * 并且在导出前用 `inspectSqlParameters` 检查：
 *   - SQL 里有占位符但**没给值** → 当场报错，不去启动一个注定失败的任务；
 *   - SQL 里**没有**占位符却带了值 → 同样报错（多余绑定会被驱动拒绝）。
 */
export function describeMissingParameters(
  sql: string,
  parameters: readonly SqlParameter[] | undefined,
  dialect: SqlParameterDialect
): string | null {
  const inspection = inspectSqlParameters(sql, dialect)
  if (!inspection.safe) {
    return `无法安全识别 SQL 参数：${inspection.reason ?? '请显式检查后再导出。'}`
  }
  const supplied = new Set(
    (parameters ?? []).map((parameter) => canonicalParameterName(parameter.name))
  )
  const missing: string[] = []
  for (const placeholder of inspection.placeholders) {
    const key = canonicalParameterName(placeholder.name)
    if (!supplied.has(key) && !missing.includes(key)) missing.push(key)
  }
  if (missing.length > 0) {
    return (
      `这条查询使用了参数 ${missing.map((n) => `:${n}`).join('、')}，` +
      '导出需要它们的值。请重新执行该查询并填写参数后再导出。'
    )
  }
  const unused = [...supplied].filter(
    (name) => !inspection.placeholders.some((p) => canonicalParameterName(p.name) === name)
  )
  if (unused.length > 0) {
    return `参数 ${unused.map((n) => `:${n}`).join('、')} 在这条 SQL 里没有对应的占位符。`
  }
  return null
}

/** 参数名归一：去掉前导冒号（`:id` 与 `id` 是同一个参数）。 */
function canonicalParameterName(name: string): string {
  const trimmed = name.trim()
  return trimmed.startsWith(':') ? trimmed.slice(1) : trimmed
}

/**
 * 把参数值转成 SQL 字面量（按方言）。
 *
 * ===== 为什么必须按方言区分 =====
 *
 * - PostgreSQL 默认 `standard_conforming_strings = on`，此时反斜杠在普通
 *   字符串字面量里**不是**转义符。用 `E'...'`（转义字符串）能消除歧义：
 *   它在开关两种设置下语义一致。
 * - SQLite **不支持** `E'...'` 语法，且它的反斜杠本来就不是转义符，
 *   所以 SQLite 用普通 `'...'`。这不是"发明不安全 SQL"，而是方言差异。
 *
 * 单引号一律翻倍（`'` → `''`），两个方言都成立。
 *
 * 与 core/transfer.ts 的 `cellToSqlLiteral` 是同一套规则——
 * 导出文件里的字面量与这里内联出来的字面量必须一致，
 * 否则"导出的 INSERT 能直接执行"这条保证会在带参数时失效。
 */
export function sqlParameterToLiteral(
  value: SqlParameterValue,
  dialect: SqlParameterDialect
): string {
  if (value === null) return 'NULL'
  switch (typeof value) {
    case 'string':
      return quoteSqlString(value, dialect)
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('非有限数值（NaN/Infinity）无法表示为 SQL 字面量')
      }
      return String(value)
    case 'boolean':
      // SQLite 没有 BOOLEAN 类型，只有 0/1；PostgreSQL 有真正的布尔类型。
      // 写 1/0 到 PG 的 boolean 列会被拒（integer → boolean 没有赋值转换）。
      if (dialect === 'postgresql') return value ? 'TRUE' : 'FALSE'
      return value ? '1' : '0'
    default: {
      /**
       * BLOB 参数。
       *
       * SQLite 用 `X'..'`，PostgreSQL 用 `E'\\x..'`（bytea）。
       *
       * 渲染进程里**没有 Buffer**（contextIsolation + nodeIntegration:false），
       * 所以自己把字节数组转成十六进制。
       */
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayLike<number>)
      let hex = ''
      for (const byte of bytes) hex += byte.toString(16).padStart(2, '0').toUpperCase()
      if (dialect === 'postgresql') return `E'\\x${hex}'`
      return `X'${hex}'`
    }
  }
}

/** 字符串 → SQL 字符串字面量。 */
function quoteSqlString(value: string, dialect: SqlParameterDialect): string {
  /**
   * NUL（U+0000）一律拒绝。
   *
   * PostgreSQL 服务器端不允许字符串字面量里含 NUL 字节，写出来的语句会直接报错；
   * SQLite 能存，但读回时 NUL 常被当作字符串结束符，造成静默截断。
   * 与 core/transfer.ts 的处理保持一致。
   */
  if (value.includes('\u0000')) {
    throw new Error('文本值包含 NUL（U+0000）字符，无法安全地表示为 SQL 字符串字面量')
  }
  if (dialect === 'postgresql') {
    // E'' 字符串里反斜杠必须转义成两个，否则 \n 之类会被解释成控制字符。
    const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "''")
    return `E'${escaped}'`
  }
  if (dialect === 'mysql') {
    // MySQL 默认启用反斜杠转义，规则与 PG 的 E'' 相同，只是不需要 E 前缀。
    const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "''")
    return `'${escaped}'`
  }
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 把带占位符的 SQL 内联成一条自包含的 SQL。
 *
 * 见 `validateTransferForm` 里那段关于"为什么必须内联"的说明。
 *
 * 实现要点：
 *   - 用 `inspectSqlParameters` 拿到占位符的**位置**，按位置倒序替换，
 *     避免前面的替换把后面的下标冲掉；
 *   - 位置替换**不碰字符串字面量与注释**——扫描器已经保证了
 *     占位符的位置一定在 SQL 语法层面（它跳过引号内与注释内容）。
 */
export function inlineSqlParameters(
  sql: string,
  parameters: readonly SqlParameter[] | undefined,
  dialect: SqlParameterDialect
): string {
  const inspection = inspectSqlParameters(sql, dialect)
  if (!inspection.safe) {
    throw new Error(inspection.reason ?? '无法安全识别 SQL 参数')
  }
  const values = new Map<string, SqlParameterValue>()
  for (const parameter of parameters ?? []) {
    values.set(canonicalParameterName(parameter.name), parameter.value)
  }
  if (inspection.placeholders.length === 0) return sql

  let out = sql
  const ordered = [...inspection.placeholders].sort((a, b) => b.start - a.start)
  for (const placeholder of ordered) {
    /**
     * 占位符的名字与绑定值的名字是**同一套**：
     *   - SQLite 的 `?` → 扫描器编号为 `?1`、`?2`…；
     *   - PostgreSQL 的 `$1` → 名字就是 `$1`；
     *   - 具名参数 `:id` → 扫描器给出 `id`（不带冒号）。
     *
     * SQL 编辑器提供的绑定值用的正是同一套名字，
     * 所以直接按名字查即可，不需要在这里重新编号。
     */
    const value = values.get(canonicalParameterName(placeholder.name))
    if (value === undefined) {
      throw new Error(`缺少参数 ${placeholder.name}`)
    }
    const literal = sqlParameterToLiteral(value, dialect)
    out = out.slice(0, placeholder.start) + literal + out.slice(placeholder.end)
  }
  return out
}

/**
 * 校验并组装导出请求。
 *
 * 这是整个向导**唯一**把「用户输入」变成「跨进程请求」的地方，
 * 所以所有约束都集中在这里，便于单测覆盖。
 *
 * 校验分两层：
 *   - 这里（渲染进程）：拦「手滑」——空路径、非法批大小、格式与来源不匹配；
 *   - 主进程（TransferManager）：拦「攻击」与最终事实——路径是否覆盖源库、
 *     列名是否重复、目标表是否存在等。
 * 两层都要有，不能互相替代。
 */
export function validateTransferForm(
  source: WizardSource,
  values: TransferFormValues
): TransferFormValidation {
  const errors: TransferFormError[] = []

  // ---- 格式 ----
  const format = values.format as TransferFormat
  if (!WIZARD_FORMATS.includes(format)) {
    errors.push({ field: 'format', message: `不支持的导出格式：${values.format}` })
  }

  // ---- 目标路径 ----
  const destinationPath = values.destinationPath.trim()
  if (destinationPath === '') {
    errors.push({ field: 'destinationPath', message: '必须填写目标文件路径' })
  } else if (!isAbsolutePath(destinationPath)) {
    /**
     * 必须是**绝对路径**。
     *
     * 为什么要拦：主进程会把路径 resolve 成绝对路径再落地，
     * 相对路径会相对于**主进程的工作目录**解析——那通常不是用户以为的目录，
     * 文件会落到一个意想不到的地方，而且用户未必找得到。
     * 与其导完了让人满盘找，不如一开始就说清楚。
     */
    errors.push({
      field: 'destinationPath',
      message: '目标路径必须是绝对路径（以 / 或盘符开头）'
    })
  }

  // ---- 批大小 ----
  const batchSizeText = values.batchSize.trim()
  let batchSize: number | undefined
  if (batchSizeText === '') {
    batchSize = DEFAULT_TRANSFER_BATCH_SIZE
  } else {
    /**
     * 严格解析：**整串必须都是数字**。
     *
     * 为什么不用 `parseInt`：它对 "12abc" 返回 12，用户输入错了却得到一个
     * "看起来生效"的 12。这里用正则整体匹配，非法就报错。
     */
    if (!/^\d+$/.test(batchSizeText)) {
      errors.push({ field: 'batchSize', message: '批大小必须是正整数' })
    } else {
      batchSize = Number(batchSizeText)
      if (
        !Number.isSafeInteger(batchSize) ||
        batchSize < MIN_TRANSFER_BATCH_SIZE ||
        batchSize > MAX_TRANSFER_BATCH_SIZE
      ) {
        errors.push({
          field: 'batchSize',
          message: `批大小必须在 ${MIN_TRANSFER_BATCH_SIZE} ~ ${MAX_TRANSFER_BATCH_SIZE} 之间`
        })
      }
    }
  }

  // ---- NULL 文本 ----
  const nullText = values.nullText
  if (formatSupportsNullText(format) === false && nullText !== '') {
    errors.push({
      field: 'nullText',
      message: 'SQL INSERT 格式的 NULL 必须写成 SQL 关键字 NULL，不能自定义文本'
    })
  }

  // ---- 行分隔符 ----
  if (values.newline !== '\r\n' && values.newline !== '\n') {
    errors.push({ field: 'newline', message: '行分隔符只支持 CRLF 或 LF' })
  }

  // ---- JSON 缩进 ----
  let jsonIndent = 2
  if (formatSupportsJsonIndent(format)) {
    const indentText = values.jsonIndent.trim()
    if (!/^\d+$/.test(indentText)) {
      errors.push({ field: 'jsonIndent', message: 'JSON 缩进必须是非负整数' })
    } else {
      jsonIndent = Number(indentText)
      if (!Number.isSafeInteger(jsonIndent) || jsonIndent < 0 || jsonIndent > 8) {
        errors.push({ field: 'jsonIndent', message: 'JSON 缩进必须在 0 ~ 8 之间' })
      }
    }
  }

  // ---- 来源与格式的匹配 ----
  const incompatible = describeIncompatibleSource(source, format)
  if (incompatible !== null) {
    /**
     * SQL INSERT 需要明确的表落点。自由 SQL 没有表名，视图没有可插入的落点，
     * 凭空编一个表名会生成"注定失败"或"插到错的表"的 INSERT。
     * 这里**在向导层就拒绝**，而不是等主进程拒绝——让用户当场就知道原因。
     */
    errors.push({
      field: 'source',
      message: incompatible
    })
  }

  if (errors.length > 0) return { ok: false, errors }

  // ---- 带参数的自由 SQL：把参数**内联**成字面量 ----
  /**
   * ===== 为什么必须在这里内联 =====
   *
   * 参数化查询的参数值**不拼进 SQL**，而是单独绑定传给驱动。
   * 导出的跨进程契约（core/transfer.ts 的 `TransferSource`）**只有 sql 文本，
   * 没有绑定值的通道**——而 core 是本轮不可改的边界。
   *
   * 于是只剩两条路：
   *   a) 把绑定值带过 IPC（要改 core/transfer.ts → 越界）；
   *   b) 在渲染进程把参数**内联成 SQL 字面量**，得到一条自包含的 SQL。
   *
   * 选 (b)。代价与前提必须说清楚：
   *   - 内联是**字面量拼接**，不是绑定。必须用方言的转义规则，
   *     否则字符串里的引号会破坏 SQL（SQL 注入面）。
   *   - 内联后的 SQL 会被主进程当作普通只读查询执行，
     * 而驱动侧仍然会做**只读校验**（prepareReadOnlyStatement），
 *     所以内联不会变成"导出可以执行写语句"。
   *   - 值只在本地拼好，不会被当成"用户输入的 SQL"直接执行。
   *
   * 不内联的后果更糟：导出直接报"缺少参数 id"，
   * 而界面上显示的来源还是那句带 `:id` 的 SQL，用户完全无从判断出了什么事。
   */
  let resolvedSql: string | undefined
  if (source.kind === 'sql') {
    const parameterIssue = describeMissingParameters(
      source.sql,
      source.parameters,
      source.dialect
    )
    if (parameterIssue !== null) {
      errors.push({ field: 'parameters', message: parameterIssue })
    } else {
      try {
        resolvedSql = inlineSqlParameters(source.sql, source.parameters, source.dialect)
      } catch (e) {
        errors.push({
          field: 'parameters',
          message: `无法把查询参数内联为 SQL 字面量：${e instanceof Error ? e.message : String(e)}`
        })
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  /**
   * nullText 只在格式允许时传。
   *
   * 注意不能给 sql-insert 传 nullText：主进程对「sql-insert + nullText」
   * 是**显式报错**（不是默默忽略），因为默默忽略会让用户以为
   * "NULL 写成了我指定的文本"，实际文件里是 NULL。
   */
  const options: TransferOptions = {
    includeHeader: formatSupportsHeaderRow(format) ? values.includeHeader : false,
    batchSize,
    newline: values.newline as '\r\n' | '\n',
    jsonIndent,
    ...(formatSupportsNullText(format) ? { nullText } : {})
  }

  const transferSource: TransferSource =
    source.kind === 'table' || source.kind === 'view'
      ? { nodeId: source.nodeId }
      : { nodeId: source.connectionNodeId, sql: resolvedSql as string }

  return {
    ok: true,
    request: {
      source: transferSource,
      format,
      destinationPath,
      options
    }
  }
}

/**
 * 绝对路径判定（跨平台）。
 *
 * 为什么自己写而不用 `path.isAbsolute`：渲染进程没有 Node 的 `path`
 * （contextIsolation + nodeIntegration:false），而 `node:path` 在打包后的
 * renderer 里也不该被引入。这里用规则判定，Windows 的盘符与 UNC 都要认。
 */
export function isAbsolutePath(value: string): boolean {
  if (value === '') return false
  // UNC：\\server\share
  if (/^[\\/]{2}[^\\/]/.test(value)) return true
  // Windows 盘符：C:\ 或 C:/
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  // POSIX 绝对路径
  if (value.startsWith('/')) return true
  return false
}

/**
 * 取路径的目录部分（用于默认文件名）。
 *
 * 只做字符串处理，不引 Node 的 path：渲染进程里没有它。
 */
export function directoryOfPath(value: string): string {
  const trimmed = value.trim()
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index <= 0) return trimmed.startsWith('/') ? '/' : ''
  return trimmed.slice(0, index)
}

/**
 * 默认目标文件名：`<基准名>-<时间戳>.<扩展名>`。
 *
 * 带时间戳是刻意的：导出是"某一刻的数据"，同名文件连着导两次会互相覆盖，
 * 而用户很可能想留着上一份做对比。
 */
export function pickDefaultFileName(
  format: TransferFormat,
  baseName: string = DEFAULT_FILE_BASE_NAME,
  now: Date = new Date()
): string {
  const iso = now.toISOString().replace(/[:.]/g, '-')
  return `${baseName}-${iso}.${FORMAT_EXTENSIONS[format]}`
}

/**
 * 根据已有路径猜一个默认文件名（保留目录，换掉文件名部分）。
 *
 * 用户已经填了路径就**不再覆盖**他的输入——这里只用于"路径为空"时的建议。
 */
export function suggestDestination(
  existingPath: string,
  format: TransferFormat,
  now: Date = new Date(),
  /**
   * 兜底目录（绝对路径）。
   *
   * 没有它时，已有路径为空就会退回**纯文件名**（相对路径），
   * 而相对路径会被向导当场拒绝——用户第一次点「开始导出」必然撞墙。
   */
  fallbackDirectory?: string | null
): string {
  const dir = directoryOfPath(existingPath)
  const fileName = pickDefaultFileName(format, DEFAULT_FILE_BASE_NAME, now)
  if (dir === '') {
    if (fallbackDirectory !== undefined && fallbackDirectory !== null && fallbackDirectory !== '') {
      const sep = fallbackDirectory.includes('\\') && !fallbackDirectory.includes('/') ? '\\' : '/'
      return `${fallbackDirectory}${sep}${fileName}`
    }
    return fileName
  }
  const sep = existingPath.includes('\\') && !existingPath.includes('/') ? '\\' : '/'
  return `${dir}${sep}${fileName}`
}

/**
 * 把字节数格式化成人类可读的形式。
 *
 * 用 1024 进制（KiB/MiB）而不是 1000（KB/MB）：后者在操作系统语境下
 * 更常见的期待其实是"文件管理器显示的大小"，那个用 1024。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

/** 任务状态的中文标签。 */
export function describeTransferStatus(status: TransferProgress['status']): string {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '导出中'
    case 'committing':
      return '正在写入最终文件'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default: {
      const never: never = status
      return String(never)
    }
  }
}

/** 终态判定。终态之后进度不再变化。 */
export function isTerminalStatus(status: TransferProgress['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/**
 * 把进度快照渲染成一行摘要。
 *
 * 为什么要**速度**：用户点下导出后最想知道的是"还要多久"。
 * 速度 = 字节数 / 已用时间。注意这是**平均速度**（不是瞬时速度），
 * 小文件上波动大，但比没有强。
 */
export function describeProgress(progress: TransferProgress, elapsedMs: number): string {
  const parts: string[] = [describeTransferStatus(progress.status)]
  parts.push(`已读 ${progress.rowsRead.toLocaleString()} 行`)
  parts.push(`已写 ${formatBytes(progress.bytesWritten)}`)
  if (progress.batches > 0) parts.push(`${progress.batches} 批`)
  if (elapsedMs > 0 && progress.bytesWritten > 0) {
    const bytesPerMs = progress.bytesWritten / elapsedMs
    const perSecond = bytesPerMs * 1000
    parts.push(`${formatBytes(Math.round(perSecond))}/s`)
  }
  return parts.join(' · ')
}

/**
 * 一致性声明的文案。
 *
 * 必须**如实告知**用户这不是快照：`live-paged` 意味着导出期间底层数据若被
 * 并发修改，不同批次看到的不是同一时刻的数据。把分页读取说成"快照"是撒谎。
 */
export function describeConsistency(consistency: TransferProgress['consistency']): string {
  switch (consistency) {
    case 'live-paged':
      return '逐页重新读取：导出期间若底层数据被并发修改，不同批次可能不是同一时刻的数据（不是数据库快照）'
    default: {
      const never: never = consistency
      return String(never)
    }
  }
}

/**
 * 结果摘要（终态时显示给用户）。
 *
 * 失败/取消时**必须**说清"目标文件没有被动过"——
 * 用户最怕的是"以为导出失败了，但原来的文件已经被写坏"。
 */
export function describeResult(result: TransferResult): string {
  switch (result.status) {
    case 'completed':
      return `导出完成：${result.rowsRead.toLocaleString()} 行，${formatBytes(
        result.bytesWritten
      )} → ${result.committedPath ?? result.destinationPath}`
    case 'cancelled':
      return `已取消：目标文件「${result.destinationPath}」保持原样，未写入任何数据`
    case 'failed':
      return `导出失败：${result.message ?? '未知原因'}（目标文件「${result.destinationPath}」保持原样）`
    default: {
      const never: never = result.status
      return String(never)
    }
  }
}

/** 标签来源的最小形状（只取向导需要的字段）。 */
export type TabSourceLike =
  | {
      readonly kind: 'table'
      readonly ref: { readonly id: string; readonly name: string }
      /**
       * 对象种类。表与视图在**能否导出**上没差别，
       * 但在**能否生成 INSERT**上有差别（视图没有可插入的落点），
       * 所以这里必须区分。
       */
      readonly objectKind?: 'table' | 'view'
    }
  | {
      readonly kind: 'sql'
      readonly nodeId: string
      readonly sql: string
      /** 该查询的绑定参数（见 `WizardSource` 的 sql 分支）。 */
      readonly parameters?: readonly SqlParameter[]
      /** 该连接的方言（决定占位符形态与字面量转义）。 */
      readonly dialect?: SqlParameterDialect
    }

/** 一个可选的导出范围。 */
export interface WizardScope {
  /** 范围 id。 */
  readonly id: 'current' | 'base'
  /** 界面上显示的范围名。 */
  readonly label: string
  /** 该范围对应的来源。 */
  readonly source: WizardSource
}

/**
 * 从结果集标签推导出**可选的导出范围**。
 *
 * ===== 为什么需要「范围」而不是只导当前看到的 =====
 *
 * 筛选的实现是「重新执行带 WHERE 的查询」，并**新开一个标签**。
 * 于是同一件事有两个来源：
 *   - `source`     = 当前标签的来源（筛选后的 SQL，或表本身）；
 *   - `baseSource` = 筛选**之前**的原始来源。
 *
 * 用户点「导出」时，很可能想要的是"我筛选出来的那些行"，但也可能是
 * "把整张表导出来"。这两种意图指向不同的 SQL，**不能替用户猜**。
 * 所以向导把范围做成一个显式选项，并在界面上标清楚当前选的是哪一个。
 *
 * 没有筛选时只有一个范围（当前），不给用户一个无意义的二选一。
 */
export function wizardScopesForTab(tab: {
  readonly source: TabSourceLike
  readonly baseSource: TabSourceLike
  readonly filterText: string
}): WizardScope[] {
  const filtered = tab.filterText.trim() !== ''
  const current = wizardSourceFor(tab.source)
  if (!filtered) {
    return [{ id: 'current', label: '当前结果集', source: current }]
  }
  return [
    { id: 'current', label: '当前筛选结果', source: current },
    { id: 'base', label: '原始结果集（不含筛选）', source: wizardSourceFor(tab.baseSource) }
  ]
}

/**
 * 把标签来源转成向导来源。
 *
 * 为什么要区分「表来源」与「SQL 来源」：
 *   - 表来源可以直接传 nodeId，主进程让驱动解析出 SELECT 与 INSERT 落点；
 *   - SQL 来源只能传 sql，**没有 INSERT 落点**，所以 SQL INSERT 格式不可用。
 *
 * 这个判定放在纯函数里，才能被单测覆盖（而不是只在 GUI 里试）。
 */
export function wizardSourceFor(source: TabSourceLike): WizardSource {
  if (source.kind === 'table') {
    /**
     * 表与视图在这里分流。
     *
     * 视图同样能读数据（所以能导出 CSV/JSON），但**没有可插入的落点**，
     * 所以 SQL INSERT 对视图不适用。分流之后，向导层的
     * `describeIncompatibleSource` 才能给出正确的拒绝理由。
     */
    if (source.objectKind === 'view') {
      return { kind: 'view', nodeId: source.ref.id, name: source.ref.name }
    }
    return { kind: 'table', nodeId: source.ref.id, name: source.ref.name }
  }
  return {
    kind: 'sql',
    connectionNodeId: source.nodeId,
    sql: source.sql,
    name: source.sql,
    ...(source.parameters === undefined ? {} : { parameters: source.parameters }),
    dialect: source.dialect ?? 'sqlite'
  }
}

/**
 * 旧签名保留：只取当前来源，并在名字上标出"筛选结果"。
 *
 * 为什么保留：调用方若不需要"原始结果集"这个选项（例如树上的表右键导出），
 * 用这个更直接。
 */
export function wizardSourceForTab(tab: {
  readonly source: TabSourceLike
  readonly filterText: string
}): WizardSource {
  const source = wizardSourceFor(tab.source)
  if (tab.source.kind === 'table') return source
  const filtered = tab.filterText.trim() !== ''
  const sqlSource = source.kind === 'sql' ? source : null
  return {
    kind: 'sql',
    connectionNodeId: sqlSource?.connectionNodeId ?? '',
    sql: sqlSource?.sql ?? '',
    name: filtered ? `${tab.source.sql}（筛选结果）` : tab.source.sql,
    ...(sqlSource?.parameters === undefined ? {} : { parameters: sqlSource.parameters }),
    dialect: sqlSource?.dialect ?? 'sqlite'
  }
}

// ============================================================================
// DOM 装配区
// ============================================================================

/** 向导对外的接口。 */
export interface TransferWizardCallbacks {
  /** 状态栏输出（进度、结果、错误）。 */
  onStatus(text: string, isError?: boolean): void
}

/** 打开向导时给出的初始来源。 */
export interface TransferWizardOptions {
  readonly api: BackendClient
  /**
   * 可选的导出范围。
   *
   * 只有一个时界面不显示范围下拉（不给用户无意义的二选一）。
   */
  readonly scopes: readonly WizardScope[]
  /**
   * 默认导出目录（**绝对路径**）。
   *
   * ===== 为什么必须由调用方给 =====
   *
   * 渲染进程里没有 `process`，拿不到 home 目录（实测 `process` 在
   * contextIsolation 的渲染进程里是 undefined）。而默认路径必须是**绝对路径**——
   * 相对路径会被向导当场拒绝，用户第一次点「开始导出」就撞墙。
   *
   * 所以由 main.ts 在**有 Node 能力的地方**取好目录再传进来。
   *
   * 给不出目录时（null）：向导的路径框留空，并在提示里说明必须填绝对路径——
   * 这比塞一个假的相对路径（必定被拒）诚实。
   */
  readonly defaultDirectory?: string | null
  /** 来源的人类可读描述（显示在向导顶部）。 */
  readonly cb: TransferWizardCallbacks
  /** 向导关闭后的回调（无论成功失败都调用）。 */
  onClosed?: () => void
}

/** 进度轮询间隔（毫秒）。 */
const PROGRESS_POLL_INTERVAL_MS = 200

/** 内部控件句柄。 */
interface WizardControls {
  readonly overlay: HTMLElement
  readonly scopeSelect: HTMLSelectElement
  readonly scopeField: HTMLElement
  readonly formatSelect: HTMLSelectElement
  readonly pathInput: HTMLInputElement
  readonly batchInput: HTMLInputElement
  readonly headerInput: HTMLInputElement
  readonly nullInput: HTMLInputElement
  readonly newlineSelect: HTMLSelectElement
  readonly indentInput: HTMLInputElement
  readonly nullField: HTMLElement
  readonly headerField: HTMLElement
  readonly headerHint: HTMLElement
  readonly indentField: HTMLElement
  readonly errorBox: HTMLElement
  readonly progressBox: HTMLElement
  readonly progressText: HTMLElement
  readonly progressDetail: HTMLElement
  readonly startBtn: HTMLButtonElement
  readonly cancelBtn: HTMLButtonElement
  readonly closeBtn: HTMLButtonElement
}

function inputStyle(): string {
  return (
    'font:inherit;width:100%;padding:6px 8px;border:1px solid var(--border);' +
    'border-radius:6px;background:var(--bg);color:var(--fg);'
  )
}

/**
 * 目标路径的提示文案。
 *
 * 有默认目录时：告诉用户文件默认落在哪、可以改。
 * 没有默认目录时：**明确说必须填绝对路径**——
 * 相对路径会被向导当场拒绝，用户第一次点「开始导出」就撞墙，
 * 而界面上一个字的提示都没有。
 */
export function renderPathHint(defaultDirectory: string | null): string {
  const base =
    '由主进程写入：先写同目录临时文件，成功后原子替换目标；失败或取消时目标文件保持原样。'
  if (defaultDirectory === null || defaultDirectory === '') {
    return `${base} 路径必须填绝对路径（以 / 或盘符开头），相对路径会被拒绝。`
  }
  return `${base} 默认目录：${defaultDirectory}（可直接改）。`
}

export function shouldBlockWizardClose(taskId: string | null, starting = false): boolean {
  return starting || taskId !== null
}

/** 打开导出向导。
 *
 * 流程：
 *   1. 展示表单（格式 / 路径 / 批大小 / 表头 / NULL 文本 / 行分隔符 / 缩进）；
 *   2. 点「开始导出」→ 校验 → `startTransfer`；
 *   3. 轮询 `getTransferProgress` 更新进度面板；
 *   4. 任务结束 → `waitTransfer` 拿终态 → 显示结果摘要；
 *   5. 点「取消」→ `cancelTransfer`（任务级，不影响同连接的其它查询）。
 *
 * **渲染进程全程拿不到行数据**，只拿进度。
 */
export function openTransferWizard(options: TransferWizardOptions): void {
  const { api, scopes, cb } = options

  if (scopes.length === 0) {
    cb.onStatus('没有可导出的来源', true)
    return
  }
  // 当前选中的范围。切换范围会同时切换来源与提示文案。
  let activeScope: WizardScope = scopes[0] as WizardScope

  const overlay = document.createElement('div')
  overlay.id = 'dbstudio-transfer-wizard'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', '导出向导')
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,.45);'

  const panel = document.createElement('div')
  panel.style.cssText =
    'width:560px;max-width:calc(100vw - 32px);max-height:calc(100vh - 64px);' +
    'display:flex;flex-direction:column;background:var(--bg);color:var(--fg);' +
    'border:1px solid var(--border);border-radius:8px;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:13px;'

  // ---- 头部 ----
  const head = document.createElement('div')
  head.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;' +
    'padding:10px 14px;border-bottom:1px solid var(--border);font-weight:600;'
  const titleEl = document.createElement('span')
  titleEl.textContent = '导出向导'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = '✕'
  closeBtn.setAttribute('aria-label', '关闭')
  closeBtn.style.cssText = 'padding:0 6px;line-height:1.4;'
  head.append(titleEl, closeBtn)

  // ---- 主体 ----
  const body = document.createElement('div')
  body.style.cssText = 'padding:12px 14px;overflow:auto;display:grid;gap:10px;'

  const sourceBox = document.createElement('div')
  sourceBox.style.cssText =
    'padding:8px 10px;border:1px solid var(--border);border-radius:6px;' +
    'background:var(--bg-alt);font-size:12px;line-height:1.6;'
  const sourceTitle = document.createElement('div')
  sourceTitle.id = 'transfer-wizard-source'
  sourceTitle.style.cssText = 'font-weight:600;margin-bottom:2px;'
  const sourceNote = document.createElement('div')
  sourceNote.id = 'transfer-wizard-source-note'
  sourceNote.style.cssText = 'color:var(--fg-dim);'
  sourceBox.append(sourceTitle, sourceNote)

  /**
   * 刷新来源提示。
   *
   * 「筛选结果」与「原始结果集」指向**不同的 SQL**，所以文案必须跟着当前
   * 范围变。用户导完之后回头看进度，也要知道导的是哪一批数据。
   */
  const renderSource = (): void => {
    const source = activeScope.source
    const scopeNote = scopes.length > 1 ? `（${activeScope.label}）` : ''
    sourceTitle.textContent = `来源：${source.name}${scopeNote}`
    sourceNote.textContent =
      source.kind === 'sql' && activeScope.id === 'current' && activeScope.label.includes('筛选')
        ? '导出的是当前筛选结果（重新执行带条件的查询），不是原始结果集。'
        : source.kind === 'view'
          ? '按视图逐批读取；视图没有可插入的落点，因此不能用 SQL INSERT 格式。'
          : source.kind === 'table'
            ? '按表逐批读取；数据由主进程直接写入目标文件，不经过界面。'
            : '按查询逐批读取；数据由主进程直接写入目标文件，不经过界面。'
  }
  renderSource()

  // ---- 来源 × 格式的兼容性提示 ----
  /**
   * 「SQL INSERT + 视图」这类不兼容组合要**当场**说清楚。
   *
   * 早先的向导不拦，用户选完格式、填完路径、点「开始导出」，
   * 才由主进程报错"INSERT 目标不是表"——那时候一整套表单都填完了。
   */
  const compatibilityNote = document.createElement('div')
  compatibilityNote.id = 'transfer-wizard-compat'
  compatibilityNote.style.cssText =
    'padding:6px 10px;border:1px solid color-mix(in srgb, var(--danger) 55%, var(--border));' +
    'border-radius:6px;background:color-mix(in srgb, var(--danger) 9%, transparent);' +
    'color:var(--danger);font-size:12px;line-height:1.6;'

  /** 刷新兼容性提示：隐藏表示当前组合是允许的。 */
  const renderCompatibility = (): void => {
    const format = controls.formatSelect.value as TransferFormat
    const issue = describeIncompatibleSource(activeScope.source, format)
    compatibilityNote.textContent = issue ?? ''
    compatibilityNote.hidden = issue === null
  }

  // ---- 范围 ----
  const scopeField = field('导出范围', 'transfer-wizard-scope')
  scopeField.id = 'transfer-wizard-scope-field'
  const scopeSelect = document.createElement('select')
  scopeSelect.id = 'transfer-wizard-scope'
  scopeSelect.style.cssText = inputStyle()
  for (const scope of scopes) {
    const option = document.createElement('option')
    option.value = scope.id
    option.textContent = scope.label
    scopeSelect.appendChild(option)
  }
  scopeSelect.value = activeScope.id
  scopeSelect.addEventListener('change', () => {
    const next = scopes.find((scope) => scope.id === scopeSelect.value)
    if (!next) return
    activeScope = next
    renderSource()
    renderCompatibility()
    showErrors([])
  })
  scopeField.appendChild(scopeSelect)
  // 只有一个范围时不显示——没有第二个可选项，摆出来只是噪音。
  scopeField.hidden = scopes.length <= 1

  // ---- 格式 ----
  const formatField = field('格式', 'transfer-wizard-format')
  const formatSelect = document.createElement('select')
  formatSelect.id = 'transfer-wizard-format'
  formatSelect.style.cssText = inputStyle()
  for (const format of WIZARD_FORMATS) {
    const option = document.createElement('option')
    option.value = format
    option.textContent = FORMAT_LABELS[format]
    formatSelect.appendChild(option)
  }
  formatSelect.value = 'csv'
  formatField.appendChild(formatSelect)

  // ---- 目标路径 ----
  const pathField = field('目标文件路径（绝对路径）', 'transfer-wizard-path')
  const pathInput = document.createElement('input')
  pathInput.id = 'transfer-wizard-path'
  pathInput.type = 'text'
  pathInput.placeholder =
    options.defaultDirectory === undefined || options.defaultDirectory === null
      ? '/Users/me/export/users.csv（必须填绝对路径）'
      : `${options.defaultDirectory}/dbstudio-export.csv`
  pathInput.setAttribute('aria-label', '目标文件路径')
  pathInput.style.cssText = inputStyle()
  const pathHint = document.createElement('div')
  pathHint.style.cssText = 'font-size:11px;color:var(--fg-dim);'
  pathHint.id = 'transfer-wizard-path-hint'
  pathHint.textContent = renderPathHint(options.defaultDirectory ?? null)
  pathField.append(pathInput, pathHint)

  // ---- 批大小 ----
  const batchField = field('每批行数', 'transfer-wizard-batch')
  const batchInput = document.createElement('input')
  batchInput.id = 'transfer-wizard-batch'
  batchInput.type = 'number'
  batchInput.min = String(MIN_TRANSFER_BATCH_SIZE)
  batchInput.max = String(MAX_TRANSFER_BATCH_SIZE)
  batchInput.value = String(DEFAULT_TRANSFER_BATCH_SIZE)
  batchInput.setAttribute('aria-label', '每批行数')
  batchInput.style.cssText = inputStyle()
  const batchHint = document.createElement('div')
  batchHint.style.cssText = 'font-size:11px;color:var(--fg-dim);'
  batchHint.textContent = `影响主进程内存占用（只保留一批）。范围 ${MIN_TRANSFER_BATCH_SIZE} ~ ${MAX_TRANSFER_BATCH_SIZE}。`
  batchField.append(batchInput, batchHint)

  // ---- 表头 ----
  //
  // 这里用 div + 内层 label（而不是 field() 的 label 外壳）：
  // 复选框需要自己的 label 来关联说明文字，
  // 而 label 不能嵌套 label（无效 HTML，且部分读屏器会读错）。
  const headerField = document.createElement('div')
  headerField.className = 'field'
  const headerLabel = document.createElement('label')
  headerLabel.style.cssText = 'display:flex;align-items:center;gap:6px;'
  const headerInput = document.createElement('input')
  headerInput.id = 'transfer-wizard-header'
  headerInput.type = 'checkbox'
  headerInput.checked = true
  headerLabel.append(headerInput, document.createTextNode('包含表头（列名）'))
  /**
   * 表头选项的说明。
   *
   * 为什么必须说明：JSON / JSON Lines / SQL INSERT **没有表头行**，
   * 列名始终以别的方式表达（对象的键 / INSERT 的列清单）。
   * 所以对这三个格式，这个复选框是禁用的——而禁用必须解释原因，
   * 否则用户会以为界面坏了，或者以为取消勾选就能去掉列名。
   */
  const headerHint = document.createElement('div')
  headerHint.id = 'transfer-wizard-header-hint'
  headerHint.style.cssText = 'font-size:11px;color:var(--fg-dim);'
  headerField.append(headerLabel, headerHint)

  // ---- NULL 文本 ----
  const nullField = field('NULL 的文本表示', 'transfer-wizard-null')
  const nullInput = document.createElement('input')
  nullInput.id = 'transfer-wizard-null'
  nullInput.type = 'text'
  nullInput.value = ''
  nullInput.placeholder = '留空表示写空串'
  nullInput.setAttribute('aria-label', 'NULL 的文本表示')
  nullInput.style.cssText = inputStyle()
  nullField.appendChild(nullInput)

  // ---- 行分隔符 ----
  const newlineField = field('行分隔符', 'transfer-wizard-newline')
  const newlineSelect = document.createElement('select')
  newlineSelect.id = 'transfer-wizard-newline'
  newlineSelect.style.cssText = inputStyle()
  for (const [value, label] of [
    ['\r\n', 'CRLF（RFC 4180，Excel 友好）'],
    ['\n', 'LF（Unix）']
  ] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    newlineSelect.appendChild(option)
  }
  newlineSelect.value = '\r\n'
  newlineField.appendChild(newlineSelect)

  // ---- JSON 缩进 ----
  const indentField = field('JSON 缩进', 'transfer-wizard-indent')
  const indentInput = document.createElement('input')
  indentInput.id = 'transfer-wizard-indent'
  indentInput.type = 'number'
  indentInput.min = '0'
  indentInput.max = '8'
  indentInput.value = '2'
  indentInput.setAttribute('aria-label', 'JSON 缩进')
  indentInput.style.cssText = inputStyle()
  indentField.appendChild(indentInput)

  // ---- 错误 ----
  const errorBox = document.createElement('div')
  errorBox.id = 'transfer-wizard-errors'
  errorBox.hidden = true
  errorBox.style.cssText =
    'padding:8px 10px;border:1px solid color-mix(in srgb, var(--danger) 55%, var(--border));' +
    'border-radius:6px;background:color-mix(in srgb, var(--danger) 9%, transparent);' +
    'color:var(--danger);font-size:12px;line-height:1.6;'

  // ---- 进度 ----
  const progressBox = document.createElement('div')
  progressBox.id = 'transfer-wizard-progress'
  progressBox.hidden = true
  progressBox.style.cssText =
    'padding:8px 10px;border:1px solid var(--border);border-radius:6px;' +
    'background:var(--bg-alt);font-size:12px;line-height:1.6;'
  const progressText = document.createElement('div')
  progressText.id = 'transfer-wizard-progress-text'
  progressText.style.cssText = 'font-weight:600;'
  const progressDetail = document.createElement('div')
  progressDetail.id = 'transfer-wizard-progress-detail'
  progressDetail.style.cssText = 'color:var(--fg-dim);word-break:break-all;'
  progressBox.append(progressText, progressDetail)

  body.append(
    sourceBox,
    scopeField,
    formatField,
    pathField,
    batchField,
    headerField,
    nullField,
    newlineField,
    indentField,
    errorBox,
    compatibilityNote,
    progressBox
  )

  // ---- 底部按钮 ----
  const footer = document.createElement('div')
  footer.style.cssText =
    'display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;' +
    'border-top:1px solid var(--border);'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.id = 'transfer-wizard-cancel'
  cancelBtn.textContent = '取消'
  const startBtn = document.createElement('button')
  startBtn.type = 'button'
  startBtn.id = 'transfer-wizard-start'
  startBtn.textContent = '开始导出'
  startBtn.style.cssText =
    'background:var(--accent);color:var(--accent-fg);border-color:var(--accent);'
  footer.append(cancelBtn, startBtn)

  panel.append(head, body, footer)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  const controls: WizardControls = {
    overlay,
    scopeSelect,
    scopeField,
    formatSelect,
    pathInput,
    batchInput,
    headerInput,
    nullInput,
    newlineSelect,
    indentInput,
    nullField,
    headerField,
    headerHint,
    indentField,
    errorBox,
    progressBox,
    progressText,
    progressDetail,
    startBtn,
    cancelBtn,
    closeBtn
  }

  /**
   * 格式变化时禁用不适用的选项。
   *
   * 必须**禁用**而不是「填了再被后端拒绝」：用户看到禁用态就知道
   * "这个选项对这个格式不适用"，而不是提交后才吃一个错误。
   */
  const syncFormatOptions = (): void => {
    const format = controls.formatSelect.value as TransferFormat
    const supportsHeader = formatSupportsHeaderRow(format)
    const supportsNull = formatSupportsNullText(format)
    const supportsIndent = formatSupportsJsonIndent(format)
    controls.headerInput.disabled = !supportsHeader
    controls.nullInput.disabled = !supportsNull
    controls.indentInput.disabled = !supportsIndent
    controls.headerField.style.opacity = supportsHeader ? '1' : '.5'
    controls.nullField.style.opacity = supportsNull ? '1' : '.5'
    controls.indentField.style.opacity = supportsIndent ? '1' : '.5'
    // 禁用必须解释原因，否则用户会以为界面坏了。
    controls.headerHint.textContent = describeHeaderRowOption(format)
    // 来源 × 格式的兼容性（SQL INSERT + 视图/自由 SQL）。
    renderCompatibility()
    // 换格式时把默认文件名跟着换（仅当用户还没自己改过路径）。
    if (!pathTouched) {
      controls.pathInput.value = suggestDestination(
        controls.pathInput.value,
        format,
        new Date(),
        options.defaultDirectory ?? null
      )
    }
  }
  controls.formatSelect.addEventListener('change', syncFormatOptions)

  // 路径一旦被用户改过，就不再自动覆盖。
  let pathTouched = false
  controls.pathInput.addEventListener('input', () => {
    pathTouched = true
  })

  let closed = false
  let starting = false
  let taskId: string | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 最近一次看到的进度里的一致性语义。
   *
   * 记下来是为了在**终态**也能显示它：进度跑完后进度接口不再返回有意义的
   * 一致性字段，但"这不是数据库快照"这句话必须一直留在用户眼前。
   */
  let lastConsistency: TransferProgress['consistency'] = 'live-paged'
  const startedAt = Date.now()

  const close = (): void => {
    if (closed) return
    closed = true
    if (pollTimer !== null) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
    options.onClosed?.()
  }

  const requestClose = (): void => {
    if (shouldBlockWizardClose(taskId, starting)) {
      cb.onStatus('导出仍在进行，请先点「取消」结束任务', true)
      return
    }
    close()
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    // 有任务在跑时，Esc 不直接关窗——先提示用户去点「取消」。
    // 悄悄关掉窗口但任务还在后台跑，用户会以为导出停了。
    if (shouldBlockWizardClose(taskId, starting)) {
      cb.onStatus('导出仍在进行，请先点「取消」结束任务', true)
      return
    }
    e.stopPropagation()
    close()
  }
  document.addEventListener('keydown', onKey, true)
  controls.closeBtn.addEventListener('click', requestClose)

  const setBusy = (busy: boolean): void => {
    controls.startBtn.disabled = busy
    controls.scopeSelect.disabled = busy
    controls.formatSelect.disabled = busy
    controls.pathInput.disabled = busy
    controls.batchInput.disabled = busy
    controls.headerInput.disabled = busy
    controls.nullInput.disabled = busy
    controls.newlineSelect.disabled = busy
    controls.indentInput.disabled = busy
    if (busy) {
      controls.startBtn.textContent = '导出中…'
      controls.cancelBtn.textContent = '取消导出'
    } else {
      controls.startBtn.textContent = '开始导出'
      controls.cancelBtn.textContent = '取消'
    }
  }

  const showErrors = (errors: readonly TransferFormError[]): void => {
    controls.errorBox.replaceChildren()
    for (const error of errors) {
      const line = document.createElement('div')
      line.textContent = `• ${error.message}`
      controls.errorBox.appendChild(line)
    }
    controls.errorBox.hidden = errors.length === 0
  }

  /** 轮询进度，直到任务进入终态。 */
  const poll = async (): Promise<void> => {
    if (taskId === null || closed) return
    let progress: TransferProgress | null = null
    try {
      progress = await api.getTransferProgress(taskId)
    } catch (e) {
      cb.onStatus(`读取导出进度失败：${errorText(e)}`, true)
    }
    if (progress !== null) {
      lastConsistency = progress.consistency
      controls.progressBox.hidden = false
      controls.progressText.textContent = describeProgress(progress, Date.now() - startedAt)
      const detailParts: string[] = [describeConsistency(progress.consistency)]
      if (progress.message !== undefined) detailParts.push(progress.message)
      controls.progressDetail.textContent = detailParts.join(' · ')
    }
    if (progress !== null && isTerminalStatus(progress.status)) {
      await finish(taskId)
      return
    }
    pollTimer = setTimeout(() => void poll(), PROGRESS_POLL_INTERVAL_MS)
  }

  /** 任务结束：取终态结果并展示。 */
  const finish = async (id: string): Promise<void> => {
    let result: TransferResult | null = null
    try {
      result = await api.waitTransfer(id)
    } catch (e) {
      cb.onStatus(`导出结束状态获取失败：${errorText(e)}`, true)
      setBusy(false)
      taskId = null
    }
    if (result === null) return
    const summary = describeResult(result)
    controls.progressBox.hidden = false
    controls.progressText.textContent = describeTransferStatus(result.status)
    /**
     * 终态也要保留一致性声明。
     *
     * 为什么不能只显示结果摘要：一致性（"不是数据库快照"）是用户判断
     * "这份文件能不能当基准用"的唯一依据。进度跑完就把这句话抹掉，
 * 等于让最重要的限制在最后一刻消失。
     */
    controls.progressDetail.textContent = `${summary} · ${describeConsistency(
      lastConsistency
    )}`
    cb.onStatus(summary, result.status !== 'completed')
    setBusy(false)
    // 任务已经结束，Esc 现在可以关窗了。
    taskId = null
  }

  const start = async (): Promise<void> => {
    showErrors([])
    const values: TransferFormValues = {
      format: controls.formatSelect.value,
      destinationPath: controls.pathInput.value,
      batchSize: controls.batchInput.value,
      includeHeader: controls.headerInput.checked,
      nullText: controls.nullInput.value,
      newline: controls.newlineSelect.value,
      jsonIndent: controls.indentInput.value
    }
    const validation = validateTransferForm(activeScope.source, values)
    if (!validation.ok) {
      showErrors(validation.errors)
      cb.onStatus('导出向导：请先修正表单中的问题', true)
      return
    }

    setBusy(true)
    controls.progressBox.hidden = false
    controls.progressText.textContent = '正在启动导出任务…'
    controls.progressDetail.textContent = ''

    starting = true
    try {
      const progress = await api.startTransfer(validation.request)
      taskId = progress.taskId
      lastConsistency = progress.consistency
      controls.progressText.textContent = describeProgress(progress, Date.now() - startedAt)
      controls.progressDetail.textContent = describeConsistency(progress.consistency)
      void poll()
    } catch (e) {
      setBusy(false)
      const message = errorText(e)
      showErrors([{ field: 'destinationPath', message }])
      cb.onStatus(`导出失败：${message}`, true)
    } finally {
      starting = false
    }
  }

  controls.startBtn.addEventListener('click', () => void start())

  controls.cancelBtn.addEventListener('click', () => {
    if (taskId === null) {
      if (starting) {
        cb.onStatus('导出仍在进行，请先点「取消」结束任务', true)
        return
      }
      close()
      return
    }
    const id = taskId
    controls.cancelBtn.disabled = true
    void (async () => {
      try {
        const accepted = await api.cancelTransfer(id)
        if (!accepted) {
          /**
           * 取消没被接受：可能是任务刚结束，或已进入不可取消的提交阶段。
           * 如实告诉用户**为什么**，而不是假装取消了。
           */
          cb.onStatus('取消未被接受：任务可能已结束，或已进入最终写入阶段', true)
        } else {
          cb.onStatus('已请求取消导出（将在当前批次结束后生效）')
        }
      } catch (e) {
        cb.onStatus(`取消导出失败：${errorText(e)}`, true)
      } finally {
        controls.cancelBtn.disabled = false
      }
    })()
  })

  syncFormatOptions()
  controls.pathInput.focus()
}

/** 构造一个 field 行（标签 + 控件容器）。 */
function field(label: string, inputId: string): HTMLElement {
  const wrap = document.createElement('label')
  wrap.className = 'field'
  if (label !== '') {
    const span = document.createElement('span')
    span.textContent = label
    // 用 setAttribute 而不是 span.htmlFor：htmlFor 只存在于 label 元素上。
    if (inputId !== '') span.setAttribute('for', inputId)
    wrap.appendChild(span)
  }
  return wrap
}

/** 从任意错误形状里抽出可读文本。 */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
