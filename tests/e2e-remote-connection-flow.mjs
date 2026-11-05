import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'

const root = resolve(process.cwd())
const outDir = mkdtempSync(join(root, 'out/.remote-flow-probe-'))
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir,
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    ssr: true,
    rollupOptions: {
      external: [/^node:/, 'electron'],
      output: { entryFileNames: 'probe.cjs' }
    },
    lib: { entry: resolve(root, 'tests/remote-connection-probe.ts'), formats: ['cjs'], fileName: () => 'probe.cjs' }
  }
})

const { ConnectionManager, ConnectionStore, listBuiltinDialects } = await import(`file://${join(outDir, 'probe.cjs')}`)
const storeDir = mkdtempSync(join(tmpdir(), 'dbstudio-remote-store-'))
const store = new ConnectionStore({
  baseDir: storeDir,
  cipher: {
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (payload) => payload.toString()
  }
})
let hostFactoryCalls = 0
const manager = new ConnectionManager(listBuiltinDialects(), store, {
  remoteOutboundPolicy: { allowedHosts: ['db.example.test'], allowedPorts: [5432] },
  createDriverHost: () => {
    hostFactoryCalls += 1
    return {
      handshake: Promise.resolve(),
      connect: async () => ({ supportsExplain: false, supportsInlineEdit: false, supportsServerPagination: false, supportsCancel: false }),
      testConnection: async () => ({ ok: true, latencyMs: 1 }),
      rollbackTransaction: async () => undefined,
      close: async () => undefined,
      kill: () => undefined
    }
  }
})

const pathConfig = { dialectId: 'sqlite', name: 'unsafe', options: { file: '/server/private.db' } }
await assert.rejects(() => manager.add(pathConfig), /远程连接配置被拒绝/)
await assert.rejects(() => manager.testConnection(pathConfig), /远程连接配置被拒绝/)
assert.equal(hostFactoryCalls, 0, '拒绝的 testConnection 不应创建宿主')

const accepted = { dialectId: 'postgresql', name: 'remote', options: { host: 'db.example.test', port: 5432, database: 'app' } }
const added = await manager.add(accepted)
assert.equal(added.connected, true, '允许的出站目标应完成 add/connect 流程')
assert.equal(manager.list().length, 1)
await assert.rejects(
  () => manager.connectConnection('missing'),
  (error) => error?.code === 'not-found'
)
await assert.rejects(
  () => manager.updateConnection('c1', { options: { host: 'db.example.test', port: 5432, file: '/server/private.db' } }),
  /远程连接配置被拒绝/
)
assert.deepEqual(manager.list()[0].options, accepted.options)
accepted.options.host = 'evil.example.test'
await manager.disconnectConnection('c1')
await assert.rejects(() => manager.connectConnection('c1'), /远程连接配置被拒绝/)
await manager.disposeAll()
const desktop = new ConnectionManager(listBuiltinDialects(), new ConnectionStore({
  baseDir: mkdtempSync(join(tmpdir(), 'dbstudio-desktop-saved-limit-')), cipher: null
}), {
  onLog: () => undefined,
  createDriverHost: () => ({
    handshake: Promise.resolve(),
    connect: async () => ({ supportsInlineEdit: false, supportsServerPagination: false, supportsCancel: false }),
    rollbackTransaction: async () => undefined,
    close: async () => undefined,
    kill: () => undefined
  })
})
try {
  for (let index = 0; index < 101; index += 1) {
    const added = await desktop.add({ dialectId: 'sqlite', name: `desktop-${index}`, options: { file: ':memory:' } })
    await desktop.disconnectConnection(added.id)
  }
  assert.equal(desktop.list().length, 101, '桌面模式仍支持本机配置且不受远程默认100条限制')
} finally { await desktop.disposeAll() }
console.log('远程连接 add/test/update/connect 复验与桌面保存额度兼容测试通过')
