/**
 * 非 SQL 数据源（Redis / Kafka）的公共基类。
 *
 * 这类连接只支持“测试连接 + 浏览”，不是 SQL 工作台。DriverAdapter 契约里所有
 * SQL / 编辑 / DDL 方法统一抛 `unsupported_method`，让 UI 和调用方拿到一条
 * 清楚的错误，而不是在驱动里半实现出错误的语义。
 */

import type { SqlDialect } from '../core/dialect'
import type { DialectInfo, RpcErrorCode } from '../core/driver'
import type { SqlScriptRules } from '../core/sql-script'
import type { TableDescription } from '../core/model'
import type { TransactionState } from '../core/resultset'

export class NoSqlAdapterError extends Error {
  readonly code: RpcErrorCode

  constructor(code: RpcErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'NoSqlAdapterError'
    this.code = code
  }
}

export const NO_SQL_SCRIPT_RULES: SqlScriptRules = {
  lineCommentPrefixes: [],
  blockComment: { start: '/*', end: '*/' },
  supportsDollarQuotedStrings: false,
  supportsBeginEndBlocks: false,
  statementTerminators: [';']
}

/** 这些方言没有 SQL；这里只为满足 SqlDialect 的结构，查询入口会先被拒。 */
export function noSqlDialect(id: string, name: string): SqlDialect {
  return {
    id,
    name,
    catalogUsage: 'none',
    schemaUsage: 'none',
    quoteIdentifier: (value: string) => value,
    buildLimitClause: () => '',
    buildPingQuery: () => '',
    supportsExplain: false,
    buildExplainQuery: () => '',
    scriptRules: NO_SQL_SCRIPT_RULES
  }
}

export abstract class NoSqlAdapterBase {
  abstract readonly dialect: SqlDialect
  abstract readonly info: DialectInfo

  protected unsupported(method: string): never {
    throw new NoSqlAdapterError(
      'unsupported_method',
      `${this.info.name} 连接只支持测试连接与浏览，不支持 ${method}`
    )
  }

  async describeTable(_id: string): Promise<TableDescription> {
    return this.unsupported('读取表结构')
  }
  async cancelQuery(): Promise<boolean> {
    return false
  }
  async query(): Promise<never> {
    return this.unsupported('SQL 查询')
  }
  async executeStatement(): Promise<never> {
    return this.unsupported('执行 SQL')
  }
  async explain(): Promise<never> {
    return this.unsupported('执行计划')
  }
  async fetchResultPage(): Promise<never> {
    return this.unsupported('结果集分页')
  }
  async closeCursor(): Promise<void> {
    // 没有游标可关；保持幂等，与 SQL 驱动的 closeCursor 语义一致。
  }
  async applyEdits(): Promise<never> {
    return this.unsupported('在线编辑')
  }
  async commitTransaction(): Promise<never> {
    return this.unsupported('事务')
  }
  async rollbackTransaction(): Promise<never> {
    return this.unsupported('事务')
  }
  async transactionState(): Promise<TransactionState> {
    return { active: false, pendingAffected: 0 }
  }
  async insertRow(): Promise<never> {
    return this.unsupported('插入行')
  }
  async importBatch(): Promise<never> {
    return this.unsupported('导入')
  }
  async deleteRows(): Promise<never> {
    return this.unsupported('删除行')
  }
  async countRows(): Promise<never> {
    return this.unsupported('统计行数')
  }
  async fetchCellValue(): Promise<never> {
    return this.unsupported('读取单元格')
  }
  async createTable(): Promise<never> {
    return this.unsupported('建表')
  }
  async dropTable(): Promise<never> {
    return this.unsupported('删表')
  }
  async createView(): Promise<never> {
    return this.unsupported('建视图')
  }
  async dropView(): Promise<never> {
    return this.unsupported('删视图')
  }
  async renameTable(): Promise<never> {
    return this.unsupported('重命名')
  }
}

export function stringOption(options: Readonly<Record<string, unknown>>, key: string, fallback = ''): string {
  const value = options[key]
  return value === undefined || value === null ? fallback : String(value).trim()
}

export function portOption(options: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const raw = options[key]
  if (raw === undefined || raw === null || raw === '') return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NoSqlAdapterError('bad_params', `端口无效：${String(raw)}`)
  }
  return port
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}
