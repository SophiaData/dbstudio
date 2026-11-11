<!--
公开脱敏副本，原文保留本地；原始SHA256=1263f4215519d697c8abaed141035abe691c2dc4fcbf1ada9b409aa13088e3de，本文件不是原始字节证据。
原文相对路径：docs/support/mysql-parity/progress.md
本副本仅做本机路径脱敏与链接重写；任务结论、表格、RED/GREEN 判定与限界与原文一致，未新增或洗白任何结论。
-->
# MySQL 对标执行进度

更新：2026-11-07。长期目标进行中，未宣称生产达标。

用户目标：MySQL 使用体验对标 t8y2/dbx 与 DBeaver，必须真实验收。总标准见[验收约定](../acceptance-contract.md)，执行顺序见阶段计划（原始材料仅本地保留（见原SHA索引））。

## 已冻结

- 参考基线（原始材料仅本地保留（见原SHA索引））：dbx v0.6.67 / `776b43ff1330fe1645223001e38a22f2166bf320`，DBeaver Community 26.2.4 / `9dcee590939f5c1155652fa729061035d2c347c8`。42 项官方资料任务，参考应用实际操作仍未执行。
- 驱动差距（原始材料仅本地保留（见原SHA索引））：数据/事务正确性候选、SHOW/EXPLAIN 等管理结果、实际服务端分页、安全连接与类型/对象管理。
- [桌面差距](./desktop-workflow-gaps.md)：21 条工作流状态、13 组真实 MySQL GUI 用户动作；固定补全/快捷键、分页/筛选、DDL 等差距。
- 真实验收基座（原始材料仅本地保留（见原SHA索引））：独立配置、WKWebView store、合成 keyring namespace、正常 Vue 事件→Rust→MySQL、独立 observer。已核实隔离 API，不等于隔离效果实测通过。

## 当前任务

