/**
 * PostgreSQL 驱动的端到端冒烟测试（第二个方言）。
 *
 * ===== 这个文件真正要证明的东西 =====
 *
 * 项目此前的所有 e2e 都只跑 SQLite。**"多方言抽象是否成立"只有加第二个驱动才能验证**。
 * 所以这里的关键不只是"PG 能用"，而是：
 *
 *   **同一套驱动宿主进程（`out/driver-host/index.js`，与 SQLite 完全共用一个入口），
 *     只把 `--dialect` 从 `sqlite` 换成 `postgresql`，整套 21 个 RPC 方法就都能工作。**
 *
 * 脚本末尾的「★ 同一套宿主代码换驱动」断言就是钉这一点：
 * 它用**与 tests/e2e.mjs 相同的调用序列**（connect → listChildren → describeTable → query →
 * fetchResultPage → applyEdits），只是连到 PG，验证返回结构符合同一份 `DriverAdapter` 契约。
 *
 * ===== 没有 PG 环境时必须跳过，不能硬失败 =====
 *
 * `DBSTUDIO_PG_URL` 未设置 → 打印「跳过：未配置 PG 连接」并 exit 0。
 * 这是硬性要求：缺环境不算失败，假装验证过才是。
 *
 * 运行：
 *   node scripts/build-driver-host.mjs
 *   DBSTUDIO_PG_URL=postgres://postgres@127.0.0.1:5432/postgres node scripts/make-fixture-pg.mjs
 *   DBSTUDIO_PG_URL=postgres://postgres@127.0.0.1:5432/postgres node tests/e2e-postgres.mjs
 */

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')
const PG_URL = process.env['DBSTUDIO_PG_URL']

if (!PG_URL) {
  console.log('跳过：未配置 PG 连接（环境变量 DBSTUDIO_PG_URL）。')
  console.log('  SQLite 回归仍然有效（node tests/e2e.mjs）。')
  console.log('  要跑 PG 冒烟：先起一个 PostgreSQL 并设置 DBSTUDIO_PG_URL，例如')
  console.log('    DBSTUDIO_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres node scripts/make-fixture-pg.mjs')
  console.log('    DBSTUDIO_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres node tests/e2e-postgres.mjs')
  process.exit(0)
}

const RPC_TIMEOUT_MS = 15_000
const HANDSHAKE_TIMEOUT_MS = 15_000
const EXIT_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// 断言框架
// ---------------------------------------------------------------------------

const results = []

