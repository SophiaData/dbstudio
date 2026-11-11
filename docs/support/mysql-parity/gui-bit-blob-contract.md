# MySQL BIT/BLOB 二进制显示与写回合同（下一 binary slice，未实施）

**Goal:** 为 MySQL BIT(1)/BIT(64)/可空 BLOB 定义一个最小 binary slice 合同。**本首 slice 只做 BLOB 列编辑**：BIT(1)/BIT(64) 本 slice 保持只读展示 + 数值精度验证；BIT 的编辑 shape／位宽／前导零写回明确留给后续 Goal（缺口保留，不删除）。本文件只定义合同，不含实现。

**Architecture:** 沿用既有 grid-* 同构 harness（Native DOM→Rust→owned synthetic MySQL→独立只读 observer；cp/ack 16KiB/2KiB、origin/run/root/probe/namespace/private-file guards、source23direct+fresh artifact/fresh run+6 项 provenance 均保留）。旧来源全名保留，新增直接依赖按实际追加，不写死 magic 数量；不 new arbitrary SQL/path RPC。本切片不阻塞当前 freshbuild/Native 验收。

**Tech Stack:** Vue3/TypeScript、Tauri2/Rust、MySQL 8.0.46、Node 只读投影。2026-11-10 Asia/Shanghai。

## 一、当前真实支持（源码证据）

- 驱动读路径：`crates/dbstudio-drivers/src/mysql.rs:68`，`MValue::Bytes` 且 `character_set()==63` 且列类型不属于 DECIMAL/NEWDECIMAL/JSON → `network.rs:53` `blob_cell` → `{kind:'blob',previewBase64,length,truncated}`；预览上限 256B（`network.rs:54`），`full=true` 时整段字节（`mysql.rs:491` fetchCellValue）。
- 列类别映射：`mysql.rs:221-227`（查询页）与 `mysql.rs:98-104`（管理快照）同一套：TINY/SHORT/LONG/INT24→integer、FLOAT/DOUBLE→real、DATE/DATETIME/TIMESTAMP→date、DECIMAL/NEWDECIMAL/LONGLONG/JSON/TIME→text，其余按 `charset==63` → blob，否则 text。
- **category ≠ 原生类型**：`page.columns[i].type` 是规范化类别（`src/core/resultset.ts:25-42`，`ResultColumn.type` ∈ integer/real/text/blob/null/boolean/date/unknown），**BIT 与 BLOB 同落 `blob`**；category 不携带原生类型，**禁止按它假区分 BIT/BLOB**。
- **原生类型元信息（describe，既有）**：`src/core/model.ts:66-69` `ColumnDescription.typeName`（方言原始类型名）；MySQL 取 `information_schema.COLUMNS.COLUMN_TYPE`（`crates/dbstudio-drivers/src/mysql.rs:270-272`；TS 路径 `src/drivers/mysql/adapter.ts:578/629-649`），形如 `blob` / `varbinary(32)` / `bit(64)` / `tinyint(1)`。表级描述经 `tab.description.columns` 到达 UI（`ResultGrid.vue:97/125`）。
- 驱动侧二进制写回通道已存在：`network.rs:57-66` `cell_param`，`kind=blob` → `{"$binary":base64}`；`truncated==true` 直接拒绝（"不能写回截断值"）；`mysql.rs:48` 解 `{"$binary"}` → `MValue::Bytes`；`mysql.rs:382/389` applyEdits 的 changes/keys 均走 `cell_param`。
- UI 只读二进制视图存在：`ResultGrid.vue:85` blob 走 `readCell`；`result-export.ts:19` blob → `"0x"`+大写 hex（由 `previewBase64` 解出），`result-export.ts:21-27` 截断时经 `backend.fetchCellValue` 取全量；`CellViewer.vue:19` 标题"只读完整值 … 十六进制"。
- 类型别名事实：MySQL BOOL 即 TINYINT(1)。`mysql.rs:99` TINY→integer；`mysql.rs:65-66` Int/UInt→`kind:'number'`，超过 2^53-1 降级为 `text_cell`。仓库内无 boolean wire type，无 BIT 专用分支。

## 二、当前真实缺失（源码证据）

