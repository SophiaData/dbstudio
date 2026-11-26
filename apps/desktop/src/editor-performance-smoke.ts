import { nextTick } from 'vue'
import type { NativeToolHost } from './native-tool-smoke'
import type { Workbench } from './workbench'
import { editorSnapshots } from './sql-editor-state'

// Runs only through the explicit native test controller, against synthetic drafts.
export async function measureEditorPerformance(wb: Workbench, tools: NativeToolHost) {
  const original = wb.activeEditorTabId.value
  const tabs: string[] = []
  const heap = () => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    return memory && Number.isFinite(memory.usedJSHeapSize) ? memory.usedJSHeapSize : null
  }
  const painted = async () => {
    await nextTick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }
  const summary = (samples: number[]) => ({ samplesMs: samples, p95Ms: [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!, maxMs: Math.max(...samples) })
  const sizes: { lines: number; loadMs: number; input: ReturnType<typeof summary> }[] = []
  const heapBytes: (number | null)[] = [heap()]
  const switches: number[] = []
  try {
    for (const lines of [1000, 10000]) {
      const text = Array.from({ length: lines }, (_, i) => `SELECT ${i}; -- 中文`).join('\n')
      const started = performance.now()
      const id = wb.openEditorTab(wb.currentConnectionId.value, text)
      tabs.push(id)
      await painted()
      const editor = await tools.sqlEditor()
      const view = editor.editor!
      const loadMs = performance.now() - started
      const samples: number[] = []
      view.focus()
      for (let i = 0; i < 30; i++) {
        const started = performance.now()
        view.dispatch({ changes: { from: view.state.doc.length, insert: '字' }, selection: { anchor: view.state.doc.length + 1 }, userEvent: 'input.type' })
        await painted()
        samples.push(performance.now() - started)
      }
      if (wb.sql.value !== text + '字'.repeat(30) || view.state.doc.lines !== lines) throw new Error('Large editor draft lost input')
      sizes.push({ lines, loadMs, input: summary(samples) })
    }
    const text = wb.sql.value
    while (tabs.length < 10) { tabs.push(wb.openEditorTab(wb.currentConnectionId.value, text)); await painted() }
    const expected = new Map(wb.editorTabs.value.filter((tab) => tabs.includes(tab.id)).map((tab) => [tab.id, tab.sql]))
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const id of tabs) {
        const started = performance.now()
        wb.activateEditorTab(id)
        await painted()
        const editor = await tools.sqlEditor()
        switches.push(performance.now() - started)
        if (editor.editor!.state.doc.toString() !== expected.get(id) || !editor.editor!.contentDOM.isContentEditable) throw new Error('Large tab did not restore its editable draft')
      }
      heapBytes.push(heap())
    }
    if (wb.editorStorageWarning.value) throw new Error('Large draft persistence failed')
    return { environment: 'GitHub Windows WebView; synthetic transactions to two animation frames', sizes, tabs: 10, switches: summary(switches), heapBytes,
      memoryScope: 'Optional WebView JS heap estimate; no forced GC, excludes native memory and is not a leak test' }
  } finally {
    for (const id of tabs) {
      wb.activateEditorTab(id)
      await nextTick()
      wb.sql.value = ''
      await wb.closeEditorTab(id)
      await nextTick()
    }
    wb.activateEditorTab(original)
    await nextTick()
    const snapshots = editorSnapshots(wb)
    if (tabs.some((id) => snapshots.has(id))) throw new Error('Closed benchmark tabs retained snapshots')
  }
}
