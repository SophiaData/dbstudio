import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

// Transpile the actual modules in memory; no bundles, database, or cleanup scripts.
const cache = new Map()
function load(relativePath) {
  const filename = resolve(import.meta.dirname, '..', relativePath)
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }
  cache.set(filename, module)
  const nativeRequire = createRequire(filename)
  const require = (specifier) => specifier.startsWith('.')
    ? load(resolve(dirname(filename), `${specifier}.ts`))
    : nativeRequire(specifier)
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  runInThisContext(`(function(require, module, exports) {${outputText}\n})`, { filename })(require, module, module.exports)
  return module.exports
}
const { formatSql } = load('src/core/sql-format.ts')
const { inspectSqlParameters: inspect, bindSqlParameters: bind } = load('src/core/sql-parameters.ts')
const { splitStatements, SQLITE_SCRIPT_RULES, POSTGRESQL_SCRIPT_RULES, SqlScriptParseError } = load('src/core/sql-script.ts')
const { splitStatements: splitForEditor, splitScriptStatements } = load('src/core/sql-format.ts')
const { MYSQL_SCRIPT_RULES } = load('src/drivers/mysql/dialect.ts')

function semantics(sql, dialect) {
  const result = inspect(sql, dialect)
  return { safe: result.safe, reason: result.reason,
    placeholders: result.placeholders.map(({ name, kind }) => ({ name, kind })) }
}
function preservesBinding(sql, dialect, parameters, expectedNames, expectedValues) {
  const formatted = formatSql(sql)
  const before = semantics(sql, dialect)
  assert.equal(before.safe, true)
  assert.deepEqual(before.placeholders.map(({ name }) => name), expectedNames)
  assert.deepEqual(semantics(formatted, dialect), before, `${sql} -> ${formatted}`)
  const originalBinding = bind(sql, parameters, dialect)
  const formattedBinding = bind(formatted, parameters, dialect)
  assert.deepEqual(originalBinding.values, expectedValues)
  assert.deepEqual(formattedBinding.values, originalBinding.values)
  assert.deepEqual(semantics(formattedBinding.sql, dialect), semantics(originalBinding.sql, dialect))
  assert.equal(formatSql(formatted), formatted)
  return formatted
}

test('PostgreSQL $1 survives formatting and binds the same value', () => {
  assert.equal(preservesBinding('SELECT $1', 'postgresql', [{ name: '$1', value: 17 }], ['$1'], [17]), 'SELECT $1')
})

test('PostgreSQL $12, repeated positions, casts and quoted lookalikes keep bindings', () => {
  const names = Array.from({ length: 12 }, (_, i) => `$${i + 1}`)
  const values = Array.from({ length: 12 }, (_, i) => i + 101)
  const sql = `SELECT ${names.join(', ')}, $12::int, $1::text, '$1 $12 :name ?' /* $12 :name ? */ -- $1 ?\nFROM items`
  const formatted = preservesBinding(sql, 'postgresql', names.map((name, i) => ({ name, value: values[i] })), [...names, '$12', '$1'], values)
  assert.match(formatted, /\$12\s*::\s*int/i)
  assert.match(formatted, /\$1\s*::\s*text/i)
  for (const text of ["'$1 $12 :name ?'", '/* $12 :name ? */', '-- $1 ?']) assert.ok(formatted.includes(text))
})

test('SQLite named parameters retain spelling, Unicode, repetition and binding order', () => {
  preservesBinding("SELECT :name, :select, :名字, :name, ':name @name $name ?', \"同名:name\" /* :name ? */ -- :name ?\nFROM items", 'sqlite', [
    { name: 'name', value: 'bound' }, { name: 'select', value: 23 }, { name: '名字', value: true }
  ], ['name', 'select', '名字', 'name'], ['bound', 23, true, 'bound'])
})

test('SQLite @name and $name stay intact and retain the actual parser rejection', () => {
  for (const name of ['@name', '$name', '@select', '$select']) {
    const sql = `SELECT ${name}`
    const formatted = formatSql(sql)
    assert.equal(formatted, sql)
    assert.equal(inspect(sql, 'sqlite').safe, false)
    assert.deepEqual(semantics(formatted, 'sqlite'), semantics(sql, 'sqlite'))
    for (const input of [sql, formatted]) assert.throws(() => bind(input, [], 'sqlite'), /不支持/)
  }
})

