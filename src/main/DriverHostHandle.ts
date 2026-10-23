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
import type { QueryOptions, QueryResult, ResultPage } from '../core/resultset'
import type { EditApplyResult, RowUpdate, TransactionState } from '../core/resultset'
import type { CellValue } from '../core/resultset'

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
}

/**
 * 一个驱动宿主进程的句柄。
 *
 * 对应 DBeaver 的 `DriverClassLoader` 想达成的目标（隔离驱动），
 * 但手段完全不同：那边是靠类加载器隔离，这边是**操作系统级进程隔离**。
 */
export class DriverHostHandle {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<number, Pending>()
  readonly #onLog: (level: 'info' | 'warn' | 'error', message: string) => void
  #nextId = 1
  #stdoutBuffer = ''
  #closed = false
  readonly handshake: Promise<RpcHandshake>

  constructor(options: DriverHostOptions) {
    this.#onLog = options.onLog ?? (() => {})

    const script = resolveDriverHostScript()
    this.#child = spawn(process.execPath, [script, '--dialect', options.dialectId], {
      // ELECTRON_RUN_AS_NODE=1：让 Electron 二进制以纯 Node 身份运行子进程，
      // 这样宿主里可以正常使用 node:sqlite 等内置模块，且不必依赖用户装了系统 node。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    // 握手是构造后立刻就会到达的一帧，用它确认「这个进程是谁」。
    this.handshake = new Promise<RpcHandshake>((resolveHandshake, rejectHandshake) => {
      const timer = setTimeout(() => {
        rejectHandshake(new Error(`驱动宿主 ${options.dialectId} 在 10s 内未完成握手`))
      }, 10_000)
      this.#child.once('error', (err) => {
        clearTimeout(timer)
        rejectHandshake(err)
      })
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
      const text = chunk.trimEnd()
      if (text) this.#onLog('info', `[driver-host:${options.dialectId}] ${text}`)
    })

    // 关键：进程退出必须清算所有挂起请求，否则 UI 会永远转圈。
    this.#child.on('exit', (code, signal) => {
      this.#closed = true
      this.#failAllPending(
        new Error(`驱动宿主进程已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
      )
    })
  }

  #handshakeSettler: { resolve: (hs: RpcHandshake) => void; reject: (e: Error) => void } | null =
    null

  /** 逐行切分 stdout。TCP/管道不保证一次 data 就是完整一行，必须自己攒。 */
  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk
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
      p.reject(err)
    }
    this.#pending.clear()
  }

  /** 发一条 RPC 并等待响应。超时会主动失败，避免悬挂。 */
  request<T>(method: RpcMethod, params?: unknown): Promise<T> {
    return this.#requestWithTimeout<T>(method, params, RPC_TIMEOUT_MS)
  }

  /**
   * 带自定义超时的请求。
   *
   * 单独抽出来而不是给 `request` 加默认参数，是为了让**每个调用点都必须显式
   * 选择**用哪个超时。默认参数会被无意识地继承，结果就是某个新加的用户 SQL
   * 方法悄悄用了 15s；显式传参时这个选择至少会在 code review 里被看到。
   */
  #requestWithTimeout<T>(method: RpcMethod, params: unknown, timeoutMs: number): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error(`驱动宿主已关闭，无法调用 ${method}`))
    }
    const id = this.#nextId++
    const frame: RpcRequest = { id, method, params }
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rej(new Error(`驱动宿主调用 ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: res as (v: unknown) => void,
        reject: rej,
        timer,
        method
      })
      try {
        this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
      } catch (e) {
        clearTimeout(timer)
        this.#pending.delete(id)
        rej(e instanceof Error ? e : new Error(String(e)))
      }
    })
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
  cancelQuery(): Promise<boolean> {
    return this.#requestWithTimeout<boolean>('cancelQuery', {}, 10_000)
  }

  renameTable(nodeId: string, newName: string): Promise<void> {
    return this.#requestWithTimeout<void>(
      'renameTable',
      { nodeId, newName },
      RESULT_SET_TIMEOUT_MS
    )
  }

  /** 优雅关闭：先 disconnect，再关 stdin 让宿主自行退出；超时则强杀。 */
  async close(): Promise<void> {
    if (this.#closed) return
    try {
      await this.request<unknown>('disconnect')
    } catch {
      // 断开失败不影响后续退出流程，忽略。
    }
    await this.#endChild()
  }

  async #endChild(): Promise<void> {
    if (this.#closed) return
    const exited = new Promise<void>((res) => this.#child.once('exit', () => res()))
    try {
      this.#child.stdin.end()
    } catch {
      /* stdin 可能已关闭 */
    }
    const timeout = new Promise<void>((res) => setTimeout(res, SHUTDOWN_GRACE_MS))
    await Promise.race([exited, timeout])
    if (!this.#closed) {
      this.#child.kill('SIGTERM')
      this.#closed = true
    }
  }

  /** 强制回收（应用退出时兜底）。 */
  kill(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#child.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
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
  | 'deleteRows'
  | 'countRows'
  | 'fetchCellValue'
  | 'createTable'
  | 'dropTable'
  | 'createView'
  | 'dropView'
  | 'renameTable'
  | 'cancelQuery'
>

export type { DialectInfo }
