/**
 * 导入/事务边界 RPC 超时的竞态安全验证（e2e-import-rpc-safety）。
 *
 * 背景（已核实的缺陷）：
 *   - DriverHostHandle.#requestWithTimeout 超时只做 pending.delete + reject；
 *   - 驱动宿主用 `void host.handle(req)` 并发分发 stdin 请求；
 *   - 于是 importBatch 超时后，ImportManager 立刻发 rollbackTransaction，
 *     该 rollback 可以和仍在逐行 INSERT 的 importBatch 交错；
 *   - commit 响应丢失时又被当成「肯定没提交」，可能错误地标成已回滚。
 *
 * 本测试用**可控 fake 宿主**（真实 DriverHostHandle + 真实子进程协议）验证修复后：
 *   1. importBatch 超时后宿主被可靠终止：不再产生任何后续写入；
 *   2. 超时后 rollback 在句柄层立即失败，根本没有 rollback 请求到宿主；
 *   3. 超时后宿主被标记为不可用（closed / failed），后续调用一律拒绝；
 *   4. commitTransaction 超时/host 退出返回可识别的「提交结果未知」错误，
 *      不会伪装成确定未提交；commit 确实已发出的证据（COMMIT_SENT）保留；
 *   5. 普通 RPC 超时语义不变（只报错，不杀宿主）。
 *
 * 构建方式：vite `write:false` 内存编译 DriverHostHandle，再写入**新目录**；
 * 不执行任何 emptyOutDir / 删除操作，所有产物与运行证据全部保留。
 *
 * 无需真实数据库，不读取任何凭据。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const artifactDir = resolve(root, 'out', 'e2e-import-rpc-safety', stamp)
const bundleDir = join(artifactDir, 'main')
const fakeHostDir = join(artifactDir, 'driver-host')
const bundlePath = join(bundleDir, 'DriverHostHandle.cjs')
const fakeHostPath = join(fakeHostDir, 'index.js')

mkdirSync(bundleDir, { recursive: true })
mkdirSync(fakeHostDir, { recursive: true })

let pass = 0
let fail = 0
const results = []

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    results.push({ name, passed: true })
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    results.push({ name, passed: false, detail })
    console.log(`FAIL  ${name}${detail ? `\n      ↳ ${detail}` : ''}`)
  }
  return Boolean(condition)
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms))
}

function readLines(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function isProcessGone(pid) {
  if (typeof pid !== 'number' || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

async function expectReject(promise) {
  try {
    const value = await promise
    return { rejected: false, value }
  } catch (error) {
    return { rejected: true, error }
  }
}

/** 给 close 这类依赖子进程退出的 Promise 加硬上限，避免测试自身无限等待。 */
async function withTimeout(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未完成`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * fake 宿主脚本：真实走 NDJSON over stdio，按方言模拟不同故障。
 * 所有行为写入 stateDir，供测试做「确实没有后续写入 / 确实发送过 COMMIT」的取证。
 */
const FAKE_HOST_SOURCE = `'use strict'
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')

const stateDir = process.env.FAKE_HOST_STATE_DIR
if (!stateDir) {
  process.stderr.write('fake host: FAKE_HOST_STATE_DIR missing\\n')
  process.exit(2)
}
const dialectIndex = process.argv.indexOf('--dialect')
const dialect = dialectIndex >= 0 ? process.argv[dialectIndex + 1] : 'unknown'

function append(file, text) {
  fs.appendFileSync(path.join(stateDir, file), text + '\\n')
}
function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\\n')
}

send({
  kind: 'handshake',
  dialectId: dialect,
  adapterVersion: 'fake-0.0.0',
  pid: process.pid,
  nodeVersion: process.version,
  platform: process.platform
})

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let importTimer = null

