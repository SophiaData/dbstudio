// Test-build only. All business operations originate from rendered controls.
import { invoke } from '@tauri-apps/api/core'

type FailureCode = 'NONE' | 'ISOLATION' | 'CONNECTION' | 'QUERY' | 'PAGING' | 'TREE' | 'EDIT' | 'ROLLBACK' | 'TIMEOUT' | 'DOM_FAILED' | 'NATIVE_BRIDGE'
type RestartFailureCode = Exclude<FailureCode, 'PAGING'>
interface RestartReport {
  schemaVersion: 1; runId: string; phase: 'restart'; actionDriver: 'native-dom-synthetic'
  checks: Record<'storage_marker' | 'persisted_connection' | 'credential_reconnect' | 'sql_select41' | 'table_open' | 'local_edit' | 'dirty_guard_cancel' | 'applied_pending' | 'rollback_restored', boolean>
  row: null | { id: 1; beforeSha256: string; localSha256: string; appliedSha256: string | null; rolledBackSha256: string | null }
  actions: { click: number; input: number; keydown: number; dblclick: number }; elapsedMs: number; failureCode: RestartFailureCode
}
type ExplainFailureCode = 'NONE' | 'ISOLATION' | 'CONNECTION' | 'QUERY' | 'TIMEOUT' | 'DOM_FAILED' | 'NATIVE_BRIDGE'
interface ExplainReport {
  schemaVersion: 1; runId: string; phase: 'explain'; actionDriver: 'native-dom-synthetic'
  checks: Record<'storage_marker' | 'persisted_connection' | 'credential_reconnect' | 'query_result' | 'explain_open' | 'plan_content' | 'plan_refresh' | 'return_results' | 'nontransactional', boolean>
  plan: null | { rowCount: 1; columnCount: 12; firstPlanSha256: string; refreshedPlanSha256: string | null; executedSqlSha256: string }
  actions: { click: number; input: number; keydown: number }; elapsedMs: number; failureCode: ExplainFailureCode
}
type CommitFailureCode = ExplainFailureCode | 'CHECKPOINT' | 'COMMIT'
interface CommitReport {
  schemaVersion: 1; runId: string; phase: 'commit'; actionDriver: 'native-dom-synthetic'
  checks: Record<'storage_marker' | 'persisted_connection' | 'credential_reconnect' | 'table_created' | 'baseline_committed' | 'baseline_observed' | 'pending_visible' | 'pending_isolated' | 'commit_clicked' | 'result_refreshed' | 'committed_observed' | 'nontransactional', boolean>
  row: null | { id: 1; baselineSha256: string; pendingSha256: string | null; committedSha256: string | null }
  actions: { click: number; input: number; keydown: number }; elapsedMs: number; failureCode: CommitFailureCode
}
type DeadlockFailureCode = 'NONE' | 'ISOLATION' | 'CONNECTION' | 'SETUP' | 'TREE' | 'EDIT' | 'CHECKPOINT' | 'DEADLOCK_NOT_OBSERVED' | 'MYSQL_ERROR_DETAILS_LOST' | 'DEADLOCK_TX_STATE_STALE' | 'ROLLBACK_NOTICE_MISSING' | 'RECOVERY' | 'TIMEOUT' | 'DOM_FAILED' | 'NATIVE_BRIDGE'
interface DeadlockReport {
  schemaVersion: 1; runId: string; phase: 'grid-deadlock'; actionDriver: 'native-dom-synthetic'
  checks: Record<'storage_marker' | 'persisted_connection' | 'credential_reconnect' | 'fixture_created' | 'table_open' | 'marker_applied' | 'actor_waited' | 'local_draft' | 'original_1213' | 'transaction_state_correct' | 'draft_preserved' | 'rollback_notice' | 'recovery_guard_cancel' | 'reloaded_baseline', boolean>
  proof: null | { rowCount: 132; baselineRowsSha256: string; markerRowsSha256: string; faultRowsSha256: string | null; reloadedRowsSha256: string | null; uiActiveAfterError: boolean | null; uiPendingAffectedAfterError: number | null; dirtyRowsAfterError: number | null; originalErrorClass: '1213' | '1305' | 'other' | null }
  actions: { click: number; input: number; keydown: number; dblclick: number }; elapsedMs: number; failureCode: DeadlockFailureCode
}
type DuplicateFailureCode = 'NONE' | 'ISOLATION' | 'CONNECTION' | 'SETUP' | 'TREE' | 'EDIT' | 'CHECKPOINT' | 'MYSQL_ERROR_DETAILS_LOST' | 'TRANSACTION_LOST' | 'DRAFT_LOST' | 'WITNESS_FAILED' | 'RECOVERY' | 'TIMEOUT' | 'DOM_FAILED' | 'NATIVE_BRIDGE'
interface DuplicateReport {
  schemaVersion: 1; runId: string; phase: 'grid-duplicate'; actionDriver: 'native-dom-synthetic'
  checks: Record<'storage_marker' | 'persisted_connection' | 'credential_reconnect' | 'fixture_created' | 'table_open' | 'marker_applied' | 'local_draft' | 'original_1062' | 'transaction_preserved' | 'draft_preserved' | 'same_session_witness' | 'rollback_cancel_preserved' | 'normal_rollback' | 'reloaded_baseline', boolean>
  proof: null | { rowCount: 4; baselineRowsSha256: string; markerRowsSha256: string; faultRowsSha256: string | null; restoredRowsSha256: string | null; uiActiveAfterError: boolean | null; uiPendingAffectedAfterError: number | null; dirtyRowsAfterError: number | null; originalErrorClass: '1062' | 'other' | null; witnessConnectionId: number | null; markerValueAfterError: number | null; markerValueAfterRollback: number | null }
  actions: { click: number; input: number; keydown: number; dblclick: number }; elapsedMs: number; failureCode: DuplicateFailureCode
}
type TimeoutFailureCode = DuplicateFailureCode | 'SESSION_SETTINGS'
interface TimeoutReport {
  schemaVersion: 1; runId: string; phase: 'grid-timeout'; actionDriver: 'native-dom-synthetic'
  checks: Record<Exclude<keyof DuplicateReport['checks'], 'original_1062'> | 'session_settings' | 'actor_held' | 'original_1205', boolean>
  proof: null | (Omit<NonNullable<DuplicateReport['proof']>, 'originalErrorClass'> & { originalErrorClass: '1205' | 'other' | null; sessionTimeoutSeconds: number | null; rollbackOnTimeout: boolean | null })
  actions: { click: number; input: number; keydown: number; dblclick: number }; elapsedMs: number; failureCode: TimeoutFailureCode
}
type PrecisionFailureCode = 'NONE' | 'ISOLATION' | 'CONNECTION' | 'SETUP' | 'TREE' | 'EDIT' | 'CHECKPOINT' | 'BASELINE_MISMATCH' | 'VALUE_LOSS' | 'NULL_EMPTY_LOST' | 'APPLY_FAILED' | 'TRANSACTION_LOST' | 'WITNESS_FAILED' | 'COMMIT_FAILED' | 'TIMEOUT' | 'NATIVE_BRIDGE'
interface PrecisionReport {
  schemaVersion: 1; runId: string; phase: 'grid-precision'; actionDriver: 'native-dom-synthetic'
  checks: Record<'storage_marker' | 'persisted_connection' | 'credential_reconnect' | 'fixture_created' | 'table_open' | 'exact_baseline' | 'editor_exact' | 'local_edits' | 'null_empty_distinct' | 'apply_succeeded' | 'uncommitted_transaction' | 'same_session_witness' | 'normal_commit' | 'reloaded_exact_values' | 'transaction_ended', boolean>
  proof: null | { rowCount: 1; editedColumns: 6; baselineRowsSha256: string; draftRowsSha256: string | null; appliedRowsSha256: string | null; committedRowsSha256: string | null; baselineProjectionSha256: string; uncommittedProjectionSha256: string | null; committedProjectionSha256: string | null; witnessConnectionId: number | null; uiActiveAfterApply: boolean | null; uiPendingAffectedAfterApply: number | null; dirtyRowsAfterApply: number | null; dirtyRowsBeforeApply: number | null }
  actions: { click: number; input: number; keydown: number; dblclick: number }; elapsedMs: number; failureCode: PrecisionFailureCode
}
type TextFailureCode = 'NONE' | 'ISOLATION' | 'CONNECTION' | 'SETUP' | 'TREE' | 'FULL_VALUE' | 'EDIT' | 'CHECKPOINT' | 'BASELINE_MISMATCH' | 'VALUE_LOSS' | 'JSON_LOSS' | 'PREVIEW' | 'APPLY_FAILED' | 'TRANSACTION_LOST' | 'WITNESS_FAILED' | 'COMMIT_FAILED' | 'TIMEOUT' | 'NATIVE_BRIDGE'
interface TextPreview { prefixSha256: string; prefixCodePoints: number; ellipsis: boolean }
interface TextReport {
  schemaVersion: 1; runId: string; phase: 'grid-text'; actionDriver: 'native-dom-synthetic'
  checks: Record<'storage_marker' | 'persisted_connection' | 'credential_reconnect' | 'fixture_created' | 'table_open' | 'preview_truncated' | 'baseline_full' | 'editor_full' | 'local_edits' | 'draft_full' | 'apply_succeeded' | 'uncommitted_transaction' | 'applied_full' | 'same_session_witness' | 'normal_commit' | 'committed_full' | 'reloaded_exact_values' | 'transaction_ended' | 'json_integer_exact', boolean>
  proof: null | { rowCount: 1; editedColumns: 2; baselineLongSha256: string; baselineJsonSha256: string; draftLongSha256: string | null; draftJsonSha256: string | null; appliedLongSha256: string | null; appliedJsonSha256: string | null; committedLongSha256: string | null; committedJsonSha256: string | null; baselineValuesSha256: string; draftValuesSha256: string | null; appliedValuesSha256: string | null; committedValuesSha256: string | null; uncommittedProjectionSha256: string | null; committedProjectionSha256: string | null; witnessConnectionId: number | null; uiActiveAfterApply: boolean | null; uiPendingAffectedAfterApply: number | null; dirtyRowsBeforeApply: number | null; dirtyRowsAfterApply: number | null; baselinePreview: [TextPreview, TextPreview]; appliedPreview: [TextPreview, TextPreview] | null; committedPreview: [TextPreview, TextPreview] | null }
  actions: { click: number; input: number; keydown: number; dblclick: number }; elapsedMs: number; failureCode: TextFailureCode
}
type SessionTimezoneFailureCode = 'NONE' | 'ISOLATION' | 'CONNECTION' | 'BASELINE_FAILED' | 'SET_REJECTED' | 'SESSION_MISMATCH' | 'AUTOCOMMIT_CHANGED' | 'EPOCH_LOSS' | 'CONNECTION_CHANGED' | 'TRANSACTION_CHANGED' | 'CHECKPOINT' | 'TIMEOUT' | 'NATIVE_BRIDGE'
interface SessionTimezoneStage {
  connectionId: number; sessionTimezone: string; systemTimezone: string; autocommit: boolean; epochText: string; projectionSha256: string; setFailed: boolean; uiActive: boolean; uiPendingAffected: number
}
interface SessionTimezoneReport {
  schemaVersion: 1; runId: string; phase: 'session-timezone'; actionDriver: 'native-dom-synthetic'
  checks: Record<'storage_marker' | 'persisted_connection' | 'credential_reconnect' | 'baseline_observed' | 'offset_set' | 'offset_readback' | 'restored_set' | 'restored_readback' | 'same_connection' | 'transaction_unchanged', boolean>
  proof: null | { rowCount: 1; baseline: SessionTimezoneStage; offset: SessionTimezoneStage | null; restored: SessionTimezoneStage | null }
  actions: { click: number; input: number; keydown: number; dblclick: number }; elapsedMs: number; failureCode: SessionTimezoneFailureCode
}
type TimeFailureCode = 'NONE' | 'ISOLATION' | 'CONNECTION' | 'FIXTURE_OPEN' | 'SESSION_UTC_FAILED' | 'TABLE_OPEN' | 'BASELINE_MISMATCH' | 'EDITOR_VALUE_LOSS' | 'DIRTY_VALUES_MISMATCH' | 'APPLY_REJECTED' | 'TRANSACTION_STALE' | 'WITNESS_FAILED' | 'COMMIT_FAILED' | 'RELOADED_VALUES_MISMATCH' | 'CHECKPOINT' | 'TIMEOUT' | 'NATIVE_BRIDGE'
interface TimeStage {
  values: (string | null)[]; columnTypes: string[]; valuesSha256: string; witnessConnectionId: number; witnessProjection: (string | null)[]; witnessProjectionSha256: string; uiActive: boolean; uiPendingAffected: number; dirtyRows: number
}
interface TimeEditor { raw: string; isNull: boolean; valueDisabled: boolean; nullDisabled: boolean }
interface TimeReport {
  schemaVersion: 1; runId: string; phase: 'grid-time'; actionDriver: 'native-dom-synthetic'
  checks: Record<'storage_marker' | 'persisted_connection' | 'credential_reconnect' | 'fixture_created' | 'session_utc_verified' | 'table_open' | 'baseline_exact' | 'editor_raw_exact' | 'local_edits' | 'apply_succeeded' | 'uncommitted_transaction' | 'same_session_witness' | 'normal_commit' | 'reloaded_exact_values' | 'transaction_ended' | 'temporal_types', boolean>
  proof: null | { rowCount: 1; columnCount: 5; editorOriginals: (TimeEditor | null)[]; stages: { baseline: TimeStage; draft: TimeStage | null; applied: TimeStage | null; committed: TimeStage | null } }
  actions: { click: number; input: number; keydown: number; dblclick: number }; elapsedMs: number; failureCode: TimeFailureCode
}
type CrosszoneFailureCode = 'NONE' | 'ISOLATION' | 'CONNECTION' | 'FIXTURE_OPEN' | 'SET_REJECTED' | 'SESSION_READBACK_MISMATCH' | 'TABLE_OPEN' | 'DISPLAY_VALUE_MISMATCH' | 'DISPLAY_TYPE_MISMATCH' | 'NON_TS_MUTATED' | 'EPOCH_MICROSECOND_LOST' | 'CONNECTION_CHANGED' | 'TRANSACTION_STARTED' | 'SESSION_NOT_RESTORED' | 'OBSERVER_MISMATCH' | 'CHECKPOINT' | 'TIMEOUT' | 'NATIVE_BRIDGE'
interface CrosszoneStage {
  values: (string | null)[]; columnTypes: string[]; valuesSha256: string; witnessConnectionId: number; witnessProjection: (string | null)[]; witnessProjectionSha256: string
  uiActive: boolean; uiPendingAffected: number; dirtyRows: number; sessionTimezone: string
  resultTabsBefore: number; resultTabsAfter: number; activeTabGeneration: number; activeTabOwned: boolean; nativeExecuteCount: number
}
interface CrosszoneReport {
  schemaVersion: 1; runId: string; phase: 'grid-time-crosszone'; actionDriver: 'native-dom-synthetic'
  checks: Record<'storage_marker' | 'persisted_connection' | 'credential_reconnect' | 'fixture_created' | 'baseline_utc_display' | 'shifted_plus08_display' | 'restored_utc_display' | 'non_ts_unchanged' | 'epoch_invariant' | 'microsecond_invariant' | 'session_readback' | 'same_connection' | 'transaction_unchanged' | 'observer_row_unchanged' | 'session_restored', boolean>
  proof: null | { rowCount: 1; columnCount: 5; stages: { baseline: CrosszoneStage; shifted: CrosszoneStage | null; restored: CrosszoneStage | null } }
  actions: { click: number; input: number; keydown: number; dblclick: number }; elapsedMs: number; failureCode: CrosszoneFailureCode
}
type BinaryFailureCode = 'NONE' | 'ISOLATION' | 'CONNECTION' | 'FIXTURE_OPEN' | 'TABLE_OPEN' | 'NATIVE_BRIDGE' | 'CHECKPOINT' | 'TIMEOUT' | 'BINARY_READ_FAILED' | 'READ_ONLY_BINARY' | 'BIT_EDIT_ENTRY' | 'EDITOR_VALUE_LOSS' | 'APPLY_REJECTED' | 'COMMIT_FAILED' | 'BLOB_VALUE_MISMATCH' | 'BIT_VALUE_MISMATCH'
interface BinaryRow {
  id: number; b1Hex: string | null; b1Decimal: string | null; b64Hex: string | null; b64Decimal: string | null; binHex: string | null; binByteLength: number | null; binIsNull: boolean
}
interface BinaryStage {
  rows: BinaryRow[]; rowsSha256: string; targetRowId: number; targetBinHex: string | null; targetBinIsNull: boolean; columnCategories: string[]
  blobEditableEntry: boolean; uiActive: boolean; uiPendingAffected: number; dirtyRows: number; witnessConnectionId: number; witnessProjectionSha256: string
}
interface BinaryGap { viewerOpened: boolean; viewerTitle: string | null; viewerHex: string | null; editorDialogPresent: boolean; inlineErrorText: string | null }
interface BinaryEditor { raw: string | null; isNull: boolean; valueDisabled: boolean; nullDisabled: boolean }
interface BinaryReport {
  schemaVersion: 1; runId: string; phase: 'grid-bit-blob'; actionDriver: 'native-dom-synthetic'
  checks: Record<'storage_marker' | 'persisted_connection' | 'credential_reconnect' | 'fixture_created' | 'table_open' | 'column_categories_read' | 'baseline_rows_read' | 'bit_readonly_observed' | 'blob_editable_entry' | 'local_edits' | 'apply_succeeded' | 'committed_reload_verified', boolean>
  proof: null | { rowCount: 4; columnCount: 3; rows: BinaryRow[]; rowsSha256: string; columnCategories: string[]; readonlyGap: BinaryGap | null; editorOriginal: BinaryEditor | null; stages: { baseline: BinaryStage | null; draft: BinaryStage | null; applied: BinaryStage | null; committed: BinaryStage | null } }
  actions: { click: number; input: number; keydown: number; dblclick: number }; elapsedMs: number; failureCode: BinaryFailureCode
}
interface Context {
  runId: string; phase: 'initial' | 'restart' | 'explain' | 'commit' | 'grid-deadlock' | 'grid-duplicate' | 'grid-timeout' | 'grid-precision' | 'grid-text' | 'session-timezone' | 'grid-time' | 'grid-time-crosszone' | 'grid-bit-blob'; host: '127.0.0.1'; port: number; database: string; user: string
  isolated: true; storeConfigured: true; legacyDisabled: true; sslmode: 'require'
  tables: { paging: 'items_805'; precision: 'precision_values'; composite: 'composite_rows'; import: 'import_empty' }
}
interface PageProof { offset: number; count: number; firstId: number; lastId: number; idsSha256: string; visibleMs: number }
interface UiReport {
  schemaVersion: 1; runId: string; phase: 'initial'; actionDriver: 'native-dom-synthetic'
  checks: Record<'storage_preflight' | 'connection_form' | 'sql_select41' | 'page_first' | 'page_next' | 'page_back', boolean>
  pages: { first: PageProof | null; next: PageProof | null; back: PageProof | null }
  actions: { click: number; input: number; keydown: number }; elapsedMs: number; failureCode: FailureCode
}
declare global { interface Window { __DBSTUDIO_MYSQL_ACCEPTANCE_PASSWORD_STATUS__?: 'pending' | 'filled' | 'target-mismatch' | 'unavailable' } }
let context: Context | undefined
let storagePassed = false
let started = false
const bridge = <T>(method: string, args: unknown[] = []): Promise<T> => invoke<T>('backend_call', { method, args })
export type StartupStage = 'main_enter' | 'preflight_passed' | 'app_import_enter' | 'app_import_passed' | 'app_mount_enter' | 'app_mounted' | 'listener_enter' | 'listener_passed' | 'boot_enter' | 'boot_passed' | 'dom_enter' | 'main_failed' | 'mounted_failed'
export async function traceMysqlStartup(stage: StartupStage): Promise<void> {
  if (import.meta.env.VITE_MYSQL_PARITY !== '1') return
  try { await bridge('mysqlAcceptanceStartupTrace', [{ schemaVersion: 1, stage }]) }
  catch { /* Diagnostics must not alter the existing startup error behavior. */ }
}
class DomFailure extends Error { constructor(readonly code: FailureCode) { super(code) } }
function need(value: unknown, code: FailureCode): asserts value { if (!value) throw new DomFailure(code) }

/** Called before createApp, without enumerating any storage keys or importing Workbench. */
export async function preflightMysqlParity(): Promise<void> {
  need(import.meta.env.VITE_MYSQL_PARITY === '1' && import.meta.env.VITE_DBSTUDIO_TEST_HOOKS !== '1', 'ISOLATION')
  const c = await bridge<Context>('mysqlAcceptanceContext')
  need(c && /^[a-f0-9]{32}$/.test(c.runId) && (c.phase === 'initial' || c.phase === 'restart' || c.phase === 'explain' || c.phase === 'commit' || c.phase === 'grid-deadlock' || c.phase === 'grid-duplicate' || c.phase === 'grid-timeout' || c.phase === 'grid-precision' || c.phase === 'grid-text' || c.phase === 'session-timezone' || c.phase === 'grid-time' || c.phase === 'grid-time-crosszone' || c.phase === 'grid-bit-blob') && c.host === '127.0.0.1'
    && Number.isInteger(c.port) && c.port > 0 && c.port <= 65535 && typeof c.database === 'string' && !!c.database
    && typeof c.user === 'string' && !!c.user && c.isolated === true && c.storeConfigured === true
    && c.legacyDisabled === true && c.sslmode === 'require' && c.tables?.paging === 'items_805'
    && c.tables.precision === 'precision_values' && c.tables.composite === 'composite_rows'
    && c.tables.import === 'import_empty', 'ISOLATION')
  context = c
  const marker = `dbstudio:mysql-parity:${c.runId}`
  if (c.phase === 'initial') {
    need(localStorage.length === 0 && localStorage.getItem(marker) === null, 'ISOLATION')
    localStorage.setItem(marker, c.runId)
    need(localStorage.getItem(marker) === c.runId && Number(localStorage.length) === 1, 'ISOLATION')
  } else {
    need(localStorage.length >= 1 && localStorage.getItem(marker) === c.runId, 'ISOLATION')
  }
  storagePassed = true
}

