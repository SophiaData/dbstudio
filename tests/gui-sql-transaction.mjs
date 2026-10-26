/**
 * SQL 工作台与连接级事务联动 GUI 测试
 *
 * 验证：
 * 1. 打开表标签（Tab A）展示现有数据；
 * 2. 在 SQL 编辑器中执行 INSERT DML 语句；
 * 3. Tab A 自动联动刷新，出现新插入的行；
 * 4. Tab A 工具栏显示未提交事务，且「提交」与「回滚」按钮可用；
 * 5. 点击「回滚」后，Tab A 自动刷新，新插入的行消失；
 * 6. 磁盘 SQLite 数据库验证未发生持久写入。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync } from 'node:fs'
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

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-sql-tx-'))
const dbPath = join(workDir, 'sql_tx.db')
{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO items (id, name) VALUES (1, 'init');
  `)
  db.close()
}

const userDataDir = join(workDir, 'userdata')
mkdirSync(userDataDir, { recursive: true })

const electronBin = require('electron')
const extraArgs =
  process.env['ELECTRON_DISABLE_SANDBOX'] === '1' && process.platform === 'linux'
    ? ['--no-sandbox']
    : []

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.DBSTUDIO_TEST_HIDDEN = '1'

const app = await electron.launch({
  executablePath: electronBin,
  args: ['.', `--user-data-dir=${userDataDir}`, ...extraArgs],
  cwd: root,
  env
})
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())
await win.waitForLoadState('domcontentloaded')
await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })

const tabCount = () =>
  win.evaluate(() => document.querySelectorAll('#result-tabs-scroll .tab-chip').length)

/** 切到第 n 个标签（0 起）。 */
async function switchToTab(index) {
  await win.evaluate((i) => {
    const chip = document.querySelectorAll('#result-tabs-scroll .tab-chip')[i]
    chip?.querySelector('.tab-chip-label')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, index)
  await win.waitForTimeout(500)
}

/** 当前可见标签的工具条按钮状态与行内容。 */
const toolbarState = () =>
  win.evaluate(() => {
    const root = document.querySelector('.tab-pane:not([hidden]) .tab-grid-root')
    const find = (label) =>
      [...(root?.querySelectorAll('.grid-toolbar button') ?? [])].find(
        (b) => b.textContent?.trim() === label
      )
    const commit = find('提交')
    const rollback = find('回滚')
    const apply = find('应用修改')
    const info = root?.querySelector('.grid-toolbar .grid-tx-info')
    const rows = [...(root?.querySelectorAll('.grid-row') ?? [])].map((r) =>
      [...r.querySelectorAll('.grid-cell')].map((c) => c.textContent).join('|')
    )
    return {
      commitEnabled: commit ? !commit.disabled : null,
      rollbackEnabled: rollback ? !rollback.disabled : null,
      applyEnabled: apply ? !apply.disabled : null,
      txInfo: info?.textContent ?? '',
      rows
    }
  })

function readDiskDb() {
  const db = new DatabaseSync(dbPath)
  const rows = db.prepare('SELECT id, name FROM items ORDER BY id').all()
  db.close()
  return rows
}

try {
  console.log('\n[1] 建立连接并打开 items 表')
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', 'SQL事务库')
  await win.fill('#f-dynamic input[data-key="file"]', dbPath)
  await win.click('#btn-submit')
  await win.waitForFunction(
    () => {
      const d = document.getElementById('dlg-connection')
      return d !== null && !d.hasAttribute('open')
    },
    { timeout: 20000 }
  )
  await win.waitForTimeout(600)

  // 展开树并点击 items 表
  await win.evaluate((name) => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const conn = rows.find((r) => r.textContent?.includes(name))
    const twisty = conn?.querySelector('.twisty')
    if (twisty && twisty.textContent?.trim() === '▸') twisty.click()
  }, 'SQL事务库')
  await win.waitForTimeout(800)
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const folder = rows.find((r) => r.textContent?.includes('表'))
    const twisty = folder?.querySelector('.twisty')
    if (twisty && twisty.textContent?.trim() === '▸') twisty.click()
  })
  await win.waitForTimeout(800)
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const target = rows.find(
      (r) =>
        r.querySelector('.row-label')?.textContent?.trim() === 'items' ||
        r.textContent?.trim() === 'items'
    )
    if (target) target.click()
  })
  await win.waitForFunction(
    () => document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-row').length > 0,
    { timeout: 15000 }
  )
  await win.waitForTimeout(500)

  const initial = await toolbarState()
  check('初始状态有 1 行数据', initial.rows.length === 1 && initial.rows[0].includes('init'))
  check('初始未处于事务状态（提交与回滚不可用）', initial.commitEnabled === false && initial.rollbackEnabled === false)

  console.log('\n[2] 在 SQL 编辑器执行 INSERT 语句')
  await win.click('.sql-editor-input')
  await win.fill('.sql-editor-input', "INSERT INTO items VALUES (100, 'sql-tx-item');")
  await win.waitForTimeout(300)
  await win.keyboard.press('Control+Shift+Enter')
  await win.waitForTimeout(2000)

  console.log('\n[3] 检查 Tab A 是否自动联动刷新')
  await switchToTab(0)
  const afterInsert = await toolbarState()
  check('Tab A 自动刷新并展示新行 (100|sql-tx-item)', afterInsert.rows.some((r) => r.includes('sql-tx-item')), JSON.stringify(afterInsert.rows))
  check('Tab A 显示事务激活，提交与回滚按钮可用', afterInsert.commitEnabled === true && afterInsert.rollbackEnabled === true, JSON.stringify(afterInsert))

  console.log('\n[4] 点击回滚并验证数据撤销')
  await win.evaluate(() => {
    const root = document.querySelector('.tab-pane:not([hidden]) .tab-grid-root')
    const rollback = [...(root?.querySelectorAll('.grid-toolbar button') ?? [])].find(
      (b) => b.textContent?.trim() === '回滚'
    )
    rollback?.click()
  })
  // 等待事务对话框并确认回滚
  await win.waitForSelector('#dbstudio-transaction-dialog', { state: 'attached', timeout: 5000 })
  await win.evaluate(() => {
    const dialog = document.getElementById('dbstudio-transaction-dialog')
    const btn = dialog?.querySelector('button[data-transaction-action="discard-rollback"]')
    btn?.click()
  })
  await win.waitForTimeout(1500)

  const afterRollback = await toolbarState()
  check('回滚后新行消失，只剩初始行', afterRollback.rows.length === 1 && !afterRollback.rows.some((r) => r.includes('sql-tx-item')), JSON.stringify(afterRollback.rows))
  check('回滚后事务已清理，提交与回滚恢复禁用', afterRollback.commitEnabled === false && afterRollback.rollbackEnabled === false)

  console.log('\n[5] 磁盘持久化检查')
  const diskRows = readDiskDb()
  check('磁盘数据从未被持久写入 100', diskRows.length === 1 && diskRows[0].id === 1 && diskRows[0].name === 'init', JSON.stringify(diskRows))

} finally {
  await app.close()
}

console.log(`\n===== SQL 事务联动 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
