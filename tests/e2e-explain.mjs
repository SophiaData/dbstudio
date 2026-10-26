/**
 * 方言级执行计划 RPC 回归。
 *
 * SQLite 始终运行；配置 DBSTUDIO_PG_URL 时额外验证 PostgreSQL。
 * 计划必须由驱动方言生成，测试不接受渲染层拼接固定的 EXPLAIN 关键字。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')
const pgOnly = process.argv.includes('--pg-only')
const sqliteOnly = process.argv.includes('--sqlite-only')
const work = mkdtempSync(join(root, 'out/.explain-test-'))
const dbPath = join(work, 'explain.db')
const db = new DatabaseSync(dbPath)
db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES (1, \'one\'), (2, \'two\');')
db.close()

class HostProcess {
  #child
  #pending = new Map()
  #events = []
  #exitInfo = null
  #nextId = 1
  #stderr = ''

  constructor(dialect) {
    this.#child = spawn(process.execPath, [hostEntry, '--dialect', dialect], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.#child.stderr.on('data', (chunk) => { this.#stderr = (this.#stderr + chunk).slice(-4000) })
    const stdout = createInterface({ input: this.#child.stdout, crlfDelay: Infinity })
    stdout.on('line', (line) => {
      if (line.trim() === '') return
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
      } else {
        this.#events.push(frame)
      }
    })
    this.#child.on('exit', (code, signal) => {
      this.#exitInfo = { code, signal }
      for (const [id, waiter] of this.#pending) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`宿主已退出（code=${code}, signal=${signal}）`))
        this.#pending.delete(id)
      }
    })
  }

  waitForEvent(predicate) {
    const existing = this.#events.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolvePromise, reject) => {
      const timer = setInterval(() => {
        const found = this.#events.find(predicate)
        if (found) {
          clearInterval(timer)
          clearTimeout(timeout)
          resolvePromise(found)
        } else if (this.#exitInfo) {
          clearInterval(timer)
          clearTimeout(timeout)
          reject(new Error('宿主已退出'))
        }
      }, 20)
      const timeout = setTimeout(() => {
        clearInterval(timer)
        reject(new Error(`等待握手超时: ${this.#stderr}`))
      }, 5000)
    })
  }

  call(method, params) {
    const id = this.#nextId++
    const frame = { id, method, params }
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`RPC 超时: ${method}`))
      }, 10000)
      this.#pending.set(id, { resolve: resolvePromise, reject, timer })
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
    })
  }

  async close() {
    if (this.#exitInfo) return
    const exited = new Promise((resolvePromise) => this.#child.once('exit', resolvePromise))
    const timeout = setTimeout(() => this.#child.kill('SIGKILL'), 5000)
    this.#child.stdin.end()
    await exited
    clearTimeout(timeout)
  }
}

function parsePgUrl(value) {
  const url = new URL(value)
  return {
    host: url.hostname,
    port: url.port === '' ? '5432' : url.port,
    database: decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres'),
    user: decodeURIComponent(url.username || 'postgres'),
    password: url.password === '' ? undefined : decodeURIComponent(url.password)
  }
}

function expectPlan(label, response, dialectId, format) {
  assert.equal(response.ok, true, `${label} explain should succeed: ${JSON.stringify(response)}`)
  assert.equal(response.result?.dialectId, dialectId)
  assert.equal(response.result?.format, format)
  assert.ok(response.result?.executedSql, `${label} should return executed SQL`)
  assert.ok(response.result?.columns?.length > 0, `${label} should return columns`)
  assert.ok(response.result?.rows?.length > 0, `${label} should return rows`)
}

async function runSqlite() {
  const host = new HostProcess('sqlite')
  try {
    assert.equal((await host.waitForEvent((frame) => frame.kind === 'handshake')).dialectId, 'sqlite')
    const beforeConnect = await host.call('explain', { sql: 'SELECT * FROM items' })
    assert.equal(beforeConnect.ok, false)
    assert.equal(beforeConnect.error?.code, 'not_connected')

    const connected = await host.call('connect', {
      config: { dialectId: 'sqlite', name: 'explain', options: { file: dbPath } }
    })
    assert.equal(connected.ok, true)

    const plan = await host.call('explain', { sql: 'SELECT * FROM items WHERE id = 1' })
    expectPlan('SQLite', plan, 'sqlite', 'tabular')
    assert.match(plan.result.executedSql, /^EXPLAIN QUERY PLAN\b/i)

    const invalid = await host.call('explain', { sql: 'SELEKT * FROM items' })
    assert.equal(invalid.ok, false)
    assert.ok(invalid.error?.message)
    const multiple = await host.call('explain', { sql: 'SELECT 1; SELECT 2' })
    assert.equal(multiple.ok, false)
    assert.equal(multiple.error?.code, 'bad_params')

    const disconnected = await host.call('disconnect')
    assert.equal(disconnected.ok, true)
    const afterDisconnect = await host.call('explain', { sql: 'SELECT 1' })
    assert.equal(afterDisconnect.ok, false)
    assert.equal(afterDisconnect.error?.code, 'not_connected')
    console.log('PASS sqlite: plan, readable errors, single-statement guard, disconnected session')
  } finally {
    await host.close()
  }
}

async function runPostgresql() {
  const value = process.env.DBSTUDIO_PG_URL
  if (!value) {
    console.log('SKIP PostgreSQL explain: 未配置 DBSTUDIO_PG_URL')
    return
  }
  const info = parsePgUrl(value)
  const host = new HostProcess('postgresql')
  try {
    assert.equal((await host.waitForEvent((frame) => frame.kind === 'handshake')).dialectId, 'postgresql')
    const connected = await host.call('connect', {
      config: {
        dialectId: 'postgresql',
        name: 'explain',
        options: { host: info.host, port: info.port, database: info.database, user: info.user }
      },
      secret: info.password
    })
    assert.equal(connected.ok, true, JSON.stringify(connected))
    const plan = await host.call('explain', { sql: 'SELECT 1' })
    expectPlan('PostgreSQL', plan, 'postgresql', 'json')
    assert.match(plan.result.executedSql, /^EXPLAIN \(FORMAT JSON\) /i)
    const cell = plan.result.rows[0].cells[0]
    assert.equal(cell.kind, 'text')
    assert.equal(JSON.parse(cell.text)[0].Plan['Node Type'], 'Result')
    const multiple = await host.call('explain', { sql: 'SELECT 1; SELECT 2' })
    assert.equal(multiple.ok, false, 'Explain accepts exactly one statement')
    assert.equal(multiple.error?.code, 'bad_params')
    const invalid = await host.call('explain', { sql: 'SELECT * FROM dbstudio_missing_explain_table' })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error?.code, 'object_not_found')
    assert.match(invalid.error.message, /does not exist/i)
    expectPlan('PostgreSQL recovery', await host.call('explain', { sql: 'SELECT 1' }), 'postgresql', 'json')
    assert.equal((await host.call('disconnect')).ok, true)
    const afterDisconnect = await host.call('explain', { sql: 'SELECT 1' })
    assert.equal(afterDisconnect.ok, false)
    assert.equal(afterDisconnect.error?.code, 'not_connected')
    console.log('PASS postgresql: JSON plan, readable errors, single-statement guard, disconnected session')
  } finally {
    await host.close()
  }
}

try {
  if (!pgOnly) await runSqlite()
  if (!sqliteOnly) await runPostgresql()
  console.log('Explain RPC: passed')
} finally {
  rmSync(work, { recursive: true, force: true })
}
