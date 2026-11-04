/**
 * 导出用例服务：流式导出任务的生命周期、来源打开与目标路径保护。
 *
 * ===== 为什么从 ConnectionManager 里抽出来 =====
 *
 * `startTransfer` / `getTransferProgress` / `cancelTransfer` / `waitTransfer`
 * 以及它们背后的三件私有逻辑（来源归属连接、打开来源、目标路径安全检查）
 * 是同一组用例的组成部分：
 *
 *   1. **同步校验**：参数与目标路径必须在返回 taskId 之前判定完；
 *   2. **来源打开**：表来源走宿主的 `resolveTransferSource`，查询来源直接
 *      使用给定 SQL，两者共用同一套分页读取（`query` / `fetchResultPage`）；
 *   3. **任务编排**：`TransferManager` 负责状态机、临时文件与原子 rename。
 *
 * 把它们集中在这里，`ConnectionManager` 只剩兼容 facade，导出路径也可以被
 * 独立阅读与测试，而不会因为会话/目录的改动被牵连。
 *
 * ===== 边界 =====
 *
 * 本模块**不** import `ConnectionManager`、electron、`src/drivers` 或任何具体
 * adapter。它只认识：
 *
 *   - `ConnectionResolver`：节点/连接 id → 活动会话；
 *   - `listSavedConnections`：已保存配置的只读快照（目标路径保护要检查
 *     **所有**连接，不只是当前连接）；
 *   - `TransferManager`：导出任务编排（本模块负责创建并持有它）；
 *   - core 的 `NodeId` 与传输类型（纯数据）。
 *
 * `LiveConnection.host` 只以类型出现（经 `types.ts` 的 `import type`），
 * 因此本模块没有任何运行时依赖会顺着宿主句柄进入主进程 bundle 之外的地方。
 *
 * ===== 必须保持的语义（逐条都会被回归测试命中）=====
 *
 * 1. **startTransfer 同步抛错**：格式、目标路径、来源、批大小任何一项不合法
 *    都在返回 taskId 之前抛出；`assertNotDatabaseFile` 仍排在最前面。
 * 2. **目标路径保护**：拒绝覆盖任意已保存 SQLite 连接正在使用的库文件，
 *    以及它的 `-wal` / `-shm` / `-journal` 旁文件。比较前必须
 *    `normalizeFsPath`（文件级符号链接 + 父目录符号链接）。
 * 3. **来源一致性**：nodeId 与 connectionId 同时给出且指向不同连接时拒绝；
 *    错误文案逐字保留。
 * 4. **sql 来源与 node 来源语义**：同时给 nodeId 与 sql 时，nodeId **只**
 *    用来定位连接，不推断表；纯 node 来源才向宿主解析 SELECT / INSERT 目标。
 * 5. **分页顺序**：首批 pending 行必须在判断 `done` **之前**交付，
 *    否则「表里有 3 行、批大小 200」会导出 0 行。
 * 6. **close 失败吞掉**：关闭游标失败不能覆盖真正的原因（SQL 错误/取消），
 *    且 close 幂等。
 * 7. **来源直接走 host**：不使用 `QueryApplicationService`，避免改变
 *    游标账本与统计口径。
 */

import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { NodeId } from '../../core/api'
import type { CellValue } from '../../core/resultset'
import type {
  TransferProgress,
  TransferRequest,
  TransferResult,
  TransferSource,
  TransferSourceHandle
} from '../../core/transfer'
import { TransferManager } from '../TransferManager'
import type { ConnectionResolver } from './connection-resolver'
import type { ConnectionLogger, SavedConnection } from './types'

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

/**
 * 导出用例服务的外部依赖。
 *
 * `getResolver` 刻意用 getter 而不是直接持有实例：`ConnectionManager` 的
 * 构造顺序是「任务组 → 会话 → 解析器」（会话服务需要任务组的取消/等待
 * 能力，解析器又需要会话）。getter 打断这个环，同时保证服务读到的仍是
 * 同一个 `ConnectionResolver`。
 */
