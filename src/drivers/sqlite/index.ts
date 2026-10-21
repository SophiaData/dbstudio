/**
 * SQLite 驱动出口。
 *
 * `src/drivers/index.ts` 从这里 import `createSqliteAdapter` 与 `SQLITE_INFO`，
 * 两个符号的签名必须与那边的契约一致——它们是「驱动清单只有一个出口」这条规则的落点，
 * 宿主进程、主进程、测试三方拿到的必须是同一份实现。
 */

export { createSqliteAdapter, SqliteAdapterError, SqliteDriverAdapter } from './adapter'
export { SQLITE_DIALECT_ID, sqliteDialect } from './dialect'
export { SQLITE_INFO } from './info'
export { buildUpdateParams, buildUpdateSql, resolveColumns, toBindValue } from './edits'
export type { ColumnMatch, SqliteBind } from './edits'
export {
  buildCountSql,
  buildDeleteParams,
  buildDeleteSql,
  buildInsertParams,
  buildInsertSql,
  normalizeInsertValues
} from './mutations'
export {
  TABLES_FOLDER_ID,
  VIEWS_FOLDER_ID,
  columnObjectId,
  parseObjectId,
  tableObjectId,
  viewObjectId
} from './ids'
export type { GroupFolder, ParsedObjectId } from './ids'