/** No Workbench/controller is accepted here. Never read any password property. */
export async function runMysqlParityDom(): Promise<void> {
  if (started) return
  started = true
  if (context?.phase === 'grid-bit-blob') { await runBinaryDom(context); return }
  if (context?.phase === 'grid-time-crosszone') { await runCrosszoneDom(context); return }
  if (context?.phase === 'grid-time') { await runTimeDom(context); return }
  if (context?.phase === 'session-timezone') { await runSessionTimezoneDom(context); return }
  if (context?.phase === 'grid-text') { await runTextDom(context); return }
  if (context?.phase === 'grid-precision') { await runPrecisionDom(context); return }
  if (context?.phase === 'grid-timeout') { await runTimeoutDom(context); return }
  if (context?.phase === 'grid-duplicate') { await runDuplicateDom(context); return }
  if (context?.phase === 'grid-deadlock') { await runDeadlockDom(context); return }
  if (context?.phase === 'commit') { await runCommitDom(context); return }
  if (context?.phase === 'explain') { await runExplainDom(context); return }
  if (context?.phase === 'restart') { await runRestartDom(context); return }
  const began = performance.now()
  const report: UiReport = {
    schemaVersion: 1, runId: context?.runId ?? '', phase: 'initial', actionDriver: 'native-dom-synthetic',
    checks: { storage_preflight: storagePassed, connection_form: false, sql_select41: false, page_first: false, page_next: false, page_back: false },
    pages: { first: null, next: null, back: null }, actions: { click: 0, input: 0, keydown: 0 }, elapsedMs: 0, failureCode: 'NONE'
  }
  let stage: FailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  function one<T extends HTMLElement>(selector: string): T {
    const matches = Array.from(document.querySelectorAll<T>(selector)).filter(visible)
    need(matches.length === 1, 'DOM_FAILED'); return matches[0]!
  }
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 40))
  async function wait(predicate: () => boolean): Promise<void> {
    const deadline = performance.now() + 30000
    while (!predicate()) {
      if (document.querySelector('#status-bar.is-error, .connection-dialog #f-error, .result-grid .inline-error')) throw new DomFailure(stage)
      need(performance.now() < deadline, 'TIMEOUT'); await delay()
    }
  }
  function click(e: HTMLButtonElement): void { need(!e.disabled && visible(e), 'DOM_FAILED'); report.actions.click++; e.click() }
  function fill(selector: string, value: string): void {
    const e = one<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)
    need(!e.disabled && !(e instanceof HTMLInputElement && e.type === 'password') && !e.hasAttribute('data-secret-key'), 'DOM_FAILED')
    e.focus(); e.value = value; report.actions.input++; e.dispatchEvent(new Event('input', { bubbles: true }))
    if (e instanceof HTMLSelectElement) e.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  function table(): HTMLTableElement { return one<HTMLTableElement>('.result-grid .data-table') }
  function ids(): number[] {
    const t = table()
    need(t.querySelector('thead th:nth-child(2) .column-sort')?.textContent?.trim() === 'parity_id', 'PAGING')
    need(t.querySelector('thead th:nth-child(3) .column-sort')?.textContent?.trim() === 'parity_body', 'PAGING')
    return Array.from(t.querySelectorAll('tbody tr')).map((tr) => {
      const raw = tr.querySelector('td:nth-child(2)')?.textContent?.trim() ?? ''
      need(/^[1-9][0-9]*$/.test(raw), 'PAGING'); return Number(raw)
    })
  }
  async function proof(offset: number, at: number): Promise<PageProof> {
    const values = ids(); need(values.length === 200 && values.every((id, i) => id === offset + i + 1), 'PAGING')
    const range = one<HTMLElement>('.result-grid .page-bar > span:first-child').textContent ?? ''
    need(range.startsWith(`${offset + 1}–${offset + 200} 行`), 'PAGING')
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(values.join(','))))
    return { offset, count: values.length, firstId: values[0]!, lastId: values[values.length - 1]!, idsSha256: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''), visibleMs: Math.round(performance.now() - at) }
  }
  function pageButton(name: string): HTMLButtonElement {
    const matches = Array.from(document.querySelectorAll<HTMLButtonElement>('.result-grid .page-bar button')).filter((b) => visible(b) && b.textContent?.trim() === name)
    need(matches.length === 1, 'DOM_FAILED'); return matches[0]!
  }
  try {
    need(context && storagePassed, 'ISOLATION')
    stage = 'CONNECTION'
    await wait(() => !one<HTMLButtonElement>('#btn-new-connection').disabled)
    click(one<HTMLButtonElement>('#btn-new-connection'))
    await wait(() => !!document.querySelector('#f-dialect'))
    fill('#f-name', `MySQL parity ${context.runId}`); fill('#f-dialect', 'mysql')
    await wait(() => !!document.querySelector('[data-key="host"]'))
    fill('[data-key="host"]', context.host); fill('[data-key="port"]', String(context.port))
    fill('[data-key="database"]', context.database); fill('[data-key="user"]', context.user); fill('[data-key="sslmode"]', 'require')
    stage = 'NATIVE_BRIDGE'
    const fillResult = await bridge<{ scheduled: boolean }>('mysqlAcceptanceFillAppPassword')
    need(fillResult.scheduled === true, 'NATIVE_BRIDGE')
    await wait(() => {
      const state = window.__DBSTUDIO_MYSQL_ACCEPTANCE_PASSWORD_STATUS__
      need(state !== 'target-mismatch' && state !== 'unavailable', 'NATIVE_BRIDGE'); return state === 'filled'
    })
    stage = 'CONNECTION'
    click(one<HTMLButtonElement>('#btn-test'))
    await wait(() => !!document.querySelector('.connection-dialog .success') && !one<HTMLButtonElement>('#btn-submit').disabled)
    click(one<HTMLButtonElement>('#btn-submit'))
    await wait(() => !document.querySelector('.connection-dialog') && !one<HTMLButtonElement>('#btn-run-sql').disabled)
    need(one<HTMLSelectElement>('#current-connection').selectedOptions[0]?.textContent === `MySQL parity ${context.runId}`, 'CONNECTION')
    report.checks.connection_form = true
    stage = 'QUERY'
    fill('#sql-input', 'SELECT 41 AS from_keyboard;'); click(one<HTMLButtonElement>('#btn-run-sql'))
    await wait(() => idle() && !!document.querySelector('.result-grid .data-table tbody tr'))
    need(table().querySelector('thead th:nth-child(2) .column-sort')?.textContent?.trim() === 'from_keyboard'
      && table().querySelectorAll('tbody tr').length === 1 && table().querySelector('tbody td:nth-child(2)')?.textContent?.trim() === '41', 'QUERY')
    report.checks.sql_select41 = true
    stage = 'PAGING'
    let at = performance.now()
    fill('#sql-input', 'SELECT id AS parity_id, body AS parity_body FROM items_805 ORDER BY id;'); click(one<HTMLButtonElement>('#btn-run-sql'))
    await wait(() => idle() && document.querySelector('.result-grid thead th:nth-child(2) .column-sort')?.textContent?.trim() === 'parity_id')
    report.pages.first = await proof(0, at); report.checks.page_first = true
    at = performance.now(); click(pageButton('下一页'))
    await wait(() => idle() && document.querySelector('.result-grid tbody td:nth-child(2)')?.textContent?.trim() === '201')
    report.pages.next = await proof(200, at); report.checks.page_next = true
    at = performance.now(); click(pageButton('上一页'))
    await wait(() => idle() && document.querySelector('.result-grid tbody td:nth-child(2)')?.textContent?.trim() === '1')
    report.pages.back = await proof(0, at); report.checks.page_back = true
  } catch (error) { report.failureCode = error instanceof DomFailure ? error.code : stage }
  report.elapsedMs = Math.round(performance.now() - began)
  // Reporting is the only final bridge operation; the host owns evidence and normal exit.
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}

async function runTimeDom(c: Context): Promise<void> {
  class Fault extends Error { constructor(readonly code: TimeFailureCode) { super(code) } }
  function need(value: unknown, code: TimeFailureCode): asserts value { if (!value) throw new Fault(code) }
  const columns = ['id','date_value','datetime_value','timestamp_value','time_wide','time_short'], expectedTypes = ['integer','date','date','date','text','text']
  const categories = ['integer','real','text','blob','null','boolean','date','unknown']
  const baseline = ['1','2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 12:34:56.123456','-25:02:03.000002','01:02:03.000003']
  const edited = ['1','2025-12-31','2025-12-31 23:59:58.999999','2025-12-31 23:59:58.654321','49:03:04.999998','-02:03:04.999997']
  const projectionColumns = ['session_timezone','date_text','datetime_text','timestamp_text','time_wide_text','time_short_text','datetime_microsecond','timestamp_microsecond','time_wide_microsecond','time_short_microsecond','timestamp_epoch']
  const baselineProjection = ['+00:00',...baseline.slice(1),'1','123456','2','3','1709210096.123456'], editedProjection = ['+00:00',...edited.slice(1),'999999','654321','999998','999997','1767225598.654321']
  const began = performance.now(), report: TimeReport = { schemaVersion: 1, runId: c.runId, phase: 'grid-time', actionDriver: 'native-dom-synthetic',
    checks: { storage_marker: storagePassed, persisted_connection: false, credential_reconnect: false, fixture_created: false, session_utc_verified: false, table_open: false, baseline_exact: false, editor_raw_exact: false, local_edits: false, apply_succeeded: false, uncommitted_transaction: false, same_session_witness: false, normal_commit: false, reloaded_exact_values: false, transaction_ended: false, temporal_types: false },
    proof: null, actions: { click: 0, input: 0, keydown: 0, dblclick: 0 }, elapsedMs: 0, failureCode: 'NONE' }
  let stage: TimeFailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const all = <T extends HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector)).filter(visible)
  function one<T extends HTMLElement>(selector: string): T { const a = all<T>(selector); need(a.length === 1, stage); return a[0]! }
  function button(scope: string, text: string, prefix = false): HTMLButtonElement { const a = all<HTMLButtonElement>(`${scope} button`).filter((e) => prefix ? e.textContent?.trim().startsWith(text) : e.textContent?.trim() === text); need(a.length === 1, stage); return a[0]! }
  function click(e: HTMLElement): void { need(visible(e) && !(e instanceof HTMLButtonElement && e.disabled), stage); report.actions.click++; e.click() }
  function dblclick(e: HTMLElement): void { need(visible(e), stage); report.actions.dblclick++; e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) }
  function fill(e: HTMLTextAreaElement, text: string): void { need(visible(e) && !e.disabled, stage); e.focus(); e.value = text; report.actions.input++; e.dispatchEvent(new Event('input', { bubbles: true })) }
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  async function wait(predicate: () => boolean, allowError = false): Promise<void> { const end = performance.now() + 20000; while (!predicate()) { if (!allowError) need(!document.querySelector('#status-bar.is-error, .result-grid .inline-error, .command-result.is-error, .tree-note.is-error'), stage); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 40)) } }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  function tx(): { uiActive: boolean; uiPendingAffected: number } { const text = one<HTMLElement>('.result-grid .transaction-state').textContent?.trim(); if (text === '无活动事务') return { uiActive: false, uiPendingAffected: 0 }; const m = /^未提交 · (\d+) 行$/.exec(text ?? ''); need(m && Number(m[1]) <= 1000, stage); return { uiActive: true, uiPendingAffected: Number(m[1]) } }
  const dirty = () => all<HTMLTableRowElement>('.result-grid tbody tr').filter((r) => r.querySelector('td.is-dirty')).length
  const safe = (value: string) => value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  async function sha(value: unknown): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (b) => b.toString(16).padStart(2, '0')).join('') }
  function row(): { values: (string | null)[]; columnTypes: string[] } {
    need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim().replace(/ [↑↓]$/, '')).join(',') === columns.join(',') && all('.result-grid tbody tr').length === 1, stage)
    const values = all<HTMLTableCellElement>('.result-grid tbody tr td').slice(1).map((e) => e.classList.contains('is-null') ? null : e.textContent ?? ''), columnTypes = all<HTMLElement>('.result-grid thead th small').map((e) => e.textContent ?? '')
    need(values.length === 6 && values.every((v) => v === null || safe(v)) && columnTypes.length === 6 && columnTypes.every((v) => categories.includes(v)), stage); return { values, columnTypes }
  }
  async function execute(sql: string): Promise<void> { const n = all('.result-tabs .result-tab').length; fill(one<HTMLTextAreaElement>('#sql-input'), sql); click(one<HTMLButtonElement>('#btn-run-sql')); await tick(); await wait(() => idle() && all('.result-tabs .result-tab').length === n + 1, true) }
  function witness(): { id: number; projection: (string | null)[] } { need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim()).join(',') === ['connection_id',...projectionColumns].join(',') && all('.result-grid tbody tr').length === 1, 'WITNESS_FAILED'); const cells = all<HTMLTableCellElement>('.result-grid tbody tr td').slice(1); need(cells.length === 12, 'WITNESS_FAILED'); const id = cells[0]!.textContent ?? ''; need(/^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id)) && !cells[0]!.classList.contains('is-null'), 'WITNESS_FAILED'); const projection = cells.slice(1).map((e) => e.classList.contains('is-null') ? null : e.textContent ?? ''); need(projection.every((v) => v === null || safe(v)), 'WITNESS_FAILED'); return { id: Number(id), projection } }
  async function capture(read: { id: number; projection: (string | null)[] }): Promise<TimeStage> { const actual = row(); return { ...actual, valuesSha256: await sha({ columns, types: actual.columnTypes, rows: [actual.values] }), witnessConnectionId: read.id, witnessProjection: [...read.projection], witnessProjectionSha256: await sha({ columns: projectionColumns, rows: [read.projection] }), ...tx(), dirtyRows: dirty() } }
  async function checkpoint(step: 'baseline' | 'draft' | 'applied' | 'committed', actual: TimeStage): Promise<void> {
    await bridge('mysqlAcceptanceTimeCheckpoint', [{ schemaVersion: 1, step, uiActive: actual.uiActive, uiPendingAffected: actual.uiPendingAffected, dirtyRows: actual.dirtyRows, valuesSha256: actual.valuesSha256, witnessConnectionId: actual.witnessConnectionId, witnessProjectionSha256: actual.witnessProjectionSha256 }])
    const end = performance.now() + 30000
    for (;;) { const r = await bridge<{ ready: boolean; verified: boolean }>('mysqlAcceptanceTimeContinue', [{ schemaVersion: 1, step }]); need(r && Object.keys(r).sort().join(',') === 'ready,verified' && typeof r.ready === 'boolean' && typeof r.verified === 'boolean', 'NATIVE_BRIDGE'); if (r.ready) { need(r.verified, 'CHECKPOINT'); return } need(!r.verified, 'NATIVE_BRIDGE'); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 60)) }
  }
  const treeRows = () => all<HTMLElement>('.metadata-tree .tree-row[data-node-id]'), label = (e: HTMLElement) => e.querySelector('.row-label')?.textContent?.trim() ?? ''
  function tree(name: string): HTMLElement { const a = treeRows().filter((e) => label(e) === name); need(a.length === 1, 'TABLE_OPEN'); return a[0]! }
  async function expand(e: HTMLElement): Promise<void> { if (e.getAttribute('aria-expanded') === 'false') click(e.querySelector<HTMLButtonElement>('.twisty')!); await wait(() => e.getAttribute('aria-expanded') === 'true' && e.getAttribute('aria-busy') !== 'true') }
  try {
    need(storagePassed && c.phase === 'grid-time' && /^[a-zA-Z0-9_]+$/.test(c.database), 'ISOLATION'); stage = 'CONNECTION'
    const connection = `MySQL parity ${c.runId}`; await wait(() => treeRows().some((e) => label(e) === connection)); const root = treeRows().filter((e) => e.getAttribute('aria-level') === '1'); need(root.length === 1 && label(root[0]!) === connection && !document.querySelector('.connection-dialog'), 'CONNECTION'); click(root[0]!)
    await wait(() => !!document.querySelector('.connection-summary')); need(one<HTMLElement>('.connection-summary strong').textContent === connection, 'CONNECTION'); report.checks.persisted_connection = true
    click(button('.connection-summary .connection-actions', '连接')); await wait(() => idle() && all<HTMLButtonElement>('.connection-summary button').some((e) => e.textContent?.trim() === '断开')); report.checks.credential_reconnect = true
    stage = 'FIXTURE_OPEN'; const name = `gui_time_${c.runId}`, table = `\`${c.database}\`.\`${name}\``
    stage = 'SESSION_UTC_FAILED'; await execute("SET SESSION time_zone = '+00:00'"); need(!document.querySelector('#status-bar.is-error, .command-result.is-error'), 'SESSION_UTC_FAILED')
    stage = 'FIXTURE_OPEN'; await execute(`CREATE TABLE ${table} (id INT PRIMARY KEY,date_value DATE NOT NULL,datetime_value DATETIME(6) NOT NULL,timestamp_value TIMESTAMP(6) NOT NULL,time_wide TIME(6) NOT NULL,time_short TIME(6) NOT NULL) ENGINE=InnoDB`)
    await execute(`INSERT INTO ${table} VALUES (1,'${baseline[1]}','${baseline[2]}','${baseline[3]}','${baseline[4]}','${baseline[5]}')`)
    need(tx().uiActive && tx().uiPendingAffected === 1, 'FIXTURE_OPEN'); click(button('.result-grid .result-actions', '提交')); await tick(); await wait(() => idle() && (!tx().uiActive || !!document.querySelector('#status-bar.is-error')), true); need(!tx().uiActive && tx().uiPendingAffected === 0 && !document.querySelector('#status-bar.is-error'), 'FIXTURE_OPEN'); report.checks.fixture_created = true
    const query = `SELECT CONNECTION_ID() AS connection_id,@@session.time_zone AS session_timezone,CAST(date_value AS CHAR) AS date_text,DATE_FORMAT(datetime_value,'%Y-%m-%d %H:%i:%s.%f') AS datetime_text,DATE_FORMAT(timestamp_value,'%Y-%m-%d %H:%i:%s.%f') AS timestamp_text,CAST(time_wide AS CHAR) AS time_wide_text,CAST(time_short AS CHAR) AS time_short_text,CAST(MICROSECOND(datetime_value) AS CHAR) AS datetime_microsecond,CAST(MICROSECOND(timestamp_value) AS CHAR) AS timestamp_microsecond,CAST(MICROSECOND(time_wide) AS CHAR) AS time_wide_microsecond,CAST(MICROSECOND(time_short) AS CHAR) AS time_short_microsecond,CAST(UNIX_TIMESTAMP(timestamp_value) AS CHAR) AS timestamp_epoch FROM ${table} WHERE id=1`
    stage = 'WITNESS_FAILED'; await execute(query); const originalWitness = witness(); report.checks.session_utc_verified = originalWitness.projection[0] === '+00:00'
    stage = 'TABLE_OPEN'; await expand(tree(connection)); for (let i = 0; i < 4 && !treeRows().some((e) => label(e) === c.database); i++) { const folder = treeRows().find((e) => e.dataset.nodeId?.includes('folder:schemas') && e.getAttribute('aria-expanded') === 'false'); need(folder, 'TABLE_OPEN'); await expand(folder) }
    await wait(() => treeRows().some((e) => label(e) === c.database)); await expand(tree(c.database)); const folder = treeRows().find((e) => e.dataset.nodeId?.endsWith('|tables')); need(folder, 'TABLE_OPEN'); await expand(folder); await wait(() => treeRows().some((e) => label(e) === name)); const tableRow = tree(name); click(tableRow); dblclick(tableRow)
    await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').length === 6); click(button('.result-grid thead', 'id')); await tick(); await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').some((e) => e.textContent?.trim() === 'id ↑')); report.checks.table_open = true
    stage = 'BASELINE_MISMATCH'; const tableTab = one<HTMLButtonElement>('.result-tabs .result-tab.is-active .tab-label'), initial = await capture(originalWitness)
    report.proof = { rowCount: 1, columnCount: 5, editorOriginals: [null,null,null,null,null], stages: { baseline: initial, draft: null, applied: null, committed: null } }
    report.checks.baseline_exact = same(initial.values, baseline) && same(initial.columnTypes, expectedTypes) && same(originalWitness.projection, baselineProjection) && !initial.uiActive && initial.uiPendingAffected === 0 && initial.dirtyRows === 0; report.checks.temporal_types = same(initial.columnTypes, expectedTypes)
    stage = 'CHECKPOINT'; await checkpoint('baseline', initial); need(report.checks.baseline_exact, 'BASELINE_MISMATCH')
    let editorExact = true
    for (let i = 0; i < 5; i++) {
      stage = 'EDITOR_VALUE_LOSS'; dblclick(one<HTMLTableCellElement>(`.result-grid tbody tr td:nth-child(${i + 3})`)); await wait(() => !!document.querySelector('[aria-label="编辑单元格"] textarea') || !!document.querySelector('.result-grid .inline-error'), true)
      if (!document.querySelector('[aria-label="编辑单元格"] textarea')) { editorExact = false; break }
      const value = one<HTMLTextAreaElement>('[aria-label="编辑单元格"] textarea'), box = one<HTMLInputElement>('[aria-label="编辑单元格"] input[type="checkbox"]'), original: TimeEditor = { raw: value.value, isNull: box.checked, valueDisabled: value.disabled, nullDisabled: box.disabled }
      need(safe(original.raw), 'EDITOR_VALUE_LOSS'); report.proof.editorOriginals[i] = original
      if (original.raw !== initial.values[i + 1] || original.isNull || original.valueDisabled || original.nullDisabled) { editorExact = false; click(button('[aria-label="编辑单元格"]', '取消')); await tick(); await wait(() => !document.querySelector('[aria-label="编辑单元格"]'), true); break }
      fill(value, edited[i + 1]!); click(button('[aria-label="编辑单元格"]', '保存到本地修改')); await tick(); await wait(() => !document.querySelector('[aria-label="编辑单元格"]'), true)
    }
    const draft = await capture(originalWitness); report.proof.stages.draft = draft; report.checks.editor_raw_exact = editorExact; report.checks.local_edits = same(draft.values, edited) && same(draft.columnTypes, expectedTypes) && draft.dirtyRows === 1 && !draft.uiActive && draft.uiPendingAffected === 0
    stage = 'CHECKPOINT'; await checkpoint('draft', draft); need(editorExact, 'EDITOR_VALUE_LOSS'); need(report.checks.local_edits, 'DIRTY_VALUES_MISMATCH')
    stage = 'APPLY_REJECTED'; click(button('.result-grid .result-actions', '应用修改', true)); await tick(); await wait(() => idle(), true)
    report.checks.apply_succeeded = dirty() === 0 && !document.querySelector('#status-bar.is-error, .result-grid .inline-error')
    stage = 'WITNESS_FAILED'; await execute(query); const appliedWitness = witness(), queryTab = one<HTMLButtonElement>('.result-tabs .result-tab.is-active .tab-label')
    click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true); const applied = await capture(appliedWitness); report.proof.stages.applied = applied
    report.checks.uncommitted_transaction = applied.uiActive && applied.uiPendingAffected === 1; report.checks.same_session_witness = appliedWitness.id === originalWitness.id && same(appliedWitness.projection, editedProjection)
    stage = 'CHECKPOINT'; await checkpoint('applied', applied); need(report.checks.apply_succeeded, 'APPLY_REJECTED'); need(report.checks.uncommitted_transaction && applied.dirtyRows === 0, 'TRANSACTION_STALE'); need(same(applied.values, edited) && same(applied.columnTypes, expectedTypes), 'RELOADED_VALUES_MISMATCH'); need(report.checks.same_session_witness, 'WITNESS_FAILED')
    stage = 'COMMIT_FAILED'; click(button('.result-grid .result-actions', '提交')); await tick(); await wait(() => idle() && (!!document.querySelector('#status-bar.is-error, .result-grid .inline-error') || (one<HTMLElement>('#status-bar').textContent ?? '').startsWith('已提交当前连接事务')), true)
    report.checks.normal_commit = !tx().uiActive && tx().uiPendingAffected === 0 && !document.querySelector('#status-bar.is-error, .result-grid .inline-error')
    stage = 'WITNESS_FAILED'; click(queryTab); await tick(); await wait(() => idle() && queryTab.getAttribute('aria-selected') === 'true', true); const committedWitness = witness()
    click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true); const committed = await capture(committedWitness); report.proof.stages.committed = committed
    report.checks.reloaded_exact_values = report.checks.normal_commit && same(committed.values, edited) && same(committed.columnTypes, expectedTypes) && same(committedWitness.projection, editedProjection) && committedWitness.id === originalWitness.id; report.checks.transaction_ended = !committed.uiActive && committed.uiPendingAffected === 0 && committed.dirtyRows === 0
    stage = 'CHECKPOINT'; await checkpoint('committed', committed); need(report.checks.normal_commit, 'COMMIT_FAILED'); need(report.checks.reloaded_exact_values, 'RELOADED_VALUES_MISMATCH'); need(report.checks.transaction_ended, 'TRANSACTION_STALE')
  } catch (error) { report.failureCode = error instanceof Fault ? error.code : stage }
  report.elapsedMs = Math.round(performance.now() - began)
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}

