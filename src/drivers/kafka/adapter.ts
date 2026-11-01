/**
 * Kafka 最小驱动：测试连接 + 浏览（topic → 分区）。
 *
 * 只用 Admin API 的只读调用：describeCluster / listTopics / fetchTopicMetadata /
 * fetchTopicOffsets。不创建 consumer group、不消费消息、不写入，
 * 浏览不会在集群上留下任何状态。
 *
 * 树结构：
 *   null                    → topic:<name>（默认隐藏 `__` 开头的内部 topic）
 *   topic:<name>            → partition:<p>:<name>（meta 带 leader / 副本 / 高低水位）
 */
import { Kafka, logLevel, type KafkaConfig, type SASLOptions } from 'kafkajs'
import type { ConnectionConfig } from '../../core/dialect'
import type { DialectInfo, SecretValue, TestConnectionResult } from '../../core/driver'
import type { DriverCapabilities, ObjectRef } from '../../core/model'
import { NoSqlAdapterBase, NoSqlAdapterError, describeError, noSqlDialect, stringOption } from '../nosql-base'
import { KAFKA_DIALECT_ID, KAFKA_INFO } from './info'

type Admin = ReturnType<Kafka['admin']>

const CAPABILITIES: DriverCapabilities = {
  supportsInlineEdit: false,
  supportsServerPagination: false,
  hasCatalog: false,
  hasSchema: false,
  supportsCancel: false
}

export function parseBrokers(raw: string): string[] {
  const brokers = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (brokers.length === 0) throw new NoSqlAdapterError('bad_params', 'Broker 列表不能为空')
  for (const broker of brokers) {
    const match = /^(.+):(\d{1,5})$/.exec(broker)
    const port = match ? Number(match[2]) : NaN
    if (!match || port < 1 || port > 65535) {
      throw new NoSqlAdapterError('bad_params', `Broker 地址应为 host:port，收到：${broker}`)
    }
  }
  return brokers
}

export function buildKafkaConfig(config: ConnectionConfig, secret: SecretValue): KafkaConfig {
  const options = config.options
  const brokers = parseBrokers(stringOption(options, 'brokers'))
  const mechanism = stringOption(options, 'saslMechanism', 'none') || 'none'
  let sasl: SASLOptions | undefined
  if (mechanism !== 'none') {
    if (mechanism !== 'plain' && mechanism !== 'scram-sha-256' && mechanism !== 'scram-sha-512') {
      throw new NoSqlAdapterError('bad_params', `不支持的 SASL 机制：${mechanism}`)
    }
    const username = stringOption(options, 'user')
    if (username === '') throw new NoSqlAdapterError('bad_params', '启用 SASL 时必须填写用户名')
    sasl = { mechanism, username, password: secret.dbPassword ?? '' } as SASLOptions
  }
  return {
    clientId: stringOption(options, 'clientId', 'dbstudio') || 'dbstudio',
    brokers,
    ssl: stringOption(options, 'ssl', 'off') === 'on',
    ...(sasl ? { sasl } : {}),
    connectionTimeout: 5000,
    requestTimeout: 10000,
    // 连不上就尽快报错，不在后台反复重试。
    retry: { retries: 1, initialRetryTime: 200, maxRetryTime: 1000 },
    logLevel: logLevel.NOTHING
  }
}

/** kafkajs 的 offset 是字符串（可能超过 Number.MAX_SAFE_INTEGER），仅用于展示。 */
export function toOffsetNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export function topicNodeId(topic: string): string {
  return `topic:${topic}`
}

export function partitionNodeId(topic: string, partition: number): string {
  return `partition:${partition}:${topic}`
}

export function parseKafkaNodeId(
  id: string
): { kind: 'topic'; topic: string } | { kind: 'partition'; topic: string; partition: number } | null {
  if (id.startsWith('topic:') && id.length > 'topic:'.length) return { kind: 'topic', topic: id.slice('topic:'.length) }
  const match = /^partition:(\d+):([\s\S]+)$/.exec(id)
  if (match) return { kind: 'partition', partition: Number(match[1]), topic: match[2] ?? '' }
  return null
}

