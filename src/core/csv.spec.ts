import { describe, expect, test } from 'vitest'

import {
  DEFAULT_CSV_DELIMITER,
  DEFAULT_CSV_NULL_TEXT,
  DEFAULT_CSV_SAMPLE_ROWS,
  MAX_CSV_ERRORS,
  MAX_CSV_SAMPLE_ROWS,
  csvCellFromRaw,
  csvCellKind,
  csvCellText,
  parseCsv,
  previewCsv
} from './csv'

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('CSV 常量', () => {
  // 这些值决定预览规模与错误上限，被改动会静默改变导入行为。
  test('保持声明值且采样上限不小于默认采样', () => {
    expect(DEFAULT_CSV_DELIMITER).toBe(',')
    expect(DEFAULT_CSV_NULL_TEXT).toBe('')
    expect(DEFAULT_CSV_SAMPLE_ROWS).toBe(50)
    expect(MAX_CSV_SAMPLE_ROWS).toBe(200)
    expect(MAX_CSV_ERRORS).toBe(100)
    expect(DEFAULT_CSV_SAMPLE_ROWS).toBeLessThanOrEqual(MAX_CSV_SAMPLE_ROWS)
  })
})

describe('原始字段转单元格', () => {
  test('未加引号的空字段是 NULL，加引号的空字段是空串', () => {
    // 这条区分是导入语义的核心：NULL 与空串写进数据库是不同的值。
    expect(csvCellKind(csvCellFromRaw({ value: '', quoted: false }))).toBe('null')
    expect(csvCellKind(csvCellFromRaw({ value: '', quoted: true }))).toBe('text')
  })

  test('非空字段转成文本并保留内容', () => {
    const cell = csvCellFromRaw({ value: 'abc', quoted: false })
    expect(csvCellKind(cell)).toBe('text')
    expect(csvCellText(cell)).toBe('abc')
  })

  test('自定义 nullText 时未加引号的完全匹配才当 NULL', () => {
    expect(csvCellKind(csvCellFromRaw({ value: 'NULL', quoted: false }, 'NULL'))).toBe('null')
    // 加了引号说明用户确实想写这段文本。
    expect(csvCellKind(csvCellFromRaw({ value: 'NULL', quoted: true }, 'NULL'))).toBe('text')
    expect(csvCellKind(csvCellFromRaw({ value: 'null', quoted: false }, 'NULL'))).toBe('text')
  })

  test('NULL 单元格取文本不会抛错', () => {
    expect(() => csvCellText(csvCellFromRaw({ value: '', quoted: false }))).not.toThrow()
  })
})

describe('CSV 解析', () => {
  test('解析成功时给出列、采样行与总行数', () => {
    const parsed = parseCsv(enc('a,b\n1,2\n3,4\n'))
    expect(parsed.ok).toBe(true)
    expect(parsed.columns.length).toBe(2)
    expect(parsed.sampleRows.length).toBe(2)
    expect(parsed.totalRows).toBe(2)
    expect(parsed.hasHeader).toBe(true)
    expect(parsed.delimiter).toBe(',')
  })

  test('带引号的字段可以包含分隔符与换行', () => {
    const parsed = parseCsv(enc('a,b\n"x,y","line1\nline2"\n'))
    const flat = JSON.stringify(parsed)
    expect(flat).toContain('x,y')
    expect(flat).toContain('line1')
  })

  test('字段内的双写引号被还原成一个引号', () => {
    const parsed = parseCsv(enc('a\n"it""s"\n'))
    expect(JSON.stringify(parsed)).toContain('it\\"s')
  })

  test('空输入不抛错', () => {
    expect(() => parseCsv(new Uint8Array())).not.toThrow()
  })

  test('自定义分隔符生效', () => {
    const parsed = parseCsv(enc('a;b\n1;2\n'), { delimiter: ';' })
    expect(parsed.delimiter).toBe(';')
    expect(parsed.columns.length).toBe(2)
  })

  test('关闭表头时首行也算数据', () => {
    const withHeader = parseCsv(enc('a,b\n1,2\n'))
    const withoutHeader = parseCsv(enc('a,b\n1,2\n'), { hasHeader: false })
    expect(withHeader.totalRows).toBe(1)
    expect(withoutHeader.totalRows).toBe(2)
    expect(withoutHeader.hasHeader).toBe(false)
  })

  // 列数不一致不能静默丢弃，否则用户会以为导入成功了。
  test('列数不一致的行被记成错误并带行号', () => {
    const parsed = parseCsv(enc('a,b\n1,2\n3\n'))
    expect(parsed.errors.length).toBeGreaterThan(0)
    expect(parsed.ok).toBe(false)
    expect(typeof parsed.errors[0]?.line).toBe('number')
  })

  test('错误数量有上限，畸形文件不会把内存撑爆', () => {
    const rows = ['a,b', ...Array.from({ length: MAX_CSV_ERRORS + 50 }, () => 'x')]
    const parsed = parseCsv(enc(rows.join('\n')))
    expect(parsed.errors.length).toBeLessThanOrEqual(MAX_CSV_ERRORS)
    // 总数仍要如实反映，即使明细被截断。
    expect(parsed.errorCount).toBeGreaterThan(parsed.errors.length)
  })
})

describe('CSV 预览', () => {
  test('只取默认采样行数', () => {
    const rows = ['a', ...Array.from({ length: DEFAULT_CSV_SAMPLE_ROWS + 30 }, (_, index) => `v${index}`)]
    const preview = previewCsv(enc(rows.join('\n')))
    expect(preview.sampleRows.length).toBeLessThanOrEqual(DEFAULT_CSV_SAMPLE_ROWS)
  })

  // 超出上限的采样数被拒绝而不是静默钳制：静默钳制会让调用方以为已经拿到了全部样本。
  test('采样行数超出上限时拒绝', () => {
    expect(() => previewCsv(enc('a\n1\n'), { sampleRowLimit: MAX_CSV_SAMPLE_ROWS + 1 })).toThrow(/样例行上限/) 
    expect(() => previewCsv(enc('a\n1\n'), { sampleRowLimit: 0 })).toThrow(/样例行上限/)
  })

  test('合法范围内的采样数生效', () => {
    const rows = ['a', ...Array.from({ length: 10 }, (_, index) => `v${index}`)]
    expect(previewCsv(enc(rows.join('\n')), { sampleRowLimit: 3 }).sampleRows.length).toBe(3)
  })

  test('预览推导出列定义', () => {
    expect(previewCsv(enc('id,name\n1,a\n')).columns.length).toBe(2)
  })

  test('空文件预览不抛错', () => {
    expect(() => previewCsv(new Uint8Array())).not.toThrow()
  })
})
