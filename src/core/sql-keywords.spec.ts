import { describe, expect, test } from 'vitest'

import {
  SQL_COMPLETION_KEYWORDS,
  SQL_FUNCTION_KEYWORDS,
  SQL_STATEMENT_KEYWORDS,
  isFunctionKeyword,
  isSqlKeyword,
  isStatementKeyword
} from './sql-keywords'

describe('SQL 关键字表', () => {
  test('匹配大小写不敏感，且能处理混写', () => {
    expect(isStatementKeyword('SELECT')).toBe(true)
    expect(isStatementKeyword('Select')).toBe(true)
    expect(isStatementKeyword('select')).toBe(true)
    expect(isFunctionKeyword('COUNT')).toBe(true)
    expect(isSqlKeyword('CoUnT')).toBe(true)
  })

  test('不是关键字时返回 false，不误判前缀或空值', () => {
    expect(isStatementKeyword('selects')).toBe(false)
    expect(isStatementKeyword('')).toBe(false)
    expect(isStatementKeyword(' ')).toBe(false)
    expect(isSqlKeyword('name')).toBe(false)
  })

  // 语句关键字与函数名分属两张表：混用会让高亮和补全语义错位。
  test('语句关键字与函数名互不越界', () => {
    expect(isStatementKeyword('count')).toBe(false)
    expect(isFunctionKeyword('select')).toBe(false)
    expect(isSqlKeyword('count')).toBe(true)
    expect(isSqlKeyword('select')).toBe(true)
  })

  // 手写集合容易重复，重复项会让补全列表出现两条相同候选。
  test('两张关键字表内部无重复项', () => {
    expect(new Set(SQL_STATEMENT_KEYWORDS).size).toBe(SQL_STATEMENT_KEYWORDS.length)
    expect(new Set(SQL_FUNCTION_KEYWORDS).size).toBe(SQL_FUNCTION_KEYWORDS.length)
  })

  test('补全全集是两张表的并集且已去重', () => {
    expect(SQL_COMPLETION_KEYWORDS.length).toBe(new Set(SQL_COMPLETION_KEYWORDS).size)
    for (const keyword of SQL_STATEMENT_KEYWORDS) expect(SQL_COMPLETION_KEYWORDS).toContain(keyword)
    for (const keyword of SQL_FUNCTION_KEYWORDS) expect(SQL_COMPLETION_KEYWORDS).toContain(keyword)
  })

  test('全部以小写存储，避免匹配规则分散到多处', () => {
    for (const keyword of SQL_COMPLETION_KEYWORDS) {
      expect(keyword).toBe(keyword.toLowerCase())
      expect(keyword.trim()).toBe(keyword)
    }
  })
})
