# P2.3 CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 SQLite 和 PostgreSQL 上增加可预览、可校验、单事务提交且失败完整回滚的 CSV 导入能力。

**Architecture:** CSV 字节读取与解析留在主进程，解析结果只以有界预览和批次数据进入导入任务；renderer 负责选择目标表、列映射、预览错误和启动/取消任务。驱动 host 负责方言相关的批量参数化插入与事务回滚，主进程负责任务生命周期和错误定位。所有导入入口都经过 core/API/preload/driver-host 六处契约同步。

**Tech Stack:** Electron 45、TypeScript 5.9、原生 DOM/CSS、SQLite `node:sqlite`、PostgreSQL `pg`、pnpm、Node e2e 与 Playwright GUI 测试。

---

## 1. 文件边界

### Task A：CSV parser and preview contract

- Create: `src/core/csv.ts`
- Create: `tests/e2e-import-validation.mjs`
- Modify: `package.json`
- Modify: `scripts/verify-manifest.mjs`

解析器只负责 UTF-8/BOM、RFC 4180 引号、引号内换行、列数校验、重复列名、空值与 NULL 文本判定；不读取数据库、不执行 SQL、不持有文件句柄。输出必须包含列名、样例行和带行号/列名的错误。

### Task B：Import task lifecycle

- Modify: `src/core/transfer.ts`
- Modify: `src/core/api.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/ConnectionManager.ts`
- Modify: `src/preload/index.ts`
- Create: `src/main/ImportManager.ts`
- Test: `tests/e2e-import-task.mjs`

主进程负责目标文件读取、导入任务状态、进度、取消、临时解析结果清理和最终结果；renderer 不接收完整文件内容。导入失败或取消必须返回错误行/列，并确保事务由驱动回滚。

### Task C：Driver batch insert contract

- Modify: `src/core/driver.ts`
- Modify: `src/driver-host/index.ts`
- Modify: `src/main/DriverHostHandle.ts`
- Modify: `src/drivers/sqlite/adapter.ts`
- Modify: `src/drivers/postgresql/adapter.ts`
- Test: `tests/e2e-import-task.mjs`（现有集成路径经 `driver-host` 覆盖真实 SQLite，并在设置 `DBSTUDIO_PG_URL` 时覆盖 PostgreSQL；不另建独立 driver 测试文件）

增加最小的 `beginImport` / `writeImportBatch` / `finishImport` 或等价的单方法批量契约。驱动必须使用参数化 INSERT，校验目标列和类型，任何一批失败都回滚整次导入；不得把 CSV 值拼接进 SQL。

### Task D：Import wizard UI

- Create: `src/renderer/import-dialog.ts`
- Modify: `src/renderer/tree.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/style.css`
- Create: `tests/gui-import.mjs`

表节点右键进入导入向导。界面必须提供 CSV 路径、目标表、分隔符/NULL 文本、列映射、有限样例预览、错误行列表、开始/取消和终态摘要。开始按钮在存在解析错误、重复目标列或未映射必填列时禁用。

### Task E：Docs and regression

- Modify: `docs/superpowers/plans/2026-10-26-dbeaver-gap-completion-plan.md`
- Modify: `README.md`

记录导入的编码、NULL、空字符串、事务和取消语义；补充 SQLite/PostgreSQL 支持矩阵和已知限制。

## 2. 不能并行修改的共享边界

- Task B、C 都会修改 `src/core/driver.ts`、`src/core/api.ts` 和 IPC 链路，必须先完成 Task A，再按 B → C 顺序合并。
- Task D 依赖 Task B 的 API 形状，必须在 B 的类型和测试通过后开始。
- Task E 必须在 A–D 的最终契约稳定后更新，避免文档描述过时。
- SQLite/PostgreSQL 不能复用未经方言验证的 SQL 生成器；共享类型可以共用，SQL 生成必须留在各自 adapter。

## 3. 完成定义

- UTF-8 BOM、引号内换行、逗号/引号字段、空字符串和自定义 NULL 文本解析正确。
- 重复列名、缺列、多列、坏编码和非法行显示明确的行号与列名。
- 预览最多读取固定样例行，完整 CSV 不进入 renderer 内存。
- SQLite 与 PostgreSQL 都使用参数化批量 INSERT。
- 任意一行失败时，目标表不留下部分导入数据。
- 取消后任务有终态，事务回滚，后续普通查询仍可用。
- `pnpm run typecheck`、`pnpm run build`、`node tests/e2e-import-validation.mjs`、`node tests/e2e-import-task.mjs` 和 GUI 导入测试通过。

