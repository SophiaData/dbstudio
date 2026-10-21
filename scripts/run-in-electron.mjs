/**
 * 在「Electron 环境」里跑脚本的包装器。
 *
 * ===== 为什么需要它 =====
 *
 * 有两类验证必须跑在 Electron 里，用系统 node 跑不出来：
 *
 *   1. `test:electron` —— 验证驱动宿主在 **Electron 内置 Node** 下的真实形态
 *      （Node 版本、node:sqlite 可用性、process.execPath + ELECTRON_RUN_AS_NODE 拉起）。
 *
 *   2. `test:gui` —— 验证界面真的渲染出来了、preload 白名单真的注入成功。
 *      这条只能用真实 Electron 主进程跑，然后从渲染进程取 DOM。
 *
 * ===== 踩过的坑（写在这里防止后人再踩） =====
 *
 * `ELECTRON_RUN_AS_NODE=1` 是**进程级**环境变量。如果调用者的 shell 里残留了它，
 * Electron 会以纯 Node 身份启动，`require('electron').app` 是 undefined，
 * 直接崩在 `app.whenReady()`，报错还指向构建产物、看起来像是打包问题。
 * 所以这里**强制删除**它，而不是靠调用者小心。
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/**
 * 找出当前平台的 Electron 可执行文件。
 *
 * ===== 这里曾经写错过，记录一下 =====
 *
 * 初版"为了避免硬编码"写了一组候选路径，但**只列了 macOS 的形状**：
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
 * 在 Linux CI 上直接 ENOENT（Linux 是 dist/electron，Windows 是 dist/electron.exe）。
 * 注释说是避免硬编码，实际还是按 macOS 硬编码了——注释和实现不符，很难查。
 *
 * 正确做法：**问 electron 包自己要**。它的入口 index.js 导出的就是一个字符串，
 * 内容是该平台可执行文件的绝对路径，内部已按 platform 分支处理好。
 * 这样跨平台不用我们维护任何路径知识。
 */
function electronBinary() {
  const require = createRequire(import.meta.url)
  try {
    // electron 的入口模块只做一件事：导出可执行文件路径。
    const p = require('electron')
    if (typeof p === 'string' && existsSync(p)) return p
  } catch {
    /* 落到下面的兜底 */
  }
  // 兜底：按平台猜（正常情况下走不到这里，除非 electron 包结构变了）
  const candidates =
    process.platform === 'darwin'
      ? [resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')]
      : process.platform === 'win32'
        ? [resolve(root, 'node_modules/electron/dist/electron.exe')]
        : [resolve(root, 'node_modules/electron/dist/electron')]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(
    `找不到 Electron 可执行文件（平台 ${process.platform}）。` +
      `请确认 pnpm install 时 electron 的 postinstall 已成功下载二进制。`
  )
}

const args = process.argv.slice(2)
const guiMode = args[0] === '--gui'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // 见文件头「踩过的坑」

let childArgs
let childEnv = env
if (guiMode) {
  // GUI 自检：由主进程里 DBSTUDIO_SMOKE=1 触发的自检钩子完成断言。
  childArgs = ['.']
  childEnv = { ...env, DBSTUDIO_SMOKE: '1' }
  // Linux CI 上 chrome-sandbox 的 SUID 权限不满足要求，Electron 会 FATAL 退出。
  // 用环境变量开关无沙箱模式，只在 CI 自检时启用（见 workflow 注释）。
  if (env.ELECTRON_DISABLE_SANDBOX === '1' && process.platform === 'linux') {
    childArgs.push('--no-sandbox')
  }
} else {
  // Node 模式：让 Electron 以 Node 身份跑给定脚本。
  childArgs = [args[0]]
  childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
}

if (!guiMode && !args[0]) {
  console.error('用法: node scripts/run-in-electron.mjs <script.mjs> | --gui')
  process.exit(2)
}

const child = spawn(electronBinary(), childArgs, {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe']
})

let out = ''
child.stdout.on('data', (d) => {
  const s = String(d)
  out += s
  process.stdout.write(s)
})
child.stderr.on('data', (d) => {
  const s = String(d)
  out += s
  process.stderr.write(s)
})

const TIMEOUT_MS = 60_000
const timer = setTimeout(() => {
  console.error(`\n[run-in-electron] 超时 ${TIMEOUT_MS}ms，强制结束`)
  child.kill('SIGKILL')
  process.exit(1)
}, TIMEOUT_MS)

child.on('exit', (code) => {
  clearTimeout(timer)
  // GUI 模式下额外要求出现明确的自检通过标记，
  // 否则「进程正常退出」可能只是窗口被关掉，并不代表断言真的跑过。
  if (guiMode && !out.includes('SMOKE_PASS')) {
    console.error('\n[run-in-electron] GUI 自检未产出 SMOKE_PASS 标记')
    process.exit(1)
  }
  process.exit(code ?? 1)
})
