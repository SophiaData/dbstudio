// Run the production ResultGrid in an isolated Electron renderer. Only the API
// transport is controlled; query/paging/dispose behavior comes from grid.ts.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { _electron as electron } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const work = mkdtempSync(join(tmpdir(), 'dbstudio-grid-lifecycle-'))
let app
try {
  const result = await build({
    configFile: false, logLevel: 'error',
    build: {
      write: false, minify: false,
      // Optional source snapshot for proving these regressions fail before a fix.
      lib: {
        entry: process.env.DBSTUDIO_GRID_TEST_SOURCE ?? resolve(root, 'src/renderer/grid.ts'),
        formats: ['iife'], name: 'GridUnderTest'
      }
    }
  })
  const chunk = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === 'chunk')
  assert.ok(chunk)
  const main = join(work, 'main.cjs')
  writeFileSync(main, `
    const { app, BrowserWindow } = require('electron')
    app.whenReady().then(() => {
      const win = new BrowserWindow({ show: false, width: 1000, height: 700,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      win.loadURL('data:text/html,<html><head></head><body></body></html>')
    })
  `)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({
    executablePath: require('electron'), args: [main], env,
    ...(process.platform === 'linux' && env.ELECTRON_DISABLE_SANDBOX === '1'
      ? { args: ['--no-sandbox', main] } : {})
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.addStyleTag({ content: readFileSync(resolve(root, 'src/renderer/style.css'), 'utf8') })
  await page.addScriptTag({ content: chunk.code })
  const results = await page.evaluate(async () => {
    const results = []
    const assert = (value, message) => { if (!value) throw new Error(message) }
    const deferred = () => {
      let resolve, reject
      const promise = new Promise((yes, no) => { resolve = yes; reject = no })
      return { promise, resolve, reject }
    }
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const until = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return
        await flush()
      }
      throw new Error('Expected API request did not start')
    }
    const columns = [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }]
    const data = (cursorId, prefix, offset = 0, count = 100, hasMore = true) => ({
      cursorId, columns, offset, returned: count, hasMore, executedSql: 'SELECT * FROM items', elapsedMs: 0,
      rows: Array.from({ length: count }, (_, i) => ({
        index: offset + i,
        cells: [{ kind: 'number', value: offset + i + 1 }, { kind: 'text', text: `${prefix}-${offset + i + 1}` }]
      }))
    })
    const fixture = () => {
      const root = document.createElement('div')
      root.className = 'tab-grid-root'
      root.style.cssText = 'height:400px;width:800px;display:flex;flex-direction:column'
      document.body.append(root)
      const queries = [], pages = [], closed = [], statuses = []
      const grid = new GridUnderTest.ResultGrid(root, { onStatus: (text) => statuses.push(text) })
      grid.attachApi({
        runQuery: () => { const d = deferred(); queries.push(d); return d.promise },
        fetchResultPage: (cursor, offset) => {
          const d = deferred(); pages.push({ ...d, cursor, offset }); return d.promise
        },
        closeCursor: async (cursor) => { closed.push(cursor) },
        listDialects: async () => [{ quoting: { open: '"', close: '"', escape: 'double' } }],
        transactionState: async () => ({ active: false, pendingAffected: 0 })
      })
      const scroll = () => {
        const viewport = root.querySelector('.grid-viewport')
        viewport.scrollTop = 110 * 24
        viewport.dispatchEvent(new Event('scroll'))
      }
      const query = () => grid.runSql('connection:a1-races', 'SELECT * FROM items')
      const start = async (cursor = 'old') => {
        const run = query()
        await until(() => queries.length === 1)
        queries[0].resolve(data(cursor, cursor))
        await run
      }
      return { grid, root, queries, pages, closed, statuses, scroll, query, start }
    }
    const test = async (name, body) => {
      const f = fixture()
      try { await body(f); results.push({ name, ok: true }) }
      catch (e) { results.push({ name, ok: false, error: String(e) }) }
      finally { await f.grid.dispose(); f.root.remove() }
    }
    await test('late initial result is discarded and its cursor closed', async (f) => {
      const first = f.query()
      await until(() => f.queries.length === 1)
      const second = f.query()
      await until(() => f.queries.length === 2)
      f.queries[1].resolve(data('fresh', 'fresh'))
      await second
      f.queries[0].resolve(data('stale', 'stale'))
      await first
      assert(f.grid.exportLoadedRows().cursorId === 'fresh', 'old query replaced active cursor')
      assert(f.closed.includes('stale') && !f.closed.includes('fresh'), 'wrong cursor cleanup')
      assert(f.grid.exportLoadedRows().rows[0].cells[1].text === 'fresh-1', 'old query replaced rows')
    })
    await test('late initial error cannot change the newer status', async (f) => {
      const first = f.query()
      await until(() => f.queries.length === 1)
      const second = f.query()
      await until(() => f.queries.length === 2)
      f.queries[1].resolve(data('fresh', 'fresh'))
      await second
      const before = f.statuses.length
      f.queries[0].reject(new Error('obsolete-query-error'))
      await first
      assert(!f.statuses.slice(before).some((s) => s.includes('obsolete-query-error')), 'old error shown')
    })
    for (const rejectOldPage of [false, true]) {
      await test(`late page ${rejectOldPage ? 'failure' : 'success'} cannot alter new cache or inflight`, async (f) => {
        await f.start()
        f.scroll()
        await until(() => f.pages.some((p) => p.cursor === 'old' && p.offset === 100))
        const oldPage = f.pages.find((p) => p.cursor === 'old' && p.offset === 100)
        const reload = f.query()
        await until(() => f.queries.length === 2)
        f.queries[1].resolve(data('fresh', 'fresh'))
        await reload
        f.scroll()
        await until(() => f.pages.some((p) => p.cursor === 'fresh' && p.offset === 100))
        const freshPage = f.pages.find((p) => p.cursor === 'fresh' && p.offset === 100)
        const before = f.statuses.length
        if (rejectOldPage) oldPage.reject(new Error('obsolete-page-error'))
        else oldPage.resolve(data('old', 'stale', 100, 1, false))
        await flush()
        const snapshot = f.grid.exportLoadedRows()
        assert(snapshot.rows.every((r) => !r.cells[1].text.startsWith('stale')), 'old page entered new cache')
        assert(snapshot.hasMore, 'old page changed exhaustion')
        assert(!f.statuses.slice(before).some((s) => s.includes('obsolete-page-error')), 'old page error shown')
        f.scroll()
        await flush()
        assert(f.pages.filter((p) => p.cursor === 'fresh' && p.offset === 100).length === 1, 'old finally removed new inflight')
        freshPage.resolve(data('fresh', 'fresh', 100, 100, false))
        await flush()
        assert(f.grid.exportLoadedRows().rows.length === 200, 'new page not accepted')
      })
    }
    await test('dispose invalidates unfinished query and closes its late cursor', async (f) => {
      const pending = f.query()
      await until(() => f.queries.length === 1)
      await f.grid.dispose()
      const html = f.root.innerHTML
      const statusCount = f.statuses.length
      f.queries[0].resolve(data('late', 'late'))
      await pending
      assert(f.closed.includes('late'), 'late cursor leaked after dispose')
      assert(f.grid.exportLoadedRows().cursorId === null, 'disposed grid acquired a cursor')
      assert(f.root.innerHTML === html && f.statuses.length === statusCount, 'disposed grid rendered or changed status')
    })
    await test('dispose invalidates pending pages without rendering', async (f) => {
      await f.start()
      f.scroll()
      await until(() => f.pages.length > 0)
      await f.grid.dispose()
      const html = f.root.innerHTML
      const statusCount = f.statuses.length
      for (const p of f.pages) p.resolve(data('old', 'stale', p.offset, 1, false))
      await flush()
      assert(f.grid.exportLoadedRows().loadedCount === 0, 'page returned into disposed cache')
      assert(f.root.innerHTML === html && f.statuses.length === statusCount, 'disposed page rendered')
    })
    await test('dispose invalidates pending sort without publishing a success status', async (f) => {
      await f.start()
      f.root.querySelector('.grid-col-header').click()
      await until(() => f.queries.length === 2)
      await f.grid.dispose()
      const html = f.root.innerHTML
      const statusCount = f.statuses.length
      f.queries[1].resolve(data('sorted-late', 'late'))
      await until(() => f.closed.includes('sorted-late'))
      await flush()
      assert(f.root.innerHTML === html && f.statuses.length === statusCount, 'disposed sort rendered or reported success')
    })
    return results
  })
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.error ? `: ${result.error}` : ''}`)
  assert.ok(results.every((result) => result.ok), 'Production ResultGrid lifecycle regressions')
  console.log(`ResultGrid lifecycle: ${results.length} passed`)
} finally {
  await app?.close()
  rmSync(work, { recursive: true, force: true })
}
