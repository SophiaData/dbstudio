/**
 * MySQL / MariaDB 驱动（P6.2 Step 1：只读与元数据 + 查询执行）。
 *
 * ===== 本阶段的边界 =====
 * 已实现：连接、目录浏览（database → 表/视图 → 列）、表结构元数据
 * （列/主键/索引/外键/唯一/CHECK/触发器）、分页查询、任意语句执行、执行计划、取消。
 * 尚未实现（Step 3）：网格在线编辑、事务、CSV 导入导出、结构编辑 DDL。
 * 未实现的方法明确抛 `unsupported_method`，而不是"半实现"给出错误语义。
 *
 * ===== 为什么不复用 PG/SQLite 的 results.ts =====
 * 各自方言的结果归一化差异太大（类型码、值形态、分页语法），跨驱动 import 会
 * 让实现互相纠缠。需要的只是同一套**契约**（CellValue/ResultPage），不是同一份代码。
 */

import { createConnection, type Connection, type FieldPacket } from 'mysql2/promise'
import type { ConnectionConfig } from '../../core/dialect'
import type { DriverAdapter, SecretValue, TestConnectionResult } from '../../core/driver'
import type { DriverCapabilities, ObjectRef, TableDescription, ColumnDescription } from '../../core/model'
import type {
  CellValue,
  ExplainResult,
  QueryOptions,
  QueryResult,
  ResultColumn,
  ResultPage,
  ResultRow,
  ResultValueType,
  StatementResult
} from '../../core/resultset'
import { MAX_CELL_TEXT_CHARS, MAX_BLOB_PREVIEW_BYTES } from '../../core/resultset'
import { mysqlDialect } from './dialect'
import { MYSQL_INFO } from './info'
import {
  SCHEMAS_FOLDER_ID,
  columnObjectId,
  parseObjectId,
  schemaFolderId,
  schemaObjectId,
  tableObjectId,
  viewObjectId,
  type SchemaFolder
} from './ids'

export class MysqlAdapterError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'MysqlAdapterError'
    this.code = code
  }
}

const MYSQL_CAPABILITIES: DriverCapabilities = {
  hasCatalog: false,
  hasSchema: true,
  supportsServerPagination: true,
  // 用独立连接执行 KILL QUERY，是真取消。
  supportsCancel: true,
  // Step 1 不做网格编辑（applyEdits 未实现），如实声明 false，UI 会据此禁用编辑。
  supportsInlineEdit: false,
  // 只声明**真正读得出来**的元数据。CHECK / 触发器本阶段未实现读取，
  // 如实标 false——否则 UI 会把"读不到"当成"确认没有"，是比缺失更坏的错误。
  metadata: {
    foreignKeys: true,
    indexes: true,
    uniqueConstraints: true,
    checkConstraints: false,
    triggers: false
  }
}

/** 系统库，列表里默认隐藏。 */
const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

interface Cursor {
  readonly sql: string
}

function readOption(config: ConnectionConfig, key: string): string | null {
  const raw = (config.options as Record<string, unknown> | undefined)?.[key]
  if (raw === undefined || raw === null) return null
  return String(raw)
}

/** 去掉末尾分号：派生表包装里子查询不能带分号。 */
function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '')
}

/** 把一条 SELECT 包进派生表做分页。MySQL 派生表必须有别名。 */
function buildPagedSql(sql: string, limit: number, offset: number): string {
  const base = stripTrailingSemicolon(sql)
  // 右括号单独一行：base 若以 `-- 注释` 结尾，`)` 不会被行注释吃掉。
  return `SELECT * FROM (\n${base}\n) AS __dbstudio_page LIMIT ${limit} OFFSET ${offset}`
}

