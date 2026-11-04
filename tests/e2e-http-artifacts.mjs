/** owner 隔离 artifact store 与 HTTP route 的真实 localhost 契约测试。 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-http-artifacts-'))
const bundle = join(outDir, 'server.mjs')
const stateDir = join(outDir, 'state')
const content = Buffer.from('dbstudio artifact payload\n', 'utf8')
const sha256 = createHash('sha256').update(content).digest('hex')
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

try {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: false,
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
  // LocalArtifactStore 通过独立构建产物导入，测试不依赖 ts-node。
  const storeBundle = join(outDir, 'artifact-store.mjs')
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: false,
      target: 'node22',
      ssr: true,
      lib: {
        entry: {
          'artifact-store': resolve(root, 'src/main/server/artifact-store.ts')
        },
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.mjs`
      },
      rollupOptions: {
        external: [/^node:/]
      }
    }
  })
  const { LocalArtifactStore: ArtifactStore } = await import(pathToFileURL(storeBundle).href)

  await check('owner artifact 配额限制数量与总容量', async () => {
    const limited = new ArtifactStore({
      baseDir: join(stateDir, 'quota-owner'),
      maxBytes: 8,
      maxArtifacts: 1,
      maxTotalBytes: 8,
      maxConcurrentUploads: 1
    })
    await limited.createUploadTicket({ purpose: 'import-source', expectedBytes: 8 })
    await assert.rejects(
      () => limited.createUploadTicket({ purpose: 'import-source', expectedBytes: 1 }),
      (error) => error?.code === 'conflict'
    )

    const capacity = new ArtifactStore({
      baseDir: join(stateDir, 'capacity-owner'),
      maxBytes: 8,
      maxArtifacts: 2,
      maxTotalBytes: 8
    })
    await capacity.createUploadTicket({ purpose: 'import-source', expectedBytes: 8 })
    await assert.rejects(
      () => capacity.createUploadTicket({ purpose: 'import-source', expectedBytes: 1 }),
      (error) => error?.statusCode === 413
    )
  })

  await check('sweep 不删除活跃上传，TTL 到期后收口为 expired', async () => {
    let now = 0
    const active = new ArtifactStore({
      baseDir: join(stateDir, 'active-owner'),
      maxBytes: 8,
      maxConcurrentUploads: 1,
      now: () => now
    })
    const ticket = await active.createUploadTicket({
      purpose: 'import-source',
      expiresInMs: 1000,
      expectedBytes: 4
    })
    const secondTicket = await active.createUploadTicket({
      purpose: 'import-source',
      expiresInMs: 1000,
      expectedBytes: 4
    })
    let release
    const blocked = new Promise((resolve) => { release = resolve })
    const uploading = active.upload(ticket.artifact.artifactId, ticket.headers['x-dbstudio-artifact-ticket'].replace(/^Bearer /, ''), (async function* () {
      yield Buffer.from('data')
      await blocked
    })())
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        if ((await active.inspectArtifact(ticket.artifact.artifactId)).status === 'uploading') break
      } catch {
        // The upload has not persisted its state yet.
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal((await active.inspectArtifact(ticket.artifact.artifactId)).status, 'uploading')
    let concurrentError
    try {
      await active.upload(secondTicket.artifact.artifactId, secondTicket.headers['x-dbstudio-artifact-ticket'].replace(/^Bearer /, ''), Buffer.from('data'))
    } catch (error) {
      concurrentError = error
    }
    assert.equal(concurrentError?.code, 'conflict')
    assert.equal((await active.inspectArtifact(ticket.artifact.artifactId)).status, 'uploading')
    now = 2000
    await active.sweepExpired()
    assert.equal((await active.inspectArtifact(ticket.artifact.artifactId)).status, 'uploading')
    release()
    await assert.rejects(uploading, (error) => error?.code === 'timeout')
    assert.equal((await active.inspectArtifact(ticket.artifact.artifactId)).status, 'expired')
  })

  await check('DELETE 与 active upload 串行化，删除不会被 upload 覆盖', async () => {
    const race = new ArtifactStore({ baseDir: join(stateDir, 'race-owner'), maxBytes: 8 })
    const ticket = await race.createUploadTicket({ purpose: 'import-source', expectedBytes: 4 })
    let release
    const blocked = new Promise((resolve) => { release = resolve })
    const uploading = race.upload(ticket.artifact.artifactId, ticket.headers['x-dbstudio-artifact-ticket'].replace(/^Bearer /, ''), (async function* () {
      yield Buffer.from('data')
      await blocked
    })())
    await new Promise((resolve) => setImmediate(resolve))
    const deleting = race.deleteArtifact(ticket.artifact.artifactId)
    release()
    await Promise.all([uploading, deleting])
    await assert.rejects(
      () => race.inspectArtifact(ticket.artifact.artifactId),
      (error) => error?.code === 'not-found'
    )
  })

  await check('artifact store 启动立即 sweep，关闭停止定时器', async () => {
    let now = 0
    const lifecycle = new ArtifactStore({
      baseDir: join(stateDir, 'lifecycle-owner'),
      now: () => now,
      sweepIntervalMs: 10
    })
    const ticket = await lifecycle.createUploadTicket({ purpose: 'import-source', expiresInMs: 1000 })
    now = 2000
    lifecycle.startSweep()
    let removed = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        removed = (await lifecycle.inspectArtifact(ticket.artifact.artifactId)).status === 'expired'
      } catch (error) {
        removed = error?.code === 'not-found'
      }
      if (removed) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    lifecycle.dispose()
    assert.equal(removed, true)
  })

  const scopes = new Map()
  let disposed = 0
  const composition = {
    dispatch: async (request, context) => ({
      id: request.id,
      ok: true,
      value: { owner: context.principal.id, method: request.method }
    }),
    scopeFor(principal) {
      let scope = scopes.get(principal.id)
      if (!scope) {
        scope = {
          artifactStore: new ArtifactStore({ baseDir: join(stateDir, principal.id), maxBytes: 1024 }),
          dispose() {}
        }
        scopes.set(principal.id, scope)
      }
      return scope
    },
    async dispose() {
      disposed += 1
      for (const scope of scopes.values()) scope.artifactStore.dispose()
    }
  }
  const server = createHttpServer({
    composition,
    listen: { host: '127.0.0.1', port: 0 },
    resolvePrincipal: (request) => {
      const owner = request.headers['x-owner-id']
      return typeof owner === 'string' ? { id: owner } : null
    }
  })
  const address = await server.listen()
  const origin = `http://127.0.0.1:${address.port}`
  const auth = { 'x-owner-id': 'owner-a' }

  try {
    let uploadTicket
    await check('创建 import-source upload ticket', async () => {
      const response = await fetch(`${origin}/artifacts/upload-tickets`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'import-source',
          filename: 'rows.csv',
          mediaType: 'text/csv',
          expectedBytes: content.byteLength,
          expectedSha256: sha256
        })
      })
      assert.equal(response.status, 201)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const payload = await response.json()
      assert.equal(payload.ok, true)
      uploadTicket = payload.value
      assert.match(uploadTicket.artifact.artifactId, /^artifact_/)
      assert.equal(uploadTicket.artifact.status, 'pending')
      assert.equal(uploadTicket.method, 'PUT')
       assert.equal(uploadTicket.uploadUrl.includes('ticket='), false)
       assert.match(uploadTicket.headers['x-dbstudio-artifact-ticket'], /^Bearer /)
    })

    await check('upload route 拒绝 export-result 和路径型 filename', async () => {
      const exportResult = await fetch(`${origin}/artifacts/upload-tickets`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'export-result' })
      })
      assert.equal(exportResult.status, 400)
      assert.equal((await exportResult.json()).error.code, 'invalid-argument')

      const pathName = await fetch(`${origin}/artifacts/upload-tickets`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'import-source', filename: '../secret.csv' })
      })
      assert.equal(pathName.status, 400)
      assert.equal((await pathName.json()).error.code, 'invalid-argument')
    })

    await check('使用一次性 upload ticket 写入文件并计算摘要', async () => {
      const response = await fetch(new URL(uploadTicket.uploadUrl, origin), {
        method: 'PUT',
        headers: { ...auth, ...uploadTicket.headers },
        body: content
      })
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.ok, true)
      assert.equal(payload.value.status, 'ready')
      assert.equal(payload.value.sizeBytes, content.byteLength)
      assert.equal(payload.value.sha256, sha256)
    })

    const artifactId = uploadTicket.artifact.artifactId
    await check('owner 可以查询 metadata，其他 owner 看不到 artifact', async () => {
      const own = await fetch(`${origin}/artifacts/${artifactId}`, { headers: auth })
      assert.equal(own.status, 200)
      assert.equal((await own.json()).value.filename, 'rows.csv')

      const other = await fetch(`${origin}/artifacts/${artifactId}`, {
        headers: { 'x-owner-id': 'owner-b' }
      })
      assert.equal(other.status, 404)
      assert.equal((await other.json()).error.code, 'not-found')
    })

    let downloadTicket
    await check('创建 download ticket 并下载原始二进制内容', async () => {
      const ticketResponse = await fetch(`${origin}/artifacts/download-tickets/${artifactId}`, {
        method: 'POST',
        headers: auth
      })
      assert.equal(ticketResponse.status, 201)
      downloadTicket = (await ticketResponse.json()).value
       const ticketValue = downloadTicket.headers['x-dbstudio-artifact-ticket'].replace(/^Bearer /, '')
       const legacyQuery = await fetch(`${origin}${downloadTicket.downloadUrl}?ticket=${encodeURIComponent(ticketValue)}`, {
         headers: auth
       })
       assert.equal(legacyQuery.status, 401)
      const response = await fetch(new URL(downloadTicket.downloadUrl, origin), {
        headers: { ...auth, ...downloadTicket.headers }
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('content-type'), 'text/csv')
      assert.equal(response.headers.get('etag'), `"${sha256}"`)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), content)
    })

    await check('download ticket 只能使用一次', async () => {
      const response = await fetch(new URL(downloadTicket.downloadUrl, origin), {
        headers: { ...auth, ...downloadTicket.headers }
      })
      assert.equal(response.status, 401)
      assert.equal((await response.json()).error.code, 'unauthorized')
    })

    await check('删除 artifact 后 metadata 不再可读', async () => {
      const response = await fetch(`${origin}/artifacts/${artifactId}`, {
        method: 'DELETE',
        headers: auth
      })
      assert.equal(response.status, 200)
      const inspect = await fetch(`${origin}/artifacts/${artifactId}`, { headers: auth })
      assert.equal(inspect.status, 404)
    })

    await check('无 principal 时 artifact route 返回 401', async () => {
      const response = await fetch(`${origin}/artifacts/upload-tickets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'import-source' })
      })
      assert.equal(response.status, 401)
      assert.equal((await response.json()).error.code, 'unauthorized')
    })
  } finally {
    await server.close()
  }
  assert.equal(disposed, 1)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n===== HTTP artifact routes：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exitCode = 1
