# dbstudio M0 验收报告

**报告日期：** 2026-10-24（Asia/Shanghai）；提交整理于 2026-10-25。

**验证基线：** `0e7e840d32260da6cda6bf490a95ee19e50221ef`。10 月 24 日的验证覆盖该基线之上的工作区改动；下文保留当时的日志和源码摘要。

**交付状态：** 用户已授权将 M0 改动按四批提交到本地 `main`，提交记录见 §7。没有 push、打 tag、创建 PR 或对外发布。

**桌面端版本：** `0.3.1`；**SDK 版本：** `0.2.0`

**验证平台：** macOS 26.6.2（arm64）

**运行时：** Node `v25.8.1` / pnpm `11.24.0` / Electron `45.0.0`（内置 Node `24.22.0`）

**计划依据：** `docs/superpowers/plans/2026-10-24-m0-remediation-plan.md`（A1–A6）

**A1 详情：** `docs/superpowers/plans/2026-10-24-m0-a1-review.md`

---

## 1. 结论摘要

| 批次 | 结论 | 依据 |
|---|---|---|
| A1 行身份与脏编辑 | ✅ 实现完成，本地验证通过 | 见 §3.1 |
| A2 真实窗口关闭 / 退出保护 | ✅ 实现完成，本地验证通过 | 见 §3.2 |
| A3 连接操作事务保护 | ✅ 实现完成，本地验证通过 | 见 §3.3 |
| A4 验证执行器 | ✅ 实现完成，本地验证通过 | 见 §3.4 |
| A5 发布门禁与打包验收 | 🔶 **代码与负例完成，远端三平台验证待补** | 见 §3.5 |
| A6 集成验证与状态纠偏 | ✅ 本次完成 | 本文件 |

**M1 准入判断：开发阶段具备继续条件。**

**不能宣布"Beta 发布就绪"。**理由有三条，且都是事实而非保守措辞：

1. A5 的发布工作流**从未在 GitHub runner 上真实执行过**——远端发布未获授权，
   本报告只有合成 bundle 的负例测试与本机 mac/arm64 的真实打包冒烟。
2. Windows x64 与 Linux x64 **连本机产物都没有**，安装器安装、启动、
   卸载路径完全未验证。
3. macOS x64 产物本机已构建，但 **Playwright 无法附加到 Rosetta 下的 x64 进程**，
   打包冒烟未通过（详见 §3.5），因此四目标里只有一目标拿到了完整冒烟证据。

---

## 2. 本轮实际执行的命令与退出码

本节列出已经记录真实退出码的命令；早期通过管道运行但没有正确捕获退出码的尝试不计入这些证据。

### 2.1 完整本地验证

```sh
(
  pnpm run verify:headless > /tmp/dbstudio-m0-final-verify6.log 2>&1
  result_code=$?
  echo "VERIFY_EXIT_CODE=$result_code" >> /tmp/dbstudio-m0-final-verify6.log
  exit "$result_code"
)
```

**退出码：`0`**（日志末尾 `VERIFY_EXIT_CODE=0`；外层 shell 观测到 `OUTER_EXIT=0`）

汇总：**选中 42 / 执行 38 / 通过 38 / 跳过 4 / 失败 0**；日志中以
`PASS` 开头的输出共 **475 行**，没有以 `FAIL` 开头的输出。各测试使用不同的输出格式，该行数不代表全部独立断言的总数。

（42 比前一次多出的 1 步是本轮新增的 `test:packaged-smoke`。）

跳过的 4 个是 external 分组（缺 `DBSTUDIO_PG_URL` / `DBSTUDIO_PG_SSL_URL` /
`DBSTUDIO_PG_PLAIN_URL`），已由 §2.2 的真实外部服务运行覆盖。

### 2.2 真实外部服务验证

自建临时 PostgreSQL 17（明文 + TLS 两个实例，`127.0.0.1` 动态端口，trust 认证）、
自签证书（另生成一张**无关** CA 作反证）、临时 sshd（动态端口），
跑完后全部停止并删除。

```sh
node scripts/verify.mjs external --require-external
```

**退出码：`0`**（日志尾部 `EXIT 0`）

