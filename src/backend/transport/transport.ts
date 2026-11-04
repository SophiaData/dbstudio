/**
 * Transport 抽象：transport 层与上层之间唯一的数据形状。
 *
 * ===== 边界 =====
 *
 * 本文件只定义类型，不实现任何 transport。第一个实现仍是
 * `backend-client.ts` 里的 Electron preload 对象；以后可能出现 Tauri IPC
 * 或 HTTP。所有实现都必须满足这里的调用/响应形状，这样渲染层可以只依赖
 * `BackendApi`，而不认识具体通道。
 *
 * **禁止** import electron、node 内置模块、main、preload、driver-host 或驱动实现。
 * 这里只允许依赖 application contract 的类型，保证在浏览器、Node、测试环境
 * 里都能安全参与类型检查。
 */

import type { BackendArgs, BackendMethod, BackendValue } from '../contract/backend'
import type { BackendErrorPayload } from '../contract/errors'

/**
 * 传输通道标识。
 *
 * 新增 transport 时在这里扩展，而不是让实现方各写字符串。
 * 第一个落地的是 `electron`（contextBridge + ipcRenderer.invoke）。
 */
export type TransportChannel = 'electron' | 'tauri' | 'http'

/**
 * 二进制载荷的类型边界。
 *
 * 契约只承诺「二进制以 `Uint8Array` 出现」，**不规定**具体编码方式：
 * Electron IPC 可以直接结构化克隆，HTTP 需要 base64 / multipart / 分块，
 * 这些都属于 transport 的实现细节。把边界收在这里，可以避免 `Buffer`
 * 或 Electron 类型泄漏进环境无关的契约文件。
 */
export type BackendBinaryPayload = Uint8Array

/**
 * transport 可以承载的返回值。
 *
 * 大多数方法返回 JSON 可序列化的值；二进制结果（未来的导出/下载）允许
 * 以 `Uint8Array` 跨边界，由具体 transport 决定是否分块或编码。
 */
export type BackendTransportValue<K extends BackendMethod> =
  | BackendValue<K>
  | BackendBinaryPayload

/** 单次后端调用的可选参数。 */
export interface BackendCallOptions {
  /**
   * 取消信号。
   *
   * transport 应把它映射到自身的取消机制（例如 IPC 取消消息、HTTP abort）。
   * 契约不保证所有后端方法都支持取消；不支持时应忽略而不是伪造成功。
   */
  readonly signal?: AbortSignal
  /** 超时毫秒数。未指定时由具体 transport 决定默认值。 */
  readonly timeoutMs?: number
  /** 期望使用的通道；多 transport 并存时用于路由。 */
  readonly channel?: TransportChannel
}

/**
 * 一次后端调用。
 *
 * `method` 与 `args` 由 `BackendApi` 派生，保证调用名和参数不会与契约漂移。
 * `id` 是调用标识，响应会原样带回，便于并发调用配对。
 */
export interface BackendCall<K extends BackendMethod = BackendMethod> {
  readonly id: string
  readonly method: K
  readonly args: BackendArgs<K>
  readonly options?: BackendCallOptions
}

/** 成功响应。 */
export interface BackendSuccessResponse<K extends BackendMethod = BackendMethod> {
  readonly id: string
  readonly ok: true
  readonly value: BackendTransportValue<K>
}

/** 失败响应。 */
export interface BackendFailureResponse {
  readonly id: string
  readonly ok: false
  readonly error: BackendErrorPayload
}

/**
 * 一次后端调用的响应。
 *
 * 用 `ok` 做可辨识联合，而不是让 `value` / `error` 都可选：
 * 后者会允许「同时有值又有错」或「两者都没有」这类非法状态，
 * 而且调用方每次都得额外判空。
 */
export type BackendResponse<K extends BackendMethod = BackendMethod> =
  | BackendSuccessResponse<K>
  | BackendFailureResponse
