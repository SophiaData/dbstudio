import { computed, reactive, ref } from 'vue'
import type { ConnectionSummary } from '../../../src/core/api'
import type { ConnectionConfig } from '../../../src/core/dialect'
import type { DialectInfo, SecretMap } from '../../../src/core/driver'
import type {
  IndexChangeSpec, ObjectRef, PartitionChangeSpec, TableDescription
} from '../../../src/core/model'
import type { CellValue, QueryResult, ResultPage, ResultRow, RowUpdate, SqlParameter, TransactionState } from '../../../src/core/resultset'
import type { RecordSqlHistoryInput } from '../../../src/core/sql-library'
import { splitStatements, SQLITE_SCRIPT_RULES } from '../../../src/core/sql-script'
import { extractSqlParameters, bindSqlParameters, type SqlParameterDialect } from '../../../src/core/sql-parameters'
import { parseFilter, buildFilteredSql } from '../../../src/core/filter-sql'
import { backend, errorText, migrationStatus } from './backend'
import { askDecision, confirmAction } from './dialogs'
import { connectionTarget as makeConnectionTarget, contextQuery, readSessionContext, sameSession, unknownSession, type ConnectionTarget, type SessionContext } from './connection-context'
import {
  createEditorTabStore,
  parseNumericCell,
  type SqlEditorTab,
  scopedParametersForStatement,
  statementParameterSlots,
  validateScopedSqlParameters,
  type SqlSourceRange,
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
export interface EditorExecution {
  readonly editorTabId: string
  readonly connectionId: string
  readonly connectionRevision: number
  readonly sessionVersion?: number
  readonly target?: ConnectionTarget
  readonly sql: string
  readonly source?: SqlSourceRange
}
export interface SqlExecutionFailure {
  readonly message: string
  readonly statementIndex: number
  readonly sql: string
  readonly startLine: number
  readonly endLine: number
  readonly phase: 'execution' | 'after-execution'
  readonly source?: SqlSourceRange
}
export interface SortKey {
  readonly column: string
  readonly direction: 'ASC' | 'DESC'
}
export interface RowCountTask {
  signalId: string
  running: boolean
  settled: boolean
  cancelling: boolean
  cancelRequested: boolean
  value: number | null
  message: string
  error: string
  page: ResultPage | null
  result: QueryResult | null
  generation: number
  cursorId?: string | null
  tableId: string
}
export interface ResultTab {
  id: string
  connectionId: string
  editorTabId?: string
  executionContext?: ConnectionTarget
  contextStale?: boolean
  contextRevision?: number
  executionFailed?: boolean
  failure?: SqlExecutionFailure
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
  appliedFilter?: string
  pageSize?: number
  rowCountTask?: RowCountTask
  order: readonly SortKey[]
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
export const RESULT_PAGE_SIZES = [100, 200, 500, 1000] as const
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
  const editorStore = createEditorTabStore(typeof localStorage === 'undefined' ? null : localStorage)
  const editorTabs = ref<SqlEditorTab[]>(editorStore.restored?.tabs ?? [])
  const restoredActive = editorStore.restored?.activeTabId
  const activeEditorTabId = ref(editorTabs.value.some((tab) => tab.id === restoredActive) ? restoredActive! : editorTabs.value[0]?.id ?? '')
  const activeEditorTab = computed(() => editorTabs.value.find((tab) => tab.id === activeEditorTabId.value) ?? null)
  const currentConnectionId = computed(() => activeEditorTab.value?.connectionId ?? '')
  const editorStorageWarning = ref(editorStore.warning)
  const connectionRevisions = new Map<string, number>()
  const sessionContexts = reactive<Record<string, SessionContext>>({})
  const sessionVersions = new Map<string, number>()
  function updateSessionContext(id: string, value: SessionContext) {
    sessionContexts[id] = value
    for (const tab of tabs.value) {
      const origin = tab.executionContext
      if (tab.connectionId === id && !tab.table && origin && contextQuery(origin.dialectId)) {
        tab.contextRevision = (tab.contextRevision ?? 0) + 1
        tab.contextStale = origin.session.status !== 'ready' || value.status !== 'ready' || !sameSession(origin.session, value)
      }
    }
  }
  function connectionTarget(id: string) {
    const connection = connections.value.find(item => item.id === id)
    return makeConnectionTarget(connection, id, connection?.connected ? sessionContexts[id] ?? unknownSession() : unknownSession())
  }
  function forgetSession(id: string) {
    updateSessionContext(id, unknownSession())
    sessionVersions.set(id, (sessionVersions.get(id) ?? 0) + 1)
  }
  async function refreshSessionContext(id: string, signalId?: string) {
    const connection = connections.value.find(item => item.id === id)
    const query = contextQuery(connection?.dialectId ?? '')
    if (!connection?.connected || !query) { updateSessionContext(id, unknownSession()); return }
    const revision = connectionRevisions.get(id) ?? 0
    const marker: SessionContext = reactive({ status: 'loading', database: null, schema: null })
    updateSessionContext(id, marker)
    const owns = () => sessionContexts[id] === marker && (connectionRevisions.get(id) ?? 0) === revision &&
      connections.value.some(item => item.id === id && item.connected && item.dialectId === connection.dialectId)
    try {
      const result = await backend.runQuery(connectionNode(id), query, { limit: 1, keepCursor: false, ...(signalId ? { signalId } : {}) })
      const value = readSessionContext(result, connection.dialectId)
      if (owns()) updateSessionContext(id, value)
    } catch (cause) {
      if (owns()) updateSessionContext(id, { status: 'error', database: null, schema: null, error: errorText(cause) })
    }
  }
  let legacyDraftsRestored = editorStore.restored?.legacyDraftsRestored === true
  const persistEditorTabs = () => {
    editorStorageWarning.value = editorStore.write(activeEditorTabId.value, editorTabs.value, legacyDraftsRestored)
  }
  const sql = computed({
    get: () => activeEditorTab.value?.sql ?? '',
    set: (text: string) => {
      const tab = activeEditorTab.value
      if (tab) { tab.sql = text; persistEditorTabs() }
      else { openEditorTab('', text) }
    }
  })
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
  let executionCancelled = false
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
  const countCancellations = new Map<string, Promise<void>>()
  function ownsRowCount(tab: ResultTab, task: RowCountTask) {
    return tabs.value.includes(tab) && tab.rowCountTask === task && !tab.invalidated &&
      tab.page === task.page && tab.result === task.result && tab.generation === task.generation &&
      tab.result?.cursorId === task.cursorId && tab.table?.id === task.tableId
  }
  async function countRows(tab: ResultTab) {
    if (!tab.table || tab.invalidated) throw new Error('当前对象不可统计，请重新打开结果')
    if (pendingEditors.has(tab.id)) throw new Error('请先保存或取消正在编辑的单元格/新增行')
    const task: RowCountTask = reactive({ signalId: crypto.randomUUID(), running: true, settled: false,
      cancelling: false, cancelRequested: false, value: null, message: '正在统计完整对象（不含筛选）', error: '',
      page: tab.page, result: tab.result, generation: tab.generation, cursorId: tab.result?.cursorId, tableId: tab.table.id })
    tab.rowCountTask = task
    tab.busy = true
    try {
      const value = await backend.countRows(task.tableId, { signalId: task.signalId })
      if (!ownsRowCount(tab, task)) return
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('统计值超出可精确显示的范围')
      task.value = value
      task.message = `完整对象共 ${value} 行（不含当前筛选）`
    } catch (cause) {
      if (ownsRowCount(tab, task)) {
        const cancelled = typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'cancelled'
        task.error = cancelled ? '' : `统计失败：${errorText(cause)}`
        task.message = cancelled ? '统计已取消' : ''
      }
    } finally {
      task.settled = true
      // Keep the connection occupied until an in-flight cancel returns; it must not reach the next query.
      await countCancellations.get(task.signalId)
      task.running = false
      tab.busy = false
      if (ownsRowCount(tab, task) && activeTab.value === tab) setStatus(task.error || task.message, !!task.error)
    }
  }
  async function cancelRowCount(tab: ResultTab) {
    const task = tab.rowCountTask
    if (!task?.running || task.settled || task.cancelling || task.cancelRequested) return
    if (!connections.value.find(connection => connection.id === tab.connectionId)?.capabilities?.supportsCancel) {
      task.message = '当前驱动不支持取消统计，请等待结果'
      return
    }
    task.cancelling = true
    const pending = (async () => {
      try {
        const cancelled = await backend.cancelQuery(connectionNode(tab.connectionId), task.signalId)
        if (!task.settled) {
          task.cancelRequested = cancelled
          task.message = cancelled ? '已请求取消，等待统计结束' : '未取消：统计尚未开始或已经结束，可重试'
        }
      } catch (cause) {
        if (!task.settled) task.message = `取消失败：${errorText(cause)}；可重试`
      } finally { task.cancelling = false }
    })()
    countCancellations.set(task.signalId, pending)
    try { await pending } finally { countCancellations.delete(task.signalId) }
  }
  const makeNode = (node: ObjectRef): TreeNode => ({ ref: node, children: [], expanded: false, loaded: false, loading: false, error: '' })
  async function refreshConnections() {
    const [list, nodes] = await Promise.all([backend.listConnections(), backend.listChildren(null)])
    connections.value = list
    for (const id of Object.keys(sessionContexts)) {
      if (!list.some(item => item.id === id && item.connected)) forgetSession(id)
    }
    roots.value = nodes.map(makeNode)
    metadataReady.value = true
    if (selected.value?.kind === 'connection') selected.value = nodes.find((node) => node.id === selected.value?.id) ?? null
    restoreLegacyEditorDrafts()
    if (!activeEditorTab.value && list.length) selectConnection(list[0]!.id)
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
  function restoreLegacyEditorDrafts() {
    if (legacyDraftsRestored || !connections.value.length) return
    legacyDraftsRestored = true
    for (const connection of connections.value) {
      const draft = editorStore.legacyDraft(connection.id)
      if (draft && !editorTabs.value.some((tab) => tab.connectionId === connection.id)) {
        editorTabs.value.push({ id: crypto.randomUUID(), connectionId: connection.id, sql: draft })
      }
    }
    if (!activeEditorTab.value && editorTabs.value.length) activateEditorTab(editorTabs.value[0]!.id)
    else if (editorTabs.value.length) persistEditorTabs()
  }
  function activateEditorTab(id: string) {
    if (!editorTabs.value.some((tab) => tab.id === id)) return
    activeEditorTabId.value = id
    persistEditorTabs()
  }
  function openEditorTab(connectionId = currentConnectionId.value, text = '') {
    restoreLegacyEditorDrafts()
    const id = crypto.randomUUID()
    editorTabs.value.push({ id, connectionId, sql: text })
    activateEditorTab(id)
    return id
  }
  async function closeEditorTab(id: string) {
    const tab = editorTabs.value.find((item) => item.id === id)
    if (!tab) return
    const draft = tab.sql
    if (draft && !(await confirmAction('关闭 SQL 标签', '关闭后将放弃此标签的 SQL 草稿。'))) return
    const index = editorTabs.value.indexOf(tab)
    if (index === -1 || tab.sql !== draft) return
    editorTabs.value.splice(index, 1)
    if (activeEditorTabId.value === id) {
      activeEditorTabId.value = editorTabs.value[Math.min(index, editorTabs.value.length - 1)]?.id ?? ''
    }
    persistEditorTabs()
  }
  function selectConnection(id: string) {
    restoreLegacyEditorDrafts()
    const active = activeEditorTab.value
    if (active?.connectionId === id) return
    if (active && !active.connectionId && id) {
      active.connectionId = id
      persistEditorTabs()
      return
    }
    const existing = editorTabs.value.find((tab) => tab.connectionId === id)
    if (existing) activateEditorTab(existing.id)
    else openEditorTab(id)
  }
  function activateTab(tab: ResultTab | string) {
    const target = typeof tab === 'string' ? tabs.value.find((candidate) => candidate.id === tab) : tab
    if (target) activeTabId.value = target.id
  }
  function selectNode(node: ObjectRef) { selected.value = node }
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
  function newTab(connectionId: string, title: string, sqlText: string, table: ObjectRef | null = null, description: TableDescription | null = null, editorTabId?: string): ResultTab {
    const tab: ResultTab = reactive({
      id: crypto.randomUUID(), connectionId, editorTabId, title, table, description, sql: sqlText, querySql: sqlText,
      executionContext: connectionTarget(connectionId),
      parameters: [], result: null, page: null, message: '', busy: false, invalidated: false,
      dirty: new Map(), selectedRows: new Set(), filter: '', appliedFilter: '', pageSize: PAGE_SIZE, order: [], generation: 0
    })
    tabs.value.push(tab)
    if (!editorTabId || activeEditorTabId.value === editorTabId) activateTab(tab)
    return tab
  }
  async function setResult(tab: ResultTab, result: QueryResult) {
    const previous = tab.result?.cursorId
    tab.result = result; tab.page = result; tab.selectedRows.clear()
    if (previous && previous !== result.cursorId) await backend.closeCursor(previous)
  }
  async function openTable(node: ObjectRef) {
    selectNode(node)
    await refreshSessionContext(connectionOf(node.id))
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
  function parameterSlots(script: string, connectionId = currentConnectionId.value) {
    if (!connectionId) return []
    return statementParameterSlots(script, dialectFor(connectionId)?.scriptRules ?? SQLITE_SCRIPT_RULES, parameterDialect(connectionId))
  }
  function captureEditorExecution(script: string, source?: SqlSourceRange): EditorExecution {
    const tab = activeEditorTab.value
    if (!tab || !currentConnection.value?.connected) throw new Error('请先选择一个已连接的数据源')
    if (source && (source.document !== tab.sql || !Number.isInteger(source.from) || !Number.isInteger(source.to) ||
      source.from < 0 || source.to < source.from || source.to > source.document.length || source.document.slice(source.from, source.to) !== script)) {
      throw new Error('SQL 草稿或选区已变化，请重新发起执行')
    }
    const origin = source ? { ...source } : script === tab.sql ? { document: tab.sql, from: 0, to: script.length } : undefined
    return { editorTabId: tab.id, connectionId: tab.connectionId, connectionRevision: connectionRevisions.get(tab.connectionId) ?? 0,
      sessionVersion: sessionVersions.get(tab.connectionId) ?? 0, target: connectionTarget(tab.connectionId), sql: script, source: origin }
  }
  async function executeEditorRequest(request: EditorExecution, parameters: ScopedSqlParameter[] = []) {
    const tab = editorTabs.value.find((item) => item.id === request.editorTabId)
    if (!tab || tab.connectionId !== request.connectionId || (connectionRevisions.get(request.connectionId) ?? 0) !== request.connectionRevision) {
      throw new Error('原 SQL 标签已关闭或连接已变化，请重新发起执行')
    }
    if (request.sessionVersion !== undefined && request.sessionVersion !== (sessionVersions.get(request.connectionId) ?? 0)) {
      throw new Error('同连接已执行其他 SQL，会话可能已变化，请重新发起执行')
    }
    return executeTarget(request, parameters)
  }
  async function recordHistory(input: RecordSqlHistoryInput) {
    try { await backend.recordSqlHistory(input) }
    catch (cause) { return `历史记录保存失败：${errorText(cause)}` }
    return ''
  }
  async function executeScript(script = sql.value, parameters: ScopedSqlParameter[] = []) {
    return executeEditorRequest(captureEditorExecution(script), parameters)
  }
  async function executeTarget(request: EditorExecution, parameters: ScopedSqlParameter[]) {
    const connection = connections.value.find((item) => item.id === request.connectionId)
    if (!connection?.connected) throw new Error('原 SQL 标签的连接未连接，请重新连接后执行')
    if (executing.value || locks.has(connection.id)) throw new Error('当前连接正在处理操作，请稍候')
    const statements = splitStatements(request.sql, dialectFor(connection.id)?.scriptRules ?? SQLITE_SCRIPT_RULES)
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
    executionCancelled = false
    executionConnectionId.value = connection.id
    activeSignal.value = crypto.randomUUID()
    let historyWarning = ''
    try {
      await refreshSessionContext(connection.id, activeSignal.value)
      if (executionCancelled) throw new Error('已取消执行，未发送后续 SQL')
      if (request.target?.session.status === 'ready' && !sameSession(request.target.session, connectionTarget(connection.id).session)) {
        throw new Error('会话库已变化或无法确认，请核对执行目标后重新执行')
      }
      sessionVersions.set(connection.id, (sessionVersions.get(connection.id) ?? 0) + 1)
      for (const statement of statements) {
        if (executionCancelled) throw new Error('已取消执行，未发送后续 SQL')
        if (statement.index > 0 && contextQuery(connection.dialectId) && connectionTarget(connection.id).session.status !== 'ready') {
          throw new Error('前序语句已执行，但会话目标无法确认；后续 SQL 未发送，请核对后重新执行')
        }
        const supplied = scopedParametersForStatement(parameters, statement.index)
        const tab = newTab(connection.id, `SQL ${statement.index + 1}`, statement.sql, null, null, request.editorTabId)
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
          tab.executionFailed = true
          const source = request.source ? {
            document: request.source.document,
            from: request.source.from + statement.startOffset,
            to: request.source.from + statement.endOffset,
          } : undefined
          const startLine = source ? source.document.slice(0, source.from).split('\n').length : statement.startLine
          const endLine = source ? source.document.slice(0, Math.max(source.from, source.to - 1)).split('\n').length : statement.endLine
          tab.failure = { message: errorText(cause), sql: statement.sql, statementIndex: statement.index,
            startLine, endLine, phase: executed ? 'after-execution' : 'execution', source }
          const location = source ? `编辑器第 ${startLine} 行` : `执行片段第 ${startLine} 行`
          tab.message = `${connection.name} · ${location}：${executed ? '语句已执行，后续处理失败；请先核对结果。' : ''}${errorText(cause)}`
          throw new Error(tab.message)
        }
        finally { await refreshSessionContext(connection.id, activeSignal.value); tab.busy = false }
      }
      setStatus(`已执行 ${statements.length} 条语句${historyWarning ? ` · ${historyWarning}` : ''}`, Boolean(historyWarning))
    } finally { executing.value = false; activeSignal.value = ''; executionConnectionId.value = '' }
  }
  async function cancelExecution() {
    const id = executionConnectionId.value
    const signal = activeSignal.value
    if (!executing.value || !id || !signal) throw new Error('当前没有正在执行的查询')
    if (!executionConnection.value?.capabilities?.supportsCancel) throw new Error('当前执行查询的驱动不支持取消')
    executionCancelled = true
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
    stageCells(tab, [{ row, changes: { [column]: value } }])
  }
  function stageCells(tab: ResultTab, edits: readonly { row: ResultRow; changes: RowUpdate['changes'] }[]) {
    if (!canEdit(tab)) throw new Error('当前结果不可编辑')
    const pending = new Map<number, RowUpdate>()
    for (const { row, changes: values } of edits) {
      const keyValues = rowKeys(tab, row)
      const original = pending.get(row.index) ?? tab.dirty.get(row.index)
      const changes = new Map(Object.entries(original?.changes ?? {}))
      for (const [column, value] of Object.entries(values)) {
        const index = tab.page!.columns.findIndex((candidate) => candidate.name === column)
        if (index < 0) throw new Error('目标列已变化，请重新编辑')
        if (JSON.stringify(row.cells[index]) === JSON.stringify(value)) changes.delete(column)
        else changes.set(column, value)
      }
      pending.set(row.index, { keyValues, changes: Object.fromEntries(changes) })
    }
    for (const [index, update] of pending) {
      if (Object.keys(update.changes).length) tab.dirty.set(index, update)
      else tab.dirty.delete(index)
    }
  }
  async function reloadTab(tab: ResultTab, guard = true, offset = 0, transform?: Pick<ResultTab, 'querySql' | 'order' | 'appliedFilter'>) {
    if (tab.invalidated) throw new Error('连接已关闭或更新，请重新打开结果')
    if (guard && pendingEditors.has(tab.id)) throw new Error('请先保存或取消正在编辑的单元格/新增行')
    if (guard && !(await guardLocal(tab, '刷新结果'))) return
    tab.busy = true
    const generation = ++tab.generation
    try {
      await refreshSessionContext(tab.connectionId)
      const executionContext = connectionTarget(tab.connectionId)
      const result = await backend.runQuery(connectionNode(tab.connectionId), transform?.querySql ?? tab.querySql, { limit: tab.pageSize ?? PAGE_SIZE, offset, keepCursor: true, parameters: tab.parameters })
      if (generation !== tab.generation || tab.invalidated || !tabs.value.includes(tab)) { if (result.cursorId) await backend.closeCursor(result.cursorId); return }
      if (transform) { tab.querySql = transform.querySql; tab.order = transform.order; tab.appliedFilter = transform.appliedFilter }
      tab.executionContext = executionContext
      tab.contextStale = !tab.table && Boolean(contextQuery(executionContext.dialectId)) && executionContext.session.status !== 'ready'
      await setResult(tab, result)
    } finally { tab.busy = false }
  }
  async function fetchTabPage(tab: ResultTab, offset: number, size: number) {
    if (tab.contextStale) throw new Error('会话目标已变化或未确认，请先刷新结果再翻页')
    const result = tab.result, page = tab.page, cursor = result?.cursorId, generation = tab.generation
    const previousSize = tab.pageSize ?? PAGE_SIZE
    if (!cursor || !page || tab.invalidated || !tabs.value.includes(tab)) return
    tab.busy = true
    try {
      const fetched = await backend.fetchResultPage(cursor, offset, size)
      if (tab.invalidated || !tabs.value.includes(tab) || tab.result !== result || tab.page !== page ||
          tab.result?.cursorId !== cursor || tab.generation !== generation || (tab.pageSize ?? PAGE_SIZE) !== previousSize) return
      tab.page = fetched
      tab.pageSize = size
      tab.selectedRows.clear()
    } finally { tab.busy = false }
  }
  async function pageTab(tab: ResultTab, direction: number) {
    if (pendingEditors.has(tab.id)) throw new Error('请先保存或取消正在编辑的单元格/新增行')
    if (!tab.result?.cursorId || !tab.page || tab.busy || tab.invalidated) return
    if (direction !== -1 && direction !== 1) throw new Error('无效的翻页方向')
    if ((direction < 0 && tab.page.offset === 0) || (direction > 0 && !tab.page.hasMore)) return
    const size = tab.pageSize ?? PAGE_SIZE
    const targetOffset = Math.max(0, tab.page.offset + direction * size)
    if (!(await guardLocal(tab, '翻页'))) return
    await fetchTabPage(tab, targetOffset, size)
  }
  async function changePageSize(tab: ResultTab, size: number) {
    if (!RESULT_PAGE_SIZES.some(candidate => candidate === size)) throw new Error('每页行数只支持 100、200、500 或 1,000')
    if (pendingEditors.has(tab.id)) throw new Error('请先保存或取消正在编辑的单元格/新增行')
    if (!tab.result?.cursorId || !tab.page || tab.busy || tab.invalidated || size === (tab.pageSize ?? PAGE_SIZE)) return
    if (!(await guardLocal(tab, '更改每页行数'))) return
    await fetchTabPage(tab, 0, size)
  }
  async function transformTab(tab: ResultTab, order = tab.order) {
    if (tab.contextStale) throw new Error('会话目标已变化或未确认，请先刷新结果再排序或筛选')
    if (pendingEditors.has(tab.id)) throw new Error('请先保存或取消正在编辑的单元格/新增行')
    if (tab.invalidated) throw new Error('连接已关闭或更新，请重新打开结果')
    const appliedFilter = tab.filter
    const quoteColumn = (name: string) => quote(name, tab.connectionId)
    const filter = parseFilter(appliedFilter, quoteColumn)
    if (!filter.ok) throw new Error(filter.error)
    const base = tab.sql.trim().replace(/;\s*$/, '')
    let querySql = order.length || filter.conditions.length
      ? buildFilteredSql({ sourceKind: 'sql', sql: base }, filter.conditions, quoteColumn)
      : base
    if (order.length) {
      const keys = order.map(({ column, direction }) => `${quoteColumn(column)} ${direction}`)
      querySql += ` ORDER BY ${keys.join(', ')}`
    }
    if (!(await guardLocal(tab, '排序或筛选'))) return
    await reloadTab(tab, false, 0, { querySql, order, appliedFilter })
  }
  function assertNoPendingEditors(id: string) {
    if (tabs.value.some((tab) => tab.connectionId === id && pendingEditors.has(tab.id))) {
      throw new Error('请先保存或取消正在编辑的单元格/新增行')
    }
  }
  async function reviewMysqlChanges(id: string, targets: ResultTab[], commit: boolean, inserting = false) {
    const connection = connections.value.find((item) => item.id === id)
    const revision = connectionRevisions.get(id) ?? 0
    const reviews = targets.map((tab) => ({
      tab, tableId: tab.table?.id, page: tab.page, result: tab.result, generation: tab.generation,
      snapshot: JSON.stringify([...tab.dirty]),
      updates: JSON.parse(JSON.stringify([...tab.dirty.values()])) as RowUpdate[],
      plan: null as Awaited<ReturnType<typeof backend.previewRowUpdates>> | null
    }))
    function assertCurrent(remaining = reviews) {
      const current = connections.value.find((item) => item.id === id)
      if (!current?.connected || current.dialectId !== 'mysql' || (connectionRevisions.get(id) ?? 0) !== revision) {
        throw new Error('连接已变化，请重新预览')
      }
      if (commit) assertNoPendingEditors(id)
      if (remaining.some(({ tab, tableId, page, result, generation, snapshot }) =>
        !tabs.value.includes(tab) || tab.connectionId !== id || !tableId || tab.table?.id !== tableId ||
        tab.invalidated || tab.busy || tab.page !== page || tab.result !== result || tab.generation !== generation ||
        (!inserting && pendingEditors.has(tab.id)) || JSON.stringify([...tab.dirty]) !== snapshot)) {
        throw new Error('结果或草稿已变化，请重新预览')
      }
      if (commit) {
        const dirtyTabs = tabs.value.filter((tab) => tab.connectionId === id && tab.dirty.size)
        if (dirtyTabs.length !== remaining.length || dirtyTabs.some((tab) => !remaining.some((item) => item.tab === tab))) {
          throw new Error('待提交的标签或草稿已变化，请重新预览')
        }
      }
    }
    assertCurrent()
    const state = await readTransaction(id)
    assertCurrent()
    for (const review of reviews) {
      review.plan = await backend.previewRowUpdates(review.tableId!, review.updates)
      assertCurrent()
    }
    const existing = state.active ? `已有事务：${state.pendingAffected} 行未提交。` : '已有事务：无。'
    const detail = reviews.map(({ tab, updates, plan }) =>
      `表「${tab.table!.name}」（标签「${tab.title}」）：${updates.length} 行草稿\n` +
      plan!.statements.map(({ sql, parameters }) => `${sql}\n参数（按占位符顺序） ${JSON.stringify(parameters)}`).join('\n\n')
    ).join('\n\n') || '没有新增 UPDATE 草稿。'
    const action = commit ? 'commit' : 'apply'
    const choice = await askDecision(commit ? '提交当前连接' : '更新 SQL 预览',
      `连接「${connection!.name}」。${existing}本次新增草稿：${reviews.length} 个标签、${reviews.reduce((sum, item) => sum + item.updates.length, 0)} 行。` +
      (commit ? '确认后应用以上草稿，并提交此连接全部未提交修改（包括此前的插入、删除或 SQL 写入）。' : '应用后仍需提交事务。'),
      [{ value: action, label: commit ? (reviews.length ? '应用并提交' : '提交事务') : '应用修改' }, { value: 'cancel', label: '取消' }], detail)
    if (choice !== action) return false
    assertCurrent()
    const confirmedState = await readTransaction(id)
    assertCurrent()
    if (confirmedState.active !== state.active || confirmedState.pendingAffected !== state.pendingAffected) {
      throw new Error('事务状态已变化，请重新预览')
    }
    for (let index = 0; index < reviews.length; index++) {
      assertCurrent(reviews.slice(index))
      const review = reviews[index]!
      try {
        await applyTab(review.tab, { updates: review.updates, fingerprint: review.plan!.fingerprint }, !commit)
      } catch (cause) {
        if (!commit) throw cause
        if (cause instanceof Error && 'transactionRolledBack' in cause && cause.transactionRolledBack === true) {
          // Aggregate applies keep their original pages until settlement, so draft row indices still match.
          for (const item of reviews.slice(0, index)) {
            if (tabs.value.includes(item.tab) && !item.tab.invalidated && item.tab.connectionId === id &&
                item.tab.table?.id === item.tableId && item.tab.generation === item.generation && item.tab.page === item.page && !item.tab.dirty.size) {
              for (const [row, update] of JSON.parse(item.snapshot) as [number, RowUpdate][]) item.tab.dirty.set(row, update)
              item.tab.message = '事务已回滚，本轮草稿已恢复；请处理草稿后刷新结果'
            }
          }
          throw new Error(`未执行提交；整个事务已回滚，本轮仍有效标签的草稿已保留或恢复。请处理草稿后刷新结果。${errorText(cause)}`)
        }
        throw new Error(`未执行提交；应用过程中发生错误，请核对当前事务。尚未应用成功的草稿已保留。${errorText(cause)}`)
      }
    }
    if (commit) {
      assertCurrent([])
      try { transactions[id] = await backend.commitTransaction(connectionNode(id)) }
      catch (cause) { throw new Error(`提交失败或结果未知，请核对数据库状态后再操作。${errorText(cause)}`) }
    }
    return true
  }
  async function reviewAndApplyTab(tab: ResultTab, inserting = false) {
    if (!tab.table || !tab.dirty.size) return true
    if (tab.busy || tab.invalidated || (!inserting && pendingEditors.has(tab.id))) throw new Error('请先结束当前单元格编辑')
    const connection = connections.value.find((item) => item.id === tab.connectionId)
    if (connection?.dialectId === 'mysql') return reviewMysqlChanges(tab.connectionId, [tab], false, inserting)
    await applyTab(tab)
    return true
  }
  async function reviewAndCommit(id: string) {
    assertNoPendingEditors(id)
    const localTabs = tabs.value.filter((tab) => tab.connectionId === id && tab.dirty.size)
    if (connections.value.some((item) => item.id === id && item.dialectId === 'mysql')) {
      return reviewMysqlChanges(id, localTabs, true)
    }
    for (const tab of localTabs) await applyTab(tab)
    transactions[id] = await backend.commitTransaction(connectionNode(id))
    return true
  }
  async function applyTab(tab: ResultTab, reviewed?: { updates: RowUpdate[]; fingerprint: string }, refresh = true) {
    if (!tab.table || !tab.dirty.size) return
    if (tab.busy || tab.invalidated) throw new Error('当前结果不可应用修改')
    tab.busy = true
    try {
      const offset = tab.page?.offset ?? 0
      const updates = reviewed?.updates ?? [...tab.dirty.values()]
      const wasActive = transactions[tab.connectionId]?.active === true
      const request = reviewed
        ? backend.applyEdits(tab.table.id, updates, reviewed.fingerprint)
        : backend.applyEdits(tab.table.id, updates)
      const result = await request.catch(async (cause: unknown) => {
        if (reviewed && cause !== null && typeof cause === 'object' &&
            'code' in cause && cause.code === 'conflict') {
          throw new Error('更新计划已变化，请重新预览')
        }
        let state: TransactionState | null = null
        try { state = await readTransaction(tab.connectionId) } catch { /* Preserve the original apply error when state cannot be confirmed. */ }
        const mysqlDeadlock = cause !== null && typeof cause === 'object' &&
          'code' in cause && cause.code === 'driver-error' &&
          'message' in cause && cause.message === 'MySQL操作失败(SQLSTATE 40001, code 1213)' &&
          connections.value.some((connection) => connection.id === tab.connectionId && connection.dialectId === 'mysql')
        if (wasActive && state?.active === false && state.pendingAffected === 0 && mysqlDeadlock) {
          throw Object.assign(new Error('MySQL操作失败(SQLSTATE 40001, code 1213)；整个事务已回滚；本地草稿已保留。请处理草稿后刷新结果'), { code: 'driver-error', transactionRolledBack: true })
        }
        throw cause
      })
      await readTransaction(tab.connectionId)
      if (!result.ok) throw new Error(result.outcomes.filter((item) => item.error).map((item) => item.error).join('；') || '部分修改失败，请回滚当前连接事务')
      tab.dirty.clear()
      if (refresh) {
        try { await reloadTab(tab, false, offset) }
        catch (cause) { throw new Error(`已应用 ${result.affected} 行到当前事务，尚未提交；刷新结果失败，请核对事务后再继续。${errorText(cause)}`) }
      } else tab.message = `已应用 ${result.affected} 行，尚未提交；结果将在提交后刷新`
      setStatus(`已应用 ${result.affected} 行，尚未提交`)
    } finally { tab.busy = false }
  }
  async function guardLocal(tab: ResultTab, action: string, inserting = false) {
    if (!tab.dirty.size) return 'clean' as const
    const choice = await askDecision(action, `「${tab.title}」有 ${tab.dirty.size} 行尚未应用的修改。`, [
      { value: 'apply', label: '应用修改' }, { value: 'discard', label: '放弃本地修改', danger: true }, { value: 'cancel', label: '取消' }
    ])
    if (choice === 'cancel') return false
    if (choice === 'apply') return await reviewAndApplyTab(tab, inserting) ? 'applied' as const : false
    tab.dirty.clear()
    return 'discarded' as const
  }
  async function refreshConnectionTabs(id: string) {
    for (const tab of tabs.value.filter((t) => t.connectionId === id && t.result && !t.invalidated && !t.contextStale)) await reloadTab(tab, false)
  }
  async function settleTransaction(id: string, commit: boolean) {
    const localTabs = tabs.value.filter((tab) => tab.connectionId === id && tab.dirty.size)
    assertNoPendingEditors(id)
    if (commit) {
      if (!(await reviewAndCommit(id))) return false
    } else {
      const dirtyCount = localTabs.reduce((sum, tab) => sum + tab.dirty.size, 0)
      const state = await readTransaction(id)
      if ((dirtyCount || state.active) && !(await confirmAction('回滚当前连接', `将放弃当前连接所有标签中的本地修改及未提交事务。`))) return false
      transactions[id] = await backend.rollbackTransaction(connectionNode(id))
      for (const tab of localTabs) tab.dirty.clear()
    }
    try { await refreshConnectionTabs(id) }
    catch (cause) { throw new Error(`${commit ? '已提交' : '已回滚'}当前连接事务，但刷新结果失败。${errorText(cause)}`) }
    setStatus(commit ? '已提交当前连接事务' : '已回滚当前连接事务')
    return true
  }
  async function guardConnection(id: string, action: string) {
    assertNoPendingEditors(id)
    const connection = connections.value.find((c) => c.id === id)
    const state = connection?.connected ? await readTransaction(id) : { active: false, pendingAffected: 0 }
    const dirty = tabs.value.filter((tab) => tab.connectionId === id).reduce((sum, tab) => sum + tab.dirty.size, 0)
    if (!state.active && !dirty) return true
    const choice = await askDecision(action, `当前连接有 ${dirty} 行本地修改${state.active ? `，事务中有 ${state.pendingAffected} 行未提交` : ''}。该操作影响此连接的全部标签。`, [
      { value: 'commit', label: '应用并提交' }, { value: 'rollback', label: '放弃并回滚', danger: true }, { value: 'cancel', label: '取消' }
    ])
    if (choice === 'cancel') return false
    if (choice === 'commit') {
      if (!(await reviewAndCommit(id))) return false
    } else {
      if (state.active) transactions[id] = await backend.rollbackTransaction(connectionNode(id))
      for (const tab of tabs.value.filter((tab) => tab.connectionId === id)) tab.dirty.clear()
    }
    try { await refreshConnectionTabs(id) }
    catch (cause) { throw new Error(`${choice === 'commit' ? '已提交' : '已回滚'}当前连接事务，但刷新结果失败。${errorText(cause)}`) }
    return true
  }
  async function invalidateConnection(id: string) {
    connectionRevisions.set(id, (connectionRevisions.get(id) ?? 0) + 1)
    forgetSession(id)
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
    try {
      await backend.connectConnection(id)
      connectionRevisions.set(id, (connectionRevisions.get(id) ?? 0) + 1)
      forgetSession(id)
      await refreshConnections()
    } finally { locks.delete(id) }
  }
  async function disconnect(id: string) { await mutateConnection(id, '断开连接', () => backend.disconnectConnection(id)) }
  async function remove(id: string) {
    if (!(await confirmAction('删除连接', '确认删除此连接配置与保存的凭据？'))) return
    await mutateConnection(id, '删除连接', () => backend.removeConnection(id))
  }
  async function closeTab(tab: ResultTab) {
    if (tab.busy) return
    if (pendingEditors.has(tab.id)) throw new Error('请先保存或取消正在编辑的单元格/新增行')
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
    if (!(await guardLocal(tab, '插入行', true))) return false
    const result = await backend.insertRow(tab.table.id, values)
    try {
      await readTransaction(tab.connectionId); await reloadTab(tab, false)
    } catch (cause) {
      setStatus(`已插入 ${result.affected} 行，尚未提交；刷新失败：${errorText(cause)}`, true)
      return true
    }
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
  /**
   * 分区、索引、会话等 MySQL 管理操作。
   * 写操作走 changeSchema：它已经负责事务守卫、
   * 旧游标失效与元数据刷新，这里不重复实现一套。
   */
  async function partitionTable(connectionId: string, nodeId: string, spec: PartitionChangeSpec) {
    return changeSchema(connectionId, '分区变更', async () => {
      await backend.partitionTable(nodeId, spec)
    }, true)
  }

  async function indexTable(connectionId: string, nodeId: string, spec: IndexChangeSpec) {
    return changeSchema(connectionId, '索引变更', async () => {
      await backend.indexTable(nodeId, spec)
    }, true)
  }

  /** 读取 MySQL 会话列表（只读）。 */
  async function listSessions(connectionId: string) {
    return backend.listSessions(`connection:${connectionId}`)
  }

  /** 终止指定 MySQL 会话。 */
  async function killSession(connectionId: string, sessionId: number) {
    return changeSchema(connectionId, `终止会话 ${sessionId}`, async () => {
      await backend.killSession(`connection:${connectionId}`, sessionId)
    })
  }

  /** 新建数据库。 */
  async function createDatabase(connectionId: string, database: string) {
    return changeSchema(connectionId, `新建库 ${database}`, async () => {
      await backend.createDatabase(connectionId, database, true)
    }, true)
  }

  /** 读取对象源码（视图 / 例程 / 触发器）。 */
  async function objectSource(nodeId: string) {
    return backend.objectSource(nodeId)
  }

  /** 跨库搜索对象。 */
  async function searchObjects(connectionId: string, keyword: string) {
    return backend.searchObjects(connectionId, { keyword })
  }

  /** 读取字段血缘证据，并在渲染进程做分档分析。 */
  async function fieldLineage(connectionId: string, table: string, column: string, schema?: string) {
    return backend.lineageEvidence(connectionId, { table, column, ...(schema ? { schema } : {}) })
  }

  /** 新建账号。 */
  async function createUser(connectionId: string, user: string, host: string, password: string) {
    return changeSchema(connectionId, `新建账号 ${user}@${host}`, async () => {
      await backend.createUser(connectionId, user, host, password)
    })
  }

  /** 删除账号。 */
  async function dropUser(connectionId: string, user: string, host: string) {
    return changeSchema(connectionId, `删除账号 ${user}@${host}`, async () => {
      await backend.dropUser(connectionId, user, host)
    })
  }

  /** 授予权限。 */
  async function grantPrivilege(connectionId: string, user: string, host: string, privileges: string[], scope: Record<string, string>) {
    return changeSchema(connectionId, `授予权限 ${user}@${host}`, async () => {
      await backend.grantPrivilege(connectionId, user, host, privileges, scope, false)
    })
  }

  /** 回收权限。 */
  async function revokePrivilege(connectionId: string, user: string, host: string, privileges: string[], scope: Record<string, string>) {
    return changeSchema(connectionId, `回收权限 ${user}@${host}`, async () => {
      await backend.revokePrivilege(connectionId, user, host, privileges, scope)
    })
  }

  /** 读取 MySQL 事件与用户权限（只读）。 */
  async function listEvents(connectionId: string) {
    return backend.listEvents(`connection:${connectionId}`)
  }

  async function listUsers(connectionId: string) {
    return backend.listUsers(`connection:${connectionId}`)
  }
  async function guardAllConnections(action: string) {
    if (pendingEditors.size) { setStatus('请先保存或取消正在编辑的单元格/新增行，再退出工作台', true); return false }
    if (backgroundTasks.size) { setStatus('导入导出任务正在运行，请等待完成或先取消任务后退出', true); return false }
    if (executing.value || locks.size || tabs.value.some((tab) => tab.busy)) { setStatus('请等待当前操作完成后退出', true); return false }
    const ids = new Set([...connections.value.map((c) => c.id), ...tabs.value.map((t) => t.connectionId)])
    for (const id of ids) if (!(await withConnectionOperation(id, () => guardConnection(id, action)))) return false
    return true
  }
  return {
    connections, dialects, roots, selected, currentConnectionId, currentConnection, sql, tabs, activeTabId, activeTab, activeContext,
    sessionContexts, connectionTarget, refreshSessionContext: (id: string) => withConnectionOperation(id, () => refreshSessionContext(id)),
    transactions, locks, backgroundTasks, pendingEditors, status, statusError, booting, metadataReady, executing, executionConnectionId, executionConnection, migrationWarning,
    setStatus, attempt, boot, refreshConnections, selectConnection, activateTab, selectNode, toggleNode, placeholders, parameterSlots,
    editorTabs, activeEditorTabId, editorStorageWarning, openEditorTab, activateEditorTab, closeEditorTab,
    executeScript, captureEditorExecution, executeEditorRequest, cancelExecution, stageCell, stageCells, canEdit, rowKeys,
    countRows: (tab: ResultTab) => withConnectionOperation(tab.connectionId, () => countRows(tab)), cancelRowCount, ownsRowCount,
    openTable: (node: ObjectRef) => withConnectionOperation(connectionOf(node.id), () => openTable(node)),
    applyTab: (tab: ResultTab) => withConnectionOperation(tab.connectionId, () => reviewAndApplyTab(tab)),
    reviewAndApplyTab: (tab: ResultTab) => withConnectionOperation(tab.connectionId, () => reviewAndApplyTab(tab)),
    pageTab: (tab: ResultTab, direction: number) => withConnectionOperation(tab.connectionId, () => pageTab(tab, direction)),
    changePageSize: (tab: ResultTab, size: number) => withConnectionOperation(tab.connectionId, () => changePageSize(tab, size)),
    reloadTab: (tab: ResultTab, guard = true) => withConnectionOperation(tab.connectionId, () => reloadTab(tab, guard)),
    transformTab: (tab: ResultTab, order = tab.order) => withConnectionOperation(tab.connectionId, () => transformTab(tab, order)),
    settleTransaction: (id: string, commit: boolean) => withConnectionOperation(id, () => settleTransaction(id, commit)),
    saveConnection, connect, disconnect, remove,
    closeTab: (tab: ResultTab) => withConnectionOperation(tab.connectionId, () => closeTab(tab)),
    insertRow: (tab: ResultTab, values: Record<string, CellValue>) => withConnectionOperation(tab.connectionId, () => insertRow(tab, values)),
    deleteSelected: (tab: ResultTab) => withConnectionOperation(tab.connectionId, () => deleteSelected(tab)),
    guardConnection: (id: string, action: string) => withConnectionOperation(id, () => guardConnection(id, action)),
    guardAllConnections, readTransaction, changeSchema,
    partitionTable, indexTable, listSessions, killSession, listEvents, listUsers,
    searchObjects: (connectionId: string, keyword: string) => withConnectionOperation(connectionId, () => searchObjects(connectionId, keyword)),
    createDatabase: (connectionId: string, database: string) => createDatabase(connectionId, database),
    objectSource: (nodeId: string) => withConnectionOperation(connectionOf(nodeId), () => objectSource(nodeId)),
    fieldLineage: (connectionId: string, table: string, column: string, schema?: string) => withConnectionOperation(connectionId, () => fieldLineage(connectionId, table, column, schema)),
    createUser: (connectionId: string, user: string, host: string, password: string) => createUser(connectionId, user, host, password),
    dropUser: (connectionId: string, user: string, host: string) => dropUser(connectionId, user, host),
    grantPrivilege: (connectionId: string, user: string, host: string, privileges: string[], scope: Record<string, string>) => grantPrivilege(connectionId, user, host, privileges, scope),
    revokePrivilege: (connectionId: string, user: string, host: string, privileges: string[], scope: Record<string, string>) => revokePrivilege(connectionId, user, host, privileges, scope)
  }
}
export type Workbench = ReturnType<typeof useWorkbench>
