/**
 * SQL 工作台多形态结果面板 (Affected 卡片 / DDL 摘要 / Rows 网格) GUI 测试
 *
 * 验证：
 * 1. 执行 UPDATE DML：渲染 .statement-summary-pane，包含“影响 1 行”与耗时；
 * 2. 执行 CREATE TABLE DDL：渲染 .statement-summary-pane，包含 DDL 摘要“CREATE TABLE tab_new 已完成”；
 * 3. 执行 SELECT 查询：渲染 .grid-panel 表格。
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

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-workbench-results-'))
const dbPath = join(workDir, 'workbench.db')
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

async function runSql(sql) {
  await win.click('.sql-editor-input')
  await win.fill('.sql-editor-input', sql)
  await win.waitForTimeout(300)
  await win.keyboard.press('Control+Shift+Enter')
  await win.waitForTimeout(1500)
}

try {
  console.log('\n[1] 建立连接')
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', '结果形态库')
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

  // 选中连接行以确立当前连接上下文
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const conn = rows.find((r) => r.textContent?.includes('结果形态库'))
    conn?.click()
  })
  await win.waitForTimeout(500)

  console.log('\n[2] 执行 UPDATE: 呈现 Affected 卡片')
  await runSql("UPDATE items SET name = 'updated' WHERE id = 1;")

  const updatePane = await win.evaluate(() => {
    const pane = document.querySelector('.tab-pane:not([hidden])')
    const summary = pane?.querySelector('.statement-summary-pane')
    const text = summary?.textContent ?? ''
    const hasGrid = pane?.querySelector('.tab-grid-root .grid-row') !== null
    return { hasSummary: !!summary, text, hasGrid }
  })
  check('当前标签页呈现 .statement-summary-pane', updatePane.hasSummary)
  check('卡片包含“影响 1 行”', updatePane.text.includes('影响 1 行'), updatePane.text)
  check('卡片包含耗时文本', /耗时|\d+ms/i.test(updatePane.text), updatePane.text)
  check('非空表格展示', !updatePane.hasGrid)

  console.log('\n[3] 执行 CREATE TABLE: 呈现 DDL 摘要卡片')
  await runSql('CREATE TABLE tab_new(val TEXT);')

  const ddlPane = await win.evaluate(() => {
    const pane = document.querySelector('.tab-pane:not([hidden])')
    const summary = pane?.querySelector('.statement-summary-pane')
    const text = summary?.textContent ?? ''
    return { hasSummary: !!summary, text }
  })
  check('DDL 执行呈现 .statement-summary-pane', ddlPane.hasSummary)
  check('包含 DDL 摘要“CREATE TABLE tab_new 已完成”', ddlPane.text.includes('CREATE TABLE tab_new') && ddlPane.text.includes('已完成'), ddlPane.text)

  console.log('\n[4] 执行 SELECT: 呈现 .grid-panel 表格')
  await runSql('SELECT * FROM items;')

  const selectPane = await win.evaluate(() => {
    const pane = document.querySelector('.tab-pane:not([hidden])')
    const gridPanel = pane?.querySelector('.grid-panel')
    const rows = [...(pane?.querySelectorAll('.grid-row') ?? [])].map((r) =>
      [...r.querySelectorAll('.grid-cell')].map((c) => c.textContent).join('|')
    )
    return { hasGridPanel: !!gridPanel, rows }
  })
  check('SELECT 查询呈现 .grid-panel 表格', selectPane.hasGridPanel)
  check('表格展示查询行数据（含 updated）', selectPane.rows.some((r) => r.includes('updated')), JSON.stringify(selectPane.rows))

  // 回滚未提交事务，避免退出守卫弹框拦截 app.close
  await win.evaluate(async () => {
    const api = window.dbstudio
    const conns = await api?.listConnections()
    if (conns?.[0]) await api.rollbackTransaction(`connection:${conns[0].id}`).catch(() => undefined)
  })
  await win.waitForTimeout(300)

} finally {
  await app.close()
}

console.log(`\n===== 工作台结果形态 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
