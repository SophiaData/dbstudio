/**
 * P2.3 CSV 导入向导的**真实 GUI 测试**。
 *
 * ============================================================================
 * 这条测试验的是「接线」，不是「纯逻辑」
 * ============================================================================
 *
 * 后端（ImportManager + 驱动 importBatch）已经由
 * `tests/e2e-import-task.mjs` 覆盖。这里覆盖的是**只有真实 Electron
 * 才能验的东西**：
 *
 *   1. 表节点右键菜单里真的有「导入 CSV…」入口；
 *   2. 向导的表单元素齐全（路径 / 分隔符 / NULL / 表头 / 批大小 / 目标列）；
 *   3. 相对路径被**当场**拒绝（不会启动一个注定失败的任务）；
 *   4. 重复目标列被**当场**拒绝（这是最容易写错、且后端也会拒的规则）；
 *   5. 导入成功后，目标表里**真的**多出了数据（读数据库文件核对，
 *      不是只看界面提示）；
 *   6. NOT NULL 失败时，界面显示**行号与列名**，且目标表**没有部分写入**；
 *   7. 启动、运行、收尾期间不能静默关闭向导；跟踪失败后**不丢任务**——
 *      既能重试接回跟踪，也能任务级取消收口；
 *   8. 连续选择不同表时，慢响应不能覆盖最后一次选择；
 *   9. 向导能正常关闭。
 *
 * 为什么第 5、6 条最重要：向导如果只是"调了 API 就报成功"，
 * 数据根本没进库，那是个**看起来完全正常**的失败——最坏的一类。
 * 所以这里直接读磁盘上的 SQLite 文件核对内容。
 *
 * 运行：node tests/gui-import.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 只验证纯函数时不创建夹具、不启 Electron、不连接数据库、不写构建产物。
if (process.argv.includes('--pure')) {
  const { build } = await import('vite')
  const { default: assert } = await import('node:assert/strict')
  const built = await build({
    configFile: false, root, logLevel: 'error',
    build: { write: false, ssr: true, target: 'node22', minify: false,
      lib: { entry: resolve(root, 'src/renderer/import-dialog.ts'), formats: ['es'] } }
  })
  const outputs = (Array.isArray(built) ? built : [built]).flatMap((result) => result.output ?? [])
  const chunk = outputs.find((output) => output.type === 'chunk')
  assert.ok(chunk)
  const logic = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`)
  const column = (name, extra = {}) => ({ name, nullable: false, defaultValue: null,
    typeName: 'TEXT', primaryKeyOrdinal: null, identity: null, generated: null, ...extra })
  const values = { sourcePath: '/tmp/example.csv', delimiter: ',', nullText: '', hasHeader: true,
    batchSize: '200', targetColumns: ['name'] }
  const target = [column('name'), column('id', { identity: 'always' })]
  const cases = [
    ['NOT NULL 无默认值列必须映射', () => assert.deepEqual(logic.findUnmappedRequiredColumns([], [column('name')]).map((c) => c.name), ['name'])],
    ['identity always 可省略', () => assert.deepEqual(logic.findUnmappedRequiredColumns([], [column('id', { identity: 'always' })]), [])],
    ['identity by-default 可省略', () => assert.deepEqual(logic.findUnmappedRequiredColumns([], [column('id', { identity: 'by-default' })]), [])],
    ['stored generated 可省略', () => assert.deepEqual(logic.findUnmappedRequiredColumns([], [column('calc', { generated: 'stored' })]), [])],
    ['virtual generated 可省略', () => assert.deepEqual(logic.findUnmappedRequiredColumns([], [column('calc', { generated: 'virtual' })]), [])],
    ['默认值与 nullable 列可省略', () => assert.deepEqual(logic.findUnmappedRequiredColumns([], [column('n', { defaultValue: '0' }), column('city', { nullable: true })]), [])],
    ['必填列映射大小写不敏感', () => assert.deepEqual(logic.findUnmappedRequiredColumns(['NAME'], [column('name')]), [])],
    ['未知 identity 信息不误禁用', () => assert.equal(logic.findUnmappedRequiredColumns([], [column('id', { identity: undefined })]).length, 0)],
    ['未知 generated 信息不误禁用', () => assert.equal(logic.findUnmappedRequiredColumns([], [column('id', { generated: undefined })]).length, 0)],
    ['SQLite rowid PK 生成信息未知允许省略', () => assert.equal(logic.findUnmappedRequiredColumns([], [column('id', { typeName: 'INTEGER', primaryKeyOrdinal: 1, identity: undefined })]).length, 0)],
    ['明确无生成的主键仍必填（WITHOUT ROWID/复合键）', () => assert.equal(logic.findUnmappedRequiredColumns([], [column('id', { primaryKeyOrdinal: 1 })]).length, 1)],
    ['generated 列不得显式映射', () => assert.equal(logic.validateImportForm('connection:c1|table:t', { ...values, targetColumns: ['calc'] }, [column('calc', { generated: 'stored' })]).ok, false)],
    ['identity ALWAYS 不得显式映射', () => assert.equal(logic.validateImportForm('connection:c1|table:t', { ...values, targetColumns: ['id'] }, [column('id', { identity: 'always' })]).ok, false)],
    ['identity BY DEFAULT 允许显式映射', () => assert.equal(logic.validateImportForm('connection:c1|table:t', { ...values, targetColumns: ['id'] }, [column('id', { identity: 'by-default' })]).ok, true)],
    ['完整表单允许省略 identity 列', () => assert.equal(logic.validateImportForm('connection:c1|table:t', values, target).ok, true)],
    ['完整表单拒绝缺失必填列', () => assert.equal(logic.validateImportForm('connection:c1|table:t', { ...values, targetColumns: ['id'] }, target).ok, false)],
    ['完整表单拒绝重复目标列', () => assert.equal(logic.validateImportForm('connection:c1|table:t', { ...values, targetColumns: ['name', 'NAME'] }, target).ok, false)],
    ['预览解析错误阻止导入', () => assert.equal(logic.validateImportPreview({ errorCount: 1, columns: [{}] }, ['name']).length, 1)],
    ['预览错误数组非空也阻止导入', () => assert.equal(logic.validateImportPreview({ errorCount: 0, errors: [{}], columns: [{}] }, ['name']).length, 1)],
    ['CSV 列数不匹配阻止导入', () => assert.equal(logic.validateImportPreview({ errorCount: 0, columns: [{}, {}] }, ['name']).length, 1)],
    ['有界截断样例不阻止有效导入', () => assert.deepEqual(logic.validateImportPreview({ errorCount: 0, columns: [{}], truncated: true }, ['name']), [])],
    ['requiredOnInsert=true 优先于未知 identity/generated', () => assert.equal(logic.findUnmappedRequiredColumns([], [column('name', { requiredOnInsert: true, identity: undefined, generated: undefined })]).length, 1)],
    ['requiredOnInsert=false 优先于 NOT NULL fallback', () => assert.equal(logic.findUnmappedRequiredColumns([], [column('id', { requiredOnInsert: false })]).length, 0)],
    ['requiredOnInsert=undefined 回退到明确三态', () => assert.equal(logic.findUnmappedRequiredColumns([], [column('name', { requiredOnInsert: undefined })]).length, 1)],
    ['rowid alias 的 false hint 允许省略 NOT NULL 主键', () => assert.equal(logic.findUnmappedRequiredColumns([], [column('id', { typeName: 'INTEGER', primaryKeyOrdinal: 1, requiredOnInsert: false })]).length, 0)],
    ['WITHOUT ROWID/PK DESC/复合PK 的 true hint 不被主键序号豁免', () => assert.equal(logic.findUnmappedRequiredColumns([], [column('id', { primaryKeyOrdinal: 1, requiredOnInsert: true })]).length, 1)],
    ['requiredOnInsert=true 已映射时通过', () => assert.equal(logic.findUnmappedRequiredColumns(['NAME'], [column('name', { requiredOnInsert: true })]).length, 0)],
    ['requiredOnInsert=false 不豁免 generated 映射禁止', () => assert.equal(logic.validateImportForm('connection:c1|table:t', { ...values, targetColumns: ['calc'] }, [column('calc', { generated: 'stored', requiredOnInsert: false })]).ok, false)]
  ]
  let failures = 0
  for (const [name, run] of cases) {
    try { run(); console.log(`PASS ${name}`) }
    catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`) }
  }
  console.log(`PURE_IMPORT_PASS=${cases.length - failures} FAIL=${failures}`)
  process.exit(failures === 0 ? 0 : 1)
}

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

// ---- 夹具 ----
const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-import-wizard-'))
const dbPath = join(workDir, 'import.db')
{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE identity_preview (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, derived TEXT GENERATED ALWAYS AS (name || '!') STORED);
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT);
    CREATE TABLE guarded (id INTEGER PRIMARY KEY, email TEXT NOT NULL, note TEXT);
    CREATE TABLE progress_failure (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE wait_failure (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE running_guard (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE cancel_guard (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE retry_guard (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE cancel_retry_guard (id INTEGER PRIMARY KEY, name TEXT);
  `)
  db.close()
}

/** 读目标表当前行数（直接读磁盘，绕开界面）。 */
const countRows = (table) => {
  const db = new DatabaseSync(dbPath)
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  } finally {
    db.close()
  }
}

