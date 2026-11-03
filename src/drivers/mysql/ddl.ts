/**
 * MySQL / MariaDB 的 DDL 校验与 SQL 构造。
 *
 * 与 PostgreSQL / SQLite 版同构，但**白名单与语法必须按 MySQL 来**：
 *   - 自增是列修饰符 `AUTO_INCREMENT`，不是 PG 的 `SERIAL`，也不是 SQLite 的
 *     `INTEGER PRIMARY KEY AUTOINCREMENT`；
 *   - 类型集不同（`TINYINT` / `MEDIUMINT` / `DATETIME` / `JSON` / `ENUM` …），
 *     照抄 PG 的白名单会把合法类型拒掉，也会把 PG 专有类型放进来；
 *   - 默认值支持 `CURRENT_TIMESTAMP`、`b'...'`、`x'...'`。
 *
 * 三条通用纪律保持不变（见 sqlite/ddl.ts 文件头）：
 *   1. 标识符 → quoteIdentifier
 *   2. typeName → 白名单规范化（拼进 SQL 的永远是常量，不是用户原文）
 *   3. defaultValue → 只允许字面量
 */

import type { TableCreateSpec } from '../../core/model'
import { MysqlAdapterError } from './errors'

/** 带数字参数的类型。括号里只允许数字，堵死"括号里塞语句"。 */
const PARAMETERIZED_TYPES: readonly { readonly pattern: RegExp; readonly canonical: string }[] = [
  { pattern: /^tinyint\s*\(\s*(\d+)\s*\)$/i, canonical: 'TINYINT' },
  { pattern: /^smallint\s*\(\s*(\d+)\s*\)$/i, canonical: 'SMALLINT' },
  { pattern: /^mediumint\s*\(\s*(\d+)\s*\)$/i, canonical: 'MEDIUMINT' },
  { pattern: /^int\s*\(\s*(\d+)\s*\)$/i, canonical: 'INT' },
  { pattern: /^integer\s*\(\s*(\d+)\s*\)$/i, canonical: 'INTEGER' },
  { pattern: /^bigint\s*\(\s*(\d+)\s*\)$/i, canonical: 'BIGINT' },
  { pattern: /^varchar\s*\(\s*(\d+)\s*\)$/i, canonical: 'VARCHAR' },
  { pattern: /^char\s*\(\s*(\d+)\s*\)$/i, canonical: 'CHAR' },
  { pattern: /^binary\s*\(\s*(\d+)\s*\)$/i, canonical: 'BINARY' },
  { pattern: /^varbinary\s*\(\s*(\d+)\s*\)$/i, canonical: 'VARBINARY' },
  { pattern: /^decimal\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/i, canonical: 'DECIMAL' },
  { pattern: /^numeric\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/i, canonical: 'NUMERIC' },
  { pattern: /^bit\s*\(\s*(\d+)\s*\)$/i, canonical: 'BIT' },
  { pattern: /^datetime\s*\(\s*(\d+)\s*\)$/i, canonical: 'DATETIME' },
  { pattern: /^timestamp\s*\(\s*(\d+)\s*\)$/i, canonical: 'TIMESTAMP' },
  { pattern: /^time\s*\(\s*(\d+)\s*\)$/i, canonical: 'TIME' }
]

/** ENUM / SET：成员必须是单引号字符串，只允许内部 `''` 翻倍转义。 */
const ENUM_PATTERN = /^(enum|set)\s*\(\s*'(?:[^'\\]|'')*'\s*(?:,\s*'(?:[^'\\]|'')*'\s*)*\)$/i

const SIMPLE_TYPES: readonly string[] = [
  'TINYINT',
  'SMALLINT',
  'MEDIUMINT',
  'INT',
  'INTEGER',
  'BIGINT',
  'DECIMAL',
  'NUMERIC',
  'FLOAT',
  'DOUBLE',
  'REAL',
  'BIT',
  'BOOLEAN',
  'BOOL',
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'TIME',
  'YEAR',
  'CHAR',
  'VARCHAR',
  'BINARY',
  'VARBINARY',
  'TINYTEXT',
  'TEXT',
  'MEDIUMTEXT',
  'LONGTEXT',
  'TINYBLOB',
  'BLOB',
  'MEDIUMBLOB',
  'LONGBLOB',
  'JSON',
  'GEOMETRY',
  'POINT',
  'LINESTRING',
  'POLYGON',
  'MULTIPOINT',
  'MULTILINESTRING',
  'MULTIPOLYGON',
  'GEOMETRYCOLLECTION'
]

