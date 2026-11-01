/**
 * SQLite 结构元数据读取。
 *
 * 这里刻意不引入新的 RPC：主进程会把 `readSqliteTableMetadata()` 的返回值合并进
 * 现有 `describeTable` 结果。列仍由现有列读取路径负责，其他结构对象按需调用本文件的
 * 独立函数，避免在 P3.1 契约尚未落地时提前固化一套临时协议。
 *
 * PRAGMA 的 table-valued 形式（`pragma_table_xinfo(?)` 等）支持参数绑定，因此表名和
 * 索引名不拼接进 SQL。只有 `sqlite_master` 的 DDL 文本需要在本模块内解析，解析器会
 * 跳过字符串、带引号标识符和注释，避免把 `DEFAULT 'CHECK (...)'` 误认成约束。
 */

import type { DatabaseSync } from 'node:sqlite'

import type {
  CheckConstraintDescription,
  ForeignKeyDescription,
  IndexDescription,
  TriggerDescription,
  UniqueConstraintDescription
} from '../../core/metadata'
import type { ColumnDescription } from '../../core/model'
import { SqliteAdapterError, describeThrown } from './errors'

/** 与后续 `core/metadata.ts` 的外键契约保持一致，额外保留 SQLite 的内部 id 便于排序。 */
export interface SqliteForeignKeyDescription {
  readonly id: number
  readonly name: string | null
  readonly columns: readonly string[]
  readonly referencedSchema: string | null
  readonly referencedTable: string
  readonly referencedColumns: readonly string[]
  readonly onUpdate: string | null
  readonly onDelete: string | null
  readonly match: string | null
}

/** 与后续 `IndexDescription` 兼容；origin/partial/sql 用于 SQLite 专属诊断与 UI 展开。 */
export interface SqliteIndexDescription {
  readonly name: string
  readonly unique: boolean
  readonly columns: readonly string[]
  readonly predicate: string | null
  readonly origin: string
  readonly partial: boolean
  readonly sql: string | null
}

export type SqliteGeneratedColumnKind = 'virtual' | 'stored' | null

/**
 * `ColumnDescription` 的兼容扩展。
 *
 * 现有 adapter 可以把返回值直接当 `ColumnDescription[]` 使用；
 * 需要展示生成列或隐藏列时再读 generated/hidden 两个附加字段。
 */
export interface SqliteColumnMetadata extends ColumnDescription {
  readonly generated: SqliteGeneratedColumnKind
  readonly hidden: boolean
}

export interface SqliteTriggerDescription {
  readonly name: string
  readonly tableName: string
  readonly sql: string
  readonly timing: 'before' | 'after' | 'instead-of' | null
  readonly event: 'insert' | 'update' | 'delete' | null
  readonly updateOf: readonly string[]
  readonly when: string | null
  /**
   * 触发体（`BEGIN ... END` 之间的语句）。
   *
   * 为什么要单独抠出来：`CREATE TRIGGER` 原文里混着时机、事件、UPDATE OF 列、
   * WHEN 条件，真正会被执行的只有中间那几句。ER 图与 DDL 预览要的是**触发体**，
   * 而不是整条 CREATE 语句。
   */
  readonly body: string
}

/** 可由 `describeTable` 直接展开的 SQLite 结构扩展片段。 */
export interface SqliteTableMetadataPatch {
  readonly foreignKeys: readonly SqliteForeignKeyDescription[]
  readonly indexes: readonly SqliteIndexDescription[]
  readonly checks: readonly string[]
  readonly triggers: readonly SqliteTriggerDescription[]
  /**
   * 来自 `origin = 'u' | 'pk'` 的索引，即表约束产生的唯一键。
   * 用户显式创建的 `CREATE UNIQUE INDEX` 仍在 indexes 中标记 unique。
   */
  readonly uniqueConstraints: readonly (readonly string[])[]
}

type SqliteScalar = string | number | bigint | null | Uint8Array

interface RawGrid {
  readonly names: readonly string[]
  readonly rows: readonly (readonly unknown[])[]
}

interface SqliteObjectRow {
  readonly name: string
  readonly type: string
  readonly sql: string | null
}

interface ForeignKeyRow {
  readonly id: number
  readonly seq: number
  readonly referencedTable: string
  readonly fromColumn: string
  readonly toColumn: string | null
  readonly onUpdate: string | null
  readonly onDelete: string | null
  readonly match: string | null
}

interface WordToken {
  readonly word: string
  readonly start: number
  readonly end: number
}

export interface SqliteTriggerDefinitionParts {
  readonly timing: 'before' | 'after' | 'instead-of' | null
  readonly event: 'insert' | 'update' | 'delete' | null
  readonly updateOf: readonly string[]
  readonly when: string | null
}

/** SQLite 单词字符。只用于识别未加引号的关键字，不参与标识符解析。 */
function isWordStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
}

function isWordChar(ch: string): boolean {
  return isWordStart(ch) || (ch >= '0' && ch <= '9') || ch === '$'
}

