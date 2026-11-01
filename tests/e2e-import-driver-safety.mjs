/**
 * CSV 导入的**驱动安全**回归测试（真实执行，不连任何真实用户库）。
 *
 * ============================================================================
 * 这条测试防的是什么
 *
 * 问题一：SQLite 导入静默丢数据
 *   `BEFORE INSERT` 触发器里的 `RAISE(IGNORE)` 会让 INSERT **语句成功返回、
 *   一行都没写进去**（sqlite3_changes() = 0）。旧实现不看 `statement.run()`
 *   的 `changes`，一律 `imported += 1`：于是"已写入行数 == 批次行数"成立，
 *   上层直接 COMMIT，用户看到"导入成功"，数据库里却少了行。
 *   —— 静默丢数据比报错严重得多。
 *
 * 问题二：PostgreSQL 导入错误把 CSV 原值带到了 renderer
 *   PG 的错误消息里经常直接带着出错的数据
 *   （`invalid input syntax for type integer: "abc"`、DETAIL 行里的
 *   `Key (email)=(someone@example.com) already exists.`）。
 *   错误消息会一路传到 renderer —— 那就等于把 CSV 内容显示在界面上，
 *   违反"renderer 永远拿不到行数据"的契约（见 src/core/transfer.ts 文件头）。
 *
 * 问题三：SQLite 的"逐值替换式抹除"挡不住变换后的片段
 *   触发器可以**先变换再回显**：`substr(NEW.note, 1, 6)`（片段）、
 *   `upper(NEW.note)`（大小写变了）、`hex(NEW.num)`（十六进制），
 *   再加上 SQLite 的**类型亲和性**会把 '42' 存成整数 42 —— 按整值替换
 *   根本认不出那是数据；单字符值也只能按"独立词"替换，紧挨别的字符就漏。
 *   → 结论：**不回显引擎原文**。导入写行失败只输出
 *     「固定错误类别（SQLite result code / PG SQLSTATE 映射）
 *       + 批次/CSV 数据行/文件物理行
 *       + 白名单内的目标列名」。
 *
 * 问题四：PG 没有 SQLSTATE 时回显原文同样不稳
 *   连接层错误里可能夹带别的东西（主机名、连接串、上一条语句），
 *   所以"没有 SQLSTATE"这一支也只给固定措辞。
 *
 * ============================================================================
 * 怎么做到"真实执行"而不是静态断言
 *
 *   - 源码用 vite 打包到**内存**（`build.write: false`）后求值，
 *     跑的就是仓库里的真实实现；
 *   - SQLite 用**真实的 node:sqlite**，数据库文件建在系统临时目录里；
 *   - PostgreSQL 用**假的 pg Client**（在打包产物的 require 里替换 'pg'），
 *     不需要真服务器；
 *   - 失败路径用**真实的 ImportManager** 驱动，验证"驱动报错 → 上层回滚"。
 *
 * 约束：不删任何文件、不碰真实用户库、不读任何凭据。
 * 临时目录用 mkdtemp 每次新建（用完留在系统临时目录里，不做清理）。
 *
 * 运行：node tests/e2e-import-driver-safety.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const nodeRequire = createRequire(import.meta.url)

/**
 * 在内存里打包一个 TS 入口并就地求值。
 *
 * `build.write: false` → vite 不落盘，也就不需要清理任何文件
 * （本项目禁止删除操作，连临时目录的清理也不例外）。
 *
 * `overrides` 用来替换打包产物里的第三方模块（这里只替换 'pg'）。
 */
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

/** 建一个全新的临时目录（不清理，用完留在系统临时目录里）。 */
function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 在临时目录里建一个 SQLite 库文件（真实 node:sqlite）。 */
function createSqliteFile(dir, name, statements) {
  const file = join(dir, name)
  const db = new DatabaseSync(file)
  for (const statement of statements) db.exec(statement)
  db.close()
  return file
}

/** 把一段文本写成 CSV 文件（ImportManager 要从磁盘读）。 */
function writeCsv(dir, name, text) {
  const file = join(dir, name)
  writeFileSync(file, text, 'utf8')
  return file
}

/** 断言"错误消息里不含某个值"。CSV 单元格值绝不能出现在错误消息里。 */
function assertNoValue(message, secret, label) {
  assert.equal(
    message.includes(secret),
    false,
    `${label}：错误消息里出现了本行的数据值「${secret}」\n消息：${message}`
  )
}

// ---------------------------------------------------------------------------
// PostgreSQL 的假 Client
// ---------------------------------------------------------------------------

/**
 * 假 pg Client：只实现驱动真正用到的那几个方法。
 *
 * 真实 pg 的错误对象上带着 SQLSTATE、severity、detail、table、column、constraint
 * 等结构化字段（见 pg-protocol 的 parseErrorMessage），这里照抄那个形状，
 * 才能验证驱动是不是真的只用了结构化信息。
 */
function createPgMock(options) {
  const state = { queries: [], insertHandler: options.insertHandler }

  class FakeClient {
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
      state.queries.push({ sql, params })
      const trimmed = sql.trim()
      if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        // 事务控制语句默认成功；controlHandler 可按语句种类注入一次失败
        // （用来模拟 COMMIT/ROLLBACK 时的服务端错误，例如 DEFERRABLE 触发器）。
        if (typeof options.controlHandler === 'function') {
          const handled = options.controlHandler(trimmed)
          if (handled !== undefined) return handled
        }
        return { rows: [], rowCount: 0, command: trimmed }
      }
      if (trimmed.includes('pg_backend_pid')) {
        return { rows: [{ pid: 4242 }], rowCount: 1 }
      }
      if (trimmed.includes('information_schema.columns')) {
        return { rows: options.columns, rowCount: options.columns.length }
      }
      if (trimmed.includes('information_schema.key_column_usage')) {
        return { rows: options.primaryKeys, rowCount: options.primaryKeys.length }
      }
      if (trimmed.includes('information_schema.tables')) {
        return { rows: [{ found: 1 }], rowCount: 1 }
      }
      if (/^INSERT/i.test(trimmed)) {
        return state.insertHandler(sql, params)
      }
      return { rows: [], rowCount: 0 }
    }
  }

  return { mock: { Client: FakeClient }, state }
}

