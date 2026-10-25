# M0 收尾与验收执行计划

> 执行者按任务复现、修复、验证并交付证据；当前会话只负责规划与审核，不承担实现。每批完成后提交审核，未通过前不进入下一批。执行者可以使用其环境中已有的计划执行技能，不依赖未安装的技能。

**Goal：**消除 M0 的数据正确性、事务生命周期、验证执行器和发布门禁缺口，为进入 M1 提供可追溯的验收结论。

**Architecture：**保留 renderer → preload → main → driver-host 的边界。围绕现有网格、连接级事务控制器和验证清单做局部修复；数据库驱动不进入 renderer/main。发布改为验证、构建及产物检查完成后统一放行。

**Tech Stack：**Electron、TypeScript、原生 DOM、SQLite/PostgreSQL、Node.js、pnpm、Playwright、GitHub Actions。

**评估日期：**2026-10-24。**评估基线：**`0e7e840`，编写时工作区无业务代码改动；本计划和交接提示词是新文档。后续执行须记录实际起点，不能把旧日志作为新提交的验收证据。

---

## 1. 范围与角色

- 执行者：复现、实现、编写回归测试、运行验证、更新证据和规划状态。
- 审核者：检查 diff、测试是否覆盖问题、证据与提交是否一致，给出通过、需修改或证据不足的结论；不代写修复。
- 用户：决定是否接受剩余风险、进入下一阶段，以及是否进行远端发布等操作。
- 本计划不包含 M1 新功能、框架迁移、全局重构、版本升级或正式发布。
- 执行者默认只在本地工作。推送、创建或合并 PR、触发远端流程、打 tag、上传 Release/npm 包均不在本次授权范围。
- 不能以“本地没有三平台 runner”为理由不修改发布工作流；可以完成代码和静态检查，并把远端验证明确标为待验证。

## 2. 当前证据与待验证风险

| 编号 | 观察 | 证据强度 | 本计划任务 |
|---|---|---|---|
| F1 | 网格保留以行号索引的脏编辑，刷新后从新行读取主键，可能更新错误记录 | 源码路径已确认；行为待复现 | A1 |
| F2 | 退出询问等待 60 秒后自动返回允许；窗口关闭许可为全局变量 | 源码已确认；真实窗口生命周期待补测 | A2 |
| F3 | 断开、删除及编辑连接入口未统一经过事务保护 | 源码已确认；逐入口行为待测 | A3 |
| F4 | `node scripts/verify.mjs node --only test:postgres` 零步骤成功退出 | 本地已复现；CI 使用该调用路径 | A4 |
| F5 | 各平台各自发布，没有统一产物门禁；版本脚本使用 Bash 语法且未声明 shell | 工作流静态检查；原生 runner 行为待验证 | A5 |
| F6 | 路线图部分完成标记、用例数量与实际证据不一致 | 文档与日志核对 | A6 |

已有日志 `/tmp/dbstudio-verify-r5.log` 显示 30 个步骤通过、4 个跳过、0 个失败，仅作历史参考。本次状态检查复跑了类型检查和验证清单测试，后者 47/47 通过；并未重新执行全套测试。真实 PostgreSQL、SSL、SSH 和远端发布结果不能据此判定通过。

## 3. 执行顺序与文件归属

默认串行：**A1 → A2 → A3 → A4 → A5 → A6**。先处理数据风险，再修复验收和发布机制。A4 技术上独立，但当前工作区共用构建输出，不安排并发构建或 GUI 测试。

下表新增文件是计划路径，执行前尚不存在；若仓库已有等价文件，优先扩展并在交付中解释路径变化。

