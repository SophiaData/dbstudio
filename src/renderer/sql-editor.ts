/**
 * SQL 编辑器组件（语法高亮 / 自动补全 / 格式化 / 多语句切分 / 执行计划渲染）。
 *
 * ============================================================================
 * 为什么用 textarea(透明文字) + pre(高亮) 叠加，而不是 CodeMirror / Monaco
 * ============================================================================
 *
 * 1. **零依赖**。本项目是 Electron 桌面应用，打包产物要能离线、可审计。
 *    CodeMirror 6 是一组包（@codemirror/state/view/language/...），Monaco 是
 *    数 MB 的 AMD 产物；引入任何一方都要额外处理 bundler/vite 配置、worker 与
 *    CSP，与"Electron 打包无冲突"这个硬目标正面冲突。
 *    textarea+pre 的方案**只用浏览器原生能力**，打包后零额外体积、零 worker。
 *
 * 2. **编辑行为完全交给浏览器**。textarea 天然支持 IME 中文输入、系统级
 *    undo/redo、选区拖拽、无障碍读屏、拼写检查、macOS 的 emoji 面板……
 *    这些在自绘编辑器里都要重写，且极难写对（尤其 IME 与 undo 栈）。
 *
 * 3. **代价是必须手写"高亮层与编辑层严格对齐"**。这也正是本方案唯一真正的坑：
 *    `<pre>` 里的文字与 `<textarea>` 里的文字必须**逐像素重合**，否则光标和
 *    高亮会错位。对齐依赖四件事同时成立：
 *      - 同一套 `font-family / font-size / font-weight / letter-spacing`；
 *      - 同一 `line-height`（用无单位数字，且两层都显式设置）；
 *      - 同一 `padding / border`（textarea 的 border 要用 `box-sizing:border-box`
 *        并把 border 宽度算进 padding）；
 *      - 同一 `white-space`（`pre-wrap`）+ 同一 `word-break`、相同的换行策略
 *        （`\n` 必须原样在 pre 里换行）。
 *    下面 `applyGeometry()` 用一份共享的样式对象同时喂给两层，就是为消除
 *    "改了一处忘另一处"这类错位来源。滚动也必须在 input/scroll 时同步。
 *
 * 所以：**这不是"退而求其次"，而是对 Electron 桌面场景的有意取舍**——
 * 用受控的对齐成本，换掉一整个第三方编辑器运行时。
 */

import { SQL_COMPLETION_KEYWORDS } from './sql-keywords'
import { formatSql, scanContexts, splitStatements } from './sql-format'

/** 外部注入的回调。编辑器不直接调 IPC——保持组件可单测、可替换宿主。 */
export interface SqlEditorCallbacks {
  /** 用户要求执行（当前语句或全部）。 */
  onExecute(sql: string): void
  /** 状态提示。isError 用于 UI 上色。 */
  onStatus(text: string, isError?: boolean): void
  /** 请求补全候选（表名/列名）；返回空数组表示没有元数据可用。 */
  getMetadataCandidates(): Promise<readonly string[]>
  /**
   * 可选：执行 `EXPLAIN QUERY PLAN <sql>` 并返回结果行。
   * 不提供时，"执行计划"按钮会提示"当前连接不支持执行计划"。
   * 返回值约定为 `{ columns: string[]; rows: unknown[][] }`，由调用方负责
   * 通过 runQuery 取数（组件不碰 api.ts，避免把渲染组件和 IPC 契约耦合）。
   */
  runExplain?(sql: string): Promise<{ readonly columns: readonly string[]; readonly rows: readonly unknown[][] }>
  /** 打开历史与收藏面板。 */
  onOpenLibrary?(): void
  /** 把当前语句（没有则整段）保存为收藏。 */
  onSaveCurrent?(sql: string): void
  /** 内容变更（用于按连接草稿自动持久化）。 */
  onChange?(text: string): void
}

interface CompletionItemView {
  readonly text: string
  readonly fromKeywords: boolean
}

