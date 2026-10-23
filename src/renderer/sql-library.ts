/**
 * SQL 历史与收藏面板。
 *
 * 面板只负责筛选与展示；真正执行由外部注入，载入只填编辑器、不偷偷执行。
 */

import type { SavedSql, SqlHistoryEntry, SqlLibrarySnapshot } from '../core/sql-library'

export interface SqlLibraryCallbacks {
  list(): Promise<SqlLibrarySnapshot>
  save(id: string | null, name: string, sql: string): Promise<SavedSql>
  removeSaved(id: string): Promise<void>
  clearHistory(): Promise<void>
  loadSql(sql: string): void
  runSql(sql: string): void
  onStatus(text: string, isError?: boolean): void
}

type Tab = 'history' | 'saved'

export class SqlLibraryPanel {
  readonly #dialog: HTMLDialogElement
  readonly #list: HTMLElement
  readonly #empty: HTMLElement
  readonly #search: HTMLInputElement
  readonly #historyTab: HTMLButtonElement
  readonly #savedTab: HTMLButtonElement
  readonly #clearBtn: HTMLButtonElement
  readonly #saveDialog: HTMLDialogElement
  readonly #saveForm: HTMLFormElement
  readonly #saveTitle: HTMLElement
  readonly #saveName: HTMLInputElement
  readonly #saveError: HTMLElement
  readonly #cb: SqlLibraryCallbacks

  #tab: Tab = 'history'
  #snapshot: SqlLibrarySnapshot = { history: [], saved: [] }
  #editingSavedId: string | null = null

