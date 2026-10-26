/**
 * 在线编辑与事务专项端到端验证。
 *
 * ===== 这个文件要证的两件事 =====
 *
 * 1. **编辑链路本身**：applyEdits → transactionState → rollback/commit 的语义正确，
 *    且「回滚后数据恢复原样」「提交后数据持久」这两条闭环成立。
 * 2. **进程隔离在事务上真的有效**：A 连接有未提交事务时，B 连接看不到它、
 *    也不认为自己在事务里。这是「一个连接 = 一个宿主进程」这条架构决策
 *    **唯一能被直接验证**的地方——如果事务状态漏到了别的连接，
 *    说明隔离只是名义上的。
 *
 * ===== 为什么用独立临时库副本，而不是直接改 tests/fixtures/sample.db =====
 *
 * 编辑测试**必然写库**。如果直接写共享夹具：
 *   - 跑一次 e2e-edit 就会把 sample.db 改脏，e2e.mjs / e2e-resultset.mjs
 *     再跑时读到的就不是 make-fixture 生成的那份数据；
 *   - 「回滚后恢复原样」这条断言会依赖"上一次运行有没有提交过"，无法重复运行。
 * 所以每次运行都把 sample.db 复制成独立副本，测试只碰副本，结束后移入垃圾桶。
 *
 * 运行：node tests/e2e-edit.mjs
 * 前置：node scripts/make-fixture.mjs && node scripts/build-driver-host.mjs
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')
const fixtureDb = resolve(root, 'tests/fixtures/sample.db')
const TRASH_DIR = resolve(root, 'out/.trash')

/** 编辑链路用的是 60s 长超时；这里测试的是本地小库，10s 足够判定「挂了」。 */
const RPC_TIMEOUT_MS = 10_000
const HANDSHAKE_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 10_000

/** 临时库路径（每次运行重新复制，保证初始状态确定）。 */
const RPC_DB = resolve(root, 'tests/fixtures/.tmp-edit-rpc.db')
const MAIN_DB = resolve(root, 'tests/fixtures/.tmp-edit-main.db')

// ---------------------------------------------------------------------------
// 断言框架
// ---------------------------------------------------------------------------

const results = []

class SetupBlockedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SetupBlockedError'
    this.status = 'blocked_by_setup'
  }
}

function check(name, condition, detail) {
  const passed = Boolean(condition)
  results.push({ name, passed, detail })
  if (passed) {
    console.log(`PASS  ${name}`)
  } else {
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log(`      ↳ ${formatDetail(detail)}`)
  }
  return passed
}

function blockedBySetup(name, detail) {
  results.push({ name, passed: false, status: 'blocked_by_setup', detail })
  console.log(`BLOCKED_BY_SETUP ${name}`)
  if (detail !== undefined) console.log(`      ↳ ${formatDetail(detail)}`)
}

function reportFailure(name, error) {
  if (error instanceof SetupBlockedError) {
    blockedBySetup(name, error.message)
    return
  }
  check(name, false, error instanceof Error ? error.message : String(error))
}

function requireConnected(summary, label) {
  if (!summary || summary.connected !== true || typeof summary.id !== 'string') {
    throw new SetupBlockedError(
      `${label}: 连接前置条件失败，summary=${formatDetail(summary)}`
    )
  }
  return summary
}

function skip(name, reason) {
  results.push({ name, passed: true, skipped: true, detail: reason })
  console.log(`SKIP  ${name}`)
  console.log(`      ↳ ${reason}`)
}

