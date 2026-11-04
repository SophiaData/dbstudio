/**
 * ER 图：用零依赖 SVG 展示表、列和真实外键关系。
 *
 * 关系线只来自 TableDescription.foreignKeys。缺少该字段时显示“不可用”，
 * 空数组时显示“无外键关系”，两种状态不能混淆。
 */

import type { BackendClient } from '../backend/backend-client'
import type { ObjectRef, TableDescription, ColumnDescription } from '../core/model'
import {
  computeErRelations,
  erRelationStatus,
  type ErRelation,
  type ErRelationSummary
} from './er-relations'
import {
  buildErLayoutKey,
  loadErLayout,
  saveErLayout
} from './er-layout'

/** 一次最多读取多少张表的完整结构。 */
export const MAX_ER_TABLES = 100

const BOX_W = 220
const TITLE_H = 26
const ROW_H = 20
const GAP_X = 32
const GAP_Y = 28
const PER_ROW = 3
const PAD = 24
const NOTE_H = 24

interface EntityBox {
  readonly ref: ObjectRef
  readonly desc: TableDescription
  readonly schema: string | null
}

export interface CollectedTable {
  readonly ref: ObjectRef
  readonly schema: string | null
}

interface EntityPosition {
  x: number
  y: number
  readonly h: number
}

export interface ErDiagramCallbacks {
  onStatus(text: string, isError?: boolean): void
  onOpenTable(ref: ObjectRef): void
}

export function filterErTables(
  tables: readonly CollectedTable[],
  query: string
): readonly CollectedTable[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (normalized === '') return tables
  return tables.filter((table) =>
    `${table.schema ?? ''}.${table.ref.name}`.toLocaleLowerCase().includes(normalized)
  )
}

