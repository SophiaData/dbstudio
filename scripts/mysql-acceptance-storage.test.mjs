import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as storageModule from './mysql-acceptance-storage.mjs'
import {
  MAX_CACHE_BYTES, MIN_AVAILABLE_BYTES, acquireBuildStorage,
  inspectBinaryDependencies, inspectStorage, storagePolicyBinding, verifyStorageReceipt
} from './mysql-acceptance-storage.mjs'

const NODE = process.execPath
const PYTHON = '/usr/bin/python3'
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = join(project, 'backups', `mysql-acceptance-storage-tests-${randomUUID()}`)
mkdirSync(fixtureRoot, { mode: 0o700 })
after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

const HEAVY_STAGES = ['host-negative-and-contract-tests', 'sqlite-smoke-cfg-compile-only', 'debug-test-artifact']
const EXPECTED_TESTS_BLOCK_SHA256 = 'b6b9512cbdc135cc237ccb7f857ebbedf1937670ad47b2e3289a90f172a2b658'
const EXPECTED_STAGE_SEQUENCE_SHA256 = 'f6b345eddeacee46adf629384e24df240a625d115478759b51b83a0bfa89f1d1'

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const ample = () => ({ availableBytes: MIN_AVAILABLE_BYTES * 2, cacheAllocatedBytes: 0 })
function caseRoot(name) {
  const root = join(fixtureRoot, name)
  mkdirSync(join(root, 'backups'), { recursive: true, mode: 0o700 })
  return root
}
function cacheFile(root, runId, cache = 'deps', name = 'cache.bin') {
  const directory = join(root, 'backups', `mysql-acceptance-host-build-${runId}`, 'target', 'debug', cache)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, name)
  writeFileSync(path, `owned-${runId}-${cache}-${name}`, { mode: 0o600 })
  return path
}
function cargoLockPaths(root, runId) {
  const run = join(root, 'backups', `mysql-acceptance-host-build-${runId}`)
  return [
    join(run, 'target', 'debug', '.cargo-lock'),
    join(run, 'target', 'debug', '.cargo-build-lock'),
    join(run, 'target', 'debug', '.cargo-artifact-lock')
  ]
}
function writeCargoLocks(root, runId) {
  for (const path of cargoLockPaths(root, runId)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, '', { mode: 0o600 })
  }
}

// A minimal but genuine 64-bit Mach-O executable header with real LC_LOAD_DYLIB commands.
// It is never executed; it exists so the real /usr/bin/otool -L parser is exercised.
function machO(dependencies) {
  const commands = []
  for (const dependency of dependencies) {
    const name = Buffer.from(`${dependency}\0`, 'utf8')
    const size = (24 + name.length + 7) & ~7
    const command = Buffer.alloc(size)
    command.writeUInt32LE(0x0c, 0)
    command.writeUInt32LE(size, 4)
    command.writeUInt32LE(24, 8)
    command.writeUInt32LE(0, 12)
    command.writeUInt32LE(0x10000, 16)
    command.writeUInt32LE(0x10000, 20)
    name.copy(command, 24)
    commands.push(command)
  }
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeInt32LE(0x01000007, 4)
  header.writeInt32LE(3, 8)
  header.writeUInt32LE(2, 12)
  header.writeUInt32LE(commands.length, 16)
  header.writeUInt32LE(commands.reduce((total, command) => total + command.length, 0), 20)
  return Buffer.concat([header, ...commands])
}
function successfulRun(root, runId, dependencies = ['/usr/lib/libSystem.B.dylib']) {
  const run = join(root, 'backups', `mysql-acceptance-host-build-${runId}`)
  for (const cache of ['deps', 'build', 'incremental']) cacheFile(root, runId, cache)
  const debug = join(run, 'target', 'debug')
  const binary = join(debug, 'dbstudio-desktop')
  writeFileSync(binary, machO(dependencies), { mode: 0o700 })
  mkdirSync(join(run, 'frontend'), { mode: 0o700 })
  writeFileSync(join(run, 'frontend', 'index.html'), '<main>synthetic</main>', { mode: 0o600 })
  mkdirSync(join(debug, '.fingerprint'), { mode: 0o700 })
  writeFileSync(join(debug, '.fingerprint', 'unit.json'), '{"synthetic":true}', { mode: 0o600 })
  writeFileSync(join(run, 'diagnostic-receipt.json'), '{"passed":false}', { mode: 0o600 })
  writeCargoLocks(root, runId)
  return { run, binary }
}
function rejection(action, code) {
  assert.throws(action, error => error.code === code || error.message === code)
}
function controllerWithHeavyStages(root, runId, inspect = ample) {
  const controller = acquireBuildStorage({ root, inspect })
  for (const stage of HEAVY_STAGES) controller.checkHeavyStage(stage)
  return controller
}

// --- synthetic Builder entry -------------------------------------------------