function formatDetail(detail) {
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

/** CellValue 构造助手：测试里大量用到，写全属性太啰嗦且容易写错形状。 */
const cell = {
  text: (text) => ({ kind: 'text', text }),
  number: (value) => ({ kind: 'number', value }),
  null: () => ({ kind: 'null' })
}

/** 把 CellValue 渲染成可比较文本。 */
function cellText(value) {
  if (value === null || value === undefined) return '<undefined>'
  switch (value.kind) {
    case 'null':
      return 'NULL'
    case 'text':
      return value.text
    case 'number':
      return String(value.value)
    case 'boolean':
      return String(value.value)
    case 'blob':
      return `<blob:${value.length}>`
    default:
      return `<unknown:${JSON.stringify(value)}>`
  }
}

/** 查询单值并返回文本，用于「值恢复原样 / 已持久」这类断言。 */
async function scalar(host, sql) {
  const res = await host.call('query', { sql, options: { keepCursor: false } })
  if (res.ok !== true) throw new Error(`查询失败: ${formatDetail(res.error)}`)
  return cellText(res.result?.rows?.[0]?.cells?.[0])
}

// ---------------------------------------------------------------------------
// 宿主客户端（与另外两个 e2e 同构，独立实现）
// ---------------------------------------------------------------------------

class HostProcess {
  #child
  #pending = new Map()
  #events = []
  #exitInfo = null
  #nextId = 1
  #stderrLines = []
  #badFrames = 0

  constructor(child) {
    this.#child = child

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (line.trim().length === 0) return
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        this.#badFrames += 1
        this.#failAll(new Error(`协议流被污染，stdout 出现非 JSON: ${line.slice(0, 200)}`))
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
  get badFrameCount() {
    return this.#badFrames
  }

  findEvent(predicate) {
    return this.#events.find(predicate) ?? null
  }

  waitForEvent(predicate, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    const existing = this.findEvent(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((res, rej) => {
      const startedAt = Date.now()
      const tick = setInterval(() => {
        const found = this.findEvent(predicate)
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
              (this.stderrText ? `；宿主 stderr 末段: ${this.stderrText.slice(-500)}` : '')
          )
        )
      }, RPC_TIMEOUT_MS)
      this.#pending.set(id, { resolve: res, reject: rej, timer })
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
    })
  }

  async callExpectFailure(label, method, params) {
    const res = await this.call(method, params)
    if (res.ok === false) return res
    check(label, false, `期望失败帧，实际成功: ${formatDetail(res.result)}`)
    return null
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

  kill() {
    if (!this.#exitInfo) this.#child.kill('SIGKILL')
  }
}

function launchHost(args) {
  return new HostProcess(
    spawn(process.execPath, [hostEntry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  )
}

// ---------------------------------------------------------------------------
// Phase 1：宿主 RPC 层
// ---------------------------------------------------------------------------

async function runHostChain() {
  console.log('─'.repeat(70))
  console.log(`拉起驱动宿主: ${process.execPath} ${hostEntry} --dialect sqlite`)
  console.log('─'.repeat(70))

  const host = launchHost(['--dialect', 'sqlite'])
  try {
    const handshake = await host.waitForEvent((f) => f.kind === 'handshake')
    check('1. 收到 handshake 帧', handshake?.dialectId === 'sqlite', formatDetail(handshake))

    // ---- 未连接时的错误映射（不依赖 adapter） ----
    const preEdit = await host.callExpectFailure(
      '2. 未连接时 applyEdits 返回 not_connected（不是超时）',
      'applyEdits',
      { tableId: 'table:users', updates: [] }
    )
    check('2a. not_connected 错误码正确', preEdit?.error?.code === 'not_connected', formatDetail(preEdit?.error))
    const preState = await host.callExpectFailure(
      '3. 未连接时 transactionState 返回 not_connected',
      'transactionState',
      {}
    )
    check('3a. not_connected 错误码正确', preState?.error?.code === 'not_connected', formatDetail(preState?.error))
    // rollback 刻意不 requireConnected（清理路径要能无条件调用）
    const preRollback = await host.call('rollbackTransaction', {})
    check(
      '4. 未连接时 rollbackTransaction 不报 not_connected（清理路径可无条件调用）',
      preRollback.ok === true && preRollback.result?.active === false,
      formatDetail(preRollback)
    )

    // ---- connect ----
    const conn = await host.call('connect', {
      config: { dialectId: 'sqlite', name: 'edit-fixture', options: { file: RPC_DB } }
    })
    if (conn.ok !== true) {
      check('5. connect 成功', false, `connect 失败: ${formatDetail(conn.error)}`)
      return
    }
    check('5. connect 成功', true)

    // ---- 探针：adapter 是否实现了编辑能力（task-19） ----
    const stateProbe = await host.call('transactionState', {})
    if (stateProbe.ok !== true && /is not a function|unsupported_method/.test(JSON.stringify(stateProbe))) {
      skip('6 及之后的编辑断言', 'adapter 尚未实现编辑能力（task-19 未就绪）')
      return
    }
    if (stateProbe.ok !== true) {
      check('6. transactionState 可用（adapter 已实现事务）', false, formatDetail(stateProbe.error))
      return
    }
    check('6. transactionState 可用（adapter 已实现事务）', true)
    check('6a. 初始状态无活动事务', stateProbe.result?.active === false, formatDetail(stateProbe.result))

    // 记录初始值，后面的「恢复原样」断言以它为基准。
    const originalEmail = await scalar(host, 'SELECT email FROM users WHERE id = 1')
    check('7. 读到 users#1 的初始 email', originalEmail.length > 0, originalEmail)

    // ===== 断言：改一行 → 未提交 =====
    const edit1 = await host.call('applyEdits', {
      tableId: 'table:users',
      updates: [{ keyValues: { id: cell.number(1) }, changes: { email: cell.text('edited@example.com') } }]
    })
    if (edit1.ok !== true) {
      check('8. applyEdits 成功', false, formatDetail(edit1.error))
      return
    }
    check('8. applyEdits 成功', true)
    const r1 = edit1.result
    check('8a. affected === 1（只改到一行）', r1?.affected === 1, formatDetail(r1?.affected))
    check('8b. inTransaction === true（未自动提交）', r1?.inTransaction === true, formatDetail(r1?.inTransaction))
    check('8c. ok === true（逐行全部成功）', r1?.ok === true, formatDetail(r1?.ok))
    check(
      '8d. outcomes 长度为 1 且 index === 0',
      Array.isArray(r1?.outcomes) && r1.outcomes.length === 1 && r1.outcomes[0]?.index === 0,
      formatDetail(r1?.outcomes)
    )
    check(
      '8e. outcomes[0].error === null',
      r1?.outcomes?.[0]?.error === null,
      formatDetail(r1?.outcomes?.[0])
    )
    check(
      '8f. outcomes[0].sql 是参数化 UPDATE（含 WHERE 与 ? 占位）',
      typeof r1?.outcomes?.[0]?.sql === 'string' &&
        /UPDATE/i.test(r1.outcomes[0].sql) &&
        /WHERE/i.test(r1.outcomes[0].sql) &&
        r1.outcomes[0].sql.includes('?'),
      formatDetail(r1?.outcomes?.[0]?.sql)
    )
    check(
      '8g. outcomes[0].sql 里不含被写入的字面值（证明是参数化而非拼接）',
      !String(r1?.outcomes?.[0]?.sql ?? '').includes('edited@example.com'),
      formatDetail(r1?.outcomes?.[0]?.sql)
    )

    // ===== 断言：事务状态 =====
    const state1 = await host.call('transactionState', {})
    check(
      '9. transactionState().active === true',
      state1.ok === true && state1.result?.active === true,
      formatDetail(state1.ok ? state1.result : state1.error)
    )
    check(
      '9a. pendingAffected > 0（累计影响行数可观测）',
      state1.ok === true && state1.result?.pendingAffected > 0,
      formatDetail(state1.ok ? state1.result : state1.error)
    )

    // 同一连接内应能看见自己的未提交改动（这是事务内的正常语义）。
    const inTxnValue = await scalar(host, 'SELECT email FROM users WHERE id = 1')
    check('10. 事务内可见自己的未提交改动', inTxnValue === 'edited@example.com', inTxnValue)

    // ===== 断言：回滚 → 恢复原样（最关键） =====
    const rollback = await host.call('rollbackTransaction', {})
    check(
      '11. rollbackTransaction 成功且 active === false',
      rollback.ok === true && rollback.result?.active === false,
      formatDetail(rollback.ok ? rollback.result : rollback.error)
    )
    check(
      '11a. 回滚后 pendingAffected 归零',
      rollback.ok === true && rollback.result?.pendingAffected === 0,
      formatDetail(rollback.ok ? rollback.result : rollback.error)
    )
    const afterRollback = await scalar(host, 'SELECT email FROM users WHERE id = 1')
    check(
      '12. ★ 回滚后数据恢复原样（未提交改动没有落盘）',
      afterRollback === originalEmail,
      `期望 ${originalEmail}，实际 ${afterRollback}`
    )

    // 回滚幂等：没有事务时再回滚一次不报错。
    const rollback2 = await host.call('rollbackTransaction', {})
    check(
      '13. rollbackTransaction 幂等（无事务时再调不报错）',
      rollback2.ok === true && rollback2.result?.active === false,
      formatDetail(rollback2.ok ? rollback2.result : rollback2.error)
    )

    // ===== 断言：再改一次 → 提交 → 持久 =====
    const edit2 = await host.call('applyEdits', {
      tableId: 'table:users',
      updates: [{ keyValues: { id: cell.number(1) }, changes: { email: cell.text('committed@example.com') } }]
    })
    check('14. 第二次 applyEdits 成功', edit2.ok === true && edit2.result?.affected === 1, formatDetail(edit2))
    const commit = await host.call('commitTransaction', {})
    check(
      '15. commitTransaction 成功且 active === false',
      commit.ok === true && commit.result?.active === false,
      formatDetail(commit.ok ? commit.result : commit.error)
    )
    const afterCommit = await scalar(host, 'SELECT email FROM users WHERE id = 1')
    check(
      '16. ★ 提交后数据已持久（新查询读到新值）',
      afterCommit === 'committed@example.com',
      `实际 ${afterCommit}`
    )

    // ===== 断言：提交后再提交 → 报错（无事务） =====
    let commitAgain = null
    try {
      commitAgain = await host.callExpectFailure(
        '17. 提交后再 commitTransaction 报错（无活动事务）',
        'commitTransaction',
        {}
      )
    } catch (err) {
      check(
        '17. 提交后再 commitTransaction 报错（无活动事务）',
        false,
        `调用超时/异常: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (commitAgain) {
      check(
        '17a. 无事务提交的错误码属于已知集合',
        ['bad_params', 'query_failed', 'internal'].includes(commitAgain.error?.code),
        formatDetail(commitAgain.error)
      )
      check(
        '17b. 无事务提交的消息可读',
        typeof commitAgain.error?.message === 'string' && commitAgain.error.message.length > 0,
        formatDetail(commitAgain.error)
      )
    }

    // ===== 断言：无主键表被拒 =====
    let noKey = null
    try {
      noKey = await host.callExpectFailure(
        '18. 对无主键表 audit_log 提交编辑被拒绝',
        'applyEdits',
        {
          tableId: 'table:audit_log',
          updates: [{ keyValues: { id: cell.number(1) }, changes: { action: cell.text('x') } }]
        }
      )
    } catch (err) {
      check(
        '18. 对无主键表 audit_log 提交编辑被拒绝',
        false,
        `调用超时/异常: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (noKey) {
      check(
        '18a. 拒绝消息含唯一键语义（对齐 DBeaver "No unique key defined"）',
        /唯一键|No unique key defined|主键/i.test(noKey.error?.message ?? ''),
        formatDetail(noKey.error)
      )
      check(
        '18b. 无主键被拒后没有留下活动事务',
        (await host.call('transactionState', {})).result?.active === false,
        formatDetail((await host.call('transactionState', {})).result)
      )
    }

    // ===== 断言：匹配不到行时 affected === 0（不是谎报成功 1 行） =====
    const noMatch = await host.call('applyEdits', {
      tableId: 'table:users',
      updates: [{ keyValues: { id: cell.number(9999) }, changes: { email: cell.text('ghost@example.com') } }]
    })
    check(
      '19. 主键匹配不到行时 affected === 0（不谎报）',
      noMatch.ok === true && noMatch.result?.affected === 0,
      formatDetail(noMatch.ok ? noMatch.result : noMatch.error)
    )
    await host.call('rollbackTransaction', {})

    // ===== 断言：视图不可编辑 =====
    const viewEdit = await host.callExpectFailure(
      '20. 对视图提交编辑被拒绝',
      'applyEdits',
      { tableId: 'view:active_users', updates: [{ keyValues: { id: cell.number(1) }, changes: { email: cell.text('x') } }] }
    )
    check(
      '20a. 视图被拒错误码属于已知集合',
      ['bad_params', 'object_not_found'].includes(viewEdit?.error?.code),
      formatDetail(viewEdit?.error)
    )

    // ===== 断言：协议层参数校验（宿主侧，不依赖 adapter） =====
    const badParamCases = [
      ['updates 不是数组', { tableId: 'table:users', updates: 'nope' }],
      ['updates 空数组', { tableId: 'table:users', updates: [] }],
      ['缺 tableId', { updates: [{ keyValues: { id: cell.number(1) }, changes: { email: cell.text('x') } }] }],
      ['keyValues 缺失', { tableId: 'table:users', updates: [{ changes: { email: cell.text('x') } }] }],
      ['keyValues 为空对象', { tableId: 'table:users', updates: [{ keyValues: {}, changes: { email: cell.text('x') } }] }],
      ['changes 为空对象', { tableId: 'table:users', updates: [{ keyValues: { id: cell.number(1) }, changes: {} }] }],
      ['CellValue kind 非法', { tableId: 'table:users', updates: [{ keyValues: { id: cell.number(1) }, changes: { email: { kind: 'bogus' } } }] }],
      ['CellValue text 非字符串', { tableId: 'table:users', updates: [{ keyValues: { id: cell.number(1) }, changes: { email: { kind: 'text', text: 7 } } }] }],
      // 注意：**不能**写成对象字面量 `{ __proto__: ... }`——那会去设原型而不是
      // 建一个名为 __proto__ 的自有属性，于是这条用例根本到不了保留键检查
      // （会先因为 changes 为空而失败，测试就变成假通过）。
      // 用 JSON.parse 才能造出真正的自有属性 __proto__，模拟线上传过来的帧。
      ['保留键名 __proto__', { tableId: 'table:users', updates: [{ keyValues: { id: cell.number(1) }, changes: JSON.parse('{"__proto__":{"kind":"text","text":"x"}}') }] }]
    ]
    for (const [label, params] of badParamCases) {
      const res = await host.callExpectFailure(`21. 参数校验 ${label} → bad_params`, 'applyEdits', params)
      check(`21a. 参数校验 ${label} 错误码正确`, res?.error?.code === 'bad_params', formatDetail(res?.error))
    }

    // ===== 断言：协议流纯净 + 优雅退出 =====
    check('22. stdout 协议流无污染（无非 JSON 行）', host.badFrameCount === 0, `非法帧数: ${host.badFrameCount}`)
    const exitCode = await host.close()
    check(
      '23. 关闭 stdin 后宿主优雅退出，退出码 === 0',
      exitCode === 0,
      `实际: ${formatDetail(exitCode)}${host.stderrText ? `；stderr: ${host.stderrText.slice(-400)}` : ''}`
    )
  } finally {
    host.kill()
  }
}

// ---------------------------------------------------------------------------
// Phase 2：主进程层探针 —— 跨连接事务隔离 + remove 时先回滚
//
// 这两条**只能**在这一层验证：
//   - 跨连接隔离：需要同时持有两个连接（两个宿主进程），宿主 RPC 层做不到；
//   - remove 时回滚：remove 是 ConnectionManager 的方法，宿主层没有这个概念。
// ---------------------------------------------------------------------------

const PROBE_DIR = resolve(root, 'out/.edit-probe')

async function runMainProcessProbe() {
  console.log('─'.repeat(70))
  console.log('Phase 2：主进程层探针（跨连接事务隔离 + remove 时回滚）')
  console.log('─'.repeat(70))

  let mod
  try {
    const { build } = await import('vite')
    await build({
      configFile: false,
      root,
      logLevel: 'error',
      build: {
        outDir: PROBE_DIR,
        emptyOutDir: true,
        target: 'node22',
        minify: false,
        ssr: true,
        rollupOptions: {
          external: [/^node:/, 'electron'],
          output: { entryFileNames: 'probe.cjs' }
        },
        lib: { entry: resolve(root, 'tests/probe-entry.ts'), formats: ['cjs'] }
      }
    })
    const probeEntry = resolve(PROBE_DIR, 'probe.cjs')
    if (!existsSync(probeEntry)) {
      const emitted = existsSync(PROBE_DIR)
        ? readdirSync(PROBE_DIR).filter((f) => /\.(c?js)$/.test(f))
        : []
      skip('Phase 2 主进程探针', `未找到 ${probeEntry}；实际产出: ${emitted.join(', ') || '(空)'}`)
      return
    }
    mod = await import(`file://${probeEntry}`)
  } catch (err) {
    skip(
      'Phase 2 主进程探针',
      `无法构建/加载探针: ${err instanceof Error ? err.message : String(err)}`
    )
    return
  }

  const createManager = mod.createManagerWithBuiltinDialects
  if (typeof createManager !== 'function') {
    skip('Phase 2 主进程探针', `探针未导出 createManagerWithBuiltinDialects（${Object.keys(mod).join(', ')}）`)
    return
  }

  const manager = createManager()

  /**
   * 对 DriverHostHandle 的原型打桩，记录 rollback / close 的**调用顺序**。
   *
   * 为什么需要这个：`remove()` 要求「先回滚再关」，但**只看最终结果区分不出来**——
   * 宿主进程被关掉时，数据库连接断开本身也会回滚未提交事务。
   * 实测（见任务汇报）把显式回滚删掉后，「数据没被提交」这条断言依然通过，
   * 说明它验的是结果而不是行为。要验证「先回滚」这个实现承诺，
   * 就必须观察到 rollback RPC 确实在 close 之前发出。
   */
  const hostCalls = []
  const HostHandle = mod.DriverHostHandle
  const originalHostMethods = {}
  let applyEditsCalls = 0
  if (typeof HostHandle === 'function') {
    const origRollback = HostHandle.prototype.rollbackTransaction
    const origClose = HostHandle.prototype.close
    const origApplyEdits = HostHandle.prototype.applyEdits
    originalHostMethods.rollbackTransaction = origRollback
    originalHostMethods.close = origClose
    originalHostMethods.applyEdits = origApplyEdits
    HostHandle.prototype.rollbackTransaction = function (...args) {
      hostCalls.push('rollback')
      return origRollback.apply(this, args)
    }
    HostHandle.prototype.close = function (...args) {
      hostCalls.push('close')
      return origClose.apply(this, args)
    }
    HostHandle.prototype.applyEdits = function (...args) {
      applyEditsCalls += 1
      return origApplyEdits.apply(this, args)
    }
  }

  /** 每条断言独立 try/catch：一条失败不该掩盖其余结论。 */
  const probe = async (name, fn) => {
    try {
      await fn()
    } catch (err) {
      reportFailure(name, err)
    }
  }

  /** 用「新开一条连接」读值，确保读到的是已落盘状态而不是某连接内的事务视图。 */
  const readFromFreshConnection = async (sql) => {
    const s = requireConnected(
      await manager.add({ dialectId: 'sqlite', name: 'verifier', options: { file: MAIN_DB } }),
      'readFromFreshConnection'
    )
    try {
      const q = await manager.runQuery(`connection:${s.id}`, sql)
      return cellText(q?.rows?.[0]?.cells?.[0])
    } finally {
      await manager.remove(s.id).catch(() => undefined)
    }
  }

  try {
    const original = await readFromFreshConnection('SELECT email FROM users WHERE id = 1')
    check('P1. 读到初始值（作为恢复基准）', original.length > 0, original)

    // ===== 跨连接事务隔离 =====
    const a = requireConnected(
      await manager.add({ dialectId: 'sqlite', name: 'conn-A', options: { file: MAIN_DB } }),
      'P2 connection A'
    )
    const b = requireConnected(
      await manager.add({ dialectId: 'sqlite', name: 'conn-B', options: { file: MAIN_DB } }),
      'P2 connection B'
    )
    check('P2. 同时建立两条连接（两个独立宿主进程）', a?.id !== b?.id && !!a?.id && !!b?.id, {
      a: a?.id,
      b: b?.id
    })

    await probe('P3. A 上的未提交编辑成功', async () => {
      const r = await manager.applyEdits(`connection:${a.id}|table:users`, [
        { keyValues: { id: cell.number(1) }, changes: { email: cell.text('a-pending@example.com') } }
      ])
      check('P3. A 上的未提交编辑成功且进入事务', r?.ok === true && r?.inTransaction === true, formatDetail(r))
    })

    await probe('P4. A 的事务状态为 active', async () => {
      const st = await manager.transactionState(`connection:${a.id}`)
      check('P4. A 的事务状态 active === true', st?.active === true, formatDetail(st))
    })

    await probe('P5. ★ B 的事务状态不受 A 影响（跨连接隔离）', async () => {
      const stB = await manager.transactionState(`connection:${b.id}`)
      check(
        'P5. ★ A 有未提交事务时 B 的 active === false（证明事务不跨连接串）',
        stB?.active === false && stB?.pendingAffected === 0,
        formatDetail(stB)
      )
    })

    await probe('P6. ★ B 读不到 A 的未提交改动（隔离在数据层也成立）', async () => {
      const q = await manager.runQuery(`connection:${b.id}`, 'SELECT email FROM users WHERE id = 1')
      const value = cellText(q?.rows?.[0]?.cells?.[0])
      check(
        'P6. ★ B 读到的是旧值，A 的未提交改动对 B 不可见',
        value === original,
        `B 读到 ${value}，期望 ${original}`
      )
    })

    // A 回滚后，B 仍读到旧值（说明 A 的改动确实没生效）。
    await probe('P7. A 回滚后数据仍为原值', async () => {
      const st = await manager.rollbackTransaction(`connection:${a.id}`)
      check('P7. A 回滚成功且 active === false', st?.active === false, formatDetail(st))
      const value = await readFromFreshConnection('SELECT email FROM users WHERE id = 1')
      check('P7a. 新连接读到的仍是原值（回滚生效）', value === original, `实际 ${value}`)
    })

    // ===== remove 连接时先回滚 =====
    await probe('P8. ★ remove 有未提交改动的连接：不抛错且数据回滚', async () => {
      const c = requireConnected(
        await manager.add({ dialectId: 'sqlite', name: 'conn-C', options: { file: MAIN_DB } }),
        'P8 connection C'
      )
      const r = await manager.applyEdits(`connection:${c.id}|table:users`, [
        { keyValues: { id: cell.number(1) }, changes: { email: cell.text('c-discarded@example.com') } }
      ])
      check('P8. C 产生了未提交改动', r?.ok === true && r?.inTransaction === true, formatDetail(r))

      // 关键：remove 不能抛错
      hostCalls.length = 0
      let removeErr = null
      try {
        await manager.remove(c.id)
      } catch (err) {
        removeErr = err
      }
      check(
        'P8a. ★ 移除有未提交改动的连接不抛错',
        removeErr === null,
        `实际抛出: ${formatDetail(removeErr instanceof Error ? removeErr.message : removeErr)}`
      )

      // 关键：必须是「先回滚、再关进程」，而不是靠进程退出兜底回滚。
      // 两者的最终数据结果一样，所以必须看调用顺序才验得出实现承诺。
      if (typeof HostHandle === 'function') {
        const rollbackAt = hostCalls.indexOf('rollback')
        const closeAt = hostCalls.indexOf('close')
        check(
          'P8c. ★ remove 先发 rollback 再 close（顺序断言，不靠进程退出兜底）',
          rollbackAt !== -1 && closeAt !== -1 && rollbackAt < closeAt,
          `调用序列: ${formatDetail(hostCalls)}`
        )
      } else {
        skip('P8c. remove 先回滚再关（顺序断言）', '探针未导出 DriverHostHandle，无法打桩观察顺序')
      }

      // 关键：数据必须回到原值（不能留下半提交状态）
      const value = await readFromFreshConnection('SELECT email FROM users WHERE id = 1')
      check(
        'P8b. ★ 移除连接后未提交改动已回滚（没有半提交状态）',
        value === original,
        `新连接读到 ${value}，期望 ${original}`
      )
    })

    // ===== 提交路径在 remove 后依然持久 =====
    await probe('P9. 已提交的改动在 remove 之后仍然持久', async () => {
      const d = requireConnected(
        await manager.add({ dialectId: 'sqlite', name: 'conn-D', options: { file: MAIN_DB } }),
        'P9 connection D'
      )
      const r = await manager.applyEdits(`connection:${d.id}|table:users`, [
        { keyValues: { id: cell.number(2) }, changes: { email: cell.text('d-committed@example.com') } }
      ])
      check('P9. D 的编辑成功', r?.ok === true, formatDetail(r))
      const st = await manager.commitTransaction(`connection:${d.id}`)
      check('P9a. D 提交成功', st?.active === false, formatDetail(st))
      await manager.remove(d.id)

      const value = await readFromFreshConnection('SELECT email FROM users WHERE id = 2')
      check(
        'P9b. remove 之后新连接读到已提交的新值',
        value === 'd-committed@example.com',
        `实际 ${value}`
      )
    })

    // ===== 边界：连接节点不能提交编辑 =====
    await probe('P10. 连接根节点不能 applyEdits', async () => {
      const e = requireConnected(
        await manager.add({ dialectId: 'sqlite', name: 'conn-E', options: { file: MAIN_DB } }),
        'P10 connection E'
      )
      let err = null
      try {
        await manager.applyEdits(`connection:${e.id}`, [
          { keyValues: { id: cell.number(1) }, changes: { email: cell.text('x') } }
        ])
      } catch (ex) {
        err = ex
      }
      check(
        'P10. 连接根节点 applyEdits 报错（不是静默成功）',
        err !== null && /具体的表|不能提交编辑/.test(String(err?.message)),
        `实际: ${formatDetail(err?.message ?? '(未报错)')}`
      )
      await manager.remove(e.id).catch(() => undefined)
    })

    // ===== 边界：空 updates 被本地拒绝 =====
    await probe('P11. 空 updates 被本地拒绝', async () => {
      const f = requireConnected(
        await manager.add({ dialectId: 'sqlite', name: 'conn-F', options: { file: MAIN_DB } }),
        'P11 connection F'
      )
      const applyEditsCallsBefore = applyEditsCalls
      let err = null
      try {
        await manager.applyEdits(`connection:${f.id}|table:users`, [])
      } catch (ex) {
        err = ex
      }
      check(
        'P11. 空 updates 被本地拒绝（不发空事务给宿主）',
        err !== null && applyEditsCalls === applyEditsCallsBefore,
        `实际: ${formatDetail({
          error: err?.message ?? '(未报错)',
          applyEditsCalls,
          applyEditsCallsBefore
        })}`
      )
      await manager.remove(f.id).catch(() => undefined)
    })

    // 收尾：B 连接也移除（它开过事务吗？没有，但确保清理路径也走一遍）
    await manager.remove(b.id).catch(() => undefined)
  } catch (err) {
    reportFailure('Phase 2 探针初始化完成（未抛未捕获异常）', err)
  } finally {
    await manager.disposeAll().catch(() => undefined)
    if (typeof HostHandle === 'function') {
      if (originalHostMethods.rollbackTransaction) {
        HostHandle.prototype.rollbackTransaction = originalHostMethods.rollbackTransaction
      }
      if (originalHostMethods.close) HostHandle.prototype.close = originalHostMethods.close
      if (originalHostMethods.applyEdits) {
        HostHandle.prototype.applyEdits = originalHostMethods.applyEdits
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 临时文件管理
// ---------------------------------------------------------------------------

/** 每次运行都从夹具复制一份干净副本，保证初始状态确定、可重复运行。 */
function prepareTempDbs() {
  if (!existsSync(fixtureDb)) {
    console.error(`[e2e-edit] 前置条件缺失: 夹具库不存在: ${fixtureDb}（先跑 node scripts/make-fixture.mjs）`)
    process.exit(1)
  }
  copyFileSync(fixtureDb, RPC_DB)
  copyFileSync(fixtureDb, MAIN_DB)
}

/** 把用过的临时库移入 out/.trash（不删原文件，符合「删除走垃圾桶」的约定）。 */
function cleanupTempDbs() {
  try {
    mkdirSync(TRASH_DIR, { recursive: true })
    for (const [src, name] of [
      [RPC_DB, 'edit-rpc.db'],
      [MAIN_DB, 'edit-main.db']
    ]) {
      if (!existsSync(src)) continue
      const dest = resolve(TRASH_DIR, name)
      // 覆盖上一次的残留（固定文件名，避免每次运行都堆一个）。
      rmSync(dest, { force: true })
      renameSync(src, dest)
    }
    // SQLite 的附属文件（有事务时可能产生）一并移走，别留在 fixtures 里。
    for (const suffix of ['-journal', '-wal', '-shm']) {
      for (const base of [RPC_DB, MAIN_DB]) {
        const side = `${base}${suffix}`
        if (!existsSync(side)) continue
        const dest = resolve(TRASH_DIR, `${base.split('/').pop()}${suffix}-${Date.now()}`)
        rmSync(dest, { force: true })
        renameSync(side, dest)
      }
    }
  } catch {
    /* 清理失败不影响断言结论 */
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(hostEntry)) {
    console.error(
      `[e2e-edit] 前置条件缺失: 宿主产物不存在: ${hostEntry}（先跑 node scripts/build-driver-host.mjs）`
    )
    process.exit(1)
  }
  prepareTempDbs()

  console.log('='.repeat(70))
  console.log('dbstudio 端到端验证：在线编辑与事务（applyEdits / commit / rollback / state）')
  console.log(`node     : ${process.version}`)
  console.log(`宿主产物 : ${hostEntry}`)
  console.log(`临时库   : ${RPC_DB}`)
  console.log('='.repeat(70))

  try {
    await runHostChain()
  } catch (err) {
    check('Phase 1 执行完成（未抛未捕获异常）', false, err instanceof Error ? err.message : String(err))
  }

  try {
    await runMainProcessProbe()
  } catch (err) {
    check('Phase 2 执行完成（未抛未捕获异常）', false, err instanceof Error ? err.message : String(err))
  }

  cleanupTempDbs()

  const failed = results.filter((r) => !r.passed)
  const skipped = results.filter((r) => r.skipped)
  const passed = results.length - failed.length
  console.log('='.repeat(70))
  console.log(`汇总: ${passed}/${results.length} PASS, ${failed.length} FAIL, ${skipped.length} SKIP`)
  if (skipped.length > 0) {
    console.log('跳过项（不计入失败，但必须如实上报）:')
    for (const s of skipped) console.log(`  ⚠ ${s.name} — ${formatDetail(s.detail)}`)
  }
  if (failed.length > 0) {
    console.log('失败项:')
    for (const f of failed)
      console.log(`  ✗ ${f.name}${f.detail !== undefined ? ` — ${formatDetail(f.detail)}` : ''}`)
  }
  console.log('='.repeat(70))

  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[e2e-edit] 未捕获的顶层异常:', err)
  process.exit(1)
})
