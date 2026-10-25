/**
 * PostgreSQL 值转换与分页相关的纯逻辑（不含连接管理）。
 *
 * 与 `sqlite/results.ts` 同一分工，但**值语义差别很大**，逐条说明：
 *
 * ===== 与 SQLite 的三处关键差异 =====
 *
 * 1. **PG 有真正的 BOOLEAN**。`pg` 驱动把 `bool` 列返回成 JS `boolean`，
 *    不像 SQLite 只有 0/1 整数。所以这里必须真的产出 `{ kind: 'boolean' }`，
 *    而不是像 SQLite 那样把所有数字都当数字。反过来，写回时 boolean 直接绑
 *    boolean（`pg` 支持），**不需要**像 SQLite 那样转成 0/1。
 *
 * 2. **大整数（BIGINT / NUMERIC）`pg` 默认返回字符串**。
 *    `pg` 为避免精度丢失，把 `int8` 与 `numeric` 都返回成 `string`。
 *    我们**保留这个行为**：既然后端已经是精确字符串，就不要再 `Number()` 回去
 *    （那会在超出 2^53 时静默丢精度）。代价是"整数字段在网格里显示成 text 类型"，
 *    这是精度优先于类型美观的取舍，与 SQLite 侧 `readBigInts` 超界降级为 text 同理。
 *
 * 3. **DATE / TIMESTAMP 返回 JS `Date`**。`pg` 把 date/timestamp 解析成 `Date` 对象。
 *    `Date` 能结构化克隆，但直接塞进 `CellValue` 会丢掉"这是不是时间"的语义类型。
 *    这里统一转成 ISO 字符串并按 `text` 传输——UI 拿到的是一段可读的时间文本，
 *    且不依赖渲染进程的时区处理（跨进程传字符串最稳）。
 *
 * 分页：与 SQLite 采用**同一条路线 A**（`SELECT * FROM (原SQL) LIMIT n OFFSET m` 重新执行），
 * 理由与代价见 `sqlite/results.ts` 文件头，此处不重复。
 */

import type { CellValue, ResultColumn, ResultRow, ResultValueType } from '../../core/resultset'
import { MAX_BLOB_PREVIEW_BYTES, MAX_CELL_TEXT_CHARS } from '../../core/resultset'
import { Buffer } from 'node:buffer'

import { PostgresAdapterError } from './errors'

/** 分页参数的默认值与边界（与 SQLite 保持一致，避免两方言的页大小语义分叉）。 */
export const DEFAULT_PAGE_SIZE = 200
export const MIN_PAGE_SIZE = 1
export const MAX_PAGE_SIZE = 1000

// ---------------------------------------------------------------------------
// SQL 只读校验（与 SQLite 同一套思路，但关键字集合按 PG 调整）
// ---------------------------------------------------------------------------

/**
 * 一眼能判断"会改数据 / 改结构 / 改会话状态"的首关键字。
 *
 * ⚠️ 与 SQLite 版同样定位：这是**防手滑的护栏，不是安全边界**。
 * 真正的安全边界是数据库权限。关键词黑名单永远可绕，不要叠加"安全"预期。
 *
 * 与 SQLite 的差异：PG 有 `GRANT`/`REVOKE`/`COPY`/`TRUNCATE`/`ALTER`/`COMMENT`/`SET`，
 * 还有事务控制 `END`。这些在 SQLite 版里不全有，所以这里单独维护，不照抄。
 */
const REJECTED_KEYWORDS = new Set([
  // 写数据
  'insert',
  'update',
  'delete',
  'merge',
  'truncate',
  'copy',
  // 写结构
  'create',
  'drop',
  'alter',
  'comment',
  'reindex',
  'vacuum',
  'cluster',
  // 权限
  'grant',
  'revoke',
  // 改库级 / 会话状态
  'begin',
  'start',
  'commit',
  'rollback',
  'end',
  'savepoint',
  'release',
  'set',
  'reset',
  'discard',
  'listen',
  'notify',
  'unlisten'
])

/**
 * 能被"包成子查询"再分页的语句类型。
 * 分页实现是 `SELECT * FROM (你的 SQL) LIMIT n OFFSET m`，
 * 要求你的 SQL 是返回行的查询表达式。`EXPLAIN` / `SHOW` / `DESCRIBE` 不是。
 */
export const PAGINATABLE_KEYWORDS = new Set(['select', 'values', 'table'])

/** PG 认可、但不能包成子查询分页的语句起始词。用于区分"合法但不支持"与"拼错"。 */
const KNOWN_SQL_KEYWORDS = new Set([
  ...REJECTED_KEYWORDS,
  'select',
  'values',
  'table',
  'with',
  'explain',
  'show',
  'analyze',
  'prepare',
  'execute',
  'deallocate',
  'declare',
  'fetch',
  'close'
])