const BUILDER_MOCK_VITE = `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export function build(options) {
  const outDir = options.build.outDir
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(outDir, 'index.html'), '<!doctype html><main>testmock</main>\\n', { mode: 0o600 })
  const config = {
    envFile: false,
    envDir: false,
    configFile: undefined,
    inlineConfig: { envDir: options.envDir },
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('VITE_')))
  }
  for (const plugin of options.plugins ?? []) plugin.configResolved?.(config)
  return { config }
}
`
const BUILDER_MOCK_PLUGIN_VUE = `export default function vue() { return { name: 'vite:vue' } }\n`
const BUILDER_MOCK_TAURI = `import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const target = process.env.CARGO_TARGET_DIR
const binary = process.env.TESTMOCK_BINARY_PATH
if (!target || !binary) { process.stderr.write('testmock: missing mock environment\\n'); process.exit(1) }
const debug = join(target, 'debug')
for (const directory of ['build', 'deps', 'incremental', '.fingerprint']) mkdirSync(join(debug, directory), { recursive: true, mode: 0o700 })
writeFileSync(join(debug, '.fingerprint', 'testmock.json'), '{"testmock":true}\\n', { mode: 0o600 })
writeFileSync(join(debug, 'build', 'testmock-build.bin'), 'testmock-build\\n', { mode: 0o600 })
writeFileSync(join(debug, 'deps', 'testmock-dep.bin'), 'testmock-dep\\n', { mode: 0o600 })
writeFileSync(join(debug, 'incremental', 'testmock-incremental.bin'), 'testmock-incremental\\n', { mode: 0o600 })
writeFileSync(join(debug, '.cargo-lock'), '', { mode: 0o600 })
writeFileSync(join(debug, '.cargo-build-lock'), '', { mode: 0o600 })
writeFileSync(join(debug, '.cargo-artifact-lock'), '', { mode: 0o600 })
copyFileSync(binary, join(debug, 'dbstudio-desktop'))
process.stdout.write('testmock: simulated debug artifact build\\n')
`
const BUILDER_MOCK_PRELOAD = `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const config = JSON.parse(process.env.TESTMOCK_CONFIG ?? '{}')
const childProcess = require('node:child_process')
const realSpawnSync = childProcess.spawnSync
const expected = config.expectedTests ?? []
childProcess.spawnSync = (program, args, options) => {
  if (program === 'git') {
    const stdout = args.includes('rev-parse') ? 'a'.repeat(40) + '\\n' : ''
    return { status: 0, stdout, stderr: '', error: undefined, output: [] }
  }
  if (program === 'cargo') {
    if (args.includes('test')) {
      const lines = expected.map(name => 'test mysql_acceptance::tests::' + name + ' ... ok')
      lines.push('test result: ok. ' + expected.length + ' passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s')
      return { status: 0, stdout: lines.join('\\n') + '\\n', stderr: '', error: undefined, output: [] }
    }
    return { status: 0, stdout: 'testmock: simulated cargo check\\n', stderr: '', error: undefined, output: [] }
  }
  const childResult = realSpawnSync(program, args, options)
  if (childResult.status !== 0) process.stderr.write('TESTMOCK_CHILD_FAILED ' + String(program) + ' ' + String(Array.isArray(args) ? args[1] : '') + '\\n' + String(childResult.stderr || '').slice(0, 4000) + '\\n')
  return childResult
}
if (config.failOpenSuffix) {
  const fs = require('node:fs')
  const realOpenSync = fs.openSync
  let used = false
  fs.openSync = (...args) => {
    if (!used && String(args[0]).endsWith(config.failOpenSuffix)) {
      used = true
      const error = new Error('injected open failure')
      error.code = 'EACCES'
      throw error
    }
    return realOpenSync(...args)
  }
}
if (config.failWriteSuffix) {
  const fs = require('node:fs')
  const realWriteFileSync = fs.writeFileSync
  fs.writeFileSync = (path, ...rest) => {
    if (String(path).endsWith(config.failWriteSuffix)) {
      const error = new Error('injected write failure')
      error.code = 'EIO'
      throw error
    }
    return realWriteFileSync(path, ...rest)
  }
}
`
function builderSourceText() {
  return readFileSync(join(project, 'scripts', 'build-mysql-acceptance.mjs'), 'utf8')
}
function builderExpectedTests() {
  const source = builderSourceText()
  const start = source.indexOf('const expectedTests = [')
  const end = source.indexOf('].sort()', start)
  return [...source.slice(start, end).matchAll(/'([a-z0-9_]+)'/g)].map(match => match[1]).sort()
}
function builderSourcePaths() {
  const source = builderSourceText()
  const start = source.indexOf('const sourcePaths = [')
  const end = source.indexOf('].sort(', start)
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map(match => match[1])
}
function writeMockFile(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, content, { mode: 0o600 })
}
function syntheticBuilderRepo(name) {
  const root = join(fixtureRoot, name, 'repo')
  mkdirSync(join(root, 'backups'), { recursive: true, mode: 0o700 })
  for (const relative of builderSourcePaths()) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, `// synthetic testmock source: ${relative}\n`, { mode: 0o600 })
  }
  copyFileSync(join(project, 'scripts', 'build-mysql-acceptance.mjs'), join(root, 'scripts', 'build-mysql-acceptance.mjs'))
  copyFileSync(join(project, 'scripts', 'mysql-acceptance-storage.mjs'), join(root, 'scripts', 'mysql-acceptance-storage.mjs'))
  chmodSync(join(root, 'scripts', 'build-mysql-acceptance.mjs'), 0o600)
  chmodSync(join(root, 'scripts', 'mysql-acceptance-storage.mjs'), 0o600)
  writeFileSync(join(root, 'src-tauri', 'tauri.mysql-acceptance.conf.json'), JSON.stringify({
    identifier: 'io.dbstudio.mysql-acceptance', app: { windows: [] }, build: { devUrl: null }
  }, null, 2), { mode: 0o600 })
  writeMockFile(join(root, 'node_modules', 'vue-tsc', 'package.json'), JSON.stringify({ name: 'vue-tsc', version: '0.0.0-testmock', type: 'module' }))
  writeMockFile(join(root, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js'), 'process.stdout.write("testmock: simulated vue typecheck\\n")\n')
  writeMockFile(join(root, 'node_modules', '@tauri-apps', 'cli', 'package.json'), JSON.stringify({ name: '@tauri-apps/cli', version: '0.0.0-testmock', type: 'module' }))
  writeMockFile(join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), BUILDER_MOCK_TAURI)
  writeMockFile(join(root, 'node_modules', 'vite', 'package.json'), JSON.stringify({ name: 'vite', version: '0.0.0-testmock', type: 'module', main: 'index.mjs', exports: { '.': './index.mjs' } }))
  writeMockFile(join(root, 'node_modules', 'vite', 'index.mjs'), BUILDER_MOCK_VITE)
  writeMockFile(join(root, 'node_modules', '@vitejs', 'plugin-vue', 'package.json'), JSON.stringify({ name: '@vitejs/plugin-vue', version: '0.0.0-testmock', type: 'module', main: 'index.mjs', exports: { '.': './index.mjs' } }))
  writeMockFile(join(root, 'node_modules', '@vitejs', 'plugin-vue', 'index.mjs'), BUILDER_MOCK_PLUGIN_VUE)
  return root
}
function runSyntheticBuilder(root, config = {}) {
  const preload = join(fixtureRoot, 'testmock-preload.mjs')
  const binary = join(fixtureRoot, 'testmock-dbstudio-desktop')
  writeMockFile(preload, BUILDER_MOCK_PRELOAD)
  writeFileSync(binary, machO(['/usr/lib/libSystem.B.dylib']), { mode: 0o600 })
  return spawnSync(NODE, ['--import', preload, join(root, 'scripts', 'build-mysql-acceptance.mjs')], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TESTMOCK_CONFIG: JSON.stringify(config), TESTMOCK_BINARY_PATH: binary }
  })
}

