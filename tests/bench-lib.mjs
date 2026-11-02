/**
 * 性能基线的公共工具（仅测试用）。
 *
 * 三个 bench-*.mjs 都需要：打包真实 ConnectionManager 探针、生成固定夹具、
 * 统计分位数。放在这里避免三份复制。它不是生产代码，Electron 不会加载。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 打包 `tests/probe-entry.ts`（真实注册表 + 真实 ConnectionManager），
 * 返回模块与临时目录。调用方负责在结束时清理临时目录。
 */
export async function buildProbe() {
  /*
   * 产物必须落在**项目目录内**（out/ 下），不能放系统临时目录：
   * probe 会 import 真实驱动，后者 require('pg') / 'ssh2' 等运行时依赖。
   * 这些依赖只在项目 node_modules 里，而 Node 的模块解析是**从文件所在目录
   * 逐级向上**找 node_modules——放在 /tmp 下就找不到了（实测报 Cannot find module 'pg'）。
   * out/ 已被 .gitignore 忽略，用完即删。
   */
  const work = mkdtempSync(join(root, 'out', 'bench-probe-'))
  await build({
    configFile: false,
    root,
    logLevel: 'error',
    build: {
      outDir: work,
      target: 'node22',
      ssr: true,
      minify: false,
      lib: { entry: resolve(root, 'tests/probe-entry.ts'), formats: ['cjs'] },
      rollupOptions: { external: [/^node:/, 'electron'], output: { entryFileNames: 'probe.cjs' } }
    }
  })
  const mod = await import(pathToFileURL(join(work, 'probe.cjs')).href)
  return { mod, work, cleanup: () => rmSync(work, { recursive: true, force: true }) }
}

/** 计算分位数（0–1）。对空数组返回 NaN，调用方应自行判空。 */
export function percentile(values, p) {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

/** 毫秒格式化成易读字符串。 */
export function ms(value) {
  if (!Number.isFinite(value)) return 'n/a'
  if (value < 1) return `${(value * 1000).toFixed(0)}µs`
  if (value < 1000) return `${value.toFixed(1)}ms`
  return `${(value / 1000).toFixed(2)}s`
}

/** 字节格式化成 MB。 */
export function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/**
 * 生成固定夹具数据库。
 *
 * ===== 数据形状为什么要这样 =====
 * 覆盖真实使用中会让分页/导出变慢的几类值：
 *   - 短文本：常规列
 *   - 长文本：部分行带 2KB 文本（会触发结果集的截断逻辑，导出时要按全文处理）
 *   - BLOB：二进制列（数据比较要跳过，导出要正确处理）
 *   - NULL：可空列（导出/比较都要区分 NULL 与空串）
 *   - 重复值：category 只有 10 个取值（低基数，模拟真实分类列）
 *   - 多列索引：(category, name) 上的复合索引
 *
 * 用事务 + prepared statement 批量插入，100 万行也在秒级完成。
 */
export function makeBenchDb(file, rows) {
  const db = new DatabaseSync(file)
  // 建表与索引不计入任何测量，属夹具准备。
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = OFF')
  db.exec(`
    CREATE TABLE bench (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      note TEXT,
      payload BLOB,
      maybe TEXT
    )
  `)
  db.exec('CREATE INDEX bench_category_name ON bench (category, name)')

  const insert = db.prepare(
    'INSERT INTO bench (id, name, category, note, payload, maybe) VALUES (?, ?, ?, ?, ?, ?)'
  )
  /*
   * 长文本长度必须**低于结果集通道的截断阈值**（MAX_CELL_TEXT_CHARS = 1000）。
   * 否则导出时会被"截断值一律拒绝"的保护拦下（那是正确行为，但会让导出
   * 基线测不下去——我们这里要测吞吐和内存，不是测截断保护）。
   * 用 500 字符：足够模拟"较大的文本列"，又不触发截断。
   */
  const longText = 'x'.repeat(500)
  db.exec('BEGIN')
  for (let id = 1; id <= rows; id += 1) {
    const name = `row-${id}`
    const category = `cat-${id % 10}`
    // 每 1000 行一个超长文本，其余为 NULL，制造稀疏的大字段。
    const note = id % 1000 === 0 ? `${longText}-${id}` : null
    // 每 500 行一个 BLOB，其余 NULL。
    const payload = id % 500 === 0 ? new Uint8Array([1, 2, 3, 4]) : null
    // 每 7 行为 NULL，其余有值——用来区分 NULL 与空串的处理。
    const maybe = id % 7 === 0 ? null : `v-${id}`
    insert.run(id, name, category, note, payload, maybe)
  }
  db.exec('COMMIT')
  // 收集统计信息，让查询规划器有依据（否则首次查询可能因未 ANALYZE 而计划不同）。
  db.exec('ANALYZE')
  db.close()
}

/** 一个简单的“测量 → 断言”框架，三个 bench 共用。 */
export function createBench() {
  let pass = 0
  let fail = 0
  const record = (name, condition, detail = '') => {
    if (condition) {
      pass += 1
      console.log(`  ✅ ${name}`)
    } else {
      fail += 1
      console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
    }
  }
  const summary = (title) => {
    console.log(`\n${title}：${pass} 通过 / ${fail} 失败`)
    if (fail > 0) process.exitCode = 1
    return fail === 0
  }
  return { record, summary }
}
