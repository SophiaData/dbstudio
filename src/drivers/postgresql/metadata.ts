/**
 * PostgreSQL 结构元数据读取。
 *
 * 与 `sqlite/metadata.ts` 同一职责、同一形状：把方言专属的 catalog 查询
 * 翻译成 `core/metadata.ts` 的**跨方言契约**，供 `describeTable` 一次返回。
 *
 * ===== 为什么不新增 RPC =====
 *
 * 见 `core/metadata.ts` 文件头：元数据挂在 `describeTable` 的返回值上，
 * 才能保证「列」和「外键/索引」来自同一份快照——ER 图才不会画出对不上的关系线。
 *
 * ===== 为什么用 pg_catalog 而不是 information_schema =====
 *
 * `information_schema` 是 SQL 标准视图，跨数据库可移植，但它**看不到**：
 *   - 部分索引的 predicate（标准视图里没有对应列）；
 *   - 表达式索引的表达式文本；
 *   - 触发器的 UPDATE OF 列、WHEN 条件、启用状态；
 *   - 外键的 ON UPDATE / ON DELETE 动作（标准视图只给文字描述，不易解析）。
 * 这些恰恰是 DBeaver「约束/索引/触发器」面板要展示的内容，
 * 所以这里走 `pg_catalog`——**只读系统目录**，不是用户表的 `SELECT`。
 *
 * 所有 schema / table 名都以 `$1` / `$2` 参数传入，**绝不拼进 SQL 文本**。
 *
 * ===== 已知限制（与 SQLite 侧对称）=====
 *
 *   - CHECK / 部分索引 predicate / 触发器 WHEN 保留**原始表达式文本**，
 *     不做语义等价归一化（与 SQLite 侧同一取舍，见 `core/metadata.ts`）。
 *   - 触发器的 `statement` 取触发函数的函数体（`pg_proc.prosrc`）；
 *     PG 的触发体本来就住在函数里，没有 SQLite 那种 `BEGIN ... END` 内联写法。
 */

import type {
  CheckConstraintDescription,
  ForeignKeyDescription,
  IndexDescription,
  TriggerDescription,
  UniqueConstraintDescription
} from '../../core/metadata'

/**
 * 执行一条只读 catalog 查询。
 *
 * 抽象成函数而不是直接 import `pg`：本模块因此**不依赖 pg 包**，
 * 可以被纯类型探针测试直接编译，也便于 adapter 注入自己的错误包装。
 */
export type PgCatalogQuery = (
  sql: string,
  params: readonly unknown[]
) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>

/** `describeTable` 可直接展开的 PG 结构扩展片段。 */
export interface PostgresTableMetadata {
  readonly uniqueConstraints: readonly UniqueConstraintDescription[]
  readonly foreignKeys: readonly ForeignKeyDescription[]
  readonly indexes: readonly IndexDescription[]
  readonly checks: readonly CheckConstraintDescription[]
  readonly triggers: readonly TriggerDescription[]
}

/** `pg_constraint.confupdtype` / `confdeltype` 的单字符动作码。 */
const FK_ACTIONS: Readonly<Record<string, string>> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT'
}

/**
 * 触发器位掩码（`pg_trigger.tgtype`）。
 *
 * PG 的 `tgtype` 是位掩码，含义见 PostgreSQL 源码 `trigger.h`：
 * 注意**没有 "AFTER" 位**——AFTER 是「时机位全为 0」的默认情形。
 * 这一点最容易写错：把 bit 8 当成 AFTER 会把 DELETE 触发器误判成 AFTER DELETE。
 */
const TRIGGER_TYPE_ROW = 1 << 0
const TRIGGER_TYPE_BEFORE = 1 << 1
const TRIGGER_TYPE_INSERT = 1 << 2
const TRIGGER_TYPE_DELETE = 1 << 3
const TRIGGER_TYPE_UPDATE = 1 << 4
const TRIGGER_TYPE_TRUNCATE = 1 << 5
const TRIGGER_TYPE_INSTEAD = 1 << 6

interface ForeignKeyRow {
  readonly constraintName: string
  readonly referencedSchema: string
  readonly referencedTable: string
  readonly columnName: string
  readonly referencedColumn: string
  readonly position: number
  readonly updateAction: string
  readonly deleteAction: string
}

