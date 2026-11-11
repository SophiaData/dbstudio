# 真实TIMESTAMP(6)行跨+08与恢复：最小可执行合同（未实施／未Native验收）

**Goal:** task89 UTC五字段正例（dd2 initial与gridtime真绿：16checks/4cp4ack/ownwitness旧旧新新，外旧旧旧新/epoch微秒正确）之后，补上**真实typed TIMESTAMP行**在同一Native连接上跨 `+08:00` 再恢复 `+00:00` 的显示转换；DATE/DATETIME/TIME原文不随TZ变化，epoch保持同一瞬间、微秒不丢。不以SESSION offset + literal函数冒充typed行，不用JS Date/Number改值，不用手填UI或额外诊断SELECT替代网格typed显示。

**Architecture:** 新 phase `grid-time-crosszone`，三检查点 baselineUTC / shifted+08 / restoredUTC；沿用现有有限握手（pub16K/ack2K、wx pending+fsync600+单写者rename）、现有只读P_S/observer/最终threads+trx归零模式、现有 grid-time 的 owned fixture（`gui_time_crosszone_<runId>`同构、ownrun表名、无DROP）。DOM只加一段 `runCrosszoneDom`（每step走 **raw SELECT 新TAB** 路径），host只加两个checkpoint/continue方法与temporal同口径actual快照，runner只加一个phase分支与固定TZ观察者，builder只加**实际新增**的准确测试名。

**Tech Stack:** Vue3/TypeScript/Tauri2/Rust/MySQL8.0.46官方固定image；复用既有 e7f4 SESSIONoffset通道（`mysql.rs:53-60` 白名单 + `:503-507` 不开事务分支）。无新依赖、无OS策略、无发布、无生产库、无真实配置/秘密、无删除/清理。

## 现状（最小读取结论，不预修）

- `crates/dbstudio-drivers/src/mysql.rs:503-507`：`SET SESSION time_zone = '+08:00'` 走独立分支，**不开事务、不计pending**；`:69-72` 单元格只按列类型拼原文（DATE纯日期、DT/TS六微秒、TIME总小时min2位），驱动侧**不做**任何时区换算。TIMESTAMP的墙钟值由MySQL服务端按会话TZ下发，驱动原样透传——故跨TZ的正确显示**无需改driver**，本切片driver源码冻结不改。
- `apps/desktop/src/mysql-parity-dom.ts:241-330`（runTimeDom）为四步编辑/提交正例，不含跨TZ；`:332-387`（runSessionTimezoneDom）虽为baseline/offset/restored三步，但只读`@@session.time_zone`与`CAST('...' AS DATETIME(6))`的literal epoch，**没有任何真实typed TIMESTAMP行**——这正是本切片补的缺口。其 `execute()` 辅助已按**结果TAB数量+1**等待新结果，本切片沿用该计数作为fresh证据来源。
- `scripts/mysql-ui-acceptance.mjs:1001-1024` 已提供可复用范式：`sessionTimezoneOracle`（固定会话TZ、只读）、`sessionTimezoneReference`（P_S `variables_by_thread` 按**owned CID**确认`time_zone`/`autocommit` + `innodb_trx`计数）、`sessionTimezoneEnded`（known ids threads/trx 归零，**不做任何清理动作**）。
- 已知歧义留待真实红例判定，不预判：TIME列header类别实际为`text`（binary charset落blob为待实际疑点）；本切片header类别预期沿用`integer,date,date,date,text,text`，实际不符则记actual并判`DISPLAY_TYPE_MISMATCH`，**不改metadata/期望值**。

## 期望真值（server侧与GUI侧同一瞬间）

| 字段/列类型 | baselineUTC 原文 | shifted+08 原文 | restoredUTC 原文 |
|---|---|---|---|
| id INT | 1 | 1 | 1 |
| date_value DATE | 2024-02-29 | 2024-02-29 | 2024-02-29 |
| datetime_value DATETIME(6) | 2024-02-29 12:34:56.000001 | 同左 | 同左 |
| timestamp_value TIMESTAMP(6) | 2024-02-29 12:34:56.123456 | **2024-02-29 20:34:56.123456** | 2024-02-29 12:34:56.123456 |
| time_wide TIME(6) | -25:02:03.000002 | 同左 | 同左 |
| time_short TIME(6) | 01:02:03.000003 | 同左 | 同左 |

