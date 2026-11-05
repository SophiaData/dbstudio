# Remote Connection Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 HTTP remote backend 增加可替换认证、owner-scoped 连接管理控制面和前端远程连接操作，并在 staging 通过完整安全与集成门禁。

**Architecture:** 保留通用 `BACKEND_METHOD_MANIFEST` 的能力边界，连接配置管理走独立的 owner-bound HTTP routes，避免把连接配置和 secret 混入普通 RPC envelope。HTTP server 仍由 composition root 注入 principal resolver、governance、remote outbound policy、audit sink 和 metrics sink；每条连接管理 route 都从 principal 选择 owner scope，再调用现有 `ConnectionApplicationService`，不复制连接生命周期逻辑。前端通过 `BackendClient` 的 transport-neutral connection control API 访问桌面 IPC 或 HTTP route，桌面路径保持现有行为。

**Tech Stack:** TypeScript、Node HTTP、Electron preload/renderer、Vite、pnpm、现有 `ConnectionManager`/`ConnectionCatalog`、owner governance、artifact and HTTP contract tests。

---

### Task 1: 固化远程连接控制面 contract 与错误语义

**Files:**
- Create: `src/backend/contract/remote-connection.ts`
- Modify: `src/backend/contract/errors.ts`
- Modify: `src/backend/backend-client.ts`
- Test: `tests/e2e-remote-connection-contract.mjs`

- [ ] **Step 1: 写失败 contract 测试**

覆盖以下 DTO 和规则：

```ts
interface RemoteConnectionCreateRequest {
  readonly config: ConnectionConfig
  readonly secret?: SecretInput
}
interface RemoteConnectionUpdateRequest {
  readonly config: ConnectionConfig
  readonly secretPatch?: SecretInput
}
interface RemoteConnectionRouteResult {
  readonly connection: ConnectionSummary
}
```

测试必须确认：连接列表只返回 `ConnectionSummary`；secret 不出现在 success envelope；未知 connection id 返回 `not-found`；无 principal 返回 `unauthorized`；owner A 的 id 在 owner B 下不可见。

运行：

```bash
node tests/e2e-remote-connection-contract.mjs
```

预期：新测试先失败，因为 contract 文件和 route DTO 尚不存在。

- [ ] **Step 2: 定义稳定错误分类**

在 `errors.ts` 中保留 `invalid-argument`、`unauthorized`、`not-found`、`conflict`、`timeout`、`internal` 的跨 transport 语义。连接额度拒绝必须携带：

```ts
{ code: 'conflict', retryable: true, details: { resource: 'connections' } }
```

连接配置策略拒绝必须携带不含 secret 的字段级 details，例如 `{ field: 'options.host', reason: 'outbound-denied' }`。

- [ ] **Step 3: 增加 HTTP client 的 connection control facade**

在 `BackendClient` 中增加 transport-neutral 方法：

```ts
listRemoteConnections(): Promise<readonly ConnectionSummary[]>
createRemoteConnection(request: RemoteConnectionCreateRequest): Promise<ConnectionSummary>
testRemoteConnection(request: RemoteConnectionCreateRequest): Promise<TestConnectionResult>
updateRemoteConnection(connectionId: string, request: RemoteConnectionUpdateRequest): Promise<ConnectionSummary>
connectRemoteConnection(connectionId: string): Promise<ConnectionSummary>
disconnectRemoteConnection(connectionId: string): Promise<ConnectionSummary>
removeRemoteConnection(connectionId: string): Promise<void>
```

HTTP 实现使用专用 route；desktop 实现适配现有 `listConnections`、`addConnection`、`testConnection`、`updateConnection`、`connectConnection`、`disconnectConnection`、`removeConnection`。不让 HTTP client 通过动态属性获得 desktop-only 文件能力。

- [ ] **Step 4: 运行 contract 测试并提交**

```bash
pnpm typecheck
node tests/e2e-remote-connection-contract.mjs
```

