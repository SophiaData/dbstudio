// Storage hard gates and current-run cache lifecycle for the compile-only acceptance builder.
// No external paths, environment overrides, process inspection, stale-lock breaking or old-cache cleanup.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, readSync, realpathSync, rmdirSync, statfsSync, unlinkSync, writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STORAGE_POLICY_VERSION = 1
export const MIN_AVAILABLE_BYTES = 21_474_836_480
export const MAX_CACHE_BYTES = 8_589_934_592
const CACHE_NAMES = Object.freeze(['build', 'deps', 'incremental'])
const LEASE_NAME = 'mysql-acceptance-storage.lease'
const RUN_PREFIX = 'mysql-acceptance-host-build-'
const RUN_PATTERN = /^mysql-acceptance-host-build-[a-f0-9]{32}$/
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/
const HEAVY_STAGE_ORDER = Object.freeze([
  'host-negative-and-contract-tests', 'sqlite-smoke-cfg-compile-only', 'debug-test-artifact'
])
const HEAVY_STAGES = new Set(HEAVY_STAGE_ORDER)
const HEX = /^[a-f0-9]{64}$/

class StorageError extends Error {
  constructor(code) { super(code); this.code = code }
}
function need(condition, code) { if (!condition) throw new StorageError(code) }
function codeOf(error, fallback = 'STORAGE_OPERATION_FAILED') {
  const code = error?.code ?? error?.message
  return typeof code === 'string' && /^STORAGE_[A-Z_]+$/.test(code) ? code : fallback
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function owned(info) { return typeof process.getuid !== 'function' || info.uid === process.getuid() }
function identity(info) { return { dev: info.dev, ino: info.ino } }
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino }
function absent(path) {
  try { lstatSync(path); return false } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw new StorageError('STORAGE_PATH_INVALID')
  }
}

export function storagePolicyBinding() {
  try {
    const path = fileURLToPath(import.meta.url)
    const info = lstatSync(path)
    need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && realpathSync(path) === path, 'STORAGE_POLICY_INVALID')
    return Object.freeze({
      policyVersion: STORAGE_POLICY_VERSION,
      sourceSha256: sha256(readFileSync(path)),
      minimumAvailableBytes: MIN_AVAILABLE_BYTES,
      maximumCacheBytes: MAX_CACHE_BYTES
    })
  } catch (error) { throw new StorageError(codeOf(error, 'STORAGE_POLICY_INVALID')) }
}

export function assertStorageHeadroom({ availableBytes, cacheAllocatedBytes }) {
  need(Number.isSafeInteger(availableBytes) && availableBytes >= 0 && Number.isSafeInteger(cacheAllocatedBytes) && cacheAllocatedBytes >= 0, 'STORAGE_MEASUREMENT_INVALID')
  need(availableBytes >= MIN_AVAILABLE_BYTES, 'STORAGE_SPACE_LOW')
  need(cacheAllocatedBytes < MAX_CACHE_BYTES, 'STORAGE_CACHE_BUDGET')
  return true
}

function baseDirectory(root) {
  need(typeof root === 'string' && root === resolve(root), 'STORAGE_ROOT_INVALID')
  const base = join(root, 'backups')
  const rootInfo = lstatSync(root), baseInfo = lstatSync(base)
  need(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && realpathSync(root) === root
    && baseInfo.isDirectory() && !baseInfo.isSymbolicLink() && realpathSync(base) === base, 'STORAGE_ROOT_INVALID')
  return base
}

function measureTree(path, seen) {
  let bytes = 0
  const info = lstatSync(path)
  need(!info.isSymbolicLink(), 'STORAGE_CACHE_INVALID')
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) bytes += measureTree(join(path, name), seen)
    return bytes
  }
  need(info.isFile(), 'STORAGE_CACHE_INVALID')
  const key = `${info.dev}:${info.ino}`
  if (seen.has(key)) return 0
  seen.add(key)
  const allocated = info.blocks * 512
  need(Number.isSafeInteger(allocated) && allocated >= 0, 'STORAGE_MEASUREMENT_INVALID')
  return allocated
}

