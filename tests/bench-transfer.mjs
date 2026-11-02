/**
 * 导出性能基线：吞吐与峰值内存。
 *
 * 核心要验证的一件事：**峰值内存不能随总行数线性增长**。
 * 导出是分批读取（每次只持一个 batch），所以 100 万行的内存占用应该和
 * 10 万行在同一个量级，而不是十倍。这条是 P7.1 的硬门槛。
 *
 * 内存采样用 heapUsed 相对基线的增量，导出期间每 40ms 采一次取峰值。
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProbe, createBench, makeBenchDb, mb, ms } from './bench-lib.mjs'

const rowsList = (process.env.BENCH_ROWS ?? '100000,1000000')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isInteger(n) && n > 0)

const work = mkdtempSync(join(tmpdir(), 'dbstudio-bench-transfer-'))
const bench = createBench()
const { mod, cleanup } = await buildProbe()

const results = []

try {
  for (const rows of rowsList) {
    const file = join(work, `bench-${rows}.db`)
    makeBenchDb(file, rows)

    const manager = mod.createManagerWithBuiltinDialects()
    const conn = await manager.add({ dialectId: 'sqlite', name: `bench-${rows}`, options: { file } })
    await manager.connectConnection(conn.id)
    const nodeId = `connection:${conn.id}`
    const destinationPath = join(work, `export-${rows}.csv`)

    // 先探一下表节点 id：导出按表来源，需要 `connection:X|table:bench`。
    const roots = await manager.listChildren(nodeId)
    const tablesFolder = roots.find((n) => n.name.includes('表')) ?? roots[0]
    const tableNode = (await manager.listChildren(tablesFolder.id)).find((n) => n.name === 'bench')
    if (!tableNode) throw new Error('找不到 bench 表节点')

    console.log(`\n[${rows.toLocaleString()} 行]`)

    // ---- 内存采样：导出期间持续记录 heapUsed 相对基线的峰值 ----
    const baseHeap = process.memoryUsage().heapUsed
    let peakDelta = 0
    const sampler = setInterval(() => {
      const delta = process.memoryUsage().heapUsed - baseHeap
      if (delta > peakDelta) peakDelta = delta
    }, 40)

    const start = performance.now()
    const progress = manager.startTransfer({
      source: { nodeId: tableNode.id, connectionId: conn.id },
      format: 'csv',
      destinationPath
    })
    const result = await manager.waitTransfer(progress.taskId)
    const elapsed = performance.now() - start
    clearInterval(sampler)

    if (result.status !== 'completed') {
      throw new Error(`导出失败: ${JSON.stringify(result)}`)
    }

    const bytes = statSync(destinationPath).size
    const rowsPerSec = Math.round(rows / (elapsed / 1000))
    console.log(`  导出: ${ms(elapsed)}，${rows.toLocaleString()} 行，${mb(bytes)}`)
    console.log(`  吞吐: ${rowsPerSec.toLocaleString()} 行/秒，峰值内存增量 ${mb(peakDelta)}`)

    results.push({ rows, elapsed, bytes, peakDelta, rowsPerSec })

    /*
     * 时间门槛 120s：实测 100 万行约 56s（2026-11-02，本机）。
     * 慢的原因是 SQLite 导出走分页读取，每批 `SELECT ... LIMIT n OFFSET m`
     * 会重执行并跳过 offset 行，越往后越慢——这是 README「一个已知代价」
     * 里记的同一件事，不是新问题。120s 给足波动余量，同时仍能拦住
     * "某次改动让导出慢一个数量级"的退化。
     */
    bench.record(`导出 ${rows.toLocaleString()} 行在 120s 内完成`, elapsed < 120_000, ms(elapsed))
    bench.record(`导出文件非空（${rows.toLocaleString()} 行）`, bytes > 0, mb(bytes))
    bench.record(`导出行数正确（${rows.toLocaleString()} 行）`, result.rowsRead === rows, `${result.rowsRead}`)

    await manager.disconnectConnection(conn.id)
  }

  // ---- 内存线性度：最大规模 vs 最小规模 ----
  // 只在最小规模足够大时评估比例：几百行的内存增量接近 0（被 GC 吃掉），
  // 拿它做分母会得到天文数字，毫无意义。绝对上限（512MB）则始终检查。
  if (results.length >= 2) {
    const smallest = results[0]
    const largest = results[results.length - 1]
    const rowRatio = largest.rows / smallest.rows
    const memRatio = largest.peakDelta / Math.max(1, smallest.peakDelta)
    console.log(
      `\n内存线性度：行数 ×${rowRatio.toFixed(0)}，峰值内存 ×${memRatio.toFixed(1)}（${mb(smallest.peakDelta)} → ${mb(largest.peakDelta)}）`
    )
    /*
     * 门槛：行数涨 N 倍时，内存涨幅必须**远小于** N 倍。
     * 分批导出只持一个 batch，理论上内存与总行数无关；留 3 倍余量吸收
     * GC 时机、字符串驻留、驱动宿主缓冲带来的噪声。若真退化成"全量载入内存"，
     * 1M vs 100k 会是接近 10 倍，明显越过这条线。
     */
    if (smallest.rows >= 50_000) {
      bench.record(
        `峰值内存不随行数线性增长（行数 ×${rowRatio.toFixed(0)}，内存 ×${memRatio.toFixed(1)} < 3）`,
        memRatio < 3,
        `${mb(smallest.peakDelta)} → ${mb(largest.peakDelta)}`
      )
    } else {
      console.log(`  规模较小，跳过内存线性度比例断言（最小 ${smallest.rows.toLocaleString()} 行）`)
    }
    // 绝对上限兜底：百万行导出的峰值增量不该到一个 GB 量级。
    bench.record(
      `最大规模峰值内存增量 < 512MB`,
      largest.peakDelta < 512 * 1024 * 1024,
      mb(largest.peakDelta)
    )
  }
} finally {
  cleanup()
  rmSync(work, { recursive: true, force: true })
}

bench.summary('导出性能基线')
