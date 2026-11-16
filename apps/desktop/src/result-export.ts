import type { CellValue, ResultColumn } from '../../../src/core/resultset'
import { csvEscapeField, buildInsertTarget, quoteTransferIdentifier } from '../../../src/core/transfer'
import { inferSchemaFromObjectId } from '../../../src/core/er-relations'
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
/**
 * 依据目标表的列描述投影 INSERT 可写列，返回结果列下标，让列名与值同步过滤。
 *
 * 结果页的列只带展示类型，不带「这一列是否由数据库自动生成」的信息；把
 * generated / identity ALWAYS 列显式写进 INSERT 会被数据库拒绝。可写性以
 * `describeTable` 的描述为准：hidden、generated（virtual/stored）、
 * identity ALWAYS 一律排除；identity BY DEFAULT（如 MySQL AUTO_INCREMENT）
 * 与现有新增行表单、导入向导的口径一致，允许显式写值。
 *
 * 描述缺失、结果列无法唯一对应到目标列、或驱动没有提供生成列标记
 * （`generated === undefined`，无法确认是否可写）时一律拒绝生成——宁可
 * 报错，也不猜着拼一条可能被数据库拒绝的 INSERT。
 */
function insertProjection(tab: ResultTab, columns: readonly ResultColumn[]): { name: string; index: number }[] {
  const described = tab.description?.columns
  if (!described?.length) throw new Error('缺少目标表的列描述，无法确认生成列与自增列，已拒绝生成 INSERT')
  const projection: { name: string; index: number }[] = []
  columns.forEach((column, index) => {
    const matches = described.filter((candidate) => candidate.name === column.name)
    if (matches.length !== 1) throw new Error(`目标表列描述中无法唯一确定结果列「${column.name}」，已拒绝生成 INSERT`)
    const meta = matches[0]!
    if (meta.generated === undefined) throw new Error(`目标表列「${column.name}」缺少生成列标记，无法确认是否可写，已拒绝生成 INSERT`)
    if (meta.hidden || meta.generated !== null || meta.identity === 'always') return
    projection.push({ name: column.name, index })
  })
  if (!projection.length) throw new Error('结果中没有可写列，已拒绝生成 INSERT')
  return projection
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
  const projection = insertProjection(tab, columns)
  const names = projection.map(({ name }) => quoteTransferIdentifier(name, dialect!)).join(', ')
  return rows.map((row) => `INSERT INTO ${target} (${names}) VALUES (${projection.map(({ index }) => {
    const cell = row[index]!
    complete(cell)
    if (cell.kind === 'blob') {
      const bytes = Uint8Array.from(atob(cell.previewBase64), (char) => char.charCodeAt(0))
      return parameterLiteral(bytes, dialect as 'sqlite' | 'postgresql' | 'mysql')
    }
    const value = cell.kind === 'null' ? null : cell.kind === 'text' ? cell.text : cell.value
    return parameterLiteral(value, dialect as 'sqlite' | 'postgresql' | 'mysql')
  }).join(', ')});`).join('\n') + '\n'
}
