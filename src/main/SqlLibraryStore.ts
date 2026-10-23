/**
 * SQL 历史与收藏的本地存储。
 *
 * 与 ConnectionStore 一样采用临时文件 + rename 的原子写，且坏文件只隔离备份、
 * 不删除。两类数据各用一个文件，避免历史的高频写入影响收藏的可靠性。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MAX_SQL_HISTORY,
  SQL_LIBRARY_SCHEMA_VERSION,
  type RecordSqlHistoryInput,
  type SavedSql,
  type SqlHistoryEntry,
  type SqlLibrarySnapshot
} from '../core/sql-library'

export { MAX_SQL_HISTORY } from '../core/sql-library'

const HISTORY_FILE = 'sql-history.json'
const SAVED_FILE = 'saved-sql.json'

interface HistoryFile {
  readonly schemaVersion: number
  readonly entries: readonly SqlHistoryEntry[]
}

interface SavedFile {
  readonly schemaVersion: number
  readonly entries: readonly SavedSql[]
}

export interface SqlLibraryStoreOptions {
  readonly baseDir: string
  readonly onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export class SqlLibraryStore {
  readonly #baseDir: string
  readonly #onLog: (level: 'info' | 'warn' | 'error', message: string) => void
  #history: SqlHistoryEntry[] = []
  #saved: SavedSql[] = []

  constructor(options: SqlLibraryStoreOptions) {
    this.#baseDir = options.baseDir
    this.#onLog = options.onLog ?? (() => {})
    this.#history = this.#loadHistory()
    this.#saved = this.#loadSaved()
  }

  get historyPath(): string {
    return join(this.#baseDir, HISTORY_FILE)
  }

  get savedPath(): string {
    return join(this.#baseDir, SAVED_FILE)
  }

  snapshot(): SqlLibrarySnapshot {
    return {
      history: this.#history.map((entry) => ({ ...entry })),
      saved: this.#saved.map((entry) => ({ ...entry }))
    }
  }

  record(input: RecordSqlHistoryInput, connectionName: string): SqlHistoryEntry {
    const sql = input.sql.trim()
    if (sql === '') throw new Error('不能记录空 SQL')
    const entry: SqlHistoryEntry = {
      id: randomUUID(),
      sql,
      connectionId: input.connectionId,
      connectionName,
      dialectId: input.dialectId,
      startedAt: Date.now(),
      elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
      status: input.status,
      error: input.status === 'error' ? (input.error ?? '未知错误') : null,
      returnedRows: input.status === 'success' ? (input.returnedRows ?? null) : null
    }
    this.#history = [entry, ...this.#history].slice(0, MAX_SQL_HISTORY)
    this.#flushHistory()
    return { ...entry }
  }

  save(id: string | null, name: string, sql: string): SavedSql {
    const cleanName = name.trim()
    const cleanSql = sql.trim()
    if (cleanName === '') throw new Error('收藏名称不能为空')
    if (cleanSql === '') throw new Error('不能收藏空 SQL')
    const now = Date.now()
    let entry: SavedSql
    if (id !== null) {
      const index = this.#saved.findIndex((item) => item.id === id)
      if (index === -1) throw new Error(`收藏不存在: ${id}`)
      entry = { id, name: cleanName, sql: cleanSql, updatedAt: now }
      // 契约是“最近保存在前”：更新也视为一次保存，必须移到最前。
      this.#saved = [entry, ...this.#saved.filter((item) => item.id !== id)]
    } else {
      entry = { id: randomUUID(), name: cleanName, sql: cleanSql, updatedAt: now }
      this.#saved = [entry, ...this.#saved]
    }
    this.#flushSaved()
    return { ...entry }
  }

  removeSaved(id: string): void {
    const next = this.#saved.filter((entry) => entry.id !== id)
    if (next.length === this.#saved.length) return
    this.#saved = next
    this.#flushSaved()
  }

  clearHistory(): void {
    if (this.#history.length === 0) return
    this.#history = []
    this.#flushHistory()
  }

  /** 刷新连接名快照；历史不会因连接被删除而失去可读性。 */
  updateConnectionName(connectionId: string, connectionName: string): void {
    let changed = false
    this.#history = this.#history.map((entry) => {
      if (entry.connectionId !== connectionId || entry.connectionName === connectionName) {
        return entry
      }
      changed = true
      return { ...entry, connectionName }
    })
    if (changed) this.#flushHistory()
  }

  #loadHistory(): SqlHistoryEntry[] {
    const path = this.historyPath
    if (!existsSync(path)) return []
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!isHistoryFile(parsed)) throw new Error('结构不符合预期')
      return parsed.entries
        .filter(isHistoryEntry)
        .slice(0, MAX_SQL_HISTORY)
    } catch (err) {
      this.#quarantine(path, `历史文件损坏: ${describeThrown(err)}`)
      return []
    }
  }

  #loadSaved(): SavedSql[] {
    const path = this.savedPath
    if (!existsSync(path)) return []
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!isSavedFile(parsed)) throw new Error('结构不符合预期')
      return parsed.entries.filter(isSavedSql)
    } catch (err) {
      this.#quarantine(path, `收藏文件损坏: ${describeThrown(err)}`)
      return []
    }
  }

  #flushHistory(): void {
    const file: HistoryFile = {
      schemaVersion: SQL_LIBRARY_SCHEMA_VERSION,
      entries: this.#history
    }
    this.#atomicWriteJson(this.historyPath, file)
  }

  #flushSaved(): void {
    const file: SavedFile = {
      schemaVersion: SQL_LIBRARY_SCHEMA_VERSION,
      entries: this.#saved
    }
    this.#atomicWriteJson(this.savedPath, file)
  }

  #quarantine(path: string, reason: string): void {
    if (!existsSync(path)) return
    const stamp = Date.now()
    let target = `${path}.corrupt-${stamp}`
    let n = 1
    while (existsSync(target)) {
      target = `${path}.corrupt-${stamp}-${n}`
      n += 1
    }
    try {
      renameSync(path, target)
      this.#onLog('warn', `[sql-library] 坏文件已隔离 → ${target.split('/').pop()}（${reason}）`)
    } catch (err) {
      this.#onLog('error', `[sql-library] 无法隔离坏文件 ${path}: ${describeThrown(err)}`)
    }
  }

  #atomicWriteJson(path: string, data: unknown): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      renameSync(tmp, path)
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* 错误路径上不再制造第二个错误 */
      }
      throw new Error(`原子写入失败（${path}）：${describeThrown(err)}`)
    }
  }
}

