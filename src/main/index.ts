/**
 * Electron 主进程入口。
 *
 * 职责严格限定为三件事：
 *   1. 开窗口
 *   2. 把 `DbStudioApi` 的实现注册为 IPC handler（实现身份是「编排者」，不含数据库知识）
 *   3. 应用退出时回收所有驱动宿主子进程
 *
 * 注意这里**没有一处数据库代码**——所有数据库能力都在子进程里。
 * 这正是剖析结论「陷阱 1 → 进程隔离」的落地形态：
 * 主进程即使遇到某个驱动的原生崩溃，也只是那一个宿主进程挂掉。
 */

import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { IPC, type DbStudioApi } from '../core/api'
import type { ConnectionConfig } from '../core/dialect'
import type { SecretInput } from '../core/driver'
import type { CellValue, QueryOptions, RowUpdate } from '../core/resultset'
import type { TableCreateSpec } from '../core/model'
import type { RecordSqlHistoryInput } from '../core/sql-library'
import { BUILTIN_DIALECT_METADATA } from '../drivers/dialect-metadata'
import { ConnectionManager } from './ConnectionManager'
import { ConnectionStore, type SecretCipher } from './ConnectionStore'
import { SqlLibraryStore } from './SqlLibraryStore'

let mainWindow: BrowserWindow | null = null
let manager: ConnectionManager | null = null
let sqlLibrary: SqlLibraryStore | null = null

/**
 * GUI 自动化测试是否以“完全后台”方式运行。
 *
 * macOS 上 `show: false` 让 Playwright 仍能操作真实 DOM、preload 与 IPC，
 * 但窗口不会出现在桌面；还必须切换 activation policy，否则应用仍会短暂
 * 抢占 Dock 和焦点。Linux CI 已经有 Xvfb，不需要隐藏；而隐藏窗口在 Xvfb
 * 下会让 Chromium 的截图等待合成结果超时，所以这里只在 macOS 生效。
 * 只认显式测试变量，正常启动不受影响。
 */
const hiddenTestMode =
  process.env['DBSTUDIO_TEST_HIDDEN'] === '1' && process.platform === 'darwin'

/**
 * 生产环境的凭据加解密器：Electron `safeStorage`。
 *
 * ===== safeStorage 到底是什么 =====
 *
 * 它不是"我们实现的加密"，而是把加解密委托给操作系统：
 *   - macOS  → Keychain（钥匙串）
 *   - Windows → DPAPI（绑定当前用户账户）
 *   - Linux   → libsecret / kwallet（取决于桌面环境）
 *
 * 也就是说，密文**只有当前登录用户在本机**才能解开，拷走文件也没用。
 * 这正是我们要的：比"自己在代码里塞一个 AES key"强——那个 key 必然
 * 在源码或二进制里，等于没加密。
 *
 * ===== 为什么允许返回 null =====
 *
 * Linux 无桌面密钥服务时 `isEncryptionAvailable()` 会返回 false。
 * 这种情况下我们**拒绝保存密码**（ConnectionStore 会抛
 * SecretStorageUnavailableError），而不是退化成明文落盘。
 * 宁可让用户每次手输密码，也不能把生产密码写到磁盘上。
 *
 * ===== 为什么用同步 API（以及一个已知的升级路径） =====
 *
 * Electron 45 给这三个同步方法打了弃用警告，建议换成
 * `isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`。
 * 这里**刻意仍用同步版**，理由是：
 *   - `SecretCipher` 是同步接口，ConnectionStore 的读写契约也是同步的
 *     （落盘是本地小文件，同步更简单、没有竞态）。改成异步会牵动
 *     store / manager / 全部持久化测试，属于为"消一个警告"付出不必要的代价。
 *   - 同步版在 Electron 45 里**功能正常**（实测往返成功），不是坏的。
 *
 * 升级时只需把这一个函数改成异步版，并让 SecretCipher 返回 Promise。
 * 那个改动的影响面已经在这里标出，留给决定升级时一次性做。
 * 在此之前，弃用警告只出现在 stderr，不影响功能。
 */
