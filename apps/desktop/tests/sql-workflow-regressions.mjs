// Focused regressions against the real workbench, with only native IPC replaced in memory.
// Standalone in CI: no pre-existing backups, DOM, native host, database, credentials or user storage.
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

process.umask(0o077)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = mkdtempSync(join(tmpdir(), 'dbstudio-sql-workflow-'))
const source = (name) => join(root, 'apps/desktop/src', name)
writeFileSync(join(output, 'entry.ts'), `export { useWorkbench } from ${JSON.stringify(source('workbench.ts'))};\nexport { decision } from ${JSON.stringify(source('dialogs.ts'))};\n`, { flag: 'wx', mode: 0o600 })
writeFileSync(join(output, 'backend.ts'), `
export const backend = new Proxy({}, { get(_target, method) {
  return (...args: unknown[]) => (globalThis as any).__DBSTUDIO_SQL_WORKFLOW_BACKEND__[method](...args)
} });
export const errorText = (error: any) => typeof error?.message === 'string' ? error.message : 'SYNTHETIC_BACKEND_ERROR';
export const migrationStatus = async () => ({ legacySecretsRequireReentry: false, warnings: [] });
`, { flag: 'wx', mode: 0o600 })
await build({
  configFile: false, envFile: false, root: output, envDir: output, logLevel: 'silent',
  resolve: { alias: [{ find: './backend', replacement: join(output, 'backend.ts') }] },
  // The unique output is outside the checkout; bundle Vue rather than relying on nearby node_modules.
  ssr: { noExternal: true },
  build: {
    outDir: join(output, 'bundle'), emptyOutDir: false, target: 'node22', ssr: true, minify: false,
    lib: { entry: join(output, 'entry.ts'), formats: ['cjs'] },
    rollupOptions: { output: { entryFileNames: 'workbench.cjs' } }
  }
})
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, value: { getItem: () => null, setItem: () => {} }
})
const { useWorkbench, decision } = await import(pathToFileURL(join(output, 'bundle/workbench.cjs')).href)
const text = (value) => ({ kind: 'text', text: value })
const number = (value) => ({ kind: 'number', value })
const originalError = () => new Error('SYNTHETIC_SQL_FAILED')
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(offset = 0) {
  const wb = useWorkbench()
  wb.connections.value = ['a', 'b'].map((id) => ({
    id, name: `synthetic-${id}`, dialectId: 'postgresql', connected: true,
    capabilities: { supportsInlineEdit: true, supportsCancel: true }
  }))
  wb.dialects.value = [{ id: 'postgresql', quoting: { open: '"', close: '"', escape: 'double' } }]
  wb.selectConnection('a')
  const values = new Map()
  const calls = { state: [], inserts: 0, applies: 0, offsets: [], closed: [] }
  let sequence = 0
  const page = (start) => {
    const rows = Array.from({ length: Math.max(0, Math.min(200, 805 - start)) }, (_, index) => {
      const id = start + index + 1
      return { index: start + index, cells: [number(id), text(values.get(id) ?? `original-${id}`)] }
    })
    return {
      columns: [{ name: 'id', type: 'integer' }, { name: 'body', type: 'text' }], rows,
      offset: start, returned: rows.length, hasMore: start + rows.length < 805,
      cursorId: `connection:a|cursor:synthetic-${++sequence}`,
      executedSql: 'SELECT id, body FROM synthetic ORDER BY id', elapsedMs: 0
    }
  }
  const initial = page(offset)
  const tab = {
    id: 'synthetic-tab-a', connectionId: 'a', title: 'synthetic',
    table: { id: 'connection:a|table:public.synthetic', name: 'synthetic', kind: 'table' },
    description: { hasUniqueKey: true, columns: [
      { name: 'id', primaryKeyOrdinal: 1 }, { name: 'body', primaryKeyOrdinal: null }
    ] },
    sql: initial.executedSql, querySql: initial.executedSql, parameters: [], result: initial, page: initial,
    message: '', busy: false, invalidated: false, dirty: new Map(), selectedRows: new Set(),
    filter: '', order: null, generation: 0
  }
  wb.tabs.value.push(tab)
  const active = wb.tabs.value[0]
  wb.activateTab(active)
  const backend = {
    async recordSqlHistory() { return {} },
    async transactionState(node) { calls.state.push(node); return { active: values.size > 0, pendingAffected: values.size } },
    async closeCursor(id) { calls.closed.push(id) },
    async runQuery(_node, _sql, options) { return page(options?.offset ?? 0) },
    async fetchResultPage(_cursor, requestedOffset) { calls.offsets.push(requestedOffset); return page(requestedOffset) },
    async applyEdits(_table, updates) {
      calls.applies++
      for (const update of updates) values.set(update.keyValues.id.value, update.changes.body.text)
      return { ok: true, affected: updates.length, outcomes: [] }
    },
    async insertRow() { calls.inserts++; values.set(806, 'inserted'); return { affected: 1, keyValues: { id: number(806) } } }
  }
  globalThis.__DBSTUDIO_SQL_WORKFLOW_BACKEND__ = backend
  return { wb, tab: active, backend, page, calls, values }
}
function finishDecision(value) {
  assert.ok(decision.value, 'synthetic decision must be open')
  decision.value.settle(value)
}
const outcomes = []
async function check(name, action) {
  try {
    await action()
    outcomes.push({ name, passed: true })
    console.log(`PASS SQL workflow: ${name}`)
  } catch {
    outcomes.push({ name, passed: false, code: 'ASSERTION_FAILED' })
    console.log(`FAIL SQL workflow: ${name} ASSERTION_FAILED`)
    // Keep subsequent cases independent if an assertion failed while a synthetic dialog was open.
    if (decision.value) decision.value.settle('cancel')
  }
}

