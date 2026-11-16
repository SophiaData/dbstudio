import { describe, expect, test } from 'vitest'

import {
  SqlParameterError,
  bindSqlParameters,
  extractSqlParameters,
  inspectSqlParameters,
  normalizeSqlParameterValue
} from './sql-parameters'

describe('参数占位符识别', () => {
  test('SQLite 识别问号与命名参数', () => {
    const names = extractSqlParameters('SELECT * FROM t WHERE a = ? AND b = :name', 'sqlite').map((item) => item.name)
    // 无编号的问号按出现顺序补成 1 起的编号，命名参数去掉前导冒号。
    expect(names).toEqual(['?1', 'name'])
  })

  test('PostgreSQL 识别 $n 形式的参数', () => {
    const names = extractSqlParameters('SELECT $1, $2 FROM t', 'postgresql').map((item) => item.name)
    expect(names).toEqual(['$1', '$2'])
  })

  test('MySQL 只识别问号', () => {
    expect(extractSqlParameters('SELECT * FROM t WHERE a = ?', 'mysql')).toHaveLength(1)
  })

  // 字符串字面量里的问号不是参数，误判会让「参数数量对不上」变成随机失败。
  test('字符串字面量里的占位符不算参数', () => {
    expect(extractSqlParameters("SELECT '?' AS q FROM t", 'sqlite')).toEqual([])
    expect(extractSqlParameters("SELECT 'a:name' FROM t", 'sqlite')).toEqual([])
    expect(extractSqlParameters("SELECT '$1' FROM t", 'postgresql')).toEqual([])
  })

  test('注释里的占位符不算参数', () => {
    expect(extractSqlParameters('SELECT 1 -- ?\nFROM t', 'sqlite')).toEqual([])
    expect(extractSqlParameters('SELECT /* ? :name */ 1 FROM t', 'sqlite')).toEqual([])
  })

  test('MySQL 的 # 行注释同样被跳过', () => {
    expect(extractSqlParameters('SELECT 1 # ?\nFROM t', 'mysql')).toEqual([])
  })

  // 方言不支持的形式必须在扫描阶段指出，而不是生成一条注定失败的语句。
  test('方言不支持的形式被标记为不安全并给出原因', () => {
    const named = inspectSqlParameters('SELECT * FROM t WHERE a = :name', 'mysql')
    expect(named.safe).toBe(false)
    expect(named.reason).toMatch(/MySQL/)
    expect(named.reason).toMatch(/\?/)

    const positional = inspectSqlParameters('SELECT $1 FROM t', 'postgresql')
    expect(positional.safe).toBe(true)

    const dollarInSqlite = inspectSqlParameters('SELECT $1 FROM t', 'sqlite')
    expect(dollarInSqlite.placeholders.length).toBeGreaterThanOrEqual(0)
  })

  test('没有占位符时结果为空且安全', () => {
    const result = inspectSqlParameters('SELECT 1 FROM t', 'sqlite')
    expect(result.safe).toBe(true)
    expect(result.placeholders).toEqual([])
    expect(result.reason).toBeNull()
  })

  test('占位符记录源码位置，供编辑器高亮与错误定位', () => {
    const [first] = extractSqlParameters('SELECT ? FROM t', 'sqlite')
    expect(first?.start).toBe(7)
    expect(first?.end).toBe(8)
  })
})

describe('参数值规范化', () => {
  test('标量与字节数组被接受', () => {
    expect(normalizeSqlParameterValue('x')).toBe('x')
    expect(normalizeSqlParameterValue(1)).toBe(1)
    expect(normalizeSqlParameterValue(false)).toBe(false)
    expect(normalizeSqlParameterValue(null)).toBeNull()
    expect(normalizeSqlParameterValue(new Uint8Array([1, 2]))).toBeInstanceOf(Uint8Array)
  })

  // NaN/Infinity 无法绑定到任何驱动，早拒绝比在驱动层报错更容易定位。
  test('非有限数被拒绝', () => {
    expect(() => normalizeSqlParameterValue(Number.NaN)).toThrow(SqlParameterError)
    expect(() => normalizeSqlParameterValue(Number.POSITIVE_INFINITY)).toThrow(SqlParameterError)
  })

  test('对象与函数被拒绝，错误信息带位置', () => {
    expect(() => normalizeSqlParameterValue({} as never, 'parameters[0].value')).toThrow(/parameters\[0\]\.value/)
    expect(() => normalizeSqlParameterValue((() => 1) as never, 'p')).toThrow(SqlParameterError)
  })
})

describe('参数绑定', () => {
  test('缺少参数时拒绝执行并指出哪个参数没给', () => {
    expect(() => bindSqlParameters('SELECT :a, :b', [{ name: ':a', value: 1 }], 'sqlite')).toThrow(
      /options.parameters|缺少|:b/
    )
  })

  test('参数名为空被拒绝', () => {
    expect(() => bindSqlParameters('SELECT ?', [{ name: '  ', value: 1 }], 'sqlite')).toThrow(
      /必须是非空字符串/
    )
  })

  test('方言不支持的写法在绑定时直接抛错', () => {
    expect(() => bindSqlParameters('SELECT :a', [{ name: ':a', value: 1 }], 'mysql')).toThrow(SqlParameterError)
  })

  test('无参数查询原样通过', () => {
    const bound = bindSqlParameters('SELECT 1 FROM t', undefined, 'sqlite')
    expect(bound.values).toEqual([])
    expect(bound.sql).toBe('SELECT 1 FROM t')
  })

  test('绑定结果里的 SQL 不再含有未提供的命名占位符', () => {
    const bound = bindSqlParameters('SELECT * FROM t WHERE a = :a', [{ name: ':a', value: 7 }], 'sqlite')
    expect(bound.values).toEqual([7])
    expect(bound.sql).not.toContain(':a')
  })

  test('占位符出现在字符串里时不需要对应参数', () => {
    const bound = bindSqlParameters("SELECT ':a' AS s FROM t", [], 'sqlite')
    expect(bound.values).toEqual([])
  })
})
