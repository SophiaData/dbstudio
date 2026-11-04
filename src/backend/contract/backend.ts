/**
 * 应用级后端契约（application contract）。
 *
 * ===== 为什么还要在 `core/api.ts` 之上再包一层 =====
 *
 * `DbStudioApi` 描述的是「preload 通过 contextBridge 暴露了什么」，
 * 它天然带着 Electron 时代的形状。渲染层真正需要的其实是更高一层的语义：
 * 「这个应用能做哪些事」。两者目前完全重合，但未来不是——例如 HTTP
 * transport 没有 `chooseImportFile`（那是本机对话框），却可能有批量上传接口。
 *
 * 所以这里先把 `DbStudioApi` **原样**收编成 `BackendApi`：
 *
 *   - 不改任何方法签名，`BackendClient` 仍可无缝传给现有 renderer 代码；
 *   - 通过 `BackendMethod` / `BackendArgs` / `BackendValue` 派生出
 *     transport 需要的「方法名 → 参数元组 → 返回值」映射；
 *   - 等真正出现 transport 差异时，只改这一层，渲染层不用再迁一次。
 *
 * 本文件必须保持环境无关：只允许 type import，不碰 electron / node / 驱动。
 */

import type { DbStudioApi } from '../../core/api'

/**
 * 应用后端契约。
 *
 * 当前直接复用既有公开 API 形状，保证第一切片**零行为变化**。
 * 后续如需为 HTTP 等 transport 收窄能力面，应在这里显式扩展/拆分，
 * 而不是在各 transport 里各自发明一套方法名。
 */
export type BackendApi = DbStudioApi

/** Electron shell 能力面，包含本机文件选择器。 */
export type DesktopBackendApi = BackendApi

/**
 * 远程 transport 能力面。
 *
 * HTTP/Tauri server 没有当前桌面的原生文件选择器，也不应接收服务端本机
 * 路径作为远程文件能力；远程导入/导出将在 upload/download artifact 契约
 * 中单独定义。因此它从 application API 中显式排除 shell-only 方法。
 */
export type RemoteBackendApi = Omit<BackendApi, 'chooseImportFile'>

/** 后端方法名。transport 用它做路由与白名单校验。 */
export type BackendMethod = keyof BackendApi
export type RemoteBackendMethod = keyof RemoteBackendApi

/** 某个后端方法的参数元组，可直接展开成 `...args`。 */
export type BackendArgs<K extends BackendMethod> = Parameters<BackendApi[K]>
export type RemoteBackendArgs<K extends RemoteBackendMethod> = Parameters<RemoteBackendApi[K]>

/**
 * 某个后端方法**解析后**的返回值。
 *
 * 契约里的方法都是异步的，但调用方通常只关心 `await` 之后的形状，
 * 所以这里用 `Awaited` 把 `Promise<T>` 拆成 `T`。transport 层再决定
 * 把它包回 Promise 还是别的响应结构。
 */
export type BackendValue<K extends BackendMethod> = Awaited<ReturnType<BackendApi[K]>>
export type RemoteBackendValue<K extends RemoteBackendMethod> = Awaited<
  ReturnType<RemoteBackendApi[K]>
>
