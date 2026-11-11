<!--
公开脱敏副本，原文保留本地；原始SHA256=a16af9107157355969daf9f07bc273da6235cb4ce3ca028e2701c56efa786d7b，本文件不是原始字节证据。
原文相对路径：docs/support/mysql-parity/gui-text-acceptance.md
本副本仅做本机路径脱敏与链接重写；任务结论、表格、RED/GREEN 判定与限界与原文一致，未新增或洗白任何结论。
-->
# 长文本完整值与JSON精确编辑提交：真实验收

本组通过真实Tauri DOM→Rust→MySQL→独立只读连接验收：单行LONGTEXT/JSON的八次正常全文查看、两次完整编辑、应用后内新外旧、正常提交后外部精确新值。九阶段同候选回归全0。这是原业务实现的支持证明，本轮业务核心/网格/驱动/完整值组件没有修复；只新增验收及纠正验收门槛。完整类型和dbx/DBeaver整体体验仍未完成。

主数据与最终九阶段来源/正文delta D2均no blocking。验收时间2026-11-09，Asia/Shanghai；实际范围见[合同](../gui-text-contract.md)。

## 候选与边界

- run `a1b30670c3ea4caa9c5867f9f9d3587a`，主进程PID38529，MySQL8.0.46官方固定image `sha256:b7e118f56c5963e079252e0d6e2978c9c010eb7fc7aaaec100e367796b5dd08f`，loopback/secure transport/TLS require；不是verify-full证明。
- 构建回执（原始材料仅本地保留（见原SHA索引））全阶段0，binary `8ddd766e24e3a14a13f8c57020aa6a0043934289658e1334f94df04bcf31824d`，receipt `85ab5f34bafc1f86223444e0859d910863844df4e282f44d3e8a3dcf3a5761a4`。
- 精确97宿主纯测试=旧88+新增9，临时5条门槛纯反例另列；不是97或102条GUI。旧core2/model21/native12未在本轮重跑，不相加。
- 保留原19直接来源，新增完整值三关键依赖后为22；本切片在新candidate initial及后续八阶段的六来源摘要、初始材料和22source完全一致。DOM `4421b161320deb192c21ffb77ce60137acabb42e3edb11eb956f53a5b532c92c`、runner `a76672f8538f38446e65cb43fa5497926a8cdc24924fe7fd8bdc481464025331`。
- 正式flags证明（原始材料仅本地保留（见原SHA索引））：2JS/35测试标记全无，frontend-only，不是正式发布产物。
- 真实渲染DOM上的程序化click/input/dblclick，`native-dom-synthetic`，不是OS可信鼠标键盘。43click/5input/3dblclick/0keydown，4578ms包含独立观察，不能当性能指标。

## 实际值与完整性

新本run专用 `gui_txt_<run>` 表、INT主键1、LONGTEXT/JSON各一列；初始805/1/2/0及precision11/paging9素材保持。两正常SQL创建/插入、正常seed提交，树打开；全过程无隐藏测试SQL RPC或修值操作。

| 项目 | 旧值 | 精确新值 | 判据 |
|---|---|---|---|
| LONGTEXT | `长😀`重复800加`\|BASE-END\|` | `改🚀`重复900加`\|EDIT-END\|` | Unicode码点1610→1810，UTF8字节5610→6310，完整SHA而非前缀 |
| JSON大整数 | `9007199254740993`数字 | `9007199254740995`数字 | 原始数字词法、正常SQL CAST原strings、JSON_TYPE严格`UNSIGNED INTEGER` |
| JSON UTF8 | `你好😀` | `改后🚀` | `E4BDA0E5A5BDF09F9880`→`E694B9E5908EF09F9A80` |
| JSON嵌套 | flag=true/items=[1,"x",null]/padding=J×1200 | flag=false/items=[2,"y",null]/padding=K×1300 | whole canonical SHA与正常SQL完整`json_exact_match=1`在commit前共同核对 |

两格初始/应用/提交后实际预览均为1000码点加ellipsis，prefix SHA按独立全文对应前缀验证；未把正确截断当丢失。实际完整值readonly textarea的原字符串独立哈希；两编辑器先正常fetch全文，其原值逐字符等先前viewer，再正常输入/保存。local dirty全文查看不发多余fetch。八次normalviewer和两editor共实际fetchCellValue成功8、失败0，四checkpoint累计2/4/6/8。

JSON cell没有经whole JSON.parse→Number→重整。草稿compact JSON SHA `fed76e9b4f53cc144678ae795b5f3f7c8bbac21211266790e6cb547fbfa6bff5`；MySQL正确规范化后的新JSON SHA `79a7775d789af4082cadbdf463e8ffa804e75e91f0b0d1515370d0b3cfc9cf36`。两个SHA本就可以不同；父端固定literal只读normalization oracle不向UI注入canonical。

