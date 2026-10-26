import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(root, 'out/.driver-host-stress-probe-'))

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
  const record = {
    child,
    startedAt: Date.now(),
    pid: child.pid,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    exitedAt: null
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    record.stdout += chunk
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    record.stderr += chunk
  })
  child.once('exit', (code, signal) => {
    record.exitCode = code
    record.signal = signal
    record.exitedAt = Date.now()
  })
  children.push(record)
  return child
}

const { ConnectionManager, ConnectionStore, listBuiltinDialects } =
  await import(`file://${join(outDir, 'probe.cjs')}`)

const dirs = []
const managerDir = mkdtempSync(join(tmpdir(), 'dbstudio-driver-host-stress-'))
dirs.push(managerDir)
const manager = new ConnectionManager(
  listBuiltinDialects(),
  new ConnectionStore({
    baseDir: managerDir,
    cipher: {
      encrypt: (plain) => Buffer.from(plain, 'utf8'),
      decrypt: (payload) => payload.toString('utf8')
    }
  })
)

function config(index) {
  const dir = mkdtempSync(join(tmpdir(), `dbstudio-driver-host-stress-db-${index}-`))
  dirs.push(dir)
  const file = join(dir, 'test.db')
  new DatabaseSync(file).close()
  return { dialectId: 'sqlite', name: `stress-${index}`, options: { file } }
}

function exited(record) {
  return record.exitCode !== null || record.signal !== null
}

async function waitForExit(record) {
  if (!exited(record)) await once(record.child, 'exit')
}

try {
  const samples = []
  for (let index = 0; index < 20; index += 1) {
    const started = Date.now()
    const summary = await manager.add(config(index))
    const record = children.at(-1)
    assert.ok(record, `iteration ${index}: no child process was recorded`)
    assert.equal(summary.connected, true, `iteration ${index}: ${JSON.stringify(summary)}`)
    assert.equal(typeof record.pid, 'number', `iteration ${index}: missing pid`)

    await manager.remove(summary.id)
    await waitForExit(record)

    assert.equal(record.exitCode, 0, `iteration ${index}: ${record.stderr}`)
    assert.equal(record.signal, null, `iteration ${index}: ${record.stderr}`)
    assert.match(record.stdout, /"kind":"handshake"/, `iteration ${index}: missing handshake`)
    assert.match(record.stderr, /方言 sqlite 已加载/, `iteration ${index}: missing startup log`)
    samples.push({
      index,
      pid: record.pid,
      handshakeMs: Date.now() - started,
      exitCode: record.exitCode,
      stdoutBytes: Buffer.byteLength(record.stdout),
      stderrBytes: Buffer.byteLength(record.stderr)
    })
  }

  assert.equal(samples.length, 20)
  assert.equal(new Set(samples.map((sample) => sample.pid)).size, 20)
  assert.ok(samples.every((sample) => sample.handshakeMs < 10_000), JSON.stringify(samples))
  console.log(`Driver host stress: ${samples.length}/20 passed`)
  console.log(JSON.stringify(samples))
} finally {
  await manager.disposeAll()
  childProcess.spawn = originalSpawn
  for (const record of children) {
    if (!exited(record)) record.child.kill('SIGKILL')
  }
  await Promise.all(children.map(waitForExit))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
}
