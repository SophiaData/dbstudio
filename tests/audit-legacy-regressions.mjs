// Offline application regressions. Bundles stay in memory; no fixture cleanup or database access.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const { buildSync } = createRequire(require.resolve('vite'))('esbuild')
function load(entry, transform = (text) => text) {
  const result = buildSync({
    stdin: { contents: transform(readFileSync(resolve(root, entry), 'utf8')), resolveDir: resolve(root, entry, '..'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false
  })
  const module = { exports: {} }
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require)
  return module.exports
}
const { ConnectionCatalog } = load('src/main/application/connection-catalog.ts')
const { MetadataApplicationService } = load('src/main/application/metadata-application-service.ts')
const { diffSchema } = load('src/core/compare.ts')
const { openComparePanel } = load('src/renderer/compare-panel.ts')
// Expose only the private lookup seam in the test bundle, leaving the shipped module untouched.
const { MetadataTree } = load('src/renderer/tree.ts', (text) => text
  .replaceAll('#roots', 'auditRoots').replaceAll('#findParentOf', 'auditFindParentOf')
  .replaceAll('#findNodeByKey', 'auditFindNodeByKey').replaceAll('#findNodeById', 'auditFindNodeById'))

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.selectedIndex = 0; this.classList = { add() {}, toggle() {} } }
  setAttribute(key, value) { this.attrs[key] = value }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children; this.selectedIndex = 0 }
  addEventListener(name, callback) { this.events[name] = callback }
  remove() {}
  get value() { return this.tag === 'select' ? this.children[this.selectedIndex]?.value ?? '' : this._value ?? '' }
  set value(value) { this._value = value }
}
const flush = () => new Promise((done) => setImmediate(done))
function fakeDocument() {
  const elements = []
  globalThis.document = {
    body: new Element('body'), addEventListener() {}, removeEventListener() {},
    createElement(tag) { const el = new Element(tag); elements.push(el); return el }
  }
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value } }
  return (id) => elements.find((el) => el.attrs['data-testid'] === id)
}
const snapshot = (name) => ({ tables: [{ id: `table:${name}`, name, schema: null }] })