rl.on('line', (line) => {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  append('requests.log', req.id + '\\t' + req.method)

  switch (req.method) {
    case 'connect':
      send({ id: req.id, ok: true, result: { dialectId: dialect, supportsCancel: false } })
      return
    case 'disconnect':
      send({ id: req.id, ok: true, result: null })
      return
    case 'importBatch': {
      append('lifecycle.log', 'importBatch:start id=' + req.id)
      // 模拟仍在逐行 INSERT：持续写证据文件，直到进程被杀。
      let n = 0
      importTimer = setInterval(() => {
        n += 1
        append('writes.log', 'INSERT row ' + n)
      }, 25)
      // 故意永不回帧，触发客户端超时。
      return
    }
    case 'commitTransaction': {
      append('lifecycle.log', 'commit:sent id=' + req.id)
      append('commit.log', 'COMMIT_SENT pid=' + process.pid)
      if (dialect === 'fake-commit-crash') {
        setTimeout(() => process.exit(7), 40)
      }
      // 其余情况：提交已发出但响应丢失（永不回帧）。
      return
    }
    case 'rollbackTransaction':
      append('rollback.log', 'ROLLBACK_RECEIVED')
      send({ id: req.id, ok: true, result: { active: false } })
      return
    case 'listChildren':
      if (dialect === 'fake-generic-hang' || dialect === 'fake-import-hang') return
      send({ id: req.id, ok: true, result: [] })
      return
    default:
      send({ id: req.id, ok: true, result: null })
      return
  }
})

