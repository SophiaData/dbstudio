/**
 * SQLite 驱动适配器（本项目的第一个真实驱动实现）。
 *
 * ===== 它运行在哪里 =====
 *
 * 这个文件**只在驱动宿主进程里执行**（见 `core/driver.ts` 文件头：
 * Node 没有 Java 的 URLClassLoader，多版本驱动无法共存，所以用进程隔离代替类加载隔离）。
 * 因此这里可以放心地把"连接句柄"作为实例状态持有——
 * 一个 adapter 实例、一个连接、一个进程，天然没有跨连接的串扰。
 * 但也正因为跨进程，所有从 `ObjectRef.meta` 出去的东西必须是可结构化克隆的原始值。
 *
 * ===== 为什么用 node:sqlite 而不是 better-sqlite3 =====
 *
 * Electron 45 内置的 Node 24 已带 `node:sqlite`（同步 API，无需 flag）。
 * 而 better-sqlite3 是原生模块，必须为每个 Electron ABI 重新编译——
 * 这会直接违背本项目的核心决策：驱动的安装不该依赖本机编译工具链。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { ConnectionConfig } from '../../core/dialect'
import type { DriverAdapter, SecretValue, TestConnectionResult } from '../../core/driver'
import type { DriverCapabilities, ObjectRef, TableDescription, ColumnDescription } from '../../core/model'
import type { DriverFactory } from '../../core/registry'
import type {
  CellValue,
  EditApplyResult,
  QueryOptions,
  QueryResult,
  ResultPage,
  RowEditOutcome,
  RowUpdate,
  TransactionState
} from '../../core/resultset'

import { sqliteDialect } from './dialect'
import {
  buildUpdateParams,
  buildUpdateSql,
  mustGetValue,
  resolveColumns,
  type ColumnMatch,
  type SqliteBind
} from './edits'
import {
  buildCountSql,
  buildDeleteParams,
  buildDeleteSql,
  buildInsertParams,
  buildInsertSql,
  normalizeInsertValues
} from './mutations'
import { SqliteAdapterError, describeThrown } from './errors'
import { SQLITE_INFO } from './info'
import {
  TABLES_FOLDER_ID,
  VIEWS_FOLDER_ID,
  columnObjectId,
  parseObjectId,
  tableObjectId,
  viewObjectId
} from './ids'
import {
  buildColumns,
  buildPagedSql,
  buildRows,
  normalizeOffset,
  normalizePageSize,
  prepareReadOnlyStatement,
  readGrid,
  toFullCellValue,
  cellByName,
  type RawGrid
} from './results'

// 错误类已移到 errors.ts（为了打断 adapter ↔ results 的循环导入），
// 这里再导出一次，避免外部已有的 `import { SqliteAdapterError } from './adapter'` 失效。
export { SqliteAdapterError } from './errors'

/**
 * 忙等超时：另一个进程/连接持有写锁时先等，而不是立刻抛 SQLITE_BUSY。
 * 桌面客户端很容易出现"编辑器里改了没提交、客户端这边写不进去"的场景，
 * 等 5 秒比弹一个用户看不懂的 busy 错误友好。
 */
const BUSY_TIMEOUT_MS = 5_000

/**
 * 能力声明。
 *
 * 注意 `supportsInlineEdit: true` 说的是"**这个方言具备**在线编辑能力"，
 * 而不是"当前这张表能编辑"——后者由 `describeTable().hasUniqueKey` 逐表决定
 * （对应 DBeaver 的 `DBDRowIdentifier` 缺失判定）。两个层级不要混。
 */
const SQLITE_CAPABILITIES: DriverCapabilities = {
  hasCatalog: false,
  hasSchema: false,
  supportsServerPagination: true,
  supportsCancel: false,
  supportsInlineEdit: true
}

/** PRAGMA table_info 的一行，先收窄成本模块自己的形状，避免 SQLOutputValue 的联合类型到处扩散。 */
interface RawColumn {
  readonly name: string
  readonly typeName: string
  readonly nullable: boolean
  /** 主键内的序号（1 起）；不属于主键为 null。 */
  readonly primaryKeyOrdinal: number | null
  readonly defaultValue: string | null
}

/** `unknown` 收窄助手：node:sqlite 的返回值是联合类型，直接用需要每处都写 typeof。 */
function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  // 理论上开启 readBigInts 才会出现；保留分支以免将来改了打开选项后静默变成 null
  if (typeof value === 'bigint') return Number(value)
  return null
}

/**
 * 从 `ConnectionConfig.options` 解析数据库文件路径。
 *
 * `options` 的类型是 `Record<string, string | number | boolean>`，
 * 也就是编译期无法保证 `file` 存在且是字符串（配置可能来自手写的 JSON），
 * 所以必须运行时收窄。
 */
function resolveDatabaseFile(config: ConnectionConfig): string {
  const raw = config.options['file']
  const file = typeof raw === 'string' ? raw.trim() : ''
  if (file === '') {
    throw new SqliteAdapterError(
      'connection_failed',
      `连接「${config.name}」缺少数据库文件路径：请在连接设置里选择或填写一个 SQLite 文件（.db / .sqlite）。`
    )
  }
  /**
   * 拒绝相对路径而不是"帮忙 resolve"。
   * 因为 adapter 跑在**驱动宿主子进程**里，它的 cwd 未必等于用户以为的目录，
   * 猜出来的路径会让用户对着一个"明明存在却报不存在"的路径发懵。
   */
  if (!isAbsolute(file)) {
    throw new SqliteAdapterError(
      'connection_failed',
      `SQLite 数据库路径必须是绝对路径，当前填写的是相对路径：${file}（驱动运行在独立子进程里，相对路径无法可靠解析）`
    )
  }
  return file
}

/** 打开结果：句柄 + 该连接的"行读取模式"探测结果（见 probeArrayMode）。 */
interface OpenedDatabase {
  readonly db: DatabaseSync
  readonly arrayMode: boolean
}

/**
 * 一次 applyEdits 的目标表信息。
 *
 * 解释成独立结构而不是三个参数传来传去：校验一次、多处复用，
 * 避免"校验用的是这张表、执行时用了另一个名字"这类错位。
 */
interface EditableTarget {
  readonly tableName: string
  /** 表的全部列名，用于报错时"列出可选项"。 */
  readonly availableColumns: readonly string[]
  /** 主键列（按主键序号排序），WHERE 子句的全部内容。 */
  readonly keyColumns: readonly string[]
  /**
   * 列名（小写）→ 声明类型。只用于判断"主键是不是 rowid 别名"（见 #isRowidAlias）。
   * 单独存一份而不是回头再查 PRAGMA：`insertRow` 会在插入后用到它，
   * 再查一次既慢又要处理"表在这期间被改"的情况。
   */
  readonly columnTypes: ReadonlyMap<string, string>
}

/**
 * 一个已打开的结果集游标。
 *
 * 只存 SQL 文本，不存行数据——这是"随机取页"路线的核心：
 * 内存占用与结果集大小无关（完整取舍见 results.ts 文件头）。
 */
interface CursorState {
  /** 用户原始 SQL 的**只读校验后的第一条语句**（未包分页子句）。 */
  readonly sql: string
}

/**
 * 打开一个 SQLite 连接（调用方负责关闭）。
 *
 * 这里做两件超出"new DatabaseSync"的事，都是必要的：
 * 1. **先检查文件存在**。`DatabaseSync` 在文件不存在时会默默创建一个空库，
 *    对"打开已有数据库"这个动作来说这是危险副作用：用户打错一个字母，
 *    得到的是一个看起来正常的空库，而真实数据在别处。
 * 2. **打开后再读一次 schema**。SQLite 是惰性的：打开一个非 SQLite 文件
 *    （比如误选了 .txt）通常要到第一次查询才报 "file is not a database"。
 *    把校验提前到连接阶段，才能让 testConnection 名副其实。
 */
