/**
 * 结果集网格：虚拟滚动 + 分页取数。
 *
 * ===== 这个文件存在的理由（剖析报告「陷阱 5」的正面实现） =====
 *
 * DBeaver 在单进程内直接持有 `ResultSet`，百万行不成问题——数据本来就在
 * 同一个进程的内存里，网格滚到哪 `seek` 到哪即可。
 *
 * Electron 里不行：数据库在驱动宿主进程、主进程居中转发、渲染进程只负责画。
 * 一次性把 100 万行经 IPC 搬过来会序列化爆内存、且渲染进程其实用不到 99%。
 *
 * 所以本网格的取数模型是：
 *   - **页缓存**：只缓存用户看过的页，页大小 100 行
 *   - **按需拉取**：可视区需要哪页才拉哪页，拉不到的格子显示骨架
 *   - **去重**：同一页正在飞的时候不重复发请求
 *   - **耗尽标记**：`hasMore === false` 之后不再请求
 *
 * ===== 与 LightGrid 的关系 =====
 *
 * 它也是虚拟滚动（`LightGrid.java#L2202` 的 `onPaint` 只迭代 `visibleRows`），
 * 但它是**自绘 Canvas**——因为 SWT 的 Table 给不了多级列头/固定列。
 * Web 端 DOM 虚拟滚动是成熟方案，且自带无障碍与文本选择，
 * 所以这里只借它的**思想**（O(可视) 而不是 O(总行数)），不用它的**手段**。
 */

import type { DbStudioApi } from '../core/api'
import type { ObjectRef, TableDescription } from '../core/model'
import type { CellValue, QueryResult, ResultColumn, ResultRow, RowUpdate } from '../core/resultset'

/** 行高必须与 CSS `.grid-row { height }` 一致。 */
const ROW_HEIGHT = 24
/** 列宽固定值。列太宽会导致横向滚动条过早出现，26 字符大约够看类型与短值。 */
const COL_WIDTH = 160
/** 行号列宽。 */
const ROWNUM_WIDTH = 64
/** 每页行数。与主进程侧默认 limit 无关，是网格自己的取数粒度。 */
const PAGE_SIZE = 100
/** 可视区上下多渲染几行，滚动时不露白。 */
const OVERSCAN = 8

interface PageState {
  rows: ResultRow[]
  /** 该页是否已确认不存在更多数据（用于避免请求越界页）。 */
  exhausted: boolean
}

export interface GridCallbacks {
  onStatus(text: string, isError?: boolean): void
}

/** 网格当前的数据来源，决定「能否编辑」。 */
type Source =
  | { kind: 'table'; ref: ObjectRef; desc: TableDescription }
  | { kind: 'sql'; sql: string }

export class ResultGrid {
  readonly #root: HTMLElement
  readonly #cb: GridCallbacks
  #api: DbStudioApi | null = null

  // 当前查询会话
  #cursorId: string | null = null
  #columns: ResultColumn[] = []
  #source: Source | null = null
  /** 已知的总行数下限。因为不查 COUNT，只知道自己见过的行——见下方说明。 */
  #knownRows = 0
  #exhausted = false

  readonly #pages = new Map<number, PageState>()
  /** 在途请求去重：同一页只发一次。 */
  readonly #inflight = new Map<number, Promise<void>>()

  #selectedRow = -1
  #selectedCol = -1

  // ---- 编辑状态 ----
  //
  // 脏数据按「结果集行下标」分组，但**提交时用的是主键值**（见 core/resultset.ts 的
  // RowUpdate 说明：下标会漂移，不能拿去拼 WHERE）。这里存下标只是为了让 UI
  // 能把未提交的改动画回对应那行。
  readonly #dirty = new Map<number, Map<string, CellValue>>()
  /** 最近一次事务状态，用于按钮可用性与「有未提交改动」提示。 */
  #txActive = false
  #pendingAffected = 0
  /** 表结构（含主键列名），编辑时要用它把行还原成 keyValues。 */
  #desc: TableDescription | null = null
  /** 正在编辑的单元格位置；null 表示没有输入框打开。 */
  #editing: { row: number; col: number } | null = null

