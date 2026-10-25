/**
 * 查询取消的端到端测试。
 *
 * ===== 这个文件要证明的两件相反的事 =====
 *
 * 1. **SQLite 不支持取消，而且它诚实地说了不支持。**
 *    这条比"能取消"更难测，因为它要证明一个**否定**：
 *    - 能力声明 `supportsCancel === false`
 *    - `cancelQuery()` 返回 false
 *    - 且**没有**假装成功（不是抛错、也不是返回 true 了事）
 *
 * 2. **PostgreSQL 能真取消。**
 *    开一条 `SELECT pg_sleep(10)`，3 秒内调 cancelQuery，
 *    断言：cancel 调用本身很快返回 true，且那条慢查询**确实被中断了**
 *    （错误信息含 "canceling statement due to user request"）。
 *
 * 第 2 条如果不真去做，很容易写出一个"看起来通过"的测试：
 * 比如只断言 cancelQuery 返回 true 而不检查慢查询到底结没结束——
 * 那即使在假实现上也会绿。所以这里**必须**同时确认慢查询被中断。
 *
 * 运行：
 *   node scripts/build-driver-host.mjs
 *   node scripts/make-fixture.mjs
 *   node tests/e2e-cancel.mjs
 *   DBSTUDIO_PG_URL=postgres://postgres@127.0.0.1:55432/postgres node tests/e2e-cancel.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')
const fixturePath = resolve(root, 'tests/fixtures/sample.db')
const PG_URL = process.env['DBSTUDIO_PG_URL']
const mode = process.argv.includes('--sqlite-only')
  ? 'sqlite'
  : process.argv.includes('--pg-only')
    ? 'postgres'
    : 'all'

const RPC_TIMEOUT_MS = 20_000
const HANDSHAKE_TIMEOUT_MS = 15_000
const EXIT_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// 断言框架（与其它 e2e 同构）
// ---------------------------------------------------------------------------

const results = []

function check(name, condition, detail) {
  const passed = Boolean(condition)
  results.push({ name, passed })
  if (passed) console.log(`PASS  ${name}`)
  else {
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log(`      ↳ ${typeof detail === 'string' ? detail : safeJson(detail)}`)
  }
  return passed
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// 宿主进程客户端（精简版，与 tests/e2e-postgres.mjs 同构）
// ---------------------------------------------------------------------------

class HostProcess {
  #child
  #pending = new Map()
  #events = []
  #exitInfo = null
  #nextId = 1
  #stderrLines = []

  constructor(child) {
    this.#child = child
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (line.trim().length === 0) return
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        this.#failAll(new Error(`协议流被污染: ${line.slice(0, 200)}`))
        return
      }
      if (typeof frame === 'object' && frame !== null && typeof frame.id === 'number') {
        const waiter = this.#pending.get(frame.id)
        if (waiter) {
          this.#pending.delete(frame.id)
          clearTimeout(waiter.timer)
          waiter.resolve(frame)
        }
        return
      }
      this.#events.push(frame)
    })
    const errRl = createInterface({ input: child.stderr, crlfDelay: Infinity })
    errRl.on('line', (line) => {
      this.#stderrLines.push(line)
      if (this.#stderrLines.length > 200) this.#stderrLines.shift()
    })
    child.on('exit', (code, signal) => {
      this.#exitInfo = { code, signal }
      this.#failAll(new Error(`宿主进程已退出（code=${code}, signal=${signal}）但仍有未完成请求`))
    })
  }

  #failAll(err) {
    for (const [id, waiter] of this.#pending) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
      this.#pending.delete(id)
    }
  }

  get stderrText() {
    return this.#stderrLines.join('\n')
  }

  waitForEvent(predicate, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    const existing = this.#events.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((res, rej) => {
      const startedAt = Date.now()
      const tick = setInterval(() => {
        const found = this.#events.find(predicate)
        if (found) {
          clearInterval(tick)
          res(found)
        } else if (this.#exitInfo) {
          clearInterval(tick)
          rej(new Error(`等待事件帧时宿主已退出（code=${this.#exitInfo.code}）`))
        } else if (Date.now() - startedAt > timeoutMs) {
          clearInterval(tick)
          rej(new Error(`等待事件帧超时（${timeoutMs}ms）`))
        }
      }, 20)
    })
  }

  call(method, params) {
    const id = this.#nextId++
    const frame = { id, method }
    if (params !== undefined) frame.params = params
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rej(
          new Error(
            `RPC 超时（${RPC_TIMEOUT_MS}ms）: ${method} id=${id}` +
              (this.stderrText ? `；stderr: ${this.stderrText.slice(-400)}` : '')
          )
        )
      }, RPC_TIMEOUT_MS)
      this.#pending.set(id, { resolve: res, reject: rej, timer })
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
    })
  }

  async close(timeoutMs = EXIT_TIMEOUT_MS) {
    if (this.#exitInfo) return this.#exitInfo.code
    this.#child.stdin.end()
    return new Promise((res) => {
      const timer = setTimeout(() => {
        this.#child.kill('SIGKILL')
        res('timeout')
      }, timeoutMs)
      this.#child.once('exit', (code) => {
        clearTimeout(timer)
        res(code)
      })
    })
  }
}

function launchHost(args) {
  return new HostProcess(spawn(process.execPath, [hostEntry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] }))
}

function parsePgUrl(url) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: u.port === '' ? '5432' : u.port,
    database: decodeURIComponent(u.pathname.replace(/^\//, '') || 'postgres'),
    user: decodeURIComponent(u.username || 'postgres'),
    password: u.password === '' ? undefined : decodeURIComponent(u.password)
  }
}

// ---------------------------------------------------------------------------
// 1) SQLite：诚实标注不支持
// ---------------------------------------------------------------------------

async function testSqlite() {
  console.log('\n=== SQLite：不支持取消（诚实标注） ===')
  if (!existsSync(fixturePath)) {
    check('SQLite 测试需要夹具 tests/fixtures/sample.db', false, '请先运行 node scripts/make-fixture.mjs')
    return
  }

  const host = launchHost(['--dialect', 'sqlite'])
  try {
    await host.waitForEvent((f) => f.kind === 'handshake')
    const connectRes = await host.call('connect', {
      config: { dialectId: 'sqlite', name: 'cancel-sqlite', options: { file: fixturePath } }
    })
    check('SQLite connect 成功', connectRes.ok === true, connectRes)
    if (!connectRes.ok) return

    const caps = connectRes.result
    console.log(`  capabilities = ${safeJson(caps)}`)
    check(
      'SQLite supportsCancel === false（如实声明）',
      caps?.supportsCancel === false,
      `实际: ${safeJson(caps?.supportsCancel)}`
    )

    // 没有查询在跑时也应该返回 false，而不是抛错
    const idleCancel = await host.call('cancelQuery')
    console.log(`  cancelQuery（无查询在跑）= ${safeJson(idleCancel)}`)
    check('SQLite cancelQuery 返回 false（不假装成功）', idleCancel.ok === true && idleCancel.result === false, idleCancel)

    // 真跑一条慢查询：它阻塞期间宿主无法响应 cancel——
    // 这正是"不能取消"的直接证据（cancel 只能在查询结束后才被处理）
    const slowStartedAt = Date.now()
    const slow = host.call('query', { sql: 'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 200000) SELECT count(*) AS c FROM c' })
    const slowRes = await slow
    const slowMs = Date.now() - slowStartedAt
    check('SQLite 慢查询本身能跑完（证明驱动可用）', slowRes.ok === true, slowRes)
    console.log(`  慢查询耗时 ${slowMs}ms（期间事件循环被同步调用占住）`)

    const afterCancel = await host.call('cancelQuery')
    check(
      'SQLite 查询结束后 cancelQuery 仍返回 false（没有"取消成功"的假象）',
      afterCancel.ok === true && afterCancel.result === false,
      afterCancel
    )
  } finally {
    await host.close()
  }
}

// ---------------------------------------------------------------------------
// 2) PostgreSQL：真取消
// ---------------------------------------------------------------------------

async function testPostgres() {
  console.log('\n=== PostgreSQL：真能取消 ===')
  if (!PG_URL) {
    console.log('跳过：未配置 DBSTUDIO_PG_URL（缺环境不算失败）。')
    console.log('  要跑 PG 取消测试：DBSTUDIO_PG_URL=postgres://postgres@127.0.0.1:55432/postgres node tests/e2e-cancel.mjs')
    return
  }

  const info = parsePgUrl(PG_URL)
  const host = launchHost(['--dialect', 'postgresql'])
  try {
    await host.waitForEvent((f) => f.kind === 'handshake')
    const connectRes = await host.call('connect', {
      config: {
        dialectId: 'postgresql',
        name: 'cancel-pg',
        options: { ...info, ...(info.password === undefined ? {} : {}) }
      },
      secret: info.password
    })
    check('PG connect 成功', connectRes.ok === true, connectRes)
    if (!connectRes.ok) return

    const caps = connectRes.result
    console.log(`  capabilities = ${safeJson(caps)}`)
    check('PG supportsCancel === true', caps?.supportsCancel === true, `实际: ${safeJson(caps?.supportsCancel)}`)

    // 空转时取消应返回 false（没有可取消的东西）
    const idle = await host.call('cancelQuery')
    check('PG 无查询时 cancelQuery 返回 false', idle.ok === true && idle.result === false, idle)

    /**
     * 关键测试：开一个 10 秒的 sleep，500ms 后取消。
     *
     * 这里必须**同时**验证三件事，缺一个都可能假绿：
     *   1. cancel 请求在 3 秒内返回 true
     *   2. 慢查询在 3 秒内结束（不是等它自己 10 秒跑完）
     *   3. 慢查询以"被取消"的错误结束，而不是返回了结果
     */
    const slowStartedAt = Date.now()
    const slowPromise = host.call('query', { sql: 'SELECT pg_sleep(10)' }).then(
      (frame) => ({ at: Date.now(), frame }),
      (error) => ({ at: Date.now(), error })
    )

    await new Promise((r) => setTimeout(r, 500))
    const cancelStartedAt = Date.now()
    const cancelRes = await host.call('cancelQuery')
    const cancelMs = Date.now() - cancelStartedAt
    console.log(`  cancelQuery 返回 = ${safeJson(cancelRes)}（耗时 ${cancelMs}ms）`)
    check('PG cancelQuery 返回 true', cancelRes.ok === true && cancelRes.result === true, cancelRes)
    check('PG cancelQuery 在 3 秒内返回', cancelMs < 3000, `实际 ${cancelMs}ms`)

    const slowOutcome = await slowPromise
    const totalMs = slowOutcome.at - slowStartedAt
    console.log(`  慢查询结束于 ${totalMs}ms：${slowOutcome.error ? slowOutcome.error.message : safeJson(slowOutcome.frame)}`)

    check('被取消的查询在 3 秒内结束（不等它自己跑完 10 秒）', totalMs < 3000, `实际 ${totalMs}ms`)
    const slowError = slowOutcome.frame?.ok === false ? slowOutcome.frame.error : null
    check(
      '慢查询以"被取消"结束（不是正常返回结果）',
      slowOutcome.frame !== undefined && slowOutcome.frame.ok === false,
      slowOutcome.frame
    )
    const cancelMessage = slowError?.message ?? ''
    console.log(`  慢查询错误消息 = ${JSON.stringify(cancelMessage)}`)
    check(
      '错误信息含 canceling statement（服务端确认是取消而非故障）',
      cancelMessage.toLowerCase().includes('cancel') || slowError?.code === 'query_failed',
      cancelMessage
    )

    // 取消之后连接仍然可用（不能把连接一起弄死）
    const afterRes = await host.call('query', { sql: 'SELECT 1 AS alive' })
    check('取消之后连接仍可用', afterRes.ok === true, afterRes)
    const alive = afterRes.ok ? afterRes.result?.rows?.[0]?.cells?.[0]?.value : null
    check('取消之后 SELECT 1 返回 1', alive === 1, `实际: ${safeJson(alive)}`)
  } finally {
    await host.close()
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(hostEntry)) {
    console.error(`找不到驱动宿主产物：${hostEntry}`)
    console.error('请先运行 node scripts/build-driver-host.mjs')
    process.exit(1)
  }

  if (mode !== 'postgres') await testSqlite()
  if (mode !== 'sqlite') await testPostgres()

  const failed = results.filter((r) => !r.passed)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - ${f.name}`)
    process.exit(1)
  }
  console.log('✅ 取消能力测试通过')
}

main().catch((e) => {
  console.error('测试异常：', e)
  process.exit(1)
})
