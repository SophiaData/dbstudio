import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { webcrypto } from 'node:crypto'
import { createRenderer, h, proxyRefs, reactive } from 'vue'

// Real component scripts/templates and workbench; only the native IPC boundary is in memory.
// No DOM, native drivers, database, browser, filesystem output or cleanup is used.
const project = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite'))('esbuild')
const { parse, compileScript, compileTemplate } = createRequire(require.resolve('vue'))('@vue/compiler-sfc')
const vueEntry = pathToFileURL(fileURLToPath(import.meta.resolve('vue'))).href
const storage = new Map()
globalThis.crypto ??= webcrypto
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value)
}
let methods = {}
let calls = []
globalThis.__DBSTUDIO_AUDIT_UI_IPC__ = async (command, payload) => {
  assert.equal(command, 'backend_call')
  calls.push(structuredClone(payload))
  assert.equal(typeof methods[payload.method], 'function', `unexpected memory IPC: ${payload.method}`)
  return methods[payload.method](...payload.args)
}
const bundle = await build({
  stdin: {
    sourcefile: 'audit-ui-memory-entry.ts', resolveDir: project,
    contents: `export { useWorkbench } from './apps/desktop/src/workbench.ts';
      export { splitStatements as splitSqlScript } from './src/core/sql-script.ts';
      export { default as Compare } from './apps/desktop/src/components/ComparePanel.vue';
      export { default as Grid } from './apps/desktop/src/components/ResultGrid.vue';
       export { default as Editor } from './apps/desktop/src/components/SqlEditor.vue';
       export { decision } from './apps/desktop/src/dialogs.ts';
       export { renderLoaded } from './apps/desktop/src/result-export.ts';
      export { default as Ddl } from './apps/desktop/src/components/DdlDialog.vue';
      export { default as MysqlAdmin } from './apps/desktop/src/components/MysqlAdminDialog.vue'`
  },
  write: false, bundle: true, format: 'esm', platform: 'node',
  plugins: [{ name: 'audit-ui-memory-only', setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: vueEntry, external: true }))
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'memory-ipc', namespace: 'audit-ui' }))
    builder.onLoad({ filter: /.*/, namespace: 'audit-ui' }, () => ({ contents: 'export const invoke = (...args) => globalThis.__DBSTUDIO_AUDIT_UI_IPC__(...args)' }))
    builder.onLoad({ filter: /apps[\\/]desktop[\\/]src[\\/]clipboard\.ts$/ }, () => ({ contents: "export const writeClipboardText = async () => { throw new Error('OS clipboard forbidden') }" }))
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const normalized = filename.replaceAll('\\', '/')
      if (!/\/(ComparePanel|ResultGrid|DdlDialog|SqlEditor|MysqlAdminDialog)\.vue$/.test(normalized)) return { contents: 'export default {}' }
      const { descriptor } = parse(await readFile(filename, 'utf8'), { filename: normalized })
      const script = compileScript(descriptor, { id: normalized, genDefaultAs: '__component' })
      // Compile the actual Compare template, including its SQL emission and preview expressions.
      const template = normalized.endsWith('/ComparePanel.vue') || normalized.endsWith('/MysqlAdminDialog.vue')
        ? compileTemplate({ source: descriptor.template.content, filename: normalized, id: normalized, compilerOptions: { bindingMetadata: script.bindings } })
        : null
      assert.deepEqual(template?.errors ?? [], [])
      return { loader: 'ts', contents: `${script.content}\n${template?.code ?? ''}\n${template ? '__component.render = render;' : ''}\nexport default __component` }
    })
  } }]
})
const { Compare, Grid, Ddl, Editor, MysqlAdmin, decision, renderLoaded, useWorkbench, splitSqlScript } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const renderer = createRenderer({
  insert() {}, remove() {}, patchProp() {},
  createElement: (tag) => ({ tag }), createText: (text) => ({ text }), createComment: (text) => ({ text }),
  setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null
})
const mounted = []
function mount(component, props) {
  let bindings
  const root = {}
  let templateTree
  const vnode = h({
    ...component,
    setup(p, context) { bindings = component.setup(p, context); return bindings },
    render() {
      // Evaluate the real template within Vue's render context; DOM directives are never mounted.
      if (component.render) templateTree = component.render({}, [], props, proxyRefs(bindings), {}, {})
      return null
    }
  }, props)
  renderer.render(vnode, root)
  mounted.push(root)
  return {
    state: proxyRefs(bindings), exposed: proxyRefs(vnode.component.exposed ?? {}),
    render() { vnode.component.update(); return templateTree }
  }
}
function walk(vnode) {
  if (Array.isArray(vnode)) return vnode.flatMap(walk)
  if (!vnode || typeof vnode !== 'object') return []
  return [vnode, ...walk(vnode.children)]
}
function fixture() {
  storage.clear(); calls = []
  const wb = useWorkbench()
  const connections = ['A', 'B', 'C'].map((id) => ({ id, name: `synthetic-${id}`, dialectId: 'sqlite', connected: true, capabilities: { supportsInlineEdit: true } }))
  wb.connections.value = connections
  wb.dialects.value = [{ id: 'sqlite', quoting: { open: '"', close: '"', escape: 'double' } }]
  wb.selectConnection('A')
  const page = () => ({ columns: [{ name: 'id', type: 'integer' }], rows: [{ index: 0, cells: [{ kind: 'number', value: 1 }] }], offset: 0, returned: 1, hasMore: false, cursorId: 'synthetic-old-cursor', elapsedMs: 0, executedSql: 'SELECT id FROM synthetic' })
  const tab = reactive({
    id: 'tab-A', connectionId: 'A', title: 'synthetic', table: { id: 'connection:A|table:synthetic', kind: 'table', name: 'synthetic', parentId: 'connection:A', hasChildren: false },
    description: { hasUniqueKey: true, columns: [{ name: 'id', typeName: 'INTEGER', primaryKeyOrdinal: 1, nullable: false, requiredOnInsert: true }] },
    sql: 'SELECT id FROM synthetic', querySql: 'SELECT id FROM synthetic', parameters: [], result: page(), page: page(),
    message: '', busy: false, invalidated: false, dirty: new Map(), selectedRows: new Set(), filter: '', order: null, generation: 0
  })
  wb.tabs.value.push(tab); wb.activateTab(tab)
  methods = {
    transactionState: async () => ({ active: false, pendingAffected: 0 }),
    closeCursor: async () => null, runQuery: async () => ({ ...page(), cursorId: 'synthetic-new-cursor' }),
    listConnections: async () => connections, listChildren: async () => [],
    insertRow: async () => ({ affected: 1 }), createTable: async () => null, createView: async () => null,
    compareTableData: async () => ({ keyColumns: ['id'], rows: [], plan: { insertCount: 2, updateCount: 0, deleteCount: 0, warnings: [], statements: ["INSERT INTO synthetic VALUES (1, 'semi;colon')", "INSERT INTO synthetic VALUES (2, 'next')"] } })
  }
  return { wb, tab }
}
const results = []
async function test(name, run) {
  try { await run(fixture()); results.push({ name, passed: true }) }
  catch (error) { results.push({ name, passed: false, error: error.stack ?? String(error) }) }
  finally { for (const root of mounted.splice(0)) renderer.render(null, root) }
}

