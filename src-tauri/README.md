# Native desktop host

Tauri 2 hosts the shared Vue application. The only application command is
`backend_call({ method, args })`; its explicit allowlist calls `dbstudio-core`
on `spawn_blocking`. No Node backend, listener, tenant or remote connection
policy is involved.

Production credentials use `keyring` through `SecretStore`. OS vault failures
return a sanitized error; there is no plaintext or application AES-key fallback.
The main window has event-subscription permissions only, without arbitrary
filesystem, shell or window-destroy privileges.

The host prevents window/application exit and emits `dbstudio:exit-requested`.
Vue must finish dirty-edit and transaction decisions before calling
`backend_call({ method: 'confirmExit', args: [] })`. The host closes the core
before authorizing exit. Native import selection is the shell-owned
`chooseImportFile` method, not an arbitrary path/shell operation.

## Real macOS WKWebView smoke

The Lead owns Cargo builds and GUI launches; this host does not require
`tauri-driver` on macOS.

1. Build the Vue app with `VITE_DBSTUDIO_TEST_HOOKS=1`, producing `dist/desktop`.
2. Build the native app with `--features test-hooks`. Use the debug/test artifact,
   never a production distribution.
3. Launch its native executable with `DBSTUDIO_NATIVE_SMOKE_ROOT` set to a
   **nonexistent, absolute, immediate child of the OS temporary directory**.
   The host creates the directory with mode 0700 and uses `<root>/data` plus
   memory-only credentials, then creates a real SQLite fixture with a synthetic
   table and row. Existing directories and non-temp locations fail.
4. The native page-load handler waits for the Vue-only
   `window.__DBSTUDIO_NATIVE_SMOKE__` function and invokes it in real WKWebView.
   That function obtains `{ databasePath, isolated: true }` through
   `backend_call('smokeFixture', [])`, then performs real Vue/native backend
   calls against `<root>/fixture.sqlite`.
5. Vue returns `{ ok: boolean, checks: Record<string, boolean> }`. The host
   records it once at `<root>/report.json`, closes the core and exits 0/1.
   Reports accept only bounded identifier keys and boolean values, never SQL,
   cell data, credentials or caller-provided output paths.

Host-owned `native_*` report checks additionally require successful core calls
for connection creation, SQL execution, query, paging, edits, commit and rollback.
A frontend-only pass is downgraded to failure when these native calls are absent.

The directory and report are retained for review. A missing report, timeout or
false check is failure; opening a window alone is not acceptance. This smoke
covers the real invoke/core/SQLite chain, not an OS keyring integration test.

Production builds use neither the Rust `test-hooks` feature nor the frontend
Vite hook flag. Without the feature, `smokeFixture` and `smokeReport` are absent
from compiled command handling; a smoke environment variable causes startup to
fail rather than touch the user's application data.
