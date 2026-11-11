<!--
公开脱敏副本，原文保留本地；原始SHA256=316de5fa97d186ed11616070e16c5966beab21f7d1dab9258d5937415b5d3dce，本文件不是原始字节证据。
原文相对路径：docs/support/mysql-parity/desktop-workflow-gaps.md
本副本仅做本机路径脱敏与链接重写；任务结论、表格、RED/GREEN 判定与限界与原文一致，未新增或洗白任何结论。
-->
# MySQL 桌面工作流差距与真实 GUI 必验项

日期：2026-11-07。task-45 仅审当前 Vue 桌面代码及其直接交互依赖；本轮没有启动 App、连接 MySQL、运行既有通过套件或修改产品代码。当前证据足以确定首批实施范围，**不能据此宣称 MySQL 体验已对齐 dbx / DBeaver，也不能把界面未验收直接记作功能缺失。**

## 状态与证据口径

- **已实现（源码）**：用户入口和调用路径在本轮读取代码中存在；不等于真实 GUI 已通过。
- **部分**：基本路径存在，但所列具体动作、边界或反馈不完整。
- **缺失（当前 UI）**：所审直接组件/操作分支中没有对应入口；不推断 Rust driver 没有该能力，也不把手写 SQL 等价为对象设计器。
- **未真验**：没有本轮真实 MySQL 服务 → 正常桌面界面 → 用户动作 → 数据库实际结果的联合证据。初始task-45审查时以下MySQL GUI均为此状态；后续真实查询/重启/编辑回滚与EXPLAIN已有独立实证，见[总记录](./real-acceptance-results.md)。D03与T01已按最新实证更新，其余行保留初始审查范围，不自动提升为通过。

Lead 提供的既有 46 项源码/controller 回归和历史 64 项 SQLite WK 结果，只能归到各自覆盖层。当前六修继续保留：连接秘密原文收集、SQL 失败后的事务刷新、取消 false 反馈、应用脏稿后的分页位置、异步编辑请求归属、新增取消保留表单；本轮不重复运行。真实浏览器 DOM 键盘验收与真实 MySQL 验收仍需单列，不能由直接调用控制器替代。

参考基线由 task-43 独立采集：dbx v0.6.67，提交 `776b43ff1330fe1645223001e38a22f2166bf320`；DBeaver CE 26.2.4，提交 `9dcee590939f5c1155652fa729061035d2c347c8`。dbx 文档快照 `01b5452f6e9c79388f3488466c5bd810366c872b` 与 release 提交分开。本文使用 task-43 已回报的工作流声明，不声称实际操作过参考产品：DBeaver 的结构/数据比较属于 EE/UE 范围，SVG ER 导出属于 PRO 范围，不能将这些列为 CE 的共同必备。它们可按 dbx/本产品目标独立要求，不能借版本混淆扩大“CE 对齐”。

UI/UX 审查已加载 `ui-ux-pro-max`，仅采用桌面任务相关的键盘可达、动作反馈、错误恢复、上下文一致、表单和表格状态规则；不引入移动端点击尺寸、配色重做或设计系统改造。

## 首批实施优先级

1. **先修确定的键盘路由问题，并完成真实 DOM 对照。** 补全可见时，执行快捷键被补全 Enter 分支截获，见 K01。真实 MySQL foundation 就绪后继续验证查询实际执行。
2. **建立两个 MySQL 连接/两个 database 的实际业务链。** 连接、目录、补全归属、有序分页、精确值、NULL/default、同连接事务及跨连接隔离要在 GUI 和数据库两侧核对。候选混用、失败恢复和未知对象只标具体边界，不用“按钮存在”代替通过。
3. **固定对象管理与数据编辑的已知不足。** 对象设计器目前是最小 DDL 表单；页大小、SQL 预览、粘贴/克隆、外键行导航尚不完整。通过下表明确首期范围，随后按用户优先级实施，不为穷举所有高级项延迟业务验收。
4. **补文件、比较、ER 的 MySQL 内容验证。** 已实现入口应保留，先跑真实导入/导出/只读比较，不重复建设已有按钮；比较与 SVG 的参考版本边界保持独立。

