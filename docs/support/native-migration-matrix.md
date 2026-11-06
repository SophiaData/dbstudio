# 原生架构迁移与验收台账

目标与默认入口：Tauri 2 + Vue 3 + Rust，0.8.0；参考 dbx 的共享核心与独立宿主边界。迁移基线为 Electron 0.7.0。最后整合：2026-11-06。

此表分别记录实现、自动测试和实际平台验收。旧 Node/Electron 结果不计入原生通过数；显式 ignored 的服务用例单独执行。

| 范围 | 实现与自动回归 | 真实验收 / 限制 |
|---|---|---|
| 协议与依赖方向 | protocol → drivers → core，Tauri 消费核心，Vue typed invoke；架构护栏已通过 | 默认 dev/build/test/verify 已切原生，legacy 入口保留参照；原生核心不运行 Node/Electron/旧 JS 后端 |
| SQLite | 12 项真实临时库回归，含参数、分页、metadata、CRUD、事务、完整值、DDL、EXPLAIN、导入 | 真实 Tauri 业务链已通过；取消仍声明 false；通用 DML RETURNING 分页在执行前 unsupported |
| PostgreSQL / MySQL | 9 项离线回归；真实连接、查询、事务、CRUD、importBatch、分页、取消 | 专用 PostgreSQL 17/MySQL 8 真实用例 2/2；新增失败事务、MyISAM 写入前拒绝、重复列名、写 CTE 和 RETURNING 反例已通过 |
| SQL TLS / SSH | 四个精确 ignored 用例，专用 CA、错误 CA、证书名称和服务端加密证明 | 四项 4/4 真实通过：PG/MySQL 直连 verify-full、PG 固定指纹 SSH+verify-full、MySQL 固定指纹 SSH；含独立取消。MySQL SSH+verify-full 明确 unsupported，SSH-only 测试不计 TLS |
| Redis / Kafka | 原生只读，9 项协议回归，含 SASL 证明、精度、no-auto-create 与旧协议拒绝 | 真实 Redis TLS 和 Kafka SASL_SSL 2/2 通过；PLAIN、SCRAM-SHA-256、SCRAM-SHA-512 均实跑，证书校验未绕过 |
| 会话与资源 | connection scope/generation/cursor、独立取消、关闭与注册竞态、失败原子持久化已测 | Rust 驱动使用同进程线程与连接锁；不宣称与旧 Node 每连接进程隔离相同 |
| 配置与 SQL 库 | 16 项应用集成，含已知 v1 迁移、重复启动、未来 schema 拒覆写、v2 优先、导出目标保护 | 测试不读真实用户配置；旧 safeStorage 密文原样保留，凭据重录；已知旧历史/收藏导入独立 v2 |
| OS 凭据 | 系统 keyring 无明文回退；失败持久化/部分更新语义有故障回归 | macOS OS keyring 真实存取 1/1；仅访问唯一合成条目，按不删除规则保留 |
| 导入 / 导出 | 真实 SQLite 集成与确定性任务竞态/取消回归；CSV 与四格式有界导出 | 实际 Vue→Tauri→Rust CSV 导入、CSV/JSONL/JSON/INSERT 导出通过；真实 PG/MySQL 原子批次通过 |
| 文件安全 | 共用导出目标校验，拒绝覆盖、私有应用目录、SQLite 原/别名及 sidecar；悬空/相对链接链解析 | 悬空 WAL/SHM/journal 链、大小写/Unicode 别名与导出期间新增连接保护回归通过；宿主新文件写入、16MiB、路径/覆盖拒绝 4 项单测通过；最终发布与当前连接表变更共享临界区 |
| 结构与数据比较 | 10 项双 SQLite＋4 项类型/故障回归；比较只读，只生成 SQL | Vue 结构比较/数据比较、目标绑定、SQL 预览和不写目标检查已通过；跨方言组合未全量穷举 |
| Vue 核心与工具 | 已通过类型检查、构建及 64 项真实 Tauri WebView：连接、SQL、分页、编辑、事务、guard、ER、传输、历史/收藏、EXPLAIN、DDL、完整值、当前页导出 | 独立审查的参数跨语句、标签连接归属、大整数、secret 空格、导出重试、翻页和树偏好边界已修复；18 项纯回归及增强后的 64 项真实 WK 全通过，含两条匿名参数更新、805 行第三页编辑后跳第四页、大整数精确写入和跨连接标签关闭/异步打开 |
| 生产构建 | 新目录构建 Vue，强制关闭测试标志；Rust release 禁 test-hooks，生产入口限制参数 | 最终源码 macOS arm64 `.app` 已实际构建（未签名），静态链接检查确认只依赖系统库；保留权限的 ZIP 已生成并核对二进制哈希，静态链接后的四项 SQL TLS/SSH 再次实跑通过 |
| CI / 候选包 | 发布目标仅 macOS arm64 DMG、Windows x64 EXE；保留 macOS 原生 WK/单测与专用数据库安全夹具，移除 Linux 桌面编译和安装包；artifact 按 run/attempt 隔离，完整版本、来源和哈希均校验 | 远端 CI 试跑结果与定点修复见 CI 记录；双平台配置与 18 项候选包门禁回归本地通过，后续以同源 CI 产物及下载后哈希核验为准；安装、签名/公证和 OS 保存框/剪贴板交互仍单独验收，候选包不自动正式发布 |

