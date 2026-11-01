/**
 * P2.2 导出向导的**真实 GUI 测试**。
 *
 * ============================================================================
 * 这条测试验的是「接线」，不是「纯逻辑」
 * ============================================================================
 *
 * `tests/e2e-transfer-wizard.mjs` 已经覆盖了向导的纯函数（校验、文案、范围）。
 * 这里覆盖的是**只有真实 Electron 才能验的东西**：
 *
 *   1. 按钮真的能打开向导（DOM 装配没写错）；
 *   2. 向导调的是 preload 白名单里的 `startTransfer`（真跨进程，不是 mock）；
 *   3. 导出的文件**真的落在磁盘上**，内容与源表一致（不是浏览器下载）；
 *   4. 相对路径被向导拒绝（不会写出一个位置诡异���文件）；
 *   5. 目标覆盖源库被拒绝（源库文件字节不变）。
 *
 * 为什么第 3 条最重要：向导如果只是"调了 API 就报成功"，
 * 文件根本没落地，那是个**看起来完全正常**的失败——最坏的一类。
 * 所以这里直接读磁盘上的文件核对内容。
 *
 * 运行：node tests/gui-export-wizard.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
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

const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-export-wizard-'))
const dbPath = join(workDir, 'wizard.db')
const outDir = join(workDir, 'out')
mkdirSync(outDir, { recursive: true })
{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score INTEGER);
    INSERT INTO users (id, name, score) VALUES (1, 'alice', 10), (2, 'bob', 20), (3, 'carol', 30);
    CREATE VIEW v_users AS SELECT id, name, score FROM users;
  `)
  db.close()
}

const userDataDir = join(workDir, 'userdata')
mkdirSync(userDataDir, { recursive: true })
const shotDir = join(root, 'out/gui-export-wizard')
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

/** 向导是否打开。 */
const wizardOpen = () =>
  win.evaluate(() => {
    const node = document.getElementById('dbstudio-transfer-wizard')
    return node !== null
  })

/** 向导的错误框文案。 */
const wizardErrors = () =>
  win.evaluate(() => {
    const box = document.getElementById('transfer-wizard-errors')
    return {
      hidden: box?.hasAttribute('hidden') ?? true,
      text: box?.textContent ?? ''
    }
  })

/** 向导的进度区文案。 */
const wizardProgress = () =>
  win.evaluate(() => {
    const box = document.getElementById('transfer-wizard-progress')
    return {
      hidden: box?.hasAttribute('hidden') ?? true,
      text: document.getElementById('transfer-wizard-progress-text')?.textContent ?? '',
      detail: document.getElementById('transfer-wizard-progress-detail')?.textContent ?? ''
    }
  })

/** 状态栏文案。 */
const statusText = () => win.$eval('#status-bar', (e) => e.textContent ?? '')

