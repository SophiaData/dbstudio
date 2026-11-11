// Compile an isolated debug artifact only. Never launch a window, service or secret consumer.
import assert from 'node:assert/strict'
import { acquireBuildStorage, storagePolicyBinding } from './mysql-acceptance-storage.mjs'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
assert.equal(process.argv.length, 2, 'this compile-only entry accepts no arguments or credential/profile paths')
const base = join(root, 'backups')
assert.ok(lstatSync(base).isDirectory() && !lstatSync(base).isSymbolicLink())
const storage = acquireBuildStorage({ root })
let run = null
let frontend = null
let target = null
let configPath = null
let environment = null
const expectedTests = [
  'mysql_host_negative_run_id_and_phase_fail_before_root_creation',
  'mysql_host_negative_wrong_root_manifest_and_restart_fail_closed',
  'mysql_host_initial_restart_keep_store_and_namespace_without_vault_access',
  'mysql_host_negative_symlink_root_rejected_without_touching_target',
  'mysql_host_negative_prepared_not_ready_manifest_rejected',
  'mysql_host_negative_zero_port_rejected_when_ready',
  'mysql_host_negative_manifest_permissions_rejected',
  'mysql_host_negative_app_secret_permissions_rejected_without_read',
  'mysql_host_negative_manifest_hardlink_rejected',
  'mysql_host_negative_app_secret_hardlink_rejected_without_read',
  'mysql_host_negative_manifest_symlink_rejected_without_following',
  'mysql_host_bridge_origin_rejects_remote_dev_and_nonmain',
  'mysql_host_bridge_password_phase_precedes_file_access',
  'mysql_host_bridge_password_reads_only_app_and_strips_one_lf',
  'mysql_host_bridge_password_rechecks_permissions_and_hardlinks',
  'mysql_host_bridge_password_rejects_symlink_without_reading',
  'mysql_host_bridge_password_rejects_encoding_size_and_multiline',
  'mysql_host_bridge_password_script_escapes_and_guards_target',
  'mysql_host_bridge_report_success_exact_envelope_is_exclusive',
  'mysql_host_bridge_report_rejects_unknown_fields_checks_and_messages',
  'mysql_host_bridge_report_rejects_bad_numbers_hashes_and_pages',
  'mysql_host_bridge_report_failure_retained_but_not_promoted',
  'mysql_host_restart_report_success_strict_schema',
  'mysql_host_restart_report_rejects_extra_fields_and_wrong_types',
  'mysql_host_restart_report_rejects_missing_row_and_required_hashes',
  'mysql_host_restart_report_rejects_inconsistent_stage_hashes',
  'mysql_host_restart_report_partial_failure_allows_unreached_nulls',
  'mysql_host_restart_reports_keep_initial_and_restart_exclusive',
  'mysql_host_restart_wrong_phase_never_creates_report',
  'mysql_host_restart_password_script_rejected_before_secret_metadata',
  'mysql_host_probe_schema_phase_source_and_business_gate',
  'mysql_host_probe_retains_unique_boolean_report_and_zero_observations',
  'mysql_host_attempt_phase_maps_restart_and_preserves_reports',
  'mysql_host_attempt_frontend_trace_schema_phase_and_noop',
  'mysql_host_attempt_trace_owned_append_sequence_and_record_cap',
  'mysql_host_attempt_trace_rejects_unknown_pairs_and_byte_cap',
  'mysql_host_attempt_native_method_classification_is_closed',
  'mysql_host_attempt_keyring_mock_trace_shares_sequence_without_vault',
  'mysql_host_explain_phase_requires_existing_root_and_rejects_password',
  'mysql_host_explain_report_rejects_extra_fields_phase_and_types',
  'mysql_host_explain_report_plan_counts_hashes_and_null_gates',
  'mysql_host_explain_report_action_and_elapsed_bounds',
  'mysql_host_explain_report_partial_failure_not_promoted',
  'mysql_host_explain_pid_report_preserves_history_and_trace_contract',
  'mysql_host_commit_phase_source_and_password_gate',
  'mysql_host_commit_checkpoint_schema_and_fixed_states',
  'mysql_host_commit_order_idempotency_and_missing_ack',
  'mysql_host_commit_false_ack_never_unlocks_next_step',
  'mysql_host_commit_wrong_ack_identity_hash_and_fields_rejected',
  'mysql_host_commit_ack_rejects_links_permissions_bounds_and_wrong_inode',
  'mysql_host_commit_atomic_publication_preserves_existing_files',
  'mysql_host_commit_final_report_strict_schema_hashes_and_actions',
  'mysql_host_commit_partial_failure_retained_without_ack_promotion',
  'mysql_host_commit_three_ack_report_pid_preserves_history',
  'mysql_host_deadlock_phase_password_source_and_snapshot_scope',
  'mysql_host_deadlock_checkpoint_schema_keeps_observed_red',
  'mysql_host_deadlock_order_payload_idempotency_and_wrapper',
  'mysql_host_deadlock_wrong_proof_and_false_ack_do_not_advance',
  'mysql_host_deadlock_ack_identity_links_modes_and_bounds_rejected',
  'mysql_host_deadlock_actual_result_recorder_never_synthesizes_state',
  'mysql_host_deadlock_final_schema_bounds_and_green_requirements',
  'mysql_host_deadlock_partial_stale_and_other_error_report_retained',
  'mysql_host_deadlock_green_requires_three_ack_and_actual_native_state',
  'mysql_host_deadlock_atomic_files_preserve_old_and_other_phase_snapshots',
  'mysql_host_duplicate_phase_scope_password_and_origin_gates',
  'mysql_host_duplicate_payload_fixed_steps_allow_bad_failed_state',
  'mysql_host_duplicate_order_idempotency_missing_wrong_and_false_ack',
  'mysql_host_duplicate_actual_ok_false_scalars_preserve_rpc_semantics',
  'mysql_host_duplicate_files_reject_links_bounds_and_preserve_existing',
  'mysql_host_duplicate_final_schema_proof_actions_and_phase_bounds',
  'mysql_host_duplicate_two_ack_bad_state_partial_report_retained',
  'mysql_host_duplicate_none_requires_native_witness_rollback_and_three_ack',
  'mysql_host_timeout_phase_password_origin_and_snapshot_scope',
  'mysql_host_timeout_marker_settings_hard_gate_failed_bad_state_allowed',
  'mysql_host_timeout_order_idempotency_missing_wrong_and_false_ack',
  'mysql_host_timeout_actual_ok_false_scalars_and_stale_state_retained',
  'mysql_host_timeout_files_reject_links_bounds_and_preserve_existing',
  'mysql_host_timeout_final_schema_settings_proof_actions_bounds',
  'mysql_host_timeout_two_ack_bad_state_and_settings_partial_preserved',
  'mysql_host_timeout_none_requires_native_witness_settings_and_rollback',
  'mysql_host_precision_phase_password_origin_and_snapshot_scope',
  'mysql_host_precision_payload_fixed_ends_and_partial_red_allowed',
  'mysql_host_precision_four_step_order_idempotency_and_ack_gate',
  'mysql_host_precision_actual_apply_metadata_no_text_or_state_synthesis',
  'mysql_host_precision_files_reject_links_bounds_and_preserve_existing',
  'mysql_host_precision_final_schema_hash_witness_actions_bounds',
  'mysql_host_precision_three_ack_bad_values_partial_report_preserved',
  'mysql_host_precision_none_requires_four_ack_applied_native_and_commit',
  'mysql_host_text_phase_password_origin_and_snapshot_scope',
  'mysql_host_text_payload_values_hash_fixed_ends_and_wide_red',
  'mysql_host_text_four_step_idempotency_wrapper_and_ack_equality',
  'mysql_host_text_actual_ok_false_metadata_never_copies_sql_or_error',
  'mysql_host_text_preview_pairs_boundaries_allow_actual_bad_prefix',
  'mysql_host_text_final_schema_allows_compact_canonical_difference',
  'mysql_host_text_partial_one_to_four_ack_bad_preview_and_calls_preserved',
  'mysql_host_text_none_requires_four_native_fetch_snapshots_and_commit',
  'mysql_host_text_files_reject_links_bounds_and_preserve_existing',
  'mysql_host_session_timezone_phase_password_origin_snapshot_scope',
  'mysql_host_session_timezone_payload_baseline_hard_later_wide',
  'mysql_host_session_timezone_order_idempotency_wrapper_and_ack',
  'mysql_host_session_timezone_actual_successful_state_only',
  'mysql_host_session_timezone_stage_schema_strings_and_green_epoch',
  'mysql_host_session_timezone_two_ack_set_rejected_readback_retained',
  'mysql_host_session_timezone_none_requires_three_native_caches_no_writes',
  'mysql_host_session_timezone_files_reject_links_bounds_preserve_existing',
  'mysql_host_time_phase_password_origin_and_snapshot_scope',
  'mysql_host_time_payload_baseline_state_and_positive_witness',
  'mysql_host_time_four_step_idempotency_wrapper_and_ack_equality',
  'mysql_host_time_actual_ok_false_and_err_metadata_no_sql_body',
  'mysql_host_time_schema_arrays_categories_editors_and_green_values',
  'mysql_host_time_one_ack_bad_baseline_header_and_raw_values_retained',
  'mysql_host_time_partial_editor_apply_and_commit_failures_preserved',
  'mysql_host_time_none_requires_four_cached_native_and_final_current_state',
  'mysql_host_time_files_reject_links_bounds_and_preserve_existing',
  'mysql_host_crosszone_phase_password_origin_snapshot_scope',
  'mysql_host_crosszone_payload_exact_shape_and_bounds',
  'mysql_host_crosszone_step_order_idempotency_and_ack_equality',
  'mysql_host_crosszone_stage_schema_and_canonical_values',
  'mysql_host_crosszone_partial_red_retained_without_promotion',
  'mysql_host_crosszone_none_requires_three_native_snapshots',
  'mysql_host_crosszone_files_reject_links_bounds_and_preserve_existing',
  'mysql_host_crosszone_actual_native_snapshot_not_replaced_by_expected',
  'mysql_host_binary_phase_password_origin_and_snapshot_scope',
  'mysql_host_binary_request_exact_ten_fields_and_ranges',
  'mysql_host_binary_request_carries_no_sql_path_or_expected',
  'mysql_host_binary_step_order_idempotency_and_covered_replay',
  'mysql_host_binary_ack_equality_forgery_and_false_verified',
  'mysql_host_binary_continue_returns_exact_ready_verified',
  'mysql_host_binary_read_only_red_keeps_one_stage_and_actual_rows',
  'mysql_host_binary_null_empty_and_zero_byte_stay_distinct',
  'mysql_host_binary_bit_values_stay_unsigned_decimal_strings',
  'mysql_host_binary_none_requires_four_stages_and_native_counts',
  'mysql_host_binary_native_counts_are_never_pre_rejected',
  'mysql_host_binary_files_reject_links_bounds_and_preserve_existing',
  'mysql_host_binary_actual_is_never_replaced_by_expected',
  'mysql_host_binary_proof_stage_gap_editor_and_failure_bounds',
  'mysql_host_initial_keyring_set_trace_is_closed_and_secret_free',
  'mysql_host_initial_keyring_diagnostics_keep_snapshot_and_failure_contract',
  'mysql_host_platform_osstatus_downcast_is_typed_and_secret_free',
  'mysql_host_initial_platform_osstatus_trace_is_canonical_and_phase_bounded'
].sort()
let verifiedTests = []
let viteIsolation = null
let diagnosticBytes = 0
const stages = []
function command(name, program, args) {
  const result = spawnSync(program, args, { cwd: root, env: environment, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  diagnosticBytes += Buffer.byteLength(result.stdout ?? '') + Buffer.byteLength(result.stderr ?? '')
  const passed = !result.error && result.status === 0
  stages.push({ name, passed, exitCode: result.status, spawnErrorCode: result.error?.code ?? null })
  if (!passed) throw new Error(`MYSQL_ACCEPTANCE_BUILD_STAGE_FAILED:${name}`)
  return result.stdout ?? ''
}
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const sourcePaths = [
  'apps/desktop/src/main.ts', 'apps/desktop/src/App.vue', 'apps/desktop/src/mysql-parity-dom.ts',
  'apps/desktop/src/components/ConnectionDialog.vue', 'apps/desktop/src/components/SqlEditor.vue',
  'apps/desktop/src/components/ResultGrid.vue', 'apps/desktop/src/workbench.ts', 'apps/desktop/src/backend.ts',
  'src-tauri/src/lib.rs', 'src-tauri/src/mysql_acceptance.rs', 'src-tauri/Cargo.toml', 'src-tauri/build.rs',
  'src-tauri/tauri.conf.json', 'src-tauri/tauri.mysql-acceptance.conf.json', 'src-tauri/capabilities/main.json',
  'scripts/build-mysql-acceptance.mjs', 'Cargo.lock', 'crates/dbstudio-drivers/src/mysql.rs', 'crates/dbstudio-core/src/lib.rs',
  'apps/desktop/src/components/CellViewer.vue', 'apps/desktop/src/result-export.ts', 'crates/dbstudio-drivers/src/network.rs',
  'src/core/resultset.ts'
].sort((a, b) => a.localeCompare(b))
function sourceSnapshot() {
  const canonical = realpathSync(root)
  return Object.fromEntries(sourcePaths.map(name => {
    const path = join(root, name); const metadata = lstatSync(path)
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1)
    assert.equal(realpathSync(path), join(canonical, name))
    return [name, hash(path)]
  }))
}
const snapshotHash = (files) => createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
function frontendSnapshot() {
  const files = {}; const canonical = realpathSync(frontend)
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); const metadata = lstatSync(path)
      assert.ok(!metadata.isSymbolicLink())
      assert.ok(realpathSync(path).startsWith(canonical + sep))
      if (metadata.isDirectory()) visit(path)
      else {
        assert.ok(metadata.isFile() && metadata.nlink === 1)
        const name = relative(frontend, path).split(sep).join('/')
        files[name] = hash(path); assert.ok(Object.keys(files).length <= 200)
      }
    }
  }
  visit(frontend)
  assert.ok(files['index.html'])
  return files
}
let sourceFiles = null
let sourceSnapshotSha256 = null
let frontendAssets = null
let sourceHead = null
let sourceDirtyPaths = []
let passed = false
let binary
let runId = null
try {
  runId = randomUUID().replaceAll('-', '')
  run = join(base, `mysql-acceptance-host-build-${runId}`)
  mkdirSync(run, { mode: 0o700 })
  frontend = join(run, 'frontend')
  target = join(run, 'target')
  const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.mysql-acceptance.conf.json'), 'utf8'))
  assert.equal(config.identifier, 'io.dbstudio.mysql-acceptance')
  assert.deepEqual(config.app.windows, [])
  assert.equal(config.build.devUrl, null)
  config.build.frontendDist = frontend
  configPath = join(run, 'tauri-test-config.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 })
  environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DBSTUDIO_') && !name.startsWith('VITE_') && !['NODE_OPTIONS', 'TAURI_CONFIG', 'TAURI_ENV_DEBUG', 'CARGO_TARGET_DIR'].includes(name)))
  Object.assign(environment, {
    VITE_DBSTUDIO_TEST_HOOKS: '0', VITE_MYSQL_PARITY: '1', OPENSSL_STATIC: '1',
    CARGO_TARGET_DIR: target, CARGO_NET_OFFLINE: 'true', TAURI_CONFIG: JSON.stringify(config)
  })
  sourceFiles = sourceSnapshot()
  sourceSnapshotSha256 = snapshotHash(sourceFiles)
  sourceHead = command('direct-source-head', 'git', ['rev-parse', 'HEAD']).trim()
  assert.match(sourceHead, /^[a-f0-9]{40}$/)
  sourceDirtyPaths = command('direct-source-dirty-paths', 'git', ['diff', '--name-only', 'HEAD', '--', ...sourcePaths]).trim().split('\n').filter(Boolean)
  assert.ok(sourceDirtyPaths.every(name => sourcePaths.includes(name)))
  for (const script of ['node_modules/vue-tsc/bin/vue-tsc.js', 'node_modules/@tauri-apps/cli/tauri.js']) assert.ok(existsSync(join(root, script)), 'required locked local tool is unavailable; no install fallback')
  command('vue-typecheck', process.execPath, [join(root, 'node_modules/vue-tsc/bin/vue-tsc.js'), '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
  // Do not load appRoot Vite config or any real .env file. Both sentinels are newly-created synthetic evidence.
  const envDir = join(run, 'synthetic-env')
  mkdirSync(envDir, { mode: 0o700 })
  for (const name of ['.env', '.env.production']) writeFileSync(join(envDir, name), 'VITE_ACCEPTANCE_ENV_SENTINEL=must-not-load\n', { flag: 'wx', mode: 0o600 })
  const isolatedVite = join(run, 'vite-isolated-build.mjs')
  const isolationProof = join(run, 'vite-isolation.json')
  const worker = `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
const root = ${JSON.stringify(join(root, 'apps/desktop'))};
const envDir = ${JSON.stringify(envDir)};
const proofPath = ${JSON.stringify(isolationProof)};
const expected = ['VITE_DBSTUDIO_TEST_HOOKS', 'VITE_MYSQL_PARITY'].sort();
assert.deepEqual(Object.keys(process.env).filter(key => key.startsWith('VITE_')).sort(), expected);
let resolved = false;
await build({ configFile: false, envFile: false, envDir, root, clearScreen: false,
  plugins: [vue(), { name: 'acceptance-env-isolation-proof', configResolved(config) {
    assert.equal(config.envFile, false);
    assert.equal(config.envDir, false);
    assert.equal(config.inlineConfig.envDir, envDir);
    assert.equal(config.configFile, undefined);
    assert.deepEqual(Object.keys(config.env).filter(key => key.startsWith('VITE_')).sort(), expected);
    assert.equal(config.env.VITE_DBSTUDIO_TEST_HOOKS, '0');
    assert.equal(config.env.VITE_MYSQL_PARITY, '1');
    assert.equal(config.env.VITE_ACCEPTANCE_ENV_SENTINEL, undefined);
    writeFileSync(proofPath, JSON.stringify({ envFileDisabled: true, configFileDisabled: true, runOwnedEnvDir: true,
      inheritedViteVariablesFiltered: true, sentinelAbsent: true, onlyExplicitViteFlags: true }), { flag: 'wx', mode: 0o600 });
    resolved = true;
  } }], build: { outDir: ${JSON.stringify(frontend)}, emptyOutDir: false, target: 'es2022' } });
assert.equal(resolved, true);
`
  writeFileSync(isolatedVite, worker, { flag: 'wx', mode: 0o600 })
  command('fresh-frontend-env-isolated', process.execPath, [isolatedVite])
  viteIsolation = JSON.parse(readFileSync(isolationProof, 'utf8'))
  assert.equal(viteIsolation.sentinelAbsent, true)
  assert.ok(existsSync(join(frontend, 'index.html')))
  // This filter is limited to newly reviewed retain-only cases, not old lifecycle suites.
  storage.checkHeavyStage('host-negative-and-contract-tests')
  const tests = command('host-negative-and-contract-tests', 'cargo', ['test', '--offline', '--locked', '-p', 'dbstudio-desktop', '--lib', '--features', 'mysql-acceptance', 'mysql_host_', '--', '--test-threads=1'])
  verifiedTests = [...tests.matchAll(/^test mysql_acceptance::tests::(mysql_host_[a-z0-9_]+) \.\.\. ok$/gm)].map(match => match[1]).sort()
  assert.deepEqual(verifiedTests, expectedTests, 'the exact new retain-only test set must execute')
  assert.match(tests, new RegExp(`test result: ok\\. ${expectedTests.length} passed; 0 failed; 0 ignored; 0 measured;`))
  storage.checkHeavyStage('sqlite-smoke-cfg-compile-only')
  command('sqlite-smoke-cfg-compile-only', 'cargo', ['check', '--offline', '--locked', '-p', 'dbstudio-desktop', '--no-default-features', '--features', 'test-hooks'])
  storage.checkHeavyStage('debug-test-artifact')
  command('debug-test-artifact', process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--debug', '--no-bundle', '--features', 'mysql-acceptance', '--config', configPath])
  binary = join(target, 'debug', process.platform === 'win32' ? 'dbstudio-desktop.exe' : 'dbstudio-desktop')
  assert.ok(existsSync(binary) && lstatSync(binary).isFile() && !lstatSync(binary).isSymbolicLink())
  assert.deepEqual(sourceSnapshot(), sourceFiles, 'direct source changed during compilation')
  frontendAssets = frontendSnapshot()
  passed = true
} catch (error) {
  // No raw child diagnostics, SQL, env, paths or secrets are printed.
  stages.push({ name: 'build-result', passed: false, code: /^MYSQL_ACCEPTANCE_BUILD_STAGE_FAILED:[a-z-]+$/.test(error.message) ? error.message : 'BUILD_VALIDATION_FAILED' })
} finally {
  let storageLifecycle = null
  try {
    storageLifecycle = storage.close({ runId: run ? runId : null, passed })
  } catch {
    passed = false
    stages.push({ name: 'storage-recycle', passed: false, code: 'STORAGE_CLOSE_FAILED' })
  }
  if (passed && (!storageLifecycle?.closed || storageLifecycle.failureCode !== null || storageLifecycle.recycle?.passed !== true)) {
    passed = false
    stages.push({ name: 'storage-recycle', passed: false, code: storageLifecycle?.failureCode ?? 'STORAGE_RECYCLE_FAILED' })
  }
  if (run && configPath && existsSync(configPath)) {
    const report = {
      scope: 'compile-only-debug-mysql-acceptance-host', passed, guiLaunched: false, mysqlConnected: false,
      productionArtifact: false, stages, diagnosticBytes, viteIsolation, expectedTests, verifiedTests,
      sourceFiles, sourceSnapshotSha256, frontendAssets, mysqlParity: 1, testHooks: 0,
      sourceSnapshotScope: '23-direct-files-not-the-transitive-native-source-closure', sourceHead, sourceDirtyPaths,
      sqliteSmokeCheckOnly: stages.some(stage => stage.name === 'sqlite-smoke-cfg-compile-only' && stage.passed),
      feature: 'mysql-acceptance', profile: 'debug', automaticWindows: 0,
      webviewStorageApi: 'data_store_identifier', minimumMacos: 14,
      keyringServicePrefix: 'io.dbstudio.acceptance.mysql.',
      storagePolicy: storagePolicyBinding(), storageLifecycle,
      cargoLockSha256: hash(join(root, 'Cargo.lock')),
      testConfigSha256: hash(configPath), frontendIndexSha256: existsSync(join(frontend, 'index.html')) ? hash(join(frontend, 'index.html')) : null,
      binarySha256: passed ? hash(binary) : null,
      binary: passed ? binary : null,
      evidenceDirectory: run,
      commandParameters: { testPackage: 'dbstudio-desktop', testFilter: 'mysql_host_', testThreads: 1, compile: ['build', '--debug', '--no-bundle', '--features', 'mysql-acceptance', '--config', 'per-run-test-config'] }
    }
    try {
      writeFileSync(join(run, 'build-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      console.log(JSON.stringify(report, null, 2))
    } catch {
      // A failed publication is closed: no raw stack, no path, and no passed report.
      passed = false
      stages.push({ name: 'build-report', passed: false, code: 'MYSQL_ACCEPTANCE_REPORT_WRITE_FAILED' })
      process.stderr.write('MYSQL_ACCEPTANCE_REPORT_WRITE_FAILED\n')
      process.exitCode = 1
    }
  }
  if (!passed) process.exitCode = 1
  // Only this successful run's three caches are recycled; failed diagnostics and old runs remain.
}
