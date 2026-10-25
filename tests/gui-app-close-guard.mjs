import assert from 'node:assert/strict'
import { launchTransactionApp, pane } from './helpers/transaction-app.mjs'

let passed = 0
async function scenario(name, fn, overrides = {}) {
  const f = await launchTransactionApp(overrides)
  try {
    await f.add()
    await f.open()
    await fn(f)
    console.log(`PASS ${name}`)
    passed++
  } finally { await f.stop() }
}
const close = (f) => f.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
const quit = (f) => f.app.evaluate(({ app }) => { app.quit() })
const dialog = (f) => f.win.waitForSelector('#dbstudio-transaction-dialog')
const shortTimers = (f) => f.app.evaluate(() => {
  const original = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 60000 ? 150 : ms, ...args)
})
const crashRenderer = (f) => f.app.evaluate(({ BrowserWindow }) => new Promise((resolve, reject) => {
  const contents = BrowserWindow.getAllWindows()[0].webContents
  const onGone = () => {
    clearTimeout(timer)
    resolve()
  }
  const timer = setTimeout(() => {
    contents.removeListener('render-process-gone', onGone)
    reject(new Error('Renderer crash did not emit render-process-gone within 10s'))
  }, 10_000)
  contents.once('render-process-gone', onGone)
  contents.forcefullyCrashRenderer()
}))

await scenario('normal decision timeout never grants close; cancel preserves dirty data', async (f) => {
  await shortTimers(f)
  const listeners = await f.app.evaluate(({ BrowserWindow }) => {
    const c = BrowserWindow.getAllWindows()[0].webContents
    return ['render-process-gone', 'unresponsive', 'destroyed'].map((event) => c.listenerCount(event))
  })
  await f.edit('pending')
  await close(f)
  await dialog(f)
  await new Promise((r) => setTimeout(r, 350))
  assert.equal(f.win.isClosed(), false, 'timer closed a dirty window without a decision')
  await close(f)
  assert.equal(await f.win.locator('#dbstudio-transaction-dialog').count(), 1)
  assert.deepEqual(f.values(), ['original', 'second'])
  await f.choose('cancel')
  assert.equal(await f.win.locator(`${pane} .is-dirty`).count(), 1)
  await f.app.evaluate(() => new Promise((resolve) => setImmediate(resolve)))
  assert.deepEqual(await f.app.evaluate(({ BrowserWindow }) => {
    const c = BrowserWindow.getAllWindows()[0].webContents
    return ['render-process-gone', 'unresponsive', 'destroyed'].map((event) => c.listenerCount(event))
  }), listeners)
})

await scenario('repeated real app.quit is prevented while one confirmation is pending', async (f) => {
  await f.edit('pending')
  await f.app.evaluate(({ app }) => {
    globalThis.quitPrevented = []
    app.on('before-quit', (event) => globalThis.quitPrevented.push(event.defaultPrevented))
  })
  await quit(f)
  await dialog(f)
  await quit(f)
  assert.deepEqual(await f.app.evaluate(() => globalThis.quitPrevented), [true, true])
  assert.equal(await f.win.locator('#dbstudio-transaction-dialog').count(), 1)
  await f.choose('cancel')
  assert.deepEqual(f.values(), ['original', 'second'])
})

