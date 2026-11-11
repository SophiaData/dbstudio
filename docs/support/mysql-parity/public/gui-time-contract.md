<!--
公开脱敏副本，原文保留本地；原始SHA256=c8577ebbf42f1b4892e1448353214990653de81b7e1e7a5dffa4102a178cd6ac，本文件不是原始字节证据。
原文相对路径：docs/support/mysql-parity/gui-time-contract.md
本副本仅做本机路径脱敏与链接重写；任务结论、表格、RED/GREEN 判定与限界与原文一致，未新增或洗白任何结论。
-->
# UTC五字段时间网格原值/编辑/提交实施计划

**Goal:** task89是时间总task84第一typed正例：正常Tauri网格DATE、DATETIME(6)、TIMESTAMP(6)、宽小时TIME(6)、短小时TIME(6)原文/表头类别/编辑原值/本地draft/apply内新外旧/normalcommit外精确新；不把前置85的literal函数或SET控制当typedgrid通过。先原业务真实红/保raw数据D2、所有相关jobs收后最小fix，不能预修已读疑点或改期望洗错。

**Architecture:** new grid-time/--run-grid-time/TimeCheckpoint/Continue，四步baseline/draft/applied/committed有限仅观测桥；原executeStatement/openObject/normaldialogs/apply/commit；独立fresh canonical SQL+I_S column types/FSP+ownGUI P_S/session/txn并核实际DOM typedrows/types/dialograw。原22直接来源全部保，新增关键ResultValueType定义[结果集契约](../../../../src/core/resultset.ts)为23；旧105host+3driverparser回归全部保，新必要pure准确N。backup分写/源D2/Lead单一offline locked Cargo2 fresh build+run真实验收。

**Tech Stack:** Vue3/TypeScript/Tauri2/Rust/MySQL8.0.46官方固定image，原有e7f4 SESSIONoffset支持。日期2026-11-09 Asia/Shanghai；所有literal的语义时区明确+00:00，非未限定用户时间。无依赖/OS策略/发布/真实配置秘密/生产库/删除清理。

## 直接发现与已核oracle

已最小读mysql.rs61–70/219–225、ResultGrid102–135/184/193、workbenchinputCell、resultset.ts25–42。MValueDate统一拼datetime6、TIME小时没有min2填充、TIME列因binarycharset落blob仅为待实际疑点，不预修。header小字真实显示column.type；ResultValueType只有integer/real/text/blob/null/boolean/date/unknown，无time枚举，冻结TIME的类别为text，DATE/DT/TS保现有date类别，不扩协议enum。非NULLcell实际kind=text进入编辑器raw；模板NULL框实际enabled，textarea.enabled/NULL未勾选，不能错误断言NOTNULL框disabled。

5c919f798f33472c8c42eae69af91da2新专用fixture/原sourcecc/公开pin613e4b...已健康归属。软件仅消费generatedappCnf的独立只读会话SET00，固定CAST/DATE_FORMAT/MICROSECOND/UNIX_TIMESTAMP查询已真实核以下两组，不写表/改global；publicoracle仅合同用，runtime parent重新fixedliteral核，不信磁盘proof或向UI注expected。

| 字段/SQL类型NOT NULL | baseline原文 | 精确新原文 |
|---|---|---|
| date_value DATE | 2024-02-29 | 2025-12-31 |
| datetime_value DATETIME(6) | 2024-02-29 12:34:56.000001 | 2025-12-31 23:59:58.999999 |
| timestamp_value TIMESTAMP(6) | 2024-02-29 12:34:56.123456 | 2025-12-31 23:59:58.654321 |
| time_wide TIME(6) | -25:02:03.000002 | 49:03:04.999998 |
| time_short TIME(6) | 01:02:03.000003 | -02:03:04.999997 |

独立literal oracle UTC/sysUTC/ac1/readOnly1，四MICROSECOND原strings baseline[1,123456,2,3]→new[999999,654321,999998,999997]；TS literal UTC epoch `1709210096.123456`→`1767225598.654321`。DATE只日期，TIME负号/超24/短小时补零及6微秒都不能改样式来洗差异。此literal结果不是typed表/GUI通过。

## 正常GUI与独立可见性

新table `gui_time_<run32>`，id INT PRIMARY KEY=1不改，其余上表5列NOT NULL。正常SQL输入依次SET SESSION time_zone='+00:00'、CREATE、INSERT baseline，normalseedcommit一次。SET沿e7f4既有业务路径，不隐藏bootstrap改GUI session。正常执行baseline witness后树打开实际表，activefalse/pending0，原typedvalues/types即使错也先publish baseline再判，不等expected来TIMEOUT。

