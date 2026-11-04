/** owner 级认证后资源配额、生命周期和审计边界。 */

import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    lib: {
      entry: resolve(root, 'src/main/server/owner-governance.ts'),
      formats: ['es']
    }
  }
})
const output = Array.isArray(result) ? result[0].output : result.output
const code = output.find((item) => item.type === 'chunk')?.code
assert.equal(typeof code, 'string')
const { OwnerGovernance, OwnerQuotaError } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
)

let pass = 0
let fail = 0
async function check(name, run) {
  try {
    await run()
    pass += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  ❌ ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

await check('每个 owner 独立执行请求配额并幂等释放租约', () => {
  const governance = new OwnerGovernance({ quota: { maxConcurrentRequests: 1 } })
  const first = governance.acquireRequest(' owner-a ', 'r1')
  assert.throws(() => governance.acquireRequest('owner-a', 'r2'), OwnerQuotaError)
  const other = governance.acquireRequest('owner-b', 'r3')
  first.release()
  first.release()
  const next = governance.acquireRequest('owner-a', 'r4')
  other.release()
  next.release()
})

await check('连接与存储租约受 owner 配额限制', () => {
  const governance = new OwnerGovernance({
    quota: { maxConnections: 2, maxStorageBytes: 10 }
  })
  const connections = governance.reserveConnection('owner-a', 2)
  assert.throws(() => governance.reserveConnection('owner-a'), OwnerQuotaError)
  const storage = governance.reserveStorage('owner-a', 10)
  assert.throws(() => governance.reserveStorage('owner-a', 1), OwnerQuotaError)
  storage.release()
  connections.release()
})

await check('审计记录认证失败、配额拒绝与 owner 生命周期', () => {
  const events = []
  const governance = new OwnerGovernance({
    quota: { maxConcurrentRequests: 1 },
    audit: (event) => events.push(event)
  })
  governance.recordAuthenticationFailure('unauthorized-1')
  const lease = governance.acquireRequest('owner-a', 'accepted-1')
  assert.throws(() => governance.acquireRequest('owner-a', 'rejected-1'), OwnerQuotaError)
  lease.release()
  governance.disposeOwner('owner-a')
  assert.deepEqual(events.map(({ type, ownerId }) => [type, ownerId]), [
    ['authentication-failed', 'unknown'],
    ['owner-created', 'owner-a'],
    ['request-accepted', 'owner-a'],
    ['request-rejected', 'owner-a'],
    ['owner-disposed', 'owner-a']
  ])
})

await check('关闭后拒绝创建新 owner', () => {
  const governance = new OwnerGovernance()
  governance.dispose()
  assert.throws(() => governance.ensureOwner('owner-a'), /已关闭/)
})

console.log(`\n===== owner governance：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exitCode = 1
