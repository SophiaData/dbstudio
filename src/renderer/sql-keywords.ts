/**
 * SQL 关键字表（用于语法高亮与自动补全）。
 *
 * 为什么单独一个文件、且是"手写集合"而不是从别处 import：
 *
 * 1. 高亮和补全都要一张**低频变更、无副作用**的表。放进渲染进程的模块里
 *    能保证它不依赖任何运行时（不碰 DOM、不碰 IPC），纯数据。
 * 2. 关键字表是**方言中立的**。具体方言的保留字（如 SQLite 的 `ROWID`、
 *    Postgres 的 `ILIKE`）属于方言元数据，应该走 `getMetadataCandidates()`，
 *    不要混进这份通用表，否则高亮会在别的方言上误判。
 * 3. 只收**语句级/子句级**关键字与常见函数名，避免把"看起来像关键字"
 *    的普通标识符（如 `name`、`value`）收进来导致高亮噪声。
 *
 * 大小写约定：全部小写存储，匹配时统一 `toLowerCase()`，这样
 * "大小写不敏感"这条规则只在一处实现（见 sql-format.ts 的 isKeyword）。
 */

/** 语句起始 / 子句 / 连接 / 运算符类关键字。 */
export const SQL_STATEMENT_KEYWORDS: readonly string[] = [
  'select', 'from', 'where', 'group', 'by', 'having', 'order', 'limit', 'offset',
  'insert', 'into', 'values', 'update', 'set', 'delete', 'replace',
  'create', 'table', 'view', 'index', 'trigger', 'drop', 'alter', 'rename', 'to',
  'join', 'inner', 'left', 'right', 'outer', 'full', 'cross', 'on', 'using',
  'union', 'all', 'distinct', 'as', 'and', 'or', 'not', 'in', 'exists', 'between',
  'like', 'glob', 'is', 'null', 'case', 'when', 'then', 'else', 'end', 'cast',
  'with', 'recursive', 'asc', 'desc', 'primary', 'key', 'foreign', 'references',
  'unique', 'check', 'default', 'constraint', 'auto_increment', 'autoincrement',
  'if', 'begin', 'commit', 'rollback', 'transaction', 'explain', 'query', 'plan',
  'analyze', 'vacuum', 'attach', 'detach', 'database', 'pragma', 'temporary', 'temp'
]

/** 常用 SQL 函数名（高亮用，不进补全的"对象"语义）。 */
export const SQL_FUNCTION_KEYWORDS: readonly string[] = [
  'count', 'sum', 'avg', 'min', 'max', 'total', 'group_concat',
  'length', 'lower', 'upper', 'trim', 'ltrim', 'rtrim', 'substr', 'substring',
  'replace', 'instr', 'printf', 'format', 'round', 'abs', 'random', 'hex', 'quote',
  'coalesce', 'ifnull', 'nullif', 'typeof', 'date', 'time', 'datetime', 'julianday',
  'strftime', 'unixepoch', 'last_insert_rowid', 'changes', 'row_number', 'rank',
  'dense_rank', 'ntile', 'lag', 'lead', 'first_value', 'last_value'
]

/** 补全候选用的全集（关键字 + 函数），已去重、保持稳定顺序。 */
export const SQL_COMPLETION_KEYWORDS: readonly string[] = Array.from(
  new Set<string>([...SQL_STATEMENT_KEYWORDS, ...SQL_FUNCTION_KEYWORDS])
)

const STATEMENT_SET: ReadonlySet<string> = new Set(SQL_STATEMENT_KEYWORDS)
const FUNCTION_SET: ReadonlySet<string> = new Set(SQL_FUNCTION_KEYWORDS)

/** 是否语句/子句关键字（大小写不敏感）。 */
export function isStatementKeyword(word: string): boolean {
  return STATEMENT_SET.has(word.toLowerCase())
}

/** 是否函数名（大小写不敏感）。 */
export function isFunctionKeyword(word: string): boolean {
  return FUNCTION_SET.has(word.toLowerCase())
}

/** 是否任一关键字（高亮/格式化统一入口，大小写不敏感）。 */
export function isSqlKeyword(word: string): boolean {
  const lower = word.toLowerCase()
  return STATEMENT_SET.has(lower) || FUNCTION_SET.has(lower)
}
