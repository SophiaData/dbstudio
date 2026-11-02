/**
 * MySQL / MariaDB 方言：纯语法知识，不含 I/O。
 *
 * 与 SQLite / PostgreSQL 一样，每个方法显式实现，不靠"隐藏默认值"。
 */

import type { SqlDialect } from '../../core/dialect'
import type { SqlScriptRules } from '../../core/sql-script'

export const MYSQL_DIALECT_ID = 'mysql'

/**
 * MySQL 脚本规则。
 *
 * 与其它方言的关键差别：
 *   - `#` 也是行注释（MySQL 特有）；`--` 后**必须跟空白**才算注释，
 *     但切分器这里按前缀匹配即可，宽松一点不会把语句切坏（宁可少切不可错切，
 *     真正的语法由服务器判定）。
 *   - 存储过程 / 触发器里有 `BEGIN ... END`，语句内部的 `;` 不是分隔符——
 *     由 `supportsBeginEndBlocks` 让切分器识别块结构。
 *   - 字符串**不用** `$$`（那是 PostgreSQL 的 dollar-quoting）。
 */
export const MYSQL_SCRIPT_RULES: SqlScriptRules = {
  lineCommentPrefixes: ['--', '#'],
  blockComment: { start: '/*', end: '*/' },
  supportsDollarQuotedStrings: false,
  supportsBeginEndBlocks: true,
  statementTerminators: [';']
}

export const mysqlDialect: SqlDialect = {
  id: MYSQL_DIALECT_ID,
  name: 'MySQL',

  /**
   * MySQL 没有独立的 catalog 层：一个 database 就同时充当 schema。
   * 所以 catalogUsage = 'none'，schemaUsage = 'all'（database 名可以出现在
   * `db.table` 这种限定写法里，DML 也能用）。
   */
  catalogUsage: 'none',
  schemaUsage: 'all',

  /**
   * 标识符用反引号。内部反引号翻倍：`` a`b `` → `` `a``b` ``。
   *
   * ===== 为什么这里可以用反引号，而不会拖垮全应用 =====
   * 渲染进程曾经要求"所有方言引号规则一致"才敢拼排序 SQL；加入反引号后那条
   * 前提失效。已把 `pickQuotingRules` 改成**按当前连接的方言取规则**，所以
   * 每个方言用自己的引号即可，不会再出现"一个方言不一致，全部禁用排序"。
   */
  quoteIdentifier(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``
  },

  buildLimitClause(limit: number, offset: number): string {
    // MySQL 支持 LIMIT n OFFSET m（也支持 LIMIT m, n，但前者更接近标准、更易读）。
    return `LIMIT ${limit} OFFSET ${offset}`
  },

  buildPingQuery(): string {
    return 'SELECT 1'
  },

  supportsExplain: true,

  buildExplainQuery(sql: string): string {
    // MySQL 的 EXPLAIN 直接前缀在语句上，返回结构化行（不是 JSON）。
    return `EXPLAIN ${sql}`
  },

  scriptRules: MYSQL_SCRIPT_RULES
}
