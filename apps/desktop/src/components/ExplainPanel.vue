<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ExplainResult } from '../../../../src/core/resultset'
import { backend, errorText } from '../backend'
import { cellText, connectionNode } from '../workbench'

const props = defineProps<{ connectionId: string; sql: string }>()
const emit = defineEmits<{ close: [] }>()
const result = ref<ExplainResult | null>(null)
const busy = ref(false)
const error = ref('')
async function refresh() {
  busy.value = true; error.value = ''
  try { result.value = await backend.explain(connectionNode(props.connectionId), props.sql) }
  catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false }
}
defineExpose({ refresh, result, busy, error })
onMounted(refresh)
</script>

<template>
  <section class="tool-panel explain-panel"><header class="pane-toolbar"><strong>执行计划</strong><span class="muted">{{ result?.dialectId ?? '' }} {{ result?.format ?? '' }}</span><span class="spacer" /><button :disabled="busy" @click="refresh">刷新计划</button><button @click="emit('close')">返回结果</button></header><div class="tool-body"><p v-if="busy" class="muted">正在读取原生执行计划…</p><p v-if="error" class="inline-error" role="alert">{{ error }}</p><template v-if="result"><pre>{{ result.executedSql }}</pre><div class="preview-scroll"><table class="data-table"><thead><tr><th v-for="(column, index) in result.columns" :key="index">{{ column.name }}</th></tr></thead><tbody><tr v-for="row in result.rows" :key="row.index"><td v-for="(cell, index) in row.cells" :key="index">{{ cellText(cell) }}</td></tr></tbody></table></div></template></div></section>
</template>
