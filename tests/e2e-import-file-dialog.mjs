/**
 * 「系统文件选择器」通道的行为回归（e2e-import-file-dialog）。
 *
 * ===== 这个测试在验什么 =====
 *
 * 新增的 `chooseImportFile()` 只有一条窄能力：
 * 弹系统文件框 → 返回用户选中的 CSV 绝对路径 → 其它一律 null。
 *
 * 这条能力有**两个容易做错、且错了不会立刻暴露**的地方：
 *   1. **失败时返回了"某个路径"**（取消时给默认路径、异常时给上次路径）。
 *      这会把用户没授权的文件当成导入源——数据可能写错库，而且极难排查。
 *   2. **对话框没有绑在发起窗口上**，或者绑在**已销毁**的窗口上
 *      （后者在 Electron 里会直接抛，用户看到的是"点了没反应"）。
 *
 * 所以这里**不**用字符串 grep 冒充验证，而是真跑代码：
 *   - `src/main/import-file-dialog.ts`：vite 内存编译（write:false）后
 *     用假 dialog 真实驱动，逐条验选中 / 取消 / 抛错 / 空结果 / 窗口销毁。
 *   - `src/main/index.ts`：整包编译，注入**假 electron**，
 *     拿到**真实注册出来的 IPC handler**，用假 event 驱动它。
 *     这样验的是"主进程真的这么接线"，而不是"源码里写着这么接线"。
 *   - `src/preload/index.ts`：同样注入假 electron，
 *     拿到 contextBridge 真正暴露出去的 api 对象，
 *     调用它并检查它**实际**发出去的 IPC 通道名。
 *
 * ===== 边界（刻意不做的事） =====
 *
 * - 不新增任何 execute / filewrite 类通道：测试会断言
 *   「主进程注册的通道集合 === core/api.ts 声明的通道集合」，
 *   多一个少一个都失败。
 * - 只验路径的**产生**，不碰文件内容：helper 全程不读文件。
 * - 不启动真实 Electron、也不弹真框：真框会挂起 CI。
 *   真 GUI 层的接线由 gui-import 那条线覆盖。
 *
 * 产物：全部编译走 write:false（内存），只有假 electron 模块
 * 落到全新隔离目录 out/e2e-import-file-dialog/<时间戳>/ 保留备查。
 * 本测试不删除任何文件。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const require_ = createRequire(import.meta.url)
const normalizeChannels = (channels) => channels.map((channel) => channel.replace(/^dbstudio:/, '')).sort()

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const artifactDir = resolve(root, 'out', 'e2e-import-file-dialog', stamp)
mkdirSync(artifactDir, { recursive: true })

// ---------------------------------------------------------------------------
// 假 electron 模块
// ---------------------------------------------------------------------------

/**
 * 假 electron（主进程用）。
 *
 * 状态挂在 `globalThis` 上：bundle 会被求值成一个独立的 CJS 模块实例，
 * 测试侧要读写它的状态，就必须走全局对象这个"跨实例总线"。
 */
const FAKE_ELECTRON_MAIN = `
const state = (globalThis.__DBSTUDIO_FAKE_ELECTRON_MAIN__ ??= {
  dialogCalls: [],
  handlers: new Map(),
  windows: [],
  /** 由测试设置的：下一次 showOpenDialog 的返回值。 */
  nextDialogResult: { canceled: false, filePaths: ['/tmp/fallback.csv'] },
  /** 由测试设置的：showOpenDialog 抛错时用的错误。 */
  nextDialogError: null,
  /** 由测试设置的：BrowserWindow.fromWebContents 的返回值。 */
  senderWindow: null
})

export const app = {
  whenReady: () => Promise.resolve(),
  on: () => {},
  once: () => {},
  getPath: () => '/tmp/dbstudio-fake-userdata',
  quit: () => {},
  exit: () => {},
  setActivationPolicy: () => {},
  dock: { hide: () => {} }
}

export class BrowserWindow {
  constructor(options = {}) {
    this.options = options
    this.destroyed = false
    this.webContents = {
      setWindowOpenHandler: () => {},
      once: () => {},
      on: () => {},
      removeListener: () => {},
      isDestroyed: () => this.destroyed,
      isCrashed: () => false,
      executeJavaScript: async () => true
    }
    state.windows.push(this)
  }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true }
  close() {}
  on() { return this }
  loadURL() { return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  static getAllWindows() { return state.windows }
  static fromWebContents() { return state.senderWindow }
}

export const dialog = {
  showOpenDialog: async (a, b) => {
    // Electron 有两种重载：带窗口 (window, options) 与不带窗口 (options)。
    const hasWindow = b !== undefined
    const window = hasWindow ? a : null
    const options = hasWindow ? b : a
    state.dialogCalls.push({ window, options })
    if (state.nextDialogError) throw state.nextDialogError
    return state.nextDialogResult
  },
  showMessageBox: async () => ({ response: 0 })
}

export const ipcMain = {
  handle: (channel, fn) => { state.handlers.set(channel, fn) },
  handleOnce: (channel, fn) => { state.handlers.set(channel, fn) },
  removeHandler: (channel) => { state.handlers.delete(channel) }
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

export const shell = { openExternal: async () => {} }
`