- 无二进制编辑入口：`ResultGrid.vue:85` 条件 `cell.kind !== 'blob'` → blob 只进只读查看器；`ResultGrid.vue:117` 显式 `throw new Error('二进制单元格只读')`。
- 无 hex→字节解析：`workbench.ts:69-78` `inputCell` 仅处理 number/integer/real/boolean，其余一律落 `{kind:'text'}`，不会产出 `kind:'blob'`。
- 无 blob CellValue 生产者：`resultset.ts:62` 定义了 blob 形状，但 UI 侧无任何代码构造它；`workbench.ts:60-68` `cellText` 对 blob 仅显示 `[BLOB n bytes]`。
- **无"按原生类型判定可编辑"的入口**：现有 UI 只看 `cell.kind==='blob'`（`ResultGrid.vue:85/117/125`）与 `page.columns[column].type`（category），任何位置都没有用 describe 的原生 `typeName` 区分 BIT 与 BLOB → 本 slice 需新增这一条最小判定流（见五 A）。
- BIT 无专门语义：`mysql.rs` 全文无 `MYSQL_TYPE_BIT` 分支，BIT 列类别取决于服务端上报 charset（63→blob 落法；非 63→text 落法）。若落 text 分支，`mysql.rs:68` else 分支对非 UTF-8 字节 `from_utf8` 失败 → 整条 SELECT 报错，这是最严重的可能形态。
- 位宽/前导零语义不存在：驱动只持有字节与字节长度（`network.rs:54-55`），不携带 BIT(n) 声明宽度，也无 information_schema 宽度参与显示；**本 slice 不宣称该语义已完成**。
- 类别期望取自既有正确语义：`docs/support/mysql-parity/mysql-driver-gaps.md:56` 已把 BLOB/BINARY/VARBINARY/BIT 记为"部分"，明确"BIT 无专门布尔/位串语义"。本切片不得把实际观测到的落法偷换成既定期望，也不得假发明 boolean wire type。

## 三、本切片范围与最小合成 case（全部合成、自有 run、无生产数据）

新建表 `gui_bin_<run32>`：`id INT PRIMARY KEY, b1 BIT(1) NOT NULL, b64 BIT(64) NOT NULL, bin BLOB NULL`（InnoDB，库继承 utf8mb4）。

| id | b1 | b64 | bin |
|---|---|---|---|
| 1 | b'1' | b'1111111111111111111111111111111111111111111111111111111111111111' | X'00FFE4B8AD' |
| 2 | b'0' | b'1' | X'00' |
| 3 | b'1' | b'1' | X'' |
| 4 | b'0' | b'1' | NULL |

- 读覆盖：4 行 × 3 目标列 + id PK 定位。bin 的 X''（零字节）与 NULL 必须区分；X'00FFE4B8AD' 含 00/FF 与 e4b8ad，用于验证字节不被隐式 UTF-8 文本化（字节数 ≠ 字符数）。
- 写覆盖：仅单行（id=1）编辑 **BLOB 列 `bin`**；多行批量编辑不在本切片；**BIT 列本 slice 不进入编辑路径**。
- BIT 值一律用位串字面量 `b'…'` 写入；不得用十进制数值暗示位宽；seed 数值不因实际观测不符而改写（N1：id=1 的 BIT(64) 字面量 64 个 1 已正确，保留）。

## 四、实际 UI 路径（真实控件）

1. 连接→树打开 `gui_bin_<run32>` → 结果网格点/双击目标单元格（`ResultGrid.vue:81-87` `openCell`）。
2. 现状（能力红）：blob 单元格进入只读 `CellViewer`（`result-export.ts:19` 输出 `"0x…"` hex 文本），不出现编辑对话框；编辑路径 `ResultGrid.vue:117` 显式拒绝。能力红证据＝真实 DOM 缺可编辑入口/控件被禁用 + 正常 observer 确认库中值未变。
3. 目标（绿，分两种）：**BLOB 列**进入既有 modal（`ResultGrid.vue:193`）编辑，textarea 为 raw hex，NULL 复选框沿用既有 `isNull` 语义；**BIT 列**本 slice 保持只读 `CellViewer`，**不得**出现编辑对话框，仅做数值精度验证（见六）。不得新建独立组件或新 IPC 方法。

## 五、本 slice 政策

### A. 可编辑判定（唯一允许依据：原生类型）
- 依据 `tab.description.columns[i].typeName`（原生 `COLUMN_TYPE`）判定；BLOB 家族 = `blob`/`tinyblob`/`mediumblob`/`longblob`/`varbinary(...)`/`binary(...)`（匹配时忽略尾部 `(n)`）。
- `bit(...)` 任意宽度 → 本 slice 一律 readonly，不进入编辑路径；`typeName` 缺失/不可靠 → **safe readonly** + 记能力红；不得 hardcode 验收列名，不得对全部 `kind==='blob'` 开放编辑。