/** 造一个和 pg 报错形状一致的错误对象。 */
function makePgError(fields) {
  const error = new Error(fields.message)
  if (fields.code !== undefined) error.code = fields.code
  if (fields.severity !== undefined) error.severity = fields.severity
  if (fields.detail !== undefined) error.detail = fields.detail
  if (fields.table !== undefined) error.table = fields.table
  if (fields.schema !== undefined) error.schema = fields.schema
  if (fields.column !== undefined) error.column = fields.column
  if (fields.constraint !== undefined) error.constraint = fields.constraint
  return error
}

// ---------------------------------------------------------------------------
// 1) SQLite：RAISE(IGNORE) 导致的"静默丢数据"
// ---------------------------------------------------------------------------

test('SQLite：触发器 RAISE(IGNORE) 时导入必须失败而不是报告成功', async () => {
  const { SqliteDriverAdapter } = await loadTs('src/drivers/sqlite/adapter.ts')
  const dir = makeTempDir('dbstudio-import-safety-sqlite-ignore-')
  const file = createSqliteFile(dir, 'ignore.db', [
    'CREATE TABLE target (id INTEGER PRIMARY KEY, name TEXT)',
    // 命中就跳过这一行：INSERT 语句成功返回，但一行都没写进去。
    `CREATE TRIGGER skip_bob BEFORE INSERT ON target WHEN NEW.name = 'bob' BEGIN SELECT RAISE(IGNORE); END;`
  ])

  const adapter = new SqliteDriverAdapter()
  await adapter.connect(
    { dialectId: 'sqlite', name: 'safety', options: { file } },
    {}
  )

  let thrown = null
  try {
    await adapter.importBatch('table:target', {
      batchIndex: 0,
      columns: ['id', 'name'],
      rows: [
        { rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: 'alice' }] },
        { rowNumber: 2, lineNumber: 3, values: [{ kind: 'text', text: '2' }, { kind: 'text', text: 'bob' }] }
      ]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, '导入必须失败：BEFORE INSERT 触发器 RAISE(IGNORE) 时那一行没被写入')
  const message = thrown instanceof Error ? thrown.message : String(thrown)
  assert.match(message, /CSV 数据第 2 行/, '错误消息必须指出失败的是哪一行')
  assert.match(message, /影响行数为 0/, '错误消息必须说明实际影响行数')
  assertNoValue(message, 'bob', 'SQLite 影响行数不符的报错')

  // 上层（ImportManager）收到失败后会回滚：回滚后表里必须一行都没有。
  const state = await adapter.rollbackTransaction()
  assert.equal(state.active, false, '回滚后不应再有活动事务')
  assert.equal(await adapter.countRows('table:target'), 0, '回滚后表里必须一行都没有（不能留下半截数据）')

  await adapter.disconnect()
})

test('SQLite：正常导入仍然报告正确的行数（不能被影响行数校验误伤）', async () => {
  const { SqliteDriverAdapter } = await loadTs('src/drivers/sqlite/adapter.ts')
  const dir = makeTempDir('dbstudio-import-safety-sqlite-ok-')
  const file = createSqliteFile(dir, 'ok.db', ['CREATE TABLE target (id INTEGER PRIMARY KEY, name TEXT)'])

  const adapter = new SqliteDriverAdapter()
  await adapter.connect({ dialectId: 'sqlite', name: 'safety', options: { file } }, {})

  const result = await adapter.importBatch('table:target', {
    batchIndex: 0,
    columns: ['id', 'name'],
    rows: [
      { rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: 'alice' }] },
      { rowNumber: 2, lineNumber: 3, values: [{ kind: 'text', text: '2' }, { kind: 'text', text: 'bob' }] }
    ]
  })

  assert.equal(result.rowsImported, 2, '两行都写进去时必须报告 2')
  assert.equal(result.inTransaction, true, '导入批次结束时事务应仍然打开')
  assert.equal(await adapter.countRows('table:target'), 2, '表里必须真的有两行')

  await adapter.commitTransaction()
  await adapter.disconnect()
})

// ---------------------------------------------------------------------------
// 2) SQLite：触发器把本行的值（哪怕是变换后的片段）写进错误消息
// ---------------------------------------------------------------------------

test('SQLite：触发器报错不得回显引擎原文（本行数据值一个字都不能出现）', async () => {
  const { SqliteDriverAdapter } = await loadTs('src/drivers/sqlite/adapter.ts')
  const dir = makeTempDir('dbstudio-import-safety-sqlite-leak-')
  const secret = 'top-secret-token-42'
  const file = createSqliteFile(dir, 'leak.db', [
    'CREATE TABLE target (id INTEGER PRIMARY KEY, note TEXT)',
    // 触发器自己拼消息：引擎的报错里会带上这一行的真实值。
    `CREATE TRIGGER echo BEFORE INSERT ON target WHEN NEW.note = '${secret}' ` +
      "BEGIN SELECT RAISE(ABORT, 'rejected: ' || NEW.note); END;"
  ])

  const adapter = new SqliteDriverAdapter()
  await adapter.connect({ dialectId: 'sqlite', name: 'safety', options: { file } }, {})

  let thrown = null
  try {
    await adapter.importBatch('table:target', {
      batchIndex: 0,
      columns: ['id', 'note'],
      rows: [
        { rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: secret }] }
      ]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, '触发器 ABORT 必须让导入失败')
  const message = thrown instanceof Error ? thrown.message : String(thrown)

  // 契约：不只是"整值不出现"，**引擎原文整体都不许出现**。
  assertNoValue(message, secret, 'SQLite 触发器报错')
  assert.equal(
    message.includes('rejected:'),
    false,
    `SQLite 触发器报错不得回显引擎原文\n消息：${message}`
  )
  assert.equal(
    message.includes('[值已省略]'),
    false,
    `不再做"逐值替换式抹除"，错误里不应再出现占位符\n消息：${message}`
  )

  // 固定错误类别 + 行列定位必须还在（否则用户无从下手）。
  assert.match(message, /写入被数据库的触发器拒绝/, '错误消息必须给出固定措辞的错误类别')
  assert.match(message, /第 1 批第 1 行/, '错误消息必须保留批次与批次内行号')
  assert.match(message, /CSV 数据第 1 行/, '错误消息必须保留行定位')
  assert.match(message, /文件物理第 2 行/, '错误消息必须保留物理行定位')
  assert.match(message, /写入列「/, '错误消息必须保留列定位')

  await adapter.rollbackTransaction()
  await adapter.disconnect()
})

