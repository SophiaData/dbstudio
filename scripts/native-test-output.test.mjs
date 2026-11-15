import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { assertNativeTestsExecuted } from './native-test-output.mjs'

const names = ['postgresql_native_factory_lifecycle', 'mysql_native_factory_lifecycle']
const summary = (passed, ignored = 0) => `test result: ok. ${passed} passed; 0 failed; ${ignored} ignored; 0 measured; 0 filtered out; finished in 0.01s\n`
const lines = names.map((name) => `test ${name} ... ok\n`).join('')

test('requires both named database lifecycles and a two-test summary', () => {
  assertNativeTestsExecuted(`running 2 tests\n${lines}${summary(2)}`, names)
  assertNativeTestsExecuted(`${lines}${summary(2)}`.replaceAll('\n', '\r\n'), names)
})
test('rejects successful Cargo runs with zero or missing tests', () => {
  assert.throws(() => assertNativeTestsExecuted(summary(0), names))
  assert.throws(() => assertNativeTestsExecuted(`test ${names[0]} ... ok\n${summary(1)}`, names))
})
test('rejects ignored tests, duplicate names, unrelated tests and inconsistent summaries', () => {
  for (const output of [
    `${lines}${summary(2, 1)}`,
    `test ${names[0]} ... ok\ntest ${names[0]} ... ok\n${summary(2)}`,
    `${lines}test unrelated ... ok\n${summary(3)}`,
    `${lines}${summary(0)}`,
    `${lines}${summary(2)}${summary(2)}`,
    lines,
  ]) assert.throws(() => assertNativeTestsExecuted(output, names))
})
test('the live fixture gates its passing state on captured test output', () => {
  const source = readFileSync(new URL('./native-database-fixture.mjs', import.meta.url), 'utf8')
  assert.match(source, /assertNativeTestsExecuted\(output,\s*\[/)
  assert.ok(source.indexOf('assertNativeTestsExecuted(output,') < source.indexOf('passed = true'))
  assert.match(source, /child\.stdout\.on\('data'/)
})
