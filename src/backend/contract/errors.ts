/**
 * 后端错误的可复用类型与纯函数。
 *
 * ===== 这一层负责什么 =====
 *
 * 定义**稳定的线上形状**：
 *
 *   - `BackendSuccessEnvelope` / `BackendFailureEnvelope`：transport 的统一信封；
 *   - `BackendErrorPayload`：可结构化克隆的错误载荷；
 *   - `toBackendErrorPayload()`：把任意异常（包括同步 throw、Promise reject、
 *     非 Error 值）归一化成 payload，保留原 `Error.message`，未知异常归为
 *     `internal`，已有合法 `BackendError` code 则保留；
 *   - `backendErrorFromPayload()`：在调用方把 payload 还原成 `BackendError`。
 *
 * 这样主进程与 preload 可以共用同一套判定，而不是各自靠字符串匹配 message。
 *
 * 本文件必须保持环境无关：不 import electron / node / 驱动实现。
 */

import type { BackendMethod } from './backend'

/**
 * 错误分类。
 *
 * 取值刻意偏「调用方可以据此决策」而不是「底层异常类名」：
 * 前者稳定、可跨 transport 复用，后者会随驱动/数据库实现漂移。
 */
export type BackendErrorCode =
  /** 当前环境根本没有可用的后端（例如浏览器里直接打开 renderer）。 */
  | 'backend-unavailable'
  /** transport 自身失败（IPC 断开、HTTP 不可达、连接被重置）。 */
  | 'transport-failed'
  /** 参数不合法；调用方修参数后可重试。 */
  | 'invalid-argument'
  /** 连接、表、游标等资源不存在。 */
  | 'not-found'
  /** 未认证或无权限。 */
  | 'unauthorized'
  /** 当前后端/驱动不支持该能力。 */
  | 'unsupported'
  /** 与当前状态冲突（例如未提交事务、并发修改）。 */
  | 'conflict'
  /** 调用方或后端主动取消。 */
  | 'cancelled'
  /** 超过调用方或 transport 设定的时限。 */
  | 'timeout'
  /** 未归类的内部错误；调用方通常只应记录与展示。 */
  | 'internal'

/**
 * 跨 transport 的错误载荷。
 *
 * 必须是可结构化克隆的纯对象：不能塞 `Error` 实例、函数或循环引用。
 * `details` 留给具体方法补充上下文（例如冲突行的主键），但不应包含凭据。
 */
export interface BackendErrorPayload {
  readonly code: BackendErrorCode
  readonly message: string
  /** 结构化补充信息，由具体方法定义；不得包含密码、token 等机密。 */
  readonly details?: unknown
  /** 调用方是否可以原样重试。缺省视为不可重试。 */
  readonly retryable?: boolean
  /** 出错的后端方法名，便于日志与 UI 定位。 */
  readonly method?: BackendMethod
  /** 对应的 transport 调用 id，用于把响应与请求关联起来。 */
  readonly callId?: string
}

/**
 * 成功的调用信封。
 *
 * Electron IPC 的 handler 不再把业务返回值直接交给 `ipcRenderer.invoke`，
 * 而是统一包一层。这样 preload 才能区分「后端成功返回了一个长得像错误的值」
 * 与「后端调用真的失败了」——单靠 reject 无法携带分类化的错误信息。
 *
 * 信封本身必须是可结构化克隆的纯对象：`value` 由具体方法保证。
 */
export interface BackendSuccessEnvelope<T = unknown> {
  readonly ok: true
  readonly value: T
}

/** 失败的调用信封。`error` 是已归一化、可跨进程克隆的错误载荷。 */
export interface BackendFailureEnvelope {
  readonly ok: false
  readonly error: BackendErrorPayload
}

/** transport 统一信封：用 `ok` 做可辨识联合。 */
export type BackendEnvelope<T = unknown> =
  | BackendSuccessEnvelope<T>
  | BackendFailureEnvelope

/**
 * 带分类信息的后端错误。
 *
 * `cause` 只放在构造参数里，不进入 payload：它通常不可序列化，
 * 也不应该跨进程暴露内部实现细节。
 */
export class BackendError extends Error {
  readonly code: BackendErrorCode
  readonly details?: unknown
  readonly retryable: boolean
  readonly method?: BackendMethod
  readonly callId?: string

