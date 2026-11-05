/** 可部署的 Node HTTP 入口。由 scripts/build-http-server.mjs 构建为 ESM。 */
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DriverHostHandle } from '../main/DriverHostHandle'
import { createConfiguredHttpServer } from '../main/server/http-server-runtime'
import { readHttpServerStartupConfig, createHttpServerPrincipalResolver, type HttpServerStartupEnv } from '../main/server/http-server-config'
import type { HttpServer } from '../main/server/http-server'
import { createStandaloneSecretCipher, readStandaloneDataDir } from './runtime-config'

export async function startStandaloneHttpServer(env: HttpServerStartupEnv = process.env): Promise<HttpServer> {
  const config = readHttpServerStartupConfig(env)
  if (!config) throw new Error('独立 HTTP 入口必须设置 DBSTUDIO_HTTP_PORT')
  // 认证与 cipher 验证先于创建数据目录，配置错误不会留下半启动 scope。
  const resolvePrincipal = createHttpServerPrincipalResolver(config)
  const cipher = createStandaloneSecretCipher(env)
  const hostScript = fileURLToPath(new URL('./driver-host/index.cjs', import.meta.url))
  if (!existsSync(hostScript)) throw new Error('缺少独立 driver host；请执行 node scripts/build-http-server.mjs')
  const baseDir = readStandaloneDataDir(env)
  const server = await createConfiguredHttpServer(env, {
    baseDir, cipher, resolvePrincipal,
    createDriverHost: (options) => new DriverHostHandle({ ...options, hostScript })
  })
  return server!
}

async function main(): Promise<void> {
  const server = await startStandaloneHttpServer()
  let closing: Promise<void> | undefined
  const close = (): void => {
    closing ??= server.close().then(() => {
      process.exitCode = 0
    }).catch(() => {
      console.error('[http-server] 关闭失败')
      process.exitCode = 1
    })
  }
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
  const address = server.address!
  console.log(`[http-server] listening ${address.address}:${address.port}`)
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  void main().catch(() => {
    // 不输出原异常：配置路径、密钥解析与网络错误均可能含部署私有信息。
    console.error('[http-server] 启动失败；请检查 HTTP 认证、数据目录、key 与构建配置')
    process.exitCode = 1
  })
}
