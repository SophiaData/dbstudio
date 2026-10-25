/**
 * 语句执行契约端到端测试 (Statement Execution E2E)
 *
 * 验证 DriverAdapter.executeStatement 与驱动宿主 RPC:
 * 1. 未连接时拒绝并返回 not_connected
 * 2. SELECT 语句返回 { kind: 'rows', result: QueryResult }
 * 3. DML 语句 (INSERT / UPDATE / DELETE) 返回 { kind: 'affected', affected, inTransaction, transactionState }
 * 4. DDL 语句 (CREATE / DROP / ALTER) 返回 { kind: 'ddl', summary, committed }
 * 5. 语法错误 / 空语句 / 多语句拒绝且返回明确错误
 *
 * 运行: node tests/e2e-statement-execution.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')

const work = mkdtempSync(join(tmpdir(), 'dbstudio-stmt-test-'))
const dbPath = join(work, 'test.db')
const db = new DatabaseSync(dbPath)
db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES(1, 'first');")
db.close()

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
      for (const [id, waiter] of this.#pending) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`宿主已退出 (code=${code}, signal=${signal})`))
        this.#pending.delete(id)
      }
    })
  }

  waitForEvent(predicate, timeoutMs = 5000) {
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
          rej(new Error(`宿主已退出`))
        } else if (Date.now() - startedAt > timeoutMs) {
          clearInterval(tick)
          rej(new Error(`等待事件超时`))
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
        rej(new Error(`RPC 超时 (5s): ${method}`))
      }, 5000)
      this.#pending.set(id, { resolve: res, reject: rej, timer })
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
    })
  }

  kill() {
    if (!this.#exitInfo) this.#child.kill('SIGKILL')
  }
}

let passed = 0
function check(name, ok, msg = '') {
  if (ok) {
    console.log(`PASS ${name}`)
    passed++
  } else {
    console.error(`FAIL ${name} ${msg}`)
    throw new Error(`断言失败: ${name} ${msg}`)
  }
}

const child = spawn(process.execPath, [hostEntry, '--dialect', 'sqlite'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe']
})
const host = new HostProcess(child)

try {
  const hs = await host.waitForEvent((f) => f.kind === 'handshake')
  check('1. 驱动宿主握手成功', hs?.dialectId === 'sqlite')

  // 未连接前调用 executeStatement
  const pre = await host.call('executeStatement', { sql: 'SELECT 1' })
  check('2. 未连接时 executeStatement 返回 not_connected', pre.ok === false && pre.error?.code === 'not_connected')

  // 建立连接
  const conn = await host.call('connect', {
    config: { dialectId: 'sqlite', name: 'sqlite-test', options: { file: dbPath } }
  })
  check('3. 连接数据库成功', conn.ok === true)

  // 1. SELECT 查询 (rows)
  const rowsRes = await host.call('executeStatement', { sql: 'SELECT * FROM items ORDER BY id' })
  check('4. SELECT 返回 rows 种类', rowsRes.ok === true && rowsRes.result?.kind === 'rows')
  check('4a. rows 结果包含完整 QueryResult 字段', Array.isArray(rowsRes.result?.result?.rows) && rowsRes.result.result.rows.length === 1)
  check('4b. rows 结果包含列信息', rowsRes.result?.result?.columns?.length === 2)

  // 2. INSERT 语句 (affected)
  const insertRes = await host.call('executeStatement', { sql: "INSERT INTO items VALUES (2, 'second')" })
  check('5. INSERT 返回 affected 种类', insertRes.ok === true && insertRes.result?.kind === 'affected')
  check('5a. INSERT 正确反馈 affected = 1', insertRes.result?.affected === 1)
  check('5b. INSERT 返回事务状态对象', typeof insertRes.result?.transactionState === 'object')

  // 验证确实写入数据库
  const verifyInsert = await host.call('executeStatement', { sql: 'SELECT COUNT(*) AS cnt FROM items' })
  const cntCell = verifyInsert.result?.result?.rows?.[0]?.cells?.[0]
  check('5c. 数据确实进入数据库', (cntCell?.value ?? cntCell?.text) == 2)

  // 3. UPDATE 语句 (affected)
  const updateRes = await host.call('executeStatement', { sql: "UPDATE items SET name = 'first-updated' WHERE id = 1" })
  check('6. UPDATE 返回 affected = 1', updateRes.ok === true && updateRes.result?.kind === 'affected' && updateRes.result?.affected === 1)

  // 4. DELETE 匹配 0 行 (affected = 0)
  const deleteRes = await host.call('executeStatement', { sql: 'DELETE FROM items WHERE id = 9999' })
  check('7. DELETE 匹配 0 行返回 affected = 0', deleteRes.ok === true && deleteRes.result?.kind === 'affected' && deleteRes.result?.affected === 0)

  // 5. CREATE TABLE (ddl)
  const ddlRes = await host.call('executeStatement', { sql: 'CREATE TABLE t_demo (a INT, b TEXT)' })
  check('8. CREATE TABLE 返回 ddl 种类', ddlRes.ok === true && ddlRes.result?.kind === 'ddl')
  check('8a. ddl 返回变更摘要', typeof ddlRes.result?.summary === 'string' && ddlRes.result.summary.length > 0)
  check('8b. ddl 返回 committed 标志', ddlRes.result?.committed === true)

  // 6. DROP TABLE (ddl)
  const dropRes = await host.call('executeStatement', { sql: 'DROP TABLE t_demo' })
  check('9. DROP TABLE 返回 ddl 种类', dropRes.ok === true && dropRes.result?.kind === 'ddl')

  // 7. 语法错误
  const syntaxErr = await host.call('executeStatement', { sql: 'SELEKT * FROM items' })
  check('10. 语法错误返回 ok = false', syntaxErr.ok === false)

  // 8. 空 SQL
  const emptyErr = await host.call('executeStatement', { sql: '   ' })
  check('11. 空 SQL 报 bad_params', emptyErr.ok === false && emptyErr.error?.code === 'bad_params')

  // 9. 多语句一次传入应拒绝 (多语句需经由客户端脚本切分器)
  const multiErr = await host.call('executeStatement', { sql: 'SELECT 1; SELECT 2;' })
  check('12. 单次 executeStatement 传入多语句明确拒绝', multiErr.ok === false && multiErr.error?.code === 'bad_params')

  console.log(`\n全部 ${passed} 项断言通过！`)
} finally {
  host.kill()
  rmSync(work, { recursive: true, force: true })
}

// Optional PostgreSQL verification if DBSTUDIO_PG_URL is present
if (process.env.DBSTUDIO_PG_URL) {
  const pgChild = spawn(process.execPath, [hostEntry, '--dialect', 'postgresql'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const pgHost = new HostProcess(pgChild)
  try {
    const hs = await pgHost.waitForEvent((f) => f.kind === 'handshake')
    check('PG-1. PostgreSQL 宿主握手成功', hs?.dialectId === 'postgresql')
    const conn = await pgHost.call('connect', {
      config: { dialectId: 'postgresql', name: 'pg-test', options: { url: process.env.DBSTUDIO_PG_URL } }
    })
    check('PG-2. 连接 PostgreSQL 成功', conn.ok === true)

    // SELECT
    const selectRes = await pgHost.call('executeStatement', { sql: 'SELECT 42 AS value' })
    check('PG-3. SELECT 返回 rows', selectRes.ok === true && selectRes.result?.kind === 'rows')

    // DDL
    const ddlRes = await pgHost.call('executeStatement', { sql: 'CREATE TEMP TABLE pg_m1_test (x INT)' })
    check('PG-4. DDL 返回 ddl', ddlRes.ok === true && ddlRes.result?.kind === 'ddl')

    // INSERT
    const insertRes = await pgHost.call('executeStatement', { sql: 'INSERT INTO pg_m1_test VALUES (1), (2)' })
    check('PG-5. INSERT 返回 affected = 2', insertRes.ok === true && insertRes.result?.kind === 'affected' && insertRes.result?.affected === 2)

    console.log('PostgreSQL 真实服务验证通过')
  } finally {
    pgHost.kill()
  }
}
