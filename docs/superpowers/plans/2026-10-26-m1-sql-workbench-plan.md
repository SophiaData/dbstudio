# M1 日常 SQL 工作台实现计划 (SQL Workbench Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 M1 日常 SQL 工作台核心能力：查询与命令分离、DML/DDL 结果区分与影响行数反馈、写操作联动连接级事务控制器、多语句顺序脚本执行与错误定位、按连接 SQL 草稿恢复，解除无差别的查询窗口只读限制。

**Architecture:** 在 `core` 协议定义 `StatementResult`（`rows` / `affected` / `ddl` 三态联合）与 `executeStatement`。驱动宿主保持进程边界，在 SQLite 与 PG adapter 实现该方法。主进程与 IPC 原样转发并作用域化游标。渲染层在 `tabs` 与 `main` 实现命令结果面板、多语句错误中断与事务状态同步，草稿持久化使用 `localStorage`。

**Tech Stack:** Electron 45, TypeScript 5.9, electron-vite, 原生 DOM/CSS, node:sqlite, pg 8, Playwright.

**评估基线：** `1f59c5d` (PR #1 合并后 main)。

---

## 文件结构与改动映射

```
src/
├── core/
│   ├── driver.ts           # 扩充 DriverAdapter: executeStatement 契约
│   ├── resultset.ts        # 导出 StatementResult 联合类型 (rows / affected / ddl)
│   └── api.ts              # 扩充 DbStudioApi 与 IPC.executeStatement 常量
├── driver-host/
│   └── index.ts            # 宿主 RPC 分发 executeStatement 请求
├── drivers/
│   ├── sqlite/
│   │   ├── adapter.ts      # 实现 executeStatement: 识别 SELECT/DML/DDL 并执行
│   │   └── results.ts      # 区分查询与写语句，开放写语句解析
│   └── postgresql/
│       ├── adapter.ts      # 实现 executeStatement: 捕获 rowCount 与 command
│       └── results.ts      # 开放 DML/DDL 语句解析
├── main/
│   ├── DriverHostHandle.ts # 增加 executeStatement 转发
│   ├── ConnectionManager.ts# 增加 executeStatement，保持游标作用域化封装
│   └── index.ts            # 注册 IPC.executeStatement 处理函数
├── preload/
│   └── index.ts            # 向 window.dbstudio 注入 executeStatement
└── renderer/
    ├── tabs.ts             # 支持网格与命令结果卡片双形态标签
    ├── transaction-controller.ts # 增加 notifyExternalMutation 响应 SQL DML
    ├── main.ts             # 改造 executeSql: 顺序脚本执行、错误中断、草稿恢复
    ├── sql-editor.ts       # 接入草稿自动存储与切换连接回填
    └── style.css           # 增加 DML/DDL 命令结果卡片与状态指示样式
tests/
├── e2e-statement-execution.mjs  # 语句执行协议与驱动端到端断言
├── gui-sql-transaction.mjs      # SQL 写操作跨标签同步与事务回滚 GUI 验证
├── gui-sql-workbench-results.mjs# 影响行数/DDL 摘要卡片渲染验证
├── gui-sql-script-execution.mjs # 顺序多语句脚本执行与错误中断验证
└── gui-sql-draft.mjs            # 按连接草稿持久化与恢复验证
```

---

### Task B1: 核心协议与驱动层语句执行契约 (StatementResult & DriverAdapter)

**Files:**
- Modify: `src/core/resultset.ts`
- Modify: `src/core/driver.ts`
- Modify: `src/drivers/sqlite/results.ts`
- Modify: `src/drivers/sqlite/adapter.ts`
- Modify: `src/drivers/postgresql/results.ts`
- Modify: `src/drivers/postgresql/adapter.ts`
- Test: `tests/e2e-statement-execution.mjs`

- [x] **Step 1: 编写失败的端到端测试**

在 `tests/e2e-statement-execution.mjs` 中编写测试，启动临时 SQLite 驱动宿主，发送 `executeStatement` RPC：
1. `SELECT 1 AS num` 必须返回 `{ kind: 'rows', result: ... }`
2. `INSERT INTO test_tbl VALUES (1, 'val')` 必须返回 `{ kind: 'affected', affected: 1, inTransaction: boolean }`
3. `CREATE TABLE temp_x (id INT)` 必须返回 `{ kind: 'ddl', summary: string, committed: true }`

```javascript
// tests/e2e-statement-execution.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')

const work = mkdtempSync(join(tmpdir(), 'dbstudio-stmt-test-'))
const dbPath = join(work, 'test.db')
const db = new DatabaseSync(dbPath)
db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES(1, 'first');")
db.close()

const child = spawn(process.execPath, [hostEntry, '--dialect', 'sqlite'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'inherit']
})

const rl = createInterface({ input: child.stdout })
const lines = rl[Symbol.asyncIterator]()

let reqId = 1
async function rpc(method, params = {}) {
  const id = `req-${reqId++}`
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  while (true) {
    const { value } = await lines.next()
    const msg = JSON.parse(value)
    if (msg.id === id) {
      if (msg.error) throw new Error(`${msg.error.code}: ${msg.error.message}`)
      return msg.result
    }
  }
}

try {
  // 1. 等待握手
  const { value: hsLine } = await lines.next()
  const hs = JSON.parse(hsLine)
  assert.equal(hs.jsonrpc, '2.0')

  // 2. 建连
  await rpc('connect', { config: { id: 'c1', dialectId: 'sqlite', name: 'sqlite', file: dbPath }, secret: null })

  // 3. 执行 SELECT (rows)
  const rowsRes = await rpc('executeStatement', { sql: 'SELECT * FROM items ORDER BY id' })
  assert.equal(rowsRes.kind, 'rows')
  assert.equal(rowsRes.result.rows.length, 1)

  // 4. 执行 INSERT (affected)
  const insertRes = await rpc('executeStatement', { sql: "INSERT INTO items VALUES (2, 'second')" })
  assert.equal(insertRes.kind, 'affected')
  assert.equal(insertRes.affected, 1)

  // 5. 执行 DDL (ddl)
  const ddlRes = await rpc('executeStatement', { sql: 'CREATE TABLE t_demo(a INT)' })
  assert.equal(ddlRes.kind, 'ddl')
  assert.ok(ddlRes.summary.includes('CREATE TABLE'))

  console.log('PASS e2e-statement-execution (driver-host RPC)')
} finally {
  child.kill()
  rmSync(work, { recursive: true, force: true })
}
```

- [x] **Step 2: 运行测试验证失败**

运行：`node tests/e2e-statement-execution.mjs`
期望：失败，报 `method_not_found: 未知方法 executeStatement` 或类似错误。

- [x] **Step 3: 实现核心类型与 SQLite/PG 的 executeStatement**

1. 在 `src/core/resultset.ts` 导出 `StatementResult`：
```typescript
export type StatementResult =
  | {
      readonly kind: 'rows'
      readonly result: QueryResult
    }
  | {
      readonly kind: 'affected'
      readonly affected: number
      readonly inTransaction: boolean
      readonly transactionState: TransactionState
      readonly executedSql: string
      readonly elapsedMs: number
    }
  | {
      readonly kind: 'ddl'
      readonly summary: string
      readonly affected?: number
      readonly committed: boolean
      readonly executedSql: string
      readonly elapsedMs: number
    }
```
2. 在 `src/core/driver.ts` 的 `DriverAdapter` 增加方法：
```typescript
executeStatement(sql: string, options?: QueryOptions): Promise<StatementResult>
```
3. 在 `src/driver-host/index.ts` 增加 RPC 分发：
```typescript
case 'executeStatement': {
  this.#requireConnected(req.method)
  const sql = parseSql(params.sql, req.method)
  const options = parseQueryOptions(params.options, req.method)
  const result: StatementResult = await this.#adapter.executeStatement(sql, options)
  return result
}
```
4. 在 `src/drivers/sqlite/adapter.ts` 实现 `executeStatement`：判断语句首词，如果是 SELECT/PRAGMA 读取/EXPLAIN 则调用现有 `this.query(sql, options)` 返回 `{ kind: 'rows', result }`；如果是 INSERT/UPDATE/DELETE/REPLACE 则使用 `db.prepare(sql).run()` 返回 `{ kind: 'affected', affected: info.changes, inTransaction: state.active, transactionState: state, executedSql: sql, elapsedMs }`；如果是 CREATE/DROP/ALTER 则调用 `db.exec(sql)` 返回 `{ kind: 'ddl', summary: '执行成功', committed: true, executedSql: sql, elapsedMs }`。
5. 在 `src/drivers/postgresql/adapter.ts` 实现相同分类并处理 `res.rowCount` 与 `res.command`。

- [x] **Step 4: 构建并验证测试通过**

运行：
```bash
node scripts/build-driver-host.mjs
node tests/e2e-statement-execution.mjs
```
期望：`PASS e2e-statement-execution (driver-host RPC)`

- [x] **Step 5: 提交**

```bash
git add src/core/resultset.ts src/core/driver.ts src/driver-host/index.ts src/drivers/ tests/e2e-statement-execution.mjs
git commit -m "feat(core): 定义 StatementResult 并在 SQLite/PG 驱动实现 executeStatement"
```

---

### Task B2: 主进程、IPC 与 SDK 链路集成

**Files:**
- Modify: `src/main/DriverHostHandle.ts`
- Modify: `src/main/ConnectionManager.ts`
- Modify: `src/core/api.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `sdk/src/index.ts`
- Test: `tests/e2e-statement-execution.mjs`

- [x] **Step 1: 扩充测试以覆盖 ConnectionManager 与游标作用域**

在 `tests/e2e-statement-execution.mjs` 尾部追加通过 `ConnectionManager` 调用的断言：验证当返回 `kind === 'rows'` 时，游标 ID 带有 `connection:c1|` 作用域前缀，且能通过 `fetchResultPage` 正常读取。

- [x] **Step 2: 运行测试确认失败**

运行：`pnpm run typecheck`
期望：因 `ConnectionManager` 和 `DbStudioApi` 缺少 `executeStatement` 报错。

- [x] **Step 3: 实现主进程转发与 IPC**

1. 在 `src/main/DriverHostHandle.ts` 增加：
```typescript
executeStatement(sql: string, options?: QueryOptions): Promise<StatementResult> {
  return this.#requestWithTimeout<StatementResult>(
    'executeStatement',
    { sql, options },
    RESULT_SET_TIMEOUT_MS
  )
}
```
2. 在 `src/main/ConnectionManager.ts` 增加：
```typescript
async executeStatement(nodeId: string, sql: string, options?: QueryOptions): Promise<StatementResult> {
  const { conn } = this.#resolveConnection(nodeId)
  const result = await conn.host.executeStatement(sql, options)
  if (this.#connections.get(conn.id) !== conn) {
    throw new Error(`语句执行所属的会话已断开: ${conn.id}`)
  }

  if (result.kind === 'rows') {
    const qResult = result.result
    if (qResult.cursorId !== null && qResult.cursorId !== undefined) {
      const scoped = CursorId.scope(conn.id, qResult.cursorId)
      this.#trackCursor(conn.id, qResult.cursorId)
      return {
        ...result,
        result: { ...qResult, cursorId: scoped }
      }
    }
  }
  return result
}
```
3. 在 `src/core/api.ts` 添加 `IPC.executeStatement = 'dbstudio:executeStatement'` 与 `DbStudioApi.executeStatement`。
4. 在 `src/main/index.ts` 的 `registerIpc` 接入 `ipcMain.handle(IPC.executeStatement, ...)`。
5. 在 `src/preload/index.ts` 暴露 `executeStatement`。

- [x] **Step 4: 构建并验证测试**

运行：
```bash
pnpm run build
pnpm run typecheck
node tests/e2e-statement-execution.mjs
```
期望：全部 PASS，无 TypeScript 类型错误。

- [x] **Step 5: 提交**

```bash
git add src/main/ src/core/api.ts src/preload/index.ts sdk/ tests/e2e-statement-execution.mjs
git commit -m "feat(main): 打通 executeStatement 的 IPC 与 ConnectionManager 游标作用域"
```

---

### Task B3: 连接级事务控制器联动与广播

**Files:**
- Modify: `src/renderer/transaction-controller.ts`
- Modify: `src/renderer/main.ts`
- Test: `tests/gui-sql-transaction.mjs`

- [x] **Step 1: 编写 GUI 跨标签事务联动测试**

创建 `tests/gui-sql-transaction.mjs`：
1. 启动应用，连接并打开 `items` 表（Tab A）。
2. 在 SQL 编辑器中执行 `INSERT INTO items VALUES (100, 'sql-tx-item')`。
3. 断言：Tab A 自动刷新并展示行 `100, 'sql-tx-item'`。
4. 断言：界面显示“未提交事务”徽标，“提交”与“回滚”按钮变为可用状态。
5. 点击工具栏“回滚”按钮。
6. 断言：Tab A 自动刷新，行 `100` 消失；直接读取磁盘 SQLite 文件确认行 `100` 从未被写入。

- [x] **Step 2: 运行测试验证失败**

运行：`node tests/gui-sql-transaction.mjs`
期望：失败，因为 SQL 编辑器目前未调用 `executeStatement` 且未通知 `TransactionController`。

- [x] **Step 3: 实现控制器外部突变通知与刷新**

1. 在 `src/renderer/transaction-controller.ts` 增加 `notifyExternalMutation`：
```typescript
async notifyExternalMutation(api?: DbStudioApi): Promise<void> {
  await this.#enqueue(async () => {
    const activeApi = api ?? this.#api
    if (activeApi) {
      const state = await activeApi.transactionState(this.connectionId).catch(() => null)
      if (state) this.#broadcastState(state)
    }
    await this.#broadcast({ reload: true })
  })
}
```
2. 在 `src/renderer/main.ts` 的 SQL 执行路径中：
当 `res.kind === 'affected'` 时，调用 `getTransactionController(connId).notifyExternalMutation(api)`。
当 `res.kind === 'ddl'` 时，调用 `tree.loadRoots()` 刷新左侧树结构，并在事务状态改变时通知控制器。

- [x] **Step 4: 运行测试确认通过**

运行：
```bash
pnpm run build
node tests/gui-sql-transaction.mjs
```
期望：`PASS SQL transaction lifecycle & cross-tab sync`

- [x] **Step 5: 提交**

```bash
git add src/renderer/transaction-controller.ts src/renderer/main.ts tests/gui-sql-transaction.mjs
git commit -m "feat(renderer): SQL 写入操作自动联动连接级事务控制器并广播刷新同连接标签"
```

---

### Task B4: 渲染层结果面板多形态支持（Affected 卡片与 DDL 摘要）

**Files:**
- Modify: `src/renderer/tabs.ts`
- Modify: `src/renderer/style.css`
- Test: `tests/gui-sql-workbench-results.mjs`

- [x] **Step 1: 编写命令结果卡片渲染测试**

创建 `tests/gui-sql-workbench-results.mjs`：
1. 执行 `UPDATE items SET name = 'updated' WHERE id = 1`。
2. 验证当前标签页呈现 `.statement-summary-pane`，内部包含“影响 1 行”与耗时文本，而非空表格。
3. 执行 `CREATE TABLE tab_new(val TEXT)`。
4. 验证当前标签页呈现 `.statement-summary-pane`，包含 DDL 摘要“CREATE TABLE tab_new 已完成”。
5. 执行 `SELECT * FROM items`。
6. 验证当前标签页呈现 `.grid-panel` 表格。

- [x] **Step 2: 运行测试验证失败**

运行：`node tests/gui-sql-workbench-results.mjs`
期望：失败，目前所有 SQL 无论返回什么都无条件创建 `ResultGrid`。

- [x] **Step 3: 实现多形态标签面板**

1. 改造 `src/renderer/tabs.ts`：
为 `Tab` 增加 `kind: 'grid' | 'command-summary'` 模式。当 `StatementResult` 为 `affected` 或 `ddl` 时，创建或切换为卡片展示容器，渲染结构化状态：
- 影响行数、执行耗时、是否在事务中、操作摘要。
- 提供“提交当前连接事务”与“回滚”的快捷点击操作。
2. 在 `src/renderer/style.css` 添加 `.statement-summary-pane`、`.statement-stat`、`.statement-badge` 等样式，保证深浅色模式清晰一致。

- [x] **Step 4: 运行测试确认通过**

运行：
```bash
pnpm run build
node tests/gui-sql-workbench-results.mjs
```
期望：`PASS GUI workbench result cards (affected / ddl / rows)`

- [x] **Step 5: 提交**

```bash
git add src/renderer/tabs.ts src/renderer/style.css tests/gui-sql-workbench-results.mjs
git commit -m "feat(renderer): 为 DML 影响行数与 DDL 变更摘要提供结构化结果卡片"
```

---

### Task B5: 多语句脚本顺序执行与错误精准定位

**Files:**
- Modify: `src/renderer/main.ts`
- Test: `tests/gui-sql-script-execution.mjs`

- [x] **Step 1: 编写多语句顺序脚本测试**

创建 `tests/gui-sql-script-execution.mjs`：
1. 执行复合脚本：
```sql
INSERT INTO items VALUES (20, 'seq-1');
INSERT INTO items VALUES (21, 'seq-2');
SELECT COUNT(*) FROM items;
```
验证三条按序执行，最终标签页展示结果或执行汇总。
2. 执行含语法错误的脚本：
```sql
INSERT INTO items VALUES (30, 'ok');
THIS IS A SYNTAX ERROR;
INSERT INTO items VALUES (31, 'should-not-run');
```
验证第二条报错后立即中断；状态栏与错误面板明确标出“第 2/3 条语句失败：syntax error”；行 31 未被执行。

- [x] **Step 2: 运行测试验证失败**

运行：`node tests/gui-sql-script-execution.mjs`
期望：失败或报错信息不包含精准的语句序号与定位。

- [x] **Step 3: 优化 main.ts executeSql 脚本执行逻辑**

1. 使用 `splitStatements` 切分语句。
2. 循环按序调用 `executeStatement`。
3. 遇到异常或错误返回时，立即捕获并记录当前语句索引 `i + 1`、语句切片文本与行号，阻断后续语句执行。
4. 精确将每一条语句的耗时、影响行数与状态记录到 SQL 历史库。

- [x] **Step 4: 运行测试确认通过**

运行：
```bash
pnpm run build
node tests/gui-sql-script-execution.mjs
```
期望：`PASS multi-statement script sequential execution & error abort`

- [x] **Step 5: 提交**

```bash
git add src/renderer/main.ts tests/gui-sql-script-execution.mjs
git commit -m "feat(renderer): 完善顺序多语句脚本执行流程与错误行号精准中断"
```

---

### Task B6: SQL 草稿按连接持久化与验证清单集成

**Files:**
- Modify: `src/renderer/sql-editor.ts`
- Modify: `src/renderer/main.ts`
- Modify: `package.json`
- Modify: `scripts/verify-manifest.mjs`
- Modify: `README.md`
- Test: `tests/gui-sql-draft.mjs`
- Test: `tests/e2e-verify-manifest.mjs`

- [x] **Step 1: 编写草稿恢复测试**

创建 `tests/gui-sql-draft.mjs`：
1. 选中连接 1，在 SQL 编辑器输入 `SELECT 'draft-1'`。
2. 切换到连接 2，输入 `SELECT 'draft-2'`。
3. 切回连接 1，验证文本框自动恢复为 `SELECT 'draft-1'`。
4. 切回连接 2，验证恢复为 `SELECT 'draft-2'`。

- [x] **Step 2: 运行测试验证失败**

运行：`node tests/gui-sql-draft.mjs`
期望：失败，当前切换连接不保存恢复草稿。

- [x] **Step 3: 实现草稿持久化与清单登记**

1. 在 `main.ts` 结合 `sql-editor.ts`：在用户输入时（防抖 200ms）将内容存入 `localStorage.setItem('dbstudio.sql-draft.' + connectionId, text)`。在切换当前连接或初始化时，读取并回显。
2. 在 `package.json` 登记所有 B1–B6 新增的测试脚本：
   - `test:statement-execution`
   - `test:gui-sql-transaction`
   - `test:gui-sql-workbench-results`
   - `test:gui-sql-script-execution`
   - `test:gui-sql-draft`
3. 在 `scripts/verify-manifest.mjs` 的对应分组（node / gui）登记上述步骤，保持清单唯一真相。
4. 更新 `README.md`，说明 SQL 工作台已支持 DML/DDL 执行、影响行数反馈与草稿恢复。

- [x] **Step 4: 运行测试并执行全量清单校验**

运行：
```bash
pnpm run test:verify-manifest
node tests/gui-sql-draft.mjs
pnpm run verify:node
```
期望：所有测试通过，清单防漂移断言 100% 匹配。

- [x] **Step 5: 提交**

```bash
git add src/renderer/ package.json scripts/verify-manifest.mjs README.md tests/
git commit -m "feat(sql-editor): 实现按连接草稿自动持久化并更新统一验证清单"
```

---

## 验证与验收标准

1. **核心契约验证：** `pnpm run test:statement-execution` 通过，SQLite 与 PG 正确区分返回行（`rows`）、影响行数（`affected`）与 DDL 变更摘要（`ddl`）。
2. **事务归属验证：** `pnpm run test:gui-sql-transaction` 通过，SQL 写入能被同连接其他标签感知，能够被连接级提交或回滚。
3. **工作台界面验证：** `pnpm run test:gui-sql-workbench-results` 通过，影响行数卡片与 DDL 卡片样式规范，且可直接触发事务提交。
4. **脚本执行验证：** `pnpm run test:gui-sql-script-execution` 通过，多语句按序执行，遇错精准标出行号与语句并停止。
5. **草稿恢复验证：** `pnpm run test:gui-sql-draft` 通过，多连接间草稿互相隔离且重进不丢失。
6. **无回归验证：** `pnpm run verify:node` 与 `pnpm run verify:headless` 完整退出码为 0。
