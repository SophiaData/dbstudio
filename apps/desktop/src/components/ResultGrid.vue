<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { CellValue, ResultRow } from '../../../../src/core/resultset'
import { backend, errorText } from '../backend'
import CellViewer from './CellViewer.vue'
import LoadedExportDialog from './LoadedExportDialog.vue'
import { fullCell, textValue } from '../result-export'
import { writeClipboardText } from '../clipboard'
import { cellText, inputCell, type Workbench, type ResultTab } from '../workbench'

const props = defineProps<{ workbench: Workbench; tab: ResultTab }>()
const editing = ref<{ row: ResultRow; column: number; raw: string; kind: string; isNull: boolean } | null>(null)
const insertOpen = ref(false)
watch([editing, insertOpen], ([cell, insert]) => {
  if (cell || insert) props.workbench.pendingEditors.add(props.tab.id)
  else props.workbench.pendingEditors.delete(props.tab.id)
}, { flush: 'sync' })
let editRequest = 0
let disposed = false
function invalidateCellEdit() { editRequest++; editing.value = null }
onBeforeUnmount(() => {
  disposed = true
  invalidateCellEdit()
  props.workbench.pendingEditors.delete(props.tab.id)
})
const insertValues = reactive<Record<string, string>>({})
const insertInclude = reactive(new Set<string>())
const insertNulls = reactive(new Set<string>())
const error = ref('')
const selectedCell = ref<{ row: ResultRow; column: number } | null>(null)
const viewer = ref<{ value: CellValue; title: string } | null>(null)
const loadedExport = ref(false)
const loadedExportController = ref<InstanceType<typeof LoadedExportDialog> | null>(null)
const rowCount = ref<number | null>(null)
const reading = ref(false)
watch([
  () => props.tab, () => props.tab.result, () => props.tab.page, () => props.tab.generation,
  () => props.tab.result?.cursorId, () => props.tab.invalidated
], () => {
  invalidateCellEdit()
  selectedCell.value = null
  viewer.value = null
  rowCount.value = null
}, { flush: 'sync' })
function selectCell(row: ResultRow, column: number) { selectedCell.value = { row, column } }
function readSelected() { if (selectedCell.value) void readCell(selectedCell.value.row, selectedCell.value.column) }
function copySelected(wholeRow: boolean) { if (selectedCell.value) void copyCell(wholeRow) }
async function readCell(row: ResultRow, column: number) {
  if (locked.value || reading.value || props.tab.invalidated) return
  reading.value = true; props.tab.busy = true; error.value = ''
  try { viewer.value = { value: await fullCell(props.tab, row.index, column, displayed(row, column)), title: props.tab.page!.columns[column]!.name } }
  catch (cause) { error.value = errorText(cause) }
  finally { reading.value = false; props.tab.busy = false }
}
async function buildCopyText(wholeRow = false): Promise<string | null> {
  const selected = selectedCell.value
  if (!selected || props.tab.invalidated) return null
  const columns = wholeRow ? props.tab.page!.columns.map((_, index) => index) : [selected.column]
  const cells: string[] = []
  for (const column of columns) cells.push(textValue(await fullCell(props.tab, selected.row.index, column, displayed(selected.row, column))) ?? '')
  return cells.join('\t')
}
async function copyCell(wholeRow = false) {
  const selected = selectedCell.value
  if (!selected || locked.value || reading.value) return
  reading.value = true; props.tab.busy = true
  try {
    const text = await buildCopyText(wholeRow)
    await writeClipboardText(text ?? '')
    props.workbench.setStatus(wholeRow ? '已复制整行（Tab 分隔，NULL 为空字符串）' : '已复制单元格（NULL 为空字符串）')
  } catch (cause) { error.value = `复制失败：${errorText(cause)}` }
  finally { reading.value = false; props.tab.busy = false }
}
async function countRows() {
  if (!props.tab.table || locked.value) return
  props.tab.busy = true; error.value = ''
  try { rowCount.value = await backend.countRows(props.tab.table.id); props.workbench.setStatus(`完整对象共 ${rowCount.value} 行（不含当前筛选）`) }
  catch (cause) { error.value = errorText(cause) }
  finally { props.tab.busy = false }
}
async function openCell(row: ResultRow, column: number) {
  if (locked.value) return
  selectCell(row, column)
  const cell = displayed(row, column)
  if (writable.value && cell.kind !== 'blob') await edit(row, column)
  else await readCell(row, column)
}
async function openLoadedExport() {
  if (!props.tab.page || locked.value || props.tab.invalidated) return
  loadedExport.value = true
  await nextTick()
  return loadedExportController.value
}
function closeLoadedExport() { loadedExport.value = false }
const writable = computed(() => props.workbench.canEdit(props.tab))
const locked = computed(() => props.tab.busy || props.workbench.executing.value || props.workbench.locks.has(props.tab.connectionId))
const insertColumns = computed(() => props.tab.description?.columns.filter((c) => !c.hidden && !c.generated && c.identity !== 'always') ?? [])
function displayed(row: ResultRow, column: number): CellValue {
  const name = props.tab.page!.columns[column]!.name
  return props.tab.dirty.get(row.index)?.changes[name] ?? row.cells[column]!
}
async function edit(row: ResultRow, column: number) {
  if (disposed || !writable.value || locked.value || !props.tab.page) return
  const tab = props.tab
  const page = tab.page!
  const result = tab.result
  const generation = tab.generation
  const cursorId = result?.cursorId
  const request = ++editRequest
  const ownsRequest = () => !disposed && request === editRequest && props.tab === tab &&
    tab.page === page && tab.result === result && tab.generation === generation &&
    tab.result?.cursorId === cursorId && !tab.invalidated && !insertOpen.value
  error.value = ''
  try {
    props.workbench.rowKeys(tab, row)
    let cell = displayed(row, column)
    if (cell.kind === 'blob') throw new Error('二进制单元格只读')
    if (cell.kind === 'text' && cell.truncated) {
      if (!cursorId) throw new Error('游标已关闭，无法获取完整文本')
      cell = await backend.fetchCellValue(cursorId, row.index, column)
      if (!ownsRequest()) return
      if (cell.kind !== 'text' || cell.truncated) throw new Error('完整文本不可用，无法安全编辑')
    }
    if (!ownsRequest()) return
    editing.value = { row, column, raw: cell.kind === 'null' ? '' : cellText(cell), kind: cell.kind === 'null' ? page.columns[column]!.type : cell.kind, isNull: cell.kind === 'null' }
  } catch (cause) { if (ownsRequest()) error.value = errorText(cause) }
}
function saveCell() {
  const editor = editing.value
  if (!editor) return
  try {
    props.workbench.stageCell(props.tab, editor.row, props.tab.page!.columns[editor.column]!.name, inputCell(editor.raw, editor.kind, editor.isNull))
    editing.value = null
  } catch (cause) { error.value = errorText(cause) }
}
async function sort(column: string) {
  if (locked.value || props.tab.invalidated) return
  props.tab.order = { column, direction: props.tab.order?.column === column && props.tab.order.direction === 'ASC' ? 'DESC' : 'ASC' }
  await props.workbench.attempt(() => props.workbench.transformTab(props.tab))
}
function beginInsert() {
  invalidateCellEdit()
  insertInclude.clear(); insertNulls.clear()
  for (const column of insertColumns.value) {
    insertValues[column.name] = ''
    if (column.requiredOnInsert) insertInclude.add(column.name)
  }
  error.value = ''; insertOpen.value = true
}
async function submitInsert() {
  try {
    const values: Record<string, CellValue> = {}
    for (const column of insertColumns.value) {
      if (!insertInclude.has(column.name)) continue
      const kind = /int|numeric|decimal|real|float|double/i.test(column.typeName) ? 'number' : /bool/i.test(column.typeName) ? 'boolean' : 'text'
      values[column.name] = inputCell(insertValues[column.name] ?? '', kind, insertNulls.has(column.name))
    }
    const inserted = await props.workbench.insertRow(props.tab, values)
    if (inserted === true) insertOpen.value = false
  } catch (cause) { error.value = errorText(cause) }
}
defineExpose({ readCell, buildCopyText, copyCell, countRows, openCell, selectCell, openLoadedExport, closeLoadedExport, beginInsert, submitInsert, saveCell, editing, viewer, loadedExport, rowCount, selectedCell, error })
</script>

