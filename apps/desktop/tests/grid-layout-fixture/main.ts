import { createApp, h, reactive } from 'vue'
import ResultGrid from '../../src/components/ResultGrid.vue'
import { useWorkbench, type ResultTab } from '../../src/workbench'
import type { CellValue } from '../../../../src/core/resultset'
import '../../src/style.css'

// Synthetic, isolated results rendered by the production component and workbench.
// Layout operations must not call native IPC. Clipboard is captured at the OS boundary.
const calls: unknown[] = []
const copied: string[] = []
const unexpectedCalls: string[] = []
const nativeReplies: { method: 'fetchCellValue' | 'fetchResultPage'; args: unknown[]; reply: () => unknown }[] = []
let deferredCell: { requested: boolean; settled: boolean; resolve: (value: CellValue) => void; reject: (error: Error) => void } | null = null
Object.assign(window, { gridNativeCall: (...args: unknown[]) => {
  calls.push(args)
  const expected = nativeReplies[0]
  const payload = args[1] as { method?: string; args?: unknown[] } | undefined
  if (expected && args.length === 2 && args[0] === 'backend_call' && payload?.method === expected.method &&
    JSON.stringify(payload.args) === JSON.stringify(expected.args)) {
    nativeReplies.shift()
    return expected.reply()
  }
  unexpectedCalls.push('Unexpected native call in layout acceptance')
  throw new Error('Unexpected native call in layout acceptance')
}, gridCopy: async (text: string) => { copied.push(text) } })

const wb = useWorkbench()
wb.connections.value = ['A', 'B'].map(id => ({ id, name: `合成连接 ${id}`, dialectId: 'sqlite',
  connected: true, capabilities: { supportsInlineEdit: true } })) as typeof wb.connections.value