function shutdown() {
  if (importTimer) clearInterval(importTimer)
  process.exit(0)
}
rl.on('close', shutdown)
process.stdin.on('end', shutdown)
`

writeFileSync(fakeHostPath, FAKE_HOST_SOURCE, 'utf8')

async function buildHandleBundle() {
  const built = await build({
    configFile: false,
    root,
    logLevel: 'error',
    build: {
      write: false,
      ssr: true,
      target: 'node22',
      minify: false,
      rollupOptions: {
        external: [/^node:/, 'electron']
      },
      lib: {
        entry: resolve(root, 'src/main/DriverHostHandle.ts'),
        formats: ['cjs'],
        fileName: () => 'DriverHostHandle.cjs'
      }
    }
  })
  const output = Array.isArray(built) ? built[0]?.output : built.output
  const chunk = output?.find((item) => item.type === 'chunk')
  if (!chunk || typeof chunk.code !== 'string') {
    throw new Error('vite 未产出 DriverHostHandle chunk')
  }
  writeFileSync(bundlePath, chunk.code, 'utf8')
}

async function loadHandle() {
  const mod = await import(pathToFileURL(bundlePath).href)
  const api = mod?.DriverHostHandle ? mod : mod?.default
  if (!api?.DriverHostHandle) throw new Error('无法从编译产物加载 DriverHostHandle')
  return api
}

function makeBatch() {
  return {
    batchIndex: 0,
    columns: ['name'],
    rows: [{ rowNumber: 1, values: [{ kind: 'text', text: 'alice' }] }]
  }
}

const SCENARIO_TIMEOUTS = { requestMs: 600, resultSetMs: 400 }

async function scenarioImportTimeout(DriverHostHandle, scenarioDir) {
  process.env.FAKE_HOST_STATE_DIR = scenarioDir
  const host = new DriverHostHandle({
    dialectId: 'fake-import-hang',
    timeouts: SCENARIO_TIMEOUTS
  })
  try {
    await withTimeout(host.handshake, 3000, 'handshake')
    await withTimeout(
      host.connect({ dialectId: 'fake-import-hang', name: 'fake', options: {} }),
      3000,
      'connect'
    )

    // 先挂一个不会被 fake 宿主回应的普通请求，用来验证宿主终止时 pending 被清算。
    const pendingList = expectReject(host.request('listChildren'))

    const outcome = await expectReject(host.importBatch('table:items', makeBatch()))
    check('importBatch 超时被拒绝', outcome.rejected)
    const listOutcome = await withTimeout(pendingList, 1500, 'pending listChildren 清算')
    check(
      '宿主终止时其他 pending 请求被一并清算（不悬挂）',
      listOutcome.rejected,
      'pending listChildren 未被拒绝'
    )
    const error = outcome.error
    check(
      'importBatch 超时错误可识别（code + hostTerminated）',
      error?.code === 'driver_host_timeout' && error?.hostTerminated === true,
      `code=${String(error?.code)} hostTerminated=${String(error?.hostTerminated)}`
    )
    check(
      'importBatch 超时文案带稳定标记',
      typeof error?.message === 'string' && error.message.includes('HOST_TERMINATED_TIMEOUT:'),
      String(error?.message)
    )
    check(
      'importBatch 超时后宿主标记为不可用（closed + failed）',
      host.closed === true && host.lifecycle === 'failed',
      `closed=${String(host.closed)} lifecycle=${String(host.lifecycle)}`
    )

    // 模拟 ImportManager 在批次失败后立即回滚：必须在句柄层被拒绝，不得写进宿主。
    const rollback = await expectReject(host.rollbackTransaction())
    check(
      '超时后 rollback 在句柄层立即失败',
      rollback.rejected && /已关闭/.test(String(rollback.error?.message)),
      String(rollback.error?.message)
    )
    check(
      '超时后没有任何 rollback 请求到达宿主',
      !existsSync(join(scenarioDir, 'rollback.log')),
      readText(join(scenarioDir, 'rollback.log'))
    )

    // 关键：宿主被终止后不得再产生后续写入。
    await delay(120)
    const before = readLines(join(scenarioDir, 'writes.log')).length
    await delay(350)
    const after = readLines(join(scenarioDir, 'writes.log')).length
    check(
      '超时前宿主确实在写入（复现前提成立）',
      before > 0,
      `before=${before}`
    )
    check(
      '超时后宿主不再产生任何后续写入',
      before === after,
      `before=${before} after=${after}`
    )

    const pid = host.diagnostics.pid
    await withTimeout(host.close(), 3000, 'close')
    check('宿主进程已退出', isProcessGone(pid), `pid=${String(pid)}`)

    // 之后任何调用都不可用。
    const reuse = await expectReject(host.request('listChildren'))
    check(
      '超时后宿主不可继续使用',
      reuse.rejected && /已关闭/.test(String(reuse.error?.message)),
      String(reuse.error?.message)
    )

    const requests = readLines(join(scenarioDir, 'requests.log'))
    check(
      '请求日志中没有 rollback/commit（没有向仍运行的宿主发事务控制）',
      !requests.some((line) => /rollbackTransaction|commitTransaction/.test(line)),
      requests.join(' | ')
    )
  } finally {
    host.kill()
  }
}

async function scenarioCommitTimeout(DriverHostHandle, scenarioDir) {
  process.env.FAKE_HOST_STATE_DIR = scenarioDir
  const host = new DriverHostHandle({
    dialectId: 'fake-commit-hang',
    timeouts: SCENARIO_TIMEOUTS
  })
  try {
    await withTimeout(host.handshake, 3000, 'handshake')
    await withTimeout(
      host.connect({ dialectId: 'fake-commit-hang', name: 'fake', options: {} }),
      3000,
      'connect'
    )

    const outcome = await expectReject(host.commitTransaction())
    check('commitTransaction 超时被拒绝', outcome.rejected)
    const error = outcome.error
    check(
      'commit 超时返回「提交结果未知」错误类型',
      error?.code === 'commit_outcome_unknown' && error?.commitOutcome === 'unknown',
      `code=${String(error?.code)} commitOutcome=${String(error?.commitOutcome)}`
    )
    check(
      'commit 超时文案带稳定标记',
      typeof error?.message === 'string' && error.message.includes('COMMIT_OUTCOME_UNKNOWN:'),
      String(error?.message)
    )
    check(
      'commit 已确实发出（因此不能断言未提交）',
      readText(join(scenarioDir, 'commit.log')).includes('COMMIT_SENT'),
      readText(join(scenarioDir, 'commit.log'))
    )
    check(
      'commit 超时后宿主标记为不可用',
      host.closed === true && host.lifecycle === 'failed',
      `closed=${String(host.closed)} lifecycle=${String(host.lifecycle)}`
    )
    check(
      'commit 超时后没有 rollback 请求到达宿主',
      !existsSync(join(scenarioDir, 'rollback.log')),
      readText(join(scenarioDir, 'rollback.log'))
    )

    const pid = host.diagnostics.pid
    await withTimeout(host.close(), 3000, 'close')
    check('commit 超时后宿主进程已退出', isProcessGone(pid), `pid=${String(pid)}`)
  } finally {
    host.kill()
  }
}

async function scenarioCommitHostExit(DriverHostHandle, scenarioDir) {
  process.env.FAKE_HOST_STATE_DIR = scenarioDir
  const host = new DriverHostHandle({
    dialectId: 'fake-commit-crash',
    timeouts: { requestMs: 1000, resultSetMs: 3000 }
  })
  try {
    await withTimeout(host.handshake, 3000, 'handshake')
    await withTimeout(
      host.connect({ dialectId: 'fake-commit-crash', name: 'fake', options: {} }),
      3000,
      'connect'
    )
    const outcome = await expectReject(host.commitTransaction())
    check('commit 在途时宿主退出被拒绝', outcome.rejected)
    const error = outcome.error
    check(
      '宿主退出同样返回「提交结果未知」而不是笼统超时',
      error?.code === 'commit_outcome_unknown' && error?.reason === 'host_exit',
      `code=${String(error?.code)} reason=${String(error?.reason)}`
    )
    check(
      '宿主退出文案带稳定标记',
      typeof error?.message === 'string' && error.message.includes('COMMIT_OUTCOME_UNKNOWN:'),
      String(error?.message)
    )
    check(
      '宿主退出前 COMMIT 已发出（保留“可能已提交”的证据）',
      readText(join(scenarioDir, 'commit.log')).includes('COMMIT_SENT'),
      readText(join(scenarioDir, 'commit.log'))
    )
    check('宿主退出后句柄不可用', host.closed === true, `closed=${String(host.closed)}`)
  } finally {
    host.kill()
  }
}

async function scenarioOrdinaryTimeoutUnchanged(DriverHostHandle, scenarioDir) {
  process.env.FAKE_HOST_STATE_DIR = scenarioDir
  const host = new DriverHostHandle({
    dialectId: 'fake-generic-hang',
    timeouts: { requestMs: 350, resultSetMs: 400 }
  })
  try {
    await withTimeout(host.handshake, 3000, 'handshake')
    await withTimeout(
      host.connect({ dialectId: 'fake-generic-hang', name: 'fake', options: {} }),
      3000,
      'connect'
    )
    const outcome = await expectReject(host.request('listChildren'))
    check('普通 RPC 仍按原语义超时', outcome.rejected)
    check(
      '普通 RPC 超时不是事务边界错误',
      outcome.error?.code === undefined,
      `code=${String(outcome.error?.code)}`
    )
    check(
      '普通 RPC 超时不会终止宿主',
      host.closed === false && host.lifecycle === 'ready',
      `closed=${String(host.closed)} lifecycle=${String(host.lifecycle)}`
    )
    await withTimeout(host.close(), 3000, 'close')
    check('普通超时后宿主可正常关闭', host.closed === true)
  } finally {
    host.kill()
  }
}

async function main() {
  console.log(`[e2e-import-rpc-safety] artifactDir = ${artifactDir}`)
  await buildHandleBundle()
  const api = await loadHandle()
  const DriverHostHandle = api.DriverHostHandle

  const scenarios = [
    ['importBatch 超时', scenarioImportTimeout],
    ['commitTransaction 超时', scenarioCommitTimeout],
    ['commit 在途宿主退出', scenarioCommitHostExit],
    ['普通 RPC 超时语义不变', scenarioOrdinaryTimeoutUnchanged]
  ]

  let index = 0
  for (const [label, fn] of scenarios) {
    index += 1
    const scenarioDir = join(artifactDir, `scenario-${index}`)
    mkdirSync(scenarioDir, { recursive: true })
    console.log(`\n--- ${label} ---`)
    try {
      await fn(DriverHostHandle, scenarioDir)
    } catch (error) {
      check(`${label} 场景未抛异常`, false, error instanceof Error ? error.stack ?? error.message : String(error))
    }
  }

  console.log(`\n[e2e-import-rpc-safety] PASS=${pass} FAIL=${fail}`)
  console.log(`[e2e-import-rpc-safety] 产物保留于：${artifactDir}`)
  if (fail > 0) {
    console.log('[e2e-import-rpc-safety] 失败项：')
    for (const item of results.filter((r) => !r.passed)) {
      console.log(`  - ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
    }
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[e2e-import-rpc-safety] 致命错误：', error)
  process.exit(1)
})
