/**
 * 后端调用的 wire 编解码层。
 *
 * ===== 为什么单独一层 =====
 *
 * transport 之间真正的共性是**请求 / 响应的数据形状**，而不是通道实现。
 * Electron IPC 可以直接结构化克隆，HTTP 只能传 JSON，Tauri 可能又是另一套。
 * 把「`BackendCall` / `BackendResponse` 如何变成可穿 JSON 的普通对象」收在这里，
 * 每种 transport 只负责搬运，不再各自发明编码规则。
 *
 * ===== 二进制怎么处理 =====
 *
 * 契约只承诺二进制以 `Uint8Array` 出现（见 `transport.ts`），没有规定线格式。
 * `JSON.stringify(new Uint8Array([1,2]))` 会变成 `{"0":1,"1":2}`，**不可逆**——
 * 解码时拿不回类型信息。所以这里用显式 tag：
 *
 *   Uint8Array → { "$dbstudio": "u8", "data": "<base64>" }
 *
 * 同样的 tag 也承载 `undefined` 与 `bigint`（JSON 自身丢失这两种值）。
 *
 * ===== 为什么 tag 要可转义 =====
 *
 * 业务值里完全可能出现一个恰好叫 `$dbstudio` 的对象（例如用户查询到的 JSON
 * 列）。如果解码只看 tag，就会把用户数据误当成二进制。因此编码时凡是带
 * `$dbstudio` 键的普通对象，都会额外包一层 `{ "$dbstudio": "object", data }`；
 * 解码时再逐字段还原。这样编码/解码对所有纯 JSON 值都是**可逆**的。
 *
 * 本文件必须保持环境无关：不 import electron / node 内置模块 / 驱动实现，
 * 也不使用 `Buffer`（浏览器里不存在）。base64 由本文件自己实现。
 */

import type { BackendMethod } from '../contract/backend'
import type { BackendErrorPayload } from '../contract/errors'
import { isBackendErrorPayload } from '../contract/errors'
import type { BackendCall, BackendResponse, BackendTransportValue } from './transport'

/** 线上 tag 键。转义规则见文件头。 */
const WIRE_TAG = '$dbstudio'

/** `parse*` 遇到非法 wire 数据时抛出。调用方通常应归一化成 `invalid-argument`。 */
export class WireCodecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WireCodecError'
  }
}

/** 可穿 JSON 的请求形状。`method` 保持字符串，由 dispatcher 做白名单校验。 */
export interface WireBackendRequest {
  readonly id: string
  readonly method: string
  readonly args: readonly unknown[]
}

/** 解码后的调用。`args` 已恢复成运行时值（含 Uint8Array）。 */
export interface DecodedBackendCall {
  readonly id: string
  readonly method: string
  readonly args: readonly unknown[]
}

/** 成功响应。`value` 是编码后的 wire 值。 */
export interface WireBackendSuccessResponse {
  readonly id: string
  readonly ok: true
  readonly value: unknown
}

/** 失败响应。错误载荷本身已保证是可克隆纯对象。 */
export interface WireBackendFailureResponse {
  readonly id: string
  readonly ok: false
  readonly error: BackendErrorPayload
}

/** 响应 union。 */
export type WireBackendResponse =
  | WireBackendSuccessResponse
  | WireBackendFailureResponse

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/**
 * 写入自有属性。
 *
 * 不能用 `record[key] = value`：当 key 是 `__proto__` 时会触发原型 setter，
 * 把数据写进原型链而不是对象本身（原型污染）。wire 数据来自外部，
 * 必须按普通自有属性处理，同时保持对象仍是普通 `Object.prototype` 对象。
 */
function assignOwn(
  record: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true
  })
}

// ---- base64（无 Buffer / 无 btoa 依赖） ----

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const BASE64_LOOKUP: ReadonlyMap<string, number> = new Map(
  Array.from(BASE64_ALPHABET, (char, index) => [char, index] as const)
)

