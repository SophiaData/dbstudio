/**
 * 连接管理器（主进程）——兼容 facade。
 *
 * ===== 现在还剩什么 =====
 *
 * 经过逐轮拆分与本轮组合根抽取，本类只保留一件东西：**公开契约**。
 * `main/index.ts`、探针与测试都只认 ConnectionManager，每个方法都只是把
 * 请求转给 `createApplicationServices()` 产出的服务包，不在本类里写业务实现，
 * 也不包含任何服务装配细节或私有日志出口。
 *
 * 所有用例服务的创建、依赖注入与构造环（任务组 → 会话 → 解析器）的处理
 * 集中在 `./application/create-application-services`。本类持有的
 * `#services` 只是组合结果引用，不复制任何业务状态。
 *
 * 连接自身的增删改查、连接/断开、测试连接与退出回收见
 * `./application/connection-application-service`；树节点 id 的作用域封装
 * 规则仍只定义在 `core/api.ts` 的 `NodeId` 里一次，UI 与测试共用。
 */

import {
  type DataCompareRequest,
  type DataCompareResult,
  type SchemaSnapshot
} from '../core/compare'
import type { ConnectionConfig } from '../core/dialect'
import type { RemoteOutboundPolicy } from '../backend/contract/remote'
import type { DialectInfo, SecretInput, TestConnectionResult } from '../core/driver'
import type { ConnectionSummary } from '../core/api'
import type { ObjectRef, TableCreateSpec, TableDescription } from '../core/model'
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
import type { ConnectionStore } from './ConnectionStore'
import {
  createApplicationServices,
  type ApplicationServices
} from './application/create-application-services'
import type { ConnectionLeaseFactory, ConnectionLogger, DriverHostFactory } from './application/types'
import type {
  ImportPreview,
  ImportPreviewRequest,
  ImportProgress,
  ImportRequest,
  ImportResult,
  TransferProgress,
  TransferRequest,
  TransferResult
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

/**
 * 游标 id 的作用域封装（`connection:<cid>|<native>`）与生存账本
 * 已移到 `./application/cursor-registry`。本类只负责把游标和活动会话关联。
 */

export interface ConnectionManagerOptions {
  readonly onLog?: ConnectionLogger
  readonly createDriverHost?: DriverHostFactory
  /** 显式提供才启用远程连接 DTO 与出站目标校验；默认桌面模式不改变。 */
  readonly remoteOutboundPolicy?: RemoteOutboundPolicy
  /** 显式提供才启用 owner 连接租约；默认桌面模式不受治理配额影响。 */
  readonly reserveConnection?: ConnectionLeaseFactory
}

export class ConnectionManager {
  /**
   * 组合根创建并接线的全部用例服务。
   *
   * 这里只保存引用，不复制任何服务内部状态；公开方法全部转发给它。
   * 装配顺序与构造环的处理见 `./application/create-application-services`。
   */
  readonly #services: ApplicationServices

  constructor(
    dialects: readonly DialectInfo[],
    store: ConnectionStore,
    options: ConnectionManagerOptions = {}
  ) {
    this.#services = createApplicationServices(dialects, store, {
      onLog: options.onLog,
      createDriverHost: options.createDriverHost,
      remoteOutboundPolicy: options.remoteOutboundPolicy,
      reserveConnection: options.reserveConnection
    })
  }

  listDialects(): DialectInfo[] {
    return this.#services.connections.listDialects()
  }

  /**
   * 列出**所有已保存的连接**（含未连接的）。
   *
   * 语义相对第一阶段变了：以前只返回活动会话，现在返回配置清单。
   * 依据是 `core/api.ts` 里 `listConnections` 的注释——UI 需要看到
   * "存了但没连"的连接才能让用户点它去连。
   *
   * 投影、保存顺序与 secretStored 判定见
   * `./application/connection-application-service`。
   */
  list(): ConnectionSummary[] {
    return this.#services.connections.list()
  }

  /**
   * 新建连接：**先落盘，再尝试连通**（契约要求，也是正确的顺序）。
   *
   * 先存后连的顺序、连接失败返回 `connected:false` 而不是抛错、
   * 安全存储不可用时配置仍保存、secret 进本次会话缓存等规则见
   * `./application/connection-application-service`。
   */
  async add(config: ConnectionConfig, secret?: SecretInput): Promise<ConnectionSummary> {
    return this.#services.connections.add(config, secret)
  }

  /**
   * 为已保存的连接建立会话（`add` 之后的重连、或启动后用户点"连接"）。
   *
   * 幂等、disposed 与不存在语义见
   * `./application/connection-application-service`。
   */
  async connectConnection(connectionId: string): Promise<ConnectionSummary> {
    return this.#services.connections.connectConnection(connectionId)
  }

  /** 关闭会话但保留配置；同步失效旧会话，再等待回滚和子进程退出。 */
  async disconnectConnection(connectionId: string): Promise<ConnectionSummary> {
    return this.#services.connections.disconnectConnection(connectionId)
  }

  async remove(connectionId: string): Promise<void> {
    return this.#services.connections.remove(connectionId)
  }

  /**
   * 测试连接：创建独立宿主、handshake 后 testConnection，finally 关闭。
   *
   * 实现见 `./application/connection-application-service`。
   */
  async testConnection(
    config: ConnectionConfig,
    secret?: SecretInput
  ): Promise<TestConnectionResult> {
    return this.#services.connections.testConnection(config, secret)
  }

  /**
   * 列子节点。
   *
   * 根层投影与作用域 id 重写见 `./application/metadata-application-service`：
   *  - 根层（null）返回的是「连接」本身，不是 adapter 的数据；
   *  - 连接层（adapterId === null）调 adapter 的 `listChildren(null)`；
   *  - 子节点的 parentId 改写成本层的**作用域 id**，否则 UI 建树会接错。
   */
  async listChildren(nodeId: string | null): Promise<ObjectRef[]> {
    return this.#services.metadata.listChildren(nodeId)
  }

  describeTable(nodeId: string): Promise<TableDescription> {
    return this.#services.metadata.describeTable(nodeId)
  }

  /**
   * 只读结构快照。展开表和视图后逐个 describe，不执行任何同步 SQL。
   *
   * 遍历深度、schema 过滤、视图 DDL 与例程读取的失败降级规则见
   * `./application/metadata-application-service`。
   */
  async captureSchemaSnapshot(
    connectionId: string,
    schema?: string | null
  ): Promise<SchemaSnapshot> {
    return this.#services.metadata.captureSchemaSnapshot(connectionId, schema)
  }

  /**
   * 按唯一键比较两张表的数据，返回差异与同步计划。
   *
   * 只读：两侧都只跑 SELECT（runQuery），同步 SQL 只生成不执行。
   * 方言守卫、maxRows 上限与二进制列处理见
   * `./application/compare-application-service`。
   */
  async compareTableData(request: DataCompareRequest): Promise<DataCompareResult> {
    return this.#services.compares.compareTableData(request)
  }

  /** 应用退出时统一回收所有宿主进程。 */
  async disposeAll(): Promise<void> {
    return this.#services.connections.disposeAll()
  }

  // ---- 流式导出（P2.1） ----

  /**
   * 启动一个导出任务。
   *
   * 参数错误同步抛出（格式不对、路径为空、来源不完整）；
   * 任务本身异步跑，调用方拿 taskId 去轮询进度。
   *
   * 同步校验、来源打开与目标路径保护见
   * `./application/transfer-application-service`。本方法只保留公开契约。
   */
  startTransfer(request: TransferRequest): TransferProgress {
    return this.#services.transfers.startTransfer(request)
  }

  /** 取导出任务进度。未知 id 返回 undefined。 */
  getTransferProgress(taskId: string): TransferProgress | undefined {
    return this.#services.transfers.getTransferProgress(taskId)
  }

  /** 取消导出任务。返回 false 表示任务不存在、已结束或已进入不可取消的提交阶段。 */
  cancelTransfer(taskId: string): boolean {
    return this.#services.transfers.cancelTransfer(taskId)
  }

  /** 等待导出任务结束，返回终态结果。 */
  async waitTransfer(taskId: string): Promise<TransferResult> {
    return this.#services.transfers.waitTransfer(taskId)
  }

  /** 在主进程读取 CSV 并返回有界预览；完整文件内容不会经过 IPC。 */
  async previewImport(request: ImportPreviewRequest): Promise<ImportPreview> {
    return this.#services.imports.previewImport(request)
  }

  /**
   * 启动一个导入任务。
   *
   * 同步校验（连接存在、未在关闭、无在途外部写）与任务编排见
   * `./application/import-application-service`。本方法只保留公开契约。
   */
  startImport(request: ImportRequest): ImportProgress {
    return this.#services.imports.startImport(request)
  }

  getImportProgress(taskId: string): ImportProgress | undefined {
    return this.#services.imports.getImportProgress(taskId)
  }

  cancelImport(taskId: string): boolean {
    return this.#services.imports.cancelImport(taskId)
  }

  async waitImport(taskId: string): Promise<ImportResult> {
    return this.#services.imports.waitImport(taskId)
  }

  // ---- 结果集（第二阶段） ----

  /**
   * 执行 SQL，返回第一页。
   *
   * 实现见 `./application/query-application-service`：连接解析、会话身份校验
   * 与游标作用域封装都在那里，本方法只保留公开契约。
   */
  async runQuery(
    nodeId: string,
    sql: string,
    options?: QueryOptions,
    signal?: AbortSignal
  ): Promise<QueryResult> {
    return this.#services.queries.runQuery(nodeId, sql, options, signal)
  }

  /**
   * 执行一条 SQL 语句（查询、DML 或 DDL）。
   * 若结果包含游标，同样进行连接归属作用域包装与账本登记。
   */
  async executeStatement(nodeId: string, sql: string, options?: QueryOptions): Promise<StatementResult> {
    return this.#services.queries.executeStatement(nodeId, sql, options)
  }

  /** 按连接所属驱动生成执行计划，不在主进程拼接方言关键字。 */
  async explain(nodeId: string, sql: string): Promise<ExplainResult> {
    return this.#services.queries.explain(nodeId, sql)
  }

  /** 从游标按偏移量取一页。入参若是坏 id 会立刻报错，不会挂死。 */
  async fetchResultPage(cursorId: string, offset: number, limit: number): Promise<ResultPage> {
    return this.#services.queries.fetchResultPage(cursorId, offset, limit)
  }

  /**
   * 释放游标。
   *
   * 幂等：重复关闭、关闭一个不存在的游标都不报错。
   * 这与宿主侧 `closeCursor` 不做 requireConnected 的决定是配套的——
   * 网格关闭时会无条件调用它，这条路径上任何噪音错误都会变成用户可见的弹窗。
   */
  async closeCursor(cursorId: string): Promise<void> {
    return this.#services.queries.closeCursor(cursorId)
  }

  /**
   * 按对象 id 生成「读取该表/视图」的 SELECT。表名限定与引号由驱动决定，主进程不猜。
   */
  async tableSelectSql(nodeId: string): Promise<string> {
    return this.#services.queries.tableSelectSql(nodeId)
  }

  /**
   * 便捷方法：预览一张表 / 视图。
   *
   * 表名限定与引号由驱动生成；行数限制经 QueryOptions.limit 交给 adapter，
   * 并在返回后兜底校验 adapter 是否真的落实了 limit。
   */
  async previewTable(nodeId: string, limit = 200): Promise<QueryResult> {
    return this.#services.queries.previewTable(nodeId, limit)
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
    return this.#services.mutations.applyEdits(tableNodeId, updates)
  }

  /**
   * 提交事务。
   *
   * 无活动事务时**不静默成功**：那说明 UI 状态与后端不一致，
   * 静默成功会让"用户以为保存了、其实什么都没发生"这种最坏的 bug 悄悄发生。
   */
  async commitTransaction(nodeId: string): Promise<TransactionState> {
    return this.#services.mutations.commitTransaction(nodeId)
  }

  /** 回滚事务。幂等——重复回滚、回滚一个没有事务的连接都不该报错。 */
  async rollbackTransaction(nodeId: string): Promise<TransactionState> {
    return this.#services.mutations.rollbackTransaction(nodeId)
  }

  /**
   * 查询事务状态。
   *
   * `nodeId` 只用来定位连接：事务是**连接级**的状态，宿主进程内的
   * adapter 实例持有它。因此这里传连接根节点（`connection:c1`）也可以，
   * UI 不必先知道某张表。
   */
  async transactionState(nodeId: string): Promise<TransactionState> {
    return this.#services.mutations.transactionState(nodeId)
  }

  // ---- 增删与完整取值（第五阶段） ----

  /**
   * 插入一行（不自动提交）。
   *
   * `tableNodeId` 由服务解析出连接与 adapterId；adapterId 原样
   * 交给宿主——adapter 自己认识 `table:<name>`，主进程不解析驱动私有 id。
   */
  async insertRow(
    tableNodeId: string,
    values: Readonly<Record<string, CellValue>>
  ): Promise<{ affected: number; keyValues: Record<string, CellValue> }> {
    return this.#services.mutations.insertRow(tableNodeId, values)
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
    return this.#services.mutations.deleteRows(tableNodeId, keys)
  }

  /**
   * 统计表行数。
   *
   * **注意：这是显式动作，任何懒加载路径都不得调用它**（大表 COUNT(*) 是全表扫描）。
   * 方法独立存在、不在 listChildren/describeTable 里被调用，就是这条约束的体现；
   * e2e 里有一条断言专门验证"列目录不会触发它"。
   */
  async countRows(tableNodeId: string): Promise<number> {
    return this.#services.mutations.countRows(tableNodeId)
  }

  /**
   * 取单格完整值。
   *
   * `cursorId` 是 runQuery 返回的**带连接作用域**的 id，故先经
   * `resolver.resolveCursor` 还原成「连接 + 原生游标 id」再转发——
   * 与 fetchResultPage 同一套规则。实现见
   * `./application/query-application-service`。
   */
  async fetchCellValue(
    cursorId: string,
    rowIndex: number,
    columnIndex: number
  ): Promise<CellValue> {
    return this.#services.queries.fetchCellValue(cursorId, rowIndex, columnIndex)
  }

  // ---- DDL 与编辑连接（第六阶段） ----

  /**
   * 建表。`connectionId` 可以是 `connection:c1` 也可以是裸 `c1`——统一用
   * `NodeId.parse` 归一：有前缀就解析，没有就当作裸 id。这样 UI 传节点 id
   * 或连接 id 都能工作，减少一类"参数形态不对"的隐 bug。
   */
  async createTable(connectionId: string, spec: TableCreateSpec): Promise<void> {
    return this.#services.mutations.createTable(connectionId, spec)
  }

  /**
   * 删表。
   *
   * ===== 主进程只做连接解析，不解析表名 =====
   *
   * `tableNodeId` 形如 `connection:c1|table:users`。主进程把**完整 adapterId**
   * （`table:users`）原样传给宿主。为什么不自己切出 `users`：
   *   - 驱动私有 id 编码可能带转义（sqlite 的 column id 就有 `\.` 转义），
   *     主进程猜规则迟早猜错；
   *   - 这与 applyEdits / insertRow 的处理方式完全一致，"id 由生成它的驱动解析"
   *     是一条统一的边界规则。
   */
  async dropTable(tableNodeId: string): Promise<void> {
    return this.#services.mutations.dropTable(tableNodeId)
  }

  async createView(connectionId: string, viewName: string, selectSql: string): Promise<void> {
    return this.#services.mutations.createView(connectionId, viewName, selectSql)
  }

  async dropView(viewNodeId: string): Promise<void> {
    return this.#services.mutations.dropView(viewNodeId)
  }

  /**
   * 取消某个节点所属连接上正在执行的查询。
   *
   * 为什么按 nodeId 而不是 connectionId：UI 手上只有当前格子/标签对应的节点，
   * 让 UI 自己去反查连接会多一层容易出错的状态。解析与转发的细节见
   * `./application/query-application-service`。
   */
  async cancelQuery(nodeId: string, signalId?: string): Promise<boolean> {
    return this.#services.queries.cancelQuery(nodeId, signalId)
  }

  async renameTable(tableNodeId: string, newName: string): Promise<void> {
    return this.#services.mutations.renameTable(tableNodeId, newName)
  }

  /**
   * 编辑已保存的连接。
   *
   * ===== 三步，顺序不能反 =====
   *
   * 先落盘新配置（+ 密码若给了）→ 原本连着才断开 → 原本连着才重连。
   * `options` 浅合并、secrets 按 key 合并、方言 lookup 与全部日志/错误文案
   * 见 `./application/connection-application-service`。
   */
  async updateConnection(
    connectionId: string,
    config: Partial<ConnectionConfig>,
    secret?: SecretInput
  ): Promise<ConnectionSummary> {
    return this.#services.connections.updateConnection(connectionId, config, secret)
  }

  /** 诊断用：当前连接数 / 游标账本条目数。让泄漏可以被观测而不是靠猜。 */
  stats(): { connections: number; openCursors: number } {
    return this.#services.connections.stats()
  }
}
