/**
 * P3.2 PostgreSQL 结构元数据端到端测试。
 *
 * ============================================================================
 * 这个文件验的是**真实 PG 服务上的 catalog 读取**，不是 mock
 * ============================================================================
 *
 * 与 `tests/e2e-sqlite-metadata.mjs`（纯 Node + node:sqlite）的区别：
 * PG 的结构元数据只能从**真实服务端的 pg_catalog** 读，
 * 没有办法像 SQLite 那样在内存库里造一个等价环境。
 * 所以这个测试：
 *   1. 建一个**临时 schema**（带 pid 后缀），在里面造齐
 *      复合主键 / 复合外键 / 唯一索引 / 普通索引 / 部分索引 /
 *      表达式索引 / CHECK / 触发器 / 无关系表；
 *   2. 通过**真实 driver-host 进程**（`out/driver-host/index.js --dialect postgresql`）
 *      调 `describeTable`，验证契约字段真的被带回来了；
 *   3. **只清理自己创建的对象**——临时 schema 整个 DROP，
 *      不碰用户的 public schema，不删别人的表。
 *
 * ===== 没有 PG 环境时必须跳过，不能硬失败 =====
 *
 * `DBSTUDIO_PG_URL` 未设置 → 打印「跳过」并 exit 0。
 * 这是硬性要求：缺环境不算失败，假装验证过才是。
 *
 * 运行：
 *   node scripts/build-driver-host.mjs
 *   DBSTUDIO_PG_URL=postgres://user@127.0.0.1:5432/postgres node tests/e2e-postgresql-metadata.mjs
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')
const PG_URL = process.env['DBSTUDIO_PG_URL']

if (!PG_URL) {
  console.log('跳过：未配置 PG 连接（环境变量 DBSTUDIO_PG_URL）。')
  console.log('  SQLite 元数据回归仍然有效（node tests/e2e-sqlite-metadata.mjs）。')
  console.log('  要跑 PG 元数据测试：')
  console.log('    DBSTUDIO_PG_URL=postgres://user@127.0.0.1:5432/postgres node tests/e2e-postgresql-metadata.mjs')
  process.exit(0)
}

const RPC_TIMEOUT_MS = 20_000
const HANDSHAKE_TIMEOUT_MS = 15_000
const EXIT_TIMEOUT_MS = 10_000

/** 临时 schema 名。带上进程 id，避免与并发运行互相干扰。 */
const PROBE_SCHEMA = `dbstudio_meta_probe_${process.pid}`

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

function formatDetail(detail) {
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

// ---------------------------------------------------------------------------
// 宿主客户端（与 tests/e2e-postgres.mjs 同构）
// ---------------------------------------------------------------------------

class HostProcess {
  #child
  #pending = new Map()
  #events = []
  #exitInfo = null
  #nextId = 1
  #stderrLines = []

  constructor(child) {
    this.#child = child
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (line.trim().length === 0) return
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        this.#failAll(new Error(`协议流被污染: ${line.slice(0, 200)}`))
        return
      }
      if (typeof frame === 'object' && frame !== null && typeof frame.id === 'number') {
        const waiter = this.#pending.get(frame.id)
        if (waiter) {
          this.#pending.delete(frame.id)
          clearTimeout(waiter.timer)
          waiter.resolve(frame)
        }
        return
      }
      this.#events.push(frame)
    })
    const errRl = createInterface({ input: child.stderr, crlfDelay: Infinity })
    errRl.on('line', (line) => {
      this.#stderrLines.push(line)
      if (this.#stderrLines.length > 200) this.#stderrLines.shift()
    })
    child.on('exit', (code, signal) => {
      this.#exitInfo = { code, signal }
      this.#failAll(new Error(`宿主进程已退出（code=${code}, signal=${signal}）但仍有未完成请求`))
    })
  }

  #failAll(err) {
    for (const [id, waiter] of this.#pending) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
      this.#pending.delete(id)
    }
  }

  get stderrText() {
    return this.#stderrLines.join('\n')
  }

  waitForEvent(predicate, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    const existing = this.#events.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((res, rej) => {
      const startedAt = Date.now()
      const tick = setInterval(() => {
        const found = this.#events.find(predicate)
        if (found) {
          clearInterval(tick)
          res(found)
        } else if (this.#exitInfo) {
          clearInterval(tick)
          rej(new Error(`等待事件帧时宿主已退出（code=${this.#exitInfo.code}）`))
        } else if (Date.now() - startedAt > timeoutMs) {
          clearInterval(tick)
          rej(new Error(`等待事件帧超时（${timeoutMs}ms）`))
        }
      }, 20)
    })
  }

  call(method, params) {
    const id = this.#nextId++
    const frame = { id, method }
    if (params !== undefined) frame.params = params
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rej(
          new Error(
            `RPC 超时（${RPC_TIMEOUT_MS}ms）: ${method} id=${id}${
              this.stderrText ? `；stderr: ${this.stderrText.slice(-400)}` : ''
            }`
          )
        )
      }, RPC_TIMEOUT_MS)
      this.#pending.set(id, { resolve: res, reject: rej, timer })
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
    })
  }

  async close(timeoutMs = EXIT_TIMEOUT_MS) {
    if (this.#exitInfo) return this.#exitInfo.code
    this.#child.stdin.end()
    return new Promise((res) => {
      const timer = setTimeout(() => {
        this.#child.kill('SIGKILL')
        res('timeout')
      }, timeoutMs)
      this.#child.once('exit', (code) => {
        clearTimeout(timer)
        res(code)
      })
    })
  }
}

