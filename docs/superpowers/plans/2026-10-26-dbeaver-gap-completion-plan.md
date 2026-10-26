# DBeaver Gap Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 dbstudio 从“SQLite/PostgreSQL 基础工作台”推进到可独立发布的专业 Beta，补齐数据传输、结构元数据、ER 关系、SQL 脚本、DDL、比较同步和驱动扩展能力。

**Architecture:** 保留 renderer → preload → main → driver-host 的进程边界，以及“一条连接一个 driver host”的隔离模型。把新能力分成四类契约：SQL 脚本执行、结果/传输任务、结构元数据、数据库比较；UI 只消费跨方言的纯数据契约，方言差异留在 driver adapter 和 dialect 中。

**Tech Stack:** Electron 45、TypeScript 5.9、electron-vite、原生 DOM/CSS、SQLite `node:sqlite`、PostgreSQL `pg`、`ssh2`、Playwright、pnpm。

---

## 0. 计划边界与当前基线

本计划是总控计划，不要求一次性合并所有阶段。每个阶段都必须先形成独立可测试的软件增量，再进入下一阶段。

当前已完成并作为基线保留：

- M0 可靠性收口：连接生命周期、标签上下文、事务离开保护、凭据处理、验证清单、发布门禁。
- M1 SQL 工作台核心：`StatementResult` 三态结果、DML/DDL 执行、连接级事务联动、多语句基础执行、SQL 草稿恢复。
- SQLite/PostgreSQL：连接、元数据树、分页结果集、按主键编辑、增删改、基础 DDL、PostgreSQL SSL/SSH。

当前基线证据：

- 代码版本：`package.json` 中的 `0.3.1`。
- 已有总路线图：`docs/superpowers/plans/2026-10-23-project-roadmap.md`。
- M1 执行计划：`docs/superpowers/plans/2026-10-26-m1-sql-workbench-plan.md`。
- 当前验证命令：`pnpm run typecheck`、`pnpm run verify:node`、`pnpm run verify:gui`、`pnpm run verify:external`。

计划执行前先处理两项基线问题：

1. `verify:node` 在连续启动多个 driver host 时出现过 10 秒握手超时。
2. 负例测试可能在前置连接建立失败后仍完成本地参数断言，导致误报通过。

本计划不承诺一次复制 DBeaver 的全部功能。首个产品目标是：SQLite + PostgreSQL 的可靠日常工作台；MySQL/MariaDB 作为第三个驱动，用来验证扩展模型；其它数据库、NoSQL、云资源和高级运维功能进入后续范围。

## 1. 产品目标和完成定义

### 1.1 Beta 用户场景

Beta 必须完整支持以下流程：

1. 创建 SQLite 或 PostgreSQL 连接，连接失败时可以定位到配置、网络、TLS、SSH、数据库认证或服务端探测阶段。
2. 浏览 schema、表、视图、列、索引、约束和外键。
3. 打开表，分页浏览、筛选、排序、查看完整字段、编辑、提交、回滚。
4. 在 SQL 工作台中执行 SELECT、DML、DDL 和包含函数块/触发器定义的脚本。
5. 将结果集或表导出到 CSV/JSON/SQL，导出不会因数据量增长而把全部数据存入 renderer 内存。
6. 导入 CSV，预览列映射，校验错误行，在一个事务内提交或完整回滚。
7. 查看带真实外键关系的 ER 图。
8. 比较两个表或两个 schema，生成可审阅的同步 SQL。
9. 驱动 host、连接配置、收藏、历史和窗口在应用重启及版本升级后保持可用。

### 1.2 Beta 退出门槛

- SQLite 和 PostgreSQL 的核心验证清单全部通过；外部服务测试不得被静默跳过。
- driver host 连续启动压力测试通过，握手超时不会被测试误报掩盖。
- 100,000 行、包含长文本和 BLOB 的导出采用流式路径，renderer 内存不随总行数线性增长。
- CSV 导入失败时能显示行号和列名，失败事务不留下部分写入。
- ER 图关系线来自真实外键元数据；没有外键时明确显示“无外键关系”。
- 结构比较能生成稳定、可重复运行的 SQL，并在危险操作前展示影响摘要。
- 打包后的 macOS、Windows、Linux 产物都能启动、创建 SQLite 连接并完成最小查询。
- 任何已知的数据正确性问题必须有回归测试或明确记录为未支持能力。

## 2. 总体阶段

| 阶段 | 目标 | 主要交付 | 依赖 | 建议工作量 |
|---|---|---|---|---:|
| P0 | 验证与连接可靠性 | 握手稳定性、负例防误报、性能基线、测试矩阵 | 无 | 3–5 天 |
| P1 | SQL 执行正确性 | 方言脚本切分、参数、执行计划、取消和进度 | P0 | 8–12 天 |
| P2 | 数据传输 | 流式导出、CSV 导入、任务进度、取消、回滚 | P0、P1 的结果/任务契约 | 10–15 天 |
| P3 | 结构元数据与 ER | 外键、唯一约束、索引、触发器、ER 关系线 | P0 | 10–14 天 |
| P4 | 结构编辑与 DDL | schema 选择、ALTER、约束/索引/触发器、DDL 预览 | P3 | 12–18 天 |
| P5 | 比较与同步 | 表/数据/schema diff、同步 SQL、危险操作确认 | P3、P4 | 12–20 天 |
| P6 | 驱动扩展 | MySQL/MariaDB、驱动 SDK、契约测试和驱动发现 | P1、P3 | 10–15 天 |
| P7 | Beta 交付 | 三平台、升级兼容、文档、性能和试用回归 | P0–P6 | 8–12 天 |

