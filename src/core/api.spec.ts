import { describe, expect, test } from 'vitest'

import { API_GLOBAL, IPC, NodeId } from './api'

describe('IPC 方法名表', () => {
  // 方法名与后端逐字对应，拼错只会在运行时表现为「方法不存在」，很难定位。
  test('全部带 dbstudio: 前缀', () => {
    for (const [key, value] of Object.entries(IPC)) {
      expect(value, key).toMatch(/^dbstudio:[A-Za-z]+$/)
    }
  })

  // 重名会让两个不同能力共用一个通道，其中一个永远收不到调用。
  test('方法名互不重复', () => {
    const values = Object.values(IPC)
    expect(new Set(values).size).toBe(values.length)
  })

  test('键名与值的方法段一致，避免复制粘贴后忘记改值', () => {
    for (const [key, value] of Object.entries(IPC)) {
      expect(value.slice('dbstudio:'.length), key).toBe(key)
    }
  })

  test('全局挂载名固定', () => {
    expect(API_GLOBAL).toBe('dbstudio')
  })
})

describe('节点 id 构造与解析', () => {
  test('连接 id 带固定前缀', () => {
    expect(NodeId.CONNECTION_PREFIX).toBe('connection:')
    expect(NodeId.connection('c1')).toBe('connection:c1')
  })

  test('作用域 id 记住连接归属与 adapter 原生 id', () => {
    const scoped = NodeId.scoped('c1', 'table:app.items')
    expect(scoped).toBe('connection:c1|table:app.items')
    expect(NodeId.parse(scoped)).toEqual({ connectionId: 'c1', adapterId: 'table:app.items' })
  })

  test('根节点的 adapterId 为 null', () => {
    expect(NodeId.parse(NodeId.connection('c1'))).toEqual({ connectionId: 'c1', adapterId: null })
  })

  test('不是连接节点时解析返回 null 而不是猜一个连接', () => {
    expect(NodeId.parse('table:app.items')).toBeNull()
    expect(NodeId.parse('')).toBeNull()
    expect(NodeId.parse('folder:x')).toBeNull()
  })

  // adapter 原生 id 里含竖线（如限定名）时，只按第一个竖线切分，其余留给 adapterId。
  test('adapterId 内部含竖线时仍按第一个竖线切分', () => {
    const scoped = NodeId.scoped('c1', 'table:a|b')
    expect(NodeId.parse(scoped)).toEqual({ connectionId: 'c1', adapterId: 'table:a|b' })
  })

  test('构造与解析互为逆运算', () => {
    for (const adapterId of ['schema:app', 'table:app.items', 'column:app.items.id', 'partition:t:2024']) {
      const parsed = NodeId.parse(NodeId.scoped('conn-1', adapterId))
      expect(parsed?.connectionId).toBe('conn-1')
      expect(parsed?.adapterId).toBe(adapterId)
    }
  })

  test('空 adapter id 被保留成空串而不是变成 null', () => {
    expect(NodeId.parse(NodeId.scoped('c1', ''))).toEqual({ connectionId: 'c1', adapterId: '' })
  })
})
