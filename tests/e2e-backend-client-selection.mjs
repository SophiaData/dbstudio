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
  const api = Object.freeze({ listDialects: async () => [] })
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
  const config = { dialectId: 'postgresql', name: 'remote', options: { host: 'db.example.test', port: 5432 } }
  const secret = { dbPassword: 'opaque-test-secret' }
  const result = await selected.client.addConnection(config, secret)
  assert.equal(result.id, 'c1')
  await selected.client.testConnection(config, secret)
  await selected.client.updateConnection('a/b', config, secret)
  assert.deepEqual(requests, [
    { url: 'http://backend.test/connections', method: 'POST', body: { config, secret } },
    { url: 'http://backend.test/connections/test', method: 'POST', body: { config, secret } },
    { url: 'http://backend.test/connections/a%2Fb', method: 'PATCH', body: { config, secretPatch: secret } }
  ])
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
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const selected = createBackendClientSelection({
    mode: 'http',
    http: {
      endpoint: 'http://backend.test/rpc',
      fetch: async (_url, init) => {
        observedSignal = init.signal
        markStarted()
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted by caller')), { once: true })
        })
      },
      requestId: () => 'selection-signal'
    }
  })
  const pending = selected.client.invoke?.('listDialects', [], { signal: controller.signal, timeoutMs: 1000 })
  assert.ok(pending)
  await started
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

await check('RPC 和 connection routes 首次发送即获取最新 session headers', async () => {
  let sessionVersion = 0
  const observed = []
  const selected = createBackendClientSelection({
    mode: 'http',
    http: {
      endpoint: 'https://backend.test/rpc',
      getHeaders: async () => ({ authorization: `Bearer fixture-session-${++sessionVersion}` }),
      fetch: async (url, init) => {
        observed.push({ url, authorization: init.headers.authorization })
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: init.headers['x-dbstudio-request-id'], ok: true, value: [] }) }
      }
    }
  })
  await selected.client.listConnections()
  await selected.client.listDialects()
  assert.equal(observed.length, 2)
  assert.equal(observed[0].authorization, 'Bearer fixture-session-1')
  assert.equal(observed[1].authorization, 'Bearer fixture-session-2')
})

await check('每个 connection mutation 网络中断均只发送一次', async () => {
  for (const invoke of [
    (api) => api.addConnection({}, {}),
    (api) => api.testConnection({}, {}),
    (api) => api.updateConnection('c1', {}, {}),
    (api) => api.connectConnection('c1'),
    (api) => api.disconnectConnection('c1'),
    (api) => api.removeConnection('c1')
  ]) {
    let calls = 0
    const selected = createBackendClientSelection({
      mode: 'http',
      http: { endpoint: 'https://backend.test/rpc', fetch: async () => { calls += 1; throw new Error('lost response') } },
      reconnect: async () => { throw new Error('must not reconnect mutation') }
    })
    await assert.rejects(() => invoke(selected.client), /lost response/)
    assert.equal(calls, 1)
  }
})

await check('session provider 错误脱敏，超时或取消时不发送请求', async () => {
  const selected = createBackendClientSelection({
    mode: 'http',
    http: {
      endpoint: 'https://backend.test/rpc',
      getHeaders: async () => { throw new Error('fixture-private-claims') },
      fetch: async () => { throw new Error('must not send') }
    }
  })
  await assert.rejects(() => selected.client.listConnections(), (error) =>
    error.code === 'unauthorized' && !error.message.includes('fixture-private-claims'))
  const timed = createBackendClientSelection({
    mode: 'http',
    http: { endpoint: 'https://backend.test/rpc', timeoutMs: 10, getHeaders: async () => new Promise(() => {}), fetch: async () => { throw new Error('must not send') } }
  })
  await assert.rejects(() => timed.client.listConnections(), (error) => error.code === 'timeout')
})

console.log(`\n===== backend client selection：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exitCode = 1
