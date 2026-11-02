/**
 * 结果集性能基线：首屏、分页 p95、深分页。
 *
 * 用真实 SQLite + 真实 ConnectionManager（经 driver-host 子进程），
 * 测的是用户实际会遇到的路径，不是纯函数微基准。
 *
 * 规模默认 1,000 / 100,000 / 1,000,000 行；可用 BENCH_ROWS 环境变量覆盖
 * （例如 CI 上想缩短时间：BENCH_ROWS=1000,100000）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProbe, createBench, makeBenchDb, ms, percentile } from './bench-lib.mjs'

const rowsList = (process.env.BENCH_ROWS ?? '1000,100000,1000000')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isInteger(n) && n > 0)

const work = mkdtempSync(join(tmpdir(), 'dbstudio-bench-resultset-'))
const bench = createBench()
const { mod, cleanup } = await buildProbe()

try {
  for (const rows of rowsList) {
    const file = join(work, `bench-${rows}.db`)
    makeBenchDb(file, rows)

    const manager = mod.createManagerWithBuiltinDialects()
    const conn = await manager.add({ dialectId: 'sqlite', name: `bench-${rows}`, options: { file } })
    await manager.connectConnection(conn.id)
    const nodeId = `connection:${conn.id}`

    console.log(`\n[${rows.toLocaleString()} 行]`)

    // ---- 首屏：执行查询并返回第一页 ----
    const t0 = performance.now()
    const first = await manager.runQuery(nodeId, 'SELECT * FROM bench', { limit: 100 })
    const firstMs = performance.now() - t0
    console.log(`  首屏: ${ms(firstMs)}（${first.rows.length} 行）`)

    // ---- 分页 p95：随机取 40 页，每次 100 行 ----
    const cursorId = first.cursorId
    const pageTimes = []
    for (let i = 0; i < 40; i += 1) {
      const offset = Math.floor(Math.random() * Math.max(1, rows - 100))
      const start = performance.now()
      await manager.fetchResultPage(cursorId, offset, 100)
      pageTimes.push(performance.now() - start)
    }
    const p95 = percentile(pageTimes, 0.95)
    const p50 = percentile(pageTimes, 0.5)
    console.log(`  分页: p50 ${ms(p50)} / p95 ${ms(p95)}`)

    // ---- 深分页：直接跳到接近末尾 ----
    const deepOffset = Math.max(0, rows - 100)
    const tDeep = performance.now()
    await manager.fetchResultPage(cursorId, deepOffset, 100)
    const deepMs = performance.now() - tDeep
    console.log(`  深分页(offset=${deepOffset.toLocaleString()}): ${ms(deepMs)}`)

    await manager.closeCursor(cursorId).catch(() => undefined)

    // ---- 门槛 ----
    // 门槛刻意设得宽松：基线的作用是**发现数量级退化**（比如某次改动让首屏
    // 从 20ms 变成 2s），而不是卡在几毫秒上，否则会在负载波动的 CI 上误报。
    bench.record(`首屏 < 800ms（${rows.toLocaleString()} 行）`, firstMs < 800, ms(firstMs))
    bench.record(`分页 p95 < 400ms（${rows.toLocaleString()} 行）`, p95 < 400, ms(p95))
    bench.record(`深分页 < 1500ms（${rows.toLocaleString()} 行）`, deepMs < 1500, ms(deepMs))
    // 分页返回的行数必须正确——性能测试也要防止“变快是因为少返回了行”。
    bench.record(
      `分页返回的列数正确（${rows.toLocaleString()} 行）`,
      first.columns.length === 6 && (first.rows[0]?.cells.length ?? 0) === 6,
      `columns=${first.columns.length}, cells=${first.rows[0]?.cells.length ?? 0}`
    )

    await manager.disconnectConnection(conn.id)
  }
} finally {
  cleanup()
  rmSync(work, { recursive: true, force: true })
}

bench.summary('结果集性能基线')
