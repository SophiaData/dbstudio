# DBStudio 开发与 Agent 协作规范

本文件是 DBStudio 对开发者与代码 Agent 的统一工程约束，适用于 DSH、Claude Code、Codex、Cursor 等工具。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。**本文借鉴 DeepSeek Harness (DSH) 官方的工程原则，并非 DSH 官方对 DBStudio 的认证或要求。** 如与仓库真实代码、执行命令冲突，先核实并在同一 PR 中修正文档，不要悄悄绕开检查。

## 1. 先确认当前事实

1. 读本文件和改动目录下更具体的 `AGENTS.md`（如将来存在），再读目标实现、调用方、对应测试与相关文档。
2. 当前桌面主线是 **Tauri 2 + Vue 3 + Rust**；根 `README.md` 的“0.7.0 参照实现与历史说明”是 legacy 资料，**不得据此添加 Electron/driver-host 新代码**。优先阅读 [目标架构](docs/architecture/tauri-vue-rust.md) 与 [原生迁移矩阵](docs/support/native-migration-matrix.md)。
3. 实际脚本和门禁以 `package.json`、`Cargo.toml`、`.github/workflows/verify.yml`、`.github/workflows/native-verify.yml`、`.github/workflows/release.yml` 为准。不得引用已经移除的测试文件、运行时或虚构命令。
4. 明确本次任务的**用户可见结果、数据副作用、错误与恢复行为、平台/数据库范围、验证边界**。较大改动先列出方案与风险；无关的重构、格式化、依赖升级应拆成独立 PR。

## 2. 代码所有权与边界

| 位置 | 职责和约束 |
| --- | --- |
| `apps/desktop/` | Vue UI、页面状态与交互；数据库访问经类型化后端接口，不在组件内直接接数据库或保存明文凭据 |
| `src/core/` | 前端复用的无 I/O 业务模型、SQL/导入导出纯逻辑；测试与实现相邻 |
| `src-tauri/` | Tauri 宿主、命令桥与窗口生命周期；生产构建禁止开启测试钩子 |
| `crates/dbstudio-core/` | Rust 业务核心、连接/会话/事务生命周期；需明确操作所有权与失败后的状态 |
| `crates/dbstudio-drivers/` | 原生 SQL/Redis/Kafka 驱动、协议与类型转换；精度、取消、超时及资源释放不能靠 UI 假定 |
| `scripts/`、`tests/`、`docs/` | 夹具、独立观察、回归与可追溯验收；证据不能替代执行 |

- **接口/协议/持久化**：改字段、语义、序列化或跨层错误码时，检查所有消费者、兼容迁移及测试。外部 JSON、磁盘、RPC 与数据库边界必须验证；已由同进程类型保证的值不重复造防御性校验。
- **失败必须可见**：数据库查询、元数据、凭据存储与导入导出的错误不可用 `unwrap_or_default`、空 `catch` 或“成功”提示掩盖。区分失败、取消、超时、未提交、提交结果未知；只在状态确实确定时声明回滚/提交成功。
- **生命周期和并发**：连接、游标、后台任务、异步 UI 响应须有清晰所有者；窗口关闭、切换连接、取消操作和重试需要清理/释放。迟到响应不得覆盖新标签、草稿或结果；资源归属测试需覆盖失败路径。
- **精确性与安全**：BIGINT、DECIMAL/NUMERIC、时区、NULL/空串、BLOB 不得经不安全的 JS Number 或有损文本转换；SQL 值走方言正确的绑定/编码，标识符单独安全转义；授权、DDL 和删除动作必须核对精确目标，必要时显式确认。
- **最小修改**：优先沿用现有模型/接口，避免复制另一套参数解析、错误分类、测试报告或状态表。注释只解释局部非显然约束、失败语义和风险，不复述代码或贴推理过程。

## 3. 测试与证据：测真实用户任务

遵循 DSH 官方“选最小相关验证、真实入口优先、从外部验证结果、失败测试必须能变红”的原则，**按 DBStudio 实际架构落地**，不照搬 DSH 的 Cordis/Session/snapshot 专用测试要求。