汇总：**选中 4 / 执行 4 / 通过 4 / 跳过 0 / 失败 0**

| 步骤 | 结果 |
|---|---|
| `test:postgres`（真实 PG 17 主驱动） | 52/52 |
| `test:cancel`（SQLite 取消声明 + PG 真取消） | 15/15 |
| `test:postgres-ssl`（TLS 语义） | 23/23 |
| `test:ssh-tunnel`（真实 sshd + PG） | 21/21 |

日志：`/tmp/dbstudio-m0-final-external.log`

### 2.3 本机打包冒烟（A5 的一部分）

```sh
pnpm exec electron-builder --config electron-builder.config.mjs --mac --arm64 --publish never
# 退出码 0；日志 /tmp/dbstudio-a5-package.log

GITHUB_SHA=$(git rev-parse HEAD) GITHUB_RUN_ID=9001 GITHUB_RUN_ATTEMPT=1 \
  node scripts/smoke-packaged-app.mjs mac arm64 \
  release/mac-arm64/dbstudio.app/Contents/MacOS/dbstudio \
  /tmp/dbstudio-smoke-mac-arm64.json
# 退出码 0；输出 "Packaged smoke passed: mac/arm64, version 0.3.1, SQLite SELECT 42"
```

冒烟报告：`/tmp/dbstudio-smoke-mac-arm64.json`，五项检查全过
（`packaged` / `renderer` / `preload` / `sqliteHost` / `query`），
可执行文件 SHA-256 `e578780182bf50a5eff10fe53ae0f8feb5cfbd26f934bf874bfac2dc055d84d7`。

---

## 3. A1–A5 逐批结论

### 3.1 A1 行身份与脏编辑

**实现完成，本地验证通过。**关键改动：

- `src/drivers/postgresql/edits.ts` 新增 `resolveRequiredColumns`，
  先允许唯一大小写回退，再按 canonical 真实列名排序检查完整主键。
- `src/drivers/postgresql/adapter.ts` 的 UPDATE / DELETE 主键完整性与 SQL 条件
  改用 canonical 精确匹配，避免组合主键 `("id","ID")` 被合并为同一列。
- `src/renderer/grid.ts` 为初始查询、分页、排序、销毁增加查询轮次与 cursor 归属检查；
  迟到的初始响应关闭自己的游标，迟到分页不写缓存、不改状态。
- 网格销毁后迟到响应不能重绘、改状态或重新取得游标。

**A1 证据：** `docs/superpowers/plans/2026-10-24-m0-a1-review.md` §7，
Node 17/17、GUI 15/15、真实 PG 52/52、增删改 GUI 75/75、网格生命周期 7/7。

**验证边界：**A1 已覆盖跨连接脏编辑隔离；A3 又逐入口检查另一连接的数据和状态不受影响。这些场景不代表已经穷举不同连接、多标签和事务操作的全部组合。

### 3.2 A2 真实窗口关闭与退出保护

**实现完成，本地验证通过。**`src/main/index.ts` 重写退出守卫：

- 移除 60 秒自动放行；超时只记警告，**不放行**。
- `quitGuardRunning` 期间第二次 `app.quit()` 也 `preventDefault()`。
- 窗口 close 许可绑定到**具体 `BrowserWindow` 实例**；macOS 关闭后重开窗口
  必须重新确认。
- 渲染进程崩溃 / 无响应 → 主进程 `dialog.showMessageBox` 要求显式选择；
  取消保留窗口，只有"退出并放弃"才退出。
- `render-process-gone` / `unresponsive` / `destroyed` 监听在 `finally` 中移除，
  无监听器泄漏。

**测试：** `tests/gui-app-close-guard.mjs` — **9 场景全过**。覆盖超时不放行、
重复 quit 被拦、apply-commit / discard-rollback 真落库、macOS 重开窗需重新确认、
崩溃需主进程确认、无响应通知不替换待决决定、崩溃中取消后可重试、
编辑中单元格受保护、监听器无泄漏。

### 3.3 A3 连接操作事务保护

**实现完成，本地验证通过。**

