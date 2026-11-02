/** 结构比较纯逻辑：同样的快照必须得到同样的 SQL，危险语句只生成不执行。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dbstudio-structure-compare-'))
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

const column = (name, typeName, extras = {}) => ({
  name,
  typeName,
  nullable: false,
  primaryKeyOrdinal: null,
  defaultValue: null,
  ...extras
})
const table = (name, columns, extras = {}) => ({ id: `table:public.${name}`, schema: 'public', name, columns, hasUniqueKey: true, ...extras })
const snapshot = (tables, views = [], routines = []) => ({
  source: { connectionId: 'left', schema: 'public' },
  tables,
  views,
  routines
})

const users = table('users', [
  column('id', 'INTEGER', { primaryKeyOrdinal: 1 }),
  column('email', 'TEXT')
], {
  indexes: [{ name: 'users_email', unique: true, columns: ['email'], predicate: null, expression: null }],
  foreignKeys: [],
  uniqueConstraints: [],
  checks: []
})
const changed = table('users', [
  column('id', 'INTEGER', { primaryKeyOrdinal: 1 }),
  column('email', 'VARCHAR(32)'),
  column('legacy', 'TEXT')
])
const source = snapshot([users], [{ schema: 'public', name: 'active_users', definition: 'SELECT id FROM users' }])
const target = snapshot(
  [changed, table('logs', [column('id', 'INTEGER', { primaryKeyOrdinal: 1 })])],
  [{ schema: 'public', name: 'active_users', definition: 'SELECT email FROM users' }]
)
const shuffled = snapshot(
  [...target.tables].reverse(),
  [...target.views]
)

const first = compare.diffSchema(source, target, 'postgresql')
const second = compare.diffSchema(source, shuffled, 'postgresql')
check('对象输入顺序不影响差异', JSON.stringify(first) === JSON.stringify(second))
check('类型不同按源端生成 TYPE', first.statements.some((sql) => sql.includes('ALTER COLUMN "email" TYPE TEXT')))
check('目标多出的列生成 DROP COLUMN 并标危险', first.statements.some((sql) => sql.includes('DROP COLUMN "legacy"')) && first.destructive)
check('目标多出的表生成 DROP TABLE', first.changes.some((change) => change.kind === 'drop' && change.objectType === 'table'))
check('定义变化的视图先删除再按源端重建', first.statements.some((sql) => sql.includes('DROP VIEW')) && first.statements.some((sql) => sql.includes('SELECT id FROM users')))
check('缺少的唯一索引生成 CREATE UNIQUE INDEX', first.statements.some((sql) => sql.includes('CREATE UNIQUE INDEX "users_email"')))

let threw = false
try {
  compare.diffSchema(source, target, 'mysql')
} catch {
  threw = true
}
check('未知方言拒绝生成 SQL', threw)
check('DROP TABLE 带 schema 限定', first.statements.includes('DROP TABLE "public"."logs"'))

const fkSource = snapshot([table('orders', [column('id', 'INTEGER', { primaryKeyOrdinal: 1 }), column('user_id', 'INTEGER')], {
  foreignKeys: [{ name: 'orders_user', columns: ['user_id'], referencedSchema: null, referencedTable: 'users', referencedColumns: ['id'], onUpdate: null, onDelete: null }]
})])
const fkTarget = snapshot([table('orders', [column('id', 'INTEGER', { primaryKeyOrdinal: 1 }), column('user_id', 'INTEGER')], { foreignKeys: [] })])
const fkDiff = compare.diffSchema(fkSource, fkTarget, 'postgresql')
check('同 schema 外键引用按本表 schema 限定', fkDiff.statements.some((sql) => sql.includes('REFERENCES "public"."users" ("id")')), fkDiff.statements.join(' | '))
check('只新增约束不算危险', fkDiff.destructive === false)

const fn = (definition) => ({ schema: 'public', name: 'touch', kind: 'function', definition })
const routineDiff = compare.diffSchema(snapshot([], [], [fn('CREATE FUNCTION public.touch() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql')]), snapshot([], [], [fn('CREATE FUNCTION public.touch() RETURNS int AS $$ SELECT 2 $$ LANGUAGE sql')]), 'postgresql')
check('例程变化生成 DROP FUNCTION + 源端定义', routineDiff.statements[0] === 'DROP FUNCTION "public"."touch"' && routineDiff.statements[1]?.includes('SELECT 1'), routineDiff.statements.join(' | '))
const unknownView = compare.diffSchema(snapshot([], [{ schema: 'public', name: 'v', definition: null }]), snapshot([], [{ schema: 'public', name: 'v', definition: null }]), 'postgresql')
check('视图定义未知时不生成删除重建', unknownView.changes.length === 0)
const same = compare.diffSchema(source, source, 'postgresql')
check('相同快照没有差异', same.changes.length === 0 && same.destructive === false)

const withIndex = snapshot([table('items', [column('id', 'INTEGER', { primaryKeyOrdinal: 1 })], {
  indexes: [{ name: 'items_id_idx', unique: false, columns: ['id'], predicate: null }]
})])
const newTable = compare.diffSchema(withIndex, snapshot([]), 'postgresql')
check('新建表连索引一起生成', newTable.statements.some((sql) => sql.includes('CREATE INDEX "items_id_idx"')), newTable.statements.join(' | '))

const sqliteType = compare.diffSchema(
  snapshot([table('t', [column('n', 'TEXT')])]),
  snapshot([table('t', [column('n', 'INTEGER')])]),
  'sqlite'
)
check('SQLite 不生成非法 ALTER COLUMN TYPE', !sqliteType.statements.some((sql) => /ALTER COLUMN/.test(sql)), sqliteType.statements.join(' | '))
check('SQLite 类型差异改为明确告警', sqliteType.warnings.some((w) => w.includes('需要手工重建表')), JSON.stringify(sqliteType.warnings))
const pgType = compare.diffSchema(
  snapshot([table('t', [column('n', 'TEXT')])]),
  snapshot([table('t', [column('n', 'INTEGER')])]),
  'postgresql'
)
check('PostgreSQL 仍生成 ALTER COLUMN TYPE', pgType.statements.some((sql) => /ALTER COLUMN "n" TYPE TEXT/.test(sql)), pgType.statements.join(' | '))

const unknownDefs = compare.diffSchema(snapshot([], [{ schema: 'public', name: 'v', definition: null }]), snapshot([], []), 'postgresql')
check('视图定义缺失时给出未比较告警', unknownDefs.warnings.some((w) => w.includes('没读到定义')), JSON.stringify(unknownDefs.warnings))
check('例程未提供时给出未比较告警', unknownDefs.warnings.some((w) => w.includes('例程')), JSON.stringify(unknownDefs.warnings))
check('覆盖范围说明包含视图与例程', /比较范围：表 0 → 0，视图 1 → 0（定义未读取），例程 未提供。/.test(compare.describeCoverage(snapshot([], [{ schema: 'public', name: 'v', definition: null }]), snapshot([], []))), compare.describeCoverage(snapshot([], [{ schema: 'public', name: 'v', definition: null }]), snapshot([], [])))

// ===== 视图 / 例程定义：捕获到定义后必须能识别"定义变化" =====
// 背景：早期 captureSchemaSnapshot 把视图 definition 硬编码为 null，
// 比较器只能判断视图存在与否，看不出定义改了没有——等于静默给出"结构一致"的错误结论。

// PG 风格：pg_get_viewdef 只返回查询体，需要补 CREATE VIEW 头部。
const viewChanged = compare.diffSchema(
  snapshot([], [{ schema: 'public', name: 'v', definition: 'SELECT id FROM t' }]),
  snapshot([], [{ schema: 'public', name: 'v', definition: 'SELECT id FROM t WHERE active' }]),
  'postgresql'
)
check(
  '视图定义变化生成 DROP VIEW + 重建',
  viewChanged.changes.length === 1 &&
    viewChanged.statements[0] === 'DROP VIEW "public"."v"' &&
    viewChanged.statements[1] === 'CREATE VIEW "public"."v" AS SELECT id FROM t',
  viewChanged.statements.join(' | ')
)
check('视图定义变化标记为危险（会丢对象）', viewChanged.destructive === true)

// SQLite 风格：sqlite_master.sql 是完整 DDL，不能再补一次头部。
const sqliteViewChanged = compare.diffSchema(
  snapshot([], [{ schema: null, name: 'v', definition: 'CREATE VIEW v AS SELECT 1' }]),
  snapshot([], [{ schema: null, name: 'v', definition: 'CREATE VIEW v AS SELECT 2' }]),
  'sqlite'
)
const sqliteCreate = sqliteViewChanged.statements.find((sql) => sql.startsWith('CREATE VIEW'))
check(
  'SQLite 完整 DDL 视图不重复添加 CREATE VIEW 头部',
  sqliteCreate === 'CREATE VIEW v AS SELECT 1',
  JSON.stringify(sqliteViewChanged.statements)
)

// 一侧定义缺失：无法判断变化，宁可不报差异也不误伤（不生成 DROP）。
const oneSideNull = compare.diffSchema(
  snapshot([], [{ schema: 'public', name: 'v', definition: 'SELECT 1' }]),
  snapshot([], [{ schema: 'public', name: 'v', definition: null }]),
  'postgresql'
)
check('一侧视图定义缺失时不生成删除重建', oneSideNull.changes.length === 0, JSON.stringify(oneSideNull.changes))

// 例程（函数）：pg_get_functiondef 返回完整 CREATE 语句，直接执行，不再拼前缀。
const fnChanged = compare.diffSchema(
  snapshot([], [], [{ schema: 'public', name: 'f', kind: 'function', definition: 'CREATE FUNCTION public.f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql' }]),
  snapshot([], [], [{ schema: 'public', name: 'f', kind: 'function', definition: 'CREATE FUNCTION public.f() RETURNS int AS $$ SELECT 2 $$ LANGUAGE sql' }]),
  'postgresql'
)
check(
  '例程定义未变时不报差异',
  compare.diffSchema(
    snapshot([], [], [{ schema: 'public', name: 'f', kind: 'function', definition: 'CREATE FUNCTION public.f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql' }]),
    snapshot([], [], [{ schema: 'public', name: 'f', kind: 'function', definition: 'CREATE FUNCTION public.f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql' }]),
    'postgresql'
  ).changes.length === 0
)
check(
  '例程定义变化生成 DROP FUNCTION + 源端完整定义',
  fnChanged.statements[0] === 'DROP FUNCTION "public"."f"' &&
    fnChanged.statements[1] === 'CREATE FUNCTION public.f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql',
  fnChanged.statements.join(' | ')
)

// 过程（procedure）走 DROP PROCEDURE，不能误用 DROP FUNCTION。
const procChanged = compare.diffSchema(
  snapshot([], [], [{ schema: 'public', name: 'p', kind: 'procedure', definition: 'CREATE PROCEDURE public.p() LANGUAGE sql AS $$ SELECT 1 $$' }]),
  snapshot([], [], [{ schema: 'public', name: 'p', kind: 'procedure', definition: 'CREATE PROCEDURE public.p() LANGUAGE sql AS $$ SELECT 2 $$' }]),
  'postgresql'
)
check(
  '过程变化使用 DROP PROCEDURE',
  procChanged.statements[0] === 'DROP PROCEDURE "public"."p"',
  procChanged.statements.join(' | ')
)

// ===== 重载例程：同名不同参，不能被当成"重复对象" =====
// PostgreSQL 允许 f(int) 与 f(text) 共存。早期实现只按 kind+schema+name 对齐，
// 撞 key 会让 indexBy 抛错，导致**任何含重载函数的 PG 库都无法做结构比较**。
const overloadSource = snapshot([], [], [
  { schema: 'public', name: 'f', kind: 'function', signature: ['integer'], definition: 'CREATE FUNCTION public.f(x integer) RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql' },
  { schema: 'public', name: 'f', kind: 'function', signature: ['text'], definition: 'CREATE FUNCTION public.f(x text) RETURNS int AS $$ SELECT 2 $$ LANGUAGE sql' }
])
let overloadThrew = false
let overloadDiff = null
try {
  overloadDiff = compare.diffSchema(overloadSource, snapshot([], []), 'postgresql')
} catch (e) {
  overloadThrew = true
}
check('两个重载函数不会被判定为重复对象', !overloadThrew)
check(
  '重载函数各自生成一条创建语句',
  overloadThrew === false && overloadDiff.changes.filter((c) => c.objectType === 'routine').length === 2,
  overloadThrew ? '抛错' : JSON.stringify(overloadDiff.changes.map((c) => c.target))
)
check(
  '重载键包含参数签名以区分彼此',
  overloadThrew === false &&
    overloadDiff.changes.some((c) => c.target === 'function:public.f(integer)') &&
    overloadDiff.changes.some((c) => c.target === 'function:public.f(text)'),
  overloadThrew ? '抛错' : JSON.stringify(overloadDiff.changes.map((c) => c.target))
)

// 重载的 DROP 必须带参数类型，否则 PG 会拒绝执行。
const overloadDrop = compare.diffSchema(
  snapshot([], []),
  snapshot([], [], [
    { schema: 'public', name: 'f', kind: 'function', signature: ['integer', 'text'], definition: 'CREATE FUNCTION public.f(a integer, b text) RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql' }
  ]),
  'postgresql'
)
check(
  '重载函数的 DROP 带参数类型',
  overloadDrop.statements[0] === 'DROP FUNCTION "public"."f"(integer, text)',
  JSON.stringify(overloadDrop.statements)
)

// ===== 例程单侧定义缺失：两个方向都必须安全 =====
// 早期实现：源端 null 直接抛错（整次比较失败）；目标端 null 被判为"有变化"，
// 生成 DROP + CREATE —— 实际可能只是没读到定义，这条 SQL 会真的删掉用户的函数。
const fnWithDef = (definition) => [{ schema: 'public', name: 'h', kind: 'function', definition }]
let sourceNullThrew = false
let sourceNullDiff = null
try {
  sourceNullDiff = compare.diffSchema(
    snapshot([], [], fnWithDef(null)),
    snapshot([], [], fnWithDef('CREATE FUNCTION public.h() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql')),
    'postgresql'
  )
} catch {
  sourceNullThrew = true
}
check('例程源端定义缺失时不抛错', !sourceNullThrew)
check('例程源端定义缺失时不生成差异', !sourceNullThrew && sourceNullDiff.changes.length === 0,
  sourceNullThrew ? '抛错' : JSON.stringify(sourceNullDiff.changes))

const targetNullDiff = compare.diffSchema(
  snapshot([], [], fnWithDef('CREATE FUNCTION public.h() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql')),
  snapshot([], [], fnWithDef(null)),
  'postgresql'
)
check(
  '例程目标端定义缺失时不得生成危险的 DROP',
  targetNullDiff.changes.length === 0 && targetNullDiff.statements.length === 0,
  JSON.stringify(targetNullDiff.statements)
)

// 两侧都有定义且确实不同 → 仍必须正常报差异（守卫不能把真实变更也吞掉）。
const realChange = compare.diffSchema(
  snapshot([], [], fnWithDef('CREATE FUNCTION public.h() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql')),
  snapshot([], [], fnWithDef('CREATE FUNCTION public.h() RETURNS int AS $$ SELECT 2 $$ LANGUAGE sql')),
  'postgresql'
)
check('例程定义真实变化仍被识别', realChange.changes.length === 1 && realChange.destructive === true,
  JSON.stringify(realChange.statements))

// SQLite 没有例程是既定事实，措辞不应暗示驱动有问题。
const sqliteRoutineWarn = compare.diffSchema(snapshot([]), snapshot([]), 'sqlite')
check(
  'SQLite 的例程提示不谎称"驱动未提供"',
  sqliteRoutineWarn.warnings.some((w) => w.includes('SQLite') && w.includes('不适用')) &&
    !sqliteRoutineWarn.warnings.some((w) => w.includes('当前驱动没有提供例程清单')),
  JSON.stringify(sqliteRoutineWarn.warnings)
)

console.log(`\n结构比较 ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
