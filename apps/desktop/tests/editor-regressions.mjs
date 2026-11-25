// Mounted CodeMirror/Vue in a synthetic DOM. Native WebView and OS input are verified separately.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Window } from 'happy-dom'

const window = new Window({ url: 'https://editor.invalid' })
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Text', 'Range', 'MutationObserver', 'DOMRect', 'KeyboardEvent', 'CompositionEvent', 'Event', 'localStorage']) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true })
}
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
const { createApp, h, nextTick, ref } = await import('vue')
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite'))('esbuild')
const { parse, compileScript } = createRequire(require.resolve('vue'))('@vue/compiler-sfc')
const project = fileURLToPath(new URL('../../../', import.meta.url))
const vueEntry = pathToFileURL(fileURLToPath(import.meta.resolve('vue'))).href
const bundle = await build({
  stdin: { resolveDir: project, sourcefile: 'editor-regressions-entry.ts', contents: `
    export { default as Editor } from './apps/desktop/src/components/SqlEditor.vue';
    export { useWorkbench } from './apps/desktop/src/workbench.ts';
    export { editorSnapshots } from './apps/desktop/src/sql-editor-state.ts';
    export { undo, redo } from '@codemirror/commands';
  ` },
  write: false, bundle: true, format: 'esm', platform: 'node',
  plugins: [{ name: 'editor-regressions', setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: vueEntry, external: true }))
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'forbidden-native-call', namespace: 'editor-test' }))
    builder.onLoad({ filter: /.*/, namespace: 'editor-test' }, () => ({ contents: 'export const invoke = () => { throw new Error("Unexpected native call") }' }))
    builder.onLoad({ filter: /SqlEditor\.vue$/ }, async ({ path }) => {
      const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path })
      const script = compileScript(descriptor, { id: 'editor-regressions', inlineTemplate: true })
      return { contents: script.content, loader: 'ts' }
    })
  } }]
})
const { Editor, useWorkbench, editorSnapshots, undo, redo } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const outcomes = []
async function test(name, action) {
  window.localStorage.clear()
  const wb = useWorkbench()
  wb.connections.value = ['A', 'B'].map((id) => ({ id, name: id, connected: true, dialectId: 'mysql', capabilities: {} }))
  wb.dialects.value = [{ id: 'mysql', quoting: { open: '`', close: '`', escape: 'double' } }]
  wb.selectConnection('A')
  const disabled = ref(false)
  const events = []
  let editor
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ render: () => h(Editor, { key: wb.activeEditorTabId.value, workbench: wb, disabled: disabled.value, ref: (value) => { editor = value }, onExecute: (sql) => events.push(sql) }) })
  app.mount(root)
  const key = (options) => {
    const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options })
    editor.editor.contentDOM.dispatchEvent(event)
    return event
  }
  const edit = (text) => editor.editor.dispatch({ changes: { from: 0, to: editor.editor.state.doc.length, insert: text }, selection: { anchor: text.length }, userEvent: 'input.type' })
  try {
    await action({ wb, disabled, events, getEditor: () => editor, key, edit, root })
    outcomes.push({ name, passed: true })
    console.log(`PASS editor: ${name}`)
  } catch (error) {
    outcomes.push({ name, passed: false })
    console.error(`FAIL editor: ${name}: ${error.message}`)
  } finally {
    app.unmount()
    root.remove()
    await window.happyDOM.cancelAsync()
  }
}

await test('real_editor_mount_text_sync_and_undo_redo', async ({ wb, edit, getEditor, root }) => {
  assert.ok(root.querySelector('.cm-content[contenteditable="true"][aria-label="SQL 编辑器"]'))
  assert.ok(root.querySelector('.cm-lineNumbers'))
  assert.equal(root.querySelector('textarea'), null)
  edit("SELECT '中文😀' AS 名称;\n-- 中文注释")
  assert.equal(wb.sql.value, "SELECT '中文😀' AS 名称;\n-- 中文注释")
  assert.ok(undo(getEditor().editor))
  assert.equal(wb.sql.value, '')
  assert.ok(redo(getEditor().editor))
  assert.equal(wb.sql.value, "SELECT '中文😀' AS 名称;\n-- 中文注释")
  wb.sql.value = 'SELECT 42'
  assert.equal(getEditor().editor.state.doc.toString(), 'SELECT 42')
})

await test('composition_and_disabled_editor_cannot_execute', async ({ key, events, edit, getEditor, disabled }) => {
  edit('SELECT 1')
  getEditor().completionOpen = true
  key({ key: 'Enter', ctrlKey: true, isComposing: true })
  key({ key: 'Enter', shiftKey: true, keyCode: 229 })
  assert.deepEqual(events, [])
  getEditor().editor.contentDOM.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }))
  key({ key: 'Enter', ctrlKey: true })
  assert.deepEqual(events, [])
  assert.equal(getEditor().completionOpen, false)
  getEditor().editor.contentDOM.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true }))
  disabled.value = true
  await nextTick()
  assert.equal(getEditor().editor.state.readOnly, true)
  assert.equal(getEditor().editor.contentDOM.contentEditable, 'false')
  key({ key: 'Enter', ctrlKey: true })
  assert.deepEqual(events, [])
})

