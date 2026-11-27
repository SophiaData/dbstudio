import { createApp, h, nextTick, reactive, ref } from 'vue'
import ResultGrid from '../../src/components/ResultGrid.vue'
import { useWorkbench, type ResultTab } from '../../src/workbench'
import type { QueryResult, ResultPage } from '../../../../src/core/resultset'
import '../../src/style.css'

interface NativeSample {
  caseId: string
  dialect: 'postgresql' | 'mysql'
  rows: number
  size: number
  page: ResultPage
  query: Pick<QueryResult, 'cursorId' | 'executedSql' | 'elapsedMs'>
}

// Input is one unchanged native ResultPage. This fixture never synthesizes cells,
// queries a database, or boots the workbench's native backend.
const wb = useWorkbench()
const label = ref('等待真实分页样本')
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
let loading = false
Object.assign(window, { pagePerformance: {
  async load(sample: NativeSample) {
    if (loading) throw new Error('Page samples must be measured sequentially')
    if (![200, 1000].includes(sample.size) || sample.page.rows.length !== sample.size) {
      throw new Error('Only a bounded native page may enter the browser')
    }
    loading = true
    try {
      wb.tabs.value = []
      wb.activeTabId.value = ''
      await nextTick()
      await frames()
      wb.connections.value = [{ id: 'performance-fixture', name: '专用合成数据连接',
        dialectId: sample.dialect, connected: true, capabilities: {} }] as typeof wb.connections.value
      label.value = `${sample.dialect} · ${sample.rows.toLocaleString()} 行 · offset ${sample.page.offset} · page ${sample.size}`
      await nextTick()
      // Browser transport/JSON decoding and the preceding teardown are excluded.
      // Measure fresh production component mount, reactive updates and two paints.
      const started = performance.now()
      const tab: ResultTab = reactive({
        id: sample.caseId, connectionId: 'performance-fixture', title: sample.caseId,
        table: null, description: null, sql: sample.query.executedSql, querySql: sample.query.executedSql,
        parameters: [], result: { ...sample.page, ...sample.query }, page: sample.page,
        message: '', busy: false, invalidated: false, dirty: new Map(), selectedRows: new Set<number>(),
        filter: '', appliedFilter: '', pageSize: sample.size, order: [], generation: 0
      })
      wb.tabs.value = [tab]
      wb.activateTab(tab)
      await nextTick()
      await frames()
      return { renderMs: performance.now() - started }
    } finally { loading = false }
  }
} })

createApp({ render: () => h('main', { class: 'workbench' }, [
  h('div', { class: 'actions' }, label.value),
  wb.activeTab.value && h(ResultGrid, { key: wb.activeTab.value.id, workbench: wb, tab: wb.activeTab.value })
]) }).mount('#app')