| Task | 责任成员 | 范围 | 状态 |
| --- | --- | --- | --- |
| 43 | artifact-hardening | 参考资料冻结 | 完成；没有参考应用实操通过 |
| 44 | connection-security | MySQL driver/API 差距 | 完成；没有新增 live 通过 |
| 45 | remote-gui-test | 桌面交互差距 | 完成；没有新增 MySQL GUI 通过 |
| 46 | remote-db-policy | 真实验收隔离设计 | 完成；已纠正将 SSH Docker build 拒绝泛化到其他构建的表述 |
| 47 | remote-gui-test | SQL 补全不抢执行快捷键 + 真实浏览器 DOM 红绿验证 | 已完成：红5项全失败→绿15项通过，类型/语法/独立D2通过；测试服务已停止。仅浏览器DOM |
| 48 | remote-db-policy | 隔离 Tauri 宿主、专用配置/构建、root/run/phase 负例 | 已完成：dotenv隔离证明、11项精确测试、旧模式compile-only、独立debug构建均通过并D2无阻塞。中断目录由Lead补齐缺失阶段，报告保留；该前端为桥接前基线，不作51同源GUI证据 |
| 49 | connection-security | 官方 MySQL 独立合成服务、私有清单与只读观察者 | 已完成：8.0.46，805/1/2/0素材、11项精度与9项分页观察通过；独立D2通过。恢复后status确认服务仍健康，不计GUI或中断期间稳定性 |
| 50 | http-production-entry | 正常DOM操作、挂载前存储预检与联合runner | 已完成首条initial真实链：6子检查、native计数及fresh observer联合通过，退出码0；不是完整对标通过 |
| 51 | remote-db-policy | 初始阶段密码控件桥与严格报告 | 已完成：22个精确定向测试和最终同源构建通过，check-only与initial真实链均exit0，独立D2无阻塞；重启/soak另待验 |
| 52 | connection-security | 专项真实驱动基线 | 已运行六个exact case：分页/重复列/LIMIT正控1通过，四类管理结果与死锁状态5项真实缺口复现；全部cleanup确认。此结果是红色基线 |
| 53 | artifact-hardening | dbx/DBeaver参考工具隔离启动方案 | 资料调查完成，原版WK/securestorage隔离仍有待probe；未下载或启动参考应用 |
| 54 | connection-security | 修复真实死锁状态及管理语句结果 | 已完成本切片：8项真实native及4项新管理纯测试通过；四管理红例转绿，单次快照分页/长值/关闭回收与Text/Binary对照通过，独立D2无阻塞。复杂管理语法、1205/1062、GUI死锁等不在本次通过范围 |
| 55 | http-production-entry | 重启凭据恢复、真实表格编辑守卫与回滚DOM/runner | 已完成本切片：新78b同一f9c二进制initial→restart全过，9DOMchecks/keyring6hits0sets/编辑守卫应用回滚/fresh805正文后验通过。旧b51跨构建凭据访问失败单列保留，不代表升级兼容已解决 |
| 56 | remote-db-policy | 重启严格报告与凭据边界 | 已完成：38项精确宿主测试、完整同源构建、源码D2与上述同binary真实链通过。闭集PID诊断/生产flags隔离通过，不放宽密码与marker门槛，不宣称完整生产就绪 |
| 57 | connection-security | 原生提交可见性、1062与1205事务隔离 | 已完成：新增3项真实native对照通过，提交前后fresh observer、语句回滚/保先前写入与锁、最终rollback均确认；timeout50→1→50恢复确认，当前lease版也实测通过。旧8定义保留，本次未全跑11，不计GUI通过 |
| 58 | lead | 专用MySQL EXPLAIN API与真实面板 | 本切片已实测通过：旧APIUnsupported真实红例→最小补丁，全12项native/44项宿主与同源构建通过；新dd714同candidate initial→restart9回归→EXPLAIN9检查通过，2份DOM计划等于fresh独立参考；完整对标未完成 |
| 59 | remote-db-policy | 专用EXPLAIN类型与调用契约 | 只读完成：当前driver收到[sql]，UI拒绑定；完整5字段结果，不注册查询游标；只冻结来源契约，不计数据库或UI通过 |
| 60 | connection-security | 专用EXPLAIN API原生实现与回归 | 已完成：先真实Unsupported红例，再仅新增driver方法/分派；修复后全12项native真实通过，完整>200行计划/独立cells/政策拒绝/1054/非事务/无隐藏cursor通过 |
| 61 | http-production-entry | 正常EXPLAIN DOM与联合runner | 已完成：PID36117正常打开/刷新/返回，9checks全真，6click1input、2native explain；新run只读CLI参考与两DOM摘要及SQL摘要一致，initial六来源保持 |
| 62 | remote-db-policy | EXPLAIN严格宿主报告与隔离 | 已完成：44项精确宿主测试/全构建阶段通过，semanticphase/helper拒绝/PID排他报告及同源真实EXPLAIN联合验收通过；测试与runtime分层 |
| 63 | lead | GUI提交前后独立连接可见性 | 本切片已完成并经交付数据D2：54宿主/全构建及新2b5e同candidate initial→restart9→explain9→commit12均过，pending外部仍旧值/提交后新值/最终留存 |
| 64 | http-production-entry | 正常GUI提交DOM与父进程观察 | 已完成：PID9131正常5SQL/2提交，12checks/9click5input/实际3SHA及三fresh观察旧旧新通过，source/initial/原素材保持，不计故障或类型矩阵 |
| 65 | remote-db-policy | 三步宿主握手与严格报告 | 已完成：54精确宿主（旧44+新10）与全构建通过，真实host3confirmed/strict12、native5execute2commit与keyring8hits0sets及normalexit0联合通过 |
| 66 | connection-security | GUI事务错误恢复只读梳理 | 只读完成；后续1213修复实证、1062及OFF+session5的1205原样通过，其他配置/写操作不推广 |
| 67 | lead | 真实GUI网格事务错误恢复 | 进行中：1213真红→绿、1062原样通过；1205单行OFF/session5真实16checks与七阶段通过，交付D2通过；其他写操作/多行/ON/默认50等未验，整个故障矩阵未完成 |
| 68 | http-production-entry | 死锁DOM、独立actor与服务器原码观察 | 源码D2与同harness红绿真实闭环通过：dd57错误细节丢失/状态陈旧；c5da PID97008原码1213/false0/草稿提示/守卫恢复通过，actor/P_S/fresh基线均证 |
| 69 | remote-db-policy | 死锁有限握手与实际native结果记录 | 修前后相同64宿主及全构建通过，来源19；绿色actual1213+TX读取4→5/false0、3ack、正常收尾通过，未暗补状态/未把other伪码 |
| 70 | connection-security | MySQL安全闭类错误透传只读方案 | 只读完成：绑定真实MySQL方言+driver-error+整条精确安全1213/40001常量，其他错误仍泛化，不透原正文；已用于最小修复 |
| 71 | connection-security | 修复真实死锁错误传递与拒绝后状态 | 已完成本切片：产品/测试源码及最终交付D2、2核心单元/21模型通过；同冻结harness真实14check恢复与五阶段回归通过，不升全部错误恢复 |
| 72 | lead | GUI1062保留先前事务与失败草稿 | 已完成本切片：14checks/源码与交付D2通过，eb0e/PID44992同连接7→0、独立事务/锁保留再清除，cancel/confirm回滚基线恢复。业务保持，同候选六阶段均0 |
| 73 | lead | GUI默认OFF1205保留先前事务 | 真实16checks/七阶段通过，交付D2通过：5f5e/PID82146，session5/OFF继承、global50→5→故障前/最终50；真wait/1205、TXmarker锁留存、actor及正常GUIrollback归零/基线，业务保持，不推广默认50或ON |
| 74 | http-production-entry | 1062正常DOM、查询见证和只读观察 | 源码D2与真实GUI14checks/六阶段回归通过；先捕故障UI再正常查询同连接7→0，独立P_S/事务锁/fresh基线与素材确认，未把旧页面作证 |
| 75 | remote-db-policy | 1062有限握手与实际partial结果观察 | 72精确宿主（旧64+8）及全构建通过，实际RPC成功2失败0/第二okfalse1062、failed真实1/1→正常rollbackfalse0/3ack对应通过；旧phase不加字段 |
| 76 | http-production-entry | 1205正常DOM、固定actor与服务租约 | 源码D2与真实16checks/七阶段通过：GUI350→actor368真wait、正常7→0、actor唯一rollback/0退出、global故障前/最终恢复50/lease留存，fresh/材料/source保持 |
| 77 | remote-db-policy | 1205有限握手与实际结果观察 | 80精确宿主（旧72+8）及全build通过，actualOkfalse1205仍RPCsuccess2fail0/exec4commit1、failedTXtrue1→normalrollback1/finalfalse0、3ack对应；其他phase不加字段 |
| 78 | lead | 精确类型网格编辑与应用后提交 | 首组实际15checks/八阶段与源码/交付D2均通过：e12b/41700正常大整数/65位小数/UTF8/NULL双向编辑，normalGUI同545新值/外旧→commit外新，原样业务保持；完整类型子矩阵继续未完成 |
| 79 | http-production-entry | 精确值正常DOM与独立提交投影 | 源码D2与真实15checks/八阶段通过：typedNULL/string、normal9列witness/same545自动reload、外部旧旧旧新、最终TX结束/素材与来源保持 |
| 80 | remote-db-policy | 精确值四步握手与实际结果观测 | 88精确宿主（旧80+8）及全build通过，actualapply1/exec3/commit2/rollback0、appliedtrue1→finalfalse0与四ack对应；其他phase不加字段 |
| 81 | lead | 长文本完整值与JSON精确编辑提交 | a1b3/38529真实通过19checks，8fullviewer/2editor、UTF8尾部/JSON大整数U/nested/wholeSHA与normalcommit外新；同8ddd/85ab/22source九阶段0、19raw归档/主数据D2通过，最终文字来源delta D2通过；旧4521类型预设INFRA独立保留 |
| 82 | http-production-entry | 全文DOM与JSON独立投影 | 原业务支持：43click5input3dbl0key、正常fetch2/4/6/8/同连接177内新外旧→commit同query自动reload+外新；两harness门槛+严格U修正均D2，5pure不凑GUI；最终delta D2通过 |
| 83 | remote-db-policy | 全文有限握手与实际结果观测 | 最新8ddd候选97宿主=88+9/全部build0、22source/六来源材料同九阶段；onlytext2实际指标/8payload24proof19checks18failure及greenfetch严格，failed按实际留存，最终delta D2通过 |
| 84 | lead | 微秒时间类型与时区行为 | 已最小读日期/TIME格式及输入路径；先补普通SET SESSION时区被统一拦截的前置85，typed DATE/DATETIME6/TIMESTAMP6/TIME6网格与微秒/时区仍待真实验收，不预修格式疑点 |
| 85 | lead | 正常SQL会话时区控制 | 59ba/81965真实拒SET红→仅driver最小fix→新bd5d/7142真绿10checks，同317 UTC→08→UTC/µs精确/P_S一致/trx最终0；同061f/ffd276/22source十阶段0、8red+18green raw归档，红/主绿数据D2通过，最终来源正文delta D2通过 |
| 86 | http-production-entry | 会话时区DOM与独立观察 | a8d01/8b907同红绿冻结，normalSET2+SELECT3/5input7click0key0dbl，exec1/3/5成功0失败，normal失败也readback/cp；ownGUI/P_S结束证据/源D2通过，最终delta D2通过 |
| 87 | remote-db-policy | 会话时区有限握手与状态观察 | a8b62/7f39/41e568同红绿冻结，105已实际构建=旧97+新8/22source，3FSM/8payload4proof-stage9/10checks13failure；scope文字新回执22/旧回执保留，最终delta D2通过 |
| 88 | lead | 最小SESSION偏移设置修复 | 原8cf→e7f4仅mysql.rs，自动DML事务前normalexecute/activepending保持/原SET事务guard保；3parser单测和源D2通过、bd5d绿及10phase0，harness五源不变/其它21直接源相同，typed时间仍待验 |
| 89 | lead | UTC五字段typed时间网格 | literaloracle/合同与两组源D2通过，39正式标记2JS剔除a310/0df0实际0（frontend-only非GUI）；用户继续已resume8。原e7f4未改，114统一构建1b679运行中，之后5c91首次实际验收不预判红绿 |
| 90 | http-production-entry | 时间DOM原值与独立观察 | 中断半成品新备份后补齐，8a169/0fb685两源冻结；types eaa1 collect0/Node与diff0全收/无runtime，源D2通过；actualrows+header双hash/5orig/normalwitness12/四step，baseline坏值也先1ack留证，whole11new业务闸通过才normalcommit |
| 91 | remote-db-policy | 时间有限握手与真实native缓存 | 98293/afd640/7c914三源冻结，Node/static/diff0已收/源码D2通过；114声明=旧105+新9、23源，4FSM/8req/4proof-stage9/16checks17failure/onlytemporal实际2metadata，尚未构建 |

