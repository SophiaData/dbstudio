# MySQL 对标 dbx / DBeaver 与真实验收实施计划

> **For agentic workers:** 按当前可用团队工具逐项执行、保留红绿证据、独立只读 review。技能目录未提供的执行技能不是暂停前置；已获得用户“设定目标、必须对标、真实验收”的执行授权，无需反复询问是否开始。

**Goal:** MySQL 日常使用、管理和异常恢复达到冻结参考任务的体验标准，以真实 Tauri 界面 → Rust → 专用 MySQL → 独立回读证明，缺失/受阻项不得隐藏。

**Architecture:** 保持 Tauri + Vue + Rust，按用户任务逐个补齐。真实验收模式只隔离应用配置、WebView 数据、合成凭据与服务，不替换业务 backend；DOM 操作、OS 键盘、系统文件对话框、驱动回归分别标证据等级。先建立最短真实链，再依据失败用例改直接责任模块，不进行无关重构。

**Tech Stack:** Tauri 2.12.5、Vue 3/TypeScript、Rust 原生 MySQL driver、专用 MySQL 8.0/8.4、OS keyring、现有 Vite / playwright-core，合成数据与独立观察连接。

---

## 1. 目标、基线与放行

- 用户于 2026-11-07 明确要求完整 MySQL 体验对标与真实验收；新持久目标已建立。此前“11月13日”只针对较窄核心范围估算，本次完整对标没有证据支持同日完成保证。
- 工作区起点 HEAD 为 `7fadb00d6f9ee2cbf87949e9f908517c508a2956`，保留前轮六项源码修复、28项新增业务回归及已修改包脚本；不重置、不覆盖、不把旧发布包当含新修复。
- 详细任务与门槛见[验收约定](../../support/mysql-parity/acceptance-contract.md)，M01—M23 均须保持可见。参考产品、版本/权限区别、各平台/各 MySQL 版本分开记录。
- 已有 68 核心 + 2 真实 NoSQL、162 SQLite 核心性能样本、46 模型/业务回归只作为历史基础，不算新 MySQL GUI 通过数。
- 真实实例只服务本轮合成数据，普通测试账号限制专用库，observer独立连接回读。不得访问生产库或真实用户配置/凭据。
- 不执行文件/数据删除清理，不覆盖旧 tag/附件；对标中的删除能力保持明确受限，准备精确测试方案后再处理授权边界，不能默默移出矩阵后宣称全部通过。

## 2. 责任边界与文件地图

| 文件 / 范围 | 责任 |
| --- | --- |
| `docs/support/mysql-parity/reference-baseline.md` | dbx指定仓库及DBeaver Community冻结版本、官方出处、逐任务期望与版本权限区别 |
| `docs/support/mysql-parity/mysql-driver-gaps.md` | MySQL协议、类型、认证、事务、分页、元数据与管理差距 |
| `docs/support/mysql-parity/desktop-workflow-gaps.md` | 桌面任务、快捷键、补全、grid、对象管理和传输体验差距 |
| `docs/support/mysql-parity/real-acceptance-foundation.md` | 隔离、真实DOM/原生链、观察连接和证据方案 |
| `docs/support/mysql-parity/acceptance-contract.md` | Lead维护唯一验收状态定义与M01—M23范围 |
| `apps/desktop/src/components/SqlEditor.vue` | 首切片仅修改执行快捷键与补全优先级，不夹带补全体系重写 |
| 新 `apps/desktop/tests/sql-editor-dom/` | 真实SFC模板浏览器DOM夹具、独立服务、合成execute记录及证据；不是Tauri/MySQL通过 |
| 新 `src-tauri/src/mysql_acceptance.rs`、`lib.rs` test-only分支 | fail-closed隔离宿主、独立WebView store、合成keyring namespace和观察报告 |
| 新 `scripts/mysql-ui-acceptance-fixture.mjs` | MySQL-only服务、素材、私有manifest、独立observer；无SSH镜像构建依赖 |
| 新 `scripts/mysql-ui-acceptance.mjs`、新 `apps/desktop/src/mysql-parity-dom.ts` | 本轮测试宿主与真实DOM动作、readiness/事件证据、initial/restart/soak生命周期 |
| 后续 `crates/dbstudio-drivers/src/mysql.rs`及直接协议/测试 | 按真实复现逐项补管理结果、分页、事务同步、类型和安全传输 |
| 后续 `DdlDialog.vue`、`SchemaPanel.vue`、`ResultGrid.vue`、工作台直接模型 | 依据验收任务补对象编辑与grid流程，不先拆全项目结构 |