  // DOM
  readonly #headerEl: HTMLElement
  readonly #viewportEl: HTMLElement
  readonly #spacerEl: HTMLElement
  readonly #rowsEl: HTMLElement
  readonly #bannerEl: HTMLElement
  readonly #toolbarEl: HTMLElement

  constructor(root: HTMLElement, cb: GridCallbacks) {
    this.#root = root
    this.#cb = cb

    // 结构：toolbar / banner / header（sticky） / viewport
    this.#toolbarEl = document.createElement('div')
    this.#toolbarEl.className = 'grid-toolbar'

    this.#bannerEl = document.createElement('div')
    this.#bannerEl.className = 'grid-banner'
    this.#bannerEl.hidden = true

    this.#headerEl = document.createElement('div')
    this.#headerEl.className = 'grid-header'
    this.#headerEl.setAttribute('role', 'row')

    this.#viewportEl = document.createElement('div')
    this.#viewportEl.className = 'grid-viewport'
    this.#viewportEl.tabIndex = 0

    this.#spacerEl = document.createElement('div')
    this.#spacerEl.className = 'grid-spacer'

    this.#rowsEl = document.createElement('div')
    this.#rowsEl.className = 'grid-rows'
    this.#rowsEl.setAttribute('role', 'rowgroup')

    this.#viewportEl.appendChild(this.#spacerEl)
    this.#viewportEl.appendChild(this.#rowsEl)

    this.#root.replaceChildren(
      this.#toolbarEl,
      this.#bannerEl,
      this.#headerEl,
      this.#viewportEl
    )

    this.#viewportEl.addEventListener('scroll', () => this.#render(), { passive: true })
    globalThis.addEventListener('resize', () => this.#render())
    this.#viewportEl.addEventListener('keydown', (e) => this.#onKeyDown(e))
  }

  attachApi(api: DbStudioApi): void {
    this.#api = api
  }

  /** 网格顶部工具条（执行 SQL 用）。由外部构造好塞进来，避免这里耦合 UI 细节。 */
  setToolbar(node: HTMLElement): void {
    this.#toolbarEl.replaceChildren(node)
  }

  /**
   * 打开一张表。
   *
   * 需要 `hasUniqueKey` 来决定可编辑性——这条规则来自 DBeaver
   * 「缺唯一键则抛 No unique key defined」（剖析报告 04 问题 5）。
   * 我们把它提前到打开时判定，而不是等用户改完再报错。
   */
  async openTable(ref: ObjectRef, desc: TableDescription): Promise<void> {
    const api = this.#requireApi()
    this.#source = { kind: 'table', ref, desc }
    this.#desc = desc
    await this.#openCursor(() => api.previewTable(ref.id))
    this.#applyEditability()
    await this.#refreshTransactionState()
  }

  /** 执行自由 SQL（只读）。 */
  async runSql(nodeId: string, sql: string): Promise<void> {
    const api = this.#requireApi()
    this.#source = { kind: 'sql', sql }
    this.#desc = null
    await this.#openCursor(() => api.runQuery(nodeId, sql, { limit: PAGE_SIZE }))
    this.#applyEditability()
    await this.#refreshTransactionState()
  }

  #requireApi(): DbStudioApi {
    if (!this.#api) throw new Error('网格尚未绑定 API')
    return this.#api
  }

  /** 重置所有会话状态。切换查询时必须调用，否则旧游标会泄漏。 */
  async #reset(): Promise<void> {
    const api = this.#api
    const old = this.#cursorId

    // 切换查询前若有未提交改动，必须回滚——否则那些改动会挂在一个
    // 用户已经离开的事务里，后续操作看到的是"幽灵状态"。
    if (this.#dirty.size > 0 && this.#source) {
      await this.#rollbackQuietly()
    }

