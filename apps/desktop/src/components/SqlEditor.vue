<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { SQL_COMPLETION_KEYWORDS } from '../../../../src/renderer/sql-keywords'
import { SQLITE_SCRIPT_RULES } from '../../../../src/core/sql-script'
import { currentSql, formattedSql, highlightTokens } from '../sql-editor-model'
import type { TreeNode, Workbench } from '../workbench'

const props = defineProps<{ workbench: Workbench; disabled?: boolean }>()
const emit = defineEmits<{ execute: [sql: string]; explain: [sql: string]; library: [] }>()
const editor = ref<HTMLTextAreaElement>()
const highlighter = ref<HTMLElement>()
const error = ref('')
const completionOpen = ref(false)
const completionIndex = ref(0)
const caret = ref(0)
const beforeCaret = computed(() => props.workbench.sql.value.slice(0, caret.value))
const prefix = computed(() => /[A-Za-z_][\w$]*$/.exec(beforeCaret.value)?.[0] ?? '')
const qualifier = computed(() => /([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)?$/.exec(beforeCaret.value)?.[1] ?? '')
const rules = computed(() => props.workbench.dialects.value.find((dialect) => dialect.id === props.workbench.currentConnection.value?.dialectId)?.scriptRules ?? SQLITE_SCRIPT_RULES)
const tokens = computed(() => highlightTokens(props.workbench.sql.value))
function flattenNodes(nodes: TreeNode[]): TreeNode[] { return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]) }
function loadedObjects(nodes: TreeNode[]): string[] { return nodes.flatMap((node) => [node.ref.name, ...loadedObjects(node.children)]) }
function columnsFor(name: string): string[] {
  const normalized = name.toLowerCase()
  const treeColumns = flattenNodes(props.workbench.roots.value)
    .filter((node) => node.ref.kind === 'table' && node.ref.name.toLowerCase() === normalized)
    .flatMap((table) => flattenNodes(table.children).filter((node) => node.ref.kind === 'column').map((node) => node.ref.name))
  const resultColumns = props.workbench.tabs.value
    .filter((tab) => tab.table?.name.toLowerCase() === normalized && tab.description)
    .flatMap((tab) => tab.description!.columns.map((column) => column.name))
  return [...new Set([...treeColumns, ...resultColumns])]
}
const candidates = computed(() => {
  const columns = qualifier.value ? columnsFor(qualifier.value) : []
  const metadata = loadedObjects(props.workbench.roots.value)
    .concat(props.workbench.tabs.value.flatMap((tab) => tab.page?.columns.map((column) => column.name) ?? []))
  const values = qualifier.value && columns.length
    ? columns
    : [...new Set([...SQL_COMPLETION_KEYWORDS.map((word) => word.toUpperCase()), ...metadata])]
  return [...new Set(values)]
    .filter((word) => !prefix.value || word.toLowerCase().startsWith(prefix.value.toLowerCase()))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 30)
})
function currentStatement() {
  const input = editor.value
  return currentSql(props.workbench.sql.value, input?.selectionStart ?? caret.value, input?.selectionEnd ?? caret.value, rules.value)
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
    const offset = editor.value?.selectionStart ?? 0
    const before = props.workbench.sql.value.slice(0, offset).replace(/\s/g, '').length
    const text = formattedSql(props.workbench.sql.value)
    props.workbench.sql.value = text
    let cursor = 0, seen = 0
    while (cursor < text.length && seen < before) if (!/\s/.test(text[cursor++]!)) seen++
    await nextTick(); editor.value?.setSelectionRange(cursor, cursor)
    error.value = ''
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '格式化失败' }
}
function updateCaret() {
  caret.value = editor.value?.selectionStart ?? 0
  completionIndex.value = 0
}
function onInput() {
  updateCaret()
  completionOpen.value = prefix.value.length > 0 || qualifier.value !== ''
}
function setSelection(start: number, end = start) {
  caret.value = start
  editor.value?.setSelectionRange(start, end)
}
function scroll() {
  if (editor.value && highlighter.value) { highlighter.value.scrollTop = editor.value.scrollTop; highlighter.value.scrollLeft = editor.value.scrollLeft }
}
async function acceptCompletion(index = completionIndex.value) {
  const word = candidates.value[index]
  if (!word || !editor.value) return
  const start = caret.value - prefix.value.length
  props.workbench.sql.value = props.workbench.sql.value.slice(0, start) + word + props.workbench.sql.value.slice(caret.value)
  const next = start + word.length
  completionOpen.value = false
  await nextTick(); editor.value.focus(); editor.value.setSelectionRange(next, next); caret.value = next
}
function keydown(event: KeyboardEvent) {
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
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); completionIndex.value = (completionIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(1, candidates.value.length)) % Math.max(1, candidates.value.length); return }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); void acceptCompletion(); return }
    if (event.key === 'Escape') { event.preventDefault(); completionOpen.value = false; return }
  }
  if (event.shiftKey && event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); void format(); return }
  if ((event.ctrlKey || event.metaKey) && event.code === 'Space') { event.preventDefault(); updateCaret(); completionIndex.value = 0; completionOpen.value = true; return }
  if (event.key === 'Tab') {
    event.preventDefault()
    const input = editor.value!
    const start = input.selectionStart, end = input.selectionEnd
    props.workbench.sql.value = props.workbench.sql.value.slice(0, start) + '  ' + props.workbench.sql.value.slice(end)
    void nextTick(() => input.setSelectionRange(start + 2, start + 2))
  }
}
defineExpose({ currentStatement, execute, executeCurrent, executeAll, format, editor, error, tokens, candidates, completionOpen, prefix, qualifier, caret, updateCaret, setSelection, acceptCompletion, keydown })
</script>

