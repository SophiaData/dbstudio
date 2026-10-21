/**
 * 行插入 / 删除的纯逻辑：SQL 构造与参数顺序。
 *
 * 与 `edits.ts` 同一分工：这里只把"要做什么"变成"参数化 SQL + 绑定值"，
 * 不做任何 I/O。注入安全完全取决于这一层坚持「值永远走 `?`」。
 *
 * 为什么不把这些塞进 `edits.ts`：那个文件的职责是"更新一行"，
 * 而这里是"插入一行 / 删除一行"，生命周期与用途不同。
 * 分开放，读的人一眼能看出哪些函数属于哪条路径。
 */

import type { CellValue } from '../../core/resultset'

import { mustGetValue, resolveColumns, toBindValue, type SqliteBind } from './edits'

/**
 * 构造一条 INSERT。
 *
 * 形如：`INSERT INTO "users" ("email", "name") VALUES (?, ?)`
 *
 * **只列调用方给出的列**，没给的列不出现在语句里——这样数据库才会用
 * 它自己的列默认值 / NULL / 自增。如果强行补一堆 NULL 进去，
 * `DEFAULT` 与自增主键都会被覆盖掉，那是在替用户做错误的决定。
 */
export function buildInsertSql(
  quote: (name: string) => string,
  tableName: string,
  columns: readonly string[]
): string {
  const columnList = columns.map((column) => quote(column)).join(', ')
  const placeholders = columns.map(() => '?').join(', ')
  return `INSERT INTO ${quote(tableName)} (${columnList}) VALUES (${placeholders})`
}

/** INSERT 的绑定值：列顺序必须与 `buildInsertSql` 一致。 */
export function buildInsertParams(columns: readonly string[], values: ReadonlyMap<string, CellValue>): SqliteBind[] {
  return columns.map((column) => toBindValue(mustGetValueRecord(values, column)))
}

/** `ReadonlyMap` 版取值，取不到就抛（绑 undefined 会变 NULL = 静默写错数据）。 */
function mustGetValueRecord(values: ReadonlyMap<string, CellValue>, key: string): CellValue {
  const value = values.get(key)
  if (value === undefined) throw new Error(`缺少列「${key}」的值`)
  return value
}

/**
 * 把调用方给的 `Record<string, CellValue>` 规范化成「表内真实列名 → 值」。
 *
 * 复用 `resolveColumns`：大小写不敏感匹配、未知列被单独列出（供上层拼可读报错）。
 * 返回 Map 而不是对象，是因为 Map 的**插入顺序**就是参数顺序，
 * 而对象键顺序在某些形态下（数字键）会被重排，绑参顺序会悄悄错位。
 */
export function normalizeInsertValues(
  values: Readonly<Record<string, CellValue>>,
  availableColumns: readonly string[]
): { readonly columns: readonly string[]; readonly byColumn: ReadonlyMap<string, CellValue>; readonly unknown: readonly string[] } {
  const requested = Object.keys(values)
  const resolved = resolveColumns(requested, availableColumns)
  const byColumn = new Map<string, CellValue>()
  for (const match of resolved.matched) {
    // 用 mustGetValue 保证"键真的在 values 里"（同 edits.ts 的理由）
    byColumn.set(match.canonical, mustGetValue(values, match.requested))
  }
  return { columns: [...byColumn.keys()], byColumn, unknown: resolved.unknown }
}

/**
 * 构造一条 DELETE。
 *
 * 形如：`DELETE FROM "users" WHERE "id" = ? AND "tenant" = ?`
 *
 * ⚠️ **调用方必须先保证 `keyColumns` 非空**（本函数不做这个判断，
 * 因为空 where 的后果太严重，必须让上层在做"要不要执行"这个决定时
 * 显式地承担它）。适配器里有一道专门的空 keys 检查。
 */
export function buildDeleteSql(
  quote: (name: string) => string,
  tableName: string,
  keyColumns: readonly string[]
): string {
  const whereClause = keyColumns.map((column) => `${quote(column)} = ?`).join(' AND ')
  return `DELETE FROM ${quote(tableName)} WHERE ${whereClause}`
}

/** DELETE 的绑定值：顺序与 `buildDeleteSql` 的占位符一致（只含 WHERE 部分）。 */
export function buildDeleteParams(keyColumns: readonly string[], keys: ReadonlyMap<string, CellValue>): SqliteBind[] {
  return keyColumns.map((column) => toBindValue(mustGetValueRecord(keys, column)))
}

/** 构造 COUNT。表名必须 quote（可以含点号/引号）。 */
export function buildCountSql(quote: (name: string) => string, tableName: string): string {
  return `SELECT COUNT(*) FROM ${quote(tableName)}`
}