export async function renderErDiagram(
  container: HTMLElement,
  api: BackendClient,
  connectionRef: ObjectRef,
  cb: ErDiagramCallbacks,
  onBack?: () => void
): Promise<void> {
  container.replaceChildren()
  container.classList.add('er-diagram')

  const head = document.createElement('div')
  head.className = 'er-head'
  const title = document.createElement('span')
  title.className = 'er-title'
  title.textContent = `ER 图 · ${connectionRef.name}`
  head.appendChild(title)

  const back = document.createElement('button')
  back.type = 'button'
  back.textContent = '← 返回'
  back.className = 'er-back'
  back.hidden = !onBack
  if (onBack) back.addEventListener('click', onBack)
  head.appendChild(back)

  const exportButton = document.createElement('button')
  exportButton.type = 'button'
  exportButton.className = 'er-export'
  exportButton.textContent = '导出 SVG'
  exportButton.setAttribute('data-er-export', 'true')
  exportButton.disabled = true
  head.appendChild(exportButton)
  container.appendChild(head)

  const pickerHost = document.createElement('div')
  pickerHost.className = 'er-picker-host'
  container.appendChild(pickerHost)

  const scroll = document.createElement('div')
  scroll.className = 'er-scroll'
  container.appendChild(scroll)

  try {
    cb.onStatus('正在统计表数量…')
    const tables = await collectTables(api, connectionRef)
    if (tables.length === 0) {
      cb.onStatus('该连接下没有可绘制的表')
      renderEmpty(scroll)
      return
    }

    const selection = renderPicker(pickerHost, tables)
    let renderGeneration = 0
    const renderSelected = async (): Promise<void> => {
      const generation = ++renderGeneration
      selection.message.hidden = true
      const selected = tables.filter((table) => selection.selectedIds.has(table.ref.id))
      if (selected.length === 0) {
        scroll.replaceChildren()
        exportButton.disabled = true
        renderPickerMessage(selection.message, '请至少选择一张表')
        cb.onStatus('请至少选择一张表后再绘制 ER 图', true)
        return
      }
      if (selected.length > MAX_ER_TABLES) {
        scroll.replaceChildren()
        exportButton.disabled = true
        renderPickerMessage(
          selection.message,
          `当前选择 ${selected.length} 张表，最多绘制 ${MAX_ER_TABLES} 张，请先筛选或取消部分选择`
        )
        cb.onStatus(`选择的表过多（${selected.length} 张），请先筛选`, true)
        return
      }

      cb.onStatus(`正在读取 ${selected.length} 张表的结构…`)
      const boxes: EntityBox[] = []
      let failedTables = 0
      for (const table of selected) {
        try {
          const desc = await api.describeTable(table.ref.id)
          if (generation !== renderGeneration) return
          boxes.push({ ref: table.ref, desc, schema: table.schema })
        } catch (e) {
          if (generation !== renderGeneration) return
          failedTables += 1
          cb.onStatus(`读取表「${table.ref.name}」结构失败，已跳过：${errText(e)}`, true)
        }
      }
      if (generation !== renderGeneration) return
      scroll.replaceChildren()
      if (boxes.length === 0) {
        exportButton.disabled = true
        renderEmpty(scroll)
        return
      }

      const layoutKey = buildErLayoutKey(
        connectionRef.id,
        selected.map((table) => table.schema)
      )
      const svg = buildSvg(boxes, cb, layoutKey)
      scroll.appendChild(svg)
      exportButton.disabled = false
      const summary = computeSummary(boxes)
      const relationStatus = erRelationStatus(summary)
      const failureSuffix = failedTables > 0 ? `；${failedTables} 张表读取失败，图不完整` : ''
      cb.onStatus(
        `ER 图已生成：${boxes.length} 张表；${relationStatus.text}${failureSuffix}`,
        relationStatus.warn || failedTables > 0
      )
    }

    wirePicker(selection, tables, renderSelected)
    exportButton.addEventListener('click', () => {
      const svg = scroll.querySelector<SVGSVGElement>('svg[data-er-root]')
      if (!svg) {
        cb.onStatus('当前没有可导出的 ER 图', true)
        return
      }
      if (!exportSvg(svg, `dbstudio-er-${safeFileName(connectionRef.name)}.svg`)) {
        cb.onStatus('导出 SVG 失败：当前环境不支持文件下载', true)
        return
      }
      cb.onStatus('ER 图 SVG 已开始下载')
    })

    if (tables.length > MAX_ER_TABLES) {
      selection.selectedIds.clear()
      updatePickerCount(selection.count, selection.selectedIds, tables)
      renderPickerMessage(
        selection.message,
        `发现 ${tables.length} 张表。请先搜索并选择不超过 ${MAX_ER_TABLES} 张表，再绘制 ER 图。`
      )
      cb.onStatus(`表太多（${tables.length} 张），请先筛选后再查看 ER 图`, true)
    } else {
      await renderSelected()
    }
  } catch (e) {
    cb.onStatus(`生成 ER 图失败：${errText(e)}`, true)
    const err = document.createElement('div')
    err.className = 'er-error'
    err.textContent = `生成 ER 图失败：${errText(e)}`
    scroll.appendChild(err)
  }
}

async function collectTables(api: BackendClient, root: ObjectRef): Promise<CollectedTable[]> {
  const out: CollectedTable[] = []
  const walk = async (node: ObjectRef, depth: number, schema: string | null): Promise<void> => {
    if (depth > 8) return
    const currentSchema = node.kind === 'schema' ? node.name : schema
    const children = await api.listChildren(node.id)
    for (const child of children) {
      if (child.kind === 'table') {
        out.push({ ref: child, schema: currentSchema })
      } else if (child.kind !== 'view' && child.hasChildren) {
        await walk(child, depth + 1, currentSchema)
      }
    }
  }
  await walk(root, 0, null)
  return out
}

interface ErPickerState {
  readonly selectedIds: Set<string>
  readonly search: HTMLInputElement
  readonly count: HTMLElement
  readonly message: HTMLElement
  readonly options: readonly HTMLElement[]
  readonly checkboxes: readonly HTMLInputElement[]
  readonly selectVisible: HTMLButtonElement
  readonly clearVisible: HTMLButtonElement
  readonly draw: HTMLButtonElement
}

