/** Electron 与独立 Node 入口共享的 HTTP 启动配置。 */
import type { IncomingMessage } from 'node:http'
import type { BackendPrincipal } from '../../backend/transport/transport'
import type { RemoteOutboundPolicy } from '../../backend/contract/remote'
import { createHttpAuthResolver } from './http-auth'
import { createJwtPrincipalResolver, validateHttpJwtAuthConfig, type HttpJwtAuthConfig } from './http-jwt-auth'

export interface HttpServerStartupConfig {
  readonly host: string
  readonly port: number
  readonly ownerId?: string
  readonly authMode?: 'jwt' | 'local'
  readonly requireAuth?: boolean
  readonly jwt?: HttpJwtAuthConfig
  readonly remoteOutboundPolicy: RemoteOutboundPolicy
}

export type HttpServerStartupEnv = Readonly<Record<string, string | undefined>>
export type HttpServerPrincipalResolver = (
  request: IncomingMessage
) => BackendPrincipal | null | undefined | Promise<BackendPrincipal | null | undefined>

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function csvValues(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
}

function portValues(value: string | undefined): number[] {
  return csvValues(value).map((item) => {
    const port = Number(item)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error('DBSTUDIO_HTTP_ALLOWED_PORTS 必须是 1 到 65535 的端口列表')
    }
    return port
  })
}

export function readHttpServerStartupConfig(env: HttpServerStartupEnv): HttpServerStartupConfig | null {
  const rawPort = env['DBSTUDIO_HTTP_PORT']?.trim()
  if (!rawPort) return null
  const port = Number(rawPort)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error('DBSTUDIO_HTTP_PORT 必须是 0 到 65535 之间的整数')
  }
  const host = env['DBSTUDIO_HTTP_HOST']?.trim() || '127.0.0.1'
  const ownerId = env['DBSTUDIO_HTTP_OWNER_ID']?.trim() || undefined
  const rawMode = env['DBSTUDIO_HTTP_AUTH_MODE']?.trim()
  if (rawMode && rawMode !== 'jwt' && rawMode !== 'local') {
    throw new Error('DBSTUDIO_HTTP_AUTH_MODE 仅允许 jwt 或 local')
  }
  const rawRequireAuth = env['DBSTUDIO_HTTP_REQUIRE_AUTH']?.trim()
  if (rawRequireAuth && !['0', '1', 'false', 'true'].includes(rawRequireAuth)) {
    throw new Error('DBSTUDIO_HTTP_REQUIRE_AUTH 必须是 0/1 或 false/true')
  }
  const requireAuth = rawRequireAuth === '1' || rawRequireAuth === 'true'
  const issuer = env['DBSTUDIO_HTTP_JWT_ISSUER']?.trim() || ''
  const audience = env['DBSTUDIO_HTTP_JWT_AUDIENCE']?.trim() || ''
  const jwksUrl = env['DBSTUDIO_HTTP_JWT_JWKS_URL']?.trim() || undefined
  const jwksFile = env['DBSTUDIO_HTTP_JWT_JWKS_FILE']?.trim() || undefined
  const hasJwt = Boolean(issuer || audience || jwksUrl || jwksFile)
  const authMode: 'jwt' | 'local' | undefined = rawMode === 'jwt' || rawMode === 'local'
    ? rawMode : (hasJwt ? 'jwt' : undefined)
  if (authMode === 'local' && (hasJwt || requireAuth)) {
    throw new Error('local 认证模式不能配置 JWT 或 REQUIRE_AUTH')
  }
  const jwt = authMode === 'jwt' ? { issuer, audience, jwksUrl, jwksFile } : undefined
  if (jwt) validateHttpJwtAuthConfig(jwt)
  const config: HttpServerStartupConfig = {
    host, port,
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(authMode === undefined ? {} : { authMode }),
    ...(requireAuth ? { requireAuth } : {}),
    ...(jwt === undefined ? {} : { jwt }),
    remoteOutboundPolicy: {
      allowedHosts: csvValues(env['DBSTUDIO_HTTP_ALLOWED_HOSTS']),
      allowedPorts: portValues(env['DBSTUDIO_HTTP_ALLOWED_PORTS'])
    }
  }
  if (ownerId && (!isLoopbackHost(host) || authMode === 'jwt' || requireAuth)) {
    throw new Error('DBSTUDIO_HTTP_OWNER_ID 仅允许 loopback host 的显式 local 配置；认证模式不能使用固定 owner')
  }
  if (authMode === 'local' && !ownerId) throw new Error('local 模式必须配置 DBSTUDIO_HTTP_OWNER_ID')
  return config
}

export function createHttpServerPrincipalResolver(
  config: HttpServerStartupConfig,
  injected?: HttpServerPrincipalResolver
): HttpServerPrincipalResolver {
  if (config.ownerId && (!isLoopbackHost(config.host) || config.authMode === 'jwt' || config.requireAuth)) {
    throw new Error('DBSTUDIO_HTTP_OWNER_ID 仅允许 loopback host 的显式 local 配置')
  }
  // 测试或嵌入部署仍可注入 provider，边界始终投影并统一异常。
  if (injected) return createHttpAuthResolver({ resolvePrincipal: injected })
  if (config.authMode === 'jwt' && config.jwt) return createJwtPrincipalResolver(config.jwt)
  // 兼容旧版显式 loopback + OWNER_ID；没有 owner 时绝不隐式创建本地身份。
  if (config.ownerId && isLoopbackHost(config.host) && !config.requireAuth) {
    return createHttpAuthResolver({ resolvePrincipal: () => ({ id: config.ownerId! }) })
  }
  throw new Error('HTTP server 缺少认证配置；必须配置 JWT 或注入 resolvePrincipal')
}
