import { describe, expect, test } from 'vitest'

import {
  TREE_OVERSCAN,
  TREE_ROW_HEIGHT,
  canPruneConnectionPreferences,
  connectionIdentity,
  flattenTree,
  loadConnectionPreferences,
  rootConnectionId,
  treeWindow
} from './tree-model'
import type { TreeNode } from './tree-model'

function connectionNode(id: string, name = 'conn', dialect = 'sqlite'): TreeNode {
  return {
    ref: { kind: 'connection', id, name, meta: { dialect } },
    children: [],
    loaded: true,
    expanded: false
  } as unknown as TreeNode
}

function childNode(kind: string, id: string, name: string): TreeNode {
  return { ref: { kind, id, name }, children: [], loaded: true, expanded: false } as unknown as TreeNode
}

describe('根连接 id 提取', () => {
  test('连接根节点能取出裸连接 id', () => {
    expect(rootConnectionId(connectionNode('connection:c1'))).toBe('c1')
  })

  // 作用域节点（含竖线）不是根，取出来当连接 id 会让偏好绑到错误的连接上。
  test('作用域节点返回 null', () => {
    expect(rootConnectionId(connectionNode('connection:c1|table:x'))).toBeNull()
  })

  test('非连接节点返回 null', () => {
    expect(rootConnectionId(childNode('table', 'connection:c1', 't'))).toBeNull()
    expect(rootConnectionId(childNode('table', 'table:app.items', 'items'))).toBeNull()
  })

  test('缺少前缀的连接节点返回 null', () => {
    expect(rootConnectionId(connectionNode('c1'))).toBeNull()
  })
})

describe('连接身份绑定', () => {
  // 偏好绑定到「名字 + 方言」而不是数组下标；下标会随列表变化而错绑。
  test('身份由名字与方言组成', () => {
    expect(connectionIdentity(connectionNode('connection:c1', '生产库', 'mysql'))).toBe(
      JSON.stringify(['生产库', 'mysql'])
    )
  })

  test('没有方言元数据时用空串占位，不会与同名同方言混淆', () => {
    const noMeta = { ref: { kind: 'connection', id: 'connection:c1', name: 'x' }, children: [], loaded: true } as unknown as TreeNode
    expect(connectionIdentity(noMeta)).toBe(JSON.stringify(['x', '']))
  })

  test('同名不同方言得到不同身份', () => {
    expect(connectionIdentity(connectionNode('connection:a', 'n', 'mysql'))).not.toBe(
      connectionIdentity(connectionNode('connection:b', 'n', 'sqlite'))
    )
  })
})

describe('虚拟滚动窗口', () => {
  test('顶部时从 0 开始并预留 overscan', () => {
    const window = treeWindow(1000, 0, TREE_ROW_HEIGHT * 10)
    expect(window.start).toBe(0)
    expect(window.offset).toBe(0)
    expect(window.end).toBeGreaterThan(10)
    expect(window.end).toBeLessThanOrEqual(1000)
  })

  test('总高度按行数与行高计算', () => {
    expect(treeWindow(50, 0, 200).total).toBe(50 * TREE_ROW_HEIGHT)
  })

  test('滚动后窗口跟随且 start 不小于 0', () => {
    const window = treeWindow(1000, TREE_ROW_HEIGHT * 100, TREE_ROW_HEIGHT * 5)
    expect(window.start).toBeGreaterThan(0)
    expect(window.offset).toBe(window.start * TREE_ROW_HEIGHT)
  })

  test('负的 scrollTop 被钳制到 0', () => {
    expect(treeWindow(100, -500, 200).start).toBe(0)
  })

  test('行数少于窗口时 end 不超过行数', () => {
    const window = treeWindow(3, 0, TREE_ROW_HEIGHT * 50)
    expect(window.end).toBe(3)
  })

  test('空树得到空窗口', () => {
    const window = treeWindow(0, 0, 200)
    expect(window.start).toBe(0)
    expect(window.end).toBe(0)
    expect(window.total).toBe(0)
  })

  // 高度为 0 时仍要至少渲染一行，否则容器初始化瞬间会白屏。
  test('高度为 0 时仍覆盖至少一行', () => {
    expect(treeWindow(100, 0, 0).end).toBeGreaterThan(0)
  })

  test('overscan 参与窗口计算', () => {
    expect(TREE_OVERSCAN).toBeGreaterThan(0)
    const tight = treeWindow(1000, TREE_ROW_HEIGHT * 50, TREE_ROW_HEIGHT)
    expect(tight.end - tight.start).toBeGreaterThanOrEqual(TREE_OVERSCAN)
  })
})

