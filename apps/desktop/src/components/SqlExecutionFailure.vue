<script setup lang="ts">
import { computed } from 'vue'
import type { Workbench } from '../workbench'
import type { SqlSourceRange } from '../sql-editor-model'

const props = defineProps<{ workbench: Workbench }>()
const emit = defineEmits<{ locate: [editorTabId: string, source: SqlSourceRange] }>()
const result = computed(() => props.workbench.activeTab.value)
const failure = computed(() => result.value?.failure)
const origin = computed(() => props.workbench.editorTabs.value.find((tab) => tab.id === result.value?.editorTabId))
const canLocate = computed(() => Boolean(failure.value?.source && origin.value &&
  origin.value.connectionId === result.value?.connectionId && origin.value.sql === failure.value.source.document))
function locate() {
  if (canLocate.value && origin.value && failure.value?.source) emit('locate', origin.value.id, failure.value.source)
}
</script>

<template>
  <section v-if="failure" class="sql-execution-failure" aria-label="SQL 执行反馈">
    <p role="alert"><strong>{{ failure.phase === 'after-execution' ? '语句已执行，后续处理失败；请先核对结果，避免重复执行。' : '语句执行未完成' }}</strong>
      · 本次第 {{ failure.statementIndex + 1 }} 条 · {{ failure.source ? '编辑器' : '执行片段' }}第 {{ failure.startLine }}–{{ failure.endLine }} 行</p>
    <p class="failure-message">{{ failure.message }}</p>
    <button :disabled="!canLocate" @click="locate">定位执行语句</button>
    <span v-if="!canLocate" class="muted">{{ !failure.source ? '未记录编辑器范围，请查看执行快照。' : !origin ? '原 SQL 标签已关闭，请查看执行快照。' : '草稿已变化，请查看执行快照。' }}</span>
    <details :key="result?.id"><summary>查看执行快照</summary><pre>{{ failure.sql }}</pre></details>
  </section>
</template>

<style scoped>
.sql-execution-failure { flex-shrink:0; max-height:190px; overflow:auto; padding:8px 12px; border-bottom:1px solid var(--border); background:var(--bg-alt); }
.sql-execution-failure p { margin:0 0 6px; }
.failure-message { white-space:pre-wrap; overflow-wrap:anywhere; }
.sql-execution-failure button { margin-right:8px; }
.sql-execution-failure details { margin-top:6px; }
.sql-execution-failure pre { white-space:pre-wrap; overflow-wrap:anywhere; font-family:var(--mono); user-select:text; }
</style>
