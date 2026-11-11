# 参考工具 macOS arm64 隔离运行准备

日期：2026-11-07，task-53。范围为官方 HTTP 元数据、文档和冻结 commit 的直接存储/启动源码。**没有下载二进制、安装、执行、启动参考应用或读取本机 App/profile/keyring；没有设置 HOME、扫描用户目录或改变系统信任设置。** 本报告是后续下载/隔离 probe 的计划，不是参考 UI、隔离或 MySQL 实测通过。

## 最短结论

| 参考 | 已确定的独立数据路径 | 尚未证明的边界 | 本轮结论 |
| --- | --- | --- | --- |
| t8y2/dbx v0.6.67 | `DBX_DATA_DIR` 明确替代业务数据根；该模式不隐式导入默认目录。`DBX_SECRET_KEY_FILE` 优先于平台 keyring，可指向本轮新合成加密 key 文件 | macOS 默认 Tauri 窗口没有本轮唯一 WKWebsiteDataStore 配置证据；仅改变业务根或复制 `.app` 不能隔离 WebView。macOS env override 也不自动采用 portable 的 managed-key policy | **不能仅加 DBX_DATA_DIR 后直接启动**。业务目录/加密 key 候选明确；发布原版 WebView 隔离仍待专门 probe/方案 |
| DBeaver Community 26.2.4 | `-data` 是 workspace；冻结源码另支持 `DBEAVER_DATA` 指向数据根的**父目录**，再追加 `DBeaverData`；`DBEAVER_WORKSPACE` 可显式设 workspace | `-data` 不独立隔离 global secure/settings/drivers；Equinox configuration/user area 与 macOS integrated-security 主 key 的命名/访问仍未由本轮源码证明独立。SWT Browser/WebKit 状态亦未验证 | 有可审核的 workspace + 产品数据根组合，**不能将其宣称为完整凭据/运行时隔离**；configuration/keyring 尚待 probe |

无需新 OS 账户作为业务工作的前置条件。找不到明确隔离开关就保留该参考的“待验证”，不启动原版去读取默认 profile 来反证，也不影响 dbstudio 自己的真实 MySQL 主链。修改上游宿主或重新签名将形成衍生构建，必须另标，不能静默当官方 release。

## 冻结下载目标与完整性