/** 读目标表的全部行（直接读磁盘）。 */
const readRows = (table) => {
  const db = new DatabaseSync(dbPath)
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
  } finally {
    db.close()
  }
}

// ---- CSV 文件 ----
const okCsvPath = join(workDir, 'people.csv')
writeFileSync(okCsvPath, 'id,name,city\n10,张三,北京\n11,李四,上海\n', 'utf8')

// 第二份 CSV：**不同的主键**。
//
// 为什么不能复用第一份：people.id 是主键，重复导入同样的 id 会触发
// UNIQUE 约束失败——那是**正确**行为，不是缺陷。所以"连续导入两次"
// 必须用两份数据不同的文件，才能验证的是"第二次导入也能走通"，
// 而不是"主键冲突被正确拒绝"。
const okCsvPath2 = join(workDir, 'people-2.csv')
writeFileSync(okCsvPath2, 'id,name,city\n20,王五,广州\n21,赵六,深圳\n', 'utf8')

const nameCsvPath = join(workDir, 'name-only.csv')
writeFileSync(nameCsvPath, 'name\n自动生成\n', 'utf8')
const malformedCsvPath = join(workDir, 'malformed.csv')
writeFileSync(malformedCsvPath, 'id,name,city\n1,missing\n', 'utf8')
const duplicateHeaderPath = join(workDir, 'duplicate-header.csv')
writeFileSync(duplicateHeaderPath, 'id,name,name\n1,A,B\n', 'utf8')

const simpleCsvPath = join(workDir, 'simple.csv')
writeFileSync(simpleCsvPath, 'id,name\n1,测试\n', 'utf8')

// 大批量 CSV：保证「取消」请求到达时后端任务**还在跑**。
//
// 为什么需要它：导入一旦结束，cancelImport 就返回 false（任务已终态），
// 那样就测不到「跟踪中断后仍能取消任务」这条路径。
// 3 万行足以让任务跑上几百毫秒，给测试留出点取消的窗口。
const BULK_ROWS = 30000
const bulkCsvPath = join(workDir, 'bulk.csv')
{
  const lines = ['id,name\n']
  for (let i = 1; i <= BULK_ROWS; i += 1) lines.push(`${i},用户${i}\n`)
  writeFileSync(bulkCsvPath, lines.join(''), 'utf8')
}

// NOT NULL 失败：第 3 行的 email 是空的（未加引号 → NULL）。
const badCsvPath = join(workDir, 'guarded-bad.csv')
writeFileSync(
  badCsvPath,
  'id,email,note\n1,a@example.com,ok\n2,b@example.com,ok\n3,,bad\n',
  'utf8'
)

// 「跟踪失败 → 恢复/取消 → 终态 → 再次导入」用例的 CSV。
//
// 主键互不重叠：两次导入必须都能成功，否则第二次会撞 UNIQUE 约束，
// 那测到的就不是「还能不能再次导入」，而是「主键冲突被正确拒绝」。
const retryCsv1 = join(workDir, 'retry-1.csv')
writeFileSync(retryCsv1, 'id,name\n1,甲\n2,乙\n', 'utf8')
const retryCsv2 = join(workDir, 'retry-2.csv')
writeFileSync(retryCsv2, 'id,name\n3,丙\n4,丁\n', 'utf8')
const cancelRetryCsv1 = join(workDir, 'cancel-retry-1.csv')
writeFileSync(cancelRetryCsv1, 'id,name\n5,戊\n6,己\n', 'utf8')
const cancelRetryCsv2 = join(workDir, 'cancel-retry-2.csv')
writeFileSync(cancelRetryCsv2, 'id,name\n7,庚\n8,辛\n', 'utf8')

const userDataDir = join(workDir, 'userdata')
mkdirSync(userDataDir, { recursive: true })
const shotDir = join(root, 'out/gui-import')
mkdirSync(shotDir, { recursive: true })

const electronBin = require('electron')
const extraArgs =
  process.env['ELECTRON_DISABLE_SANDBOX'] === '1' && process.platform === 'linux'
    ? ['--no-sandbox']
    : []

/**
 * Electron 入口。
 *
 * 默认 `.`（仓库根目录，走 package.json 的 main = out/main/index.js）。
 * 设 `DBSTUDIO_ELECTRON_ENTRY` 可以指向另一份构建产物（例如隔离验证目录），
 * 这样在不动 out/ 的前提下也能验证最新代码。
 */
const electronEntry = process.env['DBSTUDIO_ELECTRON_ENTRY'] ?? '.'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.DBSTUDIO_TEST_HIDDEN = '1'

const app = await electron.launch({
  executablePath: electronBin,
  args: [electronEntry, `--user-data-dir=${userDataDir}`, ...extraArgs],
  cwd: root,
  env
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })

/**
 * 在主进程 IPC 边界注入确定性延迟/失败。
 *
 * 渲染进程的 `window.dbstudio` 由 contextBridge 冻结，不能直接替换；
 * 这里包住真实 handler，既保留生产 IPC 路径，也能稳定复现
 * “startImport 尚未返回”和“跟踪调用失败”的窗口。
 */