| 改动 | 优先验证（依赖按实际环境选择） |
| --- | --- |
| TS/Vue 模型或核心逻辑 | `pnpm run test:core-unit`，`pnpm run typecheck:desktop`，有关时再跑 `pnpm run test:native-ui-models` |
| Rust 核心或驱动 | 对应 `cargo test --locked -p dbstudio-core` / `-p dbstudio-drivers`；影响跨 crate 再跑 `pnpm verify` |
| Tauri UI、连接、编辑、恢复 | 原生桌面 WebView 与真实后端测试；`pnpm test:native-desktop` **需要预先构建带 test-hooks 的 debug Tauri 主机**，优先对照 `native-verify.yml` 的实际步骤 |
| 真库类型/事务/网络/权限 | `scripts/native-database-fixture.mjs` 等专用夹具与独立数据库连接回读；按改动选择 MySQL、PostgreSQL、TLS/SSH/Redis/Kafka 对应门禁 |
| 发布与平台 | `native-verify.yml` 与 `release.yml`，区分 test-hooks、无钩子生产可执行文件、候选安装包以及实际安装/签名/公证 |
| 仅文档/Agent 指令 | 核对仓库路径、命令、链接与事实；不把未运行的构建或测试写成通过 |

- **不要把单测、合成 DOM、真实驱动、真实 Tauri + 独立回读、参考产品操作、正式安装包混称为“完整验收”**。原生 WebView 的 SQLite 冒烟不能自动证明 MySQL GUI 通过。
- 有状态或高风险操作必须使用**专用合成数据与隔离环境**；读取真实业务库、生产凭据、用户工作区或执行破坏性动作必须先有明确授权，默认仅做只读检查。测试夹具不得误指向生产实例，清理时必须验证自己创建的资源身份。
- 为缺陷增加能在修复前变红、修复后变绿的回归；UI/数据库副作用以**独立连接、外部文件或真实界面**检验，不以同一函数返回的 `ok` 自证。
- 报告 `passed / failed / blocked / not-run / skipped`，说明**实际运行的命令、环境及证据链接**；`skip` 不得计为通过。某门禁未接入的测试不能声称“CI 已覆盖”。
- MySQL 对标沿用 [M01–M23 验收契约](docs/support/mysql-parity/acceptance-contract.md) 和 [覆盖映射](docs/support/mysql-parity/coverage-map.md)，dbx 参考实测与 DBStudio 自身执行证据分开记录；本次 PR 不自动提升任务状态。

## 4. 提交与复审

1. **先读再改**：查看当前 `main` 与目标分支、相关 PR/Issue；优先小范围、可审阅变更。
2. **变更同步**：行为/公共接口改变时，同 PR 修改调用方、相关回归及唯一事实来源文档；不要复制生成报表或历史验收记录当现状。
3. **验证后提交**：按改动选择聚焦测试；不要为追求绿色跳过失败、静默降级、禁用断言或降低安全保障。执行不了的验证要写明原因和影响。
4. **PR 交付**：按 [PR 模板](.github/pull_request_template.md) 描述动机、范围、测试设计和结果、兼容/数据风险及 AI 参与情况；关联 Issue，列出未覆盖项与复现办法。一个 PR 尽量只解决一类问题。
5. **审查优先级**：数据正确性与丢失、越权/凭据泄露、事务与资源生命周期、用户工作流回归 > 一般性能 > 风格。没有真实证据不宣称“产品体验与 dbx 对齐”。
6. **合并和发布**：提交 PR 不等于授权合并或发布；不得自动发布候选、安装包，或执行生产数据库变更。发布流程遵循现有人工验收与工作流约束。

## 5. 参考与适配边界

原则参考 DSH 官方：[AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md)、[Testing policy](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/testing.md)、[Pre-push checks](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/skills/dsh-pre-push-checks/SKILL.md)、[Code review](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/skills/dsh-code-review/SKILL.md)。**DSH 规则是参考，不是依赖：** 不引入其插件注册、Session 格式、SDK 双语言门禁、100% coverage 门槛或专用命令；任何实际执行要求必须对应 DBStudio 仓库已有能力。