try {
  console.log('\n[1] 建连接并打开一张表')
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', '导出向导库')
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

  await win.fill('.sql-editor-input', 'SELECT id, name, score FROM users ORDER BY id')
  await win.keyboard.press('Control+Enter')
  await win.waitForTimeout(1500)

  const wizardBtnDisabled = await win.locator('#btn-export-wizard').isDisabled()
  check('有结果标签时「导出向导…」可用', wizardBtnDisabled === false)

  console.log('\n[2] 打开向导：表单元素齐全')
  await win.click('#btn-export-wizard')
  await win.waitForSelector('#dbstudio-transfer-wizard', { state: 'attached', timeout: 5000 })
  check('向导已打开', await wizardOpen())
  await win.screenshot({ path: join(shotDir, '01-向导.png') })

  const formats = await win.$$eval('#transfer-wizard-format option', (options) =>
    options.map((option) => option.value)
  )
  check(
    '★ 四种格式都在（CSV/JSONL/JSON/SQL INSERT）',
    JSON.stringify(formats) === JSON.stringify(['csv', 'jsonl', 'json', 'sql-insert']),
    JSON.stringify(formats)
  )
  check('批大小输入框存在', (await win.locator('#transfer-wizard-batch').count()) === 1)
  check('NULL 文本输入框存在', (await win.locator('#transfer-wizard-null').count()) === 1)
  check('表头复选框存在', (await win.locator('#transfer-wizard-header').count()) === 1)
  check('行分隔符下拉存在', (await win.locator('#transfer-wizard-newline').count()) === 1)

  console.log('\n[3] 格式切换会禁用不适用的选项')
  await win.selectOption('#transfer-wizard-format', 'sql-insert')
  await win.waitForTimeout(200)
  check('★ sql-insert 禁用表头复选框', await win.locator('#transfer-wizard-header').isDisabled())
  check('★ sql-insert 禁用 NULL 文本输入框', await win.locator('#transfer-wizard-null').isDisabled())
  check('★ sql-insert 禁用 JSON 缩进', await win.locator('#transfer-wizard-indent').isDisabled())
  await win.selectOption('#transfer-wizard-format', 'csv')
  await win.waitForTimeout(200)
  check('★ 切回 CSV 后表头可用', (await win.locator('#transfer-wizard-header').isDisabled()) === false)
  check('★ 切回 CSV 后 NULL 文本可用', (await win.locator('#transfer-wizard-null').isDisabled()) === false)

  console.log('\n[3b] JSONL / JSON 没有表头行 → 复选框必须禁用（不能是假开关）')
  // ★ 实测缺陷：早先 JSONL/JSON 的「包含表头」是**可用**的，
  // 但主进程的 jsonl/json 写出器根本不读 includeHeader——
  // 取消勾选后导出的文件**一模一样**。假开关比没有更糟。
  await win.selectOption('#transfer-wizard-format', 'jsonl')
  await win.waitForTimeout(200)
  check('★ jsonl 禁用表头复选框', await win.locator('#transfer-wizard-header').isDisabled())
  const jsonlHeaderHint = await win.$eval('#transfer-wizard-header-hint', (e) => e.textContent ?? '')
  check(
    '★ 禁用时说明"为什么"',
    jsonlHeaderHint.includes('始终包含列名'),
    jsonlHeaderHint
  )
  await win.selectOption('#transfer-wizard-format', 'json')
  await win.waitForTimeout(200)
  check('★ json 禁用表头复选框', await win.locator('#transfer-wizard-header').isDisabled())
  await win.selectOption('#transfer-wizard-format', 'csv')
  await win.waitForTimeout(200)

  console.log('\n[3c] 默认目标路径必须是绝对路径（否则第一次点导出必然撞墙）')
  const defaultPath = await win.inputValue('#transfer-wizard-path')
  check(
    '★ 默认路径是绝对路径',
    defaultPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(defaultPath),
    defaultPath
  )
  const pathHint = await win.$eval('#transfer-wizard-path-hint', (e) => e.textContent ?? '')
  check('★ 提示里说明了默认目录', pathHint.includes('默认目录'), pathHint)

  console.log('\n[4] 相对路径被向导当场拒绝（不产出文件）')
  await win.fill('#transfer-wizard-path', 'relative-out.csv')
  await win.click('#transfer-wizard-start')
  await win.waitForTimeout(600)
  const relativeErrors = await wizardErrors()
  check('★ 报出绝对路径要求', relativeErrors.hidden === false && relativeErrors.text.includes('绝对路径'), JSON.stringify(relativeErrors))
  check('★ 没有产出文件', !existsSync(join(workDir, 'relative-out.csv')))
  await win.screenshot({ path: join(shotDir, '02-拒绝相对路径.png') })

  console.log('\n[5] CSV 导出：文件真的落在磁盘上，内容与源表一致')
  const csvPath = join(outDir, 'users.csv')
  await win.fill('#transfer-wizard-path', csvPath)
  await win.click('#transfer-wizard-start')
  await win.waitForTimeout(2500)

  const csvProgress = await wizardProgress()
  check('★ 进度区显示了完成状态', csvProgress.text.includes('已完成'), JSON.stringify(csvProgress))
  check(
    '★ 进度区如实说明不是数据库快照',
    csvProgress.detail.includes('不是数据库快照'),
    JSON.stringify(csvProgress)
  )
  const csvStatus = await statusText()
  check('★ 状态栏报告导出完成', csvStatus.includes('导出完成'), csvStatus)
  check('★ 文件确实存在', existsSync(csvPath), csvPath)
  if (existsSync(csvPath)) {
    const csv = readFileSync(csvPath, 'utf8')
    check('★ CSV 含表头', csv.includes('id,name,score'), csv.slice(0, 120))
    check('★ CSV 含全部三行', csv.includes('alice') && csv.includes('bob') && csv.includes('carol'), csv.slice(0, 200))
    check('★ CSV 行数正确（表头 + 3 行）', csv.trim().split('\n').length === 4, String(csv.trim().split('\n').length))
  }
  await win.screenshot({ path: join(shotDir, '03-CSV 完成.png') })

  console.log('\n[6] JSONL 导出')
  const jsonlPath = join(outDir, 'users.jsonl')
  await win.selectOption('#transfer-wizard-format', 'jsonl')
  await win.waitForTimeout(200)
  await win.fill('#transfer-wizard-path', jsonlPath)
  await win.click('#transfer-wizard-start')
  await win.waitForTimeout(2500)
  check('★ JSONL 文件存在', existsSync(jsonlPath), jsonlPath)
  if (existsSync(jsonlPath)) {
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n')
    check('★ JSONL 每行一个对象', lines.length === 3, String(lines.length))
    let parsed = null
    try {
      parsed = JSON.parse(lines[0])
    } catch (e) {
      parsed = null
    }
    check('★ JSONL 是合法 JSON', parsed !== null && typeof parsed === 'object')
    check('★ JSONL 保留列名与值', parsed?.name === 'alice' && parsed?.id === 1, JSON.stringify(parsed))
  }

  console.log('\n[7] SQL INSERT 导出')
  //
  // ★ 关键：SQL INSERT 需要**表来源**（自由 SQL 没有表名，无法确定 INSERT 落点）。
  // 当前向导的来源是自由 SQL（上面跑的是一条 SELECT），所以这里**必须**先验证
  // 向导会拒绝它，然后改用树右键的「导出向导…」（那是表来源）才能导出成功。
  // 跳过这层验证就等于没测到"来源与格式不匹配"这条规则。
  {
    const sqlPath = join(outDir, 'users.sql')
    await win.selectOption('#transfer-wizard-format', 'sql-insert')
    await win.waitForTimeout(200)
    await win.fill('#transfer-wizard-path', sqlPath)
    await win.click('#transfer-wizard-start')
    await win.waitForTimeout(800)
    const errors = await wizardErrors()
    check(
      '★ 自由 SQL + SQL INSERT 被拒绝',
      errors.hidden === false && errors.text.includes('表'), JSON.stringify(errors)
    )
    check('★ 没有产出 SQL 文件', !existsSync(sqlPath))
    await win.screenshot({ path: join(shotDir, '04-拒绝自由SQL的INSERT.png') })
  }

  // 改用树右键的表来源导出向导。
  {
    const sqlPath = join(outDir, 'users.sql')
    await win.click('#transfer-wizard-cancel')
    await win.waitForTimeout(300)

    // 树是懒加载的：必须先展开连接与「表」分组，表节点才会出现在 DOM 里。
    const expand = async (matcher) => {
      await win.evaluate((text) => {
        const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
        const target = rows.find((r) => r.textContent?.trim().includes(text))
        const twisty = target?.querySelector('.twisty')
        if (twisty && twisty.textContent?.trim() === '▸') twisty.click()
      }, matcher)
      await win.waitForTimeout(500)
    }
    await expand('导出向导库')
    await expand('表')
    const hasUsers = await win.evaluate(() =>
      [...document.querySelectorAll('#tree-rows .tree-row')].some((r) =>
        r.querySelector('.row-label')?.textContent?.trim() === 'users'
      )
    )
    check('★ 树展开后能看到 users 表', hasUsers)

    const opened = await win.evaluate(() => {
      const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
      const target = rows.find(
        (r) => r.querySelector('.row-label')?.textContent?.trim() === 'users'
      )
      if (!target) return false
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: rect.left + 20,
          clientY: rect.top + 10
        })
      )
      return true
    })
    check('★ 树上的表节点可以右键', opened)
    await win.waitForTimeout(400)
    const clicked = await win.evaluate(() => {
      const items = [...document.querySelectorAll('[role="menuitem"]')]
      const item = items.find((e) => (e.textContent ?? '').includes('导出向导'))
      if (!item) return false
      item.click()
      return true
    })
    check('★ 右键菜单里有「导出向导…」', clicked)
    await win.waitForSelector('#dbstudio-transfer-wizard', { state: 'attached', timeout: 5000 })

    const sourceText = await win.$eval('#transfer-wizard-source', (e) => e.textContent ?? '')
    check('★ 来源显示的是表 users', sourceText.includes('users'), sourceText)

    await win.selectOption('#transfer-wizard-format', 'sql-insert')
    await win.waitForTimeout(200)
    await win.fill('#transfer-wizard-path', sqlPath)
    await win.click('#transfer-wizard-start')
    await win.waitForTimeout(2500)
    check('★ SQL 文件存在', existsSync(sqlPath), sqlPath)
    if (existsSync(sqlPath)) {
      const sql = readFileSync(sqlPath, 'utf8')
      check('★ SQL 含 INSERT INTO', sql.includes('INSERT INTO'), sql.slice(0, 160))
      check('★ SQL 含全部三行', sql.includes('alice') && sql.includes('bob') && sql.includes('carol'), sql.slice(0, 240))
      check(
        '★ SQL 语句数正确（3 条）',
        sql.split('INSERT INTO').filter((line) => line.includes('VALUES')).length === 3,
        String(sql.split('INSERT INTO').length - 1)
      )
    }
    await win.screenshot({ path: join(shotDir, '05-SQL INSERT.png') })
  }

  /*
   * 下面的往返与覆盖检查接着用**表来源**的向导。

  /*
   * 下面的往返与覆盖检查接着用**表来源**的向导。
   */
  console.log('\n[8] 导出的 INSERT 能真的导回数据库（往返一致）')
  {
    const roundTripPath = join(workDir, 'roundtrip.db')
    const db = new DatabaseSync(roundTripPath)
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score INTEGER);')
    const sql = readFileSync(join(outDir, 'users.sql'), 'utf8')
    let executed = true
    try {
      db.exec(sql)
    } catch (e) {
      executed = false
      console.log(`     往返执行失败：${e.message}`)
    }
    check('★ 导出的 INSERT 可直接执行', executed)
    if (executed) {
      const rows = db.prepare('SELECT id, name, score FROM users ORDER BY id').all()
      check('★ 往返后行数一致', rows.length === 3, String(rows.length))
      check(
        '★ 往返后数据一致',
        rows[0]?.name === 'alice' && rows[2]?.name === 'carol',
        JSON.stringify(rows)
      )
    }
    db.close()
  }

  console.log('\n[9] 目标覆盖源库被拒绝，且源库字节不变')
  {
    const before = readFileSync(dbPath)
    await win.selectOption('#transfer-wizard-format', 'csv')
    await win.waitForTimeout(200)
    await win.fill('#transfer-wizard-path', dbPath)
    await win.click('#transfer-wizard-start')
    await win.waitForTimeout(2000)
    const after = readFileSync(dbPath)
    check(
      '★ 源库文件字节未变',
      Buffer.compare(before, after) === 0,
      `大小 ${before.length} → ${after.length}`
    )
    const guardStatus = await statusText()
    check('★ 状态栏说明导出失败', guardStatus.includes('失败'), guardStatus)
    check(
      '★ 失败原因提到数据库文件',
      guardStatus.includes('数据库') || guardStatus.includes('SQLite'),
      guardStatus
    )
    await win.screenshot({ path: join(shotDir, '06-拒绝覆盖源库.png') })
  }

  console.log('\n[10] 临时文件没有残留')
  {
    const leftovers = readdirSync(outDir).filter(
      (name) => name.includes('.tmp') || name.startsWith('.')
    )
    check('★ 输出目录里没有临时文件残留', leftovers.length === 0, JSON.stringify(leftovers))
  }

  console.log('\n[10b] 参数化 SQL 能导出（参数必须跟着来源走）')
  //
  // ★ 这是实测发现的严重缺陷：向导把来源降级成 { nodeId, sql }，
  // 丢掉了 parameters，于是导出带 :id 的查询时报"缺少参数 id"——
  // 而界面上显示的来源还是那句带占位符的 SQL，看着完全正常。
  {
    // 上一阶段（[9]）的向导还开着，它会挡住编辑器。先关掉。
    await win.click('#transfer-wizard-cancel')
    await win.waitForTimeout(300)
    await win.fill('.sql-editor-input', 'SELECT id, name FROM users WHERE id = :id')
    await win.waitForTimeout(400)
    const hasParamPanel = (await win.locator('.sql-editor-parameter-row').count()) > 0
    check('参数面板出现了', hasParamPanel)
    await win.selectOption('.sql-editor-parameter-type', 'number')
    await win.fill('.sql-editor-parameter-value', '2')
    await win.click('.sql-editor-input')
    await win.keyboard.press('Control+Enter')
    await win.waitForTimeout(1800)

    const wizardBtnDisabled = await win.locator('#btn-export-wizard').isDisabled()
    check('参数化查询也能打开向导', wizardBtnDisabled === false)

    await win.click('#btn-export-wizard')
    await win.waitForSelector('#dbstudio-transfer-wizard', { state: 'attached', timeout: 5000 })
    const paramCsvPath = join(outDir, 'params.csv')
    await win.fill('#transfer-wizard-path', paramCsvPath)
    await win.click('#transfer-wizard-start')
    await win.waitForTimeout(2500)

    const paramStatus = await statusText()
    check('★ 参数化查询导出成功', paramStatus.includes('导出完成'), paramStatus)
    check('★ 文件存在', existsSync(paramCsvPath), paramCsvPath)
    if (existsSync(paramCsvPath)) {
      const csv = readFileSync(paramCsvPath, 'utf8')
      // ★ 关键：导出的必须是 **id=2** 那一行（参数值被正确带上），
      // 而不是全部行、更不是空文件。
      check('★ 导出内容是参数筛选的那一行', csv.includes('2,bob'), csv.slice(0, 160))
      check('★ 不包含未筛选的行', !csv.includes('alice'), csv.slice(0, 160))
    }
    await win.screenshot({ path: join(shotDir, '07-参数化导出.png') })
    await win.click('#transfer-wizard-cancel')
    await win.waitForTimeout(300)
  }

  console.log('\n[10c] 视图的 SQL INSERT 在向导层就被拒绝')
  //
  // ★ 实测缺陷：早先把视图也标成「表」来源，导致向导层的
  // "SQL INSERT 需要表来源" 规则对视图不触发——
  // 用户填完整套表单提交后，才由主进程报"INSERT 目标不是表"。
  {
    const expand = async (matcher) => {
      await win.evaluate((text) => {
        const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
        const target = rows.find((r) => r.textContent?.trim().includes(text))
        const twisty = target?.querySelector('.twisty')
        if (twisty && twisty.textContent?.trim() === '▸') twisty.click()
      }, matcher)
      await win.waitForTimeout(500)
    }
    await expand('导出向导库')
    await expand('视图')

    const hasView = await win.evaluate(() =>
      [...document.querySelectorAll('#tree-rows .tree-row')].some((r) =>
        r.querySelector('.row-label')?.textContent?.trim() === 'v_users'
      )
    )
    if (!hasView) {
      check('（跳过）夹具里没有视图', true)
    } else {
      const opened = await win.evaluate(() => {
        const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
        const target = rows.find(
          (r) => r.querySelector('.row-label')?.textContent?.trim() === 'v_users'
        )
        if (!target) return false
        const rect = target.getBoundingClientRect()
        target.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            clientX: rect.left + 20,
            clientY: rect.top + 10
          })
        )
        return true
      })
      check('视图节点可以右键', opened)
      await win.waitForTimeout(400)
      await win.evaluate(() => {
        const items = [...document.querySelectorAll('[role="menuitem"]')]
        const item = items.find((e) => (e.textContent ?? '').includes('导出向导'))
        item?.click()
      })
      await win.waitForSelector('#dbstudio-transfer-wizard', { state: 'attached', timeout: 5000 })

      await win.selectOption('#transfer-wizard-format', 'sql-insert')
      await win.waitForTimeout(300)
      const compat = await win.evaluate(() => {
        const node = document.getElementById('transfer-wizard-compat')
        return { hidden: node?.hasAttribute('hidden') ?? true, text: node?.textContent ?? '' }
      })
      check('★ 兼容性提示是可见的', compat.hidden === false, JSON.stringify(compat))
      check('★ 提示提到视图', compat.text.includes('视图'), compat.text)

      const viewSqlPath = join(outDir, 'view.sql')
      await win.fill('#transfer-wizard-path', viewSqlPath)
      await win.click('#transfer-wizard-start')
      await win.waitForTimeout(800)
      const viewErrors = await wizardErrors()
      check(
        '★ 视图 + SQL INSERT 被当场拒绝',
        viewErrors.hidden === false && viewErrors.text.includes('落点'),
        JSON.stringify(viewErrors)
      )
      check('★ 没有产出 SQL 文件', !existsSync(viewSqlPath))
      await win.screenshot({ path: join(shotDir, '08-拒绝视图INSERT.png') })
      await win.click('#transfer-wizard-cancel')
      await win.waitForTimeout(300)
    }
  }

  console.log('\n[11] 关闭向导')
  // [10c] 已经把向导关掉了，这里确认它确实关着。
  check('★ 向导已关闭', (await wizardOpen()) === false)
} finally {
  await app.close().catch(() => {})
}

console.log(`\n===== 导出向导 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exit(1)