## 当前真实通过状态

本次已新增首条 Tauri→MySQL→独立回读真实查询链通过：[实际结果与边界](./real-acceptance-results.md)。独立Tauri窗口正常表单测试/保存、SELECT41、805行数据首200/后200/返回200的6子检查、原生方法计数与fresh observer一致，正常退出；不提升为全部对标项通过。新增原生 MySQL 8.0.46 专项已真实运行：有序805行五页、重复列名和原LIMIT窗口正向对照通过；SHOW TABLES、SHOW CREATE TABLE、DESCRIBE、EXPLAIN 结果缺口各一项复现；真实1213死锁服务端整事务回滚并释放marker锁后，driver仍保留active/pending的缺陷也已复现。六项均确认连接/事务收尾，805行GUI素材保持原样。原始结果见真实驱动基线（原始材料仅本地保留（见原SHA索引））。这些1通过/5红色基线不冒充GUI验收。随后最小1213缓存/保存点原错补丁已完成真实复验：修复后结果（原始材料仅本地保留（见原SHA索引））为2通过/4管理缺口红例，死锁缓存与服务端一致，全部收尾确认；该修复时点尚未验1205/1062及UI事务异常；后续3项原生事务对照已通过，见事务实证（原始材料仅本地保留（见原SHA索引）），UI事务异常仍未验，不宣称P0完整放行。旧 68 项核心、2 项真实 NoSQL、162 条 SQLite 核心性能样本及 46 项模型/内存业务回归保持原有范围，不能合并成 MySQL 对标已通过数。