await test('selection_and_current_all_shortcuts_use_existing_sql_splitter', async ({ edit, getEditor, events, key }) => {
  const script = "SELECT 'a;b';\nSELECT 2; -- comment ;\nSELECT 3;"
  edit(script)
  getEditor().setSelection(script.indexOf('SELECT 2'))
  getEditor().completionOpen = true
  key({ key: 'Enter', ctrlKey: true })
  assert.equal(events.at(-1), 'SELECT 2')
  getEditor().setSelection(script.indexOf('SELECT 3'), script.length)
  key({ key: 'Enter', ctrlKey: true })
  assert.equal(events.at(-1), 'SELECT 3;')
  key({ key: 'Enter', shiftKey: true })
  assert.equal(events.at(-1), script)
  assert.equal(events.length, 3)
})

await test('tab_switch_preserves_independent_history_selection_and_target', async ({ wb, edit, getEditor, key, events }) => {
  const tabA = wb.activeEditorTabId.value
  edit('SELECT 11')
  getEditor().setSelection(3)
  wb.selectConnection('B')
  await nextTick()
  edit('SELECT 22')
  wb.activateEditorTab(tabA)
  await nextTick()
  assert.equal(getEditor().editor.state.doc.toString(), 'SELECT 11')
  assert.equal(getEditor().editor.state.selection.main.head, 3)
  key({ key: 'Enter', ctrlKey: true })
  assert.equal(events.at(-1), 'SELECT 11')
  assert.equal(wb.currentConnectionId.value, 'A')
  assert.ok(undo(getEditor().editor))
  assert.equal(wb.sql.value, '')
  wb.selectConnection('B')
  await nextTick()
  assert.equal(wb.sql.value, 'SELECT 22')
  assert.ok(undo(getEditor().editor))
  assert.equal(wb.sql.value, '')
  // Closing an inactive tab must release its retained editor state.
  const index = wb.editorTabs.value.findIndex((tab) => tab.id === tabA)
  wb.editorTabs.value.splice(index, 1)
  assert.equal(editorSnapshots(wb).has(tabA), false)
})

await test('completion_inserts_quoted_column_and_remains_undoable', async ({ wb, edit, getEditor }) => {
  wb.roots.value = [{ ref: { id: 'connection:A', name: 'A', kind: 'connection' }, children: [{
    ref: { id: 'connection:A|table:demo.items', name: 'items', kind: 'table' }, children: [{
      ref: { id: 'connection:A|column:demo.items.column', name: 'display name', kind: 'column' }, children: []
    }]
  }] }]
  edit('SELECT i. FROM demo.items i')
  getEditor().setSelection('SELECT i.'.length)
  assert.deepEqual([...getEditor().candidates], ['display name'])
  await getEditor().acceptCompletion(0)
  assert.equal(wb.sql.value, 'SELECT i.`display name` FROM demo.items i')
  assert.ok(undo(getEditor().editor))
  assert.equal(wb.sql.value, 'SELECT i. FROM demo.items i')
})

await test('formatting_preserves_literals_and_is_one_undoable_edit', async ({ wb, edit, getEditor }) => {
  const text = "select 'a;b 中文' as label from demo.items where id=1"
  edit(text)
  await getEditor().format()
  assert.equal(getEditor().error, '')
  assert.ok(wb.sql.value.includes("'a;b 中文'"))
  assert.equal(getEditor().editor.state.doc.toString(), wb.sql.value)
  assert.ok(undo(getEditor().editor))
  assert.equal(wb.sql.value, text)
})

await test('tab_key_indents_selected_lines_without_replacing_selection', async ({ wb, edit, getEditor, key }) => {
  edit('SELECT 1;\nSELECT 2;')
  getEditor().setSelection(0, wb.sql.value.length)
  getEditor().completionOpen = false
  key({ key: 'Tab' })
  assert.equal(wb.sql.value, '  SELECT 1;\n  SELECT 2;')
  assert.ok(undo(getEditor().editor))
  assert.equal(wb.sql.value, 'SELECT 1;\nSELECT 2;')
})

console.log(JSON.stringify({ suite: 'mounted-codemirror', passed: outcomes.filter((item) => item.passed).length, failed: outcomes.filter((item) => !item.passed).length }))
await window.happyDOM.close()
if (outcomes.some((item) => !item.passed)) process.exitCode = 1
