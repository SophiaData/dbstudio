import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

// Transpile the actual module in memory; no bundles, database, or cleanup scripts.
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

const { analyzeFieldLineage, identifierInSql } = load('src/core/field-lineage.ts')

const target = { schema: 'testdb', table: 'child', column: 'parent_id' }
const tables = [
  {
    schema: 'testdb',
    name: 'child',
    columns: ['id', 'parent_id'],
    foreignKeys: [{ name: 'fk_child', column: 'parent_id', refTable: 'parent', refColumn: 'id' }]
  },
  { schema: 'testdb', name: 'parent', columns: ['id', 'code'], foreignKeys: [] },
  { schema: 'testdb', name: 'other', columns: ['parent_id'], foreignKeys: [] }
]
const views = [
  {
    schema: 'testdb',
    name: 'v_child',
    ddl: 'select `testdb`.`child`.`id` AS `id`,`testdb`.`child`.`parent_id` AS `parent_id` from `testdb`.`child`'
  }
]

// 外键必须是 certain，且方向正确。
const result = analyzeFieldLineage({ target, tables, views })
const foreignKeys = result.items.filter((item) => item.kind === 'foreignKey')
assert.equal(foreignKeys.length, 1, `应只有一条外键证据：${JSON.stringify(foreignKeys)}`)
assert.equal(foreignKeys[0].confidence, 'certain')
assert.equal(foreignKeys[0].direction, 'outgoing')
assert.equal(foreignKeys[0].table, 'parent')

// 视图引用是 likely（表与列同时出现）。
const viewItems = result.items.filter((item) => item.kind === 'viewReference')
assert.equal(viewItems.length, 1, `视图证据应命中一条：${JSON.stringify(viewItems)}`)
assert.equal(viewItems[0].confidence, 'likely')

// 同名列是 possible，且不能和自身表重复。
const sameName = result.items.filter((item) => item.kind === 'sameName')
assert.equal(sameName.length, 1, `同名证据只应命中 other 表：${JSON.stringify(sameName)}`)
assert.equal(sameName[0].confidence, 'possible')
assert.equal(sameName[0].table, 'other')

// 统计与条目一致。
assert.deepEqual(result.counts, { certain: 1, likely: 1, possible: 1 })

// 视图只出现同名列、未出现目标表时降级为 possible。
const weakView = analyzeFieldLineage({
  target,
  tables: [],
  views: [{ schema: 'testdb', name: 'v_weak', ddl: 'select parent_id from somewhere' }]
})
assert.equal(weakView.items.length, 1)
assert.equal(weakView.items[0].confidence, 'possible', '弱证据不能标成 likely')

// 标识符匹配必须按完整标识符，不能被前缀命中。
assert.equal(identifierInSql('select id from t', 'id'), true)
assert.equal(identifierInSql('select identity from t', 'id'), false, 'id 不应命中 identity')
assert.equal(identifierInSql('select `parent_id` from t', 'parent_id'), true)

// 没有任何证据时不应编造结果。
const empty = analyzeFieldLineage({ target, tables: [], views: [], histories: [] })
assert.equal(empty.items.length, 0)
assert.deepEqual(empty.counts, { certain: 0, likely: 0, possible: 0 })

// 历史 SQL 同时含表与列时算 likely。
const withHistory = analyzeFieldLineage({
  target,
  histories: [{ id: 'h1', sql: 'select parent_id from child where 1=1' }]
})
assert.equal(withHistory.items.length, 1)
assert.equal(withHistory.items[0].confidence, 'likely')

const failed = []
if (failed.length) process.exitCode = 1
console.log(JSON.stringify({ scope: 'field-lineage-analysis-in-memory-transpile', total: 12, passed: 12, failed: 0 }))