- `src/renderer/transaction-controller.ts` 新增 `runConnectionOperation`：
  串行化、守卫期间锁 `setConnectionOperationLocked`、取消抛错、
  失败也失效旧网格；`setExitGuardLocked` 在退出守卫期间锁编辑。
- `src/renderer/main.ts` / `tree.ts`：断开、删除连接、编辑连接、树右键断开，
  全部走 `runConnectionOperation`。
- `src/renderer/grid.ts`：`invalidateConnection()` dispose 并清空网格，
  提示"连接已关闭或更新，请从连接树重新打开结果。"；
  apply / commit / rollback / insert / delete / 编辑在 locked 或 disposed 时拒绝。
- `src/renderer/tabs.ts`：`activeContext` 对 disposed 网格返回 `null`；
  导出全部按钮在网格失效时禁用。

**测试：** `tests/gui-connection-guard.mjs` — **16 场景全过**。
toolbar / tree / delete / update × cancel / apply-commit / discard-rollback，
逐项验证 UI + 磁盘数据 + 连接配置 + 另一连接不受影响；
并注入 `transactionState` / `applyEdits` / `commitTransaction` / `rollbackTransaction`
 失败，验证阻断断开。

### 3.4 A4 验证执行器

**实现完成，本地验证通过。**

- `scripts/verify.mjs`：严格解析——分组、`--only`、`--require-external`、
  未知 / 重复参数、空选择；`node --only test:postgres` 报冲突并退出 1；
  子进程启动失败或非零退出即失败；汇总输出"选中 / 执行 / 通过 / 跳过 / 失败"；
  外部步骤自身报 `SKIP` 时 `--require-external` 判失败。
- `scripts/verify-manifest.mjs` 成为**唯一真相**，CI 与本地共用；
  `tests/e2e-verify-manifest.mjs` 最终为 **55/55**（含新增打包冒烟脚本登记）。
- `tests/e2e-verify-runner.mjs` **29 通过 / 0 失败**（真实子进程 + 临时 pnpm 替身
  + 真实跑 `test:verify-manifest`）。
- `.github/workflows/verify.yml`：PG 改
  `node scripts/verify.mjs external --only test:postgres --require-external`；
  cancel / ssh-tunnel / postgres-ssl 同样走执行器。
- 本轮登记 `test:verify-runner`、`test:cancel-sqlite`；
  SQL 库测试的 CI 漏项已在较早的 M0 提交中处理。

### 3.5 A5 发布门禁与打包产物验收

**代码与负例完成；远端三平台验证待补——这一批不能标为整体验收通过。**

已实现：

- `scripts/check-release-version.mjs`：tag 必须精确匹配版本；
  手动 dispatch **永不** publish（`publish: false`）。
- `scripts/release-gate.mjs`：4 个目标（mac arm64/x64、win x64、linux x64），
  校验 manifest + aggregate + 摘要。
- `scripts/publish-release.mjs`：先建 / 复用 draft → 删旧资产 → 上传 →
  校验数量 / 大小 / sha256 → 才 `draft: false`；拒绝改动已公开 release。
- `scripts/smoke-packaged-app.mjs`：启动**打包后的**可执行文件，
  校验 `app.isPackaged`、版本、arch、打包内 `package.json`、
  renderer / preload 注入、SQLite 宿主 `SELECT 42`；
  安装器证据标 `unverified`。
- `.github/workflows/release.yml` 重写：
  `verify → matrix 构建 + 冒烟 → gate 汇总 → 单个 publish 任务`，
  仅 `publish` 任务有 `contents: write`；手动分支不发布。
- `tests/e2e-release-gate.mjs` — **25 tests passed**
  （合成 bundle + 假 GitHub API；覆盖错 commit / 版本 / run / attempt、
  缺 arch、build skipped、smoke failed、缺 SQLite check、非 packaged、
  版本不符、缺产物、伪造摘要、缺平台 / 文件、空文件、篡改文件、上传失败、
  缺远端附件、已有公开 release、手动 workflow 拒绝、工作流图约束）。

**本轮实测发现并修掉的两个真实缺陷**（都在 `scripts/smoke-packaged-app.mjs`）：