async function runCrosszoneDom(c: Context): Promise<void> {
  class Fault extends Error { constructor(readonly code: CrosszoneFailureCode) { super(code) } }
  function need(value: unknown, code: CrosszoneFailureCode): asserts value { if (!value) throw new Fault(code) }
  const columns = ['id','date_value','datetime_value','timestamp_value','time_wide','time_short']
  const expectedTypes = ['integer','date','date','date','text','text']
  const categories = ['integer','real','text','blob','null','boolean','date','unknown']
  const projectionColumns = ['session_timezone','date_text','datetime_text','timestamp_text','time_wide_text','time_short_text','datetime_microsecond','timestamp_microsecond','time_wide_microsecond','time_short_microsecond','timestamp_epoch']
  const baselineValues = ['1','2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 12:34:56.123456','-25:02:03.000002','01:02:03.000003']
  const shiftedValues = ['1','2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 20:34:56.123456','-25:02:03.000002','01:02:03.000003']
  const baselineProjection = ['+00:00','2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 12:34:56.123456','-25:02:03.000002','01:02:03.000003','1','123456','2','3','1709210096.123456']
  const shiftedProjection = ['+08:00','2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 20:34:56.123456','-25:02:03.000002','01:02:03.000003','1','123456','2','3','1709210096.123456']
  const steps: { step: 'baseline' | 'shifted' | 'restored'; tz: string; values: string[]; projection: string[] }[] = [
    { step: 'baseline', tz: '+00:00', values: baselineValues, projection: baselineProjection },
    { step: 'shifted', tz: '+08:00', values: shiftedValues, projection: shiftedProjection },
    { step: 'restored', tz: '+00:00', values: baselineValues, projection: baselineProjection }]
  const began = performance.now()
  const report: CrosszoneReport = {
    schemaVersion: 1, runId: c.runId, phase: 'grid-time-crosszone', actionDriver: 'native-dom-synthetic',
    checks: { storage_marker: storagePassed, persisted_connection: false, credential_reconnect: false, fixture_created: false, baseline_utc_display: false, shifted_plus08_display: false, restored_utc_display: false, non_ts_unchanged: false, epoch_invariant: false, microsecond_invariant: false, session_readback: false, same_connection: false, transaction_unchanged: false, observer_row_unchanged: false, session_restored: false },
    proof: null, actions: { click: 0, input: 0, keydown: 0, dblclick: 0 }, elapsedMs: 0, failureCode: 'NONE'
  }
  let stage: CrosszoneFailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const all = <T extends HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector)).filter(visible)
  function one<T extends HTMLElement>(selector: string): T { const a = all<T>(selector); need(a.length === 1, stage); return a[0]! }
  function button(scope: string, text: string): HTMLButtonElement { const a = all<HTMLButtonElement>(`${scope} button`).filter((e) => e.textContent?.trim() === text); need(a.length === 1, stage); return a[0]! }
  function click(e: HTMLElement): void { need(visible(e) && !(e instanceof HTMLButtonElement && e.disabled), stage); report.actions.click++; e.click() }
  function fill(e: HTMLTextAreaElement, text: string): void { need(visible(e) && !e.disabled, stage); e.focus(); e.value = text; report.actions.input++; e.dispatchEvent(new Event('input', { bubbles: true })) }
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  const hasError = () => !!document.querySelector('#status-bar.is-error, .result-grid .inline-error, .command-result.is-error')
  async function wait(predicate: () => boolean, allowError = false): Promise<void> { const end = performance.now() + 20000; while (!predicate()) { if (!allowError) need(!hasError(), stage); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 40)) } }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  function tx(): { uiActive: boolean; uiPendingAffected: number } { const text = one<HTMLElement>('.result-grid .transaction-state').textContent?.trim(); if (text === '无活动事务') return { uiActive: false, uiPendingAffected: 0 }; const m = /^未提交 · (\d+) 行$/.exec(text ?? ''); need(m && Number(m[1]) <= 1000, stage); return { uiActive: true, uiPendingAffected: Number(m[1]) } }
  const dirty = () => all<HTMLTableRowElement>('.result-grid tbody tr').filter((r) => r.querySelector('td.is-dirty')).length
  const safe = (value: string) => value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  async function sha(value: unknown): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (b) => b.toString(16).padStart(2, '0')).join('') }
  const tabs = () => all<HTMLElement>('.result-tabs .result-tab')
  function newestTabSelected(after: number): boolean { const list = tabs(); if (list.length !== after) return false; const selected = list.filter((t) => t.querySelector('.tab-label')?.getAttribute('aria-selected') === 'true'); return selected.length === 1 && selected[0] === list[list.length - 1] }
  const ownedSession = () => one<HTMLSelectElement>('#current-connection').selectedOptions[0]?.textContent === `MySQL parity ${c.runId}`
  function row(): { values: (string | null)[]; columnTypes: string[] } {
    need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim().replace(/ [↑↓]$/, '')).join(',') === columns.join(',') && all('.result-grid tbody tr').length === 1, stage)
    const values = all<HTMLTableCellElement>('.result-grid tbody tr td').slice(1).map((e) => e.classList.contains('is-null') ? null : e.textContent ?? ''), columnTypes = all<HTMLElement>('.result-grid thead th small').map((e) => e.textContent ?? '')
    need(values.length === 6 && values.every((v) => v === null || safe(v)) && columnTypes.length === 6 && columnTypes.every((v) => categories.includes(v)), stage); return { values, columnTypes }
  }
  function witness(): { id: number; projection: (string | null)[] } {
    need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim()).join(',') === ['connection_id',...projectionColumns].join(',') && all('.result-grid tbody tr').length === 1, stage)
    const cells = all<HTMLTableCellElement>('.result-grid tbody tr td').slice(1); need(cells.length === 12, stage)
    const id = cells[0]!.textContent ?? ''
    need(/^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id)) && !cells[0]!.classList.contains('is-null'), stage)
    const projection = cells.slice(1).map((e) => e.classList.contains('is-null') ? null : e.textContent ?? '')
    need(projection.every((v) => v === null || safe(v)), stage); return { id: Number(id), projection }
  }
  async function execute(sql: string): Promise<{ before: number; after: number; error: boolean }> {
    const before = tabs().length
    fill(one<HTMLTextAreaElement>('#sql-input'), sql); click(one<HTMLButtonElement>('#btn-run-sql')); await tick()
    await wait(() => idle() && (tabs().length === before + 1 || hasError()), true); await tick()
    return { before, after: tabs().length, error: hasError() }
  }
  async function checkpoint(step: 'baseline' | 'shifted' | 'restored', value: CrosszoneStage): Promise<{ ready: boolean; verified: boolean }> {
    await bridge('mysqlAcceptanceCrosszoneCheckpoint', [{ schemaVersion: 1, step, uiActive: value.uiActive, uiPendingAffected: value.uiPendingAffected, dirtyRows: value.dirtyRows, valuesSha256: value.valuesSha256, witnessConnectionId: value.witnessConnectionId, witnessProjectionSha256: value.witnessProjectionSha256, sessionTimezone: value.sessionTimezone, resultTabsBefore: value.resultTabsBefore, resultTabsAfter: value.resultTabsAfter, activeTabGeneration: value.activeTabGeneration, activeTabOwned: value.activeTabOwned, nativeExecuteCount: value.nativeExecuteCount }])
    const end = performance.now() + 30000
    for (;;) { const r = await bridge<{ ready: boolean; verified: boolean }>('mysqlAcceptanceCrosszoneContinue', [{ schemaVersion: 1, step }]); need(r && Object.keys(r).sort().join(',') === 'ready,verified' && typeof r.ready === 'boolean' && typeof r.verified === 'boolean', 'NATIVE_BRIDGE'); if (r.ready) { need(r.verified, 'CHECKPOINT'); return r } need(!r.verified, 'NATIVE_BRIDGE'); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 60)) }
  }
  const treeRows = () => all<HTMLElement>('.metadata-tree .tree-row[data-node-id]'), label = (e: HTMLElement) => e.querySelector('.row-label')?.textContent?.trim() ?? ''
  try {
    need(storagePassed && c.phase === 'grid-time-crosszone' && /^[a-zA-Z0-9_]+$/.test(c.database), 'ISOLATION'); stage = 'CONNECTION'
    const connection = `MySQL parity ${c.runId}`
    await wait(() => treeRows().some((e) => label(e) === connection))
    const root = treeRows().filter((e) => e.getAttribute('aria-level') === '1'); need(root.length === 1 && label(root[0]!) === connection && !document.querySelector('.connection-dialog'), 'CONNECTION'); click(root[0]!)
    await wait(() => !!document.querySelector('.connection-summary')); need(one<HTMLElement>('.connection-summary strong').textContent === connection, 'CONNECTION'); report.checks.persisted_connection = true
    click(button('.connection-summary .connection-actions', '连接')); await wait(() => idle() && all<HTMLButtonElement>('.connection-summary .connection-actions button').some((e) => e.textContent?.trim() === '断开')); report.checks.credential_reconnect = true
    const name = `gui_time_crosszone_${c.runId}`, table = `\`${c.database}\`.\`${name}\``
    let executed = 0
    stage = 'SET_REJECTED'; const seedSet = await execute("SET SESSION time_zone = '+00:00'"); need(!seedSet.error && seedSet.after === seedSet.before + 1, 'SET_REJECTED'); executed++
    stage = 'FIXTURE_OPEN'; const seedCreate = await execute(`CREATE TABLE ${table} (id INT PRIMARY KEY,date_value DATE NOT NULL,datetime_value DATETIME(6) NOT NULL,timestamp_value TIMESTAMP(6) NOT NULL,time_wide TIME(6) NOT NULL,time_short TIME(6) NOT NULL) ENGINE=InnoDB`); need(!seedCreate.error && seedCreate.after === seedCreate.before + 1, 'FIXTURE_OPEN'); executed++
    const seedInsert = await execute(`INSERT INTO ${table} VALUES (1,'2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 12:34:56.123456','-25:02:03.000002','01:02:03.000003')`); need(!seedInsert.error && seedInsert.after === seedInsert.before + 1, 'FIXTURE_OPEN'); executed++
    need(tx().uiActive && tx().uiPendingAffected === 1, 'FIXTURE_OPEN')
    click(button('.result-grid .result-actions', '提交')); await tick(); await wait(() => idle() && (!tx().uiActive || hasError()), true)
    need(!tx().uiActive && tx().uiPendingAffected === 0 && !hasError(), 'FIXTURE_OPEN'); report.checks.fixture_created = true
    const witnessSql = `SELECT CONNECTION_ID() AS connection_id,@@session.time_zone AS session_timezone,CAST(date_value AS CHAR) AS date_text,DATE_FORMAT(datetime_value,'%Y-%m-%d %H:%i:%s.%f') AS datetime_text,DATE_FORMAT(timestamp_value,'%Y-%m-%d %H:%i:%s.%f') AS timestamp_text,CAST(time_wide AS CHAR) AS time_wide_text,CAST(time_short AS CHAR) AS time_short_text,CAST(MICROSECOND(datetime_value) AS CHAR) AS datetime_microsecond,CAST(MICROSECOND(timestamp_value) AS CHAR) AS timestamp_microsecond,CAST(MICROSECOND(time_wide) AS CHAR) AS time_wide_microsecond,CAST(MICROSECOND(time_short) AS CHAR) AS time_short_microsecond,CAST(UNIX_TIMESTAMP(timestamp_value) AS CHAR) AS timestamp_epoch FROM ${table} WHERE id=1`
    const rawSql = `SELECT id,date_value,datetime_value,timestamp_value,time_wide,time_short FROM ${table} WHERE id=1`
    const stages: Record<'baseline' | 'shifted' | 'restored', CrosszoneStage | null> = { baseline: null, shifted: null, restored: null }
    let baselineCid = 0, nonTsOk = true, epochOk = true, microOk = true, tzOk = true, cidOk = true, txOk = true, observerOk = true
    for (const [index, s] of steps.entries()) {
      stage = 'SET_REJECTED'; const setResult = await execute(`SET SESSION time_zone = '${s.tz}'`); need(!setResult.error && setResult.after === setResult.before + 1, 'SET_REJECTED'); executed++
      stage = 'TABLE_OPEN'; const witnessResult = await execute(witnessSql); need(!witnessResult.error && witnessResult.after === witnessResult.before + 1, 'TABLE_OPEN'); executed++
      need(newestTabSelected(witnessResult.after), 'TABLE_OPEN'); const read = witness()
      const rawResult = await execute(rawSql); need(!rawResult.error && rawResult.after === rawResult.before + 1, 'TABLE_OPEN'); executed++
      need(newestTabSelected(rawResult.after), 'TABLE_OPEN'); const owned = ownedSession(); need(owned, 'TABLE_OPEN')
      need(executed === 3 + 3 * (index + 1), 'NATIVE_BRIDGE')
      const actual = row()
      const value: CrosszoneStage = { values: actual.values, columnTypes: actual.columnTypes, valuesSha256: await sha({ columns, types: actual.columnTypes, rows: [actual.values] }), witnessConnectionId: read.id, witnessProjection: [...read.projection], witnessProjectionSha256: await sha({ columns: projectionColumns, rows: [read.projection] }), ...tx(), dirtyRows: dirty(), sessionTimezone: read.projection[0] ?? '', resultTabsBefore: rawResult.before, resultTabsAfter: rawResult.after, activeTabGeneration: rawResult.after, activeTabOwned: owned, nativeExecuteCount: executed }
      stages[s.step] = value
      report.proof = { rowCount: 1, columnCount: 5, stages: { baseline: stages.baseline!, shifted: stages.shifted, restored: stages.restored } }
      stage = 'CHECKPOINT'; const ack = await checkpoint(s.step, value); observerOk = observerOk && ack.verified
      const tsOk = value.values[3] === s.values[3]
      const stepNonTs = value.values[0] === s.values[0] && value.values[1] === s.values[1] && value.values[2] === s.values[2] && value.values[4] === s.values[4] && value.values[5] === s.values[5]
      const typesOk = same(value.columnTypes, expectedTypes)
      const stepEpoch = value.witnessProjection[10] === '1709210096.123456'
      const stepMicro = value.witnessProjection[6] === '1' && value.witnessProjection[7] === '123456' && value.witnessProjection[8] === '2' && value.witnessProjection[9] === '3' && String(value.values[3] ?? '').endsWith('.123456')
      const stepTz = value.sessionTimezone === s.tz && value.witnessProjection[0] === s.tz
      const stepCid = baselineCid === 0 ? (baselineCid = value.witnessConnectionId, true) : value.witnessConnectionId === baselineCid
      const stepTx = !value.uiActive && value.uiPendingAffected === 0 && value.dirtyRows === 0
      const display = tsOk && stepNonTs && typesOk
      if (s.step === 'baseline') report.checks.baseline_utc_display = display
      else if (s.step === 'shifted') report.checks.shifted_plus08_display = display
      else report.checks.restored_utc_display = display
      nonTsOk = nonTsOk && stepNonTs; epochOk = epochOk && stepEpoch; microOk = microOk && stepMicro; tzOk = tzOk && stepTz; cidOk = cidOk && stepCid; txOk = txOk && stepTx
      report.checks.non_ts_unchanged = nonTsOk; report.checks.epoch_invariant = epochOk; report.checks.microsecond_invariant = microOk; report.checks.session_readback = tzOk; report.checks.same_connection = cidOk; report.checks.transaction_unchanged = txOk; report.checks.observer_row_unchanged = observerOk
      if (s.step === 'restored') report.checks.session_restored = value.sessionTimezone === '+00:00'
      need(stepTz, 'SESSION_READBACK_MISMATCH'); need(stepCid, 'CONNECTION_CHANGED'); need(stepTx, 'TRANSACTION_STARTED')
      need(s.step !== 'restored' || value.sessionTimezone === '+00:00', 'SESSION_NOT_RESTORED')
      need(stepEpoch && stepMicro, 'EPOCH_MICROSECOND_LOST'); need(stepNonTs, 'NON_TS_MUTATED'); need(typesOk, 'DISPLAY_TYPE_MISMATCH'); need(tsOk, 'DISPLAY_VALUE_MISMATCH')
    }
  } catch (error) { report.failureCode = error instanceof Fault ? error.code : stage }
  report.elapsedMs = Math.round(performance.now() - began)
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}

async function runSessionTimezoneDom(c: Context): Promise<void> {
  class Fault extends Error { constructor(readonly code: SessionTimezoneFailureCode) { super(code) } }
  function need(value: unknown, code: SessionTimezoneFailureCode): asserts value { if (!value) throw new Fault(code) }
  const began = performance.now(), report: SessionTimezoneReport = { schemaVersion: 1, runId: c.runId, phase: 'session-timezone', actionDriver: 'native-dom-synthetic',
    checks: { storage_marker: storagePassed, persisted_connection: false, credential_reconnect: false, baseline_observed: false, offset_set: false, offset_readback: false, restored_set: false, restored_readback: false, same_connection: false, transaction_unchanged: false }, proof: null, actions: { click: 0, input: 0, keydown: 0, dblclick: 0 }, elapsedMs: 0, failureCode: 'NONE' }
  let failure: SessionTimezoneFailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const all = <T extends HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector)).filter(visible)
  function one<T extends HTMLElement>(selector: string): T { const a = all<T>(selector); need(a.length === 1, failure); return a[0]! }
  function click(e: HTMLElement): void { need(visible(e) && !(e instanceof HTMLButtonElement && e.disabled), failure); report.actions.click++; e.click() }
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  async function wait(predicate: () => boolean, allowError = false): Promise<void> { const end = performance.now() + 20000; while (!predicate()) { if (!allowError) need(!document.querySelector('#status-bar.is-error, .connection-dialog #f-error'), failure); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 40)) } }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  function transaction(): { uiActive: boolean; uiPendingAffected: number } { const text = one<HTMLElement>('.result-grid .transaction-state').textContent?.trim(); if (text === '无活动事务') return { uiActive: false, uiPendingAffected: 0 }; const match = /^未提交 · (\d+) 行$/.exec(text ?? ''); need(match && Number(match[1]) <= 1000, failure); return { uiActive: true, uiPendingAffected: Number(match[1]) } }
  async function execute(sql: string): Promise<boolean> {
    const before = all('.result-tabs .result-tab').length, input = one<HTMLTextAreaElement>('#sql-input'); need(!input.disabled, failure); input.focus(); input.value = sql; report.actions.input++; input.dispatchEvent(new Event('input', { bubbles: true })); click(one<HTMLButtonElement>('#btn-run-sql')); await tick()
    await wait(() => idle() && all('.result-tabs .result-tab').length === before + 1, true); await tick()
    return !!document.querySelector('#status-bar.is-error, .result-grid .inline-error, .command-result.is-error')
  }
  const select = "SELECT CONNECTION_ID() AS connection_id,@@session.time_zone AS session_timezone,@@system_time_zone AS system_timezone,@@session.autocommit AS autocommit,CAST(UNIX_TIMESTAMP(CAST('2024-02-29 12:34:56.123456' AS DATETIME(6))) AS CHAR) AS wall_epoch"
  async function readStage(setFailed: boolean): Promise<SessionTimezoneStage> {
    need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim()).join(',') === 'connection_id,session_timezone,system_timezone,autocommit,wall_epoch' && all('.result-grid tbody tr').length === 1, failure)
    const values = all<HTMLTableCellElement>('.result-grid tbody tr td').slice(1).map((e) => e.textContent ?? '')
    need(values.length === 5 && /^[1-9][0-9]*$/.test(values[0]!) && Number.isSafeInteger(Number(values[0])) && values.slice(1).every((v) => v.length <= 64 && !/[\u0000-\u001f\u007f]/.test(v)) && ['0','1'].includes(values[3]!), failure)
    const bytes = new TextEncoder().encode(JSON.stringify({ columns: ['session_timezone','system_timezone','autocommit','wall_epoch'], rows: [values.slice(1)] }))
    const projectionSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
    return { connectionId: Number(values[0]), sessionTimezone: values[1]!, systemTimezone: values[2]!, autocommit: values[3] === '1', epochText: values[4]!, projectionSha256, setFailed, ...transaction() }
  }
  async function checkpoint(step: 'baseline' | 'offset' | 'restored', stage: SessionTimezoneStage): Promise<void> {
    await bridge('mysqlAcceptanceSessionTimezoneCheckpoint', [{ schemaVersion: 1, step, uiActive: stage.uiActive, uiPendingAffected: stage.uiPendingAffected, projectionSha256: stage.projectionSha256, connectionId: stage.connectionId, setFailed: stage.setFailed, autocommit: stage.autocommit }])
    const end = performance.now() + 30000
    for (;;) { const value = await bridge<{ ready: boolean; verified: boolean }>('mysqlAcceptanceSessionTimezoneContinue', [{ schemaVersion: 1, step }]); need(value && Object.keys(value).sort().join(',') === 'ready,verified' && typeof value.ready === 'boolean' && typeof value.verified === 'boolean', 'NATIVE_BRIDGE'); if (value.ready) { need(value.verified, 'CHECKPOINT'); return } need(!value.verified, 'NATIVE_BRIDGE'); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 60)) }
  }
  function exact(stage: SessionTimezoneStage, offset: boolean): boolean { return stage.sessionTimezone === (offset ? '+08:00' : '+00:00') && stage.systemTimezone === 'UTC' && stage.autocommit && stage.epochText === (offset ? '1709181296.123456' : '1709210096.123456') && !stage.uiActive && stage.uiPendingAffected === 0 }
  function validate(stage: SessionTimezoneStage, offset: boolean, id: number): void {
    need(!stage.setFailed, 'SET_REJECTED'); need(stage.connectionId === id, 'CONNECTION_CHANGED'); need(stage.sessionTimezone === (offset ? '+08:00' : '+00:00') && stage.systemTimezone === 'UTC', 'SESSION_MISMATCH'); need(stage.autocommit, 'AUTOCOMMIT_CHANGED'); need(stage.epochText === (offset ? '1709181296.123456' : '1709210096.123456'), 'EPOCH_LOSS'); need(!stage.uiActive && stage.uiPendingAffected === 0, 'TRANSACTION_CHANGED')
  }
  try {
    need(storagePassed && c.phase === 'session-timezone', 'ISOLATION'); failure = 'CONNECTION'
    const name = `MySQL parity ${c.runId}`; await wait(() => all<HTMLElement>('.metadata-tree .tree-row[data-node-id]').some((e) => e.querySelector('.row-label')?.textContent === name))
    const roots = all<HTMLElement>('.metadata-tree .tree-row[data-node-id]').filter((e) => e.getAttribute('aria-level') === '1'); need(roots.length === 1 && roots[0]!.querySelector('.row-label')?.textContent === name && !document.querySelector('.connection-dialog'), 'CONNECTION'); click(roots[0]!)
    await wait(() => !!document.querySelector('.connection-summary')); need(one<HTMLElement>('.connection-summary strong').textContent === name, 'CONNECTION'); report.checks.persisted_connection = true
    const connect = all<HTMLButtonElement>('.connection-summary .connection-actions button').filter((e) => e.textContent?.trim() === '连接'); need(connect.length === 1, 'CONNECTION'); click(connect[0]!)
    await wait(() => idle() && all<HTMLButtonElement>('.connection-summary .connection-actions button').some((e) => e.textContent?.trim() === '断开')); report.checks.credential_reconnect = true
    failure = 'BASELINE_FAILED'; need(!await execute(select), 'BASELINE_FAILED'); const baseline = await readStage(false); report.proof = { rowCount: 1, baseline, offset: null, restored: null }
    failure = 'CHECKPOINT'; await checkpoint('baseline', baseline); need(exact(baseline, false), 'BASELINE_FAILED'); report.checks.baseline_observed = true
    failure = 'SET_REJECTED'; const offsetFailed = await execute("SET SESSION time_zone = '+08:00'"); report.checks.offset_set = !offsetFailed
    failure = 'SESSION_MISMATCH'; need(!await execute(select), 'SESSION_MISMATCH'); const offset = await readStage(offsetFailed); report.proof.offset = offset; report.checks.offset_readback = exact(offset, true); report.checks.same_connection = offset.connectionId === baseline.connectionId; report.checks.transaction_unchanged = !baseline.uiActive && baseline.uiPendingAffected === 0 && !offset.uiActive && offset.uiPendingAffected === 0
    failure = 'CHECKPOINT'; await checkpoint('offset', offset); validate(offset, true, baseline.connectionId)
    failure = 'SET_REJECTED'; const restoredFailed = await execute("SET SESSION time_zone = '+00:00'"); report.checks.restored_set = !restoredFailed
    failure = 'SESSION_MISMATCH'; need(!await execute(select), 'SESSION_MISMATCH'); const restored = await readStage(restoredFailed); report.proof.restored = restored; report.checks.restored_readback = exact(restored, false); report.checks.same_connection = report.checks.same_connection && restored.connectionId === baseline.connectionId; report.checks.transaction_unchanged = report.checks.transaction_unchanged && !restored.uiActive && restored.uiPendingAffected === 0
    failure = 'CHECKPOINT'; await checkpoint('restored', restored); validate(restored, false, baseline.connectionId)
  } catch (error) { report.failureCode = error instanceof Fault ? error.code : failure }
  report.elapsedMs = Math.round(performance.now() - began)
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}

