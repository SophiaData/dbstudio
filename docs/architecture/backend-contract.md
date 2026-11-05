# Backend contract 与 transport 边界

## 当前分层

dbstudio 的业务调用通过 application backend contract 进入主进程服务。Electron 仍然是桌面组合根：

```text
renderer
  → preload facade
  → Electron IPC adapter
  → application services
  → connection-scoped driver-host
  → database driver
```

renderer 依赖 `BackendClient`，不直接发现 `window.dbstudio`。Electron API、IPC channel 和 preload 白名单由 `BACKEND_METHOD_MANIFEST` 共同投影，`tests/api-surface.golden.json` 固定当前发布面。

`ConnectionManager` 保留原公开方法作为兼容 facade，连接目录、session、cursor、query、mutation、metadata、compare、import 和 transfer 已分别由 application service 管理。这样可以继续保留桌面 API identity，同时逐步替换 transport。

## Desktop 与 remote capability

完整 `BackendApi` 是桌面能力面，包含 `chooseImportFile`。它需要当前 Electron `WebContents` 作为父窗口，属于 shell capability。

HTTP client 使用 `RemoteBackendApi`，remote projection 会排除 `chooseImportFile` 以及全部仍携带服务端本机路径语义的 import/export 方法（`startTransfer`、`previewImport` 及其任务生命周期方法）。连接配置管理仍由受信任桌面端完成。`src/backend/contract/artifact.ts` 冻结了后续文件能力的方向：上传 ticket、下载 ticket 和 opaque `artifactId` 都由 owner scope 绑定，带用途、大小、摘要与过期时间约束；远程导入只接受 `import-source` artifact，远程导出生成 `export-result` artifact。不能把绝对路径直接放进 HTTP contract。

当前 HTTP 代码提供：

- renderer `BackendClient` 的 desktop IPC / HTTP 选择器；HTTP 模式暴露连接状态，仅对显式列出的安全读方法在可重试传输失败时执行一次注入式 reconnect + retry，非幂等写方法绝不自动重发；低层 `invoke` 保留单次 AbortSignal/timeout；认证头由 provider 适配层维护，未绑定 JWT/mTLS 厂商；
- transport-neutral wire codec；
- `Uint8Array`、`undefined` 和 `bigint` 的 JSON 可逆编码；
- manifest 路由与 dispatcher；
- 结构化成功/失败 envelope；
- client 侧 request id、取消和超时。

当前 HTTP transport 已具备可验证的 server slice；server composition 的 owner 隔离、治理和资源边界已经落地：`createHttpServerComposition` 接收认证后的 principal，通过 request context 选择 owner-bound application scope；每个 owner 使用独立的 ConnectionStore、SqlLibraryStore、ConnectionManager、cursor 和任务状态，server 端 cipher 与 driver-host factory 也由组合根注入。`createHttpServerHandler` 提供 Node HTTP 入口的第一层防护：只接受 JSON POST、限制 body/response 大小、限制并发、校验 request id，并把客户端断连映射到 request context 的 `AbortSignal`；`createHttpServer` 在此基础上提供默认 loopback 绑定、真实 localhost listener、优雅关闭和 composition 生命周期管理。主进程入口通过 `HttpServerPrincipalResolver` 注入认证 resolver；未注入时只允许 loopback 固定 owner 本地模式，远程 host 必须由调用方提供 resolver，当前不绑定 JWT 或任何外部认证服务。`OwnerGovernance` 作为可替换的 owner 资源边界，提供请求、连接和存储租约配额、owner scope 生命周期与结构化审计事件；连接业务和 artifact store 必须显式申请租约，治理层不实现具体认证 provider 或 Artifact 存储。文件内容走独立的 artifact routes：owner scope 内的本地 store 提供短时效 upload/download ticket、大小与 sha256 校验、一次性 ticket 和二进制流传输，artifact id 不承载路径语义；bearer ticket 通过 `X-DBStudio-Artifact-Ticket: Bearer <ticket>` 专用请求头传输，upload/download URL 不包含 ticket query，旧 query 形式不兼容并返回 401。这样 ticket 不进入访问日志、Referer 或缓存键。wire decode 另有深度与节点数上限。正式入口默认构造 owner governance、console audit/metrics sinks 和 fail-closed 的出站 allowlist；`DBSTUDIO_HTTP_ALLOWED_HOSTS` / `DBSTUDIO_HTTP_ALLOWED_PORTS` 与 owner 配额环境变量提供部署配置。生产认证 provider、TLS/反向代理部署、持久化 job store 与 import/export job 编排仍由部署与后续 server slice 提供。

## 远程安全验证边界

HTTP server 组合根的安全检查按以下顺序执行：

