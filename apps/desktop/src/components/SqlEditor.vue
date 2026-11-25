<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Compartment, EditorSelection, EditorState, Prec, StateEffect } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { MySQL, PostgreSQL, SQLite, StandardSQL, sql } from '@codemirror/lang-sql'
import { inferSchemaFromObjectId } from '../../../../src/core/er-relations'
import { SQL_COMPLETION_KEYWORDS } from '../../../../src/core/sql-keywords'
import { SQLITE_SCRIPT_RULES } from '../../../../src/core/sql-script'
import { completionTable, currentSql, formattedSql } from '../sql-editor-model'
import { editorSnapshots } from '../sql-editor-state'
import { connectionOf, type TreeNode, type Workbench } from '../workbench'

const props = defineProps<{ workbench: Workbench; disabled?: boolean }>()
const emit = defineEmits<{ execute: [sql: string]; explain: [sql: string]; library: [] }>()
const editorHost = ref<HTMLElement>()
const editor = shallowRef<EditorView>()
const editorTabId = props.workbench.activeEditorTabId.value
const language = new Compartment()
const editable = new Compartment()
const error = ref('')
let composing = false
const completionOpen = ref(false)
const completionIndex = ref(0)
const caret = ref(0)
const beforeCaret = computed(() => props.workbench.sql.value.slice(0, caret.value))
const prefix = computed(() => /[\p{L}_][\p{L}\p{N}_$]*$/u.exec(beforeCaret.value)?.[0] ?? '')
const qualified = computed(() => /("(?:""|[^"])*"|\x60(?:\x60\x60|[^\x60])*\x60|\[[^\]]+\]|[\p{L}_][\p{L}\p{N}_$]*)\s*\.\s*([\p{L}_][\p{L}\p{N}_$]*)?$/u.exec(beforeCaret.value))
const qualifier = computed(() => qualified.value?.[1] ?? '')
const dialectId = computed(() => props.workbench.currentConnection.value?.dialectId)
const dialect = computed(() => props.workbench.dialects.value.find((item) => item.id === dialectId.value))
const rules = computed(() => dialect.value?.scriptRules ?? SQLITE_SCRIPT_RULES)
function flattenNodes(nodes: TreeNode[]): TreeNode[] { return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]) }
function loadedObjects(nodes: TreeNode[]): string[] { return nodes.flatMap((node) => [node.ref.name, ...loadedObjects(node.children)]) }
const connectionRoots = computed(() => props.workbench.roots.value.filter((node) => connectionOf(node.ref.id) === props.workbench.currentConnectionId.value))
const connectionTabs = computed(() => props.workbench.tabs.value.filter((tab) => tab.connectionId === props.workbench.currentConnectionId.value))
function columnsFor(name: string, schema?: string): string[] {
  const same = (actual: string, expected: string) => dialectId.value === 'postgresql'
    ? actual === expected : actual.toLowerCase() === expected.toLowerCase()
  const objects = new Map<string, Set<string>>()
  const collect = (object: { id: string; kind: string; name: string }, columns: string[]) => {
    if (connectionOf(object.id) !== props.workbench.currentConnectionId.value) return
    if ((object.kind !== 'table' && object.kind !== 'view') || !same(object.name, name)) return
    const objectSchema = inferSchemaFromObjectId(object.id, dialectId.value)
    if (schema !== undefined && (objectSchema === null || !same(objectSchema, schema))) return
    const values = objects.get(object.id) ?? new Set<string>()
    for (const column of columns) values.add(column)
    objects.set(object.id, values)
  }
  for (const node of flattenNodes(connectionRoots.value)) {
    if (node.ref.kind === 'table' || node.ref.kind === 'view') {
      collect(node.ref, flattenNodes(node.children).filter((child) => child.ref.kind === 'column').map((child) => child.ref.name))
    }
  }
  for (const tab of connectionTabs.value) {
    if (tab.table && tab.description && !tab.invalidated) collect(tab.table, tab.description.columns.map((column) => column.name))
  }
  return objects.size === 1 ? [...objects.values().next().value!] : []
}
const candidates = computed(() => {
  const context = qualified.value
  let values: string[]
  if (context) {
    const source = completionTable(props.workbench.sql.value, context.index, rules.value, dialectId.value)
    values = source ? columnsFor(source.name, source.schema) : []
  } else {
    const metadata = loadedObjects(connectionRoots.value)
      .concat(connectionTabs.value.flatMap((tab) => tab.page?.columns.map((column) => column.name) ?? []))
    values = [...SQL_COMPLETION_KEYWORDS.map((word) => word.toUpperCase()), ...metadata]
  }
  return [...new Set(values)]
    .filter((word) => !prefix.value || word.toLowerCase().startsWith(prefix.value.toLowerCase()))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 30)
})
function currentStatement() {
  const selection = editor.value?.state.selection.main
  return currentSql(props.workbench.sql.value, selection?.from ?? caret.value, selection?.to ?? caret.value, rules.value)
}
function execute(all = false) {
  if (props.disabled) return
  try {
    const text = all ? props.workbench.sql.value : currentStatement()
    if (!text.trim()) throw new Error('当前位置没有可执行的 SQL')
    emit('execute', text)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'SQL 解析失败' }
}
function executeCurrent() { execute(false) }
function executeAll() { execute(true) }
async function format() {
  if (props.disabled) return
  try {
    completionOpen.value = false
    const offset = editor.value?.state.selection.main.head ?? 0
    const before = props.workbench.sql.value.slice(0, offset).replace(/\s/g, '').length
    const text = formattedSql(props.workbench.sql.value)
    let cursor = 0, seen = 0
    while (cursor < text.length && seen < before) if (!/\s/.test(text[cursor++]!)) seen++
    if (editor.value) {
      editor.value.dispatch({ changes: { from: 0, to: editor.value.state.doc.length, insert: text }, selection: { anchor: cursor }, userEvent: 'input.format' })
    } else props.workbench.sql.value = text
    await nextTick()
    error.value = ''
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '格式化失败' }
}
function updateCaret() {
  caret.value = editor.value?.state.selection.main.head ?? caret.value
  completionIndex.value = 0
}
function setSelection(start: number, end = start) {
  caret.value = start
  const view = editor.value
  if (view) view.dispatch({ selection: EditorSelection.single(Math.min(start, view.state.doc.length), Math.min(end, view.state.doc.length)) })
}
async function acceptCompletion(index = completionIndex.value) {
  const word = candidates.value[index]
  if (props.disabled || composing || !word || !editor.value) return
  const quoting = dialect.value?.quoting
  const needsQuotes = !/^[\p{L}_][\p{L}\p{N}_$]*$/u.test(word)
    || SQL_COMPLETION_KEYWORDS.includes(word.toLowerCase())
    || (dialectId.value === 'postgresql' && word !== word.toLowerCase())
  let inserted = word
  if (qualified.value && quoting && needsQuotes) {
    const escaped = quoting.escape === 'double'
      ? word.split(quoting.close).join(quoting.close + quoting.close)
      : word.split('\\').join('\\\\').split(quoting.close).join('\\' + quoting.close)
    inserted = quoting.open + escaped + quoting.close
  }
  const start = caret.value - prefix.value.length
  const next = start + inserted.length
  editor.value.dispatch({ changes: { from: start, to: caret.value, insert: inserted }, selection: { anchor: next }, userEvent: 'input.complete' })
  completionOpen.value = false
  await nextTick()
  if (!editor.value) return
  editor.value.focus()
  caret.value = next
}
function keydown(event: KeyboardEvent) {
  // Enter confirms IME text as well as SQL/completions. Composition owns the key.
  if (composing || event.isComposing || event.keyCode === 229 || editor.value?.composing) return
  if (props.disabled) return
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    completionOpen.value = false
    execute(event.shiftKey)
    return
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && event.key === 'Enter') {
    event.preventDefault()
    completionOpen.value = false
    execute(true)
    return
  }
  if (completionOpen.value) {
    const count = candidates.value.length
    if (count && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); completionIndex.value = (completionIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count; return }
    if (count && (event.key === 'Enter' || event.key === 'Tab')) { event.preventDefault(); void acceptCompletion(); return }
    if (event.key === 'Escape') { event.preventDefault(); completionOpen.value = false; return }
  }
  if (event.shiftKey && event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); void format(); return }
  if ((event.ctrlKey || event.metaKey) && event.code === 'Space') { event.preventDefault(); updateCaret(); completionIndex.value = 0; completionOpen.value = true; return }
}
function sqlLanguage() {
  const dialect = dialectId.value === 'mysql' ? MySQL : dialectId.value === 'postgresql' ? PostgreSQL : dialectId.value === 'sqlite' ? SQLite : StandardSQL
  return sql({ dialect, upperCaseKeywords: true })
}
function editability() {
  return [EditorState.readOnly.of(Boolean(props.disabled)), EditorView.editable.of(!props.disabled)]
}
watch(() => props.workbench.sql.value, (text) => {
  const view = editor.value
  if (props.workbench.activeEditorTabId.value !== editorTabId || !view || view.state.doc.toString() === text) return
  // External loads and edits stay undoable, without echoing editor updates back into history.
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.external' })
}, { flush: 'sync' })
watch(() => props.disabled, () => {
  if (props.disabled) completionOpen.value = false
  editor.value?.dispatch({ effects: editable.reconfigure(editability()) })
})
watch(dialectId, () => {
  if (props.workbench.activeEditorTabId.value === editorTabId) editor.value?.dispatch({ effects: language.reconfigure(sqlLanguage()) })
})
onMounted(() => {
  // Controller-only tests intentionally mount no DOM; real applications always supply this host.
  if (!editorHost.value) return
  const extensions = [
    lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
    history(), indentOnInput(), indentUnit.of('  '), bracketMatching(), syntaxHighlighting(defaultHighlightStyle),
    language.of(sqlLanguage()), editable.of(editability()),
    EditorView.contentAttributes.of({ 'aria-label': 'SQL 编辑器', 'aria-multiline': 'true', spellcheck: 'false' }),
    Prec.highest(EditorView.domEventHandlers({
      keydown(event) { keydown(event); return event.defaultPrevented },
      compositionstart() { composing = true; completionOpen.value = false },
      compositionend() { composing = false },
    })),
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((update) => {
      if (props.workbench.activeEditorTabId.value !== editorTabId) return
      if (update.docChanged) props.workbench.sql.value = update.state.doc.toString()
      if (update.docChanged || update.selectionSet) {
        caret.value = update.state.selection.main.head
        completionIndex.value = 0
        completionOpen.value = update.docChanged && !composing && !update.view.composing &&
          update.transactions.some((transaction) => transaction.isUserEvent('input.type')) &&
          (prefix.value.length > 0 || qualifier.value !== '')
      }
    }),
    EditorView.theme({
      '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'var(--bg)' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', fontSize: '13px', lineHeight: '1.6' },
      '.cm-content': { padding: '8px 0', caretColor: 'var(--fg)' },
      '.cm-gutters': { backgroundColor: 'var(--bg-alt)', color: 'var(--fg-dim)', borderColor: 'var(--border)' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#7890ab12' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#4f8cff55' },
      '.cm-cursor': { borderLeftColor: 'var(--fg)' },
    }),
  ]
  const previous = editorSnapshots(props.workbench).get(editorTabId)
  const state = previous?.state.doc.toString() === props.workbench.sql.value
    ? previous.state.update({ effects: StateEffect.reconfigure.of(extensions) }).state
    : EditorState.create({ doc: props.workbench.sql.value, extensions })
  editor.value = new EditorView({ state, parent: editorHost.value })
  caret.value = state.selection.main.head
  if (previous) {
    editor.value.scrollDOM.scrollTop = previous.scrollTop
    editor.value.scrollDOM.scrollLeft = previous.scrollLeft
  }
})
onBeforeUnmount(() => {
  const view = editor.value
  if (!view) return
  const snapshots = editorSnapshots(props.workbench)
  if (props.workbench.editorTabs.value.some((tab) => tab.id === editorTabId)) {
    snapshots.set(editorTabId, { state: view.state, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft })
  }
  view.destroy()
  editor.value = undefined
})
defineExpose({ currentStatement, execute, executeCurrent, executeAll, format, editor, error, candidates, completionOpen, prefix, qualifier, caret, updateCaret, setSelection, acceptCompletion, keydown })
</script>