function cachePaths(root, runId) {
  const run = join(root, 'backups', `${RUN_PREFIX}${runId}`)
  const debug = join(run, 'target', 'debug')
  return CACHE_NAMES.map(name => join(debug, name))
}

export function inspectStorage(root) {
  try {
    const base = baseDirectory(root)
    const stats = statfsSync(base)
    const availableBytes = Number(stats.bavail) * Number(stats.bsize)
    need(Number.isSafeInteger(availableBytes) && availableBytes >= 0, 'STORAGE_MEASUREMENT_INVALID')
    const seen = new Set()
    let cacheAllocatedBytes = 0
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!RUN_PATTERN.test(entry.name)) continue
      const runId = entry.name.slice(RUN_PREFIX.length)
      const run = join(base, entry.name)
      const info = lstatSync(run)
      need(info.isDirectory() && !info.isSymbolicLink(), 'STORAGE_CACHE_INVALID')
      for (const cache of cachePaths(root, runId)) {
        if (absent(cache)) continue
        need(realpathSync(cache) === cache, 'STORAGE_CACHE_INVALID')
        cacheAllocatedBytes += measureTree(cache, seen)
      }
    }
    return { availableBytes, cacheAllocatedBytes }
  } catch (error) { throw new StorageError(codeOf(error, 'STORAGE_MEASUREMENT_INVALID')) }
}

function leaseOwnerValid(lease) {
  const directory = lstatSync(lease.path)
  need(directory.isDirectory() && !directory.isSymbolicLink() && owned(directory)
    && sameIdentity(directory, lease.directory), 'STORAGE_LEASE_OWNER_MISMATCH')
  const info = lstatSync(lease.ownerPath)
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && owned(info)
    && sameIdentity(info, lease.owner), 'STORAGE_LEASE_OWNER_MISMATCH')
  const bytes = readFileSync(lease.ownerPath)
  need(bytes.length <= 200, 'STORAGE_LEASE_OWNER_MISMATCH')
  const owner = JSON.parse(bytes.toString('utf8'))
  need(owner && typeof owner === 'object' && !Array.isArray(owner)
    && Object.keys(owner).sort().join(',') === 'schemaVersion,token'
    && owner.schemaVersion === 1 && owner.token === lease.token, 'STORAGE_LEASE_OWNER_MISMATCH')
}

function releaseLease(lease) {
  if (lease.released) return true
  leaseOwnerValid(lease)
  unlinkSync(lease.ownerPath)
  rmdirSync(lease.path)
  lease.released = true
  return true
}

// Only a directory and owner file that this call provably created may be removed here.
// A foreign or replaced directory is left untouched.
function cleanupPartialLease(path, directory, ownerPath, owner) {
  try {
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink() || !sameIdentity(identity(info), directory)) return false
    if (owner) {
      try {
        const ownerInfo = lstatSync(ownerPath)
        if (ownerInfo.isFile() && !ownerInfo.isSymbolicLink() && sameIdentity(identity(ownerInfo), owner)) unlinkSync(ownerPath)
      } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
    rmdirSync(path)
    return true
  } catch { return false }
}

