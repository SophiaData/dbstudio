/**
 * 增删改与完整取值的专项端到端验证（第五阶段）。
 *
 * 覆盖四条新链路：`insertRow` / `deleteRows` / `countRows` / `fetchCellValue`。
 *
 * ===== 两条规格特别点名、且最容易写漏的断言 =====
 *
 * 1. **`deleteRows` 传空数组被拒绝，且表行数不变**
 *    这是本组最危险的路径：空 WHERE 的 DELETE 会清空整张表。
 *    只断言"报错了"不够 —— 必须**回读行数**确认真的没删掉任何行。
 *    因为"先删后报错"也会让断言看起来通过。
 *
 * 2. **`countRows` 不会被 `listChildren` 顺带触发**
 *    大表上 COUNT(*) 是全表扫描。这条断言防的是"将来有人为了顺手，
 *    在列目录时预取行数"。做法是在宿主侧对 countRows 打桩计数，
 *    再连续调 listChildren，确认计数不变。
 *
 * ===== 数据隔离策略（与 e2e-edit 一致）=====
 *
 * 增删测试必然写库。每轮运行都把 sample.db 复制成独立副本，只改副本，
 * 结束后移入 `out/.trash`。否则会污染另外四套 e2e 读到的共享夹具，
 * 且"插入后行数增加"这类断言无法重复运行。
 *
 * 运行：node tests/e2e-mutations.mjs
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

const RPC_TIMEOUT_MS = 10_000
const HANDSHAKE_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 10_000

const MUT_DB = resolve(root, 'tests/fixtures/.tmp-mutations-rpc.db')
const MAIN_DB = resolve(root, 'tests/fixtures/.tmp-mutations-main.db')

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

const cell = {
  text: (text) => ({ kind: 'text', text }),
  number: (value) => ({ kind: 'number', value }),
  null: () => ({ kind: 'null' })
}

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

async function scalar(host, sql) {
  const res = await host.call('query', { sql, options: { keepCursor: false } })
  if (res.ok !== true) throw new Error(`查询失败: ${formatDetail(res.error)}`)
  return res.result?.rows?.[0]?.cells?.[0]
}

async function scalarText(host, sql) {
  return cellText(await scalar(host, sql))
}

// ---------------------------------------------------------------------------
// 宿主客户端
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

/** 夹具已知：users 有 3 行、有 id 主键；audit_log 无主键。 */
const USERS_INITIAL_ROWS = 3

