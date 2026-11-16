import { describe, expect, test } from 'vitest'

import {
  computeErRelations,
  erRelationStatus,
  firstUnescapedDot,
  formatQualifiedName,
  inferSchemaFromObjectId,
  relationStatusToken,
  unescapeIdPart
} from './er-relations'
import type { ErTableInput } from './er-relations'

function table(
  id: string,
  name: string,
  foreignKeys: unknown[] | undefined,
  schema?: string
): ErTableInput {
  return {
    ref: { id, kind: 'table', name, ...(schema === undefined ? {} : { schema }) } as never,
    desc: { columns: [], hasUniqueKey: true, ...(foreignKeys === undefined ? {} : { foreignKeys }) } as never
  }
}

function fk(columns: string[], referencedTable: string, referencedColumns: string[], name: string | null = null) {
  return { name, columns, referencedSchema: null, referencedTable, referencedColumns }
}

describe('节点 id 解析', () => {
  test('唯一未转义的点是 schema 与表名的分隔符', () => {
    expect(firstUnescapedDot('app.items')).toBe(3)
    expect(firstUnescapedDot('noDot')).toBe(-1)
  })

  // 表名里的点是标识符的一部分，靠反斜杠转义与分隔符区分。
  test('转义点不作为分隔符', () => {
    const escaped = 'app.user\\.archive'
    expect(firstUnescapedDot(escaped)).toBe(3)
    expect(unescapeIdPart(escaped.slice(0, 3))).toBe('app')
    expect(unescapeIdPart(escaped.slice(4))).toBe('user.archive')
  })

  test('全部转义时没有分隔符', () => {
    expect(firstUnescapedDot('a\\.b')).toBe(-1)
  })

  test('反转义还原转义点与反斜杠', () => {
    expect(unescapeIdPart('a\\.b')).toBe('a.b')
    expect(unescapeIdPart('a\\\\b')).toBe('a\\b')
    expect(unescapeIdPart('plain')).toBe('plain')
  })

  test('反转义末尾的孤立反斜杠不丢字符', () => {
    expect(unescapeIdPart('a\\')).toBe('a\\')
  })
})

describe('从对象 id 推断 schema', () => {
  test('SQLite 没有 schema 概念，一律返回 null', () => {
    expect(inferSchemaFromObjectId('table:app.items', 'sqlite')).toBeNull()
  })

  test('带作用域的 id 能取出 schema', () => {
    expect(inferSchemaFromObjectId('c1|table:app.items', 'postgresql')).toBe('app')
    expect(inferSchemaFromObjectId('table:app.items', 'postgresql')).toBe('app')
  })

  test('没有点或没有前缀时返回 null 而不是猜一个 schema', () => {
    expect(inferSchemaFromObjectId('table:items', 'postgresql')).toBeNull()
    expect(inferSchemaFromObjectId('column:app.items.id', 'postgresql')).toBeNull()
    expect(inferSchemaFromObjectId('folder:x', 'postgresql')).toBeNull()
    expect(inferSchemaFromObjectId('', 'postgresql')).toBeNull()
  })

  test('视图节点同样能推断 schema', () => {
    expect(inferSchemaFromObjectId('view:app.v', 'postgresql')).toBe('app')
  })

  test('schema 为空串时返回 null', () => {
    expect(inferSchemaFromObjectId('table:.items', 'postgresql')).toBeNull()
  })
})

describe('限定名格式化', () => {
  test('无 schema 时只给表名，有 schema 时用点连接', () => {
    expect(formatQualifiedName(null, 'items')).toBe('items')
    expect(formatQualifiedName('app', 'items')).toBe('app.items')
  })
})

describe('ER 关系计算', () => {
  // undefined 表示驱动没提供外键元数据，不能当成「这些表没有外键」。
  test('外键元数据缺失时状态为 unavailable 而不是无关系', () => {
    const summary = computeErRelations([table('table:app.a', 'a', undefined, 'app'), table('table:app.b', 'b', undefined, 'app')])
    expect(summary.metadataState).toBe('unavailable')
    expect(summary.totalForeignKeys).toBe(0)
    expect(summary.hasRelations).toBe(false)
    expect(erRelationStatus(summary).warn).toBe(true)
  })

  test('双方都在图内时画出关系', () => {
    const summary = computeErRelations([
      table('table:app.child', 'child', [fk(['parent_id'], 'parent', ['id'], 'fk_parent')], 'app'),
      table('table:app.parent', 'parent', [], 'app')
    ])
    expect(summary.relations).toHaveLength(1)
    expect(summary.hasRelations).toBe(true)
    expect(summary.skipped).toEqual([])
    expect(erRelationStatus(summary).kind).toBe('relations')
  })

  test('外键指向图外的表时记为跳过并说明原因', () => {
    const summary = computeErRelations([
      table('table:app.child', 'child', [fk(['parent_id'], 'outside', ['id'])], 'app')
    ])
    expect(summary.relations).toEqual([])
    expect(summary.skipped).toHaveLength(1)
    expect(summary.totalForeignKeys).toBe(1)
    expect(erRelationStatus(summary).kind).toBe('undrawn')
  })

  test('驱动确认没有外键时状态为 none', () => {
    const summary = computeErRelations([table('table:app.a', 'a', [], 'app'), table('table:app.b', 'b', [], 'app')])
    expect(summary.metadataState).toBe('empty')
    expect(summary.relations).toEqual([])
    const status = erRelationStatus(summary)
    expect(status.kind).toBe('none')
    expect(status.warn).toBe(false)
  })

  test('多列外键被标记为组合关系，列对顺序保持', () => {
    const summary = computeErRelations([
      table('table:app.child', 'child', [fk(['a', 'b'], 'parent', ['x', 'y'], 'fk_ab')], 'app'),
      table('table:app.parent', 'parent', [], 'app')
    ])
    expect(summary.relations[0]?.composite).toBe(true)
    expect(summary.relations[0]?.columnPairs.map((pair) => pair.column)).toEqual(['a', 'b'])
  })

  // 约束名可能缺失，此时 id 与展示都要有稳定兜底。
  test('缺少约束名时仍生成稳定 id', () => {
    const build = (): ReturnType<typeof computeErRelations> =>
      computeErRelations([
        table('table:app.child', 'child', [fk(['parent_id'], 'parent', ['id'], null)], 'app'),
        table('table:app.parent', 'parent', [], 'app')
      ])
    expect(build().relations[0]?.id).toBe(build().relations[0]?.id)
    expect(build().relations[0]?.constraintName).toBeNull()
  })

  test('空图不会抛错且状态为无关系', () => {
    const summary = computeErRelations([])
    expect(summary.relations).toEqual([])
    expect(summary.skipped).toEqual([])
    expect(() => erRelationStatus(summary)).not.toThrow()
  })

  test('同一份输入得到同样的关系顺序', () => {
    const build = (): string[] =>
      computeErRelations([
        table('table:app.c1', 'c1', [fk(['p'], 'parent', ['id'])], 'app'),
        table('table:app.c2', 'c2', [fk(['p'], 'parent', ['id'])], 'app'),
        table('table:app.parent', 'parent', [], 'app')
      ]).relations.map((relation) => relation.id)
    expect(build()).toEqual(build())
  })

  test('状态令牌与状态文案保持一致', () => {
    const summary = computeErRelations([table('table:app.a', 'a', [], 'app')])
    expect(relationStatusToken(summary)).toBe(erRelationStatus(summary).kind)
  })
})
