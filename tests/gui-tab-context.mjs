/**
 * 多标签上下文的真实 GUI 测试。
 *
 * 背景：早先渲染进程把「当前结果集」存在一组全局变量里（activeGrid /
 * activeTableRef / activeSql）。切标签时这些变量容易跟可见标签脱节，
 * 于是出现「导出导出了另一个标签的数据」「筛选把 A 表的条件用在 B 表上」
 * 这类静默错误——界面上看不出区别，只有数据对不上时才暴露。
 *
 * 本测试钉住三件事：
 *   1. 切换标签后，导出的是**当前可见标签**的数据；
 *   2. 切换标签后，筛选走的是**当前可见标签**的来源；
 *   3. 每个标签各自保留自己的筛选草稿，不互相污染。
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

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-tabctx-'))
const dbPath = join(workDir, 'tabctx.db')
{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE alpha (id INTEGER PRIMARY KEY, tag TEXT NOT NULL);
    CREATE TABLE beta (id INTEGER PRIMARY KEY, tag TEXT NOT NULL);
    INSERT INTO alpha (id, tag) VALUES (1, 'alpha-one'), (2, 'alpha-two');
    INSERT INTO beta (id, tag) VALUES (1, 'beta-one'), (2, 'beta-two');
  `)
  db.close()
}

const userDataDir = join(workDir, 'userdata')
mkdirSync(userDataDir, { recursive: true })
const shotDir = join(root, 'out/gui-tab-context')
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

async function createConnection(name) {
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', name)
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
}

/** 在当前可见标签里执行一条 SQL（会新开标签）。 */
async function runSql(sql) {
  await win.fill('.sql-editor-input', sql)
  await win.keyboard.press('Control+Enter')
  await win.waitForTimeout(1200)
}

/** 当前可见标签的标题。 */
const activeTabTitle = () =>
  win.evaluate(() => {
    const chip = document.querySelector('#result-tabs-scroll .tab-chip.is-active')
    return chip?.querySelector('.tab-chip-label')?.textContent ?? ''
  })

const visibleCellTexts = () =>
  win.evaluate(() => {
    const pane = document.querySelector('.tab-pane:not([hidden])')
    if (!pane) return []
    const row = pane.querySelector('.grid-row')
    return row ? [...row.querySelectorAll('.grid-cell')].map((c) => c.textContent) : []
  })