另完成生产flags=0的独立前端构建，2个JS资产均无smoke或MySQL验收桥标记；该证据只验证构建隔离，未启动应用，不提升为生产验收。

已完成一次计划/验收约定/驱动与桌面报告/基座报告的独立只读交叉复核，无确定阻塞；发现的独立授权文案歧义已按当前专用实例目标修正。参考基线也已由非作者独立只读复核，无确定阻塞；复核确认文档内部来源/版本权限/范围和证据分层，不冒充已联网独立核实所有出处或亲测参考产品。

## 下一条真实验收链

同一候选二进制的首次连接→新进程凭据恢复→真实表格编辑/守卫/应用/回滚已完成；专用EXPLAIN也通过，见EXPLAIN实证（原始材料仅本地保留（见原SHA索引））。新候选四阶段及正常GUI提交前后独立可见性通过，见提交实证（原始材料仅本地保留（见原SHA索引））。新增死锁红绿实证（原始材料仅本地保留（见原SHA索引））及同绿色候选五阶段通过。新增1062事务保留实证（原始材料仅本地保留（见原SHA索引））与新同候选六阶段通过。新增1205 OFF/session5实证（原始材料仅本地保留（见原SHA索引））与新同候选七阶段通过，global50→5→故障前/最终50、actor正常收取留证。新增首组六字段精确编辑/提交（原始材料仅本地保留（见原SHA索引））与同c338八阶段通过，库外旧旧旧新、同545正常查询精确投影、原样业务保持；全类型总task78不完成。新增[全文/JSON精确编辑提交](./gui-text-acceptance.md)与8ddd同候选九阶段通过，8normalviewer/2full editor、JSON strictU/完整相等1在commit前、同177自动reload/外旧旧旧新，22source/19raw/最终D2已收；旧类型预设INFRA保留不冒产品红绿。新增[正常SESSION时区红绿](./gui-session-timezone-acceptance.md)：原业务拒SET真红→仅driver最小fix→同317 UTC/08/UTC与精确µs字符串/独立P_S一致，十阶段全0/18green原始与8red保留；typed时间grid与task84仍未验。最新105宿主纯测试、3驱动parser单测、历史5软件门槛断言和历史2core/21model/12native分层，后三者未本轮重跑，不凑GUI数。

