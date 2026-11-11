# MySQL 专用 EXPLAIN API 与真实面板验收

日期：2026-11-07。MySQL 8.0.46，macOS Tauri，原生 Rust 驱动。结论：专用 API 缺口已真实复现并修复，同一候选的首次连接、重启编辑回滚回归和 EXPLAIN 面板链通过。完整对标及生产验收仍未完成。

## 问题、实现和原生回归

原面板调用专用explain API，而MySQL driver没有对应分派；已有SQL EXPLAIN SELECT结果路径不能替代按钮体验。[真实红例](evidence/explain-api-red-23cbc47b.json)的独立MySQL计划正控成功，专用API返回EXPLAIN_API_UNSUPPORTED，收尾与素材保持确认。该红例在首个API调用停止，后续子断言当时未执行，未写作通过。

最小产品补丁仅增加专用explain方法和分派：严格一个无绑定SELECT参数，沿用单语句校验；执行一次普通EXPLAIN，返回精确五字段ExplainResult（mysql/tabular/executedSql/columns/rows）。使用实际metadata与有界完整cells，不从预览拼计划，不注册隐藏游标，不开始事务。既有SELECT、管理分页和事务分支没有修改。保留10,000行/8MiB编码结果上限，超限明确失败；不是RSS或wire读取上限。

[修复后本轮全部12项native结果](evidence/explain-native-green-b0349ac6.json)均PASS、actualExit0、cleanupConfirmed=true，包含原8项、3项事务对照和新增专用API用例。新用例实际验证：

- 五字段、列类型及每格值与独立MySQL EXPLAIN参考一致；205路UNION计划的实际行数超过200，仍完整返回。
- ANALYZE、CALL、多语句、FORMAT、WITH、绑定和额外options明确拒绝；会话counter未因拒绝输入执行而改变。
- 服务端1054错误类别与安全SQLSTATE/code保留，计划调用非事务，原16个管理游标槽仍可用。
- 真实1213、1062和默认rollback_on_timeout=OFF的1205、提交可见性、管理快照等原有断言通过，临时timeout恢复确认，原805行素材保持。

本轮没有新增产品纯测试计数，已过4项管理纯测试保留原证据。12项原生回归与44项宿主纯测试分层记录，不相加成56项真实GUI测试。

## 同候选真实三阶段

[三阶段摘要](evidence/explain-three-phase-dd714960.json)与[首次链](evidence/explain-initial-dd714960.json)、[重启回归](evidence/explain-restart-regression-35488.json)、[EXPLAIN原始UI观察](evidence/explain-ui-36117.json)、[EXPLAIN完整联合报告](evidence/explain-joint-36117.json)已保留。

新run为dd714960179e4c9383867a9b5aa64573。容器使用固定官方MySQL镜像、动态回环端口、独立生成的app/observer账号与隔离应用root/WKstore/系统凭据namespace，不访问真实用户配置或生产库。TLS require仅证明当前加密连接，不提升为verify-full证据。

同一份二进制f7623236ccd1948f75fc9b21acdf8211b7f097c68a4dc513fbfc71cfb026e799依次执行：

1. initial首次正常表单测试/保存、SELECT41与分页查询链通过。
2. 新进程旧restart九项完整回归通过，PID35488，凭据恢复、表格本地编辑、翻页守卫取消、应用和回滚及805行后验通过。
3. 新进程explain通过，PID36117，恢复已存连接后在正常SQL编辑器输入固定SELECT，点击执行SQL、EXPLAIN、刷新计划、返回结果；9checks全true，正常exit0，无超时，stdout/stderr均0字节。

三阶段的binary、前端index/assets、artifact回执、runner和公开pin六项摘要均相同；18个直接来源文件与initial材料字节保持，未把二进制升级当作普通重启。旧跨构建凭据失败仍保留，没有被本轮覆盖。

## 实际可见计划与独立参考

EXPLAIN阶段实际6click、1input、0keydown，native explain恰好2次成功、0次失败；connectConnection/executeStatement均成功，keyring gets6/hits6/sets0。动作标记为native-dom-synthetic，不是OS可信鼠标键盘，也没有截图或录像证明。

第一次可见计划和刷新后的计划均12列、1行，两次DOM规范化摘要与新run结束后的独立只读mysql客户端参考完全一致：

`354ba61bfae298475cb9858961e683e120973536fd1028e683d062683124374f`

独立参考在不同连接中核autocommit/read-only，再普通EXPLAIN相同固定SQL；它不是driver回调或较早的格式探针。12列为id/select_type/table/partitions/type/possible_keys/key/key_len/ref/rows/filtered/Extra，实际行显示SIMPLE、items_805、const、PRIMARY等。NULL和数值按既有cellText规则规范化。可见executedSql摘要也与独立固定SQL摘要相同。

返回结果后原id1/body仍在，事务控件无活动事务。fresh普通observer确认805/1/2/0素材与11项精度、9项分页基线保持。258ms只是本次DOM动作流程时间，不含启动/boot，不是延迟p95或与参考产品的性能比较。

## 构建、复核和可复现入口

[候选构建回执](../../../backups/mysql-acceptance-host-build-1f664b35a5ae46688eb98fa8d6e81e1b/build-report.json)的44项精确宿主测试及全部构建阶段通过，包含旧38与6项新phase/严格schema/边界/密码拒绝/PID文件合同检查。artifact回执SHA为040744c7c425176cceeba5dffb8507d0f34c5b92d5e3957464e270b0877a631c。

driver源码SHA为8cf4a09bde1a2b58f5977e175adf064d87c8b13c121fd3e177e0179d8e1c090b；新native测试bc6f4612cb68b8e2ea0c83a073ba9a23a18dbbee500c74c2579007bee5e95d06、native runner767bcf3841432571f303444f31560f36f608e6038b3c317d18cc3eb468e6f1d0。完整18来源及UI runner/pin摘要在原始联合报告中。

[生产flags前端证明](../../../backups/mysql-production-explain-proof-8c77bc83f3db4f34b4cbfc7c9e8e9207/report.json)确认两个JS产物不含23个验收/诊断标记，源前后保持；这只证明前端剔除，没有构建或验收新的正式安装包。

小合同、红例测试、driver两处补丁、host与DOM/runner分别完成独立只读D2；最终数据与文字也完成独立交叉复核，未发现确定阻断。原生执行入口为node scripts/mysql-driver-acceptance.mjs --run。UI入口为node scripts/mysql-ui-acceptance.mjs --run-explain，需显式公开fixture pin、固定image、artifact和artifact SHA，且先通过同候选initial；旧证据存在时拒绝覆盖。具体严格边界见[冻结协议](explain-ui-contract.md)。这次只记录已运行实例，不自动重跑或重置任何既有run。

## 剩余边界

- 只支持普通单条无绑定SELECT，参数、CTE、JSON/TREE、ANALYZE和其他格式未开放。复杂计划/实际超限分支、计划图与参考工具交互对比仍未全面验证。
- GUI危险输入和服务端错误展示未由此次正向9检查覆盖；拒绝政策与1054保留在native层验证，不能冒充GUI错误恢复通过。
- GUI提交可见性、GUI1062/1205/保存点死锁、COMMIT结果未知、跨构建凭据访问仍待解决或验收。
- dbx/DBeaver参考应用未实际操作；MySQL8.4、Windows、verify-full/SSH组合、OS可信输入和真实8小时稳定性等仍未过。
- 无新commit、tag或发布；productionReady=false，不能由此宣称整个MySQL对标完成。
