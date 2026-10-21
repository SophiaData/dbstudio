/**
 * 结果集相关的纯逻辑：SQL 只读校验、分页包装、行/单元格转换。
 *
 * 这里**只做转换，不做连接管理**（连接状态在 adapter.ts），
 * 所以它是可以被单独推理和测试的一层。
 *
 * ===== 取页路线选择：路线 A（重新执行 + 子查询包裹），不是迭代器 =====
 *
 * `node:sqlite` 的 `DatabaseSync` 是同步 API，`StatementSync.all()` 会把结果**全部**
 * 读进内存；百万行表上这是灾难。两条可行路线：
 *
 *   路线 A：`query()` 只取第一页并记住 SQL，`fetchResultPage()` 用
 *           `SELECT * FROM (原始 SQL) LIMIT n OFFSET m` 重新执行取该页。
 *   路线 B：用 `StatementSync.iterate()` 持有长期迭代器，按需前进。
 *
 * 选 A。理由是**正确性**：网格的虚拟滚动一定会往回滚，
 * 而迭代器**不能后退**（要后退只能重新执行，那还不如一开始就用 A），
 * 而且长期持有游标会一直占着内存与语句句柄。
 *
 * ===== 选 A 的代价，明确写在这里，不假装没有 =====
 *
 * 1. **深翻页越来越慢**：`OFFSET m` 要求数据库先产出并丢弃前 m 行，
 *    所以取第 10000 页的代价与 m 成正比——滚到结果的深处会明显变卡。
 *    （对比：DBeaver 单进程持有 ResultSet，可以直接 seek，没有这个代价；
 *      这是"跨进程 + 不占内存"换来的必然代价。）
 *    缓解方向（本阶段不做）：记录上次取到的行做 keyset 分页，
 *    或对已取过的页做 LRU 缓存；两者都要求知道排序键，而用户 SQL 不一定有。
 * 2. **用户 SQL 会被重新执行 N 次**：非确定性的查询
 *    （如 `SELECT random()`、或读的是会被并发改的表）在不同页之间可能不一致。
 *    这是"随机取页"与生俱来的性质，接受它，但要知道。
 * 3. 每次取页都要**重新 prepare**：这里没做语句缓存，因为缓存要处理
 *    schema 变化导致的失效，收益（prepare 很快）不值这个复杂度。
 */

import { Buffer } from 'node:buffer'

import type { CellValue, ResultColumn, ResultRow, ResultValueType } from '../../core/resultset'
import { MAX_BLOB_PREVIEW_BYTES, MAX_CELL_TEXT_CHARS } from '../../core/resultset'
import { SqliteAdapterError } from './errors'

/** 分页参数的默认值与边界。UI 传什么都不能让服务端内存失控。 */
export const DEFAULT_PAGE_SIZE = 200
export const MIN_PAGE_SIZE = 1
export const MAX_PAGE_SIZE = 1000

/** bigint → number 的安全边界。超过它转 number 就会静默丢精度。 */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER)

// ---------------------------------------------------------------------------
// SQL 校验：本阶段只读
// ---------------------------------------------------------------------------

/**
 * 一眼能判断"会改数据 / 改结构 / 改会话状态"的首关键字。
 *
 * ⚠️ 这是**防手滑的护栏，不是安全边界**。真正的安全边界是只读连接或数据库权限
 * （SQLite 可以用 `??mode=ro` 之类的打开方式做，本阶段没做）。
 * 关键词黑名单永远可以被绕（比如 `PRAGMA` 的某些写形态），
 * 所以不要在它上面叠加"安全"的预期。
 */
const REJECTED_KEYWORDS = new Set([
  // 写数据
  'insert',
  'update',
  'delete',
  'replace',
  // 写结构
  'create',
  'drop',
  'alter',
  'truncate',
  'reindex',
  'vacuum',
  // 改库级/会话状态
  'attach',
  'detach',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release'
])

/**
 * 能被"包成子查询"再分页的语句类型。
 *
 * 为什么只认这几种：分页实现是 `SELECT * FROM (你的 SQL) LIMIT n OFFSET m`，
 * 这句话要求你的 SQL 是一个**返回行的查询表达式**。
 * `EXPLAIN SELECT ...`、`PRAGMA table_info(t)` 都不是查询表达式，
 * 包进去就是语法错误——与其让用户看到 "near \"PRAGMA\": syntax error"，
 * 不如在这里直接说清楚。
 */
const PAGINATABLE_KEYWORDS = new Set(['select', 'values'])

