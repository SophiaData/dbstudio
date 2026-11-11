# v0.8.1 原生 backend 性能补充基线

状态：2026-11-07 本地 native core source 补充采样完成，两个隔离 Rust 进程均 exit 0；首轮 Python CSV validator exit 0。共 162 条样本见 [performance.csv](performance.csv)。本结果属于源码 backend 子项，已安装产品的 T4/T5 验收仍未完成。

| 场景 | 样本数 | 实际结果（ms） | 本轮结论 |
| --- | ---: | --- | --- |
| 805 行首屏 / 后续分页 | 各 20 | p95 0.887959 / 0.455209 | 数据正确；805 分页回绕且尾页 5 行 |
| 100000 行首屏 / 后续分页 | 各 20 | p95 0.502625 / 0.598916 | 数据正确 |
| 1000000 行首屏 / 后续分页 | 各 20 | p95 0.509833 / 0.602542 | backend 耗时低于计划数值门槛；未验证 GUI 响应 |
| 完整短循环 | 30 | 14.969833–51.114791 | 查询、分页、700000 字符完整值、小 CSV 导出、关闭结果均完成 |
| 100000 行 CSV 导出 | 3 | 1195.120 / 1172.969 / 1158.220 | 全部内容逐行核对通过 |
| 100000 行 CSV 导入（PERSIST fixture） | 3 | 767.391 / 764.562 / 744.936 | 独立空表、每行 ID/body/大整数均验证；不对比产品默认 journaling |
| 5 轮×10 结果打开/关闭 | 5 | 操作全部成功 | RSS 缺失，内存门槛未验证 |

计时使用 ms（毫秒），百万行查询只请求有序首 100 行，不扫描或返回百万行；这是已预热源码 backend 调用耗时，不是 GUI 亚毫秒响应承诺。公开 CSV 保留三位小数，p95 表使用原始摘要的完整精度。所有样本和异常值保留。

## 实际执行与联合证据

首轮 run ID：`perf-readiness-aeqfz0ye`，Rust 运行 4.884816 秒、exit 0。先执行 COUNT、首屏、分页正确性，再计时，因此 SQLite/OS 缓存已经预热；不是冷启动或清缓存冷查询。原始 `csv_export_100k` 仍保留 `pending-content-validation`；只有随后 Python validator exit 0、33 份 CSV（30 份各 3 行、3 份各 100000 行）逐行核对标题、ID 顺序、body 和精确大整数文本后，公开 CSV 的最终导出结果才标通过。`short_cycle` 原始 pass 表示流程成功，导出内容通过同样依赖这一联合 gate。harness 摘要没有 overall pass 字段，不能仅凭 summary 推断完整验收。

首轮 journal 设置成功，但原先以 `runQuery(PRAGMA journal_mode)` 读回被明确拒绝，全部写入按规则跳过；未修改 runtime。后续按 lead 指定改为普通 SELECT `SELECT journal_mode FROM pragma_journal_mode`，在全新 run ID `perf-readiness-255v7ns0` 的实际连接确认 `persist`，只执行导入专项（2.341835 秒、exit 0），未覆盖首轮素材/样本/摘要。三次分别进入空表 `import_perf_1..3`，计数各 100000，每行 ID 范围、body 与大整数文本均核对。合成重复主键导入失败后目标 0 行；取消请求接受、终态 cancelled、目标 0 行。两项随后均正常关闭。第二轮没有重新采样查询或导出。

RSS 采集全部缺失。唯一诊断探针得到自身 PID 的 `/bin/ps` spawn `PermissionDenied`，之后停止采集，未换系统入口。公开 CSV 保留空 RSS，结果关闭循环只表示操作成功，不表示内存增长/回收阈值通过。不能从本轮得出应用 RSS、峰值、泄漏或稳定性结论。

source/app version 常量属于依赖基线标签，设备信息由本轮 lead 的 environment 记录提供；harness 自身不验证 OS/发布包。lead 已独立确认主 Cargo/lock 与 core/drivers/protocol 相对基线无差异且无这些路径的新文件；实际测的是本地 path dependency 的优化构建，不能替代已发布 `.app` 的验证。两位队友对临时 harness/validator/Cargo 做过限定只读 D2 review，确认 p95、预热、分页、PERSIST 门控及导出联合 gate 口径；未发现阻止执行的确定问题。