| 产品 | 精确发布资产 | 元数据 SHA-256 / 大小 |
| --- | --- | --- |
| DBX v0.6.67，tag commit `776b43ff1330fe1645223001e38a22f2166bf320` | [DBX_0.6.67_arm64.dmg](https://github.com/t8y2/dbx/releases/download/v0.6.67/DBX_0.6.67_arm64.dmg)，[asset 715503322](https://api.github.com/repos/t8y2/dbx/releases/assets/715503322) | `8cb722db0ed3d1d4b5cc327bc0f02d40ba39bdc63bcf48da281236de998a3293`；45,948,049 bytes |
| DBeaver CE 26.2.4，tag commit `9dcee590939f5c1155652fa729061035d2c347c8` | [dbeaver-ce-26.2.4-macos-aarch64.dmg](https://github.com/dbeaver/dbeaver/releases/download/26.2.4/dbeaver-ce-26.2.4-macos-aarch64.dmg)，[asset 699552183](https://api.github.com/repos/dbeaver/dbeaver/releases/assets/699552183) | `a1a10b2655d149f42a96874c7e769cec170fc92632d04dc793baa39825c0e8d3`；124,646,758 bytes |

架构目前以官方资产名 `arm64/aarch64` 为证，尚未读取 Mach-O 或 JVM。SHA 来自 GitHub 官方 API 的 `digest` 字段，**不是本机下载后计算值，也不等于开发者签名/公证验签**。没有将 browser-static、Windows portable 或同 release 内 `-beta.20261105.1` 的资产混入。发布元数据可变，后续须核精确 asset ID/URL/size/digest，匹配不到就停止该下载验收，不追 latest 替换。DBX release API 标 `immutable:false`。

本轮未核得这两个精确 DMG 的独立 publisher checksum 清单或 detached signature，不能写“已验签”。DBX 配置有 updater 公钥并不证明该 DMG 已由该 key 验证。后续下载任务只落全新本轮目录；先比 SHA，再只读检查包身份、arm64、codesign 与系统正常信任结果，不移除 quarantine、不改 Gatekeeper、不重签。受阻如实记录，不反复探测系统入口。

DBX 冻结源码的 Tauri 配置 `version` 仍写 `0.6.66`，而 release/资产名是 `0.6.67`；可能由打包流程覆盖，但本轮没有二进制证据，**后续必须读包版本/About 核对并单列差异**，不能用 tag 字符串代替实际运行版本。

## DBX：直接源码证明及候选输入

- [data_dir.rs（冻结 commit）](https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/src-tauri/src/data_dir.rs)：读取非空 `DBX_DATA_DIR`，优先于 portable/default。`alternative_data_dir(EnvOverride) = None`；portable marker 检测仅 Windows。没有据此声称存在 `--appdata`/`--profile` CLI，当前确定支持的是环境变量。
- [lib.rs（冻结 commit）](https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/src-tauri/src/lib.rs)：setup 用该根打开 `dbx.db`，并调用迁移入口；仅 `portable_mode` 才设置 `SecretKeyPolicy::ManagedDataDir`。macOS `DBX_DATA_DIR` 属 EnvOverride，不是 portable。不能因为指定业务根就默认绕过原 keyring。
- [secret_codec.rs（冻结 commit）](https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/crates/dbx-core/src/persistence/secret_codec.rs)：`DBX_SECRET_KEY_FILE` 首先解析，成功即返回 `ExplicitFile`，不走 platform-default 分支；其次 `DBX_SECRET_KEY`，再 policy。平台默认常量 service/user 为 `com.dbx.app.secret-store.v1` / `local-data-encryption-key`，并有用户兼容 key 文件路径，不能让继承环境或缺参落回此分支。
- [tauri.conf.json（冻结 commit）](https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/src-tauri/tauri.conf.json)：identifier 固定 `com.dbx.app`，默认 window 未指定独立数据存储。已读取的 lib 里显式 `WebviewWindowBuilder::from_config` 为 Linux 路径，不能当 macOS 唯一 WK store 证明；也未找到可引用的 macOS `data_store_identifier` 参数入口。

后续 wrapper 的**候选输入，尚非可执行放行命令**：

```text
executable = <本轮独立解包并验证过的 DBX.app 内精确二进制路径>
env.DBX_DATA_DIR = <RUN>/dbx/data
env.DBX_SECRET_KEY_FILE = <RUN>/dbx/private/synthetic-encryption-key
unset inherited DBX_SECRET_KEY / DBX_SECRET_KEY_FILE / DBX_DATA_DIR before explicit assignment
argv = []
HOME = 不修改
```

`synthetic-encryption-key` 是本轮新随机的应用数据加密 key，格式应按冻结 codec 接口生成，内容不进入 argv/日志/公开报告；不是 MySQL 密码。目录 0700、文件 0600、排他创建、无链接，重启复用同根和同 key。此组合仅处理已证的业务数据和 key 分支；**尚缺 WK store 保证，不能按上述候选启动发布原版**。下一小任务应先给出原版可用的启动前 WK 隔离机制及其证据；没有原版开关时记录限制，若改宿主则单列衍生构建，不替代官方原版成绩。不要先启动默认窗口再检查 localStorage 是否空。

## DBeaver CE：-data 的边界与候选输入

- [官方 Command Line](https://github.com/dbeaver/dbeaver/wiki/Command-Line)：macOS 可直接运行 `.app/Contents/MacOS/dbeaver` 并传参数；`open -a` 是另一入口，但本轮计划使用精确独立 bundle 内 executable，避免按应用名选中既有安装。文档是滚动资料，不替代 release 验证。
- [官方 Workspace Location](https://github.com/dbeaver/dbeaver/wiki/Workspace-Location)：默认 macOS 根为 `~/Library/DBeaverData`，workspace6、drivers、install-data、secure、settings 分列；`-data` 只指定 workspace。
- [BaseApplicationImpl（冻结 commit）](https://github.com/dbeaver/dbeaver/blob/9dcee590939f5c1155652fa729061035d2c347c8/plugins/org.jkiss.dbeaver.model/src/org/jkiss/dbeaver/model/impl/app/BaseApplicationImpl.java)：global path 来自 `RuntimeUtils.getWorkingDirectory("DBeaverData")`，workspace 再独立解析。
- [RuntimeUtils（冻结 commit）](https://github.com/dbeaver/dbeaver/blob/9dcee590939f5c1155652fa729061035d2c347c8/plugins/org.jkiss.dbeaver.model/src/org/jkiss/dbeaver/utils/RuntimeUtils.java)：`DBEAVER_DATA` 非空时执行 `Path.of(customDataPath).resolve(subPath)`。因此指定 `<RUN>/dbeaver/product-parent` 时实际 global 为 `<RUN>/dbeaver/product-parent/DBeaverData`，不能少算这一层。`DBEAVER_WORKSPACE` 非空则直接作为 workspace 路径。
- [DBeaverApplication（冻结 commit）](https://github.com/dbeaver/dbeaver/blob/9dcee590939f5c1155652fa729061035d2c347c8/plugins/org.jkiss.dbeaver.ui.app.standalone/src/org/jkiss/dbeaver/ui/app/standalone/DBeaverApplication.java)：`.workspaces` 位于 global path；若 instance location 未设则可能调用旧 workspace 迁移探测，遍历 `${user.home}/.dbeaver4` / `.dbeaver`。必须显式 `-data`，不能只设环境变量后走默认迁移分支；出现选旧 workspace/导入既有设置/复用其他实例提示就停止该 probe。
- [官方 Integrated Security](https://github.com/dbeaver/dbeaver/wiki/Integrated-Security) 与 [Security](https://github.com/dbeaver/dbeaver/wiki/Security)：secure 文件为 `DBeaverData/secure/secure_storage`，解锁主 key 受 OS keyring 保护，CE 仅 Integrated Security。**改变产品数据根不等于独立 OS keyring namespace**；本轮没有冻结凭据 provider 源码证明其 key 名包含本轮 root。不能靠“不保存密码”推断启动时完全不访问平台 keyring。

后续 wrapper 候选（**configuration 与 keyring gate 通过前不启动**）：

```text
executable = <本轮独立解包并验证过的 DBeaver.app>/Contents/MacOS/dbeaver
env.DBEAVER_DATA = <RUN>/dbeaver/product-parent
env.DBEAVER_WORKSPACE = <RUN>/dbeaver/workspace
argv = ["-data", "<RUN>/dbeaver/workspace"]
HOME = 不修改
```

本轮尚未核得 Equinox `-configuration` / `-user` / secure-storage 重定向在该 release 实际打包 launcher 中的完整组合与默认 fallback；它们是下一 probe 的目标，不能先给未证参数当确定命令。下一小任务只需核 release launcher 的 configuration/user area 与 secure provider 初始化：配置根应归本轮 bundle/run，所有 secure 文件应归本轮产品根，OS 主 key 必须有本轮唯一身份或明确不访问默认项的机制；若无法证明，则保持参考启动受阻，不改 HOME、不读取旧 secure 文件、不删除 keyring、不尝试生产账户。

DBeaver 是 SWT/RCP，不套用 Tauri 的 `data_store_identifier` 方案；若帮助/欢迎页/SWT Browser 使用 WebKit，也不能把新 workspace 自动当作网站存储独立的证明。首个对比应只用数据库工作台，后续若包含浏览器页面须另核 storage。

## 后续任务的最短验收顺序（本轮均未执行）

1. **取包与静态核验**：新 run 下下载精确 URL，排他保留原 DMG，核 size/SHA/架构/签名/About 来源；挂载或解包方案及目的路径由后续具体任务写明并做代码 D2。只操作本轮拥有对象，不覆盖已有 App，不执行文件/数据库删除或旧配置导入。
2. **启动前隔离 gate**：wrapper 校验 run 路径、权限、链接、所有必需变量与存储根；缺任一项拒绝启动。dbx 解决 WK store；DBeaver 解决 configuration 与 OS 主 key。不得先启动再观察默认用户数据。引用原版与衍生构建必须分列。
3. **无凭据 profile probe**：在已证明隔离的进程中，只检查本 run 内合成 marker/配置；另 run 独立、同 run 重启可复用。只报告布尔/路径归属/版本，不输出文件正文或 secrets。无额外系统权限时保持对应项待验证，不要求 OS 账户。
4. **连接同一专用 MySQL**：Lead 指定本轮 loopback 服务及镜像 digest/实际版本，普通专用 **SELECT/SHOW VIEW 最小只读账号**，不使用 root 或现有 app 写权限账号。密码经受控输入通道进入真实密码控件，不放 CLI/JDBC URL/截图/日志。TLS 策略一致记录；不以 REQUIRE 加密冒充 verify-full。连接读错目标则停止。
5. **第一组同任务比较**：连接→显示 VERSION/DATABASE→有序查询805行→分页/补全执行键→完整数值/文本查看。按同一数据、设备、网络、参数记录参考工具和 dbstudio 的真实步骤、等待、错误与结果；observer 独立核目标/计数。reference42 IDs、contract23 IDs、UI13组分别保持其作用域，不仅凭新 wrapper 通过记体验相同。
6. 本 slice 只读，不执行 INSERT/UPDATE/DELETE/DROP/导入覆盖，不以该只读成绩替代后续写入/事务验收。退出本轮归属进程与容器保留策略另由 runner 管理，保留文件、profile、素材与证据，不运行清理命令。

交接状态：官方 macOS arm64 目标与 API digest 已确定；dbx 业务根/显式 key 与 DBeaver 产品根/workspace 的精确语义已确定。**两参考完整运行时隔离、下载验签、实际启动及真实 MySQL 比较仍为未执行/待 probe。**
