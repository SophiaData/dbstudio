/**
 * 后台 GUI 测试模式的最小回归。
 *
 * 这层不能只靠“其它 GUI 测试都通过”来证明：Playwright 在可见窗口上也照样
 * 能填表点击。因此这里直接向主进程读取 BrowserWindow / Dock 状态，并要求：
 *   - 显式测试变量才隐藏（两轮对照，防止生产启动被误隐藏）
 *   - 隐藏时窗口仍能加载、接受点击、截图
 *   - macOS 上 Dock 确实不可见
 *   - Linux 上不启用隐藏（Xvfb 已避免打扰真实桌面，隐藏会卡住截图）
 */

import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pw = await import(
  pathToFileURL(require.resolve('playwright-core', { paths: [root] })).href
)
const electron = pw._electron ?? pw.default?._electron

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function launch(hidden) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (hidden) env.DBSTUDIO_TEST_HIDDEN = '1'
  else delete env.DBSTUDIO_TEST_HIDDEN

  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'gui-hidden-'))}`],
    cwd: root,
    env
  })
  const win = await app.firstWindow()
  await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })
  const state = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return {
      windowCount: BrowserWindow.getAllWindows().length,
      visible: window?.isVisible() ?? null,
      focusable: window?.isFocusable() ?? null,
      dockVisible: process.platform === 'darwin' ? (app.dock?.isVisible() ?? null) : null
    }
  })
  return { app, win, state }
}

console.log('\n[1] 默认启动仍显示窗口')
{
  const { app, state } = await launch(false)
  check('1a. 创建一个窗口', state.windowCount === 1, JSON.stringify(state))
  check('1b. ★ 未设置测试变量时窗口可见', state.visible === true, JSON.stringify(state))
  if (process.platform === 'darwin') {
    check('1c. 默认启动保留 Dock 图标', state.dockVisible === true, JSON.stringify(state))
  }
  await app.close()
}

console.log('\n[2] 隐藏模式不打扰桌面，但功能仍可用')
{
  const { app, win, state } = await launch(true)
  check('2a. 仍只有一个真实窗口', state.windowCount === 1, JSON.stringify(state))
  if (process.platform === 'darwin') {
    check('2b. ★ macOS BrowserWindow 不可见', state.visible === false, JSON.stringify(state))
    check('2c. ★ macOS Dock 图标已隐藏', state.dockVisible === false, JSON.stringify(state))
  } else {
    check(
      '2b. ★ 非 macOS 保持可见（Xvfb 已提供隔离桌面）',
      state.visible === true,
      JSON.stringify(state)
    )
  }

  const title = await win.title()
  check('2d. 页面仍正常加载', title === 'dbstudio', title)
  await win.click('#btn-new-connection')
  check(
    '2e. ★ 隐藏窗口仍接受真实点击',
    (await win.locator('#dlg-connection[open]').count()) === 1
  )

  const screenshot = await win.screenshot()
  check('2f. 隐藏窗口仍可截图', screenshot.length > 1000, String(screenshot.length))
  await app.close()
}

console.log(`\n===== 后台 GUI 模式测试：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
