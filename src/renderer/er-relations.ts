/**
 * ER 图的**纯关系逻辑**：从 `TableDescription.foreignKeys` 推出可绘制的边。
 *
 * ============================================================================
 * 为什么单独一个文件（而不是全部塞进 `er-diagram.ts`）
 * ============================================================================
 * 这部分**没有 DOM**，只有「数据 → 数据」的映射。它是整张图里最容易出错的
 * 部分（跨 schema 匹配、复合外键列配对、悬空引用），却也是最容易验证的部分。
 *
 * 把它单独拎出来有三个好处：
 *   1. **可以纯函数测试**：不需要 Electron、不需要 DOM、不需要真数据库。
 *   2. **判定口径只有一处**：什么叫"一条边"、什么叫"匹配不上"，
 *      只在这里定义一次；渲染层只负责画，不再重复判断。
 *   3. **刷新不重复累积**：边的计算本身是纯函数，
 *      渲染层每次都从空 DOM 重建（见 `er-diagram.ts` 的 `container.replaceChildren()`）。
 *
 * ============================================================================
 * 核心语义：undefined ≠ 空数组（见 `core/metadata.ts` 文件头）
 * ============================================================================
 * `TableDescription.foreignKeys` 有三态：
 *   - `undefined` → 驱动**没有提供**这类信息 → 图上必须说"未提供元数据"，
 *     **绝不能**说成"无关系"。否则用户会以为表真的没有外键。
 *   - `[]`        → 驱动支持且**确认没有** → "无关系"。
 *   - `[...]`     → 有外键 → 画线。
 *
 * 这个区分在 `metadataAvailability()` 里有官方口径，本文件直接复用它，
 * 不自己再写一遍 `=== undefined` 的判断。
 *
 * ============================================================================
 * 跨 schema 引用的处理
 * ============================================================================
 * `ForeignKeyDescription.referencedSchema` 为 `null` 表示**与本表同 schema**。
 * 匹配被引用表时，不能只按表名找——PG 里 `public.users` 与 `audit.users` 是两张表，
 * 按名字找会连错线（这正是 `core/model.ts` 点名的、比报错更严重的错误）。
 *
 * 本表自己的 schema 在 `TableDescription` 里**没有**字段直接给出——
 * 它只能从 `ObjectRef` 的 id 编码里解析。所以匹配顺序是：
 *   1. 先用本表 id 解析出 schema（解析不出就视为"这个方言没有 schema 概念"，
 *      例如 SQLite 的 `table:users`）；
 *   2. `referencedSchema === null` → 目标 schema = 本表 schema；
 *   3. `referencedSchema !== null` → 目标 schema = 该值（跨 schema 引用）；
 *   4. 在候选表里按 **schema + 表名** 匹配，匹配不到就是**悬空引用**。
 *
 * 悬空引用（目标表没被画进图里，比如被 30 张表上限截掉了）不画线，
 * 但**要计入统计并单独报告**——用户需要知道"这里本来有 3 条关系，
 * 其中 1 条因为目标表不在图里没画出来"，否则会以为数据库真的只有 2 条关系。
 */

import type { ForeignKeyDescription, MetadataAvailability } from '../core/metadata'
import { metadataAvailability } from '../core/metadata'
import type { ObjectRef, TableDescription } from '../core/model'

/**
 * 一条边的两个端点（表级）。
 *
 * 端点只描述"哪张表"，**不**描述"哪一列"——
 * 复合外键（本表 (a,b) → 目标 (x,y)）的列配对放在 `columnPairs` 里，
 * 这样一条边天然支持复合外键，不需要为复合情形另开一套类型。
 */
export interface ErRelationEndpoint {
  /** 端点所属表在图上的 id（即 `ObjectRef.id`，带连接归属前缀）。 */
  readonly tableId: string
  /** 端点所属表的展示名。 */
  readonly tableName: string
  /** 端点所在 schema；该方言无 schema 概念时为 null。 */
  readonly schema: string | null
}

