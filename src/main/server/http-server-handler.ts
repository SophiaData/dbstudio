/**
 * Node HTTP RPC handler 的防护边界。
 *
 * 这里只处理 HTTP 入口的资源与连接生命周期：method / content-type、body 与
 * response 大小、并发额度、request id 和断连 AbortSignal。认证由调用方注入，
 * application services 继续只看到 transport-neutral request context。
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BackendErrorPayload } from '../../backend/contract/errors'
import { toBackendErrorPayload } from '../../backend/contract/errors'
import type { BackendPrincipal, BackendRequestContext } from '../../backend/transport/transport'
import type { BackendResponse } from '../../backend/transport/transport'
import { encodeBackendResponse } from '../../backend/transport/wire-codec'
import type { HttpServerComposition } from './http-server-composition'
import { OwnerGovernance, OwnerQuotaError, type OwnerLease } from './owner-governance'

export const DEFAULT_HTTP_MAX_BODY_BYTES = 1 * 1024 * 1024
export const DEFAULT_HTTP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const DEFAULT_HTTP_MAX_CONCURRENT_REQUESTS = 64
export const DEFAULT_HTTP_MAX_REQUEST_ID_LENGTH = 200

export interface HttpServerHandlerOptions {
  readonly composition: Pick<HttpServerComposition, 'dispatch'>
  /** 认证后的 principal；缺省拒绝全部请求，避免误把未认证 handler 暴露出去。 */
  readonly resolvePrincipal?: (
    request: IncomingMessage
  ) => BackendPrincipal | null | undefined | Promise<BackendPrincipal | null | undefined>
  readonly maxBodyBytes?: number
  readonly maxResponseBytes?: number
  readonly maxConcurrentRequests?: number
  readonly maxRequestIdLength?: number
  /** owner 级请求配额与审计；未提供时保持现有全局并发行为。 */
  readonly governance?: OwnerGovernance
}

export type HttpServerHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void>

