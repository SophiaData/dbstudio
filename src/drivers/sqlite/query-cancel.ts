/**
 * SQLite 查询取消 —— **结论：做不到，这里如实说明为什么。**
 *
 * ===== 实测证据（Node v25.8.1 / 项目内 Electron 内置 Node 24 同源）=====
 *
 * `Object.keys(require('node:sqlite').DatabaseSync.prototype)` 的完整输出是：
 *
 *   aggregate, applyChangeset, close, createSession, createTagStore, enableDefensive,
 *   enableLoadExtension, exec, function, loadExtension, location, open, prepare, setAuthorizer
 *
 * 其中**没有 `interrupt`**，也没有任何等价能力。
 * 对比 sqlite3 C API：那里确实有 `sqlite3_interrupt()`，
 * 但 node:sqlite 没有把它暴露出来。`StatementSync` 也只有
 * all/get/iterate/run/columns 等，同样没有中断入口。
 *
 * ===== 就算将来暴露了，也无法从另一个调用里"打断" =====
 *
 * 更根本的问题在于 `DatabaseSync` 是**同步** API：
 * 一旦 `db.exec()` / `statement.all()` 开始执行，JS 线程就被占住，
 * 期间**事件循环完全停转**——任何定时器、任何 IPC 消息都排不上队。
 * 所以"定时器到点调用 interrupt"这条路在同步 API 上根本不成立：
 * 定时器回调要等到阻塞结束才会被调度，那时查询早就跑完了。
 * 真正可行的是**把查询放到 worker 线程里**，主线程再通过
 * `worker.terminate()` 干掉它——那是一套完全不同的执行模型
 * （需要跨线程传连接、重建 session 状态、处理事务跨线程语义），
 * 属于"换架构"而不是"加一个方法"，不在本阶段范围内。
 *
 * ===== 所以 SQLite 的答案是：不支持 =====
 *
 * - `supportsCancel` 保持 false
 * - `cancelQuery()` 返回 false
 *
 * **假装支持比不支持更糟**：如果这里返回 true，UI 会显示"已取消"
 * 而查询其实还在跑，用户会以为数据没被改、实际情况未知。
 * 给一个诚实的"不支持"，用户至少知道自己要等。
 *
 * ===== 那慢查询怎么办（真实的兜底办法）=====
 *
 * 1. 查询窗口对用户可以给出"请谨慎写全表扫描"的提示；
 * 2. 连接层可以设 `busy_timeout`（本 adapter 已设 5s）限制锁等待；
 * 3. 真正需要强制中断时，用户可以关掉这个连接——宿主进程被终止，
 *    SQLite 随之释放。这是粗暴但确实有效的兜底。
 */

/** 本驱动是否支持取消。集中成一个常量，避免能力声明与 cancelQuery 各说各话。 */
export const SQLITE_CAN_CANCEL = false

/**
 * 不支持取消的说明文本。
 *
 * 单独导出是为了让 UI / 测试引用同一份文案：
 * 如果各写一份，迟早出现"UI 说不支持、驱动说支持"这种矛盾提示。
 */
export const SQLITE_CANCEL_UNSUPPORTED_REASON =
  'SQLite 驱动（node:sqlite）是同步 API，没有 interrupt 能力，无法中断正在执行的查询。' +
  '如需强行停止，请关闭该连接（宿主进程终止后查询会被释放）。'

/**
 * SQLite 的 cancelQuery 实现：永远返回 false。
 *
 * 刻意**不抛错**：取消是一个"尽力而为"的动作，失败用返回值表达即可。
 * 抛错会让调用方在清理路径上多处理一种异常。
 */
export function cancelSqliteQuery(): Promise<boolean> {
  return Promise.resolve(false)
}
