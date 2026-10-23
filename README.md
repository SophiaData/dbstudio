# dbstudio

数据库客户端的第一块地基：**元数据/方言抽象 + 连接管理**，用 Node/TypeScript + Electron 实现。

架构不是凭空设计的，而是从对 DBeaver 源码的剖析结论里提炼的——剖析报告在
`../dbeaver-analysis/`（证据版本 `devel@cf0f184e`）。

---

## 一句话架构

> **驱动跑在独立子进程里，主进程只做编排，渲染进程只做展示。**

```
┌─────────────────────────────────────────────────┐
│  渲染进程 (src/renderer)                         │
│  虚拟化懒加载元数据树 · 详情面板 · 新建连接表单    │
│  只知道 window.dbstudio，不知道 SQLite 是什么      │
└─────────────────────┬───────────────────────────┘
                      │ 28 个白名单方法（src/core/api.ts）
┌─────────────────────▼───────────────────────────┐
│  preload (src/preload)                           │
│  contextBridge 显式枚举，多一个都不给              │
└─────────────────────┬───────────────────────────┘
                      │ ipcMain.handle（逐通道注册）
┌─────────────────────▼───────────────────────────┐
│  主进程 (src/main)                               │
│  ConnectionManager：连接生命周期 + 节点 id 作用域  │
│  DriverHostHandle：NDJSON over stdio 的 RPC 客户端 │
│  **一行数据库代码都没有**                          │
└─────────────────────┬───────────────────────────┘
                      │ spawn + JSON-RPC（NDJSON）
┌─────────────────────▼───────────────────────────┐
│  驱动宿主进程 (src/driver-host)  ← 一个连接一个   │
│  DriverRegistry → DriverAdapter (SQLite)          │
│  node:sqlite，零原生依赖                          │
└──────────────────────────────────────────────────┘
```

---

## 为什么这样分层（三条来自剖析的硬结论）

### 1. 为什么驱动在子进程，而不是主进程里

DBeaver 给**每个驱动一个独立 `URLClassLoader`**
（`registry/.../DriverClassLoader.java`，全文 79 行），解决的是
「两个驱动依赖同一个库的不同版本，在同一 JVM 里必然打架」。

**Node 没有 ClassLoader，`require` 缓存是全局的，同一进程内无法并存两个版本。**
所以照抄类加载器隔离是不可能的，唯一正确的做法是**进程隔离**。

代价与收益：多一层 RPC 开销，换来某个驱动的原生崩溃 / 内存泄漏**只影响它自己那个进程**。

### 2. 为什么能力声明只有一套，而不是三套

DBeaver 的能力探测是「接口布尔方法 + 描述符声明 + 运行时探测」三机制并存
（剖析报告 `03-metadata-dialect.md` 问题 5），那是十余年的历史累积。

本项目只用**一套**：`DriverCapabilities`，由 adapter 在 `connect()` 时给出。
它可以是静态写死的，也可以是连上后探测的结果——但**出口只有一个**。

### 3. 为什么 `SqlDialect` 不给任何隐藏默认值

这是剖析里最值得抄的一条教训。DBeaver 的 `getOffsetLimitQueryPart` 全仓只有 2 处命中：
接口声明（`SQLDialect.java#L332`）和唯一一份默认实现
（`AbstractSQLDialect.java#L643-L645`，内容 `LIMIT %d OFFSET %d`）。
**MySQL 和 PostgreSQL 都没有覆盖它**——「默认值」实际承担了「多数方言的契约」，
而契约藏在默认实现里、没有文档、改默认值会静默影响所有方言。

所以本项目的 `SqlDialect` 每个方法都必须显式实现，宁可多写几行，
也不要一个会静默传播的默认。

---

## 不该照搬的（以及我们改成了什么）