test('low space creates neither run nor lease', () => {
  const root = caseRoot('low-space')
  rejection(() => acquireBuildStorage({ root, inspect: () => ({ availableBytes: MIN_AVAILABLE_BYTES - 1, cacheAllocatedBytes: 0 }) }), 'STORAGE_SPACE_LOW')
  assert.deepEqual(readdirSync(join(root, 'backups')), [])
})

test('cache budget blocks without deleting an old cache', () => {
  const root = caseRoot('budget')
  const old = cacheFile(root, 'a'.repeat(32))
  rejection(() => acquireBuildStorage({ root, inspect: () => ({ availableBytes: MIN_AVAILABLE_BYTES * 2, cacheAllocatedBytes: MAX_CACHE_BYTES }) }), 'STORAGE_CACHE_BUDGET')
  assert.equal(readFileSync(old, 'utf8'), `owned-${'a'.repeat(32)}-deps-cache.bin`)
  assert.deepEqual(readdirSync(join(root, 'backups')), [`mysql-acceptance-host-build-${'a'.repeat(32)}`])
})

test('allocated cache scan is scoped and inode deduplicated', () => {
  const root = caseRoot('allocated')
  const first = cacheFile(root, 'b'.repeat(32))
  linkSync(first, join(dirname(first), 'same-inode.bin'))
  const ignored = join(root, 'backups', 'not-an-acceptance-run')
  mkdirSync(ignored, { mode: 0o700 })
  writeFileSync(join(ignored, 'ignored.bin'), 'not-scanned')
  const actual = inspectStorage(root)
  assert.equal(actual.cacheAllocatedBytes, statSync(first).blocks * 512)
})

test('lease rejects concurrency and normal close releases', () => {
  const root = caseRoot('lease')
  const first = acquireBuildStorage({ root, inspect: ample })
  rejection(() => acquireBuildStorage({ root, inspect: ample }), 'STORAGE_LEASE_BUSY')
  first.checkHeavyStage('host-negative-and-contract-tests')
  const closed = first.close({ runId: null, passed: false })
  assert.equal(closed.leaseReleased, true)
})

test('post-lease low-space recheck releases the owned lease', () => {
  const root = caseRoot('lease-recheck')
  let calls = 0
  rejection(() => acquireBuildStorage({ root, inspect: () => ++calls === 1 ? ample() : { availableBytes: MIN_AVAILABLE_BYTES - 1, cacheAllocatedBytes: 0 } }), 'STORAGE_SPACE_LOW')
  assert.equal(existsSync(join(root, 'backups', 'mysql-acceptance-storage.lease')), false)
  assert.deepEqual(readdirSync(join(root, 'backups')), [])
})

test('heavy-stage exception releases only the owned lease', () => {
  const root = caseRoot('lease-exception')
  let calls = 0
  const controller = acquireBuildStorage({ root, inspect: () => ++calls > 2 ? { availableBytes: MIN_AVAILABLE_BYTES - 1, cacheAllocatedBytes: 0 } : ample() })
  rejection(() => controller.checkHeavyStage('debug-test-artifact'), 'STORAGE_SPACE_LOW')
  const closed = controller.close({ runId: null, passed: false })
  assert.equal(closed.leaseReleased, true)
  assert.equal(existsSync(join(root, 'backups', 'mysql-acceptance-storage.lease')), false)
})

