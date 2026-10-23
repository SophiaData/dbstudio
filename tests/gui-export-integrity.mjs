/**
 * 导出完整性的真实 GUI 测试。
 *
 * 问题背景：结果集里的长文本 / BLOB 只加载**预览**（前 N 字符），单元格上带
 * `truncated` 标记。早先的导出直接把预览当完整值写进文件——用户导出后发现
 * 数据被截断，且界面上还显示「已导出 N 行」，看起来一切成功。
 *
 * 正确行为：**明确拒绝导出**并说明原因，而不是产出一个静默残缺的文件。
 * 本测试用真实的长文本数据验证这条拒绝路径。
 */
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { installDownloadCapture, downloads, resetDownloads } from './helpers/download-capture.mjs'

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

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-export-'))
const dbPath = join(workDir, 'export.db')
const LONG = 'X'.repeat(3000)
{
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT);')
  db.prepare('INSERT INTO docs (id, body) VALUES (?, ?)').run(1, LONG)
  db.prepare('INSERT INTO docs (id, body) VALUES (?, ?)').run(2, 'short-body')
  db.close()
}

const userDataDir = join(workDir, 'userdata')
mkdirSync(userDataDir, { recursive: true })
const shotDir = join(root, 'out/gui-export-integrity')
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

await installDownloadCapture(win)

try {
  console.log('\n[1] 建连接并打开含长文本的表')
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', '导出完整性库')
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

  await win.fill('.sql-editor-input', 'SELECT id, body FROM docs ORDER BY id')
  await win.keyboard.press('Control+Enter')
  await win.waitForTimeout(1500)

  const rendered = await win.evaluate(() => {
    const pane = document.querySelector('.tab-pane:not([hidden])')
    const rows = pane ? pane.querySelectorAll('.grid-row').length : 0
    return { rows }
  })
  check('结果集已渲染', rendered.rows >= 2, JSON.stringify(rendered))
  await win.screenshot({ path: join(shotDir, '01-长文本.png') })

  console.log('\n[2] 导出必须拒绝，而不是产出残缺文件')
  resetDownloads()
  await win.selectOption('#btn-export-format', 'csv')
  await win.waitForTimeout(1500)

  const status = await win.$eval('#status-bar', (e) => e.textContent ?? '')
  check('状态栏提示导出失败', status.includes('导出失败'), status)
  check('★ 失败原因提到「截断」', status.includes('截断'), status)
  check('★ 没有产出下载文件', downloads.length === 0, `实际 ${downloads.length}`)
  await win.screenshot({ path: join(shotDir, '02-拒绝导出.png') })

  console.log('\n[3] 网格自带的「导出 CSV」按钮同样受保护')
  // 早先 grid 里还有一个 CSV 按钮，走的是另一条路径。两条路径都必须拦得住。
  const legacyBlocked = await win.evaluate(() => {
    const btn = [...document.querySelectorAll('.tab-pane:not([hidden]) .grid-toolbar button')].find(
      (b) => b.textContent?.startsWith('导出 CSV')
    )
    if (!btn) return 'missing'
    btn.click()
    return 'clicked'
  })
  check('找到网格内的导出按钮', legacyBlocked === 'clicked', legacyBlocked)
  await win.waitForTimeout(1200)

  const legacyStatus = await win.$eval('#status-bar', (e) => e.textContent ?? '')
  check('★ 网格内按钮也拒绝导出', legacyStatus.includes('导出失败'), legacyStatus)
  check('★ 网格内按钮也没有产出文件', downloads.length === 0, `实际 ${downloads.length}`)

  console.log('\n[4] 「导出全部」同样拒绝')
  const exportAllClicked = await win.evaluate(() => {
    const btn = document.getElementById('btn-export-all')
    if (!btn || btn.disabled) return false
    btn.click()
    return true
  })
  check('「导出全部」按钮可点', exportAllClicked)
  await win.waitForTimeout(2000)

  const exportAllStatus = await win.$eval('#status-bar', (e) => e.textContent ?? '')
  check(
    '★ 「导出全部」拒绝导出',
    exportAllStatus.includes('导出全部失败') && exportAllStatus.includes('截断'),
    exportAllStatus
  )
  check('★ 「导出全部」也没有产出文件', downloads.length === 0, `实际 ${downloads.length}`)

  console.log('\n[5] 无截断的表可以正常导出')
  await win.fill('.sql-editor-input', 'SELECT id FROM docs WHERE id = 2')
  await win.keyboard.press('Control+Enter')
  await win.waitForTimeout(1500)

  resetDownloads()
  await win.selectOption('#btn-export-format', 'csv')
  await win.waitForTimeout(1500)

  const okStatus = await win.$eval('#status-bar', (e) => e.textContent ?? '')
  check('干净数据导出成功', okStatus.includes('已导出'), okStatus)
  check('产出了下载文件', downloads.length === 1, `实际 ${downloads.length}`)
  const csv = downloads[0]?.text ?? ''
  check('导出内容含该行', csv.includes('2'), csv.slice(0, 120))
  await win.screenshot({ path: join(shotDir, '03-正常导出.png') })
} finally {
  await app.close().catch(() => {})
}

console.log(`\n===== 导出完整性 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exit(1)
