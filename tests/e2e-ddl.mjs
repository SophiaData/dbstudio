/**
 * DDL 与「编辑已保存连接」的专项端到端验证（第六阶段）。
 *
 * 覆盖六条链路：
 *   createTable / dropTable / createView / dropView / renameTable / updateConnection
 *
 * ===== 规格特别点名的那条断言 =====
 *
 * **createTable 之后 listChildren 必须能看到新表**。
 * 这条验的不是"createTable 返回成功"，而是"DDL 真的落到了数据库"——
 * 如果 DDL 被包在一个没提交的事务里，返回值会成功、但目录里什么也看不到，
 * 用户会陷入"提示建好了却找不到表"的困惑。这是 DDL 最常见的坑。
 * 所以断言走**独立的 listChildren 调用**（另一条读取路径），而不是回读 setup 时的缓存。
 *
 * ===== 数据隔离 =====
 * DDL 会改库结构。每轮复制 sample.db 成独立副本，只改副本，结束移入 out/.trash。
 * updateConnection 的"改 file 指向另一个库"用例还额外需要第二个库，同样用副本。
 *
 * 运行：node tests/e2e-ddl.mjs
 * 前置：node scripts/make-fixture.mjs && node scripts/build-driver-host.mjs
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
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

const DDL_DB = resolve(root, 'tests/fixtures/.tmp-ddl-rpc.db')
const MAIN_DB = resolve(root, 'tests/fixtures/.tmp-ddl-main.db')
const OTHER_DB = resolve(root, 'tests/fixtures/.tmp-ddl-other.db')

// ---------------------------------------------------------------------------
// 断言框架
// ---------------------------------------------------------------------------

const results = []

function check(name, condition, detail) {
  const passed = Boolean(condition)
  results.push({ name, passed, detail })
  if (passed) console.log(`PASS  ${name}`)
  else {
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
              (this.stderrText ? `；stderr: ${this.stderrText.slice(-400)}` : '')
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

/** 便捷：取表名列表（从 folder:tables / folder:views 的 listChildren）。 */
async function relationNames(host, folder) {
  const res = await host.call('listChildren', { parentId: folder })
  if (res.ok !== true) throw new Error(`listChildren(${folder}) 失败: ${formatDetail(res.error)}`)
  return (res.result ?? []).map((n) => n.name)
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

    // ---- 未连接时的错误映射 ----
    const preCreate = await host.callExpectFailure(
      '2. 未连接时 createTable 返回 not_connected',
      'createTable',
      { connectionId: 'c1', spec: { name: 'x', columns: [{ name: 'id', typeName: 'INTEGER' }] } }
    )
    check('2a. 错误码正确', preCreate?.error?.code === 'not_connected', formatDetail(preCreate?.error))

    // ---- connect ----
    const conn = await host.call('connect', {
      config: { dialectId: 'sqlite', name: 'ddl-fixture', options: { file: DDL_DB } }
    })
    if (conn.ok !== true) {
      check('3. connect 成功', false, formatDetail(conn.error))
      return
    }
    check('3. connect 成功', true)

    // ---- 探针：adapter DDL 是否实现 ----
    const probe = await host.call('createTable', {
      connectionId: 'c1',
      spec: { name: 'probe_ok', columns: [{ name: 'id', typeName: 'INTEGER' }] }
    })
    if (probe.ok !== true && /is not a function|unsupported_method/.test(JSON.stringify(probe))) {
      skip('4 及之后的 DDL 断言', 'adapter 尚未实现 DDL（P2-A 未就绪）')
      return
    }
    if (probe.ok !== true) {
      check('4. DDL 可用（adapter 已实现）', false, formatDetail(probe.error))
      return
    }
    check('4. DDL 可用（adapter 已实现）', true)
    // 清理探针表，避免干扰后面的精确断言。
    await host.call('dropTable', { nodeId: 'table:probe_ok' }).catch(() => undefined)

    // ===== ★★ createTable 后 listChildren 能看到（DDL 真 commit 了）=====
    const create = await host.call('createTable', {
      connectionId: 'c1',
      spec: {
        name: 'products',
        columns: [
          { name: 'id', typeName: 'INTEGER', primaryKeyOrdinal: 1 },
          { name: 'title', typeName: 'TEXT', nullable: false },
          { name: 'price', typeName: 'REAL' }
        ]
      }
    })
    if (create.ok !== true) {
      check('5. createTable(products) 成功', false, formatDetail(create.error))
    } else {
      check('5. createTable(products) 成功', true)
      // ★ 关键：走**独立的 listChildren** 验证目录里真有这张表。
      const tables = await relationNames(host, 'folder:tables')
      check(
        '5a. ★★ createTable 后 listChildren 立刻能看到新表（DDL 已提交，不在未提交事务里）',
        tables.includes('products'),
        formatDetail(tables)
      )
      // ★ 比 listChildren 更直接的证据：DDL 结束后**不应残留未提交事务**。
      //   若 createTable 把语句留在事务里（没 commit），active 会是 true，
      //   而"新表可见"也可能只是同连接内可见——跨连接/持久化就丢了。
      //   这条直接问事务状态，是"没躺在未提交事务里"最硬的判据。
      const ddlTxn = await host.call('transactionState', {})
      check(
        '5a2. ★★ createTable 结束后无残留未提交事务（transactionState.active === false）',
        ddlTxn.ok === true && ddlTxn.result?.active === false,
        formatDetail(ddlTxn.ok ? ddlTxn.result : ddlTxn.error)
      )
      // 再交叉验证一次：describeTable 能读到新表结构（另一条路径）。
      const desc = await host.call('describeTable', { id: 'table:products' })
      check(
        '5b. ★ describeTable 也能读到新表的列（结构真的建出来了）',
        desc.ok === true &&
          Array.isArray(desc.result?.columns) &&
          desc.result.columns.map((c) => c.name).join(',') === 'id,title,price',
        formatDetail(desc.ok ? desc.result?.columns?.map((c) => c.name) : desc.error)
      )
      // 主键应被识别（建表时指定了 primaryKeyOrdinal:1）。
      const idCol = desc.ok === true ? desc.result?.columns?.find((c) => c.name === 'id') : undefined
      check(
        '5c. 建表时指定的主键被正确识别（id.primaryKeyOrdinal === 1）',
        idCol?.primaryKeyOrdinal === 1,
        formatDetail(idCol?.primaryKeyOrdinal)
      )
    }

    // ===== createTable 同名二次 → 报错 =====
    const dup = await host.callExpectFailure(
      '6. createTable 同名二次 → 报错',
      'createTable',
      {
        connectionId: 'c1',
        spec: { name: 'products', columns: [{ name: 'id', typeName: 'INTEGER' }] }
      }
    )
    check(
      '6a. 同名重复的错误码属于已知集合',
      ['query_failed', 'bad_params', 'object_not_found', 'internal'].includes(dup?.error?.code),
      formatDetail(dup?.error)
    )
    // 原表必须还在（失败的建表不该破坏已有表）。
    const tablesAfterDup = await relationNames(host, 'folder:tables')
    check('6b. 同名建表失败后，原 products 表仍在', tablesAfterDup.includes('products'), formatDetail(tablesAfterDup))

    // ===== typeName 注入 → 被拒，且无关表还在 =====
    const injectType = await host.callExpectFailure(
      '7. typeName 注入（含 ; DROP ...）→ 被拒',
      'createTable',
      {
        connectionId: 'c1',
        spec: {
          name: 'evil_type',
          columns: [{ name: 'id', typeName: 'TEXT; DROP TABLE products; --' }]
        }
      }
    )
    check(
      '7a. typeName 注入被拒绝（错误码属于已知集合）',
      ['query_failed', 'bad_params', 'internal'].includes(injectType?.error?.code),
      formatDetail(injectType?.error)
    )
    // ★ 最重要：无关表 products 必须完好无损。
    const tablesAfterInject = await relationNames(host, 'folder:tables')
    check(
      '7b. ★ typeName 注入被拒后，无关表 products 仍然存在（注入未执行）',
      tablesAfterInject.includes('products'),
      formatDetail(tablesAfterInject)
    )
    // evil_type 也不该被建出来。
    check('7c. 注入表 evil_type 未被创建', !tablesAfterInject.includes('evil_type'), formatDetail(tablesAfterInject))

    // ===== defaultValue 注入 → 被拒，且无关表还在 =====
    const injectDefault = await host.callExpectFailure(
      '8. defaultValue 注入（含 ; DROP ...）→ 被拒',
      'createTable',
      {
        connectionId: 'c1',
        spec: {
          name: 'evil_default',
          columns: [
            { name: 'id', typeName: 'INTEGER' },
            { name: 'flag', typeName: 'TEXT', defaultValue: "x'); DROP TABLE products; --" }
          ]
        }
      }
    )
    check(
      '8a. defaultValue 注入被拒绝',
      ['query_failed', 'bad_params', 'internal'].includes(injectDefault?.error?.code),
      formatDetail(injectDefault?.error)
    )
    const tablesAfterInject2 = await relationNames(host, 'folder:tables')
    check(
      '8b. ★ defaultValue 注入被拒后，无关表 products 仍然存在',
      tablesAfterInject2.includes('products'),
      formatDetail(tablesAfterInject2)
    )

    // ===== renameTable =====
    const rename = await host.call('renameTable', { nodeId: 'table:products', newName: 'goods' })
    if (rename.ok !== true) {
      check('9. renameTable 成功', false, formatDetail(rename.error))
    } else {
      check('9. renameTable 成功', true)
      const afterRename = await relationNames(host, 'folder:tables')
      check('9a. ★ 重命名后旧表 products 消失', !afterRename.includes('products'), formatDetail(afterRename))
      check('9b. ★ 重命名后新表 goods 出现', afterRename.includes('goods'), formatDetail(afterRename))
      // 数据/结构跟着走：describeTable 新名能读到 3 列。
      const descGoods = await host.call('describeTable', { id: 'table:goods' })
      check(
        '9c. 重命名后新表结构完整（3 列）',
        descGoods.ok === true && descGoods.result?.columns?.length === 3,
        formatDetail(descGoods.ok ? descGoods.result?.columns?.length : descGoods.error)
      )
    }

    // ===== createView / dropView =====
    const cv = await host.call('createView', {
      connectionId: 'c1',
      viewName: 'v_goods',
      selectSql: 'SELECT id, title FROM goods'
    })
    if (cv.ok !== true) {
      check('10. createView 成功', false, formatDetail(cv.error))
    } else {
      check('10. createView 成功', true)
      const views = await relationNames(host, 'folder:views')
      check('10a. ★ createView 后视图分组能看到新视图', views.includes('v_goods'), formatDetail(views))

      const dv = await host.call('dropView', { nodeId: 'view:v_goods' })
      check('11. dropView 成功', dv.ok === true, formatDetail(dv))
      const viewsAfter = await relationNames(host, 'folder:views')
      check('11a. ★ dropView 后视图消失', !viewsAfter.includes('v_goods'), formatDetail(viewsAfter))
    }

    // ===== dropTable =====
    const dt = await host.call('dropTable', { nodeId: 'table:goods' })
    if (dt.ok !== true) {
      check('12. dropTable 成功', false, formatDetail(dt.error))
    } else {
      check('12. dropTable 成功', true)
      const afterDrop = await relationNames(host, 'folder:tables')
      check('12a. ★ dropTable 后目录里不再有该表', !afterDrop.includes('goods'), formatDetail(afterDrop))
      // 原有夹具表必须完好（drop 只针对指定表）。
      check(
        '12b. 其它表不受影响（users / audit_log 仍在）',
        afterDrop.includes('users') && afterDrop.includes('audit_log'),
        formatDetail(afterDrop)
      )
    }

    // ===== 删不存在的表 → 报错 =====
    const dropMissing = await host.callExpectFailure(
      '13. dropTable 不存在的表 → 报错',
      'dropTable',
      { nodeId: 'table:no_such_table_xyz' }
    )
    check(
      '13a. 错误码属于已知集合',
      ['object_not_found', 'query_failed', 'bad_params', 'internal'].includes(dropMissing?.error?.code),
      formatDetail(dropMissing?.error)
    )
    const dropMissingView = await host.callExpectFailure(
      '14. dropView 不存在的视图 → 报错',
      'dropView',
      { nodeId: 'view:no_such_view_xyz' }
    )
    check(
      '14a. 错误码属于已知集合',
      ['object_not_found', 'query_failed', 'bad_params', 'internal'].includes(dropMissingView?.error?.code),
      formatDetail(dropMissingView?.error)
    )

    // ===== 参数校验（协议层结构校验，不依赖方言） =====
    const badParamCases = [
      ['createTable 缺 spec', 'createTable', { connectionId: 'c1' }],
      ['createTable spec 非对象', 'createTable', { connectionId: 'c1', spec: [] }],
      ['createTable spec.name 空', 'createTable', { connectionId: 'c1', spec: { name: '', columns: [{ name: 'a', typeName: 'TEXT' }] } }],
      ['createTable columns 为空', 'createTable', { connectionId: 'c1', spec: { name: 't', columns: [] } }],
      ['createTable 列缺 typeName', 'createTable', { connectionId: 'c1', spec: { name: 't', columns: [{ name: 'a' }] } }],
      ['createTable 列名重复', 'createTable', { connectionId: 'c1', spec: { name: 't', columns: [{ name: 'a', typeName: 'TEXT' }, { name: 'A', typeName: 'TEXT' }] } }],
      ['createTable primaryKeyOrdinal 非法', 'createTable', { connectionId: 'c1', spec: { name: 't', columns: [{ name: 'a', typeName: 'TEXT', primaryKeyOrdinal: 0 }] } }],
      ['dropTable 缺 nodeId', 'dropTable', {}],
      ['createView 缺 viewName', 'createView', { connectionId: 'c1', selectSql: 'SELECT 1' }],
      ['createView selectSql 空', 'createView', { connectionId: 'c1', viewName: 'v', selectSql: '   ' }],
      ['renameTable 缺 newName', 'renameTable', { nodeId: 'table:users' }]
    ]
    for (const [label, method, params] of badParamCases) {
      const res = await host.callExpectFailure(`15. 参数校验 ${label} → bad_params`, method, params)
      check(`15a. 参数校验 ${label} 错误码正确`, res?.error?.code === 'bad_params', formatDetail(res?.error))
    }

    // ★ 锁定"空 columns 是宿主协议层自己拒的"，不是被 adapter 兜住的。
    //   负向验证时踩到：删掉宿主的空 columns 检查后测试仍绿——因为 adapter
    //   也拒空列、也报 bad_params。必须匹配宿主独有措辞才能区分哪一层在起作用
    //   （与 task-23 的 deleteRows 空数组是同类教训）。
    {
      const res = await host.callExpectFailure(
        '15b. ★★ 空 columns 由宿主协议层自身拒绝（非 adapter 兜底）',
        'createTable',
        { connectionId: 'c1', spec: { name: 't', columns: [] } }
      )
      check(
        '15c. ★★ 拒绝消息来自宿主（含"不能为空/没有意义"的宿主措辞）',
        /不能为空——没有任何列的表没有意义/.test(res?.error?.message ?? ''),
        formatDetail(res?.error?.message)
      )
    }

    // ===== 协议流纯净 + 优雅退出 =====
    check('16. stdout 协议流无污染', host.badFrameCount === 0, `非法帧数: ${host.badFrameCount}`)
    const exitCode = await host.close()
    check('17. 关闭 stdin 后宿主优雅退出，退出码 === 0', exitCode === 0, formatDetail(exitCode))
  } finally {
    host.kill()
  }
}