function renderPicker(host: HTMLElement, tables: readonly CollectedTable[]): ErPickerState {
  host.replaceChildren()
  const picker = document.createElement('section')
  picker.className = 'er-picker'
  picker.setAttribute('aria-label', 'ER 图表选择')

  const controls = document.createElement('div')
  controls.className = 'er-picker-controls'
  const searchLabel = document.createElement('label')
  searchLabel.className = 'er-picker-search'
  searchLabel.textContent = '筛选表'
  const search = document.createElement('input')
  search.type = 'search'
  search.placeholder = '表名或 schema'
  search.setAttribute('data-er-search', 'true')
  searchLabel.appendChild(search)
  controls.appendChild(searchLabel)

  const count = document.createElement('span')
  count.className = 'er-picker-count'
  controls.appendChild(count)

  const selectVisible = pickerButton('全选当前结果', 'data-er-select-visible')
  const clearVisible = pickerButton('清空当前结果', 'data-er-clear-visible')
  const draw = pickerButton('绘制 ER 图', 'data-er-draw')
  controls.append(selectVisible, clearVisible, draw)
  picker.appendChild(controls)

  const message = document.createElement('div')
  message.className = 'er-picker-message'
  message.hidden = true
  message.setAttribute('role', 'status')
  picker.appendChild(message)

  const list = document.createElement('div')
  list.className = 'er-picker-list'
  list.setAttribute('role', 'group')
  const schemas = [...new Set(tables.map((table) => table.schema).filter((schema) => schema !== null))]
  const defaultSchema = schemas[0] ?? null
  const selectedIds = new Set(
    tables
      .filter((table) => table.schema === null || table.schema === defaultSchema)
      .map((table) => table.ref.id)
  )
  const options: HTMLElement[] = []
  const checkboxes: HTMLInputElement[] = []
  for (const table of tables) {
    const option = document.createElement('label')
    option.className = 'er-picker-option'
    option.setAttribute('data-er-table-option', table.ref.id)
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = selectedIds.has(table.ref.id)
    checkbox.setAttribute('data-er-table-checkbox', table.ref.id)
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedIds.add(table.ref.id)
      else selectedIds.delete(table.ref.id)
      updatePickerCount(count, selectedIds, tables)
    })
    const name = document.createElement('span')
    name.textContent = formatTableName(table.schema, table.ref.name)
    option.append(checkbox, name)
    list.appendChild(option)
    options.push(option)
    checkboxes.push(checkbox)
  }
  picker.appendChild(list)
  host.appendChild(picker)
  updatePickerCount(count, selectedIds, tables)
  return { selectedIds, search, count, message, options, checkboxes, selectVisible, clearVisible, draw }
}

function wirePicker(
  state: ErPickerState,
  tables: readonly CollectedTable[],
  renderSelected: () => Promise<void>
): void {
  const updateVisibility = (): void => {
    const visible = filterErTables(tables, state.search.value)
    const visibleIds = new Set(visible.map((table) => table.ref.id))
    for (const option of state.options) {
      option.hidden = !visibleIds.has(option.getAttribute('data-er-table-option') ?? '')
    }
    updatePickerCount(state.count, state.selectedIds, tables, visible.length)
  }
  state.search.addEventListener('input', updateVisibility)
  state.selectVisible.addEventListener('click', () => {
    const visible = filterErTables(tables, state.search.value)
    for (const table of visible) state.selectedIds.add(table.ref.id)
    syncPickerCheckboxes(state, tables)
    updateVisibility()
  })
  state.clearVisible.addEventListener('click', () => {
    const visible = filterErTables(tables, state.search.value)
    for (const table of visible) state.selectedIds.delete(table.ref.id)
    syncPickerCheckboxes(state, tables)
    updateVisibility()
  })
  state.draw.addEventListener('click', () => void renderSelected())
  updateVisibility()
}