/** 出现在 `WITH` 之后、能标识"这条语句究竟在干什么"的关键字。 */
const STATEMENT_KEYWORDS = new Set(['select', 'insert', 'update', 'delete', 'merge', 'values', 'table'])

interface SqlAnalysis {
  readonly statementSql: string
  readonly topLevelWords: readonly string[]
  readonly hasExtraStatement: boolean
  readonly hasAssignment: boolean
}

function isWordChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '$'
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql.charAt(i) === quote) {
      if (sql.charAt(i + 1) === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i += 1
  }
  return sql.length
}

function hasContentAfter(sql: string, from: number): boolean {
  let i = from
  while (i < sql.length) {
    const ch = sql.charAt(i)
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i += 1
      continue
    }
    if (ch === '-' && sql.charAt(i + 1) === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl + 1
      continue
    }
    if (ch === '/' && sql.charAt(i + 1) === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }
    return true
  }
  return false
}

/**
 * 手工扫描一遍 SQL。与 SQLite 版同构——不在正则上做切分，
 * 因为字符串字面量与带引号标识符里可以出现任意字符（含分号）。
 */
function analyzeSql(sql: string): SqlAnalysis {
  const topLevelWords: string[] = []
  let depth = 0
  let statementEnd = sql.length
  let hasExtraStatement = false
  let hasAssignment = false
  let word = ''
  let i = 0

  const flushWord = (): void => {
    if (word !== '') {
      if (depth === 0) topLevelWords.push(word.toLowerCase())
      word = ''
    }
  }

  while (i < sql.length) {
    const ch = sql.charAt(i)

    if (ch === '-' && sql.charAt(i + 1) === '-') {
      flushWord()
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl + 1
      continue
    }
    if (ch === '/' && sql.charAt(i + 1) === '*') {
      flushWord()
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }
    // 单引号字符串 / 双引号标识符：整体跳过（PG 用双引号做标识符，单引号做字符串）
    if (ch === "'" || ch === '"') {
      flushWord()
      i = skipQuoted(sql, i, ch)
      continue
    }
    if (ch === '(') {
      flushWord()
      depth += 1
      i += 1
      continue
    }
    if (ch === ')') {
      flushWord()
      depth = depth > 0 ? depth - 1 : 0
      i += 1
      continue
    }
    if (ch === ';') {
      flushWord()
      if (depth === 0) {
        statementEnd = i
        if (hasContentAfter(sql, i + 1)) hasExtraStatement = true
        break
      }
      i += 1
      continue
    }
    if (ch === '=' && depth === 0) {
      flushWord()
      const prev = sql.charAt(i - 1)
      const next = sql.charAt(i + 1)
      if (next !== '=' && prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>') hasAssignment = true
      i += 1
      continue
    }
    if (isWordChar(ch)) {
      word += ch
      i += 1
      continue
    }
    flushWord()
    i += 1
  }
  flushWord()

  return {
    statementSql: sql.slice(0, statementEnd).trim(),
    topLevelWords,
    hasExtraStatement,
    hasAssignment
  }
}

function statementKeyword(words: readonly string[]): string {
  const first = words[0]
  if (first === undefined) return ''
  if (first !== 'with') return first
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i]
    if (w !== undefined && STATEMENT_KEYWORDS.has(w)) return w
  }
  return first
}

/**
 * 校验并规范化用户 SQL，返回可安全包进子查询的语句文本。
 *
 * 与 SQLite 版的差异：
 *   - 没有 `PRAGMA` 这一支（PG 用 `SHOW` / `SET`，`SET` 已在 REJECTED 里）。
 *   - 多语句拒绝：PG 的 `pg` 驱动可以一次执行多条（用 simple query 协议），
 *     但我们仍在**只读查询窗口**里拒绝多语句，避免用户误以为只跑了第一条。
 */
