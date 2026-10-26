/**
 * SQLite 方言：**纯语法知识，不含任何 I/O**。
 *
 * 按 `core/dialect.ts` 的要求，每个方法都显式实现——
 * 那边的文件头解释了为什么本项目刻意不提供"隐藏默认值"：
 * DBeaver 把 `LIMIT %d OFFSET %d` 塞在 `AbstractSQLDialect` 的默认实现里，
 * 于是"默认值"事实上变成了"多数方言的契约"，却没有任何地方写明，
 * 改一次默认值会静默影响所有方言。这里宁可每个方言各写 3 行。
 */

import type { SqlDialect } from '../../core/dialect'
import { SQLITE_SCRIPT_RULES } from '../../core/sql-script'

/** 方言 id。注册表键、`ConnectionConfig.dialectId`、`RpcHandshake.dialectId` 三处必须是同一个值。 */
export const SQLITE_DIALECT_ID = 'sqlite'

export const sqliteDialect: SqlDialect = {
  id: SQLITE_DIALECT_ID,
  name: 'SQLite',

  /**
   * SQLite 既没有 catalog 也没有 schema：
   * 一个文件就是一个库，命名空间只有"main / temp / attach 进来的库"这一层，
   * 且不通用于常规 SQL 拼名（`main.users` 只在部分语句里合法）。
   * 所以两层都声明为 'none'，UI 也就不会去渲染 catalog/schema 节点。
   */
  catalogUsage: 'none',
  schemaUsage: 'none',

  /**
   * 双引号是 SQL 标准写法，SQLite 原生支持（反引号和方括号是它从 MySQL/MSSQL
   * 借来的兼容语法）。用标准的那个，将来把这段代码挪到别的方言上时心智负担最小。
   *
   * 内部的 `"` 必须翻倍：`a"b` 要写成 `"a""b"`。
   * 这不是"美化"——不翻倍的话名字里一个引号就能破坏语句结构，
   * 属于必须防住的注入面（表名/列名是从数据库里读出来的，也是用户能建出来的）。
   */
  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
  },

  /**
   * SQLite 的分页就是 `LIMIT n OFFSET m`（offset 可省，但统一带着更好拼）。
   * 调用方负责传非负整数：这里是纯语法拼接函数，
   * 数量校验属于上层（UI/查询构建器）的职责，混进来会让本函数变成半个校验器。
   */
  buildLimitClause(limit: number, offset: number): string {
    return `LIMIT ${limit} OFFSET ${offset}`
  },

  /** 连通性探测：不需要任何表，也不产生副作用。 */
  buildPingQuery(): string {
    return 'SELECT 1'
  },

  supportsExplain: true,

  buildExplainQuery(sql: string): string {
    return `EXPLAIN QUERY PLAN ${sql}`
  },

  scriptRules: SQLITE_SCRIPT_RULES
}
