/**
 * HTTP server composition root。
 *
 * 这层把「认证后的 principal → 独立 application scope」固定下来：每个 owner
 * 都有自己的 ConnectionStore、SqlLibraryStore、ConnectionManager、游标和任务组。
 * HTTP listener、JWT/mTLS 解析和上传 artifact 路由都在它之外，避免把框架细节
 * 带进 application services。
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { BackendPrincipal, BackendRequestContext } from '../../backend/transport/transport'
import type { RemoteBackendApi } from '../../backend/contract/backend'
import type { RemoteOutboundPolicy } from '../../backend/contract/remote'
import { isRemoteConnectionOptionSafe, toRemoteConnectionSummary } from '../../backend/contract/remote-connection'
import { REMOTE_BACKEND_METHOD_MANIFEST } from '../../backend/contract/method-manifest'
import { BackendError } from '../../backend/contract/errors'
import {
  createBackendDispatcher,
  type BackendDispatcher,
  type BackendDispatcherApi
} from '../../backend/transport/dispatcher'
import type { WireDecodeLimits } from '../../backend/transport/wire-codec'
import type { DialectInfo } from '../../core/driver'
import { ConnectionStore, type SecretCipher } from '../ConnectionStore'
import { SqlLibraryStore } from '../SqlLibraryStore'
import { ConnectionManager } from '../ConnectionManager'
import {
  createApplicationApi,
  type ApplicationApi
} from '../application/create-application-api'
import type { ConnectionLogger, DriverHostFactory } from '../application/types'
import { DEFAULT_ARTIFACT_MAX_TOTAL_BYTES, LocalArtifactStore } from './artifact-store'
import type { OwnerGovernance } from './owner-governance'

export interface HttpServerCompositionOptions {
  readonly dialects: readonly DialectInfo[]
  /** 所有 owner scope 的父目录；每个 owner 会使用不可逆 hash 子目录。 */
  readonly baseDir: string
  /** server 端凭据策略；null 明确表示不持久化密码。 */
  readonly cipher: SecretCipher | null | ((ownerId: string) => SecretCipher | null)
  readonly onLog?: ConnectionLogger
  readonly createDriverHost?: DriverHostFactory
  /** 远程连接出站目标策略；未提供时使用空allowlist拒绝所有连接目标。 */
  readonly remoteOutboundPolicy?: RemoteOutboundPolicy
  /** 外部 wire 请求的解码深度与节点数上限。 */
  readonly decodeLimits?: WireDecodeLimits
  /** 每个 owner 的 artifact 单文件大小上限。 */
  readonly artifactMaxBytes?: number
  /** 每个 owner 的 artifact 总容量上限；还会与 owner governance 取更小值。 */
  readonly artifactMaxTotalBytes?: number
  /** artifact ticket 的默认有效期。 */
  readonly artifactTtlMs?: number
  /** artifact 过期清理的定时周期。 */
  readonly artifactSweepIntervalMs?: number
  /** owner 生命周期治理；不绑定具体认证或存储实现。 */
  readonly governance?: OwnerGovernance
}

export interface HttpServerOwnerScope {
  readonly ownerId: string
  readonly api: RemoteBackendApi
  readonly manager: ConnectionManager
  readonly sqlLibrary: SqlLibraryStore
  readonly artifactStore: LocalArtifactStore
  dispose(): Promise<void>
}

export interface HttpServerComposition {
  readonly dispatch: BackendDispatcher
  scopeFor(principal: BackendPrincipal): HttpServerOwnerScope
  dispose(): Promise<void>
}

function ownerStorageDir(baseDir: string, ownerId: string): string {
  const digest = createHash('sha256').update(ownerId, 'utf8').digest('hex')
  return join(baseDir, 'owners', digest)
}

function normalizeOwnerId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BackendError({
      code: 'unauthorized',
      message: 'HTTP backend 请求缺少有效 principal'
    })
  }
  return value.trim()
}

function requireOwnerId(context: BackendRequestContext): string {
  return normalizeOwnerId(context.principal?.id)
}

function resolveCipher(
  cipher: HttpServerCompositionOptions['cipher'],
  ownerId: string
): SecretCipher | null {
  return typeof cipher === 'function' ? cipher(ownerId) : cipher
}

/**
 * 让 remote scope 在运行时也只有 remote capability。
 *
 * `RemoteBackendApi` 的 Omit 只约束编译期；如果直接把完整 application API
 * 放进 scope，调用方仍可能通过动态属性访问到 desktop path capability。这里按
 * remote manifest 重新投影对象，让 dispatcher 之外的组合代码也拿不到这些方法。
 */
