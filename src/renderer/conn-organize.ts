/**
 * 连接颜色标记 + 连接分组。
 *
 * ============================================================================
 * 为什么这两件事**只能**存 localStorage，绝不能进连接配置
 * ============================================================================
 * 颜色和分组是**纯本地 UI 偏好**：它描述的是"我怎么看这些连接"，
 * 而不是"这个连接怎么连"。它们与主机、端口、凭据完全是两类东西。
 *
 * 更关键的是实现约束：改连接配置要调 `api.updateConnection(...)`，
 * 而那条路径会**断开并重建会话**。用户只是想给「生产库」标个红色，
 * 结果连接被踢掉、正在跑的查询中断——这是完全不可接受的副作用。
 * 所以这里一律走 localStorage，不碰任何 IPC。
 *
 * ============================================================================
 * 连接 id 会变：颜色会丢，我们**接受这个丢失**，但绝不"猜"
 * ============================================================================
 * 删掉连接再重建会产生新的 `connectionId`，旧的 `dbstudio.conn.color.<id>`
 * 就成了孤儿数据，颜色自然丢失。
 *
 * 一个很自然的"聪明"想法是按连接名去匹配回原颜色：
 *   「这个新连接叫 production，之前也有个叫 production 的，大概是同一个吧」
 * 我们**明确不做**这件事。理由：名字相同的两个连接完全可能是两台不同机器
 * （甚至一个是生产一个是预发），把旧颜色/旧分组套到新连接上会让用户
 * 误判环境——错标的红色比没有颜色危险得多。**猜错比丢失更糟。**
 *
 * 孤儿数据不做主动清理（代价只是几十字节），但我们**不会读取它去匹配**。
 *
 * ============================================================================
 * 分层：纯函数在上，DOM 在下
 * ============================================================================
 * 上面一半（存储 key、默认色板、分组树构建、增删改）全是纯函数，接收一个
 * `KVStore` 接口而不是直接摸 `localStorage`——这样可以在 Node 里用内存实现
 * 完整单测"删组不删连接""无效 id 不污染"这类关键行为。
 */

import type { ObjectRef } from '../core/model'

// ============================================================================
// 存储抽象（让逻辑可单测）
// ============================================================================

/** localStorage 的最小子集。 */
export interface KVStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 内存实现（测试用；浏览器里也用得上——localStorage 可能被禁用）。 */
export class MemoryStore implements KVStore {
  readonly #map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.#map.has(key) ? (this.#map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value)
  }
  removeItem(key: string): void {
    this.#map.delete(key)
  }
  // 与 localStorage 同形的枚举接口——生产代码里 storeKeysWithPrefix 依赖它，
  // 内存实现必须对齐，否则单测会测不到"删组时枚举组内连接"这条关键路径。
  get length(): number {
    return this.#map.size
  }
  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null
  }
}

/**
 * 取 localStorage；不可用（隐私模式 / 被禁用）时退化为内存实现。
 *
 * 为什么必须兜底：`localStorage` 在 `file://`、某些沙箱或用户禁用时会直接抛异常，
 * 未捕获就是整个渲染进程白屏。颜色丢失可以接受，白屏不行。
 */
export function defaultStore(): KVStore {
  try {
    const ls = globalThis.localStorage
    if (!ls) return new MemoryStore()
    // 探测一次读写，确认不是"存在但一用就抛"。
    const probe = '__dbstudio_probe__'
    ls.setItem(probe, '1')
    ls.removeItem(probe)
    return ls
  } catch {
    return new MemoryStore()
  }
}

// ============================================================================
// 存储 key（按任务约定）
// ============================================================================

export const KEY_CONN_COLOR = (connectionId: string): string =>
  `dbstudio.conn.color.${connectionId}`
export const KEY_CONN_GROUP = (connectionId: string): string =>
  `dbstudio.conn.group.${connectionId}`
/** 组列表（有序）。 */
export const KEY_GROUPS = 'dbstudio.groups'

// ============================================================================
// 预设色板
// ============================================================================

/**
 * 预设色。
 *
 * 为什么是固定色板而不是取色器：固定颜色的目的是**语义化**
 * （红=生产/黄=预发/绿=本地），自由取色会让同一含义出现十几种红，
 * 反而失去"一眼分辨"的作用。DBeaver 用的也是预设色。
 *
 * 值直接给 CSS 变量名而非硬编码色值，这样明暗主题各自生效。
 */
export const PRESET_COLORS: readonly { id: string; label: string; css: string }[] = [
  { id: 'red', label: '红（生产）', css: 'var(--conn-red)' },
  { id: 'orange', label: '橙（预发）', css: 'var(--conn-orange)' },
  { id: 'yellow', label: '黄（谨慎）', css: 'var(--conn-yellow)' },
  { id: 'green', label: '绿（本地）', css: 'var(--conn-green)' },
  { id: 'blue', label: '蓝', css: 'var(--conn-blue)' },
  { id: 'purple', label: '紫', css: 'var(--conn-purple)' },
  { id: 'gray', label: '灰', css: 'var(--conn-gray)' }
]

