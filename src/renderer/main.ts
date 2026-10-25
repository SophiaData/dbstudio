/**
 * 渲染进程入口：把树、详情面板、新建连接对话框接线起来。
 *
 * 这里刻意保持「薄」——所有数据都来自 `window.dbstudio`（preload 白名单），
 * 渲染进程自己**不知道** SQLite 长什么样，也不知道驱动跑在哪个进程。
 * 这条边界就是剖析报告里「model 层无 UI / ui 层无数据库知识」在 Web 侧的对等物。
 */

import { NodeId, type ConnectionSummary, type DbStudioApi } from '../core/api'
import type { ConnectionConfig } from '../core/dialect'
import type {
  ConnectionTestCheck,
  TestConnectionResult,
  DialectField,
  DialectInfo,
  SecretMap,
  SshHostKeyCheck
} from '../core/driver'
import type { ObjectRef, TableDescription } from '../core/model'
import { MetadataTree } from './tree'
import { ResultTabs, type ActiveTabContext } from './tabs'
import { SqlEditor } from './sql-editor'
import { extractKeyValues, resolveKeyColumnIndex, encodeRowKey } from './grid'
import { SqlLibraryPanel } from './sql-library'
import { splitStatements } from './sql-format'
// E1-C 追加：ER 图渲染 + 多格式导出纯函数 + 筛选条件解析。
import { renderErDiagram } from './er-diagram'
import {
  toCsv,
  toJson,
  toInsertSql,
  toMarkdown,
  buildExportFileName,
  type ExportColumn,
  type ExportRow
} from './export-formats'
import { pickQuotingRules, quoteIdentifier } from './grid'
import type { QuotingRules } from '../core/driver'
import { parseFilter, buildFilteredSql, describeFilterError } from './filter-sql'
import { guardAllTransactions, runConnectionOperation } from './transaction-controller'

declare global {
  interface Window {
    dbstudio?: DbStudioApi
    /**
     * 主进程在退出前调用它，询问渲染进程「还有未提交的改动吗」。
     *
     * 为什么由渲染进程回答：事务的**未应用编辑**只存在于网格实例里
     * （`#dirty`），主进程看不到；只有渲染进程知道用户还改了哪些格子。
     * 而已应用但未提交的数据库事务主进程知道（它握着驱动宿主）。
     * 两边合起来才能回答「现在退出安全吗」。
     *
     * 返回 true 表示可以安全退出；false 表示用户选择取消。
     */
    dbstudioGuardTransactions?: (action: string) => Promise<boolean>
  }
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`页面缺少必需元素: #${id}`)
  return node as T
}

