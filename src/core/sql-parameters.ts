import type { SqlParameter, SqlParameterValue } from './resultset'

export type SqlParameterDialect = 'sqlite' | 'postgresql'

export interface SqlPlaceholder {
  readonly name: string
  readonly kind: 'positional' | 'named'
  readonly start: number
  readonly end: number
}

export class SqlParameterError extends Error {
  readonly code = 'bad_params' as const

  constructor(message: string) {
    super(message)
    this.name = 'SqlParameterError'
  }
}

interface ScanResult {
  readonly placeholders: readonly SqlPlaceholder[]
  readonly unsafeReason: string | null
}

export interface SqlParameterInspection {
  readonly safe: boolean
  readonly placeholders: readonly SqlPlaceholder[]
  readonly reason: string | null
}

function isNameStart(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}_]/u.test(ch)
}

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_$]/u.test(ch)
}

function scanSql(sql: string, dialect: SqlParameterDialect): ScanResult {
  const placeholders: SqlPlaceholder[] = []
  let anonymousIndex = 0
  let i = 0
  const unsafe = (reason: string): ScanResult => ({ placeholders, unsafeReason: reason })

  while (i < sql.length) {
    const ch = sql[i] as string
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (dialect === 'postgresql' && sql.startsWith('/*', i)) { depth += 1; i += 2 }
        else if (sql.startsWith('*/', i)) { depth -= 1; i += 2 }
        else i += 1
      }
      if (depth > 0) return unsafe('SQL 包含未闭合的块注释，无法安全识别参数。')
      continue
    }
    if (ch === "'" || ch === '"' || (dialect === 'sqlite' && (ch === '`' || ch === '['))) {
      const quote = ch === '[' ? ']' : ch
      const escapes = dialect === 'postgresql' && ch === "'" && /[eE]/.test(sql[i - 1] ?? '') && !isNameChar(sql[i - 2])
      i += 1
      let closed = false
      while (i < sql.length) {
        if (escapes && sql[i] === '\\') { i += 2; continue }
        if (sql[i] === quote) {
          if (ch !== '[' && sql[i + 1] === quote) { i += 2; continue }
          i += 1
          closed = true
          break
        }
        i += 1
      }
      if (!closed) return unsafe('SQL 包含未闭合的引号，无法安全识别参数。')
      continue
    }
    if (ch === '$' && !isNameChar(sql[i - 1])) {
      if (dialect === 'postgresql') {
        const tag = /^(?:\$\$|\$[\p{L}_][\p{L}\p{N}_]*\$)/u.exec(sql.slice(i))?.[0]
        if (tag) {
          const close = sql.indexOf(tag, i + tag.length)
          if (close === -1) return unsafe('SQL 包含未闭合的 dollar quote，无法安全识别参数。')
          i = close + tag.length
          continue
        }
        const match = /^\$[0-9]+/.exec(sql.slice(i))?.[0]
        if (match) {
          const position = Number(match.slice(1))
          if (!/^\$[1-9][0-9]*$/.test(match) || !Number.isSafeInteger(position) || position > 65535) {
            return unsafe('PostgreSQL 参数位置必须为 $1 到 $65535。')
          }
          placeholders.push({ name: match, kind: 'positional', start: i, end: i + match.length })
          i += match.length
          continue
        }
      } else if (isNameChar(sql[i + 1])) {
        return unsafe('SQLite 参数请使用 ? 或 :name，不支持 $ 参数。')
      }
    }
    if (ch === ':' && sql[i + 1] === ':') { i += 2; continue }
    if (dialect === 'sqlite' && ch === ':' && /\d/.test(sql[i + 1] ?? '')) {
      return unsafe('SQLite 数字名称参数暂不支持，请使用 ? 或 :name。')
    }
    if (ch === ':' && isNameStart(sql[i + 1])) {
      if (dialect === 'postgresql') return unsafe('PostgreSQL 只支持 $1、$2 形式的参数，请显式填写对应值。')
      let end = i + 2
      while (isNameChar(sql[end])) end += 1
      placeholders.push({ name: sql.slice(i + 1, end), kind: 'named', start: i, end })
      i = end
      continue
    }
    if (dialect === 'sqlite' && ch === '@' && isNameChar(sql[i + 1])) {
      return unsafe('SQLite 参数请使用 ? 或 :name，不支持 @ 参数。')
    }
    if (ch === '?' && dialect === 'sqlite') {
      if (/\d/.test(sql[i + 1] ?? '')) return unsafe('SQLite 数字编号占位符 ?N 暂不支持，请使用 ? 或 :name 参数。')
      anonymousIndex += 1
      placeholders.push({ name: `?${anonymousIndex}`, kind: 'positional', start: i, end: i + 1 })
    }
    i += 1
  }
  return { placeholders, unsafeReason: null }
}

