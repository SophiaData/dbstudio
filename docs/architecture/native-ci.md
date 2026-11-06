# Native desktop CI

新增 native-verify workflow 验证 Tauri＋Vue＋Rust 入口，可由 main push、pull request、手动或其他 workflow 调用。它不发布应用、不需要仓库密码或签名密钥，既有 verify workflow 保留旧版参照，release workflow 复用本流程构建原生候选包。

| Job | 实际门禁 | 不覆盖的范围 |
| --- | --- | --- |
| macOS 15 desktop | Rust stable、Node 24、pnpm 11 frozen install；架构边界；portable workspace 单元/集成测试；带显式 Vue test controller 与 Rust test-hooks 的 Tauri debug 构建；真正 WebView invoke/SQLite smoke；全新生产前端与无 hooks 的 release 二进制 | 应用签名、公证、安装包发布、生产 OS keyring 交互 |
| Ubuntu 24.04 native | portable workspace 测试、Vue 类型检查与前端构建、Tauri 生产 host 的 cargo check | 没有运行 Linux GUI；不能将编译检查作为 Linux WebView smoke |
| Ubuntu 24.04 databases | Docker 专用随机凭据 PostgreSQL/MySQL，随后 Redis TLS/Kafka TLS SASL，最后 SQL verify-full/固定指纹 SSH 与独立取消 | 未配置的模式不计通过；MySQL SSH+verify-full 是显式 unsupported 限制断言 |

macOS smoke 构建只在对应前端步骤设置 `VITE_DBSTUDIO_TEST_HOOKS=1`，再执行：

```sh
pnpm exec tauri build --debug --features test-hooks --no-bundle --ci
pnpm test:native-desktop
pnpm build --no-bundle
```

测试二进制位于 `target/debug/dbstudio-desktop`。生产 wrapper 为前端创建全新输出目录、强制关闭测试环境标志并拒绝 test-hooks，最后要求 `target/release/dbstudio-desktop` 可执行。生产二进制只检查产物，不启动它访问真实用户目录或系统 keyring。CI smoke 使用测试注入的临时 SecretStore，不把测试凭据存入系统 keyring。

Linux 桌面检查显式安装 build-essential、pkg-config、OpenSSL、libssh2、WebKitGTK 4.1、Ayatana appindicator、librsvg 和 patchelf。该 job 不使用 Xvfb，也不执行 macOS 的桌面 smoke 命令。

数据库 job 不安装 JavaScript backend 依赖，Node 只编排专用 Docker fixture，数据库协议由 Rust 测试执行。先运行 `cargo test --locked -p dbstudio-drivers --tests --no-run`，随后：

```sh
node scripts/native-database-fixture.mjs
node scripts/native-secure-fixture.mjs
node scripts/native-sql-secure-fixture.mjs
```

三个脚本顺序执行，限制同时运行的数据库占用，Cargo 并发限制为 2。没有使用 `--prepare-only`、跳过测试或零匹配结果来代替真实验收。fixture 自行生成随机凭据和短期测试证书，只停止并保留经过本次运行 label/不可变 ID 校验的容器；workflow 不执行容器删除、磁盘清理或日志导出。

私有 fixture 文件、证书、环境文件、完整 backups 目录和 container inspect/log 内容不上传为 CI artifact。失败通过命令退出码使对应 job 失败，不能因为没有上传诊断而把失败标记为成功。生产 OS keyring、真实外部账号及远程部署另行验收，不能从该 workflow 的 synthetic fixture 结果推导。

本地可先运行不依赖 keyring 的架构检查与 Vue 类型检查：

```sh
pnpm test:native-architecture
pnpm typecheck:desktop
```

workflow 文件的本地 YAML 解析、固定命令检查或上述两项通过不等于 GitHub macOS/Linux runner 已通过；只有真实 workflow 执行结果能确认平台门禁。
