# 正常SQL会话时区控制实施计划

**Goal:** task85先补task84时间类型前置：正常SQL设置会话时区，不绕GUI暗设；原业务真实红/数据D2后才最小修复，再新candidate/newrun绿色及必要回归。DATE/DATETIME6/TIMESTAMP6/TIME6网格原值/µs编辑仍是task84下一子切片，不把literal SELECT当typedgrid支持。

**Architecture:** session-timezone/--run-session-timezone，新3step有限仅观测桥，normalDOM→原executeStatement→Rust→MySQL；parent独立P_S限定ownDB/actualGUIid核会话变量，固定literal独立CLI核µs epoch。源码保旧22/97host不减，backup/disjoint/源D2后Lead统一offline lockedbuild。先保真实失败与D2、全部relatedjobs停收明示后才源fix，非harnessinfra洗产品错；旧环境不reset/删除。

**Tech Stack:** Vue3/TypeScript/Tauri2/Rust/MySQL8.0.46/Node acceptance-only。2026-11-09 Asia/Shanghai，沿用项目mysql-parity计划位置/Team执行；不新commit/依赖/OS策略/发布。

## 最小发现与实际oracle

已读mysql.rs53-63/183-209/211-217/490-503和workbench60-79：MValueDate统一datetime6、TIME小时未min2填充只是后续待实际核疑点，不预修。executeStatement在prep无列后将set与begin/commit等统拒为“请使用事务API控制事务”；普通SET SESSION time_zone因此需先真实验收，不通过native隐藏调用规避。

新59ba845c44c94e8a8d7bc05d80ad7756固定官方image与fixture sourcecc；只读/会话CLI软件消费generated Cnf不输出秘密。首探针因预设SYSTEM而实际+00断言失败，未产GUI结论；实际字段已留session-timezone-oracle-observed.json，后global核实及oracle-public.json确认：

- global/default session time_zone严格+00:00，system_time_zone UTC，global/session autocommit=1。旧4步中的同值UTC SET冗余，最终3步baseline/offset/restored。
- 固定literal `2024-02-29 12:34:56.123456`，session+00:00的CAST(UNIX_TIMESTAMP(CAST(literal AS DATETIME(6))) AS CHAR)为`1709210096.123456`；+08:00为`1709181296.123456`；恢复+00重回前者。全部原strings，不能JS Date或浮点拼微秒。
- App角色自身CLI可正常SET SESSION time_zone两offset，transaction_read_only=1/sessionautocommit1，全部无表写/global改。P_S变量格式autocommit=`ON`、time_zone=`+00:00`（不是数字1/SYSTEM）。
- 首失败仅oracle预设错误，现冻结基于实际值；不作产品红/GUI通过。publicproof只供合同，不信任它来代runtime验证，parent各attempt重新fixed独立oracle。

## 固定正常GUI步骤

profile从新candidate initial保存连接正常重连，ctx同namespace/私有acceptance root，不新connection/不读真实配置。正常SQL查询固定：

```sql
SELECT CONNECTION_ID() AS connection_id,
 @@session.time_zone AS session_timezone,
 @@system_time_zone AS system_timezone,
 @@session.autocommit AS autocommit,
 CAST(UNIX_TIMESTAMP(CAST('2024-02-29 12:34:56.123456' AS DATETIME(6))) AS CHAR) AS wall_epoch
```

实际结果唯一1row5cols，CONNECTION_ID只parse positiveSafeInteger，剩余4真实cellText原string，columns固定[session_timezone,system_timezone,autocommit,wall_epoch]、rows1x4→SHA256(JSON.stringify)。不把constant当observed。actualautocommit单元格0/1→bool；实际结果null/错误type/epoch字符串保差异，不数值舍入。

1. baseline：normal execute查询，捕实际id/tz/system/ac/epoch/UI transaction indicator，expected+00/UTC/1/1709210096.123456/currentfalse0。发布baseline，独立root P_S核同id在本run默认db、time_zone+00/autocommitON/innodb_trxCOUNT0；runtime固定app-role只读oracle三时区真实数据已验证。
2. offset：normal输入执行且仅执行 `SET SESSION time_zone = '+08:00'`，等待真实idle或error，立即捕visible error存在为setFailed（历史该SET结果，不冒读回时仍显示error）。即使SET失败也normal再次执行固定SELECT，读回真实状态/实际id；publish offset后依实际setFailed/state决定失败或继续，不能SET失败时只TIMEOUT或强expected替actual。绿色offset同id/+08/UTC/1/1709181296.123456/UIfalse0。
3. restored：只有offset业务检查全精确才正常执行 `SET SESSION time_zone = '+00:00'`，同样normal查询原strings，发布restored；绿色同id/+00/UTC/1/1709210096.123456/UIfalse0。恢复只本连接，不SET GLOBAL/OS时区/全局变量；no normalcommit/rollback/tablewrite。

