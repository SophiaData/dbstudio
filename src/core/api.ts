/**
 * 渲染进程可用的 API 面（经 preload 的 contextBridge 暴露为 `window.dbstudio`）。
 *
 * ===== 为什么要有这一层，而不是直接暴露 ipcRenderer =====
 *
 * 直接给渲染进程 `ipcRenderer` 等于把整个主进程的能力面全开，
 * 任何前端代码（包括一个被注入的脚本）都能调任意通道。
 *
 * DBeaver 的对应物是 Eclipse 扩展点——它用「声明式注册 + 容器校验」
 * 来收敛能力面。Web 侧的对等做法就是**显式枚举允许的方法**，
 * 这份接口就是那份白名单。
 *
 * 另一个作用：它是**唯一的跨进程契约**，
 * 主进程实现它、preload 转发它、渲染进程消费它、测试也验它，
 * 三边共用一个类型，改不动就会编译报错。
 */

import type { ConnectionConfig } from './dialect'
import type { TestConnectionResult, DialectInfo } from './driver'
import type { DriverCapabilities, ObjectRef, TableCreateSpec, TableDescription } from './model'
import type { QueryOptions, QueryResult, ResultPage } from './resultset'
import type { EditApplyResult, RowUpdate, TransactionState } from './resultset'
import type { CellValue } from './resultset'

/** 连接在 UI 里的展示态。会话态（是否已连上）单独放，避免和配置混在一起。 */
export interface ConnectionSummary {
  readonly id: string
  readonly name: string
  readonly dialectId: string
  /** 是否已建立会话（宿主进程活着且连接可用）。 */
  readonly connected: boolean
  readonly capabilities: DriverCapabilities | null
  /**
   * 该连接是否已持久化到磁盘。
   *
   * 为什么要这个标记：加了持久化之后出现两种连接——「存过但没连」与
   * 「连上了但没存」。UI 必须能区分，否则用户会以为重启后还在，
   * 或者以为已经保存了实际没有。
   */
  readonly persisted: boolean
  /**
   * 密码（凭据）是否已安全保存。
   *
   * 为什么单独一个字段：`persisted === true` 表示**配置**存下了，
   * 但密码是另一条通道（走 OS 级加密）。当系统不支持安全存储
   * （`safeStorage.isEncryptionAvailable() === false`，常见于 Linux 无 keyring）
   * 时，我们**拒绝保存密码**而不是退化成明文。
   *
   * 于是出现一种必须让用户看见的状态：配置存了、密码没存。
   * 若不给这个字段，用户重启后连接会失败，且完全不知道为什么——
   * 这类"看起来成功、实际少了关键部分"的体验比直接报错更糟。
   *
   * `null` 表示该连接本就不需要密码（例如 SQLite 文件库）。
   */
  readonly secretStored: boolean | null
  /**
   * 该连接的配置参数（**不含密码**）。
   *
   * 为什么必须暴露：编辑连接时必须能把现有值回填到表单里。
   * 早先没有这个字段，编辑对话框只能显示空白输入框——
   * 用户看不到当前路径，等于"盲改"，一不留神就把能用的配置改坏。
   *
   * 密码**不在这里**（走独立的加密通道，见 secretStored）。
   */
  readonly options: Readonly<Record<string, string | number | boolean>>
}

export interface DbStudioApi {
  /** 列出本机已注册的方言，驱动「新建连接」表单。 */
  listDialects(): Promise<DialectInfo[]>

  /**
   * 列出所有已保存的连接（**不区分是否已连接**）。
   *
   * 语义变化说明：加入持久化前，这里只返回活动连接；
   * 现在返回的是「配置清单」，`connected` 字段表明各自是否有活动会话。
   */
  listConnections(): Promise<ConnectionSummary[]>

  /**
   * 新建连接：**先落盘配置，再尝试连通**。
   *
   * 顺序刻意如此——如果先连后存，连接成功但保存失败时用户会以为已经存了；
   * 而先存后连，连不上至少配置还在，用户可以改参数重试。
   */
  addConnection(config: ConnectionConfig, secret?: string): Promise<ConnectionSummary>

  /** 为已保存的连接建立会话（`addConnection` 之后的重新连接走这里）。 */
  connectConnection(connectionId: string): Promise<ConnectionSummary>

  /** 关闭会话但**保留配置**。与 `removeConnection` 的区别是后者会删掉配置。 */
  disconnectConnection(connectionId: string): Promise<ConnectionSummary>

