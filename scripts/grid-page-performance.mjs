import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// No local launch and no browser download. GitHub supplies the installed Chrome.
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Page performance browser measurement is GitHub Actions only')
assert.ok(process.env.RUNNER_TEMP, 'GitHub runner temporary directory is required')
assert.match(process.env.GITHUB_SHA ?? '', /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i, 'Source SHA is required')
const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.resolve(process.env.DBSTUDIO_PAGE_PERF_DIR ?? path.join(root, 'out/page-performance'))
assert.equal(output, path.resolve(root, 'out/page-performance'), 'Only the dedicated public artifact directory is supported')
const repeats = 5
const sourceSha = process.env.GITHUB_SHA
const viewport = { width: 1600, height: 1000 }
const results = []
const nativeReports = []
let browser, server, activeCase = null, stage = 'validate-native-evidence'
let failed = false
let browserVersion = null
let unexpectedNetwork = 0
const runtimeErrors = []

function duration(value) {
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'Timings must be finite nonnegative milliseconds')
}
function summary(values) {
  values.forEach(duration)
  const sorted = [...values].sort((a, b) => a - b)
  return { count: values.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length }
}
async function readPublicJson(filename, maxBytes) {
  assert.equal(path.basename(filename), filename, 'Artifact name must not contain a path')
  const file = path.join(output, filename)
  const info = await stat(file)
  assert.ok(info.isFile() && info.size > 0 && info.size <= maxBytes, 'Public JSON must have a bounded size')
  const bytes = await readFile(file)
  return { value: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') }
}
function expectedText(id) {
  return [String(id), (9007199254740993n + BigInt(id)).toString(), `${id}.123456789012345678`, `分页验收中文-${id}`]
}
function validateSample(sample, report, item) {
  assert.equal(sample.schemaVersion, 1)
  for (const field of ['caseId', 'rows', 'offset', 'size', 'method', 'repeats']) assert.equal(sample[field], item[field])
  assert.equal(sample.dialect, report.dialect)
  assert.equal(sample.sourceSha, sourceSha)
  assert.match(sample.query.cursorId, /^(?:pg|mysql)-cur-\d+$/)
  const table = report.dialect === 'postgresql' ? '"public"[.]"page_perf_[a-f0-9]{16}_' : '`fixture`[.]`page_perf_[a-f0-9]{16}_'
  const closing = report.dialect === 'postgresql' ? '"' : '`'
  assert.match(sample.query.executedSql, new RegExp(`^SELECT id,big,amount,body FROM ${table}${item.rows}${closing} ORDER BY id ASC$`))
  duration(sample.query.elapsedMs)
  const page = sample.page
  assert.equal(page.offset, item.offset)
  assert.equal(page.returned, item.size)
  assert.equal(page.rows.length, item.size)
  assert.equal(page.hasMore, item.offset + item.size < item.rows)
  assert.deepEqual(page.columns.map(column => column.name), ['id', 'big', 'amount', 'body'])
  for (const [position, row] of page.rows.entries()) {
    const id = item.offset + position + 1
    assert.equal(row.index, id - 1)
    assert.equal(row.cells.length, 4)
    assert.equal(row.cells[0].kind, 'number')
    assert.equal(row.cells[0].value, id)
    const expected = expectedText(id)
    for (let column = 1; column < 4; column++) {
      assert.equal(row.cells[column].kind, 'text')
      assert.equal(row.cells[column].text, expected[column])
      assert.notEqual(row.cells[column].truncated, true)
    }
  }
}
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function verifyDom(page, item) {
  // This observer reads DOM only. It does not trust the fixture's reactive model.
  const rendered = await page.locator('.result-data-table tbody tr').evaluateAll(elements => elements.map(row => ({
    index: Number(row.getAttribute('data-row-index')),
    cells: [...row.querySelectorAll('td[data-column-index]')].map(cell => ({
      column: Number(cell.getAttribute('data-column-index')), text: cell.textContent
    }))
  })))
  assert.equal(rendered.length, item.size, 'DOM must contain exactly the current page')
  for (const [position, row] of rendered.entries()) {
    const id = item.offset + position + 1
    assert.equal(row.index, id - 1)
    assert.deepEqual(row.cells.map(cell => cell.column), [0, 1, 2, 3])
    assert.deepEqual(row.cells.map(cell => cell.text), expectedText(id), 'DOM must preserve every ID and exact numeric/Chinese value')
  }
  assert.equal(await page.getByLabel('每页行数', { exact: true }).inputValue(), String(item.size))
  assert.equal(await page.getByRole('button', { name: '上一页', exact: true }).isDisabled(), item.offset === 0)
  assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(), !item.checks.hasMore)
}
async function focusBoundary(page, index) {
  const cell = page.locator(`tbody tr[data-row-index="${index}"] td[data-column-index="0"]`)
  await cell.focus()
  await settle(page)
  const observed = await cell.evaluate(element => {
    const scroller = element.closest('.grid-scroll')
    const view = scroller.getBoundingClientRect()
    const box = element.getBoundingClientRect()
    const headerBottom = Math.max(...[...scroller.querySelectorAll('thead th')].map(header => header.getBoundingClientRect().bottom))
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return { focused: document.activeElement === element,
      selected: element.classList.contains('is-cell-selected'),
      visible: box.width > 0 && box.height > 0 && box.top >= headerBottom - 1 &&
        box.bottom <= view.top + scroller.clientTop + scroller.clientHeight + 1 &&
        box.left >= view.left + scroller.clientLeft - 1 &&
        box.right <= view.left + scroller.clientLeft + scroller.clientWidth + 1,
      hitTestable: hit === element || element.contains(hit) }
  })
  assert.deepEqual(observed, { focused: true, selected: true, visible: true, hitTestable: true }, 'Boundary row focus must be visible, selected and unobscured')
}