    this.#cursorId = null
    this.#pages.clear()
    this.#inflight.clear()
    this.#knownRows = 0
    this.#exhausted = false
    this.#columns = []
    this.#selectedRow = -1
    this.#selectedCol = -1
    this.#dirty.clear()
    this.#editing = null
    this.#txActive = false
    this.#pendingAffected = 0
    this.#headerEl.replaceChildren()
    this.#rowsEl.replaceChildren()
    this.#spacerEl.style.height = '0px'
    this.#bannerEl.hidden = true
    if (api && old) {
      // 释放游标。失败不影响新查询，但不能吞掉——记一条状态即可。
      try {
        await api.closeCursor(old)
      } catch {
        /* 游标可能已随连接关闭被释放 */
      }
    }
  }

  async #openCursor(exec: () => Promise<QueryResult>): Promise<void> {
    await this.#reset()
    this.#cb.onStatus('正在执行查询…')
    let result: QueryResult
    try {
      result = await exec()
    } catch (e) {
      this.#cb.onStatus(`查询失败：${errText(e)}`, true)
      this.#showError(errText(e))
      return
    }

    this.#cursorId = result.cursorId
    this.#columns = [...result.columns]

    // 第一页直接作为 page 0 塞进缓存，省一次往返。
    if (result.rows.length > 0) {
      this.#pages.set(0, { rows: [...result.rows], exhausted: !result.hasMore })
      this.#knownRows = result.returned
    }
    this.#exhausted = !result.hasMore

    this.#renderHeader()
    this.#render()
    this.#cb.onStatus(
      `已返回 ${result.returned} 行 · ${result.elapsedMs}ms` +
        (result.hasMore ? ' · 可继续滚动加载' : ' · 已全部返回')
    )
    if (result.rows.length === 0) this.#showEmpty()
  }

  /** 可编辑性：只有「表 + 有唯一键」才可编辑。 */
  #applyEditability(): void {
    const src = this.#source
    if (!src) return
    if (src.kind === 'table' && src.desc.hasUniqueKey) {
      this.#bannerEl.hidden = true
      this.#root.dataset['editable'] = 'true'
    } else {
      this.#root.dataset['editable'] = 'false'
      this.#bannerEl.hidden = false
      this.#bannerEl.textContent =
        src.kind === 'table'
          ? '⚠ 该表没有唯一键，不可在线编辑（Update/Delete 需要能唯一定位一行）'
          : '⚠ 自由 SQL 结果无法确定唯一键，只读'
    }
    this.#renderEditToolbar()
  }

  // -------------------------------------------------------------------------
  // 编辑工具条：应用 / 提交 / 撤销
  // -------------------------------------------------------------------------

  #renderEditToolbar(): void {
    this.#toolbarEl.replaceChildren()

    const info = document.createElement('span')
    info.className = 'grid-tx-info'
    const dirtyCells = [...this.#dirty.values()].reduce((n, m) => n + m.size, 0)
    if (this.#txActive) {
      info.textContent = `未提交：${this.#dirty.size} 行 / ${dirtyCells} 处改动`
      info.classList.add('is-pending')
    } else {
      info.textContent = this.#root.dataset['editable'] === 'true' ? '双击单元格可编辑' : '只读'
    }
    this.#toolbarEl.appendChild(info)

    if (this.#root.dataset['editable'] !== 'true') return

    const spacer = document.createElement('span')
    spacer.className = 'spacer'
    this.#toolbarEl.appendChild(spacer)

    // 「应用」把脏数据写进事务（但不提交）；「提交」才真正落库。
    // 这个两段式正是 DBeaver 的语义：Persister 构造即 autocommit=false。
    const applyBtn = document.createElement('button')
    applyBtn.type = 'button'
    applyBtn.textContent = '应用修改'
    applyBtn.disabled = this.#dirty.size === 0
    applyBtn.addEventListener('click', () => void this.applyEdits())
    this.#toolbarEl.appendChild(applyBtn)

    const commitBtn = document.createElement('button')
    commitBtn.type = 'button'
    commitBtn.textContent = '提交'
    commitBtn.disabled = !this.#txActive
    commitBtn.addEventListener('click', () => void this.commit())
    this.#toolbarEl.appendChild(commitBtn)

    const rollbackBtn = document.createElement('button')
    rollbackBtn.type = 'button'
    rollbackBtn.textContent = '回滚'
    rollbackBtn.disabled = !this.#txActive
    rollbackBtn.addEventListener('click', () => void this.rollback())
    this.#toolbarEl.appendChild(rollbackBtn)

    const reloadBtn = document.createElement('button')
    reloadBtn.type = 'button'
    reloadBtn.textContent = '重新加载'
    reloadBtn.addEventListener('click', () => void this.reload())
    this.#toolbarEl.appendChild(reloadBtn)
  }

  /** 把脏数据提交到事务（不 commit）。 */
  async applyEdits(): Promise<void> {
    const api = this.#requireApi()
    const src = this.#source
    const desc = this.#desc
    if (!src || src.kind !== 'table' || !desc) {
      this.#cb.onStatus('当前结果集不可编辑', true)
      return
    }
    if (this.#dirty.size === 0) return

    const keyCols = desc.columns
      .filter((c) => c.primaryKeyOrdinal !== null)
      .sort((a, b) => (a.primaryKeyOrdinal ?? 0) - (b.primaryKeyOrdinal ?? 0))
    if (keyCols.length === 0) {
      this.#cb.onStatus('该表没有主键，无法定位行', true)
      return
    }

    const updates: RowUpdate[] = []
    for (const [rowIndex, changes] of this.#dirty) {
      const row = this.#rowAt(rowIndex)
      if (!row) {
        this.#cb.onStatus(`第 ${rowIndex + 1} 行已不在缓存中，请重新加载后再改`, true)
        return
      }
      // 用**主键值**定位行，而不是下标——下标会漂移，改错行且无声。
      const keyValues: Record<string, CellValue> = {}
      for (const kc of keyCols) {
        const ci = this.#columns.findIndex((c) => c.name === kc.name)
        if (ci < 0) {
          this.#cb.onStatus(`主键列「${kc.name}」不在结果集中，无法定位行`, true)
          return
        }
        const cell = row.cells[ci]
        if (!cell || cell.kind === 'null') {
          this.#cb.onStatus(`主键列「${kc.name}」值为 NULL，无法定位行`, true)
          return
        }
        keyValues[kc.name] = cell
      }
      updates.push({ keyValues, changes: Object.fromEntries(changes) })
    }

    this.#cb.onStatus(`正在应用 ${updates.length} 行改动…`)
    try {
      const res = await api.applyEdits(src.ref.id, updates)
      if (!res.ok) {
        const failed = res.outcomes.filter((o) => o.error !== null)
        this.#cb.onStatus(
          `部分行失败（共 ${failed.length} 行），已保留在事务中，可回滚：${failed[0]?.error ?? ''}`,
          true
        )
      } else {
        this.#cb.onStatus(`已应用 ${res.affected} 行到事务，尚未提交`)
        // 应用成功的改动从脏池清掉；视觉上改由「事务未提交」提示承载。
        this.#dirty.clear()
      }
      this.#txActive = res.inTransaction
      this.#pendingAffected += res.affected
      await this.#refreshTransactionState()
      this.#render()
    } catch (e) {
      this.#cb.onStatus(`应用失败：${errText(e)}`, true)
    }
  }

  /** 提交事务。 */
  async commit(): Promise<void> {
    const api = this.#requireApi()
    const src = this.#source
    // 事务只对有连接的会话有意义：自由 SQL 结果没有表节点，也就没有事务上下文。
    if (!src || src.kind !== 'table') {
      this.#cb.onStatus('自由 SQL 无事务上下文，无法提交', true)
      return
    }
    const nodeId = src.ref.id
    try {
      const st = await api.commitTransaction(nodeId)
      this.#txActive = st.active
      this.#pendingAffected = st.pendingAffected
      this.#cb.onStatus('已提交')
      await this.#refreshTransactionState()
      await this.reload()
    } catch (e) {
      this.#cb.onStatus(`提交失败：${errText(e)}`, true)
    }
  }

  /** 回滚事务。 */
  async rollback(): Promise<void> {
    const api = this.#requireApi()
    const src = this.#source
    if (!src || src.kind !== 'table') return
    try {
      const st = await api.rollbackTransaction(src.ref.id)
      this.#txActive = st.active
      this.#pendingAffected = st.pendingAffected
      this.#dirty.clear()
      this.#cb.onStatus('已回滚')
      await this.#refreshTransactionState()
      await this.reload()
    } catch (e) {
      this.#cb.onStatus(`回滚失败：${errText(e)}`, true)
    }
  }

  /** 静默回滚（切换查询时用，不打扰用户）。 */
  async #rollbackQuietly(): Promise<void> {
    const api = this.#api
    const src = this.#source
    if (!api || !src || src.kind !== 'table') return
    try {
      await api.rollbackTransaction(src.ref.id)
    } catch {
      /* 连接可能已断开，忽略 */
    }
  }

  /** 重新执行当前查询（提交/回滚后刷新数据用）。 */
  async reload(): Promise<void> {
    const src = this.#source
    if (!src) return
    if (src.kind === 'table') {
      await this.openTable(src.ref, src.desc)
    } else {
      const api = this.#requireApi()
      void api
      // 自由 SQL 的 nodeId 没存，这里退化为提示用户重执行。
      this.#cb.onStatus('请重新执行 SQL 以刷新结果')
    }
  }

  async #refreshTransactionState(): Promise<void> {
    const api = this.#api
    const src = this.#source
    if (!api || !src || src.kind !== 'table') {
      this.#renderEditToolbar()
      return
    }
    try {
      const st = await api.transactionState(src.ref.id)
      this.#txActive = st.active
      this.#pendingAffected = st.pendingAffected
    } catch {
      // 拿不到状态时不要谎报；保持上一次已知状态。
    }
    this.#renderEditToolbar()
  }

  #showError(message: string): void {
    this.#rowsEl.replaceChildren()
    const box = document.createElement('div')
    box.className = 'grid-empty is-error'
    box.textContent = `查询失败：${message}`
    this.#rowsEl.appendChild(box)
  }

  #showEmpty(): void {
    const box = document.createElement('div')
    box.className = 'grid-empty'
    box.textContent = '查询返回 0 行'
    this.#rowsEl.appendChild(box)
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  #renderHeader(): void {
    this.#headerEl.replaceChildren()

    const corner = document.createElement('div')
    corner.className = 'grid-cell grid-rownum'
    corner.setAttribute('role', 'columnheader')
    corner.textContent = '#'
    this.#headerEl.appendChild(corner)

    for (const col of this.#columns) {
      const cell = document.createElement('div')
      cell.className = 'grid-cell grid-col-header'
      cell.setAttribute('role', 'columnheader')
      cell.style.width = `${COL_WIDTH}px`
      cell.textContent = col.name
      cell.title = `${col.name} · ${col.type}`
      this.#headerEl.appendChild(cell)
    }
  }

  /**
   * 重绘可视区。
   *
   * 「总行数」的处理是个关键取舍：我们不查 COUNT（大表上是全表扫描），
   * 所以不知道确切的 N。这里用 `#knownRows` 作为**已知下限**，
   * 并在未耗尽时多留一页高度，让用户能继续往下滚触发加载。
   *
   * 这正是 DBeaver 的做法——`getItemCount()` 返回的是「已加载行数」，
   * 滚动条上限是 `已加载数 + 1`（`LightGrid.java#L1057` / `#L2581-L2589`）。
   * 区别是那边数据已全在内存、滚动到底只是换下标；这边到边界会真的去拉下一页。
   */
  #render(): void {
    const viewportH = this.#viewportEl.clientHeight || 0
    const scrollTop = this.#viewportEl.scrollTop

    const totalForScroll = this.#exhausted ? this.#knownRows : this.#knownRows + PAGE_SIZE
    this.#spacerEl.style.height = `${Math.max(totalForScroll, 1) * ROW_HEIGHT}px`

    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    const end = Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN

    // 先确保可视区所需的页都已在途/已缓存。
    this.#ensurePagesFor(start, end)

    const frag = document.createDocumentFragment()
    for (let rowIndex = start; rowIndex < end; rowIndex++) {
      if (rowIndex >= totalForScroll) break
      frag.appendChild(this.#renderRow(rowIndex))
    }
    this.#rowsEl.style.transform = `translateY(${start * ROW_HEIGHT}px)`
    this.#rowsEl.replaceChildren(frag)
  }

  /** 计算需要哪些页，缺的就拉。这是「按需取数」的核心。 */
  #ensurePagesFor(start: number, end: number): void {
    if (this.#exhausted) return
    const firstPage = Math.floor(start / PAGE_SIZE)
    const lastPage = Math.floor((end - 1) / PAGE_SIZE)
    for (let p = firstPage; p <= lastPage; p++) {
      if (this.#pages.has(p) || this.#inflight.has(p)) continue
      void this.#loadPage(p)
    }
  }

  #loadPage(pageIndex: number): Promise<void> {
    const api = this.#requireApi()
    const cursorId = this.#cursorId
    if (!cursorId || this.#exhausted) return Promise.resolve()

    const offset = pageIndex * PAGE_SIZE
    // 去重：同一页飞行中不重复发。
    const existing = this.#inflight.get(pageIndex)
    if (existing) return existing

    const task = (async () => {
      try {
        const page = await api.fetchResultPage(cursorId, offset, PAGE_SIZE)
        this.#pages.set(pageIndex, { rows: [...page.rows], exhausted: !page.hasMore })
        this.#knownRows = Math.max(this.#knownRows, offset + page.returned)
        if (!page.hasMore) {
          this.#exhausted = true
          this.#cb.onStatus(`已加载全部 ${this.#knownRows} 行`)
        }
      } catch (e) {
        // 单页失败不能让整个网格崩掉：记状态，格子保持骨架。
        this.#cb.onStatus(`加载第 ${pageIndex + 1} 页失败：${errText(e)}`, true)
      } finally {
        this.#inflight.delete(pageIndex)
        this.#render()
      }
    })()
    this.#inflight.set(pageIndex, task)
    return task
  }

  #rowAt(index: number): ResultRow | undefined {
    const page = this.#pages.get(Math.floor(index / PAGE_SIZE))
    if (!page) return undefined
    return page.rows[index % PAGE_SIZE]
  }

  #renderRow(rowIndex: number): HTMLElement {
    const rowEl = document.createElement('div')
    rowEl.className = 'grid-row'
    rowEl.setAttribute('role', 'row')
    rowEl.setAttribute('aria-rowindex', String(rowIndex + 1))
    if (rowIndex === this.#selectedRow) rowEl.classList.add('is-selected')

    const numEl = document.createElement('div')
    numEl.className = 'grid-cell grid-rownum'
    numEl.textContent = String(rowIndex + 1)
    rowEl.appendChild(numEl)

    const row = this.#rowAt(rowIndex)
    if (!row) {
      // 骨架行：该页还没到。用空白格子占位，保持列宽稳定。
      for (let c = 0; c < this.#columns.length; c++) {
        const cell = document.createElement('div')
        cell.className = 'grid-cell is-skeleton'
        cell.style.width = `${COL_WIDTH}px`
        cell.setAttribute('role', 'gridcell')
        rowEl.appendChild(cell)
      }
      return rowEl
    }

    for (let c = 0; c < this.#columns.length; c++) {
      const cell = document.createElement('div')
      cell.className = 'grid-cell'
      cell.style.width = `${COL_WIDTH}px`
      cell.setAttribute('role', 'gridcell')
      if (rowIndex === this.#selectedRow && c === this.#selectedCol) {
        cell.classList.add('is-focused')
      }
      // 脏标记：这一格有未提交的改动。视觉必须明显，否则用户会忘了改过什么。
      const dirtyRow = this.#dirty.get(rowIndex)
      const colName = this.#columns[c]?.name ?? ''
      const dirtyValue = dirtyRow?.get(colName)
      const value = dirtyValue ?? row.cells[c] ?? { kind: 'null' as const }
      this.#paintCell(cell, value)
      if (dirtyValue !== undefined) cell.classList.add('is-dirty')

      cell.addEventListener('click', () => {
        this.#selectedRow = rowIndex
        this.#selectedCol = c
        this.#render()
        this.#viewportEl.focus()
      })
      cell.addEventListener('dblclick', () => {
        if (this.#root.dataset['editable'] !== 'true') return
        this.#beginCellEdit(cell, rowIndex, c, value)
      })
      rowEl.appendChild(cell)
    }
    return rowEl
  }

  /**
   * 进入单元格编辑态。
   *
   * 用一个覆盖在格子上的 `<input>`，回车/失焦确认，Esc 取消。
   * 确认后只写进 `#dirty`（内存），**不碰数据库**——
   * 真正落库要等用户点「应用修改」，那时才进事务。
   *
   * 这个两段式是刻意的：如果每敲一次回车就写库，用户改 5 个格子就是 5 次网络往返，
   * 而且中途放弃会留下一半改动。DBeaver 同样是攒批 + `autocommit=false`。
   */
  #beginCellEdit(cell: HTMLElement, rowIndex: number, col: number, current: CellValue): void {
    if (this.#editing) return // 已有输入框，先让上一个处理完
    this.#editing = { row: rowIndex, col }

    // 被截断的值不能直接编辑——回写会破坏原值（cellValueToSqlParam 也会拒）。
    if (current.kind === 'text' && current.truncated) {
      this.#cb.onStatus(
        `该值有 ${current.fullLength ?? '未知'} 字符，只加载了前 ${current.text.length} 个，` +
          '为避免写坏数据，暂不支持编辑被截断的值',
        true
      )
      this.#editing = null
      return
    }
    if (current.kind === 'blob') {
      this.#cb.onStatus('二进制字段暂不支持在线编辑', true)
      this.#editing = null
      return
    }

    cell.classList.add('is-editing')
    cell.style.position = 'relative'

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'grid-cell-editor'
    input.value =
      current.kind === 'null'
        ? ''
        : current.kind === 'text'
          ? current.text
          : String(current.kind === 'number' ? current.value : current.value)
    input.placeholder = current.kind === 'null' ? 'NULL（留空保持不变）' : ''
    cell.replaceChildren(input)
    input.focus()
    input.select()

    let settled = false
    const finish = (commit: boolean): void => {
      if (settled) return
      settled = true
      this.#editing = null
      const raw = input.value
      if (commit) {
        this.#applyCellChange(rowIndex, col, current, raw)
      }
      this.#render()
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
      // 方向键留给输入框自己，不要让网格的键盘导航抢走
      e.stopPropagation()
    })
    input.addEventListener('blur', () => finish(true))
  }

  /** 把输入框内容转换成一个 `CellValue` 并记入脏池。 */
  #applyCellChange(
    rowIndex: number,
    col: number,
    original: CellValue,
    raw: string
  ): void {
    const colName = this.#columns[col]?.name
    if (!colName) return

    // 空输入：对原本是 NULL 的列视为不改；对原本有值的列视为「设为 NULL」。
    let next: CellValue
    if (raw === '') {
      if (original.kind === 'null') return
      next = { kind: 'null' }
    } else if (original.kind === 'number') {
      const n = Number(raw)
      if (Number.isNaN(n)) {
        this.#cb.onStatus(`「${colName}」需要数字，输入 "${raw}" 不是有效数字`, true)
        return
      }
      next = { kind: 'number', value: n }
    } else if (original.kind === 'boolean') {
      if (raw !== 'true' && raw !== 'false') {
        this.#cb.onStatus(`「${colName}」需要 true/false`, true)
        return
      }
      next = { kind: 'boolean', value: raw === 'true' }
    } else {
      next = { kind: 'text', text: raw }
    }

    let row = this.#dirty.get(rowIndex)
    if (!row) {
      row = new Map<string, CellValue>()
      this.#dirty.set(rowIndex, row)
    }
    // 改回原值时把脏标记去掉，避免用户来回改后还显示"有改动"
    if (isSameValue(next, original)) {
      row.delete(colName)
      if (row.size === 0) this.#dirty.delete(rowIndex)
    } else {
      row.set(colName, next)
    }
    this.#renderEditToolbar()
    this.#cb.onStatus(
      this.#dirty.size > 0 ? `已暂存 ${this.#dirty.size} 行改动，点「应用修改」写入事务` : '没有未提交的改动'
    )
  }

  /** 渲染单元格值。NULL / BLOB / 截断文本都要有明确视觉区分。 */
  #paintCell(el: HTMLElement, value: CellValue): void {
    switch (value.kind) {
      case 'null':
        el.classList.add('is-null')
        el.textContent = 'NULL'
        el.title = 'NULL'
        break
      case 'number':
        el.classList.add('is-number')
        el.textContent = String(value.value)
        break
      case 'boolean':
        el.textContent = value.value ? 'true' : 'false'
        break
      case 'text':
        el.textContent = value.text
        if (value.truncated) {
          el.classList.add('is-truncated')
          el.title = `完整长度 ${value.fullLength ?? '未知'} 字符，已截断显示`
        }
        break
      case 'blob':
        el.classList.add('is-blob')
        el.textContent = `<BLOB ${value.length} bytes${value.truncated ? '，已截断' : ''}>`
        el.title = `二进制数据，${value.length} 字节`
        break
      default:
        el.textContent = String(value)
    }
  }

  #onKeyDown(e: KeyboardEvent): void {
    if (this.#knownRows === 0) return
    let nextRow = this.#selectedRow
    let nextCol = this.#selectedCol

    switch (e.key) {
      case 'ArrowDown':
        nextRow = Math.min(this.#knownRows - 1, this.#selectedRow + 1)
        break
      case 'ArrowUp':
        nextRow = Math.max(0, this.#selectedRow - 1)
        break
      case 'ArrowRight':
        nextCol = Math.min(this.#columns.length - 1, this.#selectedCol + 1)
        break
      case 'ArrowLeft':
        nextCol = Math.max(0, this.#selectedCol - 1)
        break
      default:
        return
    }
    e.preventDefault()
    this.#selectedRow = nextRow
    this.#selectedCol = Math.max(0, nextCol)
    this.#ensureRowVisible(nextRow)
    this.#render()
  }

  /** 键盘移动时把目标行滚进可视区，否则焦点会「走出屏幕」。 */
  #ensureRowVisible(rowIndex: number): void {
    const top = rowIndex * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    const viewTop = this.#viewportEl.scrollTop
    const viewBottom = viewTop + this.#viewportEl.clientHeight
    if (top < viewTop) this.#viewportEl.scrollTop = top
    else if (bottom > viewBottom) this.#viewportEl.scrollTop = bottom - this.#viewportEl.clientHeight
  }

  /** 页面卸载/切换时释放游标。 */
  async dispose(): Promise<void> {
    await this.#reset()
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * 判断两个单元格值是否等价。
 *
 * 用途：用户把值改了一圈又改回原值时，要能识别出来并**清掉脏标记**——
 * 否则「有未提交改动」的提示会一直挂着，用户点提交却发现什么都没变。
 */
function isSameValue(a: CellValue, b: CellValue): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'null':
      return true
    case 'text':
      return b.kind === 'text' && a.text === b.text
    case 'number':
      return b.kind === 'number' && a.value === b.value
    case 'boolean':
      return b.kind === 'boolean' && a.value === b.value
    case 'blob':
      return b.kind === 'blob' && a.previewBase64 === b.previewBase64 && a.length === b.length
    default:
      return false
  }
}
