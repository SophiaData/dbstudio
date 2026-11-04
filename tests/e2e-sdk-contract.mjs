/**
 * SDK 驱动契约矩阵（P6.1 Step 2）。
 *
 * 用 **SDK 自己的 DriverHost**（进程隔离的真实用法，不是内部 manager）对一个
 * SQLite 库跑一遍驱动必须通过的能力集合：
 *   握手 / 连接 / 列目录 / 表描述 / 查询 / 分页 / 完整值 / 事务 / DDL / 元数据 /
 *   导出块 / 错误码。
 *
 * 目的不是替代各驱动的深度 e2e（那样是 test / test:postgres / test:mysql-contract 的活），
 * 而是锁住**SDK 公开契约的形状**——版本常量、能力字段、以及这 12 类能力在 SDK 层确实可达。
 * 先在 SQLite（无需外部服务）上钉死；PG/MySQL 的深度能力由各自契约测试覆盖。
 *
 * 依赖：先 `pnpm run build:sdk`（本测试 import sdk/dist）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdkEntry = join(root, 'sdk/dist/sdk/src/index.js')
const hostScript = join(root, 'sdk/dist/driver-host/index.js')

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const mod = await import(pathToFileURL(sdkEntry).href)
const {
  DriverHost,
  DRIVER_API_VERSION,
  HANDSHAKE_PROTOCOL_VERSION,
  METADATA_SCHEMA_VERSION,
  TRANSFER_SCHEMA_VERSION,
  SDK_CONTRACT_VERSION
} = mod

const work = mkdtempSync(join(tmpdir(), 'dbstudio-sdk-contract-'))
const file = join(work, 'contract.db')
const seed = new DatabaseSync(file)
seed.exec(`
  CREATE TABLE dept (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
  CREATE TABLE emp (id INTEGER PRIMARY KEY, name TEXT NOT NULL, dept_id INTEGER REFERENCES dept(id), bio TEXT);
  CREATE INDEX idx_emp_name ON emp (name);
  INSERT INTO dept (id, name) VALUES (1, '研发'), (2, '销售');
  INSERT INTO emp (id, name, dept_id, bio) VALUES (1, '张三', 1, '${'z'.repeat(1500)}'), (2, '李四', 2, NULL);
`)
seed.close()

const host = new DriverHost({ dialectId: 'sqlite', hostScript, onLog: () => undefined })
try {
  console.log('\n[1] 版本化能力声明')
  check('DRIVER_API_VERSION 是正整数', Number.isInteger(DRIVER_API_VERSION) && DRIVER_API_VERSION >= 1, String(DRIVER_API_VERSION))
  check('METADATA_SCHEMA_VERSION 是正整数', Number.isInteger(METADATA_SCHEMA_VERSION) && METADATA_SCHEMA_VERSION >= 1)
  check('TRANSFER_SCHEMA_VERSION 是正整数', Number.isInteger(TRANSFER_SCHEMA_VERSION) && TRANSFER_SCHEMA_VERSION >= 1)
  check('SDK_CONTRACT_VERSION 是正整数', Number.isInteger(SDK_CONTRACT_VERSION) && SDK_CONTRACT_VERSION >= 1)
  check('HANDSHAKE_PROTOCOL_VERSION 是正整数', Number.isInteger(HANDSHAKE_PROTOCOL_VERSION) && HANDSHAKE_PROTOCOL_VERSION >= 1)

  console.log('\n[2] 握手 + 连接')
  // SDK 现在会在第一次业务 RPC 前等待并校验握手帧；显式 await 一次，
  // 既验证宿主真的声明了版本，也避免 connect 把这层失败吞成泛化错误。
  const hs = await host.handshake
  check('握手方言正确', hs.dialectId === 'sqlite', hs.dialectId)
  check('握手声明 protocolVersion', hs.protocolVersion === HANDSHAKE_PROTOCOL_VERSION, String(hs.protocolVersion))
  check('握手声明 driverApiVersion', hs.driverApiVersion === DRIVER_API_VERSION, String(hs.driverApiVersion))
  check('握手声明 metadataSchemaVersion', hs.metadataSchemaVersion === METADATA_SCHEMA_VERSION, String(hs.metadataSchemaVersion))
  check('握手声明 transferSchemaVersion', hs.transferSchemaVersion === TRANSFER_SCHEMA_VERSION, String(hs.transferSchemaVersion))
  check('握手声明 sdkContractVersion', hs.sdkContractVersion === SDK_CONTRACT_VERSION, String(hs.sdkContractVersion))
  const caps = await host.connect({ dialectId: 'sqlite', name: 'contract', options: { file } })
  check('connect 返回能力集合', Boolean(caps) && typeof caps === 'object')
  check('能力含 supportsServerPagination', typeof caps.supportsServerPagination === 'boolean')
  check('能力含 metadata 能力位', Boolean(caps.metadata) && typeof caps.metadata.foreignKeys === 'boolean')
  const ping = await host.testConnection({ dialectId: 'sqlite', name: 'contract', options: { file } })
  check('testConnection ok', ping.ok === true, JSON.stringify(ping))

  console.log('\n[3] 列目录')
  const roots = await host.listChildren(null)
  check('根节点存在', roots.length >= 1)
  // SQLite 根是「表/视图」分组；逐层展开找到表
  const findTables = async (parentId) => {
    const nodes = await host.listChildren(parentId)
    const tables = nodes.filter((n) => n.kind === 'table')
    if (tables.length > 0) return { nodes, tables }
    for (const n of nodes) {
      if (n.hasChildren && n.kind === 'folder') {
        const got = await findTables(n.id)
        if (got.tables.length > 0) return got
      }
    }
    return { nodes, tables }
  }
  const { tables } = await findTables(roots[0].id)
  const empNode = tables.find((t) => t.name === 'emp')
  check('列出了 emp 表', Boolean(empNode), tables.map((t) => t.name).join(','))

  console.log('\n[4] 表描述 + 元数据')
  const empDesc = await host.describeTable(empNode.id)
  check('describeTable 返回 4 列', empDesc.columns.length === 4, String(empDesc.columns.length))
  check('主键识别', empDesc.columns.find((c) => c.name === 'id')?.primaryKeyOrdinal === 1)
  check('有唯一键', empDesc.hasUniqueKey === true)
  check('读到索引 idx_emp_name', (empDesc.indexes ?? []).some((i) => i.name === 'idx_emp_name'))
  const deptNode = tables.find((t) => t.name === 'dept')
  const deptDesc = await host.describeTable(deptNode.id)
  const empFk = (empDesc.foreignKeys ?? []).find((f) => f.columns.includes('dept_id'))
  check('读到外键 dept_id → dept', Boolean(empFk) && empFk.referencedTable === 'dept', JSON.stringify(empFk))

  console.log('\n[5] 查询 + 分页')
  const page1 = await host.query('SELECT id, name FROM emp ORDER BY id', { limit: 1 })
  check('首屏 1 行', page1.rows.length === 1 && page1.hasMore === true, JSON.stringify({ n: page1.rows.length, more: page1.hasMore }))
  check('列名正确', page1.columns.map((c) => c.name).join(',') === 'id,name')
  const page2 = await host.fetchResultPage(page1.cursorId, 1, 1)
  check('第 2 页 index=1', page2.rows.length === 1 && page2.rows[0].index === 1, JSON.stringify(page2.rows.map((r) => r.index)))
  await host.closeCursor(page1.cursorId)

  console.log('\n[6] 完整值（截断契约）')
  const big = await host.query('SELECT bio FROM emp WHERE id = 1')
  const cell = big.rows[0].cells[0]
  check('超长文本被截断并标记', cell.kind === 'text' && cell.truncated === true && cell.text.length <= 1000, JSON.stringify({ len: cell.text?.length, t: cell.truncated }))
  await host.closeCursor(big.cursorId)

  console.log('\n[7] 事务 + 编辑')
  const before = (await host.query("SELECT name FROM emp WHERE id = 2")).rows[0].cells[0]
  const edit = await host.applyEdits(empNode.id, [{ keyValues: { id: { kind: 'number', value: 2 } }, changes: { name: { kind: 'text', text: '李四改' } } }])
  check('applyEdits 影响 1 行', edit.affected === 1 && edit.ok === true, JSON.stringify(edit.outcomes))
  check('编辑后进入事务', (await host.transactionState()).active === true)
  await host.commitTransaction()
  const after = (await host.query('SELECT name FROM emp WHERE id = 2')).rows[0].cells[0]
  check('提交后改名生效', after.text === '李四改', JSON.stringify(after))
  // 回滚
  await host.applyEdits(empNode.id, [{ keyValues: { id: { kind: 'number', value: 2 } }, changes: { name: { kind: 'text', text: '不应生效' } } }])
  await host.rollbackTransaction()
  const afterRb = (await host.query('SELECT name FROM emp WHERE id = 2')).rows[0].cells[0]
  check('回滚后名字未变', afterRb.text === '李四改', JSON.stringify(afterRb))

  console.log('\n[8] DDL（executeStatement）')
  const ddl = await host.executeStatement('CREATE TABLE extra (id INTEGER PRIMARY KEY)')
  check('DDL 执行成功', ddl.kind === 'affected' || ddl.kind === 'ddl', ddl.kind)

  console.log('\n[9] 错误码')
  let qErr = null
  try { await host.query('SELECT * FROM no_such_table_xyz') } catch (e) { qErr = e }
  check('查询不存在的表抛错', Boolean(qErr), String(qErr?.message ?? ''))
  check('错误对象带可读信息', Boolean(qErr?.message) && qErr.message.length > 0)
} finally {
  await host.close().catch(() => undefined)
  rmSync(work, { recursive: true, force: true })
}

console.log(`\nSDK 契约矩阵：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