## 4. 当前执行状态

- [x] Task A：CSV 解析与纯逻辑 `previewCsv` 契约已实现，并补齐 CRLF 与解析边界回归；`tests/e2e-import-validation.mjs` 当前为 30 个 `node:test` 用例。这不等于主进程已提供 `previewImport`。
- [x] Task B：主进程导入任务、进度、取消和事务收口已实现，本轮补上连接级事务租约、在途用户写时 `startImport` 同步拒绝、RPC 超时后的隔离与 commit「结果未知」不再伪装成确定未提交；`tests/e2e-import-task.mjs` 默认覆盖任务契约和真实 SQLite，设置 `DBSTUDIO_PG_URL` 后再追加 PostgreSQL 成功/失败回滚分支，未设置时该分支明确打印 `SKIP`。
- [x] Task C：SQLite/PostgreSQL `importBatch` 参数化写入契约已实现，包含列白名单和错误行定位；本轮修复「语句成功但零影响行数不得报成功」、PG 错误摘要脱敏（不带 CSV 原值）与事务控制语句和驱动内部状态同步。安全证据目前来自**模拟 pg Client** 的回归（见下方测试口径）；本轮统一验收里 `test:import-task` 的 PostgreSQL 分支仍是 `SKIP`（环境未提供 `DBSTUDIO_PG_URL`），**仍无真 PG 证据**。
- [x] Task D：导入向导已接入并完成本轮目标契约：`previewImport` IPC 与有界样例/错误预览、latest-wins、未映射 `requiredOnInsert`（含 identity/generated）实时校验与开始按钮禁用、原生文件选择器、task 跟踪与失败后恢复。最终 GUI 导入验证为 165 通过 / 0 失败，纯逻辑导入表单回归为 28 通过 / 0 失败；5 个 node 测试登记合计 95 通过 / 0 失败。实现当前仍通过主进程 `readFile` 读取完整文件后生成有界预览，流式读取与超大 CSV 内存基准尚未完成。
- [x] Task E：README 的支持矩阵与验证分组已按当前事实修正，并记录 Task D 定向验收、后端回归和未完成边界；本轮不宣称真实 PostgreSQL 或完整 `verify:node` / `verify:gui` 已完成。

## 5. 本轮整合的安全修复记录

下列修复已由整合前的各代理落地到源码，并登记为 `node` 组验证步骤（`package.json` 脚本 + `scripts/verify-manifest.mjs`）。
**本轮安全修复及无删除定向整合验收已完成**：`full-suite.log` 为 7/7 步骤通过、`EXIT=0`，
使用本次 fresh app/host，且没有回落到陈旧 `out/driver-host`。这个结论只覆盖本节修复与 §7.3 的定向步骤，
不覆盖真实 PostgreSQL，也不等于完整清单通过。

| 修复 | 承担的验证 |
|---|---|
| 连接级导入事务租约：**导入活动期间**拒绝其它写入口（`executeStatement`/`insertRow`/`applyEdits`/`deleteRows`/DDL）与普通 commit/rollback，导入结束后恢复 | `test:import-task` |
| 在途用户写时 `startImport` **同步拒绝**：连接上已有在途的用户 DML/DDL/commit/rollback 时不建任务、不触发 `importBatch` | `test:import-task`（1e/1f 段） |
| RPC 超时隔离：超时后可靠终止宿主、标记不可用、后续调用一律拒绝 | `test:import-rpc-safety` |
| 超时后 `rollbackTransaction` 不再与仍在逐行写入的批次交错 | `test:import-rpc-safety` |
| commit 响应丢失视为「结果未知」而非确定未提交 | `test:import-rpc-safety` |
| CRLF 与引号内换行的解析回归 | `test:import-validation` |
| 语句成功但 `affectedRows = 0` 必须失败（`RAISE(IGNORE)` 触发器不得被当成写入成功） | `test:import-driver-safety` |
| PG 错误摘要脱敏：只带 SQLSTATE/约束名/行定位，不带 CSV 原值 | `test:import-driver-safety` |
| 原生 PG 事务控制语句与驱动内部记账一致（raw `BEGIN`/`COMMIT`/`ROLLBACK`/`ROLLBACK TO SAVEPOINT` 的 `active` 状态），不可靠形式明确拒绝 | `test:import-pg-transaction-state` |
| 导入终态文案分类：提交结果未知/宿主被终止/回滚失败三类都不得谎称「已回滚」 | `test:import-result-messages` |
| 前端导入失败后保留 `taskId`，可查询终态 | 已落地；GUI 证据见 §7.3（统一验收 GUI 步 113 通过 / 0 失败） |

