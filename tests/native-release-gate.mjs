import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { TARGETS, RELEASE_TARGETS, createCandidate, verifyCandidate, aggregateCandidates } from '../scripts/native-release-gate.mjs'

const identity = { sha: 'a'.repeat(40), version: '0.8.0', runId: '123', runAttempt: '1' }
const work = await mkdtemp(join(tmpdir(), 'dbstudio-native-release-'))
let passed = 0
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`) }
async function fixture(targets = RELEASE_TARGETS) {
  const root = await mkdtemp(join(work, 'candidate-'))
  for (const target of targets) {
    const source = await mkdtemp(join(work, 'source-'))
    for (const extension of TARGETS[target]) await writeFile(join(source, `dbstudio_${identity.version}_${target}${extension}`), `synthetic installer only: ${target}${extension}`)
    await createCandidate({ target, sourceDir: source, outputDir: join(root, target), identity })
  }
  return root
}
await test('macOS DMG and Windows EXE aggregate without a Linux candidate', async () => {
  const gate = await aggregateCandidates(await fixture(), identity)
  assert.deepEqual(gate.manifests.map((manifest) => manifest.target), ['mac-arm64', 'win-x64'])
  assert.deepEqual(gate.manifests.flatMap((manifest) => manifest.files.map((file) => file.name.split('.').at(-1))), ['dmg', 'exe'])
  assert.equal(gate.installerAcceptance, 'unverified')
})
await test('the actual aggregate CLI requires only the two configured release targets', async () => {
  const directory = await fixture()
  const result = spawnSync(process.execPath, ['scripts/native-release-gate.mjs', 'aggregate', directory], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, GITHUB_SHA: identity.sha, GITHUB_RUN_ID: identity.runId, GITHUB_RUN_ATTEMPT: identity.runAttempt }
  })
  assert.equal(result.status, 0, 'Two-target release CLI must succeed without Linux or MSI')
  const gate = JSON.parse(await readFile(join(directory, 'native-gate.json'), 'utf8'))
  assert.deepEqual(gate.manifests.map((manifest) => manifest.target), ['mac-arm64', 'win-x64'])
})
await test('tampered installer is rejected after transport', async () => {
  const root = await fixture(['mac-arm64'])
  const directory = join(root, 'mac-arm64')
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  await writeFile(join(directory, manifest.files[0].name), 'changed content')
  await assert.rejects(verifyCandidate(directory, 'mac-arm64', identity))
})
for (const [field, value] of [['sha', 'b'.repeat(40)], ['version', '9.9.9'], ['runId', '124'], ['runAttempt', '2']]) {
  await test(`a different ${field} cannot enter this workflow`, async () => {
    const root = await fixture(['mac-arm64'])
    await assert.rejects(verifyCandidate(join(root, 'mac-arm64'), 'mac-arm64', { ...identity, [field]: value }))
  })
}
await test('missing platform cannot aggregate', async () => {
  await assert.rejects(aggregateCandidates(await fixture(['mac-arm64']), identity))
  await assert.rejects(aggregateCandidates(await fixture(['win-x64']), identity))
})
await test('manifest path traversal is rejected', async () => {
  const root = await fixture(['mac-arm64'])
  const path = join(root, 'mac-arm64', 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.files[0].name = '../dbstudio_0.8.0.dmg'
  await writeFile(path, JSON.stringify(manifest))
  await assert.rejects(verifyCandidate(join(root, 'mac-arm64'), 'mac-arm64', identity))
})
await test('empty installers never produce a manifest', async () => {
  const source = await mkdtemp(join(work, 'empty-'))
  await writeFile(join(source, 'dbstudio_0.8.0.dmg'), '')
  await assert.rejects(createCandidate({ target: 'mac-arm64', sourceDir: source, outputDir: join(work, 'empty-result'), identity }))
})
if (process.platform !== 'win32') {
  await test('symbolic links in a bundle are refused before reading', async () => {
    const source = await mkdtemp(join(work, 'link-source-'))
    const ownTarget = join(work, 'synthetic-link-target')
    await writeFile(ownTarget, 'synthetic only')
    const link = join(source, 'dbstudio_0.8.0.dmg')
    assert.ok(link.startsWith(work) && ownTarget.startsWith(work))
    await symlink(ownTarget, link)
    await assert.rejects(createCandidate({ target: 'mac-arm64', sourceDir: source, outputDir: join(work, 'link-result'), identity }))
  })
}
await test('installer acceptance cannot be promoted by a manifest edit', async () => {
  const root = await fixture(['mac-arm64'])
  const path = join(root, 'mac-arm64', 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.installerAcceptance = 'verified'
  await writeFile(path, JSON.stringify(manifest))
  await assert.rejects(verifyCandidate(join(root, 'mac-arm64'), 'mac-arm64', identity))
})
for (const wrongVersion of ['10.8.0', '0.8.0-rc.1']) {
  await test(`installer version ${wrongVersion} is not accepted as 0.8.0`, async () => {
    const source = await mkdtemp(join(work, 'wrong-version-'))
    await writeFile(join(source, `dbstudio_${wrongVersion}_aarch64.dmg`), 'synthetic wrong version')
    await assert.rejects(createCandidate({ target: 'mac-arm64', sourceDir: source, outputDir: join(source, 'candidate'), identity }))
  })
}
if (process.platform !== 'win32') {
  await test('Tauri AppDir staging links do not enter the installer candidate', async () => {
    const source = await mkdtemp(join(work, 'tauri-layout-'))
    const appDir = join(source, 'appimage', 'dbstudio.AppDir')
    await mkdir(join(appDir, 'usr', 'share', 'applications'), { recursive: true })
    await mkdir(join(source, 'deb'))
    await writeFile(join(appDir, 'dbstudio.png'), 'synthetic icon')
    await writeFile(join(appDir, 'usr', 'share', 'applications', 'dbstudio.desktop'), 'synthetic desktop entry')
    assert.ok(appDir.startsWith(work))
    await symlink('dbstudio.png', join(appDir, '.DirIcon'))
    await symlink('usr/share/applications/dbstudio.desktop', join(appDir, 'dbstudio.desktop'))
    await writeFile(join(source, 'appimage', 'dbstudio_0.8.0_amd64.AppImage'), 'synthetic AppImage')
    await writeFile(join(source, 'deb', 'dbstudio_0.8.0_amd64.deb'), 'synthetic DEB')
    const output = join(work, 'tauri-layout-result')
    const manifest = await createCandidate({ target: 'linux-x64', sourceDir: source, outputDir: output, identity })
    assert.deepEqual(manifest.files.map((file) => file.name).sort(), ['dbstudio_0.8.0_amd64.AppImage', 'dbstudio_0.8.0_amd64.deb'])
    await verifyCandidate(output, 'linux-x64', identity)
  })
  await test('an AppImage installer symlink remains rejected', async () => {
    const source = await mkdtemp(join(work, 'tauri-installer-link-'))
    const target = join(work, 'synthetic-appimage-target')
    await mkdir(join(source, 'appimage'))
    await mkdir(join(source, 'deb'))
    await writeFile(target, 'synthetic target')
    await writeFile(join(source, 'deb', 'dbstudio_0.8.0_amd64.deb'), 'synthetic DEB')
    const link = join(source, 'appimage', 'dbstudio_0.8.0_amd64.AppImage')
    assert.ok(link.startsWith(work) && target.startsWith(work))
    await symlink(target, link)
    await assert.rejects(createCandidate({ target: 'linux-x64', sourceDir: source, outputDir: join(work, 'tauri-installer-link-result'), identity }))
  })
}
await test('Tauri DEB deep staging tree is not an installer search root', async () => {
  const source = await mkdtemp(join(work, 'tauri-deb-layout-'))
  const icons = join(source, 'deb', 'dbstudio_0.8.0_amd64', 'data', 'usr', 'share', 'icons', 'hicolor', '128x128', 'apps')
  await mkdir(icons, { recursive: true })
  await mkdir(join(source, 'appimage'))
  await writeFile(join(icons, 'dbstudio.png'), 'synthetic icon')
  await writeFile(join(source, 'deb', 'dbstudio_0.8.0_amd64.deb'), 'synthetic DEB')
  await writeFile(join(source, 'appimage', 'dbstudio_0.8.0_amd64.AppImage'), 'synthetic AppImage')
  const output = join(work, 'tauri-deb-layout-result')
  const manifest = await createCandidate({ target: 'linux-x64', sourceDir: source, outputDir: output, identity })
  assert.equal(manifest.files.length, 2)
  await verifyCandidate(output, 'linux-x64', identity)
})
await test('an installer buried inside a staging tree cannot substitute for the actual output', async () => {
  const source = await mkdtemp(join(work, 'tauri-staged-fake-'))
  const staged = join(source, 'deb', 'staging', 'data')
  await mkdir(staged, { recursive: true })
  await mkdir(join(source, 'appimage'))
  await writeFile(join(staged, 'dbstudio_0.8.0_amd64.deb'), 'synthetic buried fake')
  await writeFile(join(source, 'appimage', 'dbstudio_0.8.0_amd64.AppImage'), 'synthetic AppImage')
  await assert.rejects(createCandidate({ target: 'linux-x64', sourceDir: source, outputDir: join(work, 'tauri-staged-fake-result'), identity }))
})
console.log(`Native release gate: ${passed} passed; synthetic fixtures retained`)
