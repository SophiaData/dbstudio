import assert from 'node:assert/strict'

// Cargo exits successfully when a filter matches zero tests. A live fixture gate
// requires both the expected named tests and the matching non-ignored summary.
export function assertNativeTestsExecuted(output, expectedNames) {
  assert.ok(expectedNames.length > 0 && new Set(expectedNames).size === expectedNames.length, 'Expected native tests must be unique and nonempty')
  const text = output.replace(/\u001b\[[0-9;]*m/g, '').replaceAll('\r\n', '\n')
  const executed = [...text.matchAll(/^test ([A-Za-z0-9_:]+) \.\.\. ok\s*$/gm)].map((match) => match[1])
  assert.deepEqual(executed.sort(), [...expectedNames].sort(), 'Expected native database tests were not all executed successfully')
  const summaries = [...text.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;[^\n]*$/gm)]
  assert.equal(summaries.length, 1, 'Require exactly one native integration test summary')
  assert.deepEqual(summaries[0].slice(1, 4).map(Number), [expectedNames.length, 0, 0], 'Native database tests must execute without ignored or failed cases')
}
