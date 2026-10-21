/**
 * 布局持久化（排序 / 列宽）的 **Electron 端到端** 验证。
 *
 * ===== 为什么必须有这个文件，纯 Node 自检不够 =====
 *
 * 纯 Node 测试只能验证 `layout-persist.ts` 的纯函数（key 生成、坏数据容错、
 * 列名失效丢弃）。但那个文件**不是**功能本身——真正的功能是
 * 「用户拖宽一列 → 关掉标签 → 重新打开表 → 列宽还在」。
 * 这条链路上有 localStorage、有网格实例重建、有 openTable 的执行顺序，
 * 任何一环接错，纯函数测试都会绿。
 *
 * 所以这里用真实 Electron 渲染进程做三件事：
 *   1. 拖宽列 + 点排序 → 断言 localStorage 里真的写了对应的 key
 *   2. 重新打开同一张表 → 断言列宽/排序被恢复（这才是"持久化"）
 *   3. 模拟"列名变了"（手改存储里的列名）→ 断言不炸且过期条目被忽略
 *   4. 点「重置布局」→ 断言存储被清掉、布局回到默认
 *
 * 运行：node tests/gui-layout.mjs
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

// ---- 夹具：一张表，列名固定 ----
const dir = mkdtempSync(join(tmpdir(), 'dbstudio-layout-'))
const dbPath = join(dir, 'layout.db')
{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer TEXT NOT NULL,
      amount INTEGER,
      note TEXT
    );
    INSERT INTO orders (id, customer, amount, note) VALUES
      (1,'alice',100,'n1'), (2,'bob',250,'n2'), (3,'carol',30,'n3');
  `)
  db.close()
}

const shotDir = join(root, 'out/gui-flow')
mkdirSync(shotDir, { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', `--user-data-dir=${join(dir, 'ud')}`],
  cwd: root,
  env
})
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())

await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })

// ---- 建连接 → 展开到表 ----
await win.click('#btn-new-connection')
await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
await win.fill('#f-name', 'LAYOUT')
await win.fill('#f-dynamic input[data-key="file"]', dbPath)
await win.click('#btn-submit')
await win.waitForFunction(
  () => {
    const d = document.getElementById('dlg-connection')
    return d && !d.hasAttribute('open')
  },
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

async function debugDom(label) {
  const info = await win.evaluate(() => ({
    panes: [...document.querySelectorAll('.tab-pane')].map((p) => ({ hidden: p.hasAttribute('hidden'), cls: p.className })),
    gridRoots: document.querySelectorAll('.tab-grid-root').length,
    headerCells: document.querySelectorAll('.grid-col-header').length,
    rows: document.querySelectorAll('.grid-row').length,
    bodyHasError: (document.body.textContent ?? '').includes('失败'),
    treeRows: [...document.querySelectorAll('#tree-rows .tree-row')].map((r) => r.textContent?.trim()).slice(0, 12)
  }))
  console.log(`  [debug:${label}] ${JSON.stringify(info)}`)
  return info
}

async function openOrders() {
  const clicked = await win.evaluate(() => {
    const row = [...document.querySelectorAll('#tree-rows .tree-row')].find((x) =>
      x.textContent?.trim().endsWith('orders')
    )
    if (!row) {
      return { ok: false, rows: [...document.querySelectorAll('#tree-rows .tree-row')].map((r) => r.textContent?.trim()).slice(0, 12) }
    }
    row.click()
    return { ok: true, text: row.textContent?.trim() }
  })
  if (!clicked.ok) console.log(`  ⚠ 未找到 orders 行，当前树：${JSON.stringify(clicked.rows)}`)
  await win.waitForFunction(
    (sel) => document.querySelectorAll(sel).length > 0,
    `${'.tab-pane:not([hidden]) .tab-grid-root'} .grid-col-header`,
    { timeout: 15000 }
  )
  await win.waitForTimeout(400)
}

// ---------------------------------------------------------------------------
console.log('\n[1] 打开表 → 默认布局')
await openOrders()
const hasGrid = await win.evaluate(() => document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-col-header').length > 0)
check('表已打开', hasGrid)
if (!hasGrid) {
  console.log('  表没打开，后续断言无法进行')
  await app.close()
  process.exit(1)
}

const colNames = await win.evaluate(() =>
  [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-col-header')].map((c) => c.textContent?.trim() ?? '')
)
console.log(`  列 = ${JSON.stringify(colNames)}`)

/** 读渲染进程 localStorage（按我们的 key 规则）。 */
async function readStorage() {
  return await win.evaluate(() => {
    const out = {}
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i)
      if (k && k.startsWith('dbstudio.')) out[k] = localStorage.getItem(k)
    }
    return out
  })
}
/** 读某列当前的像素宽度。 */
async function colWidth(name) {
  return await win.evaluate((n) => {
    const cell = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-col-header')].find((c) =>
      c.textContent?.includes(n)
    )
    return cell ? Math.round(cell.getBoundingClientRect().width) : -1
  }, name)
}

