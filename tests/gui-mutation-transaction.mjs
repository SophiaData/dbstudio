/**
 * INSERT / DELETE 的事务归属 GUI 测试。
 *
 * ===== 为什么 M0 的事务用例只覆盖 UPDATE 还不够 =====
 *
 * UPDATE 走 `applyEdits`，在渲染进程里有一层「本地未应用编辑」的缓冲：
 * 先攒在 `#dirty`，用户点「应用修改」才进事务。这条路径天然有明确的
 * 「本地 / 已应用」分界。
 *
 * INSERT / DELETE 不一样：它们直接调主进程的 `insertRow` / `deleteRows`，
 * **当场就进了连接事务**，中间没有本地缓冲。于是有两个问题：
 *   1. 同连接的其他标签不知道事务变了——它们仍显示旧的事务状态；
 *   2. 其他标签的网格不会刷新——用户看到的是过期的数据。
 *
 * `transaction-controller.ts` 里定义了 `notifyMutation` 正是为了解决这个，
 * 但它**从未被调用**——所以这两个问题都是真的。
 *
 * 本测试钉住：
 *   1. INSERT 后同连接的其他标签立刻看到事务状态变化；
 *   2. INSERT 后其他标签的网格数据同步刷新；
 *   3. DELETE 同理；
 *   4. 未提交时磁盘上的数据不变，提交后才变；
 *   5. 回滚后磁盘数据恢复原样。
 *   6. 不同连接的标签之间事务互不影响（隔离）。
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

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-mutation-tx-'))
const dbPath = join(workDir, 'mutation.db')
const otherDbPath = join(workDir, 'other.db')
{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO items (id, name) VALUES (1, 'keep'), (2, 'remove-me');
  `)
  db.close()
  const other = new DatabaseSync(otherDbPath)
  other.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO items (id, name) VALUES (1, 'other-conn');
  `)
  other.close()
}

const userDataDir = join(workDir, 'userdata')
mkdirSync(userDataDir, { recursive: true })
const shotDir = join(root, 'out/gui-mutation-transaction')
mkdirSync(shotDir, { recursive: true })

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

/** 当前可见标签的工具条按钮状态。 */
const toolbarState = () =>
  win.evaluate(() => {
    const root = document.querySelector('.tab-pane:not([hidden]) .tab-grid-root')
    const find = (label) =>
      [...(root?.querySelectorAll('.grid-toolbar button') ?? [])].find(
        (b) => b.textContent?.trim() === label
      )
    const commit = find('提交')
    const rollback = find('回滚')
    const info = root?.querySelector('.grid-toolbar .grid-tx-info')
    const rows = [...(root?.querySelectorAll('.grid-row') ?? [])].map((r) =>
      [...r.querySelectorAll('.grid-cell')].map((c) => c.textContent).join('|')
    )
    return {
      commitEnabled: commit ? !commit.disabled : null,
      rollbackEnabled: rollback ? !rollback.disabled : null,
      txInfo: info?.textContent ?? '',
      rows
    }
  })

/** 事务对话框是否存在。 */
const dialogState = () =>
  win.evaluate(() => {
    const dialog = document.getElementById('dbstudio-transaction-dialog')
    if (!dialog) return { present: false }
    return {
      present: true,
      open: dialog.hasAttribute('open'),
      message: dialog.querySelector('p')?.textContent ?? ''
    }
  })

async function clickDialogAction(action) {
  return win.evaluate((act) => {
    const dialog = document.getElementById('dbstudio-transaction-dialog')
    const btn = dialog?.querySelector(`button[data-transaction-action="${act}"]`)
    if (!btn) return false
    btn.click()
    return true
  }, action)
}

function readDb() {
  const db = new DatabaseSync(dbPath)
  const rows = db.prepare('SELECT id, name FROM items ORDER BY id').all()
  db.close()
  return rows
}

/** 打开 items 表（走树，逐级展开）。 */
async function openItemsTable(connectionName = '变更测试库') {
  await win.evaluate((name) => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const conn = rows.find((r) => r.textContent?.includes(name))
    const twisty = conn?.querySelector('.twisty')
    if (twisty && twisty.textContent?.trim() === '▸') twisty.click()
  }, connectionName)
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
    const target = rows.find((r) => r.textContent?.includes('items'))
    if (target) target.click()
  })
  await win.waitForFunction(
    () => document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-row').length > 0,
    { timeout: 15000 }
  )
  await win.waitForTimeout(500)
}

