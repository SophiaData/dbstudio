/**
 * MySQL legacy 行路径修复契约测试（审计台账 D03 / D04 / D02）。
 *
 * 在 `mysql2/promise` 模块边界做 mock，装载真实 adapter，走真实
 * executeStatement / query / fetchCellValue / applyEdits / deleteRows 路径，
 * 不连接真实 MySQL。
 *
 * 覆盖：
 *   - D03：executeStatement 对可分页 SELECT 复用 query 的分页契约
 *          （limit/offset/keepCursor → executedSql/returned/offset/hasMore/cursorId）；
 *          非 SELECT（SHOW / DML / DDL）保持原执行路径，不加分页包装。
 *   - D04：fetchCellValue 对可分页游标只做 `LIMIT 1 OFFSET <row>` 有界读取；
 *          不可包装的语句（SHOW 等）保持原路径。
 *   - D02：applyEdits / deleteRows 执行写 SQL 前核对键列集合与主键列集合完全一致，
 *          非主键列、缺复合主键列、无主键表一律在写 SQL 之前拒绝。
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

const FIELDS = [
  { name: 'id', type: 3 },
  { name: 'payload', type: 253 }
]

const LONG_TEXT = 'x'.repeat(1500)

const DATASET = [
  [1, 'alpha'],
  [2, 'bravo'],
  [3, LONG_TEXT],
  [4, 'delta'],
  [5, 'echo'],
  [6, 'foxtrot']
]

/** 解析 adapter 生成的分页 SQL 里的 LIMIT / OFFSET。 */
function parsePaged(sql) {
  const match = sql.match(/LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/i)
  return match === null ? null : { limit: Number(match[1]), offset: Number(match[2]) }
}

/** 写语句（含事务开始）：D02 用它断言「被拒绝的请求没有下发任何写 SQL」。 */
function isWriteSql(sql) {
  return /^(UPDATE|DELETE|INSERT|START TRANSACTION|COMMIT|ROLLBACK)\b/i.test(sql.trim())
}

function createFakeConnection(state) {
  return class FakeConnection {
    threadId = 1

    async query(sqlOrConfig, params) {
      const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig.sql
      state.queries.push({ sql, params })
      const lowered = sql.replace(/\s+/g, ' ').trim().toLowerCase()

      // describeTable 的主键元数据读取（D02 的校验依据）。
      if (lowered.includes('key_column_usage') && lowered.includes("constraint_name = 'primary'")) {
        return [state.pkColumns.map((name, index) => ({ name, pos: index + 1 })), []]
      }
      if (lowered.startsWith('start transaction')) return [{ affectedRows: 0 }, []]
      if (/^(update|delete|insert)\b/.test(lowered)) return [{ affectedRows: 1, insertId: 1 }, []]

      const paged = parsePaged(sql)
      if (paged !== null) {
        return [DATASET.slice(paged.offset, paged.offset + paged.limit), FIELDS]
      }
      if (lowered.startsWith('show')) {
        return [state.showRows ?? [['table_a']], [{ name: 'Tables_in_testdb', type: 253 }]]
      }
      return [DATASET, FIELDS]
    }

    async end() {
      return undefined
    }
  }
}

async function connectAdapter(state) {
  const { MysqlDriverAdapter } = await loadTs('src/drivers/mysql/adapter.ts', {
    'mysql2/promise': { createConnection: async () => new (createFakeConnection(state))() }
  })
  const adapter = new MysqlDriverAdapter()
  await adapter.connect(
    {
      dialectId: 'mysql',
      name: 'mysql-legacy-repair',
      options: { host: '127.0.0.1', port: 3306, database: 'testdb', user: 'tester' }
    },
    { dbPassword: '' }
  )
  return adapter
}

function makeState(overrides = {}) {
  return { queries: [], pkColumns: ['id'], ...overrides }
}

// ===== D03：executeStatement 可分页 SELECT 复用 query 的分页契约 =====

test('D03 executeStatement SELECT applies limit/offset and reports paging contract', async () => {
  const state = makeState()
  const adapter = await connectAdapter(state)
  try {
    const result = await adapter.executeStatement('SELECT id, payload FROM items ORDER BY id', {
      limit: 2,
      offset: 1,
      keepCursor: true
    })

    assert.equal(result.kind, 'rows')
    const page = result.result
    assert.equal(page.offset, 1)
    assert.equal(page.returned, 2)
    assert.equal(page.hasMore, true)
    assert.equal(typeof page.cursorId, 'string')
    assert.equal(page.rows[0]?.index, 1, '行下标必须带绝对偏移')
    assert.equal(page.rows.length, 2)

    // 服务端实际收到的必须是有界分页 SQL，而不是全量原 SQL。
    const executed = state.queries.at(-1)
    assert.match(executed.sql, /__dbstudio_page/)
    assert.match(executed.sql, /LIMIT 2 OFFSET 1/i)
    assert.match(page.executedSql, /LIMIT 2 OFFSET 1/i)
    assert.equal(state.queries.at(-1).params.length, 0)
  } finally {
    await adapter.disconnect()
  }
})

