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
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dbstudio-sshform-'))
mkdirSync(join(root, 'out/gui-flow'), { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

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

console.log('\n[2] 填表并落盘：三机密不能互相覆盖')
await win.fill('#f-name', 'SSH-FORM')
await win.fill('#f-dynamic input[data-key="host"]', '127.0.0.1')
await win.fill('#f-dynamic input[data-key="port"]', '1')
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
await win.waitForFunction(
  () => {
    const d = document.getElementById('dlg-connection')
    return d !== null && !d.hasAttribute('open')
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