function syncPickerCheckboxes(state: ErPickerState, tables: readonly CollectedTable[]): void {
  for (let i = 0; i < tables.length; i += 1) {
    const table = tables[i]
    const checkbox = state.checkboxes[i]
    if (table && checkbox) checkbox.checked = state.selectedIds.has(table.ref.id)
  }
}

function updatePickerCount(
  count: HTMLElement,
  selectedIds: ReadonlySet<string>,
  tables: readonly CollectedTable[],
  visibleCount = tables.length
): void {
  count.textContent = `已选 ${selectedIds.size} 张 · 当前显示 ${visibleCount} 张`
}

function pickerButton(label: string, attribute: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.setAttribute(attribute, 'true')
  return button
}

function renderPickerMessage(message: HTMLElement, text: string): void {
  message.hidden = false
  message.textContent = text
}

function renderLimitNotice(host: HTMLElement, total: number): void {
  const box = document.createElement('div')
  box.className = 'er-limit'
  box.setAttribute('role', 'alert')
  box.textContent =
    `表太多（${total} 张），请先筛选后再查看 ER 图。` +
    `一次最多绘制 ${MAX_ER_TABLES} 张表。`
  host.appendChild(box)
}

function renderEmpty(host: HTMLElement): void {
  const box = document.createElement('div')
  box.className = 'er-empty'
  box.textContent = '没有可绘制的表。'
  host.appendChild(box)
}

function buildSvg(
  boxes: readonly EntityBox[],
  cb: ErDiagramCallbacks,
  layoutKey: string
): SVGSVGElement {
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const rows: EntityBox[][] = []
  for (let i = 0; i < boxes.length; i += PER_ROW) rows.push(boxes.slice(i, i + PER_ROW))

  const positions = new Map<string, EntityPosition>()
  const saved = loadErLayout(
    localStorage,
    layoutKey,
    boxes.map((box) => box.ref.id)
  )
  let y = PAD
  for (const row of rows) {
    const heights = row.map((box) => entityHeight(box.desc))
    const rowH = Math.max(...heights)
    row.forEach((box, i) => {
      const fallback = { x: PAD + i * (BOX_W + GAP_X), y }
      const stored = saved[box.ref.id]
      positions.set(box.ref.id, {
        x: finitePosition(stored?.x, fallback.x),
        y: finitePosition(stored?.y, fallback.y),
        h: heights[i] ?? rowH
      })
    })
    y += rowH + GAP_Y
  }

  const width = Math.max(
    PAD * 2 + Math.min(PER_ROW, boxes.length) * BOX_W + (Math.min(PER_ROW, boxes.length) - 1) * GAP_X,
    maxPosition(boxes, positions, 'x') + BOX_W + PAD
  )
  const height = Math.max(
    y - GAP_Y + PAD + NOTE_H,
    maxPosition(boxes, positions, 'y') + maxHeight(boxes, positions) + PAD + NOTE_H
  )

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'er-svg')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('data-er-root', 'true')

  const defs = document.createElementNS(SVG_NS, 'defs')
  const marker = document.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', 'er-arrow')
  marker.setAttribute('viewBox', '0 0 10 10')
  marker.setAttribute('refX', '9')
  marker.setAttribute('refY', '5')
  marker.setAttribute('markerWidth', '6')
  marker.setAttribute('markerHeight', '6')
  marker.setAttribute('orient', 'auto-start-reverse')
  const arrow = document.createElementNS(SVG_NS, 'path')
  arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z')
  arrow.setAttribute('class', 'er-relation-arrow')
  marker.appendChild(arrow)
  defs.appendChild(marker)
  svg.appendChild(defs)

  const status = document.createElementNS(SVG_NS, 'text')
  status.setAttribute('x', String(PAD))
  status.setAttribute('y', String(PAD))
  status.setAttribute('class', 'er-note')
  const summary = computeSummary(boxes)
  const relationStatus = erRelationStatus(summary)
  status.dataset.erStatus = relationStatus.kind
  status.dataset.erSkippedCount = String(summary.skipped.length)
  status.textContent = relationStatus.text
  svg.appendChild(status)

  const relationLayer = document.createElementNS(SVG_NS, 'g')
  relationLayer.setAttribute('class', 'er-relations')
  svg.appendChild(relationLayer)
  const entityLayer = document.createElementNS(SVG_NS, 'g')
  entityLayer.setAttribute('class', 'er-entities')
  svg.appendChild(entityLayer)

  const drawRelations = (): void => {
    relationLayer.replaceChildren()
    relationLayer.appendChild(drawEdges(boxes, summary, positions, SVG_NS))
  }

  drawRelations()
  for (const box of boxes) {
    const position = positions.get(box.ref.id)
    if (!position) continue
    entityLayer.appendChild(
      drawEntity(box, position, SVG_NS, cb, () => {
        drawRelations()
        expandSvg(svg, boxes, positions)
        saveErLayout(localStorage, layoutKey, positions)
      })
    )
  }

  return svg
}