async function runTextDom(c: Context): Promise<void> {
  class Fault extends Error { constructor(readonly code: TextFailureCode) { super(code) } }
  function need(value: unknown, code: TextFailureCode): asserts value { if (!value) throw new Fault(code) }
  const baselineLong = '长😀'.repeat(800) + '|BASE-END|', editedLong = '改🚀'.repeat(900) + '|EDIT-END|'
  const baselineJson = '{"largeInteger":9007199254740993,"message":"你好😀","nested":{"flag":true,"items":[1,"x",null]},"padding":"' + 'J'.repeat(1200) + '"}'
  const editedJson = '{"largeInteger":9007199254740995,"message":"改后🚀","nested":{"flag":false,"items":[2,"y",null]},"padding":"' + 'K'.repeat(1300) + '"}'
  const projectionColumns = ['long_chars','long_bytes','long_sha256','json_sha256','json_large_integer','json_integer_type','json_message_hex','json_exact_match']
  const began = performance.now(), report: TextReport = { schemaVersion: 1, runId: c.runId, phase: 'grid-text', actionDriver: 'native-dom-synthetic',
    checks: { storage_marker: storagePassed, persisted_connection: false, credential_reconnect: false, fixture_created: false, table_open: false, preview_truncated: false, baseline_full: false, editor_full: false, local_edits: false, draft_full: false, apply_succeeded: false, uncommitted_transaction: false, applied_full: false, same_session_witness: false, normal_commit: false, committed_full: false, reloaded_exact_values: false, transaction_ended: false, json_integer_exact: false },
    proof: null, actions: { click: 0, input: 0, keydown: 0, dblclick: 0 }, elapsedMs: 0, failureCode: 'NONE' }
  let stage: TextFailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const all = <T extends HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector)).filter(visible)
  function one<T extends HTMLElement>(selector: string): T { const a = all<T>(selector); need(a.length === 1, stage); return a[0]! }
  function button(scope: string, text: string, prefix = false): HTMLButtonElement { const a = all<HTMLButtonElement>(`${scope} button`).filter((e) => prefix ? e.textContent?.trim().startsWith(text) : e.textContent?.trim() === text); need(a.length === 1, stage); return a[0]! }
  function click(e: HTMLElement): void { need(visible(e) && !(e instanceof HTMLButtonElement && e.disabled), stage); report.actions.click++; e.click() }
  function dblclick(e: HTMLElement): void { need(visible(e), stage); report.actions.dblclick++; e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) }
  function fill(e: HTMLTextAreaElement, text: string): void { need(visible(e) && !e.disabled, stage); e.focus(); e.value = text; report.actions.input++; e.dispatchEvent(new Event('input', { bubbles: true })) }
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  async function wait(predicate: () => boolean, allowError = false): Promise<void> { const end = performance.now() + 20000; while (!predicate()) { if (!allowError) need(!document.querySelector('#status-bar.is-error, .result-grid .inline-error, .command-result.is-error, .tree-note.is-error'), stage); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 40)) } }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  function tx(): { uiActive: boolean; uiPendingAffected: number } { const text = one<HTMLElement>('.result-grid .transaction-state').textContent?.trim(); if (text === '无活动事务') return { uiActive: false, uiPendingAffected: 0 }; const m = /^未提交 · (\d+) 行$/.exec(text ?? ''); need(m && Number(m[1]) <= 1000, stage); return { uiActive: true, uiPendingAffected: Number(m[1]) } }
  const dirty = () => all<HTMLTableRowElement>('.result-grid tbody tr').filter((r) => r.querySelector('td.is-dirty')).length
  async function sha(text: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('') }
  const pairHash = (long: string, json: string) => sha(JSON.stringify({ columns: ['id','long_text_sha256','json_text_sha256'], rows: [['1',long,json]] }))
  function cells(): [HTMLTableCellElement, HTMLTableCellElement] { need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim().replace(/ [↑↓]$/, '')).join(',') === 'id,long_text,json_value' && all('.result-grid tbody tr').length === 1 && one<HTMLElement>('.result-grid tbody td:nth-child(2)').textContent === '1', stage); return [one<HTMLTableCellElement>('.result-grid tbody td:nth-child(3)'),one<HTMLTableCellElement>('.result-grid tbody td:nth-child(4)')] }
  async function previews(): Promise<[TextPreview, TextPreview]> { const out: TextPreview[] = []; for (const cell of cells()) { const text = cell.textContent ?? '', ellipsis = text.endsWith('…'), prefix = ellipsis ? text.slice(0,-1) : text; out.push({ prefixSha256: await sha(prefix), prefixCodePoints: Array.from(prefix).length, ellipsis }) } return out as [TextPreview, TextPreview] }
  async function fullValues(): Promise<[string, string]> { const values: string[] = []; for (const cell of cells()) { click(cell); await tick(); click(button('.result-grid .result-actions', '查看完整值')); await wait(() => !!document.querySelector('.cell-viewer textarea[aria-label="完整单元格值"]') || !!document.querySelector('.result-grid .inline-error'), true); need(!!document.querySelector('.cell-viewer textarea[aria-label="完整单元格值"]'), 'FULL_VALUE'); const input = one<HTMLTextAreaElement>('.cell-viewer textarea[aria-label="完整单元格值"]'); need(input.readOnly && !input.disabled, 'FULL_VALUE'); values.push(input.value); click(button('.cell-viewer', '关闭')); await tick(); await wait(() => !document.querySelector('.cell-viewer'), true) } return values as [string, string] }
  async function prefixesMatch(pair: [TextPreview, TextPreview], full: [string,string]): Promise<boolean> { for (let i = 0; i < 2; i++) { const p = pair[i]!, chars = Array.from(full[i]!); if (!p.ellipsis || p.prefixCodePoints <= 0 || p.prefixCodePoints >= chars.length || p.prefixSha256 !== await sha(chars.slice(0,p.prefixCodePoints).join(''))) return false } return true }
  function integerExact(json: string, value: string): boolean { return new RegExp('"largeInteger"\\s*:\\s*' + value + '(?=\\s*[,}])').test(json) }
  async function execute(sql: string): Promise<void> { const n = all('.result-tabs .result-tab').length; fill(one<HTMLTextAreaElement>('#sql-input'), sql); click(one<HTMLButtonElement>('#btn-run-sql')); await tick(); await wait(() => idle() && all('.result-tabs .result-tab').length === n + 1, true) }
  function witness(): { id: number; projection: string[] } { need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim()).join(',') === ['connection_id',...projectionColumns].join(',') && all('.result-grid tbody tr').length === 1, 'WITNESS_FAILED'); const values = all<HTMLTableCellElement>('.result-grid tbody tr td').slice(1); need(values.length === 9 && values.every((e) => !e.classList.contains('is-null')), 'WITNESS_FAILED'); const text = values.map((e) => e.textContent ?? ''); need(/^[1-9][0-9]*$/.test(text[0]!) && Number.isSafeInteger(Number(text[0])), 'WITNESS_FAILED'); return { id: Number(text[0]), projection: text.slice(1) } }
  async function checkpoint(step: 'baseline' | 'draft' | 'applied' | 'committed', sha: string, id: number | null = null, projectionSha: string | null = null): Promise<void> {
    await bridge('mysqlAcceptanceTextCheckpoint', [{ schemaVersion: 1, step, ...tx(), dirtyRows: dirty(), valuesSha256: sha, witnessConnectionId: id, witnessProjectionSha256: projectionSha }])
    const end = performance.now() + 30000
    for (;;) { const r = await bridge<{ ready: boolean; verified: boolean }>('mysqlAcceptanceTextContinue', [{ schemaVersion: 1, step }]); need(r && Object.keys(r).sort().join(',') === 'ready,verified' && typeof r.ready === 'boolean' && typeof r.verified === 'boolean', 'NATIVE_BRIDGE'); if (r.ready) { need(r.verified, 'CHECKPOINT'); return } need(!r.verified, 'NATIVE_BRIDGE'); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 60)) }
  }
  const treeRows = () => all<HTMLElement>('.metadata-tree .tree-row[data-node-id]'), label = (e: HTMLElement) => e.querySelector('.row-label')?.textContent?.trim() ?? ''
  function tree(name: string): HTMLElement { const a = treeRows().filter((e) => label(e) === name); need(a.length === 1, 'TREE'); return a[0]! }
  async function expand(e: HTMLElement): Promise<void> { if (e.getAttribute('aria-expanded') === 'false') click(e.querySelector<HTMLButtonElement>('.twisty')!); await wait(() => e.getAttribute('aria-expanded') === 'true' && e.getAttribute('aria-busy') !== 'true') }
  try {
    need(storagePassed && c.phase === 'grid-text' && /^[a-zA-Z0-9_]+$/.test(c.database), 'ISOLATION'); stage = 'CONNECTION'
    const connection = `MySQL parity ${c.runId}`; await wait(() => treeRows().some((e) => label(e) === connection)); const root = treeRows().filter((e) => e.getAttribute('aria-level') === '1'); need(root.length === 1 && label(root[0]!) === connection && !document.querySelector('.connection-dialog'), 'CONNECTION'); click(root[0]!)
    await wait(() => !!document.querySelector('.connection-summary')); need(one<HTMLElement>('.connection-summary strong').textContent === connection, 'CONNECTION'); report.checks.persisted_connection = true
    click(button('.connection-summary .connection-actions', '连接')); await wait(() => idle() && all<HTMLButtonElement>('.connection-summary button').some((e) => e.textContent?.trim() === '断开')); report.checks.credential_reconnect = true
    stage = 'SETUP'; const name = `gui_txt_${c.runId}`, table = `\`${c.database}\`.\`${name}\``
    await execute(`CREATE TABLE ${table} (id INT PRIMARY KEY,long_text LONGTEXT NOT NULL,json_value JSON NOT NULL) ENGINE=InnoDB`)
    await execute(`INSERT INTO ${table} VALUES (1,'${baselineLong}','${baselineJson}')`)
    need(tx().uiActive && tx().uiPendingAffected === 1, 'SETUP'); click(button('.result-grid .result-actions', '提交')); await tick(); await wait(() => idle() && !tx().uiActive && (one<HTMLElement>('#status-bar').textContent ?? '').startsWith('已提交当前连接事务')); report.checks.fixture_created = true
    stage = 'TREE'; await expand(tree(connection)); for (let i = 0; i < 4 && !treeRows().some((e) => label(e) === c.database); i++) { const folder = treeRows().find((e) => e.dataset.nodeId?.includes('folder:schemas') && e.getAttribute('aria-expanded') === 'false'); need(folder, 'TREE'); await expand(folder) }
    await wait(() => treeRows().some((e) => label(e) === c.database)); await expand(tree(c.database)); const folder = treeRows().find((e) => e.dataset.nodeId?.endsWith('|tables')); need(folder, 'TREE'); await expand(folder); await wait(() => treeRows().some((e) => label(e) === name)); const tableRow = tree(name); click(tableRow); dblclick(tableRow)
    await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').length === 3); click(button('.result-grid thead', 'id')); await tick(); await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').some((e) => e.textContent?.trim() === 'id ↑')); report.checks.table_open = true
    stage = 'FULL_VALUE'; const tableTab = one<HTMLButtonElement>('.result-tabs .result-tab.is-active .tab-label'), baselinePreview = await previews(), initial = await fullValues(), baselineLongSha = await sha(initial[0]), baselineJsonSha = await sha(initial[1])
    report.proof = { rowCount: 1, editedColumns: 2, baselineLongSha256: baselineLongSha, baselineJsonSha256: baselineJsonSha, draftLongSha256: null, draftJsonSha256: null, appliedLongSha256: null, appliedJsonSha256: null, committedLongSha256: null, committedJsonSha256: null, baselineValuesSha256: await pairHash(baselineLongSha, baselineJsonSha), draftValuesSha256: null, appliedValuesSha256: null, committedValuesSha256: null, uncommittedProjectionSha256: null, committedProjectionSha256: null, witnessConnectionId: null, uiActiveAfterApply: null, uiPendingAffectedAfterApply: null, dirtyRowsBeforeApply: null, dirtyRowsAfterApply: null, baselinePreview, appliedPreview: null, committedPreview: null }
    report.checks.preview_truncated = await prefixesMatch(baselinePreview, initial); report.checks.baseline_full = initial[0] === baselineLong; const baselineInteger = integerExact(initial[1], '9007199254740993')
    stage = 'CHECKPOINT'; await checkpoint('baseline', report.proof.baselineValuesSha256)
    need(report.checks.baseline_full, 'BASELINE_MISMATCH'); need(baselineInteger, 'JSON_LOSS'); need(report.checks.preview_truncated, 'PREVIEW'); need(!tx().uiActive && tx().uiPendingAffected === 0 && dirty() === 0, 'TRANSACTION_LOST')
    let editorFull = true
    for (let i = 0; i < 2; i++) {
      stage = 'FULL_VALUE'; dblclick(cells()[i]!); await wait(() => !!document.querySelector('[aria-label="编辑单元格"] textarea') || !!document.querySelector('.result-grid .inline-error'), true); need(!!document.querySelector('[aria-label="编辑单元格"] textarea'), 'FULL_VALUE')
      const input = one<HTMLTextAreaElement>('[aria-label="编辑单元格"] textarea'), box = one<HTMLInputElement>('[aria-label="编辑单元格"] input[type="checkbox"]')
      if (input.disabled || box.checked || input.value !== initial[i]) { editorFull = false; click(button('[aria-label="编辑单元格"]', '取消')); await tick(); break }
      stage = 'EDIT'; fill(input, i === 0 ? editedLong : editedJson); click(button('[aria-label="编辑单元格"]', '保存到本地修改')); await tick(); await wait(() => !document.querySelector('[aria-label="编辑单元格"]'), true)
    }
    report.checks.editor_full = editorFull; report.checks.local_edits = dirty() === 1 && !tx().uiActive && tx().uiPendingAffected === 0
    stage = 'FULL_VALUE'; const drafted = await fullValues(); report.proof.draftLongSha256 = await sha(drafted[0]); report.proof.draftJsonSha256 = await sha(drafted[1]); report.proof.draftValuesSha256 = await pairHash(report.proof.draftLongSha256, report.proof.draftJsonSha256); report.proof.dirtyRowsBeforeApply = dirty()
    report.checks.draft_full = drafted[0] === editedLong && drafted[1] === editedJson && cells()[0].textContent === editedLong && cells()[1].textContent === editedJson
    stage = 'CHECKPOINT'; await checkpoint('draft', report.proof.draftValuesSha256)
    need(editorFull && report.checks.draft_full, 'VALUE_LOSS'); need(report.checks.local_edits, 'TRANSACTION_LOST'); need(integerExact(drafted[1], '9007199254740995'), 'JSON_LOSS')
    stage = 'APPLY_FAILED'; click(button('.result-grid .result-actions', '应用修改', true)); await tick(); await wait(() => idle(), true)
    const state = tx(); report.proof.uiActiveAfterApply = state.uiActive; report.proof.uiPendingAffectedAfterApply = state.uiPendingAffected; report.proof.dirtyRowsAfterApply = dirty(); report.checks.apply_succeeded = dirty() === 0 && !document.querySelector('#status-bar.is-error, .result-grid .inline-error'); report.checks.uncommitted_transaction = state.uiActive && state.uiPendingAffected === 1
    stage = 'FULL_VALUE'; report.proof.appliedPreview = await previews(); const applied = await fullValues(); report.proof.appliedLongSha256 = await sha(applied[0]); report.proof.appliedJsonSha256 = await sha(applied[1]); report.proof.appliedValuesSha256 = await pairHash(report.proof.appliedLongSha256, report.proof.appliedJsonSha256); report.checks.applied_full = applied[0] === editedLong && integerExact(applied[1], '9007199254740995'); report.checks.preview_truncated = report.checks.preview_truncated && await prefixesMatch(report.proof.appliedPreview, applied)
    let queryTab: HTMLButtonElement | null = null
    if (report.checks.apply_succeeded) {
      stage = 'WITNESS_FAILED'; await execute(`SELECT CONNECTION_ID() AS connection_id,CHAR_LENGTH(long_text) AS long_chars,OCTET_LENGTH(long_text) AS long_bytes,SHA2(long_text,256) AS long_sha256,SHA2(CAST(json_value AS CHAR),256) AS json_sha256,CAST(JSON_EXTRACT(json_value,'$.largeInteger') AS CHAR) AS json_large_integer,JSON_TYPE(JSON_EXTRACT(json_value,'$.largeInteger')) AS json_integer_type,HEX(JSON_UNQUOTE(JSON_EXTRACT(json_value,'$.message'))) AS json_message_hex,SHA2(CAST(json_value AS CHAR),256)=SHA2(CAST(CAST('${editedJson}' AS JSON) AS CHAR),256) AS json_exact_match FROM ${table} WHERE id=1`)
      const read = witness(); queryTab = one<HTMLButtonElement>('.result-tabs .result-tab.is-active .tab-label'); report.proof.witnessConnectionId = read.id; report.proof.uncommittedProjectionSha256 = await sha(JSON.stringify({ columns: projectionColumns, rows: [read.projection] }))
      report.checks.same_session_witness = read.projection[0] === '1810' && read.projection[1] === '6310' && read.projection[2] === report.proof.appliedLongSha256 && read.projection[3] === report.proof.appliedJsonSha256 && read.projection[4] === '9007199254740995' && read.projection[5] === 'UNSIGNED INTEGER' && read.projection[6] === Array.from(new TextEncoder().encode('改后🚀'), (b) => b.toString(16).padStart(2,'0')).join('').toUpperCase() && read.projection[7] === '1'
      click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true)
    }
    stage = 'CHECKPOINT'; await checkpoint('applied', report.proof.appliedValuesSha256, report.proof.witnessConnectionId, report.proof.uncommittedProjectionSha256)
    need(report.checks.apply_succeeded, 'APPLY_FAILED'); need(report.checks.applied_full, 'VALUE_LOSS'); need(report.checks.uncommitted_transaction, 'TRANSACTION_LOST'); need(report.checks.preview_truncated, 'PREVIEW'); need(report.checks.same_session_witness && queryTab, 'WITNESS_FAILED')
    stage = 'COMMIT_FAILED'; click(button('.result-grid .result-actions', '提交')); await tick(); await wait(() => idle() && (!!document.querySelector('#status-bar.is-error, .result-grid .inline-error') || (one<HTMLElement>('#status-bar').textContent ?? '').startsWith('已提交当前连接事务')), true); report.checks.normal_commit = !tx().uiActive && tx().uiPendingAffected === 0 && !document.querySelector('#status-bar.is-error, .result-grid .inline-error'); need(report.checks.normal_commit, 'COMMIT_FAILED')
    stage = 'FULL_VALUE'; report.proof.committedPreview = await previews(); const committed = await fullValues(); report.proof.committedLongSha256 = await sha(committed[0]); report.proof.committedJsonSha256 = await sha(committed[1]); report.proof.committedValuesSha256 = await pairHash(report.proof.committedLongSha256, report.proof.committedJsonSha256); report.checks.committed_full = committed[0] === editedLong && committed[1] === applied[1]; report.checks.preview_truncated = report.checks.preview_truncated && await prefixesMatch(report.proof.committedPreview, committed)
    click(queryTab); await tick(); await wait(() => idle() && queryTab.getAttribute('aria-selected') === 'true', true); const reloaded = witness(); report.proof.committedProjectionSha256 = await sha(JSON.stringify({ columns: projectionColumns, rows: [reloaded.projection] })); report.checks.reloaded_exact_values = reloaded.id === report.proof.witnessConnectionId && report.proof.committedProjectionSha256 === report.proof.uncommittedProjectionSha256
    click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true); report.checks.transaction_ended = !tx().uiActive && tx().uiPendingAffected === 0 && dirty() === 0; report.checks.json_integer_exact = baselineInteger && integerExact(drafted[1], '9007199254740995') && integerExact(applied[1], '9007199254740995') && integerExact(committed[1], '9007199254740995')
    stage = 'CHECKPOINT'; await checkpoint('committed', report.proof.committedValuesSha256, reloaded.id, report.proof.committedProjectionSha256)
    need(report.checks.committed_full, 'VALUE_LOSS'); need(report.checks.preview_truncated, 'PREVIEW'); need(report.checks.json_integer_exact, 'JSON_LOSS'); need(report.checks.reloaded_exact_values, 'WITNESS_FAILED'); need(report.checks.transaction_ended, 'TRANSACTION_LOST')
  } catch (error) { report.failureCode = error instanceof Fault ? error.code : stage }
  report.elapsedMs = Math.round(performance.now() - began)
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}