/** 把字节编码成标准 base64（带 `=` 填充）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const hasSecond = index + 1 < bytes.length
    const hasThird = index + 2 < bytes.length
    const second = hasSecond ? bytes[index + 1] ?? 0 : 0
    const third = hasThird ? bytes[index + 2] ?? 0 : 0

    output += BASE64_ALPHABET.charAt(first >> 2)
    output += BASE64_ALPHABET.charAt(((first & 0b11) << 4) | (second >> 4))
    output += hasSecond
      ? BASE64_ALPHABET.charAt(((second & 0b1111) << 2) | (third >> 6))
      : '='
    output += hasThird ? BASE64_ALPHABET.charAt(third & 0b111111) : '='
  }
  return output
}

/**
 * 解码标准 base64。
 *
 * 只接受合法字符与最多两个尾部填充；其它输入一律抛 `WireCodecError`，
 * 避免把损坏的数据静默解释成「一段看起来像空字节的内容」。
 */
export function base64ToBytes(text: string): Uint8Array {
  const clean = text.trim()
  if (clean.length === 0) return new Uint8Array(0)
  if (clean.length % 4 !== 0) {
    throw new WireCodecError('base64 长度必须是 4 的倍数')
  }

  let padding = 0
  if (clean.endsWith('==')) padding = 2
  else if (clean.endsWith('=')) padding = 1

  for (let index = 0; index < clean.length - padding; index += 1) {
    if (!BASE64_LOOKUP.has(clean[index] ?? '')) {
      throw new WireCodecError(`base64 含非法字符：${clean[index] ?? ''}`)
    }
  }

  const output = new Uint8Array((clean.length / 4) * 3 - padding)
  let offset = 0
  for (let index = 0; index < clean.length; index += 4) {
    let accumulator = 0
    for (let lane = 0; lane < 4; lane += 1) {
      const char = clean[index + lane] ?? ''
      const value = char === '=' ? 0 : BASE64_LOOKUP.get(char)
      if (value === undefined) {
        throw new WireCodecError(`base64 含非法字符：${char}`)
      }
      accumulator = (accumulator << 6) | value
    }
    output[offset] = (accumulator >> 16) & 0xff
    offset += 1
    if (offset < output.length) {
      output[offset] = (accumulator >> 8) & 0xff
      offset += 1
    }
    if (offset < output.length) {
      output[offset] = accumulator & 0xff
      offset += 1
    }
  }
  return output
}

// ---- 值编解码 ----

/**
 * 把任意业务值编码成可穿 JSON 的形状。
 *
 * 规则：
 *   - `Uint8Array` → base64 tag；
 *   - `undefined` / `bigint` → 显式 tag（JSON 会丢前者、直接抛后者）；
 *   - 数组 / 普通对象递归；
 *   - 带 `$dbstudio` 键的对象整体转义，保证解码可逆；
 *   - 其它值原样返回，交给 `JSON.stringify`（string / number / boolean / null）。
 */
export function encodeWireValue(value: unknown): unknown {
  if (value === undefined) return { [WIRE_TAG]: 'undefined' }
  if (typeof value === 'bigint') {
    return { [WIRE_TAG]: 'bigint', data: value.toString() }
  }
  if (value instanceof Uint8Array) {
    return { [WIRE_TAG]: 'u8', data: bytesToBase64(value) }
  }
  if (Array.isArray(value)) {
    return value.map((item) => encodeWireValue(item))
  }
  if (isPlainObject(value)) {
    if (hasOwn(value, WIRE_TAG)) {
      const fields: Record<string, unknown> = {}
      for (const [key, nested] of Object.entries(value)) {
        assignOwn(fields, key, encodeWireValue(nested))
      }
      return { [WIRE_TAG]: 'object', data: fields }
    }
    const encoded: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      assignOwn(encoded, key, encodeWireValue(nested))
    }
    return encoded
  }
  return value
}

