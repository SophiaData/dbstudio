import assert from 'node:assert/strict'
import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchTransactionApp, pane } from './helpers/transaction-app.mjs'

let passed = 0
async function prepare(f) {
  const primary = await f.add()
  const otherPath = join(f.work, 'other.db')
  copyFileSync(f.dbPath, otherPath)
  await f.open()
  await f.edit('applied')
  await f.win.getByRole('button', { name: '应用修改', exact: true }).click()
  await f.win.waitForFunction(() => {
    const cell = document.querySelector('.tab-pane:not([hidden]) .grid-row')?.querySelectorAll('.grid-cell')[2]
    return cell?.textContent === 'applied' && !cell.classList.contains('is-dirty')
  })
  await f.open()
  await f.edit('local', 1)
  const other = await f.add('other-db', otherPath)
  return { primary, other, otherPath }
}
async function trigger(f, entry) {
  const row = f.win.locator('.tree-row').filter({ has: f.win.getByText('guard-db', { exact: true }) })
  if (entry === 'toolbar' || entry === 'delete') {
    await row.locator('.row-label').click()
    if (entry === 'delete') f.win.once('dialog', (d) => d.accept())
    await f.win.locator('.conn-actions').getByRole('button', { name: entry === 'delete' ? '删除连接' : '断开', exact: true }).click()
  } else {
    await row.dispatchEvent('contextmenu', { clientX: 100, clientY: 130 })
    await f.win.getByText(entry === 'tree' ? '断开连接' : '编辑连接…', { exact: true }).click()
    if (entry === 'update') {
      await f.win.getByRole('textbox', { name: '连接名', exact: true }).fill('renamed-db')
      await f.win.getByRole('button', { name: '保存', exact: true }).click()
    }
  }
}

for (const entry of ['toolbar', 'tree', 'delete', 'update']) {
  for (const action of ['cancel', 'apply-commit', 'discard-rollback']) {
    const f = await launchTransactionApp()
    try {
      const { primary, other, otherPath } = await prepare(f)
      const configPath = join(f.work, 'userdata', 'connections.json')
      const savedBefore = readFileSync(configPath, 'utf8')
      await trigger(f, entry)
      await f.win.waitForSelector('#dbstudio-transaction-dialog')
      assert.match(await f.win.locator('#dbstudio-transaction-dialog').textContent(), /未提交/)
      assert.equal(await f.win.locator('.tab-grid-root[inert]').count(), 2)
      await f.win.evaluate((entry) => {
        document.querySelector('.grid-cell')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        const disconnect = [...document.querySelectorAll('.conn-actions button')].find((b) => b.textContent === '断开')
        if (entry === 'toolbar') disconnect?.click()
      }, entry)
      assert.equal(await f.win.locator('.grid-cell-editor').count(), 0)
      assert.equal(await f.win.locator('#dbstudio-transaction-dialog').count(), 1)
      assert.deepEqual(f.values(), ['original', 'second'])
      await f.choose(action)
      if (action === 'cancel') {
        await f.win.waitForFunction(() => document.querySelectorAll('.tab-grid-root[inert]').length === 0)
        await f.assertConnected(primary.id)
        assert.equal(readFileSync(configPath, 'utf8'), savedBefore)
        assert.equal(await f.win.locator('.grid-cell.is-dirty').count(), 1)
        const state = await f.win.evaluate((id) => window.dbstudio.transactionState(`connection:${id}`), primary.id)
        assert.equal(state.active, true)
        assert.deepEqual(f.values(), ['original', 'second'])
      } else {
        await f.win.waitForFunction(({ id, entry }) => window.dbstudio.listConnections().then((list) => {
          const c = list.find((c) => c.id === id)
          return entry === 'delete' ? !c : entry === 'update' ? c?.name === 'renamed-db' : c?.connected === false
        }), { id: primary.id, entry })
        await f.win.waitForFunction(() => [...document.querySelectorAll('.tab-grid-root')].every((r) => r.textContent.includes('连接已关闭或更新')))
        assert.deepEqual(f.values(), action === 'apply-commit' ? ['applied', 'local'] : ['original', 'second'])
        assert.equal(await f.win.locator('.grid-cell-editor').count(), 0)
        assert.equal(await f.win.locator('#btn-export-all').isDisabled(), true)
        assert.equal(await f.win.locator('#result-tools').isHidden(), true)
      }
      await f.assertConnected(other.id)
      assert.deepEqual(f.values(otherPath), ['original', 'second'])
      console.log(`PASS ${entry}: ${action}; two-tab transaction and other connection verified`)
      passed++
    } finally { await f.stop() }
  }
}

for (const channel of ['transactionState', 'applyEdits', 'commitTransaction', 'rollbackTransaction']) {
  const f = await launchTransactionApp()
  try {
    const { primary } = await prepare(f)
    await f.app.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(`dbstudio:${channel}`)
      ipcMain.handle(`dbstudio:${channel}`, () => { throw new Error(`injected-${channel}-failure`) })
    }, channel)
    await trigger(f, 'toolbar')
    if (channel !== 'transactionState') {
      await f.choose(channel === 'rollbackTransaction' ? 'discard-rollback' : 'apply-commit')
    }
    await f.win.waitForFunction(() => document.querySelectorAll('.tab-grid-root[inert]').length === 0)
    await f.assertConnected(primary.id)
    assert.deepEqual(f.values(), ['original', 'second'])
    if (channel !== 'commitTransaction') assert.equal(await f.win.locator('.grid-cell.is-dirty').count(), 1)
    assert.equal(await f.win.locator('.tab-chip').count(), 2)
    console.log(`PASS ${channel} failure blocks disconnect and preserves connection/data`)
    passed++
  } finally { await f.stop() }
}
console.log(`Connection guards: ${passed} scenarios passed`)
