/**
 * CSV 导入向导：主进程读取文件，界面仅接收有界样例与解析诊断。
 * 文件参数变化后重新预览；映射校验通过且当前预览无错误时才允许启动。
 * 任务跟踪、取消与事务终态继续使用现有导入生命周期。
 */

import type { DbStudioApi } from '../core/api'
import type { ColumnDescription } from '../core/model'
import type { ImportPreview, ImportProgress, ImportRequest, ImportResult } from '../core/transfer'
import {
  DEFAULT_TRANSFER_BATCH_SIZE,
  MAX_TRANSFER_BATCH_SIZE,
  MIN_TRANSFER_BATCH_SIZE
} from '../core/transfer'

// ============================================================================
// 纯逻辑区（可被 Node 直接单测）
// ============================================================================

/**
 * 向导表单的取值。**全部是字符串**（布尔除外）。
 *
 * 与导出向导同一理由：`<input>` 的值一律是字符串，
 * 提前保持字符串能把"用户输入了非法值"如实保留到校验阶段，
 * 而不是让 `parseInt('12abc')` 悄悄变成 12。
 */
export interface ImportFormValues {
  readonly sourcePath: string
  readonly delimiter: string
  readonly nullText: string
  readonly hasHeader: boolean
  readonly batchSize: string
  /** 每行一个目标列名，顺序即 CSV 列顺序。 */
  readonly targetColumns: readonly string[]
}

/** 校验失败时的结果。`field` 用于在界面上高亮出错的那一项。 */
export interface ImportFormError {
  readonly field:
    | 'sourcePath'
    | 'delimiter'
    | 'nullText'
    | 'hasHeader'
    | 'batchSize'
    | 'targetColumns'
    | 'general'
  readonly message: string
}

/** 校验结果。`ok` 为 false 时 `errors` 一定非空。 */
export type ImportFormValidation =
  | { readonly ok: true; readonly request: ImportRequest }
  | { readonly ok: false; readonly errors: readonly ImportFormError[] }

/**
 * 绝对路径判定（跨平台）。
 *
 * 与导出向导用同一套规则，但**这里单独写一份**而不是跨文件 import：
 * 导入向导是独立模块，跨模块共享一个只为了几行判断的工具函数
 * 会把两个本可独立演进的模块绑在一起。
 *
 * 判定规则：POSIX 以 `/` 开头；Windows 盘符 `C:\` / `C:/`；
 * UNC 路径 `\\server\share`。
 */
export function isAbsoluteImportPath(value: string): boolean {
  if (value === '') return false
  if (/^[\\/]{2}[^\\/]/.test(value)) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (value.startsWith('/')) return true
  return false
}

/**
 * 分隔符合法性判定。
 *
 * 与后端（core/csv.ts 的 `normalizeOptions`）**同一套规则**：
 * 必须是单个字符，且不能是引号或换行符。
 *
 * 为什么要在前端也判一遍：分隔符填错是导入里最常见的手滑，
 * 而它造成的失败在**提交之后**才暴露——用户填完一整套表单，
 * 才被告知"分隔符必须是单个字符"。当场拦下更省事。
 */
export function isValidDelimiter(delimiter: string): boolean {
  if (delimiter.length !== 1) return false
  return delimiter !== '"' && delimiter !== '\r' && delimiter !== '\n'
}

/**
 * 目标列解析：把用户填的行拆成**去掉首尾空白**的列名列表。
 *
 * 为什么 trim：用户从表格里复制列名常常带上空格或换行。
 * 不 trim 的话 `" id"` 与 `"id"` 会被当成两个不同的列，
 * 而驱动侧的大小写不敏感匹配又会把它们判成"重复列"——
 * 用户完全看不出错在哪。
 *
 * 空行被丢弃：映射区允许用户留空行（视觉分隔用），空行不该变成一个空列名。
 */
export function parseTargetColumns(rawLines: readonly string[]): string[] {
  const out: string[] = []
  for (const line of rawLines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    out.push(trimmed)
  }
  return out
}

/**
 * 找出重复的目标列名。
 *
 * 返回**重复出现的那些名字**（去重后的列表），而不是所有重复项：
 * 界面上要说的是"name 重复了两次"，而不是把同一个名字报三遍。
 *
 * 大小写不敏感：驱动侧解析列名是大小写不敏感的
 * （见 drivers/sqlite/edits.ts 的 `resolveColumns`），
 * 所以 `"ID"` 与 `"id"` 在后端会被解析成同一列——前端必须用同样的口径判定，
 * 否则前端说"没问题"，后端报"导入目标列重复"。
 */
export function findDuplicateTargetColumns(columns: readonly string[]): string[] {
  const seen = new Map<string, number>()
  const duplicates = new Set<string>()
  for (const column of columns) {
    const key = column.toLowerCase()
    const count = seen.get(key) ?? 0
    seen.set(key, count + 1)
    if (count >= 1) duplicates.add(column)
  }
  return [...duplicates]
}

/**
 * 目标列是否存在于目标表。
 *
 * 为什么前端也要查这一层：填了表里没有的列名，导入**必然**失败，
 * 而失败发生在提交之后。前端能当场说"目标表没有这一列"，
 * 比等后端报"导入目标列不存在"省一轮。
 *
 * 判定口径与驱动一致：**大小写不敏感**。
 */
export function findUnknownTargetColumns(
  columns: readonly string[],
  availableColumns: readonly string[]
): string[] {
  const available = new Set(availableColumns.map((column) => column.toLowerCase()))
  return columns.filter((column) => !available.has(column.toLowerCase()))
}

export function findUnmappedRequiredColumns(
  mappedColumns: readonly string[],
  availableColumns: readonly ColumnDescription[]
): ColumnDescription[] {
  const mapped = new Set(mappedColumns.map((column) => column.toLowerCase()))
  return availableColumns.filter((column) => {
    // 驱动静态提示优先；未提供时只在生成信息明确的情况下回退判定。
    const strictFallback = !column.nullable && column.defaultValue === null &&
      column.generated === null && column.identity === null
    const required = column.requiredOnInsert ?? strictFallback
    return required && !mapped.has(column.name.toLowerCase())
  })
}

/**
 * 校验并组装导入请求。
 *
 * 这是整个向导**唯一**把「用户输入」变成「跨进程请求」的地方，
 * 所以所有前端能判的约束都集中在这里，便于单测覆盖。
 *
 * 校验分两层（见文件头）：这里拦手滑，主进程拦事实。
 */
