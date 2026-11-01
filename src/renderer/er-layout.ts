/**
 * ER 图布局的**纯逻辑**：布局 key 的构造 + 布局 JSON 的解析、清洗与序列化。
 *
 * ============================================================================
 * 为什么单独一个文件（而不是继续塞进 `er-diagram.ts`）
 * ============================================================================
 * `er-diagram.ts` 是渲染层，里面全是 DOM 与事件；布局却有两个很"不渲染"的关注点：
 *   1. **key 怎么拼**（布局属于谁：连接 + schema 集合）；
 *   2. **存进去的东西怎么信**（旧版本写的、用户手改过的、别的连接串过来的）。
 *
 * 这两点恰恰是最容易出错、又最难在 GUI 里断言的部分：
 * 写错 key 的症状是"布局偶尔不生效"，写错解析的症状是"图整个打不开"。
 * 所以这里把它们拆成**纯函数**：不碰 DOM、不碰 localStorage，
 * 就能在 Node 里把每一条边界都钉死。
 *
 * ============================================================================
 * 布局数据的边界：只存坐标，不存数据库内容
 * ============================================================================
 * 布局存储里**只有** `{ 节点 id → { x, y } }`。不写列名、不写外键、
 * 更不写表里的数据——布局是本地图形偏好，不是数据副本。
 * 这样即使存储被人翻出来，里面也只有"哪个节点画在哪"。
 *
 * ============================================================================
 * key 的设计：连接 + schema 集合指纹
 * ============================================================================
 * 同一个连接下，用户可能先看 `public` 的表、再看 `audit` 的表。
 * 两张图的节点 id 不重叠（节点 id 带 schema），但坐标偏好如果共用一份，
 * 就会出现"切到另一个 schema 后图被挤成一团、坐标还残留着上一张图的值"。
 * 所以 key 必须把 **schema 集合**也算进去。
 *
 * schema 集合要先**去重**（选表时同一 schema 会出现很多次）
 * 再**排序**（顺序取决于用户点选的先后，不该影响 key）
 * 最后**稳定编码**（`null` 表示"这个方言没有 schema 概念"，例如 SQLite）。
 *
 * 编码用了一个刻意的取舍：**每一段都带类型前缀**。
 *   - `null`（无 schema 的方言）→ 记作 `null`
 *   - 字符串 schema `"public"` → 记作 `s:<编码后的 public>`
 * 于是字符串 schema 恰好叫 `"null"` 时（`s:null`）和真的 `null`（`null`）
 * **不会撞成同一个 key**。这不是洁癖：PG 里 `null` 是合法的 schema 名。
 */

/**
 * 布局存储的 key 前缀。沿用 `er-diagram.ts` 里已有的旧前缀，版本号也在其中。
 *
 * 为什么**不**把它做成可配置项：前缀一旦分叉，旧版本存下的布局就再也读不到了。
 * 这类"看不见的丢失"比报错更难查，所以前缀在这里单点定义并写死。
 */
export const ER_LAYOUT_STORAGE_PREFIX = 'dbstudio.er-layout.v1'

/** 一个节点在画布上的坐标。 */
export interface ErLayoutPosition {
  readonly x: number
  readonly y: number
}

/** 一份布局：节点 id → 坐标。 */
export type ErLayoutPositions = Record<string, ErLayoutPosition>

/**
 * 存储的最小子集。
 *
 * 刻意不复用 `layout-persist.ts` 的 `StorageLike`：那个模块会连带引入
 * `core/api`，让本文件不再是"零依赖纯逻辑"。这里自己声明一份**结构等价**的接口，
 * 所以 `localStorage` 和测试里的假存储都能直接传进来。
 */
export interface ErLayoutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * 坐标上限。
 *
 * 坐标只该是"画布上的一个位置"，正常情况下不会超过几千像素。
 * 但存储可能被手改成 `1e308` 这种值——那时 SVG 的 width 会被算成一个天文数字，
 * 浏览器会直接卡死。超出上限的一律当作坏数据丢弃。
 */
export const ER_LAYOUT_MAX_COORDINATE = 10_000_000

/* ------------------------------------------------------------------ *
 * schema 集合的规范化与编码
 * ------------------------------------------------------------------ */