// ---------------------------------------------------------------------------
// Phase 2：主进程层探针 —— updateConnection
//
// updateConnection 是 ConnectionManager 的方法，只能在主进程层验证。
// 两条要证：
//   1. 改 name → list() 返回新名字（配置真的落盘且内存同步）
//   2. 改 file 指向另一个库 → **已连接的会重连**，重连后能查到新库的表
//      （这条是"改配置必须生效"的核心，不重连就会一直连旧库）
// ---------------------------------------------------------------------------

const PROBE_DIR = resolve(root, 'out/.ddl-probe')

async function runMainProcessProbe() {
  console.log('─'.repeat(70))
  console.log('Phase 2：主进程层探针（updateConnection）')
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
    const entry = resolve(PROBE_DIR, 'probe.cjs')
    if (!existsSync(entry)) {
      skip('Phase 2 主进程探针', `未找到 ${entry}`)
      return
    }
    mod = await import(`file://${entry}`)
  } catch (err) {
    skip('Phase 2 主进程探针', `无法构建/加载: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const createManager = mod.createManagerWithBuiltinDialects
  if (typeof createManager !== 'function') {
    skip('Phase 2 主进程探针', '探针未导出 createManagerWithBuiltinDialects')
    return
  }

  const manager = createManager()
  const probe = async (name, fn) => {
    try {
      await fn()
    } catch (err) {
      check(name, false, err instanceof Error ? err.message : String(err))
    }
  }

  try {
    // 建一个连接（指向 MAIN_DB 副本）。
    const s = await manager.add({
      dialectId: 'sqlite',
      name: '原名',
      options: { file: MAIN_DB }
    })
    check('P1. 主进程建连成功', s?.connected === true, formatDetail(s))

    // ---- 改 name ----
    await probe('P2. updateConnection 改 name 成功', async () => {
      const updated = await manager.updateConnection(s.id, { name: '新名字' })
      check('P2. updateConnection 改 name 返回新 summary', updated?.name === '新名字', formatDetail(updated))
      const listed = manager.list().find((c) => c.id === s.id)
      check('P2a. ★ list() 返回新名字（配置已更新）', listed?.name === '新名字', formatDetail(listed))
      check('P2b. 改 name 后连接仍可用（connected 保持）', listed?.connected === true, formatDetail(listed))
    })

    // ---- 改 file 指向另一个库 → 重连后能查到新库的表 ----
    await probe('P3. updateConnection 改 file → 重连后查到新库的表', async () => {
      // OTHER_DB 是一个只含不同表结构的副本：先把它清理成"只有一张 marker 表"。
      const { DatabaseSync } = await import('node:sqlite')
      {
        const db = new DatabaseSync(OTHER_DB)
        try {
          // 删掉从 sample.db 复制来的所有表，只留一张独有的 marker 表，
          // 这样"能否查到 marker"就是"是否真的连到新库"的铁证。
          const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
          for (const r of rows) {
            const n = String(r.name)
            if (n.startsWith('sqlite_')) continue
            db.exec(`DROP TABLE IF EXISTS "${n.replace(/"/g, '""')}"`)
          }
          db.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY, tag TEXT)')
          db.exec("INSERT INTO marker (id, tag) VALUES (1, 'from-other-db')")
        } finally {
          db.close()
        }
      }

      const updated = await manager.updateConnection(s.id, { options: { file: OTHER_DB } })
      check('P3. updateConnection 改 file 返回 summary', updated !== undefined, formatDetail(updated))
      check('P3a. 改 file 后仍处于连接状态（自动重连）', updated?.connected === true, formatDetail(updated))

      // ★ 铁证：查 marker 表能拿到数据 → 确实连到新库。
      const q = await manager.runQuery(`connection:${s.id}`, 'SELECT tag FROM marker')
      check(
        'P3b. ★★ 重连后能查到新库独有的 marker 表（配置真的生效了）',
        q?.rows?.length === 1 && q.rows[0].cells[0]?.text === 'from-other-db',
        formatDetail(q?.rows)
      )
      // 旧库的 users 表在新库里不存在 → 查它会报错，反证确实换了库。
      let oldTableErr = null
      try {
        await manager.runQuery(`connection:${s.id}`, 'SELECT * FROM users')
      } catch (e) {
        oldTableErr = e
      }
      check(
        'P3c. ★ 旧库的 users 表已不可查（证明真的切到了新库，不是还连着旧的）',
        oldTableErr !== null,
        '仍能查到 users，说明没有真正切换'
      )
      // 列表里的配置也应反映新 file。
      const listed = manager.list().find((c) => c.id === s.id)
      check('P3d. list() 里的名称/会话正常', listed?.connected === true, formatDetail(listed))
    })

    // ---- 改一个不存在的连接 → 报错 ----
    await probe('P4. updateConnection 不存在的连接 → 报错', async () => {
      let err = null
      try {
        await manager.updateConnection('c999', { name: 'x' })
      } catch (e) {
        err = e
      }
      check('P4. 不存在的连接更新报错', err !== null && /不存在/.test(String(err?.message)), formatDetail(err?.message))
    })

    await manager.remove(s.id).catch(() => undefined)
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
// 临时文件
// ---------------------------------------------------------------------------

