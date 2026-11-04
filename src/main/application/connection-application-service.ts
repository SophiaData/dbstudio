/**
 * 连接用例服务：连接配置的增删改查、连接/断开、测试连接与应用退出回收。
 *
 * ===== 为什么从 ConnectionManager 里抽出来 =====
 *
 * 经前面几轮拆分后，`ConnectionManager` 已把目录、会话、解析、活动守卫、
 * 查询、变更、元数据、比较、导出、导入分别委托出去。最后剩下的这一组方法
 * ——`listDialects` / `list` / `add` / `connectConnection` /
 * `disconnectConnection` / `remove` / `testConnection` / `disposeAll` /
 * `updateConnection` / `stats`——恰好是**连接自身的生命周期**：
 *
 *   1. **目录 + 会话的协同**：add / update / remove 都要同时改两侧状态，
 *      顺序错了就会留下「配置在、会话没了」或「会话在、配置没了」的分裂；
 *   2. **持久化与连通的顺序**：先落盘再连接，连接失败返回 `connected:false`
 *      而不是抛错；安全存储不可用时配置照存、密码只进本次会话缓存；
 *   3. **断开/删除的清理顺序**：先同步失效旧会话，再撤销配置/令牌/凭据，
 *      最后等待回滚与宿主退出；
 *   4. **退出回收**：先会话、后任务（任务要等宿主退出才可能被唤醒）。
 *
 * 把这些规则集中在本模块，`ConnectionManager` 就只剩构造组合与纯转发，
 * 连接生命周期可以被独立阅读与测试，不会因为查询/元数据的改动被牵连。
 *
 * ===== 边界 =====
 *
 * 本模块**不** import `ConnectionManager`、electron、`src/drivers` 或任何具体
 * adapter。它只认识：
 *
 *   - `ConnectionCatalog`：方言清单、已保存配置、id 序列与摘要投影；
 *   - `ConnectionSessionService`：宿主进程、令牌、在途连接与凭据缓存；
 *   - `CursorRegistry`：游标账本（stats 用）；
 *   - `TransferApplicationService` / `ImportApplicationService`：退出时收尾任务；
 *   - `ConnectionResolver`：updateConnection 的「已保存配置 + 可选会话」解析；
 *   - `ConnectionLogger`：统一日志出口。
 *
 * `DriverHostHandle` 必须从 `../DriverHostHandle` **运行时导入**（不能用
 * `import type`）：`testConnection` 要真的 `new` 一个独立宿主；同时这保持了
 * 测试对 `DriverHostHandle.prototype` 打桩的模块身份——测试 patch 的是同一个类。
 *
 * ===== 必须保持的语义与文案（全部有回归测试）=====
 *
 * 1. `listDialects()` 返回副本；`list()` 按保存顺序投影，活动会话只影响
 *    `connected` / `capabilities`；
 * 2. `add()` **先存配置/凭据再尝试连接**；未知方言文案逐字保留；安全存储
 *    不可用时配置仍保存、secret 进 session cache 并记 warn；连接失败返回
 *    `connected:false` 而不是抛错；
 * 3. `connectConnection()` 的 disposed / 不存在 / 幂等语义；
 * 4. `disconnectConnection()` 保留配置并返回 `disconnected` summary；
 * 5. `remove()` 先同步 `stopSession`，再撤销 catalog / token / credentials，
 *    最后等待 close；
 * 6. `testConnection()` 创建独立 host、handshake / testConnection、finally close；
 * 7. `disposeAll()` 先 `sessions.dispose`，再并行收尾 transfer / import；
 * 8. `updateConnection()` 的 resolveSaved、options 浅合并、方言 lookup、
 *    先存配置/合并 secrets、只有原本已连接才断开重连；
 * 9. `stats()` 的 `{ connections, openCursors }` 口径。
 */

import type { ConnectionSummary } from '../../core/api'
import type { ConnectionConfig } from '../../core/dialect'
import {
  validateRemoteConnectionConfig,
  type RemoteOutboundPolicy
} from '../../backend/contract/remote'
import type { DialectInfo, SecretInput, TestConnectionResult } from '../../core/driver'
import { isEmptySecret, mergeSecrets, normalizeSecret } from '../../core/driver'
import { DriverHostHandle } from '../DriverHostHandle'
import { SecretStorageUnavailableError } from '../ConnectionStore'
import type { ConnectionCatalog } from './connection-catalog'
import type { ConnectionResolver } from './connection-resolver'
import type { ConnectionSessionService } from './connection-session-service'
import type { CursorRegistry } from './cursor-registry'
import type { ImportApplicationService } from './import-application-service'
import type { TransferApplicationService } from './transfer-application-service'
import {
  describeThrown,
  type ConnectionLogger,
  type DriverHostFactory,
  type LiveConnection,
  type SavedConnection
} from './types'

