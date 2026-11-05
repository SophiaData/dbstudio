/** 真正构建/启动/关闭 Node 入口；所有 key/token/密码均为临时合成材料。 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { build } from 'vite'
import { buildHttpServer } from '../scripts/build-http-server.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(resolve(tmpdir(), 'dbstudio-runtime-test-'))
const children = new Set()
let runtimeConfigCode
async function load(relative) {
  const result = await build({
    configFile: false, root, logLevel: 'warn', ssr: { noExternal: ['jose'] },
    build: { write: false, target: 'node22', ssr: true,
      lib: { entry: resolve(root, relative), formats: ['es'] } }
  })
  const output = Array.isArray(result) ? result[0].output : result.output
  const code = output.find((item) => item.type === 'chunk')?.code
  if (relative.endsWith('runtime-config.ts')) runtimeConfigCode = code
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}
function childProcess(env) {
  const child = spawn(process.execPath, [resolve(temp, 'build/index.mjs')], {
    env: { PATH: process.env.PATH, NODE_PATH: resolve(root, 'node_modules'), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  const append = (chunk) => { output = (output + chunk.toString()).slice(-64 * 1024) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  children.add(child)
  const exited = once(child, 'exit').then(([code, signal]) => {
    children.delete(child)
    return { code, signal }
  })
  return { child, exited, output: () => output }
}
async function boundedExit(run) {
  let timer
  try {
    return await Promise.race([
      run.exited,
      new Promise((_, reject) => { timer = setTimeout(() => { run.child.kill('SIGKILL'); reject(new Error('Node入口未在期限内退出')) }, 15_000) })
    ])
  } finally { clearTimeout(timer) }
}
async function launch(env) {
  const run = childProcess(env)
  let timer
  try {
    const port = await new Promise((resolvePort, reject) => {
      const onData = () => {
        const match = /\[http-server\] listening 127\.0\.0\.1:(\d+)/.exec(run.output())
        if (match) resolvePort(Number(match[1]))
      }
      run.child.stdout.on('data', onData)
      run.exited.then(() => reject(new Error('Node入口在监听前退出；未输出其原始日志')))
      timer = setTimeout(() => reject(new Error('Node入口未在期限内监听')), 15_000)
    })
    return { ...run, port }
  } catch (error) {
    run.child.kill('SIGTERM')
    await boundedExit(run)
    throw error
  } finally { clearTimeout(timer) }
}
async function stop(run) {
  run.child.kill('SIGTERM')
  const result = await boundedExit(run)
  assert.equal(result.code, 0, 'SIGTERM应优雅退出')
  assert.equal(result.signal, null)
}
async function json(run, path, token, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${run.port}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: response.status, body: await response.json() }
}

try {
  const { createStandaloneSecretCipher, readStandaloneDataDir } = await load('src/server/runtime-config.ts')
  const key = randomBytes(32).toString('base64')
  const secret = randomBytes(24).toString('base64')
  const encryptedEnv = { DBSTUDIO_HTTP_SECRETS_MODE: 'encrypted', DBSTUDIO_HTTP_SECRET_KEY_BASE64: key }
  const cipher = createStandaloneSecretCipher(encryptedEnv)
  const payload = cipher.encrypt(secret)
  assert.equal(payload.includes(Buffer.from(secret)), false)
  assert.equal(cipher.decrypt(payload) === secret, true)
  assert.equal(createStandaloneSecretCipher(encryptedEnv).decrypt(payload) === secret, true, '重启后同key可解密')
  const tampered = Buffer.from(payload)
  tampered[tampered.length - 1] ^= 1
  assert.throws(() => cipher.decrypt(tampered), (error) => error.message === 'HTTP 凭据解密失败' && error.cause === undefined)
  const different = createStandaloneSecretCipher({ ...encryptedEnv, DBSTUDIO_HTTP_SECRET_KEY_BASE64: randomBytes(32).toString('base64') })
  assert.throws(() => different.decrypt(payload), /HTTP 凭据解密失败/)
  const { ConnectionStore } = await load('src/main/ConnectionStore.ts')
  const storeDir = resolve(temp, 'cipher-store')
  const store = new ConnectionStore({ baseDir: storeDir, cipher })
  store.saveConnection('synthetic', { dialectId: 'postgresql', name: 'synthetic', options: { host: 'db.example.test', port: 5432 } })
  store.setSecret('synthetic', { dbPassword: secret })
  assert.equal(readFileSync(store.secretsPath, 'utf8').includes(secret), false)
  const restoredStore = new ConnectionStore({ baseDir: storeDir, cipher: createStandaloneSecretCipher(encryptedEnv) })
  assert.equal(restoredStore.getSecret('synthetic')?.dbPassword === secret, true)
  const disabledStore = new ConnectionStore({ baseDir: resolve(temp, 'disabled-store'), cipher: null })
  assert.throws(() => disabledStore.setSecret('synthetic', { dbPassword: secret }))
  assert.equal(createStandaloneSecretCipher({ DBSTUDIO_HTTP_SECRETS_MODE: 'disabled' }), null)
  for (const env of [{}, { DBSTUDIO_HTTP_SECRETS_MODE: 'encrypted' },
    { ...encryptedEnv, DBSTUDIO_HTTP_SECRET_KEY_BASE64: 'synthetic-invalid' },
    { ...encryptedEnv, DBSTUDIO_HTTP_SECRET_KEY_FILE: '/synthetic/unused' },
    { ...encryptedEnv, DBSTUDIO_HTTP_SECRETS_MODE: 'disabled' }
  ]) assert.throws(() => createStandaloneSecretCipher(env))
  const keyFile = resolve(temp, 'synthetic.key')
  writeFileSync(keyFile, key, { mode: 0o600 })
  const fileCipher = createStandaloneSecretCipher({ DBSTUDIO_HTTP_SECRETS_MODE: 'encrypted', DBSTUDIO_HTTP_SECRET_KEY_FILE: keyFile })
  assert.equal(fileCipher.decrypt(payload) === secret, true)
  if (process.platform !== 'win32') {
    chmodSync(keyFile, 0o644)
    assert.throws(() => createStandaloneSecretCipher({ DBSTUDIO_HTTP_SECRETS_MODE: 'encrypted', DBSTUDIO_HTTP_SECRET_KEY_FILE: keyFile }))
    chmodSync(keyFile, 0o600)
    const fifo = resolve(temp, 'synthetic-key.fifo')
    assert.equal(spawnSync('mkfifo', [fifo], { timeout: 5_000 }).status, 0)
    const modulePath = resolve(temp, 'cipher-under-test.mjs')
    writeFileSync(modulePath, runtimeConfigCode)
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createStandaloneSecretCipher } from ${JSON.stringify(pathToFileURL(modulePath).href)}
      try {
        createStandaloneSecretCipher({ DBSTUDIO_HTTP_SECRETS_MODE: 'encrypted', DBSTUDIO_HTTP_SECRET_KEY_FILE: ${JSON.stringify(fifo)} })
        process.exitCode = 2
      } catch (error) {
        process.exitCode = error.message.includes('SECRET_KEY_FILE') && error.cause === undefined ? 0 : 3
      }
    `], { timeout: 5_000, killSignal: 'SIGKILL', stdio: 'pipe' })
    assert.equal(probe.signal, null, 'FIFO必须立即拒绝，不能等待writer')
    assert.equal(probe.status, 0)
  }
  assert.throws(() => readStandaloneDataDir({}), /绝对路径/)
  assert.throws(() => readStandaloneDataDir({ DBSTUDIO_HTTP_DATA_DIR: 'relative' }), /绝对路径/)

  await buildHttpServer(resolve(temp, 'build'))
  assert.equal(existsSync(resolve(temp, 'build/index.mjs')), true)
  assert.equal(existsSync(resolve(temp, 'build/driver-host/index.cjs')), true)
  const pair = await generateKeyPair('RS256', { extractable: true })
  const jwksFile = resolve(temp, 'public.jwks.json')
  writeFileSync(jwksFile, JSON.stringify({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'runtime', alg: 'RS256', use: 'sig' }] }))
  const env = {
    DBSTUDIO_HTTP_PORT: '0', DBSTUDIO_HTTP_HOST: '127.0.0.1', DBSTUDIO_HTTP_AUTH_MODE: 'jwt', DBSTUDIO_HTTP_REQUIRE_AUTH: '1',
    DBSTUDIO_HTTP_JWT_ISSUER: 'https://issuer.example.test', DBSTUDIO_HTTP_JWT_AUDIENCE: 'runtime-test', DBSTUDIO_HTTP_JWT_JWKS_FILE: jwksFile,
    DBSTUDIO_HTTP_DATA_DIR: resolve(temp, 'data'), DBSTUDIO_HTTP_ALLOWED_ORIGINS: 'null, https://frontend.example.test', ...encryptedEnv
  }
  const tokenFor = (owner) => new SignJWT({ roles: ['reader'] }).setProtectedHeader({ alg: 'RS256', kid: 'runtime' })
    .setIssuer(env.DBSTUDIO_HTTP_JWT_ISSUER).setAudience(env.DBSTUDIO_HTTP_JWT_AUDIENCE).setSubject(owner).setExpirationTime('2m').sign(pair.privateKey)
  const token = await tokenFor('runtime-owner')
  const otherToken = await tokenFor('other-owner')
  for (const invalid of [
    { DBSTUDIO_HTTP_PORT: '' }, { DBSTUDIO_HTTP_JWT_AUDIENCE: '' },
    { DBSTUDIO_HTTP_SECRETS_MODE: '' }, { DBSTUDIO_HTTP_DATA_DIR: 'relative' },
    { DBSTUDIO_HTTP_SECRET_KEY_BASE64: 'synthetic-invalid' }, { DBSTUDIO_HTTP_MAX_CONNECTIONS: '0' },
    { DBSTUDIO_HTTP_ALLOWED_ORIGINS: '*' }
  ]) {
    const failed = childProcess({ ...env, ...invalid })
    assert.equal((await boundedExit(failed)).code, 1)
    assert.equal(failed.output().includes('[http-server] listening'), false)
    assert.equal(failed.output().includes(key), false)
  }
  env.DBSTUDIO_HTTP_ALLOWED_HOSTS = 'db.example.test'
  env.DBSTUDIO_HTTP_ALLOWED_PORTS = '5432'
  const running = await launch(env)
  for (const [path, method, body] of [
    ['/connections', 'GET'], ['/rpc', 'POST', { id: 'no-auth', method: 'listDialects', args: [] }]
  ]) {
    const missing = await json(running, path, undefined, method, body)
    assert.equal(missing.status, 401)
    assert.equal(missing.body.error.code, 'unauthorized')
    assert.equal(missing.body.error.message, '认证失败')
    const invalid = await json(running, path, 'synthetic-invalid', method, body)
    assert.equal(invalid.status, 401)
    assert.equal(invalid.body.error.message, '认证失败')
  }
  const dialects = await json(running, '/rpc', token, 'POST', { id: 'dialects', method: 'listDialects', args: [] })
  assert.equal(dialects.status, 200)
  assert.equal(dialects.body.ok, true)
  assert.equal(dialects.body.value.some((value) => value.id === 'postgresql'), true)
  assert.deepEqual((await json(running, '/connections', token)).body.value, [])
  // 仅验证出站策略拒绝，不放开生产loopback边界、不声称已连上真实数据库。
  const denied = await json(running, '/connections', token, 'POST', {
    config: { dialectId: 'postgresql', name: 'runtime-test', options: { host: '127.0.0.1', port: 5432 } },
    secret: { dbPassword: secret }
  })
  assert.equal(denied.status, 400)
  assert.equal(denied.body.error.code, 'invalid-argument')
  assert.deepEqual((await json(running, '/connections', token)).body.value, [])
  assert.deepEqual((await json(running, '/connections', otherToken)).body.value, [])
  assert.equal(existsSync(env.DBSTUDIO_HTTP_DATA_DIR), true)
  assert.equal(running.output().includes(token), false)
  assert.equal(running.output().includes(secret), false)
  assert.equal(running.output().includes(key), false)
  await stop(running)
  const restarted = await launch(env)
  const saved = await json(restarted, '/connections', token)
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.value, [])
  await stop(restarted)
  const disabled = await launch({ ...env, DBSTUDIO_HTTP_SECRETS_MODE: 'disabled', DBSTUDIO_HTTP_SECRET_KEY_BASE64: undefined, DBSTUDIO_HTTP_DATA_DIR: resolve(temp, 'disabled-data') })
  assert.equal((await json(disabled, '/connections', token)).status, 200)
  await stop(disabled)

  // 嵌入provider故障在所有已配置HTTP路由上统一变成401，不携带原message/cause。
  const { createConfiguredHttpServer } = await load('src/main/server/http-server-runtime.ts')
  for (const authEnv of [
    { DBSTUDIO_HTTP_AUTH_MODE: 'local', DBSTUDIO_HTTP_OWNER_ID: 'desktop' },
    { DBSTUDIO_HTTP_OWNER_ID: 'desktop' },
    {}
  ]) {
    await assert.rejects(() => createConfiguredHttpServer({
      DBSTUDIO_HTTP_PORT: '0', DBSTUDIO_HTTP_ALLOWED_ORIGINS: 'null', ...authEnv
    }, {
      baseDir: resolve(temp, 'cors-rejected'), cipher: null, resolvePrincipal: () => ({ id: 'injected' })
    }), /ALLOWED_ORIGINS 仅允许 JWT 或 REQUIRE_AUTH/)
  }
  const embedded = await createConfiguredHttpServer({ DBSTUDIO_HTTP_PORT: '0', DBSTUDIO_HTTP_REQUIRE_AUTH: '1', DBSTUDIO_HTTP_ALLOWED_ORIGINS: 'null' }, {
    baseDir: resolve(temp, 'provider-data'), cipher: null,
    resolvePrincipal: () => { throw new Error('synthetic-sensitive-provider-error') },
    auditSink: { record() {} }, metricsSink: { record() {} }
  })
  try {
    const failure = await json({ port: embedded.address.port }, '/connections')
    assert.equal(failure.status, 401)
    assert.equal(failure.body.error.message, '认证失败')
    assert.equal(JSON.stringify(failure.body).includes('synthetic-sensitive-provider-error'), false)
  } finally { await embedded.close() }
  console.log('HTTP Node runtime：真实build/start、JWT、owner路由、目标拒绝、cipher/store重载、disabled及SIGTERM通过')
} finally {
  await Promise.all([...children].map(async (child) => {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }))
  const recycle = resolve(tmpdir(), 'dbstudio-test-recycle')
  mkdirSync(recycle, { recursive: true })
  assert.equal(dirname(temp), resolve(tmpdir()))
  renameSync(temp, resolve(recycle, basename(temp)))
}
