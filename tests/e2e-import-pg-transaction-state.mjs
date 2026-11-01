/**
 * PostgreSQL 驱动：**显式事务控制语句与内部事务状态同步** 的回归测试。
 *
 * ============================================================================
 * 这条测试防的是什么（阻断复现目标）
 *
 * `executeStatement('BEGIN')` 会被 `prepareGeneralStatement` 判定为 `kind: 'rows'`，
 * 走 `#runQuery` 直接把 BEGIN 发给服务端，却没有更新驱动自己记账的 `#inTransaction`。
 * 于是出现"假空闲"：用户已经在服务端开了一个真实事务，驱动却认为连接空闲。
 * 随后 `importBatch` 把这条连接当空闲：
 *   1. 再发一次 `BEGIN`（PostgreSQL 里只会告警 "already a transaction in progress"，即嵌套），
 *   2. `#importActive = true`，逐行 INSERT，
 *   3. 上层收尾时 `COMMIT` —— **把用户原本的事务一起提交了**。
 * 连接级租约只能隔离"在途请求"，识别不了"已经执行完 BEGIN、但内部标记仍是假空闲"。
 *
 * 修复后的契约：
 *   - BEGIN / START TRANSACTION        → `transactionState().active === true`
 *   - COMMIT / END                     → `active === false`
 *   - ROLLBACK / ABORT                 → `active === false`
 *   - ROLLBACK ... TO [SAVEPOINT] ...  → 仍然 `active === true`（只回退保存点）
 *   - 事务控制语句执行失败             → 状态保守保留，不清掉用户事务
 *   - 无法可靠同步的形式（AND CHAIN、PREPARE TRANSACTION、裸 START）
 *                                      → 明确拒绝并提示使用既有事务 API，不发送到服务端
 *   - `#importActive` 的所有权仍在导入 API；外部 BEGIN 不得把连接伪装成"导入中"
 *
 * ============================================================================
 * 怎么做到"真实执行"而不是静态断言
 *
 *   - 源码用 vite 打包到**内存**（`build.write: false`）后求值，跑的是仓库里的真实实现；
 *   - PostgreSQL 用**假的 pg Client**（在打包产物的 require 里替换 'pg'），
 *     不需要真服务器、不读任何凭据、不连任何真实用户库；
 *   - 假 Client 逐条记录驱动真实发出的 SQL，用来审计"有没有偷偷发嵌套 BEGIN/COMMIT"。
 *
 * 约束：不删任何文件、不碰真实用户库、不读凭据、不落盘（write:false）。
 *
 * 运行：node tests/e2e-import-pg-transaction-state.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const nodeRequire = createRequire(import.meta.url)

/** 在内存里打包一个 TS 入口并就地求值（write:false，不落盘）。 */
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
  assert.ok(chunk !== undefined, `打包产物里没有找到 chunk：${entry}`)
  const module_ = { exports: {} }
  const require_ = (id) => (id in overrides ? overrides[id] : nodeRequire(id))
  const factory = new Function('module', 'exports', 'require', '__filename', '__dirname', chunk.code)
  factory(module_, module_.exports, require_, 'probe.cjs', root)
  return module_.exports
}

// ---------------------------------------------------------------------------
// 假 pg Client：记录每一条真实 SQL，并可对指定语句注入一次失败
// ---------------------------------------------------------------------------

/** 归一化：去尾分号、折叠空白、转大写，便于按语句种类判定与断言。 */
function normalizeSql(sql) {
  return sql
    .trim()
    .replace(/;\s*$/, '')
    .replace(/\s+/g, ' ')
    .toUpperCase()
}

const CONTROL_STATEMENT_RE =
  /^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE)\b/

function controlStatements(state) {
  return state.queries.map((entry) => normalizeSql(entry.sql)).filter((sql) => CONTROL_STATEMENT_RE.test(sql))
}

const DEFAULT_COLUMNS = [
  {
    column_name: 'id',
    data_type: 'integer',
    is_nullable: 'NO',
    column_default: null,
    character_maximum_length: null,
    numeric_precision: 32,
    numeric_scale: 0,
    udt_name: 'int4'
  },
  {
    column_name: 'name',
    data_type: 'text',
    is_nullable: 'YES',
    column_default: null,
    character_maximum_length: null,
    numeric_precision: null,
    numeric_scale: null,
    udt_name: 'text'
  }
]

function makeState(overrides = {}) {
  return {
    queries: [],
    failures: overrides.failures ?? [],
    columns: overrides.columns ?? DEFAULT_COLUMNS,
    primaryKeys: overrides.primaryKeys ?? [{ column_name: 'id', ordinal_position: 1 }],
    insertHandler: overrides.insertHandler ?? (() => ({ rows: [], rowCount: 1 }))
  }
}

