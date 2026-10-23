/**
 * SQL 历史与收藏的存储专项测试。
 *
 * 重点不是“能写 JSON”，而是几条会静默损坏用户资产的约束：
 *   - 历史配额不能淘汰收藏
 *   - 重启后两类数据都还在
 *   - 坏文件隔离备份而不是删除
 *   - 写入使用原子替换，不留临时文件
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0

function check(name, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log(`      ↳ ${JSON.stringify(detail)}`)
  }
}

async function loadModule() {
  const { build } = await import('vite')
  const outDir = resolve(root, 'out/.sql-library-probe')
  await build({
    configFile: false,
    root,
    logLevel: 'error',
    build: {
      outDir,
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      ssr: true,
      rollupOptions: {
        external: [/^node:/],
        output: { entryFileNames: 'store.mjs' }
      },
      lib: {
        entry: resolve(root, 'src/main/SqlLibraryStore.ts'),
        formats: ['es']
      }
    }
  })
  return import(`file://${resolve(outDir, 'store.mjs')}`)
}

const dir = mkdtempSync(join(tmpdir(), 'dbstudio-sql-library-'))
const { SqlLibraryStore, MAX_SQL_HISTORY } = await loadModule()

console.log('='.repeat(70))
console.log('dbstudio 端到端验证：SQL 历史与收藏')
console.log('='.repeat(70))

console.log('\n[1] 历史记录')
{
  const store = new SqlLibraryStore({ baseDir: dir })
  const ok = store.record(
    {
      sql: 'SELECT 1',
      connectionId: 'c1',
      dialectId: 'sqlite',
      elapsedMs: 2.4,
      status: 'success',
      returnedRows: 1
    },
    '本地库'
  )
  const failed = store.record(
    {
      sql: 'SELECT nope',
      connectionId: 'c1',
      dialectId: 'sqlite',
      elapsedMs: 5,
      status: 'error',
      error: 'no such column: nope'
    },
    '本地库'
  )
  const snapshot = store.snapshot()
  check('1a. 成功查询被记录', snapshot.history.length === 2 && ok.status === 'success')
  check('1b. 最新记录在前', snapshot.history[0]?.id === failed.id)
  check('1c. 失败原因保留', snapshot.history[0]?.error === 'no such column: nope')
  check('1d. 连接名快照已写入', snapshot.history[0]?.connectionName === '本地库')
  check('1e. 耗时为非负整数', ok.elapsedMs === 2)
}

console.log('\n[2] 收藏与历史配额解耦')
{
  const store = new SqlLibraryStore({ baseDir: dir })
  const saved = store.save(null, '健康检查', 'SELECT 1')
  for (let i = 0; i < MAX_SQL_HISTORY + 5; i += 1) {
    store.record(
      {
        sql: `SELECT ${i}`,
        connectionId: 'c1',
        dialectId: 'sqlite',
        elapsedMs: 1,
        status: 'success',
        returnedRows: 1
      },
      '本地库'
    )
  }
  const snapshot = store.snapshot()
  check('2a. 历史最多保留 500 条', snapshot.history.length === MAX_SQL_HISTORY, snapshot.history.length)
  check(
    '2b. ★ 历史淘汰不影响收藏',
    snapshot.saved.length === 1 && snapshot.saved[0]?.id === saved.id
  )
  store.clearHistory()
  check('2c. 清空历史后收藏仍在', store.snapshot().saved.length === 1)
}

console.log('\n[3] 重命名与重启持久化')
{
  const store = new SqlLibraryStore({ baseDir: dir })
  const saved = store.snapshot().saved[0]
  store.save(null, '另一条收藏', 'SELECT 2')
  check('3a. [前置] 新增收藏排到最前', store.snapshot().saved[0]?.id !== saved.id)
  const renamed = store.save(saved.id, '连接可用性', 'SELECT 42 AS answer')
  check('3b. 更新收藏保留 id', renamed.id === saved.id)
  check('3c. 更新名称/SQL 成功', renamed.name === '连接可用性' && renamed.sql === 'SELECT 42 AS answer')
  check('3d. 更新后的收藏排到最前', store.snapshot().saved[0]?.id === saved.id)
  const reopened = new SqlLibraryStore({ baseDir: dir })
  check('3e. ★ 重启后收藏仍在', reopened.snapshot().saved[0]?.name === '连接可用性')
}

console.log('\n[4] 坏文件隔离与原子写')
{
  const badDir = mkdtempSync(join(tmpdir(), 'dbstudio-sql-library-bad-'))
  writeFileSync(join(badDir, 'saved-sql.json'), '{broken', 'utf8')
  const store = new SqlLibraryStore({ baseDir: badDir })
  const files = readdirSync(badDir)
  check('4a. 坏收藏文件不拖垮启动', store.snapshot().saved.length === 0)
  check(
    '4b. 坏文件被隔离备份而非删除',
    files.some((name) => name.startsWith('saved-sql.json.corrupt-'))
  )
  const original = readFileSync(
    join(badDir, files.find((name) => name.startsWith('saved-sql.json.corrupt-'))),
    'utf8'
  )
  check('4c. 备份内容原样保留', original === '{broken')
  store.save(null, '恢复后可用', 'SELECT 1')
  const tmpFiles = readdirSync(badDir).filter((name) => name.endsWith('.tmp'))
  check('4d. 原子写后无 .tmp 残留', tmpFiles.length === 0, tmpFiles)
}

console.log('\n[5] 输入校验')
{
  const store = new SqlLibraryStore({ baseDir: dir })
  let threw = false
  try {
    store.save(null, ' ', 'SELECT 1')
  } catch {
    threw = true
  }
  check('5a. 空收藏名被拒绝', threw)
  threw = false
  try {
    store.save(null, '空 SQL', '  ')
  } catch {
    threw = true
  }
  check('5b. 空 SQL 被拒绝', threw)
  check('5c. 删除不存在的收藏是幂等的', (() => {
    store.removeSaved('does-not-exist')
    return true
  })())
}

console.log(`\n===== SQL 历史与收藏测试：${pass} 通过 / ${fail} 失败 =====`)
if (!existsSync(join(dir, 'saved-sql.json'))) {
  console.log('警告：正常目录缺少 saved-sql.json')
  process.exitCode = 1
} else {
  process.exitCode = fail > 0 ? 1 : 0
}
