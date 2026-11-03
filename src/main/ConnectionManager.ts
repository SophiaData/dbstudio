/**
 * 连接管理器（主进程）。
 *
 * 对应 DBeaver 的 `DataSourceSerializer` + `DataSourceProviderRegistry` 那一层，
 * 但我们只保留真正需要的两件事：**连接的生命周期**与**节点 id 的作用域封装**。
 *
 * ===== 设计要点：id 作用域 =====
 *
 * adapter 只保证「同一连接内 id 唯一」（比如 SQLite 里只有一个 `table:users`）。
 * 但树里同时挂着多个连接，如果直接把 adapter 的 id 交给 UI，两个连接下的
 * 同名表就会撞在一起，展开一个另一个也跟着变。
 *
 * 所以主进程在这里做一次**统一的作用域封装**：出站时把 `table:users`
 * 包成 `connection:<cid>|table:users`，入站时再拆回去。
 * 规则只在 `core/api.ts` 的 `NodeId` 里定义一次，UI 与测试共用同一套。
 */

import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import {
  compareDataRows,
  type CompareDialect,
  type DataCompareRequest,
  type DataCompareResult,
  type DataCompareRow,
  type RoutineDefinition,
  type SchemaSnapshot,
  type SnapshotTable
} from '../core/compare'
import { previewCsv } from '../core/csv'
import type { ConnectionConfig } from '../core/dialect'
import type { DialectInfo, SecretInput, SecretMap, TestConnectionResult } from '../core/driver'
import { isEmptySecret, mergeSecrets, normalizeSecret, quoteIdentifierWith } from '../core/driver'
import { NodeId, type ConnectionSummary } from '../core/api'
import type { DriverCapabilities, ObjectRef, TableCreateSpec, TableDescription } from '../core/model'
import type {
  CellValue,
  EditApplyResult,
  ExplainResult,
  QueryOptions,
  QueryResult,
  ResultPage,
  RowUpdate,
  TransactionState,
  StatementResult
} from '../core/resultset'
import { DriverHostHandle } from './DriverHostHandle'
import { ConnectionStore, SecretStorageUnavailableError } from './ConnectionStore'
import { ImportManager } from './ImportManager'
import { TransferManager } from './TransferManager'
import type {
  ImportBatch,
  ImportBatchResult,
  ImportPreview,
  ImportPreviewRequest,
  ImportProgress,
  ImportRequest,
  ImportResult,
  TransferProgress,
  TransferRequest,
  TransferResult,
  TransferSource,
  TransferSourceHandle
} from '../core/transfer'

/**
 * ===== 为什么主进程这里**不** import 任何驱动目录 =====
 *
 * 早先 `previewTable` 需要 `quoteIdentifier` 来安全拼表名，而 `DialectInfo`
 * 里没有任何语法能力，于是只能在主进程 import 驱动的 dialect 模块。
 * 那条路哪怕只 import 纯语法也会留一个后门：`src/drivers/<x>/dialect.ts`
 * 和 `adapter.ts` 在同一个目录下，后人顺手就能把 adapter 也 import 进来，
 * 进程隔离就名存实亡了。
 *
 * 现在 `DialectInfo.quoting`（纯数据，可序列化）由注册表带出来，
 * `quoteIdentifierWith` 又在 core 里统一实现，所以主进程只需拼字符串——
 * **依赖方向上不再有任何一条边从 main 指向 drivers**。
 *
 * 顺带因此删掉了「方言 → 分页子句」的对照表：`previewTable` 只生成
 * `SELECT * FROM <quoted>`，把行数限制交给 `QueryOptions.limit`，
 * 由 adapter（唯一懂自己分页语法的那个）去落实。主进程不再猜 SQL 方言。
 */

interface LiveConnection {
  readonly id: string
  readonly config: ConnectionConfig
  readonly capabilities: DriverCapabilities
  readonly host: DriverHostHandle
  /**
   * 该连接的方言展示信息。
   *
   * `previewTable` 用它取 `quoting` 规则。存成字段而不是每次回 `#dialects`
   * 线性查一遍：方言清单构造后不可变，而查询是热路径，存一份更直白也更快。
   */
  readonly info: DialectInfo
}

/**
 * 已保存但**没有活动会话**的连接。
 *
 * 为什么需要这个类型：加入持久化后，"有配置"与"有会话"是两件独立的事。
 * 启动时我们载入所有配置但不连接（见 `#loadPersisted`），因此大部分连接
 * 在任意时刻都只是"一条配置"。把它和 `LiveConnection` 分开，
 * 能让"要不要 spawn 宿主"这件事由类型系统提醒——拿到 SavedConnection
 * 却想调 host 会立刻编译失败，而不是运行时空指针。
 */
interface SavedConnection {
  readonly id: string
  readonly config: ConnectionConfig
  readonly info: DialectInfo
}

/** 生成短连接 id。只需要本会话内唯一，不必是 UUID。 */
function makeConnectionId(seq: number): string {
  return `c${seq}`
}

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

/**
 * 路径归一化：把"同一个文件的多种写法"折叠成同一个字符串。
 *
 * ===== 两条规则，缺一不可 =====
 *
 * 1. **文件本身存在时**：用 `realpathSync(absolute)`。
 *    这能解开**文件级符号链接**——例如配置的库路径是 `alias.db`
 *    （指向 `real.db` 的符号链接），而导出目标是 `real.db`。
 *    只归一化父目录会漏掉这一例：父目录相同、文件名不同，
 *    但它们**其实是同一个文件**。
 *
 * 2. **文件不存在时**（导出目标本来就还不存在）：
 *    退回到 `realpath(父目录) + 文件名`。父目录的符号链接仍要解开
 *    （macOS 上 `/var` 是 `/private/var` 的符号链接）。
 *    文件名部分保持原样——它还不存在，没有 realpath 可取。
 *
 * 库文件路径与导出目标路径**用同一条规则**，
 * 否则两侧的归一化结果不可比，比较就失去意义。
 */
function normalizeFsPath(target: string): string {
  const absolute = resolve(target)
  try {
    return realpathSync(absolute)
  } catch {
    const parent = dirname(absolute)
    try {
      return join(realpathSync(parent), basename(absolute))
    } catch {
      return absolute
    }
  }
}

/** 从任意异常里取一句可读信息。 */
function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 游标 id 的作用域封装。
 *
 * ===== 问题：cursorId 是「进程内局部变量」，而主进程要跨连接找宿主 =====
 *
 * adapter 生成的 cursorId（如 `cur-3`）只在**生成它的那个宿主进程**里有意义。
 * 另一个宿主进程可能也生成了 `cur-3`，指向完全不同的结果集。
 * 而 `fetchResultPage(cursorId)` 进来时，主进程手上只有一个字符串，
 * 它必须先回答「这是哪个连接的游标」才能转发。
 *
 * ===== 两个方案与取舍 =====
 *
 * (a) 给 cursorId 加连接前缀（本实现）：`connection:c1|cur-3`
 * (b) 主进程维护 `Map<cursorId, connectionId>`
 *
 * 选 (a)，理由三条：
 *
 * 1. **无状态**。(b) 的映射表是主进程里一份额外的可变状态：进程重启、连接重建、
 *    或者某处忘了删除，都会留下脏条目。而 (a) 的信息完全编码在字符串本身，
 *    不存在「表和实际游标不同步」这种状态。
 * 2. **复用已验证的规则**。`NodeId` 已经用同一套 `connection:<cid>|<payload>`
 *    解决了完全同构的问题（节点 id 的作用域），并且 `core/api.ts` 里写明
 *    「规则只定义一次，UI 与测试共用」。游标是同一类问题，用同一套规则，
 *    读代码的人不用再学第二种编码。
 * 3. **失败可辨识**。传进来的 cursorId 若不带前缀（比如 UI 把原生 id 直接回传），
 *    (a) 能在本地立刻判定「这不是我给出去的 id」并报错；
 *    (b) 只会在映射表里查不到，报出的错误与「游标已被关闭」无法区分。
 *
 * (b) 唯一比 (a) 强的地方是「Cursor 里能塞进前缀不允许的字符」——
 * 但我们的前缀用 `|` 分隔，宿主侧的 id 只要不含 `|` 就安全；
 * 且这里**只用 NodeId 的解析能力**，编码本身不改动游标内容。
 *
 * ===== 注意对 UI 的影响（重要） =====
 *
 * 一旦加了前缀，`QueryResult.cursorId` 与 adapter 的原生 id **不再是同一个字符串**。
 * 所以 `runQuery` 返回前必须重新包装、`fetchResultPage`/`closeCursor` 入参必须还原。
 * UI 只需要把它当**不透明字符串**存着再传回来，不该尝试解析它。
 */
const CursorId = {
  /** 把 adapter 的原生游标 id 包上连接归属，交给 UI。 */
  scope(connectionId: string, rawCursorId: string): string {
    return NodeId.scoped(connectionId, rawCursorId)
  },
  /**
   * 还原成 adapter 的原生 id。
   *
   * 返回 null 表示这个字符串不是本层发出去的（格式不对），
   * 由调用方决定怎么报错——而不是在这里抛，因为两种入参错误
   * （格式错 / 连接不存在）需要不同的提示。
   */
  parse(scoped: string): { connectionId: string; rawCursorId: string } | null {
    const parsed = NodeId.parse(scoped)
    // adapterId 为 null 说明只有 `connection:c1` 而没有 `|游标`，不是合法游标 id。
    if (!parsed || parsed.adapterId === null || parsed.adapterId === '') return null
    return { connectionId: parsed.connectionId, rawCursorId: parsed.adapterId }
  }
} as const

export class ConnectionManager {
  /** 有活动会话（宿主进程活着）的连接。 */
  readonly #connections = new Map<string, LiveConnection>()
  /**
   * 已保存的配置（含没有会话的）。
   *
   * 与 `#connections` 分开存而不是合成一个带 `connected?` 字段的 Map：
   * 两者生命周期不同（配置长存、会话可断可连），混在一起会让每个
   * 读会话的地方都要先判空，且很容易在"断开时忘了保留配置"上出错。
   */
  readonly #saved = new Map<string, SavedConnection>()
  readonly #connecting = new Map<string, { host: DriverHostHandle; promise: Promise<ConnectionSummary> }>()
  readonly #closing = new Map<string, Promise<void>>()
  readonly #sessionTokens = new Map<string, object>()
  readonly #sessionSecrets = new Map<string, SecretMap>()
  #disposed = false
  readonly #store: ConnectionStore
  readonly #dialects: readonly DialectInfo[]
  #seq = 0

