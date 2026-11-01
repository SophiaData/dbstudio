/**
 * 结构元数据契约（P3.1）。
 *
 * ===== 为什么单独一个文件，而不像 ColumnDescription 那样塞进 model.ts =====
 *
 * `model.ts` 里放的是**每个对象都必须有的**东西：节点 id、名字、列。
 * 而结构元数据（外键、索引、约束、触发器）是**可选能力**：
 * 一张表可能一个外键都没有，一个驱动可能完全不支持读外键。
 *
 * 把它们混进 model.ts 会造成一个具体后果——
 * 旧驱动（只认 `id` / `columns` / `hasUniqueKey`）返回的对象会因为
 * "少字段"而在类型上不完整。于是后来者必然想加 RPC、加方法、加新接口，
 * 而不是老老实实承认「这个能力可有可无」。
 *
 * 所以这里用**一个独立模块 + 全部字段可选**来表达"可选能力"，
 * 契约的边界比实现清楚：这里是类型，这里是语义，这里是兼容性规则。
 *
 * ===== 全部通过 describeTable 返回，不新增 RPC =====
 *
 * 早期设想是开一个 `getMetadata` RPC。但那样会立刻遇到三个问题：
 *   1. 驱动宿主要多维护一个方法 + 一份参数校验；
 *   2. UI 要多一次往返，而它本来就要 describeTable 才能画 ER 图；
 *   3. **两份数据可能不一致**——describeTable 说的是"这张表有这些列"，
 *      metadata 说的是"这张表有这些外键"，中间表结构变了就对不上。
 *
 * 合并到 describeTable 的返回里，这三个问题一次性消失：
 * 一次调用拿到一份自洽的快照，也让**旧驱动原样兼容**——
 * 它照旧返回 `{ id, columns, hasUniqueKey }`，新增字段全是 undefined。
 *
 * ===== 最重要的语义：undefined ≠ 空数组 =====
 *
 * 这不是风格问题，是**能不能正确渲染**的问题：
 *
 *   - `undefined`  → 驱动**没有提供**这类信息（老驱动 / 不支持该能力）。
 *                   UI 必须显示"不支持"或"未知"，**绝不能**显示成"无外键"。
 *                   否则用户会以为这张表真的没有外键，然后写出孤儿数据。
 *   - `[]`         → 驱动**支持**这类信息，并且确认**确实没有**。
 *                   UI 可以放心显示"无外键"。
 *   - `[...]`      → 有对象。
 *
 * 一旦把前两者混同，UI 就无法区分"数据库没有"和"我们不知道"，
 * 而后者才是真正会导致数据事故的那个。
 */

/**
 * 唯一约束。
 *
 * 与 `IndexDescription` 的区别：唯一约束是**表结构的一部分**（写在 CREATE TABLE 里），
 * 索引是**独立的数据库对象**。SQLite 里两者常常指向同一个东西，
 * 所以 driver 要能把它们分开表达，UI 才能正确显示"约束"和"索引"两个分组。
 */
export interface UniqueConstraintDescription {
  /** 约束名；SQLite 不暴露表级约束名，此处为 null。 */
  readonly name: string | null
  /** 参与约束的列，按约束内顺序排列（复合唯一约束必须保序）。 */
  readonly columns: readonly string[]
}

/**
 * 外键约束。
 *
 * 对应 DBeaver 的 `DBSForeignKeyConstraint`。
 */
export interface ForeignKeyDescription {
  /** 约束名；SQLite 不暴露，此处为 null。 */
  readonly name: string | null
  /** 本表的列，按约束内顺序排列。 */
  readonly columns: readonly string[]
  /**
   * 被引用表所在的 schema。
   *
   * null 表示**与本表同 schema**——而不是"不知道"。
   * PostgreSQL 的跨 schema 外键是真实存在的场景，所以这个字段必须能区分
   * "同 schema"（null）和"跨 schema"（给出名字）。
   */
  readonly referencedSchema: string | null
  readonly referencedTable: string
  /** 被引用的列；顺序与 `columns` 一一对应。 */
  readonly referencedColumns: readonly string[]
  /** ON UPDATE 动作，如 `CASCADE` / `SET NULL` / `RESTRICT`；无则 null。 */
  readonly onUpdate: string | null
  /** ON DELETE 动作；无则 null。 */
  readonly onDelete: string | null
}

