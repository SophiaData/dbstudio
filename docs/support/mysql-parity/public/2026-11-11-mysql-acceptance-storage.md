<!--
公开脱敏副本，原文保留本地；原始SHA256=419010ee0071d7c3628c336ecfd91c6a7e33a016bfa12eaa599b9136af9f6e27，本文件不是原始字节证据。
原文相对路径：docs/superpowers/plans/2026-11-11-mysql-acceptance-storage.md
本副本仅做本机路径脱敏与链接重写；任务结论、表格、RED/GREEN 判定与限界与原文一致，未新增或洗白任何结论。
-->
# MySQL Acceptance Storage Implementation Plan

> **For agentic workers:** 本任务已由 Root 选定当前执行者直接实施；逐步勾选，不提交、不推送。

**Goal:** 在不运行完整构建的前提下，为 MySQL acceptance Builder 增加空间硬闸、全程互斥、成功后的本轮 cache 安全回收，并让 Runner 严格绑定 helper 源码与回收证明。

**Architecture:** 独立 `mysql-acceptance-storage.mjs` 持有政策常量、纯门禁、已知 run cache 计量、token/inode lease、受保护快照及内嵌 Python openat 回收器。Builder 只传入固定项目根与**裸 32 位 hex run id**，Runner 独立计算 helper SHA 并验证 receipt；23 个 direct source 的含义保持不变。

**Tech Stack:** Node.js 25 ESM、`node:test`、Node fs/statfs、`/usr/bin/otool -L`（仅 macOS）、`/usr/bin/python3 -I -c`（无依赖、无临时脚本）。

**D1:** `backups/mysql-acceptance-storage-fix-d9e3979d-baef-4a3b-8350-a5e11dcfd2a3/`（0700 目录 / 0600 文件）；`before/` 为第一版冻结字节（helper `8ba35d4f…`、test `c0c29d65…`、Builder `4104fc21…`、Runner `1a83dc3c…`、plan `f18c1b14…`），`after/` 为本版冻结字节，`report.json` 记录测试与语法证据。

---

### Task 1: 先写失败回归

**Files:**
- Modify: `scripts/mysql-acceptance-storage.test.mjs`

- [x] 用 `backups/mysql-acceptance-storage-tests-<uuid>` 合成 root，覆盖低空间/预算无 run 副作用、旧 cache 保留、lease 并发/异常/伪造 owner、成功精确回收、失败诊断保留、链接/越界/动态依赖/占用拒绝、helper SHA/伪造证明拒绝。
- [x] 追加 A–G 边界回归：真实 Builder 入口接入、硬链接内部/跨 cache/外部/protected alias、20GiB/8GiB 字面阈值上下界、`@rpath`/`@loader_path`/相对 install name/未知格式依赖、真实 Cargo flock 占用与缺失/不安全 lock、receipt 三阶段顺序/重复/缺失、partial lease 与 report 写失败封闭。
- [x] 运行 `node --test scripts/mysql-acceptance-storage.test.mjs`；对第一版冻结实现为 **19 fail / 17 pass**（RED），对本版实现为 **36 pass / 0 fail**（GREEN）。不运行 Builder/Cargo/MySQL 的真实构建。

### Task 2: 独立 storage policy

**Files:**
- Modify: `scripts/mysql-acceptance-storage.mjs`
- Test: `scripts/mysql-acceptance-storage.test.mjs`

- [x] 固定 20 GiB = `21_474_836_480`、8 GiB = `8_589_934_592`；阈值边界（`>= MIN` 放行、`MIN-1` 拒绝；`< MAX` 放行、`= MAX` 拒绝）由字面量回归锁定；无 CLI/ENV 旁路。
- [x] 以固定项目内 atomic mkdir/wx lease 持有整个 build；只释放 token、目录 inode、owner inode 均匹配的自身 lease；owner 创建失败时仅按本次创建的目录/owner inode 清理自有残缺 lease，foreign/伪造 token 保留。
- [x] 仅对本轮成功且尚无成功 receipt 的 run 验证 canonical/owner/no-symlink/protected inode/动态依赖，再由内嵌 Python 以 `dir_fd` + `O_NOFOLLOW` 做 unlink/rmdir；before/after 保护 hash/meta 相同才返回回收证明，失败保留诊断。
- [x] 三 cache 以 dev+ino 聚合闭包：`observedAliases == st_nlink`、无 protected inode、allocated 去重一次、闭包先审后删；Python 删除时校验 remaining link 计数递减，外部/新增 alias 拒绝。
- [x] 导出当前 helper 政策 SHA 与 receipt 严格验证函数；未知格式、占用、部分失败均 closed failure，不发布 passed。

