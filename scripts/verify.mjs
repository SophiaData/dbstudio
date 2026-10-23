/**
 * 按 `verify-manifest.mjs` 的清单执行验证。
 *
 * 用法：
 *   node scripts/verify.mjs              # 全部分组
 *   node scripts/verify.mjs node         # 只跑纯 Node
 *   node scripts/verify.mjs gui          # 只跑 GUI（Linux 上需自行准备 xvfb）
 *   node scripts/verify.mjs external     # 只跑需要外部服务的
 *   node scripts/verify.mjs --only test:postgres   # 只跑指定步骤
 *
 * ===== 为什么退出码要严格 =====
 *
 * 「external」组在缺环境时**跳过**并明确打印「跳过 + 缺哪个变量」，
 * 退出码仍是 0。这是刻意的：本地没有 PG 时的跳过不是失败。
 * 但 CI 里必须提供这些服务——所以 CI 用 `--require-external`，
 * 缺环境直接判失败，避免「绿得没有说服力」。
 */
import { spawnSync } from 'node:child_process'
import { STEPS, checkEnv } from './verify-manifest.mjs'

const args = process.argv.slice(2)
const requireExternal = args.includes('--require-external')
const groups = args.filter((a) => !a.startsWith('--'))
const onlyIndex = args.indexOf('--only')
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null
const selected = groups.length > 0 ? new Set(groups) : new Set(['node', 'gui', 'external'])

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

let failed = 0
let skipped = 0
let passed = 0

console.log('='.repeat(70))
console.log('dbstudio 验证清单')
console.log('='.repeat(70))

for (const step of STEPS) {
  if (!selected.has(step.group)) continue
  if (only && step.id !== only) continue

  if (step.group === 'external') {
    const { ok, missing } = checkEnv(step, process.env)
    if (!ok) {
      if (requireExternal) {
        failed += 1
        console.error(`\n✗ [${step.id}] ${step.title}`)
        console.error(`  缺少必需环境变量：${missing.join(', ')}`)
        console.error('  CI 模式要求外部服务必须就绪——缺环境即判失败，')
        console.error('  否则这一段会静默跳过，CI 全绿却根本没验证过它。')
        continue
      }
      skipped += 1
      console.log(`\n⊘ [${step.id}] ${step.title} —— 跳过（缺 ${missing.join(', ')}）`)
      continue
    }
  }

  console.log(`\n${'─'.repeat(70)}`)
  console.log(`▶ [${step.id}] ${step.title}`)
  const result = spawnSync(pnpm, ['run', step.id], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32'
  })
  if (result.status === 0) {
    passed += 1
  } else {
    failed += 1
    console.error(`\n✗ [${step.id}] 失败（退出码 ${result.status}）`)
    // 失败就停：后面的步骤依赖前面的产物，继续跑只会制造噪音。
    break
  }
}

console.log('\n' + '='.repeat(70))
console.log(`通过 ${passed} / 跳过 ${skipped} / 失败 ${failed}`)
console.log('='.repeat(70))

process.exit(failed > 0 ? 1 : 0)

