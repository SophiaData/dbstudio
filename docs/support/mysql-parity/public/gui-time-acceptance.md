<!--
公开脱敏副本，原文保留本地；原始SHA256=534a594da69081cc635966af412f73a98d9cd89aa96e2cea0536866ad1260d2c，本文件不是原始字节证据。
原文相对路径：docs/support/mysql-parity/gui-time-acceptance.md
本副本仅做本机路径脱敏与链接重写；任务结论、表格、RED/GREEN 判定与限界与原文一致，未新增或洗白任何结论。
-->
# UTC五字段时间网格：真实红例与最小修复

本切片已实际确认两处原文问题：DATE被显示为带午夜的DATETIME，短小时TIME缺前导零。独立SQL、I_S和P_S均正确；header类别实际全部正确，不支持修复metadata。红例原始数据D2已无阻断。driver最小DATE/TIME格式修复的12项单测真实通过、源D2无阻断；真实UTC五字段GUI编辑/提交已在UTC五正例run `dd2a16a1`实跑通过（initial链与grid-time链均绿），但9项回归profiles已实跑全绿（9/9 Native exit0、无stderr、无超时、checks全true），跨时区/零值/DST/只读/活动事务等完整矩阵仍未验。新阶段为test-only set静态观测（host189 / builder071），E0382新增测试的root所有权编译错误已由root.clone唯一8byte修正：116 pure pass对应全新9f09 build（7阶段0 / actual116 / source23），新增2个pure测试后全新CB build actual118==expected（7阶段0 / source23）——两次新build仍只是构建期证据，driver 12与host计数不可加总，也不声称旧候选全12 native重跑。48a263fd与72cd873a两次run的initial均以keyring Sets0失败（UI 6 true、joint false），48归档v3与72归档已落盘、72归档独立DataD2已完成、无阻断——这两次历史run无initial完整绿色。dd2a16a1已取得initial完整绿色（UI 6 true / keyring Gets4 Hits4 Sets1 / joint chain true）与grid-time VERIFIED，其它9 profiles亦已全部执行并通过（9/9 Native exit0、无stderr、无超时、checks全true），所有Gate原样。

本组为时间总task84的第一typed正例task89；未完成跨zone实际TIMESTAMP行、zero/nullable/invalid/DST/只读模式/活动事务等完整矩阵。遵循[时间合同](./gui-time-contract.md)，所有literal明确+00:00，采用真实Tauri DOM→Rust→MySQL8.0.46；输入为native-dom-synthetic，不是OS可信输入。

## 原业务实际红例

run `5c919f798f33472c8c42eae69af91da2`，PID4227，连接5459。原业务driver SHA `e7f4ff301cbc8af22a10e1e1ae348a513652f33f572a37ed019e331c5506a4b2`，保留上组SESSIONoffset修复、未预修DATE/TIME。新114构建回执（原始材料仅本地保留（见原SHA索引））全阶段0/23直接来源，114=旧105+9时间宿主纯测试；binary `9125ad7781a4634122edbce238b2bfa6e9839eb87f3ceac52bcb99686b31d9cd`，receipt `d333c5e2afd62b10a266e942fe594ca64ded8d3034f2afa8682d8bc0825d9e84`。initial链0后正常SET00/CREATE/INSERT/seedcommit/正常12列witness→树打开typed表。

| 项目 | typed网格实际 | 正常SQL与独立fresh表 | 结论 |
|---|---|---|---|
| DATE | 2024-02-29 00:00:00.000000 | 2024-02-29 | 多出午夜，原文错误 |
| DATETIME(6) | 2024-02-29 12:34:56.000001 | 同左 | 保持1微秒，正确 |
| TIMESTAMP(6) | 2024-02-29 12:34:56.123456 | 同左 | UTC与微秒正确 |
| 宽负TIME(6) | -25:02:03.000002 | 同左 | 负号/跨日/微秒正确 |
| 短TIME(6) | 1:02:03.000003 | 01:02:03.000003 | 缺小时前导0 |
| visible header类别 | integer/date/date/date/text/text | I_S实际int/date/datetime/timestamp/time/time | 类别全部符合，不能扩大修复 |