本轮最终原生工作区：**88 passed / 8 explicit ignored / 0 failed**；宿主：**4 passed / 1 explicit ignored / 0 failed**。工作区 8 个 ignored 均已另以专用真实服务执行通过（普通 SQL 2、NoSQL TLS 2、SQL TLS/SSH 4）；宿主 ignored 的 OS keyring 也已单独通过。不同验证层分别报告，避免重复合计。

## 独立审查与定点修复

- SQLite `RAISE(FAIL)` 的单次插入残留使用保存点修复；真实反例已通过。
- 比较保留大整数与文本类型，完整值参与比较；只有明确 unsupported 的可选元数据可降级，故障传播。
- 凭据采用新 key 暂存、配置提交后回收；读写统一容量上限，失败注入通过。
- CSV 空串、数据库别名附属文件、任务关闭注册竞态和悬空 sidecar 链均有真实回归。
- Kafka metadata 禁自动创建 topic；旧协议编码失败不重试。
- PG RETURNING/写 CTE 仅执行一次，最多 10000 行或 16MiB；所有返回值在释放保存点前完成解码校验，失败只回滚本语句。真实数组/后页类型失败及先前事务保留反例通过。
- MySQL 无返回列的写 CTE 在预处理后、实际执行前被分页入口拒绝，完整单元格入口同样保护；真实计数/值保持反例通过。
- PG SSH 只配置一次实际端口，保留原主机名用于 TLS 校验；正确和错误名称/CA、独立取消均实跑。

## 重复验证

```sh
pnpm verify
cargo test -p dbstudio-desktop --lib
VITE_DBSTUDIO_TEST_HOOKS=1 pnpm build:desktop
pnpm exec tauri build --debug --no-bundle --features test-hooks
pnpm test:native-desktop
node scripts/native-database-fixture.mjs
node scripts/native-secure-fixture.mjs
node scripts/native-sql-secure-fixture.mjs
DBSTUDIO_NATIVE_KEYRING_TEST=1 cargo test -p dbstudio-desktop --lib secrets::acceptance::os_keyring_roundtrip_retains_only_a_synthetic_entry -- --ignored --exact
pnpm build --bundles app --no-sign
```

WebView 只访问新建 OS 临时目录和合成 SQLite。夹具仅创建本次带专用 label 的回环服务，按 immutable ID 检查归属后停止保留，网络停用保留。证书、口令、私有日志和备份不进入发布 artifacts；生产包不含测试控制器。
