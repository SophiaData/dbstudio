# 原生桌面功能完善与产品验收 Implementation Plan

> **For agentic workers:** 按任务和复选框逐项执行，每项记录证据后再更新状态。发现缺陷时使用当前环境可用的 `systematic-debugging` 技能定位根因；复杂修复交付前进行独立只读复核。本文不依赖未安装的任务执行技能，也不授权跳过平台验收。

**Goal:** 基于已发布的 v0.8.1，完成 macOS arm64、Windows x64 的安装与核心业务验收，建立大数据量和持续使用基线，形成可据以判断试用范围的验收报告。

**Architecture:** 保持 Tauri 2 → Rust core → 原生 drivers 的边界，Vue 负责界面和编辑草稿。本轮优先验证已声明能力、修复实际发现的问题；不再次重构架构，不增加平台，不扩展 Redis/Kafka 写入能力。

**Tech Stack:** Tauri 2、Vue 3、TypeScript、Rust、SQLite、PostgreSQL、MySQL、Redis、Kafka；人工平台验收与现有原生回归结合。

---

## 1. 基线与计划状态

- 编写日期：2026-11-07。
- 文档状态：**已启动团队执行。** 本轮设备、静态包和核心回归证据写入[验收目录](../../support/acceptance/v0.8.1/)；各复选框未勾选的项目仍不计通过。安装实测受干净 OS 会话条件限制，不能由原生核心测试代替。
- **当前执行优先级（按用户纠正）：数据库业务功能优先。** 先核对连接、SQL 执行与参数、结果编辑与事务、导入导出及比较，使用独立临时配置与合成数据复现并修复实际问题。Mac/Windows 安装、签名和长期观察单列为后续验收；下方依赖表中的 OS 环境要求仅约束生产包安装实测，不作为继续业务代码验证和修复的前置。已通过且没有新变化的测试不重复执行。
- 数据库业务补充执行结果：六项已复现问题已在当前源码修复，新增 28 个永久回归；合并模型及业务检查 46 项通过，类型与清单检查通过。证据和剩余边界见[业务修复报告](../../support/acceptance/v0.8.1/business-workflows.md)。该结果不表示已发布的 v0.8.1 安装包包含这些修复。
- 基线版本：[v0.8.1 Release](https://github.com/SophiaData/dbstudio/releases/tag/v0.8.1)。
- 基线提交：`7fadb00d6f9ee2cbf87949e9f908517c508a2956`。
- [双平台构建及聚合 CI](https://github.com/SophiaData/dbstudio/actions/runs/42256930038)已通过；发布提交的 `verify`、`native-verify` 已通过。
- [发布验收记录](https://github.com/SophiaData/dbstudio/releases/download/v0.8.1/release-verification.json)确认来源和哈希，**安装验收仍为 unverified，签名/公证未完成验收**。
- [迁移验收台账](../../support/native-migration-matrix.md)用于了解已有功能证据。其中的早期版本和历史状态不覆盖 v0.8.1 的实际发布事实。

### 范围与边界

| 范围 | 本轮目标 | 不能据此宣称 |
| --- | --- | --- |
| macOS Apple Silicon | 安装、启动、核心操作、凭据重启、系统交互 | 已支持 Intel Mac、已完成公证 |
| Windows x64 | Windows 11 x64 首轮真实安装与业务操作 | 已覆盖全部 Windows 版本或已完成代码签名 |
| SQL 数据库 | SQLite 全链路；专用 PostgreSQL 17、MySQL 8 的重点链路 | 已覆盖所有数据库版本和方言组合 |
| Redis/Kafka | 验证现有只读能力及安全连接 | 支持写入、管理或消息生产 |
| 性能与稳定性 | 固定设备、固定合成数据的首轮基线 | 对任意机器、大表或生产负载的性能保证 |

明确保留的能力限制：SQLite 查询取消及通用 DML RETURNING 分页不支持；MySQL SSH + verify-full 不支持；跨方言比较尚未充分覆盖。验收其明确拒绝或限制提示，不把这些项目默认改成新增功能。

### 执行约束

1. 仅使用新建的合成数据库、专用测试账号及独立 OS 测试账户或干净测试系统。生产账号、真实用户配置和历史凭据不参与测试。
2. 不读取或输出口令、令牌、证书私钥；连接凭据由操作者输入。公开证据仅保留用例 ID、版本、计数、耗时和脱敏错误码。
3. 继续遵守不删除规则。临时文件、数据库和容器保留；需要移走时先检查绝对路径、归属和链接类型。**卸载、删除数据等用例本轮记为受限，不执行，也不计通过。**
4. 不覆盖已发布 tag、安装包、SHA256SUMS 或发布验收记录。新增安装验收写入独立报告。
5. Windows 测试环境、专用服务或人工系统确认不可用时，记录具体阻塞条件；构建成功、Linux 服务测试和 macOS 结果都不能替代 Windows 实测。

## 2. 任务顺序、角色与交付物

角色可由同一人兼任：平台执行者负责安装和系统交互；数据库执行者负责专用服务；开发者只修复已复现问题；复核者检查证据和修复范围。

| 顺序 | 任务 | 依赖 | 当前状态 | 交付物 |
| --- | --- | --- | --- | --- |
| T0 | 冻结版本、准备环境和证据 | 无 | 部分完成：下载、哈希、合成数据就绪；干净 OS 环境待补齐 | 环境与基线记录 |
| T1 | Mac 安装与系统交互 | T0 | 静态与复制已完成；生产 GUI 受阻 | macos-arm64.md |
| T2 | Windows 安装与系统交互 | T0 | 静态与环境核查已完成；实机受阻 | windows-x64.md |
| T3 | 核心业务与支持边界 | 对应平台 T1/T2 | 68 项安全核心回归及 2 项 NoSQL live 通过；生产 GUI 与其余服务用例受阻 | core-scenarios.md |
| T4 | 大数据量与资源基线 | T3 基础用例通过 | 原生核心补充 162 样本完成；应用 UI 性能、进程组内存仍受阻 | performance.csv、performance-notes.md |
| T5 | 持续使用与故障恢复 | T3 基础用例通过 | 原生核心 30 轮短循环及合成失败恢复通过；8 小时已安装应用观察未执行 | soak.md |
| T6 | 缺陷收口与试用结论 | T1—T5 | 首轮分级和证据汇总完成；整体结论受平台环境与长期观察限制 | issues.md、summary.md |

Mac 与 Windows 可并行；缺少 Windows 环境不阻塞 Mac 验收，但最终结论必须分别报告两个平台。

执行阶段创建下列公开报告，均只含脱敏结果：

```text
docs/support/acceptance/v0.8.1/environment.md
docs/support/acceptance/v0.8.1/macos-arm64.md
docs/support/acceptance/v0.8.1/windows-x64.md
docs/support/acceptance/v0.8.1/core-scenarios.md
docs/support/acceptance/v0.8.1/performance.csv
docs/support/acceptance/v0.8.1/soak.md
docs/support/acceptance/v0.8.1/issues.md
docs/support/acceptance/v0.8.1/summary.md
```

合成数据库、导出文件和私有诊断留在本次专用 `backups/` 子目录，不加入 Git 或发布附件。报告不存在时新建；已存在时先备份并追加本轮记录，不覆盖旧结果。

## 3. T0：冻结基线与准备测试环境

**执行者：** 平台执行者、数据库执行者。

**Files:** 新建上述 environment.md；准备附录 A 生成的合成数据。参考 [发布验收说明](../../architecture/native-release.md)。

- [x] 从同一个 v0.8.1 Release 下载本平台安装包、SHA256SUMS、release-verification.json 到新建空目录（本轮 Mac 主机重新下载两安装包）。
- [x] 核对记录中的版本为 0.8.1、sourceSha 为本计划基线提交；禁止将 0.8.0 包混入。
- [x] 执行本平台哈希命令，与发布 SHA256SUMS 比较（本轮 Mac 主机独立计算两包 SHA-256；Windows 现场哈希仍待实机）。
- [x] 记录 OS 版本、CPU 类型、内存、安装包哈希、执行日期和执行者角色（已记录本轮 Mac；Windows 待补）；不记录设备序列号、系统用户名或完整系统信息转储。
- [ ] 准备独立 OS 测试账户或干净测试系统；确认其中没有既有 dbstudio 配置。路径已有应用或数据时停止，另选干净环境。
- [x] 在仓库根目录执行附录 A，取得三份规模数据 SQLite、两份比较库和 CSV（本轮已生成并验证；性能使用独立副本）。Python 3 只用于生成数据，可在一台测试机器上准备后复制到另一平台；测试记录中确认文件未被既有用例修改。
- [ ] 为人工跨数据库测试准备运行中的专用 PostgreSQL 17、MySQL 8 实例，账号仅访问测试库。无实例时只执行 SQLite 用例，并将相应 SQL 服务用例标为受阻。

macOS：

```sh
shasum -a 256 dbstudio_0.8.1_aarch64.dmg
```

Windows PowerShell：

```powershell
Get-FileHash -Algorithm SHA256 .\dbstudio_0.8.1_x64-setup.exe
```

预期 DMG：`88fc058cbdc44504f7001818c1366d8bbc2b6417a6f2265417959aa8461a5de7`。

预期 EXE：`41403e3117aaade4dd8c9b9eb433684cb2bc925da8a489e89d726e1c6e9da292`。

**通过标准：** 两平台各有独立环境记录，使用正确安装包，哈希完全一致，测试数据与真实数据隔离。没有环境的项目不能填“通过”。

## 4. T1 / T2：真实安装与系统交互

**Files:** 新建或追加 macos-arm64.md、windows-x64.md。

每项操作后立即记录结果，单项通常 2—5 分钟。只在本次测试账户中执行。

| ID | 操作 | 通过标准 |
| --- | --- | --- |
| I01 | Mac 挂载 DMG，复制应用到测试系统的空安装位置，首次启动 | 应用可启动；记录系统拦截提示及人工确认流程。不得关闭全局系统安全保护 |
| I02 | Windows 运行 EXE，使用干净测试账户完成安装并启动 | 安装流程完成，主进程可运行；缺 WebView2 或发行者拦截时记录准确提示，不将安装器启动当应用启动 |
| I03 | 连接本轮 805 行 SQLite 数据库，退出应用，再从正常入口重启 | 连接配置恢复且查询可用；无空白窗口或损坏配置 |
| I04 | 用专用数据库账号保存合成凭据，退出并重启，再连接 | 按公开的凭据保存行为正常连接；不查询系统凭据值，不接触其他条目 |
| I05 | 系统出现凭据访问提示时拒绝一次，再按界面提示重试；没有提示的平台记录“不适用”及环境条件 | 错误可理解，配置不损坏、不转明文保存、不无限重试；不修改全局安全策略强行制造拒绝 |
| I06 | 当前页导出，第一次取消原生保存框，第二次选择新文件保存 | 取消不创建结果文件；第二次可正常导出，界面可再次操作 |
| I07 | 复制包含中文、换行的 SQL，粘贴到本次测试文本文件 | 内容一致；Windows 与 Mac 分别记录，不以另一平台代替 |
| I08 | 打开多个结果标签，退出前保留一项未应用修改，分别验证取消退出与明确放弃 | 未确认前不会静默丢稿；取消退出可继续操作；正式退出后无残留应用进程 |
| I09 | 在同一测试环境再次启动已安装的相同版本 | 可正常运行，连接配置保留；此项只证明重复启动，不计为升级或卸载验收 |

**升级与卸载边界：** 不能把 Electron 0.7.0 到原生版本的迁移假定为应用内原地升级。旧格式迁移先用专用合成配置及既有回归验证；未做实际升级前单独记为“未验证”。卸载涉及删除，受当前规则限制，保持未验证。签名、公证也单独记录，不由安装成功推导。

**平台完成标准：** I01 仅 Mac 执行，I02 仅 Windows 执行，其余 I03—I09 两平台均有结果。可用性受阻、凭据异常或文件丢失均进入缺陷单。

## 5. T3：核心业务与支持边界

**Files:** 新建或追加 core-scenarios.md；发现缺陷时按第 8 节定位实现文件。

### 5.1 已安装应用的核心操作

在两个平台分别执行。SQLite 使用附录 A 数据；PostgreSQL/MySQL 使用专用测试库中的同结构小表。不要在生产库执行。

| ID | 操作 | 通过标准 |
| --- | --- | --- |
| F01 | 浏览连接、表、列、索引；断开后重连 | 名称和结构正确，断开会话失效，重连后无旧结果冒充新会话 |
| F02 | 查询 sample，按 id 排序连续翻至少四页，再切换两个结果标签；805 行库使用不大于 200 的受支持页大小，不能调整时改用 100000 行库 | 顺序稳定、无重复漏行、标签连接归属正确；记录实际页大小和数据规模 |
| F03 | 分别执行两条匿名参数更新，给每条语句设置不同参数，然后回滚 | 参数按语句绑定，回滚恢复两行；不把上一条语句参数带入下一条 |
| F04 | 在两个同连接标签编辑不同记录，先回滚再重做并提交 | 两标签共同参与连接事务；回滚/提交结果与数据库实际一致 |
| F05 | 编辑单元格，尚未应用时翻页、切换连接、关闭标签 | 有明确保护选择；未确认不丢稿，应用后跳转到原本选择的目标页 |
| F06 | 查看、编辑并重新查询 9007199254740993 | 十进制值精确一致，不变成 9007199254740992 |
| F07 | 查询 long_values，打开完整值，再导出或复制到本次文件 | 截断有标记，完整值可读取；以字符数/字节数核对，不只凭预览判断 |
| F08 | 保存一条历史/收藏 SQL，重启后重新打开 | SQL 内容与参数文本未丢失，标签状态正确 |
| F09 | 在专用测试库执行建表与 EXPLAIN，检查结果 | 结构刷新正确，执行计划能显示；不在未提交业务事务里混入可能隐式提交的 DDL |
| F10 | 将 small.csv 导入空的 import_small 表，再导出四种格式 | 数据计数为 3，中文和大整数正确；CSV/JSONL/JSON/INSERT 内容均可核对 |
| F11 | large.csv 成功导入 import_large；取消用例使用空的 import_cancel；重复主键用例把 duplicate-key.csv 导入空的 import_failed | 成功表计数为 100000；取消后计数与已提交批次一致；重复键失败表计数为 0。若取消前已完成，记录“取消未触发”而不计取消通过；不把已提交批次说成全部回滚 |
| F12 | 连接附录 A 的 compare-source.db、compare-target.db，对 compare_rows 进行结构/数据比较并查看 SQL 预览 | 识别源端独有索引；id=1 相同、id=2 仅源端、id=4 仅目标端、id=3 值不同。比较只读，目标库前后计数和值不变，不执行生成的变更 SQL |
| F13 | 打开 ER 图，检查已存在的合成外键关系 | 关系与数据库元数据一致，可在当前界面提供的操作范围内正常查看和导出 |

F03 的 SQLite/MySQL SQL：

```sql
UPDATE sample SET body = ? WHERE id = ?;
UPDATE sample SET body = ? WHERE id = ?;
```

第一条参数：普通文本 `acceptance-A`、整数 `1`；第二条参数：普通文本 `acceptance-B`、整数 `2`。PostgreSQL 将每条语句中的两个位置参数分别写成 `$1`、`$2`。测试凭据不参与 SQL 参数或结果截图。

专用 PostgreSQL/MySQL 小表准备 SQL：

```sql
CREATE TABLE sample (
  id BIGINT PRIMARY KEY,
  body VARCHAR(200) NOT NULL,
  big_value BIGINT NOT NULL
);
INSERT INTO sample (id, body, big_value) VALUES
  (1, 'acceptance-original-A', 9007199254740993),
  (2, 'acceptance-original-B', 9007199254740993),
  (3, '中文与换行验证', 9007199254740993);
```

若表名已存在则停止并新建专用测试库，不覆盖原表。MySQL 使用事务表；F04 前完成准备 DDL。

### 5.2 安全连接、取消和只读边界

- [ ] 重跑既有专用服务回归，分别记录普通 SQL、Redis/Kafka TLS、SQL TLS/SSH 的结果；不能以 prepare-only 或跳过代替通过。
- [ ] 人工连接专用 PostgreSQL/MySQL，验证正确 TLS 配置成功、错误 CA/名称明确失败。需要的连接资源不可用时标记受阻。
- [ ] PostgreSQL 执行 `SELECT pg_sleep(20);`，MySQL 执行 `SELECT SLEEP(20);`，各在约 1 秒后取消。计划门槛为取消操作后 5 秒内结束等待；随后执行 `SELECT 1;`，确认连接仍可用。仅测试本次专用查询，不取消其他会话。
- [ ] SQLite 取消与 MySQL SSH + verify-full 按当前能力明确提示不支持，不显示虚假成功。
- [ ] Redis/Kafka 验证现有只读浏览；Kafka 元数据读取前后不存在被自动创建的 topic。没有专用服务时不计人工验收通过。

已有服务回归入口（执行前确认只使用脚本自建合成服务，遵守当前资源保留约束）：

```sh
node scripts/native-database-fixture.mjs
node scripts/native-secure-fixture.mjs
node scripts/native-sql-secure-fixture.mjs
```

执行前需确认既有回归的资源处置符合当前不删除约束；存在不允许的删除操作时，先改为保留方式或将该项标为受阻，不直接执行。脚本执行后会停止并保留专用容器，**不能把它们结束后已停止的服务当作人工连接环境**。人工服务须由数据库执行者单独提供。

**通过标准：** 两平台核心必选用例均有结果；数据库扩展链路与已知限制分别记录，受阻不计通过。删除数据、卸载和未声明的新能力不夹带到本轮执行。

## 6. T4：大数据量与资源基线

**Files:** 新建或追加 performance.csv；使用附录 A 的 805、100000、1000000 行数据库及 100000 行 CSV。

以下是**计划采用的初始试用门槛，不是现有实测结果或产品性能承诺**。先记录设备和数据规模，始终比较同设备、同数据、同版本；首次未达标时保留原始结果并分析，不能通过改写阈值把失败改成通过。

| 场景 | 采样方式 | 初始门槛 |
| --- | --- | --- |
| 应用重新启动到工作台可操作 | 每平台 5 次正常退出后启动，保留系统文件缓存，记录全部值及最大值 | 单次不超过 5 秒；不含操作系统安全确认和运行库安装时间，不称为清缓存冷启动 |
| 本地 SQLite 百万行查询首屏 | 按主键排序，同查询重复 20 次 | p95 不超过 2 秒；界面能响应取消/其他受支持操作 |
| 后续分页 | 连续翻页记录 20 次，保留实际页大小 | p95 不超过 1 秒，不重复不漏行 |
| 大 CSV 导入/导出 | 100000 行，各执行 3 次；三次导入分别使用空的 import_perf_1、import_perf_2、import_perf_3，导出每次选新文件；取消另记 | 结果计数、内容正确，进度持续更新，完成或取消后可继续查询；不重复导入已填充目标或覆盖已存在文件 |
| 结果关闭后的内存 | 每轮打开/关闭同样 10 个结果，重复 5 轮 | 不随轮数持续线性增长；回收稳定后不高于起始空闲值 100 MiB 或 20% 中较大者 |

- [ ] 使用操作系统资源视图分别记录主进程和可归属于本应用的 WebView 子进程内存，并保持相同的合计口径；不能只看 Rust 主进程。记录 CPU/RSS 时只抄本应用数值，不导出完整系统或其他进程信息；无法确认子进程归属时标为证据不足。
- [ ] 记录 20 个查询/分页样本；按耗时排序取第 19 个值作为此次 p95。
- [ ] 大数据导出先验证 CSV；其他三种格式用小数据核对内容，不把容量限制当成支持无限导出的承诺。
- [ ] 触发已有行数/容量限制时必须明确说明；截断或未完成不能显示“完整成功”。
- [ ] 单独记录数据库执行耗时与界面可见耗时；网络数据库不套用本地 SQLite 的阈值。

performance.csv 表头：

```csv
scenario,platform,os_version,app_version,source_sha,dataset_rows,page_rows,sample,elapsed_ms,rss_mib,result
```

**通过标准：** 数据正确性先通过；所有样本可复核，未达门槛项进入缺陷或基线评审，不隐瞒异常值。人工计时记录实际精度，不伪造毫秒级测量。

## 7. T5：持续使用与故障恢复

**Files:** 新建或追加 soak.md、issues.md。

- [ ] 每平台执行 30 轮固定操作：查询 → 翻页 → 打开完整值 → 小数据导出 → 关闭结果。每轮记录是否成功及应用内存。
- [ ] 在专用连接上模拟服务暂时不可用，确认错误可理解；恢复服务后按正常重连操作恢复查询。
- [ ] 在有未应用草稿时关闭窗口并取消关闭，确认草稿仍可继续；不通过强杀进程测试真实用户数据。
- [ ] 核心操作通过后，应用保持测试连接运行 8 小时。每小时人工记录一次是否响应、连接状态和应用 RSS；记录动作很短，不进行长时间阻塞等待或高频轮询。
- [ ] 8 小时后再次执行查询、编辑回滚、导出及正常退出，确认可继续使用且无残留应用进程。

**通过标准：** 无崩溃、持续无响应、未确认丢稿或错误事务状态；资源没有持续线性增长，重连和正常退出有效。30 轮操作和 8 小时观察分开报告，不能用短循环冒充长期测试。

## 8. T6：缺陷修复与结果收口

### 缺陷分级

| 级别 | 定义 | 处理要求 |
| --- | --- | --- |
| P0 | 数据错误写入、不可恢复丢失、凭据泄漏、操作目标串库 | 立即停止相关写入验收，保留现场；未修复不得扩大试用 |
| P1 | 安装/启动失败、核心查询编辑不可用、事务/导入状态错误 | 修复并在原平台复测后，才给对应平台通过结论 |
| P2 | 可绕开的性能问题、交互不清、非关键元数据/比较缺口 | 有复现步骤、影响范围和明确处理结论后再评估试用范围 |

issues.md 每条记录：用例 ID、版本/平台、合成复现步骤、预期与实际、脱敏错误码、数据库前后计数、级别、关联修复提交、复测结果。不存在问题时写“本轮未发现”，不预先填写已通过。

### 修复定位表

仅在相应用例实际失败时打开实现文件，不按此表做全项目扫描或预防性重构。

| 问题范围 | 首要定位 | 回归入口 |
| --- | --- | --- |
| 安装/构建/平台凭据 | [tauri.conf.json](../../../src-tauri/tauri.conf.json)、[build-native-desktop.mjs](../../../scripts/build-native-desktop.mjs)、[secrets.rs](../../../src-tauri/src/secrets.rs) | 相同安装包场景；宿主凭据测试只用合成条目 |
| 标签、参数、草稿、分页 | [workbench.ts](../../../apps/desktop/src/workbench.ts)、[sql-editor-model.ts](../../../apps/desktop/src/sql-editor-model.ts)、[ResultGrid.vue](../../../apps/desktop/src/components/ResultGrid.vue) | [pure-regressions.mjs](../../../apps/desktop/tests/pure-regressions.mjs)、真实桌面 smoke |
| 事务、连接、取消 | [connections.rs](../../../crates/dbstudio-core/src/connections.rs)、对应[原生数据库驱动](../../../crates/dbstudio-drivers/src/) | 对应原生驱动集成测试和真实服务回归 |
| 导入/导出、路径保护 | [data_tasks.rs](../../../crates/dbstudio-core/src/data_tasks.rs)、[TransferDialog.vue](../../../apps/desktop/src/components/TransferDialog.vue) | [数据任务回归](../../../crates/dbstudio-core/tests/data_tasks.rs)、真实桌面操作 |
| 比较与元数据 | [compare.rs](../../../crates/dbstudio-core/src/compare.rs)、对应驱动的元数据实现 | [比较回归](../../../crates/dbstudio-core/tests/compare.rs)、合成库比较 |

- [ ] 每个实际缺陷先保留最小复现和失败证据，再写相应失败回归；不根据猜测预写修复。
- [ ] 改动重要实现前备份到项目根 backups；每次修复限制到直接责任模块。
- [ ] 执行对应最小回归并验证原始场景；复杂修复做独立只读复核。
- [ ] 修复改变应用运行时后，用新候选包重新执行受影响的平台用例，不能继续引用旧包安装结论。
- [ ] 提交仅包含相应修复与测试，排除私有数据、backups 和现有 staging 草稿。
- [ ] 如需发布修复版，另定新版本及不可覆盖 tag；不修改 v0.8.1 已公开附件。

### 最终通过标准

1. 两个平台分别给出：通过、部分通过、受阻或未验证；没有 Windows 实测就不能写“双平台已验收”。
2. 本轮约定的必选用例通过，无未解决 P0/P1；已知 unsupported 能力有正确提示，不能记为功能已实现。
3. 性能和持续使用结果真实保留；未达计划门槛有明确影响和结论。
4. 签名、公证、升级和卸载各自列状态，不因其他检查成功自动提升。
5. summary.md 引用对应证据，给出“可试用场景、暂不建议场景、剩余缺陷和下一步”。

建议顺序：先完成 T0—T3，再做 T4/T5。首轮操作量估计为 3—5 个工作日，另含 8 小时观察窗口；这是资源就绪且不含缺陷修复的估计，不是交付日期承诺。

## 附录 A：只创建和保留合成数据

将下面完整代码新建保存到 `backups/prepare-readiness-v0.8.1.py`；若该文件已存在则另取本轮唯一文件名，不覆盖。随后在仓库根目录运行 `python3 backups/prepare-readiness-v0.8.1.py`（Windows 可使用 `py -3 backups/prepare-readiness-v0.8.1.py`）。本段只创建新的本轮目录；不清理、不覆盖既有数据库，不输出任何凭据。生成耗时与磁盘占用需要纳入 T0 记录。代码会为功能成功、取消、失败及三次性能导入准备不同的空表。

```python
from pathlib import Path
import csv
import json
import sqlite3
import tempfile

root = Path.cwd().resolve()
assert (root / 'Cargo.toml').is_file()
assert json.loads((root / 'package.json').read_text())['name'] == 'dbstudio'
base = root / 'backups'
assert not base.is_symlink()
base.mkdir(exist_ok=True)
work = Path(tempfile.mkdtemp(prefix='readiness-v0.8.1-', dir=str(base)))
records = []
for count in (805, 100000, 1000000):
    database = work / f'sqlite-{count}.db'
    assert not database.exists()
    connection = sqlite3.connect(database)
    connection.execute('CREATE TABLE sample (id INTEGER PRIMARY KEY, body TEXT NOT NULL, big_value BIGINT NOT NULL)')
    for start in range(1, count + 1, 5000):
        rows = ((i, f'样本-{i:07d}-' + 'x' * 48, 9007199254740993)
                for i in range(start, min(start + 5000, count + 1)))
        connection.executemany('INSERT INTO sample VALUES (?, ?, ?)', rows)
    if count == 805:
        for table in ('import_small', 'import_large', 'import_cancel', 'import_failed',
                      'import_perf_1', 'import_perf_2', 'import_perf_3'):
            connection.execute(f'CREATE TABLE {table} (id INTEGER PRIMARY KEY, body TEXT NOT NULL, big_value BIGINT NOT NULL)')
        connection.execute('CREATE TABLE long_values (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
        connection.execute('INSERT INTO long_values VALUES (?, ?)', (1, '长' * 700000))
        connection.execute('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
        connection.execute('CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))')
        connection.execute('INSERT INTO parent VALUES (1)')
        connection.execute('INSERT INTO child VALUES (1, 1)')
    connection.commit()
    assert connection.execute('SELECT COUNT(*) FROM sample').fetchone()[0] == count
    connection.close()
    records.append({'file': database.name, 'rows': count})
for name, rows, with_index in (
    ('compare-source.db', [(1, 'same'), (2, 'source-only'), (3, 'old')], True),
    ('compare-target.db', [(1, 'same'), (3, 'changed'), (4, 'target-only')], False),
):
    database = work / name
    assert not database.exists()
    connection = sqlite3.connect(database)
    connection.execute('CREATE TABLE compare_rows (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    connection.executemany('INSERT INTO compare_rows VALUES (?, ?)', rows)
    if with_index:
        connection.execute('CREATE INDEX compare_body_idx ON compare_rows(body)')
    connection.commit()
    connection.close()
    records.append({'file': name, 'rows': 3, 'with_body_index': with_index})
for name, count in (('small.csv', 3), ('large.csv', 100000)):
    with (work / name).open('x', newline='', encoding='utf-8') as stream:
        writer = csv.writer(stream)
        writer.writerow(['id', 'body', 'big_value'])
        for i in range(1, count + 1):
            writer.writerow([i, f'导入-{i:07d}', '9007199254740993'])
with (work / 'duplicate-key.csv').open('x', newline='', encoding='utf-8') as stream:
    writer = csv.writer(stream)
    writer.writerow(['id', 'body', 'big_value'])
    writer.writerow([100001, '合成第一行', '9007199254740993'])
    writer.writerow([100001, '合成重复主键', '9007199254740993'])
with (work / 'dataset.json').open('x', encoding='utf-8') as stream:
    json.dump({'baseline': 'v0.8.1', 'databases': records}, stream, ensure_ascii=False, indent=2)
print('Synthetic acceptance directory:', work)
print('SQLite rows:', [item['rows'] for item in records])
```

## 结果记录规则

用例状态只允许：`未执行`、`通过`、`失败`、`受阻`、`不适用`。每条至少包含平台、用例 ID、安装包版本/哈希、实际操作、结果和证据位置。使用独立报告记录安装验收，不修改已发布清单中的 `installerAcceptance` 字段。

后续执行时按阶段操作、记录和汇报；本次文档编写不等于上述安装、服务、性能或持续使用测试已经通过。
