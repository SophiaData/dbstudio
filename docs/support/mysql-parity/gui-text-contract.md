# LONGTEXT完整值与JSON精确编辑提交实施计划

**Goal:** task81以真实normalGUI全文查看/编辑/应用/正常提交证明UTF8长文本尾部与JSON大整数及嵌套语义准确，部分截断预览不代全文。

**Architecture:** 新grid-text/--run-grid-text，旧profile不重构；normalDOM→既有业务invoke→Rust/MySQL，Text有限桥仅观察。全新run/table与initial产物六摘要、直接来源配对。旧19来源全部保留，新增本切片关键直接依赖CellViewer.vue/result-export.ts/network.rs共22；不是修改它们业务。先读小依赖/备份/分写/源D2后Lead统一offline locked构建与实际验收，真红保原始/数据D2/收所有jobs后才最小产品fix；原样过记支持不造fix。

**Tech Stack:** Vue3/TypeScript、Tauri2/Rust、MySQL8.0.46、Node只读投影。沿用项目mysql-parity计划位置与Team执行，不新commit/依赖/正式发布，不清理旧物。2026-11-09 Asia/Shanghai。

## 固定素材（全部合成）

```ts
const baselineLong = '长😀'.repeat(800) + '|BASE-END|'
const editedLong = '改🚀'.repeat(900) + '|EDIT-END|'
const baselineJson = '{"largeInteger":9007199254740993,"message":"你好😀","nested":{"flag":true,"items":[1,"x",null]},"padding":"' + 'J'.repeat(1200) + '"}'
const editedJson = '{"largeInteger":9007199254740995,"message":"改后🚀","nested":{"flag":false,"items":[2,"y",null]},"padding":"' + 'K'.repeat(1300) + '"}'
```

新table gui_txt_<run32>，id INT PRIMARY KEY,long_text LONGTEXT NOT NULL,json_value JSON NOT NULL，InnoDB/库继承utf8mb4。正常2条SQL创建、INSERT单行id1（输入上述长字符串和JSON完整文本），normalsetupcommit1。固定字符串无SQL单引号/backslash/TAB/换行，不需通用转义/RPC。旧805/1/2/0+precision11/paging9不改，旧精确值等新phase表也不reset。JSON的两处大整数在JS源中位于字符串内部，禁止JSON.parse JSON cell/JSON.stringify含Number对象/parseFloat/BigInt转值后重排。

LONGTEXT baseline CHAR_LENGTH=1610/OCTET_LENGTH=5610，edited=1810/6310；JS .length分别2410/2710是UTF16 units，全文以UTF8 SHA256比对，不能把codeunit计数当Unicode码点。本组不以viewer“字符”文案宣称码点计数能力。两JSON padding超过1000，初始及应用/提交后应真实截断，本地dirty inputCell全文不截断。

## 精确独立oracle与8列投影

MySQL JSON会规范化空格/键序，edited原输入全文SHA可与落库canonicalSHA不同，不能把正确规范化当丢失。parent在baseline观察时以observer受限只读固定SELECT：

```sql
SELECT CAST(CAST('<baselineJson固定字符串>' AS JSON) AS CHAR),CAST(CAST('<editedJson固定字符串>' AS JSON) AS CHAR)
```

各值只是上述固定常量的内联结果，不接受外部SQL/path。CLI只剥单终结LF后split单TAB（payload无控制字符），2个有界canonical文本用于独立SHA/正确preview prefix计算，绝不JSON.parse其大整数。缓存本attempt真实server-normalized字符串/hash，不给UI注入expected canonical/hash。正常GUI全文取到的原JSON应与实际server canonical一致，sourceCellViewer只是原textValue/readonly textarea，无formatter；任何差异先留原始，不自动修正。

正常GUI SQL witness在apply后仅一次，前缀CONNECTION_ID() AS connection_id，然后以下8列，WHERE id=1；父端fresh observer SELECT同8列但不connectionid：

```sql
CHAR_LENGTH(long_text) AS long_chars,
OCTET_LENGTH(long_text) AS long_bytes,
SHA2(long_text,256) AS long_sha256,
SHA2(CAST(json_value AS CHAR),256) AS json_sha256,
CAST(JSON_EXTRACT(json_value,'$.largeInteger') AS CHAR) AS json_large_integer,
JSON_TYPE(JSON_EXTRACT(json_value,'$.largeInteger')) AS json_integer_type,
HEX(JSON_UNQUOTE(JSON_EXTRACT(json_value,'$.message'))) AS json_message_hex,
SHA2(CAST(json_value AS CHAR),256)=SHA2(CAST(CAST('<editedJson固定字符串>' AS JSON) AS CHAR),256) AS json_exact_match
```

