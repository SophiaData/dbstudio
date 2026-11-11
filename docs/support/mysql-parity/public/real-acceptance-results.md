<!--
公开脱敏副本，原文保留本地；原始SHA256=4b5113621b8d159444b3a34d87a98e0e5b545ef78a2bf95dc361e321d99fb562，本文件不是原始字节证据。
原文相对路径：docs/support/mysql-parity/real-acceptance-results.md
本副本仅做本机路径脱敏与链接重写；任务结论、表格、RED/GREEN 判定与限界与原文一致，未新增或洗白任何结论。
-->
# MySQL 真实验收结果

日期：2026-11-07，Asia/Shanghai。状态：真实 Tauri→MySQL 查询链、同二进制重启凭据恢复与表格编辑回滚通过；原生管理和事务对照分批通过，详见各自范围。完整对标和生产验收仍进行中。

## 本轮实际结论

在 macOS arm64 上，独立测试构建实际启动了 Tauri WKWebView，正常 Vue 表单与按钮经 Rust 连接专用 MySQL 8.0.46。连接测试、保存、SELECT 41、结果首页/下一页/返回页的 6 个子检查均通过；实际 DOM 行摘要、原生方法计数和独立新只读连接回读一致，子进程正常退出。

这是真实应用与真实 MySQL 的自动化用户路径证据，动作类型为 `native-dom-synthetic`：通过已渲染控件触发 click/input，不是工作台 controller 直调，也不是 OS 可信鼠标键盘事件。本轮没有原生窗口截图/录像证据，不将浏览器截图代作 Tauri 截图。

[原始联合报告](../evidence/initial-real-ui-b51c7485c6364ad1b6a4cc52f09619de.json)，SHA-256：`c6f13e7161816dcc9cddf372b4429f9a8c26cb1e6e26d3db56132e0ec7ac4609`。

## 实际动作与结果

| 子检查 | 实际操作 / 观察 | 结果 |
| --- | --- | --- |
| storage_preflight | App 导入和挂载前，run 专属 WebView store 为空；仅检查本 run marker 和 storage.length，写回本轮 marker；不枚举或返回其他存储键 | 通过；跨进程重启尚未验 |
| connection_form | 正常新建连接对话框选择 MySQL，填写本轮端点/库/用户和 TLS require，经受控原生桥填合成密码；点击测试、保存并连接 | 通过；testConnection 1 次、addConnection 1 次成功 |
| sql_select41 | 正常 SQL 输入框填 `SELECT 41 AS from_keyboard;`，点击执行按钮，检查可见表头、唯一行和值41 | 通过 |
| page_first | 执行 `SELECT id AS parity_id, body AS parity_body FROM items_805 ORDER BY id;`，提取实际可见DOM | 200行，id 1—200；顺序、范围和摘要一致 |
| page_next | 点击正常下一页按钮 | 200行，id 201—400；顺序、范围和摘要一致 |
| page_back | 点击正常上一页按钮 | 200行，id 1—200；与原首页摘要一致 |

DOM 动作共7次 click、9次 input、0次 keydown。`executeStatement` 成功2次，`fetchResultPage` 成功2次，对应上述正常流程，没有为凑计数插入业务调用。

本轮DOM取页单次可见耗时为93/44/41ms；DOM流程从动作开始至报告为502ms，不含编译、进程启动、App boot和后续独立观察者回读。这不是冷启动时间、p95、百万行性能或参考产品性能对比结论。

## 数据库与隔离核对

