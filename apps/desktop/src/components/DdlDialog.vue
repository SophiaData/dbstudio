<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { ColumnCreateSpec, ObjectRef } from '../../../../src/core/model'
import { backend, errorText } from '../backend'
import type { Workbench } from '../workbench'

type DdlMode = 'create-table' | 'create-view' | 'rename' | 'drop'
const props = defineProps<{ workbench: Workbench; connectionId: string; mode: DdlMode; node?: ObjectRef }>()
const emit = defineEmits<{ close: [] }>()
const name = ref(props.mode === 'rename' ? props.node?.name ?? '' : '')
const selectSql = ref('SELECT ')
const confirmation = ref('')
const busy = ref(false)
const error = ref('')
const columns = reactive([
  { name: 'id', typeName: 'INTEGER', nullable: false, pk: 1, defaultValue: '' },
  { name: 'value', typeName: 'TEXT', nullable: true, pk: 0, defaultValue: '' }
])
const title = computed(() => props.mode === 'create-table' ? '新建表' : props.mode === 'create-view' ? '新建视图' : props.mode === 'rename' ? '重命名表' : props.node?.kind === 'view' ? '删除视图' : '删除表')
async function submit() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const objectName = name.value.trim()
    if (props.mode !== 'drop' && !objectName) throw new Error('请填写对象名称')
    if (props.mode === 'drop' && (!props.node || confirmation.value !== props.node.name)) throw new Error('请准确输入待删除对象名称')
    if (props.mode === 'create-table' && (!columns.length || columns.some((column) => !column.name.trim() || !column.typeName.trim()))) throw new Error('至少定义一列，列名与类型不能为空')
    if (props.mode === 'create-table' && new Set(columns.map((column) => column.name.trim())).size !== columns.length) throw new Error('列名不能重复')
    const saved = await props.workbench.changeSchema(props.connectionId, title.value, async () => {
      if (props.mode === 'create-table') {
        const spec: ColumnCreateSpec[] = columns.map((column) => ({ name: column.name.trim(), typeName: column.typeName.trim(), nullable: column.nullable, ...(column.pk > 0 ? { primaryKeyOrdinal: column.pk } : {}), ...(column.defaultValue.trim() ? { defaultValue: column.defaultValue.trim() } : {}) }))
        await backend.createTable(props.connectionId, { name: objectName, columns: spec })
      } else if (props.mode === 'create-view') {
        if (!selectSql.value.trim()) throw new Error('请填写视图 SELECT SQL')
        await backend.createView(props.connectionId, objectName, selectSql.value)
      } else if (props.mode === 'rename') {
        if (!props.node || props.node.kind !== 'table') throw new Error('请选择表对象')
        await backend.renameTable(props.node.id, objectName)
      } else if (props.node?.kind === 'view') await backend.dropView(props.node.id)
      else if (props.node?.kind === 'table') await backend.dropTable(props.node.id)
      else throw new Error('请选择表或视图对象')
    }, props.mode === 'rename' || props.mode === 'drop')
    if (saved) emit('close')
  } catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false }
}
defineExpose({ submit, name, selectSql, columns, confirmation, busy, error })
</script>

<template>
  <div class="modal-backdrop"><section class="modal ddl-dialog" role="dialog" aria-modal="true" :aria-label="title"><h2>{{ title }}</h2><form @submit.prevent="submit">
    <p v-if="mode === 'drop'">即将删除 {{ node?.name }}。请输入完整对象名称确认；删除结构不能通过结果表格回滚。</p>
    <label v-if="mode === 'drop'" class="field"><span>确认对象名称</span><input v-model="confirmation" :disabled="busy" autocomplete="off" aria-label="确认对象名称" /></label>
    <label v-else class="field"><span>对象名称</span><input v-model="name" :disabled="busy" required aria-label="对象名称" /></label>
    <fieldset v-if="mode === 'create-table'" :disabled="busy" class="tool-fields"><div class="ddl-columns"><div v-for="(column, index) in columns" :key="index" class="ddl-column"><input v-model="column.name" :aria-label="`第 ${index + 1} 列名`" placeholder="列名" /><input v-model="column.typeName" :aria-label="`第 ${index + 1} 列类型`" placeholder="类型" /><label class="checkbox"><input v-model="column.nullable" type="checkbox" />NULL</label><label>PK <input v-model.number="column.pk" type="number" min="0" :aria-label="`第 ${index + 1} 列主键序号`" /></label><input v-model="column.defaultValue" :aria-label="`第 ${index + 1} 列默认值`" placeholder="默认值 SQL（可选）" /><button type="button" :disabled="columns.length <= 1" :aria-label="`移除第 ${index + 1} 列`" @click="columns.splice(index, 1)">×</button></div></div><button type="button" @click="columns.push({ name: '', typeName: 'TEXT', nullable: true, pk: 0, defaultValue: '' })">＋ 列</button><p class="muted">主键序号 0 表示非主键；复合主键按 1、2… 指定。</p></fieldset>
    <label v-if="mode === 'create-view'" class="field"><span>SELECT SQL</span><textarea v-model="selectSql" :disabled="busy" rows="7" required aria-label="视图 SQL" /></label>
    <p v-if="error" class="is-error" role="alert">{{ error }}</p><div class="modal-actions"><button type="button" :disabled="busy" @click="emit('close')">取消</button><button type="submit" :class="mode === 'drop' ? 'danger' : 'primary'" :disabled="busy">{{ busy ? '处理中…' : title }}</button></div>
  </form></section></div>
</template>
