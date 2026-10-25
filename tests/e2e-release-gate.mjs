import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { checkReleaseVersion } from '../scripts/check-release-version.mjs'
import { TARGETS, artifactNames, createManifest, aggregateRelease } from '../scripts/release-gate.mjs'
import { publishRelease } from '../scripts/publish-release.mjs'

const root = resolve(import.meta.dirname, '..')
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const identity = { sha: 'a'.repeat(40), version, runId: '123', runAttempt: '1' }
const env = { ...process.env, GITHUB_SHA: identity.sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${version}`, GITHUB_REF: `refs/tags/v${version}` }
let passed = 0
const test = async (name, run) => { await run(); console.log(`PASS ${name}`); passed++ }
const work = await mkdtemp(join(tmpdir(), 'dbstudio-release-gate-'))
async function fixture() {
  const dir = await mkdtemp(join(work, 'bundles-'))
  for (const target of TARGETS) {
    const source = await mkdtemp(join(work, 'source-'))
    for (const name of artifactNames(identity, target)) await writeFile(join(source, name), 'synthetic-package')
    const smokePath = join(source, 'smoke.json')
    await writeFile(smokePath, JSON.stringify({
      schemaVersion: 1, ...identity, platform: target.platform, arch: target.arch, status: 'passed',
      evidence: 'unpacked-executable', runtimeVersion: version, executableSha256: 'b'.repeat(64),
      checks: { packaged: true, renderer: true, preload: true, sqliteHost: true, query: true },
      installers: Object.fromEntries(target.extensions.map((ext) => [ext, { status: 'unverified', method: 'Native installer validation pending' }]))
    }))
    await createManifest({ releaseDir: source, bundleDir: join(dir, `release-${target.platform}-${target.arch}`),
      smokePath, identity, platform: target.platform, arch: target.arch })
  }
  return dir
}
try {
  await test('tag version exact match and mismatched tag exit status', async () => {
    assert.equal(checkReleaseVersion(version, env).publish, true)
    const result = spawnSync(process.execPath, ['scripts/check-release-version.mjs'], {
      cwd: root, env: { ...env, GITHUB_REF_NAME: 'v99.0.0' }, encoding: 'utf8'
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /exactly match/)
  })
  await test('manual branch and manual tag never publish', async () => {
    assert.equal(checkReleaseVersion(version, { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', GITHUB_REF: 'refs/heads/main' }).publish, false)
    assert.equal(checkReleaseVersion(version, { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }).publish, false)
  })
  await test('same-workflow complete four-target bundle succeeds', async () => {
    const gate = await aggregateRelease(await fixture(), identity)
    assert.equal(gate.manifests.length, 4)
    assert.equal(gate.assets.length, 6)
  })
  for (const [name, mutate] of [
    ['wrong commit', (m) => { m.sha = 'c'.repeat(40) }],
    ['wrong version', (m) => { m.version = '9.9.9' }],
    ['different workflow', (m) => { m.runId = '456' }],
    ['different attempt', (m) => { m.runAttempt = '2' }],
    ['missing architecture', (m) => { delete m.arch }],
    ['skipped build', (m) => { m.build = 'skipped' }],
    ['failed smoke', (m) => { m.smoke.status = 'failed' }],
    ['missing SQLite check', (m) => { delete m.smoke.checks.sqliteHost }],
    ['unpackaged application', (m) => { m.smoke.checks.packaged = false }],
    ['runtime version mismatch', (m) => { m.smoke.runtimeVersion = '9.9.9' }],
    ['missing required artifact', (m) => { m.files.pop() }],
    ['forged digest', (m) => { m.files[0].sha256 = '0'.repeat(64) }]
  ]) {
    await test(`reject ${name}`, async () => {
      const dir = await fixture()
      const path = join(dir, 'release-mac-arm64', 'manifest.json')
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      mutate(manifest)
      await writeFile(path, JSON.stringify(manifest))
      await assert.rejects(aggregateRelease(dir, identity))
    })
  }
  for (const mode of ['missing platform', 'missing file', 'empty file', 'tampered file']) {
    await test(`reject ${mode}`, async () => {
      const dir = await fixture()
      const folder = join(dir, 'release-win-x64')
      const file = join(folder, artifactNames(identity, TARGETS[2])[0])
      if (mode === 'missing platform') await rm(folder, { recursive: true })
      else if (mode === 'missing file') await rm(file)
      else await writeFile(file, mode === 'empty file' ? '' : 'changed-content')
      await assert.rejects(aggregateRelease(dir, identity))
    })
  }
  const gate = await aggregateRelease(await fixture(), identity)
  function githubFixture({ failUpload = false, missingAsset = false, publicRelease = false } = {}) {
    const events = [], assets = []
    const repos = {
      async getReleaseByTag() {
        if (publicRelease) return { data: { id: 1, draft: false } }
        throw Object.assign(new Error('not found'), { status: 404 })
      },
      async createRelease(options) { events.push(['create', options]); return { data: { id: 1, draft: options.draft } } },
      async deleteReleaseAsset() { throw new Error('No prior draft assets expected') },
      async uploadReleaseAsset(options) {
        if (failUpload && assets.length === 1) throw new Error('injected upload failure')
        const expected = gate.assets.find((a) => a.name === options.name)
        assets.push({ name: options.name, size: options.data.length, state: 'uploaded', digest: `sha256:${expected.sha256}` })
      },
      async listReleaseAssets() {},
      async updateRelease(options) { events.push(['update', options]) }
    }
    return { events, github: { rest: { repos }, paginate: async () => missingAsset ? assets.slice(1) : [...assets] } }
  }
  for (const [name, options] of [
    ['upload failure stays draft', { failUpload: true }],
    ['missing remote attachment stays draft', { missingAsset: true }],
    ['existing public release is untouched', { publicRelease: true }]
  ]) {
    await test(name, async () => {
      const f = githubFixture(options)
      await assert.rejects(publishRelease({ github: f.github, owner: 'fixture', repo: 'fixture', gate, env }))
      assert.ok(f.events.every(([event, args]) => event !== 'update' || args.draft !== false))
      if (options.publicRelease) assert.deepEqual(f.events, [])
      else assert.equal(f.events[0][1].draft, true)
    })
  }
  await test('publisher refuses manual workflow before any API call', async () => {
    const f = githubFixture({})
    await assert.rejects(publishRelease({ github: f.github, owner: 'fixture', repo: 'fixture', gate,
      env: { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' } }), /Manual/)
    assert.deepEqual(f.events, [])
  })
  await test('publisher exposes one complete draft only after all attachment checks', async () => {
    const f = githubFixture({})
    await publishRelease({ github: f.github, owner: 'fixture', repo: 'fixture', gate, env })
    assert.equal(f.events[0][1].draft, true)
    assert.deepEqual(f.events.map(([event]) => event), ['create', 'update'])
    assert.equal(f.events[1][1].draft, false)
  })
  await test('workflow graph confines publication to aggregate-success job', async () => {
    const workflow = await readFile(join(root, '.github/workflows/release.yml'), 'utf8')
    assert.match(workflow, /gate:\s*\n\s*needs: build/)
    assert.match(workflow, /publish:\s*\n\s*needs: gate/)
    assert.match(workflow, /if: needs\.gate\.outputs\.publish == 'true'/)
    assert.equal((workflow.match(/contents: write/g) ?? []).length, 1)
    assert.ok(!workflow.includes('--publish always') && !workflow.includes('action-gh-release'))
    assert.match(workflow, /smoke-packaged-app\.mjs/)
    for (const target of TARGETS) assert.ok(workflow.includes(`platform: ${target.platform}`))
  })
} finally { await rm(work, { recursive: true, force: true }) }
console.log(`Release gate: ${passed} tests passed (synthetic bundles/API; no remote release)`)
