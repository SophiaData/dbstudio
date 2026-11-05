/** HTTP 环境配置、local 兼容边界与默认 JWT 接线。 */
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = await build({
  configFile: false, root, logLevel: 'warn', ssr: { noExternal: ['jose'] },
  build: { write: false, target: 'node22', ssr: true,
    lib: { entry: resolve(root, 'src/main/server/http-server-config.ts'), formats: ['es'] } }
})
const output = Array.isArray(result) ? result[0].output : result.output
const code = output.find((item) => item.type === 'chunk')?.code
assert.equal(typeof code, 'string')
const { createHttpServerPrincipalResolver, readHttpServerStartupConfig: read } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
)
assert.equal(read({}), null)
assert.equal(read({ DBSTUDIO_HTTP_PORT: ' ' }), null)
const legacy = read({ DBSTUDIO_HTTP_PORT: '0', DBSTUDIO_HTTP_OWNER_ID: 'desktop' })
assert.deepEqual(legacy, {
  host: '127.0.0.1', port: 0, ownerId: 'desktop', remoteOutboundPolicy: { allowedHosts: [], allowedPorts: [] }
})
assert.deepEqual(await createHttpServerPrincipalResolver(legacy)({}), { id: 'desktop' })
const local = read({ DBSTUDIO_HTTP_PORT: '0', DBSTUDIO_HTTP_AUTH_MODE: 'local', DBSTUDIO_HTTP_OWNER_ID: 'desktop' })
assert.deepEqual(await createHttpServerPrincipalResolver(local)({}), { id: 'desktop' })
const config = read({ DBSTUDIO_HTTP_PORT: '8123', DBSTUDIO_HTTP_HOST: '0.0.0.0', DBSTUDIO_HTTP_ALLOWED_HOSTS: 'db.example.test, jump.example.test', DBSTUDIO_HTTP_ALLOWED_PORTS: '5432,22' })
assert.deepEqual(config.remoteOutboundPolicy, { allowedHosts: ['db.example.test', 'jump.example.test'], allowedPorts: [5432, 22] })
assert.throws(() => createHttpServerPrincipalResolver(config), /必须配置 JWT 或注入 resolvePrincipal/)
const request = { headers: {} }
let observed
const injected = createHttpServerPrincipalResolver(config, async (value) => {
  observed = value
  return { id: ' owner ', roles: ['reader'], token: 'synthetic-must-not-project' }
})
assert.deepEqual(await injected(request), { id: 'owner', roles: ['reader'] })
assert.strictEqual(observed, request)
await assert.rejects(
  () => createHttpServerPrincipalResolver(config, () => { throw new Error('synthetic-private-error') })(request),
  (error) => error.code === 'unauthorized' && error.message === '认证失败' && error.cause === undefined
)
for (const env of [
  { DBSTUDIO_HTTP_HOST: '0.0.0.0', DBSTUDIO_HTTP_OWNER_ID: 'desktop' },
  { DBSTUDIO_HTTP_AUTH_MODE: 'local' },
  { DBSTUDIO_HTTP_AUTH_MODE: 'local', DBSTUDIO_HTTP_OWNER_ID: 'desktop', DBSTUDIO_HTTP_REQUIRE_AUTH: '1' },
  { DBSTUDIO_HTTP_OWNER_ID: 'desktop', DBSTUDIO_HTTP_REQUIRE_AUTH: 'true' },
  { DBSTUDIO_HTTP_AUTH_MODE: 'unknown' }, { DBSTUDIO_HTTP_REQUIRE_AUTH: 'unknown' },
  { DBSTUDIO_HTTP_AUTH_MODE: 'jwt' }, { DBSTUDIO_HTTP_JWT_ISSUER: 'https://issuer.example.test' },
  { DBSTUDIO_HTTP_ALLOWED_PORTS: '5432,bad' }, { DBSTUDIO_HTTP_ALLOWED_PORTS: '0' },
  { DBSTUDIO_HTTP_PORT: '-1' }, { DBSTUDIO_HTTP_PORT: '65536' }, { DBSTUDIO_HTTP_PORT: 'NaN' }
]) assert.throws(() => read({ DBSTUDIO_HTTP_PORT: '0', ...env }))
const required = read({ DBSTUDIO_HTTP_PORT: '0', DBSTUDIO_HTTP_REQUIRE_AUTH: '1' })
assert.throws(() => createHttpServerPrincipalResolver(required), /必须配置 JWT/)
assert.deepEqual(await createHttpServerPrincipalResolver(required, () => ({ id: 'verified' }))(request), { id: 'verified' })
const jwtEnv = {
  DBSTUDIO_HTTP_PORT: '0', DBSTUDIO_HTTP_AUTH_MODE: 'jwt', DBSTUDIO_HTTP_REQUIRE_AUTH: '1',
  DBSTUDIO_HTTP_JWT_ISSUER: 'https://issuer.example.test', DBSTUDIO_HTTP_JWT_AUDIENCE: 'dbstudio-test',
  DBSTUDIO_HTTP_JWT_JWKS_URL: 'https://issuer.example.test/keys'
}
const jwt = read(jwtEnv)
assert.equal(jwt.authMode, 'jwt')
assert.equal(jwt.jwt.issuer, jwtEnv.DBSTUDIO_HTTP_JWT_ISSUER)
const defaultJwtResolver = createHttpServerPrincipalResolver(jwt)
await assert.rejects(() => defaultJwtResolver(request), (error) => error.code === 'unauthorized' && error.message === '认证失败')
for (const env of [
  { DBSTUDIO_HTTP_OWNER_ID: 'desktop' },
  { DBSTUDIO_HTTP_JWT_AUDIENCE: '' },
  { DBSTUDIO_HTTP_JWT_JWKS_FILE: '/synthetic/public.jwks.json' },
  { DBSTUDIO_HTTP_JWT_JWKS_URL: 'http://issuer.example.test/keys' },
  { DBSTUDIO_HTTP_JWT_JWKS_URL: 'https://issuer.example.test/keys?secret=synthetic' },
  { DBSTUDIO_HTTP_AUTH_MODE: 'local', DBSTUDIO_HTTP_OWNER_ID: 'desktop' }
]) assert.throws(() => read({ ...jwtEnv, ...env }))
assert.equal(read({ ...jwtEnv, DBSTUDIO_HTTP_AUTH_MODE: undefined }).authMode, 'jwt')
console.log('HTTP startup config：local兼容、REQUIRE_AUTH、防错误配置及默认JWT接线测试通过')
