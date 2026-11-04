/**
 * 共享的 application API mapping。
 *
 * Electron IPC 与 HTTP server 都把请求交给同一组 application services；
 * transport 只负责 envelope、认证上下文与能力面，不再各自维护一份方法转发表。
 * `chooseImportFile` 留在 Electron shell adapter，因为它需要 WebContents。
 */

import type { DbStudioApi } from '../../core/api'
import type { ConnectionManager } from '../ConnectionManager'
import type { SqlLibraryStore } from '../SqlLibraryStore'

export type ApplicationApi = Omit<DbStudioApi, 'chooseImportFile'>

export interface ApplicationApiDependencies {
  readonly getManager: () => ConnectionManager
  readonly getSqlLibrary: () => SqlLibraryStore
}

export function createApplicationApi(
  dependencies: ApplicationApiDependencies
): ApplicationApi {
  const { getManager, getSqlLibrary } = dependencies

  return {
    listDialects: async () => getManager().listDialects(),
    listConnections: async () => getManager().list(),
    addConnection: async (config, secret) => getManager().add(config, secret),
    connectConnection: async (connectionId) => getManager().connectConnection(connectionId),
    disconnectConnection: async (connectionId) =>
      getManager().disconnectConnection(connectionId),
    removeConnection: async (connectionId) => getManager().remove(connectionId),
    testConnection: async (config, secret) => getManager().testConnection(config, secret),
    listChildren: async (nodeId) => getManager().listChildren(nodeId),
    describeTable: async (tableNodeId) => getManager().describeTable(tableNodeId),
    captureSchemaSnapshot: async (connectionId, schema) =>
      getManager().captureSchemaSnapshot(connectionId, schema),
    compareTableData: async (request) => getManager().compareTableData(request),

    runQuery: async (
      nodeId: string,
      sql: string,
      queryOptions?: Parameters<ConnectionManager['runQuery']>[2],
      signal?: AbortSignal
    ) =>
      getManager().runQuery(nodeId, sql, queryOptions, signal),
    executeStatement: async (nodeId, sql, queryOptions) =>
      getManager().executeStatement(nodeId, sql, queryOptions),
    explain: async (nodeId, sql) => getManager().explain(nodeId, sql),
    fetchResultPage: async (cursorId, offset, limit) =>
      getManager().fetchResultPage(cursorId, offset, limit),
    closeCursor: async (cursorId) => getManager().closeCursor(cursorId),
    previewTable: async (nodeId, limit) => getManager().previewTable(nodeId, limit),
    tableSelectSql: async (nodeId) => getManager().tableSelectSql(nodeId),

    applyEdits: async (tableNodeId, updates) =>
      getManager().applyEdits(tableNodeId, updates),
    commitTransaction: async (nodeId) => getManager().commitTransaction(nodeId),
    rollbackTransaction: async (nodeId) => getManager().rollbackTransaction(nodeId),
    transactionState: async (nodeId) => getManager().transactionState(nodeId),

    insertRow: async (tableNodeId, values) => getManager().insertRow(tableNodeId, values),
    deleteRows: async (tableNodeId, keys) => getManager().deleteRows(tableNodeId, keys),
    countRows: async (tableNodeId) => getManager().countRows(tableNodeId),
    fetchCellValue: async (cursorId, rowIndex, columnIndex) =>
      getManager().fetchCellValue(cursorId, rowIndex, columnIndex),

    createTable: async (connectionId, spec) => getManager().createTable(connectionId, spec),
    dropTable: async (nodeId) => getManager().dropTable(nodeId),
    createView: async (connectionId, viewName, selectSql) =>
      getManager().createView(connectionId, viewName, selectSql),
    dropView: async (nodeId) => getManager().dropView(nodeId),
    renameTable: async (nodeId, newName) => getManager().renameTable(nodeId, newName),
    cancelQuery: async (nodeId, signalId) => getManager().cancelQuery(nodeId, signalId),
    updateConnection: async (connectionId, config, secret) =>
      getManager().updateConnection(connectionId, config, secret),

    listSqlLibrary: async () => getSqlLibrary().snapshot(),
    recordSqlHistory: async (input) => {
      const history = getSqlLibrary()
      const manager = getManager()
      const connection = manager.list().find((item) => item.id === input.connectionId)
      return history.record(input, connection?.name ?? '（已删除的连接）')
    },
    saveSql: async (id, name, sql) => getSqlLibrary().save(id, name, sql),
    removeSavedSql: async (id) => getSqlLibrary().removeSaved(id),
    clearSqlHistory: async () => getSqlLibrary().clearHistory(),

    startTransfer: async (request) => getManager().startTransfer(request),
    getTransferProgress: async (taskId) => getManager().getTransferProgress(taskId) ?? null,
    cancelTransfer: async (taskId) => getManager().cancelTransfer(taskId),
    waitTransfer: async (taskId) => getManager().waitTransfer(taskId),

    previewImport: async (request) => getManager().previewImport(request),
    startImport: async (request) => getManager().startImport(request),
    getImportProgress: async (taskId) => getManager().getImportProgress(taskId) ?? null,
    cancelImport: async (taskId) => getManager().cancelImport(taskId),
    waitImport: async (taskId) => getManager().waitImport(taskId)
  }
}