/**
 * SQLite 认可、但**不能被包成子查询分页**的语句起始词（大写）。
 *
 * 用途：区分「语句类型合法但功能不支持」与「压根没认出来、八成是拼错」。
 * 这两种情况错误码相同（都是 `bad_params`），但**给用户的消息必须不同**——
 * 把 `SELEKT` 说成"不支持该语句类型"会让人以为自己在用冷门合法语法，
 * 实际上是打错了一个字母。
 *
 * 清单取自 SQLite 的语句起始关键字集合；不必穷尽所有子句词，
 * 只要覆盖到用户实际会尝试的顶层语句类型即可。
 */
const KNOWN_SQL_KEYWORDS = new Set([
  ...REJECTED_KEYWORDS,
  'select',
  'values',
  'with',
  'explain',
  'pragma',
  'analyze',
  'grant',
  'revoke'
])

/** 出现在 `WITH` 之后、能标识"这条语句究竟在干什么"的关键字。 */
const STATEMENT_KEYWORDS = new Set(['select', 'insert', 'update', 'delete', 'replace', 'values'])

interface SqlAnalysis {
  /** 截到第一条语句末尾（去掉分号及其后的注释）的 SQL，可直接拿去执行。 */
  readonly statementSql: string
  /** 括号深度为 0 的词（已小写）。CTE 体、函数参数都在括号里，不会混进来。 */
  readonly topLevelWords: readonly string[]
  /** 第一条语句之后是否还有实质内容（第二条语句）。 */
  readonly hasExtraStatement: boolean
  /** 深度 0 上是否出现赋值号——用来识别会改状态的 `PRAGMA x = y`。 */
  readonly hasAssignment: boolean
}

function isWordChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '$'
}

/** 跳过一个带引号片段（字符串或带引号标识符），处理 `''` / `""` 翻倍转义。 */
function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql.charAt(i) === quote) {
      if (sql.charAt(i + 1) === quote) {
        i += 2 // 翻倍 = 字面量，继续
        continue
      }
      return i + 1
    }
    i += 1
  }
  return sql.length // 没闭合就交给 SQLite 报语法错误，这里不替它判
}

/** 从 from 开始，跳过空白与注释后是否还有内容。 */
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
 * 手工扫描一遍 SQL，回答三个问题：语句到哪结束、顶层关键字是什么、是不是多条语句。
 *
 * 为什么不用正则：字符串字面量和带引号标识符里可以出现任意字符
 * （`SELECT '; delete from t'` 是完全合法的单条 SELECT），
 * 正则切分必然在某个 corner case 上给出错误结论，而这里的结论决定"要不要拒绝执行"。
 * 扫描器只有 40 行，且规则是确定的。
 */
