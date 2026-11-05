/**
 * 远程连接 DTO 与出站目标策略。
 *
 * 远程 API 只接受连接参数值，不接受 server-local 文件系统语义。凭据继续
 * 走独立的 secret 通道；本模块不定义或保存任何 secret。
 */

import type { ConnectionConfig } from '../../core/dialect'

export type RemoteOptionValue = string | number | boolean

/** 不能通过远程连接配置把 server 的路径交给驱动或文件 API。 */
export type RemotePathOption =
  | 'path'
  | 'file'
  | 'filename'
  | 'sourcePath'
  | 'destinationPath'
  | 'directory'
  | 'directoryPath'
  | 'cwd'
  | 'workingDirectory'
  | 'socketPath'
  | 'sslrootcert'
  | 'sshPrivateKey'
  | 'caFile'
  | 'certFile'
  | 'keyFile'
  | 'credentialsFile'
  | 'configFile'

/** 编译期拒绝常见 server-local 路径字段；运行时仍必须调用 validateRemoteConnectionConfig。 */
export type RemoteConnectionOptions = Readonly<
  Record<string, RemoteOptionValue> & Partial<Record<RemotePathOption, never>>
>

export type RemoteConnectionConfig = Omit<ConnectionConfig, 'options'> & {
  readonly options: RemoteConnectionOptions
}

export interface RemoteOutboundTarget {
  readonly host: string
  readonly port: number
}

/** 最小可验证策略：主机和端口都必须精确命中显式 allowlist。 */
export interface RemoteOutboundPolicy {
  readonly allowedHosts: readonly string[]
  readonly allowedPorts: readonly number[]
}

export interface RemoteValidationIssue {
  readonly field: string
  readonly code: 'invalid' | 'forbidden-path' | 'outbound-denied'
  readonly message: string
}

export interface RemoteValidationResult {
  readonly ok: boolean
  readonly issues: readonly RemoteValidationIssue[]
}

const PATH_FIELD_PATTERN = /^(?:source|destination|working|directory|socket)?path$|^(?:file|filename|filepath|directory|cwd|socket)$/i
const PATH_FIELD_NAMES = new Set([
  'sslrootcert',
  'sshprivatekey',
  'cafile',
  'certfile',
  'keyfile',
  'credentialsfile',
  'configfile'
])
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/

function canonicalHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '')
}

function isPrivateOrLocalIpv4(host: string): boolean {
  if (!IPV4_PATTERN.test(host)) return false
  const parts = host.split('.').map(Number)
  if (parts.some((part) => part > 255)) return true
  const first = parts[0] ?? -1
  const second = parts[1] ?? -1
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}

function validHost(host: string): boolean {
  const normalized = canonicalHost(host)
  return normalized !== '' && !normalized.includes('/') && !normalized.includes(':') && HOST_PATTERN.test(normalized)
}

/** 只做确定性的字符串/allowlist检查，不解析 DNS，也不跟随重定向。 */
export function isRemoteOutboundTargetAllowed(
  target: RemoteOutboundTarget,
  policy: RemoteOutboundPolicy
): boolean {
  if (!target || typeof target.host !== 'string' || !Number.isInteger(target.port)) return false
  if (target.port < 1 || target.port > 65_535 || !validHost(target.host)) return false
  const host = canonicalHost(target.host)
  if (isPrivateOrLocalIpv4(host) || host === 'localhost' || host.endsWith('.localhost')) return false
  const allowedHosts = policy.allowedHosts.map(canonicalHost)
  const allowedPorts = policy.allowedPorts
  return allowedHosts.includes(host) && allowedPorts.includes(target.port)
}

function isPathField(key: string): boolean {
  return PATH_FIELD_PATTERN.test(key) || PATH_FIELD_NAMES.has(key.toLowerCase())
}

interface OutboundTargetCandidate {
  readonly field: string
  readonly host: unknown
  readonly port: unknown
}

function outboundTargetCandidates(optionRecord: Record<string, unknown>): readonly OutboundTargetCandidate[] {
  const candidates: OutboundTargetCandidate[] = []
  if (optionRecord.host !== undefined || optionRecord.port !== undefined) {
    candidates.push({ field: 'options.host', host: optionRecord.host, port: optionRecord.port })
  }
  if (optionRecord.sshHost !== undefined || optionRecord.sshPort !== undefined) {
    candidates.push({ field: 'options.sshHost', host: optionRecord.sshHost, port: optionRecord.sshPort ?? 22 })
  }
  if (optionRecord.sshTargetHost !== undefined || optionRecord.sshTargetPort !== undefined) {
    candidates.push({
      field: 'options.sshTargetHost',
      host: optionRecord.sshTargetHost,
      port: optionRecord.sshTargetPort ?? optionRecord.port
    })
  }
  if (typeof optionRecord.brokers === 'string') {
    for (const [index, broker] of optionRecord.brokers.split(',').map((value) => value.trim()).entries()) {
      const separator = broker.lastIndexOf(':')
      if (separator <= 0) {
        candidates.push({ field: `options.brokers[${index}]`, host: broker, port: undefined })
        continue
      }
      candidates.push({
        field: `options.brokers[${index}]`,
        host: broker.slice(0, separator),
        port: Number(broker.slice(separator + 1))
      })
    }
  }
  return candidates
}

/** 校验远程连接 DTO，并验证所有驱动实际会访问的出站目标。 */
export function validateRemoteConnectionConfig(
  config: unknown,
  policy: RemoteOutboundPolicy
): RemoteValidationResult {
  const issues: RemoteValidationIssue[] = []
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, issues: [{ field: '', code: 'invalid', message: '连接配置必须是对象' }] }
  }

  const candidate = config as Record<string, unknown>
  if (typeof candidate.dialectId !== 'string' || candidate.dialectId.trim() === '') {
    issues.push({ field: 'dialectId', code: 'invalid', message: 'dialectId 不能为空' })
  }
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    issues.push({ field: 'name', code: 'invalid', message: 'name 不能为空' })
  }
  const options = candidate.options
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    issues.push({ field: 'options', code: 'invalid', message: 'options 必须是对象' })
    return { ok: issues.length === 0, issues }
  }

  const optionRecord = options as Record<string, unknown>
  for (const [key, value] of Object.entries(optionRecord)) {
    if (isPathField(key)) {
      issues.push({ field: `options.${key}`, code: 'forbidden-path', message: '远程连接配置禁止 server-local 路径字段' })
    }
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      issues.push({ field: `options.${key}`, code: 'invalid', message: '连接参数只能是字符串、数字或布尔值' })
    }
  }

  for (const candidate of outboundTargetCandidates(optionRecord)) {
    if (typeof candidate.host !== 'string' || typeof candidate.port !== 'number') {
      issues.push({ field: candidate.field, code: 'invalid', message: '出站 host 与 port 必须成对提供' })
    } else if (!isRemoteOutboundTargetAllowed({ host: candidate.host, port: candidate.port }, policy)) {
      issues.push({ field: candidate.field, code: 'outbound-denied', message: '出站目标未命中允许的主机与端口策略' })
    }
  }

  return { ok: issues.length === 0, issues }
}

export function isRemoteConnectionConfig(
  config: unknown,
  policy: RemoteOutboundPolicy
): config is RemoteConnectionConfig {
  return validateRemoteConnectionConfig(config, policy).ok
}