**三点必须说清的边界（避免把证据读大）：**

1. **连接租约与 RPC 隔离是两回事，前者不由 `test:import-pg-transaction-state` 证明。**
   连接租约指 `ConnectionManager` 的两道闸：`#assertNoActiveImport`（导入活动期间拒绝其它写入口与普通
   commit/rollback）与 `#pendingWrites` 在途计数（`startImport` 同步拒绝在途用户写），
   回归在 `tests/e2e-import-task.mjs`（写入拒绝段、1e 在途用户写段、1f 在途 DML/DDL/commit/rollback 段）。
   RPC 隔离指 `DriverHostHandle` 在 RPC 超时后终止宿主、把句柄标记为不可用并拒绝后续调用，
   回归在 `tests/e2e-import-rpc-safety.mjs`。
   `tests/e2e-import-pg-transaction-state.mjs` 证明的是**第三件事**：驱动内部事务记账与
   raw 事务控制语句一致。
2. **`COMMIT_SENT` 只是测试里的假宿主日志证据，不是数据库的提交回执。**
   它由 `tests/e2e-import-rpc-safety.mjs` 的假宿主写进 `commit.log`
   （`append('commit.log', 'COMMIT_SENT pid=…')`），用途是证明「COMMIT 命令确实已经发给宿主」。
   生产代码里**没有** `COMMIT_SENT` 这个字段（`grep -rn COMMIT_SENT src/` 无命中），
   也不能据此声称「数据库确认已提交」——提交是否落库仍然未知。
3. **PG SAVEPOINT 是语句级的窄识别，不是完整的 PostgreSQL 事务语法实现。**
   已同步驱动的形式：`BEGIN`/`START TRANSACTION`、`COMMIT`/`END`、`ROLLBACK`/`ABORT`、
   `ROLLBACK … TO [SAVEPOINT]`、`SAVEPOINT`、`RELEASE`；其中 `ROLLBACK TO SAVEPOINT`
   之后事务**仍然 active**（只回退到保存点，不结束事务）。
   `AND CHAIN`、`PREPARE TRANSACTION`、裸 `START` 等无法可靠同步的形式会被**显式拒绝且不发送到服务端**。

另：`ImportManager.start` 在同一连接上已有导入任务时会拒绝第二次导入（源码
`src/main/ImportManager.ts`），本轮未检索到直接断言该拒绝的用例（`grep 已有导入任务 tests/*.mjs` 无命中），
因此不把它列为已验证项。

`tests/e2e-import-result-messages.mjs` 现已落地（15 个 `node:test` 用例，纯函数，
不启 Electron、不连数据库），并已登记为 `package.json` 的 `test:import-result-messages`
脚本与验证清单 `node` 组步骤（`scripts/verify-manifest.mjs`）。

## 6. 测试数量与证据口径

只写有独立运行日志支撑的数字，且区分模拟 PG 与真 PG：

- `tests/e2e-import-validation.mjs`（CSV 解析与预览契约）：30 个 `node:test` 用例（统一构建日志 `csv-validation.log`：30 通过 / 0 失败）。
- `tests/e2e-import-driver-safety.mjs`（真实 SQLite + 模拟 `pg` Client）：**21** 个 `node:test` 用例。
  此前文档记的 7 个是 `verify-backend-20261029T1845Z` 快照当时的规模；该测试文件此后已被修改
  （快照记录的 sha256 `5101cdb5…` → 现文件 `70135be8…`），按当前源码独立复跑为 **21 通过 / 0 失败**。
- `tests/e2e-import-rpc-safety.mjs`（真实 `DriverHostHandle` + 可控假宿主）：28 个 `check` 断言点（`PASS=28 FAIL=0`）。
- `tests/e2e-import-pg-transaction-state.mjs`（模拟 `pg` Client）：9 个 `node:test` 用例（9 通过 / 0 失败）。
- `tests/e2e-import-result-messages.mjs`（纯函数，不启 Electron、不连数据库）：15 个 `node:test` 用例（15 通过 / 0 失败）。