await check('sql_failure_refreshes_original_connection_transaction', async () => {
  const { wb, backend, calls } = fixture()
  const execution = deferred()
  backend.executeStatement = () => execution.promise
  backend.transactionState = async (node) => { calls.state.push(node); return { active: false, pendingAffected: 0 } }
  wb.transactions.a = { active: true, pendingAffected: 7 }
  wb.transactions.b = { active: true, pendingAffected: 3 }
  const pending = wb.executeScript('UPDATE synthetic SET body=1')
  wb.selectConnection('b')
  execution.reject(originalError())
  await assert.rejects(pending, /SYNTHETIC_SQL_FAILED/)
  assert.deepEqual(calls.state, ['connection:a'])
  assert.deepEqual(wb.transactions.a, { active: false, pendingAffected: 0 })
  assert.deepEqual(wb.transactions.b, { active: true, pendingAffected: 3 })
  assert.equal(wb.currentConnectionId.value, 'b')
  assert.equal(wb.executing.value, false)
  assert.equal(wb.executionConnectionId.value, '')
  assert.ok(wb.tabs.value.every((tab) => !tab.busy))
})

await check('sql_failure_keeps_original_error_when_state_refresh_fails', async () => {
  const { wb, backend, calls } = fixture()
  backend.executeStatement = async () => { throw originalError() }
  backend.transactionState = async (node) => { calls.state.push(node); throw new Error('SYNTHETIC_STATE_REFRESH_FAILED') }
  await assert.rejects(wb.executeScript('SELECT 1'), (error) => error.message.includes('SYNTHETIC_SQL_FAILED') && !error.message.includes('SYNTHETIC_STATE_REFRESH_FAILED'))
  assert.deepEqual(calls.state, ['connection:a'])
  assert.equal(wb.executing.value, false)
  assert.equal(wb.executionConnectionId.value, '')
  assert.ok(wb.tabs.value.every((tab) => !tab.busy))
})

for (const cancelled of [false, true]) {
  await check(`cancel_${cancelled}_reports_result_for_original_execution`, async () => {
    const { wb, backend, page } = fixture()
    const execution = deferred()
    const cancellation = []
    backend.executeStatement = () => execution.promise
    backend.cancelQuery = async (...args) => { cancellation.push(args); return cancelled }
    const pending = wb.executeScript('SELECT 1')
    wb.selectConnection('b')
    try {
      await wb.cancelExecution()
      assert.equal(cancellation.length, 1)
      assert.equal(cancellation[0][0], 'connection:a')
      assert.equal(typeof cancellation[0][1], 'string')
      assert.ok(cancellation[0][1].length > 0)
      if (cancelled) {
        assert.equal(wb.status.value, '已请求取消执行')
        assert.equal(wb.statusError.value, false)
      } else {
        assert.notEqual(wb.status.value, '已请求取消执行')
        assert.match(wb.status.value, /未取消|无法取消|没有.*查询/)
      }
    } finally {
      execution.resolve({ kind: 'rows', result: page(0) })
      await pending
    }
  })
}

await check('insert_cancel_returns_false_without_backend_write', async () => {
  const { wb, tab, calls } = fixture()
  wb.stageCell(tab, tab.page.rows[0], 'body', text('keep-local-draft'))
  const pending = wb.insertRow(tab, { body: text('new-row') })
  finishDecision('cancel')
  assert.equal(await pending, false)
  assert.equal(calls.inserts, 0)
  assert.equal(tab.dirty.size, 1)
  assert.equal(wb.locks.has('a'), false)
})