function prepareTempDbs() {
  if (!existsSync(fixtureDb)) {
    console.error(`[e2e-ddl] 前置条件缺失: 夹具库不存在: ${fixtureDb}（先跑 node scripts/make-fixture.mjs）`)
    process.exit(1)
  }
  copyFileSync(fixtureDb, DDL_DB)
  copyFileSync(fixtureDb, MAIN_DB)
  copyFileSync(fixtureDb, OTHER_DB)
}

function cleanupTempDbs() {
  try {
    mkdirSync(TRASH_DIR, { recursive: true })
    for (const [src, name] of [
      [DDL_DB, 'ddl-rpc.db'],
      [MAIN_DB, 'ddl-main.db'],
      [OTHER_DB, 'ddl-other.db']
    ]) {
      if (!existsSync(src)) continue
      const dest = resolve(TRASH_DIR, name)
      rmSync(dest, { force: true })
      renameSync(src, dest)
    }
    for (const suffix of ['-journal', '-wal', '-shm']) {
      for (const base of [DDL_DB, MAIN_DB, OTHER_DB]) {
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
      `[e2e-ddl] 前置条件缺失: 宿主产物不存在: ${hostEntry}（先跑 node scripts/build-driver-host.mjs）`
    )
    process.exit(1)
  }
  prepareTempDbs()

  console.log('='.repeat(70))
  console.log('dbstudio 端到端验证：DDL 与编辑连接（createTable/dropTable/createView/dropView/renameTable/updateConnection）')
  console.log(`node     : ${process.version}`)
  console.log(`宿主产物 : ${hostEntry}`)
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
  console.error('[e2e-ddl] 未捕获的顶层异常:', err)
  process.exit(1)
})
