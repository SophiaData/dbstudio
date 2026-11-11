import { chromium } from 'playwright-core'
import { runSqlEditorDom } from './cases.mjs'

const flags = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1]
  if (!['--url', '--evidence-dir', '--phase', '--executable'].includes(key) || !value || flags.has(key)) throw new Error('Use --url <loopback fixture URL> --evidence-dir <owned fresh run directory> [--phase <name>] [--executable <existing Chromium executable>]')
  flags.set(key, value)
}
if (!flags.has('--url') || !flags.has('--evidence-dir')) throw new Error('--url and --evidence-dir are required; the server is managed separately')
// No browser installation or search is attempted. The caller provides an existing
// executable if playwright-core has no default managed browser in its environment.
const browser = await chromium.launch({ headless: true, ...(flags.has('--executable') ? { executablePath: flags.get('--executable') } : {}) })
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const summary = await runSqlEditorDom(page, {
    url: flags.get('--url'), evidenceDirectory: flags.get('--evidence-dir'), phase: flags.get('--phase') ?? 'green'
  })
  console.log(JSON.stringify({ total: summary.total, passed: summary.passed, failed: summary.failed, phase: summary.phase, scope: summary.scope, case_ids: summary.cases.map((entry) => entry.id) }, null, 2))
  if (summary.failed || summary.page_errors.length) process.exitCode = 1
  await context.close()
} finally { await browser.close() }
// Server shutdown belongs to its managed owner; evidence is retained without cleanup.
