import type { ObjectRef } from '../../../src/core/model'
import { backend, type SmokeFixture } from './backend'
import { decision } from './dialogs'
import type { NativeToolHost } from './native-tool-smoke'
import { cellText, connectionNode, type Workbench } from './workbench'
import { ensureSyntaxTree, foldedRanges } from '@codemirror/language'

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
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exercise(),
      new Promise<{ ok: boolean; checks: Record<string, boolean> }>((resolve) => {
        deadline = setTimeout(() => resolve({ ok: false, checks: { ...checks, [check]: false, stage_timed_out: false } }), 75000)
      })
    ])
  } finally {
    clearTimeout(deadline)
  }

  async function exercise() {
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

    check = 'mysql_codemirror_execution'
    const view = editor.editor
    if (!view || !view.dom.querySelector('.cm-lineNumbers')) throw new Error('CodeMirror is not mounted')
    const editorSql = "-- 中文输入验收\nSELECT 'editor-中文' AS editor_value; SELECT 17 AS following;"
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: editorSql } })
    view.focus()
    editor.setSelection(editorSql.indexOf('SELECT'))
    if (!editor.currentStatement().includes("'editor-中文'")) throw new Error('Editor selection did not reach the intended statement')
    const beforeEditorExecution = wb.tabs.value.length
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }))
    const imeDidNotExecute = wb.tabs.value.length === beforeEditorExecution && !wb.executing.value
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
    await waitFor(() => !wb.executing.value && wb.tabs.value.length > beforeEditorExecution)
    const editorResult = wb.activeTab.value!
    checks.mysql_editor_ime_guard = imeDidNotExecute
    checks.mysql_editor_single_statement = wb.tabs.value.length === beforeEditorExecution + 1
    checks.mysql_editor_text_result = cellText(editorResult.page!.rows[0]!.cells[0]!) === 'editor-中文'
    checks.mysql_editor_sql_source = editorResult.sql.includes("'editor-中文'")
    checks.mysql_editor_text_kind = editorResult.page!.rows[0]!.cells[0]!.kind === 'text'
    checks[check] = checks.mysql_editor_ime_guard && checks.mysql_editor_single_statement && checks.mysql_editor_text_result
    await wb.closeTab(editorResult)

    check = 'mysql_editor_daily_tools'
    const dailySql = "SELECT\n  'daily-中文' AS editor_value;"
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: dailySql }, selection: { anchor: 0 } })
    view.focus()
    const editorKey = (key: string, extra: KeyboardEventInit = {}) => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))
    editorKey('h', { ctrlKey: true })
    const searchPanel = view.dom.querySelector('.cm-search')!
    for (const [name, value] of [['search', 'daily-中文'], ['replace', 'replaced-中文']]) {
      const input = searchPanel.querySelector<HTMLInputElement>(`input[name="${name}"]`)!
      input.value = value!
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
    searchPanel.querySelector<HTMLButtonElement>('button[name="replaceAll"]')!.click()
    const replaced = wb.sql.value === dailySql.replace('daily-中文', 'replaced-中文')
    searchPanel.querySelector<HTMLButtonElement>('button[name="close"]')!.click()
    view.focus()
    editorKey('z', { ctrlKey: true })
    const editorRestored = wb.sql.value === dailySql
    editor.setSelection(0)
    editorKey('/', { ctrlKey: true, code: 'Slash' })
    const commented = wb.sql.value.startsWith('-- SELECT')
    editorKey('z', { ctrlKey: true })
    ensureSyntaxTree(view.state, view.state.doc.length, 100)
    editorKey('{', { ctrlKey: true, shiftKey: true, code: 'BracketLeft', keyCode: 219 })
    const folded = foldedRanges(view.state).size === 1 && wb.sql.value === dailySql
    const wrapButton = Array.from((editor.$el as HTMLElement).querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '自动换行')!
    wrapButton.click()
    await waitFor(() => view.lineWrapping)
    const beforeDailyExecution = wb.tabs.value.length
    editorKey('Enter', { ctrlKey: true })
    await waitFor(() => !wb.executing.value && wb.tabs.value.length > beforeDailyExecution)
    const dailyResult = wb.activeTab.value!
    checks[check] = replaced && editorRestored && commented && folded
      && wb.tabs.value.length === beforeDailyExecution + 1
      && cellText(dailyResult.page!.rows[0]!.cells[0]!) === 'daily-中文'
    editorKey('}', { ctrlKey: true, shiftKey: true, code: 'BracketRight', keyCode: 221 })
    wrapButton.click()
    await wb.closeTab(dailyResult)

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
    const pending = wb.executeScript(`SELECT id FROM ${database}.items WHERE id = 1 AND SLEEP(25) = 0`).then(
      () => wb.activeTab.value?.page?.rows.length === 0,
      () => true
    )
    await waitFor(async () => {
      const state = await backend.runQuery(connectionNode(observer.id),
        `SELECT COUNT(*) AS visible FROM information_schema.PROCESSLIST WHERE ID = ${serverId} AND INFO LIKE '%SLEEP(25)%'`,
        { keepCursor: false })
      return cellText(state.rows[0]!.cells[0]!) === '1'
    })
    await wb.cancelExecution()
    const requested = wb.status.value.includes('已请求取消执行')
    const stopped = await pending
    const cancelledTab = wb.activeTab.value
    if (cancelledTab && cancelledTab !== tab) await wb.closeTab(cancelledTab)
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
    const rollback = wb.settleTransaction(id, false)
    await waitFor(() => decision.value?.title === '回滚当前连接')
    decision.value!.settle('confirm')
    if (!await rollback) throw new Error('Fixture rollback was not confirmed')
    const rolledBack = await readPayload() === `row-${rowId}`
    if (tab.page!.offset === 0) await wb.pageTab(tab, 1)
    const restored = tab.page!.rows.find((item) => cellText(item.cells[0]!) === String(rowId))
    if (!restored) throw new Error('Missing restored fixture row')
    check = 'mysql_update_preview'
    const committedValue = "fixture O'Brien"
    wb.stageCell(tab, restored, 'payload', { kind: 'text', text: committedValue })
    const updates = [...tab.dirty.values()]
    const unchanged = async () => await readPayload() === 'row-' + rowId && !(await wb.readTransaction(id)).active
    const preview = await backend.previewRowUpdates(table.id, updates)
    const staleRejected = await backend.applyEdits(table.id,
      [{ ...updates[0]!, changes: { payload: { kind: 'text', text: 'unexpected draft' } } }],
      preview.fingerprint
    ).then(() => false, (cause: unknown) => (cause as { code?: string })?.code === 'conflict')
    const cleanBefore = staleRejected && await unchanged()
    const mountedGrid = await tools.grid(tab)
    const applyButton = Array.from(mountedGrid.$el.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
      .find((button) => button.textContent?.trim() === '应用修改 (1)')
    if (!applyButton) throw new Error('Apply button was not found')
    const review = async (choice: 'apply' | 'cancel') => {
      applyButton.click()
      await waitFor(() => decision.value?.title === '更新 SQL 预览' && !!document.querySelector('.decision-detail'))
      const detail = document.querySelector('.decision-detail')?.textContent
      const sqlMatches = detail?.includes(preview.statements[0]!.sql) &&
        detail.includes(JSON.stringify([committedValue, rowId])) &&
        preview.statements[0]!.sql.includes('WHERE ' + String.fromCharCode(96) + 'id' + String.fromCharCode(96) + '=?')
      const untouched = await unchanged()
      decision.value!.settle(choice)
      await waitFor(() => !wb.locks.has(id) && !tab.busy)
      return Boolean(sqlMatches) && untouched
    }
    const cancelledReview = await review('cancel') && tab.dirty.size === 1 && await unchanged()
    const confirmedReview = await review('apply') && tab.dirty.size === 0
    const stagedInTransaction = (await wb.readTransaction(id)).active && await readPayload() === 'row-' + rowId
    await wb.settleTransaction(id, true)
    checks[check] = cleanBefore && cancelledReview && confirmedReview && stagedInTransaction
    checks.mysql_transaction = rolledBack && await readPayload() === committedValue

    check = 'mysql_grid_batch_paste'
    const ids = tab.page!.rows.slice(0, 2).map((item) => Number(cellText(item.cells[0]!)))
    if (ids.length !== 2 || ids.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 405)) {
      throw new Error('Invalid bulk paste fixture row IDs')
    }
    const readPastedRows = async () => {
      const result = await backend.runQuery(connectionNode(observer.id),
        'SELECT id, group_id, payload, note FROM ' + database + '.items WHERE id IN (' + ids.join(',') + ') ORDER BY id',
        { keepCursor: false })
      return result.rows.map(({ cells }) => cells.map((cell) => cell.kind === 'null' ? null : cellText(cell)))
    }
    const beforePaste = JSON.stringify(await readPastedRows())
    const paste = async (text: string, row = 0) => {
      const grid = await tools.grid(tab)
      const targetRow = grid.$el.querySelectorAll('tbody tr')[row]
      const column = tab.page!.columns.findIndex((item) => item.name === 'group_id')
      const target = targetRow?.querySelectorAll('td')[column + 1] as HTMLTableCellElement | undefined
      if (!target || column < 0) throw new Error('Missing paste target')
      const clipboard = new DataTransfer()
      clipboard.setData('text/plain', text)
      target.focus()
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
      return grid.error
    }
    const invalid = await paste('2\tvalid\tvalue\r\nnot-a-number\trejected\tvalue')
    const pastPage = await paste('2\tvalid\tvalue\r\n1\tsecond\tvalue', tab.page!.rows.length - 1)
    const rejectedCleanly = invalid.includes('第 2 行') && invalid.includes('group_id') && pastPage.includes('超出当前页')
      && tab.dirty.size === 0 && JSON.stringify(await readPastedRows()) === beforePaste
    const batch = '2\t"from\ttable"\t\\N\r\n1\t"two\r\nlines"\t\r\n'
    const staged = async () => {
      if (await paste(batch)) return false
      const drafts = [...tab.dirty.values()]
      return drafts.length === 2 && drafts[0]?.changes.note?.kind === 'null'
        && drafts[1]?.changes.note?.kind === 'text' && drafts[1].changes.note.text === ''
        && !(await wb.readTransaction(id)).active && JSON.stringify(await readPastedRows()) === beforePaste
    }
    const applyPastedRows = async () => {
      const grid = await tools.grid(tab)
      const button = Array.from(grid.$el.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
        .find((candidate) => candidate.textContent?.trim() === '应用修改 (2)')
      if (!button) throw new Error('Missing apply action for bulk paste')
      button.click()
      await waitFor(() => decision.value?.title === '更新 SQL 预览')
      decision.value!.settle('apply')
      await waitFor(() => !wb.locks.has(id) && !tab.busy)
      return tab.dirty.size === 0 && (await wb.readTransaction(id)).active
        && JSON.stringify(await readPastedRows()) === beforePaste
    }
    const firstPaste = await staged()
    const firstApply = firstPaste && await applyPastedRows()
    if (!firstApply) throw new Error('Bulk paste did not become a pending transaction')
    const revertPaste = wb.settleTransaction(id, false)
    await waitFor(() => decision.value?.title === '回滚当前连接')
    decision.value!.settle('confirm')
    const reverted = await revertPaste && JSON.stringify(await readPastedRows()) === beforePaste
    const secondApply = await staged() && await applyPastedRows()
    if (!secondApply) throw new Error('Bulk paste could not be repeated after rollback')
    await wb.settleTransaction(id, true)
    const expectedRows = [
      [String(ids[0]), '2', 'from\ttable', null],
      [String(ids[1]), '1', 'two\r\nlines', '']
    ].sort((left, right) => Number(left[0]) - Number(right[0]))
    checks[check] = rejectedCleanly && reverted && JSON.stringify(await readPastedRows()) === JSON.stringify(expectedRows)

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
}
