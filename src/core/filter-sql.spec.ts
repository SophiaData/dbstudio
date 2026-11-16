import { describe, expect, test } from 'vitest'

import { FilterError, buildFilteredSql, buildWhere, describeFilterError, parseFilter, toSqlLiteral } from './filter-sql'

const quote = (name: string): string => `"${name}"`

describe('筛选值转 SQL 字面量', () => {
  test('空值与空串都得到空字符串字面量', () => {
    expect(toSqlLiteral('')).toBe("''")
    expect(toSqlLiteral('   ')).toBe("''")
  })

  test('已用单引号包裹的值原样保留', () => {
    expect(toSqlLiteral("'active'")).toBe("'active'")
    // 内部的成对转义是合法的。
    expect(toSqlLiteral("'it''s'")).toBe("'it''s'")
  })

  // 单个未配对引号能闭合字符串并拼接后续语句，必须拒绝。
  test('未配对的单引号被拒绝，不允许借此闭合后注入', () => {
    expect(() => toSqlLiteral("'a' OR '1'='1")).toThrow(FilterError)
    expect(() => toSqlLiteral("'abc")).toThrow(FilterError)
    expect(() => toSqlLiteral("it's")).toThrow(FilterError)
  })

  test('NULL 与布尔转成 SQL 形式', () => {
    expect(toSqlLiteral('NULL')).toBe('NULL')
    expect(toSqlLiteral('null')).toBe('NULL')
    expect(toSqlLiteral('true')).toBe('1')
    expect(toSqlLiteral('FALSE')).toBe('0')
  })

  test('整数、小数、负数与科学计数按数字处理，不加引号', () => {
    expect(toSqlLiteral('42')).toBe('42')
    expect(toSqlLiteral('-7')).toBe('-7')
    expect(toSqlLiteral('3.14')).toBe('3.14')
    expect(toSqlLiteral('1e10')).toBe('1e10')
    expect(toSqlLiteral('1.5E-3')).toBe('1.5E-3')
  })

  test('裸词加引号当作字符串', () => {
    expect(toSqlLiteral('active')).toBe("'active'")
    expect(toSqlLiteral('hello world')).toBe("'hello world'")
  })

  test('不是合法数字的形似数字也被拒绝或加引号，不原样拼进 SQL', () => {
    // `1;2` 含分隔符，必须变成字符串而不是可执行片段。
    expect(toSqlLiteral('1;2')).toBe("'1;2'")
    expect(toSqlLiteral('1 AND 2')).toBe("'1 AND 2'")
  })
})

describe('筛选文本解析', () => {
  test('空文本得到零条件且解析成功', () => {
    expect(parseFilter('', quote)).toEqual({ ok: true, conditions: [] })
    expect(parseFilter('   ', quote)).toEqual({ ok: true, conditions: [] })
  })

  test('单个等值条件解析出列、操作符与字面量', () => {
    const result = parseFilter("status = 'active'", quote)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conditions).toHaveLength(1)
    expect(result.conditions[0]?.column).toBe('status')
    expect(result.conditions[0]?.operator).toBe('=')
    expect(result.conditions[0]?.valueSql).toBe("'active'")
  })

  test('AND 连接多个条件，大小写不敏感', () => {
    const result = parseFilter('age > 18 and name = bob', quote)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conditions).toHaveLength(2)
    expect(result.conditions.map((item) => item.column)).toEqual(['age', 'name'])
  })

  test('多字符操作符不会被拆成单字符', () => {
    const cases: [string, string][] = [
      ['a >= 1', '>='],
      ['a <= 1', '<='],
      ['a != 1', '!='],
      ['a <> 1', '<>'],
      ['a > 1', '>'],
      ['a < 1', '<']
    ]
    for (const [text, expected] of cases) {
      const result = parseFilter(text, quote)
      expect(result.ok, text).toBe(true)
      if (!result.ok) continue
      expect(result.conditions[0]?.operator, text).toBe(expected)
    }
  })

  test('IS NULL 与 IS NOT NULL 不带值', () => {
    for (const operator of ['IS NULL', 'IS NOT NULL']) {
      const result = parseFilter(`deleted_at ${operator}`, quote)
      expect(result.ok, operator).toBe(true)
      if (!result.ok) continue
      expect(result.conditions[0]?.operator).toBe(operator)
    }
  })

  test('缺列名时报错', () => {
    const result = parseFilter('= 1', quote)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/缺列名|列名不合法|无法识别的条件/)
  })

  test('空条件（多余的 AND 一侧）被拒绝', () => {
    const result = parseFilter('age > 1 AND ', quote)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/空的筛选条件|缺列名|列名不合法/)
  })

  // 列名会直接拼进 SQL，必须按白名单校验；引号与括号是注入面。
  test('含引号、分号、括号的列名被拒绝', () => {
    for (const text of ['a"b = 1', 'a;b = 1', 'a(b = 1', 'x y = 1']) {
      const result = parseFilter(text, quote)
      expect(result.ok, text).toBe(false)
    }
  })

  test('允许点号表示限定列名', () => {
    const result = parseFilter('t.status = 1', quote)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conditions[0]?.column).toBe('t.status')
  })
})

describe('WHERE 子句构造', () => {
  test('没有条件时不产生 WHERE', () => {
    expect(buildWhere([], quote)).toBe('')
  })

  test('单个条件与多个条件用 AND 连接', () => {
    expect(buildWhere([{ column: 'a', operator: '=', valueSql: '1' }], quote)).toBe(' WHERE "a" = 1')
    expect(
      buildWhere(
        [
          { column: 'a', operator: '=', valueSql: '1' },
          { column: 'b', operator: '>', valueSql: '2' }
        ],
        quote
      )
    ).toBe(' WHERE "a" = 1 AND "b" > 2')
  })

  test('IS NULL 条件不拼接值', () => {
    expect(buildWhere([{ column: 'a', operator: 'IS NULL', valueSql: '' }], quote)).toBe(' WHERE "a" IS NULL')
  })

  // 列名在拼接前必须经过方言引用函数，否则同一份条件在不同方言上会拼错。
  test('列名统一经过引用函数', () => {
    const backtick = (name: string): string => `\`${name}\``
    expect(buildWhere([{ column: 'a', operator: '=', valueSql: '1' }], backtick)).toBe(' WHERE `a` = 1')
  })
})

describe('带筛选的完整 SQL', () => {
  test('表来源生成 SELECT * FROM 表并附加 WHERE', () => {
    const sql = buildFilteredSql(
      { sourceKind: 'table', tableName: 'items' },
      [{ column: 'a', operator: '=', valueSql: '1' }],
      quote
    )
    expect(sql).toContain('"items"')
    expect(sql).toContain(' WHERE "a" = 1')
  })

  test('表来源无筛选时不受影响', () => {
    const sql = buildFilteredSql({ sourceKind: 'table', tableName: 'items' }, [], quote)
    expect(sql).not.toContain('WHERE')
  })

  // SQL 来源必须包成子查询，否则 WHERE 会作用到错误层级。
  test('SQL 来源把原查询包成子查询后再筛选', () => {
    const sql = buildFilteredSql(
      { sourceKind: 'sql', sql: 'SELECT * FROM items' },
      [{ column: 'a', operator: '=', valueSql: '1' }],
      quote
    )
    expect(sql).toMatch(/SELECT \* FROM \(/i)
    expect(sql).toContain(' WHERE "a" = 1')
  })
})

describe('筛选错误转成人话', () => {
  test('错误信息带上统一前缀，便于界面识别', () => {
    expect(describeFilterError('缺列名：= 1')).toBe('筛选条件有误：缺列名：= 1')
  })
})