P1–P3 是“SQLite/PostgreSQL 专业工作台”的核心范围。P4–P6 完成后，产品才具备与 DBeaver 基础版竞争的结构工作流。P7 才允许宣布 Beta。

## 3. 文件边界

### 3.1 新增的核心模块

- `src/core/sql-script.ts`：方言无关的脚本片段、源码位置、分隔符和执行计划契约。
- `src/core/transfer.ts`：导入导出任务、进度、取消、错误行和流式块的类型。
- `src/core/metadata.ts`：外键、唯一约束、索引、检查约束、触发器和例程的跨方言模型。
- `src/core/compare.ts`：结构差异、数据差异、同步操作和危险等级。
- `src/main/TransferManager.ts`：主进程任务生命周期、临时文件、进度事件和取消。
- `src/main/CompareManager.ts`：比较任务、差异快照和生成脚本。
- `src/renderer/sql-script-runner.ts`：脚本执行状态、语句定位和结果关联。
- `src/renderer/transfer-dialog.ts`：导入导出向导、预览、映射、校验和进度。
- `src/renderer/metadata-inspector.ts`：结构对象详情和 DDL 预览。
- `src/renderer/compare-panel.ts`：差异树、筛选、SQL 预览和同步确认。

### 3.2 需要扩展的现有模块

- `src/core/model.ts`：扩展 `TableDescription` 和结构对象模型。
- `src/core/driver.ts`：扩展 adapter 的结构、流式传输、参数和比较能力。
- `src/core/api.ts`：增加 IPC/API 方法和事件类型。
- `src/core/dialect.ts`：增加脚本分隔符、执行计划、类型转换、DDL 和批量导入能力。
- `src/driver-host/index.ts`：转发任务、流块、事件和取消。
- `src/main/DriverHostHandle.ts`：增加有界请求、流式事件和宿主退出清理。
- `src/main/ConnectionManager.ts`：连接级任务和元数据缓存失效。
- `src/renderer/main.ts`：只保留接线，不继续增加业务解析。
- `src/renderer/tree.ts`：结构对象导航、刷新和对象详情入口。
- `src/renderer/grid.ts`：完整值查看、传输入口和导入后的刷新。
- `src/renderer/tabs.ts`：结果集、命令结果和传输结果关联。
- `src/renderer/er-diagram.ts`：关系线、布局和选表。
- `src/renderer/style.css`：向导、差异、进度和关系线样式。
- `scripts/verify-manifest.mjs`：所有新增测试必须登记到唯一清单。
- `README.md`：能力边界、导入导出语义、数据库支持矩阵和发布状态。

### 3.3 驱动文件

SQLite：

- `src/drivers/sqlite/adapter.ts`
- `src/drivers/sqlite/results.ts`
- `src/drivers/sqlite/ddl.ts`
- `src/drivers/sqlite/ids.ts`
- 新增 `src/drivers/sqlite/metadata.ts`
- 新增 `src/drivers/sqlite/transfer.ts`

PostgreSQL：

- `src/drivers/postgresql/adapter.ts`
- `src/drivers/postgresql/results.ts`
- `src/drivers/postgresql/ddl.ts`
- `src/drivers/postgresql/ids.ts`
- 新增 `src/drivers/postgresql/metadata.ts`
- 新增 `src/drivers/postgresql/transfer.ts`

第三个驱动：

- 新增 `src/drivers/mysql/`
- 新增 `tests/e2e-mysql-contract.mjs`

## 4. P0：验证和连接可靠性

### Task P0.1：修复握手超时和退出状态传播

**Files:**

- Modify: `src/main/DriverHostHandle.ts:120-230`
- Modify: `src/main/ConnectionManager.ts:300-450`
- Test: `tests/e2e-connection-lifecycle.mjs`
- Test: `tests/e2e-driver-host-stress.mjs`
- Modify: `scripts/verify-manifest.mjs`

- [x] **Step 1: 写失败测试**

新增连续启动、连接、断开 20 个 SQLite driver host 的测试，记录每次握手耗时、子进程 pid、退出码和 stdout/stderr。

```js
for (let i = 0; i < 20; i += 1) {
  const conn = await manager.add({
    dialectId: 'sqlite',
    name: `stress-${i}`,
    options: { file: fixture }
  })
  assert.ok(conn.id)
  await manager.remove(conn.id)
}
```

- [x] **Step 2: 运行测试确认失败或暴露时序**

运行：

```bash
node tests/e2e-driver-host-stress.mjs
```

测试必须在任一握手失败时输出失败连接的完整上下文，不得只输出“10 秒超时”。

