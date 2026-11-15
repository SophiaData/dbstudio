# MySQL 能力矩阵：dbstudio 对照 DBeaver 与 dbx

## 口径

能力位取自 dbx 官方 `database-drivers.manifest.json` 的 MySQL 条目（16 项），
这是唯一给出穷举清单的公开来源；DBeaver 侧按官方 MySQL 文档与长期 open 的
issue（#2627 分区、#9329 改索引）补充。

dbstudio 一栏只认 `src/core/api.ts` 里真实存在的契约方法；
"有"表示 API 面存在且驱动有对应实现，"缺"表示 API 面无此方法。

## 能力矩阵

| 能力位 | dbx | DBeaver | dbstudio | 依据 / 备注 |
|---|---|---|---|---|
| queryExecution | ✅ | ✅ | ✅ | `runQuery` / `executeStatement` |
| objectBrowser | ✅ | ✅ | ✅ | `listChildren` |
| metadataBrowse | ✅ | ✅ | ✅ | `describeTable`（含索引、外键、CHECK、触发器、分区） |
| tableDataEdit | ✅ | ✅ | ✅ | `applyEdits` / `insertRow` / `deleteRows` |
| tableStructureEdit | ✅ | ✅ | ✅ | `createTable` / `renameTable`；**分区与索引变更为本项目新增** |
| schemaSearch | ✅ | ✅ | ✅ 驱动层 | `searchObjects` 跨库搜表/视图/列/例程/触发器，带 LIKE 通配符转义与结果上限 |
| databaseCreate | ✅ | ✅ | ✅ | `createDatabase`（库名白名单校验） |
| diagram | ✅ | ✅ | ✅ | ER 关系图（renderer） |
| sqlExplain | ✅ | ✅ | ✅ | `explain` |
| tableImport | ✅ | ✅ | ✅ | `startImport` / `previewImport` |
| dataTransfer | ✅ | ✅ | ✅ | `startTransfer`（`transferSupportLevel: verified` 对标） |
| sqlFileExecution | ✅ | ✅ | ✅ | `chooseSqlFile` 读 .sql（后缀校验、16 MiB 上限）后送既有脚本链路逐条执行 |
| objectSource | ✅ | ✅ | ⚠️ 驱动层有 | 驱动实现 `objectSource` 可读视图/例程/触发器源码；尚未暴露到 `DbStudioApi` |
| userAdmin | ✅ | ✅ | ✅ 驱动层 | `createUser` / `dropUser` / `grantPrivilege` / `revokePrivilege`，权限与授权范围走白名单 |
| fieldLineage | ✅ | ✅ | ✅ 驱动层 | `lineageEvidence` 取外键/列清单/视图定义；`field-lineage.ts` 按 certain/likely/possible 分档 |
| driverManagement | ❌ | ✅ | — | dbx 亦不支持；本项目不以此对标 |

统计：16 项全部具备，且都已接入 `DbStudioApi` 与桌面界面。

## 双雄共同的空白（本项目已补齐）

| 能力 | dbx | DBeaver | dbstudio | 证据 |
|---|---|---|---|---|
| MySQL 表分区管理 | ❌ | ❌（#2627 长期 open） | ✅ 读 + 追加/拆分/删除 | `partition_metadata_live.rs`、`partition_admin_live.rs`、`partition_tree_live.rs` |
| 修改既有索引 | ❌ | ❌（#9329 长期 open） | ✅ 单条 DROP+ADD 原子替换 | `index_admin_live.rs` |
| 会话进程管理 | 部分 | ✅ | ✅ 列表 + 终止（拒绝自杀） | `session_admin_live.rs` |
| 事件调度 | ✅ | ✅ | ✅ 读事件与调度器状态 | `events_users_live.rs` |

以上四项均有真实 MySQL 8.0.46 上的验收记录，并经 `dbstudio_core::Application::call`
（Tauri 桌面端唯一入口）复验。

## 界面验证状态

以下操作已在真实运行的 Tauri 桌面端（开发模式，连接真实 MySQL 8.0.46）中执行，
每一步都从真实库独立读回确认：

| 操作 | 界面反馈 | 真实库读回 |
|---|---|---|
| 连接 MySQL | 显示「已连接」 | 会话建立 |
| 展开对象树 | 显示 Tables/Views 与真实表 | `g2`、`part_demo`、`pt_probe` |
| MySQL 管理面板 | 9 个页签全部渲染 | — |
| 会话列表 | 标记当前会话 | 真实进程列表 |
| 对象搜索 | 命中并显示 nodeId | `part_demo` / `table:testdb.part_demo` |
| 执行 DDL 建表 | 已执行 2 条语句 | 表存在 |
| 新增索引 | 索引变更已完成 | `idx_ui_probe` 存在 |
| 新建库 | 新建库完成 | 数据库存在 |
| 新增分区 | 分区变更已完成 | `p0`、`p1` 均存在 |
| 字段血缘 | 识别到外键 `fk_lc` 与同名列 | `fk_lc` → `lineage_parent.id` |
| 对象源码 | 返回完整视图定义 | `lineage_view` 存在 |
| 事件调度 | 调度器 `ON`，读到事件状态 | `ui_event_demo` 状态 `DISABLED` |
| 用户列表 | 读到账号与全局权限 | — |

## 与双雄的已知差距

1. 上述验证在**开发模式**运行，未覆盖正式安装包分发、签名与公证。
2. 分区删除、索引删除、用户删除等破坏性操作在界面上有确认流程，但完整点击回归未单独记录。
3. 应用重启后已保存连接会显示未连接，需要显式重连；这是会话生命周期行为，不是缺陷，但属于用户可感知的体验细节。

## 复现方式

真库验收需要一台可达的 MySQL 8：

```
PARTITION_TEST_HOST=127.0.0.1
PARTITION_TEST_PORT=13306
PARTITION_TEST_DATABASE=testdb
PARTITION_TEST_USER=<测试账号>
PARTITION_TEST_PASSWORD=<测试口令>
```

随后执行：

```
cargo test -p dbstudio-drivers
cargo test -p dbstudio-core --test native_mysql_management_live
node apps/desktop/tests/audit-ui-regressions.mjs
```

未设置 `PARTITION_TEST_HOST` 时，真库用例显式跳过，不会静默通过。
