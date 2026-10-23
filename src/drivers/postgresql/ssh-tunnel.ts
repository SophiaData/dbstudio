/**
 * SSH 隧道：让数据库连接穿过跳板机。
 *
 * ============================================================================
 * 为什么需要它（不是"高级功能"，而是连不上的硬门槛）
 * ============================================================================
 *
 * 大量自建数据库只监听内网地址（如 `10.0.1.5:5432`），从公网只能先 SSH 到跳板机。
 * 没有隧道时，这类库在本客户端里**完全不可达**——不是体验差，是根本用不了。
 *
 * ============================================================================
 * 关键设计决定：隧道归「驱动宿主进程」所有
 * ============================================================================
 *
 * 隧道有两种放法：主进程，或驱动宿主进程。这里选**宿主**，理由都是故障场景：
 *
 *   1. 宿主的生命周期已经与"这条数据库连接"绑定（一个连接一个宿主）。
 *      宿主退出 → 隧道随之关闭，不会留下孤儿 SSH 连接。
 *   2. 若把隧道放在主进程：宿主崩溃后主进程还握着一条 SSH 连接，
 *      用户看到的是"连接列表显示已断开，但跳板机上仍有一条活跃会话"。
 *      这种残留既占跳板机资源，也会让运维以为有人在用。
 *   3. 隧道里的流量只在宿主进程内，主进程依旧"一行数据库/网络代码都没有"，
 *      与项目既有的分层约束一致。
 *
 * ============================================================================
 * 为什么不能把 SSH channel 直接交给 pg（实测踩到的坑）
 * ============================================================================
 *
 * `pg` 内部把 `config.stream` 当作 `net.Socket` 使用，会调用：
 *   - `stream.setNoDelay(true)`
 *   - `stream.setKeepAlive(...)`
 *   - `stream.connect(port, host)`（并在 `connect` 事件后继续握手）
 *
 * 而 ssh2 的 Channel 是一个 Duplex，**没有**这几个方法。实测直接传会崩在
 * `this.stream.setNoDelay is not a function`。
 *
 * 所以这里做一层最小适配（`adaptChannelForPg`）：补三个方法 +
 * 手动补发一次 `connect` 事件（channel 建立时其实已经连上了，
 * 但 `pg` 的流程是"先 connect、收到事件再发 SSLRequest"）。
 *
 * ============================================================================
 * 安全边界
 * ============================================================================
 *
 * - **不在代码里提供 `rejectUnauthorized: false` 的逃生口**：那等于默认信任任意
 *   主机密钥，正好会被中间人攻击利用。未知主机必须由用户显式选择信任，
 *   且信任结果记在配置里（见 `hostKeySha256`），而不是每次静默放过。
 * - 私钥只从**文件路径**读取，不把私钥内容存进配置或数据库。
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'

import { Client } from 'ssh2'

/** SSH 配置（来自 `ConnectionConfig.options`，不含任何机密）。 */
export interface SshTunnelConfig {
  readonly host: string
  readonly port: number
  readonly username: string
  /** 私钥文件路径；与 `password` 二选一。 */
  readonly privateKeyPath: string | undefined
  /**
   * 用户已知并信任的主机公钥指纹（`SHA256:...`）。
   *
   * 为空表示"首次连接，尚未信任"。此时**拒绝连接**并返回指纹，
   * 由 UI 让用户确认后再写回配置——这就是 ssh 命令首次连接时
   * `Are you sure you want to continue connecting?` 的等价物。
   */
  readonly hostKeySha256: string | undefined
  /** 目标数据库在跳板机视角下的地址。 */
  readonly targetHost: string
  readonly targetPort: number
}

/** SSH 认证所需的机密。 */
export interface SshCredentials {
  readonly password: string | undefined
  readonly privateKeyPassphrase: string | undefined
}

/** 隧道建立失败的分类。UI 需要据此区分"该改配置"还是"该查明文"。 */
export type SshErrorCode =
  | 'ssh_auth_failed'
  | 'ssh_host_unverified'
  | 'ssh_connect_failed'
  | 'ssh_forward_failed'
  | 'ssh_missing_credentials'

export class SshTunnelError extends Error {
  readonly code: SshErrorCode
  /** `ssh_host_unverified` 时带上实际指纹，供 UI 展示给用户确认。 */
  readonly hostKeySha256?: string

  constructor(code: SshErrorCode, message: string, hostKeySha256?: string) {
    super(message)
    this.name = 'SshTunnelError'
    this.code = code
    if (hostKeySha256 !== undefined) this.hostKeySha256 = hostKeySha256
  }
}

/**
 * 计算主机公钥的 SHA256 指纹，格式与 `ssh-keygen -lf` 一致（`SHA256:base64`）。
 *
 * 为什么用这个格式而不是 hex：用户手里通常就是 `ssh-keygen -lf` 的输出，
 * 能直接肉眼比对，不必再换算一次。
 */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/** 一个已建立的隧道。调用方负责 `close()`。 */
export interface SshTunnel {
  /** 打开一条通往目标数据库的 TCP 通道（每次新建 pg 连接都要一条）。 */
  forward(): Promise<Duplex>
  close(): Promise<void>
}

/**
 * 把 ssh2 的 Channel 适配成 `pg` 期望的 socket 形状。
 *
 * 只在缺少方法时才补，避免覆盖掉 channel 自己已有的实现
 * （未来 ssh2 若补上这些方法，这里自动让位）。
 */
