import type { ObjectRef } from '../../../src/core/model'
import { backend, type SmokeFixture } from './backend'
import type { NativeToolHost } from './native-tool-smoke'
import { cellText, connectionNode, type Workbench } from './workbench'

const database = 'dbstudio_acceptance'
const options = { host: '127.0.0.1', port: 13306, database, user: 'acceptance', sslmode: 'disable' }

async function waitFor(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000
  do {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < end)
  throw new Error('The acceptance condition did not become ready')
}

export async function runWindowsMysqlSmoke(wb: Workbench, tools: NativeToolHost, fixture: SmokeFixture) {
  const checks: Record<string, boolean> = { isolated_fixture: fixture.isolated }
  let check = 'mysql_connection'
  try {
    const name = 'Windows acceptance'
    await wb.saveConnection({ dialectId: 'mysql', name, options }, {})
    const connection = wb.connections.value.find((item) => item.name === name)
    if (!connection?.connected) return { ok: false, checks: { ...checks, [check]: false } }
    const id = connection.id
    const node = connectionNode(id)
    checks[check] = true
    const observer = await backend.addConnection({ dialectId: 'mysql', name: 'Acceptance observer', options }, {})
    if (!observer.connected) throw new Error('Observer did not connect')

    check = 'mysql_alias_completion'
    const table: ObjectRef = { id: `${node}|table:${database}.items`, name: 'items', kind: 'table', parentId: node, hasChildren: true }
    await wb.openTable(table)
    const tab = wb.activeTab.value!
    const editor = await tools.sqlEditor()
    wb.sql.value = `SELECT i. FROM ${database}.items AS i`
    editor.setSelection('SELECT i.'.length)
    checks[check] = editor.candidates.includes('payload') && editor.candidates.includes('generated_value')

    check = 'mysql_multi_sort_pages'
    const grid = await tools.grid(tab)
    const header = (column: string): HTMLButtonElement => {
      const buttons: NodeListOf<HTMLButtonElement> = grid.$el.querySelectorAll('.column-sort')
      const index = tab.page?.columns.findIndex((item) => item.name === column) ?? -1
      const button = buttons[index]
      if (!button) throw new Error('Grid column header is unavailable')
      return button
    }
    header('group_id').click()
    await waitFor(() => tab.order.length === 1 && !tab.busy && !wb.locks.has(id))
    header('id').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    await waitFor(() => tab.order.length === 2 && !tab.busy && !wb.locks.has(id))
    header('id').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    await waitFor(() => tab.order[1]?.direction === 'DESC' && !tab.busy && !wb.locks.has(id))
    const first = tab.page!.rows.map((row) => cellText(row.cells[0]!))
    await wb.pageTab(tab, 1)
    const second = tab.page!.rows.map((row) => cellText(row.cells[0]!))
    const expected = Array.from({ length: 405 }, (_, index) => index + 1)
      .sort((left, right) => (left % 3) - (right % 3) || right - left).map(String)
    checks[check] = tab.page!.offset === 200 && first.length === 200 && second.length === 200
      && [...first, ...second].every((value, index) => value === expected[index])
      && header('group_id').textContent!.includes('↑1') && header('id').textContent!.includes('↓2')

    check = 'mysql_cancel_then_query'
    const active = await backend.runQuery(node, 'SELECT CONNECTION_ID() AS id', { keepCursor: false })
    const serverId = Number(cellText(active.rows[0]!.cells[0]!))
    if (!Number.isSafeInteger(serverId) || serverId <= 0) throw new Error('Invalid fixture connection ID')
    const pending = wb.executeScript(`SELECT id FROM ${database}.items WHERE id = 1 AND SLEEP(25) = 0`).then(() => false, () => true)
    await waitFor(async () => {
      const state = await backend.runQuery(connectionNode(observer.id),
        `SELECT COUNT(*) AS visible FROM information_schema.PROCESSLIST WHERE ID = ${serverId} AND INFO LIKE '%SLEEP(25)%'`,
        { keepCursor: false })
      return cellText(state.rows[0]!.cells[0]!) === '1'
    })
    await wb.cancelExecution()
    const requested = wb.status.value.includes('已请求取消执行')
    const stopped = await pending
    await wb.executeScript('SELECT 271828 AS next_query')
    checks[check] = requested && stopped && cellText(wb.activeTab.value!.page!.rows[0]!.cells[0]!) === '271828'

    // The host requires a real apply/commit/rollback round trip before accepting a smoke report.
    check = 'mysql_transaction'
    const row = tab.page!.rows[0]!
    const rowId = Number(cellText(row.cells[0]!))
    if (!Number.isSafeInteger(rowId) || rowId < 1 || rowId > 405) throw new Error('Invalid fixture row ID')
    const readPayload = async () => {
      const result = await backend.runQuery(connectionNode(observer.id), `SELECT payload FROM ${database}.items WHERE id = ${rowId}`, { keepCursor: false })
      return cellText(result.rows[0]!.cells[0]!)
    }
    wb.stageCell(tab, row, 'payload', { kind: 'text', text: 'uncommitted-fixture' })
    await wb.applyTab(tab)
    await wb.settleTransaction(id, false)
    const rolledBack = await readPayload() === `row-${rowId}`
    if (tab.page!.offset === 0) await wb.pageTab(tab, 1)
    const restored = tab.page!.rows.find((item) => cellText(item.cells[0]!) === String(rowId))
    if (!restored) throw new Error('Missing restored fixture row')
    wb.stageCell(tab, restored, 'payload', { kind: 'text', text: 'committed-fixture' })
    await wb.applyTab(tab)
    await wb.settleTransaction(id, true)
    checks[check] = rolledBack && await readPayload() === 'committed-fixture'

    check = 'mysql_generated_column_export'
    const destinationPath = fixture.exportPath.replace(/export\.csv$/, 'acceptance.sql')
    if (destinationPath === fixture.exportPath) throw new Error('Unexpected export fixture path')
    const task = await backend.startTransfer({ source: { nodeId: table.id }, destinationPath, format: 'sql-insert', options: { batchSize: 100 } })
    const result = await backend.waitTransfer(task.taskId)
    checks[check] = result.status === 'completed' && result.rowsRead === 405 && result.bytesWritten > 0
  } catch {
    checks[check] = false
  }
  return { ok: Object.values(checks).every(Boolean), checks }
}
