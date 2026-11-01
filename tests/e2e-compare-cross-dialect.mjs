/**
 * 比较功能的**拒绝规则**（外部组，需要真实 PostgreSQL）。
 *
 * 为什么单独一个测试文件：这里验的不是"能比"，而是"**不能比的时候必须拒绝**"。
 * 两类误比都会产出看起来合理、实则灾难的同步计划：
 *
 *   1. **跨方言数据比较**：PostgreSQL 把 int8/numeric 当文本返回，SQLite 当 number，
 *      比较键 `[1]` 与 `["1"]` 会被当成两个不同的键 → 每一行同时生成
 *      INSERT + DELETE，整张表被"同步"成删除重建。
 *   2. **拿只浏览数据源（Redis/Kafka）当结构比较的源端**：它没有表，
 *      快照里 tables 为空，于是目标端所有表都被判成"目标端独有" → 全库 DROP TABLE。
 *
 * 两个用例都要求**明确抛错**，不接受"返回空差异"这种安静的错误答案。
 *
 * 运行：DBSTUDIO_PG_URL=postgres://user:pass@host:port/db node tests/e2e-compare-cross-dialect.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pgUrl = process.env.DBSTUDIO_PG_URL
if (!pgUrl) {
  console.error('缺少 DBSTUDIO_PG_URL：拒绝规则必须在真实方言上验证，不允许静默跳过')
  process.exit(1)
}
const redisUrl = process.env.DBSTUDIO_REDIS_URL

const outDir = mkdtempSync(join(root, 'out/.compare-guards-'))
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
const { createManagerWithBuiltinDialects } = await import(pathToFileURL(join(outDir, 'probe.cjs')).href)

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
const expectReject = async (label, pattern, run) => {
  try {
    await run()
    check(label, false, '没有抛错')
  } catch (error) {
    const message = String(error?.message ?? error)
    check(label, pattern.test(message), message)
  }
}

const work = mkdtempSync(join(tmpdir(), 'dbstudio-compare-guards-'))
const file = join(work, 'guards.db')
const db = new DatabaseSync(file)
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
db.prepare('INSERT INTO t VALUES (1, ?)').run('x')
db.close()

const url = new URL(pgUrl)
const manager = createManagerWithBuiltinDialects()
try {
  const sqlite = await manager.add({ dialectId: 'sqlite', name: 'guards-sqlite', options: { file } })
  const pg = await manager.add(
    {
      dialectId: 'postgresql',
      name: 'guards-pg',
      options: {
        host: url.hostname,
        port: Number(url.port || 5432),
        database: decodeURIComponent(url.pathname.slice(1) || 'postgres'),
        user: decodeURIComponent(url.username || 'postgres')
      }
    },
    url.password ? { dbPassword: decodeURIComponent(url.password) } : undefined
  )
  check('两个 SQL 数据源都连上了', sqlite.connected && pg.connected)

  // 找 PG 里的 public.t（由调用方准备，或用 psql 建好）
  const schemas = await manager.listChildren((await manager.listChildren(`connection:${pg.id}`))[0].id)
  const publicSchema = schemas.find((n) => n.name === 'public') ?? schemas[0]
  const folders = await manager.listChildren(publicSchema.id)
  const tablesFolder = folders.find((f) => f.name.includes('表')) ?? folders[0]
  const pgTables = (await manager.listChildren(tablesFolder.id)).filter((n) => n.kind === 'table')
  check('PostgreSQL 侧读到表', pgTables.length > 0, JSON.stringify(pgTables.map((t) => t.name)))

  const sqliteTables = await manager.listChildren((await manager.listChildren(`connection:${sqlite.id}`))[0].id)
  const sqliteTable = sqliteTables.find((n) => n.name === 't')
  check('SQLite 侧读到表', sqliteTable !== undefined)

  await expectReject(
    '跨方言数据比较被拒绝（sqlite → postgresql）',
    /跨方言数据比较暂不支持/,
    () => manager.compareTableData({
      sourceTableNodeId: sqliteTable.id,
      targetTableNodeId: pgTables[0].id
    })
  )

  if (redisUrl !== undefined) {
    const rurl = new URL(redisUrl)
    const redis = await manager.add({
      dialectId: 'redis',
      name: 'guards-redis',
      options: { host: rurl.hostname, port: Number(rurl.port || 6379) }
    })
    check('Redis 连上了', redis.connected === true)
    await expectReject(
      '只浏览数据源不能拍结构快照',
      /没有表结构，不能参与结构比较/,
      () => manager.captureSchemaSnapshot(redis.id)
    )
  } else {
    console.log('  ⊘ 未设置 DBSTUDIO_REDIS_URL，跳过 Redis 快照用例')
  }
} finally {
  await manager.disposeAll().catch(() => undefined)
  rmSync(outDir, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n比较拒绝规则 ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