async function runPrecisionDom(c: Context): Promise<void> {
  class Fault extends Error { constructor(readonly code: PrecisionFailureCode) { super(code) } }
  function need(value: unknown, code: PrecisionFailureCode): asserts value { if (!value) throw new Fault(code) }
  const columns = ['id','unsigned_big','signed_big','exact_decimal','utf8_text','nullable_text','empty_text']
  const projectionColumns = ['unsigned_big','signed_big','exact_decimal','utf8_hex','nullable_is_null','nullable_hex','empty_is_null','empty_hex']
  const baseline: (string | null)[] = ['1','18446744073709551615','-9223372036854775808','12345678901234567890123456789012345.123456789012345678901234567890','种子-你好-😀',null,'']
  const edited: (string | null)[] = ['1','18446744073709551614','-9223372036854775807','-98765432109876543210987654321012345.987654321098765432109876543210','编辑-你好-🚀','',null]
  const began = performance.now(), report: PrecisionReport = { schemaVersion: 1, runId: c.runId, phase: 'grid-precision', actionDriver: 'native-dom-synthetic',
    checks: { storage_marker: storagePassed, persisted_connection: false, credential_reconnect: false, fixture_created: false, table_open: false, exact_baseline: false, editor_exact: false, local_edits: false, null_empty_distinct: false, apply_succeeded: false, uncommitted_transaction: false, same_session_witness: false, normal_commit: false, reloaded_exact_values: false, transaction_ended: false },
    proof: null, actions: { click: 0, input: 0, keydown: 0, dblclick: 0 }, elapsedMs: 0, failureCode: 'NONE' }
  let stage: PrecisionFailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const all = <T extends HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector)).filter(visible)
  function one<T extends HTMLElement>(selector: string): T { const a = all<T>(selector); need(a.length === 1, stage); return a[0]! }
  function button(scope: string, text: string, prefix = false): HTMLButtonElement { const a = all<HTMLButtonElement>(`${scope} button`).filter((e) => prefix ? e.textContent?.trim().startsWith(text) : e.textContent?.trim() === text); need(a.length === 1, stage); return a[0]! }
  function click(e: HTMLElement): void { need(visible(e) && !(e instanceof HTMLButtonElement && e.disabled), stage); report.actions.click++; e.click() }
  function dblclick(e: HTMLElement): void { need(visible(e), stage); report.actions.dblclick++; e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) }
  function fill(e: HTMLTextAreaElement, text: string): void { need(visible(e) && !e.disabled, stage); e.focus(); e.value = text; report.actions.input++; e.dispatchEvent(new Event('input', { bubbles: true })) }
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  async function wait(predicate: () => boolean, allowError = false): Promise<void> { const end = performance.now() + 20000; while (!predicate()) { if (!allowError) need(!document.querySelector('#status-bar.is-error, .result-grid .inline-error, .command-result.is-error, .tree-note.is-error'), stage); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 40)) } }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  function tx(): { uiActive: boolean; uiPendingAffected: number } { const text = one<HTMLElement>('.result-grid .transaction-state').textContent?.trim(); if (text === '无活动事务') return { uiActive: false, uiPendingAffected: 0 }; const m = /^未提交 · (\d+) 行$/.exec(text ?? ''); need(m && Number(m[1]) <= 1000, stage); return { uiActive: true, uiPendingAffected: Number(m[1]) } }
  const dirty = () => all<HTMLTableRowElement>('.result-grid tbody tr').filter((r) => r.querySelector('td.is-dirty')).length
  function row(): (string | null)[] { need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim().replace(/ [↑↓]$/, '')).join(',') === columns.join(',') && all('.result-grid tbody tr').length === 1, stage); const cells = all<HTMLTableCellElement>('.result-grid tbody tr td').slice(1); need(cells.length === 7, stage); return cells.map((e) => e.classList.contains('is-null') ? null : e.textContent ?? '') }
  async function digest(cols: string[], values: (string | null)[]): Promise<string> { const bytes = new TextEncoder().encode(JSON.stringify({ columns: cols, rows: [values] })); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('') }
  const hex = (text: string) => Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
  function project(values: (string | null)[]): string[] { need(values.length === 7 && values.slice(1,5).every((v) => typeof v === 'string'), stage); return [values[1]!,values[2]!,values[3]!,hex(values[4]!),values[5] === null ? '1' : '0',hex(values[5] ?? ''),values[6] === null ? '1' : '0',hex(values[6] ?? '')] }
  function same(a: (string | null)[], b: (string | null)[]): boolean { return JSON.stringify(a) === JSON.stringify(b) }
  async function execute(sql: string): Promise<void> { const n = all('.result-tabs .result-tab').length; fill(one<HTMLTextAreaElement>('#sql-input'), sql); click(one<HTMLButtonElement>('#btn-run-sql')); await tick(); await wait(() => idle() && all('.result-tabs .result-tab').length === n + 1, true) }
  function witness(): { id: number; projection: string[] } { need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim()).join(',') === ['connection_id',...projectionColumns].join(',') && all('.result-grid tbody tr').length === 1, 'WITNESS_FAILED'); const cells = all<HTMLTableCellElement>('.result-grid tbody tr td').slice(1); need(cells.length === 9 && cells.every((e) => !e.classList.contains('is-null')), 'WITNESS_FAILED'); const texts = cells.map((e) => e.textContent ?? ''); need(/^[1-9][0-9]*$/.test(texts[0]!) && Number.isSafeInteger(Number(texts[0])), 'WITNESS_FAILED'); return { id: Number(texts[0]), projection: texts.slice(1) } }
  async function checkpoint(step: 'baseline' | 'draft' | 'applied' | 'committed', sha: string, id: number | null = null, projectionSha: string | null = null): Promise<void> {
    await bridge('mysqlAcceptancePrecisionCheckpoint', [{ schemaVersion: 1, step, ...tx(), dirtyRows: dirty(), rowsSha256: sha, witnessConnectionId: id, witnessProjectionSha256: projectionSha }])
    const end = performance.now() + 30000
    for (;;) { const r = await bridge<{ ready: boolean; verified: boolean }>('mysqlAcceptancePrecisionContinue', [{ schemaVersion: 1, step }]); need(r && Object.keys(r).sort().join(',') === 'ready,verified' && typeof r.ready === 'boolean' && typeof r.verified === 'boolean', 'NATIVE_BRIDGE'); if (r.ready) { need(r.verified, 'CHECKPOINT'); return } need(!r.verified, 'NATIVE_BRIDGE'); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 60)) }
  }
  const treeRows = () => all<HTMLElement>('.metadata-tree .tree-row[data-node-id]'), label = (e: HTMLElement) => e.querySelector('.row-label')?.textContent?.trim() ?? ''
  function tree(name: string): HTMLElement { const a = treeRows().filter((e) => label(e) === name); need(a.length === 1, 'TREE'); return a[0]! }
  async function expand(e: HTMLElement): Promise<void> { if (e.getAttribute('aria-expanded') === 'false') click(e.querySelector<HTMLButtonElement>('.twisty')!); await wait(() => e.getAttribute('aria-expanded') === 'true' && e.getAttribute('aria-busy') !== 'true') }
  try {
    need(storagePassed && c.phase === 'grid-precision' && /^[a-zA-Z0-9_]+$/.test(c.database), 'ISOLATION'); stage = 'CONNECTION'
    const connection = `MySQL parity ${c.runId}`; await wait(() => treeRows().some((e) => label(e) === connection)); const root = treeRows().filter((e) => e.getAttribute('aria-level') === '1'); need(root.length === 1 && label(root[0]!) === connection && !document.querySelector('.connection-dialog'), 'CONNECTION'); click(root[0]!)
    await wait(() => !!document.querySelector('.connection-summary')); need(one<HTMLElement>('.connection-summary strong').textContent === connection, 'CONNECTION'); report.checks.persisted_connection = true
    click(button('.connection-summary .connection-actions', '连接')); await wait(() => idle() && all<HTMLButtonElement>('.connection-summary button').some((e) => e.textContent?.trim() === '断开')); report.checks.credential_reconnect = true
    stage = 'SETUP'; const name = `gui_px_${c.runId}`, table = `\`${c.database}\`.\`${name}\``
    await execute(`CREATE TABLE ${table} (id INT PRIMARY KEY,unsigned_big BIGINT UNSIGNED NOT NULL,signed_big BIGINT NOT NULL,exact_decimal DECIMAL(65,30) NOT NULL,utf8_text VARCHAR(128) NOT NULL,nullable_text VARCHAR(64) NULL,empty_text VARCHAR(64) NULL) ENGINE=InnoDB`)
    await execute(`INSERT INTO ${table} VALUES (1,18446744073709551615,-9223372036854775808,12345678901234567890123456789012345.123456789012345678901234567890,'种子-你好-😀',NULL,'')`)
    need(tx().uiActive && tx().uiPendingAffected === 1, 'SETUP'); click(button('.result-grid .result-actions', '提交')); await tick(); await wait(() => idle() && !tx().uiActive && (one<HTMLElement>('#status-bar').textContent ?? '').startsWith('已提交当前连接事务')); report.checks.fixture_created = true
    stage = 'TREE'; await expand(tree(connection)); for (let i = 0; i < 4 && !treeRows().some((e) => label(e) === c.database); i++) { const folder = treeRows().find((e) => e.dataset.nodeId?.includes('folder:schemas') && e.getAttribute('aria-expanded') === 'false'); need(folder, 'TREE'); await expand(folder) }
    await wait(() => treeRows().some((e) => label(e) === c.database)); await expand(tree(c.database)); const folder = treeRows().find((e) => e.dataset.nodeId?.endsWith('|tables')); need(folder, 'TREE'); await expand(folder); await wait(() => treeRows().some((e) => label(e) === name)); const tableRow = tree(name); click(tableRow); dblclick(tableRow)
    await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').length === 7); click(button('.result-grid thead', 'id')); await tick(); await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').some((e) => e.textContent?.trim() === 'id ↑')); report.checks.table_open = true
    stage = 'BASELINE_MISMATCH'; const actual = row(), tableTab = one<HTMLButtonElement>('.result-tabs .result-tab.is-active .tab-label')
    report.proof = { rowCount: 1, editedColumns: 6, baselineRowsSha256: await digest(columns, actual), draftRowsSha256: null, appliedRowsSha256: null, committedRowsSha256: null, baselineProjectionSha256: await digest(projectionColumns, project(actual)), uncommittedProjectionSha256: null, committedProjectionSha256: null, witnessConnectionId: null, uiActiveAfterApply: null, uiPendingAffectedAfterApply: null, dirtyRowsAfterApply: null, dirtyRowsBeforeApply: null }
    need(!tx().uiActive && tx().uiPendingAffected === 0 && dirty() === 0, 'BASELINE_MISMATCH'); report.checks.exact_baseline = same(actual, baseline)
    stage = 'CHECKPOINT'; await checkpoint('baseline', report.proof.baselineRowsSha256); need(report.checks.exact_baseline, 'BASELINE_MISMATCH')
    stage = 'EDIT'; let editorExact = true
    for (let col = 1; col <= 6; col++) {
      const cell = one<HTMLTableCellElement>(`.result-grid tbody tr td:nth-child(${col + 2})`); dblclick(cell); await wait(() => !!document.querySelector('[aria-label="编辑单元格"] textarea'), true)
      const input = one<HTMLTextAreaElement>('[aria-label="编辑单元格"] textarea'), nullBox = one<HTMLInputElement>('[aria-label="编辑单元格"] input[type="checkbox"]'), old = baseline[col]!, value = edited[col]!
      const exact = input.value === (old ?? '') && input.disabled === (old === null) && nullBox.checked === (old === null); editorExact = editorExact && exact
      if (!exact) { click(button('[aria-label="编辑单元格"]', '取消')); await tick(); break }
      if (col === 5) { click(nullBox); await tick(); need(!input.disabled && !nullBox.checked, 'EDIT'); fill(input, '') }
      else if (col === 6) { click(nullBox); await tick(); need(input.disabled && nullBox.checked, 'EDIT') }
      else fill(input, value!)
      click(button('[aria-label="编辑单元格"]', '保存到本地修改')); await tick(); await wait(() => !document.querySelector('[aria-label="编辑单元格"]'), true)
    }
    const drafted = row(); report.checks.editor_exact = editorExact; report.checks.local_edits = same(drafted, edited) && dirty() === 1 && !tx().uiActive && tx().uiPendingAffected === 0; report.checks.null_empty_distinct = drafted[5] === '' && drafted[6] === null
    report.proof.draftRowsSha256 = await digest(columns, drafted); report.proof.dirtyRowsBeforeApply = dirty(); stage = 'CHECKPOINT'; await checkpoint('draft', report.proof.draftRowsSha256)
    need(editorExact && report.checks.local_edits, 'VALUE_LOSS'); need(report.checks.null_empty_distinct, 'NULL_EMPTY_LOST')
    stage = 'APPLY_FAILED'; click(button('.result-grid .result-actions', '应用修改', true)); await tick(); await wait(() => idle(), true)
    const state = tx(), applied = row(); report.proof.uiActiveAfterApply = state.uiActive; report.proof.uiPendingAffectedAfterApply = state.uiPendingAffected; report.proof.dirtyRowsAfterApply = dirty(); report.proof.appliedRowsSha256 = await digest(columns, applied)
    report.checks.apply_succeeded = dirty() === 0 && !document.querySelector('#status-bar.is-error, .result-grid .inline-error'); report.checks.uncommitted_transaction = state.uiActive && state.uiPendingAffected === 1
    let queryTab: HTMLButtonElement | null = null
    if (report.checks.apply_succeeded) {
      stage = 'WITNESS_FAILED'; await execute(`SELECT CONNECTION_ID() AS connection_id,CAST(unsigned_big AS CHAR) AS unsigned_big,CAST(signed_big AS CHAR) AS signed_big,CAST(exact_decimal AS CHAR) AS exact_decimal,HEX(utf8_text) AS utf8_hex,nullable_text IS NULL AS nullable_is_null,HEX(COALESCE(nullable_text,'')) AS nullable_hex,empty_text IS NULL AS empty_is_null,HEX(COALESCE(empty_text,'')) AS empty_hex FROM ${table} WHERE id=1`)
      const read = witness(); queryTab = one<HTMLButtonElement>('.result-tabs .result-tab.is-active .tab-label'); report.proof.witnessConnectionId = read.id; report.proof.uncommittedProjectionSha256 = await digest(projectionColumns, read.projection)
      click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true); report.checks.same_session_witness = same(read.projection, project(edited)) && (await digest(columns, row())) === report.proof.appliedRowsSha256
    }
    stage = 'CHECKPOINT'; await checkpoint('applied', await digest(columns, row()), report.proof.witnessConnectionId, report.proof.uncommittedProjectionSha256)
    need(report.checks.apply_succeeded, 'APPLY_FAILED'); need(same(applied, edited), 'VALUE_LOSS'); need(report.checks.uncommitted_transaction, 'TRANSACTION_LOST'); need(report.checks.same_session_witness && queryTab, 'WITNESS_FAILED')
    stage = 'COMMIT_FAILED'; click(button('.result-grid .result-actions', '提交')); await tick(); await wait(() => idle() && (!!document.querySelector('#status-bar.is-error, .result-grid .inline-error') || (one<HTMLElement>('#status-bar').textContent ?? '').startsWith('已提交当前连接事务')), true); report.checks.normal_commit = !tx().uiActive && tx().uiPendingAffected === 0 && !document.querySelector('#status-bar.is-error, .result-grid .inline-error'); need(report.checks.normal_commit, 'COMMIT_FAILED')
    click(queryTab); await tick(); await wait(() => idle() && queryTab.getAttribute('aria-selected') === 'true', true); const committed = witness(); report.proof.committedProjectionSha256 = await digest(projectionColumns, committed.projection)
    click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true); report.proof.committedRowsSha256 = await digest(columns, row()); report.checks.reloaded_exact_values = same(row(), edited) && committed.id === report.proof.witnessConnectionId && same(committed.projection, project(edited)); report.checks.transaction_ended = !tx().uiActive && tx().uiPendingAffected === 0 && dirty() === 0
    stage = 'CHECKPOINT'; await checkpoint('committed', report.proof.committedRowsSha256, committed.id, report.proof.committedProjectionSha256)
    need(report.checks.reloaded_exact_values, 'VALUE_LOSS'); need(report.checks.transaction_ended, 'TRANSACTION_LOST')
  } catch (error) { report.failureCode = error instanceof Fault ? error.code : stage }
  report.elapsedMs = Math.round(performance.now() - began)
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}

async function runTimeoutDom(c: Context): Promise<void> {
  class Fault extends Error { constructor(readonly code: TimeoutFailureCode) { super(code) } }
  function need(value: unknown, code: TimeoutFailureCode): asserts value { if (!value) throw new Fault(code) }
  const began = performance.now(), report: TimeoutReport = { schemaVersion: 1, runId: c.runId, phase: 'grid-timeout', actionDriver: 'native-dom-synthetic',
    checks: { storage_marker: storagePassed, persisted_connection: false, credential_reconnect: false, fixture_created: false, table_open: false, marker_applied: false, session_settings: false, actor_held: false, local_draft: false, original_1205: false, transaction_preserved: false, draft_preserved: false, same_session_witness: false, rollback_cancel_preserved: false, normal_rollback: false, reloaded_baseline: false },
    proof: null, actions: { click: 0, input: 0, keydown: 0, dblclick: 0 }, elapsedMs: 0, failureCode: 'NONE' }
  let stage: TimeoutFailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const all = <T extends HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector)).filter(visible)
  function one<T extends HTMLElement>(selector: string): T { const a = all<T>(selector); need(a.length === 1, 'DOM_FAILED'); return a[0]! }
  function button(scope: string, text: string, prefix = false): HTMLButtonElement { const a = all<HTMLButtonElement>(`${scope} button`).filter((e) => prefix ? e.textContent?.trim().startsWith(text) : e.textContent?.trim() === text); need(a.length === 1, 'DOM_FAILED'); return a[0]! }
  function click(e: HTMLElement): void { need(visible(e) && !(e instanceof HTMLButtonElement && e.disabled), 'DOM_FAILED'); report.actions.click++; e.click() }
  function dblclick(e: HTMLElement): void { need(visible(e), 'DOM_FAILED'); report.actions.dblclick++; e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) }
  function fill(e: HTMLTextAreaElement, text: string): void { need(visible(e) && !e.disabled, 'DOM_FAILED'); e.focus(); e.value = text; report.actions.input++; e.dispatchEvent(new Event('input', { bubbles: true })) }
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  async function wait(predicate: () => boolean, allowError = false, ms = 20000): Promise<void> { const end = performance.now() + ms; while (!predicate()) { if (!allowError) need(!document.querySelector('#status-bar.is-error, .result-grid .inline-error, .command-result.is-error, .tree-note.is-error'), stage); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 40)) } }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  function tx(): { uiActive: boolean; uiPendingAffected: number } { const text = one<HTMLElement>('.result-grid .transaction-state').textContent?.trim(); if (text === '无活动事务') return { uiActive: false, uiPendingAffected: 0 }; const m = /^未提交 · (\d+) 行$/.exec(text ?? ''); need(m && Number(m[1]) <= 1000, 'DOM_FAILED'); return { uiActive: true, uiPendingAffected: Number(m[1]) } }
  function rows(): string[][] { const headers = all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim().replace(/ [↑↓]$/, '')); const values = all<HTMLTableRowElement>('.result-grid tbody tr').map((r) => Array.from(r.querySelectorAll('td')).slice(1).map((e) => e.textContent ?? '')); need(headers.join(',') === 'id,u,v' && values.length === 4 && values.every((r, i) => r.length === 3 && r[0] === String(i + 1) && /^[1-4]$/.test(r[1]!) && /^[0-7]$/.test(r[2]!)), 'DOM_FAILED'); return values }
  function cell(id: number, col: 1 | 2): HTMLTableCellElement { return one<HTMLTableCellElement>(`.result-grid tbody tr:nth-child(${id}) td:nth-child(${col + 2})`) }
  const dirty = () => all<HTMLTableRowElement>('.result-grid tbody tr').filter((r) => r.querySelector('td.is-dirty')).length
  async function snapshot(): Promise<string> { const bytes = new TextEncoder().encode(JSON.stringify({ columns: ['id','u','v'], rows: rows() })); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('') }
  async function execute(sql: string): Promise<void> { const n = all('.result-tabs .result-tab').length; fill(one<HTMLTextAreaElement>('#sql-input'), sql); click(one<HTMLButtonElement>('#btn-run-sql')); await tick(); await wait(() => idle() && all('.result-tabs .result-tab').length === n + 1, true) }
  async function edit(id: number, col: 1 | 2, value: string): Promise<void> { dblclick(cell(id, col)); await wait(() => !!document.querySelector('[aria-label="编辑单元格"] textarea'), true); fill(one<HTMLTextAreaElement>('[aria-label="编辑单元格"] textarea'), value); click(button('[aria-label="编辑单元格"]', '保存到本地修改')); await tick(); await wait(() => !document.querySelector('[aria-label="编辑单元格"]'), true) }
  function witness(): { id: number; value: number; seconds: number; rollback: boolean } {
    need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim()).join(',') === 'connection_id,marker_value,lock_wait_timeout,rollback_on_timeout' && all('.result-grid tbody tr').length === 1, 'WITNESS_FAILED')
    const texts = [2,3,4,5].map((n) => one<HTMLElement>(`.result-grid tbody td:nth-child(${n})`).textContent?.trim() ?? '')
    need(/^[1-9][0-9]*$/.test(texts[0]!) && Number.isSafeInteger(Number(texts[0])) && ['0','7'].includes(texts[1]!) && /^[1-9][0-9]*$/.test(texts[2]!) && Number(texts[2]) <= 3600 && ['0','1'].includes(texts[3]!), 'WITNESS_FAILED')
    return { id: Number(texts[0]), value: Number(texts[1]), seconds: Number(texts[2]), rollback: texts[3] === '1' }
  }
  async function checkpoint(step: 'marker' | 'failed' | 'rolled-back', original1205: boolean, id: number | null, value: number | null, seconds: number | null, rollback: boolean | null): Promise<void> {
    await bridge('mysqlAcceptanceTimeoutCheckpoint', [{ schemaVersion: 1, step, ...tx(), dirtyRows: dirty(), row1Value: Number(cell(1, 2).textContent), row3Value: Number(cell(3, 2).textContent), original1205, witnessConnectionId: id, witnessMarkerValue: value, sessionTimeoutSeconds: seconds, rollbackOnTimeout: rollback }])
    const end = performance.now() + 30000
    for (;;) { const r = await bridge<{ ready: boolean; verified: boolean }>('mysqlAcceptanceTimeoutContinue', [{ schemaVersion: 1, step }]); need(r && Object.keys(r).sort().join(',') === 'ready,verified' && typeof r.ready === 'boolean' && typeof r.verified === 'boolean', 'NATIVE_BRIDGE'); if (r.ready) { need(r.verified, 'CHECKPOINT'); return } need(!r.verified, 'NATIVE_BRIDGE'); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 60)) }
  }
  const treeRows = () => all<HTMLElement>('.metadata-tree .tree-row[data-node-id]'), label = (e: HTMLElement) => e.querySelector('.row-label')?.textContent?.trim() ?? ''
  function tree(name: string): HTMLElement { const a = treeRows().filter((e) => label(e) === name); need(a.length === 1, 'TREE'); return a[0]! }
  async function expand(e: HTMLElement): Promise<void> { if (e.getAttribute('aria-expanded') === 'false') click(e.querySelector<HTMLButtonElement>('.twisty')!); await wait(() => e.getAttribute('aria-expanded') === 'true' && e.getAttribute('aria-busy') !== 'true') }
  try {
    need(storagePassed && c.phase === 'grid-timeout' && /^[a-zA-Z0-9_]+$/.test(c.database), 'ISOLATION'); stage = 'CONNECTION'
    const connection = `MySQL parity ${c.runId}`; await wait(() => treeRows().some((e) => label(e) === connection)); const root = treeRows().filter((e) => e.getAttribute('aria-level') === '1'); need(root.length === 1 && label(root[0]!) === connection && !document.querySelector('.connection-dialog'), 'CONNECTION'); click(root[0]!)
    await wait(() => !!document.querySelector('.connection-summary')); need(one<HTMLElement>('.connection-summary strong').textContent === connection, 'CONNECTION'); report.checks.persisted_connection = true
    click(button('.connection-summary .connection-actions', '连接')); await wait(() => idle() && all<HTMLButtonElement>('.connection-summary button').some((e) => e.textContent?.trim() === '断开')); report.checks.credential_reconnect = true
    stage = 'SETUP'; const name = `gui_to_${c.runId}`, table = `\`${c.database}\`.\`${name}\``
    await execute(`CREATE TABLE ${table} (id INT PRIMARY KEY,u INT NOT NULL UNIQUE,v INT NOT NULL DEFAULT 0) ENGINE=InnoDB`); await execute(`INSERT INTO ${table} (id,u,v) VALUES (1,1,0),(2,2,0),(3,3,0),(4,4,0)`)
    need(tx().uiActive && tx().uiPendingAffected === 4, 'SETUP'); click(button('.result-grid .result-actions', '提交')); await tick(); await wait(() => idle() && !tx().uiActive && (one<HTMLElement>('#status-bar').textContent ?? '').startsWith('已提交当前连接事务')); report.checks.fixture_created = true
    stage = 'TREE'; await expand(tree(connection)); for (let i = 0; i < 4 && !treeRows().some((e) => label(e) === c.database); i++) { const folder = treeRows().find((e) => e.dataset.nodeId?.includes('folder:schemas') && e.getAttribute('aria-expanded') === 'false'); need(folder, 'TREE'); await expand(folder) }
    await wait(() => treeRows().some((e) => label(e) === c.database)); await expand(tree(c.database)); const folder = treeRows().find((e) => e.dataset.nodeId?.endsWith('|tables')); need(folder, 'TREE'); await expand(folder); await wait(() => treeRows().some((e) => label(e) === name)); const tableRow = tree(name); click(tableRow); dblclick(tableRow)
    await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').some((e) => e.textContent?.trim() === 'v')); click(button('.result-grid thead', 'id')); await tick(); await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').some((e) => e.textContent?.trim() === 'id ↑'))
    need(rows().every((r, i) => r[1] === String(i + 1) && r[2] === '0') && !tx().uiActive && dirty() === 0, 'TREE'); report.checks.table_open = true
    const tableTab = one<HTMLButtonElement>('.result-tabs .result-tab.is-active .tab-label'), baseline = await snapshot()
    stage = 'EDIT'; await edit(3, 2, '7'); click(button('.result-grid .result-actions', '应用修改', true)); await tick(); await wait(() => idle() && dirty() === 0 && tx().uiActive && tx().uiPendingAffected === 1); need(cell(3, 2).textContent === '7', 'EDIT'); report.checks.marker_applied = true
    report.proof = { rowCount: 4, baselineRowsSha256: baseline, markerRowsSha256: await snapshot(), faultRowsSha256: null, restoredRowsSha256: null, uiActiveAfterError: null, uiPendingAffectedAfterError: null, dirtyRowsAfterError: null, originalErrorClass: null, witnessConnectionId: null, markerValueAfterError: null, markerValueAfterRollback: null, sessionTimeoutSeconds: null, rollbackOnTimeout: null }
    stage = 'SESSION_SETTINGS'; await execute(`SELECT CONNECTION_ID() AS connection_id,v AS marker_value,@@SESSION.innodb_lock_wait_timeout AS lock_wait_timeout,@@GLOBAL.innodb_rollback_on_timeout AS rollback_on_timeout FROM ${table} WHERE id=3`)
    const before = witness(); report.proof.witnessConnectionId = before.id; report.proof.sessionTimeoutSeconds = before.seconds; report.proof.rollbackOnTimeout = before.rollback
    click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true)
    need(before.value === 7 && before.seconds === 5 && before.rollback === false && (await snapshot()) === report.proof.markerRowsSha256, 'SESSION_SETTINGS'); report.checks.session_settings = true
    stage = 'CHECKPOINT'; await checkpoint('marker', false, before.id, before.value, before.seconds, before.rollback); report.checks.actor_held = true
    stage = 'EDIT'; await edit(1, 2, '1'); need(dirty() === 1 && cell(1, 2).textContent === '1', 'EDIT'); report.checks.local_draft = true
    click(button('.result-grid .result-actions', '应用修改', true)); await tick(); await wait(() => idle() && !!document.querySelector('#status-bar.is-error, .result-grid .inline-error'), true, 15000)
    // Capture before any normal SQL witness or transaction operation can refresh product state.
    const state = tx(), dirtyCount = dirty(), text = all<HTMLElement>('#status-bar, .result-grid .inline-error').map((e) => e.textContent ?? '').join(' '), original = /\b1205\b/.test(text) && /\bHY000\b/.test(text)
    report.proof.uiActiveAfterError = state.uiActive; report.proof.uiPendingAffectedAfterError = state.uiPendingAffected; report.proof.dirtyRowsAfterError = dirtyCount; report.proof.originalErrorClass = original ? '1205' : 'other'; report.proof.faultRowsSha256 = await snapshot()
    report.checks.original_1205 = original; report.checks.transaction_preserved = state.uiActive && state.uiPendingAffected === 1; report.checks.draft_preserved = dirtyCount === 1 && cell(1, 2).textContent === '1'
    stage = 'WITNESS_FAILED'; await execute(`SELECT CONNECTION_ID() AS connection_id,v AS marker_value,@@SESSION.innodb_lock_wait_timeout AS lock_wait_timeout,@@GLOBAL.innodb_rollback_on_timeout AS rollback_on_timeout FROM ${table} WHERE id=3`); const after = witness(), queryTab = one<HTMLButtonElement>('.result-tabs .result-tab.is-active .tab-label')
    report.proof.witnessConnectionId = after.id; report.proof.markerValueAfterError = after.value; click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true)
    const draftUnchanged = (await snapshot()) === report.proof.faultRowsSha256
    report.checks.same_session_witness = after.id === before.id && after.value === 7 && after.seconds === 5 && after.rollback === false && draftUnchanged
    stage = 'CHECKPOINT'; await checkpoint('failed', original, after.id, after.value, after.seconds, after.rollback)
    need(original, 'MYSQL_ERROR_DETAILS_LOST'); need(report.checks.transaction_preserved, 'TRANSACTION_LOST'); need(report.checks.draft_preserved && draftUnchanged, 'DRAFT_LOST'); need(after.id === before.id && after.value === 7, 'WITNESS_FAILED'); need(after.seconds === 5 && after.rollback === false, 'SESSION_SETTINGS')
    stage = 'RECOVERY'; click(button('.result-grid .result-actions', '回滚')); await wait(() => document.querySelector('#decision-title')?.textContent === '回滚当前连接', true); click(button('[role="dialog"][aria-labelledby="decision-title"]', '取消')); await tick(); await wait(() => !document.querySelector('#decision-title'), true)
    need(tx().uiActive && tx().uiPendingAffected === 1 && dirty() === 1 && (await snapshot()) === report.proof.faultRowsSha256, 'RECOVERY'); report.checks.rollback_cancel_preserved = true
    click(button('.result-grid .result-actions', '回滚')); await wait(() => document.querySelector('#decision-title')?.textContent === '回滚当前连接', true); click(button('[role="dialog"][aria-labelledby="decision-title"]', '确认')); await tick(); await wait(() => idle() && !document.querySelector('#decision-title') && !tx().uiActive && dirty() === 0 && rows().every((r, i) => r[1] === String(i + 1) && r[2] === '0'), true)
    report.proof.restoredRowsSha256 = await snapshot(); need(tx().uiPendingAffected === 0 && report.proof.restoredRowsSha256 === baseline, 'RECOVERY'); report.checks.normal_rollback = true
    click(queryTab); await tick(); await wait(() => idle() && queryTab.getAttribute('aria-selected') === 'true', true); const restored = witness(); report.proof.markerValueAfterRollback = restored.value; need(restored.id === before.id && restored.value === 0 && restored.seconds === 5 && restored.rollback === false, 'RECOVERY')
    click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true); need((await snapshot()) === baseline && !tx().uiActive && tx().uiPendingAffected === 0 && dirty() === 0, 'RECOVERY')
    stage = 'CHECKPOINT'; await checkpoint('rolled-back', original, after.id, restored.value, restored.seconds, restored.rollback); report.checks.reloaded_baseline = true
  } catch (error) { report.failureCode = error instanceof Fault ? error.code : stage }
  report.elapsedMs = Math.round(performance.now() - began)
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}