- [x] **Step 3: 完善宿主生命周期**

为 `DriverHostHandle` 增加以下状态记录：

```ts
type HostLifecycle =
  | 'spawning'
  | 'awaiting_handshake'
  | 'ready'
  | 'closing'
  | 'exited'
  | 'failed'
```

握手超时错误必须包含 dialect、pid、脚本路径、已接收字节数和最近一次 stderr。连接失败时由 `ConnectionManager` 清除 live 记录，并保证后续重连不会复用失效句柄。

- [x] **Step 4: 验证并提交**

运行：

```bash
pnpm run typecheck
node tests/e2e-connection-lifecycle.mjs
node tests/e2e-driver-host-stress.mjs
```

```bash
git add src/main/DriverHostHandle.ts src/main/ConnectionManager.ts tests/e2e-connection-lifecycle.mjs tests/e2e-driver-host-stress.mjs scripts/verify-manifest.mjs
git commit -m "fix(connection): make driver host startup and failure cleanup observable"
```

### Task P0.2：消除测试误报并建立失败前置条件

**Files:**

- Modify: `tests/e2e-edit.mjs:627-710`
- Modify: `tests/e2e-connection-lifecycle.mjs`
- Modify: `scripts/verify.mjs`
- Test: `tests/e2e-verify-runner.mjs`

- [x] **Step 1: 把连接建立和业务断言分开**

所有使用 `manager.add()` 的测试必须先断言连接对象存在；连接失败时直接记录前置失败，不继续执行依赖该连接的本地断言。

- [x] **Step 2: 增加“测试执行了真正目标”的断言**

负例测试需要证明 RPC/adapter 路径确实被调用。例如空 `updates` 测试要记录 `HostHandle.applyEdits` 调用次数，并断言为零；如果连接没有建立，则测试状态应为 `blocked_by_setup`，最终汇总为失败。

- [x] **Step 3: 验证**

```bash
node tests/e2e-edit.mjs
node tests/e2e-verify-runner.mjs
pnpm run verify:node
```

- [x] **Step 4: 提交**

```bash
git add tests/e2e-edit.mjs tests/e2e-connection-lifecycle.mjs scripts/verify.mjs tests/e2e-verify-runner.mjs
git commit -m "test: prevent setup failures from becoming false-positive assertions"
```

## 5. P1：SQL 执行正确性

### Task P1.1：建立方言级脚本分割器

**Files:**

- Create: `src/core/sql-script.ts`
- Modify: `src/renderer/sql-format.ts`
- Modify: `src/core/dialect.ts`
- Modify: `src/renderer/sql-editor.ts`
- Modify: `src/renderer/main.ts`
- Test: `tests/e2e-sql-script-parser.mjs`

- [ ] **Step 1: 定义脚本模型**

```ts
export interface SqlScriptStatement {
  readonly index: number
  readonly sql: string
  readonly startOffset: number
  readonly endOffset: number
  readonly startLine: number
  readonly endLine: number
}

export interface SqlScriptRules {
  readonly lineCommentPrefixes: readonly string[]
  readonly blockComment: { readonly start: string; readonly end: string }
  readonly supportsDollarQuotedStrings: boolean
  readonly supportsBeginEndBlocks: boolean
  readonly statementTerminators: readonly string[]
}
```

- [ ] **Step 2: 先写覆盖边界的失败测试**

测试必须覆盖：

- 字符串内分号；
- 双引号标识符内分号；
- `--` 和 `/* */` 注释；
- PostgreSQL `$$ ... ; ... $$`；
- PostgreSQL `$tag$ ... $tag$`；
- SQLite `CREATE TRIGGER ... BEGIN ...; ... END`；
- 多行语句的起止行号；
- 末尾注释和空语句；
- 不闭合字符串/块注释的可读错误。

- [ ] **Step 3: 按方言实现最小状态机**

`splitStatements(sql, rules)` 必须返回带 offset/line 的语句对象。`sql-format.ts` 只负责格式化和 token 高亮，不能继续承担执行语句定位。

- [ ] **Step 4: 接入执行器**

`src/renderer/sql-script-runner.ts` 负责：

```ts
interface ScriptRunState {
  readonly status: 'idle' | 'running' | 'cancelled' | 'failed' | 'completed'
  readonly completed: number
  readonly total: number
  readonly current?: SqlScriptStatement
}
```

执行错误必须使用 parser 产生的 `startLine`，不能再次通过字符串片段搜索行号。

- [ ] **Step 5: 验证并提交**

```bash
node tests/e2e-sql-script-parser.mjs
pnpm run test:gui-sql-script-execution
pnpm run typecheck
```

```bash
git add src/core/sql-script.ts src/renderer/sql-format.ts src/renderer/sql-editor.ts src/renderer/main.ts src/renderer/sql-script-runner.ts tests/e2e-sql-script-parser.mjs
git commit -m "feat(sql): add dialect-aware script parsing and source locations"
```

### Task P1.2：执行计划和查询能力方言化

**Files:**

