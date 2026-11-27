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
  await check('IME confirmation leaves native default behavior and focus in the column search', async () => {
    const search = page.getByLabel('跳转列', { exact: true })
    await search.fill('id')
    const left = await scrollLeft()
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      const observed = await search.evaluate((element, options) => {
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })
        element.dispatchEvent(event)
        return { prevented: event.defaultPrevented, focused: element === document.activeElement }
      }, options)
      assert.deepEqual(observed, { prevented: false, focused: true })
      approx(await scrollLeft(), left)
    }
    await search.press('Enter'); await settle()
    assert.equal(await head(0).evaluate(el => el === document.activeElement), true)
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
    assert.equal(await page.getByRole('status').filter({ hasText: /^没有匹配列$/ }).textContent(), '没有匹配列')
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
    const emptyBox = await page.getByRole('status').filter({ hasText: '结果为空' }).boundingBox()
    assert.ok(emptyBox && emptyBox.x >= 0 && emptyBox.x + emptyBox.width <= 720 && emptyBox.y + emptyBox.height <= 650,
      'Empty result status must remain inside the viewport after horizontal navigation')
    await page.screenshot({ path: path.join(output, 'empty-narrow-table.png') })
  })
  const choose = async index => {
    await page.getByLabel('跳转列', { exact: true }).fill('')
    await page.getByLabel('匹配列').selectOption(String(index))
  }
  const pin = async index => { await choose(index); await page.getByRole('button', { name: '固定此列', exact: true }).click(); await settle() }
  const hide = async index => { await choose(index); await page.getByRole('button', { name: '隐藏此列', exact: true }).click(); await settle() }
  const visible = () => page.locator('thead th[data-column-index]').evaluateAll(elements => elements.map(element => Number(element.dataset.columnIndex)))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByRole('button', { name: '宽表 A', exact: true }).click(); await settle()
  await page.getByRole('button', { name: '重置列宽', exact: true }).click(); await settle()
  await check('pinned columns stay aligned across horizontal/vertical scrolling and width changes', async () => {
    await pin(2); await pin(0)
    assert.deepEqual((await visible()).slice(0, 4), [0, 2, 1, 3])
    await page.locator('.grid-scroll').evaluate(element => { element.scrollLeft = 2000; element.scrollTop = 140 })
    await settle()
    const viewport = await page.locator('.grid-scroll').boundingBox()
    approx((await head(0).boundingBox()).x, viewport.x + 64)
    approx((await head(2).boundingBox()).x, viewport.x + 224)
    approx(await page.locator('tbody td[data-column-index="2"]').first().evaluate(el => el.getBoundingClientRect().left), viewport.x + 224)
    await handle(0).focus(); await page.keyboard.press('ArrowRight'); await settle()
    approx((await head(2).boundingBox()).x, viewport.x + 234)
    await page.screenshot({ path: path.join(output, 'pinned-columns.png') })
  })
  await check('column jumps avoid pinned overlays; oversized pins keep other columns reachable', async () => {
    await choose(20); await page.getByRole('button', { name: '跳转', exact: true }).click(); await settle()
    assert.ok((await head(20).boundingBox()).x >= (await head(2).boundingBox()).x + await width(2) - 1)
    await handle(0).focus(); await page.keyboard.press('End'); await settle()
    await page.setViewportSize({ width: 720, height: 650 }); await settle()
    assert.equal(await page.getByRole('status').filter({ hasText: '固定列较宽' }).count(), 1)
    await choose(39); await page.getByRole('button', { name: '跳转', exact: true }).click(); await settle()
    const last = await head(39).boundingBox()
    assert.ok(last.x >= 64 && last.x + last.width <= 721)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole('button', { name: '重置列宽', exact: true }).click(); await settle()
  })
  await check('Tab and Shift+Tab reveal the selected cell outside pinned overlays', async () => {
    const cell = index => page.locator(`tbody tr:first-child td[data-column-index="${index}"]`)
    const assertRevealed = async index => {
      assert.equal(await cell(index).evaluate(el => el === document.activeElement), true)
      const box = await cell(index).boundingBox()
      const pinned = await head(2).boundingBox()
      const viewport = await page.locator('.grid-scroll').boundingBox()
      assert.ok(box.x >= pinned.x + pinned.width - 1, 'Focused cell is covered by pinned columns')
      assert.ok(box.x + box.width <= viewport.x + viewport.width + 1)
      assert.equal(await cell(index).evaluate(el => {
        const box = el.getBoundingClientRect()
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === el
      }), true, 'Focused cell must be hit-testable at its visible center')
    }
    await cell(2).focus()
    await page.locator('.grid-scroll').evaluate(el => { el.scrollLeft = 160; el.scrollTop = 0 })
    await page.keyboard.press('Tab'); await settle()
    await assertRevealed(1)
    await cell(3).focus()
    await page.locator('.grid-scroll').evaluate(el => { el.scrollLeft = 320 })
    await page.keyboard.press('Shift+Tab'); await settle()
    await assertRevealed(1)
    await page.screenshot({ path: path.join(output, 'keyboard-focus-visible.png') })
    await handle(0).focus(); await page.keyboard.press('End'); await settle()
    await page.setViewportSize({ width: 720, height: 650 }); await settle()
    await page.getByLabel('跳转列', { exact: true }).focus()
    await handle(0).focus(); await settle()
    const resizeBox = await handle(0).boundingBox()
    assert.ok(resizeBox.x >= 64 && resizeBox.x + resizeBox.width <= 721,
      'Focused resize handle must remain visible at the right edge of an oversized column')
    await cell(0).focus()
    await page.locator('.grid-scroll').evaluate(el => { el.scrollLeft = 800 })
    await page.keyboard.press('Tab'); await settle()
    assert.equal(await cell(2).evaluate(el => el === document.activeElement), true)
    const fallback = await cell(2).boundingBox()
    assert.ok(fallback.x >= 64 && fallback.x + fallback.width <= 721,
      'Keyboard visibility must use effective sticky width when oversized pins scroll')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole('button', { name: '重置列宽', exact: true }).click(); await settle()
  })
  await check('hidden columns can be searched/restored and visibility stays isolated by tab', async () => {
    await hide(3); await hide(0)
    assert.equal(await head(0).count(), 0); assert.equal(await head(3).count(), 0)
    await page.evaluate(() => window.gridFixture.replacePage()); await settle()
    assert.equal(await head(3).count(), 0)
    await page.getByRole('button', { name: '宽表 B', exact: true }).click(); await settle()
    assert.equal(await head(3).count(), 1)
    await page.getByRole('button', { name: '宽表 A', exact: true }).click(); await settle()
    assert.equal(await head(3).count(), 0)
    await choose(0)
    assert.match(await page.getByLabel('匹配列').locator('option:checked').textContent(), /隐藏/)
    await page.getByRole('button', { name: '跳转', exact: true }).click(); await settle()
    assert.equal(await head(0).count(), 1)
    assert.equal(await head(0).evaluate(el => el === document.activeElement), true)
    await page.getByRole('button', { name: /显示全部列/ }).click(); await settle()
    assert.equal((await visible()).length, 40)
    await page.getByRole('button', { name: '取消全部固定', exact: true }).click(); await settle()
    assert.deepEqual((await visible()).slice(0, 4), [0, 1, 2, 3])
  })
  await page.evaluate(() => window.gridFixture.prepareEditable()); await settle()
  await check('copy uses visible order and hidden selection clears without losing exact values', async () => {
    await pin(3); await hide(2)
    assert.deepEqual(await visible(), [3, 0, 1, 4, 5])
    const cell = page.locator('tbody td[data-column-index="1"]').first()
    await cell.click()
    await page.getByRole('button', { name: '复制整行', exact: true }).click()
    assert.equal((await page.evaluate(() => window.gridFixture.clipboard())).at(-1), '1234567890.123456789012345678\t9007199254740993\t9007199254740994\t\t')
    await page.getByLabel('选择第 1 行', { exact: true }).check()
    await page.getByRole('button', { name: '复制选中行', exact: true }).click()
    assert.equal((await page.evaluate(() => window.gridFixture.clipboard())).at(-1), 'amount\tid\texact_int\tnullable_note\tempty_note\r\n1234567890.123456789012345678\t9007199254740993\t9007199254740994\t\t')
    await hide(1)
    assert.equal(await page.getByRole('button', { name: '复制单元格', exact: true }).isDisabled(), true)
    await choose(1); await page.getByRole('button', { name: '显示此列', exact: true }).click(); await settle()
  })
  const paste = async (column, text) => {
    await page.locator(`tbody td[data-column-index="${column}"]`).first().evaluate((element, text) => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text)
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    }, text)
    await settle()
  }
  await check('paste crosses pinned/hidden columns using original identities and hidden primary keys', async () => {
    await pin(1); await hide(0)
    assert.deepEqual(await visible(), [1, 3, 4, 5])
    await paste(1, '9007199254740995\t9876543210.123456789012345678\t\\N\tchanged')
    const edits = await page.evaluate(() => window.gridFixture.edits())
    assert.deepEqual(edits, [[0, { keyValues: { id: { kind: 'text', text: '9007199254740993' } }, changes: {
      exact_int: { kind: 'text', text: '9007199254740995' }, amount: { kind: 'text', text: '9876543210.123456789012345678' },
      empty_note: { kind: 'text', text: 'changed' }
    } }]])
    await paste(4, 'text\t"\\N"')
    await paste(4, '\\N\t""')
    const final = await page.evaluate(() => window.gridFixture.edits())
    assert.deepEqual(Object.keys(final[0][1].changes).sort(), ['amount', 'exact_int'])
    await page.screenshot({ path: path.join(output, 'visible-column-paste.png') })
  })
  await check('overflow, protected and invalid pasted cells reject the whole batch', async () => {
    await page.evaluate(() => window.gridFixture.clearEdits())
    for (const [start, text] of [[5, 'one\ttwo'], [1, '42\tnot-a-decimal'], [1, '42\t1\t2\t3\n43\t1\t2\t3\n44\t1\t2\t3']]) {
      await paste(start, text)
      assert.deepEqual(await page.evaluate(() => window.gridFixture.edits()), [])
      assert.ok(await page.getByRole('alert').count())
    }
    await choose(0); await page.getByRole('button', { name: '显示此列', exact: true }).click(); await settle()
    await paste(3, '123.1\t999') // visible order now exact_int, amount, id, ...
    assert.deepEqual(await page.evaluate(() => window.gridFixture.edits()), [])
    assert.match(await page.getByRole('alert').textContent(), /不支持批量粘贴/)
  })
  await check('last visible column cannot be hidden and restoring columns preserves original indices', async () => {
    await page.getByRole('button', { name: '取消全部固定', exact: true }).click(); await settle()
    for (const index of [0, 1, 3, 4]) await hide(index)
    assert.deepEqual(await visible(), [5])
    await choose(5)
    assert.equal(await page.getByRole('button', { name: '隐藏此列', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: /显示全部列/ }).click(); await settle()
    assert.deepEqual(await visible(), [0, 1, 2, 3, 4, 5])
    await page.evaluate(() => window.gridFixture.duplicatePasteColumn()); await settle()
    await paste(1, '123')
    assert.deepEqual(await page.evaluate(() => window.gridFixture.edits()), [])
    assert.match(await page.getByRole('alert').textContent(), /无法确定目标列/)
  })
  assert.equal((await page.evaluate(() => window.gridFixture.snapshot())).calls, 0)
  assert.deepEqual(errors, [])

  // P2 starts only after all 19 layout checks and their original zero-IPC assertion.
  const rangeCell = (row, column) => page.locator(`tbody tr[data-row-index="${row}"] td[data-column-index="${column}"]`)
  const copyRangeButton = headers => page.getByRole('button', { name: headers ? '复制选区（含表头）' : '复制选区', exact: true })
  const clipboard = () => page.evaluate(() => window.gridFixture.clipboard())
  const nativeState = () => page.evaluate(() => window.gridFixture.nativeState())
  const prepareRange = async (tall = false) => {
    await page.evaluate(tall => window.gridFixture.prepareRange(tall), tall)
    await settle()
    await rangeCell(101, 0).waitFor()
  }
  const press = async key => { await page.keyboard.press(key); await settle() }
  const coordinates = selector => page.locator(`tbody td${selector}`).evaluateAll(elements => elements.map(element => [
    Number(element.closest('tr').dataset.rowIndex), Number(element.dataset.columnIndex)
  ]))
  async function assertRectangle(rows, columns, active, focused = true) {
    assert.deepEqual(await coordinates('.is-cell-in-range'), rows.flatMap(row => columns.map(column => [row, column])), 'Exact rectangle in rendered page/column order')
    assert.deepEqual(await coordinates('.is-cell-selected'), [active], 'Exactly one active cell')
    if (focused) assert.equal(await rangeCell(...active).evaluate(element => element === document.activeElement), true, 'Keyboard focus follows the active cell')
  }
  async function assertCleared() {
    assert.deepEqual(await coordinates('.is-cell-in-range'), [])
    assert.deepEqual(await coordinates('.is-cell-selected'), [])
    assert.equal(await copyRangeButton(false).isDisabled(), true)
    assert.equal(await copyRangeButton(true).isDisabled(), true)
  }
  async function selectRectangle(anchor, end = anchor) {
    await rangeCell(...anchor).click()
    if (anchor[0] !== end[0] || anchor[1] !== end[1]) await rangeCell(...end).click({ modifiers: ['Shift'] })
    await settle()
  }
  async function expectCopy(expected, shortcut = null, headers = false) {
    const before = await clipboard()
    if (shortcut) await press(shortcut)
    else await copyRangeButton(headers).click()
    await page.waitForFunction(count => window.gridFixture.clipboard().length > count, before.length)
    assert.deepEqual(await clipboard(), [...before, expected], 'One complete, exact clipboard write')
  }
  async function pasteAt(row, column, text) {
    await rangeCell(row, column).evaluate((element, text) => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text)
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    }, text)
    await settle()
  }
  async function nextRangePage() {
    await page.evaluate(() => window.gridFixture.queueNextPage())
    const next = page.getByRole('button', { name: '下一页', exact: true })
    assert.equal(await next.isEnabled(), true, 'Pending range copy must allow page navigation')
    await next.click()
    await rangeCell(301, 0).waitFor()
    await settle()
    assert.equal((await page.evaluate(() => window.gridFixture.rangeState())).offset, 300)
  }

  await check('range arrows follow page row identities, clamp all edges and leave Tab native', async () => {
    await prepareRange()
    assert.deepEqual(await page.locator('tbody tr').evaluateAll(rows => rows.map(row => Number(row.dataset.rowIndex))), [101, 305, 207, 409])
    await selectRectangle([101, 0])
    for (const key of ['ArrowUp', 'ArrowLeft']) { await press(key); await assertRectangle([101], [0], [101, 0]) }
    await press('ArrowDown'); await assertRectangle([305], [0], [305, 0])
    await press('ArrowDown'); await assertRectangle([207], [0], [207, 0])
    await press('ArrowUp'); await press('ArrowRight'); await assertRectangle([305], [1], [305, 1])
    await selectRectangle([409, 7])
    for (const key of ['ArrowDown', 'ArrowRight']) { await press(key); await assertRectangle([409], [7], [409, 7]) }
    await selectRectangle([101, 0])
    for (const [key, column] of [['Tab', 1], ['Shift+Tab', 0]]) {
      await page.evaluate(() => {
        window.rangeTabDefaultPrevented = null
        const record = event => {
          if (event.key !== 'Tab') return
          window.removeEventListener('keydown', record, true)
          queueMicrotask(() => { window.rangeTabDefaultPrevented = event.defaultPrevented })
        }
        window.addEventListener('keydown', record, true)
      })
      await press(key)
      assert.equal(await page.evaluate(() => window.rangeTabDefaultPrevented), false, 'Tab must retain the browser default')
      await assertRectangle([101], [column], [101, column])
    }
    // Returning through native Tab to the same cell must establish a new anchor.
    await selectRectangle([101, 1])
    await press('Shift+ArrowLeft'); await assertRectangle([101], [0, 1], [101, 0])
    await press('Shift+Tab')
    assert.equal(await page.getByLabel('选择第 102 行', { exact: true }).evaluate(element => element === document.activeElement), true)
    await press('Tab'); await assertRectangle([101], [0], [101, 0])
    await press('Shift+ArrowRight'); await assertRectangle([101], [0, 1], [101, 1])
  })
  await check('Shift arrows expand, contract and reverse; Shift click preserves the anchor through focus', async () => {
    await prepareRange()
    await selectRectangle([305, 3])
    await press('Shift+ArrowRight'); await press('Shift+ArrowDown')
    await assertRectangle([305, 207], [3, 4], [207, 4])
    await press('Shift+ArrowLeft'); await assertRectangle([305, 207], [3], [207, 3])
    await press('Shift+ArrowLeft'); await assertRectangle([305, 207], [2, 3], [207, 2])
    await press('Shift+ArrowUp'); await assertRectangle([305], [2, 3], [305, 2])
    await press('Shift+ArrowUp'); await assertRectangle([101, 305], [2, 3], [101, 2])
    await press('Shift+ArrowUp'); await assertRectangle([101, 305], [2, 3], [101, 2])
    await press('Escape'); await assertRectangle([101], [2], [101, 2])
    await press('Shift+ArrowRight'); await assertRectangle([101], [2, 3], [101, 3])
    await selectRectangle([101, 1], [305, 3])
    await assertRectangle([101, 305], [1, 2, 3], [305, 3])
    await page.screenshot({ path: path.join(output, 'range-selection-2x3.png') })
    // A second pointer/focus transition must still extend from the original anchor.
    await rangeCell(207, 2).click({ modifiers: ['Shift'] }); await settle()
    await assertRectangle([101, 305, 207], [1, 2], [207, 2])
    await press('Shift+ArrowUp'); await assertRectangle([101, 305], [1, 2], [305, 2])
    await press('ArrowLeft'); await assertRectangle([305], [1], [305, 1])
  })
  await check('range navigation and copying use pinned/hidden order and layout changes clear selection', async () => {
    await prepareRange()
    await pin(5); await hide(2)
    assert.deepEqual(await visible(), [5, 0, 1, 3, 4, 6, 7])
    await selectRectangle([101, 5])
    await press('ArrowLeft'); await assertRectangle([101], [5], [101, 5])
    await press('ArrowRight'); await assertRectangle([101], [0], [101, 0])
    await selectRectangle([101, 1])
    await press('ArrowRight'); await assertRectangle([101], [3], [101, 3])
    await press('ArrowLeft'); await assertRectangle([101], [1], [101, 1])
    await selectRectangle([101, 5], [305, 1])
    await assertRectangle([101, 305], [5, 0, 1], [305, 1])
    await expectCopy('"\\N"\t9007199254740993\t9007199254740995\r\n"\\N"\t9007199254740994\t9223372036854775807')
    await hide(6); await assertCleared() // Selection clears even when the changed column is outside it.
    await selectRectangle([101, 1]); await pin(3); await assertCleared()
    await selectRectangle([101, 1]); await page.getByRole('button', { name: '取消全部固定', exact: true }).click(); await settle(); await assertCleared()
    await selectRectangle([101, 1]); await page.getByRole('button', { name: /显示全部列/ }).click(); await settle(); await assertCleared()
  })
  await check('range TSV and headers preserve NULL, empty, literal null markers, quotes and exact integers on paste roundtrip', async () => {
    await prepareRange()
    await hide(2)
    await selectRectangle([101, 1], [305, 6])
    const text = '9007199254740995\t\\N\t""\t"\\N"\t"制表\t引号""与换行\n尾部"\r\n9223372036854775807\t非空\t""\t"\\N"\t"回车\r换行\r\n尾"""'
    await assertRectangle([101, 305], [1, 3, 4, 5, 6], [305, 6])
    await expectCopy(text, 'Control+c')
    await expectCopy(text, 'Meta+c')
    await expectCopy(text)
    await expectCopy('exact_int\tnullable_note\tempty_note\tliteral_note\t"escaped\t""note""\nline"\r\n' + text, null, true)
    // Consume the actual copied payload, not a second encoding of the expected values.
    await selectRectangle([101, 1], [305, 6]); await expectCopy(text, 'Control+c')
    await pasteAt(207, 1, (await clipboard()).at(-1))
    assert.deepEqual(await page.evaluate(() => window.gridFixture.edits()), [
      [207, { keyValues: { id: { kind: 'text', text: '9007199254740995' } }, changes: {
        exact_int: { kind: 'text', text: '9007199254740995' }, nullable_note: { kind: 'null' },
        empty_note: { kind: 'text', text: '' }, literal_note: { kind: 'text', text: '\\N' },
        'escaped\t"note"\nline': { kind: 'text', text: '制表\t引号"与换行\n尾部' }
      } }],
      [409, { keyValues: { id: { kind: 'text', text: '9007199254740996' } }, changes: {
        exact_int: { kind: 'text', text: '9223372036854775807' }, nullable_note: { kind: 'text', text: '非空' },
        empty_note: { kind: 'text', text: '' }, literal_note: { kind: 'text', text: '\\N' },
        'escaped\t"note"\nline': { kind: 'text', text: '回车\r换行\r\n尾"' }
      } }]
    ])
    await selectRectangle([207, 1], [409, 6]); await expectCopy(text, 'Control+c')
  })
  await check('range copy uses staged exact values and never fetches a replaced truncated preview', async () => {
    await prepareRange()
    await pasteAt(101, 1, '9007199254740997')
    await pasteAt(101, 7, '"暂存\t完整""值""\n末尾"')
    await selectRectangle([101, 1]); await expectCopy('9007199254740997', 'Control+c')
    await selectRectangle([101, 7]); await expectCopy('"暂存\t完整""值""\n末尾"', 'Control+c')
    assert.deepEqual(await page.evaluate(() => window.gridFixture.edits()), [[101, {
      keyValues: { id: { kind: 'text', text: '9007199254740993' } }, changes: {
        exact_int: { kind: 'text', text: '9007199254740997' }, full_note: { kind: 'text', text: '暂存\t完整"值"\n末尾' }
      }
    }]])
    assert.equal((await page.evaluate(() => window.gridFixture.snapshot())).firstCells[0][1].text, '9007199254740995')
  })
  await check('range resets on page/result replacement, generation, invalidation and tab roundtrip', async () => {
    for (const mutation of ['page', 'result', 'generation', 'invalidated', 'tab']) {
      await prepareRange()
      await selectRectangle([101, 1], [305, 3])
      if (mutation === 'page') await page.evaluate(() => window.gridFixture.replacePage())
      else if (mutation === 'tab') {
        await page.getByRole('button', { name: '宽表 B', exact: true }).click(); await settle(); await assertCleared()
        await selectRectangle([101, 4])
        await page.getByRole('button', { name: '宽表 A', exact: true }).click()
      } else await page.evaluate(kind => window.gridFixture.mutateRange(kind), mutation)
      await settle(); await assertCleared()
    }
  })
  await check('composing and keyCode 229 range keys retain native defaults without moving or copying', async () => {
    await prepareRange()
    await selectRectangle([101, 1], [305, 3])
    const before = await clipboard()
    for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const keys of [{ key: 'ArrowDown' }, { key: 'ArrowRight', shiftKey: true }, { key: 'Escape' }, { key: 'c', ctrlKey: true }, { key: 'c', metaKey: true }]) {
        const prevented = await rangeCell(305, 3).evaluate((element, options) => {
          const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options })
          element.dispatchEvent(event)
          return event.defaultPrevented
        }, { ...ime, ...keys })
        assert.equal(prevented, false, `IME default was prevented for ${JSON.stringify({ ...ime, ...keys })}`)
        await settle(); await assertRectangle([101, 305], [1, 2, 3], [305, 3])
        assert.deepEqual(await clipboard(), before)
      }
    }
    await press('ArrowDown'); await assertRectangle([207], [3], [207, 3])
  })
  await check('vertical arrow navigation reveals active cells below sticky headers in both directions', async () => {
    await prepareRange(true)
    const rows = await page.locator('tbody tr').evaluateAll(elements => elements.map(element => Number(element.dataset.rowIndex)))
    const assertBelowHeader = async row => {
      await assertRectangle([row], [1], [row, 1])
      const box = await rangeCell(row, 1).boundingBox()
      const viewport = await page.locator('.grid-scroll').boundingBox()
      const headerBottom = await page.locator('thead th').evaluateAll(elements => Math.max(...elements.map(element => element.getBoundingClientRect().bottom)))
      assert.ok(box.y >= headerBottom - 1, 'Active cell must not sit under the sticky header')
      assert.ok(box.y + box.height <= viewport.y + viewport.height + 1, 'Active cell must stay above the viewport bottom')
      assert.equal(await rangeCell(row, 1).evaluate(element => {
        const box = element.getBoundingClientRect()
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return hit === element || element.contains(hit)
      }), true, 'Active cell must be hit-testable after vertical navigation')
    }
    await selectRectangle([rows[0], 1])
    for (let index = 1; index <= 35; index++) await press('ArrowDown')
    assert.ok(await page.locator('.grid-scroll').evaluate(element => element.scrollTop > 0))
    await assertBelowHeader(rows[35])
    for (let index = 34; index >= 0; index--) { await press('ArrowUp'); await assertBelowHeader(rows[index]) }
  })
  // All new local interaction/clipboard tests must also remain entirely IPC-free.
  assert.equal((await nativeState()).calls.length, 0)

  async function beginFullCopy(keyboard = true) {
    await selectRectangle([101, 6], [101, 7])
    const before = await clipboard()
    const callsBefore = (await nativeState()).calls.length
    await page.evaluate(() => window.gridFixture.deferredFullCell(101, 7))
    if (keyboard) await press('Control+c')
    else await copyRangeButton(false).click()
    await page.waitForFunction(() => window.gridFixture.nativeState().pending?.requested)
    assert.deepEqual(await clipboard(), before, 'No partial clipboard write while full text is pending')
    const state = await nativeState()
    assert.equal(state.calls.length, callsBefore + 1)
    assert.equal(state.calls.at(-1)[0], 'backend_call')
    assert.equal(state.calls.at(-1)[1].method, 'fetchCellValue')
    assert.deepEqual(state.calls.at(-1)[1].args.slice(1), [101, 7], 'Fetch uses actual row.index and original column index')
    assert.equal((await page.evaluate(() => window.gridFixture.rangeState())).busy, false, 'Copy must not lock ordinary interaction')
    return before
  }
  async function finishFullCopy(outcome) {
    await page.evaluate(outcome => window.gridFixture.finishFullCell(outcome), outcome)
    await settle()
    const state = await nativeState()
    assert.deepEqual(state.pending, { requested: true, settled: true })
    assert.equal(state.queued, 0)
    assert.deepEqual(state.unexpected, [])
  }
  await check('full-cell range copy is atomic and failure or still-truncated responses preserve clipboard', async () => {
    for (const outcome of ['success', 'failure', 'truncated']) {
      await prepareRange()
      const before = await beginFullCopy(false)
      await finishFullCopy(outcome)
      if (outcome === 'success') {
        assert.deepEqual(await clipboard(), [...before, '"制表\t引号""与换行\n尾部"\t"全文\t""原值""\r\n结束\\N"'])
      } else {
        assert.deepEqual(await clipboard(), before, `${outcome} must preserve the existing clipboard`)
        assert.ok(await page.getByRole('alert').count(), `${outcome} must report the full-text error`)
      }
      await selectRectangle([101, 1]); await expectCopy('9007199254740995', 'Control+c')
    }
  })
  await check('pending copy allows keyboard selection and revision rejects even a restored identical rectangle', async () => {
    for (const change of ['keyboard', 'restore']) {
      await prepareRange()
      const before = await beginFullCopy()
      await press('ArrowLeft'); await assertRectangle([101], [6], [101, 6])
      if (change === 'restore') {
        await selectRectangle([101, 6], [101, 7])
        await assertRectangle([101], [6, 7], [101, 7])
      }
      await finishFullCopy('success')
      assert.deepEqual(await clipboard(), before, `${change} must invalidate the earlier copy revision`)
      await selectRectangle([101, 1]); await expectCopy('9007199254740995', 'Control+c')
    }
  })
  await check('pending copy allows real next-page and tab switches and discards the old full-text response', async () => {
    for (const destination of ['page', 'tab', 'tab-roundtrip']) {
      await prepareRange()
      const before = await beginFullCopy()
      if (destination === 'page') await nextRangePage()
      else {
        const next = page.getByRole('button', { name: '宽表 B', exact: true })
        assert.equal(await next.isEnabled(), true)
        await next.click(); await settle()
        if (destination === 'tab-roundtrip') {
          await page.getByRole('button', { name: '宽表 A', exact: true }).click(); await settle()
        }
      }
      await assertCleared()
      await finishFullCopy('success')
      assert.deepEqual(await clipboard(), before, `${destination} must discard the previous tab/page response`)
      await selectRectangle([destination === 'page' ? 301 : 101, 1]); await expectCopy('9007199254740995', 'Control+c')
    }
  })
  await check('pending copy rejects changed result, cursor, generation and invalidation; layout controls stay locked', async () => {
    for (const mutation of ['page', 'result', 'cursor', 'generation', 'invalidated']) {
      await prepareRange()
      const before = await beginFullCopy()
      await choose(1)
      assert.equal(await page.getByRole('button', { name: '固定此列', exact: true }).isDisabled(), true)
      assert.equal(await page.getByRole('button', { name: '隐藏此列', exact: true }).isDisabled(), true)
      if (mutation === 'page') await page.evaluate(() => window.gridFixture.replacePage())
      else await page.evaluate(kind => window.gridFixture.mutateRange(kind), mutation)
      await settle()
      if (mutation !== 'cursor') await assertCleared()
      await finishFullCopy('success')
      assert.deepEqual(await clipboard(), before, `${mutation} must invalidate the asynchronous copy`)
    }
  })
  assert.equal((await nativeState()).queued, 0)
  assert.deepEqual((await nativeState()).unexpected, [])

  // P2 pagination/search starts after the original 31 acceptance checks.
  assert.equal(results.length, 31, 'Keep the original layout/range checks intact')
  const pageSize = () => page.getByLabel('每页行数', { exact: true })
  const pageSearch = () => page.getByLabel('本页搜索', { exact: true })
  const serverFilter = () => page.getByLabel('服务端筛选', { exact: true })
  const previousPage = () => page.getByRole('button', { name: '上一页', exact: true })
  const nextPage = () => page.getByRole('button', { name: '下一页', exact: true })
  const nextMatch = () => page.getByRole('button', { name: '下一个匹配', exact: true })
  const previousMatch = () => page.getByRole('button', { name: '上一个匹配', exact: true })
  const searchStatus = () => page.getByRole('status').filter({ hasText: '个匹配单元格' })
  const applyFilter = () => page.getByRole('button', { name: '应用筛选', exact: true })
  const refresh = () => page.getByRole('button', { name: '刷新', exact: true })
  const paginationState = () => page.evaluate(() => window.gridFixture.paginationState())
  const selectionState = async () => ({ active: await coordinates('.is-cell-selected'), range: await coordinates('.is-cell-in-range') })
  const retainedState = state => ({ size: state.size, explicitSize: state.explicitSize, page: state.page,
    cursor: state.cursor, querySql: state.querySql, appliedFilter: state.appliedFilter, dirty: state.dirty, selectedRows: state.selectedRows })
  async function idlePagination() {
    await page.waitForFunction(() => {
      const state = window.gridFixture.paginationState()
      return !state.busy && !state.locked && !state.decision
    })
    await settle()
    const native = await nativeState()
    assert.equal(native.queued, 0, 'All exact native expectations must be consumed')
    assert.deepEqual(native.unexpected, [], 'No unexpected IPC, including COUNT or full-cell reads')
  }
  async function preparePagination(options = {}) {
    await idlePagination()
    await page.evaluate(options => window.gridFixture.preparePagination(options), options)
    await settle()
    await pageSize().waitFor()
    assert.deepEqual((await paginationState()).calls, [])
  }
  async function queuePage(offset, limit, outcome = 'success', deferred = false) {
    await page.evaluate(({ offset, limit, outcome, deferred }) => window.gridFixture.queuePaginationPage(offset, limit, outcome, deferred), { offset, limit, outcome, deferred })
  }
  async function queueQuery(sql, limit, outcome = 'success', deferred = false) {
    await page.evaluate(({ sql, limit, outcome, deferred }) => window.gridFixture.queuePaginationQuery(sql, limit, outcome, deferred), { sql, limit, outcome, deferred })
  }
  async function finishPagination() {
    await page.evaluate(() => window.gridFixture.finishPagination())
    await idlePagination()
    assert.deepEqual((await paginationState()).pending, { requested: true, settled: true })
  }
  async function waitPendingPagination() {
    await page.waitForFunction(() => window.gridFixture.paginationState().pending?.requested)
    assert.equal((await paginationState()).busy, true)
    assert.equal(await pageSize().isDisabled(), true)
    assert.equal(await previousPage().isDisabled(), true)
    assert.equal(await nextPage().isDisabled(), true)
  }
  async function assertPage(offset, size, returned) {
    const state = await paginationState()
    assert.equal(state.size, size)
    assert.equal(state.page.offset, offset)
    assert.equal(state.page.returned, returned)
    assert.equal(await pageSize().inputValue(), String(size))
    assert.equal(await page.locator('tbody tr').count(), returned)
    if (returned) assert.equal(await page.locator('tbody tr').first().getAttribute('data-row-index'), String(offset))
  }
  async function movePage(direction, offset, size) {
    await queuePage(offset, size)
    await (direction < 0 ? previousPage() : nextPage()).click()
    await idlePagination()
  }
  async function changeSize(size) {
    await queuePage(0, size)
    await pageSize().selectOption(String(size))
    await idlePagination()
  }
  async function assertSearchStatus(count, position = null) {
    assert.equal(await searchStatus().count(), 1)
    assert.equal((await searchStatus().textContent()).split(' · ')[0].trim(), `${position === null ? '' : `${position} / `}${count} 个匹配单元格`)
  }
  async function tryPageSize(size) {
    // A guard regression must fail promptly instead of leaving page.evaluate
    // waiting forever on a decision that these no-op cases must never open.
    return page.evaluate(async size => {
      let timer
      try {
        return await Promise.race([window.gridFixture.tryPageSize(size), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Page-size no-op unexpectedly waits for a guard/IPC')), 2000)
        })])
      } finally { clearTimeout(timer) }
    }, size)
  }
  async function searchFor(query, expected) {
    const before = retainedState(await paginationState())
    const callsBefore = (await paginationState()).calls
    await pageSearch().fill(query); await settle()
    assert.deepEqual(await coordinates('.is-page-match'), expected, 'Only currently loaded visible matching cells are highlighted')
    await assertSearchStatus(expected.length)
    assert.equal(await nextMatch().isDisabled(), expected.length === 0)
    assert.equal(await previousMatch().isDisabled(), expected.length === 0)
    const after = await paginationState()
    assert.deepEqual(retainedState(after), before, 'Local search must neither filter rows nor mutate the result/drafts')
    assert.deepEqual(after.calls, callsBefore, 'Local search must not invoke IPC')
  }
  const needleMatches = offset => [[offset, 1], [offset, 2], [offset, 3], [offset + 1, 1], [offset + 45, 11]]
  const filteredSql = value => `SELECT * FROM (SELECT synthetic_pagination) _dbstudio_filter WHERE \`note\` = '${value}'`
  const appliedLabel = () => page.getByText(/^已应用服务端筛选[：:]/)
  async function assertApplied(filter) {
    assert.equal(await appliedLabel().count(), 1)
    assert.ok((await appliedLabel().textContent()).includes(filter), `Applied indicator must retain ${filter}`)
  }
  async function stageAndSelect(offset) {
    await pasteAt(offset, 1, 'Needle staged draft')
    await page.getByLabel(`选择第 ${offset + 1} 行`, { exact: true }).check()
    await selectRectangle([offset, 1], [offset + 1, 3])
    assert.equal((await paginationState()).dirty.length, 1)
  }

  await check('pagination defaults to 200 and exposes exactly four sizes with real first/last-page boundaries', async () => {
    await preparePagination({ total: 203 })
    assert.equal((await paginationState()).explicitSize, null)
    assert.deepEqual(await pageSize().locator('option').evaluateAll(options => options.map(option => option.value)), ['100', '200', '500', '1000'])
    await assertPage(0, 200, 200)
    assert.equal(await previousPage().isDisabled(), true)
    assert.equal(await nextPage().isEnabled(), true)
    await movePage(1, 200, 200); await assertPage(200, 200, 3)
    assert.equal(await nextPage().isDisabled(), true)
    assert.equal(await previousPage().isEnabled(), true)
    await movePage(-1, 0, 200); await assertPage(0, 200, 200)
    assert.equal(await previousPage().isDisabled(), true)
    assert.equal((await paginationState()).calls.length, 2)
  })
  await check('100/500/1000 changes fetch offset zero and page forward/back with the selected limit', async () => {
    for (const size of [100, 500, 1000]) {
      await preparePagination({ offset: 200, total: size + 203 })
      await selectRectangle([200, 1])
      await changeSize(size); await assertPage(0, size, size); await assertCleared()
      assert.equal(await previousPage().isDisabled(), true)
      await movePage(1, size, size)
      await assertPage(size, size, Math.min(size, 203))
      if (size === 100) {
        await movePage(1, 200, size); await assertPage(200, size, 100)
        await movePage(1, 300, size); await assertPage(300, size, 3)
      }
      assert.equal(await nextPage().isDisabled(), true)
      const lastOffset = (await paginationState()).page.offset
      await movePage(-1, lastOffset - size, size)
      await assertPage(lastOffset - size, size, size)
      assert.equal(await nextPage().isEnabled(), true)
      await changeSize(200); await assertPage(0, 200, 200)
      assert.equal((await paginationState()).explicitSize, 200)
    }
  })
  await check('page-size change dispatches immediately but commits selector/model only after a successful response', async () => {
    await preparePagination({ offset: 200 })
    await page.getByLabel('选择第 201 行', { exact: true }).check()
    await selectRectangle([200, 1], [201, 3])
    const before = retainedState(await paginationState())
    const selection = await selectionState()
    await queuePage(0, 500, 'success', true)
    await pageSize().selectOption('500'); await waitPendingPagination()
    assert.equal(await pageSize().inputValue(), '200', 'Pending selection rolls back to the committed size')
    assert.deepEqual(retainedState(await paginationState()), before)
    assert.deepEqual(await selectionState(), selection)
    assert.equal((await paginationState()).calls.length, 1)
    await finishPagination(); await assertPage(0, 500, 500); await assertCleared()
    assert.deepEqual((await paginationState()).selectedRows, [])
  })
  await check('failed page-size fetch preserves the original page, size and row/cell selection', async () => {
    await preparePagination({ size: 100, offset: 200 })
    await page.getByLabel('选择第 201 行', { exact: true }).check()
    await selectRectangle([200, 1], [201, 3])
    const before = retainedState(await paginationState())
    const selection = await selectionState()
    await queuePage(0, 1000, 'failure', true)
    await pageSize().selectOption('1000'); await waitPendingPagination()
    assert.equal(await pageSize().inputValue(), '100')
    await finishPagination()
    assert.deepEqual(retainedState(await paginationState()), before)
    assert.deepEqual(await selectionState(), selection)
    assert.equal(await pageSize().inputValue(), '100')
    assert.equal((await paginationState()).statusError, true)
    assert.match((await paginationState()).status, /合成分页请求失败/)
    assert.equal(await nextPage().isEnabled(), true)
  })
  await check('real draft Cancel preserves page/dirty/selection for size, previous, next, refresh and filter', async () => {
    for (const action of ['size', 'previous', 'next', 'refresh', 'filter']) {
      await preparePagination({ offset: 200 })
      await stageAndSelect(200)
      await searchFor('needle', needleMatches(200))
      for (let index = 0; index < 3; index++) await nextMatch().click()
      await settle(); await assertRectangle([200], [3], [200, 3])
      if (action === 'filter') await serverFilter().fill("note = 'Alpha'")
      const before = retainedState(await paginationState())
      const selection = await selectionState()
      if (action === 'size') await pageSize().selectOption('500')
      else await ({ previous: previousPage, next: nextPage, refresh, filter: applyFilter }[action])().click()
      const dialog = page.getByRole('dialog').filter({ hasText: '尚未应用的修改' })
      await dialog.waitFor()
      assert.deepEqual((await paginationState()).calls, [], 'Guard must run before any native request')
      if (action === 'size') assert.equal(await pageSize().inputValue(), '200')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await idlePagination()
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.deepEqual(retainedState(await paginationState()), before, action)
      assert.deepEqual(await selectionState(), selection, action)
      assert.equal(await pageSize().inputValue(), '200')
      assert.equal(await pageSearch().inputValue(), 'needle')
      assert.deepEqual(await coordinates('.is-page-match'), needleMatches(200))
      await nextMatch().click(); await settle(); await assertRectangle([201], [1], [201, 1])
      assert.deepEqual((await paginationState()).calls, [])
    }
  })
  await check('real draft Discard continues the page-size request only after the user chooses it', async () => {
    await preparePagination({ offset: 200 })
    await stageAndSelect(200)
    await queuePage(0, 100)
    await pageSize().selectOption('100')
    const dialog = page.getByRole('dialog').filter({ hasText: '尚未应用的修改' })
    await dialog.waitFor()
    assert.deepEqual((await paginationState()).calls, [])
    assert.equal((await paginationState()).dirty.length, 1)
    await dialog.getByRole('button', { name: '放弃本地修改', exact: true }).click()
    await idlePagination(); await assertPage(0, 100, 100); await assertCleared()
    assert.deepEqual((await paginationState()).dirty, [])
  })
  await check('unfinished real cell editing disables both page buttons and the page-size selector', async () => {
    await preparePagination({ offset: 200 })
    await rangeCell(200, 1).dblclick()
    const dialog = page.getByRole('dialog', { name: '编辑单元格', exact: true })
    await dialog.waitFor()
    await dialog.getByLabel('单元格值', { exact: true }).fill('unfinished')
    assert.equal((await paginationState()).pendingEditor, true)
    for (const control of [previousPage(), nextPage(), pageSize()]) assert.equal(await control.isDisabled(), true)
    assert.deepEqual((await paginationState()).calls, [])
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await settle()
    assert.equal((await paginationState()).pendingEditor, false)
    for (const control of [previousPage(), nextPage(), pageSize()]) assert.equal(await control.isEnabled(), true)
    assert.deepEqual((await paginationState()).dirty, [])
  })
  await check('workbench rejects unsupported page sizes without IPC, guards or result changes', async () => {
    await preparePagination({ offset: 200 })
    await stageAndSelect(200)
    const before = retainedState(await paginationState())
    for (const size of [0, -1, 50, 201, 200.5, 2000, NaN, Infinity]) {
      assert.match(await tryPageSize(size), /每页行数只支持/)
      await idlePagination()
      assert.deepEqual(retainedState(await paginationState()), before)
      assert.deepEqual((await paginationState()).calls, [])
      assert.equal(await page.getByRole('dialog').count(), 0)
    }
  })
  await check('same-size and cursorless changes are no-ops even with drafts; cursorless paging controls are disabled', async () => {
    for (const cursor of [true, false]) {
      await preparePagination({ offset: 200, cursor })
      await stageAndSelect(200)
      const before = retainedState(await paginationState())
      const selection = await selectionState()
      for (const size of cursor ? [200] : [100, 200, 500, 1000]) {
        assert.equal(await tryPageSize(size), null)
        await idlePagination()
        assert.deepEqual(retainedState(await paginationState()), before)
        assert.deepEqual(await selectionState(), selection)
        assert.deepEqual((await paginationState()).calls, [])
        assert.equal(await page.getByRole('dialog').count(), 0)
      }
      if (!cursor) {
        for (const control of [previousPage(), nextPage(), pageSize()]) assert.equal(await control.isDisabled(), true)
      }
    }
  })
  await check('refresh and subsequent paging inherit the selected page size and close only the old cursor', async () => {
    await preparePagination()
    await changeSize(500)
    await movePage(1, 500, 500)
    await queueQuery('SELECT synthetic_pagination', 500)
    await refresh().click(); await idlePagination(); await assertPage(0, 500, 500)
    assert.deepEqual((await paginationState()).sessionProbes, [{ connectionId: 'A', dialectId: 'mysql',
      sql: 'SELECT DATABASE() AS dbstudio_database' }])
    await movePage(1, 500, 500); await assertPage(500, 500, 500)
    assert.deepEqual((await paginationState()).calls.map(call => call[1].method), ['fetchResultPage', 'fetchResultPage', 'runQuery', 'closeCursor', 'fetchResultPage'])
  })
  await check('server filter distinguishes unapplied draft from a successful applied filter and inherits page size', async () => {
    await preparePagination()
    await changeSize(500)
    await serverFilter().fill("note = 'Alpha'"); await settle()
    assert.ok(await page.getByText(/未应用/).count(), 'Editing a filter must explain it is still a draft')
    const previous = retainedState(await paginationState())
    const beforeLabel = await appliedLabel().allTextContents()
    await queueQuery(filteredSql('Alpha'), 500, 'success', true)
    await applyFilter().click(); await waitPendingPagination()
    assert.deepEqual(retainedState(await paginationState()), previous)
    assert.deepEqual(await appliedLabel().allTextContents(), beforeLabel, 'Do not mark a pending filter as applied')
    await finishPagination(); await assertApplied("note = 'Alpha'")
    await assertPage(0, 500, 500)
    assert.equal((await paginationState()).querySql, filteredSql('Alpha'))
    await movePage(1, 500, 500); await assertApplied("note = 'Alpha'")
    await queueQuery(filteredSql('Alpha'), 500)
    await refresh().click(); await idlePagination(); await assertApplied("note = 'Alpha'")
    await assertPage(0, 500, 500)
  })
  await check('failed server filter retains the previous applied SQL/indicator and keeps the new draft unapplied', async () => {
    await preparePagination({ size: 100 })
    await serverFilter().fill("note = 'Alpha'")
    await queueQuery(filteredSql('Alpha'), 100)
    await applyFilter().click(); await idlePagination(); await assertApplied("note = 'Alpha'")
    await movePage(1, 100, 100)
    await serverFilter().fill("note = 'Beta'"); await settle()
    const before = retainedState(await paginationState())
    const callCount = (await paginationState()).calls.length
    await queueQuery(filteredSql('Beta'), 100, 'failure', true)
    await applyFilter().click(); await waitPendingPagination(); await assertApplied("note = 'Alpha'")
    await finishPagination()
    assert.deepEqual(retainedState(await paginationState()), before)
    await assertApplied("note = 'Alpha'")
    assert.equal(await serverFilter().inputValue(), "note = 'Beta'")
    assert.ok(await page.getByText(/未应用/).count())
    assert.equal((await paginationState()).statusError, true)
    assert.equal((await paginationState()).calls.length, callCount + 1, 'Failed query must not close the original cursor')
    await movePage(1, 200, 100); await assertPage(200, 100, 100)
  })
  await check('invalid filter is parsed before draft guard and cannot prompt, discard or invoke native writes', async () => {
    await preparePagination({ offset: 200 })
    await stageAndSelect(200)
    await serverFilter().fill('note =')
    const before = retainedState(await paginationState())
    const selection = await selectionState()
    const indicator = await appliedLabel().allTextContents()
    await applyFilter().click(); await settle()
    assert.equal(await page.getByRole('dialog').count(), 0, 'Invalid syntax must not reach the draft decision dialog')
    await idlePagination()
    assert.equal((await paginationState()).statusError, true)
    assert.match((await paginationState()).status, /缺少右侧值/)
    assert.deepEqual(retainedState(await paginationState()), before)
    assert.deepEqual(await selectionState(), selection)
    assert.deepEqual(await appliedLabel().allTextContents(), indicator)
    assert.deepEqual((await paginationState()).calls, [])
  })
  await check('page search is case insensitive, counts matching cells and never filters rows or searches unloaded pages', async () => {
    await preparePagination()
    await searchFor('nEeDlE', needleMatches(0))
    await searchFor('NextPageOnly', [])
    await searchFor('far_note', []) // Column headings are outside cell search.
    await searchFor('不存在的文本', [])
    await searchFor('', [])
    assert.equal(await page.locator('tbody tr').count(), 200)
  })
  await check('page search follows pinned/visible order, skips hidden cells and selects one focused cell per navigation', async () => {
    await preparePagination()
    await pin(3); await hide(2)
    const matches = [[0, 3], [0, 1], [1, 1], [45, 11]]
    await searchFor('needle', matches)
    await nextMatch().click(); await settle(); await assertRectangle([0], [3], [0, 3])
    await assertSearchStatus(4, 1)
    await nextMatch().click(); await settle(); await assertRectangle([0], [1], [0, 1])
    await assertSearchStatus(4, 2)
    await pageSearch().press('Enter'); await settle(); await assertRectangle([1], [1], [1, 1])
    await assertSearchStatus(4, 3)
    await pageSearch().press('Shift+Enter'); await settle(); await assertRectangle([0], [1], [0, 1])
    await assertSearchStatus(4, 2)
    await previousMatch().click(); await settle(); await assertRectangle([0], [3], [0, 3])
    await assertSearchStatus(4, 1)
    await choose(2); await page.getByRole('button', { name: '显示此列', exact: true }).click(); await settle()
    assert.deepEqual(await coordinates('.is-page-match'), [[0, 3], [0, 1], [0, 2], [1, 1], [45, 11]])
    assert.deepEqual((await paginationState()).calls, [])
  })
  await check('page search uses staged text, updates live after paste and preserves original cells and exact staged values', async () => {
    await preparePagination()
    await searchFor('StagedOnly', [])
    await pasteAt(0, 1, 'StagedOnly replacement'); await settle()
    assert.deepEqual(await coordinates('.is-page-match'), [[0, 1]])
    await searchFor('Needle Alpha', [])
    await searchFor('stagedonly', [[0, 1]])
    await pasteAt(0, 4, '9876543210.123456789012345678')
    await searchFor('9876543210.123456789012345678', [[0, 4]])
    await searchFor('1234567890.123456789012345678', [])
    await pasteAt(0, 5, 'StagedFullOnly')
    await searchFor('PreviewToken', [])
    await searchFor('stagedfullonly', [[0, 5]])
    const state = await paginationState()
    assert.equal(state.page.rows[0].cells[1].text, 'Needle Alpha')
    assert.equal(state.page.rows[0].cells[4].text, '1234567890.123456789012345678')
    assert.equal(state.dirty[0][1].changes.amount.text, '9876543210.123456789012345678')
    assert.deepEqual(state.calls, [])
  })
  await check('page search reads truncated preview only and preserves integer/decimal precision and rendered scalar text', async () => {
    await preparePagination()
    for (const [query, matches] of [
      ['previewtoken', [[0, 5]]], ['FullTextOnlyNeverLoaded', []],
      ['9007199254740993', [[0, 0]]], ['9223372036854775807', [[0, 8]]],
      ['1234567890.123456789012345678', [[0, 4]]], ['NULL', [[0, 6]]],
      ['true', [[0, 9]]], ['7.25', [[0, 10]]]
    ]) await searchFor(query, matches)
    await searchFor('PreviewToken', [[0, 5]])
    await nextMatch().click(); await settle(); await assertRectangle([0], [5], [0, 5])
    assert.deepEqual((await paginationState()).calls, [], 'Even preview navigation must not fetch full text')
  })
  await check('empty pages and zero matches disable navigation and Enter leaves selection intact', async () => {
    await preparePagination()
    await selectRectangle([0, 1], [1, 3])
    const selection = await selectionState()
    await searchFor('NoMatchAnywhere', [])
    for (const key of ['Enter', 'Shift+Enter']) {
      await pageSearch().press(key); await settle()
      assert.deepEqual(await selectionState(), selection)
    }
    await preparePagination({ total: 0 })
    await assertPage(0, 200, 0)
    await searchFor('needle', [])
    await pageSearch().press('Enter'); await pageSearch().press('Shift+Enter'); await settle()
    await assertCleared()
    assert.equal(await previousPage().isDisabled(), true)
    assert.equal(await nextPage().isDisabled(), true)
    assert.deepEqual((await paginationState()).calls, [])
  })
  await check('page-search IME Enter/ShiftEnter and keyCode 229 leave default, focus, selection and scroll untouched', async () => {
    await preparePagination()
    await searchFor('needle', needleMatches(0))
    await nextMatch().click(); await settle(); await assertRectangle([0], [1], [0, 1])
    await pageSearch().focus()
    const selection = await selectionState()
    const scroll = await page.locator('.grid-scroll').evaluate(el => [el.scrollLeft, el.scrollTop])
    for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const shiftKey of [false, true]) {
        const observed = await pageSearch().evaluate((element, options) => {
          const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })
          element.dispatchEvent(event)
          return { prevented: event.defaultPrevented, focused: element === document.activeElement }
        }, { ...ime, shiftKey })
        await settle()
        assert.deepEqual(observed, { prevented: false, focused: true })
        assert.deepEqual(await selectionState(), selection)
        assert.deepEqual(await page.locator('.grid-scroll').evaluate(el => [el.scrollLeft, el.scrollTop]), scroll)
      }
    }
    await pageSearch().press('Enter'); await settle(); await assertRectangle([0], [2], [0, 2])
    await pageSearch().press('Shift+Enter'); await settle(); await assertRectangle([0], [1], [0, 1])
    assert.deepEqual((await paginationState()).calls, [])
  })
  await check('page navigation retains search query, recomputes loaded matches and resets navigation position', async () => {
    await preparePagination()
    await searchFor('needle', needleMatches(0))
    await nextMatch().click(); await nextMatch().click(); await nextMatch().click(); await settle()
    await assertRectangle([0], [3], [0, 3])
    await movePage(1, 200, 200)
    assert.equal(await pageSearch().inputValue(), 'needle')
    assert.deepEqual(await coordinates('.is-page-match'), needleMatches(200))
    await assertSearchStatus(5)
    await assertCleared()
    await nextMatch().click(); await settle(); await assertRectangle([200], [1], [200, 1])
    await assertSearchStatus(5, 1)
    await searchFor('NextPageOnly', [[220, 1]])
    await movePage(-1, 0, 200)
    assert.equal(await pageSearch().inputValue(), 'NextPageOnly')
    assert.deepEqual(await coordinates('.is-page-match'), [])
    assert.equal(await nextMatch().isDisabled(), true)
    assert.equal(await previousMatch().isDisabled(), true)
  })
  await check('page-size, refresh and filter result replacements retain query and reset match position', async () => {
    for (const action of ['size', 'refresh', 'filter']) {
      await preparePagination()
      await searchFor('needle', needleMatches(0))
      for (let index = 0; index < 3; index++) await nextMatch().click()
      await settle(); await assertRectangle([0], [3], [0, 3])
      if (action === 'size') await changeSize(100)
      else if (action === 'refresh') {
        await queueQuery('SELECT synthetic_pagination', 200)
        await refresh().click(); await idlePagination()
      } else {
        await serverFilter().fill("note = 'Alpha'")
        await queueQuery(filteredSql('Alpha'), 200)
        await applyFilter().click(); await idlePagination()
      }
      assert.equal(await pageSearch().inputValue(), 'needle')
      assert.deepEqual(await coordinates('.is-page-match'), needleMatches(0))
      await assertSearchStatus(5)
      await assertCleared()
      await nextMatch().click(); await settle(); await assertRectangle([0], [1], [0, 1])
    }
  })
  await check('tab remount resets page search while each tab retains its own committed page size', async () => {
    await preparePagination()
    await changeSize(100)
    await searchFor('needle', needleMatches(0))
    await nextMatch().click(); await settle()
    await page.getByRole('button', { name: '宽表 B', exact: true }).click(); await settle()
    assert.equal(await pageSize().inputValue(), '200')
    assert.equal(await pageSearch().inputValue(), '')
    assert.deepEqual(await coordinates('.is-page-match'), [])
    await searchFor('previewtoken', [[0, 5]])
    await page.getByRole('button', { name: '宽表 A', exact: true }).click(); await settle()
    assert.equal(await pageSize().inputValue(), '100')
    assert.equal(await pageSearch().inputValue(), '')
    assert.deepEqual(await coordinates('.is-page-match'), [])
    await assertCleared()
    assert.equal(await nextMatch().isDisabled(), true)
    assert.equal(await previousMatch().isDisabled(), true)
    assert.equal((await paginationState()).calls.length, 1, 'Tab/search actions must not add IPC')
  })
  await check('search reveals offscreen cells in both axes without sticky headers/pins covering the focused match', async () => {
    await preparePagination()
    await pin(0); await pin(3)
    await searchFor('ScrollOnly', [[45, 11]])
    const before = await rangeCell(45, 11).boundingBox()
    const initialView = await page.locator('.grid-scroll').boundingBox()
    assert.ok(before.y > initialView.y + initialView.height, 'The target must start below the viewport')
    assert.ok(before.x > initialView.x + initialView.width, 'The target must start beyond the viewport horizontally')
    await nextMatch().click(); await settle(); await assertRectangle([45], [11], [45, 11])
    const box = await rangeCell(45, 11).boundingBox()
    const view = await page.locator('.grid-scroll').boundingBox()
    const pinned = await head(3).boundingBox()
    const headerBottom = await page.locator('thead th').evaluateAll(elements => Math.max(...elements.map(el => el.getBoundingClientRect().bottom)))
    assert.ok(await scrollLeft() > 0)
    assert.ok(await page.locator('.grid-scroll').evaluate(el => el.scrollTop > 0))
    assert.ok(box.x >= pinned.x + pinned.width - 1 && box.x + box.width <= view.x + view.width + 1)
    assert.ok(box.y >= headerBottom - 1 && box.y + box.height <= view.y + view.height + 1)
    assert.equal(await rangeCell(45, 11).evaluate(element => {
      const box = element.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return hit === element || element.contains(hit)
    }), true, 'The focused match must be hit-testable, not hidden beneath a sticky overlay')
    await assertSearchStatus(1, 1)
    await page.screenshot({ path: path.join(output, 'pagination-search.png') })
    assert.deepEqual((await paginationState()).calls, [])
  })
  await check('full text arriving during pagination cannot open an editor that the new page would erase', async () => {
    for (const action of ['size', 'next']) {
      await preparePagination()
      await page.evaluate(() => window.gridFixture.deferredFullCell(0, 5))
      await rangeCell(0, 5).dblclick()
      await page.waitForFunction(() => window.gridFixture.nativeState().pending?.requested)
      assert.equal(await page.getByRole('dialog').count(), 0)
      await queuePage(action === 'size' ? 0 : 200, action === 'size' ? 500 : 200, 'success', true)
      if (action === 'size') await pageSize().selectOption('500')
      else await nextPage().click()
      await waitPendingPagination()
      await page.evaluate(() => window.gridFixture.finishFullCell('success')); await settle()
      assert.equal(await page.getByRole('dialog').count(), 0, 'No late editable draft while page request is pending')
      assert.equal((await paginationState()).pendingEditor, false)
      await finishPagination()
      await assertPage(action === 'size' ? 0 : 200, action === 'size' ? 500 : 200, action === 'size' ? 500 : 200)
      assert.equal(await page.getByRole('dialog').count(), 0)
      await rangeCell(action === 'size' ? 0 : 200, 1).dblclick()
      const editor = page.getByRole('dialog', { name: '编辑单元格', exact: true })
      await editor.waitFor()
      await editor.getByLabel('单元格值', { exact: true }).fill('current-page draft')
      assert.equal(await pageSize().isDisabled(), true)
      await editor.getByRole('button', { name: '取消', exact: true }).click()
      await settle()
    }
  })
  const countButton = () => page.getByRole('button', { name: /^COUNT(?:\:|$)|^统计中…$/ })
  const cancelCount = () => page.getByRole('button', { name: '取消统计', exact: true })
  async function beginCount(supported = true) {
    await page.evaluate(supported => window.gridFixture.armCount(supported), supported)
    await countButton().click()
    await page.waitForFunction(() => window.gridFixture.countState().requested)
    assert.equal(await countButton().textContent(), '统计中…')
    assert.equal(await pageSize().isDisabled(), true)
  }
  async function beginCancel() {
    await page.evaluate(() => window.gridFixture.armCountCancel())
    await cancelCount().click()
    await page.waitForFunction(() => window.gridFixture.countState().cancelRequested)
    assert.equal(await cancelCount().isDisabled(), true)
  }
  async function finishCount(outcome, value = 1000000) {
    await page.evaluate(({ outcome, value }) => window.gridFixture.finishCount(outcome, value), { outcome, value })
    await idlePagination()
    assert.equal(await cancelCount().count(), 0)
  }
  await check('COUNT is explicit, survives tab switching, cancels only its own request and retains drafts', async () => {
    await preparePagination()
    await stageAndSelect(0)
    const before = retainedState(await paginationState())
    await beginCount()
    const signal = await page.evaluate(() => window.gridFixture.countState().signal)
    await page.getByRole('button', { name: '宽表 B', exact: true }).click(); await settle()
    assert.equal(await cancelCount().count(), 0)
    assert.equal(await pageSize().isEnabled(), true, 'Other connection must remain usable')
    await page.getByRole('button', { name: '宽表 A', exact: true }).click(); await settle()
    assert.equal(await countButton().textContent(), '统计中…')
    await beginCancel()
    await page.evaluate(() => window.gridFixture.finishCountCancel('true')); await settle()
    assert.ok(await page.getByText('已请求取消，等待统计结束', { exact: true }).isVisible())
    assert.equal(await pageSize().isDisabled(), true)
    await page.screenshot({ path: path.join(output, 'count-cancel.png') })
    await finishCount('cancelled')
    assert.ok(await page.getByText('统计已取消', { exact: true }).isVisible())
    assert.deepEqual(retainedState(await paginationState()), before)
    const calls = (await paginationState()).calls
    assert.deepEqual(calls.map(call => call[1].method), ['countRows', 'cancelQuery'])
    assert.deepEqual(calls[1][1].args, ['connection:A', signal])
    await beginCount()
    assert.notEqual(await page.evaluate(() => window.gridFixture.countState().signal), signal)
    await finishCount('success')
    assert.equal(await countButton().textContent(), 'COUNT: 1000000')
    assert.match(await page.getByText(/^完整对象共/).textContent(), /不含当前筛选/)
  })
  await check('COUNT cancel false/failure can retry without unlocking or claiming the query stopped', async () => {
    await preparePagination()
    await beginCount()
    for (const outcome of ['false', 'failure']) {
      await beginCancel()
      await page.evaluate(outcome => window.gridFixture.finishCountCancel(outcome), outcome); await settle()
      assert.equal(await cancelCount().isEnabled(), true)
      assert.equal(await pageSize().isDisabled(), true)
      assert.ok(await page.getByText(outcome === 'false' ? /未取消：统计/ : /取消失败：合成取消失败/).isVisible())
    }
    await beginCancel()
    await page.evaluate(() => window.gridFixture.finishCountCancel('true')); await settle()
    await finishCount('cancelled')
  })
  await check('COUNT result wins a cancellation race but the connection stays locked until cancel returns', async () => {
    await preparePagination()
    await beginCount(); await beginCancel()
    await page.evaluate(() => window.gridFixture.finishCount('success', 17)); await settle()
    assert.equal(await pageSize().isDisabled(), true)
    assert.equal(await cancelCount().isDisabled(), true)
    await page.evaluate(() => window.gridFixture.finishCountCancel('true')); await idlePagination()
    assert.equal(await countButton().textContent(), 'COUNT: 17')
    assert.equal(await cancelCount().count(), 0)
    assert.equal(await pageSize().isEnabled(), true)
  })
  await check('unsupported COUNT cancellation is explicit; errors and nonexact counts never become successful totals', async () => {
    await preparePagination()
    await beginCount(false)
    assert.equal(await cancelCount().isDisabled(), true)
    assert.ok(await page.getByText('当前驱动不支持取消统计', { exact: false }).isVisible())
    await finishCount('success', 42)
    assert.deepEqual((await paginationState()).calls.map(call => call[1].method), ['countRows'])
    await beginCount(); await finishCount('failure')
    assert.match(await page.getByRole('alert').textContent(), /统计失败：合成统计失败/)
    assert.equal(await countButton().textContent(), 'COUNT')
    await beginCount(); await finishCount('success', 9007199254740992)
    assert.match(await page.getByRole('alert').textContent(), /精确/)
    assert.equal(await countButton().textContent(), 'COUNT')
  })
  assert.equal(results.length, 59)
  await idlePagination()
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
