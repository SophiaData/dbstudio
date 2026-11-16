import { describe, expect, test } from 'vitest'

import type { DialectInfo, DriverAdapter } from './driver'
import { DriverRegistry } from './registry'
import { SQLITE_SCRIPT_RULES } from './sql-script'

function dialectInfo(id: string, name = id.toUpperCase()): DialectInfo {
  return {
    id,
    name,
    fields: [],
    quoting: { open: '"', close: '"', escape: 'double' },
    scriptRules: SQLITE_SCRIPT_RULES
  }
}

/** 注册表只负责工厂调用，不触碰 adapter 的任何成员。 */
function fakeAdapter(info: DialectInfo): DriverAdapter {
  return { info } as unknown as DriverAdapter
}

describe('方言注册表', () => {
  test('注册后能按 id 查到并创建实例', () => {
    const registry = new DriverRegistry()
    const info = dialectInfo('sqlite')
    registry.register(() => fakeAdapter(info), info)

    expect(registry.has('sqlite')).toBe(true)
    expect(registry.create('sqlite').info.id).toBe('sqlite')
  })

  test('未注册的 id 既不在 has 里，创建也会抛错', () => {
    const registry = new DriverRegistry()
    expect(registry.has('mysql')).toBe(false)
    expect(() => registry.create('mysql')).toThrow(/未知方言: mysql/)
  })

  // 空注册表时必须明确写「无」，否则错误信息会以空括号结尾，看不出是否真没注册过。
  test('没有任何方言时错误信息指明已注册列表为空', () => {
    const registry = new DriverRegistry()
    expect(() => registry.create('nope')).toThrow(/已注册: 无/)
  })

  test('存在其它方言时错误信息列出已注册 id，便于排查拼写错误', () => {
    const registry = new DriverRegistry()
    for (const id of ['sqlite', 'postgres']) {
      const info = dialectInfo(id)
      registry.register(() => fakeAdapter(info), info)
    }
    expect(() => registry.create('mysql')).toThrow(/未知方言: mysql（已注册: sqlite, postgres）/)
  })

  // 静默覆盖会让「为什么连到了旧实现」变成无从下手的排查。
  test('重复注册同一 id 抛错，且不覆盖原有注册', () => {
    const registry = new DriverRegistry()
    const first = dialectInfo('sqlite', '第一个')
    const second = dialectInfo('sqlite', '第二个')
    registry.register(() => fakeAdapter(first), first)

    expect(() => registry.register(() => fakeAdapter(second), second)).toThrow(/方言 id 重复注册: sqlite/)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.name).toBe('第一个')
  })

  // 一个连接一个宿主进程，同一进程内两个连接不能共用同一 adapter 实例。
  test('每次 create 都调用工厂并返回新实例', () => {
    const registry = new DriverRegistry()
    const info = dialectInfo('sqlite')
    let calls = 0
    registry.register(() => {
      calls += 1
      return fakeAdapter(info)
    }, info)

    const first = registry.create('sqlite')
    const second = registry.create('sqlite')
    expect(calls).toBe(2)
    expect(first).not.toBe(second)
  })

  test('注册时不调用工厂，只有 create 才调用', () => {
    const registry = new DriverRegistry()
    const info = dialectInfo('sqlite')
    let calls = 0
    registry.register(() => {
      calls += 1
      return fakeAdapter(info)
    }, info)

    expect(calls).toBe(0)
    registry.create('sqlite')
    expect(calls).toBe(1)
  })

  // list() 直接暴露内部数组会让调用方的 push/sort 反向改写注册表。
  test('list 返回独立副本，改动它不影响注册表本身', () => {
    const registry = new DriverRegistry()
    const info = dialectInfo('sqlite')
    registry.register(() => fakeAdapter(info), info)

    const listed = registry.list()
    listed.push(dialectInfo('injected'))
    listed[0] = dialectInfo('mutated')

    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.id).toBe('sqlite')
  })

  test('list 保持注册顺序，UI 表单顺序因此稳定', () => {
    const registry = new DriverRegistry()
    for (const id of ['sqlite', 'postgres', 'mysql']) {
      const info = dialectInfo(id)
      registry.register(() => fakeAdapter(info), info)
    }
    expect(registry.list().map((item) => item.id)).toEqual(['sqlite', 'postgres', 'mysql'])
  })
})
