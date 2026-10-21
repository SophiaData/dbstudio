/**
 * PostgreSQL 的 DDL 校验与 SQL 构造。
 *
 * ===== 为什么这套代码不能照抄 sqlite/ddl.ts =====
 *
 * "DDL 没法和 DML 那样参数化，只能靠白名单"这个结论是通用的，
 * 但**白名单的内容是方言特有的**。照抄会带来两类错误：
 *
 *   1. **类型白名单错**：SQLite 认 `AUTOINCREMENT`、把 `INTEGER` 当自增载体；
 *      PG 用的是 `SERIAL` / `BIGSERIAL` / `GENERATED ... AS IDENTITY`，
 *      `AUTOINCREMENT` 在 PG 里根本不存在，拼出来就是语法错误。
 *   2. **布尔/自增语义错**：SQLite 没有布尔类型（用 0/1），PG 有真 `BOOLEAN`；
 *      SQLite 的自增是主键修饰符，PG 的自增是**独立类型**（SERIAL）。
 *
 * 所以这里按 PG 的类型集维护白名单。仍然沿用三条通用纪律（见 sqlite/ddl.ts 文件头）：
 *   1. 标识符 → quoteIdentifier
 *   2. typeName → 白名单规范化（拼进 SQL 的永远是常量，不是用户原文）
 *   3. defaultValue → 只允许字面量
 */

import type { TableCreateSpec } from '../../core/model'
import { PostgresAdapterError } from './errors'

/**
 * 带参数的类型的白名单（正则）。参数部分只允许数字——
 * `NUMERIC(p,s)` / `VARCHAR(n)` 的括号里语法上只能是整数，
 * 限定 `\d+` 就把"括号里塞语句"彻底堵死。
 */
const PARAMETERIZED_TYPES: readonly { readonly pattern: RegExp; readonly canonical: string }[] = [
  { pattern: /^varchar\s*\(\s*(\d+)\s*\)$/i, canonical: 'VARCHAR' },
  { pattern: /^char\s*\(\s*(\d+)\s*\)$/i, canonical: 'CHAR' },
  { pattern: /^numeric\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/i, canonical: 'NUMERIC' },
  { pattern: /^decimal\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/i, canonical: 'DECIMAL' }
]

/**
 * 无参数类型的白名单（按 PostgreSQL 常用类型集，**不是** SQLite 的那套）。
 *
 * 刻意包含 PG 特有的 `SERIAL` / `BIGSERIAL` / `BOOLEAN` / `BYTEA` / `JSONB` /
 * `UUID` / `TIMESTAMPTZ` 等。注意：
 *   - `SERIAL` / `BIGSERIAL` 是 PG 的"伪类型"，建表时合法，但读回时
 *     information_schema 会显示成 `integer` + 序列默认值（见 adapter 的列读取说明）。
 *   - 不收录 `AUTOINCREMENT`（SQLite 专有）、`INTEGER PRIMARY KEY` 这种组合（也不是 PG 类型）。
 */
const SIMPLE_TYPES: readonly string[] = [
  'SMALLINT',
  'INTEGER',
  'INT',
  'BIGINT',
  'INT2',
  'INT4',
  'INT8',
  'SERIAL',
  'BIGSERIAL',
  'SMALLSERIAL',
  'REAL',
  'DOUBLE PRECISION',
  'FLOAT4',
  'FLOAT8',
  'NUMERIC',
  'DECIMAL',
  'MONEY',
  'BOOLEAN',
  'BOOL',
  'TEXT',
  'VARCHAR',
  'CHAR',
  'CHARACTER',
  'CHARACTER VARYING',
  'BPCHAR',
  'BYTEA',
  'DATE',
  'TIME',
  'TIMETZ',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'INTERVAL',
  'UUID',
  'JSON',
  'JSONB',
  'XML',
  'INET',
  'CIDR',
  'MACADDR'
]

