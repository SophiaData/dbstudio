/**
 * SQL 编辑器 GUI 回归测试。
 *
 * 为什么必须补这一套：编辑器的高亮/多语句/执行计划之前只有纯函数自检，
 * 没有真实点击验证，结果「多语句执行」实际是坏的（整段发给单语句接口），
 * 纯函数测试完全测不出来 —— 是本轮人工看截图才发现的。
 */
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pw = await import(pathToFileURL(require.resolve('playwright-core', { paths: [root] })).href)
const electron = pw._electron ?? pw.default?._electron

let pass = 0, fail = 0
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`) } }

const dir = mkdtempSync(join(tmpdir(), 'sql-ed-'))
const db = join(dir, 't.db')
{ const d = new DatabaseSync(db); d.exec("CREATE TABLE u(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO u VALUES(1,'a'),(2,'b'),(3,'c')"); d.close() }

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
env.DBSTUDIO_TEST_HIDDEN = '1'
const app = await electron.launch({ executablePath: require('electron'), args: ['.', `--user-data-dir=${join(dir, 'ud')}`], cwd: root, env })
const win = await app.firstWindow()
win.on('dialog', d => void d.accept())
await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })

await win.click('#btn-new-connection')
await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
await win.fill('#f-name', 'T'); await win.fill('#f-dynamic input[data-key="file"]', db)
await win.click('#btn-submit')
await win.waitForFunction(() => { const d = document.getElementById('dlg-connection'); return d && !d.hasAttribute('open') }, { timeout: 20000 })
await win.waitForTimeout(800)

console.log('\n[1] 编辑器结构')
check('存在编辑器高亮层', await win.evaluate(() => !!document.querySelector('.sql-editor-highlight')))
check('存在编辑器 textarea', await win.evaluate(() => !!document.querySelector('.sql-editor-input')))
check('存在工具栏按钮', await win.evaluate(() => document.querySelectorAll('.sql-editor-btn').length >= 3))

console.log('\n[2] 语法高亮真的产生着色 span')
await win.click('.sql-editor-input')
await win.fill('.sql-editor-input', 'SELECT name FROM u WHERE id > 1')
await win.waitForTimeout(400)
const hl = await win.evaluate(() => ({
  kw: document.querySelectorAll('.sql-keyword').length,
  num: document.querySelectorAll('.sql-number').length,
  str: document.querySelectorAll('.sql-string').length
}))
check('关键字有着色 span', hl.kw >= 3, JSON.stringify(hl))
check('数字有着色 span', hl.num >= 1, JSON.stringify(hl))

// 高亮色必须真的生效（不是只加了 class 没 CSS）
const kwColor = await win.evaluate(() => {
  const el = document.querySelector('.sql-keyword')
  return el ? getComputedStyle(el).color : ''
})
check('关键字颜色不是默认黑（CSS 规则生效）', kwColor !== '' && kwColor !== 'rgb(0, 0, 0)', kwColor)

// 高亮层与 textarea 垂直位置一致（视觉对齐的关键）
const align = await win.evaluate(() => {
  const p = document.querySelector('.sql-editor-highlight').getBoundingClientRect()
  const t = document.querySelector('.sql-editor-input').getBoundingClientRect()
  return { dt: Math.abs(p.top - t.top), dl: Math.abs(p.left - t.left), dw: Math.abs(p.width - t.width) }
})
check('高亮层与输入框位置一致', align.dt < 2 && align.dl < 2 && align.dw < 2, JSON.stringify(align))

// 编辑器会随内容长高（必须用多行 SQL 才看得出——单行本来就该 84px）
await win.click('.sql-editor-input')
await win.fill('.sql-editor-input', 'SELECT a\nFROM u\nWHERE x = 1\nAND y = 2\nORDER BY a')
await win.waitForTimeout(600)
const grew = await win.evaluate(() => document.querySelector('.sql-editor-input').getBoundingClientRect().height)
check('多行内容时编辑器长高（自适应生效）', grew > 84, `${Math.round(grew)}px`)

console.log('\n[3] ★ 多语句执行（本轮修的 bug）')
await win.click('.sql-editor-input')
await win.fill('.sql-editor-input', 'SELECT * FROM u;\nSELECT COUNT(*) AS n FROM u;')
await win.waitForTimeout(300)
await win.keyboard.press('Control+Shift+Enter')
await win.waitForTimeout(2500)
const tabs = await win.evaluate(() => [...document.querySelectorAll('.tab-chip-label')].map(c => c.textContent ?? ''))
check('★ 多语句打开了 2 个标签', tabs.length === 2, JSON.stringify(tabs))
const status = await win.$eval('#status-bar', e => e.textContent ?? '')
check('状态栏显示已执行 2 条', /2 条语句/.test(status), status)

// 第二条 TRUE 结果是 3（u 表 3 行）
const secondValue = await win.evaluate(() => {
  const panes = [...document.querySelectorAll('.tab-pane')]
  const active = panes.find(p => !p.hidden)
  const cells = active?.querySelectorAll('.grid-row .grid-cell')
  return cells ? [...cells].map(c => c.textContent) : []
})
check('第二条语句返回 3（COUNT 正确）', JSON.stringify(secondValue).includes('3'), JSON.stringify(secondValue))

console.log('\n[4] 多语句中字符串里的分号不误切')
await win.click('.sql-editor-input')
await win.fill('.sql-editor-input', "SELECT 'a;b' AS s;")
await win.waitForTimeout(300)
await win.keyboard.press('Control+Shift+Enter')
await win.waitForTimeout(1800)
const strVal = await win.evaluate(() => {
  const panes = [...document.querySelectorAll('.tab-pane')]
  const active = panes.find(p => !p.hidden)
  return [...(active?.querySelectorAll('.grid-row .grid-cell') ?? [])].map(c => c.textContent)
})
check('含分号的字符串作为单条执行且结果为 a;b', JSON.stringify(strVal).includes('a;b'), JSON.stringify(strVal))

console.log('\n[5] 执行计划')
await win.click('.sql-editor-input')
await win.fill('.sql-editor-input', 'SELECT * FROM u WHERE id = 1')
await win.waitForTimeout(300)
await win.evaluate(() => [...document.querySelectorAll('.sql-editor-btn')].find(b => b.textContent?.includes('执行计划'))?.click())
await win.waitForTimeout(2000)
const explain = await win.evaluate(() => {
  const rows = [...document.querySelectorAll('.sql-editor-explain-row')].map(e => e.textContent ?? '')
  return { count: rows.length, text: rows.join(' | ') }
})
check('执行计划有输出行', explain.count > 0, JSON.stringify(explain))
check('执行计划内容含搜索/扫描信息', /SEARCH|SCAN/i.test(explain.text), explain.text.slice(0, 80))

console.log('\n[6] 格式化')
await win.click('.sql-editor-input')
await win.fill('.sql-editor-input', 'select id,name from u where id>1 order by name')
await win.waitForTimeout(300)
await win.evaluate(() => [...document.querySelectorAll('.sql-editor-btn')].find(b => b.textContent?.includes('格式化'))?.click())
await win.waitForTimeout(600)
const formatted = await win.$eval('.sql-editor-input', e => e.value)
check('格式化后关键字大写', /SELECT/.test(formatted) && /FROM/.test(formatted), formatted.slice(0, 60))
// 比较必须忽略大小写：格式化会把关键字大写（预期行为），
// 只校验"字符序列没增删"——用大小写归一化后再比。
const norm = (x) => x.replace(/\s/g, '').toUpperCase()
check('格式化后内容未改变（去空白+大小写归一后一致）',
  norm(formatted) === norm('select id,name from u where id>1 order by name'),
  JSON.stringify(formatted))

await app.close()
console.log(`\n===== SQL 编辑器 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