function createSafeStorageCipher(): SecretCipher | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn(
        '[main] safeStorage 不可用（可能缺少系统密钥服务），密码将不会被保存；' +
          '其余配置照常持久化。'
      )
      return null
    }
    return {
      encrypt: (plain: string) => safeStorage.encryptString(plain),
      decrypt: (payload: Buffer) => safeStorage.decryptString(payload)
    }
  } catch (err) {
    // 某些平台上 isEncryptionAvailable 本身也可能抛（初始化失败）。
    console.warn('[main] 初始化 safeStorage 失败，密码将不会被保存:', err)
    return null
  }
}

/**
 * 延迟初始化连接管理器。
 *
 * ⚠️ 这里**只取方言元数据，不加载驱动实现**。
 * 早先的写法是 `new DriverRegistry() + registerBuiltinDrivers(registry)`，
 * 那会顺着 import 链把 `node:sqlite` 与整个 SQLite adapter 打进主进程 bundle
 * （实测 out/main/index.js 出现 DatabaseSync 与 9 处 PRAGMA，产物 102KB），
 * 直接违背「驱动跑在独立进程」这条核心承诺。
 *
 * 主进程需要的只有 id/name/fields/quoting —— 全是纯数据，
 * 从 `dialect-metadata`（它只 import 各驱动的 info.ts）取即可。
 */
function getManager(): ConnectionManager {
  if (manager) return manager
  // 落盘目录从 app 取，而不是在 ConnectionStore 里硬编码——
  // store 只认"注入的 baseDir"，这样它才能在纯 Node 测试里被临时目录覆盖。
  const store = new ConnectionStore({
    baseDir: app.getPath('userData'),
    cipher: createSafeStorageCipher(),
    onLog: (level, msg) => console[level === 'error' ? 'error' : 'log'](msg)
  })
  manager = new ConnectionManager(BUILTIN_DIALECT_METADATA, store)
  console.log(
    `[main] 已注册方言: ${BUILTIN_DIALECT_METADATA.map((d) => `${d.id}(${d.name})`).join(', ')}` +
      `；配置目录: ${app.getPath('userData')}`
  )
  return manager
}

function getSqlLibrary(): SqlLibraryStore {
  if (sqlLibrary) return sqlLibrary
  sqlLibrary = new SqlLibraryStore({
    baseDir: app.getPath('userData'),
    onLog: (level, msg) => console[level === 'error' ? 'error' : 'log'](msg)
  })
  return sqlLibrary
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    show: !hiddenTestMode,
    skipTaskbar: hiddenTestMode,
    title: 'dbstudio',
    backgroundColor: '#1b1d21',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全基线：渲染进程不给 Node 能力，只能通过 preload 的白名单 API 访问主进程。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 外链一律交给系统浏览器，不在应用内打开。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  /**
   * 关闭最后一个窗口时也要问一次。
   *
   * macOS 上关掉窗口**不会**退出应用（`window-all-closed` 里只有非 darwin 才 quit），
   * 所以 `before-quit` 根本不会触发——但用户此时确实打算收工了，
   * 未提交的改动仍然悬着。Windows/Linux 上关最后一个窗口会走到 `app.quit()`，
   * 于是 `before-quit` 会拦住；这里提前拦一次，两边行为一致。
   *
   * 注意 macOS 上关窗口**不等于退出**：用户确认后只是把窗口关掉，
   * 应用仍在后台运行（符合 macOS 惯例）。要真正退出，走「退出应用」菜单，
   * 那条路径由 `before-quit` 负责。
   */
  mainWindow.on('close', (event) => {
    if (quitConfirmed || windowCloseApproved) return
    if (BrowserWindow.getAllWindows().length > 1) return
    event.preventDefault()
    if (quitGuardRunning) return
    quitGuardRunning = true
    void (async () => {
      const outcome = await askRendererToGuard()
      if (outcome === 'blocked') return // 用户取消：窗口保持打开
      windowCloseApproved = true
      mainWindow?.close()
    })().finally(() => {
      quitGuardRunning = false
    })
  })

  // 自检钩子：设置 DBSTUDIO_SMOKE=1 时，窗口加载完成后在渲染进程里跑一段断言，
  // 把结果打到 stdout 并以退出码表达成败。这样 CI / 命令行就能自动验证 GUI，
  // 而不需要人肉看窗口。默认不设置，不影响正常使用。
  if (process.env['DBSTUDIO_SMOKE'] === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      void runSmoke(mainWindow!)
    })
  }
}

