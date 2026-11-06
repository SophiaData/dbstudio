<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { diffSchema, type DataCompareResult, type StructureDiff } from '../../../../src/core/compare'
import { backend, errorText } from '../backend'
import { connectionOf, type TreeNode, type Workbench } from '../workbench'

const props = defineProps<{ workbench: Workbench }>()
const emit = defineEmits<{ close: []; sql: [connectionId: string, sql: string] }>()
const mode = ref<'schema' | 'data'>('schema')
const source = ref(props.workbench.currentConnectionId.value)
const target = ref(props.workbench.connections.value.find((c) => c.id !== source.value)?.id ?? source.value)
const sourceSchema = ref('')
const targetSchema = ref('')
const sourceTable = ref('')
const targetTable = ref('')
const keyColumns = ref('')
const maxRows = ref(10000)
const busy = ref(false)
const error = ref('')
const structure = ref<StructureDiff | null>(null)
const data = ref<DataCompareResult | null>(null)
const resultTarget = ref('')
watch([mode, source, target, sourceSchema, targetSchema, sourceTable, targetTable, keyColumns, maxRows], () => {
  structure.value = null; data.value = null; resultTarget.value = ''
}, { flush: 'sync' })
const statements = computed(() => mode.value === 'schema' ? structure.value?.statements ?? [] : data.value?.plan.statements ?? [])
const warnings = computed(() => mode.value === 'schema' ? structure.value?.warnings ?? [] : data.value?.plan.warnings ?? [])
function flatten(nodes: TreeNode[]): TreeNode[] { return nodes.flatMap((node) => [node, ...flatten(node.children)]) }
const tables = computed(() => flatten(props.workbench.roots.value).filter((node) => node.ref.kind === 'table'))
const sourceTables = computed(() => tables.value.filter((node) => connectionOf(node.ref.id) === source.value))
const targetTables = computed(() => tables.value.filter((node) => connectionOf(node.ref.id) === target.value))
async function compare() {
  busy.value = true; error.value = ''; structure.value = null; data.value = null; resultTarget.value = ''
  const capturedTarget = target.value
  try {
    if (!source.value || !target.value) throw new Error('请选择源连接和目标连接')
    if (mode.value === 'schema') {
      const dialect = props.workbench.connections.value.find((c) => c.id === target.value)?.dialectId
      if (dialect !== 'sqlite' && dialect !== 'postgresql' && dialect !== 'mysql') throw new Error('目标方言暂不支持结构比较')
      const [left, right] = await Promise.all([
        backend.captureSchemaSnapshot(source.value, sourceSchema.value.trim() || null),
        backend.captureSchemaSnapshot(target.value, targetSchema.value.trim() || null)
      ])
      structure.value = diffSchema(left, right, dialect)
    } else {
      if (!sourceTable.value || !targetTable.value) throw new Error('请先展开左侧对象树，再选择需要比较的表')
      data.value = await backend.compareTableData({ sourceTableNodeId: sourceTable.value, targetTableNodeId: targetTable.value, keyColumns: keyColumns.value.trim() ? keyColumns.value.split(',').map((name) => name.trim()).filter(Boolean) : undefined, maxRows: maxRows.value })
    }
    resultTarget.value = capturedTarget
  } catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false }
}
defineExpose({ compare, mode, source, target, sourceTable, targetTable, structure, data, statements, busy, error })
</script>

<template>
  <section class="tool-panel compare-panel"><header class="pane-toolbar"><strong>结构与数据比较</strong><span class="spacer" /><button :disabled="busy" @click="emit('close')">返回结果</button></header><div class="tool-body">
    <fieldset :disabled="busy" class="tool-fields"><div class="actions"><label><input v-model="mode" type="radio" value="schema" />结构比较</label><label><input v-model="mode" type="radio" value="data" />数据比较</label></div>
    <div class="compare-sides"><section><h3>源</h3><select v-model="source" aria-label="源连接"><option v-for="connection in workbench.connections.value.filter((c) => c.connected)" :key="connection.id" :value="connection.id">{{ connection.name }}</option></select><input v-if="mode === 'schema'" v-model="sourceSchema" aria-label="源 schema" placeholder="schema（可选）" /><select v-else v-model="sourceTable" aria-label="源表"><option value="" disabled>选择已加载的表</option><option v-for="table in sourceTables" :key="table.ref.id" :value="table.ref.id">{{ table.ref.name }}</option></select></section><section><h3>目标</h3><select v-model="target" aria-label="目标连接"><option v-for="connection in workbench.connections.value.filter((c) => c.connected)" :key="connection.id" :value="connection.id">{{ connection.name }}</option></select><input v-if="mode === 'schema'" v-model="targetSchema" aria-label="目标 schema" placeholder="schema（可选）" /><select v-else v-model="targetTable" aria-label="目标表"><option value="" disabled>选择已加载的表</option><option v-for="table in targetTables" :key="table.ref.id" :value="table.ref.id">{{ table.ref.name }}</option></select></section></div>
    <div v-if="mode === 'data'" class="actions"><input v-model="keyColumns" aria-label="比较键" placeholder="比较键（逗号分隔，留空使用主键）" /><label>单侧行数上限 <input v-model.number="maxRows" type="number" min="1" max="100000" aria-label="行数上限" /></label><span class="muted">表列表仅包含左侧已展开对象</span></div>
    <div class="actions"><button class="primary" :disabled="busy" @click="compare">{{ busy ? '比较中…' : '读取并比较' }}</button><span class="muted">读取两端数据，生成供审阅的同步 SQL</span></div>
    </fieldset><p v-if="error" class="inline-error" role="alert">{{ error }}</p><p v-for="(warning, index) in warnings" :key="index" class="warning">{{ warning }}</p>
    <template v-if="structure"><p>{{ structure.changes.length }} 处结构差异{{ structure.destructive ? ' · 含破坏性变更' : '' }}</p><table class="data-table"><thead><tr><th>动作</th><th>对象</th><th>目标</th><th>性质</th></tr></thead><tbody><tr v-for="(change, index) in structure.changes" :key="index"><td>{{ change.kind }}</td><td>{{ change.objectType }}</td><td>{{ change.target }}</td><td>{{ change.destructive ? '需审阅破坏性变更' : '新增/修改' }}</td></tr></tbody></table></template>
    <template v-if="data"><p>新增 {{ data.plan.insertCount }} · 修改 {{ data.plan.updateCount }} · 删除 {{ data.plan.deleteCount }} · 比较键 {{ data.keyColumns.join(', ') }}</p><table class="data-table"><thead><tr><th>状态</th><th>键</th><th>差异列</th></tr></thead><tbody><tr v-for="(row, index) in data.rows" :key="index"><td>{{ row.status }}</td><td>{{ JSON.stringify(row.key) }}</td><td>{{ row.columns.join(', ') }}</td></tr></tbody></table></template>
    <div v-if="structure || data" class="sql-plan"><div class="actions"><strong>同步 SQL 预览</strong><span class="spacer" /><button :disabled="!statements.length || !resultTarget" @click="emit('sql', resultTarget, statements.join('\n'))">载入目标 SQL 编辑器</button></div><pre>{{ statements.join('\n') || '没有需要同步的 SQL；未覆盖的元数据请参见提示。' }}</pre></div>
  </div></section>
</template>