/** 复合外键里的一对列：本表列 → 被引用列。 */
export interface ErRelationColumnPair {
  /** 本表（外键持有方）的列名。 */
  readonly column: string
  /** 被引用表的列名。 */
  readonly referencedColumn: string
}

/** 一条可绘制的边。 */
export interface ErRelation {
  /** 边的稳定 id：用于 `data-er-edge` 属性与 GUI 测试断言。 */
  readonly id: string
  /** 外键约束名；SQLite 不暴露表级约束名，此处为 null。 */
  readonly constraintName: string | null
  /** 本表（外键持有方）端点。 */
  readonly from: ErRelationEndpoint
  /** 被引用表端点。 */
  readonly to: ErRelationEndpoint
  /** 列配对；单列外键长度为 1，复合外键按约束内顺序排列。 */
  readonly columnPairs: readonly ErRelationColumnPair[]
  /** 是否为复合外键。 */
  readonly composite: boolean
  /** ON UPDATE 动作；无则 null。 */
  readonly onUpdate: string | null
  /** ON DELETE 动作；无则 null。 */
  readonly onDelete: string | null
}

/** 一条外键没能画出来的原因。 */
export type ErRelationSkipReason =
  /** 被引用的表不在图里（被上限截掉、读取失败、或本来就不存在）。 */
  | 'target-missing'
  /** 匹配到多个同名候选，无法确定是哪一张（宁可不断，也不画错）。 */
  | 'target-ambiguous'
  /** 外键的列 / 被引用列数量不一致，无法配对。 */
  | 'column-count-mismatch'
  /** 外键没有列信息（空数组），无法定位端点。 */
  | 'no-columns'

/** 一条被跳过的外键。 */
export interface ErRelationSkip {
  readonly reason: ErRelationSkipReason
  readonly sourceTableId: string
  readonly sourceTableName: string
  readonly referencedTable: string
  readonly referencedSchema: string | null
  /** 约束名；SQLite 为 null。 */
  readonly constraintName: string | null
  /** 人类可读的说明，用于图上的说明行。 */
  readonly detail: string
}

/** 一张表的外键元数据状态。`unavailable` 与 `empty` 必须分开。 */
export type ErMetadataState = MetadataAvailability

/** 整个 ER 图的关系层结论。 */
export interface ErRelationSummary {
  /** 全图的外键元数据状态：任一表 `undefined` 即为 `unavailable`。 */
  readonly metadataState: ErMetadataState
  /** 可绘制的边。 */
  readonly relations: readonly ErRelation[]
  /** 没能画出来的外键。 */
  readonly skipped: readonly ErRelationSkip[]
  /** 已知的外键总数（= relations.length + skipped.length）。 */
  readonly totalForeignKeys: number
  /** 是否至少有一条可绘制的边。 */
  readonly hasRelations: boolean
}

/** 一张表在图上的必要信息。 */
export interface ErTableInput {
  readonly ref: ObjectRef
  readonly desc: TableDescription
}

/**
 * 从对象 id 推断 schema。
 *
 * id 编码是**方言私有**的（`drivers/sqlite/ids.ts` 与 `drivers/postgresql/ids.ts`
 * 各有一套），渲染层不应该 import 驱动目录——那会让 UI 与具体方言纠缠。
 *
 * 但我们又必须知道 schema（跨 schema 外键要靠它匹配），所以这里做一件
 * **只读、不猜**的事：从 id 里解析出 schema 段，解析不出来就返回 null。
 *
 * 已知编码：
 *   SQLite  `table:<name>`            → 无 schema 概念，表名中的点不是分隔符
 *   PG      `table:<schema>.<name>`    → schema = 第一个未转义的 `.` 之前
 *
 * 主进程会把连接归属前缀加到 id 上（`connection:<id>|table:...`），
 * 所以要先切掉 `|` 之后的部分。标识符片段里的 `\.` 是字面点，`\\` 是
 * 字面反斜杠；不能拿未转义的首个 `.` 直接切。
 *
 * 为什么"解析不出就是 null"而不是"抛错"：渲染层拿到的 id 可能有第三种格式
 * （未来新增的方言），此时画图应当降级为"按名字匹配"而不是整张图失败。
 */
