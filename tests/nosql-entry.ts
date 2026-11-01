/**
 * Redis/Kafka 契约测试的入口（**仅测试用**）。
 *
 * 与 `probe-entry.ts` 同理：这里把「真实注册表」和「真实 adapter」装在一起，
 * 让测试拿到的是生产路径上的对象，而不是手写的假实现。
 * 它只在 `tests/e2e-nosql-drivers.mjs` 里被 vite 打包，Electron 主进程不会加载。
 */
import { DriverRegistry } from '../src/core/registry'
import { registerBuiltinDrivers } from '../src/drivers'
import {
  buildRedisOptions,
  createRedisAdapter,
  keyNodeId,
  parseKeyspace,
  parseRedisNodeId,
  parseServerVersion,
  RedisDriverAdapter
} from '../src/drivers/redis/adapter'
import {
  buildKafkaConfig,
  createKafkaAdapter,
  KafkaDriverAdapter,
  parseBrokers,
  parseKafkaNodeId,
  partitionNodeId,
  topicNodeId
} from '../src/drivers/kafka/adapter'

export function listDialects() {
  const registry = new DriverRegistry()
  registerBuiltinDrivers(registry)
  return registry.list()
}

export {
  buildKafkaConfig,
  buildRedisOptions,
  createKafkaAdapter,
  createRedisAdapter,
  KafkaDriverAdapter,
  keyNodeId,
  parseBrokers,
  parseKafkaNodeId,
  parseKeyspace,
  parseRedisNodeId,
  parseServerVersion,
  partitionNodeId,
  RedisDriverAdapter,
  topicNodeId
}
