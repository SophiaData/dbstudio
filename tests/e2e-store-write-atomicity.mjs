/**
 * ConnectionStore / SqlLibraryStore 原子写与隔离备份的 Windows EPERM 回归。
 *
 * 背景：Windows 的 MoveFileEx 在目标文件正被其它句柄打开（并发读取、索引器、
 * 杀毒扫描）时返回 EPERM。两个 store 的 temp→final 改名与坏文件隔离改名都是
 * 同步 fs 调用，没有任何退避，一次瞬时占用就会让「保存连接」「记录 SQL 历史」
 * 直接失败。
 *
 * 断言的三条语义：
 *   - win32 上对 EPERM/EBUSY/EACCES 按 5/10/20/40/80ms 有界退避，复用同一 tmp 重试后成功；
 *   - 重试耗尽后抛原始错误（caller 包装层保持原样），目标文件保持旧内容、无 tmp 残留；
 *   - 非 win32 或其它错误码不重试，立即失败。
 *
 * 注入方式：构建两个 store 的 ESM 产物后，把产物里的 `node:fs` import 重定向到
 * 测试内 shim（同一 URL 被测试与产物共同导入），由测试控制 renameSync 抛错并记录
 * 每次尝试。真实持柄用例不注入错误：由独立子进程打开目标文件，制造真实 EPERM。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-store-write-atomicity-'))
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

/** 与实现共享的退避常数（毫秒）。 */
const EPERM_DELAYS_MS = [5, 10, 20, 40, 80]
const MAX_ATTEMPTS = EPERM_DELAYS_MS.length + 1

function injectedError(code) {
  return Object.assign(new Error(`injected ${code}`), { code, syscall: 'rename' })
}

function tmpFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.tmp')) : []
}

function makeConfig(name, file) {
  return { dialectId: 'sqlite', name, options: { file } }
}

const SHIM_SOURCE = `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const real = require('node:fs')
let hook = null
export const syncRenameCalls = []
export function setRenameHook(next) { hook = next ?? null }
export function resetRenameCalls() { syncRenameCalls.length = 0 }
export function realRenameSync(from, to) { return real.renameSync(from, to) }
export function renameSync(from, to) {
  const call = { from, to, at: Date.now(), error: null }
  syncRenameCalls.push(call)
  try {
    if (hook) return hook(from, to, call)
    return real.renameSync(from, to)
  } catch (error) {
    call.error = error?.code ?? 'unknown'
    throw error
  }
}
export const existsSync = (...args) => real.existsSync(...args)
export const mkdirSync = (...args) => real.mkdirSync(...args)
export const readFileSync = (...args) => real.readFileSync(...args)
export const readdirSync = (...args) => real.readdirSync(...args)
export const statSync = (...args) => real.statSync(...args)
export const unlinkSync = (...args) => real.unlinkSync(...args)
export const writeFileSync = (...args) => real.writeFileSync(...args)
export const openSync = (...args) => real.openSync(...args)
export const closeSync = (...args) => real.closeSync(...args)
export const rmSync = (...args) => real.rmSync(...args)
`