function projectRemoteApi(api: ApplicationApi): RemoteBackendApi {
  const entries = REMOTE_BACKEND_METHOD_MANIFEST.map(({ method }) => {
    const handler = api[method as keyof ApplicationApi]
    if (typeof handler !== 'function') {
      throw new Error(`remote manifest 方法 ${method} 未在 application API 实现`)
    }
    if (method === 'listConnections') {
      return [method, async () => (await api.listConnections()).map(toRemoteConnectionSummary)] as const
    }
    if (method === 'connectConnection' || method === 'disconnectConnection') {
      return [method, async (id: string) => toRemoteConnectionSummary(await api[method](id))] as const
    }
    if (method === 'listChildren') {
      return [method, async (nodeId: string | null) => {
        const nodes = await api.listChildren(nodeId)
        if (nodeId !== null) return nodes
        return nodes.map((node) => node.meta ? {
          ...node,
          meta: Object.fromEntries(Object.entries(node.meta).filter(([key, value]) =>
            !key.startsWith('options.') || isRemoteConnectionOptionSafe(key.slice('options.'.length), value)
          ))
        } : node)
      }] as const
    }
    return [method, handler] as const
  })
  return Object.fromEntries(entries) as RemoteBackendApi
}

export function createHttpServerComposition(
  options: HttpServerCompositionOptions
): HttpServerComposition {
  if (!options || typeof options.baseDir !== 'string' || options.baseDir.trim() === '') {
    throw new Error('HTTP server composition 缺少 baseDir')
  }
  if (!Array.isArray(options.dialects)) {
    throw new Error('HTTP server composition 缺少 dialects')
  }

  const scopes = new Map<string, HttpServerOwnerScope>()
  let disposed = false

  const scopeFor = (principal: BackendPrincipal): HttpServerOwnerScope => {
    const ownerId = normalizeOwnerId(principal?.id)
    const existing = scopes.get(ownerId)
    if (existing) return existing
    if (disposed) throw new Error('HTTP server composition 已关闭')
    options.governance?.ensureOwner(ownerId)

    const ownerDir = ownerStorageDir(options.baseDir, ownerId)
    const store = new ConnectionStore({
      baseDir: ownerDir,
      cipher: resolveCipher(options.cipher, ownerId),
      onLog: options.onLog
    })
    const sqlLibrary = new SqlLibraryStore({
      baseDir: ownerDir,
      onLog: options.onLog
    })
    const manager = new ConnectionManager(options.dialects, store, {
      onLog: options.onLog,
      createDriverHost: options.createDriverHost,
      remoteOutboundPolicy: options.remoteOutboundPolicy ?? { allowedHosts: [], allowedPorts: [] },
      reserveConnection: options.governance
        ? () => options.governance!.reserveConnection(ownerId)
        : undefined
    })
    const ownerQuota = options.governance?.quotaFor(ownerId)
    const artifactStore = new LocalArtifactStore({
      baseDir: ownerDir,
      maxBytes: options.artifactMaxBytes,
      maxTotalBytes: Math.min(
        options.artifactMaxTotalBytes ?? DEFAULT_ARTIFACT_MAX_TOTAL_BYTES,
        ownerQuota?.maxStorageBytes ?? DEFAULT_ARTIFACT_MAX_TOTAL_BYTES
      ),
      defaultTtlMs: options.artifactTtlMs,
      sweepIntervalMs: options.artifactSweepIntervalMs,
      reserveStorage: options.governance
        ? (bytes) => options.governance!.reserveStorage(ownerId, bytes)
        : undefined
    })
    artifactStore.startSweep()
    const api = projectRemoteApi(
      createApplicationApi({
        getManager: () => manager,
        getSqlLibrary: () => sqlLibrary
      })
    )
    const scope: HttpServerOwnerScope = {
      ownerId,
      api,
      manager,
      sqlLibrary,
      artifactStore,
      async dispose(): Promise<void> {
        if (scopes.get(ownerId) !== scope) return
        scopes.delete(ownerId)
        artifactStore.dispose()
        options.governance?.disposeOwner(ownerId)
        await manager.disposeAll()
      }
    }
    scopes.set(ownerId, scope)
    return scope
  }

  const resolveApi = (context: BackendRequestContext): BackendDispatcherApi => {
    const ownerId = requireOwnerId(context)
    return scopeFor({ id: ownerId }).api
  }
  const dispatcher = createBackendDispatcher({
    api: resolveApi,
    manifest: REMOTE_BACKEND_METHOD_MANIFEST,
    decodeLimits: options.decodeLimits
  })

  return {
    dispatch: dispatcher,
    scopeFor,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      const active = [...scopes.values()]
      scopes.clear()
      await Promise.all(
        active.map(async (scope) => {
          scope.artifactStore.dispose()
          options.governance?.disposeOwner(scope.ownerId)
          await scope.manager.disposeAll()
        })
      )
      options.governance?.dispose()
    }
  }
}
