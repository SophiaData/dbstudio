# MySQL parity 公开导出（脱敏副本索引）

本目录是 `docs/support/mysql-parity/` 与 `docs/superpowers/plans/` 中 10 份结论文档的**公开脱敏副本**，用于在不暴露本机用户目录与临时目录的前提下公开任务结论。

> **重要**：
> - 每一份副本都是**新建的脱敏副本**，不是原始字节证据。文件头部的 HTML 注释给出对应原文的**原始 SHA256**。
> - **原文保留本地**：原文仍在 `docs/support/mysql-parity/` 与 `docs/superpowers/plans/` 中，字节未被修改、未被移动；它们含有真实用户的本机绝对路径，因此不作为公开内容分发。
> - **公开导出不替代 canonical evidence**：原文与原始 evidence 才是 canonical evidence，本目录只是可公开的阅读副本与索引。任何验收、复核或争议结论必须回到原文与原始 evidence。

## 目录内容

| 公开副本 | 原文相对路径 | 原始 SHA256 |
| --- | --- | --- |
| [2026-11-11-mysql-acceptance-storage.md](2026-11-11-mysql-acceptance-storage.md) | `docs/superpowers/plans/2026-11-11-mysql-acceptance-storage.md` | `419010ee0071d7c3628c336ecfd91c6a7e33a016bfa12eaa599b9136af9f6e27` |
| [desktop-workflow-gaps.md](desktop-workflow-gaps.md) | `docs/support/mysql-parity/desktop-workflow-gaps.md` | `316de5fa97d186ed11616070e16c5966beab21f7d1dab9258d5937415b5d3dce` |
| [gui-precision-contract.md](gui-precision-contract.md) | `docs/support/mysql-parity/gui-precision-contract.md` | `4153edc58da5ae883a1e4339dda4af8b07f6de15e8fabcee95e04839e0ac628a` |
| [gui-session-timezone-acceptance.md](gui-session-timezone-acceptance.md) | `docs/support/mysql-parity/gui-session-timezone-acceptance.md` | `7e980938b10a6f1c217c6e280ec1d3437a51a13d1d14b92d1ebed985d2eefbe4` |
| [gui-text-acceptance.md](gui-text-acceptance.md) | `docs/support/mysql-parity/gui-text-acceptance.md` | `a16af9107157355969daf9f07bc273da6235cb4ce3ca028e2701c56efa786d7b` |
| [gui-time-acceptance.md](gui-time-acceptance.md) | `docs/support/mysql-parity/gui-time-acceptance.md` | `534a594da69081cc635966af412f73a98d9cd89aa96e2cea0536866ad1260d2c` |
| [gui-time-contract.md](gui-time-contract.md) | `docs/support/mysql-parity/gui-time-contract.md` | `c8577ebbf42f1b4892e1448353214990653de81b7e1e7a5dffa4102a178cd6ac` |
| [gui-time-crosszone-acceptance.md](gui-time-crosszone-acceptance.md) | `docs/support/mysql-parity/gui-time-crosszone-acceptance.md` | `5c6ede4e21e896ab0b33dcaa9c6901e0be8d6c8830b7989c8e9ce905b7685d1c` |
| [progress.md](progress.md) | `docs/support/mysql-parity/progress.md` | `1263f4215519d697c8abaed141035abe691c2dc4fcbf1ada9b409aa13088e3de` |
| [real-acceptance-results.md](real-acceptance-results.md) | `docs/support/mysql-parity/real-acceptance-results.md` | `4b5113621b8d159444b3a34d87a98e0e5b545ef78a2bf95dc361e321d99fb562` |
| [local-evidence-index.json](local-evidence-index.json) | —（本地私有 evidence 的公开 hash 索引，见下节） | — |

## 脱敏规则

- 本机用户 home 前缀（`/Users/<user>/…`）→ 仓库内路径改为相对路径，用户目录改为 `$HOME`，工作区改为 `$WORKSPACE`，Node 解释器绝对路径改为 `node`（可移植命令）。
- macOS 临时根前缀（`/private/var/…`）→ `$ACCEPTANCE_TMP`。
- 相对链接重写：
  - 指向本目录内 10 份公开副本 → 指向 `public/` 同目录副本；
  - 指向可公开的合同文档 → `../<合同文件>`；
  - 指向公开安全的原始 evidence → `../evidence/<文件>`；
  - 指向仓库内已跟踪源码 → `../../../../<仓库相对路径>`；
  - 指向私有原始 evidence（94 项）、本机 `backups/` 产物或其它未提交目标 → 纯文本「原始材料仅本地保留（见原SHA索引）」，**不生成假的 GitHub 链接**。
- 任务结论、表格、RED/GREEN 判定、KnownGap / Infra 结论与限界**原样保留**，未新增、未洗白、未删除任何结论。

## 私有 evidence 的公开 hash 索引

[local-evidence-index.json](local-evidence-index.json) 给出本地保留的私有 evidence 的**公开索引**，每项仅含：

- `repoRelativeName`：仓库相对文件名；
- `originalSha256`：原始字节 SHA256；
- `bytes`：原始字节数；
- `closedStatus` / `counts`：仅从白名单键（`classification`、`status`、`phase`、`stage`、`failureCode`、`chainPassed`、`productionReady`、`materialsPreserved`、`exitCode`、`timedOut` 与 `checks`/`actions`/`observations`/`witnesses` 计数）软件提取的闭合状态与计数。

索引**不含**任何原始内容、路径、SQL、结果行或环境数据。原始 evidence 保留本地，未被修改、复制、暂存或删除。

## 限界说明（不得外推）

以下为可由公开副本与已核证据支持的事实边界；超出部分不得声称已验证：

- **资源隔离与回收策略的 37 项隔离用例已通过**：以合成 fixture 运行 `node --test scripts/mysql-acceptance-storage.test.mjs`，37 pass / 0 fail；真实 Cargo / Vite / tauri 均被 mock，真实 Python `fcntl` 占用与 `/usr/bin/otool -L` 解析被真实执行，**不构成真实构建或真实 MySQL 验收**。
- **提交前 source 的真实 run 不等于当前所有 source 已真 Native 验**：据上游执行者说明，真实 c151 run 的 Host 140 + 7 stage 与 auto 3.76 GiB 已通过，但那属于**提交前**源码状态（`apps/desktop/src/main.ts` 当时由另一执行者并行改动诊断逻辑），因此**不能**据此声称当前所有 source 已完成真实 Native 验证。存储计划自身也写明其套件未真实执行 Cargo/编译/Host 140。
- **历史计数不得混加**：TIME 方向的 12 个 Native 阶段、155 项**既有合同**检查，以及 driver 层的单测计数（最小 DATE/TIME 修复 12 项、Column metadata 13 项 RED＝12 pass/1 fail → GREEN 13 项全过）均属历史 run 记录；driver 计数与 host / builder 计数不可加总，本导出不把它们当作本轮新证据。
- **BLOB 编辑仍为只读**：完整类型矩阵（含 BIT/BLOB 写、范围负例、大键、插入、多行大事务、跨标签、COMMIT 未知）仍待验证，新 Native initial 与 bit-blob 路径未实跑；KnownGap / Infra 结论保持原样，未被提升为 Green。
- **完整 MySQL dbx / DBeaver 对标体验未完成**：参考基线已冻结版本与提交，但参考应用的实际操作仍未执行，不等于已完成对标。

任何进一步结论必须回到原文、原始 evidence 与 canonical 记录核对。
