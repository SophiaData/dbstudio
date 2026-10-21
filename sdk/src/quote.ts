/**
 * 标识符引号工具的便捷封装。
 *
 * 调用方拼 SQL 时最常做两件事：给表名/列名加引号、给值做参数化占位。
 * 这两件事都不该让使用者去查方言细节，所以提供这层薄封装。
 */

import type { DialectInfo, QuotingRules } from './contracts/driver.js'
import { quoteIdentifierWith } from './contracts/driver.js'

export const Quote = {
  /** 按方言的引号规则转义一个标识符（表名 / 列名）。 */
  identifier(name: string, rules: QuotingRules): string {
    return quoteIdentifierWith(name, rules)
  },

  /** 从方言元数据直接取引号规则来转义。 */
  identifierFrom(name: string, info: Pick<DialectInfo, 'quoting'>): string {
    return quoteIdentifierWith(name, info.quoting)
  },

  /**
   * 生成 N 个参数占位符，用于 `IN (...)` 或批量插入。
   * 返回 `?, ?, ?` 这样的字符串；**值本身必须另行作为参数传入**，
   * 绝不要把值拼进 SQL。
   */
  placeholders(count: number): string {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`placeholders 需要正整数，收到 ${count}`)
    }
    return new Array(count).fill('?').join(', ')
  }
} as const
