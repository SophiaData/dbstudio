# P2.1 流式导出实施与验收记录

日期：2026-10-28。状态：后端基线已实施并通过本地验收；完整性与性能后续项见文末。

对应计划：`2026-10-26-dbeaver-gap-completion-plan.md` 的 P2.1。

## 实施分工

- MiniMax M3.1（`auto/minimax-m3.1-flash`）负责传输契约、主进程文件写入、连接生命周期和 IPC 集成。
- 另一名 MiniMax M3.1 负责独立边界测试，写入范围与生产实现分开。
- 监督代理负责范围控制、代码审查、统一验证清单登记、独立执行验证及更新计划。
- 本批范围为 P2.1 后端与 API；P2.2 导出向导随后接入工作区，P2.3 导入仍按原计划单独实施。

## 验收标准

| 边界 | 通过条件 |
| --- | --- |
| 数据通路 | 主进程逐批读取并写文件，等待本批写入后再请求下一批；渲染进程不接收全量数据 |
| 数据完整性 | 多批结果无遗漏；截断字段必须完整读取或明确拒绝 |
| 文件发布 | 同目录独占临时文件；成功后发布最终文件 |
| 取消和失败 | 删除本任务临时文件，保留既有目标内容，最终状态可查询 |
| 连接生命周期 | 断连、宿主退出和应用清理后，任务有终态且释放游标与文件 |
| 任务隔离 | 取消导出不会中断同一连接上的其他查询 |
| 参数校验 | 非法格式、批大小、路径和来源在入口拒绝 |
| 序列化 | CSV 引号/换行、JSON 重复列名、SQL 字符串/二进制不会静默损坏数据 |
| 只读来源 | 导出不能通过写入语句修改源数据库 |
| 一致性声明 | 若使用 LIMIT/OFFSET 重跑，明确说明不是数据库快照 |

## 改动前基线

- `pnpm run typecheck`：通过。
- `pnpm run build`：通过。
- `pnpm run verify:node`：27 项执行，27 项通过，0 跳过，0 失败。
- `DBSTUDIO_TEST_HIDDEN=1 pnpm run test:gui`：`SMOKE_PASS`。
- 未配置 `DBSTUDIO_PG_URL` 和 PostgreSQL SSL 环境；上述结果不代表真实 PostgreSQL 服务验证通过。

## 实施结果

生产改动：

- 新增 `src/core/transfer.ts`：任务请求、进度、一致性声明及格式转换契约。
- 新增 `src/main/TransferManager.ts`：逐批写入、进度、任务级取消、独占临时文件和原子发布。
- `ConnectionManager` 管理传输任务归属，断连和退出等待任务清理；阻止覆盖已保存 SQLite 库及附属文件。
- SQLite / PostgreSQL 驱动通过 `resolveTransferSource` 解析对象 id，正确生成带引用的 SELECT 和 INSERT 目标。
- main / preload 增加启动、查询进度、取消及等待结束的白名单 API。
- 新增两项测试并登记到 `package.json` 与统一验证清单。

监督审查发现并由 MiniMax 修正的问题：

1. 全批累积字符串导致内存随总行数增长，改为本批写完才读下一批。
2. 临时文件创建失败后可能误删同名文件，改为随机命名且只清理成功创建的文件。
3. 最后发布前的取消竞争、短写和关闭来源时的失败处理。
4. 首批不足页大小时被提前结束判断丢弃。
5. JSON 的 `__proto__` 列丢失及重复列名覆盖。
6. 导出目标可覆盖源 SQLite 数据库，增加实际路径与符号链接保护。

改动后独立验证：

| 验证 | 结果 |
| --- | --- |
| `pnpm run verify:node` | 29 项执行、29 项通过；包含类型检查、构建、SDK 和两项新测试 |
| `test:transfer-task` | 68 项通过，另有 1 项 PostgreSQL 服务验证因缺少环境变量跳过 |
| `test:transfer-boundaries` | 118 项通过，0 失败 |
| 真实 Electron preload 四种格式导出 | CSV、JSONL、JSON、INSERT SQL 均通过；行数、字节数核对一致 |
| SQLite SQL 导回 | 生成的 INSERT SQL 实际执行成功，数据往返一致 |
| 真实 Electron 源库防覆盖 | 明确拒绝，SQLite 文件头保持原样 |
| `DBSTUDIO_TEST_HIDDEN=1 pnpm run test:gui` | `SMOKE_PASS` |
| `DBSTUDIO_TEST_HIDDEN=1 pnpm run test:gui-connection-guard` | 16 个事务与连接保护场景通过 |
| `DBSTUDIO_TEST_HIDDEN=1 pnpm run test:gui-export-integrity` | 13 项通过，原界面的截断拒绝与正常导出行为保持正常 |