export function validateImportForm(
  targetNodeId: string,
  values: ImportFormValues,
  /** 目标表的可用列（来自 `describeTable`）。为空表示没取到，跳过这一层校验。 */
  availableColumns: readonly ColumnDescription[] = []
): ImportFormValidation {
  const errors: ImportFormError[] = []

  // ---- 目标表 ----
  if (targetNodeId.trim() === '') {
    errors.push({ field: 'general', message: '没有选中目标表，无法开始导入。' })
  }

  // ---- CSV 路径 ----
  const sourcePath = values.sourcePath.trim()
  if (sourcePath === '') {
    errors.push({ field: 'sourcePath', message: '必须填写 CSV 文件路径' })
  } else if (!isAbsoluteImportPath(sourcePath)) {
    /**
     * 必须是**绝对路径**。
     *
     * 为什么要拦：主进程会按字面路径读文件，相对路径会相对于
     * **主进程的工作目录**解析——那通常不是用户以为的目录，
     * 文件会"找不到"，而且用户完全无从判断是路径写错还是文件不在。
     */
    errors.push({
      field: 'sourcePath',
      message: 'CSV 文件路径必须是绝对路径（以 / 或盘符开头）'
    })
  }

  // ---- 分隔符 ----
  if (!isValidDelimiter(values.delimiter)) {
    errors.push({
      field: 'delimiter',
      message: '分隔符必须是单个字符，且不能是引号（"）或换行符'
    })
  }

  // ---- NULL 文本 ----
  /**
   * NULL 文本**允许为空**：空串就是最常见的 NULL 标记（未加引号的空字段）。
   *
   * 但空串有一处必须说清楚：CSV 里**未加引号的空字段**会被当成 NULL，
   * 而**加了引号的空字段**（`""`）是空字符串。这条规则由后端统一判定，
   * 界面上必须写出来，否则用户会以为"空 = 空字符串"。
   */
  if (typeof values.nullText !== 'string') {
    errors.push({ field: 'nullText', message: 'NULL 标记必须是文本' })
  }

  // ---- 表头 ----
  if (typeof values.hasHeader !== 'boolean') {
    errors.push({ field: 'hasHeader', message: '「是否有表头」必须是布尔值' })
  }

  // ---- 批大小 ----
  const batchSizeText = values.batchSize.trim()
  let batchSize = DEFAULT_TRANSFER_BATCH_SIZE
  if (batchSizeText !== '') {
    /**
     * 严格解析：**整串必须都是数字**。
     *
     * 不用 `parseInt`：它对 "12abc" 返回 12，用户输入错了却得到一个
     * "看起来生效"的 12。非法就报错。
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

  // ---- 目标列映射 ----
  const targetColumns = parseTargetColumns(values.targetColumns)
  if (targetColumns.length === 0) {
    errors.push({
      field: 'targetColumns',
      message: '必须至少填写一个目标列（每行一个，顺序与 CSV 列顺序一致）'
    })
  }
  const duplicates = findDuplicateTargetColumns(targetColumns)
  if (duplicates.length > 0) {
    errors.push({
      field: 'targetColumns',
      message: `目标列不能重复：${duplicates.join('、')}（同一个列不能接收两列 CSV 数据）`
    })
  }
  const unknown = findUnknownTargetColumns(
    targetColumns,
    availableColumns.map((column) => column.name)
  )
  if (unknown.length > 0) {
    errors.push({
      field: 'targetColumns',
      message: `目标表里没有这些列：${unknown.join('、')}`
    })
  }

  const mapped = new Set(targetColumns.map((column) => column.toLowerCase()))
  const readOnlyColumns = availableColumns.filter((column) =>
    mapped.has(column.name.toLowerCase()) &&
    (column.identity === 'always' || (column.generated !== null && column.generated !== undefined))
  )
  if (readOnlyColumns.length > 0) {
    errors.push({ field: 'targetColumns',
      message: `这些列由数据库自动生成，不能作为导入目标：${readOnlyColumns.map((column) => column.name).join('、')}` })
  }
  const unmappedRequired = findUnmappedRequiredColumns(targetColumns, availableColumns)
  if (unmappedRequired.length > 0) {
    errors.push({
      field: 'targetColumns',
      message: `未映射必填列：${unmappedRequired.map((column) => column.name).join('、')}`
    })
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    request: {
      targetNodeId,
      sourcePath,
      delimiter: values.delimiter,
      nullText: values.nullText,
      hasHeader: values.hasHeader,
      targetColumns,
      batchSize
    }
  }
}

/** 预览诊断与目标映射位置必须同时通过，才能开始导入。 */
export function validateImportPreview(
  preview: ImportPreview,
  mappedColumns: readonly string[]
): ImportFormError[] {
  const errors: ImportFormError[] = []
  const errorCount = Math.max(preview.errorCount, Array.isArray(preview.errors) ? preview.errors.length : 0)
  if (errorCount > 0) {
    errors.push({ field: 'general', message: `CSV 有 ${errorCount} 个解析错误，请先修正文件。` })
  }
  if (mappedColumns.length !== preview.columns.length) {
    errors.push({ field: 'targetColumns', message: `CSV 有 ${preview.columns.length} 列，目标映射有 ${mappedColumns.length} 列，必须一一对应。` })
  }
  return errors
}

/** 任务状态的中文标签。 */
export function describeImportStatus(status: ImportProgress['status']): string {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '导入中'
    case 'committing':
      return '正在提交事务'
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
export function isTerminalImportStatus(status: ImportProgress['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/**
 * 向导是否应阻止关闭。
 *
 * `starting` 覆盖 `startImport` 尚未返回 taskId 的窗口；`finishing`
 * 覆盖已读到终态、但 `waitImport` 还没返回的窗口。只看 taskId 会漏掉
 * 这两段，用户能在任务已经发出后把向导静默关掉。
 */
export function shouldBlockImportWizardClose(
  taskId: string | null,
  starting = false,
  finishing = false
): boolean {
  return taskId !== null || starting || finishing
}

/**
 * 失败位置的一行文案。
 *
 * 为什么单独抽出来：行/列信息是**导入失败时最有价值的东西**——
 * 用户要知道"第几行、哪一列"才能回去改 CSV。
 * 分散在多处拼装很容易漏掉某一种位置组合（只有行 / 行+列 / 只有列 /
 * 文件级错误），所以统一在这里处理。
 *
 * 返回 null 表示没有位置信息（文件级错误）。
 */
export function formatImportLocation(
  location:
    | {
        readonly row?: number
        readonly line?: number
        readonly column?: number
        readonly columnName?: string
      }
    | undefined
): string | null {
  if (location === undefined) return null
  const parts: string[] = []
  if (location.row !== undefined) parts.push(`数据第 ${location.row} 行`)
  if (location.line !== undefined) parts.push(`文件第 ${location.line} 行`)
  if (location.column !== undefined) parts.push(`第 ${location.column} 列`)
  if (location.columnName !== undefined && location.columnName !== '') {
    parts.push(`列「${location.columnName}」`)
  }
  if (parts.length === 0) return null
  return parts.join(' · ')
}

/**
 * 把进度快照渲染成一行摘要。
 */
export function describeImportProgress(progress: ImportProgress): string {
  const parts: string[] = [describeImportStatus(progress.status)]
  if (progress.totalRows > 0) {
    parts.push(`共 ${progress.totalRows.toLocaleString()} 行`)
  }
  parts.push(`已导入 ${progress.rowsImported.toLocaleString()} 行`)
  if (progress.batches > 0) parts.push(`${progress.batches} 批`)
  return parts.join(' · ')
}

/**
 * 后端消息里**回滚失败**的信号。
 *
 * 有这个信号时**绝不能**说"已回滚、目标表没有留下数据"——
 * 回滚本身失败了，事务可能仍未结束。
 * ImportManager 在回滚失败时也会把 `rowsImported` 归零，
 * 因此不能只凭行数推断回滚一定成功。
 */
export function hasImportRollbackFailure(message: string | undefined): boolean {
  if (message === undefined) return false
  return /回滚(?:也|操作|事务|时)?失败|回滚(?:未|没有)成功|无法回滚|回滚后事务仍处于活动状态|事务可能仍未结束|ROLLBACK\s+执行失败|rollback\s+(?:failed|failure)/i.test(
    message
  )
}

/**
 * 失败/取消的**语义分类**。
 *
 * ===== 为什么必须分类，不能只看 status =====
 *
 * `failed` / `cancelled` 背后其实是**三种截然不同的事实**，
 * 而它们的补救动作完全相反：
 *
 *   - **提交结果未知**（`COMMIT_OUTCOME_UNKNOWN:`）：事务可能已经提交，
 *     也可能没有。此时**最危险的动作是"再导一次"**（会写进两份数据），
 *     所以文案绝不能说"已回滚、目标表没有留下数据"。
 *   - **宿主已终止**（`HOST_TERMINATED_TIMEOUT:`）：驱动宿主被隔离，
 *     未提交事务将由数据库在**连接断开时**回滚——那是**将来时**，
 *     不是"已经回滚成功"，所以不能声称回滚已确认。
 *   - **普通失败/取消**：可能发生在**任何写入之前**（解析拒绝、目标连接上
 *     已有未提交事务……），也可能发生在写入之后。到底有没有回滚过，
 *     只有后端知道；前端**不能替后端承诺**。
 *
 * ===== 稳定前缀优先 =====
 *
 * 前缀是后端给的**机器可读契约**，比通用文案更具体。
 * 所以判定顺序是：稳定前缀 → 回滚失败信号 → 明确已回滚信号 → 普通失败/取消。
 * 前缀必须排在前面：提交结果未知时哪怕文案里出现了"回滚"字样，
 * 也不能按普通失败处理（那会直接误导用户重复导入）。
 */
export type ImportOutcomeKind =
  | 'completed'
  | 'commit-outcome-unknown'
  | 'host-terminated'
  | 'rollback-failed'
  | 'rolled-back'
  | 'cancelled'
  | 'failed'

/** 稳定前缀：提交结果未知（可能已提交，也可能没提交）。 */
export const IMPORT_COMMIT_OUTCOME_UNKNOWN_PREFIX = 'COMMIT_OUTCOME_UNKNOWN:'
/** 稳定前缀：驱动宿主在事务边界被终止。 */
export const IMPORT_HOST_TERMINATED_PREFIX = 'HOST_TERMINATED_TIMEOUT:'

/**
 * 后端明确说"这次写入已经回滚"的信号。
 *
 * ImportManager 在取消且**确实回滚过**时才会写"已回滚本任务写入"；
 * 没写入过就取消时消息里没有这句话。
 */
export function hasImportRollbackConfirmed(message: string | undefined): boolean {
  if (message === undefined) return false
  // "回滚也失败"之类的消息里也会出现"回滚"字样，但那是**相反**的结论。
  if (hasImportRollbackFailure(message)) return false
  return message.includes('已回滚')
}

/**
 * 把导入终态归类到一种语义。
 *
 * 纯函数：不碰 DOM、不碰 API，Node 里可直接单测。
 */
export function classifyImportOutcome(result: ImportResult): ImportOutcomeKind {
  if (result.status === 'completed') return 'completed'
  const message = result.message?.trimStart() ?? ''
  // 稳定前缀优先：它比通用文案更具体，也更安全。
  if (message.startsWith(IMPORT_COMMIT_OUTCOME_UNKNOWN_PREFIX)) return 'commit-outcome-unknown'
  if (message.startsWith(IMPORT_HOST_TERMINATED_PREFIX)) return 'host-terminated'
  if (hasImportRollbackFailure(message)) return 'rollback-failed'
  if (hasImportRollbackConfirmed(message)) return 'rolled-back'
  return result.status === 'cancelled' ? 'cancelled' : 'failed'
}

/**
 * 取消终态的正文（去掉后端文案里与"已取消"重复的那截前缀）。
 *
 * 后端的取消消息固定以"导入已取消"开头；不去掉的话摘要会变成
 * "已取消：导入已取消，已回滚本任务写入"这种叠字。
 */
function cancelledDetail(message: string | undefined): string {
  const text = message?.trim() ?? ''
  if (!text.startsWith('导入已取消')) return text
  return text.slice('导入已取消'.length).replace(/^[，,、：:；;]\s*/, '').trim()
}

/**
 * 终态结果摘要（显示给用户）。
 *
 * ===== 这段文案是「安全属性」，不是「措辞」=====
 *
 * 它决定了用户接下来做什么动作，所以**不能**替后端承诺后端没说过的事：
 *
 *   - 提交结果未知 → 绝不能说"已回滚"（否则用户会再导一次，写进两份数据）；
 *   - 宿主已终止 → 绝不能说"已回滚"（回滚是连接断开时**将来**才发生的事）；
 *   - 普通失败/取消 → 绝不能笼统说"已回滚"（它可能发生在任何写入之前）。
 *
 * 只有后端**明确给了回滚信号**时，才可以说目标表没有留下本次导入的数据。
 */
export function describeImportResult(result: ImportResult): string {
  const kind = classifyImportOutcome(result)
  if (kind === 'completed') {
    return `导入完成：${result.rowsImported.toLocaleString()} 行已写入「${result.targetNodeId}」`
  }

  const location = formatImportLocation(result)
  const where = location === null ? '' : `（${location}）`
  const message = result.message ?? '未知原因'
  // 取消与失败的措辞不同，后端文案也不同（取消消息以"导入已取消"开头）。
  const cancelled = result.status === 'cancelled'
  const body = cancelled ? cancelledDetail(result.message) : message
  const head = cancelled
    ? body === ''
      ? '已取消'
      : `已取消：${body}`
    : `导入失败${where}：${body}`

  switch (kind) {
    case 'commit-outcome-unknown':
      /**
       * 提交结果未知：**不能**说"已回滚 / 没有留下数据"——
       * 事务可能已经提交成功，此时目标表里**已经有**这次的数据。
       * 唯一安全的动作是"先核实目标表，再决定要不要重来"。
       */
      return (
        `${head}。` +
        `${result.rowsImported > 0 ? `本次写入 ${result.rowsImported.toLocaleString()} 行，` : ''}` +
        '但无法确认是否已提交（数据可能已提交，也可能未提交）；' +
        '请先核实目标表，确认未导入后再决定是否重新导入。'
      )
    case 'host-terminated':
      /**
       * 宿主已终止：未提交事务会**在连接断开时**由数据库回滚，
       * 那是**将来时**。不能声称"已回滚"，只能说"尚未确认"。
       */
      return (
        `${head}。驱动宿主已终止并隔离：` +
        '未提交事务将在连接断开时由数据库回滚，但回滚结果尚未确认；' +
        '请重新连接后核对目标表数据，再决定是否重新导入。'
      )
    case 'rollback-failed':
      return (
        `${head}。回滚失败：事务可能仍未结束，` +
        '请断开连接以强制回滚，并核实目标表中的数据。'
      )
    case 'rolled-back':
      // 后端已经明说回滚过了，这时才可以断言目标表没有残留。
      return `${head}。目标表没有留下本次导入的数据。`
    case 'cancelled':
    case 'failed':
    default:
      /**
       * 普通失败/取消：可能一次都没写入，也可能写了一半。
       * 后端没给"已回滚"信号，前端就**不替它承诺**"已回滚 / 没有部分数据"，
       * 只如实转述后端原因，并提示用户去核实目标表。
       */
      return `${head}。请核实目标表数据后再决定是否重新导入。`
  }
}

// ============================================================================
// DOM 装配区
// ============================================================================

/** 向导对外的接口。 */
export interface ImportWizardCallbacks {
  /** 状态栏输出（进度、结果、错误）。 */
  onStatus(text: string, isError?: boolean): void
  /**
   * 导入成功后通知外部刷新目标表的数据视图。
   *
   * 返回 Promise 时向导会**等它完成**再写最终状态栏。
   *
   * 为什么要有这个约定：刷新表格会让网格自己往状态栏写一句
   * 「已返回 2 行」——如果向导先写「导入完成」、再刷新，
   * 用户最后看到的是那句无关的刷新提示，**导入结论被冲掉了**。
   * 所以顺序必须反过来：先刷新（让噪声先发生），再写结论。
   */
  onImported?(): void | Promise<void>
}

/** 打开向导时给出的上下文。 */
export interface ImportWizardOptions {
  readonly api: DbStudioApi
  /** 目标表节点 id（`connection:c1|table:users`）。 */
  readonly targetNodeId: string
  /** 目标表名（显示在向导顶部）。 */
  readonly targetName: string
  /** 目标表的列（来自 `describeTable`）。取不到时向导仍可打开，只是少了列名校验。 */
  readonly targetColumns: readonly ColumnDescription[]
  readonly cb: ImportWizardCallbacks
  /** 向导关闭后的回调。 */
  onClosed?: () => void
}

/** 进度轮询间隔（毫秒）。 */
const PROGRESS_POLL_INTERVAL_MS = 200

/**
 * 当前打开的导入向导（**单例**）。
 *
 * ===== 为什么必须是单例 =====
 *
 * 早先每次调用 `openImportWizard` 都往页面上追加一个新的遮罩层，
 * 于是"连续导入两次"会留下**两个** `#dbstudio-import-wizard`：
 *   - 后一个遮罩盖在前一个上面，同一个 id 匹配到两个元素，
 *     自动化脚本点「开始导入」时会点不动（被前一个的遮罩拦截）；
 *   - 更糟的是，两个向导各自持有一个 taskId：用户在**旧**向导上点
 *     「取消导入」，取消的其实是**另一个任务**，而界面上完全看不出来。
 *
 * 导出向导（transfer-dialog.ts）也有同样的隐患，但本轮只修导入这一侧，
 * 不扩大改动范围。
 */
let activeWizard: ActiveImportWizard | null = null

/** 单例登记所需的两个动作。 */
interface ActiveImportWizard {
  /** 关闭这个向导（不等导入任务结束）。 */
  close(): void
  /** 是否还有导入任务在跑。 */
  hasRunningTask(): boolean
}

/** 内部控件句柄。 */
interface ImportWizardControls {
  readonly overlay: HTMLElement
  readonly pathInput: HTMLInputElement
  readonly browseBtn: HTMLButtonElement
  readonly delimiterInput: HTMLInputElement
  readonly nullInput: HTMLInputElement
  readonly headerInput: HTMLInputElement
  readonly batchInput: HTMLInputElement
  readonly columnInput: HTMLTextAreaElement
  readonly columnList: HTMLElement
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
 * 打开 CSV 导入向导。
 *
 * 流程：
 *   1. 展示表单（路径 / 分隔符 / NULL 文本 / 表头 / 批大小 / 目标列映射）；
 *   2. 点「开始导入」→ 前端校验 → `startImport`；
 *   3. 轮询 `getImportProgress` 更新进度面板；
 *   4. 任务结束 → `waitImport` 拿终态 → 显示结果摘要与失败位置；
 *   5. 点「取消」→ `cancelImport`（任务级，不影响同连接的其它查询）。
 *
 * 跟踪链路（3/4 两步）出错时**不丢 taskId**：向导保持打开、关闭继续被阻断，
 * 并把「重试读取」与「取消导入」两条出口留给用户——
 * 否则一个还在写库的后端任务就变成了没人看得见、也取消不掉的任务。
 *
 * 渲染进程仅接收有界样例和诊断，不接收完整文件字节。
 */
export function openImportWizard(options: ImportWizardOptions): void {
  const { api, targetNodeId, targetName, targetColumns, cb } = options

  /**
   * 先把上一个向导关掉，保证页面上**同时只有一个**导入向导。
   *
   * 但如果旧向导**还有任务在跑**，不能直接关掉——那会把一个正在写库的
   * 导入变成"看不见的任务"，用户既看不到进度也点不到取消。
   * 这种情况下**拒绝打开新的**，并把原因说清楚：
   * 导入任务与导出任务一样是**连接级独占**的（主进程会拒绝同连接的第二个任务），
   * 所以这里拦住比让用户填完表单才吃后端的拒绝要好。
   */
  if (activeWizard !== null) {
    if (activeWizard.hasRunningTask()) {
      cb.onStatus('已有导入任务在进行，请先等它结束或点「取消」结束任务', true)
      return
    }
    activeWizard.close()
    activeWizard = null
  }

  const overlay = document.createElement('div')
  overlay.id = 'dbstudio-import-wizard'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', '导入 CSV 向导')
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,.45);'

  const panel = document.createElement('div')
  panel.style.cssText =
    'width:620px;max-width:calc(100vw - 32px);max-height:calc(100vh - 64px);' +
    'display:flex;flex-direction:column;background:var(--bg);color:var(--fg);' +
    'border:1px solid var(--border);border-radius:8px;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:13px;'

  // ---- 头部 ----
  const head = document.createElement('div')
  head.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;' +
    'padding:10px 14px;border-bottom:1px solid var(--border);font-weight:600;'
  const titleEl = document.createElement('span')
  titleEl.textContent = '导入 CSV'
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
  sourceTitle.id = 'import-wizard-source'
  sourceTitle.style.cssText = 'font-weight:600;margin-bottom:2px;'
  sourceTitle.textContent = `目标表：${targetName}`
  const sourceNote = document.createElement('div')
  sourceNote.id = 'import-wizard-source-note'
  sourceNote.style.cssText = 'color:var(--fg-dim);'
  sourceNote.textContent =
    'CSV 由主进程读取并逐批写入，界面只接收有界样例预览。' +
    '导入在单个事务里进行：任一行失败会整次回滚，目标表不会留下部分数据。' +
    '后端将在开始导入时完整校验（列数、列名、NULL 与类型约束）。'
  sourceBox.append(sourceTitle, sourceNote)

  // ---- CSV 路径 ----
  const pathField = field('CSV 文件路径（绝对路径）', 'import-wizard-path')
  const pathInput = document.createElement('input')
  pathInput.id = 'import-wizard-path'
  pathInput.type = 'text'
  pathInput.placeholder = '/Users/me/data/users.csv（必须填绝对路径）'
  pathInput.setAttribute('aria-label', 'CSV 文件路径')
  pathInput.style.cssText = inputStyle()
  const browseBtn = document.createElement('button')
  browseBtn.type = 'button'
  browseBtn.id = 'import-wizard-browse'
  browseBtn.textContent = '浏览…'
  browseBtn.setAttribute('aria-label', '选择 CSV 文件')
  browseBtn.style.cssText = 'margin-top:6px;'
  const pathHint = document.createElement('div')
  pathHint.id = 'import-wizard-path-hint'
  pathHint.style.cssText = 'font-size:11px;color:var(--fg-dim);'
  pathHint.textContent = '必须填绝对路径（以 / 或盘符开头）；相对路径会被拒绝。'
  pathField.append(pathInput, browseBtn, pathHint)

  // ---- 分隔符 ----
  const delimiterField = field('字段分隔符', 'import-wizard-delimiter')
  const delimiterInput = document.createElement('input')
  delimiterInput.id = 'import-wizard-delimiter'
  delimiterInput.type = 'text'
  delimiterInput.value = ','
  delimiterInput.maxLength = 1
  delimiterInput.setAttribute('aria-label', '字段分隔符')
  delimiterInput.style.cssText = inputStyle()
  const delimiterHint = document.createElement('div')
  delimiterHint.id = 'import-wizard-delimiter-hint'
  delimiterHint.style.cssText = 'font-size:11px;color:var(--fg-dim);'
  delimiterHint.textContent = '单个字符（常用 , 或 ;），不能是引号或换行符。'
  delimiterField.append(delimiterInput, delimiterHint)

  // ---- NULL 文本 ----
  const nullField = field('NULL 的文本表示', 'import-wizard-null')
  const nullInput = document.createElement('input')
  nullInput.id = 'import-wizard-null'
  nullInput.type = 'text'
  nullInput.value = ''
  nullInput.placeholder = '留空表示未加引号的空字段是 NULL'
  nullInput.setAttribute('aria-label', 'NULL 的文本表示')
  nullInput.style.cssText = inputStyle()
  const nullHint = document.createElement('div')
  nullHint.id = 'import-wizard-null-hint'
  nullHint.style.cssText = 'font-size:11px;color:var(--fg-dim);'
  nullHint.textContent =
    '未加引号且恰好等于该文本的字段按 NULL 写入；' +
    '加引号的空字段（""）仍然是空字符串，不会变成 NULL。'
  nullField.append(nullInput, nullHint)

  // ---- 表头 ----
  //
  // 用 div + 内层 label（而不是 field() 的 label 外壳）：
  // 复选框需要自己的 label 来关联说明文字，而 label 不能嵌套 label。
  const headerField = document.createElement('div')
  headerField.className = 'field'
  const headerLabel = document.createElement('label')
  headerLabel.style.cssText = 'display:flex;align-items:center;gap:6px;'
  const headerInput = document.createElement('input')
  headerInput.id = 'import-wizard-header'
  headerInput.type = 'checkbox'
  headerInput.checked = true
  headerLabel.append(headerInput, document.createTextNode('CSV 第一行是表头（列名）'))
  const headerHint = document.createElement('div')
  headerHint.id = 'import-wizard-header-hint'
  headerHint.style.cssText = 'font-size:11px;color:var(--fg-dim);'
  headerHint.textContent =
    '取消勾选则第一行当作数据行；此时列名由下面的目标列映射决定。'
  headerField.append(headerLabel, headerHint)

  // ---- 批大小 ----
  const batchField = field('每批写入行数', 'import-wizard-batch')
  const batchInput = document.createElement('input')
  batchInput.id = 'import-wizard-batch'
  batchInput.type = 'number'
  batchInput.min = String(MIN_TRANSFER_BATCH_SIZE)
  batchInput.max = String(MAX_TRANSFER_BATCH_SIZE)
  batchInput.value = String(DEFAULT_TRANSFER_BATCH_SIZE)
  batchInput.setAttribute('aria-label', '每批写入行数')
  batchInput.style.cssText = inputStyle()
  const batchHint = document.createElement('div')
  batchHint.id = 'import-wizard-batch-hint'
  batchHint.style.cssText = 'font-size:11px;color:var(--fg-dim);'
  batchHint.textContent =
    `影响主进程内存占用（只保留一批）。范围 ${MIN_TRANSFER_BATCH_SIZE} ~ ${MAX_TRANSFER_BATCH_SIZE}。`
  batchField.append(batchInput, batchHint)

  // ---- 目标列映射 ----
  //
  // 目标列以「每行一个列名」的文本区填写，而不是下拉列表：
  //   - CSV 的列数**在开始导入前是未知的**（界面读不到文件），
  //     而一个固定长度的下拉列表没法表达"CSV 有 7 列、目标表有 9 列"；
  //   - 文本区天然表达"第 1 行 → CSV 第 1 列"的顺序对应关系。
  //
  // 旁边列出目标表的所有列，点一下就填进文本区——省掉手抄列名的容易打错。
  const columnField = document.createElement('div')
  columnField.className = 'field'
  const columnLabel = document.createElement('span')
  columnLabel.textContent = '目标列（每行一个，顺序与 CSV 列顺序一致）'
  columnLabel.setAttribute('for', 'import-wizard-columns')
  const columnInput = document.createElement('textarea')
  columnInput.id = 'import-wizard-columns'
  columnInput.rows = Math.min(8, Math.max(3, targetColumns.length))
  columnInput.placeholder = 'id\nname\nemail'
  columnInput.setAttribute('aria-label', '目标列映射')
  columnInput.style.cssText =
    'font:inherit;width:100%;padding:6px 8px;border:1px solid var(--border);' +
    'border-radius:6px;background:var(--bg);color:var(--fg);resize:vertical;'
  const columnHint = document.createElement('div')
  columnHint.id = 'import-wizard-columns-hint'
  columnHint.style.cssText = 'font-size:11px;color:var(--fg-dim);'
  columnHint.textContent =
    '第 N 行对应 CSV 的第 N 列。目标列必须存在且互不重复；' +
    '预览会校验 CSV 列数；未映射的必填列会阻止开始导入。后端在开始导入时仍会完整校验文件与约束。'
  columnField.append(columnLabel, columnInput, columnHint)

  const columnList = document.createElement('div')
  columnList.id = 'import-wizard-column-list'
  columnList.style.cssText =
    'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;'
  if (targetColumns.length === 0) {
    const empty = document.createElement('div')
    empty.style.cssText = 'font-size:11px;color:var(--fg-dim);'
    empty.textContent = '（没能取到目标表的列信息，列名校验将交由后端完成）'
    columnList.appendChild(empty)
  } else {
    for (const column of targetColumns) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'import-column-chip'
      chip.dataset['column'] = column.name
      chip.textContent = column.name
      const readOnly = column.identity === 'always' || (column.generated !== null && column.generated !== undefined)
      chip.dataset['readOnly'] = String(readOnly)
      chip.disabled = readOnly
      chip.title = `${column.typeName}${column.nullable ? '' : ' · NOT NULL'}` +
        (readOnly ? ' · 数据库自动生成，不可导入' : '')
      if (readOnly) chip.textContent += '（自动生成）'
      chip.addEventListener('click', () => {
        appendTargetColumn(column.name)
        columnInput.focus()
      })
      columnList.appendChild(chip)
    }
  }
  if (targetColumns.some((column) => column.identity === undefined || column.generated === undefined)) {
    const unknownGeneration = document.createElement('div')
    unknownGeneration.id = 'import-wizard-generation-unknown'
    unknownGeneration.textContent = '部分列的自动生成信息未知，省略这些列不会在界面被误禁用；实际约束由后端最终校验。'
    unknownGeneration.style.cssText = 'font-size:11px;color:var(--fg-dim);'
    columnField.appendChild(unknownGeneration)
  }
  columnField.appendChild(columnList)

  // ---- 有界 CSV 预览 ----
  const previewBox = document.createElement('section')
  previewBox.id = 'import-wizard-preview'
  previewBox.setAttribute('aria-label', 'CSV 预览')
  previewBox.style.cssText = 'overflow:auto;max-height:240px;border:1px solid var(--border);padding:8px;border-radius:6px;'
  const previewSummary = document.createElement('div')
  previewSummary.id = 'import-wizard-preview-summary'
  previewSummary.setAttribute('role', 'status')
  previewSummary.textContent = '填写 CSV 路径后自动预览。'
  const previewTable = document.createElement('table')
  previewTable.id = 'import-wizard-preview-table'
  previewTable.style.cssText = 'border-collapse:collapse;width:100%;font-size:12px;'
  const previewErrors = document.createElement('div')
  previewErrors.id = 'import-wizard-preview-errors'
  previewErrors.style.color = 'var(--danger)'
  const previewRetry = document.createElement('button')
  previewRetry.type = 'button'
  previewRetry.id = 'import-wizard-preview-retry'
  previewRetry.textContent = '重新预览'
  previewBox.append(previewSummary, previewTable, previewErrors, previewRetry)

  // ---- 错误 ----
  const errorBox = document.createElement('div')
  errorBox.id = 'import-wizard-errors'
  errorBox.hidden = true
  errorBox.style.cssText =
    'padding:8px 10px;border:1px solid color-mix(in srgb, var(--danger) 55%, var(--border));' +
    'border-radius:6px;background:color-mix(in srgb, var(--danger) 9%, transparent);' +
    'color:var(--danger);font-size:12px;line-height:1.6;'

  // ---- 进度 ----
  const progressBox = document.createElement('div')
  progressBox.id = 'import-wizard-progress'
  progressBox.hidden = true
  progressBox.style.cssText =
    'padding:8px 10px;border:1px solid var(--border);border-radius:6px;' +
    'background:var(--bg-alt);font-size:12px;line-height:1.6;'
  const progressText = document.createElement('div')
  progressText.id = 'import-wizard-progress-text'
  progressText.style.cssText = 'font-weight:600;'
  const progressDetail = document.createElement('div')
  progressDetail.id = 'import-wizard-progress-detail'
  progressDetail.style.cssText = 'color:var(--fg-dim);word-break:break-all;'
  progressBox.append(progressText, progressDetail)

  body.append(
    sourceBox,
    pathField,
    delimiterField,
    nullField,
    headerField,
    batchField,
    columnField,
    previewBox,
    errorBox,
    progressBox
  )

  // ---- 底部按钮 ----
  const footer = document.createElement('div')
  footer.style.cssText =
    'display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;' +
    'border-top:1px solid var(--border);'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.id = 'import-wizard-cancel'
  cancelBtn.textContent = '取消'
  const startBtn = document.createElement('button')
  startBtn.type = 'button'
  startBtn.id = 'import-wizard-start'
  startBtn.textContent = '开始导入'
  startBtn.style.cssText =
    'background:var(--accent);color:var(--accent-fg);border-color:var(--accent);'
  footer.append(cancelBtn, startBtn)

  panel.append(head, body, footer)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  const controls: ImportWizardControls = {
    overlay,
    pathInput,
    browseBtn,
    delimiterInput,
    nullInput,
    headerInput,
    batchInput,
    columnInput,
    columnList,
    errorBox,
    progressBox,
    progressText,
    progressDetail,
    startBtn,
    cancelBtn,
    closeBtn
  }

  /** 把一列追加到目标列文本区末尾。 */
  const appendTargetColumn = (name: string): void => {
    const current = parseTargetColumns(columnInput.value.split('\n'))
    if (current.includes(name)) {
      // 重复列名是**硬错误**，追加前就拦住，别让用户填完再被表单校验驳回。
      showErrors([
        {
          field: 'targetColumns',
          message: `目标列「${name}」已经在列表里了，不能重复（同一个列不能接收两列 CSV 数据）`
        }
      ])
      return
    }
    columnInput.value = current.length === 0 ? name : `${current.join('\n')}\n${name}`
    refreshValidation()
  }

  let closed = false
  let preview: ImportPreview | null = null
  let previewPending = false
  let previewSequence = 0
  let previewTimer: ReturnType<typeof setTimeout> | null = null
  let formBusy = false
  let starting = false
  let finishing = false
  let taskId: string | null = null
  /**
   * 跟踪链路是否已断（进度/结果读不到，但后端任务可能还在跑）。
   *
   * 非 null 时：
   *   - **taskId 保留**——绝不静默丢弃一个可能还在写库的导入任务；
   *   - 关闭**继续被阻断**（还有可能在跑、还握着事务的任务）；
   *   - 「开始导入」变成「重试读取…」——把跟踪接回去；
   *   - 「取消」仍然是任务级的取消入口（明确收口）。
   */
  let chooserPending = false
  let trackingError: string | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  const startedAt = Date.now()

  const close = (): void => {
    if (closed) return
    closed = true
    previewSequence += 1
    if (previewTimer !== null) clearTimeout(previewTimer)
    if (pollTimer !== null) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
    // 释放单例登记：新向导打开时不该被这个已经关掉的向导挡住。
    if (activeWizard !== null && activeWizard.close === close) {
      activeWizard = null
    }
    options.onClosed?.()
  }

  const requestClose = (): void => {
    if (shouldBlockImportWizardClose(taskId, starting, finishing) || chooserPending) {
      /**
       * 每种「关不掉」的原因都要说清楚**用户下一步该点哪个按钮**。
       *
       * 之前这里的分支顺序让 `finishing ? '重试读取结果' : '重试读取进度'`
       * 永远走不到（`finishing` 先被上面那个分支接住了），
       * 于是「终态读取失败」这种状态只会说一句含糊的
       * 「正在读取导入结果」，用户不知道该点哪个按钮才能把向导收回来。
       */
      const message = chooserPending
        ? '正在打开文件选择器，完成前不能关闭向导'
        : starting
        ? '导入正在启动，完成前不能关闭向导'
        : trackingError !== null
          ? finishing
            ? '导入已结束但最终结果还没读到，确认结果前不能关闭向导；' +
              '请点「重试读取结果」再读一次，或点「取消导入」收口'
            : '导入任务仍在后台运行（跟踪已中断），请先点「重试读取进度」接回跟踪，' +
              '或点「取消导入」结束任务'
          : finishing
            ? '正在读取导入结果，完成前不能关闭向导'
            : '导入仍在进行，请先点「取消」结束任务'
      cb.onStatus(message, true)
      return
    }
    close()
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    requestClose()
  }
  document.addEventListener('keydown', onKey, true)
  controls.closeBtn.addEventListener('click', requestClose)

  const setBusy = (busy: boolean): void => {
    formBusy = busy
    controls.startBtn.disabled = busy || (taskId === null && !canStart())
    previewRetry.disabled = busy || previewPending
    controls.browseBtn.disabled = busy || chooserPending || starting || finishing || taskId !== null
    controls.pathInput.disabled = busy
    controls.delimiterInput.disabled = busy
    controls.nullInput.disabled = busy
    controls.headerInput.disabled = busy
    controls.batchInput.disabled = busy
    controls.columnInput.disabled = busy
    for (const chip of controls.columnList.querySelectorAll<HTMLButtonElement>('button')) {
      chip.disabled = busy || chip.dataset['readOnly'] === 'true'
    }
    if (busy) {
      controls.startBtn.textContent = '导入中…'
      controls.cancelBtn.textContent = '取消导入'
    } else {
      controls.startBtn.textContent = '开始导入'
      controls.cancelBtn.disabled = false
      controls.cancelBtn.textContent = '取消'
    }
  }

  const showErrors = (errors: readonly ImportFormError[]): void => {
    controls.errorBox.replaceChildren()
    for (const error of errors) {
      const line = document.createElement('div')
      line.textContent = `• ${error.message}`
      controls.errorBox.appendChild(line)
    }
    controls.errorBox.hidden = errors.length === 0
  }

  const readValues = (): ImportFormValues => ({
    sourcePath: controls.pathInput.value,
    delimiter: controls.delimiterInput.value,
    nullText: controls.nullInput.value,
    hasHeader: controls.headerInput.checked,
    batchSize: controls.batchInput.value,
    targetColumns: controls.columnInput.value.split('\n')
  })

  const validationErrors = (): readonly ImportFormError[] => {
    const validation = validateImportForm(targetNodeId, readValues(), targetColumns)
    const errors: ImportFormError[] = validation.ok ? [] : [...validation.errors]
    if (preview !== null) {
      errors.push(...validateImportPreview(preview, parseTargetColumns(readValues().targetColumns)))
    }
    return errors
  }

  const canStart = (): boolean => !chooserPending && !previewPending && preview !== null && validationErrors().length === 0

  const refreshValidation = (): void => {
    if (closed || formBusy || taskId !== null || starting || finishing || chooserPending) return
    showErrors(validationErrors())
    controls.startBtn.disabled = !canStart()
  }

  const renderPreview = (result: ImportPreview): void => {
    previewSummary.textContent = `共 ${result.totalRows.toLocaleString()} 行，显示 ${result.sampleRows.length} 行样例` +
      (result.truncated ? '（样例已截断，仅显示部分行）' : '')
    previewTable.replaceChildren()
    const head = previewTable.createTHead().insertRow()
    for (const column of result.columns) {
      const cell = document.createElement('th')
      cell.textContent = column.name
      cell.style.cssText = 'border:1px solid var(--border);padding:4px;text-align:left;'
      head.appendChild(cell)
    }
    const tbody = previewTable.createTBody()
    for (const sample of result.sampleRows) {
      const row = tbody.insertRow()
      row.dataset['row'] = String(sample.row)
      for (const value of sample.values) {
        const cell = row.insertCell()
        cell.textContent = value.kind === 'null' ? 'NULL' : value.text ?? ''
        cell.style.cssText = 'border:1px solid var(--border);padding:4px;max-width:180px;overflow-wrap:anywhere;white-space:pre-wrap;'
      }
    }
    previewErrors.replaceChildren()
    for (const error of result.errors) {
      const line = document.createElement('div')
      const location = formatImportLocation({
        row: error.row ?? undefined, line: error.line ?? undefined,
        column: error.column ?? undefined, columnName: error.columnName ?? undefined
      })
      line.textContent = `${location === null ? '' : location + '：'}${error.message}`
      previewErrors.appendChild(line)
    }
    if (result.errorCount > result.errors.length) {
      const more = document.createElement('div')
      more.textContent = `错误共 ${result.errorCount} 条，仅显示前 ${result.errors.length} 条。`
      previewErrors.appendChild(more)
    }
  }

  const schedulePreview = (): void => {
    const sequence = ++previewSequence
    if (previewTimer !== null) clearTimeout(previewTimer)
    preview = null
    previewPending = false
    previewTable.replaceChildren()
    previewErrors.replaceChildren()
    const values = readValues()
    if (!isAbsoluteImportPath(values.sourcePath.trim()) || !isValidDelimiter(values.delimiter)) {
      previewSummary.textContent = '请填写有效的绝对路径与分隔符后预览。'
      refreshValidation()
      return
    }
    previewPending = true
    previewSummary.textContent = '正在预览 CSV…'
    refreshValidation()
    previewTimer = setTimeout(() => {
      previewTimer = null
      void api.previewImport({
        sourcePath: values.sourcePath.trim(), delimiter: values.delimiter,
        nullText: values.nullText, hasHeader: values.hasHeader
      }).then((result) => {
        if (closed || sequence !== previewSequence) return
        preview = result
        renderPreview(result)
      }).catch((error: unknown) => {
        if (closed || sequence !== previewSequence) return
        previewSummary.textContent = `预览失败：${errorText(error)}`
      }).finally(() => {
        if (closed || sequence !== previewSequence) return
        previewPending = false
        refreshValidation()
      })
    }, 200)
  }

  const chooseFile = async (): Promise<void> => {
    if (closed || chooserPending || formBusy || starting || finishing || taskId !== null) return
    chooserPending = true
    controls.browseBtn.disabled = true
    controls.startBtn.disabled = true
    controls.pathInput.disabled = true
    try {
      const selected = await api.chooseImportFile()
      if (closed) return
      if (selected !== null) {
        controls.pathInput.value = selected
        schedulePreview()
      }
    } catch (error) {
      if (!closed) {
        showErrors([{ field: 'general', message: `选择 CSV 文件失败：${errorText(error)}` }])
        cb.onStatus(`选择 CSV 文件失败：${errorText(error)}`, true)
      }
    } finally {
      chooserPending = false
      if (!closed) {
        controls.browseBtn.disabled = formBusy || starting || finishing || taskId !== null
        controls.pathInput.disabled = formBusy
        controls.startBtn.disabled = formBusy || (taskId === null && !canStart())
      }
    }
  }

  for (const input of [pathInput, delimiterInput, nullInput]) input.addEventListener('input', schedulePreview)
  headerInput.addEventListener('change', schedulePreview)
  for (const input of [columnInput, batchInput]) input.addEventListener('input', refreshValidation)
  previewRetry.addEventListener('click', schedulePreview)
  controls.browseBtn.addEventListener('click', () => { void chooseFile() })

  const stopPolling = (): void => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  /**
   * 启动失败（后端根本没建任务）后回到可关闭、可重试的 idle 状态。
   *
   * 只有**确定没有任务**的时候才能这么做：清空 taskId 意味着
   * 「确实没有导入任务在跑」。任务一旦存在，就不能走这条路。
   */
  const resetTaskTracking = (): void => {
    stopPolling()
    starting = false
    finishing = false
    trackingError = null
    taskId = null
    controls.cancelBtn.disabled = false
    setBusy(false)
  }

  /**
   * 跟踪链路失败后的收口：**保留 taskId**，并给出两条明确出口。
   *
   * ============================== 为什么这么改 ==============================
   *
   * 早先的实现在这里调用 resetTaskTracking()，把 taskId 清空。
   * 那等于把一个**可能还在写库、还握着事务**的后端任务变成"看不见的任务"：
   * 用户看不到进度、点不到取消，甚至不知道有个任务在跑——
   * 而这个任务还占着该连接的独占写权限。
   *
   * 现在改成：
   *   - taskId **留着**（跟踪没丢，只是这一次的读失败了）；
   *   - 关闭**继续被阻断**（不能在任务还活着的时候静默关掉向导）；
   *   - 「开始导入」变成「重试读取…」，把跟踪接回去；
   *   - 「取消」仍然是任务级的取消入口（明确收口）。
   */
  const failTracking = (message: string): void => {
    trackingError = message
    showErrors([{ field: 'general', message }])
    controls.progressBox.hidden = false
    controls.progressText.textContent = finishing ? '读取导入结果失败' : '无法继续跟踪本次导入'
    controls.progressDetail.textContent = message
    cb.onStatus(message, true)
    // 表单恢复可用，但**任务跟踪保留**：这里绝不清空 taskId。
    setBusy(false)
    controls.startBtn.textContent = finishing ? '重试读取结果' : '重试读取进度'
    controls.cancelBtn.textContent = '取消导入'
    controls.cancelBtn.disabled = false
  }

  /** 轮询进度，直到任务进入终态。 */
  const poll = async (): Promise<void> => {
    pollTimer = null
    const id = taskId
    if (id === null || closed) return
    let progress: ImportProgress | null = null
    try {
      progress = await api.getImportProgress(id)
    } catch (e) {
      if (!closed && taskId === id) {
        /**
         * 读进度失败：**保留 taskId**，不静默丢掉跟踪。
         *
         * 后端那个导入任务可能还在跑（还握着事务），所以：
         *   - 向导保持打开、关闭继续被阻断；
         *   - 用户可以「重试读取进度」把跟踪接回去；
         *   - 「取消导入」仍然是任务级的取消入口。
         */
        failTracking(
          `无法继续跟踪本次导入：${errorText(e)}。任务仍在后台运行，` +
            '可点「重试读取进度」把跟踪接回去，或点「取消导入」结束任务。'
        )
      }
      return
    }
    if (closed || taskId !== id) return
    if (progress === null) {
      failTracking(
        '无法继续跟踪本次导入：后端已查不到这个任务。它可能已经结束，也可能还在运行；' +
          '请点「重试读取进度」确认，或点「取消导入」结束任务后再关闭向导。'
      )
      return
    }
    controls.progressBox.hidden = false
    controls.progressText.textContent = describeImportProgress(progress)
    const location = formatImportLocation(progress)
    const detailParts: string[] = []
    if (location !== null) detailParts.push(location)
    if (progress.message !== undefined) detailParts.push(progress.message)
    controls.progressDetail.textContent = detailParts.join(' · ')
    if (isTerminalImportStatus(progress.status)) {
      await finish(id)
      return
    }
    /**
     * 读到了**非终态**进度：跟踪链路是通的，上一轮的跟踪错误不再成立。
     *
     * 终态那一条**不在这里**释放：终态是这次跟踪生命周期的**最后一次**读取，
     * 由 finish() 把 taskId / finishing / trackingError 一起归零——
     * 跟踪状态的释放必须集中在一处，不能这里清一半、那里清一半。
     */
    trackingError = null
    showErrors([])
    pollTimer = setTimeout(() => void poll(), PROGRESS_POLL_INTERVAL_MS)
  }

  /** 任务结束：取终态结果并展示。 */
  const finish = async (id: string): Promise<void> => {
    if (closed || taskId !== id) return
    finishing = true
    controls.cancelBtn.disabled = true
    let result: ImportResult
    try {
      result = await api.waitImport(id)
    } catch (e) {
      if (!closed && taskId === id) {
        /**
         * 终态读取失败：**不丢 taskId**，也不解除关闭保护。
         *
         * 任务已经进入终态（进度里读到过），但结果详情读不到。
         * 这里保留 taskId 与 finishing 标志，向导继续不可关闭，
         * 用户可以点「重试读取结果」再读一次；
         * 如果结果始终读不出来，重试时会用进度接口**确认任务已终态**，
         * 确认之后才允许释放跟踪（那时已经没有需要取消的任务了）。
         */
        failTracking(
          `导入已结束，但读取最终结果失败：${errorText(e)}。` +
            '请点「重试读取结果」再读一次；确认结果前不能关闭向导。'
        )
      }
      return
    }
    if (closed || taskId !== id) return
    const summary = describeImportResult(result)
    const location = formatImportLocation(result)
    controls.progressBox.hidden = false
    controls.progressText.textContent = describeImportStatus(result.status)
    controls.progressDetail.textContent =
      location === null ? summary : `${location} · ${summary}`
    if (result.status === 'completed') {
      /**
       * 先刷新、再报结论。
       *
       * 顺序不能反：刷新会让网格往状态栏写「已返回 N 行」，
       * 那是**善后**信息；「导入完成」才是用户等的那句话。
       * 反过来写，用户最后看到的是刷新提示，导入结论被冲掉了。
       */
      try {
        await cb.onImported?.()
      } catch (e) {
        cb.onStatus(`导入已完成，但刷新表格失败：${errorText(e)}`, true)
      }
    }
    cb.onStatus(summary, result.status !== 'completed')
    // 任务与收尾都已完成，先释放确认结束的跟踪，再恢复 idle 控件。
    finishing = false
    taskId = null
    /**
     * 跟踪是好的（这次真的读到了终态），**必须清掉跟踪错误**。
     *
     * 为什么这是硬要求：`trackingError` 非 null 时「开始导入」会走
     * retryTracking，而 retryTracking 需要一个**还活着的 taskId**。
     * 如果 taskId 已经被清成 null 而 trackingError 还留着，
     * 这个按钮就变成「点了没反应」的死按钮——一次**成功**的收尾
     * 反而让向导再也导不了下一次。
     *
     * 清 taskId 的语义是「确实没有导入任务了」，那跟踪也就不存在问题了：
     * 两个状态必须同时归零，不能只清一半。
     */
    trackingError = null
    // 此时 taskId/finishing 已清空，浏览按钮与表单一起恢复。
    setBusy(false)
    refreshValidation()
  }

  /** 读一次进度；任何异常都吞掉（只用于兜底确认终态）。 */
  const readProgressSafely = async (id: string): Promise<ImportProgress | null> => {
    try {
      return await api.getImportProgress(id)
    } catch {
      return null
    }
  }

  /**
   * 跟踪中断后的重试：把跟踪接回去。
   *
   * - 运行中断 → 重新读一次进度，读到终态就走正常收尾；
   * - 收尾中断 → 重新读一次结果；仍然读不到，就用进度接口**确认任务已终态**，
   *   确认之后才允许释放跟踪（那时已经没有需要取消的任务了）。
   *
   * 重试**不会**新建任务：它用的始终是原来那个 taskId。
   */
  const retryTracking = async (): Promise<void> => {
    const id = taskId
    if (id === null || closed) return
    /**
     * 这里**不**提前清 trackingError：重试只是「再读一次」，
     * 能不能读通要由结果说话——poll() 读通了就清（跟踪恢复），
     * finish() 读到终态也清（跟踪结束），读不通则 failTracking 继续报警。
     *
     * 提前清会让状态名不副实：万一紧接着的读取又失败，状态就来回翻转，
     * 而且「开始导入」会在读通之前就被当成可点的重试入口。
     */
    setBusy(true)
    if (finishing) {
      await finish(id)
      if (trackingError === null || taskId !== id || closed) return
      /**
       * waitImport 还是读不到结果：退一步，用进度接口确认任务是否已经终态。
       *
       * 只有**确认任务已结束**才释放跟踪——否则就是在丢掉一个可能还活着的任务。
       */
      const progress = await readProgressSafely(id)
      if (progress === null || !isTerminalImportStatus(progress.status)) return
      if (closed || taskId !== id) return
      controls.progressBox.hidden = false
      controls.progressText.textContent = describeImportStatus(progress.status)
      controls.progressDetail.textContent =
        progress.message ?? '任务已结束，但最终结果详情读取失败'
      cb.onStatus(
        `导入已结束（结果详情读取失败）：${progress.message ?? '请核实目标表状态'}`,
        progress.status !== 'completed'
      )
      finishing = false
      trackingError = null
      taskId = null
      setBusy(false)
      refreshValidation()
      return
    }
    await poll()
  }

  const start = async (): Promise<void> => {
    showErrors([])
    /**
     * 新任务 = 新的跟踪生命周期：上一轮留下的跟踪错误在这一轮不再成立。
     *
     * 留着它会让「开始导入」按钮在**这一轮**里仍然被当成重试入口，
     * 而重试入口只对「原来那个任务」有意义。
     */
    trackingError = null
    const values: ImportFormValues = {
      sourcePath: controls.pathInput.value,
      delimiter: controls.delimiterInput.value,
      nullText: controls.nullInput.value,
      hasHeader: controls.headerInput.checked,
      batchSize: controls.batchInput.value,
      targetColumns: controls.columnInput.value.split('\n')
    }
    const validation = validateImportForm(targetNodeId, values, targetColumns)
    if (!canStart()) {
      refreshValidation()
      cb.onStatus('请等待 CSV 预览完成并修正解析或映射问题', true)
      return
    }
    if (!validation.ok) {
      showErrors(validation.errors)
      cb.onStatus('导入向导：请先修正表单中的问题', true)
      return
    }

    starting = true
    setBusy(true)
    controls.progressBox.hidden = false
    controls.progressText.textContent = '正在启动导入任务…'
    controls.progressDetail.textContent = ''

    try {
      const progress = await api.startImport(validation.request)
      taskId = progress.taskId
      starting = false
      controls.progressText.textContent = describeImportProgress(progress)
      void poll()
    } catch (e) {
      resetTaskTracking()
      const message = errorText(e)
      showErrors([{ field: 'general', message }])
      cb.onStatus(`导入失败：${message}`, true)
    }
  }

  controls.startBtn.addEventListener('click', () => {
    /**
     * 跟踪中断时，这个按钮是「重试读取…」而不是「开始导入」——
     * 它复用**原来那个** taskId，不会新建任务。
     *
     * 但只有**确实还有任务可重试**（taskId 不为 null）时才走重试：
     * 没有 taskId 时 retryTracking 会直接返回，按钮就变成「点了没反应」
     * 的死按钮。这种状态下宁可开一次新导入，也不能让用户点了没反应。
     */
    if (trackingError !== null && taskId !== null) {
      void retryTracking()
      return
    }
    void start()
  })

  controls.cancelBtn.addEventListener('click', () => {
    /**
     * 启动中 / 正常的收尾中：没有可取消的任务，只能阻止关闭。
     *
     * 跟踪中断后的收尾（trackingError !== null）不在此列——
     * 那时用户需要的正是**任务级取消**，所以继续往下走。
     */
    if (starting || (finishing && trackingError === null)) {
      requestClose()
      return
    }
    if (taskId === null) {
      requestClose()
      return
    }
    const id = taskId
    controls.cancelBtn.disabled = true
    void (async () => {
      try {
        const accepted = await api.cancelImport(id)
        if (!accepted) {
          /**
           * 取消没被接受：可能是任务刚结束，或已进入不可取消的提交阶段。
           * 如实告诉用户**为什么**，而不是假装取消了。
           */
          cb.onStatus(
            '取消未被接受：任务可能已结束，或已进入提交阶段。可点「重试读取进度」确认最终状态。',
            true
          )
        } else {
          cb.onStatus('已请求取消导入（将在当前批次结束后回滚）')
          /**
           * 取消之后**继续跟踪到终态**。
           *
           * 只有拿到终态，才能安全地释放 taskId 并允许关闭向导；
           * 中途放手就又变成了"看不见的任务"。
           *
           * 这里**不**提前清 trackingError：跟踪错误要由**实际结果**释放——
           * poll() 读通了进度（跟踪恢复）或 finish() 读到了终态（跟踪结束）。
           * 提前清会让「跟踪已中断」这个状态名不副实：
           * 万一紧接着的 poll 又失败，状态就来回翻转。
           */
          if (trackingError !== null) {
            setBusy(true)
            await poll()
          }
        }
      } catch (e) {
        cb.onStatus(`取消导入失败：${errorText(e)}`, true)
      } finally {
        controls.cancelBtn.disabled = false
      }
    })()
  })

  /**
   * 登记为"当前向导"（单例）。
   *
   * `hasRunningTask` 覆盖启动、运行、收尾三段：`startImport` 尚未返回时
   * 还没有 taskId，但任务请求已经发出；`waitImport` 尚未返回时任务体虽已
   * 进入终态，向导仍不能静默消失。
   *
   * 跟踪中断（trackingError）时 taskId **仍然保留**，所以这里同样算
   * 「还有任务在跑」：不能在旧向导还挂着任务时另开一个向导，
   * 否则那个任务就彻底没人管了。
   */
  activeWizard = {
    close,
    hasRunningTask: () => chooserPending || shouldBlockImportWizardClose(taskId, starting, finishing)
  }

  refreshValidation()
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
