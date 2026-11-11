# GUI 网格事务故障：首条真实1213红例与恢复协议

2026-11-08。task67覆盖1062、默认rollback_on_timeout=OFF的1205及1213；本次先实施1213保存点/前端状态风险，其余两项继续待验，不能悄悄排除。现workbench applyTab在applyEdits reject时跳过readTransaction只是源码风险，必须先真实GUI红例再修改产品。driver8cf与fixturecc946保持，不先修workbench或伪造错误。

## 新phase、隔离和数据

内部/语义phase `grid-deadlock`，仅原4env，initial-only密码gate保持。每份候选用新合成run，同candidate先initial，再本phase；修复前后候选各自initial/newrun，避免已知跨构建凭据问题混入。不能把同binary成功当升级凭据已修。

CLI `--run-grid-deadlock`必须显式公开pin，完整owned/image/live/manifest/source门槛与initial6来源、19直接源（旧18+核心错误映射）/runner/pin/initial字节保持。runChild仅本profile90s+5s ownPID watchdog，旧profiles不变。表`<database>.gui_dl_<run32>`：id INT PRIMARY KEY、u INT NOT NULL UNIQUE、v INT NOT NULL DEFAULT0、InnoDB。固定132行：id1..4及101..228，u=id，v=0，保留表及基线，不删除或修改805素材。UI正常CREATE、INSERT两SQL和正常提交按钮建立baseline；不把手写DDL当设计器通过。

## 真实GUI与父进程有限协调

1. 正常恢复连接、SQL建表/seed并正常提交；通过当前run树正常双击新表，点击id排序到ASC，读取3列/132行，均id/u/v基线。发布baseline检查点，parent fresh只读mysql读取相同有序132行，确认后继续。
2. 正常双击id3.v，输入7并保存为本地草稿，点击应用修改；实际marker7/dirty0/未提交1行。发布marker检查点；parent fresh只读仍全v0，然后启动唯一固定actor并确认它真实等待GUI marker锁，才ack允许后续。
3. 正常双击id1.v，输入1保存草稿、核dirty1，再点击应用修改；必须独立确认该GUI连接实际MySQL SQLSTATE40001/code1213，不能1305或SIGNAL，不能另一方被选victim冒GUI成功。若核心safe_error把错误泛化，DOM如实记originalErrorClass=other/original_1213=false，仍发布observed，不等待不存在的1213文本；这仅能单列MYSQL_ERROR_DETAILS_LOST缺口，不能声称GUI原错保留。绿色仍要求GUI/native确有1213细节。
4. 等应用操作busy结束，先记录故障当时界面active/pending/dirty、实际132行快照和原错类别/rollback提示；不要先执行SQL、刷新、回滚或调用backend状态来修正界面。发布observed检查点，允许携带真实陈旧状态，不能由schema拒掉产品红例。
5. parent等actor实际完成ROLLBACK/退出，再fresh只读确认全132行v0；受限admin只读确认GUI原事务已结束（捕获的GUI连接id，无其他用户查询内容）。ack仅表示观察/actor收尾已完成，不表示UI产品正确。
6. 若界面仍active/pending1，报告DEADLOCK_TX_STATE_STALE并正常close（已取得观察后再退出），保留dirty/state原始证据。若state已false0但缺明确整事务回滚/草稿保留提示，则报告ROLLBACK_NOTICE_MISSING。红例不先改workbench，不自动当作基础设施失败。
7. 只有state/原错/草稿/提示均正确，才正常点刷新→守卫取消，证明草稿仍在；再刷新→明确“放弃本地修改”，重读基线132行v0、无dirty、无活动事务。原1213错误文本可保留到下次正常操作，不要求reload无声清原错。这样验证用户明确处理草稿后的恢复。

正常用户动作都是DOM click/dblclick/input，绝不WB/controller业务直调。仅Context/受限checkpoint/Continue/report为测试桥。INT值与已知固定数据可以保留，不能任意SQL/path/错误正文/秘密进入报告。elapsedMs含parent等待，不作为性能指标。

## 固定actor及真正等待证据

只对当前完整owned/live验证通过的固定容器，内部 `/fixture/app-client.cnf`，不读配置正文/密码或输出stderr。异步spawn docker exec -i mysql，batch/raw/skip-column-names/unbuffered，固定一次stdin批次：设置本actor session锁超时20秒，START TRANSACTION，更新128行id101..228的v加1，再更新id1的v加1，输出固定HELD marker及CONNECTION_ID；接着UPDATE id3的v加1（被GUI marker锁阻塞），成功后输出CROSSED marker、ROLLBACK、输出ROLLED_BACK marker。禁用--force，不执行COMMIT/DELETE/DROP/TRUNCATE，不改变global变量。更大写集合只提高GUI被选victim概率，最终必须从已捕获GUI连接独立核实服务器1213/40001，GUI实际收到的错误分类另行记录。

