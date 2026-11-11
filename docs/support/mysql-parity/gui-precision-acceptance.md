# 首组六字段：精确类型网格编辑、应用与正常提交实证

结论：MySQL8.0.46/macOS的真实Tauri→Rust→MySQL首组六字段已通过，15项检查全真。超JS安全整数、高精度DECIMAL、UTF-8及NULL↔空字符串，经正常dialog编辑/应用、正常SQL未提交见证和正常提交后独立数据库核对均准确。现有业务实现原样支持，本轮新增有限验收与证据，没有制造产品修复。task78总类型矩阵继续进行，fullTypeMatrixVerified=false。

## 真实值与独立投影

[八阶段摘要](evidence/gui-precision-eight-phase-e12b3fa3.json)、[完整联合报告](evidence/gui-precision-joint-41700.json)、[原始UI](evidence/gui-precision-ui-41700.json)记录新run e12b3fa346f24dd78ad934867e64e1f3、PID41700、GRID_PRECISION_VERIFIED/NONE/正常exit0，无超时/stdout/stderr。

正常2SQL新建本run gui_px表并插入单行七列、正常提交；树打开ASC，检查原cellText和每个编辑器原始值/NULL勾选/textarea disabled。六列正常保存到同一dirty行，id=1不改，实际编辑与最终数据库值如下（整数与小数始终按字符串处理）：

| 列 | 初值 | 已提交精确结果 |
| --- | --- | --- |
| unsigned_big BIGINT UNSIGNED | 18446744073709551615 | 18446744073709551614 |
| signed_big BIGINT | -9223372036854775808 | -9223372036854775807 |
| exact_decimal DECIMAL(65,30) | 12345678901234567890123456789012345.123456789012345678901234567890 | -98765432109876543210987654321012345.987654321098765432109876543210 |
| utf8_text VARCHAR | 种子-你好-😀 | 编辑-你好-🚀 |
| nullable_text VARCHAR NULL | SQL NULL | 空字符串；IS NULL=0、HEX为空 |
| empty_text VARCHAR NULL | 空字符串 | SQL NULL；IS NULL=1、HEX(COALESCE(...,''))为空 |

所有六列均通过正常双击→dialog→保存到本地；NULL→空串正常解除checkbox后触发空input，空串→NULL正常勾选checkbox，不伪造CellValue或直接控制器。typed DOM hash从真实td.is-null决定null，其他格为原textContent字符串（空串保留），没有把NULL/空字符串混成同值，也没有把精确数值转Number/parseFloat/BigInt重整。

## 服务器旧→旧→旧→新与同会话见证

四步原始报告如下，ack只表示独立观察完成：

- baseline：[checkpoint](evidence/gui-precision-checkpoint-41700-baseline.json)、[ack](evidence/gui-precision-ack-41700-baseline.json)。原始DOM旧值/false0/dirty0，fresh只读外部精确旧值。
- draft：[checkpoint](evidence/gui-precision-checkpoint-41700-draft.json)、[ack](evidence/gui-precision-ack-41700-draft.json)。六字段本地精确新值，dirty1/false0；尚无apply，fresh仍旧值。
- applied：[checkpoint](evidence/gui-precision-checkpoint-41700-applied.json)、[ack](evidence/gui-precision-ack-41700-applied.json)。正常应用成功影响1行，dirty0/true1。正常SQL查询CONNECTION_ID、CAST两个大整数/小数为CHAR、UTF8 HEX与两个NULLflag/HEX，实际GUI连接545读精确新投影；正常返回原表hash保持，fresh外部仍精确旧值。
- committed：[checkpoint](evidence/gui-precision-checkpoint-41700-committed.json)、[ack](evidence/gui-precision-ack-41700-committed.json)。原表正常点击提交，查询标签由正常工作台自动重读，同连接545/精确新投影，再回原表精确新值/false0/dirty0；fresh外部此时才精确新值。

parent固定独立只读autocommit SELECT同8列CAST/HEX/ISNULL投影，原始字符串逐项核对；只去终结LF，保留末列空串的trailing TAB。最终utf8 HEX实际E7BC96E8BE912DE4BDA0E5A5BD2DF09F9A80，NULL flags为0/1且两HEX空串不被丢列。不是仅比旧页面、数字近似、预期hash或mock。

