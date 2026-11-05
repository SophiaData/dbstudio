/** renderer backend-client 的 desktop/http 选择、认证状态与断线重连契约。 */

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
    lib: { entry: resolve(root, 'src/backend/backend-client.ts'), formats: ['es'] }
  }
})
const output = Array.isArray(result) ? result[0].output : result.output
const code = output.find((item) => item.type === 'chunk')?.code
assert.equal(typeof code, 'string')
const { createBackendClientSelection } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
)

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

await check('desktop 模式保留原 API 并标记 connected', async () => {
  const api = { listDialects: async () => [] }
  const selected = createBackendClientSelection({ mode: 'desktop', api })
  assert.strictEqual(selected.client, api)
  assert.deepEqual(selected.status, { mode: 'desktop', state: 'connected' })
})

await check('HTTP connection facade 使用 owner route 且不走 RPC manifest', async () => {
  const requests = []
  const selected = createBackendClientSelection({
    mode: 'http',
    http: {
      endpoint: 'http://backend.test/rpc',
      fetch: async (url, init) => {
        requests.push({ url, method: init.method, body: JSON.parse(init.body) })
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            value: { id: 'c1', name: 'remote', dialectId: 'sqlite', connected: true, persisted: true, secretStored: false, capabilities: null, options: {} }
          })
        }
      }
    }
  })
  const result = await selected.client.createRemoteConnection({
    config: { dialectId: 'sqlite', name: 'remote', options: { file: ':memory:' } },
    secret: { dbPassword: 'opaque-test-secret' }
  })
  assert.equal(result.id, 'c1')
  assert.equal(requests[0].url, 'http://backend.test/connections')
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].body.config.name, 'remote')
  assert.equal(requests[0].body.secret.dbPassword, 'opaque-test-secret')
})

await check('HTTP 断线后刷新认证头并只重试一次', async () => {
  let attempts = 0
  let reconnects = 0
  let authHeaders = []
  const selected = createBackendClientSelection({
    mode: 'http',
    http: {
      endpoint: 'http://backend.test/rpc',
      fetch: async (_url, init) => {
        attempts += 1
        authHeaders.push(init.headers.authorization)
        if (attempts === 1) throw new Error('socket closed')
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: init.headers['x-dbstudio-request-id'], ok: true, value: [] })
        }
      },
      headers: { authorization: 'Bearer old' },
      requestId: () => `selection-${attempts + 1}`
    },
    reconnect: async () => {
      reconnects += 1
      return { authorization: 'Bearer refreshed' }
    }
  })
  assert.deepEqual(await selected.client.listDialects(), [])
  assert.equal(attempts, 2)
  assert.equal(reconnects, 1)
  assert.deepEqual(authHeaders, ['Bearer old', 'Bearer refreshed'])
  assert.equal(selected.status.state, 'connected')
})

await check('非幂等写操作断线后不自动重试', async () => {
  let attempts = 0
  let reconnects = 0
  const selected = createBackendClientSelection({
    mode: 'http',
    http: {
      endpoint: 'http://backend.test/rpc',
      fetch: async () => {
        attempts += 1
        throw new Error('socket closed after write')
      },
      requestId: () => `selection-write-${attempts + 1}`
    },
    reconnect: async () => { reconnects += 1 }
  })
  await assert.rejects(
    () => selected.client.executeStatement('connection:c1', 'INSERT INTO t VALUES (1)'),
    /socket closed after write/
  )
  assert.equal(attempts, 1)
  assert.equal(reconnects, 0)
})

await check('HTTP selection 的低层 invoke 保留单次取消选项', async () => {
  const controller = new AbortController()
  let observedSignal
  const selected = createBackendClientSelection({
    mode: 'http',
    http: {
      endpoint: 'http://backend.test/rpc',
      fetch: async (_url, init) => {
        observedSignal = init.signal
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted by caller')), { once: true })
        })
      },
      requestId: () => 'selection-signal'
    }
  })
  const pending = selected.client.invoke?.('listDialects', [], { signal: controller.signal, timeoutMs: 1000 })
  assert.ok(pending)
  controller.abort()
  await assert.rejects(pending, /后端调用已取消/)
  assert.equal(typeof observedSignal?.aborted, 'boolean')
})

await check('认证失败进入 unauthorized 状态且不自动重试', async () => {
  let attempts = 0
  let reconnects = 0
  const selected = createBackendClientSelection({
    mode: 'http',
    http: {
      endpoint: 'http://backend.test/rpc',
      fetch: async (_url, init) => {
        attempts += 1
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({
            id: init.headers['x-dbstudio-request-id'],
            ok: false,
            error: { code: 'unauthorized', message: 'expired', retryable: false, callId: init.headers['x-dbstudio-request-id'] }
          })
        }
      },
      requestId: () => 'selection-auth'
    },
    reconnect: async () => { reconnects += 1 }
  })
  await assert.rejects(() => selected.client.listDialects(), /expired/)
  assert.equal(attempts, 1)
  assert.equal(reconnects, 0)
  assert.equal(selected.status.state, 'unauthorized')
})

console.log(`\n===== backend client selection：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exitCode = 1
