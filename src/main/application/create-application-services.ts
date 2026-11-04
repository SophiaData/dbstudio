/**
 * 应用服务组合根：集中创建并连接所有主进程用例服务。
 *
 * ===== 为什么需要这个工厂 =====
 *
 * `ConnectionManager` 的职责只剩两件：对外暴露稳定契约、把请求转发给用例服务。
 * 但「按什么顺序 new、回调怎么注入、构造环（任务组 → 会话 → 解析器）怎么打断」
 * 仍然属于装配知识，不该留在兼容 facade 里。把这些细节集中到本模块后：
 *
 *   - `ConnectionManager` 只持有一个服务包引用，公开方法全部是纯转发；
 *   - 装配顺序只有一处，读代码的人不必在 facade 与各服务之间来回跳；
 *   - 测试可以直接调用工厂拿到服务包，而不必绕过 `ConnectionManager`。
 *
 * ===== 构造顺序（不能随意调整）=====
 *
 *   catalog → transfer / import managers → session → resolver → activity
 *          → query / mutation → connection → metadata → compare
 *
 * 其中存在两个**构造环**，用 getter / 回调打断：
 *
 *   1. 传输/导入服务在构造期需要 `getResolver`，而解析器晚于它们创建；
 *      会话服务又需要两个任务组的 `cancelByConnection` / `waitByConnection`。
 *   2. 导入服务在构造期需要 `isClosing`（会话服务）与 `getActivity`
 *      （活动守卫），二者都晚于它创建。
 *
 * 回调真正执行时相关实例已经就绪。JS 的闭包捕获的是绑定，不是快照，
 * 因此这里可以安全地「先引用、后声明」。
 *
 * ===== 边界 =====
 *
 * 本模块**不** import `ConnectionManager`、electron、`src/drivers` 或任何具体
 * adapter。它只依赖 `./` 下的用例服务与 `core` 的纯类型。
 *
 * `DriverHostHandle` 的运行时模块身份保持不变：本模块不直接 import 它，
 * 而是通过既有的会话服务/连接服务间接使用同一个模块实例，测试对
 * `DriverHostHandle.prototype` 的打桩继续生效。
 */

import type { DialectInfo } from '../../core/driver'
import type { RemoteOutboundPolicy } from '../../backend/contract/remote'
import { CompareApplicationService } from './compare-application-service'
import { ConnectionActivityGuard } from './connection-activity-guard'
import { ConnectionApplicationService } from './connection-application-service'
import { ConnectionCatalog, type ConnectionCatalogStore } from './connection-catalog'
import { ConnectionResolver } from './connection-resolver'
import { ConnectionSessionService } from './connection-session-service'
import { CursorRegistry } from './cursor-registry'
import { ImportApplicationService } from './import-application-service'
import { MetadataApplicationService } from './metadata-application-service'
import { MutationApplicationService } from './mutation-application-service'
import { QueryApplicationService } from './query-application-service'
import { TransferApplicationService } from './transfer-application-service'
import type { ConnectionLogger, DriverHostFactory } from './types'

/**
 * 组合根产出的服务包。
 *
 * `ConnectionManager` 只通过它转发；这里保留全部服务引用，既让依赖关系
 * 一目了然，也方便测试按需取用（例如直接观察 catalog / cursors）。
 * 包内字段都是**组合结果引用**，不复制任何服务内部状态。
 */
export interface ApplicationServices {
  readonly catalog: ConnectionCatalog
  readonly cursors: CursorRegistry
  readonly transfers: TransferApplicationService
  readonly imports: ImportApplicationService
  readonly sessions: ConnectionSessionService
  readonly resolver: ConnectionResolver
  readonly activity: ConnectionActivityGuard
  readonly queries: QueryApplicationService
  readonly mutations: MutationApplicationService
  readonly connections: ConnectionApplicationService
  readonly metadata: MetadataApplicationService
  readonly compares: CompareApplicationService
}

/**
 * 统一的日志出口。
 *
 * 与拆分前 `ConnectionManager.#log` 逐字一致：`error` 走 `console.error`，
 * 其余（info/warn）走 `console.log`。所有用例服务共用同一个落点。
 */
export const consoleConnectionLogger: ConnectionLogger = (level, message) => {
  console[level === 'error' ? 'error' : 'log'](message)
}

/**
 * 按固定顺序创建所有用例服务并接线。
 *
 * @param dialects 方言清单（来自注册表，纯数据）
 * @param store    连接配置存储；构造期只要求 `listConnections()` 可用
 * @param onLog    日志出口；默认与拆分前完全一致
 */
