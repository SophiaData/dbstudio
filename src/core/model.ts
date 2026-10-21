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

/** 列的完整描述，`describeTable` 的产物，用于结果集网格决定能否编辑。 */
export interface ColumnDescription {
  readonly name: string
  /** 方言原始类型名，如 `VARCHAR(255)` / `INTEGER`。 */
  readonly typeName: string
  readonly nullable: boolean
  /** 主键序号（1 起）；非主键为 null。 */
  readonly primaryKeyOrdinal: number | null
  readonly defaultValue: string | null
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

/** 表结构描述。 */
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
}
