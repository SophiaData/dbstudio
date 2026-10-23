/**
 * PostgreSQL 的 SSL/TLS 连接策略。
 *
 * ============================================================================
 * 为什么不直接把 `sslmode` 字符串丢给 `pg`
 * ============================================================================
 *
 * `sslmode` 的取值沿用 **libpq 的名字**（`disable` / `allow` / `prefer` /
 * `require` / `verify-ca` / `verify-full`），因为用户从 psql、DBeaver、
 * 运维文档带过来的认知应该是可迁移的——不该为了用本客户端再学一套词。
 *
 * 但 `pg`（node-postgres）对这套名字的**实现与 libpq 并不等价**，直接传字符串
 * 会静默改变语义。以下三点都是本机实测得出的（PG 17 + pg 8.23），不是文档推测：
 *
 *   1. **`pg` 的 `ssl: true` 会校验证书**。libpq 的 `require` 只要求加密、
 *      **不**校验证书有效性（这是 `require` 与 `verify-ca` 的核心差别）。
 *      实测：对自签证书的服务器传 `ssl: true` 直接失败
 *      （`self-signed certificate`）。若把 `require` 映射成 `ssl: true`，
 *      用户按 psql 的经验填 `require` 反而连不上自签库——是最坏的那种"看起来对的错"。
 *
 *   2. **`pg` 没有 `prefer` 的优雅降级**。libpq 的 `prefer` 会"先试 SSL，
 *      服务器不支持就回退明文"。实测：对未开 SSL 的服务器传任一 ssl 选项，
 *      `pg` 直接抛 `The server does not support SSL connections`，不会自动回退。
 *      所以回退必须由**我们**在这一层实现（见下 `planAttempts` / `openClient`）。
 *
 *   3. **`verify-ca` 与 `verify-full` 的差别只在"要不要校验主机名"**。
 *      两者都校验证书链（`rejectUnauthorized: true`），
 *      `verify-full` 额外要求证书里的 SAN/CN 与连接主机名一致。
 *      实测：`verify-ca` 用 `checkServerIdentity: () => undefined` 关掉主机名校验后通过，
 *      而 `verify-full` 换个不匹配的主机会被拒。
 *
 * ============================================================================
 * 一次刻意的、偏离 libpq 的地方（必须写清楚）
 * ============================================================================
 *
 * `prefer` / `allow` 的回退**只在一种明确的条件下触发**，不像 libpq 那样"第一步失败就试第二步"：
 *
 *   - `prefer`：只有"服务器不支持 SSL"才回退明文。若 TLS 握手成功但**认证失败**
 *     （密码错、pg_hba 拒绝），直接把这个错误抛出去——因为再试一次明文不会有不同结果，
 *     只会用第二个（通常更难懂的）错误覆盖掉第一个真正有用的错误。
 *   - `allow`：只有"服务端要求加密"（错误信息含 `no encryption`）才回退到 SSL。
 *
 * 这比 libpq 更保守，但在 UI 场景下更可预期：用户看到的永远是**最相关**的那个错误，
 * 而不是"回退后那条路径"的错误。
 */

import { readFileSync } from 'node:fs'
import type { Duplex } from 'node:stream'
import { Client } from 'pg'

/** libpq 的 sslmode 取值。 */
export type PgSslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'

/** 默认模式：与 psql 不带参数时一致，保证"不填也能连上绝大多数库"。 */
export const DEFAULT_SSL_MODE: PgSslMode = 'prefer'

const VALID_MODES: readonly PgSslMode[] = [
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full'
]

export function isPgSslMode(value: string): value is PgSslMode {
  return (VALID_MODES as readonly string[]).includes(value)
}

/**
 * `pg` 的 `ssl` 选项。
 *
 * `false` 表示完全不用 SSL；对象形态表示要握手，
 * 其中 `rejectUnauthorized` 决定**是否校验证书链**。
 */
export type PgSslOption =
  | false
  | {
      readonly rejectUnauthorized: boolean
      readonly ca?: string
      /**
       * 覆盖主机名校验。仅 `verify-ca` 使用——把它设成返回 undefined 的函数
       * 即"校验证书链、但不检查主机名"。
       */
      readonly checkServerIdentity?: () => undefined
    }

/** 一次连接尝试。`label` 只用于错误信息，让用户知道当时用的是什么策略。 */
export interface SslAttempt {
  readonly label: string
  readonly ssl: PgSslOption
  /**
   * 判定"这次失败是否值得回退到下一次尝试"。
   * 缺省表示不回退（失败即终态）。
   */
  readonly shouldFallback?: (error: unknown) => boolean
}

/**
 * 读取 CA 证书内容。
 *
 * 失败时**明确报错而不是静默忽略**：用户显式填了 CA 路径又选了会校验证书的模式，
 * 此时若静默降级成"不校验"，等于把用户的安全意图悄悄取消掉——
 * 那正是这类功能最危险的行为。
 */
function loadCa(caPath: string): string {
  try {
    return readFileSync(caPath, 'utf8')
  } catch (thrown) {
    const code = (thrown as { code?: unknown }).code
    if (code === 'ENOENT') {
      throw new Error(`CA 证书文件不存在：${caPath}`)
    }
    const message = (thrown as { message?: unknown }).message
    throw new Error(`无法读取 CA 证书 ${caPath}：${String(message ?? thrown)}`)
  }
}

/** 判断一个错误是否表示"服务器不支持 SSL 协商"。 */
function isServerWithoutSsl(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.includes('does not support SSL')
}

/**
 * 判断一个错误是否表示"服务端要求加密，明文被拒"。
 *
 * PG 在 `pg_hba.conf` 只有 `hostssl` 项时，明文连接会被拒，
 * 错误信息里带 `no encryption`（实测 PG 17）。
 */
