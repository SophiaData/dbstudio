/**
 * 参数化 SQL 端到端测试。
 *
 * 验证：
 * - SQLite ? / :name 参数按绑定值执行；
 * - 参数值不会被拼进 SQL（注入字面值保持为普通文本）；
 * - 缺失、重复和多余参数在协议层明确拒绝；
 * - Uint8Array 可以作为 BLOB 绑定；
 * - 配置 DBSTUDIO_PG_URL 时，PostgreSQL $1 / $2 参数也走同一契约。
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = join(root, 'out', 'driver-host', 'index.js')
const work = mkdtempSync(join(tmpdir(), 'dbstudio-sql-params-'))
const dbPath = join(work, 'params.db')
const pgUrl = process.env['DBSTUDIO_PG_URL']
const sqliteOnly = process.argv.includes('--sqlite-only')
const pgOnly = process.argv.includes('--pg-only')

{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, payload BLOB);
    INSERT INTO items (id, name) VALUES (1, 'first'), (2, 'second');
  `)
  db.close()
}

class Host {
  #child
  #pending = new Map()
  #nextId = 1
  #events = []

  constructor(dialect) {
    this.#child = spawn(process.execPath, [hostEntry, '--dialect', dialect], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout = createInterface({ input: this.#child.stdout, crlfDelay: Infinity })
    stdout.on('line', (line) => {
      if (!line.trim()) return
      const frame = JSON.parse(line)
      if (typeof frame.id === 'number') {
        const pending = this.#pending.get(frame.id)
        if (!pending) return
        this.#pending.delete(frame.id)
        clearTimeout(pending.timer)
        pending.resolve(frame)
      } else {
        this.#events.push(frame)
      }
    })
  }

  waitFor(predicate) {
    const found = this.#events.find(predicate)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const next = this.#events.find(predicate)
        if (next) {
          clearInterval(timer)
          clearTimeout(timeout)
          resolve(next)
        }
      }, 10)
      const timeout = setTimeout(() => {
        clearInterval(timer)
        reject(new Error('等待宿主事件超时'))
      }, 10_000)
    })
  }

  call(method, params) {
    const id = this.#nextId++
    const frame = { id, method, ...(params === undefined ? {} : { params }) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`RPC 超时：${method}`))
      }, 20_000)
      this.#pending.set(id, { resolve, reject, timer })
      this.#child.stdin.write(`${JSON.stringify(frame, (_key, value) => value instanceof Uint8Array ? { type: 'dbstudio-sql-bytes', data: Array.from(value) } : value)}\n`)
    })
  }

  async close() {
    this.#child.stdin.end()
    await new Promise((resolve) => this.#child.once('exit', resolve))
  }
}

function cellValue(result, row = 0, column = 0) {
  const query = result.result?.result ?? result.result
  const cell = query?.rows?.[row]?.cells?.[column]
  if (cell?.kind === 'blob') return Buffer.from(cell.previewBase64, 'base64')
  if (cell?.kind === 'text') return cell.text
  if (cell?.kind === 'number' || cell?.kind === 'boolean') return cell.value
  return null
}

function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`)
  console.log(`PASS ${name}`)
}

async function runSqlite() {
  const host = new Host('sqlite')
  try {
    check('SQLite handshake', (await host.waitFor((f) => f.kind === 'handshake')).dialectId === 'sqlite')
    check(
      'SQLite connect',
      (await host.call('connect', {
        config: { dialectId: 'sqlite', name: 'params', options: { file: dbPath } }
      })).ok === true
    )

    const positional = await host.call('executeStatement', {
      sql: 'SELECT ? + ? AS total',
      options: {
        parameters: [
          { name: '?1', value: 2 },
          { name: '?2', value: 3 }
        ]
      }
    })
    check('SQLite positional parameters bind values', positional.ok && cellValue(positional) === 5, JSON.stringify(positional))

    const injectionText = "x' OR 1=1 --"
    const named = await host.call('executeStatement', {
      sql: 'SELECT :name AS value',
      options: { parameters: [{ name: 'name', value: injectionText }] }
    })
    check('SQLite named parameter keeps injection text literal', named.ok && cellValue(named) === injectionText, JSON.stringify(named))

    const paged = await host.call('query', {
      sql: 'SELECT name FROM items WHERE id >= ? ORDER BY id',
      options: {
        limit: 1,
        parameters: [{ name: '?1', value: 1 }]
      }
    })
    check('SQLite query() accepts parameters', paged.ok && cellValue(paged) === 'first', JSON.stringify(paged))
    const nextPage = await host.call('fetchResultPage', {
      cursorId: paged.result?.cursorId,
      offset: 1,
      limit: 1
    })
    check(
      'SQLite parameter bindings survive cursor pagination',
      nextPage.ok && nextPage.result?.rows?.[0]?.cells?.[0]?.text === 'second',
      JSON.stringify(nextPage)
    )

    const blob = await host.call('executeStatement', {
      sql: 'SELECT :payload AS payload',
      options: { parameters: [{ name: 'payload', value: new Uint8Array([0, 1, 255]) }] }
    })
    const blobValue = cellValue(blob)
    check('SQLite Uint8Array binds as BLOB', blob.ok && Buffer.from(blobValue ?? []).equals(Buffer.from([0, 1, 255])), JSON.stringify(blob))

    const emptyBlob = await host.call('executeStatement', {
      sql: 'SELECT length(:empty)', options: { parameters: [{ name: 'empty', value: new Uint8Array() }] }
    })
    check('SQLite empty Uint8Array binds as empty BLOB', emptyBlob.ok && cellValue(emptyBlob) === 0, JSON.stringify(emptyBlob))

    const insert = await host.call('executeStatement', {
      sql: 'INSERT INTO items (id, name) VALUES (?, ?)',
      options: {
        parameters: [
          { name: '?1', value: 3 },
          { name: '?2', value: injectionText }
        ]
      }
    })
    check('SQLite parameterized INSERT succeeds', insert.ok && insert.result?.affected === 1, JSON.stringify(insert))

    const verify = await host.call('executeStatement', {
      sql: 'SELECT name FROM items WHERE id = ?',
      options: { parameters: [{ name: '?1', value: 3 }] }
    })
    check('SQLite parameterized INSERT stores exact value', verify.ok && cellValue(verify) === injectionText, JSON.stringify(verify))

    const missing = await host.call('executeStatement', {
      sql: 'SELECT :missing',
      options: { parameters: [] }
    })
    check('Missing parameter is bad_params', !missing.ok && missing.error?.code === 'bad_params', JSON.stringify(missing))

    const extra = await host.call('executeStatement', {
      sql: 'SELECT 1',
      options: { parameters: [{ name: '?1', value: 1 }] }
    })
    check('Extra parameter is bad_params', !extra.ok && extra.error?.code === 'bad_params', JSON.stringify(extra))

    const duplicate = await host.call('executeStatement', {
      sql: 'SELECT :name',
      options: {
        parameters: [
          { name: 'name', value: 'one' },
          { name: ':name', value: 'two' }
        ]
      }
    })
    check('Duplicate parameter names are bad_params', !duplicate.ok && duplicate.error?.code === 'bad_params', JSON.stringify(duplicate))

    const postgresStyle = await host.call('executeStatement', {
      sql: 'SELECT $1',
      options: { parameters: [{ name: '$1', value: 1 }] }
    })
    check('Unsupported SQLite placeholder style is bad_params', !postgresStyle.ok && postgresStyle.error?.code === 'bad_params', JSON.stringify(postgresStyle))
  } finally {
    await host.close()
  }
}

function parsePgUrl(value) {
  const url = new URL(value)
  return {
    host: url.hostname,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres'),
    user: decodeURIComponent(url.username || 'postgres'),
    password: url.password ? decodeURIComponent(url.password) : undefined
  }
}

async function runPostgres() {
  if (!pgUrl) {
    console.log('SKIP PostgreSQL parameter test: 未配置 DBSTUDIO_PG_URL')
    return
  }
  const info = parsePgUrl(pgUrl)
  const host = new Host('postgresql')
  try {
    await host.waitFor((f) => f.kind === 'handshake')
    const connected = await host.call('connect', {
      config: {
        dialectId: 'postgresql',
        name: 'params',
        options: { host: info.host, port: info.port, database: info.database, user: info.user }
      },
      secret: info.password
    })
    check('PostgreSQL connect', connected.ok === true, JSON.stringify(connected))

    const result = await host.call('executeStatement', {
      sql: 'SELECT $1::int + $2::int AS total',
      options: {
        parameters: [
          { name: '$1', value: 2 },
          { name: '$2', value: 3 }
        ]
      }
    })
    check('PostgreSQL positional parameters bind values', result.ok && cellValue(result) === 5, JSON.stringify(result))
    const injectionText = "x'; DROP TABLE ignored; --"
    const literal = await host.call('executeStatement', {
      sql: 'SELECT $1::text AS value, $2::bytea AS payload, $3::boolean AS flag, $4::text AS nothing',
      options: { parameters: [
        { name: '$1', value: injectionText }, { name: '$2', value: new Uint8Array([0, 255]) },
        { name: '$3', value: false }, { name: '$4', value: null }
      ] }
    })
    check('PostgreSQL text injection stays literal', literal.ok && cellValue(literal) === injectionText, JSON.stringify(literal))
    check('PostgreSQL binary, boolean and null binding', literal.ok && cellValue(literal, 0, 1).equals(Buffer.from([0, 255])) && cellValue(literal, 0, 2) === false && cellValue(literal, 0, 3) === null)
    const paged = await host.call('query', {
      sql: 'SELECT n FROM generate_series($1::int, $2::int) n ORDER BY n',
      options: { limit: 1, parameters: [{ name: '$2', value: 3 }, { name: '$1', value: 1 }] }
    })
    check('PostgreSQL orders parameter values by position', paged.ok && cellValue(paged) === 1, JSON.stringify(paged))
    const page = await host.call('fetchResultPage', { cursorId: paged.result?.cursorId, offset: 2, limit: 1 })
    check('PostgreSQL bindings survive pagination', page.ok && cellValue(page) === 3, JSON.stringify(page))
    for (const parameters of [[], [{ name: '$1', value: 1 }, { name: '$2', value: 2 }], [{ name: '$1', value: 1 }, { name: '$1', value: 2 }]]) {
      const invalid = await host.call('executeStatement', { sql: 'SELECT $1::int', options: { parameters } })
      check('PostgreSQL rejects missing, extra or duplicate parameters', !invalid.ok && invalid.error?.code === 'bad_params', JSON.stringify(invalid))
    }
    const slow = host.call('executeStatement', { sql: 'SELECT pg_sleep(10)', options: { signalId: 'current' } })
    await new Promise(resolve => setTimeout(resolve, 250))
    const stale = await host.call('cancelQuery', { signalId: 'previous' })
    check('Stale cancellation cannot interrupt the active execution', stale.ok && stale.result === false)
    const cancelled = await host.call('cancelQuery', { signalId: 'current' })
    check('Matching execution can be cancelled', cancelled.ok && cancelled.result === true)
    const interrupted = await slow
    check('Matching cancellation interrupts PostgreSQL query', !interrupted.ok && /cancel/i.test(interrupted.error?.message ?? ''), JSON.stringify(interrupted))
    const recovered = await host.call('executeStatement', { sql: 'SELECT 1' })
    check('PostgreSQL execution recovers after cancellation', recovered.ok && cellValue(recovered) === 1)

  } finally {
    await host.close()
  }
}

try {
  if (!pgOnly) await runSqlite()
  if (!sqliteOnly) await runPostgres()
  console.log('SQL parameter RPC: passed')
} finally {
  rmSync(work, { recursive: true, force: true })
}
