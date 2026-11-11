# GUI1205：默认rollback_on_timeout=OFF的实际等待、事务保留和恢复

2026-11-09，task73。新phase grid-timeout、CLI --run-grid-timeout；只验默认OFF，不推广ON/多行/其他写操作。产品coreb4/WB4b/driver8cf/fixturecc保持，不预修；若现有实现原样通过，记支持而非造fix。源19/同candidate新run initial/原4env与initial-only密码、旧profiles与72纯宿主全部保持。

## 为什么需要短时租约

MySQL builder使用network::timeout()=10秒作为read_timeout，直接等常见50秒可能先触网络错误。本case对完整owned新合成容器临时global innodb_lock_wait_timeout=5秒，正常GUI新连接继承并实际读取5后，立即恢复原global值且独立回读，才放行故障。不是默认50秒实际验收，也不是网络超时。original值真实读取不假定50；rollback_on_timeout必须原本OFF，不修改它。

仅固定内部admin-client.cnf软件消费，不读凭据/配置正文。service lease复用已审固定路径backups/mysql-transaction-contract-service-lock-<run>（与native同实例协议互斥），mkdir700排他/owner.json wx600含run/parentPID/attemptId；已有就fail，不偷/清stale。每次admin读取/变更都重新验证完整containerID/run label/owner/image/running、server root布尔身份，不输出username或秘密。闭集SQL只允许读rootbool/globaltimeout/rollbackflag及SET GLOBAL innodb_lock_wait_timeout=<已验十进制>；不任意SQL或其他global。

capture original→在SET前armed（应对返回模糊失败）→SET5→独立read5/OFF→启动GUI。marker正常查询证实session5/OFF后：读当前global，若是5就恢复original并独立readoriginal/OFF；已是original也可确认；若其他值冲突则不盲覆盖、记restore冲突/INFRA。成功恢复后不再改global，existingGUI session仍应5。finally无论UI/actor成败，使用独立有界清理signal重试确认恢复（不能继承已abort信号而跳过），不明则整个case不能pass。不得声称能恢复SIGKILL或外部未协调写入，lease是协作互斥不是服务器CAS。

最终仍读global=original/OFF，才把已核owner/inode/dev/700/600/singlelink、固定绝对路径的本lease移动到本ownPID evidence/timeout-guard-lock-retained-<pid>，留存不删。目标不存在/canonical source-target父目录与预期绝对路径均在rename前核；冲突或跨卷移动失败不绕过删除，记录未释放/INFRA，原路径保留。失败恢复不明也保留lease不释放。证据中准确记录before/temporary/restored、mutationAttempted/restoredBeforeFault/independentReadback/finalVerified/leaseRetained，不把预期值当结果。

## 正常GUI+固定actor

新表<database>.gui_to_<run32>，四行id PK/u UNIQUE/v DEFAULT0，InnoDB，id1..4/u=id/v0。正常2SQL CREATE/INSERT+正常提交按钮；正常树打开ASC，记录四行baseline DOM hash与无dirty/无TX。

