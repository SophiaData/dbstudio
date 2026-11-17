import { describe, expect, test } from 'vitest'

import type { CellValue } from './resultset'
import {
  DEFAULT_TRANSFER_BATCH_SIZE,
  MAX_TRANSFER_BATCH_SIZE,
  MIN_TRANSFER_BATCH_SIZE,
  buildInsertTarget,
  cellToJsonValue,
  cellToSqlLiteral,
  cellToTransferText,
  csvEscapeField,
  findTruncatedCell,
  normalizeTransferBatchSize,
  quoteTransferIdentifier
} from './transfer'

describe('批大小规范化', () => {
  test('未提供时用默认值', () => {
    expect(normalizeTransferBatchSize(undefined)).toBe(DEFAULT_TRANSFER_BATCH_SIZE)
  })

  test('上下界本身合法', () => {
    expect(normalizeTransferBatchSize(MIN_TRANSFER_BATCH_SIZE)).toBe(MIN_TRANSFER_BATCH_SIZE)
    expect(normalizeTransferBatchSize(MAX_TRANSFER_BATCH_SIZE)).toBe(MAX_TRANSFER_BATCH_SIZE)
  })

  test('越界被拒绝', () => {
    expect(() => normalizeTransferBatchSize(MIN_TRANSFER_BATCH_SIZE - 1)).toThrow(/批大小必须在/)
    expect(() => normalizeTransferBatchSize(MAX_TRANSFER_BATCH_SIZE + 1)).toThrow(/批大小必须在/)
  })

  // 小数与 NaN 会让分批边界算错，必须在入口拒绝。
  test('非整数与非有限数被拒绝', () => {
    expect(() => normalizeTransferBatchSize(1.5)).toThrow(/必须是整数/)
    expect(() => normalizeTransferBatchSize(Number.NaN)).toThrow(/必须是整数/)
    expect(() => normalizeTransferBatchSize(Number.POSITIVE_INFINITY)).toThrow(/必须是整数/)
  })

  test('常量关系自洽', () => {
    expect(MIN_TRANSFER_BATCH_SIZE).toBeLessThanOrEqual(DEFAULT_TRANSFER_BATCH_SIZE)
    expect(DEFAULT_TRANSFER_BATCH_SIZE).toBeLessThanOrEqual(MAX_TRANSFER_BATCH_SIZE)
  })
})

describe('单元格转 SQL 字面量', () => {
  test('缺失单元格与 NULL 都写成 NULL', () => {
    expect(cellToSqlLiteral(undefined, 'sqlite')).toBe('NULL')
    expect(cellToSqlLiteral({ kind: 'null' }, 'sqlite')).toBe('NULL')
  })

  test('数字原样输出', () => {
    expect(cellToSqlLiteral({ kind: 'number', value: 42 }, 'sqlite')).toBe('42')
    expect(cellToSqlLiteral({ kind: 'number', value: -1.5 }, 'sqlite')).toBe('-1.5')
  })

  // NaN/Infinity 不是合法 SQL 数字；静默写成 NULL 会改变语义。
  test('非有限数直接抛错而不是降级成 NULL', () => {
    expect(() => cellToSqlLiteral({ kind: 'number', value: Number.NaN }, 'sqlite')).toThrow(/非有限数值/)
    expect(() => cellToSqlLiteral({ kind: 'number', value: Number.POSITIVE_INFINITY }, 'sqlite')).toThrow(
      /非有限数值/
    )
  })

  // PostgreSQL 有真正的布尔类型，写 1/0 会被拒；SQLite/MySQL 只有 0/1。
  test('布尔按方言区分写法', () => {
    expect(cellToSqlLiteral({ kind: 'boolean', value: true }, 'postgresql')).toMatch(/^(true|TRUE)$/)
    expect(cellToSqlLiteral({ kind: 'boolean', value: false }, 'postgresql')).toMatch(/^(false|FALSE)$/)
    expect(cellToSqlLiteral({ kind: 'boolean', value: true }, 'sqlite')).toBe('1')
    expect(cellToSqlLiteral({ kind: 'boolean', value: false }, 'sqlite')).toBe('0')
  })

  test('文本里的单引号被双写，不会提前闭合', () => {
    expect(cellToSqlLiteral({ kind: 'text', text: "it's" }, 'sqlite')).toBe("'it''s'")
    expect(cellToSqlLiteral({ kind: 'text', text: '' }, 'sqlite')).toBe("''")
  })
})