1. `app.evaluate` 上下文里**没有 CommonJS `require`**，
   读打包内 `package.json` 直接 `ReferenceError`。改用
   `process.getBuiltinModule('fs')`。
2. 冒烟用 `options.file: ':memory:'` 建连接，被 SQLite 驱动的
   "必须是绝对路径"规则拒绝（`connection_failed`），冒烟因此永远失败。
   改用临时目录里的**真实空文件**（驱动也要求文件存在）。

修复后 mac/arm64 冒烟通过（§2.3）。

这两个缺陷原先**没有任何测试覆盖**——打包冒烟在 CI 上每个平台只跑一次，
写错了要等到发版那天才暴露。为此把脚本的三个关键断言导出为可测函数
（`assertPackagedRuntime` / `packagedMetadataReader` / `sqliteSmokeConnection`），
并新增 `tests/e2e-packaged-smoke.mjs`（**8/8 通过，已登记进验证清单**）：
离线锁住"evaluate 里不能用 require"、"SQLite 必须绝对路径真实文件"、
"必须启动打包产物而非开发目录"这三件事。

**mac x64 的情况（如实记录）：**

- 产物已构建（`release/mac/dbstudio.app`）。
- **手动 `arch -x86_64` 启动成功**，进程存活、正常出日志 → Rosetta 可用。
- 但 **Playwright 无法附加到该 x64 进程**：`electron.launch` 30s 超时，
  加长到 90s 仍无法建立连接，`app.evaluate` 从未返回。
- 因此 **mac x64 的打包冒烟未通过**。目前只确认进程存活和出现日志，尚未确认 renderer、preload 和数据库查询可用；超时根因仍未确定。
- 这条目只有一条命令能人工确认（手动启动），不满足 A5 的
  "同一提交的四目标实际构建 + 冒烟证据"要求。

---

## 4. 已实证 / 待验证的明确边界

### 4.1 本地已实证

- 类型检查、构建及本地验证清单实际执行的 38 步全部通过；4 个外部步骤另用真实服务运行通过。
- 真实 PostgreSQL 17 主驱动、真实查询取消、真实 TLS 握手与证书链校验、
  真实 sshd + SSH 隧道，全部在本机跑通。
- 真实窗口关闭 / 退出 / 崩溃保护（9 场景）、连接断开 / 删除 / 更新保护（16 场景）。
- 事务守卫的 apply-commit / discard-rollback 两条路径**真的落库**（独立数据库核对）。
- mac/arm64 的**打包产物**冒烟（`app.isPackaged` + SQLite `SELECT 42`）。
- 发布门禁 25 条负例、验证执行器 29 条子进程测试。

### 4.2 远端待验证

| 项目 | 未验证原因 | 影响 |
|---|---|---|
| A5 远端三平台 / 四架构构建 | 远端发布未获授权 | 发布流程整体未在真实 runner 验证 |
| Windows x64 / Linux x64 产物与安装器 | 本机只有 macOS | 安装 / 卸载 / 启动路径全未验证 |
| mac x64 打包冒烟 | Playwright 附加超时，根因未确定 | 四目标中只有一目标有完整冒烟证据 |
| macOS DMG / ZIP 安装或提取 | 本轮未执行安装器验证 | 安装器证据标 `unverified` |
| macOS 签名与公证 | 本轮未执行签名和公证 | 产物未签名，分发与 Gatekeeper 行为待验证 |
| CI runner 上的 external 组 | 本地已实证，CI 环境不同 | PG / SSL / SSH 在 CI 的行为待确认 |
| Windows / Linux 上的关闭与退出行为 | 无对应平台 | macOS 专属场景之外的关闭行为待验证 |

### 4.3 本轮为本地实证而做的改动（可能影响 CI）

- `tests/e2e-postgres-ssl.mjs`：改用 `DBSTUDIO_PG_SSL_WRONG_CA` 传错误 CA。
- `tests/e2e-ssh-tunnel.mjs`：改用 `DBSTUDIO_SSH_HOST_PUBLIC_KEY`，
  私钥由同目录推导 wrong key。
- `tests/e2e-cancel.mjs`：新增 `--sqlite-only` / `--pg-only`。

