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
import type { QuotingRules } from '../core/driver'

/** 行高必须与 CSS `.grid-row { height }` 一致。 */
const ROW_HEIGHT = 24
/** 默认列宽。用户拖过之后以实例状态 `#colWidths` 为准（不再用这个定值）。 */
const DEFAULT_COL_WIDTH = 160
/** 列宽下限。太窄会连列名都看不清，也无法拖回去。 */
const MIN_COL_WIDTH = 60
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

/**
 * `window.dbstudio` 上本阶段依赖、但由 P0-B 并行实现的两个方法。
 *
 * 为什么单独声明而不是改 `core/api.ts`：那个文件不归我改（写入范围只有
 * grid.ts / style.css），而且它们属于**同一份契约**——等 P0-B 合并后，
 * `DbStudioApi` 会自然带上这两个方法，此处的本地扩展就与它重合。
 * 用可选方法（`?`）是关键：编译期允许缺失，运行期必须判空并优雅降级，
 * 这样在接口就绪之前网格依然可用，不会白屏。
 */
type FutureCellApi = {
  /** 取某个单元格的完整值（用于被截断的长文本 / BLOB）。未就绪时降级。 */
  fetchCellValue?: (cursorId: string, rowIndex: number, colIndex: number) => Promise<CellValue>
  /** 统计某张表的精确行数（全表扫描，必须显式触发）。 */
  countRows?: (tableNodeId: string) => Promise<number>
}
type GridApi = DbStudioApi & FutureCellApi

/** 当前排序状态。`dir === null` 表示未排序（列下标 -1）。 */
interface SortState {
  /** 列在 `#columns` 中的下标；-1 表示无排序列。 */
  col: number
  dir: 'asc' | 'desc' | null
}

/** 网格当前的数据来源，决定「能否编辑 / 能否排序 / 能否统计行数」。 */
type Source =
  | { kind: 'table'; ref: ObjectRef; desc: TableDescription }
  | { kind: 'sql'; sql: string; nodeId: string }

export class ResultGrid {
  readonly #root: HTMLElement
  readonly #cb: GridCallbacks
  #api: GridApi | null = null

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

  // ---- 列宽（实例状态：表头与数据行必须共用同一份） ----
  //
  // 为什么存在实例上而不是内联写死：拖宽一列之后，表头那一格和数据行的每一格
  // 都得同步变宽，否则列会错位（用户把手机号列拖宽了，值却还挤在 160px 里，
  // 等于没拖）。键用列名而不是列下标，因为重排序后列下标会变。
  readonly #colWidths = new Map<string, number>()

  // ---- 排序 ----
  #sort: SortState = { col: -1, dir: null }
  /** 方言引号规则缓存。取不到时显示"无法排序"，绝不拼接未转义的列名。 */
  #quoting: QuotingRules | null = null
  #quotingTried = false
  /** 排序重查进行中：禁用列头点击，防连点。 */
  #sorting = false

  // ---- 复制 / 右键菜单 / 全文模态 ----
  readonly #menuEl: HTMLElement
  readonly #modalEl: HTMLElement

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
  /**
   * 表头的**内层**容器。
   *
   * 为什么需要它：`.grid-header` 是 `.grid-viewport` 的兄弟节点，
   * viewport 横向滚动时表头不会跟着动——实测 30 列的表横滚 400px 后，
   * 表头第一列停在 x=424 而数据第一列在 x=24，**列名与数据错位 400px**，
   * 用户会照错列读数据。
   *
   * 修法不是把表头塞进 viewport（那会与绝对定位的行层打架、还要重算 y 坐标），
   * 而是在表头内部再套一层：外层铺满宽度负责背景与裁剪，内层按内容宽度
   * 并跟随 viewport 的 scrollLeft 平移。这样背景不留空隙、内容又与数据对齐。
   */
  readonly #headerInnerEl: HTMLElement
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

    this.#headerInnerEl = document.createElement('div')
    this.#headerInnerEl.className = 'grid-header-inner'
    this.#headerInnerEl.setAttribute('role', 'row')
    this.#headerEl.appendChild(this.#headerInnerEl)

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

