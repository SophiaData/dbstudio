// Dedicated synthetic credentials/certificates for REAL native Redis/Kafka TLS acceptance.
// Node only orchestrates fixtures; the application/backend remains native Rust.
// Usage: node scripts/native-secure-fixture.mjs [--prepare-only]
// --prepare-only creates private fixture material, without invoking Docker or Cargo.
// Every run retains private files and its stopped containers. Never reuse real user data.
// Version-specific sources reviewed for these commands:
// https://raw.githubusercontent.com/apache/kafka/3.9.0/core/src/main/scala/kafka/tools/StorageTool.scala
//   argparse4j fromFilePrefix '@' keeps --add-scram credentials out of process arguments.
// https://raw.githubusercontent.com/apache/kafka/3.9.0/docker/jvm/Dockerfile
// https://raw.githubusercontent.com/docker-library/redis/master/7.4/alpine/Dockerfile
// https://redis.io/docs/latest/operate/oss_and_stack/management/security/encryption/
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import tls from 'node:tls'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LABEL = 'io.dbstudio.native-secure-fixture'
const IMAGES = Object.freeze({ redis: 'redis:7.4-alpine', kafka: 'apache/kafka:3.9.0' })
const TESTS = Object.freeze(['redis_native_tls_live_readonly', 'kafka_native_tls_sasl_live_readonly'])
const HEALTH_LIMIT_MS = 180000
class FixtureFailure extends Error {
  constructor(code) { super(code); this.code = code }
}
const requireFixture = (condition, code) => { if (!condition) throw new FixtureFailure(code) }
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

