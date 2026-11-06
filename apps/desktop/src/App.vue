<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ConnectionSummary } from '../../../src/core/api'
import SqlEditor from './components/SqlEditor.vue'
import { parseParameterValue, type ScopedSqlParameter, type StatementParameterSlot } from './sql-editor-model'
import type { ObjectRef } from '../../../src/core/model'
import { confirmExit, errorText } from './backend'
import { decision } from './dialogs'
import { connectionOf, useWorkbench } from './workbench'
import ConnectionDialog from './components/ConnectionDialog.vue'
import MetadataTree from './components/MetadataTree.vue'
import ResultGrid from './components/ResultGrid.vue'
import ErPanel from './components/ErPanel.vue'
import ComparePanel from './components/ComparePanel.vue'
import TransferDialog from './components/TransferDialog.vue'
import SchemaPanel from './components/SchemaPanel.vue'
import type { ResultTab } from './workbench'
import SqlLibraryPanel from './components/SqlLibraryPanel.vue'
import ExplainPanel from './components/ExplainPanel.vue'
import DdlDialog from './components/DdlDialog.vue'
import { splitStatements, SQLITE_SCRIPT_RULES } from '../../../src/core/sql-script'

const wb = useWorkbench()
const connectionEditor = ref<ConnectionSummary | null | undefined>(undefined)
const treeSearch = ref('')
const parameterSlots = ref<StatementParameterSlot[]>([])
const parameterValues = reactive<Record<string, string>>({})
const parameterKinds = reactive<Record<string, string>>({})
const parameterOpen = ref(false)
const parameterError = ref('')
const pendingSql = ref('')
const sqlController = ref<InstanceType<typeof SqlEditor> | null>(null)
const exitBusy = ref(false)
const toolPanel = ref<'er' | 'compare' | 'schema' | 'library' | 'explain' | null>(null)
const explainRequest = ref<{ connectionId: string; sql: string } | null>(null)
const ddl = ref<{ mode: 'create-table' | 'create-view' | 'rename' | 'drop'; connectionId: string; node?: ObjectRef } | null>(null)
const toolConnectionId = ref('')
const schemaNode = ref<ObjectRef | null>(null)
const transfer = ref<{ mode: 'import' | 'export'; tab: ResultTab } | null>(null)
const connectionController = ref<InstanceType<typeof ConnectionDialog> | null>(null)
const schemaController = ref<InstanceType<typeof SchemaPanel> | null>(null)
const erController = ref<InstanceType<typeof ErPanel> | null>(null)
const compareController = ref<InstanceType<typeof ComparePanel> | null>(null)
const transferController = ref<InstanceType<typeof TransferDialog> | null>(null)
const metadataController = ref<InstanceType<typeof MetadataTree> | null>(null)
const gridController = ref<InstanceType<typeof ResultGrid> | null>(null)
const libraryController = ref<InstanceType<typeof SqlLibraryPanel> | null>(null)
const explainController = ref<InstanceType<typeof ExplainPanel> | null>(null)
const ddlController = ref<InstanceType<typeof DdlDialog> | null>(null)
let unlisten: UnlistenFn | undefined
const selectedConnection = computed(() => {
  const id = wb.selected.value ? connectionOf(wb.selected.value.id) : wb.currentConnectionId.value
  return wb.connections.value.find((c) => c.id === id) ?? null
})
const operationLocked = computed(() => wb.executing.value || exitBusy.value || Boolean(selectedConnection.value && wb.locks.has(selectedConnection.value.id)))
const tableForDetails = computed(() => {
  const selected = wb.selected.value
  return selected && ['table', 'view'].includes(selected.kind) ? selected : wb.activeTab.value?.table ?? null
})
const activeResultLocked = computed(() => !wb.activeTab.value || wb.activeTab.value.invalidated || wb.activeTab.value.busy || wb.locks.has(wb.activeTab.value.connectionId) || wb.executing.value)
function openEr() { toolConnectionId.value = selectedConnection.value?.id ?? ''; toolPanel.value = 'er' }
function openSchema() { schemaNode.value = tableForDetails.value; toolPanel.value = 'schema' }
async function openSchemaData(node: ObjectRef) {
  await wb.attempt(() => wb.openTable(node))
  toolPanel.value = null
}
function loadPlan(connectionId: string, script: string) {
  wb.selectConnection(connectionId); wb.sql.value = script; toolPanel.value = null
  wb.setStatus('同步 SQL 已载入编辑器，请审阅后明确执行')
}
function relational(id: string) { return ['sqlite', 'postgresql', 'mysql'].includes(wb.connections.value.find((connection) => connection.id === id)?.dialectId ?? '') }
function openDdl(mode: 'create-table' | 'create-view' | 'rename' | 'drop', node?: ObjectRef) {
  const id = node ? connectionOf(node.id) : wb.currentConnectionId.value
  if (!relational(id)) { wb.setStatus('当前驱动不支持关系型结构 DDL', true); return }
  ddl.value = { mode, node, connectionId: id }
}
function loadLibrarySql(script: string) { wb.sql.value = script; toolPanel.value = null; wb.setStatus('SQL 已载入当前连接编辑器，尚未执行') }
function requestExplain(script = sqlController.value?.currentStatement() ?? wb.sql.value) {
  try {
    if (!wb.currentConnection.value?.connected) throw new Error('请选择一个已连接的数据源')
    const dialect = wb.dialects.value.find((item) => item.id === wb.currentConnection.value?.dialectId)
    const statements = splitStatements(script, dialect?.scriptRules ?? SQLITE_SCRIPT_RULES)
    if (statements.length !== 1) throw new Error('执行计划一次仅支持一条 SQL')
    if (wb.placeholders(statements[0]!.sql).length) throw new Error('当前执行计划契约暂不支持 SQL 绑定参数')
    explainRequest.value = { connectionId: wb.currentConnectionId.value, sql: statements[0]!.sql }; toolPanel.value = 'explain'
  } catch (cause) { wb.setStatus(errorText(cause), true) }
}
function requestExecute(script = wb.sql.value) {
  toolPanel.value = null
  pendingSql.value = script
  try {
    parameterSlots.value = wb.parameterSlots(script)
    if (parameterSlots.value.length) {
      for (const key of Object.keys(parameterValues)) delete parameterValues[key]
      for (const key of Object.keys(parameterKinds)) delete parameterKinds[key]
      for (const slot of parameterSlots.value) { parameterValues[slot.key] = ''; parameterKinds[slot.key] = 'text' }
      parameterError.value = ''; parameterOpen.value = true
    } else void wb.attempt(() => wb.executeScript(script))
  } catch (cause) { wb.setStatus(errorText(cause), true) }
}
async function executeParameters() {
  try {
    const parameters: ScopedSqlParameter[] = parameterSlots.value.map((slot) => {
      const raw = parameterValues[slot.key] ?? ''
      const kind = parameterKinds[slot.key]
      return { statementIndex: slot.statementIndex, name: slot.name, value: parseParameterValue(raw, kind ?? 'text') }
    })
    parameterOpen.value = false
    await wb.executeScript(pendingSql.value, parameters)
  } catch (cause) { parameterError.value = errorText(cause); wb.setStatus(parameterError.value, true) }
}
async function requestExit() {
  if (exitBusy.value) return
  exitBusy.value = true
  try { if (await wb.guardAllConnections('退出工作台')) await confirmExit() }
  catch (cause) { wb.setStatus(`退出前检查失败：${errorText(cause)}`, true) }
  finally { exitBusy.value = false }
}
onMounted(async () => {
  unlisten = await listen('dbstudio:exit-requested', () => { void requestExit() })
  await wb.boot()
  if (import.meta.env.VITE_DBSTUDIO_TEST_HOOKS === '1') {
    const { installNativeSmoke } = await import('./native-smoke')
    installNativeSmoke(wb, {
      async connection(connection) { connectionEditor.value = connection; await nextTick(); if (!connectionController.value) throw new Error('Connection dialog unavailable'); return connectionController.value },
      async schema(node) { schemaNode.value = node; toolPanel.value = 'schema'; await nextTick(); if (!schemaController.value) throw new Error('Schema panel unavailable'); return schemaController.value },
      async er(id) { toolConnectionId.value = id; toolPanel.value = 'er'; await nextTick(); if (!erController.value) throw new Error('ER panel unavailable'); return erController.value },
      async compare() { toolPanel.value = 'compare'; await nextTick(); if (!compareController.value) throw new Error('Compare panel unavailable'); return compareController.value },
      async transfer(tab, mode) { transfer.value = { tab, mode }; toolPanel.value = null; await nextTick(); if (!transferController.value) throw new Error('Transfer dialog unavailable'); return transferController.value },
      async sqlEditor() { await nextTick(); if (!sqlController.value) throw new Error('SQL editor unavailable'); return sqlController.value },
      async metadata() { await nextTick(); if (!metadataController.value) throw new Error('Metadata tree unavailable'); return metadataController.value },
      async grid(tab) { toolPanel.value = null; wb.activateTab(tab); await nextTick(); if (!gridController.value) throw new Error('Result grid unavailable'); return gridController.value },
      async library() { toolPanel.value = null; await nextTick(); toolPanel.value = 'library'; await nextTick(); if (!libraryController.value) throw new Error('SQL library unavailable'); return libraryController.value },
      async explain(connectionId, sql) { toolPanel.value = null; explainRequest.value = null; await nextTick(); explainRequest.value = { connectionId, sql }; toolPanel.value = 'explain'; await nextTick(); if (!explainController.value) throw new Error('Explain panel unavailable'); return explainController.value },
      async ddl(mode, connectionId, node) { ddl.value = null; await nextTick(); ddl.value = { mode, connectionId, node }; await nextTick(); if (!ddlController.value) throw new Error('DDL dialog unavailable'); return ddlController.value },
      reviewSql: loadPlan,
      async close() { if (transferController.value?.running) throw new Error('Transfer still running'); transfer.value = null; connectionEditor.value = undefined; ddl.value = null; toolPanel.value = null; await nextTick() }
    })
  }
})
onBeforeUnmount(() => unlisten?.())
</script>