Node 清单统计的“0 跳过”指步骤级别；`test:transfer-task` 内部单独报告的 PostgreSQL 跳过不计入清单步骤统计。
不能把它理解成 PostgreSQL 实际服务已通过。

## 已知限制与后续任务

- 当前提供逐批读取、逐批写盘的任务基线，来源仍是 LIMIT/OFFSET 重跑；
  `live-paged` 不保证并发修改下的行集合一致性，深分页仍可能昂贵。
- 遇到被标记截断的文本/BLOB 明确失败；尚未实现真正的数据库流式游标及完整大字段传输。
- 监督独立复现 SQLite TEXT 的 U+0000 问题：插入 `a\0b` 后，
  `hex(v)` 返回 `610062`，但 Node SQLite 直接读取字符串只得到 `a`。
  当前已在 SQLite 查询、分页和完整单元格读取前增加数据库侧检测，发现含 NUL 的 TEXT
  就明确失败并阻止目标文件发布；这条路径不再静默导出半截文本。自动修复和原始字节无损读取仍未实现。
- 取消在批次边界生效，当前在途查询需要返回；进入原子提交阶段后不再接受取消。
- 未配置 PostgreSQL 实际服务；本批未完成十万行性能和内存基准、Windows/Linux 打包验证。
- 导出向导已接入表、结果集和筛选范围，支持四种格式、进度、取消和真实落盘；
  系统文件选择器、BOM/编码选项仍待补全。本批也未实施 P2.3 CSV 导入。
- 改动保留在工作区，未提交或推送。

## 2026-10-29 审核修复补记

> 本节是 10-28 之后的**增量**记录，**不回写**上文 10-28 的历史数字
> （改动后 `verify:node` 29/29、`test:transfer-task` 68 项、`test:transfer-boundaries` 118 项等，
> 均为当时的事实）。本节只写有文件证据的内容；最终结论以整合运行的日志为准。

### 已落地的修复

1. **导出向导 `starting` 窗口纳入关闭守卫**：`src/renderer/transfer-dialog.ts` 的
   `shouldBlockWizardClose(taskId, starting)` 在 `startTransfer` 尚未返回 taskId 时（`starting === true`）
   同样阻止关闭向导，避免「已点开始导出、任务号还没回来就把向导关掉、任务仍在后台跑」。
   回归在 `tests/e2e-transfer-wizard.mjs`：空闲允许关闭 / 运行中阻止关闭 / 启动中阻止关闭。
2. **零行导出回归补上「目标文件确实存在」断言**：此前 jsonl、sql 两种格式的期望值本身就是空串，
   文件没生成时断言照样通过（假阳性）。现在改为断言 `existsSync(emptyPath) === true`。
3. **恢复被误删的既有 SQL 字面量断言**：`INSERT` 输出中 `'user1@example.com'` 等值必须正确转义
   （断言 `sqlLinesOut[0].includes("'user1@example.com'")`）。
   证据：`backups/e2e-transfer-task.mjs.20261029-191956.pre-restore-assert.bak` 与现行
   `tests/e2e-transfer-task.mjs` 的差异**只多出**上述第 2、3 条断言，其余断言未改动。

### 无删除导出整合与收尾证据

- 运行目录：`verify-export-20261029T1925Z/`；副本脚本 `make-export-copies.mjs` 只允许四类改动
  （删掉 `rmSync` 导入与退出清理、`emptyOutDir: false`、探针 bundle 与宿主产物改指本轮新目录），
  且改前改后 `check(` / `test(` / `skip(` / `assert.` 的签名计数必须完全一致，
  副本内禁止残留 `rmSync(` / `unlinkSync(` / `rmdir` / `emptyOutDir: true` 等删除语义。
- 已产生的日志与结论：

| 日志 / 产物 | 已有结论 |
|---|---|
| `logs/make-copies.log` | 两个副本的断言签名前后一致（transfer-task `82/6/2/0/0`、transfer-wizard `117/1/0/0/0`），副本内无任何删除语义 |
| `logs/e2e-transfer-task.run.log` | **实际 80 个 `PASS` / 0 个 `FAIL` / 1 个 `SKIP`**；跳过项是 PostgreSQL 导出（未配置 `DBSTUDIO_PG_URL`，不是静默通过） |
| `logs/e2e-transfer-wizard.run.log` | **117 通过 / 0 失败**（含关闭守卫、字面量、零行等纯逻辑契约） |
| `artifacts/diff-transfer-task.patch`、`artifacts/diff-transfer-wizard.patch` | 只含允许的四类改动，**没有任何 `check(`/`test(` 行被改动**（断言零改动） |
| `sha256-src-before.txt` / `sha256-src-after.txt` | `diff` 无差异 → 运行前后导出相关源码未变 |

