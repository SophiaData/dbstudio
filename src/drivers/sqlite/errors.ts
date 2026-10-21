/**
 * 适配器错误类型。
 *
 * 单独一个文件是为了**打断循环导入**：
 * `adapter.ts → results.ts`（用值转换/分页函数）、`results.ts → 错误类型`，
 * 若错误类还留在 adapter.ts 里，就变成 adapter ↔ results 互相依赖。
 * 循环导入在 ESM 下不一定报错，但初始化顺序会变成运气问题，不值得赌。
 */

import type { RpcErrorCode } from '../../core/driver'

/**
 * 带机器可判定 code 的适配器错误。
 *
 * `DriverAdapter` 接口约定抛错，但宿主进程要把错误翻译成 `RpcError`，
 * 而 `RpcErrorCode` 决定了 UI 是"提示用户""重试"还是"对象已失效"。
 * 只抛裸 Error 的话所有失败都会被归到 internal，UI 就没法区别处理了。
 */
export class SqliteAdapterError extends Error {
  readonly code: RpcErrorCode

  constructor(code: RpcErrorCode, message: string, cause?: unknown) {
    // cause 保留原始异常：message 给人看，cause 给排查用
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SqliteAdapterError'
    this.code = code
  }
}

/** 把任意 throw 出来的东西变成一句可读文本；绝不让 `[object Object]` 出现在用户面前。 */
export function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message
  if (typeof thrown === 'string') return thrown
  return String(thrown)
}