interface UniqueConstraintRow {
  readonly constraintName: string
  readonly position: number
  readonly columnName: string
}

interface IndexRow {
  readonly indexName: string
  readonly isUnique: boolean
  readonly predicate: string | null
  readonly position: number
  readonly columnName: string | null
  readonly columnExpression: string | null
  readonly isExpression: boolean
}

interface CheckRow {
  readonly constraintName: string
  readonly expression: string
}

interface TriggerRow {
  readonly triggerName: string
  readonly triggerType: number
  readonly enabled: string
  readonly updateColumns: readonly string[]
  readonly definition: string
  readonly functionBody: string | null
}

function readText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 't' || value === 'true'
}

/** 与区域设置无关的稳定文本排序；同名时再按原始大小写区分。 */
function compareText(left: string, right: string): number {
  const leftFolded = left.toLowerCase()
  const rightFolded = right.toLowerCase()
  if (leftFolded < rightFolded) return -1
  if (leftFolded > rightFolded) return 1
  if (left < right) return -1
  if (right < left) return 1
  return 0
}

function toAction(code: unknown): string {
  const key = typeof code === 'string' ? code : ''
  return FK_ACTIONS[key] ?? 'NO ACTION'
}

// ---------------------------------------------------------------------------
// 外键
// ---------------------------------------------------------------------------

/**
 * 读外键约束。
 *
 * 用 `pg_constraint` + `unnest(conkey, confkey) WITH ORDINALITY`：
 * `conkey` / `confkey` 是两个**平行的 attnum 数组**，按位置一一对应，
 * 复合外键的列顺序就体现在数组顺序上。
 *
 * 为什么不用 `information_schema.referential_constraints`：
 * 标准视图把「本表列」与「被引用列」拆到两张表里，
 * 复合外键要靠 `position_in_unique_constraint` 拼回来，且拿不到 ON UPDATE / ON DELETE 动作。
 */
export async function readPostgresForeignKeys(
  query: PgCatalogQuery,
  schema: string,
  tableName: string
): Promise<ForeignKeyDescription[]> {
  const sql = `
    SELECT
      con.conname AS constraint_name,
      frefns.nspname AS referenced_schema,
      fref.relname AS referenced_table,
      att.attname AS column_name,
      refatt.attname AS referenced_column,
      key.ord AS position,
      con.confupdtype AS update_action,
      con.confdeltype AS delete_action
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    JOIN pg_class fref ON fref.oid = con.confrelid
    JOIN pg_namespace frefns ON frefns.oid = fref.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS key(attnum, refattnum, ord)
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = key.attnum
    JOIN pg_attribute refatt ON refatt.attrelid = con.confrelid AND refatt.attnum = key.refattnum
    WHERE con.contype = 'f'
      AND ns.nspname = $1
      AND rel.relname = $2
    ORDER BY con.conname, key.ord`

  const result = await query(sql, [schema, tableName])
  const grouped = new Map<string, ForeignKeyRow[]>()
  for (const row of result.rows) {
    const constraintName = readText(row['constraint_name'])
    const referencedSchema = readText(row['referenced_schema'])
    const referencedTable = readText(row['referenced_table'])
    const columnName = readText(row['column_name'])
    const referencedColumn = readText(row['referenced_column'])
    const position = readNumber(row['position'])
    if (
      constraintName === null ||
      referencedSchema === null ||
      referencedTable === null ||
      columnName === null ||
      referencedColumn === null ||
      position === null
    ) {
      continue
    }
    const entry: ForeignKeyRow = {
      constraintName,
      referencedSchema,
      referencedTable,
      columnName,
      referencedColumn,
      position,
      updateAction: toAction(readText(row['update_action'])),
      deleteAction: toAction(readText(row['delete_action']))
    }
    const bucket = grouped.get(constraintName)
    if (bucket === undefined) grouped.set(constraintName, [entry])
    else bucket.push(entry)
  }

  const foreignKeys: ForeignKeyDescription[] = []
  for (const [constraintName, entries] of grouped) {
    entries.sort((left, right) => left.position - right.position)
    const first = entries[0]
    if (first === undefined) continue
    foreignKeys.push({
      name: constraintName,
      columns: entries.map((entry) => entry.columnName),
      // 契约规定 `referencedSchema === null` 表示「与本表同 schema」，
      // 而不是「不知道」——PG 的跨 schema 外键是真实场景，必须能区分。
      referencedSchema: first.referencedSchema === schema ? null : first.referencedSchema,
      referencedTable: first.referencedTable,
      referencedColumns: entries.map((entry) => entry.referencedColumn),
      onUpdate: first.updateAction,
      onDelete: first.deleteAction
    })
  }
  return foreignKeys.sort((left, right) => compareText(left.name ?? '', right.name ?? ''))
}

