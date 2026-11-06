import { invoke } from '@tauri-apps/api/core'
import type { DbStudioApi } from '../../../src/core/api'

export type BackendMethod = keyof DbStudioApi
export type BackendArgs<K extends BackendMethod> = Parameters<DbStudioApi[K]>
export type BackendValue<K extends BackendMethod> = Awaited<ReturnType<DbStudioApi[K]>>

/** Typed arrays are not valid JSON values; the native driver expects the explicit byte wire tag. */
export function wireBackendValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { type: 'dbstudio-sql-bytes', data: Array.from(value) }
  if (Array.isArray(value)) return value.map(wireBackendValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, wireBackendValue(child)]))
  }
  return value
}
export function wireBackendArgs(args: readonly unknown[]): unknown[] {
  return args.map(wireBackendValue)
}

/** The native host returns the API value directly and rejects with { code, message }. */
export function backendCall<K extends BackendMethod>(method: K, ...args: BackendArgs<K>): Promise<BackendValue<K>> {
  return invoke<BackendValue<K>>('backend_call', { method, args: wireBackendArgs(args) })
}

export interface MigrationStatus {
  legacyConfigImported: boolean
  legacySecretsRequireReentry: boolean
  warnings: string[]
}
export function migrationStatus(): Promise<MigrationStatus> {
  return invoke<MigrationStatus>('backend_call', { method: 'migrationStatus', args: [] })
}

/** Host-only controls share the same command boundary; they are never SQL/RPC methods. */
export function confirmExit(): Promise<void> {
  return invoke('backend_call', { method: 'confirmExit', args: [] })
}
export function chooseExportFile(suggestedName = 'export.csv'): Promise<string | null> {
  return invoke('backend_call', { method: 'chooseExportFile', args: [suggestedName] })
}
export function saveTextExport(request: { suggestedName: string; content: string }): Promise<string | null> {
  return invoke('backend_call', { method: 'saveTextExport', args: [request] })
}
export interface SmokeFixture { databasePath: string; importPath: string; exportPath: string; isolated: boolean }
export function smokeFixture(): Promise<SmokeFixture> {
  return invoke('backend_call', { method: 'smokeFixture', args: [] })
}

export const backend = new Proxy(Object.create(null), {
  get(_target, method: string) {
    if (method === 'then') return undefined
    return (...args: unknown[]) => invoke('backend_call', { method, args: wireBackendArgs(args) })
  }
}) as DbStudioApi

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return typeof error === 'string' ? error : '原生后端操作失败'
}
