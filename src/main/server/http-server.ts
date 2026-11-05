/**
 * 可启动的 Node HTTP server 组合层。
 *
 * `http-server-handler` 负责单个请求的协议与资源边界；本文件只负责
 * listener 生命周期。认证仍由 handler 注入，composition 的 dispose 在
 * listener 关闭后执行，确保 owner scope 不会在仍有请求时提前释放。
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HttpServerComposition } from './http-server-composition'
import {
  createHttpArtifactRouter,
  type HttpArtifactRouter
} from './http-artifact-routes'
import {
  createHttpRequestLimiter,
  DEFAULT_HTTP_MAX_CONCURRENT_REQUESTS,
  createHttpServerHandler,
  type HttpServerHandler,
  type HttpServerHandlerOptions
} from './http-server-handler'

export interface HttpServerListenOptions {
  /** 监听地址；默认只绑定 loopback，避免无意暴露到公网。 */
  readonly host?: string
  /** 监听端口；0 允许测试环境请求操作系统分配临时端口。 */
  readonly port: number
  readonly backlog?: number
}

export const DEFAULT_HTTP_CLOSE_GRACE_MS = 5_000

export interface HttpServerOptions
  extends Omit<HttpServerHandlerOptions, 'composition'> {
  readonly composition: HttpServerComposition
  readonly listen: HttpServerListenOptions
  readonly maxArtifactMetadataBodyBytes?: number
  /** 优雅关闭等待中的请求的最长时间；超时强制关闭连接。 */
  readonly closeGraceMs?: number
}

export interface HttpServerAddress {
  readonly address: string
  readonly family: AddressInfo['family']
  readonly port: number
}

export interface HttpServer {
  readonly server: Server
  readonly handler: HttpServerHandler
  readonly address: HttpServerAddress | null
  listen(): Promise<HttpServerAddress>
  close(): Promise<void>
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} 必须是正整数`)
  }
  return resolved
}

function validateListenOptions(options: HttpServerListenOptions): void {
  if (!options || !Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('HTTP server port 必须是 0 到 65535 之间的整数')
  }
  if (options.host !== undefined && options.host.trim() === '') {
    throw new Error('HTTP server host 不能为空')
  }
  if (
    options.backlog !== undefined &&
    (!Number.isSafeInteger(options.backlog) || options.backlog < 1)
  ) {
    throw new Error('HTTP server backlog 必须是正整数')
  }
}

function toAddress(value: string | AddressInfo | null): HttpServerAddress {
  if (!value || typeof value === 'string') {
    throw new Error('HTTP server 未返回 TCP 监听地址')
  }
  return {
    address: value.address,
    family: value.family,
    port: value.port
  }
}

function closeNodeServer(server: Server, graceMs: number): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      server.closeAllConnections?.()
    }, graceMs)
    timer.unref?.()
    server.close((error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    })
  })
}

/** 创建一个可监听、可优雅关闭的 Node HTTP server。 */
export function createHttpServer(options: HttpServerOptions): HttpServer {
  if (!options?.composition || typeof options.composition.dispatch !== 'function') {
    throw new Error('HTTP server 缺少 composition')
  }
  validateListenOptions(options.listen)
  const closeGraceMs = positiveLimit(options.closeGraceMs, DEFAULT_HTTP_CLOSE_GRACE_MS, 'closeGraceMs')
  const maxConcurrentRequests = positiveLimit(
    options.maxConcurrentRequests,
    DEFAULT_HTTP_MAX_CONCURRENT_REQUESTS,
    'maxConcurrentRequests'
  )

  const requestLimiter = options.requestLimiter ?? createHttpRequestLimiter(maxConcurrentRequests)
  const handler = createHttpServerHandler({
    ...options,
    composition: options.composition,
    requestLimiter
  })
  const artifactRouter: HttpArtifactRouter = createHttpArtifactRouter({
    composition: options.composition,
    resolvePrincipal: options.resolvePrincipal,
    maxMetadataBodyBytes: options.maxArtifactMetadataBodyBytes,
    maxConcurrentRequests: options.maxConcurrentRequests,
    requestLimiter,
    governance: options.governance,
    auditSink: options.auditSink,
    metricsSink: options.metricsSink
  })
  const server = createServer((request, response) => {
    void (async () => {
      if (await artifactRouter(request, response)) return
      await handler(request, response)
    })().catch(() => {
      // handler 已经把可预期的错误转换成 envelope；这个兜底只处理
      // response 写入阶段的意外异常，避免把未处理 rejection 留在进程中。
      if (response.writableEnded || response.destroyed) return
      response.statusCode = 500
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(
        JSON.stringify({
          id: 'http-server',
          ok: false,
          error: { code: 'internal', message: 'HTTP backend handler failed' }
        })
      )
    })
  })

  let address: HttpServerAddress | null = null
  let listenPromise: Promise<HttpServerAddress> | undefined
  let closePromise: Promise<void> | undefined

  const runtime: HttpServer = {
    server,
    handler,
    get address(): HttpServerAddress | null {
      return address
    },
    listen(): Promise<HttpServerAddress> {
      if (closePromise) return Promise.reject(new Error('HTTP server 已关闭'))
      if (listenPromise) return listenPromise

      listenPromise = new Promise<HttpServerAddress>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener('listening', onListening)
          listenPromise = undefined
          reject(error)
        }
        const onListening = (): void => {
          server.removeListener('error', onError)
          try {
            address = toAddress(server.address())
            resolve(address)
          } catch (error) {
            reject(error)
          }
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen({
          host: options.listen.host ?? '127.0.0.1',
          port: options.listen.port,
          ...(options.listen.backlog === undefined ? {} : { backlog: options.listen.backlog })
        })
      })
      return listenPromise
    },
    close(): Promise<void> {
      if (closePromise) return closePromise
      closePromise = (async () => {
        let firstError: unknown
        try {
          if (listenPromise) await listenPromise.catch(() => undefined)
          await closeNodeServer(server, closeGraceMs)
        } catch (error) {
          firstError = error
        }
        try {
          await options.composition.dispose()
        } catch (error) {
          firstError ??= error
        }
        address = null
        if (firstError !== undefined) throw firstError
      })()
      return closePromise
    }
  }

  return runtime
}