await check('insert_success_returns_true_after_state_and_result_refresh', async () => {
  const { wb, tab, calls } = fixture()
  const result = await wb.insertRow(tab, { body: text('new-row') })
  assert.equal(result, true)
  assert.equal(calls.inserts, 1)
  assert.deepEqual(calls.state, ['connection:a'])
  assert.equal(wb.transactions.a.active, true)
  assert.ok(calls.closed.length > 0, 'refresh must replace the old cursor')
  assert.equal(wb.locks.has('a'), false)
})

await check('insert_backend_failure_still_throws', async () => {
  const { wb, tab, backend } = fixture()
  backend.insertRow = async () => { throw new Error('SYNTHETIC_INSERT_FAILED') }
  await assert.rejects(wb.insertRow(tab, { body: text('new-row') }), /SYNTHETIC_INSERT_FAILED/)
  assert.equal(wb.locks.has('a'), false)
})

await check('insert_refresh_failure_still_throws_instead_of_success', async () => {
  const { wb, tab, backend, calls } = fixture()
  backend.transactionState = async () => { throw new Error('SYNTHETIC_INSERT_REFRESH_FAILED') }
  await assert.rejects(wb.insertRow(tab, { body: text('new-row') }), /SYNTHETIC_INSERT_REFRESH_FAILED/)
  assert.equal(calls.inserts, 1)
  assert.equal(wb.locks.has('a'), false)
})

await check('dirty_apply_failed_next_page_retains_fresh_position_and_retries_target', async () => {
  const { wb, tab, backend, page, calls } = fixture(400)
  backend.fetchResultPage = async (_cursor, requestedOffset) => {
    calls.offsets.push(requestedOffset)
    if (calls.offsets.length === 1) throw new Error('SYNTHETIC_NEXT_PAGE_FAILED')
    return page(requestedOffset)
  }
  wb.stageCell(tab, tab.page.rows[0], 'body', text('applied-row-401'))
  const pending = wb.pageTab(tab, 1)
  finishDecision('apply')
  await assert.rejects(pending, /SYNTHETIC_NEXT_PAGE_FAILED/)
  assert.equal(tab.page.offset, 400)
  assert.equal(tab.page.rows[0].cells[1].text, 'applied-row-401', 'must refresh the applied data, not restore a stale pre-apply page')
  assert.equal(tab.dirty.size, 0)
  assert.equal(wb.transactions.a.active, true)
  assert.equal(tab.busy, false)
  assert.equal(wb.locks.has('a'), false)
  await wb.pageTab(tab, 1)
  assert.deepEqual(calls.offsets, [600, 600])
  assert.equal(tab.page.offset, 600)
  assert.equal(calls.applies, 1)
})

await check('dirty_apply_successful_next_page_keeps_requested_target', async () => {
  const { wb, tab, calls, values } = fixture(400)
  wb.stageCell(tab, tab.page.rows[0], 'body', text('applied-row-401'))
  const pending = wb.pageTab(tab, 1)
  finishDecision('apply')
  await pending
  assert.deepEqual(calls.offsets, [600])
  assert.equal(tab.page.offset, 600)
  assert.equal(values.get(401), 'applied-row-401')
  assert.equal(tab.dirty.size, 0)
  assert.equal(calls.applies, 1)
})

await check('clean_failed_next_page_keeps_position_without_reapplying', async () => {
  const { wb, tab, backend, calls } = fixture(400)
  backend.fetchResultPage = async (_cursor, requestedOffset) => { calls.offsets.push(requestedOffset); throw new Error('SYNTHETIC_NEXT_PAGE_FAILED') }
  await assert.rejects(wb.pageTab(tab, 1), /SYNTHETIC_NEXT_PAGE_FAILED/)
  assert.equal(tab.page.offset, 400)
  assert.equal(tab.page.rows[0].cells[1].text, 'original-401')
  assert.deepEqual(calls.offsets, [600])
  assert.equal(calls.applies, 0)
})

const failed = outcomes.filter((item) => !item.passed).length
writeFileSync(join(output, 'results.json'), JSON.stringify({ scope: 'real-workbench-pure-memory-ipc', native_or_gui_pass: false, outcomes }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(`SQL workflow regression checks: ${outcomes.length - failed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
// Unique synthetic build and results remain available. No cleanup/deletion operation.
