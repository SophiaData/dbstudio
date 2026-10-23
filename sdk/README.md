# @sophiadata/dbstudio-sdk

数据库驱动层 SDK：**进程隔离的驱动宿主 + 方言抽象 + 游标分页**。
零 Electron 依赖；驱动宿主运行时依赖 `pg` 和 `ssh2`，可在任何满足 Node 版本要求的项目里复用。

> 这是 [dbstudio](https://github.com/SophiaData/dbstudio) 的驱动层。
> 桌面应用用它，但你不必用桌面应用才能用它。

## 它解决什么问题

任何 Node 项目想连多种数据库，迟早撞上：**两个驱动依赖同一个库的不同版本，
在同一个进程里必然打架**。Java 靠 ClassLoader 隔离，Node 没有——
`require` 缓存是全局的，同名模块不同版本无法共存。

本 SDK 的答案：**一个连接一个子进程**。驱动在独立进程里跑，
版本冲突天然消失，驱动崩溃也拖不垮你的主进程。

## 安装

```bash
npm install @sophiadata/dbstudio-sdk
```

**要求 Node ≥ 22.5**（依赖内置的 `node:sqlite`，无需 flag）。较老运行时如果不支持按列
返回，重复列名查询会明确报错，避免静默丢列。

安装包会带上 SQLite、PostgreSQL 和 SSH 隧道所需的宿主依赖。包外交付验证会把
tarball 安装到独立目录，再用包名导入、启动宿主和编译 TypeScript 声明。

## 快速开始

```js
import { DriverHost } from '@sophiadata/dbstudio-sdk'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// 宿主脚本的绝对路径：必须显式解析（包不在你的 node_modules 根下也能work）
const hostScript = require.resolve('@sophiadata/dbstudio-sdk/driver-host/index.js')

const host = new DriverHost({ dialectId: 'sqlite', hostScript })

// 1. 连接
await host.connect({
  dialectId: 'sqlite',
  name: 'my-db',
  options: { file: '/absolute/path/to/db.sqlite' }
})

// 2. 浏览元数据（懒加载：只取直接子节点）
const folders = await host.listChildren(null)          // [{ tables, views }]
const tables = await host.listChildren('folder:tables') // [{ name: 'users', ... }]

// 3. 读表结构（含「能否编辑」判定）
const desc = await host.describeTable('table:users')
console.log(desc.hasUniqueKey)   // false 时不该让用户编辑

// 4. 查询 + 游标分页
const page1 = await host.query('SELECT * FROM users ORDER BY id')  // 第一页
const page3 = await host.fetchResultPage(page1.cursorId, 200, 100) // 按偏移取任意页
await host.closeCursor(page1.cursorId)

// 5. 参数化编辑 + 显式事务
await host.applyEdits('table:users', [{
  keyValues: { id: { kind: 'number', value: 42 } },   // WHERE 用主键值，不是行号
  changes: { email: { kind: 'text', text: 'new@x.com' } }  // SET
}])
await host.commitTransaction()   // 或 rollbackTransaction()

await host.close()
```

不想手动管生命周期？用 `withDriverHost`，它保证回收：

```js
import { withDriverHost } from '@sophiadata/dbstudio-sdk'

const count = await withDriverHost(
  { dialectId: 'sqlite', hostScript },
  async (host) => {
    await host.connect(config)
    const r = await host.query('SELECT COUNT(*) AS c FROM users')
    return r.rows[0].cells[0].value
  }
)
```

## 关键设计

### 为什么一个连接一个进程

Node 没有 ClassLoader。多个驱动版本共存唯一可靠的办法是进程隔离。
代价是多一层 RPC；收益是**驱动崩溃不拖垮调用方**，且版本冲突不可能发生。

### 为什么不查 `COUNT(*)`

`hasMore` 是「本页拉满即认为可能还有」的**推断**，不是精确总数。
大表上 `COUNT(*)` 是全表扫描，代价不可接受。真需要总数请显式执行。

### 为什么编辑用主键值而不是行号

`keyValues` 必须是**主键列的值**。用行号（结果集下标）是错的：
下标拼不出 `WHERE`，而且用户重排序/并发插入后下标会漂移，**会静默改错行**。
无唯一键的表会被直接拒绝——这和 DBeaver 的 `No unique key defined` 语义一致。

### 大值会被截断

单元格文本超过 1000 字符、BLOB 超过 256 字节时只传预览并标记 `truncated: true`。
**被截断的值不能回写**（会破坏原数据），SDK 会拒绝而不是静默写坏。

## API 概览

| 方法 | 说明 |
|---|---|
| `connect(config, secret?)` | 建连，返回能力声明 |
| `testConnection(config, secret?)` | 只测连，不保留 |
| `listChildren(parentId)` | 列直接子节点（懒加载） |
| `describeTable(id)` | 列 + 主键 → 判断能否编辑 |
| `query(sql, options?)` | 执行，返回第一页 + cursorId |
| `fetchResultPage(cursorId, offset, limit)` | 随机取页（支持往回翻） |
| `closeCursor(cursorId)` | 释放游标 |
| `applyEdits(tableId, updates)` | 参数化 UPDATE，不自动提交 |
| `commitTransaction()` / `rollbackTransaction()` | 显式事务控制 |
| `transactionState()` | 当前事务状态 |
| `close()` / `kill()` | 优雅关闭 / 强制回收 |

工具：`Quote.identifier()`、`Quote.placeholders()`、`cellValueToSqlParam()`。

## 局限（如实说明）

- 当前宿主注册 SQLite 与 PostgreSQL 两种驱动
- **公开 API 只覆盖 UPDATE**（`applyEdits`）。桌面端的 INSERT / DELETE / DDL
  （`insertRow` / `deleteRows` / `createTable` 等）走的是另一条 IPC 链路，
  **没有**暴露在这个包里——别把桌面端的功能清单当成 SDK 的能力清单
- 只读性靠关键词扫描护栏，**不是安全边界**——生产环境请用只读连接或数据库权限
- 大字段（截断的 TEXT / BLOB）不在编辑支持范围
- SSH 隧道需要本机 sshd 可用；SSL 语义按 libpq 的 `sslmode` 对齐

## 三层能力的区别

这个仓库里同时存在三层东西，别混用：

| 层 | 位置 | 面向谁 | 稳定性 |
|---|---|---|---|
| **桌面应用** | `src/` | 最终用户 | 功能以 README「功能清单」为准 |
| **公开 SDK** | `sdk/`（本包） | 你的 Node 项目 | 只暴露上面「API 概览」表里的方法 |
| **内部协议** | NDJSON over stdio | 桌面应用 ↔ 驱动宿主 | **不是公开契约**，会随版本变化 |

本包只承诺第二层。第一层会继续加功能；第三层随时可能改，
请不要绕过 `DriverHost` 直接和宿主进程说话。

## 已验收范围

- **SQLite**：元数据浏览、查询与分页、参数化 UPDATE、显式事务与回滚。
  包外交付已验证（`npm pack` → 空目录安装 → 按包名导入 → 起宿主 → 查询）。
- **PostgreSQL**：驱动与隧道链路在 CI 中用真实 PG 17 与真实 sshd 验证；
  但本机若未配置 `DBSTUDIO_PG_URL` 等环境变量，相关测试会**跳过**而不是假装通过。

换句话说：**本地全绿不等于 PostgreSQL 被验证过**——它需要真实服务端。

## Node 版本

要求 Node ≥ 22.5（依赖内置 `node:sqlite`，无需 flag）。较老运行时如果不支持
按列返回，重复列名查询会**明确报错**，而不是静默丢列。

## License

MIT