function command(program, args, { env, timeout = 30000, input, code = 'SUBPROCESS_FAILED' } = {}) {
  try {
    return execFileSync(program, args, { cwd: ROOT, env, input, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout, killSignal: 'SIGKILL' }).trim()
  } catch { throw new FixtureFailure(code) }
}
const docker = (args, options = {}) => command('docker', args, { ...options, code: options.code ?? 'DOCKER_OPERATION_FAILED' })
function privateFile(path, content) {
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' })
  const info = lstatSync(path)
  requireFixture(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600, 'PRIVATE_FILE_MODE_INVALID')
}
function privateDirectory(path) {
  mkdirSync(path, { mode: 0o700 })
  const info = lstatSync(path)
  requireFixture(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700, 'PRIVATE_DIRECTORY_MODE_INVALID')
}
function ensureBackups() {
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

// Export pure renderers for static checks. All interpolated credentials are locally generated hex.
export function kafkaProperties({ port, password, storePassword }) {
  requireFixture(Number.isInteger(port) && port >= 1 && port <= 65535, 'PUBLISHED_PORT_INVALID')
  requireFixture(/^[a-f0-9]{64}$/.test(password) && /^[a-f0-9]{64}$/.test(storePassword), 'GENERATED_CREDENTIAL_INVALID')
  return `process.roles=broker,controller
node.id=1
controller.quorum.voters=1@127.0.0.1:19093
controller.listener.names=CONTROLLER
listeners=EXTERNAL://0.0.0.0:9093,INTERNAL://127.0.0.1:19092,CONTROLLER://127.0.0.1:19093
advertised.listeners=EXTERNAL://127.0.0.1:${port},INTERNAL://127.0.0.1:19092
listener.security.protocol.map=EXTERNAL:SASL_SSL,INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT
inter.broker.listener.name=INTERNAL
sasl.enabled.mechanisms=PLAIN,SCRAM-SHA-256,SCRAM-SHA-512
listener.name.external.plain.sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required user_fixture="${password}";
listener.name.external.scram-sha-256.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required;
listener.name.external.scram-sha-512.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required;
ssl.keystore.type=PKCS12
ssl.keystore.location=/fixture/tls/kafka.p12
ssl.keystore.password=${storePassword}
ssl.key.password=${storePassword}
ssl.client.auth=none
ssl.enabled.protocols=TLSv1.2,TLSv1.3
log.dirs=/var/lib/kafka/data/native-fixture
metadata.log.dir=/var/lib/kafka/data/native-fixture
num.partitions=1
default.replication.factor=1
min.insync.replicas=1
offsets.topic.replication.factor=1
transaction.state.log.replication.factor=1
transaction.state.log.min.isr=1
group.initial.rebalance.delay.ms=0
auto.create.topics.enable=false
log.retention.hours=1
` // CA/leaf/keystore exist only in this invocation's dedicated directory.
}
export function storageArguments(clusterId, password) {
  requireFixture(/^[A-Za-z0-9_-]{22}$/.test(clusterId) && /^[a-f0-9]{64}$/.test(password), 'GENERATED_CREDENTIAL_INVALID')
  // argparse4j reads one argument per line; Java process argv contains ONLY @/fixture/storage.args.
  return `format
--cluster-id
${clusterId}
--config
/fixture/server.properties
--add-scram
SCRAM-SHA-256=[name=fixture,iterations=8192,password=${password}]
--add-scram
SCRAM-SHA-512=[name=fixture,iterations=8192,password=${password}]
`
}
export const KAFKA_START = `#!/bin/bash
set +x
set -euo pipefail
umask 077
exec >/dev/null 2>&1
# Parent writes the final advertised loopback port after docker assigns the mapping.
for attempt in {1..30}; do
  if [[ -s /fixture/config.ready ]]; then break; fi
  sleep 1
done
[[ -s /fixture/config.ready && -s /fixture/server.properties ]]
/opt/kafka/bin/kafka-storage.sh @/fixture/storage.args
exec /opt/kafka/bin/kafka-server-start.sh /fixture/server.properties
`
export const KAFKA_HEALTH = `#!/bin/bash
set +x
set -euo pipefail
exec >/dev/null 2>&1
/opt/kafka/bin/kafka-topics.sh --bootstrap-server 127.0.0.1:19092 --command-config /fixture/admin.properties --list
`
export const REDIS_HEALTH = `#!/bin/sh
set +x
set -eu
exec 2>/dev/null
reply="$(redis-cli --tls --cacert /fixture/tls/ca.crt --sni localhost -h 127.0.0.1 -p 6379 --no-auth-warning PING 2>/dev/null)"
[ "$reply" = PONG ]
`
function certificates(directory, storePassword) {
  const caConfig = join(directory, 'ca.cnf')
  const leafConfig = join(directory, 'leaf.cnf')
  privateFile(caConfig, `[req]
prompt=no
distinguished_name=dn
x509_extensions=ca
[dn]
CN=dbstudio-dedicated-native-test-CA
[ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
`)
  privateFile(leafConfig, `[req]
prompt=no
distinguished_name=dn
[dn]
CN=localhost
[leaf]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
`)
  const file = (name) => join(directory, name)
  const openssl = (args, env) => command('openssl', args, { env, code: 'CERTIFICATE_GENERATION_FAILED' })
  openssl(['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', caConfig,
    '-keyout', file('ca.key'), '-out', file('ca.crt')])
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-config', leafConfig, '-keyout', file('server.key'), '-out', file('server.csr')])
  openssl(['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'),
    '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-days', '2', '-extfile', leafConfig, '-extensions', 'leaf', '-out', file('server.crt')])
  openssl(['pkcs12', '-export', '-inkey', file('server.key'), '-in', file('server.crt'), '-certfile', file('ca.crt'),
    '-name', 'native-fixture', '-out', file('kafka.p12'), '-passout', 'env:DBSTUDIO_FIXTURE_KEYSTORE_PASSWORD'],
  { ...process.env, DBSTUDIO_FIXTURE_KEYSTORE_PASSWORD: storePassword })
  for (const name of ['ca.key', 'ca.crt', 'server.key', 'server.csr', 'server.crt', 'kafka.p12']) {
    const info = lstatSync(file(name))
    requireFixture(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600, 'PRIVATE_FILE_MODE_INVALID')
  }
  // Read public certificates only, never inspect private keys or the keystore.
  const ca = new X509Certificate(readFileSync(file('ca.crt')))
  const leaf = new X509Certificate(readFileSync(file('server.crt')))
  requireFixture(ca.ca && leaf.verify(ca.publicKey) && leaf.checkHost('localhost') === 'localhost' &&
    leaf.checkIP('127.0.0.1') === '127.0.0.1', 'CERTIFICATE_VALIDATION_FAILED')
  return file('ca.crt')
}
function currentContainer(fixture, runId) {
  const result = docker(['inspect', '--format', `{{.Id}} {{index .Config.Labels "${LABEL}"}}`, fixture.name], { timeout: 5000 })
  const [id, label] = result.split(' ')
  requireFixture(/^[a-f0-9]{64}$/.test(id) && label === runId, 'CONTAINER_OWNERSHIP_MISMATCH')
  if (fixture.id) requireFixture(id === fixture.id, 'CONTAINER_OWNERSHIP_MISMATCH')
  return id
}
function publishedPort(fixture) {
  const value = docker(['inspect', '--format', `{{(index (index .NetworkSettings.Ports "${fixture.port}/tcp") 0).HostPort}}`, fixture.id], { timeout: 5000 })
  requireFixture(/^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535, 'PUBLISHED_PORT_INVALID')
  return Number(value)
}
async function healthy(fixture) {
  const deadline = Date.now() + HEALTH_LIMIT_MS
  while (Date.now() < deadline) {
    const status = docker(['inspect', '--format', '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', fixture.id],
      { timeout: Math.max(1, Math.min(4000, deadline - Date.now())), code: 'HEALTH_INSPECTION_FAILED' })
    if (status === 'true healthy') return
    requireFixture(status.startsWith('true '), 'FIXTURE_EXITED')
    requireFixture(status !== 'true unhealthy', 'FIXTURE_UNHEALTHY')
    await pause(Math.min(1000, Math.max(1, deadline - Date.now())))
  }
  throw new FixtureFailure('HEALTH_TIMEOUT')
}
async function tlsHandshake(port, ca) {
  await new Promise((done, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca, rejectUnauthorized: true })
    const timer = setTimeout(() => { socket.destroy(); reject(new FixtureFailure('TLS_HEALTH_TIMEOUT')) }, 5000)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      const authorized = socket.authorized
      socket.destroy()
      authorized ? done() : reject(new FixtureFailure('TLS_HEALTH_FAILED'))
    })
    socket.once('error', () => { clearTimeout(timer); socket.destroy(); reject(new FixtureFailure('TLS_HEALTH_FAILED')) })
  })
}
function runNativeTest(name, env) {
  const output = command('cargo', ['test', '-p', 'dbstudio-drivers', '--test', 'nosql_native', name,
    '--', '--ignored', '--exact', '--test-threads=1'], { env, timeout: 180000, code: 'NATIVE_TLS_TEST_FAILED' })
  // Cargo succeeds with zero matches too. Require the exact test and an executed one-test summary.
  requireFixture(output.includes(`test ${name} ... ok`) && /test result: ok\. 1 passed; 0 failed; 0 ignored;/.test(output), 'NATIVE_TLS_TEST_NOT_EXECUTED')
}

