# GUI1062唯一键冲突：先前事务、锁、草稿与正常回滚

2026-11-09，task72。本轮只增加真实验收，不预修产品。core b4b4a089、workbench4b8ba5ed、driver8cf、fixturecc946保持；64旧宿主、2核心单元、21模型与此前1213实证不代本case。若产品原样通过，如实记通过，不造修复。1205/其他写操作/ON配置仍未验。

## 正常GUI流程与独立证明

内部phase `grid-duplicate`，CLI `--run-grid-duplicate`，仅原4env；本候选用新run先initial。19直接来源、六项initial产物来源、初始报告/材料字节、公开pin及完整owned/image/live gate沿现规，不改密码initial-only gate或trace闭集。新表`<database>.gui_uq_<run32>`，id INT PRIMARY KEY、u INT NOT NULL UNIQUE、v INT NOT NULL DEFAULT0，InnoDB，4行(1,1,0)..(4,4,0)。表与文件保留，不DELETE/DROP/TRUNCATE，不动805/precision/composite/import素材；手工SQL不算设计器通过。

1. 正常连接、SQL CREATE/INSERT两条，正常提交按钮提交4行。正常树双击新表、点id排序ASC，读取4行三列，baseline全u=id/v0、无dirty/TX。baseline checkpoint，parent fresh只读autocommit四行同baseline再ack。
2. 正常双击id3.v输入7，保存草稿并应用，dirty0、未提交1行；记录实际marker四行hash。正常双击id1.u输入2、保存草稿并点击应用，必须实际唯一键冲突1062/23000，不能SIGNAL/mock/controller。
3. 故障busy结束即先记录实际UI错误闭类、active/pending、dirty、四行hash；不要先查状态/刷新/rollback纠正。expectedUI仍true/1、id1.u=2本地dirty1、页面id3.v=7。只有旧页面与badge不足以证明事务保留。
4. 正常SQL编辑器执行固定只读SELECT `CONNECTION_ID() AS connection_id,v AS marker_value FROM <本表> WHERE id=3`，正常结果应一行正整数connection_id与marker_value7。保存该结果标签的DOM引用，正常点击原表标签返回，确认草稿/页面hash与故障时相同。正常SELECT是GUI业务动作，不用测试桥/控制器直调。该真实同连接读7且fresh外部读0，证明先前写仍未提交。
5. failed checkpoint。parent只读内部admin客户端，严格限已捕GUI连接id/本run database/table：events_statements_history JOIN threads，MYSQL_ERRNO<>0按EVENT_ID倒序LIMIT1，只选MYSQL_ERRNO/RETURNED_SQLSTATE，必须1062/23000；不读SQL_TEXT/MESSAGE_TEXT/digest，不启consumer。此前savepoint rollback/release加该只读SELECT仍在history范围；缺证据记INFRA、不猜码。独立读information_schema.innodb_trx仅该连接COUNT与P_S data_locks/threads仅该连接/本表/PRIMARY/LOCK_DATA='3'/GRANTED、X或X,REC_NOT_GAP，记录事务是否仍在、marker锁是否仍持有。fresh只读仍全baseline。有限3秒轮询只用于取得事务/锁观测，不读其他会话内容/权限或改变配置。
6. failed ack表示观察完成，非产品正确；允许state/witness0/锁丢失的真实坏结果留档。原1062/事务/草稿/正常查询不满足后再按真实产品红例分类；若无法独立确认1062或观察失败则INFRA，不能伪红。
7. 满足正常保留条件后，正常点击回滚→确认框取消，必须原稿与active/pending仍保持；再次正常回滚→确认执行。workbench正常rollback清本地草稿并刷新同连接结果标签。原表恢复四行baseline/false0/dirty0；正常点击步骤4的查询标签，确认自动重读后的同一connection_id与marker_value0，再返回原表。不要用新业务测试桥替代。
8. rolled-back checkpoint。parent fresh四行baseline，捕获GUI连接事务COUNT0且marker锁0，ack后最终报告。结束还尝试fresh本表基线与原805/1/2/0+precision11/paging9观察。应用正常close/exit，失败也收取所有CLI/watcher，准确写收尾；不用删除、KILL、服务配置或其他用户数据。

## 有限握手与文件

新增debug-only `mysqlAcceptanceDuplicateCheckpoint` / `mysqlAcceptanceDuplicateContinue`，main+bundledlocal/probe/phase先闸，接口不执行DB业务、不额外查状态。

Checkpoint exact10对象：

```text
{schemaVersion:1,step:'baseline'|'failed'|'rolled-back',
 uiActive:boolean,uiPendingAffected:0..1000 integer,dirtyRows:0|1,
 row1Unique:1|2,row3Value:0|7,original1062:boolean,
 witnessConnectionId:null|positive safe integer,witnessMarkerValue:null|0|7}
```

baseline必须false0/dirty0/u1/v0/originalfalse/witness两个null。failed只检类型边界，不强制true1/witness7，以便保真实产品红例。rolled-back成功必须false0/dirty0/u1/v0/originaltrue/positiveid/witness0；失败report允许前2step。

三步baseline→failed→rolled-back，前一步正确acktrue才下一步；同payload幂等不重写、不同payload/乱序拒。固定文件 `duplicate-checkpoint-<ownpid>-<step>.json` exact6 wrapper：`{schemaVersion:1,runId,phase:'grid-duplicate',pid,report:<exact10>,observations:<实际host snapshot>}`。ack `duplicate-ack-<ownpid>-<step>.json` exact7：`{schemaVersion:1,runId,phase:'grid-duplicate',pid,step,proof:<exact10与已发布相等>,verified:boolean}`。

