import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = process.cwd()
const outDir = await mkdtemp(join(tmpdir(), 'dbstudio-remote-contract-'))
  await build({
    configFile: false,
    build: {
      lib: {
        entry: join(root, 'src/backend/contract/remote.ts'),
        formats: ['es'],
        fileName: () => 'remote.mjs'
      },
      outDir,
      emptyOutDir: true,
      rollupOptions: { external: [] }
    }
  })
  const remote = await import(pathToFileURL(join(outDir, 'remote.mjs')).href)
  const policy = { allowedHosts: ['db.example.test'], allowedPorts: [5432] }

  assert.equal(remote.isRemoteOutboundTargetAllowed({ host: 'db.example.test', port: 5432 }, policy), true)
  assert.equal(remote.isRemoteOutboundTargetAllowed({ host: 'DB.EXAMPLE.TEST.', port: 5432 }, policy), true)
  assert.equal(remote.isRemoteOutboundTargetAllowed({ host: 'db.example.test', port: 3306 }, policy), false)
  assert.equal(remote.isRemoteOutboundTargetAllowed({ host: 'localhost', port: 5432 }, policy), false)
  assert.equal(remote.isRemoteOutboundTargetAllowed({ host: '192.168.1.10', port: 5432 }, policy), false)
  assert.equal(remote.isRemoteOutboundTargetAllowed({ host: 'db.example.test/secret', port: 5432 }, policy), false)

  const accepted = remote.validateRemoteConnectionConfig(
    { dialectId: 'postgresql', name: 'remote', options: { host: 'db.example.test', port: 5432, database: 'app', profile: 'primary' } },
    policy
  )
  assert.equal(accepted.ok, true)

  const formDefaults = remote.validateRemoteConnectionConfig(
    {
      dialectId: 'postgresql',
      name: 'form-defaults',
      options: {
        host: 'db.example.test', port: 5432, sshPort: 22,
        sshHost: '', sshTargetHost: '', sshPrivateKey: '', sslrootcert: ''
      }
    },
    policy
  )
  assert.equal(formDefaults.ok, true)

  for (const field of ['path', 'file', 'sourcePath', 'destinationPath', 'socketPath', 'sslrootcert', 'sshPrivateKey']) {
    const result = remote.validateRemoteConnectionConfig(
      { dialectId: 'sqlite', name: 'remote', options: { [field]: '/server/private.db' } },
      policy
    )
    assert.equal(result.ok, false, field)
    assert.ok(result.issues.some((issue) => issue.code === 'forbidden-path'), field)
  }

  const multiTarget = remote.validateRemoteConnectionConfig(
    {
      dialectId: 'postgresql',
      name: 'ssh',
      options: {
        host: 'db.example.test', port: 5432,
        sshHost: 'jump.example.test', sshPort: 22,
        sshTargetHost: 'db.example.test', sshTargetPort: 5432
      }
    },
    { allowedHosts: ['db.example.test', 'jump.example.test'], allowedPorts: [22, 5432] }
  )
  assert.equal(multiTarget.ok, true)
  const deniedSsh = remote.validateRemoteConnectionConfig(
    { dialectId: 'postgresql', name: 'ssh', options: { host: 'db.example.test', port: 5432, sshHost: 'evil.example.test', sshPort: 22 } },
    { allowedHosts: ['db.example.test'], allowedPorts: [5432] }
  )
  assert.equal(deniedSsh.ok, false)
  assert.ok(deniedSsh.issues.some((issue) => issue.field === 'options.sshHost'))

  const badShape = remote.validateRemoteConnectionConfig(
    { dialectId: 'postgresql', name: 'remote', options: { host: 'db.example.test', port: 5432, secret: { value: 'x' } } },
    policy
  )
  assert.equal(badShape.ok, false)
  assert.ok(badShape.issues.some((issue) => issue.field === 'options.secret'))

console.log('远程连接 contract 测试通过')
