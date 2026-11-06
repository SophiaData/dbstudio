# Tauri + Vue + Rust Architecture Migration Implementation Plan

> **For agentic workers:** Execute the shared task board in dependency order. The Lead owns integration and validation; teammates write only their assigned scopes. Preserve all source and data, never run destructive cleanup.

**Goal:** Replace the dbstudio desktop runtime with Tauri 2, Vue 3 and native Rust business/database code while preserving verified desktop workflows and local data safety.

**Architecture:** Shared Rust contracts → native drivers → application core; Tauri is a consumer and supplies operating-system capabilities. Vue components call the explicit Tauri command bridge. HTTP/CLI can later consume the same core independently; this migration does not create a multi-tenant service or require an identity platform.

**Tech Stack:** Tauri 2, Vue 3 + TypeScript + Vite 7, Rust stable, rusqlite and native network database libraries, OS credential storage.

## Baseline and scope

- Baseline: merged main `5425be167847df9c98fa49aeffdb774e67f36795`, desktop version 0.7.0. Migration branch: `refactor/tauri-vue-rust`.
- Reference: t8y2/dbx architecture at `5c97a48c17621a3d82aa0b34330e206ef1bbcbfc`, especially `crates/ARCHITECTURE.md` and `apps/README.md`.
- Existing Electron source remains a behavior/reference implementation until its supported workflows are validated natively. A new window, Node sidecar or an unimplemented method does not count as migration completion.
- Uncommitted staging drafts and smoke evidence are preserved, excluded from this migration's commits and execution.
- Original user data is never used for tests. New storage files have a distinct schema/name; older encrypted credentials must not be overwritten or claimed decryptable without a working OS-compatible migration.
- No new multi-user identity, quota, public staging, microservice or global state framework scope.

## Boundaries and ownership

| Unit | Responsibility | Owner |
|---|---|---|
| `Cargo.toml`, `Cargo.lock`, `crates/dbstudio-protocol/**` | Workspace, DTOs, errors, driver interface | Lead |
| `crates/dbstudio-drivers/src/lib.rs` | Native driver dispatch, supported dialect descriptors | Lead |
| `crates/dbstudio-drivers/src/sqlite.rs`, its tests | SQLite native behavior | task-23 |
| `crates/dbstudio-drivers/src/postgresql.rs`, `mysql.rs`, network/TLS/tunnel helpers, driver Cargo | Network SQL adapters | task-24 |
| `crates/dbstudio-drivers/src/redis.rs`, `kafka.rs`, their tests | Read-only native NoSQL browsing | task-25 |
| `crates/dbstudio-core/**` | Configuration, session, cursor, task and business orchestration | task-26 |
| `src-tauri/**` | Commands, OS credential/dialog ports, window/exit behavior | task-27 |
| `apps/desktop/**` | Vue components, tab/editor/result state and backend client | task-28 |
| Root package/scripts/docs/CI | Build entrypoints, migration ledger, integration | Lead |

Dependency direction is `Vue → Tauri commands → core → drivers/protocol`; core and drivers must never import Tauri, Electron or a Node bridge. Platform capabilities enter through small interfaces. Drivers own live database resources and cancellation handles; core owns application lifecycle. A native connection need not repeat the old Node process model automatically; failure isolation requirements must be explicitly validated and documented.

## Frozen initial contracts

```rust
pub trait Driver: Send {
    fn dialect_id(&self) -> &str;
    fn capabilities(&self) -> serde_json::Value;
    fn call(&mut self, method: &str, args: Vec<serde_json::Value>)
        -> Result<serde_json::Value, DriverError>;
    fn cancel_handle(&self) -> CancelHandle;
    fn disconnect(&mut self) -> Result<(), DriverError>;
}
```

Driver arguments use native object/cursor IDs. The application core applies connection scope, checks stale sessions, and routes cancellation independently of a long-running query's mutex. Initial JSON DTOs follow the existing `src/core` methods and data shapes, preserving null/empty/binary/large-number and transaction semantics. Strongly typed Rust DTOs replace unstructured fields incrementally at their owning boundary.

```ts
const result = await invoke('backend_call', { method, args })
```

`backend_call` accepts only the explicit application method whitelist. Blocking database work runs outside the WebView thread. Filesystem and dialog operations are separate shell capabilities, not arbitrary frontend commands.

## Task 1: Native protocol and build skeleton

- [x] Create the workspace and shared protocol crate.
- [x] Add driver dispatch and complete all member manifests before running Cargo.
- [x] Install Vue/Tauri dependencies, preserve root config backups under `backups/`.
- [x] Validate `cargo metadata --no-deps --format-version 1` and protocol tests.

Protocol regression verifies separate secret channels, invalid secret keys rejected, and configuration Debug cannot expose private options.

## Task 2: Native drivers

- [x] SQLite connection, object tree, full metadata, bounded page cursors, parameter binding, rows/affected/DDL, transaction, unique-key CRUD and cancellation capability.
- [x] PostgreSQL and MySQL native connection/query/metadata/transactions/CRUD/EXPLAIN/cancellation, followed by TLS modes and SSH host fingerprint behavior.
- [x] Redis/Kafka native read-only object browsing and applicable TLS/SASL behavior.
- [x] Data task adapter operations: resolve transfer source, full cell values and atomic import batches.
- [x] Temporary SQLite integration tests run real SQL. External database tests require actual services and distinguish unavailable environments from passes.

Commands: `cargo test -p dbstudio-drivers --test sqlite_native`; network-specific tests are registered only once their real fixture setup and environment contract exist.

## Task 3: Application core