```bash
git add src/backend/contract/remote-connection.ts src/backend/contract/errors.ts src/backend/backend-client.ts tests/e2e-remote-connection-contract.mjs
git commit -m "feat: define remote connection control contract"
```

---

### Task 2: 实现 owner-scoped connection HTTP routes

**Files:**
- Create: `src/main/server/http-connection-routes.ts`
- Modify: `src/main/server/http-server.ts`
- Modify: `src/main/server/index.ts`
- Modify: `src/main/server/http-server-handler.ts`
- Test: `tests/e2e-http-connection-routes.mjs`

- [ ] **Step 1: 写 route 失败测试**

用真实 Node HTTP listener 和两个 owner 验证：

1. `GET /connections` 返回 owner 自己的连接摘要。
2. `POST /connections` 先做 remote config 校验，再保存并尝试连接。
3. `POST /connections/:id/test` 使用一次性 connection lease，并在 host 创建失败、test 失败、close 失败时释放 lease。
4. `PATCH /connections/:id` 在活动会话存在时遵守现有 update 生命周期，不绕过 rollback/close 保护。
5. `POST /connections/:id/connect` 对磁盘预置配置重新校验 outbound policy。
6. `POST /connections/:id/disconnect` 保留配置，只关闭会话。
7. `DELETE /connections/:id` 删除配置、凭据、session secret、游标和宿主。
8. owner B 访问 owner A 的 id 始终返回 `not-found`，不能泄露存在性。
9. request body、response、audit、metrics 都不包含 secret。
10. route 与 RPC 共享 global request limiter，route 在 principal resolver 前就占用 limiter。

运行：

```bash
node tests/e2e-http-connection-routes.mjs
```

- [ ] **Step 2: 添加 route handler**

实现 `createHttpConnectionRouter(options)`，options 至少包括：

```ts
interface HttpConnectionRouterOptions {
  readonly composition: Pick<HttpServerComposition, 'scopeFor'>
  readonly resolvePrincipal: HttpServerPrincipalResolver
  readonly requestLimiter: HttpRequestLimiter
  readonly governance?: OwnerGovernance
  readonly auditSink?: HttpRequestAuditSink
  readonly metricsSink?: HttpRequestAuditSink
  readonly maxBodyBytes?: number
}
```

route 处理顺序固定为：识别 `/connections` → 获取共享 limiter → 读取并限制 request id → resolve principal → `scopeFor(principal)` → 调用 `scope.manager` → 结构化响应 → finally 释放 lease/limiter 和写审计指标。route 不直接触碰 `ConnectionStore` 或 `DriverHostHandle`。

- [ ] **Step 3: 接入 HTTP server 路由顺序**

在 `http-server.ts` 中采用：

```ts
if (await artifactRouter(request, response)) return
if (await connectionRouter(request, response)) return
await handler(request, response)
```

artifact、connection、RPC 三类入口使用同一 `requestLimiter`、request id 上限、governance、audit sink 和 metrics sink。

- [ ] **Step 4: 运行连接 route 门禁并提交**

```bash
pnpm typecheck
node tests/e2e-http-connection-routes.mjs
pnpm test:http-server-handler
pnpm test:http-server-composition
```

```bash
git add src/main/server/http-connection-routes.ts src/main/server/http-server.ts src/main/server/index.ts src/main/server/http-server-handler.ts tests/e2e-http-connection-routes.mjs
git commit -m "feat: add owner scoped connection routes"
```

---

### Task 3: 接入可替换认证 provider 与 staging 配置

**Files:**
- Create: `src/main/server/http-auth.ts`
- Modify: `src/main/server/http-server-config.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/server/index.ts`
- Create: `docs/deployment/remote-backend-staging.md`
- Test: `tests/e2e-http-auth.mjs`
- Test: `tests/e2e-http-server-config.mjs`

- [ ] **Step 1: 写认证 provider 测试**

覆盖：

