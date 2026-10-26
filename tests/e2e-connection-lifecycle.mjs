import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Only this run's probe is written; the existing driver-host is read as-is.
const outDir = mkdtempSync(join(root, 'out/.connection-lifecycle-probe-'))
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir,
    emptyOutDir: false,
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

const children = []
const originalSpawn = childProcess.spawn
childProcess.spawn = function (...args) {
  const child = originalSpawn.apply(this, args)
  children.push(child)
  return child
}
const { ConnectionManager, ConnectionStore, DriverHostHandle, listBuiltinDialects } =
  await import(`file://${join(outDir, 'probe.cjs')}`)
const originalConnect = DriverHostHandle.prototype.connect
const managers = []
const dirs = []
const results = []

function setup(cipher = null) {
  const dir = mkdtempSync(join(tmpdir(), 'dbstudio-lifecycle-'))
  dirs.push(dir)
  const store = new ConnectionStore({ baseDir: dir, cipher })
  const manager = new ConnectionManager(listBuiltinDialects(), store)
  managers.push(manager)
  return { manager, store, dir }
}

function config(name = 'lifecycle') {
  const dir = mkdtempSync(join(tmpdir(), 'dbstudio-lifecycle-db-'))
  dirs.push(dir)
  const file = join(dir, 'test.db')
  new DatabaseSync(file).close()
  return { dialectId: 'sqlite', name, options: { file } }
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function numberCell(result) {
  return result.rows[0]?.cells[0]?.value
}

async function deadline(promise, ms = 4000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`deadline exceeded (${ms}ms)`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitForExit(child) {
  if (!exited(child)) await deadline(once(child, 'exit'))
}

async function check(name, fn) {
  const start = children.length
  const managerStart = managers.length
  try {
    await fn()
    results.push({ name, passed: true })
    console.log(`PASS ${name}`)
  } catch (err) {
    results.push({ name, passed: false })
    console.error(`FAIL ${name}: ${err.stack}`)
  } finally {
    DriverHostHandle.prototype.connect = originalConnect
    // Kill even orphaned hosts on a failing baseline run.
    for (const child of children.slice(start)) {
      if (!exited(child)) child.kill('SIGKILL')
    }
    await Promise.all(children.slice(start).map(waitForExit))
    await Promise.all(managers.slice(managerStart).map((manager) => manager.disposeAll()))
  }
}

try {
  await check('failed handshake exposes lifecycle diagnostics', async () => {
    const host = new DriverHostHandle({ dialectId: 'missing-lifecycle-dialect' })
    try {
      await assert.rejects(host.handshake, (error) => {
        assert.match(error.message, /missing-lifecycle-dialect/)
        assert.match(error.message, /pid=/)
        assert.match(error.message, /script=/)
        assert.match(error.message, /stdoutBytes=/)
        assert.match(error.message, /stderr=/)
        return true
      })
      assert.equal(host.lifecycle, 'failed')
      assert.equal(host.diagnostics.dialectId, 'missing-lifecycle-dialect')
      assert.equal(host.diagnostics.lifecycle, 'failed')
      assert.equal(typeof host.diagnostics.pid, 'number')
      assert.equal(host.diagnostics.exitCode, 1)
      assert.match(host.diagnostics.stderrTail, /未知方言/)
    } finally {
      host.kill()
      await host.close()
    }
  })

  await check('unexpected host exit clears live/cursors and permits an isolated reconnect', async () => {
    const { manager } = setup()
    const a = await manager.add(config('a'))
    const childA = children.at(-1)
    const b = await manager.add(config('b'))
    assert.equal(a.connected, true)
    assert.equal(b.connected, true)
    const result = await manager.runQuery(`connection:${a.id}`, 'SELECT 41 AS value')
    assert.ok(result.cursorId)
    assert.equal(manager.stats().openCursors, 1)
    childA.kill('SIGKILL')
    await waitForExit(childA)
    assert.equal(manager.list().find((c) => c.id === a.id).connected, false)
    assert.deepEqual(manager.stats(), { connections: 1, openCursors: 0 })
    assert.equal(numberCell(await manager.runQuery(`connection:${b.id}`, 'SELECT 42')), 42)
    await assert.rejects(manager.fetchResultPage(result.cursorId, 0, 1))
    assert.equal((await manager.connectConnection(a.id)).connected, true)
    assert.equal(numberCell(await manager.runQuery(`connection:${a.id}`, 'SELECT 43')), 43)
  })

  await check('concurrent connect creates exactly one usable child and closes it', async () => {
    const { manager } = setup()
    const saved = await manager.add(config())
    await manager.disconnectConnection(saved.id)
    const start = children.length
    const summaries = await Promise.all(
      Array.from({ length: 8 }, () => manager.connectConnection(saved.id))
    )
    assert.ok(summaries.every((c) => c.connected))
    assert.equal(children.length - start, 1, 'duplicate hosts leak when the last result wins')
    assert.equal(numberCell(await manager.runQuery(`connection:${saved.id}`, 'SELECT 7')), 7)
    await manager.disconnectConnection(saved.id)
    assert.ok(children.slice(start).every(exited), 'disconnect must await process exit')
  })

  await check('cipher=null passes this-session credentials and clears them on disconnect', async () => {
    const { manager, store, dir } = setup()
    const secret = { dbPassword: 'lifecycle-db-private', sshPassword: 'lifecycle-ssh-private' }
    // SQLite has no authentication. Gate the real connect RPC at the host boundary
    // so dropping either credential causes a failed connection, not a fake green.
    DriverHostHandle.prototype.connect = function (cfg, input) {
      if (input?.dbPassword !== secret.dbPassword || input?.sshPassword !== secret.sshPassword) {
        return Promise.reject(new Error('test authentication rejected: missing session credential'))
      }
      return originalConnect.call(this, cfg, input)
    }
    const summary = await manager.add(config(), secret)
    assert.equal(summary.connected, true)
    assert.equal(numberCell(await manager.runQuery(`connection:${summary.id}`, 'SELECT 9')), 9)
    assert.equal(store.getSecret(summary.id), undefined)
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8')
      assert.ok(!text.includes(secret.dbPassword) && !text.includes(secret.sshPassword))
    }
    await manager.disconnectConnection(summary.id)
    assert.equal((await manager.connectConnection(summary.id)).connected, false)
  })
} finally {
  childProcess.spawn = originalSpawn
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`Lifecycle: ${results.filter((r) => r.passed).length}/${results.length} passed`)
if (results.some((r) => !r.passed)) process.exitCode = 1
