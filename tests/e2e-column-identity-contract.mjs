/**
 * Column identity metadata contract test.
 *
 * PostgreSQL is mocked at the `pg` module boundary so this test runs without a
 * live server. It exercises the real adapter's describeTable path, including
 * the catalog SQL and the identity/generated mapping exposed to the import UI.
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
  }
]

test('PostgreSQL describeTable maps identity and generated columns without a real server', async () => {
  const queries = []

  class FakeClient {
    async connect() {
      return undefined
    }

    async end() {
      return undefined
    }

    async query(sql, params) {
      queries.push({ sql, params })
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
      if (normalized.includes('pg_backend_pid')) {
        return { rows: [{ pid: 4242 }], rowCount: 1 }
      }
      if (normalized.includes('information_schema.columns')) {
        return { rows: COLUMN_ROWS, rowCount: COLUMN_ROWS.length }
      }
      if (normalized.includes('information_schema.key_column_usage')) {
        return { rows: [], rowCount: 0 }
      }
      if (normalized.includes('information_schema.tables')) {
        return { rows: [{ found: 1 }], rowCount: 1 }
      }
      // The five structural metadata readers are outside this test's scope.
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
      name: 'identity-contract',
      options: { host: '127.0.0.1', port: 5432, database: 'testdb', user: 'tester' }
    },
    {}
  )

  try {
    const description = await adapter.describeTable('table:public.import_target')
    const byName = new Map(description.columns.map((column) => [column.name, column]))

    assert.equal(byName.get('id')?.identity, 'always')
    assert.equal(byName.get('id')?.generated, null)
    assert.equal(byName.get('id')?.nullable, false)
    assert.equal(byName.get('id')?.defaultValue, null)

    assert.equal(byName.get('external_id')?.identity, 'by-default')
    assert.equal(byName.get('external_id')?.nullable, false)
    assert.equal(byName.get('external_id')?.defaultValue, null)

    assert.equal(byName.get('slug')?.identity, null)
    assert.equal(byName.get('slug')?.generated, 'stored')
    assert.equal(byName.get('slug')?.nullable, false)
    assert.equal(byName.get('slug')?.defaultValue, null)

    assert.equal(byName.get('email')?.identity, null)
    assert.equal(byName.get('email')?.generated, null)
  } finally {
    await adapter.disconnect()
  }

  const columnQuery = queries.find((entry) => entry.sql.includes('information_schema.columns'))
  assert.ok(columnQuery, 'describeTable must query information_schema.columns')
  assert.match(columnQuery.sql, /\bc\.is_identity\b/)
  assert.match(columnQuery.sql, /\bc\.identity_generation\b/)
  assert.match(columnQuery.sql, /\bc\.is_generated\b/)
})
