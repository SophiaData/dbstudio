import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    write: false,
    target: 'node22',
    ssr: true,
    lib: { entry: resolve(root, 'src/main/server/http-auth.ts'), formats: ['es'] }
  }
})
const output = Array.isArray(result) ? result[0].output : result.output
const code = output.find((item) => item.type === 'chunk')?.code
assert.equal(typeof code, 'string')
const { createBearerTokenPrincipalResolver } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
)

const request = (authorization) => ({ headers: authorization === undefined ? {} : { authorization } })
const seen = []
const resolver = createBearerTokenPrincipalResolver(async (token) => {
  seen.push(token)
  return token === 'valid-token' ? { id: 'owner-a', roles: ['analyst'] } : null
})
assert.deepEqual(await resolver(request('Bearer valid-token')), { id: 'owner-a', roles: ['analyst'] })
assert.deepEqual(seen, ['valid-token'])
for (const authorization of [undefined, '', 'Basic valid-token', 'Bearer ', 'Bearer first second']) {
  await assert.rejects(
    () => resolver(request(authorization)),
    (error) => error?.code === 'unauthorized'
  )
}
await assert.rejects(
  () => resolver(request('Bearer invalid-token')),
  (error) => error?.code === 'unauthorized' && !error.message.includes('invalid-token')
)
console.log('HTTP bearer auth boundary 测试通过')
