/**
 * P3 SQLite 元数据读取模块的纯 Node 契约测试。
 *
 * 不新增 RPC，也不启动 Electron：Vite 只负责把 metadata.ts 打成临时 CJS，
 * 然后用 node:sqlite 在内存库上验证 describeTable 扩展片段。
 *
 * 运行：node tests/e2e-sqlite-metadata.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'dbstudio-sqlite-metadata-'))

await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir: work,
    target: 'node22',
    ssr: true,
    minify: false,
    lib: { entry: resolve(root, 'src/drivers/sqlite/metadata.ts'), formats: ['cjs'] },
    rollupOptions: {
      external: [/^node:/],
      output: { entryFileNames: 'probe.cjs' }
    }
  }
})

const metadata = await import(pathToFileURL(join(work, 'probe.cjs')).href)
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

function createDatabase() {
  const db = new DatabaseSync(':memory:', {
    enableForeignKeyConstraints: true,
    returnArrays: true
  })
  db.exec(`
    CREATE TABLE parent (
      tenant_id INTEGER NOT NULL,
      id INTEGER NOT NULL,
      code TEXT NOT NULL,
      PRIMARY KEY (tenant_id, id),
      UNIQUE (tenant_id, code)
    );

    CREATE TABLE child (
      tenant_id INTEGER NOT NULL,
      id INTEGER NOT NULL,
      parent_tenant_id INTEGER NOT NULL,
      parent_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      note TEXT DEFAULT 'CHECK (fake)', -- CHECK (comment_fake)
      qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
      qty_copy INTEGER GENERATED ALWAYS AS (qty) VIRTUAL,
      name_len INTEGER GENERATED ALWAYS AS (length(name)) STORED,
      PRIMARY KEY (tenant_id, id),
      CONSTRAINT qty_not_42 CHECK (qty != 42),
      CONSTRAINT qty_range CHECK ((qty >= 0 AND qty < 100) OR qty = -1),
      FOREIGN KEY (parent_tenant_id, parent_id)
        REFERENCES parent
        ON UPDATE CASCADE
        ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX idx_child_name
      ON child(name)
      WHERE name <> '' AND note <> 'WHERE';

    CREATE INDEX idx_child_lower
      ON child(lower(name))
      WHERE name IS NOT NULL;

    CREATE TRIGGER trg_child_ai
      AFTER INSERT ON child
      FOR EACH ROW
      WHEN NEW.name <> ''
    BEGIN
      UPDATE child SET name = trim(NEW.name) WHERE id = NEW.id;
    END;

    CREATE TRIGGER trg_child_bu
      BEFORE UPDATE OF "name", [note] ON child
    BEGIN
      SELECT 1;
    END;

    CREATE TABLE "odd""name" (
      id INTEGER PRIMARY KEY CHECK (id > 0)
    );
  `)
  return db
}

function byName(items, name) {
  return items.find((item) => item.name === name)
}

test('table_xinfo 返回 ColumnDescription 兼容字段，并标出虚拟/存储生成列', () => {
  const db = createDatabase()
  try {
    const columns = metadata.readSqliteColumnMetadata(db, 'child')
    assert.deepEqual(
      columns.slice(0, 3).map((column) => column.name),
      ['tenant_id', 'id', 'parent_tenant_id']
    )
    assert.equal(columns[0].primaryKeyOrdinal, 1)
    assert.equal(columns[1].primaryKeyOrdinal, 2)
    assert.equal(columns[0].nullable, false)
    assert.equal(columns[0].typeName, 'INTEGER')

    const virtual = byName(columns, 'qty_copy')
    const stored = byName(columns, 'name_len')
    assert.equal(virtual.generated, 'virtual')
    assert.equal(virtual.hidden, true)
    assert.equal(stored.generated, 'stored')
    assert.equal(stored.hidden, true)
  } finally {
    db.close()
  }
})

test('复合外键按 seq 归并，并从未写目标列的 REFERENCES 解析父表复合主键', () => {
  const db = createDatabase()
  try {
    const foreignKeys = metadata.readSqliteForeignKeys(db, 'child')
    assert.equal(foreignKeys.length, 1)
    assert.deepEqual(foreignKeys[0].columns, ['parent_tenant_id', 'parent_id'])
    assert.deepEqual(foreignKeys[0].referencedColumns, ['tenant_id', 'id'])
    assert.equal(foreignKeys[0].referencedTable, 'parent')
    assert.equal(foreignKeys[0].referencedSchema, null)
    assert.equal(foreignKeys[0].name, null)
    assert.equal(foreignKeys[0].onUpdate, 'CASCADE')
    assert.equal(foreignKeys[0].onDelete, 'SET NULL')
    assert.deepEqual(metadata.readSqliteForeignKeys(db, 'child'), foreignKeys)
  } finally {
    db.close()
  }
})

test('index_list/index_info 保留唯一性、表达式列和 partial predicate', () => {
  const db = createDatabase()
  try {
    const indexes = metadata.readSqliteIndexes(db, 'child')
    const partialUnique = byName(indexes, 'idx_child_name')
    const expression = byName(indexes, 'idx_child_lower')
    assert.ok(partialUnique)
    assert.ok(expression)

    assert.equal(partialUnique.unique, true)
    assert.equal(partialUnique.partial, true)
    assert.deepEqual(partialUnique.columns, ['name'])
    assert.equal(partialUnique.predicate, "name <> '' AND note <> 'WHERE'")

    assert.deepEqual(expression.columns, ['lower(name)'])
    assert.equal(expression.predicate, 'name IS NOT NULL')
    assert.equal(expression.unique, false)
  } finally {
    db.close()
  }
})

test('CHECK 解析跳过字符串与注释，并保留列级和表级表达式', () => {
  const db = createDatabase()
  try {
    const checks = metadata.readSqliteChecks(db, 'child')
    assert.deepEqual(checks, [
      'qty >= 0',
      'qty != 42',
      '(qty >= 0 AND qty < 100) OR qty = -1'
    ])
    assert.equal(checks.some((check) => check.includes('fake')), false)
  } finally {
    db.close()
  }
})

test('触发器读取完整定义并解析 timing/event/UPDATE OF/WHEN', () => {
  const db = createDatabase()
  try {
    const triggers = metadata.readSqliteTriggers(db, 'child')
    assert.deepEqual(triggers.map((trigger) => trigger.name), ['trg_child_ai', 'trg_child_bu'])
    assert.equal(triggers[0].timing, 'after')
    assert.equal(triggers[0].event, 'insert')
    assert.equal(triggers[0].when, "NEW.name <> ''")
    assert.match(triggers[0].sql, /UPDATE child SET name = trim/)

    assert.equal(triggers[1].timing, 'before')
    assert.equal(triggers[1].event, 'update')
    assert.deepEqual(triggers[1].updateOf, ['name', 'note'])
    assert.equal(triggers[1].when, null)
  } finally {
    db.close()
  }
})

test('readSqliteTableMetadata 只返回 describeTable 扩展片段', () => {
  const db = createDatabase()
  try {
    const patch = metadata.readSqliteTableMetadata(db, 'child')
    assert.deepEqual(Object.keys(patch).sort(), ['checks', 'foreignKeys', 'indexes', 'triggers', 'uniqueConstraints'])
    assert.equal('columns' in patch, false)
    assert.equal('id' in patch, false)
    assert.equal('hasUniqueKey' in patch, false)

    assert.deepEqual(
      patch.uniqueConstraints.map((columns) => [...columns]),
      [['tenant_id', 'id']]
    )

    const parentPatch = metadata.readSqliteTableMetadata(db, 'parent')
    assert.deepEqual(
      parentPatch.uniqueConstraints.map((columns) => [...columns]),
      [
        ['tenant_id', 'code'],
        ['tenant_id', 'id']
      ]
    )
  } finally {
    db.close()
  }
})

test('表名含双引号时仍能通过参数化 PRAGMA 和 sqlite_master 读取', () => {
  const db = createDatabase()
  try {
    const patch = metadata.readSqliteTableMetadata(db, 'odd"name')
    assert.deepEqual(patch.foreignKeys, [])
    assert.deepEqual(patch.indexes, [])
    assert.deepEqual(patch.checks, ['id > 0'])
  } finally {
    db.close()
  }
})

test('不存在对象返回 object_not_found，而不是 PRAGMA 空结果假成功', () => {
  const db = createDatabase()
  try {
    assert.throws(
      () => metadata.readSqliteTableMetadata(db, 'missing_table'),
      (error) => error?.code === 'object_not_found'
    )
  } finally {
    db.close()
  }
})