try {
  console.log('\n[1] 建连接并打开两个结果标签')
  await createConnection('上下文测试库')

  await runSql('SELECT id, tag FROM alpha ORDER BY id')
  await runSql('SELECT id, tag FROM beta ORDER BY id')

  const tabCount = await win.evaluate(
    () => document.querySelectorAll('#result-tabs-scroll .tab-chip').length
  )
  check('两个 SQL 标签都已打开', tabCount === 2, `实际 ${tabCount}`)

  const betaCells = await visibleCellTexts()
  check('当前可见标签显示 beta 的数据', betaCells.includes('beta-one'), betaCells.join(' | '))
  await win.screenshot({ path: join(shotDir, '01-两个标签.png') })

  console.log('\n[2] 切回第一个标签，导出必须跟着切换')
  // 点第一个标签的标题（不是关闭按钮）。
  await win.evaluate(() => {
    const chip = document.querySelectorAll('#result-tabs-scroll .tab-chip')[0]
    chip?.querySelector('.tab-chip-label')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(400)

  const alphaCells = await visibleCellTexts()
  check('切回后可见标签显示 alpha 的数据', alphaCells.includes('alpha-one'), alphaCells.join(' | '))
  check('切回后不再显示 beta 的数据', !alphaCells.includes('beta-one'), alphaCells.join(' | '))

  // 导出当前已加载行。格式选 CSV，内容好断言。
  resetDownloads()
  await win.selectOption('#btn-export-format', 'csv')
  await win.waitForTimeout(1200)

  check('导出产生了一个下载', downloads.length === 1, `实际 ${downloads.length}`)
  const csv = downloads[0]?.text ?? ''
  check('★ 导出内容来自当前可见标签（alpha）', csv.includes('alpha-one'), csv.slice(0, 200))
  check('★ 导出内容不含另一个标签（beta）的数据', !csv.includes('beta-one'), csv.slice(0, 200))
  await win.screenshot({ path: join(shotDir, '02-导出跟随标签.png') })

  console.log('\n[3] 筛选必须作用在当前可见标签的来源上')
  // 在 alpha 标签上开筛选条，输入条件。
  await win.click('#btn-filter-toggle')
  await win.waitForTimeout(200)
  await win.fill('#filter-input', "tag = 'alpha-two'")
  await win.click('#btn-filter-apply')
  await win.waitForTimeout(1500)

  const filterStatus = await win.$eval('#status-bar', (e) => e.textContent ?? '')
  check('筛选成功且有明确提示', filterStatus.includes('筛选'), filterStatus)

  const afterFilterCells = await visibleCellTexts()
  check(
    '筛选结果只含 alpha-two',
    afterFilterCells.includes('alpha-two') && !afterFilterCells.includes('alpha-one'),
    afterFilterCells.join(' | ')
  )
  check('筛选结果不含 beta 的数据', !afterFilterCells.includes('beta-one'), afterFilterCells.join(' | '))

  const tabCountAfterFilter = await win.evaluate(
    () => document.querySelectorAll('#result-tabs-scroll .tab-chip').length
  )
  check('筛选是重新查询，新开一个标签', tabCountAfterFilter === 3, `实际 ${tabCountAfterFilter}`)

  console.log('\n[4] 各标签的筛选草稿互不污染')
  // 先看第二个（beta）标签：它从没开过筛选条，草稿必须是空的、筛选条必须是收起的。
  // 如果这里也出现 alpha 的条件，就说明状态存在了全局变量里而不是按标签隔离。
  await win.evaluate(() => {
    const chip = document.querySelectorAll('#result-tabs-scroll .tab-chip')[1]
    chip?.querySelector('.tab-chip-label')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(400)
  const betaTabFilter = await win.evaluate(() => {
    const input = document.getElementById('filter-input')
    const bar = document.getElementById('filter-bar')
    return { value: input?.value ?? '', hidden: bar?.hasAttribute('hidden') ?? true }
  })
  check(
    '★ 从未开过筛选的标签不受污染',
    betaTabFilter.value === '' && betaTabFilter.hidden,
    JSON.stringify(betaTabFilter)
  )

  // 再切回第一个（alpha）标签：它自己的草稿（用户输入的条件）必须还在。
  await win.evaluate(() => {
    const chip = document.querySelectorAll('#result-tabs-scroll .tab-chip')[0]
    chip?.querySelector('.tab-chip-label')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(400)
  const firstTabFilter = await win.evaluate(() => {
    const input = document.getElementById('filter-input')
    const bar = document.getElementById('filter-bar')
    return { value: input?.value ?? '', hidden: bar?.hasAttribute('hidden') ?? true }
  })
  check(
    '★ 切回第一个标签时它自己的筛选草稿还在',
    firstTabFilter.value === "tag = 'alpha-two'" && !firstTabFilter.hidden,
    JSON.stringify(firstTabFilter)
  )

  // 切到筛选产生的第三个标签（它继承 alpha 的来源并带上条件）。
  await win.evaluate(() => {
    const chips = document.querySelectorAll('#result-tabs-scroll .tab-chip')
    const chip = chips[chips.length - 1]
    chip?.querySelector('.tab-chip-label')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(400)
  const thirdTabFilter = await win.evaluate(() => {
    const input = document.getElementById('filter-input')
    const bar = document.getElementById('filter-bar')
    return { value: input?.value ?? '', hidden: bar?.hasAttribute('hidden') ?? true }
  })
  check(
    '筛选标签保留自己的筛选条件',
    thirdTabFilter.value === "tag = 'alpha-two'" && !thirdTabFilter.hidden,
    JSON.stringify(thirdTabFilter)
  )
  await win.screenshot({ path: join(shotDir, '03-筛选草稿.png') })

  console.log('\n[5] 关闭一个标签后，导出仍然跟随新的当前标签')
  await win.evaluate(() => {
    const chips = document.querySelectorAll('#result-tabs-scroll .tab-chip')
    const chip = chips[chips.length - 1]
    chip?.querySelector('.tab-chip-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await win.waitForTimeout(800)

  const remaining = await win.evaluate(
    () => document.querySelectorAll('#result-tabs-scroll .tab-chip').length
  )
  check('标签已关闭', remaining === 2, `实际 ${remaining}`)

  resetDownloads()
  await win.selectOption('#btn-export-format', 'csv')
  await win.waitForTimeout(1200)
  const csvAfterClose = downloads[0]?.text ?? ''
  check(
    '关闭后导出的是当前可见标签的数据',
    csvAfterClose.length > 0 && !csvAfterClose.includes('alpha-two'),
    csvAfterClose.slice(0, 200)
  )
} finally {
  await app.close().catch(() => {})
}

console.log(`\n===== 多标签上下文 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exit(1)
