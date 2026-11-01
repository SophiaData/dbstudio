/**
 * Redis 最小驱动：测试连接 + 浏览（DB → key）。
 *
 * 只读命令：PING / INFO / SELECT / SCAN / TYPE / PTTL / MEMORY USAGE。
 * 不提供写入、不执行用户输入的命令，也不读取 key 的值内容——值可能很大，
 * 也可能是敏感数据；浏览阶段只给类型、TTL、长度这些元信息。
 *
 * 树结构：
 *   null          → db:<n> 若干（INFO keyspace 里有数据的库，外加 db0）
 *   db:<n>        → key:<n>:<key>（SCAN 至多 MAX_KEYS 个，按名字排序）
 *   key:<n>:<key> → 叶子，meta 带 type / ttl / length
 */
import Redis, { type RedisOptions } from 'ioredis'
import type { ConnectionConfig } from '../../core/dialect'
import type { DialectInfo, SecretValue, TestConnectionResult } from '../../core/driver'
import type { DriverCapabilities, ObjectRef } from '../../core/model'
import {
  NoSqlAdapterBase,
  NoSqlAdapterError,
  describeError,
  noSqlDialect,
  portOption,
  stringOption
} from '../nosql-base'
import { REDIS_DIALECT_ID, REDIS_INFO } from './info'

/** 单个库最多列出的 key 数；浏览用，超出时在库节点 meta 里标注 truncated。 */
export const MAX_KEYS = 500
const SCAN_COUNT = 200
const CONNECT_TIMEOUT_MS = 5000

const CAPABILITIES: DriverCapabilities = {
  supportsInlineEdit: false,
  supportsServerPagination: false,
  hasCatalog: false,
  hasSchema: false,
  supportsCancel: false
}

export function buildRedisOptions(config: ConnectionConfig, secret: SecretValue): RedisOptions {
  const options = config.options
  const host = stringOption(options, 'host', '127.0.0.1')
  if (host === '') throw new NoSqlAdapterError('bad_params', '主机不能为空')
  const user = stringOption(options, 'user')
  const tls = stringOption(options, 'tls', 'off') === 'on'
  return {
    host,
    port: portOption(options, 'port', 6379),
    ...(user !== '' ? { username: user } : {}),
    ...(secret.dbPassword ? { password: secret.dbPassword } : {}),
    ...(tls ? { tls: { servername: host } } : {}),
    connectTimeout: CONNECT_TIMEOUT_MS,
    // 失败就报错，不在后台无限重连：UI 需要明确的“连不上”。
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    enableOfflineQueue: false,
    lazyConnect: true,
    // 只读浏览：禁止 ioredis 自动发送 CLIENT SETNAME 等额外命令以外的东西。
    connectionName: 'dbstudio-browse'
  }
}

/** 解析 `INFO keyspace`：`db0:keys=3,expires=0,avg_ttl=0` → [{ db: 0, keys: 3 }]。 */
export function parseKeyspace(info: string): { db: number; keys: number }[] {
  const result: { db: number; keys: number }[] = []
  for (const line of info.split(/\r?\n/)) {
    const match = /^db(\d+):keys=(\d+)/.exec(line.trim())
    if (match) result.push({ db: Number(match[1]), keys: Number(match[2]) })
  }
  return result.sort((a, b) => a.db - b.db)
}

export function parseServerVersion(info: string): string | undefined {
  const match = /^redis_version:(.+)$/m.exec(info)
  return match ? `Redis ${match[1]?.trim()}` : undefined
}

export function dbNodeId(db: number): string {
  return `db:${db}`
}

export function keyNodeId(db: number, key: string): string {
  return `key:${db}:${key}`
}

export function parseRedisNodeId(
  id: string
): { kind: 'db'; db: number } | { kind: 'key'; db: number; key: string } | { kind: 'more'; db: number } | null {
  const more = /^more:(\d+)$/.exec(id)
  if (more) return { kind: 'more', db: Number(more[1]) }
  const db = /^db:(\d+)$/.exec(id)
  if (db) return { kind: 'db', db: Number(db[1]) }
  const key = /^key:(\d+):([\s\S]*)$/.exec(id)
  if (key) return { kind: 'key', db: Number(key[1]), key: key[2] ?? '' }
  return null
}

export class RedisDriverAdapter extends NoSqlAdapterBase {
  readonly dialect = noSqlDialect(REDIS_DIALECT_ID, 'Redis')
  readonly info: DialectInfo = REDIS_INFO
  #client: Redis | null = null
  #pattern = '*'
  /** 所有命令串行执行：SELECT 会改变连接级状态，交错执行会读错库。 */
  #queue: Promise<unknown> = Promise.resolve()