export class KafkaDriverAdapter extends NoSqlAdapterBase {
  readonly dialect = noSqlDialect(KAFKA_DIALECT_ID, 'Kafka')
  readonly info: DialectInfo = KAFKA_INFO
  #admin: Admin | null = null

  async connect(config: ConnectionConfig, secret: SecretValue): Promise<DriverCapabilities> {
    if (this.#admin !== null) throw new NoSqlAdapterError('already_connected', 'Kafka 已连接')
    const admin = new Kafka(buildKafkaConfig(config, secret)).admin()
    try {
      await admin.connect()
      await admin.describeCluster()
    } catch (error) {
      await admin.disconnect().catch(() => undefined)
      throw new NoSqlAdapterError('connection_failed', `Kafka 连接失败：${describeError(error)}`, error)
    }
    this.#admin = admin
    return CAPABILITIES
  }

  async disconnect(): Promise<void> {
    const admin = this.#admin
    this.#admin = null
    if (admin !== null) await admin.disconnect().catch(() => undefined)
  }

  async testConnection(config: ConnectionConfig, secret: SecretValue): Promise<TestConnectionResult> {
    const started = Date.now()
    let admin: Admin | null = null
    try {
      admin = new Kafka(buildKafkaConfig(config, secret)).admin()
      await admin.connect()
      const cluster = await admin.describeCluster()
      return {
        ok: true,
        elapsedMs: Date.now() - started,
        serverVersion: `Kafka 集群 ${cluster.clusterId}（${cluster.brokers.length} 个 broker）`
      }
    } catch (error) {
      return { ok: false, message: `Kafka 连接失败：${describeError(error)}`, elapsedMs: Date.now() - started }
    } finally {
      await admin?.disconnect().catch(() => undefined)
    }
  }

  async listChildren(parentId: string | null): Promise<ObjectRef[]> {
    const admin = this.#requireAdmin()
    if (parentId === null) {
      const topics = (await admin.listTopics()).filter((name) => !name.startsWith('__')).sort()
      return topics.map((topic) => ({
        id: topicNodeId(topic),
        kind: 'schema' as const,
        name: topic,
        parentId: null,
        hasChildren: true
      }))
    }
    const parsed = parseKafkaNodeId(parentId)
    if (parsed === null) throw new NoSqlAdapterError('object_not_found', `无法识别的 Kafka 节点：${parentId}`)
    if (parsed.kind === 'partition') return []
    const metadata = await admin.fetchTopicMetadata({ topics: [parsed.topic] })
    const topic = metadata.topics[0]
    if (topic === undefined) throw new NoSqlAdapterError('object_not_found', `topic 不存在：${parsed.topic}`)
    const offsets = await admin.fetchTopicOffsets(parsed.topic)
    const byPartition = new Map(offsets.map((o) => [o.partition, o]))
    return [...topic.partitions]
      .sort((a, b) => a.partitionId - b.partitionId)
      .map((partition) => {
        const offset = byPartition.get(partition.partitionId)
        return {
          id: partitionNodeId(parsed.topic, partition.partitionId),
          kind: 'folder' as const,
          name: `分区 ${partition.partitionId}`,
          parentId,
          hasChildren: false,
          meta: {
            leader: partition.leader,
            replicas: partition.replicas.join(','),
            isr: partition.isr.join(','),
            lowOffset: toOffsetNumber(offset?.low),
            highOffset: toOffsetNumber(offset?.high)
          }
        }
      })
  }

  #requireAdmin(): Admin {
    if (this.#admin === null) throw new NoSqlAdapterError('not_connected', 'Kafka 未连接')
    return this.#admin
  }
}

export function createKafkaAdapter(): KafkaDriverAdapter {
  return new KafkaDriverAdapter()
}
