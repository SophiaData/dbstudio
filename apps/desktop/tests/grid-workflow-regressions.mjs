import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { webcrypto } from 'node:crypto'
import { createRenderer, h, proxyRefs, reactive } from 'vue'

// Actual component script + workbench/backend proxy, with an in-memory IPC boundary.
// The renderer has no DOM: these are controller/lifecycle regressions, not GUI/native tests.
const project = fileURLToPath(new URL('../../../', import.meta.url))
const args = process.argv.slice(2)
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--output-parent'), 'only --output-parent is accepted')
const outputParent = args.length ? path.resolve(project, args[1]) : tmpdir()
const output = await mkdtemp(path.join(outputParent, 'grid-workflow-'))
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite'))('esbuild')
const { parse, compileScript } = createRequire(require.resolve('vue'))('@vue/compiler-sfc')
const vueEntry = fileURLToPath(import.meta.resolve('vue'))
const memoryStorage = new Map()
globalThis.crypto ??= webcrypto
globalThis.localStorage = {
  getItem: (key) => memoryStorage.get(key) ?? null,
  setItem: (key, value) => memoryStorage.set(key, value)
}
let nativeMethods
const ipcCalls = []
globalThis.__DBSTUDIO_GRID_IPC__ = async (command, payload) => {
  assert.equal(command, 'backend_call')
  assert.ok(nativeMethods?.[payload.method], `unexpected memory IPC method: ${payload.method}`)
  ipcCalls.push(payload.method)
  return nativeMethods[payload.method](...payload.args)
}
const bundle = await build({
  stdin: {
    sourcefile: 'grid-workflow-memory-entry.ts', resolveDir: project,
    contents: "export { useWorkbench } from './apps/desktop/src/workbench.ts'; export { decision } from './apps/desktop/src/dialogs.ts'; export { default as Grid } from './apps/desktop/src/components/ResultGrid.vue'"
  },
  outfile: path.join(output, 'controller.mjs'), write: false, bundle: true, format: 'esm', platform: 'node',
  plugins: [{ name: 'grid-workflow-memory-only', setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: vueEntry, external: true }))
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'native-memory-ipc', namespace: 'grid-memory-ipc' }))
    builder.onLoad({ filter: /.*/, namespace: 'grid-memory-ipc' }, () => ({ contents: 'export const invoke = (...args) => globalThis.__DBSTUDIO_GRID_IPC__(...args)' }))
    builder.onLoad({ filter: /apps\/desktop\/src\/clipboard\.ts$/ }, () => ({ contents: "export const writeClipboardText = async () => { throw new Error('OS clipboard forbidden in pure grid regressions') }" }))
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      if (!filename.endsWith('/components/ResultGrid.vue')) return { contents: 'export default {}' }
      const { descriptor } = parse(await readFile(filename, 'utf8'), { filename })
      return { loader: 'ts', contents: compileScript(descriptor, { id: 'grid-workflow-memory' }).content }
    })
  } }]
})
const controllerPath = path.join(output, 'controller.mjs')
await writeFile(controllerPath, bundle.outputFiles[0].text, { flag: 'wx' })
const { Grid, useWorkbench, decision } = await import(pathToFileURL(controllerPath).href)
const renderer = createRenderer({
  insert() {}, remove() {}, patchProp() {},
  createElement: (tag) => ({ tag }), createText: (text) => ({ text }), createComment: (text) => ({ text }),
  setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null
})
const text = (value) => ({ kind: 'text', text: value })
const truncated = (value) => ({ kind: 'text', text: value, truncated: true, fullLength: 1200 })
function defer() {
  let resolve, reject
  let settled = false
  const promise = new Promise((yes, no) => {
    resolve = (value) => { settled = true; yes(value) }
    reject = (error) => { settled = true; no(error) }
  })
  return { promise, resolve, reject, get settled() { return settled } }
}
function fixture() {
  const wb = useWorkbench()
  wb.connections.value = [{ id: 'A', name: 'synthetic-A', dialectId: 'sqlite', connected: true, capabilities: { supportsInlineEdit: true } }]
  wb.dialects.value = [{ id: 'sqlite', quoting: { open: '"', close: '"', escape: 'double' } }]
  wb.selectConnection('A')
  const columns = [{ name: 'id', type: 'integer' }, { name: 'body', type: 'text' }, { name: 'note', type: 'text' }, { name: 'omitted', type: 'text' }]
  const rows = [
    { index: 0, cells: [{ kind: 'number', value: 1 }, truncated('first-preview'), text('note-1'), { kind: 'null' }] },
    { index: 1, cells: [{ kind: 'number', value: 2 }, text('second-original'), text('note-2'), { kind: 'null' }] }
  ]
  let cursor = 0
  const makePage = (offset = 0) => ({ columns, rows: offset ? [{ index: offset, cells: [{ kind: 'number', value: offset + 1 }, text('new-page'), text('new-note'), { kind: 'null' }] }] : rows, offset, returned: offset ? 1 : 2, hasMore: !offset, cursorId: `synthetic-cursor-${++cursor}`, elapsedMs: 0, executedSql: 'SELECT id,body,note,omitted FROM synthetic' })
  const initial = makePage()
  const tab = reactive({
    id: 'tab-A', connectionId: 'A', title: 'synthetic', table: { id: 'connection:A|table:synthetic', name: 'synthetic', kind: 'table' },
    description: { hasUniqueKey: true, columns: columns.map((column, index) => ({ name: column.name, typeName: index ? 'TEXT' : 'INTEGER', primaryKeyOrdinal: index ? null : 1, nullable: index !== 0, requiredOnInsert: index === 0 })) },
    sql: initial.executedSql, querySql: initial.executedSql, parameters: [], result: initial, page: initial,
    message: '', busy: false, invalidated: false, dirty: new Map(), selectedRows: new Set(), filter: '', order: null, generation: 0
  })
  wb.tabs.value.push(tab); wb.activateTab(tab)
  const inserted = []
  let transactionActive = false
  nativeMethods = {
    transactionState: async () => ({ active: transactionActive, pendingAffected: inserted.length }),
    runQuery: async () => makePage(), closeCursor: async () => null,
    insertRow: async (_node, values) => { inserted.push(values); transactionActive = true; return { affected: 1 } }
  }
  let bindings
  const component = { ...Grid, setup(props, context) { bindings = Grid.setup(props, context); return bindings }, render: () => null }
  const root = {}
  const vnode = h(component, { workbench: wb, tab })
  renderer.render(vnode, root)
  const grid = proxyRefs(vnode.component.exposed)
  const deferred = [], inFlight = []
  let unmounted = false
  return {
    wb, tab, rows, makePage, inserted, grid, get bindings() { return bindings },
    deferCell() { const request = defer(); deferred.push(request); nativeMethods.fetchCellValue = () => request.promise; return request },
    open(row = rows[0]) { const pending = grid.openCell(row, 1); inFlight.push(pending); return pending },
    unmount() { if (!unmounted) { renderer.render(null, root); unmounted = true } },
    async finish() {
      if (decision.value) decision.value.settle('cancel')
      for (const request of deferred) if (!request.settled) request.resolve(text('synthetic-finish'))
      await Promise.allSettled(inFlight)
      this.unmount()
      assert.equal(wb.pendingEditors.size, 0)
    }
  }
}
const results = []
async function test(name, run) {
  const context = fixture()
  try { await run(context); results.push({ name, passed: true }) }
  catch (error) { results.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }) }
  finally { await context.finish() }
}

