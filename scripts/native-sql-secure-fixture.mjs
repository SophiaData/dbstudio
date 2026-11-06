// REAL native PostgreSQL/MySQL TLS and pinned SSH acceptance. Node only orchestrates.
// Execute: node scripts/native-sql-secure-fixture.mjs [--prepare-only]
// --prepare-only generates private synthetic material, WITHOUT Docker/Cargo.
// Retain every file, image, container and private network; never remove user resources.
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LABEL = 'io.dbstudio.native-sql-secure-fixture'
export const TESTS = Object.freeze([
  'postgresql_native_verify_full_live', 'mysql_native_verify_full_live',
  'postgresql_native_ssh_verify_full_live', 'mysql_native_ssh_pinned_live'
])
const IMAGES = Object.freeze({ pg: 'postgres:17', mysql: 'mysql:8.0', sshBase: 'alpine:3.21' })
const HEALTH_LIMIT_MS = 180000
class FixtureFailure extends Error {
  constructor(code) { super(code); this.code = code }
}
const requireFixture = (condition, code) => { if (!condition) throw new FixtureFailure(code) }
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
function command(program, args, { env, input, timeout = 30000, code = 'SUBPROCESS_FAILED' } = {}) {
  try {
    return execFileSync(program, args, { cwd: ROOT, env, input, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout, killSignal: 'SIGKILL' }).trim()
  } catch { throw new FixtureFailure(code) }
}
const docker = (args, options = {}) => command('docker', args, { ...options, code: options.code ?? 'DOCKER_OPERATION_FAILED' })
function privateDirectory(path) {
  mkdirSync(path, { mode: 0o700 })
  const info = lstatSync(path)
  requireFixture(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700, 'PRIVATE_DIRECTORY_MODE_INVALID')
}
function privateFile(path, content) {
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' })
  checkFile(path)
}
function checkFile(path) {
  const info = lstatSync(path)
  requireFixture(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600, 'PRIVATE_FILE_MODE_INVALID')
}
function backups() {
  const path = join(ROOT, 'backups')
  try {
    const info = lstatSync(path)
    requireFixture(info.isDirectory() && !info.isSymbolicLink(), 'BACKUPS_DIRECTORY_UNSAFE')
  } catch (error) {
    if (error instanceof FixtureFailure) throw error
    requireFixture(error.code === 'ENOENT', 'BACKUPS_DIRECTORY_UNAVAILABLE')
    mkdirSync(path, { mode: 0o700 })
  }
  return path
}
const envText = (values) => Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('')
export const SSH_DOCKERFILE = `FROM ${IMAGES.sshBase}
RUN apk add --no-cache openssh-server shadow
ENTRYPOINT ["/bin/sh","/fixture/ssh-start.sh"]
`
export const PG_START = `#!/bin/sh
set +x
set -eu
umask 077
exec >/dev/null 2>&1
mkdir -p /run/dbstudio-tls
cp /fixture/tls/server.crt /run/dbstudio-tls/server.crt
cp /fixture/tls/server.key /run/dbstudio-tls/server.key
cp /fixture/tls/ca.crt /run/dbstudio-tls/ca.crt
cp /fixture/pg_hba.conf /run/dbstudio-tls/pg_hba.conf
chmod 600 /run/dbstudio-tls/*
chown -R postgres:postgres /run/dbstudio-tls
exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_min_protocol_version=TLSv1.2 -c ssl_cert_file=/run/dbstudio-tls/server.crt -c ssl_key_file=/run/dbstudio-tls/server.key -c ssl_ca_file=/run/dbstudio-tls/ca.crt -c hba_file=/run/dbstudio-tls/pg_hba.conf
`
export const PG_HEALTH = `#!/bin/sh
set +x
set -eu
exec 2>/dev/null
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER="$POSTGRES_USER" PGDATABASE="$POSTGRES_DB" PGPASSWORD="$POSTGRES_PASSWORD"
export PGSSLMODE=verify-full PGSSLROOTCERT=/fixture/tls/ca.crt PGCONNECT_TIMEOUT=3
answer="$(psql --no-password --tuples-only --no-align --command 'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()' 2>/dev/null)"
[ "$answer" = t ]
`
export function mysqlStart(tls) {
  return `#!/bin/sh
set +x
set -eu
umask 077
exec >/dev/null 2>&1
cp /fixture/mysql-observer-grant.sql /docker-entrypoint-initdb.d/10-native-fixture.sql
chmod 600 /docker-entrypoint-initdb.d/10-native-fixture.sql
chown mysql:mysql /docker-entrypoint-initdb.d/10-native-fixture.sql
${tls ? `mkdir -p /run/dbstudio-tls
cp /fixture/tls/server.crt /run/dbstudio-tls/server.crt
cp /fixture/tls/server.key /run/dbstudio-tls/server.key
cp /fixture/tls/ca.crt /run/dbstudio-tls/ca.crt
chmod 600 /run/dbstudio-tls/*
chown -R mysql:mysql /run/dbstudio-tls
` : ''}exec /usr/local/bin/docker-entrypoint.sh mysqld --default-authentication-plugin=mysql_native_password ${tls ? '--require-secure-transport=ON --ssl-ca=/run/dbstudio-tls/ca.crt --ssl-cert=/run/dbstudio-tls/server.crt --ssl-key=/run/dbstudio-tls/server.key' : '--require-secure-transport=OFF --skip-ssl'}
`
}
export function mysqlHealth(tls) {
  return `#!/bin/sh
set +x
set -eu
exec >/dev/null 2>&1
mysql --defaults-extra-file=/fixture/mysql-${tls ? 'tls' : 'ssh'}-client.cnf --connect-timeout=3 --batch --skip-column-names --execute 'SELECT 1'
`
}
export const SSH_START = `#!/bin/sh
set +x
set -eu
umask 077
exec >/dev/null 2>&1
mkdir -p /run/sshd
adduser -D -s /bin/sh "$SSH_FIXTURE_USER"
printf '%s:%s\\n' "$SSH_FIXTURE_USER" "$SSH_FIXTURE_PASSWORD" | chpasswd
cp /fixture/ssh/host_rsa /run/sshd/host_rsa
cp /fixture/sshd_config /run/sshd/sshd_config
chmod 600 /run/sshd/host_rsa /run/sshd/sshd_config
exec /usr/sbin/sshd -D -e -f /run/sshd/sshd_config
`
export const SSH_HEALTH = `#!/bin/sh
set +x
set -eu
exec >/dev/null 2>&1
/usr/sbin/sshd -t -f /run/sshd/sshd_config
read -r daemon_pid </run/sshd/sshd.pid
kill -0 "$daemon_pid"
`
function certificates(directory) {
  privateFile(join(directory, 'ca.cnf'), `[req]
prompt=no
distinguished_name=dn
x509_extensions=ca
[dn]
CN=dbstudio-native-sql-synthetic-CA
[ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
`)
  privateFile(join(directory, 'wrong-ca.cnf'), `[req]
prompt=no
distinguished_name=dn
x509_extensions=ca
[dn]
CN=dbstudio-native-sql-untrusted-CA
[ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
`)
  privateFile(join(directory, 'leaf.cnf'), `[req]
prompt=no
distinguished_name=dn
[dn]
CN=localhost
[leaf]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1,DNS:pg-tls,DNS:mysql-tls
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
`)
  const file = (name) => join(directory, name)
  const openssl = (args) => command('openssl', args, { code: 'CERTIFICATE_GENERATION_FAILED' })
  for (const prefix of ['ca', 'wrong-ca']) {
    openssl(['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-config', file(`${prefix}.cnf`), '-keyout', file(`${prefix}.key`), '-out', file(`${prefix}.crt`)])
  }
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-config', file('leaf.cnf'),
    '-keyout', file('server.key'), '-out', file('server.csr')])
  openssl(['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'),
    '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-days', '2', '-extfile', file('leaf.cnf'), '-extensions', 'leaf', '-out', file('server.crt')])
  for (const name of ['ca.key', 'ca.crt', 'wrong-ca.key', 'wrong-ca.crt', 'server.key', 'server.csr', 'server.crt']) checkFile(file(name))
  // Inspect freshly generated public certificates only; no private key is read or printed.
  const ca = new X509Certificate(readFileSync(file('ca.crt')))
  const wrong = new X509Certificate(readFileSync(file('wrong-ca.crt')))
  const leaf = new X509Certificate(readFileSync(file('server.crt')))
  requireFixture(ca.ca && wrong.ca && leaf.verify(ca.publicKey) && !leaf.verify(wrong.publicKey), 'CERTIFICATE_CHAIN_INVALID')
  for (const host of ['pg-tls', 'mysql-tls']) requireFixture(leaf.checkHost(host) === host, 'CERTIFICATE_NAME_INVALID')
  for (const host of ['localhost', 'pg-wrong-name']) requireFixture(leaf.checkHost(host) === undefined, 'NEGATIVE_CERTIFICATE_NAME_MUST_NOT_MATCH')
  requireFixture(leaf.checkIP('127.0.0.1') === '127.0.0.1', 'CERTIFICATE_IP_INVALID')
  return file('ca.crt')
}
function hostIdentity(directory) {
  const key = join(directory, 'host_rsa')
  command('ssh-keygen', ['-q', '-t', 'rsa', '-b', '3072', '-N', '', '-C', 'dedicated-native-sql-fixture', '-f', key], { code: 'SSH_HOST_KEY_GENERATION_FAILED' })
  // ssh-keygen emits a public .pub as 0644; make all fixture material private.
  chmodSync(`${key}.pub`, 0o600)
  checkFile(key); checkFile(`${key}.pub`)
  const publicText = readFileSync(`${key}.pub`, 'utf8').trim().split(/\s+/)
  requireFixture(publicText[0] === 'ssh-rsa' && /^[A-Za-z0-9+/]+={0,2}$/.test(publicText[1] ?? ''), 'SSH_PUBLIC_KEY_INVALID')
  const blob = Buffer.from(publicText[1], 'base64')
  requireFixture(blob.length > 128, 'SSH_PUBLIC_KEY_INVALID')
  // Pin generated public material directly. Never ssh-keyscan/auto-trust a network response.
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}
function ownedContainer(fixture, runId) {
  const inspected = docker(['inspect', '--format', `{{.Id}} {{index .Config.Labels "${LABEL}"}}`, fixture.name], { timeout: 5000, code: 'CONTAINER_INSPECTION_FAILED' })
  const [id, label] = inspected.split(' ')
  requireFixture(/^[a-f0-9]{64}$/.test(id) && label === runId && (!fixture.id || id === fixture.id), 'CONTAINER_OWNERSHIP_MISMATCH')
  return id
}
function ownedNetwork(network, runId) {
  const inspected = docker(['network', 'inspect', '--format', `{{.Id}} {{index .Labels "${LABEL}"}} {{.Internal}}`, network.name], { timeout: 5000, code: 'NETWORK_INSPECTION_FAILED' })
  const [id, label, internal] = inspected.split(' ')
  requireFixture(/^[a-f0-9]{64}$/.test(id) && label === runId && internal === 'false' && (!network.id || id === network.id), 'NETWORK_OWNERSHIP_MISMATCH')
  return id
}
function publishedPort(fixture) {
  const inspected = docker(['inspect', '--format', `{{(index (index .NetworkSettings.Ports "${fixture.port}/tcp") 0).HostIp}} {{(index (index .NetworkSettings.Ports "${fixture.port}/tcp") 0).HostPort}}`, fixture.id], { timeout: 5000 })
  const [host, raw] = inspected.split(' ')
  requireFixture(host === '127.0.0.1' && /^\d+$/.test(raw) && Number(raw) > 0 && Number(raw) <= 65535, 'PUBLISHED_PORT_INVALID')
  return Number(raw)
}
async function healthy(fixture) {
  const deadline = Date.now() + HEALTH_LIMIT_MS
  while (Date.now() < deadline) {
    const status = docker(['inspect', '--format', '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', fixture.id],
      { timeout: Math.max(1, Math.min(4000, deadline - Date.now())), code: 'HEALTH_INSPECTION_FAILED' })
    if (status === 'true healthy') return
    requireFixture(status.startsWith('true ') && status !== 'true unhealthy', 'FIXTURE_UNHEALTHY')
    await pause(Math.min(1000, Math.max(1, deadline - Date.now())))
  }
  throw new FixtureFailure('HEALTH_TIMEOUT')
}
function nativeTest(name, env) {
  let output
  try {
    output = execFileSync('cargo', ['test', '-p', 'dbstudio-drivers', '--test', 'network_secure', name,
      '--', '--ignored', '--exact', '--test-threads=1'], { cwd: ROOT, env, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: 180000, killSignal: 'SIGKILL' })
  } catch (error) {
    // Retain only known source-defined stage names, never native error/log/data text.
    const allowed = new Set(['positive_connect', 'transport_attestation', 'transaction', 'wrong_ca',
      'system_roots', 'hostname_reachability', 'hostname_rejection', 'cancellation', 'missing_pin', 'wrong_pin'])
    const stages = [...String(error.stdout ?? '').matchAll(/NATIVE_SECURE_STAGE=([a-z_]+)/g)]
      .map((match) => match[1]).filter((stage) => allowed.has(stage))
    throw new FixtureFailure(`NATIVE_SECURE_TEST_FAILED${stages.length ? `_${stages.at(-1).toUpperCase()}` : ''}`)
  }
  requireFixture(output.includes(`test ${name} ... ok`) && /test result: ok\. 1 passed; 0 failed; 0 ignored;/.test(output), 'NATIVE_SECURE_TEST_NOT_EXECUTED')
}

export async function main(args = process.argv.slice(2)) {
  requireFixture(args.length === 0 || (args.length === 1 && args[0] === '--prepare-only'), 'ARGUMENTS_INVALID')
  const prepareOnly = args[0] === '--prepare-only'
  requireFixture(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS_BYPASS_FORBIDDEN')
  const previousMask = process.umask(0o077)
  const runId = randomUUID().replaceAll('-', '')
  const database = `native_secure_${runId.slice(0, 16)}`
  const user = `fx_${runId.slice(0, 12)}`
  const sshUser = `sx_${runId.slice(0, 12)}`
  const password = randomBytes(32).toString('hex')
  const sshPassword = randomBytes(32).toString('hex')
  const network = { name: `dbstudio-native-sql-secure-${runId}`, attempted: false, retainedInactive: false }
  const sshImage = `dbstudio-native-sql-ssh:${runId}`
  const fixtures = [
    { kind: 'pg-tls', name: `dbstudio-native-sql-pg-${runId}`, image: IMAGES.pg, port: 5432, publish: true, attempted: false, stopped: false },
    { kind: 'mysql-tls', name: `dbstudio-native-sql-mysql-tls-${runId}`, image: IMAGES.mysql, port: 3306, publish: true, attempted: false, stopped: false },
    { kind: 'mysql-ssh', name: `dbstudio-native-sql-mysql-ssh-${runId}`, image: IMAGES.mysql, port: 3306, publish: false, attempted: false, stopped: false },
    { kind: 'ssh', name: `dbstudio-native-sql-ssh-${runId}`, image: sshImage, port: 22, publish: true, attempted: false, stopped: false }
  ]
  const checks = []
  let evidence
  let testsPassed = false
  let cleanupPassed = true
  let preparationPassed = false
  const check = (name, passed = true, code = 'OK') => checks.push({ name, result: passed ? 'passed' : 'failed', code })
  try {
    evidence = join(backups(), `native-sql-secure-${runId}`)
    privateDirectory(evidence)
    const tlsDirectory = join(evidence, 'tls'); privateDirectory(tlsDirectory)
    const sshDirectory = join(evidence, 'ssh'); privateDirectory(sshDirectory)
    const buildDirectory = join(evidence, 'ssh-image'); privateDirectory(buildDirectory)
    const caFile = certificates(tlsDirectory)
    const pin = hostIdentity(sshDirectory)
    privateFile(join(buildDirectory, 'Dockerfile'), SSH_DOCKERFILE)
    privateFile(join(evidence, 'pg-tls-start.sh'), PG_START)
    privateFile(join(evidence, 'pg-tls-health.sh'), PG_HEALTH)
    privateFile(join(evidence, 'mysql-tls-start.sh'), mysqlStart(true))
    privateFile(join(evidence, 'mysql-ssh-start.sh'), mysqlStart(false))
    privateFile(join(evidence, 'mysql-tls-health.sh'), mysqlHealth(true))
    privateFile(join(evidence, 'mysql-ssh-health.sh'), mysqlHealth(false))
    privateFile(join(evidence, 'ssh-start.sh'), SSH_START)
    privateFile(join(evidence, 'ssh-health.sh'), SSH_HEALTH)
    privateFile(join(evidence, 'pg_hba.conf'), `local all all trust\nhostssl all all 0.0.0.0/0 scram-sha-256\nhostssl all all ::/0 scram-sha-256\nhostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject\n`)
    privateFile(join(evidence, 'sshd_config'), `Port 22\nListenAddress 0.0.0.0\nHostKey /run/sshd/host_rsa\nPidFile /run/sshd/sshd.pid\nPasswordAuthentication yes\nKbdInteractiveAuthentication no\nPermitRootLogin no\nUsePAM no\nAllowUsers ${sshUser}\nAllowTcpForwarding local\nPermitOpen pg-tls:5432 pg-wrong-name:5432 mysql-ssh:3306\nGatewayPorts no\nPermitTunnel no\nX11Forwarding no\nAllowAgentForwarding no\nLogLevel QUIET\n`)
    privateFile(join(evidence, 'pg-tls.env'), envText({ POSTGRES_USER: user, POSTGRES_DB: database, POSTGRES_PASSWORD: password, PGDATA: '/var/lib/postgresql/data/pgdata' }))
    privateFile(join(evidence, 'mysql-observer-grant.sql'), `GRANT SELECT ON performance_schema.session_status TO '${user}'@'%';\n`)
    for (const kind of ['mysql-tls', 'mysql-ssh']) {
      privateFile(join(evidence, `${kind}.env`), envText({ MYSQL_USER: user, MYSQL_DATABASE: database, MYSQL_PASSWORD: password, MYSQL_ROOT_PASSWORD: randomBytes(32).toString('hex') }))
      privateFile(join(evidence, `${kind}-client.cnf`), `[client]\nuser=${user}\npassword=${password}\ndatabase=${database}\nhost=127.0.0.1\nport=3306\nprotocol=TCP\nssl-mode=${kind === 'mysql-tls' ? 'VERIFY_IDENTITY' : 'DISABLED'}\n${kind === 'mysql-tls' ? 'ssl-ca=/fixture/tls/ca.crt\n' : ''}`)
    }
    privateFile(join(evidence, 'ssh.env'), envText({ SSH_FIXTURE_USER: sshUser, SSH_FIXTURE_PASSWORD: sshPassword }))
    preparationPassed = true
    check('private-synthetic-ca-hostkey-and-credentials')
    if (prepareOnly) {
      check('prepare-only-no-docker-or-cargo')
    } else {
      docker(['info', '--format', '{{.ServerVersion}}'], { code: 'DOCKER_UNAVAILABLE' })
      // Build context contains only the public Dockerfile, never credentials or private keys.
      docker(['build', '--label', `${LABEL}=${runId}`, '--tag', sshImage, buildDirectory], { timeout: 180000, code: 'SSH_IMAGE_BUILD_FAILED' })
      network.attempted = true
      // An internal-only Docker bridge does not expose published loopback ports here.
      // This per-run bridge keeps aliases separate and all published bindings on 127.0.0.1.
      const networkId = docker(['network', 'create', '--driver', 'bridge', '--label', `${LABEL}=${runId}`, network.name], { code: 'NETWORK_CREATE_FAILED' })
      requireFixture(/^[a-f0-9]{64}$/.test(networkId), 'NETWORK_ID_INVALID')
      network.id = networkId; ownedNetwork(network, runId)
      for (const fixture of fixtures) {
        const start = fixture.kind === 'ssh' ? [] : ['--entrypoint', '/bin/sh']
        const mount = ['--mount', `type=bind,src=${evidence},dst=/fixture,readonly`]
        const publish = fixture.publish ? ['--publish', `127.0.0.1::${fixture.port}`] : []
        fixture.attempted = true
        const id = docker(['run', '--detach', '--name', fixture.name, '--label', `${LABEL}=${runId}`,
          '--network', network.id, '--network-alias', fixture.kind,
          ...(fixture.kind === 'pg-tls' ? ['--network-alias', 'pg-wrong-name'] : []),
          '--user', '0:0', '--security-opt', 'no-new-privileges:true', '--log-driver', 'none',
          '--memory', fixture.kind.startsWith('mysql') ? '1g' : '512m', ...publish, ...mount,
          '--env-file', join(evidence, `${fixture.kind}.env`),
          '--health-cmd', `/bin/sh /fixture/${fixture.kind === 'ssh' ? 'ssh' : fixture.kind}-health.sh`,
          '--health-interval', '3s', '--health-timeout', '8s', '--health-start-period', '20s', '--health-retries', '45',
          ...start, fixture.image, ...(fixture.kind === 'ssh' ? [] : [`/fixture/${fixture.kind}-start.sh`])],
        { timeout: 180000, code: 'FIXTURE_START_FAILED' })
        requireFixture(/^[a-f0-9]{64}$/.test(id), 'CONTAINER_ID_INVALID')
        fixture.id = id; ownedContainer(fixture, runId)
        if (fixture.publish) fixture.hostPort = publishedPort(fixture)
      }
      const health = await Promise.allSettled(fixtures.map(healthy))
      const failed = health.find((result) => result.status === 'rejected')
      if (failed) throw failed.reason
      check('dedicated-pg-mysql-and-pinned-ssh-healthy')
      const nativeEnv = {
        DBSTUDIO_NATIVE_SECURE_RUN_ID: runId, DBSTUDIO_NATIVE_SECURE_ENABLED: runId,
        DBSTUDIO_NATIVE_SECURE_DIR: evidence, DBSTUDIO_NATIVE_SECURE_USER: user,
        DBSTUDIO_NATIVE_SECURE_DATABASE: database, DBSTUDIO_NATIVE_SECURE_PASSWORD: password,
        DBSTUDIO_NATIVE_SECURE_SSH_USER: sshUser, DBSTUDIO_NATIVE_SECURE_SSH_PASSWORD: sshPassword,
        DBSTUDIO_NATIVE_SECURE_CA_FILE: caFile, DBSTUDIO_NATIVE_SECURE_WRONG_CA_FILE: join(tlsDirectory, 'wrong-ca.crt'),
        DBSTUDIO_NATIVE_SECURE_SSH_PIN: pin,
        DBSTUDIO_NATIVE_SECURE_PG_TLS_PORT: String(fixtures[0].hostPort),
        DBSTUDIO_NATIVE_SECURE_MYSQL_TLS_PORT: String(fixtures[1].hostPort),
        DBSTUDIO_NATIVE_SECURE_SSH_PORT: String(fixtures[3].hostPort)
      }
      privateFile(join(evidence, 'native-tests.env'), envText(nativeEnv))
      // Child trust/config is explicit, never add the synthetic CA to system roots.
      const env = { ...process.env, ...nativeEnv }
      let failures = 0
      for (const name of TESTS) {
        try { nativeTest(name, env); check(name) }
        catch (error) {
          failures++
          check(name, false, error instanceof FixtureFailure ? error.code : 'NATIVE_SECURE_TEST_FAILED')
        }
      }
      requireFixture(failures === 0, 'NATIVE_SECURE_TESTS_FAILED')
      testsPassed = true
    }
  } catch (error) {
    check('fixture-run', false, error instanceof FixtureFailure ? error.code : 'FIXTURE_RUN_FAILED')
  } finally {
    // A timed-out run may have created its container. Inspect every recorded attempt.
    for (const fixture of fixtures.filter((item) => item.attempted)) {
      try {
        const id = ownedContainer(fixture, runId)
        docker(['stop', '--time', '15', id], { timeout: 30000, code: 'FIXTURE_STOP_FAILED' })
        requireFixture(docker(['inspect', '--format', '{{.State.Running}}', id], { timeout: 5000 }) === 'false', 'FIXTURE_STILL_RUNNING')
        fixture.id = id; fixture.stopped = true
        check(`${fixture.kind}-stopped-and-retained`)
      } catch {
        cleanupPassed = false; check(`${fixture.kind}-stopped-and-retained`, false, 'FIXTURE_STOP_OR_OWNERSHIP_FAILED')
      }
    }
    if (network.attempted) {
      try {
        const id = ownedNetwork(network, runId)
        const attached = JSON.parse(docker(['network', 'inspect', '--format', '{{json .Containers}}', id], { timeout: 5000 })) ?? {}
        for (const containerId of Object.keys(attached)) {
          const fixture = fixtures.find((item) => item.id === containerId && item.stopped)
          requireFixture(fixture && ownedContainer(fixture, runId) === containerId, 'NETWORK_ENDPOINT_OWNERSHIP_MISMATCH')
          docker(['network', 'disconnect', id, containerId], { timeout: 10000, code: 'NETWORK_DEACTIVATION_FAILED' })
        }
        const endpoints = JSON.parse(docker(['network', 'inspect', '--format', '{{json .Containers}}', id], { timeout: 5000 })) ?? {}
        requireFixture(Object.keys(endpoints).length === 0, 'NETWORK_ENDPOINTS_REMAIN')
        network.retainedInactive = true
        check('private-network-inactive-and-retained')
      } catch { cleanupPassed = false; check('private-network-inactive-and-retained', false, 'NETWORK_CLEANUP_OR_OWNERSHIP_FAILED') }
    }
    const passed = !prepareOnly && testsPassed && cleanupPassed
    const report = { runId, mode: prepareOnly ? 'prepare-only' : 'live-native-secure', preparationPassed,
      testsPassed, cleanupPassed, passed,
      limitations: ['mysql-ssh-verify-full-explicitly-unsupported', 'mysql-ssh-test-is-ssh-only-not-tls'],
      checks, fixtures: fixtures.map(({ kind, name, image, id, stopped }) => ({ kind, name, image, id, stopped })),
      network: { name: network.name, id: network.id, retainedInactive: network.retainedInactive } }
    let reportPassed = true
    try { if (evidence) privateFile(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`) }
    catch {
      reportPassed = false
      report.passed = false
      check('private-report', false, 'REPORT_WRITE_FAILED')
    }
    process.umask(previousMask)
    // Deliberately print no child output, errors, env, host key, logs, certificates or credentials.
    console.log(JSON.stringify(report, null, 2))
    if (!reportPassed) console.error('Native SQL secure fixture: REPORT_WRITE_FAILED')
    return reportPassed && cleanupPassed && (prepareOnly ? preparationPassed : passed) ? 0 : 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code }).catch(() => {
    console.error('Native SQL secure fixture: CONFIGURATION_INVALID')
    process.exitCode = 1
  })
}
