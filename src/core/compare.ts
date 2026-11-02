/**
 * 结构比较与数据比较（P5）。
 *
 * 只消费已经读好的快照，不连数据库、不执行 SQL。
 * 输出顺序必须稳定：同样的两份快照，无论对象原来怎么排，差异和 SQL 都一样。
 * 危险语句只生成、只标记，调用方不得据此自动执行。
 */

import type { DdlDialect } from './ddl'
import type {
  ColumnDescription,
  TableDescription
} from './model'
import type {
  CheckConstraintDescription,
  ForeignKeyDescription,
  IndexDescription,
  UniqueConstraintDescription
} from './metadata'

export type CompareDialect = DdlDialect

export interface CompareSource {
  readonly connectionId: string
  readonly schema: string | null
}

export interface SchemaObjectDefinition {
  readonly schema: string | null
  readonly name: string
  readonly definition: string | null
}

export interface RoutineDefinition extends SchemaObjectDefinition {
  readonly kind: 'function' | 'procedure'
}

/**
 * 快照中的表：在 describeTable 结果上补齐 schema 与名字。
 * 不同连接的 adapter id 编码不同，比较只能用 schema + 名字对齐。
 */
export interface SnapshotTable extends TableDescription {
  readonly schema: string | null
  readonly name: string
}

export interface SchemaSnapshot {
  readonly source: CompareSource
  readonly tables: readonly SnapshotTable[]
  readonly views: readonly SchemaObjectDefinition[]
  readonly routines: readonly RoutineDefinition[]
}

export type SchemaChange =
  | {
      readonly kind: 'create'
      readonly objectType: string
      readonly target: string
      readonly statements: readonly string[]
      readonly destructive: false
    }
  | {
      readonly kind: 'drop'
      readonly objectType: string
      readonly target: string
      readonly statements: readonly string[]
      readonly destructive: true
    }
  | {
      readonly kind: 'alter'
      readonly objectType: string
      readonly target: string
      readonly statements: readonly string[]
      readonly destructive: boolean
    }

export interface StructureDiff {
  readonly changes: readonly SchemaChange[]
  readonly statements: readonly string[]
  /** 仅供审阅。包含 drop、删列、类型变化；调用方不得自动执行。 */
  readonly destructive: boolean
  /**
   * 本次比较**没能覆盖**或**无法生成合法 SQL** 的地方。
   *
   * 存在的理由：宁可在界面上写清"这几处没比/没生成"，也不要让用户从
   * "没有差异"里得出"结构一致"的错误结论。
   */
  readonly warnings: readonly string[]
}

export interface DataCompareKey {
  readonly columns: readonly string[]
}

export interface DataCompareRow {
  readonly key: Readonly<Record<string, string | number | boolean | null>>
  readonly values: Readonly<Record<string, string | number | boolean | null>>
}

export type DataRowStatus = 'source-only' | 'target-only' | 'different' | 'same'

export interface DataRowDiff {
  readonly status: DataRowStatus
  readonly key: Readonly<Record<string, string | number | boolean | null>>
  readonly columns: readonly string[]
  /**
   * 值差异的可读摘要（仅 `different` 行有）。长值不展示全文，
   * 只给 `<长度, 哈希>`，用户据此能判断"确实变了"而不必把大文本搬进界面。
   */
  readonly valueChanges?: readonly {
    readonly column: string
    readonly source: string
    readonly target: string
  }[]
}

export interface DataSyncPlan {
  readonly insertCount: number
  readonly updateCount: number
  readonly deleteCount: number
  readonly statements: readonly string[]
  readonly destructive: boolean
  readonly warnings: readonly string[]
}

/** 数据比较请求：两张表的节点 id + 比较键。未给键时用源表主键。 */
export interface DataCompareRequest {
  readonly sourceTableNodeId: string
  readonly targetTableNodeId: string
  readonly keyColumns?: readonly string[]
  /** 单侧最多读取的行数，超过则拒绝比较（不静默截断）。 */
  readonly maxRows?: number
}

export interface DataCompareResult {
  readonly keyColumns: readonly string[]
  readonly rows: readonly DataRowDiff[]
  readonly plan: DataSyncPlan
}

/** 长值展示上限：超过时 UI 只显示长度和哈希，不展示全文。 */
export const LONG_VALUE_CHARS = 120

