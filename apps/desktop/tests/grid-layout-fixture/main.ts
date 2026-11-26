import { createApp, h, reactive } from 'vue'
import ResultGrid from '../../src/components/ResultGrid.vue'
import { useWorkbench, type ResultTab } from '../../src/workbench'
import '../../src/style.css'

// Synthetic, isolated results rendered by the production component and workbench.
// Layout operations must not call native IPC. Clipboard is captured at the OS boundary.
const calls: unknown[] = []
const copied: string[] = []
Object.assign(window, { gridNativeCall: (...args: unknown[]) => {
  calls.push(args)
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