/**
 * 假 electron（preload 用）。
 *
 * 与主进程那套**分开**（不同 globalThis 槽位）：preload 的
 * `ipcRenderer.invoke` 不应该真的打到主进程注册的 handler 上，
 * 否则两边的断言会互相干扰。这里只记录"发出去的是什么"。
 */
const FAKE_ELECTRON_PRELOAD = `
const state = (globalThis.__DBSTUDIO_FAKE_ELECTRON_PRELOAD__ ??= {
  invoked: [],
  exposed: null,
  nextResult: null
})

export const ipcRenderer = {
  invoke: async (channel, ...args) => {
    state.invoked.push({ channel, args })
    return state.nextResult
  }
}

export const contextBridge = {
  exposeInMainWorld: (key, api) => { state.exposed = { key, api } }
}
`

const fakeMainPath = join(artifactDir, 'electron-fake-main.mjs')
const fakePreloadPath = join(artifactDir, 'electron-fake-preload.mjs')
writeFileSync(fakeMainPath, FAKE_ELECTRON_MAIN, 'utf8')
writeFileSync(fakePreloadPath, FAKE_ELECTRON_PRELOAD, 'utf8')

// ---------------------------------------------------------------------------
// 编译工具
// ---------------------------------------------------------------------------

/**
 * 把一个 TS 入口编译成内存里的 CJS 文本。
 *
 * `write: false` 是硬要求：不写 out/、不覆盖任何既有产物。
 */