async function runDuplicateDom(c: Context): Promise<void> {
  class Fault extends Error { constructor(readonly code: DuplicateFailureCode) { super(code) } }
  function need(value: unknown, code: DuplicateFailureCode): asserts value { if (!value) throw new Fault(code) }
  const began = performance.now(), report: DuplicateReport = { schemaVersion: 1, runId: c.runId, phase: 'grid-duplicate', actionDriver: 'native-dom-synthetic',
    checks: { storage_marker: storagePassed, persisted_connection: false, credential_reconnect: false, fixture_created: false, table_open: false, marker_applied: false, local_draft: false, original_1062: false, transaction_preserved: false, draft_preserved: false, same_session_witness: false, rollback_cancel_preserved: false, normal_rollback: false, reloaded_baseline: false },
    proof: null, actions: { click: 0, input: 0, keydown: 0, dblclick: 0 }, elapsedMs: 0, failureCode: 'NONE' }
  let stage: DuplicateFailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const all = <T extends HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector)).filter(visible)
  function one<T extends HTMLElement>(selector: string): T { const a = all<T>(selector); need(a.length === 1, 'DOM_FAILED'); return a[0]! }
  function button(scope: string, text: string, prefix = false): HTMLButtonElement { const a = all<HTMLButtonElement>(`${scope} button`).filter((e) => prefix ? e.textContent?.trim().startsWith(text) : e.textContent?.trim() === text); need(a.length === 1, 'DOM_FAILED'); return a[0]! }
  function click(e: HTMLElement): void { need(visible(e) && !(e instanceof HTMLButtonElement && e.disabled), 'DOM_FAILED'); report.actions.click++; e.click() }
  function dblclick(e: HTMLElement): void { need(visible(e), 'DOM_FAILED'); report.actions.dblclick++; e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) }
  function fill(e: HTMLTextAreaElement, text: string): void { need(visible(e) && !e.disabled, 'DOM_FAILED'); e.focus(); e.value = text; report.actions.input++; e.dispatchEvent(new Event('input', { bubbles: true })) }
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  async function wait(predicate: () => boolean, allowError = false, ms = 20000): Promise<void> { const end = performance.now() + ms; while (!predicate()) { if (!allowError) need(!document.querySelector('#status-bar.is-error, .result-grid .inline-error, .command-result.is-error, .tree-note.is-error'), stage); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 40)) } }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  function tx(): { uiActive: boolean; uiPendingAffected: number } { const text = one<HTMLElement>('.result-grid .transaction-state').textContent?.trim(); if (text === '无活动事务') return { uiActive: false, uiPendingAffected: 0 }; const m = /^未提交 · (\d+) 行$/.exec(text ?? ''); need(m && Number(m[1]) <= 1000, 'DOM_FAILED'); return { uiActive: true, uiPendingAffected: Number(m[1]) } }
  function rows(): string[][] { const headers = all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim().replace(/ [↑↓]$/, '')); const values = all<HTMLTableRowElement>('.result-grid tbody tr').map((r) => Array.from(r.querySelectorAll('td')).slice(1).map((e) => e.textContent ?? '')); need(headers.join(',') === 'id,u,v' && values.length === 4 && values.every((r, i) => r.length === 3 && r[0] === String(i + 1) && /^[1-4]$/.test(r[1]!) && /^[0-7]$/.test(r[2]!)), 'DOM_FAILED'); return values }
  function cell(id: number, col: 1 | 2): HTMLTableCellElement { return one<HTMLTableCellElement>(`.result-grid tbody tr:nth-child(${id}) td:nth-child(${col + 2})`) }
  const dirty = () => all<HTMLTableRowElement>('.result-grid tbody tr').filter((r) => r.querySelector('td.is-dirty')).length
  async function snapshot(): Promise<string> { const bytes = new TextEncoder().encode(JSON.stringify({ columns: ['id','u','v'], rows: rows() })); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('') }
  async function execute(sql: string): Promise<void> { const n = all('.result-tabs .result-tab').length; fill(one<HTMLTextAreaElement>('#sql-input'), sql); click(one<HTMLButtonElement>('#btn-run-sql')); await tick(); await wait(() => idle() && all('.result-tabs .result-tab').length === n + 1, true) }
  async function edit(id: number, col: 1 | 2, value: string): Promise<void> { dblclick(cell(id, col)); await wait(() => !!document.querySelector('[aria-label="编辑单元格"] textarea'), true); fill(one<HTMLTextAreaElement>('[aria-label="编辑单元格"] textarea'), value); click(button('[aria-label="编辑单元格"]', '保存到本地修改')); await tick(); await wait(() => !document.querySelector('[aria-label="编辑单元格"]'), true) }
  function witness(): { id: number; value: number } { need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim()).join(',') === 'connection_id,marker_value' && all('.result-grid tbody tr').length === 1, 'WITNESS_FAILED'); const raw = one<HTMLElement>('.result-grid tbody td:nth-child(2)').textContent?.trim() ?? '', v = one<HTMLElement>('.result-grid tbody td:nth-child(3)').textContent?.trim(); need(/^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw)) && (v === '0' || v === '7'), 'WITNESS_FAILED'); return { id: Number(raw), value: Number(v) } }
  async function checkpoint(step: 'baseline' | 'failed' | 'rolled-back', original1062: boolean, id: number | null, value: number | null): Promise<void> {
    await bridge('mysqlAcceptanceDuplicateCheckpoint', [{ schemaVersion: 1, step, ...tx(), dirtyRows: dirty(), row1Unique: Number(cell(1, 1).textContent), row3Value: Number(cell(3, 2).textContent), original1062, witnessConnectionId: id, witnessMarkerValue: value }])
    const end = performance.now() + 30000
    for (;;) { const r = await bridge<{ ready: boolean; verified: boolean }>('mysqlAcceptanceDuplicateContinue', [{ schemaVersion: 1, step }]); need(r && Object.keys(r).sort().join(',') === 'ready,verified' && typeof r.ready === 'boolean' && typeof r.verified === 'boolean', 'NATIVE_BRIDGE'); if (r.ready) { need(r.verified, 'CHECKPOINT'); return } need(!r.verified, 'NATIVE_BRIDGE'); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 60)) }
  }
  const treeRows = () => all<HTMLElement>('.metadata-tree .tree-row[data-node-id]'), label = (e: HTMLElement) => e.querySelector('.row-label')?.textContent?.trim() ?? ''
  function tree(name: string): HTMLElement { const a = treeRows().filter((e) => label(e) === name); need(a.length === 1, 'TREE'); return a[0]! }
  async function expand(e: HTMLElement): Promise<void> { if (e.getAttribute('aria-expanded') === 'false') click(e.querySelector<HTMLButtonElement>('.twisty')!); await wait(() => e.getAttribute('aria-expanded') === 'true' && e.getAttribute('aria-busy') !== 'true') }
  try {
    need(storagePassed && c.phase === 'grid-duplicate' && /^[a-zA-Z0-9_]+$/.test(c.database), 'ISOLATION'); stage = 'CONNECTION'
    const connection = `MySQL parity ${c.runId}`; await wait(() => treeRows().some((e) => label(e) === connection)); const root = treeRows().filter((e) => e.getAttribute('aria-level') === '1'); need(root.length === 1 && label(root[0]!) === connection && !document.querySelector('.connection-dialog'), 'CONNECTION'); click(root[0]!)
    await wait(() => !!document.querySelector('.connection-summary')); need(one<HTMLElement>('.connection-summary strong').textContent === connection, 'CONNECTION'); report.checks.persisted_connection = true
    click(button('.connection-summary .connection-actions', '连接')); await wait(() => idle() && all<HTMLButtonElement>('.connection-summary button').some((e) => e.textContent?.trim() === '断开')); report.checks.credential_reconnect = true
    stage = 'SETUP'; const name = `gui_uq_${c.runId}`, table = `\`${c.database}\`.\`${name}\``
    await execute(`CREATE TABLE ${table} (id INT PRIMARY KEY,u INT NOT NULL UNIQUE,v INT NOT NULL DEFAULT 0) ENGINE=InnoDB`); await execute(`INSERT INTO ${table} (id,u,v) VALUES (1,1,0),(2,2,0),(3,3,0),(4,4,0)`)
    need(tx().uiActive && tx().uiPendingAffected === 4, 'SETUP'); click(button('.result-grid .result-actions', '提交')); await tick(); await wait(() => idle() && !tx().uiActive && (one<HTMLElement>('#status-bar').textContent ?? '').startsWith('已提交当前连接事务')); report.checks.fixture_created = true
    stage = 'TREE'; await expand(tree(connection)); for (let i = 0; i < 4 && !treeRows().some((e) => label(e) === c.database); i++) { const folder = treeRows().find((e) => e.dataset.nodeId?.includes('folder:schemas') && e.getAttribute('aria-expanded') === 'false'); need(folder, 'TREE'); await expand(folder) }
    await wait(() => treeRows().some((e) => label(e) === c.database)); await expand(tree(c.database)); const folder = treeRows().find((e) => e.dataset.nodeId?.endsWith('|tables')); need(folder, 'TREE'); await expand(folder); await wait(() => treeRows().some((e) => label(e) === name)); const tableRow = tree(name); click(tableRow); dblclick(tableRow)
    await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').some((e) => e.textContent?.trim() === 'v')); click(button('.result-grid thead', 'id')); await tick(); await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').some((e) => e.textContent?.trim() === 'id ↑'))
    need(rows().every((r, i) => r[1] === String(i + 1) && r[2] === '0') && !tx().uiActive && dirty() === 0, 'TREE'); report.checks.table_open = true
    const tableTab = one<HTMLButtonElement>('.result-tabs .result-tab.is-active .tab-label'), baseline = await snapshot(); stage = 'CHECKPOINT'; await checkpoint('baseline', false, null, null)
    stage = 'EDIT'; await edit(3, 2, '7'); click(button('.result-grid .result-actions', '应用修改', true)); await tick(); await wait(() => idle() && dirty() === 0 && tx().uiActive && tx().uiPendingAffected === 1); need(cell(3, 2).textContent === '7', 'EDIT'); report.checks.marker_applied = true
    report.proof = { rowCount: 4, baselineRowsSha256: baseline, markerRowsSha256: await snapshot(), faultRowsSha256: null, restoredRowsSha256: null, uiActiveAfterError: null, uiPendingAffectedAfterError: null, dirtyRowsAfterError: null, originalErrorClass: null, witnessConnectionId: null, markerValueAfterError: null, markerValueAfterRollback: null }
    await edit(1, 1, '2'); need(dirty() === 1 && cell(1, 1).textContent === '2', 'EDIT'); report.checks.local_draft = true
    click(button('.result-grid .result-actions', '应用修改', true)); await tick(); await wait(() => idle() && !!document.querySelector('#status-bar.is-error, .result-grid .inline-error'), true, 3000)
    // Capture before any normal SQL witness or transaction operation can refresh product state.
    const state = tx(), dirtyCount = dirty(), text = all<HTMLElement>('#status-bar, .result-grid .inline-error').map((e) => e.textContent ?? '').join(' '), original = /\b1062\b/.test(text) && /\b23000\b/.test(text)
    report.proof.uiActiveAfterError = state.uiActive; report.proof.uiPendingAffectedAfterError = state.uiPendingAffected; report.proof.dirtyRowsAfterError = dirtyCount; report.proof.originalErrorClass = original ? '1062' : 'other'; report.proof.faultRowsSha256 = await snapshot()
    report.checks.original_1062 = original; report.checks.transaction_preserved = state.uiActive && state.uiPendingAffected === 1; report.checks.draft_preserved = dirtyCount === 1 && cell(1, 1).textContent === '2'
    stage = 'WITNESS_FAILED'; await execute(`SELECT CONNECTION_ID() AS connection_id,v AS marker_value FROM ${table} WHERE id=3`); const after = witness(), queryTab = one<HTMLButtonElement>('.result-tabs .result-tab.is-active .tab-label')
    report.proof.witnessConnectionId = after.id; report.proof.markerValueAfterError = after.value; click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true)
    const draftUnchanged = (await snapshot()) === report.proof.faultRowsSha256
    report.checks.same_session_witness = after.value === 7 && draftUnchanged
    stage = 'CHECKPOINT'; await checkpoint('failed', original, after.id, after.value)
    need(original, 'MYSQL_ERROR_DETAILS_LOST'); need(report.checks.transaction_preserved, 'TRANSACTION_LOST'); need(report.checks.draft_preserved && draftUnchanged, 'DRAFT_LOST'); need(after.value === 7, 'WITNESS_FAILED')
    stage = 'RECOVERY'; click(button('.result-grid .result-actions', '回滚')); await wait(() => document.querySelector('#decision-title')?.textContent === '回滚当前连接', true); click(button('[role="dialog"][aria-labelledby="decision-title"]', '取消')); await tick(); await wait(() => !document.querySelector('#decision-title'), true)
    need(tx().uiActive && tx().uiPendingAffected === 1 && dirty() === 1 && (await snapshot()) === report.proof.faultRowsSha256, 'RECOVERY'); report.checks.rollback_cancel_preserved = true
    click(button('.result-grid .result-actions', '回滚')); await wait(() => document.querySelector('#decision-title')?.textContent === '回滚当前连接', true); click(button('[role="dialog"][aria-labelledby="decision-title"]', '确认')); await tick(); await wait(() => idle() && !document.querySelector('#decision-title') && !tx().uiActive && dirty() === 0 && rows().every((r, i) => r[1] === String(i + 1) && r[2] === '0'), true)
    report.proof.restoredRowsSha256 = await snapshot(); need(tx().uiPendingAffected === 0 && report.proof.restoredRowsSha256 === baseline, 'RECOVERY'); report.checks.normal_rollback = true
    click(queryTab); await tick(); await wait(() => idle() && queryTab.getAttribute('aria-selected') === 'true', true); const restored = witness(); report.proof.markerValueAfterRollback = restored.value; need(restored.id === after.id && restored.value === 0, 'RECOVERY')
    click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true); need((await snapshot()) === baseline && !tx().uiActive && tx().uiPendingAffected === 0 && dirty() === 0, 'RECOVERY')
    stage = 'CHECKPOINT'; await checkpoint('rolled-back', original, after.id, restored.value); report.checks.reloaded_baseline = true
  } catch (error) { report.failureCode = error instanceof Fault ? error.code : stage }
  report.elapsedMs = Math.round(performance.now() - began)
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}

async function runDeadlockDom(c: Context): Promise<void> {
  class Fault extends Error { constructor(readonly code: DeadlockFailureCode) { super(code) } }
  function need(value: unknown, code: DeadlockFailureCode): asserts value { if (!value) throw new Fault(code) }
  const began = performance.now()
  const report: DeadlockReport = { schemaVersion: 1, runId: c.runId, phase: 'grid-deadlock', actionDriver: 'native-dom-synthetic',
    checks: { storage_marker: storagePassed, persisted_connection: false, credential_reconnect: false, fixture_created: false, table_open: false, marker_applied: false, actor_waited: false, local_draft: false, original_1213: false, transaction_state_correct: false, draft_preserved: false, rollback_notice: false, recovery_guard_cancel: false, reloaded_baseline: false },
    proof: null, actions: { click: 0, input: 0, keydown: 0, dblclick: 0 }, elapsedMs: 0, failureCode: 'NONE' }
  let stage: DeadlockFailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const all = <T extends HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector)).filter(visible)
  function one<T extends HTMLElement>(selector: string): T { const a = all<T>(selector); need(a.length === 1, 'DOM_FAILED'); return a[0]! }
  function button(scope: string, text: string, prefix = false): HTMLButtonElement { const a = all<HTMLButtonElement>(`${scope} button`).filter((e) => prefix ? e.textContent?.trim().startsWith(text) : e.textContent?.trim() === text); need(a.length === 1, 'DOM_FAILED'); return a[0]! }
  function click(e: HTMLElement): void { need(visible(e) && !(e instanceof HTMLButtonElement && e.disabled), 'DOM_FAILED'); report.actions.click++; e.click() }
  function doubleClick(e: HTMLElement): void { need(visible(e), 'DOM_FAILED'); report.actions.dblclick++; e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) }
  function fill(e: HTMLTextAreaElement, value: string): void { need(visible(e) && !e.disabled, 'DOM_FAILED'); e.focus(); e.value = value; report.actions.input++; e.dispatchEvent(new Event('input', { bubbles: true })) }
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  async function wait(predicate: () => boolean, allowError = false): Promise<void> {
    const end = performance.now() + 20000
    while (!predicate()) { if (!allowError) need(!document.querySelector('#status-bar.is-error, .result-grid .inline-error, .tree-note.is-error, .command-result.is-error'), stage); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 40)) }
  }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  function tx(): { uiActive: boolean; uiPendingAffected: number } {
    const text = one<HTMLElement>('.result-grid .transaction-state').textContent?.trim()
    if (text === '无活动事务') return { uiActive: false, uiPendingAffected: 0 }
    const match = /^未提交 · (\d+) 行$/.exec(text ?? ''); need(match && Number(match[1]) <= 1000, 'DOM_FAILED'); return { uiActive: true, uiPendingAffected: Number(match[1]) }
  }
  const ids = [1,2,3,4,...Array.from({ length: 128 }, (_, i) => 101 + i)]
  function rows(): string[][] {
    const headers = all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim().replace(/ [↑↓]$/, ''))
    const values = all<HTMLTableRowElement>('.result-grid tbody tr').map((r) => Array.from(r.querySelectorAll('td')).slice(1).map((e) => e.textContent ?? ''))
    need(headers.join(',') === 'id,u,v' && values.length === 132 && values.every((r, i) => r.length === 3 && r[0] === String(ids[i]) && r[1] === String(ids[i]) && /^[0-7]$/.test(r[2]!)), 'DOM_FAILED')
    return values
  }
  function cell(id: number): HTMLTableCellElement { const index = ids.indexOf(id); need(index >= 0, 'DOM_FAILED'); return one<HTMLTableCellElement>(`.result-grid tbody tr:nth-child(${index + 1}) td:nth-child(4)`) }
  function dirty(): number { return all<HTMLTableRowElement>('.result-grid tbody tr').filter((r) => r.querySelector('td.is-dirty')).length }
  async function snapshot(): Promise<string> { const data = JSON.stringify({ columns: ['id','u','v'], rows: rows() }); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))), (b) => b.toString(16).padStart(2, '0')).join('') }
  async function execute(sql: string): Promise<void> {
    const count = all('.result-tabs .result-tab').length; fill(one<HTMLTextAreaElement>('#sql-input'), sql); click(one<HTMLButtonElement>('#btn-run-sql')); await tick(); await wait(() => idle() && all('.result-tabs .result-tab').length === count + 1)
  }
  async function edit(id: number, value: string): Promise<void> {
    doubleClick(cell(id)); await wait(() => !!document.querySelector('[role="dialog"][aria-label="编辑单元格"] textarea'), true)
    fill(one<HTMLTextAreaElement>('[role="dialog"][aria-label="编辑单元格"] textarea'), value); click(button('[role="dialog"][aria-label="编辑单元格"]', '保存到本地修改')); await tick(); await wait(() => !document.querySelector('[role="dialog"][aria-label="编辑单元格"]'), true)
  }
  async function checkpoint(step: 'baseline' | 'marker' | 'observed', original1213 = false, rollbackNotice = false): Promise<void> {
    const payload = { schemaVersion: 1, step, ...tx(), dirtyRows: dirty(), row1Value: Number(cell(1).textContent), row3Value: Number(cell(3).textContent), original1213, rollbackNotice }
    await bridge('mysqlAcceptanceDeadlockCheckpoint', [payload])
    const end = performance.now() + 30000
    for (;;) { const value = await bridge<{ ready: boolean; verified: boolean }>('mysqlAcceptanceDeadlockContinue', [{ schemaVersion: 1, step }]); need(value && Object.keys(value).sort().join(',') === 'ready,verified' && typeof value.ready === 'boolean' && typeof value.verified === 'boolean', 'NATIVE_BRIDGE'); if (value.ready) { need(value.verified, 'CHECKPOINT'); return } need(!value.verified, 'NATIVE_BRIDGE'); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 60)) }
  }
  function treeRows(): HTMLElement[] { return all<HTMLElement>('.metadata-tree .tree-row[data-node-id]') }
  function name(e: HTMLElement): string { return e.querySelector('.row-label')?.textContent?.trim() ?? '' }
  async function expand(e: HTMLElement): Promise<void> { if (e.getAttribute('aria-expanded') === 'false') click(e.querySelector<HTMLButtonElement>('.twisty')!); await wait(() => e.getAttribute('aria-expanded') === 'true' && e.getAttribute('aria-busy') !== 'true') }
  function uniqueTree(label: string): HTMLElement { const a = treeRows().filter((e) => name(e) === label); need(a.length === 1, 'TREE'); return a[0]! }
  try {
    need(storagePassed && c.phase === 'grid-deadlock' && /^[a-zA-Z0-9_]+$/.test(c.database), 'ISOLATION'); stage = 'CONNECTION'
    const connection = `MySQL parity ${c.runId}`
    await wait(() => treeRows().some((e) => name(e) === connection)); const roots = treeRows().filter((e) => e.getAttribute('aria-level') === '1')
    need(roots.length === 1 && name(roots[0]!) === connection && !document.querySelector('.connection-dialog'), 'CONNECTION'); click(roots[0]!)
    await wait(() => !!document.querySelector('.connection-summary')); need(one<HTMLElement>('.connection-summary strong').textContent === connection, 'CONNECTION'); report.checks.persisted_connection = true
    click(button('.connection-summary .connection-actions', '连接')); await wait(() => idle() && all<HTMLButtonElement>('.connection-summary button').some((e) => e.textContent?.trim() === '断开')); report.checks.credential_reconnect = true
    stage = 'SETUP'; const tableName = `gui_dl_${c.runId}`, table = `\`${c.database}\`.\`${tableName}\``
    await execute(`CREATE TABLE ${table} (id INT PRIMARY KEY,u INT NOT NULL UNIQUE,v INT NOT NULL DEFAULT 0) ENGINE=InnoDB`)
    await execute(`INSERT INTO ${table} (id,u,v) VALUES ${ids.map((id) => `(${id},${id},0)`).join(',')}`)
    need(tx().uiActive && tx().uiPendingAffected === 132, 'SETUP'); click(button('.result-grid .result-actions', '提交')); await tick(); await wait(() => idle() && !tx().uiActive && (one<HTMLElement>('#status-bar').textContent ?? '').startsWith('已提交当前连接事务')); report.checks.fixture_created = true
    stage = 'TREE'; await expand(uniqueTree(connection))
    for (let i = 0; i < 4 && !treeRows().some((e) => name(e) === c.database); i++) { const folder = treeRows().find((e) => e.dataset.nodeId?.includes('folder:schemas') && e.getAttribute('aria-expanded') === 'false'); need(folder, 'TREE'); await expand(folder) }
    await wait(() => treeRows().some((e) => name(e) === c.database)); await expand(uniqueTree(c.database))
    const folder = treeRows().find((e) => e.dataset.nodeId?.endsWith('|tables')); need(folder, 'TREE'); await expand(folder)
    await wait(() => treeRows().some((e) => name(e) === tableName)); const tableRow = uniqueTree(tableName); click(tableRow); doubleClick(tableRow)
    await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').some((e) => e.textContent?.trim() === 'v'))
    click(button('.result-grid thead', 'id')); await tick(); await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').some((e) => e.textContent?.trim() === 'id ↑'))
    need(rows().every((r) => r[2] === '0') && !tx().uiActive && dirty() === 0, 'TREE'); report.checks.table_open = true
    const baseline = await snapshot(); stage = 'CHECKPOINT'; await checkpoint('baseline')
    stage = 'EDIT'; await edit(3, '7'); need(dirty() === 1, 'EDIT'); click(button('.result-grid .result-actions', '应用修改', true)); await tick(); await wait(() => idle() && dirty() === 0 && tx().uiActive && tx().uiPendingAffected === 1)
    need(cell(3).textContent === '7' && cell(1).textContent === '0', 'EDIT'); report.checks.marker_applied = true
    report.proof = { rowCount: 132, baselineRowsSha256: baseline, markerRowsSha256: await snapshot(), faultRowsSha256: null, reloadedRowsSha256: null, uiActiveAfterError: null, uiPendingAffectedAfterError: null, dirtyRowsAfterError: null, originalErrorClass: null }
    stage = 'CHECKPOINT'; await checkpoint('marker'); report.checks.actor_waited = true
    stage = 'EDIT'; await edit(1, '1'); need(dirty() === 1 && cell(1).textContent === '1', 'EDIT'); report.checks.local_draft = true
    click(button('.result-grid .result-actions', '应用修改', true)); await tick(); await wait(() => idle() && !!document.querySelector('#status-bar.is-error, .result-grid .inline-error'), true)
    // Capture the actual fault state before any reload, transaction operation or business state read.
    const state = tx(), dirtyCount = dirty(), text = all<HTMLElement>('#status-bar, .result-grid .inline-error').map((e) => e.textContent ?? '').join(' ')
    const errorClass = /\b40001\b/.test(text) && /\b1213\b/.test(text) ? '1213' : /\b1305\b/.test(text) ? '1305' : 'other'
    const notice = /(?:整个|全部|整体)事务.*回滚|事务.*(?:全部|整体).*回滚/.test(text) && /(?:草稿|本地修改).*保留|保留.*(?:草稿|本地修改)/.test(text)
    report.proof.uiActiveAfterError = state.uiActive; report.proof.uiPendingAffectedAfterError = state.uiPendingAffected; report.proof.dirtyRowsAfterError = dirtyCount; report.proof.originalErrorClass = errorClass; report.proof.faultRowsSha256 = await snapshot()
    report.checks.original_1213 = errorClass === '1213'; report.checks.transaction_state_correct = !state.uiActive && state.uiPendingAffected === 0; report.checks.draft_preserved = dirtyCount === 1 && cell(1).textContent === '1'; report.checks.rollback_notice = notice
    stage = 'CHECKPOINT'; await checkpoint('observed', errorClass === '1213', notice)
    need(errorClass !== 'other', 'MYSQL_ERROR_DETAILS_LOST')
    need(errorClass === '1213', 'DEADLOCK_NOT_OBSERVED')
    need(!state.uiActive && state.uiPendingAffected === 0, 'DEADLOCK_TX_STATE_STALE')
    need(report.checks.draft_preserved, 'RECOVERY'); need(notice, 'ROLLBACK_NOTICE_MISSING')
    stage = 'RECOVERY'; click(button('.result-grid .result-actions', '刷新')); await wait(() => document.querySelector('#decision-title')?.textContent === '刷新结果', true)
    click(button('[role="dialog"][aria-labelledby="decision-title"]', '取消')); await tick(); await wait(() => !document.querySelector('#decision-title'), true)
    need(dirty() === 1 && cell(1).textContent === '1' && (await snapshot()) === report.proof.faultRowsSha256, 'RECOVERY'); report.checks.recovery_guard_cancel = true
    click(button('.result-grid .result-actions', '刷新')); await wait(() => document.querySelector('#decision-title')?.textContent === '刷新结果', true); click(button('[role="dialog"][aria-labelledby="decision-title"]', '放弃本地修改'))
    await tick(); await wait(() => idle() && !document.querySelector('#decision-title') && dirty() === 0 && rows().every((r) => r[2] === '0'), true)
    need(!tx().uiActive && tx().uiPendingAffected === 0, 'RECOVERY'); report.proof.reloadedRowsSha256 = await snapshot(); need(report.proof.reloadedRowsSha256 === baseline, 'RECOVERY'); report.checks.reloaded_baseline = true
  } catch (error) { report.failureCode = error instanceof Fault ? error.code : stage }
  report.elapsedMs = Math.round(performance.now() - began)
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}

