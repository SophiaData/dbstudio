import { computed, reactive, ref, watch } from 'vue'
import type { ConnectionSummary } from '../../../src/core/api'
import type { ConnectionConfig } from '../../../src/core/dialect'
import type { DialectInfo, SecretMap } from '../../../src/core/driver'
import type { ObjectRef, TableDescription } from '../../../src/core/model'
import type { CellValue, QueryResult, ResultPage, ResultRow, RowUpdate, SqlParameter, TransactionState } from '../../../src/core/resultset'
import type { RecordSqlHistoryInput } from '../../../src/core/sql-library'
import { splitStatements, SQLITE_SCRIPT_RULES } from '../../../src/core/sql-script'
import { extractSqlParameters, bindSqlParameters, type SqlParameterDialect } from '../../../src/core/sql-parameters'
import { parseFilter, buildFilteredSql } from '../../../src/renderer/filter-sql'
import { backend, errorText, migrationStatus } from './backend'
import { askDecision, confirmAction } from './dialogs'
import {
  createDraftStore,
  parseNumericCell,
  scopedParametersForStatement,
  statementParameterSlots,
  validateScopedSqlParameters,
  type ScopedSqlParameter
} from './sql-editor-model'

export interface TreeNode {
  ref: ObjectRef
  children: TreeNode[]
  expanded: boolean
  loaded: boolean
  loading: boolean
  error: string
}
export interface ResultTab {
  id: string
  connectionId: string
  title: string
  table: ObjectRef | null
  description: TableDescription | null
  sql: string
  querySql: string
  parameters: SqlParameter[]
  result: QueryResult | null
  page: ResultPage | null
  message: string
  busy: boolean
  invalidated: boolean
  dirty: Map<number, RowUpdate>
  selectedRows: Set<number>
  filter: string
  order: { column: string; direction: 'ASC' | 'DESC' } | null
  generation: number
}
export interface ActiveTabContext {
  tabId: string
  connectionId: string
  tableNodeId: string | null
  cursorId: string | null
  hasLocalChanges: boolean
}
const PAGE_SIZE = 200
export const connectionOf = (nodeId: string) => nodeId.startsWith('connection:') ? nodeId.slice(11).split('|')[0]! : nodeId
export const connectionNode = (id: string) => `connection:${id}`
export function cellText(cell: CellValue): string {
  switch (cell.kind) {
    case 'null': return 'NULL'
    case 'number': return String(cell.value)
    case 'boolean': return cell.value ? 'true' : 'false'
    case 'text': return cell.text + (cell.truncated ? '…' : '')
    case 'blob': return `[BLOB ${cell.length} bytes]`
  }
}
export function inputCell(raw: string, kind: string, isNull = false): CellValue {
  if (isNull) return { kind: 'null' }
  if (kind === 'number' || kind === 'integer' || kind === 'real') {
    return parseNumericCell(raw)
  }
  if (kind === 'boolean') {
    if (!['true', 'false', '1', '0'].includes(raw.toLowerCase())) throw new Error('布尔值只允许 true/false 或 1/0')
    return { kind: 'boolean', value: ['true', '1'].includes(raw.toLowerCase()) }
  }
  return { kind: 'text', text: raw }
}

