/**
 * 结果集专项端到端验证：query / fetchResultPage / closeCursor。
 *
 * ===== 与 tests/e2e.mjs 的分工 =====
 *
 * `tests/e2e.mjs` 验的是**元数据链路**（handshake / connect / listChildren / describeTable），
 * 也就是「连接能不能建起来、树能不能读」。
 * 本文件验的是**数据链路**，即第二阶段新增的三个 RPC 方法。
 *
 * 两者刻意不共用测试代码：共用会引入「改一个坏两个」的耦合，
 * 而且让「元数据那条链没回归」这个结论不再独立——本文件挂掉不该让元数据结论失真。
 *
 * ===== 一个关键的边界说明（避免误读通过结果） =====
 *
 * 本文件在**宿主 RPC 层**对话，用的是 adapter 生成的**原生 cursorId**。
 * 而 `ConnectionManager` 会给 cursorId 加上连接前缀（`connection:c1|cur-3`）——
 * 那一层属于主进程，需要 Electron 环境，不在本文件的覆盖范围内。
 * 本文件因此**不能**证明前缀方案是对的，它只证明「前缀方案所依赖的原生游标
 * 语义（可乱序取页、可关闭、关闭后拒绝服务）在宿主侧成立」。
 * 前缀方案的验证见 Phase 2（主进程探针）与 lead 的 Electron 验收脚本。
 *
 * 运行：node tests/e2e-resultset.mjs
 * 前置：node scripts/make-fixture.mjs && node scripts/build-driver-host.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')
const fixtureDb = resolve(root, 'tests/fixtures/sample.db')

/** 单条 RPC 超时。结果集查询本身可能慢，但这里的 fixture 都是小查询，10s 足够判定「挂了」。 */
const RPC_TIMEOUT_MS = 10_000
const HANDSHAKE_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 10_000

/**
 * 用 `WITH RECURSIVE` 造 100 行，而**不往夹具里写数据**。
 *
 * 为什么这点很重要：分页断言需要「行数明显大于一页」的数据集，
 * 但夹具库是别的工作流的产物，测试不该依赖它的具体行数，
 * 更不该为了自己的断言往里面塞数据（那会让别处的断言受影响）。
 * 递归 CTE 是纯读取，随用随算，是这里最干净的造数手段。
 */
const BIG_ROWS = 100
const BIG_SQL = `WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < ${BIG_ROWS}) SELECT x FROM seq`

// ---------------------------------------------------------------------------
// 断言框架
// ---------------------------------------------------------------------------

const results = []

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

/** 跳过：不计入失败，但会在汇总里单独列出，避免「静默通过」。 */
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

/** 把任意 CellValue 渲染成可比较的文本，避免断言绑死在 adapter 的类型映射细节上。 */
function cellText(cell) {
  if (cell === null || cell === undefined) return '<undefined>'
  switch (cell.kind) {
    case 'null':
      return 'NULL'
    case 'text':
      return cell.text
    case 'number':
      return String(cell.value)
    case 'boolean':
      return String(cell.value)
    case 'blob':
      return `<blob:${cell.length}>`
    default:
      return `<unknown:${JSON.stringify(cell)}>`
  }
}

/** 取第一行第一列的可比较文本。 */
function firstCell(result) {
  const row = result?.rows?.[0]
  const cell = row?.cells?.[0]
  return cellText(cell)
}

// ---------------------------------------------------------------------------
// 宿主客户端（与 tests/e2e.mjs 同构，但独立实现）
// ---------------------------------------------------------------------------

class HostProcess {
  #child
  #pending = new Map()
  #events = []
  #exitInfo = null
  #nextId = 1
  #stderrLines = []
  #badFrames = 0
  #frameCount = 0

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
      this.#frameCount += 1
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