固定witness正常SQL共12列（正id+11原string投影）：CONNECTION_ID AS connection_id，@@session.time_zone AS session_timezone，CAST(date_value AS CHAR) AS date_text，DATE_FORMAT(datetime_value,'%Y-%m-%d %H:%i:%s.%f') AS datetime_text，DATE_FORMAT(timestamp_value同format) AS timestamp_text，CAST(time_wide AS CHAR) AS time_wide_text、short同，CAST(MICROSECOND(四字段) AS CHAR) AS datetime_microsecond/timestamp_microsecond/time_wide_microsecond/time_short_microsecond，以及CAST(UNIX_TIMESTAMP(timestamp_value) AS CHAR) AS timestamp_epoch；WHERE id=1，所有标识符closed/ownrun表名，不任意SQL/path RPC。只CID/计数安全parse，所有µs/日期/epoch保字符串，禁止JS Date/Number改值。

DOM actual columns固定[id,date_value,datetime_value,timestamp_value,time_wide,time_short]、1row6cells。actual td.is-null→null，其他真实textContent→string(0..64无control)，不是expected；actual表头6个small.textContent作为columnTypes，绿色[integer,date,date,date,text,text]，不是MySQL精确type的冒充。valuesSha256=SHA256(JSON.stringify({columns:<6names>,types:<actual6headerCategories>,rows:[<actual6typedvalues>]}))，不把null与文字NULL混。Witness projectionSha256同样哈希{columns:<11aliases no CID>,rows:[<11actual null|string>]}，保存actual数组与hash；主键和CID真实，不能cloneexpected当observed。

1. baseline：normalbaseline witness已读实际session00/全部baselinecanonical/positiveid，实际table row+header及UIfalse0dirty0→publish。独立fresh table11projection应baseline，I_S数据类型和FSP核，P_S sameownGUI session00/acON/txn0；只有all exact才开始edit。若DATE显示datetime/TIMEshort丢0/headerblob，保存实际baseline1ack后BASELINE_MISMATCH，不改表/开editor/SQL修值。
2. draft：五格逐个正常dblclick editor，读原textarea/raw/valueDisabled/NULL checked/nullDisabled；原raw逐字符等实际baseline值且非NULL/textareaenabled/NULLcheckboxenabled。实际originals逐项先保存，不用填expected冒原文；正常input新值/保存local，5列同dirty row1/UIfalse0。若editor差异，正常取消该未保存dialog、保先前localdraft，capture实际draft+partialoriginals/发布draft再EDITOR_VALUE_LOSS，不修改DB。正常完也capture实际draft/publish；fresh外仍baseline。此step witness为缓存的实际baseline witness，明确不是新发SQL或fresh GUI查询。
3. applied：正常apply，观真实Result/事务状态，执行同固定正常witness查询捕actualnew投影/actualid/session00；正常返回原table保draft后的typedrows+header+dirty状态→publish。UItrue/pending1/dirty0、apply oktrue/aff1、同物理id/witness精确new，fresh外仍baseline，P_S同idtxn1。失败按实际值/metadata留存，不把okfalse算SQL成功或强newhash；normalSELECT失败/缺raw为INFRA不伪造。history lastApply.inTransaction=true是过去批次，不当commit后current。
4. committed：只有应用后整个业务闸（包括正常witness全部11原strings精确new）通过才正常gridcommit。工作台正常autoReload原applied witness querytab，捕实际sameid/new投影，不主动另发executeScript冒autoReload；返回原table actualnew/header+UIfalse0dirty0→publish，fresh外此时精确new，P_S txn0，最终所有known GUIids线程COUNT0+trxCOUNT0/材料来源保持。

绿色SQL executeStatement累计4/4/5/5（SET/CREATE/INSERT/baselineSELECT/appliedSELECT），commit1/1/1/2（seed+normal），apply0/0/1/1 success0fail且lastOktrueaff1/inTxntrue/outcome1failed0errorClassnone；rollback0/fetchCellValue0/noinsert/delete APIs。normaltransactionState实际baselinefalse0/draftfalse0/appliedtrue1/committedfalse0。actions input10(5SQL+5editor)、dblclick6(tableopen1+5editor)、keydown0/click>=12。90+5总体/每step30/CLI15，elapsed含独立观察不perf/OS。

## 独立parent reference

runtime固定readonly app-role literal oracle两行先真核，不信publicproof/不向UI注原文；fixed ownrun/positiveCID、async bounded/childalive/deadline before ack。每checkpoint外fresh ownapp/observer只读session先显式SET00，读取table相同11canonical投影/rowCount1。预期外序baseline/baseline/baseline/new；缓存baseline用于expected仅为server独立真值，不注UI。applied GUI正常witness新、外old共同证内新外旧。

