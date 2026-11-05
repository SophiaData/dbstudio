import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-cors-'))
await build({ configFile: false, root, logLevel: 'warn', build: {
  outDir, emptyOutDir: false, ssr: true, target: 'node22',
  lib: { entry: resolve(root, 'src/main/server/http-server.ts'), formats: ['es'] },
  rollupOptions: { external: [/^node:/], output: { entryFileNames: 'server.mjs' } }
} })
const { createHttpServer } = await import(pathToFileURL(join(outDir, 'server.mjs')).href)
let authCalls = 0
const options = {
  composition: { dispatch: async (req) => ({ id: req.id, ok: true, value: [] }), scopeFor: () => ({ manager: { list: () => [] } }), dispose: async () => {} },
  listen: { host: '127.0.0.1', port: 0 },
  resolvePrincipal: (req) => { authCalls += 1; return req.headers.authorization === 'Bearer synthetic-cors' ? { id: 'fixture' } : null }
}
assert.throws(() => createHttpServer({ ...options, allowedOrigins: ['*'] }), /origin/)
assert.throws(() => createHttpServer({ ...options, allowedOrigins: ['http://untrusted.test'] }), /origin/)
const server = createHttpServer({ ...options, allowedOrigins: ['null', 'https://frontend.test'] })
try {
  const { port } = await server.listen()
  const endpoint = `http://127.0.0.1:${port}/connections`
  for (const origin of ['null', 'https://frontend.test']) {
    const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, Content-Type, X-DBStudio-Request-Id' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
    assert.equal(preflight.headers.has('access-control-allow-credentials'), false)
    assert.equal(preflight.headers.get('vary'), 'Origin')
  }
  assert.equal(authCalls, 0, 'preflight never invokes authentication or owner services')
  const denied = await fetch(endpoint, { headers: { origin: 'https://other.test', authorization: 'Bearer synthetic-cors' } })
  assert.equal(denied.status, 403)
  assert.equal(denied.headers.has('access-control-allow-origin'), false)
  const headersDenied = await fetch(endpoint, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-arbitrary-header' } })
  assert.equal(headersDenied.status, 403)
  const unauthorized = await fetch(endpoint, { headers: { origin: 'null' } })
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.headers.get('access-control-allow-origin'), 'null', 'browser receives readable auth rejection')
  const authorized = await fetch(endpoint, { headers: { origin: 'null', authorization: 'Bearer synthetic-cors' } })
  assert.equal(authorized.status, 200)
  assert.deepEqual((await authorized.json()).value, [])
} finally { await server.close() }
const closed = createHttpServer(options)
try {
  const { port } = await closed.listen()
  const response = await fetch(`http://127.0.0.1:${port}/connections`, { headers: { origin: 'null', authorization: 'Bearer synthetic-cors' } })
  assert.equal(response.status, 403, 'CORS defaults to fail closed')
} finally { await closed.close() }
console.log('HTTP CORS：精确origin、预检、默认拒绝、实际请求仍需认证通过')
