/**
 * MySQL / MariaDB 驱动出口。注册到 `src/drivers/index.ts` 后全链路生效。
 */

export { createMysqlAdapter, MysqlAdapterError, MysqlDriverAdapter } from './adapter'
export { MYSQL_DIALECT_ID, mysqlDialect } from './dialect'
export { MYSQL_INFO } from './info'
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
