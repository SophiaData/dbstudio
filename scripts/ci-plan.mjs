import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const CHECKS = ['node', 'frontend', 'native', 'windows']

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
      Object.keys(plan).sort().join(',') !== ['version', ...CHECKS].sort().join(',') ||
      plan.version !== 1 || CHECKS.some(key => typeof plan[key] !== 'boolean')) {
    throw new Error('Invalid CI plan: require version 1 and every boolean check')
  }
  if ((plan.frontend && !plan.node) || ((plan.native || plan.windows) && !plan.frontend)) {
    throw new Error('Invalid CI plan: missing prerequisite checks')
  }
  return plan
}

export function planChanges(paths, { full = false } = {}) {
  if (!Array.isArray(paths) || typeof full !== 'boolean') throw new Error('Invalid change input')
  const plan = { version: 1, node: false, frontend: false, native: false, windows: false }
  const select = (...checks) => checks.forEach(check => { plan[check] = true })
  if (full) select(...CHECKS)
  for (const path of paths) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') ||
        /[\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Invalid repository-relative path')
    }
    if (/^(README|CONTRIBUTING|CHANGELOG|AGENTS|CLAUDE)\.md$/.test(path) ||
        /^docs\/.*\.(md|txt|png|jpe?g|svg|webp)$/.test(path) ||
        path === '.github/pull_request_template.md' || path === 'LICENSE') continue
    // These files implement the always-run planner, workflow lint and result gate.
    if (['scripts/ci-plan.mjs', 'scripts/ci-gate.mjs', 'scripts/ci-routing.test.mjs',
      '.github/workflows/verify.yml'].includes(path)) continue
    if (path === '.github/workflows/native-verify.yml') {
      select('node', 'frontend', 'native')
    } else if (['.github/workflows/windows-installed-candidate.yml',
      'scripts/windows-installed-candidate.ps1'].includes(path)) {
      // Installer changes require the separate candidate acceptance before delivery.
      select('node')
    } else if (['.github/workflows/windows-mysql-acceptance.yml',
      'scripts/windows-mysql-acceptance.ps1'].includes(path) ||
      /^apps\/desktop\/src\/(windows-mysql-smoke|mysql-parity-dom|editor-performance-smoke)\.ts$/.test(path)) {
      select('node', 'frontend', 'windows')
    } else if (/^apps\/desktop\/src\/(backend|clipboard|dialogs|main|native-smoke|native-tool-smoke)\.ts$/.test(path)) {
      select(...CHECKS)
    } else if (/^apps\/desktop\/(src|tests)\//.test(path) || path === 'apps/desktop/index.html' ||
        ['tsconfig.json', 'vitest.config.ts'].includes(path)) {
      select('node', 'frontend')
    } else if (/^tests\/e2e-/.test(path) || /^scripts\/verify(?:-manifest)?\.mjs$/.test(path)) {
      select('node')
    } else {
      // Rust, dependency locks, build configuration and every unknown path fail closed.
      select(...CHECKS)
    }
  }
  return validatePlan(plan)
}

function requireSha(sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid source SHA')
  return sha
}

export function changedPaths(base, head, { pullRequest = false, cwd = process.cwd() } = {}) {
  requireSha(base)
  requireSha(head)
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const start = pullRequest ? requireSha(git(['merge-base', base, head]).trim()) : base
  // Disable rename detection so both the old and new paths participate in routing.
  const output = git(['diff', '--name-only', '--no-renames', '-z', start, head, '--'])
  return output.split('\0').filter(Boolean)
}

export function planEvent(eventName, event, { full = false, cwd = process.cwd() } = {}) {
  if (full || !['pull_request', 'push'].includes(eventName)) return planChanges([], { full: true })
  if (eventName === 'push' && event.before === '0'.repeat(40)) return planChanges([], { full: true })
  const paths = eventName === 'pull_request'
    ? changedPaths(event.pull_request?.base?.sha, event.pull_request?.head?.sha, { pullRequest: true, cwd })
    : changedPaths(event.before, event.after, { cwd })
  return planChanges(paths)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    const plan = planEvent(process.env.GITHUB_EVENT_NAME, event, { full: process.env.CI_FULL === 'true' })
    const json = JSON.stringify(plan)
    console.log(`CI plan: ${json}`)
    appendFileSync(process.env.GITHUB_OUTPUT, `plan=${json}\n` + CHECKS.map(key => `${key}=${plan[key]}\n`).join(''))
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Selected checks\n\n| Check | Required |\n| --- | --- |\n` +
      CHECKS.map(key => `| ${key} | ${plan[key]} |\n`).join('') +
      '\nCandidate installation is a separate workflow, not covered by this gate.\n')
  } catch (error) {
    console.error(`CI planning failed: ${error.message}`)
    process.exitCode = 1
  }
}
