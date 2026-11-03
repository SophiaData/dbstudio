/**
 * 结构化 DDL 预览。
 *
 * 该模块只把结构化操作转换成可审阅的 SQL 和风险说明，不执行 SQL，也不替代
 * 驱动适配器的最终校验。渲染层可以先展示 preview，再把同一份结构化操作交给
 * 驱动执行，避免 UI 直接拼接 DDL。
 */

import type { ColumnCreateSpec, TableCreateSpec } from './model'

export type DdlDialect = 'sqlite' | 'postgresql' | 'mysql'

export interface TableTarget {
  readonly name: string
  readonly schema?: string
}

export type TableChange =
  | { readonly kind: 'add-column'; readonly column: ColumnCreateSpec }
  | { readonly kind: 'drop-column'; readonly columnName: string }
  | { readonly kind: 'rename-column'; readonly oldName: string; readonly newName: string }
  | {
      readonly kind: 'alter-column'
      readonly columnName: string
      readonly typeName?: string
      readonly nullable?: boolean
      readonly defaultValue?: string | null
    }

export interface IndexCreateSpec {
  readonly name: string
  readonly unique: boolean
  readonly columns: readonly string[]
  readonly predicate?: string
}

export interface ForeignKeyCreateSpec {
  readonly name?: string
  readonly columns: readonly string[]
  readonly referencedSchema?: string
  readonly referencedTable: string
  readonly referencedColumns: readonly string[]
  readonly onUpdate?: string
  readonly onDelete?: string
}

export type DdlOperation =
  | { readonly kind: 'create-table'; readonly target: TableTarget; readonly spec: TableCreateSpec }
  | { readonly kind: 'alter-table'; readonly target: TableTarget; readonly changes: readonly TableChange[] }
  | { readonly kind: 'create-index'; readonly target: TableTarget; readonly index: IndexCreateSpec }
  | { readonly kind: 'create-foreign-key'; readonly target: TableTarget; readonly foreignKey: ForeignKeyCreateSpec }
  | {
      readonly kind: 'drop-object'
      readonly objectType: DropObjectType
      readonly target: TableTarget
    }

export interface DdlPreview {
  readonly statements: readonly string[]
  readonly warnings: readonly string[]
  readonly requiresTransaction: boolean
  readonly destructive: boolean
}

export type DropObjectType = 'table' | 'view' | 'index' | 'trigger' | 'schema'