function openDatabase(file: string): OpenedDatabase {
  if (!existsSync(file)) {
    throw new SqliteAdapterError('connection_failed', `数据库文件不存在：${file}`)
  }
  if (!statSync(file).isFile()) {
    throw new SqliteAdapterError('connection_failed', `该路径不是文件（可能是目录）：${file}`)
  }

  let db: DatabaseSync
  try {
    db = new DatabaseSync(file, {
      /**
       * 显式写出来，不吃 `node:sqlite` 的默认值：
       * 它的默认值是"外键约束开启"，而 SQLite 本体（含 sqlite3 CLI）默认是关闭的。
       * 本项目已经在 `core/dialect.ts` 里明确反对"默认值即隐式契约"，
       * 这里同一个理由：真实行为必须写在代码里，才能被人 review 到。
       */
      enableForeignKeyConstraints: true,
      timeout: BUSY_TIMEOUT_MS,
      /**
       * 行按**列顺序**返回成数组，而不是按列名返回成对象。
       *
       * 这不是口味问题：对象模式下重复列名会互相覆盖——
       * 实测 `SELECT a AS dup, b AS dup` 只返回一个 `dup`，
       * 而 `SELECT u.id, o.id FROM users u JOIN orders o` 在真实查询里非常常见。
       * 那种情况下用户看到的会是**静默错误的数据**，比报错严重得多。
       */
      returnArrays: true,
      /**
       * 整数一律按 BigInt 返回。
       * 不开这个选项时，超出 IEEE-754 安全范围的整数会让驱动**直接抛
       * RangeError（"Value is too large to be represented as a JavaScript number"）**，
       * 也就是一条 `SELECT max(rowid)` 就能让整个查询失败。
       * 开了之后由我们在 results.ts 里决定怎么降级（小的转 number，大的保精度转文本）。
       */
      readBigInts: true
    })
  } catch (thrown) {
    throw new SqliteAdapterError(
      'connection_failed',
      `无法打开 SQLite 数据库：${file}（原始错误：${describeThrown(thrown)}）`,
      thrown
    )
  }

  try {
    // PRAGMA schema_version 是读元数据表，不依赖任何用户表，且能真正触发文件头校验
    db.prepare('PRAGMA schema_version').get()
  } catch (thrown) {
    closeQuietly(db)
    throw new SqliteAdapterError(
      'connection_failed',
      `该文件不是有效的 SQLite 数据库：${file}（原始错误：${describeThrown(thrown)}）`,
      thrown
    )
  }

  return { db, arrayMode: probeArrayMode(db) }
}

/**
 * 探测 `returnArrays` 是否真的生效。
 *
 * 该选项 Node 24.4 才有；更老的运行时（比如某个 Electron 里打包的 Node 24.0）
 * 会**忽略它**，行仍然是对象。这里不做假设，直接问一次运行时：
 * 用一条带重复列名的探测语句，看返回的是数组还是对象。
 * 探测结果决定 results.ts 里走哪条读取路径（对象模式下重名列会明确报错而不是丢数据）。
 */
function probeArrayMode(db: DatabaseSync): boolean {
  try {
    const row: unknown = db.prepare('SELECT 1 AS probe_col, 2 AS probe_col').get()
    return Array.isArray(row)
  } catch {
    // 连探测都失败说明运行时行为异常，按更保守的对象模式处理
    return false
  }
}

/** 关闭句柄且不抛错。断开连接这类"清理"动作失败时，能做的事只有继续往下走。 */
function closeQuietly(db: DatabaseSync): void {
  try {
    if (db.isOpen) db.close()
  } catch {
    // 已经关了 / 宿主进程正在退出：忽略。宿主关闭时会再调一次 disconnect，
    // 若这里抛错会把"正常退出"变成"崩溃退出"。
  }
}

/** 读 `SELECT sqlite_version()`，失败不致命（版本只用于展示）。 */
function readServerVersion(db: DatabaseSync, arrayMode: boolean): string | undefined {
  try {
    const grid = readGrid(db, 'SELECT sqlite_version()', arrayMode)
    const version = readString(grid.rows[0]?.[0])
    return version === null || version === undefined ? undefined : `SQLite ${version}`
  } catch {
    return undefined
  }
}

/**
 * 列出 sqlite_master 里的表 / 视图。
 *
 * 依据：SQLite 的元数据都在 `sqlite_master`（`sqlite_schema` 是它的新名字，
 * 老名字为了兼容一直保留，两者指向同一张表；`sqlite_temp_master` 是另一个名字空间，这里不涉及）。
 *
 * `name NOT LIKE 'sqlite\_%' ESCAPE '\'` 是必须的：
 * `sqlite_sequence`（AUTOINCREMENT 的记账表）、`sqlite_stat1`（ANALYZE 的统计表）、
 * `sqlite_autoindex_*` 等都是 SQLite 的内部对象，暴露给用户只会造成困扰。
 * 这里显式写出 `ESCAPE '\'` 让 `_` 只能匹配字面下划线——不写的话 `_` 在 LIKE 里是
 * 单字符通配符，虽然结果碰巧一样，但意图就说不清了。
 * LIKE 在 SQLite 里对 ASCII 默认不区分大小写，所以大写开头的内部表也会被一起排除。
 */
