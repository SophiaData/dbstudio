import { describe, expect, test } from 'vitest'

import { analyzeFieldLineage, identifierInSql } from './field-lineage'
import type { FieldLineageTable, FieldLineageView } from './field-lineage'

const target = { schema: 'public', table: 'child', column: 'parent_id' }

describe('SQL 里的标识符匹配', () => {
  // 前缀命中会把 identity 当成 id，血缘就被"证据"污染了。
  test('按完整标识符匹配，不做前缀命中', () => {
    expect(identifierInSql('select id from t', 'id')).toBe(true)
    expect(identifierInSql('select identity from t', 'id')).toBe(false)
    expect(identifierInSql('select parent_id from t', 'id')).toBe(false)
  })

  test('引号、反引号、方括号里的标识符同样算命中', () => {
    expect(identifierInSql('select "parent_id" from t', 'parent_id')).toBe(true)
    expect(identifierInSql('select `parent_id` from t', 'parent_id')).toBe(true)
    expect(identifierInSql('select [parent_id] from t', 'parent_id')).toBe(true)
  })

  test('大小写不敏感', () => {
    expect(identifierInSql('SELECT Parent_Id FROM t', 'parent_id')).toBe(true)
    expect(identifierInSql('select parent_id from t', 'PARENT_ID')).toBe(true)
  })

  // 标识符里可能含正则元字符，必须转义后再匹配，否则会抛错或误匹配。
  test('含正则元字符的标识符按字面量处理', () => {
    expect(identifierInSql('select a_b from t', 'a_b')).toBe(true)
    expect(identifierInSql('select axb from t', 'a_b')).toBe(false)
    // `.` 若不转义会变成「任意字符」，让 colXname 也命中。
    expect(identifierInSql('select col.name from t', 'col.name')).toBe(true)
    expect(identifierInSql('select colXname from t', 'col.name')).toBe(false)
    expect(() => identifierInSql('select x from t', 'a(b')).not.toThrow()
  })

  test('空标识符不会命中任意 SQL', () => {
    expect(identifierInSql('select 1 from t', '')).toBe(false)
  })
})