Source原业务预期可能在offset拒SET（最终须actual）。其error捕获后normal查询，应仍+00/UTC/1/原epoch、baseline同id；保存offset actual cp→finalSET_REJECTED/normalexit1，不继续restored或纠状态。Native此时executeStatement success2/failure1、其余write/tx APIs0，lastactualfalse0；P_S同id变量仍+00/ON/trx0，最后线程/事务皆消失。与fixed app CLI可SET并列，作为确定产品missing support证据而非仅失败code。

正常绿色executeStatement累计1/3/5成功、failure0，commit/rollback/apply/insert/delete0、fetchCellValue0；input5(SELECT3+SET2)/keydown0/dblclick0/click>=5。elapsed含parent observe不perf。默认全程90+5/step30/CLI15；Node所有observer async bounded/childalive deadline before ack、取消后收每个CLI/settled promise，不能共享永久approval或重复poll。

## 独立reference与结束

parent对每step在child等待时用现有admin只读helper固定SQL，限定报告actualGUIid positiveSafeInteger且processlist_db=`mysql_accept_<run前16>`；排除observer CONNECTION_ID，不跨db/枚举真实sessions。

```sql
SELECT t.PROCESSLIST_ID,v.VARIABLE_NAME,v.VARIABLE_VALUE
FROM performance_schema.threads t
JOIN performance_schema.variables_by_thread v ON v.THREAD_ID=t.THREAD_ID
WHERE t.PROCESSLIST_ID=<actual positive id>
 AND t.PROCESSLIST_DB='<own db>' AND t.PROCESSLIST_ID<>CONNECTION_ID()
 AND v.VARIABLE_NAME IN ('time_zone','autocommit')
ORDER BY v.VARIABLE_NAME;
SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id=<actual positive id>;
SELECT @@system_time_zone;
```

此3SELECT只own GUI/2namedvars/trx/sysTZ，no newgrant/SQL/pathRPC/no rawlog。核变量2rows/autocommitON或OFF真实记录、systemUTC/trx真实COUNT。与UI原strings/actualautocommit/投影SHA逐项对应；各step所需epoch用固定runtime app-role sessionoracle对应实际known offset(+00或+08)，不将未验证/任意actualTZ插入SQL。unexpectedTZ仅记录actual差异，不能构造注入；缺ownthread/privilege/unsupported参考读等为INFRA不假productred。

final所有已记录GUIid(<=3)独立P_SthreadsCOUNT0+innodb_trxCOUNT0，不只table无锁冒GUI事务；先收全部ownCLI后再查询，no knownid且baseline前失败为INFRA，不猜specificid/复用text-noid门槛。全程observer原805/1/2/0+11/9、initial六来源材料/22source保持。

## 有限桥与schema

new mysqlAcceptanceSessionTimezoneCheckpoint/Continue，仅debug/main/bundledlocal/probe/phase gate在文件/secret前；phase session-timezone。同context namespace/datastore/initial-onlypassword门槛、旧trace19/phasefields完全保。ownPID固定文件 `session-timezone-checkpoint-<pid>-<step>.json` / `session-timezone-ack-...`，pub16K/ack2K；复用wxpending+sync600/singlelink/nosymlink/canonical/openFD身份/已验证绝对源目标且dest缺席后唯一writer rename；no delete/overwrite/任意路径。3step baseline/offset/restored，幂等同payload，falseack不推进。

request exact8{schemaVersion:1,step,uiActive:boolean,uiPendingAffected:0..1000integer,projectionSha256:64lowerhex,connectionId:positiveSafeInteger,setFailed:boolean,autocommit:boolean}。baseline硬setFailedfalse/UIfalse0/autocommittrue，其余type bounds允许真实badstate/idchanged/setfailed；green才三step sameid/setFailedfalse/autocommittrue/UIfalse0。wrapper6{schemaVersion,runId,phase,pid,report,observations}，ack7{schemaVersion,runId,phase,pid,step,proof:<8完全同值>,verified:boolean}；Continue args2{schemaVersion,step}/return2{ready,verified}。acktrue只是独立观测已记录，不等业务成功。

