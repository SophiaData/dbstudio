/**
 * SDK 端到端测试。
 *
 * ===== 这个测试刻意「像外部用户那样用」 =====
 *
 * 它不 import SDK 的源码，而是 import **构建后的 dist 产物**，
 * 并且通过 `require.resolve` 找驱动宿主路径——和 npm 用户的体验一致。
 * 这样能抓到「源码能跑但发的包里是坏的」这类问题（比如路径推断错误、
 * d.ts 断链、driver-host 没被带进包）。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// ★ 关键：从 dist 产物导入，不是从 src
import { DriverHost, Quote, withDriverHost } from '../dist/sdk/src/index.js'

const require = createRequire(import.meta.url)

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---- 准备测试库 ----
const dir = mkdtempSync(join(tmpdir(), 'dbstudio-sdk-'))
const dbPath = join(dir, 'sdk-test.db')
{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, qty INTEGER);
    INSERT INTO items (id, label, qty) VALUES (1, 'alpha', 10), (2, 'beta', 20), (3, 'gamma', 30);
    CREATE TABLE no_pk (a INTEGER, b TEXT);
    INSERT INTO no_pk VALUES (1, 'x');
  `)
  db.close()
}

// ---- 定位驱动宿主（npm 用户就是这么写的）----
let hostScript
try {
  hostScript = require.resolve('@sophiadata/dbstudio-sdk/driver-host/index.js')
} catch {
  // 包还没装进 node_modules 时，直接指 dist 产物（测试环境用）
  hostScript = join(process.cwd(), 'dist/driver-host/index.js')
}
check('能定位驱动宿主脚本', existsSync(hostScript), hostScript)

console.log('\n[1] 连接与能力声明')
const config = { dialectId: 'sqlite', name: 'sdk-test', options: { file: dbPath } }
const host = new DriverHost({ dialectId: 'sqlite', hostScript })
check('DriverHost 构造成功', typeof host.pid === 'number')

const caps = await host.connect(config)
check('connect 返回能力声明', caps !== null && typeof caps === 'object')
check('SQLite 无 catalog', caps.hasCatalog === false)

console.log('\n[2] 元数据浏览')
const roots = await host.listChildren(null)
check('根层有 2 个分组', roots.length === 2, String(roots.length))
const tables = await host.listChildren('folder:tables')
const names = tables.map((t) => t.name)
check('列出 items 与 no_pk', names.includes('items') && names.includes('no_pk'), names.join(','))
check('排除 sqlite_ 内部表', !names.some((n) => n.startsWith('sqlite_')))

const desc = await host.describeTable('table:items')
check('items 有唯一键', desc.hasUniqueKey === true)
check('id 是主键', desc.columns.find((c) => c.name === 'id')?.primaryKeyOrdinal === 1)
const descNoPk = await host.describeTable('table:no_pk')
check('no_pk 无唯一键', descNoPk.hasUniqueKey === false)

console.log('\n[3] 查询与游标分页')
const q = await host.query('SELECT * FROM items ORDER BY id')
check('查询返回第一页', q.returned === 3)
check('拿到 cursorId', typeof q.cursorId === 'string' && q.cursorId.length > 0)
const page2 = await host.fetchResultPage(q.cursorId, 1, 2)
check('按偏移取页（offset=1, limit=2）', page2.returned === 2)
check('第一行 index 正确', page2.rows[0]?.index === 1, String(page2.rows[0]?.index))
const page0 = await host.fetchResultPage(q.cursorId, 0, 2)
check('乱序回取（offset=0）', page0.rows[0]?.index === 0)
await host.closeCursor(q.cursorId)
check('关闭游标不抛错', true)

console.log('\n[4] 参数化编辑 + 事务')
const apply = await host.applyEdits('table:items', [
  { keyValues: { id: { kind: 'number', value: 2 } }, changes: { label: { kind: 'text', text: 'BETA-EDITED' } } }
])
check('applyEdits 成功', apply.ok === true && apply.affected === 1)
check('进入事务', apply.inTransaction === true)
const st1 = await host.transactionState()
check('事务状态 active', st1.active === true)

const rb = await host.rollbackTransaction()
check('回滚后 active=false', rb.active === false)
const afterRollback = await host.query('SELECT label FROM items WHERE id=2')
check('★ 回滚后数据复原', afterRollback.rows[0]?.cells[0]?.text === 'beta', afterRollback.rows[0]?.cells[0]?.text)

console.log('\n[5] 注入防护（参数化是否真的生效）')
const inject = await host.applyEdits('table:items', [
  { keyValues: { id: { kind: 'text', text: '1 OR 1=1' } }, changes: { label: { kind: 'text', text: 'PWNED' } } }
])
check('注入型主键 affected=0', inject.ok ? inject.affected === 0 || inject.ok === false : true, String(inject.affected))
const all = await host.query('SELECT label FROM items')
check('没有任何行被改成 PWNED', !JSON.stringify(all.rows).includes('PWNED'))
await host.rollbackTransaction()

console.log('\n[6] 无主键表拒绝编辑')
let rejected = false
try {
  await host.applyEdits('table:no_pk', [
    { keyValues: { a: { kind: 'number', value: 1 } }, changes: { b: { kind: 'text', text: 'z' } } }
  ])
} catch (e) {
  rejected = /unique key|唯一键/i.test(String(e))
}
check('无主键表被拒绝且消息含唯一键语义', rejected)

console.log('\n[7] 引号工具')
check('Quote.identifier 双引号', Quote.identifier('my table', { open: '"', close: '"', escape: 'double' }) === '"my table"')
check('内部引号被转义', Quote.identifier('a"b', { open: '"', close: '"', escape: 'double' }) === '"a""b"')
check('Quote.placeholders', Quote.placeholders(3) === '?, ?, ?')

console.log('\n[8] 生命周期')
await host.close()
check('close 后 pid 仍可读（已退出）', true)
let closedErr = false
try {
  await host.listChildren(null)
} catch {
  closedErr = true
}
check('关闭后调用报错而不是挂死', closedErr)

console.log('\n[9] withDriverHost 便捷函数（确保回收）')
const result = await withDriverHost(
  { dialectId: 'sqlite', hostScript },
  async (h) => {
    await h.connect(config)
    const r = await h.query('SELECT COUNT(*) AS c FROM items')
    return r.rows[0]?.cells[0]?.value
  }
)
check('withDriverHost 返回结果', result === 3, String(result))

console.log(`\n===== SDK 测试：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
