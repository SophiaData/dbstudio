/**
 * 验证清单的一致性检查。
 *
 * ===== 这条测试防的是什么 =====
 *
 * 清单有两份「消费者」：`package.json` 的脚本表，和 `scripts/verify-manifest.mjs`。
 * 如果有人加了一个测试脚本却忘了登记进清单，那段测试就**永远不会被跑**——
 * 而且没有任何报错，只是安静地少验证了一件事。
 *
 * 这类失败最危险，因为它表现为「一切正常」。所以这里用测试把它变成显式失败。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { STEPS, stepIds, checkVersionMatch } = await import(
  new URL('../scripts/verify-manifest.mjs', import.meta.url).href
)

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const scripts = pkg.scripts

console.log('\n[1] 清单里的每个步骤都必须有对应的 npm 脚本')
for (const step of STEPS) {
  check(
    `清单步骤 ${step.id} 有对应脚本`,
    typeof scripts[step.id] === 'string',
    typeof scripts[step.id] === 'string' ? '' : `scripts.${step.id} 未定义`
  )
}

console.log('\n[2] 每个测试脚本都必须登记进清单')
// 白名单：这些脚本不是「验证步骤」，它们是辅助命令或分组入口。
const notSteps = new Set([
  'verify',
  'verify:node',
  'verify:gui',
  'verify:external',
  'verify:ci',
  'verify:headless',
  'test:gui:headless',
  'dev',
  'preview',
  'build',
  'build:driver-host',
  'build:app',
  'build:app:mac',
  'build:app:linux',
  'build:app:win',
  'build:sdk',
  'typecheck',
  'fixture',
  'test',
  'test:gui',
  'ssh-fixture',
  'ssl-fixture',
  'check:build'
])
const registered = new Set(STEPS.map((s) => s.id))
const unregistered = Object.keys(scripts).filter(
  (name) => name.startsWith('test:') && !registered.has(name) && !notSteps.has(name)
)
check(
  '没有未登记的 test:* 脚本',
  unregistered.length === 0,
  unregistered.length > 0 ? `未登记：${unregistered.join(', ')}` : ''
)

console.log('\n[3] 清单自身不能有重复或空缺')
const ids = STEPS.map((s) => s.id)
check('步骤 id 无重复', new Set(ids).size === ids.length)
check('每一步都有标题', STEPS.every((s) => typeof s.title === 'string' && s.title.length > 0))
check(
  '分组取值合法',
  STEPS.every((s) => ['node', 'gui', 'external'].includes(s.group))
)

console.log('\n[4] external 组必须声明环境变量')
// 没有 env 声明的 external 步骤，无法判断「是跳过了还是真跑了」——
// 那正是早先 CI 里 PG 从未被真正验证的原因。
check(
  'external 步骤都声明了必需环境变量',
  STEPS.filter((s) => s.group === 'external').every((s) => (s.env ?? []).length > 0)
)

console.log('\n[5] 分组入口齐全且可用')
for (const group of ['node', 'gui', 'external']) {
  check(`stepIds('${group}') 非空`, stepIds(group).length > 0, `${group} 组为空`)
}
check(
  'verify:headless 存在且走清单',
  typeof scripts['verify:headless'] === 'string' &&
    scripts['verify:headless'].includes('scripts/verify.mjs'),
  scripts['verify:headless'] ?? '未定义'
)

console.log('\n[6] 发布门禁：tag 与声明版本必须一致')
check('当前版本号与 tag v 一致', checkVersionMatch(`v${pkg.version}`, pkg.version).ok, pkg.version)
check(
  'checkVersionMatch 能识别不一致的 tag',
  checkVersionMatch('v9.9.9', pkg.version).ok === false
)
check(
  'checkVersionMatch 接受不带 v 前缀的 tag',
  checkVersionMatch(pkg.version, pkg.version).ok === true
)
check(
  'SDK 也有独立版本号（发布时要分别标注）',
  typeof pkg.version === 'string' && pkg.version.length > 0
)

console.log(`\n===== 验证清单一致性：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exit(1)

