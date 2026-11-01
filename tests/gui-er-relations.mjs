/**
 * ER 图真实外键关系 GUI 验收。
 *
 * 覆盖真实 SQLite 元数据到 SVG 的完整链路：关系线、复合列映射、拖动跟随、
 * 无外键空状态和重复打开不累积关系线。
 */

import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pwFile = require.resolve('playwright-core', { paths: [root] })
const pw = await import(pathToFileURL(pwFile).href)
const electron = pw._electron ?? pw.default?._electron

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dbstudio-er-'))
const relationDb = join(dir, 'relations.db')
const emptyDb = join(dir, 'empty.db')
{
  const db = new DatabaseSync(relationDb)
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE parent (
      id INTEGER NOT NULL,
      code TEXT NOT NULL,
      label TEXT,
      PRIMARY KEY (id, code)
    );
    CREATE TABLE child (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL,
      parent_code TEXT NOT NULL,
      value TEXT,
      CONSTRAINT fk_child_parent FOREIGN KEY (parent_id, parent_code)
        REFERENCES parent (id, code)
        ON DELETE CASCADE ON UPDATE CASCADE
    );
    INSERT INTO parent VALUES (1, 'A', 'parent');
    INSERT INTO child VALUES (10, 1, 'A', 'child');
  `)
  db.close()
}
{
  const db = new DatabaseSync(emptyDb)
  db.exec('CREATE TABLE standalone (id INTEGER PRIMARY KEY, value TEXT);')
  db.close()
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.DBSTUDIO_TEST_HIDDEN = '1'
const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', `--user-data-dir=${join(dir, 'ud')}`],
  cwd: root,
  env
})
const win = await app.firstWindow()
win.on('dialog', (dialog) => void dialog.accept())
await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })

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
  await win.waitForTimeout(600)
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
  await win.waitForTimeout(300)
  const clicked = await win.evaluate(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.trim() === '查看 ER 图'
    )
    if (!item || item.getAttribute('aria-disabled') === 'true') return false
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  if (!clicked) return false
  await win.waitForSelector('#er-area svg[data-er-root]', { state: 'attached', timeout: 15000 })
  await win.waitForTimeout(500)
  return true
}

await connect('RELATIONS', relationDb)
check('建立带复合外键的 SQLite 连接', await openEr('RELATIONS'))

const relationState = await win.evaluate(() => ({
  status: document.querySelector('#er-area [data-er-status]')?.getAttribute('data-er-status'),
  paths: [...document.querySelectorAll('#er-area .er-relation')].map((path) => ({
    d: path.getAttribute('d'),
    columns: path.getAttribute('data-columns'),
    source: path.getAttribute('data-source-table'),
    target: path.getAttribute('data-target-table'),
    title: path.querySelector('title')?.textContent
  })),
  tables: [...document.querySelectorAll('#er-area .er-entity')].map((entity) => entity.getAttribute('data-table-name'))
}))
check('ER 图声明存在真实外键关系', relationState.status === 'relations', JSON.stringify(relationState))
check('两张相关表均已绘制', relationState.tables.includes('parent') && relationState.tables.includes('child'), JSON.stringify(relationState.tables))
check('绘制一条关系线且来源/目标正确', relationState.paths.length === 1 && relationState.paths[0]?.source === 'child' && relationState.paths[0]?.target === 'parent', JSON.stringify(relationState.paths))
check(
  '复合外键保留两组列映射和约束信息',
  relationState.paths[0]?.columns?.includes('parent_id → id') &&
    relationState.paths[0]?.columns?.includes('parent_code → code') &&
    relationState.paths[0]?.title?.includes('删除 CASCADE') &&
    relationState.paths[0]?.title?.includes('更新 CASCADE'),
  JSON.stringify(relationState.paths[0])
)

const beforeDrag = relationState.paths[0]?.d
const childBox = await win.locator('#er-area .er-entity[data-table-name="child"]').boundingBox()
if (childBox) {
  await win.mouse.move(childBox.x + childBox.width / 2, childBox.y + childBox.height / 2)
  await win.mouse.down()
  await win.mouse.move(childBox.x + childBox.width / 2 + 90, childBox.y + childBox.height / 2 + 40)
  await win.mouse.up()
  await win.waitForTimeout(150)
}
const afterDrag = await win.locator('#er-area .er-relation').getAttribute('d')
check('拖动表框后关系线端点跟随变化', !!childBox && beforeDrag !== afterDrag, `${beforeDrag} → ${afterDrag}`)

const beforeLargeDrag = await win.evaluate(() => ({
  svgWidth: Number(document.querySelector('#er-area svg')?.getAttribute('width') ?? 0),
  svgHeight: Number(document.querySelector('#er-area svg')?.getAttribute('height') ?? 0)
}))
if (childBox) {
  await win.mouse.move(childBox.x + childBox.width / 2 + 90, childBox.y + childBox.height / 2 + 40)
  await win.mouse.down()
  await win.mouse.move(childBox.x + childBox.width / 2 + 780, childBox.y + childBox.height / 2 + 520)
  await win.mouse.up()
  await win.waitForTimeout(150)
}
const afterLargeDrag = await win.evaluate(() => ({
  svgWidth: Number(document.querySelector('#er-area svg')?.getAttribute('width') ?? 0),
  svgHeight: Number(document.querySelector('#er-area svg')?.getAttribute('height') ?? 0)
}))
check(
  '拖出初始画布后 SVG 会扩容，表框仍可找回',
  !!childBox && (afterLargeDrag.svgWidth > beforeLargeDrag.svgWidth || afterLargeDrag.svgHeight > beforeLargeDrag.svgHeight),
  `${JSON.stringify(beforeLargeDrag)} → ${JSON.stringify(afterLargeDrag)}`
)

const movedTransform = await win.locator('#er-area .er-entity[data-table-name="child"]').getAttribute('transform')
await openEr('RELATIONS')
const refreshedCount = await win.locator('#er-area .er-relation').count()
check('重复打开 ER 图不会累积关系线', refreshedCount === 1, String(refreshedCount))
const restoredTransform = await win.locator('#er-area .er-entity[data-table-name="child"]').getAttribute('transform')
check('重新打开 ER 图恢复已保存的节点坐标', movedTransform === restoredTransform, `${movedTransform} → ${restoredTransform}`)

await connect('EMPTY', emptyDb)
check('建立无外键连接并打开 ER 图', await openEr('EMPTY'))
const emptyState = await win.evaluate(() => ({
  status: document.querySelector('#er-area [data-er-status]')?.getAttribute('data-er-status'),
  paths: document.querySelectorAll('#er-area .er-relation').length,
  text: document.querySelector('#er-area [data-er-status]')?.textContent
}))
check(
  '无外键时显示明确空状态',
  emptyState.status === 'none' && emptyState.paths === 0 && emptyState.text?.includes('无关系'),
  JSON.stringify(emptyState)
)

await app.close()
console.log(`\nER 图 GUI 验收：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
