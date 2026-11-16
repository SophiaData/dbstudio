import { describe, expect, test } from 'vitest'

import { LONG_VALUE_CHARS, describeCoverage, diffSchema, summarizeValue } from './compare'
import type { SchemaSnapshot } from './compare'

function emptySnapshot(): SchemaSnapshot {
  return { source: { kind: 'table', tableName: 't' } as never, tables: [], views: [], routines: [] }
}

describe('值摘要', () => {
  test('NULL 单独表示，不与字符串 "NULL" 混淆', () => {
    expect(summarizeValue(null)).toBe('NULL')
    expect(summarizeValue('NULL')).toBe('NULL')
  })

  // 短值必须原样返回：比较报告要能直接看到差异内容。
  test('不超过上限的值原样返回', () => {
    expect(summarizeValue('abc')).toBe('abc')
    expect(summarizeValue(42)).toBe('42')
    expect(summarizeValue(false)).toBe('false')
    expect(summarizeValue('')).toBe('')
    expect(summarizeValue('x'.repeat(LONG_VALUE_CHARS))).toBe('x'.repeat(LONG_VALUE_CHARS))
  })

  // 长值不塞进报告：哈希 + 长度足以判断是否相同，又不至于把报告撑爆。
  test('超长值折叠成长度与哈希摘要', () => {
    const long = 'x'.repeat(LONG_VALUE_CHARS + 1)
    const summary = summarizeValue(long)
    expect(summary).toMatch(/^<\d+ 字符, fnv1a:[0-9a-f]{8}>$/)
    expect(summary).toContain(String(LONG_VALUE_CHARS + 1))
  })

  test('同样内容得到同样摘要，不同内容得到不同摘要', () => {
    const a = 'y'.repeat(LONG_VALUE_CHARS + 10)
    const b = 'z'.repeat(LONG_VALUE_CHARS + 10)
    expect(summarizeValue(a)).toBe(summarizeValue(a))
    expect(summarizeValue(a)).not.toBe(summarizeValue(b))
  })

  test('长度相同内容不同也能区分', () => {
    const a = `${'a'.repeat(LONG_VALUE_CHARS)}1`
    const b = `${'a'.repeat(LONG_VALUE_CHARS)}2`
    expect(summarizeValue(a)).not.toBe(summarizeValue(b))
  })
})

describe('结构比较的输入校验', () => {
  test('不支持的方言直接拒绝', () => {
    expect(() => diffSchema(emptySnapshot(), emptySnapshot(), 'oracle' as never)).toThrow(/不支持的比较方言/)
  })

  // 两个空快照之间没有差异，这是比较的零值基准。
  test('两个空快照得到无变更结果', () => {
    const diff = diffSchema(emptySnapshot(), emptySnapshot(), 'sqlite')
    expect(diff.changes).toEqual([])
    expect(diff.destructive).toBe(false)
  })

  test('方言名称大小写敏感，非法值不会被当作默认方言', () => {
    expect(() => diffSchema(emptySnapshot(), emptySnapshot(), 'MySQL' as never)).toThrow()
  })
})

describe('覆盖范围描述', () => {
  test('空快照给出各项计数', () => {
    const text = describeCoverage(emptySnapshot(), emptySnapshot())
    expect(text).toContain('表 0 → 0')
    expect(text).toContain('视图 0 → 0')
    // 例程两边都为空时明确写「未提供」，而不是写 0 → 0 让人以为确实没有例程。
    expect(text).toContain('例程 未提供')
  })
})
