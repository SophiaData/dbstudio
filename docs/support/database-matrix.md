# 数据库支持矩阵

本页说明每个数据库支持哪些能力，以及**哪些不支持**。

判断依据分两类，文中分别标注：

- **驱动声明**：来自代码里的静态能力声明（`DriverCapabilities`），是驱动接入时给出的。
- **验证条目**：`scripts/verify-manifest.mjs` 里的测试 id。标了条目编号的，表示这条能力有自动化测试覆盖，可以用 `pnpm run <测试名>` 单独跑。

> 说明：本表只描述**当前版本**。MySQL / MariaDB 为 **Beta 只读阶段**（连接/浏览/元数据/查询可用；写入与传输待后续，见文末）。

---

## 总览

| 能力 | SQLite | PostgreSQL | Redis | Kafka | MySQL |
|---|---|---|---|---|---|
| 连接与浏览 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 表结构（列 / 主键） | ✅ | ✅ | — | — | ✅ |
| Schema 层 | ❌ 无此概念 | ✅ | — | — | ✅（database 即 schema） |
| Catalog 层 | ❌ 无此概念 | ✅ | — | — | ❌ 无此概念 |
| SQL 查询 | ✅ | ✅ | ❌ | ❌ | ✅ |
| 多语句脚本 | ✅ | ✅ | ❌ | ❌ | ✅ |
| 参数绑定 | ✅ | ✅ | ❌ | ❌ | ❌ 待补 |
| 执行计划（EXPLAIN） | ✅ | ✅ | ❌ | ❌ | ✅ |
| 取消执行中的查询 | ❌ 驱动限制 | ✅ | ❌ | ❌ | ✅（KILL QUERY） |
| 服务端分页 | ✅ | ✅ | ❌ | ❌ | ✅ |
| 网格在线编辑 | ✅ | ✅ | ❌ 只读 | ❌ 只读 | ❌ 待补 |
| 外键 / 索引 / 唯一约束 | ✅ | ✅ | — | — | ✅ |
| CHECK / 触发器 | ✅ | ✅ | — | — | ❌ 待补 |
| ER 图（真实外键） | ✅ | ✅ | — | — | ✅ |
| 结构比较（表 / 视图 / 例程） | ✅ | ✅ | ❌ | ❌ | ❌ 待补 |
| 数据比较 | ✅ | ✅ | ❌ | ❌ | ❌ 待补 |
| 分批导出（内存有界） | ✅ | ✅ | ❌ | ❌ | ❌ 待补 |
| CSV 导入 | ✅ | ✅ | ❌ | ❌ | ❌ 待补 |
| SSL/TLS | — | ✅ | ✅ | ✅ | ❌ 待补 |
| SSH 隧道 | — | ✅ | ❌ | ❌ | ❌ 待补 |

「—」表示该数据库没有这个概念（例如 Redis 没有表结构），不是"不支持"。

「❌」表示当前版本未支持。MySQL / MariaDB 当前为 Beta 只读阶段，写入/传输/SSL/SSH 等标「待补」的能力见文末。

---

## SQLite

| 能力 | 状态 | 说明 | 验证 |
|---|---|---|---|
| 连接 | ✅ | 单文件数据库 | `test:connection-lifecycle` |
| 表 / 视图 / 列 / 主键 | ✅ | 读 `sqlite_master` 与 PRAGMA | `test:sqlite-metadata` |
| 外键 / 索引 / 唯一约束 / CHECK / 触发器 | ✅ | 全部可读 | `test:metadata-contract`、`test:sqlite-metadata` |
| SQL 查询与多语句 | ✅ | | `test:resultset`、`test:sql-script-parse` |
| 参数绑定 | ✅ | 位置参数 `?` | `test:sql-params` |
| 执行计划 | ✅ | `EXPLAIN QUERY PLAN` | `test:explain` |
| 服务端分页 | ✅ | | `test:resultset` |
| 网格在线编辑 | ✅ | 需要唯一键 | `test:edit`、`test:mutations` |
| 结构比较（表 / 视图） | ✅ | 视图定义读自 `sqlite_master.sql` | `test:structure-compare`、`test:compare-live` |
| 数据比较 | ✅ | 需要可靠比较键 | `test:data-compare` |
| 分批导出 | ✅ | 内存有界，但**非时间点快照** | `test:transfer-task`、`test:transfer-wizard` |
| CSV 导入 | ✅ | | `test:import-task`、`test:gui-import` |
| **取消执行中的查询** | ❌ | **驱动限制**：`node:sqlite` 是同步 API，没有 `interrupt()`。界面会如实提示"当前驱动不支持取消"，不会假装取消成功。 | `test:cancel-sqlite` |

## PostgreSQL

