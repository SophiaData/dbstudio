/**
 * 字段血缘分析。
 *
 * 证据分档与 dbx 保持一致，避免把"猜测"当"事实"：
 *   - certain：数据库声明了外键约束；
 *   - likely/possible：视图定义同时引用了目标表与目标列；
 *   - possible：仅同名列，属于推测，必须由人确认。
 *
 * 查询历史作为一类证据由调用方传入；本模块只做分析，不访问数据库。
 */

export type FieldLineageConfidence = 'certain' | 'likely' | 'possible'
export type FieldLineageKind = 'foreignKey' | 'viewReference' | 'historyReference' | 'sameName'
export type FieldLineageDirection = 'incoming' | 'outgoing' | 'reference'

export interface FieldLineageTarget {
  readonly schema?: string
  readonly table: string
  readonly column: string
}

export interface FieldLineageForeignKey {
  readonly name: string
  readonly column: string
  readonly refSchema?: string
  readonly refTable: string
  readonly refColumn: string
}

export interface FieldLineageTable {
  readonly schema?: string
  readonly name: string
  readonly columns: readonly string[]
  readonly foreignKeys?: readonly FieldLineageForeignKey[]
}

export interface FieldLineageView {
  readonly schema?: string
  readonly name: string
  readonly ddl: string
}

export interface FieldLineageHistory {
  readonly id: string
  readonly sql: string
}

export interface FieldLineageItem {
  readonly id: string
  readonly kind: FieldLineageKind
  readonly confidence: FieldLineageConfidence
  readonly direction: FieldLineageDirection
  readonly title: string
  readonly description: string
  readonly schema?: string
  readonly table?: string
  readonly column?: string
  readonly sqlSnippet?: string
}

