/**
 * 主进程层探针的入口（**仅测试用**）。
 *
 * ===== 为什么需要这个文件，而不是直接打包 ConnectionManager.ts =====
 *
 * Phase 2 要验证的是「主进程这一层」是否自洽，其中最关键的集成点是：
 * `DriverRegistry.list()` 产出的 `DialectInfo` 是否真的满足 `ConnectionManager`
 * 的需要。这一点单测 `ConnectionManager` 是验不出来的——如果测试自己手写一个
 * `DialectInfo` 字面量，就等于**替注册表把答案写好了**，注册表真漏字段时测试照样绿。
 *
 * 这个教训是实际的：早先探针手写的 DialectInfo 没有 `quoting`，
 * 于是 `previewTable` 在生产路径上会崩，但探针在别处掩盖了它。
 *
 * 所以这里把「真实注册表」和 `ConnectionManager` 装在同一个产物里，
 * 由注册表自己产出方言清单，再交给 ConnectionManager——测试只负责调用，
 * 不负责提供任何契约形状。
 *
 * 注意：这不是生产代码。它只在 `tests/e2e-resultset.mjs` 里被 vite 打包进
 * `out/.resultset-probe/`，Electron 主进程**不会**加载它。
 * 因此它 import `src/drivers` 是安全的——它运行在测试进程里，
 * 与「主进程不得 import 驱动目录」这条架构约束不冲突（那条约束针对 `src/main/**`）。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DriverRegistry } from '../src/core/registry'
import { registerBuiltinDrivers } from '../src/drivers'
import { ConnectionManager } from '../src/main/ConnectionManager'
import { ConnectionStore, SecretStorageUnavailableError } from '../src/main/ConnectionStore'

export { ConnectionManager }
export { ConnectionStore }
// 重新导出错误类型：测试要断言"cipher 不可用时抛的是这个特定错误"，
// 换打包入口后若漏了它，#31 就会因 undefined 失败（正是这次踩到的）。
export { SecretStorageUnavailableError }

/**
 * 导出宿主句柄类，供测试对它的原型打桩。
 *
 * 为什么必须导出：`remove()` 的「先回滚再关」要验的是**调用顺序**，
 * 而最终结果（数据没被提交）在两种顺序下都一样——宿主进程被关掉时，
 * 数据库连接断开本身也会回滚未提交事务。
 * 也就是说只看结果无法区分「显式回滚」与「靠进程退出兜底」，
 * 必须能观察到 rollback RPC 是否真的在 close 之前发出。
 */
export { DriverHostHandle } from '../src/main/DriverHostHandle'

/**
 * 用**真实的**内置驱动注册表构造一个 ConnectionManager。
 * 测试拿到的方言清单与生产环境 `main/index.ts` 里 `registry.list()` 的结果完全一致。
 *
 * ===== 为什么这里必须造一个 store，而不是沿用旧的两参构造 =====
 *
 * 第四阶段给 ConnectionManager 加了"必须注入 store"的构造参数（持久化）。
 * 已有的 resultset / edit 探针只关心查询与事务，但**不能因此传 undefined**——
 * 那会在 `#loadPersisted` 里立刻崩，而崩点离"我只是想测查询"很远，排查成本高。
 *
 * 所以给一个落在系统临时目录、用可逆假 cipher 的 store。
 * 探针不调 `add()`，因此它不会落任何配置；这个 store 只为满足构造契约而存在。
 * 这也顺带说明：持久化改造对**不持久化的调用方**是零负担的（只要给个 store）。
 */
export function createManagerWithBuiltinDialects(): ConnectionManager {
  const registry = new DriverRegistry()
  registerBuiltinDrivers(registry)
  const baseDir = mkdtempSync(join(tmpdir(), 'dbstudio-probe-store-'))
  const store = new ConnectionStore({
    baseDir,
    // 探针不落密码，用一个恒等 cipher 就够（不是安全实现，仅占位）。
    cipher: {
      encrypt: (plain: string) => Buffer.from(plain, 'utf8'),
      decrypt: (payload: Buffer) => payload.toString('utf8')
    }
  })
  return new ConnectionManager(registry.list(), store)
}

/** 供测试断言：注册表实际产出的方言清单（含 quoting），用于验证契约完整性。 */
export function listBuiltinDialects() {
  const registry = new DriverRegistry()
  registerBuiltinDrivers(registry)
  return registry.list()
}

/**
 * 用**任意注入的方言清单 + store** 构造 ConnectionManager（专供 secretStored 三态测试）。
 *
 * ===== 为什么需要它 =====
 *
 * `secretStored` 的取值取决于「该方言有没有 password 字段」（见
 * ConnectionManager.#secretStoredFor）。而真实的 SQLite 方言**没有** password 字段，
 * 所以用真实注册表只能测出 `null` 这一种取值。
 * 要覆盖 `true`/`false`，必须有一个**带 password 字段的假方言**。
 *
 * 这里把方言清单和 store 都让测试注入：
 *   - 方言清单：测试自己造一个含 `kind:'password'` 字段的 info
 *   - store：测试控制 cipher 可用/不可用，从而制造 true / false
 *
 * 注意这**不是**在生产里给假方言开口子——它只是把 ConnectionManager 本来就
 * 依赖的两个构造参数暴露给测试，生产仍只从真实注册表取值。
 */
export function createManagerWithInjected(
  dialects: readonly import('../src/core/driver').DialectInfo[],
  store: ConnectionStore
): ConnectionManager {
  return new ConnectionManager(dialects, store)
}
