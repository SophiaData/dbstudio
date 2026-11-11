# v0.8.1 原生核心与专用服务回归记录

本轮完成 **68 条 portable driver/core 回归及 2 条专用 NoSQL TLS 回归，均通过**。普通 PostgreSQL/MySQL 两条生命周期回归受不删除约束限制；SQL TLS/SSH 四条在 fixture 镜像准备阶段受阻，未执行。这些结果属于仓库原生代码层，**不能替代已安装应用的 macOS / Windows F01—F13 或 I01—I09 验收**。

- 执行日期：2026-11-07，Asia/Shanghai。
- 版本：v0.8.1。
- 执行源提交：`7fadb00d6f9ee2cbf87949e9f908517c508a2956`，与 readiness plan 基线一致；来源为本轮命令记录的 `git rev-parse HEAD`。
- 角色：原生核心 / 数据库回归执行者，task-37。
- 计划：[native product readiness plan 的 T3](../../../superpowers/plans/2026-11-07-native-product-readiness-plan.md)。
- 本轮记录 ID：`core-readiness-9beaead4-2516-40ae-b41a-e638ce97b739`。
- 本报告不复用历史 CI 作为本轮执行证据，不将 ignored 或准备失败计为通过。

## 本轮 portable 回归

所有命令使用 `cargo test --locked`，顺序执行。stdout / stderr 私有捕获；公开报告只保留模块、计数、测试名和固定错误码。未修改产品、测试或计划源码。

| 测试入口 | 执行数 / 通过 | 失败 | 本轮范围 |
| --- | ---: | ---: | --- |
| `dbstudio-protocol --lib` | 2 / 2 | 0 | 凭据独立通道与配置 Debug 脱敏 |
| `dbstudio-drivers --test network_native` | 9 / 9 | 0 | SQL 参数、原生 ID、DDL 字符串校验、TLS/SSH 配置与导入计划；不连接真实 SQL 服务 |
| `dbstudio-drivers --test nosql_native` | 9 / 9 | 0 | 合成协议对端、只读命令边界、ClientHello、PLAIN/SCRAM、offset 精度与禁自动建 topic；另 2 条 live 在此命令中 ignored |
| `dbstudio-drivers --test sqlite_native` 安全子集 | 10 / 10 | 0 | 真实新建 SQLite fixture：参数与随机分页、长值/NUL/BLOB/i64、事务、元数据、导入、插入 savepoint 与重连游标 |
| `dbstudio-core --test application` 安全子集 | 15 / 15 | 0 | Application 会话隔离、重连、配置迁移、原文件保留、保存上限与导出路径保护 |
| `dbstudio-core --test compare` | 10 / 10 | 0 | 原生比较、分页、完整文本、typed 大整数/键与资源限制；生成的变更 SQL 未执行 |
| `dbstudio-core --test data_tasks` | 13 / 13 | 0 | 原生 CSV preview/import、跨批次原子回滚、4 格式流式导出、字节核对与源路径保护 |
| **合计** | **68 / 68** | **0** | 本轮未运行整个 workspace 全量测试，不据此宣称全量通过 |

本轮 portable 忽略的两条 NoSQL TLS live 测试在下节专用服务中另行执行。两者只计入服务结果一次，不重复加入 68 条 portable 数量。

明确排除的现有用例：

- `sqlite_native::ddl_quotes_identifiers_validates_structure_and_explain_is_read_only`：包含实际 `dropView` / `dropTable`。
- `sqlite_native::pages_are_clamped_parameters_are_checked_and_disconnect_rolls_back`：包含实际 `DELETE FROM`，即使随后回滚，本轮也不执行。
- `application::sql_library_is_persisted_in_separate_v2_files_and_unsupported_is_explicit`：包含 `clearSqlHistory` 和 `removeSavedSql`；本轮保留不删除边界，不执行此用例。

参数解析、SQL 注入拒绝与比较计划测试中的 DELETE/DROP 文本只参与本地校验或只读计划生成，没有作为删除语句执行。文件与数据库 fixture 保留。

## 八项专用服务用例

“八项”指计划的八条 live 用例，不是本轮实际启动了八个容器。

| 用例 | 本轮结果 | 依据 / 固定码 |
| --- | --- | --- |
| `postgresql_native_factory_lifecycle` | 未执行：受约束限制 | `POLICY_DELETE_DROP_BLOCKED` |
| `mysql_native_factory_lifecycle` | 未执行：受约束限制 | `POLICY_DELETE_DROP_BLOCKED` |
| `redis_native_tls_live_readonly` | **通过** | 本轮新生成合成凭据与 CA，TLS handshake 及 exact ignored 测试实际执行 |
| `kafka_native_tls_sasl_live_readonly` | **通过** | 本轮 TLS + PLAIN / SCRAM-SHA-256 / SCRAM-SHA-512 与只读浏览；脚本核对 exact 单条测试执行摘要 |
| `postgresql_native_verify_full_live` | 未执行：fixture 准备失败 | `SSH_IMAGE_BUILD_FAILED`，单步复现进一步分类 `BUILD_OPERATION_NOT_PERMITTED` |
| `mysql_native_verify_full_live` | 未执行：fixture 准备失败 | 同上 |
| `postgresql_native_ssh_verify_full_live` | 未执行：fixture 准备失败 | 同上 |
| `mysql_native_ssh_pinned_live` | 未执行：fixture 准备失败 | 同上；此用例仅覆盖 SSH，不能作为 MySQL SSH + verify-full 成功证据 |

