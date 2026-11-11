import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, ftruncateSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import https from 'node:https'

export class VerifyError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status }
}
export function requireCheck(condition, code, status = 0) {
  if (!condition) throw new VerifyError(code, status)
}
export function privateRead(path, json = false) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    requireCheck(info.isFile() && (info.mode & 0o777) === 0o600 &&
      (typeof process.getuid !== 'function' || info.uid === process.getuid()) && info.size <= 1024 * 1024, 'PRIVATE_FILE_UNSAFE')
    const text = readFileSync(fd, 'utf8')
    return json ? JSON.parse(text) : text.trim()
  } catch (error) {
    throw error instanceof VerifyError ? error : new VerifyError('PRIVATE_FILE_UNREADABLE')
  } finally { if (fd !== undefined) closeSync(fd) }
}
export function safeWrite(path, value, { privateFile = false, exclusive = false } = {}) {
  let fd
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW |
      constants.O_NONBLOCK | (exclusive ? constants.O_EXCL : 0), 0o600)
    const info = fstatSync(fd)
    requireCheck(info.isFile() && info.nlink === 1 &&
      (typeof process.getuid !== 'function' || info.uid === process.getuid()) &&
      (!privateFile || (info.mode & 0o777) === 0o600), 'OUTPUT_FILE_UNSAFE')
    ftruncateSync(fd, 0)
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
  } catch (error) {
    throw error instanceof VerifyError ? error : new VerifyError(exclusive ? 'STATE_ALREADY_EXISTS_OR_UNWRITABLE' : 'OUTPUT_UNWRITABLE')
  } finally { if (fd !== undefined) closeSync(fd) }
}
export function httpsUrl(value, endpoint = false) {
  let url
  try { url = new URL(value) } catch { throw new VerifyError('HTTPS_REQUIRED') }
  requireCheck(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'HTTPS_REQUIRED')
  if (endpoint) {
    requireCheck(url.pathname === '/' || url.pathname === '/rpc', 'ENDPOINT_PATH_INVALID')
    url.pathname = '/'
  }
  return url
}
export async function httpsRequest({ url, method = 'GET', token, body, headers = {}, ca, timeoutMs = 15000 }) {
  httpsUrl(url)
  requireCheck(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS_BYPASS_FORBIDDEN')
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  return new Promise((resolveRequest, reject) => {
    let timer
    const fail = (code) => reject(new VerifyError(code))
    const request = https.request(url, {
      method, ca, rejectUnauthorized: true,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'content-length': payload.length }),
        ...headers, ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    }, (response) => {
      const chunks = []
      let length = 0
      response.on('data', (chunk) => {
        length += chunk.length
        if (length > 2 * 1024 * 1024) { response.destroy(); request.destroy(); fail('RESPONSE_LIMIT') }
        else chunks.push(chunk)
      })
      response.once('error', () => fail('RESPONSE_FAILED'))
      response.once('end', () => {
        const bytes = Buffer.concat(chunks)
        let json
        try { json = JSON.parse(bytes.toString('utf8')) } catch { /* binary downloads remain bytes */ }
        resolveRequest({ status: response.statusCode ?? 0, json, bytes })
      })
    })
    timer = setTimeout(() => { request.destroy(); fail('REQUEST_TIMEOUT') }, timeoutMs)
    request.once('close', () => clearTimeout(timer))
    request.once('error', (error) => fail(/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME/.test(String(error.code)) ? 'TLS_VERIFICATION_FAILED' : 'NETWORK_FAILED'))
    request.end(payload)
  })
}
export function loadConfig({ configFile, env = process.env } = {}) {
  const path = configFile ?? env.DBSTUDIO_STAGING_CONFIG_FILE
  const config = path ? privateRead(path, true) : {
    version: 1, endpoint: env.DBSTUDIO_STAGING_ENDPOINT,
    caFile: env.DBSTUDIO_STAGING_CA_FILE,
    stateFile: env.DBSTUDIO_STAGING_STATE_FILE,
    owners: { a: { tokenEnv: 'DBSTUDIO_STAGING_OWNER_A_TOKEN' }, b: { tokenEnv: 'DBSTUDIO_STAGING_OWNER_B_TOKEN' } }
  }
  requireCheck(config && config.version === 1 && typeof config === 'object', 'CONFIG_VERSION_INVALID')
  const base = path ? dirname(resolve(path)) : process.cwd()
  const filePath = (value) => { requireCheck(typeof value === 'string' && value.length > 0, 'FILE_PATH_REQUIRED'); return resolve(base, value) }
  const inputFiles = new Set(path ? [resolve(path)] : [])
  const input = (value) => { const p = filePath(value); inputFiles.add(p); return p }
  const caRead = (value) => {
    if (!value) return undefined
    try { return readFileSync(input(value)) } catch { throw new VerifyError('CA_FILE_UNREADABLE') }
  }
  const endpoint = httpsUrl(config.endpoint, true).href
  requireCheck(env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS_BYPASS_FORBIDDEN')
  const ca = caRead(config.caFile)
  const owners = {}
  for (const name of ['a', 'b']) {
    const owner = config.owners?.[name]
    requireCheck(owner && typeof owner === 'object', 'OWNER_CONFIG_REQUIRED')
    const sources = ['accessToken', 'tokenFile', 'tokenEnv', 'realIdP'].filter((key) => owner[key] !== undefined)
    requireCheck(sources.length === 1, 'OWNER_TOKEN_SOURCE_INVALID')
    if (owner.realIdP) {
      const provider = owner.realIdP
      requireCheck(typeof provider.clientId === 'string' && provider.clientId.length > 0, 'IDP_CONFIG_INVALID')
      owners[name] = { realIdP: {
        tokenEndpoint: httpsUrl(provider.tokenEndpoint).href, clientId: provider.clientId,
        username: privateRead(input(provider.usernameFile)), password: privateRead(input(provider.passwordFile)),
        ...(provider.clientSecretFile ? { clientSecret: privateRead(input(provider.clientSecretFile)) } : {}),
        ca: provider.caFile ? caRead(provider.caFile) : ca
      } }
    } else {
      const token = owner.tokenFile ? privateRead(input(owner.tokenFile)) : owner.tokenEnv ? env[owner.tokenEnv] : owner.accessToken
      requireCheck(typeof token === 'string' && token.length > 0 && !/\s/.test(token), 'OWNER_TOKEN_REQUIRED')
      owners[name] = { accessToken: token }
    }
  }
  const databases = {}
  for (const name of ['postgres', 'mysql', 'redis', 'kafka']) {
    const item = config.databases?.[name]
    if (!item) { databases[name] = { required: true }; continue }
    const secret = { ...item.secret }
    if (item.secretFile) secret.dbPassword = privateRead(input(item.secretFile))
    for (const [key, value] of Object.entries(item.secretFiles ?? {})) secret[key] = privateRead(input(value))
    databases[name] = { ...item, required: item.required !== false, secret }
    if (item.negativeConfig) {
      const negative = item.negativeConfig
      databases[name].negativeConfig = { ...negative, secret: { ...negative.secret,
        ...(negative.secretFile ? { dbPassword: privateRead(input(negative.secretFile)) } : {}) } }
    }
  }
  return {
    ...config, endpoint, ca, owners, databases, inputFiles,
    stateFile: config.stateFile ? filePath(config.stateFile) : path ? `${resolve(path)}.state.json` : undefined,
    transitionReceiptFile: config.transitionReceiptFile ? input(config.transitionReceiptFile) : undefined,
    driverFault: { ...config.driverFault, receiptFile: config.driverFault?.receiptFile ? input(config.driverFault.receiptFile) : undefined },
    artifacts: { required: config.artifacts?.required !== false },
    restart: { required: config.restart?.required !== false }, rollback: { required: config.rollback?.required !== false },
    filePath
  }
}
export async function acquireTokens(config, transport = httpsRequest) {
  const tokens = {}
  const subs = {}
  for (const owner of ['a', 'b']) {
    const item = config.owners[owner]
    if (item.realIdP) {
      const p = item.realIdP
      const form = new URLSearchParams({ grant_type: 'password', client_id: p.clientId, username: p.username, password: p.password,
        ...(p.clientSecret ? { client_secret: p.clientSecret } : {}) })
      const result = await transport({ url: p.tokenEndpoint, method: 'POST', ca: p.ca,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from(form.toString()) })
      requireCheck(result.status === 200 && typeof result.json?.access_token === 'string', 'IDP_TOKEN_FAILED', result.status)
      tokens[owner] = result.json.access_token
    } else tokens[owner] = item.accessToken
    try {
      const parts = tokens[owner].split('.')
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      requireCheck(parts.length === 3 && typeof claims.sub === 'string' && claims.sub.length > 0 &&
        Number.isFinite(claims.exp) && claims.exp > Date.now() / 1000, 'TOKEN_CLAIMS_INVALID')
      // Claims are used only to bind the private state. Actual acceptance is checked at the HTTPS service.
      subs[owner] = claims.sub
    } catch { throw new VerifyError('TOKEN_CLAIMS_INVALID') }
  }
  requireCheck(subs.a !== subs.b && tokens.a !== tokens.b, 'OWNER_SUBS_NOT_DISTINCT')
  return { tokens, subs }
}