- 专用官方MySQL8.0.46，loopback动态端口，实际镜像ID `sha256:b7e118f56c5963e079252e0d6e2978c9c010eb7fc7aaaec100e367796b5dd08f`。
- run为 `b51c7485c6364ad1b6a4cc52f09619de`，容器 immutable ID `e5db8a8460a876df9cb2b9b89b2978772ab6366c74765fa7b0c997bb3ab63d46`。启动前及结束后均核对归属、镜像、running/health、loopback端口与真实版本。
- 独立observer使用3个新autocommit/read-only连接：805行分页素材、1行精度素材、2行复合键素材、0行导入表保持预期；11项精度和9项分页基线检查通过。DOM实际显示前两页及返回页，不声称全部805行都在GUI逐行展示。
- TLS模式require，服务器要求安全传输；这证明本次链路加密，不是CA/原主机名verify-full或SSH组合验收。
- 独立appdata、禁legacy导入、独立WK store ID、唯一合成OS keyring namespace。keyring sets1、gets4/hits4只证明本进程实际存取；重启不填密码自动恢复尚未执行。
- stdout/stderr均0字节，正常退出码0，未超时；未访问生产库、现有应用配置或真实用户凭据，未执行文件或SQL删除清理。

## 构建来源与复核

构建报告（原始材料仅本地保留（见原SHA索引））：

- debug / no-bundle / `mysql-acceptance` feature，生产产物标志false；MySQL parity=1，旧SQLite hooks前端开关=0。
- Vue类型检查、全新禁dotenv前端构建、22个精确宿主/桥合同测试、旧SQLite test-hooks仅compile-check、debug产物均通过。
- 二进制SHA-256 `7b8f92b25fd8077a614fa5ef70dc01fd60457b7c2aea5d7bfa5e4d91a2bbabb3`；回执文件SHA-256 `95015ff4f97260ed75f15c058d1cdbd4e4aaa939e3882e256cca1f1dfc9fe6f5`。
- HEAD `7fadb00d6f9ee2cbf87949e9f908517c508a2956`加工作区修改；18个直接来源文件及前端所有产物有哈希，构建前后相等，runner启动/结束再次核对。这18项不是完整原生依赖闭包，未提交修改没有被伪称进入HEAD。
- 前端DOM、runner、原生桥及死锁最小补丁均完成非实现者独立只读复核；运行由Lead统一执行和收取。
- 另以生产flags0执行独立前端构建，2个JS产物没有旧smoke或MySQL验收桥标记，见前端隔离证明（原始材料仅本地保留（见原SHA索引））。该结果不替代生产应用验收。

本报告是该时点快照。后续MySQL driver或前端变化后，此产物不能自动标为当前代码已通过。

## 已复现并修复的事务缺陷

修复前专项基线（原始材料仅本地保留（见原SHA索引））：实际双连接1213死锁后，独立observer及marker NOWAIT验证服务端整事务已回滚，但driver仍active/pending非零。

最小补丁只在原生MySQL错误码1213时清事务缓存，并避免整事务失效后的保存点错误覆盖原始错误。修复后专项结果（原始材料仅本地保留（见原SHA索引））证实该原始死锁用例通过，全部会话回滚且805行素材未变，原分页/重复列/LIMIT对照仍通过。

该首轮结果只证明所测raw DML死锁路径。后续1205/1062原生对照与正常提交可见性已通过，见事务实证（原始材料仅本地保留（见原SHA索引））；GUI编辑死锁保存点路径、COMMIT结果未知及其他故障恢复仍待验，不能写“事务问题全部解决”。

## 管理结果后续修复与真实复验

上述初始查询链之后，已补齐所测 `SHOW TABLES`、`SHOW CREATE TABLE`、`DESCRIBE`、普通 `EXPLAIN SELECT` 的执行期列/行读取；语句只执行一次，管理游标保留有界快照，后续分页和完整值读取从该快照获取。原SELECT分页分支保持，因此本补丁不解决大表服务端分页问题。

八项真实MySQL复验（原始材料仅本地保留（见原SHA索引））全部通过：原分页/重复列/LIMIT窗口、四项管理结果、真实1213事务状态、管理快照分页/1800字符DDL全文与后续对象变更不重放/关闭释放容量，以及Text/Binary EXPLAIN结果及执行型变体拒绝。八项均确认收尾和原GUI素材保持。

四项纯管理回归（原始材料仅本地保留（见原SHA索引））也全部通过，覆盖FLOAT非精确小数的Text/Binary转换一致性、预览与完整值、保留预算和管理语句政策。它们没有连接数据库，不与八个真实用例混算。两个层级与补丁均完成独立只读复核。