    // 右键菜单与全文模态挂到 body 上，而不是 #root 里：
    // 它们要浮在网格之上、且不能被网格的 overflow 裁剪掉。
    this.#menuEl = document.createElement('div')
    this.#menuEl.className = 'grid-menu'
    this.#menuEl.hidden = true
    document.body.appendChild(this.#menuEl)

    this.#modalEl = document.createElement('div')
    this.#modalEl.className = 'grid-modal'
    this.#modalEl.hidden = true
    document.body.appendChild(this.#modalEl)

    this.#root.replaceChildren(
      this.#toolbarEl,
      this.#bannerEl,
      this.#headerEl,
      this.#viewportEl
    )

    this.#viewportEl.addEventListener(
      'scroll',
      () => {
        // 横向同步：表头内层跟着 viewport 的 scrollLeft 平移。
        // 用 transform 而不是 scrollLeft 赋值——前者不触发额外的布局与重绘，
        // 在快速横滚时不会出现表头「追不上」的滞后感。
        this.#headerInnerEl.style.transform = `translateX(${-this.#viewportEl.scrollLeft}px)`
        this.#render()
      },
      { passive: true }
    )
    globalThis.addEventListener('resize', () => this.#render())
    this.#viewportEl.addEventListener('keydown', (e) => this.#onKeyDown(e))
    // 右键菜单：滚动/点击别处时先收起，否则它会"飘"在原地。
    this.#viewportEl.addEventListener('scroll', () => this.#hideMenu(), { passive: true })
    document.addEventListener('mousedown', (e) => {
      if (!this.#menuEl.hidden && !this.#menuEl.contains(e.target as Node)) this.#hideMenu()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.#menuEl.hidden) this.#hideMenu()
    })
  }

  attachApi(api: DbStudioApi): void {
    this.#api = api as GridApi
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
    // 打开新对象时排序三态复位：不同表的列不可比，保留上一次的排序箭头会误导
    // 用户（看起来排了，其实新表没排）。列宽同理，按列名区分、换了表就清空。
    this.#sort = { col: -1, dir: null }
    this.#colWidths.clear()
    await this.#openCursor(() => api.previewTable(ref.id))
    this.#applyEditability()
    await this.#refreshTransactionState()
  }

  /** 执行自由 SQL（只读）。 */
  async runSql(nodeId: string, sql: string): Promise<void> {
    const api = this.#requireApi()
    // 记住 nodeId：排序要重查，而重查必须知道在哪个连接上跑。
    this.#source = { kind: 'sql', sql, nodeId }
    this.#desc = null
    this.#sort = { col: -1, dir: null }
    this.#colWidths.clear()
    await this.#openCursor(() => api.runQuery(nodeId, sql, { limit: PAGE_SIZE }))
    this.#applyEditability()
    await this.#refreshTransactionState()
  }

  #requireApi(): GridApi {
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
    this.#headerEl.appendChild(this.#headerInnerEl)
    this.#rowsEl.replaceChildren()
    this.#spacerEl.style.height = '0px'
    this.#bannerEl.hidden = true
    this.#hideMenu()
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
    // 工具条是整块重建的，先保住外部的「执行 SQL」条（它由外部 setToolbar 塞进来）。
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

    if (this.#root.dataset['editable'] === 'true') {
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

      // 新增行 / 删除行。
      //
      // 为什么放在这里而不是右键菜单：这是高频操作，藏在菜单里会让「这工具能改数据吗」
      // 的判断成本变高。放在工具条上一眼可见。
      const insertBtn = document.createElement('button')
      insertBtn.type = 'button'
      insertBtn.textContent = '新增行'
      insertBtn.title = '插入一行；留空的列交由数据库使用默认值'
      insertBtn.addEventListener('click', () => this.#openInsertModal())
      this.#toolbarEl.appendChild(insertBtn)

      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.textContent = '删除选中行'
      // 没有选中行时禁用：删除是不可逆操作，必须由用户明确选中目标
      deleteBtn.disabled = this.#selectedRow < 0
      deleteBtn.title =
        this.#selectedRow < 0 ? '先在网格里点选一行' : '删除当前选中行（需有唯一键）'
      deleteBtn.addEventListener('click', () => void this.#deleteSelectedRow())
      this.#toolbarEl.appendChild(deleteBtn)

      const reloadBtn = document.createElement('button')
      reloadBtn.type = 'button'
      reloadBtn.textContent = '重新加载'
      reloadBtn.addEventListener('click', () => void this.reload())
      this.#toolbarEl.appendChild(reloadBtn)
    }

    // ---- 本阶段新增：行数统计 / CSV 导出，统一右对齐 ----
    const spacer2 = document.createElement('span')
    spacer2.className = 'spacer'
    this.#toolbarEl.appendChild(spacer2)

    // 行数统计：只在「表」来源可用。
    // 自由 SQL 禁用原因：countRows(tableNodeId) 是按表名做全表 COUNT，而自由
    // SQL 没有表节点，FROM 可能是 JOIN / 子查询 / CTE，没法可靠统计。
    const countBtn = document.createElement('button')
    countBtn.type = 'button'
    countBtn.textContent = '统计行数'
    const isTable = this.#source?.kind === 'table'
    countBtn.disabled = !isTable
    countBtn.title = isTable
      ? '精确统计该表总行数（会执行一次全表 COUNT，大表请谨慎）'
      : '自由 SQL 结果无法精确统计总行数（无表节点，FROM 可能是多表/子查询/CTE）'
    countBtn.addEventListener('click', () => void this.#countRows())
    this.#toolbarEl.appendChild(countBtn)

    const loaded = this.#loadedRowCount()
    const exportBtn = document.createElement('button')
    exportBtn.type = 'button'
    exportBtn.textContent = `导出 CSV（已加载 ${loaded} 行）`
    exportBtn.disabled = loaded === 0
    // 这条 tooltip 是硬性要求：绝不能让用户以为「导出 = 全表」。
    exportBtn.title =
      `仅导出当前已加载的 ${loaded} 行（页缓存内的数据），未滚动到过的行不含在内。` +
      '需要全量请先向下滚动加载，或用数据库侧导出。'
    exportBtn.addEventListener('click', () => this.#exportCsv())
    this.#toolbarEl.appendChild(exportBtn)
  }

  /**
   * 统计行数（用户显式点击才触发）。
   *
   * 为什么必须显式：COUNT(*) 在大表上是全表扫描，可能几十秒。若自动调用，
   * 用户一打开表就卡住且不知道发生了什么。这与网格「默认不查总数、滚动条
   * 按已加载行数增长」一致（剖析报告 04 问题 2：hasMoreData 是段满推断，
   * CMD_COUNT 才是显式动作）。
   */
  async #countRows(): Promise<void> {
    const src = this.#source
    if (!src || src.kind !== 'table') {
      this.#cb.onStatus('只有表来源支持精确统计行数', true)
      return
    }
    const api = this.#api
    if (!api || typeof api.countRows !== 'function') {
      // 优雅降级：接口尚未就绪时给可读提示，而不是抛异常白屏。
      this.#cb.onStatus('行数统计接口尚未就绪（countRows），请稍后重试', true)
      return
    }
    this.#cb.onStatus('正在统计行数（全表扫描，请稍候）…')
    try {
      const n = await api.countRows(src.ref.id)
      this.#cb.onStatus(`该表共 ${n.toLocaleString()} 行`)
    } catch (e) {
      this.#cb.onStatus(`统计行数失败：${errText(e)}`, true)
    }
  }

  // -------------------------------------------------------------------------
  // 排序：三态循环 + **重新查询**
  // -------------------------------------------------------------------------

  /**
   * 点击列头 → 升序 / 降序 / 取消，三态循环。
   *
   * ===== 为什么必须重新查询，绝不能在前端 sort 已加载的页 =====
   *
   * `#pages` 只是**用户看过的那部分数据的缓存**。假设表 100 万行，用户只滚到
   * 第 3 页，那 `#pages` 里最多两三百行。此时若对 `#pages` 里的行做 sort：
   *   - 看起来"排好了"，但排的只是"碰巧被加载过的那几十行"；
   *   - 真正的最大/最小值可能根本不在缓存里，排序结果**完全错误**；
   *   - 更糟：它**不会报错**。用户以为数据有序并据此判断——这种"静默错误"
   *     比崩溃危险得多。
   *
   * 正确做法是把排序下推给数据库：ORDER BY 在服务端对**全表**排序，再从偏移 0
   * 重新取页。这样每一页都是全表有序序列的一段，才正确。
   * 对应 DBeaver：`toggleSortOrder` 默认按 `isHasMoreData()` 决定，还有数据没
   * 拉完就走服务端（剖析报告 04 问题 6）。
   */
  async #onHeaderSortClick(col: number): Promise<void> {
    if (this.#sorting) return
    const next = nextSortState(this.#sort, col)
    const wasSame = this.#sort.col === col

    this.#sort = next
    this.#renderHeader()

    // 第三种状态（取消排序）也要重查：否则会停留在"上一次服务端排序"的结果上，
    // 而箭头却显示未排序——状态与数据不一致，同样是静默错误。
    if (next.dir === null) {
      await this.#requerySorted(null)
      return
    }
    if (!wasSame && next.dir === 'asc') {
      // 换了列并从升序开始，正常往下走
    }

    // 拼 ORDER BY 需要方言引号规则；拿不到就明确拒绝，绝不拼未转义的列名
    // （列名可能含空格/关键字/引号，直接拼进 SQL 会语法错误甚至注入）。
    const rules = await this.#ensureQuoting()
    if (!rules) {
      this.#sort = { col: -1, dir: null }
      this.#renderHeader()
      this.#cb.onStatus('无法获取方言引号规则，已取消排序（不会拼接未转义的列名）', true)
      return
    }
    const colName = this.#columns[col]?.name
    if (!colName) return
    await this.#requerySorted({ col, dir: next.dir, rules, colName })
  }

  /**
   * 按当前排序重查。`sort === null` 表示取消排序、回到原始顺序。
   *
   * 取数方式：
   *   - 表：`SELECT * FROM <quoted table> [ORDER BY <quoted col> ASC/DESC]`
   *   - 自由 SQL：`SELECT * FROM (<原 SQL>) _dbstudio_sort [ORDER BY ...]`
   *     （包一层子查询，保证 ORDER BY 作用在原查询的**结果**上）
   */
  async #requerySorted(
    sort: { col: number; dir: 'asc' | 'desc'; rules: QuotingRules; colName: string } | null
  ): Promise<void> {
    const api = this.#requireApi()
    const src = this.#source
    if (!src) return

    this.#sorting = true
    this.#renderHeader() // 刷新箭头/禁用态
    this.#cb.onStatus(sort ? '正在按列排序（重新查询）…' : '正在恢复原始顺序（重新查询）…')
    try {
      const order =
        sort === null
          ? ''
          : ` ORDER BY ${quoteIdentifier(sort.colName, sort.rules)} ${sort.dir === 'asc' ? 'ASC' : 'DESC'}`
      if (src.kind === 'table') {
        const table = quoteIdentifier(src.ref.name, sort?.rules ?? (await this.#requireQuoting()))
        const sql = `SELECT * FROM ${table}${order}`
        await this.#openCursor(() => api.runQuery(src.ref.id, sql, { limit: PAGE_SIZE }))
      } else {
        // 子查询别名固定且带下划线，避开与原 SQL 里的表别名撞名。
        const sql = `SELECT * FROM (${src.sql}) _dbstudio_sort${order}`
        await this.#openCursor(() => api.runQuery(src.nodeId, sql, { limit: PAGE_SIZE }))
      }
      this.#cb.onStatus(
        sort
          ? `已按「${sort.colName}」${sort.dir === 'asc' ? '升序' : '降序'}重新查询`
          : '已恢复原始顺序（重新查询）'
      )
    } catch (e) {
      this.#cb.onStatus(`排序失败：${errText(e)}`, true)
    } finally {
      this.#sorting = false
      this.#renderHeader()
    }
  }

  /** 取一次方言引号规则并缓存；失败返回 null（调用方据此拒绝排序）。 */
  async #ensureQuoting(): Promise<QuotingRules | null> {
    if (this.#quoting) return this.#quoting
    if (this.#quotingTried && !this.#quoting) return null
    this.#quotingTried = true
    const api = this.#api
    if (!api) return null
    try {
      const dialects = await api.listDialects()
      const rules = pickQuotingRules(dialects)
      if (rules) this.#quoting = rules
      return this.#quoting
    } catch {
      return null
    }
  }

  /** 表来源重查需要引号规则；理论上 #ensureQuoting 已保证，兜底再取一次。 */
  async #requireQuoting(): Promise<QuotingRules> {
    const r = this.#quoting ?? (await this.#ensureQuoting())
    if (!r) throw new Error('缺少方言引号规则，无法生成表名')
    return r
  }

  // -------------------------------------------------------------------------
  // 列宽拖拽 / 自适应
  // -------------------------------------------------------------------------

  #colWidth(col: ResultColumn): number {
    return this.#colWidths.get(col.name) ?? DEFAULT_COL_WIDTH
  }

  /** 表头右边缘的拖拽手柄。拖完写进 #colWidths，表头与行同步生效。 */
  #attachResizer(handle: HTMLElement, col: ResultColumn, headerCell: HTMLElement): void {
    let startX = 0
    let startW = 0
    let dragging = false

    const onMove = (e: MouseEvent): void => {
      if (!dragging) return
      const w = Math.max(MIN_COL_WIDTH, startW + (e.clientX - startX))
      this.#colWidths.set(col.name, w)
      headerCell.style.width = `${w}px`
      // 拖动中把数据行同名列也同步改宽，否则"表头动了、数据没动"。
      this.#applyColumnWidthToRows(col.name, w)
    }
    const onUp = (): void => {
      if (!dragging) return
      dragging = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      this.#render() // 收尾整体重绘，清掉拖动中的临时状态
    }

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation() // 别触发列头排序
      dragging = true
      startX = e.clientX
      startW = this.#colWidth(col)
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })

    // 双击手柄：按已加载数据的最长值估算宽度（一次估算，不逐帧）。
    handle.addEventListener('dblclick', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const w = this.#autoFitWidth(col)
      this.#colWidths.set(col.name, w)
      headerCell.style.width = `${w}px`
      this.#applyColumnWidthToRows(col.name, w)
      this.#render()
    })
  }

  /** 拖动中同步同名列数据格宽度（避免等下一帧整体重绘的闪动）。 */
  #applyColumnWidthToRows(colName: string, width: number): void {
    const idx = this.#columns.findIndex((c) => c.name === colName)
    if (idx < 0) return
    const cellIndex = idx + 1 // 行内：行号列在 0，数据列从 1 开始
    for (const rowEl of Array.from(this.#rowsEl.children)) {
      const cell = rowEl.children[cellIndex]
      if (cell instanceof HTMLElement) cell.style.width = `${width}px`
    }
  }

  /**
   * 按已加载数据估算列宽。
   * 注意"已加载"限定：我们**只有**页缓存里的值，所以这是"当前已加载数据的最长值"，
   * 不是全表最长值。想看更宽仍可手动拖。
   */
  #autoFitWidth(col: ResultColumn): number {
    const idx = this.#columns.findIndex((c) => c.name === col.name)
    let maxLen = col.name.length
    if (idx >= 0) {
      for (const page of this.#pages.values()) {
        for (const row of page.rows) {
          const v = row.cells[idx]
          if (!v) continue
          const len = cellDisplayLength(v)
          if (len > maxLen) maxLen = len
        }
      }
    }
    // 粗略换算：每字符约 7px + 左右 padding 16 + 一点余量。
    return Math.max(MIN_COL_WIDTH, Math.min(1200, maxLen * 7 + 24))
  }

  // -------------------------------------------------------------------------
  // 复制 / 右键菜单 / 查看全文
  // -------------------------------------------------------------------------

  #copyCell(row: number, col: number): void {
    const rowVal = this.#rowAt(row)
    if (!rowVal) {
      this.#cb.onStatus('该行尚未加载，无法复制', true)
      return
    }
    const cell = rowVal.cells[col] ?? { kind: 'null' as const }
    // NULL 复制成空字符串（Excel 里 NULL 常就是空），并在状态栏说清楚。
    this.#writeClipboard(cellToClipboardText(cell), cell.kind === 'null' ? '已复制（NULL → 空字符串）' : '已复制单元格')
  }

  #copyRow(row: number): void {
    const rowVal = this.#rowAt(row)
    if (!rowVal) {
      this.#cb.onStatus('该行尚未加载，无法复制', true)
      return
    }
    // 整行用 Tab 分隔：粘到 Excel/表格里就是一行多列。
    const parts: string[] = []
    for (let c = 0; c < this.#columns.length; c++) {
      const cell = rowVal.cells[c] ?? { kind: 'null' as const }
      // 整行复制里的 NULL 用空串，但保留列结构（否则粘出来列数会错）。
      parts.push(cellToClipboardText(cell))
    }
    this.#writeClipboard(parts.join('\t'), `已复制整行（${parts.length} 列，Tab 分隔）`)
  }

  #writeClipboard(text: string, okMsg: string): void {
    // 失败必须提示而不是静默：否则用户以为复制成功，粘出来是旧剪贴板内容。
    void navigator.clipboard
      .writeText(text)
      .then(() => this.#cb.onStatus(okMsg))
      .catch((e: unknown) => this.#cb.onStatus(`复制失败：${errText(e)}`, true))
  }

  /** 当前选中的单元格值；无选中返回 null。 */
  #currentCellValue(): CellValue | null {
    if (this.#selectedRow < 0 || this.#selectedCol < 0) return null
    const row = this.#rowAt(this.#selectedRow)
    return row?.cells[this.#selectedCol] ?? null
  }

  #showContextMenu(x: number, y: number): void {
    if (this.#selectedRow < 0 || this.#selectedCol < 0) return
    const items: Array<{ label: string; run: () => void }> = [
      { label: '复制单元格', run: () => this.#copyCell(this.#selectedRow, this.#selectedCol) },
      { label: '复制整行', run: () => this.#copyRow(this.#selectedRow) },
    ]
    // 「查看完整值」只对被截断的值有意义。
    const val = this.#currentCellValue()
    if (val && (val.kind === 'text' || val.kind === 'blob') && val.truncated) {
      items.push({ label: '查看完整值…', run: () => void this.#openFullValue() })
    }

    this.#menuEl.replaceChildren()
    for (const it of items) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'grid-menu-item'
      btn.textContent = it.label
      btn.addEventListener('click', () => {
        this.#hideMenu()
        it.run()
      })
      this.#menuEl.appendChild(btn)
    }
    // 先显示再量尺寸，避免超出视口时被裁掉。
    this.#menuEl.hidden = false
    this.#menuEl.style.left = '0px'
    this.#menuEl.style.top = '0px'
    const rect = this.#menuEl.getBoundingClientRect()
    const left = Math.min(x, globalThis.innerWidth - rect.width - 4)
    const top = Math.min(y, globalThis.innerHeight - rect.height - 4)
    this.#menuEl.style.left = `${Math.max(0, left)}px`
    this.#menuEl.style.top = `${Math.max(0, top)}px`
  }

  #hideMenu(): void {
    this.#menuEl.hidden = true
  }

  /**
   * 查看完整值。
   *
   * 被截断的单元格只持有前 1000 字符（数据通道就截断了，见 core/resultset.ts），
   * 所以要看全文必须回主进程单独取。fetchCellValue 由 P0-B 并行实现，
   * 就绪前这里必须**优雅降级**：提示接口未就绪，而不是抛异常把页面搞白。
   */
  async #openFullValue(): Promise<void> {
    const row = this.#selectedRow
    const col = this.#selectedCol
    const cursorId = this.#cursorId
    if (row < 0 || col < 0) return
    if (!this.#currentCellValue()) return
    if (!cursorId) {
      this.#cb.onStatus('当前结果集没有游标，无法读取完整值', true)
      return
    }
    const api = this.#api
    if (!api || typeof api.fetchCellValue !== 'function') {
      // 优雅降级：接口未就绪
      this.#cb.onStatus('完整值接口尚未就绪（fetchCellValue），暂时无法查看全文', true)
      this.#showModal('完整值', '完整值接口尚未就绪（fetchCellValue）。\n等该接口上线后，这里会显示完整内容。')
      return
    }
    this.#cb.onStatus('正在读取完整值…')
    try {
      const full = await api.fetchCellValue(cursorId, row, col)
      const text = cellToClipboardText(full)
      const len = 'fullLength' in full && typeof full.fullLength === 'number' ? full.fullLength : text.length
      this.#showModal(`完整值（${len.toLocaleString()} 字符）`, text)
      this.#cb.onStatus('已读取完整值')
    } catch (e) {
      this.#cb.onStatus(`读取完整值失败：${errText(e)}`, true)
      this.#showModal('完整值', `读取失败：${errText(e)}`)
    }
  }

  /** 模态层：可滚动的全文 + 复制按钮。 */
  #showModal(title: string, body: string): void {
    this.#modalEl.replaceChildren()

    const backdrop = document.createElement('div')
    backdrop.className = 'grid-modal-backdrop'

    const panel = document.createElement('div')
    panel.className = 'grid-modal-panel'

    const head = document.createElement('div')
    head.className = 'grid-modal-head'
    const h = document.createElement('span')
    h.textContent = title
    head.appendChild(h)
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.textContent = '关闭'
    closeBtn.addEventListener('click', () => this.#hideModal())
    head.appendChild(closeBtn)

    const text = document.createElement('textarea')
    text.className = 'grid-modal-body'
    text.readOnly = true
    text.value = body
    text.spellcheck = false

    const foot = document.createElement('div')
    foot.className = 'grid-modal-foot'
    const copyBtn = document.createElement('button')
    copyBtn.type = 'button'
    copyBtn.textContent = '复制全文'
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard
        .writeText(body)
        .then(() => this.#cb.onStatus('已复制全文'))
        .catch((e: unknown) => this.#cb.onStatus(`复制失败：${errText(e)}`, true))
    })
    foot.appendChild(copyBtn)

    panel.append(head, text, foot)
    backdrop.appendChild(panel)
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.#hideModal()
    })
    this.#modalEl.appendChild(backdrop)
    this.#modalEl.hidden = false
    text.focus()
  }

  #hideModal(): void {
    this.#modalEl.hidden = true
    this.#modalEl.replaceChildren()
  }

  // -------------------------------------------------------------------------
  // CSV 导出（只导出已加载的行）
  // -------------------------------------------------------------------------

  /** 已在页缓存里、可导出的行数。 */
  #loadedRowCount(): number {
    let n = 0
    for (const page of this.#pages.values()) n += page.rows.length
    return n
  }

  /**
   * 导出 CSV。
   *
   * 只导出**已加载**的行——页缓存之外的行我们根本没有（也不该为了导出去全量
   * 拉取，那会把内存打爆）。按钮文案与 tooltip 都写明「已加载 N 行」，
   * 避免用户误以为这是全表导出。
   */
  #exportCsv(): void {
    const total = this.#loadedRowCount()
    const rows: CellValue[][] = []
    for (let i = 0; i < total; i++) {
      const row = this.#rowAt(i)
      if (row) rows.push([...row.cells])
    }
    if (rows.length === 0) {
      this.#cb.onStatus('没有已加载的行可导出', true)
      return
    }

    const header = this.#columns.map((c) => csvEscape(c.name)).join(',')
    const lines = [header]
    for (const cells of rows) {
      const cellsText = this.#columns.map((_, c) => csvEscape(cellToCsvText(cells[c] ?? { kind: 'null' })))
      lines.push(cellsText.join(','))
    }
    // 加 BOM：Excel 打开不带 BOM 的 UTF-8 CSV 会把中文显示成乱码。
    const blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = buildCsvFileName()
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 释放 object URL，避免内存泄漏（下载已开始，此时释放是安全的）。
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0)
    this.#cb.onStatus(`已导出 ${rows.length} 行到 ${a.download}（仅已加载数据）`)
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
      // 自由 SQL 现在记住了 nodeId，可以真正重查（而不是只提示用户重执行）；
      // 若当前有排序，优先重查保持排序结果。
      const sort = this.#sort
      const rules = sort.dir !== null && sort.col >= 0 ? await this.#ensureQuoting() : null
      const colName = sort.col >= 0 ? this.#columns[sort.col]?.name : undefined
      if (sort.dir !== null && rules && colName) {
        await this.#requerySorted({ col: sort.col, dir: sort.dir, rules, colName })
        return
      }
      await this.runSql(src.nodeId, src.sql)
    }
  }

  // -------------------------------------------------------------------------
  // 新增行 / 删除行
  // -------------------------------------------------------------------------

  /** 当前结果集的表节点 id；只有「表来源」才可执行增删。 */
  #tableNodeId(): string | null {
    const src = this.#source
    return src && src.kind === 'table' ? src.ref.id : null
  }

  /**
   * 新增行：弹一个按表结构生成的表单。
   *
   * 为什么用表单而不是「先插一个空行再让用户改」：
   * 空插入需要数据库能给出全部默认值，SQLite 允许 `INSERT INTO t DEFAULT VALUES`，
   * 但适配器的 `insertRow({})` 是**拒绝**空 values 的（防误用）。
   * 更重要的是：先插空行会立刻产生一条脏数据，用户中途放弃就留下垃圾行。
   * 让用户一次填完再提交，更安全。
   */
  #openInsertModal(): void {
    const desc = this.#desc
    const tableId = this.#tableNodeId()
    if (!desc || !tableId) {
      this.#cb.onStatus('只有表（不是自由 SQL）支持新增行', true)
      return
    }

    const backdrop = document.createElement('div')
    backdrop.className = 'grid-modal-backdrop'

    const modal = document.createElement('div')
    modal.className = 'grid-modal'

    const head = document.createElement('div')
    head.className = 'grid-modal-head'
    head.textContent = '新增行'
    modal.appendChild(head)

    const body = document.createElement('div')
    body.className = 'grid-modal-body'

    const hint = document.createElement('p')
    hint.style.cssText = 'margin:0 0 10px;font-size:12px;color:var(--fg-dim)'
    hint.textContent = '留空的列会使用数据库默认值（或 NULL）。主键为自增时留空即可。'
    body.appendChild(hint)

    const inputs = new Map<string, HTMLInputElement>()
    for (const col of desc.columns) {
      const row = document.createElement('label')
      row.style.cssText =
        'display:grid;grid-template-columns:140px 1fr;gap:8px;align-items:center;margin-bottom:6px'

      const name = document.createElement('span')
      const isPk = col.primaryKeyOrdinal !== null
      name.textContent = `${col.name}${isPk ? ' (PK)' : ''}`
      name.style.cssText = 'font-size:12px;color:var(--fg-dim)'
      name.title = `${col.typeName}${col.nullable ? '' : ' · NOT NULL'}`

      const input = document.createElement('input')
      input.type = 'text'
      input.dataset['column'] = col.name
      input.placeholder = col.nullable ? '（空 = NULL）' : '（必填）'
      input.style.cssText =
        'font:inherit;padding:4px 7px;border:1px solid var(--border);border-radius:5px;' +
        'background:var(--bg);color:var(--fg)'

      inputs.set(col.name, input)
      row.append(name, input)
      body.appendChild(row)
    }
    modal.appendChild(body)

    const foot = document.createElement('div')
    foot.className = 'grid-modal-foot'

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = '取消'

    const submit = document.createElement('button')
    submit.type = 'button'
    submit.textContent = '插入'

    foot.append(cancel, submit)
    modal.appendChild(foot)
    backdrop.appendChild(modal)
    document.body.appendChild(backdrop)

    const first = inputs.values().next().value as HTMLInputElement | undefined
    first?.focus()

    const close = (): void => {
      backdrop.remove()
      document.removeEventListener('keydown', onKey)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('keydown', onKey)
    cancel.addEventListener('click', close)
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close()
    })

    submit.addEventListener('click', () => {
      void (async () => {
        const api = this.#requireApi()
        const values: Record<string, CellValue> = {}
        for (const [name, input] of inputs) {
          const raw = input.value
          // 留空 = 交给数据库默认值，**不要**写成空字符串——
          // 那会把一个 NULL/默认值的列变成 ''，是真实的数据偏差。
          if (raw === '') continue
          values[name] = { kind: 'text', text: raw }
        }

        submit.disabled = true
        this.#cb.onStatus('正在插入…')
        try {
          // api.insertRow 由主进程提供；接口缺失时给出可读提示而不是崩
          const fn = (api as unknown as {
            insertRow?: (id: string, v: Record<string, CellValue>) => Promise<{ affected: number }>
          }).insertRow
          if (typeof fn !== 'function') {
            throw new Error('insertRow 接口尚未就绪')
          }
          const res = await fn(tableId, values)
          close()
          this.#cb.onStatus(`已插入 ${res.affected} 行（未提交，点「提交」生效）`)
          await this.reload()
          await this.#refreshTransactionState()
        } catch (e) {
          this.#cb.onStatus(`插入失败：${errText(e)}`, true)
        } finally {
          submit.disabled = false
        }
      })()
    })
  }

  /** 删除当前选中的行。用主键值定位，避免误删。 */
  async #deleteSelectedRow(): Promise<void> {
    const desc = this.#desc
    const tableId = this.#tableNodeId()
    if (!desc || !tableId) {
      this.#cb.onStatus('只有表支持删除行', true)
      return
    }
    if (this.#selectedRow < 0) {
      this.#cb.onStatus('请先在网格里点选一行', true)
      return
    }
    if (!desc.hasUniqueKey) {
      this.#cb.onStatus('该表没有唯一键，无法安全删除行', true)
      return
    }

    const row = this.#rowAt(this.#selectedRow)
    if (!row) {
      this.#cb.onStatus('选中的行不在已加载数据里，请滚动或重新加载', true)
      return
    }

    const keyCols = desc.columns
      .filter((c) => c.primaryKeyOrdinal !== null)
      .sort((a, b) => (a.primaryKeyOrdinal ?? 0) - (b.primaryKeyOrdinal ?? 0))
    const keyValues: Record<string, CellValue> = {}
    for (const kc of keyCols) {
      const ci = this.#columns.findIndex((c) => c.name === kc.name)
      if (ci < 0) {
        this.#cb.onStatus(`主键列「${kc.name}」不在结果集中，无法定位行`, true)
        return
      }
      const cell = row.cells[ci]
      if (!cell || cell.kind === 'null') {
        this.#cb.onStatus(`主键列「${kc.name}」为空，无法定位行`, true)
        return
      }
      keyValues[kc.name] = cell
    }

    // 二次确认：删除不可逆，且这是最容易误触的操作
    const keyText = Object.entries(keyValues)
      .map(([k, v]) => `${k}=${v.kind === 'text' ? v.text : v.kind === 'number' ? v.value : '?'}`)
      .join(', ')
    if (!globalThis.confirm(`确定删除这一行？\n\n定位条件：${keyText}\n\n删除后需要点「提交」才会真正生效。`)) {
      return
    }

    try {
      const api = this.#requireApi() as unknown as {
        deleteRows?: (
          id: string,
          keys: readonly Record<string, CellValue>[]
        ) => Promise<{ ok: boolean; affected: number; outcomes: readonly { error: string | null }[] }>
      }
      if (typeof api.deleteRows !== 'function') {
        throw new Error('deleteRows 接口尚未就绪')
      }
      this.#cb.onStatus('正在删除…')
      const res = await api.deleteRows(tableId, [keyValues])
      if (!res.ok) {
        const firstErr = res.outcomes.find((o) => o.error !== null)?.error ?? '未知原因'
        this.#cb.onStatus(`删除失败：${firstErr}`, true)
        return
      }
      this.#selectedRow = -1
      this.#cb.onStatus(`已删除 ${res.affected} 行（未提交，点「提交」生效）`)
      await this.reload()
      await this.#refreshTransactionState()
    } catch (e) {
      this.#cb.onStatus(`删除失败：${errText(e)}`, true)
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
    this.#headerInnerEl.replaceChildren()

    const corner = document.createElement('div')
    corner.className = 'grid-cell grid-rownum'
    corner.setAttribute('role', 'columnheader')
    corner.textContent = '#'
    // 必须放在内层：数据行里的 `#` 行号格是随行一起横滚的，
    // 表头的 `#` 若留在外层就不会跟着滚，横滚后同样会错位。
    this.#headerInnerEl.appendChild(corner)

    for (let i = 0; i < this.#columns.length; i++) {
      const col = this.#columns[i]
      if (!col) continue
      const cell = document.createElement('div')
      cell.className = 'grid-cell grid-col-header'
      cell.setAttribute('role', 'columnheader')
      // 列宽与数据行同源（#colWidths），保证表头和数据永远对齐。
      cell.style.width = `${this.#colWidth(col)}px`
      cell.style.position = 'relative' // 让右边缘拖拽手柄能绝对定位
      cell.title = `${col.name} · ${col.type}（点击排序，拖右边缘调整列宽）`
      if (this.#sorting) cell.classList.add('is-sorting')

      const label = document.createElement('span')
      label.className = 'grid-col-label'
      label.textContent = col.name
      // 排序指示器：▲ 升序 / ▼ 降序。只给当前排序列加。
      if (this.#sort.col === i && this.#sort.dir) {
        const arrow = document.createElement('span')
        arrow.className = 'grid-sort-arrow'
        arrow.textContent = this.#sort.dir === 'asc' ? '▲' : '▼'
        label.appendChild(arrow)
      }
      cell.appendChild(label)

      cell.addEventListener('click', () => {
        if (this.#sorting) return
        void this.#onHeaderSortClick(i)
      })

      // 右边缘拖拽手柄（独立元素，避免与点击排序抢事件）。
      const handle = document.createElement('div')
      handle.className = 'grid-col-resizer'
      handle.title = '拖动调整列宽，双击按内容自适应'
      this.#attachResizer(handle, col, cell)
      cell.appendChild(handle)

      this.#headerInnerEl.appendChild(cell)
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
      // 骨架行：该页还没到。用空白格子占位，保持列宽稳定（用 #colWidths 同一份）。
      for (let c = 0; c < this.#columns.length; c++) {
        const col = this.#columns[c]
        if (!col) continue
        const cell = document.createElement('div')
        cell.className = 'grid-cell is-skeleton'
        cell.style.width = `${this.#colWidth(col)}px`
        cell.setAttribute('role', 'gridcell')
        rowEl.appendChild(cell)
      }
      return rowEl
    }

    for (let c = 0; c < this.#columns.length; c++) {
      const col = this.#columns[c]
      if (!col) continue
      const cell = document.createElement('div')
      cell.className = 'grid-cell'
      // 列宽来自实例状态：与 #renderHeader 同源，保证表头与数据永远对齐。
      cell.style.width = `${this.#colWidth(col)}px`
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
        // 必须一并重绘工具条：**「删除选中行」按钮的可用性取决于是否有选中行**。
        // 只调 #render() 的话按钮会一直保持「无选中→禁用」的旧状态，
        // 用户选了行也点不动删除（这是实测发现的 bug，不是理论问题）。
        this.#renderEditToolbar()
        this.#viewportEl.focus()
      })
      cell.addEventListener('dblclick', () => {
        if (this.#root.dataset['editable'] !== 'true') return
        this.#beginCellEdit(cell, rowIndex, c, value)
      })
      // 右键：先选中该格，再弹出菜单（否则菜单操作的是上一次选中的格子）。
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        this.#selectedRow = rowIndex
        this.#selectedCol = c
        this.#render()
        this.#showContextMenu(e.clientX, e.clientY)
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
    // 复制快捷键优先于导航：Ctrl/Cmd+C 复制单元格，加 Shift 复制整行。
    const mod = e.ctrlKey || e.metaKey
    if (mod && (e.key === 'c' || e.key === 'C')) {
      if (this.#selectedRow >= 0) {
        e.preventDefault()
        if (e.shiftKey) this.#copyRow(this.#selectedRow)
        else if (this.#selectedCol >= 0) this.#copyCell(this.#selectedRow, this.#selectedCol)
      }
      return
    }

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
    this.#menuEl.remove()
    this.#modalEl.remove()
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

// ---------------------------------------------------------------------------
// 纯函数（可被 /tmp 静态自检直接 import 断言）
// ---------------------------------------------------------------------------

/**
 * 三态排序循环：无 → 升序 → 降序 → 无。
 *
 * 抽成纯函数是为了让自检能直接验证状态机，而不必启动 UI。
 * 点击**另一列**时从升序重新开始（不能把上一列的 dir 带过来）。
 */
export function nextSortState(prev: { col: number; dir: 'asc' | 'desc' | null }, col: number): {
  col: number
  dir: 'asc' | 'desc' | null
} {
  if (prev.col !== col) return { col, dir: 'asc' }
  if (prev.dir === null) return { col, dir: 'asc' }
  if (prev.dir === 'asc') return { col, dir: 'desc' }
  return { col: -1, dir: null }
}

/**
 * CSV 字段转义（RFC 4180）。
 *
 * 规则：字段含逗号、双引号、CR 或 LF 时，整体用双引号包裹，且内部双引号
 * 翻倍。不含这些字符时原样输出（避免给所有字段都加引号，那样文件又大又难读）。
 *
 * 为什么必须严格：一个含逗号的值没加引号，会让整行列数错位——导入方
 * （Excel/pandas）会把它拆成两列，数据静默错位，比报错更难发现。
 */
export function csvEscape(value: string): string {
  const s = value ?? ''
  if (s === '') return ''
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

/** 单元格 → CSV 文本。NULL 用空串（CSV 里没有 NULL 概念）。 */
function cellToCsvText(cell: CellValue): string {
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

/** 单元格 → 剪贴板文本。NULL 复制成空字符串（Excel 里 NULL 往往就是空）。 */
function cellToClipboardText(cell: CellValue): string {
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

/** 用于「自适应列宽」的显示长度估算（BLOB 按占位符长度算）。 */
function cellDisplayLength(cell: CellValue): number {
  switch (cell.kind) {
    case 'null':
      return 4
    case 'number':
      return String(cell.value).length
    case 'boolean':
      return cell.value ? 4 : 5
    case 'text':
      return cell.text.length
    case 'blob':
      return 24
    default:
      return 0
  }
}

/**
 * 从方言列表里挑出引号规则。
 *
 * 保守策略：只有在**唯一确定**时才返回规则——
 *   - 列表里只有一个方言 → 用它；
 *   - 多个方言但 quoting 完全一致 → 用它们（规则相同，选谁都一样）；
 *   - 规则不一致且无上下文能确定当前连接用哪个 → 返回 null。
 *
 * 为什么这么保守：引号规则猜错，要么 SQL 语法错误，要么把列名当关键字。
 * 任务书要求「宁可显示无法排序，也不要拼接未转义的列名」。本网格 `#source`
 * 里没有 dialectId（只有连接作用域 id），多方言且规则不一时无法可靠判断，
 * 这时就放弃排序并提示。
 */
export function pickQuotingRules(dialects: readonly { quoting: QuotingRules }[]): QuotingRules | null {
  if (dialects.length === 0) return null
  const first = dialects[0]?.quoting
  if (!first) return null
  for (const d of dialects) {
    const q = d.quoting
    if (!q || q.open !== first.open || q.close !== first.close || q.escape !== first.escape) {
      return null
    }
  }
  return first
}

/**
 * 按 QuotingRules 转义标识符。与 core/driver.ts 的 `quoteIdentifierWith` 同义，
 * 此处内联一份是为了让 grid.ts 对 driver 模块只保留类型依赖（不引入运行时耦合）。
 */
export function quoteIdentifier(name: string, rules: QuotingRules): string {
  const escaped =
    rules.escape === 'double'
      ? name.split(rules.close).join(rules.close + rules.close)
      : name.split('\\').join('\\\\').split(rules.close).join('\\' + rules.close)
  return rules.open + escaped + rules.close
}

/** 导出文件名带时间戳：`dbstudio-2026-10-22T01-25-30-000Z.csv`（`:/.` 替换为 `-`）。 */
export function buildCsvFileName(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, '-')
  return `dbstudio-${iso}.csv`
}