epoch：`UNIX_TIMESTAMP(timestamp_value)` 恒为 `1709210096.123456`（会话TZ无关，服务端同一瞬间）；`MICROSECOND(timestamp_value)` 恒为 `123456`；显示串的微秒位恒为 `.123456`。全部值按**字符串**比对，禁止 JS Date / Number / epoch 毫秒化。**typed TIMESTAMP 的 epoch 三step恒为 1709210096.123456**：不得复用 session-timezone 切片的 literal+08 epoch `1709181296`，也不得由墙钟值反推。

## 三检查点流程（每步严格同序）

**Step 0 fixture（owned、只此一次）**：正常SQL依次 `SET SESSION time_zone = '+00:00'` → `CREATE TABLE <ownrun>.gui_time_crosszone_<runId>`（六列：id INT PRIMARY KEY / date_value DATE NOT NULL / datetime_value DATETIME(6) NOT NULL / timestamp_value TIMESTAMP(6) NOT NULL / time_wide TIME(6) NOT NULL / time_short TIME(6) NOT NULL）→ `INSERT ... VALUES (1,'2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 12:34:56.123456','-25:02:03.000002','01:02:03.000003')` → 一次正常提交（seed，commitTransaction=1）。fixture必须建在会话TZ=+00:00下，使存储瞬间为1709210096.123456。**此后本切片无任何行数据写、无apply、无rollback、无表DDL**。

**Step 1 baselineUTC / Step 2 shifted+08 / Step 3 restoredUTC**：每步严格按 a→b→c→d：

- **a. SET**：正常SQL `SET SESSION time_zone = '+00:00'|'+08:00'|'+00:00'`（分别对应 baseline/shifted/restored）。
- **b. witness readback（一次独立正常SQL）**：`SELECT CONNECTION_ID() AS connection_id, <11投影表达式> FROM <owned表> WHERE id=1`；结果共 **12** 列（`connection_id` + 11投影），11投影别名与顺序固定为 `session_timezone,date_text,datetime_text,timestamp_text,time_wide_text,time_short_text,datetime_microsecond,timestamp_microsecond,time_wide_microsecond,time_short_microsecond,timestamp_epoch`（投影表达式沿用既有 `CAST(... AS CHAR)` / `DATE_FORMAT(...,'%Y-%m-%d %H:%i:%s.%f')` / `MICROSECOND` / `UNIX_TIMESTAMP` 口径）。读回 sessionTZ（须为该步预期值）、CID与11个实际值（CID单独取用，**不进** witness SHA 的 rows）。
- **c. raw SELECT（另一次独立正常SQL，取显示真值）**：`SELECT id,date_value,datetime_value,timestamp_value,time_wide,time_short FROM <owned表> WHERE id=1`——**无 CAST、无 DATE_FORMAT、无任何函数包装**，直接取六typed列。
- **d. fresh 判定与读值**（全部成立才算fresh，缺一即INFRA）：
  1. 结果TAB数量确实 **+1**：`resultTabsAfter == resultTabsBefore + 1`（`resultTabsBefore` 为执行c之前的 `.result-tabs .result-tab` 计数；正常SQL每次产生一个新结果TAB，故本step取值为 5/8/11 → 6/9/12）；
  2. 该新增TAB **aria-selected="true"** 且 `activeTabGeneration == resultTabsAfter`、`activeTabOwned == true`（读值必须来自这个新TAB，禁止读"当前活动网格"的隐式快照或旧TAB缓存；owned 由该TAB所属会话即本owned CID会话判定）；
  3. **normalquery 完成**：`#btn-run-sql` 可用且 `.result-grid` 非 `aria-busy="true"`；
  4. **native 执行计数增长**：DOM 侧 `nativeExecuteCount == 3 + 3×本step序号`（seed3 + 每step3，见下"原生计数"），且严格大于上一step同值；host 侧 native `executeStatement` 成功计数必须与之一致。
  条件全成立后，从该新TAB的 ResultGrid 读**六typed列原文**与**六个表头类别**（`values` 6项、`columnTypes` 6项），逐字与期望真值表比对。