function launchHost(args) {
  return new HostProcess(spawn(process.execPath, [hostEntry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] }))
}

/** 把 DBSTUDIO_PG_URL 解析成 pg 的连接参数（供 adapter 的 options 用）。 */
function parsePgUrl(url) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: u.port === '' ? '5432' : u.port,
    database: decodeURIComponent(u.pathname.replace(/^\//, '') || 'postgres'),
    user: decodeURIComponent(u.username || 'postgres'),
    password: u.password === '' ? undefined : decodeURIComponent(u.password)
  }
}

// ---------------------------------------------------------------------------
// 夹具：临时 schema + 覆盖各类约束的表
// ---------------------------------------------------------------------------

/**
 * 建夹具。
 *
 * 覆盖的每一项都对应契约里的一个字段：
 *   - 复合主键 / 复合唯一约束 → uniqueConstraints
 *   - 复合外键                  → foreignKeys
 *   - 唯一索引 / 普通索引 / 部分索引 / 表达式索引 → indexes
 *   - CHECK                     → checks
 *   - BEFORE/AFTER/UPDATE OF/禁用 触发器 → triggers
 *   - 无任何关系的表            → 空数组（区别于 undefined）
 */
async function createFixture(client) {
  await client.query(`DROP SCHEMA IF EXISTS ${PROBE_SCHEMA} CASCADE`)
  await client.query(`CREATE SCHEMA ${PROBE_SCHEMA}`)

  // 被引用的父表：复合主键 + 复合唯一约束 + CHECK
  await client.query(`
    CREATE TABLE ${PROBE_SCHEMA}.parent (
      tenant_id int NOT NULL,
      id int NOT NULL,
      code text NOT NULL,
      qty int NOT NULL DEFAULT 0,
      CONSTRAINT parent_pkey PRIMARY KEY (tenant_id, id),
      CONSTRAINT parent_code_key UNIQUE (tenant_id, code),
      CONSTRAINT parent_qty_check CHECK (qty >= 0)
    )`)

  // 第二个父表：给第二个复合外键用
  await client.query(`
    CREATE TABLE ${PROBE_SCHEMA}.other_parent (
      tenant_id int NOT NULL,
      id int NOT NULL,
      CONSTRAINT other_parent_pkey PRIMARY KEY (tenant_id, id)
    )`)

  // 子表：复合外键 + 各类索引 + 触发器
  await client.query(`
    CREATE TABLE ${PROBE_SCHEMA}.child (
      id serial PRIMARY KEY,
      tenant_id int NOT NULL,
      parent_id int NOT NULL,
      other_tenant_id int NOT NULL,
      other_id int NOT NULL,
      name text NOT NULL,
      note text,
      qty int NOT NULL DEFAULT 0,
      CONSTRAINT child_parent_fk FOREIGN KEY (tenant_id, parent_id)
        REFERENCES ${PROBE_SCHEMA}.parent (tenant_id, id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
      CONSTRAINT child_other_fk FOREIGN KEY (other_tenant_id, other_id)
        REFERENCES ${PROBE_SCHEMA}.other_parent (tenant_id, id)
        ON DELETE SET NULL,
      CONSTRAINT child_qty_check CHECK (qty >= 0),
      CONSTRAINT child_name_unique UNIQUE (name)
    )`)

  // 唯一索引（非约束）
  await client.query(`CREATE UNIQUE INDEX child_name_uq ON ${PROBE_SCHEMA}.child (lower(name))`)
  // 普通索引
  await client.query(`CREATE INDEX child_tenant_idx ON ${PROBE_SCHEMA}.child (tenant_id)`)
  // 部分索引（带 predicate）
  await client.query(
    `CREATE INDEX child_note_partial ON ${PROBE_SCHEMA}.child (note) WHERE note IS NOT NULL AND note <> ''`
  )
  // 多列索引（覆盖复合列顺序）
  await client.query(`CREATE INDEX child_multi_idx ON ${PROBE_SCHEMA}.child (tenant_id, parent_id)`)

  // 触发器函数
  await client.query(`
    CREATE FUNCTION ${PROBE_SCHEMA}.child_trigger_fn() RETURNS trigger AS $$
    BEGIN
      NEW.note := 'touched';
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`)

  await client.query(`
    CREATE TRIGGER child_bi BEFORE INSERT ON ${PROBE_SCHEMA}.child
    FOR EACH ROW EXECUTE FUNCTION ${PROBE_SCHEMA}.child_trigger_fn()`)
  await client.query(`
    CREATE TRIGGER child_bu BEFORE UPDATE OF name, note ON ${PROBE_SCHEMA}.child
    FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
    EXECUTE FUNCTION ${PROBE_SCHEMA}.child_trigger_fn()`)
  await client.query(`
    CREATE TRIGGER child_ad AFTER DELETE ON ${PROBE_SCHEMA}.child
    FOR EACH ROW EXECUTE FUNCTION ${PROBE_SCHEMA}.child_trigger_fn()`)
  await client.query(`
    CREATE TRIGGER child_disabled AFTER INSERT ON ${PROBE_SCHEMA}.child
    FOR EACH ROW EXECUTE FUNCTION ${PROBE_SCHEMA}.child_trigger_fn()`)
  await client.query(`ALTER TABLE ${PROBE_SCHEMA}.child DISABLE TRIGGER child_disabled`)

  // 无任何关系的表：用来验证"确定没有"（空数组）而不是"不知道"（undefined）
  await client.query(`
    CREATE TABLE ${PROBE_SCHEMA}.plain (
      id int PRIMARY KEY,
      label text
    )`)

  // 视图：验证视图也能返回空数组而不是 undefined
  await client.query(`CREATE VIEW ${PROBE_SCHEMA}.plain_view AS SELECT id, label FROM ${PROBE_SCHEMA}.plain`)
}

