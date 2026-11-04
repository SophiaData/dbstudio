import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'

const root = resolve(process.cwd())
const outDir = mkdtempSync(join(root, 'out/.owner-connection-lease-'))
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir,
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    ssr: true,
    rollupOptions: {
      external: [/^node:/, 'electron'],
      output: { entryFileNames: 'probe.cjs' }
    },
    lib: { entry: resolve(root, 'tests/owner-connection-lease-probe.ts'), formats: ['cjs'], fileName: () => 'probe.cjs' }
  }
})

const { ConnectionManager, ConnectionStore, OwnerGovernance, listBuiltinDialects } =
  await import(`file://${join(outDir, 'probe.cjs')}`)

const owner = 'owner-lease'
const governance = new OwnerGovernance({ quota: { maxConnections: 1 } })
const storeDir = mkdtempSync(join(tmpdir(), 'dbstudio-owner-lease-store-'))
const store = new ConnectionStore({ baseDir: storeDir, cipher: null })
let created = 0
const hostFactory = () => {
  created += 1
  return {
    closed: false,
    handshake: Promise.resolve(),
    connect: async () => ({ supportsExplain: false, supportsInlineEdit: false, supportsServerPagination: false, supportsCancel: false }),
    testConnection: async () => ({ ok: true, latencyMs: 1 }),
    rollbackTransaction: async () => undefined,
    close: async function () { this.closed = true },
    kill: function () { this.closed = true }
  }
}
const manager = new ConnectionManager(listBuiltinDialects(), store, {
  createDriverHost: hostFactory,
  remoteOutboundPolicy: { allowedHosts: ['db.example.test'], allowedPorts: [5432] },
  reserveConnection: () => governance.reserveConnection(owner)
})
const config = { dialectId: 'postgresql', name: 'owner-db', options: { host: 'db.example.test', port: 5432, database: 'app' } }

const added = await manager.add(config)
assert.equal(added.connected, true)
assert.equal(created, 1)
await assert.rejects(
  () => manager.add({ ...config, name: 'blocked' }),
  /owner 连接额度已达上限/
)
await manager.disconnectConnection('c1')
const tested = await manager.testConnection(config)
assert.equal(tested.ok, true)
await manager.remove('c1')
await manager.connectConnection('c2')
await manager.remove('c2')
assert.equal(manager.list().length, 0)
await manager.disposeAll()
governance.dispose()
console.log('owner connection lease add/connect/disconnect/test/remove 测试通过')
