# Remote backend staging 部署

这份部署说明适用于 dbstudio 的 HTTP remote backend staging 环境。服务本身只提供可替换的 principal resolver 和 Bearer token adapter；JWT/mTLS 校验、密钥托管、TLS 终止和组织级审计由部署环境注入。

## 启动边界

HTTP 服务默认关闭。staging 需要显式设置 `DBSTUDIO_HTTP_PORT`，并为非 loopback host 注入认证 provider。远程 host 不允许使用固定 `DBSTUDIO_HTTP_OWNER_ID`。

建议通过反向代理终止 TLS，再将代理到 Node HTTP listener 的连接限制为受信任网络。代理应继续限制 request body、response body、连接数、请求超时和 header 大小；应用层仍保留自己的限制作为第二层防护。

必须配置：

| 环境变量 | 作用 |
| --- | --- |
| `DBSTUDIO_HTTP_HOST` | Node listener 地址；远程环境使用受控内网地址 |
| `DBSTUDIO_HTTP_PORT` | listener 端口；设置后才启动 HTTP 服务 |
| `DBSTUDIO_HTTP_ALLOWED_HOSTS` | 数据库、SSH 和 Kafka 出站主机 allowlist，逗号分隔 |
| `DBSTUDIO_HTTP_ALLOWED_PORTS` | 出站端口 allowlist，逗号分隔 |
| `DBSTUDIO_HTTP_MAX_CONCURRENT_REQUESTS` | 单实例共享 RPC、artifact、connection route 并发上限 |
| `DBSTUDIO_HTTP_MAX_CONNECTIONS` | 每个 owner 的连接租约上限 |
| `DBSTUDIO_HTTP_MAX_STORAGE_BYTES` | 每个 owner 的 artifact 存储租约上限 |
| `DBSTUDIO_HTTP_ARTIFACT_MAX_BYTES` | artifact 单文件大小上限 |
| `DBSTUDIO_HTTP_ARTIFACT_MAX_TOTAL_BYTES` | artifact store 的持久总容量上限 |
| `DBSTUDIO_HTTP_ARTIFACT_SWEEP_INTERVAL_MS` | artifact 过期清理周期 |

配置解析失败必须让进程启动失败。allowlist 使用 fail-closed 语义；没有配置允许主机或端口时，远程连接会被拒绝。

## 认证 provider

应用组合根通过 `HttpAuthProvider` 或 `createBearerTokenPrincipalResolver` 注入认证实现。provider 的输出只有：

```ts
{ id: string, roles?: readonly string[] }
```

token 只能在 provider 内部验证，不得写入 principal、request body、audit event、metrics event、连接 summary、错误 details 或普通日志。认证失败统一返回 `unauthorized`，不泄露 token 是否存在、是否过期或 owner 是否存在。

JWT 签名密钥、JWKS 地址、mTLS CA 和 client identity 必须由 staging secret manager 或平台证书系统提供。不要写进仓库、环境模板、截图或测试输出。

## 数据目录与备份

`HttpServerComposition` 为每个 owner 使用 owner id 的 SHA-256 子目录，连接配置、加密凭据、SQL library、任务状态和 artifact metadata 分开存储。staging 应为整个 owner 根目录配置持久卷，并执行：

- 按组织要求做加密磁盘和访问控制。
- 备份前验证文件权限；备份内容不能进入应用日志。
- 定期验证恢复到隔离目录后 owner 目录仍然互相不可读。
- artifact data 和 metadata 需要一起备份，恢复时保留 TTL/状态字段。
- 多实例部署前确认 owner 目录和 artifact store 使用支持并发锁的共享存储；本地文件 store 不作为多实例共享生产方案。

## 审计与指标

生产环境将 `auditSink` 和 `metricsSink` 注入正式出口。事件只包含 request id、owner、route/method、status、duration、outcome 和稳定 error code。sink 故障不得改变业务响应；sink 本身应有丢弃计数和告警。

建议建立以下告警：

- `unauthorized` 突增。
- owner request、connection 或 storage quota 拒绝。
- 出站 allowlist 拒绝。
- driver host crash、timeout、cancelled 和 commit outcome unknown。
- artifact upload 失败、磁盘剩余空间不足、过期清理延迟。

## staging smoke

部署后按顺序验证：

1. 使用测试身份访问 `/connections`，确认只看到自己的 owner scope。
2. 创建一条允许目标的连接，执行 test、connect、list、disconnect、update、delete。
3. 使用另一测试身份访问第一身份的 connection id，必须返回 `not-found`。
4. 使用不在 allowlist 的数据库、SSH host、Kafka broker 和路径字段，必须被拒绝。
5. 上传、下载和删除 artifact，确认 owner 隔离、ticket 一次性、TTL 清理和 quota 拒绝。
6. 中断客户端请求，确认查询/连接测试收到取消信号，server 不留下 lease。
7. 检查 audit/metrics 中不存在 token、密码、请求体或 response value。

## 回滚

发现连接控制面或认证回归时：

1. 让反向代理停止向新的 HTTP listener 转发。
2. 保留 owner 数据卷和 audit/metrics 记录，不删除运行状态。
3. 回滚到上一已验证 commit，重新启动时使用同一 allowlist 和认证 provider 配置。
4. 重新执行 `/connections`、owner isolation、artifact 和 health smoke。
5. 将失败请求 id、错误 code、commit 和时间窗口记录到发布记录，不记录请求体、token 或密码。