class HttpGuardError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: BackendErrorPayload['code'],
    message: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'HttpGuardError'
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} 必须是正整数`)
  }
  return resolved
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value
}

function fallbackRequestId(): string {
  return `http-${randomUUID()}`
}

function requestIdFromHeader(request: IncomingMessage, maxLength: number): string | undefined {
  const value = headerValue(request, 'x-dbstudio-request-id')?.trim()
  if (!value) return undefined
  if (value.length > maxLength) {
    throw new HttpGuardError(400, 'invalid-argument', 'request id 超过长度上限')
  }
  return value
}

function requestIdFromBody(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (id.length > maxLength) {
    throw new HttpGuardError(400, 'invalid-argument', '请求 id 超过长度上限')
  }
  return id
}

function errorResponse(
  id: string,
  code: BackendErrorPayload['code'],
  message: string,
  options: { readonly retryable?: boolean } = {}
): string {
  return JSON.stringify({
    id,
    ok: false,
    error: {
      code,
      message,
      retryable: options.retryable ?? false,
      callId: id
    }
  })
}

function statusForResponse(response: BackendResponse): number {
  if (response.ok) return 200
  switch (response.error.code) {
    case 'invalid-argument':
      return 400
    case 'unauthorized':
      return 401
    case 'not-found':
      return 404
    case 'unsupported':
      return 404
    case 'conflict':
      return 409
    case 'cancelled':
      return 499
    case 'timeout':
      return 504
    case 'backend-unavailable':
      return 503
    default:
      return 500
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: string): void {
  if (response.writableEnded || response.destroyed) return
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', Buffer.byteLength(body))
  response.end(body)
}

function writeGuardError(
  response: ServerResponse,
  id: string,
  error: HttpGuardError
): void {
  writeJson(
    response,
    error.statusCode,
    errorResponse(id, error.code, error.message, { retryable: error.retryable })
  )
}

function parseContentLength(request: IncomingMessage): number | undefined {
  const raw = headerValue(request, 'content-length')
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpGuardError(400, 'invalid-argument', 'content-length 不合法')
  }
  return parsed
}

function contentTypeIsJson(request: IncomingMessage): boolean {
  const contentType = headerValue(request, 'content-type')
  if (!contentType) return false
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function drainRequest(request: IncomingMessage): void {
  request.resume()
}

async function readBody(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortController
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let ended = false
    let settled = false

    const cleanup = (): void => {
      request.removeListener('data', onData)
      request.removeListener('end', onEnd)
      request.removeListener('aborted', onAborted)
      request.removeListener('close', onClose)
      request.removeListener('error', onError)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.byteLength
      if (total > maxBytes) {
        signal.abort()
        drainRequest(request)
        fail(new HttpGuardError(413, 'invalid-argument', 'HTTP 请求体超过大小上限'))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => {
      ended = true
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onAborted = (): void => {
      signal.abort()
      fail(new HttpGuardError(499, 'cancelled', 'HTTP 客户端已断开'))
    }
    const onClose = (): void => {
      if (!ended) onAborted()
    }
    const onError = (error: Error): void => fail(error)

    request.on('data', onData)
    request.once('end', onEnd)
    request.once('aborted', onAborted)
    request.once('close', onClose)
    request.once('error', onError)
  })
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    throw new HttpGuardError(400, 'invalid-argument', '请求体不是合法 JSON')
  }
}

function validatePrincipal(value: BackendPrincipal | null | undefined): BackendPrincipal {
  if (!value || typeof value.id !== 'string' || value.id.trim() === '') {
    throw new HttpGuardError(401, 'unauthorized', 'HTTP backend 请求缺少有效 principal')
  }
  return value
}

/** 创建可直接交给 `http.createServer` 的受保护 handler。 */
export function createHttpServerHandler(
  options: HttpServerHandlerOptions
): HttpServerHandler {
  if (!options?.composition || typeof options.composition.dispatch !== 'function') {
    throw new Error('HTTP server handler 缺少 composition.dispatch')
  }

  const maxBodyBytes = positiveLimit(
    options.maxBodyBytes,
    DEFAULT_HTTP_MAX_BODY_BYTES,
    'maxBodyBytes'
  )
  const maxResponseBytes = positiveLimit(
    options.maxResponseBytes,
    DEFAULT_HTTP_MAX_RESPONSE_BYTES,
    'maxResponseBytes'
  )
  const maxConcurrentRequests = positiveLimit(
    options.maxConcurrentRequests,
    DEFAULT_HTTP_MAX_CONCURRENT_REQUESTS,
    'maxConcurrentRequests'
  )
  const maxRequestIdLength = positiveLimit(
    options.maxRequestIdLength,
    DEFAULT_HTTP_MAX_REQUEST_ID_LENGTH,
    'maxRequestIdLength'
  )
  let activeRequests = 0

  return async (request, response): Promise<void> => {
    let headerId = fallbackRequestId()
    try {
      headerId = requestIdFromHeader(request, maxRequestIdLength) ?? headerId
      if (request.method !== 'POST') {
        drainRequest(request)
        throw new HttpGuardError(405, 'unsupported', 'HTTP backend 只接受 POST')
      }
      if (!contentTypeIsJson(request)) {
        drainRequest(request)
        throw new HttpGuardError(415, 'invalid-argument', 'HTTP backend 只接受 application/json')
      }
      const contentLength = parseContentLength(request)
      if (contentLength !== undefined && contentLength > maxBodyBytes) {
        drainRequest(request)
        throw new HttpGuardError(413, 'invalid-argument', 'HTTP 请求体超过大小上限')
      }
      if (activeRequests >= maxConcurrentRequests) {
        drainRequest(request)
        throw new HttpGuardError(429, 'conflict', 'HTTP backend 并发请求已达上限', true)
      }
      activeRequests += 1
      let ownerRequestLease: OwnerLease | undefined

      try {
        let principal: BackendPrincipal
        try {
          principal = validatePrincipal(await options.resolvePrincipal?.(request))
        } catch (error) {
          options.governance?.recordAuthenticationFailure(headerId)
          if (error instanceof HttpGuardError) throw error
          const payload = toBackendErrorPayload(error, { callId: headerId })
          throw new HttpGuardError(
            payload.code === 'unauthorized' ? 401 : 500,
            payload.code,
            payload.message,
            payload.retryable
          )
        }

        try {
          ownerRequestLease = options.governance?.acquireRequest(principal.id, headerId)
        } catch (error) {
          if (error instanceof OwnerQuotaError) {
            throw new HttpGuardError(429, 'conflict', error.message, true)
          }
          throw error
        }

        const controller = new AbortController()
        let requestFinished = false
        const onAborted = (): void => controller.abort()
        const onClose = (): void => {
          if (!requestFinished) controller.abort()
        }
        const onSocketClose = (): void => {
          if (!requestFinished) controller.abort()
        }
        const onResponseClose = (): void => {
          if (!requestFinished) controller.abort()
        }
        request.once('aborted', onAborted)
        request.once('close', onClose)
        request.socket.once('close', onSocketClose)
        response.once('close', onResponseClose)

        try {
          const body = await readBody(request, maxBodyBytes, controller)
          const parsed = parseBody(body)
          const bodyId = requestIdFromBody(parsed, maxRequestIdLength)
          if (headerId !== bodyId && headerValue(request, 'x-dbstudio-request-id')) {
            throw new HttpGuardError(400, 'invalid-argument', 'request id 与请求体 id 不一致')
          }
          const requestId = bodyId ?? headerId
          const context: BackendRequestContext = {
            requestId,
            principal,
            signal: controller.signal,
            receivedAt: Date.now()
          }
          const backendResponse = await options.composition.dispatch(parsed, context)
          const bodyText = JSON.stringify(encodeBackendResponse(backendResponse))
          if (Buffer.byteLength(bodyText) > maxResponseBytes) {
            writeJson(
              response,
              500,
              errorResponse(requestId, 'internal', 'HTTP 响应超过大小上限')
            )
          } else {
            writeJson(response, statusForResponse(backendResponse), bodyText)
          }
        } finally {
          requestFinished = true
          request.removeListener('aborted', onAborted)
          request.removeListener('close', onClose)
          request.socket.removeListener('close', onSocketClose)
          response.removeListener('close', onResponseClose)
        }
      } finally {
        ownerRequestLease?.release()
        activeRequests -= 1
      }
    } catch (error) {
      if (!request.readableEnded) drainRequest(request)
      if (error instanceof HttpGuardError) {
        writeGuardError(response, headerId, error)
        return
      }
      const payload = toBackendErrorPayload(error, { callId: headerId })
      writeJson(response, statusForResponse({ id: headerId, ok: false, error: payload }), errorResponse(
        headerId,
        payload.code,
        payload.message,
        { retryable: payload.retryable }
      ))
    }
  }
}
