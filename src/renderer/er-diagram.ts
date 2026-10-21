/**
 * ER 图（实体-关系图）：SVG 手绘，零依赖。
 *
 * ============================================================================
 * 为什么用 SVG 手绘，而不是引一个图库（d3 / cytoscape / react-flow）
 * ============================================================================
 * 需求其实很小：画一堆"方框 + 列名文字"的网格，方框可点。引一个图库要背上
 * 布局引擎、事件系统、渲染管线一整套，而它们的效果图往往比这几行 SVG 更差。
 * SVG 的直接好处：可打印、可缩放、可被浏览器无障碍树识别（`<title>`），
 * 且导出成图片也是原生支持。所以这里手写。
 *
 * ============================================================================
 * ⚠️ 本图**不包含外键关系**（这是硬性设计决定，不是遗漏）
 * ============================================================================
 * 画关系线需要"哪个列引用哪个表"的信息。而当前元数据契约
 * `TableDescription`（core/model.ts）**只有 id / columns / hasUniqueKey**，
 * 里面**没有外键字段**——也就是说渲染进程根本拿不到"表 A 的 x 列引用表 B 的 id"
 * 这个事实。
 *
 * 在没有数据的情况下画一堆线（哪怕是"猜"关系）是**最坏**的选择：用户会
 * 以为看见了真实的外键，据此判断表之间的约束，而那是假的。所以：
 *   - 只画「表 + 列」；
 *   - 在图上**显式标注**「未包含外键关系（需扩展元数据契约）」。
 *
 * 将来若 `TableDescription` 增加了 `foreignKeys: { columns, refTable, refColumns }[]`，
 * 只需在 `#drawEdges`（目前故意留空/未实现）里按坐标画线即可——数据到位前不画。
 *
 * ============================================================================
 * 为什么必须有表数上限（默认 30）
 * ============================================================================
 * 生成 ER 图要对**每张表**调 `describeTable`（拉列信息）。几百张表一次拉完
 * 就是几百次跨进程往返 + 几百份元数据驻留内存，界面会卡死。
 * 这正是剖析报告 `03-metadata-dialect.md` 里「不该照搬 DBeaver 的
 * `cacheStructure(STRUCT_ALL)`」的教训：DBeaver 敢全量缓存是因为它在本地
 * JVM 里；我们是跨进程，必须设闸。超限时**中止并提示**，让用户先筛选。
 */

import type { DbStudioApi } from '../core/api'
import type { ObjectRef, TableDescription, ColumnDescription } from '../core/model'

/** 一次最多画多少张表。超出即中止——见文件头「为什么必须有表数上限」。 */
export const MAX_ER_TABLES = 30

/** 每个表框的宽度（px）。列名过长会截断。 */
const BOX_W = 220
/** 表框标题行高。 */
const TITLE_H = 26
/** 每个列行的高。 */
const ROW_H = 20
/** 表框之间的水平/垂直间距。 */
const GAP_X = 32
const GAP_Y = 28
/** 每行排几张表。 */
const PER_ROW = 3
/** 表头之外的最小留白。 */
const PAD = 24

/** 一张表在图上要画的东西。 */
interface EntityBox {
  readonly ref: ObjectRef
  readonly desc: TableDescription
}

/** ER 图对外的回调。 */
export interface ErDiagramCallbacks {
  /** 状态栏提示。 */
  onStatus(text: string, isError?: boolean): void
  /** 点击某个表框 → 打开该表（复用 main.ts 现有的 openTable 路径）。 */
  onOpenTable(ref: ObjectRef): void
}

/**
 * 生成 ER 图并挂到给定容器上。
 *
 * @param container 渲染目标（由 main.ts 提供的一个空 div）。
 * @param api       需要 `listChildren` 与 `describeTable`——**不需要新接口**。
 * @param connectionRef 连接节点（其 id 形如 `connection:c1`）。
 * @param onBack    可选的「返回」回调（用户从 ER 图退回结果区时用）。
 */
