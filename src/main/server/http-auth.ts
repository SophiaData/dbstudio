import type { IncomingMessage } from 'node:http'
import type { BackendPrincipal } from '../../backend/transport/transport'
import { BackendError } from '../../backend/contract/errors'

export interface HttpAuthProvider {
  resolvePrincipal(request: IncomingMessage): BackendPrincipal | null | Promise<BackendPrincipal | null>
}

export type BearerTokenVerifier = (
  token: string,
  request: IncomingMessage
) => BackendPrincipal | null | Promise<BackendPrincipal | null>

function unauthorized(): BackendError {
  return new BackendError({ code: 'unauthorized', message: '认证失败' })
}

export function createBearerTokenPrincipalResolver(
  verify: BearerTokenVerifier
): (request: IncomingMessage) => Promise<BackendPrincipal> {
  if (typeof verify !== 'function') throw new TypeError('Bearer token verifier 必须是函数')
  return async (request) => {
    const header = request.headers.authorization
    if (typeof header !== 'string') throw unauthorized()
    const match = /^Bearer ([^\s]+)$/.exec(header.trim())
    if (!match?.[1]) throw unauthorized()
    const principal = await verify(match[1], request)
    if (!principal || typeof principal.id !== 'string' || principal.id.trim() === '') throw unauthorized()
    return {
      id: principal.id.trim(),
      ...(principal.roles === undefined ? {} : { roles: [...principal.roles] })
    }
  }
}

export function createHttpAuthResolver(provider: HttpAuthProvider): (request: IncomingMessage) => Promise<BackendPrincipal> {
  if (!provider || typeof provider.resolvePrincipal !== 'function') {
    throw new TypeError('HTTP auth provider 缺少 resolvePrincipal')
  }
  return async (request) => {
    const principal = await provider.resolvePrincipal(request)
    if (!principal || typeof principal.id !== 'string' || principal.id.trim() === '') throw unauthorized()
    return { ...principal, id: principal.id.trim() }
  }
}