- Modify: `src/core/dialect.ts`
- Modify: `src/core/driver.ts`
- Modify: `src/core/api.ts`
- Modify: `src/driver-host/index.ts`
- Modify: `src/main/DriverHostHandle.ts`
- Modify: `src/main/ConnectionManager.ts`
- Modify: `src/drivers/sqlite/adapter.ts`
- Modify: `src/drivers/postgresql/adapter.ts`
- Modify: `src/renderer/main.ts`
- Test: `tests/e2e-explain.mjs`
- Test: `tests/gui-explain.mjs`

- [ ] **Step 1: 增加契约**

```ts
interface ExplainResult {
  readonly dialectId: string
  readonly columns: readonly ResultColumn[]
  readonly rows: readonly ResultRow[]
  readonly format: 'tabular' | 'text' | 'json'
  readonly executedSql: string
}

interface SqlDialect {
  buildExplainQuery(sql: string): string
  supportsExplain: boolean
}
```

- [ ] **Step 2: 实现 SQLite 和 PostgreSQL**

SQLite 使用 `EXPLAIN QUERY PLAN`。PostgreSQL 使用 `EXPLAIN (FORMAT JSON)` 或可配置的 text/json 模式。渲染层不能拼接数据库关键字。

- [ ] **Step 3: 增加测试**

验证两个驱动返回非空计划、错误 SQL 返回可读错误、连接断开时不会留下执行中状态。

- [ ] **Step 4: 验证并提交**

```bash
node tests/e2e-explain.mjs
node tests/gui-explain.mjs
git add src/core src/main src/driver-host src/drivers src/renderer tests/e2e-explain.mjs tests/gui-explain.mjs
git commit -m "feat(sql): make explain execution dialect aware"
```

### Task P1.3：参数化 SQL 和查询取消

**Files:**

- Modify: `src/core/resultset.ts`
- Modify: `src/core/driver.ts`
- Modify: `src/core/api.ts`
- Modify: `src/driver-host/index.ts`
- Modify: `src/drivers/sqlite/adapter.ts`
- Modify: `src/drivers/postgresql/adapter.ts`
- Modify: `src/renderer/sql-editor.ts`
- Modify: `src/renderer/main.ts`
- Test: `tests/e2e-sql-params.mjs`
- Test: `tests/gui-sql-cancel.mjs`

- [ ] **Step 1: 定义参数模型**

```ts
export type SqlParameterValue = string | number | boolean | null | Uint8Array

export interface SqlParameter {
  readonly name: string
  readonly value: SqlParameterValue
}

export interface ExecuteOptions {
  readonly parameters?: readonly SqlParameter[]
  readonly signalId?: string
}
```

- [ ] **Step 2: UI 显示参数面板**

从脚本 parser 识别 PostgreSQL `$1`、`$2` 和 SQLite `?`/`:name` 占位符；无法安全识别时必须要求用户显式输入参数，而不是猜测。

- [ ] **Step 3: 接入取消**

SQL 工作台执行必须显示取消按钮。PostgreSQL 调用已有真实取消能力；SQLite 明确显示“当前驱动无法中断同步查询”，同时阻止重复提交。

- [ ] **Step 4: 验证**

```bash
node tests/e2e-sql-params.mjs
node tests/e2e-cancel.mjs
node tests/e2e-cancel.mjs --sqlite-only
node tests/gui-sql-cancel.mjs
```

## 6. P2：数据传输

### Task P2.1：建立流式传输任务契约

**Files:**

- Create: `src/core/transfer.ts`
- Create: `src/main/TransferManager.ts`
- Modify: `src/core/api.ts`
- Modify: `src/driver-host/index.ts`
- Modify: `src/main/DriverHostHandle.ts`
- Modify: `src/main/ConnectionManager.ts`
- Test: `tests/e2e-transfer-task.mjs`

- [ ] **Step 1: 定义任务事件**

```ts
export type TransferFormat = 'csv' | 'jsonl' | 'json' | 'sql-insert'

export interface TransferProgress {
  readonly taskId: string
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  readonly rowsRead: number
  readonly bytesWritten: number
  readonly message?: string
}

export interface TransferRequest {
  readonly source: { readonly nodeId?: string; readonly sql?: string }
  readonly format: TransferFormat
  readonly destinationPath: string
  readonly options: {
    readonly includeHeader?: boolean
    readonly nullText?: string
    readonly batchSize?: number
  }
}
```

- [ ] **Step 2: 实现主进程写文件**

数据库驱动只返回结构化行块；文件句柄和临时文件由 `TransferManager` 在主进程持有。renderer 只订阅进度，不收集完整数据。

- [ ] **Step 3: 增加取消、失败清理和原子提交**

写入临时文件；成功后 rename 到目标文件；取消或失败时删除临时文件。任何截断值必须通过驱动完整值路径或直接拒绝，不允许静默写入预览。

- [ ] **Step 4: 验证并提交**

```bash
node tests/e2e-transfer-task.mjs
pnpm run typecheck
git add src/core/transfer.ts src/main/TransferManager.ts src/core/api.ts src/driver-host src/main tests/e2e-transfer-task.mjs
git commit -m "feat(transfer): add cancellable streaming export tasks"
```