test('forged lease owner is preserved and never released', () => {
  const root = caseRoot('forged-owner')
  const controller = acquireBuildStorage({ root, inspect: ample })
  const owner = join(root, 'backups', 'mysql-acceptance-storage.lease', 'owner.json')
  writeFileSync(owner, '{"schemaVersion":1,"token":"forged"}\n')
  const closed = controller.close({ runId: null, passed: false })
  assert.equal(closed.leaseReleased, false)
  assert.equal(closed.failureCode, 'STORAGE_LEASE_OWNER_MISMATCH')
  assert.equal(readFileSync(owner, 'utf8'), '{"schemaVersion":1,"token":"forged"}\n')
})

test('success removes only this run three caches and returns a sealed proof', () => {
  const root = caseRoot('success')
  const runId = 'c'.repeat(32)
  const { run, binary } = successfulRun(root, runId)
  const protectedPaths = [binary, join(run, 'frontend', 'index.html'), join(run, 'target', 'debug', '.fingerprint', 'unit.json'), join(run, 'diagnostic-receipt.json')]
  const before = protectedPaths.map(path => [hash(path), lstatSync(path).mode, lstatSync(path).ino])
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.cacheLifecycle, 'current-run-caches-recycled')
  assert.equal(lifecycle.recycle.passed, true)
  assert.equal(lifecycle.closed, true)
  assert.equal(lifecycle.leaseReleased, true)
  for (const cache of ['deps', 'build', 'incremental']) assert.equal(existsSync(join(run, 'target', 'debug', cache)), false)
  assert.deepEqual(protectedPaths.map(path => [hash(path), lstatSync(path).mode, lstatSync(path).ino]), before)
  const receipt = { storagePolicy: storagePolicyBinding(), storageLifecycle: lifecycle }
  assert.equal(verifyStorageReceipt(receipt, runId), true)
})

test('failed build retains its diagnostic caches and receipt is not promoted', () => {
  const root = caseRoot('failed-build')
  const runId = 'd'.repeat(32)
  const { run } = successfulRun(root, runId)
  const controller = acquireBuildStorage({ root, inspect: ample })
  const lifecycle = controller.close({ runId, passed: false })
  assert.equal(lifecycle.cacheLifecycle, 'failure-diagnostics-retained')
  assert.equal(lifecycle.recycle, null)
  assert.equal(lifecycle.closed, true)
  for (const cache of ['deps', 'build', 'incremental']) assert.equal(existsSync(join(run, 'target', 'debug', cache)), true)
  rejection(() => verifyStorageReceipt({ storagePolicy: storagePolicyBinding(), storageLifecycle: lifecycle }, runId), 'STORAGE_RECYCLE_PROOF_INVALID')
})

test('symlink and outside-root target reject before unlinking', () => {
  const root = caseRoot('symlink')
  const runId = 'e'.repeat(32)
  const { run } = successfulRun(root, runId)
  const outside = join(root, 'outside.bin')
  writeFileSync(outside, 'outside-must-survive')
  const cache = join(run, 'target', 'debug', 'deps')
  rmSync(cache, { recursive: true })
  symlinkSync(root, cache, 'dir')
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.recycle.passed, false)
  assert.equal(lifecycle.failureCode, 'STORAGE_CACHE_INVALID')
  assert.equal(readFileSync(outside, 'utf8'), 'outside-must-survive')
  assert.equal(lstatSync(cache).isSymbolicLink(), true)
})

test('external hardlink rejects and preserves both links', () => {
  const root = caseRoot('hardlink')
  const runId = 'f'.repeat(32)
  const { run } = successfulRun(root, runId)
  const cache = join(run, 'target', 'debug', 'deps', 'cache.bin')
  const outside = join(root, 'outside-hardlink.bin')
  linkSync(cache, outside)
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.recycle.passed, false)
  assert.equal(lifecycle.failureCode, 'STORAGE_CACHE_INVALID')
  assert.equal(readFileSync(cache, 'utf8'), readFileSync(outside, 'utf8'))
})

test('dynamic dependency inside a recyclable cache rejects', () => {
  const root = caseRoot('dynamic-dependency')
  const runId = '1'.repeat(32)
  const dependency = join(root, 'backups', `mysql-acceptance-host-build-${runId}`, 'target', 'debug', 'deps', 'libdynamic.dylib')
  const { run } = successfulRun(root, runId, [dependency])
  writeFileSync(dependency, 'synthetic-library', { mode: 0o600 })
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.recycle.passed, false)
  assert.equal(lifecycle.failureCode, 'STORAGE_BINARY_DEPENDENCY_INVALID')
  assert.equal(existsSync(join(run, 'target', 'debug', 'deps', 'cache.bin')), true)
})

test('helper SHA drift and forged recycle proof are rejected', () => {
  const root = caseRoot('binding')
  const runId = '3'.repeat(32)
  successfulRun(root, runId)
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  const receipt = { storagePolicy: storagePolicyBinding(), storageLifecycle: lifecycle }
  rejection(() => verifyStorageReceipt(receipt, runId, { ...storagePolicyBinding(), sourceSha256: '0'.repeat(64) }), 'STORAGE_POLICY_MISMATCH')
  const forged = structuredClone(receipt)
  forged.storageLifecycle.recycle.protectedAfterSha256 = '0'.repeat(64)
  rejection(() => verifyStorageReceipt(forged, runId), 'STORAGE_RECYCLE_PROOF_INVALID')
})

