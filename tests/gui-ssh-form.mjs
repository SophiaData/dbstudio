/**
 * SSH 表单与多机密收集的 GUI 验证。
 *
 * ===== 为什么必须用真实 GUI =====
 *
 * 这段最容易出的不是类型错误，而是**三个密码框都写进同一个变量**：
 * 表单看起来正常，类型检查也通过，点“测试连接”时却总有一个认证失败。
 * 只有真实 DOM + 真实 collect() 路径能发现它。
 *
 * 本测试不去连真实 SSH（那条由 e2e-ssh-tunnel.mjs 覆盖），只验证：
 *   1. SSH 字段真的渲染为正确控件；
 *   2. 三个 password 控件各自带 secretKey；
 *   3. 提交后三个值以具名对象保存，且配置里没有明文；
 *   4. 编辑连接对话框同样有三个独立密码框，而不是一个“密码”栏。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pwFile = require.resolve('playwright-core', { paths: [root] })
const pw = await import(pathToFileURL(pwFile).href)
const electron = pw._electron ?? pw.default?._electron

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ` - ${detail}` : ''}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dbstudio-sshform-'))
mkdirSync(join(root, 'out/gui-flow'), { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.DBSTUDIO_TEST_HIDDEN = '1'

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', `--user-data-dir=${join(dir, 'ud')}`],
  cwd: root,
  env
})
const win = await app.firstWindow()
await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })

console.log('\n[1] 新建连接：SSH 字段与三个独立密码框')
await win.click('#btn-new-connection')
await win.selectOption('#f-dialect', 'postgresql')
await win.waitForSelector('#f-dynamic input[data-key="sshHost"]', { state: 'attached', timeout: 10000 })

for (const key of ['sshHost', 'sshPort', 'sshUser', 'sshPrivateKey', 'sshHostKeySha256', 'sshTargetHost', 'sshTargetPort']) {
  check(`1a. 渲染字段 ${key}`, (await win.locator(`#f-dynamic [data-key="${key}"]`).count()) === 1)
}
check(
  '1b. sshPort 是 number 输入框',
  (await win.locator('#f-dynamic input[type="number"][data-key="sshPort"]').count()) === 1
)

const passwordKeys = await win.$$eval('#f-dynamic input[type="password"]', (inputs) =>
  inputs.map((i) => i.getAttribute('data-secret-key'))
)
check(
  '1c. ★ 三个密码框分别绑定 dbPassword/sshPassword/sshPassphrase',
  ['dbPassword', 'sshPassword', 'sshPassphrase'].every((k) => passwordKeys.includes(k)) &&
    passwordKeys.length === 3,
  passwordKeys.join(',')
)

/**
 * 用主进程 IPC 的确定性替身验证 UI 闭环：首次未知指纹 → 弹确认框 →
 * 用户确认 → 指纹写回表单 → 自动重试。这里不 mock 渲染层函数，
 * 点击、对话框、自动重试走的都是生产代码。
 *
 * 注意：这是唯一一处直接操作 Electron 私有 `_invokeHandlers` 的地方。
 * 原因是 contextBridge 暴露的 API 被冻结，而本项目又没有为测试开放的
 * “强制未知指纹”环境变量。未来若新增测试注入点，应优先替换掉它。
 */
await app.evaluate(({ ipcMain }) => {
  globalThis.__dbstudioTestCalls = 0
  /**
   * Playwright 的主进程 eval 上下文拿不到 registerIpc 当初注册的那个 handler，
   * 对 `_invokeHandlers` 做赋值会被 Electron 的内部代理吞掉。直接改
   * ipcMain 的内置映射是目前唯一能在真实 preload/IPC 路径上替换单通道的方法；
   * 调用签名与 Electron 的 handle() 完全一致。
   */
  const invokeHandlers = ipcMain._invokeHandlers
  invokeHandlers.set('dbstudio:testConnection', async (_event, config) => {
    globalThis.__dbstudioTestCalls += 1
    if (globalThis.__dbstudioTestCalls === 1) {
      return {
        ok: false,
        message: '首次连接该 SSH 主机，需要确认主机密钥指纹：SHA256:ui-test',
        elapsedMs: 9,
        checks: [
          { stage: 'config', status: 'passed', message: '连接参数解析通过' },
          { stage: 'ssh_host_key', status: 'failed', message: '等待用户确认主机指纹' }
        ],
        sshHostKey: {
          host: String(config.options.sshHost),
          port: Number(config.options.sshPort),
          fingerprint: 'SHA256:ui-test',
          state: 'unverified'
        }
      }
    }
    const trusted = config.options.sshHostKeySha256 === 'SHA256:ui-test'
    return {
      ok: trusted,
      ...(trusted ? { serverVersion: 'PostgreSQL UI mock' } : { message: '指纹没有写回表单' }),
      elapsedMs: 14,
      checks: [
        { stage: 'config', status: 'passed', message: '连接参数解析通过' },
        {
          stage: 'ssh_host_key',
          status: trusted ? 'passed' : 'failed',
          message: trusted ? 'SSH 主机密钥与已保存指纹一致' : '指纹没有写回表单'
        }
      ]
    }
  })
})