function adaptChannelForPg(channel: Duplex): Duplex {
  const stream = channel as Duplex & {
    setNoDelay?: (v?: boolean) => unknown
    setKeepAlive?: (v?: boolean, delay?: number) => unknown
    connect?: (...args: unknown[]) => unknown
  }
  if (typeof stream.setNoDelay !== 'function') {
    stream.setNoDelay = () => stream
  }
  if (typeof stream.setKeepAlive !== 'function') {
    stream.setKeepAlive = () => stream
  }
  if (typeof stream.connect !== 'function') {
    stream.connect = function connect(this: Duplex) {
      // channel 已经连上；pg 需要的是一个 connect 事件来继续协议握手。
      process.nextTick(() => this.emit('connect'))
      return this
    }
  }
  return stream
}

/**
 * 建立 SSH 隧道。
 *
 * 一次调用 = 一条 SSH 连接，可在同一会话内多次 `forward()` 开多条 channel
 * （例如 SSL 回退尝试、取消查询）。`close()` 之后该隧道不可再用；
 * 数据库重连需要重新建立隧道。
 */
export function openSshTunnel(config: SshTunnelConfig, credentials: SshCredentials): Promise<SshTunnel> {
  return new Promise<SshTunnel>((resolve, reject) => {
    if (config.privateKeyPath === undefined && credentials.password === undefined) {
      reject(
        new SshTunnelError(
          'ssh_missing_credentials',
          'SSH 认证信息缺失：请填写 SSH 口令，或指定私钥文件。'
        )
      )
      return
    }

    let privateKey: Buffer | undefined
    if (config.privateKeyPath !== undefined) {
      try {
        privateKey = readFileSync(config.privateKeyPath)
      } catch {
        reject(
          new SshTunnelError('ssh_missing_credentials', `无法读取 SSH 私钥文件：${config.privateKeyPath}`)
        )
        return
      }
    }

    const client = new Client()
    let settled = false
    /**
     * 主机密钥校验失败的原因。
     *
     * `hostVerifier` 只能返回 boolean，没法带出原因；而 ssh2 在它返回 false 时
     * 抛的是通用的 "Host verification failed"。所以先在闭包里记下具体原因，
     * 等 error 事件里换成有信息量的错误。
     */
    let pendingHostKeyError: SshTunnelError | undefined

    const fail = (error: SshTunnelError): void => {
      if (settled) return
      settled = true
      client.end()
      reject(error)
    }

    /**
     * 主机密钥校验。
     *
     * 这里**不做 TOFU（首次信任即永久信任）**，而是把决定权交给用户：
     * 首次连接返回一个明确的 `ssh_host_unverified` 错误并附上指纹，
     * UI 展示指纹 → 用户确认 → 写回配置 → 重连。
     *
     * 为什么不用 TOFU：本客户端会保存连接供以后自动连接，静默信任一个
     * 没见过的主机，等于把"首次连接被中间人劫持"的窗口永久化。
     */
    client.on('ready', () => {
      const forward = (): Promise<Duplex> =>
        new Promise<Duplex>((res, rej) => {
          client.forwardOut('127.0.0.1', 0, config.targetHost, config.targetPort, (err, channel) => {
            if (err) {
              rej(new SshTunnelError('ssh_forward_failed', `SSH 转发到 ${config.targetHost}:${config.targetPort} 失败：${err.message}`))
              return
            }
            res(adaptChannelForPg(channel))
          })
        })

      if (settled) return
      settled = true
      resolve({
        forward,
        close: () =>
          new Promise<void>((res) => {
            client.end()
            // ssh2 的 end() 没有回调；等 close 事件，超时兜底避免挂死。
            const timer = setTimeout(res, 2000)
            client.once('close', () => {
              clearTimeout(timer)
              res()
            })
          })
      })
    })

    client.on('error', (err: Error & { level?: string }) => {
      // 主机密钥问题优先（比 ssh2 的通用措辞更有信息量）。
      if (pendingHostKeyError !== undefined) {
        fail(pendingHostKeyError)
        return
      }
      const message = err.message
      if (message.includes('authentication') || err.level === 'client-authentication') {
        fail(new SshTunnelError('ssh_auth_failed', `SSH 认证失败：${message}`))
        return
      }
      fail(new SshTunnelError('ssh_connect_failed', `SSH 连接失败：${message}`))
    })

    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      ...(privateKey === undefined ? {} : { privateKey }),
      ...(credentials.password === undefined ? {} : { password: credentials.password }),
      ...(credentials.privateKeyPassphrase === undefined
        ? {}
        : { passphrase: credentials.privateKeyPassphrase }),
      readyTimeout: 15_000,
      /** hostVerifier 拿到的是原始公钥 Buffer，校验规则见上面的 pendingHostKeyError。 */
      hostVerifier: (key: Buffer) => {
        const fingerprint = hostKeyFingerprint(key)
        if (config.hostKeySha256 === undefined) {
          pendingHostKeyError = new SshTunnelError(
            'ssh_host_unverified',
            `首次连接该 SSH 主机，需要确认主机密钥指纹：${fingerprint}`,
            fingerprint
          )
          return false
        }
        if (config.hostKeySha256 !== fingerprint) {
          pendingHostKeyError = new SshTunnelError(
            'ssh_host_unverified',
            `SSH 主机密钥与已保存的不一致（可能是中间人攻击，或跳板机重装过）。` +
              `期望 ${config.hostKeySha256}，实际 ${fingerprint}`,
            fingerprint
          )
          return false
        }
        return true
      }
    })
  })
}
