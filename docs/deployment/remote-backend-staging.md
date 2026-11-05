# Remote backend staging 部署

HTTP backend 已提供可执行的独立 Node 入口与默认 Electron 环境认证接线。JWT 使用 `jose` 6 验证签名和 claims；部署方提供现有 IdP 签发的 access token、公开 JWKS、TLS 反向代理、持久卷和凭据加密 key。应用不签发 token，不提供自建 IdP、OIDC 登录页面或 refresh-token 服务。

## 构建和启动独立 Node 服务

使用 Node 22.13+（建议部署到 Node 24 LTS）和 pnpm。listener 不依赖 Electron 或 safeStorage；数据库驱动仍在独立 driver host 子进程运行。构建会同时生成 listener 与 driver host，运行环境必须保留项目生产依赖，不能只复制 listener 单文件。

```sh
pnpm install --frozen-lockfile
pnpm run build:http-server
```

默认产物为 `out/http-server/index.mjs` 与 `out/http-server/driver-host/index.cjs`。构建保留已有产物，不自动清空输出目录。以下由专用服务账号执行；将示例域名和目录替换为部署值。平台先把 **32 字节随机 key 的标准 base64 文本**挂载为 `/run/secrets/dbstudio-http-key`，权限为 0600，不打印内容、不写入仓库。不要每次启动重新生成 key。

```sh
install -d -m 0700 /srv/dbstudio/data
test -r /run/secrets/dbstudio-http-key

DBSTUDIO_HTTP_HOST=127.0.0.1 \
DBSTUDIO_HTTP_PORT=8123 \
DBSTUDIO_HTTP_AUTH_MODE=jwt \
DBSTUDIO_HTTP_REQUIRE_AUTH=1 \
DBSTUDIO_HTTP_JWT_ISSUER=https://idp.example.test/tenant \
DBSTUDIO_HTTP_JWT_AUDIENCE=dbstudio-staging \
DBSTUDIO_HTTP_JWT_JWKS_URL=https://idp.example.test/tenant/jwks \
DBSTUDIO_HTTP_DATA_DIR=/srv/dbstudio/data \
DBSTUDIO_HTTP_SECRETS_MODE=encrypted \
DBSTUDIO_HTTP_SECRET_KEY_FILE=/run/secrets/dbstudio-http-key \
DBSTUDIO_HTTP_ALLOWED_HOSTS=db.example.test,jump.example.test \
DBSTUDIO_HTTP_ALLOWED_PORTS=5432,22 \
pnpm run start:http-server
```

等价脚本命令是 `node scripts/build-http-server.mjs` 和 `node scripts/start-http-server.mjs`。进程托管器也可直接执行 `node out/http-server/index.mjs`，这样 SIGINT/SIGTERM 直接交给 listener；服务会关闭 listener、请求与 owner scope，再以正常退出码结束。启动成功只输出监听地址；独立入口失败只输出固定配置检查提示，不输出异常原文或 cause。

无需保存凭据的测试环境可设置 `DBSTUDIO_HTTP_SECRETS_MODE=disabled`，并移除两个 key 环境变量。此模式明确禁止持久化密码；需要凭据的连接不能依赖重启后自动恢复密码，不会降级成明文。

## 认证环境配置

HTTP 服务在 Electron 中默认关闭；配置 `DBSTUDIO_HTTP_PORT` 后启用。独立 Node 入口要求显式配置端口、数据目录和凭据存储策略。缺失配置、非法模式或不可读取的本地公钥文件会在监听前失败。

