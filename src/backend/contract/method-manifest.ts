/**
 * 可执行的后端方法清单（method manifest）。
 *
 * ===== 为什么需要它 =====
 *
 * IPC 注册、preload 白名单与 `DbStudioApi` 是同一份能力面的三个投影。
 * 过去它们靠三处手写列表保持一致，任何一处漏掉或写错都**不会编译失败**：
 * 主进程少了 handler，只会在用户真正点到那个按钮时才炸。
 *
 * 这份清单把「方法名 → IPC channel」变成可被 Node 测试直接 import 的数据：
 *   - `core/api.ts` 的 `IPC` 仍是通道常量的唯一来源；
 *   - 类型层用 `entry()` 把方法名与对应通道绑定，写错通道立刻编译失败；
 *   - 文件底部的类型断言保证清单**覆盖全部** `DbStudioApi` 方法、**不含**未知方法；
 *   - 重复项无法在类型层表达，由 `tests/e2e-backend-contract.mjs` 在运行时校验。
 *
 * 本文件必须环境无关：只依赖 `core/api.ts` 的类型与常量，
 * 不允许 import electron / node 内置模块 / 主进程实现。
 */

import { IPC, type DbStudioApi } from '../../core/api'

/** 清单中的一条：方法名与它是用的 IPC 通道一一对应。 */
export interface BackendMethodManifestEntry<M extends keyof DbStudioApi = keyof DbStudioApi> {
  readonly method: M
  readonly channel: (typeof IPC)[M]
}

/**
 * 构造一条清单项。
 *
 * 参数 `channel` 的类型是 `(typeof IPC)[M]`，因此 `method` 一旦确定，
 * 传错通道（例如把 `listConnections` 配成 `IPC.listDialects`）就是编译错误。
 */
function entry<M extends keyof DbStudioApi>(
  method: M,
  channel: (typeof IPC)[M]
): BackendMethodManifestEntry<M> {
  return { method, channel }
}

/**
 * 全部白名单方法。顺序与 `core/api.ts` 的 `IPC` 声明保持一致，便于人工对照。
 *
 * 这里刻意**没有**任何「任意方法名」入口：每一条都是具体的方法与具体的通道。
 * transport 只能按这份静态清单逐个注册，不能接受渲染进程传来的方法名。
 */
export const BACKEND_METHOD_MANIFEST = [
  entry('listDialects', IPC.listDialects),
  entry('listConnections', IPC.listConnections),
  entry('addConnection', IPC.addConnection),
  entry('connectConnection', IPC.connectConnection),
  entry('disconnectConnection', IPC.disconnectConnection),
  entry('removeConnection', IPC.removeConnection),
  entry('testConnection', IPC.testConnection),
  entry('listChildren', IPC.listChildren),
  entry('describeTable', IPC.describeTable),
  entry('captureSchemaSnapshot', IPC.captureSchemaSnapshot),
  entry('compareTableData', IPC.compareTableData),
  entry('runQuery', IPC.runQuery),
  entry('executeStatement', IPC.executeStatement),
  entry('explain', IPC.explain),
  entry('fetchResultPage', IPC.fetchResultPage),
  entry('closeCursor', IPC.closeCursor),
  entry('previewTable', IPC.previewTable),
  entry('tableSelectSql', IPC.tableSelectSql),
  entry('applyEdits', IPC.applyEdits),
  entry('commitTransaction', IPC.commitTransaction),
  entry('rollbackTransaction', IPC.rollbackTransaction),
  entry('transactionState', IPC.transactionState),
  entry('insertRow', IPC.insertRow),
  entry('deleteRows', IPC.deleteRows),
  entry('countRows', IPC.countRows),
  entry('fetchCellValue', IPC.fetchCellValue),
  entry('createTable', IPC.createTable),
  entry('dropTable', IPC.dropTable),
  entry('createView', IPC.createView),
  entry('dropView', IPC.dropView),
  entry('renameTable', IPC.renameTable),
  entry('cancelQuery', IPC.cancelQuery),
  entry('updateConnection', IPC.updateConnection),
  entry('listSqlLibrary', IPC.listSqlLibrary),
  entry('recordSqlHistory', IPC.recordSqlHistory),
  entry('saveSql', IPC.saveSql),
  entry('removeSavedSql', IPC.removeSavedSql),
  entry('clearSqlHistory', IPC.clearSqlHistory),
  entry('startTransfer', IPC.startTransfer),
  entry('getTransferProgress', IPC.getTransferProgress),
  entry('cancelTransfer', IPC.cancelTransfer),
  entry('waitTransfer', IPC.waitTransfer),
  entry('previewImport', IPC.previewImport),
  entry('startImport', IPC.startImport),
  entry('getImportProgress', IPC.getImportProgress),
  entry('cancelImport', IPC.cancelImport),
  entry('waitImport', IPC.waitImport),
  entry('chooseImportFile', IPC.chooseImportFile)
] as const

/**
 * Remote capability projection. Keep this derived from the desktop manifest so
 * adding an application method cannot silently create a second hand-written
 * route list; shell-only and server-local path methods are excluded explicitly.
 */
const REMOTE_EXCLUDED_METHODS: ReadonlySet<string> = new Set([
  'chooseImportFile',
  'addConnection',
  'testConnection',
  'updateConnection',
  'startTransfer',
  'getTransferProgress',
  'cancelTransfer',
  'waitTransfer',
  'previewImport',
  'startImport',
  'getImportProgress',
  'cancelImport',
  'waitImport'
])

export const REMOTE_BACKEND_METHOD_MANIFEST = BACKEND_METHOD_MANIFEST.filter(
  (item) => !REMOTE_EXCLUDED_METHODS.has(item.method)
)

/** 清单里出现的方法名集合（由实际元素推导，而不是手写第二份列表）。 */
export type BackendMethodName = (typeof BACKEND_METHOD_MANIFEST)[number]['method']

/** 清单里出现的通道集合。 */
export type BackendMethodChannel = (typeof BACKEND_METHOD_MANIFEST)[number]['channel']

// ---- 编译期覆盖检查 ----
//
// 如果 `DbStudioApi` 新增了方法却忘记加进清单，第一条断言立刻失败；
// 如果清单里混入了不存在的方法，第二条失败。重复项在编译期无法表达，
// 由 e2e-backend-contract 的运行时断言负责。

type Assert<T extends true> = T
type IsAssignable<From, To> = From extends To ? true : false

type _ManifestCoversEveryApiMethod = Assert<
  IsAssignable<keyof DbStudioApi, BackendMethodName>
>
type _ManifestContainsOnlyApiMethods = Assert<
  IsAssignable<BackendMethodName, keyof DbStudioApi>
>
