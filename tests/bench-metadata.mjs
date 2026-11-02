/**
 * 元数据性能基线：读取次数与懒加载纪律。
 *
 * 核心门槛（P7.1 Step 3）：**未展开的 schema 不得触发全部表结构读取**。
 *
 * 做法：对真实 `DriverHostHandle.describeTable` 打桩计数，观察
 *   - 只逐层展开目录树（连接 → 表文件夹 → 表列表）时，describeTable 应为 0 次；
 *   - 只有显式 captureSchemaSnapshot（比较需要全表结构）时，才按表数各读一次，
 *     且不重复读。
 *
 * 这条纪律很重要：如果把 describeTable 塞进 listChildren，那么"展开一个有
 * 500 张表的库"会瞬间变成 500 次元数据查询，在大库上是灾难。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildProbe, createBench } from './bench-lib.mjs'

const TABLE_COUNT = Number(process.env.BENCH_TABLES ?? 50)
const COLUMNS_PER_TABLE = 8

const work = mkdtempSync(join(tmpdir(), 'dbstudio-bench-metadata-'))
const bench = createBench()
const { mod, cleanup } = await buildProbe()

/** 建一个含多张表、每表多列 + 一个索引 + 一个外键的库。 */
function makeMultiTableDb(file, tableCount) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE anchor (id INTEGER PRIMARY KEY, label TEXT)')
  for (let t = 0; t < tableCount; t += 1) {
    const cols = []
    for (let c = 0; c < COLUMNS_PER_TABLE; c += 1) {
      cols.push(c === 0 ? 'id INTEGER PRIMARY KEY' : `c${c} TEXT`)
    }
    cols.push('anchor_id INTEGER REFERENCES anchor(id)')
    db.exec(`CREATE TABLE t_${t} (${cols.join(', ')})`)
    db.exec(`CREATE INDEX t_${t}_c1 ON t_${t} (c1)`)
  }
  db.close()
}

try {
  const file = join(work, 'meta.db')
  makeMultiTableDb(file, TABLE_COUNT)

  const manager = mod.createManagerWithBuiltinDialects()
  const conn = await manager.add({ dialectId: 'sqlite', name: 'meta', options: { file } })
  await manager.connectConnection(conn.id)
  const nodeId = `connection:${conn.id}`

  // ---- 给 describeTable 打桩计数 ----
  const proto = mod.DriverHostHandle.prototype
  const originalDescribe = proto.describeTable
  let describeCalls = 0
  proto.describeTable = function patched(...args) {
    describeCalls += 1
    return originalDescribe.apply(this, args)
  }

  try {
    // ---- 只展开目录树，不读任何一列 ----
    console.log(`\n[${TABLE_COUNT} 张表]`)
    const roots = await manager.listChildren(nodeId)
    const tablesFolder = roots.find((n) => n.name.includes('表')) ?? roots[0]
    const tables = await manager.listChildren(tablesFolder.id)
    const realTables = tables.filter((n) => n.kind === 'table')

    console.log(`  展开目录树：${realTables.length} 张表，describeTable 调用 ${describeCalls} 次`)
    bench.record(
      '只展开目录不触发任何表结构读取',
      describeCalls === 0,
      `${describeCalls} 次`
    )
    bench.record(
      `表列表数量正确（期望 ${TABLE_COUNT + 1}，含 anchor）`,
      realTables.length === TABLE_COUNT + 1,
      `${realTables.length}`
    )

    // ---- 显式快照：按表各读一次 ----
    describeCalls = 0
    const snap = await manager.captureSchemaSnapshot(conn.id)
    console.log(`  捕获快照：describeTable 调用 ${describeCalls} 次（${snap.tables.length} 张表）`)
    bench.record(
      '快照按表各读一次，不重复',
      describeCalls === snap.tables.length,
      `${describeCalls} 次 / ${snap.tables.length} 表`
    )
    bench.record(
      '快照覆盖全部表',
      snap.tables.length === TABLE_COUNT + 1,
      `${snap.tables.length}（含 anchor）`
    )
    // 快照里的列数要完整——性能测试也要防止"读得快是因为少读了列"。
    const one = snap.tables.find((t) => t.name === 't_0')
    bench.record(
      '单表列数完整',
      (one?.columns.length ?? 0) === COLUMNS_PER_TABLE + 1,
      `${one?.columns.length ?? 0}`
    )
  } finally {
    proto.describeTable = originalDescribe
  }

  await manager.disconnectConnection(conn.id)
} finally {
  cleanup()
  rmSync(work, { recursive: true, force: true })
}

bench.summary('元数据性能基线')
