import type { ConnectionSummary } from '../../../src/core/api'
import type { QueryResult } from '../../../src/core/resultset'

export interface SessionContext {
  status: 'unknown' | 'loading' | 'ready' | 'error'
  database: string | null
  schema: string | null
  error?: string
}
export interface ConnectionTarget {
  connectionId: string
  connectionName: string
  dialectId: string
  configuredDatabase: string | null
  connected: boolean
  session: SessionContext
}
export const unknownSession = (): SessionContext => ({ status: 'unknown', database: null, schema: null })
export function contextQuery(dialect: string): string | null {
  if (dialect === 'mysql') return 'SELECT DATABASE() AS dbstudio_database'
  if (dialect === 'postgresql') return 'SELECT current_database() AS dbstudio_database, current_schema() AS dbstudio_schema'
  return null
}
export function readSessionContext(result: QueryResult, dialect: string): SessionContext {
  if (result.rows.length !== 1) throw new Error('会话信息返回格式不完整')
  const field = (name: string) => {
    const index = result.columns.findIndex(column => column.name === name)
    const value = result.rows[0]?.cells[index]
    if (value?.kind === 'null') return null
    if (value?.kind !== 'text' || value.truncated || !value.text) throw new Error('会话信息返回格式不完整')
    return value.text
  }
  return { status: 'ready', database: field('dbstudio_database'), schema: dialect === 'postgresql' ? field('dbstudio_schema') : null }
}
export function connectionTarget(connection: ConnectionSummary | undefined, id: string, session: SessionContext): ConnectionTarget {
  const configured = connection?.options?.database
  return { connectionId: id, connectionName: connection?.name ?? (id ? '原连接不可用' : '未选择连接'),
    dialectId: connection?.dialectId ?? '', configuredDatabase: typeof configured === 'string' && configured ? configured : null,
    connected: connection?.connected === true, session: { ...session } }
}
export function sameSession(left: SessionContext, right: SessionContext) {
  return left.status === right.status && left.database === right.database && left.schema === right.schema
}
