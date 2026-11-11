# GUI 提交前后独立可见性验收协议

2026-11-07。task63集成切片，只验证正常GUI提交；不把native提交可见性通过代替GUI通过，不扩本次到错误注入。既有产品driver8cf与fixturecc946保持，当前ResultGrid正常提交按钮调用settleTransaction，正常SQL执行新建结果标签，不自动结束已有事务。

## 隔离、同产物与固定数据

新内部/语义phase为`commit`，仅既有4个验收环境变量，不新加秘密。用新合成run、同一候选二进制先initial通过，再本profile；可顺序回归restart/explain。沿用同root/WKstore/凭据namespace，marker和已存连接恢复；不填密码或重新保存，密码helper在任何secret metadata读取前initial-only拒绝。

CLI `--run-commit`必须显式受限公开fixture pin，完整owned/live/image/manifest/fixture来源核对；initial六摘要与当前产物相同，initial三份材料不变。仍校18个直接源与额外runner/pin，旧profiles不放宽。新报告、检查点、ack均仅本次spawnPID固定路径、排他新文件，保留不删除。父进程90秒超时/再5秒KILL仅本profile，旧时限不变。

UI仅操作新表`<database>.ui_tx_<run32>`，id INT PRIMARY KEY、body VARCHAR(128) NOT NULL、ENGINE=InnoDB。固定id1，baseline文本`baseline-<run32>`，提交后文本`committed-<run32>`。所有标识符由已验证run/database派生，不接受任意SQL、路径或endpoint输入。保留新表与最终已提交值，不动items_805/precision等既有素材，不SQL删除。

## 正常UI动作和阶段

1. marker恢复、选择正常已保存连接并点连接，不业务API/controller直调。
2. SQL编辑器+执行SQL按钮分别执行CREATE TABLE与INSERT。建表后核“无活动事务”；插入后核“未提交 · 1 行”。点击ResultGrid正常“提交”，等“无活动事务”及正常成功状态。
3. SQL编辑器正常SELECT id,body ORDER BY id；读取可见唯一id1/body为baseline，产生实际DOM baseline SHA。发布baseline检查点并等待parent独立观察者确认后继续。
4. SQL编辑器正常UPDATE id1的body为committed文本，再正常SELECT。读实际DOM新body SHA，核“未提交 · 1 行”；发布pending检查点并暂停，parent fresh连接必须仍见baseline，确认后才能继续。
5. 点击当前ResultGrid正常“提交”，不发COMMIT SQL，不直调backend；等“无活动事务”、提交成功状态，工作台正常刷新结果后读DOM body仍为committed。发布committed检查点；parent fresh连接必须见committed，ack后才最终成功报告。

五条正常SQL（CREATE/INSERT/SELECT/UPDATE/SELECT），两个正常提交按钮；native executeStatement成功恰5、commitTransaction恰2、均失败0，rollbackTransaction和applyEdits0。其余刷新读取允许原工作台行为。动作统计click/input/keydown，成功至少8click、input恰5、keydown0；真实数字如实保留，不OS可信输入。流程elapsedMs包含独立checkpoint等待，不能叫纯DOM动作耗时、启动或p95。

## 有限检查点RPC

均仅debug mysql-acceptance、main+bundled-local origin、phase commit允许，生产不可达；probe仍先拒绝。不能直接执行数据库业务，不能传任意文件名或SQL。payload编码<=1KiB，exact字段与类型校验。新方法：

- `mysqlAcceptanceCommitCheckpoint`仅接受一个对象`{schemaVersion:1,step:'baseline'|'pending'|'committed',bodySha256:<64 lowerhex>,active:<bool>,pendingAffected:<integer>}`，返回null。
- `mysqlAcceptanceCommitContinue`仅接受一个对象`{schemaVersion:1,step:<同闭集>}`，返回exact `{ready:<bool>,verified:<bool>}`。

Checkpoint step严格按baseline→pending→committed顺序，前一步ack verified=true才可发布下一步。重复相同已发布payload可幂等，不重写；同step不同payload、乱序、跳过、其他phase/类型/未知字段拒绝。每步state固定：baseline false/0、pending true/1、committed false/0。

宿主在自身Mutex状态中保留本step报告和确认状态，不以DOM布尔直接当数据库实证；发布文件时附当前本PID native observations。Continue仅读取本PID、本step固定ack；文件未存在返回false/false，失败ack返回true/false且不推进，成功ack严格匹配run/phase/pid/step/bodySha与已发布报告才true/true。重复Continue已确认step可幂等返回true/true，不能重复推进或解锁其他step。

发布到本root/evidence固定`commit-checkpoint-<pid>-<step>.json`：exact

```text
{schemaVersion:1,runId,phase:'commit',pid,step,bodySha256,active,pendingAffected,observations:<现有host snapshot>}
```