test('SQLite：触发器只回显片段（substr）时，片段也不得出现在错误里', async () => {
  const { SqliteDriverAdapter } = await loadTs('src/drivers/sqlite/adapter.ts')
  const dir = makeTempDir('dbstudio-import-safety-sqlite-substr-')
  const secret = 'top-secret-token-42'
  const fragment = secret.slice(0, 6)
  const file = createSqliteFile(dir, 'substr.db', [
    'CREATE TABLE target (id INTEGER PRIMARY KEY, note TEXT)',
    // 只回显前 6 个字符：按"整值替换"抹除的老实现认不出来 → 泄漏。
    `CREATE TRIGGER echo BEFORE INSERT ON target WHEN NEW.note = '${secret}' ` +
      "BEGIN SELECT RAISE(ABORT, 'bad:' || substr(NEW.note, 1, 6)); END;"
  ])

  const adapter = new SqliteDriverAdapter()
  await adapter.connect({ dialectId: 'sqlite', name: 'safety', options: { file } }, {})

  let thrown = null
  try {
    await adapter.importBatch('table:target', {
      batchIndex: 0,
      columns: ['id', 'note'],
      rows: [
        { rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: secret }] }
      ]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, '触发器 ABORT 必须让导入失败')
  const message = thrown instanceof Error ? thrown.message : String(thrown)

  assertNoValue(message, fragment, 'SQLite 触发器片段回显')
  assertNoValue(message, secret, 'SQLite 触发器片段回显')
  assert.equal(message.includes('bad:'), false, `不得回显引擎原文\n消息：${message}`)
  assert.match(message, /写入被数据库的触发器拒绝/, '错误消息必须给出固定措辞的错误类别')
  assert.match(message, /CSV 数据第 1 行/, '错误消息必须保留行定位')

  await adapter.rollbackTransaction()
  await adapter.disconnect()
})

test('SQLite：触发器回显大小写变换（upper）后的值时，变换值不得出现在错误里', async () => {
  const { SqliteDriverAdapter } = await loadTs('src/drivers/sqlite/adapter.ts')
  const dir = makeTempDir('dbstudio-import-safety-sqlite-upper-')
  const secret = 'secret-token-42'
  const upper = secret.toUpperCase()
  const file = createSqliteFile(dir, 'upper.db', [
    'CREATE TABLE target (id INTEGER PRIMARY KEY, note TEXT)',
    `CREATE TRIGGER echo BEFORE INSERT ON target WHEN NEW.note = '${secret}' ` +
      "BEGIN SELECT RAISE(ABORT, 'u:' || upper(NEW.note)); END;"
  ])

  const adapter = new SqliteDriverAdapter()
  await adapter.connect({ dialectId: 'sqlite', name: 'safety', options: { file } }, {})

  let thrown = null
  try {
    await adapter.importBatch('table:target', {
      batchIndex: 0,
      columns: ['id', 'note'],
      rows: [
        { rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: secret }] }
      ]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, '触发器 ABORT 必须让导入失败')
  const message = thrown instanceof Error ? thrown.message : String(thrown)

  assertNoValue(message, upper, 'SQLite 触发器 upper 变换')
  assertNoValue(message, secret, 'SQLite 触发器 upper 变换')
  assert.equal(message.includes('u:'), false, `不得回显引擎原文\n消息：${message}`)

  await adapter.rollbackTransaction()
  await adapter.disconnect()
})

test('SQLite：触发器回显十六进制（hex）且列有类型亲和性时，十六进制片段不得出现', async () => {
  const { SqliteDriverAdapter } = await loadTs('src/drivers/sqlite/adapter.ts')
  const dir = makeTempDir('dbstudio-import-safety-sqlite-hex-')
  const raw = '42'
  const hex = Buffer.from(raw, 'utf8').toString('hex')
  const file = createSqliteFile(dir, 'hex.db', [
    'CREATE TABLE target (id INTEGER PRIMARY KEY, num INTEGER)',
    // num 是 INTEGER 列：SQLite 的类型亲和性会把 '42' 存成整数 42，
    // hex(NEW.num) 因此是 '3432' —— 按整值 '42' 替换的老实现挡不住。
    `CREATE TRIGGER echo BEFORE INSERT ON target WHEN NEW.num = ${raw} ` +
      "BEGIN SELECT RAISE(ABORT, 'h:' || hex(NEW.num)); END;"
  ])

  const adapter = new SqliteDriverAdapter()
  await adapter.connect({ dialectId: 'sqlite', name: 'safety', options: { file } }, {})

  let thrown = null
  try {
    await adapter.importBatch('table:target', {
      batchIndex: 0,
      columns: ['id', 'num'],
      rows: [
        { rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: raw }] }
      ]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, '触发器 ABORT 必须让导入失败')
  const message = thrown instanceof Error ? thrown.message : String(thrown)

  assertNoValue(message, hex, 'SQLite 触发器 hex 变换')
  assert.equal(message.includes('h:'), false, `不得回显引擎原文\n消息：${message}`)
  assert.match(message, /写入被数据库的触发器拒绝/, '错误消息必须给出固定措辞的错误类别')

  await adapter.rollbackTransaction()
  await adapter.disconnect()
})