export function inferSchemaFromObjectId(objectId: string, dialectId: string | null = null): string | null {
  // SQLite 没有 schema；`table:with.dot` 里的点是表名的一部分，不能猜成 schema。
  if (dialectId === 'sqlite') return null
  const bar = objectId.indexOf('|')
  const afterScope = bar === -1 ? objectId : objectId.slice(bar + 1)
  const separator = afterScope.indexOf(':')
  if (separator <= 0) return null
  const prefix = afterScope.slice(0, separator)
  if (prefix !== 'table' && prefix !== 'view') return null
  const payload = afterScope.slice(separator + 1)
  if (payload === '') return null

  const dot = firstUnescapedDot(payload)
  if (dot <= 0) return null
  const schema = unescapeIdPart(payload.slice(0, dot))
  return schema === '' ? null : schema
}

function firstUnescapedDot(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const ch = value.charAt(index)
    if (ch === '\\') {
      index += 1
      continue
    }
    if (ch === '.') return index
  }
  return -1
}

/** 反转义 id 片段里的 `\.` / `\\`（与各驱动的 `escapePart` 对称）。 */
function unescapeIdPart(part: string): string {
  let out = ''
  for (let index = 0; index < part.length; index += 1) {
    const ch = part.charAt(index)
    if (ch === '\\') {
      const next = part.charAt(index + 1)
      if (next === '') {
        out += ch
        continue
      }
      out += next
      index += 1
      continue
    }
    out += ch
  }
  return out
}

/**
 * 候选表的匹配视图。
 *
 * ===== 为什么匹配要分"精确"和"折叠"两轮 =====
 * PostgreSQL 里未加引号的标识符会被折叠成小写，但**加了引号的大小写敏感名字**
 * （`"Users"` 与 `"users"`）是两张**不同的表**。
 *
 * 所以：先用**精确**名字找（`Users` 只匹配 `Users`）；
 * 精确找不到时，才退化到大小写不敏感匹配，并且**必须唯一**——
 * 命中多个候选说明我们无法确定是哪一张，此时**不画线**并如实上报，
 * 而不是随便挑一个画上去（画错线比不画线危险得多）。
 */
interface Candidate {
  readonly table: ErTableInput
  readonly schema: string | null
}

/** schema 是否"算作同一个"。null 表示这一侧没有 schema 概念/信息。 */
function schemaMatches(candidateSchema: string | null, targetSchema: string | null): boolean {
  if (candidateSchema === null || targetSchema === null) return true
  return candidateSchema.toLowerCase() === targetSchema.toLowerCase()
}

/**
 * 计算整张图的关系。
 *
 * @param tables 图上的表（含已读到的结构描述）。顺序决定边的稳定顺序。
 */
export function computeErRelations(
  tables: readonly ErTableInput[],
  options: { readonly dialectId?: string | null } = {}
): ErRelationSummary {
  const relations: ErRelation[] = []
  const skipped: ErRelationSkip[] = []
  let totalForeignKeys = 0
  let anyUnavailable = false

  const candidates: Candidate[] = tables.map((table) => ({
    table,
    schema: inferSchemaFromObjectId(table.ref.id, options.dialectId ?? null)
  }))

  for (const table of tables) {
    const foreignKeys = table.desc.foreignKeys
    const state = metadataAvailability(foreignKeys)
    if (state === 'unavailable') {
      anyUnavailable = true
      // undefined 意味着"驱动没提供"，**不是**"没有外键"。
      // 这里**不**把它算进 totalForeignKeys：那个数字的语义是
      // "已知的外键条数"，而我们对这张表根本不知道。
      continue
    }

    const sourceSchema = inferSchemaFromObjectId(table.ref.id, options.dialectId ?? null)
    for (const foreignKey of foreignKeys ?? []) {
      totalForeignKeys += 1
      const built = buildRelation(table, foreignKey, sourceSchema, candidates)
      if (built.relation !== null) relations.push(built.relation)
      else if (built.skip !== null) skipped.push(built.skip)
    }
  }

  const metadataState: ErMetadataState = anyUnavailable
    ? 'unavailable'
    : totalForeignKeys === 0
      ? 'empty'
      : 'present'

  return {
    metadataState,
    relations,
    skipped,
    totalForeignKeys,
    hasRelations: relations.length > 0
  }
}