// ---------------------------------------------------------------------------
// 唯一约束
// ---------------------------------------------------------------------------

/**
 * 读唯一约束（`contype IN ('u', 'p')`）。
 *
 * 包含主键：`pg_constraint` 里主键是独立的 `contype = 'p'`，
 * 它同样是一条「保证列组合唯一」的表结构约束。
 * SQLite 侧同样把 `origin = 'pk'` 的索引算进唯一约束，两边保持一致。
 */
export async function readPostgresUniqueConstraints(
  query: PgCatalogQuery,
  schema: string,
  tableName: string
): Promise<UniqueConstraintDescription[]> {
  const sql = `
    SELECT
      con.conname AS constraint_name,
      key.ord AS position,
      att.attname AS column_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    CROSS JOIN LATERAL generate_subscripts(con.conkey, 1) AS key(ord)
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[key.ord]
    WHERE con.contype IN ('u', 'p')
      AND ns.nspname = $1
      AND rel.relname = $2
    ORDER BY con.conname, key.ord`

  const result = await query(sql, [schema, tableName])
  const grouped = new Map<string, UniqueConstraintRow[]>()
  for (const row of result.rows) {
    const constraintName = readText(row['constraint_name'])
    const columnName = readText(row['column_name'])
    const position = readNumber(row['position'])
    if (constraintName === null || columnName === null || position === null) continue
    const entry: UniqueConstraintRow = { constraintName, position, columnName }
    const bucket = grouped.get(constraintName)
    if (bucket === undefined) grouped.set(constraintName, [entry])
    else bucket.push(entry)
  }

  const constraints: UniqueConstraintDescription[] = []
  for (const [constraintName, entries] of grouped) {
    entries.sort((left, right) => left.position - right.position)
    constraints.push({
      name: constraintName,
      columns: entries.map((entry) => entry.columnName)
    })
  }
  return constraints.sort((left, right) => compareText(left.name ?? '', right.name ?? ''))
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

/**
 * 读索引。
 *
 * 关键点：
 *   - `indpred` 非空即**部分索引**，条件文本由 `pg_get_expr` 给出；
 *   - `indkey` 为 0 的项表示**表达式**（不是列），
 *     表达式文本由 `pg_get_indexdef(indexrelid, n, true)` 给出；
 *   - `indnkeyatts` 是键列数，`indnatts` 还包含 `INCLUDE` 的非键列——
 *     只取前 `indnkeyatts` 项，因为非键列不参与唯一性判定也不是"索引列"的通常含义。
 */
export async function readPostgresIndexes(
  query: PgCatalogQuery,
  schema: string,
  tableName: string
): Promise<IndexDescription[]> {
  const sql = `
    SELECT
      idxcls.relname AS index_name,
      ix.indisunique AS is_unique,
      pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
      key.ord AS position,
      att.attname AS column_name,
      pg_get_indexdef(ix.indexrelid, key.ord, true) AS column_expression,
      (ix.indkey[key.ord] = 0) AS is_expression
    FROM pg_index ix
    JOIN pg_class idxcls ON idxcls.oid = ix.indexrelid
    JOIN pg_class rel ON rel.oid = ix.indrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    CROSS JOIN LATERAL generate_subscripts(ix.indkey, 1) AS key(ord)
    LEFT JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ix.indkey[key.ord]
    WHERE ns.nspname = $1
      AND rel.relname = $2
      AND key.ord <= ix.indnkeyatts
    ORDER BY idxcls.relname, key.ord`

  const result = await query(sql, [schema, tableName])
  const grouped = new Map<string, IndexRow[]>()
  for (const row of result.rows) {
    const indexName = readText(row['index_name'])
    const position = readNumber(row['position'])
    if (indexName === null || position === null) continue
    const entry: IndexRow = {
      indexName,
      isUnique: readBoolean(row['is_unique']),
      predicate: readText(row['predicate']),
      position,
      columnName: readText(row['column_name']),
      columnExpression: readText(row['column_expression']),
      isExpression: readBoolean(row['is_expression'])
    }
    const bucket = grouped.get(indexName)
    if (bucket === undefined) grouped.set(indexName, [entry])
    else bucket.push(entry)
  }

  const indexes: IndexDescription[] = []
  for (const [indexName, entries] of grouped) {
    entries.sort((left, right) => left.position - right.position)
    const first = entries[0]
    if (first === undefined) continue
    // 表达式索引：`columns` 置空，原始表达式放进 `expression`——
    // 与 SQLite 侧 `toCoreTableMetadata` 的处理完全一致。
    const hasExpression = entries.some((entry) => entry.isExpression)
    const columns = entries
      .filter((entry) => !entry.isExpression && entry.columnName !== null)
      .map((entry) => entry.columnName as string)
    const rendered = entries
      .map((entry) => entry.columnExpression ?? entry.columnName ?? '')
      .filter((text) => text !== '')
      .join(', ')
    indexes.push({
      name: indexName,
      unique: first.isUnique,
      columns: hasExpression ? [] : columns,
      predicate: first.predicate,
      expression: hasExpression ? rendered : null
    })
  }
  return indexes.sort((left, right) => compareText(left.name, right.name))
}

// ---------------------------------------------------------------------------
// CHECK 约束
// ---------------------------------------------------------------------------

/**
 * 读 CHECK 约束。
 *
 * `pg_get_expr(con.conbin, con.conrelid)` 给出条件表达式文本。
 * 它总是带一层多余括号（PG 的规范化输出），这里**保留原文**不做裁剪——
 * 裁剪需要判断括号是否配对/是否属于表达式本身，容易出错，
 * 而 UI 只是展示（见 `core/metadata.ts` 的说明）。
 */
export async function readPostgresChecks(
  query: PgCatalogQuery,
  schema: string,
  tableName: string
): Promise<CheckConstraintDescription[]> {
  const sql = `
    SELECT
      con.conname AS constraint_name,
      pg_get_expr(con.conbin, con.conrelid) AS expression
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE con.contype = 'c'
      AND ns.nspname = $1
      AND rel.relname = $2
    ORDER BY con.conname`

  const result = await query(sql, [schema, tableName])
  const checks: CheckConstraintDescription[] = []
  for (const row of result.rows) {
    const expression = readText(row['expression'])
    if (expression === null || expression === '') continue
    checks.push({
      name: readText(row['constraint_name']),
      expression
    })
  }
  return checks
}

// ---------------------------------------------------------------------------
// 触发器
// ---------------------------------------------------------------------------

/**
 * 读触发器。
 *
 * `pg_trigger.tgisinternal = true` 的是**约束自动生成的内部触发器**
 * （外键的 RI 触发器等），它们不是用户写的触发器，必须排除——
 * 否则每个有外键的表都会凭空多出两三个触发器。
 *
 * WHEN 条件从 `pg_get_triggerdef()` 的原文里切出来：
 * `pg_get_expr(tg.tgqual, tg.tgrelid)` 在 PG 17 上会直接报错
 * （"expression contains variables of more than one relation"），
 * 因为触发器条件引用了 OLD/NEW 两个伪关系，标准取法只有 triggerdef 原文。
 */
export async function readPostgresTriggers(
  query: PgCatalogQuery,
  schema: string,
  tableName: string
): Promise<TriggerDescription[]> {
  const sql = `
    SELECT
      tg.tgname AS trigger_name,
      tg.tgtype::int AS trigger_type,
      tg.tgenabled AS enabled,
      tg.tgattr::text AS update_attribute_numbers,
      pg_get_triggerdef(tg.oid) AS definition,
      proc.prosrc AS function_body
    FROM pg_trigger tg
    JOIN pg_class rel ON rel.oid = tg.tgrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    LEFT JOIN pg_proc proc ON proc.oid = tg.tgfoid
    WHERE NOT tg.tgisinternal
      AND ns.nspname = $1
      AND rel.relname = $2
    ORDER BY tg.tgname`

  const attributeSql = `
    SELECT att.attname AS column_name
    FROM pg_trigger tg
    JOIN pg_class rel ON rel.oid = tg.tgrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    JOIN pg_attribute att
      ON att.attrelid = rel.oid
     AND att.attnum = ANY (tg.tgattr)
    WHERE tg.tgname = $1
      AND ns.nspname = $2
      AND rel.relname = $3
    ORDER BY att.attnum`

  const result = await query(sql, [schema, tableName])
  const triggers: TriggerDescription[] = []
  for (const row of result.rows) {
    const triggerName = readText(row['trigger_name'])
    const triggerType = readNumber(row['trigger_type'])
    const definition = readText(row['definition'])
    if (triggerName === null || triggerType === null || definition === null) continue

    const updateColumns = await readUpdateColumns(query, attributeSql, triggerName, schema, tableName)
    const timing = toTriggerTiming(triggerType)
    const event = toTriggerEvent(triggerType)
    if (event === null) continue

    triggers.push({
      name: triggerName,
      timing,
      event,
      // PG 的触发体住在触发函数里（`pg_proc.prosrc`）；没有内联 SQL 体。
      statement: readText(row['function_body']) ?? '',
      updateOf: updateColumns,
      when: extractTriggerWhenCondition(definition),
      // `tgenabled`：`O`=origin（启用）, `D`=disabled, `R`=replica, `A`=always。
      // 只有 `D` 视为禁用；replica/always 都意味着在某种模式下会触发。
      enabled: readText(row['enabled']) !== 'D'
    })
  }
  return triggers.sort((left, right) => compareText(left.name, right.name))
}

async function readUpdateColumns(
  query: PgCatalogQuery,
  sql: string,
  triggerName: string,
  schema: string,
  tableName: string
): Promise<readonly string[]> {
  const result = await query(sql, [triggerName, schema, tableName])
  const columns: string[] = []
  for (const row of result.rows) {
    const name = readText(row['column_name'])
    if (name !== null) columns.push(name)
  }
  return columns
}

function toTriggerTiming(triggerType: number): TriggerDescription['timing'] {
  if ((triggerType & TRIGGER_TYPE_INSTEAD) !== 0) return 'INSTEAD OF'
  if ((triggerType & TRIGGER_TYPE_BEFORE) !== 0) return 'BEFORE'
  // PG 没有 "AFTER" 位——时机位全 0 就是 AFTER。
  return 'AFTER'
}

function toTriggerEvent(triggerType: number): TriggerDescription['event'] | null {
  if ((triggerType & TRIGGER_TYPE_INSERT) !== 0) return 'INSERT'
  if ((triggerType & TRIGGER_TYPE_UPDATE) !== 0) return 'UPDATE'
  if ((triggerType & TRIGGER_TYPE_DELETE) !== 0) return 'DELETE'
  if ((triggerType & TRIGGER_TYPE_TRUNCATE) !== 0) return 'TRUNCATE'
  return null
}

/**
 * 从 `pg_get_triggerdef()` 原文里切出 WHEN 条件。
 *
 * 形如：
 *   CREATE TRIGGER trg BEFORE UPDATE ON t FOR EACH ROW WHEN ((old.a IS DISTINCT FROM new.a)) EXECUTE FUNCTION f()
 *
 * 切分要**括号感知**：条件里可能有嵌套括号与字符串字面量，
 * 不能简单地按 " EXECUTE " 第一个出现位置切——那会把 `EXECUTE` 出现在
 * 字符串里的情况切错。
 */
export function extractTriggerWhenCondition(definition: string): string | null {
  const whenIndex = findKeywordOutsideStrings(definition, 'WHEN')
  if (whenIndex === -1) return null
  let cursor = whenIndex + 'WHEN'.length
  const start = skipSpaces(definition, cursor)
  if (start >= definition.length) return null
  if (definition[start] !== '(') return null

  let depth = 0
  let inString = false
  for (let index = start; index < definition.length; index += 1) {
    const ch = definition.charAt(index)
    if (inString) {
      if (ch === "'") {
        // 连续两个单引号是转义，不是字符串结束。
        if (definition.charAt(index + 1) === "'") {
          index += 1
          continue
        }
        inString = false
      }
      continue
    }
    if (ch === "'") {
      inString = true
      continue
    }
    if (ch === '(') {
      depth += 1
      continue
    }
    if (ch === ')') {
      depth -= 1
      if (depth === 0) return stripOuterParens(definition.slice(start + 1, index).trim())
    }
  }
  return null
}

/**
 * 去掉整体包裹的那一层多余括号。
 *
 * `pg_get_triggerdef()` 总是把 WHEN 条件打印成**两层**括号：
 *   `WHEN ((old.a IS DISTINCT FROM new.a))`
 *   ^^^^^^^ 这是 PG 的固定输出格式
 *          ^^^^^^^^^^^^^^^^^^^^^^^^^^^ 用户写的条件
 * 切出来的一层是 PG 加的格式化外壳，不是用户表达式的一部分。
 *
 * 为什么要去掉：SQLite 侧同一字段给的是 `NEW.name <> ''`（无外层括号），
 * 跨方言契约里同一个字段带着方言专属的括号壳，UI 就要各写一套清洗。
 *
 * 只剥**一层**且要求括号完全包住整个字符串——
 * 否则 `(a) AND (b)` 会被误剥成 `a) AND (b`。
 */
function stripOuterParens(text: string): string {
  if (!text.startsWith('(') || !text.endsWith(')')) return text
  let depth = 0
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index)
    if (inString) {
      if (ch === "'") {
        if (text.charAt(index + 1) === "'") {
          index += 1
          continue
        }
        inString = false
      }
      continue
    }
    if (ch === "'") {
      inString = true
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      // 提前闭合说明这层括号没有包住整个字符串。
      if (depth === 0 && index !== text.length - 1) return text
    }
  }
  if (depth !== 0) return text
  return text.slice(1, -1).trim()
}

