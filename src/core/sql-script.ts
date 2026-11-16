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
  /** SQLite: `[name]` 是标识符，内部的分号不是语句边界。 */
  readonly supportsBracketIdentifiers?: boolean
  /** SQLite / MySQL: `` `name` `` 是标识符，内部的分号不是语句边界。 */
  readonly supportsBacktickIdentifiers?: boolean
  /** PostgreSQL: E 前缀字符串内的反斜杠转义单引号，转义后的引号不结束字符串。 */
  readonly supportsEscapeStrings?: boolean
  /** PostgreSQL: 块注释可嵌套, 结束标记只关闭最内层. */
  readonly supportsNestedBlockComments?: boolean
}

export const SQLITE_SCRIPT_RULES: SqlScriptRules = {
  lineCommentPrefixes: ['--'],
  blockComment: { start: '/*', end: '*/' },
  supportsDollarQuotedStrings: false,
  supportsBeginEndBlocks: true,
  statementTerminators: [';'],
  supportsBracketIdentifiers: true,
  supportsBacktickIdentifiers: true
}

export const POSTGRESQL_SCRIPT_RULES: SqlScriptRules = {
  lineCommentPrefixes: ['--'],
  blockComment: { start: '/*', end: '*/' },
  supportsDollarQuotedStrings: true,
  supportsBeginEndBlocks: false,
  statementTerminators: [';'],
  supportsEscapeStrings: true,
  supportsNestedBlockComments: true
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
  let commentDepth = 0
  let createTrigger = false
  let sawCreate = false
  // PostgreSQL E 前缀字符串：反斜杠转义下一个字符，转义后的引号不结束字符串。
  let escapeString = false
  // Offset where the currently open string, identifier, comment or dollar quote began.
  let unclosedStart = 0
  // Bracket identifiers close at the first closing bracket; no doubling escape.
  // 该状态必须属于单次调用：放在模块作用域会让上一次解析的残留值
  // 把下一次的反引号双写转义误判成结束引号。
  let bracketIdentifier = false
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
    commentDepth = 0
    escapeString = false
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
      if (rules.supportsNestedBlockComments && sql.startsWith(rules.blockComment.start, i)) {
        commentDepth += 1
        i += rules.blockComment.start.length
      } else if (sql.startsWith(rules.blockComment.end, i)) {
        commentDepth -= 1
        if (commentDepth <= 0) {
          state = 'normal'
          commentDepth = 0
        }
        i += rules.blockComment.end.length
      } else {
        i += 1
      }
      continue
    }

    if (state === 'string' || state === 'quotedIdentifier') {
      segmentHasCode = true
      if (escapeString && ch === '\\') {
        i += 2
      } else if (ch === quote) {
        // Backticks and double quotes escape by doubling; brackets do not.
        if (!bracketIdentifier && next === quote) {
          i += 2
        } else {
          state = 'normal'
          quote = ''
          escapeString = false
          bracketIdentifier = false
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
      unclosedStart = i
      state = 'lineComment'
      i += linePrefix.length
      continue
    }
    if (sql.startsWith(rules.blockComment.start, i)) {
      unclosedStart = i
      state = 'blockComment'
      commentDepth = 1
      i += rules.blockComment.start.length
      continue
    }

    // PostgreSQL E-prefixed string: backslash escapes the next char; plain identifier E is unaffected.
    if (
      rules.supportsEscapeStrings === true &&
      (ch === 'e' || ch === 'E') &&
      next === "'" &&
      (i === 0 || !isWordPart(sql[i - 1] as string))
    ) {
      state = 'string'
      quote = "'"
      escapeString = true
      unclosedStart = i
      segmentHasCode = true
      i += 2
      continue
    }

    if (ch === "'" || ch === '"') {
      state = ch === "'" ? 'string' : 'quotedIdentifier'
      quote = ch
      unclosedStart = i
      escapeString = false
      bracketIdentifier = false
      segmentHasCode = true
      i += 1
      continue
    }

    // SQLite backtick and bracket identifiers: inner semicolons are not boundaries.
    if (ch.charCodeAt(0) === 96 && rules.supportsBacktickIdentifiers === true) {
      state = 'quotedIdentifier'
      quote = String.fromCharCode(96)
      unclosedStart = i
      escapeString = false
      segmentHasCode = true
      i += 1
      continue
    }
    if (ch === '[' && rules.supportsBracketIdentifiers === true) {
      state = 'quotedIdentifier'
      quote = ']'
      bracketIdentifier = true
      unclosedStart = i
      escapeString = false
      segmentHasCode = true
      i += 1
      continue
    }

    if (rules.supportsDollarQuotedStrings && ch === '$') {
      const tag = readDollarTag(sql, i)
      if (tag !== null) {
        unclosedStart = i
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
        // CASE opens its own END; counting it as a block end would close the
        // trigger body early and split on the next inner semicolon.
        else if (createTrigger && word === 'case') blockDepth += 1
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
    const offset = Math.min(unclosedStart, sql.length)
    throw new SqlScriptParseError('SQL 脚本中存在未闭合的字符串或引用标识符', offset, lineAt(sql, offset))
  }
  if (state === 'blockComment') {
    const offset = Math.min(unclosedStart, sql.length)
    throw new SqlScriptParseError('SQL 脚本中存在未闭合的块注释', offset, lineAt(sql, offset))
  }
  if (state === 'dollarQuote') {
    const offset = Math.min(unclosedStart, sql.length)
    throw new SqlScriptParseError(`SQL 脚本中存在未闭合的 dollar quote ${dollarTag}`, offset, lineAt(sql, offset))
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