/**
 * 把一条外键解析成一条边。
 *
 * 返回 `relation`（可画）或 `skip`（画不了 + 原因），二者互斥。
 */
function buildRelation(
  source: ErTableInput,
  foreignKey: ForeignKeyDescription,
  sourceSchema: string | null,
  candidates: readonly Candidate[]
): { relation: ErRelation | null; skip: ErRelationSkip | null } {
  const columns = foreignKey.columns
  const referencedColumns = foreignKey.referencedColumns

  const skipWith = (
    reason: ErRelationSkipReason,
    detail: string
  ): { relation: null; skip: ErRelationSkip } => ({
    relation: null,
    skip: {
      reason,
      sourceTableId: source.ref.id,
      sourceTableName: source.ref.name,
      referencedTable: foreignKey.referencedTable,
      referencedSchema: foreignKey.referencedSchema,
      constraintName: foreignKey.name,
      detail
    }
  })

  if (columns.length === 0) {
    return skipWith(
      'no-columns',
      `外键「${describeConstraint(foreignKey)}」没有列信息，无法定位端点`
    )
  }

  if (columns.length !== referencedColumns.length) {
    return skipWith(
      'column-count-mismatch',
      `外键「${describeConstraint(foreignKey)}」的列数不一致` +
        `（本表 ${columns.length} 个，被引用 ${referencedColumns.length} 个）`
    )
  }

  // 目标 schema：null = 与本表同 schema（契约规定）。
  const targetSchema =
    foreignKey.referencedSchema === null ? sourceSchema : foreignKey.referencedSchema
  const qualified = formatQualifiedName(targetSchema, foreignKey.referencedTable)

  // 第一轮：精确名字。
  const exact = candidates.filter(
    (candidate) =>
      candidate.table.ref.name === foreignKey.referencedTable &&
      schemaMatches(candidate.schema, targetSchema)
  )
  // 第二轮：大小写不敏感（仅当精确匹配失败）。
  const folded =
    exact.length === 0
      ? candidates.filter(
          (candidate) =>
            candidate.table.ref.name.toLowerCase() === foreignKey.referencedTable.toLowerCase() &&
            schemaMatches(candidate.schema, targetSchema)
        )
      : exact

  if (folded.length === 0) {
    return skipWith(
      'target-missing',
      `外键「${describeConstraint(foreignKey)}」引用的表「${qualified}」不在图内`
    )
  }
  if (folded.length > 1) {
    return skipWith(
      'target-ambiguous',
      `外键「${describeConstraint(foreignKey)}」引用的表「${qualified}」匹配到多个候选，无法确定`
    )
  }

  const target = folded[0]
  if (target === undefined) {
    return skipWith(
      'target-missing',
      `外键「${describeConstraint(foreignKey)}」引用的表「${qualified}」不在图内`
    )
  }

  const columnPairs: ErRelationColumnPair[] = []
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index]
    const referencedColumn = referencedColumns[index]
    if (column === undefined || referencedColumn === undefined) continue
    columnPairs.push({ column, referencedColumn })
  }

  return {
    relation: {
      id: relationId(source.ref.id, foreignKey, columnPairs[0]?.column ?? ''),
      constraintName: foreignKey.name,
      from: {
        tableId: source.ref.id,
        tableName: source.ref.name,
        schema: sourceSchema
      },
      to: {
        tableId: target.table.ref.id,
        tableName: target.table.ref.name,
        schema: target.schema
      },
      columnPairs,
      composite: columnPairs.length > 1,
      onUpdate: foreignKey.onUpdate,
      onDelete: foreignKey.onDelete
    },
    skip: null
  }
}