/**
 * GUI 自检：从渲染进程侧取真实 DOM 状态。
 *
 * 为什么要测这些：它们正好覆盖「界面真的起来了」的几个关键点——
 *   - 树的容器与撑高元素存在（虚拟滚动结构成立）
 *   - preload 白名单真的注入成功（contextBridge 生效）
 *   - 根层确实渲染出了行（说明 listChildren(null) 这条链路跑通）
 */
async function runSmoke(win: BrowserWindow): Promise<void> {
  try {
    // 给渲染进程一点时间完成首次 loadRoots 的异步往返。
    await new Promise((r) => setTimeout(r, 1200))

    /**
     * safeStorage 真实路径验证。
     *
     * ===== 为什么必须在主进程里验，纯 Node 测试替代不了 =====
     *
     * `tests/e2e-persist.mjs` 用的是**可逆假 cipher**（纯 Node 跑不了
     * safeStorage，它依赖 Electron 运行时 + 系统钥匙串）。那份测试能证明
     * "store 的逻辑正确"，但**证明不了"真实加密真的可用"**——
     * 如果这台机器上 safeStorage 根本不可用，纯 Node 测试照样全绿，
     * 而生产环境里密码会保存失败。
     *
     * 所以这里做两件事：
     *   1. 记录 isEncryptionAvailable() 的真实值
     *   2. 做一次真的 encryptString → decryptString 往返，确认密码能原样取回
     *
     * 这一步是 Lead 验收生产可用性的唯一依据，所以必须真的执行加解密，
     * 不能只调一下 isEncryptionAvailable 就完事（那个值可能是 true 但
     * 实际加解密因钥匙串被锁而失败）。
     */
    const safeStorageProbe = probeSafeStorage()

    const result = await win.webContents.executeJavaScript(`(() => {
      const tree = document.getElementById('tree-rows');
      const spacer = document.getElementById('tree-spacer');
      const status = document.getElementById('status-bar');
      // 多标签页改造后，结果区容器是 #result-tabbar + #result-stack，
      // 原来的 #result-grid 已不存在。自检断言必须跟着改，
      // 否则会误报「界面坏了」——实际是断言过时（这次就是这么发现的）。
      const tabbar = document.getElementById('result-tabbar');
      const resultStack = document.getElementById('result-stack');
      // SQL 输入框已升级为完整的编辑器组件（#sql-editor-host 由 SqlEditor 自建内部 DOM）。
      const sqlHost = document.getElementById('sql-editor-host');
      const sqlEditorArea = document.querySelector('.sql-editor-input');
      const api = window.dbstudio;
      // 结果集相关的 API 必须全部就位——白名单从 7 扩到 11 时，
      // 只要漏了任何一个，网格在真实点击时才会炸，自检要提前发现。
      const gridApi = api ? ['runQuery','fetchResultPage','closeCursor','previewTable']
        .filter(k => typeof api[k] === 'function') : [];
      // 持久化相关 API（第四阶段）：白名单 15 → 17 的两个新增项。
      const persistApi = api ? ['connectConnection','disconnectConnection']
        .filter(k => typeof api[k] === 'function') : [];
      // 在线编辑相关 API（第三阶段）：白名单 11 → 15 的四个新增项。
      // 这四条缺一不可：只给 applyEdits 却不给 commit/rollback，
      // 会把连接永久卡在未提交事务里并占着行锁。
      const editApi = api ? ['applyEdits','commitTransaction','rollbackTransaction','transactionState']
        .filter(k => typeof api[k] === 'function') : [];
      // 第三轮：DDL 五件 + 编辑连接
      const ddlApi = api ? ['createTable','dropTable','createView','dropView','renameTable']
        .filter(k => typeof api[k] === 'function') : [];
      const hasUpdateConnection = api && typeof api.updateConnection === 'function';
      const sqlLibraryApi = api ? ['listSqlLibrary','recordSqlHistory','saveSql','removeSavedSql','clearSqlHistory']
        .filter(k => typeof api[k] === 'function') : [];
      return {
        title: document.title,
        hasTree: !!tree,
        hasSpacer: !!spacer,
        apiInjected: typeof api === 'object' && api !== null
          && typeof api.listChildren === 'function',
        renderedRows: tree ? tree.children.length : -1,
        spacerHeight: spacer ? spacer.style.height : null,
        statusText: status ? status.textContent : null,
        // 结果集区域必须存在（虽然初始 hidden）
        hasTabbar: !!tabbar,
        hasResultStack: !!resultStack,
        hasSqlEditorHost: !!sqlHost,
        hasSqlEditorTextarea: !!sqlEditorArea,
        gridApiCount: gridApi.length,
        persistApiCount: persistApi.length,
        editApiCount: editApi.length,
        ddlApiCount: ddlApi.length,
        hasUpdateConnection: !!hasUpdateConnection,
        sqlLibraryApiCount: sqlLibraryApi.length
      };
    })()`)
    // 把 safeStorage 探针结果合并进 SMOKE_RESULT：DOM 侧与主进程侧的信息
    // 输出在同一个对象里，Lead 只需要读一行就能判断全部关键能力。
    // 显式标注为 unknown 再收窄：两边字段集不同，spread 后的推断类型会打架，
    // 而这里本来就要在下面用宽松收窄来读，强类型标注是假的精确。
    const merged: Record<string, unknown> = {
      ...(result as Record<string, unknown>),
      ...safeStorageProbe
    }
    console.log('SMOKE_RESULT ' + JSON.stringify(merged))
    const r = merged as {
      hasTree: boolean
      hasSpacer: boolean
      apiInjected: boolean
      renderedRows: number
      statusText: string | null
      hasTabbar: boolean
      hasResultStack: boolean
      hasSqlEditorHost: boolean
      hasSqlEditorTextarea: boolean
      gridApiCount: number
      persistApiCount: number
      editApiCount: number
      ddlApiCount: number
      hasUpdateConnection: boolean
      sqlLibraryApiCount: number
    }
    const ok =
      r.hasTree &&
      r.hasSpacer &&
      r.apiInjected &&
      typeof r.renderedRows === 'number' &&
      // 结果集：DOM 容器 + SQL 输入框 + 4 个新 API 必须齐全
      r.hasTabbar &&
      r.hasResultStack &&
      r.hasSqlEditorHost &&
      r.hasSqlEditorTextarea &&
      r.gridApiCount === 4 &&
      // 持久化：connectConnection / disconnectConnection 两个新方法必须注入
      r.persistApiCount === 2 &&
      // 在线编辑：4 个方法必须齐全（缺 rollback 会让连接卡在未提交事务里）
      r.editApiCount === 4 &&
      // DDL 五件齐全 + 编辑连接可用
      r.ddlApiCount === 5 &&
      r.hasUpdateConnection &&
      r.sqlLibraryApiCount === 5 &&
      // safeStorage 走不通时**不算自检失败**：Linux 无密钥服务是合法环境，
      // 此时功能降级为"不保存密码"而非崩溃。所以这里只要求探针真的跑过
      // （字段存在），可用性本身由 Lead 读 SMOKE_RESULT 判断。
      typeof (merged as Record<string, unknown>)['safeStorageAvailable'] === 'boolean'
    console.log(ok ? 'SMOKE_PASS' : 'SMOKE_FAIL')
    app.exit(ok ? 0 : 1)
  } catch (e) {
    console.log('SMOKE_ERROR ' + (e instanceof Error ? e.message : String(e)))
    app.exit(1)
  }
}

