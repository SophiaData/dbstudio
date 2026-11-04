/** 可启动 HTTP server 的真实 localhost 生命周期契约测试。 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-http-server-'))
const bundle = join(outDir, 'server.mjs')
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

async function fetchRpc(url, requestId = 'server-test') {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-owner-id': 'owner-a',
      'x-dbstudio-request-id': requestId
    },
    body: JSON.stringify({ id: requestId, method: 'listDialects', args: [] })
  })
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
          server: resolve(root, 'src/main/server/http-server.ts')
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
  const { createHttpServer } = await import(pathToFileURL(bundle).href)
  let disposed = 0
  const composition = {
    dispatch: async (request, context) => ({
      id: request.id,
      ok: true,
      value: { owner: context.principal.id, method: request.method }
    }),
    async dispose() {
      disposed += 1
    }
  }

  await check('监听 localhost 临时端口并完成真实 JSON 往返', async () => {
    const server = createHttpServer({
      composition,
      listen: { host: '127.0.0.1', port: 0 },
      resolvePrincipal: (request) => {
        const owner = request.headers['x-owner-id']
        return typeof owner === 'string' ? { id: owner } : null
      }
    })
    const address = await server.listen()
    assert.equal(address.address, '127.0.0.1')
    assert.ok(address.port > 0)
    assert.deepEqual(server.address, address)

    const response = await fetchRpc(`http://127.0.0.1:${address.port}/rpc`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      id: 'server-test',
      ok: true,
      value: { owner: 'owner-a', method: 'listDialects' }
    })
    await server.close()
    assert.equal(server.address, null)
  })

  await check('close 幂等且释放 composition 一次', async () => {
    const server = createHttpServer({
      composition,
      listen: { port: 0 },
      resolvePrincipal: () => ({ id: 'owner-a' })
    })
    await server.listen()
    await Promise.all([server.close(), server.close()])
    assert.equal(disposed, 2)
    await assert.rejects(server.listen(), /HTTP server 已关闭/)
  })

  await check('close grace 超时后强制关闭挂起连接', async () => {
    let release
    let started
    const requestStarted = new Promise((resolveStarted) => { started = resolveStarted })
    const pending = new Promise((resolvePending) => { release = resolvePending })
    const server = createHttpServer({
      composition: {
        dispatch: async (request, context) => {
          if (request.id === 'grace-close') {
            started()
            await pending
          }
          return { id: request.id, ok: true, value: context.signal.aborted ? 'aborted' : 'done' }
        },
        dispose: async () => undefined
      },
      listen: { port: 0 },
      closeGraceMs: 25,
      resolvePrincipal: () => ({ id: 'owner-a' })
    })
    const address = await server.listen()
    const request = fetchRpc(`http://127.0.0.1:${address.port}/rpc`, 'grace-close').catch(() => undefined)
    await requestStarted
    await Promise.race([
      server.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close grace 未生效')), 1000))
    ])
    release()
    await request
    assert.equal(server.address, null)
  })

  await check('未提供 principal 时真实 listener 返回 401', async () => {
    const server = createHttpServer({
      composition,
      listen: { port: 0 },
      resolvePrincipal: () => null
    })
    const address = await server.listen()
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'unauthorized', method: 'listDialects', args: [] })
      })
      assert.equal(response.status, 401)
      assert.equal((await response.json()).error.code, 'unauthorized')
    } finally {
      await server.close()
    }
  })

  await check('监听参数拒绝无效端口', () => {
    assert.throws(
      () => createHttpServer({ composition, listen: { port: 65536 }, resolvePrincipal: () => ({ id: 'a' }) }),
      /port 必须是 0 到 65535/
    )
  })
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n===== HTTP server：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exitCode = 1
