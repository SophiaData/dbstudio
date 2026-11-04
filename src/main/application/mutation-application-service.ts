/**
 * 变更用例服务：在线编辑、事务控制、增删行、行数统计与 DDL。
 *
 * ===== 为什么从 ConnectionManager 里抽出来 =====
 *
 * 这一组方法的共同点是：**它们都是外部发起的、可能改变数据库状态的显式动作**。
 * 每个入口只做同一套固定顺序的工作：
 *
 *   1. 把节点/连接 id 解析成活动会话；
 *   2. 在首个 await 之前完成导入互斥检查与在途写租约登记；
 *   3. 把 adapterId / 参数原样转给宿主进程；
 *   4. 在 finally 释放租约。
 *
 * 它们不碰持久化配置、不碰会话生命周期、不碰导入/导出任务编排。把这段
 * 固定时序集中到一处，既避免十几个入口各写一份后悄悄漂移，也让
 * `ConnectionManager` 退回兼容 facade 的职责。
 *
 * ===== 边界 =====
 *
 * 本模块**不** import `ConnectionManager`、electron、`src/drivers` 或任何具体
 * adapter。它只认识：
 *
 *   - `ConnectionResolver`：节点/连接 id → 活动会话；
 *   - `ConnectionActivityGuard`：导入互斥与在途写租约；
 *   - 可选的 `getActiveImport`：提供给后续只读用例的导入状态查询能力。
 *
 * `LiveConnection.host` 只以类型出现（经 `types.ts` 的 `import type`），本模块
 * 没有任何运行时依赖会顺着宿主句柄进入 driver-host 之外的地方。
 *
 * ===== 必须保持的时序与契约 =====
 *
 * 1. **先守卫、后 await**：所有外部写入口在首个 await 之前调用
 *    `assertNoActiveImport` 与 `beginWrite`，并在 `finally` 里 `endWrite`。
 *    空 updates/keys、连接节点等前置校验位于守卫之后、`beginWrite` 之前，
 *    与拆分前逐字、逐序一致。
 * 2. **rollback 幂等但受守卫**：重复回滚、回滚没有事务的连接由宿主保证不报错，
 *    但导入期间仍必须拒绝（导入事务只能由 ImportManager 回滚）。
 * 3. **transactionState 只解析连接**：事务是连接级状态，只读查询，不加写租约。
 * 4. **countRows 是显式动作**：不加入 listChildren/describeTable 的懒加载路径，
 *    也不加导入守卫（只读且不会建立事务）。
 * 5. **DDL 参数原样转 host**：主进程不解析驱动私有 id；`createTable` /
 *    `createView` 的 connectionId 既接受裸 id 也接受连接节点。
 * 6. **不做 post-await 会话校验**：这些入口在拆分前就没有，保持现状，
 *    不新增行为。
 */

import type { TableCreateSpec } from '../../core/model'
import type {
  CellValue,
  EditApplyResult,
  RowUpdate,
  TransactionState
} from '../../core/resultset'
import type { ConnectionActivityGuard } from './connection-activity-guard'
import type { ConnectionResolver } from './connection-resolver'
import type { LiveConnection } from './types'

/**
 * 变更用例服务的外部依赖。
 *
 * 全部是最小能力注入，而不是让服务反向持有 ConnectionManager：
 *   - `resolver` / `activity` 是已经抽出的协作者；
 *   - `getActiveImport` 可选。现有写入口统一经 `activity` 完成互斥，
 *     避免出现两份判定；该能力预留给需要读取导入状态的后续只读用例。
 */
export interface MutationApplicationContext {
  readonly resolver: ConnectionResolver
  readonly activity: ConnectionActivityGuard
  /** 读取该连接上正在执行的导入 taskId；没有则 undefined。 */
  readonly getActiveImport?: (connectionId: string) => string | undefined
}

export class MutationApplicationService {
  readonly #ctx: MutationApplicationContext

  constructor(context: MutationApplicationContext) {
    this.#ctx = context
  }

