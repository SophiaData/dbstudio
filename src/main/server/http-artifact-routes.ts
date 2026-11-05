/**
 * owner-bound artifact HTTP routes。
 *
 * RPC handler 只处理 backend method；文件内容走独立 route，避免把二进制数据
 * 塞进 JSON wire codec。所有 route 都先通过同一个 principal resolver，再从
 * composition 取得 owner scope。
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { URL } from 'node:url'
import {
  ARTIFACT_TICKET_HEADER,
  isArtifactId,
  type ArtifactId,
  type CreateArtifactUploadRequest
} from '../../backend/contract/artifact'
import { BackendError, toBackendErrorPayload } from '../../backend/contract/errors'
import type { BackendPrincipal } from '../../backend/transport/transport'
import type { HttpServerComposition } from './http-server-composition'
import {
  createHttpRequestLimiter,
  type HttpRequestAuditEvent,
  type HttpRequestAuditSink,
  type HttpRequestLimiter
} from './http-server-handler'
import { OwnerGovernance, OwnerQuotaError, type OwnerLease } from './owner-governance'
import { ArtifactStoreError, type LocalArtifactStore } from './artifact-store'

export const ARTIFACT_ROUTE_PREFIX = '/artifacts/'
export const DEFAULT_ARTIFACT_METADATA_BODY_BYTES = 16 * 1024

export interface HttpArtifactRouterOptions {
  readonly composition: Pick<HttpServerComposition, 'scopeFor'>
  readonly resolvePrincipal?: (
    request: IncomingMessage
  ) => BackendPrincipal | null | undefined | Promise<BackendPrincipal | null | undefined>
  readonly maxMetadataBodyBytes?: number
  readonly maxConcurrentRequests?: number
  readonly requestLimiter?: HttpRequestLimiter
  readonly governance?: OwnerGovernance
  readonly auditSink?: HttpRequestAuditSink
  readonly metricsSink?: HttpRequestAuditSink
}

export type HttpArtifactRouter = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<boolean>

function isArtifactRoute(request: IncomingMessage): boolean {
  return (request.url ?? '/').startsWith(ARTIFACT_ROUTE_PREFIX)
}

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
    case 'unauthorized':
      return 401
    case 'not-found':
      return 404
    case 'conflict':
      return 409
    case 'timeout':
      return 410
    case 'invalid-argument':
      return 400
    default:
      return 500
  }
}

function routeError(error: unknown): { status: number; body: ReturnType<typeof failure> } {
  if (error instanceof ArtifactStoreError) {
    return {
      status: error.statusCode,
      body: failure(error.code, error.message)
    }
  }
  if (error instanceof BackendError) {
    return {
      status: statusForCode(error.code),
      body: failure(error.code, error.message)
    }
  }
  const payload = toBackendErrorPayload(error)
  if (payload.code !== 'internal') {
    return { status: statusForCode(payload.code), body: failure(payload.code, payload.message) }
  }
  return {
    status: 500,
    body: failure('internal', 'artifact 服务暂时不可用')
  }
}

function requirePrincipal(value: BackendPrincipal | null | undefined): BackendPrincipal {
  if (!value || typeof value.id !== 'string' || value.id.trim() === '') {
    throw new ArtifactStoreError(
      { code: 'unauthorized', message: 'HTTP artifact 请求缺少有效 principal' },
      401
    )
  }
  return value
}

function parseUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://localhost')
}

function routeParts(url: URL): string[] {
  return url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
}

function requireArtifactId(value: string | undefined): ArtifactId {
  if (!isArtifactId(value)) {
    throw new ArtifactStoreError({ code: 'invalid-argument', message: 'artifact id 不合法' }, 400)
  }
  return value
}

function contentTypeIsJson(request: IncomingMessage): boolean {
  const value = request.headers['content-type']
  return typeof value === 'string' && value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error('maxMetadataBodyBytes 必须是正整数')
  }
  return resolved
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const length = request.headers['content-length']
  if (length !== undefined) {
    const parsed = Number(length)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new ArtifactStoreError({ code: 'invalid-argument', message: 'content-length 不合法' }, 400)
    }
    if (parsed > maxBytes) {
      request.resume()
      throw new ArtifactStoreError({ code: 'invalid-argument', message: 'artifact JSON 请求体过大' }, 413)
    }
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.byteLength
    if (total > maxBytes) {
      throw new ArtifactStoreError({ code: 'invalid-argument', message: 'artifact JSON 请求体过大' }, 413)
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ArtifactStoreError({ code: 'invalid-argument', message: 'artifact 请求体不是合法 JSON' }, 400)
  }
}

function asUploadRequest(value: unknown): CreateArtifactUploadRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArtifactStoreError({ code: 'invalid-argument', message: 'artifact upload 参数必须是对象' }, 400)
  }
  return value as CreateArtifactUploadRequest
}

function ticketFromHeader(request: IncomingMessage): string {
  const value = request.headers[ARTIFACT_TICKET_HEADER]
  const header = Array.isArray(value) ? value[0] : value
  const match = typeof header === 'string' ? /^Bearer\s+([^\s]+)$/i.exec(header.trim()) : null
  const ticket = match?.[1]
  if (!ticket || ticket.length > 512) {
    throw new ArtifactStoreError({ code: 'unauthorized', message: 'artifact ticket header 缺失或不合法' }, 401)
  }
  return ticket
}

function setDownloadHeaders(response: ServerResponse, artifact: Awaited<ReturnType<LocalArtifactStore['inspectArtifact']>>): void {
  response.setHeader('cache-control', 'no-store')
  if (artifact.mediaType) response.setHeader('content-type', artifact.mediaType)
  else response.setHeader('content-type', 'application/octet-stream')
  if (artifact.sizeBytes !== null) response.setHeader('content-length', artifact.sizeBytes)
  if (artifact.sha256) response.setHeader('etag', `"${artifact.sha256}"`)
  if (artifact.filename) {
    response.setHeader(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`
    )
  }
}

/** 判断请求是否属于 artifact route。 */
export { isArtifactRoute }

