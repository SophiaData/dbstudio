/**
 * P3.1 结构元数据契约测试。
 *
 * ============================================================================
 * 这个文件验的是**契约**，不是某个驱动的实现
 * ============================================================================
 *
 * P3.1 的核心决定是：**元数据挂在 describeTable 的返回值上，不新增 RPC**。
 * 这个决定带来两条必须被钉住的性质：
 *
 *   1. **向后兼容**：旧驱动只返回 `{ id, columns, hasUniqueKey }` 依然合法，
 *      新字段全是 undefined，UI 必须显示"不支持"而不是"无"。
 *   2. **三态可辨**：undefined（不知道）/ 空数组（确定没有）/ 非空（有）
 *      必须能被区分——把它们混同会让用户以为表真的没有外键，
 *      然后写出孤儿数据。这是本契约最容易被后人破坏的一点。
 *
 * 因此测试分三段：
 *   A. 纯契约语义（metadataAvailability 的三态）；
 *   B. **编译期**兼容性——旧式 TableDescription 必须能通过编译；
 *   C. **真实链路**——通过真实 driver-host 走 describeTable，
 *      验证 SQLite 真的把外键/索引/约束/触发器带回来了。
 *
 * 运行：node tests/e2e-metadata-contract.mjs
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')
const modulePath = root.replace(/\\/g, '/')

const results = []

function check(name, condition, detail) {
  const passed = Boolean(condition)
  results.push({ name, passed })
  if (passed) {
    console.log(`PASS  ${name}`)
  } else {
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log(`      ↳ ${formatDetail(detail)}`)
  }
  return passed
}

function formatDetail(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// 契约模块探针：用 vite 把 TS 打成 CJS 后 import
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'dbstudio-metadata-contract-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir: work,
    target: 'node22',
    ssr: true,
    minify: false,
    lib: { entry: resolve(root, 'src/core/metadata.ts'), formats: ['cjs'] },
    rollupOptions: {
      external: [/^node:/],
      output: { entryFileNames: 'metadata.cjs' }
    }
  }
})

const contract = await import(pathToFileURL(join(work, 'metadata.cjs')).href)

// ---------------------------------------------------------------------------
// A. 纯契约语义
// ---------------------------------------------------------------------------

check(
  'A1. metadataAvailability(undefined) === "unavailable"',
  contract.metadataAvailability(undefined) === 'unavailable',
  contract.metadataAvailability(undefined)
)

check(
  'A2. metadataAvailability([]) === "empty"',
  contract.metadataAvailability([]) === 'empty',
  contract.metadataAvailability([])
)

check(
  'A3. metadataAvailability([{...}]) === "present"',
  contract.metadataAvailability([{ name: 'x' }]) === 'present',
  contract.metadataAvailability([{ name: 'x' }])
)

check(
  'A4. undefined 与空数组得到不同结果（UI 不能把两者混同）',
  contract.metadataAvailability(undefined) !== contract.metadataAvailability([])
)

check(
  'A5. metadataAvailability 接受 readonly 数组',
  contract.metadataAvailability(Object.freeze([1])) === 'present'
)

// ---------------------------------------------------------------------------
// B. 编译期兼容性
// ---------------------------------------------------------------------------

/**
 * 编译探针：把一段 TS 写进临时目录，用 tsc 编译它。
 *
 * 为什么要真的编译，而不是只写运行时断言：
 * "旧驱动仍可返回已有 TableDescription" 这条保证，**本质是类型层面的保证**。
 * 运行时断言证明不了"少字段的对象仍然类型合法"——那正是 TS 的职责。
 */
