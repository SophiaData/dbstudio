/**
 * Node HTTP handler 的请求防护契约。
 *
 * 覆盖认证入口、body/response 限制、并发额度、request id 校验以及客户端断连
 * 对 request context AbortSignal 的传播。测试不依赖数据库或真实认证服务。
 */

import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-http-handler-'))
const bundle = join(outDir, 'handler.mjs')
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

function start(handler) {
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('无法取得 HTTP 测试端口'))
        return
      }
      resolveServer({ server, url: `http://127.0.0.1:${address.port}/rpc` })
    })
  })
}

async function readJson(response) {
  return response.json()
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
          handler: resolve(root, 'src/main/server/http-server-handler.ts')
        },
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.mjs`
      },
      rollupOptions: {
        external: [/^node:/]
      }
    }
  })

  assert.ok(existsSync(bundle), `未找到 ${bundle}`)
  const { createHttpServerHandler } = await import(pathToFileURL(bundle).href)
  const contexts = []
  const composition = {
    dispatch: async (request, context) => {
      contexts.push({ request, context })
      if (request.id === 'large-response') {
        return { id: request.id, ok: true, value: 'x'.repeat(400) }
      }
      return {
        id: request.id,
        ok: true,
        value: { owner: context.principal.id, method: request.method }
      }
    }
  }
  const handler = createHttpServerHandler({
    composition,
    resolvePrincipal: (request) => {
      const owner = request.headers['x-owner-id']
      return typeof owner === 'string' ? { id: owner } : null
    },
    maxBodyBytes: 256,
    maxResponseBytes: 256
  })
  const active = await start(handler)

  try {
    await check('认证 principal 进入 request context 并完成 JSON 往返', async () => {
      const response = await fetch(active.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-owner-id': 'owner-a',
          'x-dbstudio-request-id': 'valid-1'
        },
        body: JSON.stringify({ id: 'valid-1', method: 'listDialects', args: [] })
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await readJson(response), {
        id: 'valid-1',
        ok: true,
        value: { owner: 'owner-a', method: 'listDialects' }
      })
      assert.equal(contexts.at(-1).context.principal.id, 'owner-a')
      assert.equal(contexts.at(-1).context.requestId, 'valid-1')
    })

    await check('缺少 principal 时在读取 body 前返回 401', async () => {
      const response = await fetch(active.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'unauth', method: 'listDialects', args: [] })
      })
      assert.equal(response.status, 401)
      const payload = await readJson(response)
      assert.equal(payload.ok, false)
      assert.equal(payload.error.code, 'unauthorized')
    })

    await check('拒绝错误 method 与非 JSON content-type', async () => {
      const get = await fetch(active.url, { headers: { 'x-owner-id': 'owner-a' } })
      assert.equal(get.status, 405)
      const text = await get.text()
      assert.match(text, /unsupported/)

      const contentType = await fetch(active.url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-owner-id': 'owner-a' },
        body: '{}'
      })
      assert.equal(contentType.status, 415)
    })

    await check('超过 body 上限时返回 413 且不进入 dispatcher', async () => {
      const before = contexts.length
      const response = await fetch(active.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-owner-id': 'owner-a',
          'x-dbstudio-request-id': 'too-large'
        },
        body: JSON.stringify({ id: 'too-large', method: 'listDialects', args: ['x'.repeat(500)] })
      })
      assert.equal(response.status, 413)
      assert.equal(contexts.length, before)
    })

    await check('header request id 与 body id 不一致时返回 400', async () => {
      const response = await fetch(active.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-owner-id': 'owner-a',
          'x-dbstudio-request-id': 'header-id'
        },
        body: JSON.stringify({ id: 'body-id', method: 'listDialects', args: [] })
      })
      assert.equal(response.status, 400)
      const payload = await readJson(response)
      assert.equal(payload.error.code, 'invalid-argument')
    })

    await check('超过 response 上限时返回受控 internal error', async () => {
      const response = await fetch(active.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-owner-id': 'owner-a',
          'x-dbstudio-request-id': 'large-response'
        },
        body: JSON.stringify({ id: 'large-response', method: 'listDialects', args: [] })
      })
      assert.equal(response.status, 500)
      const payload = await readJson(response)
      assert.equal(payload.error.code, 'internal')
    })
  } finally {
    await new Promise((resolveClose) => active.server.close(resolveClose))
  }

  await check('并发额度阻止超额请求并允许已占用请求完成', async () => {
    let releaseFirst
    let firstStarted
    const started = new Promise((resolveStarted) => {
      firstStarted = resolveStarted
    })
    const quotaHandler = createHttpServerHandler({
      composition: {
        dispatch: async (request) => {
          if (request.id === 'first') {
            firstStarted()
            await new Promise((resolveRelease) => {
              releaseFirst = resolveRelease
            })
          }
          return { id: request.id, ok: true, value: request.id }
        }
      },
      resolvePrincipal: () => ({ id: 'owner-a' }),
      maxConcurrentRequests: 1
    })
    const quotaServer = await start(quotaHandler)
    try {
      const first = fetch(quotaServer.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dbstudio-request-id': 'first'
        },
        body: JSON.stringify({ id: 'first', method: 'listDialects', args: [] })
      })
      await started
      const second = await fetch(quotaServer.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dbstudio-request-id': 'second'
        },
        body: JSON.stringify({ id: 'second', method: 'listDialects', args: [] })
      })
      assert.equal(second.status, 429)
      assert.equal((await second.json()).error.code, 'conflict')
      releaseFirst()
      const firstResponse = await first
      assert.equal(firstResponse.status, 200)
    } finally {
      releaseFirst?.()
      await new Promise((resolveClose) => quotaServer.server.close(resolveClose))
    }
  })

  await check('客户端断连会 abort request context signal', async () => {
    let signalAborted
    let dispatchStarted
    const started = new Promise((resolveStarted) => {
      dispatchStarted = resolveStarted
    })
    const aborted = new Promise((resolveAborted) => {
      signalAborted = resolveAborted
    })
    const disconnectHandler = createHttpServerHandler({
      composition: {
        dispatch: async (request, context) => {
          dispatchStarted()
          await new Promise((resolveDispatch) => {
            const finish = () => {
              resolveDispatch()
              signalAborted(true)
            }
            if (context.signal.aborted) finish()
            else context.signal.addEventListener('abort', finish, { once: true })
          })
          return {
            id: request.id,
            ok: false,
            error: { code: 'cancelled', message: 'client disconnected' }
          }
        }
      },
      resolvePrincipal: () => ({ id: 'owner-a' })
    })
    const disconnectServer = await start(disconnectHandler)
    try {
      const address = disconnectServer.server.address()
      const client = httpRequest({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/rpc',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(JSON.stringify({ id: 'disconnect', method: 'listDialects', args: [] }))
        }
      })
      client.on('error', () => undefined)
      client.end(JSON.stringify({ id: 'disconnect', method: 'listDialects', args: [] }))
      await started
      client.destroy()
      await Promise.race([
        aborted,
        new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error('断连 signal 未触发')), 1000))
      ])
    } finally {
      await new Promise((resolveClose) => disconnectServer.server.close(resolveClose))
    }
  })
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n===== HTTP server handler：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exitCode = 1
