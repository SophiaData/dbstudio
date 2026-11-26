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
const storage = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, value: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
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
function fixture(offset = 0, { preserveStorage = false, totalRows = 805 } = {}) {
  if (!preserveStorage) storage.clear()
  const wb = useWorkbench()
  wb.connections.value = ['a', 'b'].map((id) => ({
    id, name: `synthetic-${id}`, dialectId: 'postgresql', connected: true,
    capabilities: { supportsInlineEdit: true, supportsCancel: true }
  }))
  wb.dialects.value = [{ id: 'postgresql', quoting: { open: '"', close: '"', escape: 'double' } }]
  wb.selectConnection('a')
  const values = new Map()
  const calls = { state: [], inserts: 0, applies: 0, offsets: [], fetches: [], queries: [], closed: [] }
  let sequence = 0
  const page = (start, limit = 200) => {
    const rows = Array.from({ length: Math.max(0, Math.min(limit, totalRows - start)) }, (_, index) => {
      const id = start + index + 1
      return { index: start + index, cells: [number(id), text(values.get(id) ?? `original-${id}`)] }
    })
    return {
      columns: [{ name: 'id', type: 'integer' }, { name: 'body', type: 'text' }], rows,
      offset: start, returned: rows.length, hasMore: start + rows.length < totalRows,
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
    filter: '', order: [], generation: 0
  }
  wb.tabs.value.push(tab)
  const active = wb.tabs.value[0]
  wb.activateTab(active)
  const backend = {
    async recordSqlHistory() { return {} },
    async transactionState(node) { calls.state.push(node); return { active: values.size > 0, pendingAffected: values.size } },
    async closeCursor(id) { calls.closed.push(id) },
    async runQuery(node, sql, options) {
      calls.queries.push({ node, sql, options: { ...options } })
      const result = page(options?.offset ?? 0, options?.limit ?? 200)
      result.cursorId = result.cursorId.replace('connection:a|', `${node}|`)
      return result
    },
    async fetchResultPage(cursor, requestedOffset, limit) {
      calls.offsets.push(requestedOffset)
      calls.fetches.push({ cursor, offset: requestedOffset, limit })
      return { ...page(requestedOffset, limit), cursorId: cursor }
    },
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
function addResultTab({ wb, tab, page }, connectionId, size) {
  const result = page(0, size)
  result.cursorId = result.cursorId.replace('connection:a|', `connection:${connectionId}|`)
  wb.tabs.value.push({
    ...tab, id: `synthetic-tab-${connectionId}-${wb.tabs.value.length}`, connectionId,
    table: { ...tab.table, id: `connection:${connectionId}|table:public.synthetic` },
    result, page: result, pageSize: size, generation: 0, busy: false, invalidated: false,
    filter: '', appliedFilter: '', order: [], dirty: new Map(), selectedRows: new Set()
  })
  return wb.tabs.value.at(-1)
}
// Hold an IPC response after recording its actual arguments. No timers or native work.
function holdBackend(backend, method) {
  const original = backend[method]
  const response = deferred()
  const held = { args: null, resolve: response.resolve, reject: response.reject }
  backend[method] = (...args) => {
    held.args = args
    const result = original(...args)
    return response.promise.then(() => result)
  }
  return held
}
async function waitForBackend(held) {
  for (let turn = 0; turn < 100 && !held.args; turn++) await Promise.resolve()
  assert.ok(held.args, 'operation must reach the held backend call')
}
function pageSnapshot(tab) {
  return {
    result: tab.result, page: tab.page, pageSize: tab.pageSize,
    generation: tab.generation, cursor: tab.result?.cursorId, invalidated: tab.invalidated,
    selectedRows: [...tab.selectedRows]
  }
}
function assertPageSnapshot(tab, before) {
  assert.equal(tab.result, before.result)
  assert.equal(tab.page, before.page)
  assert.equal(tab.pageSize, before.pageSize)
  assert.equal(tab.generation, before.generation)
  assert.equal(tab.result?.cursorId, before.cursor)
  assert.equal(tab.invalidated, before.invalidated)
  assert.deepEqual([...tab.selectedRows], before.selectedRows)
}
function assertIdle(wb, tab) {
  assert.equal(tab.busy, false)
  assert.equal(wb.locks.has(tab.connectionId), false)
}
function assertNoBackendWork(calls) {
  assert.deepEqual(calls, { state: [], inserts: 0, applies: 0, offsets: [], fetches: [], queries: [], closed: [] })
}
async function rejectsWithoutDecision(action, expected) {
  // Observe rejection immediately; cancel an unexpected dialog so a regression cannot hang the suite.
  let outcome
  const observed = Promise.resolve().then(action).then(
    () => { outcome = { rejected: false } },
    (error) => { outcome = { rejected: true, error } }
  )
  let asked = false
  for (let turn = 0; turn < 100 && !outcome; turn++) {
    if (decision.value) { asked = true; finishDecision('cancel') }
    await Promise.resolve()
  }
  assert.ok(outcome, 'rejection must settle without waiting for user input')
  await observed
  assert.equal(asked, false, 'invalid input must be rejected before any dirty-draft decision')
  assert.equal(outcome.rejected, true)
  if (expected) assert.match(outcome.error.message, expected)
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

await check('sql_editor_tabs_restore_independent_drafts_on_the_same_connection', () => {
  const { wb } = fixture()
  const first = wb.activeEditorTabId.value
  wb.sql.value = 'SELECT 1 AS first_draft'
  const second = wb.openEditorTab('a', 'SELECT 2 AS second_draft')
  const third = wb.openEditorTab('b', 'SELECT 3 AS third_draft')
  const restored = useWorkbench()
  assert.deepEqual(restored.editorTabs.value.map((tab) => [tab.id, tab.connectionId, tab.sql]), [
    [first, 'a', 'SELECT 1 AS first_draft'], [second, 'a', 'SELECT 2 AS second_draft'], [third, 'b', 'SELECT 3 AS third_draft']
  ])
  assert.equal(restored.activeEditorTabId.value, third)
  restored.activateEditorTab(first)
  assert.equal(restored.sql.value, 'SELECT 1 AS first_draft')
})

await check('sql_editor_keeps_a_draft_when_close_is_cancelled', async () => {
  const { wb } = fixture()
  const editor = wb.openEditorTab('a', 'SELECT 1 AS retained_draft')
  const closing = wb.closeEditorTab(editor)
  finishDecision('cancel')
  await closing
  assert.equal(wb.activeEditorTabId.value, editor)
  assert.equal(wb.sql.value, 'SELECT 1 AS retained_draft')
  assert.equal(useWorkbench().sql.value, 'SELECT 1 AS retained_draft')
})

await check('sql_editor_migrates_legacy_drafts_without_overwriting_the_old_keys', () => {
  storage.clear()
  const oldKey = 'dbstudio.vue.sql-draft.v1.a'
  storage.set(oldKey, 'SELECT 10 AS legacy_a')
  storage.set('dbstudio.vue.sql-draft.v1.b', 'SELECT 20 AS legacy_b')
  const { wb } = fixture(0, { preserveStorage: true })
  assert.equal(wb.sql.value, 'SELECT 10 AS legacy_a')
  assert.equal(wb.editorTabs.value.find((tab) => tab.connectionId === 'b').sql, 'SELECT 20 AS legacy_b')
  wb.sql.value = 'SELECT 30 AS current_a'
  assert.equal(storage.get(oldKey), 'SELECT 10 AS legacy_a')
  assert.equal(useWorkbench().sql.value, 'SELECT 30 AS current_a')
})

await check('sql_editor_retries_legacy_migration_after_an_offline_draft_was_saved', () => {
  storage.clear()
  storage.set('dbstudio.vue.sql-draft.v1.a', 'SELECT 10 AS legacy_a')
  const offline = useWorkbench()
  offline.openEditorTab('', 'SELECT 20 AS offline_draft')
  const { wb } = fixture(0, { preserveStorage: true })
  assert.equal(wb.sql.value, 'SELECT 20 AS offline_draft')
  assert.ok(wb.editorTabs.value.some((tab) => tab.connectionId === 'a' && tab.sql === 'SELECT 10 AS legacy_a'))
})

await check('sql_editor_preserves_an_unknown_storage_version', () => {
  storage.clear()
  const key = ['dbstudio.vue', 'editor-tabs.v2'].join('.')
  const original = JSON.stringify({ version: 3, tabs: [{ sql: 'future draft' }] })
  storage.set(key, original)
  const { wb } = fixture(0, { preserveStorage: true })
  wb.sql.value = 'SELECT 1 AS session_only'
  assert.equal(wb.sql.value, 'SELECT 1 AS session_only')
  assert.equal(storage.get(key), original)
  assert.ok(wb.editorStorageWarning.value)
})

await check('sql_parameter_execution_uses_its_origin_after_switching_editor_and_tree', async () => {
  const { wb, backend } = fixture()
  wb.connections.value[0].dialectId = 'mysql'
  wb.dialects.value.push({ id: 'mysql', quoting: { open: '`', close: '`', escape: 'double' } })
  const editorA = wb.activeEditorTabId.value
  wb.sql.value = 'SELECT ? AS from_a'
  const pending = wb.captureEditorExecution(wb.sql.value)
  assert.equal(wb.parameterSlots(pending.sql, pending.connectionId).length, 1)
  const editorB = wb.openEditorTab('b', 'SELECT 2 AS from_b')
  wb.selectNode({ id: 'connection:a', kind: 'connection', name: 'a' })
  wb.activateTab(wb.tabs.value[0])
  assert.equal(wb.activeEditorTabId.value, editorB)
  const calls = []
  const result = deferred()
  backend.executeStatement = (node, sql, options) => { calls.push([node, sql, options.parameters]); return result.promise }
  const execution = wb.executeEditorRequest(pending, [{ statementIndex: 0, name: '?1', value: 'sample' }])
  result.resolve({ kind: 'affected', affected: 0, elapsedMs: 0, transactionState: { active: false, pendingAffected: 0 } })
  await execution
  assert.equal(calls[0][0], 'connection:a')
  assert.equal(calls[0][1], 'SELECT ? AS from_a')
  assert.deepEqual(calls[0][2], [{ name: '?1', value: 'sample' }])
  assert.equal(wb.activeTabId.value, 'synthetic-tab-a')
  assert.equal(wb.tabs.value.at(-1).editorTabId, editorA)
  assert.equal(wb.activeEditorTabId.value, editorB)
  assert.equal(wb.sql.value, 'SELECT 2 AS from_b')
})

await check('sql_parameters_refuse_a_closed_editor_or_changed_connection', async () => {
  const { wb, backend } = fixture()
  const open = wb.openEditorTab('b', '')
  const closed = wb.captureEditorExecution('SELECT 1')
  await wb.closeEditorTab(open)
  await assert.rejects(wb.executeEditorRequest(closed), /已关闭或连接已变化/)
  const changed = wb.captureEditorExecution('SELECT 1')
  backend.disconnectConnection = async () => null
  backend.listConnections = async () => wb.connections.value
  backend.listChildren = async () => []
  await wb.disconnect('a')
  await assert.rejects(wb.executeEditorRequest(changed), /已关闭或连接已变化/)
})

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

await check('failed_second_statement_maps_selected_script_back_to_original_draft', async () => {
  const { wb, backend, page } = fixture()
  const document = "-- 中文😀\r\nSELECT 0;\r\nSELECT 1;\r\nSELECT missing_col;\r\nSELECT 3;"
  wb.sql.value = document
  const from = document.indexOf('SELECT 1')
  const request = wb.captureEditorExecution(document.slice(from), { document, from, to: document.length })
  const calls = []
  backend.executeStatement = async (_node, sql) => {
    calls.push(sql)
    if (calls.length === 2) throw originalError()
    return { kind: 'rows', result: page(0) }
  }
  await assert.rejects(wb.executeEditorRequest(request), /编辑器第 4 行/)
  assert.deepEqual(calls, ['SELECT 1', 'SELECT missing_col'])
  const failure = wb.activeTab.value.failure
  assert.equal(failure.statementIndex, 1)
  assert.equal(failure.startLine, 4)
  assert.equal(failure.endLine, 4)
  assert.equal(failure.source.document, document)
  assert.equal(document.slice(failure.source.from, failure.source.to), 'SELECT missing_col')
  assert.equal(failure.phase, 'execution')
  assert.equal(wb.executing.value, false)
})

await check('execution_source_is_captured_before_parameter_wait_and_tab_switch', async () => {
  const { wb, backend } = fixture()
  const document = 'SELECT $1;\nSELECT $1;'
  wb.sql.value = document
  const request = wb.captureEditorExecution('SELECT $1', { document, from: 11, to: 20 })
  wb.sql.value = 'SELECT 999'
  wb.selectConnection('b')
  backend.executeStatement = async () => { throw originalError() }
  await assert.rejects(wb.executeEditorRequest(request, [{ statementIndex: 0, name: '$1', value: 'sample' }]), /SYNTHETIC_SQL_FAILED/)
  const failure = wb.tabs.value.at(-1).failure
  assert.equal(failure.startLine, 2)
  assert.equal(failure.source.document, document)
  assert.equal(failure.source.from, 11)
  assert.equal(wb.currentConnectionId.value, 'b')
  assert.equal(wb.editorTabs.value.find((tab) => tab.id === request.editorTabId).sql, 'SELECT 999')
})

await check('unrelated_script_has_no_guessed_editor_location_and_bad_source_is_rejected', async () => {
  const { wb, backend } = fixture()
  wb.sql.value = 'SELECT 1; SELECT 1;'
  assert.throws(() => wb.captureEditorExecution('SELECT 1', { document: wb.sql.value, from: 3, to: 11 }), /选区已变化/)
  backend.executeStatement = async () => { throw originalError() }
  await assert.rejects(wb.executeScript('SELECT external'), /执行片段第 1 行/)
  assert.equal(wb.activeTab.value.failure.source, undefined)
})

await check('successful_statement_with_failed_refresh_warns_before_retry', async () => {
  const { wb, backend, page } = fixture()
  backend.executeStatement = async () => ({ kind: 'rows', result: page(0) })
  backend.transactionState = async () => { throw new Error('SYNTHETIC_STATE_REFRESH_FAILED') }
  await assert.rejects(wb.executeScript('SELECT 1'), /语句已执行，后续处理失败/)
  assert.equal(wb.activeTab.value.failure.phase, 'after-execution')
  assert.equal(wb.activeTab.value.failure.message, 'SYNTHETIC_STATE_REFRESH_FAILED')
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

await check('insert_refresh_failure_reports_insert_succeeded_and_refresh_failed', async () => {
  const { wb, tab, backend, calls } = fixture()
  backend.transactionState = async () => { throw new Error('SYNTHETIC_INSERT_REFRESH_FAILED') }
  // The row was written before the refresh step; a refresh failure must not be reported as a failed insert.
  assert.equal(await wb.insertRow(tab, { body: text('new-row') }), true)
  assert.equal(calls.inserts, 1)
  assert.equal(wb.statusError.value, true)
  assert.match(wb.status.value, /已插入 1 行/)
  assert.match(wb.status.value, /刷新失败/)
  assert.match(wb.status.value, /SYNTHETIC_INSERT_REFRESH_FAILED/)
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

const pageSizes = [100, 200, 500, 1000]
const navigation = [
  { name: 'page', invoke: (wb, tab) => wb.pageTab(tab, 1), offset: 600, size: 200 },
  { name: 'size', invoke: (wb, tab) => wb.changePageSize(tab, 100), offset: 0, size: 100 }
]

for (const size of pageSizes) {
  await check(`page_size_${size}_commits_only_after_cursor_fetch_succeeds`, async () => {
    const { wb, tab, backend, calls } = fixture(400)
    tab.pageSize = size === 200 ? 100 : 200
    tab.appliedFilter = 'id >= 1'
    tab.selectedRows.add(400)
    const before = pageSnapshot(tab)
    const held = holdBackend(backend, 'fetchResultPage')
    const pending = wb.changePageSize(tab, size)
    try {
      await waitForBackend(held)
      assertPageSnapshot(tab, before)
      assert.equal(tab.busy, true)
      assert.equal(wb.locks.has('a'), true)
      assert.deepEqual(calls.fetches, [{ cursor: before.cursor, offset: 0, limit: size }])
      assert.deepEqual(calls.queries, [])
      assert.deepEqual(calls.closed, [])
      held.resolve()
      await pending
      assert.equal(tab.result, before.result)
      assert.notEqual(tab.page, before.page)
      assert.equal(tab.page.offset, 0)
      assert.equal(tab.page.returned, Math.min(size, 805))
      assert.equal(tab.page.rows.length, Math.min(size, 805))
      assert.equal(tab.pageSize, size)
      assert.equal(tab.appliedFilter, 'id >= 1')
      assert.equal(tab.selectedRows.size, 0)
      assertIdle(wb, tab)
    } finally { held.resolve(); await pending.catch(() => {}) }
  })

  await check(`page_navigation_${size}_uses_current_size_for_step_and_limit`, async () => {
    const { wb, tab, page, calls } = fixture(0, { totalRows: 3205 })
    tab.pageSize = size
    tab.result = tab.page = page(0, size)
    const cursor = tab.result.cursorId
    await wb.pageTab(tab, 1)
    assert.equal(tab.page.offset, size)
    assert.equal(tab.page.rows.length, size)
    await wb.pageTab(tab, -1)
    assert.equal(tab.page.offset, 0)
    assert.deepEqual(calls.fetches, [
      { cursor, offset: size, limit: size }, { cursor, offset: 0, limit: size }
    ])
    assert.equal(tab.pageSize, size)
    assert.deepEqual(calls.queries, [])
    assertIdle(wb, tab)
  })
}

await check('legacy_result_defaults_to_200_rows_and_empty_applied_filter', async () => {
  const { wb, tab, calls } = fixture()
  assert.equal(tab.pageSize, undefined)
  assert.equal(tab.appliedFilter, undefined)
  const cursor = tab.result.cursorId
  await wb.pageTab(tab, 1)
  assert.deepEqual(calls.fetches, [{ cursor, offset: 200, limit: 200 }])
  assert.equal(tab.page.offset, 200)
  assert.equal(tab.pageSize ?? 200, 200)
  assert.equal(tab.appliedFilter ?? '', '')
  await wb.reloadTab(tab)
  await wb.transformTab(tab)
  assert.deepEqual(calls.queries.map(({ options }) => options.limit), [200, 200])
  assert.equal(tab.appliedFilter, '')
  assert.equal(tab.querySql, tab.sql)
})

for (const size of [0, -100, 1, 199, 201, 500.5, 1001, NaN, Infinity, '200', null, undefined]) {
  await check(`page_size_rejects_${typeof size}_${String(size)}_before_dirty_guard`, async () => {
    const { wb, tab, calls } = fixture(400)
    wb.stageCell(tab, tab.page.rows[0], 'body', text('keep-local-draft'))
    tab.selectedRows.add(400)
    const before = pageSnapshot(tab)
    await rejectsWithoutDecision(() => wb.changePageSize(tab, size))
    assertPageSnapshot(tab, before)
    assert.equal(tab.dirty.size, 1)
    assertNoBackendWork(calls)
    assertIdle(wb, tab)
  })
}

for (const explicitSize of [false, true]) {
  await check(`same_page_size_${explicitSize ? 'explicit' : 'default'}_is_a_noop_even_when_dirty`, async () => {
    const { wb, tab, calls } = fixture(400)
    if (explicitSize) tab.pageSize = 500
    wb.stageCell(tab, tab.page.rows[0], 'body', text('keep-local-draft'))
    const before = pageSnapshot(tab)
    const pending = wb.changePageSize(tab, explicitSize ? 500 : 200)
    const asked = Boolean(decision.value)
    if (asked) finishDecision('cancel')
    await pending
    assert.equal(asked, false)
    assertPageSnapshot(tab, before)
    assert.equal(tab.dirty.size, 1)
    assertNoBackendWork(calls)
    assertIdle(wb, tab)
  })
}

for (const operation of navigation) {
  await check(`${operation.name}_without_cursor_is_a_noop_before_dirty_guard`, async () => {
    const { wb, tab, calls } = fixture(400)
    tab.result.cursorId = undefined
    wb.stageCell(tab, tab.page.rows[0], 'body', text('keep-local-draft'))
    tab.selectedRows.add(400)
    const before = pageSnapshot(tab)
    const pending = operation.invoke(wb, tab)
    const asked = Boolean(decision.value)
    if (asked) finishDecision('cancel')
    await pending
    assert.equal(asked, false)
    assertPageSnapshot(tab, before)
    assert.equal(tab.dirty.size, 1)
    assertNoBackendWork(calls)
    assertIdle(wb, tab)
  })
}

await check('page_navigation_respects_first_last_pages_and_rejects_invalid_directions', async () => {
  const { wb, tab, page, calls } = fixture()
  const first = pageSnapshot(tab)
  await wb.pageTab(tab, -1)
  assertPageSnapshot(tab, first)
  tab.page = page(800)
  const last = pageSnapshot(tab)
  await wb.pageTab(tab, 1)
  assertPageSnapshot(tab, last)
  for (const direction of [0, 2, -2, NaN, '1']) {
    await assert.rejects(wb.pageTab(tab, direction))
    assertPageSnapshot(tab, last)
  }
  assertNoBackendWork(calls)
  assertIdle(wb, tab)
})

for (const connectionId of ['a', 'b']) {
  await check(`page_size_and_position_are_isolated_from_other_tab_on_${connectionId}`, async () => {
    const f = fixture(400)
    const { wb, tab, calls } = f
    const other = addResultTab(f, connectionId, 500)
    other.filter = 'id > 5'
    other.appliedFilter = 'id > 1'
    other.selectedRows.add(0)
    wb.stageCell(other, other.page.rows[0], 'body', text('other-tab-draft'))
    const before = pageSnapshot(other)
    await wb.changePageSize(tab, 100)
    await wb.pageTab(tab, 1)
    assert.equal(tab.page.offset, 100)
    assert.equal(tab.pageSize, 100)
    assertPageSnapshot(other, before)
    assert.equal(other.filter, 'id > 5')
    assert.equal(other.appliedFilter, 'id > 1')
    assert.equal(other.dirty.size, 1)
    assert.deepEqual(calls.fetches.map(({ offset, limit }) => [offset, limit]), [[0, 100], [100, 100]])
    assert.deepEqual(calls.queries, [])
  })
}

for (const operation of navigation) {
  for (const choice of ['cancel', 'discard', 'apply']) {
    await check(`dirty_${choice}_${operation.name}_guards_before_fetch_and_uses_current_cursor`, async () => {
      const { wb, tab, calls, values } = fixture(400)
      tab.pageSize = 200
      tab.selectedRows.add(400)
      wb.stageCell(tab, tab.page.rows[0], 'body', text('applied-row-401'))
      const before = pageSnapshot(tab)
      const pending = operation.invoke(wb, tab)
      try {
        assertPageSnapshot(tab, before)
        assertNoBackendWork(calls)
        assert.equal(wb.locks.has('a'), true)
        finishDecision(choice)
        await pending
        if (choice === 'cancel') {
          assertPageSnapshot(tab, before)
          assert.equal(tab.dirty.size, 1)
          assertNoBackendWork(calls)
        } else {
          assert.equal(tab.page.offset, operation.offset)
          assert.equal(tab.pageSize, operation.size)
          assert.equal(tab.dirty.size, 0)
          assert.equal(tab.selectedRows.size, 0)
          assert.deepEqual(calls.fetches, [{ cursor: tab.result.cursorId, offset: operation.offset, limit: operation.size }])
          if (choice === 'apply') {
            assert.notEqual(tab.result.cursorId, before.cursor, 'fetch must use the cursor produced by applying drafts')
            assert.equal(values.get(401), 'applied-row-401')
            assert.equal(calls.applies, 1)
            assert.deepEqual(calls.queries.map(({ options }) => [options.offset, options.limit]), [[400, 200]])
            assert.ok(calls.closed.includes(before.cursor))
          } else {
            assert.equal(tab.result, before.result)
            assert.equal(calls.applies, 0)
            assert.deepEqual(calls.queries, [])
            assert.equal(values.size, 0)
          }
        }
        assertIdle(wb, tab)
      } finally {
        if (decision.value) finishDecision('cancel')
        await pending.catch(() => {})
      }
    })
  }

  await check(`failed_${operation.name}_retains_page_size_and_selection_then_can_retry`, async () => {
    const { wb, tab, backend, calls } = fixture(400)
    tab.pageSize = 200
    tab.selectedRows.add(400)
    const before = pageSnapshot(tab)
    const originalFetch = backend.fetchResultPage
    backend.fetchResultPage = async (...args) => {
      await originalFetch(...args)
      throw new Error('SYNTHETIC_PAGE_FAILED')
    }
    await assert.rejects(operation.invoke(wb, tab), /SYNTHETIC_PAGE_FAILED/)
    assertPageSnapshot(tab, before)
    assertIdle(wb, tab)
    backend.fetchResultPage = originalFetch
    await operation.invoke(wb, tab)
    assert.deepEqual(calls.fetches, Array.from({ length: 2 }, () => ({ cursor: before.cursor, offset: operation.offset, limit: operation.size })))
    assert.equal(tab.page.offset, operation.offset)
    assert.equal(tab.pageSize, operation.size)
    assert.equal(tab.selectedRows.size, 0)
    assert.deepEqual(calls.queries, [])
    assert.equal(calls.applies, 0)
    assertIdle(wb, tab)
  })
}

await check('dirty_apply_failed_size_change_keeps_fresh_page_and_previous_size', async () => {
  const { wb, tab, backend, calls } = fixture(400)
  tab.pageSize = 200
  const oldCursor = tab.result.cursorId
  wb.stageCell(tab, tab.page.rows[0], 'body', text('applied-row-401'))
  const originalFetch = backend.fetchResultPage
  backend.fetchResultPage = async (...args) => {
    await originalFetch(...args)
    throw new Error('SYNTHETIC_SIZE_FAILED')
  }
  const pending = wb.changePageSize(tab, 500)
  finishDecision('apply')
  await assert.rejects(pending, /SYNTHETIC_SIZE_FAILED/)
  assert.notEqual(tab.result.cursorId, oldCursor)
  assert.equal(tab.page.offset, 400)
  assert.equal(tab.page.rows[0].cells[1].text, 'applied-row-401')
  assert.equal(tab.pageSize, 200)
  assert.equal(tab.dirty.size, 0)
  assert.equal(wb.transactions.a.active, true)
  assertIdle(wb, tab)
  backend.fetchResultPage = originalFetch
  await wb.changePageSize(tab, 500)
  assert.deepEqual(calls.fetches, Array.from({ length: 2 }, () => ({ cursor: tab.result.cursorId, offset: 0, limit: 500 })))
  assert.equal(calls.applies, 1)
  assert.equal(calls.queries.length, 1)
  assert.equal(tab.pageSize, 500)
  assert.equal(tab.page.offset, 0)
})

const staleChanges = [
  ['result', ({ tab }) => { tab.result = { ...tab.result } }],
  ['page', ({ tab }) => { tab.page = { ...tab.page } }],
  ['generation', ({ tab }) => { tab.generation++ }],
  ['cursor', ({ tab }) => { tab.result.cursorId = 'connection:a|cursor:replacement' }],
  ['removed', ({ wb, tab }) => { wb.tabs.value.splice(wb.tabs.value.indexOf(tab), 1) }],
  ['invalidated', ({ tab }) => { tab.invalidated = true }],
  ['size', ({ tab }) => { tab.pageSize = 500 }]
]
for (const operation of navigation) {
  for (const [changed, mutate] of staleChanges) {
    await check(`late_${operation.name}_response_is_discarded_after_${changed}_changes`, async () => {
      const f = fixture(400)
      const { wb, tab, backend, calls } = f
      tab.pageSize = 200
      const cursor = tab.result.cursorId
      const held = holdBackend(backend, 'fetchResultPage')
      const pending = operation.invoke(wb, tab)
      try {
        await waitForBackend(held)
        mutate(f)
        tab.selectedRows.add(401)
        const current = pageSnapshot(tab)
        held.resolve()
        await pending
        assertPageSnapshot(tab, current)
        assert.equal(wb.tabs.value.includes(tab), changed !== 'removed')
        assert.deepEqual(calls.fetches, [{ cursor, offset: operation.offset, limit: operation.size }])
        assert.deepEqual(calls.queries, [])
        assertIdle(wb, tab)
      } finally { held.resolve(); await pending.catch(() => {}) }
    })
  }

  await check(`pending_${operation.name}_locks_same_connection_and_allows_other_connection`, async () => {
    const f = fixture(400)
    const { wb, tab, backend, calls } = f
    const other = addResultTab(f, 'a', 500)
    const remote = addResultTab(f, 'b', 100)
    const before = pageSnapshot(other)
    const held = holdBackend(backend, 'fetchResultPage')
    const pending = operation.invoke(wb, tab)
    try {
      await waitForBackend(held)
      assert.equal(wb.locks.has('a'), true)
      for (const target of [tab, other]) {
        await assert.rejects(wb.pageTab(target, 1))
        await assert.rejects(wb.changePageSize(target, 1000))
        await assert.rejects(wb.reloadTab(target))
        await assert.rejects(wb.transformTab(target))
      }
      assertPageSnapshot(other, before)
      assert.equal(calls.fetches.length, 1)
      assert.deepEqual(calls.queries, [])
      await wb.reloadTab(remote)
      assert.equal(calls.queries.length, 1)
      assert.equal(calls.queries[0].node, 'connection:b')
      assert.equal(calls.queries[0].options.limit, 100)
      assert.equal(wb.locks.has('a'), true)
      assertIdle(wb, remote)
      held.resolve()
      await pending
      assertIdle(wb, tab)
    } finally { held.resolve(); await pending.catch(() => {}) }
  })
}

for (const operation of [
  ...navigation,
  { name: 'reload', invoke: (wb, tab) => wb.reloadTab(tab) },
  { name: 'filter', invoke: (wb, tab) => wb.transformTab(tab) }
]) {
  await check(`pending_cell_editor_blocks_${operation.name}_before_dirty_guard_and_backend`, async () => {
    const { wb, tab, calls } = fixture(400)
    tab.filter = 'id > 1'
    wb.stageCell(tab, tab.page.rows[0], 'body', text('keep-local-draft'))
    wb.pendingEditors.add(tab.id)
    const before = pageSnapshot(tab)
    await rejectsWithoutDecision(() => operation.invoke(wb, tab), /编辑|保存|取消/)
    assertPageSnapshot(tab, before)
    assert.equal(tab.dirty.size, 1)
    assert.equal(wb.pendingEditors.has(tab.id), true)
    assertNoBackendWork(calls)
    assertIdle(wb, tab)
  })
}

await check('internal_reload_without_guard_is_allowed_with_a_pending_editor', async () => {
  const { wb, tab, calls } = fixture(400)
  tab.pageSize = 500
  wb.pendingEditors.add(tab.id)
  await wb.reloadTab(tab, false)
  assert.equal(calls.queries.length, 1)
  assert.equal(calls.queries[0].options.limit, 500)
  assert.equal(tab.page.offset, 0)
  assert.equal(tab.page.rows.length, 500)
  assert.equal(tab.pageSize, 500)
  assertIdle(wb, tab)
})

for (const size of pageSizes) {
  for (const operation of ['reload', 'filter']) {
    await check(`${operation}_query_inherits_page_size_${size}`, async () => {
      const { wb, tab, calls } = fixture(400)
      tab.pageSize = size
      const oldResult = tab.result
      if (operation === 'filter') {
        tab.filter = 'id >= 1'
        await wb.transformTab(tab, [{ column: 'body', direction: 'DESC' }])
        assert.match(calls.queries[0].sql, /WHERE "id" >= 1/)
        assert.match(calls.queries[0].sql, /ORDER BY "body" DESC$/)
        assert.equal(tab.appliedFilter, 'id >= 1')
        assert.equal(tab.querySql, calls.queries[0].sql)
      } else {
        await wb.reloadTab(tab)
        assert.equal(calls.queries[0].sql, tab.querySql)
      }
      assert.equal(calls.queries.length, 1)
      assert.equal(calls.queries[0].node, 'connection:a')
      assert.equal(calls.queries[0].options.limit, size)
      assert.equal(calls.queries[0].options.offset, 0)
      assert.equal(calls.queries[0].options.keepCursor, true)
      assert.deepEqual(calls.fetches, [])
      assert.notEqual(tab.result, oldResult)
      assert.equal(tab.page.offset, 0)
      assert.equal(tab.page.returned, Math.min(size, 805))
      assert.equal(tab.pageSize, size)
      assertIdle(wb, tab)
    })
  }
}

await check('failed_filter_keeps_applied_filter_query_order_and_old_page', async () => {
  const { wb, tab, backend, calls } = fixture(400)
  tab.pageSize = 500
  tab.appliedFilter = 'id > 10'
  tab.querySql = `SELECT * FROM (${tab.sql}) _dbstudio_filter WHERE "id" > 10 ORDER BY "id" ASC`
  tab.order = [{ column: 'id', direction: 'ASC' }]
  tab.filter = 'id > 20'
  tab.selectedRows.add(400)
  const before = pageSnapshot(tab)
  const oldQuery = tab.querySql
  const oldOrder = tab.order
  const originalQuery = backend.runQuery
  backend.runQuery = async (...args) => {
    await originalQuery(...args)
    throw new Error('SYNTHETIC_FILTER_FAILED')
  }
  await assert.rejects(wb.transformTab(tab, [{ column: 'body', direction: 'DESC' }]), /SYNTHETIC_FILTER_FAILED/)
  assert.equal(tab.result, before.result)
  assert.equal(tab.page, before.page)
  assert.equal(tab.page.offset, 400)
  assert.equal(tab.pageSize, before.pageSize)
  assert.deepEqual([...tab.selectedRows], before.selectedRows)
  assert.equal(tab.appliedFilter, 'id > 10')
  assert.equal(tab.filter, 'id > 20')
  assert.equal(tab.querySql, oldQuery)
  assert.equal(tab.order, oldOrder)
  assert.equal(calls.queries.length, 1)
  assert.equal(calls.queries[0].options.limit, 500)
  assert.deepEqual(calls.closed, [])
  assertIdle(wb, tab)
})

for (const [name, filter] of [
  ['missing_value', 'id >'],
  ['trailing_and', 'id > 1 AND'],
  ['unclosed_quote', "body = 'unterminated"]
]) {
  await check(`invalid_filter_${name}_cannot_prompt_discard_or_apply_dirty_rows`, async () => {
    const { wb, tab, calls } = fixture(400)
    tab.appliedFilter = 'id > 10'
    tab.filter = filter
    wb.stageCell(tab, tab.page.rows[0], 'body', text('keep-local-draft'))
    const before = pageSnapshot(tab)
    const oldQuery = tab.querySql
    await rejectsWithoutDecision(() => wb.transformTab(tab))
    assertPageSnapshot(tab, before)
    assert.equal(tab.dirty.size, 1)
    assert.equal(tab.appliedFilter, 'id > 10')
    assert.equal(tab.filter, filter)
    assert.equal(tab.querySql, oldQuery)
    assertNoBackendWork(calls)
    assertIdle(wb, tab)
  })
}

await check('filter_sql_generation_failure_precedes_dirty_guard_and_backend', async () => {
  const { wb, tab, calls } = fixture(400)
  wb.dialects.value = []
  tab.filter = 'id > 1'
  wb.stageCell(tab, tab.page.rows[0], 'body', text('keep-local-draft'))
  const before = pageSnapshot(tab)
  await rejectsWithoutDecision(() => wb.transformTab(tab), /缺少方言引用规则/)
  assertPageSnapshot(tab, before)
  assert.equal(tab.dirty.size, 1)
  assertNoBackendWork(calls)
  assertIdle(wb, tab)
})

await check('cancelled_filter_keeps_applied_filter_and_old_page_without_query', async () => {
  const { wb, tab, calls } = fixture(400)
  tab.pageSize = 500
  tab.appliedFilter = 'id > 10'
  tab.filter = 'id > 20'
  wb.stageCell(tab, tab.page.rows[0], 'body', text('keep-local-draft'))
  const before = pageSnapshot(tab)
  const oldQuery = tab.querySql
  const pending = wb.transformTab(tab)
  finishDecision('cancel')
  await pending
  assertPageSnapshot(tab, before)
  assert.equal(tab.appliedFilter, 'id > 10')
  assert.equal(tab.filter, 'id > 20')
  assert.equal(tab.querySql, oldQuery)
  assert.equal(tab.dirty.size, 1)
  assertNoBackendWork(calls)
  assertIdle(wb, tab)
})

for (const waitAt of ['guard', 'query']) {
  await check(`successful_filter_uses_submitted_snapshot_when_draft_changes_during_${waitAt}`, async () => {
    const { wb, tab, backend, calls } = fixture(400)
    tab.pageSize = 500
    tab.appliedFilter = 'id >= 1'
    tab.filter = 'id > 10'
    if (waitAt === 'guard') wb.stageCell(tab, tab.page.rows[0], 'body', text('discard-this-draft'))
    const before = pageSnapshot(tab)
    const held = holdBackend(backend, 'runQuery')
    const pending = wb.transformTab(tab)
    try {
      if (waitAt === 'guard') {
        assertPageSnapshot(tab, before)
        assertNoBackendWork(calls)
        tab.filter = 'id < 5'
        finishDecision('discard')
      }
      await waitForBackend(held)
      assert.equal(tab.appliedFilter, 'id >= 1', 'applied filter changes only after query success')
      assert.equal(tab.page, before.page)
      tab.filter = 'id = 7'
      assert.equal(calls.queries.length, 1)
      assert.match(calls.queries[0].sql, /WHERE "id" > 10/)
      assert.equal(calls.queries[0].options.limit, 500)
      held.resolve()
      await pending
      assert.equal(tab.appliedFilter, 'id > 10')
      assert.equal(tab.filter, 'id = 7')
      assert.equal(tab.querySql, calls.queries[0].sql)
      assert.equal(tab.page.offset, 0)
      assert.equal(tab.pageSize, 500)
      assert.notEqual(tab.page, before.page)
      assert.equal(calls.applies, 0)
      assertIdle(wb, tab)
    } finally {
      if (decision.value) finishDecision('cancel')
      held.resolve()
      await pending.catch(() => {})
    }
  })
}

await check('clearing_filter_commits_empty_applied_filter_and_restores_base_sql', async () => {
  const { wb, tab, calls } = fixture(400)
  tab.pageSize = 100
  tab.appliedFilter = 'id > 10'
  tab.querySql = `SELECT * FROM (${tab.sql}) _dbstudio_filter WHERE "id" > 10`
  tab.filter = ''
  await wb.transformTab(tab)
  assert.equal(tab.appliedFilter, '')
  assert.equal(tab.querySql, tab.sql)
  assert.equal(tab.page.offset, 0)
  assert.equal(tab.pageSize, 100)
  assert.equal(calls.queries[0].sql, tab.sql)
  assert.equal(calls.queries[0].options.limit, 100)
})

const failed = outcomes.filter((item) => !item.passed).length
writeFileSync(join(output, 'results.json'), JSON.stringify({ scope: 'real-workbench-pure-memory-ipc', native_or_gui_pass: false, outcomes }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(`SQL workflow regression checks: ${outcomes.length - failed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
// Unique synthetic build and results remain available. No cleanup/deletion operation.