function compileProbe(name, source) {
  const dir = mkdtempSync(join(tmpdir(), `dbstudio-metadata-probe-${name}-`))
  try {
    const file = join(dir, 'probe.ts')
    writeFileSync(file, source, 'utf8')
    try {
      execFileSync(
        process.execPath,
        [
          resolve(root, 'node_modules/typescript/bin/tsc'),
          '--noEmit',
          '--strict',
          '--target',
          'es2022',
          '--module',
          'esnext',
          '--moduleResolution',
          'bundler',
          '--skipLibCheck',
          file
        ],
        { cwd: root, stdio: 'pipe', encoding: 'utf8' }
      )
      return { ok: true, output: '' }
    } catch (thrown) {
      return {
        ok: false,
        output: `${thrown.stdout ?? ''}${thrown.stderr ?? ''}`
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const legacyProbe = compileProbe(
  'legacy',
  `
import type { TableDescription } from '${modulePath}/src/core/model'

// 旧驱动的返回形状：只有 id / columns / hasUniqueKey。
export const legacy: TableDescription = {
  id: 'table:users',
  columns: [
    { name: 'id', typeName: 'INTEGER', nullable: false, primaryKeyOrdinal: 1, defaultValue: null }
  ],
  hasUniqueKey: true
}
`
)
check(
  'B1. 旧式 TableDescription（无元数据字段）仍然编译通过',
  legacyProbe.ok,
  legacyProbe.output
)

const fullProbe = compileProbe(
  'full',
  `
import type { TableDescription } from '${modulePath}/src/core/model'

export const full: TableDescription = {
  id: 'table:orders',
  columns: [],
  hasUniqueKey: false,
  uniqueConstraints: [{ name: null, columns: ['tenant_id', 'code'] }],
  foreignKeys: [
    {
      name: 'fk_orders_customer',
      columns: ['customer_id'],
      referencedSchema: null,
      referencedTable: 'customers',
      referencedColumns: ['id'],
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    }
  ],
  indexes: [
    { name: 'idx_orders_customer', unique: false, columns: ['customer_id'], predicate: null, expression: null }
  ],
  checks: [{ name: null, expression: 'qty >= 0' }],
  triggers: [
    { name: 'trg_orders_ai', timing: 'AFTER', event: 'INSERT', statement: 'SELECT 1;', enabled: true }
  ]
}
`
)
check('B2. 携带全部五个元数据字段的 TableDescription 编译通过', fullProbe.ok, fullProbe.output)

const badTimingProbe = compileProbe(
  'bad-timing',
  `
import type { TableDescription } from '${modulePath}/src/core/model'

export const bad: TableDescription = {
  id: 'table:t',
  columns: [],
  hasUniqueKey: false,
  triggers: [{ name: 'x', timing: 'BEFOREISH', event: 'INSERT', statement: '', enabled: true }]
}
`
)
check(
  'B3. 非法的 trigger timing 被类型系统拒绝（不是运行时才炸）',
  !badTimingProbe.ok,
  badTimingProbe.output
)

const requiredProbe = compileProbe(
  'required',
  `
import type { ForeignKeyDescription, IndexDescription } from '${modulePath}/src/core/metadata'

export const fk: ForeignKeyDescription = {
  columns: ['a'],
  referencedTable: 't',
  referencedColumns: ['b']
}

export const idx: IndexDescription = {
  unique: true,
  columns: ['a'],
  predicate: null,
  expression: null
}
`
)
check(
  'B4. ForeignKeyDescription.referencedTable 与 IndexDescription.name 是必填',
  !requiredProbe.ok,
  requiredProbe.output
)

const capabilityProbe = compileProbe(
  'capability',
  `
import type { DriverCapabilities } from '${modulePath}/src/core/model'

export const legacyCaps: DriverCapabilities = {
  supportsInlineEdit: true,
  supportsServerPagination: true,
  hasCatalog: false,
  hasSchema: false,
  supportsCancel: false
}

export const withMetadata: DriverCapabilities = {
  supportsInlineEdit: true,
  supportsServerPagination: true,
  hasCatalog: false,
  hasSchema: false,
  supportsCancel: false,
  metadata: {
    foreignKeys: true,
    indexes: true,
    uniqueConstraints: true,
    checkConstraints: false,
    triggers: false
  }
}
`
)
check(
  'B5. DriverCapabilities.metadata 是可选的（旧驱动不声明也合法）',
  capabilityProbe.ok,
  capabilityProbe.output
)

const columnIdentityProbe = compileProbe(
  'column-identity',
  `
import type { ColumnDescription } from '${modulePath}/src/core/model'

export const legacy: ColumnDescription = {
  name: 'id',
  typeName: 'INTEGER',
  nullable: false,
  primaryKeyOrdinal: 1,
  defaultValue: null
}

export const notIdentity: ColumnDescription = { ...legacy, identity: null }
export const always: ColumnDescription = { ...legacy, identity: 'always' }
export const byDefault: ColumnDescription = { ...legacy, identity: 'by-default' }
`
)
check(
  'B6. ColumnDescription.identity 支持 undefined/null/always/by-default',
  columnIdentityProbe.ok,
  columnIdentityProbe.output
)

const badColumnIdentityProbe = compileProbe(
  'bad-column-identity',
  `
import type { ColumnDescription } from '${modulePath}/src/core/model'

export const bad: ColumnDescription = {
  name: 'id',
  typeName: 'INTEGER',
  nullable: false,
  primaryKeyOrdinal: 1,
  defaultValue: null,
  identity: 'sometimes'
}
`
)
check(
  'B7. 非法的 ColumnDescription.identity 被类型系统拒绝',
  !badColumnIdentityProbe.ok,
  badColumnIdentityProbe.output
)

// ---------------------------------------------------------------------------
// C. 真实链路：describeTable 必须把元数据带回来
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 15_000

/**
 * 最小 driver-host 客户端。
 *
 * 为什么自己写而不用仓库里已有的辅助：那些辅助都绑定在固定夹具库上，
 * 而本测试需要一张**带外键/索引/CHECK/触发器**的专用库。
 */
class HostClient {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.events = []
    this.exited = false

    createInterface({ input: child.stdout }).on('line', (line) => {
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        return
      }
      if (typeof frame?.id === 'number') {
        const entry = this.pending.get(frame.id)
        if (entry !== undefined) {
          this.pending.delete(frame.id)
          clearTimeout(entry.timer)
          entry.resolve(frame)
        }
        return
      }
      this.events.push(frame)
    })

    child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk)
    })
    child.on('exit', () => {
      this.exited = true
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`驱动宿主已退出：${this.stderr.slice(-300)}`))
      }
      this.pending.clear()
    })
  }

  call(method, params) {
    const id = this.nextId++
    const frame = { id, method }
    if (params !== undefined) frame.params = params

    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new Error(`RPC 超时：${method}`))
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
      this.child.stdin.write(`${JSON.stringify(frame)}\n`)
    })
  }

  async callOk(method, params) {
    const frame = await this.call(method, params)
    if (frame.ok !== true) {
      throw new Error(`RPC ${method} 失败：${formatDetail(frame.error)}`)
    }
    return frame.result
  }
}

