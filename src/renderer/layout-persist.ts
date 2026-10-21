/**
 * 网格布局偏好（排序 / 列宽）的持久化 —— **纯函数，无 DOM 依赖**。
 *
 * ===== 为什么要单独拆出来 =====
 *
 * 真实的存储是 `localStorage`（渲染进程才有）。如果读写逻辑直接写在
 * `grid.ts` 里，测它就必须起一个浏览器；而这里的逻辑里最容易出错的恰恰不是
 * "调了 localStorage.setItem"，而是：
 *   - key 怎么拼（谁的偏好属于谁）
 *   - **列名变了怎么办**（表结构改动是常态）
 *   - 存的内容坏了 / 是上个版本写的 / 被用户手改过怎么办
 * 这些都是纯字符串进、纯数据出的事情，拆成纯函数就能在 Node 里直接测。
 *
 * 所以本文件只依赖一个最小接口 `StorageLike`，`localStorage` 只是它的一个实现。
 */

/** `localStorage` 的最小子集。用接口而不是直接依赖 DOM 的 `Storage`，便于在 Node 里 mock。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 排序方向。与 grid 内部的 SortState 语义一致（null = 未排序）。 */
export type SortDirection = 'asc' | 'desc'

/** 一份网格布局偏好。 */
export interface GridLayoutPrefs {
  /** 排序列名 + 方向。没有排序时为空。 */
  readonly sort:
    | { readonly columnName: string; readonly direction: SortDirection }
    | null
  /** 列名 → 宽度（px）。只保存用户**手动调过**的列，没调过的用默认宽度。 */
  readonly columnWidths: Readonly<Record<string, number>>
}

/** 空偏好。读取失败/不存在时返回它，调用方无需额外判空。 */
export const EMPTY_LAYOUT_PREFS: GridLayoutPrefs = { sort: null, columnWidths: {} }

const KEY_PREFIX = 'dbstudio'

/**
 * 生成偏好的存储 key。
 *
 * 设计：`dbstudio.<kind>.<dialect>.<connectionId>.<tableName>`
 *
 * **为什么按表而不是按查询**：排序和列宽是用户对"这张表"的偏好。
 * 如果按 SQL 文本做 key，用户只是改了个 WHERE 条件（或者从表视图
 * 换到 SQL 视图）偏好就全丢——那不是他想要的。反过来按表存，
 * 换个 SQL 但查的是同一张表，列宽依然在，符合直觉。
 *
 * `dialect` 参与 key 的原因：同名的表在 SQLite 和 PG 里是不同的东西，
 * 列类型甚至列集合都可能不同，偏好不该串。
 *
 * 名字里可能有 `:`（我们的 adapterId 形如 `table:users`）或点号，
 * 这里**不做转义**而是原样拼接：key 只用于相等比较，不做解析，
 * 所以"含分隔符"不构成歧义。这一点必须写清楚，否则后来人会以为需要转义。
 */
export function buildLayoutKey(
  kind: 'sort' | 'widths',
  dialect: string,
  connectionId: string,
  tableName: string
): string {
  return `${KEY_PREFIX}.${kind}.${dialect}.${connectionId}.${tableName}`
}

/**
 * 本模块统一使用的单个 key。
 *
 * 规格里列了 `sort` 与 `widths` 两个 key 前缀，但两者**总是同时**读写
 * （打开表时要一起应用、重置时要一起清），拆成两条记录会出现
 * "排序存好了、列宽没存上"这种半套状态。所以这里用一个 key 存整个偏好对象，
 * `buildLayoutKey` 仍然保留（它就是 key 的组成部分与向后兼容的说明），
 * 取 `kind: 'sort'` 这一支作为规范位置。
 */
export function layoutKey(dialect: string, connectionId: string, tableName: string): string {
  return buildLayoutKey('sort', dialect, connectionId, tableName)
}

/** 宽度是否在一个合理区间内。超出范围的值（手改、旧版本、负宽）一律丢弃。 */
const MIN_SAVED_WIDTH = 20
const MAX_SAVED_WIDTH = 10_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析存储里的原始字符串。
 *
 * **任何异常都返回空偏好，绝不抛错**——这是本模块最重要的容错约定：
 * 布局偏好是"锦上添花"的东西，为它让整张表打不开是不可接受的。
 * 会走到这里的坏数据在现实中很常见：旧版本写的格式、用户手改过、
 * 扩展写过同一个 key、写一半断电……
 */
