/**
 * SQL 工作台按连接草稿持久化与恢复 GUI 测试
 *
 * 验证：
 * 1. 在连接 1 输入 SQL 草稿；
 * 2. 切换到连接 2 输入另一段 SQL 草稿；
 * 3. 切回连接 1，SQL 编辑器自动恢复为连接 1 的草稿；
 * 4. 切回连接 2，SQL 编辑器自动恢复为连接 2 的草稿。
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

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-draft-test-'))
const dbPath1 = join(workDir, 'draft1.db')
const dbPath2 = join(workDir, 'draft2.db')
{
  new DatabaseSync(dbPath1).close()
  new DatabaseSync(dbPath2).close()
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

async function addConnection(name, file) {
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', name)
  await win.fill('#f-dynamic input[data-key="file"]', file)
  await win.click('#btn-submit')
  await win.waitForFunction(
    () => {
      const d = document.getElementById('dlg-connection')
      return d !== null && !d.hasAttribute('open')
    },
    { timeout: 20000 }
  )
  await win.waitForTimeout(600)
}

async function selectConnection(name) {
  await win.evaluate((n) => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const conn = rows.find((r) => r.textContent?.includes(n))
    conn?.click()
  }, name)
  await win.waitForTimeout(400)
}

try {
  console.log('\n[1] 建立两个测试连接')
  await addConnection('草稿库1', dbPath1)
  await addConnection('草稿库2', dbPath2)

  console.log('\n[2] 在连接 1 输入草稿')
  await selectConnection('草稿库1')
  await win.click('.sql-editor-input')
  await win.fill('.sql-editor-input', "SELECT 'draft-1'")
  await win.waitForTimeout(300)

  console.log('\n[3] 切换到连接 2 并输入草稿')
  await selectConnection('草稿库2')
  await win.click('.sql-editor-input')
  await win.fill('.sql-editor-input', "SELECT 'draft-2'")
  await win.waitForTimeout(300)

  console.log('\n[4] 切回连接 1 验证草稿恢复')
  await selectConnection('草稿库1')
  const draft1 = await win.$eval('.sql-editor-input', (el) => el.value)
  check('切回连接 1 恢复草稿 1', draft1 === "SELECT 'draft-1'", draft1)

  console.log('\n[5] 切回连接 2 验证草稿恢复')
  await selectConnection('草稿库2')
  const draft2 = await win.$eval('.sql-editor-input', (el) => el.value)
  check('切回连接 2 恢复草稿 2', draft2 === "SELECT 'draft-2'", draft2)

} finally {
  await app.close()
}

console.log(`\n===== SQL 草稿恢复 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
