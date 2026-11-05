/**
 * 连接会话服务：活动会话的生命周期、连接令牌与凭据缓存。
 *
 * ===== 为什么从 ConnectionManager 里抽出来 =====
 *
 * `ConnectionManager` 同时承担四件事：保存配置的目录、活动会话的生命周期、
 * 结果集游标账本、传输/导入任务编排。连接目录（`connection-catalog`）已经
 * 接管了持久化配置，游标账本（`cursor-registry`）接管了游标作用域；
 * 本模块接管**会话状态**：
 *
 *   - 哪个连接当前有活着的宿主进程（`#connections`）；
 *   - 正在建立中的会话（`#connecting`，并发 connect 的幂等来源）；
 *   - 正在关闭中的会话（`#closing`，disconnect/remove 的幂等来源）；
 *   - 会话令牌（`#sessionTokens`）与本次会话内的凭据缓存（`#sessionSecrets`）；
 *   - 应用是否已进入 dispose（`#disposed`）。
 *
 * 这些状态的共同点是：它们的生命周期与**宿主进程**一致，而不是与磁盘配置一致。
 * 把它们放在一起，`ConnectionManager` 就不再需要在十几个方法里反复摸这些 Map。
 *
 * ===== 边界 =====
 *
 * 本模块**不** import electron、`src/drivers` 或任何具体 adapter：它只认识
 * `DriverHostHandle`（主进程里的宿主句柄）、纯类型与几个注入的回调。宿主进程
 * 内的驱动实现仍然只存在于 `src/driver-host`。
 *
 * `DriverHostHandle` 必须从 `../DriverHostHandle` 运行时导入（不能用 `import type`），
 * 因为会话建立时要真的 `new` 它；同时这保持了测试对
 * `DriverHostHandle.prototype` 打桩的模块身份——测试 patch 的是同一个类。
 *
 * 目录、游标、导入/导出任务都通过 `ConnectionSessionContext` 注入。这样本模块
 * 不需要反向依赖 ConnectionManager，也不会把 TransferManager / ImportManager
 * 的具体实现拖进来。
 */

import type { ConnectionSummary } from '../../core/api'
import type { SecretMap } from '../../core/driver'
import { DriverHostHandle } from '../DriverHostHandle'
import {
  describeThrown,
  type ConnectionLease,
  type ConnectionLogger,
  type DriverHostFactory,
  type LiveConnection,
  type SavedConnection
} from './types'

/**
 * 移除连接时「尽力回滚」的时限。
 *
 * 这个值刻意**远小于** RPC 的 60s：remove 是用户点了「删除连接」之后的动作，
 * 界面在原地等；若宿主正卡在一条慢 UPDATE 上，回滚 RPC 会排在它后面排 60s，
 * 那会让「删个连接」看起来像卡死。
 *
 * 超时放弃回滚并不等于数据有风险：宿主随后被关闭，数据库连接断开时
 * 未提交事务依然会被数据库回滚。这里只是把「显式、立刻的回滚」降级为
 * 「由连接关闭兜底的回滚」。
 */
const ROLLBACK_CLEANUP_TIMEOUT_MS = 3_000

/** 游标账本在本模块需要的最小能力。 */
export interface SessionCursorLedger {
  clearConnection(connectionId: string): void
}

/** 导入/导出任务组在本模块需要的最小能力。 */
export interface SessionTaskGroup {
  cancelByConnection(connectionId: string): unknown
  waitByConnection(connectionId: string): Promise<void>
}

/**
 * 会话服务的外部依赖。
 *
 * 全部用最小形状注入，避免本模块反向依赖目录与任务管理器的实现细节。
 */
export interface ConnectionSessionContext {
  /** 读取已保存配置。返回 undefined 表示配置不存在或已被删除。 */
  getSaved(connectionId: string): SavedConnection | undefined
  /** 读取磁盘上的（解密后）凭据。 */
  getSecret(connectionId: string): SecretMap | undefined
  /** 把「配置 + 可选会话」投影成 UI 契约里的摘要。 */
  summarize(saved: SavedConnection, live: LiveConnection | undefined): ConnectionSummary
  readonly cursors: SessionCursorLedger
  readonly transfers: SessionTaskGroup
  readonly imports: SessionTaskGroup
  readonly onLog: ConnectionLogger
  readonly createDriverHost?: DriverHostFactory
  /** 远程组合根提供 owner connection lease；未提供时为桌面单租户模式。 */
  readonly reserveConnection?: (connectionId: string) => ConnectionLease
}