await app.evaluate(({ ipcMain, dialog, BrowserWindow }) => {
  const handlers = ipcMain._invokeHandlers
  const originalStart = handlers.get('dbstudio:startImport')
  const originalProgress = handlers.get('dbstudio:getImportProgress')
  const originalWait = handlers.get('dbstudio:waitImport')
  const originalDescribe = handlers.get('dbstudio:describeTable')
  const originalPreview = handlers.get('dbstudio:previewImport')
  const originalChoose = handlers.get('dbstudio:chooseImportFile')

  const originalShowOpenDialog = dialog.showOpenDialog
  globalThis.__importGuiControl = {
    chooserDelayMs: 0,
    chooserSenderWindowId: null,
    chooserMode: 'success',
    chooserPath: '',
    chooserCalls: 0,
    chooserParentMatches: false,
    previewDelayMs: 0,
    previewStarted: 0,
    startDelayMs: 0,
    startFailures: 0,
    progressFailures: 0,
    runningProgressCalls: 0,
    waitFailures: 0,
    describeDelayMs: 0,
    describeDelayTable: ''
  }

  globalThis.__restoreChooser = () => { dialog.showOpenDialog = originalShowOpenDialog }
  dialog.showOpenDialog = async (parent, options) => {
    const control = globalThis.__importGuiControl
    control.chooserCalls += 1
    control.chooserParentMatches = parent?.id === control.chooserSenderWindowId
    control.chooserSingleFile = options?.properties?.includes('openFile') && !options.properties.includes('multiSelections')
    const delayMs = control.chooserDelayMs
    control.chooserDelayMs = 0
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (control.chooserMode === 'throw') throw new Error('测试注入：文件选择器失败')
    if (control.chooserMode === 'cancel') return { canceled: true, filePaths: [] }
    return { canceled: false, filePaths: [control.chooserPath] }
  }

  ipcMain.removeHandler('dbstudio:chooseImportFile')
  ipcMain.handle('dbstudio:chooseImportFile', (event) => {
    globalThis.__importGuiControl.chooserSenderWindowId = BrowserWindow.fromWebContents(event.sender)?.id
    return originalChoose(event)
  })

  ipcMain.removeHandler('dbstudio:previewImport')
  ipcMain.handle('dbstudio:previewImport', async (event, request) => {
    const control = globalThis.__importGuiControl
    control.previewStarted += 1
    const delayMs = control.previewDelayMs
    control.previewDelayMs = 0
    const result = await originalPreview(event, request)
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    return result
  })

  ipcMain.removeHandler('dbstudio:startImport')
  ipcMain.handle('dbstudio:startImport', async (event, request) => {
    const control = globalThis.__importGuiControl
    const delayMs = control.startDelayMs
    control.startDelayMs = 0
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (control.startFailures > 0) {
      control.startFailures -= 1
      throw new Error('测试注入：启动失败')
    }
    return originalStart(event, request)
  })

  ipcMain.removeHandler('dbstudio:getImportProgress')
  ipcMain.handle('dbstudio:getImportProgress', async (event, taskId) => {
    const control = globalThis.__importGuiControl
    if (control.progressFailures > 0) {
      control.progressFailures -= 1
      throw new Error('测试注入：读取进度失败')
    }
    if (control.runningProgressCalls > 0) {
      control.runningProgressCalls -= 1
      return {
        taskId,
        status: 'running',
        totalRows: 0,
        rowsImported: 0,
        batches: 0,
        sourcePath: '',
        targetNodeId: ''
      }
    }
    return originalProgress(event, taskId)
  })

  ipcMain.removeHandler('dbstudio:waitImport')
  ipcMain.handle('dbstudio:waitImport', async (event, taskId) => {
    const control = globalThis.__importGuiControl
    if (control.waitFailures > 0) {
      control.waitFailures -= 1
      throw new Error('测试注入：读取结果失败')
    }
    return originalWait(event, taskId)
  })

  ipcMain.removeHandler('dbstudio:describeTable')
  ipcMain.handle('dbstudio:describeTable', async (event, nodeId) => {
    const control = globalThis.__importGuiControl
    const matches =
      control.describeDelayTable !== '' &&
      typeof nodeId === 'string' &&
      nodeId.endsWith(`|table:${control.describeDelayTable}`)
    const delayMs = matches ? control.describeDelayMs : 0
    if (matches) {
      control.describeDelayMs = 0
      control.describeDelayTable = ''
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    return originalDescribe(event, nodeId)
  })
})

/** 向导是否打开。 */
const wizardOpen = () =>
  win.evaluate(() => document.getElementById('dbstudio-import-wizard') !== null)

/** 向导的错误框文案。 */
const wizardErrors = () =>
  win.evaluate(() => {
    const box = document.getElementById('import-wizard-errors')
    return { hidden: box?.hasAttribute('hidden') ?? true, text: box?.textContent ?? '' }
  })

/** 向导的进度区文案。 */
const wizardProgress = () =>
  win.evaluate(() => {
    const box = document.getElementById('import-wizard-progress')
    return {
      hidden: box?.hasAttribute('hidden') ?? true,
      text: document.getElementById('import-wizard-progress-text')?.textContent ?? '',
      detail: document.getElementById('import-wizard-progress-detail')?.textContent ?? ''
    }
  })

/** 状态栏文案。 */
const statusText = () => win.$eval('#status-bar', (e) => e.textContent ?? '')

/** 关闭向导（点「取消」）。任务不在跑时它就是"关闭"。 */
const closeWizard = async () => {
  const btn = win.locator('#dbstudio-import-wizard #import-wizard-cancel').last()
  // 向导可能已经不在了（比如被别的路径关掉了）：那就不该在这里崩掉整个测试。
  if ((await btn.count()) === 0) return
  await btn.click()
  await win.waitForTimeout(400)
}

/** 点「开始导入」。用 last()：页面上只应有一个向导，last() 能避免选到旧的那个。 */
const clickStart = async () => {
  await win.locator('#dbstudio-import-wizard #import-wizard-start').last().click()
}

/**
 * 等进度区进入「已完成」，返回**是否等到了**。
 *
 * 为什么不直接用 waitForFunction：它超时会抛异常，把整个测试带崩，
 * 而「再次导入没跑起来」恰恰是要**报成一条失败检查**的东西，
 * 不能让它变成一个看不懂的堆栈。
 */
const waitCompleted = async (timeout = 15000) =>
  win
    .waitForFunction(
      () =>
        document
          .getElementById('import-wizard-progress-text')
          ?.textContent?.includes('已完成') === true,
      { timeout }
    )
    .then(() => true)
    .catch(() => false)

const setImportTestControl = (patch) =>
  app.evaluate((_electron, next) => {
    Object.assign(globalThis.__importGuiControl, next)
  }, patch)

/** 展开树上的某一行（点 twisty）。 */
const expandTree = async (matcher) => {
  await win.evaluate((text) => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const target = rows.find((r) => r.textContent?.trim().includes(text))
    const twisty = target?.querySelector('.twisty')
    if (twisty && twisty.textContent?.trim() === '▸') twisty.click()
  }, matcher)
  await win.waitForTimeout(600)
}

/** 右键某个树节点，返回右键菜单是否成功弹出。 */
const rightClickTreeNode = async (label) => {
  const opened = await win.evaluate((text) => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const target = rows.find((r) => r.querySelector('.row-label')?.textContent?.trim() === text)
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
  }, label)
  await win.waitForTimeout(500)
  return opened
}

/** 菜单里有没有某个文案的可点项。 */
const clickMenuItem = async (text) =>
  win.evaluate((label) => {
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    const item = items.find((e) => (e.textContent ?? '').includes(label))
    if (!item) return false
    item.click()
    return true
  }, text)

