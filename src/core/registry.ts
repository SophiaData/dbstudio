/**
 * 方言注册表。
 *
 * 设计来源：DBeaver 的 `SQLDialectRegistry`
 * （证据：devel@cf0f184e `model.sql/src/org/jkiss/dbeaver/model/sql/registry/SQLDialectRegistry.java#L39-L64`）
 * 与驱动注册的扩展点 `org.jkiss.dbeaver.dataSourceProvider`。
 *
 * ===== 一处刻意的简化，理由来自剖析结论 =====
 *
 * DBeaver 用 Eclipse 扩展点 + `plugin.xml` 声明方言与驱动，注册表在启动时
 * 扫描所有 bundle 的插件描述符（`DataSourceProviderRegistry`），
 * 这是支撑「上百种数据库」的骨架。
 *
 * 但剖析报告「陷阱 4」明确写道：
 *   「起步用简单的 `Map<string, Adapter>` 注册表即可，
 *     等**真的接入第二个数据库**时再抽象。过早抽象是这类项目最常见的死法。」
 *
 * 所以这里就是一个 Map。真需要动态装载时，把 `register` 换成扫描目录即可，
 * 调用方代码不用动——这正是保留这层间接的唯一目的。
 */

import type { DialectInfo, DriverAdapter } from './driver'

/**
 * 适配器工厂。
 *
 * 返回新实例而不是复用单例——因为**一个连接一个宿主进程**，
 * 进程内持有连接状态是安全的，但同一进程不该被两个连接共用。
 */
export type DriverFactory = () => DriverAdapter

interface Registration {
  readonly factory: DriverFactory
  readonly info: DialectInfo
}

export class DriverRegistry {
  readonly #byDialect = new Map<string, Registration>()

  /** 注册一个方言。重复注册同一 id 会抛错——静默覆盖会让排查变成噩梦。 */
  register(factory: DriverFactory, info: DialectInfo): void {
    if (this.#byDialect.has(info.id)) {
      throw new Error(`方言 id 重复注册: ${info.id}`)
    }
    this.#byDialect.set(info.id, { factory, info })
  }

  /** 已注册方言的展示信息，供 UI 生成「新建连接」表单。 */
  list(): DialectInfo[] {
    return [...this.#byDialect.values()].map((r) => r.info)
  }

  has(dialectId: string): boolean {
    return this.#byDialect.has(dialectId)
  }

  create(dialectId: string): DriverAdapter {
    const reg = this.#byDialect.get(dialectId)
    if (!reg) {
      throw new Error(`未知方言: ${dialectId}（已注册: ${[...this.#byDialect.keys()].join(', ') || '无'}）`)
    }
    return reg.factory()
  }
}