interface ConnectingEntry {
  readonly host: DriverHostHandle
  readonly promise: Promise<ConnectionSummary>
}

export class ConnectionSessionService {
  /** 有活动会话（宿主进程活着）的连接。 */
  readonly #connections = new Map<string, LiveConnection>()
  readonly #connecting = new Map<string, ConnectingEntry>()
  readonly #closing = new Map<string, Promise<void>>()
  readonly #sessionTokens = new Map<string, object>()
  readonly #sessionSecrets = new Map<string, SecretMap>()
  readonly #connectionLeases = new Map<string, ConnectionLease>()
  #disposed = false

  readonly #ctx: ConnectionSessionContext

  constructor(context: ConnectionSessionContext) {
    this.#ctx = context
  }

  /** 应用是否已进入 dispose。上层公开方法据此拒绝新请求。 */
  get disposed(): boolean {
    return this.#disposed
  }

  /** 活着的会话数（诊断用）。 */
  get size(): number {
    return this.#connections.size
  }

  /** 取活动会话；没有则返回 undefined。 */
  get(connectionId: string): LiveConnection | undefined {
    return this.#connections.get(connectionId)
  }

  /** 该连接是否有正在进行的关闭流程。startImport 等在首个 await 前用它同步拒绝。 */
  isClosing(connectionId: string): boolean {
    return this.#closing.has(connectionId)
  }

  /**
   * 记住本次会话内的凭据。
   *
   * 用于「安全存储不可用、密码只保留在内存」的场景：配置照常落盘，
   * 密码只活到本次会话结束。断开/删除/宿主退出时都会清掉。
   */
  rememberSecret(connectionId: string, secret: SecretMap): void {
    this.#sessionSecrets.set(connectionId, secret)
  }

  /** 删除会话令牌与内存凭据。配置撤销后调用，防止清理期间被重新拉起或残留密码。 */
  forgetToken(connectionId: string): void {
    this.#sessionTokens.delete(connectionId)
    this.#sessionSecrets.delete(connectionId)
  }

