/**
 * 连接活动守卫：导入任务与外部写操作之间的互斥。
 *
 * ===== 它解决的两个竞态 =====
 *
 * 1. **任务级守卫**（`assertNoActiveImport`）：导入期间，任何可能写库的外部入口
 *    （executeStatement / insertRow / applyEdits / deleteRows / DDL / commit /
 *    rollback）都必须拒绝。驱动侧对「已在事务中就复用」的处理意味着这些写入
 *    会悄悄加入导入事务，被 ImportManager 一起提交或回滚，破坏导入的原子性。
 *
 * 2. **在途写计数**（`beginWrite` / `endWrite` / `pendingWriteCount`）：
 *    任务级守卫与导入前的 transactionState 预检都只在**各自被调到的那一刻**
 *    检查状态，它们挡不住这个交错：
 *
 *      1. 用户先发起一个写请求。它通过了守卫，但写库的 RPC 还在途，
 *         用户事务尚未建立；
 *      2. 此时 startImport 被调用。任务级守卫看到「没有导入」放行；
 *         ImportManager 的预检又在用户事务建立**之前**跑完，看到「无事务」也放行；
 *      3. 之后用户写建立事务，导入第一批 importBatch 撞上用户事务被驱动拒绝；
 *      4. ImportManager 按「写过就回滚」无条件 rollback，于是把**用户事务**回滚了。
 *
 *    单靠扩大守卫或预检都无法关闭第 1 步与第 2 步之间的窗口，因为窗口跨越了
 *    写请求的 await。这里用一个连接级计数把「写请求在途」同步地暴露出来：
 *    每个外部写入口在**首个 await 之前**登记、在 finally 释放；startImport 在
 *    同一同步段内检查计数，>0 就同步拒绝。因为 JS 单线程，登记与检查之间没有
 *    让出点，所以二者要么写先登记（导入被拒），要么导入先建任务（写被任务守卫拒），
 *    不可能同时通过。
 *
 * ===== 边界 =====
 *
 * 本模块**不** import `ConnectionManager` / `ImportManager`。它只认识一个注入的
 * `activeTaskByConnection` 回调——「这个连接上有没有活动导入任务」是外部知识，
 * 守卫自身只负责计数与判定。
 *
 * 导入自身的内部 commit / rollback 走 ImportManager 的回调，**不经过**本守卫，
 * 因此既不会被任务级守卫拒绝，也不会进入在途写计数。这一点必须保持不变，
 * 否则 ImportManager 无法提交或回滚自己的事务。
 *
 * 所有方法都是同步的。调用方必须遵守两个时序约束：
 *   - `assertNoActiveImport` + `beginWrite` 必须在方法**首个 await 之前**完成；
 *   - `endWrite` 必须放在 `finally`，与 `beginWrite` 成对。
 */

/** 活动任务查询：返回该连接上正在执行的导入 taskId，没有则 undefined。 */
export interface ConnectionActivityContext {
  readonly activeTaskByConnection: (connectionId: string) => string | undefined
}

export class ConnectionActivityGuard {
  readonly #ctx: ConnectionActivityContext

  /** 连接 id → 已登记、尚未完成的写操作数量。 */
  readonly #pendingWrites = new Map<string, number>()

  constructor(context: ConnectionActivityContext) {
    this.#ctx = context
  }

  /**
   * 拒绝在导入期间执行可能写库的外部操作。
   *
   * 主进程无法在不重复方言解析的前提下判定 `executeStatement` 是否会写库，
   * 所以对写入口一律保守拒绝；只读查询仍走 runQuery / previewTable，不受影响。
   *
   * `operation` 是用户可读的动作名（「应用行编辑」「删表」…），拼进错误文案。
   */
  assertNoActiveImport(connectionId: string, operation: string): void {
    const taskId = this.#ctx.activeTaskByConnection(connectionId)
    if (taskId === undefined) return
    throw new Error(
      `连接 ${connectionId} 正在执行导入任务 ${taskId}，已拒绝${operation}，` +
        '以免无关写入混入导入事务。导入事务只能由 ImportManager 提交或回滚；' +
        '请等待导入结束或先取消导入。'
    )
  }

  /**
   * 登记一次外部写操作的在途租约。**必须在方法的首个 await 之前调用**，
   * 这样 startImport 在同一同步段内的计数检查与本次登记之间没有让出点，
   * 二者的先后顺序才能确定（见文件头「在途写计数」）。
   */
  beginWrite(connectionId: string): void {
    this.#pendingWrites.set(
      connectionId,
      (this.#pendingWrites.get(connectionId) ?? 0) + 1
    )
  }

  /** 释放一次在途写租约。**必须放在 finally**，且与 `beginWrite` 成对调用。 */
  endWrite(connectionId: string): void {
    const current = this.#pendingWrites.get(connectionId)
    if (current === undefined) return
    if (current <= 1) this.#pendingWrites.delete(connectionId)
    else this.#pendingWrites.set(connectionId, current - 1)
  }

  /** 当前在途写操作数量。startImport 在同一同步段内用它做最终放行判断。 */
  pendingWriteCount(connectionId: string): number {
    return this.#pendingWrites.get(connectionId) ?? 0
  }
}