await scenario('unfinished cell editor is included in window-close protection', async (f) => {
  await f.win.evaluate(() => {
    document.querySelector('.tab-pane:not([hidden]) .grid-row')?.querySelectorAll('.grid-cell')[2]
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await f.win.locator(`${pane} .grid-cell-editor`).fill('still-typing')
  await close(f)
  await dialog(f)
  await f.choose('cancel')
  assert.equal(await f.win.locator(`${pane} .is-dirty`).textContent(), 'still-typing')
  assert.deepEqual(f.values(), ['original', 'second'])
})

for (const action of ['apply-commit', 'discard-rollback']) {
  await scenario(`real quit handles applied and local edits: ${action}`, async (f) => {
    await f.edit('applied')
    await f.win.getByRole('button', { name: '应用修改', exact: true }).click()
    await f.win.waitForFunction(() => document.querySelector('.tab-pane:not([hidden]) .grid-tx-info')?.textContent?.includes('未提交'), { timeout: 5000 })
    await f.win.waitForFunction(() => {
      const cell = document.querySelector('.tab-pane:not([hidden]) .grid-row')?.querySelectorAll('.grid-cell')[2]
      return cell?.textContent === 'applied' && !cell.classList.contains('is-dirty')
    })
    await f.edit('local', 1)
    assert.deepEqual(f.values(), ['original', 'second'])
    await quit(f)
    await dialog(f)
    const exited = f.app.waitForEvent('close')
    await f.choose(action)
    await exited
    assert.deepEqual(f.values(), action === 'apply-commit' ? ['applied', 'local'] : ['original', 'second'])
  })
}

if (process.platform === 'darwin') {
  await scenario('macOS recreated window must obtain a fresh close approval', async (f) => {
    const closed = f.win.waitForEvent('close')
    await close(f)
    await closed
    await f.recreate()
    await f.win.locator('.tree-row .row-label').getByText('guard-db', { exact: true }).click()
    await f.win.getByRole('button', { name: '连接', exact: true }).click()
    await f.win.waitForFunction(() => document.querySelector('#tree-summary')?.textContent?.includes('1 个已连接'))
    await f.open()
    await f.edit('new-window')
    await close(f)
    await dialog(f)
    assert.equal(f.win.isClosed(), false)
    await f.choose('cancel')
    assert.deepEqual(f.values(), ['original', 'second'])
  })
}

await scenario('crashed renderer requires native confirmation; cancel keeps window', async (f) => {
  await f.edit('applied')
  await f.win.getByRole('button', { name: '应用修改', exact: true }).click()
  await f.win.waitForSelector(`${pane} .grid-tx-info.is-pending`)
  await f.app.evaluate(({ dialog }) => {
    globalThis.nativePrompts = []
    globalThis.nativeResponse = 0
    dialog.showMessageBox = async (_win, options) => {
      globalThis.nativePrompts.push(options)
      return { response: globalThis.nativeResponse }
    }
  })
  await crashRenderer(f)
  await quit(f)
  assert.equal(await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  assert.ok((await f.app.evaluate(() => globalThis.nativePrompts)).length > 0)
  assert.deepEqual(f.values(), ['original', 'second'])
  await f.app.evaluate(() => { globalThis.nativeResponse = 1 })
  const exited = f.app.waitForEvent('close')
  await quit(f)
  await exited
  assert.deepEqual(f.values(), ['original', 'second'])
})
await scenario('unresponsive notification offers cancel without replacing the pending decision', async (f) => {
  await f.edit('pending')
  await close(f)
  await dialog(f)
  await f.app.evaluate(({ BrowserWindow, dialog }) => {
    globalThis.promptCount = 0
    dialog.showMessageBox = async () => { globalThis.promptCount++; return { response: 0 } }
    BrowserWindow.getAllWindows()[0].webContents.emit('unresponsive')
  })
  assert.equal(await f.app.evaluate(() => globalThis.promptCount), 1)
  assert.equal(await f.win.locator('#dbstudio-transaction-dialog').count(), 1)
  await close(f)
  await f.choose('cancel')
  assert.equal(f.win.isClosed(), false)
  assert.deepEqual(f.values(), ['original', 'second'])
})

await scenario('renderer crash during a pending dialog cancels safely and permits explicit retry', async (f) => {
  await f.edit('pending')
  await quit(f)
  await dialog(f)
  await f.app.evaluate(({ dialog }) => {
    globalThis.promptCount = 0
    globalThis.response = 0
    dialog.showMessageBox = async () => { globalThis.promptCount++; return { response: globalThis.response } }
  })
  await crashRenderer(f)
  assert.ok(await f.app.evaluate(() => globalThis.promptCount > 0))
  assert.equal(await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  await f.app.evaluate(() => { globalThis.response = 1 })
  const exited = f.app.waitForEvent('close')
  await quit(f)
  await exited
  assert.deepEqual(f.values(), ['original', 'second'])
})
console.log(`App close guard: ${passed} scenarios passed`)