这三处是**参数化**，CI 侧仍走默认路径取原有环境变量；
但 CI 上 PG SSL / SSH 的真实执行尚未复核。

---

## 5. 剩余风险

1. **发布流程是"未跑过的流程"。** 门禁逻辑有 25 条负例保护，
   但从"tag 触发"到"Release 公开"的整条链路没有真实执行过一次。
   首次真实发版时最可能出问题的是 GitHub API 交互细节
   （draft 复用、资产删除、附件校验），而不是本地门禁逻辑。
2. **提交保存在本地。** 本次授权只覆盖本地提交，远端仓库尚未包含这批改动。
3. **发布权限最小化尚未在真实仓库验证。** `publish` 任务的
   `contents: write` 生效与否，只在真实 runner 上才能确认。
4. **跨连接隔离已覆盖指定场景，尚未穷举全部组合**（见 §3.1）。
5. **mac x64 冒烟超时根因未确定**，仍需在原生 x64 runner 上补充验证。

---

## 6. 关键文件标识（10 月 24 日验证时源码的 SHA-256）

| 文件 | SHA-256 |
|---|---|
| `src/main/index.ts` | `d342572665f35c87712d761d619bf0d8b20089e22d8a61e4050082f20f97c769` |
| `src/renderer/transaction-controller.ts` | `90ce3b906d2be18adfdc74a3c2a03c45c06c2bde63635946663a076e3261b322` |
| `src/renderer/grid.ts` | `df9ee30fbc7f47115ea42c7a7ec9979f0b4dd1008a10a7f6670488d88124bc53` |
| `src/renderer/tabs.ts` | `90cae683ce10d829e03b75f21aab0a575a2820eacb226a1431e40c94770ba9cc` |
| `src/renderer/tree.ts` | `47c6fb1a7e53ea38274b2cbf9b412c7eb73e0ce4a344a2cec85cb928658b42f4` |
| `scripts/verify.mjs` | `f714f7e28f41a11d13887fbd6863053ae5430ab7cb26dae41a2f205b9c38203c` |
| `scripts/release-gate.mjs` | `30e2593bf6d9e5de6390a330149170d2befa99e64d9162d2bb69aff54d42e89a` |
| `scripts/smoke-packaged-app.mjs` | `7bd06234fb6c5e1114df764d3cc5297310ce573d810a56ae481ff3cc8cbda8cf` |
| `tests/e2e-packaged-smoke.mjs` | `a4a4b8c67f3b30f1caf92f8e9b5b3b375fedb8b9bfdd1da0701f8d623c0af801` |
| `scripts/publish-release.mjs` | `dcdcf2df7d33b8aac9d13d04de6032ce1fd2549abbbb2c0043ace21c9b73fa74` |
| `scripts/check-release-version.mjs` | `6ce997c40176d1c7a674e379d542f04acb5a330d02ef450e3875916da8555859` |
| `.github/workflows/verify.yml` | `08d133ca3e3a878223b2ebe3f30f563c2036d6fca15c99cd8e9e190787a3e109` |
| `.github/workflows/release.yml` | `aedd04489492d4a28b86bfdc4909ab5722a96470a7e2f9081b0bd72c98169059` |

---

## 7. 提交整理与后续工作

2026-10-25，用户授权后，将剩余改动按四批提交到本地 `main`：

1. A1：编辑行身份、组合主键、异步网格生命周期及回归测试。
2. A2/A3：真实窗口关闭、退出与连接操作事务保护。
3. A4：验证执行器参数、失败传播和外部服务 CI 调用。
4. A5/A6：发布门禁、打包冒烟及验收文档。

前三批均从暂存区生成独立源码快照执行定向检查，避免分段暂存后只测试完整工作区。没有修改验证过的业务源码；文档中的旧日志路径和数量已同步纠正。

后续工作：

1. 在真实仓库跑一次 `workflow_dispatch` 的验证构建（不发布），
   拿到四目标的真实产物与冒烟证据，再决定是否开放 tag 发布。
2. 补充更全面的跨连接隔离组合。
3. 为 M1（SQL 工作台）单独写实现计划——路线图里已有 M1 的执行结果契约，
   但还没有逐任务的实现方案。