try {
  const cases = []
  for (const dialect of ['postgresql', 'mysql']) {
    const { value: report } = await readPublicJson(`${dialect}.native.json`, 256 * 1024)
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.dialect, dialect)
    assert.equal(report.sourceSha, sourceSha)
    assert.equal(report.environment.workers, 1)
    assert.equal(report.environment.image, dialect === 'postgresql' ? 'postgres:17' : 'mysql:8.0')
    assert.match(report.environment.engineVersion, dialect === 'postgresql' ? /^17\./ : /^8\.0\./)
    assert.equal(report.timingBoundary.endToEnd, false)
    assert.equal(report.cases.length, 12)
    assert.deepEqual(report.totals.map(total => [total.rows, total.independentTotal]), [[100000, 100000], [1000000, 1000000]])
    const expectedIds = []
    for (const rows of [100000, 1000000]) for (const size of [200, 1000]) for (const label of ['first', 'next', 'deep']) {
      expectedIds.push(`${dialect}-${rows}-${size}-${label}`)
    }
    assert.deepEqual(report.cases.map(item => item.caseId).sort(), expectedIds.sort(), 'All required native cases must exist exactly once')
    for (const item of report.cases) {
      activeCase = item.caseId
      const label = item.caseId.split('-').at(-1)
      assert.ok([100000, 1000000].includes(item.rows) && [200, 1000].includes(item.size))
      assert.equal(item.caseId, `${dialect}-${item.rows}-${item.size}-${label}`)
      assert.equal(item.offset, label === 'first' ? 0 : label === 'next' ? item.size : item.rows - item.size)
      assert.equal(item.method, label === 'first' ? 'runQuery' : 'fetchResultPage')
      assert.equal(item.repeats, repeats)
      assert.equal(item.samples.length, repeats)
      assert.deepEqual(item.checks, { returned: item.size, firstId: item.offset + 1, lastId: item.offset + item.size,
        allIdsContinuous: true, exactValues: true, hasMore: item.offset + item.size < item.rows, independentTotal: item.rows })
      for (const [index, sample] of item.samples.entries()) {
        assert.equal(sample.repeat, index + 1)
        duration(sample.wallMs)
        if (item.method === 'runQuery' || sample.elapsedMs !== null) duration(sample.elapsedMs)
      }
      assert.equal(item.pageSample, `${item.caseId}.page.json`)
      const sample = await readPublicJson(item.pageSample, 2 * 1024 * 1024)
      validateSample(sample.value, report, item)
      cases.push({ report, item, sampleSha256: sample.sha256 })
    }
    nativeReports.push(report)
  }
  activeCase = null
  stage = 'start-github-chrome'
  const [{ createServer }, { default: vue }, { chromium }] = await Promise.all([
    import('vite'), import('@vitejs/plugin-vue'), import('playwright-core')
  ])
  server = await createServer({
    configFile: false, root, logLevel: 'silent',
    cacheDir: path.join(process.env.RUNNER_TEMP, 'dbstudio-page-performance-vite'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    resolve: { alias: [{ find: '@tauri-apps/api/core', replacement: '/@page-performance-no-ipc' }] },
    plugins: [vue(), { name: 'page-performance-reject-ipc', enforce: 'pre',
      resolveId(id) { if (id === '/@page-performance-no-ipc') return '\0page-performance-no-ipc' },
      load(id) {
        if (id === '\0page-performance-no-ipc') return `export function invoke() {
          window.pagePerformanceIpcAttempts = (window.pagePerformanceIpcAttempts || 0) + 1;
          throw new Error('Native IPC is forbidden in page rendering measurements');
        }`
      }
    }]
  })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  browserVersion = browser.version()
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'block' })
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin && route.request().method() === 'GET') return route.continue()
    unexpectedNetwork++
    return route.abort('blockedbyclient')
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  page.on('pageerror', () => runtimeErrors.push('browser-runtime-error'))
  await page.goto(`${origin}/apps/desktop/tests/grid-performance-fixture/`)
  await page.waitForFunction(() => typeof window.pagePerformance?.load === 'function')
  for (const { report, item, sampleSha256 } of cases) {
    activeCase = item.caseId
    stage = 'load-native-page'
    // Read/transfer one page at a time. No browser-side generator or whole-table data.
    const { value: sample, sha256 } = await readPublicJson(item.pageSample, 2 * 1024 * 1024)
    assert.equal(sha256, sampleSha256)
    const renderMs = []
    const screenshots = [`${item.caseId}-first.png`, `${item.caseId}-last.png`]
    for (let repeat = 0; repeat < repeats; repeat++) {
      stage = `render-${repeat + 1}`
      const measured = await page.evaluate(async input => {
        let timer
        try {
          return await Promise.race([
            window.pagePerformance.load(input),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('UI ready deadline exceeded')), 30000) })
          ])
        } finally { clearTimeout(timer) }
      }, sample)
      duration(measured.renderMs)
      renderMs.push(measured.renderMs)
      stage = `dom-verification-${repeat + 1}`
      await verifyDom(page, item)
      for (const [position, index] of [item.offset, item.offset + item.size - 1].entries()) {
        await focusBoundary(page, index)
        if (repeat === repeats - 1) await page.screenshot({ path: path.join(output, screenshots[position]) })
      }
      assert.equal(await page.evaluate(() => window.pagePerformanceIpcAttempts ?? 0), 0, 'Rendering must not call native IPC')
      assert.equal(unexpectedNetwork, 0)
      assert.deepEqual(runtimeErrors, [])
    }
    const elapsed = item.samples.map(sample => sample.elapsedMs).filter(value => value !== null)
    results.push({ caseId: item.caseId, dialect: report.dialect, sourceSha, rows: item.rows, offset: item.offset,
      size: item.size, repeats, method: item.method, environment: report.environment,
      native: { samples: item.samples, wallMs: summary(item.samples.map(sample => sample.wallMs)),
        elapsedMs: elapsed.length ? summary(elapsed) : null },
      render: { samples: renderMs.map((value, index) => ({ repeat: index + 1, renderMs: value })), renderMs: summary(renderMs) },
      checks: { ...item.checks, domEveryRowExact: true, firstAndLastFocusVisible: true, nativeIpcCalls: 0 },
      pageSample: item.pageSample, pageSampleSha256: sampleSha256, screenshots })
  }
  assert.equal(results.length, 24)
  stage = 'complete'
} catch {
  failed = true
  // Do not upload stderr, server logs, environment dumps or arbitrary exception text.
} finally {
  try { await browser?.close() } catch { failed = true; stage = 'chrome-close' }
  try { await server?.close() } catch { failed = true; stage = 'vite-close' }
  const metrics = {
    schemaVersion: 1, status: failed ? 'failed' : 'passed', sourceSha,
    failure: failed ? { stage, caseId: activeCase } : null,
    environment: { os: process.platform, arch: process.arch, cpuModel: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version, chrome: browserVersion,
      viewport, deviceScaleFactor: 1, workers: 1, frontend: 'Vite development server; production ResultGrid/useWorkbench source' },
    boundaries: {
      native: 'actual native Driver::call; wallMs includes database I/O and native conversion, excludes setup and IPC',
      elapsedMs: 'native response field; null for fetchResultPage when unavailable; not server-only query time',
      renderMs: 'already-arrived page -> fresh production component mount -> nextTick + two requestAnimationFrame callbacks (UI ready); excludes transfer, module loading, teardown, DOM checks and screenshots',
      samples: 'one unchanged real native page per case, mounted five times; maximum 1000 rows resident in the current grid',
      endToEnd: false, combinedNativeAndRender: false, latencyBudget: null,
      acceptance: 'collect reproducible latency baselines plus correctness gates; no latency SLO supplied',
      percentiles: 'nearest-rank p95 of five samples equals maximum; all samples retained',
      scope: 'GitHub Chrome renderer, not packaged Tauri WebView or click-to-query end-to-end latency'
    },
    nativeReports: nativeReports.map(report => `${report.dialect}.native.json`),
    expectedCases: 24, completedCases: results.length, results
  }
  await writeFile(path.join(output, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify({ status: metrics.status, stage, completedCases: results.length, artifact: 'out/page-performance/metrics.json' }))
  if (failed) process.exitCode = 1
}
