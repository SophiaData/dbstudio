import { createApp } from 'vue'
import App from '../../src/App.vue'
import '../../src/style.css'

// Only the native boundary is synthetic: boot, tree, editor and grid use the real App.
const connection = { id: 'layout', name: '窗口验收连接', dialectId: 'mysql', connected: true,
  options: { database: 'dbstudio_acceptance' }, capabilities: { supportsInlineEdit: true } }
const root = { id: 'connection:layout', name: connection.name, kind: 'connection', hasChildren: true }
const table = { id: 'connection:layout|database:dbstudio_acceptance|table:items', name: 'items', kind: 'table', hasChildren: false }
const columns = [{ name: 'id', type: 'text' }, { name: 'payload', type: 'text' }]
const query = 'SELECT * FROM `dbstudio_acceptance`.`items`'
const unexpected: string[] = []
Object.assign(window, {
  workbenchLayout: { unexpected },
  gridNativeCall: async (command: string, payload: { method: string; args: unknown[] }) => {
    const { method, args } = payload
    if (command === 'backend_call') {
      if (method === 'listDialects') return [{ id: 'mysql', name: 'MySQL', quoting: { open: '`', close: '`', escape: 'double' } }]
      if (method === 'listConnections') return [connection]
      if (method === 'listChildren' && args[0] === null) return [root]
      if (method === 'listChildren' && args[0] === root.id) return [table]
      if (method === 'migrationStatus') return { legacyConfigImported: false, legacySecretsRequireReentry: false, warnings: [] }
      if (method === 'describeTable' && args[0] === table.id) return { hasUniqueKey: true,
        columns: columns.map((column, index) => ({ name: column.name, typeName: index ? 'TEXT' : 'BIGINT',
          nullable: Boolean(index), primaryKeyOrdinal: index ? null : 1, generated: null, identity: null })) }
      if (method === 'tableSelectSql' && args[0] === table.id) return query
      if (method === 'transactionState' && args[0] === root.id) return { active: false, pendingAffected: 0 }
      if (method === 'runQuery' && args[0] === root.id) {
        if (args[1] === 'SELECT DATABASE() AS dbstudio_database') return {
          columns: [{ name: 'dbstudio_database', type: 'text' }], rows: [{ index: 0, cells: [{ kind: 'text', text: 'dbstudio_acceptance' }] }],
          offset: 0, returned: 1, hasMore: false, elapsedMs: 1 }
        if (args[1] === query) return { columns,
          rows: Array.from({ length: 200 }, (_, index) => ({ index, cells: [{ kind: 'text', text: String(index + 1) }, { kind: 'text', text: `row-${index + 1}` }] })),
          offset: 0, returned: 200, hasMore: true, cursorId: 'layout-cursor', elapsedMs: 1, executedSql: query }
      }
    }
    unexpected.push(`${command}/${method}`)
    throw new Error(`Unexpected layout boundary: ${command}/${method}`)
  }
})
createApp(App).mount('#app')
