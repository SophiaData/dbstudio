/**
 * MySQL / MariaDB 的 TLS 配置。
 *
 * ===== 为什么不能把 sslmode 直接透传给 mysql2 =====
 *
 * `mysql2` 的 `ssl` 选项接受的是 Node `tls.connect` 的配置（`ca` /
 * `rejectUnauthorized` / `checkServerIdentity`），它**没有** libpq 那套
 * `sslmode` 语义。直接把字符串丢过去既不会被识别，也不会报错——
 * 结果是"用户以为开了 verify-full，其实根本没加密"。这属于安全问题，
 * 所以这里显式把模式映射成 tls 配置。
 *
 * 取值与 PostgreSQL 驱动保持一致，方便用户迁移认知；但 MySQL 没有
 * `allow` / `prefer` 的自动回退能力，所以只提供四个确定模式：
 *
 *   - `disable`     不加密（默认，保持既有连接行为不变）
 *   - `require`     必须加密，但不校验证书（对应 libpq 的 `require`）
 *   - `verify-ca`   必须加密且校验证书链，不校验主机名
 *   - `verify-full` 必须加密、校验证书链与主机名
 */

import { readFileSync } from 'node:fs'

export type MysqlSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full'

export const DEFAULT_MYSQL_SSL_MODE: MysqlSslMode = 'disable'

export function isMysqlSslMode(value: string): value is MysqlSslMode {
  return value === 'disable' || value === 'require' || value === 'verify-ca' || value === 'verify-full'
}

export interface MysqlSslOptions {
  readonly rejectUnauthorized: boolean
  readonly ca?: string
  /**
   * `verify-ca` 用：跳过主机名校验。
   *
   * Node 的 `checkServerIdentity` 返回 `undefined` 表示通过；
   * 返回 Error 才是失败。这里显式返回 undefined。
   */
  readonly checkServerIdentity?: () => undefined
}

/**
 * 把模式映射成 mysql2 的 `ssl` 配置。`undefined` 表示不启用 TLS。
 *
 * CA 不可读时抛错而不是降级：用户选了 verify-* 却因为文件路径错而
 * 静默变成不校验，是最危险的失败方式。
 */
export function planMysqlSsl(mode: MysqlSslMode, caPath: string | undefined): MysqlSslOptions | undefined {
  if (mode === 'disable') return undefined
  if (mode === 'require') return { rejectUnauthorized: false }

  const path = caPath?.trim() ?? ''
  if (path === '') {
    throw new Error(`sslmode=${mode} 需要提供 CA 证书路径（sslrootcert）。`)
  }
  let ca: string
  try {
    ca = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`无法读取 CA 证书文件：${path}`)
  }

  if (mode === 'verify-ca') {
    return { rejectUnauthorized: true, ca, checkServerIdentity: () => undefined }
  }
  return { rejectUnauthorized: true, ca }
}