| 环境变量 | 约束与作用 |
| --- | --- |
| `DBSTUDIO_HTTP_HOST` | 默认 127.0.0.1；可绑定受控内网地址，网络隔离由平台配置 |
| `DBSTUDIO_HTTP_PORT` | 0–65535；0 供本地测试分配临时端口，staging 使用固定端口 |
| `DBSTUDIO_HTTP_AUTH_MODE` | staging 使用 jwt；完整 JWT 环境配置也会自动选择 jwt |
| `DBSTUDIO_HTTP_REQUIRE_AUTH` | 1/true 禁止固定本地 owner 回退；不豁免签名或 claims 校验 |
| `DBSTUDIO_HTTP_JWT_ISSUER` | 必填，与 token 的 iss 精确匹配 |
| `DBSTUDIO_HTTP_JWT_AUDIENCE` | 必填，与 token 的 aud 匹配，支持 JWT 自身的字符串或数组 aud |
| `DBSTUDIO_HTTP_JWT_JWKS_URL` | HTTPS 公开 JWKS URL；禁止 URL 凭据、查询参数和 fragment |
| `DBSTUDIO_HTTP_JWT_JWKS_FILE` | 本地公开 JWKS 普通文件（最多 1 MiB，不接受最后一级符号链接或 FIFO）；与 URL 二选一，只接受 RS256/ES256 公钥，不接受私钥或对称 key |
| `DBSTUDIO_HTTP_OWNER_ID` | 只允许 loopback 的显式 local 配置，不能与 jwt 或 REQUIRE_AUTH 一起使用 |
| `DBSTUDIO_HTTP_DATA_DIR` | 独立 Node 必填的绝对目录；自动创建为 0700，既有目录必须仅服务账号可访问 |
| `DBSTUDIO_HTTP_SECRETS_MODE` | 独立 Node 必须显式选择 encrypted 或 disabled |
| `DBSTUDIO_HTTP_SECRET_KEY_FILE` | encrypted 模式的标准 base64 key 文件，32 字节、0600，不接受最后一级符号链接 |
| `DBSTUDIO_HTTP_SECRET_KEY_BASE64` | 由 secret manager 注入的标准 base64 key；与 key 文件二选一，不打印、不提交 |

验签固定只允许 **RS256、ES256**，不能通过 token header 或环境变量扩展算法。必须存在合法 `iss`、`aud`、`exp`、`sub`；过期 token、未来 `nbf`、空 sub、无签名、错误签名和不匹配的 issuer/audience 都返回 401。公开 JWKS 配置不需要 IdP 私钥。

远程 JWKS 使用 jose 的缓存和 key 轮换机制，首次有效认证请求才拉取 JWKS，单次拉取超时为 5 秒。URL 格式在启动时校验；远程 JWKS 是否可达、是否包含匹配 key 由请求时验证。JWKS 网络故障与 token 无效统一返回 unauthorized。本地 JWKS 在启动时加载，修改公钥文件后需重启服务。

所有认证结果只投影为 `{ id: string, roles?: readonly string[] }`。roles 如存在，必须是非空字符串组成的数组；额外 claims、token、provider 内部字段不会进入 principal。RPC、connection 和 artifact 三类入口都统一包裹裸 resolver：provider/verifier 的同步异常、Promise rejection、非法 principal 和非法 roles 一律返回 `unauthorized` / `认证失败`，不保留原 message、details 或 cause。roles 当前作为身份元数据；资源隔离按经过认证的 sub/owner 执行，未实现组织级角色授权策略。

本地兼容模式需要显式 `DBSTUDIO_HTTP_AUTH_MODE=local`、loopback host 和 `DBSTUDIO_HTTP_OWNER_ID`。旧版 loopback + 显式 OWNER_ID 配置继续有效，但不能用于 staging；设置 REQUIRE_AUTH 后本地回退被拒绝。没有 JWT、provider 或显式本地 owner 时，服务不会自动创建默认身份。

Electron 主进程默认启动也使用同一环境认证配置，无需调用方额外注入 verifier。Electron 的持久化凭据继续使用 safeStorage；独立 Node 使用上述 AES-256-GCM cipher，二者的加密数据目录不要混用。

## 客户端首次认证与刷新

桌面客户端通过明确的环境变量切换远程 backend：`DBSTUDIO_BACKEND_ENDPOINT` 指向 HTTPS RPC endpoint（本机开发允许 loopback HTTP），`DBSTUDIO_BACKEND_ACCESS_TOKEN` 由已有 IdP/平台 secret 环境注入短期 access token。缺少 token 必须失败关闭。token 保留在 preload 内存的请求头回调中，不写进 HTML、静态 JSON、连接配置或普通日志。

```sh
# DBSTUDIO_BACKEND_ACCESS_TOKEN 已由平台注入；不要在命令行写 token 字面量。
DBSTUDIO_BACKEND_ENDPOINT=https://dbstudio.example.test/rpc pnpm run dev
```

