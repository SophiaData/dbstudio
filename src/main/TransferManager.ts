/**
 * 主进程侧的流式导出任务管理器。
 *
 * ===== 职责边界（写在这里，免得以后被人改歪）=====
 *
 * 这个类**只做四件事**：
 *   1. 维护任务状态机（queued → running → committing → completed/failed/cancelled）
 *   2. 持有目标文件的句柄，**边读边写**，内存里最多一个批次
 *   3. 保证「同目录临时文件 → 原子 rename」的提交语义，失败/取消时删临时文件
 *   4. 提供取消与进度查询
 *
 * 它**不做**数据库的事：数据从哪来完全由注入的 `openSource` 决定
 * （依赖注入的理由见 `core/transfer.ts` 的 `OpenTransferSource` 注释）。
 *
 * ===== 为什么文件句柄只在主进程 =====
 *
 * 渲染进程不能持有文件句柄（contextBridge 只能传结构化克隆的值），
 * 而且让渲染进程写文件会绕过"同目录临时文件 + 原子 rename"这条提交语义。
 * 文件句柄只在这里，因此也只有这里能保证「失败时目标文件完好无损」。
 *
 * ===== 取消为什么是「任务级」而不是「连接级」=====
 *
 * 现有 `cancelQuery` 取消的是**整条连接**上正在跑的查询。
 * 用它来取消导出会误杀用户在同一连接上跑的其它查询——
 * 这是"取消"语义最容易被搞混的地方，所以导出任务有自己的取消标记，
 * 只在**批次边界**检查，不碰宿主的任何查询。
 *
 * 代价要说清楚：本轮的分页读取是一次真实的 SQL 查询，取消只能在批次之间生效，
 * 正在执行的那一条查询会跑完（然后不再取下一批）。
 *
 * ===== 取消与提交的竞态（必须处理，否则会"骗"用户）=====
 *
 * 提交（rename）是**不可分割**的一步：一旦开始，要么文件被发布，要么没被发布。
 * 所以：
 *   - rename **之前**的每个 await 之后都重新检查取消标记——取消随时生效；
 *   - rename **开始之后**不再接受取消（cancel 返回 false），
 *     否则会出现"UI 显示已取消，但文件其实已经写好了"的矛盾状态。
 *     这段时间任务状态是 `committing`，进度里也能看到。
 */