export function useWorkbench() {
  const connections = ref<ConnectionSummary[]>([])
  const dialects = ref<DialectInfo[]>([])
  const roots = ref<TreeNode[]>([])
  const selected = ref<ObjectRef | null>(null)
  const currentConnectionId = ref('')
  const sql = ref('')
  const sqlDrafts = createDraftStore(typeof localStorage === 'undefined' ? null : localStorage)
  watch(sql, (text) => sqlDrafts.write(currentConnectionId.value, text), { flush: 'sync' })
  const tabs = ref<ResultTab[]>([])
  const activeTabId = ref('')
  const transactions = reactive<Record<string, TransactionState>>({})
  const locks = reactive(new Set<string>())
  const backgroundTasks = reactive(new Map<string, 'import' | 'export'>())
  const pendingEditors = reactive(new Set<string>())
  const status = ref('正在连接原生后端…')
  const statusError = ref(false)
  const booting = ref(true)
  const metadataReady = ref(false)
  const executing = ref(false)
  const activeSignal = ref('')
  const executionConnectionId = ref('')
  const executionConnection = computed(() => connections.value.find((connection) => connection.id === executionConnectionId.value) ?? null)
  const migrationWarning = ref('')
  const currentConnection = computed(() => connections.value.find((c) => c.id === currentConnectionId.value) ?? null)
  const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value) ?? null)
  const activeContext = computed<ActiveTabContext | null>(() => {
    const tab = activeTab.value
    return tab ? { tabId: tab.id, connectionId: tab.connectionId, tableNodeId: tab.table?.id ?? null, cursorId: tab.result?.cursorId ?? null, hasLocalChanges: tab.dirty.size > 0 } : null
  })
  function setStatus(message: string, error = false) { status.value = message; statusError.value = error }
  async function attempt(action: () => Promise<unknown>) {
    try { return await action() } catch (cause) { setStatus(errorText(cause), true); return undefined }
  }
  async function withConnectionOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (executing.value || locks.has(id) || tabs.value.some((tab) => tab.connectionId === id && tab.busy)) throw new Error('当前连接正在处理操作，请稍候')
    locks.add(id)
    try { return await operation() }
    finally { locks.delete(id) }
  }
  const makeNode = (node: ObjectRef): TreeNode => ({ ref: node, children: [], expanded: false, loaded: false, loading: false, error: '' })
  async function refreshConnections() {
    const [list, nodes] = await Promise.all([backend.listConnections(), backend.listChildren(null)])
    connections.value = list
    roots.value = nodes.map(makeNode)
    metadataReady.value = true
    if (selected.value?.kind === 'connection') selected.value = nodes.find((node) => node.id === selected.value?.id) ?? null
    if (!list.some((c) => c.id === currentConnectionId.value)) selectConnection(list[0]?.id ?? '')
    setStatus(list.length ? `共 ${list.length} 个连接 · ${list.filter((c) => c.connected).length} 个已连接` : '还没有连接，点击「新建连接」开始')
  }
  async function boot() {
    try {
      dialects.value = await backend.listDialects()
      await refreshConnections()
      const migration = await migrationStatus()
      migrationWarning.value = migration.legacySecretsRequireReentry ? '已迁移旧连接配置，请编辑连接并重新输入密码。' : migration.warnings.join('；')
    } catch (cause) { setStatus(errorText(cause), true) }
    finally { booting.value = false }
  }
  function selectConnection(id: string) {
    sqlDrafts.write(currentConnectionId.value, sql.value)
    currentConnectionId.value = id
    sql.value = sqlDrafts.read(id)
  }
  function activateTab(tab: ResultTab | string) {
    const target = typeof tab === 'string' ? tabs.value.find((candidate) => candidate.id === tab) : tab
    if (!target) return
    activeTabId.value = target.id
    selectConnection(target.connectionId)
  }
  function selectNode(node: ObjectRef) {
    selected.value = node
    selectConnection(connectionOf(node.id))
  }
  async function toggleNode(node: TreeNode) {
    if (!node.ref.hasChildren) return
    node.expanded = !node.expanded
    if (!node.expanded || node.loaded || node.loading) return
    node.loading = true
    node.error = ''
    try { node.children = (await backend.listChildren(node.ref.id)).map(makeNode); node.loaded = true }
    catch (cause) { node.error = errorText(cause); node.expanded = false; setStatus(node.error, true) }
    finally { node.loading = false }
  }
  function dialectFor(connectionId: string) {
    const id = connections.value.find((c) => c.id === connectionId)?.dialectId
    return dialects.value.find((d) => d.id === id)
  }
  function quote(name: string, connectionId: string) {
    const rules = dialectFor(connectionId)?.quoting
    if (!rules) throw new Error('缺少方言引用规则，无法安全生成 SQL')
    const escaped = rules.escape === 'double' ? name.split(rules.close).join(rules.close + rules.close) : name.split('\\').join('\\\\').split(rules.close).join('\\' + rules.close)
    return rules.open + escaped + rules.close
  }
  async function readTransaction(id: string) {
    const state = await backend.transactionState(connectionNode(id))
    transactions[id] = state
    return state
  }
  async function releaseCursor(tab: ResultTab) {
    const id = tab.result?.cursorId
    if (id) await backend.closeCursor(id)
  }
  function newTab(connectionId: string, title: string, sqlText: string, table: ObjectRef | null = null, description: TableDescription | null = null): ResultTab {
    const tab: ResultTab = reactive({
      id: crypto.randomUUID(), connectionId, title, table, description, sql: sqlText, querySql: sqlText,
      parameters: [], result: null, page: null, message: '', busy: false, invalidated: false,
      dirty: new Map(), selectedRows: new Set(), filter: '', order: null, generation: 0
    })
    tabs.value.push(tab)
    activateTab(tab)
    return tab
  }
  async function setResult(tab: ResultTab, result: QueryResult) {
    const previous = tab.result?.cursorId
    tab.result = result; tab.page = result; tab.selectedRows.clear()
    if (previous && previous !== result.cursorId) await backend.closeCursor(previous)
  }
  async function openTable(node: ObjectRef) {
    selectNode(node)
    const desc = await backend.describeTable(node.id)
    const sqlText = await backend.tableSelectSql(node.id)
    const tab = newTab(connectionOf(node.id), node.name, sqlText, node, desc)
    tab.busy = true
    try {
      await setResult(tab, await backend.runQuery(connectionNode(tab.connectionId), sqlText, { limit: PAGE_SIZE, keepCursor: true }))
      await readTransaction(tab.connectionId)
      setStatus(`已打开 ${node.name}`)
    } catch (cause) { tab.message = errorText(cause); throw cause }
    finally { tab.busy = false }
  }
  const parameterDialect = (id: string): SqlParameterDialect => {
    const dialect = dialectFor(id)?.id
    return dialect === 'postgresql' || dialect === 'mysql' ? dialect : 'sqlite'
  }
  function placeholders(script: string) {
    return extractSqlParameters(script, parameterDialect(currentConnectionId.value))
  }
  function parameterSlots(script: string) {
    const connection = currentConnection.value
    if (!connection) return []
    return statementParameterSlots(
      script,
      dialectFor(connection.id)?.scriptRules ?? SQLITE_SCRIPT_RULES,
      parameterDialect(connection.id)
    )
  }
  async function recordHistory(input: RecordSqlHistoryInput) {
    try { await backend.recordSqlHistory(input) }
    catch (cause) { return `历史记录保存失败：${errorText(cause)}` }
    return ''
  }
  async function executeScript(script = sql.value, parameters: ScopedSqlParameter[] = []) {
    const connection = currentConnection.value
    if (!connection?.connected) throw new Error('请先选择一个已连接的数据源')
    if (executing.value || locks.has(connection.id)) throw new Error('当前连接正在处理操作，请稍候')
    const statements = splitStatements(script, dialectFor(connection.id)?.scriptRules ?? SQLITE_SCRIPT_RULES)
    if (!statements.length) throw new Error('没有可执行的 SQL')
    validateScopedSqlParameters(parameters, statements.length)
    for (const statement of statements) {
      bindSqlParameters(
        statement.sql,
        scopedParametersForStatement(parameters, statement.index),
        parameterDialect(connection.id)
      )
    }
    executing.value = true
    executionConnectionId.value = connection.id
    activeSignal.value = crypto.randomUUID()
    let historyWarning = ''
    try {
      for (const statement of statements) {
        const supplied = scopedParametersForStatement(parameters, statement.index)
        const tab = newTab(connection.id, `SQL ${statement.index + 1}`, statement.sql)
        tab.parameters = supplied
        tab.busy = true
        const startedAt = performance.now()
        let executed = false
        try {
          const result = await backend.executeStatement(connectionNode(connection.id), statement.sql, { limit: PAGE_SIZE, keepCursor: true, parameters: supplied, signalId: activeSignal.value })
          executed = true
          historyWarning = await recordHistory({ sql: statement.sql, connectionId: connection.id, dialectId: connection.dialectId, elapsedMs: performance.now() - startedAt, status: 'success', returnedRows: result.kind === 'rows' ? result.result.returned : undefined }) || historyWarning
          if (result.kind === 'rows') await setResult(tab, result.result)
          else if (result.kind === 'affected') { tab.message = `影响 ${result.affected} 行 · ${Math.round(result.elapsedMs)} ms`; transactions[connection.id] = result.transactionState }
          else { tab.message = result.summary; await refreshConnections() }
          await readTransaction(connection.id)
        } catch (cause) {
          try { await readTransaction(connection.id) }
          catch { /* Keep the original execution error if transaction state is unavailable. */ }
          if (!executed) await recordHistory({ sql: statement.sql, connectionId: connection.id, dialectId: connection.dialectId, elapsedMs: performance.now() - startedAt, status: 'error', error: errorText(cause) })
          tab.message = `第 ${statement.startLine} 行：${errorText(cause)}`; throw new Error(tab.message)
        }
        finally { tab.busy = false }
      }
      setStatus(`已执行 ${statements.length} 条语句${historyWarning ? ` · ${historyWarning}` : ''}`, Boolean(historyWarning))
    } finally { executing.value = false; activeSignal.value = ''; executionConnectionId.value = '' }
  }
  async function cancelExecution() {
    const id = executionConnectionId.value
    const signal = activeSignal.value
    if (!executing.value || !id || !signal) throw new Error('当前没有正在执行的查询')
    if (!executionConnection.value?.capabilities?.supportsCancel) throw new Error('当前执行查询的驱动不支持取消')
    const cancelled = await backend.cancelQuery(connectionNode(id), signal)
    setStatus(cancelled ? '已请求取消执行' : '未取消：当前没有正在执行的查询或驱动无法取消', !cancelled)
  }
  function rowKeys(tab: ResultTab, row: ResultRow): Record<string, CellValue> {
    const keys = tab.description?.columns.filter((c) => c.primaryKeyOrdinal !== null).sort((a, b) => a.primaryKeyOrdinal! - b.primaryKeyOrdinal!) ?? []
    if (!tab.description?.hasUniqueKey || !keys.length) throw new Error('该结果没有完整主键，只读')
    const result: Record<string, CellValue> = {}
    for (const key of keys) {
      const columns = tab.page?.columns ?? []
      const exact = columns.map((col, i) => col.name === key.name ? i : -1).filter((i) => i >= 0)
      const matches = exact.length ? exact : columns.map((col, i) => col.name.toLowerCase() === key.name.toLowerCase() ? i : -1).filter((i) => i >= 0)
      if (matches.length !== 1) throw new Error('主键列不完整或名称有歧义，无法安全修改')
      const value = row.cells[matches[0]!]
      if (!value || value.kind === 'null' || ('truncated' in value && value.truncated)) throw new Error('主键值为空或被截断，无法修改')
      result[key.name] = value
    }
    return result
  }
  function editableSource(tab: ResultTab) {
    const connection = connections.value.find((c) => c.id === tab.connectionId)
    return !tab.invalidated && Boolean(tab.table?.kind === 'table' && tab.description?.hasUniqueKey && connection?.connected && connection.capabilities?.supportsInlineEdit)
  }
  function canEdit(tab: ResultTab) {
    return !executing.value && !tab.busy && !locks.has(tab.connectionId) && editableSource(tab)
  }
  function stageCell(tab: ResultTab, row: ResultRow, column: string, value: CellValue) {
    if (!canEdit(tab)) throw new Error('当前结果不可编辑')
    const keyValues = rowKeys(tab, row)
    const old = tab.dirty.get(row.index)
    const changes = { ...old?.changes, [column]: value }
    const index = tab.page!.columns.findIndex((c) => c.name === column)
    if (JSON.stringify(row.cells[index]) === JSON.stringify(value)) delete changes[column]
    if (Object.keys(changes).length) tab.dirty.set(row.index, { keyValues, changes })
    else tab.dirty.delete(row.index)
  }
  async function reloadTab(tab: ResultTab, guard = true, offset = 0) {
    if (tab.invalidated) throw new Error('连接已关闭或更新，请重新打开结果')
    if (guard && !(await guardLocal(tab, '刷新结果'))) return
    tab.busy = true
    const generation = ++tab.generation
    try {
      const result = await backend.runQuery(connectionNode(tab.connectionId), tab.querySql, { limit: PAGE_SIZE, offset, keepCursor: true, parameters: tab.parameters })
      if (generation !== tab.generation) { if (result.cursorId) await backend.closeCursor(result.cursorId); return }
      await setResult(tab, result)
    } finally { tab.busy = false }
  }
  async function pageTab(tab: ResultTab, direction: number) {
    if (!tab.result?.cursorId || !tab.page || tab.busy || tab.invalidated) return
    const targetOffset = Math.max(0, tab.page.offset + direction * PAGE_SIZE)
    if (!(await guardLocal(tab, '翻页'))) return
    if (!tab.result?.cursorId || !tab.page || tab.invalidated) return
    tab.busy = true
    try { tab.page = await backend.fetchResultPage(tab.result.cursorId, targetOffset, PAGE_SIZE); tab.selectedRows.clear() }
    finally { tab.busy = false }
  }
  async function transformTab(tab: ResultTab) {
    if (!(await guardLocal(tab, '排序或筛选'))) return
    const quoteColumn = (name: string) => quote(name, tab.connectionId)
    const filter = parseFilter(tab.filter, quoteColumn)
    if (!filter.ok) throw new Error(filter.error)
    const base = tab.sql.trim().replace(/;\s*$/, '')
    tab.querySql = buildFilteredSql({ sourceKind: 'sql', sql: base }, filter.conditions, quoteColumn)
    if (tab.order) tab.querySql += ` ORDER BY ${quoteColumn(tab.order.column)} ${tab.order.direction}`
    await reloadTab(tab, false)
  }
  async function applyTab(tab: ResultTab) {
    if (!tab.table || !tab.dirty.size) return
    if (tab.busy || tab.invalidated) throw new Error('当前结果不可应用修改')
    tab.busy = true
    try {
      const offset = tab.page?.offset ?? 0
      const updates = [...tab.dirty.values()]
      const wasActive = transactions[tab.connectionId]?.active === true
      const result = await backend.applyEdits(tab.table.id, updates).catch(async (cause: unknown) => {
        let state: TransactionState | null = null
        try { state = await readTransaction(tab.connectionId) } catch { /* Preserve the original apply error when state cannot be confirmed. */ }
        const mysqlDeadlock = cause !== null && typeof cause === 'object' &&
          'code' in cause && cause.code === 'driver-error' &&
          'message' in cause && cause.message === 'MySQL操作失败(SQLSTATE 40001, code 1213)' &&
          connections.value.some((connection) => connection.id === tab.connectionId && connection.dialectId === 'mysql')
        if (wasActive && state?.active === false && state.pendingAffected === 0 && mysqlDeadlock) {
          throw Object.assign(new Error('MySQL操作失败(SQLSTATE 40001, code 1213)；整个事务已回滚；本地草稿已保留。请处理草稿后刷新结果'), { code: 'driver-error' })
        }
        throw cause
      })
      await readTransaction(tab.connectionId)
      if (!result.ok) throw new Error(result.outcomes.filter((item) => item.error).map((item) => item.error).join('；') || '部分修改失败，请回滚当前连接事务')
      tab.dirty.clear()
      await reloadTab(tab, false, offset)
      setStatus(`已应用 ${result.affected} 行，尚未提交`)
    } finally { tab.busy = false }
  }
  async function guardLocal(tab: ResultTab, action: string) {
    if (!tab.dirty.size) return 'clean' as const
    const choice = await askDecision(action, `「${tab.title}」有 ${tab.dirty.size} 行尚未应用的修改。`, [
      { value: 'apply', label: '应用修改' }, { value: 'discard', label: '放弃本地修改', danger: true }, { value: 'cancel', label: '取消' }
    ])
    if (choice === 'cancel') return false
    if (choice === 'apply') { await applyTab(tab); return 'applied' as const }
    tab.dirty.clear()
    return 'discarded' as const
  }
  async function refreshConnectionTabs(id: string) {
    for (const tab of tabs.value.filter((t) => t.connectionId === id && t.result && !t.invalidated)) await reloadTab(tab, false)
  }
  async function settleTransaction(id: string, commit: boolean) {
    const localTabs = tabs.value.filter((tab) => tab.connectionId === id && tab.dirty.size)
    if (commit) {
      for (const tab of localTabs) await applyTab(tab)
      transactions[id] = await backend.commitTransaction(connectionNode(id))
    } else {
      const dirtyCount = localTabs.reduce((sum, tab) => sum + tab.dirty.size, 0)
      const state = await readTransaction(id)
      if ((dirtyCount || state.active) && !(await confirmAction('回滚当前连接', `将放弃当前连接所有标签中的本地修改及未提交事务。`))) return false
      transactions[id] = await backend.rollbackTransaction(connectionNode(id))
      for (const tab of localTabs) tab.dirty.clear()
    }
    await refreshConnectionTabs(id)
    setStatus(commit ? '已提交当前连接事务' : '已回滚当前连接事务')
    return true
  }
  async function guardConnection(id: string, action: string) {
    const connection = connections.value.find((c) => c.id === id)
    const state = connection?.connected ? await readTransaction(id) : { active: false, pendingAffected: 0 }
    const dirty = tabs.value.filter((tab) => tab.connectionId === id).reduce((sum, tab) => sum + tab.dirty.size, 0)
    if (!state.active && !dirty) return true
    const choice = await askDecision(action, `当前连接有 ${dirty} 行本地修改${state.active ? `，事务中有 ${state.pendingAffected} 行未提交` : ''}。该操作影响此连接的全部标签。`, [
      { value: 'commit', label: '应用并提交' }, { value: 'rollback', label: '放弃并回滚', danger: true }, { value: 'cancel', label: '取消' }
    ])
    if (choice === 'cancel') return false
    if (choice === 'commit') {
      for (const tab of tabs.value.filter((tab) => tab.connectionId === id && tab.dirty.size)) await applyTab(tab)
      transactions[id] = await backend.commitTransaction(connectionNode(id))
    } else {
      if (state.active) transactions[id] = await backend.rollbackTransaction(connectionNode(id))
      for (const tab of tabs.value.filter((tab) => tab.connectionId === id)) tab.dirty.clear()
    }
    await refreshConnectionTabs(id)
    return true
  }
  async function invalidateConnection(id: string) {
    for (const tab of tabs.value.filter((t) => t.connectionId === id)) {
      tab.invalidated = true; tab.generation++; tab.dirty.clear(); tab.selectedRows.clear()
      await releaseCursor(tab)
      tab.result = null; tab.page = null; tab.message = '连接已关闭或更新，请重新打开结果'
    }
    delete transactions[id]
  }
  async function mutateConnection(id: string, action: string, operation: () => Promise<unknown>) {
    if (executing.value || locks.has(id) || tabs.value.some((tab) => tab.connectionId === id && tab.busy)) throw new Error('当前连接正在处理操作，请稍候')
    locks.add(id)
    try {
      if (!(await guardConnection(id, action))) return false
      try { await operation() } finally { await invalidateConnection(id) }
      await refreshConnections()
      return true
    } finally { locks.delete(id) }
  }
  async function saveConnection(config: ConnectionConfig, secret: SecretMap, id?: string) {
    if (id) {
      return mutateConnection(id, '更新连接', () => backend.updateConnection(id, config, Object.keys(secret).length ? secret : undefined))
    }
    const connection = await backend.addConnection(config, secret)
    selectConnection(connection.id)
    await refreshConnections()
    setStatus(connection.connected ? `已连接：${connection.name}` : `配置已保存，会话未连接：${connection.name}`, !connection.connected)
    return true
  }
  async function connect(id: string) {
    if (locks.has(id)) throw new Error('当前连接正在处理操作，请稍候')
    locks.add(id)
    try { await backend.connectConnection(id); await refreshConnections() }
    finally { locks.delete(id) }
  }
  async function disconnect(id: string) { await mutateConnection(id, '断开连接', () => backend.disconnectConnection(id)) }
  async function remove(id: string) {
    if (!(await confirmAction('删除连接', '确认删除此连接配置与保存的凭据？'))) return
    await mutateConnection(id, '删除连接', () => backend.removeConnection(id))
  }
  async function closeTab(tab: ResultTab) {
    if (tab.busy) return
    const last = tabs.value.filter((t) => t.connectionId === tab.connectionId).length === 1
    if (last ? !(await guardConnection(tab.connectionId, '关闭最后一个结果标签')) : !(await guardLocal(tab, '关闭结果标签'))) return
    await releaseCursor(tab)
    tabs.value = tabs.value.filter((t) => t.id !== tab.id)
    if (activeTabId.value === tab.id) {
      const next = tabs.value.at(-1)
      if (next) activateTab(next)
      else activeTabId.value = ''
    }
  }
  async function insertRow(tab: ResultTab, values: Record<string, CellValue>): Promise<boolean> {
    if (!editableSource(tab) || tab.busy || !tab.table) throw new Error('当前表不可新增行')
    if (!(await guardLocal(tab, '插入行'))) return false
    const result = await backend.insertRow(tab.table.id, values)
    await readTransaction(tab.connectionId); await reloadTab(tab, false)
    setStatus(`已插入 ${result.affected} 行，尚未提交`)
    return true
  }
  async function deleteSelected(tab: ResultTab) {
    if (!editableSource(tab) || tab.busy || !tab.table || !tab.page) throw new Error('当前结果不可删除')
    const rows = tab.page.rows.filter((row) => tab.selectedRows.has(row.index))
    if (!rows.length) throw new Error('请先勾选需要删除的行')
    const identities = rows.map((row) => {
      const before = rowKeys(tab, row)
      const changes = tab.dirty.get(row.index)?.changes ?? {}
      const after = Object.fromEntries(Object.entries(before).map(([name, value]) => [name, changes[name] ?? value]))
      return { before, after }
    })
    if (!(await confirmAction('删除选中行', `将删除 ${identities.length} 行，需要提交事务后才会生效。`))) return
    const settled = await guardLocal(tab, '删除行')
    if (!settled) return
    const keys = identities.map((identity) => settled === 'applied' ? identity.after : identity.before)
    if (keys.some((key) => Object.values(key).some((value) => value.kind === 'null' || ('truncated' in value && value.truncated)))) throw new Error('修改后的主键为空或被截断，无法安全删除')
    const result = await backend.deleteRows(tab.table.id, keys)
    await readTransaction(tab.connectionId)
    if (!result.ok) throw new Error('删除部分失败，请回滚当前连接事务')
    await reloadTab(tab, false); setStatus(`已删除 ${result.affected} 行，尚未提交`)
  }
  async function changeSchema(id: string, action: string, operation: () => Promise<void>, invalidates = false) {
    return withConnectionOperation(id, async () => {
      if (!(await guardConnection(id, action))) return false
      await operation()
      if (invalidates) await invalidateConnection(id)
      await refreshConnections()
      await readTransaction(id)
      setStatus(`${action}已完成`)
      return true
    })
  }
  async function guardAllConnections(action: string) {
    if (pendingEditors.size) { setStatus('请先保存或取消正在编辑的单元格/新增行，再退出工作台', true); return false }
    if (backgroundTasks.size) { setStatus('导入导出任务正在运行，请等待完成或先取消任务后退出', true); return false }
    if (executing.value || locks.size || tabs.value.some((tab) => tab.busy)) { setStatus('请等待当前操作完成后退出', true); return false }
    const ids = new Set([...connections.value.map((c) => c.id), ...tabs.value.map((t) => t.connectionId)])
    for (const id of ids) if (!(await guardConnection(id, action))) return false
    return true
  }
  return {
    connections, dialects, roots, selected, currentConnectionId, currentConnection, sql, tabs, activeTabId, activeTab, activeContext,
    transactions, locks, backgroundTasks, pendingEditors, status, statusError, booting, metadataReady, executing, executionConnectionId, executionConnection, migrationWarning,
    setStatus, attempt, boot, refreshConnections, selectConnection, activateTab, selectNode, toggleNode, placeholders, parameterSlots,
    executeScript, cancelExecution, stageCell, canEdit, rowKeys,
    openTable: (node: ObjectRef) => withConnectionOperation(connectionOf(node.id), () => openTable(node)),
    applyTab: (tab: ResultTab) => withConnectionOperation(tab.connectionId, () => applyTab(tab)),
    pageTab: (tab: ResultTab, direction: number) => withConnectionOperation(tab.connectionId, () => pageTab(tab, direction)),
    reloadTab: (tab: ResultTab, guard = true) => withConnectionOperation(tab.connectionId, () => reloadTab(tab, guard)),
    transformTab: (tab: ResultTab) => withConnectionOperation(tab.connectionId, () => transformTab(tab)),
    settleTransaction: (id: string, commit: boolean) => withConnectionOperation(id, () => settleTransaction(id, commit)),
    saveConnection, connect, disconnect, remove,
    closeTab: (tab: ResultTab) => withConnectionOperation(tab.connectionId, () => closeTab(tab)),
    insertRow: (tab: ResultTab, values: Record<string, CellValue>) => withConnectionOperation(tab.connectionId, () => insertRow(tab, values)),
    deleteSelected: (tab: ResultTab) => withConnectionOperation(tab.connectionId, () => deleteSelected(tab)),
    guardConnection, guardAllConnections, readTransaction, changeSchema
  }
}
export type Workbench = ReturnType<typeof useWorkbench>