describe('标识符引用', () => {
  test('MySQL 用反引号并双写内部反引号', () => {
    expect(quoteTransferIdentifier('a`b', 'mysql')).toBe('`a``b`')
  })

  test('SQLite 与 PostgreSQL 用双引号并双写内部引号', () => {
    expect(quoteTransferIdentifier('a"b', 'sqlite')).toBe('"a""b"')
    expect(quoteTransferIdentifier('a"b', 'postgresql')).toBe('"a""b"')
  })

  // 不认识的方言不能猜一套引用规则，否则生成的 SQL 可能注入或语法错。
  test('未知方言被拒绝而不是退回默认引号', () => {
    expect(() => quoteTransferIdentifier('a', 'oracle')).toThrow(/未知的方言/)
    expect(() => quoteTransferIdentifier('a', '')).toThrow(/未知的方言/)
  })
})

describe('INSERT 目标', () => {
  test('表名被引用', () => {
    expect(buildInsertTarget({ kind: 'table', name: 'items' } as never, 'sqlite')).toContain('items')
  })

  test('空表名被拒绝', () => {
    expect(() => buildInsertTarget({ kind: 'table', name: '   ' } as never, 'sqlite')).toThrow()
  })
})

describe('CSV 字段转义', () => {
  test('普通字段原样输出', () => {
    expect(csvEscapeField('abc')).toBe('abc')
    expect(csvEscapeField('')).toBe('')
  })

  test('含分隔符、引号或换行的字段被包裹并把引号双写', () => {
    expect(csvEscapeField('a,b')).toBe('"a,b"')
    expect(csvEscapeField('a"b')).toBe('"a""b"')
    expect(csvEscapeField('a\nb')).toBe('"a\nb"')
    expect(csvEscapeField('a\rb')).toBe('"a\rb"')
  })
})

describe('截断检测', () => {
  test('没有截断时返回 null', () => {
    expect(findTruncatedCell([[{ kind: 'text', text: 'a' }]], 0)).toBeNull()
    expect(findTruncatedCell([], 0)).toBeNull()
  })

  // 导出遇到截断值必须失败：写预览会静默破坏数据。
  test('发现截断时给出所在行列', () => {
    const rows: CellValue[][] = [
      [{ kind: 'text', text: 'ok' }],
      [{ kind: 'text', text: 'abc', truncated: true }]
    ]
    const hit = findTruncatedCell(rows, 100)
    expect(hit).not.toBeNull()
    expect(hit?.column).toBe(0)
    // 行号要带上偏移量，否则用户在大结果集里定位不到。
    expect(hit?.row).toBe(101)
  })

  test('行偏移为 0 时行号从 0 起算', () => {
    expect(findTruncatedCell([[{ kind: 'text', text: 'x', truncated: true }]], 0)?.row).toBe(0)
  })
})

describe('单元格转文本与 JSON', () => {
  // 返回 null 而不是空串：空串是一个真实的空文本值，与 NULL 不能合并。
  test('缺失与 NULL 都表示为 null', () => {
    expect(cellToTransferText(undefined)).toBeNull()
    expect(cellToTransferText({ kind: 'null' })).toBeNull()
    expect(cellToTransferText({ kind: 'text', text: '' })).toBe('')
  })

  test('JSON 里 NULL 是 null 而不是空串，两者不能混', () => {
    expect(cellToJsonValue(undefined)).toBeNull()
    expect(cellToJsonValue({ kind: 'null' })).toBeNull()
    expect(cellToJsonValue({ kind: 'text', text: '' })).toBe('')
  })

  test('数字与布尔在 JSON 里保留类型', () => {
    expect(cellToJsonValue({ kind: 'number', value: 7 })).toBe(7)
    expect(cellToJsonValue({ kind: 'boolean', value: true })).toBe(true)
  })
})