| 阶段 | 实际全文pair SHA | 外部fresh数据 | 当前UI |
|---|---|---|---|
| baseline | `40419e3e523c626e4d60be4df03374a6f049c93de7b9ab4ebe64de2cf6669290` | 精确旧值 | false/0、dirty0 |
| draft | `cd38f3e526895fd33ff255c7c0f82fe2508060de7f9ca18697190ffadc2aea11` | 仍精确旧值 | false/0、dirty1 |
| applied | `bcd2020e7d96971cd461e2260053571d31a3cf7a5b28d6980d7ed5d15837244f` | 仍精确旧值 | true/1、dirty0 |
| committed | 同applied完整pair | 精确新值 | false/0、dirty0 |

正常SQL见证连接177，应用后可见新LONGTEXT/JSON完整hash与995/U/UTF8/完整相等标记1；正常提交后原query标签通过工作台自动reload，仍177且新投影SHA `d739d493c9e6ea586ea7dea4cf3ee530576cb96bf0ff17368ed0d954bf478a4e`相同。外部旧投影 `ec7adb68ee9a3df18e72fbf845dd045f3707c99cd51e2c5bad7b7b0f83befae5`仅在commit后变新。独立最终该GUI事务COUNT0。

实际native：executeStatement成功3、applyEdits成功1/oktrue/affected1/inTransactiontrue/outcome1/failed0/errorClassnone，commit成功2（seed+正常网格提交），rollback0，最后实际事务false/0。lastApplyResult.inTransaction=true只是过去批次元数据，不当当前状态。19项UI检查全真、四原始确认与ack逐项对应，正常退出0，无超时/原始日志输出。

## 同候选九阶段

| 阶段 | PID | 原始联合回执 | 结果 |
|---|---:|---|---|
| initial | — | [initial](../evidence/gui-text-initial-a1b30670.json) | 0 |
| 完整值/JSON | 38529 | [Text](../evidence/gui-text-joint-38529.json) | VERIFIED/19真/0 |
| 六字段精确值 | 40314 | [precision](../evidence/gui-text-precision-40314.json) | 0 |
| 1062/OFF事务保留 | 41113 | [duplicate](../evidence/gui-text-duplicate-41113.json) | 0 |
| 1213事务结束/草稿保留 | 42113 | [deadlock](../evidence/gui-text-deadlock-42113.json) | 0 |
| 1205/OFF/session5 | 43450 | [timeout](../evidence/gui-text-timeout-43450.json) | 0 |
| samecandidate restart | 45500 | [restart](../evidence/gui-text-restart-45500.json) | 0 |
| 普通tabular EXPLAIN | 46316 | [explain](../evidence/gui-text-explain-46316.json) | 0 |
| 正常SQL提交 | 46707 | [commit](../evidence/gui-text-commit-46707.json) | 0 |

19份原始JSON已不可覆盖归档。[九阶段摘要](../evidence/gui-text-nine-phase-a1b30670.json) SHA `70b4a340e5fd7085a89eeef982fe13118c8f99313d469db730d898eadceee58f`；[Text联合](../evidence/gui-text-joint-38529.json) SHA `0f076d3de77d734f5835bab06052ffbfdeff9b11259dc52718fd29f29ddffff8`。摘要中的Text最终表值是该phase结束时的独立读回，不虚称在全部九阶段之后又做一次读回。

## 保留的验收层问题与首次INFRA

源码D2曾定位两项harness缺口：仅部分scalar/actualSHA自洽可漏掉嵌套错误后的提前commit；负分支套green fetch2成功下限会洗掉错误truncated=false绕fetch的0/1场景。已先存纯反例红，再分别修为正常SQL全JSON相等闸及负分支按实际calls保真，绿色仍2/4/6/8成功零失败。五条纯门槛回归不是产品红绿或GUI数。

首个真实run4521/PID20203在正常commit前停INFRA：MySQL真实JSON_TYPE是U而harness预设INTEGER，实际应用后完整pair/JSON SHA均准确；normalwitness按U重建SHA也准确，fetch6/apply1/execute3/commit1只有seed。正常网格提交未执行，UI退出1后GUI678独立事务结束、外部仍精确旧值、素材保持。独立固定literal只读查询确认两值均U且995精确，因而只严格修正两处验收类型字面量，不宽松允许I/U，不修业务。该失败的10raw/原表/环境保留，未reset/reuse。

[类型预设失败摘要](../evidence/gui-text-type-infra-4521e487.json) SHA `607c6be97ab5356e168571a73819cb58f42366b4543d7c29fab305771e91adad`，其独立数据D2通过。它不算产品红例，也不算通过；当前a1b3是新candidate/newrun实际通过。

## 仍需验收

不提升task78为全类型完成：DATE/DATETIME6/TIMESTAMP6/TIME微秒/时区、BIT/BOOL/BLOB写、浮点/范围负例、大/复合键、插入/defaults/多行等继续。这里仅固定大小单行两列正例；剪贴板、JSON结构化树/formatter、无效JSON、更多大小/控制字符/Unicode截断边界未验，UTF16计数字样不等Unicode码点证明。

可靠大表分页、其他写事务/ON/default50/网络/COMMIT未知与跨tab、对象/导入导出/ER比较、复杂EXPLAIN/参数、跨构建凭据真实失败、TLS verify-full/SSH、8.4/Windows/OS可信输入/8小时稳定性、参考dbx/DBeaver实操仍未完成。未提交、推送、打标签或正式发布。
