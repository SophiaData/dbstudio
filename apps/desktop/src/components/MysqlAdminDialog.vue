<script setup lang="ts">
/**
 * MySQL 管理面板：分区、索引、会话、事件与用户权限。
 *
 * 为什么单独成组件而不塞进 DdlDialog：这些是**对象级管理**而非建表/删除那类
 * 单次确认动作，字段形态完全不同；混在一个对话框里会让两边都难读，
 * 也会把 DdlDialog 的提交守卫绑到不相关的操作上。
 *
 * 写操作一律走 workbench 的 changeSchema（事务守卫 + 失效刷新），
 * 本组件只负责收集参数与展示结果。
 */
import { computed, ref, shallowRef } from 'vue'
import type {
  EventListing, IndexChangeSpec, LineageEvidence, ObjectRef, PartitionChangeSpec,
  SearchObjectsResult, SessionListing, UserListing
} from '../../../../src/core/model'
import { errorText } from '../backend'
import type { Workbench } from '../workbench'

type Tab = 'partitions' | 'indexes' | 'sessions' | 'events' | 'users' | 'search' | 'lineage' | 'source' | 'database'

const props = defineProps<{ workbench: Workbench; connectionId: string; node?: ObjectRef }>()
const emit = defineEmits<{ close: [] }>()

const tab = ref<Tab>(props.node?.kind === 'table' ? 'partitions' : 'sessions')
const busy = ref(false)
const error = ref('')
const sessions = shallowRef<SessionListing>([])
const events = shallowRef<EventListing | null>(null)
const users = shallowRef<UserListing | null>(null)
const searchKeyword = ref('')
const searchResult = shallowRef<SearchObjectsResult | null>(null)
const lineageColumn = ref('')
const lineageEvidence = shallowRef<LineageEvidence | null>(null)
const newUser = ref('')
const newUserHost = ref('%')
const newUserPassword = ref('')
const privilegeText = ref('SELECT')
const scopeKind = ref<'global' | 'database' | 'table'>('database')
const scopeDatabase = ref('')
const scopeTable = ref('')
const newDatabase = ref('')
const objectSourceText = ref('')
const confirmAction = ref<{ title: string; run: () => Promise<void> } | null>(null)

const partitionName = ref('')
const partitionBound = ref('MAXVALUE')
const indexName = ref('')
const indexColumns = ref('')

const tableNodeId = computed(() => props.node?.kind === 'table' ? props.node.id : null)
const tabs = computed(() => {
  const items: { id: Tab; label: string }[] = []
  if (tableNodeId.value !== null) {
    items.push({ id: 'partitions', label: '分区' }, { id: 'indexes', label: '索引' })
  }
  items.push(
    { id: 'sessions', label: '会话' },
    { id: 'events', label: '事件' },
    { id: 'users', label: '用户权限' },
    { id: 'search', label: '对象搜索' },
    { id: 'lineage', label: '字段血缘' },
    { id: 'source', label: '对象源码' },
    { id: 'database', label: '新建库' }
  )
  return items
})

async function run(action: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (cause) {
    error.value = errorText(cause)
  } finally {
    busy.value = false
  }
}

async function loadSessions() {
  sessions.value = await props.workbench.listSessions(props.connectionId)
}
async function loadEvents() {
  events.value = await props.workbench.listEvents(props.connectionId)
}
async function loadUsers() {
  users.value = await props.workbench.listUsers(props.connectionId)
}

async function killSession(id: number) {
  await run(async () => {
    await props.workbench.killSession(props.connectionId, id)
    await loadSessions()
  })
}

async function addPartition() {
  const nodeId = tableNodeId.value
  if (nodeId === null) return
  await run(async () => {
    const spec: PartitionChangeSpec = { action: 'add', name: partitionName.value.trim(), lessThan: partitionBound.value.trim() }
    await props.workbench.partitionTable(props.connectionId, nodeId, spec)
    partitionName.value = ''
  })
}

async function dropPartition(name: string) {
  const nodeId = tableNodeId.value
  if (nodeId === null) return
  await run(async () => {
    await props.workbench.partitionTable(props.connectionId, nodeId, { action: 'drop', name })
  })
}

async function addIndex(unique: boolean) {
  const nodeId = tableNodeId.value
  if (nodeId === null) return
  await run(async () => {
    const columns = indexColumns.value.split(',').map((item) => item.trim()).filter((item) => item !== '')
    const spec: IndexChangeSpec = { action: 'add', name: indexName.value.trim(), columns, unique }
    await props.workbench.indexTable(props.connectionId, nodeId, spec)
    indexName.value = ''
    indexColumns.value = ''
  })
}

