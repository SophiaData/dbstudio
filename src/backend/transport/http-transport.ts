/**
 * HTTP backend transport client。
 *
 * ===== 边界 =====
 *
 * 本文件是远程 backend capability 在 HTTP 上的实现：把每次方法调用编码成
 * `POST <endpoint>` 的 JSON 请求，再把响应信封还原成业务值或 `BackendError`。
 * 它**不依赖 fetch 的具体来源**——调用方注入一个满足 `HttpFetch` 的函数即可：
 *
 *   - 浏览器：直接传 `globalThis.fetch`；
 *   - Node 18+：同样可以直接传 `globalThis.fetch`；
 *   - 测试 / 自定义环境：传一个假 fetch，或包一层带认证头的 fetch。
 *
 * 因此本文件不能 import `node:*`、electron 或任何驱动实现，保证浏览器与
 * Node 都能参与类型检查与打包。
 *
 * ===== 路由 =====
 *
 * 可调用的方法名**只来自 `BACKEND_METHOD_MANIFEST`**。客户端不会把任意属性
 * 转发出去：`client.someRandomMethod` 是 `undefined`，真正调用前还会再查一次
 * 白名单。这与 Electron IPC 侧「按静态清单逐个注册」是同一份能力面。
 *
 * ===== 取消与超时 =====
 *
 * 每次调用都创建一个内部 `AbortController`：
 *   - 调用方传入的 `AbortSignal` 被桥接到它（不改变原 signal）；
 *   - `timeoutMs` 到期时 abort，并归类为 `timeout`；
 *   - 调用方主动 abort 归类为 `cancelled`；
 *   - 网络 / 解析失败归类为 `transport-failed`。
 *
 * 标准 `BackendApi` 方法签名没有 options 参数，所以超时/取消通过两种方式提供：
 *   1. 客户端级默认值：`createHttpBackendClient({ timeoutMs })`；
 *   2. 单次调用：`client.invoke(method, args, { signal, timeoutMs })`。
 *
 * 这不改变 `BackendApi` 的任何方法签名，renderer 代码仍可把本客户端当
 * `BackendClient` 使用；需要取消的调用方（例如取消按钮）显式走 `invoke`。
 */

import type {
  BackendMethod,
  RemoteBackendApi,
  RemoteBackendArgs,
  RemoteBackendMethod,
  RemoteBackendValue
} from '../contract/backend'
import type { BackendErrorPayload } from '../contract/errors'
import {
  BackendError,
  backendErrorFromPayload,
  isBackendErrorPayload
} from '../contract/errors'
import { REMOTE_BACKEND_METHOD_MANIFEST } from '../contract/method-manifest'
import type { BackendCallOptions, BackendResponse } from './transport'
import {
  decodeBackendResponse,
  encodeBackendRequest,
  WireCodecError
} from './wire-codec'

/** 请求头形状：只允许字符串值，避免把 Headers 实例泄漏进契约。 */
export type HttpHeaders = Readonly<Record<string, string>>

/**
 * 最小 fetch 请求形状。
 *
 * 刻意不用 DOM 的 `RequestInit`：那会把 transport 绑在浏览器类型上；
 * 这里只声明真正会用到的字段，Node 的 `fetch` 与浏览器 `fetch` 都结构兼容。
 */
export interface HttpRequestInit {
  readonly method: string
  readonly headers: HttpHeaders
  readonly body: string
  readonly signal?: AbortSignal
}

