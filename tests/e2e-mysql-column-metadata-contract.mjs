/**
 * MySQL 列元数据契约测试：information_schema.COLUMNS 的 EXTRA → ColumnDescription.generated。
 *
 * 在 `mysql2/promise` 模块边界做 mock，因此不需要真实 MySQL 服务：
 * 走的是真实 adapter 的 connect / describeTable / #readColumns 路径，
 * 只替换最外层的连接对象。
 *
 * 覆盖三类 EXTRA 以及两个易误判的边界：
 *   - 'VIRTUAL GENERATED' → 'virtual'
 *   - 'STORED GENERATED'  → 'stored'
 *   - ''                  → null（确认不是生成列）
 *   - 'auto_increment'    → generated null + identity 'by-default'
 *   - 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP'
 *                         → generated null（按 MySQL 语义这不是生成列，
 *                           不能被宽松的 includes('generated') 误判）
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const nodeRequire = createRequire(import.meta.url)

async function loadTs(entry, overrides = {}) {
  const result = await build({
    configFile: false,
    root,
    logLevel: 'error',
    build: {
      write: false,
      target: 'node22',
      ssr: true,
      minify: false,
      lib: { entry: resolve(root, entry), formats: ['cjs'] },
      rollupOptions: { output: { entryFileNames: 'probe.cjs' } }
    }
  })
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output
  const chunk = outputs.find((item) => item.type === 'chunk')
  assert.ok(chunk !== undefined, `No chunk produced for ${entry}`)
  const module_ = { exports: {} }
  const require_ = (id) => (id in overrides ? overrides[id] : nodeRequire(id))
  const factory = new Function('module', 'exports', 'require', '__filename', '__dirname', chunk.code)
  factory(module_, module_.exports, require_, 'probe.cjs', root)
  return module_.exports
}

const COLUMN_ROWS = [
  { name: 'id', typeName: 'int', nullable: 'NO', defaultValue: null, extra: 'auto_increment' },
  { name: 'full_name', typeName: 'varchar(101)', nullable: 'YES', defaultValue: null, extra: 'VIRTUAL GENERATED' },
  { name: 'total', typeName: 'decimal(10,2)', nullable: 'YES', defaultValue: null, extra: 'STORED GENERATED' },
  {
    name: 'updated_at',
    typeName: 'timestamp',
    nullable: 'YES',
    defaultValue: 'CURRENT_TIMESTAMP',
    extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP'
  },
  { name: 'note', typeName: 'text', nullable: 'YES', defaultValue: null, extra: '' }
]

test('MySQL describeTable maps EXTRA generated markers to ColumnDescription.generated', async () => {
  const queries = []

  class FakeConnection {
    async query(sql) {
      queries.push(sql)
      const normalized = sql.replace(/\s+/g, ' ').toLowerCase()
      if (normalized.includes('key_column_usage')) {
        return [[{ name: 'id', pos: 1 }], []]
      }
      if (normalized.includes('information_schema.columns')) {
        return [COLUMN_ROWS, []]
      }
      // 索引 / 外键 / CHECK / 触发器：本测试只关心列描述，返回空集。
      return [[], []]
    }

    async end() {
      return undefined
    }
  }

  const { MysqlDriverAdapter } = await loadTs('src/drivers/mysql/adapter.ts', {
    'mysql2/promise': { createConnection: async () => new FakeConnection() }
  })
  const adapter = new MysqlDriverAdapter()
  await adapter.connect(
    {
      dialectId: 'mysql',
      name: 'mysql-column-metadata',
      options: { host: '127.0.0.1', port: 3306, database: 'testdb', user: 'tester' }
    },
    { dbPassword: '' }
  )

  try {
    const description = await adapter.describeTable('table:testdb.gen_demo')
    const byName = new Map(description.columns.map((column) => [column.name, column]))

    // auto_increment：身份列语义保持不变，且明确不是生成列。
    assert.equal(byName.get('id')?.identity, 'by-default')
    assert.equal(byName.get('id')?.generated, null)

    // VIRTUAL GENERATED / STORED GENERATED：两态必须区分开。
    assert.equal(byName.get('full_name')?.generated, 'virtual')
    assert.equal(byName.get('full_name')?.identity, null)
    assert.equal(byName.get('total')?.generated, 'stored')
    assert.equal(byName.get('total')?.identity, null)

    // DEFAULT_GENERATED 只是默认值来源标记，不是生成列。
    assert.equal(byName.get('updated_at')?.generated, null)

    // 空 EXTRA：确认不是生成列（null，不是 undefined）。
    assert.equal(byName.get('note')?.generated, null)
    assert.equal(byName.get('note')?.identity, null)

    // MySQL information_schema 没有「隐藏列」概念：不臆造 hidden 标记。
    for (const column of description.columns) {
      assert.equal(column.hidden, undefined, `${column.name} 不应携带 hidden`)
    }

    const columnQuery = queries.find((sql) => sql.includes('information_schema.COLUMNS'))
    assert.ok(columnQuery, 'describeTable 必须查询 information_schema.COLUMNS')
    assert.match(columnQuery, /EXTRA AS extra/i)
  } finally {
    await adapter.disconnect()
  }
})
