import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TARGETS = Object.freeze({ 'mac-arm64': ['.dmg'], 'win-x64': ['.msi', '.exe'], 'linux-x64': ['.deb', '.appimage'] })
export function validateIdentity(identity) {
  assert.match(identity.sha, /^[a-f0-9]{40}$/)
  assert.match(identity.runId, /^[1-9][0-9]*$/)
  assert.match(identity.runAttempt, /^[1-9][0-9]*$/)
  assert.match(identity.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
}
function matchesVersion(name, version) {
  // Tauri installer names delimit the complete version with underscores or the extension.
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|_)${escaped}(?=_|\\.(?:dmg|msi|exe|deb|appimage)$)`, 'i').test(name)
}
async function ordinary(path, directory = false) {
  const stat = await lstat(path)
  assert.ok(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'Expected an ordinary candidate file/directory')
  return stat
}
async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function installers(directory, extensions) {
  await ordinary(directory, true)
  const outputDirectories = new Set(extensions.map((extension) => ({ '.dmg': 'dmg', '.msi': 'msi', '.exe': 'nsis', '.deb': 'deb', '.appimage': 'appimage' })[extension]))
  const result = []
  async function readOutputs(folder, allowOutputDirectories) {
    await ordinary(folder, true)
    for (const item of await readdir(folder, { withFileTypes: true })) {
      assert.ok(!item.isSymbolicLink(), 'Candidate directory contains a symbolic link')
      const path = join(folder, item.name)
      if (item.isFile() && extensions.includes(extname(item.name).toLowerCase())) result.push(path)
      // Tauri keeps AppDir and DEB staging trees beside the final files. Never search
      // those trees: only files directly in bundle/ or its known output directories qualify.
      else if (allowOutputDirectories && item.isDirectory() && outputDirectories.has(item.name)) await readOutputs(path, false)
    }
  }
  await readOutputs(directory, true)
  return result
}
export async function createCandidate({ target, sourceDir, outputDir, identity }) {
  validateIdentity(identity)
  const extensions = TARGETS[target]
  assert.ok(extensions, 'Unknown native release target')
  const sources = await installers(resolve(sourceDir), extensions)
  for (const extension of extensions) assert.equal(sources.filter((path) => extname(path).toLowerCase() === extension).length, 1, 'Require exactly one installer of each target type')
  await mkdir(dirname(resolve(outputDir)), { recursive: true })
  await mkdir(outputDir) // Never overwrite an earlier candidate directory.
  const files = []
  for (const source of sources.sort()) {
    const name = basename(source)
    assert.match(name, /^[A-Za-z0-9._+()-]+$/)
    assert.ok(matchesVersion(name, identity.version), 'Installer filename must contain the exact declared version token')
    const stat = await ordinary(source)
    assert.ok(stat.size > 0, 'Empty installer')
    const destination = join(outputDir, name)
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    const hash = await digest(destination)
    assert.equal(hash, await digest(source), 'Installer changed while being copied')
    files.push({ name, size: stat.size, sha256: hash })
  }
  const manifest = { schemaVersion: 1, kind: 'tauri-native-candidate', target, ...identity, installerAcceptance: 'unverified', files }
  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  return manifest
}
export async function verifyCandidate(directory, target, identity) {
  validateIdentity(identity)
  const extensions = TARGETS[target]
  assert.ok(extensions, 'Unknown native release target')
  await ordinary(directory, true)
  const manifestPath = join(directory, 'manifest.json')
  const stat = await ordinary(manifestPath)
  assert.ok(stat.size < 65536, 'Candidate manifest is too large')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.kind, 'tauri-native-candidate')
  assert.equal(manifest.target, target)
  assert.equal(manifest.installerAcceptance, 'unverified')
  for (const key of ['sha', 'version', 'runId', 'runAttempt']) assert.equal(manifest[key], identity[key], `Candidate ${key} mismatch`)
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === extensions.length)
  assert.equal(new Set(manifest.files.map((file) => file.name)).size, manifest.files.length)
  for (const extension of extensions) assert.equal(manifest.files.filter((file) => extname(file.name).toLowerCase() === extension).length, 1)
  for (const file of manifest.files) {
    assert.match(file.name, /^[A-Za-z0-9._+()-]+$/)
    assert.ok(matchesVersion(file.name, identity.version))
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
    const path = join(directory, file.name)
    const stat = await ordinary(path)
    assert.ok(stat.size > 0 && stat.size === file.size, 'Candidate size mismatch')
    assert.equal(await digest(path), file.sha256, 'Candidate digest mismatch')
  }
  assert.deepEqual((await readdir(directory)).sort(), ['manifest.json', ...manifest.files.map((file) => file.name)].sort(), 'Unexpected files in native candidate')
  return manifest
}
export async function aggregateCandidates(directory, identity) {
  const manifests = []
  for (const target of Object.keys(TARGETS)) manifests.push(await verifyCandidate(join(directory, target), target, identity))
  return { schemaVersion: 1, kind: 'verified-native-candidates', ...identity, installerAcceptance: 'unverified', manifests }
}
async function currentIdentity() {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'))
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
  const cargo = await readFile('Cargo.toml', 'utf8')
  assert.equal(config.version, version, 'Tauri version mismatch')
  const workspace = cargo.split('[workspace.package]')[1]?.split(/^\[/m)[0]
  assert.equal(workspace?.match(/^version\s*=\s*"([^"]+)"/m)?.[1], version, 'Cargo workspace version mismatch')
  const identity = { version, sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT }
  validateIdentity(identity)
  return identity
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, ...args] = process.argv.slice(2)
    const identity = await currentIdentity()
    if (operation === 'manifest' && args.length === 3) {
      await createCandidate({ target: args[0], sourceDir: args[1], outputDir: args[2], identity })
    } else if (operation === 'aggregate' && args.length === 1) {
      const gate = await aggregateCandidates(args[0], identity)
      await writeFile(join(args[0], 'native-gate.json'), JSON.stringify(gate, null, 2) + '\n', { flag: 'wx' })
    } else throw new Error('Invalid native release gate arguments')
    console.log('Native candidate integrity gate passed; installer acceptance remains unverified')
  } catch {
    console.error('Native candidate integrity gate failed')
    process.exitCode = 1
  }
}
