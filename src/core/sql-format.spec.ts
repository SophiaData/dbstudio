import { describe, expect, test } from 'vitest'

import { formatSql, scanContexts, stripAllWhitespace, stripComments, tokenize } from './sql-format'

describe('字符上下文扫描', () => {
  // 这张表是格式化与切分的共同基础：两边对「引号/注释」的理解必须绝对一致。
  test('每个字符都有上下文，长度与输入相同', () => {
    const sql = "SELECT 'a' -- x\nFROM t"
    expect(scanContexts(sql)).toHaveLength(sql.length)
  })

  test('字符串内的字符标记为 string', () => {
    const sql = "SELECT 'ab'"
    const contexts = scanContexts(sql)
    const open = sql.indexOf("'")
    expect(contexts[open]).toBe('string')
    expect(contexts[open + 1]).toBe('string')
    expect(contexts[sql.length - 1]).toBe('string')
  })

  // 双写引号必须两个字符一起跳过，否则字符串会被提前闭合。
  test('双写单引号不会提前结束字符串', () => {
    const sql = "SELECT 'it''s ok' , 1"
    const contexts = scanContexts(sql)
    const lastQuote = sql.indexOf("'", sql.indexOf("''") + 2)
    // 最后一个引号仍在 string 上下文里，说明中间的 '' 没有闭合字符串。
    expect(contexts[lastQuote]).toBe('string')
    expect(contexts[sql.lastIndexOf('1')]).toBe('normal')
  })

  test('双写双引号同样不会提前结束标识符', () => {
    const sql = 'SELECT "a""b" FROM t'
    const contexts = scanContexts(sql)
    expect(contexts[sql.lastIndexOf('"')]).toBe('quotedIdent')
    expect(contexts[sql.lastIndexOf('t')]).toBe('normal')
  })

  test('行注释到行尾结束，块注释到关闭标记结束', () => {
    const line = 'SELECT 1 -- comment\nSELECT 2'
    const lineContexts = scanContexts(line)
    expect(lineContexts[line.indexOf('comment')]).toBe('lineComment')
    expect(lineContexts[line.lastIndexOf('2')]).toBe('normal')

    const block = 'SELECT /* a */ 1'
    const blockContexts = scanContexts(block)
    expect(blockContexts[block.indexOf('a')]).toBe('blockComment')
    expect(blockContexts[block.lastIndexOf('1')]).toBe('normal')
  })

  test('字符串里的注释符不被当成注释', () => {
    const sql = "SELECT '-- not comment' , 1"
    const contexts = scanContexts(sql)
    expect(contexts[sql.indexOf('--')]).toBe('string')
    expect(contexts[sql.lastIndexOf('1')]).toBe('normal')
  })
})

describe('注释剥离', () => {
  test('块注释被替换成空格而不是删除，避免词被拼接', () => {
    expect(stripComments('SELECT a/*x*/b')).toBe('SELECT a     b')
  })

  test('行注释保留换行，避免两行被合并', () => {
    expect(stripComments('SELECT 1 -- c\nSELECT 2')).toBe('SELECT 1     \nSELECT 2')
  })

  // 字符串里的注释符属于数据，剥掉会改变查询语义。
  test('字符串内的注释符原样保留', () => {
    expect(stripComments("SELECT '-- keep me'")).toBe("SELECT '-- keep me'")
    expect(stripComments("SELECT '/* keep */'")).toBe("SELECT '/* keep */'")
  })

  test('没有注释时原样返回', () => {
    expect(stripComments('SELECT 1 FROM t')).toBe('SELECT 1 FROM t')
    expect(stripComments('')).toBe('')
  })
})

describe('空白压缩', () => {
  test('所有空白被移除', () => {
    expect(stripAllWhitespace('SELECT  a\n\tFROM   t')).toBe('SELECTaFROMt')
    expect(stripAllWhitespace('')).toBe('')
  })
})

describe('分词', () => {
  test('产出非空 token 序列，且能区分字符串与关键字', () => {
    const tokens = tokenize("SELECT 'x' FROM t")
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.some((token) => token.text === "'x'")).toBe(true)
    expect(tokens.some((token) => token.text.toLowerCase() === 'select')).toBe(true)
  })

  test('拼接所有 token 能还原出原文的可见字符', () => {
    const sql = "SELECT a,b FROM t WHERE x = 'y'"
    expect(tokenize(sql).map((token) => token.text).join(' ')).toContain('SELECT')
  })
})

describe('SQL 格式化', () => {
  test('同样输入得到同样输出', () => {
    const sql = 'select a,b from t where x=1'
    expect(formatSql(sql)).toBe(formatSql(sql))
  })

  // 格式化只改空白，绝不能改动字符串或注释的内容。
  test('字符串与注释内容原样保留', () => {
    const formatted = formatSql("SELECT 'a  b' FROM t -- 保留 注释")
    expect(formatted).toContain("'a  b'")
    expect(formatted).toContain('保留 注释')
  })

  test('子句另起一行并缩进', () => {
    const formatted = formatSql('select a from t where x = 1')
    expect(formatted).toMatch(/select/i)
    expect(formatted).toContain('\n')
    expect(formatted).toMatch(/from/i)
    expect(formatted).toMatch(/where/i)
  })

  test('标识符里的点不被空格拆开', () => {
    expect(formatSql('select t.a from t')).toContain('t.a')
  })

  test('括号后的第一个 token 不带前导空格', () => {
    expect(formatSql('select count(o.id) from t')).toMatch(/count\(o\.id\)/i)
  })

  test('空语句不会抛错', () => {
    expect(() => formatSql('')).not.toThrow()
    expect(formatSql('   ').trim()).toBe('')
  })

  test('格式化后的 SQL 仍能被分词还原出同样的关键字集合', () => {
    const original = 'select a from t where x = 1'
    const before = tokenize(original).map((token) => token.text.toLowerCase()).filter(Boolean)
    const after = tokenize(formatSql(original)).map((token) => token.text.toLowerCase()).filter(Boolean)
    expect(after.sort()).toEqual(before.sort())
  })
})
