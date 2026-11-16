/**
 * artifact 原子写 rename 的 Windows EPERM 回归。
 *
 * 背景：Windows 的 MoveFileEx 在目标文件正被其它句柄打开时返回 EPERM；
 * 并发 readFile metadata 与 upload 的 tmp→final 改名会稳定命中，导致上传失败。
 * 修复要求：只在 Windows 对 EPERM/EBUSY/EACCES 做有界退避重试（5/10/20/40/80ms），
 * 耗尽后抛出原始错误；同路径的 metadata 读写互斥，消除 store 自身持柄冲突。
 *
 * 注入方式：构建 `artifact-store.ts` 后把产物里的 `node:fs/promises` import 重定向到
 * 测试内 shim（同一 URL 被测试和产物共同导入），由测试控制 rename 抛错并记录每次
 * tmp→final 尝试；真实持柄用例不注入错误，直接打开目标文件句柄制造 EPERM。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-artifact-write-atomicity-'))
const bundle = join(outDir, 'artifact-store.mjs')
const shimPath = join(outDir, 'fs-promises-hook.mjs')

let pass = 0
let fail = 0
const check = async (name, run) => {
  try {
    await run()
    pass += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  ❌ ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const EPERM_DELAYS_MS = [5, 10, 20, 40, 80]

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function tokenOf(ticket) {
  return ticket.headers['x-dbstudio-artifact-ticket'].replace(/^Bearer /, '')
}

function injectedError(code) {
  return Object.assign(new Error(`injected ${code}`), { code, syscall: 'rename' })
}

const SHIM_SOURCE = `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const real = require('node:fs/promises')
let hook = null
export const renameCalls = []
export function setRenameHook(next) { hook = next ?? null }
export function resetRenameCalls() { renameCalls.length = 0 }
export function realRename(from, to) { return real.rename(from, to) }
export async function rename(from, to) {
  const call = { from, to, at: Date.now(), error: null }
  renameCalls.push(call)
  try {
    if (hook) return await hook(from, to, call)
    return await real.rename(from, to)
  } catch (error) {
    call.error = error?.code ?? 'unknown'
    throw error
  }
}
export const lstat = (...args) => real.lstat(...args)
export const mkdir = (...args) => real.mkdir(...args)
export const readFile = (...args) => real.readFile(...args)
export const readdir = (...args) => real.readdir(...args)
export const rm = (...args) => real.rm(...args)
export const stat = (...args) => real.stat(...args)
export const writeFile = (...args) => real.writeFile(...args)
`

try {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(shimPath, SHIM_SOURCE, 'utf8')
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

  const original = readFileSync(bundle, 'utf8')
  const shimUrl = JSON.stringify(pathToFileURL(shimPath).href)
  const patched = original.replace(/(from\s*)(['"])node:fs\/promises\2/g, `$1${shimUrl}`)
  assert.notEqual(patched, original, '未能在构建产物中定位 node:fs/promises import，无法注入 rename')
  writeFileSync(bundle, patched, 'utf8')

  const { LocalArtifactStore: ArtifactStore } = await import(pathToFileURL(bundle).href)
  const shim = await import(pathToFileURL(shimPath).href)

  const stateDir = join(outDir, 'state')
  const store = new ArtifactStore({ baseDir: join(stateDir, 'inject'), maxBytes: 1024, maxTotalBytes: 8192 })
  const artifactsDir = join(stateDir, 'inject', 'artifacts')

  try {
    await check('注入 EPERM：同一 tmp→final 按 5/10ms 退避重试后成功', async () => {
      const ticket = await store.createUploadTicket({ purpose: 'import-source', expectedBytes: 4 })
      const artifactId = ticket.artifact.artifactId
      const target = join(artifactsDir, `${artifactId}.json`)
      const content = Buffer.from('data')
      let remaining = 2
      shim.resetRenameCalls()
      shim.setRenameHook(async (from, to) => {
        if (to === target && remaining > 0) {
          remaining -= 1
          throw injectedError('EPERM')
        }
        return shim.realRename(from, to)
      })
      try {
        const ready = await store.upload(
          artifactId,
          tokenOf(ticket),
          (async function* () {
            yield content
          })()
        )
        assert.equal(ready.status, 'ready')
        assert.equal(ready.sizeBytes, 4)
        assert.equal(ready.sha256, sha256Of(content))
      } finally {
        shim.setRenameHook(null)
      }

      // uploading 写入：2 次失败 + 1 次成功；ready 写入：1 次。
      const targetCalls = shim.renameCalls.filter((call) => call.to === target)
      assert.equal(targetCalls.length, 4, '应经历 2 次失败、1 次成功，以及 ready 元数据的 1 次写入')
      assert.equal(targetCalls[0].error, 'EPERM')
      assert.equal(targetCalls[1].error, 'EPERM')
      assert.equal(targetCalls[2].error, null)
      assert.equal(targetCalls[3].error, null)
      const uploadingTmp = targetCalls[0].from
      assert.equal(targetCalls[1].from, uploadingTmp, '重试必须复用同一 tmp 文件')
      assert.equal(targetCalls[2].from, uploadingTmp, '重试必须复用同一 tmp 文件')
      assert.notEqual(targetCalls[3].from, uploadingTmp, 'ready 元数据应使用新的 tmp 文件')
      assert.ok(targetCalls[1].at - targetCalls[0].at >= EPERM_DELAYS_MS[0], '第一次退避不得短于 5ms')
      assert.ok(targetCalls[2].at - targetCalls[1].at >= EPERM_DELAYS_MS[1], '第二次退避不得短于 10ms')

      const metadata = JSON.parse(readFileSync(target, 'utf8'))
      assert.equal(metadata.status, 'ready')
      assert.equal(metadata.sizeBytes, 4)
      assert.equal(metadata.sha256, sha256Of(content))
      assert.equal(readFileSync(join(artifactsDir, `${artifactId}.bin`), 'utf8'), 'data')
    })

    await check('重试耗尽：抛原始错误，失败契约与 metadata 收敛不变', async () => {
      const ticket = await store.createUploadTicket({ purpose: 'import-source', expectedBytes: 4 })
      const artifactId = ticket.artifact.artifactId
      const target = join(artifactsDir, `${artifactId}.json`)
      const injected = injectedError('EPERM')
      let attempts = 0
      shim.resetRenameCalls()
      shim.setRenameHook(async (from, to) => {
        if (to === target && attempts < EPERM_DELAYS_MS.length + 1) {
          attempts += 1
          throw injected
        }
        return shim.realRename(from, to)
      })
      const started = Date.now()
      let caught = null
      try {
        await store.upload(
          artifactId,
          tokenOf(ticket),
          (async function* () {
            yield Buffer.from('data')
          })()
        )
      } catch (error) {
        caught = error
      } finally {
        shim.setRenameHook(null)
      }
      const elapsed = Date.now() - started

      assert.equal(caught, injected, '耗尽后必须原样抛出注入的 rename 错误')
      assert.equal(caught.code, 'EPERM')
      assert.equal(attempts, EPERM_DELAYS_MS.length + 1, '应是 1 次原始 + 5 次重试')
      assert.ok(elapsed >= 150, `总退避应接近 155ms，实际 ${elapsed}ms`)
      assert.equal(JSON.parse(readFileSync(target, 'utf8')).status, 'failed')
      assert.equal(existsSync(join(artifactsDir, `${artifactId}.bin`)), false, '失败上传不得留下数据文件')
    })

    await check('非可重试错误码：不重试，立即抛原始错误', async () => {
      const ticket = await store.createUploadTicket({ purpose: 'import-source', expectedBytes: 4 })
      const artifactId = ticket.artifact.artifactId
      const target = join(artifactsDir, `${artifactId}.json`)
      const injected = injectedError('ENOENT')
      let attempts = 0
      shim.setRenameHook(async (from, to) => {
        if (to === target && attempts === 0) {
          attempts += 1
          throw injected
        }
        return shim.realRename(from, to)
      })
      const started = Date.now()
      let caught = null
      try {
        await store.upload(
          artifactId,
          tokenOf(ticket),
          (async function* () {
            yield Buffer.from('data')
          })()
        )
      } catch (error) {
        caught = error
      } finally {
        shim.setRenameHook(null)
      }
      const elapsed = Date.now() - started

      assert.equal(caught, injected)
      assert.equal(attempts, 1, 'ENOENT 不属于 Windows 可重试错误码')
      assert.ok(elapsed < 50, `非可重试错误应立即失败，实际 ${elapsed}ms`)
    })

    await check('Windows 真实持柄：目标文件被打开时 rename 经重试后成功', async () => {
      if (process.platform !== 'win32') {
        console.log('     ↷ 非 Windows，跳过真实持柄场景')
        return
      }
      const ticket = await store.createUploadTicket({ purpose: 'import-source', expectedBytes: 4 })
      const artifactId = ticket.artifact.artifactId
      const target = join(artifactsDir, `${artifactId}.json`)
      const handle = openSync(target, 'r')
      let closed = false
      let closeHandle = () => {
        if (closed) return
        closed = true
        try {
          closeSync(handle)
        } catch {
          // 句柄已关闭时忽略。
        }
      }
      const attempts = []
      shim.setRenameHook(async (from, to, call) => {
        if (to === target) {
          attempts.push(call.at)
          if (!closed) setImmediate(closeHandle)
        }
        return shim.realRename(from, to)
      })
      try {
        const ready = await store.upload(
          artifactId,
          tokenOf(ticket),
          (async function* () {
            yield Buffer.from('data')
          })()
        )
        assert.equal(ready.status, 'ready')
      } finally {
        closeHandle()
        shim.setRenameHook(null)
      }
      assert.ok(attempts.length >= 2, `真实 EPERM 应触发重试，实际 rename 尝试 ${attempts.length} 次`)
      assert.equal(JSON.parse(readFileSync(target, 'utf8')).status, 'ready')
    })

    await check('并发 20 上传 + 20 元数据读取不再出现 EPERM', async () => {
      const concurrent = new ArtifactStore({
        baseDir: join(stateDir, 'concurrent'),
        maxBytes: 64,
        maxTotalBytes: 4096,
        maxArtifacts: 40,
        maxConcurrentUploads: 32
      })
      try {
        const tickets = await Promise.all(
          Array.from({ length: 20 }, () => concurrent.createUploadTicket({ purpose: 'import-source', expectedBytes: 4 }))
        )
        const readErrors = []
        let reading = true
        const reader = (async () => {
          let index = 0
          while (reading) {
            const ticket = tickets[index % tickets.length]
            index += 1
            try {
              await concurrent.inspectArtifact(ticket.artifact.artifactId)
            } catch (error) {
              readErrors.push(error)
            }
            await new Promise((resolveWaiter) => setImmediate(resolveWaiter))
          }
        })()
        const uploadErrors = []
        const uploads = tickets.map(async (ticket) => {
          try {
            return await concurrent.upload(
              ticket.artifact.artifactId,
              tokenOf(ticket),
              (async function* () {
                yield Buffer.from('da')
                yield Buffer.from('ta')
              })()
            )
          } catch (error) {
            uploadErrors.push(error)
            return null
          }
        })
        const results = await Promise.all(uploads)
        reading = false
        await reader

        assert.deepEqual(uploadErrors.map((error) => error?.code), [], '并发上传不得出现 EPERM')
        assert.deepEqual(readErrors.map((error) => error?.code), [], '并发读取不得出现 EPERM')
        assert.equal(results.filter(Boolean).length, 20)
        for (const ready of results) {
          assert.equal(ready.status, 'ready')
          assert.equal(ready.sizeBytes, 4)
        }
      } finally {
        concurrent.dispose()
      }
    })
  } finally {
    store.dispose()
  }
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n===== artifact 原子写 rename 重试：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exitCode = 1