function setStatus(text: string, isError = false): void {
  const bar = el('status-bar')
  bar.textContent = text
  bar.classList.toggle('is-error', isError)
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * 启动。
 *
 * 第一件事是检查 `window.dbstudio` 是否存在。
 * 如果直接用浏览器打开 index.html（没有 preload），它会不存在——
 * 此时给一句人能看懂的话，而不是抛一堆 TypeError 白屏。
 */
async function boot(): Promise<void> {
  const api = window.dbstudio
  if (!api) {
    document.body.innerHTML =
      '<div style="padding:32px;font:14px/1.7 -apple-system,sans-serif">' +
      '<h2 style="margin-top:0">需要 Electron 环境</h2>' +
      '<p>这个界面通过 preload 暴露的 <code>window.dbstudio</code> 与主进程通信。' +
      '当前页面没有该对象，说明它被当成了普通网页打开。</p>' +
      '<p>请用 <code>pnpm dev</code> 启动。</p></div>'
    return
  }

  // 退出前的未提交事务询问。
  //
  // 为什么挂在 window 上而不是由主进程直接 import 渲染进程的模块：
  // 主进程与渲染进程是**两个进程**，主进程拿不到渲染进程里的网格实例。
  // 所以主进程只能通过 executeJavaScript 调用这里暴露的钩子，
  // 由渲染进程自己弹框、自己读未应用编辑。
  window.dbstudioGuardTransactions = async (action: string) => {
    try {
      return await guardAllTransactions(action)
    } catch (e) {
      setStatus(`退出前检查事务失败：${errText(e)}`, true)
      // 检查失败时**不放行**：宁可让用户重试，也不能在不确定的情况下退出。
      return false
    }
  }

  // 暴露 A1 纯函数与核心身份契约，供 GUI/端到端自动化测试验证
  ;(window as unknown as Record<string, unknown>).__dbstudioA1 = {
    extractKeyValues,
    resolveKeyColumnIndex,
    encodeRowKey
  }

  // ---- 结果集多标签接线 ----
  //
  // 之前这里是 `new ResultGrid(...)` 单实例。现在改成由 ResultTabs 统一管理：
  // 每查一次就**新开**一个标签，标签内部各自持有一个独立的 ResultGrid 实例
  // （见 tabs.ts 文件头：改外层、多实例化，绝不复制 grid.ts 的代码）。
  let activeContext: ActiveTabContext | null = null
  const syncToolsVisibility = (): void => {
    el('result-tools').hidden = activeContext === null
  }
  const tabs = new ResultTabs(
    el('result-tabs-scroll'),
    el('result-stack'),
    el('result-tabs-empty'),
    el<HTMLButtonElement>('btn-export-all'),
    api,
    {
      onStatus: (t, isErr) => setStatus(t, isErr),
      onActiveChange: (context) => {
        activeContext = context
        syncToolsVisibility()
        const input = document.getElementById('filter-input') as HTMLInputElement | null
        const bar = document.getElementById('filter-bar')
        if (input) input.value = context?.filterDraft ?? ''
        if (bar) bar.hidden = !(context?.filterVisible ?? false)
      }
    }
  )

  // 网格需要知道「当前在哪个连接上执行 SQL」，所以记住最近选中的连接子树节点。
  let currentConnectionNodeId: string | null = null

  /**
   * 取方言的标识符引用规则。
   *
   * 为什么不直接用 grid 内部缓存的规则：那是私有字段。这里按 grid 的同款逻辑
   * 重取一次（`listDialects` + `pickQuotingRules`）：只有当**所有**已注册方言的
   * 引用规则一致时才拼 SQL，否则返回 null 让调用方拒绝执行——
   * 猜一个规则去拼标识符，比拒绝更危险。
   */
  const resolveQuoting = async (): Promise<QuotingRules | null> => {
    try {
      const dialects = await api.listDialects()
      return pickQuotingRules(dialects)
    } catch {
      return null
    }
  }

  const showPane = (which: 'detail' | 'grid' | 'empty' | 'er'): void => {
    el('detail-empty').hidden = which !== 'empty'
    el('detail-content').hidden = which !== 'detail'
    el('result-area').hidden = which !== 'grid'
    // E1-C 追加：ER 面板与结果区互斥。注意 er 面板自身有 #er-area[hidden] 规则。
    el('er-area').hidden = which !== 'er'
  }

  /** 选中表/视图 → **新开**一个结果标签（不再替换当前结果）。 */
  const openTableGrid = async (ref: ObjectRef): Promise<void> => {
    showPane('grid')
    try {
      const desc = await api.describeTable(ref.id)
      // 来源（ref + desc）在调用点记下，tabs 会把它绑定到该标签，供「导出全部」重查。
      await tabs.openTable(ref, desc)
    } catch (e) {
      setStatus(`打开表失败：${errText(e)}`, true)
    }
  }

  /** 统一的节点选中处理：先记录连接归属，再按节点类型分流。 */
  const onSelectNode = (ref: ObjectRef | null): void => {
    if (!ref) return
    // 子节点 id 形如 `connection:c1|table:users`；连接节点形如 `connection:c1`。
    // runQuery 需要的正是 `connection:<id>` 这个前缀部分。
    if (ref.kind === 'connection') {
      currentConnectionNodeId = ref.id
    } else if (ref.id.startsWith('connection:')) {
      currentConnectionNodeId = ref.id.split('|')[0] ?? null
    }

    if (ref.kind === 'table' || ref.kind === 'view') {
      void openTableGrid(ref)
    } else {
      void showDetail(api, ref, () => tree.loadRoots())
    }
  }

  const tree = new MetadataTree(
    el('tree-viewport'),
    el('tree-spacer'),
    el('tree-rows'),
    (nodeId) => api.listChildren(nodeId),
    {
      onStatus: (t, isErr) => setStatus(t, isErr),
      onSelect: onSelectNode,
      // 树面板左上角的摘要。原先这个元素写死在 HTML 里，连上库也显示「未连接」。
      onSummary: (t) => {
        el('tree-summary').textContent = t
      },
      // E1-C 追加：连接节点右键「查看 ER 图」→ 切到 ER 面板并生成。
      onViewErDiagram: (connRef) => {
        void openErDiagram(connRef)
      }
    }
  )

  // ---- SQL 历史与收藏 ----
  let sqlLibrary: SqlLibraryPanel | null = null

  /**
   * 记录一条实际执行过的语句。
   *
   * 历史写入失败不能把一条已经成功的查询误报成失败，但也不能静默：
   * 状态栏会明确说「查询已执行，但历史没存下」。
   */
  const recordSqlHistory = async (
    sql: string,
    connectionNodeId: string,
    elapsedMs: number,
    error: string | null,
    returnedRows: number | null
  ): Promise<void> => {
    const connectionId = NodeId.parse(connectionNodeId)?.connectionId ?? connectionNodeId
    try {
      const connection = (await api.listConnections()).find((item) => item.id === connectionId)
      await api.recordSqlHistory({
        sql,
        connectionId,
        dialectId: connection?.dialectId ?? 'unknown',
        elapsedMs,
        status: error === null ? 'success' : 'error',
        ...(error === null ? {} : { error }),
        ...(returnedRows === null ? {} : { returnedRows })
      })
      void sqlLibrary?.reload()
    } catch (historyError) {
      setStatus(`查询已执行，但写入 SQL 历史失败：${errText(historyError)}`, true)
    }
  }

  // ---- SQL 编辑器（替换原来的单行 input）----
  /** 执行一段 SQL（单条/全部同一条路径，区别只在传入内容）。 */
  /**
   * 执行 SQL。**支持多语句**：按 `;` 切分后逐条执行，每条结果开一个新标签。
   *
   * ⚠️ 这里曾经是个真 bug：编辑器有「执行全部」按钮，但它把整段 SQL
   * 原样传给 `runQuery`，而适配器只接受单条语句 —— 于是多语句 100% 失败
   * （`bad_params: 一次只能执行一条语句`）。功能等于没做。
   * 实测截图才发现，GUI 测试只测了单条 SQL 所以没暴露。
   *
   * 切分用 sql-format.ts 的 splitStatements —— 它能正确处理字符串/注释里的分号
   * （`SELECT 'a;b'` 不会被切成两条）。
   */
  const executeSql = async (sql: string): Promise<void> => {
    if (!sql.trim()) return
    if (!currentConnectionNodeId) {
      setStatus('请先在左侧选择一个连接再执行 SQL', true)
      return
    }
    showPane('grid')

    const statements = splitStatements(sql)
    if (statements.length === 0) {
      setStatus('没有可执行的语句', true)
      return
    }

    // 单条：照旧（标签名用整条 SQL 的开头）。
    // 多条：逐条执行，**前一条失败就停止**——后面的语句可能依赖前一条的结果，
    // 继续执行只会产生一堆连带错误，掩盖真正的问题。
    const connectionNodeId = currentConnectionNodeId
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i] as string
      const startedAt = performance.now()
      try {
        const opened = await tabs.runSql(connectionNodeId, stmt)
        await recordSqlHistory(
          stmt,
          connectionNodeId,
          performance.now() - startedAt,
          opened.outcome.error,
          opened.outcome.result?.returned ?? null
        )
        if (opened.outcome.error !== null) {
          const where =
            statements.length > 1 ? `第 ${i + 1}/${statements.length} 条语句失败：` : ''
          setStatus(`${where}${opened.outcome.error}`, true)
          return
        }
      } catch (e) {
        await recordSqlHistory(
          stmt,
          connectionNodeId,
          performance.now() - startedAt,
          errText(e),
          null
        )
        const where = statements.length > 1 ? `第 ${i + 1}/${statements.length} 条语句失败：` : ''
        setStatus(`${where}${errText(e)}`, true)
        return
      }
    }

    if (statements.length > 1) {
      setStatus(`已执行 ${statements.length} 条语句`)
    }
  }

  /**
   * 补全候选：当前连接的表名/视图名。
   *
   * 只遍历「表/视图」两个分组的直接子节点（各一次 listChildren），
   * 不做递归 —— 深度遍历在大库上会拉几百次请求，而补全只需要顶层对象名。
   * 缓存 30s，避免每次按键都查库。失败时返回空数组，编辑器会退化为只补关键字。
   */
  let metaCandidatesCache: { at: number; items: string[] } | null = null
  const sqlEditor = new SqlEditor(el('sql-editor-host'), {
    onExecute: (sql) => void executeSql(sql),
    onStatus: (t, isErr) => setStatus(t, isErr),
    getMetadataCandidates: async () => {
      const connId = currentConnectionNodeId
      if (!connId) return []
      const now = Date.now()
      if (metaCandidatesCache && now - metaCandidatesCache.at < 30_000) {
        return metaCandidatesCache.items
      }
      try {
        const kids = await api.listChildren(connId)
        const items: string[] = []
        for (const folder of kids) {
          if (folder.kind !== 'folder' || !folder.hasChildren) continue
          const objs = await api.listChildren(folder.id)
          for (const o of objs) items.push(o.name)
        }
        metaCandidatesCache = { at: now, items }
        return items
      } catch {
        return []
      }
    },
    runExplain: async (sql) => {
      const connId = currentConnectionNodeId
      if (!connId) throw new Error('未选择连接')
      const r = await api.runQuery(connId, `EXPLAIN QUERY PLAN ${sql}`, { keepCursor: false })
      return {
        columns: r.columns.map((c) => c.name),
        rows: r.rows.map((row) =>
          row.cells.map((c) => {
            if (c.kind === 'null') return null
            if (c.kind === 'number') return c.value
            if (c.kind === 'boolean') return c.value
            if (c.kind === 'text') return c.text
            return String(c)
          })
        )
      }
    },
    onOpenLibrary: () => void sqlLibrary?.open('history'),
    onSaveCurrent: (sql) => sqlLibrary?.saveCurrent(sql)
  })

  sqlLibrary = new SqlLibraryPanel({
    list: () => api.listSqlLibrary(),
    save: (id, name, sql) => api.saveSql(id, name, sql),
    removeSaved: (id) => api.removeSavedSql(id),
    clearHistory: () => api.clearSqlHistory(),
    loadSql: (sql) => {
      sqlEditor.setValue(sql)
      sqlEditor.focus()
    },
    runSql: (sql) => void executeSql(sql),
    onStatus: (text, isError) => setStatus(text, isError)
  })

  el('btn-refresh').addEventListener('click', () => {
    void tree.loadRoots()
  })
  el('btn-new-connection').addEventListener('click', () => {
    void openConnectionDialog(api, (summary) => {
      /**
       * 建完连接立刻把它设为「当前连接」。
       *
       * 为什么必须这样：`currentConnectionNodeId` 原先只在点击树节点时才赋值，
       * 于是最常见的操作序列 ——「新建连接 → 直接写 SQL → 执行」——
       * 会撞上「请先在左侧选择一个连接再执行 SQL」。
       * 用户刚连上、什么也没做错，却被要求再点一下树，纯属多余。
       *
       * 这个 bug 是真实点击测试抓到的，不是理论问题。
       */
      currentConnectionNodeId = NodeId.connection(summary.id)
      void tree.loadRoots()
    })
  })

  // =====================================================================
  // E1-C 追加：ER 图 + 结果工具条（多格式导出 / 筛选）
  // 全部为新增块，不改动上面的既有接线。
  // =====================================================================

  /** 打开某连接的 ER 图。 */
  const openErDiagram = async (connRef: ObjectRef): Promise<void> => {
    showPane('er')
    await renderErDiagram(
      el('er-area'),
      api,
      connRef,
      {
        onStatus: (t, isErr) => setStatus(t, isErr),
        // 点表框 → 走既有 openTable 路径（新开一个结果标签并切回结果区）。
        onOpenTable: (ref) => {
          showPane('grid')
          void openTableGrid(ref)
        }
      },
      () => showPane('grid') // 返回：回到结果区
    )
  }

  // ---------------------------------------------------------------------
  // 多格式导出（导出**已加载行**）
  // ---------------------------------------------------------------------
  //
  // 与右上角「导出全部」的区别（必须在 UI 上也让用户看得见）：
  //   - 这里：只导出 result-grid 页缓存里已加载的行，不重查，快；
  //   - 「导出全部」：会重新执行一次查询把所有行拉回来，慢、有行数上限。
  // 二者不可混为一谈，否则用户会以为"导出 = 全表"。
  const exportSel = el<HTMLSelectElement>('btn-export-format')
  exportSel.addEventListener('change', () => {
    void doExport()
  })

  const doExport = async (): Promise<void> => {
    const context = activeContext
    const grid = context?.grid
    const tableRef = context?.source.kind === 'table' ? context.source.ref : null
    if (!context || !grid) {
      setStatus('没有可导出的结果', true)
      return
    }
    try {
      /**
       * 取「用户真正加载过的那些行」。
       *
       * 早先的实现是「用相同来源重查一次、取第一页顶替已加载行」——那是**语义错误**：
       * 用户滚到第 5000 行点导出，拿到的却是第 1-500 行，界面还不会有任何提示。
       *
       * 现在 grid 提供了 `exportLoadedRows()`（受控只读出口），
       * 直接给出页缓存里真实存在的行。它同时告诉我们 `hasMore`，
       * 导出时就能明确提示「共导出 N 行（结果集还有更多未加载）」。
       *
       * 为什么不用 DOM 读单元格文本：文本无法还原 number / NULL / boolean 的区别，
       * 导出的 JSON/INSERT 类型会全错——这种静默错误比报错更糟。
       */
      const loaded = grid.exportLoadedRows()
      if (loaded.loadedCount === 0) {
        setStatus('导出失败：当前结果集还没有加载任何行', true)
        return
      }
      const cols: ExportColumn[] = loaded.columns.map((c) => ({ name: c.name }))
      const rows: ExportRow[] = loaded.rows.map((r) => r.cells)
      const fmt = exportSel.value
      let text = ''
      let ext = 'txt'
      let mime = 'text/plain;charset=utf-8'
      if (fmt === 'csv') {
        // 加 BOM：Excel 打开不带 BOM 的 UTF-8 CSV，中文会乱码。
        text = '\uFEFF' + toCsv(cols, rows)
        ext = 'csv'
        mime = 'text/csv;charset=utf-8'
      } else if (fmt === 'json') {
        text = toJson(cols, rows)
        ext = 'json'
        mime = 'application/json;charset=utf-8'
      } else if (fmt === 'insert') {
        // INSERT 需要表名 + 标识符引用规则。任一拿不到就**拒绝**，
        // 绝不拼接未转义的表名/列名。
        if (!tableRef) {
          setStatus('INSERT 导出需要"表"来源（自由 SQL 结果没有表名）', true)
          return
        }
        const rules = await resolveQuoting()
        if (!rules) {
          setStatus('无法获取方言引号规则，已取消 INSERT 导出（不会拼接未转义的标识符）', true)
          return
        }
        text = toInsertSql(tableRef.name, cols, rows, (n) => quoteIdentifier(n, rules))
        ext = 'sql'
        mime = 'text/plain;charset=utf-8'
      } else {
        text = toMarkdown(cols, rows)
        ext = 'md'
        mime = 'text/markdown;charset=utf-8'
      }
      download(text, buildExportFileName(ext), mime)
      setStatus(`已导出 ${rows.length} 行（${fmt.toUpperCase()}，仅当前已渲染的行）`)
    } catch (e) {
      setStatus(`导出失败：${errText(e)}`, true)
    }
  }

  // ---------------------------------------------------------------------
  // 筛选：**重新查询**，不是前端过滤
  // ---------------------------------------------------------------------
  //
  // 为什么不能前端过滤：页缓存只有用户滚动看过的那部分行，前端过滤会得到
  // 「只过滤了看得见的行」的结果——看起来对、实际全错、还不报错。
  // 所以这里把条件拼成 WHERE，交给 grid 重新执行查询（清空页缓存、从偏移 0 取）。
  const filterToggle = el<HTMLButtonElement>('btn-filter-toggle')
  const filterBar = el('filter-bar')
  const filterInput = el<HTMLInputElement>('filter-input')

  filterToggle.addEventListener('click', () => {
    filterBar.hidden = !filterBar.hidden
    tabs.setFilterDraft(filterInput.value, !filterBar.hidden)
    if (!filterBar.hidden) filterInput.focus()
  })
  // 输入即存草稿。
  //
  // 为什么必须在这里回写：`onActiveChange` 在切标签时会把 `filter-input` 重置成
  // 目标标签的草稿。若草稿只写进 DOM 输入框、不落到标签上，用户在标签 A 输入
  // 的条件一切走就被清空——回到 A 时条件已经没了。这不是「显示问题」，是用户
  // 辛苦写的筛选条件被静默丢弃。
  filterInput.addEventListener('input', () => {
    tabs.setFilterDraft(filterInput.value, !filterBar.hidden)
  })
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void applyFilter()
  })
  el('btn-filter-apply').addEventListener('click', () => void applyFilter())
  // 清除：把条件置空并**同样重查**——否则会停在筛选结果上，与输入框状态不符。
  el('btn-filter-clear').addEventListener('click', () => {
    filterInput.value = ''
    tabs.setFilterDraft('', !filterBar.hidden)
    void applyFilter()
  })

  const applyFilter = async (): Promise<void> => {
    const context = activeContext
    if (!context) {
      setStatus('没有可筛选的结果', true)
      return
    }
    const rules = await resolveQuoting()
    if (!rules) {
      setStatus('无法获取方言引号规则，已取消筛选（不会拼接未转义的列名）', true)
      return
    }
    const quote = (n: string): string => quoteIdentifier(n, rules)

    const parsed = parseFilter(filterInput.value, quote)
    if (!parsed.ok) {
      setStatus(describeFilterError(parsed.error), true)
      return
    }

    // 依据来源拼带 WHERE 的完整 SQL：
    //   表 → SELECT * FROM "t" WHERE ...
    //   SQL → SELECT * FROM (<原SQL>) _dbstudio_filter WHERE ...（WHERE 作用于原查询结果）
    //
    const base =
      context.baseSource.kind === 'table'
        ? ({ sourceKind: 'table', tableName: context.baseSource.ref.name } as const)
        : ({ sourceKind: 'sql', sql: context.baseSource.sql } as const)
    const sql = buildFilteredSql(base, parsed.conditions, quote)

    setStatus(parsed.conditions.length === 0 ? '正在清除筛选（重新查询）…' : '正在按筛选重新查询…')
    try {
      // 关键：**重新查询**。走 tabs.runSql 新开一个标签（tabs.openTable/runSql 是
      // 唯一能"重跑任意 SQL"的公开入口；grid.ts 不归本轮改，不能加方法）。
      // 旧标签保留，筛选结果通过 baseSource 继续关联原始查询。
      showPane('grid')
      const opened = await tabs.runSql(context.connectionNodeId, sql, {
        baseSource: context.baseSource,
        filterText: filterInput.value.trim(),
        filterConditions: parsed.conditions
      })
      if (opened.outcome.error !== null) {
        setStatus(`筛选失败：${opened.outcome.error}`, true)
        return
      }
      setStatus(
        parsed.conditions.length === 0
          ? '已清除筛选（重新查询）'
          : `已按筛选重新查询（${parsed.conditions.length} 个条件）`
      )
    } catch (e) {
      setStatus(`筛选失败：${errText(e)}`, true)
    }
  }


  await tree.loadRoots()
}