### B. raw hex 编辑政策（仅 BLOB）
- 仅接受 hex 字符 `0-9a-fA-F`，允许首部 `0x`/`0X` 前缀（显示层沿用现有 `0x` 风格）；空白、逗号、`0b` 前缀等其它字符一律拒绝；奇数长度拒绝（拒绝原因固定并可见）。
- 空输入 = 零字节 BLOB（X''），**不等于 NULL**；NULL 只能由 NULL 复选框产生（`resultset.ts:58` `kind:'null'`）。
- 产出 CellValue 形状固定 4 key：`{kind:'blob',previewBase64:base64(bytes),length:bytes.length,truncated:false}`（`resultset.ts:62`；`network.rs:53-56`）。禁止写 `kind:'text'`，禁止经 JS Number 或 UTF-8 转换。
- `truncated:true`（>256B）不在写回能力内（`network.rs:58` 拒绝截断值）：UI 不得以部分字节提交，>256B 一律只读且禁止预览回写；scope 既定不扩。
- BIT 的"仅十进制字符串或位串"表达 → **降为未来编辑规范**，不与本 slice 的 blob DTO 混用；本 slice 不产出 BIT 的编辑 DTO。

### C. N2/N3/N5（一次写清）
- **N2** 打开 BLOB 编辑器预填：当前完整值的**大写 hex、无 `0x`**；空 blob → 空字符串；NULL → `isNull=true`。不得用 `cellText` 占位（`workbench.ts:60-68` blob 仅显示 `[BLOB n bytes]`）。
- **N3** NULL binary 列按同一原生类型走同一编辑器；`kind:'blob'` 与"新建 NULL"切换必须准确（`resultset.ts:58` `kind:'null'`）。
- **N5** 非法 hex（奇数长度／非 hex 字符）必须在客户端拒绝：不 submit、不产生 dirty。本 slice 不做真实负例场景，但**不得因此取消该安全约束**；其余归入"完整非法输入/文案矩阵未覆盖"。

## 六、独立 SQL oracle（只读 observer，与 GUI 不同连接）

- BLOB：`HEX(bin)`、`OCTET_LENGTH(bin)`、`LENGTH(bin)`、`bin IS NULL`；BIT（只读观察项）：`HEX(b1)`、`HEX(b64)`、`BIN(b1)`、`BIN(b64)`、`CHAR_LENGTH(BIN(b64))`、`CAST(b1 AS UNSIGNED)`、`CAST(b64 AS UNSIGNED)`。
- 比较规则：
  - **BLOB 原始 full hex 取自既有 CellViewer/结果导出**（`0x`+大写 hex，`result-export.ts:19`）；**不得把 grid 的 `[BLOB n bytes]` 当 hex**。
  - BLOB：去 `0x` 前缀、转大写后与 `HEX(bin)` 逐字符严格相等；长度 = `OCTET_LENGTH(bin)`；NULL / X'' / X'00' 三者相互独立，不得互相等价。
  - BIT（只读主门）：将 GUI full hex 按**无符号大端**用 BigInt 解码为**十进制字符串**，与独立 `CAST(b1 AS UNSIGNED)` / `CAST(b64 AS UNSIGNED)` 一致，再与 BIN/CHAR_LENGTH 交叉核对。**不得用 JS Number，不得经隐式 UTF-8 转换**。
- BIT 原生字节宽度与 HEX 行为（是否补零、补到几位）**实测记录**；宽度未钉死前，**不把 padding 宽度差异当产品红**。
- 期望值来自独立 DB truth，**不得用 GUI 实际值反填期望**。
- oracle 只读、限本 run 自有库；不接受外部 SQL/path。

## 七、事务可见性检查点（固定为 A/A→B/A→B/B）

- 全部 seed/create/insert 走**自有正常 UI SQL**，正常 commit 一次，A 已提交；独立 observer 只读 A。**绝不**用外部 SQL UPDATE 制造 A/B 差异。
- 三个检查点窗口：① stage B（dirty=1）→ 同连接 DB 仍 A、外部仍 A；② apply affected=1 → **同一 Native CID** 下 DB witness=B、外部仍 A；③ commit → **自动重载**后展示 B，同 Native B、外部 B。
- 记录：stage/apply/commit 三窗口 + CID/NativeTx & P_S/indepHex/len/NULL/退出后 known threads=0。
- **禁止**"没有自动 reload 就手动点刷新"兜底绿：未自动回读＝现要求下的实际产品红；保留手动操作的可能性，但不得计为本 slice 正常 autorefresh 通过。
- 旁证：正常 SQL readback 后须**切回原表 TAB** 再提交，在真实实现中观察 fresh data；不预造 native 固定次数。

## 八、失败判据

