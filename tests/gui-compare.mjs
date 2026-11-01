/**
 * P5 比较面板 GUI：两个 SQLite 连接，跑结构比较与数据比较，
 * 确认面板只展示同步 SQL、没有执行入口，且两侧数据未被改动。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dbstudio-compare-gui-'))
const make = (name, rows, extraTable) => {
  const file = join(work, `${name}.db`)
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT NOT NULL)')
  if (extraTable) db.exec(`CREATE TABLE ${extraTable}(id INTEGER PRIMARY KEY)`)
  const insert = db.prepare('INSERT INTO items VALUES (?, ?)')
  for (const [id, label] of rows) insert.run(id, label)
  db.close()
  return file
}
const sourceFile = make('source', [[1, 'a'], [2, 'b'], [3, 'c']], 'only_source')
const targetFile = make('target', [[1, 'a'], [2, 'B'], [4, 'd']], 'only_target')
const env = { ...process.env, DBSTUDIO_TEST_HIDDEN: '1' }
delete env.ELECTRON_RUN_AS_NODE
let app
const pageErrors = []

try {
  const extraArgs = process.platform === 'linux' && env.ELECTRON_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : []
  app = await electron.launch({
    executablePath: require('electron'),
    args: [...extraArgs, '.', `--user-data-dir=${join(work, 'userdata')}`],
    cwd: root,
    env
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForSelector('#tree-rows', { state: 'attached' })
  for (const [name, file] of [['源库', sourceFile], ['目标库', targetFile]]) {
    const summary = await page.evaluate(
      (config) => window.dbstudio.addConnection(config),
      { dialectId: 'sqlite', name, options: { file } }
    )
    assert.equal(summary.connected, true, 'BLOCKED_BY_SETUP: compare GUI connection failed')
  }

  await page.click('#btn-compare')
  await page.waitForSelector('#dbstudio-compare')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="compare-target"] option').length === 2)
  await page.selectOption('[data-testid="compare-source"]', { label: '源库（sqlite）' })
  await page.selectOption('[data-testid="compare-target"]', { label: '目标库（sqlite）' })

  await page.click('[data-testid="compare-run"]')
  await page.waitForFunction(() => /差异/.test(document.querySelector('[data-testid="compare-summary"]')?.textContent ?? ''))
  const structureSql = await page.inputValue('[data-testid="compare-sql"]')
  assert.match(structureSql, /CREATE TABLE "only_source"/)
  assert.match(structureSql, /DROP TABLE "only_target"/)
  assert.ok(await page.locator('[data-testid="compare-summary"].danger').count() === 1, '删除必须标危险')
  console.log('PASS 结构比较：显示 CREATE/DROP 并标危险')

  await page.selectOption('[data-testid="compare-mode"]', 'data')
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="compare-target-table"] option')].some((o) => o.textContent === 'items'))
  await page.selectOption('[data-testid="compare-source-table"]', { label: 'items' })
  await page.selectOption('[data-testid="compare-target-table"]', { label: 'items' })
  await page.click('[data-testid="compare-run"]')
  await page.waitForFunction(() => /INSERT 1/.test(document.querySelector('[data-testid="compare-summary"]')?.textContent ?? ''))
  const dataSummary = await page.textContent('[data-testid="compare-summary"]')
  assert.match(dataSummary, /INSERT 1 · UPDATE 1 · DELETE 1/)
  const detailsText = (await page.locator('[data-testid="compare-details"]').textContent()) ?? ''
  assert.match(detailsText, /label: b → B/, `差异行应展示值变化：${detailsText}`)
  const dataSql = await page.inputValue('[data-testid="compare-sql"]')
  assert.match(dataSql, /DELETE FROM "items" WHERE "id" = 4/)
  console.log('PASS 数据比较：按主键给出 INSERT/UPDATE/DELETE 计数与 SQL')

  const buttons = await page.locator('#dbstudio-compare button').allTextContents()
  assert.ok(!buttons.some((t) => /执行|应用|同步到/.test(t)), `面板不应有执行入口：${buttons.join(',')}`)
  await page.click('[data-testid="compare-close"]')
  assert.equal(await page.locator('#dbstudio-compare').count(), 0)
  assert.deepEqual(pageErrors, [])
  console.log('PASS 面板无执行入口，可关闭')
} finally {
  if (app) await app.close()
  const db = new DatabaseSync(targetFile)
  const rows = db.prepare('SELECT id, label FROM items ORDER BY id').all()
  db.close()
  rmSync(work, { recursive: true, force: true })
  assert.deepEqual(rows.map((r) => `${r.id}:${r.label}`), ['1:a', '2:B', '4:d'], '比较后目标库数据必须不变')
  console.log('PASS 目标库数据未被改动')
}