/**
 * 把单元格值折叠成可展示的摘要。用 FNV-1a 32 位做指纹：纯 JS、确定、
 * 浏览器与 Node 都能跑。它只用于“肉眼区分两个长值”，不用于判等——判等始终比全文。
 */
export function summarizeValue(value: string | number | boolean | null): string {
  if (value === null) return 'NULL'
  const text = String(value)
  if (text.length <= LONG_VALUE_CHARS) return text
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `<${text.length} 字符, fnv1a:${hash.toString(16).padStart(8, '0')}>`
}

type ColumnMap = ReadonlyMap<string, ColumnDescription>

export function diffSchema(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  dialect: CompareDialect
): StructureDiff {
  if (dialect !== 'sqlite' && dialect !== 'postgresql') {
    throw new Error(`不支持的比较方言：${String(dialect)}`)
  }
  const tableChanges = diffTables(source, target, dialect)
  const changes = [
    ...tableChanges,
    ...diffNamedObjects('view', source.views, target.views, 'CREATE VIEW'),
    ...diffRoutines(source.routines, target.routines)
  ]
  return {
    changes,
    statements: changes.flatMap((change) => change.statements),
    destructive: changes.some((change) => change.destructive),
    warnings: diffWarnings(source, target, dialect)
  }
}

export function compareDataRows(
  sourceRows: readonly DataCompareRow[],
  targetRows: readonly DataCompareRow[],
  key: DataCompareKey,
  dialect: CompareDialect,
  table: { readonly schema?: string | null; readonly name: string }
): { readonly rows: readonly DataRowDiff[]; readonly plan: DataSyncPlan } {
  if (key.columns.length === 0) throw new Error('数据比较必须指定唯一列，禁止按行号比较')
  const source = indexRows(sourceRows, key.columns, '源端')
  const target = indexRows(targetRows, key.columns, '目标端')
  const keys = [...new Set([...source.keys(), ...target.keys()])].sort(compareEncodedKeys)
  const rows: DataRowDiff[] = []
  const statements: string[] = []
  let insertCount = 0
  let updateCount = 0
  let deleteCount = 0
  for (const encoded of keys) {
    const left = source.get(encoded)
    const right = target.get(encoded)
    if (left !== undefined && right === undefined) {
      insertCount += 1
      rows.push({ status: 'source-only', key: left.key, columns: [] })
      statements.push(insertSql(table, left, dialect))
    } else if (left === undefined && right !== undefined) {
      deleteCount += 1
      rows.push({ status: 'target-only', key: right.key, columns: [] })
      statements.push(deleteSql(table, right.key, key.columns, dialect))
    } else if (left !== undefined && right !== undefined) {
      const columns = changedColumns(left.values, right.values)
      rows.push({
        status: columns.length === 0 ? 'same' : 'different',
        key: left.key,
        columns,
        ...(columns.length === 0
          ? {}
          : {
              valueChanges: columns.map((column) => ({
                column,
                source: summarizeValue(left.values[column] ?? null),
                target: summarizeValue(right.values[column] ?? null)
              }))
            })
      })
      if (columns.length > 0) {
        updateCount += 1
        statements.push(updateSql(table, left, columns, key.columns, dialect))
      }
    }
  }
  const warnings = deleteCount > 0
    ? [`同步会删除目标端 ${deleteCount} 行，执行前必须单独确认。`]
    : []
  return {
    rows,
    plan: {
      insertCount,
      updateCount,
      deleteCount,
      statements,
      destructive: deleteCount > 0,
      warnings
    }
  }
}

/**
 * 说明这次比较**没覆盖**什么，以及哪些差异无法自动生成 SQL。
 *
 * 没有它的话，界面上"0 处差异"会被读成"结构一致"，而实际上视图定义、
 * 例程、SQLite 的类型变更压根没参与比较——这是最误导人的失败方式。
 */