/**
 * 归一化一个用户提供的类型名。返回 `null` 表示不在白名单里。
 * 返回值一定是白名单里的规范字面量——拼进 DDL 的永远是常量，不是用户原文。
 */
export function normalizeTypeName(rawTypeName: string): string | null {
  const trimmed = rawTypeName.trim()
  if (trimmed === '') return null

  // 先试无参数类型（大小写不敏感，内部多余空白折叠）
  const simple = trimmed.replace(/\s+/g, ' ').toUpperCase()
  if (SIMPLE_TYPES.includes(simple)) return simple

  for (const entry of PARAMETERIZED_TYPES) {
    const match = entry.pattern.exec(trimmed)
    if (match === null) continue
    const first = match[1] ?? ''
    const second = match[2]
    return second === undefined ? `${entry.canonical}(${Number(first)})` : `${entry.canonical}(${Number(first)},${Number(second)})`
  }
  return null
}

/** 供报错信息用：把允许的类型列成人话。 */
export function describeAllowedTypes(): string {
  return (
    'SMALLINT、INTEGER/INT、BIGINT、SERIAL、BIGSERIAL、REAL、DOUBLE PRECISION、NUMERIC、DECIMAL、' +
    'BOOLEAN、TEXT、VARCHAR、CHAR、BYTEA、DATE、TIME、TIMESTAMP、TIMESTAMPTZ、INTERVAL、UUID、JSON、JSONB、XML、INET、CIDR、MACADDR，' +
    '以及带数字参数的 VARCHAR(n)、CHAR(n)、NUMERIC(p,s)、DECIMAL(p,s)'
  )
}

/**
 * 默认值白名单。与 SQLite 版同构，但常量函数集按 PG 调整
 * （PG 有 `now()`、`CURRENT_TIMESTAMP`、`CURRENT_DATE`、`CURRENT_TIME` 等）。
 * 只接受**能确定为字面量**的形态；字符串必须整体就是一个字符串字面量。
 */
const CONSTANT_DEFAULTS: readonly string[] = [
  'CURRENT_TIMESTAMP',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_USER',
  'SESSION_USER',
  'LOCALTIMESTAMP',
  'LOCALTIME',
  'TRUE',
  'FALSE',
  'NULL'
]

const NUMBER_DEFAULT = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/

export function normalizeDefaultValue(
  raw: string
): { readonly ok: true; readonly sql: string } | { readonly ok: false; readonly reason: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, reason: "默认值为空字符串。空默认值请显式写 NULL 或 ''。" }

  // `now()` 是 PG 里最常用的时间默认值，单独放行（它是确定的无参函数调用）
  if (/^now\s*\(\s*\)$/i.test(trimmed)) return { ok: true, sql: 'now()' }

  const upper = trimmed.replace(/\s+/g, ' ').toUpperCase()
  if (CONSTANT_DEFAULTS.includes(upper)) return { ok: true, sql: upper }

  if (NUMBER_DEFAULT.test(trimmed)) return { ok: true, sql: trimmed }

  // 单引号字符串：整串必须恰好是一个字符串字面量，不允许尾随内容
  if (trimmed.startsWith("'")) {
    let i = 1
    let closed = -1
    while (i < trimmed.length) {
      if (trimmed.charAt(i) === "'") {
        if (trimmed.charAt(i + 1) === "'") {
          i += 2
          continue
        }
        closed = i
        break
      }
      i += 1
    }
    if (closed === trimmed.length - 1) return { ok: true, sql: trimmed }
    return {
      ok: false,
      reason: '默认值里的字符串字面量后面还有内容（只允许单独一个字面量，不允许拼接或子查询）。'
    }
  }

  return {
    ok: false,
    reason:
      "默认值只允许字面量：数字（如 42、-3.14）、NULL、TRUE/FALSE、CURRENT_TIMESTAMP/CURRENT_DATE/CURRENT_TIME/now()，或单个用单引号包裹的字符串（如 'abc'）。"
  }
}