function drawEdges(
  boxes: readonly EntityBox[],
  summary: ErRelationSummary,
  positions: ReadonlyMap<string, EntityPosition>,
  ns: string
): SVGGElement {
  const layer = document.createElementNS(ns, 'g') as SVGGElement
  layer.setAttribute('class', 'er-relation-set')
  const byId = new Map(boxes.map((box) => [box.ref.id, box]))

  for (const relation of summary.relations) {
      const source = byId.get(relation.from.tableId)
      const target = byId.get(relation.to.tableId)
      const sourcePos = source ? positions.get(source.ref.id) : undefined
      const targetPos = target ? positions.get(target.ref.id) : undefined
      if (!source || !target || !sourcePos || !targetPos) continue

      const sourcePoint = columnPoint(
        source,
        sourcePos,
        relation.columnPairs[0]?.column ?? null,
        targetPos.x >= sourcePos.x
      )
      const targetPoint = columnPoint(
        target,
        targetPos,
        relation.columnPairs[0]?.referencedColumn ?? null,
        targetPos.x < sourcePos.x
      )
      const path = document.createElementNS(ns, 'path') as SVGPathElement
      path.setAttribute('class', 'er-relation')
      path.setAttribute('d', curvePath(sourcePoint.x, sourcePoint.y, targetPoint.x, targetPoint.y))
      path.setAttribute('marker-end', 'url(#er-arrow)')
      path.setAttribute('data-er-edge', relation.id)
      path.setAttribute('data-source-table', formatTableName(relation.from.schema, relation.from.tableName))
      path.setAttribute('data-target-table', formatTableName(relation.to.schema, relation.to.tableName))
      path.setAttribute(
        'data-columns',
        relation.columnPairs.map((pair) => `${pair.column} → ${pair.referencedColumn}`).join(', ')
      )

      const title = document.createElementNS(ns, 'title')
      title.textContent = relationTitle(relation)
      path.appendChild(title)
      layer.appendChild(path)

      const label = document.createElementNS(ns, 'text') as SVGTextElement
      label.setAttribute('class', 'er-relation-label')
      label.setAttribute('x', String((sourcePoint.x + targetPoint.x) / 2))
      label.setAttribute('y', String((sourcePoint.y + targetPoint.y) / 2 - 5))
      label.setAttribute('data-er-edge', relation.id)
      label.textContent = relation.columnPairs
        .map((pair) => `${pair.column}→${pair.referencedColumn}`)
        .join(' · ')
      label.setAttribute('data-source-table', formatTableName(relation.from.schema, relation.from.tableName))
      label.setAttribute('data-target-table', formatTableName(relation.to.schema, relation.to.tableName))
      layer.appendChild(label)
  }
  return layer
}

