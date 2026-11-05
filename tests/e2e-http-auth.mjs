import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let jwtBundleCode
async function load(relative) {
  const result = await build({
    configFile: false, root, logLevel: 'warn', ssr: { noExternal: ['jose'] },
    build: { write: false, target: 'node22', ssr: true,
      lib: { entry: resolve(root, relative), formats: ['es'] } }
  })
  const output = Array.isArray(result) ? result[0].output : result.output
  const code = output.find((item) => item.type === 'chunk')?.code
  assert.equal(typeof code, 'string')
  if (relative.endsWith('http-jwt-auth.ts')) jwtBundleCode = code
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}
const { createBearerTokenPrincipalResolver, createHttpAuthResolver } = await load('src/main/server/http-auth.ts')
const { createJwtPrincipalResolver } = await load('src/main/server/http-jwt-auth.ts')
const request = (authorization) => ({ headers: authorization === undefined ? {} : { authorization } })
const isUnauthorized = (error) => error?.code === 'unauthorized' && error.message === '认证失败' && error.cause === undefined && error.details === undefined
const rejected = (resolver, authorization = 'Bearer synthetic') => assert.rejects(() => resolver(request(authorization)), isUnauthorized)

const seen = []
const resolver = createBearerTokenPrincipalResolver(async (token) => {
  seen.push(token)
  return token === 'synthetic-valid' ? { id: ' owner-a ', roles: ['analyst'], extra: 'must-not-project' } : null
})
assert.deepEqual(await resolver(request('bEaReR synthetic-valid')), { id: 'owner-a', roles: ['analyst'] })
assert.equal(seen.length, 1)
for (const authorization of [undefined, '', 'Basic synthetic', 'Bearer ', 'Bearer first second', ['Bearer synthetic']]) {
  await assert.rejects(() => resolver(request(authorization)), isUnauthorized)
}
await rejected(resolver, 'Bearer synthetic-invalid')
for (const principal of [null, undefined, [], {}, { id: ' ' }, { id: 2 }, { id: 'a', roles: 'admin' }, { id: 'a', roles: [2] }, { id: 'a', roles: [''] }, { id: 'a', roles: [null] }, { id: 'a', roles: new Set(['admin']) }]) {
  await rejected(createHttpAuthResolver({ resolvePrincipal: () => principal }))
}
for (const thrown of [new Error('synthetic-sensitive-message'), { message: 'synthetic-sensitive-message', code: 'unauthorized', details: 'synthetic-sensitive-detail' }, 'synthetic-sensitive-message']) {
  await rejected(createBearerTokenPrincipalResolver(() => { throw thrown }))
  await rejected(createHttpAuthResolver({ resolvePrincipal: async () => { throw thrown } }))
}
await rejected(createHttpAuthResolver({ resolvePrincipal: () => ({ get id() { throw new Error('synthetic-getter') } }) }))
const roles = ['reader']
const projected = await createHttpAuthResolver({ resolvePrincipal: () => ({ id: 'a', roles, token: 'synthetic' }) })(request())
roles.push('admin')
assert.deepEqual(projected, { id: 'a', roles: ['reader'] })

