/**
 * DDL 的**校验与 SQL 构造**（建表 / 删表 / 建视图 / 删视图 / 重命名）。
 *
 * ===== 本轮的核心安全问题：DDL 无法像 DML 那样参数化 =====
 *
 * DML 的值可以走 `?`：
 *   `UPDATE "t" SET "email" = ? WHERE "id" = ?`
 * 但 DDL 的结构部分——表名、列名、**类型名**、**默认值**——是 SQL 语法本身，
 * 占位符在这里不可用（`CREATE TABLE "t" ("id" ?)` 是语法错误，
 * `DEFAULT ?` 也不被接受）。也就是说这些输入**必然**以文本形式进入 SQL。
 *
 * 所以防护不能靠"参数化"，只能靠**逐个入口的白名单**：
 *
 *   1. 标识符（表名/列名/视图名）→ `quoteIdentifier` 把内部 `"` 翻倍，
 *      于是名字再离谱也只是一个"名字"，不会变成语法。
 *   2. **typeName → 白名单**。这是最危险的一个：`TEXT); DROP TABLE users;--`
 *      如果原样拼进 `("c" TEXT); DROP TABLE users;--)` 就真的会执行两条语句。
 *      所以类型名先归一到白名单里的小写规范形式，再拼。
 *   3. **defaultValue → 只允许字面量**。同样是最容易注入的地方：
 *      `DEFAULT '1'; DROP TABLE users;--'` 之类。这里只接受
 *      数字 / 单引号字符串 / NULL / 已知常量，其它一律拒绝。
 *
 * ===== 为什么不用"黑名单过滤关键字" =====
 *
 * 黑名单（比如"看到 DROP 就拒绝"）永远有人想得出绕过方式（大小写、注释、
 * 字符串拆断……），而且会误伤合法值（比如一个名叫 "drop_count" 的列）。
 * 白名单反过来：**只有我明确认识的形态才放行**，不认识就拒绝。
 * 拒绝的代价是偶发的"这个类型我没加进去"，而不是"某个未知 payload 打进来了"。
 */

import type { TableCreateSpec } from './ddl-types'
import { SqliteAdapterError } from './errors'

/**
 * 带参数的类型的白名单（正则）。
 *
 * 为什么参数部分只允许数字：`CHAR(n)` / `VARCHAR(n)` / `DECIMAL(p,s)` 的括号里
 * 语法上只能是整数。限定为 `\d+` 就把"括号里塞语句"这条路彻底堵死，
 * 而不是先去解析括号里的内容再判断。
 */
const PARAMETERIZED_TYPES: readonly { readonly pattern: RegExp; readonly canonical: string }[] = [
  { pattern: /^varchar\s*\(\s*(\d+)\s*\)$/i, canonical: 'VARCHAR' },
  { pattern: /^char\s*\(\s*(\d+)\s*\)$/i, canonical: 'CHAR' },
  { pattern: /^decimal\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/i, canonical: 'DECIMAL' },
  { pattern: /^numeric\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/i, canonical: 'NUMERIC' }
]

/** 无参数类型的白名单（与 SQLite 的类型亲和性对齐，外加常用别名）。 */
const SIMPLE_TYPES: readonly string[] = [
  'INTEGER',
  'INT',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'REAL',
  'DOUBLE',
  'FLOAT',
  'TEXT',
  'CLOB',
  'BLOB',
  'NUMERIC',
  'DECIMAL',
  'BOOLEAN',
  'BOOL',
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'JSON'
]

/**
 * 归一化一个用户提供的类型名。
 *
 * 返回 `null` 表示不在白名单里（调用方据此抛 `bad_params` 并列出允许类型）。
 * 返回值一定是**白名单里某个规范字面量**——这是本函数存在的全部意义：
 * 拼进 DDL 的永远是常量，不是用户原文。
 */
export function normalizeTypeName(rawTypeName: string): string | null {
  const trimmed = rawTypeName.trim()
  if (trimmed === '') return null

  const simple = trimmed.toUpperCase()
  if (SIMPLE_TYPES.includes(simple)) return simple

  for (const entry of PARAMETERIZED_TYPES) {
    const match = entry.pattern.exec(trimmed)
    if (match === null) continue
    /**
     * 用**捕获到的数字**重新拼，而不是回显用户原文：
     * 这样 `varchar( 10 )`、`VARCHAR(0010)` 都会被规范化成 `VARCHAR(10)`，
     * 且原文里任何"看起来像数字但夹了别的东西"的形态都在正则阶段就被拒了。
     */
    const first = match[1] ?? ''
    const second = match[2]
    return second === undefined ? `${entry.canonical}(${Number(first)})` : `${entry.canonical}(${Number(first)},${Number(second)})`
  }
  return null
}

/** 供报错信息用：把允许的类型列成人话。 */
export function describeAllowedTypes(): string {
  return 'INTEGER、INT、BIGINT、SMALLINT、TINYINT、REAL、DOUBLE、FLOAT、TEXT、CLOB、BLOB、NUMERIC、DECIMAL、BOOLEAN、DATE、DATETIME、TIMESTAMP、JSON，以及带数字参数的 VARCHAR(n)、CHAR(n)、DECIMAL(p,s)、NUMERIC(p,s)'
}

