/**
 * PostgreSQL 驱动适配器（本项目的第二个真实驱动实现）。
 *
 * ===== 这个文件存在的意义：验证「多方言抽象真的成立」 =====
 *
 * 本项目此前只有 SQLite。加了 PG 之后，凡是**需要改动 core / driver-host / main**
 * 的地方，就说明抽象有裂缝。本实现的原则是：**只新增 `src/drivers/postgresql/**`
 * 与两行注册**，其它一概不动。若发现非改不可，会在注释里显式标注「抽象裂缝」。
 *
 * ===== 它运行在哪里 =====
 *
 * 与 SQLite 一样，这个文件**只在驱动宿主进程里执行**（见 `core/driver.ts` 文件头：
 * Node 没有 URLClassLoader，用进程隔离代替类加载隔离）。因此这里可以持有
 * `pg.Pool`/`Client` 句柄作为实例状态——一个 adapter 实例、一个连接、一个进程。
 *
 * ===== pg 是异步 API，正好匹配 =====
 *
 * `node:sqlite` 是同步的（`StatementSync.all()` 直接返回），而 `pg` 全部返回 Promise。
 * 本 adapter 的方法签名本来就全是 `Promise<...>`，所以**这一层不需要任何魔改**：
 * `await client.query(...)` 直接嵌进 async 方法即可。这是"契约定成 Promise"的一个
 * 意外收益——两个同步/异步语义完全不同的驱动，对上层是同一个形状。
 */

import { randomUUID } from 'node:crypto'

import { Client, type QueryResult } from 'pg'

import type { ConnectionConfig } from '../../core/dialect'
import type {
  ImportBatch,
  ImportBatchResult,
  TransferSourceResolution
} from '../../core/transfer'
import type {
  ConnectionTestCheck,
  ConnectionTestStage,
  DriverAdapter,
  RoutineInfo,
  SecretValue,
  SshHostKeyCheck,
  TestConnectionResult
} from '../../core/driver'
import type { DriverCapabilities, ObjectRef, TableDescription, ColumnDescription } from '../../core/model'
import type { DriverFactory } from '../../core/registry'
import type {
  CellValue,
  EditApplyResult,
  ExplainResult,
  QueryOptions,
  QueryResult as QueryResultContract,
  SqlParameterValue,
  ResultPage,
  RowEditOutcome,
  RowUpdate,
  TransactionState,
  StatementResult
} from '../../core/resultset'
import { bindSqlParameters } from '../../core/sql-parameters'

import { postgresqlDialect } from './dialect'
import { POSTGRESQL_INFO } from './info'
import { cancelPostgresBackend, isCancelError } from './query-cancel'
import { PostgresAdapterError, describeThrown, wrapPgError } from './errors'
import {
  DEFAULT_SSL_MODE,
  isPgSslMode,
  openClient,
  planAttempts,
  type PgSslMode,
  type SslAttempt
} from './ssl'
import {
  openSshTunnel,
  SshTunnelError,
  type SshCredentials,
  type SshTunnel,
  type SshTunnelConfig
} from './ssh-tunnel'
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
import {
  buildColumns,
  buildGrid,
  buildPagedSql,
  buildRows,
  normalizeOffset,
  normalizePageSize,
  prepareReadOnlyStatement,
  prepareGeneralStatement,
  PAGINATABLE_KEYWORDS,
  toCellValue,
  toFullCellValue,
  type PgResultLike
} from './results'
import {
  buildCountSql,
  buildDelete,
  buildInsert,
  buildUpdate,
  normalizeValues,
  resolveColumns,
  resolveRequiredColumns,
  toBindValue,
  mustGetValue,
  type ColumnMatch
} from './edits'
import {
  buildCreateTableSql,
  buildCreateViewSql,
  buildDropTableSql,
  buildDropViewSql,
  buildRenameTableSql
} from './ddl'
import { readPostgresTableMetadata } from './metadata'
import type { TableCreateSpec } from '../../core/model'

/**
 * 能力声明。
 *
 * 与 SQLite 的差异：
 *   - `hasSchema: true`（PG 有 schema 层；这是本方言与 SQLite 最直观的结构差异）
 *   - `hasCatalog: true`（PG 连接即一个 catalog/database，但 catalog 只做连接级，见 dialect.ts）
 *   - `supportsCancel: true`（用独立连接执行 `pg_cancel_backend(pid)` 真取消，见 query-cancel.ts）
 *
 * `supportsInlineEdit: true` 说的是"方言具备在线编辑能力"，具体某表能不能改
 * 由 `describeTable().hasUniqueKey` 逐表决定（与 SQLite 同一分层）。
 */
const POSTGRESQL_CAPABILITIES: DriverCapabilities = {
  hasCatalog: true,
  hasSchema: true,
  supportsServerPagination: true,
  supportsCancel: true,
  supportsInlineEdit: true,
  // PG 的 pg_catalog 能读出外键、索引、唯一约束、CHECK 与触发器。
  // 声明在这里，UI 才能在请求之前就知道"这个连接能给出外键"。
  metadata: {
    foreignKeys: true,
    indexes: true,
    uniqueConstraints: true,
    checkConstraints: true,
    triggers: true
  }
}

/** 连接参数从 `ConnectionConfig.options` 解析出来的形状。 */
interface PgConnectionInfo {
  readonly host: string
  readonly port: number
  readonly database: string
  readonly user: string
  readonly password: string | undefined
  /**
   * SSL 策略展开后的尝试列表。
   *
   * 之所以存"展开后的列表"而不是原始 `sslmode` 字符串：取消查询需要
   * **另开一条连接**（见 query-cancel.ts），它必须与主连接用**完全相同**的 SSL 策略。
   * 若那时再解析一次，就可能出现"主连接走回退明文、取消连接却试 SSL"的偏差；
   * 而且 CA 文件会被重复读取。这里一次算好，主连接与取消连接共用。
   */
  readonly sslAttempts: readonly SslAttempt[]
  /**
   * SSH 隧道配置（未启用时为 undefined）。
   *
   * 注意这里存的是**配置**而不是已建立的隧道：隧道有生命周期，
   * 由 adapter 在 connect/disconnect 时开关（见 `#tunnel`），
   * 不能混进"每次连接都要重新算一遍"的纯配置解析结果里。
   */
  readonly ssh: SshTunnelConfig | undefined
  /** SSH 认证机密（从统一的 SecretValue 里拆出来）。 */
  readonly sshCredentials: SshCredentials | undefined
}

interface EditableTarget {
  readonly schema: string
  readonly tableName: string
  readonly availableColumns: readonly string[]
  readonly keyColumns: readonly string[]
}

interface CursorState {
  readonly sql: string
  readonly params: readonly SqlParameterValue[]
}

function readOptionString(config: ConnectionConfig, key: string): string {
  const raw = config.options[key]
  return typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
}

/**
 * 定位导入失败涉及的列。
 *
 * 优先用 PostgreSQL 的**结构化字段** `column`（服务器直接告诉我们是哪一列），
 * 其次才从错误原文里按已知模板提取列名。
 *
 * ===== 为什么"只接受确实是目标列"的候选 =====
 *
 * 错误原文里带引号的内容**未必是列名**：值本身就会带引号，
 * 例如 `invalid input syntax for type integer: "abc"`，
 * 甚至可能被人为构造成 `xxx" , column "PASSWORD"` 这种形状。
 * 若把这样的内容当列名回显，等于把 CSV 的内容抄进错误消息——
 * 那正是这个函数要防的事。所以候选必须与目标列名精确匹配（忽略大小写）。
 */
function importErrorColumn(
  message: string,
  columns: readonly string[],
  serverColumn?: unknown
): string | null {
  if (typeof serverColumn === 'string' && serverColumn !== '') {
    const exact = columns.find((column) => column.toLowerCase() === serverColumn.toLowerCase())
    if (exact !== undefined) return exact
  }
  const patterns = [
    /null value in column\s+"([^"]+)"/i,
    /column\s+"([^"]+)"\s+of relation/i,
    /column\s+"([^"]+)"/i
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(message)
    const candidate = match?.[1]
    if (candidate === undefined || candidate === '') continue
    const exact = columns.find((column) => column.toLowerCase() === candidate.toLowerCase())
    if (exact !== undefined) return exact
  }
  return null
}

/**
 * 导入场景里常见 SQLSTATE 的固定中文说明。
 *
 * 为什么要这张表：PostgreSQL 的错误消息里经常**直接带着出错的值**
 * （`invalid input syntax for type integer: "abc"`），
 * 而错误消息会一路传到 renderer —— 那就等于把 CSV 内容显示在界面上，
 * 违反"renderer 永远拿不到行数据"的契约（见 core/transfer.ts 文件头）。
 *
 * 所以这里改用**服务器给的结构化信息**（SQLSTATE 等）配一句固定措辞：
 * 说明是查表得来的固定文本，不含任何用户数据。
 *
 * 分类严格按 PostgreSQL 官方 Appendix A 的错误码表：
 *   - 22003 = numeric_value_out_of_range（数值超范围）
 *   - 22007 = invalid_datetime_format（**日期时间格式无效**）
 *   - 22008 = datetime_field_overflow（日期时间字段超范围）
 * 三者含义不同，不能互相顶替——把 22007 说成"数值超范围"会把用户带偏。
 */
const PG_IMPORT_SQLSTATE_HINTS: Readonly<Record<string, string>> = {
  '22001': '值超出了目标列的长度限制',
  '22003': '数值超出了目标列的范围',
  '22007': '日期时间格式无效',
  '22008': '日期时间字段超出了范围',
  '22012': '除数为零',
  '22P02': '文本无法转换成目标列的类型',
  '23502': '目标列不允许 NULL',
  '23503': '违反外键约束',
  '23505': '违反唯一约束',
  '23514': '违反 CHECK 约束',
  '23P01': '违反排他约束',
  '40001': '序列化冲突，事务已被中止',
  '40P01': '检测到死锁，事务已被中止',
  '42501': '权限不足',
  '42601': 'SQL 语法错误',
  '42703': '列不存在',
  '42P01': '表或视图不存在',
  '42883': '函数不存在',
  '57014': '语句被取消或超时',
  '57P01': '数据库已终止连接'
}

