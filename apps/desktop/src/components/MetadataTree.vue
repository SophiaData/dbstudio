<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TreeNode, Workbench } from '../workbench'
import {
  CONNECTION_COLORS, TREE_PREFERENCES_KEY, TREE_ROW_HEIGHT,
  canPruneConnectionPreferences, connectionIdentity, flattenTree, loadConnectionPreferences, preferenceFor,
  pruneConnectionPreferences, rootConnectionId, treeWindow,
  type ConnectionColor, type ConnectionPreferences, type PreferenceStorage, type TreeRow
} from '../tree-model'

const props = withDefaults(defineProps<{ workbench: Workbench; nodes?: TreeNode[]; search?: string; height?: number }>(), { search: '', height: 0 })
const roots = computed(() => props.nodes ?? props.workbench.roots.value)
const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(props.height || 480)
const activeKey = ref('')
const collapsedGroups = ref(new Set<string>())
const preferences = ref<ConnectionPreferences>({})
const menu = ref<{ node: TreeNode; x: number; y: number } | null>(null)
const groupDraft = ref('')
const colorDraft = ref<ConnectionColor>('default')
let storage: PreferenceStorage | null = null
let resizeObserver: ResizeObserver | undefined
const rows = computed(() => flattenTree(roots.value, props.search, preferences.value, collapsedGroups.value))
const windowRange = computed(() => treeWindow(rows.value.length, scrollTop.value, viewportHeight.value))
const visibleRows = computed(() => rows.value.slice(windowRange.value.start, windowRange.value.end))
const rowHeight = TREE_ROW_HEIGHT
const colorValues: Record<ConnectionColor, string> = {
  default: 'inherit', blue: '#78b5ff', green: '#79d49b', amber: '#e9bb69', purple: '#c69bf4', red: '#f08c8c'
}
const colorLabels: Record<ConnectionColor, string> = { default: '默认', blue: '蓝色', green: '绿色', amber: '琥珀', purple: '紫色', red: '红色' }

function savePreferences(next: ConnectionPreferences) {
  preferences.value = next
  try { storage?.setItem(TREE_PREFERENCES_KEY, JSON.stringify(next)) }
  catch { props.workbench.setStatus('连接展示偏好无法保存在本机', true) }
}
function prunePreferences() {
  // Only an authoritative refresh can prove a saved connection was removed.
  if (!canPruneConnectionPreferences(props.workbench.metadataReady.value, props.workbench.booting.value)) return
  const next = pruneConnectionPreferences(roots.value, preferences.value)
  if (JSON.stringify(next) !== JSON.stringify(preferences.value)) savePreferences(next)
}
onMounted(() => {
  try { storage = window.localStorage } catch { storage = null }
  preferences.value = loadConnectionPreferences(storage)
  prunePreferences()
  if (typeof ResizeObserver !== 'undefined' && viewport.value) {
    resizeObserver = new ResizeObserver(entries => {
      const height = entries[0]?.contentRect.height
      if (height && height > 0) viewportHeight.value = height
    })
    resizeObserver.observe(viewport.value)
  }
})
onBeforeUnmount(() => resizeObserver?.disconnect())
watch(() => [roots.value, props.workbench.booting.value, props.workbench.metadataReady.value], () => { prunePreferences(); menu.value = null })
watch(() => props.height, height => { if (height > 0) viewportHeight.value = height })
watch(() => props.search, () => { if (viewport.value) viewport.value.scrollTop = 0; scrollTop.value = 0; menu.value = null })
watch(() => rows.value.length, () => {
  const max = Math.max(0, rows.value.length * rowHeight - viewportHeight.value)
  if (scrollTop.value > max) {
    scrollTop.value = max
    if (viewport.value) viewport.value.scrollTop = max
  }
})