另每step固定readonly INFORMATION_SCHEMA.COLUMNS WHERE table_schema ownDB/table_name exactnewtable ORDER BY ordinal_position，只6rows的column_name/data_type/is_nullable/datetime_precision：id=int/date_value=date/datetime_value=datetime/timestamp_value=timestamp/time_wide=time/time_short=time，全部NO；DT/TS/两TIME precision严格6。id/DATE精度字段实际nullable值仅记录，不凭猜测要求0或NULL，它们不具有本case的fractional秒；date类型和原文只日期另核。actualI_S types不能用literalconstructor替代表真实类型。

复用独立P_S reader只payloadactualwitnessCID且ownrunDB、排observer，2namedvars time_zone/autocommit及innodb_trx/sysTZ；绿色GUI session00/acON/sysUTC，事务COUNT为0/0/1/0。3个以内known ids去重（draft沿baseline实际缓存，无新witness），所有ownCLI/oracle/readers先settled收取，再final每id threadsCOUNT0与trxCOUNT0；无id且baseline前失败只能INFRA，不复用text无id豁免。不读取其它sessions/global隐私/新grant或隐藏业务read。旧805/1/2/0+11/9及initial六来源材料/SOURCE23全保。

## 有限bridge/schema与原始失败保真

phase grid-time；methods mysqlAcceptanceTimeCheckpoint/Continue；sameNS/root/private datastore、mainorigin/bundledlocal/probe/phase/initial-onlypassword gate在文件和秘密前；旧trace19及所有旧phase格式保。ownPID闭合 `time-checkpoint-<pid>-<step>.json`/`time-ack-...`，pub16K/ack2K，复用wxpending+sync600/singlelink/nosymlink/canonical/openFD identity/经核ABS源目标且dest不存在唯一writer rename；不delete/覆已有文件/任意pathSQL。四step同payload幂等，前acktrue才下一步，false不推进。

request exact8{schemaVersion:1,step,uiActive:boolean,uiPendingAffected:int0..1000,dirtyRows:int0..1000,valuesSha256:64lowerhex,witnessConnectionId:positiveSafeInteger,witnessProjectionSha256:64lowerhex}。baseline hardfalse0dirty0但两hash可bad不等expected；其他widebounds保badstate/partialdirty/hash/id实际。wrapper6{schemaVersion,runId,phase,pid,report,observations}，ack7{schemaVersion,runId,phase,pid,step,proof:<8完全同值>,verified:boolean}，Continue args2 schemaVersion/step return2 ready/verified。acktrue只是independent记录结束，不等业务通过。

onlynewphase snapshot `temporal` exact2{lastApplyResult:null|{ok,affected,inTransaction,outcomeCount,failedOutcomeCount,errorClass},lastObservedTransactionState:null|{active,pendingAffected}}，normalAPI真正Result成功/Okfalse按actual6safe标量或成功TXstate后bestEffort，不新businesscall，不存SQL/错误正文，方法Err不当success。四cachedNative都保actual，NONE才严格4/4/5/5与commit1/1/1/2/apply0/0/1/1和stateFalseFalseTrueFalse；negative不强aff1/success/none/currentfalse才存红。

UI report原9keys/schemaVersion runId phase actionDriver checks proof actions elapsedMs failureCode，actionDriver native-dom-synthetic/16K，actions4 int0..10000/elapsed0..3600000。checks exact16：storage_marker,persisted_connection,credential_reconnect,fixture_created,session_utc_verified,table_open,baseline_exact,editor_raw_exact,local_edits,apply_succeeded,uncommitted_transaction,same_session_witness,normal_commit,reloaded_exact_values,transaction_ended,temporal_types。

proof null或exact4{rowCount:1,columnCount:5,editorOriginals:<5项null|editor>,stages:{baseline:null|stage,draft:null|stage,applied:null|stage,committed:null|stage}}；有proof必须baseline非null。editor exact4{raw:string0..64无control,isNull:boolean,valueDisabled:boolean,nullDisabled:boolean}，null代表未观察；绿色五项raw分别等baseline[1..5]/isNullfalse/valueDisabledfalse/nullDisabledfalse。stage exact9{values:<6 null|string>,columnTypes:<6 string>,valuesSha256,witnessConnectionId,witnessProjection:<11 null|string>,witnessProjectionSha256,uiActive,uiPendingAffected,dirtyRows}；idpositiveSafe，str0..64无control，category接受ResultValueType闭集以留blob/unknown错误，types/values组合SHA与witness投影SHA均由DOM按actual数组生成、Node parent独立重算并核原pub/ack/proof；host沿旧模式校验hex/字段对应/NONE逐值arrays-types及native缓存，不增SHA依赖或自实现算法。witnessProjection[0]是实际sessionTZ，其他即正常SQL原文，draft明确缓存baseline。NONE四stage非null且headers/rowstrings逐值精确/hash同/5orig准确/sameid/session00/µs11projectionbaselinebaseline-new-new/UIstate精确。校验失败时不得将observed改成expected。