await test('late_success_preserves_new_editor_draft_without_table_busy', async (f) => {
  const request = f.deferCell(), first = f.open()
  assert.equal(f.tab.busy, false)
  assert.equal(f.wb.locks.size, 0)
  await f.open(f.rows[1]); f.grid.editing.raw = 'second-unsaved-draft'
  request.resolve(text('F'.repeat(1200))); await first
  assert.equal(f.grid.editing.row.index, 1)
  assert.equal(f.grid.editing.raw, 'second-unsaved-draft')
  assert.equal(f.grid.error, '')
})
await test('late_error_does_not_replace_new_editor_error', async (f) => {
  const request = f.deferCell(), first = f.open()
  await f.open(f.rows[1]); f.grid.editing.raw = 'second-draft'; f.grid.error = 'current-editor-message'
  request.reject(new Error('stale-first-read-error')); await first
  assert.equal(f.grid.editing.raw, 'second-draft')
  assert.equal(f.grid.error, 'current-editor-message')
})
await test('two_full_reads_keep_latest_editor_when_resolved_backwards', async (f) => {
  const firstRequest = f.deferCell(), first = f.open()
  f.rows[1].cells[1] = truncated('second-preview')
  const secondRequest = f.deferCell(), second = f.open(f.rows[1])
  secondRequest.resolve(text('second-full')); await second
  f.grid.editing.raw = 'newer-user-draft'
  firstRequest.resolve(text('first-full')); await first
  assert.equal(f.grid.editing.row.index, 1)
  assert.equal(f.grid.editing.raw, 'newer-user-draft')
})
await test('late_success_ignored_after_new_page', async (f) => {
  const request = f.deferCell(), opening = f.open()
  f.tab.page = f.makePage(200)
  request.resolve(text('stale-full')); await opening
  assert.equal(f.grid.editing, null)
  assert.equal(f.wb.pendingEditors.size, 0)
})
await test('late_error_ignored_after_generation_change', async (f) => {
  const request = f.deferCell(), opening = f.open()
  f.tab.generation++
  request.reject(new Error('stale-generation-error')); await opening
  assert.equal(f.grid.editing, null)
  assert.equal(f.grid.error, '')
})
await test('late_error_ignored_after_new_page', async (f) => {
  const request = f.deferCell(), opening = f.open()
  f.tab.page = f.makePage(200)
  request.reject(new Error('stale-page-error')); await opening
  assert.equal(f.grid.editing, null)
  assert.equal(f.grid.error, '')
})
await test('late_success_ignored_after_generation_change', async (f) => {
  const request = f.deferCell(), opening = f.open()
  f.tab.generation++
  request.resolve(text('stale-generation-full')); await opening
  assert.equal(f.grid.editing, null)
})
await test('current_full_read_error_remains_visible', async (f) => {
  const request = f.deferCell(), opening = f.open()
  request.reject(new Error('current-full-read-error')); await opening
  assert.equal(f.grid.editing, null)
  assert.equal(f.grid.error, 'current-full-read-error')
})
await test('late_success_ignored_after_cursor_result_change', async (f) => {
  const request = f.deferCell(), opening = f.open()
  f.tab.result = { ...f.tab.result, cursorId: 'replacement-cursor' }
  request.resolve(text('stale-cursor-full')); await opening
  assert.equal(f.grid.editing, null)
})
await test('late_error_ignored_after_invalidation', async (f) => {
  const request = f.deferCell(), opening = f.open()
  f.tab.invalidated = true
  request.reject(new Error('invalidated-read-error')); await opening
  assert.equal(f.grid.editing, null)
  assert.equal(f.grid.error, '')
})
await test('late_success_cannot_reopen_after_unmount', async (f) => {
  const request = f.deferCell(), opening = f.open()
  f.unmount()
  request.resolve(text('unmounted-full')); await opening
  assert.equal(f.grid.editing, null)
  assert.equal(f.wb.pendingEditors.size, 0)
})
await test('late_error_ignored_after_unmount', async (f) => {
  const request = f.deferCell(), opening = f.open()
  f.unmount()
  request.reject(new Error('unmounted-error')); await opening
  assert.equal(f.grid.error, '')
  assert.equal(f.wb.pendingEditors.size, 0)
})
await test('begin_insert_invalidates_pending_cell_success', async (f) => {
  const request = f.deferCell(), opening = f.open()
  f.grid.beginInsert(); f.bindings.insertValues.body = 'insert-draft'
  request.resolve(text('old-cell-full')); await opening
  assert.equal(f.grid.editing, null)
  assert.equal(f.bindings.insertOpen.value, true)
  assert.equal(f.bindings.insertValues.body, 'insert-draft')
})
await test('begin_insert_invalidates_pending_cell_error', async (f) => {
  const request = f.deferCell(), opening = f.open()
  f.grid.beginInsert(); f.grid.error = 'insert-current-message'
  request.reject(new Error('old-cell-error')); await opening
  assert.equal(f.grid.editing, null)
  assert.equal(f.grid.error, 'insert-current-message')
})
function fillInsert(f) {
  f.grid.beginInsert()
  Object.assign(f.bindings.insertValues, { id: '9', body: '新增中文\n草稿', note: '取消NULL后仍保留的文本', omitted: 'not-included' })
  f.bindings.insertInclude.add('body'); f.bindings.insertInclude.add('note')
  f.bindings.insertNulls.add('note')
}
function insertSnapshot(f) {
  return { values: { ...f.bindings.insertValues }, include: [...f.bindings.insertInclude].sort(), nulls: [...f.bindings.insertNulls].sort() }
}
await test('cancel_dirty_guard_preserves_insert_values_include_and_nulls', async (f) => {
  f.wb.stageCell(f.tab, f.rows[1], 'body', text('existing-local-change'))
  fillInsert(f)
  const before = insertSnapshot(f)
  const submitting = f.grid.submitInsert()
  assert.equal(decision.value?.title, '插入行')
  decision.value.settle('cancel'); await submitting
  assert.equal(f.inserted.length, 0)
  assert.equal(f.tab.dirty.size, 1)
  assert.equal(f.bindings.insertOpen.value, true)
  assert.deepEqual(insertSnapshot(f), before)
  assert.equal(f.wb.pendingEditors.has(f.tab.id), true)
})
await test('successful_insert_true_closes_form_and_keeps_typed_values', async (f) => {
  f.wb.stageCell(f.tab, f.rows[1], 'body', text('existing-local-change'))
  fillInsert(f)
  const submitting = f.grid.submitInsert()
  assert.equal(decision.value?.title, '插入行')
  decision.value.settle('discard'); await submitting
  assert.equal(f.inserted.length, 1)
  assert.deepEqual(f.inserted[0], { id: { kind: 'number', value: 9 }, body: text('新增中文\n草稿'), note: { kind: 'null' } })
  assert.equal(f.bindings.insertOpen.value, false)
  assert.equal(f.wb.pendingEditors.has(f.tab.id), false)
})
await test('insert_error_preserves_form_and_all_input', async (f) => {
  fillInsert(f)
  const before = insertSnapshot(f)
  nativeMethods.insertRow = async () => { throw new Error('synthetic-insert-rejected') }
  await f.grid.submitInsert()
  assert.equal(f.bindings.insertOpen.value, true)
  assert.deepEqual(insertSnapshot(f), before)
  assert.equal(f.grid.error, 'synthetic-insert-rejected')
})

