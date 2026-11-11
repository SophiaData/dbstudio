# MySQL 真实桌面验收基础设计

日期：2026-11-07。状态：仅源码核对与设计完成；本报告不表示真实 Tauri GUI、live MySQL、重启凭据或 8 小时观察通过。使用 writing-plans 方法整理阶段与门槛；本任务只写本文，不改代码、不启动应用/服务、不执行构建/旧测试套、不更改系统策略。

**Goal:** 让 MySQL 体验对标工作有可复现的真实 Tauri 界面 → 正常 Vue 事件 → Rust Application → 原生 MySQL → 独立数据库回读证据链。

**Architecture:** 在 test-hooks 构建里增加显式独立的 MySQL 验收模式，与现有 SQLite controller smoke 分开。UI 用可见控件与键盘操作；测试 hooks 只提供隔离、进程阶段、白名单计数和脱敏报告，不调用业务 controller 代替 UI。连接秘密只经本轮指定环境变量进入内存/密码控件与唯一测试 OS keyring namespace，绝不进入公开报告。

**Tech Stack:** 现有 Tauri 2、Vue 3、Rust core/native MySQL、OS keyring；专用 MySQL 8.0 合成服务。无需新 OS 账户。macOS 的实际 WKWebView 操作/录像通道必须先验证可用；浏览器中的 Vite 页面不等于 Tauri 窗口。

## 0. 可以先实施的最短真实 UI 链

不等待8小时、性能、截图权限或完整自动化体系。第一交付只做：本轮隔离宿主 → 一台专用MySQL → 显示真实Tauri工作台 → 实际表单点击保存连接 → SQL textarea输入与执行按钮 → DOM结果 → 独立observer SELECT核对。首个SQL为固定 `SELECT 1 AS mysql_ui_probe, DATABASE() AS selected_database, VERSION() AS server_version`；随后用预备的805行表验证有序分页。它不依赖截图或RSS可用，缺少这些只把附件/资源项记受阻，不停止数据库和DOM主链。

最小文件切片：新增 test-only `src-tauri/src/mysql_acceptance.rs`，`src-tauri/src/lib.rs` 分支接入隔离路径、OS namespace与窗口；新增 `apps/desktop/src/mysql-parity-dom.ts`，由 App 仅在 `VITE_MYSQL_PARITY=1` 且原生验收模式确认后安装，绝不安装旧SQLite smoke；新增 MySQL-only fixture与runner两脚本。不改core/drivers。前端模块只定位可见DOM、填真实输入/触发浏览器事件、观察DOM和结果，不持有/调用workbench，不调用组件exposed方法或backend业务API；业务只能由正常UI handler发invoke。纯JS `.click()/dispatchEvent()`必须报告为“真实WebView内的合成DOM动作”，键盘事件不具有浏览器默认输入行为，不能冒充OS键盘：实际输入框应使用原生value setter加input/change使Vue正常接收，快捷键另外由真人/已验证native automation输入。若当前无native输入权限，按钮链可先独立通过，OS快捷键项记受阻，不能虚构 `isTrusted=true`。报告观察不修改业务状态或替换请求。

服务最低条件：一台MySQL 8.0官方镜像/已有明确指定的本轮服务、loopback端口、全新run schema、app合成用户与独立只读observer、健康SELECT及一份非敏感manifest。不需要PG、SSH镜像或个人VM；不运行旧mixedfixture的SSH build/全套测试。已知 BUILD_OPERATION_NOT_PERMITTED 仅针对此前具体 Docker SSH buildx build 操作，不重试或换builder绕过该操作。MySQL-only使用官方镜像无需Docker build，专用Cargo/Tauri测试编译是不同操作，可按本goal已有授权实施，无需重复询问；只有具体新命令自身被拒绝才停止该命令，不改系统策略。

### macOS WebView 网站数据隔离的已核实 API