- 能力红必须来自真实 Native UI 控件缺失/禁用/值未变：正常双击 BLOB 单元格未出现编辑对话框（或出现后立刻报"二进制单元格只读"），且正常 observer 确认库中值未变。**不得**用 SQL UPDATE 或 observer 写操作冒充 GUI。
- 驱动读取失败（如整条 SELECT 报错）单列为产品红（驱动失败类别），不得改写成"UI 缺控件"，也不得为此偷调 metadata。**Lead 裁定（已有严格 0CP/优先级规则胜出，优先于本条）**：只有证据完整（真实 4 行 + 同 CID witness + 有效 CP）且可 verified 后，独立 joint 才可依对应 typed error 认产品缺口；早期 **table-open 预览 SELECT 失败 / selector 未开 / 尚无真实 4row+sameCID witness+有效 CP** 一律 `INFRA_ERROR`，保 UI 实际 typed `failureCode`（`TABLE_OPEN` 或 `BINARY_READ_FAILED`）与原诊断，**不作 BLOB 能力红**、**不得**捏造 4 行、**不得**先叫 driver 产品红；`TABLE_OPEN` 明确包含预览 SELECT 的早期失败（不改 DOM 错误触发路径、不新 SQL/RPC、不改 16 闭集/shape/固定数据/metrics）。
- 绿：对话框出现 → 合法 hex 输入 → 保存到本地修改（dirty=1）→ 应用修改 affected=1 → 正常提交 → **自动重载后**网格 hex 与独立 oracle 一致；BIT 只读门与数值精度门同时绿；同时跑现有关键回归（时间/精度/文本切片不被破坏）。
- known-red 需保留原始 DOM、原始值与独立 observer 证据；只有失败码或缺字段 → INFRA，不算产品红。

## 九、预计最小修改范围（文件级，本切片不实施）

- `apps/desktop/src/components/ResultGrid.vue`：新增"按原生 `typeName` 判定可编辑"的最小分支（放行 BLOB 家族、拒绝 BIT），在既有 modal 内加 raw hex 编辑与 NULL 交互；不新建组件。
- `apps/desktop/src/workbench.ts`：`inputCell` 增加 hex→blob 分支，产出 4 key `kind:'blob'`；非法 hex 客户端拒绝。
- `src/core/resultset.ts`：仅在需要 blob 形状校验时最小扩展。
- `crates/dbstudio-drivers/src/mysql.rs`：默认不改；仅在真实观察证明 BIT 列类别/文本落法确有问题时才增 BIT 专门分支。
- 不改 `src-tauri` 协议、不改依赖/配置/环境、不新增 helper 或临时脚本。

## 十、未覆盖矩阵（明确 goal open）

BIT 编辑（shape／位宽／前导零写回）、BOOL/TINYINT(1) 别名列、VARBINARY/BINARY、GEOMETRY/SPATIAL、BLOB>256B 写回、完整非法输入/文案矩阵（仅保留最小安全约束）、只读连接、无主键表、多行批量编辑、剪贴板、浮点与大整数其它类型、插删行、既有时间/精度/文本切片完整回归、性能与 soak、ref apps 8.4 / Windows / OS / Trusted / 跨构建恢复。本切片不宣称 full types、production ready、已实施或已验收。

## 十一、有限验收协议（grid-bit-blob harness 合同；本 slice 只补 harness，不含产品实现）

### 11.1 定位、命名、固定数据与两组 scope

- 本 slice **只做 harness**（DOM+runner+host/lib+builder 的 bounded test-only phase），**不含任何产品实现**；首跑目标是**真实复现 BLOB 只读能力红**（`READ_ONLY_BINARY`），再据该红证据另起 slice 改 ResultGrid/workbench，当前**禁止任何产品代码预修**；phase `grid-bit-blob`、方法 `mysqlAcceptanceBinaryCheckpoint` / `mysqlAcceptanceBinaryContinue`、CLI `--run-grid-bit-blob`（runner 参数白名单同步追加，其余与既有 9 phase 不变）；沿用既有全部 guards（origin/run/root/probe/namespace/private-file/secret-storage），**不新增任意 SQL/path RPC**，DOM 不得自带 SQL，只发自己已执行的正常 SQL 之读回结果。
- 数据集（owned 合成库）：库 `mysql_accept_<run16>`、表 `` `gui_bin_<run32>` ``、4 行 4 列（id/b1/b64/bin），bin 原生类型 `blob`；seed 与行值沿用三章（§三），**本 slice 唯一变更 row1 bin**：A=`X'00FFE4B8AD'`（5B）→ B=`X'00FF004142'`（5B），textarea 输入 `00FF004142`（**大写、无 0x 前缀**）；row2=`X'00'`、row3=`X''`、row4=NULL 与 bit1/bit64 全部**不变**；只做 row1 单行单列写，NULL/empty 仅只读观测，**不覆盖** full NULL 写。
- 组A（DOM+runner）：`apps/desktop/src/mysql-parity-dom.ts`（新 phase 分支 + `runBinaryDom`）、`scripts/mysql-ui-acceptance.mjs`（`watchBinary` / `verifyBinary` / `runGridBitBlob` / CLI）；组B（host+lib+builder）：`src-tauri/src/mysql_acceptance.rs`（phase 上下文、两方法、request/ack/stage/proof 校验、`binary` 快照段、新测试名）、`src-tauri/src/lib.rs`（方法派发）、`scripts/build-mysql-acceptance.mjs`（source 清单双向对齐）。
- **不新增文件**：source 清单仍为 23 项（runner `SOURCES` 与 builder `sourcePaths` 同一集合、逐项双向相等）；任一组若新增文件必须**两处同时**登记并由 builder 实际列表反查，数量以 actual 为准；旧 host 测试**126 个全名保持不变**（只追加，不改名不删除），新增测试名以 host 实际列表为准，合同不预设名。

