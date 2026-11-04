/**
 * HTTP backend transport 的契约 / e2e 验证。
 *
 * ===== 这条测试锁住什么 =====
 *
 * 1. **可逆 wire 编码**：Uint8Array 经 JSON 往返后仍是 Uint8Array，
 *    嵌套值、undefined、以及恰好带 `$dbstudio` 键的业务对象都不能被误解码。
 * 2. **manifest 路由**：客户端只暴露 `BACKEND_METHOD_MANIFEST` 中的方法；
 *    dispatcher 对未知方法返回结构化失败，而不是去 `api[method]` 乱取属性。
 * 3. **结构化错误**：业务错误经 dispatcher → JSON → 客户端后仍保留
 *    `code` / `method` / `callId`，调用方不需要解析 message。
 * 4. **取消与超时**：注入的 fetch 能收到 AbortSignal；超时归类 `timeout`，
 *    调用方取消归类 `cancelled`。
 * 5. **真实 HTTP 往返**：用 Node `http` 起一个最小服务器，客户端直接注入
 *    全局 `fetch`，证明 transport 不依赖桌面 shell，也不绑定测试替身。
 *
 * ===== 为什么用 Vite =====
 *
 * 源文件是 TypeScript。项目已有 vite 依赖，且有现成的后端契约测试用同样
 * 方式打包；这里把整个 transport barrel 打成一个 ESM 产物，避免多个 bundle
 * 各自内联一份 `BackendError` 导致 `instanceof` 假阴性。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-http-transport-'))
const bundle = join(outDir, 'transport.mjs')

let pass = 0
let fail = 0

async function check(name, run) {
  try {
    await run()
    pass += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    fail += 1
    console.log(
      `  ❌ ${name} — ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  }
}

try {
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
        entry: {
          transport: resolve(root, 'src/backend/transport/index.ts')
        },
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.mjs`
      }
    }
  })

  check('Vite 产出可导入的 transport 产物', () => {
    assert.ok(existsSync(bundle), `未找到 ${bundle}`)
  })

  const transport = await import(pathToFileURL(bundle).href)
  const {
    createHttpBackendClient,
    createBackendDispatcher,
    createJsonBackendDispatcher,
    encodeWireValue,
    decodeWireValue,
    encodeBackendRequest,
    decodeBackendRequest,
    encodeBackendResponse,
    decodeBackendResponse,
    stringifyBackendRequest,
    parseBackendRequest,
    stringifyBackendResponse,
    parseBackendResponse,
    bytesToBase64,
    base64ToBytes,
    WireCodecError
  } = transport

  // ---- 测试用后端 ----
  const backendCalls = []
  const fakeApi = {
    listConnections: async () => [{ id: 'c1', name: 'Local' }],
    describeTable: async (nodeId) => {
      backendCalls.push({ method: 'describeTable', nodeId })
      throw { code: 'not-found', message: '表不存在', details: { nodeId } }
    },
    runQuery: async (nodeId, sql) => {
      backendCalls.push({ method: 'runQuery', nodeId, sql })
      return new Uint8Array([0, 1, 2, 255])
    },
    removeConnection: async (connectionId) => {
      backendCalls.push({ method: 'removeConnection', connectionId })
    }
  }

  console.log('\n[1] wire 编解码：二进制与 JSON 边界')

  await check('Uint8Array 顶层往返保持字节与类型', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255])
    const encoded = encodeWireValue(bytes)
    assert.deepEqual(encoded, { $dbstudio: 'u8', data: 'AAECf4D/' })
    const jsonRoundTrip = JSON.parse(JSON.stringify(encoded))
    const decoded = decodeWireValue(jsonRoundTrip)
    assert.ok(decoded instanceof Uint8Array)
    assert.deepEqual([...decoded], [...bytes])
  })

  await check('嵌套 Uint8Array（对象 / 数组）可逆', () => {
    const value = {
      columns: ['blob'],
      rows: [{ cells: [new Uint8Array([9, 8, 7]), { kind: 'null' }] }],
      empty: new Uint8Array(0)
    }
    const decoded = decodeWireValue(JSON.parse(JSON.stringify(encodeWireValue(value))))
    assert.deepEqual(decoded.columns, ['blob'])
    assert.ok(decoded.rows[0].cells[0] instanceof Uint8Array)
    assert.deepEqual([...decoded.rows[0].cells[0]], [9, 8, 7])
    assert.deepEqual(decoded.rows[0].cells[1], { kind: 'null' })
    assert.equal(decoded.empty.length, 0)
  })

  await check('undefined / bigint 往返', () => {
    assert.equal(decodeWireValue(encodeWireValue(undefined)), undefined)
    assert.equal(decodeWireValue(encodeWireValue(10n)), 10n)
    const decoded = decodeWireValue(
      JSON.parse(JSON.stringify(encodeWireValue([undefined, 1n])))
    )
    assert.equal(decoded[0], undefined)
    assert.equal(decoded[1], 1n)
  })

  await check('恰好带 $dbstudio 键的业务对象不会被误判为二进制', () => {
    const value = { $dbstudio: 'u8', data: 'AAEC', nested: { $dbstudio: 'object', data: 1 } }
    const decoded = decodeWireValue(JSON.parse(JSON.stringify(encodeWireValue(value))))
    assert.deepEqual(decoded, value)
    assert.equal(decoded instanceof Uint8Array, false)
  })

  await check('__proto__ 作为普通自有属性还原，不污染原型', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"safe":1}')
    const decoded = decodeWireValue(JSON.parse(JSON.stringify(encodeWireValue(input))))
    assert.equal({}.polluted, undefined)
    assert.equal(Object.prototype.hasOwnProperty.call(decoded, '__proto__'), true)
    assert.deepEqual(decoded.__proto__, { polluted: true })
    assert.equal(decoded.safe, 1)
  })

  await check('base64 非法输入被拒绝', () => {
    assert.throws(() => base64ToBytes('abc'), WireCodecError)
    assert.throws(() => base64ToBytes('!!!!'), WireCodecError)
    assert.deepEqual([...base64ToBytes(bytesToBase64(new Uint8Array([1, 2, 3])))], [1, 2, 3])
  })

  await check('请求 / 响应 JSON 往返保持 id、method、args 与二进制', () => {
    const request = {
      id: 'req-1',
      method: 'runQuery',
      args: ['connection:c1', 'select blob', { blob: new Uint8Array([4, 5, 6]) }]
    }
    const parsed = parseBackendRequest(stringifyBackendRequest(request))
    assert.equal(parsed.id, 'req-1')
    assert.equal(parsed.method, 'runQuery')
    assert.equal(parsed.args[0], 'connection:c1')
    assert.ok(parsed.args[2].blob instanceof Uint8Array)
    assert.deepEqual([...parsed.args[2].blob], [4, 5, 6])

    const success = parseBackendResponse(
      stringifyBackendResponse({
        id: 'req-1',
        ok: true,
        value: { bytes: new Uint8Array([7, 8]) }
      })
    )
    assert.equal(success.ok, true)
    assert.ok(success.value.bytes instanceof Uint8Array)
    assert.deepEqual([...success.value.bytes], [7, 8])

    const failure = parseBackendResponse(
      stringifyBackendResponse({
        id: 'req-2',
        ok: false,
        error: { code: 'conflict', message: '并发修改', retryable: true }
      })
    )
    assert.equal(failure.ok, false)
    assert.equal(failure.error.code, 'conflict')
    assert.equal(failure.error.retryable, true)
  })

  await check('非法 wire 请求 / 响应被拒绝', () => {
    assert.throws(() => decodeBackendRequest(null), WireCodecError)
    assert.throws(() => decodeBackendRequest({ id: '', method: 'x', args: [] }), WireCodecError)
    assert.throws(() => decodeBackendRequest({ id: '1', method: 'x', args: {} }), WireCodecError)
    assert.throws(() => parseBackendRequest('{not json'), WireCodecError)
    assert.throws(
      () => decodeBackendResponse({ id: '1', ok: false, error: { code: 'bogus', message: 'x' } }),
      WireCodecError
    )
    assert.throws(() => decodeBackendResponse({ id: '1', ok: true }), WireCodecError)
  })

  console.log('\n[2] dispatcher：manifest 路由与结构化错误')

  const dispatch = createBackendDispatcher({ api: fakeApi })

  await check('已知方法按 manifest 路由并回带请求 id', async () => {
    const response = await dispatch({ id: 'd-1', method: 'listConnections', args: [] })
    assert.deepEqual(response, { id: 'd-1', ok: true, value: [{ id: 'c1', name: 'Local' }] })
  })

  await check('未知方法返回 unsupported，且不会触碰 api 属性', async () => {
    const response = await dispatch({ id: 'd-2', method: 'dropDatabase', args: [] })
    assert.equal(response.ok, false)
    assert.equal(response.id, 'd-2')
    assert.equal(response.error.code, 'unsupported')
    assert.match(response.error.message, /dropDatabase/)
  })

  await check('methods 选项只能收窄，不能引入 manifest 之外的方法', async () => {
    const narrowed = createBackendDispatcher({
      api: fakeApi,
      methods: ['listConnections', 'dropDatabase']
    })
    const allowed = await narrowed({ id: 'n-1', method: 'listConnections', args: [] })
    assert.equal(allowed.ok, true)
    const rejected = await narrowed({ id: 'n-2', method: 'describeTable', args: ['x'] })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error.code, 'unsupported')
    const bogus = await narrowed({ id: 'n-3', method: 'dropDatabase', args: [] })
    assert.equal(bogus.error.code, 'unsupported')
  })

  await check('同步 throw / 业务错误保留 code、method、callId', async () => {
    const response = await dispatch({ id: 'd-3', method: 'describeTable', args: ['connection:c1|table:x'] })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'not-found')
    assert.equal(response.error.message, '表不存在')
    assert.equal(response.error.method, 'describeTable')
    assert.equal(response.error.callId, 'd-3')
    assert.deepEqual(response.error.details, { nodeId: 'connection:c1|table:x' })
  })

  await check('非法请求体返回 invalid-argument，不抛异常', async () => {
    for (const bad of [null, 'text', { id: 'x' }, { id: 'x', method: 'runQuery', args: 'no' }]) {
      const response = await dispatch(bad)
      assert.equal(response.ok, false)
      assert.equal(response.error.code, 'invalid-argument')
    }
  })

  await check('JSON dispatcher：字符串进 / 字符串出', async () => {
    const jsonDispatch = createJsonBackendDispatcher(dispatch)
    const okBody = await jsonDispatch(
      JSON.stringify({ id: 'j-1', method: 'listConnections', args: [] })
    )
    const okResponse = parseBackendResponse(okBody)
    assert.equal(okResponse.id, 'j-1')
    assert.equal(okResponse.ok, true)

    const badBody = await jsonDispatch('{not json')
    const badResponse = parseBackendResponse(badBody)
    assert.equal(badResponse.ok, false)
    assert.equal(badResponse.error.code, 'invalid-argument')
  })

  console.log('\n[3] HTTP client：POST / request id / 错误信封')

  let requestSeq = 0
  const nextId = () => `req-${++requestSeq}`
  const seen = []

  function makeFetch(dispatchFn, options = {}) {
    return async (url, init) => {
      seen.push({ url, init })
      if (options.onFetch) return options.onFetch(url, init)
      const parsed = JSON.parse(init.body)
      const response = await dispatchFn(parsed)
      return jsonResponse(encodeBackendResponse(response), options.status ?? 200)
    }
  }

  const endpoint = 'https://dbstudio.test/rpc'
  const client = createHttpBackendClient({
    endpoint,
    fetch: makeFetch(dispatch),
    requestId: nextId,
    timeoutMs: 1_000,
    headers: { authorization: 'Bearer test-token' }
  })

  await check('标准 BackendApi 方法可用，返回业务值', async () => {
    const connections = await client.listConnections()
    assert.deepEqual(connections, [{ id: 'c1', name: 'Local' }])
  })

  await check('请求是 POST JSON，并带 request id / 自定义头', () => {
    const last = seen.at(-1)
    assert.equal(last.url, endpoint)
    assert.equal(last.init.method, 'POST')
    assert.equal(last.init.headers['content-type'], 'application/json')
    assert.equal(last.init.headers.accept, 'application/json')
    assert.equal(last.init.headers.authorization, 'Bearer test-token')
    const body = JSON.parse(last.init.body)
    assert.equal(body.method, 'listConnections')
    assert.deepEqual(body.args, [])
    assert.equal(body.id, last.init.headers['x-dbstudio-request-id'])
    assert.match(body.id, /^req-\d+$/)
  })

  await check('Uint8Array 返回值经 HTTP JSON 往返仍是 Uint8Array', async () => {
    const value = await client.runQuery('connection:c1', 'select blob')
    assert.ok(value instanceof Uint8Array)
    assert.deepEqual([...value], [0, 1, 2, 255])
  })

  await check('失败信封还原成 BackendError，保留分类', async () => {
    await assert.rejects(
      () => client.describeTable('connection:c1|table:x'),
      (error) => {
        assert.equal(error.name, 'BackendError')
        assert.equal(error.code, 'not-found')
        assert.equal(error.message, '表不存在')
        assert.equal(error.method, 'describeTable')
        assert.match(error.callId, /^req-\d+$/)
        assert.deepEqual(error.details, { nodeId: 'connection:c1|table:x' })
        return true
      }
    )
  })

  await check('void 返回值可往返', async () => {
    assert.equal(await client.removeConnection('c1'), undefined)
  })

  await check('manifest 之外的属性不存在，invoke 也拒绝', async () => {
    assert.equal(client.dropDatabase, undefined)
    assert.equal(client.chooseImportFile, undefined)
    assert.equal('dropDatabase' in client, false)
    assert.equal('chooseImportFile' in client, false)
    assert.equal('listConnections' in client, true)
    await assert.rejects(
      () => client.invoke('dropDatabase', []),
      (error) => error.code === 'unsupported'
    )
  })

  console.log('\n[4] HTTP client：取消、超时与传输失败')

  await check('超时归类为 timeout', async () => {
    const hangingFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    const timeoutClient = createHttpBackendClient({
      endpoint,
      fetch: hangingFetch,
      timeoutMs: 25,
      requestId: () => 'timeout-req'
    })
    await assert.rejects(
      () => timeoutClient.listConnections(),
      (error) => {
        assert.equal(error.name, 'BackendError')
        assert.equal(error.code, 'timeout')
        assert.equal(error.method, 'listConnections')
        assert.equal(error.callId, 'timeout-req')
        assert.deepEqual(error.details, { timeoutMs: 25 })
        return true
      }
    )
  })

  await check('调用方 AbortSignal 在途取消归类为 cancelled', async () => {
    const hangingFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    const cancelClient = createHttpBackendClient({
      endpoint,
      fetch: hangingFetch,
      timeoutMs: 0,
      requestId: () => 'cancel-req'
    })
    const controller = new AbortController()
    const pending = cancelClient.invoke('listConnections', [], {
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'cancelled')
      assert.equal(error.callId, 'cancel-req')
      return true
    })
  })

  await check('已取消的 signal 不会发起请求', async () => {
    let called = false
    const cancelClient = createHttpBackendClient({
      endpoint,
      fetch: async () => {
        called = true
        return jsonResponse({ ok: true, value: [] })
      }
    })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => cancelClient.invoke('listConnections', [], { signal: controller.signal }),
      (error) => error.code === 'cancelled'
    )
    assert.equal(called, false)
  })

  await check('网络异常归类为 transport-failed 并保留原因', async () => {
    const failingClient = createHttpBackendClient({
      endpoint,
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    await assert.rejects(
      () => failingClient.listConnections(),
      (error) => {
        assert.equal(error.code, 'transport-failed')
        assert.match(error.message, /ECONNREFUSED/)
        return true
      }
    )
  })

  await check('非 JSON 响应 / id 不匹配 / 非 2xx 成功信封都判为 transport-failed', async () => {
    const htmlClient = createHttpBackendClient({
      endpoint,
      fetch: async () => ({ ok: true, status: 200, text: async () => '<html>oops</html>' })
    })
    await assert.rejects(() => htmlClient.listConnections(), (error) => error.code === 'transport-failed')

    const mismatchClient = createHttpBackendClient({
      endpoint,
      requestId: () => 'expected-id',
      fetch: async () => jsonResponse({ id: 'other-id', ok: true, value: [] })
    })
    await assert.rejects(
      () => mismatchClient.listConnections(),
      (error) => {
        assert.equal(error.code, 'transport-failed')
        assert.deepEqual(error.details, { expected: 'expected-id', actual: 'other-id' })
        return true
      }
    )

    const successOn500 = createHttpBackendClient({
      endpoint,
      fetch: async (_url, init) =>
        jsonResponse(
          { id: JSON.parse(init.body).id, ok: true, value: [] },
          500
        )
    })
    await assert.rejects(() => successOn500.listConnections(), (error) => error.code === 'transport-failed')
  })

  await check('失败信封优先于 HTTP 状态码（401 保留 unauthorized）', async () => {
    const unauthorizedClient = createHttpBackendClient({
      endpoint,
      requestId: () => 'auth-req',
      fetch: async () =>
        jsonResponse(
          {
            id: 'auth-req',
            ok: false,
            error: { code: 'unauthorized', message: '缺少凭据', method: 'listConnections' }
          },
          401
        )
    })
    await assert.rejects(
      () => unauthorizedClient.listConnections(),
      (error) => error.code === 'unauthorized' && error.callId === 'auth-req'
    )
  })

  console.log('\n[5] 真实 HTTP 服务器往返（注入全局 fetch）')

  await check('Node http server 上完成 query / binary / error 全链路', async () => {
    if (typeof globalThis.fetch !== 'function') {
      console.log('    （跳过：当前 Node 没有全局 fetch）')
      return
    }

    const jsonDispatch = createJsonBackendDispatcher(dispatch)
    const server = createServer((request, response) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf8')
        // 只验证传输语义，不引入 Express 等框架。
        const payload = await jsonDispatch(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(payload)
      })
    })

    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', resolveListen)
    })

    try {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      assert.ok(port > 0, '服务器未监听端口')

      const httpClient = createHttpBackendClient({
        endpoint: `http://127.0.0.1:${port}/rpc`,
        fetch: globalThis.fetch,
        timeoutMs: 5_000,
        requestId: () => `real-${++requestSeq}`
      })

      const connections = await httpClient.listConnections()
      assert.deepEqual(connections, [{ id: 'c1', name: 'Local' }])

      const binary = await httpClient.runQuery('connection:c1', 'select blob')
      assert.ok(binary instanceof Uint8Array)
      assert.deepEqual([...binary], [0, 1, 2, 255])

      await assert.rejects(
        () => httpClient.describeTable('connection:c1|table:x'),
        (error) => error.code === 'not-found' && error.method === 'describeTable'
      )
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  })
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n===== HTTP transport 契约：${pass} 通过 / ${fail} 失败 =====`)
process.exitCode = fail > 0 ? 1 : 0
