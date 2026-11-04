/**
 * 连接目录：方言清单、已保存配置、id 序列与摘要投影。
 *
 * ===== 为什么从 ConnectionManager 里抽出来 =====
 *
 * `ConnectionManager` 同时承担四件事：保存配置的目录、活动会话的生命周期、
 * 结果集游标账本、传输/导入任务编排。前两件又互相纠缠（summary 需要同时看
 * 配置与会话），但它们的状态边界其实很清楚：
 *
 *   - 目录状态（方言、已保存配置、id 序列）只依赖 `ConnectionStore`；
 *   - 会话状态（宿主进程、令牌、在途连接）只依赖 `DriverHostHandle`。
 *
 * 本模块接管前者。这样 `list()` / `listDialects()` / `stats()` 不再直接摸
 * ConnectionManager 的私有字段，后续可以把 `add` / `update` 的持久化步骤
 * 逐步搬到这里，而不必再改一次公开契约。
 *
 * ===== 鸭子存储兼容 =====
 *
 * 构造期**只调用 `listConnections()`**。`tests/e2e-import-preview.mjs` 用
 * `{ listConnections: () => [] }` 构造 ConnectionManager，只测 CSV 预览；
 * 它在任何路径上都不会调用写方法或读凭据。因此这里把后几项声明为可选，
 * 读到缺失的凭据按"没有"处理；写操作若被真正调用则抛出明确的错误，
 * 而不是静默成功。
 */

import type { ConnectionSummary } from '../../core/api'
import type { ConnectionConfig } from '../../core/dialect'
import type { DialectInfo, SecretInput, SecretMap } from '../../core/driver'
import type { DriverCapabilities } from '../../core/model'
import {
  connectionIdSequence,
  makeConnectionId,
  type ConnectionLogger,
  type LiveConnection,
  type SavedConnection
} from './types'

/** store 里一条连接配置的最小形态。与 ConnectionStore.StoredConnection 结构一致。 */
export interface StoredConnectionLike {
  readonly id: string
  readonly config: ConnectionConfig
}

/**
 * 目录需要的存储能力。
 *
 * 只有 `listConnections()` 是构造期必需的；其余方法在逐步委托时使用。
 * 声明为可选是为了兼容纯预览测试里的鸭子 store。
 */
export interface ConnectionCatalogStore {
  listConnections(): readonly StoredConnectionLike[]
  getSecret?(id: string): SecretMap | undefined
  saveConnection?(id: string, config: ConnectionConfig): void
  setSecret?(id: string, input: SecretInput): void
  deleteConnection?(id: string): void
}

/** 会话里目录关心的部分。用最小形状表达，避免目录反向依赖宿主细节。 */
export interface LiveCapabilitiesView {
  readonly capabilities: DriverCapabilities
}

export class ConnectionCatalog {
  readonly #dialects: readonly DialectInfo[]
  readonly #store: ConnectionCatalogStore
  readonly #onLog: ConnectionLogger

  /**
   * 已保存的配置（含没有会话的）。
   *
   * 与 ConnectionManager 的活动会话 Map 分开存：两者生命周期不同
   * （配置长存、会话可断可连），混在一起会让每个读会话的地方都要先判空，
   * 且很容易在"断开时忘了保留配置"上出错。
   */
  readonly #saved = new Map<string, SavedConnection>()

  #seq = 0

  constructor(
    dialects: readonly DialectInfo[],
    store: ConnectionCatalogStore,
    onLog: ConnectionLogger = () => {}
  ) {
    this.#dialects = dialects
    this.#store = store
    this.#onLog = onLog
    this.#loadPersisted()
  }

  // -------------------------------------------------------------------------
  // 方言
  // -------------------------------------------------------------------------

  /** 返回副本：调用方拿到的数组不该能反向影响目录。 */
  listDialects(): DialectInfo[] {
    return [...this.#dialects]
  }

  findDialect(dialectId: string): DialectInfo | undefined {
    return this.#dialects.find((dialect) => dialect.id === dialectId)
  }

  /** 未知方言错误里用的可用清单，保持 ConnectionManager 原有文案。 */
  dialectIdsText(): string {
    return this.#dialects.map((dialect) => dialect.id).join(', ')
  }

  // -------------------------------------------------------------------------
  // 已保存配置
  // -------------------------------------------------------------------------

  get(connectionId: string): SavedConnection | undefined {
    return this.#saved.get(connectionId)
  }

  set(saved: SavedConnection): void {
    this.#saved.set(saved.id, saved)
  }

  delete(connectionId: string): void {
    this.#saved.delete(connectionId)
  }

  values(): IterableIterator<SavedConnection> {
    return this.#saved.values()
  }

  keys(): IterableIterator<string> {
    return this.#saved.keys()
  }

  /** 生成下一个短连接 id（`c1`、`c2`…），并推进序列。 */
  nextConnectionId(): string {
    return makeConnectionId(++this.#seq)
  }

  /**
   * 从磁盘载入配置。**载入不等于连接**。
   *
   * 只把配置装进内存；会话由用户显式 `connectConnection` 或展开树时按需建立。
   * `list()` 里 `connected:false` 是正常状态，不是错误。
   */
  #loadPersisted(): void {
    for (const stored of this.#store.listConnections()) {
      const info = this.findDialect(stored.config.dialectId)
      if (!info) {
        // 配置里存着一个当前版本不认识的方言（比如驱动被移除了）。
        // 不删用户的配置——保留，只是无法连接。UI 会显示为不可用。
        this.#onLog(
          'warn',
          `[manager] 已保存的连接 ${stored.id} 使用了未知方言 "${stored.config.dialectId}"，已保留配置但不可连接`
        )
        continue
      }
      this.#saved.set(stored.id, { id: stored.id, config: stored.config, info })
      // 让序号越过已存在的 id（c1/c2…），避免新建时撞车。
      this.#bumpSeqFrom(stored.id)
    }
  }