/** 触发一次目标文件的原子写，返回捕获到的错误（成功时返回 null）。 */
function captureSync(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}

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
          'connection-store': resolve(root, 'src/main/ConnectionStore.ts'),
          'sql-library-store': resolve(root, 'src/main/SqlLibraryStore.ts')
        },
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.mjs`
      },
      rollupOptions: {
        external: [/^node:/]
      }
    }
  })

  // 产物可能被 rollup 拆成多个 chunk：所有出现 `node:fs` import 的文件都要重定向。
  const shimUrl = JSON.stringify(pathToFileURL(shimPath).href)
  const builtFiles = readdirSync(outDir).filter((name) => name.endsWith('.mjs') && name !== 'fs-hook.mjs')
  let patchedCount = 0
  for (const name of builtFiles) {
    const file = join(outDir, name)
    const original = readFileSync(file, 'utf8')
    const patched = original.replace(/(from\s*)(['"])node:fs\2/g, `$1${shimUrl}`)
    if (patched !== original) {
      writeFileSync(file, patched, 'utf8')
      patchedCount += 1
    }
  }
  assert.ok(patchedCount > 0, '未能在构建产物中定位 node:fs import，无法注入 renameSync')

  const shim = await import(pathToFileURL(shimPath).href)
  const { ConnectionStore } = await import(pathToFileURL(join(outDir, 'connection-store.mjs')).href)
  const { SqlLibraryStore } = await import(pathToFileURL(join(outDir, 'sql-library-store.mjs')).href)

  const stateDir = join(outDir, 'state')
  const freshDir = (tag) => {
    const dir = join(stateDir, tag)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  await check('注入 EPERM：ConnectionStore 原子写复用同一 tmp，按 5/10ms 退避后成功', async () => {
    const dir = freshDir('retry-ok')
    const store = new ConnectionStore({ baseDir: dir, cipher: null })
    const target = store.connectionsPath
    let remaining = 2
    shim.resetRenameCalls()
    shim.setRenameHook((from, to) => {
      if (to === target && remaining > 0) {
        remaining -= 1
        throw injectedError('EPERM')
      }
      return shim.realRenameSync(from, to)
    })
    try {
      store.saveConnection('c1', makeConfig('本地库', '/tmp/a.db'))
    } finally {
      shim.setRenameHook(null)
    }

    const calls = shim.syncRenameCalls.filter((call) => call.to === target)
    assert.equal(calls.length, 3, '应经历 2 次失败 + 1 次成功')
    assert.equal(calls[0].error, 'EPERM')
    assert.equal(calls[1].error, 'EPERM')
    assert.equal(calls[2].error, null)
    assert.equal(calls[1].from, calls[0].from, '重试必须复用同一 tmp 文件')
    assert.equal(calls[2].from, calls[0].from, '重试必须复用同一 tmp 文件')
    assert.ok(calls[1].at - calls[0].at >= EPERM_DELAYS_MS[0], '第一次退避不得短于 5ms')
    assert.ok(calls[2].at - calls[1].at >= EPERM_DELAYS_MS[1], '第二次退避不得短于 10ms')

    const saved = JSON.parse(readFileSync(target, 'utf8'))
    assert.equal(saved.connections.length, 1)
    assert.equal(saved.connections[0].id, 'c1')
    assert.deepEqual(tmpFiles(dir), [], '重试成功后不得残留 tmp 文件')
  })

  await check('重试耗尽：抛原始错误、目标文件保持旧内容、无 tmp 残留', async () => {
    const dir = freshDir('retry-exhausted')
    const store = new ConnectionStore({ baseDir: dir, cipher: null })
    store.saveConnection('c1', makeConfig('旧连接', '/tmp/old.db'))
    const target = store.connectionsPath
    const before = readFileSync(target, 'utf8')

    const injected = injectedError('EPERM')
    let attempts = 0
    shim.resetRenameCalls()
    shim.setRenameHook((from, to) => {
      if (to === target) {
        attempts += 1
        throw injected
      }
      return shim.realRenameSync(from, to)
    })
    const started = Date.now()
    const caught = captureSync(() => store.saveConnection('c2', makeConfig('新连接', '/tmp/new.db')))
    const elapsed = Date.now() - started
    shim.setRenameHook(null)

    assert.ok(caught !== null, '重试耗尽必须抛错')
    assert.match(caught.message, /原子写入失败/, '包装层错误语义保持')
    assert.match(caught.message, /injected EPERM/, '必须携带原始错误原因')
    assert.equal(attempts, MAX_ATTEMPTS, '应是 1 次原始 + 5 次重试')
    assert.ok(elapsed >= 150, `总退避应接近 155ms，实际 ${elapsed}ms`)
    assert.equal(readFileSync(target, 'utf8'), before, '失败时目标文件必须保持旧内容')
    assert.deepEqual(tmpFiles(dir), [], '失败路径必须清理 tmp 文件')
  })

  await check('非可重试错误码：不重试，立即抛原始错误', async () => {
    const dir = freshDir('non-retryable')
    const store = new ConnectionStore({ baseDir: dir, cipher: null })
    store.saveConnection('c1', makeConfig('旧连接', '/tmp/old.db'))
    const target = store.connectionsPath

    const injected = injectedError('ENOENT')
    let attempts = 0
    shim.resetRenameCalls()
    shim.setRenameHook((from, to) => {
      if (to === target) {
        attempts += 1
        throw injected
      }
      return shim.realRenameSync(from, to)
    })
    const started = Date.now()
    const caught = captureSync(() => store.saveConnection('c2', makeConfig('新连接', '/tmp/new.db')))
    const elapsed = Date.now() - started
    shim.setRenameHook(null)

    assert.ok(caught !== null)
    assert.match(caught.message, /injected ENOENT/)
    assert.equal(attempts, 1, 'ENOENT 不属于 Windows 可重试错误码')
    assert.ok(elapsed < 50, `非可重试错误应立即失败，实际 ${elapsed}ms`)
    assert.deepEqual(tmpFiles(dir), [])
  })

  await check('非 win32：EPERM 不重试', async () => {
    const dir = freshDir('non-win32')
    const platform = process.platform
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const store = new ConnectionStore({ baseDir: dir, cipher: null })
    store.saveConnection('c1', makeConfig('旧连接', '/tmp/old.db'))
    const target = store.connectionsPath
    let attempts = 0
    let caught = null
    shim.resetRenameCalls()
    shim.setRenameHook((from, to) => {
      if (to === target) {
        attempts += 1
        throw injectedError('EPERM')
      }
      return shim.realRenameSync(from, to)
    })
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      caught = captureSync(() => store.saveConnection('c2', makeConfig('新连接', '/tmp/new.db')))
    } finally {
      Object.defineProperty(process, 'platform', descriptor ?? { value: platform })
      shim.setRenameHook(null)
    }

    assert.equal(process.platform, platform, '必须恢复真实平台值')
    assert.ok(caught !== null, '非 win32 下 EPERM 不重试，直接失败')
    assert.match(caught.message, /injected EPERM/)
    assert.equal(attempts, 1, '非 win32 不得重试')
  })

  await check('SqlLibraryStore 原子写同样复用同一 tmp 退避重试', async () => {
    const dir = freshDir('sql-library-retry')
    const store = new SqlLibraryStore({ baseDir: dir })
    const target = store.historyPath
    let remaining = 2
    shim.resetRenameCalls()
    shim.setRenameHook((from, to) => {
      if (to === target && remaining > 0) {
        remaining -= 1
        throw injectedError('EPERM')
      }
      return shim.realRenameSync(from, to)
    })
    try {
      store.record(
        {
          sql: 'SELECT 1',
          connectionId: 'c1',
          dialectId: 'sqlite',
          elapsedMs: 3,
          status: 'success',
          returnedRows: 1
        },
        '本地库'
      )
    } finally {
      shim.setRenameHook(null)
    }

    const calls = shim.syncRenameCalls.filter((call) => call.to === target)
    assert.equal(calls.length, 3)
    assert.equal(calls[0].error, 'EPERM')
    assert.equal(calls[2].error, null)
    assert.equal(calls[2].from, calls[0].from)
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).entries.length, 1)
    assert.deepEqual(tmpFiles(dir), [])
  })

  await check('坏文件隔离改名：EPERM 退避后成功，原内容完整保留', async () => {
    const dir = freshDir('quarantine-retry')
    const store = new ConnectionStore({ baseDir: dir, cipher: null })
    const path = store.connectionsPath
    const broken = '{invalid'
    writeFileSync(path, broken, 'utf8')

    let remaining = 2
    shim.resetRenameCalls()
    shim.setRenameHook((from, to) => {
      if (from === path && to.startsWith(`${path}.corrupt-`) && remaining > 0) {
        remaining -= 1
        throw injectedError('EPERM')
      }
      return shim.realRenameSync(from, to)
    })
    let reopened = null
    try {
      reopened = new ConnectionStore({ baseDir: dir, cipher: null })
    } finally {
      shim.setRenameHook(null)
    }

    const calls = shim.syncRenameCalls.filter((call) => call.from === path)
    assert.equal(calls.length, 3, '隔离改名应经历 2 次失败 + 1 次成功')
    assert.equal(calls[2].error, null)
    assert.equal(calls[2].from, calls[0].from, '重试必须复用同一源路径')
    assert.equal(reopened.listConnections().length, 0, '坏文件仍按空清单降级')
    const corrupt = readdirSync(dir).filter((name) => name.includes('.corrupt-'))
    assert.equal(corrupt.length, 1)
    assert.equal(readFileSync(join(dir, corrupt[0]), 'utf8'), broken, '备份内容必须原样保留')
    assert.equal(existsSync(path), false, '原名文件已被改名')
  })

  await check('Windows 真实持柄：外部进程打开目标文件时同步 rename 经重试后成功', async () => {
    if (process.platform !== 'win32') {
      console.log('     ↷ 非 Windows，跳过真实持柄场景')
      return
    }
    const dir = freshDir('real-handle')
    const store = new ConnectionStore({ baseDir: dir, cipher: null })
    store.saveConnection('c1', makeConfig('已有连接', '/tmp/old.db'))
    const target = store.connectionsPath

    const childCode = [
      "const fs = require('node:fs')",
      "const handle = fs.openSync(process.argv[1], 'r')",
      "process.stdout.write('open\\n')",
      'setTimeout(() => { try { fs.closeSync(handle) } catch {} }, 80)'
    ].join('\n')
    const child = spawn(process.execPath, ['-e', childCode, target], {
      stdio: ['ignore', 'pipe', 'inherit']
    })
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
    const opened = new Promise((resolveOpen, rejectOpen) => {
      child.stdout.once('data', () => resolveOpen())
      child.once('error', rejectOpen)
    })
    try {
      await opened
      shim.resetRenameCalls()
      store.saveConnection('c2', makeConfig('新连接', '/tmp/new.db'))
    } finally {
      await exited
    }

    const calls = shim.syncRenameCalls.filter((call) => call.to === target)
    assert.ok(calls.length >= 2, `真实 EPERM 应触发重试，实际尝试 ${calls.length} 次`)
    assert.equal(calls.at(-1).error, null, '目标文件被释放后 rename 必须成功')
    const saved = JSON.parse(readFileSync(target, 'utf8'))
    assert.equal(saved.connections.length, 2)
    assert.deepEqual(tmpFiles(dir), [])
  })
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n===== store 原子写 rename 重试：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exitCode = 1