  get pid() {
    return this.#child.pid
  }
  get exitInfo() {
    return this.#exitInfo
  }
  get stderrText() {
    return this.#stderrLines.join('\n')
  }
  get badFrameCount() {
    return this.#badFrames
  }
  get frameCount() {
    return this.#frameCount
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

  /**
   * 调 RPC 并**期望失败**，返回该失败帧。
   *
   * 超时抛出的异常会传播出去——因为「期望失败但超时」正说明它挂死了，
   * 这恰恰是要抓的 bug，不能被当成「嗯，它失败了，通过」。
   */
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

    // ---- 未连接时 query 必须报 not_connected ----
    // 先测这条：它不依赖 adapter 的查询实现，因此即便 adapter 未就绪也有效。
    const pre = await host.callExpectFailure('2. 未连接时 query 返回 not_connected（不是超时）', 'query', {
      sql: 'SELECT 1'
    })
    check(
      '2a. not_connected 错误码正确',
      pre?.error?.code === 'not_connected',
      formatDetail(pre?.error)
    )

    // ---- connect ----
    const conn = await host.call('connect', {
      config: { dialectId: 'sqlite', name: 'rs-fixture', options: { file: fixtureDb } }
    })
    if (conn.ok !== true) {
      check('3. connect 成功', false, `connect 失败: ${formatDetail(conn.error)}`)
      return
    }
    check('3. connect 成功', true)

    // ---- 探针：query 是否已被 adapter 实现 ----
    // 若还是 unsupported_method，说明 task-16 未落地。这时**不能**把后续断言
    // 判成「失败得很含糊」——要明确报出「依赖未就绪」并停止，避免用一堆
    // 连锁失败掩盖唯一的真实原因。
    const probe = await host.call('query', { sql: 'SELECT 1' })
    if (probe.ok !== true && probe.error?.code === 'unsupported_method') {
      skip('4 及之后的结果集断言', `adapter 尚未实现 query（收到 unsupported_method）；task-16 未就绪`)
      return
    }
    if (probe.ok !== true) {
      check('4. query 可用（adapter 已实现查询）', false, `收到错误帧: ${formatDetail(probe.error)}`)
      return
    }
    check('4. query 可用（adapter 已实现查询）', true)

    // ---- 断言：SELECT 1 → 1 行 1 列 ----
    const one = probe.result
    check(
      '5. query("SELECT 1") 返回 1 行',
      Array.isArray(one?.rows) && one.rows.length === 1,
      formatDetail({ returned: one?.returned, rows: one?.rows?.length })
    )
    check(
      '6. query("SELECT 1") 返回 1 列',
      Array.isArray(one?.columns) && one.columns.length === 1,
      formatDetail(one?.columns)
    )
    check('7. SELECT 1 的值渲染为 "1"', firstCell(one) === '1', `实际: ${firstCell(one)}`)
    check(
      '8. SELECT 1 的单元格是合法 CellValue（带 kind 字段）',
      typeof one?.rows?.[0]?.cells?.[0]?.kind === 'string',
      formatDetail(one?.rows?.[0]?.cells?.[0])
    )
    check(
      '9. 结果集带 executedSql 与 elapsedMs',
      typeof one?.executedSql === 'string' &&
        one.executedSql.length > 0 &&
        typeof one?.elapsedMs === 'number',
      formatDetail({ executedSql: one?.executedSql, elapsedMs: one?.elapsedMs })
    )
    check(
      '10. 第一页 offset === 0',
      one?.offset === 0,
      `实际: ${formatDetail(one?.offset)}`
    )

    // ---- 断言：夹具表 users ----
    const users = await host.call('query', { sql: 'SELECT * FROM users' })
    if (users.ok !== true) {
      check('11. query("SELECT * FROM users") 成功', false, formatDetail(users.error))
    } else {
      check('11. query("SELECT * FROM users") 成功', true)
      const r = users.result
      check(
        '12. users 返回 3 行',
        Array.isArray(r?.rows) && r.rows.length === 3,
        `实际: ${formatDetail(r?.rows?.length)}`
      )
      const colNames = Array.isArray(r?.columns) ? r.columns.map((c) => c.name) : []
      check(
        '13. users 列名为 id / email / created_at',
        colNames.length === 3 &&
          colNames[0] === 'id' &&
          colNames[1] === 'email' &&
          colNames[2] === 'created_at',
        formatDetail(colNames)
      )
      check(
        '14. users 每行的 index 是绝对下标 0..2',
        Array.isArray(r?.rows) && r.rows.every((row, i) => row.index === i),
        formatDetail(r?.rows?.map?.((row) => row.index))
      )
      check(
        '15. users 每行单元格数与列数一致',
        Array.isArray(r?.rows) && r.rows.every((row) => row.cells.length === colNames.length),
        formatDetail(r?.rows?.map?.((row) => row.cells.length))
      )
      check(
        '16. users 列类型字段存在（结果集列元信息完整）',
        Array.isArray(r?.columns) && r.columns.every((c) => typeof c.type === 'string'),
        formatDetail(r?.columns)
      )
    }

    // ---- 断言：分页（100 行，limit=2） ----
    const page1 = await host.call('query', { sql: BIG_SQL, options: { limit: 2 } })
    if (page1.ok !== true) {
      check('17. 分页第 1 页查询成功', false, formatDetail(page1.error))
    } else {
      const p1 = page1.result
      check('17. 分页第 1 页查询成功', true)
      check(
        '18. limit=2 时第一页返回 2 行',
        Array.isArray(p1?.rows) && p1.rows.length === 2,
        formatDetail(p1?.rows?.length)
      )
      check(
        '19. 大结果集 hasMore === true（还有更多行）',
        p1?.hasMore === true,
        `实际: ${formatDetail(p1?.hasMore)}`
      )
      check(
        '20. 分页查询返回了非空 cursorId',
        typeof p1?.cursorId === 'string' && p1.cursorId.length > 0,
        formatDetail(p1?.cursorId)
      )

      const cursorId = p1?.cursorId
      if (typeof cursorId === 'string' && cursorId.length > 0) {
        // ---- 断言：fetchResultPage 拿后续页 ----
        const page2 = await host.call('fetchResultPage', { cursorId, offset: 2, limit: 2 })
        if (page2.ok !== true) {
          check('21. fetchResultPage(offset=2) 成功', false, formatDetail(page2.error))
        } else {
          const p2 = page2.result
          check('21. fetchResultPage(offset=2) 成功', true)
          check(
            '22. 第 2 页返回 2 行，且绝对值从第 3 行开始（不是重新从头取）',
            Array.isArray(p2?.rows) && p2.rows.length === 2 && p2.rows[0]?.index === 2,
            formatDetail({ len: p2?.rows?.length, firstIndex: p2?.rows?.[0]?.index })
          )
          check(
            '23. 第 2 页 offset 回显为 2',
            p2?.offset === 2,
            `实际: ${formatDetail(p2?.offset)}`
          )
          check(
            '24. 第 2 页 hasMore 仍为 true',
            p2?.hasMore === true,
            `实际: ${formatDetail(p2?.hasMore)}`
          )
          // 乱序取页是契约里的硬要求（core/driver.ts: 「必须支持乱序取页」）。
          // 往回滚是网格的常态动作，若只支持顺序流式读，往回滚就得重查。
          const back = await host.call('fetchResultPage', { cursorId, offset: 0, limit: 2 })
          check(
            '25. 支持乱序取页：拿到第 2 页后再取 offset=0 仍成功',
            back.ok === true && back.result?.rows?.[0]?.index === 0,
            formatDetail(back.ok ? back.result?.rows?.[0]?.index : back.error)
          )
          const backVals = back.ok === true ? back.result?.rows?.map((r) => cellText(r.cells[0])) : []
          const fwdVals =
            page1.result?.rows?.map((r) => cellText(r.cells[0])) ?? []
          check(
            '26. 回取 offset=0 的数据与首次第一页一致',
            JSON.stringify(backVals) === JSON.stringify(fwdVals),
            formatDetail({ back: backVals, first: fwdVals })
          )
        }

        // ---- 断言：末页 ----
        const last = await host.call('fetchResultPage', {
          cursorId,
          offset: BIG_ROWS - 1,
          limit: 5
        })
        check(
          '27. 取末页（offset=99）返回 1 行且 hasMore === false',
          last.ok === true && last.result?.rows?.length === 1 && last.result?.hasMore === false,
          formatDetail(
            last.ok
              ? { len: last.result?.rows?.length, hasMore: last.result?.hasMore }
              : last.error
          )
        )

        // ---- 断言：越界 offset 不报错，返回空页 ----
        // 界外取页要返回空而不是抛错：网格虚拟滚动会乐观地请求可视区，
        // 越界是正常情况而非异常，报错会让 UI 弹出无意义的错误。
        const beyond = await host.call('fetchResultPage', {
          cursorId,
          offset: BIG_ROWS + 50,
          limit: 5
        })
        check(
          '28. offset 越界返回空页而非报错（网格乐观请求的正常情况）',
          beyond.ok === true &&
            Array.isArray(beyond.result?.rows) &&
            beyond.result.rows.length === 0 &&
            beyond.result.hasMore === false,
          formatDetail(beyond.ok ? beyond.result : beyond.error)
        )

        // ---- 断言：closeCursor 幂等 ----
        const c1 = await host.call('closeCursor', { cursorId })
        const c2 = await host.call('closeCursor', { cursorId })
        check(
          '29. closeCursor 幂等（连调两次都成功）',
          c1.ok === true && c2.ok === true,
          formatDetail({ first: c1, second: c2 })
        )

        // ---- 断言：关闭后 fetchResultPage 必须报错而不是挂死 ----
        // 关键在「不挂死」：这条调用**不能**超时——超时意味着宿主没有回帧，
        // 那是比「报错」严重得多的问题。callExpectFailure 会把超时异常抛出来。
        let afterClose = null
        try {
          afterClose = await host.callExpectFailure(
            '30. 关闭游标后 fetchResultPage 报错（且未挂死）',
            'fetchResultPage',
            { cursorId, offset: 0, limit: 2 }
          )
        } catch (err) {
          check(
            '30. 关闭游标后 fetchResultPage 报错（且未挂死）',
            false,
            `调用超时/异常，宿主疑似挂死: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        if (afterClose) {
          check(
            '30a. 关闭后的错误码属于已知集合',
            ['object_not_found', 'query_failed', 'bad_params', 'internal'].includes(
              afterClose.error?.code
            ),
            formatDetail(afterClose.error)
          )
        }

        // ---- 断言：关闭一个不存在的游标不报错（幂等语义的另一面） ----
        const ghosts = await host.call('closeCursor', { cursorId: `${cursorId}-does-not-exist` })
        check(
          '31. 关闭不存在的游标不报错（幂等语义的另一面）',
          ghosts.ok === true,
          formatDetail(ghosts)
        )
      } else {
        check('21. fetchResultPage 需要非空 cursorId', false, `实际 cursorId: ${formatDetail(p1?.cursorId)}`)
      }
    }

    // ---- 断言：keepCursor:false 不发放游标 ----
    // 一次性查询（如 SELECT COUNT）不该占着句柄，否则大量小查询会累积泄漏。
    const noCursor = await host.call('query', {
      sql: 'SELECT COUNT(*) AS c FROM users',
      options: { keepCursor: false }
    })
    check(
      '32. keepCursor:false 时 cursorId === null（不占句柄）',
      noCursor.ok === true && noCursor.result?.cursorId === null,
      formatDetail(noCursor.ok ? noCursor.result?.cursorId : noCursor.error)
    )

    // ---- 断言：写操作被拒绝（query_failed） ----
    // 这是「宿主不做写保护、由 adapter 决定」这条分工的验证点：
    // 错误码必须是 query_failed（UI 据此提示 SQL 问题），不能是 internal（那意味着 bug）。
    let writeRes = null
    try {
      writeRes = await host.callExpectFailure(
        '33. 写操作（DELETE）被拒绝且错误码为 query_failed',
        'query',
        { sql: 'DELETE FROM users' }
      )
    } catch (err) {
      check(
        '33. 写操作（DELETE）被拒绝且错误码为 query_failed',
        false,
        `调用超时/异常: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (writeRes) {
      check(
        '33a. 写操作错误码 === query_failed（而非 internal）',
        writeRes.error?.code === 'query_failed',
        formatDetail(writeRes.error)
      )
      check(
        '33b. 写操作错误消息非空（可直接展示给用户）',
        typeof writeRes.error?.message === 'string' && writeRes.error.message.length > 0,
        formatDetail(writeRes.error)
      )
    }
    // 确认写操作真的没有生效（拒绝必须是「拒绝」，不能是「执行了但报错」）。
    const stillThree = await host.call('query', { sql: 'SELECT COUNT(*) AS c FROM users' })
    check(
      '34. 写操作未生效：users 仍是 3 行',
      stillThree.ok === true && firstCell(stillThree.result) === '3',
      formatDetail(stillThree.ok ? firstCell(stillThree.result) : stillThree.error)
    )

    // ---- 断言：语法错误 SQL 返回可展示的错误（不是 internal，也不挂死） ----
    //
    // 注意这里**不**断言具体错误码，原因是一个已报给 lead 的观察：
    // adapter 对「首词不是 SELECT/WITH/VALUES」的语句返回 `bad_params`
    // （因为它把「语句形态不支持分页包裹」归为参数问题），
    // 而对 `SELECT * FORM users` 这种「形态合法但写错」的语句返回 `query_failed`。
    // 两类**同为「用户写错 SQL」**的情况给出了不同码，UI 侧要不要区分是产品决策，
    // 不该由测试单方面钉死。所以这里只钉「必须是已知码、必须带可读消息」。
    const badSql = await host.callExpectFailure(
      '35. 语法错误的 SQL 返回可展示错误（不是 internal、不挂死）',
      'query',
      { sql: 'SELECT * FORM users' }
    )
    check(
      '35a. 语法错误错误码属于已知集合（非 internal）',
      ['query_failed', 'bad_params', 'object_not_found'].includes(badSql?.error?.code),
      formatDetail(badSql?.error)
    )
    check(
      '35b. 语法错误消息可读（含原始错误线索）',
      typeof badSql?.error?.message === 'string' && badSql.error.message.length > 0,
      formatDetail(badSql?.error)
    )

    // ---- 断言：查询不存在的表报错 ----
    const noTable = await host.callExpectFailure(
      '36. 查询不存在的表返回错误（不挂死）',
      'query',
      { sql: 'SELECT * FROM no_such_table_xyz' }
    )
    check(
      '36a. 不存在表的错误码属于已知集合',
      ['query_failed', 'object_not_found'].includes(noTable?.error?.code),
      formatDetail(noTable?.error)
    )

    // ---- 断言：参数校验（全部走 bad_params，不依赖 adapter） ----
    const badParamsCases = [
      ['query 空 sql', 'query', { sql: '' }],
      ['query 缺 sql', 'query', {}],
      ['query options.limit 为 0', 'query', { sql: 'SELECT 1', options: { limit: 0 } }],
      ['query options.limit 为负数', 'query', { sql: 'SELECT 1', options: { limit: -1 } }],
      ['query options.limit 为小数', 'query', { sql: 'SELECT 1', options: { limit: 1.5 } }],
      ['fetchResultPage offset 为负', 'fetchResultPage', { cursorId: 'x', offset: -1, limit: 1 }],
      ['fetchResultPage limit 为 0', 'fetchResultPage', { cursorId: 'x', offset: 0, limit: 0 }],
      ['fetchResultPage 缺 limit', 'fetchResultPage', { cursorId: 'x', offset: 0 }],
      ['fetchResultPage cursorId 非字符串', 'fetchResultPage', { cursorId: 7, offset: 0, limit: 1 }],
      ['closeCursor 缺 cursorId', 'closeCursor', {}]
    ]
    for (const [label, method, params] of badParamsCases) {
      const res = await host.callExpectFailure(`37. 参数校验 ${label} → bad_params`, method, params)
      check(`37a. 参数校验 ${label} 错误码正确`, res?.error?.code === 'bad_params', formatDetail(res?.error))
    }

    // ---- 断言：未知方法立即回帧 ----
    const unknown = await host.callExpectFailure('38. 未知方法返回 unsupported_method', 'nopeMethod', {})
    check(
      '38a. 未知方法错误码正确',
      unknown?.error?.code === 'unsupported_method',
      formatDetail(unknown?.error)
    )

    // ---- 断言：协议流仍然干净 ----
    check('39. stdout 协议流无污染（无非 JSON 行）', host.badFrameCount === 0, `非法帧数: ${host.badFrameCount}`)

    // ---- 断言：优雅退出 ----
    const exitCode = await host.close()
    check(
      '40. 关闭 stdin 后宿主优雅退出，退出码 === 0',
      exitCode === 0,
      `实际: ${formatDetail(exitCode)}${host.stderrText ? `；stderr: ${host.stderrText.slice(-400)}` : ''}`
    )
  } finally {
    host.kill()
  }
}

// ---------------------------------------------------------------------------
// Phase 2：主进程层探针（cursorId 作用域 + remove 清理）
//
// 这一层必须验，因为「cursorId 加连接前缀」是本任务的核心设计决策，
// 而 Phase 1 只碰得到原生游标 id，够不着前缀逻辑。
//
// 做法：用 vite 把 ConnectionManager 打成 CJS 到 out/ 下的一个探针目录
// （vite 是直接依赖，build-driver-host.mjs 已验证可用），再用系统 node 加载。
// ConnectionManager 不 import electron，所以这一步不需要 Electron 运行时。
//
// 探针产物放在 `<root>/out/.resultset-probe/` 下：DriverHostHandle 定位宿主脚本时
// 会试 `__dirname/../../out/driver-host/index.js`，从该位置正好落回真实产物，
// 因此不必给生产代码加任何「测试专用开关」。
// ---------------------------------------------------------------------------

const PROBE_DIR = resolve(root, 'out/.resultset-probe')

async function runMainProcessProbe() {
  console.log('─'.repeat(70))
  console.log('Phase 2：主进程层探针（cursorId 作用域 + remove 清理）')
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
        // 用 rollupOptions.output.entryFileNames 指定文件名，而不是 lib.fileName：
        // 实测 lib.fileName 在 cjs 格式下会被忽略、产出 .js。这里显式指定更可靠。
        rollupOptions: {
          external: [/^node:/, 'electron'],
          output: { entryFileNames: 'probe.cjs' }
        },
        lib: {
          // 关键：入口是**测试专用**的 probe-entry.ts，它把「真实注册表」与
          // ConnectionManager 打进同一个产物，让方言清单由生产代码自己产出。
          // 若直接打包 ConnectionManager.ts，测试就只能自己手写 DialectInfo 字面量，
          // 等于替注册表把答案写好——注册表漏字段时测试不会发现（这正是踩过的坑）。
          entry: resolve(root, 'tests/probe-entry.ts'),
          formats: ['cjs']
        }
      }
    })
    const probeEntry = resolve(PROBE_DIR, 'probe.cjs')
    if (!existsSync(probeEntry)) {
      // 兜底：万一 vite 版本换了行为又把名字改回去，也要能找到产物而不是误报 skip。
      const emitted = existsSync(PROBE_DIR) ? readdirSync(PROBE_DIR).filter((f) => /\.(c?js)$/.test(f)) : []
      skip(
        'Phase 2 主进程探针',
        `未找到 ${probeEntry}；目录实际产出: ${emitted.join(', ') || '(空)'}`
      )
      return
    }
    mod = await import(`file://${probeEntry}`)
  } catch (err) {
    // 探针失败不该伪装成功能通过，但也不该让「宿主层全绿」这个结论被掩盖。
    skip(
      'Phase 2 主进程探针',
      `无法构建/加载 ConnectionManager 探针: ${err instanceof Error ? err.message : String(err)}`
    )
    return
  }

