# MySQL 原生管理能力与对标缺口基线

截至 2026-11-07，当前原生实现具备 MySQL 连接、SELECT、表/视图浏览、InnoDB 主键 CRUD、显式事务、基础 DDL 与导入协议，但**不能据此宣称已达到 dbx / DBeaver 的 MySQL 管理体验**。优先缺口为事务状态正确性、SHOW/EXPLAIN 等管理结果、实际服务端分页、SSH + verify-full；字段/对象管理和真实 MySQL 验收也不完整。

本轮仅审查当前工作区原生 MySQL driver、直接 API/protocol/core 实现及相关测试，没有运行数据库、Cargo、旧全套测试或 GUI，没有读取真实配置/凭据/其他 backup，没有修改产品代码。HEAD 基线沿用 Lead 指定的 `7fadb00`；当前已完成的六项业务修复仍在工作区，不能把该 HEAD 字符串视为已包含这些未提交修复的新提交。本报告不是 dbx/DBeaver 的逐版本 UI 实测差异清单。

证据等级分开记录：

- **源码已实现**：当前存在可达方法及实现，不等于本轮真实 MySQL 验收通过。
- **部分**：只覆盖方法/类型/协议的一部分，或仍有明确限制。
- **缺失**：当前 API / MySQL dispatch 没有对应实现，或明确返回 unsupported。
- **未真实验**：本阶段未执行真实 MySQL；历史 native 反馈、现存 ignored 测试、纯内存契约均不能冒充本阶段 native pass。

## 后续实测与修复更新

下方保留初始静态审查快照及原责任位置，不将历史缺失判断当作最新实现状态。后续1213缓存/原错保留、四类管理结果、1062/默认OFF的1205与提交可见性已分批真实验证；最新[专用EXPLAIN记录](explain-acceptance.md)证明API已实现、全12项native回归及正常面板打开/刷新/返回通过。独立API普通无绑定SELECT完整返回计划；JSON/TREE/ANALYZE、绑定与CTE仍未开放，不能将该局部通过写成全管理能力完成。当前剩余差距以[真实结果](real-acceptance-results.md)与[执行进度](progress.md)为准。

## 初始静态审查：优先级与最小责任位置

