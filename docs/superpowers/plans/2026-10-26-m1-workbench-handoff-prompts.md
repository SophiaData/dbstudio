# M1 执行与审核交接提示词

日期：2026-10-26。配套计划：`/Users/gaotingkai/Projects/dbstudio/docs/superpowers/plans/2026-10-26-m1-sql-workbench-plan.md`。

本文件提供给执行者（可以是独立子代理、新会话或本地执行流程），当前会话可作为审核者。

## 1. 首次执行提示词 (B1: 核心契约与驱动实现)

```text
你是 dbstudio 的执行工程师，负责实现 M1 任务 B1：驱动层与核心协议的语句执行契约。
仓库：/Users/gaotingkai/Projects/dbstudio
执行计划：/Users/gaotingkai/Projects/dbstudio/docs/superpowers/plans/2026-10-26-m1-sql-workbench-plan.md

任务目标：
1. 在 src/core/resultset.ts 中定义并导出 StatementResult (rows | affected | ddl)。
2. 在 src/core/driver.ts 的 DriverAdapter 中增加 executeStatement(sql, options) 方法。
3. 在 src/driver-host/index.ts 增加 executeStatement RPC 请求转发。
4. 在 SQLite 与 PostgreSQL adapter 中实现 executeStatement，区分查询、DML（返回 affected 行数与事务状态）和 DDL（返回变更摘要与已提交状态）。
5. 编写并运行 tests/e2e-statement-execution.mjs，验证驱动层 RPC 对 SELECT、INSERT、CREATE TABLE 的分类正确。

约束：
- 驱动宿主保持进程隔离，驱动代码不进入 renderer/main。
- 必须先写反例测试，运行确认失败后再实现。
- 完成后提供 diff、测试命令、实际输出与退出码。
```

## 2. 后续批次提示词

### B2: 主进程与 IPC 链路集成
```text
实现任务 B2：主进程、IPC 与 SDK 链路打通。
1. 在 src/main/DriverHostHandle.ts 和 src/main/ConnectionManager.ts 中实现 executeStatement。
2. 处理 rows 结果的 cursorId 作用域前缀包装（CursorId.scope）。
3. 在 src/core/api.ts、src/main/index.ts、src/preload/index.ts 与 sdk/ 暴露 executeStatement。
4. 扩充 tests/e2e-statement-execution.mjs 验证完整的主进程调用链路与类型检查。
```

### B3: 连接级事务控制器联动
```text
实现任务 B3：连接级事务控制器联动与广播。
1. 在 src/renderer/transaction-controller.ts 增加 notifyExternalMutation(api)。
2. 在 main.ts 的 SQL 执行路径中，DML 成功后通知连接控制器并广播同连接所有标签刷新；DDL 成功后刷新树结构。
3. 编写 tests/gui-sql-transaction.mjs，验证 SQL 插入后同连接其他标签自动看到新行，工具栏出现“未提交事务”状态，点击回滚后恢复原状。
```

### B4: 渲染层结果面板多形态支持
```text
实现任务 B4：渲染层结果面板多形态支持（Affected 卡片与 DDL 摘要）。
1. 改造 src/renderer/tabs.ts 支持命令卡片模式。
2. 当 executeStatement 返回 affected 时渲染影响行数面板与耗时，提供事务快捷提交按钮；返回 ddl 时渲染结构变更卡片。
3. 在 src/renderer/style.css 添加响应式卡片样式。
4. 编写 tests/gui-sql-workbench-results.mjs 进行 GUI 验证。
```

### B5: 多语句脚本顺序执行与错误精准定位
```text
实现任务 B5：多语句脚本顺序执行与错误中断。
1. 在 main.ts 中优化 executeSql：按分号顺序在当前连接上逐条执行语句。
2. 前一条执行成功再执行下一条；遇到错误立刻中断执行，并在错误面板清晰指出哪一条语句、哪一行出错，拒绝静默吞错。
3. 编写 tests/gui-sql-script-execution.mjs 覆盖脚本连续写入与中途语法错误中断行为。
```

### B6: SQL 草稿按连接持久化与验证清单集成
```text
实现任务 B6：SQL 草稿按连接持久化与统一验证清单更新。
1. 在 main.ts 和 sql-editor.ts 实现基于 localStorage 的按连接 SQL 草稿防抖存储与切换回填。
2. 登记 B1–B6 的新增测试到 package.json 与 scripts/verify-manifest.mjs。
3. 运行 pnpm run test:verify-manifest、pnpm run verify:node 与 pnpm run verify:headless 确保全绿无回归。
4. 更新 README.md 相关功能与测试说明。
```
