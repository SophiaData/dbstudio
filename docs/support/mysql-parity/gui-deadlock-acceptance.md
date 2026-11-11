# GUI 网格死锁、错误传递与状态恢复实证

MySQL 8.0.46、macOS Tauri、原生Rust驱动。本切片先真实复现再修复。当前结论：GUI applyEdits保存点路径的真实1213已完成红→绿对照，错误细节、故障后事务刷新、草稿保留提示和正常恢复均已验证；新同候选initial、死锁、重启编辑回滚、EXPLAIN与提交可见性五阶段通过。只完成此死锁切片，不宣称全部故障恢复或完整对标已通过。1062和默认OFF的1205仍是后续GUI必验项。

## 修复前真实红例

[红例摘要](evidence/gui-deadlock-red-summary-dd57df9a.json)、[完整联合报告](evidence/gui-deadlock-red-joint-61745.json)、[原始UI观察](evidence/gui-deadlock-red-ui-61745.json)已归档并经独立只读数据D2，无确定阻断。run为dd57df9a7d4242fbaef34fabdac1c64c，GUI PID61745，分类KNOWN_GAP_RED、MYSQL_ERROR_DETAILS_LOST。正常退出1、无超时，stdout/stderr0；这是期望记录产品缺口的失败，不是通过。

先由[同候选initial](evidence/gui-deadlock-red-initial-dd57df9a.json)与[初始UI](evidence/gui-deadlock-red-initial-ui-dd57df9a.json)确认正常连接、保存、查询/分页链；随后真实GUI正常SQL创建本run新132行InnoDB表并正常提交，树打开表、排序，网格双击id3.v输入7、保存草稿并点击应用，形成未提交1行。

父进程的独立actor持有128行与id1锁，再更新id3，被GUI marker锁阻塞；受限只读Performance Schema实际观察到该锁链并捕获GUI连接id后，才允许GUI双击id1.v输入1、保存并点击应用。由此形成真实等待环，不用SIGNAL、模拟错误或直接调用控制器。

独立观察确认：

- 捕获的GUI连接在服务器实际报MySQL1213、SQLSTATE40001；只读取Performance Schema错误号/SQLSTATE，不读取SQL或错误正文，不启用consumer。
- actor成为存活方，CROSSED后正常ROLLBACK并exit0；GUI原事务已结束，不是actor成为victim冒GUI成功。
- 三次fresh只读autocommit连接均确认有序132行基线；最终新表全v0。原805/1/2/0素材、11precision与9paging基线保持。
- GUI与正常native Application返回中的错误实际均为other，未收到原1213安全细节。服务器码没有被注入GUI/native观察，原码保留检查为false。
- 故障当时GUI仍active=true、pendingAffected=1，dirty草稿1行保留，整事务回滚提示缺失。marker和observed的transactionState成功读取次数均4，说明没有新增故障后状态读取。

宿主lastObservedTransactionState=true/1是故障前实际读取结果，不能据此宣称故障后driver自身缓存仍错误；独立服务器事务结束与陈旧GUI状态才构成此处状态不一致实证。绿色必须新增真实状态读取并得到false/0，不以测试桥暗中补查修正。

## 修复后同脚本真实绿色恢复

[红绿对照](evidence/gui-deadlock-red-green-comparison.json)、[绿色摘要](evidence/gui-deadlock-green-summary-c5da587f.json)、[绿色联合报告](evidence/gui-deadlock-green-joint-97008.json)与[原始绿色UI](evidence/gui-deadlock-green-ui-97008.json)保留原始证据。新run为c5da587fdca64f64a871c1582154e0cf，PID97008，分类VERIFIED/NONE，正常exit0、无超时或日志输出。

同一冻结harness再次形成真正等待环，独立服务器仍记录GUI1213/40001，actor存活后正常ROLLBACK/exit0、GUI原事务结束、132行和805/1/2/0素材恢复均确认。修复后GUI/native实际错误类为1213；故障后真实transactionState调用新增一次，marker读取次数4→observed5，最后实际读取false/0，界面也false/0。

