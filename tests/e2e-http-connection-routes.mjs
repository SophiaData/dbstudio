import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-http-connection-routes-'))
await build({
  configFile: false, root, logLevel: 'warn',
  build: {
    outDir, emptyOutDir: false, target: 'node22', ssr: true,
    lib: {
      entry: {
        server: resolve(root, 'src/main/server/http-server.ts'),
        composition: resolve(root, 'src/main/server/http-server-composition.ts')
      },
      formats: ['es'], fileName: (_format, name) => `${name}.mjs`
    },
    rollupOptions: { external: [/^node:/] }
  }
})
const { createHttpServer } = await import(pathToFileURL(join(outDir, 'server.mjs')).href)
const { createHttpServerComposition } = await import(pathToFileURL(join(outDir, 'composition.mjs')).href)
const dialects = ['postgresql', 'mysql', 'redis', 'kafka', 'sqlite', 'extension'].map((id) => ({
  id, displayName: id, fields: [{ key: 'dbPassword', kind: 'password' }]
}))
const baseDir = join(outDir, 'state')
const ownerDir = (owner) => join(baseDir, 'owners', createHash('sha256').update(owner).digest('hex'))
const config = (name = 'remote', options = {}) => ({
  dialectId: 'postgresql', name, options: { host: 'db.example.test', port: 5432, ...options }
})
// 仅生成本测试自己的旧配置，验证历史不安全字段不能从 RPC 摘要旁路泄露。
mkdirSync(ownerDir('legacy'), { recursive: true })
writeFileSync(join(ownerDir('legacy'), 'connections.json'), JSON.stringify({
  schemaVersion: 1,
  connections: [{ id: 'c1', config: config('legacy', {
    file: '/synthetic/legacy.db', api_key: 'synthetic-option',
    sshPrivateKey: '/synthetic/private-key', dbPassword: 'synthetic-meta-secret',
    nested: { token: 'synthetic-nested-secret' }
  }) }]
}))
const audit = []
const hostCalls = []
let hostCount = 0
let closeCount = 0
const createDriverHost = () => {
  hostCount += 1
  return {
    handshake: Promise.resolve(),
    connect: async (value, secret) => {
      hostCalls.push(['connect', value, secret])
      if (value.name === 'network-fail') throw new Error('synthetic network failure')
      return { supportsInlineEdit: false, supportsServerPagination: false, supportsCancel: false }
    },
    testConnection: async (value, secret) => {
      hostCalls.push(['test', value, secret])
      return { ok: true, elapsedMs: 1 }
    },
    listChildren: async () => [{
      id: 'schema:public', name: 'public', kind: 'schema', parentId: null, hasChildren: true,
      meta: { 'options.file': 'adapter-metadata' }
    }],
    rollbackTransaction: async () => undefined,
    close: async () => { closeCount += 1 },
    kill: () => undefined
  }
}
const composition = createHttpServerComposition({
  dialects, baseDir, cipher: null, onLog: () => undefined, createDriverHost,
  remoteOutboundPolicy: { allowedHosts: ['db.example.test', 'jump.example.test'], allowedPorts: [5432, 22] }
})
const server = createHttpServer({
  composition, listen: { host: '127.0.0.1', port: 0 },
  resolvePrincipal: (request) => {
    const owner = request.headers['x-owner-id']
    return typeof owner === 'string' ? { id: owner } : null
  },
  auditSink: { record: (event) => audit.push(event) }
})
const address = await server.listen()
const json = async (path, method = 'GET', body, owner = 'owner-a') => {
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-owner-id': owner },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: response.status, body: await response.json() }
}
const rpc = async (method, args, owner = 'owner-a') =>
  (await json('/rpc', 'POST', { id: `rpc-${method}`, method, args }, owner)).body
