/**
 * 筛选条件的解析与 SQL 生成（纯函数，零依赖，可 Node 单测）。
 *
 * ============================================================================
 * 为什么必须「重新查询」而不是在前端过滤页缓存
 * ============================================================================
 * 结果集是分页加载的：`#pages` 里只有用户**滚动看过**的那几十/几百行。
 * 如果在前端对这份缓存做过滤，会得到「只过滤了看得见的行」的结果——
 *   - 看起来过滤成功了；
 *   - 但真正命中的行可能还在未加载的页里，永远不出现；
 *   - 而且**不会报错**。
 * 这类"静默错误"比崩溃危险得多，用户会据此做错误判断。
 *
 * 所以筛选必须下推到数据库：把条件拼成外层 `WHERE`（或包一层子查询）后**重跑**，
 * 让数据库对**全表**过滤，再从偏移 0 重新取页。这与排序（grid 的
 * `#requerySorted`）是同一个道理。
 *
 * ============================================================================
 * 注入防护：值必须转义，标识符必须引用
 * ============================================================================
 * 用户输入 `status = 'active'` 里有两部分，防护方式完全不同：
 *   1. **列名**（`status`）：它是标识符，必须用方言引用符包裹并转义内部引用符，
 *      否则 `status; DROP TABLE x` 之类会变成语法/注入。这里用调用方传入的
 *      `quote`（与排序共用同一套方言规则）。
 *   2. **值**（`'active'`）：它是字面量。若用户写了引号就原样保留（已经是 SQL 字面量）；
 *      若没写引号且不是数字/NULL，我们**加引号并翻倍内部单引号**。
 *      绝不做"直接字符串拼接"——这是注入的经典入口。
 *
 * 简化的取舍（明确写出来，避免后人误以为是完整 SQL 解析器）：
 *   - 只支持 `=` `!=` `<>` `>` `<` `>=` `<=` `LIKE` `NOT LIKE` `IS NULL` `IS NOT NULL`；
 *   - 多条件用 `AND` 连接；
 *   - 不解析括号、OR、函数等。够用且好懂，比半吊子解析器安全。
 */

/** 支持的操作符（长的放前面，解析时优先匹配）。 */
const OPERATORS = [
  'IS NOT NULL',
  'IS NULL',
  'NOT LIKE',
  'LIKE',
  '>=',
  '<=',
  '!=',
  '<>',
  '=',
  '>',
  '<'
] as const

export interface FilterCondition {
  readonly column: string
  readonly operator: string
  /** 右侧值（已转义为 SQL 字面量）；`IS NULL`/`IS NOT NULL` 时为 null。 */
  readonly valueSql: string | null
}

export type FilterParseResult =
  | { readonly ok: true; readonly conditions: readonly FilterCondition[] }
  | { readonly ok: false; readonly error: string }

/**
 * 把一个值转成 SQL 字面量。
 *
 * 规则：
 *   - 已加单引号的字符串（`'active'`）→ 保留引号、内部单引号翻倍；
 *   - 纯整数/小数（含负号）→ 原样（数字不加引号）；
 *   - `NULL` → `NULL` 关键字；
 *   - `true`/`false` → 1/0（SQLite 没有布尔字面量）；
 *   - 其它裸词 → 当作字符串，加引号并翻倍内部单引号（**不信任用户输入**）。
 */
export function toSqlLiteral(raw: string): string {
  const v = raw.trim()
  if (v === '') return "''"
  // 已经是单引号字符串：验证首尾配对/成对，然后翻倍内部单引号。
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    const inner = v.slice(1, -1)
    // 单个未配对的内部单引号（奇数个）视为非法——避免用户借此"闭合后注入"。
    // 注意：合法的转义是 `''`（两个），去掉后内部单引号个数仍为偶数才合法。
    const stripped = inner.replace(/''/g, '')
    if (stripped.includes("'")) {
      throw new FilterError(`值里的单引号没有成对：${raw}`)
    }
    return "'" + inner + "'"
  }
  if (/^NULL$/i.test(v)) return 'NULL'
  if (/^(true|false)$/i.test(v)) return /^true$/i.test(v) ? '1' : '0'
  // 整数或小数（允许负号、小数点、科学计数）。
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) {
    return v
  }
  // 其它裸词：当字符串，加引号并翻倍内部单引号。
  if (v.includes("'")) {
    // 裸词里出现单引号又没配对包裹 → 视为非法输入（多半是想注入或打错）。
    throw new FilterError(`值里有未转义的单引号：${raw}（字符串请用 '...' 包裹）`)
  }
  return "'" + v + "'"
}

/** 筛选错误（供上层统一转成人话）。 */
export class FilterError extends Error {}

