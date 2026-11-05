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

import type { ConnectionSummary, DbStudioApi } from '../core/api'
import type { SecretInput, TestConnectionResult } from '../core/driver'
import type {
  BackendApi,
  RemoteBackendArgs,
  RemoteBackendMethod,
  RemoteBackendValue
} from './contract/backend'
import type { BackendCallOptions } from './transport/transport'
import {
  createHttpBackendClient,
  type HttpBackendClient,
  type HttpBackendClientOptions,
  type HttpHeaders
} from './transport/http-transport'
import { BackendError } from './contract/errors'
import {
  remoteConnectionPath,
  type RemoteConnectionCreateRequest,
  type RemoteConnectionUpdateRequest
} from './contract/remote-connection'

export type {
  ArtifactApi,
  ArtifactDownloadTicket,
  ArtifactId,
  ArtifactMetadata,
  ArtifactPurpose,
  ArtifactReference,
  ArtifactStatus,
  ArtifactUploadTicket,
  CreateArtifactUploadRequest,
  RemoteExportArtifactOutput,
  RemoteImportArtifactInput
} from './contract/artifact'
export {
  isArtifactId,
  isArtifactReference,
  isSha256
} from './contract/artifact'

export type {
  RemoteConnectionCreateRequest,
  RemoteConnectionMethod,
  RemoteConnectionRouteDescription,
  RemoteConnectionUpdateRequest
} from './contract/remote-connection'
export {
  REMOTE_CONNECTION_ROUTES,
  isRemoteConnectionMethod,
  remoteConnectionPath,
  toRemoteConnectionSummary
} from './contract/remote-connection'

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
  BackendPrincipal,
  BackendRequestContext,
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
  BackendApiResolver,
  BackendDispatcher,
  BackendDispatcherApi,
  BackendDispatcherOptions
} from './transport/dispatcher'
export {
  base64ToBytes,
  bytesToBase64,
  DEFAULT_WIRE_DECODE_LIMITS,
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
  WireBackendSuccessResponse,
  WireDecodeLimits
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
export interface BackendClient extends BackendApi {
  listRemoteConnections(): Promise<readonly ConnectionSummary[]>
  createRemoteConnection(request: RemoteConnectionCreateRequest): Promise<ConnectionSummary>
  testRemoteConnection(request: RemoteConnectionCreateRequest): Promise<TestConnectionResult>
  updateRemoteConnection(connectionId: string, request: RemoteConnectionUpdateRequest): Promise<ConnectionSummary>
  connectRemoteConnection(connectionId: string): Promise<ConnectionSummary>
  disconnectRemoteConnection(connectionId: string): Promise<ConnectionSummary>
  removeRemoteConnection(connectionId: string): Promise<void>
  /** HTTP remote client 的低层调用入口，保留单次取消与超时选项。 */
  invoke?<K extends RemoteBackendMethod>(
    method: K,
    args: RemoteBackendArgs<K>,
    options?: BackendCallOptions
  ): Promise<RemoteBackendValue<K>>
}

export type BackendClientMode = 'desktop' | 'http'
export type BackendConnectionState = 'connected' | 'disconnected' | 'reconnecting' | 'unauthorized'

export interface BackendClientStatus {
  readonly mode: BackendClientMode
  readonly state: BackendConnectionState
  readonly lastError?: string
}

export interface HttpBackendSelectionOptions {
  readonly http: HttpBackendClientOptions
  /** 刷新认证头或等待网络恢复；返回值会替换下一次请求的 headers。 */
  readonly reconnect?: () => Promise<HttpHeaders | void>
}

export interface BackendClientSelection {
  readonly client: BackendClient
  readonly status: BackendClientStatus
  reconnect(): Promise<void>
}

interface ElectronWindow extends Window {
  dbstudio?: DbStudioApi
  __DBSTUDIO_BACKEND_CONFIG__?:
    | { readonly mode?: 'desktop' }
    | (HttpBackendSelectionOptions & { readonly mode: 'http' })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const RETRY_SAFE_METHODS: ReadonlySet<string> = new Set([
  'listDialects',
  'listConnections',
  'listChildren',
  'describeTable',
  'captureSchemaSnapshot',
  'compareTableData',
  'explain',
  'fetchResultPage',
  'closeCursor',
  'tableSelectSql',
  'countRows',
  'fetchCellValue',
  'transactionState',
  'listSqlLibrary'
])

function canRetry(method: string, error: unknown): boolean {
  return RETRY_SAFE_METHODS.has(method) &&
    error instanceof BackendError &&
    error.retryable &&
    (error.code === 'transport-failed' || error.code === 'timeout')
}

type RemoteRouteRequest = (
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: unknown
) => Promise<unknown>

function createConnectionControlMethods(request: RemoteRouteRequest): Pick<BackendClient,
  'listRemoteConnections' | 'createRemoteConnection' | 'testRemoteConnection' |
  'updateRemoteConnection' | 'connectRemoteConnection' | 'disconnectRemoteConnection' |
  'removeRemoteConnection'> {
  return {
    listRemoteConnections: async () => request('/connections', 'GET') as Promise<readonly ConnectionSummary[]>,
    createRemoteConnection: async (body) => request('/connections', 'POST', body) as Promise<ConnectionSummary>,
    testRemoteConnection: async (body) => request('/connections/test', 'POST', body) as Promise<TestConnectionResult>,
    updateRemoteConnection: async (connectionId, body) =>
      request(remoteConnectionPath(connectionId), 'PATCH', body) as Promise<ConnectionSummary>,
    connectRemoteConnection: async (connectionId) =>
      request(remoteConnectionPath(connectionId, 'connect'), 'POST') as Promise<ConnectionSummary>,
    disconnectRemoteConnection: async (connectionId) =>
      request(remoteConnectionPath(connectionId, 'disconnect'), 'POST') as Promise<ConnectionSummary>,
    removeRemoteConnection: async (connectionId) => {
      await request(remoteConnectionPath(connectionId), 'DELETE')
    }
  }
}

/** 创建可在 desktop IPC 与 HTTP 间切换的 renderer backend facade。 */
export function createBackendClientSelection(
  options: { readonly mode: 'desktop'; readonly api: DbStudioApi } | ({ readonly mode: 'http' } & HttpBackendSelectionOptions)
): BackendClientSelection {
  if (options.mode === 'desktop') {
    const status: BackendClientStatus = { mode: 'desktop', state: 'connected' }
    return { client: createElectronBackendClient(options.api), status, reconnect: async () => undefined }
  }

  let httpOptions = { ...options.http }
  let current = createHttpBackendClient(httpOptions)
  let state: BackendConnectionState = 'disconnected'
  let lastError: string | undefined
  const status = {
    get mode(): BackendClientMode { return 'http' },
    get state(): BackendConnectionState { return state },
    get lastError(): string | undefined { return lastError }
  } as BackendClientStatus

  const reconnect = async (): Promise<void> => {
    state = 'reconnecting'
    try {
      const headers = await options.reconnect?.()
      if (headers) httpOptions = { ...httpOptions, headers }
      current = createHttpBackendClient(httpOptions)
      state = 'connected'
      lastError = undefined
    } catch (error) {
      state = 'disconnected'
      lastError = errorMessage(error)
      throw error
    }
  }

  const invoke = async (
    method: string,
    args: readonly unknown[],
    callOptions?: BackendCallOptions
  ): Promise<unknown> => {
    try {
      const value = await current.invoke(method as never, args as never, callOptions)
      state = 'connected'
      return value
    } catch (error) {
      if (!canRetry(method, error) || !options.reconnect) {
        state = error instanceof BackendError && error.code === 'unauthorized' ? 'unauthorized' : 'disconnected'
        lastError = errorMessage(error)
        throw error
      }
      await reconnect()
      try {
        const value = await current.invoke(method as never, args as never, callOptions)
        state = 'connected'
        lastError = undefined
        return value
      } catch (retryError) {
        state = retryError instanceof BackendError && retryError.code === 'unauthorized'
          ? 'unauthorized'
          : 'disconnected'
        lastError = errorMessage(retryError)
        throw retryError
      }
    }
  }

  const invokeRoute: RemoteRouteRequest = async (path, method, body) => {
    try {
      const value = await current.requestJson(path, method, body)
      state = 'connected'
      lastError = undefined
      return value
    } catch (error) {
      state = error instanceof BackendError && error.code === 'unauthorized' ? 'unauthorized' : 'disconnected'
      lastError = errorMessage(error)
      throw error
    }
  }
  const connectionMethods = createConnectionControlMethods(invokeRoute)
  const connectionAliases: Record<string, unknown> = {
    listConnections: connectionMethods.listRemoteConnections,
    addConnection: connectionMethods.createRemoteConnection,
    testConnection: connectionMethods.testRemoteConnection,
    updateConnection: connectionMethods.updateRemoteConnection,
    connectConnection: connectionMethods.connectRemoteConnection,
    disconnectConnection: connectionMethods.disconnectRemoteConnection,
    removeConnection: connectionMethods.removeRemoteConnection
  }
  const target = Object.create(null) as Record<string, unknown>
  const client = new Proxy(target, {
    get(_target, property): unknown {
      if (property === 'invoke') return invoke
      if (typeof property !== 'string') return undefined
      if (property === 'status') return status
      if (property === 'reconnect') return reconnect
      if (property in connectionAliases) return connectionAliases[property]
      if (property in connectionMethods) return connectionMethods[property as keyof typeof connectionMethods]
      if (typeof current[property as keyof HttpBackendClient] !== 'function') return undefined
      return (...args: readonly unknown[]) => invoke(property, args)
    },
    has(_target, property): boolean {
      return property === 'invoke' || property === 'status' || property === 'reconnect' ||
        property in connectionAliases || property in connectionMethods ||
        (typeof property === 'string' && typeof current[property as keyof HttpBackendClient] === 'function')
    }
  }) as unknown as BackendClient
  return { client, status, reconnect }
}

/** Adapt the current Electron preload object to the renderer backend contract. */
export function createElectronBackendClient(api: DbStudioApi): BackendClient {
  // Desktop preload already exposes the stable connection method names. Keep the
  // original object untouched: contextBridge objects may be non-extensible.
  return api as BackendClient
}

let configuredSelection: BackendClientSelection | null = null

/** Resolve the backend selected by the current shell; desktop remains the default. */
export function resolveBackendClient(): BackendClient | null {
  const runtime = globalThis as unknown as ElectronWindow
  const config = runtime.__DBSTUDIO_BACKEND_CONFIG__
  if (config?.mode === 'http') {
    if (!configuredSelection) {
      const fetchImpl = globalThis.fetch?.bind(globalThis)
      if (!fetchImpl) return null
      configuredSelection = createBackendClientSelection({
        ...config,
        http: { ...config.http, fetch: config.http.fetch ?? fetchImpl }
      })
    }
    return configuredSelection.client
  }
  const api = runtime.dbstudio
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
