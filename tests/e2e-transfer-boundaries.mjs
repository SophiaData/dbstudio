/**
 * P2.1 导出后端的**独立对抗验收**。
 *
 * ===== 与 tests/e2e-transfer-task.mjs 的分工 =====
 *
 * `e2e-transfer-task.mjs` 是实现方自己的测试，验的是「正常导出能跑通」：
 * 建任务 → 写文件 → 进度变化 → 完成。本文件**不重复**它。
 *
 * 本文件验的是「不该发生的事发生后，系统是否仍然正确」：
 *   - 取消恰好落在首批写完之后、最终 rename 之前 → 不能发布残缺文件；
 *   - 失败 / 取消 → 已存在的目标文件必须原样保留，临时文件必须清掉；
 *   - 列名重复（含 `__proto__` / `constructor` 这类原型污染键）→ JSON 不能丢列；
 *   - SQL INSERT 的字符串字面量不能被单引号 / 换行 / 反斜线 / NUL 破坏或注入；
 *   - batchSize 的 NaN / Infinity / 小数 / 负数 / 过大必须被拒绝（否则无限循环）；
 *   - 导出来源不能写库；
 *   - 断连 / dispose 之后任务必须有终态且临时文件已清理；
 *   - 取消导出不能连带取消同一连接上的其它查询。
 *
 * ===== 设计原则：不掩盖缺陷 =====
 *
 * 本文件的断言**只描述正确行为**，不描述当前实现的行为。
 * 如果实现有 bug，测试必须红。**绝不允许**为了让测试变绿而修改期望值，
 * 也**不允许**用 skip 把失败藏起来——setup 失败必须让整份测试失败退出。
 *
 * 运行：
 *   node scripts/build-driver-host.mjs
 *   node tests/e2e-transfer-boundaries.mjs
 */

import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

function formatDetail(detail) {
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

/**
 * setup 失败必须**让整份测试失败退出**。
 *
 * 为什么这么严：setup 失败（例如 SQLite 不可用、探针构建失败）时若继续跑，
 * 所有依赖它的断言都会因为「拿到 undefined」而失败——看起来像是"实现有 30 个 bug"，
 * 实际上只是环境没就绪。更糟的是某些断言可能在这种状态下**假通过**
 * （例如"文件没被创建"在根本没跑起来时也成立）。
 *
 * 所以这里把 setup 失败当成**测试自身的失败**：立刻退出非 0，并打醒目的标记。
 * 绝不 skip。
 */
function fatalSetup(message, err) {
  console.error('')
  console.error('═'.repeat(70))
  console.error('BLOCKED_BY_SETUP 导出边界测试无法运行')
  console.error('═'.repeat(70))
  console.error(message)
  if (err !== undefined) console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  console.error('')
  console.error('这是**环境/依赖未就绪**，不是实现缺陷。请先修复环境后重跑。')
  console.error('本测试刻意不使用 skip 掩盖 setup 失败。')
  process.exit(1)
}

/** 给所有异步断言加超时，避免某个 bug 让测试永久挂住。 */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`超时 ${ms}ms：${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 轮询直到条件成立。
 *
 * 为什么用它而不是 sleep 固定时长：固定时长的 sleep 是在**赌**某个时序，
 * 在快机器上会"任务已经跑完了才取消"（于是断言失败，但原因不是 bug），
 * 在慢机器上又会超时。用条件轮询把时序变成确定的。
 */
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) {
      throw new Error(`等待条件超时（${timeoutMs}ms）：${label}`)
    }
    await sleep(10)
  }
}

// ---------------------------------------------------------------------------
// 探针：用 vite 把生产源码打成 CJS，在系统 node 里加载
// ---------------------------------------------------------------------------

/**
 * ===== 为什么需要探针 =====
 *
 * `src/main/TransferManager.ts` 与 `src/core/transfer.ts` 是 TypeScript，
 * 而本测试跑在纯 node 里（不进 Electron）。两种做法：
 *   - (a) 让生产代码额外导出测试专用入口 → 污染生产代码，不接受；
 *   - (b) 用 vite 把生产源码**原样**打包成 CJS 再加载 → 验的是同一份代码。
 *
 * 选 (b)。打包入口用**虚拟模块**，所以本测试不需要在仓库里新建任何
 * 额外的 .ts 入口文件（写测试文件是本测试唯一的仓库改动）。
 *
 * 探针产物放在 `out/.transfer-boundaries-probe/`：
 * `DriverHostHandle` 会用 `__dirname/../../out/driver-host/index.js` 定位宿主脚本，
 * 从该位置正好落回真实产物，因此不必给生产代码加任何「测试专用开关」。
 */
const PROBE_DIR = resolve(root, 'out/.transfer-boundaries-probe')

async function buildProbe() {
  const { build } = await import('vite')
  const VIRTUAL_ID = '\0transfer-boundaries-probe'
  const source = [
    `export { TransferManager } from '${root}/src/main/TransferManager.ts'`,
    `export * from '${root}/src/core/transfer.ts'`,
    `export { createManagerWithBuiltinDialects } from '${root}/tests/probe-entry.ts'`,
    // 需要打桩宿主句柄的 cancelQuery：用来观测"取消导出有没有误伤同连接的查询"。
    `export { DriverHostHandle } from '${root}/src/main/DriverHostHandle.ts'`
  ].join('\n')

  await build({
    configFile: false,
    root,
    logLevel: 'error',
    build: {
      outDir: PROBE_DIR,
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      ssr: true,
      rollupOptions: {
        external: [/^node:/, 'electron'],
        input: { probe: VIRTUAL_ID },
        plugins: [
          {
            name: 'transfer-boundaries-probe',
            resolveId(id) {
              return id === VIRTUAL_ID ? VIRTUAL_ID : null
            },
            load(id) {
              return id === VIRTUAL_ID ? source : null
            }
          }
        ],
        output: { entryFileNames: '[name].cjs', format: 'cjs' }
      }
    }
  })

  const probeEntry = resolve(PROBE_DIR, 'probe.cjs')
  if (!existsSync(probeEntry)) {
    const emitted = existsSync(PROBE_DIR) ? readdirSync(PROBE_DIR) : []
    throw new Error(`未找到探针产物 ${probeEntry}；目录实际产出: ${emitted.join(', ') || '(空)'}`)
  }
  return import(pathToFileURL(probeEntry).href)
}

// ---------------------------------------------------------------------------
// 宿主脚本前置检查
// ---------------------------------------------------------------------------

const HOST_ENTRY = resolve(root, 'out/driver-host/index.js')
if (!existsSync(HOST_ENTRY)) {
  fatalSetup(
    '找不到驱动宿主产物 out/driver-host/index.js。',
    '请先运行: node scripts/build-driver-host.mjs'
  )
}

let probe
try {
  probe = await buildProbe()
} catch (err) {
  fatalSetup('构建导出边界探针失败（vite build 出错）。', err)
}

const { TransferManager, cellToSqlLiteral, normalizeTransferBatchSize } = probe
if (typeof TransferManager !== 'function') {
  fatalSetup(
    '探针模块未导出 TransferManager。',
    `实际导出: ${Object.keys(probe).join(', ')}`
  )
}

// ---------------------------------------------------------------------------
// 测试工作区
// ---------------------------------------------------------------------------

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-transfer-boundaries-'))
const outDir = join(workDir, 'out')
const dbPath = join(workDir, 'source.db')
mkdirSync(outDir, { recursive: true })

/**
 * 建一个含边界数据的 SQLite 夹具库。
 *
 * 表设计刻意覆盖了几类**真实会被导出到的值**：
 *   - plain        ：普通文本与整数
 *   - quotes       ：单引号 / 换行 / 反斜线 / 注入串（SQL 字面量的经典杀手）
 *   - nulls        ：NULL 与空串的区别（导出必须区分）
 *   - big          ：25 行（验证分批边界与 exact batchSize）
 *
 * NUL 文本单独放进 `nul_paged`：node:sqlite 读 TEXT 时会在 NUL 处截断
 * （`SELECT hex(v)` 能看到完整字节，但 JS 字符串只剩前半截）。导出必须在
 * 数据库侧发现这一点并拒绝，不能把绑定层截断后的值当成完整数据。
 */
function buildFixture() {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE plain (id INTEGER PRIMARY KEY, name TEXT, score REAL);
    CREATE TABLE quotes (id INTEGER PRIMARY KEY, raw TEXT);
    CREATE TABLE nulls (id INTEGER PRIMARY KEY, maybe TEXT, empty TEXT);
    CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT);
    CREATE TABLE huge (id INTEGER PRIMARY KEY, v TEXT);
    CREATE TABLE nul_paged (id INTEGER PRIMARY KEY, v TEXT);
    CREATE TABLE nul_blob (id INTEGER PRIMARY KEY, b BLOB);
  `)
  db.prepare('INSERT INTO plain (id, name, score) VALUES (?, ?, ?)').run(1, 'alice', 1.5)
  db.prepare('INSERT INTO plain (id, name, score) VALUES (?, ?, ?)').run(2, 'bob', -2.25)
  db.prepare('INSERT INTO plain (id, name, score) VALUES (?, ?, ?)').run(3, 'carol', 0)

  db.prepare('INSERT INTO quotes (id, raw) VALUES (?, ?)').run(1, "O'Brien")
  db.prepare('INSERT INTO quotes (id, raw) VALUES (?, ?)').run(2, 'line1\nline2')
  db.prepare('INSERT INTO quotes (id, raw) VALUES (?, ?)').run(3, 'C:\\Users\\dbstudio\\x')
  db.prepare('INSERT INTO quotes (id, raw) VALUES (?, ?)').run(4, "'); DROP TABLE quotes; --")
  db.prepare('INSERT INTO quotes (id, raw) VALUES (?, ?)').run(5, 'carriage\r\nreturn')

  db.prepare('INSERT INTO nulls (id, maybe, empty) VALUES (?, ?, ?)').run(1, null, '')
  db.prepare('INSERT INTO nulls (id, maybe, empty) VALUES (?, ?, ?)').run(2, 'text', '')

  const insertBig = db.prepare('INSERT INTO big (id, v) VALUES (?, ?)')
  for (let i = 1; i <= 25; i += 1) insertBig.run(i, `row-${i}`)

  /**
   * `huge`：给「取消」与「断连」用例用。
   *
   * 为什么需要一张大表：真实 SQLite 导出极快，25 行的表在测试轮询到
   * "任务已开始"之前就已经跑完了 —— 那时取消请求会被正确地拒绝
   * （任务已是终态），断言于是失败，但原因不是 bug，而是**没测到时序**。
   * 2000 行 + batchSize=1 能稳定地造出「任务还在跑」的窗口。
   */
  const insertHuge = db.prepare('INSERT INTO huge (id, v) VALUES (?, ?)')
  for (let i = 1; i <= 2000; i += 1) insertHuge.run(i, `huge-${i}`)

  /**
   * NUL 放在第二行、用 batchSize=1 导出，确保测试覆盖
   * `fetchResultPage` 而不只是首批 `query`。
   */
  const insertNul = db.prepare('INSERT INTO nul_paged (id, v) VALUES (?, ?)')
  insertNul.run(1, 'clean')
  insertNul.run(2, 'left\u0000right')
  insertNul.run(3, 'tail')

  // BLOB 里的 0x00 可以完整往返，不能因为同样的字节就误拒。
  db.prepare('INSERT INTO nul_blob (id, b) VALUES (?, ?)').run(
    1,
    Uint8Array.from([0x61, 0x00, 0x62])
  )
  db.close()
}

