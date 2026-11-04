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
import type {
  ImportBatch,
  ImportBatchResult,
  TransferSourceResolution
} from './transfer'
import type { SqlScriptRules } from './sql-script'
import type { MetadataCapabilities } from './metadata'
import type { DriverCapabilities, ObjectRef, TableCreateSpec, TableDescription } from './model'
import type { ExplainResult, QueryOptions, QueryResult, ResultPage, StatementResult } from './resultset'
import type {
  CellValue,
  EditApplyResult,
  RowUpdate,
  TransactionState
} from './resultset'

/**
 * 机密值（密码 / SSH 口令 / 私钥口令）。
 *
 * 刻意**不放进 `ConnectionConfig`**：配置对象会被打日志、会被序列化、
 * 会出现在错误堆栈里，机密一旦混进去就迟早泄漏。
 * 机密只在这个独立参数里传递，且不落盘（落盘由后续的凭据存储负责）。
 *
 * ===== 为什么从 `string` 扩成对象（SSH 隧道带来的契约变更）=====
 *
 * 在只有数据库密码时，一个字符串就够了。但 SSH 隧道需要**两个**独立机密：
 *   - 数据库口令
 *   - SSH 认证（口令，或用带口令的私钥时的私钥口令）
 *
 * 有三个候选方案，逐个说为什么没选：
 *
 *   1. 把两个机密拼成一个字符串（`"dbpass\nsshpass"`）。看似零改动，
 *      但要求所有驱动都遵守同一套分隔符约定，而密码里**可以合法包含换行**。
 *      一旦值里出现分隔符，就会静默地把密码截断成两半——错误还表现为
 *      "认证失败"，排查成本极高。用不可见的分隔约定传机密是典型的坑。
 *   2. 把 SSH 口令塞进 `ConnectionConfig.options`。这会直接违背本文件的
 *      核心约束：options 会被打日志、写进 `connections.json`（明文文件）。
 *   3. **改成具名对象**（采用）。每个机密的含义由 key 显式表达，
 *      不依赖任何分隔约定，也不需要改动 `ConnectionConfig` 的结构。
 *
 * `string` 仍然被接受（见 `SecretInput`），这样：
 *   - 既有 SDK 调用方与测试代码不用改；
 *   - IPC 层照旧可以只传一个字符串（单机无 SSH 的常见情形）；
 *   - 但它会被**归一化**成一个具名对象再交给 adapter，adapter 只需处理一种形状。
 */
export interface SecretMap {
  /** 数据库口令（PostgreSQL 等）。 */
  readonly dbPassword?: string
  /** SSH 登录口令（与 privateKey 二选一）。 */
  readonly sshPassword?: string
  /**
   * SSH 私钥自身的口令（私钥加密时使用）。
   *
   * 与 `sshPassword` 是**两件事**：前者是"登录用的口令"，
   * 后者是"解开私钥文件的口令"。混成一体会导致"填了私钥又填口令就连不上"。
   */
  readonly sshPassphrase?: string
}

/** `SecretMap` 的合法键。解析 IPC/RPC 的未知对象时用它做白名单。 */
export const SECRET_KEYS = ['dbPassword', 'sshPassword', 'sshPassphrase'] as const

export type SecretKey = (typeof SECRET_KEYS)[number]

/**
 * 调用方可以传的形状：字符串（视为数据库口令，向后兼容）或具名映射。
 *
 * 注意这是**入口类型**，adapter 内部统一用 `SecretMap`。
 */
export type SecretInput = string | SecretMap | undefined

/**
 * 归一化后的机密集合。`DriverAdapter` 的方法统一收这个类型。
 *
 * 为什么不直接用 `SecretMap`：`undefined` 与"空对象"在实践中要表达同一件事
 * （没有提供任何机密）。归一化时把它们统一成 `undefined` 之外的空对象，
 * 可以省掉 adapter 里满地的 `secret?.` 判空。
 */
export type SecretValue = SecretMap

/**
 * 把调用方传入的各种形状归一化成 `SecretValue`。
 *
 * 空字符串统一丢弃：UI 的“留空表示不修改”和 SDK 的“不传密码”都会产生空串，
 * 若保留它，adapter 会拿一个空口令去认证，错误信息会从“没有凭据”变成
 * “认证失败”，误导排查。
 */
