/**
 * Redis / Kafka 两个“只浏览”驱动的契约测试。
 *
 * 它们不是 SQL 数据源，所以契约的重点不是查询，而是：
 *   A. **注册与宿主加载**：驱动宿主能用 `--dialect redis|kafka` 真的起来并握手；
 *   B. **SQL 方法一律拒绝**：全部返回 unsupported_method，不能“半实现”
 *      （半实现最危险：UI 会以为能查，用户拿到的是错的语义）；
 *   C. **节点 id 往返**：库/键、topic/分区 id 能解析回原值，且坏 id 明确报错；
 *   D. **参数校验**：非法 broker / 端口 / SASL 组合在发网络请求**之前**就拒绝；
 *   E. **连不上要说清楚**：testConnection 返回 ok:false + 可读原因，而不是抛异常
 *      或长时间挂住。
 *
 * 真实服务器联调在 `tests/e2e-nosql-external.mjs`（需要 docker，走外部组）。
 *
 * 运行：node tests/e2e-nosql-drivers.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')
const outDir = mkdtempSync(join(root, 'out/.nosql-drivers-'))

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
    rollupOptions: { external: [/^node:/, 'electron', 'ioredis', 'kafkajs'], output: { entryFileNames: 'nosql.cjs' } },
    lib: { entry: resolve(root, 'tests/nosql-entry.ts'), formats: ['cjs'] }
  }
})

const mod = await import(pathToFileURL(join(outDir, 'nosql.cjs')).href)

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

const BROWSE_ONLY_METHODS = [
  'query', 'executeStatement', 'explain', 'applyEdits', 'insertRow', 'deleteRows',
  'importBatch', 'countRows', 'fetchCellValue', 'fetchResultPage',
  'createTable', 'dropTable', 'createView', 'dropView', 'renameTable',
  'commitTransaction', 'rollbackTransaction', 'describeTable'
]

async function expectUnsupported(adapter, method) {
  try {
    await adapter[method]()
    return null
  } catch (error) {
    return error
  }
}

console.log('\n[1] 注册表')
const dialects = mod.listDialects()
check('五个方言都注册了', dialects.map((d) => d.id).join(',') === 'sqlite,postgresql,redis,kafka,mysql', dialects.map((d) => d.id).join(','))
check('Redis 有 host/port 字段', dialects.find((d) => d.id === 'redis')?.fields.map((f) => f.key).includes('host'))
check('Kafka 有 brokers 字段', dialects.find((d) => d.id === 'kafka')?.fields.some((f) => f.key === 'brokers'))
/*
 * 引号规则契约（P6 更新）：
 *  - 只浏览方言（Redis/Kafka）没有标识符语义，沿用双引号占位，与 SQLite/PostgreSQL 一致；
 *  - MySQL 是真正的 SQL 方言，用自己的反引号；
 *  - 渲染进程的 pickQuotingRules 已改为**按当前连接的 dialectId** 取规则（见 grid.ts），
 *    不再要求"全应用所有方言一致"——那条旧前提会让加入反引号后排序被整体禁用。
 */
const browseKeys = dialects
  .filter((d) => ['sqlite', 'postgresql', 'redis', 'kafka'].includes(d.id))
  .map((d) => `${d.quoting.open}|${d.quoting.close}|${d.quoting.escape}`)
check('主流与只浏览方言引号一致（双引号占位）', new Set(browseKeys).size === 1, [...new Set(browseKeys)].join(' / '))
check('MySQL 用反引号', dialects.find((d) => d.id === 'mysql')?.quoting.open === '`', String(dialects.find((d) => d.id === 'mysql')?.quoting.open))

console.log('\n[2] 只浏览：SQL 方法必须 unsupported_method')
for (const [name, make] of [['Redis', mod.createRedisAdapter], ['Kafka', mod.createKafkaAdapter]]) {
  const adapter = make()
  let wrong = []
  for (const method of BROWSE_ONLY_METHODS) {
    const error = await expectUnsupported(adapter, method)
    if (error === null || error.code !== 'unsupported_method') wrong.push(`${method}=${error?.code ?? 'no-error'}`)
  }
  check(`${name} 的 ${BROWSE_ONLY_METHODS.length} 个 SQL/编辑方法全部拒绝`, wrong.length === 0, wrong.join(', '))
  const cancel = await adapter.cancelQuery()
  check(`${name} cancelQuery 返回 false（没有可取消的语句）`, cancel === false)
  const state = await adapter.transactionState()
  check(`${name} 事务状态恒为无事务`, state.active === false && state.pendingAffected === 0)
  await adapter.closeCursor('anything') // 幂等，不应抛
  check(`${name} closeCursor 幂等`, true)
  try {
    await adapter.listChildren(null)
    check(`${name} 未连接时 listChildren 报 not_connected`, false)
  } catch (error) {
    check(`${name} 未连接时 listChildren 报 not_connected`, error.code === 'not_connected', error.code)
  }
}

console.log('\n[3] 节点 id 往返')
const redisIds = [
  ['db:0', { kind: 'db', db: 0 }],
  ['db:15', { kind: 'db', db: 15 }],
  ['key:3:user:1', { kind: 'key', db: 3, key: 'user:1' }],
  ['key:0:含 空格 和: 冒号', { kind: 'key', db: 0, key: '含 空格 和: 冒号' }]
]
const sameFields = (parsed, expected) =>
  parsed !== null && Object.entries(expected).every(([k, v]) => parsed[k] === v)