test('D03 executeStatement SELECT honors keepCursor=false', async () => {
  const state = makeState()
  const adapter = await connectAdapter(state)
  try {
    const result = await adapter.executeStatement('SELECT id, payload FROM items ORDER BY id', {
      limit: 2,
      offset: 1,
      keepCursor: false
    })
    assert.equal(result.kind, 'rows')
    assert.equal(result.result.cursorId, null)
    assert.match(state.queries.at(-1).sql, /LIMIT 2 OFFSET 1/i)
  } finally {
    await adapter.disconnect()
  }
})

test('D03 executeStatement non-SELECT keeps raw shape without pagination wrapping', async () => {
  const state = makeState()
  const adapter = await connectAdapter(state)
  try {
    const show = await adapter.executeStatement('SHOW TABLES', { limit: 2, offset: 1 })
    assert.equal(show.kind, 'rows')
    const showQuery = state.queries.at(-1)
    assert.equal(showQuery.sql, 'SHOW TABLES', 'SHOW 不能被包进派生表分页')
    assert.doesNotMatch(showQuery.sql, /__dbstudio_page/)
    // 保持既有返回形态：不把 limit/offset 伪装成分页语义。
    assert.equal(show.result.offset, 0)
    assert.equal(show.result.hasMore, false)
    assert.equal(show.result.returned, 1)

    const dml = await adapter.executeStatement("UPDATE items SET payload = 'x' WHERE id = 1", {
      limit: 2,
      offset: 1
    })
    assert.equal(dml.kind, 'affected')
    for (const field of ['offset', 'returned', 'hasMore', 'cursorId', 'rows', 'columns']) {
      assert.equal(field in dml, false, `affected 结果不应带分页字段 ${field}`)
    }
  } finally {
    await adapter.disconnect()
  }
})

// ===== D04：fetchCellValue 有界读取 =====

test('D04 fetchCellValue reads a single row with LIMIT 1 OFFSET', async () => {
  const state = makeState()
  const adapter = await connectAdapter(state)
  try {
    const page = await adapter.query('SELECT id, payload FROM items ORDER BY id', { limit: 5 })
    assert.equal(typeof page.cursorId, 'string')

    const value = await adapter.fetchCellValue(page.cursorId, 2, 1)
    const executed = state.queries.at(-1)
    assert.match(executed.sql, /__dbstudio_page/)
    assert.match(executed.sql, /LIMIT 1 OFFSET 2/i)
    assert.equal(executed.params.length, 0)

    // 目标行是超长文本：必须取到全文，证明取的是正确的一行。
    assert.equal(value.kind, 'text')
    assert.equal(value.text.length, LONG_TEXT.length)
    assert.equal(value.truncated, undefined)

    // 首次查询带非零 offset 时，rowIndex 仍是绝对下标（ResultRow.index），
    // 单格读取必须按绝对行号取，而不是相对本页行号。
    const offsetPage = await adapter.query('SELECT id, payload FROM items ORDER BY id', {
      limit: 2,
      offset: 1
    })
    const thirdId = await adapter.fetchCellValue(offsetPage.cursorId, 2, 0)
    assert.deepEqual(thirdId, { kind: 'number', value: 3 })
    assert.match(state.queries.at(-1).sql, /LIMIT 1 OFFSET 2/i)
  } finally {
    await adapter.disconnect()
  }
})

test('D04 fetchCellValue keeps original path for non-wrappable statements', async () => {
  const state = makeState({ showRows: [['table_a']] })
  const adapter = await connectAdapter(state)
  try {
    const show = await adapter.executeStatement('SHOW TABLES')
    assert.equal(show.kind, 'rows')
    assert.equal(typeof show.result.cursorId, 'string')

    const value = await adapter.fetchCellValue(show.result.cursorId, 0, 0)
    assert.deepEqual(value, { kind: 'text', text: 'table_a' })
    assert.equal(state.queries.at(-1).sql, 'SHOW TABLES', '不可包装语句保持原路径')
  } finally {
    await adapter.disconnect()
  }
})