task 日志末尾的 `[e2e-transfer-task] 通过 81/81（跳过 1）` 是该脚本的汇总口径：
`skip()` 结果同时被视为 `passed: true`，所以 `results.length - failed.length` 把 SKIP 计入了“81 个通过”。
逐行实际标签是 80 个 `PASS`、0 个 `FAIL`、1 个 `SKIP`；本报告不把这个脚本汇总改写成“81 个实际通过”，
原始日志也不改。

### 执行命令、退出码与时间窗

`REPORT.md` 记录运行时间为 **2026-10-29 19:35 前后（Asia/Shanghai）**。
日志文件的落盘时间为 19:35:12–19:39:09；这是文件时间，不冒充未记录的精确命令起始时刻。

| 步骤 | 实际命令（REPORT 台账） | 退出码 | 结果 |
|---|---|---:|---|
| 生成无删除副本 | `node make-export-copies.mjs` | 0 | 两份副本生成，断言签名一致 |
| 存档副本差异 | `diff -u` ×2 | 1（预期：确有差异） | task / wizard patch 已存档 |
| 构建 fresh 宿主 | `node tmp-verify-import/build-host-verify.mjs <本轮>/app/driver-host` | 0 | 新宿主产物生成 |
| 导出任务行为验收 | `node e2e-transfer-task.verify.mjs` | 0 | 80 `PASS`、0 `FAIL`、1 `SKIP` |
| 导出向导契约验收 | `node e2e-transfer-wizard.verify.mjs` | 0 | 117 通过、0 失败 |
| 源哈希前后比对 | `shasum -a 256` before/after | 0 | 11 个文件全部一致 |

首次 `after` 使用了 Linux 的 `sha256sum`，命令退出 127（找不到命令）；随后用 `shasum` 重跑，
上述 11 文件校验以重跑结果为准。这里是一组分步命令，没有单独记录一个总控脚本的整体退出码，
因此不虚构总退出码；四项决定性验收步骤（副本生成、宿主构建、task、wizard）的退出码均为 0，
`diff -u` 的 1 是检测到预期差异。

### 无删除、清单与工作区收尾

| 字段 | 已核实内容 |
|---|---|
| 无删除证明 | `git status --porcelain=v1` 的 `D` / `AD` 计数为 **0**；检查命令退出 0。验证期间的 OS 临时工作目录、向导探针目录和 `app/` 产物均保留，未执行清理 |
| 源稳定性 | `sha256-src-before.txt` 与 `sha256-src-after.txt` 无差异；用 after 清单对当前文件执行 `shasum -a 256 -c`，11 项全部 `OK`，退出 0 |
| 清单同步 | `test:import-result-messages` 已登记到 `package.json` 与 `scripts/verify-manifest.mjs`；导出侧本轮未新增验证步骤，清单无需增加导出项 |
| 收尾核验 | 主审收尾执行 `pnpm run typecheck` 通过；`node tests/e2e-verify-manifest.mjs` 为 90 通过 / 0 失败 |
| 提交状态 | `HEAD` 为 `6f6ad13fae21d12622ae2be3a038ca8923a9c997`；本次未提交，收尾核对后未再修改源代码 |

同一收尾批次的无删除导入定向验收见 `tmp-verify-import/artifacts/final-20261029T111823Z/logs/full-suite.log`：
`run-2026-10-29T11-37-27` 的 7/7 步骤通过、`EXIT=0`，使用本次 fresh app/host，
外部陈旧 `out/driver-host` 进程命中 0；其中 import-task 69/0/1、GUI 113/0、CSV 30/0、
driver-safety 21/0，附加 RPC 28/0、PG 事务状态 9/0、终态文案 15/0。

### 边界声明

- **本轮导出安全修复定向验收通过**：task 实际 80 个 `PASS` + 1 个 `SKIP`、wizard 117/0，
  命令与退出码、fresh 宿主、源哈希稳定和无删除证据均已补齐。这个结论只覆盖上述导出安全修复与定向运行，
  不是把 P2.1 的全部后续项都算完成。
- 真实 PostgreSQL 导出仍未验证：`DBSTUDIO_PG_URL` 未配置，task 日志中的 PG 分支明确为 `SKIP`；
  不得把 SQLite/契约分支的通过扩写成真 PG 通过。
- 也**不声称 P2.3 或整个项目已完成**。P2.3 本轮安全修复及定向整合验收已完成，但按实际状态仍未完成的项：
  `previewImport` IPC 与完整样例预览、未映射必填列的实时校验与禁用、原生系统文件选择器、
  流式文件读取、超大 CSV 内存基准，以及**真实 PostgreSQL** 的导入成功/回滚证据
  （详见 `2026-10-29-p2-3-csv-import-plan.md` 的 §4、§7.3 与 §7.4）；
  `verify:node` / `verify:gui` 的完整清单也**没有**整体重跑。