/**
 * 默认值白名单。
 *
 * 默认值同样是"必然进入 SQL 文本"的输入，所以只接受**能确定为字面量**的形态：
 *   - 数字：`42` / `-3.14` / `1e-3`
 *   - NULL（大小写不敏感）
 *   - 已知常量函数：`CURRENT_TIMESTAMP` / `CURRENT_DATE` / `CURRENT_TIME`
 *   - 单引号字符串：`'abc'`（内部 `''` 转义）
 *
 * 关键细节：**字符串必须整体就是一个字符串字面量**，
 * 不能是 `'a' || (SELECT ...)` 这类拼接/子查询。
 * 判定方式是扫一遍、要求整串恰好由"一个字符串字面量"构成。
 * 直接拼进 SQL 的 `'${x}'` 是经典注入点（`'a'; DROP TABLE ...; --`），
 * 所以这里把**转义后的完整字面量**算出来返回，而不是让调用方自己包引号。
 */
const CONSTANT_FUNCTIONS: readonly string[] = ['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME']

const NUMBER_DEFAULT = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/

/**
 * 校验并规范化一个默认值表达式。
 *
 * 返回**可直接拼进 DDL 的文本**；不合法则返回 `{ ok: false, reason }`。
 * 注意返回值的两种合法来源：
 *   - 数字/常量函数：原样（已经过正则约束）
 *   - 字符串：`'` + 内部 `'` 翻倍 + `'`，由**本函数**负责转义与包裹
 */
export function normalizeDefaultValue(raw: string): { readonly ok: true; readonly sql: string } | { readonly ok: false; readonly reason: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, reason: '默认值为空字符串。空默认值请显式写 NULL 或 \'\'。' }

  if (/^null$/i.test(trimmed)) return { ok: true, sql: 'NULL' }

  const upper = trimmed.toUpperCase()
  if (CONSTANT_FUNCTIONS.includes(upper)) return { ok: true, sql: upper }

  if (NUMBER_DEFAULT.test(trimmed)) return { ok: true, sql: trimmed }

  // 单引号字符串：整串必须恰好是一个字符串字面量，不允许任何尾随内容
  if (trimmed.startsWith("'")) {
    let i = 1
    let closed = -1
    while (i < trimmed.length) {
      if (trimmed.charAt(i) === "'") {
        if (trimmed.charAt(i + 1) === "'") {
          i += 2 // '' 是转义后的单引号，继续
          continue
        }
        closed = i
        break
      }
      i += 1
    }
    if (closed === trimmed.length - 1) {
      // 恰好以普通引号收尾 → 是一个完整的字符串字面量
      return { ok: true, sql: trimmed }
    }
    return {
      ok: false,
      reason: "默认值里的字符串字面量后面还有内容（只允许单独一个字面量，不允许拼接或子查询）。"
    }
  }

  return {
    ok: false,
    reason:
      '默认值只允许字面量：数字（如 42、-3.14）、NULL、CURRENT_TIMESTAMP/CURRENT_DATE/CURRENT_TIME，或单个用单引号包裹的字符串（如 \'abc\'）。'
  }
}

/**
 * 生成 `CREATE TABLE` 语句。
 *
 * 三件事按顺序做：表名/列名 quote → 类型走白名单 → 默认值走字面量白名单。
 * 任何一步不合法都抛 `bad_params`，绝不"先拼出来再想办法"。
 *
 * 主键的两种写法（SQLite 的硬性规则）：
 *   - **单列主键**：写在列定义上 `"id" INTEGER PRIMARY KEY AUTOINCREMENT`。
 *     AUTOINCREMENT 只有这种写法合法。
 *   - **复合主键**：写成表级约束 `PRIMARY KEY ("a", "b")`。
 *     每列都写 PRIMARY KEY 会被 SQLite 拒绝（"more than one primary key"）。
 */
