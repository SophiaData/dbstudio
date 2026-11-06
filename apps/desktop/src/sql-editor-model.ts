import { formatSql, scanContexts } from '../../../src/renderer/sql-format'
import { isFunctionKeyword, isStatementKeyword } from '../../../src/renderer/sql-keywords'
import { splitStatements, type SqlScriptRules } from '../../../src/core/sql-script'
import {
  bindSqlParameters,
  extractSqlParameters,
  inspectSqlParameters,
  type SqlParameterDialect
} from '../../../src/core/sql-parameters'
import type { SqlParameter, SqlParameterValue } from '../../../src/core/resultset'

export function currentSql(sql: string, start: number, end: number, rules: SqlScriptRules): string {
  if (end > start && sql.slice(start, end).trim()) return sql.slice(start, end).trim()
  const statements = splitStatements(sql, rules)
  return statements.find((statement) => start >= statement.startOffset && start <= statement.endOffset)?.sql
    ?? [...statements].reverse().find((statement) => statement.endOffset <= start)?.sql
    ?? statements[0]?.sql ?? ''
}
export function formattedSql(sql: string) {
  const formatted = formatSql(sql)
  if (formatted.replace(/\s/g, '').toLowerCase() !== sql.replace(/\s/g, '').toLowerCase()) throw new Error('格式化校验失败，已保留原 SQL')
  return formatted
}
export function highlightTokens(sql: string): { text: string; kind: string }[] {
  const contexts = scanContexts(sql)
  const tokens: { text: string; kind: string }[] = []
  let index = 0
  while (index < sql.length) {
    const state = contexts[index]
    let end = index + 1
    let kind = ''
    if (state !== 'normal') {
      while (end < sql.length && contexts[end] === state) end++
      kind = state === 'string' ? 'string' : state === 'quotedIdent' ? 'identifier' : 'comment'
    } else if (/[A-Za-z_]/.test(sql[index]!)) {
      while (end < sql.length && contexts[end] === 'normal' && /[\w$]/.test(sql[end]!)) end++
      const word = sql.slice(index, end)
      kind = isStatementKeyword(word) ? 'keyword' : isFunctionKeyword(word) ? 'function' : ''
    } else if (/\d/.test(sql[index]!)) {
      while (end < sql.length && contexts[end] === 'normal' && /[\d.]/.test(sql[end]!)) end++
      kind = 'number'
    }
    const text = sql.slice(index, end)
    const last = tokens.at(-1)
    if (last?.kind === kind) last.text += text
    else tokens.push({ text, kind })
    index = end
  }
  return tokens
}

const DRAFT_PREFIX = 'dbstudio.vue.sql-draft.v1.'
export function createDraftStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
  const memory = new Map<string, string>()
  return {
    read(id: string) {
      if (!id) return ''
      if (memory.has(id)) return memory.get(id)!
      try { return storage?.getItem(DRAFT_PREFIX + id) ?? '' } catch { return '' }
    },
    write(id: string, sql: string) {
      if (!id) return
      memory.set(id, sql)
      try { storage?.setItem(DRAFT_PREFIX + id, sql) } catch { /* In-memory drafts remain available if storage is disabled. */ }
    }
  }
}

export interface StatementParameterSlot {
  readonly statementIndex: number
  readonly startLine: number
  readonly name: string
  readonly key: string
}

export interface ScopedSqlParameter {
  readonly statementIndex: number
  readonly name: string
  readonly value: SqlParameterValue
}

/**
 * UI 的绑定槽必须带语句下标。SQLite/MySQL 的匿名 `?` 在每条语句里都从 `?1`
 * 重新编号；只按 placeholder 名收集会让第二条语句静默复用第一条的值。
 */
export function statementParameterSlots(
  script: string,
  rules: SqlScriptRules,
  dialect: SqlParameterDialect
): StatementParameterSlot[] {
  const slots: StatementParameterSlot[] = []
  for (const statement of splitStatements(script, rules)) {
    const seen = new Set<string>()
    for (const placeholder of extractSqlParameters(statement.sql, dialect)) {
      if (seen.has(placeholder.name)) continue
      seen.add(placeholder.name)
      slots.push({
        statementIndex: statement.index,
        startLine: statement.startLine,
        name: placeholder.name,
        key: `${statement.index}:${placeholder.name}`
      })
    }
  }
  return slots
}

export function scopedParametersForStatement(
  parameters: readonly ScopedSqlParameter[],
  statementIndex: number
): SqlParameter[] {
  return parameters
    .filter((parameter) => parameter.statementIndex === statementIndex)
    .map(({ name, value }) => ({ name, value }))
}

