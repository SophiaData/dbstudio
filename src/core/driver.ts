/**
 * 驱动适配器契约 + 驱动宿主进程的 RPC 协议。
 *
 * ===== 这是本项目最重要的一处架构决策，直接来自剖析结论 =====
 *
 * DBeaver 给**每个驱动一个独立的 `URLClassLoader`**
 * （证据：registry 的 `DriverClassLoader.java`，全文 79 行，
 *        `class DriverClassLoader extends URLClassLoader`，parent-first）。
 * 它解决的真实冲突是：两个驱动依赖同一个库（比如同一个日志库）的不同版本，
 * 在同一个 JVM 里必然打架。
 *
 * **Node 没有 ClassLoader，`require` 缓存是全局的，同一个进程内无法并存两个版本。**
 * 所以剖析报告「陷阱 1」的结论是：不要试图模拟 ClassLoader，要**进程隔离**。
 *
 * 本文件把这个结论固化成协议：`DriverAdapter` 的实现**只在驱动宿主进程里存在**，
 * 主进程永远拿不到 adapter 对象，只能通过下面的 RPC 帧与它对话。
 * 一个连接 = 一个宿主进程；宿主崩了，主进程和其他连接都不受影响。
 */

import type { ConnectionConfig, SqlDialect } from './dialect'
import type { DriverCapabilities, ObjectRef, TableDescription } from './model'
import type { QueryOptions, QueryResult, ResultPage } from './resultset'
import type {
  CellValue,
  EditApplyResult,
  RowUpdate,
  TransactionState
} from './resultset'

/**
 * 机密值（密码 / token）。
 *
 * 刻意**不放进 `ConnectionConfig`**：配置对象会被打日志、会被序列化、
 * 会出现在错误堆栈里，机密一旦混进去就迟早泄漏。
 * 机密只在这个独立参数里传递，且不落盘（落盘由后续的凭据存储负责）。
 */
export type SecretValue = string | undefined

/** 连接探测结果。 */
export interface TestConnectionResult {
  readonly ok: boolean
  /** 失败原因；成功时为 undefined。 */
  readonly message?: string
  /** 往返耗时（毫秒），UI 可以直接显示，帮助用户判断网络质量。 */
  readonly elapsedMs: number
  /** 连上后探测到的服务端信息，如 `SQLite 3.51.0`。 */
  readonly serverVersion?: string
}

/**
 * 驱动适配器。**实现在驱动宿主进程内**，不跨进程传递。
 *
 * 与 DBeaver 的对应关系：
 *   `connect`         ← `JDBCConnectionOpener` 的建连链路
 *   `listChildren`    ← `DBSObjectContainer.getChildren`（懒加载的唯一入口）
 *   `describeTable`   ← `DBSEntity` 的列/主键读取
 *   `query`           ← 执行语句 + 取第一页（结果集读取的入口）
 *   `closeCursor`     ← 释放结果集句柄（对应 DBeaver 关闭 ResultSet）
 *   `capabilities`    ← 取代 DBeaver 那套「三机制并存」的能力探测
 */
export interface DriverAdapter {
  /** 本 adapter 提供的方言。语法知识与 I/O 在这一层汇合。 */
  readonly dialect: SqlDialect
  /** 供 UI 显示的方言信息。 */
  readonly info: DialectInfo

  /** 建立连接并返回能力声明；能力可以是静态声明，也可以是连上后探测的结果。 */
  connect(config: ConnectionConfig, secret: SecretValue): Promise<DriverCapabilities>

  /** 断开并释放资源。必须幂等——宿主进程关闭时会再调一次。 */
  disconnect(): Promise<void>

  /**
   * 只测连不保留连接。
   * DBeaver 的「测试连接」也是真建一条再关掉（`01-connection-driver.md`），
   * 这里沿用同一语义，避免出现「测试通过但真连不上」的经典坑。
   */
  testConnection(config: ConnectionConfig, secret: SecretValue): Promise<TestConnectionResult>

  /**
   * 列出子节点。`parentId === null` 表示列出连接的根层。
   *
   * **懒加载契约**：这个方法只允许返回**直接子节点**，
   * 严禁为了「顺便」把整棵子树读出来。
   * 依据：DBeaver 的 `cacheStructure(STRUCT_ALL)` 会在打开 ER 图时全量读元数据，
   * 剖析报告把它列为「不该照搬」的项之一。
   */
  listChildren(parentId: string | null): Promise<ObjectRef[]>

  /** 读取表结构（列 + 唯一键判定）。按需调用，不在 listChildren 里预取。 */
  describeTable(id: string): Promise<TableDescription>

  /**
   * 执行一条查询语句，返回第一页。
   *
   * `cursorId` 模式的语义：
   *   - `keepCursor: true`（默认）→ 返回值里带 `cursorId`，
   *     后续用 `fetchResultPage(cursorId, offset, limit)` 随机取页；
   *   - `keepCursor: false` → 只取这一页就释放，返回 `cursorId: null`。
   *
   * 为什么查询与取页分成两个方法：一次 `query` 只拿第一页，
   * 后续取页走 `fetchResultPage`，这样渲染进程虚拟滚动到哪一段就要哪一段，
   * 不需要在进程间维持一个「滑动的全量窗口」。
   */
  query(sql: string, options?: QueryOptions): Promise<QueryResult>