/** 最小 fetch 响应形状。`Response` 结构兼容它。 */
export interface HttpResponseLike {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

/** 可注入的 fetch。浏览器 / Node 的全局 fetch 可直接传入。 */
export type HttpFetch = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>

/** HTTP transport 配置。 */
export interface HttpBackendClientOptions {
  /** 完整 endpoint，例如 `https://dbstudio.local/rpc`。必须是绝对 URL 由调用方负责。 */
  readonly endpoint: string
  /** 注入的 fetch 实现。 */
  readonly fetch: HttpFetch
  /** 额外请求头（认证等），不会覆盖 content-type / request id。 */
  readonly headers?: HttpHeaders
  /** 默认超时毫秒数；`0` 或非有限值表示不设超时。缺省 30s。 */
  readonly timeoutMs?: number
  /** 请求 id 生成器；并发调用必须唯一。缺省用 crypto.randomUUID 或回退实现。 */
  readonly requestId?: () => string
}

/** 默认超时。查询类调用可通过 `invoke` 的 `timeoutMs` 覆盖。 */
// 高于 driver host 的 60s 结果集上限，让服务端先决定超时并终止宿主，
// 避免客户端先放弃后把同一条非幂等请求误认为可重试。
export const DEFAULT_HTTP_TIMEOUT_MS = 75_000

/**
 * 在 `BackendApi` 之上增加一个低层入口，用于单次调用的取消/超时。
 *
 * `invoke` 不进入 manifest 能力面，它只是同一套方法路由的另一种调用方式；
 * 服务器仍然只接受 manifest 里的方法名。
 */
export interface HttpBackendClient extends RemoteBackendApi {
  invoke<K extends RemoteBackendMethod>(
    method: K,
    args: RemoteBackendArgs<K>,
    options?: BackendCallOptions
  ): Promise<RemoteBackendValue<K>>
}

/** 请求 id 的全局回退序号。只用于没有 `crypto.randomUUID` 的环境。 */
let fallbackRequestSequence = 0

interface CryptoLike {
  readonly randomUUID?: () => string
}

/**
 * 生成请求 id。
 *
 * 优先 `crypto.randomUUID()`（浏览器与 Node 18+ 都有）；否则用时间戳 +
 * 进程内序号 + 随机串。后者不保证密码学强度，只保证同一客户端内几乎不碰撞，
 * 足以把响应和请求配对。
 */
export function createRequestId(): string {
  const cryptoApi = (globalThis as { readonly crypto?: CryptoLike }).crypto
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  fallbackRequestSequence += 1
  const random = Math.random().toString(36).slice(2, 10)
  return `http-${Date.now().toString(36)}-${fallbackRequestSequence.toString(36)}-${random}`
}

interface AbortScope {
  readonly signal: AbortSignal
  readonly didTimeOut: () => boolean
  readonly cleanup: () => void
}

function createAbortScope(
  external: AbortSignal | undefined,
  timeoutMs: number
): AbortScope {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const onExternalAbort = (): void => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup: () => {
      if (timer !== null) clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function makeError(
  code: BackendErrorPayload['code'],
  message: string,
  options: {
    readonly method?: BackendMethod
    readonly callId: string
    readonly retryable?: boolean
    readonly details?: unknown
  }
): BackendError {
  return new BackendError({
    code,
    message,
    retryable: options.retryable,
    method: options.method,
    callId: options.callId,
    details: options.details
  })
}

/**
 * 创建 HTTP backend client。
 *
 * 返回对象只暴露远程 manifest 中的方法；本机文件选择器等 shell 能力
 * 读取结果为 `undefined`，调用时也会被拒绝。
 */
export function createHttpBackendClient(
  options: HttpBackendClientOptions
): HttpBackendClient {
  if (typeof options?.endpoint !== 'string' || options.endpoint.length === 0) {
    throw makeError('invalid-argument', 'HTTP transport 缺少 endpoint', {
      callId: 'createHttpBackendClient'
    })
  }
  if (typeof options.fetch !== 'function') {
    throw makeError('invalid-argument', 'HTTP transport 缺少 fetch 实现', {
      callId: 'createHttpBackendClient'
    })
  }

  const endpoint = options.endpoint
  const fetchImpl = options.fetch
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const nextRequestId = options.requestId ?? createRequestId
  const methodNames = new Set<string>(
    REMOTE_BACKEND_METHOD_MANIFEST.map((entry) => entry.method)
  )
  const methodCache = new Map<string, (...args: unknown[]) => Promise<unknown>>()

  async function invoke<K extends RemoteBackendMethod>(
    method: K,
    args: RemoteBackendArgs<K>,
    callOptions?: BackendCallOptions
  ): Promise<RemoteBackendValue<K>> {
    if (!methodNames.has(method)) {
      throw makeError('unsupported', `HTTP transport 不支持后端方法：${String(method)}`, {
        method,
        callId: nextRequestId()
      })
    }

    const callId = nextRequestId()
    if (callOptions?.signal?.aborted === true) {
      throw makeError('cancelled', '后端调用已取消', {
        method,
        callId,
        retryable: false
      })
    }

    const timeoutMs = callOptions?.timeoutMs ?? defaultTimeoutMs
    const scope = createAbortScope(callOptions?.signal, timeoutMs)

    const transportFailure = (error: unknown): BackendError => {
      if (scope.didTimeOut()) {
        return makeError('timeout', `后端调用超时（${timeoutMs}ms）`, {
          method,
          callId,
          retryable: true,
          details: { timeoutMs }
        })
      }
      if (callOptions?.signal?.aborted === true) {
        return makeError('cancelled', '后端调用已取消', {
          method,
          callId,
          retryable: false
        })
      }
      if (error instanceof BackendError) return error
      return makeError('transport-failed', errorMessage(error), {
        method,
        callId,
        retryable: true
      })
    }

    try {
      const body = JSON.stringify(
        encodeBackendRequest({
          id: callId,
          method,
          args
        })
      )

      let response: HttpResponseLike
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            ...options.headers,
            // 顺序刻意放在用户头之后：这些是 wire 契约的一部分，不允许被覆盖。
            'content-type': 'application/json',
            accept: 'application/json',
            'x-dbstudio-request-id': callId
          },
          body,
          signal: scope.signal
        })
      } catch (error) {
        throw transportFailure(error)
      }

      let text: string
      try {
        text = await response.text()
      } catch (error) {
        throw transportFailure(error)
      }

      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch (error) {
        throw makeError(
          'transport-failed',
          `HTTP 响应不是合法 JSON（status ${response.status}）`,
          {
            method,
            callId,
            retryable: true,
            details: { status: response.status, reason: errorMessage(error) }
          }
        )
      }

      let decoded: BackendResponse
      try {
        decoded = decodeBackendResponse(payload)
      } catch (error) {
        const reason =
          error instanceof WireCodecError ? error.message : errorMessage(error)
        throw makeError('transport-failed', `HTTP 响应不符合后端契约：${reason}`, {
          method,
          callId,
          retryable: false,
          details: { status: response.status }
        })
      }

      if (decoded.id !== callId) {
        throw makeError('transport-failed', '后端响应 id 与请求不匹配', {
          method,
          callId,
          retryable: false,
          details: { expected: callId, actual: decoded.id }
        })
      }

      if (!decoded.ok) {
        // 服务端已经给出分类化错误；原样还原，不降级成 transport-failed。
        // 若服务端漏填 method / callId，用本次请求补上，保证日志与 UI 能定位。
        throw backendErrorFromPayload({
          ...decoded.error,
          method: decoded.error.method ?? method,
          callId: decoded.error.callId ?? callId
        })
      }

      if (!response.ok) {
        throw makeError(
          'transport-failed',
          `HTTP ${response.status}：服务端返回了成功信封但状态码非 2xx`,
          {
            method,
            callId,
            retryable: false,
            details: { status: response.status }
          }
        )
      }

      return decoded.value as RemoteBackendValue<K>
    } finally {
      scope.cleanup()
    }
  }

  function methodFunction(name: string): (...args: unknown[]) => Promise<unknown> {
    const cached = methodCache.get(name)
    if (cached) return cached
    const handler = (...args: unknown[]): Promise<unknown> =>
      invoke(name as RemoteBackendMethod, args as never, undefined)
    methodCache.set(name, handler)
    return handler
  }

  // 用 Proxy 而不是手写 48 个转发函数：能力面完全由 manifest 决定，
  // 新增契约方法时这里不需要同步修改，也不会漏掉某个方法。
  const target: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const client = new Proxy(target, {
    get(current, property, receiver): unknown {
      if (typeof property !== 'string') return Reflect.get(current, property, receiver)
      if (property === 'invoke') return invoke
      if (!methodNames.has(property)) return undefined
      return methodFunction(property)
    },
    has(current, property): boolean {
      if (typeof property !== 'string') return Reflect.has(current, property)
      return property === 'invoke' || methodNames.has(property)
    }
  })

  return client as unknown as HttpBackendClient
}

/** 判断一个值是否是合法的 `BackendErrorPayload`（重导出便于 adapter 复用）。 */
export function isHttpErrorPayload(value: unknown): value is BackendErrorPayload {
  return isBackendErrorPayload(value)
}