export interface FieldLineageResult {
  readonly target: FieldLineageTarget
  readonly items: readonly FieldLineageItem[]
  readonly counts: { readonly certain: number; readonly likely: number; readonly possible: number }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 标识符是否在 SQL 文本中作为一个完整标识符出现（含引号形式）。 */
export function identifierInSql(sql: string, identifier: string): boolean {
  const escaped = escapeRegExp(identifier)
  const quoted = [`"${escaped}"`, `\`${escaped}\``, `\\[${escaped}\\]`]
  const pattern = `(?:${quoted.join('|')}|(?:^|[^\\w$])${escaped}(?![\\w$]))`
  return new RegExp(pattern, 'i').test(sql)
}

function sameIdentifier(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

function schemaMatches(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return true
  return sameIdentifier(left, right)
}

function foreignKeyLineage(
  target: Required<Pick<FieldLineageTarget, 'table' | 'column'>> & FieldLineageTarget,
  tables: readonly FieldLineageTable[]
): FieldLineageItem[] {
  const items: FieldLineageItem[] = []
  for (const table of tables) {
    for (const key of table.foreignKeys ?? []) {
      const isOwner =
        sameIdentifier(table.name, target.table) &&
        schemaMatches(table.schema, target.schema) &&
        sameIdentifier(key.column, target.column)
      if (isOwner) {
        items.push({
          id: `fk-out:${table.schema ?? ''}:${table.name}:${key.name}:${key.column}`,
          kind: 'foreignKey',
          confidence: 'certain',
          direction: 'outgoing',
          title: `${table.name}.${key.column} → ${key.refTable}.${key.refColumn}`,
          description: `外键 ${key.name} 指向 ${key.refTable}.${key.refColumn}`,
          schema: table.schema,
          table: key.refTable,
          column: key.refColumn
        })
      }
      const isReferenced =
        sameIdentifier(key.refTable, target.table) &&
        sameIdentifier(key.refColumn, target.column) &&
        schemaMatches(key.refSchema, target.schema)
      if (isReferenced) {
        items.push({
          id: `fk-in:${table.schema ?? ''}:${table.name}:${key.name}:${key.column}`,
          kind: 'foreignKey',
          confidence: 'certain',
          direction: 'incoming',
          title: `${table.name}.${key.column} → ${target.table}.${target.column}`,
          description: `外键 ${key.name} 引用了当前字段`,
          schema: table.schema,
          table: table.name,
          column: key.column
        })
      }
    }
  }
  return items
}

function viewLineage(
  target: FieldLineageTarget,
  views: readonly FieldLineageView[]
): FieldLineageItem[] {
  const items: FieldLineageItem[] = []
  for (const view of views) {
    // 只出现目标列、没出现目标表时仍可能是同名列引用，按 possible 记录并说明；
    // 两者都不出现才跳过。
    if (!schemaMatches(view.schema, target.schema)) continue
    const hasTable = identifierInSql(view.ddl, target.table)
    const hasColumn = identifierInSql(view.ddl, target.column)
    if (!hasTable && !hasColumn) continue
    const items_confidence: FieldLineageConfidence = hasTable && hasColumn ? 'likely' : 'possible'
    items.push({
      id: `view:${view.schema ?? ''}:${view.name}:${target.column}`,
      kind: 'viewReference',
      confidence: items_confidence,
      direction: 'reference',
      title: `视图 ${view.name} 引用了 ${target.table}.${target.column}`,
      description:
        hasTable && hasColumn
          ? '视图定义同时包含目标表与目标列'
          : '视图定义只包含同名字段或同名表，需要人工确认',
      schema: view.schema,
      table: view.name,
      sqlSnippet: view.ddl.length > 240 ? `${view.ddl.slice(0, 240)}…` : view.ddl
    })
  }
  return items
}

function historyLineage(
  target: FieldLineageTarget,
  histories: readonly FieldLineageHistory[]
): FieldLineageItem[] {
  const items: FieldLineageItem[] = []
  for (const entry of histories) {
    if (!identifierInSql(entry.sql, target.table)) continue
    if (!identifierInSql(entry.sql, target.column)) continue
    items.push({
      id: `history:${entry.id}`,
      kind: 'historyReference',
      confidence: 'likely',
      direction: 'reference',
      title: `历史 SQL 引用了 ${target.table}.${target.column}`,
      description: '来自本机执行过的查询，不代表全部使用方',
      sqlSnippet: entry.sql.length > 240 ? `${entry.sql.slice(0, 240)}…` : entry.sql
    })
  }
  return items
}

function sameNameLineage(
  target: FieldLineageTarget,
  tables: readonly FieldLineageTable[]
): FieldLineageItem[] {
  const items: FieldLineageItem[] = []
  for (const table of tables) {
    if (sameIdentifier(table.name, target.table) && schemaMatches(table.schema, target.schema)) continue
    const column = table.columns.find((candidate) => sameIdentifier(candidate, target.column))
    if (!column) continue
    items.push({
      id: `same:${table.schema ?? ''}:${table.name}:${column}`,
      kind: 'sameName',
      confidence: 'possible',
      direction: 'reference',
      title: `${table.name}.${column} 与当前字段同名`,
      description: '仅按名称推测，需要业务确认',
      schema: table.schema,
      table: table.name,
      column
    })
  }
  return items
}

/** 汇总各来源的证据，按置信度分档统计。 */
export function analyzeFieldLineage(options: {
  target: FieldLineageTarget
  tables?: readonly FieldLineageTable[]
  views?: readonly FieldLineageView[]
  histories?: readonly FieldLineageHistory[]
}): FieldLineageResult {
  const items = [
    ...foreignKeyLineage(options.target, options.tables ?? []),
    ...viewLineage(options.target, options.views ?? []),
    ...historyLineage(options.target, options.histories ?? []),
    ...sameNameLineage(options.target, options.tables ?? [])
  ]
  return {
    target: options.target,
    items,
    counts: {
      certain: items.filter((item) => item.confidence === 'certain').length,
      likely: items.filter((item) => item.confidence === 'likely').length,
      possible: items.filter((item) => item.confidence === 'possible').length
    }
  }
}
