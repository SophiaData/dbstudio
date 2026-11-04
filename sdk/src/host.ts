/**
 * 驱动宿主进程的客户端（SDK 主入口）。
 *
 * 这个类与仓库内 `src/main/DriverHostHandle.ts` 是同一套协议，但做了三处
 * 必要的「去 Electron 化」：
 *
 *   1. **宿主脚本路径可注入**。原版用 `__dirname` / `process.resourcesPath` 猜路径，
 *      那是打包应用的假设。SDK 不知道调用方把 driver-host 放哪，必须显式告知。
 *   2. **可执行文件可注入**。原版用 `process.execPath`（Electron 内置 Node）。
 *      SDK 默认用系统 node，也允许调用方换成别的（比如 Electron 场景下换回 Electron）。
 *   3. **不假设有 any GUI / app 生命周期**。纯 Node 语义，进程退出就退出。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'

import type { ConnectionConfig } from './contracts/dialect.js'
import type {
  DriverCapabilities,
  ObjectRef,
  TableDescription
} from './contracts/model.js'
import type {
  EditApplyResult,
  QueryOptions,
  QueryResult,
  ResultPage,
  RowUpdate,
  TransactionState,
  StatementResult
} from './contracts/resultset.js'
import type { TestConnectionResult } from './contracts/driver.js'
import type { SecretInput } from './contracts/driver.js'
import {
  DRIVER_API_VERSION,
  HANDSHAKE_PROTOCOL_VERSION,
  METADATA_SCHEMA_VERSION,
  SDK_CONTRACT_VERSION,
  TRANSFER_SCHEMA_VERSION,
  validateHandshake,
  type RpcHandshake
} from './contracts/driver.js'

/** 单条 RPC 的超时。元数据类操作毫秒级，结果集/写入可能几十秒，故分档。 */
const METADATA_TIMEOUT_MS = 15_000
const HEAVY_TIMEOUT_MS = 60_000

/**
 * 握手超时。
 *
 * 宿主启动后第一件事就是写 handshake 帧；10s 还没到只可能是脚本路径错、
 * 运行时起不来（例如 node 版本过低）或方言加载时卡死。
 * 不设这个上限，`connect()` 会一直等一个永远不会来的帧，调用方只能自己超时。
 */
const HANDSHAKE_TIMEOUT_MS = 10_000

export type DriverHostLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface DriverHostOptions {
  /** 方言 id，决定宿主进程加载哪个 adapter。 */
  readonly dialectId: string
  /**
   * 驱动宿主脚本的绝对路径。
   *
   * SDK 没有默认值——路径取决于调用方如何安装本包。
   * 通常做法：
   *   ```js
   *   import { createRequire } from 'node:module'
   *   const require = createRequire(import.meta.url)
   *   const hostScript = require.resolve('@sophiadata/dbstudio-sdk/driver-host/index.js')
   *   ```
   */
  readonly hostScript: string
  /**
   * 用哪个可执行文件启动宿主。默认 `process.execPath`（当前 Node）。
   *
   * 在 Electron 里调用时，想用 Electron 内置的 Node，可传 `process.execPath`
   * 并让 `env.ELECTRON_RUN_AS_NODE = 1`（本类会自动加，见下）。
   */
  readonly execPath?: string
  /** 额外环境变量。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 日志回调。宿主进程的 stderr 全部从这里出来。默认丢弃。 */
  readonly onLog?: (level: DriverHostLogLevel, message: string) => void
}

interface Pending {
  readonly resolve: (v: unknown) => void
  readonly reject: (e: Error) => void
  readonly timer: NodeJS.Timeout
}

/**
 * 一个驱动宿主进程的句柄。
 *
 * 生命周期：`new` 即启动 → `connect()` → 用 → `close()` 释放。
 * 忘记 `close()` 会留下僵尸子进程，所以推荐用 `using` 或 `finally`。
 */
export class DriverHost {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #dialectId: string
  readonly #pending = new Map<number, Pending>()
  readonly #onLog: (level: DriverHostLogLevel, message: string) => void
  #handshakeSettler: { resolve: (hs: RpcHandshake) => void; reject: (e: Error) => void } | null =
    null
  #nextId = 1
  #stdoutBuffer = ''
  #closed = false
  /**
   * 导致宿主不可用的首个错误（握手不兼容 / 进程退出）。
   *
   * 保留它而不是只留一句「已关闭」：调用方在握手失败后往往还会调用
   * `connect()`，此时应看到真正的原因（带 code 的 HandshakeValidationError），
   * 而不是一个把根因盖掉的泛化错误。
   */
  #fatalError: Error | null = null
  /**
   * 宿主握手 Promise。
   *
   * 与主进程的 `DriverHostHandle.handshake` 同一语义：resolve 之前宿主不可用。
   * SDK 的每个 RPC 都会先 await 它，因此「方言不匹配 / 版本不兼容」会在
   * **第一条业务请求之前**以可诊断的错误抛出，而不是在某个深层调用里
   * 变成 `undefined is not a function`。
   */
  readonly handshake: Promise<RpcHandshake>

