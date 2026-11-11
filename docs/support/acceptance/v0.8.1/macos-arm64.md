# v0.8.1 macOS arm64 安装验收

执行日期：2026-11-07（Asia/Shanghai）。执行者角色：macOS 静态包验收执行者。

**结论：发布包来源与静态检查已执行，I01 仅完成只读挂载和专用目录复制；首次启动及业务验收受阻，不能计为安装验收通过。** 本次未启动生产应用，未修改 HOME、真实用户配置、系统凭据或 Gatekeeper 设置。

## 基线与环境

| 项目 | 本轮证据 |
| --- | --- |
| 版本 | 0.8.1；包内 CFBundleShortVersionString、CFBundleVersion 均为 0.8.1 |
| 发布基线 | `7fadb00d6f9ee2cbf87949e9f908517c508a2956` |
| 发布 CI | run `42256930038`，attempt `1`；按本地发布 manifest 和 release-verification 核对，本次未重新下载 |
| 安装包 | `dbstudio_0.8.1_aarch64.dmg` |
| 大小 | 7,859,717 bytes，与 manifest 一致 |
| SHA-256 | `88fc058cbdc44504f7001818c1366d8bbc2b6417a6f2265417959aa8461a5de7`；本次独立计算，与 SHA256SUMS、manifest、release-verification 三者一致 |
| 执行平台 | macOS 27.2；arm64；16 GiB 内存；未采集序列号、用户名或完整系统转储 |
| 独立测试账户 | 未提供；当前会话不能证明生产应用数据及 keyring 与真实用户隔离 |
| 合成数据与人工服务 | 本任务未生成附录 A 数据，未启动数据库服务；不将历史回归或已停止容器算作本轮人工业务验收 |

发布文件参考：[mac manifest](../../../../dist/release-v0.8.1-42256930038-1/packages/mac-arm64/manifest.json)、[SHA256SUMS](../../../../dist/release-v0.8.1-42256930038-1/SHA256SUMS)、[release-verification](../../../../dist/release-v0.8.1-42256930038-1/release-verification.json)。这些记录未被修改。

## 已执行静态操作

本轮独占证据目录：[mac-readiness-be2af51077c843d3864e30b7c24f7ba4](../../../../backups/mac-readiness-be2af51077c843d3864e30b7c24f7ba4)。证据与复制包保留，不加入发布附件。

1. 原 DMG 为普通文件、非符号链接、链接数为 1；计算 SHA-256 完全匹配。
2. `hdiutil verify <release-dmg>` 返回 0，校验和有效。
3. 使用 `hdiutil attach -readonly -nobrowse -noautoopen -mountpoint <本轮新目录>` 挂载，返回 0。没有 Finder 自动打开或应用启动。
4. 顶层 `Applications` 是指向系统 Applications 的符号链接，仅记录、未跟随、未复制目标。`dbstudio.app` 本身不是链接。
5. 复制前审查包内文件：无内部符号链接；3 个普通文件均为单链接，无特殊文件。目标为本轮新建的 `installation/dbstudio.app`，未写系统 Applications 或覆盖既有安装。
6. 复制后逐个普通文件重新计算 SHA-256，与只读挂载源一致；目标普通文件仍为单链接。该操作证明包可复制到空位置，不证明应用可启动或 Finder 拖拽交互已通过。
7. `file` 与 `lipo -archs` 均确认主程序为单架构 arm64 Mach-O。Info.plist 标识为 `io.dbstudio.desktop`，可执行程序为 `dbstudio-desktop`。
8. `otool -L` 列出的直接动态依赖均位于系统 Frameworks 或系统 lib 路径，包含 AppKit、WebKit、Security 等；未发现第三方绝对运行时路径。此结果不单独证明全部静态链接内容或运行时可用性。