export interface TransferApplicationContext {
  /** 惰性读取统一的连接解析器。 */
  readonly getResolver: () => ConnectionResolver
  /**
   * 已保存连接的只读快照。
   *
   * 目标路径保护要检查**所有**连接：导出连接 B 时把目标写成连接 A 的库
   * 文件，同样会毁掉 A。
   */
  readonly listSavedConnections: () => Iterable<SavedConnection>
  readonly onLog: ConnectionLogger
}

export class TransferApplicationService {
  readonly #ctx: TransferApplicationContext
  readonly #manager: TransferManager

  constructor(context: TransferApplicationContext) {
    this.#ctx = context
    this.#manager = new TransferManager({
      // 打开来源：走宿主 RPC，主进程不碰数据库。
      openSource: (source, batchSize) => this.#openTransferSource(source, batchSize),
      // 归属连接：节点 id 里已经带了连接归属，这里只做解析。
      resolveConnectionId: (source) => this.#connectionIdOfTransferSource(source),
      // 目标路径安全检查（挡住"导出覆盖正在使用的数据库文件"）。
      assertDestinationAllowed: (destinationPath) =>
        this.#assertNotDatabaseFile(destinationPath),
      onLog: (level, msg) => this.#ctx.onLog(level, msg)
    })
  }

  /**
   * 任务组本身。
   *
   * 会话服务只需要 `cancelByConnection` / `waitByConnection`；暴露管理器
   * 而不是复制这两个方法，避免出现第二份「哪些任务属于该连接」的判断。
   */
  get manager(): TransferManager {
    return this.#manager
  }

  /**
   * 启动一个导出任务。
   *
   * 参数错误同步抛出（格式不对、路径为空、来源不完整）；
   * 任务本身异步跑，调用方拿 taskId 去轮询进度。
   *
   * 目标路径的危险性检查仍在此处先做一次：与拆分前一样，它发生在
   * `TransferManager.start` 的参数校验之前。
   */
  startTransfer(request: TransferRequest): TransferProgress {
    this.#assertNotDatabaseFile(request.destinationPath)
    return this.#manager.start(request)
  }

  /** 取导出任务进度。未知 id 返回 undefined。 */
  getTransferProgress(taskId: string): TransferProgress | undefined {
    return this.#manager.get(taskId)
  }

  /** 取消导出任务。返回 false 表示任务不存在、已结束或已进入不可取消的提交阶段。 */
  cancelTransfer(taskId: string): boolean {
    return this.#manager.cancel(taskId)
  }

  /** 等待导出任务结束，返回终态结果。 */
  async waitTransfer(taskId: string): Promise<TransferResult> {
    return this.#manager.wait(taskId)
  }

  /** 应用退出时收尾所有导出任务（取消未结束任务并等待临时文件清理）。 */
  dispose(): Promise<void> {
    return this.#manager.dispose()
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
    for (const saved of this.#ctx.listSavedConnections()) {
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
    const fromNode =
      source.nodeId === undefined ? undefined : NodeId.parse(source.nodeId)?.connectionId
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
   * 这里刻意**不**经过 `QueryApplicationService`：导出有自己的游标
   * 生命周期（close 吞错、不登记账本），复用查询服务会改变账本与统计口径。
   *
   * ===== 一致性（必须诚实）=====
   *
   * 每一页都是**重新执行**的 SQL，所以导出期间底层数据若被并发修改，
   * 不同批次看到的不是同一个时刻的数据。这不是快照。
   * 上层用 `consistency: 'live-paged'` 如实标注。
   */
  async #openTransferSource(
    source: TransferSource,
    batchSize: number
  ): Promise<TransferSourceHandle> {
    const connectionId = this.#connectionIdOfTransferSource(source)
    if (connectionId === undefined) {
      throw new Error('无法确定导出来源所属的连接')
    }
    const resolver = this.#ctx.getResolver()
    const { conn } = resolver.resolveConnectionLike(connectionId)

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
      const { adapterId } = resolver.resolveConnection(source.nodeId)
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
}
