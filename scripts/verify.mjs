/**
 * 按 `verify-manifest.mjs` 的清单执行验证。
 *
 * `--only` 是单步骤选择器，不是分组名。它不会自动重建前置产物；
 * 执行单步骤前的构建和夹具责任由调用方承担。
 */
import { spawnSync } from 'node:child_process'
import { STEPS, checkEnv } from './verify-manifest.mjs'

const GROUPS = new Set(['node', 'gui', 'external'])
const HELP = `用法：
  node scripts/verify.mjs [分组] [选项]

分组：
  node       纯 Node 步骤
  gui        需要真实窗口的步骤
  external   需要外部服务的步骤
  （省略分组时执行全部分组）

选项：
  --only <step>          只执行一个清单步骤
  --require-external     外部服务缺失或外部步骤跳过时失败
  --help                 显示帮助

单步骤不会自动执行前置的 build 或 fixture；请由调用方先准备。
`

function usageError(message) {
  console.error(`参数错误：${message}`)
  console.error(HELP)
  process.exitCode = 1
  return null
}

function parseArgs(args) {
  let group = null
  let only = null
  let requireExternal = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      if (args.length !== 1) return usageError('--help 不能和其它参数同时使用')
      console.log(HELP)
      return { help: true }
    }
    if (arg === '--require-external') {
      if (requireExternal) return usageError('重复选项 --require-external')
      requireExternal = true
      continue
    }
    if (arg === '--only') {
      if (only !== null) return usageError('重复选项 --only')
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--') || value.length === 0) {
        return usageError('--only 必须有一个步骤 id')
      }
      only = value
      index += 1
      continue
    }
    if (arg.startsWith('--')) return usageError(`未知选项 ${arg}`)
    if (group !== null) return usageError(`只能选择一个分组（已选择 ${group}）`)
    if (!GROUPS.has(arg)) return usageError(`未知分组 ${arg}`)
    group = arg
  }

  const step = only === null ? null : STEPS.find((candidate) => candidate.id === only)
  if (only !== null && !step) return usageError(`未知步骤 ${only}`)
  if (group !== null && step !== null && step.group !== group) {
    return usageError(`分组 ${group} 与步骤 ${only} 冲突；步骤属于 ${step.group} 分组`)
  }

  const selected = STEPS.filter((candidate) => {
    if (only !== null) return candidate.id === only
    return group === null || candidate.group === group
  })
  if (selected.length === 0) return usageError('选择结果为空；清单没有可执行步骤')
  return { group, only, requireExternal, selected }
}

function hasExplicitSkip(output) {
  return /(?:^|\n)\s*(?:SKIP|跳过|⊘)/m.test(output)
}

function hasSetupBlock(output) {
  return /(?:^|\n)\s*BLOCKED_BY_SETUP(?:\s|$)/m.test(output)
}

function runStep(step) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(pnpm, ['run', step.id], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8'
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  return {
    ...result,
    output: stdout + stderr,
    failedToStart: result.error ?? null
  }
}

const parsed = parseArgs(process.argv.slice(2))
if (parsed?.help) process.exit(0)
if (!parsed) process.exit(1)

const { requireExternal, selected } = parsed
let failed = 0
let skipped = 0
let passed = 0
let executed = 0

console.log('='.repeat(70))
console.log('dbstudio 验证清单')
console.log(`选中 ${selected.length} 个步骤`)
console.log('='.repeat(70))

for (const step of selected) {
  if (step.group === 'external') {
    const { ok, missing } = checkEnv(step, process.env)
    if (!ok) {
      if (requireExternal) {
        failed += 1
        console.error(`\n✗ [${step.id}] ${step.title}`)
        console.error(`  缺少必需环境变量：${missing.join(', ')}`)
      } else {
        skipped += 1
        console.log(`\n⊘ [${step.id}] ${step.title} —— 跳过（缺 ${missing.join(', ')}）`)
      }
      continue
    }
  }

  console.log(`\n${'─'.repeat(70)}`)
  console.log(`▶ [${step.id}] ${step.title}`)
  executed += 1
  const result = runStep(step)
  if (result.failedToStart) {
    failed += 1
    console.error(`\n✗ [${step.id}] 无法启动`)
    console.error(`  ${result.failedToStart.message}`)
    break
  }
  if (result.status !== 0) {
    failed += 1
    const exitReason = result.signal ? `信号 ${result.signal}` : `退出码 ${result.status}`
    console.error(`\n✗ [${step.id}] 失败（${exitReason}）`)
    break
  }
  if (hasSetupBlock(result.output)) {
    failed += 1
    console.error(`\n✗ [${step.id}] 测试被 setup 前置条件阻塞（BLOCKED_BY_SETUP）`)
    break
  }
  if (step.group === 'external' && hasExplicitSkip(result.output)) {
    if (requireExternal) {
      failed += 1
      console.error(`\n✗ [${step.id}] 外部步骤报告了跳过，但 --require-external 要求真实执行`)
      break
    }
    skipped += 1
    console.log(`\n⊘ [${step.id}] 外部步骤报告了跳过`)
  } else {
    passed += 1
  }
}

console.log('\n' + '='.repeat(70))
console.log(`选中 ${selected.length} / 执行 ${executed} / 通过 ${passed} / 跳过 ${skipped} / 失败 ${failed}`)
console.log('='.repeat(70))

process.exitCode = failed > 0 || passed + skipped === 0 ? 1 : 0