export function buildCreateTableSql(quote: (name: string) => string, spec: TableCreateSpec): string {
  if (spec.name.trim() === '') {
    throw new SqliteAdapterError('bad_params', '表名不能为空。')
  }
  if (spec.columns.length === 0) {
    throw new SqliteAdapterError('bad_params', '建表至少要有一列。')
  }

  const seenColumns = new Set<string>()
  /** 主键列（按 primaryKeyOrdinal 排序后），用于决定"列上写"还是"表级约束"。 */
  const primaryKeys: { name: string; ordinal: number }[] = []
  const definitions: { name: string; sql: string }[] = []
  /** 一个列的 AUTOINCREMENT 意图，只有单主键时才会被采用。 */
  const autoIncrementByColumn = new Map<string, boolean>()

  for (const column of spec.columns) {
    const columnName = column.name.trim()
    if (columnName === '') {
      throw new SqliteAdapterError('bad_params', '列名不能为空。')
    }
    if (seenColumns.has(columnName.toLowerCase())) {
      throw new SqliteAdapterError('bad_params', `列名重复：${columnName}（SQLite 列名不区分大小写）。`)
    }
    seenColumns.add(columnName.toLowerCase())

    /**
     * 类型名进 SQL 文本前必须**归一到白名单常量**。
     * 返回 null 就是"我不认识的形态"，直接拒绝——
     * 这是整个 DDL 里最重要的一道闸（见文件头对 `TEXT); DROP TABLE ...` 的说明）。
     */
    const typeName = normalizeTypeName(column.typeName)
    if (typeName === null) {
      throw new SqliteAdapterError(
        'bad_params',
        `列「${columnName}」的类型不受支持：${column.typeName}。允许的类型：${describeAllowedTypes()}`
      )
    }

    let definition = `${quote(columnName)} ${typeName}`
    // nullable 缺省视为允许 NULL（与 SQLite 默认一致，也与 core 注释一致）
    if (column.nullable === false) definition += ' NOT NULL'

    if (column.defaultValue !== undefined) {
      const normalized = normalizeDefaultValue(column.defaultValue)
      if (!normalized.ok) {
        throw new SqliteAdapterError('bad_params', `列「${columnName}」的默认值不合法：${normalized.reason}`)
      }
      definition += ` DEFAULT ${normalized.sql}`
    }

    if (column.primaryKeyOrdinal !== undefined) {
      if (!Number.isInteger(column.primaryKeyOrdinal) || column.primaryKeyOrdinal < 1) {
        throw new SqliteAdapterError(
          'bad_params',
          `列「${columnName}」的 primaryKeyOrdinal 非法：${String(column.primaryKeyOrdinal)}（应为 1 起的整数）。`
        )
      }
      if (primaryKeys.some((pk) => pk.ordinal === column.primaryKeyOrdinal)) {
        throw new SqliteAdapterError(
          'bad_params',
          `主键序号重复：${column.primaryKeyOrdinal}（两列不能占据同一个主键位置）。`
        )
      }
      primaryKeys.push({ name: columnName, ordinal: column.primaryKeyOrdinal })
    }

    definitions.push({ name: columnName, sql: definition })
  }

  /**
   * AUTOINCREMENT 的判定。
   *
   * 契约现在有 `ColumnCreateSpec.autoIncrement?: boolean`（Lead 按你的问题补的），规则：
   *   - **显式 true** → 加（但仅当它是单 INTEGER 主键，否则 SQLite 语法不允许，报错）
   *   - **显式 false** → 不加
   *   - **缺省 undefined** → 按惯例推断：恰好一个 INTEGER 主键就加
   *
   * 为什么要给用户覆盖权：`AUTOINCREMENT` 不只是"自增"，它改变 rowid 复用语义——
   * 不加时删掉最大 id 的行后再插入会复用该 id。这是有实际后果的选择
   * （比如拿 id 当对外引用时，复用会导致指向错乱），不该由实现偷偷决定。
   */
  if (primaryKeys.length === 1 && primaryKeys[0] !== undefined) {
    const pk = primaryKeys[0]
    const target = definitions.find((definition) => definition.name === pk.name)
    const pkCol = spec.columns.find((c) => c.name === pk.name)
    if (target !== undefined) {
      const isInteger = /\bINTEGER\b/i.test(target.sql)
      // 显式要求自增但不是单 INTEGER 主键 → 这是用户表达错误，必须报错而不是静默忽略。
      if (pkCol?.autoIncrement === true && !isInteger) {
        throw new SqliteAdapterError(
          'bad_params',
          `列「${pk.name}」要求自增，但自增只允许用于单列 INTEGER 主键（SQLite 约束）。` +
            `当前类型不是 INTEGER。请改用 INTEGER，或取消自增。`
        )
      }
      const wantAuto = pkCol?.autoIncrement ?? isInteger
      const useAuto = isInteger && wantAuto
      target.sql += ` PRIMARY KEY${useAuto ? ' AUTOINCREMENT' : ''}`
      if (useAuto) autoIncrementByColumn.set(pk.name, true)
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
export function buildDropTableSql(quote: (name: string) => string, tableName: string): string {
  return `DROP TABLE ${quote(tableName)}`
}

/**
 * `CREATE VIEW`。
 *
 * `selectSql` 由调用方先用 `prepareReadOnlyStatement` 校验过（只读、单语句），
 * 这里只负责拼接。**不要**在这里再做一次"看起来像写操作"的字符串判断：
 * 那会用两套不一致的规则校验同一件事，迟早出现"这里过了那里没过"。
 */
export function buildCreateViewSql(quote: (name: string) => string, viewName: string, selectSql: string): string {
  return `CREATE VIEW ${quote(viewName)} AS ${selectSql}`
}

/** `DROP VIEW`。同样不做 IF EXISTS。 */
export function buildDropViewSql(quote: (name: string) => string, viewName: string): string {
  return `DROP VIEW ${quote(viewName)}`
}

/** `ALTER TABLE ... RENAME TO ...`。两边都 quote。 */
export function buildRenameTableSql(quote: (name: string) => string, oldName: string, newName: string): string {
  return `ALTER TABLE ${quote(oldName)} RENAME TO ${quote(newName)}`
}