function diffWarnings(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  dialect: CompareDialect
): string[] {
  const warnings: string[] = []
  const unknownViews = [...source.views, ...target.views].filter((view) => view.definition === null)
  if (unknownViews.length > 0) {
    const names = [...new Set(unknownViews.map((view) => objectLabel(view)))].sort()
    warnings.push(`有 ${names.length} 个视图没读到定义（${names.join(', ')}），视图定义变更未参与比较。`)
  }
  if (source.routines.length === 0 && target.routines.length === 0) {
    warnings.push('例程（函数/存储过程）未参与比较：当前驱动没有提供例程清单。')
  }
  if (dialect === 'sqlite') {
    const left = indexBy(source.tables, tableKey)
    const right = indexBy(target.tables, tableKey)
    const rebuild: string[] = []
    for (const key of sortedKeys(left, right)) {
      const from = left.get(key)
      const to = right.get(key)
      if (from === undefined || to === undefined) continue
      const toColumns = columnMap(to)
      for (const column of from.columns) {
        const other = toColumns.get(column.name)
        if (other !== undefined && columnSignature(column) !== columnSignature(other)) {
          rebuild.push(`${tableLabel(from)}.${column.name}`)
        }
      }
    }
    if (rebuild.length > 0) {
      warnings.push(`SQLite 不支持 ALTER COLUMN TYPE：${rebuild.join(', ')} 的类型/约束差异需要手工重建表。`)
    }
  }
  return warnings
}

/** 给界面用的一句话覆盖范围说明，避免"没比过"被当成"没问题"。 */
export function describeCoverage(source: SchemaSnapshot, target: SchemaSnapshot): string {
  const definitionKnown = [...source.views, ...target.views].every((view) => view.definition !== null)
  const parts = [
    `表 ${source.tables.length} → ${target.tables.length}`,
    `视图 ${source.views.length} → ${target.views.length}${definitionKnown ? '' : '（定义未读取）'}`,
    `例程 ${source.routines.length + target.routines.length === 0 ? '未提供' : `${source.routines.length} → ${target.routines.length}`}`
  ]
  return `比较范围：${parts.join('，')}。`
}

function diffTables(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  dialect: CompareDialect
): SchemaChange[] {
  const left = indexBy(source.tables, tableKey)
  const right = indexBy(target.tables, tableKey)
  const changes: SchemaChange[] = []
  for (const key of sortedKeys(left, right)) {
    const from = left.get(key)
    const to = right.get(key)
    const name = tableLabel(from ?? to)
    if (from !== undefined && to === undefined) {
      // 新表必须连约束一起建：只发 CREATE TABLE 会把索引、外键、唯一、CHECK
      // 全部丢掉，而目标端"看起来建好了"，这是最难被发现的一类差异丢失。
      const empty: SnapshotTable = { ...from, columns: [], indexes: [], foreignKeys: [], uniqueConstraints: [], checks: [] }
      changes.push(createChange('table', name, [createTableSql(from, dialect), ...constraintSql(qualified(from), from, empty)]))
    } else if (from === undefined && to !== undefined) {
      changes.push(dropChange('table', name, `DROP TABLE ${qualified(to)}`))
    } else if (from !== undefined && to !== undefined) {
      const statements = alterTableSql(from, to, dialect)
      if (statements.length > 0) {
        changes.push({
          kind: 'alter',
          objectType: 'table',
          target: name,
          statements,
          destructive: statements.some((sql) => /\bDROP COLUMN\b|\bTYPE\b/.test(sql))
        })
      }
    }
  }
  return changes
}

function diffNamedObjects(
  objectType: string,
  source: readonly SchemaObjectDefinition[],
  target: readonly SchemaObjectDefinition[],
  createKeyword: string
): SchemaChange[] {
  const left = indexBy(source, objectKey)
  const right = indexBy(target, objectKey)
  const changes: SchemaChange[] = []
  for (const key of sortedKeys(left, right)) {
    const from = left.get(key)
    const to = right.get(key)
    const name = objectLabel(from ?? to)
    if (from !== undefined && to === undefined) {
      // 定义未知时无法生成创建语句：跳过并由 warnings 说明"没读到定义"，
      // 不能因为缺一段 DDL 就把整次比较变成异常。
      if (from.definition === null) continue
      changes.push(createChange(objectType, name, [definitionSql(createKeyword, from)]))
    } else if (from === undefined && to !== undefined) {
      changes.push(dropChange(objectType, name, `DROP ${objectType.toUpperCase()} ${qualified(to)}`))
    } else if (
      from !== undefined && to !== undefined &&
      // 任一侧没读到定义时无法判断是否变化，宁可不报差异也不生成删除重建。
      from.definition !== null && to.definition !== null &&
      normalizeSql(from.definition) !== normalizeSql(to.definition)
    ) {
      changes.push({
        kind: 'alter',
        objectType,
        target: name,
        statements: [`DROP ${objectType.toUpperCase()} ${qualified(to)}`, definitionSql(createKeyword, from)],
        destructive: true
      })
    }
  }
  return changes
}