const LIST_RELATIONS_SQL: Readonly<Record<'table' | 'view', string>> = {
  table: `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
  view: `SELECT name FROM sqlite_master WHERE type = 'view' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`
}

export class SqliteDriverAdapter implements DriverAdapter {
  readonly dialect = sqliteDialect
  readonly info = SQLITE_INFO

  /**
   * 当前连接。用实例私有字段而不是模块级变量：
   * `DriverRegistry.create()` 每次都会 new 一个新实例，
   * 连接状态若挂在模块上就会互相串（测试里最容易踩这个坑）。
   */
  #db: DatabaseSync | null = null

  /**
   * 行读取模式（数组/对象），由 openDatabase 探测后带上来，供 results.ts 选择读取路径。
   * 挂在实例上而不是每次查：它只取决于运行时版本，连接期间不会变。
   */
  #arrayMode = false

  /**
   * 已打开的游标。
   *
   * 每个游标只存**一段 SQL 文本**，不存任何行数据——
   * 所以即使 UI 忘记关闭游标，内存代价也是 O(游标数 × SQL 长度)，
   * 而不是 O(行数)。这也是没有给游标数设上限的原因：
   * 加上限反而会让"打开的结果集突然失效"变成难查的偶发 bug。
   */
  #cursors = new Map<string, CursorState>()

  /**
   * 当前事务里累计影响的行数。
   *
   * 只有这一项是"我们自己的账"：事务**是否激活**一律问
   * `DatabaseSync.isTransaction`（唯一权威来源），
   * 而"改了多少行"驱动不提供，只能自己累加。
   * commit / rollback / disconnect 都会把它清零。
   */
  #pendingAffected = 0

  async connect(config: ConnectionConfig, _secret: SecretValue): Promise<DriverCapabilities> {
    /**
     * 一个 adapter 实例只服务一个连接（一个连接一个宿主进程，见 core/driver.ts）。
     * 重复 connect 说明上层状态机出了问题，这里直接报错而不是静默替换句柄——
     * 静默替换会泄漏前一个连接，而且把状态机的 bug 藏起来。
     */
    if (this.#db !== null) {
      throw new SqliteAdapterError('already_connected', '该适配器实例已持有一个连接，请先 disconnect 再重新连接。')
    }
    const file = resolveDatabaseFile(config)
    const opened = openDatabase(file)
    this.#db = opened.db
    this.#arrayMode = opened.arrayMode
    return SQLITE_CAPABILITIES
  }

  /**
   * 断开连接。**必须幂等**：宿主进程结束时会对同一个实例再调一次，
   * 那时如果抛 "database is not open"，正常的进程退出就会变成崩溃。
   *
   * 同时**必须释放所有游标**：游标本身只存 SQL 文本（不占内存），
   * 但连接一断，它们引用的查询就再也执行不了了，
   * 留着只会让后续 `fetchResultPage` 报出"游标存在但数据库没了"这种自相矛盾的错。
   */
  async disconnect(): Promise<void> {
    const db = this.#db
    // 先摘掉引用再关：即使 close 抛错，重复调用也不会去碰同一个句柄
    this.#db = null
    this.#cursors.clear()
    this.#pendingAffected = 0
    if (db === null) return
    /**
     * 有未提交事务必须先回滚再关连接。
     *
     * 如果直接 close，SQLite 自己也会回滚——但那是"依赖底层实现替我们兜底"，
     * 而且在宿主进程被强杀、或将来换成连接池时就不成立了。
     * 这里显式回滚，语义上明确：未提交的改动**不会**被带进下一次连接。
     */
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 回滚失败也只能继续关连接——此时没有更好的补救手段，
        // 而抛错会把"正常断开"变成"崩溃"
      }
    }
    closeQuietly(db)
  }

  /**
   * 测试连接：**真建一条再关掉**，不保留。
   *
   * 为什么要真建：只做"文件存在吗 / 能 stat 吗"的检查，会出现
   * "测试通过但真连不上"的经典坑（文件损坏、被别的进程独占、不是 SQLite 库）。
   * DBeaver 的测试连接也是这个语义。
   * 这个方法返回结果对象而不是抛错——它的调用方（连接对话框）需要展示失败原因。
   */
  async testConnection(config: ConnectionConfig, _secret: SecretValue): Promise<TestConnectionResult> {
    const startedAt = performance.now()
    let opened: OpenedDatabase | null = null
    try {
      const file = resolveDatabaseFile(config)
      opened = openDatabase(file)
      const serverVersion = readServerVersion(opened.db, opened.arrayMode)
      return {
        ok: true,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...(serverVersion === undefined ? {} : { serverVersion })
      }
    } catch (thrown) {
      return {
        ok: false,
        message: thrown instanceof SqliteAdapterError ? thrown.message : `连接失败：${describeThrown(thrown)}`,
        elapsedMs: Math.round(performance.now() - startedAt)
      }
    } finally {
      // 无论成功失败都要还掉句柄：测试连接不能留下悬空连接
      if (opened !== null) closeQuietly(opened.db)
    }
  }

  /**
   * 懒加载列子节点。
   *
   * 只返回**直接子节点**：绝不为了"顺便"把整棵子树读出来。
   * 依据：DBeaver 的 `cacheStructure(STRUCT_ALL)` 会在打开 ER 图时全量读元数据，
   * 大库上代价极高，剖析报告把它列为"不该照搬"的项之一。
   */
  async listChildren(parentId: string | null): Promise<ObjectRef[]> {
    const db = this.#requireDb()

    // 根层：SQLite 没有 catalog/schema，直接给两个分组（这也是分层设计的全部）
    if (parentId === null) {
      return [
        { id: TABLES_FOLDER_ID, kind: 'folder', name: '表', parentId: null, hasChildren: true },
        { id: VIEWS_FOLDER_ID, kind: 'folder', name: '视图', parentId: null, hasChildren: true }
      ]
    }

    const parsed = parseObjectId(parentId)
    if (parsed === null) {
      throw new SqliteAdapterError('object_not_found', `无法识别的对象 id：${parentId}`)
    }

    switch (parsed.kind) {
      case 'folder':
        return this.#listRelations(db, parsed.folder === 'tables' ? 'table' : 'view')
      case 'table':
        return this.#listColumns(db, parsed.name, tableObjectId(parsed.name))
      case 'view':
        /**
         * 视图也返回列：`PRAGMA table_info` 对视图同样有效，而且视图**确实**有列。
         * 若这里谎报 hasChildren=false，UI 就不会给视图画展开箭头，
         * 用户会以为视图没有列——这是与事实不符的。
         */
        return this.#listColumns(db, parsed.name, viewObjectId(parsed.name))
      case 'column':
        // 列是叶子。理论上 UI 不会调用（那里 hasChildren=false），容错返回空数组
        return []
    }
  }

  /**
   * 读取表结构：列 + 唯一键判定。
   *
   * `hasUniqueKey` 按规格取"存在主键"。需要说明两处已知的近似：
   * 1. 严格说能当行标识的还有 UNIQUE 索引（DBeaver 的 `DBDRowIdentifier`
   *    就是主键/唯一索引一起看），这里先只认主键。
   * 2. SQLite 的普通表都有隐式 rowid，理论上也能唯一定位一行，
   *    但 rowid 不出现在 `PRAGMA table_info` 里，UI 网格也看不到它。
   * 所以"无主键表"会被判为不可编辑——偏保守，符合"宁可少给能力也不给错能力"。
   */
  async describeTable(id: string): Promise<TableDescription> {
    const db = this.#requireDb()
    const parsed = parseObjectId(id)
    if (parsed === null || (parsed.kind !== 'table' && parsed.kind !== 'view')) {
      throw new SqliteAdapterError(
        'object_not_found',
        `describeTable 只接受表或视图节点，收到的 id 是：${id}`
      )
    }

    const columns = this.#readColumns(db, parsed.name).map(
      (raw): ColumnDescription => ({
        name: raw.name,
        typeName: raw.typeName,
        nullable: raw.nullable,
        primaryKeyOrdinal: raw.primaryKeyOrdinal,
        defaultValue: raw.defaultValue
      })
    )

    return {
      // 回填规范化后的 id（转义/大小写保持不变，但保证与列表节点用同一套构造函数）
      id: parsed.kind === 'table' ? tableObjectId(parsed.name) : viewObjectId(parsed.name),
      columns,
      hasUniqueKey: columns.some((column) => column.primaryKeyOrdinal !== null)
    }
  }

  /**
   * 执行查询并**只返回第一页**。
   *
   * 为什么不一次拿全：`StatementSync.all()` 会把结果全部读进内存，
   * 百万行表直接把宿主进程撑爆；而且跨进程把整表塞给渲染进程，
   * 那些行在网格里绝大多数是永远不会被看到的 garbage
   * （`core/resultset.ts` 文件头解释了这个取舍）。
   */
  async query(sql: string, options?: QueryOptions): Promise<QueryResult> {
    const db = this.#requireDb()
    // 先校验再执行：写操作/多语句在这一步就被挡掉，不会有任何 SQL 到达引擎
    const statementSql = prepareReadOnlyStatement(sql)
    const limit = normalizePageSize(options?.limit)
    const offset = normalizeOffset(options?.offset)
    const executedSql = buildPagedSql(statementSql, limit, offset)

    const startedAt = performance.now()
    const grid = this.#runStatement(db, executedSql)
    const elapsedMs = Math.round(performance.now() - startedAt)

    /**
     * `keepCursor` 默认 true：绝大多数查询后面都会被翻页。
     * 传 false 用于"只想知道结果长什么样"的一次性查询（如 SELECT COUNT(*)），
     * 免得留下一个永远不会被关闭的游标。
     */
    const cursorId = options?.keepCursor === false ? null : this.#openCursor(statementSql)

    return {
      columns: buildColumns(grid),
      rows: buildRows(grid, offset),
      offset,
      returned: grid.rows.length,
      // 取满一页就认为"可能还有更多"——不做 COUNT(*)：
      // 那是全表扫描，不能为了一个滚动条箭头付这个代价（依据见 core/resultset.ts）
      hasMore: grid.rows.length === limit,
      cursorId,
      executedSql,
      elapsedMs
    }
  }

  /**
   * 从游标按偏移量取一页。
   *
   * 每次取页都是**重新执行** `SELECT * FROM (原 SQL) LIMIT n OFFSET m`，
   * 因此天然支持乱序取页（网格往回滚不会失效），代价是深翻页越来越慢——
   * 完整分析写在 `results.ts` 文件头，不在这里重复，但要知道它确实存在。
   */
  async fetchResultPage(cursorId: string, offset: number, limit: number): Promise<ResultPage> {
    const db = this.#requireDb()
    const cursor = this.#cursors.get(cursorId)
    if (cursor === undefined) {
      throw new SqliteAdapterError(
        'object_not_found',
        `结果集游标不存在或已关闭：${cursorId}（结果集可能已被关闭，或连接断过）`
      )
    }

    const pageSize = normalizePageSize(limit)
    const start = normalizeOffset(offset)
    const grid = this.#runStatement(db, buildPagedSql(cursor.sql, pageSize, start))

    return {
      // 每页都带列元信息：渲染进程不必另外记一份，也不必假设前后页结构一致
      columns: buildColumns(grid),
      rows: buildRows(grid, start),
      offset: start,
      returned: grid.rows.length,
      hasMore: grid.rows.length === pageSize
    }
  }

  /**
   * 释放游标。**幂等**：关闭结果集标签页、宿主进程退出都可能重复调用，
   * 一个"已经不存在的游标"不该让清理流程失败。
   */
  async closeCursor(cursorId: string): Promise<void> {
    this.#cursors.delete(cursorId)
  }

  /**
   * 插入一行并回传**新行的主键值**。
   *
   * ===== 为什么必须回传主键 =====
   *
   * UI 提交后要刷新网格并"定位到刚插入的那一行"。
   * 如果只返回 affected=1，前端只能整表重查再猜哪行是新的——
   * 在并发写入下猜错就是给用户高亮错行。
   * 所以这里显式回传主键值（主键由数据库生成时尤其必要，前端拿不到自增值）。
   *
   * ===== 主键值怎么拿 =====
   *
   * 两条来源，按主键的"是否由数据库生成"分别处理：
   *   - 调用方显式给了主键值 → 用的就是它（原样回传，不做任何"推断"）
   *   - 调用方没给（典型：INTEGER PRIMARY KEY 自增）→ 读 `lastInsertRowid`
   *     仅当该表的唯一主键列**恰好是 rowid 别名**时才这么填；
   *     否则 `lastInsertRowid` 与那个列无关（比如 TEXT 主键 + 别的自增列），
   *     这种情况我们**不编造**，返回空 keyValues 让 UI 重查——
   *     宁可多一次查询，也不能回传一个可能是错的主键。
   */
  async insertRow(
    tableId: string,
    values: Readonly<Record<string, CellValue>>
  ): Promise<{ affected: number; keyValues: Record<string, CellValue> }> {
    const db = this.#requireDb()
    // 插入不需要主键定位（见 #resolveTableTarget 的注释）
    const target = this.#resolveTableTarget(db, tableId, false)

    const normalized = normalizeInsertValues(values, target.availableColumns)
    if (normalized.unknown.length > 0) {
      throw new SqliteAdapterError(
        'bad_params',
        `插入时引用了不存在的列：${normalized.unknown.join('、')}。` +
          `「${target.tableName}」的可用列：${target.availableColumns.join('、')}`
      )
    }
    if (normalized.columns.length === 0) {
      throw new SqliteAdapterError(
        'bad_params',
        '插入时必须至少提供一个列的值。若要插入一行全默认值，请在 SQL 窗口执行 INSERT ... DEFAULT VALUES。'
      )
    }

    const inOwnTransaction = this.#ensureTransaction(db)
    const sql = buildInsertSql(this.dialect.quoteIdentifier, target.tableName, normalized.columns)
    let insertedRowid = 0
    try {
      const params = buildInsertParams(normalized.columns, normalized.byColumn)
      insertedRowid = this.#runInsert(db, sql, params)
    } catch (thrown) {
      // 失败时按"本次操作没有产生任何改动"收尾：
      // 若事务是本方法开的，就撤掉它，别让一个失败的插入留下空事务
      this.#releaseFailedOwnTransaction(db, inOwnTransaction)
      if (thrown instanceof SqliteAdapterError) throw thrown
      throw new SqliteAdapterError('query_failed', `插入失败：${describeThrown(thrown)}`, thrown)
    }

    this.#pendingAffected += 1
    return { affected: 1, keyValues: this.#resolveInsertedKeyValues(target, normalized.byColumn, insertedRowid) }
  }

  /**
   * 删除一批行。
   *
   * ===== 为什么空数组必须在这里挡掉 =====
   *
   * `DELETE FROM t`（没有 WHERE）会清空整表。
   * 这不是"用户写错 SQL"才有的风险：一个 UI bug（比如选中行为 0 却仍点了删除）
   * 就能把空数组传进来。SQL 注入至少还需要有人恶意构造，这个只要一次误触。
   * 所以拒绝放在适配器层最靠近执行的地方，而不是指望每个调用方都记得检查。
   *
   * 与 applyEdits 共用完全相同的做法：主键定位、参数化、同一事务、逐行 outcome、
   * 任何一行失败都**不自动回滚**（由上层决定，UI 才能说清"第几行失败"）。
   */
  async deleteRows(
    tableId: string,
    keys: readonly Readonly<Record<string, CellValue>>[]
  ): Promise<EditApplyResult> {
    const db = this.#requireDb()

    /**
     * 空数组检查放在最前面，且**早于**表级校验：
     * 这个请求本身就是危险的，原因应该直接说"空数组会删全表"，
     * 而不是先被"表没有主键"之类的错误盖掉（那样的提示会让人误以为
     * 只要给表加个主键就能删，实际上传空数组仍然危险）。
     */
    if (keys.length === 0) {
      throw new SqliteAdapterError(
        'bad_params',
        '拒绝执行删除：没有指定任何要删除的行。空条件会删除整张表的所有数据，' +
          '因此适配器层直接禁止空 keys（如确需清空表，请在 SQL 窗口显式执行 DELETE FROM 或 DROP）。'
      )
    }

    const target = this.#resolveTableTarget(db, tableId, true)
    // 全部行级校验先做完，再开事务
    for (let index = 0; index < keys.length; index += 1) {
      const keyValues = keys[index]
      if (keyValues === undefined) continue
      this.#resolveRowKeys(target, keyValues, index + 1, '删除')
    }

    const inOwnTransaction = this.#ensureTransaction(db)
    const outcomes: RowEditOutcome[] = []
    let affectedTotal = 0
    let aborted = false

    for (let index = 0; index < keys.length; index += 1) {
      const keyValues = keys[index]
      if (keyValues === undefined) continue
      const outcome = this.#applyOneDelete(db, target, keyValues, index)
      outcomes.push(outcome)
      if (outcome.error === null) {
        affectedTotal += outcome.affected
        continue
      }
      /**
       * 删除路径上遇到"执行失败"就停手，不再继续删后面的行：
       * 继续删只会在一个已经出错的批次里多删几行，而事务最终很可能被回滚，
       * 白白增加"回滚前改了更多东西"的风险。剩下的行明确标记为"未执行"。
       */
      aborted = true
      for (let rest = index + 1; rest < keys.length; rest += 1) {
        outcomes.push({
          index: rest,
          affected: 0,
          error: `未执行：第 ${index + 1} 行删除失败，为避免连带影响已停止后续删除。`,
          sql: ''
        })
      }
      break
    }

    this.#pendingAffected += affectedTotal
    if (aborted && inOwnTransaction) {
      /**
       * 本方法自己开的事务里已经出现失败：不提交、也不静默吞掉。
       * 保留事务让上层能看到 state.active 并显式 rollback（与 applyEdits 一致）。
       */
    }
    return { affected: affectedTotal, outcomes, ok: !aborted, inTransaction: db.isTransaction }
  }

  /**
   * 统计行数。
   *
   * ⚠️ **性能：这是全表扫描**。SQLite 的 `COUNT(*)` 没有元数据缓存，
   * 大表上可能秒级乃至更久，且会持读锁。
   * 所以它只在用户**显式请求**（点"统计行数"）时被调用，
   * 绝不能塞进 `listChildren` 里"顺手"算一下——
   * 那会让每次展开表节点都付一次全表扫描的代价（DBeaver 的经验教训）。
   */
  async countRows(tableId: string): Promise<number> {
    const db = this.#requireDb()
    // COUNT 不需要主键：它不定位任何行
    const target = this.#resolveTableTarget(db, tableId, false)
    const sql = buildCountSql(this.dialect.quoteIdentifier, target.tableName)
    try {
      const grid = readGrid(db, sql, this.#arrayMode)
      const raw = grid.rows[0]?.[0]
      // readBigInts 已开启 → COUNT 结果是 bigint；超过安全范围说明行数离谱，
      // 此时返回 Number.MAX_SAFE_INTEGER 并在注释里说明（不静默给一个错数）
      const count = readNumber(raw)
      if (count === null) {
        throw new SqliteAdapterError('query_failed', `统计行数返回了无法解析的值：${String(raw)}`)
      }
      return count
    } catch (thrown) {
      if (thrown instanceof SqliteAdapterError) throw thrown
      throw new SqliteAdapterError('query_failed', `统计行数失败：${describeThrown(thrown)}`, thrown)
    }
  }

  /**
   * 按游标 + 行列下标取某个单元格的**完整值**（不截断）。
   *
   * ===== 为什么不能直接复用 fetchResultPage =====
   *
   * 分页接口为了让单帧不撑爆 IPC，把超长文本截断到 `MAX_CELL_TEXT_CHARS`
   * 并标 `truncated: true`（见 core/resultset.ts）。用户看到一个
   * "……" 结尾的值却没有任何办法看全文——这是真实的功能缺口。
   *
   * ===== 实现方式与它的代价 =====
   *
   * 重新执行一次游标 SQL、把这一行取出来（`LIMIT 1 OFFSET rowIndex`），
   * 然后**只对这一格**做"不截断"的转换。
   *
   * 代价有两层，都写在这里不回避：
   * 1. **深行取格很慢**：`OFFSET rowIndex` 要求数据库先跳过 rowIndex 行。
   *    与 fetchResultPage 的深翻页代价同源。对大结果集的深处取值会明显变慢。
   * 2. **可能读到一个不一致的值**：用户 SQL 非确定（如 `SELECT random()`）
   *    或底层表在此期间被改，重取的值可能与网格上显示的不同。
   *    这是"不缓存整表"的必然结果，接受它；但 UI 侧应当把它当成
   *    "重新取一次"，而不是"这就是网格里那个值"。
   */
  async fetchCellValue(cursorId: string, rowIndex: number, columnIndex: number): Promise<CellValue> {
    const db = this.#requireDb()
    const cursor = this.#cursors.get(cursorId)
    if (cursor === undefined) {
      throw new SqliteAdapterError(
        'object_not_found',
        `结果集游标不存在或已关闭：${cursorId}（结果集可能已被关闭，或连接断过）`
      )
    }

    const row = normalizeOffset(rowIndex)
    const column = normalizeOffset(columnIndex)
    // 一次只取一行：LIMIT 1 OFFSET row
    const grid = this.#runStatement(db, buildPagedSql(cursor.sql, 1, row))
    const targetRow = grid.rows[0]
    if (targetRow === undefined) {
      throw new SqliteAdapterError('object_not_found', `结果集里没有第 ${row} 行（可能已到末尾）。`)
    }
    if (column >= grid.names.length) {
      throw new SqliteAdapterError(
        'bad_params',
        `列下标 ${column} 越界：这条查询只有 ${grid.names.length} 列。`
      )
    }

    // 关键差别：这里用 toFullCellValue（不截断），而不是分页用的 toCellValue
    return toFullCellValue(targetRow[column])
  }

  /**
   * 应用一批行更新。**不会自动提交**。
   *
   * ===== 与只读护栏的关系（这一条很容易做错）=====
   *
   * `query()` 会用 `prepareReadOnlyStatement` 拦住用户输入的 UPDATE/DELETE；
   * 而这里执行的是**适配器自己生成的** UPDATE，它不该被自己的护栏拦住。
   * 两者的边界不是"关掉护栏"，而是**两条独立的代码路径**：
   *   - 用户 SQL → `query()` → `prepareReadOnlyStatement`（关键词扫描）
   *   - 内部写入 → 本方法 → `#runWrite`（值全部参数化，标识符全部 quote）
   * 也就是说护栏的强度没有被削弱，只是内部写入不经过它；
   * 反过来，本方法的能力也被限制在"按主键改已知列"这一个形态上。
   *
   * ===== 事务策略 =====
   *
   * 不在事务中就 `BEGIN IMMEDIATE`，已在事务中则复用（不嵌套——SQLite 会直接报错）。
   * 用 IMMEDIATE 而不是裸 BEGIN：立刻拿写锁，
   * 避免"读完才发现别人也改了"导致 SQLITE_BUSY 推迟到提交时才爆发。
   *
   * **任何一行失败都不自动回滚**：把逐行 error 返回给上层，由它决定回滚还是人工处理。
   * 这样 UI 才能说清"第 3 行失败了"，而不是一句"整批失败"。
   */
  async applyEdits(tableId: string, updates: readonly RowUpdate[]): Promise<EditApplyResult> {
    const db = this.#requireDb()

    // 全部校验先做完再开事务：校验失败时不应该留下一个空事务
    const target = this.#resolveEditableTarget(db, tableId, updates)
    if (updates.length === 0) {
      return { affected: 0, outcomes: [], ok: true, inTransaction: db.isTransaction }
    }

    if (!db.isTransaction) {
      this.#execTransaction(db, 'BEGIN IMMEDIATE')
      // 新事务从 0 开始累计（上一轮的计数已在 commit/rollback 时清掉）
      this.#pendingAffected = 0
    }

    const outcomes: RowEditOutcome[] = []
    let affectedTotal = 0
    for (let index = 0; index < updates.length; index += 1) {
      const update = updates[index]
      if (update === undefined) continue // noUncheckedIndexedAccess 收窄
      outcomes.push(this.#applyOneUpdate(db, target, update, index))
      const affected = outcomes[outcomes.length - 1]?.affected ?? 0
      affectedTotal += affected
    }

    this.#pendingAffected += affectedTotal
    return {
      affected: affectedTotal,
      outcomes,
      ok: outcomes.every((outcome) => outcome.error === null),
      inTransaction: db.isTransaction
    }
  }

  /**
   * 提交当前事务。**无活动事务时抛错**。
   *
   * 为什么不能"静默成功"：UI 的"应用"按钮点下去会显示"已提交"，
   * 如果实际上什么也没发生（比如改动早已被回滚），用户会带着
   * "已经存好了"的错误认知继续工作——这比报错严重得多。
   */
  async commitTransaction(): Promise<TransactionState> {
    const db = this.#requireDb()
    if (!db.isTransaction) {
      throw new SqliteAdapterError('bad_params', '当前没有未提交的事务，无法提交。')
    }
    this.#execTransaction(db, 'COMMIT')
    this.#pendingAffected = 0
    return { active: db.isTransaction, pendingAffected: this.#pendingAffected }
  }

  /**
   * 回滚当前事务。**幂等**：没有事务时返回"未激活"而不是报错。
   *
   * 与 commit 的差别是刻意的：回滚是"撤销"语义，重复调用不会造成误解；
   * 提交是"确认保存"语义，重复调用就会误导用户。
   * 连接已断开时同样返回未激活——清理路径上不该抛错。
   */
  async rollbackTransaction(): Promise<TransactionState> {
    const db = this.#db
    if (db === null) return { active: false, pendingAffected: 0 }
    if (db.isTransaction) this.#execTransaction(db, 'ROLLBACK')
    this.#pendingAffected = 0
    return { active: db.isTransaction, pendingAffected: this.#pendingAffected }
  }

  /**
   * 查询事务状态。
   *
   * `active` 直接取自 `DatabaseSync.isTransaction`，而不是我们另记一个布尔量：
   * 连接的真实状态只有一个权威来源，自己再记一份迟早会不同步
   * （比如某条语句隐式结束了事务）。
   * 只有"累计影响了多少行"是我们自己的账，因为驱动不提供这个信息。
   * 未连接时返回未激活——UI 轮询状态不该抛错。
   */
  async transactionState(): Promise<TransactionState> {
    const db = this.#db
    if (db === null) return { active: false, pendingAffected: 0 }
    return { active: db.isTransaction, pendingAffected: this.#pendingAffected }
  }

  /** 拿连接，拿不到就用 not_connected 明确报错（UI 据此提示"连接已断开"）。 */
  #requireDb(): DatabaseSync {
    if (this.#db === null) {
      throw new SqliteAdapterError('not_connected', '尚未连接到数据库，请先建立连接。')
    }
    return this.#db
  }

  #listRelations(db: DatabaseSync, type: 'table' | 'view'): ObjectRef[] {
    /**
     * 走 `#runStatement` 而不是直接 `.all()`：连接是 `returnArrays: true` 打开的，
     * 直接 `.all()` 拿到的是**数组行**，`row['name']` 会静默得到 undefined，
     * 于是列表变成空——不报错，只是什么都没有。统一走网格读取才能两边都正确。
     */
    const grid = this.#runStatement(db, LIST_RELATIONS_SQL[type])
    const parentId = type === 'table' ? TABLES_FOLDER_ID : VIEWS_FOLDER_ID
    const refs: ObjectRef[] = []
    for (const row of grid.rows) {
      const name = readString(row[0])
      if (name === null) continue // 理论上不会发生；宁可少一个节点也不要塞进 undefined
      refs.push({
        id: type === 'table' ? tableObjectId(name) : viewObjectId(name),
        kind: type,
        name,
        parentId,
        // 表/视图都能展开出列，所以这里诚实地回答 true
        hasChildren: true
      })
    }
    return refs
  }

  #listColumns(db: DatabaseSync, ownerName: string, ownerObjectId: string): ObjectRef[] {
    return this.#readColumns(db, ownerName).map((raw): ObjectRef => ({
      id: columnObjectId(ownerName, raw.name),
      kind: 'column',
      name: raw.name,
      parentId: ownerObjectId,
      hasChildren: false,
      /**
       * meta 只放原始值：它要跨进程结构化克隆。
       * 放连接对象/函数会在这里编译得过、在运行时炸。
       */
      meta: {
        typeName: raw.typeName,
        nullable: raw.nullable,
        primaryKeyOrdinal: raw.primaryKeyOrdinal
      }
    }))
  }

  /**
   * 读取一个表/视图的列信息。
   *
   * 用 `PRAGMA table_info` 而不是解析 `sqlite_master.sql` 的建表语句：
   * 后者要写一个 SQL 解析器，且解析不了 `CREATE TABLE AS SELECT` 之类的写法；
   * PRAGMA 是 SQLite 官方给的元数据接口，答案就是权威的。
   *
   * 注意 PRAGMA **不支持参数绑定**（`PRAGMA table_info(?)` 的参数不会被当成表名），
   * 所以只能拼字符串。拼接用的是 `quoteIdentifier`（双引号 + 内部引号翻倍），
   * 表名里带 `"` 也不会破坏语句结构。
   */
  #readColumns(db: DatabaseSync, name: string): RawColumn[] {
    let grid: RawGrid
    try {
      /**
       * 表名只能拼进 SQL，不能绑定参数：PRAGMA 不接受占位符当对象名
       * （`PRAGMA table_info(?)` 的参数会被当成字面文本）。
       */
      grid = readGrid(db, `PRAGMA table_info(${this.dialect.quoteIdentifier(name)})`, this.#arrayMode)
    } catch (thrown) {
      // 已在 readGrid 里包装过的错误原样上抛，避免套两层"原始错误"
      if (thrown instanceof SqliteAdapterError) throw thrown
      throw new SqliteAdapterError(
        'query_failed',
        `读取表结构失败：${name}（原始错误：${describeThrown(thrown)}）`,
        thrown
      )
    }

    /**
     * PRAGMA 对不存在的对象返回空集而不报错，这里补一次存在性检查，
     * 否则"表被删了但树没刷新"会被显示成"这张表一列都没有"。
     * 只在空结果时才多查一次，正常路径没有额外开销。
     * 用 COLLATE NOCASE 对齐 SQLite 标识符大小写不敏感的行为——
     * 否则 `table:Users` 与库里的 `users` 会被判成不存在。
     */
    if (grid.rows.length === 0 && !objectExists(db, name, this.#arrayMode)) {
      throw new SqliteAdapterError('object_not_found', `对象不存在（可能已被删除，请刷新）：${name}`)
    }

    const columns: RawColumn[] = []
    for (const row of grid.rows) {
      // 按列名取值而不写死下标：PRAGMA 的列顺序是未承诺的实现细节
      const columnName = readString(cellByName(grid, row, 'name'))
      if (columnName === null) continue
      // pk 是"主键内的序号"，0 表示不属于主键；多列主键就是 1、2、3
      const pk = readNumber(cellByName(grid, row, 'pk'))
      columns.push({
        name: columnName,
        // 未声明类型时 PRAGMA 返回空串：原样保留（SQLite 允许无类型列），
        // 不要替用户编一个类型名出来
        typeName: readString(cellByName(grid, row, 'type')) ?? '',
        /**
         * notnull 是 0/1 整数，语义是"列上有没有 NOT NULL 约束"。
         *
         * 有个真实的坑要记下来：`INTEGER PRIMARY KEY`（rowid 别名）在这里返回
         * notnull=0，尽管这一列实际上不可能为 NULL（实测 SQLite 3.52.0）。
         * 我们**照实转述 PRAGMA**，而不是在模型里替 SQLite "修"这个不一致：
         * `nullable` 回答的是"建表语句里有没有写 NOT NULL"，
         * 能不能为空由主键约束决定，那部分信息已经在 primaryKeyOrdinal 里了。
         * 上层若要判断"这一列会不会是 NULL"，应当同时看这两个字段。
         */
        nullable: (readNumber(cellByName(grid, row, 'notnull')) ?? 0) === 0,
        primaryKeyOrdinal: pk !== null && pk > 0 ? pk : null,
        defaultValue: readString(cellByName(grid, row, 'dflt_value'))
      })
    }
    return columns
  }

  /**
   * 统一的结果读取入口：执行 → 归一化成"按列下标取值"的网格。
   *
   * 把执行与读取收在一个方法里，是因为"用哪种模式读行"（数组 / 对象）
   * 必须和连接打开时的选项**严格配套**——散在各个调用点迟早会漏掉一处。
   */
  #runStatement(db: DatabaseSync, sql: string): RawGrid {
    try {
      return readGrid(db, sql, this.#arrayMode)
    } catch (thrown) {
      // SqliteAdapterError 已经是可读信息（比如重名列那条），原样往上抛
      if (thrown instanceof SqliteAdapterError) throw thrown
      throw new SqliteAdapterError(
        'query_failed',
        `查询执行失败（原始错误：${describeThrown(thrown)}）`,
        thrown
      )
    }
  }

  /**
   * 解析并校验**表级**编辑目标（表名、可用列、主键列）。
   *
   * 拆出"表级"与"行级"两层校验是刻意的：
   * - 表级（这里）：表存在、不是视图、有主键 → 三条路径（UPDATE/INSERT/DELETE 共用）
   * - 行级：每条更新/删除是否覆盖了全部主键列 → 只有 UPDATE/DELETE 需要
   *
   * 为什么把"缺主键"放在表级：它是一条表属性，与传了几行无关。
   * 先做表级校验，也让 `deleteRows([])` 这种请求在检查空数组**之前**
   * 就得到一个准确的原因（无主键表 vs 空数组），报错不会张冠李戴。
   */
  #resolveTableTarget(db: DatabaseSync, tableId: string, requireKey: boolean): EditableTarget {
    const parsed = parseObjectId(tableId)
    if (parsed === null) {
      throw new SqliteAdapterError('object_not_found', `无法识别的对象 id：${tableId}`)
    }
    if (parsed.kind !== 'table') {
      throw new SqliteAdapterError(
        'bad_params',
        `只有表支持在线编辑，收到的是 ${parsed.kind} 节点：${tableId}（视图与列不能直接改）`
      )
    }

    // 表不存在时 #readColumns 会抛 object_not_found
    const columns = this.#readColumns(db, parsed.name)
    const keyColumns = columns
      .filter((column) => column.primaryKeyOrdinal !== null)
      .sort((a, b) => (a.primaryKeyOrdinal ?? 0) - (b.primaryKeyOrdinal ?? 0))
      .map((column) => column.name)

    /**
     * 只有**定位行**的操作（UPDATE / DELETE）才要求主键。
     * INSERT 不需要：它是新增一行，不存在"定位哪一行"的问题；
     * 用同一个检查把无主键表的新增也拦掉，是把规则用错了地方
     * （会让用户在一个没有主键的日志表上连插一条记录都做不到）。
     *
     * DBeaver 在这里的原话就是 "No unique key defined"，
     * UI 会直接把这句话展示给用户，所以消息里保留它。
     * 拒绝而不是"用全部列当条件"：拿整行当 WHERE 会在有重复行时
     * 一次改掉多行，属于静默改错数据。
     */
    if (requireKey && keyColumns.length === 0) {
      throw new SqliteAdapterError(
        'object_not_found',
        `表「${parsed.name}」没有唯一键，无法定位要修改的行（No unique key defined）。` +
          '没有唯一键的结果集不支持在线编辑：请为该表定义主键，或在 SQL 窗口里直接写 UPDATE。'
      )
    }

    return {
      tableName: parsed.name,
      availableColumns: columns.map((column) => column.name),
      keyColumns,
      columnTypes: new Map(columns.map((column) => [column.name.toLowerCase(), column.typeName]))
    }
  }

  /**
   * 行级校验：主键覆盖是否完整，并返回「表内真实列名」的匹配结果。
   *
   * 返回 `ColumnMatch[]` 而不是 `string[]`：SQL 里要用 canonical（真实列名），
   * 而取值必须用 callerName（调用方原始键）——两者混用会取空（task-19 踩过）。
   */
  #resolveRowKeys(
    target: EditableTarget,
    keyValues: Readonly<Record<string, CellValue>>,
    position: number,
    actionLabel: string
  ): readonly ColumnMatch[] {
    const keyKeys = Object.keys(keyValues)
    const keyResolved = resolveColumns(keyKeys, target.availableColumns)
    if (keyResolved.unknown.length > 0) {
      throw new SqliteAdapterError(
        'bad_params',
        `第 ${position} 条${actionLabel}的主键列不存在：${keyResolved.unknown.join('、')}。` +
          `「${target.tableName}」的可用列：${target.availableColumns.join('、')}`
      )
    }
    const missingKeys = target.keyColumns.filter(
      (key) => !keyKeys.some((candidate) => candidate.toLowerCase() === key.toLowerCase())
    )
    if (missingKeys.length > 0) {
      throw new SqliteAdapterError(
        'bad_params',
        `第 ${position} 条${actionLabel}缺少主键列的值：${missingKeys.join('、')}。` +
          '在线编辑必须用完整主键定位行（缺主键就无法保证只改到目标那一行）。'
      )
    }
    // 按表定义的主键顺序返回，不依赖调用方对象键顺序
    const ordered: ColumnMatch[] = []
    for (const key of target.keyColumns) {
      const match = keyResolved.matched.find((candidate) => candidate.canonical.toLowerCase() === key.toLowerCase())
      if (match !== undefined) ordered.push(match)
    }
    return ordered
  }

  /**
   * 解析并校验一次 applyEdits 的全部目标。
   *
   * 校验**全部**在开事务之前完成：校验失败属于"请求本身不对"，
   * 不该留下一个空事务让 UI 显示"有未提交改动"。
   */
  #resolveEditableTarget(db: DatabaseSync, tableId: string, updates: readonly RowUpdate[]): EditableTarget {
    const target = this.#resolveTableTarget(db, tableId, true)

    for (let index = 0; index < updates.length; index += 1) {
      const update = updates[index]
      if (update === undefined) continue
      const position = index + 1

      const changeKeys = Object.keys(update.changes)
      if (changeKeys.length === 0) {
        throw new SqliteAdapterError('bad_params', `第 ${position} 条更新没有指定任何要修改的列。`)
      }
      const changeResolved = resolveColumns(changeKeys, target.availableColumns)
      if (changeResolved.unknown.length > 0) {
        throw new SqliteAdapterError(
          'bad_params',
          `第 ${position} 条更新引用了不存在的列：${changeResolved.unknown.join('、')}。` +
            `「${target.tableName}」的可用列：${target.availableColumns.join('、')}`
        )
      }
      this.#resolveRowKeys(target, update.keyValues, position, '更新')
    }

    return target
  }

  /**
   * 执行一条行更新，把结果（含失败原因）收成一个 outcome。
   *
   * 这里**吞掉异常而不是往上抛**：批量里的一行失败不该让整批中断，
   * 上层需要看到"第几行、为什么失败"，才能决定回滚还是让用户修数据。
   * 真正的 SQL 执行异常也一样被收进 `error` 字段。
   */
  #applyOneUpdate(
    db: DatabaseSync,
    target: EditableTarget,
    update: RowUpdate,
    index: number
  ): RowEditOutcome {
    /**
     * 参数顺序必须与 buildUpdateSql 里的占位符顺序一致：先 SET 后 WHERE。
     *
     * 取值一律用**调用方原始键**（`matched.requested`）：调用方可能写 `ID`，
     * 值就只存在 `record['ID']` 下；而 SQL 里必须用表内真实列名（`matched.canonical`）。
     * 两者混用会导致"SQL 看起来对、但值取空"——那会静默把列改成 NULL。
     */
    const changeResolved = resolveColumns(Object.keys(update.changes), target.availableColumns)
    const keyResolved = resolveColumns(Object.keys(update.keyValues), target.availableColumns)
    // 主键按**表定义的主键顺序**排列，不依赖调用方传 keyValues 时的对象键顺序
    const keyMatches = target.keyColumns.map((key) =>
      keyResolved.matched.find((candidate) => candidate.canonical.toLowerCase() === key.toLowerCase())
    )
    const orderedKeyMatches = keyMatches.filter((match) => match !== undefined)
    const keyColumns = orderedKeyMatches.map((match) => match.canonical)

    const sql = buildUpdateSql(this.dialect.quoteIdentifier, target.tableName, changeResolved.matched.map((m) => m.canonical), keyColumns)

    let params: SqliteBind[]
    try {
      params = buildUpdateParams(
        new Map(changeResolved.matched.map((match) => [match.canonical, mustGetValue(update.changes, match.requested)])),
        new Map(orderedKeyMatches.map((match) => [match.canonical, mustGetValue(update.keyValues, match.requested)]))
      )
    } catch (thrown) {
      // 值转换失败（典型：被截断的文本/BLOB 不允许回写）——按行报告，不影响其它行
      return { index, affected: 0, error: `值转换失败：${describeThrown(thrown)}`, sql }
    }

    try {
      const affected = this.#runWrite(db, sql, params)
      if (affected === 0) {
        return {
          index,
          affected,
          error: '没有匹配到任何行：主键值可能已过期（该行已被删除或主键被改过），本次改动未生效。',
          sql
        }
      }
      if (affected > 1) {
        return {
          index,
          affected,
          error: `主键定位到了 ${affected} 行：该"唯一键"实际不唯一，为避免误改已停止这一行。`,
          sql
        }
      }
      return { index, affected, error: null, sql }
    } catch (thrown) {
      return { index, affected: 0, error: describeThrown(thrown), sql }
    }
  }

  /**
   * 执行内部生成的写入语句（值全部参数化、标识符全部 quote）。
   *
   * **这条路径不经过 `prepareReadOnlyStatement`**：那条护栏是给"用户输入的 SQL"用的，
   * 内部写入不该被自己拦住（详见 applyEdits 的注释）。
   */
  #runWrite(db: DatabaseSync, sql: string, params: readonly SqliteBind[]): number {
    try {
      const result = db.prepare(sql).run(...params)
      // readBigInts 已开启 → changes 是 bigint（实测），统一收窄成 number
      return readNumber(result.changes) ?? 0
    } catch (thrown) {
      throw new SqliteAdapterError('query_failed', `执行更新失败（原始错误：${describeThrown(thrown)}）`, thrown)
    }
  }

  /** 执行事务控制语句（BEGIN IMMEDIATE / COMMIT / ROLLBACK），把底层报错包装成人话。 */
  #execTransaction(db: DatabaseSync, statement: 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK'): void {
    try {
      db.exec(statement)
    } catch (thrown) {
      throw new SqliteAdapterError('query_failed', `${statement} 执行失败（原始错误：${describeThrown(thrown)}）`, thrown)
    }
  }

  /**
   * 保证有事务；返回"这个事务是不是本方法刚开的"。
   *
   * 为什么要区分：只有自己开的事务才由自己负责清理失败现场。
   * 若事务是上层（比如连续多次编辑）开的，撤掉它就会把上层的工作一起弄丢。
   */
  #ensureTransaction(db: DatabaseSync): boolean {
    if (db.isTransaction) return false
    this.#execTransaction(db, 'BEGIN IMMEDIATE')
    this.#pendingAffected = 0
    return true
  }

  /**
   * 本方法自己开的、且该操作整体失败的（目前 insert 会用），
   * 撤掉这个空事务，避免 UI 显示一个"有未提交改动"的空事务。
   *
   * 注意：只在**没有任何成功行**的情况下撤。deleteRows 里只要有一行成功，
   * 就不能走这里（那属于"部分完成"，必须留给上层决策）。
   */
  #releaseFailedOwnTransaction(db: DatabaseSync, inOwnTransaction: boolean): void {
    if (!inOwnTransaction) return
    if (!db.isTransaction) return
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败也无法再做别的了
    }
  }

  /** 执行 INSERT，返回新行的 rowid（`lastInsertRowid`）。 */
  #runInsert(db: DatabaseSync, sql: string, params: readonly SqliteBind[]): number {
    try {
      const result = db.prepare(sql).run(...params)
      // readBigInts 已开启 → lastInsertRowid 是 bigint
      return readNumber(result.lastInsertRowid) ?? 0
    } catch (thrown) {
      throw new SqliteAdapterError('query_failed', `插入执行失败（原始错误：${describeThrown(thrown)}）`, thrown)
    }
  }

  /**
   * 推断新行的主键值。
   *
   * 规则（保守优先，宁缺毋错）：
   *  1. 调用方显式给了该主键列的值 → 原样采用（这是最可靠的来源）。
   *  2. 主键是**单列**、且该列是 `INTEGER PRIMARY KEY`（rowid 别名）→ 用 `lastInsertRowid`。
   *  3. 其余情况（TEXT 主键、复合主键、普通 INTEGER 主键但值未给）→ **不猜**，
   *     返回空对象，UI 重查即可。
   *
   * 为什么不回头查询"刚插入的那行"来取主键：
   * 那样需要一个可靠的定位条件，而"刚插入的行"在没有主键值的前提下
   * 只能用 rowid 或全列匹配——在并发写入下都可能定位到别人的行。
   * 与其给出一个可能错的主键，不如诚实地少给。
   */
  #resolveInsertedKeyValues(
    target: EditableTarget,
    givenValues: ReadonlyMap<string, CellValue>,
    insertedRowid: number
  ): Record<string, CellValue> {
    const keyValues: Record<string, CellValue> = {}
    if (target.keyColumns.length === 1 && target.keyColumns[0] !== undefined) {
      const singleKey = target.keyColumns[0]
      const given = givenValues.get(singleKey)
      if (given !== undefined) {
        keyValues[singleKey] = given
        return keyValues
      }
      // 仅当该列确实是 rowid 别名时才用 lastInsertRowid
      if (this.#isRowidAlias(singleKey, target)) {
        keyValues[singleKey] = { kind: 'number', value: insertedRowid }
        return keyValues
      }
    }
    return keyValues
  }

  /**
   * 判断某个主键列是不是 rowid 别名（`INTEGER PRIMARY KEY`）。
   *
   * 为什么需要这个判断：SQLite 的 `lastInsertRowid` 指的是 **rowid**，
   * 只有当主键就是 rowid 别名时，二者才是同一个值。
   * 对 `TEXT PRIMARY KEY` 或复合主键，`lastInsertRowid` 与主键毫无关系，
   * 直接拿它当主键回传就是回传一个错值。
   *
   * 可靠判据（SQLite 官方文档明确的两条同时成立）：
   *   列的声明类型为 INTEGER（大小写/空格不敏感）+ 该表是普通 rowid 表（非 WITHOUT ROWID）。
   * 后者通过 `PRAGMA table_info` 里存在名为 rowid 的隐含列无法直接看出，
   * 这里改用 `PRAGMA index_list` 之外更直接的近似：
   * 单列主键 + 类型 INTEGER + 该列值由数据库生成（调用方未给）就够了——
   * 若表是 WITHOUT ROWID 且只有一个 INTEGER 主键，插入后主键也必须由调用方给，
   * 走到这里的场景（调用方没给主键）在 WITHOUT ROWID 表上本来就必然失败，不会误判。
   */
  #isRowidAlias(keyColumn: string, target: EditableTarget): boolean {
    const declared = target.columnTypes.get(keyColumn.toLowerCase())
    return declared !== undefined && /^integer$/i.test(declared.trim())
  }

  /**
   * 执行一条行删除，把结果收成一个 outcome（与 #applyOneUpdate 的收尾风格一致）。
   */
  #applyOneDelete(
    db: DatabaseSync,
    target: EditableTarget,
    keyValues: Readonly<Record<string, CellValue>>,
    index: number
  ): RowEditOutcome {
    const orderedKeys = this.#resolveRowKeys(target, keyValues, index + 1, '删除')
    const keyColumns = orderedKeys.map((match) => match.canonical)
    const sql = buildDeleteSql(this.dialect.quoteIdentifier, target.tableName, keyColumns)

    let params: SqliteBind[]
    try {
      params = buildDeleteParams(
        keyColumns,
        new Map(orderedKeys.map((match) => [match.canonical, mustGetValue(keyValues, match.requested)]))
      )
    } catch (thrown) {
      return { index, affected: 0, error: `值转换失败：${describeThrown(thrown)}`, sql }
    }

    try {
      const affected = this.#runWrite(db, sql, params)
      if (affected === 0) {
        return {
          index,
          affected,
          error: '没有匹配到任何行：主键值可能已过期（该行已被删除或主键被改过），本次删除未生效。',
          sql
        }
      }
      if (affected > 1) {
        return {
          index,
          affected,
          error: `主键定位到了 ${affected} 行：该"唯一键"实际不唯一，为避免误删已停止这一行。`,
          sql
        }
      }
      return { index, affected, error: null, sql }
    } catch (thrown) {
      return { index, affected: 0, error: describeThrown(thrown), sql }
    }
  }

  /**
   * 登记一个游标。
   *
   * 用 `randomUUID()` 而不是自增计数：游标 id 会跨进程传给渲染进程，
   * 自增 id 在"重连后从 0 开始"时可能与旧 id 撞车，
   * 让一个已经失效的游标请求意外命中新结果集（这种 bug 极难复现）。
   */
  #openCursor(statementSql: string): string {
    const cursorId = randomUUID()
    this.#cursors.set(cursorId, { sql: statementSql })
    return cursorId
  }
}

/** 查询 sqlite_master 判断表/视图是否存在（参数绑定，不用拼字符串）。 */
function objectExists(db: DatabaseSync, name: string, arrayMode: boolean): boolean {
  const grid = readGrid(
    db,
    `SELECT 1 AS found FROM sqlite_master
      WHERE name = ? COLLATE NOCASE AND type IN ('table', 'view')
      LIMIT 1`,
    arrayMode,
    name
  )
  return grid.rows.length > 0
}

/**
 * 工厂：每次调用返回**新实例**。
 * 依据 `core/registry.ts` 的注释——连接状态属于实例，不该被两个连接共用。
 */
export const createSqliteAdapter: DriverFactory = (): DriverAdapter => new SqliteDriverAdapter()
