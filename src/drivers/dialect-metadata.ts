/**
 * 方言**元数据**清单（纯数据，不含任何驱动实现）。
 *
 * ===== 这个文件为什么必须与 `./index` 分开 =====
 *
 * 项目最核心的承诺是「驱动跑在独立进程里」：驱动崩了不能拖垮主进程。
 * 但 Electron 主进程需要方言清单来：
 *   - 填「新建连接」的下拉框（id / name / fields）
 *   - 拼 `SELECT * FROM <quoted>` 时拿引号规则（quoting）
 *
 * 这些**全是纯数据**。如果主进程为了拿它们而 `import './index'`，
 * 就会顺着 `registerBuiltinDrivers → createSqliteAdapter → adapter.ts → node:sqlite`
 * 把整个 SQLite 实现打进主进程 bundle——架构隔离当场失效。
 *
 * 这不是理论风险：实测过 `out/main/index.js` 里出现了 `DatabaseSync`
 * 与 9 处 `PRAGMA`，产物 102KB（其中一半是根本用不到的数据库代码）。
 *
 * 所以拆成两条通道：
 *   - 本文件 `dialect-metadata.ts` → **纯数据**，主进程/渲染进程/测试都可以安全 import
 *   - `./index.ts`                  → **带实现**，只给驱动宿主进程与适配器测试用
 *
 * 新增方言时两处都要加一行。看起来有点重复，但这正是隔离的代价——
 * 一旦合并，隔离就悄悄没了。
 */

import type { DialectInfo } from '../core/driver'
import { POSTGRESQL_INFO } from './postgresql/info'
import { SQLITE_INFO } from './sqlite/info'

/**
 * 全部内置方言的元数据。
 *
 * ⚠️ 这里只能 import 各驱动的 `info.ts`（纯数据文件），
 * **绝不能** import `adapter.ts` 或驱动包的入口——那会连带拉进实现。
 * 新增方言时请遵守这条，否则隔离会以很隐蔽的方式失效。
 */
export const BUILTIN_DIALECT_METADATA: readonly DialectInfo[] = [SQLITE_INFO, POSTGRESQL_INFO]

/** 内置方言 id 清单，供需要遍历的调用方使用。 */
export const BUILTIN_DIALECT_IDS = BUILTIN_DIALECT_METADATA.map((d) => d.id)