function canonicalName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.startsWith(':')) return trimmed.slice(1)
  return trimmed
}

function binaryFromUnknown(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value.slice()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const object = value as Record<string, unknown>
  // NDJSON cannot preserve typed arrays; the host client uses this explicit wire tag.
  if (object.type === 'dbstudio-sql-bytes' && Array.isArray(object.data) &&
      object.data.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(object.data)
  }
  const keys = Object.keys(object)
  if (keys.length > 0 && keys.every((key, index) => key === String(index))) {
    const bytes = keys.map(key => object[key])
    if (bytes.every(item => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) {
      return Uint8Array.from(bytes as number[])
    }
  }
  return null
}

export function normalizeSqlParameterValue(value: unknown, where = 'parameter.value'): SqlParameterValue {
  const binary = binaryFromUnknown(value)
  if (binary !== null) return binary
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new SqlParameterError(`${where} 必须是 string、number、boolean、null 或 Uint8Array。`)
}

export function bindSqlParameters(
  sql: string,
  parameters: readonly SqlParameter[] | undefined,
  dialect: SqlParameterDialect
): { readonly sql: string; readonly values: readonly SqlParameterValue[] } {
  const scan = scanSql(sql, dialect)
  if (scan.unsafeReason !== null) throw new SqlParameterError(scan.unsafeReason)

  const supplied = parameters ?? []
  const suppliedByName = new Map<string, SqlParameterValue>()
  for (let index = 0; index < supplied.length; index += 1) {
    const parameter = supplied[index]
    if (parameter === undefined || typeof parameter.name !== 'string' || parameter.name.trim() === '') {
      throw new SqlParameterError(`options.parameters[${index}].name 必须是非空字符串。`)
    }
    const key = canonicalName(parameter.name)
    if (suppliedByName.has(key)) throw new SqlParameterError(`参数 ${parameter.name} 重复。`)
    suppliedByName.set(key, normalizeSqlParameterValue(parameter.value, `options.parameters[${index}].value`))
  }

  const used = new Set<string>()
  const values: SqlParameterValue[] = []
  for (const placeholder of scan.placeholders) {
    const key = canonicalName(placeholder.name)
    const value = suppliedByName.get(key)
    if (value === undefined && !suppliedByName.has(key)) {
      throw new SqlParameterError(`缺少参数 ${placeholder.name}。`)
    }
    used.add(key)
    if (dialect === 'sqlite') {
      values.push(value as SqlParameterValue)
    }
  }

  for (const key of suppliedByName.keys()) {
    if (!used.has(key)) throw new SqlParameterError(`参数 ${key} 没有对应的 SQL 占位符。`)
  }

  if (dialect === 'postgresql') {
    const maxIndex = scan.placeholders.reduce((max, placeholder) => {
      const index = Number(placeholder.name.slice(1))
      return Math.max(max, index)
    }, 0)
    const pgValues: SqlParameterValue[] = []
    for (let index = 1; index <= maxIndex; index += 1) {
      const key = `$${index}`
      const value = suppliedByName.get(key)
      if (value === undefined && !suppliedByName.has(key)) {
        throw new SqlParameterError(`缺少参数 ${key}。`)
      }
      pgValues.push(value as SqlParameterValue)
    }
    return { sql, values: pgValues }
  }

  let rewritten = ''
  let cursor = 0
  for (const placeholder of scan.placeholders) {
    rewritten += sql.slice(cursor, placeholder.start) + '?'
    cursor = placeholder.end
  }
  return { sql: rewritten + sql.slice(cursor), values }
}

export function extractSqlParameters(sql: string, dialect: SqlParameterDialect = 'sqlite'): readonly SqlPlaceholder[] {
  return inspectSqlParameters(sql, dialect).placeholders
}

export function inspectSqlParameters(sql: string, dialect: SqlParameterDialect = 'sqlite'): SqlParameterInspection {
  const scan = scanSql(sql, dialect)
  return {
    safe: scan.unsafeReason === null,
    placeholders: scan.placeholders,
    reason: scan.unsafeReason
  }
}