try {
  buildFixture()
} catch (err) {
  fatalSetup('生成 SQLite 夹具失败（node:sqlite 不可用或夹具 SQL 有误）。', err)
}

// ---------------------------------------------------------------------------
// 注入式来源（用于精确控制时序与内容）
// ---------------------------------------------------------------------------

/**
 * 一个**完全可控**的导出来源。
 *
 * 为什么不直接用真实数据库驱动所有用例：
 *   - 有些边界需要在**精确的时点**触发（"首批写完之后、rename 之前"）；
 *     数据库驱动的时序不可控。
 *   - 有些边界需要构造**数据库造不出来**的数据（含 NUL 的字符串、
 *     重复列名、原型污染列名）。
 *
 * 所以注入来源负责"时序与内容"，真实 SQLite 负责"端到端真实性"。
 * 两类用例都要有：只有注入来源，验不到真实链路；只有真实链路，验不到边界。
 */
function makeSource(options = {}) {
  const {
    columns = ['id', 'name'],
    dialectId = 'sqlite',
    batches = [],
    onOpen = null,
    onRead = null,
    onClose = null,
    gateReads = false
  } = options

  /**
   * `target` 必须用「键是否存在」判断，不能用解构默认值。
   *
   * 解构默认值 `target = {...}` 在显式传入 `target: undefined` 时也会生效，
   * 于是「来源不是具体表」这个用例根本构造不出来——测的就不是我想测的东西了。
   */
  const hasTarget = Object.prototype.hasOwnProperty.call(options, 'target')
  const target = hasTarget ? options.target : { name: 'plain', kind: 'table' }

  const state = { reads: 0, closes: 0, opens: 0 }
  let queue = batches.slice()

  /** 读闸门：gateReads 打开后，第 2 次及以后的 read 会一直等着，直到 openGate()。 */
  let releaseGate = () => {}
  const gate = new Promise((resolve) => {
    releaseGate = resolve
  })

  return {
    state,
    /** 供测试在合适的时点替换剩余批次。 */
    setBatches(next) {
      queue = next.slice()
    },
    /** 打开读闸门，让被挡住的 read 继续。 */
    openGate() {
      releaseGate()
    },
    open: async (source, batchSize) => {
      state.opens += 1
      if (onOpen) await onOpen(source, batchSize)
      return {
        columns,
        dialectId,
        ...(target === undefined ? {} : { target }),
        async read() {
          state.reads += 1
          // 第一批放行（它会被真的写进文件），之后的批次挡住，
          // 让测试能在「首批已落盘、任务还在跑」的窗口里发出取消。
          if (gateReads && state.reads > 1) await gate
          if (onRead) {
            const hooked = await onRead(state.reads)
            if (hooked !== undefined) return hooked
          }
          const next = queue.shift()
          if (next === undefined) return { rows: [], done: true }
          return next
        },
        async close() {
          state.closes += 1
          if (onClose) await onClose()
        }
      }
    }
  }
}

/** 造一行 CellValue（text）。 */
const text = (t) => ({ kind: 'text', text: t })
/** 造一行 CellValue（number）。 */
const num = (n) => ({ kind: 'number', value: n })
/** 造一行 CellValue（null）。 */
const nul = () => ({ kind: 'null' })

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 列出目录下所有文件（用于断言"临时文件已清理"）。 */
function listDir(dir) {
  return existsSync(dir) ? readdirSync(dir) : []
}

/** 目标目录里的临时文件残留。 */
function tempArtifacts(dir) {
  return listDir(dir).filter((name) => name.includes('.dbstudio-') || name.endsWith('.part'))
}

/** 造一个唯一的导出目标路径。 */
let pathSeq = 0
function destPath(name = 'export') {
  pathSeq += 1
  return join(outDir, `${name}-${pathSeq}.out`)
}

/** 读出文件内容（不存在则返回 null）。 */
function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function makeManager(source, extra = {}) {
  return new TransferManager({ openSource: source.open, ...extra })
}

// ===========================================================================
// 1. 取消恰好落在「首批写完之后、最终 rename 之前」
// ===========================================================================

console.log('\n[1] 取消竞态：首批写完之后、最终 rename 之前')

{
  const out = join(outDir, 'race')
  mkdirSync(out, { recursive: true })
  const destination = join(out, 'race.csv')

  /**
   * 关键时序：`onClose` 回调（在来源被关闭时触发）里发出取消请求。
   *
   * 为什么这个时点是**唯一**能命中"提交前最后一次取消检查"的位置：
   * 生产实现的顺序是「写完所有批次 → fsync → close 文件 → close 来源 →
   * 再查一次取消 → 进入 committing → rename」。来源 close 恰好落在
   * 「最后那次取消检查」之前，所以在 close 里取消，就能命中它。
   *
   * 若实现漏掉了那次检查，任务会继续 rename，把**没写完的文件**发布出去。
   */
  let manager
  let taskId
  const source = makeSource({
    columns: ['id', 'name'],
    batches: [{ rows: [[num(1), text('a')]], done: false }],
    onClose: () => {
      if (manager && taskId) manager.cancel(taskId)
    }
  })
  manager = makeManager(source)
  taskId = manager.start({
    source: { sql: 'SELECT 1', connectionId: 'c1' },
    format: 'csv',
    destinationPath: destination
  }).taskId

  const result = await withTimeout(manager.wait(taskId), 10_000, '取消竞态任务')
  check(
    '★ 取消竞态：任务终态是 cancelled（不是 completed）',
    result.status === 'cancelled',
    `实际 status=${result.status} message=${result.message ?? ''}`
  )
  check(
    '★ 取消竞态：目标文件未被发布（不存在）',
    !existsSync(destination),
    `文件存在：${existsSync(destination) ? readIfExists(destination) : '不存在'}`
  )
  check(
    '★ 取消竞态：没有残留临时文件',
    tempArtifacts(out).length === 0,
    `残留: ${JSON.stringify(tempArtifacts(out))}`
  )
  check(
    '★ 取消竞态：来源被关闭（游标释放）',
    source.state.closes === 1,
    `closes=${source.state.closes}`
  )
}

