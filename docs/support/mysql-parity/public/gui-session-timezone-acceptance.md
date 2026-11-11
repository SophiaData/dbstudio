<!--
公开脱敏副本，原文保留本地；原始SHA256=7e980938b10a6f1c217c6e280ec1d3437a51a13d1d14b92d1ebed985d2eefbe4，本文件不是原始字节证据。
原文相对路径：docs/support/mysql-parity/gui-session-timezone-acceptance.md
本副本仅做本机路径脱敏与链接重写；任务结论、表格、RED/GREEN 判定与限界与原文一致，未新增或洗白任何结论。
-->
# 正常SQL会话时区控制：真实红例与最小修复

本组完成真实红→单文件最小修复→新候选/新实例绿色：正常 `SET SESSION time_zone = '+08:00'` 与恢复UTC实际成功，同连接/微秒epoch/独立P_S/无活动事务逐步对应。同候选10阶段全0，105项宿主及3项驱动单测各自通过，红/主绿数据与源码D2均无阻断；最终10阶段来源/正文delta D2已通过。本记录不提升typed DATE/DATETIME6/TIMESTAMP6/TIME6网格或完整对标为完成。

验收日期2026-11-09，Asia/Shanghai；采用[三步合同](../gui-session-timezone-contract.md)：同连接正常查询基线UTC→正常SET +08/查询实际值→正常SET +00/查询恢复；parent逐步独立P_S namedvars/事务与fixed app-role oracle对照。全部真实Tauri DOM→Rust→MySQL，输入为程序化DOM事件，不是OS可信键盘鼠标。

## 首次真实产品红例

run `59ba845c44c94e8a8d7bc05d80ad7756`，PID81965，MySQL8.0.46官方image固定 `sha256:b7e118f56c5963e079252e0d6e2978c9c010eb7fc7aaaec100e367796b5dd08f`，loopback/TLS require；不作verify-full证明。

原driver SHA `8cf4a09bde1a2b58f5977e175adf064d87c8b13c121fd3e177e0179d8e1c090b`，全部harness来源冻结。首个105构建回执（原始材料仅本地保留（见原SHA索引））全阶段0/来源22，binary `0281ec3a2435ef3fc90e1c31622bb9097b0ba72f483717fe6ffec925cb722509`，receipt `ed1157f79aac9609dbef90fd67c0b8322c47a4e1943eaa931fc9e8ca355ec9b3`；105=旧97+8新宿主纯测试，不凑GUI。initial链实际通过。

| 阶段 | 正常GUI实际 | 独立P_S | 实际native |
|---|---|---|---|
| baseline | connection5207，+00/UTC/autocommit1/epoch1709210096.123456，UI false/0 | own5207/ownDB，time_zone+00/autocommitON/事务0 | executeStatement success1/failure0 |
| offset SET后正常SELECT | SET实际拒绝，setFailed=true；同5207仍+00/UTC/1/原epoch、UI false/0，未伪造新值 | 同5207仍+00/ON/事务0 | executeStatement success2/failure1 |
| restored | 未执行；offset业务检查失败后停止 | 最后线程0、事务0 | 无commit/rollback/apply/write/fetch |

两实际投影SHA相同 `9b367770ccec642acf5bbcbd63b26037877489020e6a19f045a044079faf5d89`。2checkpoint/2ack逐项对应，正常退出1，无超时/stdout/stderr，progress为PARTIAL_UI_FAILURE而不是TIMEOUT。3input/5click/0keydown/0dblclick，2122ms包含独立观察，非性能指标。

同attempt独立app-role只读CLI可成功设置+08和恢复+00；固定DATETIME(6) literal `2024-02-29 12:34:56.123456` 经CAST(UNIX_TIMESTAMP(...) AS CHAR)在+00为`1709210096.123456`，+08为`1709181296.123456`，恢复+00回原。结合GUI真实失败、native失败计数和P_S旧状态，确认 `SESSION_TIMEZONE_KNOWN_GAP_RED / SET_REJECTED`，不是权限/观察INFRA，不是通过。

[红例摘要](../evidence/gui-session-timezone-red-59ba845c.json) SHA `2c2043bff85ceecaab4cd8e4ed4760cff449c449f3a3a186e5acc25cabb675aa`，[原始联合回执](../evidence/gui-session-timezone-red-joint-81965.json) SHA `c173675bd3c2ba26f42e39f4cd401794c9a6c910dedc056c53fe6196f78e1dd1`。8份原始JSON已不可覆盖归档，旧实例/原表/binary不reset、不删除。805/1/2/0素材、precision11/paging9、initial材料与22来源保持；原始数据D2已no blocking。

## 最小修复与独立检查

全部相关构建、GUI、CLI、子任务检查结束收取且红例数据D2通过后，先备份8cf原文件，再仅改[MySQL驱动](../../../../crates/dbstudio-drivers/src/mysql.rs)。新driver SHA `e7f4ff301cbc8af22a10e1e1ae348a513652f33f572a37ed019e331c5506a4b2`：