test('SQLite：数值型 CellValue 触发写入失败时，数值不得出现在错误里', async () => {
  const { SqliteDriverAdapter } = await loadTs('src/drivers/sqlite/adapter.ts')
  const dir = makeTempDir('dbstudio-import-safety-sqlite-number-')
  const value = 987654321
  const hex = Buffer.from(String(value), 'utf8').toString('hex')
  const file = createSqliteFile(dir, 'number.db', [
    'CREATE TABLE target (id INTEGER PRIMARY KEY, num INTEGER)',
    `CREATE TRIGGER echo BEFORE INSERT ON target BEGIN SELECT RAISE(ABORT, 'v:' || NEW.num); END;`
  ])

  const adapter = new SqliteDriverAdapter()
  await adapter.connect({ dialectId: 'sqlite', name: 'safety', options: { file } }, {})

  let thrown = null
  try {
    await adapter.importBatch('table:target', {
      batchIndex: 0,
      columns: ['id', 'num'],
      rows: [
        {
          rowNumber: 1,
          lineNumber: 2,
          values: [{ kind: 'text', text: '1' }, { kind: 'number', value }]
        }
      ]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, '触发器 ABORT 必须让导入失败')
  const message = thrown instanceof Error ? thrown.message : String(thrown)

  // 旧实现只处理 kind === 'text' 的值，数值型 CellValue 根本不会被抹。
  assertNoValue(message, String(value), 'SQLite 数值型 CellValue')
  assertNoValue(message, hex, 'SQLite 数值型 CellValue')
  assert.equal(message.includes('v:'), false, `不得回显引擎原文\n消息：${message}`)

  await adapter.rollbackTransaction()
  await adapter.disconnect()
})

test('SQLite：单字符值紧挨其它字符时也不得泄漏', async () => {
  const { SqliteDriverAdapter } = await loadTs('src/drivers/sqlite/adapter.ts')
  const dir = makeTempDir('dbstudio-import-safety-sqlite-onechar-')
  const value = 'Q'
  const file = createSqliteFile(dir, 'onechar.db', [
    'CREATE TABLE target (id INTEGER PRIMARY KEY, note TEXT)',
    // 老实现对长度为 1 的值只能按"独立词"替换，这里 'x' 与 'Q' 紧挨着 → 漏。
    `CREATE TRIGGER echo BEFORE INSERT ON target WHEN NEW.note = '${value}' ` +
      "BEGIN SELECT RAISE(ABORT, 'x' || NEW.note || 'y'); END;"
  ])

  const adapter = new SqliteDriverAdapter()
  await adapter.connect({ dialectId: 'sqlite', name: 'safety', options: { file } }, {})

  let thrown = null
  try {
    await adapter.importBatch('table:target', {
      batchIndex: 0,
      columns: ['id', 'note'],
      rows: [
        { rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: value }] }
      ]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, '触发器 ABORT 必须让导入失败')
  const message = thrown instanceof Error ? thrown.message : String(thrown)

  assertNoValue(message, value, 'SQLite 单字符值')
  assert.equal(message.includes('xQ'), false, `不得回显引擎原文\n消息：${message}`)

  await adapter.rollbackTransaction()
  await adapter.disconnect()
})

test('SQLite：AFTER INSERT 审计触发器必须照常计数（不能被行数校验误伤）', async () => {
  const { SqliteDriverAdapter } = await loadTs('src/drivers/sqlite/adapter.ts')
  const dir = makeTempDir('dbstudio-import-safety-sqlite-audit-')
  const file = createSqliteFile(dir, 'audit.db', [
    'CREATE TABLE target (id INTEGER PRIMARY KEY, name TEXT)',
    'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, target_id INTEGER)',
    // 审计触发器：target 每写入一行，audit 就多一行。
    `CREATE TRIGGER audit_after_insert AFTER INSERT ON target BEGIN
       INSERT INTO audit (target_id) VALUES (NEW.id);
     END;`
  ])

  const adapter = new SqliteDriverAdapter()
  await adapter.connect({ dialectId: 'sqlite', name: 'safety', options: { file } }, {})

  const result = await adapter.importBatch('table:target', {
    batchIndex: 0,
    columns: ['id', 'name'],
    rows: [
      { rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: 'alice' }] },
      { rowNumber: 2, lineNumber: 3, values: [{ kind: 'text', text: '2' }, { kind: 'text', text: 'bob' }] },
      { rowNumber: 3, lineNumber: 4, values: [{ kind: 'text', text: '3' }, { kind: 'text', text: 'carol' }] }
    ]
  })

  assert.equal(result.rowsImported, 3, '三行都写进去时必须报告 3')
  assert.equal(await adapter.countRows('table:target'), 3, '目标表必须真的有三行')
  assert.equal(
    await adapter.countRows('table:audit'),
    3,
    'AFTER INSERT 审计触发器必须照常写入（触发器里的写入不该影响外层的影响行数判定）'
  )

  await adapter.commitTransaction()
  await adapter.disconnect()
})

// ---------------------------------------------------------------------------
// 3) 上层回滚：真实的 ImportManager 驱动真实的 SQLite 适配器
// ---------------------------------------------------------------------------