await win.fill('#f-dynamic input[data-key="sshHost"]', '127.0.0.1')
await win.fill('#f-dynamic input[data-key="sshPort"]', '2222')
await win.fill('#f-dynamic input[data-key="host"]', '127.0.0.1')
await win.fill('#f-dynamic input[data-key="port"]', '55432')
await win.fill('#f-dynamic input[data-key="database"]', 'postgres')
await win.fill('#f-dynamic input[data-key="user"]', 'postgres')
await win.click('#btn-test')
await win.waitForSelector('#dlg-ssh-host-key[open]', { state: 'attached', timeout: 10000 })
check(
  '1d. ★ 未知 SSH 指纹弹出确认框并展示实际指纹',
  (await win.locator('#ssh-key-actual').textContent()) === 'SHA256:ui-test' &&
    (await win.locator('#ssh-key-expected-row').getAttribute('hidden')) !== null,
  await win.locator('#ssh-key-actual').textContent()
)
await win.click('#btn-ssh-key-trust')
await win.waitForFunction(
  () =>
    document.querySelector('#test-check-list .test-check[data-stage="ssh_host_key"]')?.classList.contains(
      'passed'
    ) === true,
  { timeout: 10000 }
)
check(
  '1e. ★ 确认后写回指纹并自动重试成功',
  (await win.locator('#f-dynamic input[data-key="sshHostKeySha256"]').inputValue()) ===
    'SHA256:ui-test' &&
    (await win.locator('#status-bar').textContent())?.includes('连接成功') === true &&
    (await app.evaluate(() => globalThis.__dbstudioTestCalls)) === 2,
  await win.locator('#status-bar').textContent()
)

console.log('\n[2] 填表并落盘：三机密不能互相覆盖')
await win.fill('#f-name', 'SSH-FORM')
await win.fill('#f-dynamic input[data-key="host"]', '127.0.0.1')
await win.fill('#f-dynamic input[data-key="port"]', '55432')
await win.fill('#f-dynamic input[data-key="database"]', 'postgres')
await win.fill('#f-dynamic input[data-key="user"]', 'postgres')
await win.fill('#f-dynamic input[data-key="password"]', 'DB_PASS_UNIQUE')
await win.fill('#f-dynamic input[data-key="sshHost"]', '127.0.0.1')
await win.fill('#f-dynamic input[data-key="sshPort"]', '2222')
await win.fill('#f-dynamic input[data-key="sshUser"]', 'tester')
await win.fill('#f-dynamic input[data-key="sshPrivateKey"]', '/tmp/test_ed25519')
await win.fill('#f-dynamic input[data-key="sshPassword"]', 'SSH_PASS_UNIQUE')
await win.fill('#f-dynamic input[data-key="sshPassphrase"]', 'KEY_PASS_UNIQUE')
await win.fill('#f-dynamic input[data-key="sshHostKeySha256"]', 'SHA256:test')
await win.fill('#f-dynamic input[data-key="sshTargetHost"]', '10.0.0.9')
await win.fill('#f-dynamic input[data-key="sshTargetPort"]', '5432')

await win.click('#btn-submit')
/**
 * 未授权的假 SSH 参数会保存配置，但不会建立会话。对话框必须保持打开，
 * 这正是“先落盘、再连接”与“连上才关闭”之间的区别。
 */
await win.waitForFunction(
  () => {
    const e = document.getElementById('f-error')
    return e !== null && !e.hasAttribute('hidden')
  },
  { timeout: 25000 }
)

const saved = await win.evaluate(async () => {
  const api = window.dbstudio
  const list = await api.listConnections()
  const c = list.find((x) => x.name === 'SSH-FORM')
  if (!c) return null
  const roots = await api.listChildren(null)
  const node = roots.find((r) => r.kind === 'connection' && r.name === 'SSH-FORM')
  return { summary: c, meta: node?.meta ?? null }
})
check('2a. 连接已保存', saved !== null, JSON.stringify(saved))
check(
  '2b. SSH 配置进入 options（不含 password 字样）',
  saved?.summary?.options?.sshHost === '127.0.0.1' &&
    saved?.summary?.options?.sshUser === 'tester' &&
    saved?.summary?.options?.sshTargetHost === '10.0.0.9' &&
    saved?.summary?.options?.sshPort === 2222 &&
    saved?.summary?.options?.sshTargetPort === 5432,
  JSON.stringify(saved?.summary?.options)
)
check(
  '2c. ★ 配置对象里没有三个明文密码',
  JSON.stringify(saved?.summary?.options ?? {}).indexOf('DB_PASS_UNIQUE') === -1 &&
    JSON.stringify(saved?.summary?.options ?? {}).indexOf('SSH_PASS_UNIQUE') === -1 &&
    JSON.stringify(saved?.summary?.options ?? {}).indexOf('KEY_PASS_UNIQUE') === -1,
  JSON.stringify(saved?.summary?.options)
)