function analyzeSql(sql: string): SqlAnalysis {
  const topLevelWords: string[] = []
  let depth = 0
  let statementEnd = sql.length
  let hasExtraStatement = false
  let hasAssignment = false
  let word = ''
  let i = 0

  /** 收尾当前累积的词；只在括号深度 0 上记入，避免 CTE 体/函数参数污染"语句关键字"。 */
  const flushWord = (): void => {
    if (word !== '') {
      if (depth === 0) topLevelWords.push(word.toLowerCase())
      word = ''
    }
  }

  while (i < sql.length) {
    const ch = sql.charAt(i)

    // 注释：里面的分号与关键字都不是语法
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
    // 字符串 / 带引号标识符：整体跳过
    if (ch === "'" || ch === '"' || ch === '`') {
      flushWord()
      i = skipQuoted(sql, i, ch)
      continue
    }
    if (ch === '[') {
      flushWord()
      const end = sql.indexOf(']', i + 1)
      i = end === -1 ? sql.length : end + 1
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
        // 第一条语句到此结束：后面**全是**注释/空白才算合法（例如 `SELECT 1; -- 注释`）
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
      // 排除 == != <= >= 这些比较运算符，只认赋值形态
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

/** 取出"这条语句究竟在干什么"的关键字；`WITH ...` 要穿透 CTE 定义看后续的真语句。 */
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
 * 返回的是**去掉尾部内容后的原文**（保留用户的大小写与注释），
 * 因为执行时用原文更利于用户对照 SQL 日志排查。
 */
export function prepareReadOnlyStatement(rawSql: string): string {
  const sql = rawSql.trim()
  if (sql === '') {
    throw new SqliteAdapterError('bad_params', 'SQL 不能为空。')
  }

  const analysis = analyzeSql(sql)
  if (analysis.statementSql === '') {
    throw new SqliteAdapterError('bad_params', '这段 SQL 里没有可执行的语句。')
  }

  /**
   * 多条语句必须拦掉，而不是放行。
   * 实测 node:sqlite 只编译并执行**第一条**，后面的被静默忽略——
   * 用户会以为两条都跑了（"我明明删了"，或者反过来"为什么没生效"）。
   * 静默忽略比报错危险得多，所以这里明确拒绝。
   */
  if (analysis.hasExtraStatement) {
    throw new SqliteAdapterError(
      'bad_params',
      '一次只能执行一条语句：SQLite 驱动会静默忽略第一条之后的语句，请分开执行。'
    )
  }

  const keyword = statementKeyword(analysis.topLevelWords)
  if (keyword === '') {
    throw new SqliteAdapterError('bad_params', '无法识别这条 SQL 的语句类型，请检查语法。')
  }

  if (REJECTED_KEYWORDS.has(keyword)) {
    throw new SqliteAdapterError(
      'query_failed',
      `本阶段的查询窗口是只读的：${keyword.toUpperCase()} 这类会修改数据的语句不会被执行。（写操作会留到结果集编辑阶段单独开放）`
    )
  }

  // PRAGMA 的读取形态（`PRAGMA table_info(t)`）没有赋值号；
  // 带赋值号的形态（`PRAGMA journal_mode = WAL`）会改数据库状态，这里拦掉。
  if (keyword === 'pragma' && analysis.hasAssignment) {
    throw new SqliteAdapterError('query_failed', '本阶段的查询窗口是只读的：会修改设置或状态的 PRAGMA 不会被执行。')
  }

  if (!PAGINATABLE_KEYWORDS.has(keyword)) {
    /**
     * 这里要区分两种"首词不在白名单"的情形，否则用户会被误导：
     *
     *   1. 首词是**已知的 SQL 语句类型**（ALTER / EXPLAIN / ATTACH …），
     *      只是不支持按页读取 → 消息应该说"这类语句不支持分页读取"；
     *   2. 首词**根本不是已知语句类型**（拼错成 SELEKT / SELEC），
     *      属于语法错误 → 消息应该说"没认出这是什么语句，可能是拼写错误"。
     *
     * 两类的错误码都是 `bad_params`（对调用方来说都是"你给的参数/语句不合法"，
     * 用同一个码不会让客户端做错判断），但**消息必须说对**——
     * 否则用户看到"不支持 SELEKT 这种语句类型"会以为自己用了一个合法的冷门语法，
     * 而实际上是打错了一个字母。
     */
    const upper = keyword.toUpperCase()
    if (KNOWN_SQL_KEYWORDS.has(upper)) {
      throw new SqliteAdapterError(
        'bad_params',
        `结果集按页读取需要把语句包成子查询（SELECT * FROM (你的 SQL) LIMIT …），` +
          `因此只支持 SELECT / WITH … SELECT / VALUES。${upper} 是有效语句类型，但不支持分页读取。`
      )
    }
    throw new SqliteAdapterError(
      'bad_params',
      `无法识别的语句起始词 "${upper}"——可能是拼写错误。` +
        `结果集按页读取只支持 SELECT / WITH … SELECT / VALUES。`
    )
  }

  return analysis.statementSql
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

/** 页大小：默认 200，clamp 到 [1, 1000]。非有限数一律回落到默认值。 */
export function normalizePageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.floor(value)))
}

/** 偏移量：负数/非有限数回落到 0；上限取 JS 安全整数（再大就没法在 JS 里精确比较了）。 */
export function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
}

/**
 * 生成取页 SQL。
 *
 * **必须包一层子查询**：用户的 SQL 很可能自带 `LIMIT` / `ORDER BY`
 * （`SELECT * FROM t ORDER BY id`），直接往后接 `LIMIT n OFFSET m` 是语法错误。
 * 包成 `SELECT * FROM (用户 SQL) LIMIT n OFFSET m` 的语义才是我们要的：
 * "在用户这条查询的结果集上翻页"。
 * 实测 SQLite 会保留子查询里的 ORDER BY（否则"翻页"本身就失去意义）。
 *
 * 这里把整数直接拼进 SQL 而不是用绑定参数：limit/offset 已经过
 * `normalizePageSize` / `normalizeOffset` 收窄成受控整数，不存在注入面；
 * 而拼成文本的好处是返回给 UI 的 `executedSql` 与实际执行的字面完全一致
 * （占位符版本还得再解释一次"参数是什么"）。
 */
export function buildPagedSql(statementSql: string, limit: number, offset: number): string {
  return `SELECT * FROM (\n${statementSql}\n) LIMIT ${limit} OFFSET ${offset}`
}