1. 单行保存点1062/1213/OFF+session5的1205已真实验收；保留其他写操作、多行/大事务、ON/默认50长查询与网络超时等门槛。下一优先推进第2项精确类型网格编辑和apply后提交；不以三个错误码或native rawDML宣称整个事务矩阵完成。
2. 接续完整类型矩阵：首组六字段网格apply后正常commit已验，下一优先长文本完整编辑/JSON/微秒时间等；BIT/blob写/范围负例/大键/插入、多行大事务/跨标签/COMMIT未知仍保持待验，不以六字段正向路径推广全部。
3. 单独定位跨构建凭据读取失败，不能用已过同binary重启覆盖升级场景；平台错误类别尚未保留，不猜权限/签名根因。
4. 继续对象设计/传输/比较、TLS/SSH组合、参考应用实操与性能长期观察；所有未实现项保持可见。
5. EXPLAIN参数、CTE、JSON/TREE/ANALYZE与计划图、复杂计划和GUI错误显示仍有差距；本轮基本计划通过不意味着该大类完整对齐。

此前 SSH Docker buildx 的具体拒绝不推广为 Cargo/Tauri 或 MySQL 官方镜像的全局禁令；每个新动作若被明确拒绝则停止该动作，不换源/改系统策略绕过。没有生产账号、真实配置或 OS 测试账户前置请求；不删除数据、容器或文件，不覆盖旧发布。
