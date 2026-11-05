import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'
import type { BackendPrincipal } from '../../backend/transport/transport'
import {
  remoteConnectionPath,
  toRemoteConnectionSummary,
  type RemoteConnectionCreateRequest,
  type RemoteConnectionUpdateRequest
} from '../../backend/contract/remote-connection'
import { BackendError, toBackendErrorPayload } from '../../backend/contract/errors'
import type { ConnectionConfig } from '../../core/dialect'
import type { SecretInput } from '../../core/driver'
import type { HttpServerComposition } from './http-server-composition'
import {
  createHttpRequestLimiter,
  DEFAULT_HTTP_MAX_BODY_BYTES,
  DEFAULT_HTTP_MAX_REQUEST_ID_LENGTH,
  type HttpRequestAuditEvent,
  type HttpRequestAuditSink,
  type HttpRequestLimiter
} from './http-server-handler'
import { OwnerGovernance, OwnerQuotaError, type OwnerLease } from './owner-governance'

export const CONNECTION_ROUTE_PREFIX = '/connections'

export interface HttpConnectionRouterOptions {
  readonly composition: Pick<HttpServerComposition, 'scopeFor'>
  readonly resolvePrincipal?: (
    request: IncomingMessage
  ) => BackendPrincipal | null | undefined | Promise<BackendPrincipal | null | undefined>
  readonly requestLimiter?: HttpRequestLimiter
  readonly maxConcurrentRequests?: number
  readonly maxBodyBytes?: number
  readonly maxRequestIdLength?: number
  readonly governance?: OwnerGovernance
  readonly auditSink?: HttpRequestAuditSink
  readonly metricsSink?: HttpRequestAuditSink
}

export type HttpConnectionRouter = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<boolean>

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) return
  const body = JSON.stringify(value)
  response.statusCode = statusCode
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', Buffer.byteLength(body))
  response.end(body)
}

function success(value: unknown): { readonly ok: true; readonly value: unknown } {
  return { ok: true, value }
}

function failure(code: string, message: string): { readonly ok: false; readonly error: { code: string; message: string } } {
  return { ok: false, error: { code, message } }
}

function statusForCode(code: string): number {
  switch (code) {
    case 'invalid-argument': return 400
    case 'unauthorized': return 401
    case 'not-found': return 404
    case 'conflict': return 409
    case 'cancelled': return 499
    case 'timeout': return 504
    case 'backend-unavailable': return 503
    default: return 500
  }
}

function routeError(error: unknown): { status: number; body: ReturnType<typeof failure> } {
  if (error instanceof OwnerQuotaError) {
    return { status: 429, body: failure('conflict', error.message) }
  }
  if (error instanceof BackendError) {
    const status = error.code === 'conflict' &&
      error.details && typeof error.details === 'object' &&
      'resource' in error.details
      ? 429
      : statusForCode(error.code)
    return { status, body: failure(error.code, error.message) }
  }
  const payload = toBackendErrorPayload(error)
  return {
    status: statusForCode(payload.code),
    body: failure(payload.code, payload.code === 'internal' ? 'connection 服务暂时不可用' : payload.message)
  }
}

function requirePrincipal(value: BackendPrincipal | null | undefined): BackendPrincipal {
  if (!value || typeof value.id !== 'string' || value.id.trim() === '') {
    throw new BackendError({ code: 'unauthorized', message: 'HTTP backend 请求缺少有效 principal' })
  }
  return { ...value, id: value.id.trim() }
}

function isJson(request: IncomingMessage): boolean {
  const value = request.headers['content-type']
  return typeof value === 'string' && (value.split(';', 1)[0] ?? '').trim().toLowerCase() === 'application/json'
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers['content-length']
  if (typeof contentLength === 'string') {
    const declared = Number(contentLength)
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      request.resume()
      throw new BackendError({ code: 'invalid-argument', message: 'connection 请求体超过大小上限' })
    }
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maxBytes) {
      request.resume()
      throw new BackendError({ code: 'invalid-argument', message: 'connection 请求体超过大小上限' })
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) throw new BackendError({ code: 'invalid-argument', message: 'connection 请求体不能为空' })
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BackendError({ code: 'invalid-argument', message: 'connection 请求体必须是合法 JSON' })
  }
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BackendError({ code: 'invalid-argument', message: 'connection 请求体必须是对象' })
  }
  return value as Record<string, unknown>
}

function configAndSecret(value: unknown): RemoteConnectionCreateRequest {
  const record = bodyRecord(value)
  return {
    config: record.config as ConnectionConfig,
    secret: record.secret as SecretInput
  }
}

function updateRequest(value: unknown): RemoteConnectionUpdateRequest {
  const record = bodyRecord(value)
  return {
    config: record.config as Partial<ConnectionConfig>,
    secretPatch: record.secretPatch as SecretInput
  }
}

function routeParts(request: IncomingMessage): { pathname: string; id?: string; action?: 'connect' | 'disconnect' } | null {
  const url = new URL(request.url ?? '/', 'http://dbstudio.invalid')
  if (url.search !== '') return null
  if (url.pathname === CONNECTION_ROUTE_PREFIX) return { pathname: url.pathname }
  const match = url.pathname.match(/^\/connections\/([^/]+)(?:\/(connect|disconnect))?$/)
  if (!match) return null
  let id: string
  try {
    const rawId = match[1]
    if (!rawId) return null
    id = decodeURIComponent(rawId)
  } catch {
    return null
  }
  if (!id || id.includes('/') || id.includes('\\')) return null
  return { pathname: url.pathname, id, action: match[2] as 'connect' | 'disconnect' | undefined }
}