export async function renderErDiagram(
  container: HTMLElement,
  api: DbStudioApi,
  connectionRef: ObjectRef,
  cb: ErDiagramCallbacks,
  onBack?: () => void
): Promise<void> {
  container.replaceChildren()
  container.classList.add('er-diagram')

  // 顶部条：标题 + 返回 + 说明。
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
  if (onBack) back.addEventListener('click', onBack)
  else back.hidden = true
  head.appendChild(back)
  container.appendChild(head)

  const scroll = document.createElement('div')
  scroll.className = 'er-scroll'
  container.appendChild(scroll)

  try {
    cb.onStatus('正在统计表数量…')
    // 第一步：先**只统计**表数量（只用 listChildren，不 describeTable）。
    // 为什么先统计：如果表太多，我们连 describeTable 都不要开始调——
    // 那才是真正会卡死的部分。先数数，超限直接中止。
    const tables = await collectTables(api, connectionRef)
    if (tables.length > MAX_ER_TABLES) {
      cb.onStatus(
        `表太多（${tables.length} 张），请先筛选后再查看 ER 图（上限 ${MAX_ER_TABLES} 张）`,
        true
      )
      renderLimitNotice(scroll, tables.length)
      return
    }
    if (tables.length === 0) {
      cb.onStatus('该连接下没有可绘制的表')
      renderEmpty(scroll)
      return
    }

    // 第二步：在预算内，逐表拉列信息。上限已定，这里的并发量可控。
    cb.onStatus(`正在读取 ${tables.length} 张表的结构…`)
    const boxes: EntityBox[] = []
    for (const ref of tables) {
      try {
        const desc = await api.describeTable(ref.id)
        boxes.push({ ref, desc })
      } catch (e) {
        // 单表失败不应让整图失败——跳过并在状态栏提示，图仍可看其它表。
        cb.onStatus(`读取表「${ref.name}」结构失败，已跳过：${errText(e)}`, true)
      }
    }
    if (boxes.length === 0) {
      renderEmpty(scroll)
      return
    }

    scroll.appendChild(buildSvg(boxes, connectionRef, cb))
    cb.onStatus(`ER 图已生成：${boxes.length} 张表（未包含外键关系）`)
  } catch (e) {
    cb.onStatus(`生成 ER 图失败：${errText(e)}`, true)
    const err = document.createElement('div')
    err.className = 'er-error'
    err.textContent = `生成 ER 图失败：${errText(e)}`
    scroll.appendChild(err)
  }
}

/**
 * 收集连接下的所有表（只取 ObjectRef，不拉列）。
 *
 * 遍历粒度：连接 → 子节点（catalog/schema/folder）→ 表。
 * 因为我们不知道中间隔了几层（SQLite 是 connection→folder:tables→table，
 * 其它方言可能是 connection→schema→folder→table），所以做**有界递归**：
 * 只沿 `hasChildren && kind !== 'table' && kind !== 'view'` 的节点往下走，
 * 遇到 `kind === 'table'` 就收下（不再深入它的列）。
 */
async function collectTables(api: DbStudioApi, root: ObjectRef): Promise<ObjectRef[]> {
  const out: ObjectRef[] = []
  // 防御：万一表数已经超上限很多，没必要继续枚举完再报错——但为了给出
  // 准确数字（"表太多（N 张）"），这里仍枚举完；枚举本身只是 listChildren，
  // 比 describeTable 便宜得多。
  const walk = async (node: ObjectRef, depth: number): Promise<void> => {
    // 深度上限防御环（正常元数据树不会有环，但 id 异常时可能自引用）。
    if (depth > 8) return
    const children = await api.listChildren(node.id)
    for (const child of children) {
      if (child.kind === 'table') {
        out.push(child)
      } else if (child.kind === 'view') {
        // 视图不进 ER 图（它是查询结果，不是实体）；但也不深入。
        continue
      } else if (child.hasChildren) {
        await walk(child, depth + 1)
      }
    }
  }
  await walk(root, 0)
  return out
}

/** 超限提示（明确告知用户「表太多、先筛选」而不是静默截断前 30 张）。 */
function renderLimitNotice(host: HTMLElement, total: number): void {
  const box = document.createElement('div')
  box.className = 'er-limit'
  box.setAttribute('role', 'alert')
  box.textContent =
    `表太多（${total} 张），请先筛选后再查看 ER 图。` +
    `一次最多绘制 ${MAX_ER_TABLES} 张表——一次性拉取所有表的列信息会让界面卡死。`
  host.appendChild(box)
}

function renderEmpty(host: HTMLElement): void {
  const box = document.createElement('div')
  box.className = 'er-empty'
  box.textContent = '没有可绘制的表。'
  host.appendChild(box)
}

/**
 * 构建整张 SVG。
 *
 * 布局：网格，每行 PER_ROW 张表。每个表框高度 = 标题 + 列数 × 行高。
 * 行高不同（列多的表更高）→ 每一行取该行最高者作为该行高度，避免重叠。
 */