function acquireLease(root) {
  const path = join(baseDirectory(root), LEASE_NAME)
  const ownerPath = join(path, 'owner.json')
  const token = randomBytes(32).toString('hex')
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) {
    if (error?.code === 'EEXIST') throw new StorageError('STORAGE_LEASE_BUSY')
    throw new StorageError('STORAGE_LEASE_CREATE_FAILED')
  }
  const directory = identity(lstatSync(path))
  let lease = null
  let owner = null
  try {
    const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, token })}\n`)
    const fd = openSync(ownerPath, 'wx', 0o600)
    try {
      owner = identity(fstatSync(fd))
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      const info = fstatSync(fd)
      need(info.isFile() && info.nlink === 1 && owned(info), 'STORAGE_LEASE_CREATE_FAILED')
      lease = { path, ownerPath, token, directory, owner: identity(info), released: false }
    } finally { closeSync(fd) }
    leaseOwnerValid(lease)
    return lease
  } catch (error) {
    if (lease) { try { releaseLease(lease) } catch { /* Preserve an unverifiable lease. */ } }
    else { try { cleanupPartialLease(path, directory, ownerPath, owner) } catch { /* Preserve a foreign lease directory. */ } }
    throw new StorageError(codeOf(error, 'STORAGE_LEASE_CREATE_FAILED'))
  }
}

function assertPolicyCurrent(binding) {
  const current = storagePolicyBinding()
  need(JSON.stringify(current) === JSON.stringify(binding), 'STORAGE_POLICY_CHANGED')
}

function protectedSnapshot(run, binary) {
  const files = {}
  const inodes = new Set()
  const ancestors = new Set(['', 'target', 'target/debug'])
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (prefix === 'target/debug' && CACHE_NAMES.includes(name)) continue
      const info = lstatSync(path)
      need(!info.isSymbolicLink() && owned(info), 'STORAGE_PROTECTED_INVALID')
      inodes.add(`${info.dev}:${info.ino}`)
      if (info.isDirectory()) {
        if (!ancestors.has(rel)) files[`${rel}/`] = { ...identity(info), mode: info.mode & 0o777, nlink: info.nlink, mtimeMs: info.mtimeMs }
        visit(path, rel)
      } else {
        need(info.isFile(), 'STORAGE_PROTECTED_INVALID')
        files[rel] = {
          ...identity(info), mode: info.mode & 0o777, size: info.size,
          mtimeMs: info.mtimeMs, sha256: sha256(readFileSync(path))
        }
      }
    }
  }
  visit(run)
  const binaryName = basename(binary)
  need(files[`target/debug/${binaryName}`]?.sha256 && files['frontend/index.html']?.sha256
    && files['target/debug/.fingerprint/'], 'STORAGE_PROTECTED_INVALID')
  return { files, inodes, digest: sha256(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))) }
}

// Aggregate the three caches by device and inode. Every alias of one inode must live inside
// this closure, no protected file may share such an inode, and allocated bytes count once.
function collectCacheClosure(path, closure) {
  const info = lstatSync(path)
  need(!info.isSymbolicLink() && owned(info), 'STORAGE_CACHE_INVALID')
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) collectCacheClosure(join(path, name), closure)
    return
  }
  need(info.isFile(), 'STORAGE_CACHE_INVALID')
  const key = `${info.dev}:${info.ino}`
  const allocated = info.blocks * 512
  need(Number.isSafeInteger(allocated) && allocated >= 0, 'STORAGE_MEASUREMENT_INVALID')
  const entry = closure.get(key)
  if (!entry) {
    closure.set(key, { dev: info.dev, ino: info.ino, nlink: info.nlink, allocated, paths: [path] })
    return
  }
  need(entry.nlink === info.nlink, 'STORAGE_CACHE_INVALID')
  entry.paths.push(path)
}

function reviewCacheClosure(closure, protectedInodes) {
  let reclaimedBytes = 0
  for (const [key, entry] of closure) {
    need(!protectedInodes.has(key), 'STORAGE_CACHE_INVALID')
    need(entry.paths.length === entry.nlink, 'STORAGE_CACHE_INVALID')
    reclaimedBytes += entry.allocated
  }
  return reclaimedBytes
}

function validateRun(root, runId) {
  need(typeof runId === 'string' && RUN_ID_PATTERN.test(runId), 'STORAGE_RUN_INVALID')
  const run = join(baseDirectory(root), `${RUN_PREFIX}${runId}`)
  const info = lstatSync(run)
  need(info.isDirectory() && !info.isSymbolicLink() && owned(info) && (info.mode & 0o777) === 0o700
    && realpathSync(run) === run, 'STORAGE_RUN_INVALID')
  need(absent(join(run, 'build-report.json')), 'STORAGE_RECEIPT_ALREADY_PUBLISHED')
  return run
}

export function dependencyInspectionSupported(platform) { return platform === 'darwin' }

const MACHO_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca])

function machOHeader(binary) {
  let fd
  try { fd = openSync(binary, 'r') } catch { throw new StorageError('STORAGE_BINARY_DEPENDENCY_INVALID') }
  try {
    const header = Buffer.alloc(4)
    const read = readSync(fd, header, 0, 4, 0)
    need(read === 4, 'STORAGE_BINARY_DEPENDENCY_INVALID')
    return header
  } catch (error) { throw new StorageError(codeOf(error, 'STORAGE_BINARY_DEPENDENCY_INVALID')) }
  finally { closeSync(fd) }
}

// Only macOS is supported. Every other platform or unknown format fails closed and keeps the caches.
export function inspectBinaryDependencies(binary) {
  need(dependencyInspectionSupported(process.platform), 'STORAGE_BINARY_DEPENDENCY_UNSUPPORTED_PLATFORM')
  const header = machOHeader(binary)
  need(MACHO_MAGICS.has(header.readUInt32BE(0)), 'STORAGE_BINARY_DEPENDENCY_INVALID')
  const result = spawnSync('/usr/bin/otool', ['-L', binary], { encoding: 'utf8', maxBuffer: 1024 * 1024, env: {} })
  need(!result.error && result.status === 0, 'STORAGE_BINARY_DEPENDENCY_INVALID')
  const lines = (result.stdout ?? '').split('\n')
  const headerLine = (lines[0] ?? '').trim()
  need(headerLine.endsWith(':') && headerLine.includes(basename(binary)), 'STORAGE_BINARY_DEPENDENCY_INVALID')
  const dependencies = lines.slice(1)
    .filter(line => /^\s+\S/.test(line))
    .map(line => line.trim().replace(/\s+\([^)]*\)$/, '').replace(/\s+=>.*$/, '').replace(/^.*=>\s*/, ''))
    .filter(Boolean)
  need(dependencies.length <= 512, 'STORAGE_BINARY_DEPENDENCY_INVALID')
  return dependencies
}

function canonicalDependencyPath(dependency) {
  need(dependency.startsWith('/'), 'STORAGE_BINARY_DEPENDENCY_INVALID')
  const lexical = resolve(dependency)
  try {
    return realpathSync(lexical)
  } catch (error) {
    if (error?.code === 'ENOENT') return lexical
    throw new StorageError('STORAGE_BINARY_DEPENDENCY_INVALID')
  }
}

function assertDependenciesOutsideCaches(dependencies, caches) {
  need(Array.isArray(dependencies) && dependencies.length <= 512
    && dependencies.every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')), 'STORAGE_BINARY_DEPENDENCY_INVALID')
  for (const dependency of dependencies) {
    const canonical = canonicalDependencyPath(dependency)
    for (const cache of caches) {
      need(canonical !== cache && !canonical.startsWith(cache + sep), 'STORAGE_BINARY_DEPENDENCY_INVALID')
    }
  }
}

// Hash-bound inline helper: validate the complete closure, take a real non-blocking Cargo lock,
// then reopen every directory with dir_fd + O_NOFOLLOW for deletion. It never accepts a cache path.
const PYTHON_RECYCLER = String.raw`
import fcntl, json, os, re, stat, sys

