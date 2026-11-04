/**
 * 查询用例服务：结果集、语句执行、执行计划、游标分页与取消。
 *
 * ===== 为什么从 ConnectionManager 里抽出来 =====
 *
 * 这一组方法的共同点是：它们都只做一件事——**把入参解析成活动会话，
 * 再把请求转发给该会话的宿主进程**，最后把带连接作用域的游标 id 交回 UI。
 * 它们不碰持久化配置、不碰会话生命周期、不碰导入/导出任务编排。
 *
 * 把这组逻辑单独放进来，ConnectionManager 就只剩「兼容 facade」的转发职责，
 * 而查询路径可以被独立阅读、独立测试，也不会再因为别的职责改动而被牵连。
 *
 * ===== 边界 =====
 *
 * 本模块**不** import `ConnectionManager`、electron、`src/drivers` 或任何具体
 * adapter。它只认识：
 *
 *   - `ConnectionResolver`：节点/游标 id → 活动会话；
 *   - `CursorRegistry`：游标作用域封装与生存账本；
 *   - `ConnectionActivityGuard`：导入互斥与在途写租约；
 *   - `getSession`：会话身份校验（await 之后确认还是同一个会话）。
 *
 * `LiveConnection.host` 只以类型出现（`import type`），因此本模块没有任何
 * 运行时依赖会顺着宿主句柄进入主进程 bundle 之外的地方。
 *
 * ===== 不是纯转发：三处必须保留的时序 =====
 *
 * 1. **会话身份校验**：`runQuery` / `executeStatement` / `explain` 在 await
 *    之后必须重新取一次当前会话并与手里的 `conn` 比较。await 期间用户可能
 *    断连并重连，旧宿主上的结果不能当成新会话的结果交回 UI。
 * 2. **写租约**：`executeStatement` 必须在**首个 await 之前**完成
 *    `assertNoActiveImport` 与 `beginWrite`，并在 `finally` 里 `endWrite`。
 *    这是关闭「用户写与导入交叉」竞态窗口的关键（见 connection-activity-guard）。
 * 3. **游标还原与销账**：`fetchResultPage` / `closeCursor` 必须经
 *    `resolveCursor` 把 scoped id 还原成原生 id；`closeCursor` 即使在宿主侧
 *    关闭失败时也要在 `finally` 销账，且重复关闭不报错。
 */

import type {
  CellValue,
  ExplainResult,
  QueryOptions,
  QueryResult,
  ResultPage,
  StatementResult
} from '../../core/resultset'
import type { ConnectionActivityGuard } from './connection-activity-guard'
import type { ConnectionResolver } from './connection-resolver'
import type { CursorRegistry } from './cursor-registry'
import type { LiveConnection } from './types'

/**
 * 查询用例服务的外部依赖。
 *
 * 全部是最小能力注入，而不是让服务反向持有 ConnectionManager：
 *   - `resolver` / `cursors` / `activity` 是已经抽出的无状态或弱状态协作者；
 *   - `getSession` 只用于「await 之后还是不是同一个会话」的身份校验，
 *     比直接注入整个会话服务更不容易被误用。
 */
export interface QueryApplicationContext {
  readonly resolver: ConnectionResolver
  readonly cursors: CursorRegistry
  readonly activity: ConnectionActivityGuard
  /** 读取当前活动会话；没有（未连接 / 已断开 / 已替换）返回 undefined。 */
  readonly getSession: (connectionId: string) => LiveConnection | undefined
}

export class QueryApplicationService {
  readonly #ctx: QueryApplicationContext

  constructor(context: QueryApplicationContext) {
    this.#ctx = context
  }

  /**
   * 执行 SQL，返回第一页。
   *
   * `nodeId` 复用树节点的编码来指明「在哪个连接上执行」。
   * 这里允许 connector 根节点（`connection:c1`，adapterId === null）——
   * 用户在连接上右键「执行 SQL」时没有具体表，仍应能跑任意语句。
   *
   * 游标处理：把 adapter 的原生游标 id 包上连接归属后再交给 UI（规则见
   * cursor-registry），同时登记进账本，让「这个连接还有游标没关」在主进程侧可见。
   */
  async runQuery(
    nodeId: string,
    sql: string,
    options?: QueryOptions,
    signal?: AbortSignal
  ): Promise<QueryResult> {
    const { conn } = this.#ctx.resolver.resolveConnection(nodeId)
    const result = await conn.host.query(sql, options, signal)
    this.#assertSameSession(conn, `查询所属的会话已断开: ${conn.id}`)
    return this.#scopeCursor(conn, result)
  }