function isSslRequiredByServer(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.includes('no encryption')
}

/**
 * 把 sslmode 展开成**有序的尝试列表**。
 *
 * 单项列表表示"只试一次、成败即终态"（require / verify-* / disable）；
 * 两项列表表示有回退（prefer / allow）。
 *
 * `caPath` 只在 `verify-ca` / `verify-full` 下被读取——其余模式即使填了
 * 也不读，避免"填了个不需要的路径却因为文件不存在而连不上"。
 */
export function planAttempts(mode: PgSslMode, caPath: string | undefined): SslAttempt[] {
  switch (mode) {
    case 'disable':
      return [{ label: 'disable（明文）', ssl: false }]

    case 'require':
      // 只要加密，不校验证书——这正是与 verify-ca 的分界。
      return [{ label: 'require（加密，不校验证书）', ssl: { rejectUnauthorized: false } }]

    case 'verify-ca': {
      if (caPath === undefined || caPath === '') {
        throw new Error('verify-ca 需要 CA 证书路径（sslrootcert）')
      }
      const ca = loadCa(caPath)
      return [
        {
          label: 'verify-ca（校验 CA，不校验主机名）',
          ssl: { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined }
        }
      ]
    }

    case 'verify-full': {
      if (caPath === undefined || caPath === '') {
        throw new Error('verify-full 需要 CA 证书路径（sslrootcert）')
      }
      const ca = loadCa(caPath)
      // 不覆盖 checkServerIdentity：保留 Node 默认的主机名校验。
      return [{ label: 'verify-full（校验 CA 与主机名）', ssl: { ca, rejectUnauthorized: true } }]
    }

    case 'prefer':
      return [
        {
          label: 'prefer（先试 SSL）',
          ssl: { rejectUnauthorized: false },
          shouldFallback: isServerWithoutSsl
        },
        { label: 'prefer（回退明文）', ssl: false }
      ]

    case 'allow':
      return [
        { label: 'allow（先试明文）', ssl: false, shouldFallback: isSslRequiredByServer },
        { label: 'allow（回退 SSL）', ssl: { rejectUnauthorized: false } }
      ]
  }
}

/** 建立一个 `pg.Client` 所需的参数（不含 ssl，已由 attempts 表达）。 */
export interface OpenClientOptions {
  readonly host: string
  readonly port: number
  readonly database: string
  readonly user: string
  readonly password: string | undefined
  readonly attempts: readonly SslAttempt[]
  /** 连接超时（毫秒）。 */
  readonly connectionTimeoutMillis: number
  /** `application_name`，便于 DBA 在 pg_stat_activity 里识别。 */
  readonly applicationName: string
  /**
   * 打开底层传输。缺省时由 `pg` 自己建 TCP 连接（直连）。
   *
   * 传了它就等同于"走 SSH 隧道"：本项目在隧道里拿到的是一条已连接的 channel，
   * 交给 `pg` 的 `stream` 选项后，SSL 握手仍会在这条流上正常进行
   * （TLS 只关心字节流，不关心下面是 TCP 还是 SSH 通道）。
   *
   * 每次尝试都重新调用：prefer 模式失败要回退时，上一条流的重试需要新通道。
   */
  readonly openStream?: () => Promise<Duplex>
}

/**
 * 按尝试列表建连。
 *
 * 关键约定：**全部失败时抛第一个错误**，而不是最后一个。
 * 因为第一个尝试是用户显式选的那个策略（如 `prefer` 的 SSL 尝试），
 * 它的错误最贴近用户意图；回退路径的错误（如"明文被 pg_hba 拒"）通常是噪音。
 */
export async function openClient(options: OpenClientOptions): Promise<Client> {
  let firstError: unknown = null
  for (const attempt of options.attempts) {
    /**
     * 隧道模式下先拿流、再交给 pg。流建立失败属于**传输层**问题，
     * 与 sslmode 无关——此时不应继续尝试下一种 sslmode（那只会重复失败），
     * 所以直接抛出去。
     */
    /**
     * 注意 `pg` 的 `stream` 选项是**函数**（`() => Duplex`），不是 Duplex 实例。
     * 直接传实例会编译失败；传一个返回实例的函数才两边都对。
     *
     * 我们的 `openStream` 是异步的（要先等 SSH channel），
     * 所以先 await 拿到实例，再包成一个同步工厂交给 pg。
     */
    const stream = options.openStream === undefined ? undefined : await options.openStream()
    const client = new Client({
      host: options.host,
      port: options.port,
      database: options.database,
      user: options.user,
      password: options.password,
      ssl: attempt.ssl,
      connectionTimeoutMillis: options.connectionTimeoutMillis,
      application_name: options.applicationName,
      ...(stream === undefined ? {} : { stream: () => stream })
    })
    try {
      await client.connect()
      return client
    } catch (thrown) {
      if (firstError === null) firstError = thrown
      /*
       * 清理失败尝试的句柄。
       *
       * `end()` 在“connect 都没成功”时也可能挂起或再抛错：此时 pg 内部
       * 没有进入 ended 状态。timeout 兜底是为了不让 fallback 被一次坏连接的
       * 清理拖死；真正的原始错误仍然优先抛出。
       */
      await endQuietly(client)
      const canFallback = attempt.shouldFallback?.(thrown) === true
      if (!canFallback) throw thrown
    }
  }
  throw firstError ?? new Error('无法建立 PostgreSQL 连接')
}

/** 尽力关闭客户端；失败与超时都静默，调用方处在上报原始错误的路径上。 */
async function endQuietly(client: Client, timeoutMs = 1000): Promise<void> {
  try {
    await Promise.race([
      client.end().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ])
  } catch {
    // ignore：原始连接错误更重要
  }
}