管理快照上限为10000行/8MiB编码数据，每连接32MiB/16份；超限明确失败，不静默丢数据或驱逐其他游标。这些是保留的编码数据预算，不是RSS或wire读取上限。CALL、多结果集、EXPLAIN ANALYZE/FORMAT等没有被本补丁开放；专用EXPLAIN面板能力和管理SQL的完整GUI体验仍按矩阵验收。

## 重启实际失败与独立存储探针

新增重启测试包的30项宿主测试和构建通过，但[第一次真实重启](../evidence/restart-attempt1-failed-b51c7485c6364ad1b6a4cc52f09619de.json)180秒超时，缺少前端阶段报告；结束后的独立数据库回读确认素材未变。这个失败不能归因于凭据、编辑或回滚，当前没有这些业务动作已完成的证据。

随后32项宿主测试/同源构建及独立D2通过，实际运行同run/store的无业务原生探针：[原始布尔报告](../evidence/restart-storage-probe-32720.json)证明storageAccessible、markerMatched、nonemptyStore均true，业务调用和keyring计数全部为零，正常退出。startupFailureVisible=true来自probe阶段按设计拒绝进入工作台，不是对第一次正常重启页面的读回。probe仅证明当前存储可访问与本轮marker跨进程保留，不能提升为凭据重启或编辑回滚通过。

随后38项宿主测试和同源构建通过，按启动诊断合同（原始材料仅本地保留（见原SHA索引））实际运行正常工作台：[PID62707联合失败报告](../evidence/cross-build-restart-62707.json)记录预检、App导入挂载、监听、boot均已通过并进入DOM。对应[UI与native观察](../evidence/cross-build-ui-62707.json)证明配置恢复成功，但3次keyring get失败、hits0/sets0，connectConnection失败，应用正常exit1且没有超时；两类fresh observer确认素材保持，初始与旧失败报告字节保持。该记录只把失败定位到凭据恢复链路，没有保留平台错误类别，不能进一步断言具体权限、签名或解码根因。

这条旧run由较早的4efa构建保存凭据，随后使用新f9c构建读取，实际包含跨构建访问条件。现另建合成run，使用同一份f9c二进制连续执行initial与restart并通过普通重启；跨构建失败单列保留为未解决项，没有被新对照覆盖。没有改签名、系统信任、凭据或marker门槛，也不输出任何参数、异常正文或存储内容。

## 同二进制重启、编辑守卫与回滚实际通过

[配对摘要](../evidence/same-binary-pair-78b6bdc7.json)与[首次链原始报告](../evidence/same-binary-initial-78b6bdc7.json)、[重启联合原始报告](../evidence/same-binary-restart-73656.json)、[重启UI/native原始观察](../evidence/same-binary-ui-73656.json)均已保留。新run为78b6bdc7111946c9b207da92213bbcef，使用同一份二进制 `f9c0e3831096d5894b7000a4109e303f7d16e5b9f0ba87f85a0710c41749ece1` 连续完成两阶段，所有六项配对摘要均相同。

1. 首次正常连接表单测试/保存、SELECT41、首页/下一页/返回页通过；新进程不再填或重存密码，已存配置和marker恢复，keyring gets6/hits6/sets0，正常连接成功。
2. 正常树打开items_805，实际点击id列头升序。双击首行body保存本地草稿；点击下一页后在守卫中取消，页码、草稿和待应用1行均保持。
3. 点击应用后，DOM显示测试值且本地dirty清空、事务未提交1行。点击回滚并正常确认后，DOM正文和事务状态恢复。实际DOM四SHA满足before=rollback、local=applied且二者不同。
4. 当前进程applyEdits1次、rollbackTransaction1次及其他必需native方法均成功；子进程PID73656正常exit0、无超时、stdout/stderr均0字节。结束后fresh observer确认全部805行body、生成列及其他素材保持预期。

