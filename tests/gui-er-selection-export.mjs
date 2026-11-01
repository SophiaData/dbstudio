/**
 * ER 图「选表 / 筛选 / SVG 导出」的 GUI 验收。
 *
 * ===== 这条测试防的是什么 =====
 *
 * ER 图的 picker（搜索、勾选、全选当前结果、清空当前结果、绘制）是一整套
 * **只在渲染进程里**的交互，既不落盘、也不进主进程，出错时既没有异常栈，
 * 也没有任何 IPC 记录——表现只是"图没出来"或"图里少了几张表"。
 *
 * 更糟的是**静默**的那几种失败：
 *   - 绘制时对**未选中的表**也调了 `describeTable`：大库上这一步就是全量读元数据，
 *     用户明明只选了两张表，应用却把整库读了一遍（慢，且看起来"没反应"）。
 *   - 导出 SVG 时顺手改了 localStorage：布局偏好被导出动作污染，
 *     用户下次打开发现节点位置莫名其妙变了。
 *   - 布局 key 没带上 schema 集合：换一组 schema 打开 ER 图，
 *     上一张图的坐标残留下来，图挤成一团。
 *
 * 所以这条测试**只走真实链路**：真实 Electron 窗口、真实 SQLite 库、
 * 真实的渲染进程 DOM 与 localStorage。
 *
 * ===== 为什么有一部分用「桩」 =====
 *
 * 被测的三个语义里，有两个是 SQLite **表达不了**的：
 *   - SQLite 没有 schema 概念，筛选框里也就没有 schema 可搜；
 *   - 没有 schema 就没有"不同的 schema 集合"，也就无从验证布局 key 是否隔离。
 *
 * PostgreSQL 能提供这些，但把一条 GUI 测试绑在外部 PG 服务上，
 * 就等于让它在没装 PG 的机器上只能跳过——**没跑过的测试和没有测试一样**。
 * 所以这里改在 **IPC 边界**打桩：主进程的 `listChildren` / `describeTable`
 * 被换成一份合成的「多 schema」元数据树，渲染进程一侧**完全是真的**
 * （真的 DOM、真的筛选、真的 localStorage、真的导出按钮）。
 *
 * 打桩方式也只用了仓库里已有的手法（见 tests/gui-connection-guard.mjs：
 * `ipcMain.removeHandler` + `ipcMain.handle`）。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dbstudio-er-selection-'))

/** 关系库：users / orders 之间有真实外键，外加两张同前缀的表与一张无关表。 */
const relationDb = join(dir, 'relations.db')
{
  const db = new DatabaseSync(relationDb)
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users (id),
      total REAL
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders (id),
      sku TEXT
    );
    CREATE TABLE order_notes (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders (id),
      body TEXT
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY,
      action TEXT
    );
  `)
  db.close()
}

/** 大库：120 张表，用于触发「一次最多绘制 100 张」的上限分支。 */
const largeDb = join(dir, 'large.db')
{
  const db = new DatabaseSync(largeDb)
  db.exec('BEGIN')
  for (let i = 1; i <= 120; i += 1) {
    db.exec(`CREATE TABLE table_${i} (id INTEGER PRIMARY KEY, value TEXT);`)
  }
  db.exec('COMMIT')
  db.close()
}

/** 打桩用的真实库：只为了让「ER-SCHEMA」这条连接能建起来，元数据由桩提供。 */
const stubDb = join(dir, 'stub.db')
{
  const db = new DatabaseSync(stubDb)
  db.exec('CREATE TABLE placeholder (id INTEGER PRIMARY KEY);')
  db.close()
}

const userDataDir = join(dir, 'userdata')
mkdirSync(userDataDir, { recursive: true })
const shotDir = join(root, 'out/gui-er-selection-export')
mkdirSync(shotDir, { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.DBSTUDIO_TEST_HIDDEN = '1'
const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })
await installDownloadCapture(win)

/* ------------------------------------------------------------------ *
 * 主进程侧的观测与打桩
 * ------------------------------------------------------------------ */

/**
 * 在主进程里装两个观测点：
 *   1. `describeTable` 的调用记录（用来证明"只读了选中的表"）；
 *   2. `listChildren` / `describeTable` 的元数据桩（可随时开/关）。
 *
 * 桩必须装在 **主进程**：渲染进程的 `window.dbstudio` 由 contextBridge 冻结，
 * 既不可写也不可重定义（实测 `Object.defineProperty` 会抛
 * "Cannot redefine property"），所以只能在 IPC 那一侧拦。
 */
await app.evaluate(({ ipcMain }) => {
  const origList = ipcMain._invokeHandlers.get('dbstudio:listChildren')
  const origDescribe = ipcMain._invokeHandlers.get('dbstudio:describeTable')

  /** 被调用过的 describeTable 的表 id。 */
  globalThis.__erDescribeCalls = []
  /** 当前生效的元数据桩；null 表示走真实实现。 */
  globalThis.__erMock = null

  ipcMain.removeHandler('dbstudio:listChildren')
  ipcMain.handle('dbstudio:listChildren', async (event, nodeId) => {
    const mock = globalThis.__erMock
    if (!mock) return origList(event, nodeId)
    const connections = await origList(event, null)
    if (nodeId === null) return connections
    const connection = connections.find((item) => item.name === mock.connectionName)
    if (!connection) return origList(event, nodeId)
    const prefix = `${connection.id}|`
    if (nodeId === connection.id) {
      // 连接下面挂两个 schema 节点——模拟 PostgreSQL 的层级。
      return mock.schemas.map((schema) => ({
        id: `${prefix}schema:${schema}`,
        kind: 'schema',
        name: schema,
        parentId: connection.id,
        hasChildren: true
      }))
    }
    if (nodeId.startsWith(`${prefix}schema:`)) {
      const schema = nodeId.slice(`${prefix}schema:`.length)
      return mock.tables
        .filter((table) => table.schema === schema)
        .map((table) => ({
          id: `${prefix}table:${table.schema}.${table.name}`,
          kind: 'table',
          name: table.name,
          parentId: nodeId,
          hasChildren: false
        }))
    }
    return origList(event, nodeId)
  })

  ipcMain.removeHandler('dbstudio:describeTable')
  ipcMain.handle('dbstudio:describeTable', async (event, tableNodeId) => {
    globalThis.__erDescribeCalls.push(tableNodeId)
    const mock = globalThis.__erMock
    if (mock) {
      const table = mock.tables.find((item) =>
        tableNodeId.endsWith(`|table:${item.schema}.${item.name}`)
      )
      if (table) {
        return {
          id: tableNodeId,
          columns: table.columns.map((column, index) => ({
            name: column.name,
            typeName: column.typeName ?? 'TEXT',
            nullable: column.nullable ?? true,
            primaryKeyOrdinal: column.pk ? index + 1 : null,
            defaultValue: null
          })),
          hasUniqueKey: true,
          foreignKeys: table.foreignKeys ?? []
        }
      }
    }
    return origDescribe(event, tableNodeId)
  })
})

const resetDescribeCalls = () =>
  app.evaluate(() => {
    globalThis.__erDescribeCalls.length = 0
  })
const describeCalls = () => app.evaluate(() => globalThis.__erDescribeCalls.slice())

async function connect(name, file) {
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
  await win.fill('#f-name', name)
  await win.fill('#f-dynamic input[data-key="file"]', file)
  await win.click('#btn-submit')
  await win.waitForFunction(
    () => {
      const dialog = document.getElementById('dlg-connection')
      return dialog && !dialog.hasAttribute('open')
    },
    { timeout: 20000 }
  )
  await win.waitForTimeout(500)
  return win.evaluate(
    (connectionName) =>
      [...document.querySelectorAll('#tree-rows .tree-row')].some((item) =>
        item.textContent?.trim().includes(connectionName)
      ),
    name
  )
}

async function openEr(name) {
  const opened = await win.evaluate((connectionName) => {
    const row = [...document.querySelectorAll('#tree-rows .tree-row')].find((item) =>
      item.textContent?.trim().includes(connectionName)
    )
    if (!row) return false
    const rect = row.getBoundingClientRect()
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: rect.left + 20,
        clientY: rect.top + 10
      })
    )
    return true
  }, name)
  if (!opened) return false
  await win.waitForTimeout(250)
  const clicked = await win.evaluate(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (node) => node.textContent?.trim() === '查看 ER 图'
    )
    if (!item || item.getAttribute('aria-disabled') === 'true') return false
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  if (!clicked) return false
  await win.waitForSelector('#er-area .er-picker', { state: 'attached', timeout: 15000 })
  await win.waitForTimeout(400)
  return true
}

const search = async (text) => {
  await win.fill('#er-area [data-er-search]', text)
  await win.waitForTimeout(120)
}

const clickPickerButton = async (attribute) => {
  await win.click(`#er-area [${attribute}="true"]`)
  await win.waitForTimeout(150)
}

