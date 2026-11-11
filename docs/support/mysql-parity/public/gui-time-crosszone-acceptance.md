<!--
公开脱敏副本，原文保留本地；原始SHA256=5c6ede4e21e896ab0b33dcaa9c6901e0be8d6c8830b7989c8e9ce905b7685d1c，本文件不是原始字节证据。
原文相对路径：docs/support/mysql-parity/gui-time-crosszone-acceptance.md
本副本仅做本机路径脱敏与链接重写；任务结论、表格、RED/GREEN 判定与限界与原文一致，未新增或洗白任何结论。
-->
# GUI 时间跨时区验收报告（typed TIMESTAMP(6) 跨 +08:00 再恢复 +00:00）

**结论先行**：本切片在 真实 Tauri+Rust 应用 → 自有 MySQL 8.0.46 → 独立只读观察者 三层实链上**实测为绿**。跨时区阶段 15 项既有合同检查全部为 true，`classification=VERIFIED`、`failureCode=NONE`、`chainPassed=true`、`productionReady=false`。本轮 12 个阶段合计 155 项**既有合同检查**全部为 true——这是既有合同的 check 数，不是 155 项独立能力。

**边界（同时成立，勿外推）**：Native 侧为 DOM synthetic 驱动，非 OS 可信键盘输入；不等于性能结论，不等于参考应用实操；`productionReady=false`；`materialsPreserved=true`；「不写行」仅限**本跨时区切片**——本切片内 seed 正常提交后不再写行；同一 12 阶段链中的其他编辑型 profile（grid-time pid 73212 实际 apply 1、commit 2，以及死锁/超时/重启等故障 profile）执行各自正常的写入、提交与回滚；所有材料保留、不做清理。MySQL 8.0.46 仅由父 fixture CLI 记录，本轮 raw 内未内嵌版本串，本文不替 raw 自证版本。

**口径说明**：下文带文件链接的数值可由链接文件直接复核；标注「父 job / D2 ledger」的数值取自父 job 与只读复核记录，本文不复制其原文。

## 1. 父 job 与 12 阶段事实链

父 job `bash-b4a5857251e1446f` 收齐：先 `SOURCE_ARTIFACT_VERIFIED`，随后 12 个阶段依次真实跑完，**全部 chainPassed=true、productionReady=false**；Native 各阶段 `exitCode=0`、`stdoutBytes=0`、`stderrBytes=0`、`timedOut=false`。

| 阶段 | check 数 | Native CLI pid | raw |
|---|---|---|---|
| initial | 6 | 无 CLI pid（不猜） | real-ui-report.json（原始材料仅本地保留（见原SHA索引）） |
| grid-time-crosszone | 15 | 72012 | real-ui-grid-time-crosszone-72012.json（原始材料仅本地保留（见原SHA索引）） |
| grid-time（UTC 五字段） | 16 | 73212 | real-ui-grid-time-73212.json（原始材料仅本地保留（见原SHA索引）） |
| session-timezone | 10 | 74742 | real-ui-session-timezone-74742.json（原始材料仅本地保留（见原SHA索引）） |
| grid-text | 19 | 75451 | real-ui-grid-text-75451.json（原始材料仅本地保留（见原SHA索引）） |
| grid-precision | 15 | 76340 | real-ui-grid-precision-76340.json（原始材料仅本地保留（见原SHA索引）） |
| grid-duplicate | 14 | 77158 | real-ui-grid-duplicate-77158.json（原始材料仅本地保留（见原SHA索引）） |
| grid-deadlock | 14 | 78117 | real-ui-grid-deadlock-78117.json（原始材料仅本地保留（见原SHA索引）） |
| grid-timeout（OFF/5s） | 16 | 79434 | real-ui-grid-timeout-79434.json（原始材料仅本地保留（见原SHA索引）） |
| restart-attempt | 9 | 81491 | real-ui-restart-81491.json（原始材料仅本地保留（见原SHA索引）） |
| explain | 9 | 81880 | real-ui-explain-81880.json（原始材料仅本地保留（见原SHA索引）） |
| commit | 12 | 82238 | real-ui-commit-82238.json（原始材料仅本地保留（见原SHA索引）） |

旧 candidate（dd2）的 11 项绿属**旧 source**，不套用到本 12 阶段。

## 2. 跨时区正例实测（crosszone pid 72012）

同一 owned 连接 `witnessConnectionId=460`，三步严格同序，读值只来自 raw SELECT 新 TAB：