Continue exact `{schemaVersion:1,step}`，返回exact `{ready:boolean,verified:boolean}`；missing falsefalse、falseack truefalse不推进、true可重复确认。复用已审安全文件helper：canonicalroot/owner/mode600/nlink1/no link/open identity；fixed ownPID-step，ack<=2KiB/publish<=16KiB；wx600 pending写全sync→验证绝对源目标与目标不存在后sole-writer rename，留存不删不覆盖。旧commit/deadlock schema与测试语义不改。

## 真实native结果，不把ok:false误判RPC拒绝

仅grid-duplicate的snapshot增加`duplicate` exact2：

```text
{lastApplyResult:null|{ok:boolean,affected:0..1000 integer,inTransaction:boolean,
 outcomeCount:0..1000 integer,failedOutcomeCount:0..1000 integer,
 errorClass:'none'|'1062'|'other'},
 lastObservedTransactionState:null|{active:boolean,pendingAffected:integer}}
```

lib在正常Application真实Result返回后best effort记录；只对实际Ok Value读取上述标量/闭类，不存outcome.sql或error正文，不反推服务器码，不新调用Application。actual transactionState/commit/rollback成功返回才更新最后state。其他phase snapshot完全不新增字段；原诊断19阶段/128条32KiB best effort不变。

本case failed时native applyEdits成功2/失败0（第二次实际返回ok:false），真实lastApplyResult必须okfalse/affected0/outcomeCount1/failed1/errorClass1062才确认该trigger；setup executeStatement2+witnessSELECT1合计3、commit1、rollback0是正常流程计数。绿色事务保留另要求inTransactiontrue与实际transactionState true1；失败观察必须允许实际inTransactionfalse/statefalse0或其他合法状态原样保留，不能为凑绿色伪造或schema挡掉TRANSACTION_LOST。rolled-back绿色final要求rollback1、laststatefalse0；failed快照保原value用于对照。不能把okfalse改成RPC failure。第二step已取得真实1062与独立观察后，若UI据实报产品失败normalexit1，第三step watcher因childclose取消属于部分失败收尾；收取CLI并独立确认最终基线/事务结束后按实际证据分类，不无故等第三ack记timeout/INFRA。缺servertrigger或收尾未知仍INFRA，三步全确认与全部绿色要求不放宽。

## UI最终报告

exact schemaVersion/runId/phase:'grid-duplicate'/actionDriver:'native-dom-synthetic'/checks/proof/actions/elapsedMs/failureCode，<=16KiB。

checks exact14boolean：storage_marker,persisted_connection,credential_reconnect,fixture_created,table_open,marker_applied,local_draft,original_1062,transaction_preserved,draft_preserved,same_session_witness,rollback_cancel_preserved,normal_rollback,reloaded_baseline。

proof null或exact12：

```text
{rowCount:4,baselineRowsSha256:64lowerhex,markerRowsSha256:64hex,
 faultRowsSha256:null|64hex,restoredRowsSha256:null|64hex,
 uiActiveAfterError:null|boolean,uiPendingAffectedAfterError:null|0..1000integer,
 dirtyRowsAfterError:null|0|1,originalErrorClass:null|'1062'|'other',
 witnessConnectionId:null|positive safe integer,
 markerValueAfterError:null|0|7,markerValueAfterRollback:null|0|7}
```

hash= UTF8 JSON.stringify({columns:['id','u','v'],rows:<实际可见四行有序三列cellText字符串>})，parent mysql fresh SELECT三整数列ORDERBYid同格式hash，限定4行/id1..4/u=id/v0。fault页面有本地u1=2、id3v7，不把页面7当服务器当前值；额外正常查询7与独立外部0/真实marker锁共同作证。恢复hash=baseline。

actions exactclick/input/keydown/dblclick 0..10000；NONE至少click14/input5/dblclick3，keydown0，如实记实际动作。elapsed整数0..3600000，含独立观察等待不作性能。

failure闭集15：NONE/ISOLATION/CONNECTION/SETUP/TREE/EDIT/CHECKPOINT/MYSQL_ERROR_DETAILS_LOST/TRANSACTION_LOST/DRAFT_LOST/WITNESS_FAILED/RECOVERY/TIMEOUT/DOM_FAILED/NATIVE_BRIDGE。

NONE需14true/proof完整：original1062、UI故障时true1/dirty1、witness7→0/同connectionid、恢复hashbaseline；host3ack与真实lastApplyResult false1062、failed实际TXtrue1及最后false0对应，不能从ack单独提升。失败可部分proof/checkfalse原样保存，UI正常report/close退出1。

parentjoint固定 `real-ui-grid-duplicate-<pid>.json`。独立1062/23000/真实native false1062/原素材与最终收尾可确认时，原码丢失、事务/锁/草稿丢失可记录KNOWN_GAP_RED并据实后修；缺trigger/server观察/unknowncleanup归INFRA，原样产品通过则VERIFIED，不人为造fix。green必须failed服务器事务/marker锁仍在+freshbaseline，rolled-back事务/锁结束+freshbaseline、原素材/来源initial保持及正常exit0全部证实。

## 执行与回归

main自身90秒+5秒ownPID watchdog、每step30秒、独立livegate/CLI15秒异步有界；watcher受abort/child状态/deadline先闸，finally收取所有子进程/Promises，不能ack已退出子进程。新动作只有GUI正常业务与parent受限只读观察，无DB外部写入actor或全局参数变化。

writer备份后按DOM+runner、host+lib+build清单两组分开，产品core/WB/model/driver/fixture不改。稳定源码D2→Lead离线锁定构建/新专用run initial→本case→1213/重启/EXPLAIN/commit必要回归，分层记录纯测试不代GUI；old64精确宿主全部保留，新增必要pure测试准确计数。来源19不扩，正式flags新增两个桥标记剔除，未正式发布/OS可信输入/参考应用亲测/全矩阵放行。