const dbDir = mkdtempSync(join(tmpdir(), 'dbstudio-metadata-db-'))
const dbPath = join(dbDir, 'metadata.db')
{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE parent (
      tenant_id INTEGER NOT NULL,
      id INTEGER NOT NULL,
      code TEXT NOT NULL,
      PRIMARY KEY (tenant_id, id),
      UNIQUE (tenant_id, code)
    );

    CREATE TABLE child (
      tenant_id INTEGER NOT NULL,
      id INTEGER NOT NULL,
      parent_tenant_id INTEGER NOT NULL,
      parent_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
      PRIMARY KEY (tenant_id, id),
      CONSTRAINT qty_not_42 CHECK (qty != 42),
      FOREIGN KEY (parent_tenant_id, parent_id)
        REFERENCES parent
        ON UPDATE CASCADE
        ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX idx_child_name ON child(name);
    CREATE INDEX idx_child_lower ON child(lower(name));

    CREATE TRIGGER trg_child_ai
      AFTER INSERT ON child
      FOR EACH ROW
    BEGIN
      UPDATE child SET name = trim(NEW.name);
    END;

    CREATE TABLE lonely (id INTEGER PRIMARY KEY, payload TEXT);
  `)
  db.close()
}

const host = new HostClient(
  spawn(process.execPath, [hostEntry, '--dialect', 'sqlite'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
  })
)

try {
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('等待 handshake 超时')), RPC_TIMEOUT_MS)
    const tick = setInterval(() => {
      if (host.events.some((event) => event.kind === 'handshake')) {
        clearInterval(tick)
        clearTimeout(timer)
        resolvePromise()
      } else if (host.exited) {
        clearInterval(tick)
        clearTimeout(timer)
        rejectPromise(new Error(`宿主提前退出：${host.stderr.slice(-300)}`))
      }
    }, 20)
  })

  // connect 的返回值就是 DriverCapabilities（宿主不回单独的 capabilities 方法）。
  const capabilities = await host.callOk('connect', {
    config: { dialectId: 'sqlite', options: { file: dbPath } },
    secret: undefined
  })

  check(
    'C1. SQLite 声明了元数据能力',
    capabilities?.metadata?.foreignKeys === true &&
      capabilities?.metadata?.indexes === true &&
      capabilities?.metadata?.uniqueConstraints === true &&
      capabilities?.metadata?.checkConstraints === true &&
      capabilities?.metadata?.triggers === true,
    capabilities?.metadata
  )

  const child = await host.callOk('describeTable', { id: 'table:child' })

  check('C2. describeTable 返回 foreignKeys 数组', Array.isArray(child?.foreignKeys), child?.foreignKeys)
  check(
    'C3. 复合外键的列顺序被保留',
    Array.isArray(child?.foreignKeys) &&
      child.foreignKeys.length === 1 &&
      child.foreignKeys[0].columns.join(',') === 'parent_tenant_id,parent_id',
    child?.foreignKeys?.[0]?.columns
  )
  check(
    'C4. 复合外键解析出父表复合主键',
    child?.foreignKeys?.[0]?.referencedColumns?.join(',') === 'tenant_id,id',
    child?.foreignKeys?.[0]?.referencedColumns
  )
  check(
    'C5. 外键带出 ON UPDATE / ON DELETE',
    child?.foreignKeys?.[0]?.onUpdate === 'CASCADE' &&
      child?.foreignKeys?.[0]?.onDelete === 'SET NULL',
    child?.foreignKeys?.[0]
  )
  check(
    'C6. SQLite 不暴露外键名，name 为 null（而不是空串）',
    child?.foreignKeys?.[0]?.name === null,
    child?.foreignKeys?.[0]?.name
  )

  check('C7. describeTable 返回 indexes 数组', Array.isArray(child?.indexes), child?.indexes)
  check(
    'C8. 唯一索引被标记 unique',
    child?.indexes?.some((index) => index.name === 'idx_child_name' && index.unique === true),
    child?.indexes
  )
  check(
    'C9. 普通索引被标记为非唯一',
    child?.indexes?.some((index) => index.name === 'idx_child_lower' && index.unique === false),
    child?.indexes
  )
  check(
    'C10. 表达式索引的 columns 为空、expression 承载表达式',
    child?.indexes?.some(
      (index) =>
        index.name === 'idx_child_lower' &&
        Array.isArray(index.columns) &&
        index.columns.length === 0 &&
        typeof index.expression === 'string' &&
        index.expression.includes('lower')
    ),
    child?.indexes?.find((index) => index.name === 'idx_child_lower')
  )

  check(
    'C11. 复合唯一约束被读出且保序',
    Array.isArray(child?.uniqueConstraints) &&
      child.uniqueConstraints.some((constraint) => constraint.columns.join(',') === 'tenant_id,id'),
    child?.uniqueConstraints
  )

  check(
    'C12. CHECK 约束被读出',
    Array.isArray(child?.checks) && child.checks.some((item) => item.expression.includes('qty >= 0')),
    child?.checks
  )

  check(
    'C13. 触发器被读出，且带出触发体而不是整条 CREATE',
    Array.isArray(child?.triggers) &&
      child.triggers.some(
        (trigger) =>
          trigger.name === 'trg_child_ai' &&
          trigger.timing === 'AFTER' &&
          trigger.event === 'INSERT' &&
          trigger.statement.includes('trim(NEW.name)') &&
          !trigger.statement.includes('CREATE TRIGGER')
      ),
    child?.triggers
  )

  const lonely = await host.callOk('describeTable', { id: 'table:lonely' })
  check(
    'C14. 没有任何关系的表返回空数组（不是 undefined）',
    Array.isArray(lonely?.foreignKeys) &&
      lonely.foreignKeys.length === 0 &&
      Array.isArray(lonely?.indexes) &&
      lonely.indexes.length === 0,
    { foreignKeys: lonely?.foreignKeys, indexes: lonely?.indexes }
  )
  check(
    'C15. 空数组在契约里是 "empty" 而不是 "unavailable"',
    contract.metadataAvailability(lonely?.foreignKeys) === 'empty',
    contract.metadataAvailability(lonely?.foreignKeys)
  )

  check(
    'C16. 旧字段仍然完好（向后兼容）',
    child?.hasUniqueKey === true &&
      Array.isArray(child?.columns) &&
      child.columns.length === 6 &&
      child.id === 'table:child',
    { id: child?.id, hasUniqueKey: child?.hasUniqueKey, columns: child?.columns?.length }
  )
} catch (thrown) {
  check('C0. 真实 driver-host 链路跑通', false, thrown?.message ?? String(thrown))
} finally {
  host.child.stdin.end()
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      host.child.kill('SIGKILL')
      resolvePromise()
    }, 5000)
    host.child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
  rmSync(dbDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const passed = results.filter((entry) => entry.passed).length
const failed = results.length - passed
console.log('')
console.log('═'.repeat(70))
console.log(`元数据契约：${passed} 通过 / ${failed} 失败 / 共 ${results.length}`)
console.log('═'.repeat(70))

if (failed > 0) {
  for (const entry of results.filter((item) => !item.passed)) {
    console.log(`  ✗ ${entry.name}`)
  }
  process.exitCode = 1
}