/**
 * 真实执行一次 safeStorage 加解密往返，返回可并入 SMOKE_RESULT 的字段。
 *
 * 永不抛错：这个探针的目的是**报告**能力，而不是让自检因为环境差异失败。
 * 任何异常都收敛成 `safeStorageRoundTrip:false` + 一条错误摘要。
 */
function probeSafeStorage(): {
  safeStorageAvailable: boolean
  safeStorageRoundTrip: boolean
  safeStorageBackend: string | null
  safeStorageError: string | null
} {
  // 用一段带非 ASCII 的探针文本：纯 ASCII 可能在编码层碰巧通过，
  // 而真实密码完全可能含中文/emoji。顺带验证 UTF-8 往返无损。
  const probeText = 'dbstudio-probe-✅-密码-🔐'
  try {
    const available = safeStorage.isEncryptionAvailable()
    if (!available) {
      return {
        safeStorageAvailable: false,
        safeStorageRoundTrip: false,
        safeStorageBackend: null,
        safeStorageError: null
      }
    }
    const encrypted = safeStorage.encryptString(probeText)
    const decrypted = safeStorage.decryptString(encrypted)
    const roundTrip = decrypted === probeText
    // 后端名不一定存在（老版本 Electron 没有 getSelectedStorageBackend），
    // 取不到就报 null，不要因为它让整个探针失败。
    let backend: string | null = null
    try {
      const fn = (safeStorage as unknown as { getSelectedStorageBackend?: () => string })
        .getSelectedStorageBackend
      if (typeof fn === 'function') backend = fn.call(safeStorage)
    } catch {
      backend = null
    }
    return {
      safeStorageAvailable: true,
      safeStorageRoundTrip: roundTrip,
      safeStorageBackend: backend,
      safeStorageError: roundTrip ? null : '解密结果与原文不一致'
    }
  } catch (err) {
    return {
      safeStorageAvailable: false,
      safeStorageRoundTrip: false,
      safeStorageBackend: null,
      safeStorageError: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * 注册 IPC。
 *
 * 每个 handler 都只做「取参数 → 交给 ConnectionManager → 返回」，
 * 不在这里写业务逻辑。这样主进程可以只靠类型检查保证与 UI 契约一致。
 * 错误直接抛出，Electron 会把它序列化成 Error 传给渲染进程，
 * UI 侧 catch 到的就是可展示的 message。
 */
function registerIpc(): void {
  const api: Omit<DbStudioApi, never> = {
    listDialects: async () => getManager().listDialects(),
    listConnections: async () => getManager().list(),
    addConnection: async (config: ConnectionConfig, secret?: SecretInput) =>
      getManager().add(config, secret),
    connectConnection: async (connectionId: string) =>
      getManager().connectConnection(connectionId),
    disconnectConnection: async (connectionId: string) =>
      getManager().disconnectConnection(connectionId),
    removeConnection: async (connectionId: string) => getManager().remove(connectionId),
    testConnection: async (config: ConnectionConfig, secret?: SecretInput) =>
      getManager().testConnection(config, secret),
    listChildren: async (nodeId: string | null) => getManager().listChildren(nodeId),
    describeTable: async (tableNodeId: string) => getManager().describeTable(tableNodeId),
    // 结果集四个通道。注意它们的耗时量级与元数据方法**完全不同**：
    // 上面几个是毫秒级的元数据查询，这几个跑的是用户 SQL（可能几十秒）。
    // 超时策略因此在 DriverHostHandle 里分开（见 RESULT_SET_TIMEOUT_MS）。
    runQuery: async (nodeId: string, sql: string, options?: QueryOptions) =>
      getManager().runQuery(nodeId, sql, options),
    fetchResultPage: async (cursorId: string, offset: number, limit: number) =>
      getManager().fetchResultPage(cursorId, offset, limit),
    closeCursor: async (cursorId: string) => getManager().closeCursor(cursorId),
    previewTable: async (nodeId: string, limit?: number) =>
      getManager().previewTable(nodeId, limit),
    // 在线编辑与事务。这四个共享结果集的 60s 超时（写比读慢，见 DriverHostHandle）。
    // 注意 applyEdits **不自动提交**：主进程不做任何"帮你提交"的兜底，
    // 提交时机完全由 UI 决定（用户点"应用"或"回滚"）。这层不做主，
    // 否则会出现"用户以为能反悔、其实已经被提交"的情况。
    applyEdits: async (tableNodeId: string, updates: readonly RowUpdate[]) =>
      getManager().applyEdits(tableNodeId, updates),
    commitTransaction: async (nodeId: string) => getManager().commitTransaction(nodeId),
    rollbackTransaction: async (nodeId: string) => getManager().rollbackTransaction(nodeId),
    transactionState: async (nodeId: string) => getManager().transactionState(nodeId),
    // 增删与完整取值（第五阶段）。共享 60s：写入可能慢，countRows 在大表上是全表扫描。
    insertRow: async (tableNodeId: string, values: Readonly<Record<string, CellValue>>) =>
      getManager().insertRow(tableNodeId, values),
    deleteRows: async (
      tableNodeId: string,
      keys: readonly Readonly<Record<string, CellValue>>[]
    ) => getManager().deleteRows(tableNodeId, keys),
    countRows: async (tableNodeId: string) => getManager().countRows(tableNodeId),
    fetchCellValue: async (cursorId: string, rowIndex: number, columnIndex: number) =>
      getManager().fetchCellValue(cursorId, rowIndex, columnIndex),
    // DDL 与编辑连接（第六阶段）。DDL 可能因锁等待而慢，沿用 60s。
    createTable: async (connectionId: string, spec: TableCreateSpec) =>
      getManager().createTable(connectionId, spec),
    dropTable: async (nodeId: string) => getManager().dropTable(nodeId),
    createView: async (connectionId: string, viewName: string, selectSql: string) =>
      getManager().createView(connectionId, viewName, selectSql),
    dropView: async (nodeId: string) => getManager().dropView(nodeId),
    renameTable: async (nodeId: string, newName: string) =>
      getManager().renameTable(nodeId, newName),
    // 取消：按节点找到所属连接，交给宿主进程的 adapter（PG 真取消，SQLite 返回 false）
    cancelQuery: async (nodeId: string) => getManager().cancelQuery(nodeId),
    updateConnection: async (
      connectionId: string,
      config: Partial<ConnectionConfig>,
      secret?: SecretInput
    ) => getManager().updateConnection(connectionId, config, secret),
    listSqlLibrary: async () => getSqlLibrary().snapshot(),
    recordSqlHistory: async (input: RecordSqlHistoryInput) => {
      const history = getSqlLibrary()
      const manager = getManager()
      const connection = manager.list().find((item) => item.id === input.connectionId)
      const entry = history.record(input, connection?.name ?? '（已删除的连接）')
      return entry
    },
    saveSql: async (id: string | null, name: string, sql: string) =>
      getSqlLibrary().save(id, name, sql),
    removeSavedSql: async (id: string) => getSqlLibrary().removeSaved(id),
    clearSqlHistory: async () => getSqlLibrary().clearHistory()
  }

  // 逐个通道注册，而不是用一个万能通道 + 方法名字符串。
  // 万能通道等于把整个能力面重新打开，preload 的白名单就失效了。
  ipcMain.handle(IPC.listDialects, () => api.listDialects())
  ipcMain.handle(IPC.listConnections, () => api.listConnections())
  ipcMain.handle(IPC.addConnection, (_e, config: ConnectionConfig, secret?: SecretInput) =>
    api.addConnection(config, secret)
  )
  // ---- 持久化连接通道（第四阶段新增） ----
  // 与 addConnection 拆开，是因为它们语义不同：add 是"存一条新的"，
  // 这两个是"对已存的做会话开关"，参数只是一个 id。
  ipcMain.handle(IPC.connectConnection, (_e, connectionId: string) =>
    api.connectConnection(connectionId)
  )
  ipcMain.handle(IPC.disconnectConnection, (_e, connectionId: string) =>
    api.disconnectConnection(connectionId)
  )
  ipcMain.handle(IPC.removeConnection, (_e, connectionId: string) =>
    api.removeConnection(connectionId)
  )
  ipcMain.handle(IPC.testConnection, (_e, config: ConnectionConfig, secret?: SecretInput) =>
    api.testConnection(config, secret)
  )
  ipcMain.handle(IPC.listChildren, (_e, nodeId: string | null) => api.listChildren(nodeId))
  ipcMain.handle(IPC.describeTable, (_e, tableNodeId: string) => api.describeTable(tableNodeId))

  // ---- 结果集通道（第二阶段新增） ----
  // 每个通道单独注册，理由同上：万能通道会让 preload 的白名单失效。
  ipcMain.handle(IPC.runQuery, (_e, nodeId: string, sql: string, options?: QueryOptions) =>
    api.runQuery(nodeId, sql, options)
  )
  ipcMain.handle(
    IPC.fetchResultPage,
    (_e, cursorId: string, offset: number, limit: number) =>
      api.fetchResultPage(cursorId, offset, limit)
  )
  ipcMain.handle(IPC.closeCursor, (_e, cursorId: string) => api.closeCursor(cursorId))
  ipcMain.handle(IPC.previewTable, (_e, nodeId: string, limit?: number) =>
    api.previewTable(nodeId, limit)
  )

  // ---- 在线编辑与事务通道（第三阶段新增） ----
  ipcMain.handle(IPC.applyEdits, (_e, tableNodeId: string, updates: readonly RowUpdate[]) =>
    api.applyEdits(tableNodeId, updates)
  )
  ipcMain.handle(IPC.commitTransaction, (_e, nodeId: string) => api.commitTransaction(nodeId))
  ipcMain.handle(IPC.rollbackTransaction, (_e, nodeId: string) => api.rollbackTransaction(nodeId))
  ipcMain.handle(IPC.transactionState, (_e, nodeId: string) => api.transactionState(nodeId))

  // ---- 增删与完整取值通道（第五阶段新增） ----
  ipcMain.handle(
    IPC.insertRow,
    (_e, tableNodeId: string, values: Readonly<Record<string, CellValue>>) =>
      api.insertRow(tableNodeId, values)
  )
  ipcMain.handle(
    IPC.deleteRows,
    (_e, tableNodeId: string, keys: readonly Readonly<Record<string, CellValue>>[]) =>
      api.deleteRows(tableNodeId, keys)
  )
  ipcMain.handle(IPC.countRows, (_e, tableNodeId: string) => api.countRows(tableNodeId))
  ipcMain.handle(
    IPC.fetchCellValue,
    (_e, cursorId: string, rowIndex: number, columnIndex: number) =>
      api.fetchCellValue(cursorId, rowIndex, columnIndex)
  )

  // ---- DDL 与编辑连接通道（第六阶段新增） ----
  ipcMain.handle(IPC.createTable, (_e, connectionId: string, spec: TableCreateSpec) =>
    api.createTable(connectionId, spec)
  )
  ipcMain.handle(IPC.dropTable, (_e, nodeId: string) => api.dropTable(nodeId))
  ipcMain.handle(
    IPC.createView,
    (_e, connectionId: string, viewName: string, selectSql: string) =>
      api.createView(connectionId, viewName, selectSql)
  )
  ipcMain.handle(IPC.dropView, (_e, nodeId: string) => api.dropView(nodeId))
  ipcMain.handle(IPC.renameTable, (_e, nodeId: string, newName: string) =>
    api.renameTable(nodeId, newName)
  )
  ipcMain.handle(IPC.cancelQuery, (_e, nodeId: string) => api.cancelQuery(nodeId))
  ipcMain.handle(
    IPC.updateConnection,
    (_e, connectionId: string, config: Partial<ConnectionConfig>, secret?: SecretInput) =>
      api.updateConnection(connectionId, config, secret)
  )

  ipcMain.handle(IPC.listSqlLibrary, () => api.listSqlLibrary())
  ipcMain.handle(IPC.recordSqlHistory, (_e, input: RecordSqlHistoryInput) =>
    api.recordSqlHistory(input)
  )
  ipcMain.handle(IPC.saveSql, (_e, id: string | null, name: string, sql: string) =>
    api.saveSql(id, name, sql)
  )
  ipcMain.handle(IPC.removeSavedSql, (_e, id: string) => api.removeSavedSql(id))
  ipcMain.handle(IPC.clearSqlHistory, () => api.clearSqlHistory())
}

app.whenReady().then(() => {
  if (hiddenTestMode && process.platform === 'darwin') {
    // accessory 应用没有 Dock 图标，也不会抢走当前应用的焦点。
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  }
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// macOS 惯例：关闭所有窗口不退出应用；但驱动宿主进程必须随窗口一起清理，
// 否则会留下一堆僵尸子进程占着 SQLite 文件锁。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * 退出前询问渲染进程：还有未提交的改动吗？
 *
 * ===== 为什么必须在退出前拦这一下 =====
 *
 * 事务是**连接级**的。若用户在 A 标签改了数据并「应用」（进了事务但没提交），
 * 然后直接退出应用：
 *   - 旧行为：主进程 `disposeAll` 把宿主进程杀掉，数据库回滚未提交事务——
 *     用户的改动**静默消失**，界面上还显示着「未提交：1 行」。
 *   - 新行为：先问用户「提交还是回滚」，用户选「取消」就留在应用里。
 *
 * 「静默丢数据」比报错严重得多：用户以为自己改过并保存了。
 *
 * ===== 为什么用 preventDefault + 延后 quit =====
 *
 * `before-quit` 里 `event.preventDefault()` 可以取消这次退出。
 * 我们在这个回调里异步询问渲染进程，拿到答案后：
 *   - 放行 → 重新调用 `app.quit()`（这次不再被拦截）
 *   - 取消 → 什么都不做，应用继续开着
 */
let quitConfirmed = false
let quitGuardRunning = false
/** 上一次「关窗口」已被用户确认放行，下一次 close 不再拦截。 */
let windowCloseApproved = false

/**
 * 退出询问的最长等待时间。
 *
 * 为什么需要它：如果渲染进程卡死（wedged），`executeJavaScript` 的 Promise
 * 永远不会 settle，应用就**再也退不出去**了——用户只能强杀进程。
 * 那比丢一次未提交的事务更糟。
 *
 * 为什么给 60 秒：正常情况下用户看一眼对话框就点，最多几十秒。
 * 60 秒远大于任何合理决策时间，所以绝不会「用户还在犹豫就被关掉」，
 * 但足以保证应用不会永久卡在退不出去的状态。
 */
const QUIT_GUARD_TIMEOUT_MS = 60_000

/** 询问渲染进程的结果。 */
type GuardOutcome = 'ok' | 'blocked' | 'unavailable'

/**
 * 询问渲染进程：现在安全吗（没有未应用的编辑、没有未提交的事务）。
 *
 * 供「关最后一个窗口」与「before-quit」两条路径共用——它们的判断依据
 * 完全相同（渲染进程里的未应用编辑 + 连接上的未提交事务），分成两套
 * 迟早会漂移成「关窗口不拦、菜单退出拦」这种不一致。
 *
 * @returns `blocked` 表示用户选择取消；`unavailable` 表示没有界面可问
 *          （渲染进程已退出），此时应当放行——继续拦着只会让应用永远退不出去。
 */
async function askRendererToGuard(): Promise<GuardOutcome> {
  const win = mainWindow
  if (!win || win.isDestroyed()) return 'unavailable'
  try {
    const safe = await Promise.race([
      win.webContents.executeJavaScript(
        `(async () => {
           if (typeof window.dbstudioGuardTransactions !== 'function') return true
           return await window.dbstudioGuardTransactions('退出应用')
         })()`
      ),
      // 渲染进程卡死时的兜底：到期就放行，绝不让应用永久退不出去。
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), QUIT_GUARD_TIMEOUT_MS)
      })
    ])
    return safe === false ? 'blocked' : 'ok'
  } catch (e) {
    // 渲染进程已经没了（崩溃 / 被销毁）：没有界面可保护，也没有用户可询问。
    // 这时**放行**退出——继续拦着只会让应用永远退不出去。
    // 未提交的事务会随宿主进程退出而回滚，不会留下半提交状态。
    console.warn('[main] 退出前事务询问不可用（渲染进程可能已退出），放行退出:', e)
    return 'unavailable'
  }
}

app.on('before-quit', (event) => {
  if (quitConfirmed) {
    // 不 await：before-quit 里异步操作可能来不及。这里发信号即可，
    // 子进程有 SIGTERM 兜底，且它们是我们的子进程，父进程退出后不会变成孤儿常驻。
    void manager?.disposeAll()
    return
  }
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    // 没有窗口可问（已经在关闭流程里）：直接走清理，不无限拦截。
    quitConfirmed = true
    void manager?.disposeAll()
    return
  }
  if (quitGuardRunning) return // 已经在问了，别重复弹框

  event.preventDefault()
  quitGuardRunning = true
  void (async () => {
    const outcome = await askRendererToGuard()
    if (outcome === 'blocked') return // 用户取消：留在应用里
    quitConfirmed = true
    app.quit()
  })().finally(() => {
    quitGuardRunning = false
  })
})

// 任何未捕获异常都要有日志，不能静默——Electron 主进程静默崩溃最难查。
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason)
})