/**
 * 索引。
 *
 * 对应 DBeaver 的 `DBSIndex`。
 */
export interface IndexDescription {
  readonly name: string
  /** 是否唯一索引。 */
  readonly unique: boolean
  /**
   * 索引列。
   *
   * **表达式索引**（索引的是 `lower(name)` 这类表达式而不是列），
   * 此时这里是**空数组**，真正的表达式在 `expression` 里。
   * 不要用"columns 为空"当作"索引无效"的判据。
   */
  readonly columns: readonly string[]
  /**
   * 部分索引的过滤条件（WHERE 子句）。非部分索引为 null。
   *
   * 保留原始 SQL 文本而不做解析：条件可以是任意布尔表达式，
   * 解析成结构化形式会引入一整套表达式 AST，收益远小于成本。
   * UI 只负责展示，不负责求值。
   */
  readonly predicate: string | null
  /** 表达式索引的原始表达式文本；普通索引为 null。 */
  readonly expression: string | null
}

/**
 * CHECK 约束。
 *
 * 保留原始表达式文本，原因同 `IndexDescription.predicate`：
 * CHECK 条件是任意布尔表达式，结构化表示的复杂度不划算。
 */
export interface CheckConstraintDescription {
  /** 约束名；SQLite 不暴露表级约束名，此处为 null。 */
  readonly name: string | null
  readonly expression: string
}

/**
 * 触发器时机。
 *
 * 用**大写**的 SQL 关键字，因为这既是 SQLite 的写法，也是 PostgreSQL 的写法，
 * 跨方言归一到这里可以省掉 UI 里的字符串大小写判断。
 */
export type TriggerTiming = 'BEFORE' | 'AFTER' | 'INSTEAD OF'

/** 触发器事件。 */
export type TriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'

/**
 * 触发器。
 *
 * 对应 DBeaver 的 `DBSTrigger`。
 */
export interface TriggerDescription {
  readonly name: string
  readonly timing: TriggerTiming
  readonly event: TriggerEvent
  /** 触发体（`BEGIN ... END` 内部语句）。 */
  readonly statement: string
  /** UPDATE OF 触发器监听的列；其它事件为空数组。 */
  readonly updateOf?: readonly string[]
  /** WHEN 条件；没有条件时为 null。 */
  readonly when?: string | null
  /**
   * 是否处于启用状态。
   *
   * PostgreSQL 的触发器可以被禁用；SQLite 能读到的触发器均视为启用。
   */
  readonly enabled: boolean
}

/**
 * 驱动声明的元数据能力。
 *
 * 挂在 `DriverCapabilities.metadata` 上，供 UI 在**请求之前**就决定
 * "这个连接能不能给我看外键"。
 *
 * 注意它与 `TableDescription` 上的可选字段是**两个层次**：
 *   - 这里是**驱动级**的静态声明（连接建立时给一次）；
 *   - 那里是**表级**的实际数据（每次 describeTable 给）。
 * 两者可能不一致：驱动声明支持外键，但某张表确实没有外键，
 * 这时 `metadata.foreignKeys === true` 而该表的 `foreignKeys === []`，
 * 两者都对，不矛盾。
 */
export interface MetadataCapabilities {
  readonly foreignKeys: boolean
  readonly indexes: boolean
  readonly uniqueConstraints: boolean
  readonly checkConstraints: boolean
  readonly triggers: boolean
}

/**
 * 元数据字段的三种状态。
 *
 * 见文件头「undefined ≠ 空数组」一节：这三态必须能被区分。
 */
export type MetadataAvailability = 'unavailable' | 'empty' | 'present'

/**
 * 把可选元数据字段折叠成三态。
 *
 * 用函数而不是让 UI 到处写 `value === undefined ? ... : value.length === 0 ? ...`，
 * 是为了把这个**唯一的判定口径**收敛到一处：
 * 只要以后要改判定规则（比如加一个"部分可用"状态），
 * 改一个函数就够了，而不会漏掉某个 UI 分支。
 *
 * @param value 驱动返回的数组；undefined 表示驱动未提供该能力
 */
export function metadataAvailability(
  value: readonly unknown[] | undefined
): MetadataAvailability {
  if (value === undefined) return 'unavailable'
  return value.length === 0 ? 'empty' : 'present'
}