async function dropFixture(client) {
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${PROBE_SCHEMA} CASCADE`)
  } catch {
    // 清理失败不应该让测试结论失真——但要让人看得见。
    console.warn(`  警告：临时 schema ${PROBE_SCHEMA} 清理失败，请手动清理。`)
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log('─'.repeat(70))
  console.log('P3.2 PostgreSQL 结构元数据：describeTable 契约')
  console.log(`      连接 ${PG_URL.replace(/:[^:@/]*@/, ':****@')}`)
  console.log(`      临时 schema ${PROBE_SCHEMA}`)
  console.log('─'.repeat(70))

  const info = parsePgUrl(PG_URL)
  const admin = new pg.Client({
    host: info.host,
    port: info.port,
    database: info.database,
    user: info.user,
    ...(info.password === undefined ? {} : { password: info.password })
  })
  await admin.connect()

  let host = null
  try {
    await createFixture(admin)

    host = launchHost(['--dialect', 'postgresql'])
    const handshake = await host.waitForEvent((f) => f.kind === 'handshake')
    check('1. 收到 handshake 帧（dialectId === postgresql）', handshake?.dialectId === 'postgresql', handshake)

    const conn = await host.call('connect', {
      config: {
        dialectId: 'postgresql',
        name: 'pg-metadata-probe',
        options: { host: info.host, port: info.port, database: info.database, user: info.user }
      },
      secret: info.password
    })
    if (conn.ok !== true) {
      check('2. connect 成功', false, formatDetail(conn.error))
      return
    }
    check(
      '2. connect 成功，能力声明含 metadata 五项全为 true',
      conn.result?.metadata?.foreignKeys === true &&
        conn.result?.metadata?.indexes === true &&
        conn.result?.metadata?.uniqueConstraints === true &&
        conn.result?.metadata?.checkConstraints === true &&
        conn.result?.metadata?.triggers === true,
      formatDetail(conn.result?.metadata)
    )

    // ---- 子表：元数据最全的一张 ----
    const childDesc = await host.call('describeTable', { id: `table:${PROBE_SCHEMA}.child` })
    if (childDesc.ok !== true) {
      check('3. describeTable 读取子表成功', false, formatDetail(childDesc.error))
      return
    }
    const child = childDesc.result
    check('3. describeTable 读取子表成功', true)

    // 3a. 原有行为不回归
    check(
      '3a. 列与主键行为不回归（id 是主键且 hasUniqueKey=true）',
      child.columns?.length === 8 &&
        child.columns.find((c) => c.name === 'id')?.primaryKeyOrdinal === 1 &&
        child.hasUniqueKey === true,
      formatDetail(child.columns)
    )

    // 3b. 复合外键
    const parentFk = (child.foreignKeys ?? []).find((fk) => fk.name === 'child_parent_fk')
    check(
      '3b. 复合外键按约束内顺序给出本表列与被引用列',
      parentFk !== undefined &&
        parentFk.columns.join(',') === 'tenant_id,parent_id' &&
        parentFk.referencedColumns.join(',') === 'tenant_id,id' &&
        parentFk.referencedTable === 'parent' &&
        parentFk.referencedSchema === null &&
        parentFk.onUpdate === 'RESTRICT' &&
        parentFk.onDelete === 'CASCADE',
      formatDetail(parentFk)
    )
    check(
      '3c. 第二个复合外键也被读到，ON DELETE SET NULL 正确',
      (child.foreignKeys ?? []).some(
        (fk) =>
          fk.name === 'child_other_fk' &&
          fk.columns.join(',') === 'other_tenant_id,other_id' &&
          fk.onDelete === 'SET NULL'
      ),
      formatDetail(child.foreignKeys)
    )
    check(
      '3d. 唯一约束来自 pg_constraint，不会把外键误当唯一约束',
      (child.uniqueConstraints ?? []).some((c) => c.name === 'child_name_unique') &&
        (child.uniqueConstraints ?? []).every((c) => c.name !== 'child_parent_fk'),
      formatDetail(child.uniqueConstraints)
    )

    // 3e. 索引
    const uniqueIdx = (child.indexes ?? []).find((i) => i.name === 'child_name_uq')
    const plainIdx = (child.indexes ?? []).find((i) => i.name === 'child_tenant_idx')
    const partialIdx = (child.indexes ?? []).find((i) => i.name === 'child_note_partial')
    const multiIdx = (child.indexes ?? []).find((i) => i.name === 'child_multi_idx')
    check(
      '3e. 表达式唯一索引：columns 置空、expression 保留原表达式、unique=true',
      uniqueIdx !== undefined &&
        uniqueIdx.unique === true &&
        Array.isArray(uniqueIdx.columns) &&
        uniqueIdx.columns.length === 0 &&
        typeof uniqueIdx.expression === 'string' &&
        uniqueIdx.expression.includes('lower(name)'),
      formatDetail(uniqueIdx)
    )
    check(
      '3f. 普通索引给出列名且 predicate 为 null',
      plainIdx !== undefined &&
        plainIdx.unique === false &&
        plainIdx.columns.join(',') === 'tenant_id' &&
        plainIdx.predicate === null,
      formatDetail(plainIdx)
    )
    check(
      '3g. 部分索引带 predicate 文本',
      partialIdx !== undefined &&
        typeof partialIdx.predicate === 'string' &&
        partialIdx.predicate.includes('note IS NOT NULL'),
      formatDetail(partialIdx)
    )
    check(
      '3h. 多列索引按索引内顺序给出列',
      multiIdx !== undefined && multiIdx.columns.join(',') === 'tenant_id,parent_id',
      formatDetail(multiIdx)
    )

    // 3i. CHECK
    const checkRows = child.checks ?? []
    check(
      '3i. CHECK 约束被读到且保留表达式文本',
      checkRows.length >= 1 &&
        checkRows.some((c) => typeof c.expression === 'string' && c.expression.includes('qty >= 0')),
      formatDetail(checkRows)
    )

    // 3j. 触发器
    const triggers = child.triggers ?? []
    const bi = triggers.find((t) => t.name === 'child_bi')
    const bu = triggers.find((t) => t.name === 'child_bu')
    const ad = triggers.find((t) => t.name === 'child_ad')
    const disabled = triggers.find((t) => t.name === 'child_disabled')
    check(
      '3j. BEFORE INSERT 触发器：timing/event 正确、语句体取自触发函数',
      bi !== undefined &&
        bi.timing === 'BEFORE' &&
        bi.event === 'INSERT' &&
        bi.enabled === true &&
        typeof bi.statement === 'string' &&
        bi.statement.includes('NEW.note'),
      formatDetail(bi)
    )
    check(
      '3k. UPDATE OF 触发器带出监听的列，且 WHEN 条件被切出',
      bu !== undefined &&
        bu.timing === 'BEFORE' &&
        bu.event === 'UPDATE' &&
        bu.updateOf.join(',') === 'name,note' &&
        typeof bu.when === 'string' &&
        bu.when.includes('old.name IS DISTINCT FROM new.name'),
      formatDetail(bu)
    )
    check(
      '3l. AFTER DELETE 触发器（PG 没有 AFTER 位，时机位全 0 即 AFTER）',
      ad !== undefined && ad.timing === 'AFTER' && ad.event === 'DELETE',
      formatDetail(ad)
    )
    check(
      '3m. 被禁用的触发器 enabled=false',
      disabled !== undefined && disabled.enabled === false,
      formatDetail(disabled)
    )
    check(
      '3n. 外键的内部 RI 触发器不被当作用户触发器返回',
      !triggers.some((t) => t.name.includes('RI_')),
      formatDetail(triggers.map((t) => t.name))
    )

    // ---- 父表：复合主键 / 复合唯一约束 ----
    const parentDesc = await host.call('describeTable', { id: `table:${PROBE_SCHEMA}.parent` })
    const parent = parentDesc.result
    check(
      '4. 复合主键与复合唯一约束都被读到，列顺序保持',
      parent?.uniqueConstraints?.some(
        (c) => c.name === 'parent_pkey' && c.columns.join(',') === 'tenant_id,id'
      ) === true &&
        parent?.uniqueConstraints?.some(
          (c) => c.name === 'parent_code_key' && c.columns.join(',') === 'tenant_id,code'
        ) === true,
      formatDetail(parent?.uniqueConstraints)
    )
    check(
      '4a. 父表没有外键时返回空数组（确定没有），不是 undefined',
      Array.isArray(parent?.foreignKeys) && parent.foreignKeys.length === 0,
      formatDetail(parent?.foreignKeys)
    )

    // ---- 无关系表 ----
    const plainDesc = await host.call('describeTable', { id: `table:${PROBE_SCHEMA}.plain` })
    const plain = plainDesc.result
    check(
      '5. 无关系表：五类元数据都是空数组（三态中的 "empty"）',
      Array.isArray(plain?.foreignKeys) &&
        plain.foreignKeys.length === 0 &&
        Array.isArray(plain?.indexes) &&
        Array.isArray(plain?.uniqueConstraints) &&
        Array.isArray(plain?.checks) &&
        Array.isArray(plain?.triggers),
      formatDetail({
        foreignKeys: plain?.foreignKeys,
        indexes: plain?.indexes?.length,
        uniqueConstraints: plain?.uniqueConstraints,
        checks: plain?.checks,
        triggers: plain?.triggers
      })
    )

    // ---- 视图 ----
    const viewDesc = await host.call('describeTable', { id: `view:${PROBE_SCHEMA}.plain_view` })
    const view = viewDesc.result
    check(
      '6. 视图也返回空数组而不是 undefined',
      Array.isArray(view?.foreignKeys) && view.foreignKeys.length === 0 && view.columns?.length === 2,
      formatDetail({ foreignKeys: view?.foreignKeys, columns: view?.columns?.length })
    )

    // ---- 参数化：名字里带引号/分号的 schema 不该造成注入 ----
    // 标识符在 DDL 里无法参数化，只能按 PG 规则加引号（内部 " 翻倍）；
    // 但**读**路径必须走 $1/$2 参数——这里验证的正是读路径。
    const hostileRaw = `dbstudio_"quoted";drop_${process.pid}`
    const hostile = `"${hostileRaw.replace(/"/g, '""')}"`
    await admin.query(`CREATE SCHEMA ${hostile}`)
    await admin.query(`CREATE TABLE ${hostile}.t (id int PRIMARY KEY)`)
    const hostileDesc = await host.call('describeTable', { id: `table:${hostileRaw}.t` })
    check(
      '7. 含双引号与分号的 schema 名被正确参数化，不产生注入',
      hostileDesc.ok === true && hostileDesc.result?.columns?.length === 1,
      formatDetail(hostileDesc.error ?? hostileDesc.result?.columns)
    )
    await admin.query(`DROP SCHEMA ${hostile} CASCADE`)
  } finally {
    if (host !== null) await host.close()
    await dropFixture(admin)
    await admin.end()
  }

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length
  console.log('─'.repeat(70))
  console.log(`选中 ${results.length} / 通过 ${passed} / 失败 ${failed}`)
  if (failed > 0) {
    console.log('失败项：')
    for (const item of results.filter((r) => !r.passed)) console.log(`  - ${item.name}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('测试异常终止：', error)
  process.exitCode = 1
})