// 公钥落盘；所有签名私钥与 token 只在内存生成，不打印。
const temp = mkdtempSync(resolve(tmpdir(), 'dbstudio-auth-test-'))
try {
  const jwksFile = resolve(temp, 'public.jwks.json')
  const config = { issuer: 'https://issuer.example.test', audience: 'dbstudio-test', jwksFile }
  const keys = []
  for (const algorithm of ['RS256', 'ES256']) {
    const pair = await generateKeyPair(algorithm, { extractable: true })
    const publicKey = { ...await exportJWK(pair.publicKey), kid: algorithm, alg: algorithm, use: 'sig' }
    keys.push({ algorithm, pair, publicKey })
  }
  writeFileSync(jwksFile, JSON.stringify({ keys: keys.map((key) => key.publicKey) }))
  const jwtResolver = createJwtPrincipalResolver(config)
  for (const { algorithm, pair } of keys) {
    const claims = { iss: config.issuer, aud: config.audience, sub: 'jwt-owner', exp: Math.floor(Date.now() / 1000) + 120, roles: ['reader'], token: 'must-not-project' }
    const sign = (payload = claims, header = {}) => new SignJWT(payload).setProtectedHeader({ alg: algorithm, kid: algorithm, ...header }).sign(pair.privateKey)
    const valid = await sign()
    assert.deepEqual(await jwtResolver(request(`Bearer ${valid}`)), { id: 'jwt-owner', roles: ['reader'] })
    for (const claim of ['iss', 'aud', 'exp', 'sub']) {
      const missing = { ...claims }
      delete missing[claim]
      await rejected(jwtResolver, `Bearer ${await sign(missing)}`)
    }
    for (const invalid of [
      { iss: 'https://wrong.example.test' }, { aud: 'wrong-audience' }, { sub: ' ' }, { sub: 123 },
      { exp: Math.floor(Date.now() / 1000) - 1 }, { exp: 'later' }, { nbf: Math.floor(Date.now() / 1000) + 120 },
      { roles: 'admin' }, { roles: [null] }, { roles: [''] }
    ]) await rejected(jwtResolver, `Bearer ${await sign({ ...claims, ...invalid })}`)
    await rejected(jwtResolver, `Bearer ${await sign(claims, { kid: 'unknown' })}`)
    const wrong = await generateKeyPair(algorithm)
    const wrongSignature = await new SignJWT(claims).setProtectedHeader({ alg: algorithm, kid: algorithm }).sign(wrong.privateKey)
    await rejected(jwtResolver, `Bearer ${wrongSignature}`)
    const parts = valid.split('.')
    parts[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'attacker' })).toString('base64url')
    await rejected(jwtResolver, `Bearer ${parts.join('.')}`)
  }
  const hs = await new SignJWT({ iss: config.issuer, aud: config.audience, sub: 'a', exp: Math.floor(Date.now() / 1000) + 120 })
    .setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32))
  await rejected(jwtResolver, `Bearer ${hs}`)
  await rejected(jwtResolver, 'Bearer e30.e30.')
  for (const bad of [
    { ...config, issuer: '' }, { ...config, audience: '' }, { ...config, jwksFile: undefined },
    { ...config, jwksUrl: 'https://jwks.example.test/keys' },
    { issuer: config.issuer, audience: config.audience, jwksUrl: 'http://jwks.example.test/keys' },
    { issuer: config.issuer, audience: config.audience, jwksUrl: 'https://user:pass@jwks.example.test/keys' }
  ]) assert.throws(() => createJwtPrincipalResolver(bad))
  writeFileSync(jwksFile, JSON.stringify({ keys: [{ ...keys[0].publicKey, d: 'synthetic-forbidden-private-field' }] }))
  assert.throws(() => createJwtPrincipalResolver(config), /只含 RS256\/ES256 公钥/)
  writeFileSync(jwksFile, '{invalid-public-jwks')
  assert.throws(() => createJwtPrincipalResolver(config), /只含 RS256\/ES256 公钥/)
  if (process.platform !== 'win32') {
    const fifo = resolve(temp, 'synthetic-public-jwks.fifo')
    assert.equal(spawnSync('mkfifo', [fifo], { timeout: 5_000 }).status, 0)
    const modulePath = resolve(temp, 'jwt-under-test.mjs')
    writeFileSync(modulePath, jwtBundleCode)
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createJwtPrincipalResolver } from ${JSON.stringify(pathToFileURL(modulePath).href)}
      try {
        createJwtPrincipalResolver({ issuer: 'synthetic', audience: 'synthetic', jwksFile: ${JSON.stringify(fifo)} })
        process.exitCode = 2
      } catch (error) {
        process.exitCode = error.message.includes('普通 JWKS 文件') && error.cause === undefined ? 0 : 3
      }
    `], { timeout: 5_000, killSignal: 'SIGKILL', stdio: 'pipe' })
    assert.equal(probe.signal, null, 'FIFO必须立即拒绝，不能等待writer')
    assert.equal(probe.status, 0)
  }
} finally {
  // 用户要求禁止删除；把本次生成的公开测试材料移入临时回收目录。
  const recycle = resolve(tmpdir(), 'dbstudio-test-recycle')
  mkdirSync(recycle, { recursive: true })
  assert.equal(dirname(temp), resolve(tmpdir()))
  renameSync(temp, resolve(recycle, basename(temp)))
}
// 裸 createHttpServer DI 也必须保护 RPC / connection / artifact 三类真实请求。
const { createHttpServer } = await load('src/main/server/http-server.ts')
let receivedPrincipal
const composition = {
  dispatch: async (call, context) => {
    receivedPrincipal = context.principal
    return { id: call.id, ok: true, value: [] }
  },
  scopeFor: () => { throw new Error('认证失败时不得创建owner scope') },
  dispose: async () => {}
}
for (const resolvePrincipal of [
  () => { throw new Error('synthetic-sensitive-provider-message', { cause: 'synthetic-sensitive-cause' }) },
  async () => { throw { code: 'unauthorized', message: 'synthetic-sensitive-provider-message', details: 'synthetic-sensitive-details' } },
  () => ({ id: 'owner', roles: 'admin' })
]) {
  const server = createHttpServer({ composition, listen: { port: 0 }, resolvePrincipal })
  try {
    const address = await server.listen()
    for (const [path, method, body] of [
      ['/rpc', 'POST', { id: 'auth-test', method: 'listDialects', args: [] }],
      ['/connections', 'GET'], ['/artifacts/upload-tickets', 'POST', {}]
    ]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method, headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      const value = await response.json()
      assert.equal(response.status, 401)
      assert.equal(value.error.code, 'unauthorized')
      assert.equal(value.error.message, '认证失败')
      assert.equal(JSON.stringify(value).includes('synthetic-sensitive'), false)
    }
  } finally { await server.close() }
}
const projectedServer = createHttpServer({
  composition, listen: { port: 0 }, resolvePrincipal: () => ({ id: 'owner', roles: ['reader'], token: 'synthetic-sensitive' })
})
try {
  const address = await projectedServer.listen()
  const response = await fetch(`http://127.0.0.1:${address.port}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'projection', method: 'listDialects', args: [] })
  })
  assert.equal(response.status, 200)
  await response.json()
  assert.deepEqual(receivedPrincipal, { id: 'owner', roles: ['reader'] })
} finally { await projectedServer.close() }
console.log('HTTP auth：严格principal、固定异常、RS256/ES256必要claims、裸DI三路真实401测试通过')