- 识别显式单条 `SET SESSION time_zone = '±HH:MM'` 静态偏移字面量，大小写/空白及一个结尾分号可用，数值范围由MySQL校验。
- 在generic prep/自动DML begin之前正常执行原SQL，返回实际affected与现有active/pending；不begin、commit或增加待提交行数。
- 保留原事务关键字/通用SET guard；不把GLOBAL、autocommit、多语句、@@别名、命名时区、参数或注释变体当本次新增支持。DATE/TIME格式疑点本次未修。

三项驱动单测回执（原始材料仅本地保留（见原SHA索引）） isolated/offline/locked实际3/3通过：正向literal/case/space、其他SET/事务限制、后缀SQL/多赋值/转义及错误literal拒绝。定点diff检查通过，源码独立RO D2 no blocking。3项是驱动解析单测，不混入105宿主或GUI。

五份harness源码与红例保持一致：DOM a8d01b3e…、runner8b907711…、hosta8b62fe0…、lib7f39d705…、build41e568a9…；Source22不减、未改core/workbench/Grid/fixture、未添依赖/改环境策略。构建回执scope的旧19来源文字仅在新receipt改为实际22，历史receipt原样保留。

正式flags证明（原始材料仅本地保留（见原SHA索引））：2JS内37测试标记均被剔除，frontend-only，无正式包或GUI性能/OS输入声明。

## 新候选绿色与回归

新run `bd5d67d98fac4a1a8cc7b4aaf95d0719`，PID7142，SESSION_TIMEZONE_VERIFIED/NONE/10项检查全真，正常退出0、无超时/stdout/stderr。新105构建回执（原始材料仅本地保留（见原SHA索引））全部阶段0、来源22/scope22，binary `061f7a800b49d44b43daf182426afd96419e247b3c162d2e3e957a545ce6a3d5`，receipt `ffd276214ce17c5d9916a24471bb8660bf4e4f3268696e7cee0fbadaf55f92c4`。该105宿主与前述3项驱动单测分层，非108项GUI。

| 阶段 | 实际同连接317会话 | 正常查询epoch原字符串 | Native execute累计 | 独立P_S |
|---|---|---|---|---|
| baseline | +00:00 / UTC / autocommit1 / UI false0 | 1709210096.123456 | success1/failure0 | +00/ON/事务0 |
| offset | +08:00 / UTC / autocommit1 / UI false0 | 1709181296.123456 | success3/failure0 | +08/ON/事务0 |
| restored | +00:00 / UTC / autocommit1 / UI false0 | 1709210096.123456 | success5/failure0 | +00/ON/事务0 |

实际投影SHA为`9b367770ccec642acf5bbcbd63b26037877489020e6a19f045a044079faf5d89`→`823c8f123997f692b211521adef69d29aad43249758ffe97b3abb2b20e5a2077`→前者。3checkpoint/3ack逐项对应，SET失败数0、恢复确实执行；正常SET2+SELECT3、7click/5input/0keydown/0dblclick，2594ms含独立观察，不当性能指标。Native最后actualfalse0，无commit/rollback/apply/insert/delete/fetch，所有已记录GUI id最终线程COUNT0/事务COUNT0，805/1/2/0+11/9素材保持。主流程数据D2无阻断。

| 同候选阶段 | PID | 结果 |
|---|---:|---|
| initial | — | 0 |
| session-timezone | 7142 | VERIFIED/10真/0 |
| 全文JSON | 8843 | 0 |
| 六字段精确值 | 9761 | 0 |
| 1062事务保留 | 10599 | 0 |
| 1213恢复 | 11553 | 0 |
| 1205 OFF/session5 | 12873 | 0 |
| samecandidate restart | 14926 | 0 |
| 普通tabular EXPLAIN | 15307 | 0 |
| normal SQL commit | 15701 | 0 |

18份绿色原始JSON已不可覆盖归档；[10阶段与红绿对照摘要](../evidence/gui-session-timezone-ten-phase-bd5d67d9.json) SHA `ed442fea18abff3e471d7aa67f3fb2c8f6f70ba2fa3abcc8c8c78e1cf9740f9f`，[绿色联合回执](../evidence/gui-session-timezone-joint-7142.json) SHA `8600023b5e3afa8029c54504395ce6f9e9caf68a9af73bed41943ff963b1d5ae`。10阶段六来源摘要、初始材料及22source逐项相同。跨红/绿两个候选的22直接来源仅driver从8cf→e7f4改变，其余21来源与runner分别逐项相同，五份harness源码不变；原失败phase未重用。所有后台构建/单测/回归job均已收取。

## 仍未完成

本组只是显式SESSION偏移控制与固定literal微秒函数，不等typed时间网格显示/原值编辑/微秒提交、真实TIMESTAMP行跨zone、活动事务中SET、命名时区/无效偏移、只读连接模式/其它SET或任意SQL事务控制已验。task84与全类型task78继续；BLOB写、BIT/BOOL、范围负例/大复合键/default/insert/multirow及可靠paging/对象/transfer/compare/ER/完整故障恢复、跨构建凭据、TLS verify-full/SSH、MySQL8.4/Windows/参考dbx/DBeaver实际操作、OS输入和8小时稳定性等仍开放。未提交、推送、打标签或发布。
