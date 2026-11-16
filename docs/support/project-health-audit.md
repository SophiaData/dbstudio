# 项目健康审查台账

## 口径与状态

本报告记录当前工作树的静态审查发现、代码调整状态和待取得的验收证据。审查基线为 `40b824e59d43483598dd47ed4fe5cbc5ec1f9a33`；代码调整状态以报告整理时回读的工作树 diff 为准。风险等级表示触发后的影响，不表示已在真实数据库复现。候选项、设计取舍和运行证据缺口单独列出。

- **代码已调整，待最终验证**：diff 存在对应处理；不等于运行验收通过。
- **未修明确缺陷**：代码路径和触发条件有静态证据，部分有内存探针；每项说明实际证据层。
- **需决策或补证**：存在契约取舍、尚缺端到端复现或需运行数据，不能表述成已确认的运行故障。
- **阅读覆盖**：按审查者实际全文、分段和定向读取区分，不以文件枚举或搜索命中冒充全文阅读。

本报告不读取敏感 evidence JSON，不包含实际凭据、连接参数或私有业务输出。既有测试中含删除夹具的脚本没有因本报告而执行。最终验证表由 lead 补充同一次真实运行的命令、结果和证据定位。

## 当前执行索引

本索引将代码状态与证据状态分开。下文的原问题描述和历史验证表保留为来源记录；未在本索引明确标注的结果，不代表当前工作树的新鲜验收。总管为 lead，指定实施执行者为 DeepSeek；当前会话的 DeepSeek 路由被会话授权拒绝，尚未派出。总管侧取证与验证继续。

### P00 基线与归属

- 工作目录：`D:\Backup\Downloads\db\dbstudio`；分支：`audit-project-health`；HEAD：`40b824e59d43483598dd47ed4fe5cbc5ec1f9a33`。
- Git 状态：74 个已跟踪修改、16 个未跟踪文件，暂存区为空。主代理与 baseline-review 独立只读交叉核对一致。
- 全部现有补丁保留，由 lead 接管整合责任；无法仅凭 Git 证明的历史实施者不推测。问题归属不等于实施者身份，不等于验收通过。
- task-6 的台账写入归属由 lead 接管；task-9 由 lead 收尾核对最终 diff，当前 formatter 纯函数回归 8/8、根类型检查通过，任务状态已结算，最终整体门禁仍待 P17。
- P00 通过范围仅为基线、补丁归属映射与保留决策；不表示代码审查、产品测试或原问题全部通过。

### 问题编号 → 执行任务 → 当前验收状态

| 编号 | 当前代码/记录状态 | 下一执行任务 | 当前证据边界 |
| --- | --- | --- | --- |
| F01/F02 | HTTP 补丁存在 | P05 | 历史 HTTP 结果待当前重跑 |
| F03/F04/F05/F06 | UI 补丁存在 | P04 | 当前 audit-ui 28/28 通过，内存 IPC、无 DOM/数据库 |
| F07/F08/F09 | 平台护栏补丁存在 | P06 | 具体护栏仍须当前正负例；不凭相邻测试通过 |
| F10/F11 | 原生平台/事务守卫补丁存在 | P03 | Rust 路径与版本已确认，当前未重跑编译/真库 |
| F12 | 旧 MySQL generated 标记补丁存在 | P05 | fake 与真库分开验收 |
| F13/F14 | 路径/清单补丁存在 | P06 | 历史测试结果待当前验证 |
| U01 | 有快照补丁，超预算仍回退 live | P03/P07 | 部分路径修复，稳定契约未收口，不整体关闭 |
| U02/U07/U08 | 补丁存在，但独立复核仍有阻塞缺陷 | P03/P07 | U02 查询 COMMIT 绕过；U07 EOF EAGAIN/等待无期限；U08 读预算在执行后拒绝 |
| U03/U04/U05/U06 | 原生事务补丁存在 | P03 | 历史单测记录不替代当前测试；外部真库未验 |
| U09 | 二进制 SCAN 有补丁；节点 ID 仍碰撞 | P03/P14 | 见 U47；不能只按显示重名降级 |
| U10/U11 | 文本截断/尾页补丁存在 | P03 | 当前 Rust 回归待执行 |
| U12/U13/U14/U15/U16 | UI 补丁存在 | P04 | 当前 audit-ui 28/28 中包含对应回归；真实桌面/数据库未验 |
| U17/U18 | MySQL 文本 hex 补丁存在 | P04/P03 | 当前字节/真库验证分开，真实 sql_mode 往返未验 |
| U19/U20 | SDK 编码/code 补丁存在 | P05 | 当前 SDK 回归待安全入口检查，不因旧记录关闭 |
| U21/U22/U23/U24 | 文档补丁存在 | P06 | 当前实现与文档逐项对照待完成 |
| U25/U26 | fixture/host 执行证据门禁补丁存在 | P06/P14 | 当前门禁纯逻辑 10/10 通过，不等于宿主或真库已执行 |
| U27 | legacy CI 漏跑问题未见对应补丁 | P06/P14 | 不能由 native workflow 修改替代 |
| U28 | 源码 hash 换行补丁存在 | P06 | 当前平台专属跳过与原始预期保护待复核 |
| U29/U30 | 旧比较面板/树刷新补丁存在 | P05 | 当前 audit-legacy 4/4，合成 DOM 与内存服务；真实桌面未验 |
| U31 | 共享 parser 未见修复补丁 | P11 | 已有静态/内存反例，需修复及消费者验证 |
| U32 | formatter 补丁存在 | P05/P11 | 当前 formatter 8/8、根类型检查通过；不等于 U31 parser 已修 |
| U33/U34/U35/U36/U37/U40 | 共享结构比较生成器未见修复补丁 | P10 | 需支持矩阵与可信元数据边界，不生成误导计划 |
| U38/U39 | 例程错误传播/连接 ID 补丁存在 | P05 | 当前 audit-legacy 4/4，包含例程读取失败与未知方言ID；无真实数据库 |
| U41/U42/U43/U44/U45 | 测试路径/断言/夹具补丁存在 | P06/P14 | U42 覆盖实际 15 处导入的扩展文件；原脚本不能未审就跑 |
| U46 | 原子写/流补丁存在 | P05/P14 | 三份直接回归仍有删除收尾，禁止原样重跑 |
| D01/D05 | 旧 MySQL/PG 事务问题未修 | P08 | 缺隔离双连接证据，保留开放 |
| D02/D03/D04 | 旧 MySQL 主键/分页/单格补丁存在 | P05；D04同时关联P07/P13 | 有界读取不等于稳定身份，真库未验 |
| D06 | SDK 超时隔离未修 | P09 | 不得把超时解释为未提交 |
| D07/D09/D10/D11 | 流监听/SDK测试/任务回收/比较列投影有补丁 | P05/P03/P14 | 各消费入口和真实环境分别验证 |
| D08/D12 | 性能扫描/staging canary未收口 | P13 | 性能待测；无入口不擅删 |
| D13/D14/D15/D16/D17 | 环境继承/维护等级/BLOB/CSV/遗留用途待决定 | P12/P15 | 由总管汇总事实后提交契约决策 |
| F15 | test-hooks 无 fixture 时禁止生产存储回退补丁 | P06/P14 | 独立行为变化；旧 F07/U26 不覆盖全部隔离语义 |
| U47 | Redis bytes 与文本节点身份碰撞 | P03/P14 | 静态确定；当前未修、未运行复现 |
| U48 | SQLite/MySQL 普通快照无连接累计预算 | P03/P07 | 新快照保留路径的资源缺口，静态确认，未运行 OOM |
| U49 | storage 夹具临时根未规范化 | P06/P14 | macOS 常见 /var 别名可触发严格根校验拒绝；未做 macOS 实跑 |
| U50 | 架构护栏可借用其它 guard 的 exit 假绿 | P06/P14 | 当前与 HEAD 基线的纯内存变异均确认；不是本补丁新引入 |
| U51 | MySQL fixture 固定表预删且无专用库闸门 | P14 | emp/dept 为已有路径；gen_demo 预删为新增，不执行危险入口 |
| R01–R07 | 阅读覆盖仍有未闭合段 | P15 | 不宣称全仓逐文件审完 |

### P02 当前验证入口与环境

- Node `v24.18.0`、pnpm `11.21.0`；Rust 不在当前 PATH，但 `%USERPROFILE%\.cargo\bin\cargo.exe` 和同目录 rustc 可调用，均为 `1.100.0`。
- Docker CLI 存在，但 Docker Desktop Linux engine 管道不可达；本轮没有启动服务。5432/3306/6379/9092/9222 未发现监听，不等于排除了其它远程服务。
- 当前已执行：`vue-tsc --noEmit -p apps/desktop/tsconfig.json` 与根 `tsc --noEmit -p tsconfig.json`（均 exit 0）；`node --test scripts/native-test-output.test.mjs scripts/native-host-test-gate.test.mjs`（10 pass / 0 fail / 0 skipped）；`node apps/desktop/tests/audit-ui-regressions.mjs`（28 pass / 0 fail，真实 SFC 与内存 IPC、无目录/文件输出）；`node --test tests/audit-sql-format.mjs`（8 pass / 0 fail）；`git diff --check` 无错误，台账 UTF-8/行尾机械检查通过。
- 暂不执行：`tests/audit-sdk-regressions.mjs` 含 `mkdtempSync`；三份 artifact/store 新增回归含删除收尾；`e2e-mysql-contract.mjs` 对固定 `emp`、`dept`、`gen_demo` 预删。必须先处理安全入口，不能照抄历史通过命令。
- 本轮未新建目录，未启动真实数据库/GUI，未读取凭据，未执行删除或发布。report 修改前副本保存在既有 `backups` 目录中。

## 一、已有代码调整与待验收记录

### F01 · P1 · HTTP 完整 POST 被误判取消（legacy-01）

