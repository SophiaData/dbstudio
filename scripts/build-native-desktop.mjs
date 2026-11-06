// Build a production desktop from a fresh frontend directory, preserving all previous artifacts.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pnpmScript = process.env.npm_execpath
assert.ok(pnpmScript && existsSync(pnpmScript), '请通过 pnpm build 或 pnpm tauri:build 执行构建')
const args = process.argv.slice(2)
const simple = new Set(['--no-bundle', '--ci', '--no-sign'])
const bundles = new Set(['app', 'dmg', 'nsis', 'msi', 'deb', 'rpm', 'appimage'])
for (let index = 0; index < args.length; index++) {
  const value = args[index]
  if (simple.has(value)) continue
  if (value === '--target') {
    assert.match(args[++index] ?? '', /^(aarch64-apple-darwin|x86_64-pc-windows-msvc|x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu)$/)
    continue
  }
  if (value === '--bundles') {
    const selected = (args[++index] ?? '').split(',')
    assert.ok(selected.length > 0 && selected.every((bundle) => bundles.has(bundle)), '安装包类型无效')
    continue
  }
  throw new Error('生产入口仅允许 --no-bundle、--ci、--no-sign、--target 与 --bundles；禁止调试、feature 或配置覆盖参数')
}
const env = { ...process.env, VITE_DBSTUDIO_TEST_HOOKS: '0', OPENSSL_STATIC: '1' }
delete env.DBSTUDIO_NATIVE_SMOKE_ROOT
const output = resolve(root, 'dist', `native-production-${randomUUID()}`)
assert.ok(!existsSync(output), '生产前端产物必须写入全新目录')
function run(command) {
  const result = spawnSync(process.execPath, [pnpmScript, 'exec', ...command], { cwd: root, env, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error(`原生构建步骤失败：${command[0]}`)
}
run(['vue-tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
run(['vite', 'build', '--config', 'apps/desktop/vite.config.ts', '--outDir', output])
assert.ok(existsSync(join(output, 'index.html')), '缺少生产 Vue 入口')
const assets = join(output, 'assets')
for (const entry of readdirSync(assets, { withFileTypes: true })) {
  if (entry.isFile() && /\.js$/.test(entry.name)) {
    assert.ok(!readFileSync(join(assets, entry.name), 'utf8').includes('__DBSTUDIO_NATIVE_SMOKE__'), '生产前端不允许原生测试控制器')
  }
}
run(['tauri', 'build', '--config', JSON.stringify({ build: { frontendDist: output } }), ...args])
const targetIndex = args.indexOf('--target')
const target = targetIndex >= 0 ? args[targetIndex + 1] : null
if (process.platform === 'darwin' && (!target || target.endsWith('-apple-darwin'))) {
  const binary = target ? join(root, 'target', target, 'release', 'dbstudio-desktop') : join(root, 'target', 'release', 'dbstudio-desktop')
  const linked = spawnSync('otool', ['-L', binary], { encoding: 'utf8' })
  assert.equal(linked.status, 0, '必须能检查 macOS 生产应用的链接依赖')
  const dependencies = linked.stdout.trim().split('\n').slice(1).map((line) => line.trim().split(' (')[0])
  assert.ok(dependencies.every((path) => path.startsWith('/usr/lib/') || path.startsWith('/System/Library/')), '生产应用包含未打包的非系统动态库')
  console.log('Native macOS linkage: system libraries only; no Homebrew dependency')
}
console.log('Native production build: fresh Vue assets and Tauri/Rust host; test hooks disabled')