describe('连接偏好加载', () => {
  // 偏好是锦上添花的显示设置，坏数据不能让树打不开。
  test('坏 JSON 与非对象内容返回空偏好', () => {
    const broken = { getItem: () => '{not json' }
    expect(loadConnectionPreferences(broken as never)).toEqual({})
    const array = { getItem: () => '[1,2]' }
    expect(loadConnectionPreferences(array as never)).toEqual({})
    const scalar = { getItem: () => '"x"' }
    expect(loadConnectionPreferences(scalar as never)).toEqual({})
  })

  test('没有存储时返回空偏好', () => {
    expect(loadConnectionPreferences(null)).toEqual({})
  })

  test('存储读取抛错时降级为空偏好', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError')
      }
    }
    expect(() => loadConnectionPreferences(throwing as never)).not.toThrow()
  })

  test('空内容返回空偏好', () => {
    expect(loadConnectionPreferences({ getItem: () => '{}' } as never)).toEqual({})
  })
})

describe('偏好清理前置条件', () => {
  // 元数据还在读或仍在启动时清理，会把还没出现的连接误删。
  test('元数据未就绪或仍在启动时不允许清理', () => {
    expect(canPruneConnectionPreferences(false, false)).toBe(false)
    expect(canPruneConnectionPreferences(true, true)).toBe(false)
    expect(canPruneConnectionPreferences(false, true)).toBe(false)
  })

  test('元数据就绪且不在启动中才允许清理', () => {
    expect(canPruneConnectionPreferences(true, false)).toBe(true)
  })
})

describe('树扁平化', () => {
  test('空树得到空行', () => {
    expect(flattenTree([])).toEqual([])
  })

  test('折叠的连接只显示自身一行', () => {
    const root = connectionNode('connection:c1', 'conn')
    ;(root as { expanded: boolean }).expanded = false
    const rows = flattenTree([root])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.depth).toBe(0)
  })

  test('展开的连接把子节点排在后面', () => {
    const root = connectionNode('connection:c1', 'conn')
    ;(root as { expanded: boolean }).expanded = true
    ;(root as { children: TreeNode[] }).children = [childNode('table', 'table:a', 'a'), childNode('table', 'table:b', 'b')]
    const rows = flattenTree([root])
    expect(rows).toHaveLength(3)
    expect(rows[1]?.depth).toBe(1)
    expect(rows[2]?.depth).toBe(1)
  })

  // 搜索要保留命中节点的父链，否则命中的子节点会失去上下文。
  test('搜索时保留命中项的父链并过滤掉无关分支', () => {
    const root = connectionNode('connection:c1', 'conn')
    ;(root as { expanded: boolean }).expanded = true
    ;(root as { children: TreeNode[] }).children = [
      childNode('table', 'table:orders', 'orders'),
      childNode('table', 'table:users', 'users')
    ]
    const rows = flattenTree([root], 'orders')
    const names = rows.map((row) => row.node.ref.name)
    expect(names).toContain('orders')
    expect(names).not.toContain('users')
    expect(names).toContain('conn')
  })

  test('搜索大小写不敏感', () => {
    const root = connectionNode('connection:c1', 'CONN')
    ;(root as { expanded: boolean }).expanded = true
    ;(root as { children: TreeNode[] }).children = [childNode('table', 'table:orders', 'Orders')]
    expect(flattenTree([root], 'orders').length).toBeGreaterThan(0)
  })

  test('没有命中时不含任何数据行', () => {
    const root = connectionNode('connection:c1', 'conn')
    ;(root as { expanded: boolean }).expanded = true
    ;(root as { children: TreeNode[] }).children = [childNode('table', 'table:a', 'a')]
    const rows = flattenTree([root], 'zzz-no-match')
    expect(rows.map((row) => row.node.ref.name)).not.toContain('a')
  })
})