// ===========================================================================
// 2. 取消 / 失败时保留已存在的目标文件，并清理临时文件
// ===========================================================================

console.log('\n[2] 失败与取消的文件保全')

{
  const out = join(outDir, 'preserve')
  mkdirSync(out, { recursive: true })
  const destination = join(out, 'existing.csv')
  const ORIGINAL = 'PREVIOUS CONTENT, MUST SURVIVE\r\n'
  writeFileSync(destination, ORIGINAL, 'utf8')

  /**
   * 用读闸门把时点**确定化**：
   * 第一批放行（会被真的写进文件），第二批被挡住；
   * 于是"首批已落盘、任务仍在跑"这个窗口是确定的，不靠 sleep 赌。
   */
  const source = makeSource({
    batches: [{ rows: [[num(1), text('a')]], done: false }],
    gateReads: true
  })
  const manager = makeManager(source)
  const taskId = manager.start({
    source: { sql: 'SELECT 1', connectionId: 'c1' },
    format: 'csv',
    destinationPath: destination
  }).taskId
  // 等到第一批真的被读完（进度里 rowsRead > 0），再取消。
  await waitUntil(() => {
    const p = manager.get(taskId)
    return p !== undefined && p.rowsRead > 0
  }, 5_000, '首批落盘')
  manager.cancel(taskId)
  source.openGate()
  const result = await withTimeout(manager.wait(taskId), 10_000, '取消保全任务')

  check('★ 取消：终态是 cancelled', result.status === 'cancelled', `实际 ${result.status}`)
  check(
    '★ 取消：已存在的目标文件内容原样保留',
    readIfExists(destination) === ORIGINAL,
    `实际内容: ${JSON.stringify(readIfExists(destination))}`
  )
  check(
    '★ 取消：临时文件已清理',
    tempArtifacts(out).length === 0,
    `残留: ${JSON.stringify(tempArtifacts(out))}`
  )
}

{
  const out = join(outDir, 'preserve-fail')
  mkdirSync(out, { recursive: true })
  const destination = join(out, 'existing.csv')
  const ORIGINAL = 'PREVIOUS CONTENT, MUST SURVIVE\r\n'
  writeFileSync(destination, ORIGINAL, 'utf8')

  const source = makeSource({
    batches: [],
    onRead: async () => {
      throw new Error('模拟的数据库故障')
    }
  })
  const manager = makeManager(source)
  const taskId = manager.start({
    source: { sql: 'SELECT 1', connectionId: 'c1' },
    format: 'csv',
    destinationPath: destination
  }).taskId
  const result = await withTimeout(manager.wait(taskId), 10_000, '失败保全任务')

  check('★ 失败：终态是 failed', result.status === 'failed', `实际 ${result.status}`)
  check(
    '★ 失败：错误信息透传到结果里',
    typeof result.message === 'string' && result.message.includes('模拟的数据库故障'),
    `实际 message=${result.message ?? ''}`
  )
  check(
    '★ 失败：已存在的目标文件内容原样保留',
    readIfExists(destination) === ORIGINAL,
    `实际内容: ${JSON.stringify(readIfExists(destination))}`
  )
  check(
    '★ 失败：临时文件已清理',
    tempArtifacts(out).length === 0,
    `残留: ${JSON.stringify(tempArtifacts(out))}`
  )
  check(
    '★ 失败：来源被关闭',
    source.state.closes === 1,
    `closes=${source.state.closes}`
  )
}

// ===========================================================================
// 3. 取消不得连带取消同一连接上的其它查询
// ===========================================================================

console.log('\n[3] 取消导出不误伤同连接的其它查询')

{
  /**
   * 这里先验"取消是任务级"的语义边界：取消 A 任务之后，
   * 同一 manager 上的 B 任务必须仍能正常完成。
   *
   * 真实连接级的验证在第 8 组（真实 SQLite + 真实 ConnectionManager）里做，
   * 那里能确认同连接的普通查询在导出取消后依然可用。
   */
  const gated = makeSource({
    batches: [{ rows: [[num(1), text('a')]], done: false }],
    gateReads: true
  })
  const manager = makeManager(gated)
  const destA = destPath('other-query')
  const taskId = manager.start({
    source: { sql: 'SELECT 1', connectionId: 'c1' },
    format: 'csv',
    destinationPath: destA
  }).taskId
  await waitUntil(() => {
    const p = manager.get(taskId)
    return p !== undefined && p.rowsRead > 0
  }, 5_000, '首批落盘')
  manager.cancel(taskId)
  gated.openGate()
  await withTimeout(manager.wait(taskId), 10_000, '取消隔离任务')

  const other = makeManager(
    makeSource({
      columns: ['id'],
      batches: [{ rows: [[num(42)]], done: true }]
    })
  )
  const destB = destPath('other-query-ok')
  const otherId = other.start({
    source: { sql: 'SELECT 42', connectionId: 'c1' },
    format: 'csv',
    destinationPath: destB
  }).taskId
  const otherResult = await withTimeout(other.wait(otherId), 10_000, '其它任务')
  check(
    '★ 取消导出不误伤其它任务（其它任务仍能完成）',
    otherResult.status === 'completed',
    `实际 ${otherResult.status}`
  )
}

// ===========================================================================
// 4. 重复列名 → JSON 必须拒绝或无损
// ===========================================================================

console.log('\n[4] 重复列名与原型污染列名')

{
  const source = makeSource({
    columns: ['id', 'id'],
    batches: [{ rows: [[num(1), num(2)]], done: true }]
  })
  const manager = makeManager(source)
  const destination = destPath('dup-json')
  const taskId = manager.start({
    source: { sql: 'SELECT 1 AS id, 2 AS id', connectionId: 'c1' },
    format: 'json',
    destinationPath: destination
  }).taskId
  const result = await withTimeout(manager.wait(taskId), 10_000, '重复列名 JSON 任务')

  const content = readIfExists(destination)
  if (result.status === 'failed') {
    check(
      '★ 重复列名：JSON 导出被明确拒绝（没有静默丢列）',
      typeof result.message === 'string' && result.message.includes('重复'),
      `message=${result.message ?? ''}`
    )
    check('★ 重复列名：拒绝时不产出目标文件', content === null, `实际内容 ${JSON.stringify(content)}`)
  } else {
    /**
     * 若实现选择"允许"，那就必须**无损**：两个同名列都要出现在 JSON 里。
     * 标准 JSON 对象不允许重名键，所以"无损"只能靠数组式键或别的编码。
     * 这里只断言一个弱条件：**不能只留下一个键**。
     */
    let parsed = null
    try {
      parsed = JSON.parse(content ?? 'null')
    } catch {
      parsed = null
    }
    const obj = Array.isArray(parsed) ? parsed[0] : parsed
    const keys = obj && typeof obj === 'object' ? Object.getOwnPropertyNames(obj) : []
    check(
      '★ 重复列名：JSON 没有静默丢列（要么拒绝，要么两个值都在）',
      keys.length === 2,
      `实际 keys=${JSON.stringify(keys)} 内容=${JSON.stringify(content)}`
    )
  }
  check(
    '★ 重复列名：没有残留临时文件',
    tempArtifacts(outDir).length === 0,
    `残留: ${JSON.stringify(tempArtifacts(outDir))}`
  )
}

