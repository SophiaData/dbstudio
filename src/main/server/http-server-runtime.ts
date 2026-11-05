/** 不依赖 Electron 的共享 HTTP 启动组合；环境校验先于 listener 与 owner scope。 */
import { isAbsolute } from 'node:path'
import { BUILTIN_DIALECT_METADATA } from '../../drivers/dialect-metadata'
import type { SecretCipher } from '../ConnectionStore'
import type { DriverHostFactory, ConnectionLogger } from '../application/types'
import type { RemoteOutboundPolicy } from '../../backend/contract/remote'
import { createHttpAuthResolver, type HttpAuthProvider } from './http-auth'
import { createHttpServerComposition } from './http-server-composition'
import { createHttpServer, type HttpServer } from './http-server'
import { type HttpRequestAuditSink } from './http-server-handler'
import {
  createHttpServerPrincipalResolver, readHttpServerStartupConfig,
  type HttpServerPrincipalResolver, type HttpServerStartupEnv
} from './http-server-config'
import { DEFAULT_OWNER_QUOTA, OwnerGovernance, type OwnerQuota } from './owner-governance'

export interface HttpServerRuntimeDependencies {
  readonly baseDir: string
  readonly cipher: SecretCipher | null
  readonly resolvePrincipal?: HttpServerPrincipalResolver
  readonly authProvider?: HttpAuthProvider
  readonly governance?: OwnerGovernance
  readonly ownerQuota?: OwnerQuota
  readonly remoteOutboundPolicy?: RemoteOutboundPolicy
  readonly auditSink?: HttpRequestAuditSink
  readonly metricsSink?: HttpRequestAuditSink
  readonly createDriverHost?: DriverHostFactory
  readonly onLog?: ConnectionLogger
}

function positiveEnv(env: HttpServerStartupEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`)
  return value
}

function consoleSink(prefix: string): HttpRequestAuditSink {
  return { record: (event) => console.log(`[${prefix}] ${JSON.stringify(event)}`) }
}

export async function createConfiguredHttpServer(
  env: HttpServerStartupEnv,
  dependencies: HttpServerRuntimeDependencies
): Promise<HttpServer | null> {
  const config = readHttpServerStartupConfig(env)
  if (!config) return null
  if (!dependencies.baseDir || !isAbsolute(dependencies.baseDir)) {
    throw new Error('HTTP server 数据目录必须是绝对路径')
  }
  const allowedOrigins = env['DBSTUDIO_HTTP_ALLOWED_ORIGINS']?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? []
  if (allowedOrigins.length > 0 && (config.authMode !== 'jwt' && !config.requireAuth)) {
    throw new Error('DBSTUDIO_HTTP_ALLOWED_ORIGINS 仅允许 JWT 或 REQUIRE_AUTH 认证模式')
  }
  if (allowedOrigins.includes('*')) throw new Error('DBSTUDIO_HTTP_ALLOWED_ORIGINS 禁止通配符')
  const injected = dependencies.resolvePrincipal ?? (dependencies.authProvider
    ? createHttpAuthResolver(dependencies.authProvider) : undefined)
  const resolvePrincipal = createHttpServerPrincipalResolver(config, injected)
  const maxConcurrentRequests = positiveEnv(env, 'DBSTUDIO_HTTP_MAX_CONCURRENT_REQUESTS', DEFAULT_OWNER_QUOTA.maxConcurrentRequests)
  const quota = dependencies.ownerQuota ?? {
    maxConcurrentRequests,
    maxConnections: positiveEnv(env, 'DBSTUDIO_HTTP_MAX_CONNECTIONS', DEFAULT_OWNER_QUOTA.maxConnections),
    maxStorageBytes: positiveEnv(env, 'DBSTUDIO_HTTP_MAX_STORAGE_BYTES', DEFAULT_OWNER_QUOTA.maxStorageBytes)
  }
  const artifactMaxBytes = positiveEnv(env, 'DBSTUDIO_HTTP_ARTIFACT_MAX_BYTES', 100 * 1024 * 1024)
  const artifactMaxTotalBytes = positiveEnv(env, 'DBSTUDIO_HTTP_ARTIFACT_MAX_TOTAL_BYTES', 1024 * 1024 * 1024)
  const artifactSweepIntervalMs = positiveEnv(env, 'DBSTUDIO_HTTP_ARTIFACT_SWEEP_INTERVAL_MS', 60 * 1000)
  const governance = dependencies.governance ?? new OwnerGovernance({
    quota,
    audit: (event) => console.log(`[http-owner-audit] ${JSON.stringify(event)}`)
  })
  const composition = createHttpServerComposition({
    dialects: BUILTIN_DIALECT_METADATA,
    baseDir: dependencies.baseDir,
    cipher: dependencies.cipher,
    onLog: dependencies.onLog,
    createDriverHost: dependencies.createDriverHost,
    remoteOutboundPolicy: dependencies.remoteOutboundPolicy ?? config.remoteOutboundPolicy,
    artifactMaxBytes, artifactMaxTotalBytes, artifactSweepIntervalMs, governance
  })
  const server = createHttpServer({
    composition,
    listen: { host: config.host, port: config.port },
    resolvePrincipal, governance, maxConcurrentRequests, allowedOrigins,
    auditSink: dependencies.auditSink ?? consoleSink('http-audit'),
    metricsSink: dependencies.metricsSink ?? consoleSink('http-metrics')
  })
  try {
    await server.listen()
    return server
  } catch (error) {
    await server.close().catch(() => undefined)
    throw error
  }
}
