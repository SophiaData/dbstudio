<!--
公开脱敏副本，原文保留本地；原始SHA256=4153edc58da5ae883a1e4339dda4af8b07f6de15e8fabcee95e04839e0ac628a，本文件不是原始字节证据。
原文相对路径：docs/support/mysql-parity/gui-precision-contract.md
本副本仅做本机路径脱敏与链接重写；任务结论、表格、RED/GREEN 判定与限界与原文一致，未新增或洗白任何结论。
-->
# 精确类型网格编辑与应用后提交：首组实施与验收协议

**Goal:** task78首组实证：正常GUI编辑六字段、同连接读未提交精确值/外部仍旧值、正常提交后外部精确新值；不能以旧页面或JS Number比较替代服务器。

**Architecture:** Tauri Vue正常DOM→原业务invoke→Rust/MySQL，debug有限桥只观察/确认。仅新增grid-precision/CLI --run-grid-precision；新candidate、新run、新表，与initial六来源/材料配对。保留source19/旧80pure/旧profiles，产品coreb4/WB4b/driver8cf/fixturecc与既有产品测试不预改，原样过如实记；若真红先归档再最小修。

**Tech Stack:** Vue3/TypeScript、Tauri2/Rust、MySQL8.0.46、Node只读独立验收。2026-11-09 Asia/Shanghai。task78仍为精确类型总任务，首组通过不代表全部类型完成。

## 完整类型子矩阵（不删除未实现项）

| 类型/路径 | 本组 | 剩余范围 |
| --- | --- | --- |
| BIGINT UNSIGNED值 | max→max-1正向精确编辑/提交 | 全范围、NULL、作为大主键与越界负例 |
| BIGINT有符号值 | min→min+1正向精确编辑/提交 | 全范围、NULL、大主键/负例 |
| DECIMAL(65,30) | 35整数位+30小数位，正→负精确编辑/提交 | 其他scale/范围/舍入/负例 |
| UTF-8 VARCHAR | 中英文/emoji编辑/字节核对 | 排序collation/换行/NUL/特殊转义 |
| NULL↔空字符串 | 两个nullable VARCHAR双向各一列 | 文本NULL字面量/NOT NULL保护/默认值 |
| LONGTEXT/完整值 | 原首组六字段不验；后续task81固定单行UTF8全文查看/编辑/提交真实通过 | 更多大小/控制字符/Unicode截断边界、clipboard仍待验；见[task81](./gui-text-acceptance.md) |
| JSON/大整数JSON | 原首组不验；task81大整数/UTF8/嵌套/wholecanonical/正常提交真实通过 | 更多路径/范围、无效JSON保护、结构化树/formatter仍待验；不将一个正例升完整类型支持 |
| DATE/DATETIME(6)/TIMESTAMP(6)/TIME(6) | 本组不验 | 微秒/负长时/时区/零日期/DST及错误输入 |
| BIT/BOOL | 本组不验 | 位宽/二进制呈现、编辑与约束 |
| BLOB/VARBINARY | 源码ResultGrid117明确只读，本组不改 | 查看HEX完整值与真实只读证据、可写能力仍缺 |
| FLOAT/DOUBLE/普通INT | 本组不验 | 有限数/科学计数/溢出/精度语义 |
| 键/多行/insert/批量 | 本组INT主键1不变、单行六字段 | 大整数键/复合键/插入、多行部分成功/大事务 |

所有“本组不验”仍是目标门槛，不得把此表缩成仅已支持的类型。参考应用实操/其他MySQL版本平台与性能稳定性仍独立开放。

## 固定表、值与独立投影

新<database>.gui_px_<run32>，InnoDB，正常2SQL创建/插入单行并正常提交，禁止修改原precision_values/805素材：

```sql
CREATE TABLE <fixed> (id INT PRIMARY KEY,unsigned_big BIGINT UNSIGNED NOT NULL,signed_big BIGINT NOT NULL,exact_decimal DECIMAL(65,30) NOT NULL,utf8_text VARCHAR(128) NOT NULL,nullable_text VARCHAR(64) NULL,empty_text VARCHAR(64) NULL) ENGINE=InnoDB;
INSERT INTO <fixed> VALUES (1,18446744073709551615,-9223372036854775808,12345678901234567890123456789012345.123456789012345678901234567890,'种子-你好-😀',NULL,'');
```

正常双击编辑、检查dialog原值/NULL状态，六列分别改为：

```
unsigned_big = "18446744073709551614"
signed_big = "-9223372036854775807"
exact_decimal = "-98765432109876543210987654321012345.987654321098765432109876543210"
utf8_text = "编辑-你好-🚀"
nullable_text = ""        // 原NULL，正常点NULL checkbox解除、空input事件、保存
empty_text = null         // 原空串，正常点NULL checkbox勾选、保存，不填值
```

只编辑已有值，不以Number/parseFloat/BigInt再格式化来比较或生成参数。编辑器四个文本原值必须逐字符准确；NULL编辑器原checkbox/textarea disabled也实际检查。每列正常保存到本地后检查原表，六列合并同一dirty行；id不改。

