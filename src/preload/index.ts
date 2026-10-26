/**
 * preload：把主进程能力**按白名单**暴露给渲染进程。
 *
 * ===== 为什么要这一层，而不是直接把 ipcRenderer 给页面 =====
 *
 * 直接暴露 `ipcRenderer` 等于把整个 IPC 面全开：页面里任何一段代码
 * （包括被注入的、或某个第三方脚本）都能调用任意通道。
 *
 * 这里显式枚举 **33 个**方法（第一~五阶段 21 + 第六阶段 6 + 第七阶段 1 + 第八阶段 5），
 * 多一个都没有。这份清单与 `DbStudioApi` 是同一份类型：主进程实现它、
 * preload 转发它、渲染进程消费它、测试也验它，任何一边改了签名，`tsc` 会立刻报错。
 *
 * ===== 第二阶段为什么从 7 个扩到 11 个（一次刻意的能力面扩张） =====
 *
 * 新增的四个是：
 *   runQuery         渲染进程不可能自己执行 SQL——它没有连接，也不该有
 *   fetchResultPage  虚拟滚动的主通道，不暴露就没法分页取数
 *   closeCursor      结果集网格关闭时必须能释放宿主侧的游标
 *   previewTable     双击表名看数据，是最常用的入口
 *
 * 判据是「渲染进程有没有**不能自己完成**的正当需求」：
 * 这四个都属于「必须跨进程才能做」，所以加进白名单是必要的，不是顺手加的。
 * 反面例子是 `quoteIdentifier` 之类纯函数——那种绝不加进来，
 * 渲染进程能本地算的东西没有任何理由跨进程。
 *
 * 注意新增的四个都只接受**字符串/数字参数**，不接受回调、不接受对象里的函数，
 * 这是 contextBridge 的硬约束（只能传结构化克隆的值），也是我们的协议约束。
 *
 * ===== 第三阶段为什么扩到 15 个 =====
 *
 * 在线编辑必须跨进程（渲染进程没有连接、也不该有），四个缺一不可：
 *   applyEdits          把网格里的改动写回数据库。**它不自动提交**，
 *                       所以下面三个同样是必需的，不是可选的补充。
 *   commitTransaction   用户点"应用"时才真正落盘。没有它，改动永远进不了库；
 *                       UI 也因此才有"改完还能反悔"的语义。
 *   rollbackTransaction 用户点"撤销"时丢弃改动。没有它，一次误改只能靠重连。
 *   transactionState    驱动"有未提交改动"提示与按钮可用性。
 *                       没有它，UI 只能靠猜自己有没有未提交事务——
 *                       而猜错的方向恰恰是最坏的那个（以为没提交、其实已提交）。
 *
 * 这四条构成一个**不可拆的最小集合**：只给 applyEdits 而不给提交/回滚，
 * 等于把连接永久卡在未提交事务里（还占着行锁）。所以要么全给，要么全不给。
 *
 * 参数形状上，`applyEdits` 传的是纯结构化数据（`RowUpdate[]`，只含字符串/数字/
 * 布尔/CellValue 对象），可以安全过 contextBridge；**不接受函数、不接受回调**。
 *
 * ===== 第四阶段为什么扩到 17 个 =====
 *
 * 持久化之后，"配置"与"会话"分开了，需要两个显式动作来切换会话状态：
 *   connectConnection     对已保存的连接建立会话。没有它，重启后用户看到
 *                         一堆连接却点不亮——持久化就只存了个摆设。
 *   disconnectConnection  关会话但保留配置。没有它，用户想临时断开只能
 *                         removeConnection（那会把配置一起删掉，等于丢数据）。
 *
 * 注意 `addConnection` 的语义也在这阶段变了（先落盘再连），但它本来就在白名单里，
 * 因此列表数量只增加 2。这两个方法都只接受一个字符串 id，无结构化克隆风险。
 *
 * ===== 第五阶段为什么扩到 21 个 =====
 *
 * 补的是「增删改里只有改」的三个功能缺口，外加「看不到截断值全文」。四个都不可拆：
 *   insertRow       插不了新记录，用户就没法真正用这个客户端录入数据。
 *   deleteRows      删不掉记录，是审计指出的最大缺口。
 *   countRows       用户需要知道"到底有多少行"；但它**必须**是显式动作
 *                   （大表 COUNT(*) 是全表扫描），所以单列一个通道而不是塞进
 *                   listChildren 的返回里——放进去等于每次展开目录都全表扫描。
 *   fetchCellValue  结果集为省 IPC 把超长文本截断到 1000 字符，没有它就永远
 *                   看不到全文，用户只能看到"…"。
 *
 * 四个参数形状都是纯结构化数据（`CellValue` 对象 / 字符串 / 数字），可安全过
 * contextBridge；同样**不接受函数、不接受回调**。
 *
 * ===== 第六阶段为什么扩到 27 个 =====
 *
 * DDL 五条 + 编辑连接一条。它们对应两个"日常立刻撞上"的缺口：
 *   建不了表、删不了表（界面里连一张表都造不出来）；
 *   已保存的连接改不了参数（路径填错只能删掉重建，等于丢配置）。
 *
 *   createTable / dropTable     建表/删表——DDL 的最小可用集合
 *   createView / dropView       视图同理，必须和能力成对出现
 *   renameTable                 重命名是高频操作；没有它只能建新表+搬数据
 *   updateConnection            编辑已保存连接（改配置/改密码），会话自动重连生效
 *
 * 六个参数形态：连接 id / 节点 id / `TableCreateSpec`（纯数据对象）/ 字符串。
 * `TableCreateSpec` 里只有字符串、布尔、数字与数组，可安全结构化克隆。
 *
 * ===== 第七阶段为什么扩到 28 个 =====
 *
 * 只加了一条：
 *   cancelQuery   取消某连接上正在执行的查询。
 *
 * 它必须跨进程，因为"正在跑的查询"只存在于驱动宿主进程里——渲染进程连
 * 自己是哪条连接都不知道，更没法去中断别人。参数只有一个节点 id（纯字符串），
 * 用于定位连接（UI 上可能同时有多个连接在跑查询）。
 *
 * 注意返回值语义刻意做成三态而不是布尔二选一：`true` 表示后端确实中断了；
 * `false` 表示**要么驱动不支持（SQLite）、要么当时没有在跑的查询**。
 * UI 必须先看能力位 `supportsCancel`，否则会把"不支持"误报成"取消了"。
 *
 * 这一阶段还改了 renderer 里的排序/列宽持久化、连接颜色、连接分组，
 * 但那三项都不需要新的跨进程能力（前者用 localStorage，后两者是纯前端组织），
 * 所以白名单只增加了 1 个。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { API_GLOBAL, IPC, type DbStudioApi } from '../core/api'
import type { ConnectionConfig } from '../core/dialect'
import type { SecretInput } from '../core/driver'
import type { ObjectRef, TableCreateSpec, TableDescription } from '../core/model'
import type { ConnectionSummary } from '../core/api'
import type { CellValue, QueryOptions, QueryResult, ResultPage, StatementResult } from '../core/resultset'
import type {
  RecordSqlHistoryInput,
  SavedSql,
  SqlHistoryEntry,
  SqlLibrarySnapshot
} from '../core/sql-library'
import type {
  EditApplyResult,
  RowUpdate,
  TransactionState
} from '../core/resultset'

const api: DbStudioApi = {
  listDialects: () => ipcRenderer.invoke(IPC.listDialects),
  listConnections: () => ipcRenderer.invoke(IPC.listConnections) as Promise<ConnectionSummary[]>,
  addConnection: (config: ConnectionConfig, secret?: SecretInput) =>
    ipcRenderer.invoke(IPC.addConnection, config, secret) as Promise<ConnectionSummary>,

  /**
   * 为已保存的连接建立会话。
   *
   * 与 addConnection 的分工：add 负责"存一条新的配置并尝试连"，
   * 这两个只对**已存在的 id** 开会话/关会话，不带配置参数。
   */
  connectConnection: (connectionId: string) =>
    ipcRenderer.invoke(IPC.connectConnection, connectionId) as Promise<ConnectionSummary>,

  /** 关闭会话但保留配置：下次还能再连，这是持久化的意义所在。 */
  disconnectConnection: (connectionId: string) =>
    ipcRenderer.invoke(IPC.disconnectConnection, connectionId) as Promise<ConnectionSummary>,

  removeConnection: (connectionId: string) =>
    ipcRenderer.invoke(IPC.removeConnection, connectionId) as Promise<void>,
  testConnection: (config: ConnectionConfig, secret?: SecretInput) =>
    ipcRenderer.invoke(IPC.testConnection, config, secret),
  listChildren: (nodeId: string | null) =>
    ipcRenderer.invoke(IPC.listChildren, nodeId) as Promise<ObjectRef[]>,
  describeTable: (tableNodeId: string) =>
    ipcRenderer.invoke(IPC.describeTable, tableNodeId) as Promise<TableDescription>,

  // ---- 结果集（第二阶段） ----

  runQuery: (nodeId: string, sql: string, options?: QueryOptions) =>
    ipcRenderer.invoke(IPC.runQuery, nodeId, sql, options) as Promise<QueryResult>,

  executeStatement: (nodeId: string, sql: string, options?: QueryOptions) =>
    ipcRenderer.invoke(IPC.executeStatement, nodeId, sql, options) as Promise<StatementResult>,

  /**
   * 注意 `cursorId` 必须**原样**回传 runQuery 给的那个值。
   * 它带连接归属前缀（形如 `connection:c1|cur-3`），主进程靠前缀定位宿主；
   * UI 应该把它当不透明字符串存着，不要尝试解析或自己拼。
   */
  fetchResultPage: (cursorId: string, offset: number, limit: number) =>
    ipcRenderer.invoke(IPC.fetchResultPage, cursorId, offset, limit) as Promise<ResultPage>,

  closeCursor: (cursorId: string) =>
    ipcRenderer.invoke(IPC.closeCursor, cursorId) as Promise<void>,

  previewTable: (nodeId: string, limit?: number) =>
    ipcRenderer.invoke(IPC.previewTable, nodeId, limit) as Promise<QueryResult>,

  // ---- 在线编辑与事务（第三阶段） ----

  /**
   * 提交一批行修改。**不会自动落盘**——必须显式调 commitTransaction。
   * `nodeId` 是表节点 id；`updates` 用主键值定位行（不是行下标，见 core/resultset.ts）。
   */
  applyEdits: (tableNodeId: string, updates: readonly RowUpdate[]) =>
    ipcRenderer.invoke(IPC.applyEdits, tableNodeId, updates) as Promise<EditApplyResult>,

  commitTransaction: (nodeId: string) =>
    ipcRenderer.invoke(IPC.commitTransaction, nodeId) as Promise<TransactionState>,

  rollbackTransaction: (nodeId: string) =>
    ipcRenderer.invoke(IPC.rollbackTransaction, nodeId) as Promise<TransactionState>,

  transactionState: (nodeId: string) =>
    ipcRenderer.invoke(IPC.transactionState, nodeId) as Promise<TransactionState>,

  // ---- 增删与完整取值（第五阶段） ----

  /**
   * 插入一行，返回新行主键（`keyValues`）让 UI 能定位它。**不自动提交**。
   */
  insertRow: (tableNodeId: string, values: Readonly<Record<string, CellValue>>) =>
    ipcRenderer.invoke(IPC.insertRow, tableNodeId, values) as Promise<{
      affected: number
      keyValues: Record<string, CellValue>
    }>,

  /** 按主键批量删除。空数组会被拒绝（空 WHERE 会删整表）。**不自动提交**。 */
  deleteRows: (
    tableNodeId: string,
    keys: readonly Readonly<Record<string, CellValue>>[]
  ) => ipcRenderer.invoke(IPC.deleteRows, tableNodeId, keys) as Promise<EditApplyResult>,

  /** 统计行数。**显式动作**，大表上是全表扫描，UI 不要在展开目录时自动调用。 */
  countRows: (tableNodeId: string) =>
    ipcRenderer.invoke(IPC.countRows, tableNodeId) as Promise<number>,

  /**
   * 取单格完整值。用 `runQuery` 返回的 cursorId（带连接前缀，原样回传），
   * 解决"超长文本被截断到 1000 字符看不懂"的问题。
   */
  fetchCellValue: (cursorId: string, rowIndex: number, columnIndex: number) =>
    ipcRenderer.invoke(IPC.fetchCellValue, cursorId, rowIndex, columnIndex) as Promise<CellValue>,

  // ---- DDL 与编辑连接（第六阶段） ----

  /** 建表。成功后 listChildren 立刻能看到（DDL 已提交）。 */
  createTable: (connectionId: string, spec: TableCreateSpec) =>
    ipcRenderer.invoke(IPC.createTable, connectionId, spec) as Promise<void>,

  /** 删表。`nodeId` 是节点 id（如 `connection:c1|table:users`）。 */
  dropTable: (nodeId: string) => ipcRenderer.invoke(IPC.dropTable, nodeId) as Promise<void>,

  /** 建视图：`CREATE VIEW <viewName> AS <selectSql>`。 */
  createView: (connectionId: string, viewName: string, selectSql: string) =>
    ipcRenderer.invoke(IPC.createView, connectionId, viewName, selectSql) as Promise<void>,

  /** 删视图。`nodeId` 是节点 id。 */
  dropView: (nodeId: string) => ipcRenderer.invoke(IPC.dropView, nodeId) as Promise<void>,

  /** 重命名表。`nodeId` 是节点 id，`newName` 是新表名。 */
  renameTable: (nodeId: string, newName: string) =>
    ipcRenderer.invoke(IPC.renameTable, nodeId, newName) as Promise<void>,

  /**
   * 取消某个节点所属连接上正在执行的查询。
   *
   * `nodeId` 用于定位连接（UI 上可能同时有多个连接在跑查询）。
   * 返回 true 表示后端确实中断了；false 表示该驱动不支持取消（SQLite）
   * 或当时并没有在跑的查询。UI 应先看能力的 `supportsCancel`。
   */
  cancelQuery: (nodeId: string) =>
    ipcRenderer.invoke(IPC.cancelQuery, nodeId) as Promise<boolean>,

  /**
   * 编辑已保存连接。若当前已连接，主进程内部会断开重连，使新配置生效；
   * 原本断开的连接更新后仍保持断开（不自作主张连库）。
   */
  updateConnection: (
    connectionId: string,
    config: Partial<ConnectionConfig>,
    secret?: SecretInput
  ) =>
    ipcRenderer.invoke(
      IPC.updateConnection,
      connectionId,
      config,
      secret
    ) as Promise<ConnectionSummary>,

  // ---- SQL 历史与收藏（第八阶段） ----

  listSqlLibrary: () =>
    ipcRenderer.invoke(IPC.listSqlLibrary) as Promise<SqlLibrarySnapshot>,
  recordSqlHistory: (input: RecordSqlHistoryInput) =>
    ipcRenderer.invoke(IPC.recordSqlHistory, input) as Promise<SqlHistoryEntry>,
  saveSql: (id: string | null, name: string, sql: string) =>
    ipcRenderer.invoke(IPC.saveSql, id, name, sql) as Promise<SavedSql>,
  removeSavedSql: (id: string) =>
    ipcRenderer.invoke(IPC.removeSavedSql, id) as Promise<void>,
  clearSqlHistory: () => ipcRenderer.invoke(IPC.clearSqlHistory) as Promise<void>
}

contextBridge.exposeInMainWorld(API_GLOBAL, api)