/** 当前测试的场景状态；每个测试用 makeState 重新初始化。 */
let currentState = null

class FakePgClient {
  constructor(config) {
    this.config = config
  }

  async connect() {
    return undefined
  }

  async end() {
    return undefined
  }

  async query(sql, params) {
    const state = currentState
    if (state === null) throw new Error('测试状态未初始化')
    state.queries.push({ sql, params })
    const normalized = normalizeSql(sql)

    // 注入的一次性失败：先匹配先触发，用来验证"失败时状态保守"。
    for (let index = 0; index < state.failures.length; index += 1) {
      const failure = state.failures[index]
      if (failure.match(normalized, sql)) {
        state.failures.splice(index, 1)
        const error = new Error(failure.message ?? 'simulated failure')
        if (failure.code !== undefined) error.code = failure.code
        throw error
      }
    }

    if (normalized === 'BEGIN' || normalized.startsWith('START TRANSACTION')) {
      return { rows: [], fields: [], rowCount: null, command: 'BEGIN' }
    }
    if (
      normalized === 'COMMIT' ||
      normalized === 'END' ||
      normalized.startsWith('COMMIT ') ||
      normalized.startsWith('END ')
    ) {
      return { rows: [], fields: [], rowCount: null, command: 'COMMIT' }
    }
    if (
      normalized.startsWith('ROLLBACK') ||
      normalized === 'ABORT' ||
      normalized.startsWith('ABORT ') ||
      normalized.startsWith('SAVEPOINT') ||
      normalized.startsWith('RELEASE')
    ) {
      return { rows: [], fields: [], rowCount: null, command: 'ROLLBACK' }
    }
    if (normalized.includes('PG_BACKEND_PID')) {
      return { rows: [{ pid: 4242 }], fields: [], rowCount: 1 }
    }
    if (normalized.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return { rows: state.columns, fields: [], rowCount: state.columns.length }
    }
    if (normalized.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')) {
      return { rows: state.primaryKeys, fields: [], rowCount: state.primaryKeys.length }
    }
    if (normalized.includes('INFORMATION_SCHEMA.TABLES')) {
      return { rows: [{ found: 1 }], fields: [], rowCount: 1 }
    }
    if (normalized.startsWith('INSERT')) {
      return state.insertHandler(sql, params)
    }
    return { rows: [], fields: [], rowCount: 0 }
  }
}

const postgresModule = await loadTs('src/drivers/postgresql/adapter.ts', {
  pg: { Client: FakePgClient }
})
const { PostgresDriverAdapter } = postgresModule

async function newAdapter(overrides = {}) {
  currentState = makeState(overrides)
  const adapter = new PostgresDriverAdapter()
  await adapter.connect(
    {
      dialectId: 'postgresql',
      name: 'tx-state',
      options: { host: '127.0.0.1', port: 5432, database: 'testdb', user: 'tester' }
    },
    {}
  )
  return { adapter, state: currentState }
}

const SAMPLE_ROWS = [
  { rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: 'alice' }] },
  { rowNumber: 2, lineNumber: 3, values: [{ kind: 'text', text: '2' }, { kind: 'text', text: 'bob' }] }
]

function sampleBatch() {
  return { batchIndex: 0, columns: ['id', 'name'], rows: SAMPLE_ROWS }
}

// ---------------------------------------------------------------------------
// 1) 阻断复现：raw BEGIN 之后内部状态必须与真实请求序列一致
// ---------------------------------------------------------------------------

test('复现阻断点：raw BEGIN 后 transactionState.active 必须为 true', async () => {
  const { adapter, state } = await newAdapter()
  try {
    await adapter.executeStatement('BEGIN')
    assert.deepEqual(controlStatements(state), ['BEGIN'], 'BEGIN 必须真的发到服务端')

    const tx = await adapter.transactionState()
    assert.equal(
      tx.active,
      true,
      'raw BEGIN 之后驱动必须如实报告事务处于活动状态（修复前这里是假空闲 false）'
    )
  } finally {
    await adapter.rollbackTransaction().catch(() => undefined)
    await adapter.disconnect()
  }
})

