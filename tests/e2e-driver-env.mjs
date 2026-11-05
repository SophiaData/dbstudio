import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-driver-env-'))
await build({
  configFile: false, root, logLevel: 'warn',
  build: { outDir, emptyOutDir: false, target: 'node22', ssr: true,
    lib: { entry: resolve(root, 'src/main/DriverHostHandle.ts'), formats: ['cjs'] },
    rollupOptions: { external: [/^node:/], output: { entryFileNames: 'host.cjs' } } }
})
const { DriverHostHandle } = createRequire(import.meta.url)(join(outDir, 'host.cjs'))
const previousEnv = process.env
const previousSpawn = childProcess.spawn
let calls = 0
try {
  process.env = { ...previousEnv, DBSTUDIO_BACKEND_ACCESS_TOKEN: 'synthetic-client-token', DBSTUDIO_HTTP_SECRET_KEY_BASE64: 'synthetic-key', DBSTUDIO_DRIVER_ENV_FIXTURE: 'retained' }
  childProcess.spawn = (_executable, _args, options) => {
    calls += 1
    assert.ok(!Object.keys(options.env).some((key) => key.startsWith('DBSTUDIO_BACKEND_') || key.startsWith('DBSTUDIO_HTTP_')), 'server/client auth config must not reach driver environment')
    assert.equal(options.env.DBSTUDIO_DRIVER_ENV_FIXTURE, 'retained')
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
    throw new Error('test-spawn-boundary')
  }
  assert.throws(() => new DriverHostHandle({ dialectId: 'fixture', hostScript: '/unused-fixture' }), /test-spawn-boundary/)
  assert.equal(calls, 1)
} finally {
  childProcess.spawn = previousSpawn
  process.env = previousEnv
}
console.log('驱动 spawn 环境不继承 HTTP/客户端认证配置：通过')
