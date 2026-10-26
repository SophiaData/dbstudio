/**
 * 方言级 SQL 脚本切分与源码位置。
 *
 * 这层只处理脚本语法边界，不执行 SQL，也不依赖 DOM 或 IPC。执行器拿到
 * `SqlScriptStatement` 后可以直接使用 parser 产出的行号，避免再次通过片段
 * 搜索猜测错误位置。
 */

export interface SqlScriptStatement {
  readonly index: number
  readonly sql: string
  readonly startOffset: number
  readonly endOffset: number
  readonly startLine: number
  readonly endLine: number
}

export interface SqlScriptRules {
  readonly lineCommentPrefixes: readonly string[]
  readonly blockComment: { readonly start: string; readonly end: string }
  readonly supportsDollarQuotedStrings: boolean
  readonly supportsBeginEndBlocks: boolean
  readonly statementTerminators: readonly string[]
}

export const SQLITE_SCRIPT_RULES: SqlScriptRules = {
  lineCommentPrefixes: ['--'],
  blockComment: { start: '/*', end: '*/' },
  supportsDollarQuotedStrings: false,
  supportsBeginEndBlocks: true,
  statementTerminators: [';']
}

export const POSTGRESQL_SCRIPT_RULES: SqlScriptRules = {
  lineCommentPrefixes: ['--'],
  blockComment: { start: '/*', end: '*/' },
  supportsDollarQuotedStrings: true,
  supportsBeginEndBlocks: false,
  statementTerminators: [';']
}

export class SqlScriptParseError extends Error {
  readonly offset: number
  readonly line: number

  constructor(message: string, offset: number, line: number) {
    super(`${message}（第 ${line} 行）`)
    this.name = 'SqlScriptParseError'
    this.offset = offset
    this.line = line
  }
}

type ScanState = 'normal' | 'string' | 'quotedIdentifier' | 'lineComment' | 'blockComment' | 'dollarQuote'

export function splitStatements(
  sql: string,
  rules: SqlScriptRules = SQLITE_SCRIPT_RULES
): SqlScriptStatement[] {
  if (typeof sql !== 'string') {
    throw new TypeError('SQL 脚本必须是字符串')
  }
  if (rules.statementTerminators.length === 0) {
    throw new Error('SQL 脚本至少需要一个语句终止符')
  }

  const terminators = [...rules.statementTerminators].sort((a, b) => b.length - a.length)
  const linePrefixes = [...rules.lineCommentPrefixes].sort((a, b) => b.length - a.length)
  const statements: SqlScriptStatement[] = []
  let state: ScanState = 'normal'
  let quote = ''
  let dollarTag = ''
  let segmentStart = 0
  let segmentHasCode = false
  let blockDepth = 0
  let createTrigger = false
  let sawCreate = false
  let i = 0

  const pushSegment = (end: number): void => {
    if (!segmentHasCode) return
    const raw = sql.slice(segmentStart, end)
    const trimmed = raw.trim()
    if (trimmed.length === 0) return
    const leading = raw.search(/\S/)
    const startOffset = segmentStart + Math.max(leading, 0)
    const endOffset = startOffset + trimmed.length
    statements.push({
      index: statements.length,
      sql: trimmed,
      startOffset,
      endOffset,
      startLine: lineAt(sql, startOffset),
      endLine: lineAt(sql, Math.max(startOffset, endOffset - 1))
    })
  }

  const resetSegment = (nextStart: number): void => {
    segmentStart = nextStart
    segmentHasCode = false
    blockDepth = 0
    createTrigger = false
    sawCreate = false
  }

  while (i < sql.length) {
    const ch = sql[i] as string
    const next = i + 1 < sql.length ? (sql[i + 1] as string) : ''

    if (state === 'lineComment') {
      if (ch === '\n' || ch === '\r') state = 'normal'
      i += 1
      continue
    }

    if (state === 'blockComment') {
      if (sql.startsWith(rules.blockComment.end, i)) {
        state = 'normal'
        i += rules.blockComment.end.length
      } else {
        i += 1
      }
      continue
    }

    if (state === 'string' || state === 'quotedIdentifier') {
      segmentHasCode = true
      if (ch === quote) {
        if (next === quote) {
          i += 2
        } else {
          state = 'normal'
          quote = ''
          i += 1
        }
      } else {
        i += 1
      }
      continue
    }

    if (state === 'dollarQuote') {
      if (sql.startsWith(dollarTag, i)) {
        state = 'normal'
        i += dollarTag.length
      } else {
        i += 1
      }
      continue
    }

    const linePrefix = linePrefixes.find((prefix) => sql.startsWith(prefix, i))
    if (linePrefix !== undefined) {
      state = 'lineComment'
      i += linePrefix.length
      continue
    }
    if (sql.startsWith(rules.blockComment.start, i)) {
      state = 'blockComment'
      i += rules.blockComment.start.length
      continue
    }

    if (ch === "'" || ch === '"') {
      state = ch === "'" ? 'string' : 'quotedIdentifier'
      quote = ch
      segmentHasCode = true
      i += 1
      continue
    }

    if (rules.supportsDollarQuotedStrings && ch === '$') {
      const tag = readDollarTag(sql, i)
      if (tag !== null) {
        state = 'dollarQuote'
        dollarTag = tag
        segmentHasCode = true
        i += tag.length
        continue
      }
    }

    if (isWordStart(ch)) {
      const wordStart = i
      i += 1
      while (i < sql.length && isWordPart(sql[i] as string)) i += 1
      const word = sql.slice(wordStart, i).toLowerCase()
      segmentHasCode = true

      if (rules.supportsBeginEndBlocks) {
        if (word === 'create') sawCreate = true
        else if (word === 'trigger' && sawCreate) createTrigger = true
        else if (createTrigger && word === 'begin') blockDepth += 1
        else if (createTrigger && word === 'end' && blockDepth > 0) blockDepth -= 1
      }
      continue
    }

    const terminator = terminators.find((candidate) => sql.startsWith(candidate, i))
    if (terminator !== undefined && blockDepth === 0) {
      pushSegment(i)
      resetSegment(i + terminator.length)
      i += terminator.length
      continue
    }

    if (!/\s/.test(ch)) segmentHasCode = true
    i += 1
  }

  if (state === 'string' || state === 'quotedIdentifier') {
    throw new SqlScriptParseError('SQL 脚本中存在未闭合的字符串或引用标识符', i, lineAt(sql, i))
  }
  if (state === 'blockComment') {
    throw new SqlScriptParseError('SQL 脚本中存在未闭合的块注释', i, lineAt(sql, i))
  }
  if (state === 'dollarQuote') {
    throw new SqlScriptParseError(`SQL 脚本中存在未闭合的 dollar quote ${dollarTag}`, i, lineAt(sql, i))
  }

  pushSegment(sql.length)
  return statements
}

function lineAt(sql: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < sql.length; i += 1) {
    if (sql[i] === '\n') line += 1
  }
  return line
}

function isWordStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch)
}

function isWordPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch)
}

function readDollarTag(sql: string, offset: number): string | null {
  if (sql[offset] !== '$') return null
  if (sql[offset + 1] === '$') return '$$'
  let i = offset + 1
  if (!/[A-Za-z_]/.test(sql[i] ?? '')) return null
  i += 1
  while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i] as string)) i += 1
  if (sql[i] !== '$') return null
  return sql.slice(offset, i + 1)
}
