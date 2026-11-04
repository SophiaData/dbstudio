/**
 * 服务端 dispatcher：把 wire 请求交给后端实现。
 *
 * ===== 为什么是纯函数 / 不绑定框架 =====
 *
 * 这里不 import `node:http`、Express、Fastify 或任何服务器对象。它的输入是
 * 「已经解析成普通对象的 wire 请求」，输出是「带 request id 的
 * `BackendResponse` 信封」。任何宿主都可以这样接：
 *
 *   // Node http / Express
 *   const dispatch = createBackendDispatcher({ api })
 *   const response = await dispatch(JSON.parse(body))
 *
 * 或者直接用 `createJsonBackendDispatcher` 得到 `string → string` 的函数，
 * 连 JSON.parse / stringify 都不用自己写。
 *
 * ===== 能力面 =====
 *
 * 默认只允许 `BACKEND_METHOD_MANIFEST` 里的方法；HTTP server 可以注入独立的
 * remote manifest。方法名来自请求体，因此**必须**先查白名单再取 `api[method]`；
 * 否则一个任意字符串就能摸到对象的内部属性（原型链 / 构造器）。`methods`
 * 选项用于测试或按需收窄，但它只会**减少**能力面，不会扩大 manifest。
 *
 * ===== 失败 =====
 *
 * dispatcher 永不 reject：所有异常都被归一化成
 * `{ ok: false, error: BackendErrorPayload }`，并带上 method / callId。
 * 这样 HTTP 宿主可以稳定返回同一个信封，客户端也能按 `code` 决策，
 * 而不是依赖状态码或字符串匹配。
 */

import type {
  BackendApi,
  BackendMethod,
  RemoteBackendApi
} from '../contract/backend'
import type { BackendErrorPayload } from '../contract/errors'
import { toBackendErrorPayload } from '../contract/errors'
import {
  BACKEND_METHOD_MANIFEST,
  type BackendMethodManifestEntry
} from '../contract/method-manifest'
import type {
  BackendRequestContext,
  BackendResponse
} from './transport'
import {
  decodeBackendRequest,
  encodeBackendResponse,
  WireCodecError,
  type WireDecodeLimits
} from './wire-codec'

/** dispatcher 配置。 */
export type BackendDispatcherApi = BackendApi | RemoteBackendApi
export type BackendApiResolver = (
  context: BackendRequestContext
) => BackendDispatcherApi

export interface BackendDispatcherOptions {
  /** 静态后端实现，或按请求身份选择 owner scope 的解析器。 */
  readonly api: BackendDispatcherApi | BackendApiResolver
  /**
   * 能力面清单。缺省使用 desktop manifest；HTTP server 应显式传入
   * `REMOTE_BACKEND_METHOD_MANIFEST`，防止误暴露 shell/path capability。
   */
  readonly manifest?: readonly Pick<BackendMethodManifestEntry, 'method'>[]
  /**
   * 允许的方法名集合。缺省使用 manifest 中的全部方法。
   * 传入的集合只能继续收窄能力面，不能扩大 manifest。
   */
  readonly methods?: ReadonlySet<string> | readonly string[]
  /** 外部请求的 wire 解码资源上限。 */
  readonly decodeLimits?: WireDecodeLimits
}

/**
 * 一次分派：输入 wire 请求与可选 request context，输出带 id 的响应信封。
 *
 * context 未提供时由 dispatcher 创建一个没有 principal 的本地上下文，保持
 * 现有 `dispatch(request)` 调用兼容；需要认证和 owner isolation 的 server
 * 必须显式传入 context。
 */
export type BackendDispatcher = (
  request: unknown,
  context?: BackendRequestContext
) => Promise<BackendResponse>

/** 请求没有任何可用 id 时，响应仍要有一个可解码的占位 id。 */
const INVALID_REQUEST_ID = 'invalid-request'
function requestIdOf(request: unknown): string {
  if (
    typeof request === 'object' &&
    request !== null &&
    !Array.isArray(request) &&
    typeof (request as { id?: unknown }).id === 'string'
  ) {
    const id = (request as { id: string }).id
    return id.length > 0 ? id : INVALID_REQUEST_ID
  }
  return INVALID_REQUEST_ID
}