  constructor(options: DriverHostOptions) {
    if (!existsSync(options.hostScript)) {
      throw new Error(
        `驱动宿主脚本不存在: ${options.hostScript}\n` +
          `请确认路径正确。若通过 npm 安装本包，可用\n` +
          `  require.resolve('@sophiadata/dbstudio-sdk/driver-host/index.js')\n` +
          `取得绝对路径。`
      )
    }
    this.#onLog = options.onLog ?? (() => {})
    this.#dialectId = options.dialectId

    const execPath = options.execPath ?? process.execPath
    const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) }
    // 若用的是 Electron 可执行文件，需要这个开关让它以纯 Node 身份运行。
    if (/electron/i.test(execPath)) {
      env['ELECTRON_RUN_AS_NODE'] = '1'
    }

    this.#child = spawn(execPath, [options.hostScript, '--dialect', options.dialectId], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    // 握手 Promise 必须在挂 stdout 监听之前建好并安装 settler：
    // 子进程可能在构造函数的同一 tick 内就写出 handshake 帧。
    this.handshake = new Promise<RpcHandshake>((resolveHandshake, rejectHandshake) => {
      const timer = setTimeout(() => {
        this.#failHandshake(
          new Error(
            `驱动宿主 ${options.dialectId} 在 ${HANDSHAKE_TIMEOUT_MS}ms 内未完成握手` +
              `（pid=${this.#child.pid ?? 'unknown'}）。请检查宿主脚本路径与 Node 版本。`
          )
        )
        this.kill()
      }, HANDSHAKE_TIMEOUT_MS)
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
    // 调用方不一定 await handshake。空 catch 避免 unhandledRejection；
    // 真正 await 它的调用方仍然会收到拒绝。
    void this.handshake.catch(() => undefined)

    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk: string) => this.#onStdout(chunk))

    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (chunk: string) => {
      const text = String(chunk).trimEnd()
      if (text) this.#onLog('info', text)
    })

    // 关键：进程退出必须清算所有挂起请求，否则调用方会永远 await 不到结果。
    this.#child.on('exit', (code, signal) => {
      this.#closed = true
      this.#failAllPending(
        new Error(`驱动宿主进程已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
      )
    })
    this.#child.on('error', (err) => {
      this.#closed = true
      this.#failAllPending(err)
    })
  }

  /** 宿主进程 pid，便于排查。 */
  get pid(): number | undefined {
    return this.#child.pid
  }

  /** 逐行切分 stdout——管道不保证一次 data 就是完整一行。 */
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
        this.#onLog('warn', `stdout 出现非协议内容: ${line.slice(0, 200)}`)
        continue
      }
      const f = frame as { id?: unknown; kind?: unknown; level?: string; message?: string }
      if (typeof f.id === 'number') {
        this.#settle(f as { id: number; ok?: boolean; result?: unknown; error?: { message?: string } })
      } else if (f.kind === 'handshake') {
        this.#acceptHandshake(f)
      } else if (f.kind === 'log') {
        this.#onLog((f.level as DriverHostLogLevel) ?? 'info', String(f.message ?? ''))
      }
    }
  }

  /**
   * 校验握手帧并结算 `handshake` Promise。
   *
   * 版本/方言不匹配时**拒绝握手并杀掉子进程**：不匹配的宿主即使还能回帧，
   * 它的方法集与返回结构也不可信，继续使用只会把错误推迟到更难排查的位置。
   */
  #acceptHandshake(frame: unknown): void {
    try {
      const validated = validateHandshake(frame, {
        dialectId: this.#dialectId,
        protocolVersion: HANDSHAKE_PROTOCOL_VERSION,
        driverApiVersion: DRIVER_API_VERSION,
        metadataSchemaVersion: METADATA_SCHEMA_VERSION,
        transferSchemaVersion: TRANSFER_SCHEMA_VERSION,
        sdkContractVersion: SDK_CONTRACT_VERSION
      })
      for (const warning of validated.warnings) {
        this.#onLog('warn', `[driver-host:${this.#dialectId}] ${warning}`)
      }
      this.#onLog(
        'debug',
        `宿主就绪（方言 ${validated.handshake.dialectId}，driverApi=${String(
          validated.handshake.driverApiVersion ?? 'legacy'
        )}）`
      )
      this.#handshakeSettler?.resolve(validated.handshake)
      this.#handshakeSettler = null
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      failure.message = `${failure.message}（pid=${this.#child.pid ?? 'unknown'}）`
      this.#failHandshake(failure)
      this.kill()
    }
  }

  #failHandshake(error: Error): void {
    // 首个错误才是根因（例如握手不兼容）；后续进程退出错误只作为补充。
    if (this.#fatalError === null) this.#fatalError = error
    const settler = this.#handshakeSettler
    this.#handshakeSettler = null
    settler?.reject(error)
  }

  #settle(res: { id: number; ok?: boolean; result?: unknown; error?: { message?: string } }): void {
    const p = this.#pending.get(res.id)
    if (!p) return
    this.#pending.delete(res.id)
    clearTimeout(p.timer)
    if (res.ok) p.resolve(res.result)
    else p.reject(new Error(res.error?.message ?? 'RPC 失败'))
  }

  #failAllPending(err: Error): void {
    this.#failHandshake(err)
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.#pending.clear()
  }

  async #request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.#closed) {
      throw this.#fatalError ?? new Error(`驱动宿主已关闭，无法调用 ${method}`)
    }
    // 除 disconnect 外的所有请求都必须等握手成功。握手失败时这里会抛，
    // 且**不会**把业务请求写进一个方言/版本不可信的进程。
    // disconnect 跳过是为了让 close() 在握手失败时仍能清理。
    if (method !== 'disconnect') await this.handshake
    if (this.#closed) {
      throw this.#fatalError ?? new Error(`驱动宿主已关闭，无法调用 ${method}`)
    }
    const id = this.#nextId++
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rej(new Error(`调用 ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.#pending.set(id, { resolve: res as (v: unknown) => void, reject: rej, timer })
      try {
        this.#child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      } catch (e) {
        clearTimeout(timer)
        this.#pending.delete(id)
        rej(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  // ---- 语义化 API ----

  /** 建立连接并返回能力声明。 */
  connect(config: ConnectionConfig, secret?: SecretInput): Promise<DriverCapabilities> {
    return this.#request<DriverCapabilities>('connect', { config, secret }, METADATA_TIMEOUT_MS)
  }

  /** 只测连，不保留连接。 */
  testConnection(config: ConnectionConfig, secret?: SecretInput): Promise<TestConnectionResult> {
    return this.#request<TestConnectionResult>('testConnection', { config, secret }, HEAVY_TIMEOUT_MS)
  }

  /** 列直接子节点（懒加载的唯一入口）。 */
  listChildren(parentId: string | null): Promise<ObjectRef[]> {
    return this.#request<ObjectRef[]>('listChildren', { parentId }, METADATA_TIMEOUT_MS)
  }

  /** 读表结构（列 + 唯一键判定）。 */
  describeTable(id: string): Promise<TableDescription> {
    return this.#request<TableDescription>('describeTable', { id }, METADATA_TIMEOUT_MS)
  }

  /** 执行 SQL，返回第一页（带 cursorId）。 */
  query(sql: string, options?: QueryOptions): Promise<QueryResult> {
    return this.#request<QueryResult>('query', { sql, options }, HEAVY_TIMEOUT_MS)
  }

  /** 执行语句（查询、DML 或 DDL）。 */
  executeStatement(sql: string, options?: QueryOptions): Promise<StatementResult> {
    return this.#request<StatementResult>('executeStatement', { sql, options }, HEAVY_TIMEOUT_MS)
  }

  /** 从游标按偏移量取一页（支持乱序）。 */
  fetchResultPage(cursorId: string, offset: number, limit: number): Promise<ResultPage> {
    return this.#request<ResultPage>('fetchResultPage', { cursorId, offset, limit }, HEAVY_TIMEOUT_MS)
  }

  /** 释放游标。 */
  closeCursor(cursorId: string): Promise<void> {
    return this.#request<void>('closeCursor', { cursorId }, METADATA_TIMEOUT_MS)
  }

  /** 应用行更新（参数化 UPDATE，不自动提交）。 */
  applyEdits(tableId: string, updates: readonly RowUpdate[]): Promise<EditApplyResult> {
    return this.#request<EditApplyResult>('applyEdits', { tableId, updates }, HEAVY_TIMEOUT_MS)
  }

  /** 提交事务。 */
  commitTransaction(): Promise<TransactionState> {
    return this.#request<TransactionState>('commitTransaction', undefined, HEAVY_TIMEOUT_MS)
  }

  /** 回滚事务（幂等）。 */
  rollbackTransaction(): Promise<TransactionState> {
    return this.#request<TransactionState>('rollbackTransaction', undefined, HEAVY_TIMEOUT_MS)
  }

  /** 查询事务状态。 */
  transactionState(): Promise<TransactionState> {
    return this.#request<TransactionState>('transactionState', undefined, METADATA_TIMEOUT_MS)
  }

  /** 关闭：先 disconnect，再关 stdin 让宿主自行退出；超时则强杀。 */
  async close(): Promise<void> {
    if (this.#closed) return
    try {
      await this.#request<unknown>('disconnect', undefined, 5_000)
    } catch {
      /* 断开失败不影响退出 */
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
    const timeout = new Promise<void>((res) => setTimeout(res, 3_000))
    await Promise.race([exited, timeout])
    if (!this.#closed) {
      this.#child.kill('SIGTERM')
      this.#closed = true
    }
  }

  /** 强制回收。 */
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

/** 便捷函数：临时起一个宿主、跑一件事、确保回收。 */
export async function withDriverHost<T>(
  options: DriverHostOptions,
  fn: (host: DriverHost) => Promise<T>
): Promise<T> {
  const host = new DriverHost(options)
  try {
    return await fn(host)
  } finally {
    await host.close()
  }
}