| 优先级 | 差距 | 当前证据 | 必要工作及判定门槛 |
| --- | --- | --- | --- |
| P0 候选：事务正确性 | driver 的 active/pending 是本地缓存；deadlock 已回滚整个事务后仍可能显示 pending，下一次无实际待提交事务的 COMMIT 仍可能报成功 | [begin/execute](../../../crates/dbstudio-drivers/src/mysql.rs#L92)、[transactionState/commit](../../../crates/dbstudio-drivers/src/mysql.rs#L334)；官方确认 deadlock 的整个事务回滚语义。尚无本轮真实双连接复现，不能称 native 确诊或已修 | 用服务端 transaction status 同步状态；保留 statement rollback 与 whole-transaction rollback 的区别；连接/提交结果未知进入明确不可继续提交状态。补双连接 deadlock、默认 timeout、重复键、取消后 SELECT 1 与提交可见性验收 |
| P0 候选：错误恢复 | 每行保存点遇到 deadlock 可能已不存在，随后 ROLLBACK TO 的错误覆盖最初错误 | [edit](../../../crates/dbstudio-drivers/src/mysql.rs#L257)：错误分支无条件 rollback/release 保存点；源码与官方事务语义支持风险，未真实复现 | 同步服务端状态后决定能否 rollback 到保存点；保留原 SQLSTATE/安全错误类别，不以“保存点不存在”隐藏 deadlock；保留或清除 pending 必须符合已确认的实际事务状态 |
| P1：管理结果 | 常用 SHOW / DESCRIBE / EXPLAIN 不能按普通结果集使用；独立 explain API 在 MySQL dispatch 缺失 | [run_query](../../../crates/dbstudio-drivers/src/mysql.rs#L123)只接受 select/with；[executeStatement](../../../crates/dbstudio-drivers/src/mysql.rs#L324)遇 columns 又转入该函数；[末尾分派](../../../crates/dbstudio-drivers/src/mysql.rs#L355)没有 explain | 分类支持只读管理语句及单次结果读取；明确 CALL / 多结果集边界；补真正 explain API、SHOW CREATE/STATUS/VARIABLES/INDEX 与 DESCRIBE 的真实用例 |
| P1：分页 | 仅内存保留一页，每页却重执行原完整 SQL、跳过 offset，drop 时排空后续 wire rows；不是真正服务端 LIMIT 分页 | [page](../../../crates/dbstudio-drivers/src/mysql.rs#L100)和 [capabilities](../../../crates/dbstudio-drivers/src/mysql.rs#L296)。当前保留重复列名是正确需求，不能简单用派生表包装修复 | 见下文具体 phase；测试 wire/服务端扫描规模、LIMIT/OFFSET 语义、重复列名、参数、关闭和取消。不能拿 SQLite 性能替代 MySQL 大表证据 |
| P1：安全连接 | MySQL SSH + verify-full 显式 unsupported；TCP 地址与证书校验名未分开 | [connect](../../../crates/dbstudio-drivers/src/mysql.rs#L70)：71 行拒绝，77 行用本地地址替换 host；[cancel](../../../crates/dbstudio-drivers/src/mysql.rs#L82)复用同一 opts | 分离连接端点与原始 TLS peer name，主连接/取消第二通道都用相同 CA 与名称策略；正确 pin/CA/name 成功、错 pin/CA/name 拒绝，无 hostname-disable 降级 |
| P1：真实 MySQL 覆盖 | 当前 dedicated live 测试是 ignored；本阶段没有执行。导出/比较的现存集成测试主要是 SQLite | [network_live](../../../crates/dbstudio-drivers/tests/network_live.rs#L128)、[network_secure](../../../crates/dbstudio-drivers/tests/network_secure.rs#L263)、[core data tasks 测试](../../../crates/dbstudio-core/tests/data_tasks.rs#L17)、[compare fixture](../../../crates/dbstudio-core/tests/compare.rs#L20) | 使用全新独立 MySQL 8.0 服务与合成账号，保留对象/容器而不执行删除收尾；按实际版本/认证/传输逐项记录。存在测试文件不代表本阶段通过 |

P0 表格表示对数据/事务有影响的优先调查项；没有用条件 mock 证明 native 数据丢失，也没有本阶段实际 COMMIT 故障注入。

## 当前能力矩阵

### 连接、版本、认证、传输

| 能力 | 状态 | 当前实现 / 限制 |
| --- | --- | --- |
| MySQL 8.0 | 部分、未本阶段真实验 | 使用 [mysql crate 26 + native-tls](../../../crates/dbstudio-drivers/Cargo.toml#L18)，现存 live fixture 定位 MySQL 8.0；没有运行时 server-version 协商后的功能矩阵或明确最低 patch 校验 |
| MySQL 5.7 / 8.4 / 9.x、MariaDB | 未证，不应一概标支持 | [方言名称](../../../crates/dbstudio-drivers/src/lib.rs#L53)写 MySQL / MariaDB；CHECK_CONSTRAINTS、STATISTICS.EXPRESSION、语法、认证差异没有版本化适配保证。MySQL crate 版本不是数据库支持版本 |
| TCP、IPv4/IPv6 fallback | 源码已实现 | [connect_options](../../../crates/dbstudio-drivers/src/mysql.rs#L17)按解析到的地址族重试，仅 TCP connect 错误可重试，保留原 host 供直连 TLS 名称验证；对应离线 [单元测试](../../../crates/dbstudio-drivers/src/mysql.rs#L266)不是 TLS live 证据 |
| 用户名/密码 | 源码已实现、认证矩阵未验 | [SecretMap](../../../crates/dbstudio-protocol/src/lib.rs#L60)独立传凭据；插件协商委托 mysql crate。未暴露明确认证插件、RSA public-key pin、客户端证书身份等配置；不能由一次连接成功推导全部插件支持 |
| caching_sha2_password | 需明确真实认证场景 | MySQL 8.0 默认插件，首次完整认证与缓存快速认证要求不同；必须分别测 TLS 下首次/再次认证。不能仅测 mysql_native_password 后声称覆盖 8.0 默认认证 |
| TLS disable / require / verify-ca / verify-full | 源码已实现、未本阶段真实验 | [TLS 配置](../../../crates/dbstudio-drivers/src/mysql.rs#L70)：require 加密但不验证 CA/name，verify-ca 验证 CA但跳过名称，verify-full 不跳过两者。CA 文件至多 1 MiB；未提供产品级双向 TLS client identity 设置、协议最低版本/套件选择 |
| 直连 verify-full 正反例 | 测试已定义，未本阶段执行 | [direct_tls](../../../crates/dbstudio-drivers/tests/network_secure.rs#L194)包含正确 CA、错 CA、仅系统 roots、可达异名 require 对照及异名拒绝，并读取 Ssl_cipher；不等于现在已经通过 |
| SSH pin + password/key | 源码已实现、未本阶段真实验 | [tunnel](../../../crates/dbstudio-drivers/src/tunnel.rs#L12)：先 SHA256(raw public blob) pin 再认证，支持密码或私钥文件+passphrase；无 SSH agent、ProxyJump、known_hosts 管理、交互键盘认证接口 |
| SSH + MySQL verify-full | **明确缺失** | 本地转发接入后原服务器名称校验没有独立传递，当前主动拒绝而非不安全降级 |
| 取消 | 源码已实现、未本阶段真实验 | [cancel](../../../crates/dbstudio-drivers/src/mysql.rs#L82)用相同 opts 新建 control Conn，执行 KILL QUERY 原 connection_id；有 SSH 时会形成第二 direct-tcpip channel。需要验证权限、同身份控制、主连接可继续 SELECT 1、传输/CA/name/pin 不降级；现有 secure 测试退出门槛 <15 秒不能替代业务要求的 <5 秒 |
| Unix socket、连接池/session profile、可配置 timeout | 缺失 / 未暴露 | 当前强制 prefer_socket(false)，固定 [10 秒 timeout](../../../crates/dbstudio-drivers/src/network.rs#L18)，配置字段未包含 socket、会话时区/SQL mode/init SQL、压缩或只读 session 策略 |

### 字段精度、字符集、时区

| 能力 | 状态 | 当前实现 / 必补边界 |
| --- | --- | --- |
| INT / BIGINT / unsigned | 源码已实现、部分类型未真实验 | [cell](../../../crates/dbstudio-drivers/src/mysql.rs#L53)在 JS 安全范围外返回精确十进制文本；MValue::UInt 同样处理。已有 [live 用例](../../../crates/dbstudio-drivers/tests/network_live.rs#L29)覆盖 9007199254740993，但没有本阶段 u64 最大值等结果 |
| DECIMAL / NUMERIC / JSON | 部分 | Bytes 类型绕过 binary charset 的 BLOB 分支，使用 UTF-8 文本，避免 decimal f64 化。需要 DECIMAL(65,30)、JSON NULL / SQL NULL、JSON 字符串/Unicode/大整数、复制/导出/导入 roundtrip 真验；JSON 专门编辑与验证不属于此 driver 已实现能力 |
| FLOAT/DOUBLE | 源码已实现 | 有限值用 number；非有限转文本。不能把有损浮点当精确 decimal；未定义显示舍入与原始值编辑策略 |
| BLOB/BINARY/VARBINARY/BIT | 部分 | charset=63 的非 decimal/JSON 字节返回 BLOB，256 byte 预览与全值接口；BIT 无专门布尔/位串语义；geometry/spatial 无结构化映射。写回截断值被 [cell_param](../../../crates/dbstudio-drivers/src/network.rs#L57)拒绝 |
| 字符集 | 部分 | 连接后固定 [SET NAMES utf8mb4](../../../crates/dbstudio-drivers/src/mysql.rs#L80)，非 UTF-8 bytes 文本显式 unsupported；没有用户可选结果字符集/collation、列 charset/collation 属性或跨字符集 roundtrip 证据 |
| DATE/DATETIME/TIMESTAMP | 部分 | [cell](../../../crates/dbstudio-drivers/src/mysql.rs#L61)统一格式为带 6 位微秒的 datetime 文本，DATE 没有独立显示格式；没有 session time_zone 设置/回显策略，没有 timestamp 的时区 provenance。读取受服务器 session time_zone 影响，不能声称统一 UTC |
| TIME / 负值 / >24h | 源码已实现、未真实验 | days 合并为总小时并保留符号和 6 位微秒；需 -838:59:59.999999、零日期、fraction precision、SQL mode 严格/非严格往返用例 |
| 结果列元信息 | 部分 | [page 列映射](../../../crates/dbstudio-drivers/src/mysql.rs#L114)只返回粗 type；[describe](../../../crates/dbstudio-drivers/src/mysql.rs#L132)有 COLUMN_TYPE，但没有独立 precision/scale/unsigned/charset/collation/on-update/expression/comment 等完整可编辑属性 |
| 完整值 | 源码已实现、成本未验 | [fetchCellValue](../../../crates/dbstudio-drivers/src/mysql.rs#L308)重新执行并遍历到 row，再取列全文；不是稳定快照，且会重新排空后续结果。并发修改与大字段读取的同一行身份/性能需真验 |

### 事务、SQL、CRUD

| 能力 | 状态 | 当前实现 / 限制 |
| --- | --- | --- |
| 自动开启未提交事务 | 源码已实现 | [begin](../../../crates/dbstudio-drivers/src/mysql.rs#L99)采用 START TRANSACTION；普通 DML / 网格修改不自动提交。没有用户可配 isolation/read-only/autocommit 模型；SQL SET/BEGIN/COMMIT 等由通用执行入口拒绝 |
| 事务 active/pending | 部分，有正确性风险 | 仅本地变量；[core Session](../../../crates/dbstudio-core/src/session.rs#L31)转发 driver 结果而不修正状态。frontend 失败后查询 transactionState 的现有修复无法让后端陈旧缓存变真实 |
| 重复键/SQL 错误 | 部分 | [error](../../../crates/dbstudio-drivers/src/mysql.rs#L9)保留安全 SQLSTATE 和数字码文本，1317 映射 cancelled；缺 typed deadlock/timeout/statement-failed/transaction-ended/outcome-unknown 分类，warning/count 不展示 |
| COMMIT / ROLLBACK | 部分 | [commit dispatch](../../../crates/dbstudio-drivers/src/mysql.rs#L335)仅执行成功才清 active/pending；遇连接断开或提交回包丢失不会清缓存，但此时结果可能未知，不能宣称一定回滚。空事务 COMMIT 的 OK 也不能证明此前 pending 数据确实提交 |
| 网格主键 CRUD | 源码已实现，受限 | [insert/key/edit](../../../crates/dbstudio-drivers/src/mysql.rs#L217)绑定值、完整且仅有主键定位；insert 返回用户主键或 last_insert_id；update/delete 每行 savepoint。无主键表不做网格更新/删除，无唯一键替代；无乐观并发版本检查 |
| 非事务引擎 | 明确限制 | [require_transactional_table](../../../crates/dbstudio-drivers/src/mysql.rs#L188)仅 InnoDB 网格 CRUD/原子导入；MyISAM 显式拒绝。手写普通 SQL 并未使用同一 engine guard，不能对任意原始 DML 承诺回滚所有更改 |
| 查询/参数/批量脚本 | 部分 | driver 单条 SQL 与匿名 ? 参数；批量切分属于外层 API/UI。多结果集、session/user variables、CALL 输出参数、完整 MySQL 客户端 DELIMITER 管理语义不在当前协议内，不能把普通 SELECT 成功当完整工作台支持 |
| 结果读取命令 | 明确缺口 | SHOW / DESCRIBE / EXPLAIN 的 SELECT-only 门槛；CALL 即使被服务器执行也没有多结果集协议和“只执行一次”的存储策略，不能为翻页而重放 procedure |

### DDL、对象浏览、管理

| 能力 | 状态 | 当前实现 / 必要工作 |
| --- | --- | --- |
| schema / table / view / column 浏览 | 源码已实现 | [children](../../../crates/dbstudio-drivers/src/mysql.rs#L169)使用 information_schema，固定隐藏四个系统 schema；不提供系统库管理视图或表统计属性。索引/trigger/routine 没有独立树分支 |
| 表列、PK、UNIQUE、FK、CHECK | 部分 | [describe](../../../crates/dbstudio-drivers/src/mysql.rs#L132)查询 I_S；默认/生成/自增/required 标记存在。多个可选查询以 if let Ok 静默省略，未区分版本不支持、权限拒绝、超时、连接错误；capabilities 又统一声明支持。需要显式 unavailable/warning 与版本/权限分层 |
| 索引读取 | 部分 | [STATISTICS](../../../crates/dbstudio-drivers/src/mysql.rs#L139)有名称、唯一性、列序和 expression；缺 SUB_PART 前缀、排序、BTREE/HASH/FULLTEXT/SPATIAL、可见性、cardinality 等；混合表达式索引的列/表达式项位置也没有统一逐项表示 |
| 创建表 | 部分 | [create_table_sql](../../../crates/dbstudio-drivers/src/network.rs#L207)支持列名、白名单类型、NOT NULL、PK、AUTO_INCREMENT、安全默认字面量；不支持建表时 FK/unique/check/index/engine/charset/collation/partition/comments/generated expression。unsigned、enum/set、时间 fractional 类型等不在结构化建表白名单 |
| 改表 / 改列 / 索引管理 | 结构化 API 缺失 | [API DDL](../../../src/core/api.ts#L245)只有建/删表、建/删视图、rename；手写 ALTER/CREATE INDEX 可能经通用 DDL 执行，不等于已有可预览/回读的结构编辑合同 |
| 基础 DDL 与事务隔离 | 部分 | [executeStatement](../../../crates/dbstudio-drivers/src/mysql.rs#L327)识别 create/drop/alter/truncate/rename/grant/revoke 并在 active 时拒绝；官方还列出 LOCK/UNLOCK、FLUSH、管理语句等隐式提交。需要按真正可执行语句逐一审查，不能把首词七项白名单当完整 MySQL 隐式提交模型 |
| view | 部分 | [viewDefinition/createView](../../../crates/dbstudio-drivers/src/mysql.rs#L318)支持定义正文与新建/删除；缺 SHOW CREATE VIEW 等完整 DDL、algorithm/definer/security/check option 属性及专门修改 API |
| trigger | 只读元数据部分实现 | [TRIGGERS](../../../crates/dbstudio-drivers/src/mysql.rs#L164)读取名称、时机、事件、statement；缺 definer/sql_mode/charset/order 等完整定义，未提供专门创建/修改/查看完整 DDL 合同 |
| procedure/function | 只读列表部分实现 | [listRoutines](../../../crates/dbstudio-drivers/src/mysql.rs#L319)只有 schema/name/kind/body；缺参数、返回类型、definer/security/完整 CREATE、执行/结果多集、编辑和调试合同。权限导致 ROUTINE_DEFINITION 为 NULL 不应被 UI 描述成空 body |
| EXPLAIN / JSON / ANALYZE | 缺失 | 独立 explain dispatch 未实现；需先定义传统 tabular / JSON 形状，ANALYZE 会实际执行查询，不能直接作为无副作用解释计划合并 |
| 数据库/用户/权限、events、表维护 | 结构化管理缺失 | 当前 driver/API 没有专用 lifecycle/权限/event/维护方法。原始 SQL 通道并不等同 dbx/DBeaver 对应管理功能的实现与验收 |

### 导入、导出、比较

| 能力 | 状态 | 当前实现 / 限制 |
| --- | --- | --- |
| CSV preview 与原子导入 | core + MySQL 协议已实现，MySQL端到端未本阶段验 | [core start_import](../../../crates/dbstudio-core/src/data_tasks.rs#L394)先拒绝既有事务、校验整个 CSV、批次写入、取消/失败回滚、提交结果未知单列；[MySQL import_batch](../../../crates/dbstudio-drivers/src/mysql.rs#L197)仅 InnoDB，batchIndex 连续且锁定 target，失败禁止 commit。现存 MySQL live 只测少量 importBatch，不是 100k CSV/Application 端到端 |
| 字段映射 | 部分 | required/generated/identity 检查已有；缺 MySQL enum/set、时区/decimal/字符集特殊映射策略与业务错误逐行提示真验 |
| CSV / JSON / JSONL / SQL INSERT 导出 | core 已实现，MySQL未端到端真实验 | [start export](../../../crates/dbstudio-core/src/data_tasks.rs#L642)采用 live-paged、批次推进、保留 partial、结束后发布新文件；不是一致性快照。长字段截断按 fail-closed 处理，不能把导出预览文本当完整字段；需明确完整值导出路径与代价 |
| 结构 snapshot / compare | 部分 | [snapshot](../../../crates/dbstudio-core/src/compare.rs#L114)复用 metadata/view/routine；不保证完整 MySQL CREATE DDL/所有属性。缺失元数据不能等同对象没有约束 |
| 数据 compare | 已有通用同方言实现，MySQL未端到端真实验 | [compare_tables](../../../crates/dbstudio-core/src/compare.rs#L324)要求同方言，默认 50k、最高 500k，非二进制键、可比非 binary 列，分页取全文、计划只生成不执行。跨方言被明确拒绝；不是自动同步或快照一致性承诺 |

## SSH + verify-full 的最小补齐路径

这不是“容器缺一个配置”或“CA 不对”。当前 [connect](../../../crates/dbstudio-drivers/src/mysql.rs#L67)已经知道原数据库 host/port 并把该目标传给 SSH direct-tcpip，但建立 MySQL Conn 时用本地 127.0.0.1:tunnelPort 替代 host。mysql crate 的 [native TLS 实现](https://raw.githubusercontent.com/blackbeam/rust-mysql-simple/v26.0.1/src/io/tls/native_tls_io.rs)把该 host 转为 domain，交给 `tls_connector.connect(&domain, inner)`，于是连接地址同时决定 SNI/名称验证。[SslOpts 26.0.1 公共 API](https://docs.rs/mysql/26.0.1/mysql/struct.SslOpts.html)提供 roots、client identity 与 danger flags，当前应用未使用独立 TLS peer name 接口。

最小工作边界：

1. 在 native MySQL 连接构造中保留 **原数据库 host（TLS identity）** 与 **本地 tunnel endpoint（TCP target）** 两个值；确认当前依赖是否有可用公开分离接口。若无，使用受控、最小依赖扩展/上游改动向 TLS 握手显式传 original host。单改 ip_or_hostname 或 bind_address 不能同时完成本地转发与原始名称验证。
2. 将同一 transport/TLS 配置构造供主 Conn 和 KILL QUERY control Conn 使用；密码仍只走 SecretMap，SSH pin 在认证前校验。
3. 移除 71 行 unsupported 的前提是：正确 host/CA/pin 成功，错 host/CA/pin 均拒绝；name-negative 先证明同 alias 路径可达，避免网络失败假绿。服务器证书应为原数据库名签发，不能为迁就本地转发给业务证书添加 127.0.0.1。
4. 在 TLS+SSH 下验证事务、长字段/分页、取消第二通道和取消后 SELECT 1。不得用 require、verify-ca、danger_skip_domain_validation 或本机全局 DNS/信任库修改代替。

本报告不提出通过更换 builder、重试被拒绝 build 或新增代理路径绕过环境限制。已有普通官方 MySQL 服务镜像只可作为后续获授权的新专用服务基础；它不自动提供 SSH + verify-full 的证据。

## COMMIT 失败：可证明的语义与尚未证明的路径

[MySQL 8.0 官方 InnoDB error handling](https://docs.oracle.com/cd/E17952_01/mysql-8.0-en/innodb-error-handling.html)明确：deadlock 回滚整个事务；默认 lock wait timeout 只回滚当前语句，启用 innodb_rollback_on_timeout 后可回滚整个事务；重复键通常只回滚语句。[COMMIT 文档](https://docs.oracle.com/cd/E17952_01/mysql-8.0-en/commit.html)还明确 autocommit、START TRANSACTION、事务结束与非事务表不完全回滚的边界。

因此，不能把先前合成的“COMMIT reject 同时 backend 自动回滚，然后再次 commit 成功”写成 MySQL native 已复现：该 mock 只表示 frontend 在特定合同下的风险，没有证明 MySQL 在相同路径上会这么响应。MySQL 也不应被假设成 PostgreSQL 那样，任何单条 SQL 错误都会令整个事务失败。

当前更具体、需要真验的路径：

- **DML deadlock → server 已回滚 → driver 仍 active/pending**：源码未同步 server status，官方语义可达；随后 COMMIT 可能只对已结束事务返回 OK。这属于错误后状态/成功提示风险，不是证明“COMMIT 本身失败”。必须通过两条真实连接制造 deadlock，并用新事务/独立观察者核对此前写入与 pending。
- **COMMIT 期间连接断开/回包丢失**：源码在 execute 返回错误后保留缓存；不能知道 COMMIT 是否已生效。应标 outcome-unknown 并使会话不可继续误提交/误重试，不能无证据显示“已回滚”。[core import](../../../crates/dbstudio-core/src/data_tasks.rs#L459)已经有 commit-outcome-unknown 分支，普通 commit 接口尚未一致化。
- **默认 lock timeout/重复键 → 事务仍可继续**：不要过度修复为全部回滚，丢弃此前有效操作；需要检验 pending 保留及再次执行/提交行为。
- **保存点被整个事务回滚一并清除**：edit 错误分支不应让 rollback-to 错误替换原 deadlock；应按实际状态恢复。

建议最小实现先建立明确的 driver 状态同步/未知结果分类，再补真实双连接和受控断线证据；不是给所有异常加一次自动 ROLLBACK。

## 分页与管理结果的具体实现 phase（尚未写代码）

责任文件首先为 [mysql.rs](../../../crates/dbstudio-drivers/src/mysql.rs#L65) 的 Cursor、run_query/page/fetchResultPage/fetchCellValue，以及 [network.rs](../../../crates/dbstudio-drivers/src/network.rs#L75) 中已有词法/绑定 helper。若需要专门 MySQL 查询规划 helper，应由同一明确 owner 定义，避免多个任务同写 mysql.rs。

现有对外合同可保留：`runQuery(sql, options)` 返回 columns/rows/offset/returned/hasMore/cursorId/executedSql/elapsedMs；`fetchResultPage(rawCursor, offset, limit)` 返回 ResultPage；`fetchCellValue(rawCursor, rowIndex, columnIndex)` 返回 CellValue；`closeCursor` 幂等。raw cursor 继续不透明，core [Session](../../../crates/dbstudio-core/src/session.rs#L12)及外层连接/generation 作用域无须改成新协议。

1. **先分清执行形态**：普通无副作用 SELECT/CTE SELECT、只读管理语句、会产生副作用或多结果集的语句。SHOW/EXPLAIN/DESCRIBE 的结果必须单独接到 rows 路径；不能仅因有返回列就转入 SELECT-only validator。CALL / 带输出参数过程不得通过重执行实现翻页。独立 explain 先提供明确 tabular/JSON 合同，ANALYZE 单列。
2. **给可安全改写的查询服务端页界限**：直接保留原 SELECT 投影和列元信息，在正确的顶层语法位置应用 LIMIT/OFFSET / 参数。不能用 `SELECT * FROM (original)` 破坏当前重复列名有效用例；不能在字符串/注释/子查询 LIMIT 上做正则替换。
3. **原 SQL 有 LIMIT/OFFSET 时保持关系语义**：相对原结果的 offset/limit 应与原始限额组合，不能移除原限制、重复加 LIMIT 或向超出原窗口的请求返回额外行。处理 UNION/CTE/锁子句/已有尾部 LIMIT 的位置；暂不支持的复杂形状明确拒绝或走清楚标明的受限策略，不能悄悄回退全量排空却继续宣称服务端分页。
4. **游标仅保存策略与绑定**：可把 Cursor 扩为原 SQL + 原绑定 + 已验证分页计划/元信息，保留 ID 格式和外层映射；每页最多读取 limit+1 判断 hasMore。full-cell 应使用同一计划定位对应原始结果位置，不重新扫/排空整表；不把整表缓存到 renderer。
5. **结果一致性边界**：重执行分页仍是 live-paged，未提供稳定快照/稳定排序时需明确。不在底层擅自加 ORDER BY、额外开启或提交用户事务。仅“更多行被 LIMIT 拦住”不证明并发分页保持同一结果集合。
6. **证明语义和性能都正确**：真 MySQL 对比原结果连续性、重复列、NULL、参数位置、unsigned/decimal/Unicode、已有 LIMIT、最后一页、深 offset、只读 CTE；管理语句结果；cancel/close 后资源；大表服务端/网络读取规模。phase 完成前不将 supportsServerPagination=true 当作验收结果。

## 可以立即准备的最小真实验收条件

- 新建专用 **MySQL 8.0、InnoDB** 服务和随机 run label，使用全新 database/user；先用该版本默认 caching_sha2_password 的 TLS 全认证建立基础线，不读现有账号或系统应用。建议记录具体 patch、`VERSION()`、`@@sql_mode`、session/global time_zone、连接字符集/collation 与 InnoDB 设置；这些查询只针对本轮合成服务。
- 仅用当前允许的官方镜像直接启动新实例，不依赖 SSH 镜像 build 的基础条件即可验证 SQL 连接/只读元数据/SELECT 和明确限制；TLS 正反例需要合成 CA 与 SAN 匹配的服务器证书，不修改系统信任库。容器 stop/retain，所有对象保留，不执行 DELETE/DROP 收尾。
- **不能直接跑现存完整 network_live**：其 [第 47 行](../../../crates/dbstudio-drivers/tests/network_live.rs#L47)实际 deleteRows 并提交，[finally](../../../crates/dbstudio-drivers/tests/network_live.rs#L110)还 dropView/dropTable；合成数据也不豁免不删除约束。需要新的 retain-only MySQL 用例入口，不能先改旧测试再把原通过数照搬。
- 先测连接/UTF-8/i64/decimal/DATE/TIME/空值/重复列/管理查询/分页/元数据，再用已授权新表上的 INSERT/UPDATE + rollback 验事务。deadlock 需两条合成连接和确定顺序；COMMIT outcome-unknown 按当前目标在本 run 专属实例上先冻结精确故障范围、恢复步骤与独立观察方式，再执行故障注入，不另要求重复确认。本报告阶段未执行；若具体操作被拒绝则停止该操作，不修改系统策略或触及生产服务。
- CSV/Application 导入导出、同 MySQL 数据比较、结构修改回读应单独成为产品级用例；不能用 driver 的三行测试替代业务完成。受当前“不删除”约束的行删除、DROP、移除用户权限操作只记录实现与未验，不私自执行。

## 权威依据与限制

- [MySQL 8.0 InnoDB Error Handling](https://docs.oracle.com/cd/E17952_01/mysql-8.0-en/innodb-error-handling.html)：deadlock、lock timeout、duplicate-key 的不同回滚范围。
- [MySQL 8.0 START TRANSACTION / COMMIT / ROLLBACK](https://docs.oracle.com/cd/E17952_01/mysql-8.0-en/commit.html)：autocommit、事务结束与混合存储引擎。
- [MySQL 8.0 隐式提交语句](https://docs.oracle.com/cd/E17952_01/mysql-8.0-en/implicit-commit.html)：不能只依据七个首词覆盖所有语义。
- [MySQL 8.0 时区支持](https://docs.oracle.com/cd/E17952_01/mysql-8.0-en/time-zone-support.html)：TIMESTAMP 按 session 时区转换，DATE/TIME/DATETIME 的语义不同。
- [MySQL 8.0 caching_sha2_password](https://docs.oracle.com/cd/E17952_01/mysql-8.0-en/caching-sha2-pluggable-authentication.html)：默认插件、首次/缓存认证与 TLS/RSA 条件。
- [mysql 26.0.1 SslOpts](https://docs.rs/mysql/26.0.1/mysql/struct.SslOpts.html)与[同版 native TLS 源码](https://raw.githubusercontent.com/blackbeam/rust-mysql-simple/v26.0.1/src/io/tls/native_tls_io.rs)：名称验证如何取 host。依赖版本文档用于解释当前 major 26 的接口结构，不代替本地 resolved 版本锁定或 native 验证。

本轮已读取上述 Oracle 官方镜像和依赖源码；dev.mysql.com 入口返回 403，搜索工具认证不可用，没有调整搜索端点或系统设置。报告只声明取得的源码/权威文档依据，不把文档中的示例命令视为执行授权。