/** 归一化用户类型名。返回 null 表示不在白名单。 */
export function normalizeTypeName(rawTypeName: string): string | null {
  const trimmed = rawTypeName.trim()
  if (trimmed === '') return null

  if (ENUM_PATTERN.test(trimmed)) {
    const head = trimmed.slice(0, trimmed.indexOf('(')).toUpperCase()
    return `${head}${trimmed.slice(trimmed.indexOf('('))}`
  }

  const simple = trimmed.replace(/\s+/g, ' ').toUpperCase()
  if (SIMPLE_TYPES.includes(simple)) return simple

  for (const entry of PARAMETERIZED_TYPES) {
    const match = entry.pattern.exec(trimmed)
    if (match === null) continue
    const first = match[1] ?? ''
    const second = match[2]
    return second === undefined
      ? `${entry.canonical}(${Number(first)})`
      : `${entry.canonical}(${Number(first)},${Number(second)})`
  }
  return null
}

export function describeAllowedTypes(): string {
  return (
    'TINYINT、SMALLINT、MEDIUMINT、INT/INTEGER、BIGINT、DECIMAL、NUMERIC、FLOAT、DOUBLE、' +
    'BIT、BOOLEAN/BOOL、DATE、DATETIME、TIMESTAMP、TIME、YEAR、CHAR、VARCHAR、BINARY、VARBINARY、' +
    'TINYTEXT/TEXT/MEDIUMTEXT/LONGTEXT、TINYBLOB/BLOB/MEDIUMBLOB/LONGBLOB、JSON、' +
    'GEOMETRY 系列，以及带数字参数的 VARCHAR(n)、DECIMAL(p,s)、BIT(n)、DATETIME(n)、ENUM(...)、SET(...)'
  )
}