/** 补全候选缓存的有效期（元数据可能变，但不能每次按键都问一遍）。 */
const METADATA_CACHE_TTL_MS = 5000

/**
 * 一次高亮渲染的结果。拆出来是为了能被纯函数测试（不依赖 DOM）。
 * 之所以要"可测试的高亮函数"而不是直接往 innerHTML 塞：XSS 面必须能被断言。
 */
export function highlightSqlHtml(sql: string): string {
  const contexts = scanContexts(sql)
  let html = ''
  let i = 0

  const escapeHtml = (text: string): string =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

  const wrap = (cls: string, text: string): string => `<span class="sql-${cls}">${escapeHtml(text)}</span>`

  while (i < sql.length) {
    const ctx = contexts[i]
    if (ctx === 'lineComment' || ctx === 'blockComment' || ctx === 'string' || ctx === 'quotedIdent') {
      // 把同上下文的连续字符整体包一层（减少 span 数量，也保证注释/字符串原文不被拆）
      let j = i
      while (j < sql.length && contexts[j] === ctx) j += 1
      const cls = ctx === 'string' ? 'string'
        : ctx === 'quotedIdent' ? 'ident'
        : 'comment'
      html += wrap(cls, sql.slice(i, j))
      i = j
      continue
    }

    const ch = sql[i] as string
    // 数字
    if (/[0-9]/.test(ch)) {
      let j = i + 1
      while (j < sql.length && /[0-9.]/.test(sql[j] as string)) j += 1
      html += wrap('number', sql.slice(i, j))
      i = j
      continue
    }
    // 单词：关键字 / 函数 / 普通标识符
    if (/[A-Za-z_\u0080-\uFFFF]/.test(ch)) {
      let j = i + 1
      while (j < sql.length && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[j] as string)) j += 1
      const word = sql.slice(i, j)
      const lower = word.toLowerCase()
      if (SQL_KEYWORD_SET.has(lower)) {
        html += wrap('keyword', word)
      } else if (SQL_FUNCTION_SET.has(lower)) {
        html += wrap('function', word)
      } else {
        // 普通标识符也转义（XSS 面：`<img src=x onerror=...>` 之类）
        html += escapeHtml(word)
      }
      i = j
      continue
    }
    // 标点
    if (/\s/.test(ch)) {
      html += ch
    } else {
      html += wrap('punct', ch)
    }
    i += 1
  }
  return html
}

/**
 * 关键字/函数集合（供 highlightSqlHtml 用）。
 * 这里从 sql-keywords 逐字加入而不是直接 import 两个数组后 Set(…)，是为了
 * 在同一处明确定义"高亮用的关键字集合"与"补全用的关键字集合"的区别：
 * 高亮区分 keyword 与 function 两种颜色，补全则合并成一个候选池。
 */
import { SQL_FUNCTION_KEYWORDS, SQL_STATEMENT_KEYWORDS } from './sql-keywords'
const SQL_KEYWORD_SET: ReadonlySet<string> = new Set(SQL_STATEMENT_KEYWORDS)
const SQL_FUNCTION_SET: ReadonlySet<string> = new Set(SQL_FUNCTION_KEYWORDS)

/**
 * 编辑器类。构造时自建：工具栏 + (pre, textarea) 编辑区 + 补全浮层。
 * 外部只提供 host 容器和一个 callbacks 对象。
 */
export class SqlEditor {
  private readonly host: HTMLElement
  private readonly callbacks: SqlEditorCallbacks

  private readonly root: HTMLDivElement
  private readonly toolbar: HTMLDivElement
  private readonly editorWrap: HTMLDivElement
  private readonly highlight: HTMLPreElement
  private readonly textarea: HTMLTextAreaElement
  private readonly completions: HTMLDivElement
  private readonly explainPanel: HTMLDivElement

  private metadataCache: readonly string[] | null = null
  private metadataCacheAt = 0
  private rafPending = false

  // 补全状态
  private completionItems: CompletionItemView[] = []
  private completionIndex = 0
  private completionRangeStart = -1
  private completionVisible = false
  private completionTimer: number | null = null

