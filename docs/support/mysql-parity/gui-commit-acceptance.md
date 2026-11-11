# GUI 提交前后独立可见性实证

实际运行：2026-11-08，macOS Tauri、原生Rust驱动、MySQL 8.0.46。结论：在真实工作台正常执行SQL并点击提交按钮后，单行事务的提交前不可见、提交后可见已由独立MySQL连接验证。此切片通过，整个MySQL对标及生产门槛仍未完成。

## 实际工作流与独立证据

[四阶段摘要](evidence/gui-commit-four-phase-2b5e9357.json)与[完整联合报告](evidence/gui-commit-joint-9131.json)、[原始UI报告](evidence/gui-commit-ui-9131.json)已保留。新run为2b5e9357044940bba267f79abfc0cd99，提交进程PID9131。

界面通过正常连接控件恢复已存连接；正常SQL编辑器与执行按钮依次CREATE、INSERT、SELECT、UPDATE、SELECT，期间两次点击ResultGrid正常提交按钮，没有直接调用控制器或用COMMIT SQL代替按钮。新表ui_tx_<run32>为INT主键id、VARCHAR(128) body、InnoDB，固定id1；它只是本次新合成测试素材，不将手写CREATE算作对象设计器验收。

三个阶段均在真正继续前暂停，parent分别创建fresh autocommit/read-only MySQL客户端连接。受限确认成功后，界面才进行下一阶段；pending确认之前不会点击第二次提交。

| 阶段 | 实际界面/事务状态 | 独立连接读到 | 已验证关系 |
| --- | --- | --- | --- |
| baseline | baseline值，第一次正常按钮提交后无活动事务 | baseline | UI与独立SHA一致 |
| pending | committed新值，未提交1行，active=true/pendingAffected=1 | baseline旧值 | UI新SHA与外部旧SHA不同，写入尚不可见 |
| committed | 第二次正常按钮提交后无活动事务、结果正常刷新 | committed新值 | UI新SHA与fresh外部新SHA一致 |

旧值SHA：32cde3607c142824a2d0d043fb0789b3b63ff0be74dfebf997e3aed8cfc52ff7；新值SHA：f3c8457d08b822e533ab9d3da7603304e8b3e5115c87fb17f3b3fc6f4e925f0b。摘要来自实际可见body文本，外部SHA来自独立数据库查询，不是同一driver回调或旧快照。

三组原始文件逐项保留，可核发布时的native计数与确认为true的相同步骤/摘要：

- baseline：[checkpoint](evidence/gui-commit-checkpoint-9131-baseline.json)、[ack](evidence/gui-commit-ack-9131-baseline.json)，native execute3/commit1。
- pending：[checkpoint](evidence/gui-commit-checkpoint-9131-pending.json)、[ack](evidence/gui-commit-ack-9131-pending.json)，native execute5/commit1。
- committed：[checkpoint](evidence/gui-commit-checkpoint-9131-committed.json)、[ack](evidence/gui-commit-ack-9131-committed.json)，native execute5/commit2。

应用正常close后，另一次fresh新表回读仍为committed值、唯一id1；提交值和新表保留，没有删除或自动撤销。普通fixture observer确认原805/1/2/0素材、11项精度和9项分页基线保持。

## UI、native与宿主层分别记录

本次12项UI检查全true：marker、已存连接、凭据重连、建表、基线正常提交、基线独立观察、pending可见、pending独立不可见、正常提交动作、结果刷新、提交后观察、最终非事务状态。实际9click、5input、0keydown，actionDriver仍native-dom-synthetic；未证明OS可信鼠标/键盘或录屏视觉效果。

native executeStatement恰5次成功、commitTransaction恰2次成功，均0失败；没有rollbackTransaction或applyEdits。两次runQuery/closeCursor对应正常提交后的结果刷新。keyring gets8/hits8/sets0。2330ms包含等待三个独立观察/确认的流程时间，不是纯DOM动作、启动、p95或参考产品性能比较。进程exit0、无timeout，stdout/stderr0字节。