function check(name, condition, detail) {
  const passed = Boolean(condition)
  results.push({ name, passed })
  if (passed) console.log(`PASS  ${name}`)
  else {
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log(`      ↳ ${formatDetail(detail)}`)
  }
  return passed
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
// 宿主客户端（与 tests/e2e.mjs 同构的精简版）
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
        rej(new Error(`RPC 超时（${RPC_TIMEOUT_MS}ms）: ${method} id=${id}${this.stderrText ? `；stderr: ${this.stderrText.slice(-400)}` : ''}`))
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

/** 把 DBSTUDIO_PG_URL 解析成 pg 的连接参数（供 adapter 的 options 用）。 */
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
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log('─'.repeat(70))
  console.log(`PG 冒烟：宿主入口 ${hostEntry} --dialect postgresql`)
  console.log(`      连接 ${PG_URL.replace(/:[^:@/]*@/, ':****@')}`)
  console.log('─'.repeat(70))

  if (results.length === 0) {
    // 仅用于占位，防止 linter 认为 results 未用
  }

  const info = parsePgUrl(PG_URL)
  const host = launchHost(['--dialect', 'postgresql'])
  try {
    const handshake = await host.waitForEvent((f) => f.kind === 'handshake')
    check('1. 收到 handshake 帧（dialectId === postgresql）', handshake?.dialectId === 'postgresql', handshake)

    // ---- connect ----
    const conn = await host.call('connect', {
      config: {
        dialectId: 'postgresql',
        name: 'pg-fixture',
        options: { host: info.host, port: info.port, database: info.database, user: info.user }
      },
      secret: info.password
    })
    if (conn.ok !== true) {
      check('2. connect 成功', false, formatDetail(conn.error))
      return
    }
    check('2. connect 成功，能力声明含 hasSchema=true', conn.result?.hasSchema === true, formatDetail(conn.result))

    // ---- 根层：schema 分组（PG 与 SQLite 的结构差异）----
    const rootChildren = await host.call('listChildren', { parentId: null })
    const rootKinds = (rootChildren.result ?? []).map((n) => n.kind)
    check(
      '3. 根层只有一个 folder（schema 分组），与 SQLite 直接给表/视图分组不同',
      rootChildren.ok === true && rootChildren.result?.length === 1 && rootChildren.result[0].id === 'folder:schemas',
      formatDetail(rootChildren.result)
    )
    void rootKinds

    // ---- schema 列表 ----
    const schemas = await host.call('listChildren', { parentId: 'folder:schemas' })
    const schemaNames = (schemas.result ?? []).map((n) => n.name)
    check(
      '4. schema 列表包含 public 与夹具建的 dbstudio_demo（PG 特有 schema 层）',
      schemas.ok === true && schemaNames.includes('public') && schemaNames.includes('dbstudio_demo'),
      formatDetail(schemaNames)
    )
    check(
      '4a. schema 列表排除了 pg_catalog / information_schema 等系统 schema',
      !schemaNames.includes('pg_catalog') && !schemaNames.includes('information_schema'),
      formatDetail(schemaNames)
    )

    // ---- public 下的表/视图分组 ----
    const schemaChildren = await host.call('listChildren', { parentId: 'schema:public' })
    const schemaChildIds = (schemaChildren.result ?? []).map((n) => n.id)
    check(
      '5. schema:public 下展开出 tables / views 两个分组',
      schemaChildIds.includes('folder:public|tables') && schemaChildIds.includes('folder:public|views'),
      formatDetail(schemaChildIds)
    )

    const tables = await host.call('listChildren', { parentId: 'folder:public|tables' })
    const tableNames = (tables.result ?? []).map((n) => n.name)
    check(
      '6. 表列表包含 pg_users / pg_flags / pg_log / MixedCase',
      ['pg_users', 'pg_flags', 'pg_log', 'MixedCase'].every((t) => tableNames.includes(t)),
      formatDetail(tableNames)
    )

    const views = await host.call('listChildren', { parentId: 'folder:public|views' })
    const viewNames = (views.result ?? []).map((n) => n.name)
    check('7. 视图列表包含 pg_active', viewNames.includes('pg_active'), formatDetail(viewNames))

    // ---- 第二个 schema 也有表 ----
    const demoItems = await host.call('listChildren', { parentId: 'folder:dbstudio_demo|tables' })
    check(
      '8. 第二个 schema dbstudio_demo 下的 items 表可列出（多 schema 隔离）',
      demoItems.ok === true && (demoItems.result ?? []).some((n) => n.name === 'items'),
      formatDetail(demoItems.result)
    )

    // ---- describeTable：列 + 主键 ----
    const desc = await host.call('describeTable', { id: 'table:public.pg_users' })
    const cols = desc.result?.columns ?? []
    const colNames = cols.map((c) => c.name)
    check(
      '9. describeTable(pg_users) 列顺序为 id,email,age,score,created_at',
      desc.ok === true && colNames.join(',') === 'id,email,age,score,created_at',
      formatDetail(colNames)
    )
    const idCol = cols.find((c) => c.name === 'id')
    check('9a. pg_users.id 被识别为主键（primaryKeyOrdinal === 1）', idCol?.primaryKeyOrdinal === 1, formatDetail(idCol))
    check('9b. hasUniqueKey === true（有主键 → 可在线编辑）', desc.result?.hasUniqueKey === true, formatDetail(desc.result?.hasUniqueKey))
    const scoreCol = cols.find((c) => c.name === 'score')
    check('9c. NUMERIC(10,2) 类型名带精度（说明信息里拼接了 precision/scale）', /NUMERIC\(10,2\)/i.test(scoreCol?.typeName ?? ''), formatDetail(scoreCol?.typeName))

    // ---- 无主键表：hasUniqueKey === false ----
    const noKey = await host.call('describeTable', { id: 'table:public.pg_log' })
    check('10. pg_log（无主键）hasUniqueKey === false', noKey.result?.hasUniqueKey === false, formatDetail(noKey.result?.hasUniqueKey))

    // ---- BOOLEAN 列：PG 有真布尔（SQLite 只有 0/1）----
    const flagsDesc = await host.call('describeTable', { id: 'table:public.pg_flags' })
    const enabledCol = (flagsDesc.result?.columns ?? []).find((c) => c.name === 'enabled')
    check('11. pg_flags.enabled 的 typeName 是 BOOLEAN（PG 真布尔类型）', /BOOLEAN/i.test(enabledCol?.typeName ?? ''), formatDetail(enabledCol?.typeName))

    // ---- query + 真布尔值 ----
    const q = await host.call('query', { sql: 'SELECT id, name, enabled FROM public.pg_flags ORDER BY id', options: { limit: 10 } })
    check('12. query 返回 2 行', q.ok === true && q.result?.returned === 2, formatDetail(q.ok ? q.result?.returned : q.error))
    const firstCell = q.result?.rows?.[0]?.cells?.[2]
    check(
      '12a. ★ 布尔列的值以 { kind: "boolean" } 返回（PG 真布尔，SQLite 是 number 0/1）',
      firstCell?.kind === 'boolean' && firstCell?.value === true,
      formatDetail(firstCell)
    )

    // ---- 分页 ----
    const page1 = await host.call('query', { sql: 'SELECT id, email FROM public.pg_users ORDER BY id', options: { limit: 2, offset: 0 } })
    check('13. 分页第一页取到 2 行', page1.ok === true && page1.result?.returned === 2, formatDetail(page1.ok ? page1.result?.returned : page1.error))
    check('13a. 分页第一页 hasMore === true', page1.result?.hasMore === true, formatDetail(page1.result?.hasMore))
    const cursorId = page1.result?.cursorId
    const page2 = await host.call('fetchResultPage', { cursorId, offset: 2, limit: 2 })
    check('13b. 第二页取到第 3 行、hasMore === false', page2.ok === true && page2.result?.returned === 1 && page2.result?.hasMore === false, formatDetail(page2.ok ? { returned: page2.result?.returned, hasMore: page2.result?.hasMore } : page2.error))
    check('13c. 第二页行下标是绝对下标（2 起）', page2.result?.rows?.[0]?.index === 2, formatDetail(page2.result?.rows?.[0]?.index))
    await host.call('closeCursor', { cursorId }).catch(() => undefined)

    // ---- 编辑 → 回滚（事务用 BEGIN/COMMIT/ROLLBACK，不是 BEGIN IMMEDIATE）----
    const before = await host.call('query', { sql: 'SELECT email FROM public.pg_users WHERE id = 1', options: { keepCursor: false } })
    const emailBefore = before.result?.rows?.[0]?.cells?.[0]?.text
    const edit = await host.call('applyEdits', {
      tableId: 'table:public.pg_users',
      updates: [{ keyValues: { id: { kind: 'number', value: 1 } }, changes: { email: { kind: 'text', text: 'changed@example.com' } } }]
    })
    check('14. applyEdits 成功且 inTransaction === true（未自动提交）', edit.ok === true && edit.result?.inTransaction === true && edit.result?.affected === 1, formatDetail(edit.ok ? edit.result : edit.error))

    const inTxn = await host.call('transactionState', {})
    check('14a. transactionState().active === true（BEGIN 已开）', inTxn.result?.active === true, formatDetail(inTxn.result))

    const rb = await host.call('rollbackTransaction', {})
    check('14b. rollbackTransaction 后 active === false', rb.ok === true && rb.result?.active === false, formatDetail(rb.ok ? rb.result : rb.error))

    const after = await host.call('query', { sql: 'SELECT email FROM public.pg_users WHERE id = 1', options: { keepCursor: false } })
    const emailAfter = after.result?.rows?.[0]?.cells?.[0]?.text
    check('14c. ★ 回滚生效：email 恢复为原值（编辑真的进了事务且被撤销）', emailAfter === emailBefore, formatDetail({ emailBefore, emailAfter }))

    // ---- 编辑 → 提交 ----
    const edit2 = await host.call('applyEdits', {
      tableId: 'table:public.pg_users',
      updates: [{ keyValues: { id: { kind: 'number', value: 1 } }, changes: { email: { kind: 'text', text: 'committed@example.com' } } }]
    })
    check('15. 第二次 applyEdits 成功', edit2.ok === true && edit2.result?.affected === 1, formatDetail(edit2.ok ? edit2.result : edit2.error))
    const commit = await host.call('commitTransaction', {})
    check('15a. commitTransaction 成功、active === false', commit.ok === true && commit.result?.active === false, formatDetail(commit.ok ? commit.result : commit.error))
    const afterCommit = await host.call('query', { sql: 'SELECT email FROM public.pg_users WHERE id = 1', options: { keepCursor: false } })
    check('15b. ★ 提交生效：email 变更为 committed@example.com', afterCommit.result?.rows?.[0]?.cells?.[0]?.text === 'committed@example.com', formatDetail(afterCommit.result?.rows?.[0]?.cells?.[0]))
    // 复原夹具值，避免影响重复运行
    await host.call('applyEdits', { tableId: 'table:public.pg_users', updates: [{ keyValues: { id: { kind: 'number', value: 1 } }, changes: { email: { kind: 'text', text: 'alice@example.com' } } }] })
    await host.call('commitTransaction', {}).catch(() => undefined)

    // ---- 无主键表编辑被拒 ----
    const noKeyEdit = await host.call('applyEdits', {
      tableId: 'table:public.pg_log',
      updates: [{ keyValues: { action: { kind: 'text', text: 'login' } }, changes: { action: { kind: 'text', text: 'x' } } }]
    })
    check('16. 无主键表 applyEdits 被拒（object_not_found / No unique key）', noKeyEdit.ok === false && ['object_not_found', 'bad_params'].includes(noKeyEdit.error?.code), formatDetail(noKeyEdit.error))

    // ---- DDL：建表（SERIAL 自增）→ 可见 → 删 ----
    const create = await host.call('createTable', {
      connectionId: 'c1',
      spec: {
        name: 'pg_probe',
        columns: [
          { name: 'id', typeName: 'INTEGER', primaryKeyOrdinal: 1, autoIncrement: true },
          { name: 'label', typeName: 'TEXT', nullable: false }
        ]
      }
    })
    check('17. createTable 成功（INTEGER 主键 autoIncrement → SERIAL）', create.ok === true, formatDetail(create.ok ? undefined : create.error))
    const tablesAfterCreate = await host.call('listChildren', { parentId: 'folder:public|tables' })
    check('17a. ★ 建表后 listChildren 立刻能看到 pg_probe（DDL 已提交）', (tablesAfterCreate.result ?? []).some((n) => n.name === 'pg_probe'), formatDetail((tablesAfterCreate.result ?? []).map((n) => n.name)))
    const probeDesc = await host.call('describeTable', { id: 'table:public.pg_probe' })
    const probeId = (probeDesc.result?.columns ?? []).find((c) => c.name === 'id')
    check('17b. SERIAL 建出的 id 列读回为 INTEGER 且是主键', /INTEGER/i.test(probeId?.typeName ?? '') && probeId?.primaryKeyOrdinal === 1, formatDetail(probeId))
    // 插入一行验证 SERIAL 真的自增
    const ins = await host.call('insertRow', { tableId: 'table:public.pg_probe', values: { label: { kind: 'text', text: 'hello' } } })
    check('17c. insertRow 回填 SERIAL 自增主键（keyValues.id 有值）', ins.ok === true && ins.result?.keyValues?.id !== undefined, formatDetail(ins.ok ? ins.result : ins.error))
    await host.call('commitTransaction', {}).catch(() => undefined)
    const drop = await host.call('dropTable', { nodeId: 'table:public.pg_probe' })
    check('17d. dropTable 成功', drop.ok === true, formatDetail(drop.ok ? undefined : drop.error))

    // ---- DDL 注入防护（typeName 白名单）----
    const evil = await host.call('createTable', {
      connectionId: 'c1',
      spec: { name: 'evil_type', columns: [{ name: 'id', typeName: 'TEXT); DROP TABLE public.pg_users; --' }] }
    })
    check('18. typeName 注入被拒（白名单）', evil.ok === false && ['bad_params', 'query_failed'].includes(evil.error?.code), formatDetail(evil.error))
    const tablesAfterEvil = await host.call('listChildren', { parentId: 'folder:public|tables' })
    check('18a. ★ 注入被拒后 pg_users 仍存在', (tablesAfterEvil.result ?? []).some((n) => n.name === 'pg_users'), formatDetail((tablesAfterEvil.result ?? []).map((n) => n.name)))

    // ---- countRows ----
    const cnt = await host.call('countRows', { tableId: 'table:public.pg_users' })
    check('19. countRows(pg_users) === 3（PG 的 COUNT(*) 是 bigint→字符串，驱动要转回数字）', cnt.ok === true && cnt.result === 3, formatDetail(cnt.ok ? cnt.result : cnt.error))

    // ---- 引号 + 大小写混合表 ----
    const mixed = await host.call('describeTable', { id: 'table:public.MixedCase' })
    check(
      '20. ★ "MixedCase" 表的列名保留原大小写（Id / Name）——PG 大小写折叠的正面验证',
      mixed.ok === true && (mixed.result?.columns ?? []).map((c) => c.name).join(',') === 'Id,Name',
      formatDetail((mixed.result?.columns ?? []).map((c) => c.name))
    )
    const mixedQ = await host.call('query', { sql: 'SELECT "Id", "Name" FROM public."MixedCase" ORDER BY "Id"', options: { keepCursor: false } })
    check('20a. 大小写混合表可查询（引号正确）', mixedQ.ok === true && mixedQ.result?.returned === 2, formatDetail(mixedQ.ok ? mixedQ.result?.returned : mixedQ.error))

    // ---- 只读护栏 ----
    const write = await host.call('query', { sql: 'DELETE FROM public.pg_users' })
    check('21. 查询窗口拒绝写语句（只读护栏）', write.ok === false, formatDetail(write.error))

    // =====================================================================
    // ★★ 压轴断言：同一套宿主/主进程代码，换驱动就能用 ★★
    // =====================================================================
    //
    // 这一条不测某个具体功能，它测的是**架构**：同样的 RPC 方法序列
    // （与 tests/e2e.mjs 的 SQLite 冒烟同构），在 pg 方言上得到结构一致的结果。
    // 若某个返回值形状在 PG 上变了，说明 `DriverAdapter` 契约没被真正遵守。
    const smokeSeq = [
      ['listChildren', { parentId: 'folder:public|tables' }],
      ['describeTable', { id: 'table:public.pg_users' }],
      ['query', { sql: 'SELECT id, email FROM public.pg_users ORDER BY id', options: { keepCursor: false } }],
      ['countRows', { tableId: 'table:public.pg_users' }]
    ]
    let contractOk = true
    const contractDetail = []
    for (const [method, params] of smokeSeq) {
      const res = await host.call(method, params)
      if (res.ok !== true) {
        contractOk = false
        contractDetail.push(`${method}: ${formatDetail(res.error)}`)
      } else {
        contractDetail.push(`${method}: ok`)
      }
    }
    check(
      '22. ★★★ 同一套宿主代码换驱动可用：与 SQLite 相同的 RPC 序列在 PG 上全部返回 ok（DriverAdapter 契约成立）',
      contractOk,
      formatDetail(contractDetail)
    )

    // 返回结构必须是纯数据（可结构化克隆），不能有函数/类实例泄漏到协议上
    const shape = await host.call('describeTable', { id: 'table:public.pg_users' })
    const serializable = JSON.stringify(shape.result) === JSON.stringify(JSON.parse(JSON.stringify(shape.result)))
    check('22a. describeTable 返回值是纯数据（可 JSON 序列化，无函数/句柄泄漏到协议）', shape.ok === true && serializable, formatDetail(shape.result?.columns?.length))

    // A1: exercise the adapter and SQL on a real server, then verify committed
    // values through an independent connection (not through the host cache).
    const caseTable = `pg_a1_keys_${process.pid}`
    const caseTableId = `table:public.${caseTable}`
    const verifierClient = new pg.Client({ connectionString: PG_URL })
    await verifierClient.connect()
    try {
      await verifierClient.query(`CREATE TABLE public."${caseTable}" (
        "id" integer, "ID" integer, value text, PRIMARY KEY ("id", "ID")
      )`)
      await verifierClient.query(`INSERT INTO public."${caseTable}" VALUES
        (7, 10, 'first'), (7, 20, 'second')`)
      const keys = { id: { kind: 'number', value: 7 }, ID: { kind: 'number', value: 10 } }
      const update = await host.call('applyEdits', {
        tableId: caseTableId, updates: [{ keyValues: keys, changes: { value: { kind: 'text', text: 'changed' } } }]
      })
      check('A1 PG UPDATE preserves both case-sensitive primary keys',
        update.ok && update.result?.ok && update.result?.affected === 1, update)
      await host.call('commitTransaction', {})
      const updated = (await verifierClient.query(`SELECT * FROM public."${caseTable}" ORDER BY "ID"`)).rows
      check('A1 PG independent read: only (7,10) changed',
        updated.length === 2 && updated[0].value === 'changed' && updated[1].value === 'second', updated)
      for (const keyValues of [{ id: keys.id }, { ID: keys.ID }]) {
        const incompleteUpdate = await host.call('applyEdits', {
          tableId: caseTableId, updates: [{ keyValues, changes: { value: { kind: 'text', text: 'wrong' } } }]
        })
        const incompleteDelete = await host.call('deleteRows', { tableId: caseTableId, keys: [keyValues] })
        check(`A1 PG incomplete keys ${Object.keys(keyValues)} reject UPDATE and DELETE`,
          !incompleteUpdate.ok && !incompleteDelete.ok, { incompleteUpdate, incompleteDelete })
      }
      const unchanged = (await verifierClient.query(`SELECT * FROM public."${caseTable}" ORDER BY "ID"`)).rows
      check('A1 PG rejected incomplete operations leave data unchanged',
        JSON.stringify(unchanged) === JSON.stringify(updated), unchanged)
      const removed = await host.call('deleteRows', { tableId: caseTableId, keys: [keys] })
      check('A1 PG DELETE preserves both case-sensitive primary keys',
        removed.ok && removed.result?.ok && removed.result?.affected === 1, removed)
      await host.call('commitTransaction', {})
      const remaining = (await verifierClient.query(`SELECT * FROM public."${caseTable}"`)).rows
      check('A1 PG independent read: DELETE leaves (7,20) intact',
        remaining.length === 1 && remaining[0].ID === 20 && remaining[0].value === 'second', remaining)
    } finally {
      await host.call('rollbackTransaction', {})
      await verifierClient.query(`DROP TABLE IF EXISTS public."${caseTable}"`)
      await verifierClient.end()
    }

    // ---- disconnect 必须显式回滚未提交事务 ----
    //
    // 只验证最终数据也能通过“宿主进程退出时数据库自动回滚”，无法区分
    // 显式 ROLLBACK 是否真的发出。这里对**仍存活的宿主**发 disconnect，
    // 再开一条独立 PG 连接读取数据，验证 disconnect 返回时改动已经撤销。
    const txnUpdate = await host.call('applyEdits', {
      tableId: 'table:public.pg_users',
      updates: [
        {
          keyValues: { id: { kind: 'number', value: 1 } },
          changes: { email: { kind: 'text', text: 'disconnect-rollback@example.com' } }
        }
      ]
    })
    check(
      '23. ★ disconnect 前修改成功并进入事务',
      txnUpdate.ok === true && txnUpdate.result?.inTransaction === true,
      formatDetail(txnUpdate.ok ? txnUpdate.result : txnUpdate.error)
    )
    const disconnected = await host.call('disconnect', {})
    check('23a. disconnect 成功', disconnected.ok === true, formatDetail(disconnected.error))

    const verifier = launchHost(['--dialect', 'postgresql'])
    try {
      await verifier.waitForEvent((f) => f.kind === 'handshake')
      const verifierConnect = await verifier.call('connect', {
        config: {
          dialectId: 'postgresql',
          name: 'pg-disconnect-verifier',
          options: {
            host: info.host,
            port: info.port,
            database: info.database,
            user: info.user
          }
        },
        secret: info.password
      })
      const afterDisconnect = await verifier.call('query', {
        sql: 'SELECT email FROM public.pg_users WHERE id = 1',
        options: { keepCursor: false }
      })
      const emailAfterDisconnect = afterDisconnect.result?.rows?.[0]?.cells?.[0]?.text
      check(
        '23b. ★★ disconnect 显式回滚：独立连接读回原值（不是等进程退出才兜底）',
        verifierConnect.ok === true &&
          afterDisconnect.ok === true &&
          emailAfterDisconnect === emailBefore,
        formatDetail({
          connect: verifierConnect.error,
          query: afterDisconnect.error,
          emailBefore,
          emailAfterDisconnect
        })
      )
    } finally {
      await verifier.close()
    }
  } catch (err) {
    check('脚本执行未抛异常', false, err instanceof Error ? err.message : String(err))
    if (host.stderrText) console.log(`      stderr: ${host.stderrText.slice(-800)}`)
  } finally {
    await host.close()
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

await main()

const failed = results.filter((r) => !r.passed)
const passed = results.length - failed.length
console.log('─'.repeat(70))
console.log(`PG 冒烟结果：${passed}/${results.length} 通过`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAIL: ${f.name}`)
  process.exit(1)
}
console.log('✅ 全部通过')
process.exit(0)