/** 创建 artifact route handler；返回 false 表示请求应交给 RPC handler。 */
export function createHttpArtifactRouter(options: HttpArtifactRouterOptions): HttpArtifactRouter {
  const maxMetadataBodyBytes = positiveLimit(
    options.maxMetadataBodyBytes,
    DEFAULT_ARTIFACT_METADATA_BODY_BYTES
  )

  const requestLimiter = options.requestLimiter ?? createHttpRequestLimiter(options.maxConcurrentRequests)

  return async (request, response): Promise<boolean> => {
    if (!isArtifactRoute(request)) return false
    const startedAt = Date.now()
    const requestIdHeader = request.headers['x-dbstudio-request-id']
    const requestId = typeof requestIdHeader === 'string' && requestIdHeader.trim() !== ''
      ? requestIdHeader.trim()
      : `artifact-${randomUUID()}`
    let ownerId: string | undefined
    let method: string | undefined = request.method ?? 'GET'
    let outcome: HttpRequestAuditEvent['outcome'] = 'rejected'
    let errorCode: HttpRequestAuditEvent['errorCode']
    let counted = false
    let ownerRequestLease: OwnerLease | undefined
    try {
      let principal: BackendPrincipal
      try {
        principal = requirePrincipal(await options.resolvePrincipal?.(request))
        ownerId = principal.id
      } catch (error) {
        options.governance?.recordAuthenticationFailure(requestId)
        throw error
      }
      if (!requestLimiter.tryAcquire()) {
        throw new ArtifactStoreError(
          { code: 'conflict', message: 'HTTP artifact 并发请求已达上限', retryable: true },
          429
        )
      }
      counted = true
      try {
        ownerRequestLease = options.governance?.acquireRequest(principal.id, requestId)
      } catch (error) {
        if (error instanceof OwnerQuotaError) {
          throw new ArtifactStoreError({ code: 'conflict', message: error.message, retryable: true }, 429)
        }
        throw error
      }
      const scope = options.composition.scopeFor(principal)
      const store = scope.artifactStore
      const url = parseUrl(request)
      const parts = routeParts(url)
      method = `artifact:${request.method ?? 'GET'}:${parts[1] ?? 'unknown'}`
      outcome = 'completed'

      if (request.method === 'POST' && parts.length === 2 && parts[1] === 'upload-tickets') {
        if (!contentTypeIsJson(request)) {
          throw new ArtifactStoreError({ code: 'invalid-argument', message: 'artifact ticket 只接受 JSON' }, 415)
        }
        const ticket = await store.createUploadTicket(asUploadRequest(await readJson(request, maxMetadataBodyBytes)))
        writeJson(response, 201, success(ticket))
        return true
      }

      if (request.method === 'PUT' && parts.length === 3 && parts[1] === 'uploads') {
        const artifactId = requireArtifactId(parts[2])
        const metadata = await store.upload(artifactId, ticketFromHeader(request), request)
        writeJson(response, 200, success(metadata))
        return true
      }

      if (request.method === 'POST' && parts.length === 3 && parts[1] === 'download-tickets') {
        const artifactId = requireArtifactId(parts[2])
        const ticket = await store.createDownloadTicket(artifactId)
        writeJson(response, 201, success(ticket))
        return true
      }

      if (request.method === 'GET' && parts.length === 3 && parts[1] === 'downloads') {
        const artifactId = requireArtifactId(parts[2])
        const opened = await store.openDownload(artifactId, ticketFromHeader(request))
        setDownloadHeaders(response, opened.artifact)
        await pipeline(opened.stream, response)
        return true
      }

      if (parts.length === 2 && isArtifactId(parts[1])) {
        const artifactId = parts[1]
        if (request.method === 'GET') {
          writeJson(response, 200, success(await store.inspectArtifact(artifactId)))
          return true
        }
        if (request.method === 'DELETE') {
          await store.deleteArtifact(artifactId)
          writeJson(response, 200, success(null))
          return true
        }
      }

      request.resume()
      outcome = 'failed'
      errorCode = 'not-found'
      writeJson(response, 404, failure('not-found', 'artifact route 不存在'))
      return true
    } catch (error) {
      if (!request.readableEnded && request.method !== 'GET' && request.method !== 'DELETE') request.resume()
      outcome = 'failed'
      if (!response.headersSent) {
        const result = routeError(error)
        errorCode = result.body.error.code as HttpRequestAuditEvent['errorCode']
        writeJson(response, result.status, result.body)
      } else if (!response.destroyed) {
        response.destroy()
      }
      return true
    } finally {
      ownerRequestLease?.release()
      if (counted) requestLimiter.release()
      const event: HttpRequestAuditEvent = {
        requestId,
        ...(ownerId === undefined ? {} : { ownerId }),
        ...(method === undefined ? {} : { method }),
        statusCode: response.statusCode || (outcome === 'completed' ? 200 : 500),
        durationMs: Math.max(0, Date.now() - startedAt),
        outcome,
        ...(errorCode === undefined ? {} : { errorCode })
      }
      for (const sink of [options.auditSink, options.metricsSink]) {
        try {
          sink?.record(event)
        } catch {
          // artifact 可观测性失败不能改变响应或资源回收。
        }
      }
    }
  }
}
