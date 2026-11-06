import type { CellValue, ResultColumn } from '../../../src/core/resultset'
import { csvEscapeField, buildInsertTarget, quoteTransferIdentifier } from '../../../src/core/transfer'
import { inferSchemaFromObjectId } from '../../../src/renderer/er-relations'
import { exactNumberLiteral, parameterLiteral } from './sql-editor-model'
import { backend } from './backend'
import type { ResultTab, Workbench } from './workbench'

export type LoadedFormat = 'csv' | 'json' | 'sql-insert' | 'markdown'
export function complete(cell: CellValue) {
  if ((cell.kind === 'text' || cell.kind === 'blob') && cell.truncated) throw new Error('值仍被截断，无法复制或导出完整内容')
  return cell
}
export function textValue(cell: CellValue): string | null {
  complete(cell)
  if (cell.kind === 'null') return null
  if (cell.kind === 'text') return cell.text
  if (cell.kind === 'number') return exactNumberLiteral(cell.value)
  if (cell.kind === 'boolean') return cell.value ? 'true' : 'false'
  return '0x' + [...atob(cell.previewBase64)].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase()
}
export async function fullCell(tab: ResultTab, row: number, column: number, cell: CellValue): Promise<CellValue> {
  if ((cell.kind === 'text' || cell.kind === 'blob') && cell.truncated) {
    if (!tab.result?.cursorId || tab.invalidated) throw new Error('游标不可用，无法获取完整字段')
    return complete(await backend.fetchCellValue(tab.result.cursorId, row, column))
  }
  return complete(cell)
}
export async function completeLoadedRows(tab: ResultTab): Promise<CellValue[][]> {
  const page = tab.page
  if (!page || tab.invalidated) throw new Error('当前没有有效已加载结果')
  const rows: CellValue[][] = []
  for (const row of page.rows) {
    const cells: CellValue[] = []
    for (let index = 0; index < page.columns.length; index++) {
      const column = page.columns[index]!
      const cell = tab.dirty.get(row.index)?.changes[column.name] ?? row.cells[index]!
      cells.push(await fullCell(tab, row.index, index, cell))
    }
    rows.push(cells)
  }
  return rows
}
export function renderLoaded(format: LoadedFormat, columns: readonly ResultColumn[], rows: readonly (readonly CellValue[])[], tab: ResultTab, wb: Workbench): string {
  if (columns.some((column, index) => columns.findIndex((candidate) => candidate.name === column.name) !== index) && format === 'json') throw new Error('JSON 对象无法无损表达重复列名，请选择 CSV 或 Markdown')
  const texts = rows.map((row) => row.map(textValue))
  if (format === 'csv') return '\uFEFF' + [columns.map((column) => csvEscapeField(column.name)).join(','), ...texts.map((row) => row.map((value) => csvEscapeField(value ?? '')).join(','))].join('\r\n') + '\r\n'
  if (format === 'markdown') {
    const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
    return [columns.map((column) => escape(column.name)), columns.map(() => '---'), ...texts.map((row) => row.map((value) => escape(value ?? '')))].map((row) => '| ' + row.join(' | ') + ' |').join('\n') + '\n'
  }
  if (format === 'json') return JSON.stringify(rows.map((row) => Object.fromEntries(columns.map((column, index) => {
    const cell = complete(row[index]!)
    if (cell.kind === 'number') exactNumberLiteral(cell.value)
    return [column.name, cell.kind === 'number' || cell.kind === 'boolean' ? cell.value : textValue(cell)]
  }))), null, 2)
  if (tab.table?.kind !== 'table') throw new Error('INSERT 导出需要表来源')
  const dialect = wb.connections.value.find((connection) => connection.id === tab.connectionId)?.dialectId
  if (!['sqlite', 'postgresql', 'mysql'].includes(dialect ?? '')) throw new Error('当前方言不能安全生成 INSERT')
  const schema = inferSchemaFromObjectId(tab.table.id, dialect)
  const target = buildInsertTarget({ kind: 'table', name: tab.table.name, ...(schema ? { schema } : {}) }, dialect!)
  const names = columns.map((column) => quoteTransferIdentifier(column.name, dialect!)).join(', ')
  return rows.map((row) => `INSERT INTO ${target} (${names}) VALUES (${row.map((cell) => {
    complete(cell)
    if (cell.kind === 'blob') {
      const bytes = Uint8Array.from(atob(cell.previewBase64), (char) => char.charCodeAt(0))
      return parameterLiteral(bytes, dialect as 'sqlite' | 'postgresql' | 'mysql')
    }
    const value = cell.kind === 'null' ? null : cell.kind === 'text' ? cell.text : cell.value
    return parameterLiteral(value, dialect as 'sqlite' | 'postgresql' | 'mysql')
  }).join(', ')});`).join('\n') + '\n'
}
