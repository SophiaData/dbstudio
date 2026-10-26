/**
 * PostgreSQL 方言：**纯语法知识，不含任何 I/O**。
 *
 * 与 SQLite 的 `dialect.ts` 逐方法对照写，不共享任何默认实现——
 * 理由见 `core/dialect.ts` 文件头：本项目刻意不提供"隐藏默认值"，
 * 因为 DBeaver 的 `LIMIT %d OFFSET %d` 默认实现事实上变成了"多数方言的契约"，
 * 却没有一行文档写明它，改一次会静默影响所有方言。
 *
 * ===== 加第二个方言时的关键提醒（来自本项目 03-metadata-dialect 的结论）=====
 *
 * PostgreSQL 的 catalog / schema 用法与 MySQL **恰好相反**：
 *   MySQL      catalog = none, schema = all
 *   PostgreSQL catalog = dml,  schema = all
 * 证据：DBeaver `AbstractSQLDialect` 默认 `USAGE_NONE`，两侧方言在各自
 * `plugin.xml` 的 `<dialect>` 声明里覆盖。后果很实际：**统一拼
 * `catalog.schema.table` 全限定名会在其中一方直接报错**。
 * 所以这里如实声明 catalogUsage = 'dml'（PG 的 catalog 只用于连接级语句，
 * 不能进 DML 的表名限定），schemaUsage = 'all'。
 */

import type { SqlDialect } from '../../core/dialect'
import { POSTGRESQL_SCRIPT_RULES } from '../../core/sql-script'

/** 方言 id。注册表键、`ConnectionConfig.dialectId`、`RpcHandshake.dialectId` 三处必须是同一个值。 */
export const POSTGRESQL_DIALECT_ID = 'postgresql'

export const postgresqlDialect: SqlDialect = {
  id: POSTGRESQL_DIALECT_ID,
  name: 'PostgreSQL',

  /**
   * catalog 与 schema 的用法（见文件头）。
   *
   * PG 里 catalog 就等于"当前连接的数据库"（`CURRENT_DATABASE()`），
   * 一个连接只可能看到自己那一个 catalog；跨库要另开连接，
   * 所以 catalog 只体现为连接级（dml），真正能用来限定表名的是 schema。
   */
  catalogUsage: 'dml',
  schemaUsage: 'all',

  /**
   * 双引号是 SQL 标准写法，PG 原生支持，内部的 `"` 必须翻倍。
   *
   * ⚠️ 与 SQLite 的关键差异：**PG 对未加引号的标识符会折叠成小写**，
   * 而 SQLite 不折叠（SQLite 标识符本身大小写不敏感，但保留原样）。
   * 也就是说 `CREATE TABLE Users (...)` 在 PG 里建出的真实表名是 `users`，
   * 之后 `SELECT * FROM Users` 能找到它（同样折叠），但
   * `SELECT * FROM "Users"` 会**找不到**（带引号 = 精确匹配大小写）。
   *
   * 这条差异直接决定本驱动的元数据策略：**一律用代码返回的真实名字**
   * （即 information_schema 里存的那份，已是折叠后的形态），
   * 拼接时一律加引号。绝不能把用户输入的名字原样当成带引号标识符去匹配——
   * 那会把 `Users`（用户以为的表名）与库里的 `users` 判成两个对象。
   */
  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
  },

  /**
   * 分页就是 `LIMIT n OFFSET m`（与 SQLite 相同，但这里仍显式写，不吃默认值）。
   * 调用方负责传非负整数；数量校验属于上层，混进来会让本函数变成半个校验器。
   */
  buildLimitClause(limit: number, offset: number): string {
    return `LIMIT ${limit} OFFSET ${offset}`
  },

  /**
   * 连通性探测：`SELECT 1` 在 PG 里是标准用法，不需要任何表，也不产生副作用。
   * （`SELECT 1` 在 PG 里返回 integer 类型，不是 boolean——别被值长得像 1 骗了。）
   */
  buildPingQuery(): string {
    return 'SELECT 1'
  },

  supportsExplain: true,

  buildExplainQuery(sql: string): string {
    return `EXPLAIN (FORMAT JSON) ${sql}`
  },

  scriptRules: POSTGRESQL_SCRIPT_RULES
}
