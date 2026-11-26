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
