/**
 * MySQL / MariaDB 驱动契约测试（P6.2 Step 1：只读 + 元数据 + 执行）。
 *
 * 跑法：
 *   DBSTUDIO_MYSQL_URL 风格的五个环境变量（默认指向本机 13306 容器）：
 *     MYSQL_HOST=127.0.0.1 MYSQL_PORT=13306 MYSQL_USER=root MYSQL_PASSWORD=rootpw MYSQL_DATABASE=testdb
 *   或者设置 DBSTUDIO_MYSQL=1 表示"环境已就绪，跑真实断言"。
 *
 * 用真实的 MySQL（不是 mock）：驱动最怕"模拟测试全绿、真库一跑就崩"。
 * 没有可用 MySQL 时，明确 SKIP 并退出 0，绝不假装通过。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createConnection } from 'mysql2/promise'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const host = process.env.MYSQL_HOST ?? '127.0.0.1'
const port = Number(process.env.MYSQL_PORT ?? 13306)
const user = process.env.MYSQL_USER ?? 'root'
const password = process.env.MYSQL_PASSWORD ?? 'rootpw'
const database = process.env.MYSQL_DATABASE ?? 'testdb'

let pass = 0
let fail = 0
let skip = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const skipCheck = (name, reason) => {
  skip += 1
  console.log(`  ⏭️  SKIP ${name}（${reason}）`)
}

/** 先探测 MySQL 是否可达；不可达就 SKIP 整个文件。 */
async function probeReachable() {
  let conn = null
  try {
    conn = await createConnection({ host, port, user, password, connectTimeout: 4000 })
    await conn.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    if (conn) await conn.end().catch(() => undefined)
  }
}

async function seed(admin) {
  const stmts = [
    'DROP TABLE IF EXISTS emp',
    'DROP TABLE IF EXISTS dept',
    `CREATE TABLE dept (
       id INT AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(50) NOT NULL,
       UNIQUE KEY uq_dept_name (name)
     ) ENGINE=InnoDB`,
    `CREATE TABLE emp (
       id INT AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(50) NOT NULL,
       dept_id INT NULL,
       salary DECIMAL(10,2) NULL,
       bio TEXT NULL,
       photo BLOB NULL,
       KEY idx_emp_name (name),
       CONSTRAINT fk_emp_dept FOREIGN KEY (dept_id) REFERENCES dept(id)
     ) ENGINE=InnoDB`,
    `INSERT INTO dept (name) VALUES ('研发'), ('销售')`,
    `INSERT INTO emp (name, dept_id, salary, bio, photo) VALUES
       ('张三', 1, 12000.50, '资深工程师', X'0102'),
       ('李四', 2, 9000.00, NULL, NULL),
       ('王五', 1, 15000.00, '架构师', NULL)`
  ]
  for (const sql of stmts) await admin.query(sql)
}

const reachable = await probeReachable()
if (!reachable) {
  console.log(`\nMySQL 不可达（${host}:${port}），跳过真实断言。`)
  skipCheck('MySQL 契约测试', `${host}:${port} 无法连接`)
  console.log(`\nMySQL 契约：${pass} 通过 / ${fail} 失败 / ${skip} 跳过`)
  process.exit(0)
}

// ---- 准备：建夹具 ----
const admin = await createConnection({ host, port, user, password, database, multipleStatements: false })
await seed(admin)
await admin.end()

// ---- 打包探针（复用主进程 + 驱动宿主）----
const work = mkdtempSync(join(tmpdir(), 'dbstudio-mysql-contract-'))
const probeDir = mkdtempSync(join(root, 'out', 'mysql-probe-'))
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir: probeDir,
    target: 'node22',
    ssr: true,
    minify: false,
    lib: { entry: resolve(root, 'tests/probe-entry.ts'), formats: ['cjs'] },
    rollupOptions: { external: [/^node:/, 'electron', 'mysql2', 'pg', 'ssh2', 'ioredis', 'kafkajs'], output: { entryFileNames: 'probe.cjs' } }
  }
})
const { createManagerWithBuiltinDialects } = await import(pathToFileURL(join(probeDir, 'probe.cjs')).href)

