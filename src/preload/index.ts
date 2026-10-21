/**
 * preload：把主进程能力**按白名单**暴露给渲染进程。
 *
 * ===== 为什么要这一层，而不是直接把 ipcRenderer 给页面 =====
 *
 * 直接暴露 `ipcRenderer` 等于把整个 IPC 面全开：页面里任何一段代码
 * （包括被注入的、或某个第三方脚本）都能调用任意通道。
 *
 * 这里显式枚举 **17 个**方法（第一阶段 7 + 第二阶段 4 + 第三阶段 4 + 第四阶段 2），
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
 */

import { contextBridge, ipcRenderer } from 'electron'
import { API_GLOBAL, IPC, type DbStudioApi } from '../core/api'
import type { ConnectionConfig } from '../core/dialect'
import type { ObjectRef, TableDescription } from '../core/model'
import type { ConnectionSummary } from '../core/api'
import type { QueryOptions, QueryResult, ResultPage } from '../core/resultset'
import type {
  EditApplyResult,
  RowUpdate,
  TransactionState
} from '../core/resultset'

const api: DbStudioApi = {
  listDialects: () => ipcRenderer.invoke(IPC.listDialects),
  listConnections: () => ipcRenderer.invoke(IPC.listConnections) as Promise<ConnectionSummary[]>,
  addConnection: (config: ConnectionConfig, secret?: string) =>
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
  testConnection: (config: ConnectionConfig, secret?: string) =>
    ipcRenderer.invoke(IPC.testConnection, config, secret),
  listChildren: (nodeId: string | null) =>
    ipcRenderer.invoke(IPC.listChildren, nodeId) as Promise<ObjectRef[]>,
  describeTable: (tableNodeId: string) =>
    ipcRenderer.invoke(IPC.describeTable, tableNodeId) as Promise<TableDescription>,

  // ---- 结果集（第二阶段） ----

  runQuery: (nodeId: string, sql: string, options?: QueryOptions) =>
    ipcRenderer.invoke(IPC.runQuery, nodeId, sql, options) as Promise<QueryResult>,

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
    ipcRenderer.invoke(IPC.transactionState, nodeId) as Promise<TransactionState>
}

contextBridge.exposeInMainWorld(API_GLOBAL, api)
