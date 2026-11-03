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
import type { Duplex } from 'node:stream'
import type { ConnectionConfig } from '../../core/dialect'
import type {
  ConnectionTestCheck,
  ConnectionTestStage,
  DriverAdapter,
  RoutineInfo,
  SecretValue,
  SshHostKeyCheck,
  TestConnectionResult
} from '../../core/driver'
import type { DriverCapabilities, ObjectRef, TableCreateSpec, TableDescription, ColumnDescription } from '../../core/model'
import type {
  CellValue,
  EditApplyResult,
  ExplainResult,
  QueryOptions,
  QueryResult,
  ResultColumn,
  ResultPage,
  ResultRow,
  ResultValueType,
  RowEditOutcome,
  RowUpdate,
  SqlParameterValue,
  StatementResult,
  TransactionState
} from '../../core/resultset'
import { MAX_CELL_TEXT_CHARS, MAX_BLOB_PREVIEW_BYTES, cellValueToSqlParam } from '../../core/resultset'
import { bindSqlParameters } from '../../core/sql-parameters'
import type { ImportBatch, ImportBatchResult, TransferSourceResolution } from '../../core/transfer'
import {
  openSshTunnel,
  SshTunnelError,
  type SshCredentials,
  type SshTunnel,
  type SshTunnelConfig
} from '../ssh-tunnel'
import { mysqlDialect } from './dialect'
import {
  buildCreateTableSql,
  buildCreateViewSql,
  buildDropTableSql,
  buildDropViewSql,
  buildRenameTableSql
} from './ddl'
import { MysqlAdapterError } from './errors'
import { MYSQL_INFO } from './info'
import {
  DEFAULT_MYSQL_SSL_MODE,
  isMysqlSslMode,
  planMysqlSsl,
  type MysqlSslMode,
  type MysqlSslOptions
} from './ssl'
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

export { MysqlAdapterError } from './errors'

const MYSQL_CAPABILITIES: DriverCapabilities = {
  hasCatalog: false,
  hasSchema: true,
  supportsServerPagination: true,
  // 用独立连接执行 KILL QUERY，是真取消。
  supportsCancel: true,
  // Step 3 已实现主键编辑/插入/删除（事务内），可按行编辑。
  supportsInlineEdit: true,
  // 如实声明**真正读得出来**的元数据。MySQL 8.0.16+ 与 MariaDB 10.2+
  // 都提供 information_schema.CHECK_CONSTRAINTS / TRIGGERS。
  metadata: {
    foreignKeys: true,
    indexes: true,
    uniqueConstraints: true,
    checkConstraints: true,
    triggers: true
  }
}

/** 系统库，列表里默认隐藏。 */
const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

interface Cursor {
  readonly sql: string;
  /** 绑定参数。分页取数与「取完整值」都要原样重放。 */
  readonly params: readonly SqlParameterValue[]
}

/**
 * Uint8Array → Buffer：mysql2 只认 Buffer 作为二进制参数。
 *
 * 绑定层为了跨 IPC 可序列化，统一用 Uint8Array；到了真正发查询前再转。
 */
function toMysqlParams(values: readonly SqlParameterValue[]): unknown[] {
  return values.map((value) => (value instanceof Uint8Array ? Buffer.from(value) : value))
}

function readOption(config: ConnectionConfig, key: string): string | null {
  const raw = (config.options as Record<string, unknown> | undefined)?.[key]
  if (raw === undefined || raw === null) return null
  return String(raw)
}

/** 读取字符串选项；缺失统一成空串（比 null 少一层判空）。 */
function readOptionString(config: ConnectionConfig, key: string): string {
  return readOption(config, key)?.trim() ?? ''
}

/** 连接参数（已解析、已验证），connect / testConnection / cancel 共用。 */
interface ResolvedMysqlConnection {
  readonly host: string
  readonly port: number
  readonly database: string | undefined
  readonly user: string
  readonly password: string
  readonly ssl: MysqlSslOptions | undefined
  readonly ssh: SshTunnelConfig | undefined
  readonly sshCredentials: SshCredentials | undefined
}