  /**
   * 执行一条 SQL 语句（查询、DML 或 DDL）。
   * 若结果包含游标，同样进行连接归属作用域包装与账本登记。
   *
   * `assertNoActiveImport` + `beginWrite` 必须在首个 await 之前完成：
   * 该入口可能执行 DML/DDL 并复用导入事务，导入期间一律拒绝（只读查询走 runQuery）。
   */
  async executeStatement(nodeId: string, sql: string, options?: QueryOptions): Promise<StatementResult> {
    const { conn } = this.#ctx.resolver.resolveConnection(nodeId)
    this.#ctx.activity.assertNoActiveImport(conn.id, '执行 SQL 语句')
    this.#ctx.activity.beginWrite(conn.id)
    try {
      const result = await conn.host.executeStatement(sql, options)
      this.#assertSameSession(conn, `语句执行所属的会话已断开: ${conn.id}`)

      if (result.kind === 'rows') {
        const qResult = result.result
        if (qResult.cursorId !== null && qResult.cursorId !== undefined) {
          const scoped = this.#ctx.cursors.scope(conn.id, qResult.cursorId)
          this.#ctx.cursors.track(conn.id, qResult.cursorId)
          return {
            ...result,
            result: { ...qResult, cursorId: scoped }
          }
        }
      }
      return result
    } finally {
      this.#ctx.activity.endWrite(conn.id)
    }
  }

  /** 按连接所属驱动生成执行计划，不在主进程拼接方言关键字。 */
  async explain(nodeId: string, sql: string): Promise<ExplainResult> {
    const { conn } = this.#ctx.resolver.resolveConnection(nodeId)
    const result = await conn.host.explain(sql)
    this.#assertSameSession(conn, `执行计划所属的会话已断开: ${conn.id}`)
    return result
  }

  /** 从游标按偏移量取一页。入参若是坏 id 会立刻报错，不会挂死。 */
  async fetchResultPage(cursorId: string, offset: number, limit: number): Promise<ResultPage> {
    const { conn, rawCursorId } = this.#ctx.resolver.resolveCursor(cursorId)
    return conn.host.fetchResultPage(rawCursorId, offset, limit)
  }

  /**
   * 释放游标。
   *
   * 幂等：重复关闭、关闭一个不存在的游标都不报错。
   * 这与宿主侧 `closeCursor` 不做 requireConnected 的决定是配套的——
   * 网格关闭时会无条件调用它，这条路径上任何噪音错误都会变成用户可见的弹窗。
   */
  async closeCursor(cursorId: string): Promise<void> {
    const { conn, rawCursorId } = this.#ctx.resolver.resolveCursor(cursorId)
    try {
      await conn.host.closeCursor(rawCursorId)
    } finally {
      // 即使宿主侧关闭失败也要销账：那条游标要么已经没了，
      // 要么随着宿主退出而消失，留着账本条目只会被误判成泄漏。
      this.#ctx.cursors.forget(conn.id, rawCursorId)
    }
  }

  /**
   * 取单格完整值。
   *
   * `cursorId` 是 runQuery 返回的**带连接作用域**的 id，故先经 `resolveCursor`
   * 还原成「连接 + 原生游标 id」再转发——与 fetchResultPage 同一套规则。
   * 长文本 / 二进制列在首页只带预览，网格需要完整值时走这里。
   */
  async fetchCellValue(
    cursorId: string,
    rowIndex: number,
    columnIndex: number
  ): Promise<CellValue> {
    const { conn, rawCursorId } = this.#ctx.resolver.resolveCursor(cursorId)
    return conn.host.fetchCellValue(rawCursorId, rowIndex, columnIndex)
  }

  /**
   * 按对象 id 生成「读取该表/视图」的 SELECT。表名限定与引号由驱动决定，主进程不猜。
   */
  async tableSelectSql(nodeId: string): Promise<string> {
    const { conn, adapterId } = this.#ctx.resolver.resolveConnection(nodeId)
    if (adapterId === null) throw new Error('连接节点不能生成表查询，请选择具体的表或视图')
    return conn.host.tableSelectSql(adapterId)
  }

