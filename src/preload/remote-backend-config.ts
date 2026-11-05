import type { HttpBackendClientOptions } from '../backend/transport/http-transport'

/** 启动环境只在 preload 读取；renderer 不获得 process 或环境变量读取能力。 */
export function readRendererRemoteBackendConfig(
  env: Readonly<Record<string, string | undefined>>
): { readonly mode: 'http'; readonly http: Pick<HttpBackendClientOptions, 'endpoint' | 'getHeaders'> } | null {
  const endpoint = env['DBSTUDIO_BACKEND_ENDPOINT']?.trim()
  const accessToken = env['DBSTUDIO_BACKEND_ACCESS_TOKEN']?.trim()
  if (!endpoint) {
    if (accessToken) throw new Error('远程客户端缺少 DBSTUDIO_BACKEND_ENDPOINT')
    return null
  }
  let url: URL
  try { url = new URL(endpoint) } catch { throw new Error('远程客户端 endpoint 必须是绝对 HTTP URL') }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('远程客户端 endpoint 必须使用 HTTPS；仅 loopback 允许 HTTP，URL 禁止凭据和 query')
  }
  if (!accessToken || /\s/.test(accessToken)) throw new Error('远程客户端缺少有效的 DBSTUDIO_BACKEND_ACCESS_TOKEN')
  return { mode: 'http', http: { endpoint: url.toString(), getHeaders: () => ({ authorization: `Bearer ${accessToken}` }) } }
}