const mysqlDeadlock = 'MySQL操作失败(SQLSTATE 40001, code 1213)'
const rollbackNotice = '整个事务已回滚；本地草稿已保留。请处理草稿后刷新结果'
await test('apply_deadlock_reject_refreshes_transaction_and_preserves_draft', async (f) => {
  f.wb.connections.value[0].dialectId = 'mysql'
  f.wb.transactions.A = { active: true, pendingAffected: 1 }
  f.wb.stageCell(f.tab, f.rows[1], 'note', text('synthetic-local-draft'))
  const draft = JSON.stringify([...f.tab.dirty]), page = f.tab.page, result = f.tab.result, generation = f.tab.generation
  const original = Object.freeze({ code: 'driver-error', message: mysqlDeadlock })
  nativeMethods.applyEdits = async () => { throw original }
  nativeMethods.transactionState = async () => ({ active: false, pendingAffected: 0 })
  const start = ipcCalls.length
  let surfaced
  await f.wb.attempt(async () => {
    try { await f.wb.applyTab(f.tab) } catch (cause) { surfaced = cause; throw cause }
  })
  assert.equal(surfaced.code, 'driver-error')
  assert.equal(f.wb.statusError.value, true)
  assert.equal(f.wb.status.value, `${mysqlDeadlock}；${rollbackNotice}`)
  assert.deepEqual(f.wb.transactions.A, { active: false, pendingAffected: 0 })
  assert.equal(JSON.stringify([...f.tab.dirty]), draft)
  assert.equal(f.tab.page, page); assert.equal(f.tab.result, result); assert.equal(f.tab.generation, generation)
  assert.equal(f.tab.busy, false)
  assert.deepEqual(ipcCalls.slice(start), ['applyEdits', 'transactionState'])
})
await test('apply_reject_preserves_original_error_when_transaction_read_fails', async (f) => {
  f.wb.connections.value[0].dialectId = 'mysql'
  f.wb.transactions.A = { active: true, pendingAffected: 1 }
  f.wb.stageCell(f.tab, f.rows[1], 'note', text('synthetic-retry-draft'))
  const draft = JSON.stringify([...f.tab.dirty]), page = f.tab.page
  const original = Object.freeze({ code: 'driver-error', message: mysqlDeadlock })
  nativeMethods.applyEdits = async () => { throw original }
  nativeMethods.transactionState = async () => { throw new Error('synthetic-tx-read-failure') }
  const start = ipcCalls.length
  await assert.rejects(f.wb.applyTab(f.tab), (cause) => cause === original)
  assert.deepEqual(f.wb.transactions.A, { active: true, pendingAffected: 1 })
  assert.equal(JSON.stringify([...f.tab.dirty]), draft)
  assert.equal(f.tab.page, page); assert.equal(f.tab.busy, false)
  assert.deepEqual(ipcCalls.slice(start), ['applyEdits', 'transactionState'])
})
await test('apply_reject_does_not_infer_whole_rollback_without_exact_evidence', async (f) => {
  f.wb.stageCell(f.tab, f.rows[1], 'note', text('synthetic-preserved-draft'))
  const draft = JSON.stringify([...f.tab.dirty]), page = f.tab.page
  const cases = [
    { message: 'MySQL操作失败(SQLSTATE 23000, code 1062)', state: { active: true, pendingAffected: 1 } },
    { message: 'MySQL操作失败(SQLSTATE HY000, code 1205)', state: { active: true, pendingAffected: 1 } },
    { code: 'driver-failed', message: '数据库操作失败，请检查连接或查询配置', state: { active: false, pendingAffected: 0 } },
    { message: `${mysqlDeadlock} synthetic-extra`, state: { active: false, pendingAffected: 0 } },
    { message: mysqlDeadlock, before: false, state: { active: false, pendingAffected: 0 } },
    { message: mysqlDeadlock, state: { active: false, pendingAffected: 1 } },
    { message: mysqlDeadlock, state: { active: true, pendingAffected: 1 } },
    { dialect: 'sqlite', message: mysqlDeadlock, state: { active: false, pendingAffected: 0 } }
  ]
  for (const item of cases) {
    f.wb.connections.value[0].dialectId = item.dialect ?? 'mysql'
    f.wb.transactions.A = { active: item.before ?? true, pendingAffected: item.before === false ? 0 : 1 }
    const original = Object.freeze({ code: item.code ?? 'driver-error', message: item.message })
    nativeMethods.applyEdits = async () => { throw original }
    nativeMethods.transactionState = async () => ({ ...item.state })
    const start = ipcCalls.length
    await assert.rejects(f.wb.applyTab(f.tab), (cause) => cause === original)
    assert.deepEqual(f.wb.transactions.A, item.state)
    assert.equal(JSON.stringify([...f.tab.dirty]), draft)
    assert.equal(f.tab.page, page); assert.equal(f.tab.busy, false)
    assert.deepEqual(ipcCalls.slice(start), ['applyEdits', 'transactionState'])
  }
})
await test('partial_apply_failure_preserves_all_drafts_and_prior_transaction', async (f) => {
  f.wb.transactions.A = { active: true, pendingAffected: 2 }
  f.wb.stageCell(f.tab, f.rows[0], 'note', text('synthetic-successful-row-draft'))
  f.wb.stageCell(f.tab, f.rows[1], 'note', text('synthetic-failed-row-draft'))
  const draft = JSON.stringify([...f.tab.dirty]), page = f.tab.page
  const failure = 'MySQL操作失败(SQLSTATE 23000, code 1062)'
  nativeMethods.applyEdits = async () => ({ ok: false, affected: 1, inTransaction: true, outcomes: [
    { index: 0, affected: 1, error: null }, { index: 1, affected: 0, error: failure }
  ] })
  nativeMethods.transactionState = async () => ({ active: true, pendingAffected: 3 })
  const start = ipcCalls.length
  await assert.rejects(f.wb.applyTab(f.tab), (cause) => cause.message === failure)
  assert.deepEqual(f.wb.transactions.A, { active: true, pendingAffected: 3 })
  assert.equal(JSON.stringify([...f.tab.dirty]), draft)
  assert.equal(f.tab.dirty.size, 2); assert.equal(f.tab.page, page); assert.equal(f.tab.busy, false)
  assert.deepEqual(ipcCalls.slice(start), ['applyEdits', 'transactionState'])
})

const failed = results.filter((result) => !result.passed)
const summary = { scope: 'real-component-script-and-workbench-with-memory-ipc', mounted_gui: false, native_driver: false, total: results.length, passed: results.length - failed.length, failed: failed.length, cases: results, ipc_methods: [...new Set(ipcCalls)].sort() }
await writeFile(path.join(output, 'results.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ ...summary, output_directory: output }, null, 2))
if (failed.length) process.exitCode = 1
// Evidence directories are deliberately retained. No file/database cleanup is performed.