projection规范化{columns:[long_chars,long_bytes,long_sha256,json_sha256,json_large_integer,json_integer_type,json_message_hex,json_exact_match],rows:[8原始strings]}→SHA256(JSON.stringify)。整数column虽安全也按原strings采集；onlyCONNECTION_ID parse positiveSafeInteger。旧值整数9007199254740993/new9007199254740995，本组JSON正整数字面量的JSON_TYPE严格为UNSIGNED INTEGER（8.0.46实际列、正常GUI投影hash与独立固定literal只读查询共同确认）；原INTEGER预设导致4521/20203在提交前停为INFRA，保留该事实，不将其认作产品红例或宽松允许任意类型。message实际UTF8 HEX正确。末列用与normal输入同一固定editedJson literal，normalSQL服务器侧SHA2canonical相等应baseline0/new1；normalGUI applied witness必须同时与实际viewerSHA相等且json_exact_match=1，才可正常commit。nested flag/items顺序/null/全部keys/padding1200→1300受此提交前全量校验与parent独立oracle canonical wholeSHA共同保护；不是只比部分scalar或等到commit后才发现，padding不再单独占列。SHA256相等而非受字符collation宽松规则影响的文本等号；无新JSON parser/Number化/数据校正/额外业务call/RPC或向UI注canonical期望。

full pair规范化{columns:['id','long_text_sha256','json_text_sha256'],rows:[['1',实际全文longSHA,实际全文jsonSHA]]}→SHA256(JSON.stringify)。baseline=旧long+旧canonicalJSON；draft=editedLong+编辑原compactJSON；applied/committed=editedLong+new canonicalJSON。所有observedSHA必须从当时实际readonly textarea或实际编辑textarea/normaldialog结果计算，不用constant假装observed。

## 四步正常GUI

1. baseline：savedconnection重连、normal2SQLseed/commit、树打开/idASC。对两个td采实际preview；正常点td→“查看完整值”→读取readonly[aria-label=完整单元格值].value原全文/SHA→正常关闭，保存原json全文供编辑原值比较。两值都必须strictprefix+末ellipsis且未全长；baseline全文long逐字符等fixed旧值、JSON原文含不带引号9007199254740993数字词法。发布baseline；parentfresh8投影精确旧值、canon oracle/pair/prefix全部核对。
2. draft：两个正常dblclick editor，await真实fetch，textarea原值逐字符等步骤1完整值且未disabled/NULL未checked；normalinput新long及compactJSON、normal保存。原表两dirty字段合并1行/UIfalse0；再两个normal全文viewer（读本地full值，不fetch）确认exact输入与尾部。draft值不能变成带ellipsis的旧prefix或JSON大整数Number近似。发布draft；fresh仍旧且nativeapply0。
3. applied：normal应用，应actualOktrueaffected1，dirty0/UItrue1；page两preview重新截断。两个normal完整viewer真实新全文，long exact、JSON大整数新数字词法保留；normal执行9列witness、存querytabDOMref/id/8投影hash，返回原table。发布applied；parentfresh仍旧，rawviewer fullsha/正常witness sha对应new expected canon、native真实state及calls齐。只有前述全部精确才允许normalcommit，不错误commit/重置值过测。
4. committed：normal点击原表提交，actualcommit2/UIfalse0。原表两个normal完整viewer真实新全文与applied canonicalSHA相同；正常切保存querytab，其normal工作台自动reload应sameid/new8projection；回table/dirty0/false0。发布committed，外部fresh此时才精确新；final独立该GUItrxCOUNT0/原素材/来源材料/正常exit0才green。

normal全文viewer共8次：baseline2/draft2/applied2/committed2。normalfetchCellValue真实应baseline2/draft4/applied6/final8（draft查看已是本地全文无fetch，两个editor各fetch一次）。seedexecute2→witness后3/commit1→2/apply1/rollback0。actions input5（setup2+两edit2+witness1）、dbl3（tree1+两edit）、keydown0、click>=30。90+5秒总/step30/CLI15；全部async observer/watchdog/alive/deadline before ack/childclose部分失败取消+收所有子进程，不读日志正文/私密配置。

## 预览观测与有限桥

