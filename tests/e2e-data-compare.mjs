/** 数据比较纯逻辑：按唯一键比对，删除只进入计划，不执行。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dbstudio-data-compare-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir: work,
    target: 'node22',
    ssr: true,
    minify: false,
    lib: { entry: resolve(root, 'src/core/compare.ts'), formats: ['cjs'] },
    rollupOptions: { output: { entryFileNames: 'compare.cjs' } }
  }
})
const compare = await import(pathToFileURL(join(work, 'compare.cjs')).href)
let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const row = (id, email) => ({ key: { id }, values: { id, email } })
const result = compare.compareDataRows(
  [row(2, 'b@example.test'), row(1, 'a@example.test'), row(4, 'new@example.test')],
  [row(1, 'changed@example.test'), row(3, 'gone@example.test'), row(2, 'b@example.test')],
  { columns: ['id'] },
  'postgresql',
  { schema: 'public', name: 'users' }
)
const statuses = result.rows.map((item) => item.status)
check('四种行状态都按键排序出现', JSON.stringify(statuses) === JSON.stringify(['different', 'same', 'target-only', 'source-only']))
check('计划计数与风险分开', result.plan.insertCount === 1 && result.plan.updateCount === 1 && result.plan.deleteCount === 1 && result.plan.destructive)
check('删除语句进入计划但不代表已执行', result.plan.statements.some((sql) => sql.startsWith('DELETE FROM "public"."users"')))
check('更新只写变化列', result.plan.statements.some((sql) => sql.includes('SET "email" = \'a@example.test\'')))
check('删除风险有确认文案', result.plan.warnings.some((warning) => warning.includes('必须单独确认')))

let rejected = false
try {
  compare.compareDataRows([row(1, 'a')], [row(1, 'a')], { columns: [] }, 'sqlite', { name: 'users' })
} catch {
  rejected = true
}
check('空比较键被拒绝', rejected)

let duplicate = false
try {
  compare.compareDataRows([row(1, 'a'), row(1, 'b')], [], { columns: ['id'] }, 'sqlite', { name: 'users' })
} catch {
  duplicate = true
}
check('重复键被拒绝', duplicate)

console.log(`\n数据比较 ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