// ===== D02：行编辑键列必须与主键列集合一致 =====

test('D02 applyEdits rejects non-primary-key column before any write SQL', async () => {
  const state = makeState()
  const adapter = await connectAdapter(state)
  try {
    await assert.rejects(
      adapter.applyEdits('table:testdb.items', [
        {
          keyValues: { payload: { kind: 'text', text: 'alpha' } },
          changes: { payload: { kind: 'text', text: 'beta' } }
        }
      ]),
      (error) => {
        assert.equal(error.code, 'bad_params')
        assert.match(error.message, /id/)
        assert.match(error.message, /payload/)
        return true
      }
    )
    assert.deepEqual(state.queries.filter((entry) => isWriteSql(entry.sql)), [])
  } finally {
    await adapter.disconnect()
  }
})

test('D02 applyEdits rejects partial composite primary key before any write SQL', async () => {
  const state = makeState({ pkColumns: ['order_id', 'line_no'] })
  const adapter = await connectAdapter(state)
  try {
    await assert.rejects(
      adapter.applyEdits('table:testdb.order_items', [
        {
          keyValues: { order_id: { kind: 'number', value: 7 } },
          changes: { qty: { kind: 'number', value: 3 } }
        }
      ]),
      (error) => {
        assert.equal(error.code, 'bad_params')
        assert.match(error.message, /line_no/)
        return true
      }
    )
    assert.deepEqual(state.queries.filter((entry) => isWriteSql(entry.sql)), [])
  } finally {
    await adapter.disconnect()
  }
})

test('D02 applyEdits rejects table without primary key before any write SQL', async () => {
  const state = makeState({ pkColumns: [] })
  const adapter = await connectAdapter(state)
  try {
    await assert.rejects(
      adapter.applyEdits('table:testdb.no_pk', [
        {
          keyValues: { id: { kind: 'number', value: 1 } },
          changes: { payload: { kind: 'text', text: 'beta' } }
        }
      ]),
      (error) => {
        assert.equal(error.code, 'bad_params')
        assert.match(error.message, /主键/)
        return true
      }
    )
    assert.deepEqual(state.queries.filter((entry) => isWriteSql(entry.sql)), [])
  } finally {
    await adapter.disconnect()
  }
})

test('D02 applyEdits keeps UPDATE SQL shape for a valid full primary key', async () => {
  const state = makeState({ pkColumns: ['order_id', 'line_no'] })
  const adapter = await connectAdapter(state)
  try {
    const result = await adapter.applyEdits('table:testdb.order_items', [
      {
        keyValues: {
          order_id: { kind: 'number', value: 7 },
          line_no: { kind: 'number', value: 2 }
        },
        changes: { qty: { kind: 'number', value: 9 } }
      }
    ])
    assert.equal(result.ok, true)
    assert.equal(result.affected, 1)
    const update = state.queries.find((entry) => /^UPDATE\b/i.test(entry.sql.trim()))
    assert.ok(update, '合法主键必须正常下发 UPDATE')
    assert.match(update.sql, /WHERE .*order_id.* = \?.* AND .*line_no.* = \?/i)
    assert.deepEqual(update.params, [9, 7, 2])
  } finally {
    await adapter.disconnect()
  }
})

test('D02 deleteRows rejects mismatched key and keeps DELETE for valid key', async () => {
  const state = makeState({ pkColumns: ['order_id', 'line_no'] })
  const adapter = await connectAdapter(state)
  try {
    await assert.rejects(
      adapter.deleteRows('table:testdb.order_items', [
        { order_id: { kind: 'number', value: 7 }, note: { kind: 'text', text: 'n' } }
      ]),
      (error) => {
        assert.equal(error.code, 'bad_params')
        assert.match(error.message, /line_no/)
        assert.match(error.message, /note/)
        return true
      }
    )
    assert.deepEqual(state.queries.filter((entry) => isWriteSql(entry.sql)), [])

    const deleted = await adapter.deleteRows('table:testdb.order_items', [
      {
        order_id: { kind: 'number', value: 7 },
        line_no: { kind: 'number', value: 2 }
      }
    ])
    assert.equal(deleted.ok, true)
    assert.equal(deleted.affected, 1)
    const statement = state.queries.find((entry) => /^DELETE\b/i.test(entry.sql.trim()))
    assert.ok(statement, '合法主键必须正常下发 DELETE')
    assert.deepEqual(statement.params, [7, 2])
  } finally {
    await adapter.disconnect()
  }
})