**任一 fresh 条件不成立 → INFRA**（缺新TAB/不可观测归 `TABLE_OPEN`，native计数或桥不一致归 `NATIVE_BRIDGE`），**不得**记为 `DISPLAY_VALUE_MISMATCH`，也**不得**用缓存旧值凑expected或反复重试/等待到超时洗红。

显示真值**只**来自 c 的 raw typed 结果TAB；b 的 readback 投影只作会话TZ/CID/服务端不变量记录。**本切片统一走 raw SELECT 新TAB路径，不再走"树节点双击+idle即刷新"的旧路径**（旧路径不保证发起新查询，且readback SQL新tab激活后可能读错tab）。若测 editor：仅在**新TAB**上双击单元格读textarea原文后**取消**，断言对话框关闭、dirtyRows=0、网格未变，**不产生apply、不写表**。

## 独立可见性（observer与owned CID）

- 独立观察者用**自己的**连接、固定会话TZ=+00:00、同一库同一表，只读；它读到的行原文在三个step全程不变（UTC基线），epoch恒为1709210096.123456。观察者连接**不得**显示+08；显示变化若出现在观察者侧属`OBSERVER_MISMATCH`。
- P_S 只对**自有 owned CID**（来自网格readback的`CONNECTION_ID()`）确认：`variables_by_thread.time_zone` 在三步分别为`+00:00`/`+08:00`/`+00:00`、`autocommit=ON`、`innodb_trx`计数=0、`PROCESSLIST_DB`=own库、排除观察者自身`CONNECTION_ID()`。三步CID必须相同，否则`CONNECTION_CHANGED`。
- 观察者与P_S读取发生在**该step的checkpoint窗口内**（DOM等待Continue/verified后才进入下一步SET），故读到的TZ即该step真实会话TZ。
- 外DB行内容全程不变（本切片无写）；最终 known GUI CIDs：`performance_schema.threads` COUNT=0 且 `information_schema.innodb_trx` COUNT=0，**不执行任何删除/清理/断开**（只观测）。**该归零观测只在GUI子进程正常退出后采样**；子进程异常退出则不宣称归零。

## 有限bridge/schema与原始失败保真

- phase `grid-time-crosszone`；方法 `mysqlAcceptanceCrosszoneCheckpoint` / `mysqlAcceptanceCrosszoneContinue`；文件 `crosszone-checkpoint-<pid>-<step>.json`（pub≤16K）/ `crosszone-ack-<pid>-<step>.json`（≤2K），沿用 wx pending + fsync + 0600 + 单写者 rename（目标须不存在，不删不覆）。
- **request exact14**：`{schemaVersion:1,step:'baseline'|'shifted'|'restored',uiActive:boolean,uiPendingAffected:int0..1000,dirtyRows:int0..1000,valuesSha256:64lowerhex,witnessConnectionId:positiveSafeInteger,witnessProjectionSha256:64lowerhex,sessionTimezone:string0..64无控制字符,resultTabsBefore:int0..1000,resultTabsAfter:int0..1000,activeTabGeneration:int0..1000,activeTabOwned:boolean,nativeExecuteCount:int0..10000}`。
- **ack exact7**：`{schemaVersion,runId,phase,pid,step,proof:<同request 14键>,verified:boolean}`（顶层**7**键，非8）。
- Continue args2 `{schemaVersion,step}` → return2 `{ready,verified}`。前ack verified=true才推进下一步，false不推进。
- 入口守卫沿用现有 origin/run/root/probe/phase/secretstorage 校验与 `DBSTUDIO_MYSQL_ACCEPTANCE_ROOT/RUN_ID/PHASE/MANIFEST` 环境绑定，不新增任意SQL/路径RPC。前置 origin/run/root/probe/phase/secretstorage guards 全保。
- 报告沿用现有9键 UI report（schemaVersion/runId/phase/actionDriver/checks/proof/actions/elapsedMs/failureCode）；**proof exact3** `{rowCount:1,columnCount:5,stages:{baseline,shifted,restored}}`——`columnCount:5` 指**不含id的值列数**，而 `values`/`columnTypes` 各为**6**项（**含id**）；**stage exact15**：`{values:<6>,columnTypes:<6>,valuesSha256,witnessConnectionId,witnessProjection:<11>,witnessProjectionSha256,uiActive,uiPendingAffected,dirtyRows,sessionTimezone,resultTabsBefore,resultTabsAfter,activeTabGeneration,activeTabOwned,nativeExecuteCount}`。
- **SHA口径（写死，DOM生成、Node父进程独立重算并逐项核对；校验失败不得把observed改成expected）**：
  - `valuesSha256 = SHA256(JSON.stringify({columns:[六真实列名按顺序],types:[六实际表头类别按顺序],rows:[实际六值]}))`；六真实列名固定为 `id,date_value,datetime_value,timestamp_value,time_wide,time_short`（owned表真实列名）。
  - `witnessProjectionSha256 = SHA256(JSON.stringify({columns:[11固定别名不含CID按序],rows:[实际11值]}))`；该对象**不含** `types` 键；11别名顺序固定 `session_timezone,date_text,datetime_text,timestamp_text,time_wide_text,time_short_text,datetime_microsecond,timestamp_microsecond,time_wide_microsecond,time_short_microsecond,timestamp_epoch`。
  - 两SHA的 `rows` 元素顺序即列顺序，**不得排序/去重/换序**；值一律字符串原文，null记null。
