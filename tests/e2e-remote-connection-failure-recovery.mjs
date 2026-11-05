import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-remote-connection-failure-'))
await build({
  configFile: false,
  root,
  logLevel: 'warn',
  ssr: { noExternal: ['jose'] },
  build: {
    outDir,
    emptyOutDir: false,
    target: 'node22',
    ssr: true,
    lib: { entry: { server: resolve(root, 'src/main/server/index.ts') }, formats: ['es'], fileName: (_f, n) => `${n}.mjs` },
    rollupOptions: { external: [/^node:/] }
  }
})
const { createHttpServer, OwnerQuotaError } = await import(pathToFileURL(join(outDir, 'server.mjs')).href)
const scopes = new Map()
let quotaReject = false
let calls = 0
let oversizedList = false
const manager = {
  list: () => oversizedList ? [{ id: 'large', name: 'x'.repeat(2000), dialectId: 'postgresql', connected: false, persisted: true, secretStored: false, options: {} }] : [],
  add: async (_config, secret) => {
    calls += 1
    assert.equal(secret.dbPassword, 'do-not-log')
    if (quotaReject) {
      throw new OwnerQuotaError('connections', '连接配额已达上限')
    }
    return { id: 'c1', name: 'new', dialectId: 'sqlite', connected: false, persisted: true, secretStored: false, capabilities: null, options: {} }
  },
  testConnection: async () => ({ ok: true, latencyMs: 1 }),
  updateConnection: async () => { throw new Error('network failure') },
  connectConnection: async () => { throw new Error('network failure') },
  disconnectConnection: async () => { throw new Error('network failure') },
  remove: async () => undefined
}
const composition = {
  dispatch: async (request) => ({ id: request.id, ok: true, value: null }),
  scopeFor: (principal) => {
    let scope = scopes.get(principal.id)
    if (!scope) {
      scope = { manager, dispose: async () => undefined }
      scopes.set(principal.id, scope)
    }
    return scope
  },
  dispose: async () => undefined
}
const governance = {
  acquireRequest: () => ({ release: () => undefined }),
  recordAuthenticationFailure: () => undefined
}
const server = createHttpServer({
  composition,
  listen: { host: '127.0.0.1', port: 0 },
  resolvePrincipal: (request) => request.headers['x-owner-id'] ? { id: String(request.headers['x-owner-id']) } : null,
  governance,
  auditSink: { record: () => { throw new Error('audit sink down') } },
  metricsSink: { record: () => { throw new Error('metrics sink down') } },
  maxConcurrentRequests: 1,
  maxResponseBytes: 1024
})
const address = await server.listen()
const origin = `http://127.0.0.1:${address.port}`
const post = (body, owner = 'owner-a') => fetch(`${origin}/connections`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-owner-id': owner },
  body: JSON.stringify(body)
})
try {
  const unauthorized = await fetch(`${origin}/connections`)
  assert.equal(unauthorized.status, 401)
  assert.equal((await unauthorized.json()).error.code, 'unauthorized')

  quotaReject = true
  const quota = await post({ config: { dialectId: 'sqlite', name: 'quota', options: {} }, secret: { dbPassword: 'do-not-log' } })
  assert.equal(quota.status, 429)
  const quotaError = (await quota.json()).error
  assert.equal(quotaError.code, 'conflict')
  assert.equal(quotaError.retryable, true)
  assert.deepEqual(quotaError.details, { resource: 'connections' })
  quotaReject = false

  const success = await post({ config: { dialectId: 'sqlite', name: 'ok', options: {} }, secret: { dbPassword: 'do-not-log' } })
  assert.equal(success.status, 201)
  assert.equal((await success.json()).value.options.file, undefined)
  assert.equal(calls, 2)

  const malformed = await fetch(`${origin}/connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-owner-id': 'owner-a' },
    body: '{bad-json'
  })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error.code, 'invalid-argument')
  oversizedList = true
  const tooLarge = await fetch(`${origin}/connections`, { headers: { 'x-owner-id': 'owner-a' } })
  assert.equal(tooLarge.status, 500)
  const limitBody = await tooLarge.text()
  assert.ok(Buffer.byteLength(limitBody) < 1024)
  assert.equal(JSON.parse(limitBody).error.code, 'internal')
  oversizedList = false
  const recovered = await fetch(`${origin}/connections`, { headers: { 'x-owner-id': 'owner-a' } })
  assert.equal(recovered.status, 200, 'oversized response must release shared request limiter')
  console.log('远程 connection failure recovery 测试通过')
} finally {
  await server.close()
}
