/**
 * ER 关系纯逻辑契约：不启动 Electron，只验证外键到关系边的判定。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dbstudio-er-relations-'))
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
    lib: { entry: resolve(root, 'src/renderer/er-relations.ts'), formats: ['cjs'] },
    rollupOptions: { output: { entryFileNames: 'er-relations.cjs' } }
  }
})

const er = await import(pathToFileURL(join(work, 'er-relations.cjs')).href)
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

const ref = (id, name) => ({ id, kind: 'table', name, parentId: null, hasChildren: true })
const desc = (foreignKeys) => ({ id: 'x', columns: [], hasUniqueKey: true, foreignKeys })
const fk = (overrides = {}) => ({
  name: 'fk_child_parent',
  columns: ['parent_id', 'parent_code'],
  referencedSchema: null,
  referencedTable: 'parent',
  referencedColumns: ['id', 'code'],
  onUpdate: 'CASCADE',
  onDelete: 'CASCADE',
  ...overrides
})

const composite = er.computeErRelations([
  { ref: ref('connection:c1|table:public.child', 'child'), desc: desc([fk()]) },
  { ref: ref('connection:c1|table:public.parent', 'parent'), desc: desc([]) }
])
check('复合外键生成一条可绘制关系', composite.relations.length === 1, composite)
check('复合外键保留列顺序', composite.relations[0]?.columnPairs[1]?.referencedColumn === 'code', composite.relations[0])
check('删除/更新动作保留', composite.relations[0]?.onDelete === 'CASCADE' && composite.relations[0]?.onUpdate === 'CASCADE', composite.relations[0])

const crossSchema = er.computeErRelations([
  { ref: ref('connection:c1|table:public.child', 'child'), desc: desc([fk({ referencedSchema: 'audit' })]) },
  { ref: ref('connection:c1|table:public.parent', 'parent'), desc: desc([]) },
  { ref: ref('connection:c1|table:audit.parent', 'parent'), desc: desc([]) }
])
check('跨 schema 外键匹配到指定 schema', crossSchema.relations[0]?.to.schema === 'audit', crossSchema.relations[0])

const missing = er.computeErRelations([
  { ref: ref('connection:c1|table:child', 'child'), desc: desc([fk({ referencedSchema: null })]) }
])
check('目标表不在图内时不画错线', missing.relations.length === 0 && missing.skipped[0]?.reason === 'target-missing', missing)
check('悬空外键状态是 undrawn', er.relationStatusToken(missing) === 'undrawn', er.erRelationStatus(missing))

const unavailable = er.computeErRelations([
  { ref: ref('connection:c1|table:legacy', 'legacy'), desc: desc(undefined) }
])
check('undefined 外键元数据表示 unavailable', unavailable.metadataState === 'unavailable', unavailable)
check('unavailable 文案不会误报无关系', er.erRelationStatus(unavailable).kind === 'unavailable', er.erRelationStatus(unavailable))

const empty = er.computeErRelations([
  { ref: ref('connection:c1|table:standalone', 'standalone'), desc: desc([]) }
])
check('空数组表示驱动确认无关系', empty.metadataState === 'empty' && er.relationStatusToken(empty) === 'none', empty)

console.log(`\nER 关系纯逻辑契约：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