  /**
   * 已发出的游标：连接 id → 该连接上仍存活的原生游标 id 集合。
   *
   * ===== 为什么方案 (a) 还需要这张表 =====
   *
   * 前缀解决了「往哪转发」，但解决不了「清理」。宿主进程被关掉时它内部的游标
   * 自然消失，可主进程若不留痕，就无法回答两件事：
   *   1. `remove(connectionId)` 时该清理哪些——虽然宿主会退出，
   *      但我们仍要主动 closeCursor，让「释放」在双方都留下明确语义，
   *      而不是依赖「进程没了所以大概没事」。
   *   2. 泄漏可见性。若某个连接不断开查询却从不 closeCursor，
   *      这张表的大小就是泄漏的量化指标；没有它，泄漏是完全隐形的。
   *
   * 所以它**不是**路由表（路由靠前缀），而是**生命周期账本**。
   * 这个区分很重要：(b) 方案把路由和账本混成一份状态，而这里两者分开，
   * 前缀坏了不会影响清理，清理漏了也不会导致转发到错误的宿主。
   */
  readonly #openCursors = new Map<string, Set<string>>

  /**
   * 本管理器拥有的传输任务管理器。
   *
   * 归属在这里而不是独立存在，是因为**任务的生命周期必须跟着连接走**：
   * 连接断开时它上面的导出任务必须停下来（否则任务会一直等一个已死的宿主），
   * 应用退出时所有任务都要收尾（否则临时文件来不及删）。
   */
  readonly #transfers: TransferManager

  /** CSV 导入任务。与导出一样，生命周期跟随连接和应用退出。 */
  readonly #imports: ImportManager

  /**
   * 连接级「在途外部写」租约计数：连接 id → 已登记、尚未完成的写操作数量。
   *
   * ===== 为什么需要它（导入事务归属的最后一个竞态） =====
   *
   * 任务级守卫（`#assertNoActiveImport`）与导入前的 transactionState 预检都只
   * 在**各自被调到的那一刻**检查状态，它们挡不住这个交错：
   *
   *   1. 用户先发起一个写请求（applyEdits/insertRow/executeStatement/DDL/commit/
   *      rollback）。它通过了守卫，但写库的 RPC 还在途，用户事务尚未建立；
   *   2. 此时 startImport 被调用。任务级守卫看到「没有导入」放行；ImportManager
   *      的预检又在用户事务建立**之前**跑完，看到「无事务」也放行；
   *   3. 之后用户写建立事务，导入第一批 importBatch 撞上用户事务被驱动拒绝；
   *   4. ImportManager 按「写过就回滚」无条件 rollback，于是把**用户事务**回滚了。
   *
   * 单靠扩大守卫或预检都无法关闭第 1 步与第 2 步之间的窗口，因为窗口跨越了
   * 写请求的 await。这里用一个连接级计数把「写请求在途」这件事同步地暴露出来：
   * 每个外部写入口在**首个 await 之前**登记、在 finally 释放；startImport 在
   * 同一同步段内检查计数，>0 就同步拒绝。因为 JS 单线程，登记与检查之间没有
   * 让出点，所以二者要么写先登记（导入被拒），要么导入先建任务（写被任务守卫拒），
   * 不可能同时通过。导入自身的内部 commit/rollback 走 `#commitImport` /
   * `#rollbackImport`，不经过这些公共入口，因此不受本计数与守卫影响。
   */
  readonly #pendingWrites = new Map<string, number>()