9项checks全true，实际15click/2input/2dblclick/0keydown；动作仍为native-dom-synthetic，不是OS可信鼠标键盘。922ms仅本次DOM动作流程时间，不含启动/boot，不是p95或性能对标。应用时没有中间独立observer检查，也没有提交，因此preCommitObserverVisibilityVerified和commitVerified仍false。

本轮构建报告（原始材料仅本地保留（见原SHA索引））的38项精确宿主测试、类型检查与所有构建阶段通过，18个直接来源文件锁定；38是纯合同测试，与真实九检查、8个native用例分层记录。runner显式pin读取前只接受固定本项目fixture目录下五字段公开metadata，镜像/fixture来源硬pin保留；两阶段另核同binary、前端、回执、runner和公开pin摘要。新runner改动不在18个原生来源内，不需要重编二进制，额外摘要已进入原始证据。

所有新增代码完成独立只读复核。诊断调用点完整编译期开关保护，native诊断记录失败不覆盖业务结果；该时点生产flags前端证明（原始材料仅本地保留（见原SHA索引））确认两个JS产物均无20个验收/诊断标记。这不是正式安装包验收。

## 原生提交可见性、1062与1205新增实证

事务记录（原始材料仅本地保留（见原SHA索引））与当前版本原始结果（原始材料仅本地保留（见原SHA索引））记录本轮新增3项真实用例全通过：未提交写入对独立新observer不可见、commit后可见；1062多行语句整体回滚但保留先前事务写入与锁；实际1205在rollback_on_timeout=OFF下保留先前事务，最后rollback后恢复。临时锁超时从50设1，结束后恢复原50并独立回读；805行GUI素材保持。

此次为原生driver层验证，guiPassed=false；没有替代GUI提交与失败恢复。原8项定义保留，合计11项定义，本轮只选新3项；没有把两轮版本验证算6种场景，也没有声称11项本轮全套运行。产品driver源码3fc没有改动，新增的是测试、闭集证据与安全的专用实例故障注入。

## 专用EXPLAIN API与真实面板通过

专用EXPLAIN实证（原始材料仅本地保留（见原SHA索引））记录旧API真实Unsupported红例、最小driver修复及本轮全部12项native绿例（原始材料仅本地保留（见原SHA索引）），含完整>200行计划/独立参考/危险输入拒绝/1054/非事务/无隐藏游标，原11项亦通过。

[新候选三阶段摘要](../evidence/explain-three-phase-dd714960.json)记录同f762二进制initial→restart九项回归→EXPLAIN九项检查均通过。PID36117在正常编辑器/按钮中打开、刷新计划、返回原结果，实际6click/1input，native explain成功恰2次、keyring gets6/hits6/sets0。两份可见12列1行计划与新独立只读mysql客户端参考及executedSql摘要一致，fresh素材保持，正常exit0且无超时/日志输出。258ms仅DOM流程，不是启动或性能对标；动作仍native-dom-synthetic，不是OS可信输入。

本轮44项纯宿主和全部构建阶段通过，driver源码为8cf4a09bde1a2b58f5977e175adf064d87c8b13c121fd3e177e0179d8e1c090b；18直接来源和额外runner/pin/receipt来源均锁定。生产flags前端证明（原始材料仅本地保留（见原SHA索引））确认两JS无23个测试标记，仍不是正式安装包验收。44纯宿主与12native不相加成56项真实GUI测试。

## 正常GUI提交前后独立可见性通过

2026-11-08的GUI提交实证（原始材料仅本地保留（见原SHA索引））与[四阶段摘要](../evidence/gui-commit-four-phase-2b5e9357.json)记录新2b5e run同candidate2b1979依次initial、restart九项PID8040、EXPLAIN九项PID8449、commit十二项PID9131均通过。正常编辑器执行5条SQL、两次点击ResultGrid提交：baseline外部旧值；pending界面新值且未提交1行，独立fresh readonly连接仍见旧值；确认后才正常按钮提交，再fresh连接见新值，应用close后最终新表回读仍新值。