test('真实 ImportManager：NOT NULL 失败仍要带行/物理行/列名（与导入主套件同口径）', async () => {
  const { SqliteDriverAdapter } = await loadTs('src/drivers/sqlite/adapter.ts')
  const { ImportManager } = await loadTs('src/main/ImportManager.ts')

  const dir = makeTempDir('dbstudio-import-safety-manager-notnull-')
  const file = createSqliteFile(dir, 'notnull.db', [
    'CREATE TABLE guarded (id INTEGER PRIMARY KEY, email TEXT NOT NULL, note TEXT)'
  ])
  // 空字段 + nullText:'' → NULL → 触发 NOT NULL 约束。
  const csv = writeCsv(dir, 'data.csv', 'id,email,note\n1,a@example.com,ok\n2,,bad\n')

  const adapter = new SqliteDriverAdapter()
  await adapter.connect({ dialectId: 'sqlite', name: 'safety', options: { file } }, {})

  const manager = new ImportManager({
    writeBatch: (nodeId, batch) => adapter.importBatch(nodeId, batch),
    commit: async () => adapter.commitTransaction(),
    rollback: async () => adapter.rollbackTransaction(),
    transactionState: async () => adapter.transactionState()
  })

  const progress = manager.start({
    targetNodeId: 'table:guarded',
    sourcePath: csv,
    delimiter: ',',
    nullText: '',
    hasHeader: true,
    targetColumns: ['id', 'email', 'note'],
    batchSize: 10
  })
  const result = await manager.wait(progress.taskId)

  assert.equal(result.status, 'failed', 'NOT NULL 失败时任务必须失败')
  assert.equal(result.row, 2, '失败位置必须指向第 2 条数据行')
  assert.equal(result.line, 3, '失败位置必须指向文件物理第 3 行')
  assert.equal(result.column, 2, '失败位置必须指向第 2 列（email）')
  assert.equal(result.columnName, 'email', '失败位置必须带出列名 email')
  assert.equal(result.rowsImported, 0, '失败后成功行数必须归零')
  assert.equal(await adapter.countRows('table:guarded'), 0, '回滚后表里必须一行都没有')

  await adapter.disconnect()
})

test('真实 ImportManager：驱动报错后任务失败、行数归零、数据回滚', async () => {
  const { SqliteDriverAdapter } = await loadTs('src/drivers/sqlite/adapter.ts')
  const { ImportManager } = await loadTs('src/main/ImportManager.ts')

  const dir = makeTempDir('dbstudio-import-safety-manager-')
  const file = createSqliteFile(dir, 'manager.db', [
    'CREATE TABLE target (id INTEGER PRIMARY KEY, name TEXT)',
    `CREATE TRIGGER skip_bob BEFORE INSERT ON target WHEN NEW.name = 'bob' BEGIN SELECT RAISE(IGNORE); END;`
  ])
  const csv = writeCsv(dir, 'data.csv', 'id,name\n1,alice\n2,bob\n')

  const adapter = new SqliteDriverAdapter()
  await adapter.connect({ dialectId: 'sqlite', name: 'safety', options: { file } }, {})

  const manager = new ImportManager({
    writeBatch: (nodeId, batch) => adapter.importBatch(nodeId, batch),
    commit: async () => adapter.commitTransaction(),
    rollback: async () => adapter.rollbackTransaction(),
    transactionState: async () => adapter.transactionState()
  })

  const progress = manager.start({
    targetNodeId: 'table:target',
    sourcePath: csv,
    delimiter: ',',
    nullText: '',
    hasHeader: true,
    targetColumns: ['id', 'name'],
    batchSize: 10
  })
  const result = await manager.wait(progress.taskId)

  assert.equal(result.status, 'failed', '导入必须失败')
  assert.equal(result.rowsImported, 0, '失败后成功行数必须归零')
  assert.equal(result.row, 2, '失败位置必须指向第 2 条数据行')
  assert.equal(result.line, 3, '失败位置必须指向文件物理第 3 行')
  assert.equal(await adapter.countRows('table:target'), 0, '回滚后表里必须一行都没有')

  await adapter.disconnect()
})

// ---------------------------------------------------------------------------
// 4) PostgreSQL：错误摘要脱敏 + 保留定位与 SQLSTATE
// ---------------------------------------------------------------------------

/** 起一个连着假 Client 的 PG 适配器。 */
async function createPgAdapter(insertHandler, extra = {}) {
  const columns = [
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
      column_name: 'age',
      data_type: 'integer',
      is_nullable: 'YES',
      column_default: null,
      character_maximum_length: null,
      numeric_precision: 32,
      numeric_scale: 0,
      udt_name: 'int4'
    }
  ]
  const primaryKeys = [{ column_name: 'id', ordinal_position: 1 }]
  const { mock } = createPgMock({ columns, primaryKeys, insertHandler, controlHandler: extra.controlHandler })

  const { PostgresDriverAdapter } = await loadTs('src/drivers/postgresql/adapter.ts', { pg: mock })
  const adapter = new PostgresDriverAdapter()
  await adapter.connect(
    {
      dialectId: 'postgresql',
      name: 'safety',
      options: { host: '127.0.0.1', port: 5432, database: 'testdb', user: 'tester' }
    },
    {}
  )
  return adapter
}

test('PostgreSQL：导入错误摘要不得包含 CSV 原值，但要给出 SQLSTATE 与行列定位', async () => {
  const cellValue = 'not-a-number-42'
  let inserts = 0
  const adapter = await createPgAdapter(() => {
    inserts += 1
    // 第一行写成功，第二行才出错——这样能验证"失败的是第几行"没被脱敏弄丢。
    if (inserts === 1) return { rows: [], rowCount: 1 }
    throw makePgError({
      message: `invalid input syntax for type integer: "${cellValue}"`,
      code: '22P02',
      severity: 'ERROR',
      detail: `Failing row contains (1, ${cellValue})`,
      table: 'users',
      schema: 'public',
      column: 'age'
    })
  })

  let thrown = null
  try {
    await adapter.importBatch('table:public.users', {
      batchIndex: 0,
      columns: ['id', 'age'],
      rows: [
        { rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: '5' }] },
        { rowNumber: 2, lineNumber: 3, values: [{ kind: 'text', text: '2' }, { kind: 'text', text: cellValue }] }
      ]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, 'PG 报错必须让导入失败')
  const message = thrown instanceof Error ? thrown.message : String(thrown)

  // 契约：renderer 永远拿不到行数据 —— 原始消息里的值一个字都不能出现。
  assertNoValue(message, cellValue, 'PG 导入错误摘要')
  assert.equal(
    message.includes('invalid input syntax'),
    false,
    `PG 导入错误摘要不得回显原始错误消息\n消息：${message}`
  )

  // 定位与 SQLSTATE 必须还在：没有它们用户无从下手。
  assert.match(message, /SQLSTATE 22P02/, '错误摘要必须带 SQLSTATE')
  assert.match(message, /CSV 数据第 2 行/, '错误摘要必须保留行定位')
  assert.match(message, /文件物理第 3 行/, '错误摘要必须保留物理行定位')
  assert.match(message, /列「age」/, '错误摘要必须保留列定位')

  await adapter.disconnect()
})