故障当时dirty草稿仍1行，明确显示整个事务已回滚、本地草稿保留并提示处理后刷新。正常点击刷新→守卫取消后草稿仍在，再刷新→明确放弃本地修改，重新读取132行基线；没有自动清草稿或偷偷重读结果掩盖红例。14项UI检查全true，恢复后的实际DOM快照摘要等于独立服务器基线。

实际19click、4input、3dblclick、0keydown；5149ms包括actor与独立观察等待，不能将与红例4881ms差异当性能结论。绿色仍native-dom-synthetic、不是OS可信输入。

baseline：[checkpoint](evidence/gui-deadlock-green-checkpoint-97008-baseline.json)/[ack](evidence/gui-deadlock-green-ack-97008-baseline.json)；marker：[checkpoint](evidence/gui-deadlock-green-checkpoint-97008-marker.json)/[ack](evidence/gui-deadlock-green-ack-97008-marker.json)；observed：[checkpoint](evidence/gui-deadlock-green-checkpoint-97008-observed.json)/[ack](evidence/gui-deadlock-green-ack-97008-observed.json)。三个raw确认与原始UI/native/服务器观察相互对应，不单凭布尔判通过。

绿色候选二进制37e7a76bb22149f990a4deeedeba73526980277a7a732b300b00824af62d0191依次通过[initial](evidence/gui-deadlock-green-initial-c5da587f.json)、死锁恢复、[重启编辑回滚](evidence/gui-deadlock-green-restart-98670.json)、[EXPLAIN](evidence/gui-deadlock-green-explain-99108.json)、[提交可见性](evidence/gui-deadlock-green-commit-99467.json)。五阶段六项产物来源相同、19直接来源与initial材料保持；keyring故障阶段gets8/hits8/sets0。

红绿候选分别用各自新run与initial配对，不让已知跨构建凭据失败混入。19项来源只有核心映射与工作台两个产品文件不同，DOM/runner/host脚本、驱动8cf和fixturecc946均相同；另两个测试文件变更单独记录在定点回归，不将整个工作区说成只有两文件修改。

## 修复前原始阶段证据与数据快照

- baseline：[checkpoint](evidence/gui-deadlock-red-checkpoint-61745-baseline.json)、[ack](evidence/gui-deadlock-red-ack-61745-baseline.json)。UI与fresh服务器均全v0。
- marker：[checkpoint](evidence/gui-deadlock-red-checkpoint-61745-marker.json)、[ack](evidence/gui-deadlock-red-ack-61745-marker.json)。UI id3.v=7、未提交1行，fresh服务器仍全v0；真实actor等待成立后才继续。
- observed：[checkpoint](evidence/gui-deadlock-red-checkpoint-61745-observed.json)、[ack](evidence/gui-deadlock-red-ack-61745-observed.json)。UI保留id1本地1、id3页面旧7、true/1状态；服务器事务已结束并恢复基线。该ack只表示独立观察和actor收尾确认，绝不表示产品正确。

快照为实际可见id/u/v三列、132行有序cellText的规范化JSON摘要：baseline为364639f0657ce7fabc61e53dbdfef5c85b8830b693cad61323e1dc253698f896，marker为316e88d9d427fc686607d471bf51cdd8229372eac092464454f85e72592ac56a，fault为37320c020241df36fc75a7ed6daaab7eb64aee27cd30abee85357bac274b7f5f。不能将页面仍显示的7当成数据库仍保留7。

本次实际15click、4input、3dblclick、0keydown；4881ms包含actor/独立观察等待，不是纯DOM、启动、p95或参考产品性能。actionDriver为native-dom-synthetic，不是OS可信输入，未提供截图/录像视觉验收。恢复守卫取消与最终刷新当时未执行，报告相应false，不写作通过。

## 已查明的直接路径