for (const [id, expected] of redisIds) {
  const parsed = mod.parseRedisNodeId(id)
  check(`Redis id 解析 ${id}`, sameFields(parsed, expected), JSON.stringify(parsed))
}
check('Redis 坏 id 返回 null', mod.parseRedisNodeId('nope') === null)
check('Redis key id 往返', mod.parseRedisNodeId(mod.keyNodeId(2, 'a:b'))?.key === 'a:b')

const kafkaIds = [
  ['topic:orders', { kind: 'topic', topic: 'orders' }],
  ['partition:3:orders', { kind: 'partition', topic: 'orders', partition: 3 }],
  ['partition:0:ns.topic-with.dots', { kind: 'partition', topic: 'ns.topic-with.dots', partition: 0 }]
]
for (const [id, expected] of kafkaIds) {
  const parsed = mod.parseKafkaNodeId(id)
  check(`Kafka id 解析 ${id}`, sameFields(parsed, expected), JSON.stringify(parsed))
}
check('Kafka 坏 id 返回 null', mod.parseKafkaNodeId('nope') === null)

console.log('\n[4] 参数校验（必须在发网络请求之前拒绝）')
const badCases = [
  ['brokers 为空', () => mod.buildKafkaConfig({ dialectId: 'kafka', name: 'k', options: { brokers: '' } }, {})],
  ['brokers 缺端口', () => mod.buildKafkaConfig({ dialectId: 'kafka', name: 'k', options: { brokers: 'localhost' } }, {})],
  ['brokers 端口越界', () => mod.buildKafkaConfig({ dialectId: 'kafka', name: 'k', options: { brokers: 'localhost:99999' } }, {})],
  ['SASL 缺用户名', () => mod.buildKafkaConfig({ dialectId: 'kafka', name: 'k', options: { brokers: 'a:9092', saslMechanism: 'plain' } }, {})],
  ['SASL 未知机制', () => mod.buildKafkaConfig({ dialectId: 'kafka', name: 'k', options: { brokers: 'a:9092', saslMechanism: 'oauth' } }, {})],
  ['Redis 主机为空', () => mod.buildRedisOptions({ dialectId: 'redis', name: 'r', options: { host: '' } }, {})],
  ['Redis 端口非法', () => mod.buildRedisOptions({ dialectId: 'redis', name: 'r', options: { host: 'h', port: '0' } }, {})]
]
for (const [label, run] of badCases) {
  try {
    run()
    check(`${label} 被拒绝`, false)
  } catch (error) {
    check(`${label} 被拒绝`, error.code === 'bad_params', `${error.code}: ${error.message}`)
  }
}
const goodKafka = mod.buildKafkaConfig({ dialectId: 'kafka', name: 'k', options: { brokers: 'a:9092, b:9093', clientId: 'x' } }, {})
check('合法 brokers 解析成两段', goodKafka.brokers.join('|') === 'a:9092|b:9093', goodKafka.brokers.join('|'))
const scram = mod.buildKafkaConfig({ dialectId: 'kafka', name: 'k', options: { brokers: 'a:9092', saslMechanism: 'scram-sha-256', user: 'u' } }, { dbPassword: 'p' })
check('SASL 配置带上机制与凭据', scram.sasl?.mechanism === 'scram-sha-256' && scram.sasl.username === 'u' && scram.sasl.password === 'p')

console.log('\n[5] 连不上时 testConnection 返回可读失败（不抛、不挂）')
const started = Date.now()
const redisFail = await mod.createRedisAdapter().testConnection(
  { dialectId: 'redis', name: 'r', options: { host: '127.0.0.1', port: 1 } }, {}
)
check('Redis 失败返回 ok:false 且有原因', redisFail.ok === false && /Redis 连接失败/.test(redisFail.message ?? ''), redisFail.message)
check('Redis 失败在 10 秒内返回', Date.now() - started < 10_000, `${Date.now() - started}ms`)
const kafkaFail = await mod.createKafkaAdapter().testConnection(
  { dialectId: 'kafka', name: 'k', options: { brokers: '127.0.0.1:1' } },
  {}
)
check('Kafka 失败返回 ok:false 且有原因', kafkaFail.ok === false && /Kafka 连接失败/.test(kafkaFail.message ?? ''), kafkaFail.message)

console.log('\n[6] 驱动宿主能加载这两个方言并握手')
async function handshake(dialectId) {
  const child = spawn(process.execPath, [hostEntry, '--dialect', dialectId], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const first = await new Promise((resolveFirst, rejectFirst) => {
    const timer = setTimeout(() => rejectFirst(new Error(`${dialectId} 宿主 10 秒内没有握手`)), 10_000)
    lines.once('line', (line) => {
      clearTimeout(timer)
      resolveFirst(line)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      rejectFirst(new Error(`${dialectId} 宿主提前退出，code=${code}`))
    })
  })
  child.stdin.end()
  child.kill()
  return JSON.parse(first)
}
for (const dialectId of ['redis', 'kafka']) {
  try {
    const frame = await handshake(dialectId)
    check(`${dialectId} 宿主握手方言一致`, frame.kind === 'handshake' && frame.dialectId === dialectId, JSON.stringify(frame))
  } catch (error) {
    check(`${dialectId} 宿主握手`, false, error.message)
  }
}

rmSync(outDir, { recursive: true, force: true })
console.log(`\nRedis/Kafka 契约 ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