  /** 删除连接：关闭会话 + 删除磁盘上的配置与凭据。 */
  removeConnection(connectionId: string): Promise<void>

  /** 只测连通性，不保存连接。 */
  testConnection(config: ConnectionConfig, secret?: string): Promise<TestConnectionResult>

  /**
   * 列出某个节点的子节点。
   *
   * `nodeId` 的编码规则（主进程负责组装，UI 只当不透明字符串用）：
   *   - `null`                       → 根层，即所有连接
   *   - `connection:<id>`            → 该连接下的第一层（catalog/schema/folder）
   *   - `connection:<id>|<adapterId>`→ adapter 返回的原生 id，前缀了连接归属
   *
   * 为什么要加前缀：adapter 只保证「同一连接内 id 唯一」，
   * 而树里同时挂着多个连接，不加前缀必然撞车。
   */
  listChildren(nodeId: string | null): Promise<ObjectRef[]>

  /** 读取表结构。按需调用——不要在列目录时预取。 */
  describeTable(tableNodeId: string): Promise<TableDescription>

  /**
   * 执行 SQL，返回第一页结果。
   *
   * `nodeId` 指明在哪个连接上执行（复用树节点的连接归属编码）。
   * 返回值带 `cursorId`，后续用 `fetchResultPage` 随机取页。
   */
  runQuery(nodeId: string, sql: string, options?: QueryOptions): Promise<QueryResult>

  /**
   * 从游标按偏移量取一页。
   *
   * 这个是结果集网格虚拟滚动的主通道：网格滚到哪里就要哪一页，
   * **不要**在渲染进程里攒全量数据（见 core/resultset.ts 文件头说明）。
   */
  fetchResultPage(cursorId: string, offset: number, limit: number): Promise<ResultPage>

  /** 释放游标。网格关闭 / 用户切换查询时调用。 */
  closeCursor(cursorId: string): Promise<void>

  /** 便捷方法：直接读一张表/视图的全部行列结构，等价于对表生成 SELECT。 */
  previewTable(nodeId: string, limit?: number): Promise<QueryResult>

  /**
   * 应用一批行更新。**不会自动提交**，必须显式 `commitTransaction`。
   *
   * `tableNodeId` 是表节点 id（携带连接归属），`updates` 里用**主键值**定位行。
   * 无唯一键的表会被拒绝——这条规则在 adapter 侧强制，不依赖 UI 自觉。
   */
  applyEdits(tableNodeId: string, updates: readonly RowUpdate[]): Promise<EditApplyResult>

  /** 提交事务。 */
  commitTransaction(nodeId: string): Promise<TransactionState>

  /** 回滚事务。幂等。 */
  rollbackTransaction(nodeId: string): Promise<TransactionState>

  /** 查询当前事务状态，用于 UI 决定按钮可用性与「有未提交改动」提示。 */
  transactionState(nodeId: string): Promise<TransactionState>

  // ---- 增删与完整取值（第五阶段） ----

  /**
   * 插入一行（**不自动提交**，需显式 commit）。
   *
   * `tableNodeId` 是表节点 id；`values` 是「列名 → 值」。
   * 返回 `keyValues`（新行的主键值），让 UI 能立刻定位这一行。
   */
  insertRow(
    tableNodeId: string,
    values: Readonly<Record<string, CellValue>>
  ): Promise<{ affected: number; keyValues: Record<string, CellValue> }>

  /**
   * 按主键批量删除行（**不自动提交**）。
   *
   * `keys` 每个元素定位一行。空数组会被拒绝——空 WHERE 的 DELETE 会清空整表。
   */
  deleteRows(
    tableNodeId: string,
    keys: readonly Readonly<Record<string, CellValue>>[]
  ): Promise<EditApplyResult>

  /**
   * 统计表的总行数。
   *
   * 这是**显式动作**：大表上是全表扫描，绝不能由列目录等懒加载路径顺带触发。
   */
  countRows(tableNodeId: string): Promise<number>

  /**
   * 取某单元格的**完整值**（结果集平时会把超长文本截断到
   * `MAX_CELL_TEXT_CHARS`，这个接口按需取全文）。
   */
  fetchCellValue(cursorId: string, rowIndex: number, columnIndex: number): Promise<CellValue>

  // ---- DDL 与编辑连接（第六阶段） ----