// --- A: production Builder seam ---------------------------------------------

test('the builder entry closes the real run with a bare run id and publishes a verifiable receipt', () => {
  const root = syntheticBuilderRepo('builder-entry')
  const expected = builderExpectedTests()
  assert.equal(expected.length, 140)
  const result = runSyntheticBuilder(root, { expectedTests: expected })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.passed, true)
  assert.equal(report.storageLifecycle.recycle.passed, true)
  assert.match(report.storageLifecycle.recycle.runId, /^[a-f0-9]{32}$/)
  assert.equal(basename(report.evidenceDirectory), `mysql-acceptance-host-build-${report.storageLifecycle.recycle.runId}`)
  assert.deepEqual(report.storageLifecycle.heavyStageChecks.map(check => check.stage), HEAVY_STAGES)
  assert.equal(verifyStorageReceipt({ storagePolicy: report.storagePolicy, storageLifecycle: report.storageLifecycle }, report.storageLifecycle.recycle.runId), true)
  for (const cache of ['build', 'deps', 'incremental']) assert.equal(existsSync(join(report.evidenceDirectory, 'target', 'debug', cache)), false)
  assert.match(readFileSync(join(report.evidenceDirectory, 'frontend', 'index.html'), 'utf8'), /testmock/)
  assert.deepEqual(report.verifiedTests, expected)
  assert.deepEqual(report.stages.map(stage => stage.name), [
    'direct-source-head', 'direct-source-dirty-paths', 'vue-typecheck', 'fresh-frontend-env-isolated',
    'host-negative-and-contract-tests', 'sqlite-smoke-cfg-compile-only', 'debug-test-artifact'
  ])
  assert.equal(report.stages.every(stage => stage.passed), true)
  assert.equal(report.binarySha256 !== null, true)
})

test('a prefixed run alias is never accepted as a run id', () => {
  const root = caseRoot('run-alias')
  const runId = '7'.repeat(32)
  successfulRun(root, runId)
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId: `mysql-acceptance-host-build-${runId}`, passed: true })
  assert.equal(lifecycle.recycle.passed, false)
  assert.equal(lifecycle.failureCode, 'STORAGE_RUN_INVALID')
})

// --- B: hardlink closure -----------------------------------------------------

test('an internal hardlink inside one cache is reclaimed and both aliases disappear', () => {
  const root = caseRoot('hardlink-internal')
  const runId = '8'.repeat(32)
  const { run } = successfulRun(root, runId)
  const first = join(run, 'target', 'debug', 'deps', 'cache.bin')
  const second = join(dirname(first), 'alias.bin')
  linkSync(first, second)
  assert.equal(lstatSync(first).nlink, 2)
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.recycle.passed, true)
  assert.equal(existsSync(first), false)
  assert.equal(existsSync(second), false)
})

test('an internal hardlink across two caches is reclaimed and counted once', () => {
  const root = caseRoot('hardlink-cross-cache')
  const runId = '9'.repeat(32)
  const { run } = successfulRun(root, runId)
  const first = join(run, 'target', 'debug', 'deps', 'cache.bin')
  const second = join(run, 'target', 'debug', 'build', 'cache-alias.bin')
  linkSync(first, second)
  const sharedBytes = statSync(first).blocks * 512
  const buildBytes = statSync(join(run, 'target', 'debug', 'build', 'cache.bin')).blocks * 512
  const incrementalBytes = statSync(join(run, 'target', 'debug', 'incremental', 'cache.bin')).blocks * 512
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.recycle.passed, true)
  assert.equal(lifecycle.recycle.reclaimedBytes, sharedBytes + buildBytes + incrementalBytes)
  assert.equal(existsSync(first), false)
  assert.equal(existsSync(second), false)
})

test('a protected alias rejects the recycle and preserves the protected file', () => {
  const root = caseRoot('hardlink-protected')
  const runId = 'a'.repeat(32)
  const run = join(root, 'backups', `mysql-acceptance-host-build-${runId}`)
  const cache = cacheFile(root, runId)
  mkdirSync(join(run, 'frontend'), { mode: 0o700 })
  linkSync(cache, join(run, 'frontend', 'index.html'))
  const debug = join(run, 'target', 'debug')
  writeFileSync(join(debug, 'dbstudio-desktop'), machO(['/usr/lib/libSystem.B.dylib']), { mode: 0o700 })
  mkdirSync(join(debug, '.fingerprint'), { mode: 0o700 })
  writeFileSync(join(debug, '.fingerprint', 'unit.json'), '{"synthetic":true}', { mode: 0o600 })
  writeCargoLocks(root, runId)
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.recycle.passed, false)
  assert.equal(lifecycle.failureCode, 'STORAGE_CACHE_INVALID')
  assert.equal(existsSync(cache), true)
  assert.equal(readFileSync(join(run, 'frontend', 'index.html'), 'utf8'), `owned-${runId}-deps-cache.bin`)
})

// --- C: exact thresholds -----------------------------------------------------

test('the minimum available bytes are exactly twenty gibibytes and the threshold is inclusive', () => {
  assert.equal(MIN_AVAILABLE_BYTES, 21_474_836_480)
  const root = caseRoot('threshold-minimum')
  rejection(() => acquireBuildStorage({ root, inspect: () => ({ availableBytes: 21_474_836_479, cacheAllocatedBytes: 0 }) }), 'STORAGE_SPACE_LOW')
  assert.deepEqual(readdirSync(join(root, 'backups')), [])
  const controller = acquireBuildStorage({ root, inspect: () => ({ availableBytes: 21_474_836_480, cacheAllocatedBytes: 0 }) })
  assert.equal(controller.close({ runId: null, passed: false }).leaseReleased, true)
})