I_S六列均NOT NULL，DT/TS/两TIME FSP6，id/DATE实际precision null被记录而未凭猜测要求值。正常GUI11原string投影与fresh外部相同，µs[1,123456,2,3]、UTC epoch1709210096.123456；投影SHA `3083600ae4be6cf75a250702dfc38bfb0d75e1c237c709697e7c1f51f20c35d6`。typed实际值+types复合SHA `e6b576e95bd8974239a190168853000b0ab208d2068e9c73e07bd907fee840ba`，1checkpoint/ack与actualproof逐项对应；P_S own5459/ownDB session00/sysUTC/autocommitON/事务0。

baseline先发布实际错误值才BASELINE_MISMATCH停止，5editorOriginals均null、draft/applied/committed均null。Native execute4success0failure/seedcommit1/no apply/rollback/fetch/currentfalse0/lastApplynull，未把诊断SQL替代真实编辑。child正常exit1、无超时/stdout/stderr，progressPARTIAL_UI_FAILURE而不是TIMEOUT；4input13click1dbl0key/1892ms含独立观察，非性能数据。最终known5459 threadCOUNT0/事务COUNT0，外表baseline、805/1/2/0+precision11/paging9、initial六来源材料与23source保持。

红例摘要（原始材料仅本地保留（见原SHA索引）） SHA `959b8977ec456501043431efac13da29096721ea41bfe0207f29ef782a96710c`，原始联合回执（原始材料仅本地保留（见原SHA索引）） SHA `0d1bebdad3103fce8ff591b9ab0617d35cfb0f4da249839354c2cf4a65e9cc3b`。6份原始JSON不可覆盖归档，旧实例/表/binary/raw保持。data独立RO D2 no blocking，明确KNOWN_GAP_RED/BASELINE_MISMATCH，不是权限/seed/观测INFRA。

归档脚本第一次错误要求值与类别同时不同，在文件复制前断言停止。实际原数据明确2项值差异、0项类别差异；纠正归档断言后复制同6原始文件。未重跑GUI、改harness、改变epoch或把已有正确类别制造为产品bug。

## 根因与验证顺序

[MySQL驱动](../../../../crates/dbstudio-drivers/src/mysql.rs)原MValue::Date统一拼datetime6，未根据DATE列区分纯日期；TIME总小时直接拼数字，没有最小两位补零。相同通路的DT/TS六微秒与负25h已正确，结合原生typed/正常CAST SQL/独立DB边界，根因在Rust cell格式化。

全部相关构建、GUI、CLI、作者自检与复核任务结束收取并数据D2通过后，先备份原e7f4，再只该文件加入两项直接cell回归；先期待两项失败、原3项SESSION parser继续通过，收取后才最小格式化修复。仅根据DATE列输出YYYY-MM-DD、其他DT/TS仍六µs；TIME总小时min2位，保负号/天数/六µs。类别映射、SESSION控制、core/WB/Grid/fixture/ResultValueType/五harness/23source列表/依赖一律不改。该修复已实际完成：cargo mysql::过滤实际12=7旧MysqlNative+3SESSION parser+2时间（不是只5），首轮10pass2新fail/exit101，unit-red-verified-report（原始材料仅本地保留（见原SHA索引））仅校正实际名单未重跑（原汇总器误预计5且把Cargo最终test failed句误当compiler错误，原报告保留）；之后仅DATE按MYSQL_TYPE_DATE输出纯日期、其他DT/TS六µs保持（exactDate test 1pass），再TIME总小时min2位保负号/天数/六µs，最终12PASS0/`c77fc4b33d6ee2f600d41621e298ab9ec4fb40dad553ddf3ccafcc8122b9c894`，unit-green-report（原始材料仅本地保留（见原SHA索引）），既有7/3回归全过。只[mysql.rs](../../../../crates/dbstudio-drivers/src/mysql.rs)两fmt分支+2测试，metadata/harness5及SOURCE23旧22+ResultSet/其它business不动；sourceUnchanged:true指每次测试命令执行前后source无变化，不代表不同修复阶段driver SHA相同；sourceRO D2原connection及独立另一模型均noBlock。

## 修复后绿色及回归