修复前[核心错误映射](../../../crates/dbstudio-core/src/lib.rs)把未白名单driver-error泛化为driver-failed，而MySQL驱动原本已生成不含服务端正文的固定SQLSTATE/code格式；因此GUI原码丢失。只读安全方案要求绑定实际Session MySQL方言、driver-error与整条精确1213/40001常量，不contains匹配、不回显任意服务端消息，其他错误仍沿原策略隐藏。

修复前[工作台applyTab](../../../apps/desktop/src/workbench.ts)仅在applyEdits正常返回后刷新事务状态；真实1213经保存点路径直接reject，跳过刷新，dirty未clear。现最小修复仅在拒绝路径best effort读取事务状态，读取失败保原错同一对象、草稿不清、不自动reload；确认前active、实际返回false/0且为精确安全MySQL1213时，明确告诉用户整个事务已回滚、本地草稿保留，并在用户明确处理后刷新结果。

真实红例归档与所有相关job收取后才授权产品修复，未提前改core/工作台使红例消失。driver、protocol和fixture保持；核心不泛化放行1062/1205/1054或原始消息。[两项核心Rust单元](evidence/gui-deadlock-core-units-2tj_3mqt.json)覆盖19条正反边界与实际Session/driver_call接线；[21项模型](evidence/gui-deadlock-grid-model-21-oErj7k.json)保留旧17并新增4场景，覆盖状态读取失败保原错、草稿/页面不变、非死锁边界及部分失败。它们是合成回归，不是实际GUI或外部数据库验收。

核心与工作台分别完成独立源码D2，无确定阻断，随后同harness新candidate/newrun实际绿色恢复通过。最终绿色数据与交付文字亦经独立交叉复核，无确定阻断；仅本次1213 applyEdits切片通过。

## 构建与来源

[修复前构建回执](../../../backups/mysql-acceptance-host-build-c8bf506da66f4dc9906d4024ef66deef/build-report.json)确认64项精确宿主测试（旧54+新10）和全部构建阶段通过。二进制40b2e5b14a160d6f0f56edc8975737053d96bc06a6d0c99b782dbc9286429eb4，artifact回执SHA9146f7f3432fbd841553202d0abbe3061932706efa8c0cde8ad9c76bd0fd38cf。

来源包含旧18项并新增核心错误映射，合计19；与同candidate initial的binary、前端index/assets、runner、公开pin及artifact回执六摘要相同，initial材料保持。10份原始JSON与其SHA映射在红例摘要中保留，修复前core/工作台源码摘要不可被修复后来源替代。

[正式flags前端证明](../../../backups/mysql-production-deadlock-proof-f80a2df43f3b4365930454cc2345d646/report.json)确认两个JS产物不含27个验收/诊断标记，只是前端剔除，不是正式安装包验收。64纯宿主不等于64项GUI；保留的原native12结果没有在本轮重复执行，也不合并为真实GUI场景计数。

小合同、宿主、DOM/runner及红例归档分别独立D2通过。详细有限RPC、actor、服务器只读观察、红绿判定与恢复步骤见[冻结协议](gui-transaction-fault-contract.md)。CLI为node scripts/mysql-ui-acceptance.mjs --run-grid-deadlock，需新run、显式公开pin和同candidate initial；旧表/文件保留，不重置覆盖既有结果。

[绿色构建回执](../../../backups/mysql-acceptance-host-build-7f2f5782dc6f4e3abe13a6e0bda0bee4/build-report.json)确认相同64项宿主清单和全部构建阶段通过，artifact SHA9976727fd949be04fd0291faaf3332c845ab3eb637d36f1f5f52399f20b0cc2c。修复前后各运行同64清单，不计为128种场景；2核心单元、21模型、64宿主与真实GUI证据分层，不合计成GUI通过数。

## 尚未完成

GUI1062、默认OFF1205、rollback_on_timeout=ON、其他网格写操作故障、COMMIT结果未知/断线、精确类型和大事务等仍未过。跨构建凭据访问失败、其他平台/MySQL版本、verify-full/SSH组合、参考应用亲测及长期稳定性等仍保留。无新commit/tag/发布，productionReady=false，完整目标继续。
