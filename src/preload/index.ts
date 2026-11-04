/**
 * preload：把主进程能力**按白名单**暴露给渲染进程。
 *
 * ===== 为什么要这一层，而不是直接把 ipcRenderer 给页面 =====
 *
 * 直接暴露 `ipcRenderer` 等于把整个 IPC 面全开：页面里任何一段代码
 * （包括被注入的、或某个第三方脚本）都能调用任意通道。
 *
 * 这里显式枚举 **48 个**方法，覆盖连接、查询、事务、DDL、比较、SQL library、导入和导出，
 * 多一个都没有。具体发布面由 `BACKEND_METHOD_MANIFEST` 与 golden snapshot 固定。
 *
 * P2.3 的第五个是**系统文件选择器**（chooseImportFile）：
 * 它只回一个绝对路径，**不读文件、不回传内容**。
 * 之所以值得单独开一条通道：渲染进程没有读任意路径的能力，
 * 而"用户自己挑一个文件"是渲染进程自己做不到、又正当需要的能力。
 * 但它也**不能**变成通用读文件通道——所以入参为空、返回值只有路径。
 *
 * P2.1 新增的四个是流式导出的生命周期接口：
 *   startTransfer       启动导出任务（同步返回 taskId 与初始进度）
 *   getTransferProgress 轮询进度（不用事件推送，导出面板本来就要定时刷新）
 *   cancelTransfer      任务级取消（不影响同连接的其它查询）
 *   waitTransfer        等任务结束、拿终态结果
 *
 * 刻意**不**暴露"读导出数据"的通道：渲染进程永远拿不到行，
 * 内存占用与总行数无关——这正是整个 P2.1 设计的核心目的。这份清单与 `DbStudioApi` 是同一份类型：主进程实现它、
 * preload 转发它、渲染进程消费它、测试也验它，任何一边改了签名，`tsc` 会立刻报错。
 *
 * P2.3 同样只暴露导入任务的生命周期接口，不暴露 CSV 内容：
 *   startImport / getImportProgress / cancelImport / waitImport
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
import {
  backendErrorFromPayload,
  isBackendEnvelope,
  type BackendEnvelope
} from '../backend/contract/errors'
import type { DataCompareRequest, DataCompareResult, SchemaSnapshot } from '../core/compare'
import type { ConnectionConfig } from '../core/dialect'
import type { DialectInfo, SecretInput, TestConnectionResult } from '../core/driver'
import type { ObjectRef, TableCreateSpec, TableDescription } from '../core/model'
import type { ConnectionSummary } from '../core/api'
import type { CellValue, ExplainResult, QueryOptions, QueryResult, ResultPage, StatementResult } from '../core/resultset'
import type {
  RecordSqlHistoryInput,
  SavedSql,
  SqlHistoryEntry,
  SqlLibrarySnapshot
} from '../core/sql-library'
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
import type {
  EditApplyResult,
  RowUpdate,
  TransactionState
} from '../core/resultset'

/**
 * 统一的后端调用入口。
 *
 * 所有对外方法都经过这里，通道仍然由 `IPC` 常量提供——helper 是模块内部函数，
 * 不存在「渲染进程可指定任意 channel」的入口。
 *
 * 三种返回值都要兼容：
 *   1. 成功信封 `{ ok: true, value }`：解包后返回业务值；
 *   2. 失败信封 `{ ok: false, error }`：还原成 `BackendError` 后抛出；
 *   3. 旧的 raw 返回值（测试替身或尚未迁移的 handler）：原样透传。
 *
 * 第 3 条是刻意的兼容层：GUI 测试会替换主进程 handler 并返回裸值，
 * 不能因为我们引入了信封就把这些既有测试/调用方弄坏。
 */
async function invokeBackend<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args)
  if (isBackendEnvelope(result)) {
    return unwrapEnvelope(result) as T
  }
  return result as T
}

/** 解包信封；失败时抛出带分类信息的 `BackendError`。 */
function unwrapEnvelope<T>(envelope: BackendEnvelope<T>): T {
  if (envelope.ok) return envelope.value
  throw backendErrorFromPayload(envelope.error)
}