  /**
   * 便捷方法：预览一张表 / 视图。
   *
   * 表名限定（schema/database 前缀）与引号由**驱动**生成：主进程不认识 id 编码，
   * 曾用 quoteIdentifier(payload) 把整个 `table:<schema>.<name>` 当单标识符，
   * 多库/多 schema 下会拼出 `"public.users"` 这种错误表名、静默读错库。
   * 行数限制仍通过 QueryOptions.limit 交给 adapter（分页语法是方言知识）。
   */
  async previewTable(nodeId: string, limit = 200): Promise<QueryResult> {
    const { conn, adapterId } = this.#ctx.resolver.resolveConnection(nodeId)
    if (adapterId === null) {
      throw new Error('连接节点不能预览，请选择具体的表或视图')
    }

    // 只切第一个冒号：与 ids.ts 的 `table:<name>` 编码规则一致，
    // 所以名字里含冒号也能正确还原（`table:a:b` → `a:b`）。
    const sep = adapterId.indexOf(':')
    if (sep <= 0) throw new Error(`无法识别的对象 id: ${adapterId}`)
    const kind = adapterId.slice(0, sep)
    const name = adapterId.slice(sep + 1)

    if (kind !== 'table' && kind !== 'view') {
      throw new Error(`只能预览表或视图，收到: ${kind}`)
    }
    if (name === '') throw new Error(`对象名为空，无法预览: ${adapterId}`)

    const sql = await conn.host.tableSelectSql(adapterId)
    const result = await this.runQuery(nodeId, sql, { limit })

    // ===== 兜底校验：确认 adapter 真的落实了 limit =====
    //
    // 设计把「怎么限行」完全交给了 adapter，这是对的（方言知识不该复制到 main）。
    // 但它有一个失败模式：某个 adapter 忽略了 `options.limit`，
    // 于是 previewTable 悄悄退化成「拉全量」——而这正是剖析报告「陷阱 5」里
    // 要防的事（跨进程一次性搬运百万行会把内存打爆）。
    //
    // 主进程在这里不可能纠正它（不重查、不猜方言），但**必须让它可见**：
    // 一旦返回行数超出请求上限，说明契约被违反了。宁可抛错让人发现，
    // 也不要静默返回一个已经吞掉内存的结果。
    const effectiveLimit = Math.max(1, Math.floor(limit))
    if (result.returned > effectiveLimit) {
      throw new Error(
        `方言 "${conn.info.id}" 的 adapter 违反了 limit 契约：请求 ${effectiveLimit} 行，` +
          `实际返回 ${result.returned} 行。预览功能会因此退化为全量拉取，已中止。` +
          `这属于 adapter 实现缺陷，不是 UI 问题。`
      )
    }
    return result
  }

  /**
   * 取消某个节点所属连接上正在执行的查询。
   *
   * 为什么按 nodeId 而不是 connectionId：UI 手上只有当前格子/标签对应的节点，
   * 让 UI 自己去反查连接会多一层容易出错的状态。这里复用 resolver.resolveConnection。
   *
   * resolveConnection 对「连接节点本身」返回 adapterId=null —— 那种情况下
   * 取消的是该连接上的查询，直接用 conn.host 即可（不需要 adapterId）。
   */
  async cancelQuery(nodeId: string, signalId?: string): Promise<boolean> {
    const { conn } = this.#ctx.resolver.resolveConnection(nodeId)
    return conn.host.cancelQuery(signalId)
  }

  /**
   * await 之后确认会话没有被替换。
   *
   * 用户可能在查询执行期间断开并重新连接；旧宿主上的结果不能冒充新会话的结果。
   * 文案由调用方传入，保持与拆分前逐字一致。
   */
  #assertSameSession(conn: LiveConnection, message: string): void {
    if (this.#ctx.getSession(conn.id) !== conn) {
      throw new Error(message)
    }
  }

  /** 把 adapter 的原生游标 id 包上连接归属，并登记进生存账本。 */
  #scopeCursor(conn: LiveConnection, result: QueryResult): QueryResult {
    if (result.cursorId !== null && result.cursorId !== undefined) {
      const scoped = this.#ctx.cursors.scope(conn.id, result.cursorId)
      this.#ctx.cursors.track(conn.id, result.cursorId)
      return { ...result, cursorId: scoped }
    }
    return result
  }
}