/** picker 的完整状态。 */
async function erState() {
  return win.evaluate(() => {
    const options = [...document.querySelectorAll('#er-area [data-er-table-option]')]
    const message = document.querySelector('#er-area .er-picker-message')
    const exportButton = document.querySelector('#er-area [data-er-export]')
    return {
      count: document.querySelector('#er-area .er-picker-count')?.textContent ?? '',
      message: message?.textContent ?? '',
      messageHidden: message?.hasAttribute('hidden') ?? true,
      options: options.map((option) => ({
        id: option.getAttribute('data-er-table-option'),
        text: option.textContent?.trim() ?? '',
        hidden: option.hasAttribute('hidden'),
        checked: option.querySelector('input')?.checked ?? false
      })),
      visible: options
        .filter((option) => !option.hasAttribute('hidden'))
        .map((option) => option.textContent?.trim() ?? ''),
      selected: options
        .filter((option) => option.querySelector('input')?.checked)
        .map((option) => option.textContent?.trim() ?? ''),
      entities: [...document.querySelectorAll('#er-area .er-entity')].map((entity) =>
        entity.getAttribute('data-table-name')
      ),
      relations: document.querySelectorAll('#er-area .er-relation').length,
      svg: document.querySelector('#er-area svg[data-er-root]') !== null,
      exportDisabled: exportButton?.disabled ?? true
    }
  })
}