同一源文件只能由一个实现成员写；Lead分配任务前明确写域。跨模块合同先同步，其他成员只读。重要文件先备份到本轮新 `backups/` 子目录，证据排他创建，不覆盖旧run。

## 3. Phase A：参考与差距冻结（已开始）

- [x] 建立长期目标、任务板和独立报告目录。
- [x] 写M01—M23验收约定，区分文档、代码、内存回归、真实driver、真实DOM和平台系统交互。
- [x] task43：冻结t8y2/dbx与DBeaver Community版本/提交及官方URL，交42项参考任务；属于资料基线，不是实操通过。
- [x] task44：交MySQL driver差距报告，优先数据正确性与事务、管理返回结果、分页、TLS+SSH，给直接责任文件/函数。
- [x] task45：交桌面差距报告，含21条状态及13组真实GUI动作；没有运行MySQL界面。
- [x] task46：交隔离与真实验收路径，确认锁定Tauri的WK数据store API，效果仍待实现实测。
- [ ] 非实现者只读交叉核对四报告与验收约定，Lead建立逐项任务，不用百科式审查拖延第一条真实链。

交付：参考资料不等于实际体验对照；未亲自操作参考产品时保持“参考操作待测”。没有参考实测数据前不宣称性能相当。

## 4. Phase B1：先修高频执行快捷键（task47）

**Files:**
- Modify: `apps/desktop/src/components/SqlEditor.vue` 的 `keydown`。
- Create: `apps/desktop/tests/sql-editor-dom/fixture.html`、`fixture.ts`、`Fixture.vue`、`server.mjs`（入口命名可按同目录最小实现确定，在报告记录最终命令）。
- Evidence: 新 `backups/mysql-editor-dom-<run>/`。

- [ ] 读取真实SFC和当前测试依赖，备份SqlEditor。只使用合成Workbench refs：`sql/currentConnection/dialects/roots/tabs`，不调用真实存储或backend。fixture渲染实际SqlEditor模板；父组件接收正常`execute`事件并显示次数/SQL，不能以直接`keydown()`或`execute()`调用代替DOM。
- [ ] 建立loopback动态端口Vite测试服务，`configFile:false`、`envFile:false`，新证据目录；工具进程为可跟踪后台job。不得替换DSH GUI或普通桌面应用服务器。
- [ ] 用Playwright真实fill/press/click取得红证据：输入`SELECT 41 AS from_keyboard;`，光标放SELECT末、Ctrl+Space打开补全，再Ctrl+Enter；当前错误是接受补全且execute事件为0。Meta+Enter、Shift+Enter与Ctrl/Meta+Shift+Enter对应分支同样记录。
- [ ] 在原 `keydown` 函数最前面放以下两个分支，并移除原位置相同执行分支，其余路由保持：

```ts
if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
  event.preventDefault()
  completionOpen.value = false
  execute(event.shiftKey)
  return
}
if (!event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && event.key === 'Enter') {
  event.preventDefault()
  completionOpen.value = false
  execute(true)
  return
}
```

- [ ] 同一真实DOM流程绿色验证：Ctrl/Meta+Enter只发当前/选中SQL一次，Ctrl/Meta+Shift+Enter和Shift+Enter只发全部一次；输入文本不因执行被补全替换，listbox关闭。
- [ ] 对照：普通Enter/Tab接受补全而不execute；Escape只关闭；执行当前/全部按钮各只发一次；disabled时不execute。保留截图与结构化实际结果，明确这是浏览器DOM，不是Tauri/live MySQL。
- [ ] Vue类型检查与独立只读review后收口；停止本轮server，不删除profile/素材/证据。不为这项小修重跑Rust全套。

## 5. Phase B2：建立最短真实MySQL链