try {
  console.log('\n[1] 建连接并展开到表')
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', '导入向导库')
  await win.fill('#f-dynamic input[data-key="file"]', dbPath)
  await win.click('#btn-submit')
  await win.waitForFunction(
    () => {
      const d = document.getElementById('dlg-connection')
      return d !== null && !d.hasAttribute('open')
    },
    { timeout: 20000 }
  )
  await win.waitForTimeout(800)

  await expandTree('导入向导库')
  await expandTree('表')
  const hasPeople = await win.evaluate(() =>
    [...document.querySelectorAll('#tree-rows .tree-row')].some(
      (r) => r.querySelector('.row-label')?.textContent?.trim() === 'people'
    )
  )
  check('★ 树展开后能看到 people 表', hasPeople)

  // 先把 people 表**打开**（开一个结果标签）。
  //
  // 为什么必须先打开：导入是在渲染进程之外发生的，网格不会自己知道数据变了。
  // 只有"导入前就开着的那个标签"才能证明导入成功后界面被**自动刷新**了——
  // 如果导入后再点开表，看到新数据只能说明重新查询能查到，与刷新无关。
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const target = rows.find((r) => r.querySelector('.row-label')?.textContent?.trim() === 'people')
    target?.click()
  })
  await win.waitForTimeout(1800)
  const beforeRows = await win.evaluate(
    () =>
      document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-row').length
  )
  check('★ 导入前 people 表是空的', beforeRows === 0, String(beforeRows))

  console.log('\n[2] 表节点右键菜单里有「导入 CSV…」')
  const rightClicked = await rightClickTreeNode('people')
  check('★ 表节点可以右键', rightClicked)
  const menuItems = await win.$$eval('[role="menuitem"]', (items) =>
    items.map((i) => i.textContent?.trim() ?? '')
  )
  check(
    '★ 右键菜单里有「导入 CSV…」',
    menuItems.some((t) => t.includes('导入 CSV')),
    menuItems.join('|')
  )
  check(
    '★ 右键菜单里也有「导出向导…」',
    menuItems.some((t) => t.includes('导出向导')),
    menuItems.join('|')
  )

  console.log('\n[3] 点「导入 CSV…」打开向导：表单元素齐全')
  const clickedImport = await clickMenuItem('导入 CSV')
  check('★ 点击「导入 CSV…」打开了向导', clickedImport)
  await win.waitForSelector('#dbstudio-import-wizard', { state: 'attached', timeout: 5000 })
  check('★ 向导已打开', await wizardOpen())
  await win.screenshot({ path: join(shotDir, '01-向导.png') })

  check('★ CSV 路径输入框存在', (await win.locator('#import-wizard-path').count()) === 1)
  check('★ 分隔符输入框存在', (await win.locator('#import-wizard-delimiter').count()) === 1)
  check('★ NULL 文本输入框存在', (await win.locator('#import-wizard-null').count()) === 1)
  check('★ 表头复选框存在', (await win.locator('#import-wizard-header').count()) === 1)
  check('★ 批大小输入框存在', (await win.locator('#import-wizard-batch').count()) === 1)
  check('★ 目标列输入框存在', (await win.locator('#import-wizard-columns').count()) === 1)
  check('★ 开始按钮存在', (await win.locator('#import-wizard-start').count()) === 1)
  check('★ 取消按钮存在', (await win.locator('#import-wizard-cancel').count()) === 1)
  // ★ 同一时间只能有一个导入向导：早先每次打开都追加一层遮罩，
  // 连续导入两次会留下两个同 id 的元素，第二次点「开始导入」会被前面的遮罩拦死。
  check(
    '★ 页面上只有一个导入向导',
    (await win.locator('#dbstudio-import-wizard').count()) === 1,
    String(await win.locator('#dbstudio-import-wizard').count())
  )

  console.log('\n[2a] 原生文件选择器 IPC 全链路')
  const originalPath = await win.$eval('#import-wizard-path', (e) => e.value)
  await setImportTestControl({ chooserMode: 'success', chooserPath: okCsvPath })
  await win.click('#import-wizard-browse')
  await win.waitForFunction(() => document.getElementById('import-wizard-path')?.value.endsWith('people.csv'))
  check('选择成功后路径由主进程返回并写入', (await win.$eval('#import-wizard-path', (e) => e.value)) === okCsvPath)
  await win.waitForFunction(() => document.getElementById('import-wizard-preview-summary')?.textContent?.includes('共 2 行'))
  check('选择成功后自动预览', (await win.locator('#import-wizard-preview-table tbody tr').count()) === 2)
  const chooserState = await app.evaluate(() => ({ calls: globalThis.__importGuiControl.chooserCalls, parent: globalThis.__importGuiControl.chooserParentMatches, single: globalThis.__importGuiControl.chooserSingleFile }))
  check('chooser 收到发起窗口 parent', chooserState.parent, JSON.stringify(chooserState))
  check('chooser 原生选项限制单文件', chooserState.single)
  await setImportTestControl({ chooserMode: 'cancel', chooserDelayMs: 1000 })
  await win.click('#import-wizard-browse')
  check('chooser 在途时浏览禁用', await win.locator('#import-wizard-browse').isDisabled())
  check('chooser 在途时开始禁用', await win.locator('#import-wizard-start').isDisabled())
  await win.keyboard.press('Escape')
  await win.locator('#import-wizard-cancel').click()
  check('chooser 在途时 Esc/取消不会关闭向导', await wizardOpen())
  await win.waitForFunction(() => !document.getElementById('import-wizard-browse')?.disabled)
  check('取消选择保持原路径', (await win.$eval('#import-wizard-path', (e) => e.value)) === okCsvPath)
  check('取消选择保持现有预览', (await win.locator('#import-wizard-preview-table tbody tr').count()) === 2)
  await setImportTestControl({ chooserMode: 'throw' })
  await win.click('#import-wizard-browse')
  await win.waitForTimeout(300)
  check('选择器异常显示错误', (await wizardErrors()).text.includes('文件选择器失败'))
  check('选择器异常不改路径', (await win.$eval('#import-wizard-path', (e) => e.value)) === okCsvPath)
  await setImportTestControl({ chooserMode: 'success', chooserPath: originalPath })

  const sourceText = await win.$eval('#import-wizard-source', (e) => e.textContent ?? '')
  const sourceNote = await win.$eval('#import-wizard-source-note', (e) => e.textContent ?? '')
  const columnHint = await win.$eval('#import-wizard-columns-hint', (e) => e.textContent ?? '')
  check('★ 顶部显示目标表 people', sourceText.includes('people'), sourceText)

  const noteText = sourceNote
  check(
    '★ 说明了「后端将在开始导入时完整校验」',
    noteText.includes('后端将在开始导入时完整校验'),
    noteText
  )
  check(
    '★ 目标列提示说明了列数由后端完整校验',
    columnHint.includes('后端') && columnHint.includes('完整校验'),
    columnHint
  )

  // 目标表的列名应该被列成可点的标签（省掉手抄列名）。
  const chips = await win.$$eval('#import-wizard-column-list .import-column-chip', (els) =>
    els.map((e) => e.textContent?.trim() ?? '')
  )
  check(
    '★ 列出了目标表的全部列',
    chips.includes('id') && chips.includes('name') && chips.includes('city'),
    chips.join('|')
  )

  console.log('\n[3a] CSV 预览和实时校验')
  await win.fill('#import-wizard-columns', 'id\nname\ncity')
  await win.waitForFunction(() => !document.getElementById('import-wizard-start')?.disabled)
  check('合法映射与现有预览允许开始', !(await win.locator('#import-wizard-start').isDisabled()))
  await win.fill('#import-wizard-path', '')
  check('清空路径立即清除旧预览样例', await win.locator('#import-wizard-preview-table tbody tr').count() === 0)
  check('未预览时开始按钮禁用', await win.locator('#import-wizard-start').isDisabled())
  await win.fill('#import-wizard-path', malformedCsvPath)
  await win.fill('#import-wizard-columns', 'id\nname\ncity')
  await win.waitForFunction(() => document.getElementById('import-wizard-preview-errors')?.textContent?.includes('列'))
  check('缺列错误展示行号', (await win.locator('#import-wizard-preview-errors').innerText()).includes('第 2 行'))
  check('解析错误时开始按钮禁用', await win.locator('#import-wizard-start').isDisabled())
  await win.fill('#import-wizard-path', duplicateHeaderPath)
  await win.waitForFunction(() => document.getElementById('import-wizard-preview-errors')?.textContent?.includes('重复'))
  check('重复 CSV 表头阻止开始', await win.locator('#import-wizard-start').isDisabled())
  await win.fill('#import-wizard-path', bulkCsvPath)
  await win.fill('#import-wizard-columns', 'id\nname')
  await win.waitForFunction(() => document.getElementById('import-wizard-preview-summary')?.textContent?.includes('截断'))
  check('预览显示总行数与截断提示', (await win.locator('#import-wizard-preview-summary').innerText()).includes('30,000'))
  check('样例仅有固定 50 行', await win.locator('#import-wizard-preview-table tbody tr').count() === 50)
  check('预览表头显示源列名', (await win.locator('#import-wizard-preview-table thead').innerText()).includes('name'))
  check('预览显示样例单元格', (await win.locator('#import-wizard-preview-table tbody tr').first().innerText()).includes('用户1'))
  await win.fill('#import-wizard-columns', 'id')
  check('缺少必填列时实时禁用开始', await win.locator('#import-wizard-start').isDisabled())
  check('缺少必填列时展示列名', (await wizardErrors()).text.includes('未映射必填列：name'))
  await win.fill('#import-wizard-columns', 'id\nname\ncity')
  check('CSV 映射列数不符时禁用开始', await win.locator('#import-wizard-start').isDisabled())

  console.log('\n[3a-race] 旧响应与参数变化')
  const previewsBefore = await app.evaluate(() => globalThis.__importGuiControl.previewStarted)
  await setImportTestControl({ previewDelayMs: 1200 })
  await win.fill('#import-wizard-path', malformedCsvPath)
  await win.waitForFunction(() => document.getElementById('import-wizard-preview-summary')?.textContent?.includes('正在预览'))
  await win.waitForTimeout(350)
  check('旧预览请求已经发出', (await app.evaluate(() => globalThis.__importGuiControl.previewStarted)) > previewsBefore)
  await win.fill('#import-wizard-path', okCsvPath)
  check('切换文件立即清除旧样例', await win.locator('#import-wizard-preview-table tbody tr').count() === 0)
  check('新文件预览完成前禁用开始', await win.locator('#import-wizard-start').isDisabled())
  await win.waitForFunction(() => document.getElementById('import-wizard-preview-summary')?.textContent?.includes('共 2 行'))
  await win.waitForTimeout(1300)
  check('慢旧响应不覆盖新文件预览', (await win.locator('#import-wizard-preview-summary').innerText()).includes('共 2 行'))
  check('慢旧响应错误不覆盖新文件', (await win.locator('#import-wizard-preview-errors').innerText()) === '')
  await win.fill('#import-wizard-columns', 'id\ncity')
  check('移除必填映射立即禁用开始', await win.locator('#import-wizard-start').isDisabled())
  await win.fill('#import-wizard-columns', 'id\nname\ncity')
  check('补回必填映射立即启用开始', !(await win.locator('#import-wizard-start').isDisabled()))
  await win.fill('#import-wizard-null', '\\N')
  check('改变 NULL 参数立即使旧预览失效', await win.locator('#import-wizard-start').isDisabled())
  check('参数变化立即清除旧样例', await win.locator('#import-wizard-preview-table tbody tr').count() === 0)
  await win.waitForFunction(() => !document.getElementById('import-wizard-start')?.disabled)
  await win.fill('#import-wizard-null', '')
  await win.waitForFunction(() => !document.getElementById('import-wizard-start')?.disabled)

  console.log('\n[3a-identity] 身份列与生成列允许省略')
  await closeWizard()
  await rightClickTreeNode('identity_preview')
  await clickMenuItem('导入 CSV')
  await win.waitForSelector('#import-wizard-path')
  await win.fill('#import-wizard-path', nameCsvPath)
  await win.fill('#import-wizard-columns', 'name')
  await win.waitForFunction(() => !document.getElementById('import-wizard-start')?.disabled)
  check('identity/generated 未映射仍允许开始', !(await win.locator('#import-wizard-start').isDisabled()))
  check('identity/generated 不显示缺少必填列', !(await wizardErrors()).text.includes('未映射必填列'))
  check('生成列建议按钮禁用并说明原因', await win.locator('.import-column-chip[data-column="derived"]').isDisabled())
  await win.fill('#import-wizard-columns', 'derived')
  check('显式映射生成列时禁用开始', await win.locator('#import-wizard-start').isDisabled())
  check('显式映射生成列时解释不可写原因', (await wizardErrors()).text.includes('不能作为导入目标'))
  await closeWizard()
  await rightClickTreeNode('people')
  await clickMenuItem('导入 CSV')
  await win.waitForSelector('#import-wizard-path')

  console.log('\n[3b] 启动中 ✕ / Esc / 底部取消都不能关闭向导')
  await win.fill('#import-wizard-path', okCsvPath)
  await win.fill('#import-wizard-columns', 'id\nname\ncity')
  await setImportTestControl({ startDelayMs: 2500, startFailures: 1 })
  await clickStart()
  await win.waitForTimeout(80)
  check(
    '★ startImport 返回前开始按钮已禁用',
    await win.locator('#import-wizard-start').isDisabled()
  )
  check('导入启动中浏览按钮禁用', await win.locator('#import-wizard-browse').isDisabled())

  await win.locator('#dbstudio-import-wizard button[aria-label="关闭"]').last().click()
  await win.keyboard.press('Escape')
  await win.locator('#import-wizard-cancel').last().click()
  await win.waitForTimeout(100)
  check('★ 启动中点 ✕ / Esc / 底部取消后向导仍然打开', await wizardOpen())
  check(
    '★ 启动中的关闭尝试说明了原因',
    (await statusText()).includes('导入正在启动'),
    await statusText()
  )

  await win.waitForFunction(
    () =>
      document
        .getElementById('import-wizard-errors')
        ?.textContent?.includes('测试注入：启动失败') === true,
    { timeout: 5000 }
  )
  check(
    '★ 启动失败后开始按钮恢复可用',
    !(await win.locator('#import-wizard-start').isDisabled())
  )
  check(
    '★ 启动失败后向导仍是可关闭的 idle 状态',
    await wizardOpen()
  )
  await closeWizard()
  check('★ 启动失败后点底部取消可以关闭', (await wizardOpen()) === false)

  await rightClickTreeNode('people')
  const reopenedAfterFailure = await clickMenuItem('导入 CSV')
  check('★ 启动失败后可重新打开向导', reopenedAfterFailure)
  await win.waitForSelector('#dbstudio-import-wizard', { state: 'attached', timeout: 5000 })

  console.log('\n[4] 相对路径被当场拒绝（不会启动任务）')
  await win.fill('#import-wizard-path', 'relative-people.csv')
  await win.fill('#import-wizard-columns', 'id\nname\ncity')
  check('相对路径时开始按钮禁用', await win.locator('#import-wizard-start').isDisabled())
  await win.waitForTimeout(700)
  const relativeErrors = await wizardErrors()
  check(
    '★ 报出绝对路径要求',
    relativeErrors.hidden === false && relativeErrors.text.includes('绝对路径'),
    JSON.stringify(relativeErrors)
  )
  check('★ 表里没有数据被写入', countRows('people') === 0, String(countRows('people')))
  await win.screenshot({ path: join(shotDir, '02-拒绝相对路径.png') })

  console.log('\n[5] 重复目标列被当场拒绝')
  await win.fill('#import-wizard-path', okCsvPath)
  await win.fill('#import-wizard-columns', 'id\nname\nname')
  check('重复目标列时开始按钮禁用', await win.locator('#import-wizard-start').isDisabled())
  await win.waitForTimeout(700)
  const duplicateErrors = await wizardErrors()
  check(
    '★ 报出目标列重复',
    duplicateErrors.hidden === false && duplicateErrors.text.includes('重复'),
    JSON.stringify(duplicateErrors)
  )
  check('★ 表里仍然没有数据', countRows('people') === 0, String(countRows('people')))

  console.log('\n[5b] 目标表里不存在的列被拒绝')
  await win.fill('#import-wizard-columns', 'id\nname\nnope')
  check('未知目标列时开始按钮禁用', await win.locator('#import-wizard-start').isDisabled())
  await win.waitForTimeout(700)
  const unknownErrors = await wizardErrors()
  check(
    '★ 报出目标表没有这一列',
    unknownErrors.hidden === false && unknownErrors.text.includes('没有这些列'),
    JSON.stringify(unknownErrors)
  )

  console.log('\n[6] 成功导入：数据真的进了表')
  await win.fill('#import-wizard-columns', 'id\nname\ncity')
  await clickStart()
  await win.waitForTimeout(2500)
  const progress = await wizardProgress()
  check('★ 进度区显示了完成状态', progress.text.includes('已完成'), JSON.stringify(progress))
  const importStatus = await statusText()
  check('★ 状态栏报告导入完成', importStatus.includes('导入完成'), importStatus)
  check('★ 表里有 2 行', countRows('people') === 2, String(countRows('people')))
  const rows = readRows('people')
  check(
    '★ 行的内容与 CSV 一致',
    rows.length === 2 && rows[0].name === '张三' && rows[0].city === '北京',
    JSON.stringify(rows)
  )
  await win.screenshot({ path: join(shotDir, '03-导入完成.png') })

  console.log('\n[6b] 界面上的表格刷新后能看到新数据')
  {
    // 先关掉向导，否则它会挡住页面（遮罩层盖住整页）。
    await closeWizard()
    // 导入前就开着的那个标签应该已经被刷新（不需要用户手动重开表）。
    const gridText = await win.evaluate(() =>
      [...document.querySelectorAll('.tab-pane:not([hidden]) .tab-grid-root .grid-row')]
        .map((r) => r.textContent ?? '')
        .join('|')
    )
    check(
      '★ 导入前开着的标签自动刷新，能看到新行',
      gridText.includes('张三') && gridText.includes('李四'),
      gridText.slice(0, 200)
    )
  }

  console.log('\n[7] NOT NULL 失败：显示行号与列名，且没有部分写入')
  {
    check('★ 关闭后向导确实不在了', (await wizardOpen()) === false)
    // 换到 guarded 表，它的 email 是 NOT NULL。
    await expandTree('导入向导库')
    await expandTree('表')
    const rightClicked = await rightClickTreeNode('guarded')
    check('★ guarded 表可以右键', rightClicked)
    const opened = await clickMenuItem('导入 CSV')
    check('★ 点击后打开了向导', opened)
    await win.waitForSelector('#dbstudio-import-wizard', { state: 'attached', timeout: 5000 })

    const guardedSource = await win.$eval('#import-wizard-source', (e) => e.textContent ?? '')
    check('★ 目标表是 guarded', guardedSource.includes('guarded'), guardedSource)

    await win.fill('#import-wizard-path', badCsvPath)
    await win.fill('#import-wizard-columns', 'id\nemail\nnote')
    await clickStart()
    await win.waitForTimeout(3000)

    const badProgress = await wizardProgress()
    check('★ 进度区显示失败', badProgress.text.includes('失败'), JSON.stringify(badProgress))
    check(
      '★ 失败位置包含数据行号',
      /第\s*3\s*行/.test(badProgress.detail),
      badProgress.detail
    )
    check(
      '★ 失败位置包含列名 email',
      badProgress.detail.includes('email'),
      badProgress.detail
    )
    const badStatus = await statusText()
    check('★ 状态栏说明导入失败', badStatus.includes('失败'), badStatus)
    /**
     * 普通失败（NOT NULL 违约）**不能**再说"已回滚、没有部分数据"。
     *
     * 为什么：这种失败可能发生在任何写入之前（解析拒绝、目标连接上已有
     * 未提交事务……），也可能发生在写入之后——前端不知道，只能让用户核实。
     * 说成"已回滚"是**替后端承诺**一个它没给出的结论。
     *
     * 真正的事实断言在下一条：直接读磁盘上的 SQLite 表，看有没有残留。
     */
    check(
      '★ 状态栏不谎称已回滚（普通失败不承诺回滚结论）',
      !badStatus.includes('已回滚'),
      badStatus
    )
    check(
      '★ 状态栏要求核实目标表后再决定是否重新导入',
      badStatus.includes('核实目标表'),
      badStatus
    )
    check(
      '★ 表里没有留下任何一行',
      countRows('guarded') === 0,
      String(countRows('guarded'))
    )
    await win.screenshot({ path: join(shotDir, '04-NOT-NULL 失败.png') })
  }

  console.log('\n[8] 关闭向导')
  await closeWizard()
  check('★ 向导已关闭', (await wizardOpen()) === false)

  console.log('\n[8b] 进度读取失败：保留任务跟踪（不静默丢 taskId），可重试接回')
  {
    await setImportTestControl({ progressFailures: 1 })
    await rightClickTreeNode('progress_failure')
    const opened = await clickMenuItem('导入 CSV')
    check('★ 能打开进度失败用例向导', opened)
    await win.waitForSelector('#dbstudio-import-wizard', { state: 'attached', timeout: 5000 })
    await win.fill('#import-wizard-path', simpleCsvPath)
    await win.fill('#import-wizard-columns', 'id\nname')
    await clickStart()
    await win.waitForFunction(
      () =>
        document
          .getElementById('import-wizard-errors')
          ?.textContent?.includes('无法继续跟踪本次导入') === true,
      { timeout: 5000 }
    )
    check('★ 进度读取失败后向导仍然打开（任务仍在跟踪）', await wizardOpen())
    const degradedStart = await win.$eval('#import-wizard-start', (e) => e.textContent ?? '')
    check(
      '★ 进度读取失败后「开始导入」变成重试入口',
      degradedStart.includes('重试读取进度'),
      degradedStart
    )
    const degradedCancel = await win.$eval('#import-wizard-cancel', (e) => e.textContent ?? '')
    check('★ 进度读取失败后仍保留任务级取消入口', degradedCancel.includes('取消导入'), degradedCancel)

    // 跟踪断了也不能把向导静默关掉：后端任务可能还在写库、还握着事务。
    await win.locator('#dbstudio-import-wizard button[aria-label="关闭"]').last().click()
    await win.keyboard.press('Escape')
    await win.waitForTimeout(150)
    check('★ 跟踪中断后点 ✕ / Esc 也不能关闭向导', await wizardOpen())
    const degradedStatus = await statusText()
    check(
      '★ 关闭被拒绝时说明任务仍在后台运行',
      degradedStatus.includes('仍在后台运行'),
      degradedStatus
    )

    // 重试把跟踪接回去：用的是**原来那个** taskId，不会新建任务。
    await clickStart()
    await win.waitForFunction(
      () =>
        document
          .getElementById('import-wizard-progress-text')
          ?.textContent?.includes('已完成') === true,
      { timeout: 10000 }
    )
    check('★ 重试后读到了终态', (await wizardProgress()).text.includes('已完成'))
    const retriedStatus = await statusText()
    check('★ 重试后状态栏给出导入结论', retriedStatus.includes('导入完成'), retriedStatus)
    await closeWizard()
    check('★ 任务收口后向导可以关闭', (await wizardOpen()) === false)
  }

  console.log('\n[8c] 终态读取失败：保留任务跟踪，可重试读取结果')
  {
    await setImportTestControl({ waitFailures: 1 })
    await rightClickTreeNode('wait_failure')
    const opened = await clickMenuItem('导入 CSV')
    check('★ 能打开终态失败用例向导', opened)
    await win.waitForSelector('#dbstudio-import-wizard', { state: 'attached', timeout: 5000 })
    await win.fill('#import-wizard-path', simpleCsvPath)
    await win.fill('#import-wizard-columns', 'id\nname')
    await clickStart()
    await win.waitForFunction(
      () =>
        document
          .getElementById('import-wizard-errors')
          ?.textContent?.includes('读取最终结果失败') === true,
      { timeout: 10000 }
    )
    check('★ 终态读取失败后向导仍然打开（收尾没有收口）', await wizardOpen())
    const degradedStart = await win.$eval('#import-wizard-start', (e) => e.textContent ?? '')
    check(
      '★ 终态读取失败后「开始导入」变成「重试读取结果」',
      degradedStart.includes('重试读取结果'),
      degradedStart
    )
    await win.locator('#dbstudio-import-wizard button[aria-label="关闭"]').last().click()
    await win.waitForTimeout(150)
    check('★ 收尾中点 ✕ 也不能关闭向导', await wizardOpen())

    await clickStart()
    await win.waitForFunction(
      () =>
        document
          .getElementById('import-wizard-progress-text')
          ?.textContent?.includes('已完成') === true,
      { timeout: 10000 }
    )
    const retriedStatus = await statusText()
    check('★ 重试后拿到了导入结论', retriedStatus.includes('导入完成'), retriedStatus)
    check('重试读取结果成功后浏览恢复可用', !(await win.locator('#import-wizard-browse').isDisabled()))
    await win.fill('#import-wizard-path', retryCsv2)
    await setImportTestControl({ waitFailures: 2 })
    await clickStart()
    await win.waitForFunction(() => document.getElementById('import-wizard-errors')?.textContent?.includes('读取最终结果失败'))
    check('结果仍未知时浏览禁用且保留重试', await win.locator('#import-wizard-browse').isDisabled() && !(await win.locator('#import-wizard-start').isDisabled()))
    await clickStart()
    await win.waitForFunction(() => !document.getElementById('import-wizard-browse')?.disabled)
    check('进度确认终态的兜底后浏览恢复', !(await win.locator('#import-wizard-browse').isDisabled()))
    check('兜底如实说明结果详情读取失败', (await statusText()).includes('结果详情读取失败'))
    check('兜底对应导入数据已写入', countRows('wait_failure') === 3)
    await closeWizard()
    check('★ 收口后向导可以关闭', (await wizardOpen()) === false)
  }

  console.log('\n[8d] 已拿到 taskId 的运行中任务也不能用 ✕ 静默关闭')
  {
    await setImportTestControl({ runningProgressCalls: 5 })
    await rightClickTreeNode('running_guard')
    const opened = await clickMenuItem('导入 CSV')
    check('★ 能打开运行中关闭策略用例向导', opened)
    await win.waitForSelector('#dbstudio-import-wizard', { state: 'attached', timeout: 5000 })
    await win.fill('#import-wizard-path', simpleCsvPath)
    await win.fill('#import-wizard-columns', 'id\nname')
    await clickStart()
    await win.waitForFunction(
      () =>
        document
          .getElementById('import-wizard-progress-text')
          ?.textContent?.includes('导入中') === true,
      { timeout: 5000 }
    )
    await win.locator('#dbstudio-import-wizard button[aria-label="关闭"]').last().click()
    await win.waitForTimeout(100)
    check('★ 运行中点 ✕ 后向导仍然打开', await wizardOpen())
    await win.waitForFunction(
      () => {
        const button = document.getElementById('import-wizard-start')
        return button instanceof HTMLButtonElement && !button.disabled
      },
      { timeout: 5000 }
    )
    check('正常完成后浏览按钮恢复可用', !(await win.locator('#import-wizard-browse').isDisabled()))
    await setImportTestControl({ chooserMode: 'success', chooserPath: retryCsv2 })
    await win.click('#import-wizard-browse')
    await win.waitForFunction((path) => document.getElementById('import-wizard-path')?.value === path, retryCsv2)
    check('正常完成后可浏览选择第二文件', (await win.$eval('#import-wizard-path', (e) => e.value)) === retryCsv2)
    await win.waitForFunction(() => !document.getElementById('import-wizard-start')?.disabled)
    check('第二文件生成新的两行预览', await win.locator('#import-wizard-preview-table tbody tr').count() === 2)
    await clickStart()
    const secondCompleted = await waitCompleted()
    check('正常完成后浏览第二文件可再次导入', secondCompleted && countRows('running_guard') === 3)
    await closeWizard()
    check('★ 运行结束后可以正常关闭', (await wizardOpen()) === false)
  }

  console.log('\n[8e] describeTable latest-wins：慢响应不能覆盖后选中的表')
  {
    await setImportTestControl({ describeDelayTable: 'people', describeDelayMs: 1200 })
    await rightClickTreeNode('people')
    const firstSelected = await clickMenuItem('导入 CSV')
    check('★ 先选中 people', firstSelected)
    await rightClickTreeNode('guarded')
    const secondSelected = await clickMenuItem('导入 CSV')
    check('★ 随后选中 guarded', secondSelected)
    await win.waitForSelector('#dbstudio-import-wizard', { state: 'attached', timeout: 5000 })
    await win.waitForTimeout(1600)
    const latestSource = await win.$eval('#import-wizard-source', (e) => e.textContent ?? '')
    check('★ 慢响应返回后仍显示最后选中的 guarded', latestSource.includes('guarded'), latestSource)
    check(
      '★ latest-wins 期间页面仍然只有一个向导',
      (await win.locator('#dbstudio-import-wizard').count()) === 1
    )
    await closeWizard()
    await setImportTestControl({ describeDelayMs: 0, describeDelayTable: '' })
  }

  console.log('\n[8f] 跟踪中断后仍能任务级取消，并收口到终态')
  {
    // 让第一次读进度失败 → 向导进入「跟踪中断」，但后端那个大批量任务还在跑。
    // 这正是旧实现最危险的地方：清掉 taskId 之后，这个还握着事务的任务
    // 就再也点不到取消了。
    await setImportTestControl({ progressFailures: 1 })
    await rightClickTreeNode('cancel_guard')
    const opened = await clickMenuItem('导入 CSV')
    check('★ 能打开取消用例向导', opened)
    await win.waitForSelector('#dbstudio-import-wizard', { state: 'attached', timeout: 5000 })
    await win.fill('#import-wizard-path', bulkCsvPath)
    await win.fill('#import-wizard-columns', 'id\nname')
    await clickStart()
    await win.waitForFunction(
      () =>
        document
          .getElementById('import-wizard-errors')
          ?.textContent?.includes('无法继续跟踪本次导入') === true,
      { timeout: 5000 }
    )
    check('★ 跟踪中断后向导仍然打开', await wizardOpen())
    const degradedCancel = await win.$eval('#import-wizard-cancel', (e) => e.textContent ?? '')
    check('★ 跟踪中断后「取消」是任务级取消入口', degradedCancel.includes('取消导入'), degradedCancel)

    await win.locator('#import-wizard-cancel').last().click()
    await win.waitForFunction(
      () => {
        const text = document.getElementById('status-bar')?.textContent ?? ''
        return (
          text.includes('已请求取消导入') ||
          text.includes('取消未被接受') ||
          text.includes('取消导入失败')
        )
      },
      { timeout: 5000 }
    )
    const cancelStatus = await statusText()
    const cancelAccepted = cancelStatus.includes('已请求取消导入')
    check(
      '★ 跟踪中断后仍能发起任务级取消',
      cancelAccepted || cancelStatus.includes('取消未被接受'),
      cancelStatus
    )

    if (!cancelAccepted) {
      // 取消没赶上（任务已经自己跑完）：用「重试」把跟踪接回去，读终态。
      await clickStart()
    }
    await win.waitForFunction(
      () => {
        const text = document.getElementById('import-wizard-progress-text')?.textContent ?? ''
        return text.includes('已取消') || text.includes('已完成') || text.includes('失败')
      },
      { timeout: 30000 }
    )
    const finalProgress = await wizardProgress()
    check(
      '★ 取消收口后任务进入终态',
      finalProgress.text.includes('已取消') || finalProgress.text.includes('已完成'),
      JSON.stringify(finalProgress)
    )
    await win.waitForTimeout(300)
    const bulkRows = countRows('cancel_guard')
    check(
      '★ 取消后目标表没有留下半截数据',
      bulkRows === 0 || bulkRows === BULK_ROWS,
      String(bulkRows)
    )
    await closeWizard()
    check('★ 取消收口后向导可以关闭', (await wizardOpen()) === false)
  }

  console.log('\n[8g] 跟踪失败 → 恢复（重试）→ 终态 → 再次导入')
  {
    /**
     * 这一段验的是**生命周期闭环**：
     *   跟踪断了（trackingError）→ 用户重试接回跟踪 → 读到终态 → 向导回到 idle
     *   → 还能**再导入一次**。
     *
     * 为什么必须专门测「再导入一次」：
     * 收尾时如果只清了 taskId 却留着 trackingError，「开始导入」按钮就会去
     * 重试一个**已经不存在的任务**——按钮变成死按钮，
     * **一次成功的收尾反而让向导再也导不了下一次**。
     * 所以这里不只看状态栏文案，而是真的再点一次「开始导入」，
     * 断言新一批数据真的进了表。
     */
    await setImportTestControl({ progressFailures: 1 })
    await rightClickTreeNode('retry_guard')
    const opened = await clickMenuItem('导入 CSV')
    check('★ 能打开恢复用例向导', opened)
    await win.waitForSelector('#dbstudio-import-wizard', { state: 'attached', timeout: 5000 })
    await win.fill('#import-wizard-path', retryCsv1)
    await win.fill('#import-wizard-columns', 'id\nname')
    await clickStart()
    await win.waitForFunction(
      () =>
        document
          .getElementById('import-wizard-errors')
          ?.textContent?.includes('无法继续跟踪本次导入') === true,
      { timeout: 5000 }
    )
    check('★ 跟踪中断后向导仍然打开（任务仍在后台）', await wizardOpen())
    const degradedStart = await win.$eval('#import-wizard-start', (e) => e.textContent ?? '')
    check(
      '★ 跟踪中断后「开始导入」变成重试入口',
      degradedStart.includes('重试读取进度'),
      degradedStart
    )

    // 关闭守卫保留：跟踪断了也**不能**把向导静默关掉（后端任务可能还握着事务）。
    await win.locator('#dbstudio-import-wizard button[aria-label="关闭"]').last().click()
    await win.waitForTimeout(150)
    check('★ 跟踪中断后点 ✕ 也不能关闭向导', await wizardOpen())

    await win.fill('#import-wizard-columns', '不存在的目标列')
    check('跟踪中断后无效映射不会锁住重试按钮', !(await win.locator('#import-wizard-start').isDisabled()))
    await win.fill('#import-wizard-columns', 'id\nname')

    // 重试：接回跟踪 → 读到终态。
    await clickStart()
    await win.waitForFunction(
      () =>
        document
          .getElementById('import-wizard-progress-text')
          ?.textContent?.includes('已完成') === true,
      { timeout: 10000 }
    )
    check('★ 重试后读到终态', (await wizardProgress()).text.includes('已完成'))

    // 关键断言：收尾之后向导必须回到**可再次导入**的 idle 状态。
    const settledStart = await win.$eval('#import-wizard-start', (e) => ({
      text: e.textContent ?? '',
      disabled: e.disabled
    }))
    check(
      '★ 收尾后「开始导入」恢复成可点的开始按钮',
      settledStart.text.includes('开始导入') && !settledStart.disabled,
      JSON.stringify(settledStart)
    )
    const settledErrors = await wizardErrors()
    check(
      '★ 收尾后跟踪失败警告不再挂着',
      settledErrors.hidden === true,
      JSON.stringify(settledErrors)
    )
    check(
      '★ 第一次导入的数据进了表',
      countRows('retry_guard') === 2,
      String(countRows('retry_guard'))
    )

    // 再次导入：这一次必须真的跑起来（不是死按钮）。
    await win.fill('#import-wizard-path', retryCsv2)
    // 让前几次进度读取停在「运行中」，好在中途验证关闭守卫。
    await setImportTestControl({ runningProgressCalls: 5 })
    await clickStart()
    await win.waitForTimeout(300)
    await win.locator('#dbstudio-import-wizard button[aria-label="关闭"]').last().click()
    await win.waitForTimeout(100)
    check('★ 再次导入运行中点 ✕ 也不能关闭向导', await wizardOpen())
    const secondDone = await waitCompleted()
    const secondStatus = await statusText()
    check('★ 再次导入成功', secondDone && secondStatus.includes('导入完成'), secondStatus)
    check(
      '★ 再次导入的数据也进了表',
      countRows('retry_guard') === 4,
      String(countRows('retry_guard'))
    )
    await closeWizard()
    check('★ 再次导入收口后向导可以关闭', (await wizardOpen()) === false)
  }

  console.log('\n[8h] 跟踪失败 → 取消 → 终态 → 再次导入')
  {
    /**
     * 取消是**任务级**的出口：跟踪断了也必须能停掉那个还在写库的任务。
     * 这一段在 [8f] 之上再往前推一步：取消收口到终态之后，
     * 向导必须能**再导入一次**（不能变成死按钮）。
     */
    await setImportTestControl({ progressFailures: 1 })
    await rightClickTreeNode('cancel_retry_guard')
    const opened = await clickMenuItem('导入 CSV')
    check('★ 能打开取消恢复用例向导', opened)
    await win.waitForSelector('#dbstudio-import-wizard', { state: 'attached', timeout: 5000 })
    await win.fill('#import-wizard-path', cancelRetryCsv1)
    await win.fill('#import-wizard-columns', 'id\nname')
    await clickStart()
    await win.waitForFunction(
      () =>
        document
          .getElementById('import-wizard-errors')
          ?.textContent?.includes('无法继续跟踪本次导入') === true,
      { timeout: 5000 }
    )
    check('★ 跟踪中断后向导仍然打开', await wizardOpen())
    const degradedCancel = await win.$eval('#import-wizard-cancel', (e) => e.textContent ?? '')
    check('★ 跟踪中断后「取消」是任务级取消入口', degradedCancel.includes('取消导入'), degradedCancel)

    // 关闭守卫保留。
    await win.locator('#dbstudio-import-wizard button[aria-label="关闭"]').last().click()
    await win.waitForTimeout(150)
    check('★ 跟踪中断后点 ✕ 也不能关闭向导', await wizardOpen())

    await win.locator('#import-wizard-cancel').last().click()
    await win.waitForFunction(
      () => {
        const text = document.getElementById('status-bar')?.textContent ?? ''
        return (
          text.includes('已请求取消导入') ||
          text.includes('取消未被接受') ||
          text.includes('取消导入失败')
        )
      },
      { timeout: 5000 }
    )
    const cancelStatus = await statusText()
    check(
      '★ 跟踪中断后仍能发起任务级取消',
      cancelStatus.includes('已请求取消导入') || cancelStatus.includes('取消未被接受'),
      cancelStatus
    )

    /**
     * 收口到终态：取消被接受 → 向导继续跟踪到终态；
     * 取消没赶上（任务已经自己结束）→ 跟踪还是断的，点「重试读取进度」接回去。
     * 两条出口都必须是**能收口**的。
     */
    const terminalReached = await win
      .waitForFunction(
        () => {
          const text = document.getElementById('import-wizard-progress-text')?.textContent ?? ''
          return text.includes('已取消') || text.includes('已完成') || text.includes('失败')
        },
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false)
    if (!terminalReached) {
      await clickStart()
      await win.waitForFunction(
        () => {
          const text = document.getElementById('import-wizard-progress-text')?.textContent ?? ''
          return text.includes('已取消') || text.includes('已完成') || text.includes('失败')
        },
        { timeout: 15000 }
      )
    }
    const finalProgress = await wizardProgress()
    check(
      '★ 取消收口后任务进入终态',
      ['已取消', '已完成', '失败'].some((state) => finalProgress.text.includes(state)),
      JSON.stringify(finalProgress)
    )

    // 关键断言：收口之后向导必须回到**可再次导入**的 idle 状态。
    const settledStart = await win.$eval('#import-wizard-start', (e) => ({
      text: e.textContent ?? '',
      disabled: e.disabled
    }))
    check(
      '★ 取消收口后「开始导入」恢复成可点的开始按钮',
      settledStart.text.includes('开始导入') && !settledStart.disabled,
      JSON.stringify(settledStart)
    )
    const settledErrors = await wizardErrors()
    check(
      '★ 取消收口后跟踪失败警告不再挂着',
      settledErrors.hidden === true,
      JSON.stringify(settledErrors)
    )

    // 再次导入：必须真的跑起来（不是死按钮）。
    const rowsBefore = countRows('cancel_retry_guard')
    await win.fill('#import-wizard-path', cancelRetryCsv2)
    await clickStart()
    const secondDone = await waitCompleted()
    const secondStatus = await statusText()
    check(
      '★ 取消收口后还能再次导入',
      secondDone && secondStatus.includes('导入完成'),
      secondStatus
    )
    const rowsAfter = countRows('cancel_retry_guard')
    check(
      '★ 再次导入的数据进了表',
      rowsAfter === rowsBefore + 2,
      `${rowsBefore} → ${rowsAfter}`
    )
    await closeWizard()
    check('★ 再次导入收口后向导可以关闭', (await wizardOpen()) === false)
  }

  console.log('\n[9] 连续导入：向导开着时再打开一次，不会留下两个向导')
  {
    // ★ 实测缺陷：早先每次 openImportWizard 都追加一层遮罩，
    // 于是「打开 → 导入 → 再打开」会留下两个同 id 的向导，
    // 第二个的按钮点不动（前一个遮罩拦截 pointer events）。
    //
    // 这里**故意不关**第一个向导，直接再打开一次：
    // 正确行为是「旧向导被关掉，页面上只剩一个新的」。
    await rightClickTreeNode('people')
    const firstOpen = await clickMenuItem('导入 CSV')
    check('★ 能打开第一个向导', firstOpen)
    await win.waitForTimeout(600)
    check(
      '★ 此时只有一个向导',
      (await win.locator('#dbstudio-import-wizard').count()) === 1,
      String(await win.locator('#dbstudio-import-wizard').count())
    )

    await rightClickTreeNode('people')
    const reopened = await clickMenuItem('导入 CSV')
    check('★ 能再次打开向导', reopened)
    await win.waitForTimeout(600)
    const wizardCount = await win.locator('#dbstudio-import-wizard').count()
    check(
      '★ 页面上仍然只有一个导入向导',
      wizardCount === 1,
      `找到 ${wizardCount} 个`
    )

    // 而且新向导必须是**能用的**：点「开始导入」不能被旧遮罩拦死。
    await win.fill('#import-wizard-path', okCsvPath2)
    await win.fill('#import-wizard-columns', 'id\nname\ncity')
    await clickStart()
    await win.waitForTimeout(2500)
    const secondStatus = await statusText()
    check('★ 第二次导入也成功了', secondStatus.includes('导入完成'), secondStatus)
    // people 表原本有 2 行，这次又导入 2 行 → 4 行。
    check('★ 表里变成了 4 行', countRows('people') === 4, String(countRows('people')))
    const secondRows = readRows('people')
    check(
      '★ 两批数据都在表里',
      secondRows.length === 4 && secondRows[3].name === '赵六',
      JSON.stringify(secondRows)
    )
    await win.screenshot({ path: join(shotDir, '05-连续导入.png') })
    await closeWizard()
  }

  console.log('\n[10] 重复主键被拒绝：显示行号列名，且不留下部分数据')
  {
    // 拿**第一次**那份 CSV 再导一次：people.id 是主键，会触发 UNIQUE 约束。
    // 这是**正确**行为——但必须两件事同时成立：
    //   1. 界面说清是哪一行哪一列失败了；
    //   2. 表里**没有**多出半截数据（导入是原子的）。
    await rightClickTreeNode('people')
    const opened = await clickMenuItem('导入 CSV')
    check('★ 能打开向导', opened)
    await win.waitForSelector('#dbstudio-import-wizard', { state: 'attached', timeout: 5000 })
    await win.fill('#import-wizard-path', okCsvPath)
    await win.fill('#import-wizard-columns', 'id\nname\ncity')
    await clickStart()
    await win.waitForTimeout(3000)

    const dupProgress = await wizardProgress()
    check('★ 进度区显示失败', dupProgress.text.includes('失败'), JSON.stringify(dupProgress))
    check(
      '★ 失败位置包含行号',
      /第\s*1\s*行/.test(dupProgress.detail),
      dupProgress.detail
    )
    check(
      '★ 失败位置包含列名 id',
      dupProgress.detail.includes('id'),
      dupProgress.detail
    )
    check('★ 表里行数没变（没有部分写入）', countRows('people') === 4, String(countRows('people')))
    await win.screenshot({ path: join(shotDir, '06-主键冲突.png') })
    await closeWizard()
  }
} finally {
  await app.evaluate(() => globalThis.__restoreChooser?.()).catch(() => {})
  await app.close().catch(() => {})
}

console.log(`\n===== CSV 导入向导 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exit(1)
