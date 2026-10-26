/**
 * 多结果标签页 + 导出全部行。
 *
 * ===== 这个文件为什么存在 =====
 *
 * 阶段一/二的结果区只能同时看一个结果集：每查一次就把上一个替换掉，想对比
 * 两张表得反复切。这里把「一个结果集」升格为「一组可并存的标签」。
 *
 * ===== 关键设计：每个标签 = 一个独立的 ResultGrid 实例 =====
 *
 * `grid.ts` 已经是完整组件（自己的 cursor / 排序状态 / 列宽 / 脏数据全在实例里，
 * 见 grid.ts 的 #cursorId、#sort、#colWidths、#dirty）。所以多标签**不需要**
 * 改 grid，也不需要复制它的代码——每个标签 new 一个 `ResultGrid`，天然互不干扰。
 *
 * 随之而来的硬约束：**关闭标签必须 `dispose()` 它**。`ResultGrid.dispose()`
 * 会 `#reset()`→`closeCursor(old)` 释放主进程/驱动宿主侧的游标句柄。
 * 只把 DOM 从页面上摘掉而不 dispose，游标会永远挂着——这是内存与句柄泄漏，
 * 不会立刻报错，但长时间用会越积越多（DBeaver 里同样存在「游标必须 close」的
 * 约束，对应剖析报告 04 问题 4 的 result set 关闭时机）。
 *
 * ===== 导出全部：跨进程的「陷阱 5」在这里又一次抬头 =====
 *
 * grid 自带的 CSV 只导页缓存里的行（已加载的部分）。「导出全部」要把整个
 * 结果集读进**渲染进程内存**，这正是剖析报告「陷阱 5」要避免的跨进程全量搬运。
 * DBeaver 单进程能这么干，Electron 不能。所以这里设了行数上限（默认 5 万），
 * 超过即中止并提示改用 SQL 导出——**明确告知限制，而不是让用户以为能导 100 万行**。
 */

import { NodeId, type DbStudioApi } from '../core/api'
import type { ObjectRef, TableDescription } from '../core/model'
import type { QueryOptions, QueryResult, ResultColumn, ResultPage, StatementResult } from '../core/resultset'
import type { CellValue } from '../core/resultset'
import { ResultGrid, type SqlExecutionOutcome } from './grid'
import { csvEscape, buildCsvFileName } from './grid'
import { assertCompleteCell, assertCompleteRows } from './export-formats'
import type { FilterCondition } from './filter-sql'

/**
 * 「导出全部」的硬上限。
 *
 * 为什么是 5 万：每行几十列、每格可能几百字符，5 万行已是渲染进程内存的舒适
 * 上限；再大就有把进程撑爆的风险，且 IPC 往返时间也会变得不可接受。
 * 超过这个数就中止并引导用户走数据库侧导出（见下面 #exportAll 的中止分支）。
 */
export const MAX_EXPORT_ALL_ROWS = 50_000

/** 单次 fetchResultPage 的页大小。导出时循环拉页，这个值决定往返次数。 */
const EXPORT_PAGE_SIZE = 1_000

/**
 * 标签的「来源」：导出全部要重新执行查询，必须知道当初查的是什么。
 *
 * 为什么在 main/tabs 侧自己维护、而不向 grid 要：`grid.ts` 不是本文件的文件，
 * 且它内部把 source 存成私有的 `#source`（对外没有 getter）。与其为了一处需求
 * 去改别人的文件、加一个只为导出的 getter，不如在创建标签的**调用点**顺手记下
 * 来源——这里的调用点就是 main.ts 的 openTable / runSql。
 */
export type TabSource =
  | { kind: 'table'; ref: ObjectRef; desc: TableDescription }
  | { kind: 'sql'; nodeId: string; sql: string; options?: QueryOptions }

/** Snapshot for toolbar/connection-level controllers. Source is the executed query. */
export interface ActiveTabContext {
  readonly id: number
  readonly connectionId: string
  readonly connectionNodeId: string
  readonly grid: ResultGrid
  readonly source: TabSource
  readonly baseSource: TabSource
  readonly originalSql: string | null
  readonly filterText: string
  readonly filterConditions: readonly FilterCondition[]
  readonly filterDraft: string
  readonly filterVisible: boolean
  readonly closing: boolean
}

