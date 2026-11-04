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

HTTP client 使用 `RemoteBackendApi`，从 manifest 派生的 remote projection 会排除 `chooseImportFile`。远程 transport 也不能接收服务端任意本机绝对路径作为上传或下载接口；远程文件能力应使用 upload token、download artifact 或 job handle 单独建模。

当前 HTTP 代码提供：

- transport-neutral wire codec；
- `Uint8Array`、`undefined` 和 `bigint` 的 JSON 可逆编码；
- manifest 路由与 dispatcher；
- 结构化成功/失败 envelope；
- client 侧 request id、取消和超时。

这一切是 transport prototype。仓库当前没有把它声明为可直接暴露到互联网的多用户 server：HTTP 组合根、认证、请求上下文、资源 owner、限流、body limit、断连取消和持久化 job store 仍需在 server 产品阶段补齐。把 dispatcher 接入真实 server 时，必须先在边界处完成 principal 认证，再创建 owner-bound application scope。

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
- `pnpm run test:api-surface`：48 个 desktop method/channel 的 golden snapshot。
- `pnpm run test:handshake-contract`：主进程与 SDK 双侧 handshake/version compatibility。
- `pnpm run check:bundle-boundaries`：build 后检查 main、preload、renderer 和 driver-host 的实际 bundle 边界。