上述五条**全绿也不构成真 PostgreSQL 证据**：它们用替身驱动真实实现，不连服务器。
真 PG 的导入成功与回滚只认 `test:import-task` 在设置 `DBSTUDIO_PG_URL` 后的运行输出。

`tests/e2e-import-task.mjs` 与 `tests/gui-import.mjs` 的最新断言规模、以及完整后端套件与 GUI 套件的结果，
按证据分层写在 §7；此前文档里的 25 / 46 / 51 / 53 等旧统计已作废，不再作为当前通过证据引用。

## 7. 证据分层：历史快照 / 隔离验证 / 统一验收

### 7.1 历史快照（可引用，但不等于当前源码的最终验收）

`verify-backend-20261029T1845Z/REPORT.md` 是一次**独立、无删除**的后端整合验证，结论稳定：

- `e2e-import-task`：**69 passed / 0 failed / 1 skipped**（PG 分支因 `DBSTUDIO_PG_URL` 未设置明确 `SKIP`）；
- `e2e-import-validation` 30/30、`e2e-import-driver-safety` 7/7、`e2e-import-rpc-safety` 28/0、`e2e-import-pg-transaction-state` 9/9；
- 构建与运行期间 `src/` 与 5 个 `e2e-import-*` 测试的 sha256 前后比对**无差异**。

但该快照之后 **driver-safety 测试文件与部分源码又被修改**（driver-safety 现为 21 例），
因此**不能把它冒充当前源码的最终快照**，只能作为「当时的稳定性证明」引用。

### 7.2 GUI 的隔离验证（独立于统一验收）

`tests/gui-import.mjs` 现有 **113 个 `check(` 断言点**。前端代理用**隔离的最新 renderer 产物**跑过一次，
报 **113 通过 / 0 失败**（截图产出在该次运行的产物目录）。
这是一次**独立运行**的结果，**不属于**统一验收；统一验收里 GUI 步的 113/0 另有一份独立日志（见 §7.3），
两者都不能当成「清单全套通过」。

### 7.3 统一验收（定向步骤，已完成；**不等于清单全套**）

无删除定向统一验收在 `tmp-verify-import/` 下执行，日志落在
`tmp-verify-import/artifacts/final-20261029T111823Z/logs/`（产物 stamp `run-2026-10-29T11-37-27`）：

| 日志 | 结果 | 状态 |
|---|---|---|
| `full-suite.log` | **7/7 步骤通过，EXIT=0**（make-verify-copies / build-app / typecheck / csv-validation / import-task / driver-safety / gui-import） | 已完成 |
| `run-2026-10-29T11-37-27/logs/gui-import.log` | CSV 导入向导 GUI：**113 通过 / 0 失败**；截图 6 张（`01-向导` … `06-主键冲突`） | 已完成 |
| `run-2026-10-29T11-37-27/logs/import-task.log` | 69 passed / 0 failed / 1 skipped（PG 分支明确 `SKIP`） | 已完成 |
| `run-2026-10-29T11-37-27/logs/driver-safety.log` | 21 通过 / 0 失败 | 已完成 |
| `run-2026-10-29T11-37-27/logs/csv-validation.log` | 30 通过 / 0 失败 | 已完成 |
| `e2e-import-result-messages.log` | 15 通过 / 0 失败，EXIT=0 | 已完成 |
| `e2e-import-pg-transaction-state.log` | 9 通过 / 0 失败，EXIT=0 | 已完成 |
| `e2e-import-rpc-safety.log` | `PASS=28 FAIL=0`，EXIT=0 | 已完成 |
| `backend-steps.log` | 首轮编排 2/6；四步记为 FAIL，原因写的是「待运行文件含删除语义：(读不到文件)」——编排侧读不到文件，未执行到断言 | 历史，已被复跑取代 |
| `backend-steps-rerun.log` | 6/6 步骤通过（stamp `run-2026-10-29T11-33-27`） | 已完成 |

过程证据（`full-suite.log` 内嵌 + `run-2026-10-29T11-37-27/process-argv.log`）：
本次 stamp 的 driver-host 命中 74 次、本次应用/Electron 命中 216 次、外部 `out/driver-host`（其他代理）命中 0 次——
即验的是本次新构建的产物，没有回落到陈旧 `out/`。

