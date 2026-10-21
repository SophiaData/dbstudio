/**
 * 真实界面交互测试（GUI 端到端）。
 *
 * ===== 为什么必须单独有这一个测试 =====
 *
 * 项目原本的「GUI 自检」（main/index.ts 里的 DBSTUDIO_SMOKE）只用
 * `executeJavaScript` 读了一下 DOM，确认容器存在、preload 白名单注入了。
 * 它能证明「界面起来了」，但**证明不了「界面能用」**——
 * 按钮绑没绑事件、点击后逻辑走不走得通，它一概不知道。
 *
 * 这个测试用 Playwright 的 Electron 支持，像真人一样：
 *   新建连接 → 展开树 → 点表看数据 → 双击改单元格 → 应用 → 提交 → 验证落盘
 * 每一步都是真实 DOM 事件，走的是渲染进程里 main.ts / tree.ts / grid.ts 的真实代码路径。
 *
 * 顺带截图存到 out/gui-flow/，便于人工复核界面长相。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
// playwright 从 npx 缓存里解析（本项目刻意不把它列为依赖：它只服务于这个测试，
// 装进 node_modules 会让 Electron 打包体积和依赖面变大）


const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 解析 playwright 入口。
//
// 两个坑：
//   1. ESM 不接受目录导入，必须给出具体文件路径
//   2. playwright 的 `exports` 只导出 `.`，`playwright/index.js` 不是合法子路径
//      （报 ERR_PACKAGE_PATH_NOT_EXPORTED），所以必须解析**裸名**
// 另外 require.resolve 的 `paths` 接收的是**起始目录**（它会在其下找 node_modules），
// 不是 node_modules 目录本身——这点也踩过。
function resolvePlaywrightEntry() {
  const searchRoots = [
    // 优先项目自己的依赖。用 playwright-core 而不是 playwright：
    // 后者 postinstall 会下载几百 MB 的浏览器，而我们只需要它的 Electron 支持，
    // playwright-core 完全够用且零下载。
    root,
    // npx 缓存的父目录（`npx playwright` 或 @playwright/mcp 拉过就有）
    '/Users/gaotingkai/.npm/_npx/86170c4cd1c5da32',
    ...(process.env['DBSTUDIO_PLAYWRIGHT_PATHS'] ?? '').split(':').filter(Boolean)
  ]
  for (const base of searchRoots) {
    try {
      const req = createRequire(join(base, '__resolve__.js'))
      try {
        return req.resolve('playwright-core')
      } catch {
        return req.resolve('playwright')
      }
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(
    '未找到 playwright。请执行 `npx playwright@latest --version` 拉取，\n' +
      '或设置 DBSTUDIO_PLAYWRIGHT_PATHS 指向含 playwright 的目录（其下应有 node_modules）。'
  )
}
// CJS → ESM 互操作：playwright 主入口是 CJS，`_electron` 挂在 default 上，
// 顶层命名导出里没有它。两种形态都兜一下。
const pwMod = await import(pathToFileURL(resolvePlaywrightEntry()).href)
const electron = pwMod._electron ?? pwMod.default?._electron
if (!electron) {
  throw new Error('playwright 已加载但拿不到 _electron（Electron 支持），请确认版本 ≥1.30')
}

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---- 准备一个干净的库供界面操作 ----
const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-gui-'))
const dbPath = join(workDir, 'gui.db')
{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT);
    INSERT INTO customers (id, name, city) VALUES
      (1, 'Alice', 'Beijing'), (2, 'Bob', 'Shanghai');
  `)
  db.close()
}

// 每次测试用独立的 userData，避免受本机已有连接配置影响
const userDataDir = join(workDir, 'userdata')
mkdirSync(userDataDir, { recursive: true })
const shotDir = join(root, 'out/gui-flow')
mkdirSync(shotDir, { recursive: true })

console.log('启动应用…')
// Playwright 会从**自己的安装位置**找 Electron，找不到项目里的那个，
// 所以必须显式给出 executablePath。直接问项目的 electron 包要（跨平台正确）。
const electronBin = createRequire(join(root, 'x.js'))('electron')
if (typeof electronBin !== 'string') {
  throw new Error('无法定位项目内的 Electron 可执行文件，请先 pnpm install')
}

// Linux CI 上 chrome-sandbox 的 SUID 权限不满足要求，Electron 会直接 FATAL。
// 与 run-in-electron.mjs 的处理保持一致：只在显式要求时关沙箱。
const extraArgs =
  process.env['ELECTRON_DISABLE_SANDBOX'] === '1' && process.platform === 'linux'
    ? ['--no-sandbox']
    : []

const app = await electron.launch({
  executablePath: electronBin,
  args: ['.', `--user-data-dir=${userDataDir}`, ...extraArgs],
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, DBSTUDIO_GUI_FLOW: '1' }
})

const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
// 用 attached 而不是默认的 visible：树为空时 #tree-rows 高度为 0，
// Playwright 会判定「不可见」而超时。空树是合法初始状态。
await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })
check('应用启动并渲染出界面', true)
await win.screenshot({ path: join(shotDir, '01-启动.png') })

// ---------------------------------------------------------------------------
console.log('\n[1] 通过界面新建连接（真实填表 + 点击）')
await win.click('#btn-new-connection')
await win.waitForSelector('#dlg-connection[open]', { state: 'attached', timeout: 5000 })
check('「新建连接」对话框打开', true)

// 方言下拉应有 SQLite
const dialectOptions = await win.$$eval('#f-dialect option', (els) => els.map((e) => e.value))
check('方言下拉含 sqlite', dialectOptions.includes('sqlite'), dialectOptions.join(','))

await win.fill('#f-name', 'GUI 测试库')
// 动态字段：SQLite 的 file 输入框
await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached', timeout: 5000 })
await win.fill('#f-dynamic input[data-key="file"]', dbPath)
await win.screenshot({ path: join(shotDir, '02-填表.png') })

await win.click('#btn-submit')
// 等「对话框关闭」或「错误出现」。
// 注意不能用 waitForSelector 的 visible 语义：关掉的 <dialog> 是 display:none，
// 永远不满足 visible，只会白白超时。这里用状态轮询，语义才对。
await win.waitForFunction(
  () => {
    const d = document.getElementById('dlg-connection')
    const e = document.getElementById('f-error')
    return (d && !d.hasAttribute('open')) || (e && !e.hasAttribute('hidden'))
  },
  { timeout: 20000 }
)
const dialogClosed = await win.$eval('#dlg-connection', (d) => !d.hasAttribute('open'))
const errText = await win.$eval('#f-error', (e) => (e.hasAttribute('hidden') ? '' : e.textContent))
check('连接成功（对话框关闭）', dialogClosed, errText || '（对话框仍开着）')
await win.screenshot({ path: join(shotDir, '03-已连接.png') })

// ---------------------------------------------------------------------------
console.log('\n[2] 展开元数据树（真实点击箭头）')
await win.waitForFunction(
  () => document.querySelectorAll('#tree-rows .tree-row').length >= 1,
  { timeout: 10000 }
)
const connRows = await win.$$eval('#tree-rows .tree-row', (els) =>
  els.map((e) => e.textContent?.trim() ?? '')
)
check('树里出现连接节点', connRows.some((t) => t.includes('GUI 测试库')), connRows.join(' | '))

// 摘要文案：早先这个元素写死在 HTML 里（永远显示「未连接」），
// 即使已经连上库也不变——属于误导用户的信息，这里钉住它。
const summary = await win.$eval('#tree-summary', (e) => e.textContent ?? '')
check('树摘要反映真实状态（不再是写死的「未连接」）',
  summary.includes('连接') && !summary.trim().startsWith('未连接'),
  JSON.stringify(summary))

// 点连接节点的展开箭头
await win.click('#tree-rows .tree-row .twisty')
await win.waitForFunction(
  () => document.querySelectorAll('#tree-rows .tree-row').length >= 3,
  { timeout: 10000 }
)
const afterExpand = await win.$$eval('#tree-rows .tree-row', (els) =>
  els.map((e) => e.textContent?.trim() ?? '')
)
check('展开后出现分组（表/视图）', afterExpand.some((t) => t.includes('表')), afterExpand.join(' | '))
await win.screenshot({ path: join(shotDir, '04-展开树.png') })

// 展开「表」分组 → 找到 customers
const tableFolderClicked = await win.evaluate(() => {
  const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
  const folder = rows.find((r) => r.textContent?.includes('表'))
  const twisty = folder?.querySelector('.twisty')
  if (!twisty) return false
  twisty.click()
  return true
})
check('点击「表」分组的展开箭头', tableFolderClicked)
await win.waitForFunction(
  () => [...document.querySelectorAll('#tree-rows .tree-row')].some((r) => r.textContent?.includes('customers')),
  { timeout: 10000 }
)
check('看到 customers 表', true)
await win.screenshot({ path: join(shotDir, '05-表列表.png') })

// ---------------------------------------------------------------------------
console.log('\n[3] 点击表 → 结果集网格加载真实数据')
await win.evaluate(() => {
  const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
  const target = rows.find((r) => r.textContent?.includes('customers'))
  if (target) target.click()
})
await win.waitForFunction(
  () => document.querySelectorAll('#result-grid .grid-row').length > 0,
  { timeout: 15000 }
)
const gridInfo = await win.evaluate(() => {
  const header = [...document.querySelectorAll('#result-grid .grid-col-header')].map(
    (e) => e.textContent
  )
  const rows = [...document.querySelectorAll('#result-grid .grid-row')].map((r) =>
    [...r.querySelectorAll('.grid-cell')].map((c) => c.textContent)
  )
  const editable = document.getElementById('result-grid')?.dataset['editable']
  const banner = document.querySelector('#result-grid .grid-banner')
  return { header, rows, editable, bannerHidden: banner?.hidden ?? null }
})
check('列头正确（# / id / name / city）',
  gridInfo.header.includes('id') && gridInfo.header.includes('name') && gridInfo.header.includes('city'),
  gridInfo.header.join(','))
const dataRows = gridInfo.rows.filter((r) => r[0] !== '#' && !r.every((c) => c === ''))
check('网格渲染出数据行', dataRows.length >= 2, `实际 ${dataRows.length} 行`)
check('读到 Alice', JSON.stringify(gridInfo.rows).includes('Alice'))
check('有唯一键 → 可编辑', gridInfo.editable === 'true', String(gridInfo.editable))

// 网格列宽/列数自检。
// 为什么值得断言：列宽固定（160px）时，若表头/行被拉伸到铺满容器，
// 右侧会露出一片带底色的区域，看起来像"多了一列空列"。
// 这里直接量尺寸，比肉眼看截图可靠。
const metrics = await win.evaluate(() => {
  const pane = document.getElementById('detail-pane')
  const hdr = document.querySelector('#result-grid .grid-header')
  // 必须限定在**单行内**取单元格。早先写成全局选择器
  // `#result-grid .grid-row .grid-cell`，它会把所有行的格子加起来
  // （2 行 × 4 列 = 8），于是拿 8 和表头的 4 比较，误报成「列数不一致」。
  const row = document.querySelector('#result-grid .grid-row')
  const cellsIn = (root) => (root ? root.querySelectorAll('.grid-cell').length : 0)
  return {
    paneW: Math.round(pane.getBoundingClientRect().width),
    hdrW: Math.round(hdr.getBoundingClientRect().width),
    hdrCells: cellsIn(hdr),
    rowCells: cellsIn(row),
    rowCount: document.querySelectorAll('#result-grid .grid-row').length
  }
})
check('表头与数据行列数一致（不会错位）',
  metrics.hdrCells === metrics.rowCells,
  `表头 ${metrics.hdrCells} vs 行 ${metrics.rowCells}（共 ${metrics.rowCount} 行）`)
check('表头未铺满面板（不出现假的空列）',
  metrics.hdrW < metrics.paneW,
  `表头 ${metrics.hdrW}px / 面板 ${metrics.paneW}px`)
await win.screenshot({ path: join(shotDir, '06-结果集.png') })

// ---------------------------------------------------------------------------
console.log('\n[4] 双击单元格 → 输入 → 应用 → 提交（完整编辑流程）')
// 双击第 1 行的 name 列（列序：# id name city → index 2）
const dblClicked = await win.evaluate(() => {
  const row = document.querySelector('#result-grid .grid-row')
  if (!row) return false
  const cells = [...row.querySelectorAll('.grid-cell')]
  const target = cells[2]
  if (!target) return false
  target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  return true
})
check('双击进入编辑态', dblClicked)
await win.waitForSelector('#result-grid .grid-cell-editor', { state: 'attached', timeout: 5000 })
check('出现单元格输入框', true)
await win.screenshot({ path: join(shotDir, '07-编辑中.png') })

const editor = await win.$('#result-grid .grid-cell-editor')
await editor.fill('Alice-EDITED')
await editor.press('Enter')
// 编辑器关闭且单元格标脏
await win.waitForFunction(
  () => document.querySelectorAll('#result-grid .grid-cell.is-dirty').length > 0,
  { timeout: 5000 }
)
check('改动被标记为脏（is-dirty）', true)
await win.screenshot({ path: join(shotDir, '08-脏标记.png') })

// 点「应用修改」
const applied = await win.evaluate(() => {
  const btns = [...document.querySelectorAll('#result-grid button')]
  const b = btns.find((x) => x.textContent?.includes('应用修改'))
  if (!b || b.disabled) return false
  b.click()
  return true
})
check('点击「应用修改」', applied)
await win.waitForFunction(
  () => {
    const btns = [...document.querySelectorAll('#result-grid button')]
    const c = btns.find((x) => x.textContent?.trim() === '提交')
    return c ? !c.disabled : false
  },
  { timeout: 10000 }
)
check('事务已建立（「提交」按钮可用）', true)

// 点「提交」
await win.evaluate(() => {
  const btns = [...document.querySelectorAll('#result-grid button')]
  const c = btns.find((x) => x.textContent?.trim() === '提交'); if (c) c.click()
})
await win.waitForTimeout(1500)
await win.screenshot({ path: join(shotDir, '09-已提交.png') })

// ---------------------------------------------------------------------------
console.log('\n[5] 验证改动真的落库（绕过界面直读文件）')
const verifyDb = new DatabaseSync(dbPath)
const row = verifyDb.prepare('SELECT name FROM customers WHERE id = 1').get()
verifyDb.close()
check('★ 界面上的编辑已写入数据库文件', row?.name === 'Alice-EDITED', String(row?.name))

// ---------------------------------------------------------------------------
console.log('\n[6] 用 SQL 输入框执行查询')
await win.fill('#sql-input', 'SELECT COUNT(*) AS total FROM customers')
await win.click('#btn-run-sql')
await win.waitForFunction(
  () => document.querySelector('#result-grid')?.hidden === false,
  { timeout: 10000 }
)
await win.waitForTimeout(1200)
const sqlResult = await win.evaluate(() => {
  const rows = [...document.querySelectorAll('#result-grid .grid-row')].map((r) =>
    [...r.querySelectorAll('.grid-cell')].map((c) => c.textContent)
  )
  const editable = document.getElementById('result-grid')?.dataset['editable']
  return { rows, editable }
})
check('SQL 查询有结果', JSON.stringify(sqlResult.rows).includes('2'), JSON.stringify(sqlResult.rows))
check('自由 SQL 结果只读', sqlResult.editable === 'false', String(sqlResult.editable))
await win.screenshot({ path: join(shotDir, '10-SQL查询.png') })

// ---------------------------------------------------------------------------
console.log('\n[7] 无控制台错误')
const errors = []
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
await win.waitForTimeout(500)
check('渲染进程无未捕获错误', errors.length === 0, errors.join(' | '))

await app.close()

console.log(`\n===== GUI 交互测试：${pass} 通过 / ${fail} 失败 =====`)
console.log(`截图目录: ${shotDir}`)
process.exit(fail > 0 ? 1 : 0)