/** 触发浏览器下载（导出用）。 */
function download(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 下载已开始，下一帧释放 object URL，避免内存泄漏。
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * 右侧详情：表结构 + 唯一键警告；连接节点则给出连接/断开/删除操作。
 *
 * `reloadTree` 从外部注入而不是直接引用 tree：
 * 这个函数在 boot() 里也可被复用，直接闭包引用会让依赖关系变成隐式的。
 */
async function showDetail(
  api: DbStudioApi,
  ref: ObjectRef,
  reloadTree: () => Promise<void>
): Promise<void> {
  const empty = el('detail-empty')
  const content = el('detail-content')

  // 非表/视图节点没有列结构可展示。
  if (ref.kind !== 'table' && ref.kind !== 'view') {
    empty.hidden = false
    content.hidden = false
    content.replaceChildren()

    if (ref.kind === 'connection') {
      // 连接节点：展示持久化/会话状态，并按需给出「连接 / 断开 / 删除」操作。
      //
      // 为什么要这三个按钮：加了持久化之后，连接不再是「存在即已连上」。
      // 启动时只载入配置不建立会话（否则启动会挨个连库、慢且可能弹一堆错误），
      // 所以用户必须能手动把一条已保存的连接接上。
      const h2 = document.createElement('h2')
      h2.textContent = ref.name
      content.appendChild(h2)

      const meta = document.createElement('div')
      meta.className = 'detail-sub'
      const connected = ref.meta?.['connected'] === true
      const persisted = ref.meta?.['persisted'] === true
      // secretStored 三态：null=不需要密码；true=已加密保存；false=需要密码但存不下。
      // 用 `=== false` 而不是 `!x`，否则 null（不需要密码）会被误判成"没存"。
      const secretStored = ref.meta?.['secretStored']
      meta.textContent =
        `${String(ref.meta?.['dialect'] ?? '未知方言')} · ` +
        (connected ? '已连接' : '未连接') +
        (persisted ? ' · 配置已保存' : ' · 配置未保存')
      content.appendChild(meta)

      // 密码存不下时必须显著提示。否则用户重启后连接失败，却完全不知道为什么——
      // 这种"看起来成功、实际少了关键部分"比直接报错更糟。
      if (secretStored === false) {
        const warn = document.createElement('div')
        warn.className = 'warn-banner'
        warn.textContent =
          '⚠ 密码未保存：当前系统不支持安全存储（如缺少 keyring）。' +
          '配置已保存，但重启后需要重新输入密码。'
        content.appendChild(warn)
      }

      const bar = document.createElement('div')
      bar.className = 'conn-actions'

      // 仅在连接归属的节点 id 上操作（`connection:<id>` → `<id>`）。
      const connId = ref.id.startsWith('connection:') && !ref.id.includes('|')
        ? ref.id.slice('connection:'.length)
        : null

      if (connId) {
        if (!connected) {
          bar.appendChild(
            actionButton('连接', async () => {
              setStatus('正在连接…')
              try {
                await api.connectConnection(connId)
                setStatus(`已连接：${ref.name}`)
                await reloadTree()
              } catch (e) {
                setStatus(`连接失败：${errText(e)}`, true)
              }
            })
          )
        } else {
          bar.appendChild(
            actionButton('断开', async () => {
              setStatus('正在断开…')
              try {
                await runConnectionOperation(api, connId, '断开连接', () => api.disconnectConnection(connId))
                setStatus(`已断开：${ref.name}（配置仍保留）`)
                await reloadTree()
              } catch (e) {
                setStatus(`断开失败：${errText(e)}`, true)
              }
            })
          )
        }
        bar.appendChild(
          actionButton('删除连接', async () => {
            // 用原生 confirm 简单确认。删除会同时清掉保存的配置与凭据，不可撤销。
            if (!globalThis.confirm(`确定删除连接「${ref.name}」？配置与保存的密码都会被删除。`)) {
              return
            }
            try {
              await runConnectionOperation(api, connId, '删除连接', () => api.removeConnection(connId))
              setStatus(`已删除：${ref.name}`)
              await reloadTree()
            } catch (e) {
              setStatus(`删除失败：${errText(e)}`, true)
            }
          })
        )
      }
      content.appendChild(bar)
      return
    }

    empty.hidden = false
    content.hidden = true
    empty.textContent = `「${ref.name}」不是表或视图，没有列结构。`
    return
  }

  empty.hidden = true
  content.hidden = false
  content.replaceChildren(loadingNode('正在读取表结构…'))

  let desc: TableDescription
  try {
    desc = await api.describeTable(ref.id)
  } catch (e) {
    content.replaceChildren()
    const err = document.createElement('div')
    err.className = 'warn-banner'
    err.textContent = `读取表结构失败：${errText(e)}`
    content.appendChild(err)
    return
  }

  content.replaceChildren()

  const h2 = document.createElement('h2')
  h2.textContent = ref.name
  content.appendChild(h2)

  const sub = document.createElement('div')
  sub.className = 'detail-sub'
  sub.textContent = `${ref.kind === 'view' ? '视图' : '表'} · ${desc.columns.length} 列`
  content.appendChild(sub)

  // 无唯一键 → 不可在线编辑。这是从 DBeaver 的
  // `ResultSetPersister.checkEntityIdentifiers`（缺 DBDRowIdentifier 直接报
  // "No unique key defined"）提炼出来的规则，提前告知而不是等用户改了才报错。
  if (!desc.hasUniqueKey) {
    const warn = document.createElement('div')
    warn.className = 'warn-banner'
    warn.innerHTML =
      '<span aria-hidden="true">⚠</span><span>' +
      '<strong>该对象没有唯一键（主键）。</strong><br/>' +
      '因此无法在线编辑它的数据——Update/Delete 需要能唯一定位一行的标识。' +
      '这与 DBeaver 的行为一致（缺唯一键时抛出 “No unique key defined”）。' +
      '</span>'
    content.appendChild(warn)
  }

  const table = document.createElement('table')
  table.className = 'columns'
  const thead = document.createElement('thead')
  thead.innerHTML =
    '<tr><th scope="col">列名</th><th scope="col">类型</th>' +
    '<th scope="col">可空</th><th scope="col">主键</th><th scope="col">默认值</th></tr>'
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const c of desc.columns) {
    const tr = document.createElement('tr')

    const nameTd = document.createElement('td')
    nameTd.textContent = c.name
    tr.appendChild(nameTd)

    const typeTd = document.createElement('td')
    typeTd.className = 'type'
    typeTd.textContent = c.typeName
    tr.appendChild(typeTd)

    const nulTd = document.createElement('td')
    nulTd.textContent = c.nullable ? '是' : '否'
    tr.appendChild(nulTd)

    const pkTd = document.createElement('td')
    if (c.primaryKeyOrdinal !== null) {
      const badge = document.createElement('span')
      badge.className = 'pk-badge'
      badge.textContent = `PK${c.primaryKeyOrdinal > 1 ? c.primaryKeyOrdinal : ''}`
      pkTd.appendChild(badge)
    } else {
      pkTd.textContent = '—'
    }
    tr.appendChild(pkTd)

    const defTd = document.createElement('td')
    defTd.className = 'type'
    defTd.textContent = c.defaultValue ?? '—'
    tr.appendChild(defTd)

    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  content.appendChild(table)
}

function loadingNode(text: string): HTMLElement {
  const div = document.createElement('div')
  div.className = 'detail-sub'
  div.textContent = text
  return div
}

/** 造一个带异步点击处理的按钮，期间禁用防止连点。 */
function actionButton(label: string, onClick: () => Promise<void>): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = label
  btn.addEventListener('click', () => {
    btn.disabled = true
    void onClick().finally(() => {
      btn.disabled = false
    })
  })
  return btn
}

