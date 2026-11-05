/**
 * 远程连接表单 GUI 回归（8 场景：前七组 HTTP layer mock，末组真实 HTTP listener）。
 *
 * 运行已构建的 Electron renderer：node tests/gui-remote-connection.mjs
 * 前七组 https://remote.test 请求由 Playwright route 拦截并返回 mock 响应。
 * 末组用真实 preload、HTTP listener 和 fixture 认证，不拦截网络。
 * Electron 是否发送 Origin/预检按实测断言；显式预检另由 test:http-cors 覆盖。
 * application composition 为 fixture；不启动数据库、不验证服务端 owner 或进程隔离。
 * 实际 UI 调用旧签名 (config, secret)/(id, config, secretPatch)，不直接调用
 * createRemoteConnection 等新入口，也不替换 fetch 或 backend facade。
 * 第二次独立启动仅用环境变量，经真实 preload 注入配置；不使用 initScript。
 * 凭据仅在测试内随机生成；不读取本机凭据，不输出请求体/认证头。
 * 测试用户目录保留在系统临时目录，遵守本任务禁止删除文件的约束。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const endpoint = 'https://remote.test/rpc'
const connectionId = 'remote-gui-connection'
const connectionPath = `/connections/${connectionId}`
const password = randomUUID()
const replacementPassword = randomUUID()
const authPrefix = randomUUID()
const privateValues = [password, replacementPassword, authPrefix]
const config = {
  dialectId: 'postgresql',
  name: 'Remote GUI PostgreSQL',
  options: { host: 'db.remote.test', port: 5544, database: 'gui_db', user: 'gui_user' }
}
const updatedConfig = {
  name: 'Remote GUI PostgreSQL edited',
  options: { ...config.options, host: 'edited.remote.test', port: 5545 }
}
const dialects = [
  { id: 'sqlite', name: 'SQLite', fields: [] },
  {
    id: 'postgresql', name: 'PostgreSQL',
    fields: [
      { key: 'host', label: '主机', kind: 'text', required: true },
      { key: 'port', label: '端口', kind: 'number', required: true, default: 5432 },
      { key: 'database', label: '数据库', kind: 'text', required: true },
      { key: 'user', label: '用户', kind: 'text', required: true },
      { key: 'password', label: '密码', kind: 'password', required: false, secretKey: 'dbPassword' }
    ]
  }
]
const requests = []
const unexpected = []
const diagnostics = { pageErrors: [], console: [], failedRequests: [] }
const listenerRequests = []
let realServer
let saved = null
let denyNextCreate = false
let app
let win

function redact(value) {
  let text = String(value)
  for (const secret of privateValues) text = text.replaceAll(secret, '[REDACTED]')
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
}
function observeWindow(page) {
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(10000)
  page.on('pageerror', (error) => {
    if (diagnostics.pageErrors.length < 12) diagnostics.pageErrors.push(redact(error.message))
  })
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type()) && diagnostics.console.length < 12) {
      diagnostics.console.push({ type: message.type(), text: redact(message.text()) })
    }
  })
  page.on('requestfailed', (request) => {
    if (diagnostics.failedRequests.length < 12) diagnostics.failedRequests.push({
      method: request.method(), path: new URL(request.url()).pathname,
      error: redact(request.failure()?.errorText ?? 'Unknown request failure')
    })
  })
}
async function reportFailure() {
  const page = win && !win.isClosed()
    ? await win.evaluate(() => ({
      status: document.getElementById('status-bar')?.textContent ?? null,
      formError: document.getElementById('f-error')?.textContent ?? null,
      backendMode: window.__DBSTUDIO_BACKEND_CONFIG__?.mode ?? null,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null
    })).catch(() => ({ status: 'Renderer diagnostics unavailable' }))
    : { status: 'Renderer window unavailable' }
  const requestCounts = {}
  for (const request of requests) {
    const key = `${request.method} ${request.path}`
    requestCounts[key] = (requestCounts[key] ?? 0) + 1
  }
  // 仅输出状态/路径计数和脱敏浏览器错误；不输出 request body、headers 或配置对象。
  console.error(redact(JSON.stringify({ page, requestCount: requests.length, requestCounts, listenerRequests, ...diagnostics }, null, 2)))
}

function summary() {
  if (!saved) return null
  return {
    id: connectionId, name: saved.name, dialectId: saved.dialectId,
    connected: saved.connected, persisted: true, secretStored: true
  }
}
function roots() {
  if (!saved) return []
  return [{
    id: `connection:${connectionId}`, parentId: null, kind: 'connection',
    name: saved.name, hasChildren: false,
    meta: {
      dialect: saved.dialectId, connected: saved.connected, persisted: true,
      secretStored: true,
      ...Object.fromEntries(Object.entries(saved.options).map(([key, value]) => [`options.${key}`, value]))
    }
  }]
}
function calls(method, path) {
  return requests.filter((request) => request.method === method && request.path === path)
}
function singleCall(method, path, count = 1) {
  const matches = calls(method, path)
  assert.equal(matches.length, count, `${method} ${path} request count`)
  return matches.at(-1)
}
function checkBody(request, expectedConfig, secretKey, expectedPassword) {
  const body = request.body
  // 只比较布尔结果，避免 assertion diff 打印测试凭据（包括错误落入 options 的情况）。
  assert.ok(JSON.stringify(body?.config) === JSON.stringify(expectedConfig), 'request carries the collected config')
  assert.ok(JSON.stringify(Object.keys(body ?? {}).sort()) === JSON.stringify(['config', secretKey].sort()), 'request envelope keys')
  assert.ok(Object.keys(body?.[secretKey] ?? {}).length === 1 && body[secretKey].dbPassword === expectedPassword, `${secretKey} carries only the supplied dbPassword`)
  assert.ok(!JSON.stringify(body.config).includes(expectedPassword), 'credentials stay outside config/options')
}
function assertNoConnectionRpc() {
  const forbidden = new Set([
    'listConnections', 'addConnection', 'testConnection', 'updateConnection',
    'connectConnection', 'disconnectConnection', 'removeConnection'
  ])
  assert.ok(!calls('POST', '/rpc').some((request) => forbidden.has(request.body?.method)), 'legacy connection methods use routes, never RPC')
  assert.deepEqual(unexpected, [], 'no unexpected HTTP/RPC calls')
}

async function mockRemote(route) {
  const request = route.request()
  const path = new URL(request.url()).pathname
  const method = request.method()
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, accept, x-dbstudio-request-id',
    'access-control-allow-private-network': 'true'
  }
  if (method === 'OPTIONS') {
    await route.fulfill({ status: 204, headers })
    return
  }
  const body = request.postDataJSON()
  requests.push({ method, path, body, auth: request.headers().authorization, id: request.headers()['x-dbstudio-request-id'] })
  let status = 200
  let payload
  if (method === 'POST' && path === '/rpc') {
    let value
    if (body.method === 'listDialects') value = dialects
    else if (body.method === 'listChildren') value = body.args[0] === null ? roots() : []
    else if (body.method === 'transactionState') value = { active: false, pendingAffected: 0 }
    else {
      unexpected.push(`RPC ${body.method}`)
      status = 400
    }
    payload = status === 200
      ? { id: body.id, ok: true, value }
      : { id: body.id, ok: false, error: { code: 'unsupported', message: 'Unexpected mock RPC' } }
  } else if (method === 'GET' && path === '/connections') {
    payload = { ok: true, value: saved ? [summary()] : [] }
  } else if (method === 'POST' && path === '/connections/test') {
    payload = { ok: true, value: { ok: true, elapsedMs: 3, serverVersion: 'mock PostgreSQL' } }
  } else if (method === 'POST' && path === '/connections') {
    if (denyNextCreate) {
      denyNextCreate = false
      status = 401
      payload = { ok: false, error: { code: 'unauthorized', message: '远程会话已失效，请重新登录', retryable: false } }
    } else {
      saved = { ...body.config, connected: true }
      payload = { ok: true, value: summary() }
    }
  } else if (method === 'PATCH' && path === connectionPath && saved) {
    saved = { ...saved, ...body.config, options: { ...saved.options, ...body.config.options } }
    payload = { ok: true, value: summary() }
  } else if (method === 'POST' && path === `${connectionPath}/disconnect` && saved) {
    saved.connected = false
    payload = { ok: true, value: summary() }
  } else if (method === 'POST' && path === `${connectionPath}/connect` && saved) {
    saved.connected = true
    payload = { ok: true, value: summary() }
  } else if (method === 'DELETE' && path === connectionPath && saved) {
    saved = null
    payload = { ok: true, value: null }
  } else {
    unexpected.push(`${method} ${path}`)
    status = 404
    payload = { ok: false, error: { code: 'not-found', message: 'Unexpected mock route' } }
  }
  await route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(payload) })
}

try {
  const work = mkdtempSync(join(tmpdir(), 'dbstudio-remote-gui-'))
  const env = { ...process.env, DBSTUDIO_TEST_HIDDEN: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  // Electron runs the existing build; this script never rebuilds or edits production files.
  console.log('START Electron with an isolated temporary user directory (HTTP layer mock)')
  app = await electron.launch({
    executablePath: require('electron'), cwd: root, env, timeout: 15000,
    args: ['.', `--user-data-dir=${join(work, 'userdata')}`,
      ...(process.platform === 'linux' && env.ELECTRON_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : [])]
  })
  console.log('START Electron launched; waiting for the renderer window')
  win = await app.firstWindow({ timeout: 15000 })
  observeWindow(win)
  console.log('START Renderer window acquired; install HTTP routing and runtime config')
  await win.route('https://remote.test/**', mockRemote)
  await win.addInitScript(({ endpoint, authPrefix }) => {
    let authCalls = 0
    window.__remoteGuiReconnectCalls = 0
    window.__DBSTUDIO_BACKEND_CONFIG__ = {
      mode: 'http',
      http: {
        endpoint, timeoutMs: 5000,
        getHeaders: async () => {
          await Promise.resolve()
          authCalls += 1
          return { authorization: `Bearer ${authPrefix}.${authCalls}` }
        }
      },
      reconnect: async () => { window.__remoteGuiReconnectCalls += 1 }
    }
  }, { endpoint, authPrefix })
  console.log('START Reload built renderer with the mocked HTTP backend')
  await win.reload({ waitUntil: 'networkidle' })
  console.log('START Renderer reload complete; waiting for the empty connection tree')
  await win.waitForSelector('#tree-rows', { state: 'attached' })
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('还没有连接'))
  assert.ok(requests.length > 0, 'renderer boot sends real HTTP requests to the route mock')
  assert.ok(requests[0].auth === `Bearer ${authPrefix}.1`, 'first request awaits async getHeaders')

  async function fillCreateForm() {
    await win.click('#btn-new-connection')
    await win.waitForSelector('#dlg-connection[open]')
    await win.selectOption('#f-dialect', 'postgresql')
    await win.locator('#f-dynamic input[data-key="host"]').waitFor()
    await win.fill('#f-name', config.name)
    for (const [key, value] of Object.entries(config.options)) {
      await win.locator(`#f-dynamic input[data-key="${key}"]`).fill(String(value))
    }
    await win.locator('#f-dynamic input[data-secret-key="dbPassword"]').fill(password)
  }
  const connectionRow = (name) => win.locator('.tree-row').filter({ has: win.getByText(name, { exact: true }) })
  async function selectConnection(name, connected) {
    await connectionRow(name).locator('.row-label').click()
    await win.waitForFunction((connected) => {
      const text = document.querySelector('#detail-content .detail-sub')?.textContent ?? ''
      return text.includes(connected ? '已连接' : '未连接')
    }, connected)
  }
  async function openEdit(name) {
    await connectionRow(name).click({ button: 'right' })
    await win.getByRole('menuitem', { name: '编辑连接…', exact: true }).click()
    await win.getByRole('textbox', { name: '连接名', exact: true }).waitFor()
    await win.locator('input[data-key="host"]').filter({ visible: true }).waitFor()
  }

  await fillCreateForm()
  await win.click('#btn-test')
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('连接成功'))
  checkBody(singleCall('POST', '/connections/test'), config, 'secret', password)
  assert.equal(calls('POST', '/connections').length, 0, 'test does not create a saved connection')
  assert.equal(saved, null, 'test leaves mock connection state empty')
  assertNoConnectionRpc()
  console.log('PASS real form test: POST /connections/test carries {config, secret}; no create/RPC')

  await win.click('#btn-submit')
  await win.waitForSelector('#dlg-connection[open]', { state: 'detached' })
  await connectionRow(config.name).waitFor()
  checkBody(singleCall('POST', '/connections'), config, 'secret', password)
  await selectConnection(config.name, true)
  assertNoConnectionRpc()
  console.log('PASS real form create: POST /connections carries {config, secret}; tree shows connected')

  await openEdit(config.name)
  assert.equal(await win.locator('input[data-key="host"]').filter({ visible: true }).inputValue(), config.options.host, 'edit prefills the saved host')
  assert.equal(await win.locator('input[data-secret-key="dbPassword"]').filter({ visible: true }).inputValue(), '', 'edit never prefills a credential')
  await win.getByRole('textbox', { name: '连接名', exact: true }).fill(updatedConfig.name)
  await win.locator('input[data-key="host"]').filter({ visible: true }).fill(updatedConfig.options.host)
  await win.locator('input[data-key="port"]').filter({ visible: true }).fill(String(updatedConfig.options.port))
  await win.locator('input[data-secret-key="dbPassword"]').filter({ visible: true }).fill(replacementPassword)
  await win.getByRole('button', { name: '保存', exact: true }).click()
  await win.getByRole('textbox', { name: '连接名', exact: true }).waitFor({ state: 'detached' })
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('共 1 个连接'))
  await connectionRow(updatedConfig.name).waitFor()
  checkBody(singleCall('PATCH', connectionPath), updatedConfig, 'secretPatch', replacementPassword)
  assertNoConnectionRpc()
  console.log('PASS tree edit: PATCH connection carries {config, secretPatch}; saved values and rename reach UI')

  // 留空按旧签名提交 undefined；JSON envelope 中应省略 secretPatch。
  await openEdit(updatedConfig.name)
  await win.getByRole('button', { name: '保存', exact: true }).click()
  await win.getByRole('textbox', { name: '连接名', exact: true }).waitFor({ state: 'detached' })
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('共 1 个连接'))
  await connectionRow(updatedConfig.name).waitFor()
  const preserved = singleCall('PATCH', connectionPath, 2).body
  assert.ok(!Object.hasOwn(preserved, 'secretPatch'), 'blank edit omits secretPatch to preserve credentials')
  assert.ok(JSON.stringify(preserved.config) === JSON.stringify({ options: updatedConfig.options }), 'blank edit still sends collected options')
  console.log('PASS blank edit: omitted secretPatch preserves existing credentials')

  await selectConnection(updatedConfig.name, true)
  await win.locator('.conn-actions').getByRole('button', { name: '断开', exact: true }).click()
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('共 1 个连接'))
  singleCall('POST', `${connectionPath}/disconnect`)
  await selectConnection(updatedConfig.name, false)
  assert.ok(saved?.connected === false, 'disconnect preserves mock configuration')
  await win.locator('.conn-actions').getByRole('button', { name: '连接', exact: true }).click()
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('共 1 个连接'))
  singleCall('POST', `${connectionPath}/connect`)
  await selectConnection(updatedConfig.name, true)
  win.on('dialog', (dialog) => { void dialog.accept() })
  await win.locator('.conn-actions').getByRole('button', { name: '删除连接', exact: true }).click()
  await connectionRow(updatedConfig.name).waitFor({ state: 'detached' })
  singleCall('DELETE', connectionPath)
  assert.equal(saved, null, 'delete removes only the mock connection')
  for (const request of requests.filter((entry) => entry.path.startsWith(connectionPath) && entry.method !== 'PATCH')) {
    assert.equal(request.body, null, 'lifecycle routes do not carry config or credentials')
  }
  assertNoConnectionRpc()
  console.log('PASS UI lifecycle: disconnect keeps config, connect restores state, delete removes mock row')

  await fillCreateForm()
  denyNextCreate = true
  await win.click('#btn-submit')
  await win.waitForSelector('#f-error:not([hidden])')
  assert.match(await win.locator('#f-error').textContent(), /远程会话已失效，请重新登录/)
  assert.equal(await win.locator('#status-bar.is-error').count(), 1, '401 produces readable error state')
  checkBody(singleCall('POST', '/connections', 2), config, 'secret', password)
  assert.equal(saved, null, 'unauthorized create does not change mock state')
  await win.click('#btn-cancel')
  await win.click('#btn-refresh')
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('还没有连接'))
  singleCall('POST', '/connections', 2)
  assert.equal(await win.evaluate(() => window.__remoteGuiReconnectCalls), 0, 'mutation 401 never invokes reconnect/replay')
  assert.equal(await connectionRow(config.name).count(), 0)
  assertNoConnectionRpc()
  assert.ok(requests.every((request) => request.auth?.startsWith(`Bearer ${authPrefix}.`)), 'all RPC/routes receive provider authentication')
  assert.equal(new Set(requests.map((request) => request.auth)).size, requests.length, 'getHeaders runs afresh before every request')
  assert.ok(requests.every((request) => typeof request.id === 'string' && request.id.length > 0), 'all requests carry a request id')
  console.log('PASS async dynamic authentication: first/every request has fresh headers; readable 401 never replays mutation')

  await app.close()
  app = null
  win = null
  requests.length = 0
  saved = null
  denyNextCreate = false
  for (const entries of Object.values(diagnostics)) entries.length = 0
  const fixtureAccessToken = randomUUID()
  privateValues.push(fixtureAccessToken)
  console.log('START Separate Electron launch with environment configuration through the real preload')
  app = await electron.launch({
    executablePath: require('electron'), cwd: root, timeout: 15000,
    env: {
      ...env,
      DBSTUDIO_BACKEND_ENDPOINT: endpoint,
      DBSTUDIO_BACKEND_ACCESS_TOKEN: fixtureAccessToken
    },
    args: ['.', `--user-data-dir=${join(work, 'preload-userdata')}`,
      ...(process.platform === 'linux' && env.ELECTRON_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : [])]
  })
  win = await app.firstWindow({ timeout: 15000 })
  observeWindow(win)
  await win.route('https://remote.test/**', mockRemote)
  // 新 app 没有 addInitScript；reload 仍完全依赖真实 preload 读取启动环境。
  await win.reload({ waitUntil: 'networkidle' })
  await win.waitForSelector('#tree-rows', { state: 'attached' })
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('还没有连接'))
  const preloadConfig = await win.evaluate((fixtureAccessToken) => {
    const config = window.__DBSTUDIO_BACKEND_CONFIG__
    return {
      mode: config?.mode,
      hasProvider: typeof config?.http?.getHeaders === 'function',
      endpoint: config?.http?.endpoint,
      tokenAbsent: !JSON.stringify(config)?.includes(fixtureAccessToken)
    }
  }, fixtureAccessToken)
  assert.equal(preloadConfig.mode, 'http', 'real preload selects HTTP from environment')
  assert.equal(preloadConfig.endpoint, endpoint, 'real preload exposes the configured endpoint')
  assert.equal(preloadConfig.hasProvider, true, 'real preload exposes a callable header provider')
  assert.equal(preloadConfig.tokenAbsent, true, 'serializable preload config never contains the fixture token')
  assert.ok(requests.length > 0, 'real preload configuration drives HTTP renderer startup')
  assert.ok(requests.every((request) => request.auth === `Bearer ${fixtureAccessToken}`), 'every preload-backed request uses the fixture authentication')
  assertNoConnectionRpc()
  console.log('PASS real preload environment startup: HTTP mode, authenticated requests, no token in serializable config')

  await app.close()
  app = null
  win = null
  requests.length = 0
  for (const entries of Object.values(diagnostics)) entries.length = 0
  const listenerAccessToken = randomUUID()
  privateValues.push(listenerAccessToken)
  const { build } = await import('vite')
  const serverBundleDir = join(work, 'http-listener-bundle')
  await build({
    configFile: false, root, logLevel: 'warn',
    build: {
      outDir: serverBundleDir, emptyOutDir: false, target: 'node22', ssr: true,
      lib: {
        entry: { server: resolve(root, 'src/main/server/http-server.ts') },
        formats: ['es'], fileName: (_format, name) => `${name}.mjs`
      },
      rollupOptions: { external: [/^node:/] }
    }
  })
  const { createHttpServer } = await import(pathToFileURL(join(serverBundleDir, 'server.mjs')).href)
  const rpcMethods = []
  realServer = createHttpServer({
    allowedOrigins: ['null'], listen: { host: '127.0.0.1', port: 0 },
    resolvePrincipal: (request) => request.headers.authorization === `Bearer ${listenerAccessToken}`
      ? { id: 'gui-listener-fixture' } : null,
    composition: {
      dispatch: async (request, context) => {
        assert.equal(context.principal.id, 'gui-listener-fixture', 'real listener authenticates before dispatch')
        rpcMethods.push(request.method)
        if (request.method === 'listDialects') return { id: request.id, ok: true, value: dialects }
        if (request.method === 'listChildren') return { id: request.id, ok: true, value: [] }
        return { id: request.id, ok: false, error: { code: 'unsupported', message: 'Unexpected listener fixture RPC' } }
      },
      scopeFor: (principal) => {
        assert.equal(principal.id, 'gui-listener-fixture', 'connection route receives the authenticated principal')
        return { manager: { list: () => [] } }
      },
      dispose: async () => undefined
    }
  })
  realServer.server.prependListener('request', (request, response) => {
    // 记录 origin 与认证匹配布尔值，不保留或输出 Authorization 原值。
    const observed = {
      method: request.method, path: new URL(request.url, 'http://127.0.0.1').pathname,
      origin: request.headers.origin ?? null,
      authMatches: request.headers.authorization === `Bearer ${listenerAccessToken}`
    }
    listenerRequests.push(observed)
    response.once('finish', () => {
      observed.status = response.statusCode
      observed.allowedOrigin = response.getHeader('access-control-allow-origin') ?? null
    })
  })
  const address = await realServer.listen()
  const listenerEndpoint = `http://127.0.0.1:${address.port}/rpc`
  console.log('START Real listener ready; third Electron app uses preload and actual HTTP without network mocking')
  app = await electron.launch({
    executablePath: require('electron'), cwd: root, timeout: 15000,
    env: {
      ...env,
      DBSTUDIO_BACKEND_ENDPOINT: listenerEndpoint,
      DBSTUDIO_BACKEND_ACCESS_TOKEN: listenerAccessToken
    },
    args: ['.', `--user-data-dir=${join(work, 'listener-userdata')}`,
      ...(process.platform === 'linux' && env.ELECTRON_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : [])]
  })
  win = await app.firstWindow({ timeout: 15000 })
  observeWindow(win)
  // 该 app 不装 page.route，也不装 initScript；listener 在启动前已就绪。
  await win.waitForSelector('#tree-rows', { state: 'attached' })
  await win.waitForFunction(() => document.getElementById('status-bar')?.textContent?.includes('还没有连接'))
  assert.equal(await win.evaluate(() => window.__DBSTUDIO_BACKEND_CONFIG__?.mode), 'http', 'real listener app uses preload HTTP mode')
  await win.click('#btn-new-connection')
  await win.waitForSelector('#dlg-connection[open]')
  await win.selectOption('#f-dialect', 'postgresql')
  await win.locator('#f-dynamic input[data-key="host"]').waitFor()
  await win.click('#btn-cancel')
  const actualRequests = listenerRequests.filter((request) => request.method !== 'OPTIONS')
  assert.ok(actualRequests.length > 0, 'browser makes real HTTP application requests')
  assert.ok(actualRequests.every((request) => request.authMatches && request.status === 200), 'all actual requests authenticate with the fixture and succeed')
  assert.ok(actualRequests.every((request) => request.origin === null || request.origin === 'null'), 'Electron file requests have absent or literal null Origin')
  assert.ok(actualRequests.every((request) => request.origin !== 'null' || request.allowedOrigin === 'null'), 'requests with literal null Origin receive matching CORS permission')
  assert.ok(actualRequests.every((request) => (request.method === 'POST' && request.path === '/rpc') || (request.method === 'GET' && request.path === '/connections')), 'startup uses real RPC or connection-list routes')
  const preflights = listenerRequests.filter((request) => request.method === 'OPTIONS')
  if (preflights.length > 0) {
    assert.ok(preflights.every((request) => request.origin === 'null' && request.status === 204 && request.allowedOrigin === 'null'), 'emitted browser preflights are accepted by the real CORS handler')
    console.log('PASS emitted browser preflight: real listener returned 204 with explicit origin permission')
  } else {
    console.log('Electron emitted no Origin/preflight; explicit preflight covered by test:http-cors')
  }
  assert.ok(rpcMethods.includes('listChildren') && rpcMethods.includes('listDialects'), 'real listener serves renderer boot and the actual dialect form')
  assert.ok(rpcMethods.every((method) => ['listChildren', 'listDialects'].includes(method)), 'listener fixture receives only expected renderer RPC calls')
  console.log('PASS real network: preload → actual HTTP listener → fixture authentication (no network mock)')
  console.log('Remote connection GUI: 8 scenarios passed (7 HTTP mocks + 1 real HTTP listener; fixture composition, no server isolation coverage)')
} catch (error) {
  console.error(redact(error instanceof Error ? (error.stack ?? error.message) : error))
  await reportFailure()
  process.exitCode = 1
} finally {
  try {
    if (app) await app.close()
  } finally {
    if (realServer) await realServer.close()
  }
}
