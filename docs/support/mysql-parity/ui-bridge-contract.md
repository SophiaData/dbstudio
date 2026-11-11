# 首条真实 MySQL UI 链路合同

日期：2026-11-07。适用 task50（前端DOM/runner）与后续task51（原生桥）。当前是实现合同，不是运行证据。主标准保留contract:M01—M23与reference:M01—M42，下面子检查通过不提升整个分类通过。

## 模式与启动

- 仅专用 `mysql-acceptance` debug 测试构建，`VITE_MYSQL_PARITY=1`；生产构建必须强制0。原 `VITE_DBSTUDIO_TEST_HOOKS` 的SQLite控制器不挂入此模式。
- 四个环境变量仍为 `DBSTUDIO_MYSQL_ACCEPTANCE_{ROOT,RUN_ID,PHASE,MANIFEST}`。首次DOM切片只执行 `initial`，重启与soak保留未执行，不伪造凭据持久化。
- runner必须在启动前调用夹具 `--status <ready-manifest>`，严格要求exit0、run/manifestSHA/immutableID/image与预期一致，ownership/running/health/loopbackbinding全部通过。结束后再调用 `--observe` 建立新autocommit只读回读，不能只相信ready历史快照。
- `main.ts` 在 `createApp(...).mount(...)` 前完成预检；普通`VITE_MYSQL_PARITY=0`不调用测试桥、不读本轮marker。预检只读本run独有marker及storage.length，不枚举/返回其他键或内容；initial必须空store，写本runmarker，restart仅在后续明确实现时验证同marker。
- App挂载并正常boot后才开始DOM动作。DOM模块不得取得Workbench或组件controller，不直接调用SQL/CRUD业务API；只用真实已渲染控件的click/input/keyboard事件。合成DOM事件明确记为 `native-dom-synthetic`，不计OS可信按键。

## 非秘密上下文

保留现有 `mysqlAcceptanceContext`，空参数。仅返回runId/phase/endpoint/database/user、隔离配置标志与固定对象白名单：

- `items_805`：id为1—805，首批SELECT与有序分页。
- `precision_values`：1行；`composite_rows`：2行；`import_empty`：0行。后续类型/写入阶段使用。
- UI初始TLS选 `require`；服务全局 `require_secure_transport=ON`。require仅表示加密，不冒充CA/名称verify-full。

不得把app/observer secret值或路径、任意manifest全文、生产路径放进上下文。各产品参考操作和各MySQL版本分别记录。

## 密码控件填充

新 `mysqlAcceptanceFillAppPassword` 空参数，仅initial；restart/soak在读取secret正文前拒绝。只读取本run app的固定secretFilePath，重新核对归属、普通文件、无symlink/多hardlink、0600、长度上限与UTF-8；不读取observer秘密。

原生端在同一段窗口脚本中核对：当前窗口/来源可信；方言mysql；host=127.0.0.1、port、database、user全等上下文；恰有一个可见、enabled的 `[data-secret-key="dbPassword"]` 密码输入框。使用JSON安全编码将秘密填入该真实控件并触发正常input事件。不得返回/记录/报告秘密，也不得在控制台输出脚本正文。

闭集全局状态为 `window.__DBSTUDIO_MYSQL_ACCEPTANCE_PASSWORD_STATUS__`：`pending` / `filled` / `target-mismatch` / `unavailable`。DOM脚本只观察状态，不读取密码value/长度。原生call返回最多 `scheduled:true`，不把排队成功当实际填充成功。

现有ConnectionDialog已经有 `data-key`、`data-secret-key`、`#f-name/#f-dialect/#btn-test/#btn-submit`，应复用，无需额外属性或改表单行为。

## DOM报告

新 `mysqlAcceptanceReport` 只接受一个严格schema对象，拒绝额外字段、未知case、SQL、HTML、任意错误消息。所有错误只用闭集分类。

```ts
interface PageProof {
  offset: number
  count: number
  firstId: number
  lastId: number
  idsSha256: string
  visibleMs: number
}
interface UiReport {
  schemaVersion: 1
  runId: string
  phase: 'initial'
  actionDriver: 'native-dom-synthetic'
  checks: {
    storage_preflight: boolean
    connection_form: boolean
    sql_select41: boolean
    page_first: boolean
    page_next: boolean
    page_back: boolean
  }
  pages: { first: PageProof | null; next: PageProof | null; back: PageProof | null }
  actions: { click: number; input: number; keydown: number }
  elapsedMs: number
  failureCode: 'NONE' | 'ISOLATION' | 'CONNECTION' | 'QUERY' | 'PAGING' | 'TIMEOUT' | 'DOM_FAILED' | 'NATIVE_BRIDGE'
}
```

`idsSha256`是实际DOM id数组按原顺序 `join(',')` 的UTF-8 SHA-256。数值有限、整数非负且有上限；页记录最多3条，count≤200，offset≤805，hash为64位lowerhex。成功时first/back为id1—200、next为201—400；其余形状记录失败，不能调整预期迎合结果。失败前尚无某页则填null。

宿主将严格原始UiReport与独立native method/success/elapsed、keyring计数一起排他保存到 `<root>/evidence/ui-initial.json`，封套精确为 `{schemaVersion:1, report:UiReport, observations:<既有原生snapshot>}`，0600、wx，拒绝覆盖。原始host观察仍 `guiVerified:false`，只作观察；frontend bool不能自行成为最终通过。runner最终联合报告固定为同目录 `real-ui-report.json`，同样排他写入。写完宿主报告后正常退出本轮子进程，失败也保留材料。严禁写原始secret、DOM快照、任意异常字符串。

## runner联合核对

1. 核测试产物来源、当前source差异与hash、mode/config及隔离store；子进程仅四个本轮env，过滤旧DBSTUDIO测试/端点/secret别名，不改变HOME。
2. 原生应用接收实际连接表单test/save，SQL文本输入框与执行按钮；查询为 `SELECT 41 AS from_keyboard;` 与 `SELECT id AS parity_id, body AS parity_body FROM items_805 ORDER BY id;`。不调用controller。
3. 核UI显示41、三页DOM id摘要；核真实正常方法计数（testConnection/addConnection/executeStatement/fetchResultPage，以当前Workbench真实调用命名冻结，不为凑计数增加业务调用）。
4. 新observer独立核805行连续id及页边界和精度素材基线，和DOM摘要联合核对。服务端/driver/DOM各自scope保留，初始链不能证明SHOW、事务异常、verify-full、重启或大表性能。
5. `real-ui-report.json`只有上述联合门槛全过才给本条chain通过；仍明确`productionReady:false`及OS可信键盘、参考产品实操、8.4/Windows/8h未执行。stdout/stderr只计字节不公开原日志，超时只结束本轮已spawn子进程，不清理文件/容器。

## 评审与顺序

task48的dotenv/负例补强并完成定向D2后，task51增加桥；task50可以先实现前端/runner但不启动窗口。桥和DOM代码非作者D2、fixture状态核对全部通过后才能首次launch。本轮初始失败若root已创建，保留失败run；不得删除root以假装全新初始。