test('the maximum cache bytes are exactly eight gibibytes and the threshold is exclusive', () => {
  assert.equal(MAX_CACHE_BYTES, 8_589_934_592)
  const root = caseRoot('threshold-maximum')
  rejection(() => acquireBuildStorage({ root, inspect: () => ({ availableBytes: 21_474_836_480, cacheAllocatedBytes: 8_589_934_592 }) }), 'STORAGE_CACHE_BUDGET')
  assert.deepEqual(readdirSync(join(root, 'backups')), [])
  const controller = acquireBuildStorage({ root, inspect: () => ({ availableBytes: 21_474_836_480, cacheAllocatedBytes: 8_589_934_591 }) })
  assert.equal(controller.close({ runId: null, passed: false }).leaseReleased, true)
})

// --- D: dynamic dependency fail closed ---------------------------------------

test('an @rpath dependency is parsed and then rejected', () => {
  const root = caseRoot('dependency-rpath')
  const runId = 'b'.repeat(32)
  const { run, binary } = successfulRun(root, runId, ['@rpath/libmissing.dylib'])
  assert.deepEqual(inspectBinaryDependencies(binary), ['@rpath/libmissing.dylib'])
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.recycle.passed, false)
  assert.equal(lifecycle.failureCode, 'STORAGE_BINARY_DEPENDENCY_INVALID')
  assert.equal(existsSync(join(run, 'target', 'debug', 'deps', 'cache.bin')), true)
})

test('an @loader_path dependency is parsed and then rejected', () => {
  const root = caseRoot('dependency-loader-path')
  const runId = 'c'.repeat(32)
  const { run, binary } = successfulRun(root, runId, ['@loader_path/libmissing.dylib'])
  assert.deepEqual(inspectBinaryDependencies(binary), ['@loader_path/libmissing.dylib'])
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.recycle.passed, false)
  assert.equal(lifecycle.failureCode, 'STORAGE_BINARY_DEPENDENCY_INVALID')
  assert.equal(existsSync(join(run, 'target', 'debug', 'deps', 'cache.bin')), true)
})

test('a relative install name is parsed and then rejected', () => {
  const root = caseRoot('dependency-relative')
  const runId = 'd'.repeat(32)
  const { run, binary } = successfulRun(root, runId, ['deps/librelative.dylib'])
  assert.deepEqual(inspectBinaryDependencies(binary), ['deps/librelative.dylib'])
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.recycle.passed, false)
  assert.equal(lifecycle.failureCode, 'STORAGE_BINARY_DEPENDENCY_INVALID')
  assert.equal(existsSync(join(run, 'target', 'debug', 'deps', 'cache.bin')), true)
})

test('an absolute dependency outside the caches is accepted', () => {
  const root = caseRoot('dependency-absolute-outside')
  const runId = 'e'.repeat(32)
  const library = join(fixtureRoot, 'outside-library.dylib')
  writeFileSync(library, 'synthetic-outside-library', { mode: 0o600 })
  const { binary } = successfulRun(root, runId, [library])
  assert.deepEqual(inspectBinaryDependencies(binary), [library])
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.recycle.passed, true)
})

test('an unknown binary format fails closed', () => {
  const root = caseRoot('dependency-unknown-format')
  const runId = 'f'.repeat(32)
  const { run, binary } = successfulRun(root, runId)
  writeFileSync(binary, 'this is not a mach-o image', { mode: 0o700 })
  assert.throws(() => inspectBinaryDependencies(binary), error => error.code === 'STORAGE_BINARY_DEPENDENCY_INVALID')
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.recycle.passed, false)
  assert.equal(lifecycle.failureCode, 'STORAGE_BINARY_DEPENDENCY_INVALID')
  assert.equal(existsSync(join(run, 'target', 'debug', 'deps', 'cache.bin')), true)
})

test('only macOS dependency inspection is supported', () => {
  assert.equal(typeof storageModule.dependencyInspectionSupported, 'function')
  assert.equal(storageModule.dependencyInspectionSupported('darwin'), true)
  assert.equal(storageModule.dependencyInspectionSupported('win32'), false)
  assert.equal(storageModule.dependencyInspectionSupported('linux'), false)
})

// --- E: real occupancy rejection ---------------------------------------------

const LOCK_HOLDER = `import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
sys.stdout.write('locked\\n')
sys.stdout.flush()
sys.stdin.read()
`

