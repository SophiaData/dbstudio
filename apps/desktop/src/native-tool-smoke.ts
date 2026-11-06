import type SchemaPanel from './components/SchemaPanel.vue'
import type ErPanel from './components/ErPanel.vue'
import type ComparePanel from './components/ComparePanel.vue'
import type TransferDialog from './components/TransferDialog.vue'
import type ConnectionDialog from './components/ConnectionDialog.vue'
import type ResultGrid from './components/ResultGrid.vue'
import type MetadataTree from './components/MetadataTree.vue'
import type SqlEditor from './components/SqlEditor.vue'
import type SqlLibraryPanel from './components/SqlLibraryPanel.vue'
import type ExplainPanel from './components/ExplainPanel.vue'
import type DdlDialog from './components/DdlDialog.vue'
import type { ConnectionSummary } from '../../../src/core/api'
import type { ObjectRef } from '../../../src/core/model'
import type { TransferFormat } from '../../../src/core/transfer'
import { backend, type SmokeFixture } from './backend'
import { cellText, connectionNode, type ResultTab, type TreeNode, type Workbench } from './workbench'
import { parseParameterValue } from './sql-editor-model'
import { flattenTree } from './tree-model'

export interface NativeToolHost {
  connection(connection: ConnectionSummary): Promise<InstanceType<typeof ConnectionDialog>>
  schema(node: ObjectRef): Promise<InstanceType<typeof SchemaPanel>>
  er(connectionId: string): Promise<InstanceType<typeof ErPanel>>
  compare(): Promise<InstanceType<typeof ComparePanel>>
  transfer(tab: ResultTab, mode: 'import' | 'export'): Promise<InstanceType<typeof TransferDialog>>
  sqlEditor(): Promise<InstanceType<typeof SqlEditor>>
  metadata(): Promise<InstanceType<typeof MetadataTree>>
  grid(tab: ResultTab): Promise<InstanceType<typeof ResultGrid>>
  library(): Promise<InstanceType<typeof SqlLibraryPanel>>
  explain(connectionId: string, sql: string): Promise<InstanceType<typeof ExplainPanel>>
  ddl(mode: 'create-table' | 'create-view' | 'rename' | 'drop', connectionId: string, node?: ObjectRef): Promise<InstanceType<typeof DdlDialog>>
  reviewSql(connectionId: string, sql: string): void
  close(): Promise<void>
}
async function ready(test: () => boolean) {
  const deadline = Date.now() + 10000
  while (!test()) {
    if (Date.now() >= deadline) throw new Error('Native component did not become ready')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
function findTreeNode(nodes: readonly TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.ref.id === id) return node
    const found = findTreeNode(node.children, id)
    if (found) return found
  }
  return undefined
}