项目 [Cargo.lock](../../../Cargo.lock#L4514-L4518) 锁定 Tauri **2.12.5**。对应官方 [WebviewWindowBuilder::data_store_identifier](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindowBuilder.html#method.data_store_identifier) 签名为 `data_store_identifier([u8;16])`；官方说明可替代 WKWebView 不具备的 `data_directory`，仅 macOS ≥14 / iOS ≥17 有效，Windows/Linux/Android不支持。本机按lead环境为macOS27.2，满足API系统版本条件，但实际构建/调用效果尚未验证。不能只调用 `data_directory(root)`、改bundle identifier或新建Rust appdata就断言WK隔离。

建议在测试配置禁用自动创建默认窗口（仅测试artifact，生产配置不改），验收root/run/phase成功后、任何页面加载及Vue boot/localStorage访问之前，programmatic创建唯一WebView：`WebviewWindowBuilder::new(app, "mysql-acceptance", WebviewUrl::App("index.html".into())).data_store_identifier(run_store_uuid_bytes).build()?`。16字节store UUID初次随机生成写本run非敏感manifest；restart复用同UUID，不每次新建；另run必须新UUID。禁止先打开默认生产store窗口再关闭补救；若API不可用或不能确认传入配置则不启动。`incognito(true)`不是重启草稿持久化等价替代，不与persistent-store验收混用。Windows/Linux若后续验收才使用各平台有效的 `data_directory`，不能将mac结论泛化。

初次在独立store的最早initialization脚本只核对本run marker不存在、写入本run合成marker；不枚举/输出localStorage。restart同store读回相同marker，另run独立store marker应不存在；宿主记录正确store UUID被配置的布尔值。此检查仅观察本轮新store，不能以“打开生产store再看是否空”验证隔离。创建窗口前配置保证与marker跨进程验证联合才记ISO通过。testartifact可用独立固定测试bundleID补充区分产品身份，但bundleID本身不是WK独立store证明。所有存储、keyring操作保留，本轮不调用网站数据清理或vault删除。

第一链通过后再扩展凭据restart、Grid、系统文件选择、录屏、30轮/8h；这些未做项不影响已经真正完成的查询链子项，但整体GUI/live验收必须逐项实证，设计文档不能计通过。

## 1. 关键路径与当前阻塞

1. 先实现隔离宿主模式：全新 run root、独立 appdata 与 WebView profile、`legacy=None`、唯一 keyring service。模式校验失败必须在 `Application::open` 前退出，不能落回生产 appdata/keyring。
2. 单独准备 MySQL-only fixture，不串行依赖 PG/SSH 镜像，不运行旧 mixed SQL 套。连接 app 用户和只读 observer 分离，loopback 动态端口，记录实际镜像 digest 与 `SELECT VERSION()`，不假设 `mysql:8.0` 标签不可变。
3. 已知拒绝仅为此前具体 Docker SSH buildx build；不重试、不换builder绕该操作。MySQL-only官方镜像无需该build，专用Cargo/Tauri测试构建可依新goal授权实施；生产wrapper禁hook参数是正常产物安全gate，不是批准系统拒绝。此task当前仅报告不执行，后续实现无需重复请求已有授权。
4. 取得新构建测试产物哈希与来源，确认实际 Tauri WebView 可操作，再做连接→查询→分页→编辑/事务→DB 回读的最短垂直链。
5. 在同 run 新进程重启验证 OS keyring 自动取回，后续才扩展体验矩阵、截图视频与实际 8 小时观察。

没有可用的 WKWebView 自动化通道时，由操作者在新测试窗口内完成真实点击/键盘并录屏；自动化项记受阻。不能改用普通 Chrome 页、controller `defineExpose`、`window.__DBSTUDIO_NATIVE_SMOKE__()` 或 Rust test 替代全 UI 通过。无需枚举个人 VM 或要求先切换 OS 账户。

本任务未采集工具版本、Docker 服务状态或安装产物，因此不声明当前 Docker/MySQL/GUI driver 可用。后续只允许查固定工具版本或明确指定的本轮容器，不执行 VM/容器全量枚举、用户目录搜索或环境转储。

## 2. 已核对的现有实现

| 源码事实 | 对验收的影响 |
| --- | --- |
| [native-desktop-smoke.mjs](../../../scripts/native-desktop-smoke.mjs#L10-L19) 固定启动 `target/debug/dbstudio-desktop`，创建新的 OS temp 子目录并注入 `DBSTUDIO_NATIVE_SMOKE_ROOT`；stdout/stderr 只计字节 | 确实启动 Tauri，但不能切换任意 MySQL 目标；90 秒超时也不适合 8 小时观察。不能运行它作为新 MySQL 验收。 |
| [smoke.rs](../../../src-tauri/src/smoke.rs#L35-L71) 要求 root 为 OS temp 的全新直属子目录，创建 SQLite 和 CSV，context 只返回这些路径 | 仅换环境变量或表单字段不足以把 SQLite64 变成 MySQL。重启也不能重用当前 `create_dir` 新建流程。 |
| [Rust setup](../../../src-tauri/src/lib.rs#L170-L189) smoke root 下 `data` + `FixtureSecrets`；test-hooks 强制 `legacy=None`，但没有 smoke 时仍落生产 appdata/OS store | 新 MySQL 模式必须始终有有效 root 并失败封闭；不能只编译 test-hooks 然后无参数启动。 |
| [native-smoke.ts](../../../apps/desktop/src/native-smoke.ts#L18-L45) 直接 `wb.saveConnection/executeScript`，后续有 `backend.removeConnection` 等旧套操作；[App](../../../apps/desktop/src/App.vue#L123-L138) 提供组件 controller | 现有检查证明业务 controller → invoke 链，不能证明按钮、输入、快捷键交互。整套还含删除，不得本轮运行或照搬。 |
| [smoke.rs 报告](../../../src-tauri/src/smoke.rs#L79-L101) 接受最多 64 个布尔项，host 覆盖原生方法成功标志 | 可复用白名单与 host 观察思想，不把前端 true 当 DB 正确性；新套应独立 schema，不挤入当前 64 限额/SQLite required 列表。 |
| [OsSecretStore](../../../src-tauri/src/secrets.rs#L11-L37) service 固定 `io.dbstudio.desktop`；remove 会删 keyring 条目；其测试仅同进程不同实例 | 内存 store 和同进程 roundtrip 均不能证明重启持久化。新 test-only store 使用独立唯一 namespace；不执行 remove/轮换/清理。 |
| [build wrapper](../../../scripts/build-native-desktop.mjs#L13-L46) 只允许生产参数，强制 `VITE_DBSTUDIO_TEST_HOOKS=0`，拒绝 feature/config 覆盖，检查无 smoke 标志 | 必须保留生产 gate。不得向该 wrapper 塞 test-hooks 或先起旧生产包；专用测试构建入口属于新goal必要实现，可按已有授权独立编译，并保留生产gate，不涉及绕过此前SSH镜像build拒绝。 |
| [SQL secure fixture](../../../scripts/native-sql-secure-fixture.mjs#L247-L265) 一次准备 PG/MySQL TLS/MySQL SSH/SSH；[305 行](../../../scripts/native-sql-secure-fixture.mjs#L303-L309) 先 build SSH image，失败会阻断 MySQL | 不直接运行 mixed fixture；新 MySQL-only fixture复用排他创建、权限和 ownership 思路，不导入会执行 main 的入口。 |
| [fixture health/配置](../../../scripts/native-sql-secure-fixture.mjs#L102-L108) 使用私有 client config，密码不在 CLI；[结束处理](../../../scripts/native-sql-secure-fixture.mjs#L363-L407) 仅停止/保留本轮资源 | 只读 inspector 不输出 `.Config.Env`、私钥、原始日志。新套不执行任何删除/cleanup，不自动 docker rm/prune/down-v。 |

## 3. 隔离与凭据合同

### 新模式的最小环境变量名（拟新增，尚未实现）

| 名称 | 用途 / 流向 |
| --- | --- |
| `DBSTUDIO_MYSQL_ACCEPTANCE_ROOT` | 本轮新 temp 直属目录，初次必须不存在；0700、canonical parent、禁止符号链接。公开报告使用 run ID 不输出用户绝对路径。 |
| `DBSTUDIO_MYSQL_ACCEPTANCE_RUN_ID` | 随机 ID；同时绑定 manifest、容器标签、appdata、报告和 keyring namespace。禁止接受任意 service 字符串。 |
| `DBSTUDIO_MYSQL_ACCEPTANCE_PHASE` | closed values `initial` / `restart` / `soak`；restart/soak 仅允许同 run 已验证 manifest 和 owned 子目录，不任意复用既有目录。 |
| `DBSTUDIO_MYSQL_HOST` / `PORT` / `DATABASE` / `USER` | 仅专用 fixture endpoint/schema/user；host 为指定 loopback 服务，端口由 owned 容器固定字段返回。 |
| `DBSTUDIO_MYSQL_PASSWORD` | 只在初次 UI 密码填写/SecretMap `dbPassword` 使用。禁止输出、命令行参数、截图/录像/trace 输入日志；重启进程明确不传此变量。 |
| `DBSTUDIO_MYSQL_CA_FILE` | 如用 TLS，引用新生成公共 CA 文件；不读/显示证书私钥、不加系统信任根。 |
| `DBSTUDIO_MYSQL_OBSERVER_PASSWORD` | 独立只读 observer；仅 fixture 内部私有 client 配置/标准输入消费，永不交给 Vue。 |

新 keyring service 由 Rust 固定拼接 `io.dbstudio.acceptance.mysql.<validated-run-id>`，account 仍为 core 生成的随机 key。首次校验只查本 run 即将使用的精确条目不存在，不枚举 vault。正常 SecretStore get/set 使用真实 OS keyring；测试 store 的 remove 直接返回 unsupported，保持创建保留规则，不伪装删除成功。若 OS vault 被拒绝、系统确认无法完成或 secretStored=false，凭据项受阻，不落回文件、内存或生产 service，也不修改系统策略。

同 run 两次独立进程验证：初次通过可见表单保存并连接，正常 UI 退出；restart 阶段不注入 DB 密码、不自动填密码、不重新生成连接，仅从同 run appdata 加载非敏感连接配置，点击“连接”取得真实查询结果，host 记录同 namespace 的 get 命中布尔值。报告只含 `os_keyring_namespace_isolated/password_env_absent_on_restart/credential_reused/query_verified`，不含 key、value 或 serialized secrets。未建立该链不能称重启凭据通过。

appdata 分离尚不足以证明 WebView localStorage/cache 分离：实现者必须用当前锁定 Tauri API 为新窗口设置本 run 的独立 data directory/profile，并核验 SQL 草稿/展示偏好不复用生产 storage。若平台不支持或缺少可核验接口则记受阻，不读取用户 profile 来比较。当前 setup 仅分离 Rust data，本文不宣称它已实现 WebView 隔离。

## 4. 最小扩展文件与责任

以下均为下一阶段提案，本任务未修改。不得把设计命令当作已存在/已通过能力。

| 文件 | 最小责任 |
| --- | --- |
| 新 `scripts/mysql-ui-acceptance-fixture.mjs` | MySQL-only、新 run root、私有 secrets、固定 ownership 预检、只创建保留合成表/素材；独立只读 observer 验证。支持 `--prepare-only`，不触发 Docker/Cargo/GUI；后续live prepare按本goal已有授权实施。使用官方MySQL镜像，若该具体pull/run操作被拒绝则停止，不自动换源/镜像。 |
| 新 `scripts/mysql-ui-acceptance.mjs` | 按 manifest/hash 启动**新建专用**二进制，白名单环境、等待真实 readiness、分 initial/restart/soak、收集脱敏报告；不自动重试或强杀作为正常成功，不导出原日志；超时是失败/受阻。不要复用旧90秒runner。 |
| 新 `src-tauri/src/mysql_acceptance.rs` + `lib.rs` test-only接线 | 严格 root/run/phase/独立 WebView profile；配置 context 不返回 secrets；本轮OS store；正常 invoke 观察只存method计数/result code/耗时；独立report schema、正常退出和重启。现SQLite smoke行为不改。 |
| `src-tauri/src/secrets.rs`（如需复用极小 helper） | 生产 service 保持固定不变；namespace只能在 test-only宿主提供。优先新模块专用store，避免扩大生产可配置面。 |
| 新 `apps/desktop/tests/mysql-native-dom.mjs` | 只通过确认可连接真实 Tauri窗口的自动化适配器定位可见DOM/键盘；不能构造controller、mock invoke/数据源或调用 exposed methods。若WKWebView控制不可用，输出受阻并交人工可见操作，不改普通浏览器运行。 |
| `App.vue` test-only分支 / 新 test-only UI fixture context模块 | 避免在MySQL模式安装/调用旧SQLitecontroller smoke。仅挂载就绪、脱敏证据/实际DOM操作适配，不能暴露wb/后端业务函数。密码经私有一次性输入通道进实际password控件，不放window context/console/报告。 |
| `ResultGrid.vue` / `ConnectionDialog.vue` / `SqlEditor.vue` | 现有语义选择器足够则不改；若唯一定位不足，只增加稳定data-testid/accessible label，不重设计、不改业务逻辑。 |
| 新专用测试构建入口、`package.json` 和test feature gate | 复用固定依赖、独立target和新frontendDist；校验test产物绝不发布、生产无hook回归。专用Cargo/Tauri编译可按本goal已有授权实现执行，若该具体操作被拒绝才停止；不重试旧SSH镜像build、不改系统策略。本task仅报告未执行。 |

不用为此改 core/drivers；只有真实UI→真实服务复现明确缺陷后，按责任模块另开最小修复和独立review。MySQL DDL隐式提交是数据库合同，建素材与事务编辑用不同表/阶段，不能把DDL混入回滚断言。

## 5. 真实 DOM 最短执行链

实际字段以 Rust `listDialects()` 为准：[drivers registry](../../../crates/dbstudio-drivers/src/lib.rs#L25-L53)。MySQL键为 `host/port/database/user`，密码表单 `password` → SecretMap `dbPassword`；TLS `sslmode`（disable/require/verify-ca/verify-full）、`sslrootcert`。不根据PostgreSQL或Redis别名猜参数；本地plain与TLS分开标记，不允许服务要求TLS时自动降级。

| ID | 必须通过的可见界面动作 | 原生/DB 独立判据 |
| --- | --- | --- |
| MYSQL-ISO-01 | 新测试窗口工作台无历史连接/草稿；新建按钮可操作 | root、appdata、WebView profile、namespace均本run；legacy disabled；production路径从未打开的host bool。 |
| MYSQL-CON-01 | 点击 `#btn-new-connection`，填 `#f-name`，`#f-dialect=mysql`，逐个 `[data-key=host/port/database/user/password]`；点击 `#btn-test` 看成功；点击 `#btn-submit` | host观察testConnection/addConnection真实invoke成功；observer验证目标schema、版本/会话证据，不用UI success文字独立证明连对库。密码不在录制输入阶段留下trace。 |
| MYSQL-TREE-01 | `#tree-rows` 内点击本run连接展开按钮，逐层展开database/schema/table；双击已显示表，滚动/折叠再展开 | 实际listChildren按需发生，未全库预读；DOM表名和预备合成表匹配，查询数据正确。使用匹配run的data-node-id，不把未知节点名拼SQL。 |
| MYSQL-SQL-01 | 聚焦 `#sql-input` 输入固定无secret SQL，点击 `#btn-run-sql`，等待结果；再独立用Cmd/Ctrl+Enter执行当前语句，Shift+Enter执行全部 | 原生executeStatement/runQuery白名单计数与对应DB marker/correct rows吻合。实际快捷键输入必须记录；`dispatchEvent`路径单独标synthetic DOM，不当作OS可信键盘证据。 |
| MYSQL-PAGE-01 | 可见“下一页/上一页”按钮翻805行数据（200行/页：200/200/200/200/5），检查边界ID | DOM首尾ID、offset、计数与observer固定ORDER BY主键结果一致，无重复漏行。通过SQL query预设顺序，不假定无ORDER BY表预览顺序。 |
| MYSQL-EDIT-01 | 双击单元格，实际textarea输入；点“保存到本地修改”，见dirty；点“应用修改” | 应用前observer旧值；应用后同UI事务会话新值、observer仍旧值；点“提交”后observer新值。若只controller.stageCell则本项未执行。 |
| MYSQL-ROLLBACK-01 | 新值→应用→点“回滚”，刷新可见表 | observer及UI回到前一已提交值，事务指示一致；不靠truncate/delete复位，下一用例换行ID。 |
| MYSQL-INSERT-01 | 点“新增行”，输入中文、NULL、未勾选default列；有本地dirty时提交→点击guard取消 | form保持values/include/nulls、未发insert；正常提交路径observer提交后正确，应用失败/验证错误表单保留。仅新增专用ID，不执行delete用例。 |
| MYSQL-FULLCELL-01 | 双击长文本触发真实fullcell，在pending时操作另一单元格并输入草稿；或进入“新增行” | 可见新draft不被迟到success/error覆盖；observer不变直至用户明确应用。网络延迟仅本run可控fixture，不偷偷替换backend.fetchCellValue为mock。无法稳定制造竞争时保留手工步骤和证据，不伪造覆盖。 |
| MYSQL-IMPORT/EXPORT-01 | 点击真实导入/导出按钮，使用系统文件选择器选本轮素材/新目标，实际预览/开始/取消 | observer核对导入每行/精度/事务；CSV parser核对完整导出，不止计数。不能用hook回传预设路径替代系统选择器通过；无对话框自动化则人工录像。 |
| MYSQL-KEYRING-01 | 正常退出→同run restart新进程，不填密码，点击连接并query | 独立namespace真实get命中+无密码注入+DB正确；MemoryStore不适用。 |

[ConnectionDialog模板](../../../apps/desktop/src/components/ConnectionDialog.vue#L56-L74)、[App按钮/结果容器](../../../apps/desktop/src/App.vue#L145-L173)、[SqlEditor键盘](../../../apps/desktop/src/components/SqlEditor.vue#L97-L121) 已有相应入口。实际DOM自动化应等待可见且enabled，记录点击/键盘事件与结果，不能对disabled控件强行触发handler或用组件controller制造绿色。真实UI操作不能只靠host `native_*` 方法成功位；按钮路径、原生链与DB回读必须同时存在。

## 6. 合成 MySQL 与 DB 回读

专用新 schema 名由校验后的 runId派生，app用户仅获该schema所需权限；observer仅SELECT该schema，另有经过授权的最小transport观察权限。表包括：805行分页、100000/1000000行性能、主键/复合键、NULL/default/generated、BIGINT=9007199254740993、精确DECIMAL、中文/多行/长文本、二进制、小CSV独立空导入表。用预备阶段CREATE/INSERT创建，不DROP/DELETE/TRUNCATE，不复用已填充导入表。所有对象保留；未授权的删除场景记未执行。

observer独立连接，固定schema和表名由manifest白名单确认。readback SQL限定SELECT计数、固定主键行、HEX/精确文本比较和会话transport字段，不采集general log、完整processlist或其它schema。表名只能从严格生成标识符得到，值参数绑定；原始口令不拼命令/SQL/argv。验证commit/rollback需新/自动提交observer语句避免REPEATABLE READ旧snapshot。公开回执仅caseId、counts、exact_match、code、elapsed及可发布合成hash，不输出原始行或SQL错误。

真实MySQL证明至少包括：指定容器标签/run归属、动态loopback绑定、实际镜像digest/服务版本、Rust原生MySQL driver连接成功、UI query结果与独立observer一致。容器running/health、Rust ignored test成功或SQLite64通过均不能替代GUI链。

## 7. 未来命令合同（本阶段均不执行）

以下 `mysql-*` 是拟新增入口，现阶段不存在；应在后续实现完成后运行，不运行不存在的命令。实现和专用测试编译已在本goal授权内，不需要再次询问。本task仅报告，不执行。

```text
node scripts/mysql-ui-acceptance-fixture.mjs --prepare-only
  预期：仅创建本run私有manifest/material，services_started=false、passed=false。

node scripts/mysql-ui-acceptance-fixture.mjs --start --manifest <本轮私有manifest>
  前提：该入口已实现，MySQL官方镜像可用；按新goal已有授权运行，若该具体操作被拒绝则停止。
  预期：指定MySQL-only健康、observer SELECT核对；无Cargo、无SSH build、无删除收尾。

node scripts/mysql-ui-acceptance.mjs --binary <新测试产物绝对路径> --manifest <本轮manifest> --phase initial
node scripts/mysql-ui-acceptance.mjs --binary <同一哈希产物> --manifest <同一manifest> --phase restart
node scripts/mysql-ui-acceptance.mjs --binary <同一哈希产物> --manifest <同一manifest> --phase soak
  前提：按本goal授权实现专用测试构建入口并完成编译；Tauri窗口自动化/人工操作通道已验证。
  预期：实际窗口ready，逐case运行，独立observer与脱敏证据对齐；restart明确不传密码。
```

专用测试入口拟将Vue构建为 `VITE_MYSQL_PARITY=1`、`VITE_DBSTUDIO_TEST_HOOKS=0` 的新frontendDist，并以 `cargo build --locked -p dbstudio-desktop --features test-hooks --target-dir <本轮独立target>` 编译宿主；frontendDist需由专用测试Tauri配置明确指向，禁止沿用未核对的旧dist。具体配置接线完成后才运行命令。该独立编译属于本goal授权，不是对SSH镜像build拒绝的替代重试。生产 `pnpm build` 仍仅构建无测试hook产品，其成功不能证明隔离测试包已构建。runner不得隐式改变系统权限；明确的fixture/测试构建阶段可准备所需产物，未完成则报告对应阶段未完成，不能启动旧 `.app` 顶替。

可以在后续执行前查 `node --version`、`cargo --version`、`docker version --format` 的固定字段和指定manifest容器ID的 `docker inspect --format` running/health/image字段；不输出Docker env/config、不 `docker ps -a`/VM枚举、不读取个人VM、不dump env。所有未知能力保持未验证。

## 8. 截图、录像、脱敏与8小时指标

每个run证据目录新建保留，public/private分开：公开case布尔/计数/耗时/hash；原始数据库、私有manifest、client配置留私有权限，不加入Git或报告附件。stdout/stderr沿用字节计数及允许的阶段码，不打印原错误堆栈、SQL行值、凭据、环境或host key。截图只含专用窗口与合成数据，不采桌面其它窗口/通知/用户路径。

密码输入与任何权限提示阶段停止录像、trace/DOM快照/截图，字段清空/对话框关闭后再开始并标注该段未录制；不能先捕获敏感输入再寄望后期涂抹。自动化填密码参数不进入公开step日志，trace默认禁用。视频缺段不能证明密码输入本身，但可由宿主secret流向布尔证据与后续真实连接佐证。原始输出不批量复制到public后再脱敏。

| 指标 | 采样 / 证据 | 不足时状态 |
| --- | --- | --- |
| 真实启动到工作台可操作 | 5次新进程正常退出再启动，计spawn→可见enabled控件；保留缓存，记录全部值/max | 未观察可见UI不计；不是清缓存冷启动 |
| MySQL首屏/翻页 | 同服务/数据/网络配置；warmup明确排除，20firstpage+20分页；分别记录host native elapsed与DOM可见elapsed，第19/20为p95 | 不套SQLite backend阈值，不把DOM/IPC/DB时间相加或混称 |
| 30轮 | 每轮真实UI查询→分页→完整值→小CSV导出→关闭，observer/CSV验证，截图关键checkpoint与操作录像 | controller-only、filechooser绕过、操作未完成分别记partial/未执行 |
| RSS/CPU | 主进程PID从本runner获得；仅采可验证归属同测试窗口/进程组的WebView子进程；记录pid集合变化和相同合计口径 | 不能确认WKWebView归属则只报主进程并明确total证据不足；权限拒绝停止不换系统入口 |
| 8小时 | 真实连续运行至少8小时，初始与每小时9个checkpoint（0..8h），记录UTC+时区、monotonic elapsed、DOM响应、连接状态、app-owned RSS/CPU、一次短SELECT | 计划时间/定时器注册/短循环不计实际时长；中断明确缺口，不补造样本 |
| 8h之后 | 实际UI query、编辑回滚、导出、正常退出并确认本run进程结束 | forcekill不是正常退出成功；未完成前置8h即未执行 |

RSS系统入口被拒绝不自动切换其它采集器。observe可以分轮短任务/明确用户请求的定时checkpoint实现，不用一个8h阻塞shell或忙轮询；实际观察到8h之前报告一直写未完成。服务端CPU/memory单独记录，不混入桌面app RSS。

## 9. 实施顺序与交付门槛

- [ ] M0：先为root/run/phase/namespace/profile失败封闭写纯合成负例；无mode、坏root、符号链接、错run、错phase不得打开生产路径；初次创建/同runrestart正向例。
- [ ] M1：实现MySQL-only素材准备；独立observer证明目标版本/计数/保留策略，不运行旧含删除suite。
- [ ] M2：按本goal已有授权实现专用测试构建，记录source diff、lock hash、二进制/frontend hash、features与生产无hook gate；仅当该具体新操作受拒绝才停止，不把此前SSH镜像build拒绝泛化。
- [ ] M3：真实Tauri窗口完成ISO/CON/SQL/PAGE最短链，录像/截图/host/DB三方对齐；此阶段才首次可以声称真实GUI→MySQL。
- [ ] M4：通过可见Grid编辑/commit/rollback/guardcancel/latefullcell用例；每项新增红证据后定点修复，所有修复独立D2。
- [ ] M5：两进程keyring重启、导入导出与文件选择器；持久化/原生系统交互单列通过或受阻。
- [ ] M6：实际性能样本、30轮与8小时观察。实现的范围逐项对照dbx/DBeaver基准操作，但没有同设备同服务实际结果，不宣称更快/同等或全功能对齐。

最终case通过必须同时满足：来源与隔离gate通过、真实可见操作完成、原生链确实执行、MySQL独立回读符合、所需附件可复核。未执行/受阻不能折算通过；未完成GUI/liveMySQL链不能以已有SQLite64、内存IPC17case、native driver测试或构建成功顶替。当前本文所有新case与所有拟新增入口均尚未实现/执行。
