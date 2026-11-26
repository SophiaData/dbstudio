import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import type { ResultTab } from './workbench'

const MIN_WIDTH = 72
const MAX_WIDTH = 720
const DEFAULT_WIDTH = 160
const ROW_NUMBER_WIDTH = 64
interface Layout { signature: string; widths: number[]; scrollLeft: number; hidden: Set<number>; pinned: Set<number> }
// Result tabs own their session-only layout; closing a tab allows its state to be collected.
const layouts = new WeakMap<ResultTab, Layout>()

export function useResultGridLayout(tab: () => ResultTab) {
  const viewport = ref<HTMLDivElement | null>(null)
  const columns = computed(() => tab().page?.columns ?? [])
  const signature = computed(() => JSON.stringify(columns.value.map(({ name, type }) => [name, type])))
  const layout = shallowRef<Layout>({ signature: '', widths: [], scrollLeft: 0, hidden: new Set(), pinned: new Set() })
  const query = ref('')
  const target = ref(0)
  const highlighted = ref<number | null>(null)
  const resizing = ref(false)
  let drag: { index: number; x: number; width: number; id: number; element: HTMLElement } | null = null
  let restoreVersion = 0
  const viewportWidth = ref(0)
  let observer: ResizeObserver | null = null
  watch(viewport, (element) => {
    observer?.disconnect()
    if (!element) return
    viewportWidth.value = element.clientWidth
    observer = new ResizeObserver(() => { viewportWidth.value = element.clientWidth })
    observer.observe(element)
  }, { flush: 'post' })

  const isHidden = (index: number) => layout.value.hidden.has(index)
  const isPinned = (index: number) => layout.value.pinned.has(index)
  const visibleColumns = computed(() => {
    const available = columns.value.map((column, index) => ({ column, index })).filter(({ index }) => !isHidden(index))
    return [...available.filter(({ index }) => isPinned(index)), ...available.filter(({ index }) => !isPinned(index))]
  })
  const visibleOrder = computed(() => visibleColumns.value.map(({ index }) => index))
  const hiddenCount = computed(() => layout.value.hidden.size)
  const pinnedCount = computed(() => layout.value.pinned.size)
  // Leave a usable scrolling area even when pinned columns are wider than the window.
  const stickyOffsets = computed(() => {
    const offsets = new Map<number, number>()
    let left = ROW_NUMBER_WIDTH
    for (const { index } of visibleColumns.value) {
      if (!isPinned(index) || left + width(index) > viewportWidth.value - 160) break
      offsets.set(index, left)
      left += width(index)
    }
    return offsets
  })
  const pinnedWidth = computed(() => ROW_NUMBER_WIDTH + [...stickyOffsets.value.keys()].reduce((sum, index) => sum + width(index), 0))
  const overflowPins = computed(() => visibleColumns.value.filter(({ index }) => isPinned(index)).length > stickyOffsets.value.size)
  function columnStyle(index: number) {
    const left = stickyOffsets.value.get(index)
    return left === undefined ? {} : { left: `${left}px` }
  }
  function toggleHidden(index: number) {
    if (!columns.value[index]) return
    endResize(true)
    if (isHidden(index)) layout.value.hidden.delete(index)
    else if (visibleOrder.value.length > 1) layout.value.hidden.add(index)
  }
  function togglePinned(index: number) {
    if (!columns.value[index]) return
    endResize(true)
    if (isPinned(index)) layout.value.pinned.delete(index)
    else { layout.value.hidden.delete(index); layout.value.pinned.add(index) }
  }
  function showAll() { endResize(true); layout.value.hidden.clear() }
  function unpinAll() { endResize(true); layout.value.pinned.clear() }

  const matches = computed(() => columns.value.map((column, index) => ({ name: column.name, index }))
    .filter(({ name }) => name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
  watch(matches, (items) => {
    if (!items.some(({ index }) => index === target.value)) target.value = items[0]?.index ?? -1
  }, { immediate: true })

  function width(index: number) { return layout.value.widths[index] ?? DEFAULT_WIDTH }
  function setWidth(index: number, value: number) {
    if (columns.value[index]) layout.value.widths[index] = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(value)))
  }
  const tableWidth = computed(() => ROW_NUMBER_WIDTH + visibleOrder.value.reduce((sum, index) => sum + width(index), 0))

  function endResize(cancel = false) {
    if (!drag) return
    const current = drag
    drag = null
    resizing.value = false
    if (cancel) setWidth(current.index, current.width)
    window.removeEventListener('blur', cancelResize)
    if (current.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id)
  }
  function cancelResize() { endResize(true) }
  function startResize(event: PointerEvent, index: number) {
    if (event.button !== 0 || !event.isPrimary) return
    endResize()
    const element = event.currentTarget as HTMLElement
    element.focus({ preventScroll: true })
    element.setPointerCapture(event.pointerId)
    drag = { index, x: event.clientX, width: width(index), id: event.pointerId, element }
    resizing.value = true
    window.addEventListener('blur', cancelResize)
  }
  function moveResize(event: PointerEvent) {
    if (drag?.id === event.pointerId) setWidth(drag.index, drag.width + event.clientX - drag.x)
  }

  function header(index: number) {
    return viewport.value?.querySelector<HTMLElement>(`thead th[data-column-index="${index}"]`)
  }
  function revealColumn(index: number, focusEnd = false) {
    const scroll = viewport.value
    const head = header(index)
    if (!scroll || !head || stickyOffsets.value.has(index)) return
    const viewportLeft = scroll.getBoundingClientRect().left + scroll.clientLeft
    const left = viewportLeft + pinnedWidth.value
    const right = viewportLeft + scroll.clientWidth
    const box = head.getBoundingClientRect()
    const focusLeft = focusEnd ? box.right - 9 : box.left
    const focusWidth = focusEnd ? 9 : box.width
    // Native focus scrolling only sees the scrollport, not its sticky siblings.
    // Wide cells show their beginning; resize handles must instead show the right edge.
    if (focusLeft < left || focusWidth > right - left) scroll.scrollLeft += focusLeft - left
    else if (box.right > right) scroll.scrollLeft += box.right - right
    saveScroll()
  }
  function fitColumn(index: number) {
    const head = header(index)
    if (!head || !viewport.value) return
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return
    let measured = MIN_WIDTH
    const measure = (element: Element) => {
      context.font = getComputedStyle(element).font
      // Only measure loaded previews. Large/truncated values never trigger a fetch for layout.
      const text = (element.textContent ?? '').slice(0, 4096).replace(/\s+/g, ' ')
      measured = Math.max(measured, context.measureText(text).width + 34)
    }
    head.querySelectorAll('.column-sort, small').forEach(measure)
    viewport.value.querySelectorAll(`tbody td[data-column-index="${index}"]`).forEach(measure)
    setWidth(index, measured)
  }
  function fitAll() { visibleOrder.value.forEach(fitColumn) }
  function resetWidths() { layout.value.widths = columns.value.map(() => DEFAULT_WIDTH) }
  function resizeKey(event: KeyboardEvent, index: number) {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'Escape') { event.preventDefault(); cancelResize(); return }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return
    event.preventDefault()
    endResize()
    if (event.key === 'Enter') fitColumn(index)
    else if (event.key === 'Home') setWidth(index, MIN_WIDTH)
    else if (event.key === 'End') setWidth(index, MAX_WIDTH)
    else setWidth(index, width(index) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10))
  }
  async function jumpToColumn() {
    if (!matches.value.some(({ index }) => index === target.value)) return
    const index = target.value
    const currentTab = tab()
    layout.value.hidden.delete(index)
    await nextTick()
    if (currentTab !== tab()) return
    const head = header(index)
    const scroll = viewport.value
    if (!head || !scroll) return
    if (!stickyOffsets.value.has(index)) {
      scroll.scrollLeft += head.getBoundingClientRect().left - scroll.getBoundingClientRect().left - scroll.clientLeft - pinnedWidth.value
    }
    highlighted.value = index
    head.focus({ preventScroll: true })
    saveScroll()
  }
  function jumpKey(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    jumpToColumn()
  }
  function saveScroll() { if (viewport.value) layout.value.scrollLeft = viewport.value.scrollLeft }

  watch([tab, signature], async () => {
    endResize(true)
    const currentTab = tab()
    let saved = layouts.get(currentTab)
    if (!saved || saved.signature !== signature.value) {
      saved = reactive({ signature: signature.value, widths: columns.value.map(() => DEFAULT_WIDTH), scrollLeft: 0, hidden: new Set<number>(), pinned: new Set<number>() })
      layouts.set(currentTab, saved)
    }
    layout.value = saved
    highlighted.value = null
    const version = ++restoreVersion
    await nextTick()
    if (version === restoreVersion && viewport.value) viewport.value.scrollLeft = saved.scrollLeft
  }, { immediate: true })
  // A page replacement can interrupt a pointer gesture even when column metadata is unchanged.
  watch(() => tab().page, () => endResize(true), { flush: 'sync' })
  onBeforeUnmount(() => {
    ++restoreVersion
    observer?.disconnect()
    endResize(true)
    saveScroll()
  })

  return { viewport, query, target, matches, highlighted, resizing, tableWidth, width, minWidth: MIN_WIDTH,
    visibleColumns, visibleOrder, isHidden, isPinned, hiddenCount, pinnedCount, stickyOffsets, columnStyle, overflowPins,
    toggleHidden, togglePinned, showAll, unpinAll, revealColumn,
    maxWidth: MAX_WIDTH, rowNumberWidth: ROW_NUMBER_WIDTH, startResize, moveResize, endResize, cancelResize,
    resizeKey, fitColumn, fitAll, resetWidths, jumpToColumn, jumpKey, saveScroll }
}