try {
  console.log('\n[1] 建连接并打开同一张表的两个标签')
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', '变更测试库')
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

  await openItemsTable()
  await openItemsTable()
  check('两个标签都已打开', (await tabCount()) === 2, String(await tabCount()))

  console.log('\n[2] INSERT 后同连接的另一个标签必须看到事务状态变化')
  await switchToTab(0)
  const before = await toolbarState()
  check('插入前「提交」不可用', before.commitEnabled === false, JSON.stringify(before))

  // 走真实的「新增行」模态表单。
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.includes('新增行')
    )
    b?.click()
  })
  await win.waitForSelector('.grid-modal', { state: 'attached', timeout: 5000 })
  check('新增行模态打开', true)

  await win.evaluate(() => {
    const input = document.querySelector('.grid-modal input[data-column="name"]')
    if (input) input.value = 'inserted-row'
  })
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.grid-modal-foot button')].find((x) =>
      x.textContent?.includes('插入')
    )
    b?.click()
  })
  await win.waitForTimeout(2000)

  const afterInsert = await toolbarState()
  check('★ 插入后当前标签「提交」可用', afterInsert.commitEnabled === true, JSON.stringify(afterInsert))

  // 磁盘上还没变（未提交）。
  const rowsAfterInsert = readDb()
  check(
    '★ 插入后未落盘（要提交才生效）',
    !rowsAfterInsert.some((r) => r.name === 'inserted-row'),
    JSON.stringify(rowsAfterInsert)
  )

  // 关键断言：另一个标签（同连接）也必须看到事务状态变化。
  await switchToTab(1)
  const otherTab = await toolbarState()
  check(
    '★ 另一个标签的「提交」也可用（同一连接的事务）',
    otherTab.commitEnabled === true,
    JSON.stringify(otherTab)
  )
  check(
    '★ 另一个标签的事务提示同步了',
    otherTab.txInfo.includes('未提交'),
    otherTab.txInfo
  )
  check(
    '★ 另一个标签的网格数据同步刷新了',
    otherTab.rows.some((r) => r.includes('inserted-row')),
    JSON.stringify(otherTab.rows)
  )
  await win.screenshot({ path: join(shotDir, '01-插入后另一标签.png') })

  console.log('\n[3] 回滚应撤销 INSERT')
  // 注意不能在这里提交：一旦提交，INSERT 就落盘了，后面的回滚自然撤销不了它。
  // 这里先验证「未提交的 INSERT 能被回滚撤销」，提交留到最后一步单独验。
  await switchToTab(0)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '回滚'
    )
    b?.click()
  })
  await win.waitForTimeout(800)
  const insertRollbackDialog = await dialogState()
  check('回滚前弹确认框', insertRollbackDialog.present && insertRollbackDialog.open)
  await clickDialogAction('discard-rollback')
  await win.waitForTimeout(1500)

  const rowsAfterInsertRollback = readDb()
  check(
    '★ 回滚后 INSERT 的行消失了',
    !rowsAfterInsertRollback.some((r) => r.name === 'inserted-row'),
    JSON.stringify(rowsAfterInsertRollback)
  )
  check(
    '★ 回滚后原有数据完好',
    rowsAfterInsertRollback.length === 2,
    JSON.stringify(rowsAfterInsertRollback)
  )

  console.log('\n[4] 再插入一次并提交，验证落盘')
  await switchToTab(0)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.includes('新增行')
    )
    b?.click()
  })
  await win.waitForSelector('.grid-modal', { state: 'attached', timeout: 5000 })
  await win.evaluate(() => {
    const input = document.querySelector('.grid-modal input[data-column="name"]')
    if (input) input.value = 'inserted-row'
  })
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.grid-modal-foot button')].find((x) =>
      x.textContent?.includes('插入')
    )
    b?.click()
  })
  await win.waitForTimeout(2000)

  await switchToTab(0)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '提交'
    )
    b?.click()
  })
  await win.waitForTimeout(1800)

  const rowsAfterCommit = readDb()
  check(
    '★ 提交后新行已落盘',
    rowsAfterCommit.some((r) => r.name === 'inserted-row'),
    JSON.stringify(rowsAfterCommit)
  )

  console.log('\n[5] DELETE 后同连接的另一个标签必须看到变化')
  await switchToTab(0)
  // 选中 name = 'remove-me' 那一行。
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const target = rows.find((r) => r.textContent?.includes('remove-me'))
    const cell = target?.querySelectorAll('.grid-cell')[2]
    cell?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(400)

  // 原生 confirm 要自动接受。
  win.once('dialog', (d) => void d.accept())
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.includes('删除选中行')
    )
    b?.click()
  })
  await win.waitForTimeout(2000)

  const afterDelete = await toolbarState()
  check('★ 删除后「提交」可用', afterDelete.commitEnabled === true, JSON.stringify(afterDelete))

  const rowsAfterDelete = readDb()
  check(
    '★ 删除后未落盘',
    rowsAfterDelete.some((r) => r.name === 'remove-me'),
    JSON.stringify(rowsAfterDelete)
  )

  await switchToTab(1)
  const otherTabAfterDelete = await toolbarState()
  check(
    '★ 另一个标签的「提交」也可用',
    otherTabAfterDelete.commitEnabled === true,
    JSON.stringify(otherTabAfterDelete)
  )
  check(
    '★ 另一个标签的网格同步看到删除',
    !otherTabAfterDelete.rows.some((r) => r.includes('remove-me')),
    JSON.stringify(otherTabAfterDelete.rows)
  )
  await win.screenshot({ path: join(shotDir, '02-删除后另一标签.png') })

  console.log('\n[6] 回滚后删除被撤销')
  await switchToTab(0)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '回滚'
    )
    b?.click()
  })
  await win.waitForTimeout(800)
  const rollbackDialog = await dialogState()
  check('回滚前弹确认框', rollbackDialog.present && rollbackDialog.open, JSON.stringify(rollbackDialog))
  await clickDialogAction('discard-rollback')
  await win.waitForTimeout(1500)

  const rowsAfterRollback = readDb()
  check(
    '★ 回滚后「remove-me」恢复',
    rowsAfterRollback.some((r) => r.name === 'remove-me'),
    JSON.stringify(rowsAfterRollback)
  )
  check(
    '★ 回滚不影响已提交的 INSERT（它早就落盘了）',
    rowsAfterRollback.some((r) => r.name === 'inserted-row'),
    JSON.stringify(rowsAfterRollback)
  )
  await win.screenshot({ path: join(shotDir, '03-已回滚.png') })

  console.log('\n[7] 不同连接的标签之间事务互不影响')
  // 第二个连接指向另一个库。它开一个标签后，A 连接的事务状态不该影响它。
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', '隔离测试库')
  await win.fill('#f-dynamic input[data-key="file"]', otherDbPath)
  await win.click('#btn-submit')
  await win.waitForFunction(
    () => {
      const d = document.getElementById('dlg-connection')
      return d !== null && !d.hasAttribute('open')
    },
    { timeout: 20000 }
  )
  await win.waitForTimeout(800)

  await openItemsTable('隔离测试库')
  const otherConnTab = await toolbarState()
  check(
    '★ 新连接的标签看不到另一个连接的事务',
    otherConnTab.commitEnabled === false,
    JSON.stringify(otherConnTab)
  )
  check(
    '★ 新连接显示的是自己的数据',
    otherConnTab.rows.some((r) => r.includes('other-conn')),
    JSON.stringify(otherConnTab.rows)
  )

  // 在新连接上插入一行，然后确认旧连接的标签不受影响。
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.includes('新增行')
    )
    b?.click()
  })
  await win.waitForSelector('.grid-modal', { state: 'attached', timeout: 5000 })
  await win.evaluate(() => {
    const input = document.querySelector('.grid-modal input[data-column="name"]')
    if (input) input.value = 'isolated-row'
  })
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.grid-modal-foot button')].find((x) =>
      x.textContent?.includes('插入')
    )
    b?.click()
  })
  await win.waitForTimeout(2000)

  const isolatedTab = await toolbarState()
  check('★ 新连接自己的事务生效了', isolatedTab.commitEnabled === true, JSON.stringify(isolatedTab))

  // 切回旧连接的标签：它不应该因为新连接的事务而出现「提交」可用。
  await switchToTab(0)
  const oldConnTab = await toolbarState()
  check(
    '★ 旧连接的标签不受另一个连接的事务影响',
    oldConnTab.commitEnabled === false,
    JSON.stringify(oldConnTab)
  )

  const otherDb = new DatabaseSync(otherDbPath)
  const otherRows = otherDb.prepare('SELECT name FROM items ORDER BY id').all()
  otherDb.close()
  check(
    '★ 新连接的插入未落盘（未提交）',
    !otherRows.some((r) => r.name === 'isolated-row'),
    JSON.stringify(otherRows)
  )
  await win.screenshot({ path: join(shotDir, '04-连接隔离.png') })

  // 收拾：把新连接的事务回滚掉，否则关闭应用时会被退出守卫拦住。
  await switchToTab(2)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '回滚'
    )
    b?.click()
  })
  await win.waitForTimeout(800)
  await clickDialogAction('discard-rollback')
  await win.waitForTimeout(1000)
} finally {
  try {
    await clickDialogAction('discard-rollback')
    await clickDialogAction('cancel')
  } catch {
    /* 页面可能已经关了 */
  }
  await app.close().catch(() => {})
}

console.log(`\n===== 增删改事务归属 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exit(1)