每对preview记录actual pair=[long,json]，各object exact3{prefixSha256:64lowerhex,prefixCodePoints:0..16000integer,ellipsis:boolean}。对actual td.textContent若末字符为…，去该末字符；否则全文即prefix；SHA/Array.from(prefix).length来自真实DOM，不硬码1000。绿色应ellipsis=true、0<prefixCodePoints<完整Unicode码点数、prefixSHA等独立对应canonical/full字符串同codepoint前缀；baseline/applied/committed各对都核。draft应wholetd等输入且无人工truncation，不用正确截断格的SHA当全文SHA。

new mysqlAcceptanceTextCheckpoint/TextContinue onlydebug/main/bundledlocal/probe/phase gate先于文件secret；phase grid-text、4steps baseline/draft/applied/committed；reuse已审fixedownPID safe wxpending+sync/600/singlelink/nolinks/canonical/openFD/ABSabsenttargetrename，无任意SQL/业务call/任意路径、不删。fixed text-checkpoint-<pid>-<step>.json/text-ack-...publish16K/ack2K，wrapper exact6{schemaVersion,runId,phase,pid,report,observations}、ack7{schemaVersion,runId,phase,pid,step,proof:<8request完全同值>,verified:boolean}，同payload幂等、前acktrue推进/false不推进。Continue args2{schemaVersion,step}/return2{ready,verified}。

request exact8{schemaVersion:1,step,uiActive:bool,uiPendingAffected:0..1000int,dirtyRows:0|1,valuesSha256:hash,witnessConnectionId:null|positiveSafeInt,witnessProjectionSha256:null|hash}。baseline硬false0dirty0witnullnull；draft/applied只typebounds准真实badstate/valuehash/nullwitness红；committed绿色false0dirty0positiveid/hash。lastApply只过去batch，当前TX另采正常业务真实返回。

onlynewphase snapshot text exact2：lastApplyResult null或exact6{ok,affected,inTransaction,outcomeCount,failedOutcomeCount,errorClass:'none'|'other'}，lastObservedTransactionState null或{active,pendingAffected}。lib真正normalApplication Result后bestEffort安全标量，不新SQL/隐藏readTX、不存outcome.sql/errorbody，旧phasefields/trace19/initial-only password metadata gate不变。baseline/draft actualapply0/exe2/commit1/lastfalse0，applied actualOktrueaff1inTxntrue outcome1fail0none/lasttrue1/exe3commit1apply1，finalexe3commit2apply1/lastfalse0/rollback0；fetch2/4/6/8成功0fail才green。

## UI final schema与真实失败分类

report exactschemaVersion/runId/phase/actionDriver:native-dom-synthetic/checks/proof/actions/elapsedMs/failureCode，16KiB。checks exact19：storage_marker,persisted_connection,credential_reconnect,fixture_created,table_open,preview_truncated,baseline_full,editor_full,local_edits,draft_full,apply_succeeded,uncommitted_transaction,applied_full,same_session_witness,normal_commit,committed_full,reloaded_exact_values,transaction_ended,json_integer_exact。

proof null或exact24：rowCount:1,editedColumns:2,baselineLongSha256,baselineJsonSha256,draftLongSha256:null|hash,draftJsonSha256:null|hash,appliedLongSha256:null|hash,appliedJsonSha256:null|hash,committedLongSha256:null|hash,committedJsonSha256:null|hash,baselineValuesSha256,draftValuesSha256:null|hash,appliedValuesSha256:null|hash,committedValuesSha256:null|hash,uncommittedProjectionSha256:null|hash,committedProjectionSha256:null|hash,witnessConnectionId:null|positiveSafeInt,uiActiveAfterApply:null|bool,uiPendingAffectedAfterApply:null|0..1000int,dirtyRowsBeforeApply:null|0|1,dirtyRowsAfterApply:null|0|1,baselinePreview:<actual pair>,appliedPreview:null|pair,committedPreview:null|pair。pair schema见上，badprefix/hash/state保真不强迫成功值才存。action4keys click/input/keydown/dblclick为0..10000int，elapsed0..3600000含observer非性能。

failure exact18 NONE/ISOLATION/CONNECTION/SETUP/TREE/FULL_VALUE/EDIT/CHECKPOINT/BASELINE_MISMATCH/VALUE_LOSS/JSON_LOSS/PREVIEW/APPLY_FAILED/TRANSACTION_LOST/WITNESS_FAILED/COMMIT_FAILED/TIMEOUT/NATIVE_BRIDGE。