function drawEntity(
  box: EntityBox,
  position: EntityPosition,
  ns: string,
  cb: ErDiagramCallbacks,
  onMove: () => void
): SVGGElement {
  const g = document.createElementNS(ns, 'g') as SVGGElement
  g.setAttribute('class', 'er-entity')
  g.setAttribute('transform', `translate(${position.x},${position.y + NOTE_H})`)
  g.setAttribute('role', 'button')
  g.setAttribute('tabindex', '0')
  g.dataset.tableId = box.ref.id
  g.dataset.tableName = box.ref.name
  if (box.schema !== null) g.dataset.schema = box.schema

  const accTitle = document.createElementNS(ns, 'title')
  accTitle.textContent = `表 ${box.ref.name}，${box.desc.columns.length} 列`
  g.appendChild(accTitle)

  const rect = document.createElementNS(ns, 'rect')
  rect.setAttribute('width', String(BOX_W))
  rect.setAttribute('height', String(position.h))
  rect.setAttribute('rx', '6')
  rect.setAttribute('class', 'er-entity-rect')
  g.appendChild(rect)

  const titleBg = document.createElementNS(ns, 'rect')
  titleBg.setAttribute('width', String(BOX_W))
  titleBg.setAttribute('height', String(TITLE_H))
  titleBg.setAttribute('rx', '6')
  titleBg.setAttribute('class', 'er-entity-title-bg')
  g.appendChild(titleBg)

  const titleText = document.createElementNS(ns, 'text')
  titleText.setAttribute('x', '10')
  titleText.setAttribute('y', String(TITLE_H / 2 + 5))
  titleText.setAttribute('class', 'er-entity-title')
  titleText.textContent = truncate(box.ref.name, 26)
  titleText.appendChild(cmakeTitle(ns, box.ref.name))
  g.appendChild(titleText)

  const shown: readonly ColumnDescription[] = box.desc.columns.slice(
    0,
    Math.max(1, Math.floor((position.h - TITLE_H - 8) / ROW_H))
  )
  shown.forEach((col, i) => {
    const rowY = TITLE_H + 4 + i * ROW_H
    const t = document.createElementNS(ns, 'text') as SVGTextElement
    t.setAttribute('x', '10')
    t.setAttribute('y', String(rowY + 14))
    t.setAttribute('class', 'er-col')
    t.setAttribute('data-column-name', col.name)
    const pk = col.primaryKeyOrdinal !== null
    t.textContent = `${pk ? '🔑 ' : '   '}${truncate(col.name, 20)}`
    t.appendChild(cmakeTitle(ns, `${col.name} : ${col.typeName}${pk ? '（主键）' : ''}`))
    g.appendChild(t)

    const typeT = document.createElementNS(ns, 'text')
    typeT.setAttribute('x', String(BOX_W - 10))
    typeT.setAttribute('y', String(rowY + 14))
    typeT.setAttribute('text-anchor', 'end')
    typeT.setAttribute('class', 'er-col-type')
    typeT.textContent = truncate(col.typeName, 12)
    g.appendChild(typeT)
  })

  let moved = false
  let suppressClick = false
  let pointerStart: { x: number; y: number; px: number; py: number } | null = null
  g.addEventListener('pointerdown', (event) => {
    pointerStart = { x: position.x, y: position.y, px: event.clientX, py: event.clientY }
    moved = false
    g.setPointerCapture?.(event.pointerId)
    event.stopPropagation()
  })
  g.addEventListener('pointermove', (event) => {
    if (!pointerStart) return
    const dx = event.clientX - pointerStart.px
    const dy = event.clientY - pointerStart.py
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
    if (!moved) return
    position.x = Math.max(PAD, pointerStart.x + dx)
    position.y = Math.max(0, pointerStart.y + dy)
    g.setAttribute('transform', `translate(${position.x},${position.y + NOTE_H})`)
    onMove()
  })
  g.addEventListener('pointerup', (event) => {
    if (pointerStart && moved) {
      suppressClick = true
      onMove()
    }
    pointerStart = null
    g.releasePointerCapture?.(event.pointerId)
  })
  g.addEventListener('pointercancel', () => {
    pointerStart = null
  })

  const open = (): void => {
    if (suppressClick) {
      suppressClick = false
      return
    }
    cb.onOpenTable(box.ref)
  }
  g.addEventListener('click', open)
  g.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      open()
    }
  })
  return g
}