onlynewphase snapshot `sessionTimezone` exact1{lastObservedTransactionState:null|{active,pendingAffected}}，来自normal真正transactionState成功返回后bestEffort，不新call、不存sql/error body，不把SET失败RPC计success/不伪造state。native常规methods/keyringbounds沿用，green缓存每step实际累计exec1/3/5成功failure0/lastfalse0/无write/tx APIs，final再核；negative照实际metadata保，不能强5success或zeroFailures才存。

UI report原9keys(schemaVersion/runId/phase/actionDriver/checks/proof/actions/elapsedMs/failureCode)，16K，actionDriver native-dom-synthetic；checks exact10 storage_marker,persisted_connection,credential_reconnect,baseline_observed,offset_set,offset_readback,restored_set,restored_readback,same_connection,transaction_unchanged。actions4 click/input/keydown/dblclick int0..10000/elapsed0..3600000。

proof null或exact4{rowCount:1,baseline:<stage>,offset:null|stage,restored:null|stage}，stage exact9{connectionId,sessionTimezone,systemTimezone,autocommit,epochText,projectionSha256,setFailed,uiActive,uiPendingAffected}；id positiveSafeInteger，timezone/system/epoch原string length0..64无control(可保真实错误非expected，empty允许作差异)，ac/setFailed/UIactive bool，pending0..1000，hash64lowerhex。无数值日期parse/不原cellJSON parse，不将invalid观测改成expected后校验。

failure exact13 NONE/ISOLATION/CONNECTION/BASELINE_FAILED/SET_REJECTED/SESSION_MISMATCH/AUTOCOMMIT_CHANGED/EPOCH_LOSS/CONNECTION_CHANGED/TRANSACTION_CHANGED/CHECKPOINT/TIMEOUT/NATIVE_BRIDGE。

NONE需10checks全true/完整3stage proof/3published+3confirmed/native1/3/5严格/sameid/actualprojectionhash与stage证明/3P_S各自实际变量+epoch精确/+00→+08→+00/acONtrxs0、最后线程/事务0/observer材料来源/childexit0/noTimeoutlog。known-red需至少baseline+offset2ack或3ack、rawcp-proofs真实对应、nativeactual合理exec counts/independentP_S actualvariable+currenttrx都留、最后所有knownids线程/事务结束、childnormalexit1/noTimeout/素材来源保持。SET_REJECTED只在actualsetFailedtrue且该step执行失败计数+normal readback success/P_S旧TZ/独立app-role固定SET可执行共同证据；zeroerrorcode/缺schema/cp/privileges/收尾等一律INFRA。其他code须真实session/ac/epoch/connid/UIstate差异与native/独立reference对应才known-red，不以falsecheck单独断因。1ack/0ack不冒本功能knownred；partial2失败后restored watcher在childclose收取消，不TIMEOUT洗红。

## 文件分工与执行

- [ ] DOM/runner only2source：backup→新profile/context/正常5SQL输入与3query采值/失败也readback→actualproof/3cp→parentfixedoracle/ownGUI P_S/结束/closedCLI VERIFIED/KNOWN_GAP_RED/INFRA_ERROR；SOURCES22全保，仅新增关键直接依赖若确需先明确，不重构旧profile。Node/types/diff收取后stable2SHA。no runtime/DB/Cargo/private配置/额外业务改。
- [ ] host/lib/build only3source：backup→有限origin gates/schema/FSM/snapshot onlysessionTimezone1/negative保真/NONE cachednative1,3,5→旧97exact保+necessary准确newN(不硬凑)/同source22→静态/newtestnames/3SHA stable，不CargoDBGUI。no business/旧trace/phase格式改。
- [ ] Lead：小合同与两源D2/noBlock后唯一统一offline locked build新candidate/新run initial→session-timezone原业务真实红，保raw/dataD2/全relatedjobs已结束收明许可，再只最小normalSESSION time_zone支持，保事务API guard/no autocommit/global任意set/多语句放开，其他SET矩阵仍开。最小fix必须有直接regression tests及适当live回归，不把harnessinfra当productred。新candidate/newrun真green+当前initial/text/precision/dup/dead/OFF5timeout/restart/explain/commit必要回归+source/material，正式flags新增SessionTimezone2桥应37标记剔除、非正式包；最终data-docD2后交付。

task84的DATE显示/TIME小时/metadata只是已读疑点待真实，不本组预修；µs类型grid编辑/activeTX中SET/命名时区/invalidoffset/其它SET/事务控制SQL、TIMESTAMP真实跨zone行值与8.4/Windows/refapps/OS/8小时稳定性都不因本literal+session控制过而升完成。全目标保持active，无用户真实config/secrets/生产库/删除清理/OS策略依赖或发布。
