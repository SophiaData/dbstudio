# dbstudio 目标架构：Tauri + Vue + Rust

用户于 2026-11-06 明确决定架构重构，技术栈固定为 Tauri 2、Vue 3、Rust。此文档是当前目标；旧 Electron 文档描述迁移基线，不能作为新架构已完成的证据。

参考 t8y2/dbx 固定提交 `5c97a48c17621a3d82aa0b34330e206ef1bbcbfc` 的 [核心边界](https://github.com/t8y2/dbx/blob/5c97a48c17621a3d82aa0b34330e206ef1bbcbfc/crates/ARCHITECTURE.md) 与 [应用复用说明](https://github.com/t8y2/dbx/blob/5c97a48c17621a3d82aa0b34330e206ef1bbcbfc/apps/README.md)。借鉴共享核心与宿主分离，不复制其全部功能，也不引入多租户平台。

## 依赖方向

```text
Vue desktop UI
    → typed backend client
    → Tauri command adapter
    → dbstudio-core
        → dbstudio-drivers → dbstudio-protocol
        → injected platform ports (secret store, dialogs)

Optional future HTTP / CLI / MCP adapters
    → the same dbstudio-core
```

桌面运行不依赖 HTTP listener、Electron、Node driver-host 或身份服务器。可选入口不参与桌面默认启动和退出流程。HTTP 网络暴露所需的认证及出站治理只属于其适配边界；它们不能限制本地桌面的 SQLite 文件、localhost 和内网连接。

## 模块职责

| 模块 | 负责 | 禁止承担 |
|---|---|---|
| `apps/desktop` | Vue组件、编辑器、结果标签、可见区结果、UI编辑草稿 | 数据库连接、OS凭据、任意文件系统或shell执行 |
| `src-tauri` | 桌面启动、命令白名单、OS凭据/文件对话框、关闭审批 | SQL方言、数据比较和业务状态的第二份副本 |
| `dbstudio-core` | 配置/会话/游标归属、查询编排、事务协调、数据任务、历史收藏 | Tauri/Electron导入、Node/HTTP代理旧业务实现 |
| `dbstudio-drivers` | 原生数据库协议、元数据、SQL执行、分页、事务、取消 | UI、应用配置持久化、多租户身份 |
| `dbstudio-protocol` | 共享DTO、错误、驱动接口、凭据通道 | I/O、UI、具体数据库库 |

Rust业务调用在worker线程执行，避免阻塞WebView。一个活动会话拥有一个原生驱动对象；每连接保留独立锁、事务和取消句柄。原Electron的“每连接Node子进程”不自动照搬为Rust强制架构；原生驱动的崩溃隔离与长查询取消需分别验收，不能声称线程隔离等同进程隔离。

## 状态归属

- 配置与凭据引用由core持久化，OS凭据实际读写由Tauri注入的存储接口完成。
- 活动会话、连接中/关闭中状态、驱动实例和当前事务由connection session持有。
- 未应用编辑、筛选、排序、编辑器草稿和当前结果属于对应Vue标签/编辑器。
- 游标属于原生驱动，core负责连接作用域和旧会话失效；关闭结果时释放。
- 导入导出任务持有自己的进度、取消标记与资源，断连和退出要按顺序收尾。
- 同连接多个标签共同参与连接事务；不同连接的事务互不影响。这个边界是桌面数据正确性，不是多用户隔离。

## 调用与数据约束

初始bridge为显式白名单命令 `backend_call(method,args)`。方法及JSON结果先遵循原桌面API的形状，迁移后逐步收敛强类型DTO，避免同时改运行时与数据语义。

- 配置与secret独立传递；secret不出现在连接摘要、日志、localStorage或调试格式化中。
- 大整数不能因JavaScript Number失真；大字段必须标注截断，完整读取走独立能力。
- 主键定位编辑，不能用可变行号更新数据库。
- 编辑应用不隐式提交；DDL隐式提交等方言差异必须明确守卫。
- 分页和传输有界，不能先收集全部数据再声称流式处理。
- Tauri原生文件对话框是桌面能力；生产命令不能接受任意shell或任意测试控制。
- 测试hook必须编译feature和运行环境双重启用，仅访问新建临时目录；production不注册测试能力。

## 迁移与兼容

旧Electron源码和测试保留为行为参照，当前未提交staging草稿不纳入迁移。原用户文件不参与测试或自动覆盖。

Rust使用独立的新配置schema/文件。可从旧格式导入非机密连接配置，但Electron safeStorage密文与Rust OS凭据库的格式不能假定兼容。无法恢复时明确要求重新输入或使用经验证的安全迁移入口，保留原文件；不得静默清空或转为明文。

SQLite、PostgreSQL、MySQL及Redis/Kafka既有范围按功能逐项迁移；未支持方法明确返回unsupported并显示迁移状态。Redis/Kafka既有只读边界保持。TLS/SSH模式、取消、元数据、传输和升级兼容必须分别有证据。

## 当前验证状态

- 默认 dev/build/test/typecheck/verify 已切到 Tauri/Vue/Rust，旧入口以 legacy 命令保留。
- 原生工作区 85 项、宿主 4 项、Vue 定点回归 18 项、候选包门禁 13 项通过；8 项独立真实服务测试与 macOS OS keyring 往返均另行通过。
- 增强后的 64 项真实 Tauri WebView 业务检查通过，含历史/收藏、EXPLAIN、DDL、完整值与参数化导出；独立审查后的参数、事务归属、精度、分页和文件发布保护反例均已收口。
- 无测试 hook 的生产前端与 Rust release `.app` 已实际构建；各平台安装、签名、公证和远端 CI 结果不从本机构建推导。
- 完成标准见[迁移计划](../superpowers/plans/2026-11-06-tauri-vue-rust-migration.md)，最新分项证据及明确限制见[验收台账](../support/native-migration-matrix.md)，候选包流程见[发布说明](native-release.md)。

旧 Electron/HTTP 通过数不并入新架构计数，源码存在也不替代真实运行证据。
