/**
 * 单独构建「驱动宿主进程」。
 *
 * ===== 为什么需要这个独立构建目标 =====
 *
 * 驱动宿主必须是一个**独立可执行的 CJS 脚本**：
 *   - 它会被 `child_process.spawn` 单独拉起，一个连接一个进程；
 *   - 它**不 import electron**，因此既能跑在 Electron 的内置 Node 下
 *     （`ELECTRON_RUN_AS_NODE=1` + `process.execPath`），
 *     也能被自动化测试用系统 node 直接跑——可测性全靠这一点；
 *   - 它必须能 `require('node:sqlite')`，这要求它是 CJS 且该内置模块
 *     不被 bundle 进去（内置模块无法被内联）。
 *
 * ===== 为什么用 vite 的 build API，而不是直接 import esbuild =====
 *
 * 最初打算直接用 esbuild（它是 vite 的依赖，已经是现成的），
 * 但 pnpm 的严格 node_modules 不允许 import 未声明的传递依赖
 * （实测 `Cannot find package 'esbuild'`）。
 * 与其为此额外声明一个只为构建脚本服务的依赖，
 * 不如用 vite 自己的 `build`——vite 本来就是本项目的直接依赖，零新增。
 */

import { build } from 'vite'
import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export async function buildDriverHost(outDir = resolve(root, 'out/driver-host')) {
  await build({
    // 库模式：单入口、单文件输出，不需要任何 web 相关处理。
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: true,
      target: 'node22',
      minify: false, // 保留可读性，宿主进程出问题时可以直接看产物排查
      sourcemap: true,
      ssr: true,
      lib: {
        entry: resolve(root, 'src/driver-host/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.js'
      },
      rollupOptions: {
        // 内置模块与 electron 一律外置，交给宿主 Node 在运行时提供。
        // node:sqlite 必须外置——内置模块无法被 bundle，内联会直接失败。
        external: [/^node:/, 'electron']
      }
    }
  })

  const outFile = resolve(outDir, 'index.js')
  if (!existsSync(outFile)) {
    console.error(`[build-driver-host] 构建失败：未产出 ${outFile}`)
    process.exit(1)
  }
  const kb = (statSync(outFile).size / 1024).toFixed(1)
  console.log(`[build-driver-host] ✅ ${outFile} (${kb} KB)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDriverHost()
}
