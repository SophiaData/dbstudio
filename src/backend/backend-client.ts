/**
 * Renderer-facing backend facade.
 *
 * Renderer code depends on this contract instead of discovering a transport
 * through `window.dbstudio`. The first transport is Electron's preload API;
 * later transports (Tauri IPC or HTTP) can implement the same contract without
 * changing renderer components.
 *
 * 类型出口约定：
 *   - application contract（`BackendApi` 及方法派生类型）在本文件统一再导出，
 *     renderer 不需要知道它住在 `contract/backend.ts`；
 *   - transport 的调用/响应形状同理；
 *   - 运行时行为（resolve / require / create）保持原样，第一切片不引入包装层。
 */

import type { DbStudioApi } from '../core/api'
import type { BackendApi } from './contract/backend'

export type {
  BackendApi,
  BackendArgs,
  BackendMethod,
  BackendValue,
  DesktopBackendApi,
  RemoteBackendApi,
  RemoteBackendArgs,
  RemoteBackendMethod,
  RemoteBackendValue
} from './contract/backend'
export type {
  BackendEnvelope,
  BackendErrorCode,
  BackendErrorPayload,
  BackendErrorPayloadOptions,
  BackendFailureEnvelope,
  BackendSuccessEnvelope
} from './contract/errors'
export {
  BackendError,
  backendErrorFromPayload,
  isBackendEnvelope,
  isBackendError,
  isBackendErrorCode,
  isBackendErrorPayload,
  isEnvelope,
  sanitizeBackendDetails,
  toBackendErrorPayload
} from './contract/errors'
export type {
  BackendBinaryPayload,
  BackendCall,
  BackendCallOptions,
  BackendFailureResponse,
  BackendResponse,
  BackendSuccessResponse,
  BackendTransportValue,
  TransportChannel
} from './transport/transport'
export {
  createHttpBackendClient,
  createRequestId,
  DEFAULT_HTTP_TIMEOUT_MS
} from './transport/http-transport'
export type {
  HttpBackendClient,
  HttpBackendClientOptions,
  HttpFetch,
  HttpHeaders,
  HttpRequestInit,
  HttpResponseLike
} from './transport/http-transport'
export {
  createBackendDispatcher,
  createJsonBackendDispatcher
} from './transport/dispatcher'
export type {
  BackendDispatcher,
  BackendDispatcherOptions
} from './transport/dispatcher'
export {
  base64ToBytes,
  bytesToBase64,
  decodeBackendRequest,
  decodeBackendResponse,
  decodeWireValue,
  encodeBackendRequest,
  encodeBackendResponse,
  encodeWireValue,
  parseBackendRequest,
  parseBackendResponse,
  stringifyBackendRequest,
  stringifyBackendResponse,
  WireCodecError
} from './transport/wire-codec'
export type {
  DecodedBackendCall,
  WireBackendFailureResponse,
  WireBackendRequest,
  WireBackendResponse,
  WireBackendSuccessResponse
} from './transport/wire-codec'
export {
  BACKEND_METHOD_MANIFEST,
  REMOTE_BACKEND_METHOD_MANIFEST
} from './contract/method-manifest'

/**
 * Stable application backend contract consumed by renderer features.
 *
 * It is intentionally a structural extension of the existing public API shape
 * in this first slice: `BackendApi` currently aliases `DbStudioApi`, so every
 * renderer call site keeps compiling unchanged. The transport lookup is isolated
 * here so the next phase can split the application contract from the Electron
 * IPC contract without another renderer-wide migration.
 */
export interface BackendClient extends BackendApi {}

interface ElectronWindow extends Window {
  dbstudio?: DbStudioApi
}

/** Adapt the current Electron preload object to the renderer backend contract. */
export function createElectronBackendClient(api: DbStudioApi): BackendClient {
  return api
}

/** Resolve the backend exposed by the current desktop shell. */
export function resolveBackendClient(): BackendClient | null {
  const api = (globalThis as unknown as ElectronWindow).dbstudio
  return api ? createElectronBackendClient(api) : null
}

/** Resolve the backend or return a user-facing startup error. */
export function requireBackendClient(): BackendClient {
  const client = resolveBackendClient()
  if (!client) {
    throw new Error('需要桌面后端：请通过 dbstudio 的桌面 shell 启动界面。')
  }
  return client
}
