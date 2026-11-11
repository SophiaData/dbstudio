# 重启凭据与真实表格编辑回滚合同

日期：2026-11-07。继首条initial真实查询链之后的独立restart阶段；尚未实现/运行，不记通过。沿用同run/root/store/keyring，保留initial文件，禁止删除或reset。

## 阶段与隔离

- 使用既有 `DBSTUDIO_MYSQL_ACCEPTANCE_PHASE=restart`，其余三env与初始run一致。只能已有合法host manifest和同WK store ID；main挂载前读取本run marker证明initial→新进程持久化，storage.length允许其他本应用写入键，禁止枚举/返回其内容。
- 通过正常已保存连接恢复，DOM不得打开编辑连接或密码输入框，不能调用FillAppPassword，host在读取secret metadata/正文前拒绝该方法。runner剔除所有密码/端点别名环境，只注入原四路径/身份env。新进程keyringSets必须0、keyringHits≥1，connectConnection成功，才能写凭据重启恢复通过。
- 报告只用本轮新文件 `evidence/ui-restart.json` 和 `evidence/real-ui-restart-report.json`，wx600；初始报告仍原样。restart文件存在则失败，不覆盖。不计中断经过为8h。

## 用户动作与预期

1. 看到唯一已保存本轮MySQL连接，通过可见树行选择与连接按钮重新连接；检查工作台目标，不创建/重存连接。正常SQL按钮执行SELECT41，核可见结果。
2. 正常树行展开连接→本database→tables，选择并双击 `items_805` 打开可编辑表结果。不得通过wb.openTable/controller/backend.runQuery代替树操作。核列名、首行id1、body=`样本-0000001`，表页明确可编辑。
3. 双击首行body单元格，正常编辑对话框填 `界面回滚验收-<runId>`，保存本地修改。核dirty样式、应用按钮含1行与当前页仍1—200。
4. 点击下一页，在脏稿守卫选“取消”；页未变、dirty仍1、body草稿仍为测试值。不能通过直接关闭对话框或WB函数代替。
5. 点击应用修改，等native完成及页面刷新；body显示测试值、dirty消失、事务显示未提交1行。此步不声称独立观察者已验证提交前不可见性（本阶段没有中间observer checkpoint）。
6. 点击回滚，在正常确认框点击“确认”；等刷新后id1 body恢复原值、事务无活动、本地dirty清空。应用正常close退出后，独立新只读连接证明所有805行body为各自原值，其他素材不变。

动作只UPDATE一个合成行后ROLLBACK，不提交该UPDATE，不DELETE/DROP；失败时Application.close应回滚，若无法确认由runner给失败/清理未确认，不假称回滚通过。此次不证明提交可见性、精确类型编辑、deadlock GUI路径或所有事务恢复。

## 前端报告精确schema

```ts
interface RestartReport {
  schemaVersion: 1
  runId: string
  phase: 'restart'
  actionDriver: 'native-dom-synthetic'
  checks: {
    storage_marker: boolean
    persisted_connection: boolean
    credential_reconnect: boolean
    sql_select41: boolean
    table_open: boolean
    local_edit: boolean
    dirty_guard_cancel: boolean
    applied_pending: boolean
    rollback_restored: boolean
  }
  row: null | {
    id: 1
    beforeSha256: string
    localSha256: string
    appliedSha256: string | null
    rolledBackSha256: string | null
  }
  actions: { click: number; input: number; keydown: number; dblclick: number }
  elapsedMs: number
  failureCode: 'NONE' | 'ISOLATION' | 'CONNECTION' | 'QUERY' | 'TREE' | 'EDIT' | 'ROLLBACK' | 'TIMEOUT' | 'DOM_FAILED' | 'NATIVE_BRIDGE'
}
```

hash是实际对应DOMbody文字UTF8的SHA256，不能凭预期常量冒充读取；runner再独立计算固定合成原值和测试值期望。row初期失败可null；后两阶段没到可各null；checked=true则对应hash必须存在。host严格extra-field/类型/闭集/16KiB检查；成功必须全部checks真和NONE。`mysqlAcceptanceReport`仍唯一reportRPC，按host当前phase选择严格initial/restart schema、文件名；`{schemaVersion:1,report,observations}`三根字段不变，原生snapshot各false保持仅观察。

## 独立observer与联合门槛

夹具新增只读 `--observe-rollback <ready-manifest>`：先完整现有owned/live端口/镜像检查，再每次新autocommit/read-only observer连接，只读固定 `items_805`：COUNT=805、805个body各等于 `CONCAT('样本-',LPAD(id,7,'0'))`、generated_text一致、id1body hash。公开固定status `ROLLBACK_BASELINE_VERIFIED`、runId、counts、baselineBodyRows、firstBodySha256、autocommit/readOnly、guiPassed:false。不输出body/secret/任意SQL/日志，不改变旧observe输出schema。

runner新增 `--run-restart`，source/产物/liveownership门槛保留，phase=restart且已有合法root，报告路径使用上述两新名；先确认initial联合报告存在且chainPassedtrue、本run和对应store，不能以新root跳过初始。fresh同源构建在两方source/driver冻结后完成，不拿旧binary冒当前代码。

最终必须联合：9个DOMchecks与bodyhash、native connectConnection≥1、executeStatement≥1、describeTable/tableSelectSql/runQuery≥1、applyEdits≥1、rollbackTransaction≥1、getCellValue若实际发生可观察、keyringSets=0+hits≥1、child正常exit且无timeout、结束ownedfreshobserver与原observe素材保持，才能给本restart-chain通过。旧initial观测不可拼入当前原生计数。

## 实现写域与验证

- 前端/runner：http-production-entry独占mysql-parity-dom.ts和mysql-ui-acceptance.mjs；除必要调用方式不改App/main或产品行为；initial原用例保留。
- 宿主/桥：remote-db-policy独占mysql_acceptance.rs/lib.rs/build-mysql-acceptance.mjs，保持initial22测试/生产gate，补restart严格schema、密码读前拒绝和两个报告不互覆的retain-only负例。
- observer：Lead仅改scripts/mysql-ui-acceptance-fixture.mjs的新增只读命令，不改已有prepare/start/observe/stop；freeze后通知native和UI runner owner更新FIXTURE_SHA，不读生成secret材料。
- MySQL管理实现由connection-security独占mysql.rs；native/UI编译时统一冻结来源，Lead跟踪后台job并collect，不交叉写构建快照。

各实现只先source/syntax/type与非作者D2，不自启动；Lead统一最终构建与真实restart。若发现产品问题先保存真实失败证据，再最小修复，不让测试绕过UI问题。