{
  /**
   * ★ 原型污染列名（监督追加的重点验收项）。
   *
   * `SELECT 1 AS "__proto__", 2 AS "constructor"` 是合法的 SQL，
   * 两列名分别是 `__proto__` 与 `constructor`。
   *
   * 危险在于 JSON 写出时的对象构造方式：
   *   - `const obj = {}; obj['__proto__'] = 1` → **静默丢列**：
   *     `obj.__proto__ = 1` 改的是原型，不是自有属性，JSON.stringify 里没有这一列；
   *   - `const obj = {}; obj['constructor'] = 2` → 覆盖构造器，同样是错的值。
   *
   * 正确做法是 `Object.create(null)` 或 `Object.defineProperty`，
   * 这样 `__proto__` 是一个**普通自有属性**，原型不受影响。
   *
   * 验收点：
   *   1. 导出的 JSON 里 `__proto__` 与 `constructor` 两列都在；
   *   2. 解析出来的对象**原型仍是 Object.prototype**（没被改）；
   *   3. `Object.prototype` 没被污染（全局没被影响）。
   */
  const source = makeSource({
    columns: ['__proto__', 'constructor', 'normal'],
    batches: [
      {
        rows: [[num(1), num(2), num(3)]],
        done: true
      }
    ]
  })
  const manager = makeManager(source)
  const destination = destPath('proto-json')
  const taskId = manager.start({
    source: { sql: 'SELECT 1 AS "__proto__", 2 AS "constructor", 3 AS "normal"', connectionId: 'c1' },
    format: 'json',
    destinationPath: destination
  }).taskId
  const result = await withTimeout(manager.wait(taskId), 10_000, '原型污染列名任务')

  check(
    '★ __proto__ 列名：导出任务成功完成',
    result.status === 'completed',
    `status=${result.status} message=${result.message ?? ''}`
  )

  const content = readIfExists(destination)
  check('★ __proto__ 列名：产出了文件', content !== null, '文件不存在')

  let parsed = null
  let parseError = null
  try {
    parsed = JSON.parse(content ?? 'null')
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err)
  }
  check('★ __proto__ 列名：产出的是合法 JSON', parseError === null, parseError ?? '')

  const obj = Array.isArray(parsed) ? parsed[0] : parsed
  const keys = obj && typeof obj === 'object' ? Object.getOwnPropertyNames(obj) : []
  check(
    '★ __proto__ 列名：JSON 里保留了 __proto__ 这一列',
    keys.includes('__proto__'),
    `keys=${JSON.stringify(keys)} 内容=${JSON.stringify(content)}`
  )
  check(
    '★ __proto__ 列名：JSON 里保留了 constructor 这一列',
    keys.includes('constructor'),
    `keys=${JSON.stringify(keys)} 内容=${JSON.stringify(content)}`
  )
  check(
    '★ __proto__ 列名：值没被改（__proto__ 是数字 1，不是对象）',
    obj !== null && obj !== undefined && obj['__proto__'] === 1,
    `实际值=${JSON.stringify(obj?.['__proto__'])}`
  )
  check(
    '★ __proto__ 列名：解析出来的对象原型仍是 Object.prototype',
    obj !== null && typeof obj === 'object' && Object.getPrototypeOf(obj) === Object.prototype,
    '原型被改了'
  )
  check(
    '★ __proto__ 列名：全局 Object.prototype 未被污染',
    {}.polluted === undefined && Object.prototype.polluted === undefined,
    'Object.prototype 被污染了'
  )

  // JSONL 走同一套键构造逻辑，也要验。
  const source2 = makeSource({
    columns: ['__proto__', 'constructor'],
    batches: [{ rows: [[num(1), num(2)]], done: true }]
  })
  const manager2 = makeManager(source2)
  const dest2 = destPath('proto-jsonl')
  const id2 = manager2.start({
    source: { sql: 'SELECT 1 AS "__proto__", 2 AS "constructor"', connectionId: 'c1' },
    format: 'jsonl',
    destinationPath: dest2
  }).taskId
  const result2 = await withTimeout(manager2.wait(id2), 10_000, '原型污染列名 JSONL 任务')
  const content2 = readIfExists(dest2)
  let parsed2 = null
  try {
    parsed2 = JSON.parse((content2 ?? '').split('\n').filter(Boolean)[0] ?? 'null')
  } catch {
    parsed2 = null
  }
  const keys2 = parsed2 && typeof parsed2 === 'object' ? Object.getOwnPropertyNames(parsed2) : []
  check(
    '★ __proto__ 列名：JSONL 同样保留两列且不污染原型',
    result2.status === 'completed' &&
      keys2.includes('__proto__') &&
      keys2.includes('constructor') &&
      Object.getPrototypeOf(parsed2 ?? {}) === Object.prototype,
    `status=${result2.status} keys=${JSON.stringify(keys2)} 内容=${JSON.stringify(content2)}`
  )
}

// ===========================================================================
// 5. SQL INSERT：字面量转义、注入、NUL
// ===========================================================================

console.log('\n[5] SQL INSERT 的字面量安全')

{
  /**
   * 直接对**生产用的字面量函数**做单元级断言。
   *
   * 为什么可以直接验纯函数：它就是写出 SQL 文件的那一段逻辑，
   * 验它等于验最终文件里那一行的内容。
   */
  const cases = [
    { name: '单引号', value: "O'Brien", sqlite: "'O''Brien'" },
    { name: '换行', value: 'a\nb', sqlite: "'a\nb'" },
    { name: '反斜线', value: 'C:\\x\\y', sqlite: "'C:\\x\\y'" },
    {
      name: '单引号+分号注释',
      value: "'); DROP TABLE users; --",
      sqlite: "'''); DROP TABLE users; --'"
    }
  ]
  for (const c of cases) {
    const literal = cellToSqlLiteral(text(c.value), 'sqlite')
    check(
      `★ SQL 字面量：${c.name} 被正确转义`,
      literal === c.sqlite,
      `期望 ${JSON.stringify(c.sqlite)}，实际 ${JSON.stringify(literal)}`
    )
    check(
      `★ SQL 字面量：${c.name} 转义后仍是单个字符串字面量（引号成对）`,
      typeof literal === 'string' && literal.startsWith("'") && literal.endsWith("'"),
      `实际 ${JSON.stringify(literal)}`
    )
  }

  // NUL：必须拒绝（监督追加的重点验收项）
  let nulError = null
  try {
    cellToSqlLiteral(text('a\u0000b'), 'sqlite')
  } catch (err) {
    nulError = err instanceof Error ? err.message : String(err)
  }
  check(
    '★ SQL 字面量：含 NUL（U+0000）的文本被明确拒绝',
    nulError !== null,
    '含 NUL 的文本居然生成了字面量（会被下游截断）'
  )

  // PostgreSQL 方言同样必须拒绝 NUL（服务器端根本不允许）
  let pgNulError = null
  try {
    cellToSqlLiteral(text('a\u0000b'), 'postgresql')
  } catch (err) {
    pgNulError = err instanceof Error ? err.message : String(err)
  }
  check('★ SQL 字面量：PG 方言同样拒绝 NUL', pgNulError !== null, `实际 ${pgNulError ?? '未拒绝'}`)

  // 数值：NaN / Infinity 必须被拒绝（写成 NaN 会让整条 INSERT 语法错误）
  let nanError = null
  try {
    cellToSqlLiteral(num(Number.NaN), 'sqlite')
  } catch (err) {
    nanError = err instanceof Error ? err.message : String(err)
  }
  check('★ SQL 字面量：NaN 被拒绝（不会写出裸 NaN）', nanError !== null, 'NaN 未被拒绝')

  let infError = null
  try {
    cellToSqlLiteral(num(Number.POSITIVE_INFINITY), 'sqlite')
  } catch (err) {
    infError = err instanceof Error ? err.message : String(err)
  }
  check('★ SQL 字面量：Infinity 被拒绝', infError !== null, 'Infinity 未被拒绝')
}