/**
 * 解析一行筛选文本，如 `status = 'active' AND age > 18`。
 *
 * @param quote 标识符引用函数（方言决定），用于保护列名。
 */
export function parseFilter(text: string, quote: (name: string) => string): FilterParseResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, conditions: [] }

  // 用 AND 切分多条件。注意：不考虑字符串字面量里出现的 " AND "（简化版的已知限制，
  // 在注释里写明；真实场景若值里含 AND 请改用 SQL 里的 WHERE）。
  const parts = trimmed.split(/\s+AND\s+/i)
  const conditions: FilterCondition[] = []
  for (const part of parts) {
    const cond = parseOne(part.trim(), quote)
    if (!cond.ok) return cond
    conditions.push(cond.condition)
  }
  return { ok: true, conditions }
}

type OneResult =
  | { ok: true; condition: FilterCondition }
  | { ok: false; error: string }

function parseOne(expr: string, quote: (name: string) => string): OneResult {
  if (expr === '') return { ok: false, error: '存在空的筛选条件（多余或缺失了 AND 的一侧）' }

  for (const op of OPERATORS) {
    // 操作符前后需有空白或用词边界，避免把 `>=` 误判成 `>`。
    const re = new RegExp(`^(.*?)\\s+${escapeRegExp(op)}(?:\\s+(.*))?$`, 'i')
    const m = re.exec(expr)
    if (!m) continue
    const columnRaw = (m[1] ?? '').trim()
    if (columnRaw === '') return { ok: false, error: `缺列名：${expr}` }
    // 列名必须是"像标识符"的东西，且不能含引号/分号/括号——
    // 这是白名单式的前置检查（真正的保护仍是 quote 转义）。
    if (!/^[A-Za-z_][\w.]*$/.test(columnRaw)) {
      return { ok: false, error: `列名不合法：${columnRaw}（只允许字母、数字、下划线、点）` }
    }
    const upperOp = op.toUpperCase()
    const isNullOp = upperOp === 'IS NULL' || upperOp === 'IS NOT NULL'
    const valueRaw = (m[2] ?? '').trim()
    if (isNullOp) {
      if (valueRaw !== '') {
        return { ok: false, error: `${upperOp} 后面不应再有值：${expr}` }
      }
      return {
        ok: true,
        condition: { column: columnRaw, operator: upperOp, valueSql: null }
      }
    }
    if (valueRaw === '') return { ok: false, error: `${upperOp} 缺少右侧值：${expr}` }
    let valueSql: string
    try {
      valueSql = toSqlLiteral(valueRaw)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    return {
      ok: true,
      condition: { column: columnRaw, operator: upperOp, valueSql }
    }
  }
  return { ok: false, error: `无法识别的条件（缺少操作符？）：${expr}` }
}

/**
 * 把条件拼成 ` WHERE ...` 片段。
 *
 * 列名经 `quote` 转义；值已是安全字面量（由 toSqlLiteral 产生）。
 * 返回空串表示无条件。
 */
export function buildWhere(conditions: readonly FilterCondition[], quote: (name: string) => string): string {
  if (conditions.length === 0) return ''
  const parts = conditions.map((c) => {
    const col = quote(c.column)
    if (c.operator === 'IS NULL' || c.operator === 'IS NOT NULL') {
      return `${col} ${c.operator}`
    }
    return `${col} ${c.operator} ${c.valueSql}`
  })
  return ' WHERE ' + parts.join(' AND ')
}

/**
 * 依据"数据来源"生成带筛选的完整 SQL。
 *
 * 两种来源（与 grid 的 Source 对应）：
 *   - 表：`SELECT * FROM <quoted table> WHERE ...`
 *   - 自由 SQL：包一层子查询 `SELECT * FROM (<原 SQL>) _dbstudio_filter WHERE ...`
 *     （这样 WHERE 作用在**原查询的结果**上，语义正确）。
 *
 * @param base.tableName 表名（当 sourceKind === 'table'）
 * @param base.sql       原 SQL（当 sourceKind === 'sql'）
 */
export function buildFilteredSql(
  base:
    | { readonly sourceKind: 'table'; readonly tableName: string }
    | { readonly sourceKind: 'sql'; readonly sql: string },
  conditions: readonly FilterCondition[],
  quote: (name: string) => string
): string {
  const where = buildWhere(conditions, quote)
  if (base.sourceKind === 'table') {
    return `SELECT * FROM ${quote(base.tableName)}${where}`
  }
  // 子查询别名固定且带下划线前缀，避开与原 SQL 内表别名撞名。
  return `SELECT * FROM (${base.sql}) _dbstudio_filter${where}`
}

/** 把解析期错误转成给用户看的一句话（统一出口，便于以后本地化）。 */
export function describeFilterError(error: string): string {
  return `筛选条件有误：${error}`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
