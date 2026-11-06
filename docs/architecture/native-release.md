# 原生候选包与发布验收

0.8.0 的默认构建使用 Tauri 2、Vue 3 与 Rust。旧 Electron 发布门禁仍保留作参照，当前 release workflow 使用 native-verify 和 native-release-gate，不调用 electron-builder。

## 本机构建

```sh
pnpm build --no-bundle
pnpm build --bundles app --no-sign
pnpm build:app:mac
```

生产入口创建全新的前端输出目录，显式关闭 Vite 测试标志并检查编译产物，再将该目录传给 Tauri。入口只允许列出的目标与包类型参数，拒绝调试、feature、runner 和外部 config 覆盖；Rust release 也拒绝 test-hooks。

当前 macOS 默认输出为 `target/release/dbstudio-desktop` 和 `target/release/bundle/macos/dbstudio.app`。显式指定 Rust target 时，路径包含该 target 子目录。最终本地构建使用 `aarch64-apple-darwin`，应用位于 `target/aarch64-apple-darwin/release/bundle/macos/dbstudio.app`。

生产 wrapper 设置 `OPENSSL_STATIC=1`；macOS 构建后使用 `otool -L` 检查只允许系统动态库，拒绝依赖开发机 Homebrew 路径的应用。最终 `.app` 已通过该检查，并保留权限归档为 `dist/dbstudio_0.8.0_aarch64_native.zip`；同名 JSON 记录大小、SHA-256、基线 commit 与未提交工作区来源，不伪称已发布提交。

`--no-sign` 生成未签名本地候选应用，不构成签名或公证验收。

## CI 候选包

当前发布范围由用户确认为两个目标：**macOS arm64 DMG** 和 **Windows x64 EXE（NSIS）**。release workflow 由版本 tag 或手动操作启动，先复用原生质量门，再分别使用全新生产前端与原生 Rust 宿主生成这两个安装包。Linux 安装包、Linux 桌面编译和额外 MSI 不参与本次发布；Ubuntu 仅用于专用数据库测试与清单校验。

每个目标必须具有非空安装包，并附清单：源码 SHA、版本、workflow run ID/attempt、目标平台、文件大小与 SHA-256。清单生成时核对 package/Cargo/Tauri 版本。下载后的聚合步骤只要求 macOS 和 Windows 两个目标来自同一次运行及 attempt，重新验证大小和哈希；缺少任一目标、路径穿越、符号链接、额外文件和来源不匹配均会失败。Artifact 名包含 run ID/attempt，保留旧运行证据；失败后需使用“重新运行所有作业”，生成同一新 attempt 的双平台候选包。完整版本 token 校验拒绝将 `10.8.0` 或 `0.8.0-rc.1` 文件声明为 `0.8.0`。

候选包以 GitHub Actions artifacts 保留。清单固定标记 `installerAcceptance: unverified`；不能靠修改清单将安装验收提升为已通过。当前工作流不自动发布 GitHub Release，避免把尚未完成各平台安装验收的原生候选包分发为正式版本。

## 现有证据与后续平台验收

- macOS 真实 Tauri WebView 的业务检查、原生工作区/宿主单测，以及 OS keyring 合成凭据往返均在本机执行。
- 原生 PostgreSQL/MySQL、Redis TLS/Kafka TLS SASL、SQL TLS/固定指纹 SSH 已使用专用服务夹具实测；错误 CA、证书名称与取消通道有独立反例。
- 安装包内部完整性、来源及传输后哈希校验通过合成负例验证；这不替代安装/升级/卸载测试。
- macOS DMG 安装、Developer ID 签名/公证及 Windows EXE 安装尚需对应平台验收。此前已进行远端 CI 试跑，结果见[CI 记录](native-ci.md)；双平台配置与候选包门禁回归已在本地通过，后续执行以该配置提交的远端 CI 和下载后哈希核验为准。工作流不自动正式发布。
- OS 保存对话框与剪贴板的实际系统交互保留人工平台验收；自动检查覆盖组件状态、导出内容及原生文件写入保护。

所有夹具仅访问专用临时数据。容器停止后保留；私有证书、环境文件、备份与原始日志不上传为 artifacts。钥匙串验收保留一个唯一命名的公开合成条目，不访问已有用户凭据。
