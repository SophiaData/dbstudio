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
  ConnectionTestCheck,
  ConnectionTestStage,
  DriverAdapter,
  SecretValue,
  SshHostKeyCheck,
  TestConnectionResult
} from '../../core/driver'
import type { DriverCapabilities, ObjectRef, TableDescription, ColumnDescription } from '../../core/model'
import type { DriverFactory } from '../../core/registry'
import type {
  CellValue,
  EditApplyResult,
  QueryOptions,
  QueryResult as QueryResultContract,
  ResultPage,
  RowEditOutcome,
  RowUpdate,
  TransactionState,
  StatementResult
} from '../../core/resultset'

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
  supportsInlineEdit: true
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
}

function readOptionString(config: ConnectionConfig, key: string): string {
  const raw = config.options[key]
  return typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
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
  async describeTable(id: string): Promise<TableDescription> {
    const client = this.#requireClient()
    const parsed = parseObjectId(id)
    if (parsed === null || (parsed.kind !== 'table' && parsed.kind !== 'view')) {
      throw new PostgresAdapterError('object_not_found', `describeTable 只接受表或视图节点，收到的 id 是：${id}`)
    }
    const columns = await this.#readColumns(client, parsed.schema, parsed.name)
    const canonicalId = parsed.kind === 'table' ? tableObjectId(parsed.schema, parsed.name) : viewObjectId(parsed.schema, parsed.name)
    return {
      id: canonicalId,
      columns,
      hasUniqueKey: columns.some((column) => column.primaryKeyOrdinal !== null)
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
    const statementSql = prepareReadOnlyStatement(sql)
    const limit = normalizePageSize(options?.limit)
    const offset = normalizeOffset(options?.offset)
    const executedSql = buildPagedSql(statementSql, limit, offset)

    const startedAt = performance.now()
    const result = await this.#runQuery(client, executedSql)
    const elapsedMs = Math.round(performance.now() - startedAt)

    const grid = buildGrid(result as unknown as PgResultLike)
    const cursorId = options?.keepCursor === false ? null : this.#openCursor(statementSql)

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

  async executeStatement(sql: string, options?: QueryOptions): Promise<StatementResult> {
    const client = this.#requireClient()
    const analyzed = prepareGeneralStatement(sql)
    const startedAt = performance.now()

    if (analyzed.kind === 'rows') {
      if (PAGINATABLE_KEYWORDS.has(analyzed.keyword)) {
        const result = await this.query(analyzed.statementSql, options)
        return { kind: 'rows', result }
      }
      const res = await this.#runQuery(client, analyzed.statementSql)
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
        const res = await client.query(analyzed.statementSql)
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
      const res = await client.query(analyzed.statementSql)
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

  async fetchResultPage(cursorId: string, offset: number, limit: number): Promise<ResultPage> {
    const client = this.#requireClient()
    const cursor = this.#cursors.get(cursorId)
    if (cursor === undefined) {
      throw new PostgresAdapterError('object_not_found', `结果集游标不存在或已关闭：${cursorId}（结果集可能已被关闭，或连接断过）`)
    }
    const pageSize = normalizePageSize(limit)
    const start = normalizeOffset(offset)
    const result = await this.#runQuery(client, buildPagedSql(cursor.sql, pageSize, start))
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
    const result = await this.#runQuery(client, buildPagedSql(cursor.sql, 1, row))
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
    await this.#execControl(client, 'COMMIT')
    this.#inTransaction = false
    this.#pendingAffected = 0
    return { active: false, pendingAffected: 0 }
  }

  /** 回滚当前事务。幂等：没有事务时返回未激活而不是报错。 */
  async rollbackTransaction(): Promise<TransactionState> {
    const client = this.#client
    if (client === null) return { active: false, pendingAffected: 0 }
    if (this.#inTransaction) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // 回滚失败也不能抛（清理路径）
      }
    }
    this.#inTransaction = false
    this.#pendingAffected = 0
    return { active: false, pendingAffected: 0 }
  }

  async transactionState(): Promise<TransactionState> {
    const client = this.#client
    if (client === null) return { active: false, pendingAffected: 0 }
    return { active: this.#inTransaction, pendingAffected: this.#pendingAffected }
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

  async #runQuery(client: Client, sql: string, params: unknown[] = []): Promise<QueryResult<Record<string, unknown>>> {
    try {
      return await client.query<Record<string, unknown>>(sql, params)
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

  /** 执行事务控制语句（BEGIN/COMMIT/ROLLBACK），把底层报错包装成人话。 */
  async #execControl(client: Client, statement: 'BEGIN' | 'COMMIT' | 'ROLLBACK'): Promise<void> {
    try {
      await client.query(statement)
    } catch (thrown) {
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
   * 1. `information_schema.columns`：列名、`data_type`（基础类型）、`is_nullable`、`column_default`。
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
        c.udt_name
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
      columns.push({
        name,
        typeName: formatPgType(row),
        nullable: row['is_nullable'] === 'YES',
        primaryKeyOrdinal: pkMap.get(name) ?? null,
        defaultValue: typeof row['column_default'] === 'string' ? row['column_default'] : null
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

  #openCursor(statementSql: string): string {
    const cursorId = randomUUID()
    this.#cursors.set(cursorId, { sql: statementSql })
    return cursorId
  }
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