export async function main(args = process.argv.slice(2)) {
  requireFixture(args.length === 0 || (args.length === 1 && args[0] === '--prepare-only'), 'ARGUMENTS_INVALID')
  const prepareOnly = args[0] === '--prepare-only'
  requireFixture(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS_BYPASS_FORBIDDEN')
  const oldMask = process.umask(0o077)
  const runId = randomUUID().replaceAll('-', '')
  const checks = []
  const fixtures = [
    { kind: 'redis', name: `dbstudio-native-tls-redis-${runId}`, image: IMAGES.redis, port: 6379, attempted: false, stopped: false },
    { kind: 'kafka', name: `dbstudio-native-tls-kafka-${runId}`, image: IMAGES.kafka, port: 9093, attempted: false, stopped: false }
  ]
  let evidence
  let failed = false
  const check = (name, code = 'OK', passed = true) => checks.push({ name, code, result: passed ? 'passed' : 'failed' })
  try {
    evidence = join(ensureBackups(), `native-secure-${runId}`)
    privateDirectory(evidence)
    const tlsDirectory = join(evidence, 'tls'); privateDirectory(tlsDirectory)
    const redisPassword = randomBytes(32).toString('hex')
    const kafkaPassword = randomBytes(32).toString('hex')
    const storePassword = randomBytes(32).toString('hex')
    const clusterId = randomBytes(16).toString('base64url')
    const topic = `native-secure-${runId}`
    const caFile = certificates(tlsDirectory, storePassword)
    check('private-certificates-and-credentials')
    privateFile(join(evidence, 'storage.args'), storageArguments(clusterId, kafkaPassword))
    privateFile(join(evidence, 'kafka-start.sh'), KAFKA_START)
    privateFile(join(evidence, 'kafka-health.sh'), KAFKA_HEALTH)
    privateFile(join(evidence, 'redis-health.sh'), REDIS_HEALTH)
    privateFile(join(evidence, 'admin.properties'), 'request.timeout.ms=3000\ndefault.api.timeout.ms=6000\nsocket.connection.setup.timeout.ms=3000\n')
    privateFile(join(evidence, 'quiet-log4j.properties'), 'log4j.rootLogger=OFF\n')
    privateFile(join(evidence, 'redis.env'), envText({ REDISCLI_AUTH: redisPassword }))
    privateFile(join(evidence, 'kafka.env'), envText({ KAFKA_HEAP_OPTS: '-Xms256m -Xmx512m',
      KAFKA_JMX_OPTS: '-Dcom.sun.management.jmxremote=false',
      KAFKA_LOG4J_OPTS: '-Dlog4j.configuration=file:/fixture/quiet-log4j.properties' }))
    privateFile(join(evidence, 'redis.conf'), `bind 0.0.0.0
protected-mode yes
port 0
tls-port 6379
tls-cert-file /fixture/tls/server.crt
tls-key-file /fixture/tls/server.key
tls-ca-cert-file /fixture/tls/ca.crt
tls-auth-clients no
tls-protocols "TLSv1.2 TLSv1.3"
requirepass ${redisPassword}
save ""
appendonly no
logfile /dev/null
`)
    if (prepareOnly) {
      // A reviewable private template, not a claimed reachable endpoint.
      privateFile(join(evidence, 'server.properties.template'), kafkaProperties({ port: 9093, password: kafkaPassword, storePassword }))
      check('prepare-only-no-docker-or-cargo')
    } else {
      docker(['info', '--format', '{{.ServerVersion}}'], { code: 'DOCKER_UNAVAILABLE' })
      for (const fixture of fixtures) {
        const redis = fixture.kind === 'redis'
        const common = ['run', '--detach', '--name', fixture.name, '--label', `${LABEL}=${runId}`,
          // Root reads the host-owned 0700/0600 fixture mount; keep Docker's normal DAC capability.
          '--user', '0:0', '--security-opt', 'no-new-privileges:true', '--log-driver', 'none',
          '--memory', redis ? '256m' : '1536m', '--publish', `127.0.0.1::${fixture.port}`,
          '--mount', `type=bind,src=${evidence},dst=/fixture,readonly`, '--env-file', join(evidence, `${fixture.kind}.env`),
          '--health-cmd', `${redis ? '/bin/sh' : '/bin/bash'} /fixture/${fixture.kind}-health.sh`,
          '--health-interval', '3s', '--health-timeout', '10s', '--health-start-period', '15s', '--health-retries', '40',
          '--entrypoint', redis ? 'redis-server' : '/bin/bash', fixture.image,
          redis ? '/fixture/redis.conf' : '/fixture/kafka-start.sh']
        fixture.attempted = true
        const id = docker(common, { timeout: 180000, code: 'FIXTURE_START_FAILED' })
        requireFixture(/^[a-f0-9]{64}$/.test(id), 'CONTAINER_ID_INVALID')
        fixture.id = id
        currentContainer(fixture, runId)
        fixture.hostPort = publishedPort(fixture)
        if (!redis) {
          privateFile(join(evidence, 'server.properties'), kafkaProperties({ port: fixture.hostPort, password: kafkaPassword, storePassword }))
          privateFile(join(evidence, 'config.ready'), 'ready\n')
        }
      }
      const healthResults = await Promise.allSettled(fixtures.map(healthy))
      const unhealthy = healthResults.find((result) => result.status === 'rejected')
      if (unhealthy) throw unhealthy.reason
      check('redis-and-kafka-healthy')
      const ca = readFileSync(caFile)
      for (const fixture of fixtures) await tlsHandshake(fixture.hostPort, ca)
      check('verified-tls-handshakes')
      const kafka = fixtures.find((fixture) => fixture.kind === 'kafka')
      currentContainer(kafka, runId)
      docker(['exec', kafka.id, '/opt/kafka/bin/kafka-topics.sh', '--bootstrap-server', '127.0.0.1:19092',
        '--command-config', '/fixture/admin.properties', '--create', '--topic', topic, '--partitions', '1', '--replication-factor', '1'],
      { timeout: 30000, code: 'FIXTURE_TOPIC_CREATE_FAILED' })
      check('dedicated-topic-created')
      const redis = fixtures.find((fixture) => fixture.kind === 'redis')
      const nativeEnv = { SSL_CERT_FILE: caFile,
        DBSTUDIO_REDIS_TLS_HOST: '127.0.0.1', DBSTUDIO_REDIS_TLS_PORT: String(redis.hostPort),
        DBSTUDIO_REDIS_TLS_USER: 'default', DBSTUDIO_REDIS_TLS_PASSWORD: redisPassword,
        DBSTUDIO_KAFKA_TLS_BROKERS: `127.0.0.1:${kafka.hostPort}`, DBSTUDIO_KAFKA_TLS_USER: 'fixture',
        DBSTUDIO_KAFKA_TLS_PASSWORD: kafkaPassword, DBSTUDIO_KAFKA_TLS_TOPIC: topic }
      privateFile(join(evidence, 'native-tests.env'), envText(nativeEnv))
      const env = { ...process.env, ...nativeEnv }
      // Scope fixture trust to these child processes. Never alter the global trust store.
      for (const test of TESTS) { runNativeTest(test, env); check(test) }
    }
  } catch (error) {
    failed = true
    check('fixture-run', error instanceof FixtureFailure ? error.code : 'FIXTURE_RUN_FAILED', false)
  } finally {
    for (const fixture of fixtures.filter((value) => value.attempted)) {
      try {
        const id = currentContainer(fixture, runId)
        docker(['stop', '--time', '15', id], { timeout: 30000, code: 'FIXTURE_STOP_FAILED' })
        fixture.stopped = true
        check(`${fixture.kind}-stopped-and-retained`)
      } catch {
        failed = true
        check(`${fixture.kind}-stopped-and-retained`, 'FIXTURE_STOP_FAILED', false)
      }
    }
    const report = { checks, fixtures: fixtures.map(({ name, image, stopped }) => ({ name, image, stopped })) }
    try { if (evidence) privateFile(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`) }
    catch { failed = true; check('private-report', 'REPORT_WRITE_FAILED', false) }
    process.umask(oldMask)
    // Never print child output, errors, container env/logs, request bodies or private file contents.
    console.log(JSON.stringify(report, null, 2))
  }
  return failed ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code }).catch(() => {
    console.error('Native secure fixture failed: CONFIGURATION_INVALID')
    process.exitCode = 1
  })
}
