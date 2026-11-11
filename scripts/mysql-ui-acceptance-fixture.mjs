// MySQL-only synthetic service for real native UI acceptance. No Docker build or old fixture imports.
// node scripts/mysql-ui-acceptance-fixture.mjs --prepare-only
// node scripts/mysql-ui-acceptance-fixture.mjs --start <prepared-manifest>
// node scripts/mysql-ui-acceptance-fixture.mjs --observe <ready-manifest>
// node scripts/mysql-ui-acceptance-fixture.mjs --status <ready-manifest>
// node scripts/mysql-ui-acceptance-fixture.mjs --stop <ready-manifest>
// Every file/container is retained. Service readiness never implies native/GUI acceptance.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LABEL = 'io.dbstudio.mysql-ui-acceptance'
const OWNER = 'dbstudio-mysql-parity-fixture-v1'
const IMAGE = 'mysql:8.0'
const MAX_MANIFEST = 64 * 1024
class FixtureFailure extends Error { constructor(code) { super(code); this.code = code } }
const need = (condition, code) => { if (!condition) throw new FixtureFailure(code) }
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
function command(program, args, { input, timeout = 30000, code = 'SUBPROCESS_FAILED' } = {}) {
  try {
    return execFileSync(program, args, { cwd: ROOT, input, encoding: 'utf8', timeout,
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' }).trim()
  } catch (error) {
    const diagnostic = `${error.stdout ?? ''}\n${error.stderr ?? ''}`
    if (/not permitted|operation denied|permission denied|sandbox|policy denial/i.test(diagnostic)) throw new FixtureFailure('DOCKER_OPERATION_DENIED')
    throw new FixtureFailure(code)
  }
}
const docker = (args, options = {}) => command('docker', args, { ...options, code: options.code ?? 'DOCKER_OPERATION_FAILED' })
function privateDirectory(path) {
  mkdirSync(path, { mode: 0o700 })
  const info = lstatSync(path)
  need(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700, 'PRIVATE_DIRECTORY_INVALID')
}
function safeFile(path) {
  const info = lstatSync(path)
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o777) === 0o600, 'PRIVATE_FILE_INVALID')
  return info
}
function privateFile(path, value) { writeFileSync(path, value, { mode: 0o600, flag: 'wx' }); safeFile(path) }
function jsonFile(path, value) {
  const data = `${JSON.stringify(value, null, 2)}\n`
  need(Buffer.byteLength(data) <= MAX_MANIFEST, 'MANIFEST_TOO_LARGE')
  privateFile(path, data)
}
function absent(path) {
  try { lstatSync(path); return false } catch (error) { need(error.code === 'ENOENT', 'PATH_INSPECTION_FAILED'); return true }
}
function ownedRoot(path, runId) {
  need(/^[a-f0-9]{32}$/.test(runId), 'RUN_ID_INVALID')
  const expected = join(ROOT, 'backups', `mysql-parity-fixture-${runId}`)
  need(path === expected && realpathSync(path) === expected, 'FIXTURE_ROOT_INVALID')
  const info = lstatSync(path)
  need(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700, 'FIXTURE_ROOT_INVALID')
}
function materialFile(manifest, path) {
  need(typeof path === 'string' && dirname(path) === manifest.fixtureRoot, 'MATERIAL_PATH_INVALID')
  safeFile(path)
  need(realpathSync(path) === path, 'MATERIAL_PATH_ALIAS_FORBIDDEN')
  return path
}
function loadManifest(path, ready) {
  need(typeof path === 'string' && resolve(path) === path, 'MANIFEST_PATH_INVALID')
  const directory = dirname(path)
  const run = basename(directory).match(/^mysql-parity-fixture-([a-f0-9]{32})$/)
  need(run && dirname(directory) === join(ROOT,'backups') && basename(path) === (ready ? 'manifest.ready.json' : 'manifest.prepared.json'), 'MANIFEST_PATH_OUTSIDE_FIXTURE')
  ownedRoot(directory, run[1])
  const info = safeFile(path); need(info.size <= MAX_MANIFEST, 'MANIFEST_TOO_LARGE')
  need(realpathSync(path) === path, 'MANIFEST_PATH_ALIAS_FORBIDDEN')
  let manifest
  try { manifest = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new FixtureFailure('MANIFEST_JSON_INVALID') }
  return validateManifest(manifest, path, ready)
}
function validateManifest(manifest, path, ready) {
  need(manifest?.schemaVersion === 1, 'MANIFEST_VERSION_INVALID')
  ownedRoot(manifest.fixtureRoot, manifest.runId)
  need(dirname(path) === manifest.fixtureRoot, 'MANIFEST_ROOT_MISMATCH')
  const temporary = realpathSync(tmpdir())
  need(manifest.hostRoot === join(temporary, `dbstudio-mysql-acceptance-${manifest.runId}`), 'HOST_ROOT_INVALID')
  need(manifest.owner?.label === LABEL && manifest.owner.value === manifest.runId && manifest.owner.kind === OWNER, 'MANIFEST_OWNER_INVALID')
  need(manifest.profile === 'mysql-8.0' && manifest.image.tag === IMAGE && manifest.host === '127.0.0.1', 'SERVICE_PROFILE_INVALID')
  need(manifest.database === `mysql_accept_${manifest.runId.slice(0, 16)}`, 'DATABASE_INVALID')
  for (const role of ['app', 'observer']) {
    need(manifest[role]?.user === `${role}_${manifest.runId.slice(0, 12)}`, 'FIXTURE_USER_INVALID')
    materialFile(manifest, manifest[role].secretFilePath)
    materialFile(manifest, manifest[role].clientConfigPath)
    materialFile(manifest, manifest[role].containerClientConfigPath)
    need(!Object.hasOwn(manifest[role], 'password'), 'INLINE_SECRET_FORBIDDEN')
  }
  need(manifest.observer.readOnly === true && manifest.observer.autocommit === true, 'OBSERVER_POLICY_INVALID')
  for (const item of manifest.materials) {
    need(/^[a-z0-9.-]+$/.test(item.name) && /^[a-f0-9]{64}$/.test(item.sha256), 'MATERIAL_DIGEST_INVALID')
    const file = materialFile(manifest, join(manifest.fixtureRoot, item.name))
    need(sha256(readFileSync(file)) === item.sha256, 'MATERIAL_CHANGED')
  }
  if (ready) {
    need(manifest.ready === true && manifest.state === 'running', 'SERVICE_NOT_READY')
    need(Number.isInteger(manifest.port) && manifest.port >= 1 && manifest.port <= 65535, 'PORT_INVALID')
    need(/^[a-f0-9]{64}$/.test(manifest.containerId), 'CONTAINER_ID_INVALID')
    need(/^8\.0\.\d+/.test(manifest.serverVersion), 'MYSQL_VERSION_MISMATCH')
  } else { need(manifest.ready === false && manifest.state === 'prepared' && manifest.port === 0, 'PREPARED_MANIFEST_REQUIRED') }
  return manifest
}
function clientConfig(user, password, database, port) {
  return `[client]\nuser=${user}\npassword=${password}\nhost=127.0.0.1\nport=${port}\ndatabase=${database}\nprotocol=TCP\nssl-mode=REQUIRED\ndefault-character-set=utf8mb4\n`
}
export function schemaSql(database) {
  need(/^mysql_accept_[a-f0-9]{16}$/.test(database), 'DATABASE_INVALID')
  return `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE \`${database}\`;
CREATE TABLE items_805 (
 id BIGINT NOT NULL PRIMARY KEY, body VARCHAR(128) NOT NULL, big_value BIGINT NOT NULL,
 nullable_text VARCHAR(64) NULL DEFAULT NULL, default_text VARCHAR(64) NOT NULL DEFAULT 'fixture-default',
 generated_text VARCHAR(160) GENERATED ALWAYS AS (CONCAT(body,'-computed')) STORED
) ENGINE=InnoDB;
CREATE TABLE precision_values (
 id INT NOT NULL PRIMARY KEY, unsigned_big BIGINT UNSIGNED NOT NULL, signed_big BIGINT NOT NULL,
 exact_decimal DECIMAL(65,30) NOT NULL, utf8_text VARCHAR(128) NOT NULL, nullable_text VARCHAR(64) NULL,
 empty_text VARCHAR(64) NOT NULL DEFAULT '', binary_data BLOB NOT NULL, long_text LONGTEXT NOT NULL,
 json_value JSON NOT NULL, date_value DATE NOT NULL, datetime_value DATETIME(6) NOT NULL,
 timestamp_value TIMESTAMP(6) NOT NULL, time_value TIME(6) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE composite_rows (tenant_id INT NOT NULL, part_id VARCHAR(32) NOT NULL, body VARCHAR(128) NOT NULL,
 PRIMARY KEY(tenant_id,part_id)) ENGINE=InnoDB;
CREATE TABLE import_empty (id BIGINT NOT NULL PRIMARY KEY,body TEXT NULL,exact_amount DECIMAL(20,6) NOT NULL DEFAULT 0) ENGINE=InnoDB;
`
}
export function seedSql(database) {
  need(/^mysql_accept_[a-f0-9]{16}$/.test(database), 'DATABASE_INVALID')
  const rows = Array.from({ length: 805 }, (_, i) => `(${i + 1},'样本-${String(i + 1).padStart(7, '0')}',9007199254740993,${i % 2 ? "''" : 'NULL'})`)
  return `SET NAMES utf8mb4;
SET SESSION time_zone='+00:00';
USE \`${database}\`;
INSERT INTO items_805(id,body,big_value,nullable_text) VALUES ${rows.join(',\n')};
INSERT INTO precision_values VALUES
(1,18446744073709551615,-9223372036854775808,12345678901234567890123456789012345.123456789012345678901234567890,
 '合成-你好-😀',NULL,'',UNHEX(REPEAT('00ff',1024)),REPEAT('长😀',800),
 JSON_OBJECT('message','你好😀','largeInteger',CAST('9007199254740993' AS DECIMAL(20,0))),
 '2024-02-29','2024-02-29 12:34:56.123456','2024-02-29 12:34:56.654321','-49:02:03.123456');
INSERT INTO composite_rows VALUES(1,'a','composite-a'),(1,'b','composite-b');
`
}
export const START_SCRIPT = `#!/bin/sh
set +x
set -eu
umask 077
exec >/dev/null 2>&1
cp /fixture/accounts.sql /docker-entrypoint-initdb.d/10-acceptance-accounts.sql
cp /fixture/schema.sql /docker-entrypoint-initdb.d/20-acceptance-schema.sql
cp /fixture/seed.sql /docker-entrypoint-initdb.d/30-acceptance-seed.sql
chmod 600 /docker-entrypoint-initdb.d/*acceptance*.sql
chown mysql:mysql /docker-entrypoint-initdb.d/*acceptance*.sql
exec /usr/local/bin/docker-entrypoint.sh mysqld --default-authentication-plugin=caching_sha2_password --require-secure-transport=ON --default-time-zone=+00:00
`
function prepare() {
  const parent = join(ROOT, 'backups')
  const parentInfo = lstatSync(parent)
  need(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), 'BACKUPS_ROOT_UNSAFE')
  const runId = randomUUID().replaceAll('-', '')
  const fixtureRoot = join(parent, `mysql-parity-fixture-${runId}`)
  const hostRoot = join(realpathSync(tmpdir()), `dbstudio-mysql-acceptance-${runId}`)
  need(absent(hostRoot), 'HOST_ROOT_ALREADY_EXISTS')
  privateDirectory(fixtureRoot)
  const database = `mysql_accept_${runId.slice(0, 16)}`
  const appUser = `app_${runId.slice(0, 12)}`
  const observerUser = `observer_${runId.slice(0, 12)}`
  const appPassword = randomBytes(32).toString('hex')
  const observerPassword = randomBytes(32).toString('hex')
  const rootPassword = randomBytes(32).toString('hex')
  privateFile(join(fixtureRoot, 'app.secret'), `${appPassword}\n`)
  privateFile(join(fixtureRoot, 'observer.secret'), `${observerPassword}\n`)
  privateFile(join(fixtureRoot, 'root.secret'), `${rootPassword}\n`)
  privateFile(join(fixtureRoot, 'app-client.cnf'), clientConfig(appUser, appPassword, database, 3306))
  privateFile(join(fixtureRoot, 'observer-client.cnf'), clientConfig(observerUser, observerPassword, database, 3306))
  privateFile(join(fixtureRoot, 'admin-client.cnf'), clientConfig('root', rootPassword, 'mysql', 3306))
  privateFile(join(fixtureRoot, 'container.env'), 'MYSQL_ROOT_PASSWORD_FILE=/fixture/root.secret\n')
  privateFile(join(fixtureRoot, 'accounts.sql'), `CREATE USER '${appUser}'@'%' IDENTIFIED WITH caching_sha2_password BY '${appPassword}';
CREATE USER '${observerUser}'@'%' IDENTIFIED WITH caching_sha2_password BY '${observerPassword}';
GRANT SELECT,INSERT,UPDATE,CREATE,ALTER,INDEX,CREATE VIEW,SHOW VIEW,TRIGGER,CREATE ROUTINE,ALTER ROUTINE,EXECUTE ON \`${database}\`.* TO '${appUser}'@'%';
GRANT SELECT,SHOW VIEW ON \`${database}\`.* TO '${observerUser}'@'%';
`)
  privateFile(join(fixtureRoot, 'schema.sql'), schemaSql(database))
  privateFile(join(fixtureRoot, 'seed.sql'), seedSql(database))
  privateFile(join(fixtureRoot, 'start.sh'), START_SCRIPT)
  const files = ['app.secret','observer.secret','root.secret','app-client.cnf','observer-client.cnf','admin-client.cnf','container.env','accounts.sql','schema.sql','seed.sql','start.sh']
  const materials = files.map((name) => ({ name, sha256: sha256(readFileSync(join(fixtureRoot, name))) }))
  const materialDigest = sha256(materials.map(({ name, sha256: hash }) => `${name}:${hash}`).join('\n'))
  const manifest = {
    schemaVersion: 1, runId, fixtureRoot, hostRoot, profile: 'mysql-8.0',
    owner: { label: LABEL, value: runId, kind: OWNER },
    image: { tag: IMAGE, id: null, digest: null },
    host: '127.0.0.1', port: 0, database, containerId: null,
    state: 'prepared', ready: false, guiPassed: false,
    suggestedOptions: { sslmode: 'require' },
    transportScope: 'TLS-encryption-only-peer-identity-not-verified',
    app: { user: appUser, secretFilePath: join(fixtureRoot,'app.secret'), clientConfigPath: join(fixtureRoot,'app-client.cnf'), containerClientConfigPath: join(fixtureRoot,'app-client.cnf') },
    observer: { user: observerUser, secretFilePath: join(fixtureRoot,'observer.secret'), clientConfigPath: join(fixtureRoot,'observer-client.cnf'), containerClientConfigPath: join(fixtureRoot,'observer-client.cnf'), readOnly: true, autocommit: true },
    tables: { paging: 'items_805', precision: 'precision_values', composite: 'composite_rows', import: 'import_empty' },
    expected: { pagingRows: 805, precisionRows: 1, compositeRows: 2, importRows: 0 },
    materials, materialDigest, dataDigest: sha256(schemaSql(database) + seedSql(database)),
    versionMatrix: [{ version:'8.0',state:'prepared' },{ version:'8.4',state:'not-tested' }]
  }
  const path = join(fixtureRoot, 'manifest.prepared.json')
  jsonFile(path, manifest); loadManifest(path, false)
  return { path, manifest, manifestSha256: sha256(readFileSync(path)) }
}
function inspectImage() {
  const version = docker(['version','--format','{{.Client.Version}} {{.Server.Version}}'], { timeout: 10000, code:'DOCKER_VERSION_UNAVAILABLE' }).split(/\s+/)
  need(version.length === 2 && version.every((field) => /^[0-9.]+$/.test(field)), 'DOCKER_VERSION_INVALID')
  let inspected
  try { inspected = docker(['image','inspect',IMAGE,'--format','{{.Id}} {{json .RepoDigests}}'], { timeout:10000,code:'MYSQL_IMAGE_NOT_LOCAL' }) }
  catch (error) {
    if (error.code !== 'MYSQL_IMAGE_NOT_LOCAL') throw error
    docker(['pull',IMAGE],{timeout:180000,code:'MYSQL_IMAGE_PULL_FAILED'})
    inspected = docker(['image','inspect',IMAGE,'--format','{{.Id}} {{json .RepoDigests}}'], {timeout:10000,code:'MYSQL_IMAGE_INSPECTION_FAILED'})
  }
  const split = inspected.indexOf(' ')
  const id = inspected.slice(0, split)
  let digests; try { digests = JSON.parse(inspected.slice(split + 1)) } catch { throw new FixtureFailure('IMAGE_DIGEST_INVALID') }
  const digest = Array.isArray(digests) ? digests.find((item) => /(?:^|\/)mysql@sha256:[a-f0-9]{64}$/.test(item)) : null
  need(/^sha256:[a-f0-9]{64}$/.test(id) && digest, 'IMAGE_DIGEST_INVALID')
  return { tag: IMAGE, id, digest, dockerVersion: { client:version[0],server:version[1] } }
}
function ownedContainer(manifest) {
  const target = manifest.containerId ?? `dbstudio-mysql-ui-${manifest.runId}`
  const result = docker(['inspect','--format',`{{.Id}} {{index .Config.Labels "${LABEL}"}} {{index .Config.Labels "io.dbstudio.fixture-owner"}} {{.Image}} {{.State.Running}}`,target], { timeout:10000,code:'CONTAINER_INSPECTION_FAILED' }).split(' ')
  const [id, runId, owner, image, running] = result
  need(/^[a-f0-9]{64}$/.test(id) && runId === manifest.runId && owner === OWNER && image === manifest.image.id && (!manifest.containerId || manifest.containerId === id), 'CONTAINER_OWNERSHIP_MISMATCH')
  return { id, running: running === 'true' }
}
function sql(manifest, role, statement) {
  const owned = ownedContainer(manifest)
  need(owned.running, 'CONTAINER_NOT_RUNNING')
  const config = role === 'admin' ? 'admin-client.cnf' : basename(manifest[role].containerClientConfigPath)
  // Fresh mysql process/connection per call. Observer uses autocommit and READ ONLY explicitly.
  const prefix = role === 'observer' ? 'SET SESSION autocommit=1; SET SESSION TRANSACTION READ ONLY; ' : ''
  return docker(['exec','--user','0:0',owned.id,'mysql',`--defaults-extra-file=/fixture/${config}`,
    '--connect-timeout=5','--batch','--raw','--skip-column-names','--execute',prefix + statement],
  { timeout:15000,code:role === 'observer' ? 'OBSERVER_QUERY_FAILED' : 'FIXTURE_QUERY_FAILED' })
}
function observe(manifest) {
  const rows = sql(manifest,'observer', 'SELECT (SELECT COUNT(*) FROM items_805),(SELECT COUNT(*) FROM precision_values),(SELECT COUNT(*) FROM composite_rows),(SELECT COUNT(*) FROM import_empty),@@session.autocommit,@@session.transaction_read_only').split('\t')
  need(rows.length === 6 && rows.every((value) => /^\d+$/.test(value)), 'OBSERVER_COUNTS_INVALID')
  const counts = { paging:Number(rows[0]),precision:Number(rows[1]),composite:Number(rows[2]),import:Number(rows[3]) }
  need(counts.paging === 805 && counts.precision === 1 && counts.composite === 2 && rows[4] === '1' && rows[5] === '1', 'OBSERVER_BASELINE_MISMATCH')
  const precision = sql(manifest,'observer', `SELECT CAST(unsigned_big AS CHAR)='18446744073709551615',CAST(signed_big AS CHAR)='-9223372036854775808',CAST(exact_decimal AS CHAR)='12345678901234567890123456789012345.123456789012345678901234567890',nullable_text IS NULL,empty_text='',OCTET_LENGTH(binary_data)=2048,CHAR_LENGTH(long_text)=1600,JSON_UNQUOTE(JSON_EXTRACT(json_value,'$.message'))='你好😀',DATE_FORMAT(datetime_value,'%f')='123456',DATE_FORMAT(timestamp_value,'%f')='654321',time_value=CAST('-49:02:03.123456' AS TIME(6)) FROM precision_values WHERE id=1`).split('\t')
  need(precision.length === 11 && precision.every((value) => value === '1'), 'PRECISION_BASELINE_MISMATCH')
  const paging = sql(manifest,'observer', `SELECT COUNT(*)=805,MIN(id)=1,MAX(id)=805,COUNT(DISTINCT id)=805,SUM(big_value=9007199254740993)=805,SUM(default_text='fixture-default')=805,SUM(generated_text=CONCAT(body,'-computed'))=805,SUM(nullable_text IS NULL)=403,SUM(nullable_text='')=402 FROM items_805`).split('\t')
  need(paging.length === 9 && paging.every((value) => value === '1'), 'PAGING_BASELINE_MISMATCH')
  return { counts, autocommit:true,readOnly:true,precisionChecks:precision.length,pagingChecks:paging.length,independentConnections:3,guiPassed:false }
}
function observeRollback(manifest) {
  const fields = sql(manifest,'observer', `SELECT COUNT(*),SUM(BINARY body=BINARY CONCAT('样本-',LPAD(id,7,'0'))),SUM(BINARY generated_text=BINARY CONCAT(body,'-computed')),(SELECT LOWER(SHA2(body,256)) FROM items_805 WHERE id=1),@@session.autocommit,@@session.transaction_read_only FROM items_805`).split('\t')
  need(fields.length === 6 && fields[0] === '805' && fields[1] === '805' && fields[2] === '805'
    && fields[3] === sha256('样本-0000001') && fields[4] === '1' && fields[5] === '1', 'ROLLBACK_BASELINE_MISMATCH')
  return {status:'ROLLBACK_BASELINE_VERIFIED',runId:manifest.runId,counts:{paging:805},baselineBodyRows:805,
    firstBodySha256:fields[3],autocommit:true,readOnly:true,guiPassed:false}
}
function liveStatus(manifest, manifestPath) {
  const owned = ownedContainer(manifest)
  need(owned.running, 'CONTAINER_NOT_RUNNING')
  const health = docker(['inspect','--format','{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',owned.id], {timeout:10000,code:'HEALTH_INSPECTION_FAILED'})
  need(health === 'true healthy', 'MYSQL_HEALTH_FAILED')
  const binding = docker(['inspect','--format','{{(index (index .NetworkSettings.Ports "3306/tcp") 0).HostIp}} {{(index (index .NetworkSettings.Ports "3306/tcp") 0).HostPort}}',owned.id], {timeout:10000,code:'PORT_INSPECTION_FAILED'}).split(' ')
  need(binding[0] === '127.0.0.1' && binding[1] === String(manifest.port), 'LOOPBACK_BINDING_MISMATCH')
  const version = sql(manifest,'observer','SELECT VERSION()')
  need(version === manifest.serverVersion && /^8\.0\.\d+(?:[-.a-zA-Z0-9]*)$/.test(version), 'MYSQL_VERSION_MISMATCH')
  return {status:'OWNED_SERVICE_LIVE',runId:manifest.runId,containerId:owned.id,ownershipVerified:true,
    running:true,healthy:true,loopbackBindingVerified:true,serverVersion:version,
    manifestSha256:sha256(readFileSync(manifestPath)),imageSha256:manifest.image.id,
    fixtureSourceSha256:sha256(readFileSync(fileURLToPath(import.meta.url))),ready:true,guiPassed:false}
}
async function start(path) {
  const prepared = loadManifest(path, false)
  need(absent(prepared.hostRoot), 'HOST_ROOT_ALREADY_EXISTS')
  const manifest = { ...prepared, image:inspectImage() }
  const fixtureName = `dbstudio-mysql-ui-${manifest.runId}`
  let attempted = false
  let ready = false
  try {
    attempted = true
    const id = docker(['run','--detach','--name',fixtureName,'--label',`${LABEL}=${manifest.runId}`,
      '--label',`io.dbstudio.fixture-owner=${OWNER}`,'--user','0:0','--memory','1536m',
      '--publish','127.0.0.1::3306','--mount',`type=bind,src=${manifest.fixtureRoot},dst=/fixture,readonly`,
      '--env-file',join(manifest.fixtureRoot,'container.env'),'--log-driver','none',
      '--health-cmd','mysql --defaults-extra-file=/fixture/admin-client.cnf --connect-timeout=3 --batch --skip-column-names --execute="SELECT 1" >/dev/null 2>&1',
      '--health-interval','3s','--health-timeout','5s','--health-start-period','20s','--health-retries','50',
      '--entrypoint','/bin/sh',manifest.image.id,'/fixture/start.sh'], {timeout:180000,code:'MYSQL_CONTAINER_START_FAILED'})
    need(/^[a-f0-9]{64}$/.test(id), 'CONTAINER_ID_INVALID'); manifest.containerId = id
    ownedContainer(manifest)
    const binding = docker(['inspect','--format','{{(index (index .NetworkSettings.Ports "3306/tcp") 0).HostIp}} {{(index (index .NetworkSettings.Ports "3306/tcp") 0).HostPort}}',id], {timeout:10000,code:'PORT_INSPECTION_FAILED'}).split(' ')
    need(binding[0] === '127.0.0.1' && /^\d+$/.test(binding[1]) && Number(binding[1]) > 0 && Number(binding[1]) <= 65535, 'LOOPBACK_BINDING_INVALID')
    manifest.port = Number(binding[1])
    const deadline = Date.now() + 180000
    for (;;) {
      const health = docker(['inspect','--format','{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',id], {timeout:5000,code:'HEALTH_INSPECTION_FAILED'})
      if (health === 'true healthy') break
      need(health.startsWith('true ') && health !== 'true unhealthy' && Date.now() < deadline, 'MYSQL_HEALTH_FAILED')
      await pause(1000)
    }
    const version = sql(manifest,'observer','SELECT VERSION()')
    need(/^8\.0\.\d+(?:[-.a-zA-Z0-9]*)$/.test(version), 'MYSQL_VERSION_MISMATCH')
    const settings = sql(manifest,'observer','SELECT @@session.autocommit,@@session.transaction_read_only,@@session.time_zone,@@global.time_zone,@@character_set_client,@@character_set_connection,@@character_set_results,@@collation_connection,@@session.transaction_isolation,@@session.sql_mode,@@global.require_secure_transport').split('\t')
    need(settings.length === 11 && settings[0] === '1' && settings[1] === '1' && settings[10] === '1', 'SESSION_SETTINGS_INVALID')
    const auth = sql(manifest,'admin',`SELECT plugin FROM mysql.user WHERE User='${manifest.app.user}' AND Host='%'`)
    need(auth === 'caching_sha2_password', 'APP_AUTH_PLUGIN_MISMATCH')
    const cipher = sql(manifest,'observer',"SHOW SESSION STATUS LIKE 'Ssl_cipher'").split('\t')
    need(cipher.length === 2 && cipher[0] === 'Ssl_cipher' && /^[A-Za-z0-9_-]+$/.test(cipher[1]), 'TLS_SERVER_ATTESTATION_FAILED')
    const observation = observe(manifest)
    need(observation.counts.import === 0, 'IMPORT_TABLE_NOT_EMPTY')
    // Host client configs use published ports, while container observer configs keep port 3306.
    for (const role of ['app','observer']) {
      const secret = readFileSync(materialFile(manifest,manifest[role].secretFilePath),'utf8').trim()
      need(/^[a-f0-9]{64}$/.test(secret), 'GENERATED_SECRET_INVALID')
      const client = join(manifest.fixtureRoot,`${role}-host-client.cnf`)
      privateFile(client,clientConfig(manifest[role].user,secret,manifest.database,manifest.port))
      manifest[role] = { ...manifest[role], clientConfigPath:client }
    }
    manifest.serverVersion = version
    manifest.sessionSettings = { autocommit:true,observerReadOnly:true,sessionTimeZone:settings[2],globalTimeZone:settings[3],characterSetClient:settings[4],characterSetConnection:settings[5],characterSetResults:settings[6],collationConnection:settings[7],isolation:settings[8],sqlMode:settings[9],requireSecureTransport:true,authenticationPlugin:auth,tlsEncrypted:true,tlsCipher:cipher[1] }
    manifest.ready = true; manifest.state = 'running'
    manifest.versionMatrix = [{version:'8.0',state:'service-ready',actual:version},{version:'8.4',state:'not-tested'}]
    const readyPath = join(manifest.fixtureRoot,'manifest.ready.json')
    validateManifest(manifest,readyPath,true)
    jsonFile(join(manifest.fixtureRoot,'observer.initial.json'),observation)
    const readyData = `${JSON.stringify(manifest,null,2)}\n`
    need(Buffer.byteLength(readyData) <= MAX_MANIFEST, 'MANIFEST_TOO_LARGE')
    const manifestSha256 = sha256(readyData)
    // Commit readiness only after every fallible baseline/metadata operation succeeds.
    // No further filesystem or Docker operation follows this exclusive publication.
    privateFile(readyPath,readyData)
    ready = true
    return { status:'SERVICE_READY',runId:manifest.runId,manifestPath:readyPath,containerId:manifest.containerId,
      serverVersion:version,health:true,counts:observation.counts,manifestSha256,dataDigest:manifest.dataDigest,guiPassed:false,retainedRunning:true }
  } catch (error) {
    jsonFile(join(manifest.fixtureRoot,`failure-${randomUUID()}.json`),{code:error instanceof FixtureFailure ? error.code : 'FIXTURE_FAILED',attempted,ready:false,guiPassed:false})
    throw error
  } finally {
    if (attempted && !ready) {
      try {
        const owned = ownedContainer(manifest)
        docker(['stop','--time','15',owned.id],{timeout:30000,code:'OWNED_CONTAINER_STOP_FAILED'})
        need(ownedContainer({...manifest,containerId:owned.id}).running === false, 'CONTAINER_STILL_RUNNING')
        jsonFile(join(manifest.fixtureRoot,`stopped-after-failure-${randomUUID()}.json`),{containerId:owned.id,stopped:true,retained:true})
      } catch { jsonFile(join(manifest.fixtureRoot,`stop-unconfirmed-${randomUUID()}.json`),{code:'STOP_OR_OWNERSHIP_UNCONFIRMED',retained:true}) }
    }
  }
}
export async function main(args = process.argv.slice(2)) {
  process.umask(0o077)
  if (args.length === 1 && args[0] === '--prepare-only') {
    const {path,manifest,manifestSha256} = prepare()
    return {status:'MATERIALS_PREPARED',runId:manifest.runId,manifestPath:path,manifestSha256,dataDigest:manifest.dataDigest,ready:false,guiPassed:false}
  }
  need(args.length === 2 && ['--start','--observe','--observe-rollback','--status','--stop'].includes(args[0]), 'ARGUMENTS_INVALID')
  if (args[0] === '--start') return start(args[1])
  const manifest = loadManifest(args[1],true)
  if (args[0] === '--status') return liveStatus(manifest,args[1])
  if (args[0] === '--observe-rollback') {
    liveStatus(manifest,args[1])
    return observeRollback(manifest)
  }
  if (args[0] === '--observe') {
    const observation = observe(manifest)
    jsonFile(join(manifest.fixtureRoot,`observer-${randomUUID()}.json`),observation)
    return {status:'OBSERVER_READBACK_OK',runId:manifest.runId,...observation}
  }
  const owned = ownedContainer(manifest)
  docker(['stop','--time','15',owned.id],{timeout:30000,code:'OWNED_CONTAINER_STOP_FAILED'})
  need(ownedContainer(manifest).running === false, 'CONTAINER_STILL_RUNNING')
  jsonFile(join(manifest.fixtureRoot,`stopped-${randomUUID()}.json`),{containerId:owned.id,stopped:true,retained:true})
  return {status:'OWNED_SERVICE_STOPPED_RETAINED',runId:manifest.runId,stopped:true,retained:true,guiPassed:false}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(JSON.stringify({status:'FIXTURE_FAILED',code:error instanceof FixtureFailure ? error.code : 'FIXTURE_INTERNAL_ERROR',ready:false,guiPassed:false}))
    process.exitCode = 1
  })
}
