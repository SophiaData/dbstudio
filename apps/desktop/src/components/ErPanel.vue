<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { computeErRelations, relationStatusToken, type ErRelation, type ErTableInput } from '../../../../src/renderer/er-relations'
import { buildErLayoutKey, loadErLayout, saveErLayout, type ErLayoutPositions } from '../../../../src/renderer/er-layout'
import { backend, errorText, saveTextExport } from '../backend'
import { connectionNode, type Workbench } from '../workbench'
import type { ObjectRef } from '../../../../src/core/model'

const props = defineProps<{ workbench: Workbench; connectionId: string }>()
const emit = defineEmits<{ close: [] }>()
const MAX_TABLES = 100
const MAX_DIRECTORIES = 2000
const MAX_CATALOG_TABLES = 10000
const BOX_WIDTH = 290
const HEADER_HEIGHT = 40
const ROW_HEIGHT = 21
const FOOTER_HEIGHT = 25
const PAD = 24
const MAX_POSITION = 500000
interface TableOption { ref: ObjectRef; schema: string | null }
interface Position { x: number; y: number }
const tables = ref<ErTableInput[]>([])
const catalog = ref<TableOption[]>([])
const selectedIds = ref(new Set<string>())
const search = ref('')
const positions = reactive<Record<string, Position>>({})
const drawnSchemas = ref<Record<string, string | null>>({})
const busy = ref(false)
const exporting = ref(false)
const error = ref('')
const notice = ref('')
const limited = ref(false)
const skippedTables = ref(0)
const layoutWarning = ref('')
const layoutKey = ref('')
const svgRoot = ref<SVGSVGElement | null>(null)
const markerId = `er-arrow-${Math.random().toString(36).slice(2)}`
const connectionDialectId = computed(() => props.workbench.connections.value.find((connection) => connection.id === props.connectionId)?.dialectId ?? null)
const relations = computed(() => computeErRelations(tables.value, { dialectId: connectionDialectId.value }))
const filtered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return catalog.value.filter((table) => label(table).toLocaleLowerCase().includes(query))
})
const selectionValid = computed(() => selectedIds.value.size > 0 && selectedIds.value.size <= MAX_TABLES)
const width = computed(() => Math.max(960, ...tables.value.map((table) => (positions[table.ref.id]?.x ?? 0) + BOX_WIDTH + 100)))
const height = computed(() => Math.max(600, ...tables.value.map((table) => (positions[table.ref.id]?.y ?? 0) + tableHeight(table) + PAD)))
const status = computed(() => {
  const summary = relations.value
  if (summary.metadataState === 'unavailable') {
    return `部分表未提供外键元数据；已绘制 ${summary.relations.length} 条已知关系，无法确认完整关系。`
  }
  if (summary.skipped.length) return `已绘制 ${summary.relations.length} 条外键；另有 ${summary.skipped.length} 条未绘制。`
  if (summary.hasRelations) return `已绘制 ${summary.relations.length} 条外键关系。`
  return '无外键关系：驱动已确认当前图中的表没有外键。'
})
let generation = 0
let disposed = false
let dragState: { id: string; pointer: number; element: SVGElement; origin: Position; start: Position } | null = null