原始checkpoint/ack、UI和joint等12份报告已归档，六项产物来源/18直接源/initial字节保持。实际9click/5input/0keydown，native5execute/2commit均0失败、keyring gets8/hits8/sets0，正常exit0无超时/日志输出。原805/1/2/0素材、11precision与9paging保持；2330ms含独立观察等待，不是纯DOM/启动/p95。只有normal单行INT/VARCHAR场景，不替代网格apply、其他类型或故障恢复。

本轮54项精确纯宿主（旧44+新10）与全构建通过，产品driver8cf和fixturecc946未改，保留上轮native12结果而不声称本轮重跑；两者不相加为GUI场景数。生产flags前端证明（原始材料仅本地保留（见原SHA索引））确认两JS无25个测试标记，仍非正式安装包。

## GUI applyEdits死锁原码与事务状态红绿实证

死锁实证（原始材料仅本地保留（见原SHA索引））与[同脚本红绿对照](../evidence/gui-deadlock-red-green-comparison.json)记录修复前dd57/PID61745确有服务器1213/40001、actor正常ROLLBACK和GUI原事务结束，但GUI/native只收到other、界面仍true/1且dirty1；故障前后TX读取同4，准确判MYSQL_ERROR_DETAILS_LOST并同时确认UI状态陈旧。红例收取及归档D2后才最小改core精确安全MySQL1213透传与工作台reject状态回读，不放行任意服务端正文、不自动清草稿/刷新。

[绿色摘要](../evidence/gui-deadlock-green-summary-c5da587f.json)记录新c5da/PID97008同harness重触发真实GUI1213，14checks全真：GUI/native1213、实际TX读取4→5且false/0、dirty1保留并明确整TX回滚提示；正常刷新守卫取消保稿，再明确放弃后重读132行基线。actor存活方ROLLBACK/exit0、P_S原码/TXended、fresh132与原805/1/2/0基线均确认，正常exit0无timeout/log。19click/4input/3dblclick/0keydown、5149ms含独立actor等待，不是性能/OS可信输入。

同绿色候选37e7依次initial→死锁恢复→restart9 PID98670→EXPLAIN9 PID99108→commit12 PID99467均过，六来源与initial材料保持。红绿19直接源仅core与工作台两个产品文件不同，harness五文件/driver8cf/fixturecc946未改；另两个测试文件有定点记录。64宿主相同清单修前后均过，另2核心单元与21内存模型通过，分层不相加成GUI通过数；未重跑不变的native12。仍无正式包/发布或完整故障恢复放行。

## GUI1062先前事务、marker锁与正常回滚真实通过

1062实证（原始材料仅本地保留（见原SHA索引））与[六阶段摘要](../evidence/gui-duplicate-six-phase-eb0e3df2.json)记录eb0e/PID44992真实唯一键1062/23000、14checks全真。故障时先捕UItrue/1及dirty1，再正常SQL在连接481读到未提交marker7，独立fresh仍基线0，P_S确认该GUI事务与PRIMARY3的X锁仍在。取消回滚保稿，再正常确认回滚后同连接正常结果变0、UIfalse/0/无dirty、独立事务与锁0、四行基线恢复；原805/1/2/0+precision11/paging9保持。

实际applyEdits RPC成功2失败0，冲突结果为ok:false/affected0/一个failed1062，未伪造RPC拒绝。core/工作台/driver/fixture业务实现保持，原样支持此单行保存点路径；与1213整事务结束的行为分开记录，不推广其他配置/批量。23click/5input/3dblclick/0keydown、12697ms含独立观察等待，非性能或OS可信输入。

同e351候选initial→1062→1213 PID46492→restart PID47597→EXPLAIN PID48007→commit PID48366六阶段均0，14raw与来源/initial保持。72宿主（旧64+8）及全构建通过，历史2core/21model/native12未本轮重跑且不凑GUI；正式flags两JS无29测试标记仍非正式包。最终交付D2无确定阻断，完整目标继续。

## GUI1205默认OFF＋session5真实等待、保留与恢复通过