当前状态：driver最小DATE/TIME格式修复的12项单测真实通过（7旧MysqlNative + 3 SESSION parser + 2时间；属driver单测层，不与host计数加总，也不声称旧候选全12 native重跑）；真实UTC五字段GUI编辑/提交已在UTC五正例run `dd2a16a1`实跑通过（initial链+grid-time链），9项回归profiles已实跑全绿（直接使用已审过的 runner CLI 执行，未执行 acceptance-regression-dd2-runner.mjs）。绿的标准仍是原合同：五editor原文/本地五列修改同dirty1/apply true aff1内新外旧/同连接完整11原文witness通过才normalcommit/原querytabautoReload与table精确新、外fresh旧旧旧新/最后GUI线程事务0，正负跨日/短小时/DATE只日期/DT-TS微秒必须全过；114宿主与驱动回归分层，新候选需要当前10既有profiles相关回归（加grid-time共11阶段），原计划的“仅driver对照”现按代记录。定位凭据持久化失败的test-only静态阶段轨迹已落地：静态观测host189 / builder071（23名集合保留），test host的typed downcast只读取code()、不format错误载荷，新增canonical i32 stage仍为4 keys / 128 / 32K、仅initial、不进入frontendStages，原8 class / sets真实成功+1 / snapshot 10 keys / 门槛>=1不变；E0382新增测试曾触发root所有权编译错误，已由root.clone唯一8byte改动修正，F1预算尾部顺序调整为先staticfailed再numeric、仅1行。构建期证据依次为：上一7870 candidate未形成report且三进程匹配均rc1无PID；旧114（b2fd回执（原始材料仅本地保留（见原SHA索引）） binary `9125ad77…` receipt `d333c5e2…`）与新114（7238回执（原始材料仅本地保留（见原SHA索引）） binary `6ca9799e…` receipt `03b7ab44…`）均为actual==expected、7阶段全0、source freeze不变，两者都只是构建期证据；当前代为9f09构建回执（原始材料仅本地保留（见原SHA索引））（7阶段0/actual116/source23/receipt `07bc83b4…`/binary `773bcdb9…`）与新增2个pure测试后的CB构建回执（原始材料仅本地保留（见原SHA索引））（actual118==expected/7阶段0/source23/14 input pins前后一致/receipt `cdc82a0f…`/binary `1d077d04…`）；9f→CB实测4 changed（appCargo/lock/host/builder）/ 19 same，不套用更早scope计数。以上仍只是构建期证据；dd2a16a1已在该CB候选上取得initial完整绿色与grid-time VERIFIED（见下节），keyringSets>=1门槛不下调。SF侧：Mac mysql-acceptance仅作optional直依Sf=3.7.0（defaultfeatures false），lock仅desktop→Sf边版本与checksum不变、非prod新feature不激活直连边；Sf本就经Keyring传递依赖，不能称生产无Sf。

| initial run | UI checks | keyring | joint / native | 归档 |
|---|---|---|---|---|
| `39706ad4` | 6 true / failure NONE | Gets4 Hits0 Sets0 | joint false `JOINT_VALIDATION_FAILED`；native exit0、stdout0、stderr13983、无超时 | v2归档（原始材料仅本地保留（见原SHA索引）） SHA `8ab311fd…`（旧v2证据保持） |
| `48a263fd` | 6 true | Gets4 Hits0 Sets0 | joint false `JOINT_VALIDATION_FAILED`；native exit0、stderr13983 bytes无body、无timegrid | v3归档（原始材料仅本地保留（见原SHA索引）） SHA `9cce5c64…` |
| `72cd873a` | 6 true；所有native方法failure0 | Gets4 Hits0 Sets0 | joint false JOINT；native exit0、无超时、stderr13965仅字节数、elapsed492ms | 归档（原始材料仅本地保留（见原SHA索引）） SHA `2c144152…`（独立DataD2无阻断） |
| `dd2a16a1` | initial 6 true / failure NONE；grid-time 16/16 true | Gets4 Hits4 Sets1 | initial chain true（INITIAL_CHAIN_VERIFIED）；grid-time chain true / classification VERIFIED / failureCode NONE；native exit0、无超时、stdout/stderr 0 bytes | 归档摘要（原始材料仅本地保留（见原SHA索引）） SHA `1f7ffa0b…`（含raw joint（原始材料仅本地保留（见原SHA索引）） SHA `3a6d2faf…`，独立DataD2无阻断） |

