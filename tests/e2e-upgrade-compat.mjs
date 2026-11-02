/**
 * 配置升级 / 降级兼容：旧版与异常配置文件的处理。
 *
 * ===== 这条测试要锁住的安全属性 =====
 * 升级换版本时，最怕的是"新版本读不懂旧配置 → 直接覆盖成空 / 崩溃，
 * 用户的连接、密码、SQL 全没了"。本项目刻意选择**不猜、不覆盖**：
 *   - 同版本：正常加载；
 *   - 未知版本（旧的或更新的）、结构损坏、JSON 坏：一律把原文件**改名备份**成
 *     `.corrupt-<时间戳>`，降级为空清单，并在日志里说明原因——**绝不删除、绝不覆盖**。
 * 用户至少能手工把老文件捞回来。
 *
 * 覆盖范围说明：
 *   - connections 与 secrets 两条通道在这里直接测（Node 层，无需 Electron）。
 *   - 布局、SQL 历史、saved SQL、ER 布局存在渲染进程的 localStorage 里，
 *     需要真实窗口，由 GUI 组的 test:gui-layout / test:gui-sql-library /
 *     test:gui-er-relations 覆盖，不在本文件重复。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dbstudio-upgrade-compat-'))

// ---- 打包 ConnectionStore + 探针 ----
const probeDir = mkdtempSync(join(root, 'out', 'upgrade-probe-'))
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir: probeDir,
    target: 'node22',
    ssr: true,
    minify: false,
    lib: { entry: resolve(root, 'tests/probe-entry.ts'), formats: ['cjs'] },
    rollupOptions: { external: [/^node:/, 'electron'], output: { entryFileNames: 'probe.cjs' } }
  }
})
const { ConnectionStore, SecretStorageUnavailableError } = await import(
  pathToFileURL(join(probeDir, 'probe.cjs')).href
)

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const reversibleCipher = {
  encrypt: (plain) => Buffer.from(plain, 'utf8'),
  decrypt: (payload) => payload.toString('utf8')
}
const logs = []
const onLog = (level, message) => logs.push(`${level}: ${message}`)

const newStore = (baseDir, cipher = reversibleCipher) =>
  new ConnectionStore({ baseDir, cipher, onLog })

const baseConfig = (name) => ({ dialectId: 'sqlite', name, options: { file: join(work, `${name}.db`) } })

try {
  // ============================================================
  console.log('\n[1] 同版本：保存后重启能读回（含密码）')
  const dir1 = join(work, 'same-version')
  {
    const store = newStore(dir1)
    store.saveConnection('c1', baseConfig('db-one'))
    store.setSecret('c1', { dbPassword: 'sekret' })

    // 新实例模拟"下次启动"
    const reopened = newStore(dir1)
    const conns = reopened.listConnections()
    check('重启后连接还在', conns.length === 1 && conns[0].id === 'c1', JSON.stringify(conns.map((c) => c.id)))
    check('连接配置完整', conns[0]?.config?.name === 'db-one', JSON.stringify(conns[0]?.config))
    check('密码能解密读回', reopened.getSecret('c1')?.dbPassword === 'sekret', JSON.stringify(reopened.getSecret('c1')))
    check('原子写没有残留 temp 文件', readdirSync(dir1).every((f) => !f.includes('.tmp')), readdirSync(dir1).join(','))
  }

  // ============================================================
  console.log('\n[2] 未知 schemaVersion：隔离备份、不覆盖、降级空清单')
  const dir2 = join(work, 'unknown-version')
  {
    const store = newStore(dir2)
    store.saveConnection('c1', baseConfig('legacy'))
    const path = store.connectionsPath
    const originalText = readFileSync(path, 'utf8')
    // 篡改成未来的版本号，模拟"这个文件来自更新版本"
    const tampered = JSON.parse(originalText)
    tampered.schemaVersion = 999
    writeFileSync(path, JSON.stringify(tampered))

    logs.length = 0
    const reopened = newStore(dir2)
    check('未知版本不崩、清单降级为空', reopened.listConnections().length === 0)
    const corrupt = readdirSync(dir2).filter((f) => f.startsWith('connections.json.corrupt-'))
    check('原文件被隔离备份（.corrupt-*）', corrupt.length === 1, readdirSync(dir2).join(','))
    check('备份内容完整保留', corrupt.length === 1 && readFileSync(join(dir2, corrupt[0]), 'utf8') === JSON.stringify(tampered))
    check('日志说明了原因', logs.some((l) => l.includes('schemaVersion')), logs.join(' | '))
  }

  // ============================================================
  console.log('\n[3] JSON 损坏：隔离备份、降级空清单')
  const dir3 = join(work, 'broken-json')
  {
    const store = newStore(dir3)
    store.saveConnection('c1', baseConfig('x'))
    writeFileSync(store.connectionsPath, '{ this is not json')

    logs.length = 0
    const reopened = newStore(dir3)
    check('损坏 JSON 不崩、清单为空', reopened.listConnections().length === 0)
    const corrupt = readdirSync(dir3).filter((f) => f.startsWith('connections.json.corrupt-'))
    check('损坏文件被隔离备份', corrupt.length === 1, readdirSync(dir3).join(','))
    check('备份保留了原始坏内容', corrupt.length === 1 && readFileSync(join(dir3, corrupt[0]), 'utf8') === '{ this is not json')
    check('日志说明了 JSON 解析失败', logs.some((l) => l.includes('JSON')), logs.join(' | '))
  }

  // ============================================================
  console.log('\n[4] 缺 schemaVersion / 结构不符：隔离备份')
  const dir4 = join(work, 'missing-version')
  {
    const store = newStore(dir4)
    store.saveConnection('c1', baseConfig('y'))
    writeFileSync(store.connectionsPath, JSON.stringify({ connections: [] }))

    logs.length = 0
    const reopened = newStore(dir4)
    check('缺 schemaVersion 时清单为空', reopened.listConnections().length === 0)
    check(
      '缺 schemaVersion 时被隔离备份',
      readdirSync(dir4).some((f) => f.startsWith('connections.json.corrupt-')),
      readdirSync(dir4).join(',')
    )
    check('日志说明了结构不符', logs.some((l) => l.includes('结构')), logs.join(' | '))
  }

  // ============================================================
  console.log('\n[5] 一条坏记录不影响其它好记录（逐条校验）')
  const dir5 = join(work, 'one-bad-row')
  {
    const store = newStore(dir5)
    store.saveConnection('good', baseConfig('good'))
    const file = JSON.parse(readFileSync(store.connectionsPath, 'utf8'))
    file.connections.push({ id: '', config: null }) // 坏记录
    writeFileSync(store.connectionsPath, JSON.stringify(file))

    const reopened = newStore(dir5)
    const conns = reopened.listConnections()
    check('好记录仍被加载', conns.some((c) => c.id === 'good'), JSON.stringify(conns.map((c) => c.id)))
    check('坏记录被丢弃但不拖垮整表', conns.every((c) => c.id === 'good'), JSON.stringify(conns.map((c) => c.id)))
  }

  // ============================================================
  console.log('\n[6] 密码通道独立的降级：cipher 不可用')
  const dir6 = join(work, 'no-cipher')
  {
    // 先在有 cipher 的环境写下密码
    const writable = newStore(dir6)
    writable.saveConnection('c1', baseConfig('z'))
    writable.setSecret('c1', { dbPassword: 'pw' })

    logs.length = 0
    // 再用"无安全存储"的环境打开
    const locked = new ConnectionStore({ baseDir: dir6, cipher: null, onLog })
    check('cipher 不可用时 canStoreSecrets 为 false', locked.canStoreSecrets === false)
    check('连接本身仍能读（只有密码读不到）', locked.listConnections().length === 1)
    check('密码读不出时返回 undefined 而非崩溃', locked.getSecret('c1') === undefined)
    check('日志提示安全存储不可用', logs.some((l) => l.includes('安全存储')), logs.join(' | '))

    let threw = false
    try {
      locked.setSecret('c1', { dbPassword: 'newpw' })
    } catch (e) {
      threw = e instanceof SecretStorageUnavailableError
    }
    check('cipher 不可用时写密码抛 SecretStorageUnavailableError', threw)
  }

  // ============================================================
  console.log('\n[7] 删除连接不影响密码通道的其它条目')
  const dir7 = join(work, 'delete-isolation')
  {
    const store = newStore(dir7)
    store.saveConnection('a', baseConfig('a'))
    store.saveConnection('b', baseConfig('b'))
    store.setSecret('a', { dbPassword: 'pa' })
    store.setSecret('b', { dbPassword: 'pb' })
    store.deleteConnection('a')

    const reopened = newStore(dir7)
    check('删除 a 后只剩 b', reopened.listConnections().map((c) => c.id).join(',') === 'b')
    check('b 的密码不受影响', reopened.getSecret('b')?.dbPassword === 'pb')
    check('a 的密码已被清理', reopened.getSecret('a') === undefined)
  }
} finally {
  rmSync(probeDir, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n配置升级兼容：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
