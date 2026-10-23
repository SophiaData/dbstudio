/**
 * SQL 历史与收藏的跨进程契约。
 *
 * 这里只表达「用户想记住什么」，不包含持久化实现与 UI 状态。
 * 历史与收藏刻意分开：历史有容量上限且会自动淘汰，收藏则是用户显式
 * 保留的工作资产，不能被一次配额裁剪静默删掉。
 */

/** 收藏的一条 SQL。 */
export interface SavedSql {
  readonly id: string
  readonly name: string
  readonly sql: string
  /** 最近一次使用/保存的 Unix 毫秒时间。 */
  readonly updatedAt: number
}

/** 一条执行历史。 */
export interface SqlHistoryEntry {
  readonly id: string
  readonly sql: string
  /** 执行时选择的连接；连接被删除后仍保留其名称快照，便于阅读历史。 */
  readonly connectionId: string
  readonly connectionName: string
  readonly dialectId: string
  readonly startedAt: number
  readonly elapsedMs: number
  readonly status: 'success' | 'error'
  /** 失败原因；成功时为 null。 */
  readonly error: string | null
  /** 成功时的返回行数；失败或调用方未提供时为 null。 */
  readonly returnedRows: number | null
}

/** 记录一次执行。id 与 startedAt 由主进程生成，UI 不能伪造时间线。 */
export interface RecordSqlHistoryInput {
  readonly sql: string
  readonly connectionId: string
  readonly dialectId: string
  readonly elapsedMs: number
  readonly status: 'success' | 'error'
  readonly error?: string
  readonly returnedRows?: number
}

/** SQL 库快照。 */
export interface SqlLibrarySnapshot {
  readonly history: readonly SqlHistoryEntry[]
  readonly saved: readonly SavedSql[]
}

/** 收藏的落盘格式版本。 */
export const SQL_LIBRARY_SCHEMA_VERSION = 1

/** 历史最多保留条数；收藏不计入这个上限。 */
export const MAX_SQL_HISTORY = 500