const manager = createManagerWithBuiltinDialects()
const conn = await manager.add(
  { dialectId: 'mysql', name: 'mysql-contract', options: { host, port: String(port), database, user } },
  { dbPassword: password }
)

try {
  console.log('\n[1] 连接与能力')
  const summary = await manager.connectConnection(conn.id)
  check('能连上 MySQL', summary.connected === true)
  check('声明服务端分页能力', summary.capabilities?.supportsServerPagination === true)
  check('声明取消能力', summary.capabilities?.supportsCancel === true)
  check('声明 schema（database 作为命名空间）', summary.capabilities?.hasSchema === true)
  check('当前阶段不声明网格编辑', summary.capabilities?.supportsInlineEdit === false)

  const rootId = `connection:${conn.id}`

  console.log('\n[2] 目录浏览')
  const roots = await manager.listChildren(rootId)
  check('根节点是「数据库」分组', roots.length === 1 && roots[0].name === '数据库', JSON.stringify(roots.map((r) => r.name)))
  const schemas = await manager.listChildren(roots[0].id)
  check('能列出 testdb', schemas.some((s) => s.name === database), JSON.stringify(schemas.map((s) => s.name)))
  check('隐藏系统库 information_schema', !schemas.some((s) => s.name === 'information_schema'))
  const dbNode = schemas.find((s) => s.name === database)
  const folders = await manager.listChildren(dbNode.id)
  check('database 下有表/视图分组', folders.map((f) => f.name).join(',') === '表,视图', folders.map((f) => f.name).join(','))
  const tablesFolder = folders.find((f) => f.name === '表')
  const tables = await manager.listChildren(tablesFolder.id)
  const names = tables.map((t) => t.name)
  check('列出 dept / emp', names.includes('dept') && names.includes('emp'), names.join(','))
  const empNode = tables.find((t) => t.name === 'emp')
  const cols = await manager.listChildren(empNode.id)
  check('展开表能列出列', cols.some((c) => c.name === 'salary') && cols.some((c) => c.name === 'photo'), cols.map((c) => c.name).join(','))

  console.log('\n[3] 表结构元数据')
  const deptDesc = await manager.describeTable(tables.find((t) => t.name === 'dept').id)
  check('dept 列数 = 2', deptDesc.columns.length === 2, String(deptDesc.columns.length))
  check('dept.id 是主键', deptDesc.columns.find((c) => c.name === 'id')?.primaryKeyOrdinal === 1)
  check('dept.name NOT NULL', deptDesc.columns.find((c) => c.name === 'name')?.nullable === false)
  check('dept 有唯一键', deptDesc.hasUniqueKey === true)
  check('dept 读到唯一约束 uq_dept_name（uniqueConstraints 字段，不靠 indexes 兜底）',
    (deptDesc.uniqueConstraints ?? []).some((c) => c.name === 'uq_dept_name' && c.columns.join(',') === 'name'), JSON.stringify(deptDesc.uniqueConstraints))

  const empDesc = await manager.describeTable(empNode.id)
  check('emp 列数 = 6', empDesc.columns.length === 6, String(empDesc.columns.length))
  check('emp.id auto_increment 识别为身份列', empDesc.columns.find((c) => c.name === 'id')?.identity === 'by-default')
  const fk = (empDesc.foreignKeys ?? []).find((f) => f.name === 'fk_emp_dept')
  check('emp 读到外键 fk_emp_dept', Boolean(fk))
  check('外键指向 dept.id', fk?.referencedTable === 'dept' && fk?.columns.includes('dept_id'), JSON.stringify(fk))
  const idx = (empDesc.indexes ?? []).find((i) => i.name === 'idx_emp_name')
  check('emp 读到普通索引 idx_emp_name', Boolean(idx) && idx?.unique === false)

  console.log('\n[3b] 表名限定与预览（多库正确性）')
  const selSql = await manager.tableSelectSql(empNode.id)
  check('tableSelectSql 带 database 限定（`db`.`emp`）', selSql.includes('`' + database + '`') && selSql.includes('`emp`'), selSql)
  const preview = await manager.previewTable(empNode.id, 5)
  check('previewTable 能在非 information_schema 库取到数据', preview.rows.length === 3, String(preview.rows.length))

  console.log('\n[4] 查询与分页')
  const first = await manager.runQuery(`connection:${conn.id}`, 'SELECT id, name, salary FROM emp ORDER BY id', { limit: 2 })
  check('首屏返回 2 行', first.rows.length === 2, String(first.rows.length))
  check('首屏列名正确', first.columns.map((c) => c.name).join(',') === 'id,name,salary')
  check('hasMore 为 true', first.hasMore === true)
  // DECIMAL 走字符串返回（mysql2 默认 + 我们保留），刻意不转 JS number：金额/大数
  // 转 double 会引入浮点误差。文档与 UI 都按"高精度文本"对待。
  check('salary 保留精度（文本 12000.50）', first.rows[0].cells[2]?.kind === 'text' && first.rows[0].cells[2]?.text === '12000.50', JSON.stringify(first.rows[0].cells[2]))
  const page2 = await manager.fetchResultPage(first.cursorId, 2, 2)
  check('第 2 页 offset=2 返回 1 行', page2.rows.length === 1 && page2.rows[0].index === 2, JSON.stringify(page2.rows.map((r) => r.index)))
  await manager.closeCursor(first.cursorId)

  console.log('\n[5] 语句执行')
  const ddl = await manager.executeStatement(`connection:${conn.id}`, 'CREATE TABLE tmp_contract (id INT PRIMARY KEY, note VARCHAR(20))')
  check('CREATE TABLE 走 affected 分支', ddl.kind === 'affected', ddl.kind)
  const ins = await manager.executeStatement(`connection:${conn.id}`, "INSERT INTO tmp_contract (id, note) VALUES (1, 'ok')")
  check('INSERT 影响 1 行', ins.kind === 'affected' && ins.affected === 1, JSON.stringify(ins).slice(0, 80))
  const sel = await manager.executeStatement(`connection:${conn.id}`, 'SELECT note FROM tmp_contract')
  check('SELECT 走 rows 分支', sel.kind === 'rows' && sel.result.rows[0].cells[0].text === 'ok')
  await manager.executeStatement(`connection:${conn.id}`, 'DROP TABLE tmp_contract')

  console.log('\n[6] 执行计划')
  const plan = await manager.explain(`connection:${conn.id}`, 'SELECT * FROM emp WHERE id = 1')
  check('EXPLAIN 返回表格形式', plan.format === 'tabular')
  check('EXPLAIN 有行', plan.rows.length >= 1, String(plan.rows.length))

  console.log('\n[7] 未实现方法如实拒绝（不是半实现）')
  let txErr = null
  try {
    // commitTransaction 不经过"空更新"前置校验，会直达 adapter —— 用它验证
    // adapter 对未实现能力确实抛 unsupported_method，而不是假装成功。
    await manager.commitTransaction(`connection:${conn.id}`)
  } catch (e) {
    txErr = e
  }
  check('事务提交抛 unsupported_method', Boolean(txErr) && /unsupported_method|暂不支持/.test(String(txErr?.message ?? txErr)))
} finally {
  await manager.disconnectConnection(conn.id).catch(() => undefined)
  rmSync(probeDir, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}

console.log(`\nMySQL 契约：${pass} 通过 / ${fail} 失败 / ${skip} 跳过`)
if (fail > 0) process.exitCode = 1