/**
 * 连接用例服务的外部依赖。
 *
 * 全部是最小能力注入，而不是让服务反向持有 ConnectionManager：
 *   - `catalog` 负责持久化配置与摘要投影；
 *   - `sessions` 负责会话生命周期；
 *   - `cursors` 只用于 stats 的可观测口径；
 *   - `transfers` / `imports` 只用于 disposeAll 的任务收尾；
 *   - `resolver` 只用于 updateConnection 的配置/会话解析；
 *   - `onLog` 保持与拆分前完全一致的日志出口。
 */
export interface ConnectionApplicationContext {
  readonly catalog: ConnectionCatalog
  readonly sessions: ConnectionSessionService
  readonly cursors: CursorRegistry
  readonly transfers: TransferApplicationService
  readonly imports: ImportApplicationService
  readonly resolver: ConnectionResolver
  readonly onLog: ConnectionLogger
  readonly createDriverHost?: DriverHostFactory
  /** owner 组合根提供时，testConnection 使用一次性连接租约。 */
  readonly reserveConnection?: (connectionId: string) => { release(): void }
  /** 远程组合根显式注入后才启用连接目标校验；桌面端未配置时保持历史语义。 */
  readonly remoteOutboundPolicy?: RemoteOutboundPolicy
}

export class ConnectionApplicationService {
  readonly #ctx: ConnectionApplicationContext

  constructor(context: ConnectionApplicationContext) {
    this.#ctx = context
  }

  // -------------------------------------------------------------------------
  // 方言与配置清单
  // -------------------------------------------------------------------------

  listDialects(): DialectInfo[] {
    return this.#ctx.catalog.listDialects()
  }