| 任务 | 主要修改文件 | 回归测试 / 新增文件 | 粗略工作量 |
|---|---|---|---|
| A1 行身份与脏编辑 | `/Users/gaotingkai/Projects/dbstudio/src/renderer/grid.ts`；必要时 `/Users/gaotingkai/Projects/dbstudio/src/renderer/transaction-controller.ts` | 扩展 `/Users/gaotingkai/Projects/dbstudio/tests/gui-mutation-transaction.mjs` | 1–2 天 |
| A2 关闭/退出保护 | `/Users/gaotingkai/Projects/dbstudio/src/main/index.ts`；必要时 renderer 事务控制器 | 新增 `/Users/gaotingkai/Projects/dbstudio/tests/gui-app-close-guard.mjs` | 1–2 天 |
| A3 连接操作保护 | `/Users/gaotingkai/Projects/dbstudio/src/renderer/main.ts`、`tree.ts`、`transaction-controller.ts` | 扩展 `/Users/gaotingkai/Projects/dbstudio/tests/gui-transaction-lifecycle.mjs` | 1–2 天 |
| A4 验证执行器 | `/Users/gaotingkai/Projects/dbstudio/scripts/verify.mjs`、`verify-manifest.mjs`；`/Users/gaotingkai/Projects/dbstudio/.github/workflows/verify.yml` | 新增 `/Users/gaotingkai/Projects/dbstudio/tests/e2e-verify-runner.mjs` | 0.5–1 天 |
| A5 发布与包验收 | `/Users/gaotingkai/Projects/dbstudio/.github/workflows/release.yml`；必要时打包配置 | 新增 `/Users/gaotingkai/Projects/dbstudio/scripts/check-release-version.mjs`、`tests/e2e-release-gate.mjs`、`scripts/smoke-packaged-app.mjs` | 1–2 天，另加远端验证等待 |
| A6 集成与文档 | `/Users/gaotingkai/Projects/dbstudio/docs/superpowers/plans/2026-10-23-project-roadmap.md`；必要时 README | 新增 `/Users/gaotingkai/Projects/dbstudio/docs/superpowers/plans/2026-10-24-m0-acceptance-report.md` | 0.5–1 天 |

估算为单人工作量，约 5–10 个工作日，不作为承诺。每个新增测试脚本必须同步登记到 `/Users/gaotingkai/Projects/dbstudio/package.json` 和验证清单；A4 最后核对其分组和 CI 调用。

## 4. 每批通用交付流程

- [ ] 读取适用的 AGENTS.md，记录 `git status --short --branch`、`git rev-parse HEAD` 和实际运行时版本。
- [ ] 读取目标实现和现有测试，先写能检验用户行为或真实进程结果的反例。
- [ ] 在修复前运行反例，记录失败断言与退出码；启动失败、旧构建和测试基础设施错误不算复现成功。
- [ ] 做最小修复，不改变无关行为；构建后重跑反例和受影响的现有测试。
- [ ] 保存命令、结果、退出码、日志路径和环境信息；敏感连接字符串及凭据必须脱敏。
- [ ] 检查 diff，更新本批状态，交审核者；完成批次后停在审核节点，不自动开始后续阶段。

依赖缺失才运行安装；依赖已有且未变更时，不为形式重复安装。测试使用临时数据库和独立 user-data-dir，不修改用户的真实连接或数据库。

## 5. A1：固定编辑目标，避免跨标签刷新改错行

**设计约束：**编辑目标必须在进入脏编辑缓冲时确定，不能在提交时通过刷新后的行号重新推导。优先保存原始主键快照，并把可见行定位与编辑身份分开。若本批采用“有脏编辑时延迟刷新”的保守策略，必须覆盖所有会重置结果集的入口，并清晰提示刷新待处理；不能只修复一条广播路径。