本阶段每个源模块由Lead另开写域任务并在具体代码读完后定义完整实现/负例，禁止按文件地图直接批量重构。具体接口合同已列于foundation报告。

- [ ] 隔离负例先行：root不存在且parent为受控temp、runId严格格式、phase闭集、非symlink；initial排他新建、restart仅同run合法manifest。缺mode、错run、坏路径必须在读取任何生产目录前失败，不能回落生产appdata/keyring。
- [ ] 实现test-only `mysql_acceptance.rs`、`lib.rs`接线和专用测试配置。关闭默认自动window；先通过root/run gate，再创建带本run `data_store_identifier([u8;16])` 的WKWebView；initial新UUID，restart同UUID。macOS>=14 API条件满足不等于效果已证实，必须用本run非敏感marker跨进程验证。不得先开默认store再补配置。
- [ ] 独立真实keyring service固定为校验runId派生测试namespace。生成/输入合成secret不输出；restart进程明确无密码环境变量且不重新填密码，实际get命中和查询成功才通过。内存store不得计重启通过。
- [ ] 实现MySQL-only fixture：不导入会执行main的旧mixed脚本；采用官方MySQL镜像，新run专用标签和loopback动态端口，记录image digest；不build SSH镜像。创建app账号与只读observer，密码只经私有配置/受控stdin，不出现在命令参数或报告。使用CREATE/INSERT准备新对象，不DROP/DELETE/TRUNCATE。
- [ ] MySQL初始回读使用以下语句冻结事实；只公开版本和可发布配置，不公开secret或其他用户schema：

```sql
SELECT VERSION(), @@SESSION.sql_mode, @@character_set_connection,
       @@collation_connection, @@SESSION.time_zone;
SELECT COUNT(*) FROM acceptance_rows;
SELECT id, CAST(big_value AS CHAR), HEX(binary_value)
FROM acceptance_rows WHERE id IN (1, 2, 805) ORDER BY id;
```

- [ ] 建专用测试构建入口，生产build wrapper继续关闭测试hooks。Docker SSH镜像build曾被拒绝，仅约束该具体操作；不扩大成Cargo/Tauri或新MySQL容器的全局禁止。上述不同命令在当前用户目标授权范围内执行，若各自被拒绝则记录并停止该动作，不改系统策略、不换builder规避拒绝。
- [ ] test-only DOM模块通过可见控件 `.click()`/输入/键盘事件走正常Vue模板处理，动作与native方法计数对应。合成DOM键盘不能声称OS可信按键；能取得native自动化就另行记录，不能用controller调业务充当点击。不修改后端结果或注入假MySQL数据。
- [ ] 首次真实链只验 MYSQL-ISO-01 / CON-01 / SQL-01 / PAGE-01：实际新窗口连接表单、执行按钮、805行前后页；每个结果与独立observer一致。任一缺证保持失败/受阻，不启动旧生产App替代。
- [ ] 核对源码HEAD+dirty diff hash、Cargo.lock/frontend/binary哈希、feature、窗口存储ID、目标版本和容器ownership；交非实现者D2后才标“真实MySQL链已通过”。

## 6. Phase C：高频读写和恢复补齐

顺序为M06/M07/M10/M11/M12/M13，随后M02/M03/M08，逐任务串行管理MySQL driver写域。

- [ ] 管理结果：真实`SHOW TABLES`、`SHOW CREATE TABLE`、`EXPLAIN SELECT ...`、返回数据的`CALL`和多结果集建独立用例；不能为预览再次执行有副作用语句，不把第一结果之后静默丢掉。
- [ ] 分页：明确原SQL重复列名、已有LIMIT/OFFSET、CTE、参数、排序和多结果语义。保留正确性后实现有界获取，证明不是每页重放并排空全量数据；driver/界面总数政策与LIMIT一致。20首屏/20翻页与UI可见耗时分别测，百万行SQLite旧样本不能代替。
- [ ] 类型：每种类型原生读→DOM编辑→应用→同会话读→observer提交前旧值→commit后精确值；BIGINT 9007199254740993、UNSIGNED最大范围、DECIMAL小数、NULL/空串、时区/小数秒、中文emoji、多行、JSON与BLOB至少各独立行，不通过CAST结果自证编辑路径。
- [ ] 异常：实际唯一约束错误、InnoDB死锁、锁等待超时、服务器断开/重启与取消，记录server状态/前端提示/草稿/事务；不假设所有错误都自动回滚，不以合成事务结束契约替代MySQL实际行为。
- [ ] 稳妥编辑：新建/复合主键/自增/生成列/default，可靠可编辑查询结果与只读限制；guard取消保稿、迟到全文不覆盖、分页失败重试位置准确；所有已修六项在真实MySQL场景复验。
- [ ] 连接：TLS错误CA/错误hostname必须失败，SSH固定指纹、SSH+verify-full必须验证原主机且取消连接同样安全；未实现不能以直连verify-full替代。