function invalidRequest(id: string, error: unknown): BackendResponse {
  const message =
    error instanceof WireCodecError
      ? error.message
      : error instanceof Error
        ? error.message
        : '请求格式不合法'
  return {
    id,
    ok: false,
    error: {
      code: 'invalid-argument',
      message
    }
  }
}

/**
 * 创建 dispatcher。
 *
 * 返回的闭包只读 `api` 与白名单；不持有跨请求状态，也不触碰全局对象。
 */
export function createBackendDispatcher(
  options: BackendDispatcherOptions
): BackendDispatcher {
  const manifest = options.manifest ?? BACKEND_METHOD_MANIFEST
  const requested =
    options.methods === undefined
      ? manifest.map((entry) => entry.method)
      : Array.from(options.methods)

  // 只允许 manifest 中的方法；`methods` 只能收窄，不能新增。
  const manifestMethods = new Set<string>(manifest.map((entry) => entry.method))
  const allowed = new Set<string>(
    requested.filter((method) => manifestMethods.has(method))
  )
  const resolveApi: BackendApiResolver =
    typeof options.api === 'function'
      ? (options.api as BackendApiResolver)
      : () => options.api as BackendDispatcherApi

  return async (
    request: unknown,
    suppliedContext?: BackendRequestContext
  ): Promise<BackendResponse> => {
    const fallbackId = requestIdOf(request)

    let decoded
    try {
      decoded = decodeBackendRequest(request, options.decodeLimits)
    } catch (error) {
      return invalidRequest(fallbackId, error)
    }

    const context: BackendRequestContext = suppliedContext ?? {
      requestId: decoded.id,
      signal: new AbortController().signal,
      receivedAt: Date.now()
    }
    const method = decoded.method
    if (!allowed.has(method)) {
      return {
        id: decoded.id,
        ok: false,
        error: {
          code: 'unsupported',
          message: `不支持的后端方法：${method}`,
          method: manifestMethods.has(method) ? (method as BackendMethod) : undefined
        }
      }
    }

    let api: BackendDispatcherApi
    try {
      api = resolveApi(context)
    } catch (error) {
      return {
        id: decoded.id,
        ok: false,
        error: toBackendErrorPayload(error, {
          method: method as BackendMethod,
          callId: decoded.id
        })
      }
    }

    const handler = (api as unknown as Record<string, unknown>)[method]
    if (typeof handler !== 'function') {
      return {
        id: decoded.id,
        ok: false,
        error: {
          code: 'internal',
          message: `后端方法 ${method} 未实现`,
          method: method as BackendMethod
        }
      }
    }

    try {
      const handlerArgs =
        method === 'runQuery'
          ? [...decoded.args, context.signal]
          : decoded.args
      const value = await (handler as (...args: unknown[]) => unknown).apply(
        api,
        handlerArgs as unknown[]
      )
      return {
        id: decoded.id,
        ok: true,
        value
      } as BackendResponse
    } catch (error) {
      return {
        id: decoded.id,
        ok: false,
        error: toBackendErrorPayload(error, {
          method: method as BackendMethod,
          callId: decoded.id
        })
      }
    }
  }
}

/**
 * 把 dispatcher 包成 `JSON string → JSON string`。
 *
 * HTTP 宿主通常只拿到请求体字符串；这个薄包装负责：
 *   - 请求体 JSON 语法错误 → `invalid-argument` 信封；
 *   - 响应统一走 `encodeBackendResponse`（含 Uint8Array 编码）。
 *
 * 它仍然只做数据变换，不认识 HTTP 状态码或请求头。
 */
export function createJsonBackendDispatcher(
  dispatch: BackendDispatcher
): (body: string, context?: BackendRequestContext) => Promise<string> {
  return async (
    body: string,
    context?: BackendRequestContext
  ): Promise<string> => {
    let request: unknown
    try {
      request = JSON.parse(body)
    } catch {
      const error: BackendErrorPayload = {
        code: 'invalid-argument',
        message: '请求体不是合法 JSON'
      }
      return JSON.stringify({ id: INVALID_REQUEST_ID, ok: false, error })
    }

    const response = await dispatch(request, context)
    return JSON.stringify(encodeBackendResponse(response))
  }
}