| DBeaver 的做法 | 为什么不能照搬 | 本项目的做法 |
|---|---|---|
| 每驱动一个 `ClassLoader` | Node 没有 ClassLoader，`require` 缓存全局 | **进程隔离**：一个连接一个子进程 |
| LightGrid 自绘 Canvas 表格 | 自研动机是 SWT Table **给不了**多级列头/固定列，不是"慢" | **DOM 虚拟滚动**，保留浏览器原生无障碍与选区 |
| Eclipse Job + 泵事件循环 | SWT 单 UI 线程模型特有 | 渲染进程纯异步；主进程不做同步 DB 操作 |
| 365 个插件的扩展点体系 | 间接层成本巨大，过早抽象是这类项目最常见死法 | 起步就是 `Map<dialectId, factory>` |
| `cacheStructure(STRUCT_ALL)` 全量读 | 打开 ER 图会一次拉完所有元数据 | 懒加载契约：`listChildren` 只允许返回**直接子节点** |

---

## 目录

```
src/
  core/            契约层（无 I/O、无 UI）—— 所有并行工作的唯一事实源
    model.ts         ObjectRef / TableDescription / DriverCapabilities
    dialect.ts       SqlDialect / ConnectionConfig（不含密码）
    driver.ts        DriverAdapter / RPC 协议帧
    registry.ts      方言注册表
    api.ts           渲染进程 API 面 + IPC 通道 + NodeId 编解码
    resultset.ts     结果集契约：游标 / 分页 / 单元格值 / 大值截断
  drivers/
    index.ts         ★ 驱动清单唯一出口（新增方言只有这一处要改）
    sqlite/          SQLite 适配器（node:sqlite，零原生依赖）
  driver-host/     驱动宿主进程（纯 Node，禁止 import electron）
  main/            Electron 主进程
  preload/         白名单桥（28 个方法）
  renderer/
    tree.ts         虚拟化懒加载元数据树
    grid.ts         结果集网格：虚拟滚动 + 按页取数
    main.ts         接线：树 / 网格 / SQL 执行条
scripts/
  build-driver-host.mjs  单独打包宿主（vite build API）
  make-fixture.mjs       造测试夹具（故意含无主键表与 sqlite_ 内部表）
  acceptance.mjs         在 Electron 内置 Node 下跑验收
  run-in-electron.mjs    在 Electron 环境跑脚本的包装器
tests/
  e2e.mjs                 43 条：元数据 / 连接 / 协议
  e2e-resultset.mjs       76 条：查询 / 分页 / 游标 / 编辑判定
  probe-entry.ts          探针入口（用真实注册表，避免"替答案写好"的假阳性）
```

---

## 安装（普通用户）