48a263fd run的initial实际：UI 6 checks全true、无failure，keyring Gets4 / Hits0 / Sets0，joint chain false / JOINT_VALIDATION_FAILED，native exit0、stderr13983 bytes且无body，无timegrid；53 row trace中seq 23 enter → 24 failed / password_write_platform_failure，具体OSStatus当时未知。v3归档（原始材料仅本地保留（见原SHA索引）） SHA `9cce5c64…`，附joint（原始材料仅本地保留（见原SHA索引））、ui（原始材料仅本地保留（见原SHA索引））、trace（原始材料仅本地保留（见原SHA索引）） raw byte copy，原raw3与v1/v2全保；DataD2旧结论noBlocking，F5由真实map比较纠错。72cd873a run为真实新initial（不是复跑48/397）：先`--check-only`得SOURCE_ARTIFACT_VERIFIED、launchPerformed false，再唯一一次`--run`；UI 6 true、所有native方法failure0、keyring Gets4 / Hits0 / Sets0、elapsed492ms，joint false JOINT、native exit0、无超时、stderr13965仅字节数；54 row / 3934B四字段trace中writer PID 6175（初始lifecycle无PID，非Node CLI pid），seq 23 enter → 24 failed / password_write_platform_failure → 25 platform_osstatus / `100001`，源trace SHA `b822b65a…`。72归档（原始材料仅本地保留（见原SHA索引）） SHA `2c144152…`，附joint（原始材料仅本地保留（见原SHA索引））、ui（原始材料仅本地保留（见原SHA索引））、trace（原始材料仅本地保留（见原SHA索引）） raw byte copy全保；其独立DataD2已完成且无阻断；这仅是归档事实复核，不代表初始链或时间网格通过。来源对比sourceDiff e7→9f09（原始材料仅本地保留（见原SHA索引）） SHA `4a5d5026…`：LeafSource count 23含builder，实际为driver + host + builder共3 changed / 20 same，两份receipt同scope同keys——绝不是2/21，也不是builder outside，更不是22 scope；Source D2独立复核006 noBlocking。
数值含义有public证：[Apple QA1499](https://developer.apple.com/library/archive/qa/qa1499/_index.html)说明UNIX errno + 100000，故100001 = EPERM(1)；本机纯常量调用SecCopyErrorMessageString(100001, NULL)返回UNIX [Operation not permitted]。据此只证Security framework的set_password调用路径返回EPERM，get_keychain / find / add / update具体哪条分支没有native直证，不凭源码“首次写必add”就断言callsite；也不把该错误具体归因ACL、签名、锁或DSH。当前RO helper的sandbox_check(getpid(), NULL, 0)得self 1 / parent 1，[Chromium seatbelt.cc](https://raw.githubusercontent.com/chromium/chromium/main/sandbox/mac/seatbelt.cc)明说1 = Sandboxed（原actor反向解释已拒绝）；这是当前helper的观察，不是已退出6175的state，也不能单凭它归因EPERM；artifact静态AppSandbox / keychainAccessGroups entitlements缺省，不代表运行时无Sandbox。机制侧：Core既有`let _ = secret.set`吞错与临时内存缓存允许当次真连；UI实际workbench 445 add → 446 select → 447 refresh，App 169已有selectedConnection.secretStored=false警告“密码未保存，请编辑连接重新录入”，因此既不能把“数据库已连接”等同密码保存成功，也不能写成完全无可见告警；未采只读plan把既有已测memoryOnly契约一刀切硬失败，Core/UI未改。持久化成功仍须真实write成功通过，不以file fallback或手填Keychain换绿。本次未修改OS权限 / 信任 / 签名 / 锁 / HOME，未手工Keychain写或delete，未重跑既有initialRoot，环境未清。

## 当前绿色切片：UTC五正例 dd2a16a1

run `dd2a16a1c20142bc97b999ac395c0c1c`，helper 顺序为 checkonly → `--run` → `--run-grid-time`：checkonly 纯context检查、raw 0 输出、OS/sandbox/签名/HOME 未改；`--run` 得 INITIAL_CHAIN_VERIFIED（chainPassed=true，productionReady=false），`--run-grid-time` 得 GRID_TIME_VERIFIED（classification=VERIFIED，failureCode=NONE）。主会话已实际授权调度（用户明确许可 Lead 临时仅执行已审脚本），parent job bash8d92completed0。本次沿用同一 CB 候选：artifact receipt `cdc82a0f…`、binary `1d077d04…`、source 23 keys 全保、14 pins 前后一致、fresh build actual 118 == expected、7 阶段全 0。

初链：UI 6 checks 全 true、keyring Gets4 / Hits4 / Sets1、joint chain true（不再是 397/48/72 的 Sets0 失败），native exit 0、无超时、stdout/stderr 0 bytes。

grid-time：16/16 checks 全 true；5 个 editor 原值原样——`2024-02-29` / `2024-02-29 12:34:56.000001` / `2024-02-29 12:34:56.123456` / `-25:02:03.000002` / `01:02:03.000003`，即 DATE 纯日期与 TIME 短小时补零已在真实 GUI 生效；四阶段 baseline→draft→applied→committed 各有 checkpoint/ack，4 组 ack proof 与 checkpoint 报告逐项一致。

| 阶段 | 同连接 witness（连接 32） | dirty | apply | native exec / commit | 当前事务 |
|---|---|---|---|---|---|
| baseline | OLD `3083600a…` | 0 | 0 | 4 / 1 | 0 |
| draft | OLD `3083600a…` | 1 | 0 | 4 / 1 | 0 |
| applied | NEW `7585d854…` | 0（pendingAffected 1） | 1 | 5 / 1 | 1 |
| committed | NEW `7585d854…` | 0 | 1 | 5 / 2 | 0 |

值层面：微秒 1 / 123456 / 2 / 3 → 999999 / 654321 / 999998 / 999997，epoch 1709210096.123456 → 1767225598.654321；apply ok=true / affected=1，normal commit 成功并 autoReload；同连接 witness 为 OLD/OLD/NEW/NEW，独立 observer 读回为 OLD/OLD/OLD/NEW，两者不可混；I_S 六列类型与 FSP6 一致，session +00:00 / systemTimezone UTC / autocommit ON / owned DB；收尾 known thread 0 / 事务 0 / ended。

归档：初始 raw 2 件 + time raw 10 件共 12 件已落盘于归档目录（原始材料仅本地保留（见原SHA索引））；archive-summary.json（原始材料仅本地保留（见原SHA索引）） SHA `1f7ffa0b…`，raw joint（原始材料仅本地保留（见原SHA索引）） SHA `3a6d2faf…`。独立 Data D2 复核已 noBlocking：原值 hash、11 项 witness hash、8 项 ack proof、6 项 provenance 与 source 23 映射全部重算一致。

唯一非阻断项：旧 summary 中 F1 的 assertion 105 标签写作 `'(witness)'`，实际应指向 external observer；数据本身没有混。该标签已在新的回归总汇 summary 的 `corrections` 中按原始数据指明（本地 grid 投影 OLD/NEW/NEW/NEW，同连接 32 witness 投影 OLD/OLD/NEW/NEW，外部 observer 投影 OLD/OLD/OLD/NEW），旧 archive-summary.json 与 21 件 raw 字节一律未改。

边界：本次仍非完整 Temporal 类型矩阵、非生产就绪（productionReady=false）、非 OS 可信键盘输入（actionDriver=native-dom-synthetic）、非跨构建凭据、非跨时区/DST/零值/null/invalid/只读/活动事务矩阵；72 的 EPERM 100001（[Apple QA1499](https://developer.apple.com/library/archive/qa/qa1499/_index.html)）与本次同 binary、不同 owned run/context 的成功只能作为对照，不能据此反推唯一 kernel 原因。

正式flags证明（原始材料仅本地保留（见原SHA索引））：39个测试标记在2JS全部剔除/flags0/envFilefalse/来源未变，frontend-only，无正式包/发布或OS/性能证明。

## 回归总汇：9 项 profiles 与新 summary

9 项回归 profiles（session/text/precision/duplicate/deadlock/timeout/restart-attempt/explain/commit）已实际执行并全部通过，执行路径为直接使用已审过的 runner CLI，**未执行 acceptance-regression-dd2-runner.mjs**；独立 59c 审查结果至今未回，既不视为已过、也不视为仍阻断。

| 阶段 | checks | Native exit | stderr | timeout |
|---|---|---|---|---|
| session-timezone | 10 | 0 | 0 字节 | 否 |
| grid-text | 19 | 0 | 0 字节 | 否 |
| grid-precision | 15 | 0 | 0 字节 | 否 |
| grid-duplicate（1062） | 14 | 0 | 0 字节 | 否 |
| grid-deadlock（1213） | 14 | 0 | 0 字节 | 否 |
| grid-timeout（OFF5→1205） | 16 | 0 | 0 字节 | 否 |
| restart-attempt | 9 | 0 | 0 字节 | 否 |
| explain | 9 | 0 | 0 字节 | 否 |
| commit | 12 | 0 | 0 字节 | 否 |

initial（6）与 grid-time（16）见上节，不在此重复正文。

汇总口径：11 个 phase 共 140 项 checks（6+16+10+19+15+14+14+16+9+9+12），全部为既有 profile 合同之和，**不是 140 项不同能力**；归档 21 件 raw（12 既有 + 9 新增）逐字节一致且源件未改，另有 2 份 summary（archive-summary.json 与 run-acceptance-summary.json）不计 raw。11 个 phase 全部 chainPassed=true、productionReady=false；10 项标量 provenance 与 23 文件 source 映射跨 phase 一致。独立复核：936 对既有 12 件与 UTC 部分 noBlock，786e5bae-081e-4f01-a71a-a92af422e594 对最终数据 noBlock。

新总汇：run-acceptance-summary.json（原始材料仅本地保留（见原SHA索引）） SHA `80236c43eca5d1c8dcf4b78b5acb9cd742cc46401f9630ec9b665de820ddec26`；该件仅更正一处 stdoutStatus 转录拼写（GRID_DUPLICITE_VERIFIED → GRID_DUPLICATE_VERIFIED，按父 job 原文）与 dataReview.added9 的复核说明，其余字节保持不变，旧 archive-summary.json 与 21 件 raw 未改。

本节边界：本组 UTC 五字段 + 9 项回归已完成，task89 可待 Lead 最后核对后收口；task84/78/67 与 wholeGoal 仍 open。不宣称 fullTemporal / fullTypes / fullRecovery、生产就绪、参考 app 实际操作、MySQL 8.4、Windows、跨构建凭据、OS 可信输入、soak 或任何性能结论。同 binary（CB118 候选，binary `1d077d04…`，source 23 全保）下 72 的 EPERM 100001 与本次成功仍只是不同 run/context 的对照，不能单凭该对照断言唯一成因；core 的 memory-only 契约与 UI 的“密码未保存”告警均未改动。真实 TIMESTAMP 跨 +08 合同由另一 actor 负责修 4 个定义，尚未实施也未验收，不能用 session 时区 literal 的 10 项 check 绿色顶替。

真实TS行跨+08/恢复、zero/nullable/invalid/DST、范围边界/只读mode/activeTX SET/命名或其它SET、其他types/键/defaultinsert/multirow、完整对象/transfer/compare/ER/full recovery、crossbuild凭据/TLSverifyfullSSH/参考apps/MySQL8.4/Windows/OS可信输入/8hsoak等继续task84/78/wholeGoal；9项回归profiles（session/text/precision/duplicate/deadlock/timeout/restart-attempt/explain/commit）已实际执行并全部通过（直接使用已审过的 runner CLI，未执行 acceptance-regression-dd2-runner.mjs；独立59c审查结果至今未回，既不视为已过、也不视为仍阻断）——task89（含9回归）已完成，待Lead最后核对后收口，task84/78/67的时间/types/recovery与wholeGoal全部open；未提交、推送、tag、发布。