  /**
   * 应用一批行更新（**不自动提交**）。
   *
   * `tableNodeId` 必须是表节点（带连接作用域）；`adapterId` 原样传给宿主，
   * 由 adapter 自己解析 `table:<name>`——主进程不解析驱动私有的 id 编码。
   *
   * 提交语义：applyEdits 成功后连接进入事务，必须显式 commit/rollback。
   * 这个「不自动提交」是「在线编辑」与「随便跑条 UPDATE」最重要的区别。
   */
  async applyEdits(
    tableNodeId: string,
    updates: readonly RowUpdate[]
  ): Promise<EditApplyResult> {
    const { conn, adapterId } = this.#ctx.resolver.resolveConnection(tableNodeId)
    this.#ctx.activity.assertNoActiveImport(conn.id, '应用行编辑')
    if (adapterId === null) {
      throw new Error('连接节点不能提交编辑，请选择具体的表')
    }
    if (!Array.isArray(updates) || updates.length === 0) {
      throw new Error('没有要提交的修改（updates 为空）')
    }
    return this.#write(conn.id, () => conn.host.applyEdits(adapterId, updates))
  }

  /**
   * 提交事务。
   *
   * 无活动事务时**不静默成功**：那说明 UI 状态与后端不一致，
   * 静默成功会让「用户以为保存了、其实什么都没发生」这种最坏的 bug 悄悄发生。
   */
  async commitTransaction(nodeId: string): Promise<TransactionState> {
    const { conn } = this.#ctx.resolver.resolveConnection(nodeId)
    this.#ctx.activity.assertNoActiveImport(conn.id, '普通事务提交')
    return this.#write(conn.id, () => conn.host.commitTransaction())
  }

  /** 回滚事务。幂等——重复回滚、回滚一个没有事务的连接都不该报错。 */
  async rollbackTransaction(nodeId: string): Promise<TransactionState> {
    const { conn } = this.#ctx.resolver.resolveConnection(nodeId)
    this.#ctx.activity.assertNoActiveImport(conn.id, '普通事务回滚')
    return this.#write(conn.id, () => conn.host.rollbackTransaction())
  }

  /**
   * 查询事务状态。
   *
   * `nodeId` 只用来定位连接：事务是**连接级**的状态，宿主进程内的
   * adapter 实例持有它。因此这里传连接根节点（`connection:c1`）也可以，
   * UI 不必先知道某张表。这是只读查询，不登记在途写租约。
   */
  async transactionState(nodeId: string): Promise<TransactionState> {
    const { conn } = this.#ctx.resolver.resolveConnection(nodeId)
    return conn.host.transactionState()
  }

  /**
   * 插入一行（不自动提交）。
   *
   * `tableNodeId` 解析出连接与 adapterId；adapterId 原样交给宿主——
   * adapter 自己认识 `table:<name>`，主进程不解析驱动私有 id。
   */
  async insertRow(
    tableNodeId: string,
    values: Readonly<Record<string, CellValue>>
  ): Promise<{ affected: number; keyValues: Record<string, CellValue> }> {
    const { conn, adapterId } = this.#ctx.resolver.resolveConnection(tableNodeId)
    this.#ctx.activity.assertNoActiveImport(conn.id, '插入行')
    if (adapterId === null) {
      throw new Error('连接节点不能插入行，请选择具体的表')
    }
    return this.#write(conn.id, () => conn.host.insertRow(adapterId, values))
  }

