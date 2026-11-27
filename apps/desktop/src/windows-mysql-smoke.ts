import type { ObjectRef } from '../../../src/core/model'
import { backend, type SmokeFixture } from './backend'
import { decision } from './dialogs'
import type { NativeToolHost } from './native-tool-smoke'
import { cellText, connectionNode, type Workbench } from './workbench'
import { ensureSyntaxTree, foldedRanges } from '@codemirror/language'
import { measureEditorPerformance } from './editor-performance-smoke'

const database = 'dbstudio_acceptance'
const restoreDatabase = 'dbstudio_restore'
const options = { host: '127.0.0.1', port: 13306, database, user: 'acceptance', sslmode: 'disable' }

async function waitFor(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000
  do {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < end)
  throw new Error('The acceptance condition did not become ready')
}

function targetText(testId: 'editor-target' | 'result-target') {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.textContent ?? ''
}

async function waitForTargetText(testId: 'editor-target' | 'result-target', expected: readonly string[]) {
  let text = ''
  await waitFor(() => {
    text = targetText(testId)
    return expected.every((value) => text.includes(value))
  })
  return text
}

async function chooseDecision(
  title: string,
  value: string,
  validate?: (content: { message: string; detail: string }) => void | Promise<void>
) {
  let pending = decision.value
  await waitFor(() => {
    const current = decision.value
    if (current?.title === title && document.querySelector('#decision-title')?.textContent === title) {
      pending = current
      return true
    }
    return false
  })
  if (!pending) throw new Error(`Decision ${title} is unavailable`)
  const dialog = document.querySelector<HTMLElement>('.modal[aria-labelledby="decision-title"]')
  const option = pending.options.find((item) => item.value === value)
  if (!dialog || !option) throw new Error(`Decision option ${value} is unavailable`)
  const message = dialog.querySelector('p')?.textContent ?? ''
  const detail = dialog.querySelector('.decision-detail')?.textContent ?? ''
  await validate?.({ message, detail })
  const button = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === option.label)
  if (!button) throw new Error(`Decision button ${option.label} is unavailable`)
  button.click()
  await waitFor(() => decision.value !== pending)
  return { message, detail }
}

