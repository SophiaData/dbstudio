/**
 * 驱动宿主进程的客户端（主进程侧）。
 *
 * ===== 这一层的职责边界 =====
 *
 * 它**不关心任何数据库知识**，只做三件事：
 *   1. 把驱动宿主拉起来（一个连接一个进程）
 *   2. 按 NDJSON 协议收发帧，并把「请求 id → Promise」对应起来
 *   3. 进程死了要能立刻让所有挂起的调用失败，而不是让 UI 转圈到超时
 *
 * 第 3 点是这种架构最容易写错的地方：如果只监听 message 不监听 exit，
 * 宿主崩溃后所有 pending Promise 会永远挂着，UI 表现为「一直加载中」，
 * 而日志里什么都没有。所以 exit / error 事件必须清空 pending 表。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ConnectionConfig } from '../core/dialect'
import type {
  DialectInfo,
  DriverAdapter,
  RpcEvent,
  RpcHandshake,
  RpcMethod,
  RpcRequest,
  RpcResponse,
  SecretInput,
  TestConnectionResult
} from '../core/driver'
import { isRpcResponse } from '../core/driver'
import type { DriverCapabilities, ObjectRef, TableCreateSpec, TableDescription } from '../core/model'
import type { ExplainResult, QueryOptions, QueryResult, ResultPage, StatementResult } from '../core/resultset'
import type { EditApplyResult, RowUpdate, TransactionState } from '../core/resultset'
import type { CellValue } from '../core/resultset'
import type {
  ImportBatch,
  ImportBatchResult,
  TransferSourceResolution
} from '../core/transfer'

/** 单条 RPC 的默认超时。宿主无响应时宁可报错，也不要让 UI 无限等待。 */
const RPC_TIMEOUT_MS = 15_000

/**
 * 结果集类 RPC 的独立超时。
 *
 * ===== 为什么不能沿用 15s =====
 *
 * 15s 是给**元数据**定的：listChildren / describeTable 都是单表 PRAGMA 级的小查询，
 * 正常几毫秒返回，15s 只可能是故障。
 *
 * 但 query / fetchResultPage 是**用户 SQL**：
 *   - 一条没走索引的 JOIN 在几十万行表上跑十几秒是常态，不是故障；
 *   - 用户在 UI 上明确点了「执行」，他预期的是「等」，而不是「15 秒后报超时」；
 *   - 用元数据的超时去卡用户查询，会把「慢查询」误报成「驱动挂了」，
 *     而这两种情况对用户的处理方式完全相反（一个该等/优化 SQL，一个该重连）。
 *
 * 60s 的取舍：长到足够覆盖绝大多数交互式查询，短到不会让 UI 在真挂掉时
 * 无限转圈。**这是超时，不是取消**——查询取消能力由 `supportsCancel` 单独声明，
 * 不在超时机制里假装实现（假取消比没有取消更糟）。
 */
const RESULT_SET_TIMEOUT_MS = 60_000

/** 宿主优雅退出的等待上限，超时就强杀。 */
const SHUTDOWN_GRACE_MS = 3_000
const STDERR_TAIL_MAX_BYTES = 4_096

/** 超时覆盖值必须是正数，否则回落到默认常量（避免测试钩子把超时设成 0 造成立即失败）。 */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 定位驱动宿主脚本。
 *
 * 开发态与打包态的目录结构不同，所以按候选路径依次探测，
 * 而不是硬编码某一个。探测失败时要给出**所有试过的路径**，
 * 否则这个错误在用户机器上几乎无法定位。
 */
