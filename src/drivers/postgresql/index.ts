/**
 * PostgreSQL 驱动出口。
 *
 * `src/drivers/index.ts` 从这里 import `createPostgresAdapter` 与 `POSTGRESQL_INFO`，
 * 两个符号的签名必须与那边的契约一致——它们是「驱动清单只有一个出口」这条规则的落点，
 * 宿主进程、主进程、测试三方拿到的必须是同一份实现。
 *
 * ⚠️ 本文件会 import `adapter.ts`（连带 `pg`），**只能被驱动宿主进程与适配器测试 import**。
 * 主进程走的是纯数据通道 `dialect-metadata.ts`（只 import `info.ts`），
 * 绝不能从主进程 import 本文件，否则 `pg` 会被打进主进程 bundle，进程隔离失效。
 */

export { createPostgresAdapter, PostgresDriverAdapter } from './adapter'
export { POSTGRESQL_DIALECT_ID, postgresqlDialect } from './dialect'
export { POSTGRESQL_INFO } from './info'
export { PostgresAdapterError, describeThrown, mapPgErrorCode, wrapPgError } from './errors'
export {
  buildDelete,
  buildInsert,
  buildUpdate,
  normalizeValues,
  resolveColumns,
  toBindValue
} from './edits'
export type { BuiltStatement, ColumnMatch, PostgresBind } from './edits'
export {
  buildCreateTableSql,
  buildCreateViewSql,
  buildDropTableSql,
  buildDropViewSql,
  buildRenameTableSql,
  describeAllowedTypes,
  normalizeDefaultValue,
  normalizeTypeName
} from './ddl'
export {
  SCHEMAS_FOLDER_ID,
  columnObjectId,
  parseObjectId,
  schemaFolderId,
  schemaObjectId,
  tableObjectId,
  viewObjectId
} from './ids'
export type { ParsedObjectId, SchemaFolder } from './ids'
export {
  buildColumns,
  buildGrid,
  buildPagedSql,
  normalizePageSize,
  normalizeOffset,
  prepareReadOnlyStatement,
  toCellValue,
  toFullCellValue
} from './results'
