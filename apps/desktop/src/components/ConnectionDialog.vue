<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { ConnectionSummary } from '../../../../src/core/api'
import type { SecretMap, TestConnectionResult } from '../../../../src/core/driver'
import type { ConnectionConfig } from '../../../../src/core/dialect'
import type { Workbench } from '../workbench'
import { backend, errorText } from '../backend'
import { collectConnectionFields } from '../connection-form'

const props = defineProps<{ workbench: Workbench; connection: ConnectionSummary | null }>()
const emit = defineEmits<{ close: [] }>()
const form = ref<HTMLFormElement>()
const name = ref(props.connection?.name ?? '')
const dialectId = ref(props.connection?.dialectId ?? props.workbench.dialects.value[0]?.id ?? '')
const dialect = computed(() => props.workbench.dialects.value.find((d) => d.id === dialectId.value))
const busy = ref(false)
const error = ref('')
const diagnostic = ref<TestConnectionResult | null>(null)
const optionValues = reactive<Record<string, string>>({})
watch(dialect, (selected) => {
  for (const key of Object.keys(optionValues)) delete optionValues[key]
  for (const field of selected?.fields ?? []) {
    if (field.kind !== 'password') optionValues[field.key] = String(props.connection?.options[field.key] ?? field.default ?? (field.kind === 'select' ? field.choices?.[0]?.value : '') ?? '')
  }
}, { immediate: true })
function collect(): { config: ConnectionConfig; secret: SecretMap } {
  if (!form.value || !dialect.value) throw new Error('请选择数据库类型')
  const data = new FormData(form.value)
  const values = new Map<string, string>(dialect.value.fields.map((field) => [field.key, String(data.get(field.key) ?? '')] as const))
  const { options, secret } = collectConnectionFields({
    fields: dialect.value.fields,
    values,
    baseOptions: props.connection?.options ?? {},
    editing: Boolean(props.connection)
  })
  return { config: { name: name.value.trim() || dialect.value.name, dialectId: dialect.value.id, options }, secret }
}
async function submit(test = false) {
  if (busy.value || !form.value?.reportValidity()) return
  busy.value = true; error.value = ''; diagnostic.value = null
  try {
    const { config, secret } = collect()
    if (test) {
      diagnostic.value = await backend.testConnection(config, Object.keys(secret).length ? secret : undefined)
      if (!diagnostic.value.ok) error.value = diagnostic.value.message ?? '连接测试失败'
    } else {
      const saved = await props.workbench.saveConnection(config, secret, props.connection?.id)
      if (saved) { form.value.reset(); emit('close') }
    }
  } catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false }
}
defineExpose({ submit, optionValues, name, busy, error })
</script>

<template>
  <div class="modal-backdrop" @keydown.esc="!busy && emit('close')">
    <section class="modal connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
      <h2 id="connection-title">{{ connection ? '编辑连接' : '新建连接' }}</h2>
      <form ref="form" @submit.prevent="submit()">
        <label class="field"><span>连接名</span><input id="f-name" v-model="name" aria-label="连接名" autofocus /></label>
        <label class="field"><span>数据库类型</span><select id="f-dialect" v-model="dialectId" :disabled="!!connection || busy"><option v-for="item in workbench.dialects.value" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <div id="f-dynamic" :key="dialectId" class="connection-fields">
          <label v-for="field in dialect?.fields ?? []" :key="field.key" class="field">
            <span>{{ field.label }}{{ field.required ? ' *' : '' }}{{ connection && field.kind === 'password' ? '（留空不修改）' : '' }}</span>
            <select v-if="field.kind === 'select'" :name="field.key" :data-key="field.key" v-model="optionValues[field.key]" :required="field.required" :disabled="busy"><option v-for="choice in field.choices" :key="choice.value" :value="choice.value">{{ choice.label }}</option></select>
            <input v-else-if="field.kind === 'password'" :name="field.key" :data-key="field.key" :data-secret-key="field.secretKey ?? 'dbPassword'" type="password" :placeholder="field.placeholder" :required="field.required && !connection" autocomplete="new-password" :disabled="busy" />
            <input v-else v-model="optionValues[field.key]" :name="field.key" :data-key="field.key" :type="field.kind === 'number' ? 'number' : 'text'" :placeholder="field.placeholder" :required="field.required" autocomplete="off" :disabled="busy" />
          </label>
        </div>
        <p v-if="diagnostic?.ok" class="success" role="status">连接成功 · {{ diagnostic.elapsedMs }} ms{{ diagnostic.serverVersion ? ` · ${diagnostic.serverVersion}` : '' }}</p>
        <p v-if="error" id="f-error" class="is-error" role="alert">{{ error }}</p>
        <p v-if="connection" class="muted">更新连接将先处理此连接所有标签中的未提交修改。</p>
        <div class="modal-actions"><button id="btn-test" type="button" :disabled="busy" @click="submit(true)">测试连接</button><span class="spacer" /><button type="button" :disabled="busy" @click="emit('close')">取消</button><button id="btn-submit" class="primary" type="submit" :disabled="busy">{{ busy ? '处理中…' : connection ? '保存' : '保存并连接' }}</button></div>
      </form>
    </section>
  </div>
</template>
