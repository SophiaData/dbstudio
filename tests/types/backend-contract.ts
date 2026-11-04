/**
 * 后端契约的**编译期**使用检查。
 *
 * ===== 为什么需要这个文件 =====
 *
 * `contract/` 与 `transport/` 里大量是纯类型：如果只在运行时测
 * `resolveBackendClient()`，类型一旦飘移（方法名改了、参数元组错了、
 * 错误码写错）测试仍然全绿，直到 renderer 某处编译失败才发现。
 *
 * 这个文件不做任何运行时断言，只由 `tsc --noEmit` 检查。它同时覆盖三件事：
 *   1. `BackendApi` 与既有 `DbStudioApi` **双向兼容**（不能改变方法签名）；
 *   2. `BackendMethod` / `BackendArgs` / `BackendValue` 的派生结果正确；
 *   3. transport / error 类型可以从 `backend-client.ts` 统一导入。
 */

import {
  BackendError,
  backendErrorFromPayload,
  isBackendEnvelope,
  isBackendError,
  isEnvelope,
  sanitizeBackendDetails,
  toBackendErrorPayload
} from '../../src/backend/backend-client'
import { BACKEND_METHOD_MANIFEST } from '../../src/backend/contract/method-manifest'
import type {
  BackendApi,
  BackendArgs,
  BackendBinaryPayload,
  BackendCall,
  BackendCallOptions,
  BackendEnvelope,
  BackendErrorCode,
  BackendErrorPayload,
  BackendFailureEnvelope,
  BackendMethod,
  BackendResponse,
  BackendSuccessEnvelope,
  BackendValue,
  TransportChannel
} from '../../src/backend/backend-client'
import { IPC, type ConnectionSummary, type DbStudioApi } from '../../src/core/api'

type Assert<T extends true> = T
type IsAssignable<From, To> = From extends To ? true : false

// ---- 1. BackendApi 必须与既有 DbStudioApi 双向可赋值（零签名变化） ----

type _DbStudioApiIsBackendApi = Assert<IsAssignable<DbStudioApi, BackendApi>>
type _BackendApiIsDbStudioApi = Assert<IsAssignable<BackendApi, DbStudioApi>>
type _MethodIsKeyofApi = Assert<IsAssignable<BackendMethod, keyof DbStudioApi>>
type _KeyofApiIsMethod = Assert<IsAssignable<keyof DbStudioApi, BackendMethod>>

// ---- 2. 方法派生类型 ----

const listDialectsMethod: BackendMethod = 'listDialects'

const runQueryArgs: BackendArgs<'runQuery'> = ['connection:c1', 'select 1']
const runQueryArgsWithOptions: BackendArgs<'runQuery'> = [
  'connection:c1',
  'select 1',
  { limit: 100 }
]

const connections: BackendValue<'listConnections'> = []
const connectionCount: number = connections.length
const summary: ConnectionSummary | undefined = connections[0]

// @ts-expect-error 不存在的后端方法必须被拒绝
const invalidMethod: BackendMethod = 'dropDatabase'

// @ts-expect-error runQuery 的第一个参数必须是连接/节点 id 字符串
const invalidArgs: BackendArgs<'runQuery'> = [1, 'select 1']

// @ts-expect-error listConnections 解析后是数组，不是字符串
const invalidValue: BackendValue<'listConnections'> = 'not-a-list'

// ---- 3. transport 调用与响应 ----

const channel: TransportChannel = 'electron'
const callOptions: BackendCallOptions = { channel, timeoutMs: 5_000 }

const call: BackendCall<'listConnections'> = {
  id: 'call-1',
  method: 'listConnections',
  args: [],
  options: callOptions
}

const success: BackendResponse<'listConnections'> = {
  id: 'call-1',
  ok: true,
  value: []
}

const failure: BackendResponse = {
  id: 'call-2',
  ok: false,
  error: {
    code: 'transport-failed',
    message: 'IPC channel closed',
    retryable: true,
    method: 'listConnections',
    callId: 'call-2'
  }
}

// Uint8Array 只作为类型边界存在；本层不实现任何 HTTP 编码。
const binary: BackendBinaryPayload = new Uint8Array([0, 1, 2])

// ---- 4. 错误类型 ----

const payload: BackendErrorPayload = {
  code: 'invalid-argument',
  message: 'nodeId 不能为空',
  retryable: false,
  method: 'listChildren',
  callId: 'call-3'
}

const error = new BackendError(payload, { cause: new Error('root cause') })
const errorCode: BackendErrorCode = error.code
const errorPayload: BackendErrorPayload = error.toPayload()
const narrowedCode: BackendErrorCode = isBackendError(error) ? error.code : 'internal'

// transport 信封与错误归一化 helper 的类型出口。
const successEnvelope: BackendSuccessEnvelope<number> = { ok: true, value: 1 }
const failureEnvelope: BackendFailureEnvelope = { ok: false, error: payload }
const envelope: BackendEnvelope<number> = successEnvelope
const normalized: BackendErrorPayload = toBackendErrorPayload(error, {
  method: 'listChildren',
  callId: 'call-4'
})
const restored: BackendError = backendErrorFromPayload(normalized)
const detected: boolean = isBackendEnvelope(failureEnvelope) && isEnvelope(envelope)
const sanitized: unknown = sanitizeBackendDetails({ table: 'users', password: 'x' })

// ---- 5. 可执行 method manifest 的编译期覆盖 ----

type ManifestMethod = (typeof BACKEND_METHOD_MANIFEST)[number]['method']
type ManifestChannel = (typeof BACKEND_METHOD_MANIFEST)[number]['channel']

// 清单必须覆盖每个后端方法，且不能出现契约之外的方法名。
type _ManifestCoversAllMethods = Assert<IsAssignable<BackendMethod, ManifestMethod>>
type _ManifestHasOnlyKnownMethods = Assert<IsAssignable<ManifestMethod, BackendMethod>>

// 每个 channel 都必须是 core/api.ts 声明的通道值。
type _ManifestChannelsAreIpcValues = Assert<
  IsAssignable<ManifestChannel, (typeof IPC)[keyof typeof IPC]>
>

const manifestMethodCount: number = BACKEND_METHOD_MANIFEST.length

// 引用一次，避免未来开启 noUnusedLocals 时无声失效。
export const typeCheckUsages = {
  listDialectsMethod,
  runQueryArgs,
  runQueryArgsWithOptions,
  connectionCount,
  summary,
  invalidMethod,
  invalidArgs,
  invalidValue,
  call,
  success,
  failure,
  binary,
  errorCode,
  errorPayload,
  narrowedCode,
  manifestMethodCount
} as const
