/**
 * PostgreSQL 查询取消 —— 这个驱动**能真取消**，这里说明是怎么做到的。
 *
 * ===== 机制：pg_cancel_backend + 独立连接 =====
 *
 * PostgreSQL 的服务端是**多进程**模型：每个连接对应一个后端进程，
 * 有自己的 PID。服务端提供了 `pg_cancel_backend(pid)` 函数，
 * 从**任意别的连接**调用它，就能中断那个 PID 上正在执行的语句。
 *
 * 所以流程是：
 *   1. 连接建立后立刻记下 `SELECT pg_backend_pid()`
 *   2. 要取消时，**新开一条独立连接**，执行 `SELECT pg_cancel_backend($1)`
 *   3. 关掉这条临时连接
 *
 * ===== 为什么必须用"独立连接" =====
 *
 * 这是最关键的一点，也是最容易写错的地方：
 * 正在执行长查询的那条连接**正忙**，在它上面再发一条 `pg_cancel_backend`
 * 会被排在长查询之后——等长查询自己跑完才执行，等于没取消。
 * 必须另起一条连接，才能"从旁边把它掐掉"。
 * （`pg` 驱动内部也能通过 socket 发送 CancelRequest 包，但那是私有 API，
 *   且要自己处理协议；用一条独立连接更直白、也更容易验证。）
 *
 * ===== 一个必须处理的坑：pg_cancel_backend 对空闲会话也返回 true =====
 *
 * 实测（PG 14）：连接空闲时调用 `pg_cancel_backend(pid)` 依然返回 `t`。
 * 于是"函数返回 true"**不等于**"真的取消了一个正在跑的查询"。
 * 如果不处理，UI 会在用户什么都没跑的时候显示"已取消"——那是假信息。
 *
 * 所以取消前先用 `pg_stat_activity` 确认目标 PID 的 `state = 'active'`：
 *   - active   → 确实有语句在跑，发取消
 *   - idle     → 没在跑，直接返回 false（诚实：没有可取消的东西）
 *   - idle in transaction 等 → 同样没有正在执行的语句，返回 false
 *
 * `pg_stat_activity` 只能看到当前用户有权限的会话，但取消的正是自己这条连接，
 * 必然可见，所以这个前置检查是可靠的。
 *
 * ===== 取消成功后的现象 =====
 *
 * 被取消的查询会以错误 "canceling statement due to user request" 结束
 * （SQLSTATE 57014）。这是**预期行为**，不是异常故障：
 * 上层应当把它识别成"用户取消了"，而不是显示成红色报错。
 */

import { Client } from 'pg'

/** 建立取消连接所需的参数。与主连接使用同一套连接信息。 */
export interface PgCancelContext {
  readonly host: string
  readonly port: number
  readonly database: string
  readonly user: string
  readonly password: string | undefined
  /** 主连接的后端 PID（`SELECT pg_backend_pid()` 的结果）。 */
  readonly backendPid: number | null
}

/** 被取消的查询返回的错误里会出现这段文本（SQLSTATE 57014）。 */
export const PG_CANCEL_ERROR_HINT = 'canceling statement due to user request'

/** 判断一个错误是否是"被取消"而不是真故障。 */
export function isCancelError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (code === '57014') return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.includes(PG_CANCEL_ERROR_HINT)
}

/**
 * 用一条**临时连接**取消指定 PID 上的查询。
 *
 * 返回 true 表示服务端确认取消请求已被接受（`pg_cancel_backend` 返回 t）。
 * 返回 false 的情形：没有 PID（未连接/取 PID 失败）、目标已不在运行、连接不上。
 *
 * 注意 `pg_cancel_backend` 返回 true 只表示"信号已送达"，
 * 并不意味着语句一定已经结束——它可能还在回滚途中。实测通常几十毫秒内结束。
 */
export async function cancelPostgresBackend(context: PgCancelContext): Promise<boolean> {
  if (context.backendPid === null || !Number.isInteger(context.backendPid) || context.backendPid <= 0) {
    return false
  }

  const cancelClient = new Client({
    host: context.host,
    port: context.port,
    database: context.database,
    user: context.user,
    password: context.password,
    // 取消连接必须是"短命"的：超时短一点，避免取消操作本身把用户卡住
    connectionTimeoutMillis: 5_000,
    // 在 pg_stat_activity 里能一眼看出这条连接是来取消的
    application_name: 'dbstudio-cancel'
  })

  try {
    await cancelClient.connect()
  } catch {
    // 连不上（网络/权限）就只能如实说取消失败
    try {
      await cancelClient.end()
    } catch {
      // ignore
    }
    return false
  }

  try {
    /**
     * 前置检查：确认这条连接上**真的有语句在执行**。
     *
     * 原因见文件头：`pg_cancel_backend` 对空闲会话也返回 true，
     * 不检查就会把"什么都没做"报成"已取消"。
     */
    const stateResult = await cancelClient.query<{ state: string | null }>(
      'SELECT state FROM pg_stat_activity WHERE pid = $1',
      [context.backendPid]
    )
    const state = stateResult.rows[0]?.state
    if (state !== 'active') {
      // 没有正在执行的语句（idle / idle in transaction / 会话已消失）
      return false
    }

    // 参数化传入 PID：虽然它是我们自己数字，但拼字符串没有任何好处
    const result = await cancelClient.query<{ ok: boolean }>('SELECT pg_cancel_backend($1) AS ok', [
      context.backendPid
    ])
    const row = result.rows[0]
    return row !== undefined && row.ok === true
  } catch {
    return false
  } finally {
    try {
      await cancelClient.end()
    } catch {
      // 关闭失败不影响取消结果
    }
  }
}
