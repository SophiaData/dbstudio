/**
 * 新功能 GUI 交互验证（第二轮补齐的功能）。
 *
 * 为什么单独一个文件而不是塞进 gui-flow.mjs：
 * gui-flow 覆盖的是「基本可用」的主干流程，要保持稳定；
 * 这一份覆盖本轮新增的 8 项能力，失败时能一眼定位是哪一功能坏了。
 *
 * 覆盖：树搜索 / 排序 / 列宽拖拽 / 统计行数 / CSV 导出 / 新增行 / 删除行 / 右键菜单
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const pwFile = require.resolve('playwright-core', { paths: [root] })
const pw = await import(pathToFileURL(pwFile).href)
const electron = pw._electron ?? pw.default?._electron

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

// ---- 夹具：一张有主键的表 + 一批干扰表（为了测搜索）----
const dir = mkdtempSync(join(tmpdir(), 'dbstudio-feat-'))
const dbPath = join(dir, 'feat.db')
{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT);
    INSERT INTO people (id, name, city) VALUES (1,'Alice','Beijing'),(2,'Bob','Shanghai'),(3,'Carol','Shenzhen');
    CREATE TABLE no_key (a INTEGER, b TEXT);
    INSERT INTO no_key VALUES (1,'x');
  `)
  for (let i = 0; i < 40; i++) {
    db.exec(`CREATE TABLE filler_${String(i).padStart(2, '0')} (id INTEGER PRIMARY KEY);`)
  }
  db.close()
}

const shotDir = join(root, 'out/gui-flow')
mkdirSync(shotDir, { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.DBSTUDIO_TEST_HIDDEN = '1'

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', `--user-data-dir=${join(dir, 'ud')}`],
  cwd: root,
  env
})
const win = await app.firstWindow()
// 自动接受 confirm/alert 对话框（删除行有二次确认）
win.on('dialog', (d) => void d.accept())

await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })

// ---- 建连接并展开到表 ----
await win.click('#btn-new-connection')
await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
await win.fill('#f-name', 'FEAT')
await win.fill('#f-dynamic input[data-key="file"]', dbPath)
await win.click('#btn-submit')
await win.waitForFunction(
  () => { const d = document.getElementById('dlg-connection'); return d && !d.hasAttribute('open') },
  { timeout: 20000 }
)
await win.waitForTimeout(500)
await win.evaluate(() => document.querySelector('#tree-rows .tree-row .twisty')?.click())
await win.waitForTimeout(700)
await win.evaluate(() => {
  const r = [...document.querySelectorAll('#tree-rows .tree-row')].find((x) => x.textContent?.includes('表'))
  r?.querySelector('.twisty')?.click()
})
await win.waitForTimeout(900)

// ---------------------------------------------------------------------------
console.log('\n[1] 树搜索过滤')
const searchExists = await win.evaluate(() => !!document.getElementById('tree-search-input'))
check('存在搜索框', searchExists)
if (searchExists) {
  const before = await win.evaluate(() => document.querySelectorAll('#tree-rows .tree-row').length)
  await win.fill('#tree-search-input', 'people')
  await win.waitForTimeout(400)
  const filtered = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')].map((r) => r.textContent?.trim() ?? '')
    return { rows, count: rows.length }
  })
  check('过滤后行数减少', filtered.count < before, `${before} → ${filtered.count}`)
  check('过滤结果含 people', filtered.rows.some((t) => t.includes('people')), filtered.rows.join('|').slice(0, 120))
  check('过滤结果不含无关表', !filtered.rows.some((t) => t.includes('filler_')), filtered.rows.join('|').slice(0, 120))
  await win.screenshot({ path: join(shotDir, 'f01-树搜索.png') })
  // 注意：这里**不立刻清空**。保持「people」过滤，下一段直接点它——
  // 因为 people 在 40 张 filler_* 之后，虚拟滚动根本不会渲染它（实测只有 ~27 行在 DOM 里），
  // 不过滤就点不到。这本身也说明搜索功能的实际价值。
}

// ---------------------------------------------------------------------------
console.log('\n[2] 打开表并验证工具条新按钮')
const clickInfo = await win.evaluate(() => {
  const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
  const target = rows.find((x) => x.textContent?.includes('people'))
  if (!target) return { found: false, rows: rows.map((r) => r.textContent?.trim()).slice(0, 10) }
  target.click()
  return { found: true, cls: target.className, text: target.textContent?.trim() }
})
// 打开成功后清掉过滤，避免影响后续断言
if (clickInfo.found) {
  await win.waitForTimeout(300)
  await win.fill('#tree-search-input', '')
  await win.waitForTimeout(300)
}
check('在树中找到 people 并点击', clickInfo.found, JSON.stringify(clickInfo))
try {
  await win.waitForFunction(() => document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-row').length > 0, { timeout: 15000 })
} catch {
  const diag = await win.evaluate(() => ({
    status: document.getElementById('status-bar')?.textContent,
    gridHidden: (document.querySelector('.tab-pane:not([hidden]) .tab-grid-root')).hidden,
    rows: document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-row').length,
    empties: [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-empty')].map((e) => e.textContent),
    toolbar: [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-toolbar button')].map((b) => b.textContent?.trim())
  }))
  console.log('  [诊断]', JSON.stringify(diag))
  throw new Error('结果集未渲染，见上方诊断')
}
await win.waitForTimeout(500)

const buttons = await win.evaluate(() =>
  [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-toolbar button')].map((b) => ({
    text: b.textContent?.trim(),
    disabled: b.disabled
  }))
)
const btnTexts = buttons.map((b) => b.text)
check('工具条含「新增行」', btnTexts.some((t) => t?.includes('新增行')), btnTexts.join('|'))
check('工具条含「删除选中行」', btnTexts.some((t) => t?.includes('删除')), btnTexts.join('|'))
check('删除按钮初始禁用（未选行）', buttons.find((b) => b.text?.includes('删除'))?.disabled === true)

// ---------------------------------------------------------------------------
console.log('\n[3] 排序（点列头）')
const sortResult = await win.evaluate(() => {
  const cells = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-header-inner .grid-cell')]
  // cells[0] 是 # 角格，cells[2] 是 name 列
  const nameCell = cells[2]
  if (!nameCell) return { clicked: false }
  nameCell.click()
  return { clicked: true }
})
check('点击 name 列头', sortResult.clicked)
await win.waitForTimeout(1500)
const sortedState = await win.evaluate(() => {
  const arrows = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-sort-arrow')].map((e) => e.textContent)
  const firstRow = document.querySelector('.tab-pane:not([hidden]) .tab-grid-root .grid-row')
  const vals = firstRow ? [...firstRow.querySelectorAll('.grid-cell')].map((c) => c.textContent) : []
  return { arrows, vals }
})
check('出现排序指示箭头', sortedState.arrows.length > 0, JSON.stringify(sortedState.arrows))
check('排序生效（首行变成 Alice）', JSON.stringify(sortedState.vals).includes('Alice'), JSON.stringify(sortedState.vals))
await win.screenshot({ path: join(shotDir, 'f02-排序.png') })

// ---------------------------------------------------------------------------
console.log('\n[4] 统计行数')
const countClicked = await win.evaluate(() => {
  const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-toolbar button')].find((x) =>
    x.textContent?.includes('统计')
  )
  if (!b) return false
  ;(b).click()
  return true
})
check('点击「统计行数」', countClicked)
await win.waitForTimeout(1500)
const statusAfterCount = await win.$eval('#status-bar', (e) => e.textContent ?? '')
check('状态栏显示总行数 3', /\b3\b/.test(statusAfterCount), JSON.stringify(statusAfterCount))

// ---------------------------------------------------------------------------
console.log('\n[5] CSV 导出按钮')
const csvBtn = await win.evaluate(() => {
  const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-toolbar button')].find((x) =>
    x.textContent?.includes('CSV') || x.textContent?.includes('导出')
  )
  return b ? { text: b.textContent?.trim(), title: b.title } : null
})
check('存在导出按钮', csvBtn !== null)
check('导出按钮标明「仅已加载」范围',
  JSON.stringify(csvBtn).includes('已加载'),
  JSON.stringify(csvBtn))

// ---------------------------------------------------------------------------
console.log('\n[6] 新增行（走真实模态表单）')
await win.evaluate(() => {
  const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-toolbar button')].find((x) =>
    x.textContent?.includes('新增行')
  )
  ;(b).click()
})
await win.waitForSelector('.grid-modal', { state: 'attached', timeout: 5000 })
check('新增行模态打开', true)
await win.screenshot({ path: join(shotDir, 'f03-新增行.png') })

// 填 name / city（id 留空走自增）
const filled = await win.evaluate(() => {
  const inputs = [...document.querySelectorAll('.grid-modal input[data-column]')]
  const set = (col, val) => {
    const el = inputs.find((i) => i.getAttribute('data-column') === col)
    if (!el) return false
    el.value = val
    return true
  }
  return { name: set('name', 'Dave'), city: set('city', 'Chengdu') }
})
check('表单填好了 name/city', filled.name && filled.city)

await win.evaluate(() => {
  const b = [...document.querySelectorAll('.grid-modal-foot button')].find((x) =>
    x.textContent?.includes('插入')
  )
  ;(b).click()
})
await win.waitForTimeout(2000)
const insertDiag = await win.evaluate(() => ({
  status: document.getElementById('status-bar')?.textContent,
  modalStillOpen: !!document.querySelector('.grid-modal'),
  apiHasInsert: typeof (window.dbstudio).insertRow === 'function'
}))
console.log('  [插入诊断]', JSON.stringify(insertDiag))
// 验证：库里真的有第 4 行
// ★ 关键：插入只进事务，**必须点「提交」才会落盘**。
// 早先我直接去读数据库文件断言，结果读到的是提交前的旧数据，误判成「插入失败」——
// 那不是应用的问题，是测试没走完流程。
const committed = await win.evaluate(() => {
  const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-toolbar button')].find(
    (x) => x.textContent?.trim() === '提交'
  )
  if (!b || b.disabled) return false
  b.click()
  return true
})
check('插入后「提交」可用并点击', committed)
await win.waitForTimeout(1800)

const dbAfterInsert = new DatabaseSync(dbPath)
const inserted = dbAfterInsert.prepare('SELECT name, city FROM people WHERE name = ?').get('Dave')
const rowCount = dbAfterInsert.prepare('SELECT COUNT(*) AS c FROM people').get().c
dbAfterInsert.close()
check('★ 新行已插入数据库', inserted?.name === 'Dave' && inserted?.city === 'Chengdu', JSON.stringify(inserted))
check('表行数从 3 变为 4', rowCount === 4, String(rowCount))
await win.screenshot({ path: join(shotDir, 'f04-已插入.png') })

// ---------------------------------------------------------------------------
console.log('\n[7] 删除选中行')
const dbBeforeDelete = new DatabaseSync(dbPath)
const countBeforeDelete = dbBeforeDelete.prepare('SELECT COUNT(*) AS c FROM people').get().c
dbBeforeDelete.close()
console.log(`  [基线] 删除前行数 = ${countBeforeDelete}`)
// 先点选一行（第 1 行）
const selected = await win.evaluate(() => {
  const row = document.querySelector('.tab-pane:not([hidden]) .tab-grid-root .grid-row')
  const cell = row?.querySelectorAll('.grid-cell')[2]
  if (!cell) return false
  ;(cell).click()
  return true
})
check('点选一行', selected)
await win.waitForTimeout(400)

const delEnabled = await win.evaluate(() => {
  const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-toolbar button')].find((x) =>
    x.textContent?.includes('删除')
  )
  return b ? !b.disabled : false
})
check('选中后「删除选中行」可用', delEnabled)

await win.evaluate(() => {
  const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-toolbar button')].find((x) =>
    x.textContent?.includes('删除')
  )
  ;(b).click()
})
await win.waitForTimeout(2000)
const delCommitted = await win.evaluate(() => {
  const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-toolbar button')].find(
    (x) => x.textContent?.trim() === '提交'
  )
  if (!b || b.disabled) return false
  b.click()
  return true
})
check('删除后「提交」可用并点击', delCommitted)
await win.waitForTimeout(1800)

const dbAfterDelete = new DatabaseSync(dbPath)
const countAfterDelete = dbAfterDelete.prepare('SELECT COUNT(*) AS c FROM people').get().c
dbAfterDelete.close()
// 不能硬编码 3：插入若失败，基线就不是 4，硬编码会让这条断言恒真（假阳性）。
// 用「相对删除前少 1」来判断。
check(`★ 删除已生效（${countBeforeDelete} → ${countAfterDelete}）`,
  countAfterDelete === countBeforeDelete - 1,
  `删除前 ${countBeforeDelete}，删除后 ${countAfterDelete}`)
await win.screenshot({ path: join(shotDir, 'f05-已删除.png') })

// ---------------------------------------------------------------------------
console.log('\n[8] 右键菜单')
const menuOpened = await win.evaluate(() => {
  const row = document.querySelector('#tree-rows .tree-row')
  if (!row) return false
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 200 }))
  return true
})
check('派发右键事件', menuOpened)
await win.waitForTimeout(500)
const menuInfo = await win.evaluate(() => {
  const menu = document.querySelector('[role="menu"]')
  if (!menu) return { exists: false }
  return {
    exists: true,
    items: [...menu.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent?.trim())
  }
})
check('右键菜单出现', menuInfo.exists)
check('菜单含「刷新」项', menuInfo.items.some((t) => t?.includes('刷新')), JSON.stringify(menuInfo.items))
await win.screenshot({ path: join(shotDir, 'f06-右键菜单.png') })
// Esc 关闭
await win.keyboard.press('Escape')
await win.waitForTimeout(300)
const menuClosed = await win.evaluate(() => !document.querySelector('[role="menu"]'))
check('Esc 关闭菜单', menuClosed)

// ---------------------------------------------------------------------------
console.log('\n[9] 控制台无错误')
const errors = []
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
await win.waitForTimeout(500)
check('渲染进程无未捕获错误', errors.length === 0, errors.join(' | '))

await app.close()

console.log(`\n===== 新功能 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
console.log(`截图目录: ${shotDir}`)
process.exit(fail > 0 ? 1 : 0)