  /**
   * 为已保存的连接建立会话。
   *
   * `saved` 由调用方在检查 disposed / 配置存在之后传入；这里只处理会话层
   * 的幂等：
   *
   *   - 若该连接正在关闭，先等关闭结束。关闭期间配置或令牌可能已经变了
   *     （用户删了又建、或旧会话被 replace），这时返回「未连接」而不是
   *     在旧对象上强行 spawn。
   *   - 已连、或已有在途连接时由 `#establishSession` 负责去重。
   */
  async connectSaved(
    connectionId: string,
    saved: SavedConnection
  ): Promise<ConnectionSummary> {
    if (this.#disposed) throw new Error('连接管理器已关闭')
    const token = this.#sessionTokens.get(connectionId)
    const closing = this.#closing.get(connectionId)
    if (closing) {
      await closing
      if (
        this.#disposed ||
        this.#ctx.getSaved(connectionId) !== saved ||
        this.#sessionTokens.get(connectionId) !== token
      ) {
        return this.#toSummary(saved, undefined)
      }
    }
    return this.#establishSession(connectionId)
  }

  /**
   * 建立（或复用）会话。**幂等**：已经连着时直接返回当前状态，不重复 spawn。
   * 理由是重复 spawn 会泄漏宿主进程（旧的没人关），而且用户连点两次
   * 按钮是很常见的操作。
   */
  #establishSession(connectionId: string): Promise<ConnectionSummary> {
    const saved = this.#ctx.getSaved(connectionId)
    if (!saved) return Promise.reject(new Error(`连接不存在: ${connectionId}`))
    const live = this.#connections.get(connectionId)
    if (live) return Promise.resolve(this.#toSummary(saved, live))
    const pending = this.#connecting.get(connectionId)
    if (pending) return pending.promise

    const token = {}
    this.#sessionTokens.set(connectionId, token)
    const lease = this.#ctx.reserveConnection?.(connectionId)
    if (lease) this.#connectionLeases.set(connectionId, lease)
    let host: DriverHostHandle
    try {
      host = (this.#ctx.createDriverHost ?? ((options) => new DriverHostHandle(options)))({
        dialectId: saved.config.dialectId,
        onLog: (level, msg) => this.#ctx.onLog(level, msg),
        onExit: (error) => {
          // 旧宿主的退出事件不能清掉已经重连的新会话。
          if (this.#connections.get(connectionId)?.host === host) {
            this.#connections.delete(connectionId)
            this.#ctx.cursors.clearConnection(connectionId)
            this.#sessionSecrets.delete(connectionId)
            this.#releaseConnectionLease(connectionId)
            this.#ctx.onLog(
              'error',
              `[manager] 连接 ${connectionId}（${saved.config.name}）的驱动宿主退出: ${error.message}`
            )
          } else if (this.#connecting.get(connectionId)?.host === host) {
            this.#sessionSecrets.delete(connectionId)
          }
        }
      })
    } catch (error) {
      // reserveConnection 先于 host 构造，构造失败时必须同步释放，否则
      // 下一次连接会被一个从未创建成功的会话占用 owner 配额。
      this.#releaseConnectionLease(connectionId)
      throw error
    }
    const promise = this.#connectHost(saved, host, token, lease).finally(() => {
      if (this.#connecting.get(connectionId)?.host === host) {
        this.#connecting.delete(connectionId)
      }
    })
    this.#connecting.set(connectionId, { host, promise })
    return promise
  }

  async #connectHost(
    saved: SavedConnection,
    host: DriverHostHandle,
    token: object,
    lease?: ConnectionLease
  ): Promise<ConnectionSummary> {
    const secret =
      this.#sessionSecrets.get(saved.id) ?? this.#ctx.getSecret(saved.id)
    try {
      await host.handshake
      const capabilities = await host.connect(saved.config, secret)
      if (
        host.closed ||
        this.#disposed ||
        this.#ctx.getSaved(saved.id) !== saved ||
        this.#sessionTokens.get(saved.id) !== token
      ) {
        host.kill()
        await host.close()
        this.#releaseConnectionLease(saved.id)
        return this.#toSummary(saved, undefined)
      }
      const live: LiveConnection = { ...saved, capabilities, host }
      this.#connections.set(saved.id, live)
      return this.#toSummary(saved, live)
    } catch (err) {
      this.#releaseConnectionLease(saved.id)
      host.kill()
      await host.close()
      this.#ctx.onLog(
        'warn',
        `[manager] 连接 ${saved.id}（${saved.config.name}）失败: ${describeThrown(err)}`
      )
      return this.#toSummary(saved, undefined)
    }
  }

  /**
   * 关闭会话但保留配置；同步失效旧会话，再等待回滚和子进程退出。
   *
   * 幂等：同一连接上重复调用返回同一个 closing promise。
   */
  stopSession(connectionId: string): Promise<void> {
    const existing = this.#closing.get(connectionId)
    if (existing) return existing

    this.#sessionTokens.set(connectionId, {})
    this.#sessionSecrets.delete(connectionId)
    this.#ctx.cursors.clearConnection(connectionId)
    /**
     * 导出与导入都先标记取消，但收尾顺序不同：
     *   - 导出先关宿主，让在途读取立刻失败，再等临时文件清理；
     *   - 导入必须等 ImportManager 自己回滚完，再走连接级清理，以免普通
     *     rollback 抢先结束导入事务。
     */
    this.#ctx.transfers.cancelByConnection(connectionId)
    this.#ctx.imports.cancelByConnection(connectionId)
    const pending = this.#connecting.get(connectionId)
    this.#connecting.delete(connectionId)
    const live = this.#connections.get(connectionId)
    pending?.host.kill()

    const closing = (async () => {
      if (pending) await pending.host.close()
      if (live) {
        /**
         * 导入事务归 ImportManager 所有。必须先让它看到取消并完成自己的
         * rollback，再做连接级清理；否则通用 rollback 可能先结束导入事务，
         * ImportManager 的回滚则会变成一次无主清理。
         *
         * 这里暂时保留 #connections 中的路由，正是为了让 ImportManager
         * 在收尾期间仍能解析到同一个宿主。
         */
        await this.#ctx.imports.waitByConnection(connectionId)
        if (this.#connections.get(connectionId) === live) {
          this.#connections.delete(connectionId)
        }
        await this.#rollbackQuietly(live)
        await live.host.close()
      } else {
        await this.#ctx.imports.waitByConnection(connectionId)
      }
      // 宿主已关（在途的读会被唤醒失败），这时才等导出任务真正收尾——
      // 顺序反过来会被一条慢查询卡住整个断连流程。
      await this.#ctx.transfers.waitByConnection(connectionId)
    })().finally(() => {
      this.#releaseConnectionLease(connectionId)
      if (this.#closing.get(connectionId) === closing) this.#closing.delete(connectionId)
    })
    this.#closing.set(connectionId, closing)
    return closing
  }

  /**
   * 应用退出时统一回收所有会话。
   *
   * 先同步置 disposed，让在途 connect 的结果作废；再逐个 stop，最后等所有
   * closing 完成并清空令牌/凭据缓存。导入导出任务的 dispose 由调用方在本方法
   * **之后**执行（它们要等宿主退出才可能被唤醒）。
   */
  async dispose(connectionIds: Iterable<string>): Promise<void> {
    this.#disposed = true
    await Promise.all([...connectionIds].map((id) => this.stopSession(id)))
    await Promise.all(this.#closing.values())
    this.#sessionTokens.clear()
    this.#sessionSecrets.clear()
  }

  #releaseConnectionLease(connectionId: string): void {
    const lease = this.#connectionLeases.get(connectionId)
    if (!lease) return
    this.#connectionLeases.delete(connectionId)
    lease.release()
  }

  #toSummary(
    saved: SavedConnection,
    live: LiveConnection | undefined
  ): ConnectionSummary {
    return this.#ctx.summarize(saved, live)
  }

  /**
   * 尽力回滚，永不抛错、永不长时间阻塞。
   *
   * 用 `ROLLBACK_CLEANUP_TIMEOUT_MS` 而不是 RPC 的 60s：这是**清理路径**，
   * 目标是「别留下半提交状态」，而不是「一定要等到回滚完成」。
   * 超时后仍然 close 宿主，进程退出时数据库连接断开，未提交事务依然会被回滚。
   */
  async #rollbackQuietly(conn: LiveConnection): Promise<void> {
    const rollback = conn.host.rollbackTransaction().catch((err: unknown) => {
      // 没有事务时某些驱动会报错，这属于正常情况，不该污染日志以外的地方。
      // 只读数据源（Redis / Kafka）根本没有事务语义，回滚必然是 unsupported_method：
      // 那不是异常，别用 warn 吓人，否则每次断开都刷一条“失败”。
      // 宿主回包只把 code 拼进 message（DriverHostHandle 不透出结构化的 code），
      // 所以这里两种形态都要认，否则 Redis/Kafka 每次断开仍会刷一条 warn。
      const code = (err as { code?: unknown } | null)?.code
      const text = describeThrown(err)
      if (
        code === 'unsupported_method' ||
        code === 'not_connected' ||
        /unsupported_method|not_connected/.test(text)
      ) {
        this.#ctx.onLog(
          'info',
          `[${conn.id}] 该数据源无事务语义，跳过回滚: ${describeThrown(err)}`
        )
        return
      }
      this.#ctx.onLog(
        'warn',
        `[${conn.id}] 移除连接前回滚事务失败（忽略）: ${describeThrown(err)}`
      )
    })
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((res) => {
      timer = setTimeout(res, ROLLBACK_CLEANUP_TIMEOUT_MS)
    })
    try {
      await Promise.race([rollback, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