export function resolveDriverHostScript(): string {
  const candidates = [
    // electron-vite 构建产物：out/main/index.js -> out/driver-host/index.js
    join(__dirname, '..', 'driver-host', 'index.js'),
    // 打包后常见位置：<resources>/app.asar.unpacked/out/driver-host/index.js
    join(process.resourcesPath ?? '', 'app.asar.unpacked', 'out', 'driver-host', 'index.js'),
    join(process.resourcesPath ?? '', 'out', 'driver-host', 'index.js'),
    // 源码树直接跑（调试用）
    resolve(__dirname, '..', '..', 'out', 'driver-host', 'index.js')
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  throw new Error(
    `找不到驱动宿主脚本，已尝试:\n${candidates.map((c) => `  - ${c}`).join('\n')}\n` +
      `请先执行 pnpm run build:driver-host`
  )
}

interface Pending {
  readonly resolve: (v: unknown) => void
  readonly reject: (e: Error) => void
  readonly timer: NodeJS.Timeout
  readonly method: string
}

export interface DriverHostOptions {
  readonly dialectId: string
  readonly onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  readonly onExit?: (error: Error) => void
  /**
   * 仅用于测试的超时覆盖。生产调用方不传时完全沿用模块常量，行为不变。
   * 这样超时路径可以在可控 fake 宿主上真实验证，而不必等 60s。
   */
  readonly timeouts?: {
    readonly requestMs?: number
    readonly resultSetMs?: number
  }
}

export type HostLifecycle =
  | 'spawning'
  | 'awaiting_handshake'
  | 'ready'
  | 'closing'
  | 'exited'
  | 'failed'

export interface DriverHostDiagnostics {
  readonly dialectId: string
  readonly script: string
  readonly lifecycle: HostLifecycle
  readonly pid: number | undefined
  readonly stdoutBytes: number
  readonly stderrTail: string
  readonly exitCode: number | null
  readonly exitSignal: NodeJS.Signals | null
}

/**
 * 事务边界类 RPC 超时时抛出的错误（宿主已被强制终止）。
 *
 * 为什么需要独立类型：调用方必须能区分「普通 RPC 超时（宿主还活着，可重试）」
 * 与「事务边界超时（宿主已被终止，事务结果不可再假定）」。普通 Error 只能靠
 * 文案猜，ImportManager 无法安全决策。
 */
export class DriverHostTimeoutError extends Error {
  readonly code = 'driver_host_timeout'
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
    readonly hostTerminated: boolean,
    message: string
  ) {
    super(message)
    this.name = 'DriverHostTimeoutError'
  }
}

/**
 * 提交事务结果未知。
 *
 * 只要无法确认 COMMIT 是否已经在数据库侧生效，就必须用它，而**不能**
 * 退回「提交失败 = 肯定没提交」的假设——那会让上层放心地回滚/重试，
 * 而数据其实可能已经提交。文案固定以 `COMMIT_OUTCOME_UNKNOWN:` 开头，
 * 便于上层在不依赖 `instanceof`（跨 bundle 边界时会失效）的情况下识别。
 */
export class CommitOutcomeUnknownError extends Error {
  readonly code = 'commit_outcome_unknown'
  readonly commitOutcome = 'unknown' as const
  constructor(
    readonly reason: 'timeout' | 'host_exit',
    message: string
  ) {
    super(message)
    this.name = 'CommitOutcomeUnknownError'
  }
}

/** 识别「提交结果未知」错误的稳定入口（同时接受 code 标记，跨 bundle 也能用）。 */
export function isCommitOutcomeUnknown(error: unknown): error is CommitOutcomeUnknownError {
  if (error instanceof CommitOutcomeUnknownError) return true
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'commit_outcome_unknown'
  )
}

/**
 * 识别「事务边界超时且宿主已被终止」的稳定入口。
 *
 * 上层拿到它时**不要**再尝试回滚：宿主已不可用，回滚请求根本到不了驱动；
 * 未提交事务由数据库在连接断开时自行回滚。`method` 可区分
 * importBatch / rollbackTransaction 等具体动作。
 */
export function isHostTerminatedTimeout(error: unknown): error is DriverHostTimeoutError {
  if (error instanceof DriverHostTimeoutError) return error.hostTerminated
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'driver_host_timeout' &&
    (error as { hostTerminated?: unknown }).hostTerminated === true
  )
}

/**
 * 这些方法的超时不能被当作「请求失败了，但宿主还能继续用」：
 *   - importBatch：多批次共享同一个事务，客户端放弃时宿主可能仍在逐行 INSERT；
 *   - commitTransaction：COMMIT 一旦发出，结果可能已生效，不能假装没提交；
 *   - rollbackTransaction：回滚可能仍在进行，继续接受写入会与回滚交错。
 * 所以它们的超时必须走「终止宿主 + 标记不可用」，而不是仅从 pending 表移除。
 */
const HOST_TERMINATING_TIMEOUT_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'importBatch',
  'commitTransaction',
  'rollbackTransaction'
])

/**
 * 一个驱动宿主进程的句柄。
 *
 * 对应 DBeaver 的 `DriverClassLoader` 想达成的目标（隔离驱动），
 * 但手段完全不同：那边是靠类加载器隔离，这边是**操作系统级进程隔离**。
 */
