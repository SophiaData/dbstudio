# 专用 EXPLAIN 界面真实验收协议

2026-11-07。task58集成，task60原生实现。仅新增明确工作流，不重构旧initial/restart/probe，不修改冻结fixture源码cc946。

## 产品API

现ExplainPanel正常调用backend.explain(connectionNode(connectionId),sql)。core移除node后driver收到[sql]，当前App明确要求单条语句且拒绑定参数。返回ExplainResult仅5字段：dialectId='mysql'、format='tabular'、executedSql、columns、rows；行结构和CellValue沿用现有类型。没有cursor/page/elapsed/generation字段，不注册未受core管理的rawcursor。

初始支持普通单条SELECT的EXPLAIN，不执行原SQL；ANALYZE、CALL、多语句、未支持绑定和尾options明确拒绝。复用实际执行期metadata及管理结果完整cells与10000行/8MiB编码上限，超限明确失败，不把预览截断伪装完整。CTE、参数及其他计划格式保持差距可见。一次请求执行一次计划。

## 隔离与同产物条件

- 四个既有DBSTUDIO_MYSQL_ACCEPTANCE_*环境变量不增加秘密变量。新增内部/语义phase均为`explain`，Context和observations phase必须为explain。
- 使用新合成run的同一候选二进制，先initial通过；可先执行旧restart九项作为回归，再执行本profile。
- CLI为`--run-explain`，必须显式`--fixture-pin`；复用受限五字段公开pin及完整owned/live/hash门槛。旧b51默认行为不改，fixture脚本不编辑。
- 开始前initial的binary/index/assets/receipt/runner/pin六摘要须等于当前；完成后initial三份材料及pin/runner来源字节保持。
- 同store marker恢复，禁止填密码/新建连接/重新保存。密码helper仍initial-only，explain在任何秘密metadata访问前拒绝。
- 沿用main+bundled-local来源、schema/尺寸上限及debug-only gate；生产flags不能包含测试桥。仅本run合成系统凭据命中，keyringSets=0、hits>=1。

## 前端正常动作

1. marker与已保存连接正确，通过正常连接按钮恢复。
2. 正常编辑器填固定SQL并点击执行SQL，显示id1与原body；不调用Workbench/controller/backend业务方法。
3. 点击主工具栏EXPLAIN，正常挂载ExplainPanel；等待busy消失并读取可见表头/行及pre。
4. 点击“刷新计划”，再次读取完整可见计划。
5. 点击“返回结果”，原查询id/body仍显示；正常事务控件仍无活动事务/未提交计数。

固定SQL无分号和绑定：`SELECT id,body FROM \`<database>\`.\`items_805\` WHERE id=1`。executedSql必须为`EXPLAIN `加上述SQL。

DOM动作标记仍native-dom-synthetic；不声称OS可信鼠标/键盘。计数为click/input/keydown，keydown=0；预期至少5click和1input，真实值如实报告。各等待有时限，错误通过严格报告退出，不吞原业务错误。

## 严格前端报告

外层沿用`{schemaVersion:1,report,observations}`与16KiB上限，main窗口来源。不接受任意字段或错误正文。

report恰为：

```text
schemaVersion:1
runId:<32 lowercase hex>
phase:'explain'
actionDriver:'native-dom-synthetic'
checks:{storage_marker,persisted_connection,credential_reconnect,query_result,
        explain_open,plan_content,plan_refresh,return_results,nontransactional}:boolean
plan:null | {rowCount:1,columnCount:12,firstPlanSha256:<64hex>,
             refreshedPlanSha256:null|<64hex>,executedSqlSha256:<64hex>}
actions:{click:<bounded integer>,input:<bounded integer>,keydown:<bounded integer>}
elapsedMs:<bounded integer>
failureCode:'NONE'|'ISOLATION'|'CONNECTION'|'QUERY'|'TIMEOUT'|'DOM_FAILED'|'NATIVE_BRIDGE'
```

成功必须9checks全true、plan各摘要非空且first=refreshed、至少5click/1input、keydown0。失败可保留已取得的plan/null与false检查；字段形状和边界仍严格。

规范化计划为UTF8 JSON.stringify({columns,rows})的SHA256：columns按可见表头顺序，rows为每格cellText的字符串二维数组。数值String(number)、NULL='NULL'；保留其它文本，不加自造排序或省略列。报告只传摘要/数量，不传任意SQL、结果值或DOM文本。executedSqlSha256单独对可见pre.textContent精确UTF8做SHA。

[只读格式探针](evidence/explain-reference-format-b51c7485.json)实际确认当前MySQL8.0.46列为id/select_type/table/partitions/type/possible_keys/key/key_len/ref/rows/filtered/Extra，共12列；本固定PK计划1行。该探针不是本轮新run参考，不计GUI验收，最终仍须新run结束后fresh参考。

## 宿主与文件

- phase explain沿用restart类store隔离，但报告独立校验，不复用restart九字段。
- 自己进程wx600写`ui-explain-<pid>.json`，parent自己的spawnPID对应joint为`real-ui-explain-<pid>.json`。
- 启动闭集trace可复用restart-attempt的同句柄sink、128条/32KiB及原13frontend/3native/3keyring闭集。method组仍none/listDialects/listConnections/migrationStatus/other，explain归other，不增加参数或错误值。
- 诊断best effort，不改变业务结果；同目录wx trace按自己的PID，不覆旧文件。parent仅读自己spawnPID的固定文件。
- 保留全部38宿主旧测试，新explain schema/phase/helper拒绝等测试名单精确追加，builder新count由实现者实际给出，不预先宣称通过。

## Parent联合门槛与独立参考

parent60秒+既有TERM/KILL收尾，只允许同一候选源冻结后运行；所有新增代码先独立只读D2。即使失败/缺少UI，仍尝试fresh普通observer核素材。不要把源码/编译当真GUI通过。

成功必须全部满足：正常exit0且日志计数不含秘密；strict UI9项；native本PID connectConnection成功、executeStatement成功、explain成功恰2次且失败0，keyringSets0/hits>=1；当前18直接源、receipt/binary/assets/pin/runner及initial材料保持；fresh普通observer素材通过；fresh EXPLAIN参考与两份DOM摘要及executedSql摘要一致。

独立EXPLAIN参考放在GUI runner内部，避免修改冻结fixture：先完整live pin gate，然后只对fixed-owned容器调用mysql进程，内部使用`/fixture/observer-client.cnf`，不读取配置正文。固定同连接SQL先设置autocommit/read-only并SELECT两布尔，再普通EXPLAIN上述固定SQL。CLI batch/raw/column-names解析列名和唯一行，拒异常列数/行数或过大输出；仅id/rows/filtered转String(Number)以匹配cellText，其余原值，NULL保留。密码不进argv/日志/返回对象，失败只闭集code。

独立参考输出可留列名/行小数组与planSha256（全为固定合成计划，无原body）；autocommit/readOnly须true，plan与executedSql摘要由固定SQL生成。parent将其和DOM两摘要比对并落原始joint报告。不能用旧格式探针、同一driver回调或组件数据代替这个fresh独立参考。

joint可声明本次explainPanelVerified/independentReferenceVerified，但productionReady=false，OS可信输入/其他MySQL版本与平台/长期稳定性/完整对标仍未通过。此次不提升GUI提交、跨构建凭据恢复或其他故障恢复。
