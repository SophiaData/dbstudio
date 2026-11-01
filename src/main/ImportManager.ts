/**
 * 主进程侧的 CSV 导入任务管理器。
 *
 * 文件读取、CSV 解析和批次切分都留在主进程；renderer 只拿到任务进度与
 * 失败位置。真正写库通过注入的 `writeBatch` 回调走 driver-host RPC，
 * 主进程不 import 任何驱动实现。
 *
 * 原子性由三层共同保证：
 *   1. 请求开始前确认连接没有用户未提交事务；
 *   2. 第一批写入由 adapter 开启事务，后续批次复用；
 *   3. 普通失败或取消由本管理器调用 rollback；宿主终止或提交结果未知时
 *      不再发送事务控制请求，成功路径最后才 commit。
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import {
  createCsvRecordReader,
  csvCellFromRaw,
  parseCsv,
  validateCsvRecordColumns,
  type CsvCell,
  type CsvError,
  type CsvParseResult,
  type CsvRawRecord
} from '../core/csv'
import type { CellValue, TransactionState } from '../core/resultset'
import {
  isCommitOutcomeUnknown,
  isHostTerminatedTimeout
} from './DriverHostHandle'
import {
  normalizeTransferBatchSize,
  type ImportBatch,
  type ImportBatchRow,
  type ImportBatchResult,
  type ImportProgress,
  type ImportRequest,
  type ImportResult,
  type ImportStatus
} from '../core/transfer'

interface ImportFailureLocation {
  readonly row?: number
  readonly line?: number
  readonly column?: number
  readonly columnName?: string
}

class ImportTaskError extends Error {
  constructor(
    message: string,
    readonly location: ImportFailureLocation = {}
  ) {
    super(message)
    this.name = 'ImportTaskError'
  }
}

class ImportCancelledError extends Error {
  constructor() {
    super('导入已取消')
    this.name = 'ImportCancelledError'
  }
}

/**
 * 宿主已在事务边界超时后被终止。保留稳定 code/前缀，外层据此跳过 rollback。
 * 行定位仍放在 `location` 中，不能因为改写错误类型而丢失。
 */
class ImportHostTerminatedError extends ImportTaskError {
  readonly code = 'driver_host_timeout'
  readonly hostTerminated = true

  constructor(detail: string, batchIndex: number, location: ImportFailureLocation) {
    const normalizedDetail = detail
      .replace(/^HOST_TERMINATED_TIMEOUT:\s*/, '')
      .trim()
      .replace(/[。；;]+$/, '')
    const detailSuffix =
      normalizedDetail === '' ? '' : `；驱动错误：${normalizedDetail}`
    super(
      `HOST_TERMINATED_TIMEOUT: 第 ${batchIndex + 1} 批写入时驱动宿主已终止，` +
        `本次导入未提交；未提交事务由数据库在连接断开时自动回滚${detailSuffix}。` +
        '请重新连接后核对目标表。',
      location
    )
    this.name = 'ImportHostTerminatedError'
  }
}

const COMMIT_OUTCOME_UNKNOWN_MESSAGE = '提交结果未知，可能已提交，核实目标表后勿重复导入。'

interface ImportTask {
  readonly id: string
  readonly request: ImportRequest
  readonly connectionId?: string
  status: ImportStatus
  totalRows: number
  rowsImported: number
  batches: number
  message?: string
  row?: number
  line?: number
  column?: number
  columnName?: string
  cancelRequested: boolean
  finalizing: boolean
  done: Promise<ImportResult>
}

