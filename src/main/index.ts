/**
 * Electron 主进程入口。
 *
 * 职责严格限定为三件事：
 *   1. 开窗口
 *   2. 把 manager / SQL library / 文件对话框 shell port 交给
 *      `transport/electron-ipc-adapter`，由它把 `DbStudioApi` 注册为 IPC handler
 *      （实现身份是「编排者」，不含数据库知识）
 *   3. 应用退出时回收所有驱动宿主子进程
 *
 * 注意这里**没有一处数据库代码**——所有数据库能力都在子进程里。
 * 这正是剖析结论「陷阱 1 → 进程隔离」的落地形态：
 * 主进程即使遇到某个驱动的原生崩溃，也只是那一个宿主进程挂掉。
 */

import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import type { WebContents } from 'electron'
import { join } from 'node:path'
import { BUILTIN_DIALECT_METADATA } from '../drivers/dialect-metadata'
import { ConnectionManager } from './ConnectionManager'
import { ConnectionStore, type SecretCipher } from './ConnectionStore'
import { chooseImportFile } from './import-file-dialog'
import { SqlLibraryStore } from './SqlLibraryStore'
import { registerElectronIpc } from './transport/electron-ipc-adapter'
import {
  createHttpServer,
  createHttpServerComposition,
  DEFAULT_OWNER_QUOTA,
  OwnerGovernance,
  createHttpAuthResolver,
  createHttpServerPrincipalResolver,
  readHttpServerStartupConfig,
  type HttpAuthProvider,
  type HttpRequestAuditSink,
  type HttpServer,
  type HttpServerPrincipalResolver,
  type OwnerQuota
} from './server'

let mainWindow: BrowserWindow | null = null
let manager: ConnectionManager | null = null
let sqlLibrary: SqlLibraryStore | null = null
let httpServer: HttpServer | null = null
let windowCleanup: Promise<void> = Promise.resolve()

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

export interface HttpServerStartupDependencies {
  readonly resolvePrincipal?: HttpServerPrincipalResolver
  readonly authProvider?: HttpAuthProvider
  readonly governance?: OwnerGovernance
  readonly ownerQuota?: OwnerQuota
  readonly remoteOutboundPolicy?: import('../backend/contract/remote').RemoteOutboundPolicy
  readonly auditSink?: HttpRequestAuditSink
  readonly metricsSink?: HttpRequestAuditSink
}

function positiveEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数`)
  }
  return value
}

function startupOwnerQuota(env: NodeJS.ProcessEnv): OwnerQuota {
  return {
    maxConcurrentRequests: positiveEnv(env, 'DBSTUDIO_HTTP_MAX_CONCURRENT_REQUESTS', DEFAULT_OWNER_QUOTA.maxConcurrentRequests),
    maxConnections: positiveEnv(env, 'DBSTUDIO_HTTP_MAX_CONNECTIONS', DEFAULT_OWNER_QUOTA.maxConnections),
    maxStorageBytes: positiveEnv(env, 'DBSTUDIO_HTTP_MAX_STORAGE_BYTES', DEFAULT_OWNER_QUOTA.maxStorageBytes)
  }
}

function consoleAuditSink(prefix: string): HttpRequestAuditSink {
  return {
    record: (event) => console.log(`[${prefix}] ${JSON.stringify(event)}`)
  }
}

export async function startConfiguredHttpServer(
  dependencies: HttpServerStartupDependencies = {}
): Promise<void> {
  const config = readHttpServerStartupConfig(process.env)
  if (!config) return

  const governance = dependencies.governance ?? new OwnerGovernance({
    quota: dependencies.ownerQuota ?? startupOwnerQuota(process.env),
    audit: (event) => console.log(`[http-owner-audit] ${JSON.stringify(event)}`)
  })
  const auditSink = dependencies.auditSink ?? consoleAuditSink('http-audit')
  const metricsSink = dependencies.metricsSink ?? consoleAuditSink('http-metrics')

  const resolvePrincipal = dependencies.resolvePrincipal ??
    (dependencies.authProvider ? createHttpAuthResolver(dependencies.authProvider) : undefined)

  const composition = createHttpServerComposition({
    dialects: BUILTIN_DIALECT_METADATA,
    baseDir: app.getPath('userData'),
    cipher: createSafeStorageCipher(),
    onLog: (level, msg) => console[level === 'error' ? 'error' : 'log'](msg),
    remoteOutboundPolicy: dependencies.remoteOutboundPolicy ?? config.remoteOutboundPolicy,
    artifactMaxBytes: positiveEnv(process.env, 'DBSTUDIO_HTTP_ARTIFACT_MAX_BYTES', 100 * 1024 * 1024),
    artifactMaxTotalBytes: positiveEnv(process.env, 'DBSTUDIO_HTTP_ARTIFACT_MAX_TOTAL_BYTES', 1024 * 1024 * 1024),
    artifactSweepIntervalMs: positiveEnv(process.env, 'DBSTUDIO_HTTP_ARTIFACT_SWEEP_INTERVAL_MS', 60 * 1000),
    governance
  })
  const server = createHttpServer({
    composition,
    listen: { host: config.host, port: config.port },
    resolvePrincipal: createHttpServerPrincipalResolver(config, resolvePrincipal),
    governance,
    auditSink,
    metricsSink
  })
  try {
    const address = await server.listen()
    httpServer = server
    console.log(`[main] HTTP server 已监听 ${address.address}:${address.port}`)
  } catch (error) {
    await server.close().catch(() => undefined)
    throw error
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

  const win = mainWindow
  let closeApproved = false
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    const closingManager = manager
    manager = null
    windowCleanup = closingManager?.disposeAll() ?? Promise.resolve()
  })
  win.on('close', (event) => {
    if (quitConfirmed || closeApproved) return
    event.preventDefault()
    if (quitGuardRunning) return
    quitGuardRunning = true
    void (async () => {
      if (!(await askRendererToGuard(win))) return
      if (win.isDestroyed()) return
      closeApproved = true
      quitGuardRunning = false
      win.close()
    })().catch((error) => console.error('[main] 关闭确认失败:', error))
      .finally(() => { quitGuardRunning = false })
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
      const gridApi = api ? ['runQuery','fetchResultPage','closeCursor','previewTable','tableSelectSql']
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
      // 结果集：DOM 容器 + SQL 输入框 + 5 个 API 必须齐全（含 tableSelectSql）
      r.hasTabbar &&
      r.hasResultStack &&
      r.hasSqlEditorHost &&
      r.hasSqlEditorTextarea &&
      r.gridApiCount === 5 &&
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
 * 打开 CSV 文件选择框的 shell port。
 *
 * 只做一件事：把发起这次 IPC 调用的渲染进程 `sender` 解析成父窗口，
 * 再交给 `chooseImportFile`（系统对话框逻辑本身仍在 import-file-dialog.ts）。
 *
 * 没有发起窗口时返回 null，绝不回退到主窗口或某个默认路径。
 */
function chooseImportFileForSender(sender?: WebContents): Promise<string | null> {
  return chooseImportFile<BrowserWindow>({
    showOpenDialog: async (window, options) => {
      if (!window) throw new Error('导入文件对话框缺少发起窗口')
      const result = await dialog.showOpenDialog(window, options)
      return { canceled: result.canceled, filePaths: result.filePaths }
    },
    resolveWindows: () => {
      const fromSender = sender ? BrowserWindow.fromWebContents(sender) : null
      return [fromSender]
    }
  })
}

app.whenReady().then(async () => {
  if (hiddenTestMode && process.platform === 'darwin') {
    // accessory 应用没有 Dock 图标，也不会抢走当前应用的焦点。
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  }
  registerElectronIpc({
    getManager,
    getSqlLibrary,
    chooseImportFile: chooseImportFileForSender
  })
  await startConfiguredHttpServer()
  createWindow()

  app.on('activate', () => {
    void windowCleanup.then(() => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}).catch((error) => {
  console.error('[main] 启动 HTTP server 失败:', error)
  app.quit()
})

// macOS 惯例：关闭所有窗口不退出应用；但驱动宿主进程必须随窗口一起清理，
// 否则会留下一堆僵尸子进程占着 SQLite 文件锁。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// One pending request covers both window close and application quit. Repeated
// requests must still preventDefault while the renderer is asking the user.
let quitConfirmed = false
let quitGuardRunning = false

async function askRendererToGuard(win: BrowserWindow): Promise<boolean> {
  if (win.isDestroyed()) return false
  const contents = win.webContents
  const askForce = async (): Promise<boolean> => {
    if (win.isDestroyed()) return false
    const result = await dialog.showMessageBox(win, {
      type: 'warning', title: '无法确认未保存改动',
      message: '页面无响应或已崩溃，无法检查当前连接上的未提交事务。',
      detail: '取消会保留窗口；退出并放弃可能丢失未应用编辑，并回滚未提交事务。',
      buttons: ['取消', '退出并放弃'], defaultId: 0, cancelId: 0, noLink: true
    })
    return result.response === 1
  }
  if (contents.isDestroyed() || contents.isCrashed()) return askForce()

  let finishUnavailable: (value: boolean) => void = () => {}
  const unavailable = new Promise<boolean>((resolve) => { finishUnavailable = resolve })
  let nativePending = false
  const recover = async (crashed: boolean): Promise<void> => {
    if (nativePending) return
    nativePending = true
    try {
      const force = await askForce()
      // On an unresponsive but living renderer, cancel leaves its original
      // confirmation pending. A crash cannot ever deliver that decision.
      if (force || crashed) finishUnavailable(force)
    } finally { nativePending = false }
  }
  const onGone = (): void => { void recover(true) }
  const onUnresponsive = (): void => { void recover(false) }
  const onDestroyed = (): void => finishUnavailable(false)
  contents.on('render-process-gone', onGone)
  contents.on('unresponsive', onUnresponsive)
  contents.on('destroyed', onDestroyed)
  // This is a diagnostic deadline only; a user considering a dialog never
  // loses either the pending decision or their data because a timer fired.
  const timer = setTimeout(() => {
    console.warn('[main] 仍在等待退出确认，窗口和未保存改动保持不变')
  }, 60_000)
  try {
    const decision = contents.executeJavaScript(`(async () => {
      if (typeof window.dbstudioGuardTransactions !== 'function') throw new Error('页面事务检查尚未就绪')
      return (await window.dbstudioGuardTransactions('退出应用')) === true
    })()`).catch(async (error) => {
      console.warn('[main] 无法读取退出确认:', error)
      if (!nativePending) return askForce()
      return unavailable
    })
    return (await Promise.race([decision, unavailable])) === true
  } finally {
    clearTimeout(timer)
    contents.removeListener('render-process-gone', onGone)
    contents.removeListener('unresponsive', onUnresponsive)
    contents.removeListener('destroyed', onDestroyed)
  }
}

app.on('before-quit', (event) => {
  if (quitConfirmed) return
  event.preventDefault()
  if (quitGuardRunning) return
  quitGuardRunning = true
  void (async () => {
    const win = mainWindow
    if (win && !win.isDestroyed() && !(await askRendererToGuard(win))) return
    const closingHttpServer = httpServer
    await Promise.all([windowCleanup, manager?.disposeAll(), closingHttpServer?.close()])
    manager = null
    if (httpServer === closingHttpServer) httpServer = null
    quitConfirmed = true
    app.quit()
  })().catch((error) => console.error('[main] 退出确认失败:', error))
    .finally(() => { quitGuardRunning = false })
})

// 任何未捕获异常都要有日志，不能静默——Electron 主进程静默崩溃最难查。
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason)
})