静态原始证据：[preflight](../../../../backups/mac-readiness-be2af51077c843d3864e30b7c24f7ba4/static-preflight.json)、[挂载条目](../../../../backups/mac-readiness-be2af51077c843d3864e30b7c24f7ba4/mount-entries.json)、[应用静态结果](../../../../backups/mac-readiness-be2af51077c843d3864e30b7c24f7ba4/app-static.json)、[原包签名复核](../../../../backups/mac-readiness-be2af51077c843d3864e30b7c24f7ba4/signature-source-check.json)。本轮挂载和复制目录保留，未执行删除或清理命令。

## 签名、公证与系统信任

| 项目 | 结果 | 实际证据与限制 |
| --- | --- | --- |
| Mach-O 签名类型 | 已确认 ad-hoc | `codesign --display --verbose=4` 返回 0，显示 `Signature=adhoc`、`TeamIdentifier=not set`、`Info.plist=not bound`、`Sealed Resources=none` |
| 严格 bundle 签名验证 | 失败 | 原只读挂载包与复制包执行 `codesign --verify --deep --strict --verbose=2` 均返回 1：`code has no resources but signature indicates they must be present`。源/目标字节一致，错误不由复制产生 |
| 包内主二进制严格验证 | 失败 | 对复制包内 `Contents/MacOS/dbstudio-desktop` 执行 `codesign --verify --strict --verbose=2` 返回 1，错误与 bundle 相同。此路径位于 bundle 内，未另外提取到包外验证，不能据此断言独立 Mach-O 签名本体损坏 |
| Developer ID 分发签名 | 未通过本项验收 | 当前观察到的是 linker ad-hoc 签名，不能计作 Developer ID 签名成功 |
| Apple 公证/票据 | 未验证 | 未执行联网公证查询、票据校验或提交 |
| Gatekeeper 首次启动提示 | 未执行 | 未启动应用，未运行绕过命令，不能由静态签名结果推断实际系统提示 |

该签名状态已通知 Lead，作为 macOS package signature 异常记录，不指定 P1 等级，也不据此宣称应用不能运行。`codesign --display` 的 `adhoc,linker-signed`、无 TeamIdentifier 与无 sealed resources 表明当前不是完整 Developer ID bundle 分发签名；现有静态证据不足以单独确认所有失败原因就是“未做 bundle signing”。[主二进制验证证据](../../../../backups/mac-readiness-be2af51077c843d3864e30b7c24f7ba4/binary-signature-check.json)保留原始结果。未对已发布包重新签名、修改资源或移除隔离属性。

## 生产运行隔离判断

已读初始化源码，并通过限定文件的 `git diff --quiet <baseline> -- ...` 返回 0，确认下述源码与发布基线一致：