const ACTIONS = new Set(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'])

export function previewDdl(operation: DdlOperation, dialect: DdlDialect): DdlPreview {
  if (dialect !== 'sqlite' && dialect !== 'postgresql' && dialect !== 'mysql') {
    throw new Error(`不支持的 DDL 方言：${String(dialect)}`)
  }

  switch (operation.kind) {
    case 'create-table':
      return previewCreateTable(operation.target, operation.spec, dialect)
    case 'alter-table':
      return previewAlterTable(operation.target, operation.changes, dialect)
    case 'create-index':
      return previewCreateIndex(operation.target, operation.index, dialect)
    case 'create-foreign-key':
      return previewCreateForeignKey(operation.target, operation.foreignKey, dialect)
    case 'drop-object':
      return previewDropObject(operation.objectType, operation.target, dialect)
  }
}

function previewCreateTable(
  target: TableTarget,
  spec: TableCreateSpec,
  dialect: DdlDialect
): DdlPreview {
  const name = target.name || spec.name
  if (name !== spec.name && spec.name.trim() !== '') {
    throw new Error('create-table 的 target.name 必须与 spec.name 一致')
  }
  if (spec.columns.length === 0) throw new Error('建表至少需要一列')

  const primaryKeys = spec.columns
    .filter((column) => column.primaryKeyOrdinal !== undefined)
    .sort((a, b) => (a.primaryKeyOrdinal ?? 0) - (b.primaryKeyOrdinal ?? 0))
  const singlePrimaryKey = primaryKeys.length === 1 ? primaryKeys[0] : undefined
  const definitions = spec.columns.map((column) =>
    columnDefinition(
      column,
      dialect,
      singlePrimaryKey?.name === column.name && column.autoIncrement === true
    )
  )
  const sqliteInlinePrimaryKey =
    dialect === 'sqlite' && singlePrimaryKey !== undefined && singlePrimaryKey.autoIncrement === true
  if (primaryKeys.length > 0 && !sqliteInlinePrimaryKey) {
    definitions.push(`PRIMARY KEY (${primaryKeys.map((column) => quote(column.name, dialect)).join(', ')})`)
  }

  const warnings = primaryKeys.length === 0 ? ['未定义主键：后续在线编辑可能无法安全定位行。'] : []
  return {
    statements: [
      `CREATE TABLE ${qualified(target.schema, name, dialect)} (\n  ${definitions.join(',\n  ')}\n)`
    ],
    warnings,
    requiresTransaction: dialect === 'sqlite' && definitions.length > 1,
    destructive: false
  }
}

function previewAlterTable(
  target: TableTarget,
  changes: readonly TableChange[],
  dialect: DdlDialect
): DdlPreview {
  if (changes.length === 0) throw new Error('alter-table 至少需要一个变更')
  const table = qualified(target.schema, target.name, dialect)
  const statements: string[] = []
  const warnings: string[] = []
  let destructive = false
  let needsRebuild = false

  for (const change of changes) {
    switch (change.kind) {
      case 'add-column':
        statements.push(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition(change.column, dialect, false)}`)
        break
      case 'drop-column':
        statements.push(`ALTER TABLE ${table} DROP COLUMN ${quoteNonEmpty(change.columnName, '列名', dialect)}`)
        warnings.push(`删除列「${change.columnName}」会永久丢失该列数据。`)
        destructive = true
        needsRebuild = dialect === 'sqlite'
        break
      case 'rename-column':
        statements.push(
          `ALTER TABLE ${table} RENAME COLUMN ${quoteNonEmpty(change.oldName, '旧列名', dialect)} TO ${quoteNonEmpty(change.newName, '新列名', dialect)}`
        )
        break
      case 'alter-column':
        if (dialect === 'postgresql') {
          if (change.typeName !== undefined) {
            statements.push(`ALTER TABLE ${table} ALTER COLUMN ${quoteNonEmpty(change.columnName, '列名', dialect)} TYPE ${safeFragment(change.typeName, '类型名')}`)
          }
          if (change.nullable !== undefined) {
            statements.push(
              `ALTER TABLE ${table} ALTER COLUMN ${quoteNonEmpty(change.columnName, '列名', dialect)} ${change.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`
            )
          }
          if (change.defaultValue !== undefined) {
            statements.push(
              change.defaultValue === null
                ? `ALTER TABLE ${table} ALTER COLUMN ${quoteNonEmpty(change.columnName, '列名', dialect)} DROP DEFAULT`
                : `ALTER TABLE ${table} ALTER COLUMN ${quoteNonEmpty(change.columnName, '列名', dialect)} SET DEFAULT ${safeFragment(change.defaultValue, '默认值')}`
            )
          }
        } else if (dialect === 'mysql') {
          /*
           * MySQL 的 ALTER COLUMN 只改默认值，改类型/可空必须用 MODIFY COLUMN，
           * 而 MODIFY 要求重复**完整**列定义。没有类型名就无法生成合法语句，
           * 这里明确告警而不是生成一条半截 SQL。
           */
          if (change.typeName === undefined) {
            warnings.push(`MySQL 修改列「${change.columnName}」需要同时提供类型名；本次未生成语句。`)
            break
          }
          let definition = `${quoteNonEmpty(change.columnName, '列名', dialect)} ${safeFragment(change.typeName, '类型名')}`
          if (change.nullable === false) definition += ' NOT NULL'
          else if (change.nullable === true) definition += ' NULL'
          if (change.defaultValue !== undefined) {
            definition += change.defaultValue === null
              ? ' DEFAULT NULL'
              : ` DEFAULT ${safeFragment(change.defaultValue, '默认值')}`
          }
          statements.push(`ALTER TABLE ${table} MODIFY COLUMN ${definition}`)
        } else {
          statements.push(`-- SQLite 需要重建表才能安全修改列「${change.columnName}」`)
          if (change.typeName !== undefined) safeFragment(change.typeName, '类型名')
          if (change.defaultValue !== undefined && change.defaultValue !== null) safeFragment(change.defaultValue, '默认值')
          needsRebuild = true
        }
        if (change.typeName !== undefined) {
          warnings.push(`修改列「${change.columnName}」的类型可能导致数据转换或截断。`)
          destructive = true
        }
        break
    }
  }

  if (needsRebuild) warnings.push('SQLite 将重建表：创建临时表、迁移数据并替换原表；请先确认备份与外键影响。')
  return {
    statements,
    warnings,
    // MySQL 的 DDL 会隐式提交，不能承诺"放在同一事务里"。
    requiresTransaction: dialect !== 'mysql' && (needsRebuild || statements.length > 1),
    destructive
  }
}

function previewCreateIndex(target: TableTarget, index: IndexCreateSpec, dialect: DdlDialect): DdlPreview {
  if (index.columns.length === 0) throw new Error('索引至少需要一列')
  if (dialect === 'mysql' && index.predicate !== undefined) {
    throw new Error('MySQL 不支持部分索引（CREATE INDEX ... WHERE），已拒绝生成语句')
  }
  const columns = uniqueNames(index.columns, '索引列')
  const predicate = index.predicate === undefined ? '' : ` WHERE ${safeFragment(index.predicate, '索引条件')}`
  // MySQL 的索引名不能带 schema 前缀，只有表名可以限定。
  const indexName = dialect === 'mysql' ? quote(index.name, dialect) : qualified(target.schema, index.name, dialect)
  return {
    statements: [
      `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${indexName} ON ${qualified(target.schema, target.name, dialect)} (${columns.map((column) => quote(column, dialect)).join(', ')})${predicate}`
    ],
    warnings: [],
    requiresTransaction: false,
    destructive: false
  }
}

function previewCreateForeignKey(
  target: TableTarget,
  foreignKey: ForeignKeyCreateSpec,
  dialect: DdlDialect
): DdlPreview {
  if (foreignKey.columns.length === 0 || foreignKey.columns.length !== foreignKey.referencedColumns.length) {
    throw new Error('外键列与被引用列必须非空且数量一致')
  }
  const columns = uniqueNames(foreignKey.columns, '外键列')
  const referencedColumns = uniqueNames(foreignKey.referencedColumns, '被引用列')
  const constraint = foreignKey.name ? `CONSTRAINT ${quote(foreignKey.name, dialect)} ` : ''
  const actions = [foreignKey.onUpdate, foreignKey.onDelete]
  for (const action of actions) {
    if (action !== undefined && !ACTIONS.has(action.toUpperCase())) throw new Error(`不支持的外键动作：${action}`)
  }
  const statement = [
    `ALTER TABLE ${qualified(target.schema, target.name, dialect)} ADD ${constraint}FOREIGN KEY (${columns.map((column) => quote(column, dialect)).join(', ')})`,
    `REFERENCES ${qualified(foreignKey.referencedSchema, foreignKey.referencedTable, dialect)} (${referencedColumns.map((column) => quote(column, dialect)).join(', ')})`,
    foreignKey.onUpdate ? `ON UPDATE ${foreignKey.onUpdate.toUpperCase()}` : '',
    foreignKey.onDelete ? `ON DELETE ${foreignKey.onDelete.toUpperCase()}` : ''
  ].filter(Boolean).join(' ')
  return {
    statements: [statement],
    warnings: dialect === 'sqlite' ? ['SQLite 不能通过普通 ALTER TABLE 直接追加外键，实际执行通常需要重建表。'] : [],
    requiresTransaction: dialect === 'sqlite',
    destructive: false
  }
}

function previewDropObject(
  objectType: DropObjectType,
  target: TableTarget,
  dialect: DdlDialect
): DdlPreview {
  const keyword = objectType.toUpperCase()
  const statement = `DROP ${keyword} ${qualified(target.schema, target.name, dialect)}`
  const warnings = objectType === 'table'
    ? [`删除表「${target.name}」会永久删除其结构和全部数据。`]
    : objectType === 'schema'
      ? [`删除 schema「${target.name}」可能级联删除其中的全部对象。`]
      : []
  if (dialect === 'sqlite' && objectType === 'schema') throw new Error('SQLite 不支持 DROP SCHEMA')
  return { statements: [statement], warnings, requiresTransaction: false, destructive: true }
}

function columnDefinition(column: ColumnCreateSpec, dialect: DdlDialect, inlineAutoIncrement: boolean): string {
  let typeName = safeFragment(column.typeName, '类型名')
  if (inlineAutoIncrement) {
    if (dialect === 'sqlite') {
      if (!/^INTEGER$/i.test(typeName)) throw new Error('SQLite 自增只能用于 INTEGER 主键')
    } else if (dialect === 'postgresql') {
      const serialType = {
        SMALLINT: 'SMALLSERIAL',
        INT2: 'SMALLSERIAL',
        INTEGER: 'SERIAL',
        INT: 'SERIAL',
        INT4: 'SERIAL',
        BIGINT: 'BIGSERIAL',
        INT8: 'BIGSERIAL'
      }[typeName.toUpperCase()]
      if (serialType !== undefined) typeName = serialType
      else if (!/^((SMALL|BIG)?SERIAL)$/i.test(typeName)) {
        throw new Error('PostgreSQL 自增只能用于整数类型或 SERIAL 类型')
      }
    } else if (!/^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)\b/i.test(typeName)) {
      throw new Error('MySQL 自增只能用于整数类型（TINYINT / SMALLINT / MEDIUMINT / INT / BIGINT）')
    }
  }
  let sql = `${quoteNonEmpty(column.name, '列名', dialect)} ${typeName}`
  if (column.nullable === false) sql += ' NOT NULL'
  if (column.defaultValue !== undefined) sql += ` DEFAULT ${safeFragment(column.defaultValue, '默认值')}`
  if (column.primaryKeyOrdinal !== undefined && column.primaryKeyOrdinal < 1) throw new Error('主键序号必须从 1 开始')
  if (inlineAutoIncrement) {
    if (dialect === 'sqlite') sql += ' PRIMARY KEY AUTOINCREMENT'
    else if (dialect === 'mysql') sql += ' AUTO_INCREMENT'
  }
  return sql
}

function qualified(schema: string | undefined, name: string, dialect: DdlDialect): string {
  const object = quoteNonEmpty(name, '对象名', dialect)
  return schema === undefined || schema === '' ? object : `${quote(schema, dialect)}.${object}`
}

function quoteNonEmpty(value: string, label: string, dialect: DdlDialect): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) throw new Error(`${label}不能为空或包含 NUL`)
  return quote(value.trim(), dialect)
}

function quote(value: string, dialect: DdlDialect): string {
  if (dialect === 'mysql') return `\`${value.replaceAll('`', '``')}\``
  return `"${value.replaceAll('"', '""')}"`
}

function safeFragment(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}不能为空`)
  const trimmed = value.trim()
  if (trimmed.includes('\0') || trimmed.includes(';') || trimmed.includes('--') || trimmed.includes('/*') || trimmed.includes('*/')) {
    throw new Error(`${label}包含不安全的 SQL 片段`)
  }
  return trimmed
}

function uniqueNames(values: readonly string[], label: string): string[] {
  const out = values.map((value) => value.trim())
  if (out.some((value) => value === '')) throw new Error(`${label}不能为空`)
  const seen = new Set(out)
  if (seen.size !== out.length) throw new Error(`${label}不能重复`)
  return out
}
