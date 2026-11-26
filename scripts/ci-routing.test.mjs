import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CHECKS, changedPaths, planChanges, planEvent, validatePlan } from './ci-plan.mjs'
import { evaluateGate } from './ci-gate.mjs'

const expected = (...selected) => ({ version: 1, ...Object.fromEntries(CHECKS.map(key => [key, selected.includes(key)])) })
const results = plan => ({ changes: { result: 'success', outputs: { plan: JSON.stringify(plan) } },
  ...Object.fromEntries(CHECKS.map(key => [key, { result: plan[key] ? 'success' : 'skipped' }])) })

test('documentation and CI routing changes need only the always-run checks', () => {
  assert.deepEqual(planChanges(['README.md', 'docs/development-plan.md', '.github/workflows/verify.yml',
    'scripts/ci-plan.mjs', 'scripts/ci-gate.mjs', 'scripts/ci-routing.test.mjs']), expected())
})

test('Vue, SQL models and component tests use Node and frontend checks', () => {
  for (const path of ['apps/desktop/src/components/SqlEditor.vue', 'apps/desktop/src/workbench.ts',
    'apps/desktop/src/style.css', 'apps/desktop/tests/editor-regressions.mjs', 'vitest.config.ts']) {
    assert.deepEqual(planChanges([path]), expected('node', 'frontend'), path)
  }
})

test('Rust, locks, platform bridges and unknown paths conservatively select everything', () => {
  for (const path of ['crates/drivers/src/mysql.rs', 'src-tauri/src/lib.rs', 'Cargo.lock', 'Cargo.toml',
    'pnpm-lock.yaml', 'package.json', 'apps/desktop/vite.config.ts', 'apps/desktop/src/clipboard.ts',
    'new-engine/query.ts', 'docs/generate.mjs', 'src/backend/client.ts', 'src/core/sql.ts']) {
    assert.deepEqual(planChanges([path]), expected(...CHECKS), path)
  }
})

test('native and Windows harnesses select only their respective native platform', () => {
  assert.deepEqual(planChanges(['.github/workflows/native-verify.yml']), expected('node', 'frontend', 'native'))
  for (const path of ['scripts/windows-mysql-acceptance.ps1', '.github/workflows/windows-mysql-acceptance.yml',
    'apps/desktop/src/windows-mysql-smoke.ts']) {
    assert.deepEqual(planChanges([path]), expected('node', 'frontend', 'windows'), path)
  }
})

test('installer-only changes keep the candidate workflow separate', () => {
  assert.deepEqual(planChanges(['scripts/windows-installed-candidate.ps1',
    '.github/workflows/windows-installed-candidate.yml']), expected('node'))
})

test('mixed changes take the union and cannot hide code behind documentation', () => {
  assert.deepEqual(planChanges(['docs/new.md', 'apps/desktop/src/App.vue', 'crates/core/src/lib.rs']), expected(...CHECKS))
  assert.deepEqual(planChanges(['scripts/verify.mjs']), expected('node'))
  assert.deepEqual(planChanges([]), expected())
  assert.deepEqual(planChanges(['README.md'], { full: true }), expected(...CHECKS))
})

test('invalid paths and malformed plan flags fail closed', () => {
  for (const paths of [null, [''], [null], ['../docs/a.md'], ['/docs/a.md'], ['docs//a.md'],
    ['docs\\a.md'], ['docs/a\n.md'], ['docs/./a.md']]) assert.throws(() => planChanges(paths))
  for (const plan of [null, [], {}, { ...expected(), version: 2 }, { ...expected(), node: 'false' },
    { ...expected(), extra: false }, expected('frontend'), expected('native'), expected('node', 'windows')]) {
    assert.throws(() => validatePlan(plan))
  }
})

test('manual, reusable default and initial pushes select the full suite', () => {
  for (const event of ['workflow_dispatch', 'workflow_call', 'unknown']) {
    assert.deepEqual(planEvent(event, {}), expected(...CHECKS))
  }
  assert.deepEqual(planEvent('push', { before: '0'.repeat(40) }), expected(...CHECKS))
  assert.deepEqual(planEvent('pull_request', {}, { full: true }), expected(...CHECKS))
  assert.throws(() => planEvent('pull_request', {}))
  assert.throws(() => planEvent('push', { before: '--help', after: 'a'.repeat(40) }))
})