function isHistoryFile(value: unknown): value is HistoryFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Partial<HistoryFile>
  return file.schemaVersion === SQL_LIBRARY_SCHEMA_VERSION && Array.isArray(file.entries)
}

function isSavedFile(value: unknown): value is SavedFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Partial<SavedFile>
  return file.schemaVersion === SQL_LIBRARY_SCHEMA_VERSION && Array.isArray(file.entries)
}

function isHistoryEntry(value: unknown): value is SqlHistoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<SqlHistoryEntry>
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.sql === 'string' &&
    item.sql.length > 0 &&
    typeof item.connectionId === 'string' &&
    typeof item.connectionName === 'string' &&
    typeof item.dialectId === 'string' &&
    typeof item.startedAt === 'number' &&
    Number.isFinite(item.startedAt) &&
    typeof item.elapsedMs === 'number' &&
    Number.isFinite(item.elapsedMs) &&
    (item.status === 'success' || item.status === 'error') &&
    (item.error === null || typeof item.error === 'string') &&
    (item.returnedRows === null || typeof item.returnedRows === 'number')
  )
}

function isSavedSql(value: unknown): value is SavedSql {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<SavedSql>
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.name === 'string' &&
    item.name.length > 0 &&
    typeof item.sql === 'string' &&
    item.sql.length > 0 &&
    typeof item.updatedAt === 'number' &&
    Number.isFinite(item.updatedAt)
  )
}

function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