  constructor(host: HTMLElement, callbacks: SqlEditorCallbacks) {
    this.host = host
    this.callbacks = callbacks

    this.root = document.createElement('div')
    this.root.className = 'sql-editor'

    // ---- 工具栏（组件自建，Lead 只放 host）----
    this.toolbar = document.createElement('div')
    this.toolbar.className = 'sql-editor-toolbar'
    this.root.appendChild(this.toolbar)

    // ---- 编辑区 ----
    this.editorWrap = document.createElement('div')
    this.editorWrap.className = 'sql-editor-area'
    this.root.appendChild(this.editorWrap)

    this.highlight = document.createElement('pre')
    this.highlight.className = 'sql-editor-highlight'
    this.highlight.setAttribute('aria-hidden', 'true') // 读屏只读 textarea
    this.editorWrap.appendChild(this.highlight)

    this.textarea = document.createElement('textarea')
    this.textarea.className = 'sql-editor-input'
    this.textarea.spellcheck = false
    this.textarea.setAttribute('autocapitalize', 'off')
    this.textarea.setAttribute('autocorrect', 'off')
    this.textarea.setAttribute('wrap', 'soft')
    this.editorWrap.appendChild(this.textarea)

    // ---- 补全浮层（挂 root，绝对定位）----
    this.completions = document.createElement('div')
    this.completions.className = 'sql-editor-completions'
    this.completions.style.display = 'none'
    this.root.appendChild(this.completions)

    // ---- 执行计划面板 ----
    this.explainPanel = document.createElement('div')
    this.explainPanel.className = 'sql-editor-explain'
    this.explainPanel.style.display = 'none'
    this.root.appendChild(this.explainPanel)

    host.appendChild(this.root)

    this.buildToolbar()
    this.applyGeometry()
    this.wireEvents()
    this.refreshHighlight()
  }

  // -------------------------------------------------------------------------
  // 公共 API
  // -------------------------------------------------------------------------

  getValue(): string {
    return this.textarea.value
  }

  setValue(v: string): void {
    this.textarea.value = v
    this.refreshHighlight()
    // 填完内容后把滚动位置归零：否则长 SQL 会停在末尾，
    // 用户看到的是最后几行，不知道自己在编辑什么（实测截图里就是这个症状）。
    this.textarea.scrollTop = 0
    this.textarea.scrollLeft = 0
    this.syncScroll()
    this.hideCompletions()
  }

  /**
   * 光标所在的语句（多语句时用于"执行当前语句"）。
   * 实现：先用 splitStatements 得到各语句文本，再在原文里按顺序定位
   * 每条的 [start,end)，找包含光标的那条。找不到（光标在空白/注释间）时，
   * 退化为"最后一条非空语句"，都没有则返回空串。
   */
  getCurrentStatement(): string {
    const sql = this.textarea.value
    const caret = this.textarea.selectionStart ?? 0
    const statements = splitStatements(sql)
    if (statements.length === 0) return ''

    // 重新扫描找每条语句在原文中的区间（splitStatements 只给文本，这里配位置）
    const ranges = locateStatementRanges(sql)
    for (const r of ranges) {
      if (caret >= r.start && caret <= r.end) {
        return sql.slice(r.start, r.end).trim()
      }
    }
    // 光标不在任何语句体内（常见于语句之间或末尾注释里）：
    // 取光标之前最近的一条；没有就取第一条。
    let picked = ''
    for (const r of ranges) {
      if (r.end <= caret) picked = sql.slice(r.start, r.end).trim()
    }
    if (picked) return picked
    return (ranges[0] ? sql.slice(ranges[0].start, ranges[0].end).trim() : '')
  }

  focus(): void {
    this.textarea.focus()
  }