// Replace the load/write boundaries only in this in-memory bundle; no filesystem fixtures run.
const { SqlLibraryStore } = load('src/main/SqlLibraryStore.ts', (text) => {
  for (const [original, replacement] of [
    ['#loadHistory', 'auditLoadHistory'], ['#loadSaved', 'auditLoadSaved'],
    ['#atomicWriteJson', 'auditAtomicWriteJson']
  ]) {
    assert.ok(text.includes(`  ${original}(`), `missing in-memory boundary: ${original}`)
    text = text.replaceAll(original, replacement)
    assert.ok(text.includes(`  ${replacement}(`), `missing replaced boundary: ${replacement}`)
    assert.ok(!text.includes(original), `unreplaced filesystem boundary: ${original}`)
  }
  return text
})
function memorySqlLibrary() {
  const persisted = new Map()
  let fail = false
  let beforeWrite = () => {}
  let writes = 0
  class MemorySqlLibrary extends SqlLibraryStore {
    auditLoadHistory() { return [] }
    auditLoadSaved() { return [] }
    auditAtomicWriteJson(path, data) {
      writes += 1
      beforeWrite()
      if (fail) throw new Error('injected persistence failure')
      persisted.set(path, structuredClone(data))
    }
  }
  const store = new MemorySqlLibrary({ baseDir: 'memory-only' })
  return { store, persisted, fail(value) { fail = value }, beforeWrite(callback) { beforeWrite = callback }, writes: () => writes }
}
const historyInput = (sql = 'SELECT 1', connectionId = 'c1') => ({
  sql, connectionId, dialectId: 'sqlite', elapsedMs: 1, status: 'success', returnedRows: 1
})
for (const operation of ['record', 'save-new', 'save-update', 'removeSaved', 'clearHistory', 'updateConnectionName']) {
  test(`SQL library ${operation} publishes only after persistence succeeds`, () => {
    const memory = memorySqlLibrary()
    const { store, persisted } = memory
    store.record(historyInput(), 'original')
    store.record(historyInput('SELECT 2', 'c2'), 'other')
    const first = store.save(null, 'first', 'SELECT 1')
    store.save(null, 'second', 'SELECT 2')
    const before = store.snapshot()
    const diskBefore = structuredClone([...persisted])
    const mutate = () => {
      switch (operation) {
        case 'record': return store.record(historyInput('SELECT 3'), 'original')
        case 'save-new': return store.save(null, 'third', 'SELECT 3')
        case 'save-update': return store.save(first.id, 'updated', 'SELECT 3')
        case 'removeSaved': return store.removeSaved(first.id)
        case 'clearHistory': return store.clearHistory()
        case 'updateConnectionName': return store.updateConnectionName('c1', 'renamed')
      }
    }
    memory.fail(true)
    assert.throws(mutate, /injected persistence failure/)
    assert.deepEqual(store.snapshot(), before, 'failed write must preserve memory')
    assert.deepEqual([...persisted], diskBefore, 'failed write must preserve persisted data')
    memory.fail(false)
    // A later unrelated write must not silently persist a failed mutation.
    store.record(historyInput('SELECT 4', 'c2'), 'other')
    store.save(null, 'unrelated', 'SELECT 4')
    assert.deepEqual(store.snapshot().history.slice(1), before.history)
    assert.deepEqual(store.snapshot().saved.slice(1), before.saved)
    assert.deepEqual(persisted.get(store.historyPath).entries, store.snapshot().history)
    assert.deepEqual(persisted.get(store.savedPath).entries, store.snapshot().saved)
    const beforeRetry = store.snapshot()
    memory.beforeWrite(() => assert.deepEqual(store.snapshot(), beforeRetry, 'candidate must remain private during persistence'))
    const result = mutate()
    const after = store.snapshot()
    assert.deepEqual(persisted.get(store.historyPath).entries, after.history)
    assert.deepEqual(persisted.get(store.savedPath).entries, after.saved)
    assert.notDeepEqual(after, beforeRetry)
    if (operation === 'record') assert.deepEqual(after.history[0], result)
    if (operation.startsWith('save-')) assert.deepEqual(after.saved[0], result)
    if (operation === 'removeSaved') assert.ok(after.saved.every((entry) => entry.id !== first.id))
    if (operation === 'clearHistory') assert.deepEqual(after.history, [])
    if (operation === 'updateConnectionName') {
      assert.equal(after.history.find((entry) => entry.connectionId === 'c1').connectionName, 'renamed')
      assert.equal(after.history[0].connectionName, 'other')
    }
  })
}

test('SQL library no-op mutations skip persistence', () => {
  const memory = memorySqlLibrary()
  const { store } = memory
  memory.fail(true)
  store.clearHistory()
  store.removeSaved('missing')
  store.updateConnectionName('missing', 'name')
  assert.equal(memory.writes(), 0)
  memory.fail(false)
  store.record(historyInput(), 'original')
  const writes = memory.writes()
  memory.fail(true)
  store.updateConnectionName('c1', 'original')
  assert.equal(memory.writes(), writes)
})

test('both compare table selectors load regardless of completion order; stale requests stay local', async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const find = fakeDocument()
    const pending = []
    const statuses = []
    openComparePanel({
      api: {
        listConnections: async () => ['c1', 'c2'].map((id) => ({ id, name: id, connected: true, dialectId: 'sqlite' })),
        captureSchemaSnapshot: (id) => new Promise((resolve, reject) => pending.push({ id, resolve, reject }))
      }, onStatus: (...args) => statuses.push(args)
    })
    await flush()
    for (const index of order) { pending[index].resolve(snapshot(pending[index].id)); await flush() }
    assert.deepEqual(find('compare-source-table').children.map((o) => o.text), ['c1'])
    assert.deepEqual(find('compare-target-table').children.map((o) => o.text), ['c2'])
    const source = find('compare-source')
    source.selectedIndex = 1; source.events.change()
    source.selectedIndex = 0; source.events.change()
    pending[3].resolve(snapshot('new-c1')); await flush()
    pending[2].resolve(snapshot('stale-c2')); await flush()
    assert.deepEqual(find('compare-source-table').children.map((o) => o.text), ['new-c1'])
    assert.deepEqual(find('compare-target-table').children.map((o) => o.text), ['c2'])
    source.events.change(); source.events.change()
    pending[4].reject(new Error('stale failure'))
    pending[5].resolve(snapshot('latest-c1')); await flush()
    assert.deepEqual(statuses, [])
  }
})

