/** 薄入口保留 Node signal/退出码语义；构建产物不会在启动时自动重建。 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'out/http-server/index.mjs')
if (!existsSync(entry)) {
  console.error('[http-server] 请先执行 node scripts/build-http-server.mjs')
  process.exitCode = 1
} else {
  // 直接以 Node 执行已构建入口，保证 import.meta 与 driver-host 相对路径稳定。
  const child = spawn(process.execPath, [fileURLToPath(pathToFileURL(entry))], { stdio: 'inherit', env: process.env })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal) })
  child.once('error', () => { console.error('[http-server] 无法启动 Node listener'); process.exitCode = 1 })
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
}
