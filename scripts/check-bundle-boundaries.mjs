/**
 * 构建产物边界检查。
 *
 * 源码 import 检查不能证明 Rollup 最终没有把 Node 运行时或驱动实现打进前端包：
 * alias、动态 import 和打包配置都可能让依赖图在构建后发生变化。因此发布前
 * 还要直接扫描构建产物，锁住「界面层不携带 Node 运行时与数据库驱动」这条承诺。
 *
 * 在 Tauri 架构下，驱动实现位于 Rust 侧，界面产物不应出现任何驱动依赖；
 * 数据库访问必须经 Tauri 命令桥，而不是前端直接连库。
 *
 * 这个脚本只读取构建产物，不执行 bundle，也不解析 source map。缺少产物时
 * 直接失败，避免把过期或不完整的 dist 当成一次成功验证。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST = resolve(ROOT, 'dist/desktop')

const FORBIDDEN_MARKERS = [
  'node:fs',
  'node:path',
  'node:child_process',
  'node:sqlite',
  'node:net',
  'node:tls',
  'mysql2',
  'kafkajs',
  'ioredis',
  'pg-promise'
]

function fail(message) {
  console.error(`❌ ${message}`)
  process.exitCode = 1
}

console.log('构建产物边界检查\n')

const entry = resolve(DIST, 'index.html')
if (!existsSync(entry)) {
  fail('缺少构建产物，请先运行 pnpm build --no-bundle：\n  - dist/desktop/index.html')
  process.exit(1)
}

// index.html 必须真正引用到脚本，否则打包配置可能只产出了空壳。
const html = readFileSync(entry, 'utf8')
const scriptPaths = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1])
if (scriptPaths.length === 0) {
  fail('dist/desktop/index.html 没有引用任何脚本')
  process.exit(1)
}

const assetsDir = resolve(DIST, 'assets')
if (!existsSync(assetsDir)) {
  fail('缺少 dist/desktop/assets 目录')
  process.exit(1)
}
const bundles = readdirSync(assetsDir).filter((name) => name.endsWith('.js'))
if (bundles.length === 0) {
  fail('dist/desktop/assets 下没有 JS 产物')
  process.exit(1)
}

// 逐个核对 html 引用的脚本确实存在，避免路径写错却仍判通过。
const missingScripts = scriptPaths
  .map((path) => (path.startsWith('/') ? path.slice(1) : path))
  .filter((path) => !existsSync(resolve(DIST, path)))
if (missingScripts.length > 0) {
  fail(`index.html 引用了不存在的脚本：${missingScripts.join(', ')}`)
  process.exit(1)
}

console.log(`✅ 必需产物齐全（index.html + ${bundles.length} 个 JS 产物）`)

const scanned = bundles.map((name) => ({ name, text: readFileSync(resolve(assetsDir, name), 'utf8') }))
const hits = []
for (const bundle of scanned) {
  for (const marker of FORBIDDEN_MARKERS) {
    if (bundle.text.includes(marker)) hits.push(`${bundle.name}: ${marker}`)
  }
}

if (hits.length > 0) {
  fail(`界面产物包含 Node 运行时或驱动依赖：\n${hits.map((hit) => `  - ${hit}`).join('\n')}`)
} else {
  console.log(`✅ ${bundles.length} 个前端产物均未包含 Node 内置模块或数据库驱动依赖`)
}

if (process.exitCode) {
  console.error('\n构建产物边界检查失败。')
} else {
  console.log('\n构建产物边界检查通过。')
}