1. 正常网格双击id3.v=7、保存并应用，dirty0/TXtrue1。正常SQL SELECT CONNECTION_ID() AS connection_id,v AS marker_value,@@SESSION.innodb_lock_wait_timeout AS lock_wait_timeout,@@GLOBAL.innodb_rollback_on_timeout AS rollback_on_timeout FROM <表> WHERE id=3；正常DOM读id/7/5/0，再回原表，页hash未变。发布marker检查点。parent fresh只读仍四行基线，验证该GUI事务/PRIMARY3 marker X锁在；恢复global原值/回读成功后，启动actor。
2. actor只当前owned容器app-client.cnf，新独立连接，mysql batch/raw/skip-column-names/unbuffered固定交互批次：START TRANSACTION; UPDATE本表 SET v=v+1 WHERE id=1; SELECT固定HELD marker及CONNECTION_ID。stdin暂留，parent从actual stdout取actorId，受限admin只读确认该actor本表PRIMARY1 GRANTED X锁。marker ack前这些及global恢复必须完成；失败不得放行。
3. UI收到ack，正常双击id1.v=1、保存草稿并点击应用。parent立刻只读轮询P_S data_lock_waits/data_locks/threads，限定marker中的GUIid请求、已知actorId阻塞、当前db/table/PRIMARY1，8秒内必须捕到真实wait。session5秒小于driver10；DOM等anyerror+busyfalse最多15秒，不能猜1205。
4. 故障当时先保存UIcode/state/dirty/四行hash，禁止先查状态或reload掩盖。然后再次正常执行上述SELECT，实际sameGUIid/marker7/session5/OFF，再返回原表，草稿hash不变；发布failed检查点。
5. parent独立仅该GUIid的events_statements_history最新非零MYSQL_ERRNO/RETURNED_SQLSTATE两列，必须1205/HY000，不读SQL_TEXT/MESSAGE_TEXT/digest、不启consumer。限GUIid当前表PRIMARY3 X锁/TXcount与fresh四行外部0，实际先前事务和锁应仍在。完成观察后release actor：唯一固定命令ROLLBACK; SELECT固定ROLLED_BACK marker，end stdin并收取exit0；actor不COMMIT，不能kill其他服务会话。ack只表示观察/actor收尾完成，不表示产品正确，actual坏state允许红留档。
6. 只有原码/保留/草稿/会话参数正确后：正常回滚→取消保稿，再回滚→确认。原表清稿/false0/基线；正常点击步骤4的查询标签，工作台正常自动重读，sameGUIid/marker0/session5/OFF，再回表。rolled-back第三checkpoint，parentGUI TX0/marker锁0/fresh四行baseline与最终global原值/OFF，再ack。

actor有界45秒+5秒ownclient退出收取，release幂等仅发送一次固定ROLLBACK；finally任何UI失败/关闭/abort后也先release并收actor，不能只kill本机dockerexec就假称服务端回滚。无ROLLED_BACK+normalexit0则cleanupunknown/INFRA；不自动KILL服务连接。CLI/root/livegate均异步单次15秒、watcher读wait8秒、UI每checkpoint30秒、main仅newphase120秒+5 watchdog；只轮询限定观测、子进程状态/abort/deadline先闸，所有CLI/Promise/timer收取，不能ack已退出UI。actor45秒是健康路径窗口，不能任意延长或遗留。最终global恢复收尾有独立signal和界限，不被UI取消跳过。

## 有限桥、文件与schema

debug-only mysqlAcceptanceTimeoutCheckpoint / mysqlAcceptanceTimeoutContinue；main/bundled-local/probe/phase gate先于文件/secret，桥不执行业务，不额外Application状态调用。

checkpoint exact12：
```
{schemaVersion:1,step:'marker'|'failed'|'rolled-back',uiActive:boolean,
 uiPendingAffected:0..1000integer,dirtyRows:0|1,row1Value:0|1,row3Value:0|7,
 original1205:boolean,witnessConnectionId:null|positiveSafeInteger,
 witnessMarkerValue:null|0|7,sessionTimeoutSeconds:null|1..3600integer,
 rollbackOnTimeout:null|boolean}
```
marker成功硬需true1/dirty0/row1=0/row3=7/originalfalse/id正/marker7/session5/rollbackfalse，才能启动actor。failed仅检类型/范围，准实际false0/marker0/原码false/其他参数留红。rolled-back绿色false0/dirty0/row1=0/row3=0/originaltrue/sameid/marker0/session5/OFF。marker→failed→rolled-back，前acktrue才下一步，同payload幂等/不同或乱序拒。

固定timeout-checkpoint-<ownpid>-<step>.json exact6 wrapper {schemaVersion:1,runId,phase:'grid-timeout',pid,report:<12>,observations:<actualsnapshot>}；ack timeout-ack-<ownpid>-<step>.json exact7 {schemaVersion:1,runId,phase,pid,step,proof:<原12完全相等>,verified:boolean}。Continue exactargs{schemaVersion:1,step}返回{ready:boolean,verified:boolean}，missingfalsefalse/falseacktruefalse不推进。复用已审600/singlelink/no link/canonical/openidentity/wxpending+sync+expectedabs/targetabsentrename，publish16KiB/ack2KiB，留存不删/覆盖；旧3FSM不用重构。

