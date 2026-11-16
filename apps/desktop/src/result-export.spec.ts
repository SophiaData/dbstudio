import { describe, expect, test } from 'vitest'

import { complete, textValue } from './result-export'

describe('截断值保护', () => {
  // 页面只持有前若干字符，导出或复制会静默写出残缺数据。
  test('截断的文本与二进制被拒绝', () => {
    expect(() => complete({ kind: 'text', text: 'abc', truncated: true })).toThrow(/仍被截断/)
    expect(() =>
      complete({ kind: 'blob', previewBase64: 'AAAA', length: 1024, truncated: true })
    ).toThrow(/仍被截断/)
  })

  test('完整的值原样返回', () => {
    const cell = { kind: 'text', text: 'abc' } as const
    expect(complete(cell)).toBe(cell)
    expect(complete({ kind: 'null' })).toEqual({ kind: 'null' })
  })

  test('数字与布尔没有截断概念，不受影响', () => {
    expect(complete({ kind: 'number', value: 1 })).toEqual({ kind: 'number', value: 1 })
    expect(complete({ kind: 'boolean', value: true })).toEqual({ kind: 'boolean', value: true })
  })
})

describe('单元格转文本', () => {
  test('NULL 返回 null 而不是空串', () => {
    expect(textValue({ kind: 'null' })).toBeNull()
    // 空串是真实的空文本值，两者不能合并。
    expect(textValue({ kind: 'text', text: '' })).toBe('')
  })

  test('文本原样返回', () => {
    expect(textValue({ kind: 'text', text: 'a,b' })).toBe('a,b')
    expect(textValue({ kind: 'text', text: 'line1\nline2' })).toBe('line1\nline2')
  })

  // 数字走精确字面量：超安全范围的整数会抛错而不是输出被舍入的值。
  test('数字用精确字面量，非有限数与超安全整数被拒绝', () => {
    expect(textValue({ kind: 'number', value: 42 })).toBe('42')
    expect(textValue({ kind: 'number', value: -1.5 })).toBe('-1.5')
    expect(() => textValue({ kind: 'number', value: Number.NaN })).toThrow()
    expect(() => textValue({ kind: 'number', value: Number.MAX_SAFE_INTEGER + 2 })).toThrow()
  })

  test('布尔输出小写 true/false', () => {
    expect(textValue({ kind: 'boolean', value: true })).toBe('true')
    expect(textValue({ kind: 'boolean', value: false })).toBe('false')
  })

  test('二进制输出 0x 前缀的大写十六进制', () => {
    // base64 的 AAEC/w== 对应字节 00 01 02 FF。
    expect(textValue({ kind: 'blob', previewBase64: 'AAEC/w==', length: 4, truncated: false })).toBe('0x000102FF')
  })

  test('空二进制输出 0x', () => {
    expect(textValue({ kind: 'blob', previewBase64: '', length: 0, truncated: false })).toBe('0x')
  })

  test('截断值在转文本时同样被拒绝', () => {
    expect(() => textValue({ kind: 'text', text: 'abc', truncated: true })).toThrow(/仍被截断/)
  })
})
