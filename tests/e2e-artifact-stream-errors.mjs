/**
 * artifact 上传流 error 监听空窗回归。
 *
 * 复现路径：WriteStream 创建之后、`finishStream` 挂监听之前，`write()` 返回
 * true 不产生 drain 等待；此时异步 `error` 若没有人监听，就会变成未处理异常
 * （进程崩溃），而上传 Promise 永远挂起。
 *
 * 注入方式：构建 `artifact-store.ts` 后，把产物里的 `node:fs` import 重定向到
 * 一个测试内 shim（同一 URL 被测试和产物共同导入），由测试设置 `createWriteStream`
 * 返回可控流——`write()` 返回 true，随后异步 emit `error`。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-artifact-stream-errors-'))
const bundle = join(outDir, 'artifact-store.mjs')
const shimPath = join(outDir, 'fs-hook.mjs')

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

/** 注入流：write() 恒返回 true（不产生 drain），随后在微任务里异步 emit error。 */
class ControllableFailingStream extends EventEmitter {
  constructor(error) {
    super()
    this.error = error
    this.chunks = []
    this.destroyed = false
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk))
    queueMicrotask(() => this.emit('error', this.error))
    return true
  }

  end() {}

  destroy() {
    this.destroyed = true
  }
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms），未结算`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const SHIM_SOURCE = `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const realFs = require('node:fs')
let hook = null
export function setArtifactWriteStreamHook(next) { hook = next ?? null }
export function createReadStream(...args) { return realFs.createReadStream(...args) }
export function createWriteStream(...args) {
  return hook ? hook(...args) : realFs.createWriteStream(...args)
}
`

try {
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
  const patched = original.replace(/(from\s*)(['"])node:fs\2/g, (_match, prefix) => `${prefix}${shimUrl}`)
  assert.notEqual(patched, original, '未能在构建产物中定位 node:fs import，无法注入可控流')
  writeFileSync(bundle, patched, 'utf8')

  const { LocalArtifactStore } = await import(pathToFileURL(bundle).href)
  const shim = await import(pathToFileURL(shimPath).href)

  const store = new LocalArtifactStore({
    baseDir: join(outDir, 'state'),
    maxBytes: 1024,
    maxTotalBytes: 4096
  })
  const artifactsDir = join(outDir, 'state', 'artifacts')
  try {
    await check('正常路径：真实写流 finish 后返回 ready', async () => {
      const ticket = await store.createUploadTicket({ purpose: 'import-source', expectedBytes: 4 })
      const token = ticket.headers['x-dbstudio-artifact-ticket'].replace(/^Bearer /, '')
      const ready = await store.upload(
        ticket.artifact.artifactId,
        token,
        (async function* () {
          yield Buffer.from('data')
        })()
      )
      assert.equal(ready.status, 'ready')
      assert.equal(ready.sizeBytes, 4)
      assert.equal(existsSync(join(artifactsDir, `${ticket.artifact.artifactId}.bin`)), true)
    })

    await check('write() 返回 true 后异步 error：上传失败、进程无未捕获异常、不误报完成', async () => {
      const ticket = await store.createUploadTicket({ purpose: 'import-source' })
      const token = ticket.headers['x-dbstudio-artifact-ticket'].replace(/^Bearer /, '')
      const artifactId = ticket.artifact.artifactId
      const injected = new Error('injected artifact stream failure')
      const uncaught = []
      const onUncaught = (error) => uncaught.push(error)
      process.on('uncaughtException', onUncaught)

      let outcome = null
      let settleError = null
      try {
        shim.setArtifactWriteStreamHook(() => new ControllableFailingStream(injected))
        outcome = await withTimeout(
          store
            .upload(
              artifactId,
              token,
              (async function* () {
                yield Buffer.from('data')
              })()
            )
            .then(
              (value) => ({ resolved: value }),
              (error) => ({ rejected: error })
            ),
          2000,
          'artifact 上传'
        )
      } catch (error) {
        settleError = error
      } finally {
        shim.setArtifactWriteStreamHook(null)
        // 让注入流的 error 微任务先跑完，再撤观察窗口。
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
        process.removeListener('uncaughtException', onUncaught)
      }

      assert.equal(uncaught.length, 0, `出现未捕获异常：${uncaught.map((error) => error?.message).join(' | ')}`)
      assert.equal(settleError, null, `注入异步 error 后上传没有结算：${String(settleError)}`)
      assert.equal(outcome?.resolved, undefined, '异步 error 不得被误报为上传成功')
      assert.equal(outcome.rejected, injected, `失败路径应原样抛出注入的 error：${String(outcome.rejected)}`)

      const metadata = await store.inspectArtifact(artifactId)
      assert.equal(metadata.status, 'failed')
      assert.equal(existsSync(join(artifactsDir, `${artifactId}.bin`)), false)
    })
  } finally {
    store.dispose()
  }
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n===== artifact 上传流 error 监听：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exitCode = 1