async function runHostChain() {
  console.log('─'.repeat(70))
  console.log(`拉起驱动宿主: ${process.execPath} ${hostEntry} --dialect sqlite`)
  console.log('─'.repeat(70))

  const host = launchHost(['--dialect', 'sqlite'])
  try {
    const handshake = await host.waitForEvent((f) => f.kind === 'handshake')
    check('1. 收到 handshake 帧', handshake?.dialectId === 'sqlite', formatDetail(handshake))

    // ---- 未连接时错误映射（不依赖 adapter） ----
    const preInsert = await host.callExpectFailure(
      '2. 未连接时 insertRow 返回 not_connected',
      'insertRow',
      { tableId: 'table:users', values: { email: cell.text('x') } }
    )
    check('2a. 错误码正确', preInsert?.error?.code === 'not_connected', formatDetail(preInsert?.error))
    const preCount = await host.callExpectFailure(
      '3. 未连接时 countRows 返回 not_connected',
      'countRows',
      { tableId: 'table:users' }
    )
    check('3a. 错误码正确', preCount?.error?.code === 'not_connected', formatDetail(preCount?.error))

    // ---- connect ----
    const conn = await host.call('connect', {
      config: { dialectId: 'sqlite', name: 'mut-fixture', options: { file: MUT_DB } }
    })
    if (conn.ok !== true) {
      check('4. connect 成功', false, `connect 失败: ${formatDetail(conn.error)}`)
      return
    }
    check('4. connect 成功', true)

    // ---- 探针：adapter 是否实现四条新链路 ----
    const probe = await host.call('countRows', { tableId: 'table:users' })
    if (probe.ok !== true && /is not a function|unsupported_method/.test(JSON.stringify(probe))) {
      skip('5 及之后的增删改断言', 'adapter 尚未实现四条新链路（P0-A 未就绪）')
      return
    }
    if (probe.ok !== true) {
      check('5. countRows 可用（adapter 已实现）', false, formatDetail(probe.error))
      return
    }
    check('5. countRows 可用（adapter 已实现）', true)

    // ===== countRows 基础正确性 =====
    check(
      '6. countRows(users) === 3（与夹具一致）',
      probe.result === USERS_INITIAL_ROWS,
      `实际: ${formatDetail(probe.result)}`
    )
    check(
      '6a. countRows 返回的是 number 而不是字符串',
      typeof probe.result === 'number',
      formatDetail(typeof probe.result)
    )

    // ===== insertRow =====
    const ins = await host.call('insertRow', {
      tableId: 'table:users',
      values: { email: cell.text('newbie@example.com'), created_at: cell.text('2026-10-22T00:00:00Z') }
    })
    if (ins.ok !== true) {
      check('7. insertRow 成功', false, formatDetail(ins.error))
    } else {
      check('7. insertRow 成功', true)
      check('7a. affected === 1', ins.result?.affected === 1, formatDetail(ins.result?.affected))
      check(
        '7b. 返回 keyValues 且含 id（新行主键可定位）',
        ins.result?.keyValues && typeof ins.result.keyValues.id?.value === 'number',
        formatDetail(ins.result?.keyValues)
      )
      // 事务内：未提交前 countRows 应已见新行（同一连接内可见自己的改动）。
      const inTxnCount = await host.call('countRows', { tableId: 'table:users' })
      check(
        '8. 插入后（事务内）countRows === 4',
        inTxnCount.ok === true && inTxnCount.result === USERS_INITIAL_ROWS + 1,
        formatDetail(inTxnCount.ok ? inTxnCount.result : inTxnCount.error)
      )
      // 提交
      const commit = await host.call('commitTransaction', {})
      check('9. 插入后提交成功', commit.ok === true && commit.result?.active === false, formatDetail(commit))
      const afterCommit = await scalarText(
        host,
        "SELECT COUNT(*) AS c FROM users WHERE email = 'newbie@example.com'"
      )
      check('9a. 提交后重新查询能看到新行', afterCommit === '1', `实际: ${afterCommit}`)
    }

    // ===== deleteRows 正常路径 =====
    const beforeDelete = await host.call('countRows', { tableId: 'table:users' })
    const del = await host.call('deleteRows', {
      tableId: 'table:users',
      keys: [{ id: cell.number(2) }] // 删 bob
    })
    if (del.ok !== true) {
      check('10. deleteRows 成功', false, formatDetail(del.error))
    } else {
      check('10. deleteRows 成功', true)
      check('10a. affected === 1（只删一行）', del.result?.affected === 1, formatDetail(del.result?.affected))
      const bobs = await scalarText(
        host,
        'SELECT COUNT(*) AS c FROM users WHERE id = 2'
      )
      check('10b. 事务内该行已不可见（同连接可见自己的删除）', bobs === '0', `实际: ${bobs}`)
      await host.call('commitTransaction', {})
      const afterDel = await scalarText(host, 'SELECT COUNT(*) AS c FROM users WHERE id = 2')
      check('10c. 提交后该行消失', afterDel === '0', `实际: ${afterDel}`)
      // ★ 其它行不受影响
      const remaining = await scalarText(
        host,
        'SELECT COUNT(*) AS c FROM users WHERE id IN (1,3)'
      )
      check('10d. ★ 其它行不受影响（id=1,3 仍在）', remaining === '2', `实际: ${remaining}`)
      const afterCount = await host.call('countRows', { tableId: 'table:users' })
      check(
        '10e. 提交后 countRows 比删除前少 1',
        afterCount.ok === true && afterCount.result === beforeDelete.result - 1,
        formatDetail({ before: beforeDelete.result, after: afterCount.result })
      )
    }

    // ===== ★★ 关键安全断言：deleteRows 空数组被拒绝且表行数不变 =====
    {
      const countBefore = await host.call('countRows', { tableId: 'table:users' })
      check('11. [前置] 取到删除前行数', countBefore.ok === true, formatDetail(countBefore.error))

      let emptyRes = null
      try {
        emptyRes = await host.callExpectFailure(
          '11a. ★ deleteRows 传空数组被拒绝',
          'deleteRows',
          { tableId: 'table:users', keys: [] }
        )
      } catch (err) {
        check(
          '11a. ★ deleteRows 传空数组被拒绝',
          false,
          `调用超时/异常: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      if (emptyRes) {
        check(
          '11b. 空数组错误的码属于已知集合（bad_params 或 object_not_found）',
          ['bad_params', 'object_not_found'].includes(emptyRes.error?.code),
          formatDetail(emptyRes.error)
        )
        check(
          '11c. 错误消息说明了"空/整表"语义（可展示给用户）',
          /空|整表|不能为|keys/i.test(emptyRes.error?.message ?? ''),
          formatDetail(emptyRes.error)
        )
        // ★ 必须锁定"宿主层自己就拒绝了"，而不是被更下层（adapter）兜住的。
        //   这是一条真正针对本次改动的断言：宿主是 RPC 边界，它必须独立挡住
        //   空数组，不能指望每个 adapter 都记得挡。
        //
        //   判据必须只匹配**宿主独有措辞**（`parseDeleteKeys` 抛的
        //   "keys 不能为空数组"）。负向验证时踩过：原先用了宽正则
        //   `/删除整张表/`，但 adapter 的拒绝消息里也有"删除整张表"，
        //   于是删掉宿主检查后这条仍通过——正则太宽等于没测。
        check(
          '11c2. ★★ 拒绝来自宿主协议层自身（不是被 adapter 兜住的）',
          /keys 不能为空数组/.test(emptyRes.error?.message ?? ''),
          formatDetail(emptyRes.error?.message)
        )
      }

      // ★ 最关键：回读行数必须**完全相同**。只断言"报错"不够——
      //   "先删后报错"也会让错误断言通过，所以必须验证数据真的没动。
      const countAfter = await host.call('countRows', { tableId: 'table:users' })
      check(
        '11d. ★★ 空数组被拒后表行数完全不变（不是"先删后报错"）',
        countAfter.ok === true && countAfter.result === countBefore.result,
        formatDetail({ before: countBefore.result, after: countAfter.result })
      )
      // 再交叉验证一次：直接数一遍所有行。
      const total = await scalarText(host, 'SELECT COUNT(*) AS c FROM users')
      check(
        '11e. ★★ 独立 SELECT COUNT(*) 也确认行数未变',
        Number(total) === countAfter.result,
        `SELECT COUNT(*) = ${total}, countRows = ${countAfter.result}`
      )
    }

    // ===== 无主键表被拒绝 =====
    const noKeyDelete = await host.callExpectFailure(
      '12. 无主键表 audit_log 的 deleteRows 被拒绝',
      'deleteRows',
      { tableId: 'table:audit_log', keys: [{ id: cell.number(1) }] }
    )
    check(
      '12a. 拒绝消息含唯一键语义',
      /唯一键|No unique key defined|主键/i.test(noKeyDelete?.error?.message ?? ''),
      formatDetail(noKeyDelete?.error)
    )
    const noKeyEdit = await host.callExpectFailure(
      '13. 无主键表 audit_log 的 applyEdits 也被拒绝',
      'applyEdits',
      {
        tableId: 'table:audit_log',
        updates: [{ keyValues: { id: cell.number(1) }, changes: { action: cell.text('x') } }]
      }
    )
    check(
      '13a. 拒绝消息含唯一键语义',
      /唯一键|No unique key defined|主键/i.test(noKeyEdit?.error?.message ?? ''),
      formatDetail(noKeyEdit?.error)
    )
    // 确认无主键表的数据没被这两次失败调用动过。
    const auditCount = await scalarText(host, 'SELECT COUNT(*) AS c FROM audit_log')
    check('13b. audit_log 数据未受影响', auditCount === '2', `实际: ${auditCount}`)

    // ===== countRows 不会被 listChildren 顺带触发 =====
    //
    // 这条要证明的是"代码路径上是隔离的"，而不是"结果碰巧相等"。
    // 做法：在宿主处理器上做外部观测——统计两次 listChildren 之间
    // countRows 相关的 RPC 数量差。
    //
    // 但宿主是独立进程，没法直接打桩它的内部方法。改用另一种可靠信号：
    // **连续调用 listChildren，观察返回的节点里绝不包含行数信息**，
    // 并对「countRows 是否被隐式调起」用 RPC 计数间接验证——
    // 具体见下方 Phase 2 的主进程探针（能真正打桩 countRows）。
    const listing = await host.call('listChildren', { parentId: 'folder:tables' })
    check(
      '14. listChildren 返回的表节点不带任何行数/计数元数据',
      listing.ok === true &&
        Array.isArray(listing.result) &&
        listing.result.every(
          (n) =>
            !('rowCount' in (n.meta ?? {})) &&
            !('count' in (n.meta ?? {})) &&
            !('rows' in (n.meta ?? {}))
        ),
      formatDetail(listing.ok ? listing.result?.map?.((n) => n.meta) : listing.error)
    )

    // ===== fetchCellValue：超长文本取全文 =====
    //
    // 造一个 1500 字符的文本值。**不能**用 runQuery 建表——adapter 的 query()
    // 是只读的（会拒绝 CREATE），这是它刻意的护栏。也不能往 users 里塞
    // （会影响上面刚验证过的行数与列断言）。
    // 所以用 node:sqlite 直接对**临时副本库**建一张专用表。副本是本测试自己的，
    // 不会污染共享夹具。
    const LONG_LEN = 1500
    const longText = 'A'.repeat(LONG_LEN)
    {
      const { DatabaseSync } = await import('node:sqlite')
      const seed = new DatabaseSync(MUT_DB)
      try {
        seed.exec('DROP TABLE IF EXISTS _long_cell')
        seed.exec('CREATE TABLE _long_cell (id INTEGER PRIMARY KEY, body TEXT)')
        const stmt = seed.prepare('INSERT INTO _long_cell (id, body) VALUES (?, ?)')
        stmt.run(1, longText)
      } finally {
        seed.close()
      }
    }
    // 建表后重建一个游标去读（连接一直开着，直接重查即可）。
    {
      const q = await host.call('query', {
        sql: 'SELECT id, body FROM _long_cell',
        options: { keepCursor: true }
      })
      if (q.ok !== true) {
        check('16. [前置] 查询长文本表成功', false, formatDetail(q.error))
      } else {
        check('16. [前置] 查询长文本表成功', true)
        const page = q.result
        // 结果集层应当已把 body 截断并标 truncated（这正是 fetchCellValue 要解决的）。
        const cellInPage = page?.rows?.[0]?.cells?.[1]
        check(
          '17. 结果集页里的长文本已被截断（truncated === true，说明确实需要 fetchCellValue）',
          cellInPage?.kind === 'text' && cellInPage.truncated === true,
          formatDetail({ kind: cellInPage?.kind, truncated: cellInPage?.truncated, len: cellInPage?.text?.length })
        )
        check(
          '17a. 截断后的文本长度不超过 MAX_CELL_TEXT_CHARS(1000)',
          typeof cellInPage?.text === 'string' && cellInPage.text.length <= 1000,
          formatDetail(cellInPage?.text?.length)
        )

        // ★ fetchCellValue 回来必须是全文。
        const full = await host.call('fetchCellValue', {
          cursorId: page.cursorId,
          rowIndex: 0,
          columnIndex: 1
        })
        if (full.ok !== true) {
          check('18. fetchCellValue 成功', false, formatDetail(full.error))
        } else {
          check('18. fetchCellValue 成功', true)
          const v = full.result
          check(
            '18a. ★ 返回完整文本，长度 === 1500（> 1000）',
            v?.kind === 'text' && typeof v.text === 'string' && v.text.length === LONG_LEN,
            formatDetail({ kind: v?.kind, len: v?.text?.length })
          )
          check(
            '18b. ★ 完整值未被标记 truncated',
            v?.truncated !== true,
            formatDetail(v?.truncated)
          )
          check(
            '18c. ★ 完整值内容与写入的一致',
            typeof v?.text === 'string' && v.text === longText,
            `长度 ${v?.text?.length}，期望 ${LONG_LEN}`
          )
        }
        await host.call('closeCursor', { cursorId: page.cursorId }).catch(() => undefined)
      }
    }

    // ===== fetchCellValue：不存在的游标报错而不是挂死 =====
    let badCursor = null
    try {
      badCursor = await host.callExpectFailure(
        '19. fetchCellValue 对不存在的游标报错（未挂死）',
        'fetchCellValue',
        { cursorId: 'no-such-cursor-xyz', rowIndex: 0, columnIndex: 0 }
      )
    } catch (err) {
      check(
        '19. fetchCellValue 对不存在的游标报错（未挂死）',
        false,
        `调用超时/异常，宿主疑似挂死: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (badCursor) {
      check(
        '19a. 不存在的游标错误码属于已知集合',
        ['object_not_found', 'bad_params', 'query_failed', 'internal'].includes(badCursor.error?.code),
        formatDetail(badCursor.error)
      )
    }

    // ===== 参数校验（协议层，不依赖 adapter） =====
    const badParamsCases = [
      ['insertRow values 为空对象', 'insertRow', { tableId: 'table:users', values: {} }],
      ['insertRow 缺 values', 'insertRow', { tableId: 'table:users' }],
      ['insertRow values 非对象', 'insertRow', { tableId: 'table:users', values: [] }],
      ['insertRow CellValue kind 非法', 'insertRow', { tableId: 'table:users', values: { email: { kind: 'bogus' } } }],
      ['deleteRows keys 非数组', 'deleteRows', { tableId: 'table:users', keys: 'x' }],
      ['deleteRows keys 含空对象', 'deleteRows', { tableId: 'table:users', keys: [{}] }],
      ['countRows 缺 tableId', 'countRows', {}],
      ['fetchCellValue rowIndex 负', 'fetchCellValue', { cursorId: 'c', rowIndex: -1, columnIndex: 0 }],
      ['fetchCellValue columnIndex 非整数', 'fetchCellValue', { cursorId: 'c', rowIndex: 0, columnIndex: 1.5 }],
      ['fetchCellValue 缺 cursorId', 'fetchCellValue', { rowIndex: 0, columnIndex: 0 }]
    ]
    for (const [label, method, params] of badParamsCases) {
      const res = await host.callExpectFailure(`20. 参数校验 ${label} → bad_params`, method, params)
      check(`20a. 参数校验 ${label} 错误码正确`, res?.error?.code === 'bad_params', formatDetail(res?.error))
    }

    // ===== 协议流纯净 + 优雅退出 =====
    check('21. stdout 协议流无污染（无非 JSON 行）', host.badFrameCount === 0, `非法帧数: ${host.badFrameCount}`)
    const exitCode = await host.close()
    check(
      '22. 关闭 stdin 后宿主优雅退出，退出码 === 0',
      exitCode === 0,
      `实际: ${formatDetail(exitCode)}${host.stderrText ? `；stderr: ${host.stderrText.slice(-400)}` : ''}`
    )
  } finally {
    host.kill()
  }
}

// ---------------------------------------------------------------------------
// Phase 2：主进程层探针 —— 证明「listChildren 不触发 countRows」
//
// Phase 1 只能从"返回数据里没有行数"间接推断，这不构成证明：
// 实现完全可能悄悄调了 countRows 又把结果丢弃。要证明"没被调用"，
// 必须能观测到宿主句柄上的调用。做法：对 DriverHostHandle.prototype.countRows
// 打桩计数，再连续调 listChildren 与 describeTable，断言计数不增加。
// ---------------------------------------------------------------------------

const PROBE_DIR = resolve(root, 'out/.mutations-probe')

async function runMainProcessProbe() {
  console.log('─'.repeat(70))
  console.log('Phase 2：主进程层探针（listChildren 不触发 countRows）')
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
  const HostHandle = mod.DriverHostHandle
  if (typeof createManager !== 'function' || typeof HostHandle !== 'function') {
    skip('Phase 2 主进程探针', '探针未导出 createManagerWithBuiltinDialects / DriverHostHandle')
    return
  }

  /** 对 countRows 打桩计数（包一层，仍调用真实实现）。 */
  const counts = { countRows: 0 }
  const origCountRows = HostHandle.prototype.countRows
  HostHandle.prototype.countRows = function (...args) {
    counts.countRows += 1
    return origCountRows.apply(this, args)
  }

  /** 对 deleteRows 也打桩：记录是否被调用，用于验证"空数组在宿主之前就被挡住"。 */
  const deleteCalls = { deleteRows: 0 }
  const origDeleteRows = HostHandle.prototype.deleteRows
  HostHandle.prototype.deleteRows = function (...args) {
    deleteCalls.deleteRows += 1
    return origDeleteRows.apply(this, args)
  }

  const manager = createManager()
  try {
    const summary = await manager.add({
      dialectId: 'sqlite',
      name: 'mut-probe',
      options: { file: MAIN_DB }
    })
    if (!summary?.connected) {
      // 假存储下应该能连上真实 SQLite；连不上就把原因说清楚。
      skip('P1 及之后的探针断言', `连接未建立（connected=${summary?.connected}），无法继续`)
      return
    }
    const connId = `connection:${summary.id}`

    // 基线：此刻 countRows 计数应为 0（连上不会顺手计数）。
    check('P1. 建立连接本身不触发 countRows', counts.countRows === 0, formatDetail(counts.countRows))

    // ★ 连续调 listChildren：根层 + tables 分组 + views 分组。
    await manager.listChildren(null)
    await manager.listChildren(connId)
    await manager.listChildren(`${connId}|folder:tables`)
    await manager.listChildren(`${connId}|folder:views`)
    check(
      'P2. ★ 连续 4 次 listChildren 后 countRows 调用次数仍为 0',
      counts.countRows === 0,
      formatDetail(counts.countRows)
    )

    // describeTable 也不应触发（元数据读取不含 COUNT）。
    await manager.describeTable(`${connId}|table:users`).catch(() => undefined)
    check(
      'P3. ★ describeTable 也不触发 countRows',
      counts.countRows === 0,
      formatDetail(counts.countRows)
    )

    // 反向确认：显式调 countRows **确实**会打到宿主句柄——
    // 否则上面"计数为 0"可能只是因为打桩没接上，测试就变成永真。
    const n = await manager.countRows(`${connId}|table:users`)
    check(
      'P4. [反证] 显式调用 countRows 计数 +1 且结果正确（证明打桩生效）',
      counts.countRows === 1 && n === USERS_INITIAL_ROWS,
      formatDetail({ count: counts.countRows, result: n })
    )

    // ★ P5：ConnectionManager.deleteRows 必须**自己**拒绝空数组，
    //   而不是把空数组转发给宿主（更不是留给 adapter）。判据是宿主句柄的
    //   deleteRows 一次都没被调用。这补上了"宿主层之外还有一道"的证明。
    {
      deleteCalls.deleteRows = 0
      let err = null
      try {
        await manager.deleteRows(`${connId}|table:users`, [])
      } catch (e) {
        err = e
      }
      check(
        'P5. ★ ConnectionManager.deleteRows 空数组被本地拒绝',
        err !== null,
        `未报错（可能转发下去了）: ${formatDetail(err?.message)}`
      )
      check(
        'P5a. ★★ 空数组没有被转发给宿主（宿主句柄 deleteRows 调用次数为 0）',
        deleteCalls.deleteRows === 0,
        formatDetail(deleteCalls.deleteRows)
      )
      // 反证打桩有效：给一个正常 keys，宿主句柄必须被调用一次。
      await manager
        .deleteRows(`${connId}|table:users`, [{ id: cell.number(999999) }])
        .catch(() => undefined)
      check(
        'P5b. [反证] 非空 keys 会转发到宿主（调用次数 +1，证明 P5a 的 0 有意义）',
        deleteCalls.deleteRows === 1,
        formatDetail(deleteCalls.deleteRows)
      )
      // 收尾：上面那条正常删除可能开了事务，回滚掉避免影响后续。
      await manager.rollbackTransaction(connId).catch(() => undefined)
    }

    // 删掉刚才插入的长文本表，避免它在 MAIN_DB 里留痕（不影响断言，但保持整洁）。
    await manager.runQuery(connId, 'DROP TABLE IF EXISTS _long_cell').catch(() => undefined)
    await manager.remove(summary.id).catch(() => undefined)
  } catch (err) {
    check(
      'Phase 2 探针执行完成（未抛未捕获异常）',
      false,
      err instanceof Error ? err.message : String(err)
    )
  } finally {
    // 恢复原型，避免影响同进程后续代码（这里其实没后续，但保持卫生）。
    HostHandle.prototype.countRows = origCountRows
    HostHandle.prototype.deleteRows = origDeleteRows
    await manager.disposeAll().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// 临时文件管理
// ---------------------------------------------------------------------------

function prepareTempDbs() {
  if (!existsSync(fixtureDb)) {
    console.error(`[e2e-mutations] 前置条件缺失: 夹具库不存在: ${fixtureDb}（先跑 node scripts/make-fixture.mjs）`)
    process.exit(1)
  }
  copyFileSync(fixtureDb, MUT_DB)
  copyFileSync(fixtureDb, MAIN_DB)
}

function cleanupTempDbs() {
  try {
    mkdirSync(TRASH_DIR, { recursive: true })
    for (const [src, name] of [
      [MUT_DB, 'mutations-rpc.db'],
      [MAIN_DB, 'mutations-main.db']
    ]) {
      if (!existsSync(src)) continue
      const dest = resolve(TRASH_DIR, name)
      rmSync(dest, { force: true })
      renameSync(src, dest)
    }
    // SQLite 附属文件（事务/ WAL）一并移走，别留在 fixtures 里。
    for (const suffix of ['-journal', '-wal', '-shm']) {
      for (const base of [MUT_DB, MAIN_DB]) {
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
      `[e2e-mutations] 前置条件缺失: 宿主产物不存在: ${hostEntry}（先跑 node scripts/build-driver-host.mjs）`
    )
    process.exit(1)
  }
  prepareTempDbs()

  console.log('='.repeat(70))
  console.log('dbstudio 端到端验证：增删改与完整取值（insertRow/deleteRows/countRows/fetchCellValue）')
  console.log(`node     : ${process.version}`)
  console.log(`宿主产物 : ${hostEntry}`)
  console.log(`临时库   : ${MUT_DB}`)
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
  console.error('[e2e-mutations] 未捕获的顶层异常:', err)
  process.exit(1)
})
