/**
 * SQL 历史与收藏的真实 Electron GUI 测试。
 *
 * 只测存储层会漏掉最容易出错的接线：执行后是否真的记录、载入是否偷偷执行、
 * 历史与收藏切换、清空历史是否误删收藏、重启后是否真的还在。
 */
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pw = await import(
  pathToFileURL(require.resolve('playwright-core', { paths: [root] })).href
)
const electron = pw._electron ?? pw.default?._electron

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'sql-library-gui-'))
const db = join(dir, 'library.db')
{
  const database = new DatabaseSync(db)
  database.exec(
    "CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT); " +
      "INSERT INTO notes VALUES(1, 'alpha'), (2, 'beta');"
  )
  database.close()
}

const userDataDir = join(dir, 'ud')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

async function launch() {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: root,
    env
  })
  const win = await app.firstWindow()
  win.on('dialog', (dialog) => void dialog.accept())
  await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })
  return { app, win }
}

let { app, win } = await launch()

console.log('\n[1] 新建连接并执行一条成功 SQL')
await win.click('#btn-new-connection')
await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
await win.fill('#f-name', 'LIB')
await win.fill('#f-dynamic input[data-key="file"]', db)
await win.click('#btn-submit')
await win.waitForFunction(
  () => {
    const dialog = document.getElementById('dlg-connection')
    return dialog !== null && !dialog.hasAttribute('open')
  },
  { timeout: 20000 }
)
await win.waitForTimeout(500)
await win.fill('.sql-editor-input', 'SELECT * FROM notes ORDER BY id')
await win.keyboard.press('Control+Enter')
await win.waitForFunction(
  () => document.querySelectorAll('.tab-pane:not([hidden]) .grid-row').length > 0,
  { timeout: 15000 }
)

console.log('\n[2] 执行历史面板')
await win.evaluate(() => {
  const button = [...document.querySelectorAll('.sql-editor-btn')].find((item) =>
    item.textContent?.includes('历史 / 收藏')
  )
  button?.click()
})
await win.waitForSelector('#dlg-sql-library[open]', { timeout: 5000 })
await win.waitForFunction(
  () =>
    document.querySelectorAll('#sql-library-list .sql-library-item').length === 1,
  { timeout: 5000 }
)
const history = await win.evaluate(() => {
  const item = document.querySelector('#sql-library-list .sql-library-item')
  return {
    sql: item?.querySelector('.sql-library-sql')?.textContent ?? '',
    badge: item?.querySelector('.sql-library-badge')?.textContent ?? '',
    meta: item?.querySelector('.sql-library-meta')?.textContent ?? ''
  }
})
check('2a. 成功执行的 SQL 进入历史', history.sql.includes('SELECT * FROM notes'), history.sql)
check('2b. 成功状态可见', history.badge === '成功', history.badge)
check('2c. 记录连接快照与耗时', history.meta.includes('LIB') && /ms/.test(history.meta), history.meta)

console.log('\n[3] 失败 SQL 也记录，且保留错误原因')
await win.click('#btn-sql-library-close')
await win.fill('.sql-editor-input', 'SELECT missing_column FROM notes')
await win.keyboard.press('Control+Enter')
await win.waitForTimeout(1200)
await win.evaluate(() => {
  const button = [...document.querySelectorAll('.sql-editor-btn')].find((item) =>
    item.textContent?.includes('历史 / 收藏')
  )
  button?.click()
})
await win.waitForFunction(
  () =>
    document.querySelectorAll('#sql-library-list .sql-library-item').length === 2,
  { timeout: 5000 }
)
const failed = await win.evaluate(() => {
  const item = document.querySelector('#sql-library-list .sql-library-item')
  return {
    badge: item?.querySelector('.sql-library-badge')?.textContent ?? '',
    error: item?.querySelector('.sql-library-detail')?.textContent ?? ''
  }
})
check('3a. 失败查询进入历史', failed.badge === '失败', failed.badge)
check('3b. 失败原因被保留', /missing_column/i.test(failed.error), failed.error)

console.log('\n[4] 载入只填编辑器，不自动执行')
const tabsBeforeLoad = await win.evaluate(
  () => document.querySelectorAll('.tab-chip').length
)
await win.evaluate(() => {
  const item = [...document.querySelectorAll('#sql-library-list .sql-library-item')].find((node) =>
    node.querySelector('.sql-library-sql')?.textContent?.includes('SELECT * FROM notes')
  )
  const button = [...(item?.querySelectorAll('.sql-library-actions button') ?? [])].find(
    (node) => node.textContent === '载入'
  )
  button?.click()
})
await win.waitForTimeout(500)
const loaded = await win.evaluate(() => ({
  sql: document.querySelector('.sql-editor-input')?.value ?? '',
  tabs: document.querySelectorAll('.tab-chip').length,
  open: document.getElementById('dlg-sql-library')?.hasAttribute('open')
}))
check('4a. 历史 SQL 被填入编辑器', loaded.sql === 'SELECT * FROM notes ORDER BY id', loaded.sql)
check('4b. ★ 载入不会自动执行（标签数不变）', loaded.tabs === tabsBeforeLoad, String(loaded.tabs))
check('4c. 载入后关闭面板', loaded.open === false)