import { randomUUID } from 'node:crypto'
import { open as openFile, rename as renameFile, unlink as unlinkFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type { CellValue } from '../core/resultset'
import {
  buildInsertTarget,
  cellToJsonValue,
  cellToSqlLiteral,
  cellToTransferText,
  csvEscapeField,
  findTruncatedCell,
  normalizeTransferBatchSize,
  quoteTransferIdentifier,
  TRANSFER_FORMATS,
  type OpenTransferSource,
  type TransferFormat,
  type TransferOptions,
  type TransferProgress,
  type TransferRequest,
  type TransferResult,
  type TransferSource,
  type TransferSourceHandle,
  type TransferStatus
} from '../core/transfer'

/** 内部任务状态。 */
interface TransferTask {
  readonly id: string
  readonly source: TransferSource
  readonly format: TransferFormat
  readonly destinationPath: string
  readonly batchSize: number
  readonly options: ResolvedOptions
  /** 归属连接（用于「断开连接时取消本连接上的任务」）。未知时为 undefined。 */
  readonly connectionId?: string
  status: TransferStatus
  rowsRead: number
  bytesWritten: number
  batches: number
  message?: string
  committedPath?: string
  cancelRequested: boolean
  tempPath?: string
  done: Promise<TransferResult>
}

interface ResolvedOptions {
  readonly includeHeader: boolean
  readonly nullText: string
  readonly newline: '\r\n' | '\n'
  readonly jsonIndent: number
  readonly batchSize: number
}

export interface TransferManagerOptions {
  /**
   * 打开导出来源。
   *
   * 注入而不是内部实现，是为了让"文件失败 / 取消 / 清理"这些行为
   * 可以在**不启动数据库宿主**的情况下被独立验收。
   */
  readonly openSource: OpenTransferSource
  /**
   * 从来源推断归属连接 id（用于连接断开时取消其任务）。
   *
   * 由上层（ConnectionManager）注入，主进程里已有节点 id 的解析规则，
   * 传输层不需要也不应该知道节点 id 的编码。
   */
  readonly resolveConnectionId?: (source: TransferSource) => string | undefined
  /**
   * 目标路径的安全检查钩子。抛错即拒绝启动任务。
   *
   * 注入而不是写死，是因为"什么是危险目标"依赖上层掌握的知识
   * （哪些路径是正在使用的数据库文件），传输层自己不知道。
   * 注入后**两条入口都受保护**：直接用 TransferManager 的调用方，
   * 与经 ConnectionManager 的生产路径。
   */
  readonly assertDestinationAllowed?: (destinationPath: string) => void
  readonly onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export class TransferManager {
  readonly #tasks = new Map<string, TransferTask>()
  readonly #openSource: OpenTransferSource
  readonly #resolveConnectionId: (source: TransferSource) => string | undefined
  readonly #assertDestinationAllowed: (destinationPath: string) => void
  readonly #onLog: (level: 'info' | 'warn' | 'error', message: string) => void
  #seq = 0
  #disposed = false

  constructor(options: TransferManagerOptions) {
    this.#openSource = options.openSource
    this.#resolveConnectionId = options.resolveConnectionId ?? (() => undefined)
    this.#assertDestinationAllowed = options.assertDestinationAllowed ?? (() => {})
    this.#onLog = options.onLog ?? (() => {})
  }

  #log(level: 'info' | 'warn' | 'error', message: string): void {
    this.#onLog(level, message)
  }

  /**
   * 启动一个导出任务。**同步返回 running 状态的进度**，任务在后台跑。
   *
   * 参数错误**同步抛出**（不进入队列）：调用方能立刻拿到"格式不对 / 路径为空"
   * 这种错误，而不是先拿到一个 taskId 再去轮询一个注定失败的任务。
   */
  start(request: TransferRequest): TransferProgress {
    if (this.#disposed) throw new Error('传输管理器已关闭，无法启动新任务')
    const format = validateFormat(request.format)
    const destinationPath = validateDestination(request.destinationPath)
    // 目标路径的危险性检查在任务入队**之前**：不安全的目标根本不该开始写文件。
    this.#assertDestinationAllowed(destinationPath)
    const options = validateOptions(request.options, format)
    const source = validateSource(request.source)
    const batchSize = normalizeTransferBatchSize(options.batchSize)
    const connectionId = this.#resolveConnectionId(source)

    const id = `t${++this.#seq}`
    const task: TransferTask = {
      id,
      source,
      format,
      destinationPath,
      batchSize,
      options: { ...options, batchSize },
      status: 'queued',
      rowsRead: 0,
      bytesWritten: 0,
      batches: 0,
      cancelRequested: false,
      done: Promise.resolve<TransferResult>({
        taskId: id,
        status: 'failed',
        rowsRead: 0,
        bytesWritten: 0,
        destinationPath
      }),
      ...(connectionId === undefined ? {} : { connectionId })
    }
    this.#tasks.set(id, task)

    // 内部捕获所有异常：任何失败都变成任务的 failed 终态，
    // 绝不让内部失败变成 unhandledRejection（那会污染整个主进程）。
    const done = this.#run(task)
    ;(task as { done: Promise<TransferResult> }).done = done
    task.status = 'running'
    return this.#progressOf(task)
  }

  /** 取任务进度。未知 id 返回 undefined（调用方要能区分"没有"与"失败"）。 */
  get(taskId: string): TransferProgress | undefined {
    const task = this.#tasks.get(taskId)
    return task === undefined ? undefined : this.#progressOf(task)
  }

  /** 列出所有任务（含终态）。UI 的任务列表用它。 */
  list(): TransferProgress[] {
    return [...this.#tasks.values()].map((task) => this.#progressOf(task))
  }

  /**
   * 请求取消一个任务。
   *
   * 返回 true 表示"已记下取消请求"（任务会在下一个批次边界停下）；
   * false 表示任务不存在、已经是终态，或已进入不可取消的提交阶段。
   *
   * **不会**去取消同一连接上的其它查询——取消是任务级的。
   */
  cancel(taskId: string): boolean {
    const task = this.#tasks.get(taskId)
    if (task === undefined) return false
    if (isTerminal(task.status)) return false
    if (task.status === 'committing') {
      // 原子发布已经开始：此时接受取消会产生"显示已取消但文件已写好"的矛盾。
      this.#log('warn', `[transfer:${taskId}] 任务已进入提交阶段，不再接受取消`)
      return false
    }
    task.cancelRequested = true
    this.#log('info', `[transfer:${taskId}] 已收到取消请求（将在当前批次结束后生效）`)
    return true
  }

  /**
   * 取消某个连接上的所有未结束任务。
   *
   * 用于「断开连接」：先标记取消（不等待），让任务尽快收尾；
   * 调用方随后关闭宿主，在途的 read 会被宿主退出唤醒。
   *
   * 返回被标记取消的任务 id 列表。
   */
  cancelByConnection(connectionId: string): string[] {
    const cancelled: string[] = []
    for (const task of this.#tasks.values()) {
      if (task.connectionId !== connectionId) continue
      if (isTerminal(task.status)) continue
      if (this.cancel(task.id)) cancelled.push(task.id)
    }
    return cancelled
  }

  /**
   * 等待任务结束，返回终态结果。
   *
   * 未知 id 直接 reject（而不是永远挂着）——调用方传错 id 时要立刻知道。
   */
  async wait(taskId: string): Promise<TransferResult> {
    const task = this.#tasks.get(taskId)
    if (task === undefined) throw new Error(`传输任务不存在: ${taskId}`)
    return task.done
  }

  /**
   * 关闭管理器：取消所有未结束的任务并等待它们收尾。
   *
   * 等待是必须的：否则临时文件可能在本进程退出后才被删，
   * 留下垃圾文件（而且目标文件可能处于"已写了一半"的中间态）。
   */
  /**
   * 关闭管理器：取消所有未结束的任务，并**等待所有任务真正收尾**。
   *
   * 等"所有"而不是"未结束的"：任务状态在 `finally`（关句柄、删临时文件）
   * **之前**就被置成终态，只等 `!isTerminal` 的任务会漏掉
   * "状态已终结但临时文件还没删"的那批，应用可能在清理前就退出。
   * 已结束任务的 `done` 已经 resolve，等它几乎零成本。
   */
  async dispose(): Promise<void> {
    this.#disposed = true
    const all = [...this.#tasks.values()]
    for (const task of all) {
      if (!isTerminal(task.status)) this.cancel(task.id)
    }
    await Promise.all(all.map((task) => task.done.catch(() => undefined)))
  }

  /**
   * 等待某个连接上的所有任务真正收尾（含临时文件清理）。
   *
   * 「断开连接」时用：先标记取消让任务尽快停，再关宿主唤醒在途的读，
   * 最后等任务收尾——这样不会留下半截临时文件。
   */
  async waitByConnection(connectionId: string): Promise<void> {
    const owned = [...this.#tasks.values()].filter((task) => task.connectionId === connectionId)
    await Promise.all(owned.map((task) => task.done.catch(() => undefined)))
  }

  // ---- 内部实现 ----

  #progressOf(task: TransferTask): TransferProgress {
    const base: TransferProgress = {
      taskId: task.id,
      status: task.status,
      rowsRead: task.rowsRead,
      bytesWritten: task.bytesWritten,
      batches: task.batches,
      destinationPath: task.destinationPath,
      // 分页读取不是快照：如实标注，绝不把导出结果说成"某时刻的数据"。
      consistency: 'live-paged'
    }
    if (task.message !== undefined) return { ...base, message: task.message }
    if (task.committedPath !== undefined) return { ...base, committedPath: task.committedPath }
    return base
  }

  async #run(task: TransferTask): Promise<TransferResult> {
    let handle: TransferSourceHandle | null = null
    let file: FileHandle | null = null
    let committed = false
    try {
      handle = await this.#openSource(task.source, task.batchSize)
      // 打开来源后立刻检查一次：等待打开的这段时间里可能已经被取消。
      if (this.#cancelled(task)) return this.#finishCancelled(task)
      this.#validateHandle(task, handle)

      /**
       * 临时文件与目标**同目录**：跨目录 rename 可能跨文件系统（不是原子操作），
       * 同目录才能保证 rename 是原子的。
       *
       * 文件名带 randomUUID 而不是任务号：两个 TransferManager 实例
       * （或旧任务残留）都用 `t1` 命名会撞名，而 'wx' 遇到已存在文件会失败，
       * 让一个无关的旧残留挡住新任务。
       */
      const tempPath = join(
        dirname(task.destinationPath),
        `.${basename(task.destinationPath)}.dbstudio-${randomUUID()}.tmp`
      )
      // 'wx' = 独占创建：临时文件若已存在就报错，绝不覆盖别人的文件。
      file = await openFile(tempPath, 'wx')
      /**
       * 临时路径**只在 open 成功之后**登记。
       * 否则 open 失败（如同名文件已存在）时，finally 的清理会删掉**别人的文件**。
       */
      task.tempPath = tempPath
      if (this.#cancelled(task)) return this.#finishCancelled(task)

      const writer = createWriter(task, handle)

      /**
       * 头部先写、每批写一批、尾部最后写。
       *
       * ===== 为什么不能"攒完再写" =====
       *
       * 攒完再写（把全部行拼成一个大字符串）会让内存占用与**总行数**成正比，
       * 那就等于把"流式"退化成"全量载入主进程"——
       * 正是这个任务要防的核心问题（renderer 不积全量，主进程同样不该积）。
       *
       * 这里的背压是天然的：**写完这一批才去读下一批**，
       * 所以内存里最多只有一个批次的文本。
       */
      const headerText = writer.header()
      if (headerText.length > 0) {
        task.bytesWritten += await writeAll(file, Buffer.from(headerText, 'utf8'))
      }

      for (;;) {
        if (this.#cancelled(task)) return this.#finishCancelled(task)
        const batch = await handle.read()
        // 每一批之后都重新检查取消：读批次是可能被取消打断的最长等待点。
        if (this.#cancelled(task)) return this.#finishCancelled(task)

        if (batch.rows.length === 0 && !batch.done) {
          // 空批次且还没结束：说明来源实现有问题（否则会无限空转，
          // 任务永远不结束，还一直占着文件句柄）。明确失败优于死循环。
          throw new Error('导出来源返回了空批次但没有标记结束，已中止以避免无限循环')
        }

        if (batch.rows.length > 0) {
          const truncated = findTruncatedCell(batch.rows, task.rowsRead)
          if (truncated !== null) {
            const columnName = handle.columns[truncated.column] ?? `#${truncated.column}`
            throw new Error(
              `第 ${truncated.row + 1} 行的列「${columnName}」是被截断的值` +
                '（长文本 / 大 BLOB）。导出要求完整字段值，已中止；' +
                '本次不会写出任何不完整的数据。'
            )
          }
          // 立即落盘：这一批的文本渲染完就写掉，不在内存里留到任务结束。
          const chunk = writer.renderRows(batch.rows)
          if (chunk.length > 0) {
            task.bytesWritten += await writeAll(file, Buffer.from(chunk, 'utf8'))
          }
          task.rowsRead += batch.rows.length
          task.batches += 1
        }
        if (batch.done) break
      }

      const footerText = writer.footer()
      if (footerText.length > 0) {
        task.bytesWritten += await writeAll(file, Buffer.from(footerText, 'utf8'))
      }
      if (this.#cancelled(task)) return this.#finishCancelled(task)

      // fsync：确保数据真的落到磁盘，再做 rename。
      await file.sync()
      if (this.#cancelled(task)) return this.#finishCancelled(task)
      await file.close()
      file = null
      if (this.#cancelled(task)) return this.#finishCancelled(task)

      /**
       * 提交前先关闭来源。
       *
       * 为什么要在这里关（而不是只在 finally 里关）：
       *   - 来源的 close 会释放宿主侧的游标/语句句柄，属于**可能出错**的 I/O；
       *     若它在 finally 里出错，文件已经发布出去了，错误就变成"文件写好了但任务报失败"。
       *   - close 期间用户仍可以取消（还没进入 committing），所以这里要再查一次取消标记。
       */
      try {
        await handle.close()
      } catch (err) {
        throw new Error(`关闭导出来源失败，未发布目标文件: ${describe(err)}`)
      }
      handle = null
      if (this.#cancelled(task)) return this.#finishCancelled(task)

      /**
       * 再查一次目标路径的安全性。
       *
       * 为什么开头查过一次还要再查：导出可能跑很久，
       * 期间**新登记的 SQLite 连接**（或路径被改成指向某个库文件）
       * 不会影响已经启动的任务。这里在提交前重新判定一次，
       * 避免"任务启动时安全、提交时危险"的窗口期。
       *
       * 这一步与后面的状态切换之间**没有 await**，所以不存在
       * "检查通过之后、rename 之前又被改掉"的竞态。
       */
      this.#assertDestinationAllowed(task.destinationPath)

      /**
       * 进入提交阶段：从这里到 rename 完成，**不再接受取消**。
       * 理由见文件头「取消与提交的竞态」。
       */
      task.status = 'committing'
      await renameFile(tempPath, task.destinationPath)
      task.tempPath = undefined
      committed = true
      task.committedPath = task.destinationPath
      task.status = 'completed'
      task.message = `已导出 ${task.rowsRead} 行`
      return this.#resultOf(task, 'completed')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      task.status = 'failed'
      task.message = message
      this.#log('warn', `[transfer:${task.id}] 任务失败: ${message}`)
      return this.#resultOf(task, 'failed')
    } finally {
      // 无论成功失败：源必须关闭（释放游标），文件句柄必须关闭。
      if (handle !== null) {
        try {
          await handle.close()
        } catch (err) {
          this.#log('warn', `[transfer:${task.id}] 关闭导出来源失败（忽略）: ${describe(err)}`)
        }
      }
      if (file !== null) {
        try {
          await file.close()
        } catch {
          // 关闭失败没有补救手段，忽略
        }
      }
      if (!committed && task.tempPath !== undefined) {
        try {
          await unlinkFile(task.tempPath)
        } catch {
          // 文件可能已经不在了（正常情况）
        }
        task.tempPath = undefined
      }
    }
  }

  #cancelled(task: TransferTask): boolean {
    return task.cancelRequested && task.status !== 'committing'
  }

  #finishCancelled(task: TransferTask): TransferResult {
    task.status = 'cancelled'
    task.message = '任务已取消'
    return this.#resultOf(task, 'cancelled')
  }

  #resultOf(task: TransferTask, status: TransferResult['status']): TransferResult {
    const result: TransferResult = {
      taskId: task.id,
      status,
      rowsRead: task.rowsRead,
      bytesWritten: task.bytesWritten,
      destinationPath: task.destinationPath
    }
    if (status === 'completed' && task.committedPath !== undefined) {
      return { ...result, committedPath: task.committedPath }
    }
    if (task.message !== undefined) return { ...result, message: task.message }
    return result
  }

  /**
   * 来源侧的契约校验。
   *
   * 这些检查放在**打开之后、写入之前**：此时列名已经知道了，
   * 才能判断"JSON 重复列名"这类只有拿到列才能发现的问题。
   */
  #validateHandle(task: TransferTask, handle: TransferSourceHandle): void {
    if (handle.columns.length === 0) {
      throw new Error('导出来源没有列信息，无法写出内容')
    }
    if (task.format === 'json' || task.format === 'jsonl') {
      const seen = new Set<string>()
      for (const column of handle.columns) {
        if (seen.has(column)) {
          throw new Error(
            `列名「${column}」重复。JSON 输出以列名作为对象键，重复列名会导致数据被覆盖，` +
              '已拒绝导出。请在 SQL 里给重复列起别名。'
          )
        }
        seen.add(column)
      }
    }
    if (task.format === 'sql-insert') {
      if (handle.target === undefined) {
        throw new Error(
          'SQL INSERT 导出需要一个明确的表来源（当前来源不是具体的表）。' +
            '为避免把数据插到错误的表上，已拒绝导出。'
        )
      }
      // 目标名的合法性在这里先验一次：生成不出来就早失败，别写到一半才炸。
      buildInsertTarget(handle.target, handle.dialectId)
    }
  }
}

function isTerminal(status: TransferStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 完整写入一个 buffer。
 *
 * `FileHandle.write` 是**可能短写**的（返回实际写入字节数，可能小于请求）。
 * 直接 `await file.write(buf)` 然后按 buf.length 计数，会在短写时
 * 报出一个比真实文件更大的字节数——进度与文件大小对不上，
 * 而且文件内容是截断的。
 *
 * 所以这里循环写，并把**真实写入的字节数**返回给调用方计数。
 */
async function writeAll(file: FileHandle, buffer: Buffer): Promise<number> {
  let written = 0
  while (written < buffer.byteLength) {
    const result = await file.write(buffer, written, buffer.byteLength - written)
    if (result.bytesWritten <= 0) {
      throw new Error('写入目标文件失败：底层返回 0 字节（磁盘可能已满或句柄已关闭）')
    }
    written += result.bytesWritten
  }
  return written
}

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

function validateFormat(format: unknown): TransferFormat {
  if (typeof format !== 'string' || !TRANSFER_FORMATS.includes(format as TransferFormat)) {
    throw new Error(
      `不支持的导出格式: ${String(format)}（可用: ${TRANSFER_FORMATS.join(', ')}）`
    )
  }
  return format as TransferFormat
}

function validateDestination(destinationPath: unknown): string {
  if (typeof destinationPath !== 'string' || destinationPath.trim() === '') {
    throw new Error('必须提供目标文件路径')
  }
  return resolve(destinationPath)
}

function validateSource(source: unknown): TransferSource {
  if (typeof source !== 'object' || source === null) {
    throw new Error('必须提供导出来源')
  }
  const value = source as TransferSource
  const hasNode = typeof value.nodeId === 'string' && value.nodeId.trim() !== ''
  const hasSql = typeof value.sql === 'string' && value.sql.trim() !== ''
  if (!hasNode && !hasSql) {
    throw new Error('必须提供导出来源：nodeId（表来源）或 sql（查询来源）')
  }
  if (hasSql && !hasNode && (value.connectionId === undefined || value.connectionId === '')) {
    throw new Error('SQL 来源必须同时提供 nodeId（连接根节点）或 connectionId 以定位连接')
  }
  if (value.connectionId !== undefined && typeof value.connectionId !== 'string') {
    throw new Error('connectionId 必须是字符串')
  }
  return value
}

function validateOptions(
  options: TransferOptions | undefined,
  format: TransferFormat
): ResolvedOptions {
  const includeHeader = options?.includeHeader ?? true
  if (typeof includeHeader !== 'boolean') throw new Error('includeHeader 必须是布尔值')

  const nullText = options?.nullText ?? ''
  if (typeof nullText !== 'string') throw new Error('nullText 必须是字符串')
  const newline = options?.newline ?? '\r\n'
  if (newline !== '\r\n' && newline !== '\n') {
    throw new Error('newline 只支持 "\\r\\n" 或 "\\n"')
  }

  const jsonIndent = options?.jsonIndent ?? 2
  if (!Number.isInteger(jsonIndent) || jsonIndent < 0 || jsonIndent > 8) {
    throw new Error('jsonIndent 必须是 0 ~ 8 的整数')
  }

  const batchSize = normalizeTransferBatchSize(options?.batchSize)

  if (format === 'sql-insert' && options?.nullText !== undefined) {
    /**
     * SQL INSERT 的 NULL 必须是关键字 `NULL`，不能是任何文本。
     * 显式给出的 nullText 在这个格式下**没有意义**，直接拒绝而不是默默忽略——
     * 默默忽略会让用户以为"NULL 写成了我指定的文本"，实际文件里是 NULL。
     */
    throw new Error(
      'SQL INSERT 格式不支持 nullText：NULL 必须写成 SQL 关键字 NULL。' +
        '请不要为该格式指定 nullText。'
    )
  }

  return { includeHeader, nullText, newline, jsonIndent, batchSize }
}

// ---------------------------------------------------------------------------
// 格式写出
// ---------------------------------------------------------------------------

/**
 * 各格式的文本生成器。
 *
 * 拆成 header / renderRows / footer 三段，是为了让"表头"与"数据"在
 * **不同格式下有不同位置**这件事显式化：
 *   - CSV：表头是第一行，与数据同构；
 *   - JSONL：每行一个对象，表头只决定 key（没有单独的头部行）；
 *   - JSON：整个文件是一个数组，表头同样只决定 key；
 *   - SQL INSERT：没有表头，列名只出现在 INSERT 语句里。
 */
interface Writer {
  header(): string
  renderRows(rows: readonly (readonly CellValue[])[]): string
  footer(): string
}

function createWriter(task: TransferTask, handle: TransferSourceHandle): Writer {
  switch (task.format) {
    case 'csv':
      return createCsvWriter(task, handle)
    case 'jsonl':
      return createJsonlWriter(task, handle)
    case 'json':
      return createJsonWriter(task, handle)
    case 'sql-insert':
      return createSqlWriter(task, handle)
    default: {
      const never: never = task.format
      throw new Error(`未实现的导出格式: ${String(never)}`)
    }
  }
}

function createCsvWriter(task: TransferTask, handle: TransferSourceHandle): Writer {
  const newline = task.options.newline
  return {
    header(): string {
      if (!task.options.includeHeader) return ''
      return handle.columns.map((column) => csvEscapeField(column)).join(',') + newline
    },
    renderRows(rows): string {
      const parts: string[] = []
      for (const row of rows) {
        const cells = handle.columns.map((_, index) => {
          const text = cellToTransferText(row[index])
          const value = text === null ? task.options.nullText : text
          return csvEscapeField(value)
        })
        parts.push(cells.join(',') + newline)
      }
      return parts.join('')
    },
    footer(): string {
      // 只有表头没有数据行时，CSV 仍然是一个合法的文件，无需补任何内容。
      return ''
    }
  }
}

function createJsonlWriter(task: TransferTask, handle: TransferSourceHandle): Writer {
  const newline = task.options.newline
  return {
    header(): string {
      // JSON Lines 没有表头行；列名通过每行的 key 表达。
      return ''
    },
    renderRows(rows): string {
      const parts: string[] = []
      for (const row of rows) {
        // 用 Object.create(null) 而不是 {}：列名可能叫 "__proto__"，
        // 赋到普通对象的原型上会**吞掉这个列**（静默丢一列数据）。
        const obj: Record<string, unknown> = Object.create(null) as Record<string, unknown>
        handle.columns.forEach((column, index) => {
          obj[column] = cellToJsonValue(row[index])
        })
        parts.push(JSON.stringify(obj) + newline)
      }
      return parts.join('')
    },
    footer(): string {
      return ''
    }
  }
}

function createJsonWriter(task: TransferTask, handle: TransferSourceHandle): Writer {
  const indent = task.options.jsonIndent
  const pad = ' '.repeat(indent)
  let first = true
  return {
    header(): string {
      // JSON 是**一个数组**，不是每行一个对象：开头是 `[`，第一项前要换行缩进。
      return '['
    },
    renderRows(rows): string {
      const parts: string[] = []
      for (const row of rows) {
        // 见 JSONL 版本：Object.create(null) 防止 "__proto__" 列被吞掉。
        const obj: Record<string, unknown> = Object.create(null) as Record<string, unknown>
        handle.columns.forEach((column, index) => {
          obj[column] = cellToJsonValue(row[index])
        })
        const body = JSON.stringify(obj, null, indent)
        // JSON.stringify(obj, null, indent) 会把对象**跨行**展开，
        // 缩进也是对象内部的。数组元素的缩进要自己补一级。
        const indented = body
          .split('\n')
          .map((line, lineIndex) => (lineIndex === 0 ? line : pad + line))
          .join('\n')
        parts.push(`${first ? '' : ','}\n${pad}${indented}`)
        first = false
      }
      return parts.join('')
    },
    footer(): string {
      if (first) {
        // 一行都没有：输出空数组 `[]`，而不是 `[\n]` 这种畸形 JSON。
        return ']'
      }
      return `\n]`
    }
  }
}

function createSqlWriter(task: TransferTask, handle: TransferSourceHandle): Writer {
  const target = handle.target
  if (target === undefined) {
    throw new Error('SQL INSERT 导出缺少目标表，已拒绝')
  }
  const qualified = buildInsertTarget(target, handle.dialectId)
  const columnList = handle.columns
    .map((column) => quoteTransferIdentifier(column, handle.dialectId))
    .join(', ')
  const prefix = `INSERT INTO ${qualified} (${columnList}) VALUES (`
  return {
    header(): string {
      return ''
    },
    renderRows(rows): string {
      const parts: string[] = []
      for (const row of rows) {
        const values = handle.columns
          .map((_, index) => cellToSqlLiteral(row[index], handle.dialectId))
          .join(', ')
        parts.push(`${prefix}${values});\n`)
      }
      return parts.join('')
    },
    footer(): string {
      return ''
    }
  }
}
