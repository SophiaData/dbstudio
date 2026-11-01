# ER Table Selection, Layout Isolation, and SVG Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 P3.3 剩余能力：用户可以筛选并选择 ER 图表集合，布局按连接和 schema 隔离持久化，并能导出当前 SVG 图。

**Architecture:** 保留现有 `renderErDiagram` 的真实外键计算和 SVG 绘制链路。把“可选表集合”放在结构读取前，用表引用和轻量 schema 信息构成 picker；只有用户选中的表才调用 `describeTable`。布局 key 使用连接 ID 加 schema 集合指纹，存储内容只包含表节点 ID 与坐标。SVG 导出从当前 SVG 克隆并序列化为本地下载，不把数据库内容写入布局存储。

**Tech Stack:** Electron 45、TypeScript 5.9、原生 DOM/CSS、SVG、Playwright、pnpm。

---

### Task 1: 定义可测试的 ER 表集合和布局键

**Files:**

- Modify: `src/renderer/er-diagram.ts`
- Test: `tests/e2e-er-relations.mjs`

- [ ] **Step 1: 写失败测试**

为 picker 和布局纯逻辑增加可导出的纯函数测试，覆盖：

```text
filterTableRefs([{name:"users"}, {name:"orders"}], "ord") => orders
selectAllVisible() 只选择当前过滤结果
buildErLayoutKey("connection:c1", ["public"]) !== buildErLayoutKey("connection:c1", ["audit"])
```

- [ ] **Step 2: 运行测试确认失败**

运行：

```bash
node tests/e2e-er-relations.mjs
```

预期：因为纯函数尚未导出而失败。

- [ ] **Step 3: 实现最小纯逻辑**

在 `er-diagram.ts` 导出：

```ts
export function filterErTables(
  tables: readonly CollectedTable[],
  query: string
): readonly CollectedTable[]

export function buildErLayoutKey(
  connectionId: string,
  schemas: readonly (string | null)[]
): string
```

过滤使用 `trim().toLocaleLowerCase()`，表名和 schema 任一匹配即可；布局 key 对 schema 去重、排序后再编码。

- [ ] **Step 4: 运行纯逻辑测试**

运行：

```bash
node tests/e2e-er-relations.mjs
```

预期：新增断言通过，已有关系计算断言保持通过。

### Task 2: 增加表选择器和 schema 过滤

**Files:**

- Modify: `src/renderer/er-diagram.ts`
- Modify: `src/renderer/style.css`
- Modify: `tests/gui-er-relations.mjs`

- [ ] **Step 1: 写 GUI 失败测试**

新增真实 Electron 断言：

- 打开 ER 图后存在表搜索框、表选择 checkbox、全选当前结果、清空选择和绘制按钮。
- 搜索 `child` 后全选只选中 child。
- 清空选择后显示“请选择至少一张表”。
- 只选中 parent/child 后只调用并绘制这两张表。
- 超过 100 张表时显示先筛选提示，不自动读取全部结构。

- [ ] **Step 2: 实现 picker DOM**

在读取结构前渲染 `.er-picker`，每个表使用稳定的 `data-table-id`，状态保存在 `Set<string>`。默认选择当前 schema；SQLite 无 schema 时默认选择全部表。过滤只影响可见项，全选/清空只操作可见项。

- [ ] **Step 3: 把选中集合接入 describeTable**

绘制按钮提交时：

```ts
const selected = tables.filter((table) => selectedIds.has(table.ref.id))
if (selected.length === 0) {
  renderPickerError('请至少选择一张表')
  return
}
```

只对 `selected` 调 `describeTable`，关系计算只接收已选表；未选中的目标表由既有悬空关系状态报告。

- [ ] **Step 4: 运行 GUI 测试**

运行：

```bash
node tests/gui-er-relations.mjs
```

预期：表选择、筛选、清空、绘制和超限提示全部通过。

### Task 3: 按连接和 schema 隔离布局

**Files:**

- Modify: `src/renderer/er-diagram.ts`
- Modify: `tests/gui-er-relations.mjs`

- [ ] **Step 1: 写失败测试**

在 GUI 测试中：

- 在 `public` 选择集合中拖动表并重新打开，坐标恢复。
- 使用不同 schema 集合重新打开，不能复用前一个 schema 集合的坐标。
- 断言 localStorage value 只包含节点 ID、`x` 和 `y`，不包含列名、外键或数据库数据。

- [ ] **Step 2: 更新布局 key 和读写边界**

使用：

```ts
const layoutKey = buildErLayoutKey(connectionRef.id, selected.map((t) => t.schema))
```

布局 JSON 形状固定为：

```ts
Record<string, { x: number; y: number }>
```

读取时丢弃未知节点和非有限坐标；写入时只写当前选中节点。

- [ ] **Step 3: 运行布局测试**

运行：

```bash
node tests/gui-er-relations.mjs
```

预期：同一连接同一 schema 集合恢复坐标，不同 schema 集合互相隔离。

### Task 4: 增加 SVG 导出

**Files:**

- Modify: `src/renderer/er-diagram.ts`
- Modify: `src/renderer/style.css`
- Modify: `tests/gui-er-relations.mjs`

- [ ] **Step 1: 写 GUI 失败测试**

点击“导出 SVG”后断言：

- 触发下载或生成文件选择结果。
- 文件内容以 `<svg` 开头。
- 文件包含当前选择的表和关系线。
- 导出不会修改 localStorage 布局数据。

- [ ] **Step 2: 实现导出**

给 ER 图头部增加“导出 SVG”按钮。导出时克隆当前 SVG，补充 `xmlns` 和 `version`，通过 `Blob`、`URL.createObjectURL` 和临时 `<a download>` 触发下载；按钮状态在浏览器不支持下载 API 时显示明确错误。

- [ ] **Step 3: 运行 GUI 测试**

运行：

```bash
node tests/gui-er-relations.mjs
```

预期：SVG 文件可读取，内容与当前图一致，布局偏好不变化。

### Task 5: 回归、清单和文档

**Files:**

- Modify: `package.json`
- Modify: `scripts/verify-manifest.mjs`
- Modify: `docs/superpowers/plans/2026-10-26-dbeaver-gap-completion-plan.md`

- [ ] **Step 1: 登记新增测试**

确保 `test:er-relations` 和 `test:gui-er-relations` 都有脚本和清单项。

- [ ] **Step 2: 运行目标检查**

```bash
pnpm run typecheck
pnpm run build
node tests/e2e-er-relations.mjs
node tests/gui-er-relations.mjs
node tests/e2e-verify-manifest.mjs
```

- [ ] **Step 3: 运行完整 Node 回归**

```bash
pnpm run verify:node
```

预期：所有本地 Node 步骤通过；PostgreSQL 外部步骤只有在设置 `DBSTUDIO_PG_URL` 时运行。

- [ ] **Step 4: 更新总计划**

只有选表/过滤、布局隔离和 SVG 导出都通过后，才把 P3.3 的 Step 1 和 Step 3 标为完成，并记录实际测试数量与未验证的外部环境。