export async function runWindowsMysqlSmoke(wb: Workbench, tools: NativeToolHost, fixture: SmokeFixture) {
  const checks: Record<string, boolean> = { isolated_fixture: fixture.isolated }
  let editorPerformance: Awaited<ReturnType<typeof measureEditorPerformance>> | undefined
  let check = 'mysql_connection'
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exercise(),
      new Promise<{ ok: boolean; checks: Record<string, boolean>; editorPerformance?: typeof editorPerformance }>((resolve) => {
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

    check = 'mysql_editor_error_navigation'
    const failureSql = "SELECT 'before-error';\nSELECT dbstudio_missing_column;\nSELECT 'must-not-run';"
    wb.sql.value = failureSql
    view.focus()
    const beforeFailure = wb.tabs.value.length
    editorKey('Enter', { shiftKey: true })
    await waitFor(() => !wb.executing.value && wb.activeTab.value?.failure !== undefined)
    const failed = wb.activeTab.value!
    const failure = failed.failure!
    const locate = document.querySelector<HTMLButtonElement>('.sql-execution-failure button')!
    const captured = wb.tabs.value.length === beforeFailure + 2 && failure.startLine === 2 && failure.source?.from === failureSql.indexOf('SELECT dbstudio')
    locate.click()
    await waitFor(() => view.state.selection.main.from === failure.source!.from)
    const located = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) === 'SELECT dbstudio_missing_column'
    wb.sql.value = 'SELECT 42 AS recovered'
    await waitFor(() => locate.disabled)
    const originalRetained = failure.source?.document === failureSql && failure.sql === 'SELECT dbstudio_missing_column'
    editor.executeAll()
    await waitFor(() => !wb.executing.value && wb.activeTab.value?.id !== failed.id)
    const recovered = wb.activeTab.value!
    checks[check] = captured && located && originalRetained && cellText(recovered.page!.rows[0]!.cells[0]!) === '42'
    for (const result of wb.tabs.value.slice(beforeFailure)) await wb.closeTab(result)

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
    const cancelledApply = wb.applyTab(tab)
    await chooseDecision('更新 SQL 预览', 'cancel', ({ detail }) => {
      if (!detail.includes('uncommitted-fixture')) throw new Error('Direct apply preview omitted update parameters')
    })
    const applyCancelled = await cancelledApply
    const cancelledApplyClean = applyCancelled === false && tab.dirty.size === 1
      && await readPayload() === `row-${rowId}` && !(await wb.readTransaction(id)).active
    const confirmedApply = wb.applyTab(tab)
    await chooseDecision('更新 SQL 预览', 'apply', ({ detail }) => {
      if (!detail.includes('uncommitted-fixture')) throw new Error('Direct apply preview omitted update parameters')
    })
    const applyConfirmed = await confirmedApply
    const appliedInTransaction = applyConfirmed === true && tab.dirty.size === 0
      && (await wb.readTransaction(id)).active && await readPayload() === `row-${rowId}`
    const rollback = wb.settleTransaction(id, false)
    await chooseDecision('回滚当前连接', 'confirm')
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
      await chooseDecision('更新 SQL 预览', choice)
      await waitFor(() => !wb.locks.has(id) && !tab.busy)
      return Boolean(sqlMatches) && untouched
    }
    const cancelledReview = await review('cancel') && tab.dirty.size === 1 && await unchanged()
    const confirmedReview = await review('apply') && tab.dirty.size === 0
    const stagedInTransaction = (await wb.readTransaction(id)).active && await readPayload() === 'row-' + rowId
    const commit = wb.settleTransaction(id, true)
    await chooseDecision('提交当前连接', 'commit')
    const committed = await commit
    checks[check] = cleanBefore && cancelledApplyClean && appliedInTransaction
      && cancelledReview && confirmedReview && stagedInTransaction && committed
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
      await chooseDecision('更新 SQL 预览', 'apply')
      await waitFor(() => !wb.locks.has(id) && !tab.busy)
      return tab.dirty.size === 0 && (await wb.readTransaction(id)).active
        && JSON.stringify(await readPastedRows()) === beforePaste
    }
    const firstPaste = await staged()
    const firstApply = firstPaste && await applyPastedRows()
    if (!firstApply) throw new Error('Bulk paste did not become a pending transaction')
    const revertPaste = wb.settleTransaction(id, false)
    await chooseDecision('回滚当前连接', 'confirm')
    const reverted = await revertPaste && JSON.stringify(await readPastedRows()) === beforePaste
    const secondApply = await staged() && await applyPastedRows()
    if (!secondApply) throw new Error('Bulk paste could not be repeated after rollback')
    const pasteCommit = wb.settleTransaction(id, true)
    await chooseDecision('提交当前连接', 'commit')
    if (!await pasteCommit) throw new Error('Bulk paste transaction was not committed')
    const expectedRows = [
      [String(ids[0]), '2', 'from\ttable', null],
      [String(ids[1]), '1', 'two\r\nlines', '']
    ].sort((left, right) => Number(left[0]) - Number(right[0]))
    checks[check] = rejectedCleanly && reverted && JSON.stringify(await readPastedRows()) === JSON.stringify(expectedRows)

    check = 'mysql_guard_local_apply_preview'
    const guardRow = tab.page!.rows[0]!
    const guardRowId = Number(cellText(guardRow.cells[0]!))
    const guardRead = async () => {
      const result = await backend.runQuery(connectionNode(observer.id),
        `SELECT payload FROM ${database}.items WHERE id = ${guardRowId}`,
        { keepCursor: false })
      return cellText(result.rows[0]!.cells[0]!)
    }
    const guardBefore = await guardRead()
    wb.stageCell(tab, guardRow, 'payload', { kind: 'text', text: 'guard-local-value' })
    const transform = wb.transformTab(tab, [{ column: 'id', direction: 'DESC' }])
    await chooseDecision('排序或筛选', 'apply')
    const guardPreview = await chooseDecision('更新 SQL 预览', 'apply', ({ detail }) => {
      if (!detail.includes('guard-local-value')) throw new Error('Guard apply preview omitted update parameters')
    })
    await transform
    await waitFor(() => !wb.locks.has(id) && !tab.busy)
    const guardObserverBeforeCommit = await guardRead()
    const guardCommit = wb.settleTransaction(id, true)
    await chooseDecision('提交当前连接', 'commit')
    const guardCommitted = await guardCommit
    checks[check] = guardPreview.detail.includes('guard-local-value') && tab.dirty.size === 0
      && guardObserverBeforeCommit === guardBefore && guardCommitted
      && await guardRead() === 'guard-local-value'

    check = 'mysql_connection_draft_aggregate'
    const secondaryTable: ObjectRef = {
      id: `${node}|table:${database}.items_secondary`,
      name: 'items_secondary',
      kind: 'table',
      parentId: node,
      hasChildren: true
    }
    const primaryAggregateRow = tab.page!.rows[0]!
    const primaryAggregateId = Number(cellText(primaryAggregateRow.cells[0]!))
    await wb.openTable(secondaryTable)
    const secondaryTab = wb.activeTab.value!
    const secondaryAggregateRow = secondaryTab.page!.rows[0]!
    const secondaryAggregateId = Number(cellText(secondaryAggregateRow.cells[0]!))
    const readAggregate = async () => {
      const primary = await backend.runQuery(connectionNode(observer.id),
        `SELECT payload FROM ${database}.items WHERE id = ${primaryAggregateId}`,
        { keepCursor: false })
      const secondary = await backend.runQuery(connectionNode(observer.id),
        `SELECT payload FROM ${database}.items_secondary WHERE id = ${secondaryAggregateId}`,
        { keepCursor: false })
      return [
        cellText(primary.rows[0]!.cells[0]!),
        cellText(secondary.rows[0]!.cells[0]!)
      ]
    }
    const aggregateBefore = await readAggregate()
    wb.stageCell(tab, primaryAggregateRow, 'payload', { kind: 'text', text: 'aggregate-base' })
    const baseApply = wb.applyTab(tab)
    await chooseDecision('更新 SQL 预览', 'apply')
    if (!await baseApply) throw new Error('Aggregate fixture base transaction was not applied')
    const refreshedPrimaryAggregateRow = tab.page!.rows.find(
      (item) => cellText(item.cells[0]!) === String(primaryAggregateId)
    )
    if (!refreshedPrimaryAggregateRow) throw new Error('Missing refreshed aggregate fixture row')
    wb.stageCell(tab, refreshedPrimaryAggregateRow, 'payload', { kind: 'text', text: 'aggregate-primary' })
    wb.stageCell(secondaryTab, secondaryAggregateRow, 'payload', { kind: 'text', text: 'aggregate-secondary' })
    const aggregateValidate = (verifyUnchanged = false) => async (
      { message, detail }: { message: string; detail: string }
    ) => {
      if (!message.includes('已有事务：1 行未提交。')
          || !message.includes('本次新增草稿：2 个标签、2 行。')
          || !detail.includes('aggregate-primary')
          || !detail.includes('aggregate-secondary')
          || !detail.includes('items') || !detail.includes('items_secondary')) {
        throw new Error('Aggregate commit preview omitted the transaction or draft SQL parameters')
      }
      if (verifyUnchanged) {
        const state = await wb.readTransaction(id)
        if (!state.active || state.pendingAffected !== 1) {
          throw new Error('Aggregate commit preview changed the existing transaction')
        }
        if (JSON.stringify(await readAggregate()) !== JSON.stringify(aggregateBefore)) {
          throw new Error('Aggregate commit preview changed fixture rows before confirmation')
        }
      }
    }
    const cancelledAggregate = wb.settleTransaction(id, true)
    await chooseDecision('提交当前连接', 'cancel', aggregateValidate())
    const aggregateCancelled = await cancelledAggregate
    const retainedAfterCancel = aggregateCancelled === false
      && tab.dirty.size === 1 && secondaryTab.dirty.size === 1
      && JSON.stringify(await readAggregate()) === JSON.stringify(aggregateBefore)
    const confirmedAggregate = wb.settleTransaction(id, true)
    const aggregatePreview = await chooseDecision('提交当前连接', 'commit', aggregateValidate(true))
    const aggregateCommitted = await confirmedAggregate
    const aggregateAfter = await readAggregate()
    checks[check] = retainedAfterCancel && aggregateCommitted === true
      && tab.dirty.size === 0 && secondaryTab.dirty.size === 0
      && aggregatePreview.detail.includes('aggregate-primary')
      && aggregatePreview.detail.includes('aggregate-secondary')
      && aggregateAfter[0] === 'aggregate-primary' && aggregateAfter[1] === 'aggregate-secondary'
    await wb.closeTab(secondaryTab)

    check = 'mysql_generated_column_export'
    const destinationPath = fixture.exportPath.replace(/export\.csv$/, 'acceptance.sql')
    if (destinationPath === fixture.exportPath) throw new Error('Unexpected export fixture path')
    const task = await backend.startTransfer({ source: { nodeId: table.id }, destinationPath, format: 'sql-insert', options: { batchSize: 100 } })
    const result = await backend.waitTransfer(task.taskId)
    checks[check] = result.status === 'completed' && result.rowsRead === 405 && result.bytesWritten > 0
    check = 'mysql_editor_large_drafts'
    editorPerformance = await measureEditorPerformance(wb, tools)
    checks[check] = true

    check = 'mysql_execution_context'
    if (!wb.connections.value.some((item) => item.id === observer.id)) wb.connections.value.push(observer)
    let contextVerified = false
    let contextCleaned = false
    const originalEditorId = wb.openEditorTab(id, 'SELECT DATABASE() AS session_database')
    const beforeContextResult = wb.tabs.value.length
    document.querySelector<HTMLButtonElement>('#btn-run-sql')!.click()
    await waitFor(() => !wb.executing.value && wb.tabs.value.length === beforeContextResult + 1)
    const originalResult = wb.activeTab.value!
    const originalSnapshot = originalResult.executionContext
    await wb.refreshSessionContext(id)
    await wb.refreshSessionContext(observer.id)
    const originalTarget = await wb.connectionTarget(id)
    const observerTargetBefore = await wb.connectionTarget(observer.id)
    const initialEditorTarget = await waitForTargetText('editor-target', [name, '配置默认库', database, '最近核实会话库'])
    const initialResultTarget = await waitForTargetText('result-target', [name, '配置默认库', database, '执行时会话库', '该连接当前状态', '最近核实会话库'])
    try {
      const restoreEditorId = wb.openEditorTab(id, `USE ${restoreDatabase}`)
      const beforeUseResult = wb.tabs.value.length
      document.querySelector<HTMLButtonElement>('#btn-run-sql')!.click()
      await waitFor(() => !wb.executing.value && wb.tabs.value.length === beforeUseResult + 1)
      const useResult = wb.activeTab.value!
      await wb.refreshSessionContext(id)
      const switchedTarget = await wb.connectionTarget(id)
      const switchedEditorTarget = await waitForTargetText('editor-target', [name, '配置默认库', database, '最近核实会话库', restoreDatabase])

      wb.activateEditorTab(restoreEditorId)
      wb.activateTab(originalResult)
      const isolatedResultTarget = await waitForTargetText('result-target', [name, '执行时会话库', database, '该连接当前状态', '最近核实会话库', restoreDatabase])
      const resultSnapshotRetained = originalResult.executionContext?.session.database === database
        && originalResult.executionContext?.configuredDatabase === database

      wb.openEditorTab(observer.id, 'SELECT DATABASE() AS observer_session_database')
      const beforeObserverResult = wb.tabs.value.length
      document.querySelector<HTMLButtonElement>('#btn-run-sql')!.click()
      await waitFor(() => !wb.executing.value && wb.tabs.value.length === beforeObserverResult + 1)
      const observerResult = wb.activeTab.value!
      await wb.refreshSessionContext(observer.id)
      const observerTargetAfter = await wb.connectionTarget(observer.id)
      const observerEditorTarget = await waitForTargetText('editor-target', ['Acceptance observer', '配置默认库', database, '最近核实会话库'])
      const observerResultTarget = await waitForTargetText('result-target', ['Acceptance observer', '执行时会话库', database, '该连接当前状态', '最近核实会话库'])

      const failedEditorId = wb.openEditorTab(id, 'USE dbstudio_context_missing')
      const beforeFailedUse = wb.tabs.value.length
      document.querySelector<HTMLButtonElement>('#btn-run-sql')!.click()
      await waitFor(() => !wb.executing.value && wb.tabs.value.length === beforeFailedUse + 1
        && wb.activeTab.value?.executionFailed === true)
      const failedUseResult = wb.activeTab.value!
      await wb.refreshSessionContext(id)
      const afterFailedUse = await wb.connectionTarget(id)
      const failedEditorTarget = await waitForTargetText('editor-target', [name, restoreDatabase, '最近核实会话库'])
      const failedResultTarget = await waitForTargetText('result-target', [name, restoreDatabase, '执行时会话库', '该连接当前状态'])

      wb.activateEditorTab(restoreEditorId)
      wb.activateTab(observerResult)
      const crossedResultTarget = await waitForTargetText('result-target', ['Acceptance observer', database, '执行时会话库', '该连接当前状态'])
      wb.activateEditorTab(originalEditorId)
      const crossedEditorTarget = await waitForTargetText('editor-target', [name, restoreDatabase, '最近核实会话库'])
      wb.activateTab(originalResult)
      const crossedBackResultTarget = await waitForTargetText('result-target', [name, database, restoreDatabase, '执行时会话库', '该连接当前状态'])

      const observerTable: ObjectRef = {
        id: `${connectionNode(observer.id)}|table:${database}.items`,
        name: 'items',
        kind: 'table',
        parentId: connectionNode(observer.id),
        hasChildren: true
      }
      await wb.openTable(observerTable)
      const itemLabels = Array.from(document.querySelectorAll<HTMLButtonElement>('.result-tab .tab-label'))
        .map((label) => (label.textContent ?? '').trim())
        .filter((label) => label.startsWith('items'))
      const tableLabelsDisambiguated = itemLabels.some((label) => label.includes(name))
        && itemLabels.some((label) => label.includes('Acceptance observer'))

      contextVerified = originalTarget.connectionId === id
        && originalTarget.connectionName === name
        && originalTarget.dialectId === 'mysql'
        && originalTarget.configuredDatabase === database
        && originalTarget.connected === true
        && originalTarget.session.status === 'ready'
        && originalTarget.session.database === database
        && observerTargetBefore.configuredDatabase === database
        && observerTargetBefore.session.status === 'ready'
        && observerTargetBefore.session.database === database
        && originalSnapshot?.connectionId === id
        && originalSnapshot.connectionName === name
        && originalSnapshot.configuredDatabase === database
        && originalSnapshot.session.database === database
        && initialEditorTarget.includes('配置默认库') && initialEditorTarget.includes('最近核实会话库')
        && initialResultTarget.includes('执行时会话库') && initialResultTarget.includes('该连接当前状态')
        && switchedTarget.configuredDatabase === database
        && switchedTarget.session.status === 'ready'
        && switchedTarget.session.database === restoreDatabase
        && switchedEditorTarget.includes(name) && switchedEditorTarget.includes(restoreDatabase)
        && useResult.executionContext?.session.database === restoreDatabase
        && isolatedResultTarget.includes(database) && isolatedResultTarget.includes(restoreDatabase)
        && resultSnapshotRetained
        && observerTargetAfter.configuredDatabase === database
        && observerTargetAfter.session.status === 'ready'
        && observerTargetAfter.session.database === database
        && observerResult.executionContext?.session.database === database
        && observerEditorTarget.includes(database)
        && observerResultTarget.includes(database)
        && afterFailedUse.configuredDatabase === database
        && afterFailedUse.session.status === 'ready'
        && afterFailedUse.session.database === restoreDatabase
        && failedUseResult.executionContext?.session.database === restoreDatabase
        && failedEditorTarget.includes(restoreDatabase)
        && !failedEditorTarget.includes('dbstudio_context_missing')
        && failedResultTarget.includes(restoreDatabase)
        && !failedResultTarget.includes('dbstudio_context_missing')
        && crossedResultTarget.includes(database)
        && crossedEditorTarget.includes(restoreDatabase)
        && crossedBackResultTarget.includes(database) && crossedBackResultTarget.includes(restoreDatabase)
        && tableLabelsDisambiguated
      wb.activateEditorTab(failedEditorId)
    } finally {
      await backend.executeStatement(connectionNode(id), `USE ${database}`, {})
      await backend.rollbackTransaction(connectionNode(id))
      await wb.refreshSessionContext(id)
      wb.activateEditorTab(originalEditorId)
      wb.activateTab(originalResult)
      const restoredTarget = await wb.connectionTarget(id)
      const transaction = await wb.readTransaction(id)
      const observerTransaction = await wb.readTransaction(observer.id)
      const restoredEditorTarget = await waitForTargetText('editor-target', [name, database])
      const restoredResultTarget = await waitForTargetText('result-target', [name, database])
      contextCleaned = restoredTarget.configuredDatabase === database
        && restoredTarget.session.status === 'ready'
        && restoredTarget.session.database === database
        && transaction.active === false
        && transaction.pendingAffected === 0
        && observerTransaction.active === false
        && observerTransaction.pendingAffected === 0
        && !restoredEditorTarget.includes(restoreDatabase)
        && !restoredResultTarget.includes(restoreDatabase)
    }
    checks[check] = contextVerified && contextCleaned
  } catch {
    checks[check] = false
  }
  return { ok: Object.values(checks).every(Boolean), checks, editorPerformance }
  }
}
