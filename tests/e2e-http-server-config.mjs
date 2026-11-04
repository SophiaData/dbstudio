/** HTTP 主进程启动配置的默认行为与 loopback 安全边界。 */

import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    write: false,
    target: 'node22',
    ssr: true,
    lib: {
      entry: resolve(root, 'src/main/server/http-server-config.ts'),
      formats: ['es']
    }
  }
})
const output = Array.isArray(result) ? result[0].output : result.output
const code = output.find((item) => item.type === 'chunk')?.code
assert.equal(typeof code, 'string')
const {
  createHttpServerPrincipalResolver,
  readHttpServerStartupConfig
} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

let pass = 0
let fail = 0
async function check(name, run) {
  try {
    await run()
    pass += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  ❌ ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

await check('未配置端口时完全禁用 HTTP 服务', () => {
  assert.equal(readHttpServerStartupConfig({}), null)
  assert.equal(readHttpServerStartupConfig({ DBSTUDIO_HTTP_PORT: '  ' }), null)
})

await check('合法 loopback 配置使用默认 host 与固定 owner resolver', async () => {
  const config = readHttpServerStartupConfig({
    DBSTUDIO_HTTP_PORT: '0',
    DBSTUDIO_HTTP_OWNER_ID: 'desktop'
  })
  assert.deepEqual(config, { host: '127.0.0.1', port: 0, ownerId: 'desktop' })
  assert.deepEqual(await createHttpServerPrincipalResolver(config)({}), { id: 'desktop' })
})

await check('注入 resolver 接收原始请求并返回认证 principal', async () => {
  const config = readHttpServerStartupConfig({
    DBSTUDIO_HTTP_PORT: '8123',
    DBSTUDIO_HTTP_HOST: '127.0.0.1'
  })
  const request = { headers: { authorization: 'opaque-test-token' } }
  let observed
  const injected = async (value) => {
    observed = value
    return { id: 'owner-a' }
  }
  const resolver = createHttpServerPrincipalResolver(config, injected)
  assert.deepEqual(await resolver(request), { id: 'owner-a' })
  assert.strictEqual(observed, request)
})

await check('非 loopback 模式要求注入 resolver，拒绝固定 owner', async () => {
  const config = readHttpServerStartupConfig({
    DBSTUDIO_HTTP_PORT: '8123',
    DBSTUDIO_HTTP_HOST: '0.0.0.0'
  })
  assert.deepEqual(config, { host: '0.0.0.0', port: 8123 })
  assert.throws(() => createHttpServerPrincipalResolver(config), /必须注入 resolvePrincipal/)
  const injected = async () => ({ id: 'remote-owner' })
  assert.strictEqual(createHttpServerPrincipalResolver(config, injected), injected)
})

await check('非 loopback 配置不能携带固定 owner', () => {
  const config = readHttpServerStartupConfig({
    DBSTUDIO_HTTP_PORT: '8123',
    DBSTUDIO_HTTP_HOST: '0.0.0.0',
    DBSTUDIO_HTTP_OWNER_ID: 'desktop'
  })
  assert.throws(
    () => createHttpServerPrincipalResolver(config),
    /OWNER_ID 仅允许 loopback host/
  )
})

console.log(`\n===== HTTP server 启动配置：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exitCode = 1