function requestIdOf(request: IncomingMessage, maxLength: number): string {
  const header = request.headers['x-dbstudio-request-id']
  if (typeof header === 'string' && header.trim() !== '' && header.trim().length <= maxLength) return header.trim()
  return `connection-${randomUUID()}`
}

function auditPair(
  sinks: readonly (HttpRequestAuditSink | undefined)[],
  event: HttpRequestAuditEvent
): void {
  for (const sink of sinks) {
    try {
      sink?.record(event)
    } catch {
      // 观测出口失败不能改变连接管理响应。
    }
  }
}

function isConnectionRoute(request: IncomingMessage): boolean {
  return (request.url ?? '/').startsWith(`${CONNECTION_ROUTE_PREFIX}/`) || request.url === CONNECTION_ROUTE_PREFIX
}

export function createHttpConnectionRouter(options: HttpConnectionRouterOptions): HttpConnectionRouter {
  const requestLimiter = options.requestLimiter ?? createHttpRequestLimiter(options.maxConcurrentRequests)
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_HTTP_MAX_BODY_BYTES
  const maxRequestIdLength = options.maxRequestIdLength ?? DEFAULT_HTTP_MAX_REQUEST_ID_LENGTH

  return async (request, response): Promise<boolean> => {
    if (!isConnectionRoute(request)) return false
    const startedAt = Date.now()
    const requestId = requestIdOf(request, maxRequestIdLength)
    let counted = false
    let ownerId: string | undefined
    let method = `connection:${request.method ?? 'GET'}`
    let outcome: HttpRequestAuditEvent['outcome'] = 'rejected'
    let errorCode: HttpRequestAuditEvent['errorCode']
    let lease: OwnerLease | undefined

    if (!requestLimiter.tryAcquire()) {
      request.resume()
      writeJson(response, 429, failure('conflict', 'HTTP connection 并发请求已达上限'))
      return true
    }
    counted = true

    try {
      const parts = routeParts(request)
      if (!parts) {
        request.resume()
        throw new BackendError({ code: 'not-found', message: 'connection route 不存在' })
      }
      const principal = requirePrincipal(await options.resolvePrincipal?.(request))
      ownerId = principal.id
      lease = options.governance?.acquireRequest(ownerId, requestId)
      const scope = options.composition.scopeFor(principal)
      const manager = scope.manager
      method = `connection:${request.method ?? 'GET'}:${parts.action ?? (parts.id ?? 'collection')}`

      if (request.method === 'GET' && parts.id === undefined) {
        outcome = 'completed'
        writeJson(response, 200, success(manager.list().map(toRemoteConnectionSummary)))
        return true
      }

      if (request.method === 'POST' && parts.id === undefined && parts.pathname === CONNECTION_ROUTE_PREFIX) {
        if (!isJson(request)) throw new BackendError({ code: 'invalid-argument', message: 'connection route 只接受 JSON' })
        const requestBody = configAndSecret(await readJson(request, maxBodyBytes))
        outcome = 'completed'
        writeJson(response, 201, success(toRemoteConnectionSummary(await manager.add(requestBody.config, requestBody.secret))))
        return true
      }

      if (request.method === 'POST' && parts.pathname === `${CONNECTION_ROUTE_PREFIX}/test`) {
        if (!isJson(request)) throw new BackendError({ code: 'invalid-argument', message: 'connection route 只接受 JSON' })
        const requestBody = configAndSecret(await readJson(request, maxBodyBytes))
        outcome = 'completed'
        writeJson(response, 200, success(await manager.testConnection(requestBody.config, requestBody.secret)))
        return true
      }

      if (parts.id === undefined) throw new BackendError({ code: 'not-found', message: 'connection route 不存在' })
      const id = parts.id
      if (request.method === 'POST' && parts.action === 'connect') {
        outcome = 'completed'
        writeJson(response, 200, success(toRemoteConnectionSummary(await manager.connectConnection(id))))
        return true
      }
      if (request.method === 'POST' && parts.action === 'disconnect') {
        outcome = 'completed'
        writeJson(response, 200, success(toRemoteConnectionSummary(await manager.disconnectConnection(id))))
        return true
      }
      if (request.method === 'PATCH' && parts.action === undefined) {
        if (!isJson(request)) throw new BackendError({ code: 'invalid-argument', message: 'connection route 只接受 JSON' })
        const requestBody = updateRequest(await readJson(request, maxBodyBytes))
        outcome = 'completed'
        writeJson(response, 200, success(toRemoteConnectionSummary(await manager.updateConnection(id, requestBody.config, requestBody.secretPatch))))
        return true
      }
      if (request.method === 'DELETE' && parts.action === undefined) {
        await manager.remove(id)
        outcome = 'completed'
        writeJson(response, 200, success(null))
        return true
      }

      request.resume()
      throw new BackendError({ code: 'not-found', message: 'connection route 不存在' })
    } catch (error) {
      outcome = 'failed'
      const result = routeError(error)
      errorCode = result.body.error.code as HttpRequestAuditEvent['errorCode']
      if (!response.headersSent) writeJson(response, result.status, result.body)
      else if (!response.destroyed) response.destroy()
      return true
    } finally {
      lease?.release()
      if (counted) requestLimiter.release()
      auditPair([options.auditSink, options.metricsSink], {
        requestId,
        ...(ownerId === undefined ? {} : { ownerId }),
        method,
        statusCode: response.statusCode || (outcome === 'completed' ? 200 : 500),
        durationMs: Math.max(0, Date.now() - startedAt),
        outcome,
        ...(errorCode === undefined ? {} : { errorCode })
      })
    }
  }
}

export function remoteConnectionPathForRoute(connectionId: string, action?: 'connect' | 'disconnect'): string {
  return remoteConnectionPath(connectionId, action)
}
