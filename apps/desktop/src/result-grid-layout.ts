import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import type { ResultTab } from './workbench'

const MIN_WIDTH = 72
const MAX_WIDTH = 720
const DEFAULT_WIDTH = 160
const ROW_NUMBER_WIDTH = 64
interface Layout { signature: string; widths: number[]; scrollLeft: number }
// Result tabs own their session-only layout; closing a tab allows its state to be collected.
const layouts = new WeakMap<ResultTab, Layout>()

export function useResultGridLayout(tab: () => ResultTab) {
  const viewport = ref<HTMLDivElement | null>(null)
  const columns = computed(() => tab().page?.columns ?? [])
  const signature = computed(() => JSON.stringify(columns.value.map(({ name, type }) => [name, type])))
  const layout = shallowRef<Layout>({ signature: '', widths: [], scrollLeft: 0 })
  const query = ref('')
  const target = ref(0)
  const highlighted = ref<number | null>(null)
  const resizing = ref(false)
  let drag: { index: number; x: number; width: number; id: number; element: HTMLElement } | null = null
  let restoreVersion = 0

  const matches = computed(() => columns.value.map((column, index) => ({ name: column.name, index }))
    .filter(({ name }) => name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
  watch(matches, (items) => {
    if (!items.some(({ index }) => index === target.value)) target.value = items[0]?.index ?? -1
  }, { immediate: true })

  function width(index: number) { return layout.value.widths[index] ?? DEFAULT_WIDTH }
  function setWidth(index: number, value: number) {
    if (columns.value[index]) layout.value.widths[index] = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(value)))
  }
  const tableWidth = computed(() => ROW_NUMBER_WIDTH + layout.value.widths.reduce((sum, value) => sum + value, 0))

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
  function fitAll() { columns.value.forEach((_, index) => fitColumn(index)) }
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
  function jumpToColumn() {
    if (!matches.value.some(({ index }) => index === target.value)) return
    const head = header(target.value)
    const scroll = viewport.value
    if (!head || !scroll) return
    scroll.scrollLeft += head.getBoundingClientRect().left - scroll.getBoundingClientRect().left - scroll.clientLeft
    highlighted.value = target.value
    head.focus({ preventScroll: true })
    saveScroll()
  }
  function saveScroll() { if (viewport.value) layout.value.scrollLeft = viewport.value.scrollLeft }

  watch([tab, signature], async () => {
    endResize(true)
    const currentTab = tab()
    let saved = layouts.get(currentTab)
    if (!saved || saved.signature !== signature.value) {
      saved = reactive({ signature: signature.value, widths: columns.value.map(() => DEFAULT_WIDTH), scrollLeft: 0 })
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
    endResize(true)
    saveScroll()
  })

  return { viewport, query, target, matches, highlighted, resizing, tableWidth, width, minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH, rowNumberWidth: ROW_NUMBER_WIDTH, startResize, moveResize, endResize, cancelResize,
    resizeKey, fitColumn, fitAll, resetWidths, jumpToColumn, saveScroll }
}
