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
    export { ensureSyntaxTree, foldedRanges, foldable } from '@codemirror/language';
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
const { Editor, useWorkbench, editorSnapshots, undo, redo, ensureSyntaxTree, foldedRanges, foldable } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
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
  assert.equal(getEditor().editor.state.doc.toString(), 'SELECT 1', 'IME confirmation must not reach CodeMirror newline commands')
  assert.equal(getEditor().editor.state.selection.main.head, 'SELECT 1'.length)
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

await test('locked_editor_rejects_a_stale_completion_action', async ({ wb, disabled, edit, getEditor }) => {
  edit('SEL')
  const index = getEditor().candidates.indexOf('SELECT')
  assert.ok(index >= 0)
  getEditor().completionOpen = true
  disabled.value = true
  await nextTick()
  assert.equal(getEditor().completionOpen, false)
  await getEditor().acceptCompletion(index)
  assert.equal(wb.sql.value, 'SEL')
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

function searchField(root, name, value) {
  const field = root.querySelector(`.cm-search input[name="${name}"]`)
  assert.ok(field, `Missing search field: ${name}`)
  field.value = value
  field.dispatchEvent(new window.Event('change', { bubbles: true }))
  return field
}
function clickTool(root, text) {
  const button = [...root.querySelectorAll('.sql-actions button')].find((button) => button.textContent === text)
  assert.ok(button, `Missing editor action: ${text}`)
  button.click()
  return button
}

await test('search_and_replace_use_real_panel_and_one_undo_without_execution', async ({ wb, edit, key, root, events, getEditor }) => {
  const original = "SELECT '中文' AS label;\nSELECT '中文' AS label;"
  edit(original)
  getEditor().completionOpen = true
  key({ key: 'f', ctrlKey: true })
  assert.equal(getEditor().completionOpen, false)
  const field = searchField(root, 'search', '中文')
  assert.equal(field.getAttribute('aria-label'), '查找')
  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, shiftKey: true, bubbles: true, cancelable: true }))
  assert.equal(getEditor().editor.state.sliceDoc(getEditor().editor.state.selection.main.from, getEditor().editor.state.selection.main.to), '中文')
  assert.deepEqual(events, [], 'Search Enter must not execute SQL')
  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true, cancelable: true }))
  assert.equal(document.activeElement?.getAttribute('name'), 'replace')
  searchField(root, 'replace', '替换😀')
  root.querySelector('.cm-search button[name="replaceAll"]').click()
  assert.equal(wb.sql.value, original.replaceAll('中文', '替换😀'))
  assert.ok(undo(getEditor().editor))
  assert.equal(wb.sql.value, original)
  assert.deepEqual(events, [])
  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  assert.equal(root.querySelector('.cm-search'), null)
})

await test('search_options_and_invalid_regex_do_not_mutate_sql', async ({ wb, edit, root }) => {
  edit('SELECT name, Name, names FROM items;')
  clickTool(root, '替换')
  searchField(root, 'search', 'name')
  searchField(root, 'replace', 'title')
  for (const name of ['case', 'word']) {
    const option = root.querySelector(`.cm-search input[name="${name}"]`)
    option.checked = true
    option.dispatchEvent(new window.Event('change', { bubbles: true }))
  }
  root.querySelector('.cm-search button[name="replaceAll"]').click()
  assert.equal(wb.sql.value, 'SELECT title, Name, names FROM items;')
  const regex = root.querySelector('.cm-search input[name="re"]')
  regex.checked = true
  regex.dispatchEvent(new window.Event('change', { bubbles: true }))
  searchField(root, 'search', '[')
  root.querySelector('.cm-search button[name="replaceAll"]').click()
  assert.equal(wb.sql.value, 'SELECT title, Name, names FROM items;')
})

await test('read_only_transition_closes_stale_replace_and_allows_find', async ({ wb, edit, root, disabled, getEditor }) => {
  edit('SELECT 1')
  clickTool(root, '替换')
  searchField(root, 'search', '1')
  searchField(root, 'replace', '2')
  const stale = root.querySelector('.cm-search button[name="replaceAll"]')
  disabled.value = true
  await nextTick()
  assert.equal(root.querySelector('.cm-search'), null)
  stale.click()
  clickTool(root, '行注释')
  assert.equal(wb.sql.value, 'SELECT 1')
  clickTool(root, '查找')
  assert.ok(root.querySelector('.cm-search input[name="search"]'))
  assert.equal(root.querySelector('.cm-search input[name="replace"]'), null)
  assert.equal(getEditor().editor.state.readOnly, true)
  disabled.value = false
  await nextTick()
  clickTool(root, '替换')
  assert.ok(root.querySelector('.cm-search input[name="replace"]'))
})