构建后的桌面应用由启动器提供同样两个变量。这个入口使用单次启动时提供的短期 token；token 过期后，需要由受信任 shell 的 session provider 刷新，或重新登录并以新 token 启动应用。单独设置 endpoint 不会获得身份，也不代表应用提供了浏览器登录流程。

浏览器部署或已有受信任 shell 可在 renderer bundle 加载前注入运行时配置。下面的 `deploymentSession` 由部署环境提供，其 `getValidAccessToken` 负责首次取 token、并发刷新和过期处理，`login` 负责现有 IdP 登录；它不是本仓库内置服务。

```ts
const getHeaders = async () => ({
  authorization: `Bearer ${await deploymentSession.getValidAccessToken()}`
})
window.__DBSTUDIO_BACKEND_CONFIG__ = {
  mode: 'http',
  http: {
    endpoint: 'https://dbstudio.example.test/rpc',
    getHeaders
  },
  reconnect: async () => {
    await deploymentSession.login()
    return getHeaders()
  }
}
```

`http.getHeaders` 在每次 RPC/connection request 前异步调用，第一次请求也经过它。`reconnect` 是与 http 同级的配置，不是 http 的子字段；用户可手动重新登录/reconnect。401 不会自动重放 mutation。凭据刷新应在 session provider 内发生，避免把创建、更新、删除或事务操作当作安全重试。artifact 直接上传/下载客户端也需从同一个受信任 provider 获取最新 Bearer header。

## 反向代理与资源边界

由 HTTPS 反向代理终止 TLS，并将 `/rpc`、`/connections`、`/artifacts/` 转发到受控 Node listener。listener 不提供静态站点、登录桥接或健康检查专用 route。代理需要限制请求头、body、response、连接数和超时，不信任客户端自报 owner header。不要把 listener 暴露在允许跳过认证的代理路径下。

同源浏览器反代无需配置 CORS。打包后的 Electron 使用 `file://` 页面；不同版本可能省略 Origin 或发送字面量 `null`。需要支持带 Origin 的桌面请求时，在 **backend 服务端**显式设置 `DBSTUDIO_HTTP_ALLOWED_ORIGINS=null`。`pnpm dev` 的页面来自 Vite，其 origin 是开发服务器的具体地址（例如 `http://localhost:5173`），服务端应显式允许该实际 origin；开发态不要填写 `null`。跨源浏览器部署应填写明确 origin，例如 `DBSTUDIO_HTTP_ALLOWED_ORIGINS=https://frontend.example.test`；多个来源用逗号分隔。禁止 `*`，默认空数组不允许跨源。允许 `null` 会接纳同样使用 opaque origin 的页面，因此只应在需要桌面客户端的受控部署中启用；所有实际业务请求仍必须持有有效 Bearer token。

仅 JWT 模式或 `DBSTUDIO_HTTP_REQUIRE_AUTH=1` 的部署允许启用该配置；local 固定 owner 模式即使绑定 loopback 也会拒绝启用，避免把本地身份通过跨源页面暴露。预检放行不代表认证成功，CORS 配置不替代 JWT 验签。

```sh
# 与上文JWT/auth/data/cipher环境配置一起设置在backend进程上：
DBSTUDIO_HTTP_ALLOWED_ORIGINS=null pnpm run start:http-server
# 跨源浏览器部署使用实际前端origin；同源反代则不设置该变量。
```

| 环境变量 | 作用 |
| --- | --- |
| `DBSTUDIO_HTTP_ALLOWED_ORIGINS` | CORS 来源 allowlist，逗号分隔；桌面 file origin 显式使用 null，浏览器使用具体 origin，禁止 *；仅 JWT/REQUIRE_AUTH 模式允许 |
| `DBSTUDIO_HTTP_ALLOWED_HOSTS` | 数据库、SSH 和 Kafka 出站主机 allowlist，逗号分隔；空集合拒绝全部 |
| `DBSTUDIO_HTTP_ALLOWED_PORTS` | 出站端口 allowlist；无效端口让启动失败 |
| `DBSTUDIO_HTTP_MAX_CONCURRENT_REQUESTS` | 单实例 RPC/artifact/connection 共享上限，以及默认 owner 请求上限 |
| `DBSTUDIO_HTTP_MAX_CONNECTIONS` | 每个 owner 的连接额度 |
| `DBSTUDIO_HTTP_MAX_STORAGE_BYTES` | 每个 owner 的 artifact 存储额度 |
| `DBSTUDIO_HTTP_ARTIFACT_MAX_BYTES` | artifact 单文件上限 |
| `DBSTUDIO_HTTP_ARTIFACT_MAX_TOTAL_BYTES` | artifact store 总容量上限 |
| `DBSTUDIO_HTTP_ARTIFACT_SWEEP_INTERVAL_MS` | artifact 过期清理周期 |

