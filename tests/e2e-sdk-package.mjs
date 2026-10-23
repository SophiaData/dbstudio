import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'dbstudio-sdk-package-'))
const env = { ...process.env }
delete env.NODE_PATH
delete env.NODE_OPTIONS

function run(command, args, cwd = dir) {
  return execFileSync(command, args, {
    cwd, env, encoding: 'utf8', timeout: 180_000,
    // npm is a command shim on Windows; all arguments are generated here.
    shell: process.platform === 'win32' && command === 'npm',
    maxBuffer: 4 * 1024 * 1024
  })
}

try {
  const [packed] = JSON.parse(run('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', dir
  ], join(root, 'sdk')))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(dir, packed.filename)])

  writeFileSync(join(dir, 'consumer.mjs'), `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { DriverHost } from '@sophiadata/dbstudio-sdk'
const require = createRequire(import.meta.url)
const hostScript = require.resolve('@sophiadata/dbstudio-sdk/driver-host/index.js')
const file = fileURLToPath(new URL('./sample.db', import.meta.url))
const db = new DatabaseSync(file)
db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)')
db.close()
const host = new DriverHost({ dialectId: 'sqlite', hostScript, onLog: (_, message) => console.error(message) })
try {
  await host.connect({ dialectId: 'sqlite', name: 'isolated', options: { file } })
  const result = await host.query('SELECT 42 AS answer')
  assert.equal(result.rows[0].cells[0].value, 42)
  const duplicate = await host.query('SELECT 1 AS repeated, 2 AS repeated')
  assert.deepEqual(duplicate.rows[0].cells.map(c => c.value), [1, 2])
  assert.equal((await host.transactionState()).active, false)
  console.log('PASS isolated package: import, host, SQLite query, duplicate columns, transaction state')
} finally {
  await host.close()
}
`)
  console.log(run(process.execPath, [join(dir, 'consumer.mjs')]))

  writeFileSync(join(dir, 'consumer.ts'), `
import { DriverHost, type ConnectionConfig, type QueryResult } from '@sophiadata/dbstudio-sdk'
const config: ConnectionConfig = { dialectId: 'sqlite', name: 'types', options: { file: ':memory:' } }
export async function query(host: DriverHost): Promise<QueryResult> {
  await host.connect(config)
  return host.query('SELECT 1')
}
`)
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, noEmit: true, types: [], skipLibCheck: false
    },
    files: ['consumer.ts']
  }))
  // The compiler comes from the repo, but module/type resolution starts at the consumer.
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(dir, 'tsconfig.json')])
  console.log('PASS isolated package: NodeNext declarations')
  const pkg = JSON.parse(readFileSync(join(dir, 'node_modules/@sophiadata/dbstudio-sdk/package.json'), 'utf8'))
  assert.ok(pkg.dependencies?.pg && pkg.dependencies?.ssh2)
  console.log('PASS isolated package: runtime dependencies declared')
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  rmSync(dir, { recursive: true, force: true })
}