// ---------------------------------------------------------------------------
// 新建连接对话框
// ---------------------------------------------------------------------------

let cachedDialects: DialectInfo[] | null = null

const TEST_STAGE_LABELS: Readonly<Record<ConnectionTestCheck['stage'], string>> = {
  config: '配置',
  ssh_connect: 'SSH 握手',
  ssh_host_key: '主机指纹',
  ssh_auth: 'SSH 认证',
  ssh_forward: 'SSH 转发',
  database: '数据库连接',
  server_query: '服务端查询'
}

function renderConnectionTest(
  result: TestConnectionResult,
  onTrustHostKey: (check: SshHostKeyCheck) => Promise<void>
): void {
  const panel = el<HTMLElement>('test-diagnostics')
  const list = el<HTMLOListElement>('test-check-list')
  const message = el<HTMLDivElement>('test-message')
  const messageText = el<HTMLParagraphElement>('test-message-text')
  const trust = el<HTMLButtonElement>('btn-test-trust-host')
  const title = el('test-diagnostics-title')
  const elapsed = el('test-diagnostics-elapsed')

  panel.hidden = false
  title.textContent = result.ok ? '连接测试通过' : '连接测试失败'
  elapsed.textContent = `${result.elapsedMs}ms`
  list.replaceChildren()

  for (const check of result.checks ?? []) {
    const item = document.createElement('li')
    item.className = `test-check ${check.status}`
    item.dataset['stage'] = check.stage

    const icon = document.createElement('span')
    icon.className = 'test-check-icon'
    icon.textContent = check.status === 'passed' ? '✓' : check.status === 'failed' ? '✕' : '—'
    icon.setAttribute('aria-hidden', 'true')

    const name = document.createElement('span')
    name.className = 'test-check-name'
    name.textContent = TEST_STAGE_LABELS[check.stage]

    const detail = document.createElement('span')
    detail.className = 'test-check-message'
    detail.textContent = check.message ?? ''
    if (check.elapsedMs !== undefined) {
      detail.textContent += `${detail.textContent === '' ? '' : ' · '}${check.elapsedMs}ms`
    }
    item.append(icon, name, detail)
    list.appendChild(item)
  }

  message.hidden = result.ok || (result.message === undefined && result.sshHostKey === undefined)
  messageText.textContent = result.ok ? '' : result.message ?? ''
  trust.hidden = true
  trust.onclick = null

  if (result.sshHostKey !== undefined) {
    const hostKey = result.sshHostKey
    trust.textContent =
      hostKey.state === 'unverified' ? '核对指纹并信任…' : '查看指纹差异…'
    trust.hidden = false
    trust.onclick = () => {
      trust.disabled = true
      void onTrustHostKey(hostKey).finally(() => {
        trust.disabled = false
      })
    }
    message.hidden = false
  }
}

