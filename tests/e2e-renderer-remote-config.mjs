import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = await build({
  configFile: false, root, logLevel: 'warn',
  build: { write: false, target: 'node22', ssr: true,
    lib: { entry: resolve(root, 'src/preload/remote-backend-config.ts'), formats: ['es'] } }
})
const output = Array.isArray(result) ? result[0].output : result.output
const { readRendererRemoteBackendConfig: readConfig } = await import(`data:text/javascript;base64,${Buffer.from(output.find((item) => item.type === 'chunk').code).toString('base64')}`)
assert.equal(readConfig({}), null)
const fixtureToken = 'synthetic-access-fixture'
for (const endpoint of ['https://backend.example.test/rpc', 'http://127.0.0.1:8811/rpc', 'http://localhost:8811/rpc', 'http://[::1]:8811/rpc']) {
  const config = readConfig({ DBSTUDIO_BACKEND_ENDPOINT: endpoint, DBSTUDIO_BACKEND_ACCESS_TOKEN: fixtureToken })
  assert.equal(config.mode, 'http')
  assert.equal(config.http.endpoint, endpoint)
  assert.ok(config.http.getHeaders().authorization === `Bearer ${fixtureToken}`)
  assert.equal(JSON.stringify(config).includes(fixtureToken), false, 'token is not part of serializable runtime config')
}
for (const endpoint of ['http://remote.example.test/rpc', 'file:///local/rpc', '//remote.test/rpc', 'https://name:password@backend.test/rpc', 'https://backend.test/rpc?token=fixture']) {
  assert.throws(() => readConfig({ DBSTUDIO_BACKEND_ENDPOINT: endpoint, DBSTUDIO_BACKEND_ACCESS_TOKEN: fixtureToken }))
}
assert.throws(() => readConfig({ DBSTUDIO_BACKEND_ENDPOINT: 'https://backend.test/rpc' }), /ACCESS_TOKEN/)
assert.throws(() => readConfig({ DBSTUDIO_BACKEND_ACCESS_TOKEN: fixtureToken }), /ENDPOINT/)
console.log('preload remote 启动配置：HTTPS、fail-closed 与运行时凭据注入通过')