/** MySQL 字段类型码 → 结果值类别。只覆盖常见类型，未知归 'unknown'。 */
function typeCodeToResultType(code: number): ResultValueType {
  switch (code) {
    case 0: // DECIMAL
    case 246: // NEWDECIMAL
      return 'real'
    case 1: // TINY
    case 2: // SHORT
    case 3: // LONG
    case 8: // BIGINT
    case 9: // INT24
    case 13: // YEAR
    case 16: // BIT
      return 'integer'
    case 4: // FLOAT
    case 5: // DOUBLE
      return 'real'
    case 7: // TIMESTAMP
    case 10: // DATE
    case 11: // TIME
    case 12: // DATETIME
      return 'date'
    case 15: // VARCHAR
    case 253: // VAR_STRING
    case 254: // STRING
      return 'text'
    case 249: // TINY_BLOB
    case 250: // MEDIUM_BLOB
    case 251: // LONG_BLOB
    case 252: // BLOB
      return 'blob'
    default:
      return 'unknown'
  }
}

/** MySQL 原始值 → 线上 CellValue。大文本/BLOB 截断保护 IPC。 */
function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return { kind: 'null' }
  if (Buffer.isBuffer(value)) {
    const truncated = value.length > MAX_BLOB_PREVIEW_BYTES
    const preview = truncated ? value.subarray(0, MAX_BLOB_PREVIEW_BYTES) : value
    return { kind: 'blob', previewBase64: preview.toString('base64'), length: value.length, truncated }
  }
  if (typeof value === 'bigint') return { kind: 'text', text: value.toString() }
  if (typeof value === 'number') return { kind: 'number', value }
  if (typeof value === 'boolean') return { kind: 'boolean', value }
  if (value instanceof Date) return { kind: 'text', text: value.toISOString() }
  const text = String(value)
  if (text.length > MAX_CELL_TEXT_CHARS) {
    return { kind: 'text', text: text.slice(0, MAX_CELL_TEXT_CHARS), truncated: true, fullLength: text.length }
  }
  return { kind: 'text', text }
}

function buildColumns(fields: readonly FieldPacket[]): ResultColumn[] {
  return fields.map((f) => ({ name: f.name, type: typeCodeToResultType(f.type ?? 0) }))
}

function buildRows(rows: readonly unknown[][], offset: number): ResultRow[] {
  return rows.map((cells, i) => ({ index: offset + i, cells: cells.map(toCellValue) }))
}

function normalizeLimit(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return 100
  return Math.floor(v)
}
function normalizeOffset(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v < 0) return 0
  return Math.floor(v)
}

export class MysqlDriverAdapter implements DriverAdapter {
  readonly dialect = mysqlDialect
  readonly info = MYSQL_INFO

  #conn: Connection | null = null
  #config: ConnectionConfig | null = null
  #secret: SecretValue = {}
  #database: string | null = null
  #cursors = new Map<string, Cursor>()
  #nextCursor = 1

  #requireConn(): Connection {
    if (this.#conn === null) throw new MysqlAdapterError('not_connected', 'MySQL 连接尚未建立')
    return this.#conn
  }

