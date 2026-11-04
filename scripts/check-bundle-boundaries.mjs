/**
 * 构建产物边界检查。
 *
 * 源码 import 检查不能证明 Rollup 最终没有把驱动实现打进 main bundle：
 * alias、动态 import 和打包配置都可能让依赖图在构建后发生变化。因此发布前
 * 还要直接扫描 out/ 产物，锁住「main 只持有元数据，driver-host 才持有实现」
 * 以及「renderer/preload 不携带 Node 运行时」这两条进程隔离承诺。
 *
 * 这个脚本只读取构建产物，不执行 bundle，也不解析 source map。缺少产物时
 * 直接失败，避免把过期或不完整的 out/ 当成一次成功验证。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT = resolve(ROOT, 'out')

const required = [
  'main/index.js',
  'preload/index.js',
  'renderer/index.html',
  'driver-host/index.js'
]

const MAIN_FORBIDDEN_DRIVER_MARKERS = [
  'registerBuiltinDrivers',
  'createSqliteAdapter',
  'SqliteAdapter',
  'PostgresAdapter',
  'MysqlAdapter',
  'MariaDbAdapter',
  'RedisAdapter',
  'KafkaAdapter',
  'mysql2',
  'kafkajs',
  'ioredis'
]

const PRELOAD_RENDERER_FORBIDDEN_MARKERS = [
  'node:fs',
  'node:path',
  'node:child_process',
  'node:sqlite',
  'mysql2',
  'kafkajs',
  'ioredis'
]

function fail(message) {
  console.error(`❌ ${message}`)
  process.exitCode = 1
}

console.log('构建产物边界检查\n')

const missing = required.filter((relativePath) => !existsSync(resolve(OUT, relativePath)))
if (missing.length > 0) {
  fail(`缺少构建产物，请先运行 pnpm run build：\n${missing.map((item) => `  - out/${item}`).join('\n')}`)
} else {
  console.log(`✅ 必需产物齐全（${required.length} 个）`)
}

if (process.exitCode) process.exit(process.exitCode)

const main = readFileSync(resolve(OUT, 'main/index.js'), 'utf8')
const preload = readFileSync(resolve(OUT, 'preload/index.js'), 'utf8')
const renderer = readFileSync(resolve(OUT, 'renderer/index.html'), 'utf8')
const rendererScriptPaths = [...renderer.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1])
const rendererScripts = rendererScriptPaths.map((scriptPath) => {
  const normalized = scriptPath.startsWith('/') ? scriptPath.slice(1) : scriptPath
  const path = resolve(OUT, 'renderer', normalized)
  if (!existsSync(path)) {
    fail(`renderer/index.html 引用了不存在的脚本：${scriptPath}`)
    return ''
  }
  return readFileSync(path, 'utf8')
}).join('\n')

const mainHits = MAIN_FORBIDDEN_DRIVER_MARKERS.filter((marker) => main.includes(marker))
if (mainHits.length > 0) {
  fail(`main bundle 包含驱动实现标记：${mainHits.join(', ')}`)
} else {
  console.log('✅ main bundle 未包含具体驱动实现依赖')
}

const uiHits = PRELOAD_RENDERER_FORBIDDEN_MARKERS.filter(
  (marker) => preload.includes(marker) || rendererScripts.includes(marker)
)
if (uiHits.length > 0) {
  fail(`preload/renderer bundle 包含 Node 或驱动依赖：${uiHits.join(', ')}`)
} else {
  console.log('✅ preload/renderer bundle 未包含 Node 内置模块或驱动依赖')
}

if (process.exitCode) {
  console.error('\n构建产物边界检查失败。')
} else {
  console.log('\n构建产物边界检查通过。')
}