async function dropIndex(name: string) {
  const nodeId = tableNodeId.value
  if (nodeId === null) return
  await run(async () => {
    await props.workbench.indexTable(props.connectionId, nodeId, { action: 'drop', name })
  })
}

async function runSearch() {
  await run(async () => {
    searchResult.value = await props.workbench.searchObjects(props.connectionId, searchKeyword.value.trim())
  })
}

async function loadLineage() {
  const nodeId = tableNodeId.value
  if (nodeId === null) return
  const parts = nodeId.split('|')
  const raw = parts.length > 1 ? parts[1] : ''
  const qualified = raw.startsWith('table:') ? raw.slice('table:'.length) : raw
  const dot = qualified.lastIndexOf('.')
  if (dot <= 0) throw new Error('请选择具体的表节点')
  const schema = qualified.slice(0, dot)
  const table = qualified.slice(dot + 1)
  await run(async () => {
    lineageEvidence.value = await props.workbench.fieldLineage(props.connectionId, table, lineageColumn.value.trim(), schema)
  })
}

function scopePayload(): Record<string, string> {
  if (scopeKind.value === 'global') return { kind: 'global' }
  if (scopeKind.value === 'database') return { kind: 'database', database: scopeDatabase.value.trim() }
  return { kind: 'table', database: scopeDatabase.value.trim(), table: scopeTable.value.trim() }
}

function privilegeList(): string[] {
  return privilegeText.value.split(/[,，\s]+/).map((item) => item.trim().toUpperCase()).filter((item) => item !== '')
}

async function submitCreateUser() {
  await run(async () => {
    await props.workbench.createUser(props.connectionId, newUser.value.trim(), newUserHost.value.trim(), newUserPassword.value)
    newUser.value = ''
    newUserPassword.value = ''
    await loadUsers()
  })
}

async function submitDropUser(user: string, host: string) {
  await run(async () => {
    await props.workbench.dropUser(props.connectionId, user, host)
    await loadUsers()
  })
}

async function submitGrant(user: string, host: string) {
  await run(async () => {
    await props.workbench.grantPrivilege(props.connectionId, user, host, privilegeList(), scopePayload())
    await loadUsers()
  })
}

async function submitRevoke(user: string, host: string) {
  await run(async () => {
    await props.workbench.revokePrivilege(props.connectionId, user, host, privilegeList(), scopePayload())
    await loadUsers()
  })
}

async function loadObjectSource() {
  const node = props.node
  if (!node || !['view', 'routine', 'trigger'].includes(node.kind)) {
    throw new Error('请在目录树中选择视图、例程或触发器')
  }
  await run(async () => {
    const source = await props.workbench.objectSource(node.id)
    objectSourceText.value = source.sql ?? source.definition ?? source.statement ?? ''
    if (!objectSourceText.value) throw new Error('该对象没有可读源码')
  })
}

async function submitCreateDatabase() {
  await run(async () => {
    await props.workbench.createDatabase(props.connectionId, newDatabase.value.trim())
    newDatabase.value = ''
  })
}

/** 破坏性操作先弹确认，避免一键误伤。 */
function askConfirm(title: string, run: () => Promise<void>) {
  confirmAction.value = { title, run }
}

async function confirmYes() {
  const pending = confirmAction.value
  confirmAction.value = null
  if (pending) await pending.run()
}

async function switchTab(next: Tab) {
  tab.value = next
  if (next === 'sessions') await run(loadSessions)
  if (next === 'events') await run(loadEvents)
  if (next === 'users') await run(loadUsers)
  if (next === 'search') searchResult.value = null
}

void switchTab(tab.value)
</script>