function label(table: TableOption) { return table.schema === null ? table.ref.name : `${table.schema}.${table.ref.name}` }
function tableLabel(table: ErTableInput) {
  const schema = drawnSchemas.value[table.ref.id]
  return schema == null ? table.ref.name : `${schema}.${table.ref.name}`
}
function tableHeight(table: ErTableInput) { return HEADER_HEIGHT + Math.max(1, table.desc.columns.length) * ROW_HEIGHT + FOOTER_HEIGHT }
function short(value: string, length: number) { return value.length > length ? `${value.slice(0, length - 1)}…` : value }
function coordinates(id: string): Position { return positions[id] ?? { x: PAD, y: PAD } }
function toggle(id: string, checked: boolean) {
  const next = new Set(selectedIds.value)
  if (checked) next.add(id)
  else next.delete(id)
  selectedIds.value = next
}
function selectVisible(checked: boolean) {
  const next = new Set(selectedIds.value)
  for (const table of filtered.value) {
    if (checked) next.add(table.ref.id)
    else next.delete(table.ref.id)
  }
  selectedIds.value = next
}
function storedLayout(key: string, ids?: string[]): ErLayoutPositions {
  try { return loadErLayout(window.localStorage, key, ids) }
  catch { return {} }
}
function persistLayout() {
  if (!layoutKey.value || !tables.value.length) return
  try {
    // Preserve positions for tables temporarily omitted by this selection in the same schema set.
    const all = { ...storedLayout(layoutKey.value), ...positions }
    layoutWarning.value = saveErLayout(window.localStorage, layoutKey.value, all) ? '' : '布局未能保存到本机，当前图仍可使用。'
  } catch { layoutWarning.value = '布局未能保存到本机，当前图仍可使用。' }
}
function applyLayout(restore: boolean) {
  const saved = restore ? storedLayout(layoutKey.value, tables.value.map((table) => table.ref.id)) : {}
  for (const id of Object.keys(positions)) delete positions[id]
  let y = PAD + 26
  for (let start = 0; start < tables.value.length; start += 3) {
    const row = tables.value.slice(start, start + 3)
    for (const [index, table] of row.entries()) {
      const position = saved[table.ref.id]
      positions[table.ref.id] = position && position.x <= MAX_POSITION && position.y <= MAX_POSITION
        ? { ...position } : { x: PAD + index * (BOX_WIDTH + 55), y }
    }
    y += Math.max(...row.map(tableHeight)) + 45
  }
}
function resetLayout() { endDrag(); applyLayout(false); persistLayout() }
async function drawSelected(loadGeneration?: number) {
  if (!selectionValid.value) {
    notice.value = selectedIds.value.size ? `已选择 ${selectedIds.value.size} 张表，最多绘制 ${MAX_TABLES} 张，请取消部分选择。` : '请至少选择一张表后再绘制。'
    return
  }
  endDrag()
  const current = loadGeneration ?? ++generation
  const selected = catalog.value.filter((table) => selectedIds.value.has(table.ref.id))
  const connection = props.connectionId
  busy.value = true; error.value = ''; notice.value = ''; skippedTables.value = 0
  const loaded: ErTableInput[] = []
  let failed = 0
  try {
    for (const table of selected) {
      try {
        const desc = await backend.describeTable(table.ref.id)
        if (current !== generation || disposed) return
        loaded.push({ ref: table.ref, desc })
      } catch {
        if (current !== generation || disposed) return
        failed++
      }
    }
    if (current !== generation || disposed) return
    tables.value = loaded
    drawnSchemas.value = Object.fromEntries(selected.map((table) => [table.ref.id, table.schema]))
    skippedTables.value = failed
    layoutKey.value = buildErLayoutKey(connectionNode(connection), selected.map((table) => table.schema))
    layoutWarning.value = ''
    applyLayout(true)
    if (!loaded.length) notice.value = '所选表的结构均未能读取，请检查连接后重试。'
  } catch (cause) {
    if (current === generation && !disposed) error.value = errorText(cause)
  } finally {
    if (current === generation && !disposed) busy.value = false
  }
}
async function load() {
  endDrag()
  const current = ++generation
  const connection = props.connectionId
  const previousSelection = new Set(selectedIds.value)
  busy.value = true; error.value = ''; notice.value = ''; tables.value = []; limited.value = false; skippedTables.value = 0
  try {
    const found: TableOption[] = []
    const tableIds = new Set<string>()
    const queue: { id: string; schema: string | null; depth: number }[] = [{ id: connectionNode(connection), schema: null, depth: 0 }]
    const visited = new Set<string>()
    let cursor = 0
    let truncated = false
    while (cursor < queue.length && visited.size < MAX_DIRECTORIES && found.length < MAX_CATALOG_TABLES) {
      const item = queue[cursor++]!
      if (visited.has(item.id)) continue
      visited.add(item.id)
      const children = await backend.listChildren(item.id)
      if (current !== generation || disposed) return
      for (const node of children) {
        if (node.kind === 'table' && !tableIds.has(node.id)) {
          if (found.length >= MAX_CATALOG_TABLES) { truncated = true; continue }
          tableIds.add(node.id); found.push({ ref: node, schema: item.schema })
        } else if (node.hasChildren && ['catalog', 'schema', 'folder'].includes(node.kind) && !visited.has(node.id)) {
          if (item.depth >= 8 || queue.length >= MAX_DIRECTORIES) { truncated = true; continue }
          queue.push({ id: node.id, schema: node.kind === 'schema' ? node.name : item.schema, depth: item.depth + 1 })
        }
      }
    }
    if (current !== generation || disposed) return
    found.sort((a, b) => label(a).localeCompare(label(b)))
    catalog.value = found
    limited.value = truncated || cursor < queue.length
    const retained = found.filter((table) => previousSelection.has(table.ref.id)).map((table) => table.ref.id)
    const defaultSchema = found.find((table) => table.schema !== null)?.schema ?? null
    selectedIds.value = retained.length ? new Set(retained) : found.length <= MAX_TABLES
      ? new Set(found.filter((table) => table.schema === null || table.schema === defaultSchema).map((table) => table.ref.id)) : new Set()
    if (selectionValid.value) await drawSelected(current)
    else notice.value = found.length ? `发现 ${found.length} 张表，请搜索并选择不超过 ${MAX_TABLES} 张表后绘制。` : '该连接下没有可绘制的表。'
  } catch (cause) {
    if (current === generation && !disposed) { catalog.value = []; error.value = errorText(cause) }
  } finally {
    if (current === generation && !disposed) busy.value = false
  }
}
function svgPoint(event: PointerEvent): Position {
  const matrix = svgRoot.value?.getScreenCTM()
  if (!matrix) return { x: event.clientX, y: event.clientY }
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
  return { x: point.x, y: point.y }
}
function drag(event: PointerEvent, id: string) {
  if (event.button !== 0 || busy.value) return
  endDrag()
  const element = event.currentTarget as SVGElement
  dragState = { id, pointer: event.pointerId, element, origin: { ...coordinates(id) }, start: svgPoint(event) }
  element.setPointerCapture(event.pointerId)
  event.preventDefault()
}
function moveDrag(event: PointerEvent) {
  if (!dragState || dragState.pointer !== event.pointerId) return
  const point = svgPoint(event)
  positions[dragState.id] = {
    x: Math.min(MAX_POSITION, Math.max(PAD, dragState.origin.x + point.x - dragState.start.x)),
    y: Math.min(MAX_POSITION, Math.max(PAD + 26, dragState.origin.y + point.y - dragState.start.y))
  }
}
function endDrag() {
  if (!dragState) return
  const { element, pointer } = dragState
  dragState = null
  if (element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer)
  persistLayout()
}
function moveByKey(event: KeyboardEvent, id: string) {
  const direction: Record<string, Position> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } }
  const step = direction[event.key]
  if (!step || busy.value) return
  event.preventDefault()
  const origin = coordinates(id), scale = event.shiftKey ? 25 : 5
  positions[id] = { x: Math.min(MAX_POSITION, Math.max(PAD, origin.x + step.x * scale)), y: Math.min(MAX_POSITION, Math.max(PAD + 26, origin.y + step.y * scale)) }
  persistLayout()
}
function endpoint(id: string, column: string | undefined, right: boolean): Position {
  const table = tables.value.find((table) => table.ref.id === id)
  const position = coordinates(id)
  const index = table?.desc.columns.findIndex((item) => item.name === column) ?? -1
  return { x: position.x + (right ? BOX_WIDTH : 0), y: position.y + HEADER_HEIGHT + (Math.max(0, index) + 0.5) * ROW_HEIGHT }
}
function edgePath(edge: ErRelation) {
  const left = coordinates(edge.from.tableId), right = coordinates(edge.to.tableId)
  const forward = right.x >= left.x
  const source = endpoint(edge.from.tableId, edge.columnPairs[0]?.column, forward)
  const self = edge.from.tableId === edge.to.tableId
  const target = endpoint(edge.to.tableId, edge.columnPairs[0]?.referencedColumn, self || !forward)
  if (self) {
    return `M ${source.x} ${source.y} C ${source.x + 75} ${source.y - 35}, ${target.x + 75} ${target.y + 35}, ${target.x} ${target.y}`
  }
  const bend = Math.max(40, Math.abs(target.x - source.x) * 0.45)
  return `M ${source.x} ${source.y} C ${source.x + (forward ? bend : -bend)} ${source.y}, ${target.x + (forward ? -bend : bend)} ${target.y}, ${target.x} ${target.y}`
}
function edgeTitle(edge: ErRelation) {
  return `${edge.from.schema ? `${edge.from.schema}.` : ''}${edge.from.tableName} → ${edge.to.schema ? `${edge.to.schema}.` : ''}${edge.to.tableName}: ${edge.columnPairs.map((pair) => `${pair.column} → ${pair.referencedColumn}`).join(', ')}${edge.constraintName ? ` · ${edge.constraintName}` : ''}${edge.onDelete ? ` · ON DELETE ${edge.onDelete}` : ''}${edge.onUpdate ? ` · ON UPDATE ${edge.onUpdate}` : ''}`
}
function serializeSvg(): string {
  if (!svgRoot.value || !tables.value.length) throw new Error('当前没有可导出的 ER 图')
  const clone = svgRoot.value.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('version', '1.1')
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`
}
async function exportSvg() {
  if (exporting.value || busy.value || !tables.value.length) return
  exporting.value = true; error.value = ''; notice.value = ''
  try {
    const content = serializeSvg()
    if (new TextEncoder().encode(content).byteLength > 16 * 1024 * 1024) {
      throw new Error('SVG 超过 16 MiB，请减少选表数量后重试')
    }
    const saved = await saveTextExport({ suggestedName: 'dbstudio-er.svg', content })
    notice.value = saved === null ? '已取消保存 SVG。' : 'ER 图 SVG 已保存。'
  } catch (cause) { error.value = errorText(cause) }
  finally { exporting.value = false }
}
defineExpose({
  refresh: load, load, tables, relations, busy, error, serializeSvg, exportSvg,
  catalog, selectedIds, positions, toggle, selectVisible, drawSelected, moveByKey, resetLayout,
  svgRoot, layoutKey, layoutWarning, notice, skippedTables
})
watch(() => props.connectionId, () => {
  selectedIds.value = new Set(); catalog.value = []; search.value = ''
  void load()
}, { immediate: true })
onBeforeUnmount(() => { endDrag(); disposed = true; generation++ })
</script>

<template>
  <section class="tool-panel er-panel">
    <header class="pane-toolbar">
      <strong>ER 关系图</strong><span class="muted">{{ tables.length }} 张表 · {{ relations.relations.length }} 条已绘制关系</span><span class="spacer" />
      <button :disabled="busy" @click="load">刷新结构</button>
      <button :disabled="busy || !tables.length" @click="resetLayout">重置布局</button>
      <button data-er-export :disabled="busy || exporting || !tables.length" @click="exportSvg">{{ exporting ? '正在保存…' : '导出 SVG' }}</button>
      <button @click="emit('close')">返回结果</button>
    </header>
    <section class="er-picker" aria-label="ER 图表选择">
      <div class="er-picker-controls">
        <label>筛选表 <input v-model="search" type="search" placeholder="表名或 schema" data-er-search :disabled="busy" /></label>
        <span class="muted" aria-live="polite">已选 {{ selectedIds.size }} / {{ MAX_TABLES }} 张 · 当前显示 {{ filtered.length }} / {{ catalog.length }} 张</span>
        <button data-er-select-visible :disabled="busy || !filtered.length" @click="selectVisible(true)">全选当前结果</button>
        <button data-er-clear-visible :disabled="busy || !filtered.length" @click="selectVisible(false)">清空当前结果</button>
        <button data-er-draw :disabled="busy || !selectionValid" @click="drawSelected()">绘制 ER 图</button>
      </div>
      <div class="er-picker-list" role="group" aria-label="可绘制的表">
        <label v-for="table in filtered" :key="table.ref.id" class="er-picker-option" :data-er-table-option="table.ref.id" :title="label(table)">
          <input type="checkbox" :data-er-table-checkbox="table.ref.id" :checked="selectedIds.has(table.ref.id)" :disabled="busy" @change="toggle(table.ref.id, ($event.target as HTMLInputElement).checked)" />
          <span>{{ label(table) }}</span>
        </label>
        <span v-if="!filtered.length && catalog.length" class="muted">没有匹配的表</span>
      </div>
    </section>
    <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
    <p v-if="notice" class="tool-note" role="status">{{ notice }}</p>
    <p v-if="selectedIds.size > MAX_TABLES" class="warning" role="alert">最多绘制 {{ MAX_TABLES }} 张表，请取消部分选择；当前图保持不变。</p>
    <p v-if="limited || skippedTables" class="warning">{{ limited ? '表目录达到读取上限，未发现部分不代表没有关系；请从更小范围查看。' : '' }}{{ skippedTables ? ` ${skippedTables} 张表结构读取失败，当前图不完整。` : '' }}</p>
    <p v-if="layoutWarning" class="warning">{{ layoutWarning }}</p>
    <p v-if="tables.length" class="tool-note" :class="{ warning: relations.metadataState === 'unavailable' || relations.skipped.length }" :data-er-status="relationStatusToken(relations)">{{ status }}</p>
    <details v-if="relations.skipped.length" class="tool-note"><summary>{{ relations.skipped.length }} 条关系未绘制</summary><p v-for="(skip, index) in relations.skipped" :key="index">{{ skip.detail }}</p></details>
    <div class="er-scroll">
      <p v-if="busy" class="empty muted">正在按需读取表结构…</p>
      <svg v-else-if="tables.length" ref="svgRoot" data-er-root :data-er-status="relationStatusToken(relations)" class="er-svg" :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" role="img" aria-label="表、列与外键关系图" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag">
        <title>ER 关系图：{{ tables.length }} 张表，{{ relations.relations.length }} 条外键</title>
        <desc>{{ status }}{{ skippedTables ? ` ${skippedTables} 张表结构读取失败。` : '' }}{{ relations.skipped.map((item) => item.detail).join('；') }}</desc>
        <rect width="100%" height="100%" fill="#1b1d21" />
        <text :x="PAD" y="25" fill="#9aa3ad">{{ status }}</text>
        <defs><marker :id="markerId" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#4f8cff" /></marker></defs>
        <g class="er-relation-layer">
          <path v-for="edge in relations.relations" :key="edge.id" :data-er-edge="edge.id" :data-source-table="edge.from.tableName" :data-target-table="edge.to.tableName" :d="edgePath(edge)" fill="none" stroke="#4f8cff" stroke-width="1.6" :marker-end="`url(#${markerId})`"><title>{{ edgeTitle(edge) }}</title></path>
        </g>
        <g v-for="table in tables" :key="table.ref.id" class="er-entity" :data-table-id="table.ref.id" :data-table-name="table.ref.name" :data-schema="drawnSchemas[table.ref.id] ?? undefined" :transform="`translate(${coordinates(table.ref.id).x},${coordinates(table.ref.id).y})`">
          <title>{{ tableLabel(table) }}，{{ table.desc.columns.length }} 列</title>
          <rect :width="BOX_WIDTH" :height="tableHeight(table)" rx="5" fill="#1b1d21" stroke="#48515d" />
          <g class="er-entity-handle" role="button" tabindex="0" :aria-label="`移动表 ${tableLabel(table)}，可拖动或使用方向键`" @pointerdown="drag($event, table.ref.id)" @keydown="moveByKey($event, table.ref.id)">
            <rect :width="BOX_WIDTH" :height="HEADER_HEIGHT" rx="5" fill="#23262b" />
            <text x="10" y="25" fill="#e6e8eb" font-size="12" font-weight="600">{{ short(tableLabel(table), 34) }}<title>{{ tableLabel(table) }}</title></text>
          </g>
          <g v-for="(column, index) in table.desc.columns" :key="column.name" :data-column-name="column.name" :transform="`translate(0,${HEADER_HEIGHT + index * ROW_HEIGHT})`">
            <title>{{ column.name }} : {{ column.typeName }}{{ column.primaryKeyOrdinal != null ? '（主键）' : '' }}{{ !column.nullable ? ' NOT NULL' : '' }}</title>
            <text x="9" y="15" fill="#e6e8eb">{{ column.primaryKeyOrdinal != null ? '◆' : ' ' }} {{ short(column.name, 22) }}</text>
            <text :x="BOX_WIDTH - 9" y="15" text-anchor="end" fill="#9aa3ad" font-size="10">{{ short(column.typeName, 15) }}</text>
          </g>
          <text x="10" :y="tableHeight(table) - 9" :fill="table.desc.foreignKeys === undefined ? '#f2c46d' : '#9aa3ad'" font-size="10">{{ table.desc.foreignKeys === undefined ? '外键元数据未提供' : table.desc.foreignKeys.length ? `${table.desc.foreignKeys.length} 条已知外键` : '已确认无外键' }}</text>
        </g>
      </svg>
      <p v-else class="empty muted">{{ catalog.length ? '选择表后点击“绘制 ER 图”' : '没有可展示的表结构' }}</p>
    </div>
  </section>
</template>

<style scoped>
.er-picker { padding:8px 10px; border-bottom:1px solid var(--border); }
.er-picker-controls { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.er-picker-controls label { display:flex; align-items:center; gap:7px; }
.er-picker-controls input { width:210px; }
.er-picker-list { display:flex; flex-wrap:wrap; gap:4px 15px; max-height:125px; overflow:auto; margin-top:7px; }
.er-picker-option { display:flex; align-items:center; gap:5px; min-width:120px; max-width:300px; cursor:pointer; }
.er-picker-option span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.er-picker-option input { flex:none; }
.er-scroll { position:relative; }
.er-svg { display:block; flex:none; }
.er-entity-handle { cursor:grab; user-select:none; touch-action:none; }
.er-entity-handle:active { cursor:grabbing; }
.er-entity-handle:focus-visible { outline:2px solid #4f8cff; outline-offset:2px; }
.er-relation-layer path { pointer-events:stroke; }
.er-panel .warning { margin:0; padding:5px 10px; }
</style>