export function normalizeSecret(input: SecretInput): SecretValue {
  if (input === undefined) return {}
  if (typeof input === 'string') {
    return input === '' ? {} : { dbPassword: input }
  }
  const out: { dbPassword?: string; sshPassword?: string; sshPassphrase?: string } = {}
  for (const key of SECRET_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/** 是否一个机密键都没有。 */
export function isEmptySecret(secret: SecretMap): boolean {
  return SECRET_KEYS.every((key) => secret[key] === undefined)
}

/**
 * 按 key 合并两组机密。`patch` 里显式的空串表示删除该 key。
 *
 * 用于“编辑连接时只改了 SSH 口令，数据库口令必须原样保留”的场景。
 * 若直接用 patch 覆盖，用户改一个字段会把另一类凭据静默清掉。
 */
export function mergeSecrets(base: SecretMap, patch: SecretInput): SecretValue {
  const out: { dbPassword?: string; sshPassword?: string; sshPassphrase?: string } = {}
  for (const key of SECRET_KEYS) {
    const value = base[key]
    if (value !== undefined && value !== '') out[key] = value
  }
  if (patch === undefined) return out
  const normalized = normalizeSecret(patch)
  if (typeof patch === 'string') {
    if (patch !== '') out.dbPassword = patch
    return out
  }
  for (const key of SECRET_KEYS) {
    const value = patch[key]
    if (value === '') delete out[key]
    else if (value !== undefined) out[key] = value
    else if (normalized[key] !== undefined) out[key] = normalized[key]
  }
  return out
}

/**
 * 连接测试的单个阶段。
 *
 * 阶段只描述「用户需要排查的边界」，不绑定某个具体驱动：
 * SQLite 只会用到 config / server_query，PostgreSQL 还可以经过 SSH 与数据库。
 */
export type ConnectionTestStage =
  | 'config'
  | 'ssh_connect'
  | 'ssh_host_key'
  | 'ssh_auth'
  | 'ssh_forward'
  | 'database'
  | 'server_query'

/** 一个阶段的诊断结果。 */
export interface ConnectionTestCheck {
  readonly stage: ConnectionTestStage
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly message?: string
  readonly elapsedMs?: number
}

/**
 * SSH 主机密钥检查结果。
 *
 * `unverified` 表示首次连接、尚未保存指纹；`mismatch` 表示已有指纹但本次
 * 拿到的值不同。两者的风险与用户动作完全不同，不能都叫「验证失败」。
 */
export interface SshHostKeyCheck {
  readonly host: string
  readonly port: number
  readonly fingerprint: string
  readonly expectedFingerprint?: string
  readonly state: 'unverified' | 'mismatch'
}

/**
 * 驱动测试连接的完整结果。
 *
 * `checks` 只是展示性的诊断，不是调用方必须理解的协议状态机；
 * 决定成败的仍然只有 `ok`。
 */
export interface TestConnectionResult {
  readonly ok: boolean
  /** 失败原因；成功时为 undefined。 */
  readonly message?: string
  /** 往返耗时（毫秒），UI 可以直接显示，帮助用户判断网络质量。 */
  readonly elapsedMs: number
  /** 连上后探测到的服务端信息，如 `SQLite 3.51.0`。 */
  readonly serverVersion?: string
  /**
   * 分段诊断。为兼容既有 SDK 调用方，驱动可以不返回；
   * 新驱动应尽量返回，让 UI 能指出到底卡在 SSH、数据库还是探测查询。
   */
  readonly checks?: readonly ConnectionTestCheck[]
  /** SSH 主机密钥需要用户处理时返回；普通连接失败不返回。 */
  readonly sshHostKey?: SshHostKeyCheck
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
/**
 * 例程（函数 / 存储过程）的定义快照。
 *
 * 单独定义而不复用 compare.ts 的 RoutineDefinition：driver.ts 是底层契约，
 * 不应反过来依赖上层的比较模型。两者字段一致，由 main 层负责转换。
 */
export interface RoutineInfo {
  readonly schema: string | null
  readonly name: string
  readonly kind: 'function' | 'procedure'
  /** DDL 文本（`CREATE FUNCTION ...`）。拿不到时为 null，不要用空串冒充。 */
  readonly definition: string | null
  /**
   * 参数类型列表，用于区分重载（`f(int)` 与 `f(text)`）。
   * 无参例程为空数组；不支持时留 undefined。
   */
  readonly signature?: readonly string[]
}

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

  /**
   * 读取表结构（列 + 唯一键判定）。按需调用，不在 listChildren 里预取。
   *
   * ===== 返回值现在可能携带结构元数据 =====
   *
   * 除了列与 `hasUniqueKey`，驱动还可以返回外键、索引、唯一约束、
   * CHECK 约束与触发器（见 `TableDescription` 的可选字段）。
   *
   * 两条实现纪律：
   *   1. **不要在 listChildren 里预取这些**——那会让「展开一个表目录」
   *      变成「对每张表各读一遍外键与索引」，在宽表多的库上是灾难。
   *      元数据仍然按需调用 describeTable 获取。
   *   2. **读元数据失败不要让整次 describeTable 失败**。
   *      拿不到就把该字段留成 `undefined`（而不是空数组），
   *      这样 UI 能区分「这个驱动不支持」和「这张表确实没有」——
   *      这两者的差别见 `metadata.ts` 文件头的「undefined ≠ 空数组」。
   */
  describeTable(id: string): Promise<TableDescription>

  /**
   * 取消当前正在执行的查询。返回是否**真的**取消了。
   *
   * ===== 为什么返回值是 boolean 而不是 void =====
   *
   * 有的驱动**无法**取消（SQLite 的 `node:sqlite` 是同步 API，没有
   * `interrupt()`，见 sqlite/query-cancel.ts 的实测记录）。
   * 那种情况下必须诚实地返回 false，而不是事后假装成功——
   * UI 据 capability + 返回值决定提示"已取消"还是"当前驱动不支持取消"。
   *
   * 实现方约定：没有正在执行的查询时返回 false（取消一个不存在的东西不算成功）。
   */
  cancelQuery(): Promise<boolean>

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
  query(sql: string, options?: QueryOptions, signal?: AbortSignal): Promise<QueryResult>

  /**
   * 执行一条 SQL 语句（查询、DML 或 DDL）。
   * 区别于 query() 只读游标接口，该方法区分返回行、影响行数与 DDL 变更摘要。
   */
  executeStatement(sql: string, options?: QueryOptions): Promise<StatementResult>

  /** 按当前方言生成并执行一条只读执行计划。 */
  explain(sql: string): Promise<ExplainResult>

  /**
   * 读取视图的 DDL 定义（`CREATE VIEW ...`）。
   *
   * ===== 为什么是可选方法 =====
   * 结构比较要判断"视图定义变了没有"。没有这条能力时，比较器只能看到视图
   * 存在与否，不能判断定义变化——那会让用户以为"结构一致"，实则视图逻辑
   * 已经不同。这属于**静默给出错误结论**，必须避免。
   *
   * 所以：驱动要么实现它并返回真实 DDL；要么不实现（`undefined`），
   * 上层据此把该视图标为"定义未捕获"并告警，而不是假装比较过。
   *
   * 读不到时返回 `null`（例如权限不足、视图定义已被加密），语义是
   * "这个视图存在但定义拿不到"，同样由上层告警。
   */
  viewDefinition?(id: string): Promise<string | null>

  /**
   * 列出例程（函数 / 存储过程）及其定义。
   *
   * 同上：可选。不实现表示该方言没有例程概念（如 SQLite），
   * 或驱动暂不支持。上层据此决定是否把"例程差异"计入比较。
   */
  listRoutines?(options?: { schema?: string | null }): Promise<RoutineInfo[]>
  /**
   * 按**对象 id**生成「读取该表/视图全部列」的 SELECT 语句（`SELECT * FROM <限定名>`）。
   *
   * 为什么必须由驱动生成、而不是主进程拼：表名的**限定写法**（schema/catalog 前缀、
   * 引号与转义）是方言私有知识，id 也是驱动私有编码。主进程曾用 `quoteIdentifier(name)`
   * 把整个 `table:<schema>.<name>` 的 payload 当一个标识符拼，多库/多 schema 下会拼出
   * `"public.users"` 这种错误表名，静默读到错误库的同名表。此方法把这步交还给驱动。
   */
  tableSelectSql?(nodeId: string): Promise<string>

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
   * 批量写入 CSV 数据。
   *
   * 实现要求：
   *   - `tableId` 由驱动解析，调用方不得提交拼接后的表名；
   *   - 列名必须对照目标表做白名单校验，并用方言规则引用；
   *   - 所有值必须参数化；
   *   - 第一批开启事务，后续批次复用；提交/回滚仍走既有事务方法；
   *   - 失败错误必须包含批次行号、CSV 行号和列名上下文。
   *
   * 连接上若已有用户未提交事务，导入必须拒绝开始，避免把用户改动
   * 一起提交或回滚。
   */
  importBatch(tableId: string, batch: ImportBatch): Promise<ImportBatchResult>

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

  // ---- DDL（第六阶段） ----
  //
  // 五个方法都涉及**标识符与类型名拼接**（DDL 不支持参数绑定），
  // 因此实现方必须严格校验 + 转义，不能把用户输入直接拼进语句。
  //
  // 关于 `connectionId` 形参：adapter 实例本就只服务一个连接（一个宿主一连接），
  // 所以它**用不到**这个参数。保留它只为与 `DbStudioApi` 的参数顺序对齐，
  // 实现方可直接忽略。

  /**
   * 建表。**必须保证 DDL 真正生效**（autocommit 或显式 COMMIT），
   * 使紧随其后的 `listChildren` 能看到新表。
   *
   * 为什么要强调：DDL 若落在未提交事务里，"建表成功"的返回值与
   * "目录里看不到新表"会同时成立，用户完全无法理解。这是 DDL 最常见的坑。
   */
  createTable(connectionId: string, spec: TableCreateSpec): Promise<void>

  /**
   * 删表。`nodeId` 是**完整 adapterId**（如 `table:users`），
   * 由 adapter 解析自己的 id 编码——主进程不猜 `table:` 后面的内容。
   * 对象不存在时应报错，不静默成功。
   */
  dropTable(nodeId: string): Promise<void>

  /** 建视图。`selectSql` 是视图定义体（`CREATE VIEW x AS <selectSql>`）。 */
  createView(connectionId: string, viewName: string, selectSql: string): Promise<void>

  /** 删视图。`nodeId` 是完整 adapterId（如 `view:v`）。不存在时同样报错。 */
  dropView(nodeId: string): Promise<void>

  /** 重命名表。`nodeId` 是完整 adapterId（如 `table:users`）。 */
  renameTable(nodeId: string, newName: string): Promise<void>

  /**
   * 把一个对象节点解析成「导出用的读取语句 + INSERT 落点」。
   *
   * ===== 为什么要由驱动来解析 =====
   *
   * 驱动私有的 id 编码只有驱动自己懂：
   *   - SQLite：`table:<name>`（名字里可以含冒号）
   *   - PostgreSQL：`table:<schema>.<name>`（**带 schema**）
   *
   * 主进程若自己去切冒号，PG 的 `public.users` 会被整体当成表名，
   * 生成出 `SELECT * FROM "public.users"` 这种**指错对象**的 SQL——
   * 它可能根本不存在，或者更糟：恰好存在一张叫 `public.users` 的表。
   *
   * 而把驱动实现 import 进主进程会破坏进程隔离（见本文件头的架构决策）。
   * 所以这条解析必须留在驱动侧，通过一次 RPC 送回结果。
   *
   * 这是一个**可选**方法：不实现它的驱动会得到明确的
   * "该驱动不支持按对象导出" 错误，而不是一个错误的 SQL。
   *
   * `nodeId` 是**完整 adapterId**（如 `table:public.users`），
   * 不含主进程加的连接前缀。
   */
  resolveTransferSource?(nodeId: string): Promise<TransferSourceResolution>
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
  /** 供 SQL 编辑器切分脚本与报告源码行号。 */
  readonly scriptRules: SqlScriptRules
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
  readonly kind: 'text' | 'number' | 'password' | 'file' | 'select'
  readonly required: boolean
  /**
   * `kind === 'password'` 时，该控件对应 `SecretMap` 里的哪个键。
   *
   * 为什么显式声明而不是从 `key` 猜：PG 现在有数据库口令、SSH 登录口令、
   * SSH 私钥口令三个密码框。若 UI 统一把 password 字段塞进同一个变量，
   * 后填的会覆盖先填的，表现为“测试连接时总有一个认证失败”。
   * 把映射写进方言元数据，UI 只负责按 key 收集，不再理解方言语义。
   *
   * 非 password 字段忽略此属性。
   */
  readonly secretKey?: SecretKey
  readonly placeholder?: string
  /** 默认值。 */
  readonly default?: string | number
  /**
   * `kind === 'select'` 时的候选值；其它 kind 忽略此字段。
   *
   * ===== 为什么需要它（而不是让用户手写字符串）=====
   *
   * 有些连接参数是**闭集**，典型就是 PostgreSQL 的 `sslmode`
   * （disable / allow / prefer / require / verify-ca / verify-full）。
   * 让用户自由输入会带来两类问题：
   *   1. 拼错（`verify_full`、`required`）——错误只会到连接时才暴露，
   *      而用户已经填完整个表单、点了「连接」，反馈链路很长；
   *   2. 各取值之间的语义差别很细微（`require` 与 `verify-ca` 差在**要不要校验证书**），
   *      纯输入框没有任何提示，用户只能靠猜。
   *
   * 用下拉框把「可选集合」变成**可枚举的契约**，UI 负责渲染成 select，
   * adapter 仍然要校验（UI 不是唯一入口，SDK 用户可以绕过它）。
   *
   * 与 `fields` 一样是纯数据：可结构化克隆，能过 IPC / RPC。
   */
  readonly choices?: readonly DialectFieldOption[]
}

/** `select` 型字段的一个候选项。`value` 会作为 options 的值提交。 */
export interface DialectFieldOption {
  readonly value: string
  readonly label: string
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
  'executeStatement',
  'explain',
  'fetchResultPage',
  'closeCursor',
  'applyEdits',
  'commitTransaction',
  'rollbackTransaction',
  'transactionState',
  'insertRow',
  'importBatch',
  'deleteRows',
  'countRows',
  'fetchCellValue',
  'createTable',
  'dropTable',
  'createView',
  'dropView',
  'renameTable',
  'cancelQuery',
  'resolveTransferSource',
  'viewDefinition',
  'listRoutines',
  'tableSelectSql'
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
 * RPC 远端失败的本地 Error 表示。
 *
 * 不能只拼成 `${code}: ${message}`：那样穿过 main transport 后，错误码
 * 会退化成 `internal`，调用方无法区分参数错误、能力不支持和连接故障。
 */
export class DriverRpcError extends Error {
  readonly code: RpcErrorCode

  constructor(error: RpcError) {
    super(error.message)
    this.name = 'DriverRpcError'
    this.code = error.code
  }
}

// ---------------------------------------------------------------------------
// 版本化握手契约
//
// 这几个常量是**主进程、SDK、驱动宿主三方唯一的事实来源**。
// 以前 SDK 在 `sdk/src/version.ts` 里自己定义了一份，宿主则只发一个
// 自由格式的 `adapterVersion` 字符串——两边永远不会因为版本对不上而报错，
// 只会在调用某个方法时才以「字段是 undefined」的形式爆出来。
// 现在宿主在握手帧里显式声明版本，两侧客户端在**使用宿主之前**校验。
// ---------------------------------------------------------------------------

/**
 * 握手协议版本。
 *
 * 它与驱动 API 版本分开，是因为两者的变更节奏不同：
 *   - 传输帧形状（字段名、事件/响应区分方式）变了 → 提升它；
 *   - 只是新增 RPC 方法或 adapter 接口字段 → 提升 `DRIVER_API_VERSION`。
 *
 * 这是**精确匹配**的版本：宿主与客户端必须完全一致。协议层不做
 * 「新版本兼容旧版本」的猜测——猜测失败的表现是静默错读帧。
 */
export const HANDSHAKE_PROTOCOL_VERSION = 1 as const

/**
 * 驱动适配器接口 / RPC 方法集版本。
 *
 * 宿主与客户端必须完全一致。新增可选字段不提升版本；
 * 删除方法、改变既有参数/返回值的含义时才提升。
 */
export const DRIVER_API_VERSION = 1 as const

/** 元数据结构（ObjectRef / TableDescription 等）的版本。 */
export const METADATA_SCHEMA_VERSION = 1 as const

/** 传输契约（TransferSource / ImportBatch 等）的版本。 */
export const TRANSFER_SCHEMA_VERSION = 1 as const

/**
 * 以上契约的整体版本，供调用方做「整体兼容性」的快速判断。
 *
 * 它不替代细分版本：某个 schema 单独演进时，细分版本会先变，
 * 这个整体版本用于对外声明「这一代契约」。
 */
export const SDK_CONTRACT_VERSION = 1 as const

/**
 * 握手信息：宿主进程启动后主动发第一帧，
 * 让主进程确认「这个进程是谁、支持什么」，避免盲发请求。
 *
 * ===== 为什么版本字段是「可选」的 =====
 *
 * 老宿主（以及测试里的 fake 宿主）不会带这些字段。把它们声明成必填会让
 * 类型层与旧实现直接冲突，而运行时的旧宿主依然存在。可选 + 校验时按
 * 「legacy 兼容」处理，是既能演进又不破坏既有部署的折中：
 *   - 新宿主：发送全部版本字段，客户端严格校验；
 *   - 老宿主：字段缺失，客户端接受但记录 warning，行为与改造前一致。
 *
 * 客户端**不能**因为字段缺失就拒绝——那会把升级顺序变成强耦合。
 */
export interface RpcHandshake {
  readonly kind: 'handshake'
  readonly dialectId: string
  /** 适配器实现版本（自由格式，供人排查；兼容性判断请用下面的数字版本）。 */
  readonly adapterVersion: string
  /** 握手协议版本，见 `HANDSHAKE_PROTOCOL_VERSION`。 */
  readonly protocolVersion?: number
  /** 驱动 API 版本，见 `DRIVER_API_VERSION`。 */
  readonly driverApiVersion?: number
  /** 元数据 schema 版本，见 `METADATA_SCHEMA_VERSION`。 */
  readonly metadataSchemaVersion?: number
  /** 传输 schema 版本，见 `TRANSFER_SCHEMA_VERSION`。 */
  readonly transferSchemaVersion?: number
  /** 整体契约版本，见 `SDK_CONTRACT_VERSION`。 */
  readonly sdkContractVersion?: number
  readonly pid: number
  /** 宿主进程实际运行的 Node 版本，用于排查「内置模块不可用」类问题。 */
  readonly nodeVersion: string
  readonly platform: string
}

/** 客户端对握手帧的期望值。未提供的字段不参与校验。 */
export interface HandshakeExpectation {
  readonly dialectId?: string
  readonly protocolVersion?: number
  readonly driverApiVersion?: number
  readonly metadataSchemaVersion?: number
  readonly transferSchemaVersion?: number
  readonly sdkContractVersion?: number
}

/** 握手校验失败的机器可判定原因。 */
export type HandshakeErrorCode =
  | 'malformed_handshake'
  | 'dialect_mismatch'
  | 'protocol_version_mismatch'
  | 'driver_api_version_mismatch'
  | 'metadata_schema_version_mismatch'
  | 'transfer_schema_version_mismatch'
  | 'sdk_contract_version_mismatch'

/**
 * 握手不兼容错误。
 *
 * 带上 `code` 是为了让上层（应用 UI、SDK 调用方）能区分「连错方言」与
 * 「装了一个不兼容的宿主」——两者的处置方式完全不同，而仅靠 message
 * 做字符串匹配在本地化之后必然失效。
 */
export class HandshakeValidationError extends Error {
  constructor(
    readonly code: HandshakeErrorCode,
    message: string,
    readonly expected: HandshakeExpectation = {},
    readonly handshake?: Partial<RpcHandshake>
  ) {
    super(message)
    this.name = 'HandshakeValidationError'
  }
}

/** 跨 bundle 边界也能识别握手错误（不依赖 `instanceof`）。 */
export function isHandshakeValidationError(error: unknown): error is HandshakeValidationError {
  if (error instanceof HandshakeValidationError) return true
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { name?: unknown }).name === 'HandshakeValidationError'
  )
}

export interface ValidatedHandshake {
  readonly handshake: RpcHandshake
  /** 宿主没有声明任何数字版本字段（老宿主）。 */
  readonly legacy: boolean
  /** 非致命提示，例如「宿主未声明版本字段，按 legacy 接受」。 */
  readonly warnings: readonly string[]
}

const HANDSHAKE_VERSION_FIELDS = [
  ['protocolVersion', 'protocol_version_mismatch', '握手协议版本', HANDSHAKE_PROTOCOL_VERSION],
  ['driverApiVersion', 'driver_api_version_mismatch', '驱动 API 版本', DRIVER_API_VERSION],
  ['metadataSchemaVersion', 'metadata_schema_version_mismatch', '元数据 schema 版本', METADATA_SCHEMA_VERSION],
  ['transferSchemaVersion', 'transfer_schema_version_mismatch', '传输 schema 版本', TRANSFER_SCHEMA_VERSION],
  ['sdkContractVersion', 'sdk_contract_version_mismatch', 'SDK 契约版本', SDK_CONTRACT_VERSION]
] as const

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * 校验一帧握手，返回可用的 `RpcHandshake`，不兼容时抛
 * `HandshakeValidationError`。
 *
 * 校验顺序刻意让**最容易排查的错**先报：
 *   1. 帧形状（不是对象 / kind 不对 / 缺 dialectId）
 *   2. 方言不匹配（最常见的配置错误：启动参数与连接配置不一致）
 *   3. 版本不匹配（部署错误：SDK 与宿主来自不同发布批次）
 *
 * 版本字段缺失时按 legacy 接受并返回 warning。这是为了兼容老宿主；
 * 新宿主必须发送全部字段（见 `src/driver-host/index.ts` 的 `#handshake`）。
 */
export function validateHandshake(
  frame: unknown,
  expectation: HandshakeExpectation = {}
): ValidatedHandshake {
  if (typeof frame !== 'object' || frame === null) {
    throw new HandshakeValidationError(
      'malformed_handshake',
      `驱动宿主握手失败：期望对象帧，收到 ${frame === null ? 'null' : typeof frame}`,
      expectation
    )
  }
  const candidate = frame as Partial<RpcHandshake>
  if (candidate.kind !== 'handshake') {
    throw new HandshakeValidationError(
      'malformed_handshake',
      `驱动宿主握手失败：kind 不是 "handshake"（收到 ${String(candidate.kind)}）`,
      expectation,
      candidate
    )
  }
  if (typeof candidate.dialectId !== 'string' || candidate.dialectId.length === 0) {
    throw new HandshakeValidationError(
      'malformed_handshake',
      '驱动宿主握手失败：缺少非空的 dialectId',
      expectation,
      candidate
    )
  }
  if (typeof candidate.adapterVersion !== 'string' || candidate.adapterVersion.length === 0) {
    throw new HandshakeValidationError(
      'malformed_handshake',
      `驱动宿主握手失败：缺少 adapterVersion（dialect=${candidate.dialectId}）`,
      expectation,
      candidate
    )
  }
  if (expectation.dialectId !== undefined && candidate.dialectId !== expectation.dialectId) {
    throw new HandshakeValidationError(
      'dialect_mismatch',
      `驱动宿主握手失败：方言不匹配（期望 "${expectation.dialectId}"，宿主报告 "${candidate.dialectId}"）。` +
        `请检查启动参数 --dialect 与连接配置是否一致。`,
      expectation,
      candidate
    )
  }

  const warnings: string[] = []
  let sawVersion = false

  for (const [field, code, label, fallback] of HANDSHAKE_VERSION_FIELDS) {
    const actual = candidate[field]
    const expected = expectation[field] ?? fallback
    if (actual === undefined) {
      if (expectation[field] !== undefined) {
        warnings.push(`宿主未声明 ${field}（${label}），按 legacy 兼容模式接受`)
      }
      continue
    }
    sawVersion = true
    if (!isPositiveInteger(actual)) {
      throw new HandshakeValidationError(
        code,
        `驱动宿主握手失败：${field}（${label}）不是正整数（收到 ${String(actual)}）`,
        expectation,
        candidate
      )
    }
    if (actual !== expected) {
      throw new HandshakeValidationError(
        code,
        `驱动宿主握手失败：${label}不兼容（宿主=${actual}，客户端支持=${expected}，dialect=${candidate.dialectId}）。` +
          `SDK 与驱动宿主必须来自同一发布批次，请重新安装/重新构建后重试。`,
        expectation,
        candidate
      )
    }
  }

  if (!sawVersion) {
    warnings.push(
      `宿主 ${candidate.dialectId} 未声明任何版本字段（legacy 握手），` +
        '将跳过版本校验；请升级驱动宿主以获得可诊断的兼容性检查'
    )
  }

  return { handshake: candidate as RpcHandshake, legacy: !sawVersion, warnings }
}

/** 宿主 → 主进程的事件帧（非请求响应）。 */
export type RpcEvent = RpcHandshake | { readonly kind: 'log'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }

/** 判定一帧是响应还是事件。 */
export function isRpcResponse(frame: unknown): frame is RpcResponse {
  return typeof frame === 'object' && frame !== null && typeof (frame as RpcResponse).id === 'number'
}