/**
 * 例程按 kind + schema + name 对齐。definition 必须是完整的 CREATE 语句
 * （PG 的 pg_get_functiondef 即是），这里不再拼 CREATE 前缀。
 */
function diffRoutines(
  source: readonly RoutineDefinition[],
  target: readonly RoutineDefinition[]
): SchemaChange[] {
  const keyOf = (r: RoutineDefinition): string => `${r.kind}:${r.schema ?? ''}.${r.name}`
  const left = indexBy(source, keyOf)
  const right = indexBy(target, keyOf)
  const changes: SchemaChange[] = []
  for (const key of sortedKeys(left, right)) {
    const from = left.get(key)
    const to = right.get(key)
    const label = key
    const drop = (r: RoutineDefinition): string => `DROP ${r.kind.toUpperCase()} ${qualified(r)}`
    const create = (r: RoutineDefinition): string => {
      if (r.definition === null || r.definition.trim() === '') throw new Error(`缺少例程 ${r.name} 的定义`)
      return r.definition.trim()
    }
    if (from !== undefined && to === undefined) {
      changes.push(createChange('routine', label, [create(from)]))
    } else if (from === undefined && to !== undefined) {
      changes.push(dropChange('routine', label, drop(to)))
    } else if (from !== undefined && to !== undefined && normalizeSql(from.definition) !== normalizeSql(to.definition)) {
      changes.push({ kind: 'alter', objectType: 'routine', target: label, statements: [drop(to), create(from)], destructive: true })
    }
  }
  return changes
}