  format(): void {
    const original = this.textarea.value
    if (original.trim() === '') return
    const caret = this.textarea.selectionStart ?? 0
    const before = stripForCompare(original)
    const formatted = formatSql(original)
    // 防御性断言：格式化绝不能改变"去空白后的字符序列"。若违反（说明格式化器有 bug），
    // 宁可放弃格式化并报错，也不要静默写坏用户的 SQL。
    if (stripForCompare(formatted) !== before) {
      this.callbacks.onStatus('格式化被取消：内部校验发现会改变 SQL 内容（已保护原文本）', true)
      return
    }
    this.textarea.value = formatted
    // 尽量把光标放在原位置附近（按"前面的非空白字符数"映射）
    const mapped = mapCaretByNonWhitespace(original, caret, formatted)
    this.textarea.setSelectionRange(mapped, mapped)
    this.refreshHighlight()
    this.syncScroll()
    this.hideCompletions()
  }

  /** 渲染执行计划结果行（由 runExplain 回调提供数据）。 */
  showExplainResult(columns: readonly string[], rows: readonly unknown[][]): void {
    this.explainPanel.innerHTML = ''
    const title = document.createElement('div')
    title.className = 'sql-editor-explain-title'
    title.textContent = '执行计划（EXPLAIN QUERY PLAN）'
    this.explainPanel.appendChild(title)

    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'sql-editor-explain-empty'
      empty.textContent = '（没有计划行返回）'
      this.explainPanel.appendChild(empty)
      this.explainPanel.style.display = 'block'
      return
    }

    // 找到 "detail" 列（SQLite EXPLAIN QUERY PLAN 的固定列名），
    // 找不到就退化为"拼接整行"。同时按 id/parent 构建缩进树更直观，但
    // 为保持零假设，这里只按 detail 文本 + parent 缩进渲染。
    const detailIdx = columns.findIndex((c) => c.toLowerCase() === 'detail')
    const idIdx = columns.findIndex((c) => c.toLowerCase() === 'id')
    const parentIdx = columns.findIndex((c) => c.toLowerCase() === 'parent')