async function runCommitDom(c: Context): Promise<void> {
  class CommitFailure extends Error { constructor(readonly code: CommitFailureCode) { super(code) } }
  function need(value: unknown, code: CommitFailureCode): asserts value { if (!value) throw new CommitFailure(code) }
  const began = performance.now()
  const report: CommitReport = { schemaVersion: 1, runId: c.runId, phase: 'commit', actionDriver: 'native-dom-synthetic',
    checks: { storage_marker: storagePassed, persisted_connection: false, credential_reconnect: false, table_created: false, baseline_committed: false, baseline_observed: false, pending_visible: false, pending_isolated: false, commit_clicked: false, result_refreshed: false, committed_observed: false, nontransactional: false },
    row: null, actions: { click: 0, input: 0, keydown: 0 }, elapsedMs: 0, failureCode: 'NONE' }
  let stage: CommitFailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const all = <T extends HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector)).filter(visible)
  function one<T extends HTMLElement>(selector: string): T { const a = all<T>(selector); need(a.length === 1, 'DOM_FAILED'); return a[0]! }
  function button(scope: string, text: string): HTMLButtonElement { const a = all<HTMLButtonElement>(`${scope} button`).filter((e) => e.textContent?.trim() === text); need(a.length === 1, 'DOM_FAILED'); return a[0]! }
  function click(e: HTMLElement): void { need(visible(e) && !(e instanceof HTMLButtonElement && e.disabled), 'DOM_FAILED'); report.actions.click++; e.click() }
  async function wait(predicate: () => boolean): Promise<void> {
    const end = performance.now() + 20000
    while (!predicate()) { need(!document.querySelector('#status-bar.is-error, .result-grid .inline-error, .command-result.is-error'), stage); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 40)) }
  }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  function state(): { active: boolean; pendingAffected: number } {
    const text = one<HTMLElement>('.result-grid .transaction-state').textContent?.trim()
    if (text === '无活动事务') return { active: false, pendingAffected: 0 }
    need(text === '未提交 · 1 行', stage); return { active: true, pendingAffected: 1 }
  }
  async function execute(sql: string): Promise<void> {
    const before = all('.result-tabs .result-tab').length, e = one<HTMLTextAreaElement>('#sql-input')
    need(!e.disabled, 'DOM_FAILED'); e.focus(); e.value = sql; report.actions.input++; e.dispatchEvent(new Event('input', { bubbles: true }))
    click(one<HTMLButtonElement>('#btn-run-sql'))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await wait(() => all('.result-tabs .result-tab').length === before + 1 && idle())
    need(!document.querySelector('#status-bar.is-error, .command-result.is-error'), stage)
  }
  function body(): string {
    need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim()).join(',') === 'id,body'
      && all('.result-grid tbody tr').length === 1 && document.querySelector('.result-grid tbody td:nth-child(2)')?.textContent?.trim() === '1', stage)
    return one<HTMLElement>('.result-grid tbody td:nth-child(3)').textContent ?? ''
  }
  async function digest(text: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('') }
  async function submitCommit(): Promise<void> {
    click(button('.result-grid .result-actions', '提交'))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await wait(() => idle() && one<HTMLElement>('.result-grid .transaction-state').textContent?.trim() === '无活动事务'
      && (one<HTMLElement>('#status-bar').textContent ?? '').startsWith('已提交当前连接事务'))
  }
  async function checkpoint(step: 'baseline' | 'pending' | 'committed', bodySha256: string): Promise<void> {
    stage = 'CHECKPOINT'
    const current = state()
    need(current.active === (step === 'pending') && current.pendingAffected === (step === 'pending' ? 1 : 0), 'CHECKPOINT')
    await bridge('mysqlAcceptanceCommitCheckpoint', [{ schemaVersion: 1, step, bodySha256, active: current.active, pendingAffected: current.pendingAffected }])
    const end = performance.now() + 30000
    for (;;) {
      const value = await bridge<{ ready: boolean; verified: boolean }>('mysqlAcceptanceCommitContinue', [{ schemaVersion: 1, step }])
      need(value && Object.keys(value).sort().join(',') === 'ready,verified' && typeof value.ready === 'boolean' && typeof value.verified === 'boolean', 'NATIVE_BRIDGE')
      if (value.ready) { need(value.verified, 'CHECKPOINT'); return }
      need(!value.verified, 'NATIVE_BRIDGE'); need(performance.now() < end, 'TIMEOUT')
      await new Promise<void>((resolve) => setTimeout(resolve, 60))
    }
  }
  try {
    need(storagePassed && c.phase === 'commit' && /^[a-zA-Z0-9_]+$/.test(c.database), 'ISOLATION')
    stage = 'CONNECTION'
    const name = `MySQL parity ${c.runId}`
    await wait(() => all<HTMLElement>('.metadata-tree .tree-row[data-node-id]').some((e) => e.querySelector('.row-label')?.textContent === name))
    const roots = all<HTMLElement>('.metadata-tree .tree-row[data-node-id]').filter((e) => e.getAttribute('aria-level') === '1')
    need(roots.length === 1 && roots[0]!.querySelector('.row-label')?.textContent === name && !document.querySelector('.connection-dialog'), 'CONNECTION')
    click(roots[0]!)
    await wait(() => !!document.querySelector('.connection-summary'))
    need(one<HTMLElement>('.connection-summary strong').textContent === name && one<HTMLElement>('.connection-summary .muted').textContent?.includes('mysql'), 'CONNECTION')
    report.checks.persisted_connection = true
    click(button('.connection-summary .connection-actions', '连接'))
    await wait(() => idle() && all<HTMLButtonElement>('.connection-summary .connection-actions button').some((e) => e.textContent?.trim() === '断开'))
    need(one<HTMLSelectElement>('#current-connection').selectedOptions[0]?.textContent === name, 'CONNECTION'); report.checks.credential_reconnect = true
    stage = 'QUERY'
    const table = `\`${c.database}\`.\`ui_tx_${c.runId}\``, baseline = `baseline-${c.runId}`, committed = `committed-${c.runId}`
    await execute(`CREATE TABLE ${table} (id INT PRIMARY KEY,body VARCHAR(128) NOT NULL) ENGINE=InnoDB`)
    need(!state().active && state().pendingAffected === 0, 'QUERY'); report.checks.table_created = true
    await execute(`INSERT INTO ${table} (id,body) VALUES (1,'${baseline}')`)
    need(state().active && state().pendingAffected === 1, 'QUERY')
    stage = 'COMMIT'; await submitCommit(); report.checks.baseline_committed = true
    stage = 'QUERY'; await execute(`SELECT id,body FROM ${table} ORDER BY id`)
    need(body() === baseline && !state().active, 'QUERY')
    report.row = { id: 1, baselineSha256: await digest(body()), pendingSha256: null, committedSha256: null }
    await checkpoint('baseline', report.row.baselineSha256); report.checks.baseline_observed = true
    stage = 'QUERY'; await execute(`UPDATE ${table} SET body='${committed}' WHERE id=1`)
    need(state().active && state().pendingAffected === 1, 'QUERY')
    await execute(`SELECT id,body FROM ${table} ORDER BY id`)
    need(body() === committed && state().active && state().pendingAffected === 1, 'QUERY')
    report.row.pendingSha256 = await digest(body()); report.checks.pending_visible = true
    await checkpoint('pending', report.row.pendingSha256); report.checks.pending_isolated = true
    stage = 'COMMIT'; await submitCommit(); report.checks.commit_clicked = true
    need(body() === committed && !state().active && state().pendingAffected === 0, 'COMMIT')
    report.row.committedSha256 = await digest(body()); report.checks.result_refreshed = true
    await checkpoint('committed', report.row.committedSha256); report.checks.committed_observed = true
    need(!state().active && state().pendingAffected === 0, 'COMMIT'); report.checks.nontransactional = true
  } catch (error) { report.failureCode = error instanceof CommitFailure ? error.code : stage }
  report.elapsedMs = Math.round(performance.now() - began)
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}

async function runExplainDom(c: Context): Promise<void> {
  const began = performance.now()
  const report: ExplainReport = { schemaVersion: 1, runId: c.runId, phase: 'explain', actionDriver: 'native-dom-synthetic',
    checks: { storage_marker: storagePassed, persisted_connection: false, credential_reconnect: false, query_result: false, explain_open: false, plan_content: false, plan_refresh: false, return_results: false, nontransactional: false },
    plan: null, actions: { click: 0, input: 0, keydown: 0 }, elapsedMs: 0, failureCode: 'NONE' }
  let stage: ExplainFailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const all = <T extends HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector)).filter(visible)
  function one<T extends HTMLElement>(selector: string): T { const a = all<T>(selector); need(a.length === 1, 'DOM_FAILED'); return a[0]! }
  function button(scope: string, text: string): HTMLButtonElement {
    const a = all<HTMLButtonElement>(`${scope} button`).filter((e) => e.textContent?.trim() === text); need(a.length === 1, 'DOM_FAILED'); return a[0]!
  }
  function click(e: HTMLElement): void { need(visible(e) && !(e instanceof HTMLButtonElement && e.disabled), 'DOM_FAILED'); report.actions.click++; e.click() }
  function fill(sql: string): void { const e = one<HTMLTextAreaElement>('#sql-input'); need(!e.disabled, 'DOM_FAILED'); e.focus(); e.value = sql; report.actions.input++; e.dispatchEvent(new Event('input', { bubbles: true })) }
  async function wait(predicate: () => boolean): Promise<void> {
    const end = performance.now() + 20000
    while (!predicate()) { need(!document.querySelector('#status-bar.is-error, .explain-panel .inline-error, .result-grid .inline-error, .tree-note.is-error'), stage); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 40)) }
  }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  function resultValid(): boolean {
    const headers = all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim())
    return headers.join(',') === 'id,body' && all('.result-grid tbody tr').length === 1
      && document.querySelector('.result-grid tbody td:nth-child(2)')?.textContent?.trim() === '1'
      && document.querySelector('.result-grid tbody td:nth-child(3)')?.textContent === '样本-0000001'
  }
  async function digest(text: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('') }
  const expectedColumns = ['id','select_type','table','partitions','type','possible_keys','key','key_len','ref','rows','filtered','Extra']
  async function planProof(sql: string): Promise<{ planSha: string; sqlSha: string }> {
    const columns = all<HTMLElement>('.explain-panel thead th').map((e) => e.textContent ?? '')
    const rows = all<HTMLTableRowElement>('.explain-panel tbody tr').map((row) => Array.from(row.querySelectorAll('td'), (e) => e.textContent ?? ''))
    need(columns.length === 12 && columns.every((name, i) => name === expectedColumns[i]) && rows.length === 1 && rows[0]!.length === 12, 'QUERY')
    const executed = one<HTMLElement>('.explain-panel pre').textContent ?? ''
    need(executed === `EXPLAIN ${sql}`, 'QUERY')
    return { planSha: await digest(JSON.stringify({ columns, rows })), sqlSha: await digest(executed) }
  }
  try {
    need(storagePassed && c.phase === 'explain', 'ISOLATION')
    stage = 'CONNECTION'
    const name = `MySQL parity ${c.runId}`
    await wait(() => all<HTMLElement>('.metadata-tree .tree-row[data-node-id]').some((e) => e.querySelector('.row-label')?.textContent === name))
    const roots = all<HTMLElement>('.metadata-tree .tree-row[data-node-id]').filter((e) => e.getAttribute('aria-level') === '1')
    need(roots.length === 1 && roots[0]!.querySelector('.row-label')?.textContent === name && !document.querySelector('.connection-dialog'), 'CONNECTION')
    click(roots[0]!)
    await wait(() => !!document.querySelector('.connection-summary'))
    need(one<HTMLElement>('.connection-summary strong').textContent === name && one<HTMLElement>('.connection-summary .muted').textContent?.includes('mysql'), 'CONNECTION')
    report.checks.persisted_connection = true
    click(button('.connection-summary .connection-actions', '连接'))
    await wait(() => idle() && all<HTMLButtonElement>('.connection-summary .connection-actions button').some((e) => e.textContent?.trim() === '断开'))
    need(one<HTMLSelectElement>('#current-connection').selectedOptions[0]?.textContent === name, 'CONNECTION')
    report.checks.credential_reconnect = true
    stage = 'QUERY'
    need(/^[a-zA-Z0-9_]+$/.test(c.database), 'ISOLATION')
    const sql = `SELECT id,body FROM \`${c.database}\`.\`items_805\` WHERE id=1`
    fill(sql); click(one<HTMLButtonElement>('#btn-run-sql'))
    await wait(() => idle() && resultValid()); report.checks.query_result = true
    click(button('.editor-pane > .pane-toolbar', 'EXPLAIN'))
    await wait(() => !!document.querySelector('.explain-panel') && !button('.explain-panel', '刷新计划').disabled && !!document.querySelector('.explain-panel tbody tr'))
    report.checks.explain_open = true
    const first = await planProof(sql)
    report.plan = { rowCount: 1, columnCount: 12, firstPlanSha256: first.planSha, refreshedPlanSha256: null, executedSqlSha256: first.sqlSha }; report.checks.plan_content = true
    click(button('.explain-panel', '刷新计划'))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await wait(() => !button('.explain-panel', '刷新计划').disabled && !document.querySelector('.explain-panel .tool-body > p'))
    const refreshed = await planProof(sql)
    need(refreshed.planSha === first.planSha && refreshed.sqlSha === first.sqlSha, 'QUERY')
    report.plan.refreshedPlanSha256 = refreshed.planSha; report.checks.plan_refresh = true
    click(button('.explain-panel', '返回结果'))
    await wait(() => !document.querySelector('.explain-panel') && idle() && resultValid()); report.checks.return_results = true
    need(one<HTMLElement>('.result-grid .transaction-state').textContent?.trim() === '无活动事务', 'QUERY')
    report.checks.nontransactional = true
  } catch (error) { report.failureCode = error instanceof DomFailure && ['NONE','ISOLATION','CONNECTION','QUERY','TIMEOUT','DOM_FAILED','NATIVE_BRIDGE'].includes(error.code) ? error.code as ExplainFailureCode : stage }
  report.elapsedMs = Math.round(performance.now() - began)
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}

async function runRestartDom(c: Context): Promise<void> {
  const began = performance.now()
  const report: RestartReport = { schemaVersion: 1, runId: c.runId, phase: 'restart', actionDriver: 'native-dom-synthetic',
    checks: { storage_marker: storagePassed, persisted_connection: false, credential_reconnect: false, sql_select41: false, table_open: false, local_edit: false, dirty_guard_cancel: false, applied_pending: false, rollback_restored: false },
    row: null, actions: { click: 0, input: 0, keydown: 0, dblclick: 0 }, elapsedMs: 0, failureCode: 'NONE' }
  let stage: RestartFailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const all = <T extends HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector)).filter(visible)
  function one<T extends HTMLElement>(selector: string): T { const a = all<T>(selector); need(a.length === 1, 'DOM_FAILED'); return a[0]! }
  async function wait(predicate: () => boolean): Promise<void> {
    const end = performance.now() + 30000
    while (!predicate()) {
      need(!document.querySelector('#status-bar.is-error, .result-grid .inline-error, .tree-note.is-error'), stage)
      need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 40))
    }
  }
  function click(e: HTMLElement): void {
    need(visible(e) && !(e instanceof HTMLButtonElement && e.disabled), 'DOM_FAILED'); report.actions.click++; e.click()
  }
  function doubleClick(e: HTMLElement): void {
    need(visible(e), 'DOM_FAILED'); report.actions.dblclick++; e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  }
  function fill(e: HTMLTextAreaElement, value: string): void { need(!e.disabled && visible(e), 'DOM_FAILED'); e.focus(); e.value = value; report.actions.input++; e.dispatchEvent(new Event('input', { bubbles: true })) }
  function button(scope: string, label: string, prefix = false): HTMLButtonElement {
    const matches = all<HTMLButtonElement>(`${scope} button`).filter((e) => prefix ? e.textContent?.trim().startsWith(label) : e.textContent?.trim() === label)
    need(matches.length === 1, 'DOM_FAILED'); return matches[0]!
  }
  function treeRows(): HTMLElement[] { return all<HTMLElement>('.metadata-tree .tree-row[data-node-id]') }
  function label(e: HTMLElement): string { return e.querySelector('.row-label')?.textContent?.trim() ?? '' }
  function rowByName(name: string): HTMLElement { const a = treeRows().filter((e) => label(e) === name); need(a.length === 1, 'TREE'); return a[0]! }
  async function expand(e: HTMLElement): Promise<void> {
    if (e.getAttribute('aria-expanded') === 'false') click(e.querySelector<HTMLButtonElement>('.twisty')!)
    await wait(() => e.getAttribute('aria-expanded') === 'true' && e.getAttribute('aria-busy') !== 'true')
  }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  function column(name: string): number {
    const headings = all<HTMLElement>('.result-grid thead .column-sort');const index = headings.findIndex((e) => e.textContent?.trim().replace(/ [↑↓]$/, '') === name)
    need(index >= 0, stage); return index + 2
  }
  function firstCell(name: string): HTMLTableCellElement { return one<HTMLTableCellElement>(`.result-grid tbody tr:first-child td:nth-child(${column(name)})`) }
  function body(): string { return firstCell('body').textContent ?? '' }
  function firstPage(): boolean {
    const index = column('id'); const rows = all<HTMLTableRowElement>('.result-grid tbody tr')
    return rows.length === 200 && rows.every((r, i) => r.querySelector(`td:nth-child(${index})`)?.textContent?.trim() === String(i + 1))
      && (one<HTMLElement>('.result-grid .page-bar > span:first-child').textContent ?? '').startsWith('1–200 行')
  }
  async function digest(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, '0')).join('') }
  function clean(): boolean { return !document.querySelector('.result-grid td.is-dirty') }
  try {
    need(storagePassed && c.phase === 'restart', 'ISOLATION')
    stage = 'CONNECTION'
    const connectionName = `MySQL parity ${c.runId}`
    await wait(() => treeRows().some((e) => label(e) === connectionName))
    const rootRows = treeRows().filter((e) => e.getAttribute('aria-level') === '1')
    need(rootRows.length === 1 && label(rootRows[0]!) === connectionName && !document.querySelector('.connection-dialog'), 'CONNECTION')
    click(rootRows[0]!)
    await wait(() => !!document.querySelector('.connection-summary'))
    need(one<HTMLElement>('.connection-summary strong').textContent === connectionName && one<HTMLElement>('.connection-summary .muted').textContent?.includes('mysql'), 'CONNECTION')
    report.checks.persisted_connection = true
    click(button('.connection-summary .connection-actions', '连接'))
    await wait(() => idle() && !!all<HTMLButtonElement>('.connection-summary .connection-actions button').find((b) => b.textContent?.trim() === '断开'))
    need(one<HTMLSelectElement>('#current-connection').selectedOptions[0]?.textContent === connectionName, 'CONNECTION')
    report.checks.credential_reconnect = true
    stage = 'QUERY'
    fill(one<HTMLTextAreaElement>('#sql-input'), 'SELECT 41 AS from_keyboard;'); click(one<HTMLButtonElement>('#btn-run-sql'))
    await wait(() => idle() && document.querySelector('.result-grid thead .column-sort')?.textContent?.trim() === 'from_keyboard')
    need(all('.result-grid tbody tr').length === 1 && document.querySelector('.result-grid tbody td:nth-child(2)')?.textContent?.trim() === '41', 'QUERY')
    report.checks.sql_select41 = true
    stage = 'TREE'
    await expand(rowByName(connectionName))
    // Each step follows only the selected run's visible tree branch.
    for (let depth = 0; depth < 5 && !treeRows().some((e) => label(e) === c.database); depth++) {
      const parent = treeRows().find((e) => e.getAttribute('aria-expanded') === 'false' && e.dataset.nodeId?.includes('folder:schemas'))
      need(parent, 'TREE'); await expand(parent)
    }
    await wait(() => treeRows().some((e) => label(e) === c.database)); await expand(rowByName(c.database))
    const tablesFolder = treeRows().find((e) => e.dataset.nodeId?.endsWith('|tables') && e.getAttribute('aria-expanded') !== null)
    need(tablesFolder, 'TREE'); await expand(tablesFolder)
    await wait(() => treeRows().some((e) => label(e) === 'items_805'))
    const tableRow = rowByName('items_805'); click(tableRow); doubleClick(tableRow)
    await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').some((e) => e.textContent?.trim() === 'body'))
    const idHeader = all<HTMLButtonElement>('.result-grid thead .column-sort').find((e) => e.textContent?.trim() === 'id')
    need(idHeader, 'TREE'); click(idHeader)
    await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').some((e) => e.textContent?.trim() === 'id ↑') && firstPage())
    need(firstPage() && firstCell('id').textContent?.trim() === '1' && body() === '样本-0000001'
      && one<HTMLElement>('.result-grid .page-bar > span:first-child').textContent?.includes('双击单元格编辑'), 'TREE')
    report.checks.table_open = true
    stage = 'EDIT'
    const before = await digest(body());const changed = `界面回滚验收-${c.runId}`
    doubleClick(firstCell('body'))
    await wait(() => !!document.querySelector('[role="dialog"][aria-label="编辑单元格"] textarea'))
    fill(one<HTMLTextAreaElement>('[role="dialog"][aria-label="编辑单元格"] textarea'), changed)
    click(button('[role="dialog"][aria-label="编辑单元格"]', '保存到本地修改'))
    await wait(() => !document.querySelector('[role="dialog"][aria-label="编辑单元格"]'))
    need(body() === changed && firstCell('body').classList.contains('is-dirty') && button('.result-grid .result-actions', '应用修改', true).textContent?.includes('(1)') && firstPage(), 'EDIT')
    report.row = { id: 1, beforeSha256: before, localSha256: await digest(body()), appliedSha256: null, rolledBackSha256: null }; report.checks.local_edit = true
    click(button('.result-grid .page-bar', '下一页'))
    await wait(() => document.querySelector('#decision-title')?.textContent === '翻页')
    click(button('[role="dialog"][aria-labelledby="decision-title"]', '取消'))
    await wait(() => !document.querySelector('#decision-title'))
    need(firstPage() && body() === changed && firstCell('body').classList.contains('is-dirty') && button('.result-grid .result-actions', '应用修改', true).textContent?.includes('(1)'), 'EDIT')
    report.checks.dirty_guard_cancel = true
    click(button('.result-grid .result-actions', '应用修改', true))
    await wait(() => idle() && clean() && one<HTMLElement>('.result-grid .transaction-state').textContent?.trim() === '未提交 · 1 行')
    need(firstPage() && body() === changed, 'EDIT'); report.row.appliedSha256 = await digest(body()); report.checks.applied_pending = true
    stage = 'ROLLBACK'
    click(button('.result-grid .result-actions', '回滚'))
    await wait(() => document.querySelector('#decision-title')?.textContent === '回滚当前连接')
    click(button('[role="dialog"][aria-labelledby="decision-title"]', '确认'))
    await wait(() => idle() && !document.querySelector('#decision-title') && one<HTMLElement>('.result-grid .transaction-state').textContent?.trim() === '无活动事务')
    need(firstPage() && clean() && body() === '样本-0000001' && button('.result-grid .result-actions', '应用修改', true).disabled, 'ROLLBACK')
    report.row.rolledBackSha256 = await digest(body()); report.checks.rollback_restored = true
  } catch (error) { report.failureCode = error instanceof DomFailure && error.code !== 'PAGING' ? error.code : stage }
  report.elapsedMs = Math.round(performance.now() - began)
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}