test('a real cargo lock held by another process blocks the recycle with zero deletions', async () => {
  for (const [index, lockName] of ['.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock'].entries()) {
    const root = caseRoot(`cargo-lock-busy-${index}`)
    const runId = '5'.repeat(32)
    const { run } = successfulRun(root, runId)
    const lock = join(run, 'target', 'debug', lockName)
    const child = spawn(PYTHON, ['-c', LOCK_HOLDER, lock], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      await new Promise((resolveReady, rejectReady) => {
        let output = ''
        child.stdout.on('data', chunk => { output += chunk; if (output.includes('locked')) resolveReady() })
        child.on('error', rejectReady)
        child.on('exit', () => rejectReady(new Error('lock holder exited early')))
      })
      const controller = controllerWithHeavyStages(root, runId)
      const lifecycle = controller.close({ runId, passed: true })
      assert.equal(lifecycle.recycle.passed, false)
      assert.equal(lifecycle.failureCode, 'STORAGE_CACHE_OCCUPIED')
      for (const cache of ['deps', 'build', 'incremental']) {
        assert.equal(existsSync(join(run, 'target', 'debug', cache, 'cache.bin')), true)
      }
      child.stdin.end()
      await new Promise(resolveExit => child.on('exit', resolveExit))
      const retry = controllerWithHeavyStages(root, runId)
      const released = retry.close({ runId, passed: true })
      assert.equal(released.recycle.passed, true)
      for (const cache of ['deps', 'build', 'incremental']) {
        assert.equal(existsSync(join(run, 'target', 'debug', cache)), false)
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end()
        child.kill('SIGTERM')
        await new Promise(resolveExit => child.on('exit', resolveExit))
      }
    }
  }
})

test('a missing cargo lock rejects the recycle and is never created', () => {
  for (const [index, lockName] of ['.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock'].entries()) {
    const root = caseRoot(`cargo-lock-missing-${index}`)
    const runId = '6'.repeat(32)
    const { run } = successfulRun(root, runId)
    const missing = join(run, 'target', 'debug', lockName)
    rmSync(missing)
    const controller = controllerWithHeavyStages(root, runId)
    const lifecycle = controller.close({ runId, passed: true })
    assert.equal(lifecycle.recycle.passed, false)
    assert.equal(lifecycle.failureCode, 'STORAGE_CARGO_LOCK_MISSING')
    assert.equal(existsSync(missing), false)
    assert.equal(existsSync(join(run, 'target', 'debug', 'deps', 'cache.bin')), true)
  }
})

test('an unsafe cargo lock rejects the recycle and is never replaced', () => {
  for (const [index, lockName] of ['.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock'].entries()) {
    const root = caseRoot(`cargo-lock-unsafe-${index}`)
    const runId = '2'.repeat(32)
    const { run } = successfulRun(root, runId)
    const unsafe = join(run, 'target', 'debug', lockName)
    rmSync(unsafe)
    mkdirSync(unsafe, { mode: 0o700 })
    const controller = controllerWithHeavyStages(root, runId)
    const lifecycle = controller.close({ runId, passed: true })
    assert.equal(lifecycle.recycle.passed, false)
    assert.equal(lifecycle.failureCode, 'STORAGE_CARGO_LOCK_UNSAFE')
    assert.equal(lstatSync(unsafe).isDirectory(), true)
    assert.equal(existsSync(join(run, 'target', 'debug', 'deps', 'cache.bin')), true)
  }
})

test('real Cargo profile lock layout works without root/deps .cargo-lock', () => {
  const root = caseRoot('cargo-lock-real-profile-layout')
  const runId = '7'.repeat(32)
  const { run } = successfulRun(root, runId)
  const debug = join(run, 'target', 'debug')
  const goldenLocks = [
    join(debug, '.cargo-lock'),
    join(debug, '.cargo-build-lock'),
    join(debug, '.cargo-artifact-lock')
  ]
  const obsoleteLocks = [join(run, 'target', '.cargo-lock'), join(debug, 'deps', '.cargo-lock')]
  const metadata = info => ({
    dev: info.dev, ino: info.ino, mode: info.mode, nlink: info.nlink, size: info.size, uid: info.uid
  })
  const before = goldenLocks.map(path => {
    const info = lstatSync(path)
    assert.equal(info.isFile(), true)
    return metadata(info)
  })
  const debugLockNames = () => readdirSync(debug)
    .filter(name => name.startsWith('.cargo') && name.endsWith('lock')).sort()
  assert.deepEqual(debugLockNames(), ['.cargo-artifact-lock', '.cargo-build-lock', '.cargo-lock'])
  for (const path of obsoleteLocks) assert.equal(existsSync(path), false)

  const lifecycle = controllerWithHeavyStages(root, runId).close({ runId, passed: true })
  assert.equal(lifecycle.failureCode, null)
  assert.equal(lifecycle.recycle.passed, true)
  for (const cache of ['deps', 'build', 'incremental']) {
    assert.equal(existsSync(join(debug, cache)), false)
  }
  assert.deepEqual(debugLockNames(), ['.cargo-artifact-lock', '.cargo-build-lock', '.cargo-lock'])
  goldenLocks.forEach((path, index) => assert.deepEqual(metadata(lstatSync(path)), before[index]))
  for (const path of obsoleteLocks) assert.equal(existsSync(path), false)
})

// --- F: receipt proof --------------------------------------------------------

test('a receipt without the three heavy stage checks is rejected', () => {
  const root = caseRoot('proof-empty')
  const runId = '3'.repeat(32)
  successfulRun(root, runId)
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  const receipt = { storagePolicy: storagePolicyBinding(), storageLifecycle: lifecycle }
  const forged = structuredClone(receipt)
  forged.storageLifecycle.heavyStageChecks = []
  rejection(() => verifyStorageReceipt(forged, runId), 'STORAGE_RECYCLE_PROOF_INVALID')
})