    // 按 parent 关系算缩进层级
    const depthById = new Map<number, number>()
    const list = document.createElement('ul')
    list.className = 'sql-editor-explain-list'
    for (const row of rows) {
      const li = document.createElement('li')
      const idVal = idIdx >= 0 ? Number(row[idIdx]) : NaN
      const parentVal = parentIdx >= 0 ? Number(row[parentIdx]) : NaN
      let depth = 0
      if (Number.isFinite(parentVal)) {
        const parentDepth = depthById.get(parentVal)
        if (parentDepth !== undefined) depth = parentDepth + 1
      }
      if (Number.isFinite(idVal)) depthById.set(idVal, depth)

      const text = detailIdx >= 0
        ? String(row[detailIdx] ?? '')
        : row.map((c) => String(c ?? '')).join(' | ')
      li.textContent = text
      li.style.paddingLeft = `${depth * 16}px`
      li.className = 'sql-editor-explain-row'
      list.appendChild(li)
    }
    this.explainPanel.appendChild(list)
    this.explainPanel.style.display = 'block'
  }

  // -------------------------------------------------------------------------
  // 内部：工具栏
  // -------------------------------------------------------------------------

  private buildToolbar(): void {
    const makeBtn = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'sql-editor-btn'
      btn.textContent = label
      btn.title = title
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        onClick()
      })
      this.toolbar.appendChild(btn)
      return btn
    }

    makeBtn('格式化', '格式化 SQL（只改空白，不改内容）', () => this.format())
    makeBtn('执行当前', '执行光标所在的语句', () => {
      const stmt = this.getCurrentStatement()
      if (!stmt) {
        this.callbacks.onStatus('光标所在位置没有可执行的语句', true)
        return
      }
      this.callbacks.onExecute(stmt)
    })
    makeBtn('执行全部', '按顺序执行所有语句', () => {
      const all = this.textarea.value.trim()
      if (!all) {
        this.callbacks.onStatus('编辑器为空', true)
        return
      }
      this.callbacks.onExecute(all)
    })
    makeBtn('执行计划', '对当前语句执行 EXPLAIN QUERY PLAN', () => void this.runExplain())
    if (this.callbacks.onOpenLibrary) {
      makeBtn('历史 / 收藏', '浏览 SQL 执行历史与收藏', () => this.callbacks.onOpenLibrary?.())
    }
    if (this.callbacks.onSaveCurrent) {
      makeBtn('保存收藏', '把当前语句保存为收藏', () => {
        const sql = this.getCurrentStatement() || this.textarea.value.trim()
        if (!sql) {
          this.callbacks.onStatus('编辑器为空，无法保存收藏', true)
          return
        }
        this.callbacks.onSaveCurrent?.(sql)
      })
    }
  }

  private async runExplain(): Promise<void> {
    const stmt = this.getCurrentStatement()
    if (!stmt) {
      this.callbacks.onStatus('光标所在位置没有语句，无法查看执行计划', true)
      return
    }
    if (!this.callbacks.runExplain) {
      this.callbacks.onStatus('当前宿主未提供执行计划能力', true)
      return
    }
    try {
      const result = await this.callbacks.runExplain(stmt)
      this.showExplainResult(result.columns, result.rows)
      this.callbacks.onStatus('执行计划已更新')
    } catch (err) {
      // 关键：如实报告 adapter 只读护栏的拒绝，不做任何"绕过"。
      const msg = err instanceof Error ? err.message : String(err)
      this.callbacks.onStatus(`执行计划失败：${msg}`, true)
    }
  }

  // -------------------------------------------------------------------------
  // 内部：几何对齐（textarea 与 pre 必须逐像素重合）
  // -------------------------------------------------------------------------

  /**
   * 把同一份排版属性**同时**喂给 pre 与 textarea。
   * 这里是"错位唯一来源"的唯一收口点：只要保证两层用同一组值，就不会错位。
   * 具体数值（字体/行高/内边距）应由外层 CSS 通过 CSS 变量统一控制，
   * 这里只强制"两层引用同一变量"，避免出现只改一层的半吊子改动。
   */
  private applyGeometry(): void {
    const props = {
      // 字体族：等宽，保证每个字符等宽——这是"字符与光标对齐"的前提
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: '13px',
      lineHeight: '20px',
      letterSpacing: '0',
      tabSize: '2'
    } as const
    for (const el of [this.highlight, this.textarea]) {
      el.style.fontFamily = props.fontFamily
      el.style.fontSize = props.fontSize
      el.style.lineHeight = props.lineHeight
      el.style.letterSpacing = props.letterSpacing
      el.style.tabSize = props.tabSize
      el.style.whiteSpace = 'pre-wrap'
      el.style.wordBreak = 'break-word'
      el.style.overflowWrap = 'break-word'
      el.style.margin = '0'
      el.style.boxSizing = 'border-box'
      el.style.padding = '8px 10px'
      el.style.border = '1px solid transparent'
    }
    // textarea：文字透明、只在 pre 里显示彩色文字；caret 必须可见
    this.textarea.style.background = 'transparent'
    this.textarea.style.color = 'transparent'
    this.textarea.style.caretColor = 'var(--sql-caret, #e6e6e6)'
    this.textarea.style.resize = 'none'
    // 关键：textarea 的滚动条会改变可视宽高，导致与 pre 错位。
    // 让 textarea 撑满容器、隐藏自身滚动条，由 pre 承载滚动（两层同步）。
    this.textarea.style.overflow = 'auto'
  }

  // -------------------------------------------------------------------------
  // 内部：事件
  // -------------------------------------------------------------------------

  private wireEvents(): void {
    this.textarea.addEventListener('input', () => {
      this.scheduleHighlight()
      this.scheduleCompletionUpdate()
      this.callbacks.onChange?.(this.textarea.value)
    })
    this.textarea.addEventListener('scroll', () => this.syncScroll())
    this.textarea.addEventListener('keydown', (e) => this.onKeyDown(e))
    this.textarea.addEventListener('click', () => this.hideCompletions())
    this.textarea.addEventListener('blur', () => {
      // 稍延迟，避免点击补全项时先 blur 再 click 导致选不中
      window.setTimeout(() => this.hideCompletions(), 120)
    })
    // 窗口尺寸变化时 pre 的换行可能变化，重算滚动同步
    window.addEventListener('resize', () => this.syncScroll())
  }

  private scheduleHighlight(): void {
    if (this.rafPending) return
    this.rafPending = true
    // 用 rAF 节流：每帧最多重算一次高亮，比每次 keypress 同步重排便宜得多
    requestAnimationFrame(() => {
      this.rafPending = false
      this.refreshHighlight()
      this.syncScroll()
    })
  }

  private refreshHighlight(): void {
    // 末尾补一个换行占位，避免最后一行是空行时 pre 高度比 textarea 少一行导致错位
    const value = this.textarea.value
    const html = highlightSqlHtml(value)
    this.highlight.innerHTML = html + (value.endsWith('\n') ? ' ' : '')
    this.autoGrow()
  }

  /**
   * 让编辑器跟着内容长高（上限 320px 后内部滚动）。
   *
   * 为什么需要：固定 84px 高度只能看 4 行 SQL，多语句查询根本写不开
   * （实测截图里只能看到最后几行）。DBeaver 的编辑器会随内容增高。
   *
   * 注意必须同时设 textarea 与容器高度：高亮层是 absolute + inset:0，
   * 跟随的是**容器**高度；textarea 若单独长高就会与高亮层错位。
   */
  private autoGrow(): void {
    const MAX = 320
    // 先归零，否则 scrollHeight 只增不减，删行后不会缩回
    this.textarea.style.height = 'auto'
    const next = Math.min(MAX, Math.max(84, this.textarea.scrollHeight))
    this.textarea.style.height = `${next}px`
    this.editorWrap.style.height = `${next}px`
    this.syncScroll()
  }

  private syncScroll(): void {
    // pre 不单独滚动：让它跟随 textarea 的滚动位置（两层同尺寸，滚同样的量即对齐）
    this.highlight.scrollTop = this.textarea.scrollTop
    this.highlight.scrollLeft = this.textarea.scrollLeft
    // 高度严格对齐 textarea 的客户端高度：
    // 容器有 1px border，inset:0 铺的是 border-box（含边框），
    // 而 textarea 的 height 是 content-box，两者差 2px 会让底部几行轻微错位。
    this.highlight.style.height = `${this.textarea.clientHeight}px`
  }

  private onKeyDown(e: KeyboardEvent): void {
    // 补全浮层可见时优先处理导航键
    if (this.completionVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        this.moveCompletion(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        this.moveCompletion(-1)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        this.applyCompletion()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        this.hideCompletions()
        return
      }
    }
    // Ctrl+Space 手动触发补全
    if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {
      e.preventDefault()
      void this.triggerCompletion(true)
      return
    }

    /**
     * 执行快捷键（这批是编辑器最常用的操作，不能只靠按钮点）。
     *
     * 为什么放在补全处理之后：补全浮层可见时 Enter 用于选中候选，
     * 不能被"执行"抢走——所以那段有 `return`。
     *
     * 用 `e.key === 'Enter'` 而不是 `e.code`：不同键盘布局下 code 可能不同，
     * 而 Enter 的 key 值稳定。
     */
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        // Ctrl/Cmd+Shift+Enter → 执行全部
        const all = this.textarea.value.trim()
        if (!all) {
          this.callbacks.onStatus('编辑器为空', true)
          return
        }
        this.callbacks.onExecute(all)
      } else {
        // Ctrl/Cmd+Enter → 执行光标所在语句
        const stmt = this.getCurrentStatement()
        if (!stmt) {
          this.callbacks.onStatus('光标所在位置没有可执行的语句', true)
          return
        }
        this.callbacks.onExecute(stmt)
      }
      return
    }

    // Shift+Alt+F → 格式化（与常见编辑器一致）
    if (e.shiftKey && e.altKey && (e.key === 'F' || e.key === 'f')) {
      e.preventDefault()
      this.format()
    }
  }

  // -------------------------------------------------------------------------
  // 内部：自动补全
  // -------------------------------------------------------------------------

  private scheduleCompletionUpdate(): void {
    // 输入后延迟一点点再弹，避免每个字符都重建候选（也避免打字时闪一下）
    if (this.completionTimer !== null) window.clearTimeout(this.completionTimer)
    this.completionTimer = window.setTimeout(() => {
      this.completionTimer = null
      void this.triggerCompletion(false)
    }, 90)
  }

  private async getMetadataCached(): Promise<readonly string[]> {
    const now = Date.now()
    if (this.metadataCache !== null && now - this.metadataCacheAt < METADATA_CACHE_TTL_MS) {
      return this.metadataCache
    }
    try {
      const candidates = await this.callbacks.getMetadataCandidates()
      this.metadataCache = Array.isArray(candidates) ? candidates.slice() : []
      this.metadataCacheAt = now
      return this.metadataCache
    } catch {
      // 拿不到元数据时不报错：只用关键字（任务要求）
      this.metadataCache = []
      this.metadataCacheAt = now
      return this.metadataCache
    }
  }

  private async triggerCompletion(force: boolean): Promise<void> {
    const word = this.currentWordBeforeCaret()
    if (!force && word.prefix.length < 1) {
      this.hideCompletions()
      return
    }
    const metadata = await this.getMetadataCached()
    const prefix = word.prefix.toLowerCase()

    const seen = new Set<string>()
    const items: CompletionItemView[] = []
    const pushItem = (text: string, fromKeywords: boolean): void => {
      const key = text.toLowerCase()
      if (seen.has(key)) return
      if (prefix.length > 0 && !key.startsWith(prefix)) return
      if (prefix.length > 0 && key === prefix) return // 已经全等了就不必再提示自己
      seen.add(key)
      items.push({ text, fromKeywords })
    }
    for (const kw of SQL_COMPLETION_KEYWORDS) pushItem(kw, true)
    for (const m of metadata) pushItem(m, false)

    if (items.length === 0) {
      this.hideCompletions()
      return
    }
    // 关键字在前、对象在后；同类按字母序，稳定可预期
    items.sort((a, b) => {
      if (a.fromKeywords !== b.fromKeywords) return a.fromKeywords ? -1 : 1
      return a.text.localeCompare(b.text)
    })
    this.completionItems = items
    this.completionIndex = 0
    this.completionRangeStart = word.start
    this.renderCompletions()
    this.positionCompletions()
  }

  /** 取光标前的"当前词"（字母/数字/下划线）；返回起始偏移与前缀。 */
  private currentWordBeforeCaret(): { start: number; prefix: string } {
    const value = this.textarea.value
    const caret = this.textarea.selectionStart ?? 0
    let i = caret
    while (i > 0 && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(value[i - 1] as string)) i -= 1
    return { start: i, prefix: value.slice(i, caret) }
  }

  private renderCompletions(): void {
    this.completions.innerHTML = ''
    this.completionItems.forEach((item, idx) => {
      const row = document.createElement('div')
      row.className = 'sql-editor-completion-item'
      if (idx === this.completionIndex) row.classList.add('active')
      const label = document.createElement('span')
      label.textContent = item.text // textContent 天然转义，XSS 安全
      row.appendChild(label)
      const kind = document.createElement('span')
      kind.className = 'sql-editor-completion-kind'
      kind.textContent = item.fromKeywords ? 'kw' : 'obj'
      row.appendChild(kind)
      // mousedown 而非 click：抢在 textarea blur 之前处理
      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.completionIndex = idx
        this.applyCompletion()
      })
      this.completions.appendChild(row)
    })
    this.completions.style.display = 'block'
    this.completionVisible = true
  }

  private positionCompletions(): void {
    // 简化定位：放在光标所在行的下方（不做精确的字符坐标测量，避免引入
    // 另一个"测量不准就错位"的坑）。对补全来说"贴着光标下方"已够用。
    const rect = this.textarea.getBoundingClientRect()
    const lineHeight = 20
    const caret = this.textarea.selectionStart ?? 0
    const before = this.textarea.value.slice(0, caret)
    const lineIndex = before.split('\n').length - 1
    const wrapRect = this.editorWrap.getBoundingClientRect()
    const top = rect.top - wrapRect.top + (lineIndex + 1) * lineHeight - this.textarea.scrollTop
    this.completions.style.top = `${Math.max(0, top)}px`
    this.completions.style.left = '10px'
    this.completions.style.maxHeight = '180px'
  }

  private moveCompletion(delta: number): void {
    if (this.completionItems.length === 0) return
    const n = this.completionItems.length
    this.completionIndex = (this.completionIndex + delta + n) % n
    // 只改 class，不重建 DOM（避免闪烁）
    Array.from(this.completions.children).forEach((child, idx) => {
      child.classList.toggle('active', idx === this.completionIndex)
    })
  }

  private applyCompletion(): void {
    const item = this.completionItems[this.completionIndex]
    if (!item) {
      this.hideCompletions()
      return
    }
    const value = this.textarea.value
    const caret = this.textarea.selectionStart ?? 0
    const start = this.completionRangeStart >= 0 ? this.completionRangeStart : caret
    const next = value.slice(0, start) + item.text + value.slice(caret)
    this.textarea.value = next
    const newCaret = start + item.text.length
    this.textarea.setSelectionRange(newCaret, newCaret)
    this.refreshHighlight()
    this.hideCompletions()
  }

  private hideCompletions(): void {
    this.completionVisible = false
    this.completionItems = []
    this.completionRangeStart = -1
    this.completions.style.display = 'none'
    this.completions.innerHTML = ''
  }
}