export function validateScopedSqlParameters(
  parameters: readonly ScopedSqlParameter[],
  statementCount: number
): void {
  const seen = new Set<string>()
  for (const parameter of parameters) {
    if (!Number.isInteger(parameter.statementIndex) || parameter.statementIndex < 0 || parameter.statementIndex >= statementCount) {
      throw new Error('参数缺少有效的语句范围，请重新填写 SQL 参数')
    }
    const key = `${parameter.statementIndex}:${parameter.name}`
    if (seen.has(key)) throw new Error(`第 ${parameter.statementIndex + 1} 条语句的参数 ${parameter.name} 重复`)
    seen.add(key)
  }
}

const DECIMAL_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const INTEGER_LITERAL = /^[+-]?\d+$/

/**
 * 数值单元格只在 JavaScript 能精确表示时转成 number。安全范围外的十进制整数
 * 原样保留为文本，交给驱动按 decimal string 绑定，不能先 Number 再转回文本。
 */
export function parseNumericCell(raw: string): { kind: 'number'; value: number } | { kind: 'text'; text: string } {
  const text = raw.trim()
  if (!text || !DECIMAL_LITERAL.test(text)) throw new Error('请输入有效数字，NULL 请使用独立选项')
  const value = Number(text)
  if (!Number.isFinite(value)) throw new Error('请输入有效数字，NULL 请使用独立选项')
  if (INTEGER_LITERAL.test(text) && !Number.isSafeInteger(value)) return { kind: 'text', text }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error('该数值超出安全整数范围，无法无损转换；请只输入整数部分或改用文本列保存精确值')
  }
  return { kind: 'number', value }
}

export function exactNumberLiteral(value: number): string {
  if (!Number.isFinite(value)) throw new Error('非有限数不能导出')
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error('数值已超出安全整数范围，不能从已舍入的 number 生成 SQL 字面量；请保留精确文本')
  }
  return String(value)
}

export function parseParameterValue(raw: string, kind: string): SqlParameterValue {
  if (kind === 'null') return null
  if (kind === 'binary') {
    const hex = raw.replace(/\s/g, '')
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error('二进制参数需要偶数位十六进制字节')
    return Uint8Array.from(hex.match(/../g) ?? [], (part) => parseInt(part, 16))
  }
  if (kind === 'number') {
    const text = raw.trim()
    const value = Number(text)
    if (!text || !Number.isFinite(value)) throw new Error('参数需要有效数字')
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error('参数超出安全整数范围；不能先转换为 number。请改选「文本」类型并输入精确十进制值')
    }
    return value
  }
  if (kind === 'boolean') {
    if (!['true', 'false', '1', '0'].includes(raw)) throw new Error('布尔参数需要 true/false 或 1/0')
    return raw === 'true' || raw === '1'
  }
  return raw
}
export function parameterLiteral(value: SqlParameterValue, dialect: SqlParameterDialect): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return exactNumberLiteral(value)
  if (typeof value === 'boolean') return dialect === 'postgresql' ? (value ? 'TRUE' : 'FALSE') : (value ? '1' : '0')
  if (typeof value === 'string') {
    if (value.includes('\0')) throw new Error('文本含 NUL，无法安全生成 SQL 字面量')
    if (dialect === 'sqlite') return `'${value.replace(/'/g, "''")}'`
    const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "''")
    return dialect === 'postgresql' ? `E'${escaped}'` : `'${escaped}'`
  }
  const hex = [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return dialect === 'postgresql' ? `decode('${hex}','hex')` : `X'${hex}'`
}
/** Only exports a validated, fully bound query; placeholders inside strings/comments remain untouched. */
export function materializeQuery(sql: string, parameters: readonly SqlParameter[], dialect: SqlParameterDialect): string {
  bindSqlParameters(sql, parameters, dialect)
  const inspection = inspectSqlParameters(sql, dialect)
  if (!inspection.safe) throw new Error(inspection.reason ?? '无法安全识别绑定参数')
  const normalize = (name: string) => name.startsWith(':') ? name.slice(1) : name
  const values = new Map(parameters.map((parameter) => [normalize(parameter.name), parameter.value]))
  let result = sql
  for (const placeholder of [...inspection.placeholders].reverse()) {
    const value = values.get(normalize(placeholder.name))
    if (value === undefined) throw new Error(`缺少参数 ${placeholder.name}`)
    result = result.slice(0, placeholder.start) + parameterLiteral(value, dialect) + result.slice(placeholder.end)
  }
  return result
}
