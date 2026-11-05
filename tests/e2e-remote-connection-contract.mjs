import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = process.cwd()
const outDir = await mkdtemp(join(tmpdir(), 'dbstudio-remote-connection-contract-'))
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
      entry: { remoteConnection: join(root, 'src/backend/contract/remote-connection.ts') },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`
    },
    rollupOptions: { external: [/^node:/] }
  }
})
const contract = await import(pathToFileURL(join(outDir, 'remoteConnection.mjs')).href)

assert.deepEqual(contract.REMOTE_CONNECTION_ROUTES, {
  list: { method: 'GET', path: '/connections' },
  create: { method: 'POST', path: '/connections' },
  test: { method: 'POST', path: '/connections/test' },
  update: { method: 'PATCH', path: '/connections/:id' },
  connect: { method: 'POST', path: '/connections/:id/connect' },
  disconnect: { method: 'POST', path: '/connections/:id/disconnect' },
  remove: { method: 'DELETE', path: '/connections/:id' }
})
assert.equal(contract.remoteConnectionPath('c/1'), '/connections/c%2F1')
assert.equal(contract.remoteConnectionPath('c1', 'connect'), '/connections/c1/connect')
assert.throws(() => contract.remoteConnectionPath(''), /connectionId 不能为空/)
assert.equal(contract.isRemoteConnectionMethod('create'), true)
assert.equal(contract.isRemoteConnectionMethod('drop'), false)

const summary = contract.toRemoteConnectionSummary({
  id: 'c1',
  name: 'remote',
  dialectId: 'postgresql',
  connected: false,
  persisted: true,
  secretStored: true,
  capabilities: null,
  options: {
    host: 'db.example.test', file: '/server/private.db', password: 'must-not-appear',
    api_key: 'must-not-appear', accessKey: 'must-not-appear', 'private-key': 'must-not-appear',
    passphrase: 'must-not-appear', credentials: 'must-not-appear'
  },
  secret: { dbPassword: 'must-not-appear' }
})
assert.deepEqual(summary, {
  id: 'c1',
  name: 'remote',
  dialectId: 'postgresql',
  connected: false,
  persisted: true,
  secretStored: true,
  capabilities: null,
  options: { host: 'db.example.test' }
})
assert.equal(JSON.stringify(summary).includes('must-not-appear'), false)
console.log('远程连接 control contract 测试通过')