export class DriverHostHandle {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #dialectId: string
  readonly #script: string
  readonly #pending = new Map<number, Pending>()
  readonly #onLog: (level: 'info' | 'warn' | 'error', message: string) => void
  readonly #onExit: (error: Error) => void
  readonly #exited: Promise<void>
  #nextId = 1
  #stdoutBuffer = ''
  #stdoutBytes = 0
  #stderrTail = ''
  #exitCode: number | null = null
  #exitSignal: NodeJS.Signals | null = null
  #lifecycle: HostLifecycle = 'spawning'
  #closed = false
  #closing: Promise<void> | null = null
  readonly #rpcTimeoutMs: number
  readonly #resultSetTimeoutMs: number
  readonly handshake: Promise<RpcHandshake>

  constructor(options: DriverHostOptions) {
    this.#dialectId = options.dialectId
    this.#onLog = options.onLog ?? (() => {})
    this.#onExit = options.onExit ?? (() => {})
    this.#rpcTimeoutMs = positiveOr(options.timeouts?.requestMs, RPC_TIMEOUT_MS)
    this.#resultSetTimeoutMs = positiveOr(options.timeouts?.resultSetMs, RESULT_SET_TIMEOUT_MS)

    const script = resolveDriverHostScript()
    this.#script = script
    this.#child = spawn(process.execPath, [script, '--dialect', options.dialectId], {
      // ELECTRON_RUN_AS_NODE=1：让 Electron 二进制以纯 Node 身份运行子进程，
      // 这样宿主里可以正常使用 node:sqlite 等内置模块，且不必依赖用户装了系统 node。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.#lifecycle = 'awaiting_handshake'

    // 握手是构造后立刻就会到达的一帧，用它确认「这个进程是谁」。
    this.handshake = new Promise<RpcHandshake>((resolveHandshake, rejectHandshake) => {
      const timer = setTimeout(() => {
        this.#terminate(this.#diagnosticError(`驱动宿主 ${options.dialectId} 在 10s 内未完成握手`))
      }, 10_000)
      // 握手帧由下面的 stdout 解析器捕获后 resolve。
      this.#handshakeSettler = {
        resolve: (hs) => {
          clearTimeout(timer)
          resolveHandshake(hs)
        },
        reject: (e) => {
          clearTimeout(timer)
          rejectHandshake(e)
        }
      }
    })

    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk: string) => this.#onStdout(chunk))

    // stderr 是宿主的日志通道，与协议流分开，不会污染 JSON。
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (chunk: string) => {
      this.#appendStderr(chunk)
      const text = chunk.trimEnd()
      if (text) this.#onLog('info', `[driver-host:${options.dialectId}] ${text}`)
    })

    // 关键：进程退出必须清算所有挂起请求，否则 UI 会永远转圈。
    this.#exited = new Promise<void>((resolveExit) => {
      this.#child.once('exit', (code, signal) => {
        this.#exitCode = code
        this.#exitSignal = signal
        this.#lifecycle =
          this.#closing !== null && code === 0 && signal === null ? 'exited' : 'failed'
        this.#finish(
          this.#diagnosticError(
            `驱动宿主进程已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`
          )
        )
        resolveExit()
      })
      this.#child.on('error', (err) => {
        this.#terminate(this.#diagnosticError(err.message))
        // spawn 失败时没有 exit 事件。
        if (this.#child.pid === undefined) resolveExit()
      })
    })
    this.#child.stdin.on('error', (err) => this.#terminate(err))
  }

  get closed(): boolean {
    return this.#closed
  }

  get lifecycle(): HostLifecycle {
    return this.#lifecycle
  }

  get diagnostics(): DriverHostDiagnostics {
    return {
      dialectId: this.#dialectId,
      script: this.#script,
      lifecycle: this.#lifecycle,
      pid: this.#child.pid,
      stdoutBytes: this.#stdoutBytes,
      stderrTail: this.#stderrTail,
      exitCode: this.#exitCode,
      exitSignal: this.#exitSignal
    }
  }

  #finish(error: Error): void {
    if (this.#closed) return
    this.#closed = true
    this.#failAllPending(error)
    this.#onExit(error)
  }

  #terminate(error: Error): void {
    if (this.#closed) return
    this.#lifecycle = 'failed'
    this.#finish(error)
    this.#child.kill('SIGKILL')
  }

  #diagnosticError(reason: string): Error {
    const stderr = this.#stderrTail.trim() || '(empty)'
    return new Error(
      `${reason}; dialect=${this.#dialectId} pid=${this.#child.pid ?? 'unknown'} ` +
        `script=${this.#script} stdoutBytes=${this.#stdoutBytes} stderr=${stderr}`
    )
  }

  #appendStderr(chunk: string): void {
    this.#stderrTail = `${this.#stderrTail}${chunk}`
    const bytes = Buffer.byteLength(this.#stderrTail, 'utf8')
    if (bytes <= STDERR_TAIL_MAX_BYTES) return
    this.#stderrTail = Buffer.from(this.#stderrTail, 'utf8')
      .subarray(-STDERR_TAIL_MAX_BYTES)
      .toString('utf8')
  }

  #handshakeSettler: { resolve: (hs: RpcHandshake) => void; reject: (e: Error) => void } | null =
    null

  /** 逐行切分 stdout。TCP/管道不保证一次 data 就是完整一行，必须自己攒。 */
  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk
    this.#stdoutBytes += Buffer.byteLength(chunk, 'utf8')
    let idx: number
    while ((idx = this.#stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.#stdoutBuffer.slice(0, idx).trim()
      this.#stdoutBuffer = this.#stdoutBuffer.slice(idx + 1)
      if (!line) continue
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        // 收到非 JSON 说明宿主把日志写到 stdout 了（协议违规）。
        this.#onLog('warn', `[driver-host] stdout 出现非协议内容: ${line.slice(0, 200)}`)
        continue
      }
      this.#handleFrame(frame)
    }
  }

  #handleFrame(frame: unknown): void {
    if (isRpcResponse(frame)) {
      this.#settle(frame)
      return
    }
    const event = frame as RpcEvent
    if (event?.kind === 'handshake') {
      if (this.#lifecycle === 'awaiting_handshake') this.#lifecycle = 'ready'
      this.#handshakeSettler?.resolve(event)
      this.#handshakeSettler = null
    } else if (event?.kind === 'log') {
      this.#onLog(event.level, `[driver-host] ${event.message}`)
    }
  }

  #settle(res: RpcResponse): void {
    const pending = this.#pending.get(res.id)
    if (!pending) return
    this.#pending.delete(res.id)
    clearTimeout(pending.timer)
    if (res.ok) pending.resolve(res.result)
    else pending.reject(new Error(`${res.error.code}: ${res.error.message}`))
  }

  #failAllPending(err: Error): void {
    this.#handshakeSettler?.reject(err)
    this.#handshakeSettler = null
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      if (p.method === 'commitTransaction') {
        // 宿主在 commit 在途时退出：COMMIT 可能已经在数据库侧生效，
        // 绝不能把「连接没了」当成「肯定没提交」。
        p.reject(
          new CommitOutcomeUnknownError(
            'host_exit',
            `COMMIT_OUTCOME_UNKNOWN: 提交事务期间驱动宿主已退出（${err.message}），` +
              '无法确认数据库是否已提交；请重新连接并核对数据后再决定是否重试。'
          )
        )
      } else {
        p.reject(err)
      }
    }
    this.#pending.clear()
  }

  /** 发一条 RPC 并等待响应。超时会主动失败，避免悬挂。 */
  request<T>(method: RpcMethod, params?: unknown): Promise<T> {
    return this.#requestWithTimeout<T>(method, params, this.#rpcTimeoutMs)
  }

  /**
   * 带自定义超时的请求。
   *
   * 单独抽出来而不是给 `request` 加默认参数，是为了让**每个调用点都必须显式
   * 选择**用哪个超时。默认参数会被无意识地继承，结果就是某个新加的用户 SQL
   * 方法悄悄用了 15s；显式传参时这个选择至少会在 code review 里被看到。
   */
  #requestWithTimeout<T>(method: RpcMethod, params: unknown, timeoutMs: number): Promise<T> {
    if (this.#closed || (this.#closing && method !== 'disconnect')) {
      return Promise.reject(new Error(`驱动宿主已关闭，无法调用 ${method}`))
    }
    // 调用点仍然显式传模块常量，便于 review 每个方法选的超时档位；
    // 测试钩子只在这里把常量映射成缩短后的生效值，生产默认完全一致。
    const effectiveTimeoutMs =
      timeoutMs === RPC_TIMEOUT_MS
        ? this.#rpcTimeoutMs
        : timeoutMs === RESULT_SET_TIMEOUT_MS
          ? this.#resultSetTimeoutMs
          : timeoutMs
    const id = this.#nextId++
    const frame: RpcRequest = { id, method, params }
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        // 响应可能刚好先到并被 #settle 清掉，这里再确认一次，避免误杀已完成的请求。
        if (!this.#pending.has(id)) return
        this.#pending.delete(id)
        if (HOST_TERMINATING_TIMEOUT_METHODS.has(method)) {
          const error = this.#transactionBoundaryTimeoutError(method, effectiveTimeoutMs)
          // 先同步把句柄标记为 closed（#terminate -> #finish），再拒绝本次调用。
          // 这样调用方紧接着发起的 rollback/commit 会在句柄层被拒绝，绝不会写进
          // 仍在逐行写入的宿主 stdin。进程被 SIGKILL 后，数据库连接断开，
          // 未提交事务由数据库回滚。
          this.#terminate(error)
          rej(error)
          return
        }
        rej(new Error(`驱动宿主调用 ${method} 超时（${effectiveTimeoutMs}ms）`))
      }, effectiveTimeoutMs)
      this.#pending.set(id, {
        resolve: res as (v: unknown) => void,
        reject: rej,
        timer,
        method
      })
      try {
        this.#child.stdin.write(`${JSON.stringify(frame, (_key, value: unknown) =>
          value instanceof Uint8Array ? { type: 'dbstudio-sql-bytes', data: Array.from(value) } : value
        )}\n`, (err) => {
          if (err) this.#terminate(err)
        })
      } catch (e) {
        clearTimeout(timer)
        this.#pending.delete(id)
        rej(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /** 构造事务边界超时错误：类型/文案都要让上层能区分「结果未知」。 */
  #transactionBoundaryTimeoutError(method: RpcMethod, timeoutMs: number): Error {
    if (method === 'commitTransaction') {
      return new CommitOutcomeUnknownError(
        'timeout',
        `COMMIT_OUTCOME_UNKNOWN: 提交事务超时（${timeoutMs}ms），无法确认数据库是否已提交；` +
          '已强制终止驱动宿主并断开连接。请重新连接并核对数据后，再决定是否重试。'
      )
    }
    if (method === 'rollbackTransaction') {
      return new DriverHostTimeoutError(
        method,
        timeoutMs,
        true,
        `HOST_TERMINATED_TIMEOUT: 回滚事务超时（${timeoutMs}ms），回滚结果未知；` +
          '已强制终止驱动宿主并断开连接，未提交事务由数据库在连接断开时回滚。'
      )
    }
    return new DriverHostTimeoutError(
      method,
      timeoutMs,
      true,
      `HOST_TERMINATED_TIMEOUT: 导入批次写入超时（${timeoutMs}ms），` +
        '已强制终止驱动宿主以阻止后续写入；未提交事务随连接断开回滚。' +
        '请重新连接后核对导入结果。'
    )
  }

  // ---- 语义化的便捷方法（对上层隐藏 RPC 细节） ----

  connect(config: ConnectionConfig, secret?: SecretInput): Promise<DriverCapabilities> {
    return this.request<DriverCapabilities>('connect', { config, secret })
  }

  listChildren(parentId: string | null): Promise<ObjectRef[]> {
    return this.request<ObjectRef[]>('listChildren', { parentId })
  }

  describeTable(id: string): Promise<TableDescription> {
    return this.request<TableDescription>('describeTable', { id })
  }

  testConnection(config: ConnectionConfig, secret?: SecretInput): Promise<TestConnectionResult> {
    return this.request<TestConnectionResult>('testConnection', { config, secret })
  }

  // ---- 结果集：全部走 60s 长超时（理由见 RESULT_SET_TIMEOUT_MS） ----

  /** 执行 SQL，返回第一页与游标。 */
  query(sql: string, options?: QueryOptions): Promise<QueryResult> {
    return this.#requestWithTimeout<QueryResult>(
      'query',
      { sql, options },
      RESULT_SET_TIMEOUT_MS
    )
  }

  /** 执行语句（查询、DML 或 DDL）。 */
  executeStatement(sql: string, options?: QueryOptions): Promise<StatementResult> {
    return this.#requestWithTimeout<StatementResult>(
      'executeStatement',
      { sql, options },
      RESULT_SET_TIMEOUT_MS
    )
  }

  /** 按驱动方言生成执行计划。 */
  explain(sql: string): Promise<ExplainResult> {
    return this.#requestWithTimeout<ExplainResult>('explain', { sql }, RESULT_SET_TIMEOUT_MS)
  }

  /**
   * 从游标按偏移量取一页。
   *
   * 这里收到的 `cursorId` 已经是**被 ConnectionManager 还原过的原生 id**：
   * 作用域前缀（`connection:c1|`）在主进程侧就剥掉了，宿主只认 adapter 自己的 id。
   */
  fetchResultPage(cursorId: string, offset: number, limit: number): Promise<ResultPage> {
    return this.#requestWithTimeout<ResultPage>(
      'fetchResultPage',
      { cursorId, offset, limit },
      RESULT_SET_TIMEOUT_MS
    )
  }

  /** 释放游标。幂等，重复调用不报错。 */
  closeCursor(cursorId: string): Promise<void> {
    // 关游标本身是 O(1) 的本地操作，理论上用默认超时就够；
    // 但这里仍用长超时，理由是**它和 fetch 是同一批生命周期操作**：
    // 若宿主正忙着一个慢查询，closeCursor 会排在它后面，
    // 用 15s 会让「网格都关了但游标没释放」这种泄漏悄悄发生。
    return this.#requestWithTimeout<void>('closeCursor', { cursorId }, RESULT_SET_TIMEOUT_MS)
  }

  // ---- 在线编辑与事务（第三阶段） ----

  /**
   * 应用一批行更新（不自动提交）。
   *
   * 超时沿用结果集的 60s：写操作只会比读更慢，不会更快——
   * 它要在同一个事务里跑多条 UPDATE，还可能撞上锁等待。
   * 用 15s 会把「正在等行锁的正常写入」误判成驱动挂了。
   */
  applyEdits(tableId: string, updates: readonly RowUpdate[]): Promise<EditApplyResult> {
    return this.#requestWithTimeout<EditApplyResult>(
      'applyEdits',
      { tableId, updates },
      RESULT_SET_TIMEOUT_MS
    )
  }

  /** 提交事务。无活动事务时 adapter 会报错（不静默成功）。 */
  commitTransaction(): Promise<TransactionState> {
    return this.#requestWithTimeout<TransactionState>(
      'commitTransaction',
      undefined,
      RESULT_SET_TIMEOUT_MS
    )
  }

  /**
   * 回滚事务。幂等。
   *
   * 注意它**不需要**先确定有事务——`ConnectionManager.remove` 的清理路径
   * 会无条件调用它，靠 adapter 把「本来就没有事务」当成功处理。
   */
  rollbackTransaction(): Promise<TransactionState> {
    return this.#requestWithTimeout<TransactionState>(
      'rollbackTransaction',
      undefined,
      RESULT_SET_TIMEOUT_MS
    )
  }

  /** 查询事务状态。 */
  transactionState(): Promise<TransactionState> {
    return this.#requestWithTimeout<TransactionState>(
      'transactionState',
      undefined,
      RESULT_SET_TIMEOUT_MS
    )
  }

  // ---- 增删与完整取值（第五阶段）：全部沿用 60s（写入/全表扫描都可能慢） ----

  /** 插入一行（不自动提交）。 */
  insertRow(
    tableId: string,
    values: Readonly<Record<string, CellValue>>
  ): Promise<{ affected: number; keyValues: Record<string, CellValue> }> {
    return this.#requestWithTimeout(
      'insertRow',
      { tableId, values },
      RESULT_SET_TIMEOUT_MS
    )
  }

  /** 批量导入写入。沿用结果集超时：锁等待或大事务都不应被 15s 误杀。 */
  importBatch(tableId: string, batch: ImportBatch): Promise<ImportBatchResult> {
    return this.#requestWithTimeout<ImportBatchResult>(
      'importBatch',
      { tableId, batch },
      RESULT_SET_TIMEOUT_MS
    )
  }

  /** 按主键批量删除（不自动提交）。空数组在宿主侧被拒。 */
  deleteRows(
    tableId: string,
    keys: readonly Readonly<Record<string, CellValue>>[]
  ): Promise<EditApplyResult> {
    return this.#requestWithTimeout<EditApplyResult>(
      'deleteRows',
      { tableId, keys },
      RESULT_SET_TIMEOUT_MS
    )
  }

  /** 统计行数。用 60s 是因为大表 COUNT(*) 可能真的跑很久。 */
  countRows(tableId: string): Promise<number> {
    return this.#requestWithTimeout<number>('countRows', { tableId }, RESULT_SET_TIMEOUT_MS)
  }

  /** 取单格完整值。 */
  fetchCellValue(cursorId: string, rowIndex: number, columnIndex: number): Promise<CellValue> {
    return this.#requestWithTimeout<CellValue>(
      'fetchCellValue',
      { cursorId, rowIndex, columnIndex },
      RESULT_SET_TIMEOUT_MS
    )
  }

  // ---- DDL（第六阶段）：涉及改表结构，可能因锁等待而慢，沿用 60s ----

  createTable(connectionId: string, spec: TableCreateSpec): Promise<void> {
    return this.#requestWithTimeout<void>(
      'createTable',
      { connectionId, spec },
      RESULT_SET_TIMEOUT_MS
    )
  }

  /** `nodeId` 是完整 adapterId（不含连接前缀），由 adapter 解析。 */
  dropTable(nodeId: string): Promise<void> {
    return this.#requestWithTimeout<void>('dropTable', { nodeId }, RESULT_SET_TIMEOUT_MS)
  }

  createView(connectionId: string, viewName: string, selectSql: string): Promise<void> {
    return this.#requestWithTimeout<void>(
      'createView',
      { connectionId, viewName, selectSql },
      RESULT_SET_TIMEOUT_MS
    )
  }

  dropView(nodeId: string): Promise<void> {
    return this.#requestWithTimeout<void>('dropView', { nodeId }, RESULT_SET_TIMEOUT_MS)
  }

  /**
   * 取消当前查询。
   *
   * 超时用较短的 10s：取消请求本身不该让用户再等 60s——
   * 如果这么久都没有响应，说明后端有问题，宁可报超时。
   */
  cancelQuery(signalId?: string): Promise<boolean> {
    return this.#requestWithTimeout<boolean>('cancelQuery', { signalId }, 10_000)
  }

  renameTable(nodeId: string, newName: string): Promise<void> {
    return this.#requestWithTimeout<void>(
      'renameTable',
      { nodeId, newName },
      RESULT_SET_TIMEOUT_MS
    )
  }

  /**
   * 解析导出对象 → 读取语句 + INSERT 落点。
   *
   * 超时用结果集的 60s：它内部要查一次元数据（确认对象存在），
   * 慢库上可能真的慢。
   */
  resolveTransferSource(nodeId: string): Promise<TransferSourceResolution> {
    return this.#requestWithTimeout<TransferSourceResolution>(
      'resolveTransferSource',
      { nodeId },
      RESULT_SET_TIMEOUT_MS
    )
  }

  /** 优雅关闭：先 disconnect，再关 stdin 让宿主自行退出；超时则强杀。 */
  close(): Promise<void> {
    if (!this.#closing) this.#closing = this.#close()
    return this.#closing
  }

  async #close(): Promise<void> {
    if (this.#closed) return this.#exited
    this.#lifecycle = 'closing'
    // 限时覆盖 disconnect RPC 本身，不能先等 15s RPC 超时再开始退出计时。
    const timer = setTimeout(() => this.kill(), SHUTDOWN_GRACE_MS)
    try {
      await this.request<unknown>('disconnect').catch(() => undefined)
      if (!this.#closed) this.#child.stdin.end()
      await this.#exited
    } finally {
      clearTimeout(timer)
    }
  }

  /** 强制回收（应用退出时兜底）。 */
  kill(): void {
    this.#terminate(new Error('驱动宿主已强制关闭'))
  }
}

/**
 * 供上层类型检查用：宿主进程暴露的能力与 `DriverAdapter` 一一对应，
 * 但**对象本身不在本进程**——这正是隔离的意义。
 */
export type RemoteAdapterShape = Pick<
  DriverAdapter,
  | 'connect'
  | 'disconnect'
  | 'listChildren'
  | 'describeTable'
  | 'testConnection'
  | 'query'
  | 'fetchResultPage'
  | 'closeCursor'
  | 'applyEdits'
  | 'commitTransaction'
  | 'rollbackTransaction'
  | 'transactionState'
  | 'insertRow'
  | 'importBatch'
  | 'deleteRows'
  | 'countRows'
  | 'fetchCellValue'
  | 'createTable'
  | 'dropTable'
  | 'createView'
  | 'dropView'
  | 'renameTable'
  | 'cancelQuery'
  | 'resolveTransferSource'
>

export type { DialectInfo }
