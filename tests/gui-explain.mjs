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
const pgOnly = process.argv.includes('--pg-only')
const sqliteOnly = process.argv.includes('--sqlite-only')
const work = mkdtempSync(join(tmpdir(), 'dbstudio-explain-gui-'))
const file = join(work, 'explain.db')
const db = new DatabaseSync(file)
db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1)')
db.close()
const env = { ...process.env, DBSTUDIO_TEST_HIDDEN: '1' }
delete env.ELECTRON_RUN_AS_NODE
let app

async function addConnection(page, config, secret) {
  const summary = await page.evaluate(
    ({ config, secret }) => window.dbstudio.addConnection(config, secret),
    { config, secret }
  )
  assert.equal(summary.connected, true, 'BLOCKED_BY_SETUP: explain GUI connection failed')
  await page.click('#btn-refresh')
  const row = page.locator('#tree-rows .tree-row').filter({ hasText: config.name })
  await row.waitFor()
  await row.click()
  return summary
}

async function requestPlan(page, sql, expectedStatus) {
  await page.fill('.sql-editor-input', sql)
  await page.getByRole('button', { name: '执行计划', exact: true }).click()
  await page.waitForFunction(
    (expected) => document.querySelector('#status-bar')?.textContent?.includes(expected),
    expectedStatus
  )
  assert.equal(await page.locator('.sql-editor-explain').getAttribute('aria-busy'), 'false')
}

/**
 * 断开后重连，带有限次重试。
 *
 * ===== 为什么要重试 =====
 *
 * 原来这里只调一次 `connectConnection` 就断言 `connected === true`。这个写法在
 * 本地一直是绿的，但在 GitHub runner 上**稳定**失败（同一行、连跑两次都一样）：
 *
 *   AssertionError: BLOCKED_BY_SETUP: explain GUI reconnect failed
 *   false !== true
 *
 * 断开是异步收尾的（回滚 + 等驱动宿主子进程退出 + 等导出/导入任务），
 * 重连撞上这段收尾窗口时，`ConnectionManager.connectConnection` 会走
 * "收尾期间会话已被替换" 的静默分支，直接返回 `connected: false`，
 * **不抛错也不打日志**。机器越慢、进程回收越慢，这个窗口越宽——
 * 所以本地快机器几乎撞不上，CI 上必撞。
 *
 * 断言"一次就必须连上"其实是不合理的：连接建立本身就是异步的，
 * 真实用户点重连也会等。所以这里改成轮询式重试，最多等 `timeoutMs`。
 *
 * 重试**不降低验证强度**：最终仍然要求 connected === true，且后续还要
 * 重新请求执行计划并断言计划内容正确。它只是把"立刻成功"放宽成
 * "在合理时间内成功"。
 *
 * 全部尝试都失败时，把每次的结果拼进错误信息——否则 CI 里只剩一句
 * "reconnect failed"，看不出是没连上、被拒、还是根本没建会话。
 */
async function reconnectUntilConnected(page, id, timeoutMs = 20000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  const attempts = []
  for (;;) {
    const summary = await page.evaluate((cid) => window.dbstudio.connectConnection(cid), id)
    attempts.push({
      connected: summary?.connected === true,
      atMs: timeoutMs - Math.max(0, deadline - Date.now())
    })
    if (summary?.connected === true) return { ...summary, attempts }
    if (Date.now() >= deadline) {
      return { ...(summary ?? {}), connected: false, attempts }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs))
  }
}

async function checkConnection(page, config, secret, sql, expectedPlan) {
  const summary = await addConnection(page, config, secret)
  const pageErrors = []
  const onPageError = (error) => pageErrors.push(error.message)
  page.on('pageerror', onPageError)
  try {
    await requestPlan(page, sql, '执行计划已更新')
    const plan = await page.locator('.sql-editor-explain-row').allTextContents()
    assert.ok(plan.length > 0)
    assert.match(plan.join('\n'), expectedPlan)
    assert.equal(await page.locator('.sql-editor-explain-title').textContent(), '执行计划')
    console.log(`PASS ${config.dialectId}: GUI displays driver plan`)

    await requestPlan(page, 'SELECT * FROM dbstudio_missing_explain_table', '执行计划失败')
    assert.equal(await page.locator('.sql-editor-explain').isVisible(), false,
      'A failed explain must hide the previous plan')
    await requestPlan(page, "SELECT 'unterminated", '未闭合')
    assert.equal(await page.locator('.sql-editor-explain').isVisible(), false)
    console.log(`PASS ${config.dialectId}: errors hide stale plan`)

    await page.evaluate((id) => window.dbstudio.disconnectConnection(id), summary.id)
    await requestPlan(page, sql, '断开')
    const reconnected = await reconnectUntilConnected(page, summary.id)
    assert.equal(
      reconnected.connected,
      true,
      `BLOCKED_BY_SETUP: explain GUI reconnect failed（${reconnected.attempts.length} 次尝试）: ` +
        JSON.stringify(reconnected.attempts)
    )
    await requestPlan(page, sql, '执行计划已更新')
    assert.match((await page.locator('.sql-editor-explain-row').allTextContents()).join('\n'), expectedPlan)
    assert.deepEqual(pageErrors, [])
    console.log(`PASS ${config.dialectId}: disconnect error settles and reconnect recovers`)
  } finally {
    page.off('pageerror', onPageError)
  }
}

