import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

/**
 * 三个构建目标，与 DBeaver 的 bundle 分层一一对应：
 *   main       -> registry + 连接管理（OSGi registry 的对应物）
 *   preload    -> 受控的 IPC 契约（Eclipse extension point 的收敛替代品）
 *   renderer   -> ui.navigator（元数据树）
 *
 * 额外第四个目标 driver-host 由 scripts/build-driver-host.mjs 单独构建，
 * 因为它必须以「独立进程」形态运行，不能被打进主进程 bundle。
 *
 * ⚠️ 教训记录（踩过一次坑）：
 * 最初在这里手写了 `external: ['electron']`，结果**覆盖掉 electron-vite 的默认外部化配置**，
 * 构建出的 out/main/index.js 变成 `require("electron")` 的普通 CJS，
 * 真实启动时 `electron.app` 是 undefined，直接崩在 `app.whenReady()`。
 * electron-vite 对 main/preload 已有正确的默认处理（含 electron 与全部 node 内置模块），
 * **不需要也不应该手写 external**。此文件因此刻意只声明入口。
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