{
  /**
   * 端到端：导出 SQL INSERT 文件后，**真的拿去 SQLite 执行**，
   * 把数据导回一张新表，逐值比对。
   *
   * 这是"生成的 SQL 可实际导回新表"的硬验收：
   * 只检查字符串长什么样是不够的——注入成功时字符串也"看起来对"。
   */
  const out = join(outDir, 'sqlroundtrip')
  mkdirSync(out, { recursive: true })
  const destination = join(out, 'dump.sql')

  const source = makeSource({
    columns: ['id', 'raw'],
    target: { name: 'quotes', kind: 'table' },
    batches: [
      {
        rows: [
          [num(1), text("O'Brien")],
          [num(2), text('line1\nline2')],
          [num(3), text('C:\\Users\\dbstudio\\x')],
          [num(4), text("'); DROP TABLE quotes; --")],
          [num(5), text('carriage\r\nreturn')],
          [num(6), nul()],
          [num(7), text('')]
        ],
        done: true
      }
    ]
  })
  const manager = makeManager(source)
  const taskId = manager.start({
    source: { sql: 'SELECT id, raw FROM quotes', connectionId: 'c1' },
    format: 'sql-insert',
    destinationPath: destination
  }).taskId
  const result = await withTimeout(manager.wait(taskId), 10_000, 'SQL INSERT 导出任务')
  check(
    '★ SQL INSERT：导出任务完成',
    result.status === 'completed',
    `status=${result.status} ${result.message ?? ''}`
  )

  const sql = readIfExists(destination)
  check('★ SQL INSERT：产出了 .sql 文件', sql !== null, '文件不存在')
  check(
    '★ SQL INSERT：文件以 INSERT 开头',
    typeof sql === 'string' && sql.trimStart().startsWith('INSERT INTO'),
    `实际开头: ${JSON.stringify((sql ?? '').slice(0, 60))}`
  )
  check(
    '★ SQL INSERT：INSERT 目标带 schema 限定（"main"."quotes"）',
    typeof sql === 'string' && sql.includes('"main"."quotes"'),
    `实际内容前 200 字: ${JSON.stringify((sql ?? '').slice(0, 200))}`
  )

  // 真的执行一遍
  const { DatabaseSync } = require('node:sqlite')
  const back = join(out, 'roundtrip.db')
  const db = new DatabaseSync(back)
  let execError = null
  try {
    db.exec('CREATE TABLE "quotes" (id INTEGER, raw TEXT);')
    db.exec(sql ?? '')
  } catch (err) {
    execError = err instanceof Error ? err.message : String(err)
  }
  check('★ SQL INSERT：生成的文件能被 SQLite 实际执行', execError === null, execError ?? '')

  if (execError === null) {
    const rows = db.prepare('SELECT id, raw FROM quotes ORDER BY id').all()
    check('★ SQL INSERT：导回新表后行数正确（7 行）', rows.length === 7, `实际 ${rows.length} 行`)
    const byId = new Map(rows.map((r) => [r.id, r.raw]))
    check(
      "★ SQL INSERT：单引号值原样往返（O'Brien）",
      byId.get(1) === "O'Brien",
      `实际 ${JSON.stringify(byId.get(1))}`
    )
    check(
      '★ SQL INSERT：换行值原样往返',
      byId.get(2) === 'line1\nline2',
      `实际 ${JSON.stringify(byId.get(2))}`
    )
    check(
      '★ SQL INSERT：反斜线值原样往返',
      byId.get(3) === 'C:\\Users\\dbstudio\\x',
      `实际 ${JSON.stringify(byId.get(3))}`
    )
    check(
      '★ SQL INSERT：注入串被当作纯数据（表没被删、行数不减）',
      byId.get(4) === "'); DROP TABLE quotes; --" && rows.length === 7,
      `实际 ${JSON.stringify(byId.get(4))}，行数 ${rows.length}`
    )
    check(
      '★ SQL INSERT：NULL 写成 SQL 关键字 NULL 而不是字符串',
      byId.get(6) === null,
      `实际 ${JSON.stringify(byId.get(6))}`
    )
    check(
      '★ SQL INSERT：空串与 NULL 区分开（空串不是 NULL）',
      byId.get(7) === '',
      `实际 ${JSON.stringify(byId.get(7))}`
    )
  }
  db.close()
}

{
  // sql-insert 格式缺少目标表时必须拒绝（不能凭空编表名）
  const source = makeSource({
    columns: ['id'],
    target: undefined,
    batches: [{ rows: [[num(1)]], done: true }]
  })
  const manager = makeManager(source)
  const destination = destPath('no-target')
  const taskId = manager.start({
    source: { sql: 'SELECT 1', connectionId: 'c1' },
    format: 'sql-insert',
    destinationPath: destination
  }).taskId
  const result = await withTimeout(manager.wait(taskId), 10_000, '无目标 SQL INSERT 任务')
  check(
    '★ SQL INSERT：来源不是具体表时拒绝导出',
    result.status === 'failed',
    `实际 ${result.status}`
  )
  check('★ SQL INSERT：拒绝时不产出文件', !existsSync(destination), '文件被创建了')
}

// ===========================================================================
// 6. batchSize 参数校验
// ===========================================================================

console.log('\n[6] batchSize 校验')

{
  const bad = [
    { name: 'NaN', value: Number.NaN },
    { name: 'Infinity', value: Number.POSITIVE_INFINITY },
    { name: '-Infinity', value: Number.NEGATIVE_INFINITY },
    { name: '小数 1.5', value: 1.5 },
    { name: '负数 -1', value: -1 },
    { name: '0', value: 0 },
    { name: '过大 100000', value: 100_000 }
  ]
  for (const c of bad) {
    let threw = false
    let message = ''
    try {
      normalizeTransferBatchSize(c.value)
    } catch (err) {
      threw = true
      message = err instanceof Error ? err.message : String(err)
    }
    check(`★ batchSize=${c.name} 被拒绝`, threw, `居然被接受了（${message}）`)
  }

  const good = [1, 200, 1000]
  for (const value of good) {
    let normalized = null
    let threw = false
    try {
      normalized = normalizeTransferBatchSize(value)
    } catch {
      threw = true
    }
    check(`★ batchSize=${value} 被接受`, !threw && normalized === value, `实际 ${normalized}`)
  }

  // 通过 manager 入口也必须拒绝（不能只在纯函数层挡）
  for (const c of bad) {
    const source = makeSource({ batches: [{ rows: [], done: true }] })
    const manager = makeManager(source)
    let threw = false
    try {
      manager.start({
        source: { sql: 'SELECT 1', connectionId: 'c1' },
        format: 'csv',
        destinationPath: destPath('bad-batch'),
        options: { batchSize: c.value }
      })
    } catch {
      threw = true
    }
    check(`★ manager.start 拒绝 batchSize=${c.name}`, threw, '居然启动了任务')
  }

  // 拒绝后不能留下任何文件
  check(
    '★ batchSize 非法时不产生临时文件',
    tempArtifacts(outDir).length === 0,
    `残留: ${JSON.stringify(tempArtifacts(outDir))}`
  )
}

// ===========================================================================
// 7. 非法来源 / 格式 / 路径在入口拒绝
// ===========================================================================

console.log('\n[7] 入口参数校验')

{
  const manager = makeManager(makeSource({ batches: [{ rows: [], done: true }] }))
  const base = {
    source: { sql: 'SELECT 1', connectionId: 'c1' },
    format: 'csv',
    destinationPath: destPath('entry')
  }

  const invalid = [
    {
      name: '非法格式',
      request: { ...base, format: 'xml' },
      expect: /格式|format|不支持/i
    },
    {
      name: '空目标路径',
      request: { ...base, destinationPath: '   ' },
      expect: /路径|path|目标/i
    },
    {
      name: '既无 nodeId 也无 sql',
      request: { ...base, source: {} },
      expect: /来源|source|nodeId|sql/i
    },
    {
      name: '只有 sql 没有连接定位',
      request: { ...base, source: { sql: 'SELECT 1' } },
      expect: /连接|connection|nodeId/i
    }
  ]

  for (const c of invalid) {
    let threw = false
    let message = ''
    try {
      manager.start(c.request)
    } catch (err) {
      threw = true
      message = err instanceof Error ? err.message : String(err)
    }
    check(`★ 入口拒绝：${c.name}`, threw && c.expect.test(message), `threw=${threw} message=${message}`)
  }
}

// ===========================================================================
// 8. 真实 SQLite + 真实 ConnectionManager 的端到端边界
// ===========================================================================

console.log('\n[8] 真实 SQLite 链路（ConnectionManager 真实集成）')

let manager2 = null
let connectionId = null

{
  const { createManagerWithBuiltinDialects } = probe
  manager2 = createManagerWithBuiltinDialects()
  const summary = await withTimeout(
    manager2.add({
      dialectId: 'sqlite',
      name: '边界库',
      options: { file: dbPath }
    }),
    30_000,
    '建立 SQLite 连接'
  )
  connectionId = summary.id
  check('★ 真实链路：SQLite 连接建立成功', summary.connected === true, JSON.stringify(summary))
}

