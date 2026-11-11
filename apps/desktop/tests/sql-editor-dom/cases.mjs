import assert from 'node:assert/strict'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

const FIRST = 'SELECT 41 AS from_keyboard;'
const SECOND = 'SELECT 42 AS from_script;'
const SCRIPT = `${FIRST}\n${SECOND}`
const normalizeStatement = (sql) => sql.trim().replace(/;$/, '')

export async function runSqlEditorDom(page, { url, evidenceDirectory, phase }) {
  const address = new URL(url)
  assert.equal(address.hostname, '127.0.0.1')
  assert.ok(!['1420', '62032'].includes(address.port), 'use an independent fixture port')
  assert.match(phase, /^[a-z][a-z0-9-]{0,35}$/)
  const evidence = await realpath(evidenceDirectory)
  assert.match(path.basename(evidence), /^mysql-editor-dom-/)
  const screenshots = path.join(evidence, 'screenshots', phase)
  await mkdir(screenshots, { recursive: false })
  const consoleErrors = []
  const recordPageError = (error) => consoleErrors.push(error.message)
  page.on('pageerror', recordPageError)
  const cases = []
  await page.setViewportSize({ width: 1200, height: 850 })
  const editor = () => page.getByRole('textbox', { name: 'SQL 编辑器', exact: true })
  const events = async () => page.getByTestId('execute-sql').allTextContents()
  async function reset(sql = SCRIPT) {
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: 'SQL 编辑器 DOM 验收夹具' }).waitFor()
    await editor().fill(sql)
    assert.equal(await page.getByTestId('execute-count').innerText(), '0')
  }
  async function textStart() {
    // Unmodified arrow keys behave consistently across the browser host platforms.
    const length = (await editor().inputValue()).length
    for (let index = 0; index < length; index++) await editor().press('ArrowLeft')
  }
  async function firstWordCaret() {
    await textStart()
    for (let index = 0; index < 6; index++) await editor().press('ArrowRight')
    assert.equal(await editor().evaluate((input) => input.selectionStart), 6)
  }
  async function openCompletion() {
    await firstWordCaret()
    await editor().press('Control+Space')
    await page.getByRole('listbox', { name: 'SQL 补全' }).waitFor({ state: 'visible' })
  }
  async function capture(id) {
    const screenshot = path.join(screenshots, `${id}.png`)
    await writeFile(screenshot, await page.screenshot({ fullPage: true }), { flag: 'wx' })
    return screenshot
  }
  async function observed() {
    return {
      execute_count: Number(await page.getByTestId('execute-count').innerText()),
      sql_events: await events(), input_sql: await editor().inputValue(),
      listbox_visible: await page.getByRole('listbox', { name: 'SQL 补全' }).isVisible(),
      input_disabled: await editor().isDisabled()
    }
  }
  async function test(id, name, actions, verify) {
    await reset()
    let passed = false, failure = null
    try { await actions(); await verify(); passed = true }
    catch (error) { failure = error instanceof Error ? error.message : String(error) }
    const state = await observed()
    const screenshot = await capture(id)
    cases.push({ id, name, passed, failure, observed: state, screenshot: path.relative(evidence, screenshot) })
  }
  async function assertSingleCurrent() {
    const emitted = await events()
    assert.equal(emitted.length, 1, 'execute current exactly once')
    assert.equal(normalizeStatement(emitted[0]), normalizeStatement(FIRST))
    assert.equal(await editor().inputValue(), SCRIPT, 'execution must not accept or rewrite a completion')
    assert.equal(await page.getByRole('listbox', { name: 'SQL 补全' }).isVisible(), false)
  }
  async function assertSingleAll() {
    assert.deepEqual(await events(), [SCRIPT], 'execute whole script exactly once')
    assert.equal(await editor().inputValue(), SCRIPT)
    assert.equal(await page.getByRole('listbox', { name: 'SQL 补全' }).isVisible(), false)
  }
  try {
    for (const [id, key] of [['D01', 'Control+Enter'], ['D02', 'Meta+Enter']]) {
      await test(id, `completion-visible ${key} executes current`, async () => { await openCompletion(); await editor().press(key) }, assertSingleCurrent)
    }
    for (const [id, key] of [['D03', 'Control+Shift+Enter'], ['D04', 'Meta+Shift+Enter'], ['D05', 'Shift+Enter']]) {
      await test(id, `completion-visible ${key} executes all`, async () => { await openCompletion(); await editor().press(key) }, assertSingleAll)
    }
    await test('D06', 'selected text shortcut executes selection once', async () => {
      await openCompletion()
      await textStart()
      for (let index = 0; index < FIRST.length; index++) await editor().press('Shift+ArrowRight')
      await editor().press('Control+Enter')
    }, assertSingleCurrent)
    await test('D07', 'whole-script shortcut ignores selection', async () => {
      await openCompletion()
      await textStart()
      for (let index = 0; index < FIRST.length; index++) await editor().press('Shift+ArrowRight')
      await editor().press('Meta+Shift+Enter')
    }, assertSingleAll)
    for (const [id, key] of [['D08', 'Enter'], ['D09', 'Tab']]) {
      await test(id, `plain ${key} accepts completion without execution`, async () => {
        await editor().fill('sel')
        await page.getByRole('listbox', { name: 'SQL 补全' }).waitFor({ state: 'visible' })
        await editor().press(key)
      }, async () => {
        assert.deepEqual(await events(), [])
        assert.equal(await editor().inputValue(), 'SELECT')
        assert.equal(await page.getByRole('listbox', { name: 'SQL 补全' }).isVisible(), false)
      })
    }
    await test('D10', 'Escape closes completion and later shortcut works', async () => {
      await openCompletion(); await editor().press('Escape')
      assert.deepEqual(await events(), [])
      assert.equal(await page.getByRole('listbox', { name: 'SQL 补全' }).isVisible(), false)
      await editor().press('Control+Enter')
    }, assertSingleCurrent)
    await test('D11', 'current button emits current once', async () => {
      await firstWordCaret(); await page.getByRole('button', { name: '执行当前', exact: true }).click()
    }, async () => {
      const emitted = await events()
      assert.equal(emitted.length, 1)
      assert.equal(normalizeStatement(emitted[0]), normalizeStatement(FIRST))
      assert.equal(await editor().inputValue(), SCRIPT)
    })
    await test('D12', 'all button emits script once', async () => {
      await page.getByRole('button', { name: '执行全部', exact: true }).click()
    }, async () => { assert.deepEqual(await events(), [SCRIPT]); assert.equal(await editor().inputValue(), SCRIPT) })
    await test('D13', 'disabled input and execution buttons cannot execute', async () => {
      await page.getByTestId('fixture-disabled').check()
      assert.equal(await editor().isDisabled(), true)
      for (const name of ['执行当前', '执行全部']) assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true)
      await page.keyboard.press('Control+Enter'); await page.keyboard.press('Meta+Enter'); await page.keyboard.press('Shift+Enter')
    }, async () => { assert.deepEqual(await events(), []); assert.equal(await editor().inputValue(), SCRIPT) })
    await test('D14', 'shortcut without completion still executes current once', async () => {
      await firstWordCaret(); assert.equal(await page.getByRole('listbox', { name: 'SQL 补全' }).isVisible(), false)
      await editor().press('Meta+Enter')
    }, assertSingleCurrent)
    await test('D15', 'selected text current button respects DOM selection', async () => {
      await textStart()
      for (let index = 0; index < FIRST.length + 1; index++) await editor().press('ArrowRight')
      for (let index = 0; index < SECOND.length; index++) await editor().press('Shift+ArrowRight')
      await page.getByRole('button', { name: '执行当前', exact: true }).click()
    }, async () => {
      const emitted = await events()
      assert.equal(emitted.length, 1)
      assert.equal(normalizeStatement(emitted[0]), normalizeStatement(SECOND))
    })
  } finally { page.off('pageerror', recordPageError) }
  const passed = cases.filter((entry) => entry.passed).length
  const summary = {
    scope: 'real-browser-dom-real-sfc-synthetic-refs', phase,
    total: cases.length, passed, failed: cases.length - passed,
    browser: page.context().browser()?.version() ?? 'browser-tool',
    os_keyboard_verified: false, tauri_verified: false, mysql_verified: false,
    fixture_uses_backend: false, fixture_uses_storage: false,
    page_errors: consoleErrors, cases
  }
  await writeFile(path.join(evidence, `${phase}.json`), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
  return summary
}