/** 跳过 SQL 中的字符串或带引号标识符，并正确处理双写转义。 */
function skipQuoted(sql: string, start: number): number {
  const quote = sql.charAt(start)
  let index = start + 1

  if (quote === '[') {
    const close = sql.indexOf(']', index)
    return close === -1 ? sql.length : close + 1
  }

  while (index < sql.length) {
    if (sql.charAt(index) === quote) {
      if (sql.charAt(index + 1) === quote) {
        index += 2
        continue
      }
      return index + 1
    }
    index += 1
  }
  return sql.length
}

/** 跳过空白与 SQL 注释。 */
function skipTrivia(sql: string, start: number): number {
  let index = start
  while (index < sql.length) {
    const ch = sql.charAt(index)
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      index += 1
      continue
    }
    if (ch === '-' && sql.charAt(index + 1) === '-') {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (ch === '/' && sql.charAt(index + 1) === '*') {
      const close = sql.indexOf('*/', index + 2)
      index = close === -1 ? sql.length : close + 2
      continue
    }
    break
  }
  return index
}

function readWord(sql: string, start: number): { readonly word: string; readonly end: number } | null {
  if (!isWordStart(sql.charAt(start))) return null
  let end = start + 1
  while (end < sql.length && isWordChar(sql.charAt(end))) end += 1
  return { word: sql.slice(start, end).toLowerCase(), end }
}

/** 找到与 openIndex 指向的左括号配对的右括号。 */
function findMatchingParen(sql: string, openIndex: number): number | null {
  let depth = 0
  let index = openIndex
  while (index < sql.length) {
    const ch = sql.charAt(index)
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      index = skipQuoted(sql, index)
      continue
    }
    if (ch === '-' && sql.charAt(index + 1) === '-') {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (ch === '/' && sql.charAt(index + 1) === '*') {
      const close = sql.indexOf('*/', index + 2)
      index = close === -1 ? sql.length : close + 2
      continue
    }
    if (ch === '(') {
      depth += 1
      index += 1
      continue
    }
    if (ch === ')') {
      depth -= 1
      if (depth === 0) return index
      index += 1
      continue
    }
    index += 1
  }
  return null
}

