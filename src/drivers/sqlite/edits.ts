/**
 * 在线编辑的纯逻辑：UPDATE 语句构造与参数转换。
 *
 * 这里**不做任何 I/O**，只把"要改什么"变成"一条参数化 SQL + 一组绑定值"。
 * 这样切开的理由是：注入安全完全取决于这一层——
 * 只要这一层坚持"值永远走 `?`、只有标识符才进 SQL 文本"，
 * 上层怎么调都不会拼出可注入的语句。
 *
 * ===== 为什么值必须参数化，而不是"转义一下再拼" =====
 *
 * 手写转义（把 `'` 变成 `''`）看着能用，但它要求**每一个**值路径都记得转义：
 * 数字、NULL、BLOB 各有各的写法，漏一个就是注入面。
 * 参数化把这件事交给 SQLite 自己：值永远不进入 SQL 文本，
 * 于是"值里带什么字符"从根上不构成问题。
 * 实测依据：绑定 `"1 OR 1=1"` 时，SQLite 把它当成一个普通 TEXT 值去比较，
 * 不会把 `OR` 当语法（见验证用例 h）。
 */

import type { CellValue } from '../../core/resultset'
import { cellValueToSqlParam } from '../../core/resultset'

/**
 * 可以绑定到 SQLite 参数上的值。
 *
 * **没有 boolean**：SQLite 没有布尔类型，`node:sqlite` 绑定 boolean 会直接抛
 * "Provided value cannot be bound to SQLite parameter"（实测）。
 * 所以布尔在这里被显式转成 0/1，见 `toBindValue`。
 */
export type SqliteBind = string | number | null | Uint8Array

/**
 * 构造一行 UPDATE。
 *
 * 输出形如：
 *   UPDATE "users" SET "email" = ? WHERE "id" = ? AND "tenant" = ?
 *
 * - 标识符（表名/列名）走调用方给的 `quote`（即方言的 `quoteIdentifier`），
 *   所以含引号、含点的表名都不会破坏语句结构；
 * - 值只出现 `?`，绑定顺序是**先 SET 后 WHERE**，与 `buildUpdateParams` 严格对应。
 */
export function buildUpdateSql(
  quote: (name: string) => string,
  tableName: string,
  changeColumns: readonly string[],
  keyColumns: readonly string[]
): string {
  const setClause = changeColumns.map((column) => `${quote(column)} = ?`).join(', ')
  const whereClause = keyColumns.map((column) => `${quote(column)} = ?`).join(' AND ')
  return `UPDATE ${quote(tableName)} SET ${setClause} WHERE ${whereClause}`
}

/**
 * 按 `buildUpdateSql` 约定的顺序生成绑定值数组。
 *
 * 顺序错了不会报错，只会**静默改错列**——这类 bug 最难发现，
 * 所以这两个函数放在同一个文件里、紧挨着，改一个就必须看到另一个。
 */
export function buildUpdateParams(
  changes: ReadonlyMap<string, CellValue>,
  keyValues: ReadonlyMap<string, CellValue>
): SqliteBind[] {
  const params: SqliteBind[] = []
  for (const value of changes.values()) params.push(toBindValue(value))
  for (const value of keyValues.values()) params.push(toBindValue(value))
  return params
}

/**
 * `CellValue` → SQLite 可绑定的值。
 *
 * 转换本身复用 core 的 `cellValueToSqlParam`（**规格明确要求**：
 * 测试与实现必须用同一套转换，否则会出现"测试绿但真写错"的假绿）。
 * 这里只做 SQLite 特有的收口：boolean → 0/1。
 *
 * 它还会拒绝被截断的文本/BLOB（抛错）——这是刻意的：
 * 页面只持有前 1000 字符，回写会破坏原值，宁可让这一行失败也不能写坏数据。
 * 抛出的错误由调用方按"行"收集，不影响同一批里的其它行。
 */
export function toBindValue(value: CellValue): SqliteBind {
  if (value.kind === 'boolean') {
    // 布尔在 core 里是合法 CellValue（UI 可能要显示开关），但 SQLite 只认 0/1
    return value.value ? 1 : 0
  }
  return cellValueToSqlParam(value) as SqliteBind
}

/**
 * 校验一次更新请求里的列名，并**规范化成表里的真实列名**。
 *
 * 为什么要先校验而不是交给 SQLite：SQLite 的报错是
 * `no such column: emial`，用户看不出"我该填什么"。
 * 这里直接把可用列列出来——拼错列名是在线编辑里最高频的错误。
 *
 * 为什么按大小写不敏感匹配：SQLite 的标识符本身不区分大小写
 * （`WHERE "ID" = ?` 对列 `id` 是合法的）。若这里严格区分，
 * 就会拒绝一个数据库自己会接受的请求——那是我们自己制造的假错误。
 *
 * ⚠️ `matched` 里同时带回**调用方原始键**（`requested`）与**表内真实列名**（`canonical`），
 * 缺一不可：SQL 文本里必须用真实列名，而取值时必须用调用方原始键
 * （调用方可能传 `ID`，值只存在 `record['ID']` 这个键下）。
 * 只带 `canonical` 会导致取值取空——这个坑我实际踩过一次。
 */
export interface ColumnMatch {
  /** 调用方传来的键名（原样，用于在它的记录里取值）。 */
  readonly requested: string
  /** 表里的真实列名（用于生成 SQL）。 */
  readonly canonical: string
}

export function resolveColumns(
  requested: readonly string[],
  available: readonly string[]
): { readonly matched: readonly ColumnMatch[]; readonly unknown: readonly string[] } {
  const byLower = new Map<string, string>()
  for (const name of available) byLower.set(name.toLowerCase(), name)

  const matched: ColumnMatch[] = []
  const unknown: string[] = []
  for (const name of requested) {
    const actual = byLower.get(name.toLowerCase())
    if (actual === undefined) unknown.push(name)
    else matched.push({ requested: name, canonical: actual })
  }
  return { matched, unknown }
}

/**
 * 从"列名 → 值"的记录里取值。
 *
 * 前面已用 `resolveColumns` 校验过键存在，所以这里是防御性写法：
 * 真取不到时抛出可读错误，而不是把 `undefined` 悄悄塞进绑定参数
 * （绑 undefined 会变成 NULL，等于静默改错数据）。
 */
export function mustGetValue(record: Readonly<Record<string, CellValue>>, key: string): CellValue {
  const value = record[key]
  if (value === undefined) throw new Error(`缺少列「${key}」的值`)
  return value
}