### 普通 SQL 生命周期回归的约束

执行前审查发现，[network_live.rs](../../../../crates/dbstudio-drivers/tests/network_live.rs#L47) 的生命周期中会执行 `deleteRows` 并提交，在 PostgreSQL 分支还有多次行删除；[finally 段](../../../../crates/dbstudio-drivers/tests/network_live.rs#L110)还会执行 `dropView` / `dropTable`。因此没有启动 `native-database-fixture` 的两个完整用例，也没有自行豁免“合成数据删除”或修改这些现有测试。

### SQL TLS/SSH fixture 构建阻碍

本轮确实执行了 [SQL secure fixture 入口](../../../../scripts/native-sql-secure-fixture.mjs)，其结果为 exit 1、`SSH_IMAGE_BUILD_FAILED`，四条 Rust live 测试尚未启动。

按 Lead 指示，在本轮私有目录另建与源码相同、不含秘密的 Dockerfile，只复现对应 Docker build 一步。复现同样 exit 1。程序仅匹配固定特征，没有将原始日志、URL、环境或秘密回显；已确认分类为 **`BUILD_OPERATION_NOT_PERMITTED`**，错误涉及 buildx / builder，未进入镜像拉取或 APK 安装阶段。当前没有支持 DNS、TLS、包镜像或磁盘故障的证据。不修改个人 Docker / VM / builder 配置，不通过其他构建途径绕过限制。

该阻碍只证明本轮 SQL 安全 fixture 无法完成准备，不能据此判断原生 SQL TLS/SSH 产品功能通过或失败，也不能用旧 CI / 历史测试代替重跑。

## 资源与证据保留

- 两个本轮新建 NoSQL TLS 容器均由 fixture 停止保留；另做只读核验：精确本轮 label、64 位 immutable container ID 与 `.State.Running=false` 均符合，**2 个确认停止、0 个核验失败**。
- SQL secure 失败发生在创建网络和服务容器之前；本轮没有可供 GUI 使用的 SQL 安全服务。
- 不执行 `rm`、`del`、`Remove-Item`、`docker rm/down/prune` 或 SQL DELETE/DROP。停止保留的容器和数据不作为仍在线服务。
- 原始 stdout / stderr、本轮捕获脚本、脱敏摘要、retention 核验、无秘密 Dockerfile 和构建分类留在本轮私有 `backups/` 子目录，不加入 Git 或发布附件；不读取其他 run 的私有配置、日志或凭据。
- 本轮 cargo 已全部结束并向性能验收成员明确交接。

## 与 T3 应用场景的对应边界

| 计划范围 | 本轮原生层已有证据 | 仍需已安装应用验证 |
| --- | --- | --- |
| F01—F04：浏览、分页、参数、连接事务 | driver/core 会话隔离、随机页、参数解析、事务提交/回滚通过；不是四页 GUI 操作或两标签交互验收 | macOS / Windows 实际标签、页大小、四页连续翻页与两条更新参数 |
| F05、F08：草稿保护、历史/收藏重启 | 部分 core 保存、迁移和重启检查；未做应用交互 | 两平台已安装应用草稿保护、历史/收藏恢复 |
| F06—F07：大整数与完整值 | 原生大整数精度、长文本/NUL/BLOB、完整值和比较通过 | GUI 编辑、完整值面板、复制/导出到本轮文件 |
| F09：DDL 与 EXPLAIN | 原生建表/元数据准备和 DDL 字符串校验有覆盖；含 DROP 的 SQLite EXPLAIN 用例被排除 | GUI 结构刷新、EXPLAIN 展示与本轮实际 EXPLAIN 验收 |
| F10—F11：导入/导出 | 257 行分页导入、跨批次失败全回滚、两行四格式导出及字节核对通过 | 计划指定 3 行 small.csv、100000 行 large.csv、真正触发的取消，以及两平台原生文件对话框 |
| F12—F13：比较、ER | 原生只读比较与元数据通过，生成 SQL 未执行 | 已安装应用比较预览、ER 图查看/导出 |
| 5.2：TLS/SSH、取消及只读边界 | NoSQL TLS/只读 live 两条通过；SQL TLS/SSH 四条未执行 | SQL 正确/错误 CA 与名称、取消后 5 秒门槛和 SELECT 1 可继续使用、真实应用限制提示 |

SQLite 查询取消、通用 DML RETURNING 分页不支持；MySQL SSH + verify-full 不支持。这些是保留的能力声明，本轮没有把受阻的 SQL 安全测试或未做的界面提示验收填写为通过。

本报告不覆盖安装包 GUI、平台系统对话框、凭据系统访问、实际安装/升级/卸载、Windows 实机或长期稳定性。相应 F/I 项保持各平台独立验收，不能由本轮 68 + 2 条原生回归推导通过。