<template>
  <section class="vue-sql-editor">
    <div class="sql-actions"><button :disabled="disabled" @click="executeCurrent">执行当前</button><button :disabled="disabled" @click="executeAll">执行全部</button><button :disabled="disabled" @click="format">格式化</button><button :disabled="disabled" @click="completionOpen = !completionOpen; updateCaret()">补全</button><button :disabled="disabled" @click="emit('explain', currentStatement())">执行计划</button><button @click="emit('library')">历史 / 收藏</button><span class="spacer" /><small>⌘/Ctrl Enter 当前 · ⇧ Enter 全部 · ⇧⌥F 格式化</small></div>
    <div ref="editorHost" class="sql-code" />
    <div v-if="completionOpen" class="sql-completions" role="listbox" aria-label="SQL 补全"><button v-for="(candidate, index) in candidates" :key="candidate" :class="{ selected: index === completionIndex }" role="option" :aria-selected="index === completionIndex" @mousedown.prevent="acceptCompletion(index)">{{ candidate }}</button><span v-if="!candidates.length" class="muted">没有匹配项；展开元数据树以获得表列候选</span></div>
    <p v-if="error" class="is-error">{{ error }}</p>
  </section>
</template>

<style scoped>
.vue-sql-editor { position:relative; display:flex; flex-direction:column; flex:0 0 230px; min-height:120px; border-bottom:1px solid var(--border); resize:vertical; overflow:hidden; }
.sql-actions { display:flex; align-items:center; flex-wrap:wrap; gap:5px; padding:4px 8px; background:var(--bg-alt); }
.sql-actions small { color:var(--fg-dim); font-size:10px; }
.sql-code { flex:1; min-height:0; overflow:hidden; }
.sql-completions { position:absolute; top:55px; right:12px; width:260px; max-height:230px; overflow:auto; z-index:5; background:var(--bg-alt); border:1px solid var(--border); box-shadow:0 4px 20px #0008; }
.sql-completions button { display:block; width:100%; text-align:left; border:0; border-radius:0; font-family:var(--mono); }.sql-completions button.selected { background:#263d5c; }
</style>