parent先验证该结构、stage状态、来源和本PID native计数，再发起fresh独立观察。baseline时commit成功1/execute成功3；pending时commit1/execute5；committed时commit2/execute5，均对应失败0。只有参考成功才写verified=true。

Parent ack固定`commit-ack-<pid>-<step>.json`：exact

```text
{schemaVersion:1,runId,phase:'commit',pid,step,bodySha256,verified:<bool>}
```

观察失败可发布false让DOM快速失败，不能授权后续提交。检查点每步最多1份、ack每步最多1份，不覆盖旧证据。宿主读取ack前验证固定root/父路径canonical/no-symlink、文件600/singlelink/bound大小及打开句柄元数据，不能读外部文件；run、pid、step、bodySha均严格相同才接受。

为避免create后write尚未完成被另一进程读到，checkpoint和ack在本evidence内用固定本PID-step `.pending`名wx600写全+sync，再核源文件/归属/绝对父路径、目标不存在后rename到固定最终名。移动前必须验证解析后的绝对源/目标均为本次预期路径；仅本次私有目录、单一stage writer，Mutex保证host重复发布不产生多writer；不删除任何文件。无覆盖/偷取旧stage或任意path参数。pure tests验证seq、重复/错ack/链接与旧文件保护。单父进程本轮，不宣称崩溃/恶意同用户文件篡改恢复保证。

每步DOM轮询Continue有30秒截止，轮询仅读有限状态，不增加native业务调用。parent轮询只读自己的spawnPID的下一stage，观察客户端有15秒timeout，必须在子进程仍活着且未超时的情况下发ack。观察完成与ack均保留到joint结果中，正常close后再做final素材与最终新表回读。watcher必须随ownchild结束/超时终止，不留timer/job；不重算旧候选或读取他PID路径。

## 独立MySQL观察

不改冻结fixture脚本；UI runner内部沿既有EXPLAIN独立CLI方法：先完整live gate，只对fixed-owned容器调用mysql进程，内部私有`/fixture/observer-client.cnf`，不读取或输出配置正文/秘密/原始stderr。固定SQL同session设autocommit=1、transaction read-only并核布尔后，读取本新表唯一行id与body SHA。输出仅bounded计数/布尔/hash，不传任意数据内容。

baseline新连接看baseline；pending另一fresh连接仍看baseline，且UI checkpoint bodySha为committed，两者必须不同；committed再fresh连接看committed。各连接结束后才发ack。3份观察是独立于driver的外部查询，不用同一会话或旧snapshot冒充。最终fresh普通fixture observer核805/1/2/0原素材，最终新表fresh回读确认提交值保留。失败仍尝试final observer，若表未创建或状态未知应准确失败/收尾未知，不能一概报原值恢复，也不自动撤销已成功commit。

## 最终严格UI报告

复用`mysqlAcceptanceReport`，outer仍{schemaVersion:1,report,observations}，16KiB/mainlocal/wx自身`ui-commit-<pid>.json`。report exact：

```text
schemaVersion:1; runId; phase:'commit'; actionDriver:'native-dom-synthetic'
checks:{storage_marker,persisted_connection,credential_reconnect,table_created,
        baseline_committed,baseline_observed,pending_visible,pending_isolated,
        commit_clicked,result_refreshed,committed_observed,nontransactional}:boolean
row:null|{id:1,baselineSha256:<64hex>,pendingSha256:null|<64hex>,committedSha256:null|<64hex>}
actions:{click:<0..10000 integer>,input:<0..10000 integer>,keydown:<0..10000 integer>}
elapsedMs:<0..3600000 integer>
failureCode:'NONE'|'ISOLATION'|'CONNECTION'|'QUERY'|'TIMEOUT'|'DOM_FAILED'|'NATIVE_BRIDGE'|'CHECKPOINT'|'COMMIT'
```

NONE要求12check全真、row完整、baseline!=pending=committed、动作条件全满足，并且host自身3ack均confirmed；不能只接受前端说“已观察”。失败保留已取得row/null与false状态，不升为GUI通过。context/snapshot semanticcommit，同keyringSets0/hits>=1，诊断复用原19闭集/methodgroups、128条/32KiB，best effort不改业务语义。

parent joint自身wx `real-ui-commit-<pid>.json`，只有normalexit0、strict12checks、3顺序检查点及独立参考与ack、native5execute/2commit及keyring、同candidate6来源/18源/initial材料保持、最终素材和新表观察全过，才设preCommitObserverVisibilityVerified=true、commitVerified=true。生产ready、OS可信输入、跨构建凭据、错误恢复/长期稳定性等仍false/未验。旧44宿主测试保留，新增有限checkpoint/ack/phase/schema测试名单由owner给准确count；构建/纯测试不代真实GUI。