const disk = (owner = 'owner-a') => readFileSync(join(ownerDir(owner), 'connections.json'), 'utf8')
try {
  const created = await json('/connections', 'POST', { config: config(), secret: { dbPassword: 'synthetic-password' } })
  assert.equal(created.status, 201)
  assert.equal(created.body.value.id, 'c1')
  assert.equal(created.body.value.connected, true)
  assert.equal(hostCalls.at(-1)[2].dbPassword, 'synthetic-password')
  assert.equal(disk().includes('synthetic-password'), false)
  const aliasUpdate = await json('/connections/connection%3Ac1%7Ctable%3Aalias', 'PATCH', { config: {} })
  assert.equal(aliasUpdate.status, 200)
  assert.equal(aliasUpdate.body.value.id, 'c1', '节点别名更新必须落到原连接ID，不能借PATCH新增配置')
  assert.equal(JSON.parse(disk()).connections.length, 1)
  assert.deepEqual((await json('/connections', 'GET', undefined, 'owner-b')).body.value, [])
  for (const [path, method, body] of [
    ['/connections/c1/connect', 'POST'], ['/connections/c1/disconnect', 'POST'],
    ['/connections/c1', 'PATCH', { config: { name: 'foreign' } }], ['/connections/c1', 'DELETE']
  ]) {
    const result = await json(path, method, body, 'owner-b')
    assert.equal(result.status, 404, `${method} ${path} unknown/foreign`)
  }
  const before = disk()
  const callsBefore = hostCount
  for (const bad of [
    {}, { config: null }, { config: [] }, { config: { dialectId: 'postgresql' } },
    { config: config(), secret: null }, { config: config(), secret: [] },
    { config: config(), secret: 42 }, { config: config(), secret: { dbPassword: null } },
    { config: config(), secret: { unknown: 'synthetic' } },
    { config: { ...config(), password: 'synthetic' } },
    { config: config('secret-option', { password: 'synthetic' }) },
    { config: config('secret-option', { api_key: 'synthetic' }) },
    { config: config('local-path', { file: '/synthetic/forbidden.db' }) },
    { config: config('local-path', { sshPrivateKeyPath: '/synthetic/key' }) },
    { config: { dialectId: 'mysql', name: 'default-host', options: {} } },
    { config: { dialectId: 'redis', name: 'default-host', options: {} } },
    { config: { dialectId: 'extension', name: 'unknown-target', options: {} } },
    { config: config('ssh-host-type', { sshHost: 127001, sshPort: 22 }) },
    { config: config('ssh-target-port', { sshHost: 'jump.example.test', sshTargetHost: '', sshTargetPort: 6379 }) }
  ]) {
    for (const path of ['/connections', '/connections/test']) {
      const result = await json(path, 'POST', bad)
      assert.equal(result.status, 400, `${path}: ${JSON.stringify(bad)}`)
      assert.equal(result.body.error.code, 'invalid-argument')
    }
    assert.equal(disk(), before, 'invalid create/test must not change saved state')
  }
  for (const bad of [
    {}, { config: null }, { config: [] }, { config: { options: null } },
    { config: { name: null } }, { config: { dialectId: 42 } },
    { config: { name: 'changed' }, secretPatch: null },
    { config: { name: 'changed' }, secretPatch: { dbPassword: 42 } },
    { config: { options: { token: 'synthetic' } } }
  ]) {
    const result = await json('/connections/c1', 'PATCH', bad)
    assert.equal(result.status, 400, `PATCH ${JSON.stringify(bad)}`)
    assert.equal(disk(), before, 'invalid update must be rejected before persistence')
  }
  assert.equal(hostCount, callsBefore, 'rejected inputs never create driver hosts')
  const tested = await json('/connections/test', 'POST', { config: config('ssh-defaults', {
    sshHost: '', sshPort: 22, sshTargetHost: '', sshTargetPort: '', sshPrivateKey: '', sslrootcert: ''
  }) })
  assert.equal(tested.status, 200)
  assert.equal(tested.body.value.ok, true)
  const ssh = await json('/connections/test', 'POST', { config: config('ssh-fallback', {
    sshHost: 'jump.example.test', sshTargetHost: '', sshTargetPort: ''
  }) })
  assert.equal(ssh.status, 200)
  const updated = await json('/connections/c1', 'PATCH', { config: { name: 'changed' }, secretPatch: { sshPassword: 'synthetic-ssh' } })
  // cipher=null keeps the existing update error semantics after valid configuration persistence.
  assert.equal(updated.status, 500)
  assert.equal(JSON.parse(disk()).connections[0].config.name, 'changed')
  assert.equal((await json('/connections/c1/disconnect', 'POST')).status, 200)
  assert.equal((await rpc('connectConnection', ['c1'])).ok, true)
  assert.equal((await rpc('disconnectConnection', ['c1'])).ok, true)
  for (const method of ['addConnection', 'testConnection', 'updateConnection']) {
    const response = await rpc(method, [config('bypass')])
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'unsupported')
  }
  const legacyRpc = await rpc('listConnections', [], 'legacy')
  const legacyHttp = await json('/connections', 'GET', undefined, 'legacy')
  assert.equal(legacyRpc.ok, true)
  assert.deepEqual(legacyRpc.value, legacyHttp.body.value)
  assert.deepEqual(legacyRpc.value[0].options, config().options)
  const legacyRoot = await rpc('listChildren', [null], 'legacy')
  assert.equal(legacyRoot.ok, true)
  assert.deepEqual(legacyRoot.value, [{
    id: 'connection:c1', kind: 'connection', name: 'legacy', parentId: null, hasChildren: true,
    meta: {
      dialect: 'postgresql', connected: false, persisted: true, secretStored: false,
      'options.host': 'db.example.test', 'options.port': 5432
    }
  }], 'RPC根metadata必须过滤路径、机密和非标量options，保留安全配置和连接状态')
  assert.equal(JSON.stringify(legacyRoot).includes('synthetic'), false)
  assert.deepEqual((await rpc('listChildren', [null], 'owner-b')).value, [])
  const connectedRoot = await rpc('listChildren', [null])
  assert.equal(connectedRoot.ok, true)
  assert.equal(connectedRoot.value[0].meta.connected, false)
  const nonRoot = await rpc('connectConnection', ['c1'])
  assert.equal(nonRoot.ok, true)
  const children = await rpc('listChildren', ['connection:c1'])
  assert.equal(children.ok, true)
  assert.equal(children.value[0].meta['options.file'], 'adapter-metadata', '过滤只作用于根连接配置投影')
  await rpc('disconnectConnection', ['c1'])
  const legacyConnect = await rpc('connectConnection', ['c1'], 'legacy')
  assert.equal(legacyConnect.ok, false)
  assert.equal(legacyConnect.error.code, 'invalid-argument')
  const legacyDisconnect = await rpc('disconnectConnection', ['c1'], 'legacy')
  assert.equal(legacyDisconnect.ok, true)
  assert.deepEqual(legacyDisconnect.value, legacyRpc.value[0])
  assert.equal((await rpc('connectConnection', ['c1'], 'owner-b')).error.code, 'not-found')
  assert.equal((await rpc('removeConnection', ['c1'], 'owner-b')).error.code, 'not-found')
  const otherCreated = await json('/connections', 'POST', { config: config('owner-b-only') }, 'owner-b')
  assert.equal(otherCreated.body.value.id, 'c1', '不同owner可以独立拥有同名连接ID')
  assert.equal((await rpc('listConnections', [], 'owner-b')).value[0].name, 'owner-b-only')
  assert.equal((await json('/connections')).body.value[0].name, 'remote', 'owner B同名ID不会覆盖owner A')
  assert.equal((await json('/connections/c1', 'DELETE', undefined, 'owner-b')).status, 200)
  assert.equal((await json('/connections')).body.value.length, 1)
  const noPolicyDir = join(outDir, 'no-policy')
  const closedDir = join(noPolicyDir, 'owners', createHash('sha256').update('closed').digest('hex'))
  mkdirSync(closedDir, { recursive: true })
  writeFileSync(join(closedDir, 'connections.json'), JSON.stringify({ schemaVersion: 1, connections: [{ id: 'c1', config: config('preexisting') }] }))
  const noPolicy = createHttpServerComposition({ dialects, baseDir: noPolicyDir, cipher: null, onLog: () => undefined, createDriverHost })
  try {
    const manager = noPolicy.scopeFor({ id: 'closed' }).manager
    const beforeClosed = readFileSync(join(closedDir, 'connections.json'), 'utf8')
    const beforeHosts = hostCount
    await assert.rejects(() => manager.add(config()), (error) => error.code === 'invalid-argument')
    await assert.rejects(() => manager.testConnection(config()), (error) => error.code === 'invalid-argument')
    await assert.rejects(() => manager.connectConnection('c1'), (error) => error.code === 'invalid-argument')
    assert.equal(readFileSync(join(closedDir, 'connections.json'), 'utf8'), beforeClosed)
    assert.equal(hostCount, beforeHosts)
  } finally { await noPolicy.dispose() }
  const quotaManager = composition.scopeFor({ id: 'quota' }).manager
  const failed = await quotaManager.add(config('network-fail'))
  assert.equal(failed.connected, false)
  assert.equal(failed.persisted, true)
  // 远程保存额度与活动会话额度分离；断开连接也占保存额度。
  for (let index = 1; index < 100; index += 1) {
    const item = await quotaManager.add(config(`saved-${index}`))
    await quotaManager.disconnectConnection(item.id)
  }
  const quotaBefore = disk('quota')
  const quotaHosts = hostCount
  await assert.rejects(() => quotaManager.add(config('over-limit')), (error) => error.code === 'conflict')
  const quotaHttp = await json('/connections', 'POST', { config: config('over-limit') }, 'quota')
  assert.equal(quotaHttp.status, 429)
  assert.equal(disk('quota'), quotaBefore)
  assert.equal(hostCount, quotaHosts)
  assert.equal(quotaManager.list().length, 100)
  await quotaManager.remove('c1')
  assert.equal((await quotaManager.add(config('replacement'))).persisted, true)
  assert.equal((await json('/connections/c1', 'DELETE')).status, 200)
  assert.equal((await json('/connections/c1', 'DELETE')).status, 404)
  assert.equal((await rpc('removeConnection', ['missing'])).error.code, 'not-found')
  assert.equal(JSON.stringify(audit).includes('synthetic-password'), false)
  assert.equal(audit.every((event) => !('value' in event)), true)
  assert.ok(existsSync(join(ownerDir('quota'), 'connections.json')))
  console.log('真实 HTTP composition/manager/store：owner 隔离、输入校验、SSH fallback、RPC 脱敏、fail-closed 与100条配置配额通过')
} finally {
  await server.close()
}
assert.equal(closeCount, hostCount, '全部 fake driver hosts 均回收')
