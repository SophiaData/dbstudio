// Require that the MySQL acceptance host contract filter actually executed tests.
// Cargo exits 0 when a filter matches nothing, so the exit status alone is not evidence.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOST_FILTER = 'mysql_host_'
const HOST_TEST_PATH = 'mysql_acceptance::tests::mysql_host_'
// The reviewed retain-only host contract set is well above this floor; a smaller
// --list match means the filter or module layout changed and the gate must be re-reviewed.
const MIN_EXECUTED = 100
const CARGO_TEST_ARGS = [
  'test', '--locked', '-p', 'dbstudio-desktop', '--lib', '--features', 'mysql-acceptance', HOST_FILTER,
]

const normalize = (value) => String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '').replaceAll('\r\n', '\n')

export function parseListedHostTests(output) {
  return normalize(output).split('\n').flatMap((line) => {
    const match = /^([A-Za-z0-9_:]+): test$/.exec(line.trim())
    return match ? [match[1]] : []
  })
}

// Pure output policy: callers pass the `--list` match set and the captured test run.
export function assertHostTestsExecuted(output, listedNames, { minExecuted = MIN_EXECUTED } = {}) {
  const text = normalize(output)
  assert.ok(Array.isArray(listedNames) && listedNames.length > 0, 'cargo test --list must match host tests; a zero-match filter is not evidence')
  assert.equal(new Set(listedNames).size, listedNames.length, 'cargo test --list must not repeat host test names')
  for (const name of listedNames) assert.match(name, /^mysql_acceptance::tests::mysql_host_[A-Za-z0-9_]+$/, `listed test must be a mysql_acceptance::tests::mysql_host_ contract: ${name}`)
  assert.ok(listedNames.length >= minExecuted, `host test gate requires at least ${minExecuted} listed tests, cargo test --list matched ${listedNames.length}`)
  assert.ok(text.includes(HOST_TEST_PATH), 'cargo test output must name the executed mysql_acceptance::tests::mysql_host_ contracts')

  const executed = [...text.matchAll(/^test (\S+) \.\.\. ok\s*$/gm)].map((match) => match[1])
  assert.deepEqual([...executed].sort(), [...listedNames].sort(), 'every listed host test must execute and pass')
  const summaries = [...text.matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; 0 measured; \d+ filtered out; finished in [^\n]*$/gm)]
  assert.equal(summaries.length, 1, 'require exactly one host test result summary')
  const [, status, passed, failed, ignored] = summaries[0]
  assert.equal(status, 'ok', 'host test result must be ok')
  assert.equal(Number(failed), 0, 'host contract tests must not fail')
  assert.equal(Number(ignored), 0, 'host contract tests must not be ignored')
  assert.ok(Number(passed) > 0, 'host test summary must report executed tests, not only filtered-out cases')
  assert.equal(Number(passed), listedNames.length, 'executed host test count must match the cargo test --list match count')
  return Number(passed)
}

function cargo(args) {
  const result = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  if (result.error) throw new Error(`无法启动 cargo：${result.error.message}`)
  return result
}

export function main() {
  const list = cargo([...CARGO_TEST_ARGS, '--', '--list'])
  const listed = parseListedHostTests(list.stdout)
  assert.equal(list.status, 0, `cargo test --list 退出码非零：${list.status}\n${normalize(list.stderr).slice(-2000)}`)
  const run = cargo(CARGO_TEST_ARGS)
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  let passed
  try {
    passed = assertHostTestsExecuted(output, listed)
  } catch (error) {
    // Compile or link diagnostics only; the isolated host contracts use synthetic fixtures.
    console.error(normalize(run.stderr).split('\n').slice(-40).join('\n'))
    throw error
  }
  assert.equal(run.status, 0, `host 契约测试退出码非零：${run.status}`)
  console.log(`Native host gate: ${passed} mysql_acceptance::tests::mysql_host_ contracts executed and passed (cargo test --list matched ${listed.length})`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