- 缺少 Authorization header 返回 `unauthorized`。
- Bearer token 不完整或 scheme 错误返回 `unauthorized`。
- provider 返回 owner id 后只保留规范化 principal，不把 token 放进 principal、audit 或 error details。
- provider 异步失败返回 `unauthorized` 或 `internal` 的稳定映射。
- loopback 固定 owner 仍只用于本地开发，非 loopback 没有注入 provider 时启动失败。

运行：

```bash
node tests/e2e-http-auth.mjs
```

- [ ] **Step 2: 定义 provider 注入边界**

`http-auth.ts` 只定义接口和安全 adapter，不在仓库内硬编码 JWT 密钥、密码或第三方身份服务：

```ts
export interface HttpAuthProvider {
  resolvePrincipal(request: IncomingMessage): Promise<BackendPrincipal>
}
```

生产入口从依赖注入 provider；测试 provider 使用固定 owner 映射。真实 JWT/mTLS 校验实现作为部署 adapter，不把密钥写入源码或配置文件。

- [ ] **Step 3: 增加 staging 环境配置**

在 `http-server-config.ts` 增加并校验：

- `DBSTUDIO_HTTP_HOST`
- `DBSTUDIO_HTTP_PORT`
- `DBSTUDIO_HTTP_ALLOWED_HOSTS`
- `DBSTUDIO_HTTP_ALLOWED_PORTS`
- `DBSTUDIO_HTTP_MAX_CONCURRENT_REQUESTS`
- `DBSTUDIO_HTTP_MAX_CONNECTIONS`
- `DBSTUDIO_HTTP_MAX_STORAGE_BYTES`
- `DBSTUDIO_HTTP_ARTIFACT_MAX_BYTES`
- `DBSTUDIO_HTTP_ARTIFACT_MAX_TOTAL_BYTES`
- `DBSTUDIO_HTTP_ARTIFACT_SWEEP_INTERVAL_MS`

配置错误必须在启动时 fail fast；禁止静默接受非法端口、空 allowlist 或非正整数 quota。

- [ ] **Step 4: 编写 staging 部署文档**

`docs/deployment/remote-backend-staging.md` 必须包含：TLS/reverse proxy、认证 provider 注入、owner 数据目录、artifact 备份、audit/metrics sink、环境变量表、健康检查、回滚步骤和禁止在日志中记录 token/secret 的要求。

- [ ] **Step 5: 运行认证/配置门禁并提交**

```bash
pnpm typecheck
node tests/e2e-http-auth.mjs
node tests/e2e-http-server-config.mjs
pnpm test:architecture
```

```bash
git add src/main/server/http-auth.ts src/main/server/http-server-config.ts src/main/index.ts src/main/server/index.ts docs/deployment/remote-backend-staging.md tests/e2e-http-auth.mjs tests/e2e-http-server-config.mjs
git commit -m "feat: add injectable remote authentication boundary"
```

---

### Task 4: 接入前端远程连接管理 UI

**Files:**
- Modify: `src/backend/backend-client.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/tree.ts`
- Modify: `src/renderer/grid.ts` only if connection status refresh requires it
- Test: `tests/gui-remote-connection.mjs`
- Test: `tests/e2e-backend-client-selection.mjs`

- [ ] **Step 1: 写 GUI 失败测试**

在 HTTP backend config 下验证：

- 连接列表能展示 disconnected/connected 状态。
- “新建连接”使用远程 route 保存并测试连接。
- 连接失败后对话框保留，配置仍在列表中。
- 连接/断开/编辑/删除按钮调用 owner-scoped route。
- HTTP 模式不显示本机路径导入、文件选择器和 desktop-only export 能力。
- unauthorized 状态显示重新认证入口，不自动重发非幂等连接操作。
- 审计失败或 metrics 失败不改变 UI 成功响应。

运行：

```bash
node tests/gui-remote-connection.mjs
node tests/e2e-backend-client-selection.mjs
```

- [ ] **Step 2: 接入 facade 方法**

`BackendClient` 的远程连接方法必须调用专用 route client；桌面模式调用现有 `DbStudioApi`。远程 mutation 不加入 `RETRY_SAFE_METHODS`，断线后不得自动重发。