const NUMBER_DEFAULT = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/
const CONSTANT_DEFAULTS = new Set(['NULL', 'TRUE', 'FALSE', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME'])

export function normalizeDefaultValue(
  raw: string
): { readonly ok: true; readonly sql: string } | { readonly ok: false; readonly reason: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, reason: "默认值为空字符串。空默认值请显式写 NULL 或 ''。" }

  const upper = trimmed.replace(/\s+/g, ' ').toUpperCase()
  if (CONSTANT_DEFAULTS.has(upper)) return { ok: true, sql: upper }
  if (/^CURRENT_TIMESTAMP\s*\(\s*\d*\s*\)$/i.test(trimmed)) {
    return { ok: true, sql: trimmed.replace(/\s+/g, '').toUpperCase() }
  }
  if (NUMBER_DEFAULT.test(trimmed)) return { ok: true, sql: trimmed }
  if (/^[bx]\s*'[0-9a-fA-F]*'$/i.test(trimmed)) return { ok: true, sql: trimmed }

  if (trimmed.startsWith("'")) {
    let i = 1
    let closed = -1
    while (i < trimmed.length) {
      if (trimmed.charAt(i) === '\\') {
        i += 2
        continue
      }
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
    return { ok: false, reason: '默认值里的字符串字面量后面还有内容（只允许单独一个字面量）。' }
  }

  return {
    ok: false,
    reason:
      "默认值只允许字面量：数字、NULL、TRUE/FALSE、CURRENT_TIMESTAMP/CURRENT_DATE/CURRENT_TIME、b'..'/x'..'，或单个用单引号包裹的字符串。"
  }
}

/**
 * 生成 `CREATE TABLE`。
 *
 * 与 PG 的关键差异：
 *   - 整数主键 + `autoIncrement: true` → 列上追加 `AUTO_INCREMENT`，
 *     并把 `PRIMARY KEY` 内联到该列（MySQL 要求自增列必须是键）；
 *   - 与 PG 一样**不推断**自增：缺省 `autoIncrement` 时不偷偷加 `AUTO_INCREMENT`。
 */
export function buildCreateTableSql(quote: (name: string) => string, spec: TableCreateSpec): string {
  if (spec.name.trim() === '') throw new MysqlAdapterError('bad_params', '表名不能为空。')
  if (spec.columns.length === 0) throw new MysqlAdapterError('bad_params', '建表至少要有一列。')

  const seen = new Set<string>()
  const primaryKeys: { name: string; ordinal: number }[] = []
  const definitions: { name: string; sql: string; typeName: string; autoIncrement: boolean }[] = []

  for (const column of spec.columns) {
    const columnName = column.name.trim()
    if (columnName === '') throw new MysqlAdapterError('bad_params', '列名不能为空。')
    if (seen.has(columnName.toLowerCase())) {
      throw new MysqlAdapterError('bad_params', `列名重复：${columnName}（MySQL 列名不区分大小写）。`)
    }
    seen.add(columnName.toLowerCase())

    const typeName = normalizeTypeName(column.typeName)
    if (typeName === null) {
      throw new MysqlAdapterError(
        'bad_params',
        `列「${columnName}」的类型不受支持：${column.typeName}。允许的类型：${describeAllowedTypes()}`
      )
    }

    let definition = `${quote(columnName)} ${typeName}`
    if (column.nullable === false) definition += ' NOT NULL'

    if (column.defaultValue !== undefined) {
      const normalized = normalizeDefaultValue(column.defaultValue)
      if (!normalized.ok) {
        throw new MysqlAdapterError('bad_params', `列「${columnName}」的默认值不合法：${normalized.reason}`)
      }
      definition += ` DEFAULT ${normalized.sql}`
    }

    if (column.primaryKeyOrdinal !== undefined) {
      if (!Number.isInteger(column.primaryKeyOrdinal) || column.primaryKeyOrdinal < 1) {
        throw new MysqlAdapterError('bad_params', `列「${columnName}」的 primaryKeyOrdinal 非法（应为 1 起的整数）。`)
      }
      if (primaryKeys.some((pk) => pk.ordinal === column.primaryKeyOrdinal)) {
        throw new MysqlAdapterError('bad_params', `主键序号重复：${column.primaryKeyOrdinal}。`)
      }
      primaryKeys.push({ name: columnName, ordinal: column.primaryKeyOrdinal })
    }

    definitions.push({ name: columnName, sql: definition, typeName, autoIncrement: column.autoIncrement === true })
  }

  if (primaryKeys.length === 1) {
    const pk = primaryKeys[0]
    if (pk === undefined) throw new MysqlAdapterError('internal', '主键解析失败')
    const target = definitions.find((definition) => definition.name === pk.name)
    if (target === undefined) throw new MysqlAdapterError('internal', '主键列不存在')
    if (target.autoIncrement) {
      if (!/^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)\b/i.test(target.typeName)) {
        throw new MysqlAdapterError(
          'bad_params',
          `列「${pk.name}」要求自增，但 MySQL 自增只支持整数类型（TINYINT/SMALLINT/MEDIUMINT/INT/BIGINT）。`
        )
      }
      target.sql += ' AUTO_INCREMENT PRIMARY KEY'
    } else {
      target.sql += ' PRIMARY KEY'
    }
  } else if (primaryKeys.length > 1) {
    const ordered = [...primaryKeys].sort((a, b) => a.ordinal - b.ordinal)
    definitions.push({
      name: '',
      sql: `PRIMARY KEY (${ordered.map((pk) => quote(pk.name)).join(', ')})`,
      typeName: '',
      autoIncrement: false
    })
  }

  return `CREATE TABLE ${quote(spec.name)} (\n  ${definitions.map((definition) => definition.sql).join(',\n  ')}\n)`
}

export function buildDropTableSql(quote: (name: string) => string, schema: string, tableName: string): string {
  return `DROP TABLE ${quote(schema)}.${quote(tableName)}`
}

export function buildCreateViewSql(
  quote: (name: string) => string,
  schema: string,
  viewName: string,
  selectSql: string
): string {
  return `CREATE VIEW ${quote(schema)}.${quote(viewName)} AS ${selectSql}`
}

export function buildDropViewSql(quote: (name: string) => string, schema: string, viewName: string): string {
  return `DROP VIEW ${quote(schema)}.${quote(viewName)}`
}

export function buildRenameTableSql(
  quote: (name: string) => string,
  schema: string,
  from: string,
  to: string
): string {
  return `RENAME TABLE ${quote(schema)}.${quote(from)} TO ${quote(schema)}.${quote(to)}`
}