  constructor(payload: BackendErrorPayload, options?: { readonly cause?: unknown }) {
    super(
      payload.message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    )
    this.name = 'BackendError'
    this.code = payload.code
    this.details = payload.details
    this.retryable = payload.retryable ?? false
    this.method = payload.method
    this.callId = payload.callId
  }

  /** 转成可跨 transport 传输的纯对象。 */
  toPayload(): BackendErrorPayload {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
      method: this.method,
      callId: this.callId
    }
  }
}

/**
 * 判断一个值是否是 `BackendError`。
 *
 * 现阶段只用 `instanceof`：跨进程后错误本来就退化成普通对象，
 * 那类场景应先用 `BackendErrorPayload` 反序列化，再交给业务逻辑判断
 * `code`。等真正需要跨 realm 识别时再补结构化判定，避免类型守卫说谎。
 */
export function isBackendError(value: unknown): value is BackendError {
  return value instanceof BackendError
}

const BACKEND_ERROR_CODES: ReadonlySet<BackendErrorCode> = new Set<BackendErrorCode>([
  'backend-unavailable',
  'transport-failed',
  'invalid-argument',
  'not-found',
  'unauthorized',
  'unsupported',
  'conflict',
  'cancelled',
  'timeout',
  'internal'
])

/** 判断字符串是否是合法的错误分类。 */
export function isBackendErrorCode(value: unknown): value is BackendErrorCode {
  return typeof value === 'string' && BACKEND_ERROR_CODES.has(value as BackendErrorCode)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 判断一个值是否是有效的错误载荷。
 *
 * 只认「合法 code + 字符串 message」：这是跨进程边界后唯一可靠的结构证据。
 * 不做 `instanceof` 检查，因为反序列化后的对象一定不是 `BackendError`。
 */
export function isBackendErrorPayload(value: unknown): value is BackendErrorPayload {
  if (!isPlainRecord(value)) return false
  return isBackendErrorCode(value.code) && typeof value.message === 'string'
}

/**
 * 判断一个值是否是 transport 信封。
 *
 * 成功信封要求存在 `value` 键（值本身允许是 `undefined`）；
 * 失败信封要求 `error` 是合法 payload。其它对象（包括旧版 handler 的
 * 原始返回值）一律不算信封，由调用方按 raw passthrough 处理。
 */
export function isBackendEnvelope(value: unknown): value is BackendEnvelope<unknown> {
  if (!isPlainRecord(value) || typeof value.ok !== 'boolean') return false
  return value.ok ? 'value' in value : isBackendErrorPayload(value.error)
}

/**
 * `isBackendEnvelope` 的短别名。
 *
 * transport 层内部用哪个名字都可以；保留长名字是为了和 `BackendErrorPayload`
 * 等类型保持同一套前缀，短名字则方便调用点书写。
 */
export function isEnvelope(value: unknown): value is BackendEnvelope<unknown> {
  return isBackendEnvelope(value)
}

/** details 中永远不允许出现的键：不可序列化或会暴露内部实现。 */
const FORBIDDEN_DETAIL_KEYS: ReadonlySet<string> = new Set(['stack', 'cause'])

/** details 中需要脱敏的键名；宁可少带信息，也不把凭据送过进程边界。 */
const SENSITIVE_DETAIL_KEY =
  /(?:password|passwd|pwd|secret|token|credential|api[_-]?key|authorization|cookie)/i

const MAX_DETAIL_DEPTH = 4
const MAX_DETAIL_ITEMS = 100

/** 驱动宿主 RPC 错误到跨 transport backend code 的兼容映射。 */
const RPC_ERROR_CODE_MAP: Readonly<Record<string, BackendErrorCode>> = {
  not_connected: 'backend-unavailable',
  already_connected: 'conflict',
  unsupported_method: 'unsupported',
  bad_params: 'invalid-argument',
  connection_failed: 'transport-failed',
  query_failed: 'internal',
  object_not_found: 'not-found',
  internal: 'internal'
}

function mapExternalErrorCode(value: unknown): BackendErrorCode | undefined {
  return typeof value === 'string' ? RPC_ERROR_CODE_MAP[value] : undefined
}

/**
 * 把 details 收敛成可结构化克隆的纯对象。
 *
 * 规则：
 *   - 只保留 primitives / 数组 / 普通对象；
 *   - 丢弃函数、symbol、`undefined` 与超深嵌套；
 *   - 丢弃 `stack` / `cause` 以及疑似凭据的键；
 *   - 数组与对象都做条数上限，避免一次错误把整棵大树送过 IPC。
 *
 * 不追求「完整保留」，优先保证：可克隆、无内部实现细节、无凭据。
 */
export function sanitizeBackendDetails(value: unknown, depth = 0): unknown {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return undefined
  }
  if (depth >= MAX_DETAIL_DEPTH) return undefined

  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const item of value.slice(0, MAX_DETAIL_ITEMS)) {
      const clean = sanitizeBackendDetails(item, depth + 1)
      if (clean !== undefined) items.push(clean)
    }
    return items
  }

  if (isPlainRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_DETAIL_KEYS.has(key) || SENSITIVE_DETAIL_KEY.test(key)) continue
      const clean = sanitizeBackendDetails(nested, depth + 1)
      if (clean !== undefined) result[key] = clean
    }
    return result
  }

  // Date / Map / Set / Error 等对象不保证跨 transport 的纯对象语义，直接丢弃。
  return undefined
}