1. `createHttpServerHandler` 只接受 JSON `POST`，在读取 body 前检查 content length、认证 principal 和并发额度。
2. body、response、request id 都有上限；wire decode 另外限制嵌套深度与节点数量，超限返回结构化错误并停止进入 application API。
3. `BackendRequestContext.signal` 在 request body 读取期间、socket 断连和 response 关闭时保持可观察；认证层只负责产生 principal，owner scope 由组合根选择。
4. `OwnerGovernance` 为认证后的 owner 发放请求、连接和存储租约；超过配额返回受控错误，租约释放幂等，owner dispose 时清理治理状态并写入审计事件。远程 scope 创建 `ConnectionManager` 时显式注入连接租约工厂：成功的 add/connect 持有租约，disconnect/remove、宿主异常退出和 owner dispose 释放租约；失败重试重新申请，testConnection 使用一次性租约。未注入租约工厂的桌面组合保持既有行为。
5. 每个 owner 的持久化文件位于 owner id 的 SHA-256 子目录；连接、游标、SQL library、任务状态与 artifact store 不跨 scope 共享。
6. remote manifest 与 runtime API projection 同时排除 Electron 文件选择器和服务端本机路径能力。文件传输走 owner-bound artifact ticket；upload ticket 只能写一次，download ticket 只能读一次，artifact id 不接受路径语义。

这组约束对应的自动验证入口是 `test:http-server-composition`、`test:http-server-handler`、`test:artifact-contract`、`test:http-transport`、`test:architecture` 与 `check:bundle-boundaries`。生产部署仍需通过注入的 resolver 接入真实认证，并配置 TLS、反向代理 body limit、持久化 job/artifact store、审计和速率限制策略。

远程 API 的限流分两层：handler 的全局并发上限防止单实例资源耗尽，`OwnerGovernance` 的 owner 请求/连接配额防止单租户挤占资源；两层拒绝都返回可重试标记，且租约释放必须幂等；RPC 与 artifact route 共享单实例请求 limiter，artifact ticket 还有内存数量上限，避免独立入口绕过资源治理。出站连接只有在显式 `RemoteOutboundPolicy` 的 host/port allowlist 命中时才允许；策略覆盖数据库 host、SSH host/target、Kafka brokers 和证书/私钥路径字段，不解析 DNS、不跟随重定向，也拒绝 localhost、私网 IPv4 与路径式 host。已保存配置在每次 connect 前重新校验。`HttpRequestAuditSink` 与 `metricsSink` 只接收 request id、owner、方法、状态、耗时和错误码，禁止记录请求体、响应值、凭据、token 或 header；sink 故障不得改变业务响应。

## 错误与协议

跨 transport 的错误使用：

```json
{
  "ok": false,
  "error": {
    "code": "invalid-argument",
    "message": "可读错误",
    "method": "runQuery",
    "callId": "request-id"
  }
}
```

错误 payload 会移除 `stack` / `cause`，并对 password、secret、token、credential、authorization 和 cookie 等字段脱敏。driver-host 的 RPC code 在进入 backend boundary 时保留在 `details.rpcCode`，同时映射到稳定的 backend error code。

Electron 与 SDK 共用 driver-host handshake。握手声明 dialect、protocol、driver API、metadata、transfer 和整体 contract 版本；新宿主严格校验，不带数字版本字段的 legacy 宿主保留兼容并产生 warning。版本不兼容时，在第一条业务 RPC 前终止宿主并返回可诊断的错误。

HTTP wire codec 使用 `$dbstudio` 标记包装二进制和特殊值；业务对象恰好包含该键时会自动转义。driver-host 的 NDJSON 仍是内部进程协议，调用方应通过 `DriverHost`，不要自行拼接 stdio 帧。

## 验证入口

- `pnpm run test:architecture`：源码跨层 import 和 renderer facade 边界。
- `pnpm run test:backend-contract`：Backend facade、错误 envelope 和 API manifest。
- `pnpm run test:http-transport`：wire codec、remote capability、dispatcher、取消/超时和真实 Node HTTP 往返。
- `pnpm run test:http-server-composition`：principal、owner scope、remote manifest 和 owner 存储隔离。
- `pnpm run test:http-server-handler`：HTTP body/response 限制、并发额度、request id 与断连 signal。
- `pnpm run test:http-server`：真实 localhost listener、JSON 往返、认证拒绝与优雅关闭。
- `node tests/e2e-http-owner-governance.mjs`：owner 请求/连接/存储租约、生命周期和审计事件。
- `pnpm run test:http-artifacts`：artifact ticket、二进制上传/下载、摘要校验、删除与 owner 隔离。
- `pnpm run test:artifact-contract`：opaque artifact id、purpose 与 sha256 校验。
- `pnpm run test:api-surface`：48 个 desktop method/channel 的 golden snapshot。
- `pnpm run test:handshake-contract`：主进程与 SDK 双侧 handshake/version compatibility。
- `pnpm run check:bundle-boundaries`：build 后检查 main、preload、renderer 和 driver-host 的实际 bundle 边界。