### Task P2.2：实现导出向导

**Files:**

- Create: `src/renderer/transfer-dialog.ts`
- Modify: `src/renderer/grid.ts`
- Modify: `src/renderer/tabs.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/style.css`
- Test: `tests/gui-export-streaming.mjs`

- [ ] **Step 1: 增加导出入口**

表、当前结果集和自由 SQL 结果都必须进入同一个向导；向导明确显示“当前过滤结果”或“原始结果集”。

- [ ] **Step 2: 添加格式和字段选项**

支持 CSV、JSON Lines、JSON、INSERT SQL；显示编码、BOM、NULL 文本、是否包含表头和批大小。

- [ ] **Step 3: 增加进度和取消**

进度面板显示已读行数、写入字节、速度、当前状态和取消按钮。

- [ ] **Step 4: 验证**

```bash
node tests/gui-export-streaming.mjs
node tests/gui-export-integrity.mjs
```

### Task P2.3：实现 CSV 导入和事务回滚

**Files:**

- Modify: `src/core/transfer.ts`
- Modify: `src/core/driver.ts`
- Modify: `src/core/api.ts`
- Modify: `src/drivers/sqlite/transfer.ts`
- Modify: `src/drivers/postgresql/transfer.ts`
- Create: `src/renderer/import-dialog.ts`
- Modify: `src/renderer/tree.ts`
- Modify: `src/renderer/style.css`
- Test: `tests/e2e-import-validation.mjs`
- Test: `tests/gui-import.mjs`

- [ ] **Step 1: 写 CSV 解析和校验测试**

覆盖 UTF-8 BOM、引号内换行、重复列名、缺列、多列、空字符串、NULL 文本、数字、布尔、长字段和坏编码。

- [ ] **Step 2: 实现预览模型**

```ts
interface ImportPreview {
  readonly columns: readonly {
    readonly sourceName: string
    readonly targetName: string | null
    readonly targetType: string | null
    readonly mappingStatus: 'mapped' | 'unmapped' | 'duplicate'
  }[]
  readonly sampleRows: readonly readonly string[][]
  readonly errors: readonly { readonly row: number; readonly column?: string; readonly message: string }[]
}
```

- [ ] **Step 3: 实现批量写入**

使用临时表或单事务批量插入。遇到任一校验/数据库错误时回滚整个导入，并返回行号、列名和数据库错误。

- [ ] **Step 4: 验证**

```bash
node tests/e2e-import-validation.mjs
node tests/gui-import.mjs
```

## 7. P3：结构元数据和 ER 图

### Task P3.1：扩展元数据契约

**Files:**

- Create: `src/core/metadata.ts`
- Modify: `src/core/model.ts`
- Modify: `src/core/driver.ts`
- Modify: `src/core/api.ts`
- Modify: `src/driver-host/index.ts`
- Modify: `src/main/ConnectionManager.ts`
- Test: `tests/e2e-metadata-contract.mjs`

- [ ] **Step 1: 定义结构对象**

```ts
export interface ForeignKeyDescription {
  readonly name: string | null
  readonly columns: readonly string[]
  readonly referencedSchema: string | null
  readonly referencedTable: string
  readonly referencedColumns: readonly string[]
  readonly onUpdate: string | null
  readonly onDelete: string | null
}

export interface IndexDescription {
  readonly name: string
  readonly unique: boolean
  readonly columns: readonly string[]
  readonly predicate: string | null
}

export interface TableDescription {
  readonly id: string
  readonly columns: readonly ColumnDescription[]
  readonly hasUniqueKey: boolean
  readonly uniqueConstraints: readonly string[][]
  readonly foreignKeys: readonly ForeignKeyDescription[]
  readonly indexes: readonly IndexDescription[]
  readonly checks: readonly string[]
}
```

- [ ] **Step 2: 加入版本兼容策略**

新字段必须使用空数组表示“驱动已支持但没有对象”，使用 `undefined` 表示“驱动版本暂未提供该能力”。UI 不能把两者混成同一状态。

- [ ] **Step 3: 验证协议**

测试 SQLite 和 PostgreSQL 的复合主键、复合外键、唯一索引、部分索引、检查约束和没有关系的表。

- [ ] **Step 4: 提交**

```bash
git add src/core/metadata.ts src/core/model.ts src/core/driver.ts src/core/api.ts src/driver-host src/main/ConnectionManager.ts tests/e2e-metadata-contract.mjs
git commit -m "feat(metadata): expose relational constraints and indexes"
```

### Task P3.2：实现 SQLite/PostgreSQL 元数据读取

**Files:**

- Create: `src/drivers/sqlite/metadata.ts`
- Create: `src/drivers/postgresql/metadata.ts`
- Modify: `src/drivers/sqlite/adapter.ts`
- Modify: `src/drivers/postgresql/adapter.ts`
- Test: `tests/e2e-sqlite-metadata.mjs`
- Test: `tests/e2e-postgresql-metadata.mjs`

- [ ] **Step 1: SQLite**

使用 `PRAGMA foreign_key_list`、`PRAGMA index_list`、`PRAGMA index_info`、`PRAGMA table_xinfo` 和 `sqlite_master` 读取关系、索引、生成列、触发器和表定义。

