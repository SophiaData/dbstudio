/**
 * 元数据模型。
 *
 * 设计来源：DBeaver 的 `DBSObject` / `DBSObjectContainer` 继承体系
 * （证据：devel@cf0f184e `model/src/org/jkiss/dbeaver/model/struct/DBSObjectContainer.java#L55-L91`）。
 *
 * 关键取舍——**刻意不做继承体系**：
 * DBeaver 用 Java 类继承 + 泛型来表达「表 / 视图 / 索引都是容器」，
 * 但 TS 里同样的表达会带来联合类型爆炸与跨进程序列化麻烦。
 * 这里改成 **一个扁平的 ObjectRef + 判别字段 kind**，
 * 让「一套 UI 适配多方言」靠数据而不是靠类型层级实现。
 */

import type {
  CheckConstraintDescription,
  ForeignKeyDescription,
  IndexDescription,
  MetadataCapabilities,
  TriggerDescription,
  UniqueConstraintDescription
} from './metadata'

/** 节点种类。UI 只认这些值，永远不认识具体方言。 */
export type NodeKind =
  | 'connection'
  | 'catalog'
  | 'schema'
  | 'folder'
  | 'table'
  | 'view'
  | 'column'
  | 'index'
  | 'trigger'

/** 逻辑分组文件夹的固定标识，方言可以把对象挂到这些分组下。 */
export type FolderId = 'tables' | 'views' | 'indexes' | 'triggers' | 'columns'

/**
 * 一个元数据对象的最小可序列化表示。
 *
 * 这是**跨进程边界**传输的东西（driver-host → main → renderer），
 * 所以只允许放结构化克隆能处理的值——不放函数、不放类实例、不放连接句柄。
 */
export interface ObjectRef {
  /** 稳定标识。要求：同一会话内可重复解析回真实对象；可持久化。 */
  readonly id: string
  readonly kind: NodeKind
  readonly name: string
  /** 父节点 id；连接根节点为 null。 */
  readonly parentId: string | null
  /**
   * 是否可能有子节点。
   *
   * 为什么需要它：树控件必须在不展开的情况下决定要不要画展开箭头。
   * 若此处撒谎为 true，用户会展开出一个空节点——DBeaver 用
   * `DBNLazyNode` / 占位节点绕开了这个问题，我们改成让 adapter 直接回答。
   */
  readonly hasChildren: boolean
  /** 方言自由附加的展示属性（类型、可空、主键、行数估计…）。 */
  readonly meta?: Readonly<Record<string, string | number | boolean | null>>
}

/**
 * 列的完整描述，`describeTable` 的产物，用于结果集网格决定能否编辑。
 */
export interface ColumnDescription {
  readonly name: string
  /** 方言原始类型名，如 `VARCHAR(255)` / `INTEGER`。 */
  readonly typeName: string
  readonly nullable: boolean
  /** 主键序号（1 起）；非主键为 null。 */
  readonly primaryKeyOrdinal: number | null
  readonly defaultValue: string | null
  /**
   * 身份列的生成方式。
   *
   * `undefined` 表示驱动没有提供这类信息；`null` 表示确认不是身份列。
   * NOT NULL 身份列可能没有 `defaultValue`，导入向导必须结合本字段判断
   * “省略该列时数据库是否会自动生成值”。
   */
  readonly identity?: 'always' | 'by-default' | null
  /**
   * 生成列类型。
   *
   * `undefined` 表示驱动没有提供这类信息；`null` 表示确认不是生成列。
   */
  readonly generated?: 'virtual' | 'stored' | null
  /**
   * 插入时该列是否**必须**提供值（只基于已知列定义的静态判断）。
   *
   * 三态语义（与 `identity` / `generated` 一致，`undefined ≠ false`）：
   *   - `undefined` → 驱动无法可靠判断（例如 SQLite 无法确定该列是否为
   *     rowid 别名）。UI 必须按"未知"处理，**不能**据此禁用/强制输入。
   *   - `true` → 仅凭列定义即可确定：省略该列会导致插入失败
   *     （NOT NULL、无默认值、非 identity/generated，且不是 SQLite 的
   *     rowid 别名这种"省略即自动生成"的情况）。
   *   - `false` → 按列定义省略该列是安全的（有默认值、可空、identity/generated，
   *     或 SQLite rowid 别名会自动生成）。
   *
   * 边界：这是**静态必填**，不是"绝对可写"的承诺。CHECK 约束、触发器、
   * DEFAULT 表达式本身求值失败等运行时规则不在此字段的判定范围内——
   * 本字段只回答"列的 DDL 里是否写着必须给值"。
   */
  readonly requiredOnInsert?: boolean
  /** SQLite hidden/generated 列标记；驱动不支持时省略。 */
  readonly hidden?: boolean
}

/**
 * 建表时一列的定义（`createTable` 的入参）。
 *
 * ===== 为什么 typeName / defaultValue 是字符串而不是结构化类型 =====
 *
 * 我们**不做**类型系统建模（不枚举 INTEGER/VARCHAR/…）：那是一个无底洞
 * （每种数据库各有几十上百种类型与修饰符），且必然落后于数据库版本。
 * 所以类型名原样交给用户/UI 输入，adapter 负责**校验与转义**后再拼进 DDL。
 *
 * 这也意味着 typeName / defaultValue 是**注入面**：它们不是用参数绑定能解决的
 * （DDL 不支持参数绑定），只能靠 adapter 严格校验（白名单字符、拒绝 `;`/注释符等）。
 * 责任边界写在这里：模型层只表达"用户想建什么"，安全由 adapter 强制。
 */