console.log('\n[5] 保存收藏与重命名')
await win.evaluate(() => {
  const button = [...document.querySelectorAll('.sql-editor-btn')].find((item) =>
    item.textContent?.includes('保存收藏')
  )
  button?.click()
})
await win.waitForSelector('#dlg-save-sql[open]', { timeout: 5000 })
await win.fill('#f-save-sql-name', '全部笔记')
await win.click('#btn-save-sql-submit')
await win.waitForFunction(
  () => {
    const dialog = document.getElementById('dlg-save-sql')
    return dialog !== null && !dialog.hasAttribute('open')
  },
  { timeout: 5000 }
)
await win.evaluate(() => {
  const button = [...document.querySelectorAll('.sql-editor-btn')].find((item) =>
    item.textContent?.includes('历史 / 收藏')
  )
  button?.click()
})
await win.waitForSelector('#dlg-sql-library[open]', { timeout: 5000 })
await win.click('#tab-sql-saved')
await win.waitForFunction(
  () => document.querySelectorAll('#sql-library-list .sql-library-item').length === 1,
  { timeout: 5000 }
)
const saved = await win.evaluate(() => ({
  title: document.querySelector('#sql-library-list .sql-library-item-head strong')?.textContent,
  badge: document.querySelector('#sql-library-list .sql-library-badge')?.textContent
}))
check('5a. 收藏出现在独立标签', saved.title === '全部笔记', saved.title)
check('5b. 收藏有独立状态标识', saved.badge === '收藏', saved.badge)

await win.evaluate(() => {
  const button = [...document.querySelectorAll('#sql-library-list .sql-library-actions button')].find(
    (node) => node.textContent === '重命名'
  )
  button?.click()
})
await win.waitForSelector('#dlg-save-sql[open]', { timeout: 5000 })
await win.fill('#f-save-sql-name', '笔记全量')
await win.click('#btn-save-sql-submit')
await win.waitForFunction(
  () =>
    document.querySelector('#sql-library-list .sql-library-item-head strong')?.textContent ===
    '笔记全量',
  { timeout: 5000 }
)
check('5c. 收藏可重命名', true)

console.log('\n[6] 清空历史不影响收藏')
await win.click('#tab-sql-history')
await win.waitForFunction(
  () => document.querySelectorAll('#sql-library-list .sql-library-item').length === 2,
  { timeout: 5000 }
)
await win.click('#btn-clear-sql-history')
await win.waitForFunction(
  () => document.getElementById('sql-library-empty')?.hidden === false,
  { timeout: 5000 }
)
check('6a. 历史被清空', true)
await win.click('#tab-sql-saved')
await win.waitForFunction(
  () => document.querySelectorAll('#sql-library-list .sql-library-item').length === 1,
  { timeout: 5000 }
)
const savedAfterClear = await win.evaluate(
  () => document.querySelector('#sql-library-list .sql-library-item-head strong')?.textContent
)
check('6b. ★ 清空历史没有误删收藏', savedAfterClear === '笔记全量', String(savedAfterClear))

console.log('\n[7] 重启后收藏仍在')
await app.close()
;({ app, win } = await launch())
await win.evaluate(() => {
  const button = [...document.querySelectorAll('.sql-editor-btn')].find((item) =>
    item.textContent?.includes('历史 / 收藏')
  )
  button?.click()
})
await win.waitForSelector('#dlg-sql-library[open]', { timeout: 5000 })
await win.click('#tab-sql-saved')
await win.waitForFunction(
  () =>
    document.querySelector('#sql-library-list .sql-library-item-head strong')?.textContent ===
    '笔记全量',
  { timeout: 5000 }
)
check('7a. ★ 重启后收藏仍可读取', true)
await win.fill('#sql-library-search', 'select')
await win.waitForFunction(
  () => document.querySelectorAll('#sql-library-list .sql-library-item').length === 1,
  { timeout: 5000 }
)
await win.fill('#sql-library-search', '不存在')
await win.waitForFunction(
  () => document.getElementById('sql-library-empty')?.hidden === false,
  { timeout: 5000 }
)
check('7b. 收藏搜索可过滤', true)

await app.close()
console.log(`\n===== SQL 历史与收藏 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
