/** Electron main 进程 HTTP listener 的最小启动配置与认证注入边界。 */

import type { IncomingMessage } from 'node:http'
import type { BackendPrincipal } from '../../backend/transport/transport'
import type { RemoteOutboundPolicy } from '../../backend/contract/remote'

export interface HttpServerStartupConfig {
  readonly host: string
  readonly port: number
  /** 仅 loopback 本地单租户模式使用；远程模式必须注入 resolver。 */
  readonly ownerId?: string
  /** 远程驱动实际可访问的主机/端口 allowlist；缺省为空，fail closed。 */
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
  return csvValues(value).map((item) => Number(item)).filter((item) => Number.isSafeInteger(item) && item >= 1 && item <= 65_535)
}

/**
 * HTTP 服务默认完全关闭。resolver 不绑定任何认证协议，部署方可注入自己的认证实现。
 * 固定 owner 只允许 loopback，防止把本地单租户身份误当作远程认证。
 */
export function readHttpServerStartupConfig(
  env: HttpServerStartupEnv
): HttpServerStartupConfig | null {
  const rawPort = env['DBSTUDIO_HTTP_PORT']?.trim()
  if (!rawPort) return null

  const port = Number(rawPort)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error('DBSTUDIO_HTTP_PORT 必须是 0 到 65535 之间的整数')
  }

  const host = env['DBSTUDIO_HTTP_HOST']?.trim() || '127.0.0.1'
  const ownerId = env['DBSTUDIO_HTTP_OWNER_ID']?.trim() || undefined
  const remoteOutboundPolicy = {
    allowedHosts: csvValues(env['DBSTUDIO_HTTP_ALLOWED_HOSTS']),
    allowedPorts: portValues(env['DBSTUDIO_HTTP_ALLOWED_PORTS'])
  }
  return ownerId === undefined
    ? { host, port, remoteOutboundPolicy }
    : { host, port, ownerId, remoteOutboundPolicy }
}

export function createHttpServerPrincipalResolver(
  config: HttpServerStartupConfig,
  injected?: HttpServerPrincipalResolver
): HttpServerPrincipalResolver {
  const loopback = isLoopbackHost(config.host)
  if (config.ownerId && !loopback) {
    throw new Error('DBSTUDIO_HTTP_OWNER_ID 仅允许 loopback host；远程模式必须注入认证 resolver')
  }
  if (injected) return injected
  if (config.ownerId && loopback) return () => ({ id: config.ownerId! })
  throw new Error('HTTP server 缺少认证 resolver；远程模式必须注入 resolvePrincipal')
}
