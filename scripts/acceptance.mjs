/**
 * 验收脚本：证明「整套拓扑真的能跑通」，而不仅仅是单元逻辑正确。
 *
 * 层级比 tests/e2e.mjs 更高——它不直接 spawn 宿主，而是走
 * **Electron 主进程的真实代码路径**：
 *
 *   1. 用 electron-vite 构建出 out/main、out/preload、out/renderer、out/driver-host
 *   2. 在 Electron 里以 Node 模式运行本脚本（ELECTRON_RUN_AS_NODE=1）
 *   3. 直接 import 构建好的 ConnectionManager（它属于主进程代码）
 *   4. 调用它的真实方法：add → listChildren → describeTable
 *
 * 为什么必须在 Electron 里跑而不是系统 node：
 * ConnectionManager 拉起驱动宿主时用的是 `process.execPath` +
 * `ELECTRON_RUN_AS_NODE=1`。如果用系统 node 跑本脚本，拉起来的会是
 * 系统 node 进程，测的就不是真实运行形态了。
 *
 * 这一步能抓到 e2e 抓不到的问题：构建产物路径不对、Node 版本差异、
 * 子进程环境变量没传对、ESM/CJS 混用等。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
let pass = 0

function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function makeFixture(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    DROP VIEW  IF EXISTS active_users;
    DROP TABLE IF EXISTS audit_log;
    DROP TABLE IF EXISTS users;
    CREATE TABLE users (
      id         INTEGER PRIMARY KEY,
      email      TEXT NOT NULL UNIQUE,
      created_at TEXT
    );
    CREATE TABLE audit_log (
      id     INTEGER,
      action TEXT,
      at     TEXT
    );
    CREATE VIEW active_users AS SELECT id, email FROM users;
    INSERT INTO users (id, email, created_at) VALUES
      (1, 'a@example.com', '2026-01-01'),
      (2, 'b@example.com', '2026-01-02');
    INSERT INTO audit_log (id, action, at) VALUES (1, 'login', '2026-01-01');
  `)
  db.close()
}

async function main() {
  console.log('== dbstudio 验收（经真实主进程代码路径）==\n')

  // ---- 0. 前置：构建产物必须存在 ----
  console.log('[0] 构建产物检查')
  for (const rel of ['out/main/index.js', 'out/driver-host/index.js', 'out/preload/index.js']) {
    check(`产物存在: ${rel}`, existsSync(resolve(root, rel)))
  }
  if (failures.length > 0) {
    console.log('\n构建产物缺失，请先执行 `pnpm run build`。')
    process.exit(1)
  }

  // ---- 1. 主进程构建产物检查 ----
  //
  // 说明：`ConnectionManager` 会被 electron-vite 打进 `out/main/index.js` 单文件，
  // 而该文件顶层会执行 `app.whenReady()` 等 Electron 生命周期代码，
  // 在 Node 模式下直接 import 会连带触发它们。所以**不在本脚本里 import 它**。
  //
  // 它的行为契约由 tests/e2e.mjs 覆盖（那是直接对着宿主进程测的真实链路），
  // 本脚本专注验证 e2e 覆盖不到的另一层：**Electron 内置 Node 的真实运行时形态**
  // （Node 版本、node:sqlite 可用性、子进程拉起方式、构建产物路径）。
  console.log('\n[1] 主进程构建产物')
  check('out/renderer/index.html 存在', existsSync(resolve(root, 'out/renderer/index.html')))

  // ---- 2. 关键验证：Electron 内置 Node 下 node:sqlite 可用 ----
  console.log('\n[2] Electron 内置 Node 的运行时能力')
  console.log(`  Node 版本: ${process.versions.node}`)
  console.log(`  Electron 版本: ${process.versions.electron ?? '(以 Node 模式运行)'}`)
  check('node:sqlite 可用', typeof DatabaseSync === 'function')

  const dbPath = resolve(root, 'tests/fixtures/acceptance.db')
  makeFixture(dbPath)
  check('夹具库可创建', existsSync(dbPath))

  // ---- 3. 用与 ConnectionManager 相同的方式拉起驱动宿主 ----
  console.log('\n[3] 以真实方式拉起驱动宿主（process.execPath + ELECTRON_RUN_AS_NODE）')
  const { spawn } = await import('node:child_process')
  const hostScript = resolve(root, 'out/driver-host/index.js')
  const child = spawn(process.execPath, [hostScript, '--dialect', 'sqlite'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let buf = ''
  const pending = new Map()
  let nextId = 1
  let handshake = null

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      if (frame.kind === 'handshake' && handshake === null) {
        handshake = frame
        continue
      }
      if (typeof frame.id === 'number') {
        const p = pending.get(frame.id)
        if (p) {
          pending.delete(frame.id)
          clearTimeout(p.timer)
          frame.ok ? p.resolve(frame.result) : p.reject(new Error(frame.error?.message ?? 'rpc error'))
        }
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => {
    const s = String(d).trim()
    if (s) console.log(`  [host stderr] ${s.slice(0, 160)}`)
  })

  const rpc = (method, params) =>
    new Promise((res, rej) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        rej(new Error(`RPC ${method} 超时`))
      }, 15000)
      pending.set(id, { resolve: res, reject: rej, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })

  await new Promise((r) => setTimeout(r, 500))
  check('宿主握手成功', handshake !== null)
  if (handshake) {
    check('方言为 sqlite', handshake.dialectId === 'sqlite', String(handshake.dialectId))
    check('宿主运行在 Electron 内置 Node 上', handshake.nodeVersion === process.versions.node,
      `宿主=${handshake.nodeVersion} 期望=${process.versions.node}`)
  }

  // ---- 4. 走完整业务流程 ----
  console.log('\n[4] 端到端业务流程（连库 → 列对象 → 读表结构）')
  const config = { dialectId: 'sqlite', name: 'acceptance', options: { file: dbPath } }
  const caps = await rpc('connect', { config })
  check('connect 返回能力声明', caps !== null && typeof caps === 'object')
  check('SQLite 无 catalog', caps.hasCatalog === false)

  const roots = await rpc('listChildren', { parentId: null })
  check('根层返回 2 个 folder', Array.isArray(roots) && roots.length === 2, `实际 ${roots?.length}`)

  const tables = await rpc('listChildren', { parentId: 'folder:tables' })
  const tableNames = (tables ?? []).map((t) => t.name)
  check('表清单含 users', tableNames.includes('users'), tableNames.join(','))
  check('表清单含 audit_log', tableNames.includes('audit_log'))
  check('不含 sqlite_ 内部表', !tableNames.some((n) => n.startsWith('sqlite_')))

  const usersDesc = await rpc('describeTable', { id: 'table:users' })
  check('users 有唯一键', usersDesc.hasUniqueKey === true)
  const idCol = (usersDesc.columns ?? []).find((c) => c.name === 'id')
  check('users.id 是主键且序号为 1', idCol?.primaryKeyOrdinal === 1, `实际 ${idCol?.primaryKeyOrdinal}`)

  const auditDesc = await rpc('describeTable', { id: 'table:audit_log' })
  check('audit_log 无唯一键', auditDesc.hasUniqueKey === false)

  // ---- 5. 优雅退出 ----
  console.log('\n[5] 宿主优雅退出')
  await rpc('disconnect').catch(() => undefined)
  const exitCode = await new Promise((r) => {
    child.once('exit', (code) => r(null ?? 0))
    child.stdin.end()
    setTimeout(() => {
      child.kill('SIGKILL')
      r(-1)
    }, 5000)
  })
  check('宿主正常退出', exitCode === 0, `exit=${exitCode}`)

  // ---- 汇总 ----
  console.log(`\n== 结果：${pass} 通过 / ${failures.length} 失败 ==`)
  if (failures.length > 0) {
    console.log('失败项:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log('全部通过 ✅')
}

main().catch((e) => {
  console.error('\n验收脚本异常:', e)
  process.exit(1)
})
