/**
 * @sophiadata/dbstudio-sdk —— 驱动层 SDK。
 *
 * ===== 这个包解决什么问题 =====
 *
 * 任何 Node 项目想连多种数据库，迟早撞上一个问题：**两个驱动依赖同一个库的
 * 不同版本，在同一个进程里必然打架**。Java 靠 ClassLoader 隔离，Node 没有——
 * `require` 缓存是全局的，同名模块不同版本无法共存。
 *
 * 本 SDK 的答案：**一个连接一个子进程**。驱动在独立进程里跑，
 * 版本冲突天然消失，驱动崩溃也拖不垮你的主进程。
 *
 * ===== 为什么它值得单独发包 =====
 *
 * 这些东西与「界面」毫无关系：
 *   - 方言抽象（引号规则、分页语法、命名空间用法）
 *   - 元数据契约（对象树、表结构、唯一键判定）
 *   - 结果集游标（按页随机取，不在进程间搬全量数据）
 *   - 驱动宿主进程管理（spawn + NDJSON RPC + 生命周期）
 *
 * 所以它零 Electron 依赖，宿主依赖 pg 与 ssh2。Electron 应用可以用，
 * 一个 CLI、一个 HTTP 服务、一个后台任务同样可以用。
 */

// ---- 契约类型：调用方拼 SQL / 判断能力时需要 ----
export type {
  ConnectionConfig,
  SqlDialect,
  NamespaceUsage
} from './contracts/dialect.js'

export type {
  ObjectRef,
  NodeKind,
  ColumnDescription,
  TableDescription,
  DriverCapabilities
} from './contracts/model.js'

export type {
  QueryOptions,
  QueryResult,
  ResultPage,
  ResultRow,
  ResultColumn,
  CellValue,
  RowUpdate,
  RowEditOutcome,
  EditApplyResult,
  TransactionState
} from './contracts/resultset.js'

export { cellValueToSqlParam, MAX_CELL_TEXT_CHARS } from './contracts/resultset.js'

export type {
  DialectInfo,
  DialectField,
  QuotingRules,
  TestConnectionResult,
  SecretMap,
  SecretInput,
  SecretKey
} from './contracts/driver.js'

export { quoteIdentifierWith } from './contracts/driver.js'

// ---- 实际可用的东西 ----
export { DriverHost, withDriverHost, type DriverHostOptions, type DriverHostLogLevel } from './host.js'
export { Quote } from './quote.js'