/**
 * 生成 `CREATE TABLE` 语句。
 *
 * ===== PG 与 SQLite 在主键/自增上的根本差异 =====
 *
 * SQLite：`INTEGER PRIMARY KEY AUTOINCREMENT`（自增是主键列的修饰符）。
 * PostgreSQL：
 *   - 自增是**类型**：`id SERIAL PRIMARY KEY`（SERIAL 自带一个序列默认值）。
 *   - 或者显式 identity：`id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY`。
 *   - 复合主键写成表级约束 `PRIMARY KEY (a, b)`，与 SQLite 相同。
 *
 * 本实现策略（与 SQLite 版对齐的"推断 + 覆盖"）：
 *   - `autoIncrement === true` 且单列主键 → 若类型是 INTEGER/INT/BIGINT 等，
 *     改用 `SERIAL`/`BIGSERIAL`/`SMALLSERIAL`（按原类型的位宽映射）；
 *     若用户已显式写 SERIAL 系列则原样保留。非整数类型要求自增 → 报错。
 *   - `autoIncrement` 缺省 → **不自动加自增**（PG 里自增是一个显式选择，
 *     不像 SQLite 的"单 INTEGER 主键就自增"那样是惯例；强行推断会让每个整数主键
 *     都偷偷带上序列，用户看不到）。
 *   - `autoIncrement === false` → 不加。
 */
export function buildCreateTableSql(quote: (name: string) => string, spec: TableCreateSpec): string {
  if (spec.name.trim() === '') {
    throw new PostgresAdapterError('bad_params', '表名不能为空。')
  }
  if (spec.columns.length === 0) {
    throw new PostgresAdapterError('bad_params', '建表至少要有一列。')
  }

  const seenColumns = new Set<string>()
  const primaryKeys: { name: string; ordinal: number }[] = []
  const definitions: { name: string; sql: string }[] = []

  for (const column of spec.columns) {
    const columnName = column.name.trim()
    if (columnName === '') {
      throw new PostgresAdapterError('bad_params', '列名不能为空。')
    }
    // ⚠️ PG 标识符大小写折叠：未加引号的 `Users` 会变成 `users`。
    // 我们建表时**总是加引号**（下面 quote），所以这里列名大小写会被原样保留。
    // 因此"列名重复"的判定必须按**精确字面**（区分大小写）——
    // `"Users"` 与 `"users"` 在 PG 里是两个不同的列，不能误判为重复。
    if (seenColumns.has(columnName)) {
      throw new PostgresAdapterError('bad_params', `列名重复：${columnName}（PostgreSQL 加引号后区分大小写）。`)
    }
    seenColumns.add(columnName)

    const typeName = normalizeTypeName(column.typeName)
    if (typeName === null) {
      throw new PostgresAdapterError(
        'bad_params',
        `列「${columnName}」的类型不受支持：${column.typeName}。允许的类型：${describeAllowedTypes()}`
      )
    }

    let definition = `${quote(columnName)} ${typeName}`
    if (column.nullable === false) definition += ' NOT NULL'

    if (column.defaultValue !== undefined) {
      const normalized = normalizeDefaultValue(column.defaultValue)
      if (!normalized.ok) {
        throw new PostgresAdapterError('bad_params', `列「${columnName}」的默认值不合法：${normalized.reason}`)
      }
      definition += ` DEFAULT ${normalized.sql}`
    }

    if (column.primaryKeyOrdinal !== undefined) {
      if (!Number.isInteger(column.primaryKeyOrdinal) || column.primaryKeyOrdinal < 1) {
        throw new PostgresAdapterError(
          'bad_params',
          `列「${columnName}」的 primaryKeyOrdinal 非法：${String(column.primaryKeyOrdinal)}（应为 1 起的整数）。`
        )
      }
      if (primaryKeys.some((pk) => pk.ordinal === column.primaryKeyOrdinal)) {
        throw new PostgresAdapterError(
          'bad_params',
          `主键序号重复：${column.primaryKeyOrdinal}（两列不能占据同一个主键位置）。`
        )
      }
      primaryKeys.push({ name: columnName, ordinal: column.primaryKeyOrdinal })
    }

    definitions.push({ name: columnName, sql: definition })
  }

  // ---- 自增处理（PG 用 SERIAL 系列，不是 AUTOINCREMENT）----
  if (primaryKeys.length === 1 && primaryKeys[0] !== undefined) {
    const pk = primaryKeys[0]
    const target = definitions.find((definition) => definition.name === pk.name)
    const pkCol = spec.columns.find((c) => c.name === pk.name)
    if (target !== undefined) {
      const isSerial = /\b(SERIAL|BIGSERIAL|SMALLSERIAL)\b/i.test(target.sql)
      const declared = normalizeTypeName(pkCol?.typeName ?? '')
      const serialFor: Record<string, string> = {
        SMALLINT: 'SMALLSERIAL',
        INT2: 'SMALLSERIAL',
        INTEGER: 'SERIAL',
        INT: 'SERIAL',
        INT4: 'SERIAL',
        BIGINT: 'BIGSERIAL',
        INT8: 'BIGSERIAL'
      }
      const wantAuto = pkCol?.autoIncrement === true
      if (wantAuto) {
        if (isSerial) {
          // 用户已经写了 SERIAL，原样保留
        } else if (declared !== null && serialFor[declared] !== undefined) {
          // 把整数类型替换成对应的 SERIAL 系列（保留列名与已经加的 NOT NULL 等修饰）
          target.sql = target.sql.replace(/\b(INTEGER|INT|INT2|INT4|INT8|BIGINT|SMALLINT)\b/i, serialFor[declared] ?? 'SERIAL')
          // SERIAL 隐式 NOT NULL；显式 NOT NULL 也无害，保留即可
        } else {
          throw new PostgresAdapterError(
            'bad_params',
            `列「${pk.name}」要求自增，但自增只支持整数类型（SMALLINT/INTEGER/BIGINT）或直接用 SERIAL/BIGSERIAL。当前类型：${declared ?? pkCol?.typeName ?? ''}。`
          )
        }
      }
      target.sql += ' PRIMARY KEY'
    }
  } else if (primaryKeys.length > 1) {
    const ordered = [...primaryKeys].sort((a, b) => a.ordinal - b.ordinal)
    definitions.push({
      name: '',
      sql: `PRIMARY KEY (${ordered.map((pk) => quote(pk.name)).join(', ')})`
    })
  }

  return `CREATE TABLE ${quote(spec.name)} (\n  ${definitions.map((definition) => definition.sql).join(',\n  ')}\n)`
}