function resolveConnectionInfo(config: ConnectionConfig, secret: SecretValue): ResolvedMysqlConnection {
  const host = readOptionString(config, 'host') || '127.0.0.1'
  const portRaw = readOptionString(config, 'port')
  const port = portRaw === '' ? 3306 : Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new MysqlAdapterError('connection_failed', `连接「${config.name}」的端口非法：${portRaw}（应为 1-65535 的整数）。`)
  }
  const database = readOptionString(config, 'database')
  if (database === '') {
    throw new MysqlAdapterError('connection_failed', `连接「${config.name}」缺少数据库名（database）。`)
  }
  const user = readOptionString(config, 'user') || 'root'
  const password = secret.dbPassword ?? ''

  const sslModeRaw = readOptionString(config, 'sslmode')
  const sslMode: MysqlSslMode =
    sslModeRaw === ''
      ? DEFAULT_MYSQL_SSL_MODE
      : isMysqlSslMode(sslModeRaw)
        ? sslModeRaw
        : (() => {
            throw new MysqlAdapterError(
              'connection_failed',
              `SSL 模式非法：${sslModeRaw}。可选值：disable / require / verify-ca / verify-full。`
            )
          })()
  const caPath = readOptionString(config, 'sslrootcert')
  let ssl: MysqlSslOptions | undefined
  try {
    ssl = planMysqlSsl(sslMode, caPath === '' ? undefined : caPath)
  } catch (thrown) {
    throw new MysqlAdapterError('connection_failed', describeThrown(thrown))
  }

  /*
   * SSH 隧道。`sshHost` 留空即不启用——与 PostgreSQL 驱动同一约定，
   * 表单里的其它 SSH 字段不会误触发隧道。
   */
  const sshHost = readOptionString(config, 'sshHost')
  let ssh: SshTunnelConfig | undefined
  if (sshHost !== '') {
    const sshUser = readOptionString(config, 'sshUser')
    if (sshUser === '') {
      throw new MysqlAdapterError('connection_failed', '启用 SSH 隧道时必须填写 SSH 用户名（sshUser）。')
    }
    const sshPortRaw = readOptionString(config, 'sshPort')
    const sshPort = sshPortRaw === '' ? 22 : Number(sshPortRaw)
    if (!Number.isInteger(sshPort) || sshPort <= 0 || sshPort > 65535) {
      throw new MysqlAdapterError('connection_failed', `SSH 端口非法：${sshPortRaw}（应为 1-65535 的整数）。`)
    }
    const targetHostRaw = readOptionString(config, 'sshTargetHost')
    const targetPortRaw = readOptionString(config, 'sshTargetPort')
    const targetPort = targetPortRaw === '' ? port : Number(targetPortRaw)
    if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
      throw new MysqlAdapterError('connection_failed', `SSH 目标数据库端口非法：${targetPortRaw}（应为 1-65535 的整数）。`)
    }
    const privateKeyPath = readOptionString(config, 'sshPrivateKey')
    const hostKeySha256 = readOptionString(config, 'sshHostKeySha256')
    ssh = {
      host: sshHost,
      port: sshPort,
      username: sshUser,
      privateKeyPath: privateKeyPath === '' ? undefined : privateKeyPath,
      hostKeySha256: hostKeySha256 === '' ? undefined : hostKeySha256,
      targetHost: targetHostRaw === '' ? host : targetHostRaw,
      targetPort
    }
  }

  return {
    host,
    port,
    database,
    user,
    password,
    ssl,
    ssh,
    sshCredentials:
      ssh === undefined
        ? undefined
        : { password: secret.sshPassword, privateKeyPassphrase: secret.sshPassphrase }
  }
}

function toSshHostKeyCheck(ssh: SshTunnelConfig, error: SshTunnelError): SshHostKeyCheck | undefined {
  if (error.code !== 'ssh_host_unverified' && error.code !== 'ssh_host_key_mismatch') return undefined
  return {
    host: ssh.host,
    port: ssh.port,
    fingerprint: error.hostKeySha256 ?? '',
    ...(error.expectedHostKeySha256 === undefined ? {} : { expectedFingerprint: error.expectedHostKeySha256 }),
    state: error.code === 'ssh_host_unverified' ? 'unverified' : 'mismatch'
  }
}