  constructor(cb: SqlLibraryCallbacks) {
    this.#cb = cb
    this.#dialog = required<HTMLDialogElement>('dlg-sql-library')
    this.#list = required('sql-library-list')
    this.#empty = required('sql-library-empty')
    this.#search = required<HTMLInputElement>('sql-library-search')
    this.#historyTab = required<HTMLButtonElement>('tab-sql-history')
    this.#savedTab = required<HTMLButtonElement>('tab-sql-saved')
    this.#clearBtn = required<HTMLButtonElement>('btn-clear-sql-history')
    this.#saveDialog = required<HTMLDialogElement>('dlg-save-sql')
    this.#saveForm = required<HTMLFormElement>('form-save-sql')
    this.#saveTitle = required('save-sql-title')
    this.#saveName = required<HTMLInputElement>('f-save-sql-name')
    this.#saveError = required('save-sql-error')

    required('btn-sql-library-close').addEventListener('click', () => this.close())
    this.#historyTab.addEventListener('click', () => this.#selectTab('history'))
    this.#savedTab.addEventListener('click', () => this.#selectTab('saved'))
    this.#search.addEventListener('input', () => this.#render())
    this.#clearBtn.addEventListener('click', () => void this.#clearHistory())
    required('btn-save-sql-cancel').addEventListener('click', () => this.#closeSaveDialog())
    this.#saveForm.addEventListener('submit', (event) => {
      event.preventDefault()
      void this.#submitSave()
    })
    // 原生 Esc 关闭保存框时复位状态，避免下次误以为在重命名。
    this.#saveDialog.addEventListener('close', () => {
      this.#editingSavedId = null
      this.#saveError.hidden = true
    })
  }

  async open(tab: Tab = 'history'): Promise<void> {
    this.#tab = tab
    if (!this.#dialog.open) this.#dialog.showModal()
    this.#search.value = ''
    await this.reload()
    this.#search.focus()
  }

  /** 从编辑器工具栏直接保存当前 SQL；不经历史列表。 */
  saveCurrent(sql: string): void {
    this.#openSaveDialog(null, sql)
  }

  close(): void {
    if (this.#dialog.open) this.#dialog.close()
  }

  async reload(): Promise<void> {
    try {
      this.#snapshot = await this.#cb.list()
      this.#render()
    } catch (err) {
      this.#cb.onStatus(`读取 SQL 库失败：${errText(err)}`, true)
    }
  }

  #selectTab(tab: Tab): void {
    this.#tab = tab
    this.#render()
  }

  #render(): void {
    const isHistory = this.#tab === 'history'
    this.#historyTab.setAttribute('aria-selected', String(isHistory))
    this.#savedTab.setAttribute('aria-selected', String(!isHistory))
    this.#clearBtn.hidden = !isHistory
    this.#list.replaceChildren()

    const query = this.#search.value.trim().toLowerCase()
    if (isHistory) {
      const entries = this.#snapshot.history.filter((entry) => matchesHistory(entry, query))
      for (const entry of entries) this.#list.appendChild(this.#renderHistory(entry))
      this.#showEmpty(entries.length, query, '还没有执行历史', '没有匹配的历史')
    } else {
      const entries = this.#snapshot.saved.filter((entry) => matchesSaved(entry, query))
      for (const entry of entries) this.#list.appendChild(this.#renderSaved(entry))
      this.#showEmpty(entries.length, query, '还没有收藏 SQL', '没有匹配的收藏')
    }
  }

  #showEmpty(count: number, query: string, emptyText: string, noMatchText: string): void {
    this.#empty.hidden = count > 0
    this.#empty.textContent = query === '' ? emptyText : noMatchText
  }

  #renderHistory(entry: SqlHistoryEntry): HTMLElement {
    return this.#renderItem({
      id: `history-${entry.id}`,
      title: sqlPreview(entry.sql),
      meta: [
        entry.status === 'success' ? '成功' : '失败',
        entry.connectionName || entry.connectionId,
        entry.dialectId,
        formatTime(entry.startedAt),
        `${entry.elapsedMs}ms`,
        entry.returnedRows === null ? '' : `${entry.returnedRows} 行`
      ].filter(Boolean).join(' · '),
      sql: entry.sql,
      tone: entry.status === 'error' ? 'error' : 'success',
      detail: entry.error,
      actions: [
        { label: '载入', title: '填入 SQL 编辑器（不执行）', run: () => this.#load(entry.sql) },
        { label: '执行', title: '立即执行这条 SQL', run: () => this.#run(entry.sql) },
        {
          label: '收藏',
          title: '保存为收藏',
          run: () => this.#openSaveDialog(null, entry.sql)
        }
      ]
    })
  }

  #renderSaved(entry: SavedSql): HTMLElement {
    return this.#renderItem({
      id: `saved-${entry.id}`,
      title: entry.name,
      meta: [sqlPreview(entry.sql), formatTime(entry.updatedAt)].join(' · '),
      sql: entry.sql,
      tone: 'saved',
      actions: [
        { label: '载入', title: '填入 SQL 编辑器（不执行）', run: () => this.#load(entry.sql) },
        { label: '执行', title: '立即执行这条 SQL', run: () => this.#run(entry.sql) },
        {
          label: '重命名',
          title: '修改收藏名称或 SQL',
          run: () => this.#openSaveDialog(entry, entry.sql)
        },
        {
          label: '删除',
          title: '删除这条收藏',
          danger: true,
          run: () => void this.#removeSaved(entry)
        }
      ]
    })
  }

  #renderItem(spec: {
    id: string
    title: string
    meta: string
    sql: string
    tone: 'success' | 'error' | 'saved'
    detail?: string | null
    actions: readonly { label: string; title: string; run: () => void; danger?: boolean }[]
  }): HTMLElement {
    const item = document.createElement('article')
    item.className = 'sql-library-item'
    item.dataset['id'] = spec.id
    item.setAttribute('role', 'listitem')

    const head = document.createElement('div')
    head.className = 'sql-library-item-head'
    const title = document.createElement('strong')
    title.textContent = spec.title
    title.title = spec.title
    head.appendChild(title)
    const badge = document.createElement('span')
    badge.className = `sql-library-badge ${spec.tone}`
    badge.textContent = spec.tone === 'success' ? '成功' : spec.tone === 'error' ? '失败' : '收藏'
    head.appendChild(badge)
    item.appendChild(head)

    const sql = document.createElement('pre')
    sql.className = 'sql-library-sql'
    sql.textContent = spec.sql
    item.appendChild(sql)

    const meta = document.createElement('div')
    meta.className = 'sql-library-meta'
    meta.textContent = spec.meta
    item.appendChild(meta)

    if (spec.detail) {
      const detail = document.createElement('div')
      detail.className = 'sql-library-detail'
      detail.textContent = spec.detail
      item.appendChild(detail)
    }

    const actions = document.createElement('div')
    actions.className = 'sql-library-actions'
    for (const action of spec.actions) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = action.label
      button.title = action.title
      if (action.danger) button.classList.add('is-danger')
      button.addEventListener('click', action.run)
      actions.appendChild(button)
    }
    item.appendChild(actions)
    return item
  }

  #load(sql: string): void {
    this.#cb.loadSql(sql)
    this.close()
  }

  #run(sql: string): void {
    this.close()
    this.#cb.runSql(sql)
  }

  #openSaveDialog(entry: SavedSql | null, sql: string): void {
    this.#editingSavedId = entry?.id ?? null
    this.#saveTitle.textContent = entry ? '编辑收藏' : '保存为收藏'
    this.#saveName.value = entry?.name ?? ''
    this.#saveError.hidden = true
    this.#saveForm.dataset['sql'] = sql
    this.#saveDialog.showModal()
    this.#saveName.focus()
    this.#saveName.select()
  }

  async #submitSave(): Promise<void> {
    const name = this.#saveName.value.trim()
    const sql = this.#saveForm.dataset['sql'] ?? ''
    const editingSavedId = this.#editingSavedId
    if (name === '') {
      this.#saveError.textContent = '请填写收藏名称'
      this.#saveError.hidden = false
      return
    }
    try {
      await this.#cb.save(editingSavedId, name, sql)
      this.#closeSaveDialog()
      await this.reload()
      this.#cb.onStatus(editingSavedId === null ? '已保存到收藏' : '已更新收藏')
    } catch (err) {
      this.#saveError.textContent = errText(err)
      this.#saveError.hidden = false
    }
  }

  #closeSaveDialog(): void {
    if (this.#saveDialog.open) this.#saveDialog.close()
  }

  async #removeSaved(entry: SavedSql): Promise<void> {
    if (!globalThis.confirm(`确定删除收藏「${entry.name}」？`)) return
    try {
      await this.#cb.removeSaved(entry.id)
      await this.reload()
      this.#cb.onStatus(`已删除收藏：${entry.name}`)
    } catch (err) {
      this.#cb.onStatus(`删除收藏失败：${errText(err)}`, true)
    }
  }

  async #clearHistory(): Promise<void> {
    if (!globalThis.confirm('确定清空全部 SQL 执行历史？收藏不会被删除。')) return
    try {
      await this.#cb.clearHistory()
      await this.reload()
      this.#cb.onStatus('已清空 SQL 执行历史')
    } catch (err) {
      this.#cb.onStatus(`清空历史失败：${errText(err)}`, true)
    }
  }
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`页面缺少必需元素: #${id}`)
  return node as T
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sqlPreview(sql: string, max = 100): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '未知时间'
  return date.toLocaleString('zh-CN', { hour12: false })
}

function matchesHistory(entry: SqlHistoryEntry, query: string): boolean {
  if (query === '') return true
  return `${entry.sql}\n${entry.connectionName}\n${entry.dialectId}`
    .toLowerCase()
    .includes(query)
}

function matchesSaved(entry: SavedSql, query: string): boolean {
  if (query === '') return true
  return `${entry.name}\n${entry.sql}`.toLowerCase().includes(query)
}