  /**
   * 按主键批量删除行（不自动提交）。
   *
   * 主进程这一层也做一次**空数组拒绝**（宿主侧还会再挡一次）。两层都挡是
   * 刻意的：这是会导致整表清空的路径，「省一道防线」换不来任何收益。
   */
  async deleteRows(
    tableNodeId: string,
    keys: readonly Readonly<Record<string, CellValue>>[]
  ): Promise<EditApplyResult> {
    const { conn, adapterId } = this.#ctx.resolver.resolveConnection(tableNodeId)
    this.#ctx.activity.assertNoActiveImport(conn.id, '删除行')
    if (adapterId === null) {
      throw new Error('连接节点不能删除行，请选择具体的表')
    }
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error('没有要删除的行（keys 为空）——为避免误删整表，已拒绝')
    }
    return this.#write(conn.id, () => conn.host.deleteRows(adapterId, keys))
  }

  /**
   * 统计表行数。
   *
   * **注意：这是显式动作，任何懒加载路径都不得调用它**（大表 COUNT(*) 是全表扫描）。
   * 方法独立存在、不在 listChildren/describeTable 里被调用，就是这条约束的体现；
   * e2e 里有一条断言专门验证「列目录不会触发它」。
   */
  async countRows(tableNodeId: string): Promise<number> {
    const { conn, adapterId } = this.#ctx.resolver.resolveConnection(tableNodeId)
    if (adapterId === null) {
      throw new Error('连接节点没有行数，请选择具体的表')
    }
    return conn.host.countRows(adapterId)
  }

  /**
   * 建表。`connectionId` 可以是 `connection:c1` 也可以是裸 `c1`——统一用
   * `resolveConnectionLike` 归一：有前缀就解析，没有就当作裸 id。这样 UI 传
   * 节点 id 或连接 id 都能工作，减少一类「参数形态不对」的隐 bug。
   */
  async createTable(connectionId: string, spec: TableCreateSpec): Promise<void> {
    const { conn } = this.#ctx.resolver.resolveConnectionLike(connectionId)
    this.#ctx.activity.assertNoActiveImport(conn.id, '建表')
    // adapter 层用不到 connectionId，但仍按契约传（见 DriverAdapter 注释）。
    return this.#write(conn.id, () => conn.host.createTable(conn.id, spec))
  }

  /**
   * 删表。
   *
   * ===== 主进程只做连接解析，不解析表名 =====
   *
   * `tableNodeId` 形如 `connection:c1|table:users`。这里把**完整 adapterId**
   * （`table:users`）原样传给宿主。为什么不自己切出 `users`：
   *   - 驱动私有 id 编码可能带转义（sqlite 的 column id 就有 `\.` 转义），
   *     主进程猜规则迟早猜错；
   *   - 这与 applyEdits / insertRow 的处理方式完全一致，「id 由生成它的驱动解析」
   *     是一条统一的边界规则。
   */
  async dropTable(tableNodeId: string): Promise<void> {
    const { conn, adapterId } = this.#ctx.resolver.resolveConnection(tableNodeId)
    this.#ctx.activity.assertNoActiveImport(conn.id, '删表')
    if (adapterId === null) throw new Error('连接节点不能删除，请选择具体的表')
    return this.#write(conn.id, () => conn.host.dropTable(adapterId))
  }

  async createView(connectionId: string, viewName: string, selectSql: string): Promise<void> {
    const { conn } = this.#ctx.resolver.resolveConnectionLike(connectionId)
    this.#ctx.activity.assertNoActiveImport(conn.id, '建视图')
    return this.#write(conn.id, () => conn.host.createView(conn.id, viewName, selectSql))
  }

  async dropView(viewNodeId: string): Promise<void> {
    const { conn, adapterId } = this.#ctx.resolver.resolveConnection(viewNodeId)
    this.#ctx.activity.assertNoActiveImport(conn.id, '删视图')
    if (adapterId === null) throw new Error('连接节点不能删除，请选择具体的视图')
    return this.#write(conn.id, () => conn.host.dropView(adapterId))
  }

  async renameTable(tableNodeId: string, newName: string): Promise<void> {
    const { conn, adapterId } = this.#ctx.resolver.resolveConnection(tableNodeId)
    this.#ctx.activity.assertNoActiveImport(conn.id, '重命名表')
    if (adapterId === null) throw new Error('连接节点不能重命名，请选择具体的表')
    return this.#write(conn.id, () => conn.host.renameTable(adapterId, newName))
  }

  /**
   * 在途写租约的统一包装。
   *
   * 调用方必须**已经**完成 `assertNoActiveImport` 与全部同步前置校验；
   * 这里只负责 `beginWrite` → 执行 → `finally endWrite`。
   * `beginWrite` 与 `action()` 之间没有 await，因此租约在首个 await 之前生效。
   */
  async #write<T>(connectionId: string, action: () => Promise<T>): Promise<T> {
    this.#ctx.activity.beginWrite(connectionId)
    try {
      return await action()
    } finally {
      this.#ctx.activity.endWrite(connectionId)
    }
  }
}