/** 找到括号外第一个指定关键字（大小写不敏感）。 */
function findTopLevelKeyword(sql: string, keyword: string, from = 0): { readonly start: number; readonly end: number } | null {
  let depth = 0
  let index = from
  while (index < sql.length) {
    const ch = sql.charAt(index)
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      index = skipQuoted(sql, index)
      continue
    }
    if (ch === '-' && sql.charAt(index + 1) === '-') {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (ch === '/' && sql.charAt(index + 1) === '*') {
      const close = sql.indexOf('*/', index + 2)
      index = close === -1 ? sql.length : close + 2
      continue
    }
    if (ch === '(') {
      depth += 1
      index += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    const word = isWordStart(ch) ? readWord(sql, index) : null
    if (word !== null) {
      if (depth === 0 && word.word === keyword) return { start: index, end: word.end }
      index = word.end
      continue
    }
    index += 1
  }
  return null
}

/** 按顶层逗号切分表达式列表；逗号出现在括号、字符串或标识符内时不会切。 */
function splitTopLevelList(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let index = 0

  while (index < text.length) {
    const ch = text.charAt(index)
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      index = skipQuoted(text, index)
      continue
    }
    if (ch === '-' && text.charAt(index + 1) === '-') {
      const newline = text.indexOf('\n', index + 2)
      index = newline === -1 ? text.length : newline + 1
      continue
    }
    if (ch === '/' && text.charAt(index + 1) === '*') {
      const close = text.indexOf('*/', index + 2)
      index = close === -1 ? text.length : close + 2
      continue
    }
    if (ch === '(') {
      depth += 1
      index += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (ch === ',' && depth === 0) {
      const part = text.slice(start, index).trim()
      if (part !== '') parts.push(part)
      start = index + 1
    }
    index += 1
  }

  const tail = text.slice(start).trim()
  if (tail !== '') parts.push(tail)
  return parts
}

/** 将单纯由引号包住的列名还原为实际标识符；表达式原样保留。 */
function normalizeIdentifierTerm(term: string): string {
  const trimmed = term.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed.charAt(0)
  const last = trimmed.charAt(trimmed.length - 1)
  if ((first === '"' && last === '"') || (first === '`' && last === '`')) {
    return trimmed.slice(1, -1).replaceAll(first + first, first)
  }
  if (first === '[' && last === ']') return trimmed.slice(1, -1)
  return trimmed
}

/** 解析 CREATE TABLE 中所有 CHECK (...) 的表达式，不包含外层 CHECK 和括号。 */
export function parseSqliteCheckExpressions(sql: string): string[] {
  const checks: string[] = []
  let index = 0

  while (index < sql.length) {
    const ch = sql.charAt(index)
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      index = skipQuoted(sql, index)
      continue
    }
    if (ch === '-' && sql.charAt(index + 1) === '-') {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (ch === '/' && sql.charAt(index + 1) === '*') {
      const close = sql.indexOf('*/', index + 2)
      index = close === -1 ? sql.length : close + 2
      continue
    }

    const word = isWordStart(ch) ? readWord(sql, index) : null
    if (word === null) {
      index += 1
      continue
    }
    if (word.word !== 'check') {
      index = word.end
      continue
    }

    const open = skipTrivia(sql, word.end)
    if (sql.charAt(open) !== '(') {
      index = word.end
      continue
    }
    const close = findMatchingParen(sql, open)
    if (close === null) break
    const expression = sql.slice(open + 1, close).trim()
    if (expression !== '') checks.push(expression)
    index = close + 1
  }

  return checks
}

/** 从 CREATE INDEX 的顶层 WHERE 子句提取 partial index predicate。 */
export function parseSqlitePartialIndexPredicate(sql: string): string | null {
  const where = findTopLevelKeyword(sql, 'where')
  if (where === null) return null

  let depth = 0
  let index = where.end
  while (index < sql.length) {
    const ch = sql.charAt(index)
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      index = skipQuoted(sql, index)
      continue
    }
    if (ch === '-' && sql.charAt(index + 1) === '-') {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (ch === '/' && sql.charAt(index + 1) === '*') {
      const close = sql.indexOf('*/', index + 2)
      index = close === -1 ? sql.length : close + 2
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) break
    index += 1
  }

  const predicate = sql.slice(where.end, index).trim()
  return predicate === '' ? null : predicate
}

/** 读取 CREATE INDEX 括号中的列/表达式；用于补齐表达式索引中 index_info 的空名称。 */
function parseIndexTerms(sql: string): string[] {
  const on = findTopLevelKeyword(sql, 'on')
  if (on === null) return []

  let index = on.end
  while (index < sql.length) {
    const ch = sql.charAt(index)
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      index = skipQuoted(sql, index)
      continue
    }
    if (ch === '-' && sql.charAt(index + 1) === '-') {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (ch === '/' && sql.charAt(index + 1) === '*') {
      const close = sql.indexOf('*/', index + 2)
      index = close === -1 ? sql.length : close + 2
      continue
    }
    if (ch === '(') {
      const close = findMatchingParen(sql, index)
      return close === null ? [] : splitTopLevelList(sql.slice(index + 1, close)).map(normalizeIdentifierTerm)
    }
    index += 1
  }
  return []
}

function scanTopLevelWordsUntilBegin(sql: string): { readonly words: readonly WordToken[]; readonly begin: number } | null {
  const words: WordToken[] = []
  let depth = 0
  let index = 0

  while (index < sql.length) {
    const ch = sql.charAt(index)
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      index = skipQuoted(sql, index)
      continue
    }
    if (ch === '-' && sql.charAt(index + 1) === '-') {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (ch === '/' && sql.charAt(index + 1) === '*') {
      const close = sql.indexOf('*/', index + 2)
      index = close === -1 ? sql.length : close + 2
      continue
    }
    if (ch === '(') {
      depth += 1
      index += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    const word = isWordStart(ch) ? readWord(sql, index) : null
    if (word === null) {
      index += 1
      continue
    }
    if (depth === 0 && word.word === 'begin') return { words, begin: index }
    if (depth === 0) words.push({ word: word.word, start: index, end: word.end })
    index = word.end
  }
  return null
}

/** 解析触发器的 timing/event/UPDATE OF/WHEN；完整 SQL 仍由调用方原样保留。 */
export function parseSqliteTriggerDefinition(sql: string): SqliteTriggerDefinitionParts {
  const scanned = scanTopLevelWordsUntilBegin(sql)
  if (scanned === null) return { timing: null, event: null, updateOf: [], when: null }

  const triggerIndex = scanned.words.findIndex((word) => word.word === 'trigger')
  if (triggerIndex === -1) return { timing: null, event: null, updateOf: [], when: null }

  let eventIndex = -1
  for (let index = triggerIndex + 1; index < scanned.words.length; index += 1) {
    const word = scanned.words[index]
    if (word === undefined) continue
    if (word.word === 'insert' || word.word === 'update' || word.word === 'delete') {
      eventIndex = index
      break
    }
  }
  if (eventIndex === -1) return { timing: null, event: null, updateOf: [], when: null }

  const eventWord = scanned.words[eventIndex]
  const event = eventWord?.word as 'insert' | 'update' | 'delete' | undefined
  if (event === undefined) return { timing: null, event: null, updateOf: [], when: null }

  let timing: SqliteTriggerDefinitionParts['timing'] = null
  for (let index = triggerIndex + 1; index < eventIndex; index += 1) {
    const word = scanned.words[index]
    if (word?.word === 'before') {
      timing = 'before'
      break
    }
    if (word?.word === 'after') {
      timing = 'after'
      break
    }
    if (word?.word === 'instead' && scanned.words[index + 1]?.word === 'of') {
      timing = 'instead-of'
      break
    }
  }

  let updateOf: readonly string[] = []
  if (event === 'update') {
    const of = scanned.words[eventIndex + 1]
    if (of?.word === 'of') {
      let onIndex = -1
      for (let index = eventIndex + 2; index < scanned.words.length; index += 1) {
        if (scanned.words[index]?.word === 'on') {
          onIndex = index
          break
        }
      }
      if (onIndex !== -1) {
        const on = scanned.words[onIndex]
        if (on !== undefined) {
          updateOf = splitTopLevelList(sql.slice(of.end, on.start).trim()).map(normalizeIdentifierTerm)
        }
      }
    }
  }

  let when: string | null = null
  const onIndex = scanned.words.findIndex((word, index) => index > eventIndex && word.word === 'on')
  const whenStart = onIndex === -1 ? eventIndex + 1 : onIndex + 1
  for (let index = whenStart; index < scanned.words.length; index += 1) {
    if (scanned.words[index]?.word !== 'when') continue
    const whenWord = scanned.words[index]
    if (whenWord === undefined) break
    const expression = sql.slice(whenWord.end, scanned.begin).trim()
    when = expression === '' ? null : expression
    break
  }

  return { timing, event, updateOf, when }
}

/**
 * 抠出触发体（`BEGIN ... END` 之间）。
 *
 * 结束标记必须是**顶层**的 END：触发体内部可能有嵌套的 BEGIN…END 块
 * （比如触发器里再写一个 CASE WHEN … THEN BEGIN … END），
 * 只找第一个 END 会把触发体截断成半句 SQL。
 */
export function parseSqliteTriggerBody(sql: string): string {
  const scanned = scanTopLevelWordsUntilBegin(sql)
  if (scanned === null) return ''

  const endIndex = findTopLevelEnd(sql, scanned.begin)
  if (endIndex === -1) return ''
  return sql.slice(scanned.begin + 'begin'.length, endIndex).trim()
}

/** 从 `start` 起找第一个顶层 END；找不到返回 -1。 */
function findTopLevelEnd(sql: string, start: number): number {
  let depth = 0
  let index = start

  while (index < sql.length) {
    const ch = sql.charAt(index)
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      index = skipQuoted(sql, index)
      continue
    }
    if (ch === '-' && sql.charAt(index + 1) === '-') {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (ch === '/' && sql.charAt(index + 1) === '*') {
      const close = sql.indexOf('*/', index + 2)
      index = close === -1 ? sql.length : close + 2
      continue
    }
    if (ch === '(') {
      depth += 1
      index += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (isWordStart(ch)) {
      const word = readWord(sql, index)
      if (depth === 0 && word !== null && word.word === 'end') return index
      index = word === null ? index + 1 : word.end
      continue
    }
    index += 1
  }
  return -1
}

/** 读取行并按列名取值，同时兼容 `returnArrays: true/false` 两种连接模式。 */
function queryRows(db: DatabaseSync, context: string, sql: string, params: readonly SqliteScalar[] = []): RawGrid {
  try {
    const statement = db.prepare(sql)
    const names = statement.columns().map((column) => column.name)
    const rawRows = statement.all(...params) as readonly unknown[]
    const rows = rawRows.map((raw) => {
      if (Array.isArray(raw)) return raw as readonly unknown[]
      const record = raw as Record<string, unknown>
      return names.map((name) => record[name])
    })
    return { names, rows }
  } catch (thrown) {
    if (thrown instanceof SqliteAdapterError) throw thrown
    throw new SqliteAdapterError(
      'query_failed',
      `读取 SQLite ${context}失败（原始错误：${describeThrown(thrown)}）`,
      thrown
    )
  }
}

function cell(grid: RawGrid, row: readonly unknown[], name: string): unknown {
  const index = grid.names.indexOf(name)
  return index === -1 ? undefined : row[index]
}

function readText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

function readFlag(value: unknown): boolean {
  const number = readNumber(value)
  return number !== null && number !== 0
}

function readSqliteObject(db: DatabaseSync, tableName: string): SqliteObjectRow {
  const grid = queryRows(
    db,
    `对象 ${tableName}`,
    `SELECT name, type, sql
       FROM sqlite_master
      WHERE name = ? COLLATE NOCASE
        AND type IN ('table', 'view')
      ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name
      LIMIT 1`,
    [tableName]
  )
  const row = grid.rows[0]
  if (row === undefined) {
    throw new SqliteAdapterError('object_not_found', `对象不存在（可能已被删除，请刷新）：${tableName}`)
  }

  const name = readText(cell(grid, row, 'name'))
  const type = readText(cell(grid, row, 'type'))
  if (name === null || type === null) {
    throw new SqliteAdapterError('query_failed', `读取 SQLite 对象失败：sqlite_master 返回了不完整的行（${tableName}）`)
  }
  return { name, type, sql: readText(cell(grid, row, 'sql')) }
}

/** 读取 `CREATE TABLE`/`CREATE VIEW` 原文；这是 SQLite 唯一能拿到 CHECK 的可靠来源。 */
export function readSqliteTableSql(db: DatabaseSync, tableName: string): string | null {
  return readSqliteObject(db, tableName).sql
}

/**
 * 判断「rowid 别名」所需的表级事实。
 *
 * ===== 为什么不能只看 primaryKeyOrdinal / typeName 推断 =====
 *
 * 常见误区是"单列 INTEGER 主键就是 rowid 别名"，但反例真实存在：
 *   - `WITHOUT ROWID` 表的 INTEGER 主键**不是** rowid 别名，插入时不可省略；
 *   - `INTEGER PRIMARY KEY DESC`（列级 DESC）出于历史兼容**也不是**别名；
 *   - 复合主键永远不是单列 rowid 别名。
 *
 * 这些都是 `PRAGMA table_xinfo` 单独看不出来的，必须结合真实元数据：
 *   - `PRAGMA table_list` 的 `wr` → 是否 WITHOUT ROWID；
 *   - `PRAGMA index_list` 是否存在 `origin='pk'` 的自动索引 →
 *     真 rowid 别名没有这种索引，而 `INTEGER PRIMARY KEY DESC`、复合主键、
 *     `WITHOUT ROWID` 主键都会生成它。
 *
 * 我们**不**解析 `CREATE TABLE` 原文来猜（脆弱且易被注释/字符串误导），
 * 只依赖 SQLite 自己给出的 PRAGMA 事实。查不到时返回 null，由调用方标"未知"。
 */
interface SqliteRowidAliasContext {
  readonly withoutRowid: boolean
  /** 主键列名，按主键序号排序；用来区分单列 / 复合主键。 */
  readonly primaryKeyColumns: readonly string[]
  /** 是否存在 `origin='pk'` 的自动索引（存在即说明不是 rowid 别名）。 */
  readonly hasPrimaryKeyIndex: boolean
}

function readSqliteRowidAliasContext(
  db: DatabaseSync,
  tableName: string
): SqliteRowidAliasContext | null {
  try {
    const tableGrid = queryRows(
      db,
      `表属性 ${tableName}`,
      `SELECT schema, name, type, ncol, wr, strict
         FROM pragma_table_list(?)
        ORDER BY CASE schema WHEN 'main' THEN 0 WHEN 'temp' THEN 1 ELSE 2 END
        LIMIT 1`,
      [tableName]
    )
    const tableRow = tableGrid.rows[0]
    if (tableRow === undefined) return null
    const objectType = (readText(cell(tableGrid, tableRow, 'type')) ?? '').toLowerCase()
    if (objectType !== 'table') {
      // 视图没有 rowid 概念；按"非 rowid 别名"参与后续判定即可。
      return { withoutRowid: false, primaryKeyColumns: [], hasPrimaryKeyIndex: false }
    }

    const indexGrid = queryRows(
      db,
      `索引 ${tableName}`,
      `SELECT name, "unique", origin, partial FROM pragma_index_list(?)`,
      [tableName]
    )
    const hasPrimaryKeyIndex = indexGrid.rows.some(
      (row) => (readText(cell(indexGrid, row, 'origin')) ?? '') === 'pk'
    )

    const pkGrid = queryRows(
      db,
      `主键 ${tableName}`,
      `SELECT name, pk FROM pragma_table_xinfo(?) WHERE pk > 0 ORDER BY pk`,
      [tableName]
    )
    const primaryKeyColumns = pkGrid.rows
      .map((row) => readText(cell(pkGrid, row, 'name')))
      .filter((name): name is string => name !== null)

    return {
      withoutRowid: readFlag(cell(tableGrid, tableRow, 'wr')),
      primaryKeyColumns,
      hasPrimaryKeyIndex
    }
  } catch {
    // 老版本 SQLite 没有 pragma_table_list，或 schema 读取异常：
    // 返回 null 让"无法确定 rowid 别名"的列落到 undefined，绝不瞎猜。
    return null
  }
}

/**
 * 判定某列是否 SQLite rowid 别名（省略即自动生成）。
 *
 * 返回值三态：`true` 是别名；`false` 确认不是；`undefined` 信息不足。
 */
function isSqliteRowidAlias(
  column: SqliteColumnMetadata,
  context: SqliteRowidAliasContext | null
): boolean | undefined {
  if (column.primaryKeyOrdinal === null) return false
  if (context === null) return undefined
  if (context.withoutRowid) return false
  if (context.primaryKeyColumns.length !== 1) return false
  // 必须是**精确**的 INTEGER：INT / BIGINT / UNSIGNED INTEGER 都不是别名。
  if (column.typeName.trim().toUpperCase() !== 'INTEGER') return false
  // 有 origin='pk' 自动索引 → SQLite 没把它当别名（如 INTEGER PRIMARY KEY DESC）。
  if (context.hasPrimaryKeyIndex) return false
  return true
}

/**
 * 计算 `ColumnDescription.requiredOnInsert`（SQLite 静态必填）。
 *
 * 判定顺序（只依赖已知列定义）：
 *   1. 生成列（hidden=2/3）→ false（不能也不需要显式插入）；
 *   2. 其它隐藏列（hidden=1，虚拟表内部列）→ undefined（不猜）；
 *   3. 可空 → false；
 *   4. 有默认值 → false（含 `DEFAULT NULL`，其写值/可省性交给运行期规则）；
 *   5. 非主键 → true（走到这里说明 NOT NULL、无默认值）；
 *   6. 主键列 → 看是否 rowid 别名：别名 false，非别名 true，信息不足 undefined。
 */
export function computeSqliteRequiredOnInsert(
  column: SqliteColumnMetadata,
  context: SqliteRowidAliasContext | null
): boolean | undefined {
  if (column.generated !== null) return false
  if (column.hidden) return undefined
  if (column.nullable) return false
  if (column.defaultValue !== null) return false
  if (column.primaryKeyOrdinal === null) return true
  const alias = isSqliteRowidAlias(column, context)
  if (alias === undefined) return undefined
  return alias ? false : true
}

/**
 * 读取 `PRAGMA table_xinfo`。
 *
 * `hidden=2/3` 分别是生成列 virtual/stored；返回值仍扩展自现有 `ColumnDescription`，
 * adapter 可以先用它替换 `table_info` 读取，再决定是否把额外字段暴露给 UI。
 *
 * 同时补上 `requiredOnInsert`：这是**列描述读取路径**里的最小增量，
 * 不改动 ER 结构对象（外键/索引等仍由 `readSqliteTableMetadata` 负责）。
 */
export function readSqliteColumnMetadata(db: DatabaseSync, tableName: string): SqliteColumnMetadata[] {
  const grid = queryRows(
    db,
    `表列 ${tableName}`,
    `SELECT *
       FROM pragma_table_xinfo(?)
      ORDER BY cid`,
    [tableName]
  )
  const rowidContext = readSqliteRowidAliasContext(db, tableName)

  const columns: SqliteColumnMetadata[] = []
  for (const row of grid.rows) {
    const name = readText(cell(grid, row, 'name'))
    if (name === null) continue
    const primaryKey = readNumber(cell(grid, row, 'pk')) ?? 0
    const hiddenCode = readNumber(cell(grid, row, 'hidden')) ?? 0
    const column: SqliteColumnMetadata = {
      name,
      typeName: readText(cell(grid, row, 'type')) ?? '',
      nullable: (readNumber(cell(grid, row, 'notnull')) ?? 0) === 0,
      primaryKeyOrdinal: primaryKey > 0 ? primaryKey : null,
      defaultValue: readText(cell(grid, row, 'dflt_value')),
      generated: hiddenCode === 2 ? 'virtual' : hiddenCode === 3 ? 'stored' : null,
      hidden: hiddenCode !== 0
    }
    columns.push({
      ...column,
      requiredOnInsert: computeSqliteRequiredOnInsert(column, rowidContext)
    })
  }
  return columns
}

function resolveReferencedColumns(
  db: DatabaseSync,
  rows: readonly ForeignKeyRow[],
  referencedTable: string
): readonly string[] {
  let primaryKey: readonly string[] = []
  if (rows.some((row) => row.toColumn === null)) {
    try {
      primaryKey = readSqliteColumnMetadata(db, referencedTable)
        .filter((column) => column.primaryKeyOrdinal !== null)
        .sort((left, right) => (left.primaryKeyOrdinal ?? 0) - (right.primaryKeyOrdinal ?? 0))
        .map((column) => column.name)
    } catch (thrown) {
      // schema 已损坏或父表被删时，仍应返回其余元数据；空串明确表示“列名无法解析”。
      if (!(thrown instanceof SqliteAdapterError) || thrown.code !== 'object_not_found') throw thrown
    }
  }

  return rows.map((row, index) => row.toColumn ?? primaryKey[index] ?? '')
}

/** 读取并归并复合外键。SQLite 不暴露约束名，因此 name 固定为 null。 */
export function readSqliteForeignKeys(db: DatabaseSync, tableName: string): SqliteForeignKeyDescription[] {
  const grid = queryRows(
    db,
    `外键 ${tableName}`,
    `SELECT *
       FROM pragma_foreign_key_list(?)
      ORDER BY id, seq`,
    [tableName]
  )
  const groups = new Map<number, ForeignKeyRow[]>()

  for (const rawRow of grid.rows) {
    const id = readNumber(cell(grid, rawRow, 'id'))
    const seq = readNumber(cell(grid, rawRow, 'seq'))
    const referencedTable = readText(cell(grid, rawRow, 'table'))
    const fromColumn = readText(cell(grid, rawRow, 'from'))
    if (id === null || seq === null || referencedTable === null || fromColumn === null) continue

    const row: ForeignKeyRow = {
      id,
      seq,
      referencedTable,
      fromColumn,
      toColumn: readText(cell(grid, rawRow, 'to')),
      onUpdate: readText(cell(grid, rawRow, 'on_update'))?.toUpperCase() ?? null,
      onDelete: readText(cell(grid, rawRow, 'on_delete'))?.toUpperCase() ?? null,
      match: readText(cell(grid, rawRow, 'match'))?.toUpperCase() ?? null
    }
    const existing = groups.get(id)
    if (existing === undefined) groups.set(id, [row])
    else existing.push(row)
  }

  const result: SqliteForeignKeyDescription[] = []
  for (const [id, unsortedRows] of groups) {
    const rows = [...unsortedRows].sort((left, right) => left.seq - right.seq)
    const first = rows[0]
    if (first === undefined) continue
    result.push({
      id,
      name: null,
      columns: rows.map((row) => row.fromColumn),
      referencedSchema: null,
      referencedTable: first.referencedTable,
      referencedColumns: resolveReferencedColumns(db, rows, first.referencedTable),
      onUpdate: first.onUpdate,
      onDelete: first.onDelete,
      match: first.match
    })
  }

  return result.sort((left, right) => {
    return (
      compareText(left.referencedTable, right.referencedTable) ||
      compareText(left.columns.join('\u0000'), right.columns.join('\u0000')) ||
      left.id - right.id
    )
  })
}

function readIndexSql(db: DatabaseSync, indexName: string): string | null {
  const grid = queryRows(
    db,
    `索引定义 ${indexName}`,
    `SELECT sql
       FROM sqlite_master
      WHERE type = 'index' AND name = ?
      LIMIT 1`,
    [indexName]
  )
  const row = grid.rows[0]
  return row === undefined ? null : readText(cell(grid, row, 'sql'))
}

/** 读取索引、唯一性和 partial predicate；表达式索引用 CREATE INDEX 原文补齐列项。 */
export function readSqliteIndexes(db: DatabaseSync, tableName: string): SqliteIndexDescription[] {
  const list = queryRows(
    db,
    `索引列表 ${tableName}`,
    `SELECT *
       FROM pragma_index_list(?)
      ORDER BY name COLLATE NOCASE, name`,
    [tableName]
  )
  const indexes: SqliteIndexDescription[] = []

  for (const listRow of list.rows) {
    const name = readText(cell(list, listRow, 'name'))
    if (name === null) continue

    const info = queryRows(
      db,
      `索引列 ${name}`,
      `SELECT *
         FROM pragma_index_info(?)
        ORDER BY seqno`,
      [name]
    )
    const sql = readIndexSql(db, name)
    const terms = sql === null ? [] : parseIndexTerms(sql)
    const columns: string[] = []
    for (let index = 0; index < info.rows.length; index += 1) {
      const row = info.rows[index]
      if (row === undefined) continue
      const seq = readNumber(cell(info, row, 'seqno')) ?? index
      columns.push(readText(cell(info, row, 'name')) ?? terms[seq] ?? '')
    }

    const partial = readFlag(cell(list, listRow, 'partial'))
    indexes.push({
      name,
      unique: readFlag(cell(list, listRow, 'unique')),
      columns,
      predicate: partial && sql !== null ? parseSqlitePartialIndexPredicate(sql) : null,
      origin: readText(cell(list, listRow, 'origin')) ?? '',
      partial,
      sql
    })
  }

  return indexes.sort((left, right) => compareText(left.name, right.name))
}

function uniqueConstraintsFromIndexes(indexes: readonly SqliteIndexDescription[]): readonly (readonly string[])[] {
  return indexes
    .filter((index) => (index.origin === 'u' || index.origin === 'pk') && !index.partial)
    .map((index) => index.columns)
    .sort((left, right) => compareText(left.join('\u0000'), right.join('\u0000')))
}

export function readSqliteChecks(db: DatabaseSync, tableName: string): string[] {
  const sql = readSqliteTableSql(db, tableName)
  return sql === null ? [] : parseSqliteCheckExpressions(sql)
}

/** 读取表上的触发器定义；name 排序使用二进制优先级，保证跨平台稳定。 */
export function readSqliteTriggers(db: DatabaseSync, tableName: string): SqliteTriggerDescription[] {
  const grid = queryRows(
    db,
    `触发器 ${tableName}`,
    `SELECT name, tbl_name, sql
       FROM sqlite_master
      WHERE type = 'trigger'
        AND tbl_name = ? COLLATE NOCASE
      ORDER BY name COLLATE NOCASE, name`,
    [tableName]
  )
  const triggers: SqliteTriggerDescription[] = []

  for (const row of grid.rows) {
    const name = readText(cell(grid, row, 'name'))
    const owner = readText(cell(grid, row, 'tbl_name'))
    const sql = readText(cell(grid, row, 'sql'))
    if (name === null || owner === null || sql === null) continue
    triggers.push({
      name,
      tableName: owner,
      sql,
      body: parseSqliteTriggerBody(sql),
      ...parseSqliteTriggerDefinition(sql)
    })
  }
  return triggers.sort((left, right) => compareText(left.name, right.name))
}

/**
 * `describeTable` 的结构扩展入口。
 *
 * 不读取列，也不返回 id/hasUniqueKey：它们已经由 adapter 的现有路径负责。
 * 这样主进程只需要把四个字段合并进 TableDescription，不需要新 RPC。
 */
export function readSqliteTableMetadata(db: DatabaseSync, tableName: string): SqliteTableMetadataPatch {
  // 先验证对象存在，避免 PRAGMA 对不存在的表静默返回空集。
  readSqliteObject(db, tableName)
  const indexes = readSqliteIndexes(db, tableName)
  return {
    foreignKeys: readSqliteForeignKeys(db, tableName),
    indexes,
    checks: readSqliteChecks(db, tableName),
    triggers: readSqliteTriggers(db, tableName),
    uniqueConstraints: uniqueConstraintsFromIndexes(indexes)
  }
}

/**
 * 把 SQLite 专有的读取结果翻译成**跨方言契约**（`core/metadata.ts`）。
 *
 * ===== 为什么要有这一层翻译，而不是直接返回 SQLite 的形状 =====
 *
 * SQLite 的 PRAGMA 输出带着一堆方言专属信息（`origin`、`partial`、`match`、
 * `updateOf`、触发器的 `when`）。这些在 SQLite 内部很有用，
 * 但 UI 若直接消费它们，就得为每个方言各写一套渲染分支——
 * 那正是 DBeaver 用 `DBSIndex` / `DBSForeignKeyConstraint` 这些**抽象基类**
 * 花了几十年才消灭掉的东西。
 *
 * 所以这里做一次**收窄**：SQLite 专属细节留在 SQLite 层，
 * 跨方言能表达的部分才翻译上去。多出来的信息不丢——
 * 它们仍在 `readSqliteTableMetadata()` 的返回值里，adapter 需要时自取。
 *
 * ===== 翻译时必须保留的信息 =====
 *
 *   - 表达式索引：`columns` 置空、原始表达式放进 `expression`。
 *     契约里 `IndexDescription.expression` 的存在就是为了这个——
 *     否则 UI 看到"空列的索引"会以为数据坏了。
 *   - 触发器时机/事件：SQLite 的小写值归一为跨方言的大写关键字。
 *   - 触发器体：契约的 `statement` 保留 BEGIN/END 内的原始 SQL。
 */
export function toCoreTableMetadata(
  db: DatabaseSync,
  tableName: string
): {
  readonly uniqueConstraints: readonly UniqueConstraintDescription[]
  readonly foreignKeys: readonly ForeignKeyDescription[]
  readonly indexes: readonly IndexDescription[]
  readonly checks: readonly CheckConstraintDescription[]
  readonly triggers: readonly TriggerDescription[]
} {
  const patch = readSqliteTableMetadata(db, tableName)
  return {
    uniqueConstraints: patch.uniqueConstraints.map((columns) => ({
      // SQLite 不暴露表级唯一约束名，只能给 null。
      name: null,
      columns: [...columns]
    })),
    foreignKeys: patch.foreignKeys.map((foreignKey) => ({
      name: foreignKey.name,
      columns: [...foreignKey.columns],
      referencedSchema: foreignKey.referencedSchema,
      referencedTable: foreignKey.referencedTable,
      referencedColumns: [...foreignKey.referencedColumns],
      onUpdate: foreignKey.onUpdate,
      onDelete: foreignKey.onDelete
    })),
    indexes: patch.indexes.map((index) => ({
      name: index.name,
      unique: index.unique,
      columns: isExpressionIndex(index.columns) ? [] : [...index.columns],
      predicate: index.predicate,
      expression: isExpressionIndex(index.columns) ? index.columns.join(', ') : null
    })),
    checks: patch.checks.map((expression) => ({
      name: null,
      expression
    })),
    // 触发器单独读：触发器是**独立的数据库对象**，
    // 混进「表结构片段」会让那个名字名不副实。
    triggers: readSqliteTriggers(db, tableName).map((trigger) => ({
      name: trigger.name,
      timing: toCoreTriggerTiming(trigger.timing),
      event: toCoreTriggerEvent(trigger.event),
      statement: extractTriggerBody(trigger.sql),
      updateOf: [...trigger.updateOf],
      when: trigger.when,
      // SQLite 没有禁用触发器的独立状态；能读到的触发器均视为启用。
      enabled: true
    }))
  }
}

function extractTriggerBody(sql: string): string {
  const begin = /\bbegin\b/i.exec(sql)
  if (begin === null) return sql.trim()
  const end = /\bend\s*;?\s*$/i.exec(sql)
  const bodyEnd = end === null ? sql.length : end.index
  return sql.slice(begin.index + begin[0].length, bodyEnd).trim()
}

function toCoreTriggerTiming(timing: SqliteTriggerDescription['timing']): TriggerDescription['timing'] {
  if (timing === 'before') return 'BEFORE'
  if (timing === 'after') return 'AFTER'
  return 'INSTEAD OF'
}

function toCoreTriggerEvent(event: SqliteTriggerDescription['event']): TriggerDescription['event'] {
  if (event === 'insert') return 'INSERT'
  if (event === 'update') return 'UPDATE'
  return 'DELETE'
}

/**
 * 判断索引列是不是**表达式**而不是真实列名。
 *
 * SQLite 的 `pragma_index_info` 对表达式索引返回 NULL 列名，
 * 本模块用 `CREATE INDEX` 原文里的表达式回填。
 * 真实列名不可能含有 `(`（那需要被引用），所以出现括号即可判定为表达式。
 */
function isExpressionIndex(columns: readonly string[]): boolean {
  return columns.some((column) => column.includes('('))
}

/** 与区域设置无关的稳定文本排序；同名时再按原始大小写区分。 */
function compareText(left: string, right: string): number {
  const leftFolded = left.toLowerCase()
  const rightFolded = right.toLowerCase()
  if (leftFolded < rightFolded) return -1
  if (leftFolded > rightFolded) return 1
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
