import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { parseListedHostTests, assertHostTestsExecuted } from './native-host-test-gate.mjs'

const names = [
  'mysql_acceptance::tests::mysql_host_time_four_step_idempotency_wrapper_and_ack_equality',
  'mysql_acceptance::tests::mysql_host_binary_request_exact_ten_fields_and_ranges',
  'mysql_acceptance::tests::mysql_host_negative_manifest_hardlink_rejected_without_read',
]
const options = { minExecuted: 3 }
const listing = (list) => `${list.map((name) => `${name}: test\n`).join('')}\n${list.length} tests, 0 benchmarks\n`
const runOutput = (list, { passed = list.length, failed = 0, ignored = 0, filtered = 7 } = {}) =>
  `running ${passed + ignored} tests\n${list.map((name) => `test ${name} ... ok\n`).join('')}test result: ok. ${passed} passed; ${failed} failed; ${ignored} ignored; 0 measured; ${filtered} filtered out; finished in 0.02s\n`

test('parses only executed test entries from cargo test --list output', () => {
  const output = `\u001b[0m   Compiling dbstudio v0.1.0\r\n${listing(names).replaceAll('\n', '\r\n')}`
  assert.deepEqual(parseListedHostTests(output), names)
  assert.deepEqual(parseListedHostTests('\n0 tests, 0 benchmarks\n'), [])
})

test('accepts a run where exactly the listed host contracts executed and passed', () => {
  assert.equal(assertHostTestsExecuted(runOutput(names), names, options), names.length)
  assert.equal(assertHostTestsExecuted(runOutput(names).replaceAll('\n', '\r\n'), names, options), names.length)
})

test('rejects successful cargo exits with zero executed host tests', () => {
  assert.throws(() => assertHostTestsExecuted('running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 140 filtered out; finished in 0.00s\n', [], options))
  assert.throws(() => assertHostTestsExecuted(runOutput(names), [], options))
  assert.throws(() => assertHostTestsExecuted('', names, options))
})

test('rejects ignored, failed, inconsistent or missing host test results', () => {
  for (const output of [
    runOutput(names, { ignored: 1 }),
    runOutput(names, { failed: 1 }),
    runOutput(names, { passed: names.length - 1, filtered: 8 }),
    runOutput(names.slice(1)),
    `${runOutput(names)}${runOutput(names)}`,
    runOutput(names).replace(/^test result:.*\n/m, ''),
    runOutput(names).replace(/^test .* \.\.\. ok\n/m, ''),
  ]) assert.throws(() => assertHostTestsExecuted(output, names, options))
})

test('rejects unlisted, duplicated or too few host contracts', () => {
  const other = [...names.slice(0, 2), 'mysql_acceptance::tests::mysql_time_checkpoint']
  assert.throws(() => assertHostTestsExecuted(runOutput(other), other, options))
  assert.throws(() => assertHostTestsExecuted(runOutput([names[0], names[0], names[1]]), [names[0], names[0], names[1]], options))
  assert.throws(() => assertHostTestsExecuted(runOutput(names), names))
})

test('CI runs the host gate instead of the zero-match mysql_host:: filter', () => {
  const workflow = readFileSync(new URL('../.github/workflows/native-verify.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts
  assert.match(workflow, /name:\s+Test native host execution evidence gate\n\s+run:\s+node --test scripts\/native-host-test-gate\.test\.mjs/)
  assert.match(workflow, /name:\s+Test MySQL acceptance host contracts\n\s+run:\s+pnpm test:native-host\n/)
  assert.ok(!workflow.includes('mysql_host::'), 'the zero-match cargo filter must not return')
  assert.ok(!workflow.includes('mysql_host_'), 'the workflow must delegate the host filter to the gated script')
  assert.equal(scripts['test:native-host'], 'node scripts/native-host-test-gate.mjs')
  assert.equal(scripts['test:native-host-gate'], 'node --test scripts/native-host-test-gate.test.mjs')
})