  async connect(config: ConnectionConfig, secret: SecretValue): Promise<DriverCapabilities> {
    if (this.#client !== null) throw new NoSqlAdapterError('already_connected', 'Redis 已连接')
    const client = new Redis(buildRedisOptions(config, secret))
    client.on('error', () => undefined) // 错误通过命令的 reject 上报，避免未处理事件打崩宿主
    try {
      await client.connect()
      await client.ping()
    } catch (error) {
      client.disconnect()
      throw new NoSqlAdapterError('connection_failed', `Redis 连接失败：${describeError(error)}`, error)
    }
    this.#pattern = stringOption(config.options, 'keyPattern', '*') || '*'
    this.#client = client
    return CAPABILITIES
  }

  async disconnect(): Promise<void> {
    const client = this.#client
    this.#client = null
    if (client === null) return
    try {
      await client.quit()
    } catch {
      client.disconnect()
    }
  }

  async testConnection(config: ConnectionConfig, secret: SecretValue): Promise<TestConnectionResult> {
    const started = Date.now()
    const client = new Redis(buildRedisOptions(config, secret))
    client.on('error', () => undefined)
    try {
      await client.connect()
      await client.ping()
      const info = await client.info('server')
      const version = parseServerVersion(info)
      return { ok: true, elapsedMs: Date.now() - started, ...(version ? { serverVersion: version } : {}) }
    } catch (error) {
      return { ok: false, message: `Redis 连接失败：${describeError(error)}`, elapsedMs: Date.now() - started }
    } finally {
      client.disconnect()
    }
  }

  async listChildren(parentId: string | null): Promise<ObjectRef[]> {
    const client = this.#requireClient()
    if (parentId === null) return this.#serial(() => this.#listDatabases(client))
    const parsed = parseRedisNodeId(parentId)
    if (parsed === null) throw new NoSqlAdapterError('object_not_found', `无法识别的 Redis 节点：${parentId}`)
    // key 与"仅显示前 N 个"提示节点都是叶子。
    if (parsed.kind === 'key' || parsed.kind === 'more') return []
    return this.#serial(() => this.#listKeys(client, parsed.db))
  }

  #requireClient(): Redis {
    if (this.#client === null) throw new NoSqlAdapterError('not_connected', 'Redis 未连接')
    return this.#client
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task)
    this.#queue = run.catch(() => undefined)
    return run
  }

  async #listDatabases(client: Redis): Promise<ObjectRef[]> {
    const keyspace = parseKeyspace(await client.info('keyspace'))
    if (!keyspace.some((entry) => entry.db === 0)) keyspace.unshift({ db: 0, keys: 0 })
    return keyspace.map(({ db, keys }) => ({
      id: dbNodeId(db),
      kind: 'schema' as const,
      name: `db${db}`,
      parentId: null,
      hasChildren: keys > 0,
      meta: { keys, pattern: this.#pattern }
    }))
  }

  async #listKeys(client: Redis, db: number): Promise<ObjectRef[]> {
    await client.select(db)
    const keys = new Set<string>()
    let cursor = '0'
    let truncated = false
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', this.#pattern, 'COUNT', SCAN_COUNT)
      cursor = next
      for (const key of batch) {
        if (keys.size >= MAX_KEYS) {
          truncated = true
          break
        }
        keys.add(key)
      }
    } while (cursor !== '0' && !truncated)
    const sorted = [...keys].sort()
    const pipeline = client.pipeline()
    for (const key of sorted) pipeline.type(key).pttl(key)
    const replies = (await pipeline.exec()) ?? []
    const refs = sorted.map((key, index): ObjectRef => {
      const type = replies[index * 2]?.[1]
      const pttl = replies[index * 2 + 1]?.[1]
      return {
        id: keyNodeId(db, key),
        kind: 'folder',
        name: key,
        parentId: dbNodeId(db),
        hasChildren: false,
        meta: {
          type: typeof type === 'string' ? type : 'unknown',
          ttl: typeof pttl === 'number' ? (pttl < 0 ? (pttl === -1 ? '永久' : '已过期') : `${Math.ceil(pttl / 1000)} 秒`) : null
        }
      }
    })
    if (truncated) {
      refs.push({
        id: `more:${db}`,
        kind: 'folder',
        name: `…仅显示前 ${MAX_KEYS} 个 key，请用“键过滤”缩小范围`,
        parentId: dbNodeId(db),
        hasChildren: false,
        meta: { truncated: true }
      })
    }
    return refs
  }
}

export function createRedisAdapter(): RedisDriverAdapter {
  return new RedisDriverAdapter()
}
