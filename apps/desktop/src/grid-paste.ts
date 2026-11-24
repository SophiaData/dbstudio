import { createCsvRecordReader, type CsvRawField } from '../../../src/core/csv'
import type { ColumnDescription } from '../../../src/core/model'
import type { CellValue } from '../../../src/core/resultset'
import { inputCell } from './workbench'

const integerBits: Record<string, number> = { tinyint: 8, smallint: 16, mediumint: 24, int: 32, integer: 32, bigint: 64 }
const binaryType = /\b(?:binary|varbinary|tinyblob|blob|mediumblob|longblob|bit|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/i

export function parseGridPaste(text: string): readonly (readonly CsvRawField[])[] {
  if (text.length > 1024 * 1024) throw new Error('粘贴内容过大，请分批粘贴')
  const reader = createCsvRecordReader({ delimiter: '\t', hasHeader: false })
  const records = [...reader.push(text), ...reader.flush()]
  const width = records[0]?.fields.length
  return records.map((record) => {
    if (record.error) throw new Error('粘贴内容第 ' + record.line + ' 行第 ' + record.error.column + ' 列。' + record.error.message)
    if (record.fields.length !== width) throw new Error('粘贴内容第 ' + record.line + ' 行的列数不一致')
    return record.fields
  })
}

export function pastedMysqlCell(field: CsvRawField, column: ColumnDescription): CellValue {
  if (column.primaryKeyOrdinal != null || column.generated || column.hidden || column.identity || binaryType.test(column.typeName)) {
    throw new Error('此列不支持批量粘贴')
  }
  const raw = field.value
  if (!field.quoted && raw === '\\N') {
    if (!column.nullable) throw new Error('此列不允许 NULL')
    return { kind: 'null' }
  }
  const type = column.typeName.toLowerCase()
  const integer = /^(tinyint|smallint|mediumint|int|integer|bigint)\b/.exec(type)
  if (integer) {
    const text = raw.trim()
    if (!/^[+-]?\d+$/.test(text)) throw new Error('请输入整数')
    const digits = text.replace(/^[+-]?0*/, '')
    if (digits.length > 20) throw new Error('整数超出列的范围')
    const bits = integerBits[integer[1]!]!
    const unsigned = /\bunsigned\b/.test(type)
    const upper = 1n << BigInt(unsigned ? bits : bits - 1)
    const value = BigInt((text.startsWith('-') ? '-' : '') + (digits || '0'))
    if (value < (unsigned ? 0n : -upper) || value >= upper) throw new Error('整数超出列的范围')
    return inputCell(value.toString(), 'integer')
  }
  const decimal = /^(?:decimal|numeric)\((\d+),\s*(\d+)\)/.exec(type)
  if (decimal) {
    const text = raw.trim()
    const parts = /^[+-]?(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(text)
    if (!parts) throw new Error('请输入十进制数')
    const whole = (parts[1] ?? '').replace(/^0+/, '')
    const fraction = parts[2] ?? parts[3] ?? ''
    const precision = Number(decimal[1])
    const scale = Number(decimal[2])
    if (whole.length > precision - scale || fraction.length > scale || (/\bunsigned\b/.test(type) && text.startsWith('-'))) {
      throw new Error('小数超出列的精度或小数位数')
    }
    return { kind: 'text', text }
  }
  if (/^(float|double|real)\b/.test(type)) return inputCell(raw, 'number')
  const length = /^(?:char|varchar)\((\d+)\)/.exec(type)
  if (length && [...raw].length > Number(length[1])) throw new Error('文本超过列的最大长度')
  if (type === 'json') {
    try { JSON.parse(raw) } catch { throw new Error('请输入有效的 JSON') }
  }
  return { kind: 'text', text: raw }
}