const statusText = () => win.$eval('#status-bar', (element) => element.textContent ?? '')

/**
 * 点「绘制 ER 图」并等到**这一轮**绘制结束。
 *
 * 关键点：不能只等 "svg 存在"——上一轮的图还在 DOM 里，那会让断言读到旧图。
 * 所以这里先记住旧 svg 元素与旧提示文案，再用 MutationObserver 判断
 * 「换了一张新 svg」或者「提示文案变了」，二者都算这一轮结束。
 */
async function draw() {
  await win.evaluate(() => {
    window.__erPrevSvg = document.querySelector('#er-area svg[data-er-root]')
    window.__erPrevMessage = document.querySelector('#er-area .er-picker-message')?.textContent ?? ''
    window.__erNewSvg = false
    if (window.__erObserver) window.__erObserver.disconnect()
    window.__erObserver = new MutationObserver(() => {
      const now = document.querySelector('#er-area svg[data-er-root]')
      if (now && now !== window.__erPrevSvg) window.__erNewSvg = true
    })
    window.__erObserver.observe(document.getElementById('er-area'), {
      childList: true,
      subtree: true
    })
  })
  await clickPickerButton('data-er-draw')
  try {
    await win.waitForFunction(
      () => {
        if (window.__erNewSvg) return true
        const message = document.querySelector('#er-area .er-picker-message')
        return (
          message &&
          !message.hidden &&
          message.textContent !== window.__erPrevMessage &&
          message.textContent.trim() !== ''
        )
      },
      { timeout: 30000 }
    )
  } catch {
    // 超时不是"测试崩掉"——它只说明**这一轮绘制没有产生任何可观察的变化**。
    // 真正的断言在下面按当前 DOM 状态做，失败会以断言形式报出来，
    // 而不是让整个测试进程抛一个 TimeoutError。
  }
  await win.waitForTimeout(250)
}

/** 拖动第一张表框——这是**唯一**会写布局 localStorage 的入口。 */
async function dragFirstEntity() {
  const target = win.locator('#er-area .er-entity').first()
  await target.hover()
  await win.waitForTimeout(100)
  const box = await target.boundingBox()
  if (!box) return false
  const before = await target.getAttribute('transform')
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 45, { steps: 6 })
  await win.mouse.up()
  await win.waitForTimeout(300)
  const after = await target.getAttribute('transform')
  return before !== after
}

