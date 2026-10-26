import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'dbstudio-parameters-parser-'))
await build({ configFile: false, root, logLevel: 'error', build: {
  outDir: work, target: 'node22', ssr: true, minify: false,
  lib: { entry: resolve(root, 'src/core/sql-parameters.ts'), formats: ['cjs'] },
  rollupOptions: { output: { entryFileNames: 'probe.cjs' } }
} })
const { bindSqlParameters: bind, inspectSqlParameters: inspect, normalizeSqlParameterValue: normalize } =
  await import(pathToFileURL(join(work, 'probe.cjs')).href)
process.on('exit', () => rmSync(work, { recursive: true, force: true }))
const names = (sql, dialect) => inspect(sql, dialect).placeholders.map(p => p.name)

test('SQLite ignores quoted names, strings and comments; rewrites only scanned offsets', () => {
  const sql = "SELECT :x, ':x ?', [?:z], `:q`, \"?\", :x -- :ignore ?\n/* ? */"
  assert.deepEqual(names(sql, 'sqlite'), ['x', 'x'])
  assert.deepEqual(bind(sql, [{ name: 'x', value: "a';--" }], 'sqlite'), {
    sql: sql.replace('SELECT :x', 'SELECT ?').replace(', :x --', ', ? --'), values: ["a';--", "a';--"]
  })
})
test('SQLite numbered and unsupported named syntax cannot silently bind the wrong slot', () => {
  for (const sql of ['SELECT ?2', 'SELECT @x', 'SELECT $x', 'SELECT $1', 'SELECT :123']) {
    assert.throws(() => bind(sql, [], 'sqlite'), /参数|占位/)
  }
})
test('PostgreSQL operators and array brackets do not hide $N parameters', () => {
  assert.deepEqual(names("SELECT (ARRAY[$1::int, $2::int])[$3], '{}'::jsonb ? 'x'", 'postgresql'), ['$1', '$2', '$3'])
  assert.deepEqual(bind("SELECT '{}'::jsonb ? $1", [{ name: '$1', value: 'x' }], 'postgresql').values, ['x'])
})
test('PostgreSQL ignores dollar quotes, nested comments, escape strings, and identifier dollars', () => {
  assert.deepEqual(names("SELECT $$ $99 $$, $tag$ $88 $tag$, E'it\\\'s $77', foo$66, $1 /* outer /* $55 */ $44 */", 'postgresql'), ['$1'])
})
test('PostgreSQL invalid positions and wrong binding styles are rejected', () => {
  for (const name of ['$0', '$01', '$999999999999999999999999']) {
    assert.throws(() => bind(`SELECT ${name}`, [{ name, value: 1 }], 'postgresql'), /参数|占位/)
  }
  assert.throws(() => bind('SELECT :x', [{ name: 'x', value: 1 }], 'postgresql'), /参数/)
})
test('Parameter values reject arbitrary objects and sparse JSON byte maps', () => {
  for (const value of [{}, [], { 1: 9 }, { 0: 1, 2: 3 }, { 0: 256 }, { type: 'Buffer', data: [1] }, Infinity]) {
    assert.throws(() => normalize(value), /value|参数/)
  }
  assert.deepEqual(normalize({ 0: 0, 1: 255 }), new Uint8Array([0, 255]))
  assert.deepEqual(normalize(new Uint8Array()), new Uint8Array())
})

test('Unicode identifiers and parameter names keep their lexical boundaries', () => {
  assert.deepEqual(names('SELECT 名字$99, $内容$ $88 $内容$, $1', 'postgresql'), ['$1'])
  assert.deepEqual(bind('SELECT :名字', [{ name: '名字', value: 'bound' }], 'sqlite').values, ['bound'])
})
