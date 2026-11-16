import { describe, expect, test } from 'vitest'

import {
  POSTGRESQL_SCRIPT_RULES,
  SQLITE_SCRIPT_RULES,
  SqlScriptParseError,
  splitStatements
} from './sql-script'

describe('SQL 脚本切分', () => {
  test('按分号切成独立语句，并给出每条的源位置', () => {
    const script = 'SELECT 1;\nSELECT 2;'
    const statements = splitStatements(script)
    expect(statements.map((item) => item.sql)).toEqual(['SELECT 1', 'SELECT 2'])
    expect(statements.map((item) => item.index)).toEqual([0, 1])
    expect(statements[0]?.startLine).toBe(1)
    expect(statements[1]?.startLine).toBe(2)
    // 偏移必须能切回原文，否则错误行号会指到别处。
    for (const item of statements) {
      expect(script.slice(item.startOffset, item.endOffset)).toBe(item.sql)
    }
  })

  test('末尾没有分号时最后一条仍然保留，空脚本返回空数组', () => {
    expect(splitStatements('SELECT 1').map((item) => item.sql)).toEqual(['SELECT 1'])
    expect(splitStatements('')).toEqual([])
    expect(splitStatements('   \n  ;;;  \n').map((item) => item.sql)).toEqual([])
  })

  test('字符串内的分号不是语句边界', () => {
    const statements = splitStatements("SELECT 'a;b' AS x; SELECT 2;")
    expect(statements.map((item) => item.sql)).toEqual(["SELECT 'a;b' AS x", 'SELECT 2'])
  })

  test('行注释与块注释内的分号不是语句边界', () => {
    const lineComment = splitStatements('SELECT 1 -- ; 注释里的分号\n; SELECT 2;')
    expect(lineComment.map((item) => item.sql)).toEqual(['SELECT 1 -- ; 注释里的分号', 'SELECT 2'])

    const blockComment = splitStatements('SELECT /* ; */ 1; SELECT 2;')
    expect(blockComment.map((item) => item.sql)).toEqual(['SELECT /* ; */ 1', 'SELECT 2'])
  })

  test('双写引号是转义而不是字符串结束', () => {
    const statements = splitStatements("SELECT 'it''s;ok' AS x; SELECT 2;")
    expect(statements.map((item) => item.sql)).toEqual(["SELECT 'it''s;ok' AS x", 'SELECT 2'])
  })

  test('SQLite 的反引号与方括号标识符内的分号不是边界', () => {
    const backtick = splitStatements('SELECT `a;b` FROM t; SELECT 2;')
    expect(backtick.map((item) => item.sql)).toEqual(['SELECT `a;b` FROM t', 'SELECT 2'])
    const bracket = splitStatements('SELECT [a;b] FROM t; SELECT 2;')
    expect(bracket.map((item) => item.sql)).toEqual(['SELECT [a;b] FROM t', 'SELECT 2'])
  })

  test('方言开关生效：方括号只在 SQLite 规则下是标识符', () => {
    // PostgreSQL 不认方括号，其中的分号应视为语句边界。
    const pg = splitStatements('SELECT [a;b] FROM t', POSTGRESQL_SCRIPT_RULES)
    expect(pg.length).toBe(2)
    const sqlite = splitStatements('SELECT [a;b] FROM t', SQLITE_SCRIPT_RULES)
    expect(sqlite.length).toBe(1)
  })

  test('PostgreSQL dollar quote 内的分号不是边界', () => {
    const statements = splitStatements('SELECT $$a;b$$; SELECT 2;', POSTGRESQL_SCRIPT_RULES)
    expect(statements.map((item) => item.sql)).toEqual(['SELECT $$a;b$$', 'SELECT 2'])
    const tagged = splitStatements('SELECT $tag$a;b$tag$; SELECT 2;', POSTGRESQL_SCRIPT_RULES)
    expect(tagged.map((item) => item.sql)).toEqual(['SELECT $tag$a;b$tag$', 'SELECT 2'])
  })

  test('PostgreSQL 嵌套块注释按层关闭', () => {
    const statements = splitStatements('SELECT /* a /* b */ ; */ 1; SELECT 2;', POSTGRESQL_SCRIPT_RULES)
    expect(statements.map((item) => item.sql)).toEqual(['SELECT /* a /* b */ ; */ 1', 'SELECT 2'])
  })

  test('PostgreSQL E 字符串里的反斜杠转义引号不结束字符串', () => {
    const statements = splitStatements("SELECT E'a\\';b' ; SELECT 2;", POSTGRESQL_SCRIPT_RULES)
    expect(statements.map((item) => item.sql)).toEqual(["SELECT E'a\\';b'", 'SELECT 2'])
  })

  test('SQLite 触发器 BEGIN...END 内的分号不拆分语句', () => {
    const script = 'CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET x = 1; END; SELECT 2;'
    const statements = splitStatements(script)
    expect(statements.length).toBe(2)
    expect(statements[0]?.sql).toContain('BEGIN')
    expect(statements[1]?.sql).toBe('SELECT 2')
  })

  test('未闭合的块注释与 dollar quote 抛出带行号的解析错误', () => {
    expect(() => splitStatements('SELECT 1 /* 未闭合')).toThrow(SqlScriptParseError)
    expect(() => splitStatements('SELECT 1 /* 未闭合')).toThrow(/未闭合的块注释/)
    expect(() => splitStatements('SELECT $$未闭合', POSTGRESQL_SCRIPT_RULES)).toThrow(/未闭合的 dollar quote/)
    // 行号必须指向真正出问题的那一行，而不是首行。
    expect(() => splitStatements('SELECT 1;\nSELECT 2 /* 未闭合')).toThrow(/第 2 行/)
  })

  test('非法入参在解析前就被拒绝', () => {
    expect(() => splitStatements(123 as unknown as string)).toThrow(TypeError)
    expect(() => splitStatements('SELECT 1', { ...SQLITE_SCRIPT_RULES, statementTerminators: [] })).toThrow(
      /至少需要一个语句终止符/
    )
  })

  // 解析状态属于单次调用。若上一次解析在中途留下标识符状态，下一次会把
  // 正常的双写转义当成结束引号，把一条语句错切成两条。
  test('一次解析留下的标识符状态不会污染下一次解析', () => {
    // 未闭合的方括号标识符会抛错，此时解析器内部状态必须随调用一起结束。
    expect(() => splitStatements('SELECT [a;b')).toThrow(SqlScriptParseError)
    const statements = splitStatements('SELECT `a``;b` FROM t; SELECT 2;')
    expect(statements.map((item) => item.sql)).toEqual(['SELECT `a``;b` FROM t', 'SELECT 2'])
  })
})