test('MySQL question marks retain ordering and ignore same names in strings and comments', () => {
  preservesBinding("SELECT ?, '? :name $1', ?, 'it''s ?' /* ? :name $1 */ -- ? $1\nFROM items", 'mysql', [
    { name: '?1', value: null }, { name: '?2', value: 'second' }
  ], ['?1', '?2'], [null, 'second'])
})

test('PG casts remain operators rather than named parameters', () => {
  preservesBinding("SELECT 1::int, 'value'::text, (2)::numeric", 'postgresql', [], [], [])
})

test('String, quoted identifier and comment contents retain trailing and multiline whitespace', () => {
  const protectedText = ["'first  \nsecond\t \n:name $1 ?'", '"quoted  \nidentifier"', '/* block  \n:name $1 ?\t \n*/', '-- :name $1 ?  \t']
  const sql = `SELECT :name, ${protectedText.slice(0, 3).join(', ')} ${protectedText[3]}\nFROM items`
  const formatted = preservesBinding(sql, 'sqlite', [{ name: 'name', value: 9 }], ['name'], [9])
  for (const text of protectedText) assert.ok(formatted.includes(text), `Protected text changed: ${JSON.stringify(text)}`)
})

test('Existing keyword, clause and comma formatting remains stable', () => {
  assert.equal(formatSql('select a,b from items where id >= 1 order by a'), 'SELECT a,\n  b\n  FROM items\n  WHERE id >= 1\n  ORDER BY a')
})

function assertStatements(sql, rules, expected) {
  let cursor = 0
  const located = expected.map((text, index) => {
    const startOffset = sql.indexOf(text, cursor)
    assert.notEqual(startOffset, -1)
    const endOffset = startOffset + text.length
    cursor = endOffset
    return { index, sql: text, startOffset, endOffset,
      startLine: sql.slice(0, startOffset).split('\n').length,
      endLine: sql.slice(0, endOffset - 1).split('\n').length }
  })
  assert.deepEqual(splitStatements(sql, rules), located)
  assert.deepEqual(splitScriptStatements(sql, rules), located)
  assert.deepEqual(splitForEditor(sql, rules), expected)
}

// parse error.offset 指向未闭合构造的起点（执行器据此定位出错语句），
// 而不是 EOF。测试按各自构造的起点断言。
function assertUnclosed(sql, rules, startOffset) {
  assert.throws(() => splitStatements(sql, rules), (error) => {
    assert.ok(error instanceof SqlScriptParseError)
    assert.match(error.message, /未闭合/)
    assert.equal(error.offset, sql.indexOf(startOffset))
    assert.equal(error.line, sql.slice(0, error.offset).split('\n').length)
    return true
  })
}

for (const identifier of ['`semi;colon`', '[semi;colon]', '`escaped``;quote`', '[first\n;second]']) {
  test(`SQLite identifier ${JSON.stringify(identifier)} keeps boundaries and source positions`, () => {
    const first = `SELECT ${identifier} FROM items`
    const second = `SELECT ${identifier}, 'tail;value'`
    assertStatements(`\r\n ${first};\r\n\r\n ${second}; SELECT 3;`, SQLITE_SCRIPT_RULES, [first, second, 'SELECT 3'])
  })
}

test('SQLite brackets close at the first ] and backticks escape only with doubled backticks', () => {
  assertStatements('SELECT [a]]; SELECT 2;', SQLITE_SCRIPT_RULES, ['SELECT [a]]', 'SELECT 2'])
  assertStatements('SELECT `a``;b`; SELECT 2;', SQLITE_SCRIPT_RULES, ['SELECT `a``;b`', 'SELECT 2'])
  assertUnclosed('SELECT 1;\nSELECT `a``;', SQLITE_SCRIPT_RULES, '`a``;')
})

test('SQLite trigger CASE END does not close its BEGIN block or leak into later statements', () => {
  const trigger = [
    'CREATE TEMP TRIGGER audit AFTER INSERT ON items',
    'WHEN CASE WHEN new.id > 0 THEN 1 ELSE 0 END',
    'BEGIN',
    '  INSERT INTO log VALUES (CASE WHEN new.id > 1 THEN CASE WHEN new.id > 2 THEN 3 ELSE 2 END ELSE 1 END);',
    '  UPDATE items SET value = CASE WHEN id > 0 THEN \'END; BEGIN\' ELSE \'CASE\' END;',
    '  /* END; CASE */ INSERT INTO log VALUES (\'tail;value\');',
    'END'
  ].join('\n')
  assertStatements(`SELECT 0;\n${trigger};\n${trigger};\nSELECT CASE WHEN 1 THEN 2 END;`, SQLITE_SCRIPT_RULES,
    ['SELECT 0', trigger, trigger, 'SELECT CASE WHEN 1 THEN 2 END'])
})

