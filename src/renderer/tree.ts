/**
 * 虚拟化 + 懒加载的元数据树。
 *
 * ===== 为什么是「DOM 虚拟滚动」而不是「自绘 Canvas」 =====
 *
 * DBeaver 的结果集网格 LightGrid 是自绘 Canvas 控件
 * （证据：devel@cf0f184e `.../controls/lightgrid/LightGrid.java#L50`
 *   `public abstract class LightGrid extends Canvas`，
 *   绘制循环在 `onPaint`，只从 `getTopIndex()` 迭代 `visibleRows` 次，见 `#L2202` / `#L2230` / `#L2245`）。
 *
 * 但剖析报告「陷阱 2」明确指出：**DBeaver 自研自绘的原因不是"原生表格慢"，
 * 而是 SWT Table 给不了多级列头 / 固定列 / 可嵌套行这些能力。**
 * Web 端 DOM 虚拟滚动本身就是成熟方案，且浏览器会自动处理
 * 无障碍、选区、文本断行——自绘 Canvas 反而要自己重写这些。
 *
 * 所以这里只借鉴它的**核心思想**（只渲染可视区，O(可视) 而非 O(总行数)），
 * 实现手段用 Web 的原生方式。
 *
 * ===== 虚拟滚动是怎么做的 =====
 *
 *   #tree-spacer 高度 = 总行数 × 行高        → 让滚动条比例正确
 *   #tree-rows   只放 [start, end) 这一段行 → DOM 节点数恒定
 *   #tree-rows 用 translateY 位移           → 视觉上贴住滚动位置
 *
 * 行高固定是这套方案的前提。可变行高会让 index↔offset 的换算退化成前缀和查询，
 * 复杂度陡增——本项目的元数据行都是单行文本，没有这个必要。
 */

import type { ObjectRef } from '../core/model'
import {
  buildRootEntries,
  defaultStore,
  deleteGroup,
  getConnColor,
  getConnGroup,
  getGroups,
  groupToObjectRef,
  colorCss,
  isConnGroupRef,
  renameGroup,
  setConnColor,
  setConnGroup,
  PRESET_COLORS,
  type KVStore
} from './conn-organize'
import type { DbStudioApi } from '../core/api'
import {
  asDdlApi,
  dropTableWithConfirm,
  dropViewWithConfirm,
  openCreateTableDialog,
  openCreateViewDialog,
  openRenameTableDialog,
  showDdlError,
  type DdlApi
} from './ddl'
import { NodeId } from '../core/api'

/**
 * 一组 DDL 菜单项描述。为什么拆成 create/rename/drop 三槽而不是一个数组：
 * 顺序与分组在菜单里是固定的（新建在最上、删除在最下且用危险色），
 * 用命名槽位比"往数组里按顺序 push"更难出错。
 */
interface DdlMenuTarget {
  create?: { label: string; run: (api: DdlApi) => void }
  rename?: { label: string; run: (api: DdlApi) => void }
  drop?: { label: string; run: (api: DdlApi) => void }
}

/**
 * 刷新/连接/断开需要调 API，但本类的构造签名只接收 `listChildren`——
 * 这是刻意的边界（见文件头「渲染进程不知道数据库长什么样」）。
 * 为了在不改 main.ts 的前提下补上节点级操作，这里把 API 取成**可选**：
 *   1. 优先用 main.ts 传进来的回调（若日后接线，行为可控）；
 *   2. 否则退回 `window.dbstudio`（preload 白名单已暴露，见 preload/index.ts#L137）。
 * 两条路都没有时菜单项直接禁用，绝不静默失效。
 */
function optionalApi(): DbStudioApi | undefined {
  return (globalThis as unknown as { dbstudio?: DbStudioApi }).dbstudio
}

/** 与 CSS 里 `.tree-row { height }` 必须一致，否则滚动位置会错位。 */
const ROW_HEIGHT = 26
/** 视口上下各多渲染几行，滚动时不会出现白边。 */
const OVERSCAN = 6
/** 每层缩进的像素。 */
const INDENT = 14

interface NodeState {
  readonly ref: ObjectRef
  readonly depth: number
  expanded: boolean
  loading: boolean
  error: string | null
  /** null = 尚未加载过（懒加载的关键状态）。 */
  children: NodeState[] | null
}

/** 展平后的一行：既可能是真实节点，也可能是状态提示行。 */
type Row =
  | { kind: 'node'; key: string; depth: number; node: NodeState }
  | {
      kind: 'message'
      key: string
      depth: number
      tone: 'loading' | 'empty' | 'error'
      text: string
      /** 出错时可点重试。 */
      retry?: () => void
    }

export interface TreeCallbacks {
  /** 选中并需要展示详情（点击/回车）。 */
  onSelect(node: ObjectRef | null): void
  /** 状态栏提示。 */
  onStatus(text: string, isError?: boolean): void
  /**
   * 更新树面板左上角的一行摘要（如「2 个连接 · 1 个已连接」）。
   *
   * 为什么要单独一个回调：这个元素原先只在 index.html 里写死「未连接」，
   * 渲染进程从不更新它——于是**连上库之后界面依然显示「未连接」**，
   * 属于会误导用户的信息。修法是把更新权交给这里。
   */
  onSummary(text: string): void
  /**
   * 节点级刷新时，要求外部重新载入连接列表（连接层刷新会改变摘要）。
   * 可选：未接线时退化为只重载该子树。
   */
  onRootsChanged?(): void
  /**
   * 连接节点右键「查看 ER 图」时触发（E1-C 追加）。
   *
   * 可选：ER 图的渲染依赖 main.ts 的容器与 openTable 路径，树自身只负责把
   * "用户想对某连接看 ER 图"这个意图传出去，不直接持有渲染逻辑。
   * 未接线时该菜单项 disabled，不静默失败。
   */
  onViewErDiagram?(connectionRef: ObjectRef): void
}

export class MetadataTree {
  readonly #viewport: HTMLElement
  readonly #spacer: HTMLElement
  readonly #rowsEl: HTMLElement
  readonly #listChildren: (nodeId: string | null) => Promise<ObjectRef[]>
  readonly #cb: TreeCallbacks
  /**
   * 颜色/分组偏好存储。
   *
   * 为什么走 localStorage 而不是连接配置：颜色/分组是纯本地 UI 偏好，
   * 而改连接配置要调 `updateConnection`，那会**断开重连**——用户只想改个颜色，
   * 结果连接被踢掉，不可接受。详见 conn-organize.ts 文件头。
   */
  readonly #store: KVStore
  /** 分组节点的展开态（按组名记，与连接 id 无关，所以组改名后需迁移）。 */
  readonly #groupExpanded = new Map<string, boolean>()

  #roots: NodeState[] = []
  /**
   * 展平后、**未经搜索过滤**的完整行数组。
   *
   * 为什么要保留这份：过滤是「在已展平的可见行里挑」，而 #rows 会变成过滤后的结果。
   * 清空搜索时必须能原样恢复，所以不能就地覆盖——必须留一份全量。
   */
  #allRows: Row[] = []
  #rows: Row[] = []
  #selectedKey: string | null = null
  #lastRenderKey = ''

  /** 当前搜索词（已 trim + 小写）。空串表示不过滤。 */
  #filter = ''
  #searchInput: HTMLInputElement | null = null
  #searchCountEl: HTMLElement | null = null
  #debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** 右键菜单元素（单例，复用以避免重复挂 document 监听）。 */
  #menuEl: HTMLElement | null = null