/**
 * 展示主机密钥并等待用户明确选择。
 *
 * 已保存指纹不一致时也允许更新，但不提供“静默覆盖”：按钮文案和警告都要求
 * 用户先核对实际指纹。这里没有“始终信任”选项，避免把一次决定变成永久绕过。
 */
function confirmSshHostKey(check: SshHostKeyCheck): Promise<boolean> {
  const dlg = el<HTMLDialogElement>('dlg-ssh-host-key')
  const expectedRow = el('ssh-key-expected-row')
  const warning = el('ssh-key-warning')
  const title = el('ssh-key-title')
  const intro = el('ssh-key-intro')
  const guidance = el('ssh-key-guidance')
  const trust = el<HTMLButtonElement>('btn-ssh-key-trust')

  const mismatch = check.state === 'mismatch'
  title.textContent = mismatch ? 'SSH 主机密钥已变化' : '确认新的 SSH 主机'
  warning.hidden = !mismatch
  warning.textContent = mismatch
    ? '这可能是中间人攻击，也可能是跳板机重装或换过主机密钥。务必通过可信渠道核对下方实际指纹，确认无误后再继续。'
    : ''
  intro.textContent = mismatch
    ? '本客户端拒绝在未获确认时改用新指纹。'
    : '这是第一次连接该主机。请通过可信渠道核对指纹；确认后只会信任这一次展示的密钥。'
  guidance.textContent = mismatch
    ? '若无法解释指纹变化，请取消并联系跳板机管理员。不要仅在网络恢复后反复重试。'
    : '可与管理员提供的 ssh-keygen -lf 输出逐字比对。'
  el('ssh-key-host').textContent = `${check.host}:${check.port}`
  el('ssh-key-expected').textContent = check.expectedFingerprint ?? ''
  expectedRow.hidden = !mismatch || check.expectedFingerprint === undefined
  el('ssh-key-actual-label').textContent = mismatch ? '本次实际指纹' : 'SHA256 指纹'
  el('ssh-key-actual').textContent = check.fingerprint
  trust.textContent = mismatch ? '我核对过，使用新指纹' : '信任并继续'

  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (accepted: boolean): void => {
      if (settled) return
      settled = true
      trust.removeEventListener('click', onTrust)
      el('btn-ssh-key-cancel').removeEventListener('click', onCancel)
      dlg.removeEventListener('cancel', onDialogCancel)
      dlg.close()
      resolve(accepted)
    }
    const onTrust = (): void => finish(true)
    const onCancel = (): void => finish(false)
    const onDialogCancel = (event: Event): void => {
      event.preventDefault()
      finish(false)
    }
    trust.addEventListener('click', onTrust)
    el('btn-ssh-key-cancel').addEventListener('click', onCancel)
    dlg.addEventListener('cancel', onDialogCancel)
    dlg.showModal()
  })
}

