// Dedicated local database fixtures for native Rust tests. No application/Node backend.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runId = randomUUID().replaceAll('-', '').slice(0, 16)
const evidence = join(root, 'backups', `native-database-${runId}`)
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const dbPassword = () => randomBytes(32).toString('hex')
const fixtures = [
  { kind: 'pg', name: `dbstudio-native-pg-${runId}`, image: 'postgres:17', port: 5432,
    password: dbPassword(), user: 'fixture', database: 'fixture', created: false, attempted: false },
  { kind: 'mysql', name: `dbstudio-native-mysql-${runId}`, image: 'mysql:8.0', port: 3306,
    password: dbPassword(), user: 'fixture', database: 'fixture', created: false, attempted: false },
]
function docker(args, timeout = 30000) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim() }
  catch { throw new Error(`专用数据库夹具操作失败：${args[0]}`) }
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
async function ready(fixture) {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    const status = docker(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{end}}', fixture.name])
    if (status === 'healthy') return
    if (status === 'unhealthy') throw new Error(`${fixture.kind} 专用数据库健康检查失败`)
    await pause(1000)
  }
  throw new Error(`${fixture.kind} 专用数据库未在时限内就绪`)
}
let passed = false
try {
  docker(['info', '--format', '{{.ServerVersion}}'])
  for (const fixture of fixtures) {
    const envPath = join(evidence, `${fixture.kind}.env`)
    const values = fixture.kind === 'pg'
      ? { POSTGRES_USER: fixture.user, POSTGRES_DB: fixture.database, POSTGRES_PASSWORD: fixture.password }
      : { MYSQL_USER: fixture.user, MYSQL_DATABASE: fixture.database, MYSQL_PASSWORD: fixture.password, MYSQL_ROOT_PASSWORD: dbPassword() }
    writeFileSync(envPath, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600, flag: 'wx' })
    const health = fixture.kind === 'pg' ? 'pg_isready -U fixture -d fixture' : 'mysqladmin ping --silent'
    fixture.attempted = true
    docker(['run', '--detach', '--name', fixture.name, '--label', `io.dbstudio.native-fixture=${runId}`,
      '--memory', fixture.kind === 'pg' ? '512m' : '1g', '--publish', `127.0.0.1::${fixture.port}`,
      '--env-file', envPath, '--health-cmd', health, '--health-interval', '2s', '--health-timeout', '2s',
      '--health-start-period', '15s', '--health-retries', '50', fixture.image], 180000)
    fixture.created = true
    fixture.hostPort = docker(['inspect', '--format', `{{(index (index .NetworkSettings.Ports "${fixture.port}/tcp") 0).HostPort}}`, fixture.name])
    assert.match(fixture.hostPort, /^\d+$/)
    console.log(`Native fixture ${fixture.kind}: started on a dedicated loopback port`)
  }
  await Promise.all(fixtures.map(ready))
  const env = { ...process.env }
  for (const fixture of fixtures) {
    const prefix = fixture.kind === 'pg' ? 'DBSTUDIO_NATIVE_PG' : 'DBSTUDIO_NATIVE_MYSQL'
    env[`${prefix}_PORT`] = fixture.hostPort
    env[`${prefix}_PASSWORD`] = fixture.password
  }
  const result = await new Promise((done, reject) => {
    const child = spawn('cargo', ['test', '-p', 'dbstudio-drivers', '--test', 'network_live', '--', '--ignored', '--test-threads=1'], { cwd: root, env, stdio: 'inherit' })
    child.once('error', () => reject(new Error('无法启动原生数据库测试')))
    child.once('exit', (code) => done(code))
  })
  assert.equal(result, 0, '原生真实数据库验收失败')
  passed = true
} finally {
  const report = { runId, testsPassed: passed, cleanupPassed: true, passed: false, fixtures: [] }
  for (const fixture of fixtures.filter((item) => item.attempted)) {
    let stopped = false
    let found = false
    // A timed-out Docker CLI may already have created its container. Inspect every attempt.
    try {
      const id = docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `name=^/${fixture.name}$`,
        '--filter', `label=io.dbstudio.native-fixture=${runId}`])
      if (id) {
        assert.match(id, /^[a-f0-9]{64}$/)
        const label = docker(['inspect', '--format', '{{index .Config.Labels "io.dbstudio.native-fixture"}}', id])
        assert.equal(label, runId)
        found = true
        // Stop the immutable, verified ID; never a name that could be replaced after inspection.
        docker(['stop', '--time', '15', id], 30000)
        assert.equal(docker(['inspect', '--format', '{{.State.Running}}', id]), 'false')
      } else {
        assert.equal(fixture.created, false, 'a confirmed fixture must remain inspectable')
      }
      stopped = true
    } catch {
      report.cleanupPassed = false
      console.error(`Native fixture ${fixture.kind}: stop failed; dedicated container retained`)
    }
    report.fixtures.push({ kind: fixture.kind, image: fixture.image, container: fixture.name, found, stopped })
  }
  report.passed = report.testsPassed && report.cleanupPassed
  writeFileSync(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  if (!report.cleanupPassed) process.exitCode = 1
  // Keep private fixture files and stopped containers; user rules forbid deletion.
}