try {
  if (pgOnly && !process.env.DBSTUDIO_PG_URL) {
    console.log('SKIP PostgreSQL explain GUI: 未配置 DBSTUDIO_PG_URL')
  } else {
    /*
     * Linux（尤其 CI）需要两个开关：
     *
     * 1. `--no-sandbox`
     *    chrome-sandbox 需要 root:4755 才能启用 SUID 沙箱，GitHub runner 上不满足。
     *    不关的话 Electron 直接 FATAL 退出。
     *
     * 2. `--password-store=basic`
     *    ===== 这条是本用例在 CI 上失败的真正原因 =====
     *    测试流程是「连接 → 断开 → 重连」。断开时会把内存里的密码从
     *    `#sessionSecrets` 删掉，重连只能从持久化存储里取（ConnectionStore）。
     *    而 ConnectionStore 用 Electron safeStorage 加密，Linux 无桌面 keyring
     *    时 safeStorage 不可用 → `getSecret()` 返回 undefined → 重连时没有密码。
     *
     *    CI 的 postgres 服务设了 POSTGRES_PASSWORD，走 scram 认证，**必须**有密码，
     *    于是重连必然认证失败，`connectConnection` 返回 connected:false。
     *    表现就是本用例稳定失败 31 次尝试全 false——不是竞态，是密码没了。
     *
     *    `basic` 让 Chromium 用一个内置密钥的基础后端，不依赖系统 keyring，
     *    密码因此能存住、重连能成功。和 `--no-sandbox` 一样属于测试环境的
     *    合理妥协：加载的是自己构建的本地页面，不涉及真实敏感数据。
     */
    const extraArgs = process.platform === 'linux'
      ? ['--password-store=basic', ...(env.ELECTRON_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : [])]
      : []
    app = await electron.launch({
      executablePath: require('electron'),
      args: [...extraArgs, '.', `--user-data-dir=${join(work, 'userdata')}`],
      cwd: root,
      env
    })
    /*
     * 转发 Electron 主进程的 stdout/stderr。
     *
     * ===== 为什么必须有 =====
     * Playwright 的 `electron.launch()` 默认把子进程输出**内部消化**，不转发到
     * 父进程。于是主进程里 `[manager] 连接 ... 失败`、`[store] 无法读取凭据`
     * 这类关键日志在 CI 日志里完全看不到——上一轮排查「重连失败」时，
     * 明明走了静默分支却查不出原因，就是因为这个。
     *
     * 转发之后，任何连接/凭据问题都会直接出现在 CI 输出里，不用再靠猜。
     */
    const electronProc = app.process()
    electronProc.stdout?.on('data', (chunk) => process.stdout.write(`[electron] ${chunk}`))
    electronProc.stderr?.on('data', (chunk) => process.stderr.write(`[electron] ${chunk}`))

    const page = await app.firstWindow()
    await page.waitForSelector('#tree-rows', { state: 'attached' })
    if (!pgOnly) {
      await checkConnection(page,
        { dialectId: 'sqlite', name: 'SQLite explain GUI', options: { file } },
        undefined, 'SELECT * FROM items WHERE id = 1', /SEARCH|SCAN/i)
    }
    if (!sqliteOnly && process.env.DBSTUDIO_PG_URL) {
      const url = new URL(process.env.DBSTUDIO_PG_URL)
      await checkConnection(page, {
        dialectId: 'postgresql',
        name: 'PostgreSQL explain GUI',
        options: {
          host: url.hostname, port: url.port || '5432',
          database: decodeURIComponent(url.pathname.slice(1) || 'postgres'),
          user: decodeURIComponent(url.username || 'postgres')
        }
      }, url.password ? decodeURIComponent(url.password) : undefined,
      'SELECT 1', /"Node Type"\s*:\s*"Result"/)
    } else if (!sqliteOnly) {
      console.log('SKIP PostgreSQL explain GUI: 未配置 DBSTUDIO_PG_URL')
    }
  }
} finally {
  if (app) await app.close()
  rmSync(work, { recursive: true, force: true })
}