1205实证（原始材料仅本地保留（见原SHA索引））与[七阶段摘要](../evidence/gui-timeout-seven-phase-5f5e7d2e.json)记录5f5e/PID82146真实1205/HY000、16checks全真。专用实例排他lease真实捕original50→暂global5，正常GUI新连接350读取session5/OFF/marker7后，parent在放行前恢复global50并独立回读。actor368真实持PRIMARY1 X锁，P_S观察GUI350→actor368等待；故障先捕UItrue1/dirty1，正常后witness同连接marker7，独立fresh外0、GUI事务/PRIMARY3 marker锁仍在。actor唯一固定ROLLBACK+标记+normalexit0收取后，正常GUI取消/确认回滚保稿再恢复，querytab同连接0、UIfalse0、独立TX0锁0/基线保持；finalglobal50/OFF与安全lease留存确认。

ActualapplyEdits RPC成功2失败0，实际Okfalse/affected0/inTxntrue/单failed1205为旧批次响应，最终实际TXfalse0另证。core/WB/driver/fixture原样支持，未造业务fix。25click6input3dbl0key、20520ms含5秒等待和独立观察，非性能/OS可信输入。仅OFF+GUI session5，不推广默认50/ON/多行或lease失败恢复。

同04c8候选initial→1205→1062 PID84666→1213 PID85710→restart86808→EXPLAIN87200→commit87554七阶段均0，15raw与initial六来源/19source/素材保持，80pure（旧72+8）及全build0；历史2core/21model/native12未本轮重跑不凑GUI，31marker/2JS仅正式flags前端非正式包。最终数据交付D2无确定阻断，完整目标继续。

## 首组六字段精确网格编辑与应用后提交真实通过

精确值实证（原始材料仅本地保留（见原SHA索引））与[八阶段摘要](../evidence/gui-precision-eight-phase-e12b3fa3.json)记录e12b/PID41700真实15checks全真。正常dialog逐字符原值、六字段编辑与NULLcheckbox双向操作，超JS范围unsigned18446744073709551614/signed-9223372036854775807、65位DECIMAL负值、UTF8和NULL/空字符串实际保持；typed DOM null|string不混同。正常apply后同GUI连接545 SQL CAST/HEX/ISNULL读精确新投影，外部fresh仍旧；正常commit后querytab自动reload同ID精确新值、外部此时才新、UI/独立TXfalse0。四阶段外部旧→旧→旧→新，原805/1/2/0+precision11/paging9素材保持，精确新表已提交结果留存。

实际applyRPCsuccess1fail0/oktrueaffected1/outcome1fail0，execute3/commit2/rollback0，lastApply.inTxntrue是过去batch而最后实际TXfalse0另证。业务core/WB/ResultGrid/driver/fixture原样支持未补fix，25click8input7dbl0key/3773ms含观察非performance/OS输入。首组六字段不推广完整类型/负例/大键/多行。

samec338候选initial→precision→1062 42927→1213 44362→1205 OFF/session5 45711→restart47754→EXPLAIN48158→commit48516八阶段均0，18raw/来源19/initial六摘要材料保持。88pure（旧80+8）及全build0，历史2core/21model/native12未重跑不凑GUI；正式flags2JS无33测试标记只前端证明非正式包，最终数据/交付独立D2无确定阻断。类型总task78与完整目标继续。

## 长文本完整值与JSON精确编辑提交（新增真实通过）

[全文/JSON验收](./gui-text-acceptance.md)：新a1b30670/PID38529，八次normal全文viewer、两次原值完整editor，longUTF8尾部1610/5610→1810/6310 chars/bytes；JSON数字9007199254740993→9007199254740995的完整大整数词法、UNSIGNED INTEGER、UTF8及nestedflag/items/null/padding由wholecanonicalSHA与normalSQL提交前完整相等1核对。actualfullpair baseline40419→draftcd38(rawcompact)→applied/committedbcd202(canonical)；正常GUI连接177未提交/正常commit后自动reload同新投影d739，fresh外旧旧旧新/最终GUI事务0，19checks全真、exit0。业务原样支持，没有为本组造修复。