function makeTab(id: string): ResultTab {
  const columns = Array.from({ length: 40 }, (_, index) => ({
    name: ['id', 'amount', '说明', '大字段预览', '重复名称'][index] ??
      (index === 7 ? 'Customer_Code' : index === 22 ? '重复名称' : index === 39 ? '末尾备注' : `field_${index + 1}`),
    type: 'text' as const
  }))
  const rows = Array.from({ length: 32 }, (_, index) => ({ index, cells: columns.map((_, column) => {
    if (column === 0) return { kind: 'text' as const, text: '9007199254740993' }
    if (column === 1) return { kind: 'text' as const, text: '1234567890.123456789012345678' }
    if (column === 2) return { kind: 'text' as const, text: '中文说明' }
    if (column === 3) return { kind: 'text' as const, text: '当前页大字段预览'.repeat(100), truncated: true, fullLength: 100000 }
    if (column === 5) return { kind: 'null' as const }
    return { kind: 'text' as const, text: `${id} · 行 ${index + 1} · 列 ${column + 1}` }
  }) }))
  const page = { columns, rows, offset: 0, returned: rows.length, hasMore: false,
    cursorId: `synthetic-${id}`, elapsedMs: 4, executedSql: 'SELECT synthetic_columns' }
  return reactive({ id, connectionId: id, title: `宽表 ${id}`, table: null, description: null,
    sql: page.executedSql, querySql: page.executedSql, parameters: [], page, result: page,
    message: '', busy: false, invalidated: false, dirty: new Map(), selectedRows: new Set(),
    filter: '', order: [], generation: 0 })
}
const tabs = [makeTab('A'), makeTab('B')]
wb.tabs.value.push(...tabs)
wb.activateTab(tabs[0]!)
let rangeSequence = 0
function rangePage(connection: string, offset = 100, tall = false) {
  const columns = ['id', 'exact_int', 'hidden_note', 'nullable_note', 'empty_note', 'literal_note', 'escaped\t"note"\nline', 'full_note']
    .map(name => ({ name, type: 'text' as const }))
  // Deliberately non-contiguous and out of numeric order: arrows must follow page order.
  const indices = [offset + 1, offset + 205, offset + 107, offset + 309]
  const rows = Array.from({ length: tall ? 48 : 4 }, (_, position) => ({
    index: indices[position] ?? offset + 400 + position * 7,
    cells: [
      { kind: 'text', text: (9007199254740993n + BigInt(position)).toString() },
      { kind: 'text', text: position === 0 ? '9007199254740995' : position === 1 ? '9223372036854775807' : String(position + 5) },
      { kind: 'text', text: `hidden-${position}` },
      position === 0 ? { kind: 'null' } : { kind: 'text', text: position === 1 ? '非空' : 'placeholder' },
      { kind: 'text', text: position < 2 ? '' : 'placeholder' },
      { kind: 'text', text: position < 2 ? '\\N' : 'placeholder' },
      { kind: 'text', text: position === 0 ? '制表\t引号"与换行\n尾部' : position === 1 ? '回车\r换行\r\n尾"' : 'placeholder' },
      position < 2 ? { kind: 'text', text: '全文预览', truncated: true, fullLength: 100000 } : { kind: 'text', text: 'destination full' }
    ] as CellValue[]
  }))
  return { columns, rows, offset, returned: rows.length, hasMore: true,
    cursorId: `synthetic-range-${connection}-${rangeSequence}`, elapsedMs: 4, executedSql: 'SELECT synthetic_range' }
}
function prepareRange(tall = false) {
  if (nativeReplies.length || (deferredCell && !deferredCell.settled)) throw new Error('Previous native expectation was not completed')
  deferredCell = null
  rangeSequence++
  for (const [index, connectionId] of ['A', 'B'].entries()) {
    const tab = makeTab(connectionId)
    tab.id = `range-${rangeSequence}-${connectionId}`
    const page = rangePage(connectionId, 100, tall)
    tab.result = page; tab.page = page
    tab.table = { id: `connection:${connectionId}|table:synthetic_range`, name: 'synthetic_range', kind: 'table' } as ResultTab['table']
    tab.description = { hasUniqueKey: true, columns: page.columns.map((column, columnIndex) => ({
      name: column.name, typeName: columnIndex < 2 ? 'BIGINT' : 'TEXT', nullable: columnIndex > 1,
      primaryKeyOrdinal: columnIndex === 0 ? 1 : null, generated: null, identity: null
    })) } as ResultTab['description']
    wb.connections.value.find(connection => connection.id === connectionId)!.dialectId = 'mysql'
    tabs[index] = tab
  }
  wb.tabs.value.splice(0, wb.tabs.value.length, ...tabs)
  wb.activateTab(tabs[0]!)
}
Object.assign(window, { gridFixture: {
  snapshot: () => ({ calls: calls.length, copied: [...copied], dirty: tabs.map(tab => tab.dirty.size),
    order: tabs.map(tab => tab.order), filter: tabs.map(tab => tab.filter),
    firstCells: tabs.map(tab => tab.page?.rows[0]?.cells.slice(0, 3)) }),
  replacePage: () => {
    const tab = wb.activeTab.value!
    tab.page = { ...tab.page!, columns: [...tab.page!.columns], rows: [...tab.page!.rows] }
  },
  changeSchema: () => {
    const tab = wb.activeTab.value!
    tab.page = { ...tab.page!, columns: tab.page!.columns.map((column, index) => index === 0 ? { ...column, name: 'new_id' } : column) }
  },
  emptyRows: () => { const tab = wb.activeTab.value!; tab.page = { ...tab.page!, rows: [], returned: 0 } },
  prepareEditable: () => {
    const tab = wb.activeTab.value!
    const connection = wb.connections.value.find(connection => connection.id === tab.connectionId)!
    connection.dialectId = 'mysql'
    const columns = ['id', 'exact_int', 'hidden_note', 'amount', 'nullable_note', 'empty_note'].map(name => ({ name, type: 'text' as const }))
    const cells = [
      { kind: 'text' as const, text: '9007199254740993' }, { kind: 'text' as const, text: '9007199254740994' },
      { kind: 'text' as const, text: 'must-stay-hidden' }, { kind: 'text' as const, text: '1234567890.123456789012345678' },
      { kind: 'null' as const }, { kind: 'text' as const, text: '' }
    ]
    const page = { ...tab.page!, columns, rows: [0, 1].map(index => ({ index, cells: structuredClone(cells) })), returned: 2 }
    tab.result = page; tab.page = page; tab.dirty.clear(); tab.selectedRows.clear()
    tab.table = { id: 'connection:' + tab.connectionId + '|table:synthetic', name: 'synthetic', kind: 'table' } as ResultTab['table']
    tab.description = { hasUniqueKey: true, columns: columns.map((column, index) => ({
      name: column.name, typeName: index < 2 ? 'BIGINT' : index === 3 ? 'DECIMAL(38,18)' : 'TEXT',
      nullable: index > 1, primaryKeyOrdinal: index === 0 ? 1 : null, generated: null, identity: null
    })) } as ResultTab['description']
  },
  edits: () => [...wb.activeTab.value!.dirty.entries()],
  clipboard: () => [...copied],
  clearEdits: () => wb.activeTab.value!.dirty.clear(),
  prepareRange,
  rangeState: () => ({ busy: wb.activeTab.value!.busy, offset: wb.activeTab.value!.page!.offset }),
  nativeState: () => ({ calls: [...calls], unexpected: [...unexpectedCalls], queued: nativeReplies.length,
    pending: deferredCell ? { requested: deferredCell.requested, settled: deferredCell.settled } : null }),
  deferredFullCell: (row: number, column: number) => {
    if (deferredCell && !deferredCell.settled) throw new Error('Full cell request is already pending')
    const tab = wb.activeTab.value!
    const cell = tab.page!.rows.find(candidate => candidate.index === row)?.cells[column]
    if (cell?.kind !== 'text' || !cell.truncated) throw new Error('Expected a synthetic truncated cell')
    let resolve!: (value: CellValue) => void
    let reject!: (error: Error) => void
    const promise = new Promise<CellValue>((accept, fail) => { resolve = accept; reject = fail })
    const request = { requested: false, settled: false, resolve, reject }
    deferredCell = request
    nativeReplies.push({ method: 'fetchCellValue', args: [tab.result!.cursorId, row, column], reply: () => {
      request.requested = true
      return promise
    } })
  },
  finishFullCell: (outcome: 'success' | 'failure' | 'truncated') => {
    if (!deferredCell?.requested || deferredCell.settled) throw new Error('No requested full cell to finish')
    deferredCell.settled = true
    if (outcome === 'failure') deferredCell.reject(new Error('合成全文读取失败'))
    else deferredCell.resolve(outcome === 'truncated'
      ? { kind: 'text', text: '仍是预览', truncated: true, fullLength: 100000 }
      : { kind: 'text', text: '全文\t"原值"\r\n结束\\N' })
  },
  queueNextPage: () => {
    const tab = wb.activeTab.value!
    const offset = tab.page!.offset + 200
    const page = { ...rangePage(tab.connectionId, offset), cursorId: tab.result!.cursorId, hasMore: false }
    nativeReplies.push({ method: 'fetchResultPage', args: [tab.result!.cursorId, offset, 200], reply: () => Promise.resolve(page) })
  },
  mutateRange: (kind: 'result' | 'generation' | 'invalidated' | 'cursor') => {
    const tab = wb.activeTab.value!
    if (kind === 'result') tab.result = { ...tab.result! }
    else if (kind === 'generation') tab.generation++
    else if (kind === 'invalidated') tab.invalidated = true
    // Keep result/page identity unchanged to exercise the cursor check independently.
    else if (kind === 'cursor') Object.assign(tab.result!, { cursorId: `${tab.result!.cursorId}-changed` })
    else throw new Error('Unknown synthetic range mutation')
  },
  duplicatePasteColumn: () => {
    const tab = wb.activeTab.value!
    tab.page = { ...tab.page!, columns: tab.page!.columns.map((column, index) => index === 5 ? { ...column, name: 'exact_int' } : column) }
  },
  closeAndReopen: () => {
    tabs[0] = makeTab('A')
    wb.tabs.value.splice(0, 1, tabs[0])
    wb.activeTabId.value = 'A'
  }
} })

createApp({ render: () => h('main', { class: 'workbench' }, [
  h('nav', { class: 'actions', 'aria-label': '合成结果标签' }, tabs.map(tab => h('button', {
    'data-fixture-tab': tab.id, onClick: () => wb.activateTab(tab)
  }, `宽表 ${tab.id}`))),
  wb.activeTab.value && h(ResultGrid, { key: wb.activeTab.value.id, workbench: wb, tab: wb.activeTab.value })
]) }).mount('#app')
