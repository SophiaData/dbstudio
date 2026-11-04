/**
 * HTTP server composition root 的隔离契约。
 *
 * 验证 principal → owner scope 的装配、remote manifest 的收窄，以及每个 owner
 * 的 SQL library / application state 不会互相读取。测试不启动真实 HTTP listener，
 * 只验证 listener 应该调用的 transport-neutral composition boundary。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-http-composition-'))
const bundle = join(outDir, 'composition.mjs')
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
      emptyOutDir: true,
      target: 'node22',
      ssr: true,
      lib: {
        entry: {
          composition: resolve(root, 'src/main/server/http-server-composition.ts')
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
  const { createHttpServerComposition } = await import(pathToFileURL(bundle).href)
  const baseDir = join(outDir, 'state')
  const cipherOwners = []
  const composition = createHttpServerComposition({
    dialects: [],
    baseDir,
    cipher: (ownerId) => {
      cipherOwners.push(ownerId)
      return null
    },
    onLog: () => undefined
  })

  const context = (ownerId, requestId = `req-${ownerId}`) => ({
    requestId,
    principal: { id: ownerId },
    signal: new AbortController().signal,
    receivedAt: Date.now()
  })

  await check('同一 principal 复用同一个 owner scope', () => {
    const first = composition.scopeFor({ id: 'owner-a' })
    const second = composition.scopeFor({ id: 'owner-a' })
    assert.strictEqual(first, second)
    assert.deepEqual(cipherOwners, ['owner-a'])
  })

  await check('不同 principal 获得独立 scope 与存储目录', () => {
    const ownerA = composition.scopeFor({ id: 'owner-a' })
    const ownerB = composition.scopeFor({ id: 'owner-b' })
    assert.notStrictEqual(ownerA, ownerB)
    assert.notStrictEqual(ownerA.manager, ownerB.manager)
    assert.notStrictEqual(ownerA.sqlLibrary, ownerB.sqlLibrary)
    assert.deepEqual(cipherOwners.sort(), ['owner-a', 'owner-b'])
  })

  await check('无 principal 的请求被拒绝', async () => {
    const response = await composition.dispatch({
      id: 'unauthenticated',
      method: 'listConnections',
      args: []
    })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'unauthorized')
    assert.equal(response.error.callId, 'unauthenticated')
  })

  await check('remote manifest 排除本机路径型导入导出方法', async () => {
    const response = await composition.dispatch(
      { id: 'remote-file', method: 'startTransfer', args: [{}] },
      context('owner-a', 'remote-file')
    )
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'unsupported')
  })

  await check('remote manifest 排除连接配置与探测方法', async () => {
    for (const method of ['addConnection', 'testConnection', 'updateConnection']) {
      const response = await composition.dispatch(
        { id: `remote-${method}`, method, args: [{}] },
        context('owner-a', `remote-${method}`)
      )
      assert.equal(response.ok, false)
      assert.equal(response.error.code, 'unsupported')
    }
  })

  await check('owner scope 的 runtime API 也不暴露 desktop 文件能力', () => {
    const api = composition.scopeFor({ id: 'owner-a' }).api
    assert.equal('startTransfer' in api, false)
    assert.equal('previewImport' in api, false)
    assert.equal('chooseImportFile' in api, false)
  })

  await check('owner A 的 SQL library 不会被 owner B 读取', async () => {
    const saved = await composition.dispatch(
      { id: 'save-a', method: 'saveSql', args: [null, 'A only', 'SELECT 1'] },
      context('owner-a', 'save-a')
    )
    assert.equal(saved.ok, true)
    const ownerB = await composition.dispatch(
      { id: 'list-b', method: 'listSqlLibrary', args: [] },
      context('owner-b', 'list-b')
    )
    assert.equal(ownerB.ok, true)
    assert.deepEqual(ownerB.value.saved, [])
  })

  await check('dispatcher 将 request context 的 principal 交给 scope resolver', async () => {
    const ownerA = await composition.dispatch(
      { id: 'list-a', method: 'listSqlLibrary', args: [] },
      context('owner-a', 'list-a')
    )
    assert.equal(ownerA.ok, true)
    assert.equal(ownerA.value.saved.length, 1)
    const ownerB = await composition.dispatch(
      { id: 'list-b-2', method: 'listSqlLibrary', args: [] },
      context('owner-b', 'list-b-2')
    )
    assert.equal(ownerB.ok, true)
    assert.equal(ownerB.value.saved.length, 0)
  })

  await composition.dispose()
  await check('dispose 后不再创建新的 owner scope', () => {
    assert.throws(
      () => composition.scopeFor({ id: 'owner-c' }),
      /HTTP server composition 已关闭/
    )
  })
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n===== HTTP server composition：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exitCode = 1