  constructor(dialects: readonly DialectInfo[], store: ConnectionStore) {
    this.#dialects = dialects
    this.#store = store
    this.#transfers = new TransferManager({
      // 打开来源：走宿主 RPC，主进程不碰数据库。
      openSource: (source, batchSize) => this.#openTransferSource(source, batchSize),
      // 归属连接：节点 id 里已经带了连接归属，这里只做解析。
      resolveConnectionId: (source) => this.#connectionIdOfTransferSource(source),
      // 目标路径安全检查（挡住"导出覆盖正在使用的数据库文件"）。
      assertDestinationAllowed: (destinationPath) => this.#assertNotDatabaseFile(destinationPath),
      onLog: (level, msg) => this.#log(level, msg)
    })
    this.#imports = new ImportManager({
      writeBatch: (targetNodeId, batch) => this.#writeImportBatch(targetNodeId, batch),
      commit: (targetNodeId) => this.#commitImport(targetNodeId),
      rollback: (targetNodeId) => this.#rollbackImport(targetNodeId),
      transactionState: (targetNodeId) => this.#importTransactionState(targetNodeId),
      resolveConnectionId: (targetNodeId) => NodeId.parse(targetNodeId)?.connectionId,
      onLog: (level, msg) => this.#log(level, msg)
    })
    this.#loadPersisted()
  }

  /**
   * 从磁盘载入配置。**载入不等于连接**。
   *
   * ===== 为什么启动时不把所有库都连上 =====
   *
   * 1. 启动会变慢：5 个远端连接每个都要做一次 TCP + 认证，冷启动直接几十秒。
   * 2. 会弹一堆错误：某个库的机器关机了、密码轮换了，启动时就冒 5 个红色错误框，
   *    而用户此刻根本不想用这些连接。
   * 3. 会占资源：每个连接一个宿主进程，全连上等于空转 N 个子进程。
   *
   * 所以这里只**把配置装进内存**，会话由用户显式 `connectConnection` 或
   * 展开树时按需建立。list() 里 `connected:false` 是正常状态，不是错误。
   */
  #loadPersisted(): void {
    for (const stored of this.#store.listConnections()) {
      const info = this.#dialects.find((d) => d.id === stored.config.dialectId)
      if (!info) {
        // 配置里存着一个当前版本不认识的方言（比如驱动被移除了）。
        // 不删用户的配置——保留，只是无法连接。UI 会显示为不可用。
        this.#log(
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

  /** 从形如 `c12` 的 id 里提取序号，保证 `#seq` 不会与已载入的 id 冲突。 */
  #bumpSeqFrom(id: string): void {
    const match = /^c(\d+)$/.exec(id)
    if (!match) return
    const n = Number(match[1])
    if (Number.isFinite(n) && n > this.#seq) this.#seq = n
  }

  /** 统一的日志出口。移除连接时的回滚失败只是 warn，不该被当成连接删除失败。 */
  #log(level: 'info' | 'warn' | 'error', message: string): void {
    console[level === 'error' ? 'error' : 'log'](message)
  }

  listDialects(): DialectInfo[] {
    return [...this.#dialects]
  }

  /**
   * 判断某连接密码（凭据）的保存状态。**唯一的判定出口**。
   *
   * ===== 三态的语义（与 core/api.ts 的注释对齐） =====
   *
   *   null  → 该方言本就不需要密码（SQLite 是文件库，没 password 字段）
   *   true  → 需要密码且密文确实存下来了
   *   false → 需要密码但没存成（典型原因：safeStorage 不可用，我们拒绝存明文）
   *
   * ===== 为什么集中成一个函数 =====
   *
   * 这个判定要出现在 list() / add() / connect() / disconnect() / listChildren()
   * 至少五个地方。若各处自己写一遍，迟早出现"列表里显示已保存、树里显示未保存"
   * 这种自相矛盾的 UI。集中一处，改规则只改这里。
   */
  #secretStoredFor(saved: SavedConnection): boolean | null {
    // 1. 方言声明了 password 字段吗？没有 → 这个连接不需要密码，返回 null。
    //    注意看的是**方言的字段声明**，而不是"这次 add 有没有传 secret"：
    //    用户可能这次没填密码而想之后补，但那不改变"这个方言需要密码"的事实。
    const needsPassword = saved.info.fields.some((f) => f.kind === 'password')
    if (!needsPassword) return null

    /*
     * 2. 需要密码：必须真的能解出**数据库口令**才算存了。
     *
     * 早先是 hasSecret() 只看“有没有密文”。SSH 隧道之后这不够：
     * 一个连接可能只存了 SSH 口令、数据库口令为空，此时磁盘上有密文，
     * UI 却会显示“密码已保存”，重启后依然连不上数据库。
     * 这里有意只解密一次小文件，换取状态判断不撒谎。
     */
    if (this.#store.getSecret(saved.id)?.dbPassword !== undefined) return true

    // 3. 需要密码但没有密文 → false。
    //    典型成因是 cipher 不可用导致 setSecret 抛错（我们宁可拒存也不存明文）。
    return false
  }

  /**
   * 列出**所有已保存的连接**（含未连接的）。
   *
   * 语义相对第一阶段变了：以前只返回活动会话，现在返回配置清单。
   * 依据是 `core/api.ts` 里 `listConnections` 的注释——UI 需要看到
   * "存了但没连"的连接才能让用户点它去连。
   *
   * `capabilities` 只在有活动会话时非 null：能力是连上之后才知道的，
   * 未连接时给 null 而不是编一组默认值，这样 UI 不会误以为编辑能力可用。
   */
  list(): ConnectionSummary[] {
    const out: ConnectionSummary[] = []
    for (const saved of this.#saved.values()) {
      const live = this.#connections.get(saved.id)
      out.push({
        id: saved.id,
        name: saved.config.name,
        dialectId: saved.config.dialectId,
        connected: live !== undefined,
        capabilities: live?.capabilities ?? null,
        persisted: true,
        secretStored: this.#secretStoredFor(saved),
        options: { ...saved.config.options }
      })
    }
    return out
  }

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
    if (this.#disposed) throw new Error('连接管理器已关闭')
    const info = this.#dialects.find((d) => d.id === config.dialectId)
    if (!info) {
      throw new Error(
        `未知方言 "${config.dialectId}"，可用方言: ${this.#dialects.map((d) => d.id).join(', ')}`
      )
    }

    const id = makeConnectionId(++this.#seq)

    // ---- 第一步：落盘（配置 + 凭据） ----
    // 保存密码可能因 cipher 不可用而抛 SecretStorageUnavailableError。
    // 这时**配置仍然要存下来**（配置没有保密需求），只放弃密码，
    // 并把这件事交给 UI 提示——绝不能因此连配置都不存。
    let secretError: unknown = null
    this.#store.saveConnection(id, config)
    try {
      this.#store.setSecret(id, secret)
    } catch (err) {
      secretError = err
      const temporary = normalizeSecret(secret)
      if (!isEmptySecret(temporary)) this.#sessionSecrets.set(id, temporary)
    }
    this.#saved.set(id, { id, config, info })
    this.#log(
      'info',
      `[manager] 已保存连接 ${id}（${config.name}）到磁盘${
        secretError instanceof SecretStorageUnavailableError ? '；密码未保存（安全存储不可用）' : ''
      }`
    )

    // ---- 第二步：尝试连通 ----
    const summary = await this.#establishSession(id)
    // 密码保存失败时，把这件事"挂"在返回对象之外无法表达（ConnectionSummary 没这个字段），
    // 所以走日志 + 让 summary 反映真实连接结果。UI 侧通过 list() 看到 persisted=true。
    if (secretError !== null) {
      this.#log(
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
    if (this.#disposed) throw new Error('连接管理器已关闭')
    const saved = this.#saved.get(connectionId)
    if (!saved) throw new Error(`连接不存在: ${connectionId}`)
    const token = this.#sessionTokens.get(connectionId)
    const closing = this.#closing.get(connectionId)
    if (closing) {
      await closing
      if (this.#disposed || this.#saved.get(connectionId) !== saved ||
          this.#sessionTokens.get(connectionId) !== token) {
        return this.#toSummary(saved, undefined)
      }
    }
    return this.#establishSession(connectionId)
  }

  /** 关闭会话但保留配置；同步失效旧会话，再等待回滚和子进程退出。 */
  async disconnectConnection(connectionId: string): Promise<ConnectionSummary> {
    const saved = this.#saved.get(connectionId)
    if (!saved) throw new Error(`连接不存在: ${connectionId}`)
    await this.#stopSession(connectionId)
    return this.#toSummary(this.#saved.get(connectionId) ?? saved, undefined)
  }

  #establishSession(connectionId: string): Promise<ConnectionSummary> {
    const saved = this.#saved.get(connectionId)
    if (!saved) return Promise.reject(new Error(`连接不存在: ${connectionId}`))
    const live = this.#connections.get(connectionId)
    if (live) return Promise.resolve(this.#toSummary(saved, live))
    const pending = this.#connecting.get(connectionId)
    if (pending) return pending.promise

    const token = {}
    this.#sessionTokens.set(connectionId, token)
    const host = new DriverHostHandle({
      dialectId: saved.config.dialectId,
      onLog: (level, msg) => this.#log(level, msg),
      onExit: (error) => {
        // 旧宿主的退出事件不能清掉已经重连的新会话。
        if (this.#connections.get(connectionId)?.host === host) {
          this.#connections.delete(connectionId)
          this.#openCursors.delete(connectionId)
          this.#sessionSecrets.delete(connectionId)
          this.#log(
            'error',
            `[manager] 连接 ${connectionId}（${saved.config.name}）的驱动宿主退出: ${error.message}`
          )
        } else if (this.#connecting.get(connectionId)?.host === host) {
          this.#sessionSecrets.delete(connectionId)
        }
      }
    })
    const promise = this.#connectHost(saved, host, token).finally(() => {
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
    token: object
  ): Promise<ConnectionSummary> {
    const secret = this.#sessionSecrets.get(saved.id) ?? this.#store.getSecret(saved.id)
    try {
      await host.handshake
      const capabilities = await host.connect(saved.config, secret)
      if (host.closed || this.#disposed || this.#saved.get(saved.id) !== saved ||
          this.#sessionTokens.get(saved.id) !== token) {
        host.kill()
        await host.close()
        return this.#toSummary(saved, undefined)
      }
      const live: LiveConnection = { ...saved, capabilities, host }
      this.#connections.set(saved.id, live)
      return this.#toSummary(saved, live)
    } catch (err) {
      host.kill()
      await host.close()
      this.#log('warn', `[manager] 连接 ${saved.id}（${saved.config.name}）失败: ${describeThrown(err)}`)
      return this.#toSummary(saved, undefined)
    }
  }

  #stopSession(connectionId: string): Promise<void> {
    const existing = this.#closing.get(connectionId)
    if (existing) return existing

    this.#sessionTokens.set(connectionId, {})
    this.#sessionSecrets.delete(connectionId)
    this.#openCursors.delete(connectionId)
    /**
     * 导出与导入都先标记取消，但收尾顺序不同：
     *   - 导出先关宿主，让在途读取立刻失败，再等临时文件清理；
     *   - 导入必须等 ImportManager 自己回滚完，再走连接级清理，以免普通
     *     rollback 抢先结束导入事务。
     */
    this.#transfers.cancelByConnection(connectionId)
    this.#imports.cancelByConnection(connectionId)
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
        await this.#imports.waitByConnection(connectionId)
        if (this.#connections.get(connectionId) === live) {
          this.#connections.delete(connectionId)
        }
        await this.#rollbackQuietly(live)
        await live.host.close()
      } else {
        await this.#imports.waitByConnection(connectionId)
      }
      // 宿主已关（在途的读会被唤醒失败），这时才等导出任务真正收尾——
      // 顺序反过来会被一条慢查询卡住整个断连流程。
      await this.#transfers.waitByConnection(connectionId)
    })().finally(() => {
      if (this.#closing.get(connectionId) === closing) this.#closing.delete(connectionId)
    })
    this.#closing.set(connectionId, closing)
    return closing
  }

  #toSummary(saved: SavedConnection, live: LiveConnection | undefined): ConnectionSummary {
    return {
      id: saved.id,
      name: saved.config.name,
      dialectId: saved.config.dialectId,
      connected: live !== undefined,
      capabilities: live?.capabilities ?? null,
      persisted: true,
      secretStored: this.#secretStoredFor(saved),
      // 编辑连接时要把原配置回填到表单，没有这个字段用户就是"盲改"。
      options: { ...saved.config.options }
    }
  }

  async remove(connectionId: string): Promise<void> {
    const closing = this.#stopSession(connectionId)
    // 先撤销可连接的配置，避免清理期间被另一个 connect 重新拉起。
    this.#saved.delete(connectionId)
    this.#sessionTokens.delete(connectionId)
    this.#store.deleteConnection(connectionId)
    await closing
    this.#log('info', `[manager] 已删除连接 ${connectionId}（配置与凭据已清除）`)
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
      if (code === 'unsupported_method' || code === 'not_connected' || /unsupported_method|not_connected/.test(text)) {
        this.#log('info', `[${conn.id}] 该数据源无事务语义，跳过回滚: ${describeThrown(err)}`)
        return
      }
      this.#log('warn', `[${conn.id}] 移除连接前回滚事务失败（忽略）: ${describeThrown(err)}`)
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

  /**
   * 解析 nodeId 并返回它所属的连接；出错时抛出可直接展示的消息。
   *
   * 三种失败各有独立文案，因为用户能做的应对完全不同：
   * 语法错（界面 bug）、连接没了（重连）、adapterId 缺失（用错了节点类型）。
   */
  #resolveConnection(nodeId: string): { conn: LiveConnection; adapterId: string | null } {
    const parsed = NodeId.parse(nodeId)
    if (!parsed) throw new Error(`无法解析的节点 id: ${nodeId}`)
    const conn = this.#connections.get(parsed.connectionId)
    if (!conn) throw new Error(`连接不存在或已断开: ${parsed.connectionId}`)
    return { conn, adapterId: parsed.adapterId }
  }

  async testConnection(
    config: ConnectionConfig,
    secret?: SecretInput
  ): Promise<TestConnectionResult> {
    const host = new DriverHostHandle({ dialectId: config.dialectId })
    try {
      await host.handshake
      return await host.testConnection(config, secret)
    } finally {
      // 测试连接不留会话，务必回收。
      await host.close()
    }
  }

  /**
   * 列子节点。
   *
   * 三处细节，都是踩过坑才知道要处理的：
   *  1. 根层（null）返回的是「连接」本身，不是 adapter 的数据
   *  2. 连接层（adapterId === null）要调 adapter 的 `listChildren(null)`
   *  3. 子节点的 parentId 必须改写成本层的**作用域 id**，否则 UI 建树会接错
   */
  async listChildren(nodeId: string | null): Promise<ObjectRef[]> {
    if (nodeId === null) {
      return this.list().map((c) => ({
        id: NodeId.connection(c.id),
        kind: 'connection' as const,
        name: c.name,
        parentId: null,
        hasChildren: true,
        meta: {
          dialect: c.dialectId,
          connected: c.connected,
          // ★ 这两个字段是 UI 显示状态所必需的，漏传会让 UI 永远显示"未保存"
          //   （`ref.meta?.['persisted'] === true` 永远为 false）。
          //   meta 的值域是 string|number|boolean|null，故 secretStored 的
          //   `boolean|null` 可直接放。null 表示"该方言不需要密码"，
          //   UI 应据此区分"无需密码"与"需要但没存上"。
          persisted: c.persisted,
          secretStored: c.secretStored,
          // 把配置参数拍平成 `options.<key>` 放进 meta，供「编辑连接」对话框回填。
          // 为什么拍平而不是嵌套对象：ObjectRef.meta 的值域是
          // `string | number | boolean | null`（要能结构化克隆跨进程），
          // 放嵌套对象会破坏这个约定。
          ...Object.fromEntries(
            Object.entries(c.options).map(([k, v]) => [`options.${k}`, v])
          ),
          ...(c.capabilities ? { inlineEdit: c.capabilities.supportsInlineEdit } : {})
        }
      }))
    }

    const parsed = NodeId.parse(nodeId)
    if (!parsed) throw new Error(`无法解析的节点 id: ${nodeId}`)

    const conn = this.#connections.get(parsed.connectionId)
    if (!conn) throw new Error(`连接不存在或已断开: ${parsed.connectionId}`)

    const raw = await conn.host.listChildren(parsed.adapterId)
    const parentScoped = nodeId
    return raw.map((item) => ({
      ...item,
      id: NodeId.scoped(conn.id, item.id),
      parentId: parentScoped
    }))
  }

  describeTable(nodeId: string): Promise<TableDescription> {
    const parsed = NodeId.parse(nodeId)
    if (!parsed) return Promise.reject(new Error(`无法解析的节点 id: ${nodeId}`))
    if (parsed.adapterId === null) {
      return Promise.reject(new Error('连接节点没有表结构，请选择具体的表或视图'))
    }
    const conn = this.#connections.get(parsed.connectionId)
    if (!conn) return Promise.reject(new Error(`连接不存在或已断开: ${parsed.connectionId}`))
    return conn.host.describeTable(parsed.adapterId)
  }

  /**
   * 只读结构快照。展开表和视图后逐个 describe，不执行任何同步 SQL。
   */
  async captureSchemaSnapshot(connectionId: string, schema?: string | null): Promise<SchemaSnapshot> {
    const tables: SnapshotTable[] = []
    const views: { schema: string | null; name: string; definition: string | null }[] = []
    // 只下钻 folder / schema，表和视图是叶子（它们的子节点是列，不需要）。
    // 深度上限防止异常驱动返回环。
    const conn = this.#connections.get(connectionId)
    if (!conn) throw new Error(`连接不存在或已断开: ${connectionId}`)
    const walk = async (nodeId: string, currentSchema: string | null, depth: number): Promise<void> => {
      if (depth > 4) return
      for (const node of await this.listChildren(nodeId)) {
        if (node.kind === 'schema') {
          if (schema && node.name !== schema) continue
          await walk(node.id, node.name, depth + 1)
        } else if (node.kind === 'folder' || node.kind === 'catalog') {
          await walk(node.id, currentSchema, depth + 1)
        } else if (node.kind === 'table') {
          tables.push({ ...(await this.describeTable(node.id)), schema: currentSchema, name: node.name })
        } else if (node.kind === 'view') {
          /*
           * 读取视图的真实 DDL。没有这一步，快照里所有视图的 definition 都是
           * null，比较器只能判断"视图存在与否"，判断不出"定义改没改"——
           * 那会让用户以为结构一致，实际视图逻辑已经不同。
           *
           * 单条读取失败不拖垮整次快照：拿不到就留 null，上层会把它标成
           * "定义未捕获"并告警（可见的不确定，好过静默的错误结论）。
           */
          let definition: string | null = null
          const viewAdapterId = NodeId.parse(node.id)?.adapterId ?? null
          if (viewAdapterId !== null) {
            try {
              definition = await conn.host.viewDefinition(viewAdapterId)
            } catch {
              definition = null
            }
          }
          views.push({ schema: currentSchema, name: node.name, definition })
        }
      }
    }
    // 只浏览数据源（Redis / Kafka）没有表结构。放它进来会得到一张空快照，
    // 再被拿去和目标库比较，就会生成"删除目标端全部表"的 DROP 计划。
    if (conn.config.dialectId !== 'sqlite' && conn.config.dialectId !== 'postgresql' && conn.config.dialectId !== 'mysql') {
      throw new Error(`${conn.info.name} 没有表结构，不能参与结构比较（只支持 SQL 数据源）`)
    }
    await walk(NodeId.connection(connectionId), null, 0)
    const byName = (a: { schema: string | null; name: string }, b: { schema: string | null; name: string }) =>
      `${a.schema ?? ''}.${a.name}`.localeCompare(`${b.schema ?? ''}.${b.name}`)
    tables.sort(byName)
    views.sort(byName)
    /*
     * 例程（函数 / 存储过程）。它们不在树节点里（树只展开表/视图），
     * 所以单独查一次。驱动不支持时 host 会返回空数组（见 driver-host 的
     * listRoutines 分支），SQLite 就是这种情况——它没有持久化例程。
     *
     * 同样按"失败不拖垮快照"处理：查不到就当没有例程，不抛错。
     */
    let routines: RoutineDefinition[] = []
    try {
      const raw = await conn.host.listRoutines({ schema: schema ?? null })
      routines = raw.map((routine) => ({
        schema: routine.schema,
        name: routine.name,
        kind: routine.kind,
        definition: routine.definition,
        // 签名原样透传给比较器：它是区分重载的唯一依据，不能在中间层丢掉。
        ...(routine.signature === undefined ? {} : { signature: routine.signature })
      }))
    } catch {
      routines = []
    }
    return {
      source: { connectionId, schema: schema ?? null },
      tables,
      views,
      routines
    }
  }

  /**
   * 按唯一键比较两张表的数据，返回差异与同步计划。
   *
   * 只读：两侧都只跑 SELECT（runQuery），同步 SQL 只生成不执行。
   * 超过 maxRows 直接拒绝，而不是截断后给出“看起来没差异”的错误结论。
   */
  async compareTableData(request: DataCompareRequest): Promise<DataCompareResult> {
    // 方言守卫必须**最先**跑：跨方言比较无论如何都不支持，先报这件事，
    // 用户才不会先看到"缺少比较键列"这类由误配表引起的次生错误。
    const source = this.#resolveConnection(request.sourceTableNodeId)
    const target = this.#resolveConnection(request.targetTableNodeId)
    const dialect = target.conn.config.dialectId
    const sourceDialect = source.conn.config.dialectId
    for (const [label, id] of [['源', sourceDialect], ['目标', dialect]] as const) {
      if (id !== 'sqlite' && id !== 'postgresql' && id !== 'mysql') throw new Error(`数据比较暂不支持方言：${label} ${id}`)
    }
    // 跨方言比较必须拒绝：两边对同一列的值映射不同（PostgreSQL 把 int8/numeric
    // 当文本返回，SQLite 当 number），按键对齐后每行都会被判成"源端独有+目标端独有"，
    // 于是生成一张全表 DELETE + 全表 INSERT 的"同步计划"——看起来合理，实则灾难。
    if (sourceDialect !== dialect) {
      throw new Error(
        `跨方言数据比较暂不支持（源 ${sourceDialect} → 目标 ${dialect}）：` +
          '两边的值类型映射不同，按行比较会产生假差异。请改用结构比较，或先迁移到同一方言。'
      )
    }
    const maxRows = Math.min(Math.max(request.maxRows ?? 50_000, 1), 500_000)
    const sourceDesc = await this.describeTable(request.sourceTableNodeId)
    const targetDesc = await this.describeTable(request.targetTableNodeId)
    const primary = sourceDesc.columns
      .filter((c) => c.primaryKeyOrdinal !== null)
      .sort((a, b) => (a.primaryKeyOrdinal ?? 0) - (b.primaryKeyOrdinal ?? 0))
      .map((c) => c.name)
    const keyColumns = request.keyColumns && request.keyColumns.length > 0 ? [...request.keyColumns] : primary
    if (keyColumns.length === 0) {
      throw new Error('源表没有主键，请指定一组唯一列作为比较键（不支持按行号比较）')
    }
    for (const [label, desc] of [['源表', sourceDesc], ['目标表', targetDesc]] as const) {
      const names = new Set(desc.columns.map((c) => c.name))
      const missing = keyColumns.filter((c) => !names.has(c))
      if (missing.length > 0) throw new Error(`${label}缺少比较键列：${missing.join(', ')}`)
    }
    const sharedColumns = sourceDesc.columns
      .map((c) => c.name)
      .filter((name) => targetDesc.columns.some((t) => t.name === name))
    if (sharedColumns.length === 0) throw new Error('两张表没有同名列，无法比较数据')
    /*
     * 二进制列不参与数据比较（BLOB / BYTEA / BINARY 等）：
     * 把二进制内容按文本比较既不可靠，也会把整块数据搬进内存。
     * 这与文档里的语义一致——这里显式剔除并告警，而不是读到该列时才抛错。
     */
    const isBinaryType = (typeName: string): boolean =>
      /(^|\W)(blob|tinyblob|mediumblob|longblob|bytea|binary|varbinary|image)(\W|$)/i.test(typeName)
    const binaryColumns = sharedColumns.filter((name) => {
      const sourceColumn = sourceDesc.columns.find((c) => c.name === name)
      const targetColumn = targetDesc.columns.find((c) => c.name === name)
      return isBinaryType(sourceColumn?.typeName ?? '') || isBinaryType(targetColumn?.typeName ?? '')
    })
    const keyBinary = keyColumns.filter((name) => binaryColumns.includes(name))
    if (keyBinary.length > 0) {
      throw new Error(`比较键不能是二进制列：${keyBinary.join(', ')}`)
    }
    const comparableColumns = sharedColumns.filter((name) => !binaryColumns.includes(name))
    if (comparableColumns.length === 0) {
      throw new Error('两张表没有可比的非二进制列，无法比较数据')
    }
    const sourceRows = await this.#readRowsForCompare(request.sourceTableNodeId, comparableColumns, keyColumns, maxRows)
    const targetRows = await this.#readRowsForCompare(request.targetTableNodeId, comparableColumns, keyColumns, maxRows)
    const name = tableNameFromAdapterId(target.adapterId, dialect)
    const result = compareDataRows(sourceRows, targetRows, { columns: keyColumns }, dialect as CompareDialect, name)
    // 只比列交集：目标端缺的列不会被比较，必须说出来，否则用户会以为那一列也一致。
    const sourceOnly = sourceDesc.columns.map((c) => c.name).filter((n) => !targetDesc.columns.some((t) => t.name === n))
    const targetOnly = targetDesc.columns.map((c) => c.name).filter((n) => !sourceDesc.columns.some((t) => t.name === n))
    const warnings = [...result.plan.warnings]
    if (binaryColumns.length > 0) {
      warnings.push(`二进制列不参与数据比较：${binaryColumns.join(', ')}。`)
    }
    if (sourceOnly.length > 0) warnings.push(`源表独有列未参与比较：${sourceOnly.join(', ')}（需要先同步结构）。`)
    if (targetOnly.length > 0) warnings.push(`目标表独有列未参与比较：${targetOnly.join(', ')}（需要先同步结构）。`)
    return { keyColumns, ...result, plan: { ...result.plan, warnings } }
  }

  async #readRowsForCompare(
    tableNodeId: string,
    columns: readonly string[],
    keyColumns: readonly string[],
    maxRows: number
  ): Promise<DataCompareRow[]> {
    const { conn, adapterId } = this.#resolveConnection(tableNodeId)
    const { schema, name } = tableNameFromAdapterId(adapterId, conn.config.dialectId)
    const q = (value: string) => quoteIdentifierWith(value, conn.info.quoting)
    const from = schema ? `${q(schema)}.${q(name)}` : q(name)
    const sql = `SELECT ${columns.map(q).join(', ')} FROM ${from} ORDER BY ${keyColumns.map(q).join(', ')}`
    const pageSize = 1000
    const first = await this.runQuery(tableNodeId, sql, { limit: pageSize, keepCursor: true })
    const rows: DataCompareRow[] = []
    try {
      let page: ResultPage = first
      let offset = 0
      for (;;) {
        for (const row of page.rows) {
          if (rows.length >= maxRows) {
            throw new Error(`表 ${name} 超过 ${maxRows} 行，已停止比较；请缩小范围或调大上限`)
          }
          const values: Record<string, string | number | boolean | null> = {}
          for (let i = 0; i < columns.length; i += 1) {
            let cell = row.cells[i] ?? { kind: 'null' as const }
            if (cell.kind === 'text' && cell.truncated && first.cursorId !== null) {
              cell = await this.fetchCellValue(first.cursorId, row.index, i)
            }
            values[columns[i] as string] = compareValueOf(cell, name, columns[i] as string)
          }
          const key: Record<string, string | number | boolean | null> = {}
          for (const column of keyColumns) key[column] = values[column] ?? null
          rows.push({ key, values })
        }
        offset += page.returned
        if (!page.hasMore || first.cursorId === null) break
        page = await this.fetchResultPage(first.cursorId, offset, pageSize)
      }
    } finally {
      if (first.cursorId !== null) await this.closeCursor(first.cursorId).catch(() => undefined)
    }
    return rows
  }

  /** 应用退出时统一回收所有宿主进程。 */
  async disposeAll(): Promise<void> {
    this.#disposed = true
    await Promise.all([...this.#saved.keys()].map((id) => this.#stopSession(id)))
    await Promise.all(this.#closing.values())
    // 传输任务最后收尾：它们要等宿主退出才可能被唤醒。
    await Promise.all([this.#transfers.dispose(), this.#imports.dispose()])
    this.#sessionTokens.clear()
    this.#sessionSecrets.clear()
  }

  // ---- 流式导出（P2.1） ----

  /**
   * 启动一个导出任务。
   *
   * 参数错误同步抛出（格式不对、路径为空、来源不完整）；
   * 任务本身异步跑，调用方拿 taskId 去轮询进度。
   */
  startTransfer(request: TransferRequest): TransferProgress {
    this.#assertNotDatabaseFile(request.destinationPath)
    return this.#transfers.start(request)
  }

  /**
   * 拒绝把导出结果写到**数据库文件**上。
   *
   * 导出流程是「同目录临时文件 → 原子 rename 到目标」。
   * 若目标恰好是某个 SQLite 库文件，rename 会把库文件替换成导出内容——
   * 数据库直接没了。更糟的是该库文件仍被连接持有，连接继续写下去
   * 会写到一个已被替换掉的文件，"看起来还在用的库"与磁盘上的文件分家。
   *
   * 检查**所有已保存连接**的库路径（不只是当前连接）：
   * 导出连接 B 时把目标写成连接 A 的库文件，同样会毁掉 A。
   * 同时挡 `-wal` / `-shm` / `-journal` 旁文件——覆盖它们会破坏
   * 正在运行的连接的 WAL 状态。
   *
   * 路径比较前先归一化（见 `normalizeFsPath`），否则符号链接会让
   * "目标其实就是那个库文件"绕过检查。
   */
  #assertNotDatabaseFile(destinationPath: string): void {
    const target = normalizeFsPath(destinationPath)
    for (const saved of this.#saved.values()) {
      if (saved.config.dialectId !== 'sqlite') continue
      const raw = saved.config.options['file']
      if (typeof raw !== 'string' || raw.trim() === '') continue
      const dbPath = normalizeFsPath(raw.trim())
      if (dbPath === target) {
        throw new Error(
          `导出目标「${destinationPath}」就是连接「${saved.config.name}」正在使用的 SQLite 数据库文件。` +
            '导出会用结果替换目标文件，那会直接毁掉这个数据库。已拒绝。'
        )
      }
      for (const suffix of ['-wal', '-shm', '-journal']) {
        if (normalizeFsPath(`${raw.trim()}${suffix}`) === target) {
          throw new Error(
            `导出目标「${destinationPath}」是连接「${saved.config.name}」的 SQLite 附属文件` +
              `（${suffix}）。覆盖它会破坏正在使用的数据库，已拒绝。`
          )
        }
      }
    }
  }

  /** 取导出任务进度。未知 id 返回 undefined。 */
  getTransferProgress(taskId: string): TransferProgress | undefined {
    return this.#transfers.get(taskId)
  }

  /** 取消导出任务。返回 false 表示任务不存在、已结束或已进入不可取消的提交阶段。 */
  cancelTransfer(taskId: string): boolean {
    return this.#transfers.cancel(taskId)
  }

  /** 等待导出任务结束，返回终态结果。 */
  async waitTransfer(taskId: string): Promise<TransferResult> {
    return this.#transfers.wait(taskId)
  }

  /** 在主进程读取 CSV 并返回有界预览；完整文件内容不会经过 IPC。 */
  async previewImport(request: ImportPreviewRequest): Promise<ImportPreview> {
    if (typeof request !== 'object' || request === null) {
      throw new Error('预览请求必须是对象')
    }
    if (typeof request.sourcePath !== 'string' || request.sourcePath.trim() === '') {
      throw new Error('预览请求缺少 sourcePath')
    }
    if (!isAbsolute(request.sourcePath)) {
      throw new Error(`CSV 文件路径必须是绝对路径：${request.sourcePath}`)
    }
    if (typeof request.delimiter !== 'string' || request.delimiter.length !== 1) {
      throw new Error('CSV 分隔符必须是单个字符')
    }
    if (typeof request.nullText !== 'string') {
      throw new Error('CSV NULL 标记必须是字符串')
    }
    if (typeof request.hasHeader !== 'boolean') {
      throw new Error('CSV hasHeader 必须是布尔值')
    }
    const bytes = await readFile(request.sourcePath)
    const parsed = previewCsv(bytes, {
      delimiter: request.delimiter,
      nullText: request.nullText,
      hasHeader: request.hasHeader,
      sampleRowLimit: request.sampleRowLimit
    })
    return { sourcePath: request.sourcePath, ...parsed }
  }

  startImport(request: ImportRequest): ImportProgress {
    // 同步校验节点与连接，避免先拿到 taskId 再发现连接根本不存在。
    const { conn } = this.#resolveConnection(request.targetNodeId)
    if (this.#closing.has(conn.id)) {
      throw new Error(`连接 ${conn.id} 正在断开，不能再启动导入任务。`)
    }
    // 连接上还有在途的外部写：此时开始导入会在「用户事务尚未建立」的空窗里
    // 通过预检，随后 importBatch 撞上用户事务并触发 ImportManager 的通用
    // rollback，把用户事务误回滚。必须同步拒绝；等写操作结束（finally 释放
    // 租约）后用户可重试。放在 #imports.start 之前，保证任务不会先被建出来。
    const pendingWrites = this.#pendingWriteCount(conn.id)
    if (pendingWrites > 0) {
      throw new Error(
        `连接 ${conn.id} 上还有 ${pendingWrites} 个写操作正在进行，已拒绝启动导入。` +
          '请等待这些写操作完成（或先提交/回滚）后重试，以免导入事务与用户事务交叉。'
      )
    }
    return this.#imports.start(request)
  }

  getImportProgress(taskId: string): ImportProgress | undefined {
    return this.#imports.get(taskId)
  }

  cancelImport(taskId: string): boolean {
    return this.#imports.cancel(taskId)
  }

  async waitImport(taskId: string): Promise<ImportResult> {
    return this.#imports.wait(taskId)
  }

  #writeImportBatch(targetNodeId: string, batch: ImportBatch): Promise<ImportBatchResult> {
    const { conn, adapterId } = this.#resolveConnection(targetNodeId)
    if (adapterId === null) {
      return Promise.reject(new Error('连接节点不能作为导入目标，请选择具体的表'))
    }
    return conn.host.importBatch(adapterId, batch)
  }

  #commitImport(targetNodeId: string): Promise<TransactionState> {
    const { conn } = this.#resolveConnection(targetNodeId)
    return conn.host.commitTransaction()
  }

  #rollbackImport(targetNodeId: string): Promise<TransactionState> {
    const { conn } = this.#resolveConnection(targetNodeId)
    return conn.host.rollbackTransaction()
  }

  #importTransactionState(targetNodeId: string): Promise<TransactionState> {
    const { conn } = this.#resolveConnection(targetNodeId)
    return conn.host.transactionState()
  }

  /**
   * 归属连接 id 的解析。
   *
   * 节点 id 形如 `connection:c1|table:users`，连接归属就在前缀里。
   * `connectionId` 字段则允许直接给裸 id。
   *
   * 两者同时给出时**必须一致**，否则拒绝——不一致意味着调用方搞混了
   * "在哪个连接上跑"，继续下去会把数据从错误的库导出来。
   */
  #connectionIdOfTransferSource(source: TransferSource): string | undefined {
    const fromNode = source.nodeId === undefined ? undefined : NodeId.parse(source.nodeId)?.connectionId
    const fromExplicit = source.connectionId
    if (fromNode !== undefined && fromExplicit !== undefined && fromNode !== fromExplicit) {
      throw new Error(
        `导出来源的 nodeId 指向连接 ${fromNode}，但 connectionId 是 ${fromExplicit}，两者不一致，已拒绝。`
      )
    }
    return fromNode ?? fromExplicit
  }

  /**
   * 打开一个导出来源。
   *
   * ===== 数据从哪来 =====
   *
   *   - 表来源（只给 nodeId）：向宿主要「读取语句 + INSERT 落点」，
   *     然后用**既有的** query / fetchResultPage 分页取数。
   *   - 查询来源（给 sql）：直接用这条 SQL 走同样的分页取数。
   *
   * 走既有 RPC 的原因：分页读取的语义（重新执行 + LIMIT/OFFSET）
   * 在 adapter 里已经实现并被网格验证过，导出**复用**它而不是另写一套。
   *
   * ===== 一致性（必须诚实）=====
   *
   * 每一页都是**重新执行**的 SQL，所以导出期间底层数据若被并发修改，
   * 不同批次看到的不是同一个时刻的数据。这不是快照。
   * 上层用 `consistency: 'live-paged'` 如实标注。
   */
  async #openTransferSource(source: TransferSource, batchSize: number): Promise<TransferSourceHandle> {
    const connectionId = this.#connectionIdOfTransferSource(source)
    if (connectionId === undefined) {
      throw new Error('无法确定导出来源所属的连接')
    }
    const { conn } = this.#resolveConnectionLike(connectionId)

    let sql: string
    let target: TransferSourceHandle['target']
    if (source.sql !== undefined && source.sql.trim() !== '') {
      if (source.nodeId !== undefined && source.nodeId.trim() !== '') {
        /**
         * 同时给了 nodeId 与 sql：nodeId 只用来定位连接，
         * **不**用来推断表——否则"给一张表的 nodeId 却导出另一条 SQL"会
         * 让人误以为导出的是那张表。
         */
        const parsed = NodeId.parse(source.nodeId)
        if (parsed === null) {
          throw new Error(`无法解析导出来源的 nodeId：${source.nodeId}`)
        }
        if (parsed.connectionId !== connectionId) {
          throw new Error(
            `导出来源的 nodeId 属于连接 ${parsed.connectionId}，与指定连接 ${connectionId} 不一致，已拒绝。`
          )
        }
      }
      sql = source.sql
    } else {
      if (source.nodeId === undefined || source.nodeId.trim() === '') {
        throw new Error('必须提供导出来源：nodeId（表来源）或 sql（查询来源）')
      }
      const { adapterId } = this.#resolveConnection(source.nodeId)
      if (adapterId === null) {
        throw new Error('连接节点不能作为导出对象，请选择具体的表或视图')
      }
      // 让驱动解析自己的 id（PG 的 id 带 schema，主进程切不开）。
      const resolution = await conn.host.resolveTransferSource(adapterId)
      sql = resolution.sql
      target = resolution.target
    }

    // 先跑一次查询拿到列名与第一页，游标就此打开。
    const first = await conn.host.query(sql, { limit: batchSize })
    let cursorId = first.cursorId
    let columns = first.columns.map((column) => column.name)
    let pending: readonly (readonly CellValue[])[] = first.rows.map((row) => row.cells)
    let done = !first.hasMore
    let offset = first.rows.length

    /**
     * 释放游标。
     *
     * 幂等：异常路径上可能已经关过一次。
     * 关游标失败**不抛**：那会让"导出失败"的原因被"关游标失败"覆盖，
     * 而真正的原因（SQL 错误、取消）才是用户需要的。
     */
    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      if (cursorId === null) return
      const id = cursorId
      cursorId = null
      try {
        await conn.host.closeCursor(id)
      } catch {
        // 忽略
      }
    }

    return {
      columns,
      dialectId: conn.info.id,
      ...(target === undefined ? {} : { target }),
      async read(): Promise<{ rows: readonly (readonly CellValue[])[]; done: boolean }> {
        /**
         * 先把手上这批交出去，**再**判断是否已到末尾。
         *
         * 顺序反了会漏数据：第一批返回的行数少于批大小时 `hasMore` 为 false，
         * 若先判 done 就直接返回空数组，那批行会被整批丢掉——
         * "表里有 3 行、批大小 200"就会导出 0 行。
         */
        if (pending.length > 0) {
          const rows = pending
          pending = []
          return { rows, done }
        }
        if (done) return { rows: [], done: true }
        if (cursorId === null) {
          // 没有游标却还有数据要读：不该发生，明确失败而不是静默截断。
          throw new Error('导出来源的游标已失效，无法继续读取')
        }
        const page = await conn.host.fetchResultPage(cursorId, offset, batchSize)
        offset += page.rows.length
        done = !page.hasMore
        columns = page.columns.map((column) => column.name)
        return { rows: page.rows.map((row) => row.cells), done }
      },
      close
    }
  }

  // ---- 结果集（第二阶段） ----

  /**
   * 执行 SQL，返回第一页。
   *
   * `nodeId` 复用树节点的编码来指明「在哪个连接上执行」。
   * 这里允许 connector 根节点（`connection:c1`，adapterId === null）——
   * 用户在连接上右键「执行 SQL」时没有具体表，仍应能跑任意语句。
   */
  async runQuery(nodeId: string, sql: string, options?: QueryOptions): Promise<QueryResult> {
    const { conn } = this.#resolveConnection(nodeId)
    const result = await conn.host.query(sql, options)
    if (this.#connections.get(conn.id) !== conn) {
      throw new Error(`查询所属的会话已断开: ${conn.id}`)
    }

    // 把 adapter 的原生游标 id 包上连接归属后再交给 UI（理由见 CursorId 注释）。
    // 同时登记进账本，让「这个连接还有游标没关」在主进程侧可见。
    if (result.cursorId !== null && result.cursorId !== undefined) {
      const scoped = CursorId.scope(conn.id, result.cursorId)
      this.#trackCursor(conn.id, result.cursorId)
      return { ...result, cursorId: scoped }
    }
    return result
  }

  /**
   * 执行一条 SQL 语句（查询、DML 或 DDL）。
   * 若结果包含游标，同样进行连接归属作用域包装与账本登记。
   */
  async executeStatement(nodeId: string, sql: string, options?: QueryOptions): Promise<StatementResult> {
    const { conn } = this.#resolveConnection(nodeId)
    // 该入口可能执行 DML/DDL 并复用导入事务，导入期间一律拒绝（只读查询走 runQuery）。
    this.#assertNoActiveImport(conn.id, '执行 SQL 语句')
    this.#beginWrite(conn.id)
    try {
      const result = await conn.host.executeStatement(sql, options)
      if (this.#connections.get(conn.id) !== conn) {
        throw new Error(`语句执行所属的会话已断开: ${conn.id}`)
      }

      if (result.kind === 'rows') {
        const qResult = result.result
        if (qResult.cursorId !== null && qResult.cursorId !== undefined) {
          const scoped = CursorId.scope(conn.id, qResult.cursorId)
          this.#trackCursor(conn.id, qResult.cursorId)
          return {
            ...result,
            result: { ...qResult, cursorId: scoped }
          }
        }
      }
      return result
    } finally {
      this.#endWrite(conn.id)
    }
  }

  /** 按连接所属驱动生成执行计划，不在主进程拼接方言关键字。 */
  async explain(nodeId: string, sql: string): Promise<ExplainResult> {
    const { conn } = this.#resolveConnection(nodeId)
    const result = await conn.host.explain(sql)
    if (this.#connections.get(conn.id) !== conn) {
      throw new Error(`执行计划所属的会话已断开: ${conn.id}`)
    }
    return result
  }

  /** 从游标按偏移量取一页。入参若是坏 id 会立刻报错，不会挂死。 */
  async fetchResultPage(cursorId: string, offset: number, limit: number): Promise<ResultPage> {
    const { conn, rawCursorId } = this.#resolveCursor(cursorId)
    return conn.host.fetchResultPage(rawCursorId, offset, limit)
  }

  /**
   * 释放游标。
   *
   * 幂等：重复关闭、关闭一个不存在的游标都不报错。
   * 这与宿主侧 `closeCursor` 不做 requireConnected 的决定是配套的——
   * 网格关闭时会无条件调用它，这条路径上任何噪音错误都会变成用户可见的弹窗。
   */
  async closeCursor(cursorId: string): Promise<void> {
    const { conn, rawCursorId } = this.#resolveCursor(cursorId)
    try {
      await conn.host.closeCursor(rawCursorId)
    } finally {
      // 即使宿主侧关闭失败也要销账：那条游标要么已经没了，
      // 要么随着宿主退出而消失，留着账本条目只会被误判成泄漏。
      this.#openCursors.get(conn.id)?.delete(rawCursorId)
    }
  }

  /**
   * 便捷方法：预览一张表 / 视图。
   *
   * ===== 为什么不拼字符串 =====
   *
   * 表名来自数据库元数据，但用户可以创建任意名字的表——包含双引号、分号、
   * 甚至 `"; DROP TABLE users; --` 这种名字（SQLite 完全允许）。
   * 直接 `${name}` 拼进 SELECT 就是一个注入面。
   * 所以必须走方言的 `quoteIdentifier`，它内部把 `"` 翻倍成 `""`，破坏语句结构。
   *
   * ===== 为什么用 Lazy 的 limit 而不是把整个结果集拉回来 =====
   *
   * 预览的语义是「看一眼前 N 行」。用方言的 `buildLimitClause` 生成
   * `LIMIT n OFFSET 0` 交给数据库执行，而不是拉全量再在内存里截断——
   * 后者在百万行表上会直接把主进程内存打爆（这也是 core/resultset.ts 里
   * 「不做 DBeaver 那套滚动条以已加载行数为准」的原因）。
   *
   * 表名从 nodeId 里取：adapter 的 id 形如 `table:users` / `view:v`
   * （编码规则见 `src/drivers/sqlite/ids.ts`，只切第一个冒号，名字原样保留）。
   * 这里直接用 `nodeId` 的 adapterId 部分再切掉前缀——不 import adapter，
   * 因为那会把一个持有连接的实现拖进主进程（见文件头 import 注释）。
   */
  /**
   * 按对象 id 生成「读取该表/视图」的 SELECT。表名限定与引号由驱动决定，主进程不猜。
   */
  async tableSelectSql(nodeId: string): Promise<string> {
    const { conn, adapterId } = this.#resolveConnection(nodeId)
    if (adapterId === null) throw new Error('连接节点不能生成表查询，请选择具体的表或视图')
    return conn.host.tableSelectSql(adapterId)
  }

  async previewTable(nodeId: string, limit = 200): Promise<QueryResult> {
    const { conn, adapterId } = this.#resolveConnection(nodeId)
    if (adapterId === null) {
      throw new Error('连接节点不能预览，请选择具体的表或视图')
    }

    // 只切第一个冒号：与 ids.ts 的 `table:<name>` 编码规则一致，
    // 所以名字里含冒号也能正确还原（`table:a:b` → `a:b`）。
    const sep = adapterId.indexOf(':')
    if (sep <= 0) throw new Error(`无法识别的对象 id: ${adapterId}`)
    const kind = adapterId.slice(0, sep)
    const name = adapterId.slice(sep + 1)

    if (kind !== 'table' && kind !== 'view') {
      throw new Error(`只能预览表或视图，收到: ${kind}`)
    }
    if (name === '') throw new Error(`对象名为空，无法预览: ${adapterId}`)

    // 表名限定（schema/database 前缀）与引号由**驱动**生成：主进程不认识 id 编码，
    // 曾用 quoteIdentifier(payload) 把整个 `table:<schema>.<name>` 当单标识符，
    // 多库/多 schema 下会拼出 `"public.users"` 这种错误表名、静默读错库。
    // 行数限制仍通过 QueryOptions.limit 交给 adapter（分页语法是方言知识）。
    const sql = await conn.host.tableSelectSql(adapterId)
    const result = await this.runQuery(nodeId, sql, { limit })

    // ===== 兜底校验：确认 adapter 真的落实了 limit =====
    //
    // 上面的设计把「怎么限行」完全交给了 adapter，这是对的（方言知识不该复制到 main）。
    // 但它有一个失败模式：某个 adapter 忽略了 `options.limit`，
    // 于是 previewTable 悄悄退化成「拉全量」——而这正是剖析报告「陷阱 5」里
    // 要防的事（跨进程一次性搬运百万行会把内存打爆）。
    //
    // 主进程在这里不可能纠正它（不重查、不猜方言），但**必须让它可见**：
    // 一旦返回行数超出请求上限，说明契约被违反了。宁可抛错让人发现，
    // 也不要静默返回一个已经吞掉内存的结果。
    const effectiveLimit = Math.max(1, Math.floor(limit))
    if (result.returned > effectiveLimit) {
      throw new Error(
        `方言 "${conn.info.id}" 的 adapter 违反了 limit 契约：请求 ${effectiveLimit} 行，` +
          `实际返回 ${result.returned} 行。预览功能会因此退化为全量拉取，已中止。` +
          `这属于 adapter 实现缺陷，不是 UI 问题。`
      )
    }
    return result
  }

  // ---- 在线编辑与事务（第三阶段） ----

  /**
   * 应用一批行更新（**不自动提交**）。
   *
   * `tableNodeId` 必须是表节点（带连接作用域）；`adapterId` 原样传给宿主，
   * 由 adapter 自己解析 `table:<name>`——主进程不解析驱动私有的 id 编码，
   * 这是「驱动知识只存在于驱动里」这条边界的直接结果。
   *
   * 提交语义：applyEdits 成功后连接进入事务，必须显式 commit/rollback。
   * 这个"不自动提交"来自 DBeaver 的 Persister（构造即 autocommit=false），
   * 也是"在线编辑"与"随便跑条 UPDATE"最重要的区别：用户要有反悔的机会。
   */
  async applyEdits(
    tableNodeId: string,
    updates: readonly RowUpdate[]
  ): Promise<EditApplyResult> {
    const { conn, adapterId } = this.#resolveConnection(tableNodeId)
    this.#assertNoActiveImport(conn.id, '应用行编辑')
    if (adapterId === null) {
      throw new Error('连接节点不能提交编辑，请选择具体的表')
    }
    if (!Array.isArray(updates) || updates.length === 0) {
      throw new Error('没有要提交的修改（updates 为空）')
    }
    this.#beginWrite(conn.id)
    try {
      return await conn.host.applyEdits(adapterId, updates)
    } finally {
      this.#endWrite(conn.id)
    }
  }

  /**
   * 提交事务。
   *
   * 无活动事务时**不静默成功**：那说明 UI 状态与后端不一致，
   * 静默成功会让"用户以为保存了、其实什么都没发生"这种最坏的 bug 悄悄发生。
   */
  async commitTransaction(nodeId: string): Promise<TransactionState> {
    const { conn } = this.#resolveConnection(nodeId)
    this.#assertNoActiveImport(conn.id, '普通事务提交')
    this.#beginWrite(conn.id)
    try {
      return await conn.host.commitTransaction()
    } finally {
      this.#endWrite(conn.id)
    }
  }

  /** 回滚事务。幂等——重复回滚、回滚一个没有事务的连接都不该报错。 */
  async rollbackTransaction(nodeId: string): Promise<TransactionState> {
    const { conn } = this.#resolveConnection(nodeId)
    this.#assertNoActiveImport(conn.id, '普通事务回滚')
    this.#beginWrite(conn.id)
    try {
      return await conn.host.rollbackTransaction()
    } finally {
      this.#endWrite(conn.id)
    }
  }

  /**
   * 当前架构没有把事务 owner 写进 TransactionState，因此普通事务入口只能
   * 以“导入任务是否仍活动”作为最小所有权判据。误放行 commit 会把半次导入
   * 提交掉，误放行 rollback 会让 ImportManager 失去事务控制权，两者都必须拒绝。
   *
   * ===== 为什么写入入口也要走同一道闸 =====
   *
   * 导入的批次写入由 ImportManager 直接调 `host.importBatch`，第一批开启事务、
   * 后续批次复用同一个连接事务。但 `executeStatement`（DML）、`insertRow`、
   * `applyEdits`、`deleteRows` 以及 DDL 在驱动侧都是“已在事务中就复用、否则
   * BEGIN IMMEDIATE”——也就是说导入期间它们会悄悄加入导入事务。若放行，
   * 这些无关写入会被 ImportManager 的 commit 一起提交（或随 rollback 一起丢弃），
   * 破坏导入的原子性边界。主进程无法在不重复方言解析的前提下判定
   * `executeStatement` 是否会写库，所以这里对上述入口一律保守拒绝；
   * 只读查询仍走 `runQuery` / `previewTable`，不受影响。
   */
  #assertNoActiveImport(connectionId: string, operation: string): void {
    const taskId = this.#imports.activeTaskByConnection(connectionId)
    if (taskId === undefined) return
    throw new Error(
      `连接 ${connectionId} 正在执行导入任务 ${taskId}，已拒绝${operation}，` +
        '以免无关写入混入导入事务。导入事务只能由 ImportManager 提交或回滚；' +
        '请等待导入结束或先取消导入。'
    )
  }

  /**
   * 登记一次外部写操作的在途租约。**必须在方法的首个 await 之前调用**，
   * 这样 startImport 在同一同步段内的计数检查与本次登记之间没有让出点，
   * 二者的先后顺序才能确定（见 `#pendingWrites` 注释）。
   */
  #beginWrite(connectionId: string): void {
    this.#pendingWrites.set(connectionId, (this.#pendingWrites.get(connectionId) ?? 0) + 1)
  }

  /** 释放一次在途写租约。**必须放在 finally**，且与 `#beginWrite` 成对调用。 */
  #endWrite(connectionId: string): void {
    const current = this.#pendingWrites.get(connectionId)
    if (current === undefined) return
    if (current <= 1) this.#pendingWrites.delete(connectionId)
    else this.#pendingWrites.set(connectionId, current - 1)
  }

  #pendingWriteCount(connectionId: string): number {
    return this.#pendingWrites.get(connectionId) ?? 0
  }

  /**
   * 查询事务状态。
   *
   * `nodeId` 只用来定位连接：事务是**连接级**的状态，宿主进程内的
   * adapter 实例持有它。因此这里传连接根节点（`connection:c1`）也可以，
   * UI 不必先知道某张表。
   */
  async transactionState(nodeId: string): Promise<TransactionState> {
    const { conn } = this.#resolveConnection(nodeId)
    return conn.host.transactionState()
  }

  // ---- 增删与完整取值（第五阶段） ----

  /**
   * 插入一行（不自动提交）。
   *
   * `tableNodeId` 用 `#resolveConnection` 拆出连接与 adapterId；adapterId 原样
   * 交给宿主——adapter 自己认识 `table:<name>`，主进程不解析驱动私有 id。
   */
  async insertRow(
    tableNodeId: string,
    values: Readonly<Record<string, CellValue>>
  ): Promise<{ affected: number; keyValues: Record<string, CellValue> }> {
    const { conn, adapterId } = this.#resolveConnection(tableNodeId)
    this.#assertNoActiveImport(conn.id, '插入行')
    if (adapterId === null) {
      throw new Error('连接节点不能插入行，请选择具体的表')
    }
    this.#beginWrite(conn.id)
    try {
      return await conn.host.insertRow(adapterId, values)
    } finally {
      this.#endWrite(conn.id)
    }
  }

  /**
   * 按主键批量删除行（不自动提交）。
   *
   * 主进程这一层也做一次**空数组拒绝**（宿主侧还会再挡一次）。两层都挡是
   * 刻意的：这是会导致整表清空的路径，"省一道防线"换不来任何收益。
   */
  async deleteRows(
    tableNodeId: string,
    keys: readonly Readonly<Record<string, CellValue>>[]
  ): Promise<EditApplyResult> {
    const { conn, adapterId } = this.#resolveConnection(tableNodeId)
    this.#assertNoActiveImport(conn.id, '删除行')
    if (adapterId === null) {
      throw new Error('连接节点不能删除行，请选择具体的表')
    }
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error('没有要删除的行（keys 为空）——为避免误删整表，已拒绝')
    }
    this.#beginWrite(conn.id)
    try {
      return await conn.host.deleteRows(adapterId, keys)
    } finally {
      this.#endWrite(conn.id)
    }
  }

  /**
   * 统计表行数。
   *
   * **注意：这是显式动作，任何懒加载路径都不得调用它**（大表 COUNT(*) 是全表扫描）。
   * 方法独立存在、不在 listChildren/describeTable 里被调用，就是这条约束的体现；
   * e2e 里有一条断言专门验证"列目录不会触发它"。
   */
  async countRows(tableNodeId: string): Promise<number> {
    const { conn, adapterId } = this.#resolveConnection(tableNodeId)
    if (adapterId === null) {
      throw new Error('连接节点没有行数，请选择具体的表')
    }
    return conn.host.countRows(adapterId)
  }

  /**
   * 取单格完整值。
   *
   * `cursorId` 是 runQuery 返回的**带连接作用域**的 id，故先经 `#resolveCursor`
   * 还原成"连接 + 原生游标 id"再转发——与 fetchResultPage 同一套规则。
   */
  async fetchCellValue(
    cursorId: string,
    rowIndex: number,
    columnIndex: number
  ): Promise<CellValue> {
    const { conn, rawCursorId } = this.#resolveCursor(cursorId)
    return conn.host.fetchCellValue(rawCursorId, rowIndex, columnIndex)
  }

  // ---- DDL 与编辑连接（第六阶段） ----

  /**
   * 建表。`connectionId` 可以是 `connection:c1` 也可以是裸 `c1`——统一用
   * `NodeId.parse` 归一：有前缀就解析，没有就当作裸 id。这样 UI 传节点 id
   * 或连接 id 都能工作，减少一类"参数形态不对"的隐 bug。
   */
  async createTable(connectionId: string, spec: TableCreateSpec): Promise<void> {
    const { conn } = this.#resolveConnectionLike(connectionId)
    this.#assertNoActiveImport(conn.id, '建表')
    this.#beginWrite(conn.id)
    try {
      // adapter 层用不到 connectionId，但仍按契约传（见 DriverAdapter 注释）。
      return await conn.host.createTable(conn.id, spec)
    } finally {
      this.#endWrite(conn.id)
    }
  }

  /**
   * 删表。
   *
   * ===== 主进程只做连接解析，不解析表名 =====
   *
   * `tableNodeId` 形如 `connection:c1|table:users`。主进程用 NodeId.parse 拆出
   * `{ connectionId, adapterId }`，然后把**完整 adapterId**（`table:users`）原样
   * 传给宿主。为什么不自己切出 `users`：
   *   - 驱动私有 id 编码可能带转义（sqlite 的 column id 就有 `\.` 转义），
   *     主进程猜规则迟早猜错；
   *   - 这与 applyEdits / insertRow 的处理方式完全一致，"id 由生成它的驱动解析"
   *     是一条统一的边界规则。
   */
  async dropTable(tableNodeId: string): Promise<void> {
    const { conn, adapterId } = this.#resolveConnection(tableNodeId)
    this.#assertNoActiveImport(conn.id, '删表')
    if (adapterId === null) throw new Error('连接节点不能删除，请选择具体的表')
    this.#beginWrite(conn.id)
    try {
      return await conn.host.dropTable(adapterId)
    } finally {
      this.#endWrite(conn.id)
    }
  }

  async createView(connectionId: string, viewName: string, selectSql: string): Promise<void> {
    const { conn } = this.#resolveConnectionLike(connectionId)
    this.#assertNoActiveImport(conn.id, '建视图')
    this.#beginWrite(conn.id)
    try {
      return await conn.host.createView(conn.id, viewName, selectSql)
    } finally {
      this.#endWrite(conn.id)
    }
  }

  async dropView(viewNodeId: string): Promise<void> {
    const { conn, adapterId } = this.#resolveConnection(viewNodeId)
    this.#assertNoActiveImport(conn.id, '删视图')
    if (adapterId === null) throw new Error('连接节点不能删除，请选择具体的视图')
    this.#beginWrite(conn.id)
    try {
      return await conn.host.dropView(adapterId)
    } finally {
      this.#endWrite(conn.id)
    }
  }

  /**
   * 取消某个节点所属连接上正在执行的查询。
   *
   * 为什么按 nodeId 而不是 connectionId：UI 手上只有当前格子/标签对应的节点，
   * 让 UI 自己去反查连接会多一层容易出错的状态。这里复用 `#resolveConnection`。
   *
   * `#resolveConnection` 对"连接节点本身"返回 adapterId=null —— 那种情况下
   * 取消的是该连接上的查询，直接用 conn.host 即可（不需要 adapterId）。
   */
  async cancelQuery(nodeId: string, signalId?: string): Promise<boolean> {
    const { conn } = this.#resolveConnection(nodeId)
    return conn.host.cancelQuery(signalId)
  }

  async renameTable(tableNodeId: string, newName: string): Promise<void> {
    const { conn, adapterId } = this.#resolveConnection(tableNodeId)
    this.#assertNoActiveImport(conn.id, '重命名表')
    if (adapterId === null) throw new Error('连接节点不能重命名，请选择具体的表')
    this.#beginWrite(conn.id)
    try {
      return await conn.host.renameTable(adapterId, newName)
    } finally {
      this.#endWrite(conn.id)
    }
  }

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
    const { conn, saved } = this.#resolveSaved(connectionId)
    const wasConnected = conn !== undefined

    // ---- 合并配置 ----
    // options 必须**浅合并**而不是整体替换：UI 编辑表单可能只提交被改动的
    // 字段（比如只传 { file }），整体替换会把其它 option 丢掉。
    const mergedConfig: ConnectionConfig = {
      dialectId: config.dialectId ?? saved.config.dialectId,
      name: config.name ?? saved.config.name,
      options: { ...saved.config.options, ...(config.options ?? {}) }
    }

    // 方言若改了，要重新查 DialectInfo（previewTable/secretStored 依赖它）。
    const info = this.#dialects.find((d) => d.id === mergedConfig.dialectId)
    if (!info) {
      throw new Error(
        `未知方言 "${mergedConfig.dialectId}"，可用方言: ${this.#dialects.map((d) => d.id).join(', ')}`
      )
    }

    // 1) 落盘新配置；密码给了就一并更新（走 store 的加密通道）。
    this.#store.saveConnection(connectionId, mergedConfig)
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
      const existing = this.#store.getSecret(connectionId) ?? {}
      const merged = mergeSecrets(existing, secret)
      this.#store.setSecret(connectionId, isEmptySecret(merged) ? undefined : merged)
    }
    this.#saved.set(connectionId, { id: connectionId, config: mergedConfig, info })
    this.#log('info', `[manager] 已更新连接 ${connectionId}（${mergedConfig.name}）的配置`)

    // 2) 原本连着 → 先断（保留配置）。断开会回滚未提交事务并关宿主。
    if (wasConnected) {
      await this.disconnectConnection(connectionId)
    }

    // 3) 原本连着才重连，让新配置立刻生效。
    if (wasConnected) {
      return this.connectConnection(connectionId)
    }
    // 原本断开：不擅自连接，返回更新后的（未连接）summary。
    const after = this.#saved.get(connectionId)
    if (!after) throw new Error(`连接在更新过程中消失: ${connectionId}`)
    return this.#toSummary(after, undefined)
  }

  /**
   * 接受「节点 id（connection:c1）或裸连接 id（c1）」两种形态，归一成连接。
   * 用于 createTable / createView —— 它们的入参是 connectionId，
   * 但 UI 手上往往把它包成节点 id，两种都认更省事也更不易出错。
   */
  #resolveConnectionLike(connectionIdOrNodeId: string): { conn: LiveConnection } {
    const parsed = NodeId.parse(connectionIdOrNodeId)
    const realId = parsed ? parsed.connectionId : connectionIdOrNodeId
    const conn = this.#connections.get(realId)
    if (!conn) throw new Error(`连接不存在或已断开: ${realId}`)
    return { conn }
  }

  /** 取「已保存配置」+「可选的活动会话」。updateConnection 用。 */
  #resolveSaved(connectionId: string): {
    conn: LiveConnection | undefined
    saved: SavedConnection
  } {
    const parsed = NodeId.parse(connectionId)
    const realId = parsed ? parsed.connectionId : connectionId
    const saved = this.#saved.get(realId)
    if (!saved) throw new Error(`连接不存在: ${connectionId}`)
    return { conn: this.#connections.get(realId), saved }
  }

  /** 登记一个游标到账本。 */
  #trackCursor(connectionId: string, rawCursorId: string): void {
    let set = this.#openCursors.get(connectionId)
    if (!set) {
      set = new Set<string>()
      this.#openCursors.set(connectionId, set)
    }
    set.add(rawCursorId)
  }

  /** 把 UI 传来的 scoped cursorId 还原成「连接 + adapter 原生 id」。 */
  #resolveCursor(cursorId: string): { conn: LiveConnection; rawCursorId: string } {
    const parsed = CursorId.parse(cursorId)
    if (!parsed) {
      throw new Error(
        `无法解析的游标 id: ${cursorId}（游标 id 必须原样使用 runQuery 返回的值，不要自行拼接）`
      )
    }
    const conn = this.#connections.get(parsed.connectionId)
    if (!conn) {
      throw new Error(`游标所属的连接已断开: ${parsed.connectionId}（游标随宿主进程一起失效）`)
    }
    return { conn, rawCursorId: parsed.rawCursorId }
  }

  /** 诊断用：当前连接数 / 游标账本条目数。让泄漏可以被观测而不是靠猜。 */
  stats(): { connections: number; openCursors: number } {
    let cursors = 0
    for (const set of this.#openCursors.values()) cursors += set.size
    return { connections: this.#connections.size, openCursors: cursors }
  }
}

/**
 * 从 adapter 表 id 还原 schema 与表名（数据比较拼 SELECT 用）。
 *
 * 两种内置编码：SQLite `table:<name>`（名字原样）；PostgreSQL
 * `table:<schema>.<name>`，两段内 `\` 转义、以第一个未转义点号分隔。
 * 无法识别时拒绝，而不是猜一个名字去拼 SQL。
 */
function tableNameFromAdapterId(
  adapterId: string | null,
  dialectId: string
): { schema: string | null; name: string } {
  if (adapterId === null || !adapterId.startsWith('table:')) {
    throw new Error(`数据比较只接受表节点，收到: ${adapterId ?? '连接节点'}`)
  }
  const payload = adapterId.slice('table:'.length)
  if (payload === '') throw new Error(`无法识别的表 id: ${adapterId}`)
  if (dialectId === 'sqlite') return { schema: null, name: payload }
  if (dialectId !== 'postgresql' && dialectId !== 'mysql') throw new Error(`数据比较暂不支持方言：${dialectId}`)
  let head = ''
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload.charAt(i)
    if (ch === '\\') {
      head += payload.charAt(i + 1)
      i += 1
      continue
    }
    if (ch === '.') {
      let tail = ''
      for (let j = i + 1; j < payload.length; j += 1) {
        const c = payload.charAt(j)
        if (c === '\\') {
          tail += payload.charAt(j + 1)
          j += 1
        } else tail += c
      }
      if (head === '' || tail === '') break
      return { schema: head, name: tail }
    }
    head += ch
  }
  throw new Error(`无法识别的 PostgreSQL 表 id: ${adapterId}`)
}

function compareValueOf(cell: CellValue, table: string, column: string): string | number | boolean | null {
  switch (cell.kind) {
    case 'null':
      return null
    case 'number':
    case 'boolean':
      return cell.value
    case 'text':
      if (cell.truncated) throw new Error(`${table}.${column} 的长文本无法取全文，已停止比较`)
      return cell.text
    case 'blob':
      throw new Error(`${table}.${column} 是二进制列，暂不支持数据比较`)
  }
}
