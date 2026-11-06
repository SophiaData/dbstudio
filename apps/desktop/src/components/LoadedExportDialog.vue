<script setup lang="ts">
import { ref } from 'vue'
import { saveTextExport, errorText } from '../backend'
import { completeLoadedRows, renderLoaded, type LoadedFormat } from '../result-export'
import type { ResultTab, Workbench } from '../workbench'
const props = defineProps<{ tab: ResultTab; workbench: Workbench }>()
const emit = defineEmits<{ close: [] }>()
const format = ref<LoadedFormat>('csv')
const content = ref('')
const busy = ref(false)
const error = ref('')
const previewError = ref('')
const saveError = ref('')
const exported = ref(false)
const notice = ref('')
function syncError() { error.value = previewError.value || saveError.value }
async function generate() {
  content.value = renderLoaded(format.value, props.tab.page!.columns, await completeLoadedRows(props.tab), props.tab, props.workbench)
  previewError.value = ''
}
async function preview() {
  if (busy.value) return
  busy.value = true; previewError.value = ''; saveError.value = ''; syncError(); exported.value = false; notice.value = ''
  props.tab.busy = true
  try { await generate() }
  catch (cause) { previewError.value = errorText(cause); content.value = ''; syncError() }
  finally { busy.value = false; props.tab.busy = false }
}
async function save() {
  if (busy.value) return
  busy.value = true; previewError.value = ''; saveError.value = ''; error.value = ''; exported.value = false; notice.value = ''
  props.tab.busy = true
  try {
    if (!content.value) await generate()
    if (!content.value || previewError.value) {
      error.value = previewError.value
      exported.value = false
      return
    }
    const extension = format.value === 'sql-insert' ? 'sql' : format.value === 'markdown' ? 'md' : format.value
    const path = await saveTextExport({ suggestedName: `loaded-page.${extension}`, content: content.value })
    if (path !== null) { exported.value = true; props.workbench.setStatus(`已保存当前已加载页 ${props.tab.page?.returned ?? 0} 行（${format.value}）`) }
    else { exported.value = false; notice.value = '已取消保存，未写入文件。' }
  } catch (cause) {
    saveError.value = errorText(cause)
    exported.value = false
  }
  finally {
    syncError()
    busy.value = false
    props.tab.busy = false
  }
}
defineExpose({ preview, save, format, content, error, previewError, saveError, busy, exported, notice })
</script>
<template>
<div class="modal-backdrop"><section class="modal loaded-export" role="dialog" aria-modal="true" aria-label="导出当前已加载页"><h2>导出当前已加载页</h2><p class="muted">仅导出当前页 {{ tab.page?.returned ?? 0 }} 行{{ tab.page?.hasMore ? '，结果仍有未加载行' : '' }}。包含本地已编辑值；截断字段按需补全。导出完整来源请使用流式导出。</p><label class="field"><span>格式</span><select v-model="format" :disabled="busy" @change="content = ''; exported = false; notice = ''; previewError = ''; saveError = ''; error = ''"><option value="csv">CSV</option><option value="json">JSON</option><option value="sql-insert" :disabled="tab.table?.kind !== 'table'">INSERT SQL</option><option value="markdown">Markdown</option></select></label><button :disabled="busy" @click="preview">生成预览</button><textarea v-if="content" :value="content" readonly rows="10" aria-label="当前页导出预览" /><p v-if="error" class="is-error" role="alert">{{ error }}</p><p v-if="exported" class="success" role="status">原生文件已写入并同步</p><p v-if="notice" class="muted" role="status">{{ notice }}</p><div class="modal-actions"><button :disabled="busy" @click="emit('close')">关闭</button><button class="primary" :disabled="busy" @click="save">另存为新文件…</button></div></section></div>
</template>
<style scoped>.loaded-export { width:min(850px,95vw); }.loaded-export textarea { display:block; width:100%; margin-top:12px; }</style>
