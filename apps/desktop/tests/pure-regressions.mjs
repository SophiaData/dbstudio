import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = mkdtempSync(join(tmpdir(), 'dbstudio-pure-regressions-'))
const entry = resolve(root, 'apps/desktop/tests/pure-entry.ts')
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir: output,
    emptyOutDir: false,
    target: 'node22',
    ssr: true,
    minify: false,
    lib: { entry, formats: ['cjs'] },
    rollupOptions: { output: { entryFileNames: 'pure-regressions.cjs' } }
  }
})

const m = await import(pathToFileURL(join(output, 'pure-regressions.cjs')).href)
let passed = 0
const failures = []
const check = (name, action) => {
  try {
    action()
    passed += 1
    console.log(`PASS pure: ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL pure: ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}
const throws = (action, pattern) => assert.throws(action, pattern)
const node = (id, name, kind, children = [], expanded = false, loaded = true) => ({
  ref: { id, kind, name, parentId: null, hasChildren: children.length > 0 },
  children,
  expanded,
  loaded,
  loading: false,
  error: ''
})

check('param_slots_scope_anonymous', () => {
  const slots = m.statementParameterSlots(
    'UPDATE t SET v=? WHERE id=1; UPDATE t SET v=? WHERE id=2; SELECT :name',
    m.SQLITE_SCRIPT_RULES,
    'sqlite'
  )
  assert.deepEqual(slots.map((slot) => [slot.statementIndex, slot.name, slot.key]), [
    [0, '?1', '0:?1'],
    [1, '?1', '1:?1'],
    [2, 'name', '2:name']
  ])
})

check('param_slots_named_dedupe_same_statement', () => {
  const slots = m.statementParameterSlots('SELECT :x, :x; SELECT :x', m.SQLITE_SCRIPT_RULES, 'sqlite')
  assert.deepEqual(slots.map((slot) => [slot.statementIndex, slot.name]), [[0, 'x'], [1, 'x']])
})

check('param_slots_label_statement_line', () => {
  const slots = m.statementParameterSlots('UPDATE t SET v=? WHERE id=1;\n\nUPDATE t SET v=? WHERE id=2', m.SQLITE_SCRIPT_RULES, 'sqlite')
  assert.deepEqual(slots.map((slot) => [slot.statementIndex, slot.startLine]), [[0, 1], [1, 3]])
})

check('param_slots_postgres_local_numbering', () => {
  const slots = m.statementParameterSlots('SELECT $1,$2; SELECT $1', m.POSTGRESQL_SCRIPT_RULES, 'postgresql')
  assert.deepEqual(slots.map((slot) => [slot.statementIndex, slot.name, slot.key]), [
    [0, '$1', '0:$1'],
    [0, '$2', '0:$2'],
    [1, '$1', '1:$1']
  ])
})

check('param_binding_uses_each_statement_values', () => {
  const sql = 'UPDATE t SET v=? WHERE id=1; UPDATE t SET v=? WHERE id=2'
  const scoped = [
    { statementIndex: 0, name: '?1', value: 'first' },
    { statementIndex: 1, name: '?1', value: 'second' }
  ]
  const first = m.bindSqlParameters('UPDATE t SET v=? WHERE id=1', m.scopedParametersForStatement(scoped, 0), 'sqlite')
  const second = m.bindSqlParameters('UPDATE t SET v=? WHERE id=2', m.scopedParametersForStatement(scoped, 1), 'sqlite')
  assert.deepEqual(first.values, ['first'])
  assert.deepEqual(second.values, ['second'])
  assert.throws(() => m.validateScopedSqlParameters(scoped, 1), /语句范围/)
})

check('param_named_values_do_not_leak_across_statements', () => {
  const second = m.bindSqlParameters(
    'UPDATE t SET v=:value WHERE id=2',
    m.scopedParametersForStatement([
      { statementIndex: 0, name: 'value', value: 'named-first' },
      { statementIndex: 1, name: 'value', value: 'named-second' }
    ], 1),
    'sqlite'
  )
  assert.deepEqual(second.values, ['named-second'])
})

check('param_unsafe_number_rejected_with_text_guidance', () => {
  throws(() => m.parseParameterValue('9007199254740993', 'number'), /文本/)
})

check('numeric_cell_preserves_unsafe_integer_as_text', () => {
  assert.deepEqual(m.parseNumericCell('9007199254740993'), { kind: 'text', text: '9007199254740993' })
  assert.deepEqual(m.parseNumericCell('9007199254740991'), { kind: 'number', value: 9007199254740991 })
  assert.deepEqual(m.parseNumericCell('42.5'), { kind: 'number', value: 42.5 })
})

check('parameter_literal_rejects_rounded_number', () => {
  const rounded = Number('9007199254740993')
  assert.equal(rounded, 9007199254740992)
  throws(() => m.parameterLiteral(rounded, 'sqlite'), /安全整数/)
  throws(() => m.materializeQuery('SELECT ?', [{ name: '?1', value: rounded }], 'sqlite'), /安全整数/)
})

check('connection_secret_preserves_raw_and_unknown_options', () => {
  const fields = [
    { key: 'host', label: 'Host', kind: 'text', required: true },
    { key: 'dbPassword', label: 'Password', kind: 'password', required: false, secretKey: 'dbPassword' },
    { key: 'sshPassphrase', label: 'SSH passphrase', kind: 'password', required: false, secretKey: 'sshPassphrase' }
  ]
  const values = new Map([
    ['host', '  localhost  '],
    ['dbPassword', '  p@ss word  '],
    ['sshPassphrase', '   ']
  ])
  const result = m.collectConnectionFields({
    fields,
    values,
    baseOptions: { native_unlisted_option: 'keep' },
    editing: true
  })
  assert.equal(result.options.host, 'localhost')
  assert.equal(result.options.native_unlisted_option, 'keep')
  assert.equal(result.secret.dbPassword, '  p@ss word  ')
  assert.equal(result.secret.sshPassphrase, '   ')
})

check('tree_search_traverses_loaded_collapsed_nodes', () => {
  const column = node('connection:c|column:needle', 'needle', 'column')
  const table = node('connection:c|table:t', 'table', 'table', [column], false, true)
  const schema = node('connection:c|schema:public', 'public', 'schema', [table], false, true)
  const root = node('connection:c', 'conn', 'connection', [schema], false, true)
  const rows = m.flattenTree([root], 'needle')
  assert.deepEqual(rows.filter((row) => row.kind === 'node').map((row) => row.node.ref.name), ['conn', 'public', 'table', 'needle'])
  assert.equal(table.expanded, false)
  assert.equal(schema.expanded, false)
})

check('tree_search_does_not_traverse_unloaded_cache', () => {
  const hidden = node('connection:c|table:hidden', 'needle', 'table')
  const table = node('connection:c|table:t', 'table', 'table', [hidden], false, false)
  const root = node('connection:c', 'conn', 'connection', [table], false, true)
  assert.equal(m.flattenTree([root], 'needle').length, 0)
})

check('tree_search_opens_matching_group_without_mutating_state', () => {
  const table = node('connection:c|table:needle', 'needle', 'table')
  const root = node('connection:c', 'conn', 'connection', [table], false, true)
  const preferences = { c: { color: 'blue', group: 'Team', identity: JSON.stringify(['conn', '']) } }
  const collapsed = new Set(['Team'])
  const rows = m.flattenTree([root], 'needle', preferences, collapsed)
  assert.deepEqual(rows.map((row) => row.kind), ['group', 'node', 'node'])
  assert.equal(rows[0].expanded, true)
  assert.ok(rows.some((row) => row.kind === 'node' && row.node.ref.name === 'needle'))
  assert.equal(collapsed.has('Team'), true)
})

check('tree_preferences_prune_requires_authoritative_metadata', () => {
  assert.equal(m.canPruneConnectionPreferences(false, false), false)
  assert.equal(m.canPruneConnectionPreferences(false, true), false)
  assert.equal(m.canPruneConnectionPreferences(true, false), true)
})

check('schema_inference_uses_first_unescaped_dot', () => {
  assert.equal(m.inferSchemaFromObjectId('connection:c1|table:a\\.b.users', 'postgresql'), 'a.b')
  assert.equal(m.inferSchemaFromObjectId('table:a\\\\b.users', 'postgresql'), 'a\\b')
})

check('schema_inference_sqlite_never_splits_table_name', () => {
  const id = 'connection:c1|table:with.dot'
  assert.equal(m.inferSchemaFromObjectId(id, 'sqlite'), null)
  const child = node(id, 'users', 'table')
  const target = node('connection:c1|table:with.dot', 'with.dot', 'table')
  const fk = {
    name: 'fk_dotted', columns: ['owner'], referencedSchema: null, referencedTable: 'with.dot',
    referencedColumns: ['id'], onUpdate: null, onDelete: null
  }
  const summary = m.computeErRelations([
    { ref: { ...child.ref, id: 'connection:c1|table:child' }, desc: { id: 'child', columns: [], hasUniqueKey: true, foreignKeys: [fk] } },
    { ref: target.ref, desc: { id: target.ref.id, columns: [], hasUniqueKey: true, foreignKeys: [] } }
  ], { dialectId: 'sqlite' })
  assert.equal(summary.relations.length, 1)
  assert.equal(summary.relations[0].from.schema, null)
  assert.equal(summary.relations[0].to.schema, null)
})

check('schema_inference_pg_schema_with_dot_matches_fk', () => {
  const fk = {
    name: 'fk_dotted_schema', columns: ['owner'], referencedSchema: null, referencedTable: 'users',
    referencedColumns: ['id'], onUpdate: null, onDelete: null
  }
  const summary = m.computeErRelations([
    { ref: { id: 'connection:c1|table:a\\.b.child', kind: 'table', name: 'child', parentId: null, hasChildren: true }, desc: { id: 'child', columns: [], hasUniqueKey: true, foreignKeys: [fk] } },
    { ref: { id: 'connection:c1|table:a\\.b.users', kind: 'table', name: 'users', parentId: null, hasChildren: true }, desc: { id: 'users', columns: [], hasUniqueKey: true, foreignKeys: [] } }
  ], { dialectId: 'postgresql' })
  assert.equal(summary.relations.length, 1)
  assert.equal(summary.relations[0].from.schema, 'a.b')
  assert.equal(summary.relations[0].to.schema, 'a.b')
})

check('insert_target_uses_inferred_schema_with_dot', () => {
  assert.equal(m.buildInsertTarget({ kind: 'table', name: 'with.dot' }, 'sqlite'), '"main"."with.dot"')
  assert.equal(m.buildInsertTarget({ kind: 'table', name: 'users', schema: 'a.b' }, 'postgresql'), '"a.b"."users"')
})

console.log(`\nPure regression checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
