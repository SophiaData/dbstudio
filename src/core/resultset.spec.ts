import { describe, expect, test } from 'vitest'

import { MAX_BLOB_PREVIEW_BYTES, MAX_CELL_TEXT_CHARS, cellValueToSqlParam } from './resultset'

describe('单元格值还原成 SQL 参数', () => {
  test('NULL 还原成 null，与空串严格区分', () => {
    expect(cellValueToSqlParam({ kind: 'null' })).toBeNull()
    expect(cellValueToSqlParam({ kind: 'text', text: '' })).toBe('')
  })

  test('数字与布尔原样透传，不做类型强制', () => {
    expect(cellValueToSqlParam({ kind: 'number', value: 42 })).toBe(42)
    expect(cellValueToSqlParam({ kind: 'number', value: -0.5 })).toBe(-0.5)
    expect(cellValueToSqlParam({ kind: 'boolean', value: false })).toBe(false)
    expect(cellValueToSqlParam({ kind: 'boolean', value: true })).toBe(true)
  })

  test('完整文本原样返回，包括换行与引号', () => {
    const text = "a'b\nc"
    expect(cellValueToSqlParam({ kind: 'text', text })).toBe(text)
    // truncated 显式为 false 与省略是同一语义：值完整。
    expect(cellValueToSqlParam({ kind: 'text', text: 'x', truncated: false })).toBe('x')
  })

  // 页面只持有前若干字符，回写会静默破坏原值，因此必须拒绝而不是尽力而为。
  test('被截断的文本拒绝回写并说明原因', () => {
    expect(() => cellValueToSqlParam({ kind: 'text', text: 'abc', truncated: true })).toThrow(/不能把被截断的文本写回数据库/)
  })

  test('被截断的二进制预览拒绝回写并说明原因', () => {
    expect(() =>
      cellValueToSqlParam({ kind: 'blob', previewBase64: 'AAAA', length: 1024, truncated: true })
    ).toThrow(/不能把被截断的二进制预览写回数据库/)
  })

  test('完整二进制按 base64 还原成字节', () => {
    const bytes = Uint8Array.from([0, 1, 2, 255])
    const base64 = Buffer.from(bytes).toString('base64')
    const restored = cellValueToSqlParam({ kind: 'blob', previewBase64: base64, length: bytes.length, truncated: false })
    expect(restored).toBeInstanceOf(Uint8Array)
    expect(Array.from(restored as Uint8Array)).toEqual([0, 1, 2, 255])
  })

  test('空二进制还原成空字节而不是 null', () => {
    const restored = cellValueToSqlParam({ kind: 'blob', previewBase64: '', length: 0, truncated: false })
    expect(restored).toBeInstanceOf(Uint8Array)
    expect((restored as Uint8Array).length).toBe(0)
  })

  // 未知 kind 说明上游契约被破坏；静默返回 undefined 会让写入变成「写了空值」。
  test('未知 kind 直接抛错，不静默降级', () => {
    expect(() => cellValueToSqlParam({ kind: 'unknown' } as never)).toThrow(/无法转换的单元格值/)
  })
})

describe('结果集上限常量', () => {
  // 这两个值决定「看到的是不是完整值」；改动会让截断判定与回写保护同时失效。
  test('文本与 BLOB 上限保持声明值', () => {
    expect(MAX_CELL_TEXT_CHARS).toBe(1000)
    expect(MAX_BLOB_PREVIEW_BYTES).toBe(256)
  })
})