function columnPoint(
  box: EntityBox,
  position: EntityPosition,
  column: string | null,
  rightSide: boolean
): { x: number; y: number } {
  const index = column === null ? 0 : box.desc.columns.findIndex((item) => item.name === column)
  const row = index < 0 ? 0 : index
  return {
    x: position.x + (rightSide ? BOX_W : 0),
    y: position.y + NOTE_H + TITLE_H + 4 + row * ROW_H + ROW_H / 2
  }
}

function curvePath(sx: number, sy: number, tx: number, ty: number): string {
  const bend = Math.max(36, Math.abs(tx - sx) * 0.45)
  const c1x = sx + (tx >= sx ? bend : -bend)
  const c2x = tx - (tx >= sx ? bend : -bend)
  return `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`
}

function relationTitle(relation: ErRelation): string {
  const pairs = relation.columnPairs
    .map((pair) => `${pair.column} → ${pair.referencedColumn}`)
    .join(', ')
  const rules = [
    relation.constraintName ? `约束 ${relation.constraintName}` : '',
    relation.onDelete ? `删除 ${relation.onDelete}` : '',
    relation.onUpdate ? `更新 ${relation.onUpdate}` : ''
  ].filter(Boolean)
  return (
    `${formatTableName(relation.from.schema, relation.from.tableName)} → ` +
    `${formatTableName(relation.to.schema, relation.to.tableName)}：${pairs}` +
    `${rules.length ? `（${rules.join('，')}）` : ''}`
  )
}

function computeSummary(boxes: readonly EntityBox[]): ErRelationSummary {
  return computeErRelations(boxes.map(({ ref, desc }) => ({ ref, desc })))
}

function entityHeight(desc: TableDescription): number {
  return TITLE_H + Math.max(1, desc.columns.length) * ROW_H + 8
}

function formatTableName(schema: string | null, name: string): string {
  return schema === null ? name : `${schema}.${name}`
}

function exportSvg(svg: SVGSVGElement, fileName: string): boolean {
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return false
  }
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('version', '1.1')
  const source = new XMLSerializer().serializeToString(clone)
  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    return true
  } finally {
    URL.revokeObjectURL(url)
  }
}

function safeFileName(name: string): string {
  const value = name.trim().replace(/[\\/:*?"<>|]+/g, '_')
  return value === '' ? 'connection' : value
}

function maxPosition(
  boxes: readonly EntityBox[],
  positions: ReadonlyMap<string, EntityPosition>,
  axis: 'x' | 'y'
): number {
  return Math.max(...boxes.map((box) => positions.get(box.ref.id)?.[axis] ?? 0), 0)
}

function maxHeight(boxes: readonly EntityBox[], positions: ReadonlyMap<string, EntityPosition>): number {
  return Math.max(...boxes.map((box) => positions.get(box.ref.id)?.h ?? entityHeight(box.desc)), 0)
}

function expandSvg(
  svg: SVGSVGElement,
  boxes: readonly EntityBox[],
  positions: ReadonlyMap<string, EntityPosition>
): void {
  const currentWidth = Number(svg.getAttribute('width') ?? 0)
  const currentHeight = Number(svg.getAttribute('height') ?? 0)
  const width = Math.max(currentWidth, maxPosition(boxes, positions, 'x') + BOX_W + PAD)
  const height = Math.max(
    currentHeight,
    maxPosition(boxes, positions, 'y') + maxHeight(boxes, positions) + PAD + NOTE_H
  )
  if (width === currentWidth && height === currentHeight) return
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
}

function finitePosition(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function cmakeTitle(ns: string, text: string): SVGTitleElement {
  const t = document.createElementNS(ns, 'title') as SVGTitleElement
  t.textContent = text
  return t
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
