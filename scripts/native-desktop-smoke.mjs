// Execute a built test-feature binary; actual business calls happen in the native WebView.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binary = resolve(root, 'target/debug', process.platform === 'win32' ? 'dbstudio-desktop.exe' : 'dbstudio-desktop')
assert.ok(existsSync(binary), '先构建 debug 原生桌面与 test-hooks；本脚本不会替换后端或模拟网络')
const fixtureRoot = join(tmpdir(), `dbstudio-native-smoke-${randomUUID()}`)
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('DBSTUDIO_') && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(key)))
environment.DBSTUDIO_NATIVE_SMOKE_ROOT = fixtureRoot
let timedOut = false
let signalTimer
const child = spawn(binary, [], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
// Only byte counts are retained: native errors may otherwise include database/path values.
let diagnosticBytes = 0
child.stdout.on('data', (value) => { diagnosticBytes += value.length })
child.stderr.on('data', (value) => { diagnosticBytes += value.length })
const timeout = setTimeout(() => {
  timedOut = true
  child.kill('SIGTERM')
  signalTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
}, 90000)
try {
  const result = await new Promise((resolveResult, reject) => {
    child.once('error', () => reject(new Error('无法启动原生桌面测试进程')))
    child.once('exit', (code, signal) => resolveResult({ code, signal }))
  })
  assert.equal(timedOut, false, '原生WebView未在时限内完成；不会计为通过')
  const path = join(fixtureRoot, 'report.json')
  assert.ok(existsSync(path), '原生测试必须产生报告，启动成功不等于业务验证成功')
  const report = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(Object.keys(report).sort(), ['checks', 'ok'])
  if (report.ok !== true && report.checks && typeof report.checks === 'object') {
    const failures = Object.entries(report.checks).filter(([name, passed]) => /^[A-Za-z0-9_-]{1,64}$/.test(name) && passed === false).map(([name]) => name)
    console.error(`Native boolean checks failed: ${failures.join(', ') || 'incomplete-report'}`)
  }
  assert.equal(result.code, 0, `原生桌面退出失败（仅保留诊断字节数：${diagnosticBytes}）`)
  assert.equal(report.ok, true)
  const required = [
    'isolated_fixture', 'connection', 'paging', 'native_apply', 'committed_value', 'rollback_restores',
    'guard_cancel_preserves_tabs', 'guard_cross_tab_dirty', 'guard_rollback', 'guard_apply_commit',
    'ui_execution_owner_stays_with_query', 'ui_removed_connection_restores_draft',
    'ui_pk_edit_delete_tracks_new_key', 'ui_pk_delete_rollback_restores',
    'vue_schema_panel', 'vue_er_panel', 'vue_er_real_fk', 'vue_schema_compare', 'vue_data_compare',
    'ui_compare_result_invalidation', 'vue_compare_sql_review', 'vue_compare_read_only',
    'vue_csv_preview', 'ui_transfer_start_guard_before_await', 'vue_csv_import',
    'vue_export_csv', 'vue_export_jsonl', 'vue_export_json', 'vue_export_sql_insert',
    'vue_task_guards_released', 'ui_connection_edit_preserves_unlisted_options',
    'native_addConnection', 'native_executeStatement', 'native_runQuery', 'native_fetchResultPage',
    'native_applyEdits', 'native_commitTransaction', 'native_rollbackTransaction',
    'script_transaction', 'vue_active_context', 'ui_sql_draft_persisted', 'vue_er_layout_svg',
    'vue_sql_editor_format', 'vue_sql_completion', 'vue_sql_execute_current_all', 'ui_binary_parameter',
    'vue_parameterized_export', 'vue_metadata_tree', 'vue_grid_full_cell', 'vue_grid_count',
    'vue_grid_copy', 'vue_loaded_export_formats', 'vue_sql_library', 'vue_sql_library_negative',
    'vue_explain_positive', 'vue_explain_negative', 'vue_ddl_positive', 'vue_ddl_negative'
  ]
  assert.ok(report.checks && typeof report.checks === 'object')
  for (const name of required) assert.equal(report.checks[name], true, `缺少本轮原生验收检查：${name}`)
  for (const [name, passed] of Object.entries(report.checks)) {
    assert.match(name, /^[A-Za-z0-9_-]{1,64}$/)
    assert.equal(passed, true, `原生检查失败：${name}`)
    console.log(`PASS native WebView: ${name}`)
  }
  console.log(`Native desktop smoke: ${Object.keys(report.checks).length} checks passed (real Tauri invoke, Rust core and SQLite)`)
} finally {
  clearTimeout(timeout)
  clearTimeout(signalTimer)
  // Keep the isolated fixture and evidence. Never remove user or temporary files.
}