/** 从错误对象里安全地读一个字符串字段。读不到就返回 null，绝不猜。 */
function readPgErrorField(thrown: unknown, field: string): string | null {
  if (typeof thrown !== 'object' || thrown === null) return null
  const value = (thrown as Record<string, unknown>)[field]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 生成**不含 CSV 单元格值**的导入失败摘要。
 *
 * 只输出服务器给的结构化信息：SQLSTATE、严重级别、以及表/列/约束这些
 * **目录对象名**（是 schema 里的对象名，不是数据），再配一句固定措辞的说明。
 * 原始错误消息**一律不回显**——它最可能携带的就是出错的那份数据。
 *
 * ===== 为什么连"没有 SQLSTATE"的情况也不回显原文 =====
 *
 * 没有 SQLSTATE 说明是连接层/客户端层错误（例如连接被中断）。
 * 旧实现在这里回显原文（只把本行的值替换掉），但那条路同样不可靠：
 *   - 客户端错误可能夹带**别的**内容（连接串、主机名、乃至上一条语句）；
 *   - 逐值替换式抹除挡不住"先变换再回显"（substr/upper/hex）与
 *     PostgreSQL 的类型亲和性（'42' → 42）；
 *   - 长度为 1 的值只能按"独立词"替换，紧挨别的字符就漏。
 * 既然没有可信的结构化字段可展示，就**只给固定措辞**。
 */
function describePgImportFailure(thrown: unknown): string {
  const sqlstate = readPgErrorField(thrown, 'code')
  if (sqlstate === null || !/^[0-9A-Z]{5}$/.test(sqlstate)) {
    const severity = readPgErrorField(thrown, 'severity')
    const severityPart =
      severity !== null && /^[A-Z]{1,16}$/.test(severity) ? `，严重级别 ${severity}` : ''
    return `数据库连接层错误（服务器未返回 SQLSTATE）${severityPart}`
  }

  const parts: string[] = [`SQLSTATE ${sqlstate}`]
  const hint = PG_IMPORT_SQLSTATE_HINTS[sqlstate]
  parts.push(`（${hint ?? '数据库返回的错误'}）`)

  const severity = readPgErrorField(thrown, 'severity')
  if (severity !== null && severity.toUpperCase() !== 'ERROR') {
    parts.push(`，严重级别 ${severity}`)
  }
  const constraint = readPgErrorField(thrown, 'constraint')
  if (constraint !== null) parts.push(`，约束 ${constraint}`)
  const table = readPgErrorField(thrown, 'table')
  if (table !== null) {
    const schema = readPgErrorField(thrown, 'schema')
    parts.push(`，表 ${schema === null ? table : `${schema}.${table}`}`)
  }
  return parts.join('')
}

/**
 * 导入失败时挂的**安全 cause**：只带 SQLSTATE / 严重级别这类结构化字段。
 *
 * 原来的写法是把 `pg` 抛出的原始异常整个挂成 `cause`，那等于把
 * "含出错数据与 DETAIL 键值"的原文留在错误对象里。即使当前 RPC 协议
 * 只传 `{ code, message }`（见 src/driver-host/index.ts 的 toRpcError：
 * 它只取 code 与 message，**不会序列化 cause**），留着原始 cause 也
 * 迟早被人误用/误序列化。这里只保留固定码，排查够用，且不可能夹带数据。
 */
function pgImportFailureCause(thrown: unknown): {
  readonly driver: 'postgresql'
  readonly sqlstate: string | null
  readonly severity: string | null
} {
  const sqlstate = readPgErrorField(thrown, 'code')
  const severity = readPgErrorField(thrown, 'severity')
  return {
    driver: 'postgresql',
    sqlstate: sqlstate !== null && /^[0-9A-Z]{5}$/.test(sqlstate) ? sqlstate : null,
    severity: severity !== null && /^[A-Z]{1,16}$/.test(severity) ? severity : null
  }
}

/**
 * 解析连接参数。密码从独立的 `secret` 参数拿，**不从 options 里拿**——
 * 这是 `core/driver.ts` 里 `SecretValue` 的硬约束：机密不能混进会被日志/序列化的配置对象。
 */
function resolveConnectionInfo(config: ConnectionConfig, secret: SecretValue): PgConnectionInfo {
  const host = readOptionString(config, 'host')
  const database = readOptionString(config, 'database')
  const user = readOptionString(config, 'user')
  const portRaw = readOptionString(config, 'port')
  if (host === '') {
    throw new PostgresAdapterError('connection_failed', `连接「${config.name}」缺少主机地址（host）。`)
  }
  if (database === '') {
    throw new PostgresAdapterError('connection_failed', `连接「${config.name}」缺少数据库名（database）。`)
  }
  if (user === '') {
    throw new PostgresAdapterError('connection_failed', `连接「${config.name}」缺少用户名（user）。`)
  }
  const port = portRaw === '' ? 5432 : Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new PostgresAdapterError('connection_failed', `连接「${config.name}」的端口非法：${portRaw}（应为 1-65535 的整数）。`)
  }
  /**
   * SSL 模式解析。缺省 `prefer`（与 psql 一致），非法值明确报错而不是静默降级——
   * 静默降级会把"我想要 verify-full"变成"其实没校验"，这是安全问题而非体验问题。
   */
  const sslModeRaw = readOptionString(config, 'sslmode')
  const sslMode: PgSslMode =
    sslModeRaw === '' ? DEFAULT_SSL_MODE : isPgSslMode(sslModeRaw) ? sslModeRaw : invalidSslMode(sslModeRaw)
  const caPath = readOptionString(config, 'sslrootcert')
  let sslAttempts: SslAttempt[]
  try {
    sslAttempts = planAttempts(sslMode, caPath === '' ? undefined : caPath)
  } catch (thrown) {
    // 把 CA 缺失/不可读包装成连接错误，让 UI 能看到可读的中文提示。
    throw new PostgresAdapterError('connection_failed', describeThrown(thrown))
  }

  /**
   * SSH 隧道配置。`sshHost` 为空即"不启用隧道"。
   *
   * 隧道里的 `targetHost/targetPort` 是**跳板机视角**下的数据库地址，
   * 与直连时的 `host/port` 可以是两个不同的值（典型：跳板机在公网，
   * 数据库只监听内网 10.x）。所以这里缺省复用 host/port，但允许显式覆盖。
   */
  const sshHost = readOptionString(config, 'sshHost')
  let ssh: SshTunnelConfig | undefined
  if (sshHost !== '') {
    const sshUser = readOptionString(config, 'sshUser')
    if (sshUser === '') {
      throw new PostgresAdapterError('connection_failed', '启用 SSH 隧道时必须填写 SSH 用户名（sshUser）。')
    }
    const sshPortRaw = readOptionString(config, 'sshPort')
    const sshPort = sshPortRaw === '' ? 22 : Number(sshPortRaw)
    if (!Number.isInteger(sshPort) || sshPort <= 0 || sshPort > 65535) {
      throw new PostgresAdapterError(
        'connection_failed',
        `SSH 端口非法：${sshPortRaw}（应为 1-65535 的整数）。`
      )
    }
    const targetHostRaw = readOptionString(config, 'sshTargetHost')
    const targetPortRaw = readOptionString(config, 'sshTargetPort')
    const targetPort = targetPortRaw === '' ? port : Number(targetPortRaw)
    if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
      throw new PostgresAdapterError(
        'connection_failed',
        `SSH 目标数据库端口非法：${targetPortRaw}（应为 1-65535 的整数）。`
      )
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

  /**
   * 从统一机密里拆出 SSH 用的两个。数据库口令始终是 `dbPassword`。
   *
   * 私钥口令（passphrase）与 SSH 登录口令是**两件事**，见 core/driver.ts 的 SecretMap。
   */
  const sshCredentials: SshCredentials | undefined =
    ssh === undefined
      ? undefined
      : {
          password: secret.sshPassword,
          privateKeyPassphrase: secret.sshPassphrase
        }

  return {
    host,
    port,
    database,
    user,
    password: secret.dbPassword,
    sslAttempts,
    ssh,
    sshCredentials
  }
}

/**
 * SSH 失败码到 RPC 错误码的映射。
 *
 * 宿主层只会透传 `RpcErrorCode` 白名单里的码（见 driver-host/index.ts），
 * 若直接把 ssh_* 抛出去，最终会被归成 internal，用户看到“内部错误”，
 * 完全不知道是自己填错了私钥还是主机指纹。
 *
 * 这里保留“连接失败”的大语义（UI 的恢复动作都是改配置/重试），
 * 精确原因仍在消息里。`ssh_host_unverified` 尤其不能丢消息——
 * 它携带用户需要确认的指纹。
 */
function wrapSshError(thrown: unknown): PostgresAdapterError {
  if (thrown instanceof SshTunnelError) {
    return new PostgresAdapterError('connection_failed', thrown.message, thrown)
  }
  return new PostgresAdapterError('connection_failed', describeThrown(thrown))
}

/**
 * 记录一个测试阶段。阶段按执行顺序追加，耗时由调用方按边界计算。
 *
 * 不在这里直接读 `performance.now()`：SSH 认证与主机密钥校验同属 SSH 连接
 * 事件，却被 ssh2 合并成一次等待；单独造精确耗时会给出看似精确、实则编造的数字。
 */
function recordCheck(
  checks: ConnectionTestCheck[],
  stage: ConnectionTestStage,
  status: ConnectionTestCheck['status'],
  message?: string,
  elapsedMs?: number
): void {
  checks.push({
    stage,
    status,
    ...(message === undefined ? {} : { message }),
    ...(elapsedMs === undefined ? {} : { elapsedMs })
  })
}

/** 把 SSH 异常映射到它实际失败的阶段。 */
function sshFailureStage(error: SshTunnelError): ConnectionTestStage {
  switch (error.code) {
    case 'ssh_host_unverified':
    case 'ssh_host_key_mismatch':
      return 'ssh_host_key'
    case 'ssh_auth_failed':
      return 'ssh_auth'
    case 'ssh_forward_failed':
      return 'ssh_forward'
    case 'ssh_missing_credentials':
    case 'ssh_connect_failed':
      return 'ssh_connect'
  }
}

/** 从 SSH 异常构造 UI 可直接展示的主机密钥确认数据。 */
function toSshHostKeyCheck(
  config: SshTunnelConfig,
  error: SshTunnelError
): SshHostKeyCheck | undefined {
  if (
    error.hostKeySha256 === undefined ||
    (error.code !== 'ssh_host_unverified' && error.code !== 'ssh_host_key_mismatch')
  ) {
    return undefined
  }
  return {
    host: config.host,
    port: config.port,
    fingerprint: error.hostKeySha256,
    ...(error.expectedHostKeySha256 === undefined
      ? {}
      : { expectedFingerprint: error.expectedHostKeySha256 }),
    state: error.code === 'ssh_host_key_mismatch' ? 'mismatch' : 'unverified'
  }
}

/** 非法 sslmode 的报错（单独拆出来只是为了让上面的三元表达式读得下去）。 */
function invalidSslMode(raw: string): never {
  throw new PostgresAdapterError(
    'connection_failed',
    `不支持的 SSL 模式：${raw}（可选 disable / allow / prefer / require / verify-ca / verify-full）`
  )
}

/**
 * 显式事务控制语句的归类结果。
 *
 * ===== 为什么必须在 executeStatement 里单独处理这几条语句 =====
 *
 * `prepareGeneralStatement` 只把 DML/DDL 分出来，`BEGIN`/`COMMIT`/`ROLLBACK`
 * 这类会被归到 `kind: 'rows'`，然后走 `#runQuery` 直接发给服务端。
 * 但 `pg.Client` 不提供 `node:sqlite` 那样的 `isTransaction`，驱动只能自己记账
 * （`#inTransaction`）。如果只把语句发出去却不更新账本，就会出现"假空闲"：
 * 用户已在服务端开了真实事务，驱动却认为连接空闲。随后 `importBatch` 会把它
 * 当空闲连接，再发一次 `BEGIN`（PG 里只是嵌套告警），最后在导入收尾时 COMMIT，
 * **把用户的事务一起提交**。连接级租约只能隔离在途请求，识别不了这种假空闲。
 *
 * 这里只做**可判定**的最小同步：
 *   - BEGIN / START TRANSACTION          → 进入事务
 *   - COMMIT / END                       → 离开事务
 *   - ROLLBACK / ABORT                   → 离开事务
 *   - ROLLBACK ... TO [SAVEPOINT] ...    → 仍留在事务里（绝不标成空闲）
 *   - COMMIT/ROLLBACK PREPARED           → 作用于两阶段事务，不改本连接事务状态
 * 拿不准语义的形式（AND CHAIN、PREPARE TRANSACTION、裸 START）显式拒绝，
 * 让用户改用既有的事务 API，绝不猜着同步、也绝不偷偷提交用户事务。
 */
type TxControlAction = 'begin' | 'commit' | 'rollback' | 'rollback_to' | 'no_state_change'

type TxControlDirective =
  | { readonly kind: 'state'; readonly action: TxControlAction }
  | { readonly kind: 'unsupported'; readonly form: string }

/** 只取 SQL 开头若干个"词"，跳过空白、注释与引号内容；够判定事务控制首词即可。 */
function leadingSqlWords(sql: string, limit: number): string[] {
  const words: string[] = []
  let index = 0
  while (index < sql.length && words.length < limit) {
    const ch = sql[index]
    if (ch === undefined || ch === ';') break
    if (ch === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (ch === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      index += 1
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = index + 1
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end] as string)) end += 1
      words.push(sql.slice(index, end).toLowerCase())
      index = end
      continue
    }
    if (/[0-9]/.test(ch)) {
      let end = index + 1
      while (end < sql.length && /[0-9.]/.test(sql[end] as string)) end += 1
      index = end
      continue
    }
    if (ch === '(') break
    index += 1
  }
  return words
}

/** 是否出现 `AND CHAIN`（`AND NO CHAIN` 是默认语义，不算）。 */
function hasAndChain(words: readonly string[]): boolean {
  const index = words.indexOf('chain')
  if (index === -1) return false
  return words[index - 1] !== 'no'
}

