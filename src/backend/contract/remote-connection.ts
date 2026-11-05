import type { ConnectionSummary } from '../../core/api'
import type { ConnectionConfig } from '../../core/dialect'
import type { SecretInput, TestConnectionResult } from '../../core/driver'
import { isRemoteSecretOptionKey } from './remote'

export interface RemoteConnectionCreateRequest {
  readonly config: ConnectionConfig
  readonly secret?: SecretInput
}

export interface RemoteConnectionUpdateRequest {
  readonly config: Partial<ConnectionConfig>
  readonly secretPatch?: SecretInput
}

export type RemoteConnectionMethod =
  | 'list'
  | 'create'
  | 'test'
  | 'update'
  | 'connect'
  | 'disconnect'
  | 'remove'

export interface RemoteConnectionRouteDescription {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
}

export const REMOTE_CONNECTION_ROUTES: Readonly<Record<RemoteConnectionMethod, RemoteConnectionRouteDescription>> = {
  list: { method: 'GET', path: '/connections' },
  create: { method: 'POST', path: '/connections' },
  test: { method: 'POST', path: '/connections/test' },
  update: { method: 'PATCH', path: '/connections/:id' },
  connect: { method: 'POST', path: '/connections/:id/connect' },
  disconnect: { method: 'POST', path: '/connections/:id/disconnect' },
  remove: { method: 'DELETE', path: '/connections/:id' }
}

export function isRemoteConnectionMethod(value: unknown): value is RemoteConnectionMethod {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REMOTE_CONNECTION_ROUTES, value)
}

export function remoteConnectionPath(
  connectionId?: string,
  action?: 'connect' | 'disconnect'
): string {
  if (connectionId === undefined) return '/connections'
  if (connectionId.trim() === '') throw new Error('connectionId 不能为空')
  const encoded = encodeURIComponent(connectionId)
  return action === undefined ? `/connections/${encoded}` : `/connections/${encoded}/${action}`
}

function isPathLikeKey(key: string): boolean {
  return /(path|file|directory|filename|socket|sslrootcert|cafile|certfile|keyfile|credentialsfile|configfile)/i.test(key)
}

export function isRemoteConnectionOptionSafe(key: string, value: unknown): value is string | number | boolean {
  return !isRemoteSecretOptionKey(key) && !isPathLikeKey(key) &&
    (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
}

function safeOptions(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output: Record<string, string | number | boolean> = {}
  for (const [key, item] of Object.entries(value)) {
    if (isRemoteConnectionOptionSafe(key, item)) {
      output[key] = item
    }
  }
  return output
}

export function toRemoteConnectionSummary(value: unknown): ConnectionSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('connection summary 必须是对象')
  }
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.dialectId !== 'string' ||
    typeof candidate.connected !== 'boolean' ||
    typeof candidate.persisted !== 'boolean' ||
    !(candidate.secretStored === null || typeof candidate.secretStored === 'boolean')
  ) {
    throw new Error('connection summary 字段不完整')
  }
  return {
    id: candidate.id,
    name: candidate.name,
    dialectId: candidate.dialectId,
    connected: candidate.connected,
    capabilities: candidate.capabilities && typeof candidate.capabilities === 'object'
      ? candidate.capabilities as ConnectionSummary['capabilities']
      : null,
    persisted: candidate.persisted,
    secretStored: candidate.secretStored,
    options: safeOptions(candidate.options)
  }
}

export type RemoteConnectionTestResult = TestConnectionResult