test('a receipt with duplicated heavy stage checks is rejected', () => {
  const root = caseRoot('proof-duplicate')
  const runId = '4'.repeat(32)
  successfulRun(root, runId)
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  const receipt = { storagePolicy: storagePolicyBinding(), storageLifecycle: lifecycle }
  const forged = structuredClone(receipt)
  forged.storageLifecycle.heavyStageChecks = [
    forged.storageLifecycle.heavyStageChecks[0],
    forged.storageLifecycle.heavyStageChecks[0],
    forged.storageLifecycle.heavyStageChecks[1]
  ]
  rejection(() => verifyStorageReceipt(forged, runId), 'STORAGE_RECYCLE_PROOF_INVALID')
})

test('a receipt with reordered heavy stage checks is rejected', () => {
  const root = caseRoot('proof-reordered')
  const runId = '5'.repeat(32)
  successfulRun(root, runId)
  const controller = controllerWithHeavyStages(root, runId)
  const lifecycle = controller.close({ runId, passed: true })
  const receipt = { storagePolicy: storagePolicyBinding(), storageLifecycle: lifecycle }
  const forged = structuredClone(receipt)
  const checks = forged.storageLifecycle.heavyStageChecks
  forged.storageLifecycle.heavyStageChecks = [checks[1], checks[0], checks[2]]
  rejection(() => verifyStorageReceipt(forged, runId), 'STORAGE_RECYCLE_PROOF_INVALID')
})

test('close cannot publish a successful recycle without the three heavy stage checks', () => {
  const root = caseRoot('proof-close')
  const runId = '6'.repeat(32)
  const { run } = successfulRun(root, runId)
  const controller = acquireBuildStorage({ root, inspect: ample })
  const lifecycle = controller.close({ runId, passed: true })
  assert.equal(lifecycle.recycle.passed, false)
  assert.equal(lifecycle.failureCode, 'STORAGE_HEAVY_STAGE_PROOF_INVALID')
  assert.equal(lifecycle.cacheLifecycle, 'current-run-caches-retained')
  assert.equal(existsSync(join(run, 'target', 'debug', 'deps', 'cache.bin')), true)
  rejection(() => verifyStorageReceipt({ storagePolicy: storagePolicyBinding(), storageLifecycle: lifecycle }, runId), 'STORAGE_RECYCLE_PROOF_INVALID')
})

// --- G: lease partial cleanup and closed report failure ----------------------

test('a lease whose owner file cannot be created leaves no partial lease behind', () => {
  const root = caseRoot('lease-partial')
  const preload = join(fixtureRoot, 'lease-preload.mjs')
  const driver = join(fixtureRoot, 'lease-driver.mjs')
  writeMockFile(preload, BUILDER_MOCK_PRELOAD)
  writeMockFile(driver, `import { acquireBuildStorage } from ${JSON.stringify(new URL('./mysql-acceptance-storage.mjs', import.meta.url).href)}
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2]
let first = null
try { acquireBuildStorage({ root }) } catch (error) { first = error.code ?? error.message }
const controller = acquireBuildStorage({ root })
const closed = controller.close({ runId: null, passed: false })
process.stdout.write(JSON.stringify({ first, released: closed.leaseReleased, entries: readdirSync(join(root, 'backups')) }) + '\\n')
`)
  const result = spawnSync(NODE, ['--import', preload, driver, root], {
    encoding: 'utf8',
    env: { ...process.env, TESTMOCK_CONFIG: JSON.stringify({ failOpenSuffix: 'owner.json' }) }
  })
  assert.equal(result.status, 0, result.stderr)
  const outcome = JSON.parse(result.stdout)
  assert.equal(outcome.first, 'STORAGE_LEASE_CREATE_FAILED')
  assert.equal(outcome.released, true)
  assert.deepEqual(outcome.entries, [])
  assert.equal(existsSync(join(root, 'backups', 'mysql-acceptance-storage.lease')), false)
})

test('a report write failure exits with a closed code and no raw stack', () => {
  const root = syntheticBuilderRepo('builder-report-failure')
  const expected = builderExpectedTests()
  const result = runSyntheticBuilder(root, { expectedTests: expected, failWriteSuffix: 'build-report.json' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /MYSQL_ACCEPTANCE_REPORT_WRITE_FAILED/)
  assert.equal(/at .*\(.*:\d+:\d+\)/.test(result.stderr), false)
  assert.equal(result.stderr.includes(fixtureRoot), false)
  assert.equal(result.stdout.includes('"passed": true'), false)
  const runs = readdirSync(join(root, 'backups')).filter(name => name.startsWith('mysql-acceptance-host-build-'))
  assert.equal(runs.length, 1)
  assert.equal(existsSync(join(root, 'backups', 'mysql-acceptance-storage.lease')), false)
  assert.equal(existsSync(join(root, 'backups', runs[0], 'build-report.json')), false)
})

// --- byte preservation --------------------------------------------------------

test('the expected test names and build stages stay byte identical', () => {
  const source = builderSourceText()
  const start = source.indexOf('const expectedTests = [')
  const end = source.indexOf('].sort()', start) + '].sort()'.length
  assert.equal(createHash('sha256').update(source.slice(start, end)).digest('hex'), EXPECTED_TESTS_BLOCK_SHA256)
  const stages = [...source.matchAll(/command\('([a-z0-9-]+)'/g)].map(match => match[1])
  assert.equal(createHash('sha256').update(JSON.stringify(stages)).digest('hex'), EXPECTED_STAGE_SEQUENCE_SHA256)
  assert.equal(stages.length, 7)
})