  /**
   * 建表。成功后**必须立刻能在 listChildren 里看到**（DDL 已生效，不在未提交事务里）。
   * `spec` 见 `core/model.ts` 的 `TableCreateSpec`。
   */
  createTable(connectionId: string, spec: TableCreateSpec): Promise<void>

  /**
   * 删表。`nodeId` 是**节点 id**（`connection:c1|table:users`）。
   * 主进程只解析连接归属，完整 adapterId 交给宿主，由 adapter 解析表名。
   */
  dropTable(nodeId: string): Promise<void>

  /** 建视图：`CREATE VIEW <viewName> AS <selectSql>`。 */
  createView(connectionId: string, viewName: string, selectSql: string): Promise<void>

  /** 删视图。`nodeId` 是节点 id（`connection:c1|view:v`）。 */
  dropView(nodeId: string): Promise<void>

  /** 重命名表。`nodeId` 是节点 id（`connection:c1|table:users`）。 */
  renameTable(nodeId: string, newName: string): Promise<void>

  /**
   * 编辑已保存的连接（改配置 / 改密码）。
   *
   * **语义**：更新落盘配置 → 若当前已连接则断开重连（否则新配置不生效，
   * 用户会困惑"我改了为什么还连旧的"）→ 返回新的 summary。
   * `config` 是部分更新（只传要改的字段）。
   */
  updateConnection(
    connectionId: string,
    config: Partial<ConnectionConfig>,
    secret?: string
  ): Promise<ConnectionSummary>
}

/** preload 注入到 window 上的全局名。 */
export const API_GLOBAL = 'dbstudio' as const

/** IPC 通道名常量。集中定义，避免主/预加载两处手写字符串写错。 */
export const IPC = {
  listDialects: 'dbstudio:listDialects',
  listConnections: 'dbstudio:listConnections',
  addConnection: 'dbstudio:addConnection',
  connectConnection: 'dbstudio:connectConnection',
  disconnectConnection: 'dbstudio:disconnectConnection',
  removeConnection: 'dbstudio:removeConnection',
  testConnection: 'dbstudio:testConnection',
  listChildren: 'dbstudio:listChildren',
  describeTable: 'dbstudio:describeTable',
  runQuery: 'dbstudio:runQuery',
  fetchResultPage: 'dbstudio:fetchResultPage',
  closeCursor: 'dbstudio:closeCursor',
  previewTable: 'dbstudio:previewTable',
  applyEdits: 'dbstudio:applyEdits',
  commitTransaction: 'dbstudio:commitTransaction',
  rollbackTransaction: 'dbstudio:rollbackTransaction',
  transactionState: 'dbstudio:transactionState',
  insertRow: 'dbstudio:insertRow',
  deleteRows: 'dbstudio:deleteRows',
  countRows: 'dbstudio:countRows',
  fetchCellValue: 'dbstudio:fetchCellValue',
  createTable: 'dbstudio:createTable',
  dropTable: 'dbstudio:dropTable',
  createView: 'dbstudio:createView',
  dropView: 'dbstudio:dropView',
  renameTable: 'dbstudio:renameTable',
  updateConnection: 'dbstudio:updateConnection'
} as const

/**
 * 节点 id 的编解码。
 *
 * 放在 core 里而不是主进程里，是为了让**测试与渲染进程都能用同一套规则**
 * 构造/解析 id；如果只有主进程知道怎么拼，测试就只能靠猜。
 */
export const NodeId = {
  CONNECTION_PREFIX: 'connection:',
  /** 连接根节点 id。 */
  connection(connectionId: string): string {
    return `${NodeId.CONNECTION_PREFIX}${connectionId}`
  },
  /** 把 adapter 返回的原生 id 加上连接归属。 */
  scoped(connectionId: string, adapterId: string): string {
    return `${NodeId.CONNECTION_PREFIX}${connectionId}|${adapterId}`
  },
  /** 解析节点 id。根节点返回 null。 */
  parse(nodeId: string): { connectionId: string; adapterId: string | null } | null {
    if (!nodeId.startsWith(NodeId.CONNECTION_PREFIX)) return null
    const rest = nodeId.slice(NodeId.CONNECTION_PREFIX.length)
    const sep = rest.indexOf('|')
    if (sep === -1) return { connectionId: rest, adapterId: null }
    return { connectionId: rest.slice(0, sep), adapterId: rest.slice(sep + 1) }
  }
} as const
