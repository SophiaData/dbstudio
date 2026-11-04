/**
 * ConnectionManager 拆分后的共享类型与小工具。
 *
 * 这里只放**纯类型**与不持有状态的函数，目的是让连接目录（catalog）、
 * 游标账本（cursor registry）与 ConnectionManager 使用同一套定义，
 * 避免三处各写一份后悄悄漂移。
 *
 * 刻意不把 `DriverHostHandle` 当作运行时依赖：`LiveConnection.host` 只需要
 * 它的类型，`import type` 会在编译后完全消失。因此本模块仍可被纯 Node
 * 探针直接加载，也不会改变测试对 `DriverHostHandle.prototype` 打桩的模块身份。
 */

import type { ConnectionConfig } from '../../core/dialect'
import type { DialectInfo } from '../../core/driver'
import type { DriverCapabilities } from '../../core/model'
import type { DriverHostHandle, DriverHostOptions } from '../DriverHostHandle'

/** 驱动宿主构造器；server composition 可注入独立的脚本解析策略。 */
export type DriverHostFactory = (options: DriverHostOptions) => DriverHostHandle

/** 有活动会话（宿主进程活着）的连接。 */
export interface LiveConnection {
  readonly id: string
  readonly config: ConnectionConfig
  readonly capabilities: DriverCapabilities
  readonly host: DriverHostHandle
  /**
   * 该连接的方言展示信息。
   *
   * `previewTable` 用它取 `quoting` 规则。存成字段而不是每次回 `#dialects`
   * 线性查一遍：方言清单构造后不可变，而查询是热路径，存一份更直白也更快。
   */
  readonly info: DialectInfo
}

/**
 * 已保存但**没有活动会话**的连接。
 *
 * 为什么需要这个类型：加入持久化后，"有配置"与"有会话"是两件独立的事。
 * 启动时我们载入所有配置但不连接（见 ConnectionCatalog 的载入逻辑），
 * 因此大部分连接在任意时刻都只是"一条配置"。把它和 `LiveConnection` 分开，
 * 能让"要不要 spawn 宿主"这件事由类型系统提醒——拿到 SavedConnection
 * 却想调 host 会立刻编译失败，而不是运行时空指针。
 */
export interface SavedConnection {
  readonly id: string
  readonly config: ConnectionConfig
  readonly info: DialectInfo
}

/** 日志级别。ConnectionManager 与目录共用，避免字符串字面量各写一套。 */
export type ConnectionLogLevel = 'info' | 'warn' | 'error'

/** 日志出口。 */
export type ConnectionLogger = (level: ConnectionLogLevel, message: string) => void

/** 生成短连接 id。只需要本会话内唯一，不必是 UUID。 */
export function makeConnectionId(seq: number): string {
  return `c${seq}`
}

/**
 * 从形如 `c12` 的 id 里提取序号。
 *
 * 返回 null 表示不是本层生成的 id 形态；无法解析为有限数字时同样返回 null。
 * 载入持久化配置时用它把 `#seq` 推过已存在的 id，避免新建时撞车。
 */
export function connectionIdSequence(id: string): number | null {
  const match = /^c(\d+)$/.exec(id)
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) ? n : null
}

/** 从任意异常里取一句可读信息。 */
export function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