/**
 * 去重并排序 schema 集合。
 *
 * - **去重**：选表时同一个 schema 会重复出现，重复项不该影响 key。
 * - **排序**：key 只能由"集合"决定，不能由"用户点选的先后"决定，
 *   否则同一批表先选 A 后选 B 与先选 B 后选 A 会得到两个 key，布局就丢了。
 * - **`null` 排在最前**：`null` 表示"没有 schema 概念"，把它放在固定位置，
 *   编码结果才稳定。
 * - 排序用**码位比较**而不是 `localeCompare`：后者依赖运行环境的区域设置，
 *   同一份数据在不同机器上可能排出不同顺序，key 就不稳定了。
 */
export function normalizeErLayoutSchemas(
  schemas: readonly (string | null)[] | null | undefined
): (string | null)[] {
  const unique = new Set<string | null>()
  for (const schema of schemas ?? []) {
    if (schema === null) {
      unique.add(null)
      continue
    }
    if (typeof schema !== 'string') continue
    unique.add(schema)
  }
  return [...unique].sort(compareSchemas)
}

function compareSchemas(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a < b ? -1 : 1
}

/** 保留这些字符，其余一律转义。 */
const SAFE_FRAGMENT_CHAR = /^[A-Za-z0-9_-]$/

/**
 * 把一段字符串编码成"只含安全字符"的片段。
 *
 * 保留 `A-Za-z0-9_-`，其余字符按 UTF-16 码位编码成定长 4 位十六进制（`%XXXX`）。
 * **定长**很重要：变长会让解码端无法判断 `%` 后面到底几位是转义的一部分。
 *
 * 编码后的片段里不会出现 `.` `:` `%` 之外的任何分隔符字符，
 * 所以分隔符（`.` 与 `:`）在片段内部**不可能出现**，拼接时不会有歧义。
 */
