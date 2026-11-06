<script setup lang="ts">
import { ref } from 'vue'
import type { CellValue } from '../../../../src/core/resultset'
import { textValue } from '../result-export'
import { errorText } from '../backend'
import { writeClipboardText } from '../clipboard'
const props = defineProps<{ value: CellValue; title: string }>()
const emit = defineEmits<{ close: [] }>()
const error = ref('')
const copied = ref(false)
const content = textValue(props.value)
async function copy() {
  try { await writeClipboardText(content ?? ''); copied.value = true; error.value = '' }
  catch (cause) { error.value = `复制失败：${errorText(cause)}` }
}
defineExpose({ content, copy, error, copied })
</script>
<template>
  <div class="modal-backdrop" @keydown.esc="emit('close')"><section class="modal cell-viewer" role="dialog" aria-modal="true" :aria-label="title"><h2>{{ title }}</h2><p class="muted">只读完整值{{ value.kind === 'blob' ? ` · ${value.length} bytes · 十六进制` : content === null ? ' · NULL' : ` · ${content.length} 字符` }}</p><textarea :value="content ?? 'NULL'" readonly rows="16" aria-label="完整单元格值" /><p v-if="error" class="is-error">{{ error }}</p><p v-if="copied" class="success" role="status">已复制{{ content === null ? '（NULL → 空字符串）' : '' }}</p><div class="modal-actions"><button @click="copy">复制完整值</button><button @click="emit('close')">关闭</button></div></section></div>
</template>
<style scoped>.cell-viewer { width:min(900px,94vw); }.cell-viewer textarea { width:100%; resize:vertical; min-height:200px; }</style>