/** 识别显式事务控制语句；非事务控制返回 null。 */
function classifyTransactionControl(sql: string): TxControlDirective | null {
  const words = leadingSqlWords(sql, 8)
  const first = words[0]
  if (first === undefined) return null

  switch (first) {
    case 'begin':
      return { kind: 'state', action: 'begin' }
    case 'start':
      return words[1] === 'transaction'
        ? { kind: 'state', action: 'begin' }
        : { kind: 'unsupported', form: 'START（缺少 TRANSACTION）' }
    case 'commit':
    case 'end':
      // PREPARED 操作的是两阶段事务，不是本连接当前事务，状态不动。
      if (words[1] === 'prepared') return { kind: 'state', action: 'no_state_change' }
      if (hasAndChain(words)) return { kind: 'unsupported', form: `${first.toUpperCase()} ... AND CHAIN` }
      return { kind: 'state', action: 'commit' }
    case 'rollback':
    case 'abort': {
      if (words[1] === 'prepared') return { kind: 'state', action: 'no_state_change' }
      // 先判 TO：ROLLBACK TO SAVEPOINT 只回退到保存点，事务仍然活动。
      if (words.indexOf('to') > 0) return { kind: 'state', action: 'rollback_to' }
      if (hasAndChain(words)) return { kind: 'unsupported', form: `${first.toUpperCase()} ... AND CHAIN` }
      return { kind: 'state', action: 'rollback' }
    }
    case 'prepare':
      return words[1] === 'transaction'
        ? { kind: 'unsupported', form: 'PREPARE TRANSACTION' }
        : null
    default:
      return null
  }
}

export class PostgresDriverAdapter implements DriverAdapter {
  readonly dialect = postgresqlDialect
  readonly info = POSTGRESQL_INFO

  /**
   * 当前连接。用 `pg.Client`（单连接），不用 `pg.Pool`。
   *
   * ===== 为什么是 Client 而不是 Pool =====
   *
   * 剖析报告（01-connection-driver.md）的核心结论之一是：DBeaver 的用户连接**不进池**，
   * 连接由各执行上下文按需持有。本项目沿用同一决策：一个宿主进程 = 一个连接。
   * 用 `Pool` 会引入一个本不该存在的连接池维度（池大小、借还、空闲回收），
   * 而架构上"一个连接一个进程"已经让池失去了存在意义——进程里永远只有一条逻辑连接。
   * 这也是"不该照搬"清单里明确的一条（见项目 README 的对照表）。
   */
  #client: Client | null = null
  #cursors = new Map<string, CursorState>()
  #pendingAffected = 0
  /**
   * 当前是否在显式事务里。
   *
   * `pg.Client` 没有 `node:sqlite` 那样的 `isTransaction` 属性，所以必须自己维护。
   * 这是本 adapter 里唯一"驱动不提供、只能自己记账"的状态——
   * 权威来源是**我们发出的 BEGIN/COMMIT/ROLLBACK 语句**，而不是猜测。
   */
  #inTransaction = false
  /** 当前事务是否由 CSV 导入创建；用于阻止导入复用/提交用户的编辑事务。 */
  #importActive = false
  /**
   * 本连接的后端 PID，用于取消查询（`pg_cancel_backend(pid)`）。
   * 连接建立后立刻取；取不到时为 null，此时 cancelQuery 会如实返回 false。
   */
  #backendPid: number | null = null
  /** 建连参数（取消时需要用它另开一条连接）。未连接时为 null。 */
  #connectionInfo: PgConnectionInfo | null = null
  /**
   * 当前 SSH 隧道。未启用隧道时为 null。
   *
   * ===== 为什么它挂在 adapter 上，而不是每次连接临时创建 =====
   * 一次数据库连接期间可能需要多条 channel（SSL 回退尝试、取消查询）。
   * 让它们复用同一条 SSH 连接，避免重复做 SSH 认证，也不会在跳板机
   * 日志里刷出一堆会话。`disconnect` 时关闭，不留孤儿连接。
   */
  #tunnel: SshTunnel | null = null

