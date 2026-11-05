import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-http-connection-routes-'))
const bundle = join(outDir, 'server.mjs')
await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    target: 'node22',
    ssr: true,
    lib: {
      entry: { server: resolve(root, 'src/main/server/http-server.ts') },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`
    },
    rollupOptions: { external: [/^node:/] }
  }
})
assert.ok(existsSync(bundle))
const { createHttpServer } = await import(pathToFileURL(bundle).href)

const audit = []
const metrics = []
const leases = []
const scopes = new Map()
const calls = []
const summary = (id, name = id) => ({
  id, name, dialectId: 'sqlite', connected: true, capabilities: null,
  persisted: true, secretStored: false, options: { file: `/tmp/${id}.db` }
})
const managers = (owner) => {
  const list = [summary(`${owner}-c1`, `${owner} connection`)]
  const owned = (id) => {
    if (!id.startsWith(`${owner}-`)) {
      const error = new Error('连接不存在')
      error.code = 'not-found'
      throw error
    }
  }
  return {
    list: () => list,
    add: async (config, secret) => {
      calls.push(['add', owner, config, secret])
      return summary(`${owner}-new`, config.name)
    },
    testConnection: async (config, secret) => {
      calls.push(['test', owner, config, secret])
      return { ok: true, latencyMs: 2 }
    },
    updateConnection: async (id, config, secret) => {
      owned(id)
      calls.push(['update', owner, id, config, secret])
      return summary(id, config.name ?? 'updated')
    },
    connectConnection: async (id) => {
      owned(id)
      calls.push(['connect', owner, id])
      return summary(id)
    },
    disconnectConnection: async (id) => {
      owned(id)
      calls.push(['disconnect', owner, id])
      return { ...summary(id), connected: false }
    },
    remove: async (id) => {
      owned(id)
      calls.push(['remove', owner, id])
    }
  }
}
const composition = {
  dispatch: async (request) => ({ id: request.id, ok: true, value: null }),
  scopeFor: (principal) => {
    let scope = scopes.get(principal.id)
    if (!scope) {
      scope = { manager: managers(principal.id), dispose: async () => undefined }
      scopes.set(principal.id, scope)
    }
    return scope
  },
  dispose: async () => undefined
}
const governance = {
  acquireRequest: (ownerId, requestId) => {
    leases.push(['acquire', ownerId, requestId])
    return { release: () => leases.push(['release', ownerId, requestId]) }
  },
  recordAuthenticationFailure: () => undefined
}
const server = createHttpServer({
  composition,
  listen: { host: '127.0.0.1', port: 0 },
  resolvePrincipal: (request) => {
    const owner = request.headers['x-owner-id']
    return typeof owner === 'string' ? { id: owner } : null
  },
  governance,
  auditSink: { record: (event) => audit.push(event) },
  metricsSink: { record: (event) => metrics.push(event) },
  maxConcurrentRequests: 2
})
const address = await server.listen()
const origin = `http://127.0.0.1:${address.port}`
const json = async (path, init = {}, owner = 'owner-a') => fetch(`${origin}${path}`, {
  ...init,
  headers: { 'content-type': 'application/json', 'x-owner-id': owner, ...(init.headers ?? {}) }
})
try {
  const list = await json('/connections', { method: 'GET' })
  assert.equal(list.status, 200)
  assert.equal((await list.json()).value[0].id, 'owner-a-c1')

  const other = await json('/connections', { method: 'GET' }, 'owner-b')
  assert.equal((await other.json()).value[0].id, 'owner-b-c1')

  const created = await json('/connections', {
    method: 'POST',
    body: JSON.stringify({ config: { dialectId: 'sqlite', name: 'new', options: { file: ':memory:' } }, secret: { dbPassword: 'private' } })
  })
  assert.equal(created.status, 201)
  assert.equal((await created.json()).value.id, 'owner-a-new')

  const tested = await json('/connections/test', {
    method: 'POST',
    body: JSON.stringify({ config: { dialectId: 'sqlite', name: 'test', options: { file: ':memory:' } }, secret: { dbPassword: 'private' } })
  })
  assert.equal(tested.status, 200)
  assert.equal((await tested.json()).value.ok, true)

  for (const [path, method, expectedCall] of [
    ['/connections/owner-a-c1/connect', 'POST', 'connect'],
    ['/connections/owner-a-c1/disconnect', 'POST', 'disconnect'],
    ['/connections/owner-a-c1', 'PATCH', 'update'],
    ['/connections/owner-a-c1', 'DELETE', 'remove']
  ]) {
    const response = await json(path, {
      method,
      body: method === 'PATCH' ? JSON.stringify({ config: { name: 'changed' }, secretPatch: { dbPassword: 'private' } }) : undefined
    })
    assert.equal(response.status, 200, `${method} ${path}`)
    assert.equal(calls.at(-1)[0], expectedCall)
  }

  const foreign = await json('/connections/owner-a-c1/connect', { method: 'POST' }, 'owner-b')
  assert.equal(foreign.status, 404)
  assert.equal((await foreign.json()).error.code, 'not-found')

  const serialized = JSON.stringify({ audit, metrics })
  assert.equal(serialized.includes('private'), false)
  assert.ok(leases.some(([kind]) => kind === 'acquire'))
  assert.ok(leases.some(([kind]) => kind === 'release'))
  assert.equal(audit.every((event) => !('value' in event)), true)
  console.log('HTTP owner-scoped connection routes 测试通过')
} finally {
  await server.close()
}
