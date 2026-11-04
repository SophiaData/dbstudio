/**
 * Renderer 后端契约的运行时验证。
 *
 * ===== 这条测试防的是什么 =====
 *
 * `backend-client.ts` 是 renderer 与桌面 shell 之间唯一的出口。它的三条语义
 * 一旦回归，整个界面会在启动时以最难读的方式坏掉：
 *
 *   1. 没有 `globalThis.dbstudio` 时，`resolveBackendClient()` 必须返回 `null`，
 *      让调用方有机会展示「需要桌面 shell」的提示，而不是抛一个未捕获异常；
 *   2. `requireBackendClient()` 必须抛**可读**错误，而不是 `Cannot read properties of undefined`；
 *   3. transport 注入后必须**原样返回同一对象**，不能包装/克隆——否则 identity 丢失，
 *      预加载层与 renderer 持有的不是同一份 API，测试和缓存语义都会错。
 *
 * ===== 为什么用 Vite 打包 =====
 *
 * 源文件是 TypeScript，直接 import `.ts` 在 Node 里不可行。项目没有引入额外的
 * 转译依赖，但 `vite` 本来就是直接依赖（`build-driver-host.mjs` 也用它），
 * 所以这里用 Vite 的库模式把 `backend-client.ts` 打成一个临时 ESM 产物，
 * 再在真实 Node 运行时里 import。测的是实际会被打包的那份语义，而不是
 * 手抄一份等价实现——后者会漂移，且漂移时测试仍然「通过」。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-backend-contract-'))
const bundle = join(outDir, 'backend-client.mjs')
const errorsBundle = join(outDir, 'errors.mjs')
const manifestBundle = join(outDir, 'method-manifest.mjs')
const apiBundle = join(outDir, 'core-api.mjs')

let pass = 0
let fail = 0

function check(name, run) {
  try {
    run()
    pass += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  ❌ ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

try {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: true,
      target: 'node22',
      ssr: true,
      lib: {
        entry: {
          'backend-client': resolve(root, 'src/backend/backend-client.ts'),
          errors: resolve(root, 'src/backend/contract/errors.ts'),
          'method-manifest': resolve(root, 'src/backend/contract/method-manifest.ts'),
          'core-api': resolve(root, 'src/core/api.ts')
        },
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.mjs`
      }
    }
  })

  check('Vite 产出可导入的 ESM 产物', () => {
    assert.ok(existsSync(bundle), `未找到 ${bundle}`)
  })

  const client = await import(pathToFileURL(bundle).href)
  const errors = await import(pathToFileURL(errorsBundle).href)
  const manifest = await import(pathToFileURL(manifestBundle).href)
  const coreApi = await import(pathToFileURL(apiBundle).href)

  console.log('\n[0] 可执行 method manifest')
  check('Vite 产出可导入的 manifest / core-api / errors 产物', () => {
    assert.ok(existsSync(errorsBundle), `未找到 ${errorsBundle}`)
    assert.ok(existsSync(manifestBundle), `未找到 ${manifestBundle}`)
    assert.ok(existsSync(apiBundle), `未找到 ${apiBundle}`)
  })

  const entries = manifest.BACKEND_METHOD_MANIFEST
  const ipcKeys = Object.keys(coreApi.IPC)

  check('manifest 非空且每条都带 method / channel', () => {
    assert.ok(Array.isArray(entries) && entries.length > 0)
    for (const entry of entries) {
      assert.equal(typeof entry.method, 'string')
      assert.equal(typeof entry.channel, 'string')
    }
  })

  check('方法名没有重复', () => {
    const methods = entries.map((entry) => entry.method)
    assert.equal(new Set(methods).size, methods.length)
  })

  check('IPC channel 没有重复（manifest 与 IPC 常量两侧都检查）', () => {
    const channels = entries.map((entry) => entry.channel)
    assert.equal(new Set(channels).size, channels.length)
    assert.equal(new Set(Object.values(coreApi.IPC)).size, ipcKeys.length)
  })

  check('manifest 与 core/api.ts 的 IPC 常量一一对应（无遗漏 / 无多余）', () => {
    assert.deepEqual(
      entries.map((entry) => entry.method).sort(),
      [...ipcKeys].sort()
    )
  })

  check('每条 channel 都等于对应方法的 IPC 常量', () => {
    for (const entry of entries) {
      assert.equal(entry.channel, coreApi.IPC[entry.method], `方法 ${entry.method} 的通道不匹配`)
    }
  })

  delete globalThis.dbstudio

  console.log('\n[1] 没有桌面 transport 时')
  check('resolveBackendClient() 返回 null', () => {
    assert.equal(client.resolveBackendClient(), null)
  })

  check('requireBackendClient() 抛可读错误', () => {
    assert.throws(
      () => client.requireBackendClient(),
      (error) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /桌面后端/)
        assert.match(error.message, /桌面 shell/)
        assert.doesNotMatch(error.message, /undefined is not|cannot read/i)
        return true
      }
    )
  })

  console.log('\n[2] 注入 fake transport 后')
  const fakeApi = {
    marker: Symbol('fake-backend'),
    listConnections: async () => []
  }
  globalThis.dbstudio = fakeApi

  check('resolveBackendClient() 返回注入的同一对象', () => {
    assert.equal(client.resolveBackendClient(), fakeApi)
  })

  check('重复 resolve 保持 identity（不包装、不克隆）', () => {
    assert.equal(client.resolveBackendClient(), client.resolveBackendClient())
  })

  check('requireBackendClient() 返回注入的同一对象', () => {
    assert.equal(client.requireBackendClient(), fakeApi)
  })

  check('createElectronBackendClient() 适配后仍是同一对象', () => {
    assert.equal(client.createElectronBackendClient(fakeApi), fakeApi)
  })

  console.log('\n[3] 移除注入后恢复可降级语义')
  delete globalThis.dbstudio
  check('resolveBackendClient() 再次返回 null', () => {
    assert.equal(client.resolveBackendClient(), null)
  })

  console.log('\n[4] 契约类型运行时出口')
  check('BackendError 可构造且 isBackendError 可识别', () => {
    const error = new client.BackendError({
      code: 'transport-failed',
      message: 'IPC channel closed',
      retryable: true
    })
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'BackendError')
    assert.equal(error.code, 'transport-failed')
    assert.equal(error.retryable, true)
    assert.equal(client.isBackendError(error), true)
    assert.equal(client.isBackendError(new Error('plain error')), false)
    assert.deepEqual(error.toPayload(), {
      code: 'transport-failed',
      message: 'IPC channel closed',
      details: undefined,
      retryable: true,
      method: undefined,
      callId: undefined
    })
  })

  console.log('\n[5] 结构化 transport 信封与错误归一化')

  check('success / failure envelope 判定', () => {
    assert.equal(errors.isBackendEnvelope({ ok: true, value: 1 }), true)
    assert.equal(errors.isBackendEnvelope({ ok: true, value: undefined }), true)
    assert.equal(
      errors.isBackendEnvelope({ ok: false, error: { code: 'not-found', message: '不存在' } }),
      true
    )
    assert.equal(
      errors.isBackendEnvelope({ ok: false, error: { code: 'bogus-code', message: 'x' } }),
      false
    )
    assert.equal(errors.isBackendEnvelope({ ok: 'yes', value: 1 }), false)
    assert.equal(errors.isBackendEnvelope('raw-value'), false)
    assert.equal(errors.isBackendEnvelope(null), false)
  })

  check('failure envelope → BackendError 保留 code / message / method / callId', () => {
    const error = errors.backendErrorFromPayload({
      code: 'not-found',
      message: '表不存在',
      method: 'describeTable',
      callId: 'dbstudio:describeTable'
    })
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'BackendError')
    assert.equal(error.code, 'not-found')
    assert.equal(error.message, '表不存在')
    assert.equal(error.method, 'describeTable')
    assert.equal(error.callId, 'dbstudio:describeTable')
    assert.equal(errors.isBackendError(error), true)
  })

  check('普通 Error 保留原 message，未知分类默认 internal', () => {
    const payload = errors.toBackendErrorPayload(new Error('连接失败'), {
      method: 'connectConnection',
      callId: 'dbstudio:connectConnection'
    })
    assert.equal(payload.code, 'internal')
    assert.equal(payload.message, '连接失败')
    assert.equal(payload.method, 'connectConnection')
    assert.equal(payload.callId, 'dbstudio:connectConnection')
  })

  check('驱动 RPC 错误 code 映射为 backend code，并保留 rpcCode', () => {
    const error = new Error('SQL 执行失败')
    error.code = 'query_failed'
    const payload = errors.toBackendErrorPayload(error, { method: 'runQuery' })
    assert.equal(payload.code, 'internal')
    assert.equal(payload.message, 'SQL 执行失败')
    assert.deepEqual(payload.details, { rpcCode: 'query_failed' })
  })

  check('已有合法 BackendError code / details / retryable 保留', () => {
    const original = new errors.BackendError({
      code: 'conflict',
      message: '并发修改',
      details: { table: 'users', expectedVersion: 3 },
      retryable: true
    })
    const payload = errors.toBackendErrorPayload(original, { method: 'applyEdits' })
    assert.equal(payload.code, 'conflict')
    assert.equal(payload.message, '并发修改')
    assert.equal(payload.retryable, true)
    assert.equal(payload.method, 'applyEdits')
    assert.deepEqual(payload.details, { table: 'users', expectedVersion: 3 })
  })

  check('非 Error 值也能得到可读 message', () => {
    assert.equal(errors.toBackendErrorPayload('磁盘满了').message, '磁盘满了')
    assert.equal(errors.toBackendErrorPayload({ message: '对象错误' }).message, '对象错误')
    assert.equal(errors.toBackendErrorPayload({ error: '嵌套错误' }).message, '嵌套错误')
    assert.equal(errors.toBackendErrorPayload(null).code, 'internal')
    assert.match(errors.toBackendErrorPayload(null).message, /未知错误/)
  })

  check('普通 Error 的 stack / cause 不进入 payload', () => {
    const cause = new Error('secret-cause')
    const error = new Error('plain failure', { cause })
    const payload = errors.toBackendErrorPayload(error)
    assert.equal(payload.details, undefined)
    assert.equal('stack' in payload, false)
    assert.equal('cause' in payload, false)
    const json = JSON.stringify(payload)
    assert.doesNotMatch(json, /secret-cause/)
    assert.doesNotMatch(json, /at .*:\d+:\d+/)
  })

  check('details 会剔除 stack / cause，并对凭据键脱敏', () => {
    const payload = errors.toBackendErrorPayload(
      new errors.BackendError({
        code: 'internal',
        message: 'boom',
        details: {
          table: 'users',
          password: 'hunter2',
          nested: { token: 'abc', keep: 'ok', stack: 'secret-stack', cause: new Error('inner-cause') }
        }
      })
    )
    const details = payload.details
    assert.equal(details.table, 'users')
    assert.equal('password' in details, false)
    assert.equal(details.nested.keep, 'ok')
    assert.equal('token' in details.nested, false)
    assert.equal('stack' in details.nested, false)
    assert.equal('cause' in details.nested, false)
    assert.equal('stack' in payload, false)
    const json = JSON.stringify(payload)
    assert.doesNotMatch(json, /hunter2|secret-stack|inner-cause/)
    assert.doesNotThrow(() => structuredClone(payload))
  })

  check('backend-client 统一再导出 error helpers / types', () => {
    assert.equal(typeof client.toBackendErrorPayload, 'function')
    assert.equal(typeof client.backendErrorFromPayload, 'function')
    assert.equal(typeof client.isBackendEnvelope, 'function')
    assert.equal(typeof client.isBackendErrorPayload, 'function')
    assert.equal(client.toBackendErrorPayload(new Error('x')).code, 'internal')
    const restored = client.backendErrorFromPayload({
      code: 'timeout',
      message: '超时'
    })
    assert.equal(restored.code, 'timeout')
    assert.equal(restored.message, '超时')
  })
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n===== Renderer 后端契约：${pass} 通过 / ${fail} 失败 =====`)
process.exitCode = fail > 0 ? 1 : 0