if (connectionId !== null) {
  const tableNode = (name) => `connection:${connectionId}|table:${name}`

  // --- 8a. 小表（3 行）必须完整导出 ---
  {
    const destination = destPath('real-3row')
    const taskId = manager2.startTransfer({
      source: { nodeId: tableNode('plain') },
      format: 'csv',
      destinationPath: destination
    }).taskId
    const result = await withTimeout(manager2.waitTransfer(taskId), 30_000, '真实 3 行导出')
    check(
      '★ 真实链路：3 行小表导出完成',
      result.status === 'completed',
      `status=${result.status} message=${result.message ?? ''}`
    )
    check(
      '★ 真实链路：3 行小表行数正确',
      result.rowsRead === 3,
      `实际 rowsRead=${result.rowsRead}`
    )
    const csv = readIfExists(destination)
    check(
      '★ 真实链路：3 行小表内容含全部三行',
      typeof csv === 'string' &&
        csv.includes('alice') &&
        csv.includes('bob') &&
        csv.includes('carol'),
      `实际内容: ${JSON.stringify(csv)}`
    )
  }

  // --- 8b. 行数少于批大小（3 行，batchSize=100）——首批就结束 ---
  {
    const destination = destPath('real-fewer-than-batch')
    const taskId = manager2.startTransfer({
      source: { nodeId: tableNode('plain') },
      format: 'csv',
      destinationPath: destination,
      options: { batchSize: 100 }
    }).taskId
    const result = await withTimeout(manager2.waitTransfer(taskId), 30_000, '真实少批导出')
    check(
      '★ 真实链路：行数少于批大小时全部导出（不能全丢）',
      result.status === 'completed' && result.rowsRead === 3,
      `status=${result.status} rowsRead=${result.rowsRead} message=${result.message ?? ''}`
    )
  }

  // --- 8c. 行数恰好等于批大小（exact batchSize 边界）---
  {
    const destination = destPath('real-exact-batch')
    const taskId = manager2.startTransfer({
      source: { nodeId: tableNode('plain') },
      format: 'csv',
      destinationPath: destination,
      options: { batchSize: 3 }
    }).taskId
    const result = await withTimeout(manager2.waitTransfer(taskId), 30_000, '真实恰好一批导出')
    check(
      '★ 真实链路：行数恰好等于批大小时全部导出',
      result.status === 'completed' && result.rowsRead === 3,
      `status=${result.status} rowsRead=${result.rowsRead} message=${result.message ?? ''}`
    )
    const csv = readIfExists(destination)
    check(
      '★ 真实链路：恰好一批时内容含三行',
      typeof csv === 'string' &&
        csv.includes('alice') &&
        csv.includes('bob') &&
        csv.includes('carol'),
      `实际内容: ${JSON.stringify(csv)}`
    )
  }

  // --- 8d. 多批（25 行，批大小 10）不能漏行 ---
  {
    const destination = destPath('real-multi-batch')
    const taskId = manager2.startTransfer({
      source: { nodeId: tableNode('big') },
      format: 'csv',
      destinationPath: destination,
      options: { batchSize: 10 }
    }).taskId
    const result = await withTimeout(manager2.waitTransfer(taskId), 30_000, '真实多批导出')
    check(
      '★ 真实链路：25 行分 3 批导出行数正确',
      result.status === 'completed' && result.rowsRead === 25,
      `status=${result.status} rowsRead=${result.rowsRead} message=${result.message ?? ''}`
    )
    const csv = readIfExists(destination) ?? ''
    const dataLines = csv.split('\r\n').filter((l) => /^\d+,row-\d+$/.test(l))
    check('★ 真实链路：多批导出没有漏行（25 行）', dataLines.length === 25, `实际 ${dataLines.length} 行`)
    const ids = new Set(dataLines.map((l) => l.split(',')[0]))
    check('★ 真实链路：多批导出的行 id 无重复无缺失', ids.size === 25, `实际唯一 id ${ids.size} 个`)
  }

  // --- 8e. 真实 SQL INSERT 导出后能导回新表 ---
  {
    const destination = destPath('real-sql-dump.sql')
    const taskId = manager2.startTransfer({
      source: { nodeId: tableNode('quotes') },
      format: 'sql-insert',
      destinationPath: destination
    }).taskId
    const result = await withTimeout(manager2.waitTransfer(taskId), 30_000, '真实 SQL INSERT 导出')
    check(
      '★ 真实链路：SQL INSERT 导出完成',
      result.status === 'completed',
      `status=${result.status} message=${result.message ?? ''}`
    )
    const sql = readIfExists(destination) ?? ''
    const { DatabaseSync } = require('node:sqlite')
    const back = join(outDir, 'real-roundtrip.db')
    const db = new DatabaseSync(back)
    let execError = null
    try {
      db.exec('CREATE TABLE "quotes" (id INTEGER, raw TEXT);')
      db.exec(sql)
    } catch (err) {
      execError = err instanceof Error ? err.message : String(err)
    }
    check('★ 真实链路：真实导出的 SQL 能被 SQLite 执行', execError === null, execError ?? '')
    if (execError === null) {
      const rows = db.prepare('SELECT id, raw FROM quotes ORDER BY id').all()
      check('★ 真实链路：导回后 5 行', rows.length === 5, `实际 ${rows.length}`)
      const byId = new Map(rows.map((r) => [r.id, r.raw]))
      check("★ 真实链路：单引号原样往返", byId.get(1) === "O'Brien", `实际 ${JSON.stringify(byId.get(1))}`)
      check('★ 真实链路：换行原样往返', byId.get(2) === 'line1\nline2', `实际 ${JSON.stringify(byId.get(2))}`)
      check(
        '★ 真实链路：反斜线原样往返',
        byId.get(3) === 'C:\\Users\\dbstudio\\x',
        `实际 ${JSON.stringify(byId.get(3))}`
      )
      check(
        '★ 真实链路：注入串被当纯数据',
        byId.get(4) === "'); DROP TABLE quotes; --",
        `实际 ${JSON.stringify(byId.get(4))}`
      )
    }
    db.close()
  }

  // --- 8f. 导出不能写库 ---
  {
    const { DatabaseSync } = require('node:sqlite')
    const probeDb = new DatabaseSync(dbPath)
    const before = probeDb.prepare('SELECT count(*) AS c FROM plain').get().c
    probeDb.close()

    const destination = destPath('readonly')
    const taskId = manager2.startTransfer({
      source: { nodeId: tableNode('plain') },
      format: 'csv',
      destinationPath: destination
    }).taskId
    await withTimeout(manager2.waitTransfer(taskId), 30_000, '真实只读导出')

    const afterDb = new DatabaseSync(dbPath)
    const after = afterDb.prepare('SELECT count(*) AS c FROM plain').get().c
    const tablesAfter = afterDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name)
    afterDb.close()

    check('★ 导出不修改源库行数', before === after, `before=${before} after=${after}`)
    check(
      '★ 导出不修改源库结构',
      tablesAfter.includes('plain') &&
        tablesAfter.includes('quotes') &&
        tablesAfter.includes('nulls') &&
        tablesAfter.includes('big') &&
        tablesAfter.includes('huge'),
      `实际表: ${JSON.stringify(tablesAfter)}`
    )
  }

  // --- 8e-2. TEXT 中的 NUL 必须在数据库侧被发现并拒绝 ---
  {
    const { DatabaseSync } = require('node:sqlite')
    const rawDb = new DatabaseSync(dbPath)
    const rawHex = rawDb.prepare('SELECT hex(v) AS h FROM nul_paged WHERE id = 2').get().h
    rawDb.close()
    check(
      '★ NUL 夹具：SQLite 实际保存了完整 61..00..62 字节',
      rawHex === '6C656674007269676874',
      `实际 hex=${rawHex}`
    )

    let directError = null
    try {
      await withTimeout(
        manager2.runQuery(`connection:${connectionId}`, 'SELECT * FROM nul_paged ORDER BY id'),
        30_000,
        'NUL 直接查询'
      )
    } catch (err) {
      directError = err instanceof Error ? err.message : String(err)
    }
    check(
      '★ NUL：直接查询明确失败而不是返回截断值',
      typeof directError === 'string' && /NUL|U\+0000/i.test(directError),
      `实际 ${directError ?? '查询成功（截断值被静默返回）'}`
    )

    const destination = destPath('nul-paged')
    const taskId = manager2.startTransfer({
      source: { nodeId: tableNode('nul_paged') },
      format: 'csv',
      destinationPath: destination,
      options: { batchSize: 1 }
    }).taskId
    const result = await withTimeout(manager2.waitTransfer(taskId), 30_000, 'NUL 第二页导出')
    check(
      '★ NUL：第二页含 NUL 的 TEXT 使导出失败',
      result.status === 'failed' && /NUL|U\+0000/i.test(result.message ?? ''),
      `status=${result.status} message=${result.message ?? ''}`
    )
    check(
      '★ NUL：错误信息指出具体列 v',
      /(^|[^A-Za-z0-9_])v([^A-Za-z0-9_]|$)/.test(result.message ?? ''),
      `message=${result.message ?? ''}`
    )
    check('★ NUL：拒绝时不发布目标文件', !existsSync(destination), '文件被发布了')

    const expressionDestination = destPath('nul-expression')
    const expressionTaskId = manager2.startTransfer({
      source: {
        sql: "SELECT 'left' || char(0) || 'right' AS generated",
        connectionId
      },
      format: 'json',
      destinationPath: expressionDestination
    }).taskId
    const expressionResult = await withTimeout(
      manager2.waitTransfer(expressionTaskId),
      30_000,
      'NUL 表达式导出'
    )
    check(
      '★ NUL：查询表达式生成的 TEXT 同样在数据库侧被发现',
      expressionResult.status === 'failed' &&
        /NUL|U\+0000/i.test(expressionResult.message ?? '') &&
        expressionResult.message.includes('generated'),
      `status=${expressionResult.status} message=${expressionResult.message ?? ''}`
    )

    const blobDestination = destPath('nul-blob')
    const blobTaskId = manager2.startTransfer({
      source: { nodeId: tableNode('nul_blob') },
      format: 'csv',
      destinationPath: blobDestination
    }).taskId
    const blobResult = await withTimeout(
      manager2.waitTransfer(blobTaskId),
      30_000,
      'NUL BLOB 导出'
    )
    const blobCsv = readIfExists(blobDestination) ?? ''
    check(
      '★ NUL：BLOB 中的 0x00 不被误判且完整导出',
      blobResult.status === 'completed' && blobCsv.includes('610062'),
      `status=${blobResult.status} message=${blobResult.message ?? ''} csv=${JSON.stringify(blobCsv)}`
    )

    const duplicate = await withTimeout(
      manager2.runQuery(`connection:${connectionId}`, 'SELECT 1 AS dup, 2 AS dup'),
      30_000,
      'NUL 校验不影响重名列'
    )
    check(
      '★ NUL 校验：重名列仍按列位置完整返回',
      duplicate.columns.length === 2 &&
        duplicate.rows[0]?.cells.length === 2 &&
        duplicate.rows[0].cells[0]?.kind === 'number' &&
        duplicate.rows[0].cells[0].value === 1 &&
        duplicate.rows[0].cells[1]?.kind === 'number' &&
        duplicate.rows[0].cells[1].value === 2,
      JSON.stringify(duplicate.rows[0]?.cells)
    )
  }

  // --- 8g-0. 取消导出不得向宿主发出「取消查询」RPC ---
  {
    /**
     * ⚠️ 这一条必须**观察 RPC 本身**，不能只看"查询还能不能跑"。
     *
     * 原因：SQLite 的 `cancelQuery` 是一个**诚实的空操作**（驱动不支持取消，
     * 见 src/drivers/sqlite/query-cancel.ts）。也就是说——
     * 即使实现真的在取消导出时顺手调了 `host.cancelQuery()`，
     * 在 SQLite 上也**看不出任何后果**：同连接的查询照样能跑。
     *
     * 所以"取消后查询仍可用"这条断言在 SQLite 上**没有区分度**：
     * 无论实现有没有误伤其它查询，它都会通过。
     *
     * 这里改为**探针宿主句柄**：统计 cancelQuery 被调用的次数。
     * 只要取消导出触发了一次 cancelQuery RPC，就判定失败——
     * 无论驱动是否支持取消，**任务级取消都不该碰宿主查询**。
     */
    const { DriverHostHandle } = probe
    const originalCancel = DriverHostHandle.prototype.cancelQuery
    let cancelCalls = 0
    DriverHostHandle.prototype.cancelQuery = function patched(...args) {
      cancelCalls += 1
      return originalCancel.apply(this, args)
    }
    try {
      const destination = destPath('no-rpc-cancel')
      const taskId = manager2.startTransfer({
        source: { nodeId: tableNode('huge') },
        format: 'csv',
        destinationPath: destination,
        options: { batchSize: 1 }
      }).taskId
      await waitUntil(() => {
        const p = manager2.getTransferProgress(taskId)
        return p !== undefined && p.rowsRead > 0
      }, 10_000, '真实链路导出开始')
      manager2.cancelTransfer(taskId)
      await withTimeout(manager2.waitTransfer(taskId), 30_000, '取消导出（探针）')
      check(
        '★ 取消导出没有向宿主发出 cancelQuery RPC（不误伤同连接查询）',
        cancelCalls === 0,
        `cancelQuery 被调用了 ${cancelCalls} 次`
      )
    } finally {
      DriverHostHandle.prototype.cancelQuery = originalCancel
    }
  }

  // --- 8g. 取消导出后，同连接的普通查询依然可用 ---
  {
    const destination = destPath('cancel-then-query')
    const taskId = manager2.startTransfer({
      source: { nodeId: tableNode('huge') },
      format: 'csv',
      destinationPath: destination,
      options: { batchSize: 1 }
    }).taskId
    // 轮询进度直到任务真的开始跑（rowsRead > 0），再取消——
    // 用 sleep 赌时机会随机失败（任务可能已经跑完了）。
    await waitUntil(() => {
      const p = manager2.getTransferProgress(taskId)
      return p !== undefined && p.rowsRead > 0
    }, 10_000, '真实链路导出开始')
    const cancelled = manager2.cancelTransfer(taskId)
    const result = await withTimeout(manager2.waitTransfer(taskId), 30_000, '真实取消导出')
    check('★ 真实链路：取消请求被接受', cancelled === true, `实际 ${cancelled}`)
    check(
      '★ 真实链路：取消后任务终态是 cancelled',
      result.status === 'cancelled',
      `实际 ${result.status}`
    )
    check('★ 真实链路：取消后不发布目标文件', !existsSync(destination), '文件被发布了')
    check(
      '★ 真实链路：取消后临时文件已清理',
      tempArtifacts(outDir).length === 0,
      `残留: ${JSON.stringify(tempArtifacts(outDir))}`
    )

    // 同连接的普通查询必须照常工作
    let queryOk = true
    let queryDetail = ''
    try {
      const q = await withTimeout(
        manager2.runQuery(`connection:${connectionId}`, 'SELECT count(*) AS c FROM big'),
        30_000,
        '取消后同连接查询'
      )
      queryOk = q.rows.length === 1
      queryDetail = JSON.stringify(q.rows[0]?.cells)
    } catch (err) {
      queryOk = false
      queryDetail = err instanceof Error ? err.message : String(err)
    }
    check('★ 真实链路：取消导出后同连接的普通查询仍可用', queryOk, queryDetail)
  }

  // --- 8h. 断连后任务有终态且临时文件被清理 ---
  {
    const destination = destPath('disconnect')
    const taskId = manager2.startTransfer({
      source: { nodeId: tableNode('huge') },
      format: 'csv',
      destinationPath: destination,
      options: { batchSize: 1 }
    }).taskId
    await waitUntil(() => {
      const p = manager2.getTransferProgress(taskId)
      return p !== undefined && p.rowsRead > 0
    }, 10_000, '真实链路导出开始')
    await withTimeout(manager2.disconnectConnection(connectionId), 30_000, '断开连接')
    const result = await withTimeout(manager2.waitTransfer(taskId), 30_000, '断连后的任务')
    check(
      '★ 断连后任务有终态（cancelled 或 failed）',
      result.status === 'cancelled' || result.status === 'failed',
      `实际 ${result.status}`
    )
    check('★ 断连后不发布目标文件', !existsSync(destination), '文件被发布了')
    check(
      '★ 断连后临时文件已清理',
      tempArtifacts(outDir).length === 0,
      `残留: ${JSON.stringify(tempArtifacts(outDir))}`
    )

    // 重新连上，供后续清理
    const re = await withTimeout(manager2.connectConnection(connectionId), 30_000, '重新连接')
    check('★ 断连后可重新连接', re.connected === true, JSON.stringify(re))
  }

  // --- 8i. disposeAll 之后任务有终态 ---
  {
    const destination = destPath('dispose-all')
    const taskId = manager2.startTransfer({
      source: { nodeId: tableNode('huge') },
      format: 'csv',
      destinationPath: destination,
      options: { batchSize: 1 }
    }).taskId
    await waitUntil(() => {
      const p = manager2.getTransferProgress(taskId)
      return p !== undefined && p.rowsRead > 0
    }, 10_000, '真实链路导出开始')
    await withTimeout(manager2.disposeAll(), 30_000, 'disposeAll')
    const result = await withTimeout(manager2.waitTransfer(taskId), 30_000, 'disposeAll 后的任务')
    check(
      '★ disposeAll 后任务有终态',
      result.status === 'cancelled' || result.status === 'failed' || result.status === 'completed',
      `实际 ${result.status}`
    )
    check(
      '★ disposeAll 后临时文件已清理',
      tempArtifacts(outDir).length === 0,
      `残留: ${JSON.stringify(tempArtifacts(outDir))}`
    )
  }
}

