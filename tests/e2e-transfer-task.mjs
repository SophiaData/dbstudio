/**
 * P2.1 流式导出任务的端到端验证。
 *
 * ===== 覆盖什么 =====
 *
 *   1. 真实 SQLite 连接（不是 mock）：连接失败即测试失败
 *   2. 四种格式：csv / jsonl / json / sql-insert，解析并核对内容
 *   3. 多批次（行数 > 默认页 200）与批大小边界（1 行、恰好等于批大小）
 *   4. 长字段：被截断的值必须**拒绝**导出，不能静默写预览
 *   5. 取消：目标文件不产生、临时文件被清掉
 *   6. 失败清理：来源抛错 → 任务失败 → 临时文件删除 → **既有目标文件不受损**
 *   7. 目标覆盖保护：导出目标是源库文件 / 其附属文件 / 其符号链接真实路径时必须拒绝
 *
 * 已知未覆盖（不在本文件的断言范围内）：SQLite 文本里含 NUL 字节时，
 * `node:sqlite` 在绑定层就把 NUL 之后的内容截掉了，导出层看不到标记、
 * 无法检测，会静默写出不完整的内容。详见 src/core/transfer.ts 的说明。
 *
 * PostgreSQL 分支（需要 DBSTUDIO_PG_URL，未配置时明确跳过）：
 *   - CSV 导出并核对内容；
 *   - **自由 SQL 来源做 sql-insert 必须被拒绝**（没有表落点）；
 *   - **表来源**做 sql-insert：生成的 INSERT 带 schema 限定、用 E 字面量，
 *     并把导出的语句**逐条执行回 PG**（写进另一张表）验证行数与数据一致。
 *
 * 运行：node tests/e2e-transfer-task.mjs
 * 前置：node scripts/make-fixture.mjs && node scripts/build-driver-host.mjs
 */

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')

// ---------------------------------------------------------------------------
// 断言框架
// ---------------------------------------------------------------------------

const results = []

function check(name, condition, detail) {
  const passed = Boolean(condition)
  results.push({ name, passed, detail })
  if (passed) {
    console.log(`PASS  ${name}`)
  } else {
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log(`      ↳ ${formatDetail(detail)}`)
  }
  return passed
}

function skip(name, reason) {
  results.push({ name, passed: true, skipped: true, detail: reason })
  console.log(`SKIP  ${name}`)
  console.log(`      ↳ ${reason}`)
}