// ---------------------------------------------------------------------------
console.log('\n[2] 拖宽 customer 列 → localStorage 应写入')
const widthBefore = await colWidth('customer')
// 用真实鼠标拖拽列宽手柄（与用户操作一致，避免直接调内部方法）
const handleBox = await win.evaluate(() => {
  const cell = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-col-header')].find((c) =>
    c.textContent?.includes('customer')
  )
  const handle = cell?.querySelector('.grid-col-resizer')
  if (!handle) return null
  const r = handle.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
check('找到列宽拖拽手柄', handleBox !== null)
if (handleBox) {
  await win.mouse.move(handleBox.x, handleBox.y)
  await win.mouse.down()
  await win.mouse.move(handleBox.x + 120, handleBox.y, { steps: 10 })
  await win.mouse.up()
  await win.waitForTimeout(600)
}
const widthAfter = await colWidth('customer')
console.log(`  customer 列宽：${widthBefore}px → ${widthAfter}px`)
check('拖拽后列宽确实变宽', widthAfter > widthBefore + 80, `${widthBefore} → ${widthAfter}`)

const storageAfterDrag = await readStorage()
console.log(`  localStorage = ${JSON.stringify(storageAfterDrag)}`)
const keys = Object.keys(storageAfterDrag)
check('localStorage 出现了 dbstudio 布局 key', keys.length > 0, keys.join('|'))
const layoutKey = keys[0]
check('key 里含 dialect=sqlite', layoutKey?.includes('sqlite') === true, layoutKey ?? '')
check('key 里含表名 orders', layoutKey?.includes('orders') === true, layoutKey ?? '')
const savedWidths = layoutKey ? JSON.parse(storageAfterDrag[layoutKey])?.columnWidths ?? {} : {}
console.log(`  存储的列宽 = ${JSON.stringify(savedWidths)}`)
check('存储里记录了 customer 的新宽度', typeof savedWidths['customer'] === 'number' && savedWidths['customer'] > widthBefore + 80, savedWidths)
await win.screenshot({ path: join(shotDir, 'L01-列宽已保存.png') })

// ---------------------------------------------------------------------------
console.log('\n[3] 点排序 → 存储里应记录排序列')
await win.evaluate(() => {
  const cell = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-col-header')].find((c) =>
    c.textContent?.includes('amount')
  )
  cell?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await win.waitForTimeout(1500)
const storageAfterSort = await readStorage()
const sortSaved = layoutKey ? JSON.parse(storageAfterSort[layoutKey] ?? '{}')?.sort : null
console.log(`  存储的排序 = ${JSON.stringify(sortSaved)}`)
check('存储里记录了排序（列名 + 方向）', sortSaved?.columnName === 'amount', sortSaved)
check('排序方向是 asc', sortSaved?.direction === 'asc', sortSaved)

// ---------------------------------------------------------------------------
console.log('\n[4] 关掉标签再重新打开 → 布局应被恢复')
// 关掉当前标签，再从树上重新打开
await win.evaluate(() => {
  const closeBtn = document.querySelector('.tab.is-active .tab-close, .tab-close')
  closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await win.waitForTimeout(600)
await openOrders()
const restoredWidth = await colWidth('customer')
console.log(`  重新打开后 customer 列宽 = ${restoredWidth}px（期望 ≈ ${widthAfter}）`)
check('重新打开后列宽被恢复', Math.abs(restoredWidth - widthAfter) < 8, `${restoredWidth} vs ${widthAfter}`)
const sortArrow = await win.evaluate(() => {
  const cell = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-col-header')].find((c) =>
    c.textContent?.includes('amount')
  )
  return cell?.querySelector('.grid-sort-arrow')?.textContent ?? cell?.textContent ?? ''
})
console.log(`  amount 列头内容 = ${JSON.stringify(sortArrow)}`)
check('重新打开后排序箭头被恢复（▲）', sortArrow.includes('▲'), sortArrow)
await win.screenshot({ path: join(shotDir, 'L02-重新打开已恢复.png') })

// ---------------------------------------------------------------------------
console.log('\n[5] 列名失效容错：手改存储塞一个不存在的列 → 不得报错')
await win.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('dbstudio.') && x.includes('orders'))
  if (k) {
    localStorage.setItem(
      k,
      JSON.stringify({
        sort: { columnName: 'a_column_that_was_removed', direction: 'desc' },
        columnWidths: { customer: 380, gone_column: 200 }
      })
    )
  }
})
await win.evaluate(() => {
  const closeBtn = document.querySelector('.tab.is-active .tab-close, .tab-close')
  closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await win.waitForTimeout(600)
await openOrders()
const afterStale = await win.evaluate(() => ({
  headerCells: [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-col-header')].length,
  body: document.body.textContent?.includes('错误') ?? false
}))
console.log(`  打开后列数 = ${afterStale.headerCells}`)
check('列名失效时表仍能正常打开', afterStale.headerCells > 0, afterStale)
const staleWidth = await colWidth('customer')
console.log(`  customer 列宽 = ${staleWidth}px（存储里是 380，应被保留）`)
check('有效列宽仍生效', Math.abs(staleWidth - 380) < 8, staleWidth)
const staleArrow = await win.evaluate(() => {
  const cell = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-col-header')].find((c) =>
    c.textContent?.includes('amount')
  )
  return cell?.textContent ?? ''
})
console.log(`  amount 列头 = ${JSON.stringify(staleArrow)}`)
check('失效的排序列被忽略（无排序箭头）', !staleArrow.includes('▲') && !staleArrow.includes('▼'), staleArrow)
await win.screenshot({ path: join(shotDir, 'L03-列名失效容错.png') })

// ---------------------------------------------------------------------------
console.log('\n[6] 重置布局 → 存储被清空、布局回默认')
await win.evaluate(() => {
  const btn = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-toolbar button')].find(
    (b) => b.textContent?.trim() === '重置布局'
  )
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await win.waitForTimeout(800)
const storageAfterReset = await readStorage()
console.log(`  重置后 localStorage = ${JSON.stringify(storageAfterReset)}`)
check('重置后该表的布局 key 被清除', Object.keys(storageAfterReset).length === 0, storageAfterReset)
const widthAfterReset = await colWidth('customer')
console.log(`  重置后 customer 列宽 = ${widthAfterReset}px`)
check('重置后列宽回到默认（160px）', Math.abs(widthAfterReset - 160) < 8, widthAfterReset)
await win.screenshot({ path: join(shotDir, 'L04-重置布局.png') })

// ---------------------------------------------------------------------------
console.log('\n[7] 取消查询按钮：SQLite 下应禁用并说明原因')
const cancelBtn = await win.evaluate(() => {
  const btn = [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-toolbar button')].find(
    (b) => b.textContent?.trim() === '取消查询'
  )
  return btn ? { disabled: btn.disabled, title: btn.title } : null
})
console.log(`  取消按钮 = ${JSON.stringify(cancelBtn)}`)
check('存在「取消查询」按钮', cancelBtn !== null)
check('SQLite 下取消按钮被禁用', cancelBtn?.disabled === true, cancelBtn)
check(
  '禁用原因说明提到 SQLite 同步驱动',
  typeof cancelBtn?.title === 'string' &&
    (cancelBtn.title.includes('SQLite') || cancelBtn.title.includes('不支持')),
  cancelBtn?.title ?? ''
)

// ---------------------------------------------------------------------------
console.log('\n[8] 控制台无错误')
const consoleErrors = await win.evaluate(() => {
  return (globalThis.__dbstudioConsoleErrors ?? []).length
})
check('渲染进程无未捕获错误', consoleErrors === 0, `errors=${consoleErrors}`)

await app.close()

console.log(`\n===== 布局持久化 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exit(1)
