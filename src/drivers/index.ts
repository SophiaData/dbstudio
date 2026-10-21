/**
 * 内置驱动注册入口。
 *
 * ===== 为什么这个小文件必须是「单写者」的契约 =====
 *
 * 驱动宿主进程、Electron 主进程、以及自动化测试**三方都要拿到同一份驱动清单**。
 * 如果各自 import 各自的 adapter，就会出现「测试里能连、应用里连不上」这类
 * 最难查的不一致。所以清单只有这一个出口。
 *
 * 新增一个方言的完整步骤（第 3 步是重点）：
 *   1. 在 `src/drivers/<name>/` 下实现 `DriverAdapter` 与 `SqlDialect`
 *   2. 导出 `create<Name>Adapter: DriverFactory` 与 `<NAME>_INFO: DialectInfo`
 *   3. **在这里注册** —— 注册完，UI 的下拉框、宿主进程的加载、测试的用例自动全部生效
 */

import type { DriverRegistry } from '../core/registry'
import { createPostgresAdapter, POSTGRESQL_INFO } from './postgresql'
import { createSqliteAdapter, SQLITE_INFO } from './sqlite'

/** 把本仓库自带的所有驱动注册进注册表。 */
export function registerBuiltinDrivers(registry: DriverRegistry): void {
  registry.register(createSqliteAdapter, SQLITE_INFO)
  // 第二个方言：PostgreSQL。注册即全链路生效（UI 下拉框 / 宿主加载 / 测试遍历）。
  registry.register(createPostgresAdapter, POSTGRESQL_INFO)
}

/** 内置驱动的方言 id 清单，测试用它遍历所有方言做冒烟。 */
export const BUILTIN_DIALECT_IDS = ['sqlite', 'postgresql'] as const