<template>
  <section class="result-grid" :aria-busy="tab.busy">
    <div class="actions result-actions">
      <button :disabled="locked || tab.invalidated || !tab.result" @click="workbench.attempt(() => workbench.reloadTab(tab))">刷新</button>
      <button :disabled="locked || !writable" @click="beginInsert">新增行</button>
      <button :disabled="locked || !writable || !tab.selectedRows.size" @click="workbench.attempt(() => workbench.deleteSelected(tab))">删除选中行</button>
      <button :disabled="locked || !tab.dirty.size" @click="workbench.attempt(() => workbench.applyTab(tab))">应用修改{{ tab.dirty.size ? ` (${tab.dirty.size})` : '' }}</button>
      <button :disabled="locked || reading || !selectedCell" @click="readSelected">查看完整值</button>
      <button :disabled="locked || reading || !selectedCell" @click="copySelected(false)">复制单元格</button>
      <button :disabled="locked || reading || !selectedCell" @click="copySelected(true)">复制整行</button>
      <button :disabled="locked || tab.invalidated || !tab.page" @click="openLoadedExport">导出当前页…</button>
      <button v-if="tab.table?.kind === 'table'" :disabled="locked || tab.invalidated" @click="countRows">COUNT{{ rowCount !== null ? `: ${rowCount}` : '' }}</button>
      <span class="spacer" /><span class="transaction-state">{{ workbench.transactions[tab.connectionId]?.active ? `未提交 · ${workbench.transactions[tab.connectionId]?.pendingAffected ?? 0} 行` : '无活动事务' }}</span>
      <button :disabled="locked || tab.invalidated" @click="workbench.attempt(() => workbench.settleTransaction(tab.connectionId, true))">提交</button>
      <button :disabled="locked || tab.invalidated" @click="workbench.attempt(() => workbench.settleTransaction(tab.connectionId, false))">回滚</button>
    </div>
    <form v-if="tab.result && !tab.invalidated" class="filter-bar" @submit.prevent="workbench.attempt(() => workbench.transformTab(tab))"><label class="muted" :for="`filter-${tab.id}`">筛选</label><input :id="`filter-${tab.id}`" v-model="tab.filter" placeholder="status = 'active' AND age >= 18" :disabled="locked" /><button :disabled="locked">应用筛选</button></form>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <div v-if="tab.page" class="grid-scroll">
      <table class="data-table"><thead><tr><th class="row-number">#</th><th v-for="(column, index) in tab.page.columns" :key="index"><button class="column-sort" :disabled="locked || tab.invalidated" @click="sort(column.name)">{{ column.name }}{{ tab.order?.column === column.name ? tab.order.direction === 'ASC' ? ' ↑' : ' ↓' : '' }}</button><small>{{ column.type }}</small></th></tr></thead>
        <tbody><tr v-for="row in tab.page.rows" :key="row.index" :class="{ 'is-selected': tab.selectedRows.has(row.index) }"><td class="row-number"><label><input type="checkbox" :checked="tab.selectedRows.has(row.index)" :disabled="locked" :aria-label="`选择第 ${row.index + 1} 行`" @change="tab.selectedRows.has(row.index) ? tab.selectedRows.delete(row.index) : tab.selectedRows.add(row.index)" />{{ row.index + 1 }}</label></td>
          <td v-for="(column, index) in tab.page.columns" :key="index" :class="{ 'is-dirty': tab.dirty.get(row.index)?.changes[column.name] !== undefined, 'is-null': displayed(row, index).kind === 'null', 'is-cell-selected': selectedCell?.row.index === row.index && selectedCell.column === index }" :title="cellText(displayed(row, index))" tabindex="0" @click="selectCell(row, index)" @keydown.enter.prevent="openCell(row, index)" @dblclick="openCell(row, index)">{{ cellText(displayed(row, index)) }}</td>
        </tr></tbody>
      </table>
      <p v-if="!tab.page.rows.length" class="empty muted">结果为空</p>
    </div>
    <div v-else class="command-result" :class="{ 'is-error': tab.invalidated }">{{ tab.message || (tab.busy ? '正在执行…' : '没有结果') }}</div>
    <div v-if="tab.page" class="page-bar"><span>{{ tab.page.offset + (tab.page.returned ? 1 : 0) }}–{{ tab.page.offset + tab.page.returned }} 行 · {{ Math.round(tab.result?.elapsedMs ?? 0) }} ms{{ writable ? ' · 双击单元格编辑' : ' · 只读' }}</span><span class="spacer" /><button :disabled="locked || !tab.page.offset || tab.invalidated" @click="workbench.attempt(() => workbench.pageTab(tab, -1))">上一页</button><button :disabled="locked || !tab.page.hasMore || !tab.result?.cursorId || tab.invalidated" @click="workbench.attempt(() => workbench.pageTab(tab, 1))">下一页</button></div>
    <div v-if="editing" class="modal-backdrop" @keydown.esc="editing = null"><section class="modal" role="dialog" aria-modal="true" aria-label="编辑单元格"><h2>编辑 {{ tab.page?.columns[editing.column]?.name }}</h2><form @submit.prevent="saveCell"><textarea v-model="editing.raw" :disabled="editing.isNull" rows="5" aria-label="单元格值" autofocus /><label class="checkbox"><input v-model="editing.isNull" type="checkbox" />NULL</label><p v-if="error" class="is-error">{{ error }}</p><div class="modal-actions"><button type="button" @click="editing = null">取消</button><button type="submit" class="primary">保存到本地修改</button></div></form></section></div>
    <div v-if="insertOpen" class="modal-backdrop"><section class="modal insert-dialog" role="dialog" aria-modal="true" aria-label="新增行"><h2>新增行</h2><p class="muted">未勾选的列由数据库默认值填充；插入后需要提交事务。</p><form @submit.prevent="submitInsert"><div v-for="column in insertColumns" :key="column.name" class="insert-field"><label class="checkbox"><input type="checkbox" :checked="insertInclude.has(column.name)" @change="insertInclude.has(column.name) ? insertInclude.delete(column.name) : insertInclude.add(column.name)" />{{ column.name }}{{ column.requiredOnInsert ? ' *' : '' }}</label><input v-model="insertValues[column.name]" :disabled="!insertInclude.has(column.name) || insertNulls.has(column.name)" :aria-label="column.name" :placeholder="column.defaultValue ?? column.typeName" /><label class="checkbox"><input type="checkbox" :disabled="!insertInclude.has(column.name) || !column.nullable" :checked="insertNulls.has(column.name)" @change="insertNulls.has(column.name) ? insertNulls.delete(column.name) : insertNulls.add(column.name)" />NULL</label></div><p v-if="error" class="is-error">{{ error }}</p><div class="modal-actions"><button type="button" @click="insertOpen = false">取消</button><button class="primary" type="submit">插入</button></div></form></section></div>
    <CellViewer v-if="viewer" :value="viewer.value" :title="viewer.title" @close="viewer = null" />
    <LoadedExportDialog v-if="loadedExport" ref="loadedExportController" :tab="tab" :workbench="workbench" @close="closeLoadedExport" />
  </section>
</template>

<style scoped>
.data-table td.is-cell-selected { outline:1px solid var(--accent); outline-offset:-1px; }
</style>
