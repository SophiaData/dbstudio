import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { pathToFileURL } from 'node:url'
import { fileDigest, releaseIdentity, targetFor } from './release-gate.mjs'

/**
 * 打包应用的冒烟断言。
 *
 * 单独导出是为了能被单元测试直接检验——这套断言在真实 CI 上
 * 只有**一次**机会跑（每个平台一次），一旦写错就会让整条发布链
 * 长期带着一个假绿或假红。所以每条断言的形状都要能在本地被测到。
 */
export function assertPackagedRuntime(runtime, { version, platform, arch }) {
  assert.equal(runtime.packaged, true, 'Must launch the packaged executable, not out/ or node_modules/electron')
  assert.equal(runtime.version, version)
  assert.equal(runtime.arch, arch)
  assert.equal(runtime.platform, { mac: 'darwin', win: 'win32', linux: 'linux' }[platform])
}

/**
 * 读取**打包产物内部**的 package.json 版本。
 *
 * ⚠️ Electron 的 `app.evaluate` 上下文里没有 CommonJS `require`，
 * 直接写 `require('node:fs')` 会抛 `ReferenceError: require is not defined`，
 * 冒烟会在第一道真实断言前就崩掉。Electron 内置的 Node 运行时
 * 把内置模块挂在 `process.getBuiltinModule` 上，必须用它。
 */
export function packagedMetadataReader() {
  return ({ app }) => {
    const fs = process.getBuiltinModule('fs')
    const path = process.getBuiltinModule('path')
    return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).version
  }
}

/**
 * SQLite 冒烟的连接参数。
 *
 * ⚠️ 不能用 ':memory:'：SQLite 驱动**拒绝**非绝对路径
 * （子进程里无法可靠解析相对路径），也**要求文件真实存在**。
 * 所以必须给一个临时目录里的真实空文件——空文件就是合法的 SQLite 库。
 */
export function sqliteSmokeConnection(databaseFile) {
  return { dialectId: 'sqlite', name: 'packaged-smoke', options: { file: databaseFile } }
}

const [platform, arch, executable, reportPath] = process.argv.slice(2)
export async function runPackagedSmoke({ platform, arch, executable, reportPath, env = process.env }) {
  const target = targetFor(platform, arch)
  assert.ok(executable && reportPath, 'Usage: smoke-packaged-app.mjs PLATFORM ARCH EXECUTABLE REPORT_JSON')
  const root = resolve(import.meta.dirname, '..')
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const identity = releaseIdentity(env, version)
  const work = await mkdtemp(join(tmpdir(), 'dbstudio-packaged-smoke-'))
  const logs = []
  let app
  let watchdog
  try {
    const launchEnv = { ...env, DBSTUDIO_TEST_HIDDEN: '1' }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    delete launchEnv.ELECTRON_RENDERER_URL
    delete launchEnv.DBSTUDIO_SMOKE
    app = await electron.launch({
      executablePath: resolve(executable), cwd: work, env: launchEnv, timeout: 30000,
      args: [`--user-data-dir=${join(work, 'userdata')}`,
        ...(process.platform === 'linux' && launchEnv.ELECTRON_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : [])]
    })
    app.process().stdout?.on('data', (data) => logs.push(data.toString()))
    app.process().stderr?.on('data', (data) => logs.push(data.toString()))
    watchdog = setTimeout(() => { app.process().kill('SIGKILL') }, 60000)
    const runtime = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged, version: app.getVersion(), arch: process.arch, platform: process.platform,
      appPath: app.getAppPath()
    }))
    assertPackagedRuntime(runtime, { version, platform, arch })
    // Validate packaged metadata too; the executable version alone does not
    // prove that the application's own package.json made it into the archive.
    const metadata = await app.evaluate(packagedMetadataReader())
    assert.equal(metadata, version)
    const page = await app.firstWindow({ timeout: 15000 })
    await page.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })
    await page.waitForFunction(() => !!window.dbstudio?.runQuery)
    const databaseFile = join(work, 'packaged-smoke.db')
    // The driver requires a real, existing, absolute path — see sqliteSmokeConnection.
    await writeFile(databaseFile, '')
    const connection = sqliteSmokeConnection(databaseFile)
    /*
     * 第一次启动：查询 + 建连接并改名 + 断开（保留配置，不 remove）。
     *
     * 保留配置是为了下一步验证"重启后恢复"——这是 P7.2 要求的关键一条：
     * 光证明"能连上、能查询"不够，还要证明**编辑过的配置在重启后还在**。
     */
    const firstRun = await page.evaluate(async (config) => {
      const api = window.dbstudio
      const c = await api.addConnection(config)
      if (!c.connected) throw new Error('Packaged SQLite host did not connect')
      const query = await api.runQuery(`connection:${c.id}`, 'SELECT 42 AS packaged_answer')
      await api.closeCursor(query.cursorId)
      await api.updateConnection(c.id, { name: 'renamed-after-edit' })
      await api.disconnectConnection(c.id)
      return { id: c.id, value: query.rows[0]?.cells[0]?.value }
    }, connection)
    assert.equal(firstRun.value, 42)

    // 关闭第一次启动（模拟用户退出应用）
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app.close().catch(() => undefined)
    app = undefined

    // 第二次启动：同一 user-data 目录，验证连接配置（含改名）在重启后恢复
    app = await electron.launch({
      executablePath: resolve(executable),
      cwd: work,
      env: launchEnv,
      timeout: 30000,
      args: [`--user-data-dir=${join(work, 'userdata')}`,
        ...(process.platform === 'linux' && launchEnv.ELECTRON_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : [])]
    })
    app.process().stdout?.on('data', (data) => logs.push(data.toString()))
    app.process().stderr?.on('data', (data) => logs.push(data.toString()))
    const page2 = await app.firstWindow({ timeout: 15000 })
    await page2.waitForFunction(() => !!window.dbstudio?.listConnections, undefined, { timeout: 15000 })
    const restored = await page2.evaluate(async () => window.dbstudio.listConnections())
    const restoredConn = restored.find((c) => c.id === firstRun.id)
    assert.ok(restoredConn, '重启后连接配置必须还在')
    assert.equal(restoredConn.name, 'renamed-after-edit', '重启后应恢复编辑后的连接名')
    const methods = {
      dmg: 'Pending native macOS mount, copy to Applications, launch and signing/notarization assessment.',
      zip: 'Pending archive extraction and launch of the extracted application.',
      exe: 'Pending native Windows installer installation, launch and uninstall.',
      AppImage: 'Pending executable AppImage extraction/mount and launch on native Linux.'
    }
    const report = {
      schemaVersion: 1, ...identity, platform, arch, status: 'passed', evidence: 'unpacked-executable',
      runtimeVersion: runtime.version, executableSha256: (await fileDigest(resolve(executable))).sha256,
      checks: { packaged: true, renderer: true, preload: true, sqliteHost: true, query: true, restartRecovery: true },
      installers: Object.fromEntries(target.extensions.map((ext) => [ext, { status: 'unverified', method: methods[ext] }]))
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Packaged smoke passed: ${platform}/${arch}, version ${version}, SQLite SELECT 42, restart recovery ok`)
    return report
  } finally {
    clearTimeout(watchdog)
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
      if (app.process().exitCode === null) app.process().kill('SIGKILL')
      await app.close().catch(() => {})
    }
    await writeFile(`${reportPath}.log`, logs.join(''))
    await rm(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [platform, arch, executable, reportPath] = process.argv.slice(2)
  try {
    await runPackagedSmoke({ platform, arch, executable, reportPath })
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