const api: DbStudioApi = {
  listDialects: () => invokeBackend<DialectInfo[]>(IPC.listDialects),
  listConnections: () => invokeBackend(IPC.listConnections) as Promise<ConnectionSummary[]>,
  addConnection: (config: ConnectionConfig, secret?: SecretInput) =>
    invokeBackend(IPC.addConnection, config, secret) as Promise<ConnectionSummary>,

  /**
   * 为已保存的连接建立会话。
   *
   * 与 addConnection 的分工：add 负责"存一条新的配置并尝试连"，
   * 这两个只对**已存在的 id** 开会话/关会话，不带配置参数。
   */
  connectConnection: (connectionId: string) =>
    invokeBackend(IPC.connectConnection, connectionId) as Promise<ConnectionSummary>,

  /** 关闭会话但保留配置：下次还能再连，这是持久化的意义所在。 */
  disconnectConnection: (connectionId: string) =>
    invokeBackend(IPC.disconnectConnection, connectionId) as Promise<ConnectionSummary>,

  removeConnection: (connectionId: string) =>
    invokeBackend(IPC.removeConnection, connectionId) as Promise<void>,
  testConnection: (config: ConnectionConfig, secret?: SecretInput) =>
    invokeBackend<TestConnectionResult>(IPC.testConnection, config, secret),
  listChildren: (nodeId: string | null) =>
    invokeBackend(IPC.listChildren, nodeId) as Promise<ObjectRef[]>,
  describeTable: (tableNodeId: string) =>
    invokeBackend(IPC.describeTable, tableNodeId) as Promise<TableDescription>,
  captureSchemaSnapshot: (connectionId: string, schema?: string | null) =>
    invokeBackend(IPC.captureSchemaSnapshot, connectionId, schema) as Promise<SchemaSnapshot>,
  compareTableData: (request: DataCompareRequest) =>
    invokeBackend(IPC.compareTableData, request) as Promise<DataCompareResult>,

  // ---- 结果集（第二阶段） ----

  runQuery: (nodeId: string, sql: string, options?: QueryOptions) =>
    invokeBackend(IPC.runQuery, nodeId, sql, options) as Promise<QueryResult>,

  executeStatement: (nodeId: string, sql: string, options?: QueryOptions) =>
    invokeBackend(IPC.executeStatement, nodeId, sql, options) as Promise<StatementResult>,

  explain: (nodeId: string, sql: string) =>
    invokeBackend(IPC.explain, nodeId, sql) as Promise<ExplainResult>,

  /**
   * 注意 `cursorId` 必须**原样**回传 runQuery 给的那个值。
   * 它带连接归属前缀（形如 `connection:c1|cur-3`），主进程靠前缀定位宿主；
   * UI 应该把它当不透明字符串存着，不要尝试解析或自己拼。
   */
  fetchResultPage: (cursorId: string, offset: number, limit: number) =>
    invokeBackend(IPC.fetchResultPage, cursorId, offset, limit) as Promise<ResultPage>,

  closeCursor: (cursorId: string) =>
    invokeBackend(IPC.closeCursor, cursorId) as Promise<void>,

  previewTable: (nodeId: string, limit?: number) =>
    invokeBackend(IPC.previewTable, nodeId, limit) as Promise<QueryResult>,
  tableSelectSql: (nodeId: string) =>
    invokeBackend(IPC.tableSelectSql, nodeId) as Promise<string>,

  // ---- 在线编辑与事务（第三阶段） ----

  /**
   * 提交一批行修改。**不会自动落盘**——必须显式调 commitTransaction。
   * `nodeId` 是表节点 id；`updates` 用主键值定位行（不是行下标，见 core/resultset.ts）。
   */
  applyEdits: (tableNodeId: string, updates: readonly RowUpdate[]) =>
    invokeBackend(IPC.applyEdits, tableNodeId, updates) as Promise<EditApplyResult>,

  commitTransaction: (nodeId: string) =>
    invokeBackend(IPC.commitTransaction, nodeId) as Promise<TransactionState>,

  rollbackTransaction: (nodeId: string) =>
    invokeBackend(IPC.rollbackTransaction, nodeId) as Promise<TransactionState>,

  transactionState: (nodeId: string) =>
    invokeBackend(IPC.transactionState, nodeId) as Promise<TransactionState>,

  // ---- 增删与完整取值（第五阶段） ----

  /**
   * 插入一行，返回新行主键（`keyValues`）让 UI 能定位它。**不自动提交**。
   */
  insertRow: (tableNodeId: string, values: Readonly<Record<string, CellValue>>) =>
    invokeBackend(IPC.insertRow, tableNodeId, values) as Promise<{
      affected: number
      keyValues: Record<string, CellValue>
    }>,

  /** 按主键批量删除。空数组会被拒绝（空 WHERE 会删整表）。**不自动提交**。 */
  deleteRows: (
    tableNodeId: string,
    keys: readonly Readonly<Record<string, CellValue>>[]
  ) => invokeBackend(IPC.deleteRows, tableNodeId, keys) as Promise<EditApplyResult>,

  /** 统计行数。**显式动作**，大表上是全表扫描，UI 不要在展开目录时自动调用。 */
  countRows: (tableNodeId: string) =>
    invokeBackend(IPC.countRows, tableNodeId) as Promise<number>,

  /**
   * 取单格完整值。用 `runQuery` 返回的 cursorId（带连接前缀，原样回传），
   * 解决"超长文本被截断到 1000 字符看不懂"的问题。
   */
  fetchCellValue: (cursorId: string, rowIndex: number, columnIndex: number) =>
    invokeBackend(IPC.fetchCellValue, cursorId, rowIndex, columnIndex) as Promise<CellValue>,

  // ---- DDL 与编辑连接（第六阶段） ----

  /** 建表。成功后 listChildren 立刻能看到（DDL 已提交）。 */
  createTable: (connectionId: string, spec: TableCreateSpec) =>
    invokeBackend(IPC.createTable, connectionId, spec) as Promise<void>,

  /** 删表。`nodeId` 是节点 id（如 `connection:c1|table:users`）。 */
  dropTable: (nodeId: string) => invokeBackend(IPC.dropTable, nodeId) as Promise<void>,

  /** 建视图：`CREATE VIEW <viewName> AS <selectSql>`。 */
  createView: (connectionId: string, viewName: string, selectSql: string) =>
    invokeBackend(IPC.createView, connectionId, viewName, selectSql) as Promise<void>,

  /** 删视图。`nodeId` 是节点 id。 */
  dropView: (nodeId: string) => invokeBackend(IPC.dropView, nodeId) as Promise<void>,

  /** 重命名表。`nodeId` 是节点 id，`newName` 是新表名。 */
  renameTable: (nodeId: string, newName: string) =>
    invokeBackend(IPC.renameTable, nodeId, newName) as Promise<void>,

  /**
   * 取消某个节点所属连接上正在执行的查询。
   *
   * `nodeId` 用于定位连接（UI 上可能同时有多个连接在跑查询）。
   * 返回 true 表示后端确实中断了；false 表示该驱动不支持取消（SQLite）
   * 或当时并没有在跑的查询。UI 应先看能力的 `supportsCancel`。
   */
  cancelQuery: (nodeId: string, signalId?: string) =>
    invokeBackend(IPC.cancelQuery, nodeId, signalId) as Promise<boolean>,

  /**
   * 编辑已保存连接。若当前已连接，主进程内部会断开重连，使新配置生效；
   * 原本断开的连接更新后仍保持断开（不自作主张连库）。
   */
  updateConnection: (
    connectionId: string,
    config: Partial<ConnectionConfig>,
    secret?: SecretInput
  ) =>
    invokeBackend(
      IPC.updateConnection,
      connectionId,
      config,
      secret
    ) as Promise<ConnectionSummary>,

  // ---- SQL 历史与收藏（第八阶段） ----

  listSqlLibrary: () =>
    invokeBackend(IPC.listSqlLibrary) as Promise<SqlLibrarySnapshot>,
  recordSqlHistory: (input: RecordSqlHistoryInput) =>
    invokeBackend(IPC.recordSqlHistory, input) as Promise<SqlHistoryEntry>,
  saveSql: (id: string | null, name: string, sql: string) =>
    invokeBackend(IPC.saveSql, id, name, sql) as Promise<SavedSql>,
  removeSavedSql: (id: string) =>
    invokeBackend(IPC.removeSavedSql, id) as Promise<void>,
  clearSqlHistory: () => invokeBackend(IPC.clearSqlHistory) as Promise<void>,

  // ---- 流式导出（P2.1） ----

  /**
   * 启动导出任务。
   *
   * 参数形状是纯结构化数据（字符串 / 布尔 / 数字 / 嵌套对象），
   * 可安全过 contextBridge；不接受函数、不接受回调。
   */
  startTransfer: (request: TransferRequest) =>
    invokeBackend(IPC.startTransfer, request) as Promise<TransferProgress>,

  /** 轮询任务进度。未知任务 id 返回 null。 */
  getTransferProgress: (taskId: string) =>
    invokeBackend(IPC.getTransferProgress, taskId) as Promise<TransferProgress | null>,

  /** 取消任务（任务级，不影响同连接的其它查询）。 */
  cancelTransfer: (taskId: string) =>
    invokeBackend(IPC.cancelTransfer, taskId) as Promise<boolean>,

  /** 等任务结束，返回终态结果。 */
  waitTransfer: (taskId: string) =>
    invokeBackend(IPC.waitTransfer, taskId) as Promise<TransferResult>,

  // ---- CSV 导入（P2.3） ----

  previewImport: async (request: ImportPreviewRequest) => {
    const result: unknown = await ipcRenderer.invoke(IPC.previewImport, request)
    if (isBackendEnvelope(result)) {
      return unwrapEnvelope<ImportPreview>(result as BackendEnvelope<ImportPreview>)
    }
    return result as ImportPreview
  },

  startImport: (request: ImportRequest) =>
    invokeBackend(IPC.startImport, request) as Promise<ImportProgress>,

  getImportProgress: (taskId: string) =>
    invokeBackend(IPC.getImportProgress, taskId) as Promise<ImportProgress | null>,

  cancelImport: (taskId: string) =>
    invokeBackend(IPC.cancelImport, taskId) as Promise<boolean>,

  waitImport: (taskId: string) =>
    invokeBackend(IPC.waitImport, taskId) as Promise<ImportResult>,

  /**
   * 打开系统文件选择框，让用户挑一个 CSV 文件。
   *
   * 返回选中的绝对路径；用户取消 / 没选 / 对话框打不开时返回 `null`。
   *
   * 刻意**不**暴露"读文件"或"按路径读内容"的通道：
   * 这条只解决"文件在哪"，内容解析留在主进程。
   * 也没有"任意路径"参数——要选文件就得让用户自己在系统框里选。
   */
  chooseImportFile: () =>
    invokeBackend(IPC.chooseImportFile) as Promise<string | null>
}

contextBridge.exposeInMainWorld(API_GLOBAL, api)
