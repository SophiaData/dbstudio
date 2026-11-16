/**
 * vitest 配置。
 *
 * 单测与源码同目录（`src/**\/*.spec.ts`），不设独立测试目录：断言与实现紧邻，
 * 改实现时能直接看到对应测试，避免出现源码已变而测试仍在验证旧行为的漂移。
 *
 * 环境用 happy-dom 而非 jsdom：前端产物里有 localStorage、DOM 事件等真实
 * 依赖，纯 node 环境跑不了；happy-dom 启动更快，适合大量小用例。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(import.meta.dirname, 'src/core'),
      '@drivers': resolve(import.meta.dirname, 'src/drivers')
    }
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.spec.ts', 'apps/desktop/src/**/*.spec.ts'],
    // 单测不碰真实数据库与网络；出现这些调用说明用例写错了边界。
    clearMocks: true,
    restoreMocks: true
  }
})
