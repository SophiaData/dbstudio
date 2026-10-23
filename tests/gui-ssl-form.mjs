/**
 * SSL 表单的 GUI 交互验证。
 *
 * ===== 为什么这条必须用真实 GUI 测，纯 Node 测不出来 =====
 *
 * `sslmode` 是渲染层新支持的一种控件（`kind: 'select'`）。它有三个关键行为
 * 只存在于真实 DOM 里：
 *
 *   1. 必须渲染成 `<select>` 而不是 `<input>`。若退化回文本框，
 *      `collect()` 依然能读到值、类型检查也照样过——**纯 Node 测试全绿**，
 *      但用户看到的是一个空框，完全不知道该填什么。
 *   2. 默认值必须真的被选中。`<select>` 不显式赋值时会默认第一项，
 *      而 sslmode 的第一项恰好是 `disable`——于是「没填」会静默变成「明文连接」。
 *      这是安全相关的静默降级，必须有测试钉住。
 *   3. 提交时值要原样进 `options`，不能被 `Number()` 之类的分支误转成数字。
 *
 * 本测试**不需要真实的 PostgreSQL 服务端**：只验表单渲染与提交值。
 * 建连会失败（连不上 127.0.0.1 的假端口），但我们要断言的是失败**之前**
 * 表单收集到了什么——这正是这一层的职责边界。
 *
 * 运行：node tests/gui-ssl-form.mjs
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

const dir = mkdtempSync(join(tmpdir(), 'dbstudio-sslform-'))
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

console.log('\n[1] 新建连接对话框：选择 PostgreSQL')
await win.click('#btn-new-connection')
await win.waitForSelector('#f-dialect', { state: 'attached', timeout: 10000 })
await win.selectOption('#f-dialect', 'postgresql')
// 等动态表单按新方言重建
await win.waitForSelector('#f-dynamic select[data-key="sslmode"]', { state: 'attached', timeout: 10000 })

check(
  '1a. ★ sslmode 渲染成 <select>（不是文本框）',
  await win.locator('#f-dynamic select[data-key="sslmode"]').count() === 1
)
check(
  '1b. sslmode 没有被渲染成 input',
  await win.locator('#f-dynamic input[data-key="sslmode"]').count() === 0
)

console.log('\n[2] 候选项与默认值')
const optionValues = await win.$$eval('#f-dynamic select[data-key="sslmode"] option', (opts) =>
  opts.map((o) => o.value)
)
check(
  '2a. 六个 libpq 模式都在选项里',
  ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].every((m) =>
    optionValues.includes(m)
  ),
  optionValues.join(',')
)

const defaultValue = await win.$eval('#f-dynamic select[data-key="sslmode"]', (el) => el.value)
/**
 * 这条是整个文件里最重要的一条：默认值若落到 `disable`，
 * 用户「什么都没选」就会连出明文连接——安全上的静默降级。
 */
check('2b. ★ 默认选中 prefer（不是首项 disable）', defaultValue === 'prefer', `实际=${defaultValue}`)

console.log('\n[3] 选择后提交：值必须原样进入 options')
await win.selectOption('#f-dynamic select[data-key="sslmode"]', 'verify-full')
await win.fill('#f-name', 'SSL-FORM')
await win.fill('#f-dynamic input[data-key="host"]', '127.0.0.1')
await win.fill('#f-dynamic input[data-key="port"]', '1')
await win.fill('#f-dynamic input[data-key="database"]', 'postgres')
await win.fill('#f-dynamic input[data-key="user"]', 'postgres')

/**
 * 端口 1 必然连不上，但 `addConnection` 会先落盘。新语义要求保留对话框并
 * 明说“配置已保存、会话未连接”，不能像旧版那样关框后仍显示“已连接”。
 */
await win.click('#btn-submit')
await win.waitForFunction(
  () => {
    const e = document.getElementById('f-error')
    return e !== null && !e.hasAttribute('hidden')
  },
  { timeout: 20000 }
)
check(
  '3a. ★ 连接失败时对话框保留且明确提示配置已保存',
  (await win.locator('#dlg-connection[open]').count()) === 1 &&
    (await win.locator('#f-error').textContent())?.includes('配置已保存') === true,
  await win.locator('#f-error').textContent()
)

// 用页面内的 API 直接验证：collect() 的结果会随 addConnection 一起落盘，
// 端口 1 必然连不上，但**配置已保存**（add 的语义是先落盘再连）。
const saved = await win.evaluate(async () => {
  const api = window.dbstudio
  const list = await api.listConnections()
  const conn = list.find((c) => c.name === 'SSL-FORM')
  if (!conn) return null
  return conn
})
check('3b. 配置已保存（add 先落盘再连）', saved !== null && saved !== undefined, JSON.stringify(saved))

if (saved) {
  /**
   * 最关键的一条：确认 `sslmode` 真的以**字符串** `verify-full` 落进了配置，
   * 而不是被丢掉、或被转成数字/布尔。
   *
   * 读取路径用 UI 自己也会用的那个：连接节点上的 `options.*` 元数据
   * （`tree.ts` 编辑对话框就是靠它回填的）。
   */
  // 注意：连接节点的 meta 里**没有** connectionId 字段（只有 id 本身是
  // `connection:<id>` 形状），所以按名字找最直接——这也是 UI 展示用的字段。
  const optionsMeta = await win.evaluate(async (name) => {
    const roots = await window.dbstudio.listChildren(null)
    const node = roots.find((r) => r.kind === 'connection' && r.name === name)
    return node?.meta ?? null
  }, 'SSL-FORM')
  const sslmode = optionsMeta?.['options.sslmode']
  check(
    '3c. ★ sslmode 以字符串 verify-full 落进配置',
    sslmode === 'verify-full',
    `实际=${String(sslmode)}（meta=${JSON.stringify(optionsMeta)}）`
  )
}

console.log(`\n===== SSL 表单 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
await app.close()
process.exit(fail === 0 ? 0 : 1)
