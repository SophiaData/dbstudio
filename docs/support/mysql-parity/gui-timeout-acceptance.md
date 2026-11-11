# GUI1205：默认OFF事务保留、短时租约与正常恢复实证

结论：MySQL8.0.46/macOS的真实Tauri→Rust→MySQL网格单行1205/HY000已通过，16项检查全真。现有业务实现原样支持：等待超时后先前事务与marker锁仍在、失败草稿保留；取消回滚保持，确认回滚后恢复基线。本轮只新增有限验收及证据，没有业务修复。范围为rollback_on_timeout=OFF、GUI session lock_wait_timeout=5秒；不是默认50秒等待、ON或全部故障矩阵通过。

## 真实联合证据

[七阶段摘要](evidence/gui-timeout-seven-phase-5f5e7d2e.json)、[完整联合报告](evidence/gui-timeout-joint-82146.json)、[原始UI](evidence/gui-timeout-ui-82146.json)记录新run5f5e7d2ea41f48ea843bb88d892e2165、PID82146、GRID_TIMEOUT_VERIFIED/NONE/正常exit0，无超时/stdout/stderr。核心/工作台/driver/fixture保持，原805/1/2/0+precision11/paging9素材保持。

正常2SQL在本run创建四行id/u/v InnoDB新表并正常提交，树打开ASC。网格先应用id3.v=7，形成未提交1行，正常SQL实际读取connection_id350/marker7/session5/rollbackOFF并回表。parent独立fresh仍读四行v0，确认GUI事务及PRIMARY3 X锁；恢复global原值后，独立actor连接368固定UPDATE id1.v=v+1并保持事务、输出HELD，parent确认实际PRIMARY1 GRANTED X锁才ack。

GUI正常编辑id1.v=1并应用，parent实际观察GUI350请求、actor368阻塞的本表PRIMARY1锁等待。服务器随后真实1205/HY000。UI在任何后续查询/重载前先保存原码、true/1、dirty1和四行故障快照，再正常SQL于同一连接350读到marker7/session5/OFF，回原表草稿不变。独立fresh仍四行基线0，P_S只该GUIid错误号/SQLSTATE两列、事务COUNT与PRIMARY3 marker X锁证明先前事务实际保留，未拿旧页面7或badge单独作证。

parent收齐失败观察后，仅向自有actor发唯一固定ROLLBACK和ROLLED_BACK标记，end stdin，实际正常exit0/标记完整，无超时，才ack继续。GUI正常点击回滚→取消保持草稿/未提交状态，再回滚→确认；原表清稿、false/0、恢复四行基线。正常点击此前故障后查询标签，正常工作台已自动重读，同连接350读到marker0/session5/OFF，再回表。独立GUI事务0、marker锁0及fresh基线最终确认。

## 参数继承、恢复与lease

驱动公共网络read_timeout为10秒。本case不直接等待常见50秒，以免把网络错误错算为1205。只在新专用完整owned实例使用与native同run路径的协作排他service lease，真实读取original后临时global5，正常GUI新连接实际继承5；marker前述正常查询证实后，parent在故障放行前立即恢复original并独立回读。

本次原始guard明确记录：

```json
{"before":50,"temporary":5,"restored":50,"mutationAttempted":true,"restoredBeforeFault":true,"independentReadback":true,"finalVerified":true,"leaseRetained":true,"restoreFailure":null}
```

故障时global已50，既有GUI session仍5；正常回滚后同连接查询仍实际5/OFF。finally也以独立有界signal确认global50/OFF，再验证owner、inode/dev、700目录/600单链接文件、canonical固定绝对路径和目标不存在后，把自身lease移动到ownPID证据目录保留。实际留存目录及owner文件另被归档脚本核对，未删除/偷用lease。只变更该专用实例的lock_wait_timeout，未改rollback_on_timeout/consumer/其他global、系统策略或真实服务。

恢复冲突不盲写、恢复或actor收尾未知不能pass；本次均有正向实证。未模拟SIGKILL、外部未协调写入、restore失败或lease争用，不把成功路径提升成这些故障已验，也不声称服务器CAS或能处理所有外部干预。

## 实际RPC与状态

actual applyEdits RPC成功2、失败0；第二次业务结果为安全六标量：

```json
{"ok":false,"affected":0,"inTransaction":true,"outcomeCount":1,"failedOutcomeCount":1,"errorClass":"1205"}
```

failed最后实际transactionState为true/1，正常rollback调用成功1后，最后实际状态false/0。lastApplyResult.inTransaction=true仍描述过去批次，不是回滚后当前状态；当前状态用最后真实返回及独立P_S事务/锁共同证明。executeStatement成功4（setup2、前后正常witness各1），commit1，正常结果的RPC成功与失败outcome分开记录，不假造reject。