test('every valid selection accepts success and only unselected skipped results', () => {
  for (const plan of [expected(), expected('node'), expected('node', 'frontend'),
    expected('node', 'frontend', 'windows'), expected('node', 'frontend', 'native'), expected(...CHECKS)]) {
    assert.ok(evaluateGate(results(plan)).every(row => row.ok))
    for (const key of CHECKS) {
      for (const result of ['failure', 'cancelled', 'timed_out', 'neutral', 'missing', undefined]) {
        const needs = results(plan)
        needs[key] = { result }
        assert.equal(evaluateGate(needs).find(row => row.check === key).ok, false)
      }
      const skipped = results(plan)
      skipped[key].result = 'skipped'
      assert.equal(evaluateGate(skipped).find(row => row.check === key).ok, !plan[key])
      const extraSuccess = results(plan)
      extraSuccess[key].result = 'success'
      assert.ok(evaluateGate(extraSuccess).every(row => row.ok))
    }
  }
})

test('failed planning, missing jobs and corrupt outputs cannot produce a green gate', () => {
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    const needs = results(expected())
    needs.changes.result = result
    assert.throws(() => evaluateGate(needs))
  }
  for (const plan of ['', 'not json', '{}', '{"version":1}', JSON.stringify({ ...expected(), node: 'true' })]) {
    const needs = results(expected())
    needs.changes.outputs.plan = plan
    assert.throws(() => evaluateGate(needs))
  }
  const needs = results(expected())
  delete needs.windows
  assert.equal(evaluateGate(needs).find(row => row.check === 'windows').ok, false)
})

test('real Git diff includes both rename paths, deletions and PR merge-base changes', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dbstudio-ci-routing-'))
  console.log(`Git fixture: ${cwd}`)
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'CI Fixture')
  git('config', 'user.email', 'ci-fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(cwd, 'docs'))
  mkdirSync(join(cwd, 'crates'))
  writeFileSync(join(cwd, 'crates', 'driver.rs'), 'driver source\n')
  writeFileSync(join(cwd, 'README.md'), 'baseline\n')
  git('add', '.')
  git('commit', '-m', 'baseline')
  const base = git('rev-parse', 'HEAD')
  git('switch', '-c', 'feature')
  const source = join(cwd, 'crates', 'driver.rs')
  const destination = join(cwd, 'docs', 'driver.md')
  assert.equal(realpathSync(source), join(realpathSync(cwd), 'crates', 'driver.rs'))
  assert.equal(realpathSync(join(cwd, 'docs')), join(realpathSync(cwd), 'docs'))
  assert.equal(lstatSync(source).isSymbolicLink(), false)
  assert.equal(lstatSync(source).nlink, 1)
  renameSync(source, destination)
  git('add', '-A')
  git('commit', '-m', 'rename implementation into documentation')
  const head = git('rev-parse', 'HEAD')
  const paths = changedPaths(base, head, { cwd })
  assert.deepEqual(paths.sort(), ['crates/driver.rs', 'docs/driver.md'])
  assert.deepEqual(planChanges(paths), expected(...CHECKS))
  assert.deepEqual(planEvent('push', { before: base, after: head }, { cwd }), expected(...CHECKS))
  git('switch', 'main')
  writeFileSync(join(cwd, 'unrelated-config'), 'base branch advanced\n')
  git('add', '.')
  git('commit', '-m', 'advance base')
  const newBase = git('rev-parse', 'HEAD')
  assert.deepEqual(changedPaths(newBase, head, { pullRequest: true, cwd }).sort(), paths.sort())
  assert.deepEqual(planEvent('pull_request', { pull_request: { base: { sha: newBase }, head: { sha: head } } }, { cwd }), expected(...CHECKS))
  assert.throws(() => changedPaths('f'.repeat(40), head, { cwd }))
})

test('gate CLI returns nonzero for required skipped and malformed results', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dbstudio-ci-gate-'))
  console.log(`Gate fixture: ${cwd}`)
  const summary = join(cwd, 'summary.md')
  const run = needs => spawnSync(process.execPath, ['scripts/ci-gate.mjs'], {
    encoding: 'utf8', env: { ...process.env, CI_NEEDS: needs, GITHUB_STEP_SUMMARY: summary }
  })
  const good = run(JSON.stringify(results(expected('node'))))
  assert.equal(good.status, 0, good.stderr)
  assert.match(readFileSync(summary, 'utf8'), /node \| true \| success \| true/)
  const skipped = results(expected('node'))
  skipped.node.result = 'skipped'
  assert.equal(run(JSON.stringify(skipped)).status, 1)
  assert.equal(run('{}').status, 1)
  assert.equal(run('not-json').status, 1)
})