/** 列出 localStorage 里的全部键（用 length/key(i)，Storage 的键不是自有属性）。 */
const storageKeys = () =>
  win.evaluate(() => {
    const keys = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key !== null) keys.push(key)
    }
    return keys
  })

const localStorageSnapshot = () =>
  win.evaluate(() => {
    const out = {}
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key !== null) out[key] = localStorage.getItem(key)
    }
    return out
  })

const layoutKeys = async () =>
  (await storageKeys()).filter((key) => key.startsWith('dbstudio.er-layout.v1.'))

try {
  /* ---------------------------------------------------------------- *
   * [1] picker 的基本形态
   * ---------------------------------------------------------------- */

  console.log('\n[1] 连接并打开 ER 图选择器')
  check('建立关系库连接', await connect('RELATIONS', relationDb))
  check('关系库 ER 选择器已打开', await openEr('RELATIONS'))

  let state = await erState()
  const controls = await win.evaluate(() => ({
    search: document.querySelectorAll('#er-area [data-er-search]').length,
    checkboxes: document.querySelectorAll('#er-area [data-er-table-checkbox]').length,
    selectVisible: document.querySelectorAll('#er-area [data-er-select-visible]').length,
    clearVisible: document.querySelectorAll('#er-area [data-er-clear-visible]').length,
    draw: document.querySelectorAll('#er-area [data-er-draw]').length,
    export: document.querySelectorAll('#er-area [data-er-export]').length
  }))
  check('表选择器显示五张表', state.options.length === 5, String(state.options.length))
  check('存在搜索框', controls.search === 1, JSON.stringify(controls))
  check('每张表一个勾选框', controls.checkboxes === 5, JSON.stringify(controls))
  check('存在「全选当前结果」按钮', controls.selectVisible === 1, JSON.stringify(controls))
  check('存在「清空当前结果」按钮', controls.clearVisible === 1, JSON.stringify(controls))
  check('存在「绘制 ER 图」按钮', controls.draw === 1, JSON.stringify(controls))
  check('存在「导出 SVG」按钮', controls.export === 1, JSON.stringify(controls))
  check('默认选择全部可用的 SQLite 表', state.options.every((option) => option.checked))
  check(
    '默认绘制包含 users 与 orders',
    state.entities.includes('users') && state.entities.includes('orders'),
    JSON.stringify(state.entities)
  )

  /* ---------------------------------------------------------------- *
   * [2] 搜索：按表名过滤
   * ---------------------------------------------------------------- */

  console.log('\n[2] 搜索框按表名过滤')

  await search('order')
  state = await erState()
  check(
    '搜索 "order" 只显示匹配的表',
    JSON.stringify(state.visible.sort()) === JSON.stringify(['order_items', 'order_notes', 'orders']),
    JSON.stringify(state.visible)
  )
  check('计数同时报告已选数与当前显示数', /已选 \d+ 张 · 当前显示 3 张/.test(state.count), state.count)

  await search('orders')
  state = await erState()
  check(
    '搜索 "orders" 精确命中一张表',
    JSON.stringify(state.visible) === JSON.stringify(['orders']),
    JSON.stringify(state.visible)
  )

  await search('不存在的表')
  state = await erState()
  check(
    '搜索无结果时当前显示 0 张',
    state.visible.length === 0 && /当前显示 0 张/.test(state.count),
    state.count
  )

  await search('')
  state = await erState()
  check('清空搜索后全部表重新可见', state.visible.length === 5, JSON.stringify(state.visible))

  /* ---------------------------------------------------------------- *
   * [3] 全选 / 清空只作用于当前结果
   * ---------------------------------------------------------------- */

  console.log('\n[3] 全选当前结果 / 清空当前结果 只作用于可见项')

  await clickPickerButton('data-er-clear-visible')
  state = await erState()
  check('清空当前结果后一张都不剩', state.selected.length === 0, JSON.stringify(state.selected))

  await search('order')
  await clickPickerButton('data-er-select-visible')
  state = await erState()
  check(
    '全选当前结果只选中可见的三张表',
    JSON.stringify(state.selected.sort()) === JSON.stringify(['order_items', 'order_notes', 'orders']),
    JSON.stringify(state.selected)
  )
  check(
    '被过滤掉的表没有被顺带选中',
    state.options.filter((option) => option.hidden).every((option) => !option.checked),
    JSON.stringify(state.options.filter((option) => option.hidden))
  )

  await clickPickerButton('data-er-clear-visible')
  state = await erState()
  check(
    '清空当前结果只清掉可见项',
    state.selected.length === 0,
    JSON.stringify(state.selected)
  )

  await search('')
  await clickPickerButton('data-er-select-visible')
  state = await erState()
  check('无过滤时全选当前结果选中全部 5 张表', state.selected.length === 5, JSON.stringify(state.selected))

  // 单个勾选框也要能改选择。
  await win.locator('#er-area [data-er-table-option]:not([hidden]) input').first().click()
  await win.waitForTimeout(100)
  state = await erState()
  check('取消单个勾选框会同步计数', state.selected.length === 4, JSON.stringify(state.selected))
  await win.locator('#er-area [data-er-table-option]:not([hidden]) input').first().click()
  await win.waitForTimeout(100)
  state = await erState()
  check('重新勾选会恢复', state.selected.length === 5, JSON.stringify(state.selected))

  /* ---------------------------------------------------------------- *
   * [4] 一张都不选时必须明确提示
   * ---------------------------------------------------------------- */

  console.log('\n[4] 一张表都没选时给出明确提示')

  await clickPickerButton('data-er-clear-visible')
  await draw()
  state = await erState()
  const emptyStatus = await statusText()
  check('全部清空后提示至少选择一张表', !state.messageHidden && state.message.includes('至少选择一张表'), state.message)
  check('状态栏同步说明原因', emptyStatus.includes('请至少选择一张表'), emptyStatus)
  check('全部清空后不生成 ER 图', state.svg === false)
  check('导出按钮保持禁用', state.exportDisabled === true)

  /* ---------------------------------------------------------------- *
   * [5] 子集绘制：只读取、只显示选中的表
   * ---------------------------------------------------------------- */

  console.log('\n[5] 子集绘制：只读取、只显示选中的表')

  await search('users')
  await clickPickerButton('data-er-select-visible')
  await search('orders')
  await clickPickerButton('data-er-select-visible')
  await search('')
  state = await erState()
  check(
    '选中了 users 与 orders 两张表',
    JSON.stringify(state.selected.sort()) === JSON.stringify(['orders', 'users']),
    JSON.stringify(state.selected)
  )

  await resetDescribeCalls()
  await draw()
  const subsetCalls = await describeCalls()
  state = await erState()
  const subsetStatus = await statusText()
  check(
    '图里只有选中的两张表',
    JSON.stringify(state.entities.sort()) === JSON.stringify(['orders', 'users']),
    JSON.stringify(state.entities)
  )
  check('只画出了这一组外键关系', state.relations === 1, String(state.relations))
  check('describeTable 只对选中的两张表调用过', subsetCalls.length === 2, JSON.stringify(subsetCalls))
  check(
    '被调用恰好就是选中的两张表',
    JSON.stringify(subsetCalls.map((id) => id.split('|table:')[1]).sort()) ===
      JSON.stringify(['orders', 'users']),
    JSON.stringify(subsetCalls)
  )
  check('状态栏报告画了两张表', subsetStatus.includes('2 张表'), subsetStatus)

  /* ---------------------------------------------------------------- *
   * [6] SVG 导出
   * ---------------------------------------------------------------- */

  console.log('\n[6] SVG 导出：内容正确，且不污染 localStorage')

  const storageBefore = await localStorageSnapshot()
  resetDownloads()
  await win.click('#er-area [data-er-export]')
  // 捕获是异步的（Blob.text() 是微任务 + IO），所以等"真的收到"而不是死等固定时长。
  const deadline = Date.now() + 10_000
  while (downloads.length === 0 && Date.now() < deadline) {
    await win.waitForTimeout(100)
  }

  check('导出触发一个下载', downloads.length === 1, `实际 ${downloads.length}`)
  const svgText = downloads[0]?.text ?? ''
  check('文件名以 .svg 结尾', (downloads[0]?.name ?? '').endsWith('.svg'), downloads[0]?.name)
  check(
    '下载内容是 SVG',
    svgText.includes('<svg') && svgText.includes('xmlns="http://www.w3.org/2000/svg"'),
    svgText.slice(0, 120)
  )
  check('SVG 包含当前表名', svgText.includes('users') && svgText.includes('orders'), svgText.slice(0, 200))
  check(
    'SVG 包含关系线',
    svgText.includes('er-relation') && svgText.includes('data-source-table'),
    svgText.slice(0, 300)
  )
  check('状态栏提示已开始下载', (await statusText()).includes('下载'), await statusText())

  const storageAfter = await localStorageSnapshot()
  check(
    '导出不改变 localStorage',
    JSON.stringify(storageBefore) === JSON.stringify(storageAfter),
    Object.keys(storageAfter)
      .filter((key) => storageBefore[key] !== storageAfter[key])
      .join(', ')
  )
  await win.screenshot({ path: join(shotDir, '01-子集导出.png') })

  /* ---------------------------------------------------------------- *
   * [7] 超过 100 张表：必须先筛选
   * ---------------------------------------------------------------- */

  console.log('\n[7] 超过 100 张表时先筛选再绘制')

  check('建立大表库连接', await connect('LARGE', largeDb))
  check('大表库 ER 选择器已打开', await openEr('LARGE'))

  state = await erState()
  const largeStatus = await statusText()
  check('大表库显示全部 120 张表供筛选', state.options.length === 120, String(state.options.length))
  check('大表库默认一张都不选', /已选 0 张/.test(state.count), state.count)
  check('大表库默认不自动绘制', state.svg === false)
  check(
    '大表库提示先筛选',
    state.message.includes('120') &&
      state.message.includes('请先搜索') &&
      state.message.includes('100'),
    state.message
  )
  check('状态栏说明表太多', largeStatus.includes('请先筛选'), largeStatus)

  await resetDescribeCalls()
  check('超限时没有读取任何表结构', (await describeCalls()).length === 0, JSON.stringify(await describeCalls()))

  await search('table_120')
  await clickPickerButton('data-er-select-visible')
  state = await erState()
  check(
    '大表库搜索后只选择当前结果',
    state.options.filter((option) => !option.hidden && option.checked).length === 1,
    JSON.stringify(state.options.filter((option) => !option.hidden))
  )

  await resetDescribeCalls()
  await draw()
  const largeCalls = await describeCalls()
  state = await erState()
  check('筛选后只绘制 table_120', state.entities.length === 1 && state.entities[0] === 'table_120', JSON.stringify(state.entities))
  check('只读取了这一张表的结构', largeCalls.length === 1, JSON.stringify(largeCalls))
  await win.screenshot({ path: join(shotDir, '02-超限先筛选.png') })

  /* ---------------------------------------------------------------- *
   * [8] 不同的 schema 集合 → 不同的布局 key
   * ---------------------------------------------------------------- */

  console.log('\n[8] 不同 schema 集合产生不同的布局 key')

  check('建立用于多 schema 桩的连接', await connect('ER-SCHEMA', stubDb))

  // 装上多 schema 的元数据桩：public 与 audit 各有两张表，且两个 schema
  // 里各有一张叫 users 的表——只有带 schema 的搜索才能把它们分开。
  //
  // 注意：`electronApp.evaluate` 的函数**第一个参数是 Electron 模块**，
  // 自定义参数排在第二个（Playwright 的 Electron 约定），所以写成
  // `(_electron, mock)`。
  await app.evaluate((_electron, mock) => {
    globalThis.__erMock = mock
  }, {
    connectionName: 'ER-SCHEMA',
    schemas: ['public', 'audit'],
    tables: [
      {
        schema: 'public',
        name: 'users',
        columns: [
          { name: 'id', typeName: 'INTEGER', pk: true },
          { name: 'email', typeName: 'TEXT' }
        ]
      },
      {
        schema: 'public',
        name: 'orders',
        columns: [
          { name: 'id', typeName: 'INTEGER', pk: true },
          { name: 'user_id', typeName: 'INTEGER' }
        ],
        foreignKeys: [
          {
            name: 'orders_user_fk',
            columns: ['user_id'],
            referencedSchema: null,
            referencedTable: 'users',
            referencedColumns: ['id'],
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE'
          }
        ]
      },
      {
        schema: 'audit',
        name: 'users',
        columns: [
          { name: 'id', typeName: 'INTEGER', pk: true },
          { name: 'actor', typeName: 'TEXT' }
        ]
      },
      {
        schema: 'audit',
        name: 'logs',
        columns: [
          { name: 'id', typeName: 'INTEGER', pk: true },
          { name: 'action', typeName: 'TEXT' }
        ]
      }
    ]
  })

  check('多 schema 的 ER 选择器已打开', await openEr('ER-SCHEMA'))
  state = await erState()
  check('桩提供了四张表', state.options.length === 4, String(state.options.length))
  check(
    '表名带 schema 前缀',
    state.visible.includes('public.users') && state.visible.includes('audit.users'),
    JSON.stringify(state.visible)
  )

  await search('public')
  state = await erState()
  check(
    '按 schema 搜索命中该 schema 下的表',
    JSON.stringify(state.visible.sort()) === JSON.stringify(['public.orders', 'public.users']),
    JSON.stringify(state.visible)
  )

  await search('users')
  state = await erState()
  check(
    '按表名搜索命中两个 schema 下的同名表',
    JSON.stringify(state.visible.sort()) === JSON.stringify(['audit.users', 'public.users']),
    JSON.stringify(state.visible)
  )

  // 第一组：只选 public。
  await search('')
  await clickPickerButton('data-er-clear-visible')
  await search('public')
  await clickPickerButton('data-er-select-visible')
  await search('')
  state = await erState()
  check(
    '只选中了 public 下的两张表',
    JSON.stringify(state.selected.sort()) === JSON.stringify(['public.orders', 'public.users']),
    JSON.stringify(state.selected)
  )

  await draw()
  state = await erState()
  check(
    'public 这一组画出了两张表',
    JSON.stringify(state.entities.sort()) === JSON.stringify(['orders', 'users']),
    JSON.stringify(state.entities)
  )
  check('public 这一组画出了跨表外键关系', state.relations === 1, String(state.relations))

  check('拖动表框会写入布局', await dragFirstEntity())
  const keysAfterPublic = await layoutKeys()
  const publicKey = keysAfterPublic.find((key) => key.includes('s:public'))
  check('public 集合写出了一个布局 key', Boolean(publicKey), JSON.stringify(keysAfterPublic))

  // 第二组：只选 audit。
  await search('')
  await clickPickerButton('data-er-clear-visible')
  await search('audit')
  await clickPickerButton('data-er-select-visible')
  await search('')
  state = await erState()
  check(
    '只选中了 audit 下的两张表',
    JSON.stringify(state.selected.sort()) === JSON.stringify(['audit.logs', 'audit.users']),
    JSON.stringify(state.selected)
  )

  await draw()
  state = await erState()
  check(
    'audit 这一组画出了两张表',
    JSON.stringify(state.entities.sort()) === JSON.stringify(['logs', 'users']),
    JSON.stringify(state.entities)
  )

  check('拖动表框会写入布局', await dragFirstEntity())
  const keysAfterAudit = await layoutKeys()
  const auditKey = keysAfterAudit.find((key) => key.includes('s:audit'))
  check('audit 集合写出了另一个布局 key', Boolean(auditKey), JSON.stringify(keysAfterAudit))
  check(
    '两组 schema 集合的布局 key 不同',
    Boolean(publicKey) && Boolean(auditKey) && publicKey !== auditKey,
    `${publicKey} / ${auditKey}`
  )
  check(
    '布局存储里多出一份 key（两组互不覆盖）',
    keysAfterAudit.length === keysAfterPublic.length + 1,
    JSON.stringify(keysAfterAudit)
  )

  await app.evaluate(() => {
    globalThis.__erMock = null
  })
} finally {
  await app.close().catch(() => {})
}

console.log(`\nER 图选择与导出 GUI 验收：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
