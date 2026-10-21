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
  onStatus(text: string): void
}

export class MetadataTree {
  readonly #viewport: HTMLElement
  readonly #spacer: HTMLElement
  readonly #rowsEl: HTMLElement
  readonly #listChildren: (nodeId: string | null) => Promise<ObjectRef[]>
  readonly #cb: TreeCallbacks

  #roots: NodeState[] = []
  #rows: Row[] = []
  #selectedKey: string | null = null
  #lastRenderKey = ''

  constructor(
    viewport: HTMLElement,
    spacer: HTMLElement,
    rowsEl: HTMLElement,
    listChildren: (nodeId: string | null) => Promise<ObjectRef[]>,
    callbacks: TreeCallbacks
  ) {
    this.#viewport = viewport
    this.#spacer = spacer
    this.#rowsEl = rowsEl
    this.#listChildren = listChildren
    this.#cb = callbacks

    // 滚动只做「重算切片 + 重绘可见行」，不重建整棵树。
    this.#viewport.addEventListener('scroll', () => this.#scheduleRender(), { passive: true })
    // 窗口尺寸变化时可视行数变了，必须重算。
    globalThis.addEventListener('resize', () => this.#scheduleRender())
    this.#viewport.addEventListener('keydown', (e) => this.#onKeyDown(e))
  }

  /** 重新加载根层（连接列表）。 */
  async loadRoots(): Promise<void> {
    this.#cb.onStatus('正在加载连接…')
    try {
      const refs = await this.#listChildren(null)
      this.#roots = refs.map((ref) => this.#makeNode(ref, 0))
      this.#rebuildRows()
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
    this.#rows = rows
    this.#lastRenderKey = ''
    this.#scheduleRender()
  }

  #scheduleRender(): void {
    // 用 microtask 合并同一帧内的多次触发（滚动会连续发事件）。
    queueMicrotask(() => this.render())
  }

  /** 只渲染可视区。这是整个文件的核心。 */
  render(): void {
    const total = this.#rows.length
    // 撑高元素决定滚动条能滚多远，必须等于完整高度。
    this.#spacer.style.height = `${total * ROW_HEIGHT}px`

    const viewportH = this.#viewport.clientHeight || 0
    const scrollTop = this.#viewport.scrollTop
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
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
}

function keyOf(ref: ObjectRef): string {
  return `${ref.kind}::${ref.id}`
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