- [ ] 在同一 SQLite 连接打开两个标签，建立 `items(id INTEGER PRIMARY KEY, name TEXT)`，数据为 `(1,'one'), (2,'two'), (3,'three')`，通过明确排序保证行顺序。
- [ ] B 编辑 id=2 为 `two-edited`，暂不应用；A 删除 id=1 并触发广播。等待实际刷新完成后，B 应用并提交。
- [ ] 断言 id=2 为 `two-edited`、id=3 仍为 `three`，从独立数据库连接检查最终值；记录修复前是否真的出现错行。未复现时不得伪造失败，须解释实际路径与源码风险。
- [ ] 实现稳定身份或完整的延迟刷新保护；覆盖缓存翻页、排序、筛选、主动刷新和广播刷新，不以按钮文案代替数据断言。
- [ ] 增加目标行被另一标签删除的场景：必须报告冲突或明确拒绝，不能转移编辑或报告成功。
- [ ] 增加复合主键、主键编辑（若支持）、分页缓存淘汰和不同连接隔离的定向场景。主键编辑必须用原主键定位。
- [ ] 验证提交和回滚均保持正确数据，异步广播不能让较旧结果覆盖较新状态。

定向命令，从仓库根目录运行：

```sh
pnpm run typecheck
pnpm run build
pnpm run test:gui-mutation-transaction
pnpm run test:gui-transaction-lifecycle
pnpm run test:gui-tab-context
```

**通过标准：**不存在把 id=2 的编辑应用到 id=3 的路径；目标丢失可见且不误报；测试断言数据库内容。交付时说明采用的策略及其限制。

## 6. A2：真实窗口关闭和应用退出保护

**行为契约：**等待用户决定不等于允许退出。正常窗口尚有未处理改动时，超时不能自动销毁窗口或提交/回滚。渲染进程无响应时应保留取消能力；如提供强制退出，必须由用户显式选择并说明未保存改动可能丢失。确认权限只适用于本次窗口/退出请求。

- [ ] 新增真实 Electron 生命周期测试，经主进程触发窗口 `close()` 和 `app.quit()`，不只调用 `window.dbstudioGuardTransactions`。
- [ ] 测试未应用编辑与已应用未提交事务；确认窗口存活、连接状态和磁盘内容。
- [ ] 用可注入计时器或仅测试模式启用的短超时覆盖等待场景；生产超时行为不因测试而放宽。断言超时后窗口仍在、数据仍可处理。
- [ ] 测试连续两次退出请求，不得绕过正在进行的确认，也不得弹出相互竞争的对话框。
- [ ] 修正窗口许可生命周期；macOS 测试关闭后重新创建窗口，再编辑和关闭时仍必须确认。
- [ ] 验证取消、明确提交、明确放弃三条路径；若现有 UI 先“应用”再“提交”，测试应走完整操作。
- [ ] 对渲染进程崩溃/销毁单独定义并验证行为，不能把“等待用户”归入崩溃分支；清理定时器和事件监听器。
- [ ] 将新测试注册为 `test:gui-app-close-guard`。

```sh
pnpm run typecheck
pnpm run build
pnpm run test:gui-app-close-guard
pnpm run test:gui-transaction-lifecycle
```

**通过标准：**没有任何“用户未作决定却被当成确认”的正常退出路径。无法在当前平台执行的 macOS 专属场景须标注待验证，不能用其他平台结果代替。

## 7. A3：统一断开、删除和编辑连接的事务保护

**行为契约：**会关闭或替换宿主连接的操作，在执行前处理该连接全部标签的未应用编辑与未提交事务。取消必须阻止原操作；处理失败必须阻止破坏性后续操作。删除连接的普通确认不能代替事务处理。

- [ ] 用 `rg` 枚举 renderer 中 `disconnectConnection`、`removeConnection`、`updateConnection` 及重连调用点，交付入口清单。
- [ ] 对工具栏、树菜单、连接编辑表单逐入口写回归；同连接两个标签分别制造未应用编辑、已应用未提交修改。
- [ ] 复用事务控制器建立连接级保护入口，避免复制多套询问逻辑。
- [ ] 明确提交：先处理本地编辑，再完成提交，最后断开/删除/更新连接。
- [ ] 明确放弃：清理本地编辑，回滚连接事务，成功后再执行原操作。
- [ ] 取消或处理失败：连接、配置、标签和改动均保留；异步期间防止重复操作和新的编辑绕过检查。
- [ ] 验证其他连接完全不受影响，宿主意外退出仍能走现有故障恢复路径。