  const createManager = mod.createManagerWithBuiltinDialects
  const listDialects = mod.listBuiltinDialects
  if (typeof createManager !== 'function') {
    skip('Phase 2 主进程探针', `探针模块未导出 createManagerWithBuiltinDialects（导出: ${Object.keys(mod).join(', ')}）`)
    return
  }

  // ---- 契约完整性：注册表产出的 DialectInfo 必须带 quoting（lead 新增的字段） ----
  // 这条独立成断言：它是「主进程不需要 import 驱动目录」这个设计成立的**前提**。
  try {
    const dialects = listDialects()
    check(
      'P0. registry.list() 产出的 DialectInfo 带 quoting 规则（主进程不 import driver 的前提）',
      Array.isArray(dialects) &&
        dialects.length > 0 &&
        dialects.every(
          (d) =>
            d.quoting &&
            typeof d.quoting.open === 'string' &&
            typeof d.quoting.close === 'string' &&
            (d.quoting.escape === 'double' || d.quoting.escape === 'backslash')
        ),
      formatDetail(dialects?.map?.((d) => ({ id: d.id, quoting: d.quoting })))
    )
  } catch (err) {
    check(
      'P0. registry.list() 产出的 DialectInfo 带 quoting 规则',
      false,
      err instanceof Error ? err.message : String(err)
    )
  }

