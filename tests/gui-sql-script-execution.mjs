/**
 * SQL 多语句脚本顺序执行与错误中断 GUI 测试
 *
 * 验证：
 * 1. 复合脚本 (INSERT + INSERT + SELECT) 按序执行，最终展示查询结果，状态栏显示执行总数；
 * 2. 含有语法错误的脚本在中途遇到错误时立即中断，后续语句绝不执行；
 * 3. 错误提示明确标出失败语句序号与行号。
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

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-script-exec-'))
const dbPath = join(workDir, 'script.db')
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
  await win.waitForTimeout(2000)
}

try {
  console.log('\n[1] 建立连接')
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', '脚本执行库')
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

  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const conn = rows.find((r) => r.textContent?.includes('脚本执行库'))
    conn?.click()
  })
  await win.waitForTimeout(500)

  console.log('\n[2] 执行复合脚本：按序执行并在最后一条展示查询结果')
  const script1 = [
    "INSERT INTO items VALUES (20, 'seq-1');",
    "INSERT INTO items VALUES (21, 'seq-2');",
    "SELECT COUNT(*) AS total FROM items;"
  ].join('\n')

  await runSql(script1)

  const status1 = await win.$eval('#status-bar', (el) => el.textContent ?? '')
  check('状态栏提示已执行 3 条语句', /3 条语句/.test(status1), status1)

  const countResult = await win.evaluate(() => {
    const pane = document.querySelector('.tab-pane:not([hidden])')
    const cells = pane?.querySelectorAll('.grid-row .grid-cell')
    return cells ? [...cells].map((c) => c.textContent) : []
  })
  check('最终结果展示 COUNT(*) = 3', countResult.some((c) => c === '3'), JSON.stringify(countResult))

  console.log('\n[3] 执行含语法错误的脚本：验证中途报错并立即中断')
  const script2 = [
    "INSERT INTO items VALUES (30, 'ok');",
    "THIS IS A SYNTAX ERROR;",
    "INSERT INTO items VALUES (31, 'should-not-run');"
  ].join('\n')

  await runSql(script2)

  const status2 = await win.$eval('#status-bar', (el) => el.textContent ?? '')
  check('状态栏明确指出第 2/3 条语句失败', /第 2\/3 条语句/.test(status2), status2)
  check('状态栏指出第 2 行', /第 2 行/.test(status2), status2)
  check('状态栏包含具体语法错误原因', /syntax|near|error|失败/i.test(status2), status2)

  // 验证数据库中 30 已插入（前序成功），而 31 绝对未执行（后续阻断）
  const checkRows = await win.evaluate(async () => {
    const api = window.dbstudio
    const conns = await api.listConnections()
    const res = await api.runQuery(`connection:${conns[0].id}`, 'SELECT id, name FROM items ORDER BY id')
    return res.rows.map((r) => r.cells.map((c) => c.text ?? c.value).join('|'))
  })
  check('前序语句 30 已成功执行', checkRows.some((r) => r.includes('30|ok')), JSON.stringify(checkRows))
  check('后续语句 31 被阻断，未被执行', !checkRows.some((r) => r.includes('31')), JSON.stringify(checkRows))

  // 回滚事务
  await win.evaluate(async () => {
    const api = window.dbstudio
    const conns = await api?.listConnections()
    if (conns?.[0]) await api.rollbackTransaction(`connection:${conns[0].id}`).catch(() => undefined)
  })
  await win.waitForTimeout(300)

} finally {
  await app.close()
}

console.log(`\n===== 多语句脚本执行 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