parent在收到actor HELD与其正整数连接id后，用独立 `/fixture/admin-client.cnf` 的受限只读SQL轮询performance_schema.data_lock_waits/data_locks/threads：仅请求actor连接id、当前run database/table、PRIMARY id3锁，取得唯一blocking GUI连接id，核deadlock_detect=1。不得SHOW ENGINE STATUS/PROCESSLIST或输出其他会话SQL、用户/秘密；不授新权限或修改服务器global。观察到真实wait后才marker ack。actor此时已持id1，GUI随后apply id1形成环。

observed阶段额外以受限admin只读查询performance_schema.events_statements_history JOIN threads，仅过滤已捕获的GUI PROCESSLIST_ID、非零MYSQL_ERRNO，按EVENT_ID降序取1条，仅选择MYSQL_ERRNO/RETURNED_SQLSTATE两列，不读SQL_TEXT、MESSAGE_TEXT、digest或其他会话。该连接是本轮锁等待链独立捕获且仍存活的GUI连接；GUI在observed前不再发SQL，因此错误事件必须实际1213/40001。若consumer未启用、history缺失或读不到该码，记录serverEventVerified=false/INFRA，不能启用consumer、改配置或从actor反推码。保存serverError:{code:1213,sqlState:'40001'}的独立闭集结果；确认GUI原TX ended后与actorROLLBACK/freshbaseline一起区分：GUI/native为other就是原错细节丢失，GUI/native为1213而UI仍active/pending就是状态陈旧。两缺口可同时由同次真实结果确认，记录各自事实，不预修core或WB。

观察CLI含livegate均异步、有界、独立15秒限制；wait轮询总8秒，actor总体35秒，UI每step30秒。子进程main90/5 watchdog保持可运行；ack前检查ownPID/exit/signal/deadline/abort。UI关闭会释放其事务锁，actor固定批次应继续并ROLLBACK；无论成功/失败，parent必须收取actor完成或准确记录未知，不能遗留无收取promise/timer或假称已回滚。只在固定owned目标的读取/写入权限内操作，不静默KILL任意服务连接/变更全局策略。最终fresh基线与原素材观察均尝试。

actor不是GUI本身，不让其结果冒GUI错误。若actor成为victim、未见真实wait、未从已捕获GUI连接独立证实serverError1213/40001、actor退出异常或收尾未知，应基础设施/未触发失败，不可记已复现UI陈旧状态。GUI/native实际other但服务器与其他前提完整时，按下述MYSQL_ERROR_DETAILS_LOST红例分层记录。

## 两个有限RPC与文件

新增debug-only `mysqlAcceptanceDeadlockCheckpoint`/`mysqlAcceptanceDeadlockContinue`；main+bundled-local来源、probe/phase gate在文件访问前；不执行数据库业务，不新env或生产RPC。

Checkpoint仅一个exact9对象：

```text
{schemaVersion:1,step:'baseline'|'marker'|'observed',
 uiActive:boolean,uiPendingAffected:0..1000 integer,dirtyRows:0|1,
 row1Value:0..7 integer,row3Value:0..7 integer,
 original1213:boolean,rollbackNotice:boolean}
```

baseline必须false/0/dirty0/row1=0/row3=0/两个errorboolfalse；marker必须true/1/dirty0/row1=0/row3=7/两个errorboolfalse。observed仅检类型边界而不强制statefalse或notice true，以保留真实产品红例。顺序baseline→marker→observed，前一步acktrue才下一步；相同payload重复幂等不重写，不同payload/乱序拒绝。

发布固定 `deadlock-checkpoint-<pid>-<step>.json`，exact wrapper：

```text
{schemaVersion:1,runId,phase:'grid-deadlock',pid,report:<exact9>,observations:<host snapshot>}
```

Continue仅一个exact `{schemaVersion:1,step:<闭集>}`，返回exact `{ready:boolean,verified:boolean}`。ack固定 `deadlock-ack-<pid>-<step>.json`，exact7：

```text
{schemaVersion:1,runId,phase:'grid-deadlock',pid,step,proof:<相同exact9 payload>,verified:boolean}
```

host缓存已发布payload并逐字段核ack等值，不需新hash依赖；parent另保留原始文件SHA。missing falsefalse，false truefalse不解锁，正确true可重复幂等。文件安全复用已审commit方法：固定自身PID-step路径、canonical目录/owner、600/singlelink/no symlink/打开fd元数据身份、有界<=2KiB；pending wx写全sync，重算expected绝对源目标、目标不存在后sole-writer rename，保留不删不覆盖。Wrapper观察可16KiB，其payload/ack有界2KiB。旧commit接口/文件/schema保持。

## 只记录实际native结果

仅grid-deadlock快照增加`deadlock` exact2：

```text
{lastApplyFailureClass:'none'|'1213'|'1305'|'other',
 lastObservedTransactionState:null|{active:boolean,pendingAffected:integer}}
```

lib在原正常backend调用真实返回后best-effort记录：applyEdits失败只把已有安全错误映射到闭类，不存原正文；transactionState/commitTransaction/rollbackTransaction实际成功返回时保留状态。不得为证据暗中额外调用Application业务或读取状态，不能让测试hook刷新前端。所有其他phase旧snapshot字段完全不变，诊断原19闭集/128条32KiB仍best effort。