// ===========================================================================
// 9. 首批落盘即写（流式，不是攒完再写）
// ===========================================================================

console.log('\n[9] 首批真的落盘（不是攒到任务结束才写）')

{
  const out = join(outDir, 'streaming')
  mkdirSync(out, { recursive: true })
  const destination = join(out, 'stream.csv')

  /**
   * 关键：在**第二次 read 即将开始**时检查磁盘上的文件。
   *
   * ⚠️ 要看的是**临时文件**（同目录的 `.xxx.dbstudio-*.tmp`），不是目标文件：
   * 目标文件要到最终 rename 才出现，用它判断"首批是否落盘"永远是"不存在"，
   * 那条断言就变成了"目标文件不该提前出现"，测不到想测的东西。
   *
   * 若实现是"攒完所有批次再一次性写"，那么第一次 read 之后临时文件是 0 字节，
   * `bytesWritten` 也是 0 —— 这正是监督要求验收的点。
   */
  let observed = null
  let manager
  let taskId
  const source = makeSource({
    columns: ['id', 'name'],
    batches: [
      { rows: [[num(1), text('first')]], done: false },
      { rows: [[num(2), text('second')]], done: false },
      { rows: [], done: true }
    ],
    onRead: async (n) => {
      if (n === 2) {
        // 第二次 read 即将发生：此时第一批**应该**已经落盘
        const temps = tempArtifacts(out)
        let size = -1
        let content = ''
        if (temps.length > 0) {
          const tempPath = join(out, temps[0])
          size = existsSync(tempPath) ? statSync(tempPath).size : -1
          content = existsSync(tempPath) ? readFileSync(tempPath, 'utf8') : ''
        }
        observed = {
          size,
          content,
          temps: temps.length,
          progress: manager ? manager.get(taskId) : undefined
        }
      }
      return undefined
    }
  })
  manager = makeManager(source)
  taskId = manager.start({
    source: { sql: 'SELECT 1', connectionId: 'c1' },
    format: 'csv',
    destinationPath: destination
  }).taskId
  await withTimeout(manager.wait(taskId), 10_000, '流式落盘任务')

  /**
   * ⚠️ 必须断言**数据行**已经落盘，不能只断言文件非空。
   *
   * CSV 的**表头**是在读第一批之前就写下的，所以"临时文件非空"这条断言
   * 即便在"攒完所有批次才一次性写"的实现下也成立 —— 那样的 bug 会漏过去。
   * 真正能区分两种实现的是：第一批的**数据行内容**是否已经在文件里。
   */
  check(
    '★ 首批数据行在第二次 read 之前就已落盘（临时文件里能看到数据）',
    observed !== null && typeof observed.content === 'string' && observed.content.includes('first'),
    `第二次 read 时临时文件内容=${JSON.stringify(observed?.content ?? '')}`
  )
  check(
    '★ 首批在第二次 read 之前就已落盘（临时文件非空）',
    observed !== null && observed.size > 0,
    `第二次 read 时临时文件大小=${observed?.size ?? 'N/A'}（临时文件数=${observed?.temps ?? 'N/A'}）`
  )
  check(
    '★ 首批在第二次 read 之前就已计入 bytesWritten（>0）',
    observed !== null &&
      observed.progress !== undefined &&
      observed.progress.bytesWritten > 0,
    `第二次 read 时 bytesWritten=${observed?.progress?.bytesWritten ?? 'N/A'}`
  )
}