  const manager = createManager()

  /**
   * 探针的执行策略：**每条断言独立 try/catch**。
   *
   * 为什么不能整段一个 try：cursorId 作用域是纯本地逻辑，不依赖 adapter 的查询实现；
   * 若因为 adapter 未就绪而在第一次 runQuery 处抛出，后面的本地断言就全被跳过，
   * 结果读起来像「作用域方案有问题」，实际只是「依赖没到位」。分开跑才能各自给出结论。
   */
  const probe = async (name, fn) => {
    try {
      await fn()
    } catch (err) {
      check(name, false, err instanceof Error ? err.message : String(err))
    }
  }

  /** 探测 adapter 是否已实现 query；未实现时返回 false，让后续断言明确 SKIP 而不是连锁 FAIL。 */
  let adapterReady = false

  try {
    const summary = await manager.add({
      dialectId: 'sqlite',
      name: 'probe',
      options: { file: fixtureDb }
    })
    check('P1. 主进程 add() 建连成功', summary?.connected === true, formatDetail(summary))
    const nodeId = `connection:${summary.id}`

    // ---- 本地断言（不依赖 adapter 的查询实现，先跑） ----

    await probe('P2. 不带前缀的 cursorId 被本地拒绝（不会盲目转发给宿主）', async () => {
      let err = null
      try {
        await manager.fetchResultPage('not-a-scoped-cursor', 0, 1)
      } catch (e) {
        err = e
      }
      check(
        'P2. 不带前缀的 cursorId 被本地拒绝（不会盲目转发给宿主）',
        err !== null && /无法解析的游标 id/.test(String(err?.message)),
        `实际: ${formatDetail(err?.message ?? '(未报错)')}`
      )
    })

    await probe('P3. 指向不存在连接的 cursorId 报「连接已断开」而非静默失败', async () => {
      let err = null
      try {
        await manager.fetchResultPage('connection:c999|cur-1', 0, 1)
      } catch (e) {
        err = e
      }
      check(
        'P3. 指向不存在连接的 cursorId 报「连接已断开」而非静默失败',
        err !== null && /连接已断开/.test(String(err?.message)),
        `实际: ${formatDetail(err?.message ?? '(未报错)')}`
      )
    })

    await probe('P4. 连接根节点不可 previewTable（报错而非生成坏 SQL）', async () => {
      let err = null
      try {
        await manager.previewTable(nodeId, 5)
      } catch (e) {
        err = e
      }
      check(
        'P4. 连接根节点不可 previewTable（报错而非生成坏 SQL）',
        err !== null && /不能预览|具体的表/.test(String(err?.message)),
        `实际: ${formatDetail(err?.message ?? '(未报错)')}`
      )
    })

    await probe('P5. 非表/视图节点不可 previewTable', async () => {
      let err = null
      try {
        await manager.previewTable(`connection:${summary.id}|folder:tables`, 5)
      } catch (e) {
        err = e
      }
      check(
        'P5. 非表/视图节点不可 previewTable',
        err !== null && /只能预览表或视图/.test(String(err?.message)),
        `实际: ${formatDetail(err?.message ?? '(未报错)')}`
      )
    })

    /**
     * P6：引号注入防护（纯本地即可验证，不需要 adapter 成功执行）。
     *
     * 这条**必须**验：`previewTable` 若退化成字符串拼接，一个名为
     * `users"; DROP TABLE x; --` 的表就能破坏语句结构。
     * 这里传一个恶意表名，断言生成出来的 SQL 里的引号被正确翻倍。
     *
     * 做法：故意让查询失败（没有这张表），但错误信息里会带上我们生成的 SQL，
     * 或者用 executedSql 断言。adapter 未就绪时，只能断言 SQL 拼接发生在
     * 出错之前——所以这条在 adapterReady 时才有完整结论。
     */
    // ---- 探测 adapter 就绪度 ----
    try {
      const probeRes = await manager.runQuery(nodeId, 'SELECT 1')
      adapterReady = probeRes?.rows?.length === 1
      check('P6. adapter 已实现 query（依赖 task-16）', adapterReady, formatDetail(probeRes))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const missingMethod = /is not a function|unsupported_method/.test(msg)
      if (missingMethod) {
        skip(
          'P6 及之后的 adapter 依赖断言',
          `SQLite adapter 尚未实现查询方法（${msg}）；task-16 未就绪，非本任务缺陷`
        )
      } else {
        check('P6. adapter 已实现 query（依赖 task-16）', false, msg)
      }
    }

    if (!adapterReady) {
      // 本地断言已经跑完，这里可以安全收尾。
      await manager.disposeAll().catch(() => undefined)
      return
    }

    // ---- 以下断言依赖 adapter ----

    await probe('P7. runQuery 返回的 cursorId 带连接作用域前缀', async () => {
      const q = await manager.runQuery(nodeId, 'SELECT * FROM users')
      check(
        'P7. runQuery 返回的 cursorId 带连接作用域前缀（connection:<cid>|...）',
        typeof q?.cursorId === 'string' && q.cursorId.startsWith(`connection:${summary.id}|`),
        `实际 cursorId: ${formatDetail(q?.cursorId)}`
      )
      check(
        'P7a. 前缀之后是 adapter 的原生游标 id 且非空',
        typeof q?.cursorId === 'string' && (q.cursorId.split('|')[1] ?? '').length > 0,
        formatDetail(q?.cursorId)
      )
    })

    await probe('P8. fetchResultPage 能用 scoped cursorId 取到后续页', async () => {
      const q = await manager.runQuery(nodeId, BIG_SQL, { limit: 4 })
      const p2 = await manager.fetchResultPage(q.cursorId, 2, 2)
      check(
        'P8. fetchResultPage 用 scoped cursorId 取到 offset=2 的页（前缀被正确还原）',
        Array.isArray(p2?.rows) && p2.rows.length === 2 && p2.rows[0]?.index === 2,
        formatDetail({ len: p2?.rows?.length, firstIndex: p2?.rows?.[0]?.index })
      )
    })

    await probe('P9. previewTable 只取 limit 行且用双引号转义表名', async () => {
      const pv = await manager.previewTable(`connection:${summary.id}|table:users`, 2)
      check(
        'P9. previewTable 只取 limit 行（不是全量拉回再截断）',
        Array.isArray(pv?.rows) && pv.rows.length === 2,
        formatDetail({ len: pv?.rows?.length, sql: pv?.executedSql })
      )
      check(
        'P9a. previewTable 生成的 SQL 用了双引号转义表名',
        typeof pv?.executedSql === 'string' && pv.executedSql.includes('"users"'),
        formatDetail(pv?.executedSql)
      )
      // 不再断言 executedSql 里有 LIMIT：分页由 adapter 在包裹子查询时落实，
      // `executedSql` 回显的是**用户语义上的**语句（`SELECT * FROM "users"`），
      // 而不是内部加壳后的最终语句。这里改为断言「真的只回来 limit 行」——
      // 那才是行为层面的证据，字符串匹配只是实现细节。
      check(
        'P9b. previewTable 通过 limit 只取 2 行（行数限制生效）',
        pv?.returned === 2 || pv?.rows?.length === 2,
        formatDetail({ returned: pv?.returned, rows: pv?.rows?.length, sql: pv?.executedSql })
      )
    })

    await probe('P10. 引号注入防护：含引号的表名被正确转义', async () => {
      // ===== 为什么这里要另开一个临时库，而不是用夹具 =====
      //
      // 要验证 quoteIdentifier，就得有一张名里带双引号的表。但**不能用 runQuery 建它**：
      // adapter 按规格拒绝一切写操作（CREATE/INSERT/UPDATE/DELETE/DROP/ALTER），
      // 走 runQuery 建表必然失败，那样这个测试会变成「依赖一个不该存在的能力」。
      //
      // 也**不能**往夹具 sample.db 里塞表：夹具是别的工作流的产物，
      // 改它会让其他测试的断言（比如「tables 恰好含 users 与 audit_log」）失真。
      //
      // 所以用 node:sqlite 直接建一个一次性的临时库，用完即弃。
      const tmpDb = resolve(root, 'tests/fixtures/.tmp-escape-probe.db')
      const evilName = 'evil"name'
      const { DatabaseSync } = await import('node:sqlite')
      // 复用同一个固定文件（用前先 DROP），而不是每次生成新文件名——
      // 否则每跑一次 CI 就在 fixtures 目录里多留一个垃圾库。
      const seed = new DatabaseSync(tmpDb)
      try {
        seed.exec('DROP TABLE IF EXISTS "evil""name"; CREATE TABLE "evil""name" (x INTEGER);')
        seed.exec('INSERT INTO "evil""name" (x) VALUES (1), (2);')
      } finally {
        seed.close()
      }

      const m2 = createManager()
      try {
        const s3 = await m2.add({ dialectId: 'sqlite', name: 'escape', options: { file: tmpDb } })
        const pv = await m2.previewTable(`connection:${s3.id}|table:${evilName}`, 2)
        check(
          'P10. 含双引号的表名被正确转义（" 翻倍为 ""）且查询成功',
          typeof pv?.executedSql === 'string' && pv.executedSql.includes('"evil""name"'),
          formatDetail(pv?.executedSql)
        )
        check(
          'P10a. 转义后的查询真的取到数据（不是只拼对了字符串）',
          Array.isArray(pv?.rows) && pv.rows.length === 2,
          formatDetail(pv?.rows?.length)
        )
        // 反证：如果实现退化成裸拼接，SQL 里会出现 `"evil"name"` 这种未翻倍形态。
        check(
          'P10b. SQL 中不存在未转义的引号形态（裸拼接反证）',
          typeof pv?.executedSql === 'string' && !/\"evil\"name\"/.test(pv.executedSql),
          formatDetail(pv?.executedSql)
        )
      } finally {
        await m2.disposeAll().catch(() => undefined)
        // 用完把临时库移进垃圾桶（不是删）。垃圾桶放在 out/ 下而不是 tests/fixtures/：
        // out/ 是构建产物目录、本就不入版本库，而 fixtures/ 里多一个隐藏目录
        // 会让「夹具目录应该只有 sample.db」这件事变得模糊。
        // 固定文件名 + 覆盖写入，保证多次运行也只留一个残留。
        try {
          const { mkdirSync, renameSync, rmSync, existsSync: exists } = await import('node:fs')
          const trash = resolve(root, 'out/.trash')
          mkdirSync(trash, { recursive: true })
          const dest = resolve(trash, 'escape-probe.db')
          if (exists(dest)) {
            // 删的是垃圾桶里**上一次**的残留，不是用户文件。
            // 用 rename 在 Windows 上会因目标存在而失败，所以这里只能覆盖。
            rmSync(dest, { force: true })
          }
          renameSync(tmpDb, dest)
        } catch {
          /* 清理失败不影响断言结论 */
        }
      }
    })

    await probe('P11. 账本可观测：查询后 openCursors > 0', async () => {
      const before = manager.stats()
      await manager.runQuery(nodeId, 'SELECT * FROM users')
      const after = manager.stats()
      check(
        'P11. stats() 显示账本里有存活游标（泄漏可观测而非隐形）',
        after.openCursors > before.openCursors,
        formatDetail({ before, after })
      )
    })

    await probe('P12. closeCursor 幂等且销账', async () => {
      const q = await manager.runQuery(nodeId, 'SELECT * FROM users')
      const before = manager.stats()
      await manager.closeCursor(q.cursorId)
      const mid = manager.stats()
      check(
        'P12. closeCursor 后账本销账',
        mid.openCursors < before.openCursors,
        formatDetail({ before, mid })
      )
      let idemErr = null
      try {
        await manager.closeCursor(q.cursorId)
      } catch (e) {
        idemErr = e
      }
      check('P12a. closeCursor 重复调用不报错（幂等）', idemErr === null, formatDetail(idemErr?.message))
    })

    await probe('P13. remove(connectionId) 清空该连接的游标账本（防内存泄漏）', async () => {
      await manager.runQuery(nodeId, 'SELECT * FROM users')
      const withCursor = manager.stats()
      check(
        'P13. remove 前账本计数 > 0（确认有东西可泄漏）',
        withCursor.openCursors > 0,
        formatDetail(withCursor)
      )
      await manager.remove(summary.id)
      const afterRemove = manager.stats()
      check(
        'P13a. remove(connectionId) 后游标账本被清空（内存泄漏防护）',
        afterRemove.openCursors === 0,
        formatDetail({ before: withCursor, after: afterRemove })
      )
      check('P13b. remove 后连接也已移除', afterRemove.connections === 0, formatDetail(afterRemove))
    })

    await probe('P14. 连接移除后旧 cursorId 报错（不误路由到别的连接）', async () => {
      let staleErr = null
      try {
        await manager.fetchResultPage(`connection:${summary.id}|cur-1`, 0, 1)
      } catch (e) {
        staleErr = e
      }
      check(
        'P14. 连接移除后旧 cursorId 报错（不静默、不误路由）',
        staleErr !== null,
        `实际: ${formatDetail(staleErr?.message ?? '(未报错)')}`
      )
    })

    await probe('P15. disposeAll 清空账本与连接', async () => {
      const s2 = await manager.add({
        dialectId: 'sqlite',
        name: 'probe2',
        options: { file: fixtureDb }
      })
      await manager.runQuery(`connection:${s2.id}`, 'SELECT * FROM users')
      check('P15. disposeAll 前有游标', manager.stats().openCursors > 0, formatDetail(manager.stats()))
      await manager.disposeAll()
      check(
        'P15a. disposeAll 后账本与连接都清空',
        manager.stats().openCursors === 0 && manager.stats().connections === 0,
        formatDetail(manager.stats())
      )
    })
  } catch (err) {
    check(
      'Phase 2 探针初始化完成（未抛未捕获异常）',
      false,
      err instanceof Error ? err.message : String(err)
    )
  } finally {
    await manager.disposeAll().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  const missing = []
  if (!existsSync(hostEntry))
    missing.push(`宿主产物不存在: ${hostEntry}（先跑 node scripts/build-driver-host.mjs）`)
  if (!existsSync(fixtureDb))
    missing.push(`夹具库不存在: ${fixtureDb}（先跑 node scripts/make-fixture.mjs）`)
  if (missing.length > 0) {
    for (const m of missing) console.error(`[e2e-resultset] 前置条件缺失: ${m}`)
    process.exit(1)
  }

  console.log('='.repeat(70))
  console.log('dbstudio 端到端验证：结果集链路（query / fetchResultPage / closeCursor）')
  console.log(`node     : ${process.version}`)
  console.log(`宿主产物 : ${hostEntry}`)
  console.log(`夹具库   : ${fixtureDb}`)
  console.log('='.repeat(70))

  try {
    await runHostChain()
  } catch (err) {
    check(
      'Phase 1 执行完成（未抛未捕获异常）',
      false,
      err instanceof Error ? err.message : String(err)
    )
  }

  try {
    await runMainProcessProbe()
  } catch (err) {
    check(
      'Phase 2 执行完成（未抛未捕获异常）',
      false,
      err instanceof Error ? err.message : String(err)
    )
  }

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
  console.error('[e2e-resultset] 未捕获的顶层异常:', err)
  process.exit(1)
})