### 11.2 文件与 CP / Continue / ack 协议

- 文件：`binary-checkpoint-<pid>-<step>.json`（≤16KiB）、`binary-ack-<pid>-<step>.json`（≤2KiB）；目录 0700 / 文件 0600、`wx` pending + `fsync` + 单写者 `rename`（目标必须不存在；不删、不覆、不移动）；**CP envelope exact6** `{schemaVersion,runId,phase,pid,report,observations}`（`phase='grid-bit-blob'`）。
- **request exact10**：`{schemaVersion:1, step:'baseline'|'draft'|'applied'|'committed', uiActive:boolean, uiPendingAffected:int0..1000, dirtyRows:int0..1000, rowsSha256:64lowerhex, witnessConnectionId:positiveSafeInteger, witnessProjectionSha256:64lowerhex, columnCategories:[4 个表头类别，固定序 id,b1,b64,bin，取值 ∈ integer|real|text|blob|null|boolean|date|unknown], blobEditableEntry:boolean}`；≤2048B；**不含 SQL、路径、期望值**。
- **Continue**：args2 `{schemaVersion,step}` → return2 `{ready,verified}`（exact2 键，均 boolean）；前序 ack `verified=true` 才推进下一阶段；`ready=true&&verified=false` → 停（不再发下一阶段）。
- **ack exact7**：`{schemaVersion,runId,phase,pid,step,proof,verified}`，`proof` = request 原样（10 键），≤2KiB；`verified=true` 只表示**协议合法 + 独立只读读完成**，**不表示与期望相符**（期望比对只在 joint 判定做，红照实记）。
- step 集合固定 4：`baseline|draft|applied|committed`（顺序固定；缺后续阶段只允许 null）。

### 11.3 UI report schema 与 SHA 口径

- 沿用 9 键 UI report：`{schemaVersion,runId,phase,actionDriver,checks,proof,actions,elapsedMs,failureCode}`（≤16KiB，`actionDriver='native-dom-synthetic'`）；`actions` exact4 `{click,input,keydown,dblclick}`；**host 校验只做 schema/类型/范围，不预拒真实红**：`failureCode≠NONE` 时允许 checks 部分 false、允许后续 stage 为 null、原值照实保留；只有 `failureCode=NONE` 才要求 12 项 checks 全 true。
- **proof exact8**：`{rowCount:4, columnCount:3, rows:[row×4], rowsSha256, columnCategories:[×4], readonlyGap:gap|null, editorOriginal:editor|null, stages:{baseline,draft,applied,committed}}`；`columnCount:3` 明确指**不含 id 的 3 个 binary 目标列**（b1,b64,bin），而 `rows` 每行的 `id` 是行定位键（含 id），两者口径不同但**不改 row/proof 的 8 键 schema**。
- **row exact8**：`{id:int1..4, b1Hex:string|null, b1Decimal:string|null, b64Hex:string|null, b64Decimal:string|null, binHex:string|null, binByteLength:int|null0..256, binIsNull:boolean}`；hex 一律**大写、无 0x**；十进制一律**字符串**（BigInt 解码，**禁止 JS Number**）；空串 = 零字节、`binIsNull=true` = NULL，二者与 `X'00'` 三者独立。
- **stage exact12**：`{rows:[row×4], rowsSha256, targetRowId:int=1, targetBinHex:string|null, targetBinIsNull:boolean, columnCategories:[×4], blobEditableEntry:boolean, uiActive:boolean, uiPendingAffected:int0..1000, dirtyRows:int0..1000, witnessConnectionId:int>0, witnessProjectionSha256:64lowerhex}`；只读缺口首跑时 `draft/applied/committed` 为 **null**（**不得**硬 require 已执行）。
- **gap exact5**：`{viewerOpened:boolean, viewerTitle:string|null≤64, viewerHex:string|null≤128（含 0x 原文）, editorDialogPresent:boolean, inlineErrorText:string|null≤64}`；`editorOriginal` exact4 `{raw:string|null≤64, isNull:boolean, valueDisabled:boolean, nullDisabled:boolean}`（未打开编辑框时为 null）。
- **checks exact12**：`storage_marker, persisted_connection, credential_reconnect, fixture_created, table_open, column_categories_read, baseline_rows_read, bit_readonly_observed, blob_editable_entry, local_edits, apply_succeeded, committed_reload_verified`。
- SHA 口径（DOM 生成、runner 独立重算并逐项核对，**不得**把 observed 改成 expected）：`rowsSha256 = SHA256(JSON.stringify({rows:[r1,r2,r3,r4]}))`，行按 id 升序、每行键序固定 `id,b1Hex,b1Decimal,b64Hex,b64Decimal,binHex,binByteLength,binIsNull`、null 记 null、字符串原文、不排序/去重/换序，runner 必须按同一固定键序重建对象再算；`witnessProjectionSha256 = SHA256(JSON.stringify({columns:[7 别名],rows:[4 行]}))`，7 别名固定序 `b1_hex,b1_dec,b64_hex,b64_dec,bin_hex,bin_len,bin_null`；**同连接 witness 查询固定 8 列（1 个 CID + 7 个 projection）且别名稳定**：`SELECT CONNECTION_ID() AS connection_id,HEX(b1) AS b1_hex,CAST(b1 AS UNSIGNED) AS b1_dec,HEX(b64) AS b64_hex,CAST(b64 AS UNSIGNED) AS b64_dec,IF(bin IS NULL,'NULL',HEX(bin)) AS bin_hex,IF(bin IS NULL,'NULL',CAST(OCTET_LENGTH(bin) AS CHAR)) AS bin_len,CAST(bin IS NULL AS CHAR) AS bin_null FROM ownedtable ORDER BY id`；**7 个 projection 全为字符串**：NULL 的 BLOB 其 `bin_hex`/`bin_len` 规范为字面 `"NULL"`，非 NULL 的空 blob 为 `bin_hex=""`/`bin_len="0"`，null 标志 `bin_null` 为 `"1"`/`"0"`；**CID 不进 SHA 投影**，同一连接 4 行 CID 必须全同，SHA 的 `columns` 数组固定为上述 7 个别名；**父进程独立 oracle 用同一 7 列投影但不带 CID**（oracle 自身连接的 ID **不得**当作 owned CID）；**UI proof 的 `row.binHex`/`row.binByteLength` 为 NULL 时是 JSON `null`**（与 witness 的字符串 `"NULL"` 不同形），须按 `bin_null` 明确转换后再比较，**不得**把空 blob 与 NULL 混为一谈。

