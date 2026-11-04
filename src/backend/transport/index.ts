/**
 * Transport 层统一出口。
 *
 * 包含：
 *   - 调用 / 响应类型（`./transport`）；
 *   - 可逆 JSON wire 编解码（`./wire-codec`）；
 *   - 可注入 fetch 的 HTTP client（`./http-transport`）；
 *   - 框架无关的服务端 dispatcher（`./dispatcher`）。
 *
 * 这里的所有实现都必须保持环境无关：浏览器、Node、测试进程都能 import。
 */

export * from './transport'
export * from './wire-codec'
export * from './http-transport'
export * from './dispatcher'