- 定位：[HTTP handler:383](../../src/main/server/http-server-handler.ts#L383)、[回归测试:146](../../tests/e2e-http-server-handler.mjs#L146)。
- 触发与影响：正常请求体读取完成也会触发 `IncomingMessage.close`。异步 dispatcher 尚未返回时，无条件 abort 会令正常查询走取消路径。
- 当前代码：`request.close` 仅在 `!request.complete || request.aborted` 时取消，保留 response/socket 断连取消。测试包含正常延迟 dispatcher。
- 验证要求：正常 POST 在 dispatch 前后 signal 均为 false；等待期间真实客户端断连后变为 true；请求完成后不会误取消后续操作。最终命令与结果见本轮状态行。
- 本轮状态：本轮已通过（node tests/e2e-http-server-handler.mjs，12 通过 / 0 失败，exit 0；含 keep-alive 复用连接用例 1 项）。

### F02 · P2 · HTTP 断连回归缺少取消前置断言（legacy-02）

- 定位：[HTTP handler 测试:143](../../tests/e2e-http-server-handler.mjs#L143)。
- 触发与影响：只断言断连后为 true，无法排除请求一开始就已取消，可能掩盖 F01。
- 当前 diff：包含正常延迟负例；测试构建保留独立目录而不删除。断连用例的完整断言链仍应由 lead 在最终验证中逐项确认。
- 验证要求：先确认等待中的 dispatcher 未取消，再执行真实 `client.destroy`，最后确认取消；不能只依靠忽略 signal 的成功 mock。

### F03 · P1 · 数据比较连接与选表不一致（UI-01）

- 定位：[ComparePanel:23](../../apps/desktop/src/components/ComparePanel.vue#L23)、[ComparePanel:49](../../apps/desktop/src/components/ComparePanel.vue#L49)。
- 触发与影响：选择 A/B 表后切目标连接 C，旧 B 表 ID 仍用于比较，生成 SQL 却装入 C 的编辑器；同名表可能使用户误执行到 C。源连接切换也有同类问题。
- 当前代码：连接变更同步清空对应表和 schema，请求前核对两侧表 ID 的连接归属。
- 验证要求：三连接同名异数据表；切连接后旧表不发 IPC，明确重新选表才能比较，生成 SQL 的目标与实际比较表一致。
- 本轮状态：本轮已修并通过（node apps/desktop/tests/audit-ui-regressions.mjs，total 28 / passed 28 / failed 0，exit 0；用例 source/target_switch_synchronously_clears_table_schema_and_plan 与 forged_source/target_table_rejected_before_compare_backend 共 4 项）。

### F04 · P2 · 多项比较计划缺少 SQL 分隔符（UI-03）

- 定位：[ComparePanel:68](../../apps/desktop/src/components/ComparePanel.vue#L68)。
- 触发与影响：生成器的各项 SQL 本身不带分号，只按换行拼接会被脚本解析器识别成一条语句。
- 当前代码：预览与载入编辑器均以 `;\n` 分隔。
- 验证要求：结构、数据计划各含至少两项，使用真实 parser 得到正确语句数；真实同步结果需单独数据库验证。
- 本轮状态：本轮已修并通过（同次 audit-ui 运行；用例 schema/data_actual_template_emits_and_previews_two_parseable_statements 共 2 项）。

### F05 · P1 · 新增 DECIMAL/NUMERIC 经 Number 丢精度（UI-02）

- 定位：[ResultGrid:155](../../apps/desktop/src/components/ResultGrid.vue#L155)。
- 触发与影响：长小数新增时在 IPC 前转成 JavaScript number，数据库接收时已无法恢复。审查内存探针确认 `0.123456789012345678901234567890` 被舍入。
- 当前代码：`numeric`、`decimal` 新增值使用 text 路径，其他数值类型保持相应分类。
- 验证要求：真实 Grid 提交 IPC 保持精确文本；真实数据库 CAST 回读完全一致，同时覆盖 NULL、非法数值和普通整数。仅编辑既有 text 单元格的 DOM 测试不能覆盖新增入口。
- 本轮状态：本轮已修并通过（同次 audit-ui 运行；用例 DECIMAL(38,18)/NUMERIC(38,18)_insert_reaches_ipc_as_exact_text 共 2 项）。

### F06 · P2 · 新建表/视图后的旧游标失效未同步到界面（UI-04）

- 定位：[DdlDialog:29](../../apps/desktop/src/components/DdlDialog.vue#L29)、[DdlDialog:42](../../apps/desktop/src/components/DdlDialog.vue#L42)、[workbench:502](../../apps/desktop/src/workbench.ts#L502)。
- 触发与影响：typed DDL 清空连接游标；create 未使既有结果失效，下一页和完整值读取继续使用旧游标。
- 当前代码：DDL 对话框所有操作均请求连接结果失效。
- 验证要求：805 行与长文本结果标签存在时新建无关表/视图，旧标签明确失效或建立新游标，不能继续发失效游标请求。
- 本轮状态：本轮已修并通过（同次 audit-ui 运行；用例 create-table/create-view_invalidates_existing_results_and_closes_old_cursor 共 2 项）。

### F07 · P2 · 原生架构护栏依赖 LF（T1）

- 定位：[原生架构护栏:52](../../scripts/check-native-architecture.mjs#L52)。
- 触发与影响：Windows CRLF 使包含精确换行的 Rust 防护片段定位失败，默认 verify 假红。
- 当前代码：读取 Rust shell 后规范 CRLF 为 LF。
- 验证要求：LF/CRLF 正例通过；移除防护、把防护移到 context/app/window 后的负例仍失败。
- 本轮状态：已修（代码+静态证据）；本机 rustup 1.29.3 / rustc、cargo 1.100.0 可用，cargo check/test 已实跑（workspace 138 passed / 8 ignored，exit 0）；scripts/check-native-architecture.mjs 本轮未单独执行，CRLF 规范化断言由静态核对覆盖，负例断言只有内存 metadata 探针核对。

### F08 · P2 · Grid 测试的 Windows 路径和 ESM URL（T2）

- 定位：[Grid 回归 harness:42](../../apps/desktop/tests/grid-workflow-regressions.mjs#L42)。
- 触发与影响：反斜杠路径不匹配目标 SFC；Windows 盘符路径作为 external ESM specifier 也无法直接导入。
- 当前代码：Vue external 转 `pathToFileURL`，clipboard 匹配兼容两种分隔符，目标组件匹配前规范路径。
- 验证要求：Windows/POSIX 目标组件正常编译，非目标组件仍隔离，真实组件 setup 被执行。最终运行记录见本轮状态行。
- 本轮状态：本轮已通过（node apps/desktop/tests/grid-workflow-regressions.mjs，total 21 / passed 21 / failed 0，exit 0）。

### F09 · P2 · legacy 架构 allowlist 在 Windows 错拒纯元数据（T3）

- 定位：[legacy 架构护栏:235](../../scripts/check-architecture.mjs#L235)。
- 当前代码：allowlist 匹配前规范路径分隔符。
- 触发与影响：纯 metadata/info import 被误认为主进程引入驱动实现。
- 验证要求：Windows 自检合法例通过，adapter/index 等带实现 import 仍被拒。

### F10 · P2 · Unix 专用 MySQL live fixture 的平台边界

- 定位：[MySQL live fixture:3](../../crates/dbstudio-drivers/tests/mysql_acceptance_live.rs#L3)。
- 当前代码：整文件 `#![cfg(unix)]`。
- 触发与影响：Unix 专用 fixture 不应阻断 Windows 普通工作区编译。
- 验证要求：Windows 工作区编译通过；Unix 上仍注册预期用例。此状态不代表 MySQL live tests 已执行。

### F11 · P1 · PostgreSQL SQL 事务别名绕过状态守卫

- 定位：[PostgreSQL:314](../../crates/dbstudio-drivers/src/postgresql.rs#L314)。
- 当前代码：SQL 事务守卫包含 `ABORT` 与 `PREPARE TRANSACTION`，要求使用 typed transaction API。
- 触发与影响：SQL 事务控制若绕过应用状态，可能使 active/pending 与服务端事务不一致。
- 验证要求：两种语句在实际执行前拒绝，已有未提交写入不变；普通 PREPARE 的支持策略另按现有契约验证。尚无本轮真实 PostgreSQL 执行证据。
- 本轮状态：已修（代码+单元测试证据）；Rust 已编译并运行单元测试——drivers lib 36、sqlite_native 21、network_native 10、nosql_native 10 通过 2 ignored、network_live 2 ignored、network_secure 4 ignored、core lib 25，均 0 failed；仍未对真实 PostgreSQL 执行（无 Docker/真实库）。

### F12 · P2 · legacy MySQL 列元数据缺 generated 映射（基线缺陷）

- 定位：[MySQL adapter:650](../../src/drivers/mysql/adapter.ts#L650)、[列元数据回归:65](../../tests/e2e-mysql-column-metadata-contract.mjs#L65)。
- 触发与影响：information_schema EXTRA 的 VIRTUAL/STORED GENERATED 未映射到 `ColumnDescription.generated` 时，D11/U12 的保守策略会把远程 MySQL 整表判为不可写。
- 当前代码：describeTable 从 EXTRA 的 `virtual generated` / `stored generated` 映射 generated 列标记；`DEFAULT_GENERATED` 不视为生成列。
- 验证：e2e-mysql-column-metadata-contract 1 通过 / 0 失败。
- 本轮状态：已修（代码+内存回归证据）。

### F13 · P2 · transfer-boundaries 注入路径在 Windows 不可解析（基线缺陷）

- 定位：[transfer-boundaries:157](../../tests/e2e-transfer-boundaries.mjs#L157)。
- 触发与影响：注入给探针的 Windows 绝对路径以反斜杠形式序列化，作为路径解析或 ESM specifier 时不可用。
- 当前代码：注入前统一把 `\` 转为 `/` 再 JSON 序列化。
- 验证：node tests/e2e-transfer-boundaries.mjs → 126 通过 / 0 失败。
- 本轮状态：已修（代码+回归证据）。

### F15 · P1 · test-hooks 运行缺 fixture 时的生产存储隔离

- 定位：[Tauri 启动](../../src-tauri/src/lib.rs)、[原生架构护栏](../../scripts/check-native-architecture.mjs)、[原生 CI 说明](../architecture/native-ci.md)。
- 代码状态：已有补丁要求测试运行使用明确 fixture，避免测试构建在 fixture 缺失时回退到实际应用数据目录及 OS 凭据存储。
- 验收：缺失/非法 fixture 在读取生产配置或创建窗口之前拒绝；正常 fixture 使用独立合成存储；默认生产构建不暴露测试桥。需要回读调用次序及运行正负例，不能只凭编译成功关闭。
- 下一任务：P06/P14；当前只确认行为补丁归属，未完成该项运行验收。

### F14 · P2 · verify-manifest 未登记 native 脚本白名单（基线缺陷）

- 定位：[verify-manifest test:55](../../tests/e2e-verify-manifest.mjs#L55)、[verify-manifest test:61](../../tests/e2e-verify-manifest.mjs#L61)。
- 触发与影响：package.json 的原生脚本不在清单测试允许清单内时，清单一致性检查失败。
- 当前代码：允许清单包含 test:native、test:native-architecture、test:native-desktop、test:native-release、test:native-ui-models、test:native-test-output、test:native-host、test:native-host-gate。
- 验证：node tests/e2e-verify-manifest.mjs → 143 通过 / 0 失败。
- 本轮状态：已修（代码+回归证据）。

## 二、原始缺陷及修复记录（当前状态以执行索引为准）

### U01 · P1 · 原生普通游标重放 SQL（drivers-D1）

- 定位：[SQLite:91](../../crates/dbstudio-drivers/src/sqlite.rs#L91)、[SQLite:188](../../crates/dbstudio-drivers/src/sqlite.rs#L188)、[SQLite:216](../../crates/dbstudio-drivers/src/sqlite.rs#L216)、[PostgreSQL:277](../../crates/dbstudio-drivers/src/postgresql.rs#L277)、[PostgreSQL:283](../../crates/dbstudio-drivers/src/postgresql.rs#L283)、[MySQL:481](../../crates/dbstudio-drivers/src/mysql.rs#L481)、[MySQL:488](../../crates/dbstudio-drivers/src/mysql.rs#L488)。
- 触发与影响：翻页或取全文重新执行原查询。`randomblob`、`UUID` 等非确定表达式的值会变化；PG `nextval` 等带副作用函数会重复执行。并发数据变化也可能改变行下标对应对象。
- 推荐：定义稳定游标契约，使用服务端游标或受预算约束快照；若保留 live 重查语义，明确限制非确定/副作用查询，完整值不得冒充原单元格。
- 验证：同一结果多次翻页与全文读取保持值和行归属，副作用计数只增加一次；覆盖三 SQL 驱动。当前为代码路径证据，未做本轮真库复现。
- 本轮状态：已修（代码+单元/真库测试证据）。三驱动实现预算约束行快照（5000 行/16MiB）+ 超预算回退 live 重查 + runQuery 返回 stable 布尔；SQLite 真库测试 5 项（snapshot_cursor_keeps_non_deterministic_values_stable_across_pages_and_full_cells、cursor_snapshot_serves_repeated_reads_from_one_execution、over_budget_results_fall_back_to_live_requery_and_report_unstable、over_budget_values_fall_back_to_live_requery、snapshot_cursor_reports_has_more_and_offsets_at_row_boundaries），PG/MySQL 为纯函数单测（stable_flag_separates_snapshot_and_live_query_pages、query_page_payload_marks_stable_only_for_snapshot_paths）；同次 Rust workspace 138 passed / 0 failed / 8 ignored。

### U02 · P1 · SQLite 导入失败仍可提交部分批次（drivers-D2）

- 定位：[SQLite:111](../../crates/dbstudio-drivers/src/sqlite.rs#L111)、[SQLite:533](../../crates/dbstudio-drivers/src/sqlite.rs#L533)。
- 触发与影响：批次前几行成功、后续行约束失败，仅返回“请回滚”，没有 failed 状态阻止 `commitTransaction`；前几行可被提交。
- 推荐：导入失败后只允许回滚，或在导入级保存点恢复后明确返回状态；不能只依赖上层调用顺序。
- 验证：第二行唯一约束失败后 commit 被拒，rollback 后零新增；覆盖前一批次已有成功数据的情形。

### U03 · P1 · SQLite 已有事务内失败语句可残留写入（drivers-D3）

- 定位：[SQLite:237](../../crates/dbstudio-drivers/src/sqlite.rs#L237)。
- 触发与影响：已有事务执行含 `RAISE(FAIL)` 的多行写，语句先写部分行再失败；只有 `own=true` 才回滚，已有事务保留未计数写入。
- 推荐：每条普通写用保存点，失败只回滚当前语句，保留此前用户事务。
- 验证：真实 SQLite trigger 反例；失败语句零残留，之前写入可继续提交或回滚，pending 与实际一致。

### U04 · P1 · MySQL 查询路径死锁后事务状态不重置（drivers-D4）

- 定位：[MySQL:193](../../crates/dbstudio-drivers/src/mysql.rs#L193)、[MySQL:207](../../crates/dbstudio-drivers/src/mysql.rs#L207)，对照 [execute:202](../../crates/dbstudio-drivers/src/mysql.rs#L202)。
- 触发与影响：query/page 返回 InnoDB 1213，服务端整事务回滚，active/pending 仍保留，后续写入可能走错误事务状态。
- 推荐：集中处理所有 MySQL 错误入口中的事务失效，不只处理 execute。
- 验证：双连接制造查询/分页死锁，1213 后状态 inactive、pending=0；后续写需重新开始事务；1205/1062 按各自语义验证。
- 本轮状态：已修（代码+单元测试证据）。query/page/execute 三路 1213 死锁统一重置 active=false、pending=0，1205/1062 不改状态（mysql.rs 单测 deadlock_aborts_transaction_but_statement_errors_preserve_it）；真实 MySQL 双连接用例 mysql_deadlock_reconciles_transaction_state 属 unix gated，本机未执行。

### U05 · P1 · PG/MySQL 批量编辑边写边校验，后续非法输入遮蔽前序成功（drivers-D5）

- 定位：[PostgreSQL:231](../../crates/dbstudio-drivers/src/postgresql.rs#L231)、[PostgreSQL:239](../../crates/dbstudio-drivers/src/postgresql.rs#L239)、[PostgreSQL:253](../../crates/dbstudio-drivers/src/postgresql.rs#L253)、[MySQL:378](../../crates/dbstudio-drivers/src/mysql.rs#L378)、[MySQL:398](../../crates/dbstudio-drivers/src/mysql.rs#L398)。
- 触发与影响：第一项成功后第二项缺键/未知列等在 SQL 前 `?` 返回，前序写入保留，却无完整 outcomes 且 pending 在循环末才累计。
- 推荐：先校验整个批次，或保证任何中途返回均回滚批次保存点/返回完整部分结果与准确计数。
- 验证：第二项非法输入后数据库、pending 和 outcomes 一致；分别覆盖 update/delete 及复合主键。
- 本轮状态：已修（代码+单元测试证据）。PG 先整批校验（任一非法行整批拒绝、零写入）；MySQL 逐行保存点执行，失败行映射为 outcome 并即时累计 pending，完整返回 outcomes（PG 单测 edit_statements_validate_whole_batch_before_any_write；MySQL 单测 edit_outcomes_report_each_row_and_aggregate_consistently）。真库语义未验证。

### U06 · P1 · PG insertRow 的 RETURNING 解码失败保留插入（drivers-D6）

- 定位：[PostgreSQL:212](../../crates/dbstudio-drivers/src/postgresql.rs#L212)、[PostgreSQL:215](../../crates/dbstudio-drivers/src/postgresql.rs#L215)。
- 触发与影响：插入成功后主键类型无法 cell 解码（如 `int[]` PK），函数报错但插入留在事务，pending 尚未累计；重试可重复插入。
- 推荐：插入及完整返回值解码处于同一语句保存点，解码失败回滚本语句。
- 验证：不支持的返回主键类型插入失败且零残留，之前事务不丢失，受支持主键正常返回。
- 本轮状态：已修（代码+单元测试证据）。RETURNING 解码失败回滚语句级保存点，pending 与真实状态一致（PG 单测 statement_recovery_keeps_known_statement_errors_recoverable）；真库未验证。

### U07 · P1 · SSH 背压与 EOF 丢弃缓冲数据（drivers-D7）

- 定位：[SSH tunnel:47](../../crates/dbstudio-drivers/src/tunnel.rs#L47)。
- 触发与影响：up/down 超过 1MiB 直接 break；任一方向 EOF 也立即退出，尚未写完的另一方向数据被丢弃，大字段/慢消费者可能断连或截断。
- 推荐：有界缓冲达到高水位时停止读该方向；分别追踪 EOF、半关闭和缓冲排空，超时给出明确错误。
- 验证：慢读/慢写、双向超过阈值、尾部 EOF 数据完整性与关闭时限；不以小包连通测试替代。
- 本轮状态：已修（代码+单元测试证据）。双向泵实现背压、半关闭、缓冲排空与超时；tunnel.rs 4 项内存 fake 单测（forwards_more_than_one_mebibyte_in_both_directions_without_truncation、one_sided_eof_does_not_discard_bytes_still_buffered_for_the_other_direction、data_keeps_flowing_after_the_client_closed_its_write_side、a_peer_that_never_becomes_writable_times_out_instead_of_discarding_data）。无真实 SSH 服务端验收。

### U08 · P2 · PG 快照缺少连接累计预算（drivers-D8）

- 定位：[PostgreSQL:113](../../crates/dbstudio-drivers/src/postgresql.rs#L113)、[PostgreSQL:307](../../crates/dbstudio-drivers/src/postgresql.rs#L307)。
- 触发与影响：单快照受 10000 行/16MiB 限制，但多个保留游标累积无总预算，反复执行 RETURNING/CTE 可持续持有内存。
- 推荐：为每连接游标数量和累计保留字节设预算，close/disconnect 释放预算，超限在写入前或保存点内拒绝。
- 验证：连续快照达到总上限后可控拒绝、无写残留；关闭游标后可再次创建，内存保持有界。
- 本轮状态：已修（代码+单元测试证据）。PG 每连接快照预算 64MiB、16 游标，读快照与 RETURNING 同计（单测 snapshot_retention_enforces_connection_budget_and_release、read_snapshot_retention_counts_toward_connection_budget）。预算按值字节计量，非 RSS。

### U09 · P2 · Redis 二进制键导致整个 SCAN 失败（drivers-D9）

- 定位：[Redis:117](../../crates/dbstudio-drivers/src/redis.rs#L117)。
- 触发与影响：合法 key 含非 UTF-8 字节，如 `0xff`，`Vec<String>` 解码使本批浏览失败。
- 推荐：按 bytes 接收，显示层采用可逆编码并保留原 key 身份；若限定文本键，明确跳过与告警策略。
- 验证：文本、空 key、非 UTF-8、相同显示前缀的不同 bytes 可区分，普通 key 不受影响。
- 本轮状态：已修（代码+单元测试证据）。SCAN 二进制 key 按字节接收，仅展示层做边界转义（nosql_native 单测 redis_native_scan_accepts_binary_keys_and_keeps_their_bytes_for_metadata、redis_native_scan_match_preserves_pattern_whitespace）。极端文本 key 与转义字面量可能显示重名，未在真实 Redis 验收。

### U10 · P2 · 文本截断的计量单位不一致（drivers-D10）

- 定位：[network:48](../../crates/dbstudio-drivers/src/network.rs#L48)。
- 触发与影响：长度按 UTF-16，预览按 Unicode scalar 截 1000 个；emoji 可超预期 UTF-16 预算，部分短文本被标记 truncated 却返回全部内容。
- 推荐：统一预览上限/fullLength 单位且不截断代理对，明确契约。
- 验证：ASCII、汉字、emoji、混合边界 999/1000/1001 的长度、truncated 和全文一致。

### U11 · P3 · SQLite 满末页误报 hasMore（drivers-D11）

- 定位：[SQLite:201](../../crates/dbstudio-drivers/src/sqlite.rs#L201)、[SQLite:214](../../crates/dbstudio-drivers/src/sqlite.rs#L214)。
- 触发与影响：末页恰好满 page size 时 `count == limit` 返回 true，界面仍允许空下一页。
- 推荐：多读一行确定尾页，或明确保守 hasMore 与空页回退契约。
- 验证：总数 0、limit−1、limit、limit+1、2×limit 的尾页状态。

### U12 · P2 · 当前页 INSERT 导出包含生成列（UI-05）

- 定位：[result-export:61](../../apps/desktop/src/result-export.ts#L61)。
- 触发与影响：全部结果列直接作为 INSERT 列，generated 列显式写入会被数据库拒绝。
- 推荐：依据目标描述投影可写列，列和值同步过滤；缺少可靠描述时拒绝生成 INSERT。
- 验证：含 generated/identity 的表导出到同结构空表，数据库计算生成值，普通列保持一致。
- 本轮状态：已修（代码+UI 回归证据）。当前页 INSERT 导出按目标列描述投影可写列，缺描述或生成列标记时拒绝（audit-ui 5 项：U12_current_page_insert_projects_writable_columns_only、keeps_plain_table_columns_and_rows、refuses_without_target_column_description、refuses_result_column_absent_from_description、refuses_when_generated_marker_is_missing；同次 total 28 / passed 28 / failed 0）。

### U13 · P2 · SQL 补全混用不同连接元数据（UI-06）

- 定位：[SqlEditor:23](../../apps/desktop/src/components/SqlEditor.vue#L23)、[SqlEditor:35](../../apps/desktop/src/components/SqlEditor.vue#L35)。
- 触发与影响：所有 roots/tabs 按表名混合；A/B 同名异列时，B 推荐 A 的列而执行失败。
- 推荐：先按当前连接筛 roots/tabs，再处理 schema/表名限定。
- 验证：同名表独有列，切换连接后候选不串；未加载对象仍遵守现有提示边界。

### U14 · P2 · 排序取消/失败留下虚假排序状态（UI-07）

- 定位：[ResultGrid:136](../../apps/desktop/src/components/ResultGrid.vue#L136)、[workbench:338](../../apps/desktop/src/workbench.ts#L338)。
- 触发与影响：先写 tab.order，再弹 dirty guard；取消或查询失败后页面数据不变但箭头改变，下一次方向也错误。
- 推荐：候选 order 在查询成功后提交，或取消/失败时恢复原状态。
- 验证：dirty 取消、执行失败、执行成功三类的 SQL、箭头、下一次方向一致。

### U15 · P2 · NULL 二进制单元格进入文本编辑（UI-08）

- 定位：[ResultGrid:81](../../apps/desktop/src/components/ResultGrid.vue#L81)、[ResultGrid:125](../../apps/desktop/src/components/ResultGrid.vue#L125)。
- 触发与影响：非 NULL blob 只读，但 NULL binary 由 column.type 得到 blob，`inputCell` 落入 text；`00FF` 不代表二进制，可能写错类型或被驱动拒绝。
- 推荐：基于列 metadata 判只读，NULL binary 同样保护；Hex 编辑另行定义契约。
- 验证：同列 NULL/非 NULL 均不产生 text update，常规 NULL 文本仍可编辑。
- 本轮状态：已修（代码+UI 回归证据）。全 NULL BLOB 列结合表描述 typeName 判定，无可靠元数据时保守只读（audit-ui 5 项：UI-08 null/nonnull blob 2 项、inferred_null_blob_column、inferred_null_text_column、null_column_without_reliable_metadata，其中 blob 只读 3 项；同次 total 28 / passed 28 / failed 0）。

### U16 · P1 · 插入成功后刷新失败允许重复提交（UI-09）

- 定位：[workbench:474](../../apps/desktop/src/workbench.ts#L474)、[ResultGrid:158](../../apps/desktop/src/components/ResultGrid.vue#L158)、[既有回归:207](../../apps/desktop/tests/sql-workflow-regressions.mjs#L207)。
- 触发与影响：insertRow 成功，随后 transactionState/reload 抛错，表单未关闭；自动主键表再次点击可新增第二行。
- 推荐：分别记录写成功与刷新失败，写后禁止重复 submit，提供独立刷新和准确状态提示。
- 验证：写成功、状态/查询失败后用户重试，insert 总次数仍为 1；真实数据库行数不增加。

### U17 · P1 · 前端 MySQL 字面量依赖反斜杠模式（UI-10）

- 定位：[sql-editor-model:185](../../apps/desktop/src/sql-editor-model.ts#L185)、[TransferDialog:93](../../apps/desktop/src/components/TransferDialog.vue#L93)。
- 触发与影响：反斜杠翻倍的字符串在 `NO_BACKSLASH_ESCAPES` 下含义改变；影响物化查询匹配及当前页 INSERT 导出，可能导出/回写错误数据。
- 推荐：使用与模式无关的 UTF-8 hex 文本表达式，参考原生 compare 的 `CONVERT(X'…' USING utf8mb4)`。
- 验证：两种 sql_mode 下反斜杠、引号、中文和换行查询及导出往返一致。现有证据为生成值的内存探针，非真库往返。

### U18 · P1 · 原生 INSERT 导出同样依赖 MySQL 反斜杠模式（core-C1）

- 定位：[data_tasks:590](../../crates/dbstudio-core/src/data_tasks.rs#L590)、[data_tasks:601](../../crates/dbstudio-core/src/data_tasks.rs#L601)。
- 触发与影响：MySQL 导出文本采用反斜杠翻倍；目标 `NO_BACKSLASH_ESCAPES` 下值不等价。
- 推荐：文本使用 UTF-8 hex 表达式，保持 PostgreSQL/SQLite 分支独立。
- 验证：含反斜杠、引号、中文、换行的 INSERT 在两种模式往返逐字段一致。若代码随后调整，须回读 diff 后移入待验证区。

### U19 · P2 · SDK 空 Uint8Array 丢失二进制身份（T4 / legacy-03）

- 定位：[SDK host:312](../../sdk/src/host.ts#L312)、[SQL 参数:148](../../src/core/sql-parameters.ts#L148)、[SDK 文档:117](../../sdk/README.md#L117)。
- 触发与影响：普通 JSON.stringify 将空 Uint8Array 编成 `{}`，宿主只兼容非空数字键对象，合法空 BLOB 被 bad_params 拒绝；SDK 文档的 HTTP wire 承诺也不对应当前通道。
- 推荐：SDK 使用明确 bytes tag/replacer，包括长度零；文档按实际 stdio 契约说明。
- 验证：SDK→真实 SQLite 的空/非空/含零字节 BLOB、NULL、空文本可区分。内存 roundtrip 已观察空 rejected、非空 accepted，不等于完整 SDK e2e。

### U20 · P2 · SDK 丢弃 RPC 错误码（legacy-04）

- 定位：[SDK host:275](../../sdk/src/host.ts#L275)、[SDK 契约测试:144](../../tests/e2e-sdk-contract.mjs#L144)。
- 触发与影响：宿主 `{code,message}` 变为普通 Error，仅 message 可用；调用方无法稳定分类，测试却只检查消息。
- 推荐：公开错误类型/属性保留 code，测试按 bad_params/query_failed/not_connected 分类。
- 验证：真实或可控宿主返回三种错误，SDK code 保留且不依赖本地化消息。

### U21 · P2 · 同连接事务范围文档错误（T6）

- 定位：[SQL 工作台指南:97](../user-guide/sql-workbench.md#L97)、[数据库矩阵:118](database-matrix.md#L118)、[实际 workbench:388](../../apps/desktop/src/workbench.ts#L388)。
- 触发与影响：文档宣称标签事务独立，实际提交/回滚覆盖同连接所有标签，误导用户对提交范围的判断。
- 推荐：明确连接级共享、跨连接独立，与确认提示一致。
- 验证：文档回读对照跨标签事务回归；真实提交范围另按运行证据说明。

### U22 · P2 · 远程部署指南启动与类型检查命令不对应 legacy（T7）

- 定位：[staging 指南:75](../deployment/remote-backend-staging.md#L75)、[staging 指南:145](../deployment/remote-backend-staging.md#L145)、[package scripts:18](../../package.json#L18)。
- 触发与影响：远程 endpoint 配合 `pnpm dev` 启动 Tauri，而该入口不提供 legacy HTTP 客户端；默认 typecheck 也仅覆盖 Vue。
- 推荐：按远程客户端实际运行时使用 `legacy:dev`、`legacy:typecheck`，明确适用边界。
- 验证：逐条对照根 script 和原生禁止 HTTP fallback 的架构契约，启动实测另列。

### U23 · P2 · 当前架构/验证/发布说明与默认入口不一致（T8）

- 定位：[backend contract:5](../architecture/backend-contract.md#L5)、[README:192](../../README.md#L192)、[README:213](../../README.md#L213)、[README:294](../../README.md#L294)。
- 触发与影响：Electron 组合根、`release/`、默认 verify 走 legacy 清单、自动 draft 发布等描述可能被当作当前原生流程。
- 推荐：当前命令与产物路径按 package/Tauri/workflow 说明，历史实现明确标记 legacy；候选包不自动正式发布不能表述成缺陷。
- 验证：文档正文与当前脚本、配置、候选 workflow 逐项一致；不以历史报告替代当前运行结果。

### U24 · P2 · 导入编码文档超出实现（T9）

- 定位：[导入导出指南:44](../user-guide/import-export.md#L44)、[TransferDialog:13](../../apps/desktop/src/components/TransferDialog.vue#L13)、[data_tasks:193](../../crates/dbstudio-core/src/data_tasks.rs#L193)。
- 触发与影响：承诺自动识别/手选编码，实际无控件且严格 UTF-8，用户可能按文档导入非 UTF-8 而失败。
- 推荐：写明仅 UTF-8 和预转换要求；若支持其他编码应另行设计验证。
- 验证：UTF-8 正常、非法 UTF-8 明确拒绝，提示与指南一致。

### U25 · P2 · 普通数据库 fixture 可零测试假绿（T10）

- 定位：[native-database-fixture:67](../../scripts/native-database-fixture.mjs#L67)，对照 [secure fixture:225](../../scripts/native-secure-fixture.mjs#L225)、[SQL secure fixture:244](../../scripts/native-sql-secure-fixture.mjs#L244)。
- 触发与影响：cargo --ignored 仅按 exit 0 标 passed；过滤名称错误或零注册测试也可通过。
- 推荐：核对预期 PG/MySQL 两个测试名及实际执行数，不能只检查 exit code。
- 验证：零用例、缺一个用例必须失败；两个预期用例实际执行才通过。

### U26 · P2 · native CI 缺宿主单元和 feature 契约执行（T11）

- 定位：[native-verify workflow:51](../../.github/workflows/native-verify.yml#L51)。
- 触发与影响：工作区测试排除 desktop，随后 build/smoke 不能覆盖宿主默认 --lib 和 mysql-acceptance 的 140 项 mysql_host 契约。
- 推荐：适用平台增加默认宿主单元测试与 feature 精确契约，区分 mock Cargo、真实 GUI 和真实驱动。
- 验证：相应契约故意失败时门禁红，输出明确执行数；构建成功不算测试执行证据。

### U27 · P2 · legacy CI 有 PG 服务但漏真实 PG 分支（T12）

- 定位：[verify workflow:115](../../.github/workflows/verify.yml#L115)、[verify workflow:125](../../.github/workflows/verify.yml#L125)、[manifest:99](../../scripts/verify-manifest.mjs#L99)、[manifest:168](../../scripts/verify-manifest.mjs#L168)、[manifest:204](../../scripts/verify-manifest.mjs#L204)。
- 触发与影响：手抄 --only 列表漏 postgresql-metadata、compare-cross-dialect，node 阶段 import-task 无 PG env 使真 PG 分支 SKIP。
- 推荐：在现有专用 PG 服务下显式执行三项，建立清单覆盖检查并检查无 SKIP。
- 验证：用例实际注册且执行，缺环境/打印 SKIP 必须使对应验收失败。

### U28 · P3 · storage 源码 hash 的 CRLF 假红（T13）

- 定位：[storage test:804](../../scripts/mysql-acceptance-storage.test.mjs#L804)。
- 触发与影响：相同源码 LF/CRLF 产生不同 hash；审查确认 LF 与基线 blob 匹配预期，不能解释成 mac CI 必红。
- 推荐：只规范换行，保留原 EXPECTED hash；不能通过改期望值掩盖问题。
- 验证：LF/CRLF 同值；删除/改名测试或改阶段仍失败。该测试另有 mac 限制，不宣称修后 Windows 全套可跑。
- 本轮状态：已修（代码+测试证据；scripts/mysql-acceptance-storage.test.mjs:838 对源码片段规范 CRLF 后再取 hash，EXPECTED 常量未改）。本机 Windows 运行 node --test scripts/mysql-acceptance-storage.test.mjs → 37 tests / 20 pass / 0 fail / 17 skipped（跳过为 POSIX mode、symlink、macOS otool/python 专属；macOS 上这些用例仍执行）。

### U29 · P2 · legacy 比较源表请求固定被另一侧覆盖（legacy-rest-01）

- 定位：[compare-panel:91](../../src/renderer/compare-panel.ts#L91)、[compare-panel:118](../../src/renderer/compare-panel.ts#L118)。
- 触发与影响：两侧 loadTables 共用 tableRequest；并发初始化时第一侧 token 恒失效，源表下拉为空，阻断数据比较。
- 推荐：每侧独立请求序号，连接切换只使自身旧请求失效。
- 验证：两种返回顺序及快速切连接，源/目标均显示各自表，旧请求不覆盖新值。

### U30 · P2 · legacy DDL 刷新找不到父节点（legacy-rest-02）

- 定位：[tree:1643](../../src/renderer/tree.ts#L1643)、[tree:1651](../../src/renderer/tree.ts#L1651)、[tree:1879](../../src/renderer/tree.ts#L1879)。
- 触发与影响：传入裸 parentId，而匹配 key 为 `kind::id`；DDL 成功后树未刷新。
- 推荐：统一父节点身份匹配，区分 ref.id 和 UI key，避免拼错 kind。
- 验证：新建、删除、重命名后对应父节点刷新，跨连接同名节点不受影响。

### U31 · P2 · SQL 切分不完整识别方言边界（legacy-rest-03）

- 定位：[sql-script:116](../../src/core/sql-script.ts#L116)、[sql-script:164](../../src/core/sql-script.ts#L164)、[sql-script:193](../../src/core/sql-script.ts#L193)。
- 触发与影响：SQLite 反引号/方括号标识符中的分号被切开；trigger 内 CASE END 提前降低 BEGIN 深度；PG E 字符串转义和嵌套注释也未单独建模。共享 parser 的消费者都需核对。
- 推荐：按方言扩充词法状态、嵌套注释和 CASE/BEGIN 层次，不用简单全局替换。
- 验证：合法反引号、方括号和 CASE trigger 的内存探针已复现错误；补 PG E 字符串/嵌套注释正例、错误位置与多语句停止规则，实际数据库执行另验。

### U32 · P2 · legacy 格式化破坏占位符（legacy-rest-04）

- 定位：[sql-format:362](../../src/renderer/sql-format.ts#L362)、[sql-format:397](../../src/renderer/sql-format.ts#L397)、[sql-format:436](../../src/renderer/sql-format.ts#L436)。
- 触发与影响：`$1`、`:name` 分成标点与数字/单词，格式化输出 `SELECT $ 1`、`SELECT : name`，绑定 SQL 不再合法。
- 推荐：占位符作为完整 token，明确 PostgreSQL cast、dollar quote 等边界。
- 验证：现有内存探针确认输出；补各方言位置/命名参数格式化前后绑定等价与幂等测试。

### U33 · P2 · PG 结构比较把所有列差异只转为 ALTER TYPE（legacy-rest-05a）

- 定位：[compare:486](../../src/core/compare.ts#L486)、[compare:493](../../src/core/compare.ts#L493)。
- 触发与影响：仅 nullable/default/PK 改变也生成 ALTER TYPE，执行后目标约束没有同步。该生成器也被原生 ComparePanel 使用。
- 推荐：按类型、可空、默认值、主键分别生成受支持 SQL；不支持者显式告警，不伪造同步完成。
- 验证：nullable-only/default-only/PK-only 独立 diff，执行后重新 capture 比较归零；已有探针只确认 nullable-only 错误 SQL。

### U34 · P2 · SQLite 约束同步生成不支持的 ALTER（legacy-rest-05b）

- 定位：[compare:518](../../src/core/compare.ts#L518)、[compare:524](../../src/core/compare.ts#L524)、[compare:527](../../src/core/compare.ts#L527)。
- 触发与影响：SQLite 新表或补约束生成 `ALTER TABLE ADD CONSTRAINT`，不受支持，计划无法执行。
- 推荐：创建时内联约束，既有表按重建计划或明确不支持，保持数据保护和审阅边界。
- 验证：FK/UNIQUE/CHECK 新表及既有表分别生成可执行计划或明确警告；不能只看字符串存在。

### U35 · P2 · 表达式索引丢表达式（legacy-rest-05c）

- 定位：[compare:511](../../src/core/compare.ts#L511)、[compare:515](../../src/core/compare.ts#L515)。
- 触发与影响：忽略 expression，columns 为空时生成 `CREATE INDEX ... ()`；非空时也可能改变索引语义。
- 推荐：可靠保留表达式，无法安全重建时跳过并告警。
- 验证：纯表达式、普通、混合索引计划的 SQL 及重捕获结果；内存探针已观察空括号。

### U36 · P2 · 外键动作在同步 SQL 中丢失（legacy-rest-05d）

- 定位：[compare:518](../../src/core/compare.ts#L518)。
- 触发与影响：忽略 onUpdate/onDelete，目标外键采用默认动作，与源语义不同。
- 推荐：白名单校验并输出完整动作，未知动作拒绝自动生成。
- 验证：CASCADE/SET NULL/RESTRICT 的计划和实际约束一致，动作变化可检测。

### U37 · P2 · 同名约束变化和删除没有完整同步（legacy-rest-05e）

- 定位：[compare:504](../../src/core/compare.ts#L504)。
- 触发与影响：约束逻辑仅新增 missing，没有完整删除/重建同名变化；计划可能冲突或保留目标多余约束。
- 推荐：明确新增、删除、同名变更的支持矩阵，破坏性操作只生成审阅计划；不支持项告警。
- 验证：同名不同定义、目标多余约束及名称冲突；重复比较不能伪称归零。

### U38 · P1 · 例程读取失败被当作源端不存在，生成 DROP（legacy-rest-06）

- 定位：[metadata service:212](../../src/main/application/metadata-application-service.ts#L212)、[metadata service:222](../../src/main/application/metadata-application-service.ts#L222)、[compare:448](../../src/core/compare.ts#L448)。
- 触发与影响：权限/网络错误被吞成空数组，再比较正常目标时生成删除所有目标例程的 SQL。计划虽需用户执行，但错误输入被包装成破坏性建议。
- 推荐：区分 unsupported、读取失败与真实空列表；快照标注未知，比较禁止据未知生成 DROP。
- 验证：源端 listRoutines 抛错时零 DROP 且明确错误/告警；真实空列表与正常定义仍按契约比较。

### U39 · P1 · 未知方言连接未占用序号，后续新建可覆盖配置（legacy-rest-07）

- 定位：[connection-catalog:145](../../src/main/application/connection-catalog.ts#L145)、[connection-catalog:153](../../src/main/application/connection-catalog.ts#L153)、[connection-catalog:157](../../src/main/application/connection-catalog.ts#L157)、[ConnectionStore:238](../../src/main/ConnectionStore.ts#L238)。
- 触发与影响：载入未知方言 c1 时先 continue 再 bump，新建可再次生成 c1；按 ID 保存时可能覆盖保留配置。内存探针已确认前半序号碰撞。
- 推荐：所有持久化 ID 先占用序号/唯一性，再按支持情况展示；保存层也拒绝意外覆盖。
- 验证：未知 c1/cN 与已知连接混合启动，新建 ID 唯一，原配置逐字段保留；不读取用户真实配置。

### U40 · P2 · 结构比较遗漏 identity/generated 定义（legacy-rest-08）

- 定位：[compare:543](../../src/core/compare.ts#L543)、[ColumnDescription](../../src/core/model.ts)。
- 触发与影响：columnSql 不输出 PG GENERATED AS IDENTITY 和生成列表达式，生成列变普通列；当前 generated 契约仅 virtual/stored，无法完整重建表达式。
- 推荐：先补可信元数据契约，无法重建时明确阻止/告警，而非把列降级普通列。
- 验证：PG identity、各方言 generated 表建表 SQL 的语义一致；不支持表达式必须可见。

### U41 · P2 · packaged-smoke 绝对路径断言只接受 POSIX（tests-rest-01）

- 定位：[packaged-smoke test:69](../../tests/e2e-packaged-smoke.mjs#L69)。
- 触发与影响：合法 Windows 盘符绝对路径不以 `/` 开头而假红。
- 推荐：使用 `path.isAbsolute` 并保持禁止 `:memory:` 的断言。
- 验证：Windows 盘符、UNC、POSIX 绝对路径和相对路径负例。当前仅静态审查。

### U42 · P2 · 多份 legacy 测试手拼 file URL（tests-rest-02）

- 定位：[remote-connection-flow:27](../../tests/e2e-remote-connection-flow.mjs#L27)、[owner-connection-lease:28](../../tests/e2e-owner-connection-lease.mjs#L28)、[sql-script-parser:33](../../tests/e2e-sql-script-parser.mjs#L33)、[connection-lifecycle:40](../../tests/e2e-connection-lifecycle.mjs#L40)、[driver-host-stress:73](../../tests/e2e-driver-host-stress.mjs#L73)、[sql-library:53](../../tests/e2e-sql-library.mjs#L53)、[statement-execution:231](../../tests/e2e-statement-execution.mjs#L231)。
- 触发与影响：`file://${Windows path}` 不是正确 ESM URL，测试在进入业务断言前失败，空格/特殊字符也有风险。
- 推荐：统一用 `pathToFileURL(...).href`，保持各脚本原有测试边界。
- 验证：Windows 和 POSIX、含空格/Unicode 路径动态导入成功；本轮未执行含删除的测试脚本。

### U43 · P2 · compare-live 负例因 Promise ID 与任意异常假绿（tests-rest-03）

- 定位：[compare-live:179](../../tests/e2e-compare-live.mjs#L179)、[compare-live:193](../../tests/e2e-compare-live.mjs#L193)、[compare service:79](../../src/main/application/compare-application-service.ts#L79)、[compare service:125](../../src/main/application/compare-application-service.ts#L125)。
- 触发与影响：async tableId 没有 await，resolver 先因 Promise 失败，任意异常 helper 判通过；BLOB 非键列实际应跳过并告警，其“拒绝”期望也过时。
- 推荐：await 真实 ID；无主键断言特定语义，BLOB 改断言跳过列/告警和可比较非二进制结果。
- 验证：无效 ID 与预期业务拒绝分离；故意移除无主键保护时测试红；BLOB 正常路径实际运行。

### U44 · P2 · PG metadata 失败分支提前 return，进程仍可成功（tests-rest-04）

- 定位：[PG metadata test:361](../../tests/e2e-postgresql-metadata.mjs#L361)、[PG metadata test:376](../../tests/e2e-postgresql-metadata.mjs#L376)、[汇总:578](../../tests/e2e-postgresql-metadata.mjs#L578)。
- 触发与影响：conn.ok/childDesc.ok 失败后 check(false) 并 return，绕过末尾设置 process.exitCode，finally 正常时 exit 0；verify 可能假绿。
- 推荐：失败立即 throw 或设置 exitCode，汇总通过 finally/统一出口执行。
- 验证：分别注入连接失败与 describe 失败，进程非零且汇总失败数正确；成功分支不变。

### U45 · P1 · PG metadata fixture 对外部库预删固定命名空间（tests-rest-05）

- 定位：[PG metadata test:225](../../tests/e2e-postgresql-metadata.mjs#L225)。
- 触发与影响：对外部 `DBSTUDIO_PG_URL` 启动即 `DROP SCHEMA IF EXISTS dbstudio_meta_probe_${pid} CASCADE`，无专用库守卫，PID 复用或名称碰撞可删除残留/同名对象。
- 推荐：专用测试库显式闸门、随机 run 命名、CREATE 不预删；按保留式 fixture 管理，不触碰已有对象。
- 验证：非专用连接在任何 DDL 前拒绝，既有同名 schema 不删除，独立运行不碰撞。本轮未执行该测试。
- 本轮状态：已修（代码+静态证据）。专用库闸门 DBSTUDIO_PG_DEDICATED=1（已设置 DBSTUDIO_PG_URL 但缺该变量时 exit 1 且不建立连接）、随机 run 后缀 schema、取消启动预删、保留式不删对象；e2e-postgresql-metadata 本轮未运行。

### U46 · P2 · Windows temp+rename 覆盖持柄目标文件返回 EPERM（基线缺陷）

- 定位：[rename-atomic:1](../../src/main/rename-atomic.ts#L1)、[ConnectionStore:428](../../src/main/ConnectionStore.ts#L428)、[SqlLibraryStore:196](../../src/main/SqlLibraryStore.ts#L196)、[TransferManager:440](../../src/main/TransferManager.ts#L440)、[artifact-store:156](../../src/main/server/artifact-store.ts#L156)、[artifact-store:617](../../src/main/server/artifact-store.ts#L617)、[artifact-store:261](../../src/main/server/artifact-store.ts#L261)。
- 触发与影响：Windows MoveFileEx 在目标文件正被其它句柄打开（并发读取、索引器、杀毒扫描）时返回 EPERM/EBUSY/EACCES；artifact 元数据与上传数据、连接与 SQL 库存储、导出提交的 temp→rename 覆盖会失败。
- 当前实现：统一共享 `src/main/rename-atomic.ts`，win32 上仅对 EPERM/EBUSY/EACCES 按 5/10/20/40/80ms 有界退避并复用同一 tmp，非 win32 及其它错误码不重试；同步 store 与异步调用方共用同一组错误码与退避序列。artifact-store 另以按路径串行队列（#withMetadataLock）消除自身持柄冲突。
- 验证：e2e-http-artifacts 15 通过 / 0 失败；e2e-store-write-atomicity 7 通过 / 0 失败；e2e-artifact-write-atomicity 5 通过 / 0 失败（含 Windows 真实持柄用例）。
- 本轮状态：已修（代码+测试证据）。

### U47 · P2 · Redis 二进制键与文本键的节点 ID 碰撞

- 定位：[Redis display_key](../../crates/dbstudio-drivers/src/redis.rs#L98)、[节点 ID 生成](../../crates/dbstudio-drivers/src/redis.rs#L165)。
- 触发：二进制单字节 `0xff` 显示为四个文本字符 `\xff`，合法 UTF-8 文本键 `\xff` 原样显示；两者的 `id` 都从显示值生成，得到相同节点身份。
- 影响：不是仅显示重名；UI 或元数据消费者按 ID 去重/定位时会混淆不同实际键。TYPE/PTTL 当前仍使用原始 bytes，不据此声称发生数据库写入或读取了其它键的值。
- 推荐：原始 bytes 生成可逆、无碰撞的 opaque ID，显示名称单独处理；核对连接及数据库作用域，保留文本键可读性。
- 验收：同一 SCAN 同时包含 `0xff`、文本 `\xff`、空键、NUL、冒号和反斜杠组合时节点 ID 唯一；元数据命令仍收到正确原始 bytes。当前为源码路径证据，未运行复现、未修复。
- 下一任务：P03/P14。U09 二进制 SCAN 支持不能据此整体关闭。

## 三、需决策或补运行证据

### D01 · P1 候选 · legacy MySQL executeStatement 绕事务/DDL 守卫（legacy-05）

- 定位：[MySQL adapter:945](../../src/drivers/mysql/adapter.ts#L945)、[事务状态:339](../../src/drivers/mysql/adapter.ts#L339)、[ensureTransaction:1057](../../src/drivers/mysql/adapter.ts#L1057)、[专用 DDL 守卫:1241](../../src/drivers/mysql/adapter.ts#L1241)。
- 触发与影响候选：网格未提交写后执行 SQL DDL 可能隐式提交；手写 BEGIN/DML 后网格再次 START TRANSACTION 可能提前提交；状态不随手写事务命令同步。
- 推荐：统一通用 SQL 与 typed DDL 的事务守卫，按服务端语义管理事务。
- 补证：专用 MySQL 双连接测试提交前可见性、rollback 回读和 DDL 拒绝时机。当前只有静态链路，未声称真库复现。
- 本轮状态：需决策（未修；缺真实 MySQL 双连接证据，本机未启动真实 MySQL）。

### D02 · P1 候选 · legacy MySQL 行编辑不核真实完整主键（legacy-06）

- 定位：[MySQL adapter:1075](../../src/drivers/mysql/adapter.ts#L1075)、[MySQL adapter:1141](../../src/drivers/mysql/adapter.ts#L1141)、[mutation service:154](../../src/main/application/mutation-application-service.ts#L154)。
- 触发与影响候选：只核 key 非空，非唯一字段或半个复合键可形成多行 UPDATE/DELETE；上层只转发主键契约。
- 推荐：驱动依据元数据核对全部且仅有主键列，执行前拒绝不完整身份。
- 补证：重复非主键、复合主键缺列、无主键请求均在执行前拒绝，数据库逐行不变；使用专用库。
- 本轮状态：已修（代码+内存回归证据）。驱动依据元数据核对全部且仅有主键列，不一致时拒绝且不下发任何写 SQL；e2e-mysql-legacy-repair 中 D02 用例 5 项（同次 10 pass / 0 fail）。真实 MySQL 双连接证据仍未取得。

### D03 · P2 候选 · legacy MySQL SELECT 忽略分页参数（legacy-07）

- 定位：[MySQL adapter:951](../../src/drivers/mysql/adapter.ts#L951)、[已有 query:894](../../src/drivers/mysql/adapter.ts#L894)。
- 触发与影响候选：executeStatement SELECT 全量 conn.query，固定 offset=0/hasMore=false，忽略 limit/offset/keepCursor；大结果集产生内存和 IPC/HTTP 压力。
- 推荐：可分页 SELECT 复用 query，SHOW/CALL 单独明确返回契约。
- 补证：真实多页数据 limit=2、offset=1、keepCursor=false，核返回形态和实际查询范围，不以响应上限代替读取有界。
- 本轮状态：已修（代码+内存回归证据）。executeStatement 的 SELECT 复用分页路径（limit/offset/keepCursor/游标契约），非 SELECT 不伪造分页字段；e2e-mysql-legacy-repair 中 D03 用例 3 项（同次 10 pass / 0 fail）。真实 MySQL 未验收。

### D04 · P2 候选 · legacy MySQL 取单格重查全部结果（legacy-08）

- 定位：[MySQL adapter:1170](../../src/drivers/mysql/adapter.ts#L1170)。
- 触发与影响候选：fetchCellValue 重新执行完整原 SQL，再在 JS 取目标行，单格读取也可能载入大表。
- 推荐：稳定游标/快照，或受契约约束的 LIMIT 1 OFFSET 查询，和 U01 的稳定身份要求一致但单独保留性能问题。
- 补证：非零 offset 与 BLOB 内容正确，服务端实际返回行数有界；本轮无真库/内存峰值数据。
- 本轮状态：已修（代码+内存回归证据）。可分页 SELECT 的 fetchCellValue 用 LIMIT 1 OFFSET 有界读取；e2e-mysql-legacy-repair 中 D04 用例 2 项（同次 10 pass / 0 fail）。真实 MySQL 未验收。

### D05 · P1 候选 · legacy PG RETURNING 绕过应用事务（legacy-09）

- 定位：[PG results:354](../../src/drivers/postgresql/results.ts#L354)、[PG adapter:1302](../../src/drivers/postgresql/adapter.ts#L1302)、[PG adapter:1323](../../src/drivers/postgresql/adapter.ts#L1323)。
- 触发与影响候选：RETURNING 写语句被归为 rows，直接 runQuery，绕过 affected 分支 ensureTransaction/pending；可能自动提交且无法工具栏回滚。
- 推荐：是否写入与是否返回行独立分类，结果形态不得决定事务保护。
- 补证：真实 PG 双连接比较相同 UPDATE 带/不带 RETURNING，提交前不可见，回滚后原值，返回行及状态准确。
- 本轮状态：需决策（未修；缺真实 PG 双连接证据，本机未启动真实 PG）。

### D06 · P2 · SDK 事务超时后的未知结果边界（T5 / legacy 补证）

- 定位：[SDK host:306](../../sdk/src/host.ts#L306)，对照 [桌面 host:226](../../src/main/DriverHostHandle.ts#L226)。
- 触发与影响：commit/rollback 超时只删除 pending 并 reject，宿主可能仍执行并接收后续请求；不能把超时表述成提交失败/已回滚。
- 推荐：决定并实现事务边界超时隔离策略，终止宿主、拒绝在途并标记结果未知；恢复连接后由用户核对。
- 补证：可控 fake host 延迟事务回帧，超时后无第二业务请求，错误准确；未执行长超时动态探针。

### D07 · P2 候选 · artifact 输出流错误监听空窗（legacy 补证）

- 定位：[artifact-store:511](../../src/main/server/artifact-store.ts#L511)。
- 触发与影响候选：WriteStream 创建到 finishStream 挂监听之间，write 返回 true 后的异步 error 可能无监听，导致未处理异常。
- 推荐：从创建起安装持续 error 监听，以统一完成/失败路径结算，保留安全落盘边界。
- 补证：可控流注入 write=true 后异步错误，进程不崩溃、请求正确失败、无误报完成。没有动态复现前不列已确认崩溃。
- 本轮状态：已修（代码+回归证据）。输出流从创建起挂 error 监听并统一失败结算；e2e-artifact-stream-errors 2 通过 / 0 失败（write() 返回 true 后异步 error：上传失败、进程无未捕获异常、不误报完成）。

### D08 · P3 · artifact 分块上传元数据扫描成本（legacy 补证）

- 定位：[artifact-store:522](../../src/main/server/artifact-store.ts#L522)。
- 触发与影响候选：每 chunk 扫描/解析全部 metadata，随 chunks×artifacts 放大。
- 推荐：先测目标规模，再决定索引/缓存与一致性策略。
- 补证：固定 chunk 与 artifact 阶梯规模的吞吐、延迟和 I/O 计数；当前没有性能退化实测结论。

### D09 · P2 · SDK 契约测试声明超出断言（legacy 补证）

- 定位：[SDK test:1](../../tests/e2e-sdk-contract.mjs#L1)、[SDK test:120](../../tests/e2e-sdk-contract.mjs#L120)、[SDK test:144](../../tests/e2e-sdk-contract.mjs#L144)。
- 触发与影响：说明包含完整值/导出块/错误码，正文只查截断预览、没有完整值/导出块调用，错误码也仅测 message。
- 推荐：补相应调用和精确断言，或收窄测试声明；U20 的 code 问题独立保留。
- 验证：主动破坏完整值/导出块实现时对应测试红，声明与实际覆盖一一对应。
- 本轮状态：已修（代码+测试证据）。SDK 契约测试声明收窄，移除 SDK 无公开面的「完整值/导出块」，错误断言升级为精确 error.code；e2e-sdk-contract 37 通过 / 0 失败。

### D10 · P2 · TaskRegistry 达到累计任务上限需重启（core-C2）

- 定位：[TaskRegistry:95](../../crates/dbstudio-core/src/data_tasks.rs#L95)。
- 触发与影响：任务记录累计 256 后拒绝继续导入/导出并要求重新打开应用；完成任务也占预算。
- 需决策：保留历史上限作为产品限制，或对终态任务分页/淘汰且不影响在途任务。
- 验证：达到上限后的 UX、任务历史与取消/关闭语义，不能只提高常量。
- 本轮状态：已修（代码+单元测试证据）。任务注册满额时回收最旧终态任务，活动任务不动；core 单测 finished_tasks_are_reclaimed_oldest_first_while_running_work_keeps_its_slot、only_terminal_tasks_are_reclaimed_so_a_full_active_registry_still_rejects_new_work。

### D11 · P2 候选 · 原生数据比较写 generated 列（core-C3）

- 定位：[原生 compare:455](../../crates/dbstudio-core/src/compare.rs#L455)、[原生 compare:470](../../crates/dbstudio-core/src/compare.rs#L470)。
- 触发与影响候选：INSERT 使用源行全部 values，UPDATE 使用全部 changed；若 generated 列包含在投影中，会生成不可写 SQL。
- 推荐：按目标可写元数据投影，生成列参与展示比较与写入计划分离；缺描述时阻止自动计划。
- 补证：构造 generated 表数据差异，确认读取投影、计划列及实际数据库结果。与 U12 的当前页导出入口分开验收。
- 本轮状态：已修（代码+单元测试证据）。比较写入计划按目标可写元数据投影，剔除 generated/hidden/identity ALWAYS，identity BY DEFAULT 可写；缺生成列标记时整表拒绝（core 单测 target_writability_metadata_excludes_generated_hidden_and_always_identity_columns、unreliable_target_descriptions_refuse_to_generate_a_write_plan、insert_plan_projects_writable_columns_and_keeps_names_aligned_with_values、update_plan_never_writes_generated_columns_but_keeps_them_in_the_visible_diff、generated_only_differences_are_reported_but_cannot_produce_an_update）。真实数据库未验收。

### D12 · P2 · staging canary 结果形态过时（tooling-D1）

- 定位：[staging runner:80](../../scripts/staging-verify/runner.mjs#L80)、[结果契约:69](../../src/core/resultset.ts#L69)。
- 触发与影响：读取二维数组或 row.staging_probe，但真实 rows 为 `{index,cells}`，合法数字 1 也被判 false；现有脚本无调用入口。
- 需决策：保留时修真实契约并补最小运行入口，或明确历史隔离；不擅自删除。
- 验证：真实 ResultRow 数字 1 正例及错误值/错误形态负例；内存形态探针已确认不匹配，未宣称 staging 实跑。

### D13 · SDK 子进程环境继承策略（tooling-D2）

- 定位：[SDK host:140](../../sdk/src/host.ts#L140)。
- 当前事实：SDK 继承全 env；桌面主进程有特定 HTTP/backend 环境过滤。
- 需决策：SDK 是否承诺相同隔离策略；Node 默认继承本身不直接定性安全缺陷。
- 验证：使用合成变量测试允许/过滤清单和必要运行变量，不输出实际环境内容。

### D14 · legacy / SDK / 发布边界（tooling-D3）

- 定位：[package scripts](../../package.json)、[候选发布 workflow](../../.github/workflows/release.yml)。
- 需决策：legacy 客户端、HTTP、SDK 的受支持范围与维护层级；保留代码本身不是缺陷。
- 验证：支持矩阵、实际命令和 CI 口径一致；候选包不自动公开 Release 是既定边界，不能当作缺少发布步骤。

### D15 · BLOB 只读与专用 DOM 验收要求不一致（UI-D1）

- 定位：[mysql-parity-dom:1424](../../apps/desktop/src/mysql-parity-dom.ts#L1424)、[ResultGrid:117](../../apps/desktop/src/components/ResultGrid.vue#L117)。
- 当前事实：生产 BLOB 只读，专用场景要求编辑并最终得到 READ_ONLY_BINARY。
- 需决策：验收按已支持能力判预期拒绝，还是另立二进制编辑需求；测试不能自行成为产品需求。
- 验证：生产与 feature UI 的能力声明、提示、断言一致，不以预期不支持误报产品回归。

### D16 · 当前页 CSV 的 NULL / 空串交换契约（UI-D2）

- 定位：[result-export:46](../../apps/desktop/src/result-export.ts#L46)、[TransferDialog:14](../../apps/desktop/src/components/TransferDialog.vue#L14)。
- 当前事实：CSV NULL 和空串均输出空字段，导入默认 NULL 标记为 `\N`；重新导入可能有损。
- 需决策：明确仅展示导出，或设计可往返交换契约并展示 NULL 标记。
- 验证：NULL、空串、字面量 `\N`、引号/换行分别往返，明确无法无损的选项。

### D17 · UI 遗留组件与样式用途（UI-D3）

- 定位：[TreeBranch](../../apps/desktop/src/components/TreeBranch.vue)、[样式:38](../../apps/desktop/src/style.css#L38)、[样式:101](../../apps/desktop/src/style.css#L101)。
- 当前事实：TreeBranch 仅自递归，App 使用 MetadataTree；部分 sql-editor、er-canvas/edges/table/column 样式未见当前 consumer。
- 需决策：确认遗留用途与后续载体，未授权清理，不把无 consumer 直接认定运行缺陷。
- 验证：定向引用核查和构建产物使用检查；本报告不删除或重构。

## 四、阅读覆盖与排除

### R01 · 原生 UI

审查者声明 `apps/desktop` 42 个跟踪文本文件全部全文阅读：入口 HTML、tsconfig、Vite 配置，App/backend/clipboard/connection-form/dialogs/main，mysql-parity-dom（1514 行）、native-smoke、native-tool-smoke、result-export、sql-editor-model、style、tree-model、workbench，14 个 Vue 组件，以及 grid/pure/sql-workflow 回归、pure-entry 和 sql-editor-dom 的 Fixture/README/cases/fixture HTML/TS/run/server。

直接契约对照包括 package、Tauri lib（516 行）与配置/Cargo/capability，TS API/resultset/filter-sql，原生 compare/session 全文及 lib 定向片段，TS compare/parser、三 SQL 驱动定向片段。未全文审查 Tauri secrets/mysql_acceptance/smoke 内部。

实际内存探针覆盖两项 SQL 计划被识别为一条、长小数数值舍入、MySQL 字面量生成。真实 SFC 内存编译中观察到调整后的 Compare 会清空表且不发 IPC；这不是完整组件回归 PASS。未执行 GUI/Tauri/真实数据库业务测试、文件导入导出、实际凭据操作。

### R02 · 原生 drivers / protocol / core / Tauri

审查者声明 drivers 全部源码、6 个集成测试和 protocol 全文读取；core 全部源码和 3 个集成测试全文，Tauri lib/secrets 全文。Tauri 大型 mysql/smoke 仅入口读取，不能视为全文覆盖。Rust 工具链执行结果以最终验证表为准（cargo check/test，workspace 138 passed / 8 ignored）；所有真实 SQL/TLS/SSH/NoSQL 缺陷路径须按各项补证。

### R03 · tooling / SDK / 当前文档

分区共有 314 个跟踪文件；docs 241 个，其中 169 个历史 evidence JSON 未打开。当前架构、用户指南、CI/发布、部署、验收汇总和公开 MySQL 进度为主要文档覆盖；历史计划与其余专项合同未逐篇全文。

全文包括根 package/Cargo workspace 与四成员 Cargo、根 TS/Electron/pnpm 配置、3 个 workflow、两个 plist、SDK 全部跟踪文本；scripts 中 native build/version/gate/smoke、3 个原生 DB fixture、legacy manifest/verify、两类架构护栏/bundle、SDKbuild、HTTPbuild/start、legacy release/publish/packaged-smoke、staging config/security/runner、mysql storage 模块/driver runner。大型 MySQL UI runner 2184 行仅首 180 行；storage test 808 行仅首 190、190–216、730–808 行；其他 fixture 为定向读取。

实际只读探针包括架构 selftest、内存 bytes、源码换行/hash/Git blob/140 测试名交叉、合法 QueryResult canary 与 Windows 绝对路径。未安装、构建、完整 verify、数据库、GUI、签名或发布。图标二进制和两份大锁文件未内容审计，不宣称 314 文件逐个读完。

### R04 · legacy 已完成审查范围

全文包括 HTTP handler/auth/JWT/composition/connection-routes/artifact-store/runtime/governance，query service/cursor registry/remote/dispatcher，SDK host/build/contracts-resultset 和 SDK 契约测试。HTTP handler 测试缺 211–229 片段。分段包括 MySQL adapter 1–1354、PG adapter 1–1454、SQLite adapter 1–1222、PG results 250–419、DriverHostHandle 430–759、driver-host 1–230/290–399、ImportManager 400–639、mutation service 1–220、connection session 90–329、SQL parameters 1–170、core resultset 180–275、MySQL contract 1–240。

其余 renderer、Redis/Kafka/SSH、解析器/比较器与测试由补充审查另行列明；枚举和 grep 不算全文。MySQL/PG 候选项没有真库复现；没有完整 SDK 进程 e2e 或实际打包 App 验收。

### R05 · vendor 定向核查

仅读 rskafka 来源说明、上游版本定位和 named Metadata 补丁链：connection 289–297、protocol metadata 54–68/243–272、partition 583–595。所读与补丁说明一致，未发现该片段的确定缺陷。没有下载上游 archive、重算来源 SHA256、完整 diff 上游或阅读全部上游实现；未针对该补丁链跑 Rust 定向测试（最终验证表的 workspace cargo test 不构成 vendor 补丁链验证）。

### R06 · legacy-rest / tests-rest 补充范围

本报告保留已经收到的补充发现 U29–U45；两名审查者的最终完整覆盖、排除和剩余发现由 lead 转发后补充。当前不宣称补充范围全部完成。

### R07 · 执行边界

本轮未因整理报告执行含 rm/unlink/rmdir 或 emptyOutDir 清理的既有脚本，没有修改凭据、删除夹具、生产变更、提交或发布。第三方 install/build scripts 不属于已审范围。安装器安装、Windows/macOS 双平台运行、签名/公证、OS 保存框/剪贴板、真实数据库 TLS/SSH 与业务数据结果，均不能由静态审查或 mock 测试代替。

## 五、最终验证表（lead 补充）

同一次会话、同一工作树中的真实运行结果；第一、二节的原问题描述保留不变，其中本轮已修条目的状态以本表为准。

| 范围 | 命令 | 同次运行结果 | 未覆盖边界 |
| --- | --- | --- | --- |
| Rust workspace 回归；U02/U03/U10/U11/U18 已修（代码+单元测试/探针证据），F11 已修（代码+静态证据，真实 PG 未执行） | `cargo test --locked --workspace --exclude dbstudio-desktop` | exit 0；138 passed / 0 failed / 8 ignored（core lib 25、core tests 12+10+12、drivers lib 36、protocol 2、sqlite_native 21、network_native 10、nosql_native 10 通过 2 ignored、network_live 2 ignored、network_secure 4 ignored、空 target 若干） | 单元/合成协议级；无真实外部数据库；network_live 与 network_secure 的 ignored 用例未执行 |
| Rust 静态检查 | `cargo check --locked --workspace --exclude dbstudio-desktop` | exit 0（仅 vendor rskafka 既有 warning） | 只做编译与静态检查，不执行测试 |
| 原生纯逻辑回归 | `node apps/desktop/tests/pure-regressions.mjs` | 19 passed / 0 failed，exit 0 | 不覆盖 GUI、Tauri 桌面与真实数据库 |
| SQL 工作流回归 | `node apps/desktop/tests/sql-workflow-regressions.mjs` | 11 passed / 0 failed，exit 0 | 不覆盖真实事务与真实数据库 |
| 网格工作流回归；F08 已修（代码+静态/单测证据） | `node apps/desktop/tests/grid-workflow-regressions.mjs` | total 21 / passed 21 / failed 0，exit 0 | 不覆盖真实渲染管线与真实数据库 |
| UI 审查回归；F03/F04/F05/F06、U12/U15/U13/U14/U16 已修（代码+UI 回归证据） | `node apps/desktop/tests/audit-ui-regressions.mjs` | total 28 / passed 28 / failed 0，exit 0（含 U12 导出 5 项、UI-08 blob 只读 3 项）；用例与台账条目对应见下 | 仅 SFC 内存编译与 DOM 探针；不覆盖真实 GUI/Tauri、真实事务与数据库 |
| legacy 回归；U29/U30/U38/U39 已修（代码+静态/单测证据） | `node tests/audit-legacy-regressions.mjs` | 4 pass / 0 fail，exit 0 | 内存 fixture，非真实 IPC 与数据库 |
| SDK 回归；U19/U20 已修（代码+静态/单测证据） | `node tests/audit-sdk-regressions.mjs` | 2 pass / 0 fail，exit 0 | 内存 NDJSON 通道，非完整 SDK 进程 e2e |
| SQL 格式化回归；U32 已修（代码+静态/单测证据） | `node tests/audit-sql-format.mjs` | 8 pass / 0 fail，exit 0 | 格式化与绑定探针，非真实数据库执行 |
| HTTP handler；F01/F02 已修（代码+静态/单测证据） | `node tests/e2e-http-server-handler.mjs` | 12 通过 / 0 失败，exit 0（含 keep-alive 复用连接用例 1 项） | 不覆盖真实浏览器/网络客户端与需 out/ 的打包 e2e |
| artifact HTTP 契约；U46 已修（代码+测试证据） | `node tests/e2e-http-artifacts.mjs` | 15 通过 / 0 失败，exit 0 | 真实 localhost 与临时目录；非真实用户配置目录、生产 keyring 或真实安装包 |
| connection/SQL 库原子写；U46 已修（代码+测试证据） | `node tests/e2e-store-write-atomicity.mjs` | 7 通过 / 0 失败，exit 0（含 Windows 真实持柄 rename） | 临时目录与注入/真实持柄错误；非真实磁盘故障与用户配置 |
| artifact 原子写；U46 已修（代码+测试证据） | `node tests/e2e-artifact-write-atomicity.mjs` | 5 通过 / 0 失败，exit 0（含 Windows 真实持柄 rename） | 临时目录；非生产存储介质 |
| artifact 流错误；D07 已修（代码+测试证据） | `node tests/e2e-artifact-stream-errors.mjs` | 2 通过 / 0 失败，exit 0 | 注入写流错误，非真实磁盘故障 |
| MySQL 列元数据；F12 已修（代码+内存回归证据） | `node tests/e2e-mysql-column-metadata-contract.mjs` | 1 通过 / 0 失败，exit 0 | 内存 fake MySQL 连接，非真实 MySQL |
| legacy MySQL 修复；D02/D03/D04 已修（代码+内存回归证据） | `node tests/e2e-mysql-legacy-repair.mjs` | 10 通过 / 0 失败，exit 0（D02 5 项、D03 3 项、D04 2 项） | 内存 fake MySQL 连接，非真实 MySQL |
| SDK 契约；D09 已修（代码+测试证据） | `node tests/e2e-sdk-contract.mjs` | 37 通过 / 0 失败，exit 0 | 内存 NDJSON 通道，非完整 SDK 进程 e2e |
| 清单一致性；F14 已修（代码+回归证据） | `node tests/e2e-verify-manifest.mjs` | 143 通过 / 0 失败，exit 0 | 清单一致性，非完整 verify 全链 |
| 传输边界；F13 已修（代码+回归证据） | `node tests/e2e-transfer-boundaries.mjs` | 126 通过 / 0 失败，exit 0 | 注入探针与内存边界，非真实数据库 |
| DDL 回归 | `node tests/e2e-ddl.mjs` | 53/53 PASS，exit 0 | 真实 SQLite 副本；不含真实 PG/MySQL |
| 持久化回归 | `node tests/e2e-persist.mjs` | 62/62 PASS，exit 0 | 假 cipher + 临时文件目录；不含真实 OS keyring、Electron GUI 与安装包 |
| 数据比较实时回归 | `node tests/e2e-compare-live.mjs` | 22 通过 / 0 失败，exit 0 | 真实 SQLite 驱动宿主；不含真实 PG/MySQL |
| 打包冒烟 | `node tests/e2e-packaged-smoke.mjs` | 9 passed，exit 0 | 打包路径与运行时夹具判定；不含安装器安装、签名与公证 |
| SQL 库回归 | `node tests/e2e-sql-library.mjs` | 20 通过 / 0 失败，exit 0 | 文件型夹具；不含真实数据库与 GUI |
| 宿主测试门禁；U25/U26 已修（代码+静态/单测证据） | `node --test scripts/native-test-output.test.mjs`；`node --test scripts/native-host-test-gate.test.mjs` | 4 pass / 0 fail；6 pass / 0 fail，均 exit 0 | 门禁逻辑单测；CI workflow 未真实运行 |
| storage 源码 hash 跨平台；U28 已修（代码+测试证据） | `node --test scripts/mysql-acceptance-storage.test.mjs` | 37 tests / 20 pass / 0 fail / 17 skipped，exit 0（跳过为 POSIX mode、symlink、macOS otool/python 专属；macOS 上这些用例仍执行） | macOS CI 未验证；17 项平台专属用例在 Windows 跳过 |
| tests-rest 基线修正；U41/U42/U43/U44 已修（代码+静态证据） | `node --check` 逐文件语法检查与静态核对 | 语法与静态核对通过；U41 由 e2e-packaged-smoke 9 passed、U43 由 e2e-compare-live 22 通过、U42 的 sql-library 由 20 通过覆盖 | U44 的 PG metadata 与 U42 其余目标脚本未运行（需 out/、真实 PG 或含 rm 清理） |
| 类型检查（原生 UI / 根） | `vue-tsc --noEmit -p apps/desktop/tsconfig.json`；`tsc --noEmit -p tsconfig.json` | 均 exit 0 | 不含运行期行为 |
| 补丁洁净 | `git diff --check` | 无输出，exit 0 | 只检查空白错误，不代表编译或测试通过 |
| Rust 语义探针 | `python backups/audit-20261113-rust/probe/sqlite_semantics_probe.py` | exit 0；U03 旧行为残留复现（无 SAVEPOINT 时 items=2/audit=1）、新序列零残留、own=true 分支、RAISE(ROLLBACK) 分支；LIMIT+1 分页 checked=126 mismatches=0（含满末页反例 total=4,limit=2,start=2 → hasMore=False）；UTF-16 预览 surrogateSafe 全 true；MySQL 文本字面量 6 组字节往返全 true | Python sqlite3 语义探针不等于 Rust 驱动对真实数据库的执行 |

audit-ui-regressions 的 28 项与台账条目对应：

- F03（UI-01）：source/target_switch_synchronously_clears_table_schema_and_plan、forged_source/target_table_rejected_before_compare_backend（4 项）。
- F04（UI-03）：schema/data_actual_template_emits_and_previews_two_parseable_statements（2 项）。
- F05（UI-02）：DECIMAL(38,18)/NUMERIC(38,18)_insert_reaches_ipc_as_exact_text（2 项）。
- F06（UI-04）：create-table/create-view_invalidates_existing_results_and_closes_old_cursor（2 项）。
- U12（UI-05）：U12_current_page_insert_projects_writable_columns_only、keeps_plain_table_columns_and_rows、refuses_without_target_column_description、refuses_result_column_absent_from_description、refuses_when_generated_marker_is_missing（5 项）。
- U15（UI-08）：UI-08_null/nonnull_blob_column_opens_only_viewer_without_staging_or_apply（2 项）、UI-08_inferred_null_blob_column_opens_viewer_via_table_metadata、UI-08_inferred_null_text_column_keeps_text_editing、UI-08_null_column_without_reliable_metadata_opens_viewer（共 5 项，其中 blob 只读 3 项）。
- U13（UI-06）：UI-06_completion_tracks_current_connection_for_tree_and_result_columns（1 项）。
- U14（UI-07）：UI-07_sort_{cancel,failure,success,close-failure}_keeps_sql_order_and_page_consistent（4 项）。
- U16（UI-09）：UI-09_insert_success_{transactionState,runQuery,closeCursor}_failure_closes_form_and_blocks_resubmit（3 项）。

本表之外未运行、不能表述为已验证：

- 真实 PostgreSQL / MySQL / Redis / Kafka / SSH：本机无 Docker 且未启动真实服务，均未验证。
- `e2e-mysql-contract` 的真库断言未运行；`mysql_acceptance_live`（unix gated）在 Windows 未注册执行；`network_live`（2 ignored）与 `network_secure`（4 ignored）未执行。
- GUI、Tauri 桌面、安装器安装/签名/公证与真实 OS keyring 均未运行。
- macOS / Linux 未运行（本机 Windows）。
- 敏感 evidence JSON 不读取。

**已验证**：本表列出的同次运行结果：Rust workspace `cargo test --locked --workspace --exclude dbstudio-desktop` 138 passed / 0 failed / 8 ignored，`cargo check --locked --workspace --exclude dbstudio-desktop` exit 0；原生 UI 四组（pure 19、sql-workflow 11、grid 21、audit-ui 28）；legacy 各 e2e（audit-legacy 4、audit-sdk 2、audit-sql-format 8、http handler 12、http-artifacts 15、verify-manifest 143、transfer-boundaries 126、store-write-atomicity 7、artifact-write-atomicity 5、artifact-stream-errors 2、mysql-column-metadata-contract 1、mysql-legacy-repair 10、sdk-contract 37、ddl 53/53、persist 62/62、compare-live 22、packaged-smoke 9、sql-library 20）；scripts 三组（37 tests / 20 pass / 17 skipped、4 pass、6 pass）；两处类型检查与 `git diff --check` 均 exit 0；Python sqlite3 语义探针。已修条目状态为「已修（代码+单元/测试/静态/探针证据）」，不等于真实外部数据库验收通过。

**刻意未验**：真实 PG/MySQL/Redis/Kafka/SSH；GUI/Tauri、安装器/签名/公证/OS keyring；macOS/Linux；`e2e-mysql-contract` 真库断言、`mysql_acceptance_live`（unix gated）、`network_live`/`network_secure`（ignored）；敏感 evidence JSON 不读取。

**不可宣称**：全仓逐文件审完、未列文件无缺陷、所有修复已验收、完整测试全绿、产品可用/可发布；Rust 修复仅在单元/合成协议级验证，未对真实外部数据库执行。