/** 一个标签的完整状态。grid 实例与来源一起存，保证二者不脱节。 */
interface Tab {
  id: number
  /** 显示在标签栏上的名字。 */
  title: string
  kind: 'grid' | 'command-summary'
  /** 该标签独占的网格实例（仅在 kind === 'grid' 时存在）。 */
  grid: ResultGrid | null
  /** 承载该网格的容器（显示/隐藏靠它，不重建网格）。 */
  pane: HTMLElement
  /** 导出全部时重新执行查询所需的信息。 */
  source: TabSource
  baseSource: TabSource
  filterText: string
  filterConditions: readonly FilterCondition[]
  filterDraft: string
  filterVisible: boolean
  closing: boolean
  status: { text: string; isError: boolean } | null
  /** 是否正在导出（防止重复点）。 */
  exporting: boolean
  exportProgress: string | null
}

export interface ResultTabsCallbacks {
  /** 状态栏输出。 */
  onStatus(text: string, isError?: boolean): void
  /** Fires on activation, active close/fallback, and context changes; null means no tabs. */
  onActiveChange?(context: ActiveTabContext | null): void
}

/**
 * 结果区多标签管理。
 *
 * 它接管 `#result-area` 里的三块 DOM：标签栏、标签内容区、以及「导出全部」按钮
 * （导出全部按钮是「当前标签」维度的操作，所以放在标签栏右侧而不是每个网格
 * 的内部工具条里——网格内部工具条归 grid.ts 管，我们不动它）。
 */
export class ResultTabs {
  readonly #api: DbStudioApi
  readonly #cb: ResultTabsCallbacks

  /** 标签栏（横向可滚动）。 */
  readonly #barEl: HTMLElement
  /** 标签内容区：每个标签的 pane 都塞在这里，靠 hidden 切换。 */
  readonly #stackEl: HTMLElement
  /** 空态提示：一个标签都没有时显示。 */
  readonly #emptyEl: HTMLElement
  /** 「导出全部」按钮：作用于当前标签。 */
  readonly #exportAllBtn: HTMLButtonElement
  readonly #exportAllLabel: string

  readonly #tabs: Tab[] = []
  #activeId: number | null = null
  #nextId = 1