/**
 * grid-bit-blob: MySQL BIT(1)/BIT(64)/nullable BLOB read-only parity slice.
 * The DOM only reads rendered cells, the read-only CellViewer and its own normal SQL.
 * No SQL text, path, expected value or correction is sent to the host; the host only
 * receives the bounded request shape of the contract and the actual observations.
 */
async function runBinaryDom(c: Context): Promise<void> {
  class Fault extends Error { constructor(readonly code: BinaryFailureCode) { super(code) } }
  function need(value: unknown, code: BinaryFailureCode): asserts value { if (!value) throw new Fault(code) }
  const columns = ['id','b1','b64','bin']
  const categories = ['integer','real','text','blob','null','boolean','date','unknown']
  const projectionColumns = ['b1_hex','b1_dec','b64_hex','b64_dec','bin_hex','bin_len','bin_null']
  const targetHex = '00FFE4B8AD', editedHex = '00FF004142'
  const began = performance.now()
  const report: BinaryReport = {
    schemaVersion: 1, runId: c.runId, phase: 'grid-bit-blob', actionDriver: 'native-dom-synthetic',
    checks: { storage_marker: storagePassed, persisted_connection: false, credential_reconnect: false, fixture_created: false, table_open: false, column_categories_read: false, baseline_rows_read: false, bit_readonly_observed: false, blob_editable_entry: false, local_edits: false, apply_succeeded: false, committed_reload_verified: false },
    proof: null, actions: { click: 0, input: 0, keydown: 0, dblclick: 0 }, elapsedMs: 0, failureCode: 'NONE'
  }
  const proof: NonNullable<BinaryReport['proof']> = {
    rowCount: 4, columnCount: 3, rows: [], rowsSha256: '', columnCategories: [], readonlyGap: null, editorOriginal: null,
    stages: { baseline: null, draft: null, applied: null, committed: null }
  }
  let stage: BinaryFailureCode = 'ISOLATION'
  const visible = (e: Element) => e instanceof HTMLElement && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const all = <T extends HTMLElement>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector)).filter(visible)
  function one<T extends HTMLElement>(selector: string): T { const a = all<T>(selector); need(a.length === 1, stage); return a[0]! }
  function button(scope: string, text: string, prefix = false): HTMLButtonElement { const a = all<HTMLButtonElement>(`${scope} button`).filter((e) => prefix ? e.textContent?.trim().startsWith(text) : e.textContent?.trim() === text); need(a.length === 1, stage); return a[0]! }
  function click(e: HTMLElement): void { need(visible(e) && !(e instanceof HTMLButtonElement && e.disabled), stage); report.actions.click++; e.click() }
  function dblclick(e: HTMLElement): void { need(visible(e), stage); report.actions.dblclick++; e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) }
  function fill(e: HTMLTextAreaElement, text: string): void { need(visible(e) && !e.disabled, stage); e.focus(); e.value = text; report.actions.input++; e.dispatchEvent(new Event('input', { bubbles: true })) }
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  async function wait(predicate: () => boolean, allowError = false): Promise<void> { const end = performance.now() + 20000; while (!predicate()) { if (!allowError) need(!hasError(), stage); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 40)) } }
  const idle = () => !one<HTMLButtonElement>('#btn-run-sql').disabled && !document.querySelector('.result-grid[aria-busy="true"]')
  const hasError = () => !!document.querySelector('#status-bar.is-error, .result-grid .inline-error, .command-result.is-error, .tree-note.is-error')
  const sqlError = () => !!document.querySelector('#status-bar.is-error, .command-result.is-error')
  function tx(): { uiActive: boolean; uiPendingAffected: number } { const text = one<HTMLElement>('.result-grid .transaction-state').textContent?.trim(); if (text === '无活动事务') return { uiActive: false, uiPendingAffected: 0 }; const m = /^未提交 · (\d+) 行$/.exec(text ?? ''); need(m && Number(m[1]) <= 1000, stage); return { uiActive: true, uiPendingAffected: Number(m[1]) } }
  const dirty = () => all<HTMLTableRowElement>('.result-grid tbody tr').filter((r) => r.querySelector('td.is-dirty')).length
  const safe = (value: string) => value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)
  async function sha(value: unknown): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (b) => b.toString(16).padStart(2, '0')).join('') }
  const treeRows = () => all<HTMLElement>('.metadata-tree .tree-row[data-node-id]'), label = (e: HTMLElement) => e.querySelector('.row-label')?.textContent?.trim() ?? ''
  function tree(name: string): HTMLElement { const a = treeRows().filter((e) => label(e) === name); need(a.length === 1, 'TABLE_OPEN'); return a[0]! }
  async function expand(e: HTMLElement): Promise<void> { if (e.getAttribute('aria-expanded') === 'false') click(e.querySelector<HTMLButtonElement>('.twisty')!); await wait(() => e.getAttribute('aria-expanded') === 'true' && e.getAttribute('aria-busy') !== 'true') }
  async function execute(sql: string): Promise<void> {
    const n = all('.result-tabs .result-tab').length
    fill(one<HTMLTextAreaElement>('#sql-input'), sql); click(one<HTMLButtonElement>('#btn-run-sql')); await tick()
    await wait(() => idle() && (all('.result-tabs .result-tab').length === n + 1 || sqlError()), true)
    need(!sqlError(), stage)
  }
  function cell(row: number, column: number): HTMLTableCellElement { return one<HTMLTableCellElement>(`.result-grid tbody tr:nth-child(${row}) td:nth-child(${column + 2})`) }
  const decimalOf = (hex: string) => (hex === '' ? 0n : BigInt(`0x${hex}`)).toString()
  /** Reads one binary cell through the rendered read-only viewer; a NULL cell stays JSON null. */
  async function readBinary(row: number, column: number): Promise<{ hex: string | null; length: number | null; isNull: boolean }> {
    const target = cell(row, column)
    if (target.classList.contains('is-null')) return { hex: null, length: null, isNull: true }
    dblclick(target)
    await wait(() => !!document.querySelector('.cell-viewer textarea[aria-label="完整单元格值"]') || !!document.querySelector('[aria-label="编辑单元格"] textarea') || hasError(), true)
    const viewerCell = document.querySelector('.cell-viewer textarea[aria-label="完整单元格值"]')
    const editorCell = document.querySelector('[aria-label="编辑单元格"] textarea')
    need(!!viewerCell || !!editorCell, 'BINARY_READ_FAILED')
    let hex: string
    if (viewerCell) {
      const raw = one<HTMLTextAreaElement>('.cell-viewer textarea[aria-label="完整单元格值"]').value
      const text = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw
      need(/^[0-9A-Fa-f]*$/.test(text) && text.length % 2 === 0, 'BINARY_READ_FAILED')
      hex = text.toUpperCase()
      click(button('.cell-viewer', '关闭')); await tick(); await wait(() => !document.querySelector('.cell-viewer'), true)
    } else {
      const raw = one<HTMLTextAreaElement>('[aria-label="编辑单元格"] textarea').value
      need(/^[0-9A-Fa-f]*$/.test(raw) && raw.length % 2 === 0 && raw.length <= 512, 'BINARY_READ_FAILED')
      hex = raw.toUpperCase()
      click(button('[aria-label="编辑单元格"]', '取消')); await tick(); await wait(() => !document.querySelector('[aria-label="编辑单元格"]'), true)
    }
    return { hex, length: hex.length / 2, isNull: false }
  }
  async function readRows(): Promise<BinaryRow[]> {
    const rows: BinaryRow[] = []
    for (let index = 1; index <= 4; index++) {
      const idText = cell(index, 0).textContent?.trim() ?? ''
      need(/^[1-9][0-9]*$/.test(idText) && Number(idText) === index, 'BINARY_READ_FAILED')
      const b1 = await readBinary(index, 1), b64 = await readBinary(index, 2), bin = await readBinary(index, 3)
      rows.push({ id: index, b1Hex: b1.hex, b1Decimal: b1.hex === null ? null : decimalOf(b1.hex), b64Hex: b64.hex, b64Decimal: b64.hex === null ? null : decimalOf(b64.hex), binHex: bin.hex, binByteLength: bin.length, binIsNull: bin.isNull })
    }
    return rows
  }
  /** Same-connection witness: one connection id plus seven string projections with fixed aliases. */
  function witness(): { id: number; rows: string[][] } {
    need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim().replace(/ [↑↓]$/, '')).join(',') === ['connection_id', ...projectionColumns].join(','), 'BINARY_READ_FAILED')
    const trs = all<HTMLTableRowElement>('.result-grid tbody tr'); need(trs.length === 4, 'BINARY_READ_FAILED')
    const ids: number[] = [], rows: string[][] = []
    for (const tr of trs) {
      const cells = Array.from(tr.querySelectorAll('td')).slice(1); need(cells.length === 8, 'BINARY_READ_FAILED')
      const cid = cells[0]!.textContent?.trim() ?? ''; need(/^[1-9][0-9]*$/.test(cid) && Number.isSafeInteger(Number(cid)), 'BINARY_READ_FAILED')
      ids.push(Number(cid))
      const projection = cells.slice(1).map((e) => { need(!e.classList.contains('is-null'), 'BINARY_READ_FAILED'); return (e.textContent ?? '').trim() })
      need(projection.length === 7 && projection.every((v) => safe(v)), 'BINARY_READ_FAILED'); rows.push(projection)
    }
    need(ids.every((v) => v === ids[0]), 'BINARY_READ_FAILED')
    return { id: ids[0]!, rows }
  }
  /** The witness string literal "NULL" is normalized only through the explicit bin_null flag. */
  function witnessBlob(projection: string[]): { hex: string | null; length: number | null; isNull: boolean } {
    const hex = projection[4]!, len = projection[5]!, flag = projection[6]!
    if (flag === '1') { need(hex === 'NULL' && len === 'NULL', 'BINARY_READ_FAILED'); return { hex: null, length: null, isNull: true } }
    need(flag === '0' && /^[0-9A-F]*$/.test(hex) && hex.length % 2 === 0 && /^[0-9]+$/.test(len), 'BINARY_READ_FAILED')
    return { hex, length: Number(len), isNull: false }
  }
  function bitMismatch(rows: BinaryRow[], witnessRows: string[][]): boolean { return rows.some((r, i) => r.b1Decimal !== witnessRows[i]![1] || r.b64Decimal !== witnessRows[i]![3]) }
  function blobMismatch(rows: BinaryRow[], witnessRows: string[][]): boolean {
    return rows.some((r, i) => { const b = witnessBlob(witnessRows[i]!); return r.binHex !== b.hex || r.binByteLength !== b.length || r.binIsNull !== b.isNull })
  }
  async function buildStage(rows: BinaryRow[], columnCategories: string[], editable: boolean, wit: { id: number }, witnessSha: string): Promise<BinaryStage> {
    const state = tx()
    return { rows, rowsSha256: await sha({ rows }), targetRowId: 1, targetBinHex: rows[0]!.binHex, targetBinIsNull: rows[0]!.binIsNull, columnCategories, blobEditableEntry: editable, uiActive: state.uiActive, uiPendingAffected: state.uiPendingAffected, dirtyRows: dirty(), witnessConnectionId: wit.id, witnessProjectionSha256: witnessSha }
  }
  async function checkpoint(step: 'baseline' | 'draft' | 'applied' | 'committed', value: BinaryStage): Promise<void> {
    await bridge('mysqlAcceptanceBinaryCheckpoint', [{ schemaVersion: 1, step, uiActive: value.uiActive, uiPendingAffected: value.uiPendingAffected, dirtyRows: value.dirtyRows, rowsSha256: value.rowsSha256, witnessConnectionId: value.witnessConnectionId, witnessProjectionSha256: value.witnessProjectionSha256, columnCategories: value.columnCategories, blobEditableEntry: value.blobEditableEntry }])
    const end = performance.now() + 30000
    for (;;) { const r = await bridge<{ ready: boolean; verified: boolean }>('mysqlAcceptanceBinaryContinue', [{ schemaVersion: 1, step }]); need(r && Object.keys(r).sort().join(',') === 'ready,verified' && typeof r.ready === 'boolean' && typeof r.verified === 'boolean', 'NATIVE_BRIDGE'); if (r.ready) { need(r.verified, 'CHECKPOINT'); return } need(!r.verified, 'NATIVE_BRIDGE'); need(performance.now() < end, 'TIMEOUT'); await new Promise<void>((resolve) => setTimeout(resolve, 60)) }
  }
  try {
    need(storagePassed && c.phase === 'grid-bit-blob' && /^[a-zA-Z0-9_]+$/.test(c.database), 'ISOLATION'); stage = 'CONNECTION'
    const connection = `MySQL parity ${c.runId}`
    await wait(() => treeRows().some((e) => label(e) === connection))
    const root = treeRows().filter((e) => e.getAttribute('aria-level') === '1'); need(root.length === 1 && label(root[0]!) === connection && !document.querySelector('.connection-dialog'), 'CONNECTION'); click(root[0]!)
    await wait(() => !!document.querySelector('.connection-summary')); need(one<HTMLElement>('.connection-summary strong').textContent === connection, 'CONNECTION'); report.checks.persisted_connection = true
    click(button('.connection-summary .connection-actions', '连接')); await wait(() => idle() && all<HTMLButtonElement>('.connection-summary .connection-actions button').some((e) => e.textContent?.trim() === '断开')); report.checks.credential_reconnect = true
    stage = 'FIXTURE_OPEN'
    const name = `gui_bin_${c.runId}`, table = `\`${c.database}\`.\`${name}\``
    await execute(`CREATE TABLE ${table} (id INT PRIMARY KEY,b1 BIT(1) NOT NULL,b64 BIT(64) NOT NULL,bin BLOB NULL) ENGINE=InnoDB`)
    await execute(`INSERT INTO ${table} (id,b1,b64,bin) VALUES (1,b'1',b'${'1'.repeat(64)}',X'00FFE4B8AD'),(2,b'0',b'1',X'00'),(3,b'1',b'1',X''),(4,b'0',b'1',NULL)`)
    need(tx().uiActive && tx().uiPendingAffected === 4, 'FIXTURE_OPEN')
    click(button('.result-grid .result-actions', '提交')); await tick(); await wait(() => idle() && (!tx().uiActive || sqlError()), true)
    need(!tx().uiActive && tx().uiPendingAffected === 0 && !sqlError(), 'FIXTURE_OPEN'); report.checks.fixture_created = true
    stage = 'TABLE_OPEN'
    await expand(tree(connection))
    for (let i = 0; i < 4 && !treeRows().some((e) => label(e) === c.database); i++) { const folder = treeRows().find((e) => e.dataset.nodeId?.includes('folder:schemas') && e.getAttribute('aria-expanded') === 'false'); need(folder, 'TABLE_OPEN'); await expand(folder) }
    await wait(() => treeRows().some((e) => label(e) === c.database)); await expand(tree(c.database))
    const folder = treeRows().find((e) => e.dataset.nodeId?.endsWith('|tables')); need(folder, 'TABLE_OPEN'); await expand(folder)
    await wait(() => treeRows().some((e) => label(e) === name)); const tableRow = tree(name); click(tableRow); dblclick(tableRow)
    await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').length === 4)
    click(button('.result-grid thead', 'id')); await tick(); await wait(() => idle() && all<HTMLElement>('.result-grid thead .column-sort').some((e) => e.textContent?.trim() === 'id ↑'))
    need(all<HTMLElement>('.result-grid thead .column-sort').map((e) => e.textContent?.trim().replace(/ [↑↓]$/, '')).join(',') === columns.join(','), 'TABLE_OPEN')
    need(all('.result-grid tbody tr').length === 4, 'TABLE_OPEN'); report.checks.table_open = true
    const tableTab = one<HTMLButtonElement>('.result-tabs .result-tab.is-active .tab-label')
    stage = 'BINARY_READ_FAILED'
    const columnCategories = all<HTMLElement>('.result-grid thead th small').map((e) => e.textContent?.trim() ?? '')
    need(columnCategories.length === 4 && columnCategories.every((v) => categories.includes(v)), 'BINARY_READ_FAILED'); report.checks.column_categories_read = true
    const baselineRows = await readRows(); report.checks.baseline_rows_read = true
    stage = 'BIT_EDIT_ENTRY'
    let bitReadonly = true
    for (const column of [1, 2]) {
      dblclick(cell(1, column))
      await wait(() => !!document.querySelector('.cell-viewer') || !!document.querySelector('[aria-label="编辑单元格"]') || hasError(), true)
      if (document.querySelector('[aria-label="编辑单元格"]')) bitReadonly = false
      if (document.querySelector('.cell-viewer')) { click(button('.cell-viewer', '关闭')); await tick(); await wait(() => !document.querySelector('.cell-viewer'), true) }
      else if (document.querySelector('[aria-label="编辑单元格"]')) { click(button('[aria-label="编辑单元格"]', '取消')); await tick(); await wait(() => !document.querySelector('[aria-label="编辑单元格"]'), true) }
    }
    report.checks.bit_readonly_observed = bitReadonly
    stage = 'READ_ONLY_BINARY'
    let editable = false
    dblclick(cell(1, 3))
    await wait(() => !!document.querySelector('[aria-label="编辑单元格"]') || !!document.querySelector('.cell-viewer') || hasError(), true)
    const editorOpen = !!document.querySelector('[aria-label="编辑单元格"]'), viewerOpen = !!document.querySelector('.cell-viewer')
    const inline = document.querySelector('.result-grid .inline-error')?.textContent?.trim() ?? null
    const viewerHex = viewerOpen ? (document.querySelector<HTMLTextAreaElement>('.cell-viewer textarea[aria-label="完整单元格值"]')?.value ?? null) : null
    proof.readonlyGap = {
      viewerOpened: viewerOpen,
      viewerTitle: viewerOpen ? (document.querySelector('.cell-viewer h2')?.textContent?.trim() ?? null) : null,
      viewerHex: viewerHex === null ? null : (viewerHex.length <= 128 ? viewerHex : viewerHex.slice(0, 128)),
      editorDialogPresent: editorOpen,
      inlineErrorText: inline === null ? null : (inline.length <= 64 ? inline : inline.slice(0, 64))
    }
    if (editorOpen) {
      const input = one<HTMLTextAreaElement>('[aria-label="编辑单元格"] textarea'), box = one<HTMLInputElement>('[aria-label="编辑单元格"] input[type="checkbox"]')
      const raw = input.value
      proof.editorOriginal = { raw: raw.length <= 64 ? raw : raw.slice(0, 64), isNull: box.checked, valueDisabled: input.disabled, nullDisabled: box.disabled }
      editable = true
      click(button('[aria-label="编辑单元格"]', '取消')); await tick(); await wait(() => !document.querySelector('[aria-label="编辑单元格"]'), true)
    } else if (viewerOpen) {
      click(button('.cell-viewer', '关闭')); await tick(); await wait(() => !document.querySelector('.cell-viewer'), true)
    }
    report.checks.blob_editable_entry = editable
    stage = 'BINARY_READ_FAILED'
    const witnessSql = `SELECT CONNECTION_ID() AS connection_id,HEX(b1) AS b1_hex,CAST(b1 AS UNSIGNED) AS b1_dec,HEX(b64) AS b64_hex,CAST(b64 AS UNSIGNED) AS b64_dec,IF(bin IS NULL,'NULL',HEX(bin)) AS bin_hex,IF(bin IS NULL,'NULL',CAST(OCTET_LENGTH(bin) AS CHAR)) AS bin_len,CAST(bin IS NULL AS CHAR) AS bin_null FROM ${table} ORDER BY id`
    await execute(witnessSql)
    const wit = witness(), witnessSha = await sha({ columns: projectionColumns, rows: wit.rows })
    need(!bitMismatch(baselineRows, wit.rows), 'BIT_VALUE_MISMATCH')
    need(!blobMismatch(baselineRows, wit.rows), 'BLOB_VALUE_MISMATCH')
    click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true)
    const baselineStage = await buildStage(baselineRows, columnCategories, editable, wit, witnessSha)
    proof.rows = baselineRows; proof.rowsSha256 = baselineStage.rowsSha256; proof.columnCategories = columnCategories; proof.stages.baseline = baselineStage
    report.proof = proof
    stage = 'CHECKPOINT'; await checkpoint('baseline', baselineStage)
    if (!bitReadonly) { report.failureCode = 'BIT_EDIT_ENTRY' }
    else if (!editable) { report.failureCode = 'READ_ONLY_BINARY' }
    else {
      stage = 'EDITOR_VALUE_LOSS'
      dblclick(cell(1, 3))
      await wait(() => !!document.querySelector('[aria-label="编辑单元格"] textarea') || hasError(), true)
      need(!!document.querySelector('[aria-label="编辑单元格"] textarea'), 'EDITOR_VALUE_LOSS')
      const input = one<HTMLTextAreaElement>('[aria-label="编辑单元格"] textarea'), box = one<HTMLInputElement>('[aria-label="编辑单元格"] input[type="checkbox"]')
      const raw = input.value
      proof.editorOriginal = { raw: raw.length <= 64 ? raw : raw.slice(0, 64), isNull: box.checked, valueDisabled: input.disabled, nullDisabled: box.disabled }
      need(proof.editorOriginal.raw === targetHex && !proof.editorOriginal.isNull && !proof.editorOriginal.valueDisabled && !proof.editorOriginal.nullDisabled, 'EDITOR_VALUE_LOSS')
      fill(input, editedHex)
      click(button('[aria-label="编辑单元格"]', '保存到本地修改')); await tick(); await wait(() => !document.querySelector('[aria-label="编辑单元格"]'), true)
      const draftRows = await readRows()
      need(draftRows[0]!.binHex === editedHex, 'EDITOR_VALUE_LOSS')
      report.checks.local_edits = dirty() === 1 && !tx().uiActive && tx().uiPendingAffected === 0
      stage = 'BINARY_READ_FAILED'
      await execute(witnessSql)
      const draftWitness = witness(), draftSha = await sha({ columns: projectionColumns, rows: draftWitness.rows })
      need(draftWitness.id === wit.id, 'CONNECTION')
      click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true)
      const draftStage = await buildStage(draftRows, columnCategories, true, draftWitness, draftSha)
      proof.stages.draft = draftStage
      stage = 'CHECKPOINT'; await checkpoint('draft', draftStage)
      stage = 'APPLY_REJECTED'
      click(button('.result-grid .result-actions', '应用修改', true)); await tick(); await wait(() => idle(), true)
      need(dirty() === 0 && !sqlError(), 'APPLY_REJECTED'); report.checks.apply_succeeded = true
      const appliedRows = await readRows()
      need(appliedRows[0]!.binHex === editedHex, 'BLOB_VALUE_MISMATCH')
      stage = 'BINARY_READ_FAILED'
      await execute(witnessSql)
      const appliedWitness = witness(), appliedSha = await sha({ columns: projectionColumns, rows: appliedWitness.rows })
      need(appliedWitness.id === wit.id, 'CONNECTION')
      click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true)
      const appliedStage = await buildStage(appliedRows, columnCategories, true, appliedWitness, appliedSha)
      proof.stages.applied = appliedStage
      stage = 'CHECKPOINT'; await checkpoint('applied', appliedStage)
      stage = 'COMMIT_FAILED'
      click(button('.result-grid .result-actions', '提交')); await tick(); await wait(() => idle() && (sqlError() || (one<HTMLElement>('#status-bar').textContent ?? '').startsWith('已提交当前连接事务')), true)
      need(!tx().uiActive && tx().uiPendingAffected === 0 && !sqlError(), 'COMMIT_FAILED')
      const committedRows = await readRows()
      need(committedRows[0]!.binHex === editedHex, 'BLOB_VALUE_MISMATCH')
      stage = 'BINARY_READ_FAILED'
      await execute(witnessSql)
      const committedWitness = witness(), committedSha = await sha({ columns: projectionColumns, rows: committedWitness.rows })
      need(committedWitness.id === wit.id, 'CONNECTION')
      click(tableTab); await tick(); await wait(() => idle() && tableTab.getAttribute('aria-selected') === 'true', true)
      const committedStage = await buildStage(committedRows, columnCategories, true, committedWitness, committedSha)
      proof.stages.committed = committedStage
      report.checks.committed_reload_verified = !tx().uiActive && tx().uiPendingAffected === 0 && dirty() === 0
      stage = 'CHECKPOINT'; await checkpoint('committed', committedStage)
    }
  } catch (error) { report.failureCode = error instanceof Fault ? error.code : stage }
  report.elapsedMs = Math.round(performance.now() - began)
  try { await bridge('mysqlAcceptanceReport', [report]) } catch { document.body.dataset.mysqlParity = 'NATIVE_BRIDGE' }
}
