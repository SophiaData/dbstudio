import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = await build({
  configFile: false, root, logLevel: 'warn',
  build: { write: false, target: 'node22', ssr: true,
    lib: { entry: resolve(root, 'src/renderer/transaction-controller.ts'), formats: ['es'] } }
})
const output = Array.isArray(result) ? result[0].output : result.output
const code = output.find((item) => item.type === 'chunk').code
const { TransactionController } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const controller = new TransactionController('c1')
let active = 0
let revision = 1
const errors = []
const api = { transactionState: async () => ({ active: true, pendingAffected: revision }) }
const participants = ['a', 'b'].map((id) => ({
  transactionParticipantId: id, transactionNodeId: 'connection:c1', connectionNodeId: 'connection:c1',
  rowsAtRevision: 0,
  getLocalDirtySummary: () => ({ rows: 0, cells: 0 }),
  applyLocalEditsFromController: async () => true,
  discardLocalEditsFromController() {},
  setTransactionStateFromController() {},
  reportTransactionControllerStatus: (message, isError) => { if (isError) errors.push(message) },
  async refreshFromTransactionController() {
    assert.equal(active, 0, '同一连接的 preview 查询不能重叠')
    active += 1
    try {
      await new Promise(setImmediate)
      this.rowsAtRevision = revision
    } finally { active -= 1 }
  }
}))
const unregister = participants.map((p) => controller.register(api, p))
await controller.notifyMutation(participants[0])
assert.deepEqual(errors, [])
assert.deepEqual(participants.map((p) => p.rowsAtRevision), [1, 1], '通知完成前两个标签都要完成刷新')
revision = 2
await controller.notifyExternalMutation()
assert.deepEqual(errors, [])
assert.deepEqual(participants.map((p) => p.rowsAtRevision), [2, 2])
for (const release of unregister) release()
console.log('事务变更按连接串行刷新所有标签：通过')