test('PostgreSQL：唯一约束冲突的摘要只带 SQLSTATE 与约束名，不带键值', async () => {
  const cellValue = 'someone@example.com'
  const adapter = await createPgAdapter(() => {
    throw makePgError({
      message: 'duplicate key value violates unique constraint "users_email_key"',
      code: '23505',
      severity: 'ERROR',
      detail: `Key (email)=(${cellValue}) already exists.`,
      table: 'users',
      schema: 'public',
      constraint: 'users_email_key'
    })
  })

  let thrown = null
  try {
    await adapter.importBatch('table:public.users', {
      batchIndex: 0,
      columns: ['id', 'age'],
      rows: [
        { rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: cellValue }] }
      ]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, 'PG 报错必须让导入失败')
  const message = thrown instanceof Error ? thrown.message : String(thrown)

  assertNoValue(message, cellValue, 'PG 唯一约束冲突摘要')
  assert.match(message, /SQLSTATE 23505/, '错误摘要必须带 SQLSTATE')
  assert.match(message, /users_email_key/, '错误摘要应带上约束名（目录对象名，不是数据）')
  assert.match(message, /CSV 数据第 1 行/, '错误摘要必须保留行定位')

  await adapter.disconnect()
})

test('PostgreSQL：语句成功但没写入任何行时必须失败（与 SQLite 同一口径）', async () => {
  const adapter = await createPgAdapter(() => ({ rows: [], rowCount: 0 }))

  let thrown = null
  try {
    await adapter.importBatch('table:public.users', {
      batchIndex: 0,
      columns: ['id', 'age'],
      rows: [{ rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: '5' }] }]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, '没有写入任何行时必须失败，不能报告成功')
  const message = thrown instanceof Error ? thrown.message : String(thrown)
  assert.match(message, /影响行数为 0/, '错误消息必须说明实际影响行数')
  assert.match(message, /CSV 数据第 1 行/, '错误消息必须保留行定位')

  await adapter.rollbackTransaction()
  await adapter.disconnect()
})

// ---------------------------------------------------------------------------
// 5) PostgreSQL：没有 SQLSTATE 时也不回显原文
// ---------------------------------------------------------------------------

test('PostgreSQL：没有 SQLSTATE 的错误不得回显原文（只给固定措辞）', async () => {
  const raw = 'connection to server at "10.0.0.5" (10.0.0.5), port 5432 failed: secret-value-9'
  const adapter = await createPgAdapter(() => {
    // 没有 code 字段：连接层/客户端层错误。
    throw makePgError({ message: raw })
  })

  let thrown = null
  try {
    await adapter.importBatch('table:public.users', {
      batchIndex: 0,
      columns: ['id', 'age'],
      rows: [{ rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: '5' }] }]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, 'PG 报错必须让导入失败')
  const message = thrown instanceof Error ? thrown.message : String(thrown)

  assertNoValue(message, 'secret-value-9', 'PG 无 SQLSTATE 错误摘要')
  assert.equal(
    message.includes('connection to server'),
    false,
    `PG 无 SQLSTATE 错误摘要不得回显原文\n消息：${message}`
  )
  assert.match(message, /数据库连接层错误/, '必须给出固定措辞的错误类别')
  assert.match(message, /CSV 数据第 1 行/, '错误摘要必须保留行定位')
  assert.match(message, /写入列「/, '错误摘要必须保留列定位')

  await adapter.disconnect()
})

// ---------------------------------------------------------------------------
// 6) PostgreSQL：SQLSTATE 22007 的分类（invalid_datetime_format）
// ---------------------------------------------------------------------------

test('PostgreSQL：SQLSTATE 22007 必须归类为日期时间格式无效（不是数值超范围）', async () => {
  const cellValue = '2024-13-45'
  const adapter = await createPgAdapter(() => {
    throw makePgError({
      message: `invalid input syntax for type timestamp: "${cellValue}"`,
      code: '22007',
      severity: 'ERROR',
      table: 'users',
      schema: 'public',
      column: 'age'
    })
  })

  let thrown = null
  try {
    await adapter.importBatch('table:public.users', {
      batchIndex: 0,
      columns: ['id', 'age'],
      rows: [{ rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: cellValue }] }]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, 'PG 报错必须让导入失败')
  const message = thrown instanceof Error ? thrown.message : String(thrown)

  // PostgreSQL 官方 Appendix A：22007 = invalid_datetime_format，
  // 22003 = numeric_value_out_of_range —— 两者不能互相顶替。
  assert.match(message, /SQLSTATE 22007/, '错误摘要必须带 SQLSTATE')
  assert.match(message, /日期时间格式无效/, '22007 必须归类为日期时间格式无效')
  assert.equal(
    message.includes('数值超出了目标列的范围'),
    false,
    `22007 不是 numeric_value_out_of_range，不能说成数值超范围\n消息：${message}`
  )
  assertNoValue(message, cellValue, 'PG 22007 摘要')

  await adapter.disconnect()
})

// ---------------------------------------------------------------------------
// 7) 导入错误不携带含数据的原始 cause（按真实 RPC 序列化形状核对）
// ---------------------------------------------------------------------------