### Task 3: Builder 与 Runner 最小接线

**Files:**
- Modify: `scripts/build-mysql-acceptance.mjs`
- Test: `scripts/mysql-acceptance-storage.test.mjs`

- [x] Builder 在 run/config/child 前取得 storage controller；lease 后复检，并在三个重 Cargo 阶段前复检；finally 成功才回收、失败保留，report 写入政策绑定及空间/生命周期 closed metadata，140 tests/7 stages 不删减（字节级 SHA 锁定）。
- [x] Builder 以**裸 32 位 hex run id** 调用 `storage.close`；helper 只接受裸 id，带前缀别名一律 `STORAGE_RUN_INVALID`。
- [x] Builder report 写失败以封闭错误码 `MYSQL_ACCEPTANCE_REPORT_WRITE_FAILED` 退出 1，不输出 raw 栈、不泄漏路径、不伪造 passed；自身 lease 已在 close 中释放。
- [x] Runner 保持 23 direct sources 不变，额外独立 pin 当前 helper SHA（`verifyStorageReceipt` 强制 policy/source 与本轮成功回收证明），旧 receipt 不修改；本版 Runner 字节未变。

### Task 4: 验证与交付

**Files:**
- Create: `backups/mysql-acceptance-storage-fix-d9e3979d-baef-4a3b-8350-a5e11dcfd2a3/report.json`

- [x] 运行 `node --check` 检查 helper、test、Builder、Runner 四个 JS 文件；记录测试 pass/fail 名称和数量。
- [x] 只复核上述五个交付文件；计算最终 SHA，写 report，清理本次新建的合成 fixtures（`backups/mysql-acceptance-storage-tests-<uuid>`、scratch），不触碰历史 artifact/cache。
- [x] 明确报告未执行 full build、Native、GUI、DB、commit/push；冻结后交 Root 安排另一模型 D2。

---

## 本版实际限制（不可声称已验证）

- **仅 macOS 受支持**：动态依赖只经 `/usr/bin/otool -L` 解析；`win32`/`linux` 与未知二进制格式一律 failclosed（`STORAGE_BINARY_DEPENDENCY_UNSUPPORTED_PLATFORM` / `STORAGE_BINARY_DEPENDENCY_INVALID`），保缓存并失败。Windows/Linux **未验证**。
- **依赖判定只要求规范化后位于三 cache 之外的绝对路径**；`@rpath`/`@loader_path`/相对 install name 一律拒绝。系统库位于 dyld shared cache 时磁盘上无该文件亦允许（生产 `/usr/lib/libSystem.B.dylib` 场景），因此不要求依赖文件存在。
- **回收要求本轮三个 Cargo lock 存在且可 flock**：`target/debug/.cargo-lock`、`target/debug/.cargo-build-lock`、`target/debug/.cargo-artifact-lock`；缺失/不安全/被占用即拒绝且不创建锁文件。真实保留构建的只读 `lstat` 证据仅支持这三个 `target/debug` 锁；不得假设根 `target/.cargo-lock` 或 `target/debug/deps/.cargo-lock` 存在。
- **占用防线在 Python 回收器内**（真实非阻塞 `flock`，`lockf` 不用，因 macOS 上 `lockf` 与自身冲突）；JS 侧不再保留可注入的假占用钩子。
- **测试用的 Builder 接入为 storage integration**：合成 repoRoot + test-owned preload 模拟 git/Vue/Vite/Cargo/tauri，真实 FS/lease/run 生成/close/receipt/validator 全链路走通；**未真实执行 Cargo/编译/Host 140**，不得据此声称 Host 140 已跑。
- **helper SHA 已变**：第一版冻结 helper 与本版 helper 字节不同，任何绑定旧 SHA 的 receipt（含历史 4e）不再匹配；历史保持历史，不改写 receipt。
- 23 个 direct source 范围不变；helper SHA 是额外独立 pin，**不等于**完整传递闭包。
