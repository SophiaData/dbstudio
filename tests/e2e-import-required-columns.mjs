/**
 * 导入必填列静态 hint（`ColumnDescription.requiredOnInsert`）契约测试。
 *
 * 全部在内存中运行，Vite 用 `write: false` 直接产出临时 CJS（不落盘）：
 *   1. SQLite：用真实 `node:sqlite` 建内存库，覆盖 rowid 别名判定的 DDL 反例
 *      （普通单列 INTEGER PK、WITHOUT ROWID、INTEGER PRIMARY KEY DESC、
 *      复合 PK、INT / INTEGER 差异、生成列、默认值、可空列）；
 *   2. PostgreSQL：在 `pg` 模块边界 mock，验证 identity(ALWAYS/BY DEFAULT)、
 *      普通 NOT NULL、默认值、生成列、可空列的 requiredOnInsert 映射。
 *
 * 运行：node tests/e2e-import-required-columns.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
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
      rollupOptions: {
        external: [/^node:/],
        output: { entryFileNames: 'probe.cjs' }
      }
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

function createSqliteDatabase() {
  const db = new DatabaseSync(':memory:', { returnArrays: true })
  db.exec(`
    -- 普通单列 INTEGER PK NOT NULL：rowid 别名，可省略
    CREATE TABLE plain_pk (
      id INTEGER PRIMARY KEY NOT NULL,
      name TEXT
    );

    -- WITHOUT ROWID：INTEGER 主键不是 rowid 别名，不可省略
    CREATE TABLE without_rowid_pk (
      id INTEGER PRIMARY KEY,
      name TEXT
    ) WITHOUT ROWID;

    -- 列级 INTEGER PRIMARY KEY DESC：不是 rowid 别名
    CREATE TABLE desc_pk (
      id INTEGER PRIMARY KEY DESC NOT NULL,
      name TEXT
    );

    -- 复合 PK：不是单列 rowid 别名
    CREATE TABLE composite_pk (
      a INTEGER NOT NULL,
      b INTEGER NOT NULL,
      PRIMARY KEY (a, b)
    );

    -- INT 不是精确的 INTEGER，不是 rowid 别名
    CREATE TABLE int_not_integer (
      id INT PRIMARY KEY NOT NULL
    );

    -- INTEGER PRIMARY KEY ASC 仍是 rowid 别名
    CREATE TABLE asc_pk (
      id INTEGER PRIMARY KEY ASC,
      name TEXT
    );

    -- 生成列（virtual / stored）
    CREATE TABLE generated_cols (
      a INTEGER,
      b INTEGER GENERATED ALWAYS AS (a * 2) STORED,
      c INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL
    );

    -- 默认值 / 可空 / NOT NULL
    CREATE TABLE defaults_cols (
      id INTEGER PRIMARY KEY,
      x TEXT DEFAULT 'hi',
      y TEXT NOT NULL,
      z TEXT
    );
  `)
  return db
}

test('SQLite：requiredOnInsert 依据真实元数据区分 rowid 别名与真实必填', async () => {
  const metadata = await loadTs('src/drivers/sqlite/metadata.ts')
  const db = createSqliteDatabase()
  const read = (table) => {
    const columns = metadata.readSqliteColumnMetadata(db, table)
    return new Map(columns.map((column) => [column.name, column]))
  }

  // 普通单列 INTEGER PK NOT NULL：别名 → 省略即自动生成 → false
  assert.equal(read('plain_pk').get('id').requiredOnInsert, false)
  // 可空普通列 → false
  assert.equal(read('plain_pk').get('name').requiredOnInsert, false)

  // WITHOUT ROWID 的 INTEGER PK → 必须提供 → true
  assert.equal(read('without_rowid_pk').get('id').requiredOnInsert, true)

  // 列级 INTEGER PRIMARY KEY DESC → 不是别名 → 必须提供 → true
  assert.equal(read('desc_pk').get('id').requiredOnInsert, true)

  // 复合 PK 的两列都是 NOT NULL 无默认 → true
  const composite = read('composite_pk')
  assert.equal(composite.get('a').requiredOnInsert, true)
  assert.equal(composite.get('b').requiredOnInsert, true)

  // INT（不是精确 INTEGER）→ 不是别名 → 必须提供 → true
  assert.equal(read('int_not_integer').get('id').requiredOnInsert, true)

  // INTEGER PRIMARY KEY ASC → 仍是别名 → false
  assert.equal(read('asc_pk').get('id').requiredOnInsert, false)

  // 生成列：不能也不需要显式插入 → false
  const generated = read('generated_cols')
  assert.equal(generated.get('b').requiredOnInsert, false)
  assert.equal(generated.get('c').requiredOnInsert, false)

  // 默认值列 → false；NOT NULL 无默认 → true；可空 → false
  const defaults = read('defaults_cols')
  assert.equal(defaults.get('x').requiredOnInsert, false)
  assert.equal(defaults.get('y').requiredOnInsert, true)
  assert.equal(defaults.get('z').requiredOnInsert, false)
  assert.equal(defaults.get('id').requiredOnInsert, false)

  db.close()
})

test('SQLite：查不到可靠 rowid 信息时 hint 为 undefined（不瞎猜）', async () => {
  const metadata = await loadTs('src/drivers/sqlite/metadata.ts')

  // 模拟表级事实读取失败（context = null）。
  const ambiguousIntegerPk = {
    name: 'id',
    typeName: 'INTEGER',
    nullable: false,
    primaryKeyOrdinal: 1,
    defaultValue: null,
    generated: null,
    hidden: false
  }
  assert.equal(metadata.computeSqliteRequiredOnInsert(ambiguousIntegerPk, null), undefined)

  // 非主键的必填判定不依赖 rowid 信息，仍可给出确定答案。
  const plainRequired = {
    name: 'y',
    typeName: 'TEXT',
    nullable: false,
    primaryKeyOrdinal: null,
    defaultValue: null,
    generated: null,
    hidden: false
  }
  assert.equal(metadata.computeSqliteRequiredOnInsert(plainRequired, null), true)
})

const PG_COLUMN_ROWS = [
  {
    column_name: 'id',
    data_type: 'integer',
    is_nullable: 'NO',
    column_default: null,
    character_maximum_length: null,
    numeric_precision: 32,
    numeric_scale: 0,
    udt_name: 'int4',
    is_identity: 'YES',
    identity_generation: 'ALWAYS',
    is_generated: 'NEVER'
  },
  {
    column_name: 'external_id',
    data_type: 'integer',
    is_nullable: 'NO',
    column_default: null,
    character_maximum_length: null,
    numeric_precision: 32,
    numeric_scale: 0,
    udt_name: 'int4',
    is_identity: 'YES',
    identity_generation: 'BY DEFAULT',
    is_generated: 'NEVER'
  },
  {
    column_name: 'slug',
    data_type: 'text',
    is_nullable: 'NO',
    column_default: null,
    character_maximum_length: null,
    numeric_precision: null,
    numeric_scale: null,
    udt_name: 'text',
    is_identity: 'NO',
    identity_generation: null,
    is_generated: 'ALWAYS'
  },
  {
    column_name: 'email',
    data_type: 'text',
    is_nullable: 'NO',
    column_default: null,
    character_maximum_length: null,
    numeric_precision: null,
    numeric_scale: null,
    udt_name: 'text',
    is_identity: 'NO',
    identity_generation: null,
    is_generated: 'NEVER'
  },
  {
    column_name: 'nick',
    data_type: 'text',
    is_nullable: 'NO',
    column_default: "'x'::text",
    character_maximum_length: null,
    numeric_precision: null,
    numeric_scale: null,
    udt_name: 'text',
    is_identity: 'NO',
    identity_generation: null,
    is_generated: 'NEVER'
  },
  {
    column_name: 'bio',
    data_type: 'text',
    is_nullable: 'YES',
    column_default: null,
    character_maximum_length: null,
    numeric_precision: null,
    numeric_scale: null,
    udt_name: 'text',
    is_identity: 'NO',
    identity_generation: null,
    is_generated: 'NEVER'
  }
]

test('PostgreSQL：requiredOnInsert 由 NOT NULL / default / identity / generated 推导', async () => {
  class FakeClient {
    async connect() {
      return undefined
    }

    async end() {
      return undefined
    }

    async query(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
      if (normalized.includes('pg_backend_pid')) {
        return { rows: [{ pid: 4242 }], rowCount: 1 }
      }
      if (normalized.includes('information_schema.columns')) {
        return { rows: PG_COLUMN_ROWS, rowCount: PG_COLUMN_ROWS.length }
      }
      if (normalized.includes('information_schema.key_column_usage')) {
        return { rows: [], rowCount: 0 }
      }
      if (normalized.includes('information_schema.tables')) {
        return { rows: [{ found: 1 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
  }

  const { PostgresDriverAdapter } = await loadTs('src/drivers/postgresql/adapter.ts', {
    pg: { Client: FakeClient }
  })
  const adapter = new PostgresDriverAdapter()
  await adapter.connect(
    {
      dialectId: 'postgresql',
      name: 'required-columns',
      options: { host: '127.0.0.1', port: 5432, database: 'testdb', user: 'tester' }
    },
    {}
  )

  try {
    const description = await adapter.describeTable('table:public.import_target')
    const byColumn = new Map(description.columns.map((column) => [column.name, column]))

    // identity（ALWAYS / BY DEFAULT）→ 自动生成 → false
    assert.equal(byColumn.get('id').requiredOnInsert, false)
    assert.equal(byColumn.get('external_id').requiredOnInsert, false)
    // generated → false
    assert.equal(byColumn.get('slug').requiredOnInsert, false)
    // 普通 NOT NULL、无默认、非 identity/generated → true
    assert.equal(byColumn.get('email').requiredOnInsert, true)
    // 有默认值 → false
    assert.equal(byColumn.get('nick').requiredOnInsert, false)
    // 可空 → false
    assert.equal(byColumn.get('bio').requiredOnInsert, false)

    // 所有列都必须给出确定的 boolean（PG 提供了完整字段，不存在 unknown）
    for (const column of description.columns) {
      assert.equal(typeof column.requiredOnInsert, 'boolean')
    }
  } finally {
    await adapter.disconnect()
  }
})