```sh
pnpm run typecheck
pnpm run build
pnpm run test:gui-transaction-lifecycle
pnpm run test:connection-lifecycle
pnpm run test:gui-round3
```

**通过标准：**入口清单中的每条破坏性操作都经过同一连接级策略；测试同时验证 UI、实际数据库内容与连接配置是否改变。

## 8. A4：验证执行器不能零执行成功

**固定 CLI 契约：**

| 输入 | 预期行为 |
|---|---|
| 无参数 | 按清单顺序执行全部分组 |
| `node` | 只选 node 分组 |
| `--only test:verify-manifest` | 不把选项值当分组，只选择该步骤 |
| `external --only test:postgres` | 只选择 PG 主测试 |
| `node --only test:postgres` | 分组冲突，非零退出并解释原因 |
| `--only`、未知步骤、未知分组、未知选项、重复 `--only` | 非零退出，明确参数错误 |
| 任意空选择 | 非零退出 |
| 外部环境缺失，普通模式 | 明确记录跳过及缺失项，汇总选中/执行/跳过数量 |
| 外部环境缺失，`--require-external` | 非零退出 |
| 子进程失败或无法启动 | 非零退出，保留真实失败原因 |

`--only` 不自动重建所有前置产物；执行单步骤前的构建/fixture 责任必须在帮助和 CI 中明确，避免误认为测试了新代码。

- [ ] 以真实子进程测试 CLI 参数、输出和退出码。可用临时替身执行器隔离昂贵测试，但至少保留一个真实测试脚本执行断言。
- [ ] 将解析、选择校验与执行职责分开到最小必要程度，不引入通用任务框架。
- [ ] 修复 CI：PG 使用 `node scripts/verify.mjs external --only test:postgres --require-external`，并保留实际构建、fixture 和服务环境。
- [ ] 核对其余 external 步骤缺服务时必须失败；本地缺 PG 时 SQLite 的取消语义仍应有可运行测试，拆分脚本或补独立测试均可。
- [ ] 新增 `test:verify-runner`，登记清单，防止测试执行自身递归。
- [ ] 核实已有脚本别名不被重复计算为独立覆盖；一致性测试和实际执行测试职责分开。

```sh
pnpm run test:verify-runner
pnpm run test:verify-manifest
node scripts/verify.mjs --only test:verify-manifest
node scripts/verify.mjs node --only test:postgres
```

最后一条是负例，预期非零；不要把它与正例合并后只报告整体成功。PG 服务就绪时，另运行修正后的 CI 命令，确认实际断言执行且非零测试数量。

**通过标准：**错误选择不能成功退出，真实 CI 主 PG 用例确实运行，缺服务不能冒充通过。

## 9. A5：发布门禁与打包产物验收

**工作流目标：**`verify → 三平台 build + packaged smoke → 汇总校验 → publish`。构建任务只上传本次 workflow 的中间产物，不对外发布。手动分支构建仅生成验证产物，不创建正式 Release。

