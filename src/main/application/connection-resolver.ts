/**
 * 连接解析器：把「节点 id / 连接 id / 游标 id」统一解析成活动会话。
 *
 * ===== 为什么从 ConnectionManager 里抽出来 =====
 *
 * 主进程有一半的方法是同一种开头：解析入参、找到连接、找不到就抛错。
 * 这些解析散落在查询、编辑、DDL、导入、导出、事务等十几个入口里，
 * 文案看似一样，却是各写一遍——任何一次措辞或判定顺序的改动都要改十几处，
 * 漏改就会让同类错误在不同入口给出不同的提示。
 *
 * 本模块把四类解析集中成唯一出口：
 *
 *   - `resolveConnection(nodeId)`：`connection:c1|table:users` → 会话 + adapterId
 *   - `resolveConnectionLike(id)`：节点 id 或裸连接 id → 会话
 *   - `resolveSaved(id)`：连接 id → 已保存配置 + 可选会话
 *   - `resolveCursor(cursorId)`：带作用域的游标 id → 会话 + 原生游标 id
 *
 * ===== 边界 =====
 *
 * 本模块**不** import `ConnectionManager`，也不 import electron / 驱动实现。
 * 它只依赖三件最小能力，由调用方注入：
 *
 *   - `getSession`：从会话服务取活动会话；
 *   - `getSaved`：从配置目录取已保存配置；
 *   - `parseCursorOrThrow`：把 scoped cursorId 还原成 `{ connectionId, rawCursorId }`
 *     （格式错误时由它抛出「无法解析的游标 id」）。
 *
 * 依赖方向因此是单向的：ConnectionManager → ConnectionResolver，反向没有边。
 * 这样解析逻辑可以被独立测试，也不会因为会话/目录的实现变化而被拖下水。
 *
 * ===== 错误文案是契约 =====
 *
 * 下面四类错误都是 UI 直接展示给用户的，措辞与拆分前**逐字一致**：
 *   - `无法解析的节点 id: <input>`
 *   - `连接不存在或已断开: <id>`
 *   - `连接不存在: <input>`
 *   - `游标所属的连接已断开: <id>（游标随宿主进程一起失效）`
 *   - `无法解析的游标 id: ...`（由注入的 parseCursorOrThrow 产生）
 *
 * 改文案前先确认没有测试或 UI 文案依赖它。
 */

import { NodeId } from '../../core/api'
import { BackendError } from '../../backend/contract/errors'
import type { LiveConnection, SavedConnection } from './types'

/** 游标 id 解析结果。与 `CursorRegistry.parse` 的返回形状一致。 */
export interface ParsedCursorId {
  readonly connectionId: string
  readonly rawCursorId: string
}

/**
 * 解析器需要的最小外部能力。
 *
 * 全部用函数注入，而不是直接持有 `ConnectionSessionService` /
 * `ConnectionCatalog` / `CursorRegistry` 实例，目的有两个：
 *   1. 解析器不需要知道这些类的其余能力，接口面越小越不容易被误用；
 *   2. 测试可以用纯对象构造解析器，不必拉起会话或磁盘存储。
 */
export interface ConnectionResolverContext {
  /** 读取活动会话；没有（未连接 / 已断开）返回 undefined。 */
  readonly getSession: (connectionId: string) => LiveConnection | undefined
  /** 读取已保存配置；配置不存在或已删除返回 undefined。 */
  readonly getSaved: (connectionId: string) => SavedConnection | undefined
  /** 还原游标 id；格式不对时抛出「无法解析的游标 id」。 */
  readonly parseCursorOrThrow: (cursorId: string) => ParsedCursorId
}

export class ConnectionResolver {
  readonly #ctx: ConnectionResolverContext

  constructor(context: ConnectionResolverContext) {
    this.#ctx = context
  }

  /**
   * 解析 nodeId 并返回它所属的连接；出错时抛出可直接展示的消息。
   *
   * 三种失败各有独立文案，因为用户能做的应对完全不同：
   * 语法错（界面 bug）、连接没了（重连）、adapterId 缺失（用错了节点类型）。
   * 这里只负责前两种；adapterId 是否为 null 由调用方按业务判断
   * （例如「连接节点不能预览」）。
   */
  resolveConnection(nodeId: string): { conn: LiveConnection; adapterId: string | null } {
    const parsed = NodeId.parse(nodeId)
    if (!parsed) throw new Error(`无法解析的节点 id: ${nodeId}`)
    const conn = this.#ctx.getSession(parsed.connectionId)
    if (!conn) throw new Error(`连接不存在或已断开: ${parsed.connectionId}`)
    return { conn, adapterId: parsed.adapterId }
  }

  /**
   * 接受「节点 id（connection:c1）或裸连接 id（c1）」两种形态，归一成连接。
   * 用于 createTable / createView —— 它们的入参是 connectionId，
   * 但 UI 手上往往把它包成节点 id，两种都认更省事也更不易出错。
   */
  resolveConnectionLike(connectionIdOrNodeId: string): { conn: LiveConnection } {
    const parsed = NodeId.parse(connectionIdOrNodeId)
    const realId = parsed ? parsed.connectionId : connectionIdOrNodeId
    const conn = this.#ctx.getSession(realId)
    if (!conn) throw new Error(`连接不存在或已断开: ${realId}`)
    return { conn }
  }

  /**
   * 取「已保存配置」+「可选的活动会话」。updateConnection 用。
   *
   * 注意错误文案用的是**原始入参** `connectionId`，而不是解析后的 `realId`：
   * 与拆分前保持一致，方便用户对照自己传进来的值。
   */
  resolveSaved(connectionId: string): {
    conn: LiveConnection | undefined
    saved: SavedConnection
  } {
    const parsed = NodeId.parse(connectionId)
    const realId = parsed ? parsed.connectionId : connectionId
    const saved = this.#ctx.getSaved(realId)
    if (!saved) throw new BackendError({ code: 'not-found', message: `连接不存在: ${connectionId}` })
    return { conn: this.#ctx.getSession(realId), saved }
  }

  /**
   * 把 UI 传来的 scoped cursorId 还原成「连接 + adapter 原生 id」。
   *
   * 格式错误与连接失效是两件事，必须给出不同提示：
   * 前者说明调用方拼错了 id，后者说明游标随宿主进程一起没了。
   */
  resolveCursor(cursorId: string): { conn: LiveConnection; rawCursorId: string } {
    const parsed = this.#ctx.parseCursorOrThrow(cursorId)
    const conn = this.#ctx.getSession(parsed.connectionId)
    if (!conn) {
      throw new Error(
        `游标所属的连接已断开: ${parsed.connectionId}（游标随宿主进程一起失效）`
      )
    }
    return { conn, rawCursorId: parsed.rawCursorId }
  }
}