- 来源提交：`7fadb00d6f9ee2cbf87949e9f908517c508a2956`，版本 `0.8.1`。
- 设备口径由本轮 lead 提供：macOS 27.2 arm64、8 cores、16 GiB；未采集序列号、其他进程或系统环境变量。
- 公开样本测量范围固定为 `native_core_source`（私有原始输出写作 `backend`）：隔离 Rust harness → `dbstudio_core::Application` → 原生 SQLite driver。使用 `MemorySecretStore` 和独立新 appdata。
- 不启动已安装 App、Tauri 或 WebView，不把本结果称为 GUI 可见耗时、产品启动耗时或全应用 RSS。
- 本轮私有证据目录：[perf-readiness-aeqfz0ye](../../../../backups/perf-readiness-aeqfz0ye/materials-manifest.json)。harness、复制素材、所有导出及原始样本均保留在该独立目录，不清理、不进入发布附件。
- 三份 SQLite（805、100000、1000000 行）和两份 CSV 仅从 lead 明确授权的本轮合成素材复制，以排他创建新文件并核对 SHA-256；不修改来源素材。
- 临时独立 Cargo workspace、独立 target；使用本机已缓存的离线依赖与复制的锁文件，稳定后 `--offline --locked` 编译。主 workspace 锁文件不修改。性能执行采用临时工程默认 release profile（优化构建），不冒充与发布包链接参数完全相同。

## 测量方法

先逐库验证计数、首 100 行和后 100 行的完整 ID、body 及精确保留的 64 位大整数文本。每库一次预热查询不入样本。每库首屏 20 次，按主键排序、limit=100；后续分页 20 次，百万行与十万行从 offset=100 连续翻至 2000。805 行库因只有 8 个后续页面而循环这 8 页，末页实际 5 行，单独记录，不能宣称 805 行也有连续 20 个不同页面。

各数据集分别排序计时，20 样本的 p95 取第 19 个值，不插值、不删异常样本。计时为同步 Application 调用墙钟时间，包括 core/driver 与 JSON 结构建立；不包括测试断言、关闭游标、外部 RSS 采集或 GUI 渲染。

RSS 使用 `/bin/ps -o rss= -p <本harness PID>`，KiB 转 MiB；仅归属于 backend 单进程。RSS 点值不是全进程组、WebView 合计或峰值。结果关闭观察以已预热且无打开结果时为起点，5 轮各打开/关闭相同 10 个 805 行结果；每轮仅短暂 100ms 收尾观察，不能代替长时间稳定观察。

导出使用 Application 原生 `startTransfer`/`waitTransfer`，每次全新目标文件；core 以 `create_new` 创建 partial、`hard_link` 发布并保留 partial，任务完成/失败/取消仅更新状态和关闭游标，直接导出路径无 `remove_file`。导出后另用 CSV parser 对每行 ID、body 和大整数文本核对，内容核对前不将计时样本记为完整通过。

导入只有在本轮 805 行副本的实际 Application 连接通过 `PRAGMA journal_mode=PERSIST` 设置并再次读回 `persist` 后才执行；确认失败则跳过全部导入、失败写入与取消写入子项。这是为保留 journal 而使用的本轮策略，会影响写入与提交成本，不能与产品默认 journaling 性能直接比较，不修改 driver/runtime 或源素材。三次导入分别使用独立空表 `import_perf_1..3`，各 100000 行；不执行 SQL DELETE/DROP，不重复导入已填充表。合成失败和取消仅使用 `import_failed`、`import_cancel`，不触及外部数据库。

## 尚不能覆盖的计划项目

已安装产品 5 次启动到可操作时间、WebView 响应与取消交互、应用进程组总 RSS、Windows、真实服务故障恢复、未应用草稿关闭确认、8 小时观察均未执行。最终数据与 T4/T5 的产品门槛必须分别评估，backend 子项成功不提升上述状态。
