/**
 * PostgreSQL 编辑 SQL 构造的无服务依赖契约测试。
 *
 * 这里覆盖大小写敏感的组合主键解析，避免只有真实 PG 环境才会发现
 * `("id", "ID")` 被错误合并成同一列。测试通过 Vite 临时打包源码模块，
 * 不启动数据库，也不把测试实现复制到测试脚本里。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tempDir = mkdtempSync(resolve(tmpdir(), 'dbstudio-pg-edits-'))
const bundlePath = resolve(tempDir, 'edits.mjs')

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  const built = await build({
    configFile: false,
    logLevel: 'error',
    build: {
      write: false,
      ssr: true,
      lib: {
        entry: resolve(root, 'src/drivers/postgresql/edits.ts'),
        formats: ['es'],
        fileName: () => 'edits.mjs'
      }
    }
  })
  const output = Array.isArray(built) ? built[0]?.output : built.output
  const chunk = output?.find((item) => item.type === 'chunk')
  if (!chunk || typeof chunk.code !== 'string') throw new Error('Vite 未生成 edits 模块')
  writeFileSync(bundlePath, chunk.code)
  const edits = await import(pathToFileURL(bundlePath).href)

  const available = ['id', 'ID', 'value']
  const ordered = edits.resolveRequiredColumns(
    ['id', 'ID'],
    ['id', 'ID'],
    available
  )
  check(
    '组合主键按真实列名分别匹配 id 与 ID',
    ordered.ordered.map((match) => match.canonical).join(',') === 'id,ID',
    JSON.stringify(ordered)
  )

  const missing = edits.resolveRequiredColumns(['id', 'ID'], ['id'], available)
  check(
    '缺少组合主键列时明确报告 ID',
    missing.missing.length === 1 && missing.missing[0] === 'ID',
    JSON.stringify(missing)
  )

  const builtUpdate = edits.buildUpdate(
    (name) => `"${name}"`,
    'public',
    'items',
    ['value'],
    ordered.ordered.map((match) => match.canonical),
    new Map([['value', { kind: 'text', text: 'changed' }]]),
    new Map([
      ['id', { kind: 'number', value: 7 }],
      ['ID', { kind: 'number', value: 10 }]
    ])
  )
  check(
    'UPDATE SQL 同时包含两个大小写敏感的主键条件',
    builtUpdate.sql.includes('"id" = $2') &&
      builtUpdate.sql.includes('"ID" = $3') &&
      builtUpdate.params.length === 3,
    JSON.stringify(builtUpdate)
  )
  check('UPDATE binds the original keys in order',
    JSON.stringify(builtUpdate.params) === JSON.stringify(['changed', 7, 10]))
  const deletion = edits.buildDelete(
    (name) => `"${name}"`, 'public', 'items',
    ordered.ordered.map((match) => match.canonical),
    new Map([['id', { kind: 'number', value: 7 }], ['ID', { kind: 'number', value: 10 }]])
  )
  check('DELETE keeps two distinct key conditions and parameters',
    deletion.sql.endsWith('WHERE "id" = $1 AND "ID" = $2') &&
      JSON.stringify(deletion.params) === JSON.stringify([7, 10]), JSON.stringify(deletion))
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(`\n===== PostgreSQL 编辑契约：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exit(1)
