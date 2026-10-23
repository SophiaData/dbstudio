/**
 * 事务离开保护的真实 GUI 测试。
 *
 * 背景：数据库事务是**连接级**的，但界面上的结果标签是**标签级**的。早先每个
 * 网格各自管自己的「未提交改动」，于是：
 *   - 在 A 标签改了数据，切到 B 标签点「提交」→ 提交的是整个连接，不只是 B；
 *   - 关掉标签时未提交的改动被静默丢弃或静默保留，用户完全不知道；
 *   - 同一连接开两个标签，两边显示的事务状态互相矛盾。
 *
 * 正确行为：连接级统一状态 + 离开前明确询问影响范围。
 * 本测试钉住：
 *   1. 同一连接的两个标签共享同一个事务状态；
 *   2. 关闭标签时弹出对话框，用户可选择「应用并离开 / 丢弃 / 取消」；
 *   3. 「取消」时标签不会被关闭（不会在用户拒绝后仍然关掉）；
 *   4. 「丢弃」后数据库里的数据确实没变。
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

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-txlifecycle-'))
const dbPath = join(workDir, 'tx.db')
{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO items (id, name) VALUES (1, 'original'), (2, 'second');
  `)
  db.close()
}

const userDataDir = join(workDir, 'userdata')
mkdirSync(userDataDir, { recursive: true })
const shotDir = join(root, 'out/gui-transaction-lifecycle')
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

/** 事务对话框是否存在、当前有哪些按钮。 */
const dialogState = () =>
  win.evaluate(() => {
    const dialog = document.getElementById('dbstudio-transaction-dialog')
    if (!dialog) return { present: false }
    return {
      present: true,
      open: dialog.hasAttribute('open'),
      title: dialog.querySelector('h2')?.textContent ?? '',
      message: dialog.querySelector('p')?.textContent ?? '',
      actions: [...dialog.querySelectorAll('button')].map((b) => ({
        action: b.dataset['transactionAction'],
        label: b.textContent,
        kind: b.className
      }))
    }
  })

/** 点事务对话框里的某个动作按钮。 */
async function clickDialogAction(action) {
  return win.evaluate((act) => {
    const dialog = document.getElementById('dbstudio-transaction-dialog')
    const btn = dialog?.querySelector(`button[data-transaction-action="${act}"]`)
    if (!btn) return false
    btn.click()
    return true
  }, action)
}

/** 当前可见标签的工具条按钮文本。 */
const toolbarTexts = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].map(
      (b) => b.textContent?.trim() ?? ''
    )
  )

const tabCount = () =>
  win.evaluate(() => document.querySelectorAll('#result-tabs-scroll .tab-chip').length)

/** 在当前可见标签里改一个单元格（进入编辑态并回车确认），不落库。 */
async function editFirstRowCell(columnIndex, value) {
  await win.evaluate((idx) => {
    const row = document.querySelector('.tab-pane:not([hidden]) .tab-grid-root .grid-row')
    const cell = row?.querySelectorAll('.grid-cell')[idx]
    if (cell) cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  }, columnIndex)
  await win.waitForSelector('.tab-pane:not([hidden]) .grid-cell-editor', {
    state: 'attached',
    timeout: 5000
  })
  const editor = await win.$('.tab-pane:not([hidden]) .grid-cell-editor')
  await editor.fill(value)
  await editor.press('Enter')
  await win.waitForTimeout(300)
}

/** 数据库里的实际值（绕过界面，验证真落盘与否）。 */
function readDb() {
  const db = new DatabaseSync(dbPath)
  const rows = db.prepare('SELECT id, name FROM items ORDER BY id').all()
  db.close()
  return rows
}