function recordCheck(
  checks: ConnectionTestCheck[],
  stage: ConnectionTestStage,
  status: 'passed' | 'failed' | 'skipped',
  message?: string,
  elapsedMs?: number
): void {
  checks.push({ stage, status, ...(message === undefined ? {} : { message }), ...(elapsedMs === undefined ? {} : { elapsedMs }) })
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
  /** 是否处于由本驱动开启的事务中（executeStatement 手动 BEGIN 不在此跟踪，见注） */
  #inTransaction = false
  /** 事务内累计影响行数 */
  #pendingAffected = 0
  #database: string | null = null
  /** 已解析的连接参数，取消查询时要用同一套 SSL / 隧道设置。 */
  #info: ResolvedMysqlConnection | null = null
  #tunnel: SshTunnel | null = null
  #cursors = new Map<string, Cursor>()
  #nextCursor = 1

  #requireConn(): Connection {
    if (this.#conn === null) throw new MysqlAdapterError('not_connected', 'MySQL 连接尚未建立')
    return this.#conn
  }

  /**
   * 建一条 mysql2 连接。SSH 隧道启用时，先开一条通道把它当 `stream` 交给 mysql2。
   *
   * 每次调用都可能新开一条 channel（取消查询也要一条），所以隧道实例
   * 由 adapter 持有并复用，`disconnect()` 时统一关闭。
   */
  async #openConnection(info: ResolvedMysqlConnection, connectTimeout?: number): Promise<Connection> {
    let stream: Duplex | undefined
    if (info.ssh !== undefined) {
      if (this.#tunnel === null) {
        this.#tunnel = await openSshTunnel(
          info.ssh,
          info.sshCredentials ?? { password: undefined, privateKeyPassphrase: undefined }
        )
      }
      stream = await this.#tunnel.forward()
    }
    return createConnection({
      host: info.host,
      port: info.port,
      user: info.user,
      password: info.password,
      ...(info.database === undefined ? {} : { database: info.database }),
      ...(info.ssl === undefined ? {} : { ssl: info.ssl }),
      ...(stream === undefined ? {} : { stream }),
      ...(connectTimeout === undefined ? {} : { connectTimeout }),
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
  }

  async connect(config: ConnectionConfig, secret: SecretValue): Promise<DriverCapabilities> {
    try {
      const info = resolveConnectionInfo(config, secret)
      this.#conn = await this.#openConnection(info)
      this.#info = info
      this.#database = info.database ?? null
      return MYSQL_CAPABILITIES
    } catch (thrown) {
      // 连接失败时不要留下半开的隧道。
      const tunnel = this.#tunnel
      this.#tunnel = null
      if (tunnel !== null) await tunnel.close().catch(() => undefined)
      if (thrown instanceof MysqlAdapterError) throw thrown
      throw new MysqlAdapterError('connection_failed', `无法连接到 MySQL：${describeThrown(thrown)}`)
    }
  }

  async disconnect(): Promise<void> {
    const conn = this.#conn
    const tunnel = this.#tunnel
    this.#conn = null
    this.#info = null
    this.#tunnel = null
    this.#cursors.clear()
    if (conn) {
      try {
        await conn.end()
      } catch {
        // 断开失败不抛：可能对端已关。
      }
    }
    if (tunnel !== null) {
      try {
        await tunnel.close()
      } catch {
        // 隧道关闭失败同样不阻塞断开。
      }
    }
  }

  async testConnection(config: ConnectionConfig, secret: SecretValue): Promise<TestConnectionResult> {
    const startedAt = performance.now()
    const checks: ConnectionTestCheck[] = []
    let info: ResolvedMysqlConnection | null = null
    let probe: Connection | null = null
    let tunnel: SshTunnel | null = null
    try {
      info = resolveConnectionInfo(config, secret)
      recordCheck(checks, 'config', 'passed', '连接参数解析通过')

      let stream: Duplex | undefined
      if (info.ssh !== undefined) {
        const sshStartedAt = performance.now()
        tunnel = await openSshTunnel(
          info.ssh,
          info.sshCredentials ?? { password: undefined, privateKeyPassphrase: undefined }
        )
        stream = await tunnel.forward()
        recordCheck(checks, 'ssh_connect', 'passed', `SSH 已连接 ${info.ssh.host}:${info.ssh.port}`, Math.round(performance.now() - sshStartedAt))
        recordCheck(checks, 'ssh_host_key', 'passed', 'SSH 主机密钥与已保存指纹一致')
        recordCheck(checks, 'ssh_auth', 'passed', 'SSH 认证通过')
        recordCheck(checks, 'ssh_forward', 'passed', `SSH 转发通道可用，目标 ${info.ssh.targetHost}:${info.ssh.targetPort}`)
      } else {
        recordCheck(checks, 'ssh_connect', 'skipped', '未启用 SSH 隧道')
        recordCheck(checks, 'ssh_host_key', 'skipped', '未启用 SSH 隧道')
        recordCheck(checks, 'ssh_auth', 'skipped', '未启用 SSH 隧道')
        recordCheck(checks, 'ssh_forward', 'skipped', '未启用 SSH 隧道')
      }

      const databaseStartedAt = performance.now()
      probe = await createConnection({
        host: info.host,
        port: info.port,
        user: info.user,
        password: info.password,
        ...(info.database === undefined ? {} : { database: info.database }),
        ...(info.ssl === undefined ? {} : { ssl: info.ssl }),
        ...(stream === undefined ? {} : { stream }),
        connectTimeout: 8000
      })
      recordCheck(
        checks,
        'database',
        'passed',
        `已连接数据库 ${info.host}:${info.port}/${info.database ?? ''}`,
        Math.round(performance.now() - databaseStartedAt)
      )

      const queryStartedAt = performance.now()
      const [rows] = await probe.query('SELECT VERSION() AS v')
      recordCheck(checks, 'server_query', 'passed', '服务端探测查询通过', Math.round(performance.now() - queryStartedAt))
      const raw = Array.isArray(rows) && rows.length > 0 ? (rows[0] as Record<string, unknown>) : null
      const version = raw && typeof raw.v === 'string' ? raw.v : undefined
      return {
        ok: true,
        elapsedMs: Math.round(performance.now() - startedAt),
        checks,
        ...(version ? { serverVersion: `MySQL ${version}` } : {})
      }
    } catch (thrown) {
      let failedStage: ConnectionTestStage =
        probe !== null ? 'server_query' : info === null ? 'config' : info.ssh !== undefined && tunnel === null ? 'ssh_connect' : 'database'
      let sshHostKey: SshHostKeyCheck | undefined
      const message = describeThrown(thrown)
      if (thrown instanceof SshTunnelError) {
        failedStage =
          thrown.code === 'ssh_host_unverified' || thrown.code === 'ssh_host_key_mismatch'
            ? 'ssh_host_key'
            : thrown.code === 'ssh_auth_failed' || thrown.code === 'ssh_missing_credentials'
              ? 'ssh_auth'
              : 'ssh_connect'
        if (info?.ssh !== undefined) sshHostKey = toSshHostKeyCheck(info.ssh, thrown)
      }
      recordCheck(checks, failedStage, 'failed', message)
      return {
        ok: false,
        message,
        elapsedMs: Math.round(performance.now() - startedAt),
        checks,
        ...(sshHostKey === undefined ? {} : { sshHostKey })
      }
    } finally {
      if (probe) await probe.end().catch(() => undefined)
      if (tunnel !== null) await tunnel.close().catch(() => undefined)
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
    let result = description
    /*
     * 索引 / 外键 / 唯一约束放在同一个 try 里：它们来自同一组稳定的
     * information_schema 表，一次失败通常意味着连接或权限问题。
     */
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
      const fkMap = new Map<string, {
        name: string
        columns: string[]
        refSchema: string
        refTable: string
        refColumns: string[]
        onUpdate: string | null
        onDelete: string | null
      }>()
      for (const r of fkRows as unknown as { name: string; columnName: string; refSchema: string; refTable: string; refColumn: string }[]) {
        const cur = fkMap.get(r.name) ?? {
          name: r.name,
          columns: [],
          refSchema: r.refSchema,
          refTable: r.refTable,
          refColumns: [],
          onUpdate: null,
          onDelete: null
        }
        cur.columns.push(r.columnName)
        cur.refColumns.push(r.refColumn)
        fkMap.set(r.name, cur)
      }
      // 外键动作（ON UPDATE / ON DELETE）在 REFERENTIAL_CONSTRAINTS 里。
      try {
        const [ruleRows] = await conn.query(
          `SELECT CONSTRAINT_NAME AS name, UPDATE_RULE AS onUpdate, DELETE_RULE AS onDelete
             FROM information_schema.REFERENTIAL_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?`,
          [schema, table]
        )
        for (const r of ruleRows as unknown as { name: string; onUpdate: string | null; onDelete: string | null }[]) {
          const cur = fkMap.get(r.name)
          if (cur === undefined) continue
          cur.onUpdate = r.onUpdate
          cur.onDelete = r.onDelete
        }
      } catch {
        // 读不到动作不影响外键本身，保持 null。
      }
      const foreignKeys = [...fkMap.values()].map((f) => ({
        name: f.name,
        columns: f.columns,
        referencedSchema: f.refSchema,
        referencedTable: f.refTable,
        referencedColumns: f.refColumns,
        onUpdate: f.onUpdate,
        onDelete: f.onDelete
      }))

      // 唯一约束从"唯一索引"派生（MySQL 里 UNIQUE KEY 就是唯一索引）。
      const uniqueConstraints = [...indexMap.values()]
        .filter((i) => i.unique)
        .map((i) => ({ name: i.name, columns: i.columns }))
      result = { ...result, indexes, foreignKeys, uniqueConstraints }
    } catch (thrown) {
      if (thrown instanceof MysqlAdapterError) throw thrown
      return result
    }

    /*
     * CHECK 约束单独一个 try：MySQL 8.0.16 之前没有 CHECK_CONSTRAINTS。
     * 这条查询失败时只应让 checks 保持 undefined（"驱动没说"），
     * 不能因此把已经读到的索引/外键一起丢掉。
     */
    try {
      const [checkRows] = await conn.query(
        `SELECT tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS expression
           FROM information_schema.TABLE_CONSTRAINTS tc
           JOIN information_schema.CHECK_CONSTRAINTS cc
             ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
            AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
          WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'
          ORDER BY tc.CONSTRAINT_NAME`,
        [schema, table]
      )
      const checks = (checkRows as unknown as { name: string; expression: string | null }[])
        .filter((r) => typeof r.expression === 'string')
        .map((r) => ({ name: r.name, expression: r.expression as string }))
      result = { ...result, checks }
    } catch {
      // 旧版本 MySQL 没有 CHECK_CONSTRAINTS：保持 undefined，UI 显示"未知"。
    }

    try {
      const [triggerRows] = await conn.query(
        `SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event,
                ACTION_STATEMENT AS statement, ACTION_CONDITION AS cond
           FROM information_schema.TRIGGERS
          WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
          ORDER BY TRIGGER_NAME`,
        [schema, table]
      )
      const triggers = (triggerRows as unknown as {
        name: string
        timing: string
        event: string
        statement: string | null
        cond: string | null
      }[])
        .filter((r) => isTriggerTiming(r.timing) && isTriggerEvent(r.event))
        .map((r) => ({
          name: r.name,
          timing: r.timing as 'BEFORE' | 'AFTER' | 'INSTEAD OF',
          event: r.event as 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE',
          statement: r.statement ?? '',
          updateOf: [] as string[],
          when: r.cond ?? null,
          // MySQL 不能单独禁用触发器；读到的都视为启用。
          enabled: true
        }))
      result = { ...result, triggers }
    } catch {
      // 权限不足等：保持 undefined，不假装"没有触发器"。
    }

    return result
  }

  /** 读取视图定义（`information_schema.VIEWS`）。拿不到时返回 null。 */
  async viewDefinition(id: string): Promise<string | null> {
    const conn = this.#requireConn()
    const parsed = parseObjectId(id)
    if (parsed === null || parsed.kind !== 'view') {
      throw new MysqlAdapterError('object_not_found', `viewDefinition 只接受视图节点，收到的 id 是：${id}`)
    }
    try {
      const [rows] = await conn.query(
        'SELECT VIEW_DEFINITION AS definition FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [parsed.schema, parsed.name]
      )
      const definition = (rows as unknown as { definition: string | null }[])[0]?.definition
      return typeof definition === 'string' && definition.trim() !== '' ? definition : null
    } catch {
      return null
    }
  }

  /**
   * 列出例程（函数 / 存储过程）。
   *
   * MySQL 不支持同名重载，所以不提供 `signature`——`DROP PROCEDURE name`
   * 本来就不能带参数列表。定义用 `SHOW CREATE` 取完整 DDL
   * （information_schema 的 `ROUTINE_DEFINITION` 只有函数体，不足以重建）。
   * 单个例程取不到定义时留 null，不影响其它例程。
   */
  async listRoutines(options?: { schema?: string | null }): Promise<RoutineInfo[]> {
    const conn = this.#requireConn()
    const params: string[] = []
    let filter = ''
    if (options?.schema) {
      params.push(options.schema)
      filter = ' AND ROUTINE_SCHEMA = ?'
    }
    const [rows] = await conn.query(
      `SELECT ROUTINE_SCHEMA AS routineSchema, ROUTINE_NAME AS name, ROUTINE_TYPE AS kind
         FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
        ${filter}
        ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME`,
      params
    )
    const routines: RoutineInfo[] = []
    for (const row of rows as unknown as { routineSchema: string; name: string; kind: string }[]) {
      const kind = row.kind === 'PROCEDURE' ? 'procedure' : 'function'
      const definition = await this.#routineDefinition(conn, row.routineSchema, row.name, kind)
      routines.push({ schema: row.routineSchema, name: row.name, kind, definition })
    }
    return routines
  }

  async #routineDefinition(
    conn: Connection,
    schema: string,
    name: string,
    kind: 'function' | 'procedure'
  ): Promise<string | null> {
    const quote = mysqlDialect.quoteIdentifier.bind(mysqlDialect)
    try {
      const [rows] = await conn.query(`SHOW CREATE ${kind.toUpperCase()} ${quote(schema)}.${quote(name)}`)
      const row = (rows as unknown as Record<string, unknown>[])[0]
      if (row === undefined) return null
      const key = Object.keys(row).find((k) => /^Create (Function|Procedure)$/i.test(k))
      const value = key === undefined ? undefined : row[key]
      if (typeof value !== 'string' || value.trim() === '') return null
      /*
       * 去掉 DEFINER：`SHOW CREATE` 会带上原定义者（``DEFINER=`root`@`%` ``），
       * 拿到另一个环境执行时往往因权限不足失败。去掉后由执行者自己作为定义者，
       * 这是结构同步最可移植的形态。
       */
      return value.trim().replace(/^(CREATE\s+)DEFINER=(?:`[^`]*`|[^\s@]+)@(?:`[^`]*`|[^\s]+)\s+/i, '$1')
    } catch {
      return null
    }
  }

  async query(sql: string, options?: QueryOptions): Promise<QueryResult> {
    const conn = this.#requireConn()
    const bound = bindSqlParameters(sql, options?.parameters, 'mysql')
    const limit = normalizeLimit(options?.limit)
    const offset = normalizeOffset(options?.offset)
    const executedSql = buildPagedSql(bound.sql, limit, offset)
    const startedAt = performance.now()
    const [rows, fields] = await conn.query({ sql: executedSql, rowsAsArray: true }, toMysqlParams(bound.values))
    const elapsedMs = Math.round(performance.now() - startedAt)
    const rawRows = rows as unknown as unknown[][]
    const cursorId = options?.keepCursor === false ? null : this.#openCursor(bound.sql, bound.values)
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
    const [rows, fields] = await conn.query({ sql: executedSql, rowsAsArray: true }, toMysqlParams(cursor.params))
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

  #openCursor(sql: string, params: readonly SqlParameterValue[] = []): string {
    const id = `mysql-cursor-${this.#nextCursor++}`
    this.#cursors.set(id, { sql, params })
    return id
  }

  async executeStatement(sql: string, options?: QueryOptions): Promise<StatementResult> {
    const conn = this.#requireConn()
    const bound = bindSqlParameters(sql, options?.parameters, 'mysql')
    const statementSql = stripTrailingSemicolon(bound.sql)
    const params = toMysqlParams(bound.values)
    const startedAt = performance.now()
    const [rows, fields] = await conn.query({ sql: statementSql, rowsAsArray: true }, params)
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
          cursorId: this.#openCursor(statementSql, bound.values),
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
      // 事务状态如实反映本驱动的跟踪结果（手写 BEGIN/COMMIT 不在跟踪范围内）。
      inTransaction: this.#inTransaction,
      transactionState: { active: this.#inTransaction, pendingAffected: this.#pendingAffected },
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
    const info = this.#info
    if (conn === null || info === null) return false
    const threadId = conn.threadId
    if (typeof threadId !== 'number') return false
    // 用**独立连接**执行 KILL QUERY：主连接正忙着跑那条查询，在它上面发只会排队。
    // 取消连接必须复用同一套 SSL / SSH 设置：远端要求 TLS 或只能经跳板机到达时，
    // 用明文直连会失败，表现为"取消按钮点了没反应"，且本机永远复现不了。
    let killer: Connection | null = null
    try {
      let stream: Duplex | undefined
      if (info.ssh !== undefined) {
        if (this.#tunnel === null) return false
        stream = await this.#tunnel.forward()
      }
      killer = await createConnection({
        host: info.host,
        port: info.port,
        user: info.user,
        password: info.password,
        ...(info.ssl === undefined ? {} : { ssl: info.ssl }),
        ...(stream === undefined ? {} : { stream }),
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
  // ===== 写入与传输（P6.2 Step 3） =====
  // 注：用户在 SQL 窗口手写的 BEGIN/COMMIT 不由 #inTransaction 跟踪；事务工具栏与
  // 网格编辑走这里的专用方法。这是本阶段的已知边界，记录在此而非假装覆盖。

  /** 解析表目标 → 限定表名（`db`.`name`）。视图或非表 id 报错。 */
  #tableTarget(tableId: string): { schema: string; name: string; qualified: string } {
    const parsed = parseObjectId(tableId)
    if (parsed === null || parsed.kind !== 'table') {
      throw new MysqlAdapterError('object_not_found', `写操作只接受表节点，收到的 id：${tableId}`)
    }
    const qualified = `${mysqlDialect.quoteIdentifier(parsed.schema)}.${mysqlDialect.quoteIdentifier(parsed.name)}`
    return { schema: parsed.schema, name: parsed.name, qualified }
  }

  async #readPrimaryKeyColumns(conn: Connection, schema: string, table: string): Promise<string[]> {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
        ORDER BY ORDINAL_POSITION`,
      [schema, table]
    )
    return (rows as unknown as { name: string }[]).map((r) => r.name)
  }

  /** 确保处于事务中；返回 true 表示是本次开启的（失败时可撤销空事务）。 */
  async #ensureTransaction(conn: Connection): Promise<boolean> {
    if (this.#inTransaction) return false
    await conn.query('START TRANSACTION')
    this.#inTransaction = true
    this.#pendingAffected = 0
    return true
  }

  async applyEdits(tableId: string, updates: readonly RowUpdate[]): Promise<EditApplyResult> {
    const conn = this.#requireConn()
    const target = this.#tableTarget(tableId)
    if (updates.length === 0) return { affected: 0, outcomes: [], ok: true, inTransaction: this.#inTransaction }
    await this.#ensureTransaction(conn)
    const outcomes: RowEditOutcome[] = []
    let total = 0
    for (let index = 0; index < updates.length; index += 1) {
      const update = updates[index]
      if (update === undefined) continue
      const setCols = Object.keys(update.changes)
      const keyCols = Object.keys(update.keyValues)
      if (setCols.length === 0) { outcomes.push({ index, affected: 0, error: '没有要更新的列', sql: '' }); continue }
      if (keyCols.length === 0) { outcomes.push({ index, affected: 0, error: '缺少主键值，拒绝无条件更新', sql: '' }); continue }
      const setSql = setCols.map((c) => `${mysqlDialect.quoteIdentifier(c)} = ?`).join(', ')
      const whereSql = keyCols.map((c) => `${mysqlDialect.quoteIdentifier(c)} = ?`).join(' AND ')
      const sql = `UPDATE ${target.qualified} SET ${setSql} WHERE ${whereSql}`
      const params = [
        ...setCols.map((c) => cellValueToSqlParam(update.changes[c]!)),
        ...keyCols.map((c) => cellValueToSqlParam(update.keyValues[c]!))
      ]
      try {
        const [res] = await conn.query(sql, params)
        const affected = Number((res as { affectedRows?: number }).affectedRows ?? 0)
        total += affected
        outcomes.push({ index, affected, error: null, sql })
      } catch (thrown) {
        outcomes.push({ index, affected: 0, error: describeThrown(thrown), sql })
      }
    }
    this.#pendingAffected += total
    return { affected: total, outcomes, ok: outcomes.every((o) => o.error === null), inTransaction: this.#inTransaction }
  }

  async insertRow(
    tableId: string,
    values: Readonly<Record<string, CellValue>>
  ): Promise<{ affected: number; keyValues: Record<string, CellValue> }> {
    const conn = this.#requireConn()
    const target = this.#tableTarget(tableId)
    const cols = Object.keys(values)
    if (cols.length === 0) throw new MysqlAdapterError('bad_params', '插入必须至少提供一个列值')
    const inOwn = await this.#ensureTransaction(conn)
    const sql = `INSERT INTO ${target.qualified} (${cols.map((c) => mysqlDialect.quoteIdentifier(c)).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    const params = cols.map((c) => cellValueToSqlParam(values[c]!))
    try {
      const [res] = await conn.query(sql, params)
      this.#pendingAffected += 1
      const insertId = Number((res as { insertId?: number }).insertId ?? 0)
      const keyValues: Record<string, CellValue> = {}
      const pkCols = await this.#readPrimaryKeyColumns(conn, target.schema, target.name)
      if (pkCols.length === 1 && insertId > 0) keyValues[pkCols[0]!] = { kind: 'number', value: insertId }
      return { affected: Number((res as { affectedRows?: number }).affectedRows ?? 1), keyValues }
    } catch (thrown) {
      if (inOwn) {
        await conn.query('ROLLBACK').catch(() => undefined)
        this.#inTransaction = false
        this.#pendingAffected = 0
      }
      throw thrown instanceof MysqlAdapterError ? thrown : new MysqlAdapterError('query_failed', `插入失败：${describeThrown(thrown)}`)
    }
  }

  async deleteRows(
    tableId: string,
    keys: readonly Readonly<Record<string, CellValue>>[]
  ): Promise<EditApplyResult> {
    const conn = this.#requireConn()
    const target = this.#tableTarget(tableId)
    if (keys.length === 0) throw new MysqlAdapterError('bad_params', '拒绝空删除条件（会删掉整张表）')
    await this.#ensureTransaction(conn)
    const outcomes: RowEditOutcome[] = []
    let total = 0
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]
      if (key === undefined) continue
      const keyCols = Object.keys(key)
      if (keyCols.length === 0) { outcomes.push({ index, affected: 0, error: '缺少主键值，拒绝无条件删除', sql: '' }); continue }
      const whereSql = keyCols.map((c) => `${mysqlDialect.quoteIdentifier(c)} = ?`).join(' AND ')
      const sql = `DELETE FROM ${target.qualified} WHERE ${whereSql}`
      const params = keyCols.map((c) => cellValueToSqlParam(key[c]!))
      try {
        const [res] = await conn.query(sql, params)
        const affected = Number((res as { affectedRows?: number }).affectedRows ?? 0)
        total += affected
        outcomes.push({ index, affected, error: null, sql })
      } catch (thrown) {
        outcomes.push({ index, affected: 0, error: describeThrown(thrown), sql })
      }
    }
    this.#pendingAffected += total
    return { affected: total, outcomes, ok: outcomes.every((o) => o.error === null), inTransaction: this.#inTransaction }
  }

  async countRows(tableId: string): Promise<number> {
    const conn = this.#requireConn()
    const target = this.#tableTarget(tableId)
    const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM ${target.qualified}`)
    return Number((rows as unknown as { c: number }[])[0]?.c ?? 0)
  }

  async fetchCellValue(cursorId: string, rowIndex: number, columnIndex: number): Promise<CellValue> {
    const conn = this.#requireConn()
    const cursor = this.#cursors.get(cursorId)
    if (!cursor) throw new MysqlAdapterError('object_not_found', `未知游标：${cursorId}`)
    const [rows] = await conn.query({ sql: cursor.sql, rowsAsArray: true }, toMysqlParams(cursor.params))
    const row = (rows as unknown as unknown[][])[rowIndex]
    if (!row) throw new MysqlAdapterError('bad_params', `行号越界：${rowIndex}`)
    return toFullCellValue(row[columnIndex])
  }

  async transactionState(): Promise<TransactionState> {
    if (this.#conn === null) return { active: false, pendingAffected: 0 }
    return { active: this.#inTransaction, pendingAffected: this.#pendingAffected }
  }

  async commitTransaction(): Promise<TransactionState> {
    const conn = this.#requireConn()
    if (!this.#inTransaction) throw new MysqlAdapterError('bad_params', '当前没有未提交的事务，无法提交')
    await conn.query('COMMIT')
    this.#inTransaction = false
    this.#pendingAffected = 0
    return { active: false, pendingAffected: 0 }
  }

  async rollbackTransaction(): Promise<TransactionState> {
    const conn = this.#conn
    if (conn === null) return { active: false, pendingAffected: 0 }
    if (this.#inTransaction) {
      await conn.query('ROLLBACK').catch(() => undefined)
      this.#inTransaction = false
      this.#pendingAffected = 0
    }
    return { active: false, pendingAffected: 0 }
  }

  async importBatch(tableId: string, batch: ImportBatch): Promise<ImportBatchResult> {
    const conn = this.#requireConn()
    const target = this.#tableTarget(tableId)
    if (batch.rows.length === 0) return { rowsImported: 0, inTransaction: this.#inTransaction }
    const cols = [...batch.columns]
    if (cols.length === 0) throw new MysqlAdapterError('bad_params', '导入批次缺少列')
    await this.#ensureTransaction(conn)
    const rowPlaceholder = `(${cols.map(() => '?').join(', ')})`
    const sql = `INSERT INTO ${target.qualified} (${cols.map((c) => mysqlDialect.quoteIdentifier(c)).join(', ')}) VALUES ${batch.rows.map(() => rowPlaceholder).join(', ')}`
    const params: (string | number | boolean | null | Uint8Array)[] = []
    for (const row of batch.rows) for (const v of row.values) params.push(cellValueToSqlParam(v))
    try {
      const [res] = await conn.query(sql, params)
      const n = Number((res as { affectedRows?: number }).affectedRows ?? batch.rows.length)
      this.#pendingAffected += n
      return { rowsImported: n, inTransaction: this.#inTransaction }
    } catch (thrown) {
      throw new MysqlAdapterError('query_failed', `导入第 ${batch.batchIndex} 批失败：${describeThrown(thrown)}`)
    }
  }

  async resolveTransferSource(nodeId: string): Promise<TransferSourceResolution> {
    const parsed = parseObjectId(nodeId)
    if (parsed === null || (parsed.kind !== 'table' && parsed.kind !== 'view')) {
      throw new MysqlAdapterError('object_not_found', `导出只支持表或视图节点：${nodeId}`)
    }
    const qualified = `${mysqlDialect.quoteIdentifier(parsed.schema)}.${mysqlDialect.quoteIdentifier(parsed.name)}`
    return { sql: `SELECT * FROM ${qualified}`, target: { schema: parsed.schema, name: parsed.name, kind: parsed.kind } }
  }

  // ===== DDL 结构编辑（建表/删表/视图/重命名） =====

  /** DDL 需要明确的目标库。连接未指定 database 时按错误处理，不猜。 */
  #requireDatabase(): string {
    if (this.#database === null || this.#database.trim() === '') {
      throw new MysqlAdapterError('bad_params', '当前连接没有指定 database，无法确定 DDL 的目标库。')
    }
    return this.#database
  }

  /**
   * MySQL 的 DDL 会**隐式提交**当前事务。若用户有未提交的网格编辑，
   * 直接执行 DDL 会把它们一起提交——这是静默的数据事故。
   * 所以有跟踪中的事务时明确拒绝，让用户先提交或回滚。
   */
  #assertNoTransaction(action: string): void {
    if (this.#inTransaction) {
      throw new MysqlAdapterError(
        'bad_params',
        `当前有未提交的事务，${action}会隐式提交它。请先提交或回滚，再执行 DDL。`
      )
    }
  }

  #requireName(value: string, label: string): string {
    const name = value.trim()
    if (name === '' || name.includes('\0')) {
      throw new MysqlAdapterError('bad_params', `${label}不能为空或包含 NUL 字符。`)
    }
    return name
  }

  #requireRelationName(nodeId: string, kind: 'table' | 'view', action: string): { schema: string; name: string } {
    const parsed = parseObjectId(nodeId)
    if (parsed === null || parsed.kind !== kind) {
      throw new MysqlAdapterError('object_not_found', `${action}只接受${kind === 'table' ? '表' : '视图'}节点，收到的 id：${nodeId}`)
    }
    return { schema: parsed.schema, name: parsed.name }
  }

  async #runDdl(action: string, sql: string): Promise<void> {
    const conn = this.#requireConn()
    try {
      await conn.query(sql)
    } catch (thrown) {
      throw new MysqlAdapterError('query_failed', `${action}失败：${describeThrown(thrown)}`)
    }
  }

  async createTable(connectionId: string, spec: TableCreateSpec): Promise<void> {
    void connectionId
    this.#assertNoTransaction('建表')
    const schema = this.#requireDatabase()
    const quote = mysqlDialect.quoteIdentifier.bind(mysqlDialect)
    const raw = buildCreateTableSql(quote, spec)
    const sql = raw.replace(/^CREATE TABLE /, `CREATE TABLE ${quote(schema)}.`)
    await this.#runDdl('建表', sql)
  }

  async dropTable(nodeId: string): Promise<void> {
    this.#assertNoTransaction('删表')
    const { schema, name } = this.#requireRelationName(nodeId, 'table', '删表')
    const quote = mysqlDialect.quoteIdentifier.bind(mysqlDialect)
    await this.#runDdl('删表', buildDropTableSql(quote, schema, name))
  }

  async createView(connectionId: string, viewName: string, selectSql: string): Promise<void> {
    void connectionId
    this.#assertNoTransaction('建视图')
    const schema = this.#requireDatabase()
    const name = this.#requireName(viewName, '视图名')
    const select = this.#requireReadOnlySelect(selectSql)
    const quote = mysqlDialect.quoteIdentifier.bind(mysqlDialect)
    await this.#runDdl('建视图', buildCreateViewSql(quote, schema, name, select))
  }

  async dropView(nodeId: string): Promise<void> {
    this.#assertNoTransaction('删视图')
    const { schema, name } = this.#requireRelationName(nodeId, 'view', '删视图')
    const quote = mysqlDialect.quoteIdentifier.bind(mysqlDialect)
    await this.#runDdl('删视图', buildDropViewSql(quote, schema, name))
  }

  async renameTable(nodeId: string, newName: string): Promise<void> {
    this.#assertNoTransaction('重命名表')
    const { schema, name } = this.#requireRelationName(nodeId, 'table', '重命名表')
    const target = this.#requireName(newName, '新表名')
    const quote = mysqlDialect.quoteIdentifier.bind(mysqlDialect)
    await this.#runDdl('重命名表', buildRenameTableSql(quote, schema, name, target))
  }

  /**
   * 视图定义只允许单条 SELECT / WITH 查询。
   *
   * MySQL 的 CREATE VIEW 不接受多语句；如果这里放过 `SELECT ...; DROP ...`，
   * 在多语句关闭时服务器会报错，但错误信息会离真正原因很远，而且等于把
   * 注入面交给服务器去兜底。这里提前拒绝。
   */
  #requireReadOnlySelect(selectSql: string): string {
    const sql = stripTrailingSemicolon(selectSql)
    if (sql.trim() === '') throw new MysqlAdapterError('bad_params', '视图定义不能为空。')
    if (sql.includes(';')) throw new MysqlAdapterError('bad_params', '视图定义只能包含一条 SELECT 语句。')
    if (!/^(SELECT|WITH)\b/i.test(sql.trim())) {
      throw new MysqlAdapterError('bad_params', '视图定义必须以 SELECT 或 WITH 开头。')
    }
    return sql
  }
}

/** 完整单元格值（不截断）——「取完整值」专用，与网格首屏的截断版区分。 */
function toFullCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return { kind: 'null' }
  if (Buffer.isBuffer(value)) return { kind: 'blob', previewBase64: value.toString('base64'), length: value.length, truncated: false }
  if (typeof value === 'bigint') return { kind: 'text', text: value.toString() }
  if (typeof value === 'number') return { kind: 'number', value }
  if (typeof value === 'boolean') return { kind: 'boolean', value }
  if (value instanceof Date) return { kind: 'text', text: value.toISOString() }
  return { kind: 'text', text: String(value) }
}

function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message
  return String(thrown)
}

function isTriggerTiming(value: string): value is 'BEFORE' | 'AFTER' {
  return value === 'BEFORE' || value === 'AFTER'
}

function isTriggerEvent(value: string): value is 'INSERT' | 'UPDATE' | 'DELETE' {
  return value === 'INSERT' || value === 'UPDATE' || value === 'DELETE'
}

export function createMysqlAdapter(): DriverAdapter {
  return new MysqlDriverAdapter()
}