test('SQLite：导入失败不携带含数据的原始 cause（RPC 形状核对）', async () => {
  const { SqliteDriverAdapter } = await loadTs('src/drivers/sqlite/adapter.ts')
  const dir = makeTempDir('dbstudio-import-safety-sqlite-cause-')
  const secret = 'top-secret-token-42'
  const file = createSqliteFile(dir, 'cause.db', [
    'CREATE TABLE target (id INTEGER PRIMARY KEY, note TEXT)',
    `CREATE TRIGGER echo BEFORE INSERT ON target WHEN NEW.note = '${secret}' ` +
      "BEGIN SELECT RAISE(ABORT, 'rejected: ' || NEW.note); END;"
  ])

  const adapter = new SqliteDriverAdapter()
  await adapter.connect({ dialectId: 'sqlite', name: 'safety', options: { file } }, {})

  let thrown = null
  try {
    await adapter.importBatch('table:target', {
      batchIndex: 0,
      columns: ['id', 'note'],
      rows: [{ rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: secret }] }]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, '触发器 ABORT 必须让导入失败')
  assert.ok(thrown instanceof Error)

  // 1) cause 里不能有原始数据（只允许结构化码）。
  const cause = thrown.cause
  assert.notEqual(cause, undefined, '导入错误应当带一个安全的 cause（只含结构化码）')
  assert.notEqual(cause, null, '导入错误应当带一个安全的 cause（只含结构化码）')
  const causeJson = JSON.stringify(cause)
  assert.equal(causeJson.includes(secret), false, `cause 里出现了本行数据：${causeJson}`)
  assert.equal(causeJson.includes('rejected:'), false, `cause 里出现了引擎原文：${causeJson}`)

  // 2) RPC 真正传输的形状是 { code, message }：
  //    src/driver-host/index.ts 的 toRpcError 只取 code 与 message，**不序列化 cause**；
  //    src/main/DriverHostHandle.ts 也只用 `${code}: ${message}` 重建 Error。
  //    这里按同一形状再核对一遍，确保链路上任何一环都不会带出数据。
  const rpcPayload = JSON.stringify({ code: thrown.code, message: thrown.message })
  assert.equal(rpcPayload.includes(secret), false, `RPC 载荷里出现了本行数据：${rpcPayload}`)
  assert.equal(thrown.code, 'query_failed', '导入写行失败必须是可信的固定错误码')

  await adapter.rollbackTransaction()
  await adapter.disconnect()
})

test('PostgreSQL：导入失败不携带含数据的原始 cause（RPC 形状核对）', async () => {
  const cellValue = 'not-a-number-42'
  const adapter = await createPgAdapter(() => {
    throw makePgError({
      message: `invalid input syntax for type integer: "${cellValue}"`,
      code: '22P02',
      severity: 'ERROR',
      detail: `Failing row contains (1, ${cellValue})`,
      table: 'users',
      schema: 'public',
      column: 'age'
    })
  })

  let thrown = null
  try {
    await adapter.importBatch('table:public.users', {
      batchIndex: 0,
      columns: ['id', 'age'],
      rows: [{ rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: cellValue }] }]
    })
  } catch (error) {
    thrown = error
  }

  assert.notEqual(thrown, null, 'PG 报错必须让导入失败')
  assert.ok(thrown instanceof Error)

  const cause = thrown.cause
  assert.notEqual(cause, undefined, '导入错误应当带一个安全的 cause（只含结构化码）')
  const causeJson = JSON.stringify(cause)
  assert.equal(causeJson.includes(cellValue), false, `cause 里出现了本行数据：${causeJson}`)
  assert.equal(causeJson.includes('invalid input syntax'), false, `cause 里出现了引擎原文：${causeJson}`)
  assert.equal(causeJson.includes('22P02'), true, `cause 里应当保留可信的 SQLSTATE：${causeJson}`)

  const rpcPayload = JSON.stringify({ code: thrown.code, message: thrown.message })
  assert.equal(rpcPayload.includes(cellValue), false, `RPC 载荷里出现了本行数据：${rpcPayload}`)
  assert.equal(thrown.code, 'query_failed', '导入写行失败必须是可信的固定错误码')

  await adapter.disconnect()
})

// ---------------------------------------------------------------------------
// 8) PostgreSQL：导入 COMMIT / ROLLBACK 失败时的脱敏
//    DEFERRABLE INITIALLY DEFERRED 约束触发器可以在 COMMIT 时才
//    RAISE EXCEPTION 'bad: %', NEW.note —— 错误原文直接带着本行 CSV 值。
//    旧实现走 #execControl → wrapPgError，会把原文拼进 message 一路到 renderer。
// ---------------------------------------------------------------------------

