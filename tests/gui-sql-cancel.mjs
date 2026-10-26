/**
 * SQL 工作台参数面板与取消状态 GUI 测试。
 *
 * SQLite 使用同步驱动，查询执行期间不能中断；工作台仍必须显示取消按钮，
 * 明确说明限制，并锁住执行按钮避免同一条 SQL 被重复提交。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pw = await import(pathToFileURL(require.resolve('playwright-core', { paths: [root] })).href)
const electron = pw._electron ?? pw.default?._electron
const pgOnly = process.argv.includes('--pg-only')
const sqliteOnly = process.argv.includes('--sqlite-only')

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

const work = mkdtempSync(join(tmpdir(), 'dbstudio-gui-sql-cancel-'))
const dbPath = join(work, 'cancel.db')
{
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES (1, \'one\');')
  db.close()
}
const userDataDir = join(work, 'userdata')
mkdirSync(userDataDir, { recursive: true })

const env = { ...process.env, DBSTUDIO_TEST_HIDDEN: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', `--user-data-dir=${userDataDir}`, ...(process.platform === 'linux' && env.ELECTRON_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : [])],
  cwd: root,
  env
})
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0].webContents.session.on('will-download', (event) => event.preventDefault())
})
const win = await app.firstWindow()
win.on('dialog', (dialog) => void dialog.accept())

try {
  await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })
  if (!pgOnly) {
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', 'SQL 取消测试')
  await win.fill('#f-dynamic input[data-key="file"]', dbPath)
  await win.click('#btn-submit')
  await win.waitForFunction(
    () => {
      const dialog = document.getElementById('dlg-connection')
      return dialog !== null && !dialog.hasAttribute('open')
    },
    { timeout: 20000 }
  )
  await win.waitForTimeout(600)

  console.log('\n[1] SQL 参数面板')
  await win.fill('.sql-editor-input', 'SELECT ? + 1 AS answer')
  await win.waitForTimeout(200)
  const parameterUi = await win.evaluate(() => ({
    visible: getComputedStyle(document.querySelector('.sql-editor-parameters')).display !== 'none',
    rows: document.querySelectorAll('.sql-editor-parameter-row').length,
    name: document.querySelector('.sql-editor-parameter-row > span')?.textContent ?? ''
  }))
  check('参数占位符显示参数面板', parameterUi.visible, JSON.stringify(parameterUi))
  check('匿名参数显示为稳定名称', parameterUi.rows === 1 && parameterUi.name === '?1', JSON.stringify(parameterUi))

  await win.fill('.sql-editor-parameter-value', '2')
  await win.evaluate(() => {
    const button = [...document.querySelectorAll('.sql-editor-btn')].find((item) => item.textContent?.includes('执行当前'))
    button?.click()
  })
  await win.waitForTimeout(1500)
  const answer = await win.evaluate(() => {
    const pane = document.querySelector('.tab-pane:not([hidden])')
    return [...(pane?.querySelectorAll('.grid-row .grid-cell') ?? [])].map((cell) => cell.textContent ?? '')
  })
  check('参数面板值通过绑定参数执行', answer.includes('3'), JSON.stringify(answer))

  await win.locator('.tab-pane:not([hidden]) .grid-col-header').first().click()
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('已按「'))
  check('参数结果排序重查保留绑定值', (await win.locator('.tab-pane:not([hidden]) .grid-row .grid-cell').allTextContents()).includes('3'))
  await win.click('#btn-filter-toggle')
  await win.fill('#filter-input', 'answer >= 3')
  await win.click('#btn-filter-apply')
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('已按筛选重新查询'))
  check('参数结果筛选重查保留绑定值', (await win.locator('.tab-pane:not([hidden]) .grid-row .grid-cell').allTextContents()).includes('3'))
  await win.click('#btn-export-all')
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('已导出'))
  check('参数结果导出重查成功', !(await win.locator('#status-bar').textContent()).includes('失败'))

  await win.fill('.sql-editor-input', 'SELECT ? AS first; SELECT ? AS second')
  await win.fill('.sql-editor-parameter-value[data-parameter-name="?1"]', 'alpha')
  await win.fill('.sql-editor-parameter-value[data-parameter-name="?2"]', 'beta')
  await win.getByRole('button', { name: '执行全部', exact: true }).click()
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('已执行 2 条语句'))
  check('脚本匿名参数按整段出现顺序绑定', (await win.locator('.tab-pane:not([hidden]) .grid-row .grid-cell').allTextContents()).includes('beta'))

  console.log('\n[2] SQLite SQL 工作台取消状态')
  await win.fill(
    '.sql-editor-input',
    'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 5000000) SELECT count(*) AS total FROM c'
  )
  await win.evaluate(() => {
    const button = [...document.querySelectorAll('.sql-editor-btn')].find((item) => item.textContent?.includes('执行当前'))
    button?.click()
  })
  await win.waitForTimeout(120)
  const running = await win.evaluate(() => {
    const buttons = [...document.querySelectorAll('.sql-editor-btn')]
    const cancel = buttons.find((button) => button.textContent?.trim() === '取消执行')
    const execute = buttons.find((button) => button.textContent?.includes('执行当前'))
    return {
      cancel: cancel ? { disabled: cancel.disabled, title: cancel.title } : null,
      executeDisabled: execute?.disabled ?? false,
      status: document.getElementById('status-bar')?.textContent ?? ''
    }
  })
  check('SQL 工作台有取消执行按钮', running.cancel !== null, JSON.stringify(running))
  check('SQLite 取消按钮说明同步查询不可中断', running.cancel?.disabled === true && /SQLite|同步|中断/.test(running.cancel.title), JSON.stringify(running))
  check('执行期间锁住重复提交按钮', running.executeDisabled === true, JSON.stringify(running))

  await win.waitForFunction(
    () => [...document.querySelectorAll('.sql-editor-btn')].some(
      (button) => button.textContent?.includes('执行当前') && !button.disabled
    ),
    { timeout: 30000 }
  )
  const after = await win.$eval('#status-bar', (element) => element.textContent ?? '')
  check('SQLite 慢查询完成后工作台恢复可执行', /已返回|执行成功|查询/.test(after), after)
  }
  if (!sqliteOnly && process.env.DBSTUDIO_PG_URL) {
    console.log('\n[3] PostgreSQL 参数与真实取消')
    const url = new URL(process.env.DBSTUDIO_PG_URL)
    const config = { dialectId: 'postgresql', name: 'PG SQL cancel', options: {
      host: url.hostname, port: url.port || '5432', user: decodeURIComponent(url.username || 'postgres'),
      database: decodeURIComponent(url.pathname.slice(1) || 'postgres'), sslmode: 'disable'
    } }
    const summary = await win.evaluate(({ config, password }) => window.dbstudio.addConnection(config, password),
      { config, password: url.password ? decodeURIComponent(url.password) : undefined })
    if (!summary.connected) throw new Error('BLOCKED_BY_SETUP: PostgreSQL GUI connection failed')
    await win.click('#btn-refresh')
    await win.locator('#tree-rows .tree-row').filter({ hasText: config.name }).click()
    const pgNode = `connection:${summary.id}`
    await win.fill('.sql-editor-input', 'SELECT $1::int + 1 AS answer')
    await win.locator('.sql-editor-parameter-value[data-parameter-name="$1"]').waitFor()
    await win.fill('.sql-editor-parameter-value', '6')
    await win.getByRole('button', { name: '执行全部', exact: true }).click()
    await win.waitForFunction(() => document.querySelector('.sql-editor')?.getAttribute('aria-busy') === 'false')
    check('PostgreSQL GUI 绑定 $1 参数', (await win.locator('.tab-pane:not([hidden]) .grid-row .grid-cell').allTextContents()).includes('7'))

    await win.evaluate(nodeId => window.dbstudio.executeStatement(nodeId, 'CREATE TEMP SEQUENCE dbstudio_p13_seq'), pgNode)
    await win.fill('.sql-editor-input', "SELECT nextval('dbstudio_p13_seq') AS n")
    await win.getByRole('button', { name: '执行全部', exact: true }).click()
    await win.waitForFunction(() => document.querySelector('.sql-editor')?.getAttribute('aria-busy') === 'false')
    const current = await win.evaluate(nodeId => window.dbstudio.runQuery(nodeId,
      "SELECT currval('dbstudio_p13_seq') AS n", { keepCursor: false }), pgNode)
    check('SQL 工作台查询只执行一次', (current.rows[0].cells[0].text ?? current.rows[0].cells[0].value) == 1, JSON.stringify(current))

    const other = await win.evaluate(file => window.dbstudio.addConnection({
      dialectId: 'sqlite', name: '取消期间切换目标', options: { file }
    }), dbPath)
    if (!other.connected) throw new Error('BLOCKED_BY_SETUP: second GUI connection failed')
    await win.click('#btn-refresh')
    await win.fill('.sql-editor-input', 'SELECT pg_sleep(10); SELECT 99 AS must_not_run')
    const started = Date.now()
    await win.getByRole('button', { name: '执行全部', exact: true }).click()
    await win.waitForFunction(() => document.querySelector('.sql-editor')?.getAttribute('aria-busy') === 'true')
    const { Client } = await import('pg')
    const observer = new Client({ connectionString: process.env.DBSTUDIO_PG_URL })
    await observer.connect()
    try {
      let running = false
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const status = await observer.query("SELECT 1 FROM pg_stat_activity WHERE application_name = 'dbstudio' AND state = 'active' AND query LIKE '%pg_sleep(10)%'")
        if (status.rowCount > 0) { running = true; break }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      check('PostgreSQL 后端正在执行慢查询', running)
      await win.locator('#tree-rows .tree-row').filter({ hasText: '取消期间切换目标' }).click()
      const cancel = win.getByRole('button', { name: '取消执行', exact: true })
      check('切换到 SQLite 后取消仍指向原 PostgreSQL 执行', await cancel.isEnabled())
      await cancel.click()
      await win.waitForFunction(() => document.querySelector('.sql-editor')?.getAttribute('aria-busy') === 'false', null, { timeout: 4000 })
      const status = await win.locator('#status-bar').textContent()
      check('PostgreSQL 慢查询被真正中断', /cancel/i.test(status), status)
      check('取消未等待慢查询自然完成', Date.now() - started < 6000)
      const library = await win.evaluate(() => window.dbstudio.listSqlLibrary())
      check('取消后不执行脚本下一条语句', !library.history.some(entry => entry.sql.includes('must_not_run')))
      const recovered = await win.evaluate(nodeId => window.dbstudio.runQuery(nodeId, 'SELECT 1', { keepCursor: false }), pgNode)
      check('取消后 PostgreSQL 连接仍可用', recovered.rows[0].cells[0].value === 1)
    } finally { await observer.end() }
  } else if (!sqliteOnly) {
    console.log('SKIP PostgreSQL SQL cancel GUI: 未配置 DBSTUDIO_PG_URL')
  }

} finally {
  await app.close()
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n===== SQL 工作台取消 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
