<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { SavedSql, SqlLibrarySnapshot } from '../../../../src/core/sql-library'
import { backend, errorText } from '../backend'
import { confirmAction } from '../dialogs'

const props = defineProps<{ currentSql: string }>()
const emit = defineEmits<{ close: []; load: [sql: string] }>()
const snapshot = ref<SqlLibrarySnapshot>({ history: [], saved: [] })
const mode = ref<'history' | 'saved'>('history')
const filter = ref('')
const busy = ref(false)
const error = ref('')
const selectedId = ref<string | null>(null)
const name = ref('')
const savedText = ref('')
const history = computed(() => snapshot.value.history.filter((item) => `${item.sql} ${item.connectionName}`.toLowerCase().includes(filter.value.toLowerCase())))
const saved = computed(() => snapshot.value.saved.filter((item) => `${item.name} ${item.sql}`.toLowerCase().includes(filter.value.toLowerCase())))
async function refresh() {
  busy.value = true; error.value = ''
  try { snapshot.value = await backend.listSqlLibrary() }
  catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false }
}
function select(item: SavedSql) { selectedId.value = item.id; name.value = item.name; savedText.value = item.sql }
function fromEditor() { selectedId.value = null; name.value = ''; savedText.value = props.currentSql; mode.value = 'saved' }
async function save() {
  busy.value = true; error.value = ''
  try {
    if (!name.value.trim() || !savedText.value.trim()) throw new Error('请填写收藏名称和 SQL')
    const item = await backend.saveSql(selectedId.value, name.value.trim(), savedText.value)
    selectedId.value = item.id; snapshot.value = await backend.listSqlLibrary()
  } catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false }
}
async function remove(id: string) {
  if (!(await confirmAction('删除 SQL 收藏', '确认删除这条收藏？'))) return
  busy.value = true
  try { await backend.removeSavedSql(id); if (selectedId.value === id) selectedId.value = null; snapshot.value = await backend.listSqlLibrary() }
  catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false }
}
async function clearHistory() {
  if (!(await confirmAction('清空执行历史', '确认清空 SQL 执行历史？收藏会保留。'))) return
  busy.value = true
  try { await backend.clearSqlHistory(); snapshot.value = await backend.listSqlLibrary() }
  catch (cause) { error.value = errorText(cause) }
  finally { busy.value = false }
}
defineExpose({ refresh, fromEditor, save, snapshot, selectedId, name, savedText, busy, error })
onMounted(refresh)
</script>

<template>
  <section class="tool-panel sql-library"><header class="pane-toolbar"><strong>SQL 历史与收藏</strong><button :class="{ primary: mode === 'history' }" @click="mode = 'history'">历史</button><button :class="{ primary: mode === 'saved' }" @click="mode = 'saved'">收藏</button><span class="spacer" /><button :disabled="busy" @click="refresh">刷新</button><button @click="emit('close')">返回结果</button></header>
    <div class="tool-body"><div class="actions"><input v-model="filter" aria-label="搜索 SQL 库" placeholder="搜索 SQL / 名称…" /><button :disabled="busy || !currentSql.trim()" @click="fromEditor">收藏当前编辑器 SQL</button><button v-if="mode === 'history'" :disabled="busy || !snapshot.history.length" @click="clearHistory">清空历史</button></div><p v-if="error" class="inline-error" role="alert">{{ error }}</p>
      <template v-if="mode === 'history'"><p v-if="!history.length" class="muted">暂无匹配历史</p><article v-for="item in history" :key="item.id" class="library-entry"><header><strong>{{ item.connectionName }}</strong><span class="muted">{{ new Date(item.startedAt).toLocaleString() }} · {{ Math.round(item.elapsedMs) }} ms · {{ item.status === 'success' ? '成功' : '失败' }}</span><span class="spacer" /><button @click="emit('load', item.sql)">载入编辑器</button></header><pre>{{ item.sql }}</pre><p v-if="item.error" class="is-error">{{ item.error }}</p></article></template>
      <template v-else><div class="saved-editor"><label class="field"><span>收藏名称</span><input v-model="name" aria-label="收藏名称" :disabled="busy" /></label><textarea v-model="savedText" rows="5" aria-label="收藏 SQL" :disabled="busy" /><div class="modal-actions"><button :disabled="busy" @click="selectedId = null; name = ''; savedText = ''">新建收藏</button><button class="primary" :disabled="busy || !name.trim() || !savedText.trim()" @click="save">{{ selectedId ? '保存修改' : '保存收藏' }}</button></div></div><article v-for="item in saved" :key="item.id" class="library-entry"><header><strong>{{ item.name }}</strong><span class="spacer" /><button @click="emit('load', item.sql)">载入编辑器</button><button :disabled="busy" @click="select(item)">编辑</button><button :disabled="busy" @click="remove(item.id)">删除</button></header><pre>{{ item.sql }}</pre></article><p v-if="!saved.length" class="muted">暂无匹配收藏</p></template>
    </div>
  </section>
</template>