<template>
  <div class="modal-backdrop">
    <section class="modal mysql-admin" role="dialog" aria-modal="true" aria-label="MySQL 管理">
      <header>
        <h2>MySQL 管理</h2>
        <button type="button" @click="emit('close')">关闭</button>
        <div v-if="confirmAction" class="admin-confirm" role="alertdialog">
          <p>{{ confirmAction.title }}</p>
          <button type="button" class="danger" :disabled="busy" @click="confirmYes">确认执行</button>
          <button type="button" :disabled="busy" @click="confirmAction = null">取消</button>
        </div>
      </header>

      <nav class="admin-tabs" role="tablist">
        <button
          v-for="item in tabs"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="tab === item.id"
          :disabled="busy"
          @click="switchTab(item.id)"
        >{{ item.label }}</button>
      </nav>

      <p v-if="error" class="is-error" role="alert">{{ error }}</p>

      <div v-if="tab === 'sessions'" class="admin-panel">
        <button type="button" :disabled="busy" @click="run(loadSessions)">刷新会话</button>
        <table class="admin-table">
          <thead><tr><th>ID</th><th>用户</th><th>来源</th><th>库</th><th>状态</th><th>秒</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="row in sessions" :key="row.id">
              <td>{{ row.id }}<span v-if="row.current" class="tag">当前</span></td>
              <td>{{ row.user }}</td>
              <td>{{ row.host }}</td>
              <td>{{ row.database ?? '—' }}</td>
              <td>{{ row.command }} {{ row.state ?? '' }}</td>
              <td>{{ row.seconds }}</td>
              <td>
                <button type="button" :disabled="busy || row.current" @click="askConfirm(`确认终止会话 ${row.id}？`, () => killSession(row.id))">终止</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!sessions.length" class="muted">尚未读取会话</p>
      </div>

      <div v-if="tab === 'events'" class="admin-panel">
        <button type="button" :disabled="busy" @click="run(loadEvents)">刷新事件</button>
        <p v-if="events">调度器：{{ events.scheduler ?? '未知' }}</p>
        <ul class="admin-list">
          <li v-for="row in events?.items ?? []" :key="`${row.schema}.${row.name}`">
            <strong>{{ row.name }}</strong> · {{ row.status ?? '未知' }} · 每 {{ row.intervalValue ?? '?' }} {{ row.intervalField ?? '' }}
          </li>
        </ul>
        <p v-if="events && !events.items.length" class="muted">该库没有事件</p>
      </div>

      <div v-if="tab === 'users'" class="admin-panel">
        <button type="button" :disabled="busy" @click="run(loadUsers)">刷新用户</button>
        <ul class="admin-list">
          <li v-for="row in users?.users ?? []" :key="`${row.user}@${row.host}`">
            <strong>{{ row.user }}@{{ row.host }}</strong>
            <span v-if="row.locked"> · 已锁定</span>
            <span v-if="row.passwordExpired"> · 密码已过期</span>
            <span v-if="row.plugin"> · {{ row.plugin }}</span>
          </li>
        </ul>
        <p v-if="users" class="muted">共 {{ users.privileges.length }} 条全局权限记录</p>
        <form @submit.prevent="submitCreateUser">
          <label>账号<input v-model="newUser" maxlength="32" placeholder="用户名" required /></label>
          <label>主机<input v-model="newUserHost" maxlength="255" placeholder="%" required /></label>
          <label>口令<input v-model="newUserPassword" type="password" placeholder="留空表示无口令" /></label>
          <button type="submit" :disabled="busy">新建账号</button>
        </form>
        <form @submit.prevent="users && users.users.length ? submitGrant(users.users[0].user, users.users[0].host) : undefined">
          <label>权限<input v-model="privilegeText" placeholder="SELECT, INSERT" required /></label>
          <label>范围<select v-model="scopeKind"><option value="global">全局</option><option value="database">库</option><option value="table">表</option></select></label>
          <label v-if="scopeKind !== 'global'">库名<input v-model="scopeDatabase" maxlength="64" /></label>
          <label v-if="scopeKind === 'table'">表名<input v-model="scopeTable" maxlength="64" /></label>
          <button type="submit" :disabled="busy || !users?.users.length">授权给首个账号</button>
          <button type="button" :disabled="busy || !users?.users.length" @click="users && submitRevoke(users.users[0].user, users.users[0].host)">回收</button>
        </form>

      </div>

      <div v-if="tab === 'search'" class="admin-panel">
        <form @submit.prevent="runSearch">
          <label>关键字<input v-model="searchKeyword" maxlength="128" placeholder="表名 / 列名 / 例程名" required /></label>
          <button type="submit" :disabled="busy">搜索</button>
        </form>
        <table v-if="searchResult" class="admin-table">
          <thead><tr><th>类型</th><th>库</th><th>名称</th><th>定位</th></tr></thead>
          <tbody>
            <tr v-for="item in searchResult.items" :key="item.nodeId + item.name">
              <td>{{ item.kind }}</td>
              <td>{{ item.schema }}</td>
              <td>{{ item.table ? item.table + '.' : '' }}{{ item.name }}</td>
              <td><code>{{ item.nodeId }}</code></td>
            </tr>
          </tbody>
        </table>
        <p v-if="searchResult && !searchResult.items.length" class="muted">没有匹配的对象</p>
        <p v-if="searchResult?.truncated" class="muted">结果已截断，请收窄关键字</p>
      </div>

      <div v-if="tab === 'lineage'" class="admin-panel">
        <p class="muted">在目录树中选中一张表，输入列名后读取真实外键、视图定义与同名列证据。</p>
        <form @submit.prevent="loadLineage">
          <label>列名<input v-model="lineageColumn" maxlength="64" placeholder="例如 parent_id" required /></label>
          <button type="submit" :disabled="busy || !tableNodeId">读取血缘</button>
        </form>
        <ul v-if="lineageEvidence" class="admin-list">
          <li v-for="key in lineageEvidence.foreignKeys" :key="key.name + key.table + key.column">
            <strong>外键（确定）</strong>
            {{ key.table }}.{{ key.column }} → {{ key.refTable }}.{{ key.refColumn }}（{{ key.direction }}）
          </li>
          <li v-for="view in lineageEvidence.views" :key="view.name">
            <span v-if="view.ddl.includes(lineageColumn.trim())">
              <strong>视图（可能）</strong> {{ view.name }}
            </span>
          </li>
        </ul>
        <p v-if="lineageEvidence && !lineageEvidence.foreignKeys.length" class="muted">没有外键证据</p>
      </div>

      <div v-if="tab === 'source'" class="admin-panel">
        <p class="muted">在目录树中选中视图、例程或触发器后读取真实源码。</p>
        <button type="button" :disabled="busy" @click="loadObjectSource">读取源码</button>
        <pre v-if="objectSourceText" class="admin-source">{{ objectSourceText }}</pre>
      </div>

      <div v-if="tab === 'database'" class="admin-panel">
        <form @submit.prevent="submitCreateDatabase">
          <label>数据库名<input v-model="newDatabase" maxlength="64" placeholder="仅字母数字下划线" required /></label>
          <button type="submit" :disabled="busy">新建数据库</button>
        </form>
        <p class="muted">已存在同名库时不会覆盖。</p>
      </div>

      <div v-if="tab === 'partitions'" class="admin-panel">
        <p class="muted">分区表的当前分区的名称与边界显示在目录树中。新增 RANGE 分区：</p>
        <form @submit.prevent="addPartition">
          <label>分区名<input v-model="partitionName" maxlength="64" placeholder="p2026" required /></label>
          <label>边界值<input v-model="partitionBound" maxlength="64" placeholder="MAXVALUE 或 2027" required /></label>
          <button type="submit" :disabled="busy">新增分区</button>
        </form>
        <p v-if="!tableNodeId" class="muted">请先在目录树中选择一张表</p>
      </div>

      <div v-if="tab === 'indexes'" class="admin-panel">
        <form @submit.prevent="addIndex(false)">
          <label>索引名<input v-model="indexName" maxlength="64" placeholder="idx_created" required /></label>
          <label>列（逗号分隔）<input v-model="indexColumns" placeholder="created, id" required /></label>
          <button type="submit" :disabled="busy">新增索引</button>
          <button type="button" :disabled="busy" @click="addIndex(true)">新增唯一索引</button>
        </form>
        <p class="muted">已有索引的列在表结构里可见；删除或修改请使用下方输入。</p>
        <form @submit.prevent="indexName && dropIndex(indexName.trim())">
          <label>删除索引<input v-model="indexName" maxlength="64" placeholder="输入已有索引名" /></label>
          <button type="submit" :disabled="busy || !indexName">删除索引</button>
        </form>
      </div>
    </section>
  </div>
</template>

<style scoped>
.admin-tabs { display: flex; gap: 4px; margin: 8px 0; flex-wrap: wrap; }
.admin-tabs button[aria-selected='true'] { font-weight: 600; }
.admin-panel { display: flex; flex-direction: column; gap: 8px; }
.admin-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.admin-table th, .admin-table td { border-bottom: 1px solid rgba(127, 127, 127, 0.3); padding: 4px 6px; text-align: left; }
.admin-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.tag { margin-left: 6px; padding: 0 4px; border-radius: 3px; background: rgba(64, 128, 255, 0.2); }
.admin-source { max-height: 220px; overflow: auto; padding: 8px; background: rgba(127,127,127,0.12); white-space: pre-wrap; }
.admin-confirm { margin-top: 10px; padding: 8px; border: 1px solid rgba(200,64,64,0.6); border-radius: 4px; }
</style>