try {
  console.log('\n[1] 建连接并打开同一张表的两个标签')
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', '事务测试库')
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

  // 从树上打开同一张表两次 → 两个标签，同一个连接。
  // 必须走表（不能走 SQL）：自由 SQL 结果是只读的，编辑路径不存在。
  const openItemsTable = async () => {
    // 树是懒加载的：连接 → 表分组 → 表。要逐级点开。
    await win.evaluate(() => {
      const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
      const conn = rows.find((r) => r.textContent?.includes('事务测试库'))
      const twisty = conn?.querySelector('.twisty')
      if (twisty && twisty.textContent?.trim() === '▸') twisty.click()
    })
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
  await openItemsTable()
  await openItemsTable()

  const count = await tabCount()
  check('两个标签都已打开', count === 2, `实际 ${count}`)

  const editable = await win.evaluate(
    () =>
      document.querySelector('.tab-pane:not([hidden]) .tab-grid-root')?.dataset['editable'] ?? 'none'
  )
  check('表来源是可编辑的', editable === 'true', String(editable))

  console.log('\n[2] 在第一个标签改动，第二个标签应看到同一个连接的事务状态')
  // 列序：# / id / name → name 是 index 2。
  // 注意：打开两张表后**活动标签是第二个**，要显式切回第一个再改。
  await win.evaluate(() => {
    const chip = document.querySelectorAll('#result-tabs-scroll .tab-chip')[0]
    chip?.querySelector('.tab-chip-label')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(500)
  await editFirstRowCell(2, 'edited-in-tab-1')
  const dirtyMarked = await win.evaluate(
    () => document.querySelectorAll('.tab-pane:not([hidden]) .grid-cell.is-dirty').length > 0
  )
  check('改动被标为脏（尚未应用）', dirtyMarked)

  // 切到第二个标签。
  await win.evaluate(() => {
    const chip = document.querySelectorAll('#result-tabs-scroll .tab-chip')[1]
    chip?.querySelector('.tab-chip-label')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(500)

  const secondTabButtons = await toolbarTexts()
  check(
    '第二个标签也有编辑工具条',
    secondTabButtons.includes('应用修改'),
    secondTabButtons.join(' | ')
  )
  const secondApplyDisabled = await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '应用修改'
    )
    return b ? b.disabled : null
  })
  check(
    '★ 第二个标签的「应用修改」禁用（它自己没有未应用编辑）',
    secondApplyDisabled === true,
    String(secondApplyDisabled)
  )

  console.log('\n[3] 关闭有未应用编辑的标签 → 必须弹对话框')
  await win.evaluate(() => {
    const chip = document.querySelectorAll('#result-tabs-scroll .tab-chip')[0]
    chip?.querySelector('.tab-chip-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(700)

  const dialog = await dialogState()
  check('★ 关闭标签弹出了事务对话框', dialog.present && dialog.open, JSON.stringify(dialog))
  check('对话框说明了未应用的编辑量', /1 行/.test(dialog.message ?? ''), dialog.message)
  check(
    '对话框提供「应用 / 丢弃 / 取消」三个选择',
    ['apply', 'discard', 'cancel'].every((a) =>
      (dialog.actions ?? []).some((x) => x.action === a)
    ),
    JSON.stringify(dialog.actions)
  )
  await win.screenshot({ path: join(shotDir, '01-关闭标签询问.png') })

  console.log('\n[4] 选「取消」→ 标签不能被关掉')
  await clickDialogAction('cancel')
  await win.waitForTimeout(700)
  const afterCancel = await tabCount()
  check('★ 取消后标签仍然存在', afterCancel === 2, `实际 ${afterCancel}`)
  const dialogGone = await dialogState()
  check('对话框已关闭', !dialogGone.present || !dialogGone.open, JSON.stringify(dialogGone))
  await win.screenshot({ path: join(shotDir, '02-已取消.png') })

  console.log('\n[5] 再关一次并选「丢弃」→ 标签关闭，数据不变')
  await win.evaluate(() => {
    const chip = document.querySelectorAll('#result-tabs-scroll .tab-chip')[0]
    chip?.querySelector('.tab-chip-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(700)
  const dialog2 = await dialogState()
  check('再次弹出对话框', dialog2.present && dialog2.open, JSON.stringify(dialog2))

  await clickDialogAction('discard')
  await win.waitForTimeout(900)
  const afterDiscard = await tabCount()
  check('★ 丢弃后标签被关闭', afterDiscard === 1, `实际 ${afterDiscard}`)

  const rowsAfterDiscard = readDb()
  check(
    '★ 丢弃后数据库数据未变',
    rowsAfterDiscard.find((r) => r.id === 1)?.name === 'original',
    JSON.stringify(rowsAfterDiscard)
  )
  await win.screenshot({ path: join(shotDir, '03-已丢弃.png') })

  console.log('\n[6] 应用编辑 → 进入事务但未提交')
  // 此时只剩一个标签（tab 2），它是唯一的事务所有者。
  await editFirstRowCell(2, 'applied-value')
  const applied = await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '应用修改'
    )
    if (!b || b.disabled) return false
    b.click()
    return true
  })
  check('点「应用修改」成功', applied)
  await win.waitForTimeout(1500)

  const rowsAfterApply = readDb()
  check(
    '★ 应用后仍未落盘（要提交才落盘）',
    rowsAfterApply.find((r) => r.id === 1)?.name === 'original',
    JSON.stringify(rowsAfterApply)
  )

  const commitEnabled = await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '提交'
    )
    return b ? !b.disabled : false
  })
  check('「提交」按钮可用（事务已建立）', commitEnabled)
  await win.screenshot({ path: join(shotDir, '04-已应用.png') })

  console.log('\n[7] 再开一个标签验证连接级事务状态同步')
  // 关键：事务属于**连接**，不属于标签。新开的标签必须立刻看到同一份状态。
  await openItemsTable()
  const sharedCommit = await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '提交'
    )
    return b ? !b.disabled : null
  })
  check('★ 新标签立刻看到连接上的未提交事务（提交可用）', sharedCommit === true, String(sharedCommit))
  const txInfo = await win.evaluate(
    () =>
      document.querySelector('.tab-pane:not([hidden]) .grid-toolbar .grid-tx-info')?.textContent ?? ''
  )
  check('★ 事务状态提示同步到新标签', txInfo.includes('未提交'), txInfo)
  await win.screenshot({ path: join(shotDir, '05-连接级状态.png') })

  console.log('\n[8] 关闭标签时询问提交还是回滚')
  // 关掉新开的这个标签：它自己没改动，但连接上有未提交事务，
  // 且它不是最后一个参与者，所以不应弹「连接级」询问。
  await win.evaluate(() => {
    const chips = document.querySelectorAll('#result-tabs-scroll .tab-chip')
    const chip = chips[chips.length - 1]
    chip?.querySelector('.tab-chip-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(900)
  const afterNoPrompt = await tabCount()
  check('无本地改动的标签可直接关闭', afterNoPrompt === 1, `实际 ${afterNoPrompt}`)

  // 关掉最后一个标签 → 此时它是唯一所有者，必须询问提交还是回滚。
  await win.evaluate(() => {
    const chip = document.querySelectorAll('#result-tabs-scroll .tab-chip')[0]
    chip?.querySelector('.tab-chip-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(900)

  const dialog3 = await dialogState()
  check('★ 弹出连接级事务询问', dialog3.present && dialog3.open, JSON.stringify(dialog3))
  check('★ 对话框提示影响整个连接', dialog3.message.includes('连接'), dialog3.message)
  check(
    '★ 提供提交与回滚两个选项',
    dialog3.actions.some((a) => a.action === 'apply-commit') &&
      dialog3.actions.some((a) => a.action === 'discard-rollback'),
    JSON.stringify(dialog3.actions)
  )
  await win.screenshot({ path: join(shotDir, '06-连接级询问.png') })

  console.log('\n[9] 选「回滚」→ 数据恢复原样')
  await clickDialogAction('discard-rollback')
  await win.waitForTimeout(1200)

  const afterRollback = await tabCount()
  check('标签已关闭', afterRollback === 0, `实际 ${afterRollback}`)
  const rowsAfterRollback = readDb()
  check(
    '★ 回滚后数据库数据是原值',
    rowsAfterRollback.find((r) => r.id === 1)?.name === 'original',
    JSON.stringify(rowsAfterRollback)
  )
  await win.screenshot({ path: join(shotDir, '07-已回滚.png') })

  console.log('\n[10] 重新做一次并选「提交」→ 数据落盘')
  await openItemsTable()
  await editFirstRowCell(2, 'committed-value')
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '应用修改'
    )
    b?.click()
  })
  await win.waitForTimeout(1500)

  await win.evaluate(() => {
    const chip = document.querySelectorAll('#result-tabs-scroll .tab-chip')[0]
    chip?.querySelector('.tab-chip-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(900)
  const dialog4 = await dialogState()
  check('再次弹出连接级询问', dialog4.present && dialog4.open, JSON.stringify(dialog4))

  await clickDialogAction('apply-commit')
  await win.waitForTimeout(1500)

  const rowsAfterCommit = readDb()
  check(
    '★ 提交后数据已落盘',
    rowsAfterCommit.find((r) => r.id === 1)?.name === 'committed-value',
    JSON.stringify(rowsAfterCommit)
  )
  await win.screenshot({ path: join(shotDir, '08-已提交.png') })

  console.log('\n[11] 退出应用前的询问')
  // 再做一次未提交的改动，然后尝试关窗口：
  // macOS 上关窗口不等于退出，但**必须**先问一次未提交事务——
  // 否则用户以为收工了，改动静默消失。
  await openItemsTable()
  await editFirstRowCell(2, 'pending-at-quit')
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '应用修改'
    )
    b?.click()
  })
  await win.waitForTimeout(1500)

  const quitHookPresent = await win.evaluate(
    () => typeof window.dbstudioGuardTransactions === 'function'
  )
  check('★ 渲染进程暴露了退出询问钩子', quitHookPresent)

  // 不能直接 await 这个钩子：它在等用户点对话框按钮，会把测试卡死。
  // 所以先发起（不 await），确认对话框真的弹出来了，再点按钮，最后读结果。
  await win.evaluate(() => {
    window.__guardResult = null
    void window.dbstudioGuardTransactions('退出应用').then((r) => {
      window.__guardResult = r
    })
  })
  await win.waitForTimeout(800)

  const quitDialog = await dialogState()
  check('★ 退出时弹出了事务询问框', quitDialog.present && quitDialog.open, JSON.stringify(quitDialog))
  check('★ 询问框说明影响整个连接', quitDialog.message.includes('连接'), quitDialog.message)
  await win.screenshot({ path: join(shotDir, '09-退出询问.png') })

  // 选「取消」→ 应用继续开着，数据还在。
  await clickDialogAction('cancel')
  await win.waitForTimeout(600)
  const guardResult = await win.evaluate(() => window.__guardResult)
  check('★ 取消后钩子返回 false（不放行退出）', guardResult === false, String(guardResult))
  const stillAlive = await win.evaluate(() => document.querySelectorAll('.grid-row').length > 0)
  check('★ 取消后应用仍在运行', stillAlive)

  const rowsStillPending = readDb()
  check(
    '★ 取消后未提交的数据仍在事务里（未落盘）',
    rowsStillPending.find((r) => r.id === 1)?.name === 'committed-value',
    JSON.stringify(rowsStillPending)
  )

  console.log('\n[12] 关闭前先处理掉待决事务')
  // 退出守卫会拦住 app.close()（它在等一个没人点的对话框）。
  // 所以关闭应用前必须先把待决事务回滚掉——这本身就是守卫在工作的证明。
  const rollbackClicked = await win.evaluate(() => {
    const b = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (x) => x.textContent?.trim() === '回滚'
    )
    if (!b || b.disabled) return false
    b.click()
    return true
  })
  check('点「回滚」发起回滚', rollbackClicked)
  await win.waitForTimeout(700)
  const rollbackDialog = await dialogState()
  check('回滚前弹出确认框', rollbackDialog.present && rollbackDialog.open, JSON.stringify(rollbackDialog))
  await clickDialogAction('discard-rollback')
  await win.waitForTimeout(1200)

  const resolved = await dialogState()
  check('待决事务询问框已解决', !resolved.present || !resolved.open, JSON.stringify(resolved))

  const rowsRolledBack = readDb()
  check(
    '★ 回滚后数据库是上一次提交的值',
    rowsRolledBack.find((r) => r.id === 1)?.name === 'committed-value',
    JSON.stringify(rowsRolledBack)
  )
} finally {
  // 兜底：万一还有对话框没关，强行解决它，否则 app.close() 会被守卫无限拦住。
  try {
    await clickDialogAction('discard-rollback')
    await clickDialogAction('cancel')
  } catch {
    /* 页面可能已经关了 */
  }
  await app.close().catch(() => {})
}

console.log(`\n===== 事务生命周期 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exit(1)