  constructor(
    barEl: HTMLElement,
    stackEl: HTMLElement,
    emptyEl: HTMLElement,
    exportAllBtn: HTMLButtonElement,
    api: DbStudioApi,
    cb: ResultTabsCallbacks
  ) {
    this.#barEl = barEl
    this.#stackEl = stackEl
    this.#emptyEl = emptyEl
    this.#exportAllBtn = exportAllBtn
    this.#exportAllLabel = exportAllBtn.textContent ?? '导出全部 CSV'
    this.#api = api
    this.#cb = cb

    this.#exportAllBtn.addEventListener('click', () => void this.#exportAll())
    // 键盘：Ctrl/Cmd+W 关闭当前标签。
    // 挂在 window 上而不是某个 pane：用户焦点可能在标签栏、也可能在网格里，
    // 而快捷键是「当前标签」维度的，与焦点无关（同浏览器的 Cmd+W 心智）。
    globalThis.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'w' || e.key === 'W')) {
        if (this.#activeId !== null) {
          e.preventDefault()
          void this.closeTab(this.#activeId)
        }
      }
    })

    this.#renderBar()
    this.#syncChrome()
  }

  // -------------------------------------------------------------------------
  // 创建标签
  // -------------------------------------------------------------------------

  /**
   * 打开一张表 → 新开一个标签。
   *
   * 刻意「新开」而不是「替换」：用户点树上的表，多半是想和手里那张对比着看。
   */
  async openTable(ref: ObjectRef, desc: TableDescription): Promise<ResultGrid> {
    const title = ref.name || ref.id
    const tab = this.#createTab(title, { kind: 'table', ref, desc })
    // 先切到这个新标签再执行查询：查询是异步的，切过去能让用户立刻看到
    // 「正在执行」的状态，而不是等查完才跳转（否则会觉得点了没反应）。
    this.#activate(tab.id)
    try {
      await tab.grid!.openTable(ref, desc)
    } catch (e) {
      this.#cb.onStatus(`打开表失败：${errText(e)}`, true)
    }
    return tab.grid!
  }

  /** 执行 SQL → 新开一个标签，标题取 SQL 前若干字符。 */
  async runSql(
    nodeId: string,
    sql: string,
    filter?: Pick<ActiveTabContext, 'baseSource' | 'filterText' | 'filterConditions'>,
    options?: QueryOptions,
    initialResult?: QueryResult
  ): Promise<{ grid: ResultGrid; outcome: SqlExecutionOutcome }> {
    const tab = this.#createTab(sqlTitle(sql), { kind: 'sql', nodeId, sql, options })
    if (filter) {
      tab.baseSource = filter.baseSource
      tab.filterText = filter.filterText
      tab.filterConditions = filter.filterConditions.map((c) => ({ ...c }))
      tab.filterDraft = filter.filterText
      tab.filterVisible = true
    }
    this.#activate(tab.id)
    let outcome: SqlExecutionOutcome = { result: null, error: '执行未完成' }
    try {
      outcome = await tab.grid!.runSql(nodeId, sql, options, initialResult)
    } catch (e) {
      this.#cb.onStatus(`执行 SQL 失败：${errText(e)}`, true)
      outcome = { result: null, error: errText(e) }
    }
    return { grid: tab.grid!, outcome }
  }

  /** 展示 DML/DDL 的结构化命令执行结果卡片面板。 */
  async showCommandResult(nodeId: string, sql: string, result: Exclude<StatementResult, { kind: 'rows' }>): Promise<void> {
    const title = sqlTitle(sql)
    const id = this.#nextId++
    const pane = document.createElement('div')
    pane.className = 'tab-pane'
    pane.dataset['tabId'] = String(id)

    const summaryPane = document.createElement('div')
    summaryPane.className = 'statement-summary-pane'

    const header = document.createElement('div')
    header.className = 'statement-summary-header'

    const badge = document.createElement('span')
    badge.className = `statement-badge is-${result.kind}`
    badge.textContent = result.kind === 'affected' ? 'DML 变更' : 'DDL 结构'

    const titleEl = document.createElement('h3')
    titleEl.className = 'statement-title'
    titleEl.textContent = title
    header.append(badge, titleEl)

    const stats = document.createElement('div')
    stats.className = 'statement-stats'

    if (result.kind === 'affected') {
      const statAff = document.createElement('div')
      statAff.className = 'statement-stat'
      statAff.innerHTML = `<span class="stat-label">影响行数</span><span class="stat-value">影响 ${result.affected} 行</span>`
      stats.appendChild(statAff)
    } else if (result.kind === 'ddl') {
      const statDdl = document.createElement('div')
      statDdl.className = 'statement-stat'
      statDdl.innerHTML = `<span class="stat-label">变更摘要</span><span class="stat-value">${result.summary}</span>`
      stats.appendChild(statDdl)
    }

    const statElapsed = document.createElement('div')
    statElapsed.className = 'statement-stat'
    statElapsed.innerHTML = `<span class="stat-label">执行耗时</span><span class="stat-value">耗时 ${result.elapsedMs}ms</span>`
    stats.appendChild(statElapsed)

    if (result.kind === 'affected' && result.inTransaction) {
      const statTx = document.createElement('div')
      statTx.className = 'statement-stat'
      statTx.innerHTML = `<span class="stat-label">事务状态</span><span class="stat-value is-pending">未提交（事务中）</span>`
      stats.appendChild(statTx)
    }

    const sqlBox = document.createElement('div')
    sqlBox.className = 'statement-sql-box'
    const code = document.createElement('code')
    code.textContent = result.executedSql || sql
    sqlBox.appendChild(code)

    summaryPane.append(header, stats, sqlBox)
    pane.appendChild(summaryPane)
    this.#stackEl.appendChild(pane)

    const tab: Tab = {
      id,
      title,
      kind: 'command-summary',
      grid: null,
      pane,
      source: { kind: 'sql', nodeId, sql },
      baseSource: { kind: 'sql', nodeId, sql },
      filterText: '',
      filterConditions: [],
      filterDraft: '',
      filterVisible: false,
      closing: false,
      status: null,
      exporting: false,
      exportProgress: null
    }

    this.#tabs.push(tab)
    this.#activate(tab.id)
  }

  get activeContext(): ActiveTabContext | null {
    const tab = this.#tabs.find((t) => t.id === this.#activeId)
    if (!tab || !tab.grid || tab.grid.isDisposed) return null
    const nodeId = tab.source.kind === 'table' ? tab.source.ref.id : tab.source.nodeId
    const parsed = NodeId.parse(nodeId)
    if (!parsed) throw new Error(`标签缺少连接归属：${nodeId}`)
    return {
      id: tab.id,
      connectionId: parsed.connectionId,
      connectionNodeId: NodeId.connection(parsed.connectionId),
      grid: tab.grid,
      source: { ...tab.source },
      baseSource: { ...tab.baseSource },
      originalSql: tab.baseSource.kind === 'sql' ? tab.baseSource.sql : null,
      filterText: tab.filterText,
      filterConditions: tab.filterConditions.map((c) => ({ ...c })),
      filterDraft: tab.filterDraft,
      filterVisible: tab.filterVisible,
      closing: tab.closing
    }
  }

  /** Keep unsubmitted input per tab as well as the applied conditions. */
  setFilterDraft(text: string, visible: boolean): void {
    const tab = this.#tabs.find((t) => t.id === this.#activeId)
    if (!tab || tab.closing) return
    tab.filterDraft = text
    tab.filterVisible = visible
  }

  /** 造一个标签：建 DOM pane、new 一个独立 ResultGrid、接到栈里。 */
  #createTab(title: string, source: TabSource): Tab {
    const id = this.#nextId++
    const pane = document.createElement('div')
    pane.className = 'tab-pane'
    // 每个 ResultGrid 自己会在 root 里建 toolbar/banner/header/viewport。
    // 我们只给它一个干净的容器，**不复制 grid 的任何内部代码**。
    const gridRoot = document.createElement('div')
    gridRoot.className = 'tab-grid-root grid-panel'
    pane.appendChild(gridRoot)
    this.#stackEl.appendChild(pane)

    const grid = new ResultGrid(gridRoot, {
      onInvalidated: () => this.#syncChrome(),
      onStatus: (text, isError = false) => {
        const tab = this.#tabById(id)
        if (!tab || tab.closing) return
        tab.status = { text, isError }
        if (this.#activeId === id) this.#cb.onStatus(text, isError)
      }
    })
    grid.attachApi(this.#api)
    // 网格顶部的「执行 SQL」条由外部提供。这里给一个薄占位，说明这是只读结果视图。
    // （真正的 SQL 输入条在页面底部 #sqlbar，全局唯一的。）
    const notice = document.createElement('span')
    notice.className = 'grid-tab-notice'
    notice.textContent = source.kind === 'table' ? `表：${source.ref.name}` : 'SQL 结果'
    grid.setToolbar(notice)

    // grid.ts also has a legacy CSV button. Guard it in capture phase so it
    // cannot bypass the same integrity check as the external format toolbar.
    pane.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button')
      if (!button?.textContent?.startsWith('导出 CSV')) return
      try {
        assertCompleteRows(grid.exportLoadedRows().rows.map((r) => r.cells))
      } catch (e) {
        event.preventDefault()
        event.stopImmediatePropagation()
        this.#cb.onStatus(`导出失败：${errText(e)}`, true)
      }
    }, true)

    const tab: Tab = {
      id, title, kind: 'grid', grid, pane, source, baseSource: source,
      filterText: '', filterConditions: [], filterDraft: '', filterVisible: false,
      closing: false, status: null, exporting: false, exportProgress: null
    }
    this.#tabs.push(tab)
    this.#renderBar()
    this.#syncChrome()
    const status = this.#tabById(id)?.status
    if (status) this.#cb.onStatus(status.text, status.isError)
    return tab
  }

  // -------------------------------------------------------------------------
  // 切换 / 关闭
  // -------------------------------------------------------------------------

  #tabById(id: number): Tab | undefined {
    return this.#tabs.find((t) => t.id === id)
  }

  /** 切到某个标签：只显示/隐藏 pane，不重建（保留滚动位置与全部状态）。 */
  #activate(id: number): void {
    this.#activeId = id
    for (const t of this.#tabs) {
      t.pane.hidden = t.id !== id
    }
    this.#renderBar()
    this.#syncChrome()
  }

  /**
   * 关闭标签。
   *
   * **必须 await dispose()**：它负责 closeCursor 释放游标。这是本文件最重要的一条。
   * 顺序：先 dispose（异步释放句柄）→ 再从 DOM 与数组移除 → 若关的是当前标签则
   * 切到相邻一个。
   */
  async closeTab(id: number): Promise<void> {
    const idx = this.#tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const tab = this.#tabs[idx]
    if (!tab || tab.closing) return
    tab.closing = true
    this.#syncChrome()

    if (tab.grid) {
      try {
        if (!(await tab.grid.prepareToLeave('关闭标签'))) {
          tab.closing = false
          this.#syncChrome()
          return
        }
      } catch (e) {
        tab.closing = false
        this.#syncChrome()
        this.#cb.onStatus(`关闭标签前检查编辑失败：${errText(e)}`, true)
        return
      }

      // 先释放游标，再摘 DOM。即使 dispose 抛错也要继续清理 DOM，否则会留下
      // "看不见但还在"的僵尸 pane。所以用 try/finally 把清理与释放分开。
      try {
        await tab.grid.dispose()
      } catch (e) {
        // 释放失败不阻断关闭流程，但要让人知道（可能是连接已断）。
        this.#cb.onStatus(`关闭标签时释放游标失败：${errText(e)}`, true)
      }
    }
      tab.pane.remove()
      // await dispose() 期间别的标签可能已经关掉了，所以按对象重新定位下标，
      // 不能用 await 之前记下的那个位置。
      const currentIndex = this.#tabs.indexOf(tab)
      this.#tabs.splice(currentIndex, 1)
      if (this.#activeId === id) {
        // 关掉当前标签后，优先切到它左边那个；没有左边就切第一个。
        const next = this.#tabs.slice(0, currentIndex).reverse().find((t) => !t.closing)
          ?? this.#tabs.find((t) => !t.closing) ?? null
        this.#activeId = next ? next.id : null
        for (const t of this.#tabs) t.pane.hidden = t.id !== this.#activeId
      }
      this.#renderBar()
      this.#syncChrome()
      const status = this.#tabs.find((t) => t.id === this.#activeId)?.status
      if (status) this.#cb.onStatus(status.text, status.isError)
  }

  /** 关闭当前标签（快捷键与按钮共用）。 */
  async closeActive(): Promise<void> {
    if (this.#activeId !== null) await this.closeTab(this.#activeId)
  }

  /** 当前标签数量（供自检/外部查询）。 */
  get tabCount(): number {
    return this.#tabs.length
  }

  // -------------------------------------------------------------------------
  // 渲染标签栏 / 空态与按钮可用性
  // -------------------------------------------------------------------------

  #renderBar(): void {
    this.#barEl.replaceChildren()

    for (const t of this.#tabs) {
      const chip = document.createElement('div')
      chip.className = 'tab-chip'
      chip.setAttribute('role', 'tab')
      chip.setAttribute('aria-selected', String(t.id === this.#activeId))
      if (t.id === this.#activeId) chip.classList.add('is-active')

      const label = document.createElement('span')
      label.className = 'tab-chip-label'
      label.textContent = t.title
      label.title = t.title
      label.addEventListener('click', () => this.#activate(t.id))
      chip.appendChild(label)

      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'tab-chip-close'
      close.textContent = '×'
      close.title = '关闭标签（Ctrl/Cmd+W）'
      // 关闭按钮的点击不能冒泡成「切换标签」，否则会先激活再关闭，闪烁一下。
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.closeTab(t.id)
      })
      chip.appendChild(close)

      // 点 chip 空白处也激活。
      chip.addEventListener('click', () => this.#activate(t.id))

      this.#barEl.appendChild(chip)
    }
  }

  /** 空态与「导出全部」按钮的可用性，随标签变化同步。 */
  #syncChrome(): void {
    const has = this.#tabs.length > 0
    this.#emptyEl.hidden = has
    this.#stackEl.hidden = !has
    const active = this.#activeId !== null ? this.#tabById(this.#activeId) : undefined
    this.#exportAllBtn.disabled = !active || !active.grid || active.grid.isDisposed || active.exporting || active.closing
    this.#exportAllBtn.textContent = active?.exportProgress ?? this.#exportAllLabel
    if (active) {
      // tooltip 明确两件事：①只作用于当前标签 ②会重新查询一次 ③有上限。
      this.#exportAllBtn.title =
        `导出当前标签的全部行（会重新执行一次该查询）。` +
        `最多 ${MAX_EXPORT_ALL_ROWS.toLocaleString()} 行；含截断字段预览会拒绝导出。`
    }
    this.#cb.onActiveChange?.(this.activeContext)
  }

  // -------------------------------------------------------------------------
  // 导出全部行
  // -------------------------------------------------------------------------

  /**
   * 导出当前标签的**全部**行。
   *
   * 实现：用 runQuery 重新执行该标签的查询 → 循环 fetchResultPage 拉完所有页
   * → 拼 CSV。为什么要重新查询：grid 内部只缓存看过的页，无法「要全部」；
   * 而重新查询能拿到一个全新的游标，从头顺序拉完，且不需要 grid 暴露内部状态。
   *
   * 代价与保护：这会**把整个结果集读进渲染进程内存**（跨进程全量搬运，正是
   * 「陷阱 5」）。所以边拉边计数，一旦累计行数要超过上限就**立即中止并释放
   * 游标**，绝不继续吃内存。
   */
  async #exportAll(): Promise<void> {
    const id = this.#activeId
    if (id === null) return
    const tab = this.#tabById(id)
    if (!tab || !tab.grid || tab.grid.isDisposed || tab.exporting || tab.closing) return

    tab.exporting = true
    this.#syncChrome()
    let cursorId: string | null = null
    try {
      // 1) 重新执行查询，拿第一页 + 新游标。
      const first = await this.#runQueryForSource(tab.source)
      cursorId = first.cursorId
      if (!tab.grid || tab.grid.isDisposed || tab.closing || !this.#tabs.includes(tab)) return
      // previewTable/runQuery 若没保留游标（keepCursor=false）就没有 cursorId：
      // 这种情况只能导出第一页，明确告知，而不是假装导完了。
      if (!cursorId) {
        this.#cb.onStatus('该查询未保留游标，只能导出第一页（其余需要重新查询取游标）', true)
        return
      }
      const firstCursor: string = cursorId
      const columns = first.columns
      const rows: CellValue[][] = []
      let total = first.returned
      if (total > MAX_EXPORT_ALL_ROWS) throw new Error(`数据量超过导出上限（${MAX_EXPORT_ALL_ROWS} 行）`)
      assertCompleteRows(first.rows.map((r) => r.cells))
      rows.push(...first.rows.map((r) => [...r.cells]))
      tab.exportProgress = `正在导出 ${total} 行…`
      this.#syncChrome()

      // 2) 循环拉后续页，直到 hasMore=false 或超过上限。
      let page: ResultPage = first
      while (page.hasMore) {
        // 上限检查放在「下一批会导致超限」之前，避免先拉回来再判断（那样已经吃内存了）。
        if (total >= MAX_EXPORT_ALL_ROWS) {
          this.#cb.onStatus(
            `数据量超过导出上限（${MAX_EXPORT_ALL_ROWS.toLocaleString()} 行），已中止导出。` +
              `请改用数据库侧导出（如 SQL / 命令行 COPY）。`,
            true
          )
          return // finally 会释放游标
        }
        const offset = total
        const next: ResultPage = await this.#api.fetchResultPage(
          firstCursor,
          offset,
          Math.min(EXPORT_PAGE_SIZE, MAX_EXPORT_ALL_ROWS - total)
        )
        if (!tab.grid || tab.grid.isDisposed || tab.closing || !this.#tabs.includes(tab)) return
        if (next.returned === 0) {
          if (next.hasMore) throw new Error('分页未前进，已中止导出（不能确认结果完整）')
          break
        }
        assertCompleteRows(next.rows.map((r) => r.cells))
        total += next.returned
        rows.push(...next.rows.map((r) => [...r.cells]))
        tab.exportProgress = `正在导出 ${total} 行…`
        this.#syncChrome()
        page = next
        // 到这里若已超上限，下一轮循环开头会中止。
        if (total > MAX_EXPORT_ALL_ROWS) {
          this.#cb.onStatus(
            `数据量超过导出上限（${MAX_EXPORT_ALL_ROWS.toLocaleString()} 行），已中止导出。` +
              `请改用数据库侧导出。`,
            true
          )
          return
        }
      }

      if (rows.length === 0) {
        this.#cb.onStatus('该结果集没有行可导出', true)
        return
      }

      // 3) 拼 CSV（RFC4180，沿用 grid 的 csvEscape 规则，不重复实现转义逻辑）。
      const header = columns.map((c: ResultColumn) => csvEscape(c.name)).join(',')
      const lines = [header]
      for (const cells of rows) {
        lines.push(columns.map((_, i) => csvEscape(cellToCsvText(cells[i]))).join(','))
      }
      // BOM 让 Excel 正确识别 UTF-8 中文。
      const blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], {
        type: 'text/csv;charset=utf-8'
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = buildCsvFileName()
      document.body.appendChild(a)
      a.click()
      a.remove()
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 0)
      this.#cb.onStatus(`已导出全部 ${rows.length} 行到 ${a.download}（字段未截断；重新查询的结果）`)
    } catch (e) {
      this.#cb.onStatus(`导出全部失败：${errText(e)}`, true)
    } finally {
      tab.exporting = false
      tab.exportProgress = null
      this.#syncChrome()
      // 释放这次导出用的临时游标（与标签本身的长游标是两个不同的游标）。
      if (cursorId) {
        try {
          await this.#api.closeCursor(cursorId)
        } catch {
          /* 游标可能已随连接关闭被释放 */
        }
      }
    }
  }

  /** 按来源重新执行查询（只取第一页）。 */
  async #runQueryForSource(source: TabSource): Promise<QueryResult> {
    if (source.kind === 'table') {
      // previewTable 内部会生成 SELECT * FROM <quoted>，等价于「查这张表」。
      return this.#api.previewTable(source.ref.id, EXPORT_PAGE_SIZE)
    }
    const options: QueryOptions = { ...source.options, limit: EXPORT_PAGE_SIZE }
    return this.#api.runQuery(source.nodeId, source.sql, options)
  }
}

// ---------------------------------------------------------------------------
// 纯函数（可被静态自检直接 import）
// ---------------------------------------------------------------------------

/** 用 SQL 的前若干字符做标签名：压掉空白、超长截断加省略号。 */
export function sqlTitle(sql: string, maxLen = 40): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxLen) return oneLine || '(空 SQL)'
  return oneLine.slice(0, maxLen) + '…'
}

/**
 * 单元格 → CSV 文本。NULL 用空串（CSV 没有 NULL 概念）。
 * 与 grid.ts 的同类函数语义一致——但那是私有函数，无法 import，故在此本地实现
 * 这一个纯映射（不是复制 grid 的组件代码，只是同一份数据契约的取值规则）。
 */
export function cellToCsvText(cell: CellValue | undefined): string {
  assertCompleteCell(cell)
  if (!cell) return ''
  switch (cell.kind) {
    case 'null':
      return ''
    case 'number':
      return String(cell.value)
    case 'boolean':
      return cell.value ? 'true' : 'false'
    case 'text':
      return cell.text
    case 'blob':
      return cell.previewBase64
    default:
      return ''
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