for (const prefix of ['E', 'e']) {
  test(`PostgreSQL ${prefix} string escapes quotes, backslashes and semicolons across statements`, () => {
    const escaped = String.raw`SELECT ${prefix}'one\';two\\', 'ordinary'';quote'`
    const multiline = `SELECT ${prefix}'first\nsecond;line'`
    assertStatements(`\n${escaped};\n${multiline};\nSELECT 3;`, POSTGRESQL_SCRIPT_RULES, [escaped, multiline, 'SELECT 3'])
  })
}

test('PostgreSQL E prefix is a complete token and ordinary strings do not use backslash escapes', () => {
  for (const first of [String.raw`SELECT 'one\'`, String.raw`SELECT someE'one\'`, String.raw`SELECT "E"'one\'`, String.raw`SELECT E /* gap */ 'one\'`]) {
    assertStatements(`${first}; SELECT 2;`, POSTGRESQL_SCRIPT_RULES, [first, 'SELECT 2'])
  }
  assertUnclosed(String.raw`SELECT 1;` + '\n' + String.raw`SELECT E'one\';still open;`, POSTGRESQL_SCRIPT_RULES, String.raw`E'one\';still open;`)
})

test('PostgreSQL nested comments protect all internal terminators and quotes', () => {
  const commented = `/* outer;\n /* inner; ' \" $$ */\n still outer; /* deeper /* ; */ ; */ */ SELECT 2`
  assertStatements(`SELECT 1;\n${commented};\n/* tail /* nested; */ */`, POSTGRESQL_SCRIPT_RULES, ['SELECT 1', commented])
  assertUnclosed('SELECT 1;\n/* outer\n/* inner */ SELECT 2;', POSTGRESQL_SCRIPT_RULES, '/* outer\n')
})

test('Unclosed SQLite identifiers and PostgreSQL escapes report the construct start offset and line', () => {
  for (const text of ['`open;\nname', '[open;\nname']) assertUnclosed(`SELECT 1;\nSELECT ${text}`, SQLITE_SCRIPT_RULES, text)
  for (const text of [String.raw`E'open\'`, "e'open\\"]) assertUnclosed(`SELECT 1;\nSELECT ${text}`, POSTGRESQL_SCRIPT_RULES, text)
})

test('Dialect extensions remain opt-in and existing rule objects retain their contract', () => {
  const legacyRules = { lineCommentPrefixes: ['--'], blockComment: { start: '/*', end: '*/' },
    supportsDollarQuotedStrings: false, supportsBeginEndBlocks: true, statementTerminators: [';'] }
  for (const rules of [legacyRules, MYSQL_SCRIPT_RULES]) {
    assertStatements('SELECT 1;\nSELECT \'a;b\'; -- tail;\n', rules, ['SELECT 1', "SELECT 'a;b'"])
    assertStatements('SELECT `a;b`; SELECT 2;', rules, ['SELECT `a', 'b`', 'SELECT 2'])
  }
  assertStatements('SELECT [a;b]; SELECT 2;', POSTGRESQL_SCRIPT_RULES, ['SELECT [a', 'b]', 'SELECT 2'])
  const nonNested = '/* outer /* inner */ SELECT 1'
  assertStatements(`${nonNested}; SELECT 2;`, SQLITE_SCRIPT_RULES, [nonNested, 'SELECT 2'])
  assertStatements(String.raw`SELECT E'one\'; SELECT 2;`, SQLITE_SCRIPT_RULES, [String.raw`SELECT E'one\'`, 'SELECT 2'])
})

test('Existing dollar quotes, comments, empty segments and custom terminators keep locations', () => {
  const body = 'DO $body$ BEGIN;\nEND; $body$'
  assertStatements(`\n${body};\nSELECT $$one;two$$; ; -- tail;\n`, POSTGRESQL_SCRIPT_RULES, [body, 'SELECT $$one;two$$'])
  const rules = { ...SQLITE_SCRIPT_RULES, statementTerminators: [';;', ';'] }
  assertStatements('SELECT \'one;two\';;\n/* ; */ SELECT 2;;', rules, ["SELECT 'one;two'", '/* ; */ SELECT 2'])
  assertUnclosed('SELECT 1;\nDO $body$ unclosed;', POSTGRESQL_SCRIPT_RULES, '$body$ unclosed;')
})