/** 约束的展示名：有名用名，无名用「表 → 被引用表」。 */
function describeConstraint(foreignKey: ForeignKeyDescription): string {
  if (foreignKey.name !== null && foreignKey.name !== '') return foreignKey.name
  return `${foreignKey.referencedTable} 的外键`
}

/** `schema.table` 的展示形式；无 schema 时只给表名。 */
export function formatQualifiedName(schema: string | null, table: string): string {
  return schema === null ? table : `${schema}.${table}`
}

/** 边的稳定 id：源表 + 约束名 + 首列。约束名可能为 null，用列名兜底。 */
function relationId(sourceTableId: string, foreignKey: ForeignKeyDescription, column: string): string {
  const constraint = foreignKey.name === null || foreignKey.name === '' ? 'fk' : foreignKey.name
  return `${sourceTableId}::${constraint}::${column}`
}

/**
 * ER 图的关系层状态。
 *
 * 三种主要状态必须能被一眼区分（外加一种"有外键但一条都没画出来"的中间态）：
 *   - `relations`   → 有关系（图上画出了至少一条线）
 *   - `none`        → 无关系（驱动**确认**这些表确实没有外键）
 *   - `unavailable` → 未提供元数据（**不是**"无外键"，是"我们不知道"）
 *   - `undrawn`     → 知道有外键，但全部没能画出来（如目标表不在图内）
 */
export type ErRelationStatusKind = 'relations' | 'none' | 'unavailable' | 'undrawn'

/** 状态判定结果。 */
export interface ErRelationStatus {
  readonly kind: ErRelationStatusKind
  /** 图上说明行的文案。 */
  readonly text: string
  /** 是否需要用醒目的告警配色。 */
  readonly warn: boolean
}

/**
 * 判定关系层状态并给出文案。
 *
 * 注意 `metadataState === 'unavailable'` 的优先级最高：
 * 只要有**任何一张表**没提供外键元数据，整张图就只能说"不完整"——
 * 因为我们无法证明剩下那些表真的没有外键。
 */
export function erRelationStatus(summary: ErRelationSummary): ErRelationStatus {
  if (summary.metadataState === 'unavailable') {
    const known = summary.totalForeignKeys
    const suffix =
      known > 0
        ? `（已知的 ${known} 条关系已画出，其余表未提供外键元数据）`
        : '，图中无法确定表之间的关系'
    return {
      kind: 'unavailable',
      text: `⚠ 未提供外键元数据：部分表未返回 foreignKeys${suffix}`,
      warn: true
    }
  }
  if (summary.relations.length === 0) {
    if (summary.totalForeignKeys > 0) {
      return {
        kind: 'undrawn',
        text: `⚠ 有 ${summary.totalForeignKeys} 条外键，但没有一条能画出来（目标表不在图内）`,
        warn: true
      }
    }
    return {
      kind: 'none',
      text: '无关系：这些表没有外键（驱动已确认）',
      warn: false
    }
  }
  const skippedSuffix =
    summary.skipped.length === 0 ? '' : `，另有 ${summary.skipped.length} 条外键未能画出`
  return {
    kind: 'relations',
    text: `有关系：${summary.relations.length} 条外键关系${skippedSuffix}`,
    warn: summary.skipped.length > 0
  }
}

/**
 * 状态 token，供 `data-er-status` 属性与 GUI 测试直接断言。
 */
export function relationStatusToken(summary: ErRelationSummary): ErRelationStatusKind {
  return erRelationStatus(summary).kind
}