- [ ] **Step 3: 接入 renderer 状态**

连接树使用 `listRemoteConnections()`，每次 connect/disconnect/update/remove 成功后刷新 owner scoped list。错误只显示结构化 message/code，不显示 transport stack、token 或 secret。

- [ ] **Step 4: 运行 GUI 门禁并提交**

```bash
pnpm typecheck
node tests/e2e-backend-client-selection.mjs
node tests/gui-remote-connection.mjs
```

```bash
git add src/backend/backend-client.ts src/renderer/main.ts src/renderer/tree.ts src/renderer/grid.ts tests/e2e-backend-client-selection.mjs tests/gui-remote-connection.mjs
git commit -m "feat: connect renderer to remote connection control plane"
```

---

### Task 5: 补齐安全、隔离、失败恢复和外部数据库集成门禁

**Files:**
- Modify: `tests/e2e-http-connection-routes.mjs`
- Modify: `tests/e2e-http-owner-governance.mjs`
- Modify: `tests/e2e-remote-connection-flow.mjs`
- Create: `tests/e2e-remote-connection-failure-recovery.mjs`
- Modify: `tests/e2e-cancel.mjs` only for remote cancellation coverage
- Modify: `docs/architecture/backend-contract.md`

- [ ] **Step 1: 增加失败恢复测试**

覆盖 host spawn 失败、handshake 失败、connect 失败、test close 失败、owner quota 满、audit sink 抛错、metrics sink 抛错、客户端断连、重复 DELETE、重复 DISCONNECT、更新时旧会话仍存在、connect 时 persisted config 被篡改。

- [ ] **Step 2: 增加多 owner 隔离测试**

并发创建相同名称连接、相同 id 猜测、artifact 与 connection 目录交叉读取、owner dispose 后连接 host 回收，均必须证明 owner A 无法看到 owner B 的状态。

- [ ] **Step 3: 配置真实数据库测试矩阵**

有环境变量时运行：

```bash
pnpm test:cancel
pnpm test:sql-params-postgres
pnpm test:gui-sql-cancel-postgres
pnpm test:mysql-contract
pnpm test:nosql-external
```

没有外部环境时必须保留明确的 skip 原因，不伪造通过结果。

- [ ] **Step 4: 更新架构文档**

补充专用 connection routes、认证 provider 注入边界、secret 生命周期、远程前端能力矩阵和 staging 部署限制。

- [ ] **Step 5: 运行回归并提交**

```bash
pnpm verify:node
pnpm verify:headless
pnpm typecheck
pnpm test:architecture
```

```bash
git add tests docs/architecture/backend-contract.md
git commit -m "test: verify remote connection isolation and recovery"
```

---

### Task 6: 发布 staging PR 并等待远程门禁

**Files:**
- Modify: `docs/deployment/remote-backend-staging.md` if validation changes deployment steps
- Create: `docs/release/remote-connection-control-plane-release.md`

- [ ] **Step 1: 写发布验收记录**

记录 commit、环境变量名、实际可用数据库矩阵、跳过项及原因、HTTP smoke、owner isolation、audit/metrics 和 rollback 结果；不得记录 token、密码或私密连接信息。

- [ ] **Step 2: 运行最终门禁**

```bash
git diff --check
pnpm verify:node
pnpm verify:headless
pnpm test:http-server
pnpm test:http-artifacts
pnpm test:http-connection-routes
pnpm test:remote-connection-contract
pnpm test:remote-connection-flow
```

- [ ] **Step 3: 创建 PR**

PR 描述必须包含变更范围、验证结果、外部数据库跳过项、部署前置条件和官方 DSH badge：

```markdown
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
```

- [ ] **Step 4: 等待 CI 并只在所有 required checks 通过后合并**

```bash
gh pr checks <number> --watch --interval 10
gh pr view <number> --json state,mergeStateStatus,statusCheckRollup
```

- [ ] **Step 5: 合并后确认**

确认 PR merged、远程分支状态、工作树只保留约定的 `smoke.json` 未跟踪证据，并更新目标进度。