test('PostgreSQL：导入 COMMIT 失败（DEFERRABLE 触发器 RAISE）不得回显 CSV 数据，保留 SQLSTATE 且不误标空闲', async () => {
  const secret = 'top-secret-note-42'
  const fragment = secret.slice(0, 8) // 裁切片段：整值匹配式抹除挡不住
  let commitAttempts = 0
  const adapter = await createPgAdapter(
    // 每一行都写成功，问题留到 COMMIT 才爆发。
    () => ({ rows: [], rowCount: 1 }),
    {
      controlHandler: (statement) => {
        if (statement !== 'COMMIT') return undefined
        commitAttempts += 1
        throw makePgError({
          message: `bad: ${secret} (fragment ${fragment})`,
          code: 'P0001', // PL/pgSQL raise_exception
          severity: 'ERROR',
          detail: `Key (note)=(${secret})`,
          table: 'users',
          schema: 'public',
          constraint: 'users_note_deferred'
        })
      }
    }
  )

  // 1) 先确认写入路径本身成功（问题只在 COMMIT）。
  const result = await adapter.importBatch('table:public.users', {
    batchIndex: 0,
    columns: ['id', 'age'],
    rows: [
      { rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: '5' }] },
      { rowNumber: 2, lineNumber: 3, values: [{ kind: 'text', text: '2' }, { kind: 'text', text: '6' }] }
    ]
  })
  assert.equal(result.rowsImported, 2, '写入阶段应成功，两行都算已导入')
  assert.equal(result.inTransaction, true, '导入批次结束时事务应仍然打开')

  // 2) COMMIT 抛错。
  let thrown = null
  try {
    await adapter.commitTransaction()
  } catch (error) {
    thrown = error
  }
  assert.notEqual(thrown, null, 'COMMIT 失败必须向上抛出')
  assert.equal(commitAttempts, 1, '必须真的向服务端发过一次 COMMIT')
  assert.ok(thrown instanceof Error)
  const message = thrown.message

  // 契约：CSV 原值、裁切片段、引擎原文都不得出现。
  assertNoValue(message, secret, 'PG COMMIT 失败摘要')
  assertNoValue(message, fragment, 'PG COMMIT 失败摘要（裁切片段）')
  assert.equal(message.includes('bad:'), false, `不得回显引擎原文\n消息：${message}`)
  // 结构化信息 + 固定类别必须保留，否则用户无从下手。
  assert.match(message, /导入事务提交失败/, '必须给出固定措辞的类别')
  assert.match(message, /SQLSTATE P0001/, '必须保留可信的 SQLSTATE')
  assert.match(message, /users_note_deferred/, '可保留约束名这类目录对象名（不是数据）')

  // cause 只带结构化码，且保住 SQLSTATE。
  const cause = thrown.cause
  assert.notEqual(cause, undefined, '导入错误应带安全 cause')
  const causeJson = JSON.stringify(cause)
  assert.equal(causeJson.includes(secret), false, `cause 里出现了本行数据：${causeJson}`)
  assert.equal(causeJson.includes(fragment), false, `cause 里出现了裁切片段：${causeJson}`)
  assert.equal(causeJson.includes('bad:'), false, `cause 里出现了引擎原文：${causeJson}`)
  assert.equal(causeJson.includes('P0001'), true, `cause 应保留可信的 SQLSTATE：${causeJson}`)

  // RPC 真正传输的形状 { code, message } 也不能带数据。
  const rpcPayload = JSON.stringify({ code: thrown.code, message: thrown.message })
  assert.equal(rpcPayload.includes(secret), false, `RPC 载荷里出现了本行数据：${rpcPayload}`)
  assert.equal(thrown.code, 'query_failed', 'COMMIT 失败必须是可信的固定错误码')

  // 3) 关键：COMMIT 失败不能把事务假标为已结束。
  assert.equal(
    (await adapter.transactionState()).active,
    true,
    'COMMIT 失败后事务必须仍报告为活动，不能假标为空闲'
  )

  // 4) 回滚收尾仍然正常工作。
  const rolledBack = await adapter.rollbackTransaction()
  assert.equal(rolledBack.active, false, 'COMMIT 失败后仍能正常回滚')
  assert.equal((await adapter.transactionState()).active, false, '回滚成功后应报告空闲')

  await adapter.disconnect()
})

test('PostgreSQL：导入 ROLLBACK 失败同样脱敏，且事务状态保守保留为活动', async () => {
  const secret = 'top-secret-note-9'
  let rollbackThrows = 0
  const adapter = await createPgAdapter(
    () => ({ rows: [], rowCount: 1 }),
    {
      controlHandler: (statement) => {
        // 只让第一次 ROLLBACK 失败（disconnect 收尾那次保持成功）。
        if (statement === 'ROLLBACK' && rollbackThrows === 0) {
          rollbackThrows += 1
          throw makePgError({
            message: `bad: ${secret}`,
            code: 'P0001',
            severity: 'ERROR',
            detail: `Value (${secret})`,
            table: 'users',
            schema: 'public'
          })
        }
        return undefined
      }
    }
  )

  const result = await adapter.importBatch('table:public.users', {
    batchIndex: 0,
    columns: ['id', 'age'],
    rows: [{ rowNumber: 1, lineNumber: 2, values: [{ kind: 'text', text: '1' }, { kind: 'text', text: '5' }] }]
  })
  assert.equal(result.rowsImported, 1, '写入阶段应成功')
  assert.equal(result.inTransaction, true, '导入批次结束时事务应仍然打开')

  let thrown = null
  try {
    await adapter.rollbackTransaction()
  } catch (error) {
    thrown = error
  }
  assert.notEqual(thrown, null, 'ROLLBACK 失败必须向上抛出')
  assert.ok(thrown instanceof Error)
  const message = thrown.message
  assertNoValue(message, secret, 'PG ROLLBACK 失败摘要')
  assert.equal(message.includes('bad:'), false, `不得回显引擎原文\n消息：${message}`)
  assert.match(message, /导入事务回滚失败/, '必须给出固定措辞的类别')
  assert.match(message, /SQLSTATE P0001/, '必须保留可信的 SQLSTATE')

  const causeJson = JSON.stringify(thrown.cause)
  assert.equal(causeJson.includes(secret), false, `cause 里出现了本行数据：${causeJson}`)
  assert.equal(causeJson.includes('P0001'), true, `cause 应保留可信的 SQLSTATE：${causeJson}`)

  // 关键：ROLLBACK 失败后事务状态必须保守保留为活动，不能误清。
  const state = await adapter.transactionState()
  assert.equal(state.active, true, 'ROLLBACK 失败后事务状态必须保守保留为活动')
  assert.equal(state.pendingAffected, result.rowsImported, '累计影响行数也应保留')

  await adapter.disconnect()
})

test('PostgreSQL：反向证明——旧 COMMIT 包装（wrapPgError）必然泄漏原文，本修复针对性堵住', async () => {
  // 修复前的 commitTransaction → #execControl 就是这一句：
  //   throw wrapPgError(thrown, 'query_failed', 'COMMIT 执行失败')
  // 用同一个 helper、同一个前缀、同一个形状的服务端错误，证明旧实现会把
  // 带 CSV 值的原文拼进 message（→ 经 RPC 的 message 泄漏到 renderer）。
  // 若本断言失败，说明旧路径其实不漏，那本次修复的前提就不成立。
  const { wrapPgError } = await loadTs('src/drivers/postgresql/errors.ts')
  const secret = 'top-secret-note-42'
  const serverError = makePgError({
    message: `bad: ${secret}`,
    code: 'P0001',
    severity: 'ERROR'
  })
  const oldStyle = wrapPgError(serverError, 'query_failed', 'COMMIT 执行失败')
  assert.equal(
    oldStyle.message.includes(secret),
    true,
    '旧实现会把 CSV 值拼进 COMMIT 错误 message —— 证明旧版本确实会漏'
  )
  assert.equal(
    oldStyle.message.includes('bad:'),
    true,
    '旧实现会回显引擎原文 —— 证明旧版本确实会漏'
  )
})
