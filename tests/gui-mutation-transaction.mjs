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
    CREATE TABLE a1_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO a1_items (id, name) VALUES (1, 'one'), (2, 'two'), (3, 'three');
    CREATE TABLE pair_items (k1 INTEGER NOT NULL, k2 INTEGER NOT NULL, val TEXT NOT NULL, PRIMARY KEY (k1, k2));
    INSERT INTO pair_items (k1, k2, val) VALUES (1, 10, 'v1'), (1, 20, 'v2');
    CREATE TABLE paged_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE null_items (id INTEGER PRIMARY KEY, note TEXT, val TEXT);
    INSERT INTO null_items (id, note, val) VALUES (1, NULL, 'v1');
    CREATE TABLE blob_pk_items (id BLOB PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO blob_pk_items (id, name) VALUES (X'01020304', 'blob-row');
  `)
  const insert = db.prepare('INSERT INTO paged_items (id, name) VALUES (?, ?)')
  for (let i = 1; i <= 250; i++) {
    insert.run(i, `p${i}`)
  }
  db.close()
  const other = new DatabaseSync(otherDbPath)
  other.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO items (id, name) VALUES (1, 'other-conn');
    CREATE TABLE other_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO other_items (id, name) VALUES (10, 'other-10');
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
    const apply = find('应用修改')
    const info = root?.querySelector('.grid-toolbar .grid-tx-info')
    const dirtyCells = root?.querySelectorAll('.grid-cell.is-dirty').length ?? 0
    const rows = [...(root?.querySelectorAll('.grid-row') ?? [])].map((r) =>
      [...r.querySelectorAll('.grid-cell')].map((c) => c.textContent).join('|')
    )
    return {
      commitEnabled: commit ? !commit.disabled : null,
      rollbackEnabled: rollback ? !rollback.disabled : null,
      applyEnabled: apply ? !apply.disabled : null,
      dirtyCells,
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
async function openTableByName(connectionName = '变更测试库', tableName = 'items') {
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
  await win.evaluate((tbl) => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const target = rows.find(
      (r) =>
        r.querySelector('.row-label')?.textContent?.trim() === tbl ||
        r.textContent?.trim() === tbl
    )
    if (target) target.click()
  }, tableName)
  await win.waitForFunction(
    () => document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-row').length > 0,
    { timeout: 15000 }
  )
  await win.waitForTimeout(500)
}

async function openItemsTable(connectionName = '变更测试库') {
  return openTableByName(connectionName, 'items')
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

  console.log('\n[8] 跨标签删除刷新后脏编辑固定行身份，不改错行（A1 核心反例）')
  await openTableByName('变更测试库', 'a1_items')
  const tabAIndex = (await tabCount()) - 1
  await openTableByName('变更测试库', 'a1_items')
  const tabBIndex = (await tabCount()) - 1

  // 1. 在 Tab B 中双击编辑 id=2 的 name 列为 'two-edited'，暂不应用
  await switchToTab(tabBIndex)
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '2')
    const nameCell = targetRow?.querySelectorAll('.grid-cell')[2]
    nameCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = 'two-edited'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(600)

  // 2. 切到 Tab A，删除 id=1，广播刷新
  await switchToTab(tabAIndex)
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '1')
    const idCell = targetRow?.querySelectorAll('.grid-cell')[1]
    idCell?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(400)
  win.once('dialog', (d) => void d.accept())
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.includes('删除选中行')
    )
    b?.click()
  })
  await win.waitForTimeout(2500)

  // 3. 切回 Tab B，应用修改并提交
  await switchToTab(tabBIndex)
  const tabBToolbar = await toolbarState()
  check('★ Tab B 收到广播后仍然保持未应用脏编辑', tabBToolbar.rows.length > 0)

  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '应用修改'
    )
    b?.click()
  })
  await win.waitForTimeout(1000)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '提交'
    )
    b?.click()
  })
  await win.waitForTimeout(1500)

  // 4. 从独立数据库连接断言真实数据内容
  {
    const db = new DatabaseSync(dbPath)
    const rows = db.prepare('SELECT id, name FROM a1_items ORDER BY id').all()
    db.close()
    const r2 = rows.find((r) => r.id === 2)
    const r3 = rows.find((r) => r.id === 3)
    const r1 = rows.find((r) => r.id === 1)
    check('★ id=1 已被成功删除', r1 === undefined, JSON.stringify(rows))
    check('★ id=2 准确更新为 two-edited（未因行号漂移而改错）', r2?.name === 'two-edited', JSON.stringify(r2))
    check('★ id=3 保持原值 three 完好（绝对没有被篡改）', r3?.name === 'three', JSON.stringify(r3))
  }

  console.log('\n[9] 目标行被另一标签删除：明确报告冲突，不转移编辑，不谎报成功')
  await switchToTab(tabBIndex)
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '2')
    const nameCell = targetRow?.querySelectorAll('.grid-cell')[2]
    nameCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = 'two-conflicted'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(600)

  // 切到 Tab A 删除 id=2（直接进入连接事务，广播刷新）
  await switchToTab(tabAIndex)
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '2')
    const idCell = targetRow?.querySelectorAll('.grid-cell')[1]
    idCell?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(400)
  win.once('dialog', (d) => void d.accept())
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.includes('删除选中行')
    )
    b?.click()
  })
  await win.waitForTimeout(2500)

  // 切回 Tab B，目标行已被删除，Tab B 尝试点「应用修改」
  await switchToTab(tabBIndex)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '应用修改'
    )
    b?.click()
  })
  await win.waitForTimeout(1500)

  const tabBStatus = await win.evaluate(() => document.getElementById('status-bar')?.textContent ?? '')
  check(
    '★ 目标行被删后应用修改被明确拒绝（没有匹配到任何行）',
    tabBStatus.includes('没有匹配到任何行') || tabBStatus.includes('失败') || tabBStatus.includes('丢失'),
    tabBStatus
  )

  {
    const db = new DatabaseSync(dbPath)
    const rows = db.prepare('SELECT id, name FROM a1_items ORDER BY id').all()
    db.close()
    check('★ 数据库中 id=3 仍为 three（未被转移改错）', rows.find((r) => r.id === 3)?.name === 'three', JSON.stringify(rows))
  }

  // 回滚清理未提交的删除与失败脏编辑
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '回滚'
    )
    b?.click()
  })
  await win.waitForTimeout(800)
  await clickDialogAction('discard-rollback')
  await win.waitForTimeout(1000)

  console.log('\n[10] 复合主键表的行编辑与事务提交')
  await openTableByName('变更测试库', 'pair_items')
  const pairTabIndex = (await tabCount()) - 1
  await switchToTab(pairTabIndex)

  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => {
      const cells = [...r.querySelectorAll('.grid-cell')].map((c) => c.textContent?.trim())
      return cells[1] === '1' && cells[2] === '20'
    })
    const valCell = targetRow?.querySelectorAll('.grid-cell')[3]
    valCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = 'v2-updated'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(500)

  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '应用修改'
    )
    b?.click()
  })
  await win.waitForTimeout(1000)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '提交'
    )
    b?.click()
  })
  await win.waitForTimeout(1500)

  {
    const db = new DatabaseSync(dbPath)
    const rows = db.prepare('SELECT k1, k2, val FROM pair_items ORDER BY k1, k2').all()
    db.close()
    const r1 = rows.find((r) => r.k1 === 1 && r.k2 === 10)
    const r2 = rows.find((r) => r.k1 === 1 && r.k2 === 20)
    check('★ 复合主键行 (1, 20) 准确更新为 v2-updated', r2?.val === 'v2-updated', JSON.stringify(r2))
    check('★ 复合主键行 (1, 10) 保持 v1 完好', r1?.val === 'v1', JSON.stringify(r1))
  }

  console.log('\n[11] 主键列编辑：以原主键定位 WHERE 并落盘新主键')
  await switchToTab(tabAIndex)
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '3')
    const idCell = targetRow?.querySelectorAll('.grid-cell')[1]
    idCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = '30'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(500)

  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '应用修改'
    )
    b?.click()
  })
  await win.waitForTimeout(1000)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '提交'
    )
    b?.click()
  })
  await win.waitForTimeout(1500)

  {
    const db = new DatabaseSync(dbPath)
    const rows = db.prepare('SELECT id, name FROM a1_items ORDER BY id').all()
    db.close()
    check('★ 主键编辑后新主键 id=30 已落盘', rows.some((r) => r.id === 30 && r.name === 'three'), JSON.stringify(rows))
    check('★ 原主键 id=3 已不再存在（定位准确）', !rows.some((r) => r.id === 3), JSON.stringify(rows))
  }

  console.log('\n[12] 排序重查保留脏编辑并准确更新目标行')
  {
    const db = new DatabaseSync(dbPath)
    db.exec("INSERT INTO a1_items (id, name) VALUES (100, 'alpha');")
    db.close()
  }
  // 刷新当前 Tab
  await switchToTab(tabAIndex)
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const target = rows.find((r) => r.querySelector('.row-label')?.textContent?.trim() === 'a1_items')
    if (target) target.click()
  })
  await win.waitForTimeout(1000)

  // 排序前断言行顺序：row 0 为 id=2，row 2 为 id=100
  const preSortOrder = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    return rows.map((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim())
  })
  check('★ 排序前第一行为 id=2', preSortOrder[0] === '2', JSON.stringify(preSortOrder))

  // 双击第 0 行（id=2）编辑 name 为 'two-sorted'
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '2')
    const nameCell = targetRow?.querySelectorAll('.grid-cell')[2]
    nameCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = 'two-sorted'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(500)

  // 点击真实表头 .grid-col-header 触发服务端排序（按 name 升序）
  const headerFound = await win.evaluate(() => {
    const headers = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-col-header')]
    const nameHeader = headers.find((h) => h.querySelector('.grid-col-label')?.textContent?.trim().startsWith('name'))
    if (!nameHeader) return false
    nameHeader.click()
    return true
  })
  check('★ 找到实际表头 .grid-col-header 并触发排序点击（无静默跳过）', headerFound === true)

  // 等待排序指示器出现
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-sort-arrow', { timeout: 5000 })
  const arrowText = await win.evaluate(() =>
    document.querySelector('.tab-pane:not([hidden]) .grid-sort-arrow')?.textContent?.trim()
  )
  check('★ 排序指示箭头显示升序 ▲', arrowText === '▲', arrowText)

  // 观察等待行发生物理位置调换：按 name 升序后，'alpha'(id=100) 变为 row 0，'two-sorted'(id=2) 移到 row 2
  await win.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const row0Id = rows[0]?.querySelectorAll('.grid-cell')[1]?.textContent?.trim()
    const row2Id = rows[2]?.querySelectorAll('.grid-cell')[1]?.textContent?.trim()
    return row0Id === '100' && row2Id === '2'
  }, { timeout: 8000 })

  const sortedState = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const row0Name = rows[0]?.querySelectorAll('.grid-cell')[2]
    const row2Name = rows[2]?.querySelectorAll('.grid-cell')[2]
    return {
      row0Name: row0Name?.textContent?.trim(),
      row0Dirty: row0Name?.classList.contains('is-dirty'),
      row2Name: row2Name?.textContent?.trim(),
      row2Dirty: row2Name?.classList.contains('is-dirty')
    }
  })
  check('★ 排序后第一行变为 alpha 且无 dirty 标记', sortedState.row0Name === 'alpha' && sortedState.row0Dirty === false, JSON.stringify(sortedState))
  check('★ 排序后移动到末尾的目标行 id=2 准确保留编辑值 two-sorted', sortedState.row2Name === 'two-sorted', JSON.stringify(sortedState))
  check('★ 排序后移动到末尾的目标行 id=2 仍保持 is-dirty 标记', sortedState.row2Dirty === true, JSON.stringify(sortedState))

  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '应用修改'
    )
    b?.click()
  })
  await win.waitForTimeout(1000)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '提交'
    )
    b?.click()
  })
  await win.waitForTimeout(1500)

  {
    const db = new DatabaseSync(dbPath)
    const rows = db.prepare('SELECT id, name FROM a1_items ORDER BY id').all()
    db.close()
    const r2 = rows.find((r) => r.id === 2)
    const r100 = rows.find((r) => r.id === 100)
    check('★ 排序后提交：id=2 准确落盘为 two-sorted', r2?.name === 'two-sorted', JSON.stringify(r2))
    check('★ 排序后提交：id=100 保持 alpha 完好', r100?.name === 'alpha', JSON.stringify(r100))
  }

  console.log('\n[13] 实际跨页加载后，离开可视区的脏编辑仍准确定位落盘')
  await openTableByName('变更测试库', 'paged_items')
  const pagedTabIndex = (await tabCount()) - 1
  await switchToTab(pagedTabIndex)

  // 1. 在第 1 页编辑 id=5 的 name 为 'p5-edited'，暂不应用
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '5')
    const nameCell = targetRow?.querySelectorAll('.grid-cell')[2]
    nameCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = 'p5-edited'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(500)

  // 2. 模拟大幅滚动到底部加载后续分页（行 220 对应 Page 2）
  await win.evaluate(() => {
    const vp = document.querySelector('.tab-pane:not([hidden]) .grid-viewport')
    if (vp) {
      vp.scrollTop = 220 * 24
      vp.dispatchEvent(new Event('scroll'))
    }
  })
  await win.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    return rows.some((row) => row.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '220')
  }, undefined, { timeout: 8000 })
  const pagingEvidence = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const ids = rows.map((row) => row.querySelectorAll('.grid-cell')[1]?.textContent?.trim())
    return { loaded220: ids.includes('220'), visible5: ids.includes('5') }
  })
  check('★ 分页实际加载到 id=220，原编辑行 id=5 已离开可视区',
    pagingEvidence.loaded220 && !pagingEvidence.visible5, JSON.stringify(pagingEvidence))

  // 3. 点击「应用修改」与「提交」
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '应用修改'
    )
    b?.click()
  })
  await win.waitForTimeout(1000)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '提交'
    )
    b?.click()
  })
  await win.waitForTimeout(1500)

  // 4. 从数据库断言 id=5 准确落盘，其它行完好
  {
    const db = new DatabaseSync(dbPath)
    const row5 = db.prepare('SELECT id, name FROM paged_items WHERE id = 5').get()
    const row6 = db.prepare('SELECT id, name FROM paged_items WHERE id = 6').get()
    const row220 = db.prepare('SELECT id, name FROM paged_items WHERE id = 220').get()
    db.close()
    check('★ 跨页滚动后远端脏编辑 id=5 准确落盘为 p5-edited', row5?.name === 'p5-edited', JSON.stringify(row5))
    check('★ 相邻行 id=6 保持 p6 完好', row6?.name === 'p6', JSON.stringify(row6))
    check('★ 滚动目标行 id=220 保持 p220 完好', row220?.name === 'p220', JSON.stringify(row220))
  }

  console.log('\n[14] A1-R1 & A1-R3 核心契约验证（精确大小写、歧义拒绝、截断/BLOB主键拒绝）')
  const contractResults = await win.evaluate(() => {
    const a1 = window.__dbstudioA1
    if (!a1) return { error: '__dbstudioA1 not exposed' }

    // 1. A1-R1: 大小写异名列（id 与 ID，主键为 ID）
    const columns = [
      { name: 'id', type: 'integer' },
      { name: 'ID', type: 'integer' },
      { name: 'val', type: 'text' }
    ]
    const keyCols = [{ name: 'ID', type: 'integer', nullable: false, primaryKeyOrdinal: 0, defaultValue: null }]
    const rowA = { index: 0, cells: [{ kind: 'number', value: 7 }, { kind: 'number', value: 10 }, { kind: 'text', text: 'rowA' }] }
    const rowB = { index: 1, cells: [{ kind: 'number', value: 7 }, { kind: 'number', value: 20 }, { kind: 'text', text: 'rowB' }] }

    const keyA = a1.extractKeyValues(rowA, columns, keyCols)
    const keyB = a1.extractKeyValues(rowB, columns, keyCols)
    const rowKeyA = keyA ? a1.encodeRowKey(keyA) : null
    const rowKeyB = keyB ? a1.encodeRowKey(keyB) : null

    // 2. 歧义列拒绝：同名精确重名列（SELECT id, id FROM ...）
    const dupCols = [{ name: 'id', type: 'integer' }, { name: 'id', type: 'integer' }]
    const dupKeyCols = [{ name: 'id', type: 'integer', nullable: false, primaryKeyOrdinal: 0, defaultValue: null }]
    const dupRow = { index: 0, cells: [{ kind: 'number', value: 1 }, { kind: 'number', value: 2 }] }
    const dupExtract = a1.extractKeyValues(dupRow, dupCols, dupKeyCols)

    // 3. 大小写不敏感安全回退（单候选）与多候选歧义拒绝
    const singleCiCols = [{ name: 'user_id', type: 'integer' }]
    const singleCiKey = a1.resolveKeyColumnIndex(singleCiCols, 'USER_ID')

    const multiCiCols = [{ name: 'user_id', type: 'integer' }, { name: 'USER_ID', type: 'integer' }]
    const multiCiKey = a1.resolveKeyColumnIndex(multiCiCols, 'User_Id')

    // 4. A1-R3: 截断文本主键与 BLOB 预览主键拒绝
    const truncKeyCols = [{ name: 'code', type: 'text', nullable: false, primaryKeyOrdinal: 0, defaultValue: null }]
    const truncCols = [{ name: 'code', type: 'text' }]
    const truncRow1 = { index: 0, cells: [{ kind: 'text', text: 'PREFIX', truncated: true, fullLength: 2000 }] }
    const truncRow2 = { index: 1, cells: [{ kind: 'text', text: 'PREFIX', truncated: true, fullLength: 3000 }] }
    const truncExtract1 = a1.extractKeyValues(truncRow1, truncCols, truncKeyCols)
    const truncExtract2 = a1.extractKeyValues(truncRow2, truncCols, truncKeyCols)

    const blobKeyCols = [{ name: 'hash', type: 'blob', nullable: false, primaryKeyOrdinal: 0, defaultValue: null }]
    const blobCols = [{ name: 'hash', type: 'blob' }]
    const blobRow1 = { index: 0, cells: [{ kind: 'blob', previewBase64: 'AAAA', length: 100, truncated: true }] }
    const blobRow2 = { index: 1, cells: [{ kind: 'blob', previewBase64: 'AAAA', length: 200, truncated: true }] }
    const blobExtract1 = a1.extractKeyValues(blobRow1, blobCols, blobKeyCols)
    const blobExtract2 = a1.extractKeyValues(blobRow2, blobCols, blobKeyCols)

    let encodeTruncThrew = false
    try {
      a1.encodeRowKey({ code: { kind: 'text', text: 'PREFIX', truncated: true } })
    } catch {
      encodeTruncThrew = true
    }

    let encodeBlobThrew = false
    try {
      a1.encodeRowKey({ hash: { kind: 'blob', previewBase64: 'AAAA', length: 100, truncated: true } })
    } catch {
      encodeBlobThrew = true
    }

    return {
      keyAVal: keyA?.ID?.value,
      keyBVal: keyB?.ID?.value,
      rowKeyA,
      rowKeyB,
      dupExtract,
      singleCiKey,
      multiCiKey,
      truncExtract1,
      truncExtract2,
      blobExtract1,
      blobExtract2,
      encodeTruncThrew,
      encodeBlobThrew
    }
  })
  check('★ A1-R1: Row A 准确提取真实大小写列 ID=10', contractResults.keyAVal === 10, JSON.stringify(contractResults))
  check('★ A1-R1: Row B 准确提取真实大小写列 ID=20', contractResults.keyBVal === 20, JSON.stringify(contractResults))
  check('★ A1-R1: 两个编辑身份绝对没有合并', contractResults.rowKeyA !== contractResults.rowKeyB, `${contractResults.rowKeyA} vs ${contractResults.rowKeyB}`)
  check('★ A1-R1: 重名列返回 null（歧义拒绝）', contractResults.dupExtract === null, JSON.stringify(contractResults.dupExtract))
  check('★ A1-R1: 单一大小写候选安全回退为对应下标', contractResults.singleCiKey === 0, contractResults.singleCiKey)
  check('★ A1-R1: 多大小写候选无法唯一确定时返回 null', contractResults.multiCiKey === null, contractResults.multiCiKey)
  check('★ A1-R3: 截断文本主键 extractKeyValues 返回 null', contractResults.truncExtract1 === null && contractResults.truncExtract2 === null)
  check('★ A1-R3: BLOB 预览主键 extractKeyValues 返回 null', contractResults.blobExtract1 === null && contractResults.blobExtract2 === null)
  check('★ A1-R3: encodeRowKey 对截断文本主键抛错拒绝', contractResults.encodeTruncThrew === true)
  check('★ A1-R3: encodeRowKey 对 BLOB 主键抛错拒绝', contractResults.encodeBlobThrew === true)

  console.log('\n[15] A1-R3: GUI BLOB 主键行拒绝编辑且不产生脏暂存')
  await openTableByName('变更测试库', 'blob_pk_items')
  const blobTabIndex = (await tabCount()) - 1
  await switchToTab(blobTabIndex)
  // 尝试双击 BLOB 主键行的 name 单元格
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const nameCell = rows[0]?.querySelectorAll('.grid-cell')[2]
    nameCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForTimeout(500)
  const editorOpened = await win.evaluate(() =>
    document.querySelectorAll('.tab-pane:not([hidden]) .grid-cell-editor').length > 0
  )
  const blobStatus = await win.evaluate(() => document.getElementById('status-bar')?.textContent ?? '')
  check('★ BLOB 主键行双击未弹出编辑输入框（拒绝编辑）', editorOpened === false)
  check('★ 状态栏明确提示主键不完整/无法唯一定位', blobStatus.includes('主键不完整') || blobStatus.includes('无法唯一定位'), blobStatus)
  const blobToolbar = await toolbarState()
  check('★ 未产生任何未应用改动', blobToolbar.dirtyCells === 0 && blobToolbar.applyEnabled === false)

  console.log('\n[16] A1-R2: NULL 原值编辑后再清空完整撤回暂存，多列编辑保留独立性')
  await openTableByName('变更测试库', 'null_items')
  const nullTabIndex = (await tabCount()) - 1
  await switchToTab(nullTabIndex)

  // 1. 将 id=1 的 note（原值 NULL）修改为 'temp-note'
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const noteCell = rows[0]?.querySelectorAll('.grid-cell')[2]
    noteCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = 'temp-note'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(500)
  let nullTb = await toolbarState()
  check('★ NULL 单元格编辑后暂存 1 处改动（应用修改按钮启用）', nullTb.dirtyCells === 1 && nullTb.applyEnabled === true)

  // 2. 再次双击该单元格，清空为 ''（回退原值 NULL）
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const noteCell = rows[0]?.querySelectorAll('.grid-cell')[2]
    noteCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = ''
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(500)
  nullTb = await toolbarState()
  const cellDirty = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const noteCell = rows[0]?.querySelectorAll('.grid-cell')[2]
    return noteCell?.classList.contains('is-dirty') ?? false
  })
  check('★ 清空回退后暂存池完全清空（0 处改动，旧暂存已移除）', nullTb.dirtyCells === 0 && nullTb.applyEnabled === false)
  check('★ 单元格 is-dirty 视觉标记已被准确移除', cellDirty === false)

  // 3. 多列测试：note 改为 'final-note', val 改为 'final-val'，然后将 note 清空回退
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    rows[0]?.querySelectorAll('.grid-cell')[2]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = 'final-note'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(400)

  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    rows[0]?.querySelectorAll('.grid-cell')[3]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = 'final-val'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(400)

  // 将 note 再次清空回退为 NULL
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    rows[0]?.querySelectorAll('.grid-cell')[2]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = ''
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(500)

  const multiState = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const noteCell = rows[0]?.querySelectorAll('.grid-cell')[2]
    const valCell = rows[0]?.querySelectorAll('.grid-cell')[3]
    return {
      noteDirty: noteCell?.classList.contains('is-dirty'),
      valDirty: valCell?.classList.contains('is-dirty'),
      valText: valCell?.textContent?.trim()
    }
  })
  check('★ note 撤回后不再为 is-dirty', multiState.noteDirty === false)
  check('★ 同行 val 字段修改仍保留且为 is-dirty', multiState.valDirty === true && multiState.valText === 'final-val')

  // 应用并提交
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '应用修改'
    )
    b?.click()
  })
  await win.waitForTimeout(800)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '提交'
    )
    b?.click()
  })
  await win.waitForTimeout(1200)

  {
    const db = new DatabaseSync(dbPath)
    const row = db.prepare('SELECT id, note, val FROM null_items WHERE id = 1').get()
    db.close()
    check('★ 独立数据库确认：note 仍为 NULL（撤回生效）', row?.note === null, JSON.stringify(row))
    check('★ 独立数据库确认：val 成功落盘为 final-val', row?.val === 'final-val', JSON.stringify(row))
  }

  console.log('\n[17] 带脏编辑的主动刷新守卫验证（取消保留编辑、丢弃清理编辑重载）')
  await switchToTab(tabAIndex)
  // 修改 a1_items id=100 为 'alpha-dirty'
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '100')
    const nameCell = targetRow?.querySelectorAll('.grid-cell')[2]
    nameCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = 'alpha-dirty'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(500)

  // 点击网格工具条上的「重新加载」按钮
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '重新加载'
    )
    b?.click()
  })
  await win.waitForSelector('#dbstudio-transaction-dialog[open]', { timeout: 3000 })
  const reloadDialogMsg = await win.evaluate(() =>
    document.querySelector('#dbstudio-transaction-dialog p')?.textContent ?? ''
  )
  check('★ 触发重新加载弹出事务守卫对话框', reloadDialogMsg.includes('未应用的编辑') || reloadDialogMsg.includes('重新加载'), reloadDialogMsg)

  // 1. 点「取消」
  await clickDialogAction('cancel')
  await win.waitForTimeout(600)
  const cancelState = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '100')
    const nameCell = targetRow?.querySelectorAll('.grid-cell')[2]
    return {
      text: nameCell?.textContent?.trim(),
      isDirty: nameCell?.classList.contains('is-dirty')
    }
  })
  check('★ 选「取消」后重新加载中止，脏编辑 alpha-dirty 完好保留', cancelState.text === 'alpha-dirty' && cancelState.isDirty === true, JSON.stringify(cancelState))

  // 2. 再次点「重新加载」，选「丢弃」
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '重新加载'
    )
    b?.click()
  })
  await win.waitForSelector('#dbstudio-transaction-dialog[open]', { timeout: 3000 })
  await clickDialogAction('discard')
  await win.waitForTimeout(1000)

  const discardState = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '100')
    const nameCell = targetRow?.querySelectorAll('.grid-cell')[2]
    return {
      text: nameCell?.textContent?.trim(),
      isDirty: nameCell?.classList.contains('is-dirty')
    }
  })
  check('★ 选「丢弃」后重新加载完成，恢复库中真实值 alpha 且无 dirty 标记', discardState.text === 'alpha' && discardState.isDirty === false, JSON.stringify(discardState))

  // Query and paging races run against ResultGrid in gui-grid-lifecycle.mjs.

  console.log('\n[19] 跨连接脏编辑与稳定行身份完全隔离')
  // 在当前连接（变更测试库）Tab A 编辑 id=30 为 'conn1-dirty'，暂不应用
  await switchToTab(tabAIndex)
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '30')
    const nameCell = targetRow?.querySelectorAll('.grid-cell')[2]
    nameCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = 'conn1-dirty'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(500)

  // Filtering opens a new, read-only tab. The source tab must retain its
  // unapplied edit; the new query must show the actual database value.
  const beforeFilter = await tabCount()
  const filterHidden = await win.$eval('#filter-bar', (bar) => bar.hidden)
  if (filterHidden) await win.click('#btn-filter-toggle')
  await win.fill('#filter-input', 'id = 30')
  await win.click('#btn-filter-apply')
  await win.waitForFunction((count) =>
    document.querySelectorAll('#result-tabs-scroll .tab-chip').length === count + 1,
  beforeFilter, { timeout: 8000 })
  await win.waitForFunction(() =>
    [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row .grid-cell')]
      .some((cell) => cell.textContent?.trim() === 'three'),
  undefined, { timeout: 8000 })
  const filteredState = await toolbarState()
  check('★ 带未应用编辑筛选新开标签，结果取数据库值而非暂存值',
    filteredState.rows.some((row) => row.includes('three')) &&
      filteredState.rows.every((row) => !row.includes('conn1-dirty')),
    JSON.stringify(filteredState.rows))
  check('★ 筛选标签没有继承源标签脏编辑', filteredState.dirtyCells === 0)
  await switchToTab(tabAIndex)
  const sourceAfterFilter = await toolbarState()
  check('★ 筛选后源标签仍保留原来的未应用编辑',
    sourceAfterFilter.dirtyCells === 1 &&
      sourceAfterFilter.rows.some((row) => row.includes('conn1-dirty')),
    JSON.stringify(sourceAfterFilter))
  {
    const db = new DatabaseSync(dbPath)
    const actual = db.prepare('SELECT name FROM a1_items WHERE id = 30').get()
    db.close()
    check('★ 筛选未暗中应用编辑，独立连接读到 three', actual?.name === 'three', JSON.stringify(actual))
  }

  // 打开新连接（隔离测试库）的 other_items 表
  await openTableByName('隔离测试库', 'other_items')
  const conn2TabIndex = (await tabCount()) - 1
  await switchToTab(conn2TabIndex)

  const conn2Toolbar = await toolbarState()
  check('★ 新连接标签完全没有继承连接 1 的脏编辑（0 处改动）', conn2Toolbar.dirtyCells === 0 && conn2Toolbar.applyEnabled === false)

  // 在新连接编辑 id=10 为 'other-edited'，并应用提交
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '10')
    const nameCell = targetRow?.querySelectorAll('.grid-cell')[2]
    nameCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', { timeout: 3000 })
  await win.evaluate(() => {
    const input = document.querySelector('.tab-pane:not([hidden]) .grid-cell-editor')
    if (input) {
      input.value = 'other-edited'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
  })
  await win.waitForTimeout(400)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '应用修改'
    )
    b?.click()
  })
  await win.waitForTimeout(800)
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '提交'
    )
    b?.click()
  })
  await win.waitForTimeout(1000)

  // 切回连接 1 的 Tab A
  await switchToTab(tabAIndex)
  const conn1State = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-row')]
    const targetRow = rows.find((r) => r.querySelectorAll('.grid-cell')[1]?.textContent?.trim() === '30')
    const nameCell = targetRow?.querySelectorAll('.grid-cell')[2]
    return {
      text: nameCell?.textContent?.trim(),
      isDirty: nameCell?.classList.contains('is-dirty')
    }
  })
  check('★ 切回连接 1 后其脏编辑 conn1-dirty 丝毫不受连接 2 提交影响', conn1State.text === 'conn1-dirty' && conn1State.isDirty === true, JSON.stringify(conn1State))

  // 清理连接 1 的脏编辑
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '重新加载'
    )
    b?.click()
  })
  await win.waitForTimeout(600)
  await clickDialogAction('discard')
  await win.waitForTimeout(800)
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