function encodeErLayoutFragment(value: string): string {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index)
    if (SAFE_FRAGMENT_CHAR.test(char)) {
      out += char
      continue
    }
    out += `%${value.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * 构造布局存储的 key。
 *
 * 形如：`dbstudio.er-layout.v1.<连接 id 编码>.<schema 指纹>`
 *
 * 连接 id 也走同一套编码，所以连接 id 里含 `.` `:` `|`（真实 id 就是
 * `connection:<uuid>`）**不会**和 schema 指纹的分隔符混淆——
 * "连接 A + schema B" 与 "连接 A.B + schema 空" 一定是两个不同的 key。
 */
export function buildErLayoutKey(
  connectionId: string,
  schemas: readonly (string | null)[] | null | undefined
): string {
  const normalized = normalizeErLayoutSchemas(schemas)
  const fingerprint =
    normalized.length === 0
      ? 'empty'
      : normalized
          .map((schema) => (schema === null ? 'null' : `s:${encodeErLayoutFragment(schema)}`))
          .join('.')
  const connection = encodeErLayoutFragment(
    typeof connectionId === 'string' ? connectionId : String(connectionId)
  )
  return `${ER_LAYOUT_STORAGE_PREFIX}.${connection}.${fingerprint}`
}

/* ------------------------------------------------------------------ *
 * 布局 JSON 的解析与清洗
 * ------------------------------------------------------------------ */

/**
 * 判断是不是"可当普通对象读"的值。
 *
 * 注意这里**必须**把 Map 排除掉：`typeof map === 'object'` 为真、
 * `Array.isArray(map)` 也为假，只看这两条的话 Map 会被误判成普通对象，
 * 而 `Object.entries(map)` 返回的是空数组——那样 `serializeErLayout(map)`
 * 会**静默存出一个空布局**：用户拖了半天框，位置全丢，而且不报错。
 *
 * 用"有没有 `entries` 方法"而不是 `instanceof Map` 来判断：
 * `instanceof` 跨 realm（iframe / vm 上下文）会失效，
 * 而渲染进程与测试都可能来自不同的 realm。
 */
function isMapLike(value: unknown): value is ReadonlyMap<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { entries?: unknown }).entries === 'function'
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isMapLike(value)
  )
}

/**
 * 把一个候选值收敛成一个合法坐标，非法则返回 null。
 *
 * 判定口径（与 `er-diagram.ts` 里 `finitePosition` 保持一致）：
 * 必须是**有限数**且 **>= 0**。字符串 `"12"`、布尔值、`null` 一律丢弃——
 * 宁可回退到自动布局，也不能画到 NaN 位置上去。
 */
function toErLayoutPosition(value: unknown): ErLayoutPosition | null {
  if (!isPlainObject(value)) return null
  const x = value['x']
  const y = value['y']
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) return null
  if (typeof y !== 'number' || !Number.isFinite(y) || y < 0) return null
  if (x > ER_LAYOUT_MAX_COORDINATE || y > ER_LAYOUT_MAX_COORDINATE) return null
  return { x, y }
}

/**
 * 解析布局 JSON 字符串。
 *
 * **任何异常都返回空布局，绝不抛错**——布局是"锦上添花"的偏好，
 * 为它让整张 ER 图打不开是不可接受的。
 * 会被丢掉的坏数据在现实中很常见：旧版本格式、用户手改过、写到一半断了。
 */
export function parseErLayout(raw: string | null | undefined): ErLayoutPositions {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  return sanitizeErLayout(parsed)
}

/**
 * 清洗一份布局：只保留 `Record<nodeId, { x, y }>` 形状的合法项。
 *
 * - 顶层不是对象（数组、`null`、数字、字符串）→ 返回空布局。
 * - 某项不是对象、缺 `x`/`y`、坐标非有限或为负 → 丢弃**该项**，其余保留。
 * - `knownNodeIds` 给出时，**未知节点**（当前图里不存在的节点 id）一并丢弃：
 *   表被删了、改名了，或者这份布局来自另一张图，留着它们毫无意义。
 * - 只保留 `x` 与 `y` 两个键，多余的键被丢掉，
 *   这样序列化出去的内容永远是固定的形状。
 *
 * 返回的是**新对象**，不会修改入参，也不会与入参共享内部引用。
 */
export function sanitizeErLayout(
  value: unknown,
  knownNodeIds?: Iterable<string> | null
): ErLayoutPositions {
  if (!isPlainObject(value)) return {}
  const allowed = knownNodeIds ? new Set(knownNodeIds) : null
  const entries: [string, ErLayoutPosition][] = []
  for (const [nodeId, raw] of Object.entries(value)) {
    if (nodeId === '') continue
    if (allowed !== null && !allowed.has(nodeId)) continue
    const position = toErLayoutPosition(raw)
    if (position === null) continue
    entries.push([nodeId, position])
  }
  // 用 fromEntries 而不是 `out[id] = pos`：`__proto__` 这类键若走赋值，
  // 会触发 Object.prototype 的 setter，把布局数据变成原型污染的载体。
  return Object.fromEntries(entries)
}

/* ------------------------------------------------------------------ *
 * 序列化与存取
 * ------------------------------------------------------------------ */

function toErLayoutEntries(
  positions: ErLayoutPositions | ReadonlyMap<string, ErLayoutPosition>
): [string, unknown][] {
  if (isPlainObject(positions)) return Object.entries(positions)
  return Array.from(positions.entries())
}

/**
 * 把布局序列化成 JSON 字符串。
 *
 * 写出去的内容**只有**节点 id 与 `x`/`y`：不写列名、不写外键、不写任何数据。
 * 坐标取整（像素级精度），与渲染层保存时的口径一致。
 * 节点 id 排序后输出，保证同样的布局永远得到同样的字符串（便于比对与调试）。
 */
export function serializeErLayout(
  positions: ErLayoutPositions | ReadonlyMap<string, ErLayoutPosition>
): string {
  const entries: [string, { x: number; y: number }][] = []
  for (const [nodeId, raw] of toErLayoutEntries(positions)) {
    if (nodeId === '') continue
    const position = toErLayoutPosition(raw)
    if (position === null) continue
    entries.push([nodeId, { x: Math.round(position.x), y: Math.round(position.y) }])
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return JSON.stringify(Object.fromEntries(entries))
}

/**
 * 从存储里读一份布局并按当前节点清洗。
 *
 * 读取本身也可能抛错（隐私模式下访问 `localStorage` 即抛、配额满等），
 * 所以整段包在 try 里——**读不到就当没有**，不让布局偏好影响功能。
 */
export function loadErLayout(
  storage: ErLayoutStorage,
  key: string,
  knownNodeIds?: Iterable<string> | null
): ErLayoutPositions {
  let raw: string | null = null
  try {
    raw = storage.getItem(key)
  } catch {
    return {}
  }
  return sanitizeErLayout(parseErLayout(raw), knownNodeIds)
}

/** 写一份布局。写失败（配额满 / 隐私模式）静默忽略：布局不值得打断用户操作。 */
export function saveErLayout(
  storage: ErLayoutStorage,
  key: string,
  positions: ErLayoutPositions | ReadonlyMap<string, ErLayoutPosition>
): boolean {
  try {
    storage.setItem(key, serializeErLayout(positions))
    return true
  } catch {
    return false
  }
}
