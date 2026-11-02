/**
 * P5 比较的端到端链路：真实 ConnectionManager + 真实 SQLite 驱动宿主。
 *
 * 验证三件事：
 *   1. captureSchemaSnapshot 能从连接读出表结构，diffSchema 给出确定的同步 SQL；
 *   2. compareTableData 按主键分批读取两侧数据（含超过一页、含超长文本）；
 *   3. 整个过程不改动任何一侧数据——同步 SQL 只生成、不执行。
 *
 * 前置：node scripts/build-driver-host.mjs（verify 流程已包含）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(root, 'out/.compare-live-probe-'))
const dataDir = mkdtempSync(join(tmpdir(), 'dbstudio-compare-live-'))
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir,
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    ssr: true,
    rollupOptions: { external: [/^node:/, 'electron'], output: { entryFileNames: 'probe.cjs' } },
    lib: { entry: resolve(root, 'tests/probe-entry.ts'), formats: ['cjs'] }
  }
})
const compareDir = join(outDir, 'compare')
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir: compareDir,
    target: 'node22',
    ssr: true,
    minify: false,
    lib: { entry: resolve(root, 'src/core/compare.ts'), formats: ['cjs'] },
    rollupOptions: { output: { entryFileNames: 'compare.cjs' } }
  }
})
const { createManagerWithBuiltinDialects } = await import(pathToFileURL(join(outDir, 'probe.cjs')).href)
const compare = await import(pathToFileURL(join(compareDir, 'compare.cjs')).href)

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const LONG = 'x'.repeat(3000)
function makeDb(file, variant) {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, bio TEXT)`)
  db.exec(`CREATE TABLE no_pk (a TEXT, b TEXT)`)
  db.prepare('INSERT INTO no_pk VALUES (?, ?)').run('x', 'y')
  db.exec(`CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB)`)
  db.prepare('INSERT INTO blobs VALUES (1, ?)').run(new Uint8Array([1, 2, 3]))
  if (variant === 'source') db.exec(`CREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT)`)
  else db.exec(`CREATE TABLE legacy (id INTEGER PRIMARY KEY)`)
  const insert = db.prepare('INSERT INTO users (id, email, bio) VALUES (?, ?, ?)')
  // 2500 行跨过 1000 行一页的分批边界。
  for (let id = 1; id <= 2500; id += 1) {
    if (variant === 'target' && id === 2500) continue // 源端多出一行 → INSERT
    const email = variant === 'target' && id === 7 ? 'changed@example.test' : `u${id}@example.test`
    // 长文本只在第 9 行末尾不同：截断预览完全相同，只有比较全文才能发现。
    const bio = id === 9 ? LONG + (variant === 'target' ? 'B' : 'A') : null
    insert.run(id, email, bio)
  }
  if (variant === 'target') insert.run(9001, 'extra@example.test', null) // 目标端多出 → DELETE
  // 视图：两侧同名但定义不同，用来验证 viewDefinition 真的把 DDL 读了出来。
  // 早期实现里 definition 硬编码为 null，这里会退化成"看不出定义变化"。
  db.exec(
    variant === 'source'
      ? `CREATE VIEW users_view AS SELECT id, email FROM users WHERE id > 0`
      : `CREATE VIEW users_view AS SELECT id, email FROM users WHERE id > 1`
  )
  db.close()
}
const sourceFile = join(dataDir, 'source.db')
const targetFile = join(dataDir, 'target.db')
makeDb(sourceFile, 'source')
makeDb(targetFile, 'target')

const manager = createManagerWithBuiltinDialects()
try {
  const left = await manager.add({ dialectId: 'sqlite', name: 'left', options: { file: sourceFile } })
  const right = await manager.add({ dialectId: 'sqlite', name: 'right', options: { file: targetFile } })

  console.log('\n[1] 结构快照 → 确定性 diff')
  const s1 = await manager.captureSchemaSnapshot(left.id)
  const t1 = await manager.captureSchemaSnapshot(right.id)
  check('快照读到源端全部表（按名称排序）', s1.tables.map((t) => t.name).join(',') === 'audit,blobs,no_pk,users', s1.tables.map((t) => t.name).join(','))
  check('快照包含列定义', s1.tables.find((t) => t.name === 'users')?.columns.length === 3)
  const diff = compare.diffSchema(s1, t1, 'sqlite')
  const again = compare.diffSchema(await manager.captureSchemaSnapshot(left.id), await manager.captureSchemaSnapshot(right.id), 'sqlite')
  check('两次快照的 diff 完全一致', JSON.stringify(diff) === JSON.stringify(again))
  check('源端独有表生成 CREATE TABLE', diff.statements.some((sql) => sql.startsWith('CREATE TABLE "audit"')), diff.statements.join(' | '))
  check('目标端独有表生成 DROP TABLE 且标危险', diff.statements.includes('DROP TABLE "legacy"') && diff.destructive)

  // ===== 视图定义：真实读到 DDL，且能识别两库定义不同 =====
  const viewEntry = s1.views.find((v) => v.name === 'users_view')
  check('快照捕获到视图', viewEntry !== undefined, JSON.stringify(s1.views.map((v) => v.name)))
  check(
    '视图 definition 是真实 DDL（不再是 null）',
    typeof viewEntry?.definition === 'string' && /CREATE\s+VIEW/i.test(viewEntry.definition),
    JSON.stringify(viewEntry?.definition)
  )
  check(
    '两库视图定义不同被识别为 alter',
    diff.changes.some((c) => c.objectType === 'view' && c.kind === 'alter') &&
      diff.statements.some((sql) => sql.startsWith('DROP VIEW')),
    diff.statements.join(' | ')
  )

  console.log('\n[2] 数据比较（按主键、分批、长值全文）')
  const tableNode = async (connId) => {
    const roots = await manager.listChildren(`connection:${connId}`)
    const folder = roots.find((r) => r.kind === 'folder' && r.name !== '视图') ?? roots[0]
    const tables = await manager.listChildren(folder.id)
    return tables.find((t) => t.name === 'users').id
  }
  const result = await manager.compareTableData({
    sourceTableNodeId: await tableNode(left.id),
    targetTableNodeId: await tableNode(right.id)
  })
  check('默认用主键做比较键', JSON.stringify(result.keyColumns) === '["id"]')
  check('计数：1 INSERT / 2 UPDATE / 1 DELETE', result.plan.insertCount === 1 && result.plan.updateCount === 2 && result.plan.deleteCount === 1,
    JSON.stringify({ i: result.plan.insertCount, u: result.plan.updateCount, d: result.plan.deleteCount }))
  check('超长文本按全文比较出差异', result.rows.some((r) => r.status === 'different' && r.key.id === 9 && r.columns.includes('bio')))
  check('删除被标危险并给出确认提示', result.plan.destructive && result.plan.warnings.length > 0)
  check('行顺序按数值主键', result.rows[0]?.key.id === 1 && result.rows.at(-1)?.key.id === 9001)
  check('长值摘要显示长度与哈希', /^<3001 字符, fnv1a:[0-9a-f]{8}>$/.test(compare.summarizeValue(LONG + 'A')))
  const bioRow = result.rows.find((r) => r.key.id === 9)
  const bioChange = bioRow?.valueChanges?.find((c) => c.column === 'bio')
  check('长值差异给出折叠摘要而不是全文', /^<3001 字符, fnv1a:[0-9a-f]{8}>$/.test(bioChange?.source ?? '') && bioChange?.source !== bioChange?.target,
    JSON.stringify(bioChange))
  const emailChange = result.rows.find((r) => r.key.id === 7)?.valueChanges?.find((c) => c.column === 'email')
  check('短值差异直接显示原值', emailChange?.source === 'u7@example.test' && emailChange?.target === 'changed@example.test', JSON.stringify(emailChange))

  let rejected = ''
  try {
    await manager.compareTableData({
      sourceTableNodeId: await tableNode(left.id),
      targetTableNodeId: await tableNode(right.id),
      maxRows: 100
    })
  } catch (error) {
    rejected = String(error?.message ?? error)
  }
  check('超过上限时拒绝而不是静默截断', rejected.includes('超过 100 行'), rejected)

  let noKey = ''
  try {
    await manager.compareTableData({
      sourceTableNodeId: await tableNode(left.id),
      targetTableNodeId: await tableNode(right.id),
      keyColumns: ['missing']
    })
  } catch (error) {
    noKey = String(error?.message ?? error)
  }
  check('比较键列不存在时报错', noKey.includes('缺少比较键列'), noKey)

  console.log('\n[2b] 拒绝无法可靠比较的情形')
  const reject = async (label, run) => {
    try {
      await run()
      check(label, false, '没有抛错')
    } catch (error) {
      check(label, true, String(error?.message ?? error))
    }
  }
  const tableId = async (connId, name) => {
    const roots = await manager.listChildren(`connection:${connId}`)
    const folder = roots.find((r) => r.kind === 'folder' && r.name !== '视图') ?? roots[0]
    const tables = await manager.listChildren(folder.id)
    return tables.find((t) => t.name === name)?.id
  }
  await reject('无主键表且未指定键时拒绝', () => manager.compareTableData({
    sourceTableNodeId: tableId(left.id, 'no_pk'),
    targetTableNodeId: tableId(right.id, 'no_pk')
  }))
  await reject('含 BLOB 列时拒绝（不猜二进制相等）', () => manager.compareTableData({
    sourceTableNodeId: tableId(left.id, 'blobs'),
    targetTableNodeId: tableId(right.id, 'blobs')
  }))
  const crossDialect = await manager.add({
    dialectId: 'sqlite', name: 'left2', options: { file: sourceFile }
  })
  void crossDialect

  console.log('\n[3] 比较不改动数据')
  await manager.disposeAll()
  const db = new DatabaseSync(targetFile)
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n
  const extra = db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = 9001').get().n
  const legacy = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'legacy'").get().n
  db.close()
  check('目标端行数与表都未变', count === 2500 && extra === 1 && legacy === 1, JSON.stringify({ count, extra, legacy }))
} finally {
  await manager.disposeAll().catch(() => undefined)
  rmSync(outDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(`\n比较链路 ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
