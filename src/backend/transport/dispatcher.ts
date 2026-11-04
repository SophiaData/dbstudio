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
 * 默认只允许 `BACKEND_METHOD_MANIFEST` 里的方法。方法名来自请求体，
 * 因此**必须**先查白名单再取 `api[method]`；否则一个任意字符串就能摸到
 * 对象的内部属性（原型链 / 构造器）。`methods` 选项用于测试或按需收窄，
 * 但它只会**减少**能力面，不会扩大。
 *
 * ===== 失败 =====
 *
 * dispatcher 永不 reject：所有异常都被归一化成
 * `{ ok: false, error: BackendErrorPayload }`，并带上 method / callId。
 * 这样 HTTP 宿主可以稳定返回同一个信封，客户端也能按 `code` 决策，
 * 而不是依赖状态码或字符串匹配。
 */

import type { BackendApi, BackendMethod } from '../contract/backend'
import type { BackendErrorPayload } from '../contract/errors'
import { toBackendErrorPayload } from '../contract/errors'
import { BACKEND_METHOD_MANIFEST } from '../contract/method-manifest'
import type { BackendResponse } from './transport'
import {
  decodeBackendRequest,
  encodeBackendResponse,
  WireCodecError
} from './wire-codec'

/** dispatcher 配置。 */
export interface BackendDispatcherOptions {
  /** 真正的后端实现（主进程 application services / 测试替身）。 */
  readonly api: BackendApi
  /**
   * 允许的方法名集合。缺省用 `BACKEND_METHOD_MANIFEST`。
   *
   * 传入的集合不能扩大能力面：每个方法仍需在 manifest 中，否则视为配置错误。
   */
  readonly methods?: ReadonlySet<string> | readonly string[]
}

/**
 * 一次分派：输入未知 wire 请求，输出带 id 的响应信封。
 *
 * 返回 `BackendResponse` 而不是裸 `BackendEnvelope`，是为了让响应能直接
 * 走 `encodeBackendResponse` / `JSON.stringify`，并与请求 id 配对。
 */
export type BackendDispatcher = (request: unknown) => Promise<BackendResponse>

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
  const api = options.api
  const requested =
    options.methods === undefined
      ? BACKEND_METHOD_MANIFEST.map((entry) => entry.method)
      : Array.from(options.methods)

  // 只允许 manifest 中的方法；`methods` 只能收窄，不能新增。
  const manifestMethods = new Set<string>(
    BACKEND_METHOD_MANIFEST.map((entry) => entry.method)
  )
  const allowed = new Set<string>(
    requested.filter((method) => manifestMethods.has(method))
  )

  return async (request: unknown): Promise<BackendResponse> => {
    const fallbackId = requestIdOf(request)

    let decoded
    try {
      decoded = decodeBackendRequest(request)
    } catch (error) {
      return invalidRequest(fallbackId, error)
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
      const value = await (handler as (...args: unknown[]) => unknown).apply(
        api,
        decoded.args as unknown[]
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
): (body: string) => Promise<string> {
  return async (body: string): Promise<string> => {
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

    const response = await dispatch(request)
    return JSON.stringify(encodeBackendResponse(response))
  }
}
