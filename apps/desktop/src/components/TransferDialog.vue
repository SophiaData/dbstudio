<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { ImportPreview, ImportProgress, TransferFormat, TransferProgress } from '../../../../src/core/transfer'
import { backend, chooseExportFile, errorText } from '../backend'
import { connectionNode, type ResultTab, type Workbench } from '../workbench'
import { materializeQuery } from '../sql-editor-model'

const props = defineProps<{ workbench: Workbench; tab: ResultTab; mode: 'import' | 'export' }>()
const emit = defineEmits<{ close: [] }>()
const path = ref('')
const format = ref<TransferFormat>('csv')
const sourceMode = ref<'table' | 'query'>(props.tab.table ? 'table' : 'query')
const delimiter = ref(',')
const nullText = ref('\\N')
const hasHeader = ref(true)
const batchSize = ref(200)
const preview = ref<ImportPreview | null>(null)
const mapping = ref<string[]>([])
const progress = ref<ImportProgress | TransferProgress | null>(null)
const busy = ref(false)
const running = ref(false)
const error = ref('')
let mounted = true
let timer: ReturnType<typeof setTimeout> | undefined
let ownsLock = false
const writableColumns = computed(() => props.tab.description?.columns.filter((column) => !column.hidden && !column.generated && column.identity !== 'always') ?? [])
const terminal = (state: string) => ['completed', 'failed', 'cancelled'].includes(state)
const extension = computed(() => format.value === 'sql-insert' ? 'sql' : format.value === 'jsonl' ? 'jsonl' : format.value)
async function selectFile() {
  busy.value = true; error.value = ''
  try {
    const selected = props.mode === 'import' ? await backend.chooseImportFile() : await chooseExportFile(`export.${extension.value}`)
    if (selected) { path.value = selected; preview.value = null; mapping.value = [] }
  } catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false }
}
async function loadPreview() {
  busy.value = true; error.value = ''; preview.value = null
  try {
    if (!path.value) throw new Error('请先选择 CSV 文件')
    const result = await backend.previewImport({ sourcePath: path.value, delimiter: delimiter.value, nullText: nullText.value, hasHeader: hasHeader.value, sampleRowLimit: 10 })
    preview.value = result
    mapping.value = result.columns.map((column) => writableColumns.value.find((target) => target.name === column.name)?.name ?? '')
  } catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false }
}
function releaseTask() {
  if (ownsLock) props.workbench.locks.delete(props.tab.connectionId)
  ownsLock = false
  if (progress.value) props.workbench.backgroundTasks.delete(progress.value.taskId)
}
async function monitorTask() {
  if (!progress.value || busy.value && !running.value) return
  busy.value = true; error.value = ''
  try {
    while (mounted && progress.value && !terminal(progress.value.status)) {
      await new Promise<void>((resolve) => { timer = setTimeout(resolve, 250) })
      const next: ImportProgress | TransferProgress | null = props.mode === 'import' ? await backend.getImportProgress(progress.value.taskId) : await backend.getTransferProgress(progress.value.taskId)
      if (!next) throw new Error('原生任务进度暂时不可用，请重查或取消任务')
      progress.value = next
    }
    if (progress.value && terminal(progress.value.status)) {
      const result = props.mode === 'import' ? await backend.waitImport(progress.value.taskId) : await backend.waitTransfer(progress.value.taskId)
      running.value = false
      releaseTask()
      if (result.status === 'failed') error.value = result.message ?? '任务失败'
      if (props.mode === 'import') { await props.workbench.readTransaction(props.tab.connectionId); await props.workbench.reloadTab(props.tab, false) }
      props.workbench.setStatus(`${props.mode === 'import' ? '导入' : '导出'}任务${result.status === 'completed' ? '已完成' : result.status === 'cancelled' ? '已取消' : '失败'}`, result.status === 'failed')
    }
  } catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false }
}
async function start() {
  if (running.value || busy.value) return
  busy.value = true; error.value = ''
  const id = props.tab.connectionId
  try {
    if (!path.value) throw new Error('请先选择文件')
    if (props.workbench.executing.value || props.workbench.locks.has(id) || props.workbench.pendingEditors.size || props.workbench.tabs.value.some((tab) => tab.connectionId === id && tab.busy)) throw new Error('当前连接或编辑器正在处理其它操作')
    props.workbench.locks.add(id)
    ownsLock = true
    if (!(await props.workbench.guardConnection(id, props.mode === 'import' ? '导入 CSV 前处理事务' : '导出前处理事务'))) return
    progress.value = null
    if (props.mode === 'import') {
      if (!props.tab.table || !preview.value || preview.value.errorCount) throw new Error('请先获得无解析错误的 CSV 预览')
      if (mapping.value.length !== preview.value.columns.length || mapping.value.some((name) => !name)) throw new Error('请为每个 CSV 列明确选择目标列')
      if (new Set(mapping.value).size !== mapping.value.length) throw new Error('目标列不能重复映射')
      const missing = writableColumns.value.filter((column) => column.requiredOnInsert && !mapping.value.includes(column.name))
      if (missing.length) throw new Error(`缺少必填列：${missing.map((column) => column.name).join(', ')}`)
      progress.value = await backend.startImport({ targetNodeId: props.tab.table.id, sourcePath: path.value, delimiter: delimiter.value, nullText: nullText.value, hasHeader: hasHeader.value, targetColumns: mapping.value, batchSize: batchSize.value })
    } else {
      let exportSql = props.tab.querySql
      if (sourceMode.value === 'query' && props.tab.parameters.length) {
        const dialect = props.workbench.connections.value.find((connection) => connection.id === id)?.dialectId
        if (dialect !== 'sqlite' && dialect !== 'postgresql' && dialect !== 'mysql') throw new Error('当前方言不能安全物化 SQL 参数')
        exportSql = materializeQuery(props.tab.querySql, props.tab.parameters, dialect)
      }
      progress.value = await backend.startTransfer({
        source: sourceMode.value === 'table' && props.tab.table ? { nodeId: props.tab.table.id } : { nodeId: connectionNode(id), sql: exportSql, connectionId: id },
        format: format.value, destinationPath: path.value, options: { batchSize: batchSize.value, includeHeader: hasHeader.value }
      })
    }
    running.value = true
    props.workbench.backgroundTasks.set(progress.value.taskId, props.mode)
    await monitorTask()
  } catch (cause) { error.value = errorText(cause) }
  finally {
    busy.value = false
    if (!running.value) releaseTask()
  }
}
async function cancel() {
  if (!progress.value) return
  try {
    const accepted = props.mode === 'import' ? await backend.cancelImport(progress.value.taskId) : await backend.cancelTransfer(progress.value.taskId)
    if (!accepted) error.value = '任务已进入提交阶段或已结束，无法取消'
    if (!busy.value) await monitorTask()
  } catch (cause) { error.value = errorText(cause) }
}
defineExpose({ path, format, sourceMode, preview, mapping, loadPreview, start, progress, running, busy, error })
onBeforeUnmount(() => { mounted = false; if (timer) clearTimeout(timer) })
</script>

