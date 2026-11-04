/**
 * 握手 / 版本兼容性契约测试。
 *
 * ===== 它要钉住的是什么 =====
 *
 * 主进程的 `DriverHostHandle` 与 SDK 的 `DriverHost` 是两个类，但必须遵守
 * **同一份**握手协议。历史上二者各写各的：SDK 甚至不等待握手帧，宿主发的是
 * 一个自由格式的 `adapterVersion` 字符串，于是「方言装错了」「SDK 与宿主
 * 不是同一发布批次」这两类部署错误都不会在握手阶段暴露，而会在某个深层
 * RPC 上以字段缺失的形式炸开。
 *
 * 本测试从三条路径验证同一份契约：
 *   1. `validateHandshake` 纯函数（共享实现，直接单测边界）；
 *   2. SDK 的 `DriverHost`（真实构建产物）；
 *   3. 主进程的 `DriverHostHandle`（用 vite 打包 tests/probe-entry.ts）。
 *
 * 同时验证**向后兼容**：不带版本字段的 legacy 宿主仍然可以握手成功，
 * 只是会得到一条 warning——这样老部署不会因为客户端升级而立刻不可用。
 *
 * 依赖：
 *   - `pnpm run build:sdk`（sdk/dist）
 *   - `pnpm run build:driver-host`（out/driver-host）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdkEntry = join(root, 'sdk/dist/sdk/src/index.js')
const sdkHostScript = join(root, 'sdk/dist/driver-host/index.js')
const mainHostScript = join(root, 'out/driver-host/index.js')

for (const [label, path] of [
  ['SDK 构建产物', sdkEntry],
  ['SDK 宿主脚本', sdkHostScript],
  ['主进程宿主脚本', mainHostScript]
]) {
  if (!existsSync(path)) {
    throw new Error(
      `${label}不存在: ${path}\n` +
        '请先执行 `pnpm run build:sdk && pnpm run build:driver-host` 再跑本测试。'
    )
  }
}

// ---------------------------------------------------------------------------
// fake 宿主：真实走 NDJSON over stdio，只替换握手帧内容
// ---------------------------------------------------------------------------

const FAKE_HOST_SOURCE = `'use strict'
const readline = require('node:readline')

const dialectIndex = process.argv.indexOf('--dialect')
const dialect = dialectIndex >= 0 ? process.argv[dialectIndex + 1] : 'unknown'
const override = __OVERRIDE__

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\\n')
}

send(Object.assign({
  kind: 'handshake',
  dialectId: dialect,
  adapterVersion: 'fake-handshake-0.0.0',
  pid: process.pid,
  nodeVersion: process.version,
  platform: process.platform
}, override))

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  let req
  try { req = JSON.parse(line) } catch { return }
  switch (req.method) {
    case 'connect':
      send({ id: req.id, ok: true, result: { dialectId: dialect, supportsCancel: false, hasCatalog: false } })
      return
    case 'testConnection':
      send({ id: req.id, ok: true, result: { ok: true, elapsedMs: 1 } })
      return
    default:
      send({ id: req.id, ok: true, result: null })
  }
})
rl.on('close', () => process.exit(0))
`

const work = mkdtempSync(join(tmpdir(), 'dbstudio-handshake-contract-'))
let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function writeFakeHost(name, handshakeOverride) {
  const file = join(work, `${name}.cjs`)
  writeFileSync(file, FAKE_HOST_SOURCE.replace('__OVERRIDE__', JSON.stringify(handshakeOverride)))
  return file
}

async function rejectionOf(input) {
  try {
    // 同步抛错的校验函数用 thunk 传入，异步 RPC 直接传 Promise。
    const value = await (typeof input === 'function' ? input() : input)
    return { rejected: false, value }
  } catch (error) {
    return { rejected: true, error }
  }
}

const sdk = await import(pathToFileURL(sdkEntry).href)
const {
  DriverHost,
  DRIVER_API_VERSION,
  HANDSHAKE_PROTOCOL_VERSION,
  METADATA_SCHEMA_VERSION,
  TRANSFER_SCHEMA_VERSION,
  SDK_CONTRACT_VERSION,
  validateHandshake,
  HandshakeValidationError,
  isHandshakeValidationError
} = sdk

// 主进程侧：把真实的 DriverHostHandle 打进一个临时 CJS 探针
const probeDir = mkdtempSync(join(root, 'out/.handshake-contract-probe-'))
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir: probeDir,
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    ssr: true,
    rollupOptions: {
      external: [/^node:/, 'electron'],
      output: { entryFileNames: 'probe.cjs' }
    },
    lib: { entry: resolve(root, 'tests/probe-entry.ts'), formats: ['cjs'] }
  }
})
const { DriverHostHandle } = await import(pathToFileURL(join(probeDir, 'probe.cjs')).href)

const VERSIONS = {
  protocolVersion: HANDSHAKE_PROTOCOL_VERSION,
  driverApiVersion: DRIVER_API_VERSION,
  metadataSchemaVersion: METADATA_SCHEMA_VERSION,
  transferSchemaVersion: TRANSFER_SCHEMA_VERSION,
  sdkContractVersion: SDK_CONTRACT_VERSION
}

function handshake(overrides = {}) {
  return {
    kind: 'handshake',
    dialectId: 'sqlite',
    adapterVersion: 'test-0.0.0',
    pid: process.pid,
    nodeVersion: process.version,
    platform: process.platform,
    ...VERSIONS,
    ...overrides
  }
}

try {
  console.log('\n[1] 共享校验函数 validateHandshake')
  {
    const ok = validateHandshake(handshake(), { dialectId: 'sqlite', ...VERSIONS })
    check('合法握手通过', ok.handshake.dialectId === 'sqlite')
    check('合法握手没有 warning', ok.warnings.length === 0, ok.warnings.join(';'))
    check('合法握手不是 legacy', ok.legacy === false)

    const dialect = await rejectionOf(async () => validateHandshake(handshake({ dialectId: 'postgresql' }), { dialectId: 'sqlite' }))
    check('方言不匹配被拒绝', dialect.rejected)
    check('方言错误码是 dialect_mismatch', dialect.error?.code === 'dialect_mismatch', String(dialect.error?.code))
    check('方言错误信息含期望/实际', /期望 "sqlite"/.test(dialect.error?.message ?? '') && /"postgresql"/.test(dialect.error?.message ?? ''), dialect.error?.message)
    check('错误可用 isHandshakeValidationError 识别', isHandshakeValidationError(dialect.error))
    check('错误是 HandshakeValidationError', dialect.error instanceof HandshakeValidationError)

    for (const [field, code] of [
      ['protocolVersion', 'protocol_version_mismatch'],
      ['driverApiVersion', 'driver_api_version_mismatch'],
      ['metadataSchemaVersion', 'metadata_schema_version_mismatch'],
      ['transferSchemaVersion', 'transfer_schema_version_mismatch'],
      ['sdkContractVersion', 'sdk_contract_version_mismatch']
    ]) {
      const result = await rejectionOf(async () =>
        validateHandshake(handshake({ [field]: VERSIONS[field] + 1 }), { dialectId: 'sqlite', ...VERSIONS })
      )
      check(`${field} 不匹配被拒绝 (${code})`, result.rejected && result.error?.code === code, result.error?.message)
    }

    const legacy = validateHandshake(
      { kind: 'handshake', dialectId: 'sqlite', adapterVersion: 'legacy-0.0.0', pid: 1, nodeVersion: 'x', platform: 'x' },
      { dialectId: 'sqlite', ...VERSIONS }
    )
    check('legacy 宿主被接受（向后兼容）', legacy.legacy === true)
    check('legacy 宿主产生 warning', legacy.warnings.length >= 1, legacy.warnings.join(';'))

    const malformed = await rejectionOf(async () => validateHandshake({ kind: 'log' }, { dialectId: 'sqlite' }))
    check('非握手帧被拒绝', malformed.rejected && malformed.error?.code === 'malformed_handshake')
  }

  console.log('\n[2] 真实宿主在握手帧中声明版本')
  {
    const host = new DriverHost({ dialectId: 'sqlite', hostScript: sdkHostScript })
    try {
      const hs = await host.handshake
      check('SDK 宿主: dialectId 正确', hs.dialectId === 'sqlite', hs.dialectId)
      check('SDK 宿主: protocolVersion 正确', hs.protocolVersion === HANDSHAKE_PROTOCOL_VERSION, String(hs.protocolVersion))
      check('SDK 宿主: driverApiVersion 正确', hs.driverApiVersion === DRIVER_API_VERSION, String(hs.driverApiVersion))
      check('SDK 宿主: metadataSchemaVersion 正确', hs.metadataSchemaVersion === METADATA_SCHEMA_VERSION)
      check('SDK 宿主: transferSchemaVersion 正确', hs.transferSchemaVersion === TRANSFER_SCHEMA_VERSION)
      check('SDK 宿主: sdkContractVersion 正确', hs.sdkContractVersion === SDK_CONTRACT_VERSION)
    } finally {
      await host.close()
    }
  }
  {
    const host = new DriverHostHandle({ dialectId: 'sqlite', hostScript: mainHostScript })
    try {
      const hs = await host.handshake
      check('主进程宿主: dialectId 正确', hs.dialectId === 'sqlite', hs.dialectId)
      check('主进程宿主: protocolVersion 正确', hs.protocolVersion === HANDSHAKE_PROTOCOL_VERSION, String(hs.protocolVersion))
      check('主进程宿主: driverApiVersion 正确', hs.driverApiVersion === DRIVER_API_VERSION, String(hs.driverApiVersion))
      check('主进程宿主: 生命周期为 ready', host.lifecycle === 'ready', host.lifecycle)
    } finally {
      await host.close()
    }
  }

  console.log('\n[3] SDK 客户端拒绝不兼容宿主')
  {
    const cases = [
      {
        name: '方言不匹配',
        file: writeFakeHost('sdk-dialect', { dialectId: 'postgresql' }),
        code: 'dialect_mismatch',
        patterns: [/期望 "sqlite"/, /"postgresql"/]
      },
      {
        name: '协议版本不匹配',
        file: writeFakeHost('sdk-protocol', { protocolVersion: HANDSHAKE_PROTOCOL_VERSION + 1 }),
        code: 'protocol_version_mismatch',
        patterns: [/协议版本不兼容/, new RegExp(`宿主=${HANDSHAKE_PROTOCOL_VERSION + 1}`)]
      },
      {
        name: '驱动 API 版本不匹配',
        file: writeFakeHost('sdk-api', { driverApiVersion: DRIVER_API_VERSION + 1 }),
        code: 'driver_api_version_mismatch',
        patterns: [/驱动 API 版本不兼容/, new RegExp(`客户端支持=${DRIVER_API_VERSION}`)]
      }
    ]
    for (const item of cases) {
      const host = new DriverHost({ dialectId: 'sqlite', hostScript: item.file, onLog: () => undefined })
      try {
        const result = await rejectionOf(host.handshake)
        check(`SDK ${item.name}: 握手被拒绝`, result.rejected, String(result.value))
        check(`SDK ${item.name}: 错误码正确`, result.error?.code === item.code, String(result.error?.code))
        check(
          `SDK ${item.name}: 错误可诊断`,
          item.patterns.every((pattern) => pattern.test(result.error?.message ?? '')) && /pid=/.test(result.error?.message ?? ''),
          result.error?.message
        )
        const connect = await rejectionOf(host.connect({ dialectId: 'sqlite', name: 'x', options: {} }))
        check(`SDK ${item.name}: connect 不会盲发`, connect.rejected && connect.error?.code === item.code, connect.error?.message)
      } finally {
        host.kill()
      }
    }
  }
  {
    const legacyFile = writeFakeHost('sdk-legacy', {})
    const host = new DriverHost({ dialectId: 'sqlite', hostScript: legacyFile, onLog: () => undefined })
    try {
      const hs = await host.handshake
      check('SDK legacy 宿主: 握手成功', hs.dialectId === 'sqlite')
      check('SDK legacy 宿主: 版本字段缺失', hs.protocolVersion === undefined)
      const caps = await host.connect({ dialectId: 'sqlite', name: 'legacy', options: {} })
      check('SDK legacy 宿主: connect 仍可用', caps && typeof caps === 'object')
    } finally {
      await host.close()
    }
  }

  console.log('\n[4] 主进程客户端拒绝不兼容宿主')
  {
    const cases = [
      {
        name: '方言不匹配',
        file: writeFakeHost('main-dialect', { dialectId: 'postgresql' }),
        code: 'dialect_mismatch',
        patterns: [/期望 "sqlite"/, /"postgresql"/]
      },
      {
        name: '协议版本不匹配',
        file: writeFakeHost('main-protocol', { protocolVersion: HANDSHAKE_PROTOCOL_VERSION + 1 }),
        code: 'protocol_version_mismatch',
        patterns: [/协议版本不兼容/]
      },
      {
        name: '驱动 API 版本不匹配',
        file: writeFakeHost('main-api', { driverApiVersion: DRIVER_API_VERSION + 1 }),
        code: 'driver_api_version_mismatch',
        patterns: [/驱动 API 版本不兼容/]
      }
    ]
    for (const item of cases) {
      const host = new DriverHostHandle({
        dialectId: 'sqlite',
        hostScript: item.file,
        onLog: () => undefined
      })
      try {
        const result = await rejectionOf(host.handshake)
        check(`主进程 ${item.name}: 握手被拒绝`, result.rejected, String(result.value))
        check(`主进程 ${item.name}: 错误码正确`, result.error?.code === item.code, String(result.error?.code))
        check(
          `主进程 ${item.name}: 错误可诊断`,
          item.patterns.every((pattern) => pattern.test(result.error?.message ?? '')) &&
            /pid=/.test(result.error?.message ?? '') &&
            /script=/.test(result.error?.message ?? ''),
          result.error?.message
        )
        check(`主进程 ${item.name}: 生命周期标记为 failed`, host.lifecycle === 'failed', host.lifecycle)
      } finally {
        host.kill()
        await host.close()
      }
    }
  }
  {
    const legacyFile = writeFakeHost('main-legacy', {})
    const host = new DriverHostHandle({ dialectId: 'sqlite', hostScript: legacyFile, onLog: () => undefined })
    try {
      const hs = await host.handshake
      check('主进程 legacy 宿主: 握手成功', hs.dialectId === 'sqlite')
      check('主进程 legacy 宿主: 版本字段缺失', hs.protocolVersion === undefined)
      check('主进程 legacy 宿主: 生命周期为 ready', host.lifecycle === 'ready', host.lifecycle)
    } finally {
      await host.close()
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
  rmSync(probeDir, { recursive: true, force: true })
}

console.log(`\n握手/版本契约：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