<template>
  <div class="workbench" :class="{ 'is-exiting': exitBusy }">
    <header class="app-toolbar"><strong>dbstudio</strong><span class="muted">数据库工作台</span><span class="spacer" /><button :disabled="operationLocked" @click="toolPanel = 'library'">历史 / 收藏</button><button :disabled="operationLocked || !wb.connections.value.some((c) => c.connected)" @click="toolPanel = 'compare'">比较…</button><button :disabled="operationLocked || !selectedConnection?.connected" @click="openEr">ER 图</button><button id="btn-new-connection" :disabled="wb.booting.value || operationLocked" @click="connectionEditor = null">＋ 新建连接</button></header>
    <div v-if="wb.migrationWarning.value" class="warning" role="status">{{ wb.migrationWarning.value }}</div>
    <main class="workspace" :inert="exitBusy || undefined">
      <aside class="tree-pane"><div class="pane-toolbar"><span>数据库导航</span><span class="spacer" /><button id="btn-refresh" :disabled="operationLocked" @click="wb.attempt(wb.refreshConnections)">刷新</button></div><input v-model="treeSearch" class="tree-search" aria-label="筛选已加载对象" placeholder="筛选已加载对象…" /><div id="tree-rows" class="tree-content metadata-tree-host"><MetadataTree ref="metadataController" :workbench="wb" :search="treeSearch" /></div>
        <div v-if="selectedConnection" class="connection-summary"><strong>{{ selectedConnection.name }}</strong><span class="muted">{{ selectedConnection.dialectId }} · {{ selectedConnection.connected ? '已连接' : '未连接' }}</span><p v-if="selectedConnection.secretStored === false" class="warning">密码未保存，请编辑连接重新录入。</p><div class="connection-actions"><button :disabled="operationLocked" @click="connectionEditor = selectedConnection">编辑</button><button v-if="selectedConnection.connected" :disabled="operationLocked" @click="wb.attempt(() => wb.disconnect(selectedConnection!.id))">断开</button><button v-else :disabled="operationLocked" @click="wb.attempt(() => wb.connect(selectedConnection!.id))">连接</button><button :disabled="operationLocked" @click="wb.attempt(() => wb.remove(selectedConnection!.id))">删除</button></div></div>
      </aside>
      <section class="editor-pane">
        <div class="pane-toolbar"><label for="current-connection" class="muted">连接</label><select id="current-connection" :value="wb.currentConnectionId.value" :disabled="operationLocked" @change="wb.selectConnection(($event.target as HTMLSelectElement).value)"><option value="" disabled>请选择连接</option><option v-for="connection in wb.connections.value" :key="connection.id" :value="connection.id">{{ connection.name }}{{ connection.connected ? '' : '（未连接）' }}</option></select><span class="spacer" /><button v-if="wb.executing.value" :disabled="!wb.executionConnection.value?.capabilities?.supportsCancel" @click="wb.attempt(wb.cancelExecution)">取消执行</button><button :disabled="operationLocked || !wb.currentConnection.value?.connected || !wb.sql.value.trim()" @click="requestExplain()">EXPLAIN</button><button id="btn-run-sql" class="primary" :disabled="operationLocked || !wb.currentConnection.value?.connected" @click="requestExecute()">{{ wb.executing.value ? '执行中…' : '执行 SQL' }}</button></div>
        <SqlEditor ref="sqlController" :workbench="wb" :disabled="operationLocked || !wb.currentConnection.value?.connected" @execute="requestExecute" @explain="requestExplain" @library="toolPanel = 'library'" />
        <nav class="result-tabs" aria-label="结果标签"><div v-for="tab in wb.tabs.value" :key="tab.id" class="result-tab" :class="{ 'is-active': wb.activeTabId.value === tab.id }"><button class="tab-label" :aria-selected="wb.activeTabId.value === tab.id" @click="wb.activateTab(tab); toolPanel = null">{{ tab.title }}{{ tab.dirty.size ? ' ●' : '' }}</button><button class="tab-close" :aria-label="`关闭 ${tab.title}`" :disabled="tab.busy || operationLocked" @click="wb.attempt(() => wb.closeTab(tab))">×</button></div></nav>
        <div class="actions result-tools"><button :disabled="operationLocked || !wb.currentConnection.value?.connected || !relational(wb.currentConnectionId.value)" @click="openDdl('create-table')">新建表…</button><button :disabled="operationLocked || !wb.currentConnection.value?.connected || !relational(wb.currentConnectionId.value)" @click="openDdl('create-view')">新建视图…</button></div>
        <div v-if="wb.activeTab.value || tableForDetails" class="actions result-tools"><button :disabled="operationLocked || !tableForDetails" @click="openSchema">结构详情</button><button :disabled="activeResultLocked || wb.activeTab.value?.table?.kind !== 'table'" @click="transfer = { mode: 'import', tab: wb.activeTab.value! }">导入 CSV…</button><button :disabled="activeResultLocked || !wb.activeTab.value?.result" title="选择完整表或当前查询导出；绑定参数会安全内联" @click="transfer = { mode: 'export', tab: wb.activeTab.value! }">导出完整来源…</button><span class="muted">结构与数据按需读取</span></div>
        <ErPanel ref="erController" v-if="toolPanel === 'er' && toolConnectionId" :key="toolConnectionId" :workbench="wb" :connection-id="toolConnectionId" @close="toolPanel = null" />
        <ComparePanel ref="compareController" v-else-if="toolPanel === 'compare'" :workbench="wb" @close="toolPanel = null" @sql="loadPlan" />
        <SchemaPanel ref="schemaController" v-else-if="toolPanel === 'schema' && schemaNode" :key="schemaNode.id" :node="schemaNode" :can-alter="relational(connectionOf(schemaNode.id)) && !operationLocked" @close="toolPanel = null" @open="openSchemaData" @ddl="openDdl" />
        <SqlLibraryPanel v-else-if="toolPanel === 'library'" ref="libraryController" :current-sql="wb.sql.value" @close="toolPanel = null" @load="loadLibrarySql" />
        <ExplainPanel v-else-if="toolPanel === 'explain' && explainRequest" ref="explainController" :key="`${explainRequest.connectionId}:${explainRequest.sql}`" :connection-id="explainRequest.connectionId" :sql="explainRequest.sql" @close="toolPanel = null" />
        <ResultGrid v-else-if="wb.activeTab.value" ref="gridController" :key="wb.activeTab.value.id" :workbench="wb" :tab="wb.activeTab.value" />
        <div v-else class="welcome"><h2>数据库工作台</h2><p class="muted">展开左侧对象树，双击表或视图打开数据</p><p class="muted">SQL 查询与表格修改通过原生数据库核心执行</p></div>
      </section>
    </main>
    <footer id="status-bar" class="status-bar" :class="{ 'is-error': wb.statusError.value }" role="status">{{ wb.status.value }}<span class="spacer" /><span class="muted">Tauri · Vue · Rust</span></footer>
    <ConnectionDialog ref="connectionController" v-if="connectionEditor !== undefined" :workbench="wb" :connection="connectionEditor" @close="connectionEditor = undefined" />
    <TransferDialog ref="transferController" v-if="transfer" :workbench="wb" :tab="transfer.tab" :mode="transfer.mode" @close="transfer = null" />
    <DdlDialog v-if="ddl" ref="ddlController" :workbench="wb" :mode="ddl.mode" :connection-id="ddl.connectionId" :node="ddl.node" @close="ddl = null; toolPanel = null" />
    <div v-if="parameterOpen" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="SQL 参数"><h2>绑定 SQL 参数</h2><p class="muted">参数按语句独立绑定；同名占位符出现在不同语句时也需要分别填写。</p><form @submit.prevent="executeParameters"><label v-for="slot in parameterSlots" :key="slot.key" class="parameter-field"><span>第 {{ slot.statementIndex + 1 }} 条语句（第 {{ slot.startLine }} 行）· {{ slot.name }}</span><select v-model="parameterKinds[slot.key]" :aria-label="`第 ${slot.statementIndex + 1} 条语句 ${slot.name} 类型`"><option value="text">文本</option><option value="number">数字</option><option value="boolean">布尔</option><option value="binary">二进制 Hex</option><option value="null">NULL</option></select><input v-model="parameterValues[slot.key]" :disabled="parameterKinds[slot.key] === 'null'" :aria-label="`第 ${slot.statementIndex + 1} 条语句参数 ${slot.name}`" /></label><p v-if="parameterError" class="is-error">{{ parameterError }}</p><div class="modal-actions"><button type="button" @click="parameterOpen = false">取消</button><button type="submit" class="primary">执行</button></div></form></section></div>
    <div v-if="decision" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="decision-title"><h2 id="decision-title">{{ decision.title }}</h2><p>{{ decision.message }}</p><div class="modal-actions"><button v-for="option in decision.options" :key="option.value" :class="{ danger: option.danger }" @click="decision?.settle(option.value)">{{ option.label }}</button></div></section></div>
  </div>
</template>

<style scoped>
.metadata-tree-host { overflow:hidden; }
</style>