  /** 保证 `#seq` 不会与已载入的 id 冲突。 */
  #bumpSeqFrom(id: string): void {
    const n = connectionIdSequence(id)
    if (n !== null && n > this.#seq) this.#seq = n
  }

  // -------------------------------------------------------------------------
  // 摘要投影与凭据状态
  // -------------------------------------------------------------------------

  /**
   * 判断某连接密码（凭据）的保存状态。**唯一的判定出口**。
   *
   * ===== 三态的语义（与 core/api.ts 的注释对齐） =====
   *
   *   null  → 该方言本就不需要密码（SQLite 是文件库，没 password 字段）
   *   true  → 需要密码且密文确实存下来了
   *   false → 需要密码但没存成（典型原因：safeStorage 不可用，我们拒绝存明文）
   *
   * 集中一处，避免 list() / add() / connect() / disconnect() / listChildren()
   * 各写一遍后出现"列表里显示已保存、树里显示未保存"这种自相矛盾的 UI。
   */
  secretStoredFor(saved: SavedConnection): boolean | null {
    // 1. 方言声明了 password 字段吗？没有 → 这个连接不需要密码，返回 null。
    //    注意看的是**方言的字段声明**，而不是"这次 add 有没有传 secret"。
    const needsPassword = saved.info.fields.some((field) => field.kind === 'password')
    if (!needsPassword) return null

    /*
     * 2. 需要密码：必须真的能解出**数据库口令**才算存了。
     *
     * 只看 hasSecret() 不够：一个连接可能只存了 SSH 口令、数据库口令为空，
     * 此时磁盘上有密文，UI 却会显示"密码已保存"，重启后依然连不上数据库。
     */
    if (this.getSecret(saved.id)?.dbPassword !== undefined) return true

    // 3. 需要密码但没有密文 → false。
    return false
  }

  /** 把一条配置（+ 可选会话）投影成 UI 契约里的 ConnectionSummary。 */
  summarize(
    saved: SavedConnection,
    live: LiveConnection | LiveCapabilitiesView | undefined
  ): ConnectionSummary {
    return {
      id: saved.id,
      name: saved.config.name,
      dialectId: saved.config.dialectId,
      connected: live !== undefined,
      capabilities: live?.capabilities ?? null,
      persisted: true,
      secretStored: this.secretStoredFor(saved),
      // 编辑连接时要把原配置回填到表单，没有这个字段用户就是"盲改"。
      options: { ...saved.config.options }
    }
  }

  /**
   * 按保存顺序列出所有已保存连接。
   *
   * `liveFor` 由 ConnectionManager 提供：目录不持有活动会话，只负责把
   * 会话能力投影进摘要，避免把宿主进程的知识搬进本模块。
   */
  list(
    liveFor: (connectionId: string) => LiveConnection | LiveCapabilitiesView | undefined
  ): ConnectionSummary[] {
    const out: ConnectionSummary[] = []
    for (const saved of this.#saved.values()) {
      out.push(this.summarize(saved, liveFor(saved.id)))
    }
    return out
  }

  // -------------------------------------------------------------------------
  // 存储委托（逐步迁移用）
  // -------------------------------------------------------------------------

  getSecret(connectionId: string): SecretMap | undefined {
    return this.#store.getSecret?.(connectionId)
  }

  saveConnection(connectionId: string, config: ConnectionConfig): void {
    this.#requireStore('saveConnection').saveConnection(connectionId, config)
  }

  setSecret(connectionId: string, input: SecretInput): void {
    this.#requireStore('setSecret').setSecret(connectionId, input)
  }

  deleteConnection(connectionId: string): void {
    this.#requireStore('deleteConnection').deleteConnection(connectionId)
  }

  #requireStore<K extends 'saveConnection' | 'setSecret' | 'deleteConnection'>(
    method: K
  ): ConnectionCatalogStore & Required<Pick<ConnectionCatalogStore, K>> {
    if (typeof this.#store[method] !== 'function') {
      throw new Error(`当前连接存储不支持 ${method}()，无法完成该操作`)
    }
    return this.#store as ConnectionCatalogStore & Required<Pick<ConnectionCatalogStore, K>>
  }
}