function select(node: TreeNode) {
  activeKey.value = node.ref.id
  props.workbench.selectNode(node.ref)
}
function activate(node: TreeNode) {
  select(node)
  if (node.ref.kind === 'table' || node.ref.kind === 'view') void props.workbench.attempt(() => props.workbench.openTable(node.ref))
  else void props.workbench.attempt(() => props.workbench.toggleNode(node))
}
function toggleGroup(name: string) {
  const next = new Set(collapsedGroups.value)
  if (next.has(name)) next.delete(name); else next.add(name)
  collapsedGroups.value = next
}
function openMenu(node: TreeNode, event: MouseEvent) {
  event.preventDefault()
  select(node)
  const bounds = viewport.value?.getBoundingClientRect()
  menu.value = { node, x: Math.max(0, Math.min(event.clientX - (bounds?.left ?? 0), (bounds?.width ?? 260) - 220)), y: Math.max(0, Math.min(event.clientY - (bounds?.top ?? 0), viewportHeight.value - 260)) }
  const preference = preferenceFor(node, preferences.value)
  groupDraft.value = preference.group
  colorDraft.value = preference.color
}
async function refresh(node: TreeNode) {
  menu.value = null
  if (node.loading) return
  await props.workbench.attempt(async () => {
    const row = rows.value.find(row => row.kind === 'node' && row.node === node)
    const target = node.ref.hasChildren ? node : row?.kind === 'node' ? row.parent : null
    if (!target) return props.workbench.refreshConnections()
    if (target.loading) return
    // Invalidate only this node's (or a leaf's parent's) cache; workbench owns backend calls.
    target.loaded = false
    target.expanded = false
    target.error = ''
    await props.workbench.toggleNode(target)
  })
}
async function copy(text: string) {
  menu.value = null
  await props.workbench.attempt(async () => {
    if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持剪贴板写入')
    await navigator.clipboard.writeText(text)
    props.workbench.setStatus('已复制')
  })
}
function applyPreference() {
  const node = menu.value?.node
  if (!node) return
  const id = rootConnectionId(node)
  if (id === null) return
  savePreferences({ ...preferences.value, [id]: { color: colorDraft.value, group: groupDraft.value.trim().slice(0, 80), identity: connectionIdentity(node) } })
  menu.value = null
}
async function focusRow(row: TreeRow) {
  activeKey.value = row.key
  const index = rows.value.findIndex(candidate => candidate.key === row.key)
  if (viewport.value) {
    const top = index * rowHeight
    if (top < scrollTop.value) viewport.value.scrollTop = top
    else if (top + rowHeight > scrollTop.value + viewportHeight.value) viewport.value.scrollTop = top + rowHeight - viewportHeight.value
    scrollTop.value = viewport.value.scrollTop
  }
  await nextTick()
  // Compare dataset values directly; object names and IDs never become CSS selectors.
  const elements = viewport.value?.querySelectorAll<HTMLElement>('[data-tree-key]')
  const target = elements && Array.from(elements).find(element => element.dataset.treeKey === row.key)
  target?.focus()
}
function keydown(event: KeyboardEvent, row: TreeRow) {
  if (event.key === 'Escape') { menu.value = null; return }
  if (row.kind === 'node' && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) {
    event.preventDefault()
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
    openMenu(row.node, new MouseEvent('contextmenu', { clientX: bounds.left + 24, clientY: bounds.bottom }))
    void nextTick(() => viewport.value?.parentElement?.querySelector<HTMLElement>('.tree-context button')?.focus())
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    const candidates = rows.value.filter(candidate => candidate.kind !== 'message')
    const index = candidates.findIndex(candidate => candidate.key === row.key)
    const target = event.key === 'Home' ? candidates[0] : event.key === 'End' ? candidates[candidates.length - 1]
      : candidates[Math.max(0, Math.min(candidates.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
    if (target) void focusRow(target)
  } else if (row.kind === 'group' && ['Enter', ' ', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault()
    if (event.key === 'ArrowRight' && row.expanded || event.key === 'ArrowLeft' && !row.expanded) return
    toggleGroup(row.name)
  } else if (row.kind === 'node') {
    if (event.key === 'Enter') { event.preventDefault(); activate(row.node) }
    else if (event.key === ' ') { event.preventDefault(); select(row.node) }
    else if (event.key === 'ArrowRight' && row.node.ref.hasChildren && !row.node.expanded) {
      event.preventDefault(); void props.workbench.attempt(() => props.workbench.toggleNode(row.node))
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (row.node.expanded) void props.workbench.attempt(() => props.workbench.toggleNode(row.node))
      else if (row.parent) { select(row.parent); void focusRow({ kind: 'node', key: row.parent.ref.id, node: row.parent, parent: null, depth: 0 }) }
    }
  }
}
defineExpose({ rows, select, activate, preferences, collapsedGroups, activeKey, refresh, savePreferences, prunePreferences, toggleGroup, windowRange, visibleRows })
</script>

<template>
  <div class="metadata-tree" @keydown.esc.stop="menu = null">
    <div ref="viewport" class="tree-viewport" role="tree" aria-label="数据库对象" :style="height > 0 ? { height: `${height}px` } : undefined" @scroll="scrollTop = ($event.target as HTMLElement).scrollTop; menu = null" @click.self="menu = null">
      <div class="tree-spacer" :style="{ height: `${windowRange.total}px` }">
        <div class="tree-window" :style="{ transform: `translateY(${windowRange.offset}px)` }">
          <template v-for="row in visibleRows" :key="row.key">
            <div v-if="row.kind === 'group'" class="tree-row tree-display-group" role="treeitem" :aria-expanded="row.expanded" aria-level="1" :data-tree-key="row.key" :tabindex="activeKey === row.key || !activeKey ? 0 : -1" @click="toggleGroup(row.name)" @keydown="keydown($event, row)">
              <span class="twisty">{{ row.expanded ? '▾' : '▸' }}</span><span class="row-label">{{ row.name }}</span>
            </div>
            <div v-else-if="row.kind === 'message'" class="tree-note" :class="{ 'is-error': row.error }" :style="{ paddingLeft: `${30 + row.depth * 16}px` }" :title="row.text">{{ row.text }}</div>
            <div v-else class="tree-row" role="treeitem" :class="{ 'is-selected': workbench.selected.value?.id === row.node.ref.id }" :style="{ paddingLeft: `${8 + row.depth * 16}px` }" :aria-level="row.depth + 1" :aria-selected="workbench.selected.value?.id === row.node.ref.id" :aria-expanded="row.node.ref.hasChildren ? row.node.expanded : undefined" :aria-busy="row.node.loading" :data-node-id="row.node.ref.id" :data-tree-key="row.key" :tabindex="activeKey === row.key || !activeKey ? 0 : -1" @click="select(row.node); menu = null" @dblclick="activate(row.node)" @keydown="keydown($event, row)" @contextmenu="openMenu(row.node, $event)">
              <button v-if="row.node.ref.hasChildren" class="twisty" tabindex="-1" :aria-label="row.node.expanded ? '折叠' : '展开'" :disabled="row.node.loading" @click.stop="workbench.attempt(() => workbench.toggleNode(row.node))">{{ row.node.loading ? '…' : row.node.expanded ? '▾' : '▸' }}</button><span v-else class="twisty-space" />
              <span class="node-icon" :style="row.node.ref.kind === 'connection' ? { color: colorValues[preferenceFor(row.node, preferences).color] } : undefined" aria-hidden="true">{{ row.node.ref.kind === 'connection' ? row.node.ref.meta?.connected ? '●' : '○' : row.node.ref.kind === 'table' ? '▦' : row.node.ref.kind === 'view' ? '▤' : '▱' }}</span>
              <span class="row-label" :title="row.node.ref.name">{{ row.node.ref.name }}</span>
              <button class="node-menu-button" tabindex="-1" aria-label="对象操作" @click.stop="openMenu(row.node, $event)">⋯</button>
            </div>
          </template>
        </div>
      </div>
      <p v-if="!rows.length" class="muted tree-empty">{{ search ? '已展开对象中没有匹配项' : '无连接对象' }}</p>
    </div>
    <div v-if="menu" class="tree-context" :style="{ top: `${menu.y}px`, left: `${menu.x}px` }" role="region" aria-label="对象操作">
      <button type="button" :disabled="menu.node.loading" @click="refresh(menu.node)">刷新对象</button>
      <button type="button" @click="copy(menu.node.ref.name)">复制名称</button>
      <button type="button" @click="copy(menu.node.ref.id)">复制对象 ID</button>
      <form v-if="rootConnectionId(menu.node) !== null" @submit.prevent="applyPreference">
        <label>连接颜色<select v-model="colorDraft"><option v-for="color in CONNECTION_COLORS" :key="color" :value="color">{{ colorLabels[color] }}</option></select></label>
        <label>分组<input v-model="groupDraft" maxlength="80" placeholder="未分组" /></label>
        <button type="submit">保存展示偏好</button>
      </form>
      <button type="button" @click="menu = null">关闭</button>
    </div>
  </div>
</template>

<style scoped>
.metadata-tree { position: relative; display:flex; flex-direction:column; height:100%; min-height: 0; }
.tree-viewport { overflow: auto; position: relative; flex:1; min-height: 96px; overscroll-behavior: contain; }
.tree-spacer { position: relative; }
.tree-window { position: absolute; inset: 0 0 auto; }
.tree-row, .tree-note { height: 32px; box-sizing: border-box; }
.tree-row { display: flex; align-items: center; gap: 4px; padding-right: 4px; }
.tree-row:focus-visible { outline: 1px solid #78b5ff; outline-offset: -1px; }
.row-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.tree-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 32px; opacity: .8; }
.tree-display-group { padding-left: 8px; font-weight: 600; }
.node-menu-button { margin-left: auto; padding: 0 5px; border: 0; background: transparent; color: inherit; }
.tree-context { position: absolute; z-index: 20; width: 210px; max-height: 280px; overflow: auto; padding: 6px; background: #202733; border: 1px solid #495366; border-radius: 4px; box-shadow: 0 4px 16px #0006; }
.tree-context > button { display: block; width: 100%; text-align: left; padding: 5px 8px; }
.tree-context form { display: grid; gap: 6px; padding: 6px 0; }
.tree-context label { display: grid; gap: 3px; font-size: 12px; }
.tree-context input, .tree-context select { width: 100%; box-sizing: border-box; }
.tree-empty { padding: 8px; }
</style>