test('START TRANSACTION / END / ABORT 与 BEGIN / COMMIT / ROLLBACK 同步一致', async () => {
  const { adapter } = await newAdapter()
  try {
    await adapter.executeStatement('START TRANSACTION')
    assert.equal((await adapter.transactionState()).active, true, 'START TRANSACTION 后应活动')

    await adapter.executeStatement('END')
    assert.equal((await adapter.transactionState()).active, false, 'END 是 COMMIT 的别名')

    await adapter.executeStatement('BEGIN')
    assert.equal((await adapter.transactionState()).active, true, 'BEGIN 后应活动')

    await adapter.executeStatement('ABORT')
    assert.equal((await adapter.transactionState()).active, false, 'ABORT 是 ROLLBACK 的别名')

    // AND NO CHAIN 是默认语义（不开启新事务），应与普通 COMMIT/ROLLBACK 一致。
    await adapter.executeStatement('BEGIN')
    await adapter.executeStatement('COMMIT AND NO CHAIN')
    assert.equal((await adapter.transactionState()).active, false, 'COMMIT AND NO CHAIN 后应空闲')
    await adapter.executeStatement('BEGIN')
    await adapter.executeStatement('ROLLBACK AND NO CHAIN')
    assert.equal((await adapter.transactionState()).active, false, 'ROLLBACK AND NO CHAIN 后应空闲')
  } finally {
    await adapter.disconnect()
  }
})

// ---------------------------------------------------------------------------
// 2) 核心修复：raw BEGIN 之后导入必须被拒绝，且绝不发送嵌套 BEGIN/COMMIT
// ---------------------------------------------------------------------------

test('raw BEGIN 后 importBatch 必须拒绝，且不发送嵌套 BEGIN/COMMIT/ROLLBACK', async () => {
  const { adapter, state } = await newAdapter()
  try {
    await adapter.executeStatement('BEGIN')
    const controlsBefore = controlStatements(state)

    let thrown = null
    try {
      await adapter.importBatch('table:public.users', sampleBatch())
    } catch (error) {
      thrown = error
    }

    assert.notEqual(thrown, null, '连接上已有未提交的用户事务时，导入必须被拒绝')
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    assert.match(message, /已有未提交事务|未提交事务/, '拒绝消息应说明连接上已有未提交事务')

    assert.deepEqual(
      controlStatements(state),
      controlsBefore,
      '拒绝时不得发送任何 BEGIN/COMMIT/ROLLBACK（尤其不能发嵌套 BEGIN，也不能提交用户事务）'
    )
    assert.equal((await adapter.transactionState()).active, true, '拒绝后用户事务必须仍然活动')
  } finally {
    await adapter.rollbackTransaction().catch(() => undefined)
    await adapter.disconnect()
  }
})

// ---------------------------------------------------------------------------
// 3) 手工事务真实结束后，导入应能正常开始
// ---------------------------------------------------------------------------