  async connect(config: ConnectionConfig, secret: SecretValue): Promise<DriverCapabilities> {
    if (this.#client !== null) {
      throw new PostgresAdapterError('already_connected', '该适配器实例已持有一个连接，请先 disconnect 再重新连接。')
    }
    const info = resolveConnectionInfo(config, secret)
    /**
     * 隧道模式下先建 SSH，再把通道交给 pg。
     *
     * 隧道建立失败要**原样抛出 SshTunnelError**（尤其是 ssh_host_unverified，
     * 它带着指纹供用户确认）。若被 `wrapPgError` 包成通用的
     * "无法连接到 PostgreSQL"，UI 就没法区分"该确认主机指纹"和"密码错了"。
     */
    if (info.ssh !== undefined) {
      try {
        this.#tunnel = await openSshTunnel(info.ssh, info.sshCredentials ?? { password: undefined, privateKeyPassphrase: undefined })
      } catch (thrown) {
        throw wrapSshError(thrown)
      }
    }
    let client: Client
    try {
      /**
       * 建连走 `openClient`，而不是直接 `new Client()`：
       * sslmode 的尝试/回退逻辑（尤其 prefer/allow）在那一层实现。
       * 见 ssl.ts 文件头「为什么不直接把 sslmode 丢给 pg」。
       */
      client = await openClient({
        host: info.host,
        port: info.port,
        database: info.database,
        user: info.user,
        password: info.password,
        attempts: info.sslAttempts,
        // 有隧道就每次用新 channel（一条 channel 不能被两次连接复用）。
        ...(this.#tunnel === null ? {} : { openStream: () => this.#tunnel!.forward() }),
        // 连接超时：与 SQLite 的 BUSY_TIMEOUT 不同，PG 必须防"TCP 连不上挂死"
        connectionTimeoutMillis: 10_000,
        // 应用名，方便 DBA 在 pg_stat_activity 里认出是本客户端
        applicationName: 'dbstudio'
      })
    } catch (thrown) {
      // 建连失败时隧道也要收掉：留着没有消费者，只是占着跳板机的一条会话。
      await this.#closeTunnel()
      throw wrapPgError(thrown, 'connection_failed', `无法连接到 PostgreSQL ${info.host}:${info.port}/${info.database}`)
    }
    this.#client = client
    this.#connectionInfo = info
    this.#inTransaction = false
    this.#importActive = false
    this.#pendingAffected = 0
    /**
     * 记下后端 PID，供取消使用。
     * 失败不致命（连接本身可用），只是 cancelQuery 会退化为返回 false。
     */
    try {
      const pidResult = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const pid = pidResult.rows[0]?.pid
      this.#backendPid = typeof pid === 'number' && Number.isInteger(pid) ? pid : null
    } catch {
      this.#backendPid = null
    }
    return POSTGRESQL_CAPABILITIES
  }

  /**
   * 断开连接。**必须幂等**：宿主进程结束时会对同一个实例再调一次。
   * 有未提交事务时先 ROLLBACK 再 end（与 SQLite 版同语义：未提交改动不带进下一次连接）。
   */
  async disconnect(): Promise<void> {
    const client = this.#client
    /*
     * 事务状态必须在清空字段**之前**记下。
     *
     * 早先先执行 `#inTransaction = false` 再判断，导致带未提交事务的
     * disconnect 永远不会发 ROLLBACK。现在与 SQLite 版保持同一语义：
     * 先显式回滚，再关连接；即便底层关闭本身也会回滚，也不依赖它兜底。
     */
    const inTransaction = this.#inTransaction
    this.#client = null
    this.#cursors.clear()
    this.#pendingAffected = 0
    this.#inTransaction = false
    this.#importActive = false
    this.#backendPid = null
    this.#connectionInfo = null
    if (client === null) {
      /**
       * 注意这里也要关隧道：SSH 建立成功、但数据库建连失败的那条路径上，
       * `#client` 仍然是 null，而隧道可能已经建立（或在失败的 catch 里被关掉）。
       * 漏掉这一句就会在"SSH 通了、数据库连不上"时留下一条孤儿会话。
       */
      await this.#closeTunnel()
      return
    }
    try {
      if (inTransaction) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // 回滚失败也只能继续关连接
        }
      }
    } finally {
      try {
        await client.end()
      } catch {
        // end 失败时忽略：进程即将退出
      }
      // 顺序：先关数据库连接，再关隧道。反过来的话，pg 的 end() 会往一条
      // 已经断掉的通道里写终止包，日志里会出现无意义的错误。
      await this.#closeTunnel()
    }
  }

  /** 关闭并清空隧道。幂等——disconnect 会被宿主在退出时再调一次。 */
  async #closeTunnel(): Promise<void> {
    const tunnel = this.#tunnel
    this.#tunnel = null
    if (tunnel === null) return
    try {
      await tunnel.close()
    } catch {
      // 关闭失败不影响主流程：进程即将退出，或隧道本就已经断了
    }
  }

  /**
   * 测试连接：真建一条再关掉，不保留（与 SQLite / DBeaver 同语义）。
   * 返回结果对象而不是抛错——调用方（连接对话框）需要展示失败原因。
   */
  async testConnection(config: ConnectionConfig, secret: SecretValue): Promise<TestConnectionResult> {
    const startedAt = performance.now()
    const checks: ConnectionTestCheck[] = []
    let info: PgConnectionInfo | null = null
    let client: Client | null = null
    let tunnel: SshTunnel | null = null
    try {
      info = resolveConnectionInfo(config, secret)
      recordCheck(checks, 'config', 'passed', '连接参数解析通过')
      if (info.ssh !== undefined) {
        const sshStartedAt = performance.now()
        tunnel = await openSshTunnel(
          info.ssh,
          info.sshCredentials ?? { password: undefined, privateKeyPassphrase: undefined }
        )
        recordCheck(
          checks,
          'ssh_connect',
          'passed',
          `SSH 已连接 ${info.ssh.host}:${info.ssh.port}`,
          Math.round(performance.now() - sshStartedAt)
        )
        recordCheck(checks, 'ssh_host_key', 'passed', 'SSH 主机密钥与已保存指纹一致')
        recordCheck(checks, 'ssh_auth', 'passed', 'SSH 认证通过')
      } else {
        recordCheck(checks, 'ssh_connect', 'skipped', '未启用 SSH 隧道')
        recordCheck(checks, 'ssh_host_key', 'skipped', '未启用 SSH 隧道')
        recordCheck(checks, 'ssh_auth', 'skipped', '未启用 SSH 隧道')
        recordCheck(checks, 'ssh_forward', 'skipped', '未启用 SSH 隧道')
      }
      const databaseStartedAt = performance.now()
      client = await openClient({
        host: info.host,
        port: info.port,
        database: info.database,
        user: info.user,
        password: info.password,
        attempts: info.sslAttempts,
        ...(tunnel === null ? {} : { openStream: () => tunnel!.forward() }),
        connectionTimeoutMillis: 10_000,
        applicationName: 'dbstudio'
      })
      if (info.ssh !== undefined) {
        recordCheck(
          checks,
          'ssh_forward',
          'passed',
          `SSH 转发通道可用，目标 ${info.ssh.targetHost}:${info.ssh.targetPort}`
        )
      }
      checks.push({
        stage: 'database',
        status: 'passed',
        message: `已连接数据库 ${info.host}:${info.port}/${info.database}`,
        elapsedMs: Math.round(performance.now() - databaseStartedAt)
      })
      const queryStartedAt = performance.now()
      const versionResult = await client.query<{ version: string }>('SELECT version() AS version')
      checks.push({
        stage: 'server_query',
        status: 'passed',
        message: '服务端探测查询通过',
        elapsedMs: Math.round(performance.now() - queryStartedAt)
      })
      const serverVersion = versionResult.rows[0]?.version
      return {
        ok: true,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...(serverVersion === undefined ? {} : { serverVersion }),
        checks
      }
    } catch (thrown) {
      let failedStage: ConnectionTestStage =
        client !== null ? 'server_query' : info === null ? 'config' : 'database'
      let message: string
      let sshHostKey: SshHostKeyCheck | undefined
      if (thrown instanceof SshTunnelError) {
        failedStage = sshFailureStage(thrown)
        message = thrown.message
        if (info?.ssh !== undefined) sshHostKey = toSshHostKeyCheck(info.ssh, thrown)
      } else if (thrown instanceof PostgresAdapterError) {
        message = thrown.message
        if (info === null) failedStage = 'config'
        else if (tunnel === null) failedStage = info.ssh === undefined ? 'database' : 'ssh_connect'
        else {
          // 非 SSH 异常出现在 openClient 内，说明 openStream 已成功拿到 channel；
          // 真正卡住的是其后的 PG 握手/认证，而不是 SSH 转发。
          if (client === null && info.ssh !== undefined) {
            recordCheck(
              checks,
              'ssh_forward',
              'passed',
              `SSH 转发通道可用，目标 ${info.ssh.targetHost}:${info.ssh.targetPort}`
            )
          }
          failedStage = client === null ? 'database' : 'server_query'
        }
      } else {
        message = `连接失败：${describeThrown(thrown)}`
      }
      // 失败之前的阶段已经通过；把当前阶段标红，后面的阶段保持未执行，
      // 而不是伪造 skipped — 用户能看出诊断停在哪一步。
      recordCheck(checks, failedStage, 'failed', message)
      return {
        ok: false,
        message,
        elapsedMs: Math.round(performance.now() - startedAt),
        checks,
        ...(sshHostKey === undefined ? {} : { sshHostKey })
      }
    } finally {
      if (client !== null) {
        try {
          await client.end()
        } catch {
          // ignore
        }
      }
      // 测试连接=临时建一条再关掉，隧道也必须一起收（不留孤儿会话）。
      if (tunnel !== null) {
        try {
          await tunnel.close()
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * 列出子节点（懒加载，只返回直接子节点）。
   *
   * ===== 结构：schema 分组（与 SQLite 完全不同）=====
   *
   *   null
   *    └── folder:schemas               ← 根层唯一分组
   *         └── schema:<name>            ← 每个用户 schema
   *              ├── folder:<schema>|tables
   *              │    └── table:<schema>.<name>
   *              │         └── column:<schema>.<table>.<col>
   *              └── folder:<schema>|views
   *                   └── view:<schema>.<name>
   *
   * 依据：本项目 03-metadata-dialect 记录 PG 是 `catalog=USAGE_DML, schema=USAGE_ALL`——
   * schema 才是真正用于限定表名的命名空间，所以树里展开的是 schema 而不是 catalog。
   */
  async listChildren(parentId: string | null): Promise<ObjectRef[]> {
    const client = this.#requireClient()

    // 根层：只有 schema 分组
    if (parentId === null) {
      return [
        { id: SCHEMAS_FOLDER_ID, kind: 'folder', name: 'Schema', parentId: null, hasChildren: true }
      ]
    }

    const parsed = parseObjectId(parentId)
    if (parsed === null) {
      throw new PostgresAdapterError('object_not_found', `无法识别的对象 id：${parentId}`)
    }

    switch (parsed.kind) {
      case 'schemas-folder':
        return this.#listSchemas(client)
      case 'schema':
        return [
          { id: schemaFolderId(parsed.schema, 'tables'), kind: 'folder', name: '表', parentId: parentId, hasChildren: true },
          { id: schemaFolderId(parsed.schema, 'views'), kind: 'folder', name: '视图', parentId: parentId, hasChildren: true }
        ]
      case 'folder':
        return this.#listRelations(client, parsed.schema, parsed.folder)
      case 'table':
        return this.#listColumns(client, parsed.schema, parsed.name, tableObjectId(parsed.schema, parsed.name))
      case 'view':
        return this.#listColumns(client, parsed.schema, parsed.name, viewObjectId(parsed.schema, parsed.name))
      case 'column':
        return []
    }
  }

  /**
   * 读取表结构：列 + 唯一键判定。
   *
   * ===== 主键判定（PG 特有）=====
   *
   * 用 `information_schema.table_constraints` + `key_column_usage`：
   *   1. 先找该表的 `PRIMARY KEY` 约束名；
   *   2. 再从 `key_column_usage` 拿主键列与 `ordinal_position`（主键内序号）。
   * 这比 `pg_index` 更标准、更易读；`pg_index` 的优势是快（一次 join 不跨三张系统视图），
   * 但本阶段数据量小，可读性优先（与任务说明"优先 information_schema，需要性能时用 pg_catalog"一致）。
   */
  /**
   * 读取视图定义。
   *
   * 用 `pg_get_viewdef(oid, true)`：第二个参数 pretty=true 让输出带缩进，
   * 便于用户在差异里阅读。**参数化查询**，不拼接名字——视图名可能含引号或
   * 大小写，拼接既有注入风险又容易引错对象。
   *
   * 只认 `relkind = 'v'`（普通视图）；物化视图是 'm'，暂不纳入结构比较范围
   * （它们是"有数据的物化结果"，刷新语义与普通视图不同，混在一起比会误导）。
   */
  async viewDefinition(id: string): Promise<string | null> {
    const client = this.#requireClient()
    const parsed = parseObjectId(id)
    if (parsed === null || parsed.kind !== 'view') {
      throw new PostgresAdapterError(
        'object_not_found',
        `viewDefinition 只接受视图节点，收到的 id 是：${id}`
      )
    }
    const result = await client.query(
      `SELECT pg_get_viewdef(c.oid, true) AS definition
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'v' AND n.nspname = $1 AND c.relname = $2`,
      [parsed.schema, parsed.name]
    )
    const definition = result.rows[0]?.definition
    return typeof definition === 'string' ? definition : null
  }

  /**
   * 列出例程（函数 / 存储过程）及其定义。
   *
   * ===== 关键取舍 =====
   * 1. 只取 `prokind IN ('f','p')`：聚合函数是 'a'、窗口函数是 'w'，
   *    `pg_get_functiondef` 对它们会直接报错（PostgreSQL 限制），必须先过滤掉，
   *    否则一条聚合函数就能让整个例程读取失败。
   * 2. 排除系统 schema，否则会把上千个 pg_catalog 内置函数全列出来。
   * 3. **定义按例程隔离失败**：某个函数拿不到定义（比如被 drop 或权限不足）时，
   *    只把它的 definition 记为 null 继续，不让整次采集失败——这与
   *    describeTable 里"元数据读失败不拖垮整表"的原则一致。
   */
  async listRoutines(options?: { schema?: string | null }): Promise<RoutineInfo[]> {
    const client = this.#requireClient()
    const params: string[] = []
    let schemaFilter = ''
    if (options?.schema) {
      params.push(options.schema)
      schemaFilter = ` AND n.nspname = $${params.length}`
    }
    const result = await client.query(
      `SELECT n.nspname AS schema,
              p.proname AS name,
              CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END AS kind,
              p.oid::text AS oid,
              pg_get_function_identity_arguments(p.oid) AS signature
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prokind IN ('f', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          ${schemaFilter}
        ORDER BY n.nspname, p.proname`,
      params
    )
    const routines: RoutineInfo[] = []
    for (const row of result.rows as {
      schema: string
      name: string
      kind: 'function' | 'procedure'
      oid: string
      signature: string | null
    }[]) {
      let definition: string | null = null
      try {
        const defResult = await client.query('SELECT pg_get_functiondef($1::oid) AS definition', [row.oid])
        const text = defResult.rows[0]?.definition
        if (typeof text === 'string') definition = text
      } catch {
        // 单个例程拿不到定义：留 null，由上层告警"定义未捕获"，不影响其它例程。
        definition = null
      }
      /*
       * signature 用于区分重载：PG 允许 f(int) 与 f(text) 共存，
       * 比较器按 name+签名对齐，DROP 语句也必须带参数类型才合法。
       * `pg_get_function_identity_arguments` 返回的正是 DROP 需要的形态
       * （如 `integer, text`），按逗号切分即可；无参函数返回空串 → []。
       */
      const signature = (row.signature ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
      routines.push({ schema: row.schema, name: row.name, kind: row.kind, definition, signature })
    }
    return routines
  }

  /** 按对象 id 生成限定到 schema 的 SELECT。 */
  async tableSelectSql(nodeId: string): Promise<string> {
    const parsed = parseObjectId(nodeId)
    if (parsed === null || (parsed.kind !== 'table' && parsed.kind !== 'view')) {
      throw new PostgresAdapterError('object_not_found', `tableSelectSql 只接受表或视图节点：${nodeId}`)
    }
    return `SELECT * FROM ${this.dialect.quoteIdentifier(parsed.schema)}.${this.dialect.quoteIdentifier(parsed.name)}`
  }

  async describeTable(id: string): Promise<TableDescription> {
    const client = this.#requireClient()
    const parsed = parseObjectId(id)
    if (parsed === null || (parsed.kind !== 'table' && parsed.kind !== 'view')) {
      throw new PostgresAdapterError('object_not_found', `describeTable 只接受表或视图节点，收到的 id 是：${id}`)
    }
    const columns = await this.#readColumns(client, parsed.schema, parsed.name)
    const canonicalId = parsed.kind === 'table' ? tableObjectId(parsed.schema, parsed.name) : viewObjectId(parsed.schema, parsed.name)
    const description: TableDescription = {
      id: canonicalId,
      columns,
      hasUniqueKey: columns.some((column) => column.primaryKeyOrdinal !== null)
    }
    // 视图也读元数据：PG 的视图没有外键/索引/唯一约束/CHECK，
    // 但可以有 INSTEAD OF 触发器——那是真实存在的对象。
    // 与 SQLite 侧同一分层（视图同样走 #withMetadata），
    // 这样 UI 对视图看到的也是"确定没有外键"而不是"不知道"。
    return this.#withMetadata(client, parsed.schema, parsed.name, description)
  }

  /**
   * 追加结构元数据（外键 / 索引 / 唯一约束 / CHECK / 触发器）。
   *
   * ===== 为什么失败时整个字段留空，而不是让 describeTable 抛错 =====
   *
   * 与 SQLite 侧同一取舍（见 `sqlite/adapter.ts` 的 `#withMetadata`）：
   * `describeTable` 的本职是"告诉 UI 这张表长什么样"——
   * 列和唯一键是**网格能否工作**的前提，丢了整张表就打不开。
   * 而外键、索引这些是**附加信息**：读不到只是 ER 图少画几条线，
   * 不该让用户连表都看不到。
   *
   * 所以这里是"尽力而为"：读失败就**整块省略**这些字段，
   * 让 UI 落到 `metadataAvailability()` 的 'unavailable' 状态，
   * 而不是把它误显示成"这张表没有外键"。
   */
  async #withMetadata(
    client: Client,
    schema: string,
    tableName: string,
    description: TableDescription
  ): Promise<TableDescription> {
    try {
      const metadata = await readPostgresTableMetadata(
        (sql, params) => this.#runQuery(client, sql, params),
        schema,
        tableName
      )
      return { ...description, ...metadata }
    } catch (thrown) {
      // 只吞"读元数据失败"，不吞参数/状态错误：
      // 那些是真正的 bug，应该让测试看见，而不是被静默降级。
      if (!(thrown instanceof PostgresAdapterError)) throw thrown
      return description
    }
  }

  /**
   * 取消当前正在执行的查询。
   *
   * 用**独立连接**执行 `pg_cancel_backend(pid)`——不能在主连接上发：
   * 那条连接正忙着跑长查询，新语句只会排在它后面，等于没取消
   * （机制详见 query-cancel.ts）。
   *
   * 返回 false 的情形：未连接、PID 未知、服务端拒绝取消（比如语句已结束）。
   * 取消是尽力而为的动作，失败不抛错。
   */
  async cancelQuery(): Promise<boolean> {
    const info = this.#connectionInfo
    if (this.#client === null || info === null || this.#backendPid === null) return false
    const tunnel = this.#tunnel
    return cancelPostgresBackend({
      ...info,
      backendPid: this.#backendPid,
      // 取消连接也要穿过同一条隧道（在隧道上开新 channel）。
      ...(tunnel === null ? {} : { openStream: () => tunnel.forward() })
    })
  }

  async query(sql: string, options?: QueryOptions): Promise<QueryResultContract> {
    const client = this.#requireClient()
    const bound = bindSqlParameters(sql, options?.parameters, 'postgresql')
    const statementSql = prepareReadOnlyStatement(bound.sql)
    return this.#queryBound(client, statementSql, toPgValues(bound.values), options)
  }

  async #queryBound(
    client: Client,
    statementSql: string,
    params: readonly unknown[],
    options?: QueryOptions
  ): Promise<QueryResultContract> {
    const limit = normalizePageSize(options?.limit)
    const offset = normalizeOffset(options?.offset)
    const executedSql = buildPagedSql(statementSql, limit, offset)

    const startedAt = performance.now()
    const result = await this.#runQuery(client, executedSql, params)
    const elapsedMs = Math.round(performance.now() - startedAt)

    const grid = buildGrid(result as unknown as PgResultLike)
    const cursorId = options?.keepCursor === false ? null : this.#openCursor(statementSql, params)

    return {
      columns: buildColumns(grid.names, grid.rows),
      rows: buildRows(grid.names, grid.rows, offset),
      offset,
      returned: grid.rows.length,
      hasMore: grid.rows.length === limit,
      cursorId,
      executedSql,
      elapsedMs
    }
  }

  async explain(sql: string): Promise<ExplainResult> {
    const client = this.#requireClient()
    const executedSql = this.dialect.buildExplainQuery(prepareReadOnlyStatement(sql))
    const result = await this.#runQuery(client, executedSql)
    const grid = buildGrid(result as unknown as PgResultLike)
    return {
      dialectId: this.dialect.id,
      columns: buildColumns(grid.names, grid.rows),
      rows: buildRows(grid.names, grid.rows, 0),
      format: 'json',
      executedSql
    }
  }

  async executeStatement(sql: string, options?: QueryOptions): Promise<StatementResult> {
    const client = this.#requireClient()
    const bound = bindSqlParameters(sql, options?.parameters, 'postgresql')
    const analyzed = prepareGeneralStatement(bound.sql)
    const startedAt = performance.now()

    if (analyzed.kind === 'rows') {
      /**
       * 显式事务控制必须先归类、再执行、**成功之后**才更新内部账本。
       * 失败时绝不改状态（保守保留用户事务），见文件顶部的类型注释。
       */
      const txDirective = classifyTransactionControl(analyzed.statementSql)
      if (txDirective !== null) {
        if (txDirective.kind === 'unsupported') {
          throw new PostgresAdapterError(
            'bad_params',
            `查询窗口无法可靠同步「${txDirective.form}」的事务状态，已拒绝执行。` +
              '请改用事务工具栏（提交/回滚）等既有事务 API，避免驱动误判事务状态或误提交你的改动。'
          )
        }
        /**
         * 导入事务的所有权只属于导入流程。导入进行中若从 SQL 窗口手动控制事务，
         * 轻则打乱原子性（把已导入的行提前提交/回滚），重则让后续批次复用错误状态。
         * 这里直接拒绝，不扩大到让导入 API 之外的人来控制它。
         */
        if (this.#importActive && txDirective.action !== 'no_state_change') {
          throw new PostgresAdapterError(
            'bad_params',
            '当前连接正在执行 CSV 导入，导入事务只能由导入流程自身结束。' +
              '请等待导入完成或取消导入后，再手动控制事务。'
          )
        }
      }
      if (PAGINATABLE_KEYWORDS.has(analyzed.keyword)) {
        const result = await this.#queryBound(client, analyzed.statementSql, toPgValues(bound.values), options)
        return { kind: 'rows', result }
      }
      const res = await this.#runQuery(client, analyzed.statementSql, toPgValues(bound.values))
      if (txDirective !== null && txDirective.kind === 'state') {
        this.#applyTransactionControl(txDirective.action)
      }
      const elapsedMs = Math.round(performance.now() - startedAt)
      const grid = buildGrid(res as unknown as PgResultLike)
      return {
        kind: 'rows',
        result: {
          columns: buildColumns(grid.names, grid.rows),
          rows: buildRows(grid.names, grid.rows, 0),
          offset: 0,
          returned: grid.rows.length,
          hasMore: false,
          cursorId: null,
          executedSql: analyzed.statementSql,
          elapsedMs
        }
      }
    }

    if (analyzed.kind === 'affected') {
      const inOwnTransaction = await this.#ensureTransaction(client)
      let rowCount = 0
      try {
        const res = await client.query(analyzed.statementSql, toPgValues(bound.values))
        rowCount = res.rowCount ?? 0
        this.#pendingAffected += rowCount
      } catch (thrown) {
        await this.#releaseFailedOwnTransaction(client, inOwnTransaction)
        throw wrapPgError(thrown, 'query_failed', '执行语句失败')
      }
      const elapsedMs = Math.round(performance.now() - startedAt)
      const txState = await this.transactionState()
      return {
        kind: 'affected',
        affected: rowCount,
        inTransaction: txState.active,
        transactionState: txState,
        executedSql: analyzed.statementSql,
        elapsedMs
      }
    }

    // ddl
    let command = ''
    try {
      const res = await client.query(analyzed.statementSql, toPgValues(bound.values))
      command = res.command ?? `${analyzed.keyword.toUpperCase()} 语句执行完成`
    } catch (thrown) {
      throw wrapPgError(thrown, 'query_failed', '执行 DDL 失败')
    }
    const elapsedMs = Math.round(performance.now() - startedAt)
    const txState = await this.transactionState()
    const snippet = analyzed.statementSql.replace(/\s+/g, ' ').trim().slice(0, 50)
    return {
      kind: 'ddl',
      summary: `${snippet} 已完成`,
      committed: !txState.active,
      executedSql: analyzed.statementSql,
      elapsedMs
    }
  }

  /**
   * 把对象节点解析成「读取语句 + INSERT 落点」。
   *
   * ===== 为什么必须由驱动解析 =====
   *
   * PostgreSQL 的对象 id 是 `table:<schema>.<name>`——**带 schema**。
   * 主进程若自己切冒号，会把 `public.users` 整体当成表名，
   * 生成 `SELECT * FROM "public.users"` 这种**指错对象**的语句
   * （该名字很可能不存在，或更糟：恰好存在一张同名表）。
   *
   * schema 还必须原样带进 INSERT 目标：`public.users` 与 `audit.users`
   * 是两张不同的表，只写表名会插到 `search_path` 命中的第一张同名表上。
   *
   * 视图不能作为 INSERT 目标（`kind: 'view'`），上层据此拒绝 sql-insert 格式。
   */
  async resolveTransferSource(nodeId: string): Promise<TransferSourceResolution> {
    const parsed = parseObjectId(nodeId)
    if (parsed === null || (parsed.kind !== 'table' && parsed.kind !== 'view')) {
      throw new PostgresAdapterError(
        'object_not_found',
        `无法识别的导出对象 id：${nodeId}（只支持表与视图节点）`
      )
    }
    const quotedSchema = this.dialect.quoteIdentifier(parsed.schema)
    const quotedName = this.dialect.quoteIdentifier(parsed.name)
    return {
      sql: `SELECT * FROM ${quotedSchema}.${quotedName}`,
      target: { schema: parsed.schema, name: parsed.name, kind: parsed.kind }
    }
  }

  async fetchResultPage(cursorId: string, offset: number, limit: number): Promise<ResultPage> {
    const client = this.#requireClient()
    const cursor = this.#cursors.get(cursorId)
    if (cursor === undefined) {
      throw new PostgresAdapterError('object_not_found', `结果集游标不存在或已关闭：${cursorId}（结果集可能已被关闭，或连接断过）`)
    }
    const pageSize = normalizePageSize(limit)
    const start = normalizeOffset(offset)
    const result = await this.#runQuery(client, buildPagedSql(cursor.sql, pageSize, start), toPgValues(cursor.params))
    const grid = buildGrid(result as unknown as PgResultLike)
    return {
      columns: buildColumns(grid.names, grid.rows),
      rows: buildRows(grid.names, grid.rows, start),
      offset: start,
      returned: grid.rows.length,
      hasMore: grid.rows.length === pageSize
    }
  }

  async closeCursor(cursorId: string): Promise<void> {
    this.#cursors.delete(cursorId)
  }

  /**
   * 插入一行并回传新行的主键值。
   *
   * PG 与 SQLite 的差异：SQLite 用 `lastInsertRowid`（且只对 rowid 别名有效）；
   * PG 用 `INSERT ... RETURNING <pk列>` —— 只要主键列已知，就直接让数据库回填。
   * 这是 PG 更好的地方：**不用像 SQLite 那样推断 rowid 别名**。
   */
  async insertRow(
    tableId: string,
    values: Readonly<Record<string, CellValue>>
  ): Promise<{ affected: number; keyValues: Record<string, CellValue> }> {
    const client = this.#requireClient()
    const target = await this.#resolveTableTarget(client, tableId, false)
    const normalized = normalizeValues(values, target.availableColumns)
    if (normalized.unknown.length > 0) {
      throw new PostgresAdapterError(
        'bad_params',
        `插入时引用了不存在的列：${normalized.unknown.join('、')}。「${target.tableName}」的可用列：${target.availableColumns.join('、')}`
      )
    }
    if (normalized.columns.length === 0) {
      throw new PostgresAdapterError('bad_params', '插入时必须至少提供一个列的值。若要插入全默认值行，请在 SQL 窗口执行 INSERT ... DEFAULT VALUES。')
    }

    const quote = this.dialect.quoteIdentifier.bind(this.dialect)
    const built = buildInsert(quote, target.schema, target.tableName, normalized.columns, normalized.byColumn)
    const inOwnTransaction = await this.#ensureTransaction(client)
    // RETURNING 主键列（若表有主键），让 UI 立刻能定位新行
    const returning = target.keyColumns.length > 0 ? ` RETURNING ${target.keyColumns.map((c) => quote(c)).join(', ')}` : ''
    let returnedRow: Record<string, unknown> | undefined
    try {
      const result = await client.query(`${built.sql}${returning}`, built.params as unknown[])
      returnedRow = result.rows[0]
    } catch (thrown) {
      await this.#releaseFailedOwnTransaction(client, inOwnTransaction)
      throw wrapPgError(thrown, 'query_failed', '插入失败')
    }
    this.#pendingAffected += 1

    const keyValues: Record<string, CellValue> = {}
    // 优先用 RETURNING 回来的主键值；若调用方也给了，则用调用方给的（更可靠）
    for (const key of target.keyColumns) {
      const given = normalized.byColumn.get(key)
      if (given !== undefined) {
        keyValues[key] = given
      } else if (returnedRow !== undefined && returnedRow[key] !== undefined) {
        keyValues[key] = toCellValue(returnedRow[key])
      }
    }
    return { affected: 1, keyValues }
  }

  /**
   * 批量写入 CSV 行。每个值都走参数绑定，标识符由方言 quoteIdentifier 处理。
   *
   * 逐行执行而不是拼一条多行 VALUES：多行语句失败时数据库只给一个笼统错误，
   * 无法指认是哪一行/哪一列；逐行执行能准确返回 CSV 行号，同时仍由同一事务
   * 保证整次导入原子性。
   */
  async importBatch(tableId: string, batch: ImportBatch): Promise<ImportBatchResult> {
    const client = this.#requireClient()
    const target = await this.#resolveTableTarget(client, tableId, false)
    const resolved = resolveColumns(batch.columns, target.availableColumns)
    if (resolved.unknown.length > 0) {
      throw new PostgresAdapterError(
        'bad_params',
        `导入目标列不存在：${resolved.unknown.join('、')}。「${target.tableName}」的可用列：` +
          target.availableColumns.join('、')
      )
    }
    const columns = resolved.matched.map((match) => match.canonical)
    if (new Set(columns).size !== columns.length) {
      throw new PostgresAdapterError('bad_params', '导入目标列重复，无法确定每个 CSV 值应写入哪一列。')
    }
    if (batch.rows.length === 0) {
      throw new PostgresAdapterError('bad_params', '导入批次为空，已拒绝执行。')
    }
    for (let index = 0; index < batch.rows.length; index += 1) {
      const row = batch.rows[index]
      if (row === undefined) continue
      if (row.values.length !== columns.length) {
        throw new PostgresAdapterError(
          'bad_params',
          `导入批次第 ${index + 1} 行（CSV 数据第 ${row.rowNumber} 行）有 ${row.values.length} 个值，` +
            `但目标列有 ${columns.length} 个。`
        )
      }
    }

    if (this.#importActive) {
      if (!this.#inTransaction) {
        throw new PostgresAdapterError('query_failed', '导入事务已意外结束，无法继续写入；请重新开始导入。')
      }
    } else {
      if (this.#inTransaction) {
        throw new PostgresAdapterError(
          'bad_params',
          '目标连接上已有未提交事务。请先提交或回滚该事务，再开始 CSV 导入，' +
            '以免导入把无关改动一起提交。'
        )
      }
      await this.#ensureTransaction(client)
      this.#importActive = true
    }

    const quote = this.dialect.quoteIdentifier.bind(this.dialect)
    let imported = 0
    for (let index = 0; index < batch.rows.length; index += 1) {
      const row = batch.rows[index]
      if (row === undefined) continue
      const byColumn = new Map(
        columns.map((column, columnIndex) => {
          const value = row.values[columnIndex]
          if (value === undefined) throw new Error(`缺少列「${column}」的值`)
          return [column, value] as const
        })
      )
      const built = buildInsert(quote, target.schema, target.tableName, columns, byColumn)
      const physical = row.lineNumber === undefined ? '' : `（文件物理第 ${row.lineNumber} 行）`
      let rowCount = 0
      try {
        const result = await client.query(built.sql, built.params as unknown[])
        rowCount = result.rowCount ?? 0
      } catch (thrown) {
        /**
         * **不回显引擎原文**（含 `invalid input syntax ...: "abc"`、
         * `Key (email)=(x@y.z) already exists.` 这类带数据的原始消息）。
         * 只输出：服务器给的结构化信息（SQLSTATE / 严重级别 / 约束 / 表）+
         * 行列定位 + 白名单列名。
         */
        const raw = describeThrown(thrown)
        const column =
          importErrorColumn(raw, columns, readPgErrorField(thrown, 'column')) ?? columns.join('、')
        throw new PostgresAdapterError(
          'query_failed',
          `导入第 ${batch.batchIndex + 1} 批第 ${index + 1} 行（CSV 数据第 ${row.rowNumber} 行${physical}）` +
            `写入列「${column}」失败：${describePgImportFailure(thrown)}`,
          pgImportFailureCause(thrown)
        )
      }
      /**
       * ===== 必须核对实际写入行数 =====
       *
       * `BEFORE INSERT` 触发器返回 NULL 会让这一行**根本没写进去**，
       * 但语句照样成功、`rowCount` 为 0。若照样算作已导入，
       * 上层看到"已写入行数 == 批次行数"就会直接 COMMIT —— 静默丢数据。
       * 所以对不上就失败，由上层回滚整个导入（与 SQLite 驱动同一口径）。
       */
      if (rowCount !== 1) {
        throw new PostgresAdapterError(
          'query_failed',
          `导入第 ${batch.batchIndex + 1} 批第 ${index + 1} 行（CSV 数据第 ${row.rowNumber} 行${physical}）` +
            `写入失败：数据库没有写入这一行（实际影响行数为 ${rowCount}，常见原因是 BEFORE INSERT 触发器 ` +
            '返回了 NULL）。已中止导入并请求回滚，以免静默丢数据。'
        )
      }
      imported += rowCount
    }

    this.#pendingAffected += imported
    return { rowsImported: imported, inTransaction: this.#inTransaction }
  }

  async deleteRows(
    tableId: string,
    keys: readonly Readonly<Record<string, CellValue>>[]
  ): Promise<EditApplyResult> {
    const client = this.#requireClient()
    // 空数组必须最前面拒绝（空 WHERE 的 DELETE 会清空整表）——与宿主层双保险
    if (keys.length === 0) {
      throw new PostgresAdapterError(
        'bad_params',
        '拒绝执行删除：没有指定任何要删除的行。空条件会删除整张表的所有数据，因此适配器层直接禁止空 keys（确需清空请在 SQL 窗口显式执行 DELETE FROM 或 DROP）。'
      )
    }
    const target = await this.#resolveTableTarget(client, tableId, true)
    // 先做完所有行级校验
    for (let index = 0; index < keys.length; index += 1) {
      const keyValues = keys[index]
      if (keyValues === undefined) continue
      this.#resolveRowKeys(target, keyValues, index + 1, '删除')
    }

    const inOwnTransaction = await this.#ensureTransaction(client)
    const quote = this.dialect.quoteIdentifier.bind(this.dialect)
    const outcomes: RowEditOutcome[] = []
    let affectedTotal = 0
    let aborted = false

    for (let index = 0; index < keys.length; index += 1) {
      const keyValues = keys[index]
      if (keyValues === undefined) continue
      const orderedKeys = this.#resolveRowKeys(target, keyValues, index + 1, '删除')
      const keyColumns = orderedKeys.map((m) => m.canonical)
      const keyMap = new Map(orderedKeys.map((m) => [m.canonical, mustGetValue(keyValues, m.requested)]))
      const built = buildDelete(quote, target.schema, target.tableName, keyColumns, keyMap)
      try {
        const affected = await this.#runWrite(client, built.sql, built.params)
        if (affected === 0) {
          outcomes.push({ index, affected, error: '没有匹配到任何行：主键值可能已过期（该行已被删除或主键被改过），本次删除未生效。', sql: built.sql })
        } else if (affected > 1) {
          outcomes.push({ index, affected, error: `主键定位到了 ${affected} 行：该"唯一键"实际不唯一，为避免误删已停止这一行。`, sql: built.sql })
        } else {
          affectedTotal += affected
          outcomes.push({ index, affected, error: null, sql: built.sql })
        }
        if (outcomes[outcomes.length - 1]?.error !== null) {
          // 有失败：停止后续删除（与 SQLite 版一致的策略）
          aborted = true
          for (let rest = index + 1; rest < keys.length; rest += 1) {
            outcomes.push({ index: rest, affected: 0, error: `未执行：第 ${index + 1} 行删除失败，为避免连带影响已停止后续删除。`, sql: '' })
          }
          break
        }
      } catch (thrown) {
        aborted = true
        outcomes.push({ index, affected: 0, error: describeThrown(thrown), sql: built.sql })
        for (let rest = index + 1; rest < keys.length; rest += 1) {
          outcomes.push({ index: rest, affected: 0, error: `未执行：第 ${index + 1} 行删除失败，为避免连带影响已停止后续删除。`, sql: '' })
        }
        break
      }
    }

    this.#pendingAffected += affectedTotal
    return { affected: affectedTotal, outcomes, ok: !aborted, inTransaction: this.#inTransaction }
  }

  async countRows(tableId: string): Promise<number> {
    const client = this.#requireClient()
    const target = await this.#resolveTableTarget(client, tableId, false)
    const quote = this.dialect.quoteIdentifier.bind(this.dialect)
    const sql = buildCountSql(quote, target.schema, target.tableName)
    try {
      const result = await client.query<{ dbstudio_count: string }>(sql)
      // pg 把 COUNT(*)（bigint）返回成字符串
      const raw = result.rows[0]?.dbstudio_count
      const count = raw === undefined ? NaN : Number(raw)
      if (!Number.isFinite(count)) {
        throw new PostgresAdapterError('query_failed', `统计行数返回了无法解析的值：${String(raw)}`)
      }
      return count
    } catch (thrown) {
      if (thrown instanceof PostgresAdapterError) throw thrown
      throw wrapPgError(thrown, 'query_failed', '统计行数失败')
    }
  }

  async fetchCellValue(cursorId: string, rowIndex: number, columnIndex: number): Promise<CellValue> {
    const client = this.#requireClient()
    const cursor = this.#cursors.get(cursorId)
    if (cursor === undefined) {
      throw new PostgresAdapterError('object_not_found', `结果集游标不存在或已关闭：${cursorId}（结果集可能已被关闭，或连接断过）`)
    }
    const row = normalizeOffset(rowIndex)
    const column = normalizeOffset(columnIndex)
    const result = await this.#runQuery(client, buildPagedSql(cursor.sql, 1, row), toPgValues(cursor.params))
    const grid = buildGrid(result as unknown as PgResultLike)
    const targetRow = grid.rows[0]
    if (targetRow === undefined) {
      throw new PostgresAdapterError('object_not_found', `结果集里没有第 ${row} 行（可能已到末尾）。`)
    }
    if (column >= grid.names.length) {
      throw new PostgresAdapterError('bad_params', `列下标 ${column} 越界：这条查询只有 ${grid.names.length} 列。`)
    }
    return toFullCellValue(targetRow[column])
  }

  /** 建表。DDL 必须真正生效（自己的事务里提交，见 #runDdl）。 */
  async createTable(connectionId: string, spec: TableCreateSpec): Promise<void> {
    void connectionId
    const client = this.#requireClient()
    const quote = this.dialect.quoteIdentifier.bind(this.dialect)
    // schema：本阶段所有新表建在 public。真正的 schema 选择属于后续阶段，
    // 这里显式写 public 而不是靠 search_path——避免"建到了别的 schema"的静默偏差。
    // buildCreateTableSql 产出的是 `CREATE TABLE "name" (...)`（不带 schema）。
    // 这里显式限定到 public，避免 search_path 让表落到别的 schema。
    const rawSql = buildCreateTableSql(quote, spec)
    const sql = rawSql.replace(/^CREATE TABLE /, `CREATE TABLE ${quote('public')}.`)
    await this.#runDdl(client, sql, {
      action: '建表',
      target: spec.name,
      alreadyExists: /already exists|relation .* already exists/i,
      alreadyExistsMessage: `表「${spec.name}」已存在（already exists）。`
    })
  }

  async dropTable(nodeId: string): Promise<void> {
    const client = this.#requireClient()
    const { schema, name } = this.#requireRelationName(nodeId, 'table', '删表')
    const quote = this.dialect.quoteIdentifier.bind(this.dialect)
    const sql = buildDropTableSql(quote, schema, name)
    await this.#runDdl(client, sql, {
      action: '删表',
      target: name,
      missing: /does not exist/i,
      missingMessage: `表「${name}」不存在（does not exist）。`
    })
  }

  async createView(connectionId: string, viewName: string, selectSql: string): Promise<void> {
    void connectionId
    const client = this.#requireClient()
    this.#requireName(viewName, '视图名')
    const checkedSql = prepareReadOnlyStatement(selectSql)
    const quote = this.dialect.quoteIdentifier.bind(this.dialect)
    const sql = buildCreateViewSql(quote, 'public', viewName, checkedSql)
    await this.#runDdl(client, sql, {
      action: '建视图',
      target: viewName,
      alreadyExists: /already exists/i,
      alreadyExistsMessage: `视图「${viewName}」已存在（already exists）。`
    })
  }

  async dropView(nodeId: string): Promise<void> {
    const client = this.#requireClient()
    const { schema, name } = this.#requireRelationName(nodeId, 'view', '删视图')
    const quote = this.dialect.quoteIdentifier.bind(this.dialect)
    const sql = buildDropViewSql(quote, schema, name)
    await this.#runDdl(client, sql, {
      action: '删视图',
      target: name,
      missing: /does not exist/i,
      missingMessage: `视图「${name}」不存在（does not exist）。`
    })
  }

  async renameTable(nodeId: string, newName: string): Promise<void> {
    const client = this.#requireClient()
    const { schema, name } = this.#requireRelationName(nodeId, 'table', '重命名表')
    this.#requireName(newName, '新表名')
    const quote = this.dialect.quoteIdentifier.bind(this.dialect)
    const sql = buildRenameTableSql(quote, schema, name, newName)
    await this.#runDdl(client, sql, {
      action: '重命名表',
      target: `${name} → ${newName}`,
      alreadyExists: /already exists|relation .* already exists/i,
      alreadyExistsMessage: `重命名失败：目标名「${newName}」已被占用（already exists）。请换一个名字。`
    })
  }

  async applyEdits(tableId: string, updates: readonly RowUpdate[]): Promise<EditApplyResult> {
    const client = this.#requireClient()
    const target = await this.#resolveTableTarget(client, tableId, true)
    if (updates.length === 0) {
      return { affected: 0, outcomes: [], ok: true, inTransaction: this.#inTransaction }
    }
    // 全部校验先做完再开事务
    for (let index = 0; index < updates.length; index += 1) {
      const update = updates[index]
      if (update === undefined) continue
      this.#validateUpdate(target, update, index + 1)
    }

    await this.#ensureTransaction(client)
    const quote = this.dialect.quoteIdentifier.bind(this.dialect)
    const outcomes: RowEditOutcome[] = []
    let affectedTotal = 0
    for (let index = 0; index < updates.length; index += 1) {
      const update = updates[index]
      if (update === undefined) continue
      const outcome = await this.#applyOneUpdate(client, quote, target, update, index)
      outcomes.push(outcome)
      affectedTotal += outcome.affected
    }
    this.#pendingAffected += affectedTotal
    return {
      affected: affectedTotal,
      outcomes,
      ok: outcomes.every((outcome) => outcome.error === null),
      inTransaction: this.#inTransaction
    }
  }

  /** 提交当前事务。无活动事务时报错（不能静默成功——与 SQLite 版同一理由）。 */
  async commitTransaction(): Promise<TransactionState> {
    const client = this.#requireClient()
    if (!this.#inTransaction) {
      throw new PostgresAdapterError('bad_params', '当前没有未提交的事务，无法提交。')
    }
    /*
     * 导入边界（`#importActive`）：COMMIT 可能因为 DEFERRABLE 约束触发器在提交时
     * RAISE EXCEPTION 而失败，原始错误里带着 CSV 数据。传 true 让 #execControl
     * 走导入安全摘要，绝不回显原文。
     *
     * 失败时 #execControl 直接抛出，下面三行清理不会执行 —— 因此
     * `#inTransaction` / `#importActive` 保持 true，不会把"提交失败"伪装成
     * "事务已结束"。调用方仍可用 rollbackTransaction 正确收尾。
     */
    await this.#execControl(client, 'COMMIT', this.#importActive)
    this.#inTransaction = false
    this.#importActive = false
    this.#pendingAffected = 0
    return { active: false, pendingAffected: 0 }
  }

  /** 回滚当前事务。幂等：没有事务时返回未激活而不是报错。 */
  async rollbackTransaction(): Promise<TransactionState> {
    const client = this.#client
    if (client === null) return { active: false, pendingAffected: 0 }
    if (this.#inTransaction) {
      /*
       * 同样在导入边界走安全摘要：ROLLBACK 也可能失败（例如连接已断、或触发器
       * 在回滚钩子里抛错），原文同样可能夹带数据。
       *
       * 失败时 #execControl 直接抛出，下面的清理不会执行 —— 事务状态保守保留为
       * 活动，transactionState() 继续如实报告，不会误清。
       */
      await this.#execControl(client, 'ROLLBACK', this.#importActive)
    }
    this.#inTransaction = false
    this.#importActive = false
    this.#pendingAffected = 0
    return { active: false, pendingAffected: 0 }
  }

  async transactionState(): Promise<TransactionState> {
    const client = this.#client
    if (client === null) return { active: false, pendingAffected: 0 }
    return { active: this.#inTransaction, pendingAffected: this.#pendingAffected }
  }

  /**
   * 把**已成功执行**的显式事务控制语句同步到内部账本。
   * 只在成功后调用；失败路径由调用方直接抛出，这里不会把用户事务误清掉。
   */
  #applyTransactionControl(action: TxControlAction): void {
    switch (action) {
      case 'begin':
        // 嵌套 BEGIN（PG 只会告警）不应重置已累计的影响行数。
        if (!this.#inTransaction) this.#pendingAffected = 0
        this.#inTransaction = true
        return
      case 'commit':
      case 'rollback':
        this.#inTransaction = false
        this.#importActive = false
        this.#pendingAffected = 0
        return
      case 'rollback_to':
      case 'no_state_change':
        // ROLLBACK TO 只回退到保存点；PREPARED 系列不作用于本连接事务。状态都不变。
        return
    }
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  #requireClient(): Client {
    if (this.#client === null) {
      throw new PostgresAdapterError('not_connected', '尚未连接到数据库，请先建立连接。')
    }
    return this.#client
  }

  async #runQuery(client: Client, sql: string, params: readonly unknown[] = []): Promise<QueryResult<Record<string, unknown>>> {
    try {
      return await client.query<Record<string, unknown>>(sql, params as unknown[])
    } catch (thrown) {
      throw wrapPgError(thrown, 'query_failed', '查询执行失败')
    }
  }

  /** 执行内部生成的写入语句（值全部参数化）。返回影响行数。 */
  async #runWrite(client: Client, sql: string, params: readonly unknown[]): Promise<number> {
    try {
      const result = await client.query(sql, params as unknown[])
      return result.rowCount ?? 0
    } catch (thrown) {
      throw wrapPgError(thrown, 'query_failed', '执行更新失败')
    }
  }

  /**
   * 执行事务控制语句（BEGIN/COMMIT/ROLLBACK），把底层报错包装成人话。
   *
   * `importSafe` 只在**导入边界**（`#importActive === true` 时的 COMMIT/ROLLBACK）
   * 传 true。此时原始错误必须**在 `wrapPgError` 把原文拼进 message 之前**就
   * 用结构化字段提炼成固定摘要 + 安全 cause：
   *
   *   - `DEFERRABLE INITIALLY DEFERRED` 的约束触发器可以在 **COMMIT** 时才
   *     `RAISE EXCEPTION 'bad: %', NEW.note`——错误原文里直接带着 CSV 单元格值；
   *   - `wrapPgError` 会生成「...（原始错误：<原文>）」并把它挂成 cause，
   *     RPC 只取 `{ code, message }` 发给 renderer，于是数据就泄漏到界面上了。
   *
   * 这里在 catch 里拿到的是**尚未包装的原生数据库错误**，正好可以复用写行
   * 路径同一套 `describePgImportFailure` / `pgImportFailureCause`（只输出
   * SQLSTATE/严重级别/约束/表等结构化信息），绝不回显原文。
   *
   * 非导入路径（用户编辑事务、DDL 自管事务）`importSafe` 为 false，语义完全
   * 不变，仍走 `wrapPgError`。
   */
  async #execControl(
    client: Client,
    statement: 'BEGIN' | 'COMMIT' | 'ROLLBACK',
    importSafe = false
  ): Promise<void> {
    try {
      await client.query(statement)
    } catch (thrown) {
      if (importSafe) {
        const verb = statement === 'COMMIT' ? '提交' : '回滚'
        throw new PostgresAdapterError(
          'query_failed',
          `导入事务${verb}失败：${describePgImportFailure(thrown)}`,
          pgImportFailureCause(thrown)
        )
      }
      throw wrapPgError(thrown, 'query_failed', `${statement} 执行失败`)
    }
  }

  /** 保证有事务；返回"这个事务是不是本方法刚开的"。 */
  async #ensureTransaction(client: Client): Promise<boolean> {
    if (this.#inTransaction) return false
    // PG 的事务用 BEGIN（不是 SQLite 的 BEGIN IMMEDIATE —— PG 没有 IMMEDIATE 这个概念）
    await this.#execControl(client, 'BEGIN')
    this.#inTransaction = true
    this.#pendingAffected = 0
    return true
  }

  /** 自己开的、且整体失败的事务：撤掉它，避免留下空事务。 */
  async #releaseFailedOwnTransaction(client: Client, inOwnTransaction: boolean): Promise<void> {
    if (!inOwnTransaction || !this.#inTransaction) return
    try {
      await client.query('ROLLBACK')
    } catch {
      // ignore
    }
    this.#inTransaction = false
    this.#pendingAffected = 0
  }

  /** 执行一条 DDL 并**按需立即提交**（提交策略见 sqlite/adapter.ts 的 #runDdl 注释，语义相同）。 */
  async #runDdl(
    client: Client,
    sql: string,
    hints: {
      readonly action: string
      readonly target: string
      readonly alreadyExists?: RegExp
      readonly alreadyExistsMessage?: string
      readonly missing?: RegExp
      readonly missingMessage?: string
    }
  ): Promise<void> {
    const selfManaged = !this.#inTransaction
    if (selfManaged) {
      await this.#execControl(client, 'BEGIN')
      this.#inTransaction = true
    }
    try {
      await client.query(sql)
      if (selfManaged) {
        await this.#execControl(client, 'COMMIT')
        this.#inTransaction = false
      }
    } catch (thrown) {
      if (selfManaged && this.#inTransaction) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // ignore
        }
        this.#inTransaction = false
      }
      const raw = describeThrown(thrown)
      if (hints.alreadyExists !== undefined && hints.alreadyExists.test(raw)) {
        throw new PostgresAdapterError('bad_params', hints.alreadyExistsMessage ?? `${hints.action}失败：「${hints.target}」已存在。原始错误：${raw}`, thrown)
      }
      if (hints.missing !== undefined && hints.missing.test(raw)) {
        throw new PostgresAdapterError('object_not_found', hints.missingMessage ?? `${hints.action}失败：「${hints.target}」不存在。原始错误：${raw}`, thrown)
      }
      throw wrapPgError(thrown, 'query_failed', `${hints.action}「${hints.target}」失败`)
    }
  }

  /** 列出所有用户 schema（排除 pg_catalog / information_schema 等系统 schema）。 */
  async #listSchemas(client: Client): Promise<ObjectRef[]> {
    const sql = `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND schema_name NOT LIKE 'pg_temp_%'
        AND schema_name NOT LIKE 'pg_toast_temp_%'
      ORDER BY schema_name`
    const result = await this.#runQuery(client, sql)
    const refs: ObjectRef[] = []
    for (const row of result.rows) {
      const name = typeof row['schema_name'] === 'string' ? row['schema_name'] : null
      if (name === null) continue
      refs.push({ id: schemaObjectId(name), kind: 'schema', name, parentId: SCHEMAS_FOLDER_ID, hasChildren: true })
    }
    return refs
  }

  /** 列出某个 schema 下的表或视图。 */
  async #listRelations(client: Client, schema: string, folder: SchemaFolder): Promise<ObjectRef[]> {
    const tableType = folder === 'tables' ? 'BASE TABLE' : 'VIEW'
    // 参数化 schema 与类型（information_schema 的过滤值可以走参数）
    const sql = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = $2
      ORDER BY table_name`
    const result = await this.#runQuery(client, sql, [schema, tableType])
    const parentId = schemaFolderId(schema, folder)
    const refs: ObjectRef[] = []
    for (const row of result.rows) {
      const name = typeof row['table_name'] === 'string' ? row['table_name'] : null
      if (name === null) continue
      refs.push({
        id: folder === 'tables' ? tableObjectId(schema, name) : viewObjectId(schema, name),
        kind: folder === 'tables' ? 'table' : 'view',
        name,
        parentId,
        hasChildren: true
      })
    }
    return refs
  }

  /** 列出表/视图的列。 */
  async #listColumns(client: Client, schema: string, ownerName: string, ownerObjectId: string): Promise<ObjectRef[]> {
    const columns = await this.#readColumns(client, schema, ownerName)
    return columns.map((raw): ObjectRef => ({
      id: columnObjectId(schema, ownerName, raw.name),
      kind: 'column',
      name: raw.name,
      parentId: ownerObjectId,
      hasChildren: false,
      // meta 只放原始值（要跨进程结构化克隆）
      meta: {
        typeName: raw.typeName,
        nullable: raw.nullable,
        primaryKeyOrdinal: raw.primaryKeyOrdinal
      }
    }))
  }

  /**
   * 读取一个表/视图的列信息（含主键序号）。
   *
   * ===== 两条查询：列 + 主键 =====
   *
   * 1. `information_schema.columns`：列名、`data_type`（基础类型）、`is_nullable`、
   *    `column_default`，以及 identity/generated 三个 catalog 标记。
   *    注意 `data_type` 不含长度（`VARCHAR` 而非 `VARCHAR(64)`），
   *    要拼成 `VARCHAR(64)` 需要 `character_maximum_length` / `numeric_precision` / `numeric_scale`。
   *    这里做了拼接，让 UI 看到的是完整的类型名。
   * 2. `information_schema.table_constraints` JOIN `key_column_usage`：主键列与主键内序号。
   *
   * ⚠️ **PG 大小写折叠的落地**：`information_schema.columns` 返回的列名是**真实存储名**
   * （`CREATE TABLE Users` 建出来是 `users`）。我们一律用它，不做任何 case 变换——
   * 因为 UI 里的列名就是从这里来的，一旦这里改了大小写，WHERE 拼出来的 `"Users"` 就会
   * 匹配不到真实列 `users`。这是 PG 与 SQLite 最需要小心的一处差异。
   */
  async #readColumns(client: Client, schema: string, ownerName: string): Promise<ColumnDescription[]> {
    const columnSql = `
      SELECT
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        c.character_maximum_length,
        c.numeric_precision,
        c.numeric_scale,
        c.udt_name,
        c.is_identity,
        c.identity_generation,
        c.is_generated
      FROM information_schema.columns c
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position`
    let columnResult: QueryResult<Record<string, unknown>>
    try {
      columnResult = await this.#runQuery(client, columnSql, [schema, ownerName])
    } catch (thrown) {
      if (thrown instanceof PostgresAdapterError) throw thrown
      throw wrapPgError(thrown, 'query_failed', `读取表结构失败：${schema}.${ownerName}`)
    }
    if (columnResult.rows.length === 0) {
      // 视图/表不存在，或该 schema 下没这个对象
      const exists = await this.#relationExists(client, schema, ownerName)
      if (!exists) {
        throw new PostgresAdapterError('object_not_found', `对象不存在（可能已被删除，请刷新）：${schema}.${ownerName}`)
      }
    }

    // 主键列 → 序号
    const pkMap = await this.#readPrimaryKey(client, schema, ownerName)

    const columns: ColumnDescription[] = []
    for (const row of columnResult.rows) {
      const name = typeof row['column_name'] === 'string' ? row['column_name'] : null
      if (name === null) continue
      // identity 列的 column_default 也是 null，不能只靠默认值判断是否必填。
      const isIdentity = row['is_identity'] === 'YES'
      const identityGeneration = isIdentity
        ? row['identity_generation'] === 'ALWAYS'
          ? 'always'
          : row['identity_generation'] === 'BY DEFAULT'
            ? 'by-default'
            : null
        : null
      const nullable = row['is_nullable'] === 'YES'
      const defaultValue = typeof row['column_default'] === 'string' ? row['column_default'] : null
      const generated = row['is_generated'] === 'ALWAYS' ? 'stored' : null
      /**
       * 静态必填：NOT NULL 且无默认值、非 identity、非 generated。
       *
       * 这是**纯列定义**判断，不代表"省略后插入一定成功"：
       * CHECK 约束、触发器、DEFAULT 表达式求值失败等运行期规则不在本字段范围。
       * 有 `DEFAULT NULL` 时 `column_default` 非空，按"有默认值"归为 false，
       * 但不承诺该省略一定可写（见 `ColumnDescription.requiredOnInsert` 注释）。
       */
      const requiredOnInsert = !nullable && defaultValue === null && !isIdentity && generated === null
      columns.push({
        name,
        typeName: formatPgType(row),
        nullable,
        primaryKeyOrdinal: pkMap.get(name) ?? null,
        defaultValue,
        identity: identityGeneration,
        generated,
        requiredOnInsert
      })
    }
    return columns
  }

  /** 读主键列及主键内序号（1 起）。 */
  async #readPrimaryKey(client: Client, schema: string, tableName: string): Promise<Map<string, number>> {
    const sql = `
      SELECT kcu.column_name, kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
       AND tc.table_name = kcu.table_name
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = $1
        AND tc.table_name = $2
      ORDER BY kcu.ordinal_position`
    const result = await this.#runQuery(client, sql, [schema, tableName])
    const map = new Map<string, number>()
    for (const row of result.rows) {
      const name = typeof row['column_name'] === 'string' ? row['column_name'] : null
      const ordinal = typeof row['ordinal_position'] === 'number' ? row['ordinal_position'] : Number(row['ordinal_position'])
      if (name !== null && Number.isInteger(ordinal) && ordinal > 0) map.set(name, ordinal)
    }
    return map
  }

  async #relationExists(client: Client, schema: string, name: string): Promise<boolean> {
    const sql = `
      SELECT 1 AS found
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2
      LIMIT 1`
    const result = await this.#runQuery(client, sql, [schema, name])
    return result.rows.length > 0
  }

  /** 解析并校验表级编辑目标（schema 限定、可用列、主键列）。 */
  async #resolveTableTarget(client: Client, tableId: string, requireKey: boolean): Promise<EditableTarget> {
    const parsed = parseObjectId(tableId)
    if (parsed === null) {
      throw new PostgresAdapterError('object_not_found', `无法识别的对象 id：${tableId}`)
    }
    if (parsed.kind !== 'table') {
      throw new PostgresAdapterError('bad_params', `只有表支持在线编辑，收到的是 ${parsed.kind} 节点：${tableId}（视图与列不能直接改）`)
    }
    const columns = await this.#readColumns(client, parsed.schema, parsed.name)
    const keyColumns = columns
      .filter((column) => column.primaryKeyOrdinal !== null)
      .sort((a, b) => (a.primaryKeyOrdinal ?? 0) - (b.primaryKeyOrdinal ?? 0))
      .map((column) => column.name)

    if (requireKey && keyColumns.length === 0) {
      throw new PostgresAdapterError(
        'object_not_found',
        `表「${parsed.name}」没有唯一键，无法定位要修改的行（No unique key defined）。没有唯一键的结果集不支持在线编辑：请为该表定义主键，或在 SQL 窗口里直接写 UPDATE。`
      )
    }
    return {
      schema: parsed.schema,
      tableName: parsed.name,
      availableColumns: columns.map((column) => column.name),
      keyColumns
    }
  }

  /** 行级校验：主键覆盖是否完整，返回 ColumnMatch[]。 */
  #resolveRowKeys(
    target: EditableTarget,
    keyValues: Readonly<Record<string, CellValue>>,
    position: number,
    actionLabel: string
  ): readonly ColumnMatch[] {
    const keyKeys = Object.keys(keyValues)
    const keyResolved = resolveRequiredColumns(target.keyColumns, keyKeys, target.availableColumns)
    if (keyResolved.resolved.unknown.length > 0) {
      throw new PostgresAdapterError(
        'bad_params',
        `第 ${position} 条${actionLabel}的主键列不存在：${keyResolved.resolved.unknown.join('、')}。「${target.tableName}」的可用列：${target.availableColumns.join('、')}`
      )
    }
    if (keyResolved.missing.length > 0) {
      throw new PostgresAdapterError(
        'bad_params',
        `第 ${position} 条${actionLabel}缺少主键列的值：${keyResolved.missing.join('、')}。在线编辑必须用完整主键定位行。`
      )
    }
    return keyResolved.ordered
  }

  #validateUpdate(target: EditableTarget, update: RowUpdate, position: number): void {
    const changeKeys = Object.keys(update.changes)
    if (changeKeys.length === 0) {
      throw new PostgresAdapterError('bad_params', `第 ${position} 条更新没有指定任何要修改的列。`)
    }
    const changeResolved = resolveColumns(changeKeys, target.availableColumns)
    if (changeResolved.unknown.length > 0) {
      throw new PostgresAdapterError(
        'bad_params',
        `第 ${position} 条更新引用了不存在的列：${changeResolved.unknown.join('、')}。「${target.tableName}」的可用列：${target.availableColumns.join('、')}`
      )
    }
    this.#resolveRowKeys(target, update.keyValues, position, '更新')
  }

  async #applyOneUpdate(
    client: Client,
    quote: (name: string) => string,
    target: EditableTarget,
    update: RowUpdate,
    index: number
  ): Promise<RowEditOutcome> {
    const changeResolved = resolveColumns(Object.keys(update.changes), target.availableColumns)
    const keyResolved = resolveRequiredColumns(
      target.keyColumns,
      Object.keys(update.keyValues),
      target.availableColumns
    )
    const orderedKeyMatches = keyResolved.ordered
    const keyColumns = orderedKeyMatches.map((match) => match.canonical)

    let built
    try {
      built = buildUpdate(
        quote,
        target.schema,
        target.tableName,
        changeResolved.matched.map((m) => m.canonical),
        keyColumns,
        new Map(changeResolved.matched.map((match) => [match.canonical, mustGetValue(update.changes, match.requested)])),
        new Map(orderedKeyMatches.map((match) => [match.canonical, mustGetValue(update.keyValues, match.requested)]))
      )
    } catch (thrown) {
      return { index, affected: 0, error: `值转换失败：${describeThrown(thrown)}`, sql: '' }
    }

    try {
      const affected = await this.#runWrite(client, built.sql, built.params)
      if (affected === 0) {
        return { index, affected, error: '没有匹配到任何行：主键值可能已过期（该行已被删除或主键被改过），本次改动未生效。', sql: built.sql }
      }
      if (affected > 1) {
        return { index, affected, error: `主键定位到了 ${affected} 行：该"唯一键"实际不唯一，为避免误改已停止这一行。`, sql: built.sql }
      }
      return { index, affected, error: null, sql: built.sql }
    } catch (thrown) {
      return { index, affected: 0, error: describeThrown(thrown), sql: built.sql }
    }
  }

  /** 从完整 adapterId 取出 schema 与对象名，并校验节点类型。 */
  #requireRelationName(nodeId: string, expectedKind: 'table' | 'view', actionLabel: string): { schema: string; name: string } {
    const parsed = parseObjectId(nodeId)
    if (parsed === null) {
      throw new PostgresAdapterError('object_not_found', `${actionLabel}失败：无法识别的对象 id「${nodeId}」。`)
    }
    if (parsed.kind !== expectedKind) {
      throw new PostgresAdapterError(
        'bad_params',
        `${actionLabel}失败：期待${expectedKind === 'table' ? '表' : '视图'}节点，收到的是 ${parsed.kind}（${nodeId}）。`
      )
    }
    this.#requireName(parsed.name, expectedKind === 'table' ? '表名' : '视图名')
    return { schema: parsed.schema, name: parsed.name }
  }

  #requireName(name: string, label: string): void {
    if (name.trim() === '') {
      throw new PostgresAdapterError('bad_params', `${label}不能为空。`)
    }
  }

  #openCursor(statementSql: string, params: readonly unknown[] = []): string {
    const cursorId = randomUUID()
    this.#cursors.set(cursorId, {
      sql: statementSql,
      params: params as readonly SqlParameterValue[]
    })
    return cursorId
  }
}

function toPgValues(values: readonly SqlParameterValue[]): unknown[] {
  return values.map((value) => (value instanceof Uint8Array ? Buffer.from(value) : value))
}

/**
 * 把 information_schema 的类型信息拼成完整类型名。
 *
 * `data_type` 对字符类型返回 `character varying`（不是 `varchar`），对数值类型返回 `numeric`
 * 但不含精度。所以要结合 `character_maximum_length` / `numeric_precision` / `numeric_scale`：
 *   - `character varying` + len → `VARCHAR(len)`
 *   - `character` + len → `CHAR(len)`
 *   - `numeric` + p,s → `NUMERIC(p,s)`
 * 其余直接用小写 data_type 的大写形式（如 `INTEGER` / `BOOLEAN` / `TIMESTAMP WITH TIME ZONE`）。
 *
 * 注意：`SERIAL` 建出来的列，information_schema 显示为 `integer` + 默认值 `nextval(...)`，
 * **不会**再显示成 `SERIAL`——这是 PG 的固有行为（SERIAL 只是 `integer + 序列 + 默认值` 的语法糖）。
 */
function formatPgType(row: Record<string, unknown>): string {
  const dataType = typeof row['data_type'] === 'string' ? row['data_type'].toUpperCase() : ''
  const charLen = typeof row['character_maximum_length'] === 'number' ? row['character_maximum_length'] : null
  const numPrecision = typeof row['numeric_precision'] === 'number' ? row['numeric_precision'] : null
  const numScale = typeof row['numeric_scale'] === 'number' ? row['numeric_scale'] : null

  if ((dataType === 'CHARACTER VARYING' || dataType === 'VARCHAR') && charLen !== null) {
    return `VARCHAR(${charLen})`
  }
  if ((dataType === 'CHARACTER' || dataType === 'CHAR' || dataType === 'BPCHAR') && charLen !== null) {
    return `CHAR(${charLen})`
  }
  if ((dataType === 'NUMERIC' || dataType === 'DECIMAL') && numPrecision !== null) {
    return numScale !== null && numScale > 0 ? `NUMERIC(${numPrecision},${numScale})` : `NUMERIC(${numPrecision})`
  }
  if (dataType === 'USER-DEFINED') {
    // 自定义类型（如 enum）：用 udt_name
    const udt = typeof row['udt_name'] === 'string' ? row['udt_name'] : 'USER-DEFINED'
    return udt.toUpperCase()
  }
  if (dataType === 'ARRAY') {
    const udt = typeof row['udt_name'] === 'string' ? row['udt_name'].replace(/^_/, '') : ''
    return udt === '' ? 'ARRAY' : `${udt.toUpperCase()}[]`
  }
  return dataType || 'UNKNOWN'
}

/** 工厂：每次调用返回新实例（连接状态属于实例，不该被两个连接共用）。 */
export const createPostgresAdapter: DriverFactory = (): DriverAdapter => new PostgresDriverAdapter()