await test('line_comments_and_shortcut_are_undoable', async ({ wb, edit, getEditor, root, key }) => {
  const original = 'SELECT 1;\nSELECT 2;'
  edit(original)
  getEditor().setSelection(0, original.length)
  clickTool(root, '行注释')
  assert.equal(wb.sql.value, '-- SELECT 1;\n-- SELECT 2;')
  assert.ok(undo(getEditor().editor))
  assert.equal(wb.sql.value, original)
  key({ key: '/', code: 'Slash', ctrlKey: true })
  assert.equal(wb.sql.value, '-- SELECT 1;\n-- SELECT 2;')
  key({ key: '/', code: 'Slash', ctrlKey: true })
  assert.equal(wb.sql.value, original)
})

await test('replacement_history_and_search_query_stay_with_their_tab', async ({ wb, edit, root, getEditor }) => {
  const tabA = wb.activeEditorTabId.value
  edit('SELECT 1')
  clickTool(root, '替换')
  searchField(root, 'search', '1')
  searchField(root, 'replace', '11')
  root.querySelector('.cm-search button[name="replaceAll"]').click()
  wb.selectConnection('B')
  await nextTick()
  edit('SELECT 2')
  assert.equal(root.querySelector('.cm-search'), null)
  wb.activateEditorTab(tabA)
  await nextTick()
  assert.equal(root.querySelector('.cm-search input[name="search"]').value, '1')
  assert.equal(root.querySelector('.cm-search input[name="replace"]').value, '11')
  assert.equal(wb.sql.value, 'SELECT 11')
  assert.ok(undo(getEditor().editor))
  assert.equal(wb.sql.value, 'SELECT 1')
  wb.selectConnection('B')
  await nextTick()
  assert.equal(wb.sql.value, 'SELECT 2')
})

await test('fold_and_wrapping_survive_tabs_without_changing_execution', async ({ wb, edit, getEditor, key, root, events }) => {
  const original = 'SELECT\n  id,\n  name\nFROM items;'
  const tabA = wb.activeEditorTabId.value
  edit(original)
  getEditor().setSelection(0)
  getEditor().completionOpen = false
  assert.ok(ensureSyntaxTree(getEditor().editor.state, original.length, 100))
  assert.ok(foldable(getEditor().editor.state, 0, 6), 'SQL language must expose a foldable statement')
  assert.ok(root.querySelector('.cm-foldGutter'))
  assert.ok(key({ key: '{', code: 'BracketLeft', keyCode: 219, ctrlKey: true, shiftKey: true }).defaultPrevented, 'Fold key must be handled')
  assert.equal(foldedRanges(getEditor().editor.state).size, 1, 'Fold shortcut must collapse the SQL statement')
  assert.equal(wb.sql.value, original)
  key({ key: 'Enter', ctrlKey: true })
  assert.equal(events.at(-1), original.slice(0, -1), 'Folded SQL must execute completely')
  const wrap = clickTool(root, '自动换行')
  await nextTick()
  assert.equal(wrap.getAttribute('aria-pressed'), 'true')
  assert.equal(getEditor().editor.contentDOM.classList.contains('cm-lineWrapping'), true)
  wb.selectConnection('B')
  await nextTick()
  edit('SELECT 2')
  assert.equal(getEditor().editor.contentDOM.classList.contains('cm-lineWrapping'), false)
  assert.equal(foldedRanges(getEditor().editor.state).size, 0)
  wb.activateEditorTab(tabA)
  await nextTick()
  assert.equal(getEditor().editor.contentDOM.classList.contains('cm-lineWrapping'), true)
  assert.equal(foldedRanges(getEditor().editor.state).size, 1, 'Returning to the tab must restore its folded SQL')
  assert.equal(wb.sql.value, original)
  key({ key: '}', code: 'BracketRight', keyCode: 221, ctrlKey: true, shiftKey: true })
  assert.equal(foldedRanges(getEditor().editor.state).size, 0)
  assert.ok(undo(getEditor().editor))
  assert.equal(wb.sql.value, '')
})

console.log(JSON.stringify({ suite: 'mounted-codemirror', passed: outcomes.filter((item) => item.passed).length, failed: outcomes.filter((item) => !item.passed).length }))
await window.happyDOM.close()
if (outcomes.some((item) => !item.passed)) process.exitCode = 1
