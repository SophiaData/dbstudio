import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpRequestLimiter } from './http-server-handler'

const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE'])
const HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-dbstudio-request-id', 'x-dbstudio-artifact-ticket'])

/** CORS 只授予显式 origin，不授予身份；实际请求仍必须通过 JWT/provider 验证。 */
export function createHttpCorsHandler(origins: readonly string[] = []) {
  const allowed = new Set(origins)
  for (const origin of allowed) {
    if (origin === 'null') continue // Electron file://，必须由部署方显式选择。
    let url: URL
    try { url = new URL(origin) } catch { throw new Error('allowedOrigins 必须是完整 origin 或 null') }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
      throw new Error('allowedOrigins 只允许精确 HTTPS origin 或 loopback HTTP origin')
    }
  }
  return (request: IncomingMessage, response: ServerResponse, limiter: HttpRequestLimiter): boolean => {
    const origin = request.headers.origin
    if (origin === undefined) return false
    const reject = (status: number): true => {
      request.resume()
      response.statusCode = status
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: '跨源请求未获允许' } }))
      return true
    }
    response.setHeader('vary', 'Origin')
    if (typeof origin !== 'string' || !allowed.has(origin)) return reject(403)
    response.setHeader('access-control-allow-origin', origin)
    if (request.method !== 'OPTIONS') return false
    if (!limiter.tryAcquire()) return reject(429)
    try {
      const method = request.headers['access-control-request-method']
      const rawHeaders = request.headers['access-control-request-headers']
      const headers = typeof rawHeaders === 'string' ? rawHeaders.split(',').map((name) => name.trim().toLowerCase()) : []
      if (typeof method !== 'string' || !METHODS.has(method) || headers.some((name) => !HEADERS.has(name))) return reject(403)
      request.resume()
      response.statusCode = 204
      response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE')
      response.setHeader('access-control-allow-headers', [...HEADERS].join(', '))
      response.setHeader('cache-control', 'no-store')
      response.end()
      return true
    } finally { limiter.release() }
  }
}