function alterTableSql(source: SnapshotTable, target: SnapshotTable, dialect: CompareDialect): string[] {
  const table = qualified(source)
  const from = columnMap(source)
  const to = columnMap(target)
  const statements: string[] = []
  for (const name of [...from.keys()].sort()) {
    const left = mustGet(from, name)
    const right = to.get(name)
    if (right === undefined) statements.push(`ALTER TABLE ${table} ADD COLUMN ${columnSql(left)}`)
    else if (columnSignature(left) !== columnSignature(right)) {
      // SQLite 没有 ALTER COLUMN ... TYPE 语法，生成出来必然执行失败。
      // 这类变更只能手工重建表，因此这里不生成语句，由 diffWarnings 明确告知。
      if (dialect !== 'sqlite') {
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${quote(name)} TYPE ${safeType(left.typeName)}`)
      }
    }
  }
  for (const name of [...to.keys()].sort()) {
    if (!from.has(name)) statements.push(`ALTER TABLE ${table} DROP COLUMN ${quote(name)}`)
  }
  statements.push(...constraintSql(table, source, target))
  return statements
}

function constraintSql(table: string, source: SnapshotTable, target: SnapshotTable): string[] {
  const statements: string[] = []
  for (const index of missing(source.indexes ?? [], target.indexes ?? [], indexKey)) {
    statements.push(
      `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quote(index.name)} ON ${table} (${list(index.columns)})${index.predicate ? ` WHERE ${index.predicate}` : ''}`
    )
  }
  for (const key of missing(source.foreignKeys ?? [], target.foreignKeys ?? [], foreignKeySignature)) {
    statements.push(
      `ALTER TABLE ${table} ADD CONSTRAINT ${quote(key.name ?? 'fk')} FOREIGN KEY (${list(key.columns)}) REFERENCES ${qualified({ schema: key.referencedSchema ?? source.schema, name: key.referencedTable })} (${list(key.referencedColumns)})`
    )
  }
  for (const unique of missing(source.uniqueConstraints ?? [], target.uniqueConstraints ?? [], uniqueSignature)) {
    statements.push(`ALTER TABLE ${table} ADD CONSTRAINT ${quote(unique.name ?? 'uq')} UNIQUE (${list(unique.columns)})`)
  }
  for (const check of missing(source.checks ?? [], target.checks ?? [], checkSignature)) {
    statements.push(`ALTER TABLE ${table} ADD CONSTRAINT ${quote(check.name ?? 'ck')} CHECK (${check.expression})`)
  }
  return statements
}

function createTableSql(table: SnapshotTable, dialect: CompareDialect): string {
  const columns = [...table.columns]
    .sort((a, b) => (a.primaryKeyOrdinal ?? 999) - (b.primaryKeyOrdinal ?? 999) || a.name.localeCompare(b.name))
    .map((column) => columnSql(column))
  const primary = table.columns
    .filter((column) => column.primaryKeyOrdinal !== null)
    .sort((a, b) => (a.primaryKeyOrdinal ?? 0) - (b.primaryKeyOrdinal ?? 0))
  if (primary.length > 0) columns.push(`PRIMARY KEY (${list(primary.map((column) => column.name))})`)
  return `CREATE TABLE ${qualified(table)} (${columns.join(', ')})`
}

function columnSql(column: ColumnDescription): string {
  let sql = `${quote(column.name)} ${safeType(column.typeName)}`
  if (!column.nullable) sql += ' NOT NULL'
  if (column.defaultValue !== null) sql += ` DEFAULT ${safeType(column.defaultValue)}`
  return sql
}

function insertSql(
  table: { readonly schema?: string | null; readonly name: string },
  row: DataCompareRow,
  dialect: CompareDialect
): string {
  const columns = Object.keys(row.values).sort()
  return `INSERT INTO ${qualified(table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map((column) => literal(row.values[column], dialect)).join(', ')})`
}

function updateSql(
  table: { readonly schema?: string | null; readonly name: string },
  row: DataCompareRow,
  columns: readonly string[],
  keyColumns: readonly string[],
  dialect: CompareDialect
): string {
  const assignments = [...columns].sort().map((column) => `${quote(column)} = ${literal(row.values[column], dialect)}`)
  return `UPDATE ${qualified(table)} SET ${assignments.join(', ')} WHERE ${whereSql(row.key, keyColumns, dialect)}`
}

function deleteSql(
  table: { readonly schema?: string | null; readonly name: string },
  key: Readonly<Record<string, string | number | boolean | null>>,
  keyColumns: readonly string[],
  dialect: CompareDialect
): string {
  return `DELETE FROM ${qualified(table)} WHERE ${whereSql(key, keyColumns, dialect)}`
}

function whereSql(
  key: Readonly<Record<string, string | number | boolean | null>>,
  columns: readonly string[],
  dialect: CompareDialect
): string {
  return columns.map((column) => {
    const value = key[column]
    return value === null ? `${quote(column)} IS NULL` : `${quote(column)} = ${literal(value, dialect)}`
  }).join(' AND ')
}

function literal(value: string | number | boolean | null | undefined, dialect: CompareDialect): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return dialect === 'postgresql' ? (value ? 'TRUE' : 'FALSE') : (value ? '1' : '0')
  return `'${value.replaceAll("'", "''")}'`
}

function changedColumns(
  source: Readonly<Record<string, string | number | boolean | null>>,
  target: Readonly<Record<string, string | number | boolean | null>>
): string[] {
  return [...new Set([...Object.keys(source), ...Object.keys(target)])]
    .filter((column) => source[column] !== target[column])
    .sort()
}

/** 键按列逐个比较：NULL 最前，数字按数值，其余按字符串。结果确定且符合直觉。 */
function compareEncodedKeys(a: string, b: string): number {
  const left = JSON.parse(a) as (string | number | boolean | null)[]
  const right = JSON.parse(b) as (string | number | boolean | null)[]
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? null
    const y = right[i] ?? null
    if (x === y) continue
    if (x === null) return -1
    if (y === null) return 1
    if (typeof x === 'number' && typeof y === 'number') return x - y
    const order = String(x) < String(y) ? -1 : 1
    return order
  }
  return 0
}

function indexRows(
  rows: readonly DataCompareRow[],
  columns: readonly string[],
  side: string
): Map<string, DataCompareRow> {
  const indexed = new Map<string, DataCompareRow>()
  for (const row of rows) {
    const missing = columns.filter((column) => !Object.hasOwn(row.key, column))
    if (missing.length > 0) throw new Error(`${side}比较键缺少列：${missing.join(', ')}`)
    const encoded = JSON.stringify(columns.map((column) => row.key[column]))
    if (indexed.has(encoded)) throw new Error(`${side}比较键重复，不能按非唯一列比较`)
    indexed.set(encoded, row)
  }
  return indexed
}

function columnMap(table: TableDescription): ColumnMap {
  return new Map([...table.columns].sort((a, b) => a.name.localeCompare(b.name)).map((column) => [column.name, column]))
}

function columnSignature(column: ColumnDescription): string {
  return JSON.stringify([column.typeName.trim().toUpperCase(), column.nullable, column.defaultValue, column.primaryKeyOrdinal])
}

function indexKey(index: IndexDescription): string {
  return JSON.stringify([index.name, index.unique, index.columns, index.predicate, index.expression])
}

function foreignKeySignature(key: ForeignKeyDescription): string {
  return JSON.stringify([key.columns, key.referencedSchema, key.referencedTable, key.referencedColumns, key.onUpdate, key.onDelete])
}

function uniqueSignature(unique: UniqueConstraintDescription): string {
  return JSON.stringify(unique.columns)
}

function checkSignature(check: CheckConstraintDescription): string {
  return JSON.stringify([check.name, check.expression])
}

function missing<T>(source: readonly T[], target: readonly T[], signature: (value: T) => string): T[] {
  const have = new Set(target.map(signature))
  return source.filter((value) => !have.has(signature(value))).sort((a, b) => signature(a).localeCompare(signature(b)))
}

function indexBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T> {
  const indexed = new Map<string, T>()
  for (const value of values) {
    const key = keyOf(value)
    if (indexed.has(key)) throw new Error(`快照中的对象重复：${key}`)
    indexed.set(key, value)
  }
  return indexed
}

function sortedKeys<T>(left: ReadonlyMap<string, T>, right: ReadonlyMap<string, T>): string[] {
  return [...new Set([...left.keys(), ...right.keys()])].sort()
}

function tableKey(table: SnapshotTable): string {
  return `${table.schema ?? ''}.${table.name}`
}

function objectKey(object: SchemaObjectDefinition): string {
  return `${object.schema ?? ''}.${object.name}`
}

function tableLabel(table: SnapshotTable | undefined): string {
  if (table === undefined) throw new Error('比较对象缺失')
  return tableKey(table)
}

function objectLabel(object: SchemaObjectDefinition | undefined): string {
  if (object === undefined) throw new Error('比较对象缺失')
  return objectKey(object)
}

function qualified(object: { readonly schema?: string | null; readonly name: string }): string {
  return object.schema ? `${quote(object.schema)}.${quote(object.name)}` : quote(object.name)
}

function definitionSql(keyword: string, object: SchemaObjectDefinition): string {
  if (object.definition === null || object.definition.trim() === '') {
    throw new Error(`缺少 ${object.name} 的定义，不能生成创建语句`)
  }
  const definition = object.definition.trim()
  /*
   * 两种驱动的定义形态不同，必须都兼容：
   *   - PostgreSQL 的 `pg_get_viewdef` 只返回查询体（`SELECT ...`），需要补
   *     `CREATE VIEW <name> AS` 头部；
   *   - SQLite 的 `sqlite_master.sql` 返回**完整 DDL**（`CREATE VIEW ... AS SELECT ...`），
   *     再补一次头部会变成 `CREATE VIEW "v" AS CREATE VIEW v AS SELECT ...`，
   *     直接是语法错误。
   *
   * 所以先看定义本身有没有 CREATE 头部：有就原样使用（它就是一条可执行 DDL），
   * 没有才补。这比让每个驱动各自剥前缀更稳——剥前缀要小心视图名里出现 "AS"。
   */
  if (/^\s*CREATE\s/i.test(definition)) return definition
  return `${keyword} ${qualified(object)} AS ${definition}`
}

function normalizeSql(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function list(columns: readonly string[]): string {
  return columns.map(quote).join(', ')
}

function quote(value: string): string {
  if (value.trim() === '' || value.includes('\0')) throw new Error('标识符不能为空')
  return `"${value.replaceAll('"', '""')}"`
}

function safeType(value: string): string {
  const typeName = value.trim()
  if (typeName === '' || /[;]|--|\/\*|\*\//.test(typeName)) throw new Error('类型名包含不安全的 SQL 片段')
  return typeName
}

function mustGet(columns: ColumnMap, name: string): ColumnDescription {
  const column = columns.get(name)
  if (column === undefined) throw new Error(`列不存在：${name}`)
  return column
}

function createChange(objectType: string, target: string, statements: readonly string[]): SchemaChange {
  return { kind: 'create', objectType, target, statements, destructive: false }
}

function dropChange(objectType: string, target: string, statement: string): SchemaChange {
  return { kind: 'drop', objectType, target, statements: [statement], destructive: true }
}
