import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
export const root = resolve(import.meta.dirname, '../..')
export const pane = '.tab-pane:not([hidden])'

export async function launchTransactionApp(overrides = {}) {
  const work = mkdtempSync(join(tmpdir(), 'dbstudio-guard-'))
  const dbPath = join(work, 'test.db')
  const db = new DatabaseSync(dbPath)
  db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES(1,'original'),(2,'second')")
  db.close()
  mkdirSync(join(work, 'userdata'))
  const env = { ...process.env, DBSTUDIO_TEST_HIDDEN: '1', ...overrides }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath: require('electron'), cwd: root, env,
    args: ['.', `--user-data-dir=${join(work, 'userdata')}`,
      ...(process.platform === 'linux' && env.ELECTRON_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : [])]
  })
  let win = await app.firstWindow()
  async function ready() {
    await win.waitForSelector('#tree-rows', { state: 'attached' })
    await win.waitForFunction(() => typeof window.dbstudioGuardTransactions === 'function')
  }
  await ready()
  async function add(name = 'guard-db', file = dbPath) {
    await win.click('#btn-new-connection')
    await win.fill('#f-name', name)
    await win.fill('#f-dynamic input[data-key="file"]', file)
    await win.click('#btn-submit')
    await win.waitForFunction(() => !document.querySelector('#dlg-connection')?.open)
    await win.getByText(name, { exact: true }).first().waitFor()
    return win.evaluate(async (name) => (await window.dbstudio.listConnections()).find((c) => c.name === name), name)
  }
  async function open(name = 'guard-db') {
    const conn = win.locator('.tree-row').filter({ has: win.locator('.row-label', { hasText: name }) }).first()
    await conn.waitFor()
    if ((await conn.locator('.twisty').textContent()).trim() === '▸') await conn.locator('.twisty').click()
    const folder = win.locator('.tree-row').filter({ has: win.getByText('表', { exact: true }) }).first()
    await folder.waitFor()
    if ((await folder.locator('.twisty').textContent()).trim() === '▸') await folder.locator('.twisty').click()
    const count = await win.locator('.tab-chip').count()
    await win.locator('.tree-row .row-label').getByText('items', { exact: true }).click()
    await win.waitForFunction((count) => document.querySelectorAll('.tab-chip').length === count + 1, count)
    await win.waitForSelector(`${pane} .grid-row .grid-cell`)
  }
  async function edit(value, row = 0) {
    await win.waitForFunction(({ row, selector }) => {
      const target = document.querySelectorAll(`${selector} .grid-row`)[row]
      if (!document.querySelector(`${selector} .grid-cell-editor`)) {
        target?.querySelectorAll('.grid-cell')[2]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      }
      return !!document.querySelector(`${selector} .grid-cell-editor`)
    }, { row, selector: pane }, { timeout: 5000 })
    const input = win.locator(`${pane} .grid-cell-editor`)
    await input.fill(value)
    await input.press('Enter')
    await win.waitForSelector(`${pane} .grid-cell.is-dirty`)
  }
  async function choose(action) {
    await win.locator(`#dbstudio-transaction-dialog [data-transaction-action="${action}"]`).click()
    await win.waitForSelector('#dbstudio-transaction-dialog', { state: 'detached' }).catch(() => {})
  }
  function values(file = dbPath) {
    const reader = new DatabaseSync(file)
    try { return reader.prepare('SELECT name FROM items ORDER BY id').all().map((r) => r.name) }
    finally { reader.close() }
  }
  return {
    app, work, dbPath, get win() { return win }, add, open, edit, choose, values,
    async recreate() {
      const next = app.waitForEvent('window')
      await app.evaluate(({ app }) => app.emit('activate'))
      win = await next
      await ready()
    },
    async stop() {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await app.close().catch(() => {})
      rmSync(work, { recursive: true, force: true })
    },
    async assertConnected(id, expected = true) {
      const list = await win.evaluate(() => window.dbstudio.listConnections())
      assert.equal(list.find((c) => c.id === id)?.connected, expected)
    }
  }
}