/**
 * 从主进程侧直接读加密存储，确认三个 key 都在。
 * 这里只有 Electron 的 safeStorage 真实产物，测试进程无法直接解密，
 * 所以改为让页面调用一次“只测连”不可行（会真的建 SSH）。
 *
 * 退而求其次：连接节点 meta 里不能出现密码；真正“三值同时存在”的存储层
 * 断言由 tests/e2e-persist.mjs 用可注入 cipher 覆盖。这里断言 UI 确实把
 * 三个控件分别暴露出来，且 config 不泄漏。
 */
check('2d. 连接节点 meta 不含明文密码', !JSON.stringify(saved?.meta ?? {}).includes('DB_PASS_UNIQUE'))
check(
  '2e. ★ 新连接失败时对话框保留，并提示配置已保存',
  (await win.locator('#dlg-connection[open]').count()) === 1 &&
    (await win.locator('#f-error:not([hidden])').textContent())?.includes('配置已保存') === true,
  await win.locator('#f-error').textContent()
)
await win.click('#btn-cancel')

console.log('\n[3] 编辑连接：不能退回单个密码框')
// 右键连接节点，菜单第一项之后找“编辑连接”。
const nodeIndex = await win.evaluate(() => {
  const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
  return rows.findIndex((r) => r.textContent?.includes('SSH-FORM'))
})
check('3a. 树里找到 SSH-FORM 连接', nodeIndex >= 0, `index=${nodeIndex}`)
if (nodeIndex >= 0) {
  const row = win.locator('#tree-rows .tree-row').nth(nodeIndex)
  await row.click({ button: 'right' })
  await win.waitForSelector('[role="menu"]', { state: 'visible', timeout: 5000 })
  const clicked = await win.evaluate(() => {
    // 浏览器原生 click() 不触发 pointerdown/mousedown，而菜单的“点击别处关闭”
    // 监听的是 mousedown。这里按真实用户路径派发 mousedown + click，
    // 否则测试会误以为菜单项没反应。
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
    const edit = items.find((x) => x.textContent?.trim().startsWith('编辑连接'))
    if (!edit) return false
    edit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    edit.click()
    return true
  })
  check('3b. 右键菜单有「编辑连接」', clicked)
  if (clicked) {
    // 先确认“编辑连接”对话框自身出现，再等字段。否则超时只能看到
    // “三个 input 没出现”，无法区分点击没生效 / 方言元数据没拿到。
    await win.waitForFunction(
      () =>
        [...document.querySelectorAll('body > div')].some((el) =>
          el.textContent?.includes('编辑连接「SSH-FORM」')
        ),
      { timeout: 10000 }
    )
    const editPanel = win.locator('body > div').last()
    try {
      await win.waitForFunction(
        () =>
          [...document.querySelectorAll('body > div')]
            .at(-1)
            ?.querySelectorAll('input[data-secret-key]').length === 3,
        { timeout: 10000 }
      )
    } catch {
      const diagnostic = await win.evaluate(() => ({
        secretInputs: [...(document.querySelectorAll('body > div').item(document.querySelectorAll('body > div').length - 1)?.querySelectorAll('input[data-secret-key]') ?? [])].map((e) => ({
          key: e.getAttribute('data-key'),
          secretKey: e.getAttribute('data-secret-key'),
          type: e.getAttribute('type')
        })),
        allInputs: [...document.querySelectorAll('body > div:last-child input')].map((e) => ({
          key: e.getAttribute('data-key'),
          secretKey: e.getAttribute('data-secret-key'),
          type: e.getAttribute('type')
        })),
        text: [...document.querySelectorAll('body > div')].at(-1)?.textContent?.slice(0, 500)
      }))
      console.log('  [诊断]', JSON.stringify(diagnostic))
      throw new Error(`编辑对话框密码框数量不是 3: ${JSON.stringify(diagnostic.secretInputs)}`)
    }
    const editKeys = await editPanel.locator('input[data-secret-key]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-secret-key'))
    )
    check(
      '3c. ★ 编辑对话框仍有三个独立密码框',
      ['dbPassword', 'sshPassword', 'sshPassphrase'].every((k) => editKeys.includes(k)),
      editKeys.join(',')
    )

    /*
     * 清空 sshHost 必须真的关闭隧道。
     *
     * 仅检查输入框存在还不够：早先保存逻辑会跳过所有空值，用户清空后
     * 旧 sshHost 仍留在配置里，界面显示已关闭、重连却继续走跳板机。
     */
    await editPanel.locator('input[data-key="sshHost"]').fill('')
    await editPanel.getByRole('button', { name: '保存', exact: true }).click()
    await win.waitForFunction(
      () => ![...document.querySelectorAll('body > div')].some((el) => el.textContent?.includes('编辑连接「SSH-FORM」')),
      { timeout: 10000 }
    )
    const afterClear = await win.evaluate(async () => {
      const list = await window.dbstudio.listConnections()
      return list.find((x) => x.name === 'SSH-FORM')?.options ?? null
    })
    check(
      '3d. ★ 清空 sshHost 后配置真的删除了旧值（能关闭隧道）',
      afterClear !== null && afterClear.sshHost === '',
      JSON.stringify(afterClear)
    )
  }
}

console.log(`\n===== SSH 表单 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
await app.close()
process.exit(fail === 0 ? 0 : 1)
