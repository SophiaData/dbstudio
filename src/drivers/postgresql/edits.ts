/**
 * PostgreSQL 在线编辑的纯逻辑：UPDATE / INSERT / DELETE 的 SQL 构造与参数转换。
 *
 * 与 `sqlite/edits.ts` + `sqlite/mutations.ts` 同一分工（这里合成一个文件，
 * 因为 PG 的参数占位符规则统一是 `$1,$2,...`，不像 SQLite 的 `?`，
 * 需要一处集中管理"第几个参数"的编号——拆开反而容易出现编号错位）。
 *
 * ===== 与 SQLite 最关键的三处差异 =====
 *
 * 1. **占位符不是 `?`，而是 `$1, $2, ...`**（PG 的位置参数）。
 *    这意味着 SQL 文本里必须**按顺序编号**，而 SQLite 是顺序绑定 `?`。
 *    编号一错不会报错，只会把值绑到错误的列——所以这里的 `buildUpdateSql`
 *    与 `buildUpdateParams` 必须严格成对（同文件，紧挨着）。
 *
 * 2. **布尔直接绑 boolean**，不需要像 SQLite 那样转 0/1（PG 有真 boolean 类型）。
 *
 * 3. **表名必须带 schema 限定**。PG 的 search_path 可能让裸表名落到别的 schema，
 *    必须 `"schema"."table"`。
 *
 * 通用纪律（与 SQLite 一致）：值永远参数化、标识符永远 quote、无唯一键拒绝、不自动提交。
 */

import type { CellValue } from '../../core/resultset'
import { cellValueToSqlParam } from '../../core/resultset'

/**
 * 能绑定到 pg 参数上的值。
 *
 * 与 SQLite 的 `SqliteBind` 差异：
 *   - 有 `boolean`（PG 原生支持 boolean 绑定）
 *   - 没有 `bigint`（pg 默认把 bigint 当字符串传，这里也保持字符串）
 */
export type PostgresBind = string | number | boolean | null | Uint8Array

/**
 * `CellValue` → pg 可绑定的值。
 *
 * 复用 core 的 `cellValueToSqlParam`（规格要求：测试与实现用同一套转换）。
 * 与 SQLite 的 `toBindValue` 唯一的差别：**boolean 不做 0/1 转换**，
 * 直接返回 boolean（pg 的参数化支持 BOOLEAN）。这正是"PG 有真布尔"的落地。
 */
export function toBindValue(value: CellValue): PostgresBind {
  if (value.kind === 'boolean') return value.value
  return cellValueToSqlParam(value) as PostgresBind
}

/** 校验一次更新请求里的列名，规范化为表里真实列名。带 `requested` 供取值、`canonical` 供拼 SQL。 */
export interface ColumnMatch {
  readonly requested: string
  readonly canonical: string
}

/**
 * 按大小写不敏感匹配列名。
 *
 * ⚠️ 与 SQLite 的差别：PG 加引号的标识符**区分大小写**，未加引号的才折叠。
 * 我们的列名一律来自 information_schema（真实名字），调用方（UI 从结果集拿到的列名）
 * 传的也是真实名字，所以正常路径是精确匹配。
 * 这里做**大小写不敏感**匹配是为了容忍 UI 侧的轻微大小写差异，
 * 先精确匹配真实列名；只有不存在精确匹配且小写候选唯一时才回退。
 * `"Users"` 与 `"users"` 并存时，不猜测 `"USERS"` 指向哪一列。
 */
export function resolveColumns(
  requested: readonly string[],
  available: readonly string[]
): { readonly matched: readonly ColumnMatch[]; readonly unknown: readonly string[] } {
  const availableSet = new Set(available)
  const byLowerMap = new Map<string, string[]>()
  for (const name of available) {
    const key = name.toLowerCase()
    const list = byLowerMap.get(key) ?? []
    list.push(name)
    byLowerMap.set(key, list)
  }

  const matched: ColumnMatch[] = []
  const unknown: string[] = []
  for (const name of requested) {
    if (availableSet.has(name)) {
      matched.push({ requested: name, canonical: name })
      continue
    }
    const candidates = byLowerMap.get(name.toLowerCase())
    if (candidates && candidates.length === 1 && candidates[0] !== undefined) {
      matched.push({ requested: name, canonical: candidates[0] })
    } else {
      unknown.push(name)
    }
  }
  return { matched, unknown }
}

/**
 * 按目标列的真实名字补齐并排序匹配结果。
 *
 * `resolveColumns` 允许唯一的大小写不敏感回退，但这里必须按 canonical
 * 精确匹配目标列；否则组合主键 `("id", "ID")` 会把两个条件合并到同一列。
 */
export function resolveRequiredColumns(
  required: readonly string[],
  requested: readonly string[],
  available: readonly string[]
): {
  readonly resolved: ReturnType<typeof resolveColumns>
  readonly ordered: readonly ColumnMatch[]
  readonly missing: readonly string[]
} {
  const resolved = resolveColumns(requested, available)
  const ordered = required
    .map((key) => resolved.matched.find((candidate) => candidate.canonical === key))
    .filter((match): match is ColumnMatch => match !== undefined)
  const missing = required.filter(
    (key) => !resolved.matched.some((candidate) => candidate.canonical === key)
  )
  return { resolved, ordered, missing }
}