## 实际native结果与最终UI

仅grid-timeout snapshot增加timeout exact2：lastApplyResult null或exact6{ok,affected,inTransaction,outcomeCount,failedOutcomeCount,errorClass:'none'|'1205'|'other'}，lastObservedTransactionState null或{active,pendingAffected}。lib只正常Application真实Result后best-effort记录，actualOkfalse仍RPC成功；不存outcome.sql/error原文、不新业务call、不把server码注入。实际transactionState/commit/rollback成功才记状态，旧phase snapshot不加字段/trace19原样。

marker normalexecute3/commit1/applysuccess1；failed normalexecute4（setup2+正常前后witness2）/commit1/applysuccess2/failure0/rollback0，lastApplyResult false/affected0/outcome1failed1class1205才trigger。inTransactiontrue/actualTXtrue1是绿色保留期望，failed必须允许真实badbool/state留档；finalrollback1/lastTXfalse0，lastApplyResult.inTransaction仍为旧批次状态不能误作currentTX。

UIreport exact schemaVersion/runId/phase:'grid-timeout'/actionDriver:'native-dom-synthetic'/checks/proof/actions/elapsedMs/failureCode，16KiB。checks exact16：storage_marker,persisted_connection,credential_reconnect,fixture_created,table_open,marker_applied,session_settings,actor_held,local_draft,original_1205,transaction_preserved,draft_preserved,same_session_witness,rollback_cancel_preserved,normal_rollback,reloaded_baseline。

proof null或exact14：rowCount:4,baselineRowsSha256,markerRowsSha256,faultRowsSha256:null|hash,restoredRowsSha256:null|hash,uiActiveAfterError:null|bool,uiPendingAffectedAfterError:null|0..1000integer,dirtyRowsAfterError:null|0|1,originalErrorClass:null|'1205'|'other',witnessConnectionId:null|positiveSafeInteger,markerValueAfterError:null|0|7,markerValueAfterRollback:null|0|7,sessionTimeoutSeconds:null|1..3600integer,rollbackOnTimeout:null|boolean。hash均64lowerhex，规范化JSON.stringify({columns:['id','u','v'],rows:<实际可见4x3cellText>})；parent fresh只读autocommit SELECT3整数ORDERBYid，同格式hash/固定id1..4/u=id/v0。fault为id1v本地1、id3v7，不把旧页7单独当证据。

actions exactclick/input/keydown/dblclick非负integer<=10000；NONE input6（setup2+两cell2+前后witness2）、dblclick3、keydown0、click>=16，实际如实记；elapsed0..3600000含等待不性能。

failure闭集16：NONE/ISOLATION/CONNECTION/SETUP/TREE/EDIT/CHECKPOINT/SESSION_SETTINGS/MYSQL_ERROR_DETAILS_LOST/TRANSACTION_LOST/DRAFT_LOST/WITNESS_FAILED/RECOVERY/TIMEOUT/DOM_FAILED/NATIVE_BRIDGE。

NONE严格16true、完整proof/三ack/actualnative1205与failedtrue1、finalfalse0、sameid/正常查询7→0/session5/OFF、actor正常ROLLBACK/真实wait/独立1205/TXlock保持→结束、fresh四行基线与原805/1/2/0+11precision9paging、lease恢复/最后global原值/OFF/安全留存全部成立。partial前2step的真实产品失败normalexit1第三watcher取消单列，不洗成timeout；trigger/server实际1205/actor正常rollback/global恢复/最终TXlock0/freshbaseline全证后才known-red，缺证或未知收尾INFRA，不捏造产品缺陷。

## 执行边界

保持原19直接源/6initial摘要/initial字节/旧profiles。拆DOM+runner与host+lib+build写入，先backup、稳定D2后Lead offline locked统一构建和新run initial→1205→1062/1213/restart/EXPLAIN/commit必要回归。原72宿主全保+必要新增pure准确计数；历史2core/21model/native12不为本轮重跑合计。产品/driver/fixture/依赖零改，不清环境不读秘密，不正式发布。正式flags加入两新桥剔除，源码/纯测试均不代真实GUI。