- checks exact15：`storage_marker,persisted_connection,credential_reconnect,fixture_created,baseline_utc_display,shifted_plus08_display,restored_utc_display,non_ts_unchanged,epoch_invariant,microsecond_invariant,session_readback,same_connection,transaction_unchanged,observer_row_unchanged,session_restored`。
- failure exact18（集合不变）：`NONE,ISOLATION,CONNECTION,FIXTURE_OPEN,SET_REJECTED,SESSION_READBACK_MISMATCH,TABLE_OPEN,DISPLAY_VALUE_MISMATCH,DISPLAY_TYPE_MISMATCH,NON_TS_MUTATED,EPOCH_MICROSECOND_LOST,CONNECTION_CHANGED,TRANSACTION_STARTED,SESSION_NOT_RESTORED,OBSERVER_MISMATCH,CHECKPOINT,TIMEOUT,NATIVE_BRIDGE`。
- **failure 判定优先级（命中多条时取序号最小者，INFRA前置先判）**：1 ISOLATION → 2 CONNECTION → 3 FIXTURE_OPEN → 4 SET_REJECTED → 5 TABLE_OPEN → 6 NATIVE_BRIDGE → 7 CHECKPOINT → 8 TIMEOUT → 9 SESSION_READBACK_MISMATCH → 10 CONNECTION_CHANGED → 11 TRANSACTION_STARTED → 12 SESSION_NOT_RESTORED → 13 OBSERVER_MISMATCH → 14 EPOCH_MICROSECOND_LOST → 15 NON_TS_MUTATED → 16 DISPLAY_TYPE_MISMATCH → 17 DISPLAY_VALUE_MISMATCH → 18 NONE。进入第10~17档的前提：fresh四条件全成立（见 d）**且** fresh witness 11值与服务端 epoch/micros 均已取到；否则只能是第5/6档 INFRA。**缓存旧值、缺新TAB、结果不可观测一律不得归产品红**。
- 否定分类（真实红须由actual支撑，不以单个false断因）：**实际TS错值**=任一步timestamp_value原文≠该步预期；**DATE随TZ变**=date/dt/time任一列在任一步≠baseline原文；**epochµs丢**=epoch≠1709210096.123456或micros≠123456或显示串微秒位≠123456；**TX误启动**=任一步uiActive=true或pendingAffected>0（SET不得开事务）；**differentCID**=三步CID不全等；**sessionTZ未restore**=restored步readback≠+00:00或P_S owned CID time_zone≠+00:00；**indepdata changed**=观察者行原文或epoch在任一步变化。
- partial failure 保真：某步红时**先发布该步 actual 值与哈希**再停，不等expected、不为凑expected超时洗红；已完成的step保持证据、后续step不执行、不自动修UI/不发纠值SQL；child正常非超时退出，runner分类 KNOWN_GAP_RED（业务红）或 INFRA_ERROR（权限/凭据/不可观测/收尾失败），0 ack不冒本feature红。
- **原生计数（按实际实现记录，不得预写未实测数字）**：`executeStatement` success = **3 + 3×已完成step数**（seed：SET+CREATE+INSERT=3；每step：SET + witness readback + raw SELECT = 3）→ baseline后6、shifted后9、restored后12；failure=0；`commitTransaction`=1（仅seed）；`applyEdits`=0、`rollbackTransaction`=0、`fetchCellValue`=0、`insertRow/deleteRows`=0；事务状态全程 active=false/pending=0。结果TAB总数与 `executeStatement` 成功数一一对应（每次正常SQL产生一个新结果TAB），故各step结束时TAB总数为 6/9/12，对应 `resultTabsBefore/After` 为 5→6 / 8→9 / 11→12。树/网格路径所用方法的真实计数按实现口径记录，不与driver单测/host计数加总。

