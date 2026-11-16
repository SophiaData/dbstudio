import { describe, expect, test } from 'vitest'

import { previewDdl } from './ddl'
import type { DdlOperation } from './ddl'

function createTable(
  columns: { name: string; typeName: string; primaryKeyOrdinal?: number; autoIncrement?: boolean; defaultValue?: string; nullable?: boolean }[],
  name = 'items',
  schema?: string
): DdlOperation {
  return { kind: 'create-table', target: { name, ...(schema === undefined ? {} : { schema }) }, spec: { name, columns } }
}

describe('DDL 预览：方言与标识符', () => {
  test('不支持的方言直接拒绝', () => {
    expect(() => previewDdl(createTable([{ name: 'id', typeName: 'INTEGER' }]), 'oracle' as never)).toThrow(
      /不支持的 DDL 方言/
    )
  })

  // MySQL 用反引号、其它用双引号；内部的引号字符必须双写，否则表名会截断语句。
  test('标识符按方言加引号并双写内部引号', () => {
    const mysql = previewDdl(createTable([{ name: 'id', typeName: 'INTEGER' }], 'we`ird'), 'mysql')
    expect(mysql.statements[0]).toContain('`we``ird`')

    const sqlite = previewDdl(createTable([{ name: 'id', typeName: 'INTEGER' }], 'we"ird'), 'sqlite')
    expect(sqlite.statements[0]).toContain('"we""ird"')
  })

  test('带 schema 时生成限定名', () => {
    const preview = previewDdl(createTable([{ name: 'id', typeName: 'INTEGER' }], 'items', 'app'), 'postgresql')
    expect(preview.statements[0]).toContain('"app"."items"')
  })

  test('空对象名被拒绝', () => {
    expect(() => previewDdl(createTable([{ name: 'id', typeName: 'INTEGER' }], '  '), 'sqlite')).toThrow(/不能为空/)
  })
})