### 11.4 Host native 快照与 failure 闭集

- `grid-bit-blob` phase 的 snapshot **必须**含唯一新增段 `binary`，exact2 `{lastApplyResult, lastObservedTransactionState}`；`lastApplyResult` 形如 `{ok,affected,inTransaction,outcomeCount,failedOutcomeCount,errorClass}`（applyEdits 之后）或 null；`lastObservedTransactionState` 形如 `{active,pendingAffected}` 或 null；**不允许** `temporal`/`crosszone` 等别名段，**不允许**缺失即跳过（缺 `binary` → schema 错，不是跳过）；顶层 = scope/runId/phase/methods/keyringGets/keyringHits/keyringSets/guiVerified/mysqlVerified/storePersistenceVerified + `binary`（11 键）。
- **failure exact16**：`NONE, ISOLATION, CONNECTION, FIXTURE_OPEN, TABLE_OPEN, NATIVE_BRIDGE, CHECKPOINT, TIMEOUT, BINARY_READ_FAILED, READ_ONLY_BINARY, BIT_EDIT_ENTRY, EDITOR_VALUE_LOSS, APPLY_REJECTED, COMMIT_FAILED, BLOB_VALUE_MISMATCH, BIT_VALUE_MISMATCH`。
- **优先级（命中多条取序号最小）**：1 ISOLATION → 2 CONNECTION → 3 FIXTURE_OPEN → 4 TABLE_OPEN → 5 NATIVE_BRIDGE → 6 CHECKPOINT → 7 TIMEOUT → 8 BINARY_READ_FAILED → 9 READ_ONLY_BINARY → 10 BIT_EDIT_ENTRY → 11 EDITOR_VALUE_LOSS → 12 APPLY_REJECTED → 13 COMMIT_FAILED → 14 BLOB_VALUE_MISMATCH → 15 BIT_VALUE_MISMATCH → 16 NONE；1–7 = **不可判定档**（只能 INFRA_ERROR，**不得**记 KnownGap 产品红），8–15 = **产品红档**（可 KnownGapRed，须有真实 actual 支撑），16 = 全绿。**0CP 优先（Lead 裁定，优先于"驱动失败=产品红"）**：无有效 CP（早期 table-open 预览 SELECT 失败 / selector 未开 / 未取得真实 4row+sameCID witness）→ 一律 `INFRA_ERROR`，保 UI 实际 typed `failureCode`（`TABLE_OPEN` 或 `BINARY_READ_FAILED`）与原诊断，不作 BLOB 能力红、不捏 4 行、不先叫 driver 产品红；`TABLE_OPEN` 含预览 SELECT 早期失败；仅证据完整可 verified 后 joint 才可依对应 typed error 认产品缺口（16 闭集/shape/固定数据/metrics 与 DOM 错误触发路径均不变）。
- 判定要点：`READ_ONLY_BINARY` = 真实双击 row1 bin **未出现 `[aria-label="编辑单元格"]`**（只开 CellViewer）且独立 observer 仍为 A；**KnownGap 门槛另须 `readonlyGap.viewerOpened===true` 且子进程退出后最终独立 `reference` 仍为 A**（缺任一者不得记 KnownGap，按原 generic Infra 保 joint actual reference）；`BINARY_READ_FAILED` = 整条 SELECT 报错/列缺失/类别不可读（驱动红，单列；早期无有效 CP 者按 0CP 优先规则记 Infra 保真实 typed code）；`BIT_EDIT_ENTRY` = BIT 列出现编辑框（违反 BIT 只读）；`BIT_VALUE_MISMATCH` = UI hex 以 BigInt 解出的十进制 ≠ 独立 `CAST(b64 AS UNSIGNED)`；`BLOB_VALUE_MISMATCH` = UI hex/长度/NULL 与独立 `HEX`/`OCTET_LENGTH`/`IS NULL` 不等（含提交后未自动重载）；BIT 十六进制宽度差异**不单独**当产品红。
- **metadata 链缺失与"无 BLOB 编辑路径"在 DOM 层不可区分**，二者都归 `READ_ONLY_BINARY`；归因由源码级证据（Lead 复核）补足，harness 内不得猜测、**不得**把 DB 真值回填成 UI 期望。