/** 从"列名 → 值"的记录里取值；取不到就抛（绑 undefined 会变 NULL = 静默写错数据）。 */
export function mustGetValue(record: Readonly<Record<string, CellValue>>, key: string): CellValue {
  const value = record[key]
  if (value === undefined) throw new Error(`缺少列「${key}」的值`)
  return value
}

/**
 * 一条语句的构造结果：SQL 模板 + 按位置排列的绑定值。
 *
 * 为什么把 SQL 和参数一起返回，而不是像 SQLite 那样分两个函数：
 * PG 的 `$n` 编号与参数数组下标必须严格对齐，一次构造出来就杜绝了"SQL 与参数数组分别维护、
 * 悄悄错位"的可能（SQLite 的 `?` 至少顺序绑定能自洽，`$n` 不行）。
 */
export interface BuiltStatement {
  readonly sql: string
  readonly params: readonly PostgresBind[]
}

/** 构造 UPDATE：`UPDATE "s"."t" SET "c"=$1 WHERE "k"=$2`。先 SET 后 WHERE。 */
export function buildUpdate(
  quote: (name: string) => string,
  schema: string,
  tableName: string,
  changeColumns: readonly string[],
  keyColumns: readonly string[],
  changeValues: ReadonlyMap<string, CellValue>,
  keyValues: ReadonlyMap<string, CellValue>
): BuiltStatement {
  const params: PostgresBind[] = []
  let n = 1
  const setClause = changeColumns.map((column) => `${quote(column)} = $${n++}`).join(', ')
  for (const column of changeColumns) params.push(toBindValue(mustGetValueMap(changeValues, column)))
  const whereClause = keyColumns.map((column) => `${quote(column)} = $${n++}`).join(' AND ')
  for (const column of keyColumns) params.push(toBindValue(mustGetValueMap(keyValues, column)))
  const sql = `UPDATE ${quote(schema)}.${quote(tableName)} SET ${setClause} WHERE ${whereClause}`
  return { sql, params }
}

/** 构造 DELETE：`DELETE FROM "s"."t" WHERE "k"=$1`。调用方必须先保证 keyColumns 非空。 */
export function buildDelete(
  quote: (name: string) => string,
  schema: string,
  tableName: string,
  keyColumns: readonly string[],
  keyValues: ReadonlyMap<string, CellValue>
): BuiltStatement {
  const params: PostgresBind[] = []
  let n = 1
  const whereClause = keyColumns.map((column) => `${quote(column)} = $${n++}`).join(' AND ')
  for (const column of keyColumns) params.push(toBindValue(mustGetValueMap(keyValues, column)))
  const sql = `DELETE FROM ${quote(schema)}.${quote(tableName)} WHERE ${whereClause}`
  return { sql, params }
}

/**
 * 构造 INSERT：`INSERT INTO "s"."t" ("a","b") VALUES ($1,$2)`。
 *
 * 只列调用方给出的列——没给的列让数据库用默认值/自增。
 * `RETURNING` 由 adapter 决定（是否需要回填主键），这里只管语句与参数。
 */
export function buildInsert(
  quote: (name: string) => string,
  schema: string,
  tableName: string,
  columns: readonly string[],
  values: ReadonlyMap<string, CellValue>
): BuiltStatement {
  const columnList = columns.map((column) => quote(column)).join(', ')
  const params: PostgresBind[] = []
  const placeholders = columns.map((column, i) => {
    params.push(toBindValue(mustGetValueMap(values, column)))
    return `$${i + 1}`
  })
  const sql = `INSERT INTO ${quote(schema)}.${quote(tableName)} (${columnList}) VALUES (${placeholders.join(', ')})`
  return { sql, params }
}

/** 构造 COUNT：表名必须带 schema 并 quote。 */
export function buildCountSql(quote: (name: string) => string, schema: string, tableName: string): string {
  return `SELECT COUNT(*) AS dbstudio_count FROM ${quote(schema)}.${quote(tableName)}`
}

/** 把 `Record<string, CellValue>` 规范化成「表内真实列名 → 值」，复用 resolveColumns 的匹配规则。 */
export function normalizeValues(
  values: Readonly<Record<string, CellValue>>,
  availableColumns: readonly string[]
): { readonly columns: readonly string[]; readonly byColumn: ReadonlyMap<string, CellValue>; readonly unknown: readonly string[] } {
  const requested = Object.keys(values)
  const resolved = resolveColumns(requested, availableColumns)
  const byColumn = new Map<string, CellValue>()
  for (const match of resolved.matched) {
    byColumn.set(match.canonical, mustGetValue(values, match.requested))
  }
  return { columns: [...byColumn.keys()], byColumn, unknown: resolved.unknown }
}

/** `ReadonlyMap` 版取值，取不到就抛。 */
function mustGetValueMap(values: ReadonlyMap<string, CellValue>, key: string): CellValue {
  const value = values.get(key)
  if (value === undefined) throw new Error(`缺少列「${key}」的值`)
  return value
}