源码一致性：`hash-timeline.txt` 的 `FINAL post` 共记录 14 个路径；主审用该清单对当前工作区复核，
14 项全部匹配。其中 PostgreSQL adapter 为 `da99d2061a6dce3f241244c4d3598f13fe89e13b98e0157e5450efb5c0ccdd53`、
SQLite adapter 为 `0ff068afac830142f55b61e2af2b9fc00f178ee6130923208610d28a3ebfd826`、
`src/renderer/import-dialog.ts` 为 `c6e6a848a38f8dba084193de5e8eaef32202271d2de101b2327bff139a02038d`。
`src/main/ConnectionManager.ts` **不在**这份 14 路径清单中，不能把“未登记”写成“哈希不匹配”；
它另与 `verify-backend-20261029T1845Z/sha256-src-after.txt` 的
`1695b711e716acf10fd06c0a5c46e418a8faccb5bf6d86e12768e9d5c42525e4` 比对为 `MATCH`。
`hash-pre.txt`（本轮基线）里 `tests/e2e-import-driver-safety.mjs` = `203b5a51…` 与最终 `70135be8…` 不同，
说明该文件在基线之后被改动过；driver-safety 的 21 例因此以本轮复跑及统一验收日志为准，最终路径已与当前一致。

主审收尾另执行 `pnpm run typecheck`，通过；`node tests/e2e-verify-manifest.mjs` 为 **90 通过 / 0 失败**；
工作区 `git status --porcelain` 的删除条目为 **0**。`HEAD` 为
`6f6ad13fae21d12622ae2be3a038ca8923a9c997`，本次未提交，收尾核对后未再修改源代码。

**这轮不是清单全套**：`verify:node` 的全部步骤、`verify:gui` 的全部 GUI 用例本轮**没有**整体重跑，
上面只是导入链路的定向验收。**不得**把它写成「项目全套通过」。

### 7.4 当前仍缺什么（不得含糊）

- **真实 PostgreSQL**：`DBSTUDIO_PG_URL` 未设置，`test:import-task` 的 PG 分支仍是 `SKIP`，真 PG 的导入成功/回滚无证据；
- **清单全套**：`pnpm run verify:node` / `verify:gui` 的完整步骤集未在本轮整体执行；
- **流式与规模基准**：当前 `previewImport` 用主进程 `readFile` 读取完整文件，再返回有界预览；流式文件读取、超大 CSV 内存基准尚未完成。有限预览不等于文件流式处理，也不证明内存与文件大小无关。

### 7.5 当前 Task D 收尾证据（2026-10-30）

本节记录本轮最终结果；§7.1–§7.3 的 2026-10-29 历史日志与路径原样保留，不回写历史数字。

- GUI 导入最终验证：**165 通过 / 0 失败**（fresh run `run-2026-10-30T17-36-31`）；覆盖 preview setup、合法映射后清空 path、预览消失后开始按钮禁用、finish/retryTracking 终态恢复 browse、native chooser 的成功/取消/异常、busy 与关闭保护。
- 纯逻辑导入表单回归：**28 通过 / 0 失败**；5 个 node 测试登记合计 **95 通过 / 0 失败**，包含 preview、column identity、required columns、file dialog 与 import form pure。
- 独立后端回归：`verify-task-d-backend-20261030T0127-EW31uq/REPORT.md`，逐套结果为 preview 5、file-dialog 22、required 3、identity 1、CSV 30、import-task 69（另 1 真 PG SKIP）、driver safety 21、RPC 28、PG transaction-state 9、result messages 15；合计 **203 PASS / 0 FAIL / 1 SKIP**。typecheck、fresh driver-host build 与候选 1 实际命中证据均 exit 0。
- 后端回归的 13 个源文件与 10 个既有测试前后 hash 一致；本轮不包含 `src/renderer/import-dialog.ts` 与 `tests/gui-import.mjs`，它们的并发 GUI 修改按 GUI 验收证据单独记录。
- 这些结果是 Task D 定向验收，不是完整 P2.3 或整个项目验收。后续仍需真实 PostgreSQL、流式读取与内存基准，以及完整 `verify:node` / `verify:gui`。

**结论：**Task D 本轮目标契约已完成并有独立 GUI、纯逻辑和后端证据；P2.3 与整个项目仍未宣称完成，原因是上述真实 PostgreSQL、流式/内存基准和完整清单验证尚未完成。
