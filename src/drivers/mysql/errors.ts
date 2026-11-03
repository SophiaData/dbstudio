/**
 * MySQL 适配器的错误类型。
 *
 * 单独成文件是为了让 `ddl.ts` 能抛同一类错误，又不反向 import `adapter.ts`
 * （那会形成循环依赖，也会把 `mysql2` 拖进只需要构造 SQL 的模块）。
 */
export class MysqlAdapterError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'MysqlAdapterError'
    this.code = code
  }
}