CACHE_NAMES = ('build', 'deps', 'incremental')
CARGO_LOCKS = ('target/debug/.cargo-lock', 'target/debug/.cargo-build-lock', 'target/debug/.cargo-artifact-lock')

def invalid(code='STORAGE_CACHE_INVALID'):
    raise RuntimeError(code)

def open_dir(parent, name):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        os.close(fd)
        invalid()
    return fd

def release_locks(locks):
    for fd in locks:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(fd)

def acquire_cargo_locks(run_path):
    locks = []
    for relative in CARGO_LOCKS:
        path = os.path.join(run_path, relative)
        try:
            fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
        except FileNotFoundError:
            release_locks(locks)
            invalid('STORAGE_CARGO_LOCK_MISSING')
        except OSError:
            release_locks(locks)
            invalid('STORAGE_CARGO_LOCK_UNSAFE')
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            os.close(fd)
            release_locks(locks)
            invalid('STORAGE_CARGO_LOCK_UNSAFE')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            release_locks(locks)
            invalid('STORAGE_CACHE_OCCUPIED')
        locks.append(fd)
    return locks

def scan_tree(path, closure, directories):
    info = os.stat(path, follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode):
        if info.st_uid != os.getuid():
            invalid()
        directories.append((path, info.st_dev, info.st_ino))
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for name in sorted(os.listdir(fd)):
                scan_tree(os.path.join(path, name), closure, directories)
        finally:
            os.close(fd)
        return
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        invalid()
    key = (info.st_dev, info.st_ino)
    entry = closure.get(key)
    if entry is None:
        closure[key] = {'nlink': info.st_nlink, 'paths': [path]}
    else:
        if entry['nlink'] != info.st_nlink:
            invalid()
        entry['paths'].append(path)