从 [Releases](https://github.com/SophiaData/dbstudio/releases) 下载对应平台的安装包：

| 平台 | 文件 |
|---|---|
| macOS (Apple Silicon) | `dbstudio-x.y.z-arm64.dmg` |
| macOS (Intel) | `dbstudio-x.y.z-x64.dmg` |
| Windows | `dbstudio-x.y.z-setup.exe` |
| Linux | `dbstudio-x.y.z.AppImage` |

> ⚠️ **macOS 首次打开会被 Gatekeeper 拦**：当前版本未做代码签名与公证
> （需要苹果开发者账号，$99/年）。两个绕过办法：
> - 右键点 app → 「打开」→ 再点「打开」
> - 或执行 `xattr -dr com.apple.quarantine /Applications/dbstudio.app`

## 从源码运行（开发者）

```bash
pnpm install
pnpm dev            # 开发模式
```

### 自己打包安装包

```bash
pnpm build:app        # 打当前平台
pnpm build:app:mac    # 或 :linux / :win
```

产物在 `release/`。

**打包有一个必须注意的点**：驱动宿主是 `child_process.spawn` 拉起的独立脚本，
而 `app.asar` 内的文件**无法被执行**。所以 `electron-builder.config.mjs` 里必须有：

```js
asarUnpack: ['out/driver-host/**', 'node_modules/**']
```

漏了这行，应用能启动、界面正常，但**连不上任何数据库**——症状很有迷惑性。
`node_modules` 也必须解包：驱动宿主从 `app.asar.unpacked` 执行时，
Node 的模块查找不会跨回 `app.asar` 去加载 `pg` / `ssh2`。
`src/main/DriverHostHandle.ts` 的路径候选列表里预留了
`app.asar.unpacked/out/driver-host/index.js`，与此配置对应。

---

## 验证

```bash
pnpm install
pnpm verify      # 二十四段全链（含 8 段 GUI；PG / SSL / SSH 无环境时自动跳过）
```

`pnpm verify` 依次执行（顺序与 `package.json` 里的 `verify` 脚本一致）：

| 阶段 | 命令 | 验证什么 |
|---|---|---|
| 1 | `typecheck` | strict 模式零错误 |
| 2 | `build` | 宿主 + main/preload/renderer 全部构建 |
| 3 | `fixture` | 夹具可生成，且**确实含 `sqlite_` 内部表**（保证过滤断言有区分度） |
| 4 | `test` | 元数据/连接 e2e **43/43**，经 stdio 与宿主对话 |
| 5 | `test:resultset` | 结果集 e2e **76/76**：查询 / 分页 / 乱序取页 / 游标 |
| 6 | `test:edit` | 在线编辑 e2e **60/60**：参数化 UPDATE / 事务 / 回滚 / 跨连接隔离 |
| 7 | `test:persist` | 持久化 e2e **62/62**：配置落盘 / 具名凭据与旧密文迁移 / 坏文件降级 / 明文泄漏断言 |
| 8 | `test:mutations` | 增删改 e2e **56/56**：INSERT/DELETE/空数组拒绝/注入防护 |
| 9 | `test:ddl` | DDL e2e **53/53**：建表/删表/视图/重命名/类型与默认值白名单 |
| 10 | `test:postgres` | PG e2e **45/45**（真实 PG 17.11；无环境时自动跳过） |
| 11 | `test:cancel` | 取消能力 **15/15**：PG 真取消（516ms 中断 10s 慢查询）/ SQLite 如实不支持 |
| 12 | `test:postgres-ssl` | SSL **23/23**：6 种 sslmode 的加密/校验语义 + 错误 CA 真被拒 + SSL 连接上取消真生效 |
| 13 | `test:ssh-tunnel` | SSH **21/21**（真实 sshd + PG）：结构化分段诊断 / 首次指纹确认 / 指纹变化 / 未授权私钥 / 隧道 SQL / 取消 |
| 14 | `test:gui-layout` | 布局持久化 GUI 测试 **20/20**：拖列宽/排序落进 localStorage、重开表恢复、重置回默认 |
| 15 | `test:electron` | **19/19**，在 Electron 内置 Node 下验证运行时形态 |
| 16 | `test:gui` | 真实启动窗口，从渲染进程取 DOM 确认 API 注入与 safeStorage 往返 |
| 17 | `build:sdk` | 构建 SDK 发布产物（含 core 的 d.ts，保证 dist 内自闭合） |
| 18 | `test:sdk` | **30/30**（从 dist 产物导入，模拟外部用户） |
| 19 | `test:gui-flow` | **Playwright 驱动真实点击**：建连接→展开树→点表→改单元格→应用→提交→验证落库 |
| 20 | `test:gui-features` | 真实点击验证：树搜索/排序/列宽/统计/CSV/新增行/删除行/右键菜单 |
| 21 | `test:gui-round3` | 真实点击验证：多标签页 / DDL 对话框 / 编辑连接 |
| 22 | `test:gui-sql` | 真实点击验证 SQL 编辑器：高亮 / 多语句 / 执行计划 / 格式化 |
| 23 | `test:gui-ssl-form` | SSL 表单 **7/7**：sslmode 是 select 而非文本框、默认 prefer、提交值原样落盘 |
| 24 | `test:gui-ssh-form` | SSH 表单 **20/20**：三个独立密码框 / 指纹确认后自动重试 / 连接失败不假报成功 / 编辑时能清空 `sshHost` |

单独跑：

```bash
pnpm dev                # 开发模式（会先构建驱动宿主）
pnpm test               # 元数据 e2e
pnpm test:resultset     # 结果集 e2e
pnpm test:electron      # Electron 内置 Node 验收
pnpm test:gui           # GUI 冒烟
```

---

## 结果集：为什么必须分页而不是一次拉完

这是剖析报告「陷阱 5」的正面实现，值得单独说清楚。

DBeaver 单进程内直接持有 `ResultSet`，滚动条以**行**为单位、上限是「已加载行数 + 1」
（`LightGrid.java#L1057` / `#L2581-L2589`），所以它从不需要知道总数。

Electron 里照抄会翻车：数据库在驱动宿主进程、主进程居中转发、渲染进程只负责画。
一次性把 100 万行经 IPC 搬过去会序列化爆内存，而那 99% 用户根本看不到。

所以本项目的取数模型是：

```
runQuery(sql)                    → 只取第一页，返回 cursorId
  ↓ 网格滚动到可视区
fetchResultPage(cursor, offset)  → 按偏移量随机取那一页
  ↓ 用户切换查询
closeCursor(cursor)              → 立刻释放
```

网格侧配套三条约束（`src/renderer/grid.ts`）：
- **页缓存**：只缓存用户看过的页，页大小 100
- **在途去重**：同一页飞行中不重复发请求
- **耗尽标记**：`hasMore === false` 后停止请求

`hasMore` 是**推断**而非 `COUNT(*)`（本页拉满即认为可能还有），
因为大表上 COUNT 是全表扫描——这也是 DBeaver 的做法。

### 一个已知代价（不回避）

SQLite 的分页实现是 `SELECT * FROM (原始SQL) LIMIT ? OFFSET ?`，
**深翻页时数据库要跳过 offset 行**，越往后越慢。30 万行实测：
offset 0 → 0.09ms，10000 → 0.13ms，100000 → 0.78ms，299000 → 3.21ms。
代价已写进 `src/drivers/sqlite/results.ts` 注释；要根治需要键集分页（keyset pagination），
而它要求知道排序键，属于下一阶段。

---

## 在线编辑：为什么用主键值而不是行号

初版契约把 `RowUpdate.rowIndex`（结果集下标）当作行标识，**这是错的**：

1. **拼不出 WHERE** —— UPDATE 需要 `WHERE pk = ?`，下标不存在于数据库里
2. **下标会漂移** —— 用户重排序/重查/并发插入后，第 5 行早已不是那行，
   改数据会**静默改错行**，这比报错严重得多
3. 这正是 DBeaver 要求 `DBDRowIdentifier` 的原因：要的是"能唯一定位一行的列值"

所以改成 `keyValues`（主键值）+ `changes`（新值）。

### 事务语义

```
applyEdits → BEGIN IMMEDIATE，写入但不提交
  ↓
commitTransaction → 落库
或 rollbackTransaction → 撤销
```

- **缺唯一键直接拒绝**（消息含 DBeaver 原话 "No unique key defined"）
- **值一律参数化**（`?` 占位），表名列名走 `quoteIdentifier`
- **任一行失败不自动回滚**，把逐行 error 返回让上层决定
- `disconnect` 时若事务未提交 → 自动回滚，不留半提交状态

注入防护已验证到"反证"级别：把同一 payload 直接拼进 SQL 会改掉 3 行，
而走参数化 `affected=0` —— 证明挡住它的是参数化本身，不是"碰巧没匹配"。

---

## SSL：为什么不能把 sslmode 直接丢给 pg

`sslmode` 的取值沿用 libpq 的名字，但 **`pg`（node-postgres）的实现与 libpq 不等价**。
这三点是实测得出的（PG 17 + pg 8.23），不是文档推测：

| 模式 | libpq 的语义 | `pg` 直接传时的实际行为 |
|---|---|---|
| `require` | 只要求加密，**不校验证书** | `ssl: true` 会校验证书 → 自签库直接连不上 |
| `prefer` | 先试 SSL，服务端不支持就**回退明文** | 不回退，直接抛 `does not support SSL` |
| `verify-ca` | 校验证书链，不校验主机名 | 需显式覆盖 `checkServerIdentity` 才不会误查主机名 |

所以映射由 `src/drivers/postgresql/ssl.ts` 显式实现，回退逻辑也在那一层。
两条刻意的保守选择：

- **`prefer` 只在"服务端不支持 SSL"时回退**；若 TLS 握手成功但认证失败，
  直接抛该错误——再试明文不会有不同结果，只会用第二个更难懂的错误盖掉真正原因。
- **全部失败时抛第一个错误**，因为第一个尝试才对应你显式选的策略。

取消查询**复用同一套 SSL 策略**：它要另开一条连接发 `pg_cancel_backend`，
若那条连接忘了带 SSL，会被 `pg_hba` 拒绝，表现为"取消按钮点了没反应"——
而这个 bug 只会在远端 SSL 库上出现，本机永远复现不了。

## SSH 隧道：主机指纹不做 TOFU

跳板机后面的自建库只能经 SSH 到达。实现放在驱动宿主进程内
（`src/drivers/postgresql/ssh-tunnel.ts`），隧道生命周期与数据库连接一致；
同一会话内的 SSL 回退与取消查询会在一条 SSH 连接上另开 channel，
断开或重连时重新建立隧道。

安全上的关键选择是**首次连接不静默信任**：

1. 没有预置 `sshHostKeySha256` 时，连接被拒绝，错误里带实际
   `SHA256:...` 指纹（与 `ssh-keygen -lf` 同格式）；
2. 新连接界面会弹出独立确认框展示 SSH 主机、端口与实际指纹，用户确认后
   写回 `sshHostKeySha256` 并自动重试；已保存指纹不一致时同时展示期望值与
   实际值，并明确警告“可能是中间人攻击，或跳板机重装过”；
3. 私钥只读文件路径，私钥口令/SSH 登录口令/数据库口令分别存放，
   不会拼成一个字符串，也不会进入 `connections.json`。

`testConnection` 还会返回 `checks` 分段结果（配置解析、SSH 握手、主机指纹、
SSH 认证、SSH 转发、数据库连接、服务端查询），失败时 UI 能直接指出停在哪一步。

实测踩到的一个协议坑：`pg` 把 `stream` 当 `net.Socket` 用，会调
`setNoDelay` / `setKeepAlive` / `connect`，而 ssh2 的 channel 是普通
`Duplex`。所以中间需要一层最小适配，否则会在建连阶段报
`this.stream.setNoDelay is not a function`。

## 持久化：配置与凭据分两条通道

```
connections.json   ← 配置（id/name/dialect/options），无任何密码
secrets.json       ← 凭据（base64 密文），单独文件
```

- **加密用 Electron `safeStorage`**（OS 级钥匙串），不是自研加密
- 系统不支持安全存储时**拒绝保存密码**，而不是退化成明文
- 于是出现第三种状态：配置存了、密码没存 → 用 `secretStored: false` 让 UI 明确提示
- **原子写**（临时文件 + rename），避免写一半断电
- **坏文件不删**，改名 `.corrupt-<时间戳>` 备份——用户配置可能还能手工救回
- **载入不等于连接**：启动只载配置，不挨个连库（否则启动慢且可能弹一堆错误）

---

## 一次架构违规的修复（记录在案）

第三阶段后曾发现 **`out/main/index.js` 内含完整 SQLite 实现**（`DatabaseSync` + 9 处 `PRAGMA`，产物 102KB）：
主进程为了取方言清单 `import '../drivers'`，顺着 `registerBuiltinDrivers → adapter.ts → node:sqlite`
把实现打进了主进程 bundle，**"驱动崩了不拖垮主进程"这个承诺当场失效**。

修法是**把方言元数据与实现分离**：

```
src/drivers/dialect-metadata.ts   ← 只 import 各驱动的 info.ts（纯数据）
                                   主进程 / 渲染进程 / 测试都安全
src/drivers/index.ts              ← 带实现，只给驱动宿主进程用
```

结果：主进程产物 **102KB → 56KB**，`DatabaseSync`/`PRAGMA`/`require("node:sqlite")` 归零。

**教训**：`DialectInfo` 本来就是纯数据，不该牵着实现走。
新增方言时两处都要加一行——这点重复正是隔离的代价，合并了隔离就悄悄没了。

---

## 功能清单

### 已具备

| 能力 | 说明 |
|---|---|
| **多方言** | SQLite（`node:sqlite`，零依赖）+ **PostgreSQL**（`pg`，实测 PG 17.11 42/42 通过） |
| 连接管理 | 配置落盘、密码经 OS 钥匙串加密；**连接颜色标记**（7 色，红=生产/绿=本地）；**连接分组**（真父节点，可重命名/删除，删组不删连接） |
| 元数据浏览 | 虚拟化懒加载树；搜索过滤（明确标注「仅搜索已展开节点」）；右键刷新/复制/连接断开/查看 ER 图 |
| **SQL 编辑器** | 语法高亮（textarea+pre 叠加，零依赖）、**自动补全**（关键字+表名列名）、**格式化**（Shift+Alt+F）、**多语句执行**（Ctrl+Enter 当前 / Ctrl+Shift+Enter 全部）、**执行计划**（EXPLAIN QUERY PLAN） |
| 结果集 | 游标分页 + 虚拟滚动；点列头排序（重新查询）；列宽拖拽/双击自适应；**排序与列宽持久化**（按表记忆） |
| **多结果标签页** | 每标签独立网格（各自游标/排序/列宽/脏数据），关闭即释放游标 |
| 数据编辑 | UPDATE / INSERT / DELETE（参数化、按主键定位、显式事务、删除二次确认） |
| 数据查看 | 复制单元格/整行；截断值查看全文；统计行数 |
| **数据筛选** | 列名+操作符+值，拼 WHERE 重新查询（不在页缓存上过滤） |
| **导出** | CSV / JSON / INSERT 语句 / Markdown（导出已加载行，明确标注范围）+ 导出全部（带进度与 5 万行上限） |
| **DDL** | 建表（列编辑器/类型白名单/主键/自增/默认值）、删表、建视图、删视图、重命名表 |
| **ER 图** | SVG 手绘，30 张表上限，**明确标注不含外键关系**（元数据契约暂无外键字段） |
| **查询取消** | PostgreSQL 真取消（`pg_cancel_backend`，实测 516ms 中断 10 秒慢查询）；**SQLite 如实不支持**（同步 API 无法中断） |
| **SSL/TLS** | PostgreSQL 六种 libpq 语义的 sslmode（disable/allow/prefer/require/verify-ca/verify-full）+ CA 证书校验；**语义差异已实测核对**（见下方说明） |
| **SSH 隧道** | PostgreSQL 经跳板机连接：私钥/口令认证、SHA256 主机指纹确认（不做 TOFU）、目标地址覆盖；SSL 回退与取消查询复用隧道连接 |

### 还没做（与 DBeaver 的差距）

| 缺口 | 影响 |
|---|---|
| 只有 2 个方言 | DBeaver 支持 100+；但**加驱动零架构改动**（PG 验证过，只加一个目录） |
| 无传输/导入导出向导 | DBeaver 的 data transfer 是独立子系统，支持跨库搬数据 |
| 无数据库比较/同步 | 表结构与数据的 diff |
| 无执行历史持久化 | 查过的 SQL 关掉就没了 |
| ER 图无外键关系线 | 元数据契约缺外键字段，需先扩展 `TableDescription` |
| SQLite 查询不可取消 | 同步 API 的硬限制 |

---

## 新增一个方言

1. 在 `src/drivers/<name>/` 实现 `DriverAdapter` 与 `SqlDialect`
2. 导出 `create<Name>Adapter: DriverFactory` 与 `<NAME>_INFO: DialectInfo`
3. 在 `src/drivers/index.ts` 里 `registry.register(...)` 一行

注册完，UI 的方言下拉框、宿主进程的加载、测试的遍历用例**自动全部生效**——
这是「驱动清单只有一个出口」这条规则带来的直接好处。

`DialectInfo` 里必须带 `quoting`（引号规则），因为主进程要用它拼
`SELECT * FROM <quoted table>`。这条规则是**纯数据**，主进程不需要认识任何具体驱动——
否则每加一个方言就要在主进程里加一条 import，进程隔离就开始漏。

---
