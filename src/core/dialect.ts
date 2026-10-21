/**
 * SQL 方言契约。
 *
 * 设计来源：DBeaver 的 `SQLDialect` 接口 + `AbstractSQLDialect` 默认骨架
 * （证据：devel@cf0f184e `model/src/org/jkiss/dbeaver/model/sql/SQLDialect.java#L46`，
 *        `model/src/org/jkiss/dbeaver/model/impl/sql/AbstractSQLDialect.java#L50`）。
 *
 * 但有一处**关键的、经验证的教训必须照抄**：
 *
 * DBeaver 的 `getOffsetLimitQueryPart` 全仓只有 **2 处** 命中——接口声明
 * （`SQLDialect.java#L332`）与唯一一份默认实现（`AbstractSQLDialect.java#L643-L645`，
 * 内容就是 `LIMIT %d OFFSET %d`）。MySQL 与 PostgreSQL **都没有覆盖它**，
 * 而 MySQL 的真实分页语法恰好就是 `LIMIT n OFFSET m`。
 *
 * 也就是说：「默认值」实际上承担了「多数方言的契约」这个角色，
 * 而契约藏在默认实现里、没有文档、改了默认值会静默影响所有方言——
 * 剖析报告称之为「默认值即隐式契约」。
 *
 * 本项目的应对：**不提供任何隐藏默认值**。
 * 每个方法都必须显式实现，宁可多写几行，也不要一个会静默传播的默认。
 */

/**
 * 命名空间（catalog / schema）的使用方式。
 *
 * 这个类型的存在本身来自一条实证：MySQL 的 schema 用法是 `all`、
 * catalog 用法是 `none`；PostgreSQL 恰好相反（catalog 近乎不可用、schema 是主力）。
 * 证据：`AbstractSQLDialect.java#L296-L304` 默认 `USAGE_NONE`，
 * 两侧方言在各自 `plugin.xml` 的 `<dialect>` 声明里覆盖。
 *
 * 后果很实际：**统一拼 `catalog.schema.table` 全限定名会在其中一方直接报错**。
 */
export type NamespaceUsage = 'none' | 'dml' | 'all'

/** 连接配置。由 UI 采集，经 IPC 传到主进程，再传给驱动宿主进程。 */
export interface ConnectionConfig {
  /** 方言 id，用于在注册表里选中 adapter。 */
  readonly dialectId: string
  /** 展示名（用户可改）。 */
  readonly name: string
  /**
   * 方言自定义的连接参数。
   * 例如 SQLite 用 `{ file }`，PostgreSQL 用 `{ host, port, database, user }`。
   * 密码**不放在这里**——它走独立的 secret 通道，不进配置对象，
   * 以免被日志或配置文件顺手带走。
   */
  readonly options: Readonly<Record<string, string | number | boolean>>
}

/**
 * 方言实现。
 *
 * 注意这里**只有纯函数式的语法知识**，不含任何 I/O——
 * I/O 属于 `DriverAdapter`（见 driver.ts）。这条分界对应 DBeaver 的
 * `model`（无 UI、无 I/O 的语法知识）与 `model.jdbc`（JDBC 实现层）的拆分。
 */
export interface SqlDialect {
  /** 唯一 id，与 `ConnectionConfig.dialectId` 对应。 */
  readonly id: string
  /** 人类可读名，如 "SQLite" / "PostgreSQL"。 */
  readonly name: string

  /** 是否需要 catalog 层。 */
  readonly catalogUsage: NamespaceUsage
  /** 是否需要 schema 层。 */
  readonly schemaUsage: NamespaceUsage

  /** 把标识符按方言规则加引号（MySQL 反引号 / PG 双引号 / SQLite 双引号）。 */
  quoteIdentifier(name: string): string

  /** 拼分页子句。**故意不给默认实现坑**——见文件头注释。 */
  buildLimitClause(limit: number, offset: number): string

  /** 用于连接可用性探测的语句。SQLite 返回 `SELECT 1`。 */
  buildPingQuery(): string
}