describe('字段血缘分档', () => {
  test('没有任何证据时不编造结果', () => {
    const result = analyzeFieldLineage({ target, tables: [], views: [], histories: [] })
    expect(result.items).toEqual([])
    expect(result.counts).toEqual({ certain: 0, likely: 0, possible: 0 })
  })

  test('指向目标列的外键算确定', () => {
    const tables: FieldLineageTable[] = [
      {
        schema: 'public',
        name: 'child',
        columns: ['id', 'parent_id'],
        foreignKeys: [{ name: 'fk_parent', column: 'parent_id', refTable: 'parent', refColumn: 'id' }]
      }
    ]
    const result = analyzeFieldLineage({ target, tables })
    expect(result.counts.certain).toBe(1)
    expect(result.items[0]?.kind).toBe('foreignKey')
    expect(result.items[0]?.confidence).toBe('certain')
    expect(result.items[0]?.direction).toBe('outgoing')
  })

  test('被其它表引用的外键算确定且方向为 incoming', () => {
    const tables: FieldLineageTable[] = [
      {
        schema: 'public',
        name: 'grandchild',
        columns: ['id', 'child_id'],
        foreignKeys: [{ name: 'fk_child', column: 'child_id', refTable: 'child', refColumn: 'parent_id' }]
      }
    ]
    const result = analyzeFieldLineage({ target, tables })
    expect(result.counts.certain).toBe(1)
    expect(result.items[0]?.direction).toBe('incoming')
  })

  // 只出现表名、没出现列名时不足以证明这条列被引用。
  test('视图同时出现表与列才算 likely，只出现一个算 possible', () => {
    const both: FieldLineageView[] = [
      { schema: 'public', name: 'v_both', ddl: 'CREATE VIEW v_both AS SELECT parent_id FROM child' }
    ]
    expect(analyzeFieldLineage({ target, views: both }).items[0]?.confidence).toBe('likely')

    const onlyColumn: FieldLineageView[] = [
      { schema: 'public', name: 'v_col', ddl: 'CREATE VIEW v_col AS SELECT parent_id FROM other' }
    ]
    expect(analyzeFieldLineage({ target, views: onlyColumn }).items[0]?.confidence).toBe('possible')

    const onlyTable: FieldLineageView[] = [
      { schema: 'public', name: 'v_tab', ddl: 'CREATE VIEW v_tab AS SELECT id FROM child' }
    ]
    expect(analyzeFieldLineage({ target, views: onlyTable }).items[0]?.confidence).toBe('possible')
  })

  test('视图里表与列都没出现时不计入证据', () => {
    const views: FieldLineageView[] = [
      { schema: 'public', name: 'v_none', ddl: 'CREATE VIEW v_none AS SELECT id FROM unrelated' }
    ]
    expect(analyzeFieldLineage({ target, views }).items).toEqual([])
  })

  test('Schema 不匹配的证据被丢弃', () => {
    const views: FieldLineageView[] = [
      { schema: 'audit', name: 'v', ddl: 'CREATE VIEW v AS SELECT parent_id FROM child' }
    ]
    expect(analyzeFieldLineage({ target, views }).items).toEqual([])
  })

  test('历史 SQL 同时含表与列时算 likely', () => {
    const result = analyzeFieldLineage({
      target,
      histories: [{ id: 'h1', sql: 'select parent_id from child where 1=1' }]
    })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.confidence).toBe('likely')
    expect(result.items[0]?.kind).toBe('historyReference')
  })

  test('历史 SQL 缺少表或列时不作为证据', () => {
    expect(analyzeFieldLineage({ target, histories: [{ id: 'h', sql: 'select parent_id from other' }] }).items).toEqual(
      []
    )
    expect(analyzeFieldLineage({ target, histories: [{ id: 'h', sql: 'select id from child' }] }).items).toEqual([])
  })

  // 同名列只是名称巧合，必须落在「可能」而不是「确定」或「较可能」。
  test('其它表的同名列只算可能并提示需人工确认', () => {
    const tables: FieldLineageTable[] = [{ schema: 'public', name: 'sibling', columns: ['id', 'parent_id'] }]
    const result = analyzeFieldLineage({ target, tables })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.kind).toBe('sameName')
    expect(result.items[0]?.confidence).toBe('possible')
    expect(result.items[0]?.description).toContain('需要业务确认')
  })

  test('目标表自身的同名列不算证据，避免自证', () => {
    const tables: FieldLineageTable[] = [{ schema: 'public', name: 'child', columns: ['parent_id'] }]
    expect(analyzeFieldLineage({ target, tables }).items).toEqual([])
  })

  test('长历史 SQL 的摘要有上限，避免把整条语句塞进证据列表', () => {
    const sql = `select parent_id from child -- ${'x'.repeat(500)}`
    const result = analyzeFieldLineage({ target, histories: [{ id: 'h', sql }] })
    expect(result.items[0]?.sqlSnippet?.length).toBeLessThanOrEqual(241)
    expect(result.items[0]?.sqlSnippet?.endsWith('…')).toBe(true)
  })

  test('多种证据同时存在时计数按可信度分别累加', () => {
    const tables: FieldLineageTable[] = [
      {
        schema: 'public',
        name: 'child',
        columns: ['parent_id'],
        foreignKeys: [{ name: 'fk', column: 'parent_id', refTable: 'parent', refColumn: 'id' }]
      },
      { schema: 'public', name: 'sibling', columns: ['parent_id'] }
    ]
    const views: FieldLineageView[] = [
      { schema: 'public', name: 'v', ddl: 'CREATE VIEW v AS SELECT parent_id FROM child' }
    ]
    const result = analyzeFieldLineage({ target, tables, views, histories: [{ id: 'h', sql: 'select parent_id from child' }] })
    expect(result.counts.certain).toBe(1)
    expect(result.counts.likely).toBe(2)
    expect(result.counts.possible).toBe(1)
    expect(result.items).toHaveLength(4)
  })

  test('每条证据 id 唯一，列表可直接用于渲染 key', () => {
    const tables: FieldLineageTable[] = [
      {
        schema: 'public',
        name: 'child',
        columns: ['parent_id'],
        foreignKeys: [{ name: 'fk', column: 'parent_id', refTable: 'parent', refColumn: 'id' }]
      },
      { schema: 'public', name: 'sibling', columns: ['parent_id'] }
    ]
    const ids = analyzeFieldLineage({ target, tables }).items.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