## 当前工作流台账

表中“待验”是用户可观察行为，不是本轮已执行结果；责任文件为实现定位，而非要求本任务修改。

| ID | 工作流 | 当前状态及直接证据 | 差距与首批待验 | 责任位置 |
| --- | --- | --- | --- | --- |
| C01 | 新建、测试、保存、编辑、连接/断开 | 已实现（源码）：动态方言字段、必填校验、测试耗时/版本、错误；编辑继承未知 options，秘密字段不 trim、留空不改 | 未真验 MySQL 实际字段、密码首尾空格、测试后输入不丢、保存后重连、两连接归属。不能由动态字段渲染推断认证/TLS/SSH 全链路通过 | [ConnectionDialog](../../../../apps/desktop/src/components/ConnectionDialog.vue#L20)、[连接字段收集](../../../../apps/desktop/src/connection-form.ts#L18)、[连接变更守卫](../../../../apps/desktop/src/workbench.ts#L419) |
| C02 | TLS/SSH 测试诊断与恢复 | 部分：表单平铺宿主返回字段，测试结果只显示成功耗时/版本或 message；组件没有阶段诊断/指纹确认动作 | 具体 MySQL TLS/SSH 字段及支持限制由 driver 审查确认；真实 GUI 验正确配置、错误 CA/名称、SSH 条件和可理解的重试提示，不关闭安全策略 | [ConnectionDialog](../../../../apps/desktop/src/components/ConnectionDialog.vue#L38) |
| N01 | 目录展开、对象定位、颜色/分组、节点刷新 | 已实现（源码）：lazy tree、虚拟窗口、箭头/Enter、节点刷新/复制、连接偏好 | 搜索明确只作用已加载对象；部分：未见服务器全对象搜索、对象 pin、procedure/function source 专用打开。菜单只有刷新/复制/连接展示偏好，不能称完整 MySQL 对象管理 | [MetadataTree](../../../../apps/desktop/src/components/MetadataTree.vue#L68)、[树菜单](../../../../apps/desktop/src/components/MetadataTree.vue#L193)、[导航入口](../../../../apps/desktop/src/App.vue#L150) |
| E01 | SQL 高亮、格式化、当前/选中/全部执行 | 源码有高亮/格式化/范围执行/逐语句参数/标签/错误行号/取消；task85显式SESSION time_zone偏移字面量经原业务拒绝红例→单driver最小fix→新run同317 +00→08→00/µs原string/P_S与UIfalse0已真过，同candidate10阶段0 | 全MySQL引号/注释/分隔符/存储程序/参数与完整语法仍待；SESSION时区仅静态offset正例，named/invalid/@@别名/参数/注释变体/activeTX/只读模式及其它SET未验，literal函数不代typed时间网格。正常执行/失败事务/取消后下一查询分别记录 | [SESSION时区红绿](./gui-session-timezone-acceptance.md)、SqlEditor（原始材料仅本地保留（见原SHA索引））、编辑器模型（原始材料仅本地保留（见原SHA索引））、SQL执行（原始材料仅本地保留（见原SHA索引）） |
| E02 | 表/列补全 | 部分：输入自动弹出候选；关键词、已加载表/结果列、简单 `表名.` 列候选 | **上下文差距**：遍历全部 roots/tabs，无当前连接/database 限定；同名表列可能混入其他连接。没有 SQL alias 解析、按需元数据读取或引用标识符插入。不是“无补全”，但不是 MySQL 语义补全已对齐 | [SqlEditor 候选](../../../../apps/desktop/src/components/SqlEditor.vue#L23) |
| K01 | 补全与执行快捷键 | 部分；确定静态路由问题：补全分支在执行分支前，Enter 未区分修饰键 | 补全可见时 Ctrl/Cmd+Enter、Ctrl/Cmd+Shift+Enter、Shift+Enter 被 acceptCompletion 抢走。真实 DOM 复现和最小修复建议见下节，尚未在真实 MySQL GUI 运行 | [SqlEditor keydown](../../../../apps/desktop/src/components/SqlEditor.vue#L97) |
| E03 | SQL 草稿、历史/收藏、多个编辑上下文 | 部分：每连接一份持久草稿，历史/收藏可保存/搜索/载入；结果标签可多开 | 当前一个编辑器，没有 SQL 文件/多脚本编辑标签入口；历史/收藏保存 SQL 文本，未提供绑定值随收藏重开。载入覆盖当前编辑器直接赋值，没有审阅现稿选择。持久化和错误处理须真实 GUI 验证 | [草稿模型](../../../../apps/desktop/src/sql-editor-model.ts#L52)、[SQL 库](../../../../apps/desktop/src/components/SqlLibraryPanel.vue#L25)、[载入 SQL](../../../../apps/desktop/src/App.vue#L68) |
| G01 | 服务端分页和总数 | 部分：固定 200 行、上一页/下一页，表来源可显式 COUNT 并标注完整对象 | 当前 UI 缺页大小选择、任意页定位；自由 SQL 无总数动作，COUNT 不代表筛选结果数。表格按页渲染，无网格虚拟滚动，不能把树虚拟化当结果虚拟化。MySQL LIMIT/尾页/无重复遗漏须真验 | [分页条](../../../../apps/desktop/src/components/ResultGrid.vue#L192)、[分页状态](../../../../apps/desktop/src/workbench.ts#L329)、[固定页大小](../../../../apps/desktop/src/workbench.ts#L57) |
| G02 | 筛选与排序 | 部分：重新查询数据库，外层 WHERE、单列 ASC/DESC；不是本地页缓存筛选 | 当前 UI 无本地搜索与 DB WHERE 的双模式，单列排序没有第三态清除或多列排序；筛选仅 AND 简化语法，不支持 OR/括号/函数、含 ` AND ` 的字符串，列名限制 ASCII 标识符；取消 dirty 守卫前已改变排序标记，显示与实际查询的一致性需 DOM/GUI 核验 | [网格排序/筛选](../../../../apps/desktop/src/components/ResultGrid.vue#L136)、[transformTab](../../../../apps/desktop/src/workbench.ts#L338)、[筛选限制](../../../../src/renderer/filter-sql.ts#L107) |
| G03 | 主键定位、本地改单元格、应用、NULL/default | 部分真实通过：单INT主键六字段BIGINT有无符号/DECIMAL65,30/UTF8/NULL↔空串，正常编辑→apply内新外旧→commit外精确新值15checks；单行唯一键1062恢复已验。源码新增默认值/异步owner与取消保留 | 自由SQL/无键/视图仍只读。复合/大整数主键、其他类型/范围负例、插入默认值/生成列/NOT NULL、多行编辑等仍待验，不能以首组六字段覆盖全部 | 精确值实证（原始材料仅本地保留（见原SHA索引））、1062实证（原始材料仅本地保留（见原SHA索引））、[编辑与插入](../../../../apps/desktop/src/components/ResultGrid.vue#L102)、[rowKeys](../../../../apps/desktop/src/workbench.ts#L286)、[executeScript新标签](../../../../apps/desktop/src/workbench.ts#L254) |
| G04 | 高级网格管理 | 缺失（当前 UI）：所审网格没有矩形粘贴/批量粘贴校验、行克隆、更新 SQL 预览、外键行导航入口 | dbx 对应工作流声明可作为差距；不要求本轮一次全部实现，先固定用户优先级。手工写 SQL 不等价为这些直接网格动作 | [ResultGrid 操作与表格](../../../../apps/desktop/src/components/ResultGrid.vue#L165) |
| G05 | 完整值、复制和类型查看 | 基础raw textarea/截断cursor全文、cell/row copy、BLOB hex只读。task81已真实通过固定单行LONGTEXT/JSON：8normalviewer/2full editor、UTF8尾部/JSON大整数及nested/wholeSHA、normalapply内新外旧→commit外新；19checks/8fetch/9同candidate阶段0 | 更多大小/控制字符/Unicode边界、JSON树/格式切换/无效输入、二进制写/外键导航、BIT/BLOB/日期时区仍待核；本组不验clipboard。复制按钮不代专用Ctrl/Cmd+C或网格方向键 | [真实全文/JSON](./gui-text-acceptance.md)、CellViewer（原始材料仅本地保留（见原SHA索引））、网格复制（原始材料仅本地保留（见原SHA索引））、导出helper（原始材料仅本地保留（见原SHA索引）） |
| T01 | 连接级事务及 dirty 守卫 | 部分真实通过：守卫/单行SQL提交、1213拒绝后false0保稿恢复、1062及1205 OFF/session5事务锁保留与rollback已过；新增六字段网格apply后同conn精确新/外旧→正常commit后同conn与外部新、lastfalse0及15checks | 没有显式autocommit/manual切换；全局executing限制其他连接并发。完整类型、多行大事务/跨标签/DDL隐式提交、ON/默认50长查询、其他写操作、COMMIT失败未知/断线和完整错误定位仍待验，不以单行正例推广全部事务 | 精确网格提交（原始材料仅本地保留（见原SHA索引））、SQL提交（原始材料仅本地保留（见原SHA索引））、死锁（原始材料仅本地保留（见原SHA索引））、1062（原始材料仅本地保留（见原SHA索引））、1205（原始材料仅本地保留（见原SHA索引））、[事务与守卫](../../../../apps/desktop/src/workbench.ts#L388)、[操作锁](../../../../apps/desktop/src/workbench.ts#L115)、[事务按钮](../../../../apps/desktop/src/components/ResultGrid.vue#L177) |
| D01 | 表/视图创建、表重命名、结构删除 | 部分：最小列名/类型/NULL/PK/default、视图 SELECT、表 rename/drop；事务前置守卫和结构刷新 | 创建表单没有目标 database/schema 选择、生成 SQL 审阅、列 charset/collation/comment/auto_increment 专项配置。选择树中另一 database 是否正确定位创建目标须 MySQL 实验；当前不能凭“新建表”按钮称设计器完整 | [DdlDialog](../../../../apps/desktop/src/components/DdlDialog.vue#L7)、[DDL 入口](../../../../apps/desktop/src/App.vue#L73)、[结构变更](../../../../apps/desktop/src/workbench.ts#L490) |
| D02 | 现有对象设计、索引/外键/触发器及例程源 | 缺失（当前 UI）：结构面板读列/FK/index/check/trigger，但没有现表 ALTER、列重排、索引/FK 编辑、视图定义编辑或 routine source 专用动作 | 这是 UI 管理差距，不表示 driver 无法通过 SQL 读取/执行。dbx 资料声明的 MySQL 物理列重排、charset/collation/comment 和源编辑，尚未形成当前表单路径 | [SchemaPanel](../../../../apps/desktop/src/components/SchemaPanel.vue#L27)、[DdlDialog](../../../../apps/desktop/src/components/DdlDialog.vue#L29) |
| D03 | 执行计划 | 基础路径已真实通过：普通无绑定SELECT专用API、正常按钮打开/刷新/返回，12列1行的两份实际DOM计划与新独立只读参考一致；9checks与native恰2次成功联合通过 | 参数/CTE/JSON/TREE/ANALYZE尚未开放；没有计划图，复杂计划及GUI错误显示/参考产品体验对照仍待验。全12项native也覆盖>200行计划、政策拒绝与1054，但不替代GUI错误验收 | EXPLAIN实证（原始材料仅本地保留（见原SHA索引））、[EXPLAIN校验](../../../../apps/desktop/src/App.vue#L79)、[ExplainPanel](../../../../apps/desktop/src/components/ExplainPanel.vue#L12) |
| X01 | CSV 导入 | 已实现基础：原生选文件、有界预览、明确列映射、重复/必填校验、批次/进度/取消和失败状态 | 仅 CSV UI，所有源列要求映射；没有源列忽略、变换或导入新建目标设计器。NULL 由显式标记处理，不直接套用 dbx 的 empty-as-NULL 默认。MySQL 默认值、中文/大整数、失败/取消的实际提交边界须单独验 | [TransferDialog 预览与启动](../../../../apps/desktop/src/components/TransferDialog.vue#L37) |
| X02 | 当前页/完整来源导出 | 已实现：当前页 CSV/JSON/INSERT/Markdown，完整表或查询流式 CSV/JSONL/JSON/INSERT，参数物化；live-paged 明示 | 页面 vs 全来源已区分；INSERT 限表来源，当前查询自动切 CSV 会清旧路径的修复保留。原生保存取消/失败重试须真实点击；MySQL 反斜杠、二进制与精确数值的输出内容须核对。不是时间点一致快照承诺 | [LoadedExportDialog](../../../../apps/desktop/src/components/LoadedExportDialog.vue#L29)、[TransferDialog 导出](../../../../apps/desktop/src/components/TransferDialog.vue#L92)、[格式切换](../../../../apps/desktop/src/components/TransferDialog.vue#L128) |
| R01 | ER 查看、布局与导出 | 已实现（源码）：按 schema/表搜索选表、最多 100 张、真实 FK、键盘/拖拽布局、保存 SVG 与取消提示 | MySQL 跨 database/复合/自引用 FK、元数据 unavailable vs 无外键及 SVG 实体/列/边待真验；所审 UI 没有缩放/适配窗口/从图跳转数据的专用入口。SVG 属本产品/dbx 高级目标，不以 DBeaver CE 支持 SVG 为依据 | [ErPanel 选择与输出](../../../../apps/desktop/src/components/ErPanel.vue#L250) |
| R02 | 结构/数据比较与同步 SQL 审阅 | 已实现基本只读路径：捕获两端结构、数据比较、警告、目标绑定 SQL；选择变化使旧结果失效 | 部分：数据表仅取已展开树，列表只显示裸表名；跨 database 同名选择易混淆。数据差异表显示状态/键/列名而非左右值；无逐项选择应用，SQL 为审阅后手动执行。MySQL 两端比较前后不写入须真验；不将 DBeaver EE/UE 比较归为 CE 共同要求 | [ComparePanel](../../../../apps/desktop/src/components/ComparePanel.vue#L23) |
| U01 | 键盘、模态和状态反馈 | 部分：树键盘导航/上下文菜单、SQL 快捷键、单元格 Enter、错误 role=alert、底部 role=status 存在 | 所审模态没有焦点捕获/返回触发点逻辑；grid 无方向键/复制快捷键，排序头无 aria-sort；结果标签不显示连接/database 标签，长时间查询需依赖上方连接控件。焦点顺序/禁用原因/菜单键盘/操作后反馈待真实 DOM 和 MySQL GUI 观察，未做对比度或视觉截图判定 | [App 标签与状态](../../../../apps/desktop/src/App.vue#L154)、[ResultGrid](../../../../apps/desktop/src/components/ResultGrid.vue#L184)、[MetadataTree](../../../../apps/desktop/src/components/MetadataTree.vue#L137) |

## K01：确定快捷键分支的最小复现与后续修复建议

本节是源码已确定的事件优先级，不是已运行的浏览器复现。责任为 [SqlEditor keydown](../../../../apps/desktop/src/components/SqlEditor.vue#L97)：`completionOpen` 时 `event.key === 'Enter'` 分支不检查 Ctrl/Meta/Shift，先调用 `acceptCompletion()` 并 return；后面的执行分支收不到该事件。

用户动作：

1. 在编辑器输入完整有效 SQL：`SELECT 41 AS from_keyboard;`。
2. 光标放在 `SELECT` 单词末，按 Ctrl+Space 令补全列表可见；也可点击“补全”后重新聚焦输入框，保持列表可见。
3. 在输入框按 Ctrl+Enter 或 Cmd+Enter。预期执行当前语句一次；当前分支只选择补全，没有 execute 事件。新结果标签/实际 MySQL 查询不会由这次快捷键触发。
4. 列表可见时，Ctrl/Cmd+Shift+Enter、单独 Shift+Enter 同样被截获；普通 Enter/Tab 选择补全则应保留。

最小修复建议：在补全的普通 Enter/Tab 分支之前识别已定义的执行快捷键，关闭补全并按 current/whole 路径执行；不新增第二个全局 key handler，不重复发出 execute。Esc 继续只关列表。

后续独立任务的**真实 DOM**测试要求：挂载真实 SFC 到浏览器测试页，以实际 textarea/按钮/listbox 交互；父测试页可将 execute 事件记录到 DOM 断言区。使用隔离的内存工作台/IPC，不读取真实配置。不得仅调用 setup、keydown、executeCurrent 函数断言通过。

| 场景 | DOM 动作 | 必须观察的结果 |
| --- | --- | --- |
| 当前语句执行 | 两条有效 SQL，光标在第一条、打开补全；真实按 Ctrl+Enter 和 Meta+Enter | 每次 execute 仅 1 次，文本仅当前语句，输入 SQL 不因补全而意外替换，列表关闭 |
| 整脚本执行 | 补全可见，真实按 Ctrl/Meta+Shift+Enter 与 Shift+Enter | 每次仅 1 次 whole script 事件；选择范围不把 whole 降成 current |
| 选中执行与按钮 | 选择一个完整语句，点击执行当前；再点击执行全部 | current 只发选区，all 发整脚本，各 1 次 |
| 补全对照 | 补全可见按普通 Enter、Tab | 只插入候选，不执行 SQL |
| Esc 恢复 | Esc 关补全后，再按执行快捷键 | SQL 仍可执行一次；焦点仍在编辑器 |

DOM 路由通过只解决键盘/按钮交互证据。真实 MySQL foundation 就绪后，还须在正常 App 路径观察实际结果、耗时/错误及连接归属，不能将事件发出计为数据库成功。

## 首批真实 MySQL GUI required matrix

所有项当前均 **未执行／未真验**。不以新 OS 账户为前置；使用已指定的测试 MySQL 服务、仅合成数据的专用 schema/权限，以及可固定到本轮隔离应用数据目录的正常原生运行入口。避免读入真实用户配置/凭据；操作者输入专用测试凭据，证据只保留版本、动作、用例 ID、计数、耗时、脱敏错误与合成结果。

测试负责人先固定应用 source/build、MySQL server version/sql_mode/字符集、两个连接及各自 database。准备两端可区分的同名表、805 行有序样本、复合主键、无主键/视图、BIGINT `9007199254740993`、高精度 DECIMAL、NULL/空串/default、utf8mb4/换行/反斜杠、长文本、JSON/BLOB、已存在的合成 FK、独立空导入表和只读比较源/目标。素材由 foundation 提供，本文不生成或清理。

验收以**实际点击/键盘驱动 UI**为主；记录正常控件是否可见、可达、反馈正确。数据库的独立只读复核仅验证实际结果，不替代 UI。以下不执行 DELETE/DROP/卸载/文件清理；删除入口仅验证打开后取消，最终删除效果保持未验。

| 用例 | 用户动作顺序 | 必须留证的业务结果 |
| --- | --- | --- |
| M01 连接与恢复 | 新建→选择 MySQL→填合成连接信息→测试→保存→断开→连接；编辑一个非秘密字段后再连 | 真实连接成功/失败反馈；秘密空白原文与已有 options 保留；当前连接与选中对象一致；TLS/SSH 按已声明边界另分配置测试 |
| M02 导航和对象上下文 | 展开两个 database→打开不同列结构的同名表→对象搜索→节点刷新→颜色分组 | 显示所属 database、结构与当前连接可辨；未加载对象不得被“无匹配”误当不存在；刷新失败有可恢复提示 |
| M03 SQL 补全与键盘 | 输入前缀自动弹出→`表名.`→SQL alias→切另一连接重复；再执行 K01 矩阵 | 候选不混入另一连接/库；无法语义补全时准确标部分；所有键盘/按钮当前/全部各只执行一次 |
| M04 参数/错误/取消 | 两条 UPDATE 各填不同 `?` 槽→观察结果；执行一条错误 SQL→再正常 SELECT；对专用 `SELECT SLEEP(20)` 发取消 | 两条绑定独立，错误后事务状态正确，原错误不被状态查询失败掩盖；取消 false 不报成功，后续连接仍可查询；只取消本次专用查询 |
| M05 分页和筛选排序 | 有序 805 行连续翻至少四页→尾页→回页；应用服务端筛选→切排序→清空筛选；保留 dirty 时点取消/应用 | 无重漏行；COUNT 的全对象范围清楚；筛选不是仅过滤当前页；取消守卫后排序标记与实际次序一致；应用后抵达原目标页，取页失败可重试 |
| M06 编辑精确值与表单取消 | 改 BIGINT/DECIMAL/NULL/空串→本地保存→应用→回滚；再提交一次合成变化；旧 dirty 时填新增全部字段→插入守卫取消→再成功 | 库中精度、空值和默认值正确；取消保留 values/include/nulls，成功才关新增；唯一键/NOT NULL 错误后可修正重试；生成列/BLOB 等只读原因可理解 |
| M07 事务归属和离开保护 | 同连接双标签分别改行→回滚/重做提交；切连接 B→查询；关闭有 dirty 的标签/退出→取消；失败提交按可控制的合成条件观察 | 两标签共用 A 事务，B 无误写；未确认前草稿不丢；失败后 pending/dirty/页面与数据库一致。COMMIT 自动回滚未经原生复现不预填结论 |
| M08 完整值与当前页导出 | 长文本/JSON/BLOB 查看完整值→复制；生成 CSV/JSON/INSERT/Markdown→取消原生保存→新文件保存；触发一次可控保存错误后重试 | 字符/字节/数值精确；NULL 和空串不混淆；保存取消不是成功，失败可重试；文件只含当前页且包括已注明的本地修改；不覆盖既有文件 |
| M09 最小结构/计划 | 通过新建表/视图表单在专用目标创建全新名字→刷新→打开结构→无参数 EXPLAIN；对索引/FK/列注释/例程源查找预期入口 | 创建目标 database 明确、结构正确、计划字段可读；当前无 UI 的对象编辑准确列缺失，不以手写 SQL 代替设计器完成；删除确认只取消 |
| M10 CSV 和完整来源导出 | 选择 small CSV→预览→映射→空表导入→四格式导出；当前查询绑定参数并筛选→导出；INSERT 后切 query→重新选新路径 | 数量、中文、反斜杠、精确数值、NULL/default 与文件内容一致；扩展名/格式一致；完整表 vs 当前查询范围准确；导出 live-paged 限制清楚 |
| M11 任务失败/取消 | 用不同空目标执行重复键失败、受控长导入/导出取消→查询该目标 | 终态、实际写入计数及事务规则一致；未触发取消不能计取消通过，不把已提交批次说成全回滚；任务终态后锁释放、可继续工作 |
| M12 只读比较 | 两端选择 schema/同名表→读取比较→查差异→载入目标编辑器但不执行→改变目标 | 差异数/精确键/列正确；目标前后值和计数不变；载入目标连接正确，旧结果随选择失效；裸表名不导致错选 |
| M13 ER 与可达性 | 选合成 FK 表→绘图→键盘/拖拽→刷新恢复→SVG 取消/保存；键盘走连接/树/编辑器/网格/模态 | FK schema/列/复合关系准确、SVG 有完整实体列边；焦点不逃出模态/关闭可返回触发点；禁用与错误有文字反馈，未由静态检查推断可访问性通过 |

每个用例记录应用版本、MySQL 配置摘要（无凭据）、具体动作、实际结果、数据库/文件内容复核与结论。已存在但未真验的路径先保持，已确定缺口进入实施；缺少新证据时不把“未验”改写为“通过”或“缺失”。