async function openConnectionDialog(
  api: DbStudioApi,
  onConnected: (summary: ConnectionSummary) => void
): Promise<void> {
  const dlg = el<HTMLDialogElement>('dlg-connection')
  const sel = el<HTMLSelectElement>('f-dialect')
  const dyn = el('f-dynamic')
  const errP = el('f-error')
  const nameInput = el<HTMLInputElement>('f-name')

  try {
    cachedDialects ??= await api.listDialects()
  } catch (e) {
    setStatus(`读取方言列表失败：${errText(e)}`, true)
    return
  }

  // 填充方言下拉。每次都重建，避免上次的选项残留。
  sel.replaceChildren()
  for (const d of cachedDialects) {
    const opt = document.createElement('option')
    opt.value = d.id
    opt.textContent = `${d.name}（${d.id}）`
    sel.appendChild(opt)
  }

  const renderFields = (): void => {
    const dialect = cachedDialects?.find((d) => d.id === sel.value)
    dyn.replaceChildren()
    if (!dialect) return
    for (const f of dialect.fields) {
      dyn.appendChild(buildField(f))
    }
  }
  renderFields()
  sel.onchange = renderFields

  errP.hidden = true
  el<HTMLElement>('test-diagnostics').hidden = true
  nameInput.value = ''

  /** 收集表单 → ConnectionConfig + 具名 secret。密码绝不进 options。 */
  const collect = (): { config: ConnectionConfig; secret: SecretMap } => {
    const dialect = cachedDialects?.find((d) => d.id === sel.value)
    if (!dialect) throw new Error('请选择数据库类型')
    const options: Record<string, string | number | boolean> = {}
    const secret: { dbPassword?: string; sshPassword?: string; sshPassphrase?: string } = {}
    for (const f of dialect.fields) {
      // `select` 与 `input` 都带 data-key，但类型不同：统一按"有 value 的控件"取。
      const control = dyn.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[data-key="${cssEscape(f.key)}"]`
      )
      if (!control) continue
      const raw = control.value.trim()
      if (raw === '') {
        if (f.required) throw new Error(`请填写「${f.label}」`)
        continue
      }
      if (f.kind === 'password') {
        // 每个密码框按方言声明的 secretKey 分开收集。SSH 连接最多有三个
        // 独立机密，绝不能后填覆盖先填（见 DialectField.secretKey 的注释）。
        secret[f.secretKey ?? 'dbPassword'] = raw
      } else if (f.kind === 'number') {
        const n = Number(raw)
        if (Number.isNaN(n)) throw new Error(`「${f.label}」必须是数字`)
        options[f.key] = n
      } else {
        options[f.key] = raw
      }
    }
    const name = nameInput.value.trim() || dialect.name
    return { config: { dialectId: dialect.id, name, options }, secret }
  }

  /**
   * 测试连接。未知或已变化的 SSH 指纹由用户显式确认，写回表单后自动重试；
   * 确认值尚未落盘时取消，不会留下任何“已信任”状态。
   */
  const runTest = async (): Promise<void> => {
    const { config, secret } = collect()
    let res = await api.testConnection(config, secret)
    if (!res.ok && res.sshHostKey !== undefined) {
      const accepted = await confirmSshHostKey(res.sshHostKey)
      if (accepted) {
        const fingerprintInput = dyn.querySelector<HTMLInputElement>(
          '[data-key="sshHostKeySha256"]'
        )
        if (fingerprintInput === null) {
          throw new Error('当前表单不支持保存 SSH 主机指纹')
        }
        fingerprintInput.value = res.sshHostKey.fingerprint
        setStatus('已确认主机指纹，正在重新测试…')
        res = await api.testConnection(collect().config, secret)
      }
    }
    renderConnectionTest(res, async (hostKey) => {
      const accepted = await confirmSshHostKey(hostKey)
      if (!accepted) return
      const fingerprintInput = dyn.querySelector<HTMLInputElement>(
        '[data-key="sshHostKeySha256"]'
      )
      if (fingerprintInput === null) throw new Error('当前表单不支持保存 SSH 主机指纹')
      fingerprintInput.value = hostKey.fingerprint
      setStatus('已确认主机指纹，正在重新测试…')
      await runTest()
    })
    if (res.ok) {
      setStatus(
        `连接成功（${res.elapsedMs}ms${res.serverVersion ? ` · ${res.serverVersion}` : ''}）`
      )
    } else {
      setStatus(`连接失败：${res.message ?? '未知原因'}`, true)
    }
  }

  el('btn-test').onclick = () => {
    void (async () => {
      errP.hidden = true
      setStatus('正在测试连接…')
      try {
        await runTest()
      } catch (e) {
        errP.textContent = errText(e)
        errP.hidden = false
        setStatus('测试连接失败', true)
      }
    })()
  }

  el('btn-cancel').onclick = () => {
    dlg.close()
  }

  const form = el<HTMLFormElement>('form-connection')
  form.onsubmit = (e) => {
    e.preventDefault()
    void (async () => {
      errP.hidden = true
      el<HTMLButtonElement>('btn-submit').disabled = true
      setStatus('正在连接…')
      try {
        const { config, secret } = collect()
        const summary: ConnectionSummary = await api.addConnection(config, secret)
        /*
         * addConnection 的成功语义是“配置已保存”，不代表会话已建立。
         * 连接失败时保留表单，让用户直接改参数/测试；但刷新树，
         * 因为配置确实已经落盘，用户也可以稍后从树里重连。
         */
        if (summary.connected) {
          dlg.close()
          setStatus(`已连接：${summary.name}`)
          onConnected(summary)
        } else {
          errP.textContent = `配置已保存，但会话连接失败。请检查参数后重试，或从树中稍后连接「${summary.name}」。`
          errP.hidden = false
          setStatus(`已保存，未连接：${summary.name}`, true)
          onConnected(summary)
        }
      } catch (err) {
        errP.textContent = errText(err)
        errP.hidden = false
        setStatus('连接失败', true)
      } finally {
        el<HTMLButtonElement>('btn-submit').disabled = false
      }
    })()
  }

  dlg.showModal()
}

/**
 * 按 `DialectField.kind` 动态造一个表单行。五种 kind 都要支持。
 *
 * `select` 是后加的（PostgreSQL 的 sslmode 是闭集，见 core/driver.ts 的
 * `DialectField.choices`）。它必须造 `<select>` 而不是 `<input>`——
 * 否则 `collect()` 里 `input.value` 能读到值，但用户看到的是一个空文本框，
 * 会以为自己要手打 `verify-ca`。
 */
function buildField(f: DialectField): HTMLElement {
  const wrap = document.createElement('label')
  wrap.className = 'field'

  const label = document.createElement('span')
  label.textContent = f.required ? `${f.label} *` : f.label
  wrap.appendChild(label)

  if (f.kind === 'select') {
    const sel = document.createElement('select')
    sel.dataset['key'] = f.key
    for (const c of f.choices ?? []) {
      const opt = document.createElement('option')
      opt.value = c.value
      opt.textContent = c.label
      sel.appendChild(opt)
    }
    // 缺省值必须显式选中：`<select>` 不设时会默认第一项，
    // 而 sslmode 的第一项是 `disable`——那会让"没填"变成"明文连接"。
    if (f.default !== undefined) sel.value = String(f.default)
    sel.required = f.required
    wrap.appendChild(sel)
    return wrap
  }

  const input = document.createElement('input')
  input.dataset['key'] = f.key
  if (f.kind === 'password') input.dataset['secretKey'] = f.secretKey ?? 'dbPassword'
  input.type = f.kind === 'password' ? 'password' : f.kind === 'number' ? 'number' : 'text'
  if (f.placeholder) input.placeholder = f.placeholder
  if (f.default !== undefined) input.value = String(f.default)
  input.required = f.required

  if (f.kind === 'file') {
    // 文件选择：用一个只读文本框 + 「浏览」按钮。Electron 里真正调
    // 系统文件对话框需要主进程配合，这里先用纯文本输入，避免为了一个
    // 可选 UI 细节把 IPC 面再开大一次。
    input.placeholder = f.placeholder ?? '输入绝对路径，例如 /tmp/sample.db'
  }

  wrap.appendChild(input)
  return wrap
}

/** CSS 属性选择器转义，避免 key 里的特殊字符导致 querySelector 抛错。 */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&')
}

// 启动。任何未捕获异常都要显示到状态栏，不能白屏。
boot().catch((e) => {
  setStatus(`启动失败：${errText(e)}`, true)
  console.error(e)
})
