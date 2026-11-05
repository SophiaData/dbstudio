import type { IncomingMessage } from 'node:http'
import type { BackendPrincipal } from '../../backend/transport/transport'
import { BackendError } from '../../backend/contract/errors'

export interface HttpAuthProvider {
  resolvePrincipal(request: IncomingMessage): BackendPrincipal | null | undefined | Promise<BackendPrincipal | null | undefined>
}

export type BearerTokenVerifier = (
  token: string,
  request: IncomingMessage
) => BackendPrincipal | null | Promise<BackendPrincipal | null>

function unauthorized(): BackendError {
  return new BackendError({ code: 'unauthorized', message: '认证失败' })
}

/** 认证边界只允许这两个字段离开 provider；读取 getter 失败也由外层统一脱敏。 */
function projectPrincipal(value: unknown): BackendPrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unauthorized()
  const { id, roles } = value as { id?: unknown; roles?: unknown }
  if (typeof id !== 'string' || id.trim() === '') throw unauthorized()
  if (roles === undefined) return { id: id.trim() }
  if (!Array.isArray(roles)) throw unauthorized()
  const projectedRoles: string[] = []
  for (const role of roles) {
    if (typeof role !== 'string' || role.trim() === '') throw unauthorized()
    projectedRoles.push(role.trim())
  }
  return { id: id.trim(), roles: projectedRoles }
}

export function createHttpAuthResolver(provider: HttpAuthProvider): (request: IncomingMessage) => Promise<BackendPrincipal> {
  if (!provider || typeof provider.resolvePrincipal !== 'function') {
    throw new TypeError('HTTP auth provider 缺少 resolvePrincipal')
  }
  return async (request) => {
    try {
      return projectPrincipal(await provider.resolvePrincipal(request))
    } catch {
      // 不保留 message、details、cause 或原异常，包含 verifier/JWKS/provider 故障。
      throw unauthorized()
    }
  }
}

export function createBearerTokenPrincipalResolver(
  verify: BearerTokenVerifier
): (request: IncomingMessage) => Promise<BackendPrincipal> {
  if (typeof verify !== 'function') throw new TypeError('Bearer token verifier 必须是函数')
  return createHttpAuthResolver({
    async resolvePrincipal(request) {
      const header = request.headers.authorization
      if (typeof header !== 'string') throw unauthorized()
      const match = /^Bearer ([^\s]+)$/i.exec(header.trim())
      if (!match?.[1]) throw unauthorized()
      return verify(match[1], request)
    }
  })
}
