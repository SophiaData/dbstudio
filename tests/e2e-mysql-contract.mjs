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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
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
       CONSTRAINT fk_emp_dept FOREIGN KEY (dept_id) REFERENCES dept(id),
       CONSTRAINT chk_emp_salary CHECK (salary IS NULL OR salary >= 0)
     ) ENGINE=InnoDB`,
    'DROP TRIGGER IF EXISTS trg_emp_bi',
    `CREATE TRIGGER trg_emp_bi BEFORE INSERT ON emp
       FOR EACH ROW SET NEW.name = TRIM(NEW.name)`,
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
const { createManagerWithBuiltinDialects, diffSchema } = await import(pathToFileURL(join(probeDir, 'probe.cjs')).href)

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
  check('已声明网格编辑能力（Step 3）', summary.capabilities?.supportsInlineEdit === true)

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

  console.log('\n[7] DDL 事务保护')
  // MySQL 的 DDL 会隐式提交事务。有未提交编辑时必须拒绝，而不是把用户改动一起提交。
  await manager.applyEdits(empNode.id, [
    { keyValues: { id: { kind: 'number', value: 1 } }, changes: { name: { kind: 'text', text: '张三' } } }
  ])
  let guardErr = null
  try {
    await manager.dropTable(empNode.id)
  } catch (e) {
    guardErr = e
  }
  check('有未提交事务时 DDL 被拒绝', Boolean(guardErr) && /未提交|事务/.test(String(guardErr?.message ?? guardErr)), String(guardErr?.message ?? guardErr))
  await manager.rollbackTransaction(`connection:${conn.id}`)
  check('回滚后事务结束', (await manager.transactionState(`connection:${conn.id}`)).active === false)
  check('表没有被误删', (await manager.countRows(empNode.id)) === 3)
  console.log('\n[8] 写入与事务（真实 MySQL）')
  const ins2 = await manager.insertRow(empNode.id, {
    name: { kind: 'text', text: '赵六' },
    dept_id: { kind: 'number', value: 1 },
    salary: { kind: 'text', text: '8000.00' }
  })
  check('insertRow 受影响 1 行', ins2.affected === 1, JSON.stringify(ins2))
  const newId = ins2.keyValues.id?.kind === 'number' ? ins2.keyValues.id.value : null
  check('insertRow 回填自增主键', typeof newId === 'number' && newId > 0, JSON.stringify(ins2.keyValues))

  const edit = await manager.applyEdits(empNode.id, [
    { keyValues: { id: { kind: 'number', value: newId } }, changes: { name: { kind: 'text', text: '赵六改' } } }
  ])
  check('applyEdits 影响 1 行且全部成功', edit.affected === 1 && edit.ok === true, JSON.stringify(edit.outcomes))
  const tx = await manager.transactionState(`connection:${conn.id}`)
  check('编辑后处于未提交事务', tx.active === true, JSON.stringify(tx))
  await manager.commitTransaction(`connection:${conn.id}`)
  const verifyEdit = await manager.runQuery(`connection:${conn.id}`, `SELECT name FROM emp WHERE id = ${newId}`)
  check('提交后改名生效', verifyEdit.rows[0]?.cells[0]?.text === '赵六改', JSON.stringify(verifyEdit.rows[0]?.cells))

  await manager.applyEdits(empNode.id, [
    { keyValues: { id: { kind: 'number', value: newId } }, changes: { name: { kind: 'text', text: '不应生效' } } }
  ])
  await manager.rollbackTransaction(`connection:${conn.id}`)
  const afterRollback = await manager.runQuery(`connection:${conn.id}`, `SELECT name FROM emp WHERE id = ${newId}`)
  check('回滚后名字未变（事务生效）', afterRollback.rows[0]?.cells[0]?.text === '赵六改', JSON.stringify(afterRollback.rows[0]?.cells))

  let emptyDelErr = null
  try { await manager.deleteRows(empNode.id, []) } catch (e) { emptyDelErr = e }
  check('空删除条件被拒绝', Boolean(emptyDelErr) && /为空|拒绝|空删除/.test(String(emptyDelErr?.message ?? '')))

  const cnt = await manager.countRows(empNode.id)
  check('countRows 正确（4 行）', cnt === 4, String(cnt))
  const del = await manager.deleteRows(empNode.id, [{ id: { kind: 'number', value: newId } }])
  check('deleteRows 影响 1 行', del.affected === 1, JSON.stringify(del.outcomes))
  await manager.commitTransaction(`connection:${conn.id}`)
  const cnt2 = await manager.countRows(empNode.id)
  check('删除并提交后计数回到 3', cnt2 === 3, String(cnt2))

  console.log('\n[9] 完整单元格值')
  await manager.executeStatement(`connection:${conn.id}`, "INSERT INTO emp (name, bio) VALUES ('长文', REPEAT('y', 1500))")
  const longQ = await manager.runQuery(`connection:${conn.id}`, "SELECT bio FROM emp WHERE name = '长文'")
  const firstCell = longQ.rows[0]?.cells[0]
  check('首屏 bio 被截断到 1000', firstCell?.kind === 'text' && firstCell?.truncated === true && firstCell.text.length === 1000, JSON.stringify({ len: firstCell?.text?.length, t: firstCell?.truncated }))
  const full = await manager.fetchCellValue(longQ.cursorId, 0, 0)
  check('fetchCellValue 取回完整 1500', full.kind === 'text' && full.text.length === 1500 && full.truncated !== true, JSON.stringify({ len: full.text?.length }))
  await manager.closeCursor(longQ.cursorId)
  await manager.executeStatement(`connection:${conn.id}`, "DELETE FROM emp WHERE name = '长文'")

  console.log('\n[10] 导出（走 resolveTransferSource）')
  const exportPath = join(work, 'emp-export.csv')
  const task = manager.startTransfer({ source: { nodeId: empNode.id, connectionId: conn.id }, format: 'csv', destinationPath: exportPath })
  const tr = await manager.waitTransfer(task.taskId)
  check('导出任务成功', tr.status === 'completed', tr.status)
  check('导出 CSV 非空', tr.bytesWritten > 0, String(tr.bytesWritten))

  console.log('\n[11] 参数绑定（? 占位符）')
  const paramRows = await manager.runQuery(
    `connection:${conn.id}`,
    'SELECT name FROM emp WHERE salary > ? ORDER BY id',
    { parameters: [{ name: '?1', value: 10000 }], limit: 10 }
  )
  check('参数绑定按值过滤（2 行）', paramRows.rows.length === 2, String(paramRows.rows.length))
  const injection = await manager.runQuery(
    `connection:${conn.id}`,
    'SELECT id FROM emp WHERE name = ?',
    { parameters: [{ name: '?1', value: "' OR 1=1 --" }], limit: 10 }
  )
  check('注入 payload 走参数化后匹配 0 行', injection.rows.length === 0, String(injection.rows.length))
  let missingParamErr = null
  try {
    await manager.runQuery(`connection:${conn.id}`, 'SELECT id FROM emp WHERE id = ?')
  } catch (e) {
    missingParamErr = e
  }
  check('缺少参数被拒绝', Boolean(missingParamErr) && /缺少参数/.test(String(missingParamErr?.message ?? missingParamErr)))

  console.log('\n[12] CHECK 约束与触发器元数据')
  const empMeta = await manager.describeTable(empNode.id)
  check('读到 CHECK 约束 chk_emp_salary',
    (empMeta.checks ?? []).some((c) => c.name === 'chk_emp_salary' && /salary/i.test(c.expression)),
    JSON.stringify(empMeta.checks))
  check('读到触发器 trg_emp_bi（BEFORE INSERT）',
    (empMeta.triggers ?? []).some((t) => t.name === 'trg_emp_bi' && t.timing === 'BEFORE' && t.event === 'INSERT'),
    JSON.stringify(empMeta.triggers))
  const caps = (await manager.connectConnection(conn.id)).capabilities
  check('能力声明 checkConstraints = true', caps?.metadata?.checkConstraints === true)
  check('能力声明 triggers = true', caps?.metadata?.triggers === true)

  console.log('\n[13] 视图定义与例程')
  await manager.executeStatement(`connection:${conn.id}`, 'DROP VIEW IF EXISTS v_emp_names')
  await manager.executeStatement(`connection:${conn.id}`, 'CREATE OR REPLACE VIEW v_emp_names AS SELECT id, name FROM emp')
  await manager.executeStatement(`connection:${conn.id}`, 'DROP PROCEDURE IF EXISTS p_emp_count')
  let procCreated = true
  try {
    await manager.executeStatement(`connection:${conn.id}`, 'CREATE PROCEDURE p_emp_count() SELECT COUNT(*) AS c FROM emp')
  } catch (e) {
    procCreated = false
    skipCheck('存储过程定义读取', `当前账号无权创建例程：${String(e?.message ?? e)}`)
  }

  const snap = await manager.captureSchemaSnapshot(conn.id)
  const viewSnap = snap.views.find((v) => v.name === 'v_emp_names')
  check('结构快照包含视图 v_emp_names', Boolean(viewSnap), JSON.stringify(snap.views.map((v) => v.name)))
  check('视图定义已读取（含 SELECT）',
    typeof viewSnap?.definition === 'string' && /select/i.test(viewSnap.definition),
    JSON.stringify(viewSnap?.definition))
  if (procCreated) {
    const procSnap = snap.routines.find((r) => r.name === 'p_emp_count')
    check('结构快照包含存储过程 p_emp_count', Boolean(procSnap), JSON.stringify(snap.routines.map((r) => r.name)))
    check('存储过程定义是完整 CREATE 语句',
      typeof procSnap?.definition === 'string' && /create[\s\S]*procedure/i.test(procSnap.definition),
      JSON.stringify(procSnap?.definition))
  }

  console.log('\n[14] 结构比较（MySQL 反引号）')
  const altered = {
    ...snap,
    tables: snap.tables.map((t) =>
      t.name === 'emp'
        ? { ...t, columns: [...t.columns, { name: 'extra_col', typeName: 'int', nullable: true, primaryKeyOrdinal: null, defaultValue: null }] }
        : t
    )
  }
  const structureDiff = diffSchema(altered, snap, 'mysql')
  check('结构比较生成 ADD COLUMN',
    structureDiff.statements.some((s) => /ADD COLUMN/i.test(s) && s.includes('`extra_col`')),
    JSON.stringify(structureDiff.statements))
  check('MySQL 同步 SQL 使用反引号而非双引号',
    structureDiff.statements.every((s) => !/"[a-zA-Z_]/.test(s)) && structureDiff.statements.some((s) => s.includes('`emp`')),
    JSON.stringify(structureDiff.statements))
  check('同一快照比较无差异', diffSchema(snap, snap, 'mysql').changes.length === 0)

  console.log('\n[15] 数据比较（同表自比）')
  const dataCmp = await manager.compareTableData({ sourceTableNodeId: empNode.id, targetTableNodeId: empNode.id })
  check('同表数据比较无差异', dataCmp.rows.every((r) => r.status === 'same'), JSON.stringify(dataCmp.rows.filter((r) => r.status !== 'same').slice(0, 2)))
  check('数据比较键为主键 id', dataCmp.keyColumns.join(',') === 'id', dataCmp.keyColumns.join(','))

  console.log('\n[16] DDL 结构编辑（真实执行）')
  await manager.createTable(`connection:${conn.id}`, {
    name: 'ddl_demo',
    columns: [
      { name: 'id', typeName: 'INT', primaryKeyOrdinal: 1, autoIncrement: true, nullable: false },
      { name: 'label', typeName: 'VARCHAR(32)', nullable: false, defaultValue: "'x'" }
    ]
  })
  let tablesAfter = await manager.listChildren(tablesFolder.id)
  const ddlNode = tablesAfter.find((t) => t.name === 'ddl_demo')
  check('建表后目录可见 ddl_demo', Boolean(ddlNode), tablesAfter.map((t) => t.name).join(','))
  const ddlDesc = await manager.describeTable(ddlNode.id)
  check('DDL 建表主键与自增正确',
    ddlDesc.columns.find((c) => c.name === 'id')?.primaryKeyOrdinal === 1 &&
      ddlDesc.columns.find((c) => c.name === 'id')?.identity === 'by-default',
    JSON.stringify(ddlDesc.columns))
  check('DDL 建表默认值生效', ddlDesc.columns.find((c) => c.name === 'label')?.defaultValue === 'x', JSON.stringify(ddlDesc.columns.find((c) => c.name === 'label')))

  await manager.renameTable(ddlNode.id, 'ddl_demo2')
  tablesAfter = await manager.listChildren(tablesFolder.id)
  check('重命名表生效', tablesAfter.some((t) => t.name === 'ddl_demo2') && !tablesAfter.some((t) => t.name === 'ddl_demo'), tablesAfter.map((t) => t.name).join(','))
  const renamedNode = tablesAfter.find((t) => t.name === 'ddl_demo2')

  await manager.createView(`connection:${conn.id}`, 'ddl_view', 'SELECT id, label FROM ddl_demo2')
  const viewsFolder = (await manager.listChildren(dbNode.id)).find((f) => f.name === '视图')
  let viewList = await manager.listChildren(viewsFolder.id)
  const ddlViewNode = viewList.find((v) => v.name === 'ddl_view')
  check('建视图后目录可见 ddl_view', Boolean(ddlViewNode), viewList.map((v) => v.name).join(','))
  await manager.dropView(ddlViewNode.id)
  viewList = await manager.listChildren(viewsFolder.id)
  check('删视图生效', !viewList.some((v) => v.name === 'ddl_view'), viewList.map((v) => v.name).join(','))

  let badTypeErr = null
  try {
    await manager.createTable(`connection:${conn.id}`, {
      name: 'bad_ddl',
      columns: [{ name: 'x', typeName: 'INT; DROP TABLE emp' }]
    })
  } catch (e) {
    badTypeErr = e
  }
  check('危险类型名被拒绝', Boolean(badTypeErr) && /类型不受支持/.test(String(badTypeErr?.message ?? badTypeErr)), String(badTypeErr?.message ?? badTypeErr))

  await manager.dropTable(renamedNode.id)
  tablesAfter = await manager.listChildren(tablesFolder.id)
  check('删表生效', !tablesAfter.some((t) => t.name === 'ddl_demo2'), tablesAfter.map((t) => t.name).join(','))

  console.log('\n[17] SQL INSERT 导出（MySQL 反引号与转义）')
  const sqlPath = join(work, 'emp.sql')
  const sqlTask = manager.startTransfer({ source: { nodeId: empNode.id, connectionId: conn.id }, format: 'sql-insert', destinationPath: sqlPath })
  const sqlRes = await manager.waitTransfer(sqlTask.taskId)
  check('SQL INSERT 导出完成', sqlRes.status === 'completed', sqlRes.status)
  const sqlText = readFileSync(sqlPath, 'utf8')
  check('导出表名带 database 限定与反引号',
    sqlText.includes('`' + database + '`') && sqlText.includes('`emp`'),
    sqlText.slice(0, 160))
  check('导出内容含 INSERT 语句', /INSERT INTO/i.test(sqlText))

  console.log('\n[20] CSV 导入（importBatch 端到端）')
  const csvPath = join(work, 'import.csv')
  writeFileSync(csvPath, 'name,dept_id,salary\n导入甲,1,7000.00\n导入乙,2,8000.00\n', 'utf8')
  const importTask = manager.startImport({
    targetNodeId: empNode.id,
    sourcePath: csvPath,
    delimiter: ',',
    nullText: '',
    hasHeader: true,
    targetColumns: ['name', 'dept_id', 'salary'],
    batchSize: 1
  })
  const importRes = await manager.waitImport(importTask.taskId)
  check('CSV 导入完成并提交 2 行', importRes.status === 'completed' && importRes.rowsImported === 2, JSON.stringify(importRes))
  const imported = await manager.runQuery(`connection:${conn.id}`, "SELECT name FROM emp WHERE name LIKE '导入%' ORDER BY name")
  check('导入的数据可见', imported.rows.length === 2 && imported.rows[0]?.cells[0]?.text === '导入乙', JSON.stringify(imported.rows.map((r) => r.cells[0])))
  await manager.executeStatement(`connection:${conn.id}`, "DELETE FROM emp WHERE name LIKE '导入%'")

  console.log('\n[18] TLS')
  let tlsConn = null
  try {
    tlsConn = await manager.add(
      { dialectId: 'mysql', name: 'mysql-tls', options: { host, port: String(port), database, user, sslmode: 'require' } },
      { dbPassword: password }
    )
    await manager.connectConnection(tlsConn.id)
    const sslStatus = await manager.executeStatement(`connection:${tlsConn.id}`, "SHOW STATUS LIKE 'Ssl_version'")
    const sslRow = sslStatus.kind === 'rows' ? sslStatus.result.rows[0] : undefined
    const sslVersion = sslRow?.cells[1]?.text
    check('sslmode=require 建立加密连接', typeof sslVersion === 'string' && sslVersion.length > 0, JSON.stringify(sslRow?.cells))
  } finally {
    if (tlsConn !== null) {
      await manager.disconnectConnection(tlsConn.id).catch(() => undefined)
      await manager.remove(tlsConn.id).catch(() => undefined)
    }
  }

  const caPath = process.env.MYSQL_SSL_CA
  if (caPath === undefined || caPath === '') {
    skipCheck('sslmode=verify-ca 校验证书链', '未设置 MYSQL_SSL_CA（CA 证书路径）')
  } else {
    let verifyConn = null
    try {
      verifyConn = await manager.add(
        { dialectId: 'mysql', name: 'mysql-verify-ca', options: { host, port: String(port), database, user, sslmode: 'verify-ca', sslrootcert: caPath } },
        { dbPassword: password }
      )
      await manager.connectConnection(verifyConn.id)
      check('sslmode=verify-ca 校验证书链并连接成功', true)
    } finally {
      if (verifyConn !== null) {
        await manager.disconnectConnection(verifyConn.id).catch(() => undefined)
        await manager.remove(verifyConn.id).catch(() => undefined)
      }
    }
  }

  const badSsl = await manager.testConnection(
    { dialectId: 'mysql', name: 'mysql-bad-ssl', options: { host, port: String(port), database, user, sslmode: 'bogus' } },
    { dbPassword: password }
  )
  check('非法 sslmode 被拒绝（不静默降级）',
    badSsl.ok === false && /SSL|sslmode/i.test(String(badSsl.message ?? '')),
    JSON.stringify(badSsl))

  console.log('\n[19] MySQL over SSH 隧道')
  const sshHost = process.env.MYSQL_SSH_HOST
  if (sshHost === undefined || sshHost === '') {
    skipCheck('MySQL over SSH 隧道', '未设置 MYSQL_SSH_HOST（需要本机 sshd 夹具）')
  } else {
    const sshPort = process.env.MYSQL_SSH_PORT ?? '2222'
    const sshUser = process.env.MYSQL_SSH_USER ?? userInfo().username
    const sshKey = process.env.MYSQL_SSH_KEY ?? resolve(root, 'tests/.ssh-fixture/client_ed25519')
    const sshOptions = {
      host,
      port: String(port),
      database,
      user,
      sshHost,
      sshPort,
      sshUser,
      sshPrivateKey: sshKey,
      sshTargetHost: process.env.MYSQL_SSH_TARGET_HOST ?? host,
      sshTargetPort: process.env.MYSQL_SSH_TARGET_PORT ?? String(port)
    }

    // 首次连接不静默信任主机：先拿到实际指纹，再带指纹重连。
    // 若环境已提供指纹，则跳过探测（只建立一条 SSH 连接）。
    let fingerprint = process.env.MYSQL_SSH_HOST_KEY ?? ''
    if (fingerprint === '') {
      const probe = await manager.testConnection(
        { dialectId: 'mysql', name: 'mysql-ssh-probe', options: sshOptions },
        { dbPassword: password }
      )
      if (probe.ok === false && probe.sshHostKey?.state === 'unverified') {
        fingerprint = probe.sshHostKey.fingerprint
      }
      check('首次 SSH 连接返回待确认指纹（不做 TOFU）',
        probe.ok === true || probe.sshHostKey?.state === 'unverified',
        JSON.stringify({ ok: probe.ok, sshHostKey: probe.sshHostKey, message: probe.message }))
    } else {
      skipCheck('首次 SSH 连接返回待确认指纹（不做 TOFU）', '已通过 MYSQL_SSH_HOST_KEY 预置指纹')
    }

    let sshConn = null
    try {
      sshConn = await manager.add(
        { dialectId: 'mysql', name: 'mysql-ssh', options: { ...sshOptions, sshHostKeySha256: fingerprint } },
        { dbPassword: password }
      )
      await manager.connectConnection(sshConn.id)
      const viaTunnel = await manager.executeStatement(`connection:${sshConn.id}`, 'SELECT COUNT(*) AS c FROM emp')
      const count = viaTunnel.kind === 'rows' ? viaTunnel.result.rows[0]?.cells[0]?.text : undefined
      check('通过 SSH 隧道连接 MySQL 并查询', count === '3', JSON.stringify({ count, status: viaTunnel.kind }))
    } finally {
      if (sshConn !== null) {
        await manager.disconnectConnection(sshConn.id).catch(() => undefined)
        await manager.remove(sshConn.id).catch(() => undefined)
      }
    }
  }

  await manager.executeStatement(`connection:${conn.id}`, 'DROP VIEW IF EXISTS v_emp_names')
  await manager.executeStatement(`connection:${conn.id}`, 'DROP PROCEDURE IF EXISTS p_emp_count')

} finally {
  await manager.disconnectConnection(conn.id).catch(() => undefined)
  rmSync(probeDir, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}

console.log(`\nMySQL 契约：${pass} 通过 / ${fail} 失败 / ${skip} 跳过`)
if (fail > 0) process.exitCode = 1