native预期executeStatement成功2（建表/seed）、commitTransaction成功1、applyEdits成功1失败1；报告前无rollbackTransaction。原错保留时failure class1213；safe_error泛化的真实红例允许other，但必须独立serverError=1213/40001，且UI/native都如实other，不把server码注入native/GUI观察。marker checkpoint记录原transactionState读计数t；observed时红例可能仍t、lastObservedState true1，绿色须实际readTransaction读数增加至少1且lastObservedState false0，不能用旧commit返回值冒充。runQuery/closeCursor允许正常树打开、排序、应用后重读和恢复刷新，不强制无关读取次数。

## 严格最终UI报告与红绿分类

report exact schemaVersion/runId/phase:'grid-deadlock'/actionDriver:'native-dom-synthetic'/checks/proof/actions/elapsedMs/failureCode，16KiB。

checks exact14boolean：storage_marker,persisted_connection,credential_reconnect,fixture_created,table_open,marker_applied,actor_waited,local_draft,original_1213,transaction_state_correct,draft_preserved,rollback_notice,recovery_guard_cancel,reloaded_baseline。

proof null或exact9：

```text
{rowCount:132,baselineRowsSha256:64lowerhex,markerRowsSha256:64lowerhex,
 faultRowsSha256:null|64hex,reloadedRowsSha256:null|64hex,
 uiActiveAfterError:null|boolean,uiPendingAffectedAfterError:null|0..1000integer,
 dirtyRowsAfterError:null|0|1,originalErrorClass:null|'1213'|'1305'|'other'}
```

快照hash= UTF8 JSON.stringify({columns:['id','u','v'],rows:<实际可见有序132行的三格cellText字符串>})。parent fresh只读CLI SELECT三个整数列ORDER BYid，限定132行/3列/固定id集合、u=id/v0，规范化相同hash，保baseline/final值；不依赖截断GROUP_CONCAT或driver回调。marker hash与baseline不同、fault保row1本地1和marker3的7，恢复后hash必须等baseline。证明真实服务器基线回滚与草稿保留，不把旧页面的7当数据库现值。

actions exact click/input/keydown/dblclick整数0..10000；成功至少12click、input4（2SQL+2cell）、keydown0、dblclick3（表+2cell）；实际计数如实记录。elapsed整数0..3600000。failure闭集NONE/ISOLATION/CONNECTION/SETUP/TREE/EDIT/CHECKPOINT/DEADLOCK_NOT_OBSERVED/MYSQL_ERROR_DETAILS_LOST/DEADLOCK_TX_STATE_STALE/ROLLBACK_NOTICE_MISSING/RECOVERY/TIMEOUT/DOM_FAILED/NATIVE_BRIDGE。

NONE需14true、proof完整且error1213/故障时UI false0、dirty1、恢复hash=baseline；host自身3ack已确认且观测error1213、最后真实TX状态false0，观察后前后状态不由桥伪造。失败允许部分proof/null与checkfalse，按实际report正常close退出1不提升成功。

parent joint固定 `real-ui-grid-deadlock-<pid>.json`。独立serverError1213/40001+实际wait/actor正常ROLLBACK+GUI原TX结束+freshbaseline与原素材收尾均确认，是任何known-red或green的共同前提。若UI/native实际other且报告MYSQL_ERROR_DETAILS_LOST，判KNOWN_GAP_RED/同code；同时如UI仍true/pending>0，可记录transactionStateStale=true，不能宣称GUI原始1213保留。若UI/native均1213且UI故障时true/pending>0，才判KNOWN_GAP_RED/DEADLOCK_TX_STATE_STALE。其他触发/收尾失败归INFRA_ERROR或未触发，不虚构产品红例。绿色须全部UI/native/host/checkpoint/actor/fresh观察、samecandidate来源与材料、normalexit0通过；只该case标verified，不把1062/1205/全部故障恢复/生产ready等设true。

先源码备份+合同/actor/DOM/host定向D2，冻结red harness，Lead构建并真正收取red后才允许最小workbench修复。不能在编译/运行中tinyfix；所有相关job已收取且Lead明确信号才改。green新candidate/newrun，测试harness与fixture/driver保持相同，准确记录仅产品fix来源差异。旧initial/restart/explain/commit工作流按新candidate回归，精确宿主清单保留旧54、只追加必要纯合同，纯测试/构建不代本次GUI证据。因已确认核心safe_error是直接错误映射依赖，红harness冻结前在buildscript和runner来源名单共同增加crates/dbstudio-core/src/lib.rs：旧18直接源全部保留，合计19，不放宽旧profiles。修复前该核心源与WB保持原样；真实错误细节丢失红例收取后，才授权按MySQL方言和可信格式提取安全闭类码的最小透传，禁止任意服务端错误正文进入GUI。core/前端两处最小产品fix均须备份、独立测试/D2，再同harness新candidate/newrun真绿。