function skipSpaces(text: string, from: number): number {
  let index = from
  while (index < text.length && /\s/.test(text.charAt(index))) index += 1
  return index
}

/** 找到关键字的起始下标，跳过字符串字面量与双引号标识符；找不到返回 -1。 */
function findKeywordOutsideStrings(text: string, keyword: string): number {
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index)
    if (inString) {
      if (ch === "'") {
        if (text.charAt(index + 1) === "'") {
          index += 1
          continue
        }
        inString = false
      }
      continue
    }
    if (ch === "'") {
      inString = true
      continue
    }
    if (ch !== keyword.charAt(0)) continue
    if (text.slice(index, index + keyword.length) !== keyword) continue
    const before = index === 0 ? '' : text.charAt(index - 1)
    const after = text.charAt(index + keyword.length)
    const isBoundary =
      (before === '' || !/[A-Za-z0-9_$]/.test(before)) &&
      (after === '' || !/[A-Za-z0-9_$]/.test(after))
    if (isBoundary) return index
  }
  return -1
}

// ---------------------------------------------------------------------------
// 汇总入口
// ---------------------------------------------------------------------------

/**
 * 读一张表的全部结构元数据。
 *
 * 与 SQLite 侧 `readSqliteTableMetadata()` 同一职责：
 * 不读列、不返回 id/hasUniqueKey——那些由 adapter 的现有路径负责，
 * 这里只产出**可以合并进 TableDescription 的四块内容**。
 */
export async function readPostgresTableMetadata(
  query: PgCatalogQuery,
  schema: string,
  tableName: string
): Promise<PostgresTableMetadata> {
  const [uniqueConstraints, foreignKeys, indexes, checks, triggers] = await Promise.all([
    readPostgresUniqueConstraints(query, schema, tableName),
    readPostgresForeignKeys(query, schema, tableName),
    readPostgresIndexes(query, schema, tableName),
    readPostgresChecks(query, schema, tableName),
    readPostgresTriggers(query, schema, tableName)
  ])
  return { uniqueConstraints, foreignKeys, indexes, checks, triggers }
}