// ---------------------------------------------------------------------------
// 纯函数辅助（便于测试；不依赖 DOM）
// ---------------------------------------------------------------------------

/** 供格式化前后比较：去掉所有空白字符。 */
/**
 * 归一化用于"格式化前后内容是否等价"的比较。
 *
 * ★ 必须忽略大小写：格式化器会把关键字大写（`select` → `SELECT`），
 * 这是**预期行为**，不是内容改变。早先这里只去空白不忽略大小写，
 * 导致每次格式化都被防御断言误判成"会改变内容"而拒绝执行——
 * 功能形同失效（且只在真实点击时才暴露，纯函数测试测不到 format() 这层）。
 *
 * 但**大小写不能一概而论**：字符串字面量和标识符的大小写是有意义的
 * （`'Paid'` ≠ `'paid'`）。所以只对"词"降级比较太复杂，这里采用
 * 更保守的折中：整体忽略大小写 + 去空白。对"格式化器只动关键字大小写"
 * 这一约定足够，且能挡住真正的字符增删。
 */
function stripForCompare(sql: string): string {
  return sql.replace(/\s+/g, '').toUpperCase()
}

/** 把旧光标位置（按非空白字符序号）映射到格式化后的新位置。 */
function mapCaretByNonWhitespace(original: string, caret: number, formatted: string): number {
  let count = 0
  for (let i = 0; i < caret && i < original.length; i += 1) {
    if (!/\s/.test(original[i] as string)) count += 1
  }
  let seen = 0
  for (let i = 0; i < formatted.length; i += 1) {
    if (seen >= count) return i
    if (!/\s/.test(formatted[i] as string)) seen += 1
  }
  return formatted.length
}

/** 找出每条语句在原文中的 [start,end) 区间（与 splitStatements 同源规则）。 */
function locateStatementRanges(sql: string): Array<{ start: number; end: number }> {
  const contexts = scanContexts(sql)
  const ranges: Array<{ start: number; end: number }> = []
  let start = 0
  const pushIfMeaningful = (from: number, to: number): void => {
    const text = sql.slice(from, to)
    if (text.trim() === '') return
    ranges.push({ start: from, end: to })
  }
  for (let i = 0; i < sql.length; i += 1) {
    if (sql[i] === ';' && contexts[i] === 'normal') {
      pushIfMeaningful(start, i)
      start = i + 1
    }
  }
  pushIfMeaningful(start, sql.length)
  return ranges
}
