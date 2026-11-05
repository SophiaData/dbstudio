/** jose 负责 JWT/JWS 与 JWKS；应用只固定部署约束并投影身份。 */
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import { createBearerTokenPrincipalResolver } from './http-auth'

export interface HttpJwtAuthConfig {
  readonly issuer: string
  readonly audience: string
  readonly jwksUrl?: string
  readonly jwksFile?: string
}

const JWT_ALGORITHMS = ['RS256', 'ES256']

export function validateHttpJwtAuthConfig(config: HttpJwtAuthConfig): void {
  if (!config.issuer?.trim() || !config.audience?.trim()) {
    throw new Error('JWT 必须配置 DBSTUDIO_HTTP_JWT_ISSUER 和 DBSTUDIO_HTTP_JWT_AUDIENCE')
  }
  if (Boolean(config.jwksUrl) === Boolean(config.jwksFile)) {
    throw new Error('JWT 必须且只能配置 JWT_JWKS_URL 或 JWT_JWKS_FILE')
  }
  if (config.jwksUrl) {
    let url: URL
    try { url = new URL(config.jwksUrl) } catch { throw new Error('JWT_JWKS_URL 必须是 HTTPS URL') }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
      throw new Error('JWT_JWKS_URL 必须是无凭据、查询参数和 fragment 的 HTTPS URL')
    }
  }
}

function readPublicJwks(path: string): JSONWebKeySet {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error()
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'))
    if (!value || typeof value !== 'object' || !('keys' in value) || !Array.isArray(value.keys) || value.keys.length === 0) {
      throw new Error()
    }
    for (const key of value.keys) {
      if (!key || typeof key !== 'object' || Array.isArray(key)) throw new Error()
      // 此文件是公开验证材料，绝不接受私钥或对称 key。
      if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some((name) => name in key)) throw new Error()
      if (key.alg !== undefined && !JWT_ALGORITHMS.includes(key.alg)) throw new Error()
      if (key.use !== undefined && key.use !== 'sig') throw new Error()
      if (key.kty === 'RSA') {
        if (typeof key.n !== 'string' || !key.n || typeof key.e !== 'string' || !key.e) throw new Error()
        if (key.alg !== undefined && key.alg !== 'RS256') throw new Error()
      } else if (key.kty === 'EC') {
        if (key.crv !== 'P-256' || typeof key.x !== 'string' || !key.x || typeof key.y !== 'string' || !key.y) throw new Error()
        if (key.alg !== undefined && key.alg !== 'ES256') throw new Error()
      } else throw new Error()
    }
    return value as JSONWebKeySet
  } catch {
    throw new Error('JWT_JWKS_FILE 必须是可读取且只含 RS256/ES256 公钥的普通 JWKS 文件（最多 1 MiB）')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function createJwtPrincipalResolver(config: HttpJwtAuthConfig) {
  validateHttpJwtAuthConfig(config)
  const keySet = config.jwksUrl
    ? createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5_000 })
    : createLocalJWKSet(readPublicJwks(config.jwksFile!))
  return createBearerTokenPrincipalResolver(async (token) => {
    const { payload } = await jwtVerify(token, keySet, {
      algorithms: JWT_ALGORITHMS,
      issuer: config.issuer,
      audience: config.audience,
      requiredClaims: ['iss', 'aud', 'exp', 'sub']
    })
    // jose 检查 exp/nbf/issuer/audience 与签名；边界再检查 sub/roles 的运行时类型。
    return { id: payload.sub!, ...(payload.roles === undefined ? {} : { roles: payload.roles as string[] }) }
  })
}
