/**
 * 结构 / 数据比较面板（P5）。
 *
 * 只展示比较结果与同步 SQL，不提供“执行”按钮：同步 SQL 只能复制出去，
 * 由用户在 SQL 编辑器里自己审阅后执行。删除类语句会被单独标红并计数。
 */

import type { ConnectionSummary, DbStudioApi } from '../core/api'
import { NodeId } from '../core/api'
import {
  describeCoverage,
  diffSchema,
  summarizeValue,
  type CompareDialect,
  type DataCompareResult,
  type SchemaSnapshot,
  type StructureDiff
} from '../core/compare'

export interface ComparePanelOptions {
  readonly api: DbStudioApi
  readonly onStatus: (message: string, isError?: boolean) => void
}

let activeOverlay: HTMLElement | null = null

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  if (text !== undefined) node.textContent = text
  return node
}

export function openComparePanel(options: ComparePanelOptions): void {
  const { api, onStatus } = options
  activeOverlay?.remove()

  const overlay = h('div', { id: 'dbstudio-compare', role: 'dialog', 'aria-modal': 'true', 'aria-label': '结构与数据比较', class: 'compare-overlay' })
  const panel = h('div', { class: 'compare-panel' })
  const head = h('div', { class: 'compare-head' })
  const close = h('button', { type: 'button', 'aria-label': '关闭', 'data-testid': 'compare-close' }, '✕')
  head.append(h('span', {}, '结构 / 数据比较（只生成 SQL，不执行）'), close)

  const form = h('div', { class: 'compare-form' })
  const mode = h('select', { 'data-testid': 'compare-mode' })
  mode.append(new Option('结构比较', 'structure'), new Option('数据比较', 'data'))
  const sourceConn = h('select', { 'data-testid': 'compare-source' })
  const targetConn = h('select', { 'data-testid': 'compare-target' })
  const sourceTable = h('select', { 'data-testid': 'compare-source-table' })
  const targetTable = h('select', { 'data-testid': 'compare-target-table' })
  const keyInput = h('input', { type: 'text', placeholder: '比较键列（逗号分隔，留空用主键）', 'data-testid': 'compare-key' })
  const run = h('button', { type: 'button', 'data-testid': 'compare-run' }, '比较')
  const tableRow = h('div', { class: 'compare-row compare-data-only' })
  tableRow.append(h('label', {}, '源表'), sourceTable, h('label', {}, '目标表'), targetTable, keyInput)
  const connRow = h('div', { class: 'compare-row' })
  connRow.append(mode, h('label', {}, '源'), sourceConn, h('label', {}, '目标'), targetConn, run)
  form.append(connRow, tableRow)

  const summary = h('div', { class: 'compare-summary', 'data-testid': 'compare-summary' })
  const details = h('div', { class: 'compare-details', 'data-testid': 'compare-details' })
  const sql = h('textarea', { class: 'compare-sql', readonly: '', spellcheck: 'false', 'data-testid': 'compare-sql' })
  const copy = h('button', { type: 'button', 'data-testid': 'compare-copy', disabled: '' }, '复制同步 SQL')
  const foot = h('div', { class: 'compare-foot' })
  foot.append(h('span', { class: 'compare-hint' }, '同步 SQL 需在 SQL 编辑器中自行审阅后执行。'), copy)

  panel.append(head, form, summary, details, sql, foot)
  overlay.append(panel)
  document.body.append(overlay)
  activeOverlay = overlay

  const dispose = (): void => {
    overlay.remove()
    if (activeOverlay === overlay) activeOverlay = null
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') dispose()
  }
  document.addEventListener('keydown', onKey)
  close.addEventListener('click', dispose)

  let connections: ConnectionSummary[] = []
  const syncMode = (): void => {
    tableRow.hidden = mode.value !== 'data'
  }
  let tableRequest = 0
  const loadTables = async (connId: string, select: HTMLSelectElement): Promise<void> => {
    const token = ++tableRequest
    select.replaceChildren()
    if (!connId) return
    try {
      const snapshot = await api.captureSchemaSnapshot(connId)
      // 快速切换连接时，旧请求可能后返回；只认最后一次，避免下拉框里
      // 留下别的连接的表节点 id（那会让比较把两张不相干的表对齐）。
      if (token !== tableRequest) return
      for (const table of snapshot.tables) {
        const label = table.schema ? `${table.schema}.${table.name}` : table.name
        select.append(new Option(label, NodeId.scoped(connId, table.id)))
      }
    } catch (error) {
      if (token === tableRequest) onStatus(`读取表列表失败：${(error as Error).message}`, true)
    }
  }

  const fillConnections = async (): Promise<void> => {
    connections = (await api.listConnections()).filter((c) => c.connected)
    for (const select of [sourceConn, targetConn]) {
      select.replaceChildren()
      for (const c of connections) select.append(new Option(`${c.name}（${c.dialectId}）`, c.id))
    }
    if (connections.length > 1) targetConn.selectedIndex = 1
    if (connections.length === 0) summary.textContent = '没有已连接的数据源，请先连接至少一个。'
    await Promise.all([loadTables(sourceConn.value, sourceTable), loadTables(targetConn.value, targetTable)])
  }

  mode.addEventListener('change', syncMode)
  sourceConn.addEventListener('change', () => void loadTables(sourceConn.value, sourceTable))
  targetConn.addEventListener('change', () => void loadTables(targetConn.value, targetTable))
  copy.addEventListener('click', () => {
    const clipboard = navigator.clipboard
    if (!clipboard) {
      onStatus('当前环境不支持剪贴板，请手动选择文本复制', true)
      return
    }
    void clipboard.writeText(sql.value).then(
      () => onStatus('同步 SQL 已复制'),
      () => onStatus('复制失败，请手动选择文本复制', true)
    )
  })

  const showStatements = (statements: readonly string[]): void => {
    sql.value = statements.map((s) => `${s};`).join('\n')
    copy.disabled = statements.length === 0
  }

  const renderStructure = (diff: StructureDiff, left: SchemaSnapshot, right: SchemaSnapshot): void => {
    const drops = diff.changes.filter((c) => c.destructive).length
    // 没有差异时**不能**只说"结构一致"：视图定义和例程往往没参与比较。
    summary.textContent = diff.changes.length === 0
      ? `表与视图的增删一致，没有差异。${describeCoverage(left, right)}`
      : `共 ${diff.changes.length} 处差异，其中 ${drops} 处包含删除或类型变更（危险）。`
    summary.classList.toggle('danger', diff.destructive)
    const warningRows = diff.warnings.map((text) => {
      const row = h('div', { class: 'compare-item warning' })
      row.textContent = `⚠ ${text}`
      return row
    })
    details.replaceChildren(
      ...warningRows,
      ...diff.changes.map((change) => {
        const row = h('div', { class: `compare-item${change.destructive ? ' danger' : ''}` })
        row.textContent = `${change.kind.toUpperCase()} ${change.objectType} ${change.target}`
        return row
      })
    )
    showStatements(diff.statements)
  }

  const renderData = (result: DataCompareResult): void => {
    const { plan } = result
    summary.textContent =
      `比较键：${result.keyColumns.join(', ')}。INSERT ${plan.insertCount} · UPDATE ${plan.updateCount} · DELETE ${plan.deleteCount}` +
      (plan.warnings.length > 0 ? `。${plan.warnings.join(' ')}` : '')
    summary.classList.toggle('danger', plan.destructive)
    const differing = result.rows.filter((r) => r.status !== 'same')
    const visible = differing.slice(0, 500)
    const truncatedRows = differing.length > visible.length
      ? [(() => {
          const row = h('div', { class: 'compare-item warning' })
          row.textContent = `⚠ 仅显示前 500 条差异，共 ${differing.length} 条；同步 SQL 仍是完整的。`
          return row
        })()]
      : []
    details.replaceChildren(
      ...truncatedRows,
      ...visible.map((row) => {
        const item = h('div', { class: `compare-item${row.status === 'target-only' ? ' danger' : ''}` })
        const key = Object.entries(row.key).map(([k, v]) => `${k}=${summarizeValue(v)}`).join(', ')
        const label = { 'source-only': '仅源端', 'target-only': '仅目标端', different: '不同', same: '相同' }[row.status]
        const changes = (row.valueChanges ?? [])
          .map((change) => `${change.column}: ${change.source} → ${change.target}`)
          .join('；')
        item.textContent =
          `${label} · ${key}` + (changes !== '' ? ` · ${changes}` : row.columns.length > 0 ? ` · 列：${row.columns.join(', ')}` : '')
        return item
      })
    )
    showStatements(plan.statements)
  }

  run.addEventListener('click', () => {
    void (async () => {
      run.disabled = true
      summary.textContent = '比较中…'
      details.replaceChildren()
      showStatements([])
      try {
        const target = connections.find((c) => c.id === targetConn.value)
        const source = connections.find((c) => c.id === sourceConn.value)
        if (!source || !target) throw new Error('请选择源和目标连接')
        const sourceDialect = source.dialectId
        if (mode.value === 'structure') {
          if (target.dialectId !== 'sqlite' && target.dialectId !== 'postgresql') {
            throw new Error(`结构比较暂不支持 ${target.dialectId}`)
          }
          const [left, right] = await Promise.all([
            api.captureSchemaSnapshot(sourceConn.value),
            api.captureSchemaSnapshot(target.id)
          ])
          if (sourceDialect !== target.dialectId) {
            throw new Error(`结构比较要求同一方言（源 ${sourceDialect} → 目标 ${target.dialectId}）`)
          }
          renderStructure(diffSchema(left, right, target.dialectId as CompareDialect), left, right)
        } else {
          if (!sourceTable.value || !targetTable.value) throw new Error('请选择源表和目标表')
          const keyColumns = keyInput.value.split(',').map((s) => s.trim()).filter(Boolean)
          renderData(await api.compareTableData({
            sourceTableNodeId: sourceTable.value,
            targetTableNodeId: targetTable.value,
            ...(keyColumns.length > 0 ? { keyColumns } : {})
          }))
        }
      } catch (error) {
        summary.textContent = `比较失败：${(error as Error).message}`
        summary.classList.add('danger')
      } finally {
        run.disabled = false
      }
    })()
  })

  syncMode()
  void fillConnections().catch((error: unknown) => onStatus(`读取连接失败：${(error as Error).message}`, true))
}