/** `DROP TABLE`。刻意不带 IF EXISTS：静默成功会让 UI 以为删掉了不存在的表。 */
export function buildDropTableSql(quote: (name: string) => string, schema: string, tableName: string): string {
  return `DROP TABLE ${quote(schema)}.${quote(tableName)}`
}

/** `CREATE VIEW`。selectSql 由调用方先用 prepareReadOnlyStatement 校验过。 */
export function buildCreateViewSql(
  quote: (name: string) => string,
  schema: string,
  viewName: string,
  selectSql: string
): string {
  return `CREATE VIEW ${quote(schema)}.${quote(viewName)} AS ${selectSql}`
}

/** `DROP VIEW`。不做 IF EXISTS。 */
export function buildDropViewSql(quote: (name: string) => string, schema: string, viewName: string): string {
  return `DROP VIEW ${quote(schema)}.${quote(viewName)}`
}

/**
 * `ALTER TABLE ... RENAME TO ...`。
 *
 * 与 SQLite 相同（PG 也支持这条语法），差异只在**必须带 schema 限定**，
 * 否则会在 search_path 里找表、可能改到别的 schema 的同名表。
 */
export function buildRenameTableSql(
  quote: (name: string) => string,
  schema: string,
  oldName: string,
  newName: string
): string {
  return `ALTER TABLE ${quote(schema)}.${quote(oldName)} RENAME TO ${quote(newName)}`
}