- [ ] **Step 2: PostgreSQL**

使用 `pg_catalog` 读取 `pg_constraint`、`pg_index`、`pg_attribute`、`pg_trigger`、`pg_proc` 和 `pg_class`；schema、表名和对象名全部参数化。

- [ ] **Step 3: 增加缓存失效**

DDL 成功后只失效当前连接和受影响 schema 的结构缓存；刷新树时不重新读取未展开节点。

- [ ] **Step 4: 验证**

```bash
node tests/e2e-sqlite-metadata.mjs
DBSTUDIO_PG_URL=... node tests/e2e-postgresql-metadata.mjs
```

### Task P3.3：实现带关系线的 ER 图

**Files:**

- Modify: `src/renderer/er-diagram.ts`
- Modify: `src/renderer/tree.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/style.css`
- Test: `tests/gui-er-relations.mjs`

- [ ] **Step 1: 增加选表入口**

默认选择当前 schema；用户可以勾选表、按名称过滤、全选当前结果、清空选择。超过 100 张表时先要求筛选，不静默截断。

- [ ] **Step 2: 绘制关系线**

先计算所有表框位置，再按 `ForeignKeyDescription` 绘制边；边上显示列名，鼠标悬停显示约束名、删除规则和更新规则。

- [ ] **Step 3: 保存布局和导出**

按连接/schema保存表框坐标；支持 SVG 导出。布局数据只保存节点 id 和坐标，不保存数据库内容。

- [ ] **Step 4: 验证**

```bash
node tests/gui-er-relations.mjs
```

## 8. P4：结构编辑和 DDL

### Task P4.1：统一 DDL 预览和执行契约

**Files:**

- Create: `src/core/ddl.ts`
- Modify: `src/core/driver.ts`
- Modify: `src/core/api.ts`
- Modify: `src/drivers/sqlite/ddl.ts`
- Modify: `src/drivers/postgresql/ddl.ts`
- Create: `src/renderer/ddl-preview.ts`
- Modify: `src/renderer/ddl.ts`
- Test: `tests/e2e-ddl-preview.mjs`

- [ ] **Step 1: 定义 DDL 操作**

```ts
type TableChange =
  | { readonly kind: 'add-column'; readonly column: ColumnCreateSpec }
  | { readonly kind: 'drop-column'; readonly columnName: string }
  | { readonly kind: 'rename-column'; readonly oldName: string; readonly newName: string }
  | { readonly kind: 'alter-column'; readonly columnName: string; readonly typeName?: string; readonly nullable?: boolean; readonly defaultValue?: string | null }

interface IndexCreateSpec {
  readonly name: string
  readonly unique: boolean
  readonly columns: readonly string[]
  readonly predicate?: string
}

interface ForeignKeyCreateSpec {
  readonly name?: string
  readonly columns: readonly string[]
  readonly referencedSchema?: string
  readonly referencedTable: string
  readonly referencedColumns: readonly string[]
  readonly onUpdate?: string
  readonly onDelete?: string
}

type DdlOperation =
  | { readonly kind: 'create-table'; readonly spec: TableCreateSpec }
  | { readonly kind: 'alter-table'; readonly tableId: string; readonly changes: readonly TableChange[] }
  | { readonly kind: 'create-index'; readonly tableId: string; readonly index: IndexCreateSpec }
  | { readonly kind: 'create-foreign-key'; readonly tableId: string; readonly foreignKey: ForeignKeyCreateSpec }
  | { readonly kind: 'drop-object'; readonly objectId: string }

interface DdlPreview {
  readonly statements: readonly string[]
  readonly warnings: readonly string[]
  readonly requiresTransaction: boolean
}
```

- [ ] **Step 2: 驱动生成 SQL**

所有标识符走 `quoteIdentifier`；类型、默认值、表达式和约束由驱动校验。renderer 只提交结构化操作，不直接拼接 DDL。

- [ ] **Step 3: UI 显示预览**

任何删表、删列、删约束、改类型和可能丢数据的操作必须先显示 SQL 和警告，用户确认后才执行。

- [ ] **Step 4: 验证**

```bash
node tests/e2e-ddl-preview.mjs
```

### Task P4.2：完善 PostgreSQL/SQLite 对象编辑器

**Files:**

- Modify: `src/renderer/ddl.ts`
- Create: `src/renderer/object-editor.ts`
- Modify: `src/renderer/tree.ts`
- Modify: `src/drivers/sqlite/ddl.ts`
- Modify: `src/drivers/postgresql/ddl.ts`
- Test: `tests/gui-object-editor.mjs`

- [ ] **Step 1: PostgreSQL**

支持 schema 选择、ALTER TABLE、索引、唯一约束、外键、CHECK、触发器和视图定义编辑。函数/过程先提供只读查看和生成 SQL，不提供复杂的参数化编辑器。

- [ ] **Step 2: SQLite**

支持索引、触发器和视图定义；需要重建表的 ALTER 操作必须显示“SQLite 将创建临时表并迁移数据”的风险摘要。

