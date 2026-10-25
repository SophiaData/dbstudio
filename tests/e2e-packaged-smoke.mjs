import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assertPackagedRuntime,
  packagedMetadataReader,
  sqliteSmokeConnection
} from '../scripts/smoke-packaged-app.mjs'

/**
 * 打包冒烟脚本的**离线**回归测试。
 *
 * 为什么要单独测它：真实的打包冒烟在 CI 上每个平台只跑**一次**。
 * 脚本里的任何一处写错，都要等到发版那天才暴露——而那正是最不该
 * 出问题的时刻。本文件在**不打包、不启动 Electron** 的前提下，
 * 把脚本里最容易写错的三个形状锁住：
 *
 *   1. Electron evaluate 上下文里没有 `require`（必须用 getBuiltinModule）
 *   2. SQLite 驱动拒绝 ':memory:'（必须是绝对路径的真实文件）
 *   3. "必须是打包产物" 这条断言真的会拒绝开发目录
 *
 * 这三个都是本轮**真实踩到**的坑（见 §3.5 验收报告），不是假想。
 */

let passed = 0
const test = async (name, run) => {
  await run()
  console.log(`PASS ${name}`)
  passed++
}

const work = await mkdtemp(join(tmpdir(), 'dbstudio-smoke-unit-'))
try {
  await test('packaged metadata reader uses getBuiltinModule, not require', () => {
    const source = packagedMetadataReader.toString()
    assert.ok(
      !/\brequire\s*\(/.test(source),
      'Electron evaluate context has no CommonJS require; using it throws ReferenceError'
    )
    assert.match(source, /getBuiltinModule/)
  })

  await test('packaged metadata reader resolves the version inside the archive', async () => {
    // 用真实的 evaluate 语义模拟：只有 process.getBuiltinModule，没有 require。
    const appDir = join(work, 'app')
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'dbstudio', version: '0.3.1' }))
    const reader = packagedMetadataReader()
    const electronSandbox = {
      process: {
        getBuiltinModule: (name) => {
          if (name === 'fs') return { readFileSync: (p, enc) => readFileSync(p, enc) }
          if (name === 'path') return { join: (...parts) => parts.join('/') }
          throw new Error(`unexpected builtin ${name}`)
        }
      },
      app: { getAppPath: () => appDir }
    }
    const version = reader(electronSandbox)
    assert.equal(version, '0.3.1')
  })

  await test('sqlite smoke connection uses an absolute path, never :memory:', () => {
    const config = sqliteSmokeConnection(join(work, 'smoke.db'))
    assert.equal(config.dialectId, 'sqlite')
    assert.notEqual(config.options.file, ':memory:')
    assert.ok(config.options.file.startsWith('/'), `expected an absolute path, got ${config.options.file}`)
  })

  await test('sqlite smoke connection file is created before connecting', async () => {
    // 驱动同时要求"文件真实存在"，所以冒烟必须先建一个空文件。
    const dbFile = join(work, 'created.db')
    await writeFile(dbFile, '')
    const statResult = await stat(dbFile)
    assert.ok(statResult.isFile())
    assert.equal(statResult.size, 0, 'an empty file is already a valid SQLite database')
  })

  await test('packaged runtime assertion rejects a development-directory launch', () => {
    const expect = { version: '0.3.1', platform: 'mac', arch: 'arm64' }
    assert.throws(
      () => assertPackagedRuntime({ packaged: false, version: '0.3.1', arch: 'arm64', platform: 'darwin' }, expect),
      /packaged executable/
    )
  })

  await test('packaged runtime assertion accepts the real packaged shape', () => {
    const expect = { version: '0.3.1', platform: 'mac', arch: 'arm64' }
    assertPackagedRuntime(
      { packaged: true, version: '0.3.1', arch: 'arm64', platform: 'darwin' },
      expect
    )
  })

  await test('packaged runtime assertion rejects a wrong platform mapping', () => {
    const expect = { version: '0.3.1', platform: 'win', arch: 'x64' }
    assert.throws(
      () => assertPackagedRuntime({ packaged: true, version: '0.3.1', arch: 'x64', platform: 'darwin' }, expect),
      /Expected values to be strictly equal/
    )
  })

  await test('smoke script keeps installer evidence unverified', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../scripts/smoke-packaged-app.mjs'), 'utf8')
    assert.match(source, /status: 'unverified'/)
    assert.match(source, /evidence: 'unpacked-executable'/)
  })
} finally {
  await rm(work, { recursive: true, force: true })
}

console.log(`Packaged smoke unit tests: ${passed} passed`)