function buildSvg(
  boxes: EntityBox[],
  connectionRef: ObjectRef,
  cb: ErDiagramCallbacks
): SVGSVGElement {
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const rows: EntityBox[][] = []
  for (let i = 0; i < boxes.length; i += PER_ROW) {
    rows.push(boxes.slice(i, i + PER_ROW))
  }

  // 布局：先算每个框的 (x, y, h)，再算整体尺寸。
  const positions = new Map<ObjectRef, { x: number; y: number; h: number }>()
  let y = PAD
  for (const row of rows) {
    const heights = row.map((b) => TITLE_H + Math.max(1, b.desc.columns.length) * ROW_H + 8)
    const rowH = Math.max(...heights)
    row.forEach((b, i) => {
      const x = PAD + i * (BOX_W + GAP_X)
      positions.set(b.ref, { x, y, h: heights[i] ?? rowH })
    })
    y += rowH + GAP_Y
  }
  const cols = Math.min(PER_ROW, boxes.length)
  const width = PAD * 2 + cols * BOX_W + (cols - 1) * GAP_X
  const height = y - GAP_Y + PAD

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'er-svg')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)

  // 顶部说明：明确「未包含外键关系」。这条必须显眼——见文件头。
  const noteY = 14
  const note = document.createElementNS(SVG_NS, 'text')
  note.setAttribute('x', String(PAD))
  note.setAttribute('y', String(noteY))
  note.setAttribute('class', 'er-note')
  note.textContent = '⚠ 未包含外键关系（当前元数据契约 TableDescription 无外键字段，需扩展）'
  svg.appendChild(note)

  // 因为有顶部说明，所有表框整体下移一点，避免与说明重叠。
  const shiftY = 20

  // 先画所有表框（方便后面若要画线时压在下层）。
  for (const box of boxes) {
    const pos = positions.get(box.ref)
    if (!pos) continue
    svg.appendChild(drawEntity(box, pos.x, pos.y + shiftY, BOX_W, pos.h, SVG_NS, cb))
  }

  // 关系线：**故意不画**。数据（外键）不存在，画出来就是假的。
  // drawEdges(...) —— 契约扩展后再实现。

  return svg
}

/** 画一张表的框：标题（表名）+ 每行一个列（主键前加 🔑）。 */
function drawEntity(
  box: EntityBox,
  x: number,
  y: number,
  w: number,
  h: number,
  ns: string,
  cb: ErDiagramCallbacks
): SVGGElement {
  const g = document.createElementNS(ns, 'g') as SVGGElement
  g.setAttribute('class', 'er-entity')
  g.setAttribute('transform', `translate(${x},${y})`)
  g.setAttribute('role', 'button')
  g.setAttribute('tabindex', '0')
  // 无障碍：读屏器会念出「表 users，N 列」。
  const accTitle = document.createElementNS(ns, 'title')
  accTitle.textContent = `表 ${box.ref.name}，${box.desc.columns.length} 列`
  g.appendChild(accTitle)

  // 外框
  const rect = document.createElementNS(ns, 'rect')
  rect.setAttribute('x', '0')
  rect.setAttribute('y', '0')
  rect.setAttribute('width', String(w))
  rect.setAttribute('height', String(h))
  rect.setAttribute('rx', '6')
  rect.setAttribute('class', 'er-entity-rect')
  g.appendChild(rect)

  // 标题栏
  const titleBg = document.createElementNS(ns, 'rect')
  titleBg.setAttribute('x', '0')
  titleBg.setAttribute('y', '0')
  titleBg.setAttribute('width', String(w))
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

  // 列行
  const cols: readonly ColumnDescription[] = box.desc.columns
  const shown = cols.slice(0, Math.max(1, Math.floor((h - TITLE_H - 8) / ROW_H)))
  shown.forEach((col, i) => {
    const rowY = TITLE_H + 4 + i * ROW_H
    const t = document.createElementNS(ns, 'text')
    t.setAttribute('x', '10')
    t.setAttribute('y', String(rowY + 14))
    t.setAttribute('class', 'er-col')
    const pk = col.primaryKeyOrdinal !== null
    // 主键加 🔑；同时用不同 class 便于 CSS 强调（颜色由 style.css 决定）。
    const label = `${pk ? '🔑 ' : '   '}${truncate(col.name, 20)}`
    t.textContent = label
    t.appendChild(cmakeTitle(ns, `${col.name} : ${col.typeName}${pk ? '（主键）' : ''}`))
    g.appendChild(t)

    // 类型放右侧，弱化显示
    const typeT = document.createElementNS(ns, 'text')
    typeT.setAttribute('x', String(w - 10))
    typeT.setAttribute('y', String(rowY + 14))
    typeT.setAttribute('text-anchor', 'end')
    typeT.setAttribute('class', 'er-col-type')
    typeT.textContent = truncate(col.typeName, 12)
    g.appendChild(typeT)
  })

  // 点击/回车 → 打开该表
  const open = (): void => cb.onOpenTable(box.ref)
  g.addEventListener('click', open)
  g.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open()
    }
  })
  return g
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
  if (e instanceof Error) return e.message
  return String(e)
}