export interface ApplicationServicesOptions {
  readonly onLog?: ConnectionLogger
  readonly createDriverHost?: DriverHostFactory
  /** 显式提供才启用远程连接配置与出站目标校验。 */
  readonly remoteOutboundPolicy?: RemoteOutboundPolicy
}

export function createApplicationServices(
  dialects: readonly DialectInfo[],
  store: ConnectionCatalogStore,
  onLogOrOptions: ConnectionLogger | ApplicationServicesOptions = consoleConnectionLogger,
  driverHostFactory?: DriverHostFactory
): ApplicationServices {
  const onLog =
    typeof onLogOrOptions === 'function'
      ? onLogOrOptions
      : onLogOrOptions.onLog ?? consoleConnectionLogger
  const createDriverHost =
    typeof onLogOrOptions === 'function'
      ? driverHostFactory
      : onLogOrOptions.createDriverHost
  const remoteOutboundPolicy =
    typeof onLogOrOptions === 'function' ? undefined : onLogOrOptions.remoteOutboundPolicy
  // 1) 目录：载入持久化配置，提供方言、id 序列与摘要投影。
  const catalog: ConnectionCatalog = new ConnectionCatalog(dialects, store, onLog)

  // 游标账本：无副作用，但在会话与查询服务中共享同一个实例。
  const cursors: CursorRegistry = new CursorRegistry()

  // 2) 任务组：导出 / 导入。二者都晚于解析器创建，用 getter 打断构造环。
  const transfers: TransferApplicationService = new TransferApplicationService({
    getResolver: () => resolver,
    // 目标路径保护要检查**所有**已保存连接，不只是当前连接。
    listSavedConnections: () => catalog.values(),
    onLog
  })
  const imports: ImportApplicationService = new ImportApplicationService({
    getResolver: () => resolver,
    isClosing: (connectionId) => sessions.isClosing(connectionId),
    getActivity: () => activity,
    onLog
  })

  // 3) 会话：需要目录的读取/投影能力，以及两个任务组的收尾能力。
  const sessions: ConnectionSessionService = new ConnectionSessionService({
    getSaved: (connectionId) => catalog.get(connectionId),
    getSecret: (connectionId) => catalog.getSecret(connectionId),
    summarize: (saved, live) => catalog.summarize(saved, live),
    cursors,
    transfers: transfers.manager,
    imports: imports.manager,
    onLog,
    createDriverHost
  })

  // 4) 解析器：会话 / 目录 / 游标账本之上的一层统一入口。
  const resolver: ConnectionResolver = new ConnectionResolver({
    getSession: (connectionId) => sessions.get(connectionId),
    getSaved: (connectionId) => catalog.get(connectionId),
    parseCursorOrThrow: (cursorId) => cursors.parseOrThrow(cursorId)
  })

  // 5) 活动守卫：导入与外部写操作的互斥。
  const activity: ConnectionActivityGuard = new ConnectionActivityGuard({
    activeTaskByConnection: (connectionId) =>
      imports.manager.activeTaskByConnection(connectionId)
  })

  // 6) 查询 / 变更用例：都依赖解析器与活动守卫。
  const queries: QueryApplicationService = new QueryApplicationService({
    resolver,
    cursors,
    activity,
    getSession: (connectionId) => sessions.get(connectionId)
  })
  const mutations: MutationApplicationService = new MutationApplicationService({
    resolver,
    activity,
    getActiveImport: (connectionId) =>
      imports.manager.activeTaskByConnection(connectionId)
  })

  // 7) 连接用例：协调目录、会话、游标与任务组的生命周期。
  const connections: ConnectionApplicationService = new ConnectionApplicationService({
    catalog,
    sessions,
    cursors,
    transfers,
    imports,
    resolver,
    onLog,
    createDriverHost,
    remoteOutboundPolicy
  })

  // 8) 元数据用例：根层来自目录的公开投影，其余走会话。
  const metadata: MetadataApplicationService = new MetadataApplicationService({
    resolver,
    getSession: (connectionId) => sessions.get(connectionId),
    listConnections: () => connections.list()
  })

  // 9) 数据比较：读结构 + 分页取数的组合用例。
  const compares: CompareApplicationService = new CompareApplicationService({
    resolver,
    metadata,
    queries
  })

  return {
    catalog,
    cursors,
    transfers,
    imports,
    sessions,
    resolver,
    activity,
    queries,
    mutations,
    connections,
    metadata,
    compares
  }
}