本次25click/6input/3dblclick/0keydown，20520ms包含5秒锁等待及actor/独立观察，不是纯DOM、启动或p95性能。actionDriver=native-dom-synthetic，不是OS可信输入或视觉截图验收；安全原码可见不等于完整服务端消息、索引/值定位体验已齐。

## 三步原始确认与来源

- marker：[checkpoint](evidence/gui-timeout-checkpoint-82146-marker.json)、[ack](evidence/gui-timeout-ack-82146-marker.json)。UI未提交marker7/session5，fresh外0，真实GUI marker锁保留；ack前global恢复及actor持锁确认。
- failed：[checkpoint](evidence/gui-timeout-checkpoint-82146-failed.json)、[ack](evidence/gui-timeout-ack-82146-failed.json)。UI原码/草稿、正常同连接7、服务器实际1205/事务锁保留、fresh外0及actor正常回滚收取。
- rolled-back：[checkpoint](evidence/gui-timeout-checkpoint-82146-rolled-back.json)、[ack](evidence/gui-timeout-ack-82146-rolled-back.json)。同连接正常结果0、UI基线/false0、独立TX/锁0/global原值。

actual DOM四行cellText规范化hash：baseline/restored8393ad54f25514e8dd72e661dc8c53e276958817ab501900f13901d6e736eaa0，marker43e84550afee6a6947d635f879e12acf93834b26e562ad35d903f21bceb864c5，faultcf1c30feb36a1ca4c5ae798306c83cf169244204de8350ce71be1665ad5d72ba。三步fresh只读autocommit均基线hash，actor未提交改动也不外泄。ack只表示观察/固定收尾完成，不能单独提升产品成功。

[冻结协议](gui-timeout-contract.md)允许failed真实坏状态及两步失败报告留档，绿色三步和独立门槛不放宽。本次没有产品红例，未为过测改断言或补业务实现。

同04c821c93b1e0e88c313e7a1c749a8480b150bb5bd95d90eb86a335d0fb9d0b8候选依次通过[initial](evidence/gui-timeout-initial-5f5e7d2e.json)、1205、[1062](evidence/gui-timeout-duplicate-84666.json)、[1213](evidence/gui-timeout-deadlock-85710.json)、[重启编辑回滚](evidence/gui-timeout-restart-86808.json)、[EXPLAIN](evidence/gui-timeout-explain-87200.json)、[提交可见性](evidence/gui-timeout-commit-87554.json)七阶段，全部正常exit0；[initial原始UI](evidence/gui-timeout-initial-ui-5f5e7d2e.json)也保留。六项产物来源/19直接源与initial材料对应，15份raw JSON及SHA映射保留。联合SHAf4585ac3017ca6fc4a32cadcd7072f4f5393b6294da6c2669d897498083775f1，摘要SHA869cfd367af6e8419e2b7a0095cc083bdcf69154d4226217031f245f6f29fcb6。

[构建回执](../../../backups/mysql-acceptance-host-build-7803a37fe74a4f04a1295bc736550e61/build-report.json)确认80精确纯宿主（旧72+8）及全部阶段通过，artifact SHA5da02c5878aa860bb35af365fe37f3e9542240fd06b3630190f45ec969c0ba2e。它们不是80项GUI；历史2core/21内存模型/native12没有本轮重跑，不合计为新GUI数。coreb4/WB4b/driver8cf/fixturecc与既有产品测试保持。

[正式flags证明](../../../backups/mysql-production-timeout-proof-9b36b8bdb2de4320a03aab85f0b058a3/report.json)确认2个JS不含31个验收/诊断标记，仅前端剔除证明，不是正式包验收。小合同、宿主与DOM/runner限定源码D2已无阻断，最终数据/交付文字独立D2亦无确定阻断，仅本次OFF/session5单行路径通过。

## 仍开放的门槛

ON配置、默认50秒/长查询与网络超时行为、其他网格写操作、多行/大事务、网格apply后提交、跨标签、COMMIT失败/未知/断线及完整错误定位继续未验。跨构建凭据、verify-full/SSH、对象与传输比较、参考应用亲测、MySQL8.4/Windows/OS可信输入/长期稳定性等仍开放。只完成此单行OFF/session5路径，不完成整个故障矩阵或完整对标目标。

所有测试表、文件和环境保留，不读真实配置/凭据/生产库、不删除或清理旧环境、不正式发布，productionReady=false。