## 分工/执行（Lead单一最小实现scope建议）

- [ ] **组A DOM+runner**（`apps/desktop/src/mysql-parity-dom.ts` + `scripts/mysql-ui-acceptance.mjs`）：新phase分支、三检查点DOM、**raw SELECT 新TAB取显示真值**、fresh四条件证据（resultTabsBefore/After、activeTabGeneration、activeTabOwned、nativeExecuteCount）、11投影witness readback、固定SHA口径、checkpoint/continue桥、runner固定TZ观察者与owned-CID P_S复核、最终threads/trx归零（子进程正常退出后采样）、DOM/runner源D2。
- [ ] **组B host+lib+builder**（host新增 phase 上下文与两方法、request exact14/ack exact7 校验、stage exact15/proof exact3 校验、actual temporal 快照、**实际新增**测试名与builder对齐）：host源D2；旧host测试基数**118**（**完整名保持不变**）与既有source清单全保，新增测试名必须与builder实际列表逐项一致（数量以actual为准，合同不预设名，不写“105/118”二义），**不编造“已跑过”**。
- [ ] Lead：合同D2 → 两组源D2无阻断 → 唯一 offline locked Cargo2 fresh build + 新artifact + **fresh run**（初始/UTC5/9phase来源6keys绑定旧artifact，不得复用旧initial历史sourceguard判定新run）→ 真实业务先跑出红/绿；**若当前实现已正确则如实记绿，不硬造bug**；不先改driver与期望值；相关job全收后再最小对应修复（新candidate/fresh run）；数据与文档D2后交付。
- 源码冻结（CoreSource）仍**冻结**，直到本合同 fix 完成并经 **Lead 核对**后由Lead决定解除；本轮**不实施**任何Rust/Vue/runner/矩阵/归档/配置/依赖改动，不动 driver `c77fc4b3`/DOM `8a169`/runner `0fb685`/host `deac`，不预修driver或metadata。

## 范围外（留矩阵后续，不得被本正例宣称覆盖）

命名时区/DST切换、zero/null/invalid值、更多日期范围与多行、只读模式、**活动事务内SET负例**（本切片只做无活动事务下的正例，不含该负例）、其他类型/键/default insert/多行插入、完整对象/transfer/compare/ER/full recovery、跨构建凭据/TLS/SSH、参考应用实操、MySQL8.4、Windows/OS可信输入、8h soak、正式发布与生产环境。

**状态：未实施、未Native验收。** stage 9 的9个真实回归仍在等待，本合同不改动、不复用其结果；不承诺任何日期、生产环境或参考应用实操结论。本轮**唯一改动文件**为本文件；其70行原版已备份至 `backups/mysql-keyring-osstatus-8a0ff501-6254-4300-ab28-23ef94fe8bd9/629EEAB2-FE37-4FC5-8C39-9571628AC3E7/gui-time-crosszone-contract.before-70.md`（SHA256 c38c060d5624791ad01d66dc3e2400826b15f37513d8dc2599ca6437868701ca）；未删除、未移动、未清理任何文件，结尾不mvTrash，全部temp与既有证据保留。
