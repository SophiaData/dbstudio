<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { CellValue, ResultRow } from '../../../../src/core/resultset'
import { backend, errorText } from '../backend'
import CellViewer from './CellViewer.vue'
import LoadedExportDialog from './LoadedExportDialog.vue'
import { fullCell, textValue } from '../result-export'
import { writeClipboardText } from '../clipboard'
import { parseGridPaste, pastedMysqlCell } from '../grid-paste'
import { useResultGridLayout } from '../result-grid-layout'
import { cellText, inputCell, type Workbench, type ResultTab, type SortKey } from '../workbench'

const props = defineProps<{ workbench: Workbench; tab: ResultTab }>()
const { viewport, query: columnQuery, target: targetColumn, matches: matchingColumns, highlighted: highlightedColumn,
  resizing, tableWidth, width: columnWidth, minWidth, maxWidth, rowNumberWidth, startResize, moveResize, endResize,
  visibleColumns, visibleOrder, isHidden, isPinned, hiddenCount, pinnedCount, stickyOffsets, columnStyle, overflowPins,
  toggleHidden, togglePinned, showAll, unpinAll,
  cancelResize, resizeKey, fitColumn, fitAll, resetWidths, jumpToColumn, jumpKey, saveScroll } = useResultGridLayout(() => props.tab)
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
watch(visibleOrder, (indices) => {
  if (selectedCell.value && !indices.includes(selectedCell.value.column)) selectedCell.value = null
}, { flush: 'sync' })
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
  const columns = wholeRow ? [...visibleOrder.value] : [selected.column]
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
    props.workbench.setStatus(wholeRow ? '已复制整行可见列（Tab 分隔，NULL 为空字符串）' : '已复制单元格（NULL 为空字符串）')
  } catch (cause) { error.value = `复制失败：${errorText(cause)}` }
  finally { reading.value = false; props.tab.busy = false }
}
function tsvField(text: string): string {
  return /["\t\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
async function copyMarkedRows() {
  const tab = props.tab
  const page = tab.page
  if (!page || locked.value || reading.value || tab.invalidated) return
  const rows = page.rows.filter((row) => tab.selectedRows.has(row.index))
  if (!rows.length) return
  const result = tab.result
  const cursorId = result?.cursorId
  const generation = tab.generation
  const dirty = new Map(tab.dirty)
  const indices = [...visibleOrder.value]
  const orderKey = indices.join(',')
  const ownsCopy = () => !disposed && props.tab === tab && props.workbench.activeTab.value === tab &&
    tab.generation === generation && tab.page === page && tab.result === result &&
    tab.result?.cursorId === cursorId && !tab.invalidated && visibleOrder.value.join(',') === orderKey

  reading.value = true
  error.value = ''
  try {
    const lines = [indices.map(index => tsvField(page.columns[index]!.name)).join('\t')]
    for (const row of rows) {
      const fields: string[] = []
      for (const index of indices) {
        if (!ownsCopy()) return
        const { name } = page.columns[index]!
        const cell = dirty.get(row.index)?.changes[name] ?? row.cells[index]!
        const value = await fullCell(tab, row.index, index, cell)
        fields.push(tsvField(textValue(value) ?? ''))
      }
      lines.push(fields.join('\t'))
    }
    if (!ownsCopy()) return
    await writeClipboardText(lines.join('\r\n'))
    if (ownsCopy()) props.workbench.setStatus(`已复制 ${rows.length} 行可见列（含表头，NULL 为空字段）`)
  } catch (cause) {
    if (ownsCopy()) error.value = `复制失败：${errorText(cause)}`
  } finally {
    reading.value = false
  }
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
  if (writable.value && cell.kind !== 'blob' && !binaryColumn(column)) await edit(row, column)
  else await readCell(row, column)
}
/** 二进制类型名：SQLite BLOB、PG BYTEA、MySQL BINARY/VARBINARY/BLOB 系列。 */
const binaryType = /\b(?:blob|bytea|binary|varbinary|longvarbinary|image|tinyblob|mediumblob|longblob)\b/i
/**
 * 该结果列是否只能只读查看。
 *
 * 结果列的类型由驱动按行值推断，全 NULL 列会得到 `null`，不能只看它：
 * SQLite 的全 NULL BLOB 列因此曾进入文本编辑。判定优先用驱动给的非 NULL
 * 值类型（`blob`），其次用目标表列描述的 `typeName`；两者都没有可靠信息时
 * 按「不可判定」处理，保守地只读查看。
 */
function binaryColumn(column: number): boolean {
  const pageColumn = props.tab.page?.columns[column]
  if (!pageColumn) return true
  if (pageColumn.type === 'blob') return true
  const described = props.tab.description?.columns.find((candidate) => candidate.name === pageColumn.name)
  if (described) return binaryType.test(described.typeName)
  return pageColumn.type === 'null'
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
const canPaste = computed(() => writable.value && props.workbench.connections.value.some((connection) =>
  connection.id === props.tab.connectionId && connection.dialectId === 'mysql'))

function pasteCells(event: ClipboardEvent, row: ResultRow, firstColumn: number) {
  if (!canPaste.value || editing.value || insertOpen.value || viewer.value || loadedExport.value) return
  const clipboard = event.clipboardData
  const page = props.tab.page
  if (!clipboard?.types.includes('text/plain') || !page) return
  event.preventDefault()
  selectCell(row, firstColumn)
  error.value = ''
  try {
    const matrix = parseGridPaste(clipboard.getData('text/plain'))
    if (!matrix.length) return
    const firstRow = page.rows.indexOf(row)
    const width = matrix[0]!.length
    const start = visibleOrder.value.indexOf(firstColumn)
    if (firstRow < 0 || start < 0 || firstRow + matrix.length > page.rows.length || start + width > visibleOrder.value.length) {
      throw new Error('粘贴范围超出当前页，请选择足够的行和列')
    }
    const metadata = props.tab.description?.columns ?? []
    const columns = visibleOrder.value.slice(start, start + width).map(index => {
      const { name } = page.columns[index]!
      const description = metadata.find((column) => column.name === name)
      if (!description || page.columns.filter((column) => column.name === name).length !== 1) {
        throw new Error('无法确定目标列「' + name + '」')
      }
      return description
    })
    const edits = matrix.map((fields, index) => ({
      row: page.rows[firstRow + index]!,
      changes: Object.fromEntries(fields.map((field, columnIndex) => {
        const column = columns[columnIndex]!
        try {
          return [column.name, pastedMysqlCell(field, column)] as const
        } catch (cause) {
          throw new Error('粘贴区域第 ' + (index + 1) + ' 行「' + column.name + '」。' + errorText(cause))
        }
      }))
    }))
    props.workbench.stageCells(props.tab, edits)
    props.workbench.setStatus('已暂存 ' + String(matrix.length) + ' 行粘贴内容。点击「应用修改」查看 SQL 预览')
  } catch (cause) {
    error.value = errorText(cause)
  }
}
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
const ambiguousSortColumns = computed(() => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const { name } of props.tab.page?.columns ?? []) {
    if (seen.has(name)) duplicates.add(name)
    seen.add(name)
  }
  return duplicates
})
const sortIndicators = computed(() => new Map(props.tab.order.map(({ column, direction }, index) => {
  const arrow = direction === 'ASC' ? '↑' : '↓'
  return [column, props.tab.order.length > 1 ? `${arrow}${index + 1}` : arrow] as const
})))
async function sort(column: string, extend = false) {
  if (locked.value || props.tab.invalidated || ambiguousSortColumns.value.has(column)) return
  const current = props.tab.order
  let order: SortKey[]
  if (!extend) {
    const descending = current[0]?.column === column && current[0].direction === 'ASC'
    order = [{ column, direction: descending ? 'DESC' : 'ASC' }]
  } else {
    order = [...current]
    const index = order.findIndex((key) => key.column === column)
    if (index === -1) order.push({ column, direction: 'ASC' })
    else if (order[index]?.direction === 'ASC') order[index] = { column, direction: 'DESC' }
    else order.splice(index, 1)
  }
  await props.workbench.attempt(() => props.workbench.transformTab(props.tab, order))
}
async function clearSort() {
  if (locked.value || props.tab.invalidated || !props.tab.order.length) return
  await props.workbench.attempt(() => props.workbench.transformTab(props.tab, []))
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
  if (!insertOpen.value) return
  try {
    const values: Record<string, CellValue> = {}
    for (const column of insertColumns.value) {
      if (!insertInclude.has(column.name)) continue
      const kind = /\b(?:numeric|decimal)\b/i.test(column.typeName) ? 'text' : /int|real|float|double/i.test(column.typeName) ? 'number' : /bool/i.test(column.typeName) ? 'boolean' : 'text'
      values[column.name] = inputCell(insertValues[column.name] ?? '', kind, insertNulls.has(column.name))
    }
    const inserted = await props.workbench.insertRow(props.tab, values)
    if (inserted === true) insertOpen.value = false
  } catch (cause) { error.value = errorText(cause) }
}
defineExpose({ readCell, buildCopyText, copyCell, copyMarkedRows, countRows, openCell, selectCell, openLoadedExport, closeLoadedExport, beginInsert, submitInsert, saveCell, editing, viewer, loadedExport, rowCount, selectedCell, error })
</script>

<template>
  <section class="result-grid" :aria-busy="tab.busy">
    <div class="actions result-actions">
      <button :disabled="locked || tab.invalidated || !tab.result" @click="workbench.attempt(() => workbench.reloadTab(tab))">刷新</button>
      <button :disabled="locked || !writable" @click="beginInsert">新增行</button>
      <button :disabled="locked || !writable || !tab.selectedRows.size" @click="workbench.attempt(() => workbench.deleteSelected(tab))">删除选中行</button>
      <button :disabled="locked || !tab.dirty.size" @click="workbench.attempt(() => workbench.reviewAndApplyTab(tab))">应用修改{{ tab.dirty.size ? ` (${tab.dirty.size})` : '' }}</button>
      <button :disabled="locked || reading || !selectedCell" @click="readSelected">查看完整值</button>
      <button :disabled="locked || reading || !selectedCell" @click="copySelected(false)">复制单元格</button>
      <button :disabled="locked || reading || !selectedCell" @click="copySelected(true)">复制整行</button>
      <button :disabled="locked || reading || tab.invalidated || !tab.page || !tab.selectedRows.size" @click="copyMarkedRows">复制选中行</button>
      <button :disabled="locked || tab.invalidated || !tab.page" title="导出当前页全部结果列，包括隐藏列，使用原始列顺序" @click="openLoadedExport">导出当前页…</button>
      <button v-if="tab.table?.kind === 'table'" :disabled="locked || tab.invalidated" @click="countRows">COUNT{{ rowCount !== null ? `: ${rowCount}` : '' }}</button>
      <span class="spacer" /><span class="transaction-state">{{ workbench.transactions[tab.connectionId]?.active ? `未提交 · ${workbench.transactions[tab.connectionId]?.pendingAffected ?? 0} 行` : '无活动事务' }}</span>
      <button :disabled="locked || tab.invalidated" @click="workbench.attempt(() => workbench.settleTransaction(tab.connectionId, true))">提交</button>
      <button :disabled="locked || tab.invalidated" @click="workbench.attempt(() => workbench.settleTransaction(tab.connectionId, false))">回滚</button>
    </div>
    <form v-if="tab.result && !tab.invalidated" class="filter-bar" @submit.prevent="workbench.attempt(() => workbench.transformTab(tab))">
      <label class="muted" :for="`filter-${tab.id}`">筛选</label>
      <input :id="`filter-${tab.id}`" v-model="tab.filter" placeholder="status = 'active' AND age >= 18" :disabled="locked" />
      <button :disabled="locked">应用筛选</button>
      <button v-if="tab.order.length" type="button" :disabled="locked" @click="clearSort">清除排序</button>
    </form>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <div v-if="tab.page?.columns.length" class="column-tools">
      <label :for="`column-search-${tab.id}`">跳转列</label>
      <input :id="`column-search-${tab.id}`" v-model="columnQuery" type="search" placeholder="输入列名" @keydown.enter="jumpKey" />
      <select v-model="targetColumn" aria-label="匹配列" :disabled="!matchingColumns.length" @keydown.enter="jumpKey">
        <option v-for="column in matchingColumns" :key="column.index" :value="column.index">{{ column.index + 1 }} · {{ column.name }}{{ isHidden(column.index) ? '（隐藏）' : isPinned(column.index) ? '（固定）' : '' }}</option>
      </select>
      <button :disabled="!matchingColumns.length" @click="jumpToColumn">跳转</button>
      <button :disabled="targetColumn < 0 || reading" :aria-pressed="isPinned(targetColumn)" @click="togglePinned(targetColumn)">{{ isPinned(targetColumn) ? '取消固定此列' : '固定此列' }}</button>
      <button :disabled="targetColumn < 0 || reading || (!isHidden(targetColumn) && visibleOrder.length <= 1)" @click="toggleHidden(targetColumn)">{{ isHidden(targetColumn) ? '显示此列' : '隐藏此列' }}</button>
      <button v-if="hiddenCount" :disabled="reading" @click="showAll">显示全部列 ({{ hiddenCount }})</button>
      <button v-if="pinnedCount" :disabled="reading" @click="unpinAll">取消全部固定</button>
      <span v-if="!matchingColumns.length" class="muted" role="status">没有匹配列</span>
      <span class="spacer" />
      <button title="根据列名和当前页已加载内容适宽，不读取完整大字段" @click="fitAll">适宽全部列</button>
      <button @click="resetWidths">重置列宽</button>
    </div>
    <p v-if="overflowPins" class="column-hint muted" role="status">固定列较宽，部分列随表格滚动；缩小列宽或加宽窗口可恢复固定。</p>
    <div v-if="tab.page" ref="viewport" class="grid-scroll" :class="{ 'is-resizing': resizing }" @scroll="saveScroll">
      <table class="data-table result-data-table" :style="{ width: `${tableWidth}px` }">
        <colgroup><col :style="{ width: `${rowNumberWidth}px` }" /><col v-for="{ index } in visibleColumns" :key="index" :style="{ width: `${columnWidth(index)}px` }" /></colgroup>
        <thead><tr><th class="row-number">#</th>
        <th v-for="{ column, index } in visibleColumns" :key="index" :data-column-index="index" tabindex="-1" :style="columnStyle(index)" :class="{ 'is-column-target': highlightedColumn === index, 'is-pinned': stickyOffsets.has(index) }">
          <button class="column-sort"
            :disabled="locked || tab.invalidated || ambiguousSortColumns.has(column.name)"
            :title="ambiguousSortColumns.has(column.name) ? '结果列名重复，请先在 SQL 中设置不同别名' : '点击切换单列排序，按住 Shift 点击添加或调整多列排序'"
            @click="sort(column.name, $event.shiftKey)">
            {{ column.name }} <span v-if="sortIndicators.has(column.name)">{{ sortIndicators.get(column.name) }}</span>
          </button><small>{{ column.type }}</small>
          <span class="column-resize" role="separator" tabindex="0" aria-orientation="vertical"
            :aria-label="`调整第 ${index + 1} 列 ${column.name} 的宽度`" :aria-valuemin="minWidth" :aria-valuemax="maxWidth" :aria-valuenow="columnWidth(index)"
            title="拖动调整列宽，双击适宽；方向键微调，Enter 适宽"
            @pointerdown.stop.prevent="startResize($event, index)" @pointermove="moveResize"
            @pointerup="endResize()" @pointercancel="cancelResize" @lostpointercapture="cancelResize"
            @click.stop @dblclick.stop.prevent="fitColumn(index)" @keydown.stop="resizeKey($event, index)" />
        </th>
      </tr></thead>
        <tbody><tr v-for="row in tab.page.rows" :key="row.index" :class="{ 'is-selected': tab.selectedRows.has(row.index) }"><td class="row-number"><label><input type="checkbox" :checked="tab.selectedRows.has(row.index)" :disabled="locked" :aria-label="`选择第 ${row.index + 1} 行`" @change="tab.selectedRows.has(row.index) ? tab.selectedRows.delete(row.index) : tab.selectedRows.add(row.index)" />{{ row.index + 1 }}</label></td>
          <td v-for="{ column, index } in visibleColumns" :key="index" :data-column-index="index" :style="columnStyle(index)" :class="{ 'is-pinned': stickyOffsets.has(index), 'is-dirty': tab.dirty.get(row.index)?.changes[column.name] !== undefined, 'is-null': displayed(row, index).kind === 'null', 'is-cell-selected': selectedCell?.row.index === row.index && selectedCell.column === index }" :title="cellText(displayed(row, index))" tabindex="0" @focus="selectCell(row, index)" @click="selectCell(row, index)" @paste="pasteCells($event, row, index)" @keydown.enter.prevent="openCell(row, index)" @dblclick="openCell(row, index)">{{ cellText(displayed(row, index)) }}</td>
        </tr></tbody>
      </table>
    </div>
    <div v-else class="command-result" :class="{ 'is-error': tab.invalidated }">{{ tab.message || (tab.busy ? '正在执行…' : '没有结果') }}</div>
    <div v-if="tab.page" class="page-bar"><span v-if="!tab.page.rows.length" role="status">结果为空</span><span>{{ tab.page.offset + (tab.page.returned ? 1 : 0) }}–{{ tab.page.offset + tab.page.returned }} 行 · {{ Math.round(tab.result?.elapsedMs ?? 0) }} ms{{ writable ? ' · 双击单元格编辑' : ' · 只读' }}<template v-if="canPaste"> · 选中单元格后可粘贴</template></span><span class="spacer" /><button :disabled="locked || !tab.page.offset || tab.invalidated" @click="workbench.attempt(() => workbench.pageTab(tab, -1))">上一页</button><button :disabled="locked || !tab.page.hasMore || !tab.result?.cursorId || tab.invalidated" @click="workbench.attempt(() => workbench.pageTab(tab, 1))">下一页</button></div>
    <div v-if="editing" class="modal-backdrop" @keydown.esc="editing = null"><section class="modal" role="dialog" aria-modal="true" aria-label="编辑单元格"><h2>编辑 {{ tab.page?.columns[editing.column]?.name }}</h2><form @submit.prevent="saveCell"><textarea v-model="editing.raw" :disabled="editing.isNull" rows="5" aria-label="单元格值" autofocus /><label class="checkbox"><input v-model="editing.isNull" type="checkbox" />NULL</label><p v-if="error" class="is-error">{{ error }}</p><div class="modal-actions"><button type="button" @click="editing = null">取消</button><button type="submit" class="primary">保存到本地修改</button></div></form></section></div>
    <div v-if="insertOpen" class="modal-backdrop"><section class="modal insert-dialog" role="dialog" aria-modal="true" aria-label="新增行"><h2>新增行</h2><p class="muted">未勾选的列由数据库默认值填充；插入后需要提交事务。</p><form @submit.prevent="submitInsert"><div v-for="column in insertColumns" :key="column.name" class="insert-field"><label class="checkbox"><input type="checkbox" :checked="insertInclude.has(column.name)" @change="insertInclude.has(column.name) ? insertInclude.delete(column.name) : insertInclude.add(column.name)" />{{ column.name }}{{ column.requiredOnInsert ? ' *' : '' }}</label><input v-model="insertValues[column.name]" :disabled="!insertInclude.has(column.name) || insertNulls.has(column.name)" :aria-label="column.name" :placeholder="column.defaultValue ?? column.typeName" /><label class="checkbox"><input type="checkbox" :disabled="!insertInclude.has(column.name) || !column.nullable" :checked="insertNulls.has(column.name)" @change="insertNulls.has(column.name) ? insertNulls.delete(column.name) : insertNulls.add(column.name)" />NULL</label></div><p v-if="error" class="is-error">{{ error }}</p><div class="modal-actions"><button type="button" @click="insertOpen = false">取消</button><button class="primary" type="submit">插入</button></div></form></section></div>
    <CellViewer v-if="viewer" :value="viewer.value" :title="viewer.title" @close="viewer = null" />
    <LoadedExportDialog v-if="loadedExport" ref="loadedExportController" :tab="tab" :workbench="workbench" @close="closeLoadedExport" />
  </section>
</template>

<style scoped>
.data-table td.is-cell-selected { outline:1px solid var(--accent); outline-offset:-1px; }
.result-data-table { table-layout:fixed; min-width:0; }
.result-data-table th,.result-data-table td { min-width:0; max-width:none; }
.result-data-table .row-number { min-width:0; }
.result-data-table .row-number { position:sticky; left:0; z-index:2; background:var(--bg-alt); }
.result-data-table th.row-number { z-index:4; }
.result-data-table td.is-pinned { position:sticky; z-index:2; background:var(--bg); }
.result-data-table th.is-pinned { z-index:3; }
.result-data-table td.is-pinned.is-dirty { background:#4b4020; }
.result-data-table tr.is-selected td.is-pinned { background:#26364a; }
.result-data-table tr:hover td.is-pinned { background:#252a31; }
.column-hint { margin:0; padding:3px 8px; border-bottom:1px solid var(--border); }
.result-data-table .column-sort,.result-data-table th small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:8px; }
.result-data-table th.is-column-target { box-shadow:inset 0 -2px var(--accent); background:#263d5c; }
.result-data-table th:focus { outline:2px solid var(--accent); outline-offset:-2px; }
.column-resize { position:absolute; top:0; right:0; bottom:0; width:9px; cursor:col-resize; touch-action:none; }
.column-resize:hover,.column-resize:focus-visible { background:var(--accent); outline:none; }
.is-resizing { cursor:col-resize; user-select:none; }
.column-tools { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:5px 8px; border-bottom:1px solid var(--border); }
.column-tools input { width:160px; }
.column-tools select { width:200px; max-width:100%; }
</style>