出站策略还会拒绝 loopback、特殊/不安全地址和 server-local 路径字段；仅把目标写入 allowlist 不会绕过这些规则。SQLite/本机文件不是远程连接目标。允许的数据库目标应在受控网络中，数据库账户权限独立于应用 owner 隔离。

## 数据、key 与部署限制

每个 owner 使用 sub 的 SHA-256 子目录；持久卷覆盖整个数据根目录，连接配置与密文凭据分开存储。独立 cipher 使用 AES-256-GCM 随机 nonce 和认证 tag，拒绝被篡改的密文。key 来自平台 secret manager，不写进数据文件。

- 备份数据卷、artifact data/metadata，并独立安全备份加密 key；恢复时保持原 key 和 owner sub。
- 目前没有加密 key 自动轮换或旧 key 回退。更换/丢失 key 后旧密文无法恢复，需要受控迁移或重新输入凭据。
- 不能直接把 Electron safeStorage 密文迁到 Node cipher，也不能通过复制数据目录完成 IdP sub 迁移。
- 当前本地文件 store 面向单实例；未实现跨实例锁、共享数据库或分布式任务协调。不要让多个进程共享同一 owner 数据目录。
- JWT 不做在线 introspection、即时注销或吊销查询；使用短有效期 access token，并由部署 IdP 管理 session 与签发/轮换。
- 审计和指标默认输出安全事件元数据。生产可注入正式 sink；不得记录 Authorization、密码、请求体、response value 或错误 cause。

## 验证命令与 staging smoke

仓库内定向测试：

```sh
pnpm run typecheck
pnpm run test:http-auth
pnpm run test:http-server-config
pnpm run test:http-server-runtime
```

这些测试仅生成临时 key/token，不输出内容。覆盖 RS256/ES256、必要 claims、错签名、过期、非法 roles、provider 异常、真实 listener 三类入口统一 401，以及真正构建/启动 Node 子进程、env 失败关闭、cipher/临时 store 重载和 SIGTERM 退出。运行验证不依赖真实 IdP、生产密钥或数据库；不表示真实 staging 或真实数据库已经连通。

部署后先验证未认证响应，仅输出状态码：

```sh
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  https://dbstudio.example.test/connections
# 期望 401
```

再由平台注入 `DBSTUDIO_SMOKE_ENDPOINT` 和测试身份的 `DBSTUDIO_SMOKE_ACCESS_TOKEN`，执行不输出 token/响应内容的认证探测：

```sh
node --input-type=module <<'JS'
const endpoint = process.env.DBSTUDIO_SMOKE_ENDPOINT
const token = process.env.DBSTUDIO_SMOKE_ACCESS_TOKEN
if (!endpoint || !token) throw new Error('缺少平台注入的 smoke 配置')
const response = await fetch(new URL('/connections', endpoint), {
  headers: { authorization: `Bearer ${token}` }
})
if (response.status !== 200) throw new Error('staging 认证探测失败')
console.log('staging authenticated: 200')
JS
```

随后用两个独立测试身份验证连接 owner 隔离；对允许的真实数据库目标执行 test/connect/list/disconnect/update/delete，确认另一身份无法操作该 connection id。验证非法出站目标拒绝、artifact 一次性 ticket/TTL/quota、取消请求释放 lease，以及 SIGTERM 后重启仍能读取原配置和凭据。核对审计不含凭据；这些是部署环境验收，不能用本地合成测试代替。

回滚时先停止反向代理向新 listener 转发，保留数据卷、原加密 key 和审计记录，切回上一已验证发布。保持 IdP issuer/audience、owner sub 和出站 allowlist 一致，重新执行 401/200 认证探测与 owner 隔离验证。发布记录只记 request id、稳定错误 code、版本和时间窗口。