宿主仅保存观察，原始wrapper的guiVerified/mysqlVerified/storePersistenceVerified仍false。联合runner核正常exit、12checks、顺序检查点与三个独立参考/ack、精确native/keyring、来源与材料保持及final两类observer后，才写preCommitObserverVisibilityVerified=true、commitVerified=true。不能只凭宿主或前端布尔通过。

## 同候选四阶段与来源

同一候选二进制2b1979fee13256152415e34c227f0a49670c67251ef3b963f91e7b2661a44e9c依次通过：

1. [initial正常表单/查询/分页](evidence/gui-commit-initial-2b5e9357.json)，[原始初始UI](evidence/gui-commit-initial-ui-2b5e9357.json)也保留。
2. [restart九项编辑回滚回归](evidence/gui-commit-restart-8040.json)，PID8040。
3. [EXPLAIN九项回归](evidence/gui-commit-explain-8449.json)，PID8449。
4. 本次commit十二项与独立中间观察，PID9131。

四阶段binary、前端index/assets、runner、公开pin与artifact回执六项来源摘要一致；18个直接源与initial材料字节保持。隔离root/WKstore/凭据namespace、新合成MySQL服务均沿既有安全gate，不读真实用户配置或生产库。公开pinSHA为3e3328058dcb6c9b999f8e1bba9cf3e88a457f6344878f58b8c1c9e800cf6c59；artifact回执SHA为2caaba3da2e378258fa3e8fd4b472019bb1291a392a6abdf58c22ff638f26c73。完整容器/image/source/hash在联合报告中，不输出秘密。

本轮未修改产品MySQL驱动或fixture，driver仍8cf4a09bde1a2b58f5977e175adf064d87c8b13c121fd3e177e0179d8e1c090b，fixture仍cc946c63a5a51f391bac46b2fe740fbe4b421b0fe381be7b2a233dbed076e34d。保留[上轮全12项真实native](evidence/explain-native-green-b0349ac6.json)，不将其记为本轮又执行12项。

## 实现与验证范围

新增受限commit验收phase、正常DOM工作流、异步独立观察watcher，以及两个debug-only检查点RPC。三个步骤的payload、继续状态、固定本PID文件、原子发布和严格最终报告按[冻结小协议](gui-commit-contract.md)。false或错ack不授权后续提交，final NONE还要求host自身三ack确认与已发布实际DOM摘要相符；来源main/bundled-local、probe/phase/密码读前限制保持。不增加任意SQL、路径或生产RPC。

[同源构建回执](../../../backups/mysql-acceptance-host-build-42515ea569524eba91c10a9cad3098a7/build-report.json)确认54项精确宿主测试（旧44+新10）及全部构建阶段通过。该54是纯宿主/文件边界合同测试，不是54项GUI，也不与native12相加成真实GUI场景数。小合同、宿主和DOM/runner分别完成独立只读D2，无确定阻断；最终证据与说明也完成独立交叉复核，未发现确定阻断。

[正式flags前端证明](../../../backups/mysql-production-commit-proof-7af771ed13b94e088a2c643e335da24f/report.json)确认两个JS产物不含25个验收/诊断标记，源前后相同；只证明前端剔除，未产生新的正式安装包。CLI入口node scripts/mysql-ui-acceptance.mjs --run-commit需显式公开fixture pin/image/artifact/artifact SHA与同候选initial；已有同名证据不能覆盖，不重置已提交表来复跑。

## 尚未覆盖

- 本次只验证正常SQL写入、INT/VARCHAR单行和当前结果刷新；精确类型编辑、网格apply后提交、多行/大事务、跨标签一致性及更多配置组合仍待验。
- 1062、默认OFF1205及1213的GUI网格保存点/错误恢复未过；只读发现applyTab在1213直接reject时可能跳过前端事务刷新，须后续真实GUI红例确认后最小修复。原native raw DML证据不等于网格保存点已过。
- COMMIT失败/结果未知、断线、rollback_on_timeout=ON、跨构建凭据访问仍未验证或解决；本次未修改全局超时、网络、签名或系统信任。
- MySQL8.4、Windows、verify-full/SSH组合、参考应用实际操作和真实8小时稳定性未过。TLS require不能提升为verify-full。
- 无新commit/tag/正式发布，productionReady=false，完整对标目标继续。