NONE须19checks/完整24proof/4confirmed+4cp实际fullpairhash对应proof/8投影sameid/JSON canonical完整与UNSIGNED INTEGER精确/preview3对严格prefix/dirty1false0→applytrue1dirty0→normalcommitfalse0、fetch2/4/6/8与准确native/外oldoldoldnew-finalnew+TXended/source22+initial6材料/8051/2/0+11/9/正常exit0，productionReady=false。不能将checked ack当passed。

失败partial1/2/3或4confirmed可原样finalreport/normalexit1；后step watcher在ownchildclose收取消，不洗成timeout。known-red必须原始actualviewerSHA或prefix/JSON投影/native失败真的偏离期望并与checkpoint/proof/phase/calls对应、独立fresh已知实际值/素材来源齐、正常childexit1/noTimeout和独立结束证明；仅失败code、缺字段或未知根因/收尾为INFRA。1ack仅基线read/prefix/JSON真实差异（BASELINE_MISMATCH/PREVIEW/JSON_LOSS/FULL_VALUE）可依上述证据，不放宽旧precision一ack规则。parent负分支按实际calls保真，不能复用green的textNativePassed来强迫baseline2次成功fetch，也不设负分支最低成功fetch数；错误truncated=false导致normalViewer跳过fetch、但已用实际全文pair/prefix与独立fresh/canonical证实偏差的0/1次场景仍可known-red。负baseline仍保connect/execute2commit1apply0rollback0/lastactualfalse0/keyring/schema/actualDifference与上述完整独立收尾门槛；green的2/4/6/8成功0失败保持严格。原生存失败报告不自行判knownred。

有GUIid严格byid事务COUNT0；早期无id先收全部ownedCLI/live/observer，再限定本run默认db其他foreground排CONNECTION_ID0/innodb_trx JOINthreads同db排观察者0/本db本gui_txt表data_locks0的fresh三zero、normalexit1/noTimeout，scope=owned-db-no-known-id，不以表无锁冒GUI事务；固定GUI db_name=本库/无USE/actors/sourcepin。已提交错误值据实留存不自动reset，真红Lead先归档D2，收所有jobs再最小fix。

## 文件与执行步骤

- [ ] DOM/runner组只改apps/desktop/src/mysql-parity-dom.ts、scripts/mysql-ui-acceptance.mjs：备份→实现上述normalview8/edit2/normalwitness/4FSM-parent/read-onlycanon+8projection/负分支→Node语法及vue-tsc→稳定两SHA/所有自jobs已收后freeze。runner SOURCES保19追加CellViewer/result-export/network共22，无其他production改；不DB/GUI/Cargo/旧profile重构。
- [ ] host组只改src-tauri/src/mysql_acceptance.rs、src-tauri/src/lib.rs、scripts/build-mysql-acceptance.mjs：备份→new有限phase/RPC/schema/FSM/actualtext2metadata/strictNONE+actualfetchcounts/负报告保真→保旧88exactpure再必要新增准确N→build source22同步→Node静态/newtestnames与三SHA稳定、所有自jobs收后freeze。不DB/CargoGUI/业务/协议依赖改。
- [ ] Lead：备份正式剔除script+进度3doc，new专用fixture/publicpin，formalflags桥剔除Text2names；小合同/源D2无block后统一CARGO_BUILD_JOBS2/offline locked。命令node scripts/build-mysql-acceptance.mjs应全阶段0/精确测试名单全pass，newrun node scripts/mysql-ui-acceptance.mjs --run/--run-grid-text加publicpin/image/buildreport+sha，预期INITIAL_CHAIN_VERIFIED/GRID_TEXT_VERIFIED。再samecandidate precision/1062/1213/OFF-session5-1205/restart/explain/commit必要回归，按实际闭集/来源归档后data-docD2；不是9阶段全过前先宣称，测试分层不混算旧2core21model12native。

本组不验剪贴板（不读用户clipboard）、文件导出、JSON树/formatter、JSON所有范围/路径、超过本组大小、时间微秒/时区/BIT/二进制写/其他类型键/insert/多行负例。task78总矩阵保留它们，二进制源码只读缺能力不排除。保护真实配置/秘密/生产库，不delete/清旧环境/改OS策略/依赖/正式发布；freeze后tinyfix先Lead明确所有相关jobs已停收，源码与data各D2，wholegoal继续。
