/**
 * Exercise the CLI in real child processes. A temporary pnpm records expensive
 * steps; the final case runs the repository's real manifest consistency test.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STEPS } from '../scripts/verify-manifest.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(join(tmpdir(), 'dbstudio-verify-runner-'))
const bin = join(temp, 'bin')
const log = join(temp, 'calls.jsonl')
const env = { ...process.env }
for (const name of Object.keys(env)) {
  if (name.startsWith('DBSTUDIO_')) delete env[name]
}
let passed = 0
let failed = 0

function test(name, run) {
  try {
    run()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

function invoke(args, overrides = {}, real = false) {
  writeFileSync(log, '')
  const result = spawnSync(process.execPath, ['scripts/verify.mjs', ...args], {
    cwd: real ? root : temp,
    env: { ...env, PATH: real ? env.PATH : bin, A4_CALL_LOG: log, ...overrides },
    encoding: 'utf8',
    timeout: 30_000
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  return { ...result, output: result.stdout + result.stderr, calls }
}

function summary(result, selected, executed, skipped, failures) {
  assert.match(
    result.output,
    new RegExp(`选中 ${selected} / 执行 ${executed} / 通过 \\d+ / 跳过 ${skipped} / 失败 ${failures}`)
  )
}

try {
  mkdirSync(join(temp, 'scripts'))
  mkdirSync(bin)
  for (const file of ['verify.mjs', 'verify-manifest.mjs']) {
    copyFileSync(join(root, 'scripts', file), join(temp, 'scripts', file))
  }
  const stub = join(bin, 'pnpm-stub.cjs')
  writeFileSync(stub, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.A4_CALL_LOG, JSON.stringify(args) + '\\n');
console.log('EXECUTED ' + args.join(' '));
if (process.env.A4_SKIP) console.log('SKIP  SSH assertions (sshd unavailable)');
if (process.env.A4_BLOCKED) console.log('BLOCKED_BY_SETUP connection prerequisite failed');
if (process.env.A4_EXIT) {
  console.error('fixture child failure');
  process.exit(Number(process.env.A4_EXIT));
}
`)
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'pnpm.cmd'), `@"${process.execPath}" "${stub}" %*\r\n`)
  } else {
    writeFileSync(join(bin, 'pnpm'), `#!${process.execPath}\nrequire(${JSON.stringify(stub)});\n`, { mode: 0o755 })
  }

  test('group conflict fails before launching a child', () => {
    const result = invoke(['node', '--only', 'test:postgres'])
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /冲突|conflict/i)
    assert.deepEqual(result.calls, [])
  })

  test('--only consumes its value and executes exactly one step', () => {
    const result = invoke(['--only', 'test:verify-manifest'])
    assert.equal(result.status, 0, result.output)
    assert.deepEqual(result.calls, [['run', 'test:verify-manifest']])
    summary(result, 1, 1, 0, 0)
  })

  const invalid = [
    [['--only'], /必须有一个步骤 id/],
    [['--only', '--require-external'], /必须有一个步骤 id/],
    [['--only', ''], /必须有一个步骤 id/],
    [['--only', 'test:missing'], /未知步骤/],
    [['missing'], /未知分组/],
    [['--wat'], /未知选项/],
    [['--only', 'test:verify-manifest', '--only', 'test:verify-manifest'], /重复选项/],
    [['--require-external', '--require-external'], /重复选项/]
  ]
  for (const [args, message] of invalid) {
    test(`invalid arguments ${JSON.stringify(args)}`, () => {
      const result = invoke(args)
      assert.equal(result.status, 1, result.output)
      assert.match(result.output, message)
      assert.deepEqual(result.calls, [])
    })
  }

  test('help describes single-step prerequisites without executing', () => {
    const result = invoke(['--help'])
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /--only/)
    assert.match(result.output, /build.*fixture/i)
    assert.deepEqual(result.calls, [])
  })

  test('no arguments preserve manifest order across all groups', () => {
    const result = invoke([])
    const runnable = STEPS.filter((step) => step.group !== 'external')
    assert.equal(result.status, 0, result.output)
    assert.deepEqual(result.calls, runnable.map((step) => ['run', step.id]))
    summary(result, STEPS.length, runnable.length, STEPS.length - runnable.length, 0)
  })

  test('node selects only its group in manifest order', () => {
    const result = invoke(['node'])
    const nodeSteps = STEPS.filter((step) => step.group === 'node')
    assert.equal(result.status, 0, result.output)
    assert.deepEqual(result.calls, nodeSteps.map((step) => ['run', step.id]))
    summary(result, nodeSteps.length, nodeSteps.length, 0, 0)
  })

  for (const step of STEPS.filter((step) => step.group === 'external')) {
    test(`${step.id}: missing environment is an explicit local skip`, () => {
      const result = invoke(['external', '--only', step.id])
      assert.equal(result.status, 0, result.output)
      assert.deepEqual(result.calls, [])
      for (const variable of step.env) assert.ok(result.output.includes(variable))
      summary(result, 1, 0, 1, 0)
    })
    test(`${step.id}: missing environment fails in CI`, () => {
      const result = invoke(['external', '--only', step.id, '--require-external'])
      assert.equal(result.status, 1, result.output)
      assert.deepEqual(result.calls, [])
      summary(result, 1, 0, 0, 1)
    })
  }

  test('external --only routes the CI PG command to the PG test', () => {
    const result = invoke(['external', '--only', 'test:postgres', '--require-external'], {
      DBSTUDIO_PG_URL: 'postgres://fixture/unused'
    })
    assert.equal(result.status, 0, result.output)
    assert.deepEqual(result.calls, [['run', 'test:postgres']])
    summary(result, 1, 1, 0, 0)
  })

  test('partial SSL configuration cannot pass strict mode', () => {
    const result = invoke(['external', '--only', 'test:postgres-ssl', '--require-external'], {
      DBSTUDIO_PG_SSL_URL: 'postgres://fixture/unused'
    })
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /DBSTUDIO_PG_PLAIN_URL/)
    assert.deepEqual(result.calls, [])
  })

  for (const strict of [false, true]) {
    test(`a child service skip is ${strict ? 'a CI failure' : 'counted as skipped'}`, () => {
      const result = invoke(['external', '--only', 'test:ssh-tunnel', ...(strict ? ['--require-external'] : [])], {
        DBSTUDIO_PG_URL: 'postgres://fixture/unused', A4_SKIP: '1'
      })
      assert.equal(result.status, strict ? 1 : 0, result.output)
      assert.match(result.output, /sshd unavailable/)
      summary(result, 1, 1, strict ? 0 : 1, strict ? 1 : 0)
    })
  }

  test('child failure preserves exit code and stderr and stops later steps', () => {
    const result = invoke(['node'], { A4_EXIT: '37' })
    assert.equal(result.status, 1, result.output)
    assert.equal(result.calls.length, 1)
    assert.match(result.output, /37/)
    assert.match(result.output, /fixture child failure/)
  })

  test('setup-blocked child cannot pass with exit code zero', () => {
    const result = invoke(['--only', 'test:verify-manifest'], { A4_BLOCKED: '1' })
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /BLOCKED_BY_SETUP/)
    summary(result, 1, 1, 0, 1)
  })

  test('missing executable is a failure with the actual launch reason', () => {
    const emptyBin = join(temp, 'empty-bin')
    mkdirSync(emptyBin)
    const result = invoke(['--only', 'test:verify-manifest'], { PATH: emptyBin })
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, process.platform === 'win32' ? /not recognized|ENOENT|找不到|不是内部/ : /ENOENT/)
  })

  test('empty manifest selection fails', () => {
    const manifest = join(temp, 'scripts', 'verify-manifest.mjs')
    const original = readFileSync(manifest, 'utf8')
    try {
      writeFileSync(manifest, 'export const STEPS = []; export const checkEnv = () => ({ok: true, missing: []});')
      const result = invoke([])
      assert.equal(result.status, 1, result.output)
    assert.match(result.output, /为空|empty|no steps/i)
      assert.deepEqual(result.calls, [])
    } finally {
      writeFileSync(manifest, original)
    }
  })

  test('real --only executes manifest test assertions (never the runner itself)', () => {
    const result = invoke(['--only', 'test:verify-manifest'], {}, true)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /验证清单一致性：\d+ 通过 \/ 0 失败/)
    summary(result, 1, 1, 0, 0)
  })
} finally {
  rmSync(temp, { recursive: true, force: true })
}

console.log(`\nverify runner: ${passed} passed / ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