// ===========================================================================
// 10. nullText = 'NUL' 是合法取值（不是 NUL 字符）
// ===========================================================================

console.log('\n[10] nullText 语义')

{
  const source = makeSource({
    columns: ['id', 'maybe'],
    batches: [{ rows: [[num(1), nul()]], done: true }]
  })
  const manager = makeManager(source)
  const destination = destPath('nulltext-nul')

  /**
   * ⚠️ 这里必须**捕获** start() 的异常，不能让它直接抛出去。
   *
   * `start()` 的参数错误是**同步抛出**的（这是契约）。若实现误把
   * nullText='NUL' 拒掉，异常会从 start() 抛出来——不捕获的话整个测试进程
   * 带着未处理异常退出，后面的断言一条都跑不到，报告里只会看到一行
   * stack trace，看不出"是哪一条契约被违反"。
   *
   * 捕获后转成一条失败断言，才能既精确又不掩盖后面的用例。
   */
  let taskId = null
  let startError = null
  try {
    taskId = manager.start({
      source: { sql: 'SELECT 1', connectionId: 'c1' },
      format: 'csv',
      destinationPath: destination,
      options: { nullText: 'NUL' }
    }).taskId
  } catch (err) {
    startError = err instanceof Error ? err.message : String(err)
  }
  check(
    "★ nullText='NUL' 是合法取值（不被当作 NUL 字符拒绝）",
    startError === null && taskId !== null,
    `start() 抛错: ${startError ?? '无'}`
  )

  const result =
    taskId === null
      ? { status: 'failed', message: startError ?? '任务未启动' }
      : await withTimeout(manager.wait(taskId), 10_000, 'nullText=NUL 任务')
  check(
    "★ nullText='NUL' 的导出任务能正常完成",
    result.status === 'completed',
    `status=${result.status} message=${result.message ?? ''}`
  )
  const csv = readIfExists(destination)
  check(
    "★ nullText='NUL' 时 NULL 写成 NUL 文本",
    typeof csv === 'string' && csv.includes('NUL'),
    `实际内容: ${JSON.stringify(csv)}`
  )
}

{
  // SQL INSERT 格式不允许 nullText（NULL 必须写成关键字）
  const source = makeSource({
    columns: ['id'],
    batches: [{ rows: [[num(1)]], done: true }]
  })
  const manager = makeManager(source)
  let threw = false
  let message = ''
  try {
    manager.start({
      source: { sql: 'SELECT 1', connectionId: 'c1' },
      format: 'sql-insert',
      destinationPath: destPath('sql-nulltext'),
      options: { nullText: 'NUL' }
    })
  } catch (err) {
    threw = true
    message = err instanceof Error ? err.message : String(err)
  }
  check(
    '★ SQL INSERT 格式拒绝 nullText（NULL 必须是 SQL 关键字）',
    threw,
    `居然接受了：${message}`
  )
  check(
    '★ SQL INSERT + nullText 被拒时不留下临时文件',
    tempArtifacts(outDir).length === 0,
    `残留: ${JSON.stringify(tempArtifacts(outDir))}`
  )
}

// ===========================================================================
// 11. 临时文件不得因命名碰撞而删掉别人的文件
// ===========================================================================

console.log('\n[11] 临时文件命名碰撞')

{
  const out = join(outDir, 'collision')
  mkdirSync(out, { recursive: true })
  const destination = join(out, 'collide.csv')

  // 先造一个"别人的文件"，名字模拟临时文件
  const foreign = join(out, '.collide.csv.dbstudio-someone-else.tmp')
  const FOREIGN_CONTENT = 'BELONGS TO ANOTHER PROCESS'
  writeFileSync(foreign, FOREIGN_CONTENT, 'utf8')

  const source = makeSource({
    batches: [{ rows: [[num(1), text('x')]], done: true }]
  })
  const manager = makeManager(source)
  const taskId = manager.start({
    source: { sql: 'SELECT 1', connectionId: 'c1' },
    format: 'csv',
    destinationPath: destination
  }).taskId
  const result = await withTimeout(manager.wait(taskId), 10_000, '碰撞任务')

  check(
    '★ 命名碰撞：别人的文件没有被删掉',
    existsSync(foreign) && readIfExists(foreign) === FOREIGN_CONTENT,
    `文件存在=${existsSync(foreign)} 内容=${JSON.stringify(readIfExists(foreign))}`
  )
  check(
    '★ 命名碰撞：本次导出仍然成功（临时名唯一）',
    result.status === 'completed',
    `status=${result.status} message=${result.message ?? ''}`
  )
}

// ===========================================================================
// 12. 截断值必须被拒绝
// ===========================================================================

console.log('\n[12] 截断值拒绝')

{
  const source = makeSource({
    columns: ['id', 'body'],
    batches: [
      {
        rows: [[num(1), { kind: 'text', text: '前 1000 字…', truncated: true, fullLength: 5000 }]],
        done: true
      }
    ]
  })
  const manager = makeManager(source)
  const destination = destPath('truncated')
  const taskId = manager.start({
    source: { sql: 'SELECT 1', connectionId: 'c1' },
    format: 'csv',
    destinationPath: destination
  }).taskId
  const result = await withTimeout(manager.wait(taskId), 10_000, '截断任务')
  check('★ 截断值被明确拒绝（任务 failed）', result.status === 'failed', `status=${result.status}`)
  check(
    '★ 截断值的错误信息提到具体列',
    typeof result.message === 'string' && result.message.includes('body'),
    `message=${result.message ?? ''}`
  )
  check('★ 截断值拒绝时不产出目标文件', !existsSync(destination), '文件被创建了')
  check(
    '★ 截断值拒绝后临时文件已清理',
    tempArtifacts(outDir).length === 0,
    `残留: ${JSON.stringify(tempArtifacts(outDir))}`
  )
}

// ===========================================================================
// 汇总
// ===========================================================================

const failed = results.filter((r) => !r.passed)
const passed = results.length - failed.length

console.log('')
console.log('─'.repeat(70))
console.log(`导出边界验收：${passed} 通过 / ${failed.length} 失败（共 ${results.length} 条）`)
console.log('─'.repeat(70))
if (failed.length > 0) {
  console.log('')
  console.log('失败明细：')
  for (const f of failed) {
    console.log(`  ❌ ${f.name}`)
    if (f.detail !== undefined) console.log(`       ↳ ${formatDetail(f.detail)}`)
  }
}

try {
  rmSync(workDir, { recursive: true, force: true })
} catch {
  // 清理失败不影响测试结论
}

if (failed.length > 0) process.exit(1)
