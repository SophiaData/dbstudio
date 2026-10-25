import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkReleaseVersion } from './check-release-version.mjs'

export const TARGETS = [
  { platform: 'mac', arch: 'arm64', extensions: ['dmg', 'zip'] },
  { platform: 'mac', arch: 'x64', extensions: ['dmg', 'zip'] },
  { platform: 'win', arch: 'x64', extensions: ['exe'] },
  { platform: 'linux', arch: 'x64', extensions: ['AppImage'] }
]
const identityKeys = ['sha', 'version', 'runId', 'runAttempt']
const smokeChecks = ['packaged', 'renderer', 'preload', 'sqliteHost', 'query']

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

export function releaseIdentity(env = process.env, version) {
  const identity = { sha: env.GITHUB_SHA, version, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT }
  requireValue(/^[0-9a-f]{40}$/.test(identity.sha ?? ''), 'Missing or invalid commit SHA')
  requireValue(/^[1-9]\d*$/.test(identity.runId ?? ''), 'Missing workflow run ID')
  requireValue(/^[1-9]\d*$/.test(identity.runAttempt ?? ''), 'Missing workflow run attempt')
  requireValue(typeof version === 'string' && version.length > 0, 'Missing version')
  return identity
}

export function targetFor(platform, arch) {
  const target = TARGETS.find((item) => item.platform === platform && item.arch === arch)
  requireValue(target, `Unexpected release target: ${platform}/${arch}`)
  return target
}

export function artifactNames(identity, target) {
  return target.extensions.map((ext) => `dbstudio-${identity.version}-${target.platform}-${target.arch}.${ext}`)
}

export async function fileDigest(path) {
  const stat = await lstat(path)
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, `Artifact must be a nonempty regular file: ${path}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { size: stat.size, sha256: hash.digest('hex') }
}

export function validateSmoke(smoke, identity, target) {
  requireValue(smoke?.schemaVersion === 1 && smoke.status === 'passed', 'Packaged smoke did not pass')
  for (const key of [...identityKeys, 'platform', 'arch']) {
    requireValue(smoke[key] === (key in target ? target[key] : identity[key]), `Smoke ${key} mismatch`)
  }
  requireValue(smoke.evidence === 'unpacked-executable', 'Unsupported smoke evidence level')
  requireValue(smokeChecks.every((key) => smoke.checks?.[key] === true), 'Incomplete packaged smoke checks')
  requireValue(smoke.runtimeVersion === identity.version, 'Packaged application version mismatch')
  requireValue(/^[0-9a-f]{64}$/.test(smoke.executableSha256 ?? ''), 'Missing packaged executable digest')
  // Installer validation is reported separately; unpacked launch never proves installation or signing.
  requireValue(target.extensions.every((ext) => smoke.installers?.[ext]?.status === 'unverified'
    && typeof smoke.installers[ext].method === 'string' && smoke.installers[ext].method.length > 0),
  'Missing installer evidence limitations')
}

export async function createManifest({ releaseDir, bundleDir, smokePath, identity, platform, arch }) {
  const target = targetFor(platform, arch)
  const smoke = JSON.parse(await readFile(smokePath, 'utf8'))
  validateSmoke(smoke, identity, target)
  const files = []
  // Read and validate everything before creating an uploadable manifest.
  for (const name of artifactNames(identity, target)) {
    files.push({ name, ...await fileDigest(join(releaseDir, name)) })
  }
  await mkdir(bundleDir, { recursive: true })
  requireValue((await readdir(bundleDir)).length === 0, 'Bundle directory must be empty')
  for (const { name } of files) await copyFile(join(releaseDir, name), join(bundleDir, name))
  const manifest = { schemaVersion: 1, ...identity, platform, arch, build: 'success', smoke, files }
  await writeFile(join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export async function aggregateRelease(root, identity) {
  const expectedDirs = TARGETS.map((target) => `release-${target.platform}-${target.arch}`)
  const entries = await readdir(root)
  requireValue(entries.filter((name) => name !== 'gate.json').sort().join() === [...expectedDirs].sort().join(),
    'Missing or unexpected platform/architecture bundle')
  const assets = []
  const manifests = []
  for (const target of TARGETS) {
    const dir = join(root, `release-${target.platform}-${target.arch}`)
    requireValue((await lstat(dir)).isDirectory() && !(await lstat(dir)).isSymbolicLink(), 'Invalid bundle directory')
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    requireValue(manifest.schemaVersion === 1 && manifest.build === 'success', 'Build missing, failed or skipped')
    for (const key of [...identityKeys, 'platform', 'arch']) {
      requireValue(manifest[key] === (key in target ? target[key] : identity[key]), `Manifest ${key} mismatch`)
    }
    validateSmoke(manifest.smoke, identity, target)
    const names = artifactNames(identity, target)
    requireValue(Array.isArray(manifest.files) && manifest.files.length === names.length, 'Missing required artifact')
    requireValue(manifest.files.map((file) => file.name).sort().join() === [...names].sort().join(), 'Unexpected artifact name/version')
    requireValue((await readdir(dir)).sort().join() === [...names, 'manifest.json'].sort().join(), 'Missing or unexpected artifact file')
    for (const file of manifest.files) {
      const path = join(dir, file.name)
      const actual = await fileDigest(path)
      requireValue(actual.size === file.size && actual.sha256 === file.sha256, `Artifact digest mismatch: ${file.name}`)
      assets.push({ ...file, path })
    }
    manifests.push(manifest)
  }
  return { schemaVersion: 1, ...identity, assets, manifests }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { version } = JSON.parse(await readFile('package.json', 'utf8'))
    checkReleaseVersion(version)
    const identity = releaseIdentity(process.env, version)
    const [command, ...args] = process.argv.slice(2)
    if (command === 'manifest' && args.length === 5) {
      const [platform, arch, releaseDir, smokePath, bundleDir] = args
      await createManifest({ releaseDir, bundleDir, smokePath, identity, platform, arch })
    } else if (command === 'aggregate' && args.length === 1) {
      const gate = await aggregateRelease(args[0], identity)
      await writeFile(join(args[0], 'gate.json'), `${JSON.stringify(gate, null, 2)}\n`)
      console.log(`Validated ${gate.manifests.length} targets and ${gate.assets.length} assets for ${identity.sha}`)
    } else {
      throw new Error('Usage: release-gate.mjs manifest PLATFORM ARCH RELEASE_DIR SMOKE_JSON BUNDLE_DIR | aggregate BUNDLES_DIR')
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