<template>
  <section class="vue-sql-editor">
    <div class="sql-actions"><button :disabled="disabled" @click="executeCurrent">执行当前</button><button :disabled="disabled" @click="executeAll">执行全部</button><button :disabled="disabled" @click="format">格式化</button><button :disabled="disabled" @click="completionOpen = !completionOpen; updateCaret()">补全</button><button :disabled="disabled" @click="emit('explain', currentStatement())">执行计划</button><button @click="emit('library')">历史 / 收藏</button><span class="spacer" /><small>⌘/Ctrl Enter 当前 · ⇧ Enter 全部 · ⇧⌥F 格式化</small></div>
    <div class="sql-code"><pre ref="highlighter" class="sql-highlight" aria-hidden="true"><template v-for="(token, index) in tokens" :key="index"><span :class="`sql-${token.kind}`">{{ token.text }}</span></template>{{ '\n' }}</pre><textarea id="sql-input" ref="editor" v-model="workbench.sql.value" spellcheck="false" aria-label="SQL 编辑器" :disabled="disabled" placeholder="输入 SQL；按连接保存草稿" @keydown="keydown" @click="updateCaret" @keyup="updateCaret" @input="onInput" @scroll="scroll" /></div>
    <div v-if="completionOpen" class="sql-completions" role="listbox" aria-label="SQL 补全"><button v-for="(candidate, index) in candidates" :key="candidate" :class="{ selected: index === completionIndex }" role="option" :aria-selected="index === completionIndex" @mousedown.prevent="acceptCompletion(index)">{{ candidate }}</button><span v-if="!candidates.length" class="muted">没有匹配项；展开元数据树以获得表列候选</span></div>
    <p v-if="error" class="is-error">{{ error }}</p>
  </section>
</template>

<style scoped>
.vue-sql-editor { position:relative; display:flex; flex-direction:column; flex:0 0 230px; min-height:120px; border-bottom:1px solid var(--border); resize:vertical; overflow:hidden; }
.sql-actions { display:flex; align-items:center; flex-wrap:wrap; gap:5px; padding:4px 8px; background:var(--bg-alt); }
.sql-actions small { color:var(--fg-dim); font-size:10px; }
.sql-code { flex:1; min-height:0; position:relative; }
.sql-code textarea,.sql-highlight { position:absolute; inset:0; margin:0; padding:10px; font:13px/1.6 var(--mono); letter-spacing:normal; white-space:pre; overflow:auto; tab-size:2; border:0; border-radius:0; width:100%; height:100%; resize:none; }
.sql-code textarea { color:transparent; caret-color:var(--fg); background:transparent; -webkit-text-fill-color:transparent; }
.sql-code textarea::selection { background:#4f8cff55; }
.sql-code textarea::placeholder { -webkit-text-fill-color:var(--fg-dim); }
.sql-highlight { pointer-events:none; color:var(--fg); }
.sql-keyword { color:#8fbbff; font-weight:600; }.sql-function { color:#d5a3ef; }.sql-string { color:#a9d48c; }.sql-comment { color:#7f8b8a; }.sql-number { color:#f2bf8a; }.sql-identifier { color:#d8d3a4; }
.sql-completions { position:absolute; top:55px; right:12px; width:260px; max-height:230px; overflow:auto; z-index:5; background:var(--bg-alt); border:1px solid var(--border); box-shadow:0 4px 20px #0008; }
.sql-completions button { display:block; width:100%; text-align:left; border:0; border-radius:0; font-family:var(--mono); }.sql-completions button.selected { background:#263d5c; }
</style>
