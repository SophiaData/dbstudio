/**
 * SDK 构建脚本。
 *
 * ===== 核心策略：复用而不是复制 =====
 *
 * SDK 的类型与驱动实现都来自主仓库（`../src/core`、`../src/driver-host`）。
 * 绝不在 sdk/ 下复制源码——复制必然分叉（主仓库改了、SDK 还是旧的，
 * 而两边都能编译通过，问题只在用户那里以类型不匹配爆发）。
 *
 * ===== 两步产出，各有各的坑 =====
 *
 *   1. **类型声明**：用 `tsconfig.build.json`（它把 core 的 .ts 也列进 files），
 *      让 tsc **把 core 的 d.ts 一并产出**。为什么必须这样：SDK 的类型
 *      re-export 了主仓库的 core，若只产出 SDK 自己的 d.ts，里面的
 *      `../../../src/core/*` 在发布包里不存在，用户拿到的是断链类型。
 *      产出结构是 `dist/sdk/src/*` + `dist/src/core/*`，相对引用自闭合。
 *
 *   2. **JS**：vite 打包成单文件 ESM。注意它必须打到**临时目录**再合并——
 *      若直接打到 dist，vite 的 emptyOutDir 会清掉第 1 步产出的 d.ts（踩过）。
 */

import { build } from 'vite'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const sdkDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(sdkDir, '..')
const dist = resolve(sdkDir, 'dist')
const jsTmp = resolve(sdkDir, '.tmp-js')

const hostSrc = resolve(repoRoot, 'out/driver-host/index.js')
if (!existsSync(hostSrc)) {
  console.error(`[sdk:build] 缺少驱动宿主产物: ${hostSrc}\n请先在仓库根目录执行: pnpm run build`)
  process.exit(1)
}

console.log('[sdk:build] 1/4 清空 dist 与临时目录')
rmSync(dist, { recursive: true, force: true })
rmSync(jsTmp, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

console.log('[sdk:build] 2/4 生成类型声明（含 core 的 d.ts，保证 dist 内自闭合）')
try {
  execFileSync(
    process.execPath,
    [resolve(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', resolve(sdkDir, 'tsconfig.build.json')],
    { stdio: 'inherit', cwd: sdkDir }
  )
} catch {
  console.error('[sdk:build] 类型声明生成失败')
  process.exit(1)
}

console.log('[sdk:build] 3/4 打包 JS（ESM 单文件，先打到临时目录）')
await build({
  configFile: false,
  root: sdkDir,
  logLevel: 'warn',
  build: {
    outDir: jsTmp,
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    ssr: true,
    lib: {
      entry: resolve(sdkDir, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      external: [/^node:/]
    }
  }
})
cpSync(resolve(jsTmp, 'index.js'), resolve(dist, 'sdk/src/index.js'), { force: true })
if (existsSync(resolve(jsTmp, 'index.js.map'))) {
  cpSync(resolve(jsTmp, 'index.js.map'), resolve(dist, 'sdk/src/index.js.map'), { force: true })
}
rmSync(jsTmp, { recursive: true, force: true })

console.log('[sdk:build] 4/4 复制驱动宿主')
cpSync(hostSrc, resolve(dist, 'driver-host/index.js'), { force: true })
if (existsSync(hostSrc + '.map')) {
  cpSync(hostSrc + '.map', resolve(dist, 'driver-host/index.js.map'), { force: true })
}

/**
 * ★ 必须给 driver-host 单独声明 CommonJS。
 *
 * 本 SDK 的 package.json 是 `"type": "module"`（对外用 ESM 很自然），
 * 但这个作用域会**继承到子目录**——驱动宿主脚本是 CJS（产物里有 `require`），
 * 被当 ESM 解释会直接 `ReferenceError: require is not defined in ES module scope`，
 * 表现是「DriverHost 一构造，子进程立刻以 code=1 退出」。
 *
 * 放一个最小的 package.json 声明即可切断继承。这个坑很难从错误信息联想到
 * `type: module`，所以在这里写清楚。
 */
writeFileSync(
  resolve(dist, 'driver-host/package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n'
)

console.log(`[sdk:build] ✅ 完成 → ${dist}`)