| 能力 | 状态 | 说明 | 验证 |
|---|---|---|---|
| 连接 | ✅ | 支持 SSL 与 SSH 隧道 | `test:connection-lifecycle` |
| Schema / Catalog 层 | ✅ | 连接即一个 database | `test:postgresql-metadata` |
| 表 / 视图 / 列 / 主键 | ✅ | 读 `pg_catalog` | `test:postgresql-metadata` |
| 外键 / 索引 / 唯一约束 / CHECK / 触发器 | ✅ | 全部可读 | `test:metadata-contract`、`test:postgresql-metadata` |
| SQL 查询与多语句 | ✅ | | `test:resultset`、`test:sql-script-parse` |
| 参数绑定 | ✅ | `$1, $2 …` | `test:sql-params-postgres` |
| 执行计划 | ✅ | `EXPLAIN (FORMAT JSON)` | `test:explain-postgres` |
| **取消执行中的查询** | ✅ | 用独立连接执行 `pg_cancel_backend(pid)`，是**真取消** | `test:cancel` |
| 服务端分页 | ✅ | | `test:resultset` |
| 网格在线编辑 | ✅ | 需要唯一键 | `test:postgres-edits`、`test:mutations` |
| 结构比较（表 / 视图 / 函数 / 过程） | ✅ | 视图用 `pg_get_viewdef`，例程用 `pg_proc`；支持函数重载 | `test:structure-compare` |
| 数据比较 | ✅ | | `test:data-compare` |
| 分批导出 | ✅ | 内存有界，但**非时间点快照** | `test:transfer-task`、`test:transfer-wizard` |
| CSV 导入 | ✅ | 导入失败按事务回滚 | `test:import-task`、`test:import-pg-transaction-state` |
| SSL/TLS | ✅ | 不做 `sslmode` 透传，显式校验证书 | `test:postgres-ssl` |
| SSH 隧道 | ✅ | 主机指纹不做 TOFU | `test:ssh-tunnel` |

## Redis

| 能力 | 状态 | 说明 | 验证 |
|---|---|---|---|
| 连接 | ✅ | host / port | `test:nosql-drivers` |
| 键空间浏览 | ✅ | 按 db 分组展开到 key | `test:nosql-drivers`、`test:nosql-external` |
| 节点 id 解析 | ✅ | 含带冒号的 key 名 | `test:nosql-drivers` |
| TLS | ✅ | | `test:nosql-drivers` |
| **写入 / 编辑** | ❌ | **只读浏览**。所有 SQL/编辑方法一律拒绝，不是"悄悄失败"。 | `test:nosql-drivers` |
| **结构化查询 / 分页 / 取消** | ❌ | Redis 没有这些概念 | — |
| 结构比较 / 导出 / 导入 | ❌ | 无表结构，不能参与 | `test:compare-cross-dialect` |

## Kafka

| 能力 | 状态 | 说明 | 验证 |
|---|---|---|---|
| 连接 | ✅ | brokers 列表 | `test:nosql-drivers` |
| 主题 / 分区浏览 | ✅ | 展开到 topic → partition | `test:nosql-drivers`、`test:nosql-external` |
| SSL / SASL 认证 | ✅ | | `test:nosql-drivers` |
| **写入 / 生产消息** | ❌ | **只读浏览**，不提供生产者能力 | `test:nosql-drivers` |
| 结构化查询 / 分页 / 取消 | ❌ | Kafka 没有这些概念 | — |
| 结构比较 / 导出 / 导入 | ❌ | 无表结构，不能参与 | `test:compare-cross-dialect` |

---

## 数据语义（各数据库通用）

这些语义容易误解，单独说明。

### 事务

- 网格里的编辑是**未应用**状态，不碰数据库。点「应用修改」后进入事务，点「提交」才真正落盘，点「回滚」撤销。
- 有未提交事务时离开或关闭应用会被拦下，不会静默丢弃。
- 每条连接有独立的事务状态，标签之间不会互相影响。

### 导出范围与一致性

- 「全部」导出的是**当前查询**的全部结果，不受网格已加载行数限制。
- 导出采用**分批读取**（每次读完一批即写入并丢弃），因此**内存占用与总行数无关**，百万行也不会把内存吃满。
- **但这不是时间点快照**：导出过程中如果底层表被并发修改，分批之间的行可能重复或遗漏。契约里用 `consistency: 'live-paged'` 显式标注了这一点。需要严格快照请先停止写入，或等待后续版本提供真正的流式游标。
- 内容不完整时（例如超长字段被截断）会**拒绝导出并说明是哪个列、哪一行**，不会导出一份看起来正常但缺字段的文件。

### 长字段与 BLOB

- 结果集里超长文本在网格中折叠显示，比较与导出时按**全文**处理，不是拿截断后的预览去比。
- BLOB 列**不参与数据比较**——二进制内容的等价判断不可靠，我们不猜。

### NULL

- `NULL` 与空字符串是两个不同的值，比较和导出都分别对待。

### 查询取消

- PostgreSQL 是真取消（`pg_cancel_backend`）。
- SQLite **无法取消**（驱动限制），界面会明确告知，不会让用户以为已经停了。

---

## 未支持的数据库

### MySQL / MariaDB

**Beta 只读阶段（P6.2 Step 1 已完成）**。连接列表中已出现该选项，可连接真实 MySQL 8 / MariaDB。

已支持：
- 连接、`database` 作为命名空间层（等效于 schema）的目录浏览；
- 表 / 视图 / 列的主键、索引、外键、唯一约束读取（ER 图可用真实外键）；
- 分页查询、任意语句执行（DDL/DML 走影响行数）、EXPLAIN、取消（`KILL QUERY`）。

暂不支持（后续阶段补齐，界面对应操作会明确拒绝而不是给出半成品语义）：
- 网格在线编辑、事务（提交/回滚）、CSV 导入导出、结构/数据比较；
- CHECK 约束与触发器的读取；SSL/TLS、SSH 隧道；参数绑定。

验证条目：`test:mysql-contract`（真实 MySQL 8 容器，覆盖连接、目录、表结构、分页、执行、EXPLAIN 与"未实现能力如实拒绝"）。

在写入/事务补齐之前，请不要期望能在 MySQL 上做在线编辑或导入导出。
