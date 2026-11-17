# 为 DBStudio 贡献代码

本仓库当前主线为 **Tauri 2 + Vue 3 + Rust**。所有贡献者（包括 DSH、Claude Code、Codex、Cursor）应先阅读 [AGENTS.md](AGENTS.md)：它是开发规范的唯一入口，本文件只提供工作流程。

## 开始

1. 阅读 [根 README 当前架构说明](README.md) 与 [Tauri/Vue/Rust 架构](docs/architecture/tauri-vue-rust.md)，不要把 README 的历史 Electron 部分当作当前实现。
2. 查看相关模块、调用方、单测和 Issue，确认目标用户行为与失败恢复要求。
3. 安装并根据实际改动选择验证命令：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck:desktop
pnpm run test:core-unit
pnpm verify
```

`pnpm verify` 与 `pnpm run test:core-unit` 目前是**不同入口**，前者不自动执行 Vitest；不要因为只跑了一个就报告另一个已通过。Rust 测试可按 crate 使用 `cargo test --locked -p dbstudio-core` 或 `cargo test --locked -p dbstudio-drivers`。真实 UI/数据库、候选包的前置构建和 CI 见 [native-verify](.github/workflows/native-verify.yml) 与 [release](.github/workflows/release.yml)。只改文档不要求无关的全量构建，但仍需核对引用和命令。

## 开发与提交

- 使用独立分支、聚焦一个问题；不要混入无关重构、格式化或第三方依赖升级。
- 修改行为时同时补充**能区分正确与错误的测试**。纯函数测试不能代替真实 GUI/驱动/数据库验证，尤其是事务、精度、导入导出、断线恢复和权限操作。
- 对生产数据与凭据采取默认保守策略：测试仅在专用合成实例运行；意外副作用、失败/回滚不明或未验证时必须显式报告。
- PR 按 [模板](.github/pull_request_template.md) 写清动机、具体变更、验证设计、**已经运行**的测试及未运行原因；有界面改动则附截图/操作步骤和平台，涉及数据库写入则附独立回读证据。
- 提交前核对差异和格式（如 `git diff --check`），并根据改动范围运行相关检查。不得把前一次提交或其他分支的绿色 CI 冒充当前 SHA。
- 由维护者决定合并及发布；验证未完成时保持 PR Open 或 Draft。

## 规范来源

此项目**参考而不照搬** [DeepSeek Harness 官方 AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md)、[测试政策](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/testing.md) 与 [PR 描述规则](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/skills/dsh-pr-description/SKILL.md)。DSH 专属的 Cordis/Session、其测试命令或覆盖率目标不属于 DBStudio 的直接要求；请以 [AGENTS.md](AGENTS.md) 及本仓库真实 CI 为准。
