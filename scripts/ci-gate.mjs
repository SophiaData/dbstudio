import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { CHECKS, validatePlan } from './ci-plan.mjs'

export function evaluateGate(needs) {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) throw new Error('Missing CI job results')
  if (needs.changes?.result !== 'success') throw new Error('CI planning did not succeed')
  const plan = validatePlan(JSON.parse(needs.changes.outputs?.plan))
  return CHECKS.map(check => {
    const result = needs[check]?.result ?? 'missing'
    return { check, required: plan[check], result, ok: result === 'success' || (!plan[check] && result === 'skipped') }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const rows = evaluateGate(JSON.parse(process.env.CI_NEEDS))
    const report = '| Check | Required | Result | Accepted |\n| --- | --- | --- | --- |\n' +
      rows.map(row => `| ${row.check} | ${row.required} | ${row.result} | ${row.ok} |\n`).join('')
    console.log(report)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI gate\n\n${report}`)
    if (rows.some(row => !row.ok)) throw new Error('Required checks did not all succeed')
  } catch (error) {
    console.error(`CI gate failed: ${error.message}`)
    process.exitCode = 1
  }
}
