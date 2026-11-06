<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ObjectRef, TableDescription } from '../../../../src/core/model'
import { metadataAvailability } from '../../../../src/core/metadata'
import { backend, errorText } from '../backend'

const props = defineProps<{ node: ObjectRef; canAlter?: boolean }>()
const emit = defineEmits<{ close: []; open: [node: ObjectRef]; ddl: [mode: 'rename' | 'drop', node: ObjectRef] }>()
const description = ref<TableDescription | null>(null)
const busy = ref(false)
const error = ref('')
async function load() {
  busy.value = true; error.value = ''
  try { description.value = await backend.describeTable(props.node.id) }
  catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false }
}
function emptyMessage(value: readonly unknown[] | undefined) {
  return metadataAvailability(value) === 'unavailable' ? '驱动未提供此类元数据' : '已确认没有此类对象'
}
defineExpose({ refresh: load, description, busy, error })
onMounted(load)
</script>

<template>
  <section class="tool-panel schema-panel">
    <header class="pane-toolbar"><strong>{{ node.name }} · 结构</strong><span class="muted">{{ node.kind === 'view' ? '视图' : '表' }}</span><span class="spacer" /><button :disabled="busy" @click="load">刷新结构</button><button :disabled="busy" @click="emit('open', node)">打开数据</button><button v-if="canAlter && node.kind === 'table'" :disabled="busy" @click="emit('ddl', 'rename', node)">重命名…</button><button v-if="canAlter" class="danger" :disabled="busy" @click="emit('ddl', 'drop', node)">删除结构…</button><button @click="emit('close')">返回结果</button></header>
    <div class="tool-body">
      <p v-if="busy" class="muted">正在按需读取结构…</p><p v-if="error" class="inline-error" role="alert">{{ error }}</p>
      <template v-if="description">
        <p class="muted">{{ description.columns.length }} 列 · {{ description.hasUniqueKey ? '具备唯一行标识' : '没有可靠唯一键，数据只读' }}</p>
        <h3>列</h3><div class="preview-scroll"><table class="data-table"><thead><tr><th>列名</th><th>类型</th><th>可空</th><th>主键序号</th><th>默认值</th><th>生成方式</th></tr></thead><tbody><tr v-for="column in description.columns" :key="column.name"><td>{{ column.name }}</td><td>{{ column.typeName }}</td><td>{{ column.nullable ? '是' : '否' }}</td><td>{{ column.primaryKeyOrdinal ?? '—' }}</td><td>{{ column.defaultValue ?? '—' }}</td><td>{{ column.generated ?? column.identity ?? (column.hidden ? '隐藏列' : '—') }}</td></tr></tbody></table></div>
        <h3>外键</h3><p v-if="!description.foreignKeys?.length" class="muted">{{ emptyMessage(description.foreignKeys) }}</p><div v-else class="preview-scroll"><table class="data-table"><thead><tr><th>约束</th><th>本表列</th><th>引用表</th><th>引用列</th><th>更新 / 删除</th></tr></thead><tbody><tr v-for="(key, index) in description.foreignKeys" :key="index"><td>{{ key.name ?? '未命名' }}</td><td>{{ key.columns.join(', ') }}</td><td>{{ key.referencedSchema ? `${key.referencedSchema}.` : '' }}{{ key.referencedTable }}</td><td>{{ key.referencedColumns.join(', ') }}</td><td>{{ key.onUpdate ?? '—' }} / {{ key.onDelete ?? '—' }}</td></tr></tbody></table></div>
        <h3>索引</h3><p v-if="!description.indexes?.length" class="muted">{{ emptyMessage(description.indexes) }}</p><div v-else class="preview-scroll"><table class="data-table"><thead><tr><th>名称</th><th>列或表达式</th><th>唯一</th><th>筛选</th></tr></thead><tbody><tr v-for="index in description.indexes" :key="index.name"><td>{{ index.name }}</td><td>{{ index.expression ?? index.columns.join(', ') }}</td><td>{{ index.unique ? '是' : '否' }}</td><td>{{ index.predicate ?? '—' }}</td></tr></tbody></table></div>
        <h3>唯一约束</h3><p v-if="!description.uniqueConstraints?.length" class="muted">{{ emptyMessage(description.uniqueConstraints) }}</p><p v-for="(constraint, index) in description.uniqueConstraints" :key="index">{{ constraint.name ?? '未命名' }} · {{ constraint.columns.join(', ') }}</p>
        <h3>CHECK 约束</h3><p v-if="!description.checks?.length" class="muted">{{ emptyMessage(description.checks) }}</p><p v-for="(check, index) in description.checks" :key="index"><strong>{{ check.name ?? '未命名' }}</strong><code>{{ check.expression }}</code></p>
        <h3>触发器</h3><p v-if="!description.triggers?.length" class="muted">{{ emptyMessage(description.triggers) }}</p><details v-for="trigger in description.triggers" :key="trigger.name"><summary>{{ trigger.name }} · {{ trigger.timing }} {{ trigger.event }} · {{ trigger.enabled ? '启用' : '禁用' }}</summary><pre>{{ trigger.statement }}</pre></details>
      </template>
    </div>
  </section>
</template>