每项真实失败先保存定点证据，再改责任文件、必要回归和独立review。测试服务停止/重启只针对本轮immutable ID+label已确认的容器，保留数据与容器；不操作其他服务。

## 7. Phase D：完整管理与效率体验

- [ ] M03/M14/M15：补图形ALTER列、默认值/注释、主键、索引/FK、视图定义、触发器/例程/数据库常用管理；列明前缀/顺序/可见性等精确属性，DDL预览与执行结果逐项核对，注意MySQL DDL隐式提交，不把它计入可回滚事务。
- [ ] M05/M08/M21：补全限定当前连接/schema并识别别名；页大小、跳页、总数、清排序和多列排序；有界筛选与明确服务端范围；键盘焦点、状态和错误恢复按相同参考任务测操作数。
- [ ] M16/M17：CSV/Excel映射与类型/NULL政策，错误与取消事务范围，完整四格式导出、参数、范围、覆盖保护、系统选择器；对dbx非原子批次政策如实比较，不为“相同”降低数据安全。
- [ ] M18/M19：MySQL结构/数据比较、目标绑定与SQL审阅、ER/FK导航、SQL文件/历史/收藏/跨库传输/dump；Community付费版本区别明确，dbx单方高级项保持矩阵状态。
- [ ] 同设备同服务实际操作参考工具；仅在已隔离的参考配置下启动，不能读用户已有reference profile。无参考实测时保持“参考操作待测”，不声称体验等同。

## 8. Phase E：稳定性与生产候选

- [ ] 参考同任务性能基线取得后冻结阈值，保留全部样本，不删除异常值；冷启动/预热、DB/IPC/DOM、主进程/全应用资源分别记录。
- [ ] 连续30轮真实查询/分页/完整值/导出/关闭，独立parser/observer验证；资源采样只读本run归属PID，受拒绝不换系统入口规避。
- [ ] 真实8小时活跃连接与每小时checkpoint，记录monotonic实际elapsed；中断自然经过不算。完成后再实际查询、编辑回滚、导出、正常退出。长任务用受管理后台执行，及时用户更新，不阻塞8小时shell等待、不创建用户未要求的定时任务。
- [ ] MySQL8.0/8.4与Mac/Win各自给结果；5.7等未实测明确列出。无Windows实际结果不得宣称Windows达标。
- [ ] 测试hook关闭的候选构建同源回归、来源/哈希、独立review完成；新版本发布与现v0.8.1分开，不覆盖旧tag或附件。
- [ ] M01—M23逐行给证据/剩余差距，必选体验和数据正确性/恢复门槛未通过则目标保持active，不按日期或完成测试数量自动放行。

## 9. 当前可运行检查

已有脚本仅在相关改动后运行，不重跑无变化全套：

```text
node apps/desktop/tests/sql-workflow-regressions.mjs
  预期：11通过，exit 0；纯内存工作台，不是真MySQL。
node apps/desktop/tests/grid-workflow-regressions.mjs
  预期：17通过，exit 0；真实Vue生命周期/内存IPC，无可见DOM。
node tests/e2e-verify-manifest.mjs
  预期：清单无未登记入口，exit 0。
pnpm run typecheck:desktop
  预期：exit 0；仅类型，不替代运行。
```

新DOM服务与MySQL runner在实现后由任务报告给出实际命令和输出，未存在的入口不提前记通过。默认项目Node可用，先前指定另一Node加载Rollup本机模块失败不是产品通过/失败证据，不修改签名或安全设置绕过。