export interface ImportManagerOptions {
  /** 调用驱动 `importBatch` RPC。主进程只传表节点与结构化批次。 */
  readonly writeBatch: (targetNodeId: string, batch: ImportBatch) => Promise<ImportBatchResult>
  /** 提交导入事务。 */
  readonly commit: (targetNodeId: string) => Promise<TransactionState | void>
  /** 回滚导入事务；实现必须幂等。 */
  readonly rollback: (targetNodeId: string) => Promise<TransactionState | void>
  /** 写入前确认连接空闲；有用户未提交事务时拒绝开始。 */
  readonly transactionState?: (targetNodeId: string) => Promise<TransactionState>
  /** 用于连接断开时取消/等待该连接上的导入任务。 */
  readonly resolveConnectionId?: (targetNodeId: string) => string | undefined
  readonly onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

function isTerminal(status: ImportStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function validateRequest(request: ImportRequest): ImportRequest {
  if (typeof request !== 'object' || request === null) {
    throw new Error('导入请求必须是对象')
  }
  if (typeof request.targetNodeId !== 'string' || request.targetNodeId.trim() === '') {
    throw new Error('导入请求缺少 targetNodeId')
  }
  if (typeof request.sourcePath !== 'string' || request.sourcePath.trim() === '') {
    throw new Error('导入请求缺少 sourcePath')
  }
  if (!isAbsolute(request.sourcePath)) {
    throw new Error(`CSV 文件路径必须是绝对路径：${request.sourcePath}`)
  }
  if (typeof request.delimiter !== 'string' || request.delimiter.length !== 1) {
    throw new Error('CSV 分隔符必须是单个字符')
  }
  if (request.delimiter === '"' || request.delimiter === '\r' || request.delimiter === '\n') {
    throw new Error('CSV 分隔符不能是引号或换行符')
  }
  if (typeof request.nullText !== 'string') {
    throw new Error('CSV NULL 标记必须是字符串')
  }
  if (typeof request.hasHeader !== 'boolean') {
    throw new Error('CSV hasHeader 必须是布尔值')
  }
  if (!Array.isArray(request.targetColumns) || request.targetColumns.length === 0) {
    throw new Error('targetColumns 必须是非空数组')
  }
  const targetColumns = request.targetColumns.map((column, index) => {
    if (typeof column !== 'string' || column.trim() === '') {
      throw new Error(`targetColumns[${index}] 必须是非空字符串`)
    }
    return column
  })
  if (new Set(targetColumns).size !== targetColumns.length) {
    throw new Error('targetColumns 不能包含重复列名')
  }
  return {
    ...request,
    targetColumns,
    batchSize: normalizeTransferBatchSize(request.batchSize)
  }
}

function csvCellToValue(cell: CsvCell): CellValue {
  return cell.kind === 'null'
    ? { kind: 'null' }
    : { kind: 'text', text: cell.text ?? '' }
}

function isBlankRecord(record: CsvRawRecord): boolean {
  const first = record.fields[0]
  return (
    record.error === null &&
    record.fields.length === 1 &&
    first !== undefined &&
    !first.quoted &&
    first.value === ''
  )
}

function locationOfCsvError(error: CsvError): ImportFailureLocation {
  return {
    ...(error.row === null ? {} : { row: error.row }),
    ...(error.line === null ? {} : { line: error.line }),
    ...(error.column === null ? {} : { column: error.column }),
    ...(error.columnName === null ? {} : { columnName: error.columnName })
  }
}

function messageOfError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/** 从驱动错误文本中恢复批次内失败位置；驱动契约要求消息里带这些上下文。 */
function locationOfBatchError(error: unknown, batch: ImportBatch): ImportFailureLocation {
  const message = messageOfError(error)
  const rowMatch = /CSV 数据第\s+(\d+)\s+行/.exec(message)
  const batchRowMatch = /第\s+\d+\s+批第\s+(\d+)\s+行/.exec(message)
  const columnMatch = /列「([^」]+)」/.exec(message)
  const rowNumber =
    rowMatch === null ? undefined : Number.parseInt(rowMatch[1] as string, 10)
  const batchRowIndex =
    batchRowMatch === null ? undefined : Number.parseInt(batchRowMatch[1] as string, 10) - 1
  const matchingRow =
    rowNumber === undefined
      ? batchRowIndex === undefined
        ? undefined
        : batch.rows[batchRowIndex]
      : batch.rows.find((row) => row.rowNumber === rowNumber)
  const columnName = columnMatch?.[1]
  const column =
    columnName === undefined
      ? undefined
      : batch.columns.findIndex((candidate) => candidate.toLowerCase() === columnName.toLowerCase()) + 1
  return {
    ...(matchingRow === undefined ? {} : { row: matchingRow.rowNumber }),
    ...(matchingRow?.lineNumber === undefined ? {} : { line: matchingRow.lineNumber }),
    ...(column === undefined || column <= 0 ? {} : { column }),
    ...(columnName === undefined ? {} : { columnName })
  }
}

export class ImportManager {
  readonly #tasks = new Map<string, ImportTask>()
  readonly #writeBatch: ImportManagerOptions['writeBatch']
  readonly #commit: ImportManagerOptions['commit']
  readonly #rollback: ImportManagerOptions['rollback']
  readonly #transactionState: ImportManagerOptions['transactionState']
  readonly #resolveConnectionId: NonNullable<ImportManagerOptions['resolveConnectionId']>
  readonly #onLog: NonNullable<ImportManagerOptions['onLog']>
  #seq = 0
  #disposed = false

  constructor(options: ImportManagerOptions) {
    this.#writeBatch = options.writeBatch
    this.#commit = options.commit
    this.#rollback = options.rollback
    this.#transactionState = options.transactionState
    this.#resolveConnectionId = options.resolveConnectionId ?? (() => undefined)
    this.#onLog = options.onLog ?? (() => {})
  }

  start(rawRequest: ImportRequest): ImportProgress {
    if (this.#disposed) throw new Error('导入管理器已关闭，无法启动新任务')
    const request = validateRequest(rawRequest)
    const connectionId = this.#resolveConnectionId(request.targetNodeId)
    for (const task of this.#tasks.values()) {
      if (isTerminal(task.status)) continue
      if (
        task.request.targetNodeId === request.targetNodeId ||
        (connectionId !== undefined && task.connectionId === connectionId)
      ) {
        throw new Error(
          `连接 ${connectionId ?? request.targetNodeId} 上已有导入任务 ${task.id}，` +
            '请等待它完成或先取消，再开始新的导入。'
        )
      }
    }

    const id = `i${++this.#seq}`
    const task: ImportTask = {
      id,
      request,
      ...(connectionId === undefined ? {} : { connectionId }),
      status: 'queued',
      totalRows: 0,
      rowsImported: 0,
      batches: 0,
      cancelRequested: false,
      finalizing: false,
      done: Promise.resolve({
        taskId: id,
        status: 'failed',
        totalRows: 0,
        rowsImported: 0,
        batches: 0,
        sourcePath: request.sourcePath,
        targetNodeId: request.targetNodeId
      })
    }
    this.#tasks.set(id, task)
    const done = this.#run(task)
    task.done = done
    task.status = 'running'
    return this.#progressOf(task)
  }

  get(taskId: string): ImportProgress | undefined {
    const task = this.#tasks.get(taskId)
    return task === undefined ? undefined : this.#progressOf(task)
  }

  cancel(taskId: string): boolean {
    const task = this.#tasks.get(taskId)
    if (
      task === undefined ||
      isTerminal(task.status) ||
      task.status === 'committing' ||
      task.finalizing
    ) {
      return false
    }
    task.cancelRequested = true
    this.#onLog('info', `[import:${taskId}] 已收到取消请求，将在当前批次结束后回滚`)
    return true
  }

  cancelByConnection(connectionId: string): string[] {
    const cancelled: string[] = []
    for (const task of this.#tasks.values()) {
      if (task.connectionId !== connectionId || isTerminal(task.status)) continue
      if (this.cancel(task.id)) cancelled.push(task.id)
    }
    return cancelled
  }

  /**
   * 返回该连接上仍由导入管理器持有的任务 id。
   *
   * 连接级 commit/rollback 用它判断当前事务是否可能属于导入。包括
   * `finalizing` 阶段在内的非终态任务都必须算活动，直到 ImportManager
   * 自己的 commit/rollback 完成。
   */
  activeTaskByConnection(connectionId: string): string | undefined {
    for (const task of this.#tasks.values()) {
      if (task.connectionId === connectionId && !isTerminal(task.status)) return task.id
    }
    return undefined
  }

  async wait(taskId: string): Promise<ImportResult> {
    const task = this.#tasks.get(taskId)
    if (task === undefined) throw new Error(`导入任务不存在: ${taskId}`)
    return task.done
  }

  async waitByConnection(connectionId: string): Promise<void> {
    const owned = [...this.#tasks.values()].filter((task) => task.connectionId === connectionId)
    await Promise.all(owned.map((task) => task.done.catch(() => undefined)))
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    const all = [...this.#tasks.values()]
    for (const task of all) {
      if (!isTerminal(task.status)) this.cancel(task.id)
    }
    await Promise.all(all.map((task) => task.done.catch(() => undefined)))
  }

  #progressOf(task: ImportTask): ImportProgress {
    return {
      taskId: task.id,
      status: task.status,
      totalRows: task.totalRows,
      rowsImported: task.rowsImported,
      batches: task.batches,
      sourcePath: task.request.sourcePath,
      targetNodeId: task.request.targetNodeId,
      ...(task.message === undefined ? {} : { message: task.message }),
      ...(task.row === undefined ? {} : { row: task.row }),
      ...(task.line === undefined ? {} : { line: task.line }),
      ...(task.column === undefined ? {} : { column: task.column }),
      ...(task.columnName === undefined ? {} : { columnName: task.columnName })
    }
  }

  #resultOf(task: ImportTask): ImportResult {
    const status: ImportResult['status'] =
      task.status === 'completed' || task.status === 'cancelled'
        ? task.status
        : 'failed'
    return {
      taskId: task.id,
      status,
      totalRows: task.totalRows,
      rowsImported: task.rowsImported,
      batches: task.batches,
      sourcePath: task.request.sourcePath,
      targetNodeId: task.request.targetNodeId,
      ...(task.message === undefined ? {} : { message: task.message }),
      ...(task.row === undefined ? {} : { row: task.row }),
      ...(task.line === undefined ? {} : { line: task.line }),
      ...(task.column === undefined ? {} : { column: task.column }),
      ...(task.columnName === undefined ? {} : { columnName: task.columnName })
    }
  }

  #cancelled(task: ImportTask): boolean {
    return task.cancelRequested || this.#disposed
  }

  #applyFailure(task: ImportTask, failure: ImportTaskError): void {
    task.message = failure.message
    if (failure.location.row !== undefined) task.row = failure.location.row
    if (failure.location.line !== undefined) task.line = failure.location.line
    if (failure.location.column !== undefined) task.column = failure.location.column
    if (failure.location.columnName !== undefined) task.columnName = failure.location.columnName
  }

  async #run(task: ImportTask): Promise<ImportResult> {
    let writeStarted = false
    let committed = false
    try {
      const bytes = await readFile(task.request.sourcePath)
      if (this.#cancelled(task)) throw new ImportCancelledError()

      const parseOptions = {
        delimiter: task.request.delimiter,
        nullText: task.request.nullText,
        hasHeader: task.request.hasHeader
      }
      // 按任务要求先跑完整解析校验；该结果有界，只保留样例与错误。
      const parsed = parseCsv(bytes, parseOptions)
      task.totalRows = parsed.totalRows
      if (!parsed.ok) {
        const first = parsed.errors[0]
        const extra =
          parsed.errorCount > 1 ? `（另有 ${parsed.errorCount - 1} 个解析错误）` : ''
        throw new ImportTaskError(
          `CSV 解析失败：${first?.message ?? '未知解析错误'}${extra}`,
          first === undefined ? {} : locationOfCsvError(first)
        )
      }
      this.#validateColumnMapping(parsed, task.request)
      if (parsed.totalRows === 0) {
        throw new ImportTaskError('CSV 没有数据行，未执行导入。')
      }
      if (this.#cancelled(task)) throw new ImportCancelledError()
      if (this.#transactionState !== undefined) {
        const state = await this.#transactionState(task.request.targetNodeId)
        if (state.active) {
          throw new ImportTaskError(
            '目标连接上已有未提交事务。请先提交或回滚，再开始导入，以免导入把无关改动一起提交。'
          )
        }
      }

      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const decoded = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
      const reader = createCsvRecordReader(parseOptions)
      const expectedColumnCount = parsed.columns.length
      let headerPending = task.request.hasHeader
      let expectedColumnCountForBlankLines = 0
      let rowNumber = 0
      let batchIndex = 0
      let pendingRows: ImportBatchRow[] = []

      const flushBatch = async (): Promise<void> => {
        if (pendingRows.length === 0) return
        if (this.#cancelled(task)) throw new ImportCancelledError()
        const batch: ImportBatch = {
          batchIndex,
          columns: task.request.targetColumns,
          rows: pendingRows
        }
        writeStarted = true
        try {
          const result = await this.#writeBatch(task.request.targetNodeId, batch)
          if (result.inTransaction !== true) {
            throw new ImportTaskError(
              `第 ${batchIndex + 1} 批写入后驱动未保持导入事务，已中止导入。`
            )
          }
          if (result.rowsImported !== batch.rows.length) {
            throw new ImportTaskError(
              `第 ${batchIndex + 1} 批有 ${batch.rows.length} 行，` +
                `但驱动报告写入了 ${result.rowsImported} 行，已中止导入。`
            )
          }
          task.rowsImported += result.rowsImported
          task.batches += 1
        } catch (error) {
          const message = messageOfError(error)
          const location = locationOfBatchError(error, batch)
          if (isHostTerminatedTimeout(error)) {
            throw new ImportHostTerminatedError(message, batchIndex, location)
          }
          throw new ImportTaskError(message, location)
        }
        batchIndex += 1
        pendingRows = []
      }

      const consume = async (records: readonly CsvRawRecord[]): Promise<void> => {
        for (const record of records) {
          if (isBlankRecord(record) && expectedColumnCountForBlankLines !== 1) continue
          if (headerPending) {
            headerPending = false
            expectedColumnCountForBlankLines = expectedColumnCount
            continue
          }
          if (expectedColumnCountForBlankLines === 0) {
            expectedColumnCountForBlankLines = expectedColumnCount
          }
          rowNumber += 1
          const validation = validateCsvRecordColumns(
            record.fields,
            parsed.columns,
            rowNumber,
            record.line
          )
          const firstError = validation[0]
          if (firstError !== undefined) {
            throw new ImportTaskError(firstError.message, locationOfCsvError(firstError))
          }
          const values = record.fields.map((field) =>
            csvCellToValue(csvCellFromRaw(field, task.request.nullText))
          )
          pendingRows.push({
            rowNumber,
            lineNumber: record.line,
            values
          })
          if (pendingRows.length >= task.request.batchSize) {
            await flushBatch()
          }
          if (this.#cancelled(task)) throw new ImportCancelledError()
        }
      }

      const chunkSize = 64 * 1024
      for (let offset = 0; offset < decoded.length; offset += chunkSize) {
        if (this.#cancelled(task)) throw new ImportCancelledError()
        await consume(reader.push(decoded.slice(offset, offset + chunkSize)))
      }
      await consume(reader.flush())
      if (rowNumber !== parsed.totalRows) {
        throw new ImportTaskError(
          `CSV 二次读取的数据行数不一致（解析 ${parsed.totalRows} 行，读取 ${rowNumber} 行），` +
            '为避免漏导已停止。'
        )
      }
      await flushBatch()
      if (this.#cancelled(task)) throw new ImportCancelledError()

      task.status = 'committing'
      const commitState = await this.#commit(task.request.targetNodeId)
      if (commitState !== undefined && commitState.active) {
        throw new ImportTaskError('提交后事务仍处于活动状态，无法确认导入已提交。')
      }
      committed = true
      task.status = 'completed'
      return this.#resultOf(task)
    } catch (error) {
      task.finalizing = true
      const hostTerminated = isHostTerminatedTimeout(error)
      const commitOutcomeUnknown = isCommitOutcomeUnknown(error)
      const cancelled =
        !hostTerminated &&
        !commitOutcomeUnknown &&
        (error instanceof ImportCancelledError || this.#cancelled(task))
      let rollbackMessage = ''
      if (writeStarted && !committed && !hostTerminated && !commitOutcomeUnknown) {
        try {
          const rollbackState = await this.#rollback(task.request.targetNodeId)
          if (rollbackState !== undefined && rollbackState.active) {
            throw new Error('回滚后事务仍处于活动状态')
          }
        } catch (rollbackError) {
          rollbackMessage =
            `；回滚也失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}。` +
            '数据库提示事务可能仍未结束，请断开连接以强制回滚。'
          this.#onLog('error', `[import:${task.id}] ${rollbackMessage}`)
        }
      }
      if (!committed && !commitOutcomeUnknown) {
        // 普通失败/取消的写入已在 rollback 后丢弃，不能作为成功行数返回。
        // commit 结果未知时保留已写入行数，因为事务可能已经提交。
        task.rowsImported = 0
      }

      if (commitOutcomeUnknown) {
        task.status = 'failed'
        const detail = messageOfError(error)
          .replace(/^COMMIT_OUTCOME_UNKNOWN:\s*/, '')
          .trim()
        task.message =
          `COMMIT_OUTCOME_UNKNOWN: ${COMMIT_OUTCOME_UNKNOWN_MESSAGE}` +
          (detail === '' ? '' : `驱动错误：${detail}`)
      } else if (hostTerminated) {
        task.status = 'failed'
        const failure =
          error instanceof ImportTaskError
            ? error
            : new ImportTaskError(messageOfError(error))
        this.#applyFailure(task, failure)
      } else if (cancelled) {
        task.status = 'cancelled'
        task.message =
          `导入已取消${writeStarted && rollbackMessage === '' ? '，已回滚本任务写入' : ''}` +
          rollbackMessage
      } else {
        task.status = 'failed'
        const failure =
          error instanceof ImportTaskError
            ? error
            : new ImportTaskError(messageOfError(error))
        this.#applyFailure(task, failure)
        task.message = `${failure.message}${rollbackMessage}`
      }
      this.#onLog(
        task.status === 'failed' ? 'warn' : 'info',
        `[import:${task.id}] ${task.status}: ${task.message ?? ''}`
      )
      return this.#resultOf(task)
    }
  }

  #validateColumnMapping(parsed: CsvParseResult, request: ImportRequest): void {
    if (request.targetColumns.length !== parsed.columns.length) {
      throw new ImportTaskError(
        `CSV 有 ${parsed.columns.length} 列，但提供了 ${request.targetColumns.length} 个目标列映射。`,
        parsed.columns[request.targetColumns.length] === undefined
          ? {}
          : {
              column: request.targetColumns.length + 1,
              columnName: parsed.columns[request.targetColumns.length]?.name
            }
      )
    }
  }
}