实际typed DOM baseline SHA e7323bb9147660554da1ae06255ffe32397d06942420d12b00542e95042caaf1；draft/applied/committed均39f82b0b6f6f1b06a9fae098b539dd2249d332b091503abaa23f788ea0ac0b7c。外部baseline/draft/applied projection SHA均e6674bc1807b526dd991db6a723ed17d6760ce23695f7ee6dae310cae2d1b2cf，正常GUI未提交与提交后及最终外部新投影均de7b13118ff66e056f1576c9fa56f7c66c7553e65d58604adbb45f733fba5514。精确大整数、小数并未通过JS Number比较。

## 原生结果与来源

actual applyEdits成功1/失败0，真实返回安全六标量oktrue/affected1/inTransactiontrue/outcomeCount1/failedOutcomeCount0/errorClassnone；applied最后实际状态true1。正常commit成功2（setup1+网格应用后1）、executeStatement成功3（setup2+正常witness1）、rollback0。最后实际状态false0，独立该GUI事务COUNT0确认。最后lastApplyResult.inTransactiontrue只是过去批次，不是提交后当前状态。

本次25click/8input/7dblclick/0keydown，3773ms包括四步独立观察，不是启动/纯DOM/p95性能。actionDriver=native-dom-synthetic，不是OS可信输入/视觉验收。

同c3381f034eda18964e61920772b40ff93512b4f6f303ae083e69de40c720230f候选依次通过[initial](evidence/gui-precision-initial-e12b3fa3.json)、precision、[1062](evidence/gui-precision-duplicate-42927.json)、[1213](evidence/gui-precision-deadlock-44362.json)、[1205 OFF/session5](evidence/gui-precision-timeout-45711.json)、[重启编辑回滚](evidence/gui-precision-restart-47754.json)、[EXPLAIN](evidence/gui-precision-explain-48158.json)、[提交可见性](evidence/gui-precision-commit-48516.json)八阶段，全部正常exit0。保存[initial原始UI](evidence/gui-precision-initial-ui-e12b3fa3.json)、四组原始checkpoint/ack和全部18raw JSON/SHA映射，六项产物来源/19直接源与initial字节材料一致，原805/1/2/0+precision11/paging9素材保持，精确新表提交结果保留。

[构建回执](../../../backups/mysql-acceptance-host-build-f6f246205add4e40b43b8b9b29d4f6fe/build-report.json)确认88精确纯宿主（旧80+8）及全部阶段通过，artifact SHAb140d0187ad13ce1140adf685e0aa733004d398475c920fcc70d065f0fda2d68。不是88项GUI；历史2core/21model/native12未本轮重跑，不合计为新GUI通过数。coreb4/WB4b/ResultGrid/driver8cf/fixturecc与既有产品测试保持，未改业务实现。

[正式flags证明](../../../backups/mysql-production-precision-proof-086cff9786b244f9998c699ae7d1e8e7/report.json)确认两个JS无33验收/诊断标记，只证明前端剔除，不是正式安装包。小合同/差异、宿主与DOM/runner源码D2均无阻断，最终数据与交付文字独立D2亦无确定阻断，仅首组六字段正向路径通过。联合SHA7618939f3d0611a2b8cc87269d5c0f294ec0873ad6d362814bd508024708c757，摘要SHA93978097c751e823f265997db800c5fcf43e6acef894e0f213e5163e7449f3d8。

## 完整类型矩阵继续开放

[协议中的完整子矩阵](gui-precision-contract.md)保留LONGTEXT完整获取后编辑、JSON/大整数JSON、DATE/DATETIME/TIMESTAMP/TIME微秒和时区、BIT/BOOL、BLOB/VARBINARY读写、FLOAT/DOUBLE、越界/无效输入/NOT NULL/默认值、大整数键/复合键/插入/多行等。本次只有单INT主键、单行六字段正向路径通过，不代表全范围、负例或完整类型矩阵。

source明确二进制网格只读，本轮未补写能力；该缺口仍在，不把它移出目标。跨标签/多行大事务/COMMIT未知、其他平台连接组合/参考产品实操/长期稳定性也未因此完成。本次没有实际产品红例，未测试早期红例分支的运行故障恢复；仅有限schema/pure及源D2不能代这些实际故障。

所有表、文件和环境保留，不读真实配置/凭据/生产库、不删除清理旧环境、不改系统策略或依赖、不正式发布。task78及完整对标目标保持进行中，productionReady=false。