failure exact17 NONE/ISOLATION/CONNECTION/FIXTURE_OPEN/SESSION_UTC_FAILED/TABLE_OPEN/BASELINE_MISMATCH/EDITOR_VALUE_LOSS/DIRTY_VALUES_MISMATCH/APPLY_REJECTED/TRANSACTION_STALE/WITNESS_FAILED/COMMIT_FAILED/RELOADED_VALUES_MISMATCH/CHECKPOINT/TIMEOUT/NATIVE_BRIDGE。

NONE：16checks真/四cp+confirmed/原pub/ack和proof逐项相等/4cachedactualnative门槛及当前finalstate/hash+row+header/dialog/witness/independentSQLI_S_P_S每时全部符合，childexit0无Timeout/全knownid结束/observer与材料SOURCE23保持。

known baseline-red特殊1ack：仅BASELINE_MISMATCH，baseline实际6values或headerKinds与独立canonicalexpected/types有明确逐字段差异；两hash必须按actualproof重算且原cp=ack/proof逐项对应；normalbaselineWitness真值等independent baseline11projection/CIDP_SownDB/session00acON/trx0，I_S六真实类型/FSP符合；nativeexec4success0fail/commitseed1/applyrollbackfetch0/lastactualfalse0；childnormalexit1/notimeout/最终该GUI线程trx0/素材来源全齐。允许三疑点实际wrong DATE/time短串/headerblob，不强正确baselineSHA来洗成INFRA。

其它known-red 2..4ack需actualeditor原值/typedrow/header/localdirty/lastApplyactualokfalse或方法Err/真实TX/normalWitness/commit或reload值差异具体支撑，不以falsecheck单独断因；尽量capture对应step再fail，editor错误取消未存dialog后发draftpartial、apply错误先正常witness+state发applied、commit错误保实际UI值再发committed。全部actual native/count与independent可见性对应，不强绿色5exec/commit2/aff1才能留。缺必要raw/前置连接权限/未知Schema/不可观测或收尾失败均INFRA，0ack不冒本featureknownred。部分1/2/3结束应收取消后续watchers、所有CLI settled，不等第4step timeout洗既有red；不自动修UI/发纠值SQL/强恢复。

## 分工/执行

- [ ] DOM/runner only2source，backup/read→新phase/context/types+normalSQL/5dialogs/actualtypedrows与header2hash/真实partial四FSM→parent固定oracle/ownSQLI_S_P_S/finalknownids/closed GRID_TIME_VERIFIED/KNOWN_GAP_RED/INFRA_ERROR；SOURCE23=旧22+resultset.ts，Node/types/diff与全selfjobs收后2SHAfreeze；不DBGUI/Cargo/privateconfig/env/log/业务产品/旧profile重构。
- [ ] host/lib/build only3source，backup/read→同safeorigin与request/ack/FSM/NONE3层及onlytemporal actual2metadata，baseline1ack真bad保/partialother保；旧105names完整+必要新mysql_host_time_准确N/SOURCE23同步，Node/static/diff/selfjobs全收3SHAfreeze；不CargoDBGUI/产品/旧trace字段格式改。
- [ ] Lead：合同D2/源两组D2无阻断→唯一offline locked Cargo2 fresh build新5c91 initial6材料+actualgridtime；原e7f4业务先真实运行，主流程原始JSON数量4+2×实际ack数（baseline一ack为6），全部保留/dataD2及allrelatedjobs停收许可后最小对应driverfix，不预修；再新candidate/newrun green+当前10profiles必要回归、3driverSESSIONparser保/新增时间回归单列，正式39标记2JS剔除frontendonly，最终data-docD2后交付。

本组仅UTC单行五typed字段正例，TIME/DATE raw显示与类型类别无formatter自由改写。真实TS行跨+08/恢复/DST、zeroDate、invalid/nullable/readonlymode/activeTXSET、更多日期范围/键/多行，以及全部types/objects/transfer/compare/ER/fullrecovery/refapps/TLS8.4WinOSsoak/crosscred仍保task84/78/wholeGoal active；无Git提交/推送/tag/正式发布。
