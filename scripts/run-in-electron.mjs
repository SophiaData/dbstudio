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
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function electronBinary() {
  // 从已安装的 electron 包读取平台二进制路径，避免硬编码。
  // electron 包导出的就是一个字符串路径。
  const req = [
    resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    resolve(root, 'node_modules/electron/dist/electron')
  ]
  return req[0]
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