- [ ] 将版本校验放到 setup-node 之后的 Node 脚本，复用已有版本匹配规则，避免依赖未声明的 shell。
- [ ] tag 触发时严格匹配 package.json；不匹配即失败。手动分支构建读取声明版本但不将分支名当 tag，也不得自动发布。
- [ ] 每平台构建后校验产物存在、非空、版本正确，生成含 commit SHA、平台、架构、版本和文件摘要的产物清单。
- [ ] 增加打包应用冒烟脚本，启动打包后的可执行文件，验证 renderer/preload 可用、SQLite 宿主启动及一次查询；设置超时并收集日志。不能只启动开发目录 `out/`。
- [ ] 区分证据等级：解包可执行文件启动不等于安装器安装成功。macOS DMG/ZIP、Windows EXE、Linux AppImage 的安装或挂载/提取验证方式分别记录；无法执行的项目保留未验证状态。
- [ ] 汇总任务只接收本次 workflow、同一 commit/version 的预期平台和架构产物，缺任一必需产物、冒烟失败或构建被跳过均阻止发布。
- [ ] 正式发布集中在单个任务；先建立或更新 draft，核对全部必需附件后才转公开。失败时不能留下部分产物的公开新版本；不要删除已有公开版本。
- [ ] 验证错误 tag、缺平台、缺产物、冒烟失败、手动分支构建五类负例。可用临时文件夹和合成清单测试门禁；这些不替代真实 runner 验证。
- [ ] 最小化发布权限，只给发布任务写权限；不引入凭据、不打印 token，不绕过签名检查来声称正式分发可用。
- [ ] 注册 `test:release-gate`。远端运行未获授权时，仅提交工作流与本地门禁测试证据，将远端三平台结果标为待验证。

```sh
pnpm run test:release-gate
pnpm run test:verify-manifest
```

**通过标准：**门禁代码及负例测试通过，并有同一提交的三平台实际构建/冒烟证据后才能判定 A5 整体验收通过；仅静态检查通过应标为“实现完成，远端验证待补”。

## 10. A6：集成验证与状态纠偏

- [ ] 汇总 A1–A5 的审核结论，任何未通过项继续保留，不用总体百分比掩盖。
- [ ] 对最终源码运行类型检查、构建及完整本地验证。A4 未通过前，不采用执行器的成功汇总作为完整证据。
- [ ] 保存真实退出码，不能用管道末尾的 `tail` 状态替代测试进程状态。可用下面的子 shell 记录日志：

```sh
(
  pnpm run verify:headless > /tmp/dbstudio-m0-final-verify.log 2>&1
  result_code=$?
  cat /tmp/dbstudio-m0-final-verify.log
  exit "$result_code"
)
```

- [ ] 外部服务可用时运行 `pnpm run verify:external --require-external`；缺环境则列出未验证项，不能写“全量通过”。
- [ ] 检查故障注入、取消、回滚、跨连接隔离、真实窗口关闭和发布负例均有证据。
- [ ] 更新路线图中的阶段状态、实际用例数、能力描述及遗留事项，明确“已实现 / 本地验证通过 / 远端待验证 / 审核通过”。
- [ ] 编写验收报告，记录最终 commit、工作区状态、平台、运行时版本、命令、退出码、日志和剩余风险；如果测试后又修改源码或测试，重跑受影响验证。
- [ ] 给出 M1 准入结论；若发布验证未完成，只能说开发阶段是否具备继续条件，不能宣布 Beta 发布就绪。

## 11. 审核标准与报告格式

每批交付必须包含：

```text
任务编号：
实际起点 commit：
提交 commit 或未提交 diff 的范围：
问题复现：命令、失败断言、退出码、日志路径
根因与修改：用户行为变化、涉及文件、关键设计选择
修复后验证：逐条命令、退出码、通过/失败/跳过数量
负例与边界：本任务要求的场景及结果
环境与限制：本地/远端、服务依赖、未运行项
剩余风险：
请求审核的结论：
```

审核者输出“通过 / 需修改 / 证据不足”，并为未通过项给出严重级别、文件位置、触发场景、影响和可检查的修正条件。测试绿色不自动推导代码正确；缺陷复现失败也不自动推导风险不存在。

**M0 验收通过条件：**A1–A4 的数据与生命周期问题关闭，A5 的实际发布门禁证据齐全，A6 报告和路线图一致。任一要求未满足，保持 M0 收尾中；只有用户明确接受并记录某项延期，才允许调整准入范围。
