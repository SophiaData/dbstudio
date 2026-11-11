# GUI1062：先前事务、失败草稿与正常回滚实证

结论：MySQL8.0.46/macOS的真实Tauri→Rust→MySQL网格单行唯一键冲突已通过，14项检查全真。当前业务实现原样支持：1062后先前未提交写入和marker锁仍在、失败草稿保留；取消回滚保稿，确认回滚后恢复基线。此次只新增有限验收和证据，没有制造产品修复。1205、其他写操作、多行部分失败、其他配置/平台仍未验，完整目标继续。

## 真实操作与联合证据

[六阶段摘要](evidence/gui-duplicate-six-phase-eb0e3df2.json)、[完整联合报告](evidence/gui-duplicate-joint-44992.json)、[原始UI](evidence/gui-duplicate-ui-44992.json)记录新run eb0e3df259da45bc911401662fad4c53、PID44992、VERIFIED/NONE、正常exit0，无超时/stdout/stderr。

正常SQL创建本run四行(id PK,u UNIQUE,v)InnoDB表并提交，正常树打开并id升序。先在网格应用id3.v=7形成未提交1行，再编辑id1.u=2并点击应用，服务器实际发生1062/23000。界面忙状态结束即捕获错误、true/1事务状态、dirty1及实际四行快照，未先刷新掩盖故障。

随后正常SQL查询同一连接CONNECTION_ID及id3.v，实际连接481读到7；正常点击原表标签返回后，失败草稿和故障快照未变。独立fresh只读autocommit连接仍读全v0，受限Performance Schema仅该连接/本表观察实际1062/23000、事务存在、PRIMARY3的GRANTED X锁仍持有。旧页面7和缓存badge没有被单独当作证据。

正常点击回滚→取消后草稿、true/1状态和快照保持；再点击回滚→确认执行。原表清草稿、false/0、恢复四行基线。正常切到此前查询标签，正常工作台已自动重读，仍是连接481且marker变0，再返回原表。独立事务COUNT0、marker锁0与fresh基线确认，原805/1/2/0、precision11/paging9素材保持。

本case没有外部写入actor、全局参数改变、SQL SIGNAL或业务测试桥直调；有限桥只传观察/确认。实际23click、5input、3dblclick、0keydown；12697ms包括独立观察与轮询等待，不是纯DOM/启动/p95或参考产品性能。actionDriver为native-dom-synthetic，不是OS可信输入，未声明截图/视觉或系统快捷键验收。

## API结果语义与事务状态

实际两次applyEdits RPC成功2、失败0；冲突调用本身成功返回如下安全标量，不能写成RPC拒绝：

```json
{"ok":false,"affected":0,"inTransaction":true,"outcomeCount":1,"failedOutcomeCount":1,"errorClass":"1062"}
```

failed快照的实际transactionState为active=true/pendingAffected=1。正常回滚调用成功1，最后实际状态为false/0。最终记录中的lastApplyResult.inTransaction=true仍描述先前那次apply响应，不能误当回滚后的当前状态；当前状态以最后真实状态调用和独立服务器事务/锁观察共同证明。

与已验1213整事务回滚不同，本次1062只使失败行保存点回滚，先前写入仍保留直到用户明确回滚。本结论仅覆盖该四行、单marker、单失败行路径，不推广多行部分失败或其他操作。错误可见性只验证安全1062/SQLSTATE，并未证明完整服务端消息、索引名/重复值定位等错误展示体验已对齐参考产品。

## 原始三步确认

- baseline：[checkpoint](evidence/gui-duplicate-checkpoint-44992-baseline.json)、[ack](evidence/gui-duplicate-ack-44992-baseline.json)。UI/fresh服务器均基线。
- failed：[checkpoint](evidence/gui-duplicate-checkpoint-44992-failed.json)、[ack](evidence/gui-duplicate-ack-44992-failed.json)。UI失败草稿u1=2、marker3=7；正常查询读7、外部fresh0、实际1062与事务/锁保留。
- rolled-back：[checkpoint](evidence/gui-duplicate-checkpoint-44992-rolled-back.json)、[ack](evidence/gui-duplicate-ack-44992-rolled-back.json)。同连接查询0、UI基线/false0、独立事务锁0。

actual四行id/u/v有序cellText规范化JSON摘要：baseline与restored均8393ad54f25514e8dd72e661dc8c53e276958817ab501900f13901d6e736eaa0，marker43e84550afee6a6947d635f879e12acf93834b26e562ad35d903f21bceb864c5，faulta22fb07a49dd59440a347c50a4b661657c238991a335533a4965e2c13cb14bf9。ack只表示独立观察完成，不单独代表产品正确。

[冻结协议](gui-duplicate-contract.md)保留failed真实坏状态与两步产品失败报告的表达能力，绿色三步与所有独立条件未放宽。本次实际没有产品红例，未降低门槛或补业务代码造通过。

## 同候选回归、来源与构建

同一e351ad983305544dd6a1eae7599383b4708f6ed53fb20cea05e32f01af71402d候选依次通过[initial](evidence/gui-duplicate-initial-eb0e3df2.json)、1062、[1213回归](evidence/gui-duplicate-deadlock-46492.json)、[重启编辑回滚](evidence/gui-duplicate-restart-47597.json)、[EXPLAIN](evidence/gui-duplicate-explain-48007.json)、[提交可见性](evidence/gui-duplicate-commit-48366.json)六阶段。initial的[原始UI](evidence/gui-duplicate-initial-ui-eb0e3df2.json)也保留，六项产物来源/19直接源与initial材料保持，14份原始JSON及SHA映射归档在摘要中。

[构建回执](../../../backups/mysql-acceptance-host-build-a3e77e5eb2824a55bec09585c905f3da/build-report.json)确认72项精确宿主（旧64+新8）及全部阶段通过，artifact SHA9937874e5b4d4e335222421cdf8c1829789923dfd2081a2ba36ef547b89a7e49。72纯宿主不是72项GUI；此前2核心单元、21内存模型及native12没有本轮重跑，不相加作新GUI通过数。

本轮core b4b4a089、workbench4b8ba5ed、driver8cf、fixturecc946及既有产品测试保持，变化限新验收phase/有限桥/宿主标量观察和文档。[正式flags前端证明](../../../backups/mysql-production-duplicate-proof-d81513314905432085a147c87887789e/report.json)确认2个JS不含29个验收/诊断标记，只验证前端剔除，未验正式安装包。

小合同与宿主、DOM/runner的限定源码D2已通过。最终原始证据与交付文字独立D2亦通过，无确定阻断，仅本次1062单行路径通过。所有测试表、文件与环境保留，不读真实配置/凭据/生产库，不修改系统策略、不删除或发布，productionReady=false。

## 后续门槛

默认OFF1205、ON配置、其他网格写操作、网格应用后提交/多行大事务/跨标签、COMMIT未知/断线、精确类型/性能稳定性等继续未验。跨构建凭据失败、verify-full/SSH组合、参考应用亲测、MySQL8.4/Windows/OS可信输入/长期观察仍保留。本次1062通过不替代任何这些门槛。
