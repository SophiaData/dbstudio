import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

export class ReleaseError extends Error {
  constructor(code) { super(code); this.code = code }
}
const fail = (code = 'invalid-config') => { throw new ReleaseError(code) }
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
function keys(value, allowed) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail()
}
function absolute(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || value.includes('\n')) fail()
  return resolve(value)
}
export function requirePrivateFile(path, read = false) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > 1024 * 1024 || (process.platform !== 'win32' && (info.mode & 0o077))) fail('private-file-required')
    return read ? readFileSync(fd, 'utf8') : undefined
  } catch { fail('private-file-required') } finally { if (fd !== undefined) closeSync(fd) }
}
export function readPrivateJson(path) {
  try { return JSON.parse(requirePrivateFile(path, true)) } catch { fail('private-json-invalid') }
}
export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = statSync(path)
  if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077))) fail('private-directory-required')
}
export function writePrivateJson(path, value) {
  privateDirectory(dirname(path))
  // 每次run使用唯一目录和新文件；不覆盖既有state/receipt/report。
  let fd
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
  } catch { fail('evidence-write-failed') } finally { if (fd !== undefined) closeSync(fd) }
}
function version(value, previous = false) {
  keys(value, previous ? ['image', 'gitSha', 'imageDigest', 'evidenceFile'] : ['image', 'gitSha', 'imageDigest'])
  if (typeof value.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(value.image)) fail()
  if (typeof value.gitSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.gitSha)) fail()
  if (typeof value.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.imageDigest)) fail()
  return { ...value, ...(previous ? { evidenceFile: absolute(value.evidenceFile) } : {}) }
}
export function readReleaseConfig(path) {
  const value = readPrivateJson(absolute(path))
  keys(value, ['schemaVersion', 'environment', 'project', 'dockerContext', 'composeFile', 'envFile', 'candidate', 'previousVerified', 'verifierConfigFile', 'workDir'])
  if (value.schemaVersion !== 1 || !['local-container-staging', 'remote-staging'].includes(value.environment)) fail()
  if (typeof value.project !== 'string' || !/^dbstudio-staging[a-z0-9_-]{0,48}$/.test(value.project)) fail()
  if (typeof value.dockerContext !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value.dockerContext)) fail()
  const config = {
    ...value,
    composeFile: absolute(value.composeFile), envFile: absolute(value.envFile),
    verifierConfigFile: absolute(value.verifierConfigFile), workDir: absolute(value.workDir),
    candidate: version(value.candidate),
    previousVerified: value.previousVerified ? version(value.previousVerified, true) : undefined
  }
  if (config.previousVerified?.imageDigest === config.candidate.imageDigest) fail('rollback-image-must-differ')
  requirePrivateFile(config.envFile)
  requirePrivateFile(config.verifierConfigFile)
  return config
}
export function requirePreviousEvidence(config) {
  const previous = config.previousVerified
  if (!previous) fail('previous-verified-version-required')
  const evidence = readPrivateJson(previous.evidenceFile)
  if (evidence.schemaVersion !== 1 || evidence.execution !== 'real' || evidence.environmentPassed !== true || evidence.status !== 'passed' || evidence.environment !== config.environment || !Array.isArray(evidence.versions)) fail('previous-version-evidence-invalid')
  if (!evidence.versions.some((item) => item?.verified === true && item.imageDigest === previous.imageDigest && item.gitSha === previous.gitSha)) fail('previous-version-evidence-invalid')
}