  /**
   * 从已打开的游标按偏移量取一页。
   *
   * **必须支持乱序取页**（先取第 100 行、再取第 0 行都要能工作）。
   * 这是与 DBeaver 单进程 ResultSet 的关键差异：那边可以直接 `seek`，
   * 我们这边如果只保证顺序流式读取，网格往回滚动就得重查。
   */
  fetchResultPage(cursorId: string, offset: number, limit: number): Promise<ResultPage>

  /** 释放游标。必须幂等。 */
  closeCursor(cursorId: string): Promise<void>

  /**
   * 应用一批行更新。**不会自动提交**。
   *
   * 实现要求（都来自剖析结论）：
   *   - 必须用**参数化**语句，不许字符串拼接值（注入面）
   *   - 表名/列名必须走方言的 `quoteIdentifier`
   *   - 缺唯一键时**直接拒绝**（对应 DBeaver 的 "No unique key defined"）
   *   - 进入事务后保持打开，直到显式 `commitTransaction` / `rollbackTransaction`
   *   - 任何一行失败时，整批应可回滚（不能留下改了一半的状态）
   */
  applyEdits(tableId: string, updates: readonly RowUpdate[]): Promise<EditApplyResult>

  /** 提交当前事务。无活动事务时应报错而不是静默成功。 */
  commitTransaction(): Promise<TransactionState>

  /** 回滚当前事务。必须幂等。 */
  rollbackTransaction(): Promise<TransactionState>

  /** 查询当前事务状态。UI 用它决定按钮可用性。 */
  transactionState(): Promise<TransactionState>

  // ---- 增删与完整取值（第五阶段） ----
  //
  // 补的是「只有 UPDATE 不够用」的三个缺口：删不掉记录、插不了新记录、
  // 看不到被截断值全文。四个方法都遵循与 applyEdits 相同的写入纪律：
  // 参数化语句、标识符走 quoteIdentifier、无唯一键时拒绝、不自动提交。

  /**
   * 插入一行。**不自动提交**（与 applyEdits 一致，需要显式 commit）。
   *
   * 返回 `keyValues` 是为了让 UI 能立刻定位刚插入的这行——否则用户插完
   * 一行，网格里没有它的稳定标识，后续想改/删都无从下手。
   * 若该表没有可用主键（或数据库未回填），实现可返回空对象；调用方必须能从
   * `affected` 判断"插成功了"，而不能靠 keyValues 是否为空。
   */
  insertRow(
    tableId: string,
    values: Readonly<Record<string, CellValue>>
  ): Promise<{ affected: number; keyValues: Record<string, CellValue> }>

  /**
   * 按主键批量删除行。**不自动提交**。
   *
   * `keys` 是「一组 WHERE 条件的集合」，每个元素定位一行（与 RowUpdate.keyValues
   * 同构）。空数组**必须被拒绝**——空 WHERE 的 DELETE 会删掉整张表，
   * 这是本接口最危险的误用面，协议层与 adapter 都要挡。
   */
  deleteRows(
    tableId: string,
    keys: readonly Readonly<Record<string, CellValue>>[]
  ): Promise<EditApplyResult>

  /**
   * 表的总行数。
   *
   * ===== 为什么这是一个"显式动作"，绝不参与懒加载 =====
   *
   * `COUNT(*)` 在大表上是全表扫描。它必须是用户主动触发（比如点了"统计行数"），
   * **绝不能**被 listChildren / describeTable 顺手调用——那会让"展开一个表目录"
   * 变成"对每个表各做一次全表扫描"，在百万行库上是灾难。
   * 测试里有一条专钉「列目录不会触发 countRows」，防止后人顺手加。
   */
  countRows(tableId: string): Promise<number>

  /**
   * 按游标 + 行列下标取某个单元格的**完整值**。
   *
   * ===== 为什么需要单独一个接口 =====
   *
   * 结果集为了让单帧不撑爆 IPC，把超长文本截断到 `MAX_CELL_TEXT_CHARS`
   * （1000 字符）并标 `truncated: true`（见 resultset.ts 的设计说明）。
   * 用户看到一个截断的值却没有任何办法看全文——这是真实的功能缺口。
   * 这个接口按需重取单格，返回值**不应被截断**（完整内容）。
   */
  fetchCellValue(cursorId: string, rowIndex: number, columnIndex: number): Promise<CellValue>
}