export interface ColumnCreateSpec {
  readonly name: string
  /** 方言原始类型名，如 `TEXT` / `INTEGER` / `VARCHAR(64)`。由 adapter 校验。 */
  readonly typeName: string
  /** 是否允许 NULL。默认由 adapter 决定（通常是 true）。 */
  readonly nullable?: boolean
  /** 主键序号（1 起）。多列主键时按此排序。 */
  readonly primaryKeyOrdinal?: number
  /** 默认值（原始 SQL 文本）。由 adapter 校验。 */
  readonly defaultValue?: string
  /**
   * 是否自增。**可选，缺省时由 adapter 推断**。
   *
   * 为什么给这个字段：SQLite 的 `AUTOINCREMENT` 不是"主键自动赋值"那么简单，
   * 它改变的是 rowid 的复用语义——**不加**时删掉最大 id 的行后再插入会复用该 id，
   * **加了**则永不复用（内部维护 sqlite_sequence）。这是有实际后果的选择，
   * 不该由实现替用户偷偷决定。
   *
   * 但也不能强制用户每次都选——绝大多数场景"单 INTEGER 主键就自增"是符合直觉的。
   * 所以设计成：**缺省 undefined → adapter 按惯例推断**（单 INTEGER 主键视为自增）；
   * 显式 true/false 则覆盖推断。
   */
  readonly autoIncrement?: boolean
}

/**
 * 建表规格（`TableCreateSpec`）。
 *
 * 注意它**不带 connectionId**：连接归属由 `createTable(connectionId, spec)` 的
 * 第一个参数表达。把连接塞进 spec 会让"同一份 spec 用于不同连接"变得别扭，
 * 而连接与"表长什么样"本来就是两件事。
 */
export interface TableCreateSpec {
  readonly name: string
  readonly columns: readonly ColumnCreateSpec[]
}

/**
 * 表结构描述。
 *
 * ===== 结构元数据为什么挂在 describeTable 上，而不是单独的 RPC =====
 *
 * 见 `metadata.ts` 文件头：一处返回才能保证「列」和「外键/索引」来自同一份快照，
 * 否则两次调用之间表结构变了，UI 会画出对不上的 ER 图。
 *
 * ===== 下面几个可选字段的三态语义（务必读）=====
 *
 *   - `undefined` → 驱动**没有提供**这类信息（老驱动，或该方言不支持）。
 *     UI 必须显示"不支持/未知"，**不能**显示成"无"——
 *     否则用户会以为表真的没有外键，然后写出孤儿数据。
 *   - `[]`        → 驱动支持这类信息，且**确认没有**。
 *   - `[...]`     → 有对象。
 *
 * 判定请统一走 `metadataAvailability()`（`metadata.ts`），不要在各处散着写
 * `value === undefined`——那是最容易漏掉一个分支的地方。
 */
export interface TableDescription {
  readonly id: string
  readonly columns: readonly ColumnDescription[]
  /**
   * 是否具备「唯一行标识」。
   *
   * 直接对应 DBeaver 的 `DBDRowIdentifier` 缺失判定
   * （证据：`ResultSetPersister.java#L501-L563` 缺唯一键时抛 "No unique key defined"）。
   * 没有它就不能在线编辑——这条规则我们提前到模型层表达，
   * 而不是等到用户改了单元格才报错。
   */
  readonly hasUniqueKey: boolean
  /** 唯一约束（表结构的一部分），与索引分开表达。 */
  readonly uniqueConstraints?: readonly UniqueConstraintDescription[]
  /** 外键约束。ER 图的关系线就来自这里。 */
  readonly foreignKeys?: readonly ForeignKeyDescription[]
  /** 索引（含唯一索引与部分索引）。 */
  readonly indexes?: readonly IndexDescription[]
  /** CHECK 约束。 */
  readonly checks?: readonly CheckConstraintDescription[]
  /** 触发器。 */
  readonly triggers?: readonly TriggerDescription[]
}

/**
 * 方言能力声明。
 *
 * DBeaver 的能力探测是「三机制并存」：接口布尔方法、描述符声明、运行时探测
 * （证据：`03-metadata-dialect.md` 问题 5）。
 * 三套并存是历史包袱，我们**只用一套**：由 adapter 在连接建立后给出，
 * 可以是静态声明，也可以是运行时探测的结果，但出口只有这一个。
 */
export interface DriverCapabilities {
  /** 结果集能否直接改数据（依赖唯一键）。 */
  readonly supportsInlineEdit: boolean
  /** 是否支持服务端分页（false 则必须客户端截断，UI 要警告）。 */
  readonly supportsServerPagination: boolean
  readonly hasCatalog: boolean
  readonly hasSchema: boolean
  /** 查询能否取消。 */
  readonly supportsCancel: boolean
  /**
   * 该驱动支持哪些结构元数据。
   *
   * undefined 表示**旧驱动没有声明这件事**——UI 要回退到
   * 「看这张表的 describeTable 里有没有对应字段」来判断，
   * 而不是直接当成"不支持"。
   *
   * 它是**驱动级静态声明**（连上时给一次），
   * 与 `TableDescription` 上的**表级实际数据**是两个层次：
   * 声明支持外键但某张表没有外键，是完全正常的状态。
   */
  readonly metadata?: MetadataCapabilities
}