/** `encodeWireValue` 的逆操作。 */
export function decodeWireValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decodeWireValue(item))
  }
  if (!isPlainObject(value)) return value

  if (hasOwn(value, WIRE_TAG)) {
    const tag = value[WIRE_TAG]
    const keys = Object.keys(value)

    if (keys.length === 1 && tag === 'undefined') return undefined
    if (keys.length === 2 && tag === 'bigint' && typeof value['data'] === 'string') {
      return BigInt(value['data'])
    }
    if (keys.length === 2 && tag === 'u8') {
      if (typeof value['data'] !== 'string') {
        throw new WireCodecError('二进制 wire 值缺少字符串 data')
      }
      return base64ToBytes(value['data'])
    }
    if (keys.length === 2 && tag === 'object' && isPlainObject(value['data'])) {
      const restored: Record<string, unknown> = {}
      for (const [key, nested] of Object.entries(value['data'])) {
        assignOwn(restored, key, decodeWireValue(nested))
      }
      return restored
    }
    if (keys.length === 1) {
      throw new WireCodecError(`未知的 wire tag：${String(tag)}`)
    }
  }

  const decoded: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    assignOwn(decoded, key, decodeWireValue(nested))
  }
  return decoded
}

// ---- 请求 / 响应 ----

/** 把一次调用编码成 wire 请求。`options`（含 AbortSignal）不进入 wire。 */
export function encodeBackendRequest(call: BackendCall): WireBackendRequest {
  return {
    id: call.id,
    method: call.method,
    args: encodeWireValue(call.args) as readonly unknown[]
  }
}

/** 校验并解码 wire 请求。 */
export function decodeBackendRequest(payload: unknown): DecodedBackendCall {
  if (!isPlainObject(payload)) {
    throw new WireCodecError('请求必须是普通对象')
  }
  const { id, method, args } = payload
  if (typeof id !== 'string' || id.length === 0) {
    throw new WireCodecError('请求 id 必须是非空字符串')
  }
  if (typeof method !== 'string' || method.length === 0) {
    throw new WireCodecError('请求 method 必须是非空字符串')
  }
  if (!Array.isArray(args)) {
    throw new WireCodecError('请求 args 必须是数组')
  }
  return {
    id,
    method,
    args: decodeWireValue(args) as readonly unknown[]
  }
}

/** 把 transport 响应编码成 wire 响应。 */
export function encodeBackendResponse(response: BackendResponse): WireBackendResponse {
  if (response.ok) {
    return {
      id: response.id,
      ok: true,
      value: encodeWireValue(response.value)
    }
  }
  return {
    id: response.id,
    ok: false,
    error: encodeWireValue(response.error) as BackendErrorPayload
  }
}

/** 校验并解码 wire 响应。失败载荷会先做结构校验。 */
export function decodeBackendResponse(payload: unknown): BackendResponse {
  if (!isPlainObject(payload)) {
    throw new WireCodecError('响应必须是普通对象')
  }
  const { id, ok } = payload
  if (typeof id !== 'string' || id.length === 0) {
    throw new WireCodecError('响应 id 必须是非空字符串')
  }
  if (typeof ok !== 'boolean') {
    throw new WireCodecError('响应 ok 必须是布尔值')
  }

  if (ok) {
    if (!hasOwn(payload, 'value')) {
      throw new WireCodecError('成功响应缺少 value 字段')
    }
    return {
      id,
      ok: true,
      value: decodeWireValue(payload['value']) as BackendTransportValue<BackendMethod>
    }
  }

  const error = decodeWireValue(payload['error'])
  if (!isBackendErrorPayload(error)) {
    throw new WireCodecError('失败响应的 error 不是合法 BackendErrorPayload')
  }
  return { id, ok: false, error }
}

// ---- JSON 便捷函数 ----

/** `JSON.stringify(encodeBackendRequest(call))`。 */
export function stringifyBackendRequest(call: BackendCall): string {
  return JSON.stringify(encodeBackendRequest(call))
}

/** `decodeBackendRequest(JSON.parse(text))`；JSON 语法错误包成 `WireCodecError`。 */
export function parseBackendRequest(text: string): DecodedBackendCall {
  return decodeBackendRequest(parseJson(text, '请求'))
}

/** `JSON.stringify(encodeBackendResponse(response))`。 */
export function stringifyBackendResponse(response: BackendResponse): string {
  return JSON.stringify(encodeBackendResponse(response))
}

/** `decodeBackendResponse(JSON.parse(text))`；JSON 语法错误包成 `WireCodecError`。 */
export function parseBackendResponse(text: string): BackendResponse {
  return decodeBackendResponse(parseJson(text, '响应'))
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WireCodecError(`${label}不是合法 JSON：${reason}`)
  }
}