/** 方言的展示信息，UI 用它渲染「新建连接」的下拉框。 */
export interface DialectInfo {
  readonly id: string
  readonly name: string
  /** 该方言连接时用户必须填哪些字段，UI 按此动态生成表单。 */
  readonly fields: readonly DialectField[]
  /**
   * 标识符加引号的规则（双引号 / 反引号 / 需要转义哪些字符）。
   *
   * ===== 为什么把这条规则并进 DialectInfo，而不是让调用方去 import 具体方言 =====
   *
   * 主进程需要在**不持有 adapter 实例**的前提下拼简单 SQL，
   * 典型场景是「打开表」时的 `SELECT * FROM <quoted table>`。
   * 最初的临时做法是让主进程深路径 import 某个具体驱动的 dialect 模块，
   * 但那样有两个问题：
   *   1. 每加一个方言就要在主进程里加一条 import，与「驱动清单只有一个出口」冲突；
   *   2. 主进程一旦开始依赖具体驱动目录，进程隔离就开始漏。
   *
   * 把规则抽成**纯数据**放进 DialectInfo，主进程就能自己完成转义，
   * 完全不需要跨进程调用，也不需要认识任何具体驱动。
   */
  readonly quoting: QuotingRules
}

/**
 * 标识符加引号规则。纯数据、可序列化，不含函数——
 * 它要经 IPC / RPC 传递，函数没法结构化克隆。
 */
export interface QuotingRules {
  /** 开引号字符，如 `"` 或 `` ` ``。 */
  readonly open: string
  /** 闭引号字符。 */
  readonly close: string
  /**
   * 引号内部的转义方式：
   *   - `double`：把内部引号字符重复一次（SQL 标准，SQLite/PG 都是这样）
   *   - `backslash`：用反斜杠转义（MySQL 风格）
   */
  readonly escape: 'double' | 'backslash'
}

/**
 * 按 `QuotingRules` 转义一个标识符。
 *
 * 放在 core 里而不是各驱动里，是为了让**主进程、渲染进程、测试**用同一套逻辑，
 * 避免出现「主进程拼的 SQL 和驱动自己拼的不一致」这种最难查的偏差。
 */
export function quoteIdentifierWith(name: string, rules: QuotingRules): string {
  const escaped =
    rules.escape === 'double'
      ? name.split(rules.close).join(rules.close + rules.close)
      : name.split('\\').join('\\\\').split(rules.close).join('\\' + rules.close)
  return rules.open + escaped + rules.close
}

export interface DialectField {
  readonly key: string
  readonly label: string
  readonly kind: 'text' | 'number' | 'password' | 'file'
  readonly required: boolean
  readonly placeholder?: string
  /** 默认值。 */
  readonly default?: string | number
}

// ---------------------------------------------------------------------------
// RPC 协议：主进程 ⇄ 驱动宿主进程
// ---------------------------------------------------------------------------

/**
 * 传输格式：**按行分隔的 JSON**（NDJSON），走子进程 stdio。
 *
 * 为什么不用别的：
 * - 不引入任何依赖（不用 grpc / msgpack）。
 * - 天然支持流式输出——后续要传百万行结果集时，可以逐段发帧，
 *   不会像一次性 `ipcRenderer.invoke` 那样把内存打爆
 *   （这正是剖析报告「陷阱 5」指出的、Web 端独有而 DBeaver 源码里学不到的问题）。
 * - 调试时肉眼可读，`stderr` 完全留给日志，两边不抢通道。
 */
export interface RpcRequest {
  readonly id: number
  readonly method: RpcMethod
  readonly params?: unknown
}

export const RPC_METHODS = [
  'handshake',
  'connect',
  'disconnect',
  'testConnection',
  'listChildren',
  'describeTable',
  'query',
  'fetchResultPage',
  'closeCursor',
  'applyEdits',
  'commitTransaction',
  'rollbackTransaction',
  'transactionState',
  'insertRow',
  'deleteRows',
  'countRows',
  'fetchCellValue'
] as const

export type RpcMethod = (typeof RPC_METHODS)[number]

export interface RpcSuccess {
  readonly id: number
  readonly ok: true
  readonly result: unknown
}

export interface RpcFailure {
  readonly id: number
  readonly ok: false
  readonly error: RpcError
}

export type RpcResponse = RpcSuccess | RpcFailure

export interface RpcError {
  /** 机器可判定，UI 据此决定是提示用户还是重试。 */
  readonly code: RpcErrorCode
  /** 人类可读，直接展示给用户。 */
  readonly message: string
}

export type RpcErrorCode =
  | 'not_connected'
  | 'already_connected'
  | 'unsupported_method'
  | 'bad_params'
  | 'connection_failed'
  | 'query_failed'
  | 'object_not_found'
  | 'internal'

/**
 * 握手信息：宿主进程启动后主动发第一帧，
 * 让主进程确认「这个进程是谁、支持什么」，避免盲发请求。
 */
export interface RpcHandshake {
  readonly kind: 'handshake'
  readonly dialectId: string
  readonly adapterVersion: string
  readonly pid: number
  /** 宿主进程实际运行的 Node 版本，用于排查「内置模块不可用」类问题。 */
  readonly nodeVersion: string
  readonly platform: string
}

/** 宿主 → 主进程的事件帧（非请求响应）。 */
export type RpcEvent = RpcHandshake | { readonly kind: 'log'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }

/** 判定一帧是响应还是事件。 */
export function isRpcResponse(frame: unknown): frame is RpcResponse {
  return typeof frame === 'object' && frame !== null && typeof (frame as RpcResponse).id === 'number'
}
