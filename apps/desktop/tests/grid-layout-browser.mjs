import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright-core'

// Run on the GitHub runner's installed Chrome; no browser downloads or Rust build.
// Locally, browser operations must use the shared Playwright connection instead.
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Run this browser acceptance in GitHub Actions')
const project = fileURLToPath(new URL('../../../', import.meta.url))
const output = path.join(project, 'out/grid-layout')
await mkdir(output, { recursive: true })
const server = await createServer({
  configFile: false, root: project, logLevel: 'warn',
  cacheDir: path.join(process.env.RUNNER_TEMP, 'dbstudio-grid-vite'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  resolve: { alias: [{ find: '@tauri-apps/api/core', replacement: '/@grid-native-boundary' }] },
  plugins: [vue(), { name: 'grid-layout-external-boundaries', enforce: 'pre',
    resolveId(id) { if (id === '/@grid-native-boundary') return '\0grid-native-boundary' },
    load(id) { if (id === '\0grid-native-boundary') return 'export const invoke = (...args) => window.gridNativeCall(...args)' },
    transform(_source, id) {
      if (id.replaceAll('\\', '/').endsWith('/apps/desktop/src/clipboard.ts')) {
        return 'export const writeClipboardText = text => window.gridCopy(text)'
      }
    }
  }]
})
let browser
const results = []
try {
  await server.listen()
  const address = server.httpServer.address()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${address.port}/apps/desktop/tests/grid-layout-fixture/`)
  await page.locator('tbody td[data-column-index="0"]').first().waitFor()
  const head = index => page.locator(`thead th[data-column-index="${index}"]`)
  const handle = index => head(index).getByRole('separator')
  const width = index => head(index).evaluate(element => element.getBoundingClientRect().width)
  const scrollLeft = () => page.locator('.grid-scroll').evaluate(element => element.scrollLeft)
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 2, `width/position ${actual} differs from ${expected}`)
  async function check(name, action) {
    try { await action(); results.push({ name, passed: true }); console.log(`PASS ${name}`) }
    catch (error) { results.push({ name, passed: false, error: error.message }); throw error }
  }
  async function drag(index, delta, finish = true) {
    await handle(index).scrollIntoViewIfNeeded()
    const box = await handle(index).boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 5 })
    if (finish) await page.mouse.up()
    await settle()
  }
  const original = await page.evaluate(() => window.gridFixture.snapshot())
  await check('pointer resizing changes the rendered column and no adjacent columns', async () => {
    approx(await width(0), 160)
    await drag(0, 100)
    approx(await width(0), 260)
    approx(await width(1), 160)
    approx(await page.locator('tbody td[data-column-index="0"]').first().evaluate(el => el.getBoundingClientRect().width), 260)
  })
  await check('keyboard resize respects limits and Escape cancels a pointer drag', async () => {
    await handle(0).focus()
    await page.keyboard.press('Home'); await settle(); approx(await width(0), 72)
    await page.keyboard.press('ArrowRight'); await settle(); approx(await width(0), 82)
    await page.keyboard.press('Shift+ArrowRight'); await settle(); approx(await width(0), 122)
    await page.keyboard.press('End'); await page.keyboard.press('ArrowRight'); await settle(); approx(await width(0), 720)
    await page.keyboard.press('Home'); await settle()
    await drag(0, 100, false)
    approx(await width(0), 172)
    await page.keyboard.press('Escape'); await page.mouse.up(); await settle()
    approx(await width(0), 72)
    assert.equal(await handle(0).getAttribute('aria-valuenow'), '72')
  })
  await check('double-click fits loaded content and a long preview is bounded without fetching', async () => {
    await handle(1).dblclick(); await settle()
    assert.ok(await width(1) > 220)
    await handle(3).dblclick(); await settle(); approx(await width(3), 720)
    assert.equal((await page.evaluate(() => window.gridFixture.snapshot())).calls, 0)
  })
  await check('name search jumps to an offscreen column and transfers keyboard focus', async () => {
    await page.getByLabel('跳转列', { exact: true }).fill('末尾')
    await page.getByRole('button', { name: '跳转', exact: true }).click(); await settle()
    assert.ok(await scrollLeft() > 4000)
    assert.equal(await head(39).evaluate(element => element === document.activeElement), true)
    const targetBox = await head(39).boundingBox()
    const viewportBox = await page.locator('.grid-scroll').boundingBox()
    assert.ok(targetBox.x >= viewportBox.x && targetBox.x + targetBox.width <= viewportBox.x + viewportBox.width + 1)
    await page.screenshot({ path: path.join(output, 'wide-table-jump.png') })
  })
  await check('duplicate names retain column positions; search is case insensitive and handles no match', async () => {
    const search = page.getByLabel('跳转列', { exact: true })
    await search.fill('重复名称')
    assert.deepEqual(await page.getByLabel('匹配列').locator('option').allTextContents(), ['5 · 重复名称', '23 · 重复名称'])
    await page.getByLabel('匹配列').selectOption('22')
    await search.press('Enter'); await settle()
    assert.equal(await head(22).evaluate(el => el === document.activeElement), true)
    await search.fill('customer'); await search.press('Enter'); await settle()
    assert.equal(await head(7).evaluate(el => el === document.activeElement), true)
    await search.fill('不存在的列')
    assert.equal(await page.getByRole('button', { name: '跳转', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('status').textContent(), '没有匹配列')
    await search.fill('')
  })
  await check('each tab keeps its own widths and horizontal position through unmount and page replacement', async () => {
    const left = await scrollLeft()
    const savedWidth = await width(1)
    await page.getByRole('button', { name: '宽表 B', exact: true }).click(); await settle()
    approx(await width(1), 160); approx(await scrollLeft(), 0)
    await drag(1, 40)
    await page.getByRole('button', { name: '宽表 A', exact: true }).click(); await settle()
    approx(await width(1), savedWidth); approx(await scrollLeft(), left)
    await page.evaluate(() => window.gridFixture.replacePage()); await settle()
    approx(await width(1), savedWidth); approx(await scrollLeft(), left)
  })
  await check('resizing and navigation preserve exact values, selection copy and query state', async () => {
    await page.getByLabel('跳转列', { exact: true }).fill('id')
    await page.getByRole('button', { name: '跳转', exact: true }).click(); await settle()
    await page.locator('tbody td[data-column-index="0"]').first().click()
    await page.getByRole('button', { name: '复制单元格', exact: true }).click()
    const state = await page.evaluate(() => window.gridFixture.snapshot())
    assert.deepEqual(state.copied, ['9007199254740993'])
    assert.deepEqual({ ...state, copied: [] }, original)
    await page.getByRole('button', { name: '适宽全部列', exact: true }).click(); await settle()
    assert.ok(await width(1) > 220)
    approx(await width(3), 720)
    await page.screenshot({ path: path.join(output, 'column-widths.png') })
  })
  await check('reset widths, changed schema and reopened tab discard stale column settings', async () => {
    await page.getByRole('button', { name: '重置列宽', exact: true }).click(); await settle()
    approx(await width(1), 160)
    await drag(0, 70); approx(await width(0), 230)
    await page.evaluate(() => window.gridFixture.changeSchema()); await settle()
    approx(await width(0), 160); approx(await scrollLeft(), 0)
    await drag(0, 50); approx(await width(0), 210)
    await page.evaluate(() => window.gridFixture.closeAndReopen()); await settle()
    approx(await width(0), 160)
  })
  await check('page replacement and tab unmount cancel an active drag without leaking pointer state', async () => {
    await drag(0, 60, false)
    approx(await width(0), 220)
    await page.evaluate(() => window.gridFixture.replacePage()); await settle()
    await page.mouse.up(); approx(await width(0), 160)
    await drag(0, 50, false)
    await page.evaluate(() => document.querySelector('[data-fixture-tab="B"]').click()); await settle()
    await page.mouse.move(600, 400); await page.mouse.up(); await settle()
    approx(await width(0), 160)
    assert.equal(await page.locator('.is-resizing').count(), 0)
  })
  await check('empty results can fit headers and jump at a narrow viewport', async () => {
    await page.evaluate(() => window.gridFixture.emptyRows()); await settle()
    await page.setViewportSize({ width: 720, height: 650 })
    await page.getByRole('button', { name: '适宽全部列', exact: true }).click(); await settle()
    await page.getByLabel('跳转列', { exact: true }).fill('末尾')
    await page.getByRole('button', { name: '跳转', exact: true }).click(); await settle()
    assert.equal(await page.locator('tbody tr').count(), 0)
    assert.equal(await head(39).evaluate(el => el === document.activeElement), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: path.join(output, 'empty-narrow-table.png') })
  })
  assert.deepEqual(errors, [])
  await context.close()
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0]
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ ok: process.exitCode !== 1,
    sourceSha: process.env.GITHUB_SHA, browser: 'Chrome on GitHub Linux; synthetic data; real Vue component', results }, null, 2))
}