async function compileToCjs(entry, electronAlias) {
  const built = await build({
    configFile: false,
    root,
    logLevel: 'error',
    resolve: {
      alias: electronAlias ? { electron: electronAlias } : {}
    },
    ssr: {
      // electron 必须进 bundle（要注入假实现），不能被外部化。
      noExternal: electronAlias ? ['electron'] : []
    },
    build: {
      write: false,
      ssr: true,
      target: 'node22',
      minify: false,
      rollupOptions: {
        input: { index: entry },
        external: electronAlias ? [] : ['electron'],
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  })
  const outputs = Array.isArray(built) ? built.flatMap((r) => r.output ?? []) : (built.output ?? [])
  const chunk = outputs.find((o) => o.type === 'chunk')
  if (!chunk) throw new Error(`vite 未产出 chunk: ${entry}`)
  return chunk.code
}

/** 在一个带 node require 的沙箱里求值 CJS 文本，返回 module.exports。 */
function evaluateCjs(code, filename) {
  const module_ = { exports: {} }
  const factory = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  factory(
    module_.exports,
    require_,
    module_,
    filename,
    dirname(filename)
  )
  return module_.exports
}

/** 造一个"像 BrowserWindow"的最小对象（只带 isDestroyed）。 */
function fakeWindow(destroyed = false) {
  return { isDestroyed: () => destroyed }
}

// ---------------------------------------------------------------------------
// 第一部分：helper 的纯行为
// ---------------------------------------------------------------------------

const helperCode = await compileToCjs(resolve(root, 'src/main/import-file-dialog.ts'), null)
const helper = evaluateCjs(helperCode, join(artifactDir, 'helper.cjs'))

test('helper：用户选中文件时返回该文件的绝对路径', async () => {
  const calls = []
  const chosen = '/Users/me/data/users.csv'
  const result = await helper.chooseImportFile({
    showOpenDialog: async (window, options) => {
      calls.push({ window, options })
      return { canceled: false, filePaths: [chosen] }
    },
    resolveWindows: () => [fakeWindow()]
  })
  assert.equal(result, chosen)
  assert.equal(calls.length, 1)
})

test('helper：用户取消时返回 null（绝不返回任何路径）', async () => {
  const result = await helper.chooseImportFile({
    showOpenDialog: async () => ({ canceled: true, filePaths: ['/tmp/should-not-be-used.csv'] }),
    resolveWindows: () => [fakeWindow()]
  })
  assert.equal(result, null)
})

test('helper：对话框返回空列表时返回 null', async () => {
  const result = await helper.chooseImportFile({
    showOpenDialog: async () => ({ canceled: false, filePaths: [] }),
    resolveWindows: () => [fakeWindow()]
  })
  assert.equal(result, null)
})

test('helper：对话框抛错向 UI 传播，而不是伪装成取消', async () => {
  await assert.rejects(
    helper.chooseImportFile({
      showOpenDialog: async () => { throw new Error('dialog exploded') },
      resolveWindows: () => [fakeWindow()]
    }),
    /dialog exploded/
  )
})

test('helper：空白路径视为未选择，返回 null', async () => {
  const result = await helper.chooseImportFile({
    showOpenDialog: async () => ({ canceled: false, filePaths: ['   '] }),
    resolveWindows: () => [fakeWindow()]
  })
  assert.equal(result, null)
})

test('helper：多选不启用——传给系统框的 properties 只有 openFile', async () => {
  const calls = []
  await helper.chooseImportFile({
    showOpenDialog: async (window, options) => {
      calls.push({ window, options })
      return { canceled: true, filePaths: [] }
    },
    resolveWindows: () => [fakeWindow()]
  })
  assert.equal(calls.length, 1)
  const { options } = calls[0]
  assert.deepEqual(options.properties, ['openFile'])
  assert.equal(options.properties.includes('multiSelections'), false)
  assert.equal(options.properties.includes('openDirectory'), false)
})

test('helper：过滤器只列 CSV', async () => {
  const calls = []
  await helper.chooseImportFile({
    showOpenDialog: async (window, options) => {
      calls.push({ window, options })
      return { canceled: true, filePaths: [] }
    },
    resolveWindows: () => [fakeWindow()]
  })
  const extensions = calls[0].options.filters.flatMap((f) => f.extensions)
  assert.ok(extensions.includes('csv'))
})

test('helper：对话框绑定到第一个存活窗口（发起窗口优先）', async () => {
  const calls = []
  const senderWindow = fakeWindow()
  const fallbackWindow = fakeWindow()
  await helper.chooseImportFile({
    showOpenDialog: async (window, options) => {
      calls.push({ window, options })
      return { canceled: true, filePaths: [] }
    },
    resolveWindows: () => [senderWindow, fallbackWindow]
  })
  assert.equal(calls[0].window, senderWindow)
})

test('helper：发起窗口已销毁时不弹框，也不回退到另一个窗口', async () => {
  const calls = []
  const destroyed = fakeWindow(true)
  const alive = fakeWindow()
  await helper.chooseImportFile({
    showOpenDialog: async (window, options) => {
      calls.push({ window, options })
      return { canceled: true, filePaths: [] }
    },
    resolveWindows: () => [destroyed, alive]
  })
  assert.equal(calls.length, 0)
  assert.equal(alive.isDestroyed(), false)
  assert.equal(await helper.chooseImportFile({ showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/no.csv'] }), resolveWindows: () => [destroyed, alive] }), null)
})

test('helper：没有存活发起窗口时不调用对话框并返回 null', async () => {
  let calls = 0
  const result = await helper.chooseImportFile({
    showOpenDialog: async () => { calls++; return { canceled: false, filePaths: ['/tmp/ok.csv'] } },
    resolveWindows: () => [fakeWindow(true)]
  })
  assert.equal(calls, 0)
  assert.equal(result, null)
})

test('helper：不读文件——只返回路径，不解析 CSV 内容', async () => {
  // 文件内容里有换行与逗号；返回值必须原样是路径，不含任何内容。
  const chosen = '/tmp/weird, name\nwith-newline.csv'
  const result = await helper.chooseImportFile({
    showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }),
    resolveWindows: () => [fakeWindow()]
  })
  assert.equal(result, chosen)
})

// ---------------------------------------------------------------------------
// 第二部分：主进程的真实接线
// ---------------------------------------------------------------------------

const mainCode = await compileToCjs(resolve(root, 'src/main/index.ts'), fakeMainPath)
const mainExports = evaluateCjs(mainCode, join(artifactDir, 'main.cjs'))

const mainState = globalThis.__DBSTUDIO_FAKE_ELECTRON_MAIN__

test('主进程接线：等待 app ready 后注册了 IPC 通道', async () => {
  // registerIpc() 挂在 app.whenReady().then(...) 上，给它一个微任务窗口。
  await new Promise((r) => setImmediate(r))
  assert.ok(mainState, '假 electron 状态应已建立')
  assert.ok(mainState.handlers.size > 0, '应至少注册了一个 IPC 通道')
})

test('主进程接线：chooseImportFile 通道存在，且调用它会弹框并返回选中路径', async () => {
  await new Promise((r) => setImmediate(r))
  const handler = mainState.handlers.get('dbstudio:chooseImportFile')
  assert.equal(typeof handler, 'function', '应注册 dbstudio:chooseImportFile 通道')

  mainState.dialogCalls.length = 0
  mainState.nextDialogError = null
  mainState.nextDialogResult = { canceled: false, filePaths: ['/tmp/picked.csv'] }

  const senderWindow = { id: 'sender-window', isDestroyed: () => false }
  mainState.senderWindow = senderWindow

  const result = await handler({ sender: { id: 'sender-webcontents' } })
  assert.equal(result, '/tmp/picked.csv')
  assert.equal(mainState.dialogCalls.length, 1)
})

test('主进程接线：对话框绑定到发起调用的那个窗口', async () => {
  await new Promise((r) => setImmediate(r))
  const handler = mainState.handlers.get('dbstudio:chooseImportFile')

  mainState.dialogCalls.length = 0
  mainState.nextDialogError = null
  mainState.nextDialogResult = { canceled: false, filePaths: ['/tmp/picked.csv'] }

  const senderWindow = { id: 'sender-window', isDestroyed: () => false }
  mainState.senderWindow = senderWindow

  await handler({ sender: { id: 'sender-webcontents' } })
  assert.equal(mainState.dialogCalls[0].window, senderWindow, '父窗口应是 sender 解析出的窗口')
  assert.deepEqual(mainState.dialogCalls[0].options.properties, ['openFile'])
  assert.equal(mainState.dialogCalls[0].options.properties.includes('multiSelections'), false)
})

test('主进程接线：发起窗口已销毁时不调用对话框，也不回退主窗口', async () => {
  await new Promise((r) => setImmediate(r))
  const handler = mainState.handlers.get('dbstudio:chooseImportFile')

  mainState.dialogCalls.length = 0
  mainState.nextDialogError = null
  mainState.nextDialogResult = { canceled: false, filePaths: ['/tmp/picked.csv'] }

  const destroyed = { id: 'destroyed-window', isDestroyed: () => true }
  mainState.senderWindow = destroyed

  const result = await handler({ sender: { id: 'sender-webcontents' } })
  assert.equal(mainState.dialogCalls.length, 0, '销毁窗口时不应弹框')
  assert.equal(result, null)
})

test('主进程接线：取消返回 null；对话框异常传播给 UI', async () => {
  await new Promise((r) => setImmediate(r))
  const handler = mainState.handlers.get('dbstudio:chooseImportFile')

  mainState.dialogCalls.length = 0
  mainState.senderWindow = { id: 'sender-window', isDestroyed: () => false }

  mainState.nextDialogError = null
  mainState.nextDialogResult = { canceled: true, filePaths: [] }
  assert.equal(await handler({ sender: {} }), null)

  mainState.nextDialogError = new Error('dialog exploded')
  await assert.rejects(handler({ sender: {} }), /dialog exploded/)
  mainState.nextDialogError = null
})

test('主进程接线：缺失 sender 时不调用对话框且返回 null', async () => {
  await new Promise((r) => setImmediate(r))
  const handler = mainState.handlers.get('dbstudio:chooseImportFile')
  mainState.dialogCalls.length = 0
  mainState.senderWindow = { id: 'fallback-window', isDestroyed: () => false }
  mainState.nextDialogError = null
  mainState.nextDialogResult = { canceled: false, filePaths: ['/tmp/should-not-open.csv'] }
  assert.equal(await handler({}), null)
  assert.equal(mainState.dialogCalls.length, 0)
})

test('主进程接线：没有多余通道——注册集合等于 core/api.ts 声明的集合', async () => {
  await new Promise((r) => setImmediate(r))
  const apiCode = await compileToCjs(resolve(root, 'src/core/api.ts'), null)
  const apiModule = evaluateCjs(apiCode, join(artifactDir, 'api.cjs'))
  const declared = normalizeChannels(Object.values(apiModule.IPC))
  const registered = normalizeChannels([...mainState.handlers.keys()])
  assert.deepEqual(
    registered,
    declared,
    '主进程注册的 IPC 通道必须与 core/api.ts 声明的一一对应（不允许出现 execute/filewrite 之类的额外通道）'
  )
})

// ---------------------------------------------------------------------------
// 第三部分：preload 的真实接线
// ---------------------------------------------------------------------------

const preloadCode = await compileToCjs(resolve(root, 'src/preload/index.ts'), fakePreloadPath)
evaluateCjs(preloadCode, join(artifactDir, 'preload.cjs'))

const preloadState = globalThis.__DBSTUDIO_FAKE_ELECTRON_PRELOAD__

test('preload 接线：contextBridge 暴露了 chooseImportFile', () => {
  assert.ok(preloadState, '假 electron 状态应已建立')
  assert.ok(preloadState.exposed, 'preload 应已调用 contextBridge.exposeInMainWorld')
  assert.equal(preloadState.exposed.key, 'dbstudio')
  assert.equal(typeof preloadState.exposed.api.chooseImportFile, 'function')
})

test('preload 接线：调用后真的发出 dbstudio:chooseImportFile 通道且不夹带参数', async () => {
  preloadState.invoked.length = 0
  preloadState.nextResult = '/tmp/from-preload.csv'
  const value = await preloadState.exposed.api.chooseImportFile()
  assert.equal(preloadState.invoked.length, 1)
  assert.equal(preloadState.invoked[0].channel, 'dbstudio:chooseImportFile')
  assert.deepEqual(preloadState.invoked[0].args, [], '不应传递路径等参数')
  assert.equal(value, '/tmp/from-preload.csv')
})

test('preload 接线：通道常量在 core/api.ts 与 preload 之间一致', async () => {
  const apiCode = await compileToCjs(resolve(root, 'src/core/api.ts'), null)
  const apiModule = evaluateCjs(apiCode, join(artifactDir, 'api2.cjs'))
  assert.equal(apiModule.IPC.chooseImportFile, 'dbstudio:chooseImportFile')
  assert.equal(preloadState.invoked[0].channel, apiModule.IPC.chooseImportFile)
})

test('preload 接线：暴露的 api 方法集合与 core/api.ts 的通道集合一致', async () => {
  const apiCode = await compileToCjs(resolve(root, 'src/core/api.ts'), null)
  const apiModule = evaluateCjs(apiCode, join(artifactDir, 'api3.cjs'))
  const exposed = Object.keys(preloadState.exposed.api).sort()
  const declared = normalizeChannels(Object.values(apiModule.IPC))
  assert.deepEqual(exposed, declared, 'preload 白名单必须与 core/api.ts 的通道一一对应')
})

// 产物目录仅供人工复核，测试不删除任何文件。
console.log(`[e2e-import-file-dialog] 产物目录: ${artifactDir}`)
void pathToFileURL