实际DOM规范化：columns固定[id,unsigned_big,signed_big,exact_decimal,utf8_text,nullable_text,empty_text]，rows为1x7；每格若实际td.is-null则null，否则真实cellText字符串（包括空串），hash=SHA256(JSON.stringify({columns,rows}))。不得把NULL与文字'NULL'或空串混成同一值。baselinehash来自实际初始DOM，draft/applied/committed来自各时实际DOM，不伪造expected hash当observed。

正常GUI witness SQL只有一次，在apply完成后执行：

```sql
SELECT CONNECTION_ID() AS connection_id,CAST(unsigned_big AS CHAR) AS unsigned_big,CAST(signed_big AS CHAR) AS signed_big,CAST(exact_decimal AS CHAR) AS exact_decimal,HEX(utf8_text) AS utf8_hex,nullable_text IS NULL AS nullable_is_null,HEX(COALESCE(nullable_text,'')) AS nullable_hex,empty_text IS NULL AS empty_is_null,HEX(COALESCE(empty_text,'')) AS empty_hex FROM <fixed> WHERE id=1
```

正常渲染读取9列单行、positiveSafeInteger connection_id，其余8列全部按真实字符串（NULL flags是0/1）采集。projection规范化columns=[unsigned_big,signed_big,exact_decimal,utf8_hex,nullable_is_null,nullable_hex,empty_is_null,empty_hex]、rows=1x8字符串，UTF8 HEX大写；SHA256同上。parent固定fresh readonly autocommit SELECT同8列（不connectionid）同格式核对，不读取server message/SQL_TEXT。baselineProjectionSha由实际初始DOM对应CAST字符串/UTF8字节/NULLflag映射并与fresh SQL比对；未提交/已提交projection必须来自正常GUI SQL结果，不是从旧表页推算。

## 四步正常流程

1. baseline：正常连接/seed2SQL+commit、正常树打开/id ASC，七列原值逐字符/NULL类型正确、UIfalse0/dirty0；发布baseline，parentfresh旧值核对。
2. draft：逐列正常dialog输入/NULL toggle/save，检查六字段精确新值、dirty1/UIfalse0。发布draft，parentfresh仍旧值（业务apply0/commit1）；坏hash/状态允许真实留档。然后才点击应用。
3. applied：真实apply应oktrue affected1，dirty0/UItrue1，原表精确新值；正常执行上述witness、保存新querytab DOM引用和connectionid、投影hash，再正常点回原tabletab检查hash/dirty。发布applied；parentfresh仍旧值并保存原生实际返回/状态。若真实值丢失/partial/拒绝先留观察再报产品红，不为过测改值或直接controller校正。
4. committed：只有前述精确检查通过才正常点原表“提交”，应actualcommit2/UIfalse0。正常切到步骤3保存的querytab，工作台自动重读后sameconnectionid/新精确projection，再回原table检查精确hash/dirty0。发布committed，parentfresh应新值。最终独立fresh新值/原805/1/2/0+precision11/paging9/无GUI事务与正常exit0，才green。新精确表提交结果保留，不重置/删除。

## 有限桥、文件与native

新增mysqlAcceptancePrecisionCheckpoint/mysqlAcceptancePrecisionContinue，仅debug/main/bundled-local/probe/phase gate先于文件/secret，桥不业务call、不SQL、不隐藏readTransaction。四步baseline/draft/applied/committed，前acktrue推进、相同payload幂等/异payload拒；复用已审safe wxpending/sync/600/singlelink/no links/canonical/openFD identity/expectedABS+absenttargetrename。fixed precision-checkpoint-<ownPID>-<step>.json与precision-ack-...，publish16KiB/ack2KiB，留存不删，旧FSM不重构。

checkpoint exact8：{schemaVersion:1,step,uiActive:boolean,uiPendingAffected:0..1000integer,dirtyRows:0|1,rowsSha256:64lowerhex,witnessConnectionId:null|positiveSafeInteger,witnessProjectionSha256:null|64lowerhex}。baseline硬false0/dirty0/witnessnullnull；draft/applied仅类型界限，真实wronghash/badstate/空witness可留红；committed成功false0/dirty0/witness正id/hash。wrapper exact6 {schemaVersion,runId,phase:'grid-precision',pid,report,observations}；ack exact7 {schemaVersion,runId,phase,pid,step,proof:<原8完全相等>,verified:boolean}；Continue args2{schemaVersion,step}/return2{ready,verified}，missingfalsefalse、falseack不推进。

仅该phase snapshot增加precision exact2：lastApplyResult null或exact6{ok,affected,inTransaction,outcomeCount,failedOutcomeCount,errorClass:'none'|'other'}，lastObservedTransactionState null或{active,pendingAffected}。lib在正常Application真实Result后bestEffort记安全标量，不存outcome.sql/errorbody、不新业务call；TXstate/commit/rollback只实际成功返回。baseline/draft execute2/commit1/apply0，applied execute3/commit1/applysuccess1failure0/lasttrue affected1 inTxntrue/outcome1failed0classnone/lastactualtrue1；finalcommit2/lastactualfalse0/rollback0。lastApply.inTxntrue是过去batch不是当前TX，旧phase snapshot/trace19/initial-only密码gate保持。