- [x] Implement configuration/session separation, per-connection lifecycle, safe persistent config and injectable secret storage.
- [x] Preserve saved configuration after normal connect failure; disconnect retains config, remove removes only the selected saved resource.
- [x] Route metadata/query/edit/transaction methods with scoped IDs, cursor release and stale-session checks.
- [x] Migrate SQL history/saved SQL and declare upgrade compatibility using isolated fixtures.
- [x] Implement data import/export, comparison and schema snapshot workflows without unbounded frontend result accumulation.
- [x] Reject any unmigrated method with explicit unsupported; never return fabricated empty success.

Commands: `cargo test -p dbstudio-core`; use a temporary application directory and real native SQLite drivers for lifecycle/transaction/data persistence tests.

## Task 4: Tauri desktop shell

- [x] Tauri configuration and Vite frontend path, production CSP and command permissions.
- [x] `backend_call` whitelist plus `spawn_blocking`, OS credential store and native file selection.
- [x] Preserve dirty-edit/transaction quit guards, handle window/menu exit and crash paths honestly.
- [x] Build-time test-hooks permit isolated real WebView smoke; production has no test-control commands.
- [x] Verify production build links native Rust code and has no Electron/Node backend runtime requirement.

Commands: `cargo check -p dbstudio-desktop`; `pnpm tauri:build --no-bundle`; native smoke launch uses only a fresh test data directory.

## Task 5: Vue workflow migration

- [x] Vue entry, backend adapter, connection form/list and lazy metadata tree.
- [x] SQL editor/scripts/parameters, multiple result tabs, bounded paging and full cell viewer.
- [x] Unique-key edits/insert/delete, connection-level transactions, tab-local drafts and operation/exit guards.
- [x] Native file import/export workflows, metadata/ER and comparisons, preserving capability gating.
- [x] Safe rendering of database text, no secret persistence in localStorage or logs.

Commands: `pnpm typecheck:desktop`; `pnpm build:desktop`; actual Tauri invoke smoke must execute connection/query/edit/rollback/commit/restart operations, not a browser mock.

## State ownership rules

| State | Owner |
|---|---|
| Saved connection configuration and credential references | Core persistence |
| Connected session, driver and current transaction | Connection session/native driver |
| Pending UI edits/filter/editor source | Vue tab/editor state |
| Cursor and execution cancellation | Native driver plus core-scoped resource registry |
| Import/export progress and recovery | Application task service |
| File dialogs, OS credentials and close approval | Tauri shell via explicit ports |

## Integration checkpoints and completion criteria

1. Real SQLite vertical slice: Vue UI → Tauri invoke → Rust core → rusqlite, including visible results and commit/rollback.
2. Feature ledger: each baseline capability marked implemented / tested / external-unverified / not-yet-migrated with exact evidence.
3. Native Rust unit/integration suites, Vue typecheck/build, architecture imports and production command surface checks.
4. Native WebView desktop smoke; then actual network DB/TLS/SSH fixtures where available. Skips are never counted as migration completion.
5. Configuration migration and OS secret roundtrip using isolated data, full import/export correctness and close/upgrade safeguards.
6. Read-only independent review of each complex module, followed by scoped fixes and reruns.
7. Update launch/build/release documentation and CI. Default user entrypoints switch to Tauri only with runnable native shell and honest feature availability; legacy commands remain explicit reference until retired by a separate reviewed change.

The native architecture implementation and macOS acceptance are complete for the scoped desktop workflows. Platform installer execution, signing/notarization and remote CI remain explicitly unverified; they are release acceptance rather than evidence inferred from compilation. Detailed capabilities and deliberate unsupported modes remain in the migration ledger.

## Execution log

- 2026-11-06: User explicitly requires Tauri + Vue + Rust. Verified Rust/Cargo stable aarch64, Node and pnpm available. Created migration branch and protocol; assigned tasks 23–28 with disjoint scopes. Staging drafts preserved and not executed.
- Runtime goal payload updated from paused staging to migration. Automatic resume was rejected by the runtime (`the user must resume it`); work continued under the user's explicit instruction, with this plan and shared task board preserving state.
- 2026-11-06 final acceptance: native workspace 85/0 (8 service tests explicitly ignored in default run, all separately executed), host 4/0 plus one actual macOS keyring roundtrip, Vue pure regressions 18/0, native candidate gate 13/0, and enhanced real Tauri WebView 64/0. The default `pnpm verify` chain also passed.
- Dedicated live PostgreSQL/MySQL 2/2, Redis TLS/Kafka TLS SASL 2/2 and SQL TLS/pinned SSH 4/4 passed. SQL TLS/SSH 4/4 was repeated with static OpenSSL linkage. Every fixture was stopped and retained without deletion.
- Independent reviews and regressions covered statement-scoped anonymous parameters, tab/transaction ownership, precise large integers, saved-secret whitespace, paging guards, loaded-export retry/cancellation, tree metadata readiness, escaped schema IDs, PostgreSQL RETURNING rollback, MySQL write-CTE rejection, and live/case-normalized export destination protection.
- Final macOS arm64 production `.app` was built from fresh Vue assets with test hooks disabled, includes platform icons and links only system dynamic libraries. A permission-preserving local ZIP and a hash/source record were generated in `dist/`; source record explicitly identifies uncommitted migration changes on this branch. No commit, PR, remote deployment or formal release was created.
- Defaults now use Tauri/Vue/Rust; legacy reference commands remain available. CI is native and candidate-only with version/source/run-attempt/hash checks. Windows/Linux installers, DMG installation, signing/notarization and actual OS save-dialog/clipboard interactions remain platform acceptance tasks as documented.
