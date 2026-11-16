import { describe, expect, test } from 'vitest'

import { metadataAvailability } from './metadata'

describe('元数据可用性三态', () => {
  // undefined 表示驱动没提供该能力；空数组表示驱动提供了但这张表确实没有。
  // 把两者混成一种，UI 就无法区分「不支持」和「没有」。
  test('未提供与提供但为空是两种状态', () => {
    expect(metadataAvailability(undefined)).toBe('unavailable')
    expect(metadataAvailability([])).toBe('empty')
    expect(metadataAvailability(['x'])).toBe('present')
  })

  test('只要有一个元素就是 present', () => {
    expect(metadataAvailability([0])).toBe('present')
    expect(metadataAvailability([''])).toBe('present')
    expect(metadataAvailability([null])).toBe('present')
    expect(metadataAvailability([undefined])).toBe('present')
  })

  test('只按长度判定，不看元素内容', () => {
    expect(metadataAvailability(new Array(3).fill(undefined))).toBe('present')
    // 稀疏数组的长度同样决定结果，避免调用方用 holes 表达「没有数据」。
    expect(metadataAvailability(new Array(2))).toBe('present')
  })

  test('接收只读数组，调用方不必为了判态先复制一份', () => {
    const frozen: readonly number[] = Object.freeze([1, 2])
    expect(metadataAvailability(frozen)).toBe('present')
  })

  test('返回值是封闭的三态之一，不会出现第四种取值', () => {
    const samples: (readonly unknown[] | undefined)[] = [undefined, [], [1], [[]], ['a', 'b', 'c']]
    const seen = new Set(samples.map((value) => metadataAvailability(value)))
    for (const state of seen) expect(['unavailable', 'empty', 'present']).toContain(state)
    expect(seen.size).toBe(3)
  })
})
