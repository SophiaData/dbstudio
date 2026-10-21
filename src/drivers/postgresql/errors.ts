/**
 * PostgreSQL 适配器的错误类型。
 *
 * 与 `sqlite/errors.ts` 同一职责、同一形状：带机器可判定的 `RpcErrorCode`，
 * 宿主进程据此决定 UI 是"提示用户 / 重试 / 对象失效"（见 `src/driver-host/index.ts`
 * 的 `pickErrorCode`：它按白名单原样透传 adapter 抛出的合法 code）。
 *
 * 为什么每个方言各自一份而不是共用：错误消息里会带方言特有的修复建议
 * （PG 要提示 schema、SQLite 要提示文件路径），共用会让消息退化成泛泛而谈；
 * 且共用意味着 pg 驱动的错误类要出现在主进程能看到的地方，界限不清。
 */

import type { RpcErrorCode } from '../../core/driver'

export class PostgresAdapterError extends Error {
  readonly code: RpcErrorCode

  constructor(code: RpcErrorCode, message: string, cause?: unknown) {
    // cause 保留原始异常：message 给人看，cause 给排查用
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'PostgresAdapterError'
    this.code = code
  }
}

/** 把任意 throw 出来的东西变成一句可读文本；绝不让 `[object Object]` 出现在用户面前。 */
export function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message
  if (typeof thrown === 'string') return thrown
  return String(thrown)
}

/**
 * 把 `pg` 抛出的错误映射成本适配器的错误码。
 *
 * `pg` 的错误对象带 `code`（PostgreSQL 的 SQLSTATE，5 字符）与 `severity`。
 * 我们只关心几类：
 *   - `42P01` undefined_table / `42703` undefined_column / `3F000` invalid_schema
 *     → `object_not_found`（对象没了，UI 应该提示刷新树）
 *   - `23505` unique_violation / `23503` foreign_key_violation / `23502` not_null_violation
 *     → `bad_params`（是用户数据/请求的问题，不是系统故障）
 *   - `28P01` invalid_password / `28000` invalid_authorization → `connection_failed`
 *   - `42601` syntax_error → `query_failed`
 * 其余一律交给调用方按上下文决定（建连路径归 connection_failed，执行路径归 query_failed）。
 */
export function mapPgErrorCode(thrown: unknown): RpcErrorCode | null {
  const code = (thrown as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return null
  switch (code) {
    case '42P01': // undefined_table
    case '42703': // undefined_column
    case '3F000': // invalid_schema_name
    case '42883': // undefined_function
      return 'object_not_found'
    case '23505': // unique_violation
    case '23503': // foreign_key_violation
    case '23502': // not_null_violation
    case '22P02': // invalid_text_representation（类型不匹配）
      return 'bad_params'
    case '28P01': // invalid_password
    case '28000': // invalid_authorization_specification
    case '3D000': // invalid_catalog_name（库不存在）
      return 'connection_failed'
    case '42601': // syntax_error
      return 'query_failed'
    default:
      return null
  }
}

/** 把 `pg` 错误包装成本适配器错误：优先用 SQLSTATE 映射的码，映射不到用兜底码。 */
export function wrapPgError(
  thrown: unknown,
  fallbackCode: RpcErrorCode,
  prefix: string
): PostgresAdapterError {
  const mapped = mapPgErrorCode(thrown)
  const code = mapped ?? fallbackCode
  const raw = describeThrown(thrown)
  return new PostgresAdapterError(code, `${prefix}（原始错误：${raw}）`, thrown)
}
