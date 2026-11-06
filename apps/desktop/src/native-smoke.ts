import { backend, smokeFixture } from './backend'
import { cellText, connectionNode, inputCell, type TreeNode, type Workbench } from './workbench'
import { runNativeToolSmoke, type NativeToolHost } from './native-tool-smoke'
import { decision } from './dialogs'

type SmokeResult = { ok: boolean; checks: Record<string, boolean> }
declare global { interface Window { __DBSTUDIO_NATIVE_SMOKE__?: () => Promise<SmokeResult> } }

/** This module is imported only by VITE_DBSTUDIO_TEST_HOOKS=1 builds. */
export function installNativeSmoke(wb: Workbench, tools: NativeToolHost) {
  if (import.meta.env.VITE_DBSTUDIO_TEST_HOOKS !== '1') return
  let pending: Promise<SmokeResult> | undefined
  window.__DBSTUDIO_NATIVE_SMOKE__ = () => pending ??= run()
  async function run(): Promise<SmokeResult> {
    const checks: Record<string, boolean> = {}
    let activeCheck = 'connection'
    try {
      const fixture = await smokeFixture()
      checks.isolated_fixture = fixture.isolated
      if (!fixture.isolated) return { ok: false, checks }
      const name = `Vue Native ${crypto.randomUUID().slice(0, 8)}`
      await wb.saveConnection({ dialectId: 'sqlite', name, options: { file: fixture.databasePath, native_unlisted_option: 'preserve-test-option' } }, {})
      const connection = wb.connections.value.find((c) => c.name === name)
      checks.connection = Boolean(connection?.connected)
      if (!connection?.connected) return { ok: false, checks }
      wb.selectConnection(connection.id)
      wb.sql.value = 'SELECT 11 AS draft_a;'
      const secondName = `Vue Draft ${crypto.randomUUID().slice(0, 8)}`
      await wb.saveConnection({ dialectId: 'sqlite', name: secondName, options: { file: fixture.databasePath } }, {})
      const second = wb.connections.value.find((item) => item.name === secondName)!
      wb.sql.value = 'SELECT 22 AS draft_b;'
      wb.selectConnection(connection.id)
      checks.ui_sql_draft_persisted = localStorage.getItem(`dbstudio.vue.sql-draft.v1.${connection.id}`) === 'SELECT 11 AS draft_a;'
        && localStorage.getItem(`dbstudio.vue.sql-draft.v1.${second.id}`) === 'SELECT 22 AS draft_b;'
      const actualExecution = wb.executeScript('SELECT 1 AS execution_owner;')
      wb.selectConnection(second.id)
      checks.ui_execution_owner_stays_with_query = wb.executionConnectionId.value === connection.id && wb.executionConnection.value?.id === connection.id
      await actualExecution
      checks.ui_execution_owner_cleared = wb.executionConnectionId.value === '' && !wb.executing.value
      await backend.removeConnection(second.id)
      await wb.refreshConnections()
      checks.ui_removed_connection_restores_draft = wb.currentConnectionId.value === connection.id && wb.sql.value === 'SELECT 11 AS draft_a;'
      const tableName = `native_vue_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
      const values = Array.from({ length: 205 }, (_, i) => `(${i + 1}, 'row-${i + 1}')`).join(',')
      await wb.executeScript(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO ${tableName} (id,value) VALUES ${values};`)
      await wb.settleTransaction(connection.id, true)
      checks.script_transaction = wb.transactions[connection.id]?.active === false

      activeCheck = 'script_transaction'
      const parameterTableName = `native_param_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
      const parameterSql = `UPDATE ${parameterTableName} SET value=? WHERE id=1; UPDATE ${parameterTableName} SET value=? WHERE id=2;`
      const parameterSlots = wb.parameterSlots(parameterSql)
      await wb.executeScript(`CREATE TABLE ${parameterTableName} (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO ${parameterTableName} (id,value) VALUES (1,'initial-1'),(2,'initial-2');`)
      await wb.settleTransaction(connection.id, true)
      await wb.executeScript(parameterSql, [
        { statementIndex: 0, name: '?1', value: 'first-statement' },
        { statementIndex: 1, name: '?1', value: 'second-statement' }
      ])
      await wb.settleTransaction(connection.id, true)
      const parameterRows = await backend.runQuery(connectionNode(connection.id), `SELECT value FROM ${parameterTableName} ORDER BY id`, { keepCursor: false })
      const committedParameterValues = JSON.stringify(parameterRows.rows.map((row) => row.cells.map(cellText))) === JSON.stringify([['first-statement'], ['second-statement']])
      await wb.executeScript(parameterSql, [
        { statementIndex: 0, name: '?1', value: 'rollback-first' },
        { statementIndex: 1, name: '?1', value: 'rollback-second' }
      ])
      await backend.rollbackTransaction(connectionNode(connection.id))
      await wb.readTransaction(connection.id)
      const rolledBackParameterRows = await backend.runQuery(connectionNode(connection.id), `SELECT value FROM ${parameterTableName} ORDER BY id`, { keepCursor: false })
      const rolledBackParameterValues = JSON.stringify(rolledBackParameterRows.rows.map((row) => row.cells.map(cellText))) === JSON.stringify([['first-statement'], ['second-statement']])
      checks.script_transaction = checks.script_transaction && parameterSlots.length === 2 && parameterSlots[0]?.key === '0:?1' && parameterSlots[1]?.key === '1:?1' && committedParameterValues && rolledBackParameterValues

      activeCheck = 'failed_bigint_table'
      const bigTableName = `native_big_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
      await wb.executeScript(`CREATE TABLE ${bigTableName} (id INTEGER PRIMARY KEY, value BIGINT NOT NULL);`)
      activeCheck = 'failed_bigint_commit_ddl'
      const bigDdlAutoCommitted = !(await wb.readTransaction(connection.id)).active
      activeCheck = 'failed_bigint_parse'
      const exactBigInteger = inputCell('9007199254740993', 'number')
      activeCheck = 'failed_bigint_insert'
      await backend.insertRow(`${connectionNode(connection.id)}|table:${bigTableName}`, {
        id: inputCell('1', 'number'),
        value: exactBigInteger
      })
      activeCheck = 'failed_bigint_commit'
      await wb.settleTransaction(connection.id, true)
      activeCheck = 'failed_bigint_read'
      const bigResult = await backend.runQuery(connectionNode(connection.id), `SELECT value FROM ${bigTableName} WHERE id=1`, { keepCursor: false })
      const bigCell = bigResult.rows[0]?.cells[0]
      const exactBigIntegerStored = bigDdlAutoCommitted && exactBigInteger.kind === 'text' && exactBigInteger.text === '9007199254740993' && bigCell?.kind === 'text' && bigCell.text === '9007199254740993'

      activeCheck = 'paging'
      const pageTableName = `native_page_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
      const pageValues = Array.from({ length: 805 }, (_, index) => `(${index + 1}, 'page-${index + 1}')`).join(',')
      await wb.executeScript(`CREATE TABLE ${pageTableName} (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO ${pageTableName} (id,value) VALUES ${pageValues};`)
      await wb.settleTransaction(connection.id, true)
      await wb.refreshConnections()
      let budget = 24
      async function findTable(nodes: TreeNode[], name = tableName, depth = 0): Promise<TreeNode | undefined> {
        for (const node of nodes) {
          if (node.ref.kind === 'table' && node.ref.name === name) return node
          if (node.ref.hasChildren && depth < 5 && budget-- > 0) {
            if (!node.loaded) await wb.toggleNode(node)
            const found = await findTable(node.children, name, depth + 1)
            if (found) return found
          }
        }
      }
      const root = wb.roots.value.find((node) => node.ref.id === connectionNode(connection.id))
      const table = root ? await findTable([root]) : undefined
      checks.lazy_metadata = Boolean(table)
      if (!table) return { ok: false, checks }
      await wb.openTable(table.ref)
      const tab = wb.activeTab.value!
      checks.table_result = tab.page?.rows.length === 200 && Boolean(tab.result?.cursorId)
      await wb.pageTab(tab, 1)
      checks.paging = tab.page?.offset === 200 && tab.page?.rows.length === 5
      await wb.pageTab(tab, -1)
      const pageTableRef = { ...table.ref, id: `${connectionNode(connection.id)}|table:${pageTableName}`, name: pageTableName }
      await wb.openTable(pageTableRef)
      const dirtyPageTab = wb.activeTab.value!
      await wb.pageTab(dirtyPageTab, 1)
      await wb.pageTab(dirtyPageTab, 1)
      const thirdPageOffset = dirtyPageTab.page?.offset
      wb.stageCell(dirtyPageTab, dirtyPageTab.page!.rows[0]!, 'value', { kind: 'text', text: 'third-page-dirty' })
      const nextPage = wb.pageTab(dirtyPageTab, 1)
      await selectDecision('apply')
      await nextPage
      const fourthPageAfterDirtyApply = thirdPageOffset === 400 && dirtyPageTab.page?.offset === 600 && dirtyPageTab.page.rows[0]?.cells[0]?.kind === 'number' && dirtyPageTab.page.rows[0].cells[0].value === 601
      await backend.rollbackTransaction(connectionNode(connection.id))
      await wb.readTransaction(connection.id)
      checks.paging = checks.paging && fourthPageAfterDirtyApply
      wb.activateTab(tab)

      activeCheck = 'vue_active_context'
      const tabConnectionName = `Vue Tabs ${crypto.randomUUID().slice(0, 8)}`
      await wb.saveConnection({ dialectId: 'sqlite', name: tabConnectionName, options: { file: fixture.databasePath } }, {})
      const tabConnection = wb.connections.value.find((item) => item.name === tabConnectionName)!
      wb.selectConnection(tabConnection.id)
      wb.sql.value = 'SELECT 444 AS draft_tab_connection;'
      const tabTableRef = { ...table.ref, id: `${connectionNode(tabConnection.id)}|table:${tableName}`, name: tableName }
      await wb.openTable(tabTableRef)
      const otherConnectionTab = wb.activeTab.value!
      wb.selectConnection(connection.id)
      wb.sql.value = 'SELECT 333 AS draft_primary_connection;'
      await wb.openTable(table.ref)
      const primaryTab = wb.activeTab.value!
      wb.activateTab(otherConnectionTab)
      const tabDraftRestored = wb.currentConnectionId.value === tabConnection.id && wb.sql.value === 'SELECT 444 AS draft_tab_connection;'
      await wb.closeTab(otherConnectionTab)
      const closeActivatedTargetContext = wb.activeTabId.value === primaryTab.id && wb.currentConnectionId.value === connection.id && wb.sql.value === 'SELECT 333 AS draft_primary_connection;'
      const asyncOpen = wb.openTable(tabTableRef)
      wb.selectConnection(connection.id)
      wb.sql.value = 'SELECT 555 AS async_primary_draft;'
      await asyncOpen
      const asyncOpenKeptResultContext = wb.currentConnectionId.value === tabConnection.id && wb.activeTab.value?.connectionId === tabConnection.id && wb.activeTab.value?.table?.id === tabTableRef.id
      const asyncTab = wb.activeTab.value!
      await wb.closeTab(asyncTab)
      wb.activateTab(tab)
      const row = tab.page!.rows[0]!
      const column = tab.page!.columns.find((c) => c.name === 'value')!
      wb.stageCell(tab, row, column.name, { kind: 'text', text: 'vue-native-edited' })
      checks.local_dirty = tab.dirty.size === 1
      await wb.applyTab(tab)
      checks.native_apply = tab.dirty.size === 0 && wb.transactions[connection.id]?.active === true
      await wb.settleTransaction(connection.id, true)
      checks.committed_value = tab.page!.rows.some((r) => r.cells.some((c) => cellText(c) === 'vue-native-edited')) && exactBigIntegerStored
      const keys = wb.rowKeys(tab, tab.page!.rows[0]!)
      const deleted = await backend.deleteRows(table.ref.id, [keys])
      checks.native_delete = deleted.ok && deleted.affected === 1
      await backend.rollbackTransaction(connectionNode(connection.id))
      await wb.readTransaction(connection.id)
      await wb.reloadTab(tab)
      checks.rollback_restores = tab.page!.rows.some((r) => r.cells.some((c) => cellText(c) === 'vue-native-edited'))
      checks.vue_active_context = wb.activeContext.value?.tableNodeId === table.ref.id && wb.activeContext.value?.connectionId === connection.id && tabDraftRestored && closeActivatedTargetContext && asyncOpenKeptResultContext
      await wb.openTable(table.ref)
      const otherTab = wb.activeTab.value!
      wb.stageCell(tab, tab.page!.rows[0]!, 'value', { kind: 'text', text: 'guard-first' })
      wb.stageCell(otherTab, otherTab.page!.rows[0]!, 'value', { kind: 'text', text: 'guard-second' })
      async function guardedExit(choice: string) {
        const pending = wb.guardAllConnections('原生 smoke 关闭保护')
        const deadline = Date.now() + 10000
        while (!decision.value) {
          if (Date.now() >= deadline) throw new Error('Guard dialog unavailable')
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        decision.value.settle(choice)
        return pending
      }
      checks.guard_cancel_preserves_tabs = !(await guardedExit('cancel')) && tab.dirty.size === 1 && otherTab.dirty.size === 1
      await wb.applyTab(tab)
      checks.guard_cross_tab_dirty = otherTab.dirty.size === 1 && wb.transactions[connection.id]?.active === true
      checks.guard_rollback = await guardedExit('rollback') && tab.dirty.size === 0 && otherTab.dirty.size === 0 && wb.transactions[connection.id]?.active === false && tab.page!.rows[0]!.cells.some((cell) => cellText(cell) === 'vue-native-edited') && otherTab.page!.rows[0]!.cells.some((cell) => cellText(cell) === 'vue-native-edited')
      wb.stageCell(otherTab, otherTab.page!.rows[0]!, 'value', { kind: 'text', text: 'guard-committed' })
      checks.guard_apply_commit = await guardedExit('commit') && otherTab.dirty.size === 0 && wb.transactions[connection.id]?.active === false && tab.page!.rows[0]!.cells.some((cell) => cellText(cell) === 'guard-committed')
      const originalRow = tab.page!.rows[0]!
      wb.stageCell(tab, originalRow, 'id', { kind: 'number', value: 7001 })
      tab.selectedRows.clear(); tab.selectedRows.add(originalRow.index)
      const deletion = wb.deleteSelected(tab)
      async function selectDecision(choice: string) {
        const deadline = Date.now() + 10000
        while (!decision.value) {
          if (Date.now() >= deadline) throw new Error('Selection dialog unavailable')
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        decision.value.settle(choice)
      }
      await selectDecision('confirm'); await selectDecision('apply'); await deletion
      checks.ui_pk_edit_delete_tracks_new_key = await backend.countRows(table.ref.id) === 204
      await backend.rollbackTransaction(connectionNode(connection.id)); await wb.readTransaction(connection.id); await wb.reloadTab(tab)
      checks.ui_pk_delete_rollback_restores = await backend.countRows(table.ref.id) === 205 && tab.page!.rows[0]!.cells.some((cell) => cell.kind === 'number' && cell.value === 1)
      const comparisonName = `${tableName}_target`
      await wb.executeScript(`CREATE TABLE ${tableName}_child (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES ${tableName}(id)); CREATE TABLE ${comparisonName} (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO ${comparisonName} SELECT id,value FROM ${tableName}; UPDATE ${comparisonName} SET value='native-target' WHERE id=1;`)
      await wb.settleTransaction(connection.id, true)
      budget = 24
      const comparisonRoot = wb.roots.value.find((node) => node.ref.id === connectionNode(connection.id))
      const comparison = comparisonRoot ? await findTable([comparisonRoot], comparisonName) : undefined
      checks.comparison_fixture = Boolean(comparison)
      if (comparison) Object.assign(checks, await runNativeToolSmoke(wb, tools, fixture, tab, comparison.ref))
      const editor = await tools.connection(wb.connections.value.find((item) => item.id === connection.id)!)
      await editor.submit()
      checks.ui_connection_edit_preserves_unlisted_options = !editor.error && (await backend.listConnections()).find((item) => item.id === connection.id)?.options.native_unlisted_option === 'preserve-test-option'
      await tools.close()
      return { ok: Object.values(checks).every(Boolean), checks }
    } catch {
      checks[activeCheck] = false
      return { ok: false, checks }
    }
  }
}