describe('DDL 预览：建表', () => {
  test('没有列时拒绝建表', () => {
    expect(() => previewDdl(createTable([]), 'sqlite')).toThrow(/至少需要一列/)
  })

  test('target.name 与 spec.name 不一致时拒绝，避免建错表', () => {
    expect(() =>
      previewDdl(
        { kind: 'create-table', target: { name: 'a' }, spec: { name: 'b', columns: [{ name: 'id', typeName: 'INTEGER' }] } },
        'sqlite'
      )
    ).toThrow(/必须与 spec.name 一致/)
  })

  test('column 定义包含名称与类型，且可重复执行得到同样文本', () => {
    const operation = createTable([{ name: 'id', typeName: 'INTEGER' }, { name: 'title', typeName: 'TEXT' }])
    const first = previewDdl(operation, 'sqlite')
    const second = previewDdl(operation, 'sqlite')
    expect(first).toEqual(second)
    expect(first.statements[0]).toContain('"id" INTEGER')
    expect(first.statements[0]).toContain('"title" TEXT')
  })

  test('单列自增主键在 SQLite 上使用内联 AUTOINCREMENT', () => {
    const preview = previewDdl(
      createTable([{ name: 'id', typeName: 'INTEGER', primaryKeyOrdinal: 1, autoIncrement: true }]),
      'sqlite'
    )
    expect(preview.statements[0]).toMatch(/AUTOINCREMENT/i)
    expect(preview.statements[0]).not.toMatch(/PRIMARY KEY \(/)
  })

  // SQLite 的 AUTOINCREMENT 只对 INTEGER 主键成立；接受别的类型会生成跑不通的 DDL。
  test('SQLite 自增用在非 INTEGER 类型上被拒绝', () => {
    expect(() =>
      previewDdl(createTable([{ name: 'id', typeName: 'TEXT', primaryKeyOrdinal: 1, autoIncrement: true }]), 'sqlite')
    ).toThrow(/只能用于 INTEGER 主键/)
  })

  test('PostgreSQL 自增把整数类型映射成对应 SERIAL', () => {
    const big = previewDdl(
      createTable([{ name: 'id', typeName: 'BIGINT', primaryKeyOrdinal: 1, autoIncrement: true }]),
      'postgresql'
    )
    expect(big.statements[0]).toMatch(/BIGSERIAL/i)

    const small = previewDdl(
      createTable([{ name: 'id', typeName: 'SMALLINT', primaryKeyOrdinal: 1, autoIncrement: true }]),
      'postgresql'
    )
    expect(small.statements[0]).toMatch(/SMALLSERIAL/i)
  })

  test('PostgreSQL 自增用在非整数类型上被拒绝', () => {
    expect(() =>
      previewDdl(createTable([{ name: 'id', typeName: 'TEXT', primaryKeyOrdinal: 1, autoIncrement: true }]), 'postgresql')
    ).toThrow(/只能用于整数类型或 SERIAL/)
  })

  test('多列主键按序号排序后写进表级约束', () => {
    const preview = previewDdl(
      createTable([
        { name: 'b', typeName: 'INTEGER', primaryKeyOrdinal: 2 },
        { name: 'a', typeName: 'INTEGER', primaryKeyOrdinal: 1 }
      ]),
      'sqlite'
    )
    expect(preview.statements[0]).toMatch(/PRIMARY KEY \("a", "b"\)/)
  })
})

describe('DDL 预览：注入面校验', () => {
  // typeName / defaultValue 是原始 SQL 文本，DDL 不支持参数绑定，只能靠校验拦住。
  test('类型名里的语句分隔与注释符被拒绝', () => {
    for (const typeName of ['INTEGER; DROP TABLE x', 'INTEGER -- x', 'INTEGER /* x */', 'TEXT\0']) {
      expect(() => previewDdl(createTable([{ name: 'id', typeName }]), 'sqlite')).toThrow(/不安全的 SQL 片段/)
    }
  })

  test('空类型名被拒绝', () => {
    expect(() => previewDdl(createTable([{ name: 'id', typeName: '   ' }]), 'sqlite')).toThrow(/不能为空/)
  })

  test('默认值里的语句分隔被拒绝', () => {
    expect(() =>
      previewDdl(createTable([{ name: 'x', typeName: 'TEXT', defaultValue: "1; DROP TABLE y" }]), 'sqlite')
    ).toThrow(/不安全的 SQL 片段/)
  })

  test('合法默认值被写进定义', () => {
    const preview = previewDdl(createTable([{ name: 'x', typeName: 'INTEGER', defaultValue: '0' }]), 'sqlite')
    expect(preview.statements[0]).toMatch(/DEFAULT 0/)
  })

  test('列名为空或含 NUL 被拒绝', () => {
    expect(() => previewDdl(createTable([{ name: ' ', typeName: 'INTEGER' }]), 'sqlite')).toThrow(/不能为空/)
    expect(() => previewDdl(createTable([{ name: 'a\0b', typeName: 'INTEGER' }]), 'sqlite')).toThrow(/NUL/)
  })

  test('重复列名被拒绝', () => {
    expect(() =>
      previewDdl(createTable([{ name: 'id', typeName: 'INTEGER' }, { name: 'id', typeName: 'TEXT' }]), 'sqlite')
    ).toThrow(/不能重复/)
  })
})

describe('DDL 预览：其它操作', () => {
  test('建索引区分唯一与非唯一，并带上列顺序', () => {
    const unique = previewDdl(
      { kind: 'create-index', target: { name: 'items' }, index: { name: 'idx', unique: true, columns: ['a', 'b'] } },
      'sqlite'
    )
    expect(unique.statements[0]).toMatch(/CREATE UNIQUE INDEX/)
    expect(unique.statements[0]).toContain('("a", "b")')

    const plain = previewDdl(
      { kind: 'create-index', target: { name: 'items' }, index: { name: 'idx', unique: false, columns: ['a'] } },
      'sqlite'
    )
    expect(plain.statements[0]).toMatch(/CREATE INDEX/)
    expect(plain.statements[0]).not.toMatch(/UNIQUE/)
  })

  test('索引没有列时被拒绝', () => {
    expect(() =>
      previewDdl(
        { kind: 'create-index', target: { name: 'items' }, index: { name: 'idx', unique: false, columns: [] } },
        'sqlite'
      )
    ).toThrow()
  })

  test('外键引用列数与本地列数不一致时被拒绝', () => {
    expect(() =>
      previewDdl(
        {
          kind: 'create-foreign-key',
          target: { name: 'child' },
          foreignKey: { columns: ['a', 'b'], referencedTable: 'parent', referencedColumns: ['id'] }
        },
        'postgresql'
      )
    ).toThrow()
  })

  test('合法外键生成 REFERENCES 子句', () => {
    const preview = previewDdl(
      {
        kind: 'create-foreign-key',
        target: { name: 'child' },
        foreignKey: { columns: ['parent_id'], referencedTable: 'parent', referencedColumns: ['id'] }
      },
      'postgresql'
    )
    expect(preview.statements[0]).toContain('REFERENCES')
    expect(preview.statements[0]).toContain('"parent"')
  })

  test('删除操作按对象类型生成对应 DROP 语句', () => {
    const table = previewDdl({ kind: 'drop-object', objectType: 'table', target: { name: 'items' } }, 'sqlite')
    expect(table.statements[0]).toMatch(/DROP TABLE/)
    const view = previewDdl({ kind: 'drop-object', objectType: 'view', target: { name: 'v' } }, 'sqlite')
    expect(view.statements[0]).toMatch(/DROP VIEW/)
  })

  // 破坏性操作必须被标记，UI 据此要求二次确认。
  test('删除操作被标记为破坏性且需要事务', () => {
    const preview = previewDdl({ kind: 'drop-object', objectType: 'table', target: { name: 'items' } }, 'sqlite')
    expect(preview.destructive).toBe(true)
    // DROP 在多数方言里是隐式提交，不需要（也无法）包在事务里。
    expect(preview.requiresTransaction).toBe(false)
  })

  test('普通建表不被标记为破坏性', () => {
    const preview = previewDdl(createTable([{ name: 'id', typeName: 'INTEGER' }]), 'sqlite')
    expect(preview.destructive).toBe(false)
  })
})