export function prepareReadOnlyStatement(rawSql: string): string {
  const sql = rawSql.trim()
  if (sql === '') {
    throw new PostgresAdapterError('bad_params', 'SQL 不能为空。')
  }

  const analysis = analyzeSql(sql)
  if (analysis.statementSql === '') {
    throw new PostgresAdapterError('bad_params', '这段 SQL 里没有可执行的语句。')
  }

  if (analysis.hasExtraStatement) {
    throw new PostgresAdapterError(
      'bad_params',
      '一次只能执行一条语句：查询窗口不会执行第二条及之后的语句，请分开执行。'
    )
  }

  const keyword = statementKeyword(analysis.topLevelWords)
  if (keyword === '') {
    throw new PostgresAdapterError('bad_params', '无法识别这条 SQL 的语句类型，请检查语法。')
  }

  if (REJECTED_KEYWORDS.has(keyword)) {
    throw new PostgresAdapterError(
      'query_failed',
      `本阶段的查询窗口是只读的：${keyword.toUpperCase()} 这类会修改数据/结构/会话的语句不会被执行。（写操作走结果集编辑与 DDL 接口）`
    )
  }

  if (!PAGINATABLE_KEYWORDS.has(keyword)) {
    const upper = keyword.toUpperCase()
    if (KNOWN_SQL_KEYWORDS.has(upper)) {
      throw new PostgresAdapterError(
        'bad_params',
        `结果集按页读取需要把语句包成子查询（SELECT * FROM (你的 SQL) LIMIT …），` +
          `因此只支持 SELECT / WITH … SELECT / VALUES / TABLE。${upper} 是有效语句类型，但不支持分页读取。`
      )
    }
    throw new PostgresAdapterError(
      'bad_params',
      `无法识别的语句起始词 "${upper}"——可能是拼写错误。结果集按页读取只支持 SELECT / WITH … SELECT / VALUES / TABLE。`
    )
  }

  return analysis.statementSql
}

export type PostgresStatementKind = 'rows' | 'affected' | 'ddl'

export interface AnalyzedPostgresStatement {
  readonly statementSql: string
  readonly keyword: string
  readonly kind: PostgresStatementKind
}

/**
 * 分析并分类用于工作台执行的 PostgreSQL 通用语句。
 */
export function prepareGeneralStatement(rawSql: string): AnalyzedPostgresStatement {
  const sql = rawSql.trim()
  if (sql === '') {
    throw new PostgresAdapterError('bad_params', 'SQL 不能为空。')
  }

  const analysis = analyzeSql(sql)
  if (analysis.statementSql === '') {
    throw new PostgresAdapterError('bad_params', '这段 SQL 里没有可执行的语句。')
  }

  if (analysis.hasExtraStatement) {
    throw new PostgresAdapterError(
      'bad_params',
      '一次只能执行一条语句：查询窗口不会执行第二条及之后的语句，请分开执行。'
    )
  }

  const keyword = statementKeyword(analysis.topLevelWords)
  if (keyword === '') {
    throw new PostgresAdapterError('bad_params', '无法识别这条 SQL 的语句类型，请检查语法。')
  }

  const DML_KEYWORDS = new Set(['insert', 'update', 'delete', 'merge'])
  if (DML_KEYWORDS.has(keyword)) {
    if (analysis.topLevelWords.includes('returning')) {
      return { statementSql: analysis.statementSql, keyword, kind: 'rows' }
    }
    return { statementSql: analysis.statementSql, keyword, kind: 'affected' }
  }

  const DDL_KEYWORDS = new Set([
    'create', 'drop', 'alter', 'truncate', 'comment', 'reindex', 'vacuum', 'cluster',
    'grant', 'revoke', 'set', 'reset', 'discard'
  ])
  if (DDL_KEYWORDS.has(keyword)) {
    return { statementSql: analysis.statementSql, keyword, kind: 'ddl' }
  }

  return { statementSql: analysis.statementSql, keyword, kind: 'rows' }
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

export function normalizePageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.floor(value)))
}

export function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
}

/**
 * 生成取页 SQL。必须包一层子查询——用户的 SQL 很可能自带 ORDER BY / LIMIT，
 * 直接往后接 `LIMIT n OFFSET m` 会语法错误，或语义变成"对前 N 行再分页"。
 * 整数已过 normalizePageSize/normalizeOffset 收窄成受控整数，不存在注入面。
 */
export function buildPagedSql(statementSql: string, limit: number, offset: number): string {
  return `SELECT * FROM (\n${statementSql}\n) AS dbstudio_paged LIMIT ${limit} OFFSET ${offset}`
}

// ---------------------------------------------------------------------------
// 值转换
// ---------------------------------------------------------------------------

/**
 * PG 值 → 可跨进程传输的 CellValue。
 *
 * 关键差异（与 sqlite/results.ts 的 toCellValue 对照）：
 *   - `boolean` → `{ kind: 'boolean' }`（PG 有真布尔，SQLite 没有）
 *   - `string` → text（**包括** pg 返回的 int8/numeric 精确字符串，不转数字）
 *   - `Date` → ISO 文本（PG 的 date/timestamp/time 被 pg 解析成 Date）
 *   - `Buffer`/`Uint8Array` → blob 预览（bytea）
 *   - `number` → number（pg 的 int4/float8 是 JS number）
 *   - `bigint` → 理论上 pg 默认不返回 bigint（返回 string），但保留分支以防配置变更
 */