function formatDetail(detail) {
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

// ---------------------------------------------------------------------------
// 载入被测模块
// ---------------------------------------------------------------------------

/**
 * 用 vite 把主进程层的两个模块打进 out/ 再 import。
 *
 * 为什么需要打包：项目没有 tsx/ts-node，Node 不认 TS。
 * vite 是直接依赖，打包目标不 import electron，系统 node 可直接跑
 * （与 tests/e2e-persist.mjs 同一套路）。
 *
 * 入口文件在运行时生成到 out/ 下（out/ 已被 .gitignore 忽略），
 * 仓库里不留测试专用入口文件。
 */
async function loadModules() {
  const { build } = await import('vite')
  const outDir = resolve(root, 'out/.transfer-probe')
  const entryDir = resolve(outDir, 'src')
  mkdirSync(entryDir, { recursive: true })
  const entry = resolve(entryDir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export { TransferManager } from ${JSON.stringify(resolve(root, 'src/main/TransferManager.ts'))}`,
      `export { ConnectionManager } from ${JSON.stringify(resolve(root, 'src/main/ConnectionManager.ts'))}`,
      `export { ConnectionStore } from ${JSON.stringify(resolve(root, 'src/main/ConnectionStore.ts'))}`,
      ''
    ].join('\n'),
    'utf8'
  )
  await build({
    configFile: false,
    root,
    logLevel: 'error',
    build: {
      outDir,
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      ssr: true,
      rollupOptions: {
        external: [/^node:/, 'electron'],
        output: { entryFileNames: 'probe.cjs' }
      },
      lib: { entry, formats: ['cjs'] }
    }
  })
  const bundle = resolve(outDir, 'probe.cjs')
  if (!existsSync(bundle)) throw new Error(`vite 未产出 ${bundle}`)
  return import(`file://${bundle}`)
}

// ---------------------------------------------------------------------------
// 夹具：真实的 SQLite 库
// ---------------------------------------------------------------------------

/**
 * 造一个真实的 SQLite 库。
 *
 * 为什么要自己造而不是用 tests/fixtures/sample.db：
 * sample.db 是**别的**测试的产物，行数与列型由那边决定，
 * 本文件需要确定的行数（多批次 / 边界）与长字段，
 * 依赖别人的夹具会让断言随对方改动而失效。
 */
function makeDb(dir) {
  const file = join(dir, 'transfer.db')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE users (
      id    INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      note  TEXT
    );
    CREATE TABLE tiny (id INTEGER PRIMARY KEY, v TEXT);
    CREATE TABLE wide (id INTEGER PRIMARY KEY, body TEXT);
    CREATE VIEW active_users AS SELECT id, email FROM users;
  `)
  const insertUser = db.prepare('INSERT INTO users (id, email, note) VALUES (?, ?, ?)')
  for (let i = 1; i <= 500; i += 1) {
    insertUser.run(i, `user${i}@example.com`, `note-${i}`)
  }
  // 一行 note 为 NULL：用来验证 NULL 的文本表示（NULL 与空串是两回事）
  insertUser.run(501, 'user501@example.com', null)
  db.prepare('INSERT INTO tiny (id, v) VALUES (1, ?)').run('one')
  // 恰好等于默认批大小（200）：用来验"正好一批"时不能漏行
  const insertTiny = db.prepare('INSERT INTO tiny (id, v) VALUES (?, ?)')
  for (let i = 2; i <= 200; i += 1) insertTiny.run(i, `v${i}`)
  // 长字段：超过 MAX_CELL_TEXT_CHARS（1000），结果集通道会截断
  db.prepare('INSERT INTO wide (id, body) VALUES (1, ?)').run('x'.repeat(5000))
  db.close()
  return file
}

/** 让某个 host 子进程跑起来（必要时先构建宿主产物）。 */
async function ensureDriverHost() {
  if (existsSync(hostEntry)) return
  const result = spawn(process.execPath, [resolve(root, 'scripts/build-driver-host.mjs')], {
    stdio: 'inherit'
  })
  const code = await new Promise((res) => result.on('exit', res))
  if (code !== 0 || !existsSync(hostEntry)) {
    throw new Error('构建驱动宿主失败，无法运行导出测试')
  }
}

/**
 * PostgreSQL 分支：真实 PG 连接 + 真实导出。
 *
 * 用 `generate_series` 造数据，**不猜 schema**（不需要知道库里有什么表），
 * 只用自由 SQL 来源。导出后把结果导回一个临时表，验证
 * "导出的 INSERT 语句确实能执行、且数据一致"——这比只比对文本更有意义。
 */
async function runPostgresBranch(modules, workDir, pgUrl) {
  const { ConnectionManager, ConnectionStore } = modules
  const url = new URL(pgUrl)
  const options = {
    host: url.hostname,
    port: url.port === '' ? '5432' : url.port,
    database: decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres'),
    user: decodeURIComponent(url.username || 'postgres')
  }
  const password = url.password === '' ? undefined : decodeURIComponent(url.password)

  const manager = new ConnectionManager(
    [
      {
        id: 'postgresql',
        name: 'PostgreSQL',
        fields: [
          { key: 'host', label: '主机', kind: 'text', required: true },
          { key: 'port', label: '端口', kind: 'number', required: true },
          { key: 'database', label: '数据库', kind: 'text', required: true },
          { key: 'user', label: '用户名', kind: 'text', required: true },
          { key: 'password', label: '密码', kind: 'password', secretKey: 'dbPassword', required: false }
        ],
        quoting: { open: '"', close: '"', escape: 'double' },
        scriptRules: { statements: [], delimiters: [] }
      }
    ],
    new ConnectionStore({
      baseDir: join(workDir, 'store-pg'),
      cipher: {
        encrypt: (plain) => Buffer.from(plain, 'utf8'),
        decrypt: (payload) => payload.toString('utf8')
      }
    })
  )
  const summary = await manager.add(
    { dialectId: 'postgresql', name: 'pg-transfer', options },
    password
  )
  if (!summary.connected) {
    check('PostgreSQL 连接真实建立成功', false, summary)
    await manager.disposeAll()
    return
  }
  check('PostgreSQL 连接真实建立成功', summary.connected === true)

  const nodeId = `connection:${summary.id}`

  // CSV 导出
  const csvPath = join(workDir, 'pg.csv')
  const csvProgress = manager.startTransfer({
    source: {
      nodeId,
      sql: "SELECT g AS id, 'name-' || g AS name, CASE WHEN g % 2 = 0 THEN NULL ELSE 'odd' END AS tag FROM generate_series(1, 300) g"
    },
    format: 'csv',
    destinationPath: csvPath
  })
  const csvResult = await manager.waitTransfer(csvProgress.taskId)
  const csvLines = existsSync(csvPath)
    ? readFileSync(csvPath, 'utf8').split('\r\n').filter((line) => line !== '')
    : []
  check('PG CSV 导出成功', csvResult.status === 'completed', csvResult)
  check('PG CSV 行数 = 300 + 表头', csvLines.length === 301, { got: csvLines.length })
  check('PG CSV 表头正确', csvLines[0] === 'id,name,tag', csvLines[0])
  check('PG CSV 第二行内容正确', csvLines[1] === '1,name-1,odd', csvLines[1])

  // 自由 SQL 来源做 sql-insert 必须被拒绝（没有表落点）
  const freeSqlPath = join(workDir, 'pg-free.sql')
  const freeSqlProgress = manager.startTransfer({
    source: {
      nodeId,
      sql: "SELECT g AS id, 'name-' || g AS name FROM generate_series(1, 50) g"
    },
    format: 'sql-insert',
    destinationPath: freeSqlPath
  })
  const freeSqlResult = await manager.waitTransfer(freeSqlProgress.taskId)
  check('PG 自由 SQL 源做 sql-insert 被拒绝', freeSqlResult.status === 'failed', freeSqlResult)
  check('PG 自由 SQL 拒绝原因说明缺少表来源', /表来源/.test(freeSqlResult.message ?? ''), freeSqlResult.message)
  check('PG 自由 SQL 拒绝后没有产出目标文件', !existsSync(freeSqlPath))

  // 表来源做 sql-insert：生成带 schema 限定的 INSERT，并真的执行回 PG
  const tableName = `transfer_src_${Date.now()}`
  await manager.executeStatement(nodeId, `CREATE TABLE public.${tableName} (id integer, name text)`)
  await manager.executeStatement(
    nodeId,
    `INSERT INTO public.${tableName} SELECT g, 'name-' || g FROM generate_series(1, 50) g`
  )
  const sqlPath = join(workDir, 'pg.sql')
  const sqlProgress = manager.startTransfer({
    source: { nodeId: `${nodeId}|table:public.${tableName}` },
    format: 'sql-insert',
    destinationPath: sqlPath
  })
  const sqlResult = await manager.waitTransfer(sqlProgress.taskId)
  check('PG SQL INSERT 导出成功', sqlResult.status === 'completed', sqlResult)
  const sqlText = existsSync(sqlPath) ? readFileSync(sqlPath, 'utf8') : ''
  check(
    'PG SQL INSERT 表名带 schema 限定（public）',
    sqlText.includes(`INSERT INTO "public"."${tableName}"`) === true,
    sqlText.split('\n')[0]
  )
  check(
    'PG SQL INSERT 使用 E 字面量',
    sqlText.includes("E'name-1'") === true,
    sqlText.split('\n')[0]
  )

  // 把导出的 INSERT 真的执行到另一张表，验证语句可用且数据一致
  const targetTable = `${tableName}_copy`
  await manager.executeStatement(nodeId, `CREATE TABLE public.${targetTable} (id integer, name text)`)
  // 一次只能执行一条语句（工作台的既有约束），所以逐条执行。
  const insertStatements = sqlText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.replaceAll(`"public"."${tableName}"`, `"public"."${targetTable}"`))
  for (const statement of insertStatements) {
    await manager.executeStatement(nodeId, statement)
  }
  const copied = await manager.runQuery(nodeId, `SELECT count(*)::int AS n, sum(id)::int AS s FROM public.${targetTable}`)
  check(
    'PG 导出的 INSERT 可执行且行数一致（50 行）',
    copied.rows[0]?.cells[0]?.value === 50,
    copied.rows[0]?.cells[0]
  )
  check(
    'PG 导出的 INSERT 数据一致（id 求和 = 1275）',
    copied.rows[0]?.cells[1]?.value === 1275,
    copied.rows[0]?.cells[1]
  )

  // 清理测试表
  await manager.executeStatement(nodeId, `DROP TABLE public.${targetTable}`)
  await manager.executeStatement(nodeId, `DROP TABLE public.${tableName}`)

  await manager.disposeAll()
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-transfer-'))
  const dbFile = makeDb(workDir)

  let modules
  try {
    await ensureDriverHost()
    modules = await loadModules()
  } catch (err) {
    console.error('[e2e-transfer-task] 无法准备被测模块:', err)
    process.exit(1)
  }
  const { ConnectionManager, ConnectionStore, TransferManager } = modules

  // ---- 真实 SQLite 连接（必须成功） ----
  const store = new ConnectionStore({
    baseDir: join(workDir, 'store'),
    cipher: {
      encrypt: (plain) => Buffer.from(plain, 'utf8'),
      decrypt: (payload) => payload.toString('utf8')
    }
  })
  const manager = new ConnectionManager(
    [
      {
        id: 'sqlite',
        name: 'SQLite',
        fields: [{ key: 'file', label: '数据库文件', kind: 'file', required: true }],
        quoting: { open: '"', close: '"', escape: 'double' },
        scriptRules: { statements: [], delimiters: [] }
      }
    ],
    store
  )
  const summary = await manager.add(
    { dialectId: 'sqlite', name: 'transfer-test', options: { file: dbFile } },
    undefined
  )
  if (!summary.connected) {
    console.error('[e2e-transfer-task] SQLite 连接未建立成功，测试失败')
    console.error('[e2e-transfer-task] 摘要:', JSON.stringify(summary))
    process.exit(1)
  }
  check('SQLite 连接真实建立成功', summary.connected === true, summary)
  const connectionId = summary.id
  const tableNode = `connection:${connectionId}|table:users`

  // ---- 1) 四种格式 ----
  const csvPath = join(workDir, 'users.csv')
  const csvProgress = manager.startTransfer({
    source: { nodeId: tableNode },
    format: 'csv',
    destinationPath: csvPath
  })
  const csvResult = await manager.waitTransfer(csvProgress.taskId)
  check('CSV 导出成功', csvResult.status === 'completed', csvResult)
  const csvText = existsSync(csvPath) ? readFileSync(csvPath, 'utf8') : ''
  const csvLines = csvText.split('\r\n').filter((line) => line !== '')
  check('CSV 行数 = 表行数 + 表头', csvLines.length === 502, { got: csvLines.length })
  check('CSV 表头正确', csvLines[0] === 'id,email,note', csvLines[0])
  check('CSV 第一行数据正确', csvLines[1] === '1,user1@example.com,note-1', csvLines[1])
  check('CSV 最后一行数据正确', csvLines[500] === '500,user500@example.com,note-500', csvLines[500])

  const jsonlPath = join(workDir, 'users.jsonl')
  const jsonlProgress = manager.startTransfer({
    source: { nodeId: tableNode },
    format: 'jsonl',
    destinationPath: jsonlPath
  })
  const jsonlResult = await manager.waitTransfer(jsonlProgress.taskId)
  check('JSONL 导出成功', jsonlResult.status === 'completed', jsonlResult)
  const jsonlLines = existsSync(jsonlPath)
    ? readFileSync(jsonlPath, 'utf8').split('\n').filter((line) => line !== '')
    : []
  check('JSONL 行数 = 表行数', jsonlLines.length === 501, { got: jsonlLines.length })
  let firstJsonl = null
  try {
    firstJsonl = JSON.parse(jsonlLines[0])
  } catch (err) {
    firstJsonl = { error: String(err) }
  }
  check(
    'JSONL 首行是对象且字段完整',
    firstJsonl !== null && firstJsonl.id === 1 && firstJsonl.email === 'user1@example.com',
    firstJsonl
  )

  const jsonPath = join(workDir, 'users.json')
  const jsonProgress = manager.startTransfer({
    source: { nodeId: tableNode },
    format: 'json',
    destinationPath: jsonPath
  })
  const jsonResult = await manager.waitTransfer(jsonProgress.taskId)
  check('JSON 导出成功', jsonResult.status === 'completed', jsonResult)
  let parsedJson = null
  try {
    parsedJson = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch (err) {
    parsedJson = { error: String(err) }
  }
  check('JSON 是数组且长度正确', Array.isArray(parsedJson) && parsedJson.length === 501, {
    isArray: Array.isArray(parsedJson),
    length: Array.isArray(parsedJson) ? parsedJson.length : -1
  })
  check(
    'JSON 首元素字段完整',
    Array.isArray(parsedJson) &&
      parsedJson[0]?.id === 1 &&
      parsedJson[0]?.email === 'user1@example.com' &&
      parsedJson[0]?.note === 'note-1',
    Array.isArray(parsedJson) ? parsedJson[0] : null
  )
  check(
    'JSON 末元素正确',
    Array.isArray(parsedJson) && parsedJson[499]?.id === 500,
    Array.isArray(parsedJson) ? parsedJson[499] : null
  )

  const sqlPath = join(workDir, 'users.sql')
  const sqlProgress = manager.startTransfer({
    source: { nodeId: tableNode },
    format: 'sql-insert',
    destinationPath: sqlPath
  })
  const sqlResult = await manager.waitTransfer(sqlProgress.taskId)
  check('SQL INSERT 导出成功', sqlResult.status === 'completed', sqlResult)
  const sqlText = existsSync(sqlPath) ? readFileSync(sqlPath, 'utf8') : ''
  const sqlLinesOut = sqlText.split('\n').filter((line) => line.trim() !== '')
  check('SQL INSERT 语句数 = 表行数', sqlLinesOut.length === 501, { got: sqlLinesOut.length })
  check(
    'SQL INSERT 使用 schema 限定的表名',
    sqlLinesOut[0]?.startsWith('INSERT INTO "main"."users" ("id", "email", "note") VALUES (') === true,
    sqlLinesOut[0]
  )
  check(
    'SQL INSERT 字符串字面量正确转义',
    sqlLinesOut[0]?.includes("'user1@example.com'") === true,
    sqlLinesOut[0]
  )
  // ---- 1b) 零行结果：四种格式都必须生成合法空文件 ----
  for (const [format, extension, expected] of [
    ['csv', 'csv', 'id,name\r\n'],
    ['jsonl', 'jsonl', ''],
    ['json', 'json', '[]'],
    ['sql-insert', 'sql', '']
  ]) {
    const emptyPath = join(workDir, `empty.${extension}`)
    const emptyTransfers = new TransferManager({
      openSource: async () => ({
        columns: ['id', 'name'],
        dialectId: 'sqlite',
        target: { name: 'users', kind: 'table' },
        read: async () => ({ rows: [], done: true }),
        close: async () => {}
      })
    })
    const emptyProgress = emptyTransfers.start({
      source: { nodeId: 'connection:empty|table:users' },
      format,
      destinationPath: emptyPath
    })
    const emptyResult = await emptyTransfers.wait(emptyProgress.taskId)
    const emptyText = existsSync(emptyPath) ? readFileSync(emptyPath, 'utf8') : ''
    check(`${format} 零行导出成功`, emptyResult.status === 'completed', emptyResult)
    // 独立断言文件真的落盘：否则文件不存在时空文本与期望值相同会假阳性
    // （jsonl / sql 的期望值本身就是空串）
    check(`${format} 零行目标文件存在`, existsSync(emptyPath) === true, emptyPath)
    check(`${format} 零行输出正确`, emptyText === expected, JSON.stringify(emptyText))
  }

  const progressAfterCsv = manager.getTransferProgress(csvProgress.taskId)
  check('进度记录了多批次（501 行 / 默认批 200 → 3 批）', progressAfterCsv?.batches === 3, {
    batches: progressAfterCsv?.batches,
    rowsRead: progressAfterCsv?.rowsRead
  })
  check('进度行数 = 501', progressAfterCsv?.rowsRead === 501, progressAfterCsv?.rowsRead)
  check('进度一致性标注为 live-paged（非快照）', progressAfterCsv?.consistency === 'live-paged', {
    consistency: progressAfterCsv?.consistency
  })
  check('进度字节数大于 0', (progressAfterCsv?.bytesWritten ?? 0) > 0, progressAfterCsv?.bytesWritten)

  const batchedPath = join(workDir, 'batched.csv')
  const batchedProgress = manager.startTransfer({
    source: { nodeId: tableNode },
    format: 'csv',
    destinationPath: batchedPath,
    options: { batchSize: 50 }
  })
  const batchedResult = await manager.waitTransfer(batchedProgress.taskId)
  const batchedLines = readFileSync(batchedPath, 'utf8').split('\r\n').filter((line) => line !== '')
  check('指定批大小 50 时导出成功', batchedResult.status === 'completed', batchedResult)
  check('指定批大小 50 时行数仍为 501', batchedLines.length === 502, { got: batchedLines.length })
  check(
    '指定批大小 50 时批次数 = 11',
    manager.getTransferProgress(batchedProgress.taskId)?.batches === 11,
    manager.getTransferProgress(batchedProgress.taskId)?.batches
  )

  // ---- 3) 边界行数（1 行 / 恰好等于批大小）----
  for (const [label, sql, expected] of [
    ['单行表', 'SELECT id, v FROM tiny WHERE id = 1', 1],
    ['恰好等于批大小（200 行）', 'SELECT id, v FROM tiny', 200]
  ]) {
    const path = join(workDir, `edge-${expected}.csv`)
    const progress = manager.startTransfer({
      source: { nodeId: `connection:${connectionId}`, sql },
      format: 'csv',
      destinationPath: path
    })
    const result = await manager.waitTransfer(progress.taskId)
    const lines = existsSync(path)
      ? readFileSync(path, 'utf8').split('\r\n').filter((line) => line !== '')
      : []
    check(`${label}：导出成功`, result.status === 'completed', result)
    check(`${label}：数据行数 = ${expected}`, lines.length === expected + 1, { got: lines.length })
  }

  // ---- 4) 长字段：必须拒绝，不能写预览 ----
  const longPath = join(workDir, 'long.csv')
  const longProgress = manager.startTransfer({
    source: { nodeId: `connection:${connectionId}|table:wide` },
    format: 'csv',
    destinationPath: longPath
  })
  const longResult = await manager.waitTransfer(longProgress.taskId)
  check('长字段被截断时导出失败', longResult.status === 'failed', longResult)
  check('长字段失败原因提到截断', /截断/.test(longResult.message ?? ''), longResult.message)
  check('长字段失败后没有产出目标文件', !existsSync(longPath))
  check(
    '长字段失败后没有残留临时文件',
    readdirSync(workDir).every((file) => !file.includes('.dbstudio-') || !file.endsWith('.tmp')),
    readdirSync(workDir)
  )

  // ---- 5) 取消 ----
  const cancelPath = join(workDir, 'cancelled.csv')
  const cancelProgress = manager.startTransfer({
    source: { nodeId: `connection:${connectionId}`, sql: 'SELECT id, email FROM users' },
    format: 'csv',
    destinationPath: cancelPath,
    options: { batchSize: 10 }
  })
  const cancelled = manager.cancelTransfer(cancelProgress.taskId)
  const cancelResult = await manager.waitTransfer(cancelProgress.taskId)
  check('取消请求被接受', cancelled === true, { cancelled })
  check('取消后任务进入 cancelled 终态', cancelResult.status === 'cancelled', cancelResult)
  check('取消后没有产出目标文件', !existsSync(cancelPath))
  check(
    '取消后没有残留临时文件',
    readdirSync(workDir).every((file) => !file.endsWith('.tmp')),
    readdirSync(workDir)
  )

  // ---- 6) 失败清理与既有文件保全（注入来源，独立于数据库）----
  const transfers = new TransferManager({
    openSource: async () => ({
      columns: ['a'],
      dialectId: 'sqlite',
      read: async () => {
        throw new Error('注入的来源故障')
      },
      close: async () => {}
    })
  })
  const existingPath = join(workDir, 'existing.csv')
  writeFileSync(existingPath, 'ORIGINAL-CONTENT\n', 'utf8')
  const failProgress = transfers.start({
    source: { nodeId: 'connection:c1' },
    format: 'csv',
    destinationPath: existingPath
  })
  const failResult = await transfers.wait(failProgress.taskId)
  check('来源故障时任务失败', failResult.status === 'failed', failResult)
  check('来源故障时目标文件内容未被改动', readFileSync(existingPath, 'utf8') === 'ORIGINAL-CONTENT\n')
  check(
    '来源故障时临时文件已删除',
    readdirSync(workDir).every((file) => !file.endsWith('.tmp')),
    readdirSync(workDir)
  )
  check('失败任务的进度可查询到终态', transfers.get(failProgress.taskId)?.status === 'failed')

  // ---- 6b) 视图不能作为 INSERT 目标 ----
  const viewPath = join(workDir, 'view.sql')
  const viewProgress = manager.startTransfer({
    source: { nodeId: `connection:${connectionId}|view:active_users` },
    format: 'sql-insert',
    destinationPath: viewPath
  })
  const viewResult = await manager.waitTransfer(viewProgress.taskId)
  check('视图作为 INSERT 目标被拒绝', viewResult.status === 'failed', viewResult)
  check('视图 INSERT 失败原因说明不是表', /不是表/.test(viewResult.message ?? ''), viewResult.message)
  check('视图 INSERT 失败后没有产出目标文件', !existsSync(viewPath))

  // ---- 6c) 表头开关与 NULL 文本 ----
  const noHeaderPath = join(workDir, 'no-header.csv')
  const noHeaderProgress = manager.startTransfer({
    source: { nodeId: `connection:${connectionId}`, sql: 'SELECT id, email FROM users WHERE id <= 3' },
    format: 'csv',
    destinationPath: noHeaderPath,
    options: { includeHeader: false }
  })
  const noHeaderResult = await manager.waitTransfer(noHeaderProgress.taskId)
  const noHeaderLines = existsSync(noHeaderPath)
    ? readFileSync(noHeaderPath, 'utf8').split('\r\n').filter((line) => line !== '')
    : []
  check('includeHeader=false 导出成功', noHeaderResult.status === 'completed', noHeaderResult)
  check('includeHeader=false 没有表头行', noHeaderLines.length === 3, { got: noHeaderLines.length })
  check('includeHeader=false 首行是数据', noHeaderLines[0] === '1,user1@example.com', noHeaderLines[0])

  // ---- 6d) NULL 文本表示（真 NULL，不是空串）----
  const nullTextPath = join(workDir, 'null-text.csv')
  const nullTextProgress = manager.startTransfer({
    source: {
      nodeId: `connection:${connectionId}`,
      sql: 'SELECT id, note FROM users WHERE note IS NULL'
    },
    format: 'csv',
    destinationPath: nullTextPath,
    options: { nullText: '\\N' }
  })
  const nullTextResult = await manager.waitTransfer(nullTextProgress.taskId)
  const nullTextLines = existsSync(nullTextPath)
    ? readFileSync(nullTextPath, 'utf8').split('\r\n').filter((line) => line !== '')
    : []
  check('nullText 导出成功', nullTextResult.status === 'completed', nullTextResult)
  check(
    'nullText 按指定文本写出 NULL',
    nullTextLines.length === 2 && nullTextLines[1] === '501,\\N',
    nullTextLines
  )

  // ---- 6e) JSON 重复列名被拒绝 ----
  // 走 DI 缝隙直接注入重复列名：SQLite 驱动会把重名列改成 id / id:1
  // （见 sqlite/results.ts），所以真实 SQLite 路径**造不出**重名列，
  // 但 PostgreSQL 的 pg 驱动会把两列都报成同名——这条检查是必要的。
  const dupPath = join(workDir, 'dup.json')
  const dupTransfers = new TransferManager({
    openSource: async () => ({
      columns: ['id', 'id'],
      dialectId: 'sqlite',
      read: async () => ({ rows: [[{ kind: 'number', value: 1 }, { kind: 'number', value: 2 }]], done: true }),
      close: async () => {}
    })
  })
  const dupProgress = dupTransfers.start({
    source: { nodeId: 'connection:c1' },
    format: 'json',
    destinationPath: dupPath
  })
  const dupResult = await dupTransfers.wait(dupProgress.taskId)
  check('JSON 重复列名被拒绝', dupResult.status === 'failed', dupResult)
  check('JSON 重复列名失败原因提到重复', /重复/.test(dupResult.message ?? ''), dupResult.message)
  check('JSON 重复列名失败后没有产出目标文件', !existsSync(dupPath))

  // ---- 7) 参数校验 ----
  let threw = false
  try {
    transfers.start({ source: { nodeId: 'connection:c1' }, format: 'xml', destinationPath: join(workDir, 'x.xml') })
  } catch {
    threw = true
  }
  check('不支持的格式被拒绝', threw)

  threw = false
  try {
    transfers.start({ source: { nodeId: 'connection:c1' }, format: 'csv', destinationPath: '' })
  } catch {
    threw = true
  }
  check('空目标路径被拒绝', threw)

  threw = false
  try {
    transfers.start({ source: {}, format: 'csv', destinationPath: join(workDir, 'y.csv') })
  } catch {
    threw = true
  }
  check('空来源被拒绝', threw)

  // ---- 8) 批大小越界被拒绝 ----
  threw = false
  try {
    transfers.start({
      source: { nodeId: 'connection:c1' },
      format: 'csv',
      destinationPath: join(workDir, 'z.csv'),
      options: { batchSize: 100000 }
    })
  } catch {
    threw = true
  }
  check('越界批大小被拒绝', threw)

  // ---- 8b) 目标覆盖源数据库文件必须被拒绝（数据破坏防护）----
  // 回归：曾经把导出目标设成正在导出的那个 SQLite 库文件，
  // 原子 rename 会把库文件替换成 CSV —— 数据库直接没了。
  const dbMagicBefore = readFileSync(dbFile)
  let selfOverwriteRejected = false
  let selfOverwriteMessage = ''
  try {
    manager.startTransfer({
      source: { nodeId: tableNode },
      format: 'csv',
      destinationPath: dbFile
    })
  } catch (err) {
    selfOverwriteRejected = true
    selfOverwriteMessage = err instanceof Error ? err.message : String(err)
  }
  check('导出目标为源库文件时被拒绝', selfOverwriteRejected, selfOverwriteMessage)
  check(
    '拒绝原因提到数据库文件',
    /数据库|SQLite/.test(selfOverwriteMessage),
    selfOverwriteMessage
  )
  check(
    '源库文件内容（magic）未被改动',
    Buffer.compare(readFileSync(dbFile), dbMagicBefore) === 0
  )
  check('源库文件仍是 SQLite 库（表可读）', (() => {
    const db = new DatabaseSync(dbFile)
    const rows = db.prepare('SELECT count(*) AS n FROM users').all()
    db.close()
    return rows[0]?.n === 501
  })())

  // 文件级符号链接：配置用 alias.db（指向 real.db），导出目标是 real.db。
  // 这两者"路径不同、实为同一文件"，只归一化父目录会漏掉。
  const realDbPath = join(workDir, 'real-target.db')
  const aliasDbPath = join(workDir, 'alias-target.db')
  {
    const copy = new DatabaseSync(realDbPath)
    copy.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    copy.close()
    symlinkSync(realDbPath, aliasDbPath)
  }
  const symlinkManager = new ConnectionManager(
    [
      {
        id: 'sqlite',
        name: 'SQLite',
        fields: [{ key: 'file', label: '数据库文件', kind: 'file', required: true }],
        quoting: { open: '"', close: '"', escape: 'double' },
        scriptRules: { statements: [], delimiters: [] }
      }
    ],
    new ConnectionStore({
      baseDir: join(workDir, 'store-symlink'),
      cipher: {
        encrypt: (plain) => Buffer.from(plain, 'utf8'),
        decrypt: (payload) => payload.toString('utf8')
      }
    })
  )
  const symlinkSummary = await symlinkManager.add(
    { dialectId: 'sqlite', name: 'symlink-db', options: { file: aliasDbPath } },
    undefined
  )
  check('符号链接库连接建立成功', symlinkSummary.connected === true, symlinkSummary)
  let aliasRejected = false
  let aliasMessage = ''
  try {
    symlinkManager.startTransfer({
      source: { nodeId: `connection:${symlinkSummary.id}|table:t` },
      format: 'csv',
      destinationPath: realDbPath
    })
  } catch (err) {
    aliasRejected = true
    aliasMessage = err instanceof Error ? err.message : String(err)
  }
  check('导出目标为源库的符号链接真实路径时被拒绝', aliasRejected, aliasMessage)
  check('符号链接拒绝原因提到数据库文件', /数据库|SQLite/.test(aliasMessage), aliasMessage)
  check(
    '符号链接源文件内容未被改动',
    (() => {
      const db = new DatabaseSync(realDbPath)
      const rows = db.prepare('SELECT count(*) AS n FROM t').all()
      db.close()
      return rows[0]?.n === 0
    })()
  )
  await symlinkManager.disposeAll()

  // 附属文件（WAL / SHM / journal）同样要挡住
  for (const suffix of ['-wal', '-shm', '-journal']) {
    let rejected = false
    try {
      manager.startTransfer({
        source: { nodeId: tableNode },
        format: 'csv',
        destinationPath: `${dbFile}${suffix}`
      })
    } catch {
      rejected = true
    }
    check(`导出目标为源库附属文件 ${suffix} 时被拒绝`, rejected)
  }

  // ---- 9) 断开连接时任务有终态 ----
  const disconnectPath = join(workDir, 'disconnect.csv')
  const disconnectProgress = manager.startTransfer({
    source: { nodeId: `connection:${connectionId}`, sql: 'SELECT id, email FROM users' },
    format: 'csv',
    destinationPath: disconnectPath,
    options: { batchSize: 10 }
  })
  await manager.disconnectConnection(connectionId)
  const disconnectResult = await manager.waitTransfer(disconnectProgress.taskId)
  check(
    '断开连接后任务进入终态',
    ['completed', 'failed', 'cancelled'].includes(disconnectResult.status),
    disconnectResult
  )
  check(
    '断开连接后没有残留临时文件',
    readdirSync(workDir).every((file) => !file.endsWith('.tmp')),
    readdirSync(workDir)
  )

  await manager.disposeAll()

  // ---- PostgreSQL：未配置则明确跳过 ----
  const pgUrl = process.env['DBSTUDIO_PG_URL']
  if (!pgUrl) {
    skip('PostgreSQL 导出 e2e', '未配置 DBSTUDIO_PG_URL，跳过（不是静默通过）')
  } else {
    await runPostgresBranch(modules, workDir, pgUrl)
  }

  rmSync(workDir, { recursive: true, force: true })

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.passed)
  const skipped = results.filter((r) => r.skipped)
  console.log(
    `\n[e2e-transfer-task] 通过 ${results.length - failed.length}/${results.length}` +
      `（跳过 ${skipped.length}）`
  )
  if (failed.length > 0) {
    console.error('[e2e-transfer-task] 失败用例:')
    for (const f of failed) console.error(`  - ${f.name}${f.detail === undefined ? '' : ` → ${formatDetail(f.detail)}`}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[e2e-transfer-task] 未捕获异常:', err)
  process.exit(1)
})
