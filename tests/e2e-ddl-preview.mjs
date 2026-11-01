/** DDL 预览纯逻辑契约：不连接数据库、不执行 SQL。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dbstudio-ddl-preview-'))
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
    lib: { entry: resolve(root, 'src/core/ddl.ts'), formats: ['cjs'] },
    rollupOptions: { output: { entryFileNames: 'ddl.cjs' } }
  }
})
const ddl = await import(pathToFileURL(join(work, 'ddl.cjs')).href)
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
const expectThrow = (name, fn) => {
  try {
    fn()
  } catch (error) {
    check(name, true, error?.message ?? String(error))
    return error
  }
  check(name, false, '没有抛出错误')
  return null
}

const table = ddl.previewDdl({
  kind: 'create-table',
  target: { schema: 'public', name: 'users' },
  spec: {
    name: 'users',
    columns: [
      { name: 'id', typeName: 'INTEGER', nullable: false, primaryKeyOrdinal: 1 },
      { name: 'email', typeName: 'TEXT', nullable: false, defaultValue: "''" }
    ]
  }
}, 'postgresql')
check('create-table 生成 schema 限定 SQL', table.statements[0]?.includes('CREATE TABLE "public"."users"'))
check('create-table 生成主键与默认值', table.statements[0]?.includes('PRIMARY KEY ("id")') && table.statements[0]?.includes("DEFAULT ''"))
check('create-table 默认不标记 destructive', table.destructive === false)
check('无主键表给出编辑风险提示', ddl.previewDdl({
  kind: 'create-table', target: { name: 'logs' }, spec: { name: 'logs', columns: [{ name: 'message', typeName: 'TEXT' }] }
}, 'sqlite').warnings.some((x) => x.includes('主键')))

const altered = ddl.previewDdl({
  kind: 'alter-table',
  target: { name: 'users' },
  changes: [
    { kind: 'add-column', column: { name: 'age', typeName: 'INTEGER' } },
    { kind: 'rename-column', oldName: 'email', newName: 'address' },
    { kind: 'drop-column', columnName: 'legacy' }
  ]
}, 'postgresql')
check('alter-table 为每个变更生成确定顺序的语句', altered.statements.length === 3 && altered.statements[0]?.includes('ADD COLUMN'))
check('删列标记 destructive', altered.destructive && altered.warnings.some((x) => x.includes('永久丢失')))
const sqliteAlter = ddl.previewDdl({
  kind: 'alter-table', target: { name: 'users' },
  changes: [{ kind: 'alter-column', columnName: 'age', typeName: 'TEXT' }]
}, 'sqlite')
check('SQLite 改列给出重建表说明', sqliteAlter.requiresTransaction && sqliteAlter.warnings.some((x) => x.includes('重建表')))

const index = ddl.previewDdl({
  kind: 'create-index', target: { schema: 'public', name: 'users' },
  index: { name: 'users_email_uq', unique: true, columns: ['email'], predicate: 'email IS NOT NULL' }
}, 'postgresql')
check('create-index 生成唯一索引与 predicate', index.statements[0]?.includes('CREATE UNIQUE INDEX') && index.statements[0]?.includes('WHERE email IS NOT NULL'))

const fk = ddl.previewDdl({
  kind: 'create-foreign-key', target: { name: 'orders' },
  foreignKey: {
    name: 'orders_user_fk', columns: ['user_id'], referencedSchema: 'public', referencedTable: 'users',
    referencedColumns: ['id'], onDelete: 'CASCADE'
  }
}, 'postgresql')
check('create-foreign-key 保留名称/schema/动作', fk.statements[0]?.includes('CONSTRAINT "orders_user_fk"') && fk.statements[0]?.includes('REFERENCES "public"."users"') && fk.statements[0]?.includes('ON DELETE CASCADE'))
const sqliteFk = ddl.previewDdl({
  kind: 'create-foreign-key', target: { name: 'orders' },
  foreignKey: { columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'] }
}, 'sqlite')
check('SQLite 外键预览提示需要重建表', sqliteFk.requiresTransaction && sqliteFk.warnings.length === 1)

const drop = ddl.previewDdl({ kind: 'drop-object', objectType: 'table', target: { schema: 'public', name: 'users' } }, 'postgresql')
check('drop-object 生成 DROP TABLE', drop.statements[0] === 'DROP TABLE "public"."users"')
check('删表给出不可逆警告', drop.destructive && drop.warnings[0]?.includes('全部数据'))

check('恶意标识符只作为被 quote 的名字', ddl.previewDdl({ kind: 'drop-object', objectType: 'table', target: { name: 'x"; DROP TABLE y;--' } }, 'sqlite').statements[0]?.includes('"x""; DROP TABLE y;--"'))
expectThrow('恶意类型片段被拒绝', () => ddl.previewDdl({
  kind: 'create-table', target: { name: 'x' }, spec: { name: 'x', columns: [{ name: 'v', typeName: 'TEXT); DROP TABLE y;--' }] }
}, 'sqlite'))
expectThrow('空变更被拒绝', () => ddl.previewDdl({ kind: 'alter-table', target: { name: 'x' }, changes: [] }, 'sqlite'))
expectThrow('复合外键列数不一致被拒绝', () => ddl.previewDdl({
  kind: 'create-foreign-key', target: { name: 'x' }, foreignKey: { columns: ['a', 'b'], referencedTable: 'y', referencedColumns: ['id'] }
}, 'sqlite'))
check('同一操作输出稳定', JSON.stringify(ddl.previewDdl({
  kind: 'create-index', target: { name: 't' }, index: { name: 'idx', unique: false, columns: ['a', 'b'] }
}, 'sqlite')) === JSON.stringify(ddl.previewDdl({
  kind: 'create-index', target: { name: 't' }, index: { name: 'idx', unique: false, columns: ['a', 'b'] }
}, 'sqlite')))

console.log(`\nDDL 预览纯逻辑契约：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