/** Uses mounted Vue controllers and real native calls. Returned values contain no database content. */
export async function runNativeToolSmoke(wb: Workbench, host: NativeToolHost, fixture: SmokeFixture, tab: ResultTab, comparisonTable: ObjectRef) {
  const checks: Record<string, boolean> = {}
  const table = tab.table!
  try {
    const schema = await host.schema(table)
    await ready(() => !schema.busy)
    checks.vue_schema_panel = !schema.error && schema.description?.columns.some((column) => column.name === 'value') === true
    const er = await host.er(tab.connectionId)
    await ready(() => !er.busy && (er.tables.length === 0 || Boolean(er.svgRoot)))
    checks.vue_er_panel = !er.error && er.tables.some((item) => item.ref.id === table.id)
    checks.vue_er_real_fk = er.relations.relations.some((relation) => relation.to.tableId === table.id)
    er.toggle(table.id, true)
    const erSelected = er.selectedIds.has(table.id)
    er.toggle(table.id, false)
    const erDeselected = !er.selectedIds.has(table.id)
    er.toggle(table.id, true)
    const erOrigin = er.positions[table.id] ? { ...er.positions[table.id] } : null
    if (erOrigin) er.moveByKey(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, cancelable: true }), table.id)
    const erSvg = er.tables.length ? er.serializeSvg() : ''
    checks.vue_er_layout_svg = erSelected && erDeselected && erOrigin !== null && er.positions[table.id]?.x === Math.min(500000, erOrigin.x + 25) && erSvg.includes('<svg') && erSvg.includes('data-er-root')
    const compare = await host.compare()
    compare.source = tab.connectionId; compare.target = tab.connectionId; compare.mode = 'schema'
    await compare.compare()
    checks.vue_schema_compare = !compare.error && compare.structure?.changes.length === 0
    compare.mode = 'data'; compare.sourceTable = table.id; compare.targetTable = comparisonTable.id
    await compare.compare()
    checks.vue_data_compare = !compare.error && compare.data?.plan.updateCount === 1 && compare.statements.length > 0
    const plan = compare.statements.join('\n')
    compare.target = 'nonexistent-test-selection'
    checks.ui_compare_result_invalidation = compare.statements.length === 0 && compare.data === null && compare.structure === null
    compare.target = tab.connectionId; await compare.compare()
    host.reviewSql(tab.connectionId, plan)
    checks.vue_compare_sql_review = wb.sql.value === plan && plan.length > 0
    const quotedSource = '"' + table.name.replaceAll('"', '""') + '"'
    const quotedTarget = '"' + comparisonTable.name.replaceAll('"', '""') + '"'
    const targetValue = await backend.runQuery(connectionNode(tab.connectionId), `SELECT value FROM ${quotedTarget} WHERE id=1`, { keepCursor: false })
    checks.vue_compare_read_only = targetValue.rows[0]?.cells.some((cell) => cellText(cell) === 'native-target') === true
    await host.close()
    const importer = await host.transfer(tab, 'import')
    importer.path = fixture.importPath
    await importer.loadPreview()
    checks.vue_csv_preview = !importer.error && importer.preview?.sampleRows.length === 2 && importer.mapping.length === 2 && importer.mapping.every(Boolean)
    const importing = importer.start()
    checks.ui_transfer_start_guard_before_await = wb.locks.has(tab.connectionId) && !(await wb.guardAllConnections('测试启动瞬间退出'))
    await importing
    checks.vue_csv_import = !importer.error && importer.progress?.status === 'completed' && await backend.countRows(table.id) === 207
    await host.close()
    for (const format of ['csv', 'jsonl', 'json', 'sql-insert'] as TransferFormat[]) {
      const exporter = await host.transfer(tab, 'export')
      const extension = format === 'sql-insert' ? 'sql' : format
      exporter.format = format
      exporter.path = fixture.exportPath.replace(/\.csv$/, `-${format}.${extension}`)
      await exporter.start()
      checks[`vue_export_${format.replace('-', '_')}`] = !exporter.error && exporter.progress?.status === 'completed' && 'rowsRead' in exporter.progress && exporter.progress.rowsRead === 207
      await host.close()
    }
    const editor = await host.sqlEditor()
    editor.completionOpen = false
    wb.sql.value = `select id,value from ${quotedTarget} where id=1`
    const unformatted = wb.sql.value
    await editor.format()
    checks.vue_sql_editor_format = !editor.error && wb.sql.value.replace(/\s/g, '').toLowerCase() === unformatted.replace(/\s/g, '').toLowerCase() && editor.tokens.some((token) => token.kind === 'keyword')
    wb.sql.value = 'SELECT val'
    editor.setSelection(wb.sql.value.length)
    editor.completionOpen = true
    checks.vue_sql_completion = editor.candidates.includes('value')
    wb.sql.value = 'SELECT 101 AS a; SELECT 102 AS b;'
    editor.setSelection(0)
    const tabsBefore = wb.tabs.value.length
    editor.completionOpen = false
    editor.keydown(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true }))
    await ready(() => wb.tabs.value.length >= tabsBefore + 1 && !wb.executing.value)
    const afterCurrent = wb.tabs.value.length
    editor.keydown(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }))
    await ready(() => wb.tabs.value.length >= afterCurrent + 2 && !wb.executing.value)
    checks.vue_sql_execute_current_all = afterCurrent === tabsBefore + 1 && wb.tabs.value.length === afterCurrent + 2
    const binary = parseParameterValue('00ff', 'binary')
    await wb.executeScript('SELECT ? AS bin_value', [{ statementIndex: 0, name: '?1', value: binary }])
    const binaryCell = wb.activeTab.value?.page?.rows[0]?.cells[0]
    checks.ui_binary_parameter = binary instanceof Uint8Array && binaryCell?.kind === 'blob' && binaryCell.length === 2
    await wb.executeScript(`SELECT id, value FROM ${quotedSource} WHERE id <= :max`, [{ statementIndex: 0, name: 'max', value: 2 }])
    const parameterTab = wb.activeTab.value!
    const parameterExporter = await host.transfer(parameterTab, 'export')
    parameterExporter.format = 'csv'
    parameterExporter.path = fixture.exportPath.replace(/\.csv$/, '-parameterized.csv')
    await parameterExporter.start()
    checks.vue_parameterized_export = !parameterExporter.error && parameterExporter.progress?.status === 'completed' && 'rowsRead' in parameterExporter.progress && parameterExporter.progress.rowsRead === 2
    await host.close()
    await wb.closeTab(parameterTab)
    const metadata = await host.metadata()
    const tableTreeNode = findTreeNode(wb.roots.value, table.id)
    if (tableTreeNode && !tableTreeNode.loaded && !tableTreeNode.expanded) await wb.toggleNode(tableTreeNode)
    if (tableTreeNode?.expanded) await wb.toggleNode(tableTreeNode)
    const searchedRows = flattenTree(wb.roots.value, 'value')
    const collapsedLoadedSearch = tableTreeNode?.loaded === true && tableTreeNode.expanded === false
      && searchedRows.some((row) => row.kind === 'node' && row.node.ref.id === tableTreeNode.ref.id)
      && searchedRows.some((row) => row.kind === 'node' && row.node.ref.kind === 'column' && row.node.ref.name === 'value')
    checks.vue_metadata_tree = wb.metadataReady.value && collapsedLoadedSearch && metadata.rows.some((row) => row.kind === 'node' && row.node.ref.id === table.id) && metadata.rows.some((row) => row.kind === 'node' && row.node.ref.kind === 'connection')
    const longValue = 'Z'.repeat(1500)
    await wb.executeScript(`UPDATE ${quotedSource} SET value = ? WHERE id = 1`, [{ statementIndex: 0, name: '?1', value: longValue }])
    await wb.settleTransaction(tab.connectionId, true)
    const grid = await host.grid(tab)
    const longRow = tab.page!.rows.find((row) => row.cells[0]?.kind === 'number' && row.cells[0].value === 1)
    const valueIndex = tab.page!.columns.findIndex((column) => column.name === 'value')
    const truncated = longRow?.cells[valueIndex]
    if (longRow && valueIndex >= 0) await grid.readCell(longRow, valueIndex)
    checks.vue_grid_full_cell = truncated?.kind === 'text' && truncated.truncated === true && grid.viewer?.value.kind === 'text' && grid.viewer.value.text.length === 1500 && grid.editing === null
    await grid.countRows()
    checks.vue_grid_count = grid.rowCount === 207
    let copyText: string | null = null
    if (longRow && valueIndex >= 0) { grid.selectCell(longRow, valueIndex); copyText = await grid.buildCopyText(true) }
    checks.vue_grid_copy = copyText?.includes(longValue) === true && copyText.includes('\t')
    const loaded = await grid.openLoadedExport()
    let loadedFormats = Boolean(loaded)
    if (loaded) {
      for (const format of ['csv', 'json', 'sql-insert', 'markdown'] as const) {
        loaded.format = format
        await loaded.preview()
        if (loaded.error || !loaded.content) loadedFormats = false
      }
      loadedFormats = loadedFormats && loaded.content.startsWith('|')
      loaded.content = 'x'.repeat(16 * 1024 * 1024 + 1)
      await loaded.save()
      const firstSaveError = loaded.error
      ;(loaded as unknown as { content: unknown }).content = 123
      await loaded.save()
      const retryReachedNativeValidation = firstSaveError.includes('16MiB') && loaded.error.includes('必须是文本') && !loaded.error.includes('16MiB') && !loaded.exported
      loaded.content = ''
      await loaded.preview()
      // Keep the real Tauri bridge: system save/cancel outcomes are platform acceptance,
      // while these failures exercise actual native validation and retry without a dialog.
      loadedFormats = loadedFormats && retryReachedNativeValidation && !loaded.error && !loaded.exported
      grid.closeLoadedExport()
    }
    checks.vue_loaded_export_formats = loadedFormats
    await host.close()
    const library = await host.library()
    await ready(() => !library.busy)
    const historySeen = library.snapshot.history.length > 0
    library.fromEditor()
    library.name = 'Synthetic Vue Library'
    library.savedText = 'SELECT 1 AS synthetic_library'
    await library.save()
    checks.vue_sql_library = historySeen && !library.error && library.snapshot.saved.some((item) => item.id === library.selectedId)
    library.selectedId = 'missing-native-library-id'
    library.name = 'Synthetic Missing Library'
    library.savedText = 'SELECT 2 AS synthetic_library'
    await library.save()
    checks.vue_sql_library_negative = Boolean(library.error)
    await host.close()
    const explain = await host.explain(tab.connectionId, 'SELECT 1 AS explain_check')
    await ready(() => !explain.busy)
    checks.vue_explain_positive = !explain.error && ((explain.result?.columns.length ?? 0) > 0 || (explain.result?.rows.length ?? 0) > 0)
    const failedExplain = await host.explain(tab.connectionId, 'SELECT * FROM native_missing_explain_table_6f2d')
    await ready(() => !failedExplain.busy)
    checks.vue_explain_negative = Boolean(failedExplain.error) && failedExplain.result === null
    await host.close()
    const ddlName = `native_ddl_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
    const ddl = await host.ddl('create-table', tab.connectionId)
    ddl.name = ddlName
    await ddl.submit()
    const created = await backend.runQuery(connectionNode(tab.connectionId), `SELECT COUNT(*) AS n FROM "${ddlName}"`, { keepCursor: false })
    checks.vue_ddl_positive = !ddl.error && created.rows[0]?.cells[0]?.kind === 'number' && created.rows[0].cells[0].value === 0
    const duplicate = await host.ddl('create-table', tab.connectionId)
    duplicate.name = ddlName
    await duplicate.submit()
    checks.vue_ddl_negative = Boolean(duplicate.error)
    await host.close()
    checks.vue_task_guards_released = wb.backgroundTasks.size === 0 && wb.locks.size === 0
    return checks
  } finally { await host.close() }
}