/** 已知色 id 集合（读取时做白名单，非法值当作"未设置"）。 */
const COLOR_IDS = new Set(PRESET_COLORS.map((c) => c.id))

/** 色 id → CSS 值；未知返回 null（不猜、不回落成某个颜色）。 */
export function colorCss(colorId: string | null): string | null {
  if (!colorId) return null
  const found = PRESET_COLORS.find((c) => c.id === colorId)
  return found ? found.css : null
}

// ============================================================================
// 颜色读写
// ============================================================================

/** 读某连接的色 id；未设置或值非法 → null。 */
export function getConnColor(store: KVStore, connectionId: string): string | null {
  if (!connectionId) return null
  const raw = store.getItem(KEY_CONN_COLOR(connectionId))
  if (!raw) return null
  // 白名单：旧版本残留的未知值不应被当成有效颜色往后传。
  return COLOR_IDS.has(raw) ? raw : null
}

/** 设置颜色；传 null 表示清除。 */
export function setConnColor(store: KVStore, connectionId: string, colorId: string | null): void {
  if (!connectionId) return
  if (colorId === null) {
    store.removeItem(KEY_CONN_COLOR(connectionId))
    return
  }
  if (!COLOR_IDS.has(colorId)) return // 非法色 id 直接忽略，不写入垃圾
  store.setItem(KEY_CONN_COLOR(connectionId), colorId)
}

// ============================================================================
// 分组读写
// ============================================================================

/** 读组列表（有序、去重）。损坏的 JSON → 空数组，绝不抛。 */
export function getGroups(store: KVStore): string[] {
  const raw = store.getItem(KEY_GROUPS)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (typeof item !== 'string') continue
      const name = item.trim()
      if (name === '' || seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
    return out
  } catch {
    return []
  }
}

function saveGroups(store: KVStore, groups: readonly string[]): void {
  store.setItem(KEY_GROUPS, JSON.stringify(groups))
}

/** 读某连接所属组；未分组 → null。组不存在于此列表时仍返回组名（容忍顺序）。 */
export function getConnGroup(store: KVStore, connectionId: string): string | null {
  if (!connectionId) return null
  const raw = store.getItem(KEY_CONN_GROUP(connectionId))
  if (!raw) return null
  const name = raw.trim()
  return name === '' ? null : name
}

/**
 * 把连接移入组（groupName 为 null 表示移出到顶层）。
 *
 * 会自动把这个组名补进组列表——否则会出现"连接在某组里，组却不在列表中"
 * 的不一致状态（该组不会显示出来，连接也就"消失"了）。
 */
export function setConnGroup(
  store: KVStore,
  connectionId: string,
  groupName: string | null
): void {
  if (!connectionId) return
  if (groupName === null || groupName.trim() === '') {
    store.removeItem(KEY_CONN_GROUP(connectionId))
    return
  }
  const name = groupName.trim()
  store.setItem(KEY_CONN_GROUP(connectionId), name)
  const groups = getGroups(store)
  if (!groups.includes(name)) {
    groups.push(name)
    saveGroups(store, groups)
  }
}

/**
 * 重命名组。
 *
 * 只改**组名**本身，以及指向旧组名的连接记录——不触碰连接配置，
 * 更不碰 `updateConnection`。
 */
export function renameGroup(store: KVStore, oldName: string, newName: string): boolean {
  const from = oldName.trim()
  const to = newName.trim()
  if (from === '' || to === '' || from === to) return false
  const groups = getGroups(store)
  const idx = groups.indexOf(from)
  if (idx === -1) return false
  if (groups.includes(to)) return false // 目标名已存在：拒绝合并，避免意外并组

  groups[idx] = to
  saveGroups(store, groups)
  // 同步迁移组内连接（只改 group 记录，连接本身完好）。
  for (const connId of storeKeysWithPrefix(store, 'dbstudio.conn.group.')) {
    if (store.getItem(KEY_CONN_GROUP(connId)) === from) {
      store.setItem(KEY_CONN_GROUP(connId), to)
    }
  }
  return true
}

/**
 * 删除组：**组内连接回到顶层，连接本身完好。**
 *
 * 这是本模块最需要小心的一条：绝不能顺手清掉连接记录或动连接配置。
 * 实现上只做两件事：从组列表移除该名 + 删除指向它的 group 记录。
 */
export function deleteGroup(store: KVStore, groupName: string): boolean {
  const name = groupName.trim()
  if (name === '') return false
  const groups = getGroups(store)
  const idx = groups.indexOf(name)
  if (idx === -1) return false

  groups.splice(idx, 1)
  saveGroups(store, groups)

  // 组内每个连接：只删"分组归属"这一条记录 → 它自然回到顶层。
  for (const connId of storeKeysWithPrefix(store, 'dbstudio.conn.group.')) {
    if (store.getItem(KEY_CONN_GROUP(connId)) === name) {
      store.removeItem(KEY_CONN_GROUP(connId))
    }
  }
  return true
}