- [宿主 setup](../../../../src-tauri/src/lib.rs#L169)：生产分支使用 `app_data_dir()` 和 `OsSecretStore`，旧目录固定为 `config_dir()/dbstudio`。生产构建遇 `DBSTUDIO_NATIVE_SMOKE_ROOT` 会拒绝，不能用该变量隔离正式发布包。
- [storage](../../../../crates/dbstudio-core/src/storage.rs#L80)：v2 缺失时从指定旧目录读取配置与 SQL library；旧凭据文件只检查存在，不能据此认为启动不会访问真实配置。
- [OS keyring 适配](../../../../src-tauri/src/secrets.rs#L11)：使用固定服务名的系统凭据存储；本次没有调用、枚举或读取任何凭据。

测试 feature 的 fixture 路径与内存 SecretStore 仅是实现对照，不是本轮 production 安装验收证据。没有发现不修改 HOME/真实用户目录即可为此发布包指定完整隔离配置与凭据域的生产入口。本轮按计划停在启动之前，Lead 已确认不 launch。

继续执行所需条件：独立、干净的 macOS 测试账户或 VM，明确没有既有 dbstudio 配置；该环境的交互式 GUI 会话与操作者；合成数据和专用服务账户；由操作者处理真实系统信任与凭据提示。不得创建账户或关闭全局安全保护来绕过当前授权边界。

## I/F 用例状态

| ID | 状态 | 本轮结果或阻塞条件 |
| --- | --- | --- |
| I01 | 部分执行，未通过整体项 | DMG 哈希、完整性、只读挂载、新位置复制、字节一致均完成；首次启动和系统提示未执行，缺独立 OS 测试环境与 GUI |
| I02 | 不适用本平台 | Windows 安装由独立平台任务记录 |
| I03 | 受阻 | 未启动生产包，无法验证 SQLite 连接保存与重启 |
| I04 | 受阻 | 缺独立测试账户、专用服务凭据及人工操作；未接触真实 keyring |
| I05 | 受阻 | 未执行生产运行与系统提示，不能记“不适用”或拒绝重试通过 |
| I06 | 受阻 | 原生保存框取消/保存未执行 |
| I07 | 受阻 | 未操作应用剪贴板，也未读取现有剪贴板 |
| I08 | 受阻 | 多标签脏稿保护、取消退出、正式退出与无残留进程未执行 |
| I09 | 受阻 | 未完成首次启动，不能验证再次启动 |
| F01–F13 | 全部受阻，均不计通过 | 当前平台生产启动前置条件未满足；没有以静态检查、源码回归、test-hooks 或其他平台代替 |
| 升级 | 未验证 | 不将复制新版本或旧格式回归计为实际升级 |
| 卸载 | 受限，未执行 | 涉及删除，按本轮约束保持未验证 |

本报告仅支持“正确发布 DMG 已完成有限静态检查及非覆盖复制”的结论，不支持“macOS 安装验收通过”“已可公开无提示启动”或任何业务/性能通过结论。

## 补充：独立 Mach-O 与 bundle 上下文对照

按 Lead 要求，仅在本轮证据目录内将已核验的主二进制复制出 `.app`，没有移动、签名或启动。操作前检查源与目标的绝对路径及链接状态：源为单链接普通文件，源路径解析未经过符号链接；目标和目标父目录原先不存在。独立目标为 `standalone-comparison/dbstudio-desktop-standalone`，复制后同为单链接普通文件。

源和独立目标 SHA-256 完全相同：`f34fcafcb5e2dd5344cf3b474a6999dc101ec46db73255b84a92e89983c8fc4e`。

| 验证位置 | 命令 | 返回码及结果 |
| --- | --- | --- |
| 原挂载 `.app` 与本轮复制 `.app` | `codesign --verify --deep --strict --verbose=2 <app>` | 均为 1；`code has no resources but signature indicates they must be present` |
| 复制 `.app` 内主二进制路径 | `codesign --verify --strict --verbose=2 <app>/Contents/MacOS/dbstudio-desktop` | 1；相同资源校验错误 |
| 包外独立、字节相同的 Mach-O | `codesign --verify --strict --verbose=2 <standalone-file>` | **0**；`valid on disk`、`satisfies its Designated Requirement` |
| 包外独立 Mach-O 的签名显示 | `codesign --display --verbose=4 <standalone-file>` | 0；`flags=0x20002(adhoc,linker-signed)`、`Signature=adhoc`、`TeamIdentifier=not set`、`Info.plist=not bound`、`Sealed Resources=none` |

该对照将失败范围定位到 bundle 上下文的资源签名校验：同一份 Mach-O 字节离开 `.app` 后可通过严格验证，不能将此前包内路径的失败解释为独立 Mach-O 签名字节损坏。它仍不是 Developer ID 签名、公证或实际启动通过的证据；构建流程为何未形成可通过验证的 bundle 资源封装，留给 Lead 结合构建配置调查，不从本次静态结果猜测。此前“未包外提取”的限制现由本补充证据更新，原始验证记录保留。

本次修改前已将报告备份到本轮证据目录：[修改前报告](../../../../backups/mac-readiness-be2af51077c843d3864e30b7c24f7ba4/macos-arm64-before-standalone.md)。[独立二进制对照结果](../../../../backups/mac-readiness-be2af51077c843d3864e30b7c24f7ba4/standalone-signature-comparison.json)记录源/目标 hash 与命令返回值。任务完成状态未更改。
