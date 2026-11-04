/**
 * API surface golden snapshot。
 *
 * method manifest 已经是 Electron IPC、preload 与 application contract 的共同来源，
 * 但「新增了方法」本身仍可能是一次不经意的公开 API 变化。这个测试把当前发布面
 * 固定成可审查的 golden 文件：有意扩展 API 时必须同步更新 snapshot 并在 review
 * 中看到完整变更。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-api-surface-'))
const manifestBundle = join(outDir, 'method-manifest.mjs')
const goldenPath = join(root, 'tests/api-surface.golden.json')

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
        entry: resolve(root, 'src/backend/contract/method-manifest.ts'),
        formats: ['es'],
        fileName: () => 'manifest.mjs'
      }
    }
  })

  assert.ok(existsSync(manifestBundle), 'manifest bundle 未生成')
  assert.ok(existsSync(goldenPath), 'golden snapshot 不存在')
  const { BACKEND_METHOD_MANIFEST } = await import(pathToFileURL(manifestBundle).href)
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))
  assert.deepEqual(BACKEND_METHOD_MANIFEST, golden)
  console.log(`API surface golden：${golden.length} 个方法通过`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
