/**
 * ConnectionManager.previewImport 的后端契约回归（不启 Electron、不连接数据库）。
 *
 * 这里通过真实的 ConnectionManager 实例和主进程源码 bundle 验证文件读取、
 * 请求校验与 CSV 预览边界；IPC 通道名称仅做静态接线检查，真实 IPC 由 GUI 验证。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const built = await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    write: false,
    target: 'node22',
    ssr: true,
    minify: false,
    lib: { entry: resolve(root, 'src/main/ConnectionManager.ts'), formats: ['es'] }
  }
})
const outputs = Array.isArray(built)
  ? built.flatMap((result) => result.output ?? [])
  : (built.output ?? [])
const chunk = outputs.find((output) => output.type === 'chunk')
if (!chunk) throw new Error('Vite did not produce a ConnectionManager chunk')
const managerModule = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`)

const fixtureDir = await mkdtemp(join(tmpdir(), 'dbstudio-import-preview-'))
const store = { listConnections: () => [] }
const manager = new managerModule.ConnectionManager([], store)
const fixturePath = join(fixtureDir, 'preview.csv')

const request = (sourcePath = fixturePath, overrides = {}) => ({
  sourcePath,
  delimiter: ',',
  nullText: 'NULL',
  hasHeader: true,
  ...overrides
})

await writeFile(
  fixturePath,
  ['id,name,note', '1,A,""', '2,B,NULL'].join('\n'),
  'utf8'
)

test('ConnectionManager.previewImport 真实读取绝对路径并解析 quoted 空串与 NULL', async () => {
  const result = await manager.previewImport(request())
  assert.equal(result.sourcePath, fixturePath)
  assert.deepEqual(result.columns.map((column) => column.name), ['id', 'name', 'note'])
  assert.equal(result.totalRows, 2)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.errors, [])
  assert.equal(result.sampleRows[0].values[2].kind, 'text')
  assert.equal(result.sampleRows[0].values[2].text, '')
  assert.equal(result.sampleRows[0].values[2].quoted, true)
  assert.equal(result.sampleRows[1].values[2].kind, 'null')
  assert.equal(result.sampleRows[1].values[2].text, null)
})

test('ConnectionManager.previewImport 使用 50 默认样例上限并允许 200 上限', async () => {
  const rows = ['id', ...Array.from({ length: 205 }, (_, index) => String(index + 1))]
  const path = join(fixtureDir, 'limits.csv')
  await writeFile(path, rows.join('\n'), 'utf8')

  const defaultResult = await manager.previewImport(request(path))
  assert.equal(defaultResult.sampleRows.length, 50)
  assert.equal(defaultResult.totalRows, 205)
  assert.equal(defaultResult.truncated, true)

  const maxResult = await manager.previewImport(request(path, { sampleRowLimit: 200 }))
  assert.equal(maxResult.sampleRows.length, 200)
  assert.equal(maxResult.totalRows, 205)
  assert.equal(maxResult.truncated, true)
})

test('ConnectionManager.previewImport 返回重复 header、缺列和非法 UTF-8 位置', async () => {
  const malformedPath = join(fixtureDir, 'malformed.csv')
  await writeFile(malformedPath, 'id,id\n1\n', 'utf8')
  const malformed = await manager.previewImport(request(malformedPath))
  assert.equal(malformed.totalRows, 1)
  assert.ok(malformed.errors.some((error) => error.code === 'duplicate-column'))
  assert.ok(malformed.errors.some((error) => error.code === 'missing-column'))

  const invalidPath = join(fixtureDir, 'invalid-utf8.csv')
  await writeFile(invalidPath, Buffer.from([0x69, 0x64, 0x0a, 0x31, 0xc3, 0x28]))
  const invalid = await manager.previewImport(request(invalidPath))
  const encodingError = invalid.errors.find((error) => error.code === 'invalid-encoding')
  assert.ok(encodingError)
  assert.equal(encodingError.line, 2)
  assert.equal(encodingError.column, null)
  assert.match(encodingError.message, /字节偏移/)
})

test('ConnectionManager.previewImport 拒绝无效请求、路径、分隔符、上限和不存在文件', async () => {
  await assert.rejects(() => manager.previewImport(undefined), /预览请求必须是对象/)
  await assert.rejects(() => manager.previewImport(request('relative.csv')), /必须是绝对路径/)
  await assert.rejects(() => manager.previewImport(request('', {})), /缺少 sourcePath/)
  await assert.rejects(() => manager.previewImport(request(fixturePath, { delimiter: undefined })), /单个字符/)
  await assert.rejects(() => manager.previewImport(request(fixturePath, { nullText: undefined })), /NULL 标记必须是字符串/)
  await assert.rejects(() => manager.previewImport(request(fixturePath, { hasHeader: undefined })), /hasHeader 必须是布尔值/)
  await assert.rejects(() => manager.previewImport(request(fixturePath, { delimiter: '' })), /单个字符/)
  await assert.rejects(() => manager.previewImport(request(fixturePath, { delimiter: '||' })), /单个字符/)
  await assert.rejects(() => manager.previewImport(request(fixturePath, { sampleRowLimit: 201 })), /样例行上限/)
  await assert.rejects(
    () => manager.previewImport(request(join(fixtureDir, 'does-not-exist.csv'))),
    /ENOENT/
  )
})

test('previewImport IPC 通道已接入主进程和 preload 白名单（静态检查）', async () => {
  const [api, preload, manifest, adapter] = await Promise.all([
    (await import('node:fs/promises')).readFile(resolve(root, 'src/core/api.ts'), 'utf8'),
    (await import('node:fs/promises')).readFile(resolve(root, 'src/preload/index.ts'), 'utf8'),
    (await import('node:fs/promises')).readFile(
      resolve(root, 'src/backend/contract/method-manifest.ts'),
      'utf8'
    ),
    (await import('node:fs/promises')).readFile(
      resolve(root, 'src/main/transport/electron-ipc-adapter.ts'),
      'utf8'
    )
  ])
  assert.match(api, /previewImport:\s*'dbstudio:previewImport'/)
  assert.match(preload, /ipcRenderer\.invoke\(IPC\.previewImport, request\)/)
  // 方法名 → channel 的绑定在可执行 manifest 里；transport 按该清单注册。
  assert.match(manifest, /entry\('previewImport',\s*IPC\.previewImport\)/)
  assert.match(adapter, /BACKEND_METHOD_MANIFEST/)
  assert.match(adapter, /for \(const \{ method, channel \} of BACKEND_METHOD_MANIFEST\)/)
  assert.match(adapter, /handler\(\.\.\.args\)/)
})