export function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return { kind: 'null' }

  if (typeof value === 'boolean') return { kind: 'boolean', value }

  if (typeof value === 'number') {
    // pg 的 int4 / float8 走这里；NaN / Infinity 不在 JSON 可序列化范围，转文本兜底
    if (!Number.isFinite(value)) return { kind: 'text', text: String(value) }
    return { kind: 'number', value }
  }

  if (typeof value === 'bigint') {
    // pg 默认不开 BigInt 解析；如配置变更导致出现，按安全范围降级（与 SQLite 同一策略）
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return { kind: 'number', value: Number(value) }
    }
    return { kind: 'text', text: value.toString() }
  }

  if (typeof value === 'string') {
    if (value.length > MAX_CELL_TEXT_CHARS) {
      return {
        kind: 'text',
        text: value.slice(0, MAX_CELL_TEXT_CHARS),
        truncated: true,
        fullLength: value.length
      }
    }
    return { kind: 'text', text: value }
  }

  if (value instanceof Date) {
    // pg 把 date/timestamp/timestamptz 都解析成 Date；统一转 ISO 文本传输
    return { kind: 'text', text: value.toISOString() }
  }

  if (value instanceof Uint8Array) {
    const previewLength = Math.min(value.length, MAX_BLOB_PREVIEW_BYTES)
    return {
      kind: 'blob',
      previewBase64: Buffer.from(value.subarray(0, previewLength)).toString('base64'),
      length: value.length,
      truncated: value.length > previewLength
    }
  }

  // 其它（数组、JSON 对象、pg 的 range 等复杂类型）：转成 JSON/text，不丢信息
  return { kind: 'text', text: typeof value === 'object' ? JSON.stringify(value) : String(value) }
}

/** 同 toCellValue 但不截断文本。只给 fetchCellValue（用户显式看全文）用。 */
export function toFullCellValue(value: unknown): CellValue {
  if (typeof value === 'string') return { kind: 'text', text: value }
  if (value instanceof Uint8Array) {
    return {
      kind: 'blob',
      previewBase64: Buffer.from(value).toString('base64'),
      length: value.length,
      truncated: false
    }
  }
  return toCellValue(value)
}

/**
 * 推断列的 ResultValueType（按运行时值，拿不到就 'unknown'）。
 *
 * 与 SQLite 版的差异：会识别 boolean 与 Date。
 * 已知近似：pg 把 int8/numeric 返回成 string，所以这些列会推断成 'text'——
 * 这是精度优先的必然结果（见文件头第 2 条）。
 */
export function inferColumnType(values: readonly unknown[]): ResultValueType {
  for (const value of values) {
    if (value === null || value === undefined) continue
    if (typeof value === 'boolean') return 'boolean'
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'real'
    if (typeof value === 'bigint') return 'integer'
    if (typeof value === 'string') return 'text'
    if (value instanceof Date) return 'date'
    if (value instanceof Uint8Array) return 'blob'
    return 'unknown'
  }
  return values.length === 0 ? 'unknown' : 'null'
}

// ---------------------------------------------------------------------------
// 组装给上层的结构
// ---------------------------------------------------------------------------

/** pg 的查询结果里我们需要的字段（用结构类型避免 import pg 到纯逻辑层）。 */
export interface PgResultLike {
  readonly fields: readonly { readonly name: string }[]
  readonly rows: readonly Record<string, unknown>[]
}

/**
 * 把 pg 的 `Result` 归一化成"按列顺序取值的网格"。
 *
 * pg 默认返回**以列名为键的对象行**（不是数组），所以这里按 `fields` 的列名列表
 * 逐列取值——与 SQLite 的 `readGrid` 归一化目的相同：
 * `SELECT u.id, o.id FROM users u JOIN orders o` 在对象行里**后一列会覆盖前一列**，
 * 直接按对象取值会静默丢数据。按 `fields` 顺序 + 列名取值至少能对齐列顺序，
 * 重名列时两列拿到的是同一个值（pg 的对象行本就不区分重名列）——
 * 这是 pg 驱动的已知限制，UI 侧应给重名列起别名。
 */
export function buildGrid(result: PgResultLike): { readonly names: readonly string[]; readonly rows: readonly (readonly unknown[])[] } {
  const names = result.fields.map((f) => f.name)
  const rows = result.rows.map((row) => names.map((name) => row[name]))
  return { names, rows }
}

export function buildColumns(names: readonly string[], rows: readonly (readonly unknown[])[]): ResultColumn[] {
  return names.map((name, index) => ({
    name,
    type: inferColumnType(rows.map((row) => row[index]))
  }))
}

/** 行下标用**绝对下标**：渲染进程的虚拟滚动要靠它把页面拼回结果集。 */
export function buildRows(
  names: readonly string[],
  rows: readonly (readonly unknown[])[],
  offset: number
): ResultRow[] {
  return rows.map((row, index) => ({
    index: offset + index,
    cells: row.map((value) => toCellValue(value))
  }))
}