def review_closure(closure, protected):
    for key, entry in closure.items():
        if key in protected:
            invalid()
        if len(entry['paths']) != entry['nlink']:
            invalid()

def remove_closure(closure):
    for key, entry in closure.items():
        paths = entry['paths']
        remaining = entry['nlink']
        for index, path in enumerate(paths):
            info = os.stat(path, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                invalid()
            if info.st_nlink != remaining:
                invalid()
            os.unlink(path)
            remaining -= 1
            if remaining > 0:
                follower = os.stat(paths[index + 1], follow_symlinks=False)
                if not stat.S_ISREG(follower.st_mode) or follower.st_nlink != remaining:
                    invalid()
        try:
            os.stat(paths[0], follow_symlinks=False)
            invalid()
        except FileNotFoundError:
            pass

def remove_directories(directories):
    for path, dev, ino in sorted(directories, key=lambda item: item[0].count('/'), reverse=True):
        info = os.stat(path, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino) != (dev, ino):
            invalid()
        if os.listdir(path):
            invalid()
        os.rmdir(path)

def main():
    if not re.fullmatch(r'[a-f0-9]{32}', sys.argv[2]):
        raise RuntimeError('STORAGE_RUN_INVALID')
    payload = json.loads(sys.stdin.read() or '{}')
    protected = set(tuple(item) for item in payload.get('protected', []))
    root = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        backups = open_dir(root, 'backups')
        try:
            run = open_dir(backups, 'mysql-acceptance-host-build-' + sys.argv[2])
            try:
                run_path = os.path.join(sys.argv[1], 'backups', 'mysql-acceptance-host-build-' + sys.argv[2])
                locks = acquire_cargo_locks(run_path)
                try:
                    closure = {}
                    directories = []
                    target = open_dir(run, 'target')
                    try:
                        debug = open_dir(target, 'debug')
                        try:
                            for name in CACHE_NAMES:
                                try:
                                    cache = open_dir(debug, name)
                                except FileNotFoundError:
                                    continue
                                try:
                                    scan_tree(os.path.join(run_path, 'target', 'debug', name), closure, directories)
                                finally:
                                    os.close(cache)
                        finally:
                            os.close(debug)
                    finally:
                        os.close(target)
                    review_closure(closure, protected)
                    remove_closure(closure)
                    remove_directories(directories)
                finally:
                    release_locks(locks)
            finally:
                os.close(run)
        finally:
            os.close(backups)
    finally:
        os.close(root)

try:
    main()
except RuntimeError as error:
    print(str(error) if re.fullmatch(r'STORAGE_[A-Z_]+', str(error)) else 'STORAGE_RECYCLE_FAILED')
    sys.exit(1)
except OSError:
    print('STORAGE_CACHE_OCCUPIED')
    sys.exit(1)
except Exception:
    print('STORAGE_RECYCLE_FAILED')
    sys.exit(1)
`

function pythonRecycle(root, runId, protectedInodes) {
  const payload = JSON.stringify({
    protected: [...protectedInodes].map(key => key.split(':').map(value => Number(value)))
  })
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', PYTHON_RECYCLER, root, runId], {
    encoding: 'utf8', maxBuffer: 64 * 1024, env: {}, input: payload
  })
  if (!result.error && result.status === 0) return true
  const printed = (result.stdout ?? '').trim()
  throw new StorageError(/^STORAGE_[A-Z_]+$/.test(printed) ? printed : 'STORAGE_RECYCLE_FAILED')
}

export function recycleSuccessfulRun({ root, runId }) {
  const run = validateRun(root, runId)
  const binary = join(run, 'target', 'debug', process.platform === 'win32' ? 'dbstudio-desktop.exe' : 'dbstudio-desktop')
  const caches = cachePaths(root, runId)
  const before = protectedSnapshot(run, binary)
  assertDependenciesOutsideCaches(inspectBinaryDependencies(binary), caches)
  const closure = new Map()
  for (const cache of caches) {
    need(!absent(cache) && realpathSync(cache) === cache, 'STORAGE_CACHE_INVALID')
    collectCacheClosure(cache, closure)
  }
  const reclaimedBytes = reviewCacheClosure(closure, before.inodes)
  pythonRecycle(root, runId, before.inodes)
  need(caches.every(absent), 'STORAGE_RECYCLE_FAILED')
  const after = protectedSnapshot(run, binary)
  need(before.digest === after.digest, 'STORAGE_PROTECTED_CHANGED')
  return {
    passed: true, runId, removedCaches: [...CACHE_NAMES].sort(), reclaimedBytes,
    protectedBeforeSha256: before.digest, protectedAfterSha256: after.digest
  }
}

function failedRecycle(runId, code) {
  return { passed: false, runId, removedCaches: [], reclaimedBytes: 0, protectedBeforeSha256: null, protectedAfterSha256: null, failureCode: code }
}

function heavyStageProofValid(checks) {
  return Array.isArray(checks) && checks.length === HEAVY_STAGE_ORDER.length
    && checks.every((check, index) => check && typeof check === 'object' && check.stage === HEAVY_STAGE_ORDER[index])
}

export function acquireBuildStorage({ root, inspect = inspectStorage }) {
  const initial = inspect(root)
  assertStorageHeadroom(initial)
  const binding = storagePolicyBinding()
  const lease = acquireLease(root)
  let leaseRecheck
  try {
    leaseRecheck = inspect(root)
    assertStorageHeadroom(leaseRecheck)
  } catch (error) {
    try { releaseLease(lease) } catch { /* Never break an unverifiable lease. */ }
    throw error
  }
  const heavyStageChecks = []
  let closedResult = null
  return {
    checkHeavyStage(stage) {
      need(!closedResult && HEAVY_STAGES.has(stage), 'STORAGE_STAGE_INVALID')
      assertPolicyCurrent(binding)
      const measurement = inspect(root)
      assertStorageHeadroom(measurement)
      heavyStageChecks.push({ stage, ...measurement })
      return measurement
    },
    close({ runId = null, passed = false }) {
      if (closedResult) return closedResult
      let recycle = null, failureCode = null, final = null
      if (passed) {
        try {
          assertPolicyCurrent(binding)
          need(heavyStageProofValid(heavyStageChecks), 'STORAGE_HEAVY_STAGE_PROOF_INVALID')
          recycle = recycleSuccessfulRun({ root, runId })
          assertPolicyCurrent(binding)
        } catch (error) {
          failureCode = codeOf(error, 'STORAGE_RECYCLE_FAILED')
          recycle = failedRecycle(runId, failureCode)
        }
      }
      try {
        final = inspect(root)
        assertStorageHeadroom(final)
      } catch (error) { if (!failureCode) failureCode = codeOf(error, 'STORAGE_MEASUREMENT_INVALID') }
      let leaseReleased = false
      try { leaseReleased = releaseLease(lease) } catch (error) { if (!failureCode) failureCode = codeOf(error, 'STORAGE_LEASE_OWNER_MISMATCH') }
      closedResult = {
        schemaVersion: 1, policyVersion: binding.policyVersion, sourceSha256: binding.sourceSha256,
        initial, leaseRecheck, heavyStageChecks, final,
        cacheLifecycle: recycle?.passed ? 'current-run-caches-recycled' : passed ? 'current-run-caches-retained' : 'failure-diagnostics-retained',
        recycle, closed: final !== null && leaseReleased, leaseReleased, failureCode
      }
      return closedResult
    }
  }
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
function measurementValuesValid(value) {
  return Number.isSafeInteger(value?.availableBytes) && value.availableBytes >= MIN_AVAILABLE_BYTES
    && Number.isSafeInteger(value?.cacheAllocatedBytes) && value.cacheAllocatedBytes >= 0 && value.cacheAllocatedBytes < MAX_CACHE_BYTES
}
function validMeasurement(value) {
  return exact(value, ['availableBytes', 'cacheAllocatedBytes']) && measurementValuesValid(value)
}

export function verifyStorageReceipt(receipt, runId, current = storagePolicyBinding()) {
  const policy = receipt?.storagePolicy
  need(exact(policy, ['policyVersion', 'sourceSha256', 'minimumAvailableBytes', 'maximumCacheBytes'])
    && JSON.stringify(policy) === JSON.stringify(current), 'STORAGE_POLICY_MISMATCH')
  const lifecycle = receipt?.storageLifecycle
  need(exact(lifecycle, ['schemaVersion', 'policyVersion', 'sourceSha256', 'initial', 'leaseRecheck', 'heavyStageChecks', 'final', 'cacheLifecycle', 'recycle', 'closed', 'leaseReleased', 'failureCode'])
    && lifecycle.schemaVersion === 1 && lifecycle.policyVersion === current.policyVersion
    && lifecycle.sourceSha256 === current.sourceSha256 && lifecycle.closed === true && lifecycle.leaseReleased === true
    && lifecycle.failureCode === null && lifecycle.cacheLifecycle === 'current-run-caches-recycled'
    && validMeasurement(lifecycle.initial) && validMeasurement(lifecycle.leaseRecheck) && validMeasurement(lifecycle.final)
    && Array.isArray(lifecycle.heavyStageChecks) && lifecycle.heavyStageChecks.length === HEAVY_STAGE_ORDER.length
    && lifecycle.heavyStageChecks.every((check, index) => exact(check, ['stage', 'availableBytes', 'cacheAllocatedBytes'])
      && check.stage === HEAVY_STAGE_ORDER[index] && measurementValuesValid(check)), 'STORAGE_RECYCLE_PROOF_INVALID')
  const proof = lifecycle.recycle
  need(exact(proof, ['passed', 'runId', 'removedCaches', 'reclaimedBytes', 'protectedBeforeSha256', 'protectedAfterSha256'])
    && proof.passed === true && proof.runId === runId && RUN_ID_PATTERN.test(runId)
    && Array.isArray(proof.removedCaches) && proof.removedCaches.join(',') === 'build,deps,incremental'
    && Number.isSafeInteger(proof.reclaimedBytes) && proof.reclaimedBytes >= 0
    && HEX.test(proof.protectedBeforeSha256) && proof.protectedBeforeSha256 === proof.protectedAfterSha256, 'STORAGE_RECYCLE_PROOF_INVALID')
  return true
}