### 11.5 阶段流程（DOM 侧，4 步固定集）

- **baseline**：读 4 行 × 3 二进制列 → 每格双击开 CellViewer（取 `textarea[aria-label="完整单元格值"]` 的 `0x`+大写 hex 原文，去前缀）→ 由 hex 以 BigInt 解出 b1/b64 十进制字符串 → 记行/类别/字节数/NULL 区分 → **尝试打开 row1 bin 编辑**（双击；**"不得出现编辑框" 仅适用于 BIT 列**；row1 BLOB 若编辑框出现则允许继续 draft，若仅出现 CellViewer 则记 readonly gap）→ 记 gap 证据 → 执行 1 次同连接 witness SELECT → 切回原表 TAB → 发 baseline CP → 等 ack；**若 row1 bin 无编辑入口（仅 CellViewer）** → 立即以 `READ_ONLY_BINARY` 收口：**只发 baseline CP + 只 1 个 ack**、`draft/applied/committed` 全部 null、app 正常退出（**不点刷新兜底**），独立 observer 仍为 A → joint 判 KNOWN_GAP_RED。
- **draft**（仅当编辑入口存在）：textarea 预填须为 `00FFE4B8AD`（大写、无前缀、isNull=false、两个控件均未禁用）→ 改为 `00FF004142` → 「保存到本地修改」→ dirty=1、uiActive=false、pending=0；同连接 DB 仍 A、observer 仍 A。
- **applied**：「应用修改」→ affected=1；同连接 witness=B（未提交）、observer=A；native active=true、pending=1、dirty=0。**committed**：「提交」→ **自动重载**后 UI 显示 B；native active=false、pending=0、dirty=0；observer=B；**禁止**"没有自动 reload 就手动点刷新"兜底绿。
- 每阶段：发 CP → 等 ack（`verified` 只代表协议+独立读完成）→ 顺序推进；某步红则**先发该步 actual 再停**，已发阶段证据保留，后续阶段不执行、不修 UI、不发纠值 SQL。

### 11.6 metrics 计划公式（基于实际已有正常 SQL/UI 路径）

- `executeStatement.success = 2 + K`（K = 已完成阶段数 1..4）：seed `CREATE TABLE`+`INSERT`=2，每阶段 1 次同连接 witness SELECT，failure=0；`commitTransaction.success = 1 + (K===4 ? 1 : 0)`（seed commit + 最终 commit）；`applyEdits.success = (K>=3 ? 1 : 0)`；`rollbackTransaction=0`；`fetchCellValue=0`（本切片全部值 ≤256B，走 preview 完整策略，不触发 fullCell 取值）；`insertRow=0`；`deleteRows=0`；`connectConnection.success≥1`；`keyringGets≥1,keyringHits≥1,keyringSets=0`。
- `previewTable` / `fetchResultPage` **不是** executeStatement，**不与** driver 单测/host 计数加总；首跑（能力红，K=1）期望 executeStatement=3、commitTransaction=1、applyEdits=0、rollback/fetchCellValue/insertRow/deleteRows=0；满程（K=4）期望 executeStatement=6、commitTransaction=2、applyEdits=1。
- 若首跑实测与公式不符（如真实多一次 SQL）：**不得静默改公式**，记为 infra 诊断项随首跑报告列出实际值，由 Lead 决定是否修订；文档公式保持计划口径。

