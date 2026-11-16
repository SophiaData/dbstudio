// Source-level SDK protocol regressions; the NDJSON peer is synthetic, not a database.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const viteRequire = createRequire(require.resolve('vite'))
const { buildSync } = viteRequire('esbuild')
const bundle = (options) => buildSync({
  bundle: true, platform: 'node', target: 'node22', write: false, ...options
}).outputFiles[0].text
const sdkSource = bundle({
  stdin: {
    contents: `export { DriverHost } from './sdk/src/host.ts'; export {
      HANDSHAKE_PROTOCOL_VERSION, DRIVER_API_VERSION, METADATA_SCHEMA_VERSION,
      TRANSFER_SCHEMA_VERSION, SDK_CONTRACT_VERSION
    } from './src/core/driver.ts'`,
    resolveDir: root, loader: 'ts'
  }, format: 'esm'
})
const work = mkdtempSync(join(tmpdir(), 'dbstudio-audit-sdk-'))
const sdkScript = join(work, 'sdk-source.mjs')
writeFileSync(sdkScript, sdkSource, { flag: 'wx' })
const sdk = await import(pathToFileURL(sdkScript).href)
const peerScript = join(work, 'ndjson-peer.cjs')
const peerSource = bundle({
  stdin: {
    contents: `
      import { createInterface } from 'node:readline'
      import { normalizeSqlParameterValue } from './src/core/sql-parameters.ts'
      const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
      send({ kind: 'handshake', dialectId: 'sqlite', adapterVersion: 'synthetic-peer',
        protocolVersion: ${sdk.HANDSHAKE_PROTOCOL_VERSION},
        driverApiVersion: ${sdk.DRIVER_API_VERSION},
        metadataSchemaVersion: ${sdk.METADATA_SCHEMA_VERSION},
        transferSchemaVersion: ${sdk.TRANSFER_SCHEMA_VERSION},
        sdkContractVersion: ${sdk.SDK_CONTRACT_VERSION},
        pid: process.pid, nodeVersion: process.version, platform: process.platform })
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
      input.on('line', (line) => {
        const request = JSON.parse(line)
        try {
          if (request.params?.sql?.startsWith('rpc-error:')) {
            const code = request.params.sql.slice('rpc-error:'.length)
            send({ id: request.id, ok: false, error: code === 'missing'
              ? {} : { code, message: 'synthetic RPC failure' } })
            return
          }
          const values = (request.params?.options?.parameters ?? []).map(({ value }) => {
            const normalized = normalizeSqlParameterValue(value)
            return normalized instanceof Uint8Array
              ? { kind: 'bytes', data: Array.from(normalized), wire: value }
              : { kind: normalized === null ? 'null' : typeof normalized, value: normalized }
          })
          send({ id: request.id, ok: true, result: values })
        } catch (error) {
          send({ id: request.id, ok: false, error: { code: error.code, message: error.message } })
        }
      })
      input.on('close', () => process.exit(0))
    `,
    resolveDir: root, loader: 'ts'
  }, format: 'cjs'
})
writeFileSync(peerScript, peerSource, { flag: 'wx' })
console.log(`Synthetic peer retained without deletion: ${work}`)

async function withPeer(run) {
  const host = new sdk.DriverHost({ dialectId: 'sqlite', hostScript: peerScript })
  try {
    await host.handshake
    await run(host)
  } finally {
    await host.close()
  }
}

test('SDK query and executeStatement preserve empty BLOB, zero byte, NULL and empty text over NDJSON', async () => {
  await withPeer(async (host) => {
    for (const method of ['query', 'executeStatement']) {
      const result = await host[method]('SELECT ?, ?, ?, ?', {
        parameters: [new Uint8Array(), new Uint8Array([0]), null, ''].map((value, i) => ({
          name: `?${i + 1}`, value
        }))
      })
      assert.deepEqual(result, [
        { kind: 'bytes', data: [], wire: { type: 'dbstudio-sql-bytes', data: [] } },
        { kind: 'bytes', data: [0], wire: { type: 'dbstudio-sql-bytes', data: [0] } },
        { kind: 'null', value: null },
        { kind: 'string', value: '' }
      ], method)
    }
  })
})

test('SDK preserves RPC error codes across repeated requests and keeps uncoded fallback errors', async () => {
  await withPeer(async (host) => {
    for (const method of ['query', 'executeStatement']) {
      await assert.rejects(host[method]('SELECT ?', {
        parameters: [{ name: '?1', value: {} }]
      }), (error) => {
        assert.ok(error instanceof Error)
        assert.equal(error.code, 'bad_params')
        assert.match(error.message, /parameter.value/)
        return true
      })
      for (const code of ['unsupported_method', 'not_connected', 'unsupported_method']) {
        await assert.rejects(host[method](`rpc-error:${code}`), (error) => {
          assert.ok(error instanceof Error)
          assert.equal(error.message, 'synthetic RPC failure')
          assert.equal(error.code, code)
          return true
        })
      }
      await assert.rejects(host[method]('rpc-error:missing'), (error) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'RPC 失败')
        assert.equal(error.code, undefined)
        return true
      })
      assert.deepEqual(await host[method]('SELECT 1'), [])
    }
  })
})