  /**
   * 列出**所有已保存的连接**（含未连接的）。
   *
   * `capabilities` 只在有活动会话时非 null：能力是连上之后才知道的，
   * 未连接时给 null 而不是编一组默认值，这样 UI 不会误以为编辑能力可用。
   * 投影、保存顺序与 secretStored 判定都由目录负责；这里只提供活动会话。
   */
  list(): ConnectionSummary[] {
    return this.#ctx.catalog.list((connectionId) =>
      this.#ctx.sessions.get(connectionId)
    )
  }

  // -------------------------------------------------------------------------
  // 新建与连接
  // -------------------------------------------------------------------------

  /**
   * 新建连接：**先落盘，再尝试连通**（契约要求，也是正确的顺序）。
   *
   * ===== 为什么先存后连 =====
   *
   * 反过来的问题是：连上了但保存失败时，用户以为已经存了，重启后连接消失。
   * 而先存后连，最坏情况是"存了但连不上"——用户看得见它、能改参数重试。
   * 两种失败里后者可恢复，前者会让人丢失配置。
   *
   * ===== 连接失败不抛错（关键） =====
   *
   * 返回 `connected:false` 而不是 throw：UI 需要这个连接**留在列表里**
   * 让用户能改参数重试。如果抛错，调用方通常会把整条记录丢掉，
   * 那"先存后连"就没意义了。
   */
  async add(config: ConnectionConfig, secret?: SecretInput): Promise<ConnectionSummary> {
    this.#validateRemoteConfig(config)
    const { catalog, sessions } = this.#ctx
    if (sessions.disposed) throw new Error('连接管理器已关闭')
    const info = catalog.findDialect(config.dialectId)
    if (!info) {
      throw new Error(
        `未知方言 "${config.dialectId}"，可用方言: ${catalog.dialectIdsText()}`
      )
    }

    const id = catalog.nextConnectionId()

    // ---- 第一步：落盘（配置 + 凭据） ----
    // 保存密码可能因 cipher 不可用而抛 SecretStorageUnavailableError。
    // 这时**配置仍然要存下来**（配置没有保密需求），只放弃密码，
    // 并把这件事交给 UI 提示——绝不能因此连配置都不存。
    let secretError: unknown = null
    catalog.saveConnection(id, config)
    try {
      catalog.setSecret(id, secret)
    } catch (err) {
      secretError = err
      const temporary = normalizeSecret(secret)
      if (!isEmptySecret(temporary)) sessions.rememberSecret(id, temporary)
    }
    const saved: SavedConnection = { id, config, info }
    catalog.set(saved)
    this.#ctx.onLog(
      'info',
      `[manager] 已保存连接 ${id}（${config.name}）到磁盘${
        secretError instanceof SecretStorageUnavailableError ? '；密码未保存（安全存储不可用）' : ''
      }`
    )

    // ---- 第二步：尝试连通 ----
    const summary = await sessions.connectSaved(id, saved)
    // 密码保存失败时，把这件事"挂"在返回对象之外无法表达（ConnectionSummary 没这个字段），
    // 所以走日志 + 让 summary 反映真实连接结果。UI 侧通过 list() 看到 persisted=true。
    if (secretError !== null) {
      this.#ctx.onLog(
        'warn',
        `[manager] 连接 ${id} 的密码未能保存: ${describeThrown(secretError)}`
      )
    }
    return summary
  }

  /**
   * 为已保存的连接建立会话（`add` 之后的重连、或启动后用户点"连接"）。
   *
   * **幂等**：已经连着时直接返回当前状态，不重复 spawn。
   * 理由是重复 spawn 会泄漏宿主进程（旧的没人关），而且用户连点两次
   * 按钮是很常见的操作。
   */
  async connectConnection(connectionId: string): Promise<ConnectionSummary> {
    const { catalog, sessions } = this.#ctx
    if (sessions.disposed) throw new Error('连接管理器已关闭')
    const saved = catalog.get(connectionId)
    if (!saved) throw new Error(`连接不存在: ${connectionId}`)
    return sessions.connectSaved(connectionId, saved)
  }

  /** 关闭会话但保留配置；同步失效旧会话，再等待回滚和子进程退出。 */
  async disconnectConnection(connectionId: string): Promise<ConnectionSummary> {
    const { catalog, sessions } = this.#ctx
    const saved = catalog.get(connectionId)
    if (!saved) throw new Error(`连接不存在: ${connectionId}`)
    await sessions.stopSession(connectionId)
    return this.#toSummary(catalog.get(connectionId) ?? saved, undefined)
  }

  /**
   * 删除连接：配置与凭据一起撤销，并等待宿主退出。
   *
   * 顺序不能反：先同步 `stopSession`（立刻失效旧会话与令牌），再撤销
   * catalog 配置——避免清理期间被另一个 connect 重新拉起；然后显式
   * `forgetToken` 与删凭据，最后才 await 关闭。
   */
  async remove(connectionId: string): Promise<void> {
    const { catalog, sessions } = this.#ctx
    const closing = sessions.stopSession(connectionId)
    // 先撤销可连接的配置，避免清理期间被另一个 connect 重新拉起。
    catalog.delete(connectionId)
    sessions.forgetToken(connectionId)
    catalog.deleteConnection(connectionId)
    await closing
    this.#ctx.onLog('info', `[manager] 已删除连接 ${connectionId}（配置与凭据已清除）`)
  }

  /**
   * 测试连接：创建**独立**宿主，handshake 后执行 testConnection，finally 关闭。
   *
   * 不登记会话、不写目录、不碰游标账本——测试连接只是"问一次能不能连"，
   * 失败也要把宿主回收掉，否则每次点「测试」都会泄漏一个进程。
   */
  async testConnection(
    config: ConnectionConfig,
    secret?: SecretInput
  ): Promise<TestConnectionResult> {
    this.#validateRemoteConfig(config)
    const lease = this.#ctx.reserveConnection?.('__test__')
    const host = (this.#ctx.createDriverHost ?? ((options) => new DriverHostHandle(options)))({
      dialectId: config.dialectId
    })
    try {
      await host.handshake
      return await host.testConnection(config, secret)
    } finally {
      // 测试连接不留会话，务必回收宿主与临时 owner lease。
      await host.close()
      lease?.release()
    }
  }

  // -------------------------------------------------------------------------
  // 编辑连接
  // -------------------------------------------------------------------------

  /**
   * 编辑已保存的连接。
   *
   * ===== 三步，顺序不能反 =====
   *
   * 1. **先落盘新配置**（+ 密码若给了）。这样即使第 3 步重连失败，
   *    配置也已经更新——用户看到"连不上"但打开详情是最新参数，能改错重试。
   *    反过来先重连再落盘，重连失败会留下"内存里是新配置、磁盘是旧配置"的分裂。
   * 2. 若当前**有活动会话**，先关掉它（`disconnectConnection` 保留配置但关宿主）。
   * 3. 用新配置重连 —— **只有原本就连着的才自动重连**。原本断开的状态，
   *    更新后仍保持断开（尊重用户"我只是改个名字"的意图，不要擅自连库）。
   *
   * `Partial<ConnectionConfig>` 与现有配置合并：只覆盖传入的字段，
   * 未传的保留原值（尤其 `options` 要浅合并——用户可能只改 file 一个键）。
   */
  async updateConnection(
    connectionId: string,
    config: Partial<ConnectionConfig>,
    secret?: SecretInput
  ): Promise<ConnectionSummary> {
    const { catalog } = this.#ctx
    const { conn, saved } = this.#ctx.resolver.resolveSaved(connectionId)
    const wasConnected = conn !== undefined

    // ---- 合并配置 ----
    // options 必须**浅合并**而不是整体替换：UI 编辑表单可能只提交被改动的
    // 字段（比如只传 { file }），整体替换会把其它 option 丢掉。
    const mergedConfig: ConnectionConfig = {
      dialectId: config.dialectId ?? saved.config.dialectId,
      name: config.name ?? saved.config.name,
      options: { ...saved.config.options, ...(config.options ?? {}) }
    }
    this.#validateRemoteConfig(mergedConfig)

    // 方言若改了，要重新查 DialectInfo（previewTable/secretStored 依赖它）。
    const info = catalog.findDialect(mergedConfig.dialectId)
    if (!info) {
      throw new Error(
        `未知方言 "${mergedConfig.dialectId}"，可用方言: ${catalog.dialectIdsText()}`
      )
    }

    // 1) 落盘新配置；密码给了就一并更新（走 store 的加密通道）。
    catalog.saveConnection(connectionId, mergedConfig)
    if (secret !== undefined) {
      // setSecret 在 cipher 不可用时会抛 SecretStorageUnavailableError。
      // 这里**不吞**它：用户明确要改密码，存不了必须让他知道（否则又是一次
      // "以为存了其实没存"）。但配置已经落盘，不会白改。
      /*
       * 按 key 合并，而不是整体替换。
       *
       * 编辑连接时 UI 只提交“用户改动过的密钥”：改了 SSH 口令不该把数据库
       * 口令一起清掉。`mergeSecrets` 约定显式空串 = 删除该 key，undefined = 保留。
       */
      const existing = catalog.getSecret(connectionId) ?? {}
      const merged = mergeSecrets(existing, secret)
      catalog.setSecret(connectionId, isEmptySecret(merged) ? undefined : merged)
    }
    catalog.set({ id: connectionId, config: mergedConfig, info })
    this.#ctx.onLog(
      'info',
      `[manager] 已更新连接 ${connectionId}（${mergedConfig.name}）的配置`
    )

    // 2) 原本连着 → 先断（保留配置）。断开会回滚未提交事务并关宿主。
    if (wasConnected) {
      await this.disconnectConnection(connectionId)
    }

    // 3) 原本连着才重连，让新配置立刻生效。
    if (wasConnected) {
      return this.connectConnection(connectionId)
    }
    // 原本断开：不擅自连接，返回更新后的（未连接）summary。
    const after = catalog.get(connectionId)
    if (!after) throw new Error(`连接在更新过程中消失: ${connectionId}`)
    return this.#toSummary(after, undefined)
  }

  // -------------------------------------------------------------------------
  // 退出与诊断
  // -------------------------------------------------------------------------

  /** 应用退出时统一回收所有宿主进程。 */
  async disposeAll(): Promise<void> {
    const { catalog, sessions, transfers, imports } = this.#ctx
    // 先回收会话（宿主进程），再收尾任务：任务要等宿主退出才可能被唤醒。
    await sessions.dispose(catalog.keys())
    await Promise.all([transfers.dispose(), imports.dispose()])
  }

  /** 诊断用：当前连接数 / 游标账本条目数。让泄漏可以被观测而不是靠猜。 */
  stats(): { connections: number; openCursors: number } {
    return {
      connections: this.#ctx.sessions.size,
      openCursors: this.#ctx.cursors.count()
    }
  }

  #validateRemoteConfig(config: ConnectionConfig): void {
    const policy = this.#ctx.remoteOutboundPolicy
    if (!policy) return
    const result = validateRemoteConnectionConfig(config, policy)
    if (!result.ok) {
      const details = result.issues.map((issue) => `${issue.field || 'config'}: ${issue.message}`).join('; ')
      throw new Error(`远程连接配置被拒绝: ${details}`)
    }
  }

  #toSummary(saved: SavedConnection, live: LiveConnection | undefined): ConnectionSummary {
    return this.#ctx.catalog.summarize(saved, live)
  }
}