  constructor(
    viewport: HTMLElement,
    spacer: HTMLElement,
    rowsEl: HTMLElement,
    listChildren: (nodeId: string | null) => Promise<ObjectRef[]>,
    callbacks: TreeCallbacks,
    // 颜色/分组的本地存储（默认 localStorage；测试或禁用时可注入 MemoryStore）。
    store: KVStore = defaultStore()
  ) {
    this.#viewport = viewport
    this.#spacer = spacer
    this.#rowsEl = rowsEl
    this.#listChildren = listChildren
    this.#cb = callbacks
    this.#store = store

    // 滚动只做「重算切片 + 重绘可见行」，不重建整棵树。
    this.#viewport.addEventListener('scroll', () => this.#scheduleRender(), { passive: true })
    // 窗口尺寸变化时可视行数变了，必须重算。
    globalThis.addEventListener('resize', () => this.#scheduleRender())
    this.#viewport.addEventListener('keydown', (e) => this.#onKeyDown(e))
    // 右键菜单：整棵树一个监听，按行定位。
    this.#viewport.addEventListener('contextmenu', (e) => this.#onContextMenu(e))
    this.#installSearchBox()
  }

  /**
   * 创建搜索框。
   *
   * 为什么用 JS 创建而不写在 index.html：index.html 不在本工作流的写入范围内，
   * 且搜索是树的内部职责——树自己管自己的 UI，外部只需要一个挂载点。
   *
   * 插在 #tree-viewport **之前**（即 #tree-pane 里的 toolbar 与 viewport 之间），
   * 这样它不参与虚拟滚动的绝对定位层，不会被 transform 带走。
   */
  #installSearchBox(): void {
    const host = this.#viewport.parentElement
    if (!host) return

    const wrap = document.createElement('div')
    // 复用已有 token 做内联样式：不改 style.css（那是别人的独占文件）。
    wrap.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:6px 10px;' +
      'border-bottom:1px solid var(--border);'

    const label = document.createElement('label')
    // 无障碍：aria-label + for 双保险，读屏器能念出「搜索元数据节点」。
    label.setAttribute('for', 'tree-search-input')
    label.setAttribute('aria-label', '搜索元数据节点')
    label.textContent = '🔍'
    label.style.cssText = 'font-size:12px;color:var(--fg-dim);flex:0 0 auto;'

    const input = document.createElement('input')
    input.id = 'tree-search-input'
    input.type = 'search'
    input.setAttribute('aria-label', '搜索元数据节点')
    input.setAttribute('autocomplete', 'off')
    // 诚实标注范围：这一点是硬要求——只对**已加载**的节点生效。
    // 让人以为搜了全库、实际只搜了一部分，比明说「搜不了」更糟。
    input.placeholder = '仅搜索已展开的节点…（/ 聚焦，Esc 清空）'
    input.title = '仅搜索已展开的节点：未展开的分支还没有加载，因此搜不到'
    input.style.cssText =
      'flex:1 1 auto;min-width:0;font:inherit;font-size:12px;padding:3px 6px;' +
      'border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);'

    const count = document.createElement('span')
    count.setAttribute('role', 'status')
    count.setAttribute('aria-live', 'polite')
    count.textContent = ''
    count.style.cssText =
      'flex:0 0 auto;font-size:11px;color:var(--fg-dim);font-family:var(--mono);' +
      'white-space:nowrap;'

    // 去抖 150ms：121 张表时每敲一个字符重建行数组代价可观，且打字时中间态没意义。
    input.addEventListener('input', () => {
      if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer)
      this.#debounceTimer = setTimeout(() => {
        this.#debounceTimer = null
        this.#applyFilter(input.value)
      }, 150)
    })
    // Esc：清空并聚焦回树（用户想「退出搜索」时不该留在输入框里）。
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        input.value = ''
        this.#applyFilter('')
        this.#viewport.focus()
      }
    })

    wrap.appendChild(label)
    wrap.appendChild(input)
    wrap.appendChild(count)
    host.insertBefore(wrap, this.#viewport)

    this.#searchInput = input
    this.#searchCountEl = count
  }

  /** 重新加载根层（连接列表）。 */
  async loadRoots(): Promise<void> {
    this.#cb.onStatus('正在加载连接…')
    try {
      const refs = await this.#listChildren(null)
      // 「拉完 → 构建节点」之间插入本地分组逻辑（分组是纯本地偏好，
      // 服务端返回的是扁平连接列表，只能在这一步重新组织成两层）。
      this.#roots = this.#buildRootsWithGroups(refs)
      this.#rebuildRows()
      const connected = refs.filter((r) => r.meta?.['connected'] === true).length
      // 摘要里区分「已保存」与「已连接」——加入持久化后这两个不是一回事：
      // 启动时只载入配置不建会话，所以「2 个连接 · 0 个已连接」是正常状态。
      const groupCount = getGroups(this.#store).length
      this.#cb.onSummary(
        refs.length === 0
          ? '未连接'
          : `${refs.length} 个连接 · ${connected} 个已连接` +
              (groupCount > 0 ? ` · ${groupCount} 个分组` : '')
      )
      this.#cb.onStatus(`共 ${refs.length} 个连接`)
      if (refs.length === 0) {
        this.#cb.onStatus('还没有连接，点击右上角「新建连接」开始')
      }
    } catch (e) {
      this.#roots = []
      this.#rebuildRows()
      this.#cb.onStatus(`加载连接失败：${errText(e)}`)
    }
  }

  /**
   * 把扁平的连接列表按本地分组偏好组织成根层节点。
   *
   * 分组节点是**真的父节点**（children 就是连接节点），因此树的展开/折叠、
   * 搜索过滤、键盘导航对它自动生效，不需要任何特判。
   * 展开态额外记在 #groupExpanded（组名→布尔）：NodeState 每次 loadRoots 都会
   * 重建，不能依赖对象身份保存展开状态。
   */
  #buildRootsWithGroups(refs: readonly ObjectRef[]): NodeState[] {
    const groups = getGroups(this.#store)
    const entries = buildRootEntries(refs, groups, (id) => getConnGroup(this.#store, id))
    const roots: NodeState[] = []
    for (const entry of entries) {
      if (entry.kind === 'connection') {
        roots.push(this.#makeNode(entry.ref, 0))
        continue
      }
      // 分组节点 depth 0，组内连接 depth 1。
      const groupNode = this.#makeNode(groupToObjectRef(entry.name), 0)
      groupNode.children = entry.connections.map((c) => this.#makeNode(c, 1))
      // 新建的组默认展开（用户刚分完组，应立刻看到结果）；之后沿用记住的展开态。
      groupNode.expanded = this.#groupExpanded.get(entry.name) ?? true
      this.#groupExpanded.set(entry.name, groupNode.expanded)
      roots.push(groupNode)
    }
    return roots
  }

  /** 设置某连接的颜色（null = 清除）。只影响渲染，不重取数据。 */
  #applyConnColor(node: NodeState, colorId: string | null): void {
    setConnColor(this.#store, stripConnPrefix(node.ref.id), colorId)
    this.#lastRenderKey = ''
    this.render()
    this.#cb.onStatus(
      colorId === null
        ? `已清除「${node.ref.name}」的颜色`
        : `已把「${node.ref.name}」标为${
            PRESET_COLORS.find((c) => c.id === colorId)?.label ?? colorId
          }`
    )
  }

  /** 把连接移入组（null → 移回顶层）。 */
  #moveToGroup(node: NodeState, groupName: string | null): void {
    setConnGroup(this.#store, stripConnPrefix(node.ref.id), groupName)
    this.#rebuildRootsFromCache()
    this.#cb.onStatus(
      groupName === null
        ? `「${node.ref.name}」已移出分组`
        : `「${node.ref.name}」已移入「${groupName}」`
    )
  }

  /** 重命名组。 */
  #renameConnGroup(groupName: string, newName: string): boolean {
    const ok = renameGroup(this.#store, groupName, newName)
    if (!ok) {
      this.#cb.onStatus(`重命名失败：「${newName}」已存在或原分组「${groupName}」不存在`, true)
      return false
    }
    // 展开态跟着组名迁移，否则改名后组突然折叠，看起来像"内容没了"。
    const wasExpanded = this.#groupExpanded.get(groupName)
    this.#groupExpanded.delete(groupName)
    if (wasExpanded !== undefined) this.#groupExpanded.set(newName, wasExpanded)
    this.#rebuildRootsFromCache()
    this.#cb.onStatus(`分组「${groupName}」已重命名为「${newName}」`)
    return true
  }

  /**
   * 删除组：**组内连接回到顶层，连接本身完好**。
   *
   * 这是本功能最关键的不变量。deleteGroup 只删「分组归属」记录与组列表项，
   * 绝不触碰连接配置或连接对象——所以删组永远删不掉连接。
   */
  #deleteConnGroup(groupName: string): void {
    const memberCount = this.#countGroupMembers(groupName)
    if (!deleteGroup(this.#store, groupName)) {
      this.#cb.onStatus(`删除分组失败：「${groupName}」不存在`, true)
      return
    }
    this.#groupExpanded.delete(groupName)
    this.#rebuildRootsFromCache()
    this.#cb.onStatus(
      `已删除分组「${groupName}」，其中 ${memberCount} 个连接已回到顶层（连接本身未被删除）`
    )
  }

  /** 当前缓存里属于某组的连接数（给删除提示用）。 */
  #countGroupMembers(groupName: string): number {
    let n = 0
    for (const node of this.#roots) {
      if (!isConnGroupRef(node.ref)) continue
      if (node.ref.name !== groupName) continue
      n += node.children?.length ?? 0
    }
    return n
  }

  /**
   * 用「上次从服务端拿到的连接 refs」重新按本地偏好构建根节点。
   *
   * 为什么不直接 loadRoots()：分组/颜色是纯本地变化，再问一次服务端既慢，
   * 又会把所有已加载的子节点缓存丢掉（用户展开的 schema 会全部收起）。
   */
  #rebuildRootsFromCache(): void {
    const connections: ObjectRef[] = []
    for (const node of this.#roots) {
      if (isConnGroupRef(node.ref)) {
        for (const child of node.children ?? []) connections.push(child.ref)
      } else {
        connections.push(node.ref)
      }
    }
    this.#roots = this.#buildRootsWithGroups(connections)
    this.#rebuildRows()
  }

  /** 已有分组名（供菜单选择）。 */
  #existingGroups(): string[] {
    return getGroups(this.#store)
  }


  #makeNode(ref: ObjectRef, depth: number): NodeState {
    return { ref, depth, expanded: false, loading: false, error: null, children: null }
  }

  /**
   * 展开/折叠。
   *
   * 懒加载的关键：只有**第一次**展开才真的发请求。
   * 之后展开用的是缓存（`children !== null`），否则每次折叠再展开都会打一次网络。
   */
  async toggle(node: NodeState): Promise<void> {
    if (!node.ref.hasChildren) return
    if (node.expanded) {
      node.expanded = false
      this.#rebuildRows()
      return
    }
    node.expanded = true
    if (node.children === null) {
      await this.#loadChildren(node)
    } else {
      this.#rebuildRows()
    }
  }

  async #loadChildren(node: NodeState): Promise<void> {
    node.loading = true
    node.error = null
    this.#rebuildRows()
    try {
      const refs = await this.#listChildren(node.ref.id)
      node.children = refs.map((ref) => this.#makeNode(ref, node.depth + 1))
    } catch (e) {
      node.error = errText(e)
      node.children = null
    } finally {
      node.loading = false
      this.#rebuildRows()
    }
  }

  /** 把树按「展开状态」展平成一维行数组。虚拟滚动只认这个数组。 */
  #rebuildRows(): void {
    const rows: Row[] = []
    const walk = (nodes: NodeState[]): void => {
      for (const node of nodes) {
        rows.push({ kind: 'node', key: keyOf(node.ref), depth: node.depth, node })
        if (!node.expanded) continue
        if (node.loading) {
          rows.push({
            kind: 'message',
            key: `${keyOf(node.ref)}::loading`,
            depth: node.depth + 1,
            tone: 'loading',
            text: '加载中…'
          })
          continue
        }
        if (node.error) {
          rows.push({
            kind: 'message',
            key: `${keyOf(node.ref)}::error`,
            depth: node.depth + 1,
            tone: 'error',
            text: `加载失败：${node.error}（点击重试）`,
            retry: () => void this.#loadChildren(node)
          })
          continue
        }
        if (node.children && node.children.length === 0) {
          rows.push({
            kind: 'message',
            key: `${keyOf(node.ref)}::empty`,
            depth: node.depth + 1,
            tone: 'empty',
            text: '无对象'
          })
          continue
        }
        if (node.children) walk(node.children)
      }
    }
    walk(this.#roots)
    // 全量先存起来；过滤只派生 #rows，绝不就地覆盖 #allRows，
    // 否则清空搜索时无法恢复「折叠/展开的原始视图」。
    this.#allRows = rows
    this.#recomputeFilteredRows()
  }

  /**
   * 依据当前 #filter 从 #allRows 派生 #rows。
   *
   * ===== 过滤规则（含祖先链保留）=====
   * 直接按 `#rows.filter(命中)` 是错的：子节点命中而父节点被滤掉会看不到层级，
   * 甚至出现「孤儿行」缩进错乱。正确做法是自顶向下递归，
   * **只要子树里有命中，当前节点就必须留下**，并在其下继续递归。
   *
   * ===== 为什么在「行」这一层做，而不是在 NodeState 上做 =====
   * #allRows 已经体现了折叠状态（折叠节点的子节点本来就不在里面）。
   * 在这里过滤，天然满足「只搜索已展开的节点」——这正是必须诚实标注的范围。
   */
  #recomputeFilteredRows(): void {
    const q = this.#filter
    let matched = 0
    let rows: Row[]

    if (!q) {
      rows = this.#allRows
    } else {
      const keep: Row[] = []
      // 递归用「depth 严格递增的连续区间」判断父子关系：#allRows 是 DFS 序。
      //
      // 为什么这个判据在真实数据上成立（重要前提，改 #rebuildRows 时必须同改）：
      // message 行（加载中/出错/无对象）的 depth = 父 depth + 1，且**只在**
      // 该父节点「已展开但没有真实子节点」时出现——此时该节点子树里只有这一行，
      // 不会出现「message 行与真正的孙节点同级并列」的情况。
      // 因此 message 行的 depth 不会与其它同层真实节点混淆，区间切分安全。
      const visit = (from: number, endIdx: number): boolean => {
        let i = from
        let anyKept = false
        while (i < endIdx) {
          const row = this.#allRows[i]
          if (!row) break
          const depth = row.depth
          // 找该行的子树区间 [i+1, j)
          let j = i + 1
          while (j < endIdx) {
            const next = this.#allRows[j]
            if (!next || next.depth <= depth) break
            j++
          }
          const selfHit = row.kind === 'node' && row.node.ref.name.toLowerCase().includes(q)
          // 先递归子树决定是否也要保留（无论自己是否命中）。
          const childKept = visit(i + 1, j)
          if (selfHit) {
            matched++
            keep.push(row)
            // 命中的节点：把整棵子树原样保留，用户才能看清它的位置。
            for (let k = i + 1; k < j; k++) {
              const c = this.#allRows[k]
              if (c) keep.push(c)
            }
          } else if (childKept) {
            keep.push(row)
          }
          i = j
          if (selfHit || childKept) anyKept = true
        }
        return anyKept
      }
      visit(0, this.#allRows.length)
      rows = keep
    }

    this.#rows = rows
    this.#lastRenderKey = ''
    this.#updateSearchCount(matched)
    this.#scheduleRender()
  }

  /** 更新搜索框右侧的「匹配 N / M」提示；只在有搜索词时显示。 */
  #updateSearchCount(matched: number): void {
    const el = this.#searchCountEl
    if (!el) return
    if (!this.#filter) {
      el.textContent = ''
      return
    }
    // 分母用「已加载的可搜索节点数」（节点行，不含加载中/空提示行），
    // 而不是全库表数——因为我们只搜得到已加载的部分，分母也必须诚实。
    const loadedNodes = this.#allRows.filter((r) => r.kind === 'node').length
    el.textContent = `匹配 ${matched} / ${loadedNodes}`
    // 0 命中时给个更明确的提示，避免用户以为「树坏了」。
    el.style.color = matched === 0 ? 'var(--danger)' : 'var(--fg-dim)'
  }

  /** 应用搜索词（由输入框去抖后调用，或 Esc 清空时调用）。 */
  #applyFilter(raw: string): void {
    const next = raw.trim().toLowerCase()
    if (next === this.#filter) return
    this.#filter = next
    // 过滤会改变行数与选中项可见性：若当前选中行被滤掉，清掉选中态避免幽灵选中。
    if (this.#selectedKey !== null) {
      const stillVisible = this.#allRows.some(
        (r) => r.kind === 'node' && r.key === this.#selectedKey && this.#matchesVisible(r)
      )
      if (!stillVisible) this.#selectedKey = null
    }
    this.#recomputeFilteredRows()
    if (next) {
      this.#cb.onStatus(`正在过滤已加载节点：「${next}」`)
    } else {
      // 清空过滤时必须把状态提示也恢复，否则会一直残留「正在过滤…」，
      // 用户看着树已经全展开了、状态栏却还在说在过滤——典型的残留状态。
      this.#cb.onStatus(`已清除过滤，共 ${this.#roots.length} 个连接`)
    }
  }

  /** 选中行是否仍出现在过滤后的 #rows 里（按 key 比对，避免对象身份问题）。 */
  #matchesVisible(row: Extract<Row, { kind: 'node' }>): boolean {
    if (!this.#filter) return true
    return this.#rows.some((r) => r.kind === 'node' && r.key === row.key)
  }

  #scheduleRender(): void {
    // 用 microtask 合并同一帧内的多次触发（滚动会连续发事件）。
    queueMicrotask(() => this.render())
  }

  /** 只渲染可视区。这是整个文件的核心。 */
  render(): void {
    // ⚠️ 关键：这里的 total 必须是**过滤后**的行数（即 #rows.length），
    // 不能用 #allRows.length。撑高元素高度 = total × 行高，它决定滚动条比例；
    // 若用全量行数，过滤后滚动条仍按全量算，会出现「能滚到空白区 / 滚不到底」。
    const total = this.#rows.length
    // 撑高元素决定滚动条能滚多远，必须等于完整高度。
    this.#spacer.style.height = `${total * ROW_HEIGHT}px`

    const viewportH = this.#viewport.clientHeight || 0
    const scrollTop = this.#viewport.scrollTop
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    // 行数变少（过滤后）时，可能当前 scrollTop 已超出新内容高度。
    // 浏览器在 spacer 变矮后会自动 clamp scrollTop，但本帧读到的仍是旧值，
    // 于是 end 会算到 total 之外——用 min(total, …) 兜住即可，不会越界渲染。
    const end = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN)

    // 切片没变就不动 DOM —— 滚动时大部分帧其实只需要平移，不需要重建。
    const renderKey = `${start}:${end}:${this.#selectedKey ?? ''}:${total}`
    this.#rowsEl.style.transform = `translateY(${start * ROW_HEIGHT}px)`
    if (renderKey === this.#lastRenderKey) return
    this.#lastRenderKey = renderKey

    const frag = document.createDocumentFragment()
    for (let i = start; i < end; i++) {
      const row = this.#rows[i]
      if (!row) continue
      frag.appendChild(row.kind === 'node' ? this.#renderNodeRow(row) : this.#renderMessageRow(row))
    }
    this.#rowsEl.replaceChildren(frag)
  }

  #renderNodeRow(row: Extract<Row, { kind: 'node' }>): HTMLElement {
    const { node } = row
    const el = document.createElement('div')
    const selected = this.#selectedKey === row.key
    el.className = 'tree-row'
    if (node.ref.kind === 'connection') el.classList.add('is-connection')
    el.dataset['key'] = row.key
    el.setAttribute('role', 'treeitem')
    el.setAttribute('aria-level', String(node.depth + 1))
    el.setAttribute('aria-selected', selected ? 'true' : 'false')
    if (node.ref.hasChildren) {
      el.setAttribute('aria-expanded', node.expanded ? 'true' : 'false')
    }
    el.style.paddingLeft = `${6 + node.depth * INDENT}px`

    // ---- 连接颜色标记 ----
    // 只对**连接节点**上色（分组/表/列不需要颜色语义）。
    // 做法克制：左侧 3px 色条 + 名字前小圆点，避免整行染色造成视觉噪音。
    // 颜色是纯本地偏好（localStorage），不进连接配置（见 conn-organize.ts）。
    if (node.ref.kind === 'connection') {
      const colorId = getConnColor(this.#store, stripConnPrefix(node.ref.id))
      const css = colorCss(colorId)
      if (css) {
        el.classList.add('has-conn-color')
        // 色条用 box-shadow inset 而不是 border，避免改变行高/宽度导致虚拟滚动错位。
        el.style.boxShadow = `inset 3px 0 0 0 ${css}`
        el.setAttribute('data-conn-color', colorId ?? '')
      }
    }
    // 分组节点加个类，便于样式区分（图标与折叠行为复用 folder 那套）。
    if (isConnGroupRef(node.ref)) el.classList.add('is-conn-group')

    // 只有「确实可能有子节点」的才画箭头，避免用户展开出空节点。
    const twisty = document.createElement('span')
    twisty.className = 'twisty'
    twisty.textContent = node.ref.hasChildren ? (node.expanded ? '▾' : '▸') : ''
    twisty.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.toggle(node)
    })
    el.appendChild(twisty)

    const icon = document.createElement('span')
    icon.className = 'row-icon'
    icon.textContent = iconFor(node.ref.kind)
    icon.setAttribute('aria-hidden', 'true')
    el.appendChild(icon)

    // 颜色圆点（在名字之前）。只在连接节点且设了色时出现。
    if (node.ref.kind === 'connection') {
      const dotCss = colorCss(getConnColor(this.#store, stripConnPrefix(node.ref.id)))
      if (dotCss) {
        const dot = document.createElement('span')
        dot.className = 'conn-color-dot'
        dot.setAttribute('aria-hidden', 'true')
        dot.style.background = dotCss
        el.appendChild(dot)
      }
    }

    const label = document.createElement('span')
    label.className = 'row-label'
    label.textContent = node.ref.name
    el.appendChild(label)

    const meta = metaText(node.ref)
    if (meta) {
      const metaEl = document.createElement('span')
      metaEl.className = 'row-meta'
      metaEl.textContent = meta
      el.appendChild(metaEl)
    }

    el.addEventListener('click', () => {
      this.#select(row.key, node)
    })
    el.addEventListener('dblclick', () => {
      void this.toggle(node)
    })
    return el
  }

  #renderMessageRow(row: Extract<Row, { kind: 'message' }>): HTMLElement {
    const el = document.createElement('div')
    el.className = 'tree-row'
    el.style.paddingLeft = `${6 + row.depth * INDENT + 16}px`
    const span = document.createElement('span')
    span.className = row.tone === 'error' ? 'row-error' : 'row-state'
    span.textContent = row.text
    if (row.tone === 'error' && row.retry) {
      span.addEventListener('click', (e) => {
        e.stopPropagation()
        row.retry?.()
      })
    }
    el.appendChild(span)
    return el
  }

  #select(key: string, node: NodeState): void {
    this.#selectedKey = key
    this.#lastRenderKey = ''
    this.render()
    this.#cb.onSelect(node.ref)
    // 键盘焦点跟着视觉选中走，读屏器才会播报正确的节点。
    this.#viewport.focus()
  }

  /** 当前展平行里，可被选中的「节点行」索引。 */
  #nodeIndices(): number[] {
    const out: number[] = []
    for (let i = 0; i < this.#rows.length; i++) {
      if (this.#rows[i]?.kind === 'node') out.push(i)
    }
    return out
  }

  #currentIndex(): number {
    if (this.#selectedKey === null) return -1
    return this.#rows.findIndex((r) => r.kind === 'node' && r.key === this.#selectedKey)
  }

  #onKeyDown(e: KeyboardEvent): void {
    // `/` 聚焦搜索框这件事不该依赖「当前有没有可导航的行」——
    // 空树时用户更需要搜索框来确认「是不是真的没东西」。
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && this.#searchInput) {
      e.preventDefault()
      this.#searchInput.focus()
      this.#searchInput.select()
      return
    }
    const idxs = this.#nodeIndices()
    if (idxs.length === 0) return
    const cur = this.#currentIndex()

    const moveTo = (targetIdx: number): void => {
      const row = this.#rows[targetIdx]
      if (!row || row.kind !== 'node') return
      this.#select(row.key, row.node)
      // 让选中行进入可视区，否则键盘导航会"走出屏幕"。
      const top = targetIdx * ROW_HEIGHT
      const bottom = top + ROW_HEIGHT
      if (top < this.#viewport.scrollTop) this.#viewport.scrollTop = top
      else if (bottom > this.#viewport.scrollTop + this.#viewport.clientHeight) {
        this.#viewport.scrollTop = bottom - this.#viewport.clientHeight
      }
    }

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = idxs.find((i) => i > cur)
        moveTo(next ?? idxs[idxs.length - 1] ?? 0)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const prev = [...idxs].reverse().find((i) => i < cur)
        moveTo(prev ?? idxs[0] ?? 0)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        const row = this.#rows[cur]
        if (row?.kind === 'node' && row.node.ref.hasChildren && !row.node.expanded) {
          void this.toggle(row.node)
        } else {
          const next = idxs.find((i) => i > cur)
          if (next !== undefined) moveTo(next)
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        const row = this.#rows[cur]
        if (row?.kind === 'node' && row.node.expanded) {
          void this.toggle(row.node)
        } else if (row?.kind === 'node') {
          // 回到父节点：depth 更小的前一个节点行
          const prev = [...idxs].reverse().find((i) => i < cur && this.#rows[i]?.kind === 'node')
          if (prev !== undefined) {
            const p = this.#rows[prev]
            if (p?.kind === 'node') moveTo(prev)
          }
        }
        break
      }
      case 'Enter': {
        e.preventDefault()
        const row = this.#rows[cur]
        if (row?.kind === 'node') this.#cb.onSelect(row.node.ref)
        break
      }
      default:
        break
    }
  }

  /** 供详情面板用：当前是否选中了某个节点。 */
  get selectedRef(): ObjectRef | null {
    const i = this.#currentIndex()
    const row = i >= 0 ? this.#rows[i] : undefined
    return row?.kind === 'node' ? row.node.ref : null
  }

  // ===========================================================================
  // 节点级刷新
  // ===========================================================================

  /**
   * 刷新单个节点：清缓存 → 重新拉子节点 → 保持展开状态。
   *
   * 为什么要「先置 null 再 load」：`children === null` 是本文件里
   * 「未加载/需重新加载」的唯一标记（见 #loadChildren）。直接把 children 置空，
   * expanded 保持原值不动，就能实现「刷新后仍展开」——因为 #loadChildren 结束
   * 后会 #rebuildRows，展开标志为 true 的子节点会自然重新出现在行数组里。
   */
  async refreshNode(node: NodeState): Promise<void> {
    if (!node.ref.hasChildren) {
      this.#cb.onStatus(`「${node.ref.name}」没有可刷新的子节点`)
      return
    }
    const wasExpanded = node.expanded
    node.children = null
    node.error = null
    // 保持展开：即使原先折叠，刷新一个节点也默认把它展开给用户看结果。
    node.expanded = true
    await this.#loadChildren(node)
    if (!wasExpanded && node.children === null) {
      // 加载失败时回退展开态，避免留下一个「展开但空着」的假象。
      node.expanded = false
      this.#rebuildRows()
    }
    this.#cb.onStatus(`已刷新「${node.ref.name}」`)
  }

  // ===========================================================================
  // 右键菜单
  // ===========================================================================

  #onContextMenu(e: MouseEvent): void {
    const rowEl = (e.target as HTMLElement | null)?.closest('.tree-row')
    if (!rowEl) return
    const key = (rowEl as HTMLElement).dataset['key']
    if (!key) return
    // 只对节点行开菜单；message 行（加载中/空/错误）没有可操作对象。
    const row = this.#rows.find((r) => r.kind === 'node' && r.key === key)
    if (!row || row.kind !== 'node') return
    e.preventDefault()
    this.#openMenu(e.clientX, e.clientY, row.node)
  }

  /**
   * 打开右键菜单。
   *
   * 用绝对定位 div 手写而非引入依赖：需求只有 3~4 个菜单项，
   * 引一个菜单库（含主题/定位/焦点陷阱）不划算，且会把 bundle 撑大。
   *
   * 菜单是**单例**（#menuEl），每次打开先移除旧的。挂 document 级监听
   * 在打开时注册、关闭时移除——避免常驻监听泄漏。
   */
  /**
   * 编辑已保存连接的对话框。
   *
   * 为什么放在 tree.ts 而不是新文件：它属于「连接节点的操作」，
   * 与右键菜单同源；单独开文件反而要在两个模块间传 node 与刷新回调。
   * （`ddl.ts` 已经承担了表/视图的 DDL 对话框，职责不同，不混在一起。）
   */
  #openEditConnection(node: NodeState): void {
    const api = optionalApi() as
      | (ReturnType<typeof optionalApi> & {
          updateConnection?: (
            id: string,
            cfg: Record<string, unknown>,
            secret?: string
          ) => Promise<unknown>
          listDialects?: () => Promise<Array<{ id: string; fields: ReadonlyArray<{ key: string; label: string; kind: string; required: boolean; placeholder?: string; default?: string | number }> }>>
        })
      | null
    if (!api || typeof api.updateConnection !== 'function') {
      globalThis.alert('编辑连接接口尚未就绪（updateConnection）')
      return
    }

    const connId = node.ref.id.startsWith('connection:') && !node.ref.id.includes('|')
      ? node.ref.id.slice('connection:'.length)
      : null
    if (!connId) {
      globalThis.alert('无法解析连接 id')
      return
    }

    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(0,0,0,.45)'
    const panel = document.createElement('div')
    panel.style.cssText =
      'background:var(--bg);color:var(--fg);border:1px solid var(--border);' +
      'border-radius:8px;padding:16px;min-width:380px;max-width:min(560px,90vw);' +
      'box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:13px'

    const h = document.createElement('div')
    h.textContent = `编辑连接「${node.ref.name}」`
    h.style.cssText = 'font-weight:600;margin-bottom:10px'
    panel.appendChild(h)

    const nameLabel = document.createElement('div')
    nameLabel.textContent = '连接名'
    nameLabel.style.cssText = 'color:var(--fg-dim);margin-bottom:4px'
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.value = node.ref.name
    nameInput.setAttribute('aria-label', '连接名')
    nameInput.style.cssText = inputStyleLocal()
    panel.appendChild(nameLabel)
    panel.appendChild(nameInput)

    // 连接参数：从方言元数据动态生成（与「新建连接」一致），
    // 但这里只填可改的文本类字段；密码单独一栏。
    const paramHost = document.createElement('div')
    paramHost.style.cssText = 'margin-top:10px;display:flex;flex-direction:column;gap:6px'
    panel.appendChild(paramHost)

    const hint = document.createElement('p')
    hint.setAttribute('role', 'alert')
    hint.style.cssText = 'margin:10px 0 0;color:var(--danger);font-size:12px;min-height:1.2em'
    panel.appendChild(hint)

    const footer = document.createElement('div')
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = '取消'
    const save = document.createElement('button')
    save.type = 'button'
    save.textContent = '保存'
    // ★ 初始禁用：参数输入框是异步（等 listDialects）建出来的。
    //   如果在建好之前就能点保存，收集到的 options 是空的，用户以为改了其实没改
    //   （实测踩到的 bug：对话框里 file 显示 placeholder 而非回填值，点保存后配置不变）。
    save.disabled = true
    save.title = '正在准备表单…'
    footer.append(cancel, save)
    panel.appendChild(footer)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)

    const close = (): void => overlay.remove()
    cancel.addEventListener('click', close)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close()
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        document.removeEventListener('keydown', onKey)
        close()
      }
    }
    document.addEventListener('keydown', onKey)

    // 密码栏（可选：留空表示不修改）
    const pwdLabel = document.createElement('div')
    pwdLabel.textContent = '密码（留空表示不修改）'
    pwdLabel.style.cssText = 'color:var(--fg-dim);margin:10px 0 4px'
    const pwdInput = document.createElement('input')
    pwdInput.type = 'password'
    pwdInput.setAttribute('aria-label', '密码')
    pwdInput.placeholder = '不修改则留空'
    pwdInput.style.cssText = inputStyleLocal()
    panel.appendChild(pwdLabel)
    panel.appendChild(pwdInput)

    void (async () => {
      // 拉方言元数据以生成参数输入框
      try {
        const dialects = (await api.listDialects?.()) ?? []
        const dialectId = String(node.ref.meta?.['dialect'] ?? '')
        const d = dialects.find((x) => x.id === dialectId)
        if (d) {
          for (const f of d.fields) {
            if (f.kind === 'password') continue // 密码单独一栏，已在上面
            const lab = document.createElement('div')
            lab.textContent = f.label
            lab.style.cssText = 'color:var(--fg-dim);font-size:12px'
            const inp = document.createElement('input')
            inp.type = f.kind === 'number' ? 'number' : 'text'
            inp.dataset['key'] = f.key
            // ★ 回填当前值。没有这一步，对话框只显示空框，用户不知道现在配的是什么，
            //   一改就可能把能用的配置覆盖成错的（实测发现的 bug）。
            const cur = node.ref.meta?.['options.' + f.key]
            if (cur !== undefined && cur !== null) inp.value = String(cur)
            if (f.placeholder) inp.placeholder = f.placeholder
            inp.style.cssText = inputStyleLocal()
            const wrap = document.createElement('div')
            wrap.append(lab, inp)
            paramHost.appendChild(wrap)
          }
        }
      } catch {
        /* 拿不到元数据时只允许改名字，不影响主流程 */
      } finally {
        // 表单已就绪（或确认拿不到参数只能改名）→ 允许保存
        save.disabled = false
        save.title = ''
      }
    })()

    save.addEventListener('click', () => {
      void (async () => {
        hint.textContent = ''
        save.disabled = true
        try {
          const cfg: Record<string, unknown> = {}
          const newName = nameInput.value.trim()
          if (newName !== '' && newName !== node.ref.name) cfg['name'] = newName

          const opts: Record<string, unknown> = {}
          const paramInputs = paramHost.querySelectorAll<HTMLInputElement>('input[data-key]')
          for (const inp of paramInputs) {
            const key = inp.dataset['key']
            const raw = inp.value.trim()
            if (key && raw !== '') {
              opts[key] = inp.type === 'number' ? Number(raw) : raw
            }
          }
          // 防御：表单里一个参数框都没有，却提交了「修改」——这会静默丢掉配置。
          // 与其让用户以为改了，不如明确报错。
          if (paramInputs.length === 0) {
            throw new Error('参数表单尚未就绪，请稍候重试（若持续如此，说明读取方言元数据失败）')
          }
          if (Object.keys(opts).length > 0) cfg['options'] = opts

          const secret = pwdInput.value.trim()
          const fn = api.updateConnection
          if (typeof fn !== 'function') throw new Error('updateConnection 不可用')
          await fn(connId, cfg, secret === '' ? undefined : secret)

          close()
          document.removeEventListener('keydown', onKey)
          this.#cb.onStatus(`已更新连接「${node.ref.name}」${node.ref.meta?.['connected'] === true ? '（已重连）' : ''}`)
          // 配置改了，刷新根层让名字/状态同步
          await this.loadRoots()
        } catch (e) {
          hint.textContent = e instanceof Error ? e.message : String(e)
        } finally {
          save.disabled = false
        }
      })()
    })
  }

  #openMenu(x: number, y: number, node: NodeState): void {
    this.#closeMenu()
    const isConn = node.ref.kind === 'connection'

    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', `${node.ref.name} 的操作`)
    // 内联样式：不改 style.css（别人独占）。z-index 用高值压住树与详情面板。
    menu.style.cssText =
      'position:fixed;z-index:9999;min-width:160px;padding:4px 0;' +
      'background:var(--bg);border:1px solid var(--border);border-radius:6px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.18);font-size:12px;user-select:none;'

    const items: Array<{ label: string; run: () => void; disabled?: boolean; danger?: boolean }> = [
      { label: '刷新此节点', run: () => void this.refreshNode(node) },
      { label: '复制名称', run: () => void this.#copyName(node.ref.name) }
    ]
    if (isConn) {
      const connected = node.ref.meta?.['connected'] === true
      const api = optionalApi()
      items.push(
        connected
          ? {
              label: '断开连接',
              disabled: !api,
              run: () => void this.#toggleConnection(node, false)
            }
          : {
              label: '连接',
              disabled: !api,
              run: () => void this.#toggleConnection(node, true)
            }
      )

      // 编辑连接：改配置 / 改密码。
      //
      // 为什么必须有这个入口：加了持久化之后，连接配置是**落盘**的。
      // 路径填错、库文件搬家、密码改了，用户只能「删掉重建」——
      // 而删除会丢掉 id，也丢掉已保存的其它设置。
      items.push({
        label: '编辑连接…',
        disabled: !api || typeof (api as { updateConnection?: unknown }).updateConnection !== 'function',
        run: () => this.#openEditConnection(node)
      })

      // 查看 ER 图（E1-C 追加）。
      //
      // 为什么挂在连接节点：ER 图是"整库/整连接"的视角，不是单表的事。
      // 只把意图转给 main.ts（onViewErDiagram），渲染与上限判断都在 er-diagram.ts；
      // 未接线时 disabled，并在点击时说明原因，不静默失败。
      const canEr = typeof this.#cb.onViewErDiagram === 'function'
      items.push({
        label: '查看 ER 图',
        disabled: !canEr,
        run: () => {
          if (typeof this.#cb.onViewErDiagram !== 'function') {
            this.#cb.onStatus('ER 图尚未接入（缺少 onViewErDiagram 回调）', true)
            return
          }
          this.#cb.onViewErDiagram(node.ref)
        }
      })

      // ---- 颜色标记（E2-B）----
      //
      // 为什么不做成「子菜单」而是一个可展开的调色板：预设色只有 7 个 + 清除，
      // 平铺比两级菜单更快。用文字符号（●）着色，不依赖额外图标资源。
      const currentColor = getConnColor(this.#store, stripConnPrefix(node.ref.id))
      items.push({
        label: `标记颜色…${currentColor ? '（已设置）' : ''}`,
        run: () => this.#openColorPicker(node)
      })

      // ---- 分组（E2-B）----
      items.push({
        label: '移动到分组…',
        run: () => this.#openMoveToGroup(node)
      })
    }

    // ---- 连接分组的操作（重命名 / 删除组）----
    if (isConnGroupRef(node.ref)) {
      items.push({
        label: '重命名分组…',
        run: () => this.#openRenameGroup(node.ref.name)
      })
      items.push({
        label: '删除分组（连接回到顶层）',
        danger: true,
        run: () => this.#openDeleteGroup(node.ref.name)
      })
    }

    // ---- DDL 入口 ----
    //
    // 按节点类型挂不同操作。注意「表」「视图」这两个**分组节点**（folder）
    // 才提供「新建…」，因为新建必须知道目标连接与分组；详见 core/api.ts 的 id 规则
    // （`folder:tables` / `folder:views`，经 scoped 后是 `connection:c1|folder:tables`）。
    //
    // DDL 是否会真正生效取决于 core/preload 是否已接入这五个方法——用 asDdlApi
    // 探测；未接入时菜单项 disabled，并在点击时给出明确原因，而不是静默失败。
    const ddlEntry = this.#ddlTargetFor(node.ref)
    if (ddlEntry) {
      const ddlApi = this.#tryDdlApi()
      if (ddlEntry.create) {
        items.push({
          label: ddlEntry.create.label,
          disabled: ddlApi === null,
          run: () => {
            if (ddlApi === null) return this.#reportDdlUnavailable(ddlEntry.create?.label)
            ddlEntry.create?.run(ddlApi)
          }
        })
      }
      if (ddlEntry.rename) {
        items.push({
          label: ddlEntry.rename.label,
          disabled: ddlApi === null,
          run: () => {
            if (ddlApi === null) return this.#reportDdlUnavailable(ddlEntry.rename?.label)
            ddlEntry.rename?.run(ddlApi)
          }
        })
      }
      if (ddlEntry.drop) {
        items.push({
          // 删除项用危险色标记，让用户在点之前就意识到后果。
          label: ddlEntry.drop.label,
          disabled: ddlApi === null,
          danger: true,
          run: () => {
            if (ddlApi === null) return this.#reportDdlUnavailable(ddlEntry.drop!.label)
            ddlEntry.drop!.run(ddlApi)
          }
        })
      }
    }
    for (const item of items) {
      const el = document.createElement('div')
      el.setAttribute('role', 'menuitem')
      el.setAttribute('tabindex', '-1')
      el.textContent = item.label
      if (item.disabled) el.setAttribute('aria-disabled', 'true')
      // 危险项（删除）用 --danger 着色；disabled 时统一降透明度。
      const isDanger = (item as { danger?: boolean }).danger === true
      el.style.cssText =
        'padding:6px 12px;white-space:nowrap;' +
        (item.disabled
          ? 'color:var(--fg-dim);opacity:.55;cursor:default;'
          : isDanger
            ? 'cursor:pointer;color:var(--danger);'
            : 'cursor:pointer;color:var(--fg);')
      if (!item.disabled) {
        el.addEventListener('mouseenter', () => {
          el.style.background = 'var(--bg-alt)'
        })
        el.addEventListener('mouseleave', () => {
          el.style.background = 'transparent'
        })
        el.addEventListener('click', (ev) => {
          ev.stopPropagation()
          this.#closeMenu()
          item.run()
        })
      }
      menu.appendChild(el)
    }

    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
    document.body.appendChild(menu)
    // 视口右侧/下方放不下时向内翻转，避免菜单被裁到屏幕外。
    const rect = menu.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`
    }

    this.#menuEl = menu
    // 关闭路径 1：点击别处（下一帧再挂，否则触发本次右键的 click 会立刻关掉）。
    // 用 capture 保证在目标元素自己的 handler 之前判定。
    setTimeout(() => {
      document.addEventListener('mousedown', this.#onDocMouseDown, true)
      document.addEventListener('keydown', this.#onDocKeyDown, true)
      window.addEventListener('blur', this.#onWindowBlur)
      window.addEventListener('resize', this.#onWindowBlur)
    }, 0)
    // 焦点移进菜单第一项，键盘用户可直接 Esc / Tab 退出。
    const first = menu.querySelector<HTMLElement>('[role="menuitem"]')
    first?.focus()
  }

  // 用箭头函数固化 this，便于 add/removeEventListener 拿到同一个引用。
  #onDocMouseDown = (e: MouseEvent): void => {
    if (this.#menuEl && !this.#menuEl.contains(e.target as Node)) this.#closeMenu()
  }

  /** 关闭路径 2：Esc。 */
  #onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      this.#closeMenu()
    }
  }

  #onWindowBlur = (): void => {
    this.#closeMenu()
  }

  #closeMenu(): void {
    if (!this.#menuEl) return
    this.#menuEl.remove()
    this.#menuEl = null
    document.removeEventListener('mousedown', this.#onDocMouseDown, true)
    document.removeEventListener('keydown', this.#onDocKeyDown, true)
    window.removeEventListener('blur', this.#onWindowBlur)
    window.removeEventListener('resize', this.#onWindowBlur)
  }

  async #copyName(name: string): Promise<void> {
    try {
      // 优先用异步剪贴板 API（file:// 下 Electron 渲染进程可用）；
      // 不可用时退回 execCommand，失败就只给状态栏提示，不静默。
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(name)
        this.#cb.onStatus(`已复制「${name}」`)
        return
      }
      const ta = document.createElement('textarea')
      ta.value = name
      ta.style.cssText = 'position:fixed;opacity:0;'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      this.#cb.onStatus(ok ? `已复制「${name}」` : '复制失败：剪贴板不可用', !ok)
    } catch (e) {
      this.#cb.onStatus(`复制失败：${errText(e)}`, true)
    }
  }

  async #toggleConnection(node: NodeState, connect: boolean): Promise<void> {
    const api = optionalApi()
    if (!api) {
      this.#cb.onStatus('连接操作不可用：缺少 dbstudio API', true)
      return
    }
    // 连接节点的 id 形如 `connection:c1`；API 要的是裸连接 id（主进程侧的键）。
    const connId = node.ref.id.startsWith('connection:')
      ? node.ref.id.slice('connection:'.length)
      : node.ref.id
    this.#cb.onStatus(connect ? '正在连接…' : '正在断开…')
    try {
      if (connect) await api.connectConnection(connId)
      else await api.disconnectConnection(connId)
      // 连接状态变了 → 该连接的子树必须作废重取（目录可能完全不同）。
      node.children = null
      node.expanded = true
      await this.#loadChildren(node)
      // 连接态影响左上角摘要「N 个连接 · M 个已连接」，交给外部重算。
      this.#cb.onRootsChanged?.()
      this.#cb.onStatus(connect ? '已连接' : '已断开')
    } catch (e) {
      this.#cb.onStatus(`${connect ? '连接' : '断开'}失败：${errText(e)}`, true)
    }
  }

  // ===========================================================================
  // DDL 入口
  // ===========================================================================

  /**
   * 取 DDL API；不可用返回 null。
   *
   * 为什么不直接 `asDdlApi(optionalApi())` 让它抛：菜单是**长生命周期**的构建过程，
   * 在 core/preload 尚未接入 DDL 的过渡期，抛异常会连菜单都打不开。
   * 所以这里做软探测——菜单项标 disabled，用户点的时候才给明确原因。
   */
  #tryDdlApi(): DdlApi | null {
    const api = optionalApi()
    if (!api) return null
    try {
      return asDdlApi(api)
    } catch {
      return null
    }
  }

  #reportDdlUnavailable(label: string | undefined): void {
    // 状态栏 + 阻塞提示各一份：状态栏会被后续消息冲掉，DDL 这类事必须让用户看见。
    this.#cb.onStatus(`「${label ?? 'DDL 操作'}」不可用：DDL 尚未接入`, true)
    showDdlError('DDL 功能不可用', '当前版本的主进程/预加载层尚未接入 DDL，无法执行该操作。')
  }

  /**
   * 依据节点类型给出 DDL 菜单项。返回 null 表示该节点没有 DDL 操作。
   *
   * 关键：从带连接归属的节点 id（`connection:c1|table:users`）里拆出
   * - connectionId（建表/建视图要的是它）
   * - 以及把**整条节点 id** 原样交给 dropTable / dropView / renameTable
   *   （core/api.ts 约定这些方法收 nodeId，含连接归属）。
   */
  #ddlTargetFor(ref: ObjectRef): DdlMenuTarget | null {
    const parsed = NodeId.parse(ref.id)
    if (!parsed) return null
    const { connectionId, adapterId } = parsed
    // adapterId 形如 `table:users` / `view:v` / `folder:tables` / `folder:views`。
    const folder = adapterId?.startsWith('folder:') ? adapterId.slice('folder:'.length) : null

    const refreshParent = (): void => {
      // 新建对象后刷新它的父分组；找不到父节点就退化为刷新当前节点。
      const parent = this.#findParentOf(ref)
      if (parent) void this.refreshNode(parent)
    }

    switch (ref.kind) {
      case 'table':
        return {
          rename: {
            label: '重命名表…',
            run: (api) =>
              openRenameTableDialog(api, ref.id, ref.name, () => {
                // 重命名后原节点 id（含旧表名）已失效 → 刷新父分组让新名字出现。
                refreshParent()
              })
          },
          drop: {
            label: '删除表…',
            run: (api) => {
              void (async () => {
                const ok = await dropTableWithConfirm(api, ref.id, ref.name)
                if (ok) {
                  this.#cb.onStatus(`已删除表「${ref.name}」`)
                  refreshParent()
                }
              })()
            }
          }
        }
      case 'view':
        return {
          drop: {
            label: '删除视图…',
            run: (api) => {
              void (async () => {
                const ok = await dropViewWithConfirm(api, ref.id, ref.name)
                if (ok) {
                  this.#cb.onStatus(`已删除视图「${ref.name}」`)
                  refreshParent()
                }
              })()
            }
          }
        }
      case 'folder':
        if (folder === 'tables') {
          return {
            create: {
              label: '新建表…',
              run: (api) =>
                openCreateTableDialog(api, connectionId, () => {
                  this.#cb.onStatus('已创建表')
                  // 新建后必须展开该分组并重取，否则用户看不到新表。
                  const parent = this.#findParentOf(ref)
                  if (parent) void this.refreshNode(parent)
                })
            }
          }
        }
        if (folder === 'views') {
          return {
            create: {
              label: '新建视图…',
              run: (api) =>
                openCreateViewDialog(api, connectionId, () => {
                  this.#cb.onStatus('已创建视图')
                  const parent = this.#findParentOf(ref)
                  if (parent) void this.refreshNode(parent)
                })
            }
          }
        }
        return null
      default:
        return null
    }
  }

  /** 在已加载的树里找某 ref 的父节点（按 parentId 匹配）。找不到返回 null。 */
  #findParentOf(ref: ObjectRef): NodeState | null {
    if (!ref.parentId) {
      // 顶层（连接）没有可刷新的父节点 → 退化为刷新自身。
      return this.#findNodeByKey(keyOf(ref))
    }
    return this.#findNodeByKey(ref.parentId)
  }

  #findNodeByKey(key: string): NodeState | null {
    const stack: NodeState[] = [...this.#roots]
    while (stack.length > 0) {
      const cur = stack.pop()
      if (!cur) continue
      if (keyOf(cur.ref) === key) return cur
      if (cur.children) stack.push(...cur.children)
    }
    return null
  }

  // ===========================================================================
  // 颜色 / 分组的对话框
  // ===========================================================================
  //
  // 全部用**内联样式 + CSS 变量**手写，不依赖 index.html 也不引入组件库
  // （index.html / 其它渲染模块不在本任务写入范围）。三个对话框结构都很小，
  // 为此抽一个通用 Modal 反而是过度设计。

  /**
   * 颜色选择：平铺 7 个预设色 + 清除。
   *
   * 为什么是**预设色板**而不是取色器：固定颜色的价值在于语义化
   * （红=生产 / 绿=本地），自由取色会让同一含义出现十几种红，反而失去辨识度。
   */
  #openColorPicker(node: NodeState): void {
    const connId = stripConnPrefix(node.ref.id)
    const current = getConnColor(this.#store, connId)

    const { overlay, panel } = buildOverlay(`设置颜色 · ${node.ref.name}`)
    const grid = document.createElement('div')
    grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;'

    for (const preset of PRESET_COLORS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('aria-label', preset.label)
      btn.title = preset.label
      const isCur = current === preset.id
      btn.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;' +
        `border:1px solid ${isCur ? 'var(--accent)' : 'var(--border)'};` +
        'background:var(--bg);color:var(--fg);cursor:pointer;font:inherit;font-size:12px;'
      const swatch = document.createElement('span')
      swatch.style.cssText =
        `width:12px;height:12px;border-radius:50%;background:${preset.css};flex:0 0 auto;`
      const text = document.createElement('span')
      text.textContent = preset.label
      btn.appendChild(swatch)
      btn.appendChild(text)
      btn.addEventListener('click', () => {
        overlay.remove()
        this.#applyConnColor(node, preset.id)
      })
      grid.appendChild(btn)
    }
    panel.appendChild(grid)

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;'
    const clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.textContent = '清除颜色'
    clearBtn.disabled = current === null
    clearBtn.addEventListener('click', () => {
      overlay.remove()
      this.#applyConnColor(node, null)
    })
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.textContent = '取消'
    cancelBtn.addEventListener('click', () => overlay.remove())
    actions.appendChild(clearBtn)
    actions.appendChild(cancelBtn)
    panel.appendChild(actions)
  }

  /**
   * 移动到分组。
   *
   * 提供"已有组"快捷按钮 + "新建组"输入框 + "移出分组"。
   * 注意：所有写入都只碰 localStorage，**绝不调用 updateConnection**
   * （那会断开重连，用户只是整理分组而已）。
   */
  #openMoveToGroup(node: NodeState): void {
    const existing = this.#existingGroups()
    const currentGroup = getConnGroup(this.#store, stripConnPrefix(node.ref.id))

    const { overlay, panel } = buildOverlay(`移动到分组 · ${node.ref.name}`)

    if (existing.length > 0) {
      const label = document.createElement('div')
      label.textContent = '已有分组'
      label.style.cssText = 'margin-bottom:6px;color:var(--fg-dim);font-size:12px;'
      panel.appendChild(label)
      const list = document.createElement('div')
      list.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;'
      for (const g of existing) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.textContent = g + (g === currentGroup ? '（当前）' : '')
        btn.addEventListener('click', () => {
          overlay.remove()
          this.#moveToGroup(node, g)
        })
        list.appendChild(btn)
      }
      panel.appendChild(list)
    }

    const newLabel = document.createElement('div')
    newLabel.textContent = '新建分组'
    newLabel.style.cssText = 'margin-bottom:6px;color:var(--fg-dim);font-size:12px;'
    panel.appendChild(newLabel)
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = '例如：生产 / 测试 / 本地'
    input.setAttribute('aria-label', '新分组名')
    input.style.cssText =
      'width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:5px 7px;' +
      'border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);'
    panel.appendChild(input)

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;'
    const outBtn = document.createElement('button')
    outBtn.type = 'button'
    outBtn.textContent = '移出分组（回到顶层）'
    outBtn.disabled = currentGroup === null
    outBtn.addEventListener('click', () => {
      overlay.remove()
      this.#moveToGroup(node, null)
    })
    const okBtn = document.createElement('button')
    okBtn.type = 'button'
    okBtn.textContent = '确定'
    const submit = (): void => {
      const name = input.value.trim()
      if (name === '') {
        input.focus()
        return
      }
      overlay.remove()
      this.#moveToGroup(node, name)
    }
    okBtn.addEventListener('click', submit)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit()
    })
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.textContent = '取消'
    cancelBtn.addEventListener('click', () => overlay.remove())
    actions.appendChild(outBtn)
    actions.appendChild(cancelBtn)
    actions.appendChild(okBtn)
    panel.appendChild(actions)
    input.focus()
  }

  /** 重命名分组（单输入框）。 */
  #openRenameGroup(groupName: string): void {
    const { overlay, panel } = buildOverlay(`重命名分组 · ${groupName}`)
    const input = document.createElement('input')
    input.type = 'text'
    input.value = groupName
    input.setAttribute('aria-label', '新分组名')
    input.style.cssText =
      'width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:5px 7px;' +
      'border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);'
    panel.appendChild(input)

    const hint = document.createElement('p')
    hint.setAttribute('role', 'alert')
    hint.style.cssText = 'margin:8px 0 0;color:var(--danger);font-size:12px;min-height:1.2em;'
    panel.appendChild(hint)

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:10px;'
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.textContent = '取消'
    cancelBtn.addEventListener('click', () => overlay.remove())
    const okBtn = document.createElement('button')
    okBtn.type = 'button'
    okBtn.textContent = '确定'
    const submit = (): void => {
      const next = input.value.trim()
      if (next === '' || next === groupName) {
        hint.textContent = next === '' ? '分组名不能为空。' : '与原名相同。'
        return
      }
      if (this.#renameConnGroup(groupName, next)) overlay.remove()
      else hint.textContent = `「${next}」已存在，请换一个名字。`
    }
    okBtn.addEventListener('click', submit)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit()
    })
    actions.appendChild(cancelBtn)
    actions.appendChild(okBtn)
    panel.appendChild(actions)
    input.focus()
    input.select()
  }

  /**
   * 删除分组（二次确认）。
   *
   * 文案必须说清"连接不会被删"——否则用户会怕删组把连接一起删了，
   * 或者反过来，以为安全而不知道组内连接会跑到顶层。
   */
  #openDeleteGroup(groupName: string): void {
    const members = this.#countGroupMembers(groupName)
    const message =
      `确定删除分组「${groupName}」吗？\n\n` +
      `组内 ${members} 个连接不会被删除，它们会回到顶层显示。`
    // 二次确认用原生 confirm：阻塞、不可被后续消息冲掉，适合破坏性操作。
    // eslint-disable-next-line no-alert -- 见上方注释
    if (!window.confirm(message)) return
    this.#deleteConnGroup(groupName)
  }

  /** 资源清理：移除常驻监听（菜单是临时的，关闭时自清）。 */
  dispose(): void {
    this.#closeMenu()
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer)
      this.#debounceTimer = null
    }
  }
}

function keyOf(ref: ObjectRef): string {
  return `${ref.kind}::${ref.id}`
}

/**
 * 从 `connection:c1` 取出裸连接 id（`c1`）。
 *
 * 为什么颜色/分组的 localStorage key 用**裸 id**：`connection:` 前缀是树的
 * 节点 id 编码，属于展示层；本地偏好应当与"哪条连接"绑定，而不是与
 * 某个 UI 前缀字符串绑定。这里只做确定性去前缀，**不做任何模糊匹配**。
 */
function stripConnPrefix(nodeId: string): string {
  const PREFIX = 'connection:'
  return nodeId.startsWith(PREFIX) ? nodeId.slice(PREFIX.length) : nodeId
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

function iconFor(kind: ObjectRef['kind']): string {
  switch (kind) {
    case 'connection':
      return '▣'
    case 'catalog':
      return '◫'
    case 'schema':
      return '◇'
    case 'folder':
      return '▤'
    case 'table':
      return '▦'
    case 'view':
      return '◨'
    case 'column':
      return '·'
    case 'index':
      return '#'
    case 'trigger':
      return '⚡'
    default:
      return '•'
  }
}

/** 行尾的灰色元信息，只挑最有用的两三个字段展示。 */
function metaText(ref: ObjectRef): string {
  const m = ref.meta
  if (!m) return ''
  const parts: string[] = []
  if (typeof m['type'] === 'string') parts.push(m['type'])
  if (m['primaryKey'] === true) parts.push('PK')
  if (m['nullable'] === false) parts.push('NOT NULL')
  if (typeof m['dialect'] === 'string') parts.push(m['dialect'])
  return parts.join(' · ')
}

/** 与缓存区一致的输入框内联样式（不改 style.css）。 */
function inputStyleLocal(): string {
  return (
    'font:inherit;font-size:12px;padding:4px 6px;box-sizing:border-box;' +
    'border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg)'
  )
}

/**
 * 造一个极简模态遮罩 + 面板。
 *
 * 为什么手写而不复用别处的弹窗：index.html 与其它渲染模块不在本任务写入范围，
 * 且这三个对话框都只有「若干按钮 + 一个输入框」，抽通用 Modal 组件是过度设计。
 * 内联样式 + CSS 变量即可跟随明暗主题。
 *
 * 关闭方式：Esc、点遮罩、或调用方 `overlay.remove()`。
 */
function buildOverlay(title: string): { overlay: HTMLElement; panel: HTMLElement } {
  const overlay = document.createElement('div')
  overlay.className = 'conn-organize-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', title)
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,.45);'

  const panel = document.createElement('div')
  panel.style.cssText =
    'width:420px;max-width:calc(100vw - 32px);max-height:calc(100vh - 64px);' +
    'overflow:auto;padding:14px;background:var(--bg);color:var(--fg);' +
    'border:1px solid var(--border);border-radius:8px;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:13px;'

  const head = document.createElement('h3')
  head.textContent = title
  head.style.cssText = 'margin:0 0 12px;font-size:14px;'
  panel.appendChild(head)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  const close = (): void => {
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  document.addEventListener('keydown', onKey, true)
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close()
  })
  return { overlay, panel }
}