export function parseLayoutPrefs(raw: string | null): GridLayoutPrefs {
  if (raw === null) return EMPTY_LAYOUT_PREFS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_LAYOUT_PREFS
  }
  if (!isRecord(parsed)) return EMPTY_LAYOUT_PREFS

  const sortRaw = parsed['sort']
  let sort: GridLayoutPrefs['sort'] = null
  if (isRecord(sortRaw)) {
    const columnName = sortRaw['columnName']
    const direction = sortRaw['direction']
    if (
      typeof columnName === 'string' &&
      columnName !== '' &&
      (direction === 'asc' || direction === 'desc')
    ) {
      sort = { columnName, direction }
    }
  }

  const widthsRaw = parsed['columnWidths']
  const columnWidths: Record<string, number> = {}
  if (isRecord(widthsRaw)) {
    for (const [name, width] of Object.entries(widthsRaw)) {
      if (name === '') continue
      if (typeof width !== 'number' || !Number.isFinite(width)) continue
      if (width < MIN_SAVED_WIDTH || width > MAX_SAVED_WIDTH) continue
      columnWidths[name] = Math.round(width)
    }
  }

  return { sort, columnWidths }
}

/**
 * 把偏好里的**列名**与当前结果集的列名对齐，丢弃失效的部分。
 *
 * 这就是规格里说的"列名变了就忽略该条记录"：
 *   - 排序列不存在了（改名/删除）→ 取消排序
 *   - 某些列宽对应不到任何现有列 → 丢那几条，其余保留
 *
 * 为什么不是"整条记录作废"：表加了一列不该让用户之前调好的 10 个列宽全丢。
 * 只有直接相关的那部分失效，收益最大、也最符合直觉。
 *
 * 注意 `columnWidths` 的 key 是**列名**而不是下标：排序之后列下标会变，
 * 用下标存宽度会在重排后把宽度套到错的列上。
 */
export function sanitizeLayoutPrefs(
  prefs: GridLayoutPrefs,
  columnNames: readonly string[]
): GridLayoutPrefs {
  const available = new Set(columnNames)

  const sort =
    prefs.sort !== null && available.has(prefs.sort.columnName)
      ? { columnName: prefs.sort.columnName, direction: prefs.sort.direction }
      : null

  const columnWidths: Record<string, number> = {}
  for (const [name, width] of Object.entries(prefs.columnWidths)) {
    if (available.has(name)) columnWidths[name] = width
  }

  return { sort, columnWidths }
}

/**
 * 读取并清洗偏好。
 *
 * 存储本身也可能抛错（隐私模式下 `localStorage` 访问即抛、配额满等），
 * 所以整个读取包在 try 里——同样地，**读不到就当没有**，不让布局偏好影响功能。
 */
export function loadLayoutPrefs(
  storage: StorageLike,
  dialect: string,
  connectionId: string,
  tableName: string,
  columnNames: readonly string[]
): GridLayoutPrefs {
  let raw: string | null = null
  try {
    raw = storage.getItem(layoutKey(dialect, connectionId, tableName))
  } catch {
    return EMPTY_LAYOUT_PREFS
  }
  return sanitizeLayoutPrefs(parseLayoutPrefs(raw), columnNames)
}

/** 保存偏好。写失败（配额满/隐私模式）静默忽略：布局偏好不值得打断用户操作。 */
export function saveLayoutPrefs(
  storage: StorageLike,
  dialect: string,
  connectionId: string,
  tableName: string,
  prefs: GridLayoutPrefs
): void {
  try {
    storage.setItem(layoutKey(dialect, connectionId, tableName), JSON.stringify(prefs))
  } catch {
    // 存不下就算了：下次打开用默认布局，不影响任何功能
  }
}

/** 清除某张表的偏好（"重置布局"用）。失败同样静默。 */
export function clearLayoutPrefs(
  storage: StorageLike,
  dialect: string,
  connectionId: string,
  tableName: string
): void {
  try {
    storage.removeItem(layoutKey(dialect, connectionId, tableName))
  } catch {
    // ignore
  }
}

/**
 * 从表节点 id 里取出表名。
 *
 * adapterId 形如 `table:users`、`table:a.b`（表名可以含点号）。
 * 解析规则与驱动侧保持一致：**只切第一个冒号**，后面原样作为名字——
 * 从右往左切在"名字里含点号"时会有歧义（见 sqlite/ids.ts 的说明）。
 *
 * 非 `table:` 开头的 id（视图、连接、自由 SQL）返回 null：
 * 这些场景按规格**不做持久化**（自由 SQL 的列不固定，持久化没有意义）。
 */
export function tableNameFromNodeId(nodeId: string): string | null {
  const separator = nodeId.indexOf(':')
  if (separator <= 0) return null
  if (nodeId.slice(0, separator) !== 'table') return null
  const name = nodeId.slice(separator + 1)
  return name === '' ? null : name
}