| 步 | 期望会话 TZ | 显示真值（TS 列） | `valuesSha256` | `witnessProjectionSha256` | 新 TAB | `nativeExecuteCount` |
|---|---|---|---|---|---|---|
| baseline | `+00:00` | `2024-02-29 12:34:56.123456` | `328705bd90b5b51efe19f9e3fac0cd6e07c002ac3365de1f4e72592bf9c2409d` | `3083600ae4be6cf75a250702dfc38bfb0d75e1c237c709697e7c1f51f20c35d6` | 5→6 | 6 |
| shifted | `+08:00` | `2024-02-29 20:34:56.123456` | `f9fcae646abbd703006986bf2b57291de987848f4c56f8d3b903ff3f185e9e00` | `b923919dc4bce3d5ad60e9fa4fcef8078291854eb10282fa0faacf904deac13c` | 8→9 | 9 |
| restored | `+00:00` | `2024-02-29 12:34:56.123456` | `328705bd90b5b51efe19f9e3fac0cd6e07c002ac3365de1f4e72592bf9c2409d` | `3083600ae4be6cf75a250702dfc38bfb0d75e1c237c709697e7c1f51f20c35d6` | 11→12 | 12 |

- 三步表头类别均为 `integer,date,date,date,text,text`；`DATE=2024-02-29`、`DATETIME=2024-02-29 12:34:56.000001`、`TIME=-25:02:03.000002` 与 `01:02:03.000003` 三步不变。
- epoch 恒为 `1709210096.123456`、微秒恒为 `123456`（同一瞬间，未丢微秒）。
- `valuesSha256` 口径含 6 列名/6 类型/6 值；`witnessProjectionSha256` 口径含 11 别名/11 值，**不含 CID、不含 types**；CID 单独取用。
- 会话侧：`variables_by_thread` 自有 CID 三步 `+00:00 / +08:00 / +00:00`、`autocommit=ON`、`innodb_trx` 计数 0、`PROCESSLIST_DB` 为 own 库，观察者连接被排除。（以上为 SQL 口径名；raw 对应 `lifecycle.progress.steps[*].session` 的 `connectionId`、`sessionTimezone`、`systemTimezone`、`autocommitVariable`、`transactionCount`、`ownedDatabaseVerified` 字段。）
- 独立观察者（固定 UTC、只读、**独立只读连接**）三步行原文与 baseline 完全一致，全程未变：顶层 observer 记录 `independentConnections=3`、`readOnly=true`；逐步 observer 只记录 `sessionTimezone`/`projection`，未记录其 `connectionId`。
- UI 侧：`uiActive=false`、`uiPendingAffected=0`、`dirtyRows=0`；native 的 `native.crosszone.lastObservedTransactionState={active:false,pendingAffected:0}`（`native.methods.transactionState` 是 12 次调用计数，不是状态值）；`lastApplyResult=null`；`commitTransaction` 成功 1（仅 seed 提交），`applyEdits`/`rollbackTransaction`/`fetchCellValue`/`insertRow`/`deleteRows` 无调用记录（0）。
- GUI 子进程正常退出后采样：`knownConnectionIds=[460]`、`threads COUNT=0`、`innodb_trx COUNT=0`（只观测，不删除、不清理）。

## 3. 网格时间四阶段可见性（grid-time pid 73212）

| 视角 | baseline | draft | applied | committed |
|---|---|---|---|---|
| 本地网格（localGrid） | 旧值 | 新值 | 新值 | 新值 |
| 同一 Native DB witness（同连接） | 旧值 | 旧值 | 新值 | 新值 |
| 独立外部观察者 | 旧值 | 旧值 | 旧值 | 新值 |

- 正常 apply 1 次、正常 commit、提交后自动刷新；`applyEdits` 成功 1。
- `native.temporal.lastApplyResult.inTransaction=true` 属**历史**记录，不能当作最终当前活动态；最终 `lastObservedTransactionState` 为 `active=false/pending=0`。
- 四阶段表头类别一致为 `integer,date,date,date,text,text`；本轮不沿用旧 summary 中的 “witness” 误标签，视角名以本表为准。

## 4. 红 → 绿 因果

**红（保留归档）**：summary-cbda636c.json（原始材料仅本地保留（见原SHA索引））（SHA256 `b6235c225590dc596c0feb7402558e1ec965a11e41eca223f06189586edb12bb`）。该 run 的 crosszone 阶段 native pid 37519：`classification=KNOWN_GAP_RED`、`failureCode=DISPLAY_TYPE_MISMATCH`、`chainPassed=false`；baseline 实际列类型 `integer,date,date,date,blob,blob`（末两列落 blob），`typesDiffCount=2`、`valuesDiffCount=0`；shifted/restored **未跑**（为 null）。初始阶段 6/6 通过，native `exitCode=0`、stdout/stderr 0 字节、未超时。

**成因**：驱动 `crates/dbstudio-drivers/src/mysql.rs` 中 `management_columns` 与 `page` 两处 text arm 漏掉 TIME，charset 63 落到 blob fallback；单元格取值格式化本身早已正确，故值层无差异（valueDiff 0）。

**修复**：仅在既有 text arm 追加 2 个 token（`MYSQL_TYPE_TIME`），落在 `management_columns` 第 102 行与 `page` 第 225 行，共 2 行改动（unit report 仅支持 `productionChange.lines=[102,225]`，不据其推断更宽的上下文范围）；driver 源 `c77fc4b33d6ee2f600d41621e298ab9ec4fb40dad553ddf3ccafcc8122b9c894` → `1c965a3cad06759734923cefafc0192c8b46c0baa6a663bd3cc71b74f8f98a83`。**未做**：不改期望值、不泛化取消 binary fallback、不加 TIME2、不改 DateHours codec、不做 helper 重构。