  async connect(config: ConnectionConfig, secret: SecretValue): Promise<DriverCapabilities> {
    const host = readOption(config, 'host') ?? '127.0.0.1'
    const port = Number(readOption(config, 'port') ?? 3306)
    const database = readOption(config, 'database') ?? undefined
    const user = readOption(config, 'user') ?? 'root'
    const password = secret?.dbPassword ?? ''
    try {
      this.#conn = await createConnection({
        host,
        port,
        user,
        password,
        ...(database === undefined ? {} : { database }),
        // 注意：**不**在这里设 rowsAsArray。元数据查询需要对象行（按列名取），
        // 只有 query/fetchResultPage 这类结果集查询才按需用 { rowsAsArray: true }。
        // DATE/DATETIME 直接返回字符串，避免本地时区把时间"挪"了。
        dateStrings: true,
        // 大整数按字符串返回，避免 JS number 精度丢失。
        supportBigNumbers: true,
        bigNumberStrings: true,
        // 一次只跑一条语句：多语句交给上层脚本切分器，驱动不猜。
        multipleStatements: false
      })
      this.#database = database ?? null
      this.#config = config
      this.#secret = secret
      return MYSQL_CAPABILITIES
    } catch (thrown) {
      throw new MysqlAdapterError('connection_failed', `无法连接到 MySQL ${host}:${port}：${describeThrown(thrown)}`)
    }
  }

  async disconnect(): Promise<void> {
    const conn = this.#conn
    this.#conn = null
    this.#cursors.clear()
    if (conn) {
      try {
        await conn.end()
      } catch {
        // 断开失败不抛：可能对端已关。
      }
    }
  }

  async testConnection(config: ConnectionConfig, secret: SecretValue): Promise<TestConnectionResult> {
    const startedAt = performance.now()
    let probe: Connection | null = null
    try {
      const host = readOption(config, 'host') ?? '127.0.0.1'
      const port = Number(readOption(config, 'port') ?? 3306)
      const database = readOption(config, 'database') ?? undefined
      const user = readOption(config, 'user') ?? 'root'
      probe = await createConnection({
        host,
        port,
        user,
        password: secret?.dbPassword ?? '',
        ...(database === undefined ? {} : { database }),
        connectTimeout: 8000
      })
      const [rows] = await probe.query('SELECT VERSION() AS v')
      const raw = Array.isArray(rows) && rows.length > 0 ? (rows[0] as Record<string, unknown>) : null
      const version = raw && typeof raw.v === 'string' ? raw.v : undefined
      return { ok: true, elapsedMs: Math.round(performance.now() - startedAt), ...(version ? { serverVersion: `MySQL ${version}` } : {}) }
    } catch (thrown) {
      return { ok: false, message: describeThrown(thrown), elapsedMs: Math.round(performance.now() - startedAt) }
    } finally {
      if (probe) await probe.end().catch(() => undefined)
    }
  }

  async listChildren(parentId: string | null): Promise<ObjectRef[]> {
    const conn = this.#requireConn()
    if (parentId === null) {
      return [{ id: SCHEMAS_FOLDER_ID, kind: 'folder', name: '数据库', parentId: null, hasChildren: true }]
    }
    const parsed = parseObjectId(parentId)
    if (parsed === null) throw new MysqlAdapterError('object_not_found', `无法识别的对象 id：${parentId}`)
    switch (parsed.kind) {
      case 'schemas-folder':
        return this.#listSchemas(conn)
      case 'schema':
        return [
          { id: schemaFolderId(parsed.schema, 'tables'), kind: 'folder', name: '表', parentId, hasChildren: true },
          { id: schemaFolderId(parsed.schema, 'views'), kind: 'folder', name: '视图', parentId, hasChildren: true }
        ]
      case 'folder':
        return this.#listRelations(conn, parsed.schema, parsed.folder)
      case 'table':
        return this.#listColumns(conn, parsed.schema, parsed.name, tableObjectId(parsed.schema, parsed.name))
      case 'view':
        return this.#listColumns(conn, parsed.schema, parsed.name, viewObjectId(parsed.schema, parsed.name))
      case 'column':
        return []
    }
  }

  async #listSchemas(conn: Connection): Promise<ObjectRef[]> {
    const [rows] = await conn.query(
      'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME'
    )
    return (rows as unknown as { name: string }[])
      .filter((r) => !SYSTEM_SCHEMAS.has(r.name))
      .map((r) => ({
        id: schemaObjectId(r.name),
        kind: 'schema' as const,
        name: r.name,
        parentId: SCHEMAS_FOLDER_ID,
        hasChildren: true
      }))
  }

  async #listRelations(conn: Connection, schema: string, folder: SchemaFolder): Promise<ObjectRef[]> {
    const tableType = folder === 'tables' ? 'BASE TABLE' : 'VIEW'
    const [rows] = await conn.query(
      'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ? ORDER BY TABLE_NAME',
      [schema, tableType]
    )
    const kind = folder === 'tables' ? 'table' : 'view'
    return (rows as unknown as { name: string }[]).map((r) => ({
      id: folder === 'tables' ? tableObjectId(schema, r.name) : viewObjectId(schema, r.name),
      kind,
      name: r.name,
      parentId: schemaFolderId(schema, folder),
      hasChildren: true
    }))
  }

  async #listColumns(conn: Connection, schema: string, table: string, parentNodeId: string): Promise<ObjectRef[]> {
    const [rows] = await conn.query(
      'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS typeName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [schema, table]
    )
    return (rows as unknown as { name: string; typeName: string }[]).map((r) => ({
      id: columnObjectId(schema, table, r.name),
      kind: 'column' as const,
      name: r.name,
      parentId: parentNodeId,
      hasChildren: false,
      meta: { typeName: r.typeName }
    }))
  }

  /** 按对象 id 生成限定到 database 的 SELECT（`\`db\`.\`name\``）。 */
  async tableSelectSql(nodeId: string): Promise<string> {
    const parsed = parseObjectId(nodeId)
    if (parsed === null || (parsed.kind !== 'table' && parsed.kind !== 'view')) {
      throw new MysqlAdapterError('object_not_found', `tableSelectSql 只接受表或视图节点：${nodeId}`)
    }
    return `SELECT * FROM ${mysqlDialect.quoteIdentifier(parsed.schema)}.${mysqlDialect.quoteIdentifier(parsed.name)}`
  }

  async describeTable(id: string): Promise<TableDescription> {
    const conn = this.#requireConn()
    const parsed = parseObjectId(id)
    if (parsed === null || (parsed.kind !== 'table' && parsed.kind !== 'view')) {
      throw new MysqlAdapterError('object_not_found', `describeTable 只接受表或视图节点，收到的 id 是：${id}`)
    }
    const columns = await this.#readColumns(conn, parsed.schema, parsed.name)
    const canonicalId = parsed.kind === 'table' ? tableObjectId(parsed.schema, parsed.name) : viewObjectId(parsed.schema, parsed.name)
    const description: TableDescription = {
      id: canonicalId,
      columns,
      hasUniqueKey: columns.some((c) => c.primaryKeyOrdinal !== null)
    }
    return this.#withMetadata(conn, parsed.schema, parsed.name, description)
  }

  async #readColumns(conn: Connection, schema: string, table: string): Promise<ColumnDescription[]> {
    // 主键列与序号：KEY_COLUMN_USAGE 里 CONSTRAINT_NAME='PRIMARY'。
    const [pkRows] = await conn.query(
      `SELECT COLUMN_NAME AS name, ORDINAL_POSITION AS pos
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
        ORDER BY ORDINAL_POSITION`,
      [schema, table]
    )
    const pkOrdinal = new Map<string, number>()
    for (const r of pkRows as unknown as { name: string; pos: number }[]) pkOrdinal.set(r.name, Number(r.pos))

    const [colRows] = await conn.query(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS typeName, IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS defaultValue, EXTRA AS extra
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [schema, table]
    )
    return (colRows as unknown as {
      name: string
      typeName: string
      nullable: string
      defaultValue: string | null
      extra: string
    }[]).map((r) => {
      const extra = (r.extra ?? '').toLowerCase()
      const identity: ColumnDescription['identity'] = extra.includes('auto_increment')
        ? 'by-default'
        : null
      return {
        name: r.name,
        typeName: r.typeName,
        nullable: r.nullable === 'YES',
        primaryKeyOrdinal: pkOrdinal.get(r.name) ?? null,
        defaultValue: r.defaultValue,
        identity
      }
    })
  }

  /**
   * 追加结构元数据。失败时整块省略（与 PG/SQLite 同一原则）：
   * 元数据读不到只影响 ER 图/约束展示，不该让整张表打不开。
   */
  async #withMetadata(
    conn: Connection,
    schema: string,
    table: string,
    description: TableDescription
  ): Promise<TableDescription> {
    try {
      const [idxRows] = await conn.query(
        `SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName,
                SEQ_IN_INDEX AS seq
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME <> 'PRIMARY'
          ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [schema, table]
      )
      const indexMap = new Map<string, { name: string; unique: boolean; columns: string[] }>()
      for (const r of idxRows as unknown as { indexName: string; nonUnique: number; columnName: string | null }[]) {
        const cur = indexMap.get(r.indexName) ?? { name: r.indexName, unique: Number(r.nonUnique) === 0, columns: [] }
        if (r.columnName !== null) cur.columns.push(r.columnName)
        indexMap.set(r.indexName, cur)
      }
      const indexes = [...indexMap.values()].map((i) => ({ name: i.name, unique: i.unique, columns: i.columns, predicate: null, expression: null }))

      const [fkRows] = await conn.query(
        `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS columnName, k.ORDINAL_POSITION AS pos,
                k.REFERENCED_TABLE_SCHEMA AS refSchema, k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refColumn
           FROM information_schema.KEY_COLUMN_USAGE k
          WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        [schema, table]
      )
      const fkMap = new Map<string, { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[] }>()
      for (const r of fkRows as unknown as { name: string; columnName: string; refSchema: string; refTable: string; refColumn: string }[]) {
        const cur = fkMap.get(r.name) ?? { name: r.name, columns: [], refSchema: r.refSchema, refTable: r.refTable, refColumns: [] }
        cur.columns.push(r.columnName)
        cur.refColumns.push(r.refColumn)
        fkMap.set(r.name, cur)
      }
      const foreignKeys = [...fkMap.values()].map((f) => ({
        name: f.name,
        columns: f.columns,
        referencedSchema: f.refSchema,
        referencedTable: f.refTable,
        referencedColumns: f.refColumns,
        onUpdate: null,
        onDelete: null
      }))

      // 唯一约束从"唯一索引"派生（MySQL 里 UNIQUE KEY 就是唯一索引）。
      const uniqueConstraints = [...indexMap.values()]
        .filter((i) => i.unique)
        .map((i) => ({ name: i.name, columns: i.columns }))
      return { ...description, indexes, foreignKeys, uniqueConstraints }
    } catch (thrown) {
      if (thrown instanceof MysqlAdapterError) throw thrown
      return description
    }
  }

  async query(sql: string, options?: QueryOptions): Promise<QueryResult> {
    const conn = this.#requireConn()
    const limit = normalizeLimit(options?.limit)
    const offset = normalizeOffset(options?.offset)
    const executedSql = buildPagedSql(sql, limit, offset)
    const startedAt = performance.now()
    const [rows, fields] = await conn.query({ sql: executedSql, rowsAsArray: true })
    const elapsedMs = Math.round(performance.now() - startedAt)
    const rawRows = rows as unknown as unknown[][]
    const cursorId = options?.keepCursor === false ? null : this.#openCursor(sql)
    return {
      columns: buildColumns(fields ?? []),
      rows: buildRows(rawRows, offset),
      offset,
      returned: rawRows.length,
      hasMore: rawRows.length === limit,
      cursorId,
      executedSql,
      elapsedMs
    }
  }

  async fetchResultPage(cursorId: string, offset: number, limit: number): Promise<ResultPage> {
    const conn = this.#requireConn()
    const cursor = this.#cursors.get(cursorId)
    if (!cursor) throw new MysqlAdapterError('object_not_found', `未知游标：${cursorId}`)
    const off = normalizeOffset(offset)
    const lim = normalizeLimit(limit)
    const executedSql = buildPagedSql(cursor.sql, lim, off)
    const [rows, fields] = await conn.query({ sql: executedSql, rowsAsArray: true })
    const rawRows = rows as unknown as unknown[][]
    return {
      columns: buildColumns(fields ?? []),
      rows: buildRows(rawRows, off),
      offset: off,
      returned: rawRows.length,
      hasMore: rawRows.length === lim
    }
  }

  async closeCursor(cursorId: string): Promise<void> {
    this.#cursors.delete(cursorId)
  }

  #openCursor(sql: string): string {
    const id = `mysql-cursor-${this.#nextCursor++}`
    this.#cursors.set(id, { sql })
    return id
  }

  async executeStatement(sql: string, options?: QueryOptions): Promise<StatementResult> {
    const conn = this.#requireConn()
    const startedAt = performance.now()
    void startedAt
    const [rows, fields] = await conn.query({ sql: stripTrailingSemicolon(sql), rowsAsArray: true })
    // SELECT / SHOW / 返回结果集的语句：rows 是数组。
    if (Array.isArray(rows) && Array.isArray(fields) && fields.length > 0) {
      const rawRows = rows as unknown as unknown[][]
      return {
        kind: 'rows',
        result: {
          columns: buildColumns(fields),
          rows: buildRows(rawRows, 0),
          offset: 0,
          returned: rawRows.length,
          hasMore: false,
          cursorId: this.#openCursor(sql),
          executedSql: sql,
          elapsedMs: Math.round(performance.now() - startedAt)
        }
      }
    }
    // DML / DDL：rows 是 ResultSetHeader（有 affectedRows）。
    const header = rows as unknown as { affectedRows?: number; insertId?: number }
    void options
    return {
      kind: 'affected',
      affected: Number(header?.affectedRows ?? 0),
      // Step 1 不使用事务；这些字段如实反映"无用户事务、自动提交"。
      inTransaction: false,
      transactionState: { active: false, pendingAffected: 0 },
      executedSql: sql,
      elapsedMs: Math.round(performance.now() - startedAt)
    }
  }

  async explain(sql: string): Promise<ExplainResult> {
    const conn = this.#requireConn()
    const executedSql = this.dialect.buildExplainQuery(stripTrailingSemicolon(sql))
    const [rows, fields] = await conn.query({ sql: executedSql, rowsAsArray: true })
    const rawRows = rows as unknown as unknown[][]
    return {
      dialectId: this.dialect.id,
      columns: buildColumns(fields ?? []),
      rows: buildRows(rawRows, 0),
      format: 'tabular',
      executedSql
    }
  }

  async cancelQuery(): Promise<boolean> {
    const conn = this.#conn
    const config = this.#config
    if (conn === null || config === null) return false
    const threadId = conn.threadId
    if (typeof threadId !== 'number') return false
    // 用**独立连接**执行 KILL QUERY：主连接正忙着跑那条查询，在它上面发只会排队。
    let killer: Connection | null = null
    try {
      killer = await createConnection({
        host: readOption(config, 'host') ?? '127.0.0.1',
        port: Number(readOption(config, 'port') ?? 3306),
        user: readOption(config, 'user') ?? 'root',
        password: this.#secret?.dbPassword ?? '',
        connectTimeout: 5000
      })
      await killer.query(`KILL QUERY ${threadId}`)
      return true
    } catch {
      return false
    } finally {
      if (killer) await killer.end().catch(() => undefined)
    }
  }

  // ===== 以下为 Step 3（写入 / 事务 / 传输 / DDL）未实现部分 =====
  // 明确抛 unsupported_method，而非半实现给出错误语义。

  #unsupported(method: string): never {
    throw new MysqlAdapterError(
      'unsupported_method',
      `MySQL 驱动当前版本暂不支持「${method}」（只读 + 元数据阶段）。写入/事务/导入导出在后续阶段提供。`
    )
  }

  async applyEdits(): Promise<never> {
    this.#unsupported('网格编辑')
  }
  async insertRow(): Promise<never> {
    this.#unsupported('插入行')
  }
  async deleteRows(): Promise<never> {
    this.#unsupported('删除行')
  }
  async commitTransaction(): Promise<never> {
    this.#unsupported('提交事务')
  }
  async rollbackTransaction(): Promise<never> {
    this.#unsupported('回滚事务')
  }
  async transactionState(): Promise<never> {
    this.#unsupported('事务状态')
  }
  async importBatch(): Promise<never> {
    this.#unsupported('CSV 导入')
  }
  async countRows(): Promise<never> {
    this.#unsupported('行数统计')
  }
  async fetchCellValue(): Promise<never> {
    this.#unsupported('取完整单元格值')
  }
  async createTable(): Promise<never> {
    this.#unsupported('建表')
  }
  async dropTable(): Promise<never> {
    this.#unsupported('删表')
  }
  async createView(): Promise<never> {
    this.#unsupported('建视图')
  }
  async dropView(): Promise<never> {
    this.#unsupported('删视图')
  }
  async renameTable(): Promise<never> {
    this.#unsupported('重命名表')
  }
}

function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message
  return String(thrown)
}

export function createMysqlAdapter(): DriverAdapter {
  return new MysqlDriverAdapter()
}