### 11.7 runner 独立读与 joint 判定

- 每 CP 窗口由父进程做独立只读读（父 readonly observer / owned-CID P_S 复核），全部在单写者 ack 之前完成：**observer**（另一连接，只读）同 7 列投影读 4 行 → baseline/draft/applied 窗口必须为 **A**、committed 窗口必须为 **B**（applied 窗口 observer 必须仍为 A：未提交不可见）；**owned-CID P_S**（admin 连接，只读）`SELECT t.PROCESSLIST_ID,t.PROCESSLIST_DB FROM performance_schema.threads t WHERE t.PROCESSLIST_ID=<cid> AND t.PROCESSLIST_DB='<ownedDb>' AND t.PROCESSLIST_ID<>CONNECTION_ID(); SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id=<cid>;` → owned DB 匹配、trx count = 0（baseline/draft/committed）/1（applied）；**DB 原生类型**（只读）`SELECT COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='<ownedDb>' AND TABLE_NAME='<table>' ORDER BY ORDINAL_POSITION` → 4 行（读到什么记什么；期望 `int/bit(1)/bit(64)/blob`），**不得**用它回填 UI 期望。
- **joint 判定**：0 个 checkpoint → `INFRA_ERROR`（**不得**假 KnownGap）；`READ_ONLY_BINARY` + steps=1 + observer=A + DB 原生类型=blob（另须 `readonlyGap.viewerOpened===true` 且子进程退出后最终独立 `reference` 仍为 A）→ `KNOWN_GAP_RED`（能力红，保留原值：rows/hex/长度/NULL 全 actual）；未自动重载 → `BLOB_VALUE_MISMATCH` 产品红，**不得**用 timeout 洗 UI readonly；只有全 4 步 + raw actual + 12 项 checks 全绿 + native 计数符合 11.6 → `VERIFIED`（productionReady 仍 false，不宣称 full types/parity）。

### 11.8 证据 / dataset / report / source / provenance 映射与禁止清单

- **dataset**：owned 合成库 `mysql_accept_<run16>`、表 `gui_bin_<run32>`、4 行 4 列、seed 行值见 §三、唯一目标变更 row1 bin A→B（5B→5B）。
- **report map**：`binary-checkpoint-<pid>-<step>.json`（≤16KiB，满程 4 件 / 首跑 1 件）、`binary-ack-<pid>-<step>.json`（≤2KiB，满程 4 件 / 首跑 1 件）、host 快照 `host-grid-bit-blob-<pid>-<nonce>.json`（按 retain_snapshot 实际次数）、UI `ui-grid-bit-blob-<pid>.json`（host report ≤16KiB）、joint `real-ui-grid-bit-blob-<pid>.json`（≤256KiB：ui/native/lifecycle/trace/oracle/observer/finalTableReference/finalSessionCleanup/materialsPreserved/provenance）；归档 raw 件数以 actual 为准（每阶段 1 CP + 1 ack + host 快照按 retain 次数 + UI 1 + joint 1），**不预设总数**。
- **source map**：组A 2 文件 + 组B 3 文件（见 11.1）；source 23 双向清单不变；new artifact + fresh run 绑定（runId 不得复用既有 phase 证据）。
- **provenance（6 项 core gate 标量 + 额外一致标量 + source gate）**：core gate 唯一为 `runnerSourceSha256`（runner 源）、`fixturePinSha256`（fresh fixture pin）、`artifactReceiptSha256`、`binarySha256`、`frontendIndexSha256`、`frontendAssetsSha256`（new artifact）共 6 项；`fixtureSourceSha256`、`manifestSha256`/`containerId`/`imageSha256` 仍作**额外一致标量**保留，**不代替** `frontendIndexSha256`/`frontendAssetsSha256`，**不得因此丢掉上述 6 项 core gate**；source gate = `source`（23 文件映射）与 `manifestSha256`/`containerId`/`imageSha256` 一致；其余标量沿用 time phase 同名口径，**不新造字段名**。
- **禁止清单**：不改 `ResultGrid.vue` / `workbench.ts` / `src/core/resultset.ts` / `crates/dbstudio-drivers/src/mysql.rs`（产品实现另起 slice，且必须依据本 harness 的红证据）；不改既有 9 phase 任何行为；不新增文件/包装器/脚本；不新增任意 SQL/path RPC；不改依赖/配置/环境/Keychain/privatecfg/env/logs；不删、不移任何文件（备份与证据全留）；不宣称 full types、full parity、production ready、已实施或已验收。