**单测（真实 Column metadata，非 mock、非源码文本断言）**：unit-red-report.json（原始材料仅本地保留（见原SHA索引））（SHA256 `567fc0acef9e338bc183ef6a24dd850a1f9d949be795c2808ae6465c0b3342e2`）→ unit-green-report.json（原始材料仅本地保留（见原SHA索引））（SHA256 `ada264390e3dc5748c15a2e7918472125a56d2900f7f7c785607c14d0cb0ee6c`）。RED：13 项 = 12 pass / 1 fail，`exitCode=101`，断言 `blob ≠ text`（`mysql.rs:615`）；GREEN：13 项全过、`exitCode=0`。原 12 项全部保留，同一用例内同时守护 BLOB+63→blob、VAR_STRING+63→blob、VAR_STRING+45→text、DATE/DATETIME/TIMESTAMP+63→date。

**因果强度**：表头类别（color/type）因果链由 raw 直接支撑——红 raw 表头 2 处错 → 现 2 处正确，且值一致；charset 63 的判定由「唯一 fallback 路径 + 实测反推」得出，**非抓包直证**，不据此断言内核层问题。红阶段的元数据 Data D2（无阻断，1f68）与旧 unit/raw 均未改动；源码 D2 独立复核无阻断（28953dcb，父 job / D2 ledger）。

## 5. 构建与来源边界

- 新 build receipt：build-report.json（原始材料仅本地保留（见原SHA索引）），SHA256 `267d0f3f6d26c4c19099b4d4714a5f55775e4d8df5c8ab17c6c50afaa4513afb`；binary `1a2d2abaa1f3e1ba73f8123dcb22e1253d6e20989156743249a7c339aee870fd`；source snapshot `a8ee5e1a92898adeb80b35ed8de4d9586db0655031a589b4d4ba23618e56b788`。
- 该 receipt：actual 126 == expected（126 个完整测试名，逐一比对一致）；7 个 stage 全部 `exitCode=0`；输入 before/after 未变；wrapper 0 处改动；debug feature 为 `mysql-acceptance`；`productionArtifact=false`；编译参数含 `--no-bundle`。
- 旧 build receipt：build-report.json（原始材料仅本地保留（见原SHA索引）），SHA256 `a6b4ed61ff2ed20b061928dbe163e91a7c683efd846df9d761ff6f63d52c4f06`。两份公开 receipt 仅 `sourceFiles` 可比：键集合相同（23 项），**1 项 changed**（`crates/dbstudio-drivers/src/mysql.rs`）、**22 项 same**；其余字段不在可比范围，不作推断。
- source 口径：`sourceFiles` 为 **23 个直接文件**（`sourceSnapshotScope=23-direct-files-not-the-transitive-native-source-closure`），既不是 22，也不是完整传递闭包；其中含 builder 脚本本身。另有 14 项 D2 输入集（含 builder 本身），before/after 未变（父 job / D2 ledger 口径）。`sourceHead=7fadb00d6f9ee2cbf87949e9f908517c508a2956`。

## 6. 故障注入与未覆盖范围

- 重复键：服务端错误类 `1062` 保持原样；`checks` 14/14 为 true。
- 死锁：错误类 `1213` 保持原样；`checks` 14/14 为 true。
- 超时：`sessionTimeoutSeconds=5`、原错误类 `1205`、`rollbackOnTimeout=false`；16/16 为 true。**ON 语义未验**。
- 重启尝试：`credentialRestartVerified=true`、`rollbackVerified=true`；9/9 为 true。**属凭据/回滚合同，不是完整崩溃恢复**。
- 仍未覆盖（open）：完整类型矩阵、nullable/zero/DST、活动事务内 SET 负例、只读模式、BIT/BLOB 编辑、float 边界、default insert、多行插入、完整对象/transfer/compare/ER、完整恢复、SSH/TLS 全验证、跨构建凭据、参考应用实操、MySQL 8.4、Windows/OS 可信输入、8h soak、性能。

## 7. 归档与复核

- 归档目录 `docs/support/mysql-parity/evidence/gui-time-crosszone-green-a4ec3e44/`（30 个文件 = 29 raw + 1 summary）由归档步骤产出，其汇总文件为 run-acceptance-summary.json（原始材料仅本地保留（见原SHA索引））；本文不复制其内容、也不臆造其 summary 的 SHA。
- 合同侧只读引用、不修改：[gui-time-crosszone-contract.md](../gui-time-crosszone-contract.md)。
- 本报告仅陈述已发生事实；独立 Data D2（1028c59e-a058-4dfa-87e1-234cc6db4580）已 noBlock，29 raw / 155 checks / 14 canonical SHA / 规范 6 core 12 同已核；本次只调整摘要命名与审阅说明，原文未改。完整归档与 ledger 供独立复核，最终复核结论随交付总汇记录。
