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

## 首轮 tag CI 记录

2026-11-06 推送的 `v0.8.0` 固定引用迁移提交 `30ea604b04bbcb5bc09bb9441be78141b90f0e1e`；[首次候选包运行](https://github.com/SophiaData/dbstudio/actions/runs/42221460748)中，macOS 原生 WebView/生产构建和 Linux 单测/桌面编译均通过。真实 PostgreSQL/MySQL 与 Redis TLS/Kafka TLS SASL 已通过；SQL TLS/SSH 四个用例中三个通过，MySQL 的错误主机名可达性对照失败，因而安装包构建被门禁阻止。

该对照保留 `localhost` 原主机名和完整证书拒绝断言。锁定的 MySQL 客户端默认 TCP 路径在第一个 DNS 地址连接失败时提前返回；IPv6 优先的 runner 无法回退到夹具发布的 IPv4 地址。修复须覆盖正常建连和独立取消通道，保留 TLS 的原始主机名，不用放宽校验、跳过用例或覆盖已有 tag 来取得通过。后续验证以新的提交及对应运行 SHA 为准。

MySQL 修复保持原始 `ip_or_hostname`、端口、TLS 配置和超时，通过库的 bind-address 路径逐地址族尝试；只有 TCP 连接建立失败或连接超时可进入下一地址族，TLS/认证/协议错误立即返回。正常连接和独立取消通道共用该 helper。修复后本地 88 项原生回归及四项真实 SQL TLS/SSH 均通过。原 tag 不移动，修复提交使用 `workflow_dispatch` 验证完整候选包流水线，清单中的 SHA 为实际构建提交。

[修复提交的候选包运行](https://github.com/SophiaData/dbstudio/actions/runs/42224817633)在 `8150129f3ee3b8ef3169cd628cedec3886cf599f` 上通过全部三个质量门，包含真正 Linux 上的四项 SQL TLS/SSH。Windows MSI/NSIS 和 macOS DMG 已构建、生成清单并上传；Linux DEB/AppImage 已构建，但收集器误入 Tauri 保留的 `.AppDir` 中间目录，因其中合法的应用链接而拒绝生成清单。

收集器按已有 `.app` 规则排除普通 `.AppDir` 内部内容，仅最终 DMG/AppImage/DEB/MSI/EXE 进入清单；目录入口或安装包自身的符号链接仍被拒绝，来源、完整版本、文件大小、SHA-256、缺平台和不覆盖检查保持有效。新增真实 AppDir 布局先复现旧故障，修复后 15 项门禁正反例通过。后续产物须在同一新提交及 workflow attempt 完整重建，不拼接不同运行的包。
