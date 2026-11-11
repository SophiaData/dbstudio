# v0.8.1 本轮问题与环境缺口

日期：2026-11-07。基线：`7fadb00d6f9ee2cbf87949e9f908517c508a2956`。状态：首轮核心、性能及静态取证已收口；后续六项数据库业务问题已在源码修复，见[业务修复报告](business-workflows.md)。下列安装和长期观察条件为后置平台验收范围，不作为继续业务代码工作的前置；未实际运行的场景不能据此宣称无缺陷。

## ACC-MAC-SIG-001：应用包严格签名校验失败

- 类型：发布包静态校验异常；运行影响与优先级尚待干净环境启动验证，暂不定为 P1，也不声称应用无法运行。
- 用例：I01，macOS 27.2 arm64，v0.8.1 正式 DMG。
- 已执行：DMG SHA-256 与发布记录一致；hdiutil verify、只读挂载、新目录复制、文件哈希一致；架构为 arm64，直接动态依赖均为系统路径。
- 预期：记录准确签名状态，并能解释严格校验结果；Developer ID、公证本来就未完成验收。
- 实际：源包与副本的 `codesign --verify --deep --strict` 均退出 1，固定错误为 `code has no resources but signature indicates they must be present`；观察到 ad-hoc、linker-signed、无 TeamIdentifier、无 sealed resources。包内二进制路径的严格校验也失败。
- 定点对照：相同 SHA-256 的独立包外二进制执行严格签名验证返回 0，仍为 `adhoc,linker-signed`。同字节在包内及整个应用包验证返回 1，将失败范围定位到 bundle 上下文的资源签名校验，不能归为独立 Mach-O 签名字节损坏。没有修改、签名或覆盖正式附件。
- 数据前后：只读来源，复制校验一致；未启动生产应用，未读用户配置或凭据。
- 下一步：静态对照已完成；在独立干净 Mac GUI 账户核对实际系统提示与启动，再决定是否需要候选包修复及新版本。
- 证据：[macOS 报告](macos-arm64.md)。

## ENV-MAC-001：缺少可直接使用的干净 Mac GUI 会话

- 类型：平台验收前置缺口，不是已复现的运行时缺陷。
- 影响：I01 首次启动、I03—I09、F01—F13、应用级性能及 8 小时持续使用受阻。
- 原因：生产 setup 固定使用 OS 应用数据目录、旧配置导入目录和系统 keyring；本轮尚无独立 OS 测试账户。测试 hook 可隔离的源码构建不能冒充已发布包安装验收。
- 处理：未启动生产包，未修改 HOME、真实配置、系统信任或既有凭据。需要独立干净账户或 VM 的交互式会话后继续。
- 证据：[Mac 隔离判断](macos-arm64.md#生产运行隔离判断)。

## ENV-WIN-001：未提供 Windows 11 x64 测试会话

- 类型：环境缺口。
- 影响：I02—I09、F01—F13 共 21 项实机用例受阻；Windows 安装通过数为 0。
- 已执行：EXE 哈希与大小核对、PE 头与证书表静态检查。NSIS 外层引导程序为 x86 不代表内部应用不是 x64。
- 原因：宿主为 Mac arm64；`prlctl` 命令存在，但未指定可用且获准使用的 Windows 系统或远程会话。未枚举、启动个人 VM 或扫描网络。
- 下一步：提供 Windows 11 x64 干净账户与桌面会话，使用同一 EXE 和合成数据逐项验证；不能用本轮 Mac/core 结果代替。
- 证据：[Windows 报告](windows-x64.md)。

## TEST-POLICY-001：部分既有生命周期回归与本轮不删除约束冲突

- 类型：测试执行限制，不是测试断言失败。
- 影响：普通 PostgreSQL/MySQL 的两项完整 network_live 用例不能原样重跑；其他含删除/删表清理的测试也不能直接执行。
- 已确认：`network_live` 用例实际调用 deleteRows 并提交，结束阶段还执行 dropView/dropTable。即使操作对象为合成数据，本轮也不自行豁免。
- 处理：保留既有测试不修改；只运行审查后没有删除操作的用例。新增性能 harness 只创建独立数据并保留。
- 证据：核心成员 task-37 的定点源码审查；最终执行清单见[核心回归报告](core-scenarios.md)。

## FIXTURE-SSH-001：专用 SQL TLS/SSH 镜像构建失败

- 类型：服务准备失败；四条 SQL TLS/SSH 测试未启动，不能记作驱动测试失败或通过。
- 本轮现象：编排返回固定错误 `SSH_IMAGE_BUILD_FAILED`，退出码 1；当时未取得构建失败根因。
- 定点诊断：使用新建、与源码相同且无秘密的公共 Dockerfile 单步复现构建，再次退出 1。脱敏特征确认 `BUILD_OPERATION_NOT_PERMITTED`，错误涉及 buildx/builder，未进入镜像拉取或 APK 安装。没有 DNS、TLS、镜像仓库或磁盘故障的证据；未修改 Docker/VM/builder 设置或绕过拒绝。
- 当前结果：四项 SQL 安全测试本轮未执行。现有入口仅支持无参数或 `--prepare-only`，live 路径无条件先构建 SSH 镜像；没有可直接独立运行两项直连 TLS 的参数。未修改夹具、重试或绕过被拒绝的构建操作。Redis TLS、Kafka TLS/SASL 两项已独立通过，此项准备失败不撤销这两项结果，也不把历史四项 SQL 安全测试成功算成本轮已执行。详见[核心回归报告](core-scenarios.md#sql-tlsssh-fixture-构建阻碍)。

## PERF-RSS-001：无法采集测试进程自身 RSS

- 类型：测量环境限制，不是产品内存泄漏证据。
- 本轮现象：只针对隔离 harness 自身 PID 启动 `/bin/ps`，得到 `PermissionDenied`；未改用其他系统入口规避。
- 影响：公开性能 CSV 的 RSS 均为空。5 轮各 10 个结果打开/关闭只证明操作成功，不能认定内存稳定、回收达标、无泄漏或满足计划的 100 MiB/20% 门槛；未取得 Rust 与 WebView 进程组合计。
- 下一步：在允许采集自身测试应用资源的干净平台会话中执行应用进程组采样，保留同一统计口径。
- 证据：[性能口径](performance-notes.md)、[持续使用状态](soak.md)。
