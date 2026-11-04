/**
 * 游标 id 的作用域封装与生存账本。
 *
 * ===== 问题：cursorId 是「进程内局部变量」，而主进程要跨连接找宿主 =====
 *
 * adapter 生成的 cursorId（如 `cur-3`）只在**生成它的那个宿主进程**里有意义。
 * 另一个宿主进程可能也生成了 `cur-3`，指向完全不同的结果集。
 * 而 `fetchResultPage(cursorId)` 进来时，主进程手上只有一个字符串，
 * 它必须先回答「这是哪个连接的游标」才能转发。
 *
 * ===== 两个方案与取舍 =====
 *
 * (a) 给 cursorId 加连接前缀（本实现）：`connection:c1|cur-3`
 * (b) 主进程维护 `Map<cursorId, connectionId>`
 *
 * 选 (a)，理由三条：
 *
 * 1. **无状态**。(b) 的映射表是主进程里一份额外的可变状态：进程重启、连接重建、
 *    或者某处忘了删除，都会留下脏条目。而 (a) 的信息完全编码在字符串本身，
 *    不存在「表和实际游标不同步」这种状态。
 * 2. **复用已验证的规则**。`NodeId` 已经用同一套 `connection:<cid>|<payload>`
 *    解决了完全同构的问题（节点 id 的作用域），并且 `core/api.ts` 里写明
 *    「规则只定义一次，UI 与测试共用」。游标是同一类问题，用同一套规则，
 *    读代码的人不用再学第二种编码。
 * 3. **失败可辨识**。传进来的 cursorId 若不带前缀（比如 UI 把原生 id 直接回传），
 *    (a) 能在本地立刻判定「这不是我给出去的 id」并报错；
 *    (b) 只会在映射表里查不到，报出的错误与「游标已被关闭」无法区分。
 *
 * ===== 注意对 UI 的影响（重要） =====
 *
 * 一旦加了前缀，`QueryResult.cursorId` 与 adapter 的原生 id **不再是同一个字符串**。
 * 所以 `runQuery` 返回前必须重新包装、`fetchResultPage`/`closeCursor` 入参必须还原。
 * UI 只需要把它当**不透明字符串**存着再传回来，不该尝试解析它。
 *
 * ===== 生存账本 =====
 *
 * 前缀解决了「往哪转发」，但解决不了「清理」。宿主进程被关掉时它内部的游标
 * 自然消失，可主进程若不留痕，就无法回答两件事：
 *   1. `remove(connectionId)` 时该清理哪些——虽然宿主会退出，
 *      但我们仍要主动 closeCursor，让「释放」在双方都留下明确语义，
 *      而不是依赖「进程没了所以大概没事」。
 *   2. 泄漏可见性。若某个连接不断开查询却从不 closeCursor，
 *      这张表的大小就是泄漏的量化指标；没有它，泄漏是完全隐形的。
 *
 * 所以它**不是**路由表（路由靠前缀），而是**生命周期账本**。
 */

import { NodeId } from '../../core/api'

export interface ParsedCursorId {
  readonly connectionId: string
  readonly rawCursorId: string
}

export class CursorRegistry {
  /**
   * 已发出的游标：连接 id → 该连接上仍存活的原生游标 id 集合。
   *
   * 方案 (a) 仍然需要这张表，理由见文件头「生存账本」。
   */
  readonly #open = new Map<string, Set<string>>()

  /** 把 adapter 的原生游标 id 包上连接归属，交给 UI。 */
  scope(connectionId: string, rawCursorId: string): string {
    return NodeId.scoped(connectionId, rawCursorId)
  }

  /**
   * 还原成 adapter 的原生 id。
   *
   * 返回 null 表示这个字符串不是本层发出去的（格式不对），
   * 由调用方决定怎么报错——而不是在这里抛，因为两种入参错误
   * （格式错 / 连接不存在）需要不同的提示。
   */
  parse(scoped: string): ParsedCursorId | null {
    const parsed = NodeId.parse(scoped)
    // adapterId 为 null 说明只有 `connection:c1` 而没有 `|游标`，不是合法游标 id。
    if (!parsed || parsed.adapterId === null || parsed.adapterId === '') return null
    return { connectionId: parsed.connectionId, rawCursorId: parsed.adapterId }
  }

  /**
   * 同 `parse`，但格式不对时直接抛 ConnectionManager 原有的可读错误。
   *
   * 「连接不存在」不在本模块判定：账本只认识字符串，不知道会话是否还活着。
   * 这样错误文案与职责边界都和拆分前完全一致。
   */
  parseOrThrow(scoped: string): ParsedCursorId {
    const parsed = this.parse(scoped)
    if (!parsed) {
      throw new Error(
        `无法解析的游标 id: ${scoped}（游标 id 必须原样使用 runQuery 返回的值，不要自行拼接）`
      )
    }
    return parsed
  }

  /** 登记一个游标到账本。 */
  track(connectionId: string, rawCursorId: string): void {
    let set = this.#open.get(connectionId)
    if (!set) {
      set = new Set<string>()
      this.#open.set(connectionId, set)
    }
    set.add(rawCursorId)
  }

  /**
   * 从账本销账。
   *
   * 即使宿主侧关闭失败也要调用：那条游标要么已经没了，要么随着宿主退出
   * 而消失，留着账本条目只会被误判成泄漏。
   */
  forget(connectionId: string, rawCursorId: string): void {
    this.#open.get(connectionId)?.delete(rawCursorId)
  }

  /** 宿主退出 / 断连 / 删除连接时清空该连接的全部账本。 */
  clearConnection(connectionId: string): void {
    this.#open.delete(connectionId)
  }

  /** 诊断用：当前账本里的游标总数。 */
  count(): number {
    let cursors = 0
    for (const set of this.#open.values()) cursors += set.size
    return cursors
  }
}