/** `toBackendErrorPayload` 的调用上下文。 */
export interface BackendErrorPayloadOptions {
  /** 出错的方法名；错误对象自带 method 时优先用错误对象上的。 */
  readonly method?: BackendMethod
  /** 用于关联请求的调用 id；没有真实 request id 时可传通道名。 */
  readonly callId?: string
}

/**
 * 把任意异常归一化成可跨 transport 的错误载荷。
 *
 * 行为约定：
 *   - `BackendError` / 合法 payload：保留 `code`、`message`、`details`、
 *     `retryable`、`method`、`callId`；
 *   - 普通 `Error`：**保留原 message**，未知分类默认 `internal`；
 *     `AbortError` / `TimeoutError` 分别归为 `cancelled` / `timeout`；
 *   - 非 Error：字符串直接用；对象优先读 `message`，其次 `error`；
 *     仍读不到时给一条稳定的兜底文案；
 *   - 永远不把 `stack` / `cause` 放进 payload，`details` 会先脱敏。
 */
export function toBackendErrorPayload(
  error: unknown,
  options: BackendErrorPayloadOptions = {}
): BackendErrorPayload {
  let code: BackendErrorCode = 'internal'
  let message: string
  let retryable: boolean | undefined
  let details: unknown
  let method: BackendMethod | undefined = options.method
  let callId: string | undefined = options.callId

  if (error instanceof BackendError) {
    code = error.code
    message = error.message
    retryable = error.retryable
    details = error.details
    method = error.method ?? options.method
    callId = error.callId ?? options.callId
  } else if (isBackendErrorPayload(error)) {
    code = error.code
    message = error.message
    retryable = error.retryable
    details = error.details
    method = error.method ?? options.method
    callId = error.callId ?? options.callId
  } else {
    const record = isPlainRecord(error) ? error : undefined
    message =
      typeof error === 'string'
        ? error
        : record && typeof record.message === 'string'
          ? record.message
          : record && typeof record.error === 'string'
            ? record.error
            : typeof error === 'number' ||
                typeof error === 'boolean' ||
                typeof error === 'bigint'
              ? String(error)
              : error instanceof Error
                ? error.message
                : '后端调用失败：未知错误'

    const mappedRpcCode = mapExternalErrorCode(record?.code)
    if (record && isBackendErrorCode(record.code)) {
      code = record.code
    } else if (mappedRpcCode !== undefined) {
      code = mappedRpcCode
      details = { rpcCode: record?.code }
    } else if (error instanceof Error && error.name === 'AbortError') {
      code = 'cancelled'
    } else if (error instanceof Error && error.name === 'TimeoutError') {
      code = 'timeout'
    }

    if (record && typeof record.retryable === 'boolean') {
      retryable = record.retryable
    }
  }

  const payload: BackendErrorPayload = {
    code,
    message,
    ...(retryable === undefined ? {} : { retryable }),
    ...(method === undefined ? {} : { method }),
    ...(callId === undefined ? {} : { callId })
  }

  if (details !== undefined) {
    const clean = sanitizeBackendDetails(details)
    if (clean !== undefined) {
      return { ...payload, details: clean }
    }
  }
  return payload
}

/** 把跨进程收到的 payload 还原成 `BackendError`。 */
export function backendErrorFromPayload(payload: BackendErrorPayload): BackendError {
  return new BackendError(payload)
}