// ---------------------------------------------------------------------------
// 值转换
// ---------------------------------------------------------------------------

/**
 * SQLite 值 → 可跨进程传输的 CellValue。
 *
 * 几个刻意的选择：
 * - **大整数降级为 text**：打开连接时开了 `readBigInts`，所以整数都是 bigint。
 *   超出 IEEE-754 安全范围时转 number 会静默丢精度（尾数被截断），
 *   这里改为返回精确的十进制字符串并保持 kind='text'。
 *   宁可让类型类别降级，也不能给用户一个**看起来正常但是错的**数字。
 * - **0/1 不转 boolean**：SQLite 没有布尔类型，`is_active INTEGER` 的 0/1
 *   就是数字；擅自转 boolean 会让 `SELECT count(*)` 这类结果也变得"像布尔"。
 * - **BLOB 只给预览**：base64 预览不超过 MAX_BLOB_PREVIEW_BYTES，
 *   完整内容留给专门的接口——把二进制塞进 IPC 会把整条通道拖垮。
 */
export function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return { kind: 'null' }

  if (typeof value === 'bigint') {
    if (value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT) {
      return { kind: 'number', value: Number(value) }
    }
    // 超出安全范围的整数：用字符串保精度（UI 可据此标灰并提示"超出精确表示范围"）
    return { kind: 'text', text: value.toString() }
  }

  if (typeof value === 'number') return { kind: 'number', value }

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

  if (value instanceof Uint8Array) {
    const previewLength = Math.min(value.length, MAX_BLOB_PREVIEW_BYTES)
    return {
      kind: 'blob',
      previewBase64: Buffer.from(value.subarray(0, previewLength)).toString('base64'),
      length: value.length,
      truncated: value.length > previewLength
    }
  }

  if (typeof value === 'boolean') return { kind: 'boolean', value }

  // 兜底：不认识的类型也不能丢信息，转成文本总比抛错强
  return { kind: 'text', text: String(value) }
}

/**
 * 同 `toCellValue`，但**不截断文本**。只给 `fetchCellValue`（用户显式要看全文）用。
 *
 * 为什么单独一个函数而不是给 `toCellValue` 加个参数：
 * 截断是**分页通道的默认安全策略**（防止单帧撑爆 IPC），
 * 如果把它变成可选参数，任何一个调用点忘了传就会让分页也可能传出整篇大文本。
 * 把它拆成一个语义独立、名字就说明用途的函数，调用方一眼能看出代价。
 *
 * BLOB 也走完整路径：`previewBase64` 装的是**整个 BLOB** 的 base64（`truncated` 恒为 false）。
 * 超大 BLOB 会把整块读进内存并撑大 IPC——这是"用户显式请求完整值"的应有代价，
 * UI 侧应在调用前按大小提示/确认。
 */
