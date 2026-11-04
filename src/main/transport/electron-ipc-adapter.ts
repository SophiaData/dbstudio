/**
 * Electron IPC transport adapter。
 *
 * ===== 这一层负责什么 =====
 *
 * 把 `DbStudioApi` 的白名单方法逐个注册成 Electron IPC handler。
 * 它只做三件事：
 *   1. 从组合根注入的 `getManager` / `getSqlLibrary` 取到应用服务；
 *   2. 把 IPC 参数原样转发给对应方法（不做业务规则、不解析节点 id）；
 *   3. 把方法返回值包成 `{ ok: true, value }`，把异常归一化成
 *      `{ ok: false, error: BackendErrorPayload }` 后交回 Electron。
 *      这样渲染层既能拿到业务值，也能拿到分类化、可结构化克隆的错误。
 *
 * ===== 为什么允许 import electron =====
 *
 * transport 是「桌面 shell 与后端契约之间的适配器」，天然认识 Electron。
 * 但 `backend/contract`、`core` 与 application services 都不认识它：
 * 以后接 HTTP / Tauri 时，只需要另写一个 transport，不碰业务代码。
 *
 * ===== 为什么仍然逐个通道注册 =====
 *
 * 注册来源是 `BACKEND_METHOD_MANIFEST` 这份**编译期静态清单**，
 * 不是渲染进程传来的方法名。每个清单项都会生成独立的 `ipcMain.handle`，
 * 因此不存在「一个万能通道 + 任意方法字符串」的能力面回退路径；
 * 清单之外的通道一律不存在。
 *
 * ===== chooseImportFile 的特例 =====
 *
 * 它是唯一需要 `event.sender` 的方法：系统文件框必须挂在**发起这次调用的
 * 那个窗口**上，否则对话框可能跑到别的窗口前面。这里只把 `event.sender`
 * 传给注入的 shell port，取消 / 无发起窗口返回 `null` 的语义仍由
 * `import-file-dialog.ts` 决定。
 */

import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { BACKEND_METHOD_MANIFEST } from '../../backend/contract/method-manifest'
import {
  toBackendErrorPayload,
  type BackendEnvelope
} from '../../backend/contract/errors'
import type { BackendMethod } from '../../backend/contract/backend'
import type { DbStudioApi } from '../../core/api'
import type { ConnectionManager } from '../ConnectionManager'
import type { SqlLibraryStore } from '../SqlLibraryStore'
import { createApplicationApi } from '../application/create-application-api'

/**
 * 主进程侧的 API 面。
 *
 * 与 `DbStudioApi` 的唯一差别：`chooseImportFile` 多一个**可选**的 `sender`，
 * 用来把系统对话框绑定到"发起这次调用的那个窗口"。
 *
 * sender 缺失时返回 `null`，不会回退到主窗口；这只用于内部测试与类型适配，
 * 实际 IPC handler 始终传入 `event.sender`。
 */
export type MainApi = Omit<DbStudioApi, 'chooseImportFile'> & {
  chooseImportFile(sender?: WebContents): Promise<string | null>
}

/**
 * transport 需要的外部依赖。
 *
 * 全部由 `src/main/index.ts` 这个组合根注入：
 *   - `getManager` / `getSqlLibrary` 保留延迟初始化语义；
 *   - `chooseImportFile` 是 shell port，负责真正的系统对话框。
 */
export interface ElectronIpcAdapterOptions {
  readonly getManager: () => ConnectionManager
  readonly getSqlLibrary: () => SqlLibraryStore
  /**
   * 打开 CSV 文件选择框的 shell port。
   *
   * 参数是发起调用的渲染进程；没有可用窗口时必须返回 `null`，
   * 绝不能回退到"随便一个窗口"或"某个默认路径"。
   */
  readonly chooseImportFile: (sender?: WebContents) => Promise<string | null>
}

/**
 * 把一个 handler 的调用结果统一编码成 transport 信封。
 *
 * 同步 throw 与 Promise reject 都会进入同一个 catch：
 * `async` 函数体里同步抛出的异常会变成 rejected promise，因此不需要
 * 额外的 `try` 区分两种失败路径。
 *
 * `callId` 直接用通道名：当前 IPC 协议没有真实 request id，通道名已经是
 * 稳定且足够的关联标识；不为此引入额外的全局计数状态。payload 里不会出现
 * stack / cause，`details` 由 `toBackendErrorPayload` 负责脱敏。
 */
async function invokeAndEncode(
  method: BackendMethod,
  channel: string,
  invoke: () => unknown
): Promise<BackendEnvelope<unknown>> {
  try {
    return { ok: true, value: await invoke() }
  } catch (error) {
    return {
      ok: false,
      error: toBackendErrorPayload(error, { method, callId: channel })
    }
  }
}

/**
 * 注册全部白名单 IPC handler。
 *
 * 调用方（`src/main/index.ts`）只负责提供 manager / SQL library /
 * 文件对话框 shell port；业务逻辑全部留在 application services 与
 * `ConnectionManager` 里。
 */
export function registerElectronIpc(options: ElectronIpcAdapterOptions): void {
  const { getManager, getSqlLibrary, chooseImportFile: chooseImportFileShell } = options

  const api: MainApi = {
    ...createApplicationApi({ getManager, getSqlLibrary }),
    // 对外契约仍然是零参；sender 只用于绑定对话框父窗口。
    chooseImportFile: async (sender) => chooseImportFileShell(sender)
  }

  // 编译期证据：含内部可选参数的实现仍然满足对外契约 DbStudioApi。
  // 如果哪天某个方法的参数或返回值形状变了，这里立刻报错。
  const _apiContract: DbStudioApi = api
  void _apiContract

  // 按静态清单逐个注册。每次循环都会创建一个独立的 handler，
  // 通道完全由清单（也就是 `core/api.ts` 的 IPC 常量）决定；
  // 渲染进程无法提供方法名，因此不是"万能任意方法通道"。
  for (const { method, channel } of BACKEND_METHOD_MANIFEST) {
    ipcMain.handle(channel, (event, ...args) =>
      invokeAndEncode(method, channel, () => {
        // 唯一需要 sender 的方法：把发起窗口交给 shell port。
        if (method === 'chooseImportFile') {
          return api.chooseImportFile(event.sender)
        }
        // 每个方法的参数形状仍由 `MainApi` 约束；这里只是把
        // Electron 的可变参数元组转发给对应方法。
        const handler = api[method] as (...forwarded: unknown[]) => unknown
        return handler(...args)
      })
    )
  }
}