test('手工事务真实 COMMIT 结束后 importBatch 可以正常导入', async () => {
  const { adapter, state } = await newAdapter()
  try {
    await adapter.executeStatement('BEGIN')
    await adapter.executeStatement('COMMIT')
    assert.equal((await adapter.transactionState()).active, false, '手工 COMMIT 后必须报告空闲')

    const result = await adapter.importBatch('table:public.users', sampleBatch())
    assert.equal(result.rowsImported, 2, '两行都应写入')
    assert.equal(result.inTransaction, true, '导入批次结束时事务应仍在进行（未自动提交）')
    assert.deepEqual(
      controlStatements(state),
      ['BEGIN', 'COMMIT', 'BEGIN'],
      '导入应在真空闲状态下自己新开一个事务，而不是复用/嵌套用户事务'
    )

    await adapter.commitTransaction()
    assert.deepEqual(controlStatements(state), ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'])
  } finally {
    await adapter.rollbackTransaction().catch(() => undefined)
    await adapter.disconnect()
  }
})

// ---------------------------------------------------------------------------
// 4) ROLLBACK TO SAVEPOINT 不能把事务误标为空闲
// ---------------------------------------------------------------------------

test('ROLLBACK TO SAVEPOINT 之后事务仍然活动，导入仍被拒绝', async () => {
  const { adapter, state } = await newAdapter()
  try {
    await adapter.executeStatement('BEGIN')
    await adapter.executeStatement('SAVEPOINT sp1')
    await adapter.executeStatement('ROLLBACK TO SAVEPOINT sp1')

    assert.equal(
      (await adapter.transactionState()).active,
      true,
      'ROLLBACK TO 只回退到保存点，事务必须仍然活动'
    )

    let thrown = null
    try {
      await adapter.importBatch('table:public.users', sampleBatch())
    } catch (error) {
      thrown = error
    }
    assert.notEqual(thrown, null, '事务仍活动时导入必须被拒绝')
    assert.deepEqual(
      controlStatements(state),
      ['BEGIN', 'SAVEPOINT SP1', 'ROLLBACK TO SAVEPOINT SP1'],
      '导入拒绝不应额外发送事务控制语句'
    )
  } finally {
    await adapter.rollbackTransaction().catch(() => undefined)
    await adapter.disconnect()
  }
})

// ---------------------------------------------------------------------------
// 5) 失败时必须保守：不误清用户事务状态
// ---------------------------------------------------------------------------

test('失败的事务控制语句必须保守：不误清用户事务状态', async () => {
  const { adapter, state } = await newAdapter()
  try {
    await adapter.executeStatement('BEGIN')

    state.failures.push({ match: (normalized) => normalized === 'COMMIT', message: 'simulated commit failure', code: '40000' })
    let commitError = null
    try {
      await adapter.executeStatement('COMMIT')
    } catch (error) {
      commitError = error
    }
    assert.notEqual(commitError, null, 'COMMIT 失败必须向上抛出')
    assert.equal(
      (await adapter.transactionState()).active,
      true,
      'COMMIT 失败后不得把用户事务误判为空闲'
    )

    state.failures.push({ match: (normalized) => normalized === 'ROLLBACK', message: 'simulated rollback failure', code: '40000' })
    let rollbackError = null
    try {
      await adapter.rollbackTransaction()
    } catch (error) {
      rollbackError = error
    }
    assert.notEqual(rollbackError, null, 'ROLLBACK 失败必须向上抛出')
    assert.equal(
      (await adapter.transactionState()).active,
      true,
      'ROLLBACK 失败后事务状态必须保守保留为活动'
    )

    // 恢复：只有真正成功回滚之后，才允许报告空闲。
    await adapter.rollbackTransaction()
    assert.equal((await adapter.transactionState()).active, false, 'ROLLBACK 真正成功后才应报告空闲')
  } finally {
    await adapter.disconnect()
  }
})

test('BEGIN 失败时不得把状态误标为活动', async () => {
  const { adapter, state } = await newAdapter()
  try {
    state.failures.push({ match: (normalized) => normalized === 'BEGIN', message: 'simulated begin failure', code: '40000' })
    let thrown = null
    try {
      await adapter.executeStatement('BEGIN')
    } catch (error) {
      thrown = error
    }
    assert.notEqual(thrown, null, 'BEGIN 失败必须向上抛出')
    assert.equal((await adapter.transactionState()).active, false, 'BEGIN 失败后不得报告事务活动')
  } finally {
    await adapter.disconnect()
  }
})

// ---------------------------------------------------------------------------
// 6) 无法可靠同步的形式：明确拒绝，不发送、不改状态
// ---------------------------------------------------------------------------

test('无法可靠同步的事务控制形式必须显式拒绝且不发送到服务端', async () => {
  const { adapter, state } = await newAdapter()
  try {
    await adapter.executeStatement('BEGIN')
    const sentBefore = state.queries.length

    let chainError = null
    try {
      await adapter.executeStatement('COMMIT AND CHAIN')
    } catch (error) {
      chainError = error
    }
    assert.notEqual(chainError, null, 'COMMIT AND CHAIN 无法可靠同步，必须被拒绝')
    assert.match(
      String(chainError instanceof Error ? chainError.message : chainError),
      /事务\s*API/,
      '拒绝消息必须提示改用既有事务 API'
    )
    assert.equal(state.queries.length, sentBefore, '被拒绝的语句不得发送到服务端')
    assert.equal((await adapter.transactionState()).active, true, '拒绝后用户事务状态必须保持不变')

    let prepareError = null
    try {
      await adapter.executeStatement("PREPARE TRANSACTION 'gid-1'")
    } catch (error) {
      prepareError = error
    }
    assert.notEqual(prepareError, null, 'PREPARE TRANSACTION 无法可靠同步，必须被拒绝')
    assert.equal(state.queries.length, sentBefore, 'PREPARE TRANSACTION 不得发送到服务端')
  } finally {
    await adapter.rollbackTransaction().catch(() => undefined)
    await adapter.disconnect()
  }
})

test('外部 BEGIN 不能把连接伪装成"导入中"', async () => {
  const { adapter, state } = await newAdapter()
  try {
    await adapter.executeStatement('BEGIN')
    // 若外部 BEGIN 错误地设置了 #importActive，importBatch 会走"复用导入事务"分支而不报错。
    let thrown = null
    try {
      await adapter.importBatch('table:public.users', sampleBatch())
    } catch (error) {
      thrown = error
    }
    assert.notEqual(thrown, null, '外部 BEGIN 之后导入必须按"已有用户事务"拒绝，而不是被当成导入事务复用')
    assert.equal(
      controlStatements(state).filter((sql) => sql.startsWith('BEGIN')).length,
      1,
      '全程只应有用户那一条 BEGIN，导入不得再发嵌套 BEGIN'
    )
    assert.equal(
      controlStatements(state).some((sql) => sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')),
      false,
      '导入不得发送 COMMIT/ROLLBACK，用户事务的提交权仍在用户手里'
    )
  } finally {
    await adapter.rollbackTransaction().catch(() => undefined)
    await adapter.disconnect()
  }
})
