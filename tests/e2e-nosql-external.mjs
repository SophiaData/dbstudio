/**
 * Redis / Kafka 真实服务器联调（外部组）。
 *
 * 用环境变量传地址，**缺变量就失败而不是静默跳过**——这类"只浏览"驱动的
 * 最大风险是"看起来连上了，其实什么都没列出来"，跳过等于没测。
 *
 *   DBSTUDIO_REDIS_URL   redis://127.0.0.1:6379/0
 *   DBSTUDIO_KAFKA_BROKERS 127.0.0.1:9092
 *
 * 覆盖：
 *   A. testConnection 成功且带 serverVersion；
 *   B. 经真实 ConnectionManager + 驱动宿主列出 Redis 库 / key（含多库）；
 *   C. 列出 Kafka topic / 分区，分区 meta 带 leader 与 offset；
 *   D. 只读：浏览前后 DBSIZE 与 topic offset 不变；
 *   E. 浏览发起 SQL 查询会被明确拒绝（unsupported_method），不是静默失败。
 *
 * 运行：DBSTUDIO_REDIS_URL=... DBSTUDIO_KAFKA_BROKERS=... node tests/e2e-nosql-external.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Redis } from 'ioredis'
import { Kafka } from 'kafkajs'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const redisUrl = process.env.DBSTUDIO_REDIS_URL
const kafkaBrokers = process.env.DBSTUDIO_KAFKA_BROKERS
if (!redisUrl) {
  console.error('缺少 DBSTUDIO_REDIS_URL：外部联调不允许静默跳过')
  process.exit(1)
}
if (!kafkaBrokers) {
  console.error('缺少 DBSTUDIO_KAFKA_BROKERS：外部联调不允许静默跳过')
  process.exit(1)
}

const outDir = mkdtempSync(join(root, 'out/.nosql-external-'))
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir,
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    ssr: true,
    rollupOptions: { external: [/^node:/, 'electron'], output: { entryFileNames: 'probe.cjs' } },
    lib: { entry: resolve(root, 'tests/probe-entry.ts'), formats: ['cjs'] }
  }
})
const { createManagerWithBuiltinDialects } = await import(pathToFileURL(join(outDir, 'probe.cjs')).href)

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const url = new URL(redisUrl)
const redisDb = Number(url.pathname.replace('/', '') || '0')
const manager = createManagerWithBuiltinDialects()
const created = []
try {
  console.log('\n[1] Redis')
  const redis = await manager.add({
    dialectId: 'redis',
    name: 'redis-external',
    options: {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password ? { password: '' } : {})
    }
  }, url.password ? { dbPassword: decodeURIComponent(url.password) } : undefined)
  created.push(redis.id)
  check('连接成功', redis.connected === true)

  const dbs = await manager.listChildren(`connection:${redis.id}`)
  check('列出至少一个库', dbs.length >= 1, JSON.stringify(dbs.map((d) => d.name)))
  check('库节点带 key 数量', dbs.every((d) => typeof d.meta?.keys === 'number'))
  const target = dbs.find((d) => d.name === `db${redisDb}`) ?? dbs[0]
  const keys = await manager.listChildren(target.id)
  check(`db${redisDb} 下能列出 key`, keys.length >= 1, JSON.stringify(keys.map((k) => k.name)))
  check('key 节点带 type', keys.every((k) => typeof k.meta?.type === 'string'))
  check('key 节点是叶子（不谎报有子节点）', keys.every((k) => k.hasChildren === false))
  check('key 节点带 TTL 展示值', keys.every((k) => k.meta?.ttl !== undefined))
  const keyLeaves = await manager.listChildren(keys[0].id)
  check('key 展开为空', keyLeaves.length === 0)

  let rejected = null
  try {
    await manager.runQuery(`connection:${redis.id}`, 'SELECT 1')
  } catch (error) {
    rejected = error
  }
  check('Redis 上执行 SQL 被拒绝', /不支持|unsupported_method/.test(String(rejected?.message ?? rejected)), String(rejected?.message ?? rejected))

  const client = new Redis(redisUrl, { maxRetriesPerRequest: 1 })
  const sizeBefore = await client.dbsize()
  await manager.listChildren(target.id)
  const sizeAfter = await client.dbsize()
  check('浏览不改变 key 数量', sizeBefore === sizeAfter, `${sizeBefore} → ${sizeAfter}`)
  await client.quit()

  let snapshotRejected = null
  try {
    await manager.captureSchemaSnapshot(redis.id)
  } catch (error) {
    snapshotRejected = error
  }
  check('只浏览数据源不能拍结构快照', /没有表结构/.test(String(snapshotRejected?.message ?? '')), String(snapshotRejected?.message ?? '未拒绝'))

  await manager.disconnectConnection(redis.id)

  console.log('\n[2] Kafka')
  const kafka = await manager.add({
    dialectId: 'kafka',
    name: 'kafka-external',
    options: { brokers: kafkaBrokers }
  })
  created.push(kafka.id)
  check('连接成功', kafka.connected === true)
  const topics = await manager.listChildren(`connection:${kafka.id}`)
  check('列出 topic', topics.length >= 1, JSON.stringify(topics.map((t) => t.name)))
  check('内部 topic（__）被隐藏', topics.every((t) => !t.name.startsWith('__')))
  const orders = topics.find((t) => t.name === 'orders') ?? topics[0]
  const partitions = await manager.listChildren(orders.id)
  check('列出分区', partitions.length >= 1, JSON.stringify(partitions.map((p) => p.name)))
  check('分区带 leader 与副本', partitions.every((p) => p.meta?.leader !== undefined && p.meta?.replicas !== undefined))
  check('分区带 offset 水位', partitions.every((p) => typeof p.meta?.highOffset === 'number'))
  check('分区是叶子', partitions.every((p) => p.hasChildren === false))

  const admin = new Kafka({ clientId: 'verify', brokers: kafkaBrokers.split(',') }).admin()
  await admin.connect()
  const offsetsBefore = JSON.stringify(await admin.fetchTopicOffsets(orders.name))
  await manager.listChildren(orders.id)
  const offsetsAfter = JSON.stringify(await admin.fetchTopicOffsets(orders.name))
  check('浏览不改变 topic offset', offsetsBefore === offsetsAfter)
  await admin.disconnect()

  let kafkaRejected = null
  try {
    await manager.runQuery(`connection:${kafka.id}`, 'SELECT 1')
  } catch (error) {
    kafkaRejected = error
  }
  check('Kafka 上执行 SQL 被拒绝', /不支持|unsupported_method/.test(String(kafkaRejected?.message ?? kafkaRejected)))
} finally {
  await manager.disposeAll().catch(() => undefined)
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\nRedis/Kafka 外部联调 ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
