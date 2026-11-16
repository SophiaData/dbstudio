import { describe, expect, test } from 'vitest'

import { SQLITE_SCRIPT_RULES } from '@core/sql-script'
import {
  currentSql,
  exactNumberLiteral,
  parseNumericCell,
  parseParameterValue,
  parameterLiteral
} from './sql-editor-model'

const rules = SQLITE_SCRIPT_RULES

describe('取当前要执行的 SQL', () => {
  // 有选区就执行选区，这是用户明确表达的意图。
  test('有非空选区时执行选区内容', () => {
    const sql = 'SELECT 1;\nSELECT 2;'
    // 选区原样返回（含分号），不替用户重写选中的内容。
    expect(currentSql(sql, 0, 9, rules)).toBe('SELECT 1;')
    expect(currentSql(sql, 10, 19, rules)).toBe('SELECT 2;')
  })

  test('选区只有空白时退回按光标定位', () => {
    const sql = 'SELECT 1;\nSELECT 2;'
    expect(currentSql(sql, 9, 10, rules)).toBe('SELECT 1')
  })

  test('没有选区时执行光标所在的那条语句', () => {
    const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;'
    // 光标落在第二条语句中间。
    expect(currentSql(sql, 12, 12, rules)).toBe('SELECT 2')
  })

  test('光标在末尾时执行最后一条语句', () => {
    const sql = 'SELECT 1;\nSELECT 2;'
    expect(currentSql(sql, sql.length, sql.length, rules)).toBe('SELECT 2')
  })

  test('单条语句时总是返回它', () => {
    expect(currentSql('SELECT 42', 3, 3, rules)).toBe('SELECT 42')
  })

  test('空脚本返回空串而不是抛错', () => {
    expect(currentSql('', 0, 0, rules)).toBe('')
    expect(currentSql('   \n  ', 0, 0, rules)).toBe('')
  })
})

describe('数字单元格解析', () => {
  test('合法数字得到 number', () => {
    expect(parseNumericCell('42')).toEqual({ kind: 'number', value: 42 })
    expect(parseNumericCell('-1.5')).toEqual({ kind: 'number', value: -1.5 })
    expect(parseNumericCell('  7  ')).toEqual({ kind: 'number', value: 7 })
  })

  test('非数字被拒绝并提示 NULL 要用独立选项', () => {
    for (const raw of ['', 'abc', '12abc', '--1']) {
      expect(() => parseNumericCell(raw), raw).toThrow(/请输入有效数字/)
    }
  })

  // 超出安全整数范围的整数转 number 会静默丢精度，保留原文更安全。
  test('超安全范围的整数降级成文本而不是丢精度', () => {
    const big = '9007199254740993'
    expect(parseNumericCell(big)).toEqual({ kind: 'text', text: big })
  })

  test('超安全范围的小数直接拒绝，因为小数部分也会被舍入', () => {
    expect(() => parseNumericCell('9007199254740993.5')).toThrow(/超出安全整数范围/)
  })

  test('安全范围内的整数边界值仍是 number', () => {
    expect(parseNumericCell(String(Number.MAX_SAFE_INTEGER))).toEqual({
      kind: 'number',
      value: Number.MAX_SAFE_INTEGER
    })
  })
})

describe('精确数字字面量', () => {
  test('有限数转字符串', () => {
    expect(exactNumberLiteral(42)).toBe('42')
    expect(exactNumberLiteral(-1.5)).toBe('-1.5')
  })

  // 已舍入的 number 无法还原原始值，生成字面量会把错误写进库。
  test('非有限数与超安全整数被拒绝', () => {
    expect(() => exactNumberLiteral(Number.NaN)).toThrow(/非有限数/)
    expect(() => exactNumberLiteral(Number.POSITIVE_INFINITY)).toThrow(/非有限数/)
    expect(() => exactNumberLiteral(Number.MAX_SAFE_INTEGER + 2)).toThrow(/超出安全整数范围/)
  })
})

describe('参数转 SQL 字面量', () => {
  test('null 写成 NULL', () => {
    expect(parameterLiteral(null, 'sqlite')).toBe('NULL')
  })

  test('数字走精确字面量，非有限数与超安全整数被拒绝', () => {
    expect(parameterLiteral(7, 'sqlite')).toBe('7')
    expect(() => parameterLiteral(Number.NaN, 'sqlite')).toThrow()
  })

  // PostgreSQL 有真布尔类型，写 1/0 会被拒。
  test('布尔按方言区分', () => {
    expect(parameterLiteral(true, 'postgresql')).toBe('TRUE')
    expect(parameterLiteral(false, 'postgresql')).toBe('FALSE')
    expect(parameterLiteral(true, 'sqlite')).toBe('1')
    expect(parameterLiteral(false, 'mysql')).toBe('0')
  })

  // MySQL 的字符串转义受 NO_BACKSLASH_ESCAPES 影响，用十六进制最稳。
  test('MySQL 字符串用 CONVERT(X ... USING utf8mb4) 避开反斜杠模式差异', () => {
    expect(parameterLiteral("it's", 'mysql')).toBe("CONVERT(X'69742773' USING utf8mb4)")
    // 反斜杠与换行也必须原样编码，不能依赖转义序列。
    const literal = parameterLiteral('a\\b', 'mysql')
    expect(literal).toMatch(/^CONVERT\(X'[0-9a-f]+' USING utf8mb4\)$/)
  })

  test('PostgreSQL 用 E 前缀明确转义语义，SQLite 用双写单引号', () => {
    // E'' 不依赖 standard_conforming_strings 开关，跨会话行为一致。
    expect(parameterLiteral("it's", 'postgresql')).toBe("E'it''s'")
    expect(parameterLiteral("it's", 'sqlite')).toBe("'it''s'")
  })

  test('含 NUL 的文本被拒绝而不是截断', () => {
    expect(() => parameterLiteral('a\0b', 'postgresql')).toThrow(/NUL/)
  })

  test('二进制参数转成十六进制字面量', () => {
    const literal = parameterLiteral(Uint8Array.from([0, 1, 255]), 'sqlite')
    expect(literal.toUpperCase()).toContain('0001FF')
  })
})

describe('参数字面值解析', () => {
  test('null 类型得到 null', () => {
    expect(parseParameterValue('', 'null')).toBeNull()
  })

  test('二进制需要偶数位十六进制', () => {
    expect(parseParameterValue('00ff', 'binary')).toBeInstanceOf(Uint8Array)
    expect(() => parseParameterValue('abc', 'binary')).toThrow(/偶数位十六进制/)
    expect(() => parseParameterValue('zz', 'binary')).toThrow(/偶数位十六进制/)
  })

  test('十六进制按字节还原', () => {
    expect(Array.from(parseParameterValue('00FF', 'binary') as Uint8Array)).toEqual([0, 255])
  })
})