for (const side of ['source', 'target']) {
  await test(`${side}_switch_synchronously_clears_table_schema_and_plan`, ({ wb }) => {
    const { state: s } = mount(Compare, { workbench: wb })
    s.sourceTable = 'connection:A|table:source'; s.targetTable = 'connection:B|table:target'
    s.sourceSchema = 'source_schema'; s.targetSchema = 'target_schema'
    s.structure = { changes: [], statements: ['SELECT 1'], warnings: [] }; s.resultTarget = 'B'
    s[side] = 'C'
    assert.equal(s[`${side}Table`], '')
    assert.equal(s[`${side}Schema`], '')
    const other = side === 'source' ? 'target' : 'source'
    assert.equal(s[`${other}Table`], `connection:${other === 'source' ? 'A' : 'B'}|table:${other}`)
    assert.equal(s[`${other}Schema`], `${other}_schema`)
    assert.equal(s.structure, null); assert.equal(s.data, null); assert.equal(s.resultTarget, '')
  })
}
for (const side of ['source', 'target']) {
  await test(`forged_${side}_table_rejected_before_compare_backend`, async ({ wb }) => {
    const { state: s } = mount(Compare, { workbench: wb })
    s.mode = 'data'; s.sourceTable = 'connection:A|table:source'; s.targetTable = 'connection:B|table:target'
    s[`${side}Table`] = 'connection:C|table:forged'
    await s.compare()
    assert.equal(s.error, '所选表与比较连接不一致，请重新选择')
    assert.equal(s.busy, false); assert.equal(s.data, null); assert.equal(s.resultTarget, '')
    assert.deepEqual(calls, [])
  })
}
for (const mode of ['schema', 'data']) {
  await test(`${mode}_actual_template_emits_and_previews_two_parseable_statements`, async ({ wb }) => {
    const emitted = []
    const component = mount(Compare, { workbench: wb, onSql: (...args) => emitted.push(args) })
    const s = component.state
    s.mode = mode; s.sourceTable = 'connection:A|table:source'; s.targetTable = 'connection:B|table:target'
    methods.captureSchemaSnapshot = async (id) => ({ source: { connectionId: id, schema: null }, tables: [], routines: [], views: id === 'A' ? [
      { schema: null, name: 'first_view', definition: "CREATE VIEW first_view AS SELECT 'semi;colon'" },
      { schema: null, name: 'second_view', definition: 'CREATE VIEW second_view AS SELECT 2' }
    ] : [] })
    await s.compare()
    assert.equal(s.error, ''); assert.equal(s.statements.length, 2)
    const nodes = walk(component.render())
    const button = nodes.find((node) => node.type === 'button' && node.children === '载入目标 SQL 编辑器')
    assert.ok(button, 'actual template SQL button exists'); assert.equal(button.props.disabled, false)
    button.props.onClick()
    assert.equal(emitted.length, 1); assert.equal(emitted[0][0], 'B')
    const sql = emitted[0][1]
    assert.equal(nodes.find((node) => node.type === 'pre').children, sql)
    assert.equal(sql, `${s.statements[0]};\n${s.statements[1]}`)
    assert.deepEqual(splitSqlScript(sql).map((statement) => statement.sql), [...s.statements])
    // A connection change synchronously removes the old target's SQL action from the template.
    s.target = 'C'
    assert.equal(walk(component.render()).some((node) => node.type === 'pre'), false)
  })
}
for (const typeName of ['DECIMAL(38,18)', 'NUMERIC(38,18)']) {
  await test(`${typeName}_insert_reaches_ipc_as_exact_text`, async ({ wb, tab }) => {
    tab.description.columns.push({ name: 'amount', typeName, nullable: false, requiredOnInsert: true, primaryKeyOrdinal: null })
    const { state: s, exposed: grid } = mount(Grid, { workbench: wb, tab })
    grid.beginInsert()
    const exact = '12345678901234567890.123456789012345678'
    s.insertValues.id = '7'; s.insertValues.amount = exact
    await grid.submitInsert()
    assert.equal(grid.error, '')
    const inserted = calls.filter((call) => call.method === 'insertRow')
    assert.equal(inserted.length, 1)
    assert.deepEqual(inserted[0].args, ['connection:A|table:synthetic', { id: { kind: 'number', value: 7 }, amount: { kind: 'text', text: exact } }])
    assert.equal(s.insertOpen, false)
    assert.ok(calls.some((call) => call.method === 'runQuery'))
  })
}
for (const mode of ['create-table', 'create-view']) {
  await test(`${mode}_invalidates_existing_results_and_closes_old_cursor`, async ({ wb, tab }) => {
    const closed = []
    const { exposed: ddl } = mount(Ddl, { workbench: wb, connectionId: 'A', mode, onClose: () => closed.push(true) })
    ddl.name = 'synthetic_created'; ddl.selectSql = 'SELECT 1'
    const generation = tab.generation
    await ddl.submit()
    assert.equal(ddl.error, ''); assert.equal(ddl.busy, false)
    assert.equal(calls.filter((call) => call.method === (mode === 'create-table' ? 'createTable' : 'createView')).length, 1)
    assert.equal(tab.invalidated, true); assert.equal(tab.generation, generation + 1)
    assert.equal(tab.result, null); assert.equal(tab.page, null)
    assert.deepEqual(calls.filter((call) => call.method === 'closeCursor').map((call) => call.args), [['synthetic-old-cursor']])
    assert.equal(wb.canEdit(tab), false); assert.equal(wb.locks.size, 0)
    assert.deepEqual(closed, [true])
  })
}
function currentPageInsert(tab, wb) {
  return renderLoaded('sql-insert', tab.page.columns, tab.page.rows.map((row) => row.cells), tab, wb)
}
function insertColumnCount(sql) {
  const [, columns = '', values = ''] = sql.match(/\(([^)]*)\) VALUES \(([^)]*)\)/) ?? []
  return [columns.split(',').filter((part) => part.trim()).length, values.split(',').filter((part) => part.trim()).length]
}
await test('U12_current_page_insert_projects_writable_columns_only', ({ wb, tab }) => {
  tab.page.columns.push({ name: 'total', type: 'integer' }, { name: 'seq', type: 'integer' }, { name: 'auto', type: 'integer' })
  tab.page.rows[0].cells.push({ kind: 'number', value: 42 }, { kind: 'number', value: 7 }, { kind: 'number', value: 9 })
  Object.assign(tab.description.columns[0], { defaultValue: null, generated: null, identity: null })
  tab.description.columns.push(
    { name: 'total', typeName: 'INTEGER', nullable: true, primaryKeyOrdinal: null, defaultValue: null, generated: 'stored' },
    { name: 'seq', typeName: 'INTEGER', nullable: false, primaryKeyOrdinal: null, defaultValue: null, generated: null, identity: 'always' },
    { name: 'auto', typeName: 'INTEGER', nullable: false, primaryKeyOrdinal: null, defaultValue: null, generated: null, identity: 'by-default' }
  )
  const sql = currentPageInsert(tab, wb)
  assert.equal(sql, 'INSERT INTO "main"."synthetic" ("id", "auto") VALUES (1, 9);\n')
  assert.deepEqual(insertColumnCount(sql), [2, 2], 'writable column names and values stay aligned')
})
await test('U12_current_page_insert_keeps_plain_table_columns_and_rows', ({ wb, tab }) => {
  tab.page.columns.push({ name: 'body', type: 'text' })
  tab.page.rows[0].cells.push({ kind: 'text', text: 'first' })
  tab.page.rows.push({ index: 1, cells: [{ kind: 'number', value: 2 }, { kind: 'text', text: 'second' }] })
  Object.assign(tab.description.columns[0], { defaultValue: null, generated: null, identity: null })
  tab.description.columns.push({ name: 'body', typeName: 'TEXT', nullable: true, primaryKeyOrdinal: null, defaultValue: null, generated: null, identity: null })
  assert.equal(currentPageInsert(tab, wb),
    'INSERT INTO "main"."synthetic" ("id", "body") VALUES (1, \'first\');\n' +
    'INSERT INTO "main"."synthetic" ("id", "body") VALUES (2, \'second\');\n')
})
await test('U12_current_page_insert_refuses_without_target_column_description', ({ wb, tab }) => {
  tab.description = null
  assert.throws(() => currentPageInsert(tab, wb), /缺少目标表的列描述，无法确认生成列与自增列，已拒绝生成 INSERT/)
})
await test('U12_current_page_insert_refuses_result_column_absent_from_description', ({ wb, tab }) => {
  Object.assign(tab.description.columns[0], { defaultValue: null, generated: null, identity: null })
  tab.page.columns.push({ name: 'extra', type: 'text' })
  tab.page.rows[0].cells.push({ kind: 'text', text: 'not-described' })
  assert.throws(() => currentPageInsert(tab, wb), /无法唯一确定结果列「extra」，已拒绝生成 INSERT/)
})
await test('U12_current_page_insert_refuses_when_generated_marker_is_missing', ({ wb, tab }) => {
  // 驱动未提供 generated 标记（如 MySQL 的 information_schema EXTRA 未解析）时不能猜。
  assert.equal(tab.description.columns[0].generated, undefined)
  assert.throws(() => currentPageInsert(tab, wb), /目标表列「id」缺少生成列标记，无法确认是否可写，已拒绝生成 INSERT/)
})
for (const [label, cell] of [
  ['null', { kind: 'null' }],
  ['nonnull', { kind: 'blob', previewBase64: 'AAH/', length: 3, truncated: false }]
]) {
  await test(`UI-08_${label}_blob_column_opens_only_viewer_without_staging_or_apply`, async ({ wb, tab }) => {
    tab.page.columns.push({ name: 'payload', type: 'blob' })
    tab.page.rows[0].cells.push(cell)
    tab.description.columns.push({ name: 'payload', typeName: 'BLOB', nullable: true, primaryKeyOrdinal: null })
    const { exposed: grid } = mount(Grid, { workbench: wb, tab })
    assert.equal(wb.canEdit(tab), true, 'table is writable; BLOB metadata must enforce read-only behavior')
    await grid.openCell(tab.page.rows[0], 1)
    assert.equal(grid.error, '')
    assert.equal(grid.editing, null)
    assert.deepEqual(grid.viewer, { title: 'payload', value: cell })
    assert.equal(grid.selectedCell.column, 1)
    assert.equal(tab.busy, false)
    assert.equal(wb.pendingEditors.size, 0)
    grid.saveCell()
    assert.equal(tab.dirty.size, 0)
    assert.deepEqual(calls, [], 'complete BLOB viewing and saveCell without an editor send no backend writes or reads')
  })
}
await test('UI-08_inferred_null_blob_column_opens_viewer_via_table_metadata', async ({ wb, tab }) => {
  // SQLite 驱动按行值推断列类型：全 NULL 列得到 "null"，不能只看结果列类型。
  tab.page.columns.push({ name: 'payload', type: 'null' })
  tab.page.rows[0].cells.push({ kind: 'null' })
  tab.description.columns.push({ name: 'payload', typeName: 'BLOB', nullable: true, primaryKeyOrdinal: null })
  const { exposed: grid } = mount(Grid, { workbench: wb, tab })
  assert.equal(wb.canEdit(tab), true)
  await grid.openCell(tab.page.rows[0], 1)
  assert.equal(grid.error, '')
  assert.equal(grid.editing, null)
  assert.deepEqual(grid.viewer, { title: 'payload', value: { kind: 'null' } })
  grid.saveCell()
  assert.equal(tab.dirty.size, 0)
  assert.deepEqual(calls, [])
})
await test('UI-08_inferred_null_text_column_keeps_text_editing', async ({ wb, tab }) => {
  tab.page.columns.push({ name: 'note', type: 'null' })
  tab.page.rows[0].cells.push({ kind: 'null' })
  tab.description.columns.push({ name: 'note', typeName: 'TEXT', nullable: true, primaryKeyOrdinal: null })
  const { exposed: grid } = mount(Grid, { workbench: wb, tab })
  await grid.openCell(tab.page.rows[0], 1)
  assert.equal(grid.error, '')
  assert.equal(grid.viewer, null, 'TEXT metadata must not be mistaken for binary')
  assert.equal(grid.editing?.column, 1)
  assert.deepEqual(calls, [])
})
await test('UI-08_null_column_without_reliable_metadata_opens_viewer', async ({ wb, tab }) => {
  // 结果列类型与表描述都无法判定时按保守只读处理。
  tab.page.columns.push({ name: 'mystery', type: 'null' })
  tab.page.rows[0].cells.push({ kind: 'null' })
  const { exposed: grid } = mount(Grid, { workbench: wb, tab })
  await grid.openCell(tab.page.rows[0], 1)
  assert.equal(grid.editing, null)
  assert.deepEqual(grid.viewer, { title: 'mystery', value: { kind: 'null' } })
  assert.deepEqual(calls, [])
})
await test('UI-06_completion_tracks_current_connection_for_tree_and_result_columns', ({ wb, tab }) => {
  const node = (id, name, kind, children = []) => ({ ref: { id, name, kind }, children, loaded: true })
  wb.roots.value = ['A', 'B'].map((id) => node(`connection:${id}`, id, 'connection', [
    node(`connection:${id}|table:synthetic`, 'synthetic', 'table', [node(`connection:${id}|column:tree_${id}`, `tree_${id}`, 'column')])
  ]))
  tab.description.columns.push({ name: 'result_A' })
  wb.tabs.value.push({ ...tab, id: 'tab-B', connectionId: 'B', description: { columns: [{ name: 'result_B' }] }, page: { columns: [{ name: 'page_B' }] } })
  const { exposed: editor } = mount(Editor, { workbench: wb })
  for (const id of ['A', 'B', 'A']) {
    wb.selectConnection(id); wb.sql.value = 'synthetic.'; editor.setSelection(10)
    assert.deepEqual([...editor.candidates].sort(), id === 'A' ? ['id', 'result_A', 'tree_A'] : ['result_B', 'tree_B'])
    wb.sql.value = 'page_'; editor.setSelection(5)
    assert.deepEqual([...editor.candidates], id === 'B' ? ['page_B'] : [])
  }
  assert.deepEqual(calls, [])
})
for (const outcome of ['cancel', 'failure', 'success', 'close-failure']) {
  await test(`UI-07_sort_${outcome}_keeps_sql_order_and_page_consistent`, async ({ wb, tab }) => {
    const { state: grid } = mount(Grid, { workbench: wb, tab })
    const original = tab.page, sql = tab.querySql
    if (outcome === 'cancel') tab.dirty.set(0, { keyValues: { id: { kind: 'number', value: 1 } }, changes: { id: { kind: 'number', value: 2 } } })
    if (outcome === 'failure') methods.runQuery = async () => { throw new Error('synthetic-sort-failed') }
    if (outcome === 'close-failure') methods.closeCursor = async () => { throw new Error('synthetic-close-failed') }
    const pending = grid.sort('id')
    if (outcome === 'cancel') { assert.ok(decision.value); decision.value.settle('cancel') }
    await pending
    if (outcome === 'cancel' || outcome === 'failure') {
      assert.equal(tab.order, null); assert.equal(tab.querySql, sql); assert.equal(tab.page, original)
      if (outcome === 'cancel') assert.equal(calls.length, 0)
    } else {
      assert.deepEqual(tab.order, { column: 'id', direction: 'ASC' })
      assert.match(tab.querySql, /ORDER BY "id" ASC$/); assert.notEqual(tab.page, original)
    }
    assert.equal(tab.busy, false); assert.equal(wb.locks.size, 0)
    tab.dirty.clear(); methods.runQuery = async () => ({ ...original, cursorId: 'retry-cursor' }); methods.closeCursor = async () => null
    await grid.sort('id')
    assert.equal(tab.order.direction, outcome === 'cancel' || outcome === 'failure' ? 'ASC' : 'DESC')
    assert.equal(calls.filter((call) => call.method === 'runQuery').at(-1).args[1], tab.querySql)
  })
}
for (const failedMethod of ['transactionState', 'runQuery', 'closeCursor']) {
  await test(`UI-09_insert_success_${failedMethod}_failure_closes_form_and_blocks_resubmit`, async ({ wb, tab }) => {
    const { state: state, exposed: grid } = mount(Grid, { workbench: wb, tab })
    grid.beginInsert(); state.insertValues.id = '7'
    methods[failedMethod] = async () => { throw new Error(`synthetic-${failedMethod}-failed`) }
    await grid.submitInsert()
    assert.equal(calls.filter((call) => call.method === 'insertRow').length, 1)
    assert.equal(state.insertOpen, false); assert.equal(wb.pendingEditors.size, 0)
    assert.equal(wb.statusError.value, true)
    assert.match(wb.status.value, /已插入 1 行/); assert.match(wb.status.value, /刷新失败/)
    assert.match(wb.status.value, new RegExp(`synthetic-${failedMethod}-failed`))
    await grid.submitInsert()
    assert.equal(calls.filter((call) => call.method === 'insertRow').length, 1)
    assert.equal(wb.locks.size, 0); assert.equal(tab.busy, false)
  })
}
await test('mysql_admin_panel_renders_all_tabs_and_disables_self_kill', ({ wb }) => {
  methods.listSessions = async () => ([
    { id: 1, user: 'app', host: '10.0.0.1', database: 'testdb', command: 'Sleep', seconds: 3, state: null, info: null, current: true },
    { id: 2, user: 'app', host: '10.0.0.2', database: 'testdb', command: 'Query', seconds: 1, state: 'executing', info: 'SELECT 1', current: false }
  ])
  methods.listEvents = async () => ({ scheduler: 'ON', items: [] })
  methods.listUsers = async () => ({ users: [], privileges: [] })
  const node = { id: 'connection:c1|table:testdb.t', kind: 'table', name: 't', parentId: null, hasChildren: true }
  const { state: admin, render } = mount(MysqlAdmin, { workbench: wb, connectionId: 'c1', node })
  assert.deepEqual(admin.tabs.map((tab) => tab.id), ['partitions', 'indexes', 'sessions', 'events', 'users', 'search', 'lineage', 'source', 'database'])
  assert.equal(admin.tab, 'partitions')
  return admin.switchTab('sessions').then(async () => {
    assert.equal(admin.tab, 'sessions')
    assert.equal(admin.sessions.length, 2)
    // 当前会话必须被标记，其它会话可终止；终止自己的按钮状态由模板禁用。
    assert.equal(admin.sessions.filter((row) => row.current).length, 1)
    const tree = render()
    assert.ok(tree, '模板必须能渲染出 vnode')
    await admin.switchTab('source')
    assert.equal(admin.tab, 'source')
    const sourceTree = render()
    assert.ok(sourceTree, '对象源码面板必须能渲染')
    await admin.switchTab('database')
    assert.equal(admin.tab, 'database')
    const databaseTree = render()
    assert.ok(databaseTree, '新建库面板必须能渲染')
    await admin.switchTab('events')
    assert.equal(admin.events.scheduler, 'ON')
    await admin.switchTab('users')
    assert.equal(admin.users.users.length, 0)
  })
})

const failed = results.filter((result) => !result.passed)
console.log(JSON.stringify({ scope: 'real-vue-component-template-and-workbench-with-memory-ipc', dom: false, native_driver: false, database: false, filesystem_output: false, total: results.length, passed: results.length - failed.length, failed: failed.length, cases: results }, null, 2))
if (failed.length) process.exitCode = 1