## 最终UI与分类

UIreport exactschemaVersion/runId/phase/actionDriver:'native-dom-synthetic'/checks/proof/actions/elapsedMs/failureCode、16KiB。checks exact15：storage_marker,persisted_connection,credential_reconnect,fixture_created,table_open,exact_baseline,editor_exact,local_edits,null_empty_distinct,apply_succeeded,uncommitted_transaction,same_session_witness,normal_commit,reloaded_exact_values,transaction_ended。

proof null或exact14：rowCount:1,editedColumns:6,baselineRowsSha256,draftRowsSha256:null|hash,appliedRowsSha256:null|hash,committedRowsSha256:null|hash,baselineProjectionSha256,uncommittedProjectionSha256:null|hash,committedProjectionSha256:null|hash,witnessConnectionId:null|positiveSafeInt,uiActiveAfterApply:null|bool,uiPendingAffectedAfterApply:null|0..1000int,dirtyRowsAfterApply:null|0|1,dirtyRowsBeforeApply:null|0|1。失败允许真实hash/state，不强迫成功常量才留档。actions exactclick/input/keydown/dblclick为0..10000int，NONE input8（setup2+值输入5+witness1）、dblclick7（tree1+六编辑）、keydown0/click>=20，elapsed0..3600000含独立等待不性能。

failure闭集16：NONE/ISOLATION/CONNECTION/SETUP/TREE/EDIT/CHECKPOINT/BASELINE_MISMATCH/VALUE_LOSS/NULL_EMPTY_LOST/APPLY_FAILED/TRANSACTION_LOST/WITNESS_FAILED/COMMIT_FAILED/TIMEOUT/NATIVE_BRIDGE。

绿色需全部15true/完整proof/witness sameid投影精确/appliedactualtrue1→finalfalse0/4confirmed/native准确calls与partial元数据/独立fresh旧→旧→旧→新、最后新值/GUI TX0/initial来源6与source19/材料/旧fixture全成立，ack仅表示完成观察不产品正确。partial2或3ack产品失败normalexit1、后续step watcher childclose可正常取消。另仅BASELINE_MISMATCH允许1ack红例：baseline独立fresh投影必须精确旧值，原始UI非空proof的baselineRowsSha256必须等于该baseline checkpoint实际rowsSha256且不同于精确旧值期望，baseline native仅execute2/commit1/apply0、最后TXfalse0，normalexit1/最终服务器TX0/fresh仍旧/来源素材保持全部成立才known-red；其他1ack失败不获此例外。若原始UI或正常SQL精确值确实丢失，保实际失败证据、已收子进程/服务器TX0及最终外部实际值再分known-red。若部分失败尚无GUI connection_id，不能仅凭本表无锁声称TX0：所有owned CLI/live/observer先收取后，独立admin限定本run默认database，计其他foreground会话（排除观察连接CONNECTION_ID自身）、innodb_trx JOINthreads同database（排除观察者）、本db本gui_px表data_locks，三者均0且正常ownchildexit1/无timeout，才用scope=owned-database-no-known-gui-id证明专用库范围结束，不冒具体GUIid。依据固定GUI db_name=本库、受控profile SQL无USE/actors与source pin；有真实GUIid时仍按该id核事务结束，绿色严格sameid不变。缺独立证据或收尾未知INFRA，不能洗红/造绿/自动reset committed值；任何真实red先Lead归档/D2再最小产品fix。

## 执行计划与责任边界

- [ ] DOM/runner组：仅apps/desktop/src/mysql-parity-dom.ts、scripts/mysql-ui-acceptance.mjs，新增正常上述流程/readonly投影/四step/最终分类，main新phase90+5/step30/CLI15全async abort/alive/deadline闸+全收。先备份，Node/types可，不DB/GUI/Cargo。
- [ ] host组：仅src-tauri/src/mysql_acceptance.rs、src-tauri/src/lib.rs、scripts/build-mysql-acceptance.mjs，新有限schema/FSM/实际metadata/必要pure，旧80精确名单全保+新增准确计数。先备份，不业务改动/DB/Cargo。
- [ ] Lead：新专用fixture/publicpin/正式桥剔除，稳定源码D2后offline locked统一build、新run initial→precision→必要旧事务/重启/计划/提交回归，归档raw/summary/类型矩阵更新/最终D2。产品source先不动；真red收所有jobs后才交最小fix。

不读真实配置/凭据/生产库，不删/清旧环境，不修改依赖/OS策略/系统信任，不正式发布。freeze后任何tinyfix先Lead明确相关jobs已停并收取。本组用固定合成字符串实际SQL，不OS可信输入或视觉/性能验收，productionReady=false。