export function toFullCellValue(value: unknown): CellValue {
  if (typeof value === 'string') {
    return { kind: 'text', text: value }
  }
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
 * 推断列的 `ResultValueType`（规格：按运行时值推断，拿不到就 'unknown'）。
 *
 * 这是**值推断，不是元数据**，所以有两个已知的近似：
 * - REAL 列里恰好存着整数值（如 2.0）会被判成 'integer'；
 *   要精确就得每列额外查一次 `PRAGMA table_info`，与"查询要快"冲突。
 * - 一页里全是 NULL 的列判成 'null'，下一页有值时会变成实际类型——
 *   每页各自推断，类型可能随页变化。
 */
export function inferColumnType(values: readonly unknown[]): ResultValueType {
  for (const value of values) {
    if (value === null || value === undefined) continue
    if (typeof value === 'bigint') return 'integer'
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'real'
    if (typeof value === 'string') return 'text'
    if (value instanceof Uint8Array) return 'blob'
    if (typeof value === 'boolean') return 'boolean'
    return 'unknown'
  }
  // 一行都没有 → 无从推断；有行但全 NULL → 这一页就是 null
  return values.length === 0 ? 'unknown' : 'null'
}

// ---------------------------------------------------------------------------
// 行读取归一化
// ---------------------------------------------------------------------------

/** 归一化后的结果网格：无论运行时的行是数组还是对象，都按**列顺序**取值。 */
export interface RawGrid {
  /** 列名（按结果集的列顺序，含重名列）。 */
  readonly names: readonly string[]
  /** 每行按列顺序排列的值。 */
  readonly rows: readonly (readonly unknown[])[]
}

/** 能绑定到语句上的参数值。不用 `any`，也不引入 node:sqlite 的联合类型。 */
export type BindValue = string | number | bigint | null | Uint8Array

/**
 * `readGrid` 需要的最小数据库接口。
 *
 * 声明成结构类型而不是直接 import `DatabaseSync`，有两个好处：
 * 1. results.ts 只依赖它真正用到的那两个方法，不做连接管理；
 * 2. 单测可以传一个假的实现进来，不必真开数据库。
 */
export interface QueryableDatabase {
  prepare(sql: string): {
    columns(): readonly { readonly name: string }[]
    all(...params: readonly BindValue[]): unknown
  }
}

/**
 * 执行一条语句并把结果归一化成"按列下标取值"。
 *
 * ===== 为什么要开 `returnArrays` 并在这里归一化 =====
 *
 * 默认模式下 node:sqlite 把行返回成**以列名为键的对象**，
 * 于是 `SELECT u.id, o.id FROM users u JOIN orders o` 这种常见的重复列名
 * 会互相覆盖——实测 `SELECT a AS dup, b AS dup` 只留下后一列的值，
 * 前一列**静默消失**。对数据库客户端而言这不可接受：用户看到的是错数据，
 * 而且没有任何报错。
 *
 * 所以连接用 `returnArrays: true` 打开，这里再统一成下标访问。
 * 万一是老运行时（该选项 Node 24.4 才有）会退化成对象模式：
 * 此时按列名取值仍然正确，**只有重名列**会丢数据，我们宁可明确报错也不静默给错——
 * 这是本文件里唯一一处"运行时能力探测"的理由。
 */
export function readGrid(db: QueryableDatabase, sql: string, arrayMode: boolean, ...params: readonly BindValue[]): RawGrid {
  const statement = db.prepare(sql)
  const names = statement.columns().map((column) => column.name)
  const rawRows: readonly unknown[] = statement.all(...params) as readonly unknown[]

  const rows: (readonly unknown[])[] = []
  for (const raw of rawRows) {
    if (Array.isArray(raw)) {
      rows.push(raw as readonly unknown[])
      continue
    }
    /**
     * 对象模式（老运行时）的兜底路径。
     *
     * 这里必须**逐列确认键真的存在**，不能只比较列名是否重复：
     * SQLite 会把重名列去重成 `dup` / `dup:1` 这类名字，
     * 于是"列名列表看起来没重复"，但行对象里根本没有 `dup:1` 这个键——
     * 取值会静默变成 undefined，再被转成 null 交给用户。
     * 那是最坏的结果（错数据 + 无报错），所以这里宁可显式报错。
     */
    const record = raw as Record<string, unknown>
    const missing = names.filter((name) => !Object.prototype.hasOwnProperty.call(record, name))
    if (missing.length > 0) {
      throw new SqliteAdapterError(
        'query_failed',
        `这条查询有重名或无法按名定位的列（${[...new Set(missing)].join(', ')}），` +
          '当前 Node 运行时（< 24.4）不支持按列下标读取结果，继续下去会静默丢失数据。' +
          '请给重复的列起别名（例如 `SELECT u.id AS user_id, o.id AS order_id`）后重试。'
      )
    }
    rows.push(names.map((name) => record[name]))
  }

  return { names, rows }
}

/**
 * 按列名取某一行里的值。
 *
 * 用列名而不是写死下标：SQLite 目前 `PRAGMA table_info` 的列顺序是稳定的
 * （cid, name, type, notnull, dflt_value, pk），但把这个顺序写进代码
 * 等于把一个未承诺的实现细节变成隐式契约——正是本项目一直在避免的东西。
 * 列名在两种读取模式下都拿得到（array 模式用 names，object 模式用键），代价可以忽略。
 */
export function cellByName(grid: RawGrid, row: readonly unknown[], name: string): unknown {
  const index = grid.names.indexOf(name)
  return index === -1 ? undefined : row[index]
}

// ---------------------------------------------------------------------------
// 组装给上层的结构
// ---------------------------------------------------------------------------

export function buildColumns(grid: RawGrid): ResultColumn[] {
  return grid.names.map((name, index) => ({
    name,
    type: inferColumnType(grid.rows.map((row) => row[index]))
  }))
}

/** 行下标用**绝对下标**：渲染进程的虚拟滚动要靠它把页面拼回结果集。 */
export function buildRows(grid: RawGrid, offset: number): ResultRow[] {
  return grid.rows.map((row, index) => ({
    index: offset + index,
    cells: row.map((value) => toCellValue(value))
  }))
}
