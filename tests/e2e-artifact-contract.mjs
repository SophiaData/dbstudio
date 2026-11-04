/** 远程 artifact contract 的纯 Node 契约测试。 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-artifact-contract-'))
const bundle = join(outDir, 'artifact.mjs')
let pass = 0
let fail = 0

async function check(name, run) {
  try {
    await run()
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
          artifact: resolve(root, 'src/backend/contract/artifact.ts')
        },
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.mjs`
      }
    }
  })

  assert.ok(existsSync(bundle))
  const artifact = await import(pathToFileURL(bundle).href)
  const {
    ARTIFACT_TICKET_HEADER,
    isArtifactId,
    isArtifactReference,
    isSha256
  } = artifact

  await check('artifact ticket header 固定且不依赖 URL query', () => {
    assert.equal(ARTIFACT_TICKET_HEADER, 'x-dbstudio-artifact-ticket')
  })

  await check('artifact id 只接受 opaque、有限长度格式', () => {
    assert.equal(isArtifactId('artifact_1234567890abcdef'), true)
    assert.equal(isArtifactId('artifact_short'), false)
    assert.equal(isArtifactId('../connections.json'), false)
    assert.equal(isArtifactId('artifact_../../secrets'), false)
  })

  await check('artifact reference 强制 purpose 匹配', () => {
    assert.equal(
      isArtifactReference({ artifactId: 'artifact_1234567890abcdef', purpose: 'import-source' }),
      true
    )
    assert.equal(
      isArtifactReference({ artifactId: 'artifact_1234567890abcdef', purpose: 'export-result' }),
      true
    )
    assert.equal(
      isArtifactReference({ artifactId: 'artifact_1234567890abcdef', purpose: 'import' }),
      false
    )
    assert.equal(isArtifactReference({ artifactId: 'artifact_1234567890abcdef' }), false)
  })

  await check('sha256 校验只接受 64 位十六进制摘要', () => {
    assert.equal(isSha256('a'.repeat(64)), true)
    assert.equal(isSha256('g'.repeat(64)), false)
    assert.equal(isSha256('a'.repeat(63)), false)
  })
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n===== Artifact contract：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exitCode = 1