<template>
  <div class="modal-backdrop"><section class="modal transfer-dialog" role="dialog" aria-modal="true" :aria-label="mode === 'import' ? 'CSV 导入' : '流式导出'"><h2>{{ mode === 'import' ? `CSV 导入 · ${tab.title}` : `流式导出 · ${tab.title}` }}</h2>
    <p v-if="mode === 'export'" class="muted">原生后端分页读取完整来源；并发写入可能造成跨页变化（live-paged），导出不是时间点快照。</p>
    <div class="field"><span>{{ mode === 'import' ? 'CSV 源文件' : '目标文件' }}</span><div class="file-choice"><input :value="path" readonly :aria-label="mode === 'import' ? 'CSV 源文件' : '目标文件'" /><button :disabled="busy || running" @click="selectFile">选择…</button></div></div>
    <label v-if="mode === 'export'" class="field"><span>导出来源</span><select v-model="sourceMode" :disabled="busy || running" @change="format === 'sql-insert' && sourceMode === 'query' && (format = 'csv')"><option v-if="tab.table" value="table">完整表/视图（不含当前筛选）</option><option value="query">当前查询（含筛选、排序）{{ tab.parameters.length ? ' · 参数已安全内联' : '' }}</option></select></label>
    <label v-if="mode === 'export'" class="field"><span>格式</span><select v-model="format" :disabled="busy || running" @change="path = ''"><option value="csv">CSV</option><option value="jsonl">JSONL</option><option value="json">JSON</option><option value="sql-insert" :disabled="tab.table?.kind !== 'table' || sourceMode !== 'table'">SQL INSERT</option></select></label>
    <template v-if="mode === 'import'"><label class="field"><span>分隔符</span><input v-model="delimiter" maxlength="1" :disabled="busy || running" @input="preview = null" /></label><label class="field"><span>NULL 标记</span><input v-model="nullText" :disabled="busy || running" @input="preview = null" /></label></template>
    <label class="checkbox"><input v-model="hasHeader" type="checkbox" :disabled="busy || running" @change="preview = null" />{{ mode === 'import' ? 'CSV 第一行为表头' : '包含列名表头' }}</label>
    <label class="field"><span>每批行数</span><input v-model.number="batchSize" type="number" min="1" max="1000" :disabled="busy || running" /></label>
    <button v-if="mode === 'import'" :disabled="busy || running || !path" @click="loadPreview">读取有界预览</button>
    <div v-if="preview" class="import-preview"><p>{{ preview.totalRows }} 行{{ preview.truncated ? ' · 预览已截断' : '' }} · {{ preview.errorCount }} 个解析错误</p><div class="preview-scroll"><table class="data-table"><thead><tr><th v-for="column in preview.columns" :key="column.index">{{ column.name }}<select v-model="mapping[column.index - 1]" :disabled="running" :aria-label="`${column.name} 目标列`"><option value="" disabled>选择目标列</option><option v-for="target in writableColumns" :key="target.name" :value="target.name">{{ target.name }}</option></select></th></tr></thead><tbody><tr v-for="row in preview.sampleRows" :key="row.row"><td v-for="(cell, index) in row.values" :key="index">{{ cell.kind === 'null' ? 'NULL' : cell.text }}</td></tr></tbody></table></div><p v-for="(issue, index) in preview.errors.slice(0, 5)" :key="index" class="is-error">{{ issue.message }}</p></div>
    <p v-if="progress" role="status">任务 {{ progress.status }} · {{ 'rowsImported' in progress ? progress.rowsImported : progress.rowsRead }} 行{{ 'bytesWritten' in progress ? ` · ${progress.bytesWritten} bytes` : '' }}</p><p v-if="error" class="is-error" role="alert">{{ error }}</p>
    <div class="modal-actions"><button v-if="running && !busy" @click="monitorTask">重新获取进度</button><button v-if="running" :disabled="progress?.status === 'committing'" @click="cancel">取消任务</button><span class="spacer" /><button :disabled="busy || running" @click="emit('close')">关闭</button><button class="primary" :disabled="busy || running || !path || (mode === 'import' && (!preview || !!preview.errorCount))" @click="start">{{ running ? '任务进行中…' : mode === 'import' ? '开始导入' : '开始导出' }}</button></div>
  </section></div>
</template>