test('DDL parent lookup uses scoped object IDs across kinds and connections', () => {
  const tree = Object.create(MetadataTree.prototype)
  const parent = { ref: { kind: 'folder', id: 'connection:c1|folder:tables' }, children: [] }
  const other = { ref: { kind: 'folder', id: 'connection:c2|folder:tables' }, children: [] }
  const connection = { ref: { kind: 'connection', id: 'connection:c1' }, children: [parent] }
  tree.auditRoots = [connection, { ref: { kind: 'connection', id: 'connection:c2' }, children: [other] }]
  assert.equal(tree.auditFindParentOf({ id: 'connection:c1|table:t', parentId: parent.ref.id }), parent)
  assert.equal(tree.auditFindParentOf({ id: 'connection:c2|table:t', parentId: other.ref.id }), other)
  assert.equal(tree.auditFindParentOf({ ...parent.ref, parentId: connection.ref.id }), connection)
  assert.equal(tree.auditFindParentOf({ ...connection.ref, parentId: null }), connection)
  assert.equal(tree.auditFindParentOf({ id: 'missing', parentId: 'missing' }), null)
})

test('routine read failure rejects snapshot before a destructive comparison can be generated', async () => {
  const failure = new Error('routine metadata unavailable')
  let routines = async () => { throw failure }
  const conn = { id: 'c1', config: { dialectId: 'postgresql' }, info: { name: 'PostgreSQL' }, host: {
    listChildren: async () => [], listRoutines: (...args) => routines(...args)
  } }
  const service = new MetadataApplicationService({ getSession: () => conn, listConnections: () => [] })
  await assert.rejects(service.captureSchemaSnapshot('c1'), (error) => error === failure)
  routines = async () => []
  const empty = await service.captureSchemaSnapshot('c1')
  assert.deepEqual(empty.routines, [])
  const routine = { schema: 'public', name: 'f', kind: 'function', signature: [], definition: 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE SQL' }
  const target = { ...empty, routines: [routine] }
  assert.equal(diffSchema(empty, target, 'postgresql').statements[0], 'DROP FUNCTION "public"."f"()')
  routines = async () => [routine]
  assert.deepEqual((await service.captureSchemaSnapshot('c1')).routines, [routine])
})

test('unknown persisted dialects reserve connection IDs without changing stored configurations', () => {
  for (const ids of [['c1'], ['c40', 'c2'], ['c2', 'c40']]) {
    const stored = ids.map((id) => ({ id, config: { dialectId: 'unavailable', name: id, options: { marker: id } } }))
    stored.push({ id: 'c3', config: { dialectId: 'sqlite', name: 'known', options: {} } })
    const original = structuredClone(stored)
    const catalog = new ConnectionCatalog([{ id: 'sqlite', fields: [] }], { listConnections: () => stored })
    const generated = [catalog.nextConnectionId(), catalog.nextConnectionId()]
    const maxPersisted = Math.max(...stored.map(({ id }) => Number(id.slice(1))))
    assert.equal(generated[0], `c${maxPersisted + 1}`)
    assert.ok(generated.every((id) => !stored.some((entry) => entry.id === id)))
    assert.notEqual(generated[0], generated[1])
    assert.deepEqual(stored, original)
    assert.equal(catalog.get('c3').config.name, 'known')
  }
})