- [ ] **Step 3: 验证**

```bash
node tests/gui-object-editor.mjs
node tests/e2e-ddl.mjs
```

## 9. P5：结构和数据比较

### Task P5.1：实现结构快照和差异模型

**Files:**

- Create: `src/core/compare.ts`
- Create: `src/main/CompareManager.ts`
- Modify: `src/core/api.ts`
- Modify: `src/main/ConnectionManager.ts`
- Test: `tests/e2e-structure-compare.mjs`

- [ ] **Step 1: 定义快照**

```ts
interface SchemaSnapshot {
  readonly source: { readonly connectionId: string; readonly schema: string | null }
  readonly tables: readonly TableDescription[]
  readonly views: readonly {
    readonly schema: string | null
    readonly name: string
    readonly definition: string | null
  }[]
  readonly routines: readonly {
    readonly schema: string | null
    readonly name: string
    readonly kind: 'function' | 'procedure'
    readonly definition: string | null
  }[]
}

type SchemaChange =
  | { readonly kind: 'create'; readonly objectType: string; readonly target: string }
  | { readonly kind: 'drop'; readonly objectType: string; readonly target: string; readonly destructive: true }
  | { readonly kind: 'alter'; readonly objectType: string; readonly target: string; readonly statements: readonly string[] }
```

- [ ] **Step 2: 实现确定性 diff**

对象按 schema、类型、名称排序；列按 ordinal；约束和索引按规范化结构比较。差异输出必须不依赖数据库返回顺序。

- [ ] **Step 3: 生成同步 SQL**

默认只生成 SQL，不自动执行；危险删除、类型缩窄和可能丢数据的操作标记为 destructive。

- [ ] **Step 4: 验证**

```bash
node tests/e2e-structure-compare.mjs
```

### Task P5.2：实现数据比较

**Files:**

- Modify: `src/core/compare.ts`
- Modify: `src/main/CompareManager.ts`
- Create: `src/renderer/compare-panel.ts`
- Modify: `src/renderer/style.css`
- Test: `tests/e2e-data-compare.mjs`
- Test: `tests/gui-compare.mjs`

- [ ] **Step 1: 定义键和批量比较**

优先使用主键；没有主键时要求用户选择唯一列组合，禁止默认按行号比较。大表采用分页 hash 或按键范围分批。

- [ ] **Step 2: 显示差异**

支持仅源端、仅目标端、值不同和相同四种状态；长值显示 hash、长度和按需取全文。

- [ ] **Step 3: 生成同步计划**

同步计划必须先展示 INSERT、UPDATE、DELETE 数量和删除风险；用户确认后生成 SQL 或进入导入任务。

- [ ] **Step 4: 验证**

```bash
node tests/e2e-data-compare.mjs
node tests/gui-compare.mjs
```

## 10. P6：驱动扩展和第三个数据库

### Task P6.1：收敛驱动 SDK 契约

**Files:**

- Modify: `sdk/src/index.ts`
- Modify: `sdk/src/host.ts`
- Modify: `sdk/src/contracts/model.ts`
- Modify: `sdk/src/contracts/driver.ts`
- Modify: `sdk/src/contracts/resultset.ts`
- Test: `tests/e2e-sdk-contract.mjs`
- Test: `tests/e2e-sdk-package.mjs`

- [ ] **Step 1: 导出版本化能力**

SDK 必须公开 driver API 版本、能力集合、元数据版本和传输版本；新字段采用可选扩展，破坏性变更提升 major 版本。

- [ ] **Step 2: 建立驱动契约测试**

每个驱动至少通过：握手、连接、列目录、表描述、查询、分页、完整值、事务、DDL、元数据、导出块和错误码测试。

- [ ] **Step 3: 包外验证**

```bash
pnpm run build:sdk
pnpm run test:sdk-package
```

### Task P6.2：增加 MySQL/MariaDB 驱动

**Files:**

- Create: `src/drivers/mysql/adapter.ts`
- Create: `src/drivers/mysql/dialect.ts`
- Create: `src/drivers/mysql/info.ts`
- Create: `src/drivers/mysql/ids.ts`
- Create: `src/drivers/mysql/results.ts`
- Create: `src/drivers/mysql/metadata.ts`
- Create: `src/drivers/mysql/ddl.ts`
- Modify: `src/drivers/index.ts`
- Modify: `src/drivers/dialect-metadata.ts`
- Test: `tests/e2e-mysql-contract.mjs`

- [ ] **Step 1: 先完成只读和元数据**

支持连接、schema/database 目录、表/视图、列、主键、索引和外键；不先承诺所有 MySQL 特殊类型。

- [ ] **Step 2: 验证抽象裂缝**

如果需要修改 `main`、`renderer` 或公共协议才能处理 MySQL 的基本目录和查询，先补齐公共契约，再继续增加驱动能力。

- [ ] **Step 3: 增加写入和传输**

完成主键编辑、事务、完整值和 CSV 导入导出后，再将驱动标记为 Beta 支持。

- [ ] **Step 4: 验证**

```bash
DBSTUDIO_MYSQL_URL=... node tests/e2e-mysql-contract.mjs
```