/**
 * 枚举带某前缀的 key。
 *
 * localStorage 有 `length` + `key(i)`；内存实现没有，所以统一通过
 * `Object.keys` 探测 + 可选的 `length/key` 接口。这里做成鸭子类型。
 */
function storeKeysWithPrefix(store: KVStore, prefix: string): string[] {
  const out: string[] = []
  const anyStore = store as unknown as {
    length?: number
    key?: (i: number) => string | null
  }
  if (typeof anyStore.length === 'number' && typeof anyStore.key === 'function') {
    for (let i = 0; i < anyStore.length; i++) {
      const k = anyStore.key(i)
      if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length))
    }
    return out
  }
  return out
}

// ============================================================================
// 分组树构建（纯函数，核心逻辑）
// ============================================================================

/** 分组节点在 meta 里的标记，让树识别"这是连接分组，不是数据库里的 folder"。 */
export const CONN_GROUP_FLAG = 'isConnGroup'

/**
 * 由「连接列表 + 本地分组偏好」构建根层节点顺序。
 *
 * 输出顺序规则：
 *   1. 先所有**分组节点**（按 `dbstudio.groups` 里的顺序）；
 *   2. 再所有**未分组连接**（保持服务端返回的原始顺序）。
 *
 * 为什么分组在前：任务要求"分组节点显示在连接之前"；也更符合直觉
 * （组织容器在上，散落在下）。
 *
 * 组内连接的顺序沿用服务端顺序，不额外排序——排序是另一个功能，
 * 在这里偷偷排序会让"为什么顺序变了"变成一个谜。
 *
 * @returns 根层节点描述数组。`kind: 'group'` 的需要调用方包成 NodeState。
 */
export type RootEntry =
  | { readonly kind: 'group'; readonly name: string; readonly connections: readonly ObjectRef[] }
  | { readonly kind: 'connection'; readonly ref: ObjectRef }

export function buildRootEntries(
  connections: readonly ObjectRef[],
  groups: readonly string[],
  groupOf: (connectionId: string) => string | null
): RootEntry[] {
  // 已知分组名（本地列表为准）；连接上指向**不在列表里**的组名时，
  // 不做"猜"，当作未分组处理——但这也意味着那部分偏好读不出来。
  // 为了不丢数据，这里把"连接引用了但列表里没有"的组名补进有效组集合，
  // 否则用户的连接会凭空出现在顶层、看起来像丢了分组。
  const effectiveGroups: string[] = [...groups]
  const buckets = new Map<string, ObjectRef[]>()
  for (const g of effectiveGroups) buckets.set(g, [])

  const ungrouped: ObjectRef[] = []
  for (const conn of connections) {
    // 只认 connection 类型的根节点。
    if (conn.kind !== 'connection') {
      ungrouped.push(conn)
      continue
    }
    const g = groupOf(conn.id)
    if (g === null) {
      ungrouped.push(conn)
      continue
    }
    let bucket = buckets.get(g)
    if (!bucket) {
      // 组名存在但不在列表里：补建（见上面注释）。
      bucket = []
      buckets.set(g, bucket)
      effectiveGroups.push(g)
    }
    bucket.push(conn)
  }

  const entries: RootEntry[] = []
  for (const g of effectiveGroups) {
    const conns = buckets.get(g) ?? []
    // 空组也显示：用户刚建的空分组应当可见，否则"建了组却看不到"很困惑。
    entries.push({ kind: 'group', name: g, connections: conns })
  }
  for (const conn of ungrouped) {
    entries.push({ kind: 'connection', ref: conn })
  }
  return entries
}

/**
 * 把分组节点伪造成一个 `ObjectRef`（`kind: 'folder'` + meta 标记）。
 *
 * 为什么用 folder 而不是新造 kind：`NodeKind` 是 core 的联合类型，
 * 加值要改 core（不在本次写入范围）；而 `folder` 在树里本来就是"可折叠容器"，
 * 语义最接近。用 `meta.isConnGroup = true` 明确标记身份，避免与数据库里的
 * folder（`connection:c1|folder:tables`）混淆。
 *
 * id 用 `conngroup:<name>`，**不带 `connection:` 前缀**——这很关键：
 * 它会被 `NodeId.parse()` 判为 null，从而任何依赖连接归属的逻辑
 * （DDL、ER、筛选）都不会把它误当成连接内的对象。
 */
export function groupToObjectRef(name: string): ObjectRef {
  return {
    id: `conngroup:${name}`,
    kind: 'folder',
    name,
    parentId: null,
    hasChildren: true,
    meta: { [CONN_GROUP_FLAG]: true }
  }
}

/** 判断某 ref 是否是连接分组节点。 */
export function isConnGroupRef(ref: ObjectRef): boolean {
  return ref.kind === 'folder' && ref.meta?.[CONN_GROUP_FLAG] === true
}