同8ddd/85abreceipt/22source及initial六来源材料，initial→text→六字段precision40314→1062/41113→1213/42113→OFF/session5/1205/43450→restart45500→explain46316→commit46707九阶段全0。[九阶段摘要](../evidence/gui-text-nine-phase-a1b30670.json)SHA `70b4a340e5fd7085a89eeef982fe13118c8f99313d469db730d898eadceee58f`，19raw已保。97宿主=88+9，5纯门槛断言另计，不混入GUI或旧core/model/native层。

首次4521/20203因验收错误预设INTEGER而真实为U在提交前停INFRA：应用后全文正确、未正常网格commit、进程1后事务结束外旧；[失败摘要](../evidence/gui-text-type-infra-4521e487.json)与10raw保留，不记产品红例/通过。已独立fixedliteral取证后严格修两验收literal，另两源码D2验收门槛缺口经纯反例修正；没有改业务/重置旧表/正式发布。

## 正常SQL会话时区控制（真实红→单文件修复→绿）

[SESSION时区实证](./gui-session-timezone-acceptance.md)：原8cf驱动在59ba/PID81965拒normalSET08，正常SELECT同5207仍UTC/µs旧、P_S也旧/ON/trx0、native2success1failure、最后线程事务0；8raw+红摘要2c204.../jointc173.../dataD2保留。独立同app-role可SET排除权限猜测，明确KNOWN_GAP_RED SET_REJECTED。

仅mysql.rs改为单条显式SESSION time_zone偏移字面量在自动DML事务外执行，保通用SET/事务guard/activepending，3driver纯回归及源D2通过。新e7f4驱动/061f候选/ffd276receipt在bd5d/PID7142真绿10checks，same317 normalSET2+SELECT3，+00→08→00/epoch1709210096.123456→1709181296.123456→first纯strings、3P_S同步/ON/trx0/UIfalse0/native1/3/5success0failure、最后线程事务0。red与green五harness相同，22source中只driver变化。

同candidate initial/session/text8843/precision9761/1062-10599/1213-11553/OFF5-1205-12873/restart14926/explain15307/commit15701十阶段全0、六来源initial材料/22source保持。[十阶段红绿摘要](../evidence/gui-session-timezone-ten-phase-bd5d67d9.json)SHA `ed442fea18abff3e471d7aa67f3fb2c8f6f70ba2fa3abcc8c8c78e1cf9740f9f`/18green raw；105host=97+8与3driver单测分层，不凑GUI/旧历史core-model-native。该正例不代activeTX/named/invalid/其它SET/typed DATE/TIME网格微秒或完整时区支持。

## 明确未完成

- 可靠服务端分页/大表、更多长文本大小/控制字符/Unicode边界/JSON结构化及无效输入、时间微秒时区/BIT/二进制写/浮点/范围负例/大键等完整类型矩阵、插入/多行大事务/跨标签与COMMIT未知恢复、导入导出、对象设计器、补全上下文、比较和ER仍未覆盖；已过六字段及本组单行LONGTEXT/JSON正例apply后提交不替代这些门槛。
- GUI ON配置、默认50秒/长查询与网络超时、其他网格写操作、多行/大事务故障、COMMIT结果未知等仍未验；已验的单行applyEdits1062/1213/OFF+session5的1205不替代这些门槛，完整错误消息与索引/值定位、lease争用/失败恢复也未验。
- EXPLAIN目前仅普通无绑定SELECT的tabular路径；参数/CTE/JSON/TREE/ANALYZE及计划图、复杂计划和GUI错误展示仍未完整覆盖。
- 跨构建凭据恢复仍有上述真实失败；TLS verify-full正反例、SSH组合、MySQL8.4、Windows、OS可信快捷键与系统文件选择、30轮及真实8小时稳定性均未完成。
- dbx和DBeaver参考应用尚未实际操作，不声称体验/性能已相同。
- 未新发正式安装包，已发布v0.8.1不包含当前工作区全部修复；`productionReady:false`。长期目标继续，完整矩阵见[验收约定](../acceptance-contract.md)与[执行进度](./progress.md)。