## 11. P7：Beta 交付和产品化

### Task P7.1：性能和大数据基线

**Files:**

- Create: `tests/bench-resultset.mjs`
- Create: `tests/bench-transfer.mjs`
- Create: `tests/bench-metadata.mjs`
- Modify: `scripts/verify-manifest.mjs`
- Modify: `README.md`

- [ ] **Step 1: 建立固定夹具**

生成 1,000、100,000、1,000,000 行数据，包含短文本、长文本、BLOB、NULL、重复值和多列索引。

- [ ] **Step 2: 测量**

记录首屏时间、分页 p95、深分页时间、导出吞吐、峰值内存、取消延迟和元数据读取次数。

- [ ] **Step 3: 设定门槛**

首屏和分页必须保持在可接受范围；流式导出峰值内存不能随总行数线性增长；未展开的 schema 不得触发全部表结构读取。

- [ ] **Step 4: 验证**

```bash
node tests/bench-resultset.mjs
node tests/bench-transfer.mjs
node tests/bench-metadata.mjs
```

### Task P7.2：三平台产物和升级兼容

**Files:**

- Modify: `electron-builder.config.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/smoke-packaged-app.mjs`
- Create: `tests/e2e-upgrade-compat.mjs`
- Modify: `README.md`

- [ ] **Step 1: 验证安装产物**

每个平台安装或解包后完成：启动、创建 SQLite 连接、查询、编辑、关闭应用、再次启动并恢复连接配置。

- [ ] **Step 2: 验证配置升级**

覆盖旧版 connections、secrets、SQL history、saved SQL、布局和 ER 布局；迁移失败时保留原文件并生成可读错误。

- [ ] **Step 3: 验证发布门禁**

```bash
pnpm run verify:node
pnpm run verify:gui
pnpm run verify:external
pnpm run build:app:mac
pnpm run test:packaged-smoke
```

### Task P7.3：用户文档和能力矩阵

**Files:**

- Modify: `README.md`
- Create: `docs/user-guide/connections.md`
- Create: `docs/user-guide/sql-workbench.md`
- Create: `docs/user-guide/import-export.md`
- Create: `docs/user-guide/metadata-and-er.md`
- Create: `docs/support/database-matrix.md`
- Modify: `docs/superpowers/plans/2026-10-23-project-roadmap.md`

- [ ] **Step 1: 写清每个能力的支持矩阵**

按 SQLite、PostgreSQL、MySQL 分列，明确支持、部分支持、驱动不支持和 UI 不支持。

- [ ] **Step 2: 写清数据语义**

特别说明事务、导出范围、长字段、NULL、BLOB、导入失败回滚、DDL 提交和查询取消语义。

- [ ] **Step 3: 发布前自检**

文档中的每个“支持”必须能找到验证清单条目；每个“暂不支持”必须有用户可理解的替代方式。

## 12. 不纳入本轮 Beta 的能力

以下能力不作为 SQLite/PostgreSQL Beta 的发布阻断项：

- NoSQL 专用对象模型；
- 云资源管理和 Cloud Explorer；
- 完整数据库服务器监控；
- 复杂存储过程可视化编辑器；
- 多用户团队协作和远程 Web 客户端；
- AI SQL 助手；
- 细粒度 RBAC 管理；
- 完整备份恢复编排；
- 任意 JDBC 驱动的无代码加载。

这些能力需要不同的产品模型、权限边界或运行时架构，不能混入当前数据正确性和结构工作流的主线。

## 13. 提交和执行规则

每个 Task 按以下顺序执行：

1. 先写最小失败测试。
2. 只实现使该测试通过的最小代码。
3. 运行目标测试和受影响的验证分组。
4. 更新 `scripts/verify-manifest.mjs`、README 和能力矩阵。
5. 使用一个聚焦提交保存结果。
6. 进入下一个 Task 前检查 `git status --short`，禁止把未解释的生成文件或临时夹具带入提交。

阶段完成后必须输出：

- 完成的 Task 和提交；
- 通过/跳过/失败的测试数量；
- 未验证的外部服务；
- 新增的已知限制；
- 对下一阶段的接口影响。

## 14. 总体成功标准

当以下条件全部满足时，dbstudio 可以从“正在建设的早期客户端”升级为“SQLite/PostgreSQL 专业 Beta”：

- SQL 脚本不会因 PostgreSQL dollar quote 或 SQLite trigger 的分号而误切分；
- 执行计划和取消能力按方言工作；
- 导入导出采用任务和流式路径，支持取消、进度和回滚；
- 长文本、BLOB、NULL 和数字类型不会在传输中静默丢失；
- 元数据包含外键、唯一约束、索引和检查约束；
- ER 图绘制真实关系；
- DDL 操作可预览、可审阅、可撤销或明确报告不可逆风险；
- 结构比较和数据比较生成稳定、可审阅的同步计划；
- 至少 SQLite、PostgreSQL、MySQL 三个驱动通过统一契约测试；
- 三平台独立产物完成启动、升级和最小数据库工作流验收；
- 验证清单不会把 setup failure 误报为功能通过。
