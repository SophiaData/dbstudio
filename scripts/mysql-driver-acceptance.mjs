// Retain-only native driver baseline for one explicitly owned MySQL 8.0 fixture.
// --prepare-only creates private inputs; --run builds and runs only the exact ignored tests below.
// Imported fixture code is frozen; this runner never starts/stops a service or launches a GUI.
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { main as fixtureMain } from './mysql-ui-acceptance-fixture.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUN = 'b51c7485c6364ad1b6a4cc52f09619de'
const FIXTURE_ROOT = join(ROOT, 'backups', `mysql-parity-fixture-${RUN}`)
const READY = join(FIXTURE_ROOT, 'manifest.ready.json')
const MANIFEST_SHA = 'ad80c6250022db8bb165c76d0955727624bf2c41ed9ab9dae6153b88ea6833a9'
const CONTAINER = 'e5db8a8460a876df9cb2b9b89b2978772ab6366c74765fa7b0c997bb3ab63d46'
const IMAGE = 'sha256:b7e118f56c5963e079252e0d6e2978c9c010eb7fc7aaaec100e367796b5dd08f'
const FIXTURE_SOURCE_SHA = 'cc946c63a5a51f391bac46b2fe740fbe4b421b0fe381be7b2a233dbed076e34d'
const TEST_SOURCE = join(ROOT,'crates/dbstudio-drivers/tests/mysql_acceptance_live.rs')
const DRIVER_SOURCE = join(ROOT,'crates/dbstudio-drivers/src/mysql.rs')
const FIXTURE_SOURCE = join(ROOT,'scripts/mysql-ui-acceptance-fixture.mjs')
const CASES = Object.freeze([
  'mysql_select_duplicate_columns_and_pages',
  'mysql_show_tables_returns_rows',
  'mysql_show_create_table_returns_rows',
  'mysql_describe_returns_rows',
  'mysql_explain_returns_rows',
  'mysql_deadlock_reconciles_transaction_state',
  'mysql_management_snapshot_pages_full_values_and_close',
  'mysql_management_explain_bound_results_and_policy',
  'mysql_commit_visibility_to_fresh_observer',
  'mysql_duplicate_key_preserves_prior_transaction',
  'mysql_lock_wait_timeout_preserves_prior_transaction',
  'mysql_explain_api_returns_complete_plan',
])
const TRANSACTION_CASES = Object.freeze(CASES.slice(8,11))
const EXPLAIN_CASES = Object.freeze(CASES.slice(11,12))
const TIMEOUT_CASE = 'mysql_lock_wait_timeout_preserves_prior_transaction'
let cancelOwnedChild = null
const CHECK_KEYS = new Set(['duplicateColumnsPreserved','allFivePagesOrdered','originalLimitWindowPreserved',
  'guiBaselinePreserved','independentServerReferenceRows','driverReturnedUnsupported','nativeManagementRows',
  'actualDeadlock1213Observed','observerConfirmedWholeRollback','victimMarkerUnlockedBeforeCleanup',
  'victimCachedActive','victimCachedPendingNonzero','transactionStateMatchesServer','allSessionsRolledBack',
  'managementRemainsNontransactional','snapshotPagingDidNotReplay','keepCursorFalseRespected',
  'longDdlSnapshotExactAfterMutation','cursorCloseReleasesCapacity','textAndBinaryNumericResultsAgree','explainExecutionVariantsRejected',
  'uncommittedWriteInvisibleToFreshObserver','committedWriteVisibleToFreshObserver','commitClearsPendingState','committedEvidenceRetained',
  'actualLockWait1205Observed','actualDuplicate1062Observed','originalStatementErrorCodePreserved','failedStatementRowsRolledBack',
  'priorMarkerLockPreserved','priorTransactionWritePreserved','pendingStatePreservedAfterStatementError','allContractWritesRolledBack',
  'oneSecondTimeoutInherited','rollbackOnTimeoutOff','globalTimeoutRestored',
  'independentExplainReferenceRows','explainApiUnsupported','explainFiveFieldContract','explainCellsMatchIndependentReference',
  'explainHasNoCursorOrPageFields','explainAllPlanRowsReturned','explainDangerousInputsRejectedWithoutExecution',
  'explainOriginalServerErrorPreserved','explainRemainsNontransactional','explainAllocatesNoHiddenCursor'])
const REPORT_CODES = new Set(['OK','DUPLICATE_COLUMN_CONTRACT','PAGE_WINDOW_CONTRACT','PAGE_ROW_CONTRACT',
  'PAGE_COUNT_CONTRACT','ORIGINAL_LIMIT_CONTRACT','MANAGEMENT_ROWS_UNSUPPORTED','MANAGEMENT_ROWS_CONTRACT',
  'MANAGEMENT_CONTENT_CONTRACT','DEADLOCK_TRANSACTION_STATE_STALE','CLEANUP_UNCONFIRMED',
  'NATIVE_CONNECT_FAILED','INDEPENDENT_CONNECT_FAILED','INDEPENDENT_SESSION_FAILED','OBSERVER_READ_ONLY_FAILED',
  'OBSERVER_QUERY_FAILED','GUI_BASELINE_CHANGED','NATIVE_CALL_FAILED','CURSOR_MISSING','ROWS_SHAPE_INVALID',
  'SERVER_REFERENCE_EMPTY','MANAGEMENT_CALL_FAILED','DEADLOCK_DETECTION_REQUIRED','BASELINE_COMMIT_UNCONFIRMED',
  'ACTOR_RELEASE_FAILED','ACTOR_RESULT_TIMEOUT','ACTUAL_DEADLOCK_NOT_OBSERVED','SURVIVOR_ROLLBACK_UNCONFIRMED','TRANSACTION_STATE_SHAPE_INVALID',
  'TRANSACTION_BASELINE_CHANGED','LOCK_PROBE_START_FAILED','LOCK_PROBE_ROLLBACK_FAILED',
  'VICTIM_MARKER_STILL_LOCKED','VICTIM_MARKER_NOT_BASELINE','UNEXPECTED_TEST_PANIC',
  'PRIVATE_FILE_OUTSIDE_ROOT','PRIVATE_FILE_INVALID','PRIVATE_FILE_ALIAS','PRIVATE_FILE_READ_FAILED',
  'GENERATED_SECRET_INVALID','DRIVER_CONFIG_INVALID','MANAGEMENT_NONTRANSACTIONAL_CONTRACT',
  'MANAGEMENT_SNAPSHOT_CONTRACT','MANAGEMENT_LONG_VALUE_CONTRACT','MANAGEMENT_CURSOR_LIMIT_CONTRACT',
  'MANAGEMENT_CURSOR_CLOSE_CONTRACT','MANAGEMENT_BOUND_RESULT_CONTRACT','MANAGEMENT_EXPLAIN_POLICY_CONTRACT',
  'MANAGEMENT_FIXTURE_DDL_FAILED','MANAGEMENT_PAGE_NO_PROGRESS','MANAGEMENT_MUTATION_NOT_OBSERVED',
  'TRANSACTION_CONTRACT_OBSERVER_MISMATCH','COMMIT_VISIBILITY_STATE_CONTRACT','LOCK_TIMEOUT_INHERITANCE_REQUIRED',
  'ROLLBACK_ON_TIMEOUT_OFF_REQUIRED','TIMEOUT_BLOCKER_FAILED','ACTUAL_LOCK_TIMEOUT_NOT_OBSERVED','ACTUAL_DUPLICATE_NOT_OBSERVED',
  'STATEMENT_ERROR_TRANSACTION_STATE_CONTRACT','PRIOR_TRANSACTION_WRITE_LOST','FAILED_STATEMENT_NOT_ROLLED_BACK','PRIOR_MARKER_LOCK_NOT_OBSERVED',
  'EXPLAIN_REFERENCE_VALUE_INVALID','EXPLAIN_API_RESULT_CONTRACT','EXPLAIN_API_REFERENCE_CONTRACT','EXPLAIN_API_COMPLETE_VALUE_CONTRACT',
  'EXPLAIN_API_UNSUPPORTED','EXPLAIN_API_CALL_FAILED','EXPLAIN_REFERENCE_TOO_SMALL','EXPLAIN_COUNTER_SETUP_FAILED',
  'EXPLAIN_API_INPUT_POLICY_CONTRACT','EXPLAIN_API_INPUT_EXECUTED','EXPLAIN_API_ARGUMENT_CONTRACT',
  'EXPLAIN_API_ORIGINAL_ERROR_CONTRACT','EXPLAIN_API_NONTRANSACTIONAL_CONTRACT','EXPLAIN_API_CURSOR_LEAK_CONTRACT'])
const sha = (value) => createHash('sha256').update(value).digest('hex')
class BaselineFailure extends Error { constructor(code) { super(code); this.code = code } }
const need = (condition, code) => { if (!condition) throw new BaselineFailure(code) }
function directory(path) {
  const info = lstatSync(path)
  need(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700 && realpathSync(path) === path,'PRIVATE_DIRECTORY_INVALID')
}
function file(path, root, maximum) {
  need(dirname(path) === root, 'PRIVATE_FILE_OUTSIDE_ROOT')
  const info = lstatSync(path)
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o777) === 0o600
    && info.size <= maximum && realpathSync(path) === path,'PRIVATE_FILE_INVALID')
  return info
}
function writePrivate(path, value) {
  writeFileSync(path,value,{flag:'wx',mode:0o600})
  file(path,dirname(path),64 * 1024 * 1024)
}
function writeJson(path, value) { writePrivate(path,`${JSON.stringify(value,null,2)}\n`) }
function sourceHashes() {
  return { test:sha(readFileSync(TEST_SOURCE)),driver:sha(readFileSync(DRIVER_SOURCE)),
    fixture:sha(readFileSync(FIXTURE_SOURCE)),runner:sha(readFileSync(fileURLToPath(import.meta.url))) }
}
async function ownedLive() {
  need(sha(readFileSync(FIXTURE_SOURCE)) === FIXTURE_SOURCE_SHA,'FROZEN_FIXTURE_SOURCE_CHANGED')
  let status
  try { status = await fixtureMain(['--status',READY]) } catch { throw new BaselineFailure('FIXTURE_LIVE_CHECK_FAILED') }
  need(status?.status === 'OWNED_SERVICE_LIVE' && status.runId === RUN && status.containerId === CONTAINER
    && status.manifestSha256 === MANIFEST_SHA && status.imageSha256 === IMAGE && status.fixtureSourceSha256 === FIXTURE_SOURCE_SHA
    && status.serverVersion === '8.0.46' && status.ready === true && status.ownershipVerified === true
    && status.running === true && status.healthy === true && status.loopbackBindingVerified === true
    && status.guiPassed === false,'OWNED_SERVICE_IDENTITY_MISMATCH')
  return status
}
function inputManifest() {
  need(dirname(FIXTURE_ROOT) === join(ROOT,'backups') && realpathSync(ROOT) === ROOT,'WORKSPACE_IDENTITY_INVALID')
  directory(FIXTURE_ROOT); file(READY,FIXTURE_ROOT,64 * 1024)
  const bytes = readFileSync(READY)
  need(sha(bytes) === MANIFEST_SHA,'MANIFEST_CHANGED')
  let manifest
  try { manifest = JSON.parse(bytes) } catch { throw new BaselineFailure('MANIFEST_INVALID') }
  need(manifest.schemaVersion === 1 && manifest.runId === RUN && manifest.fixtureRoot === FIXTURE_ROOT
    && manifest.host === '127.0.0.1' && Number.isInteger(manifest.port) && manifest.port >= 1 && manifest.port <= 65535
    && manifest.database === `mysql_accept_${RUN.slice(0,16)}` && manifest.ready === true && manifest.state === 'running'
    && manifest.containerId === CONTAINER && manifest.image.id === IMAGE
    && manifest.owner?.label === 'io.dbstudio.mysql-ui-acceptance' && manifest.owner.value === RUN
    && manifest.owner.kind === 'dbstudio-mysql-parity-fixture-v1','MANIFEST_IDENTITY_MISMATCH')
  const roles = {}
  for (const name of ['app','observer']) {
    const role = manifest[name]
    need(role?.user === `${name}_${RUN.slice(0,12)}` && role.secretFilePath === join(FIXTURE_ROOT,`${name}.secret`)
      && !Object.hasOwn(role,'password'),'ROLE_IDENTITY_MISMATCH')
    // Metadata only: generated credential bytes are read exclusively by the Rust test process.
    file(role.secretFilePath,FIXTURE_ROOT,128)
    roles[name] = {user:role.user,secretFilePath:role.secretFilePath}
  }
  need(manifest.observer.readOnly === true && manifest.observer.autocommit === true,'OBSERVER_POLICY_INVALID')
  return {host:manifest.host,port:manifest.port,database:manifest.database,...roles}
}
async function prepare(transactionsOnly = false) {
  await ownedLive()
  const input = inputManifest()
  const attemptId = randomUUID().replaceAll('-','')
  const evidenceRoot = join(ROOT,'backups',`${transactionsOnly?'mysql-transaction-contract-':'mysql-driver-acceptance-'}${attemptId}`)
  need(realpathSync(join(ROOT,'backups')) === join(ROOT,'backups'),'EVIDENCE_PARENT_ALIAS')
  mkdirSync(evidenceRoot,{mode:0o700}); directory(evidenceRoot)
  const configPath = join(evidenceRoot,'config.json')
  const config = {schemaVersion:1,runId:RUN,attemptId,manifestSha256:MANIFEST_SHA,containerId:CONTAINER,
    evidenceRoot,fixtureRoot:FIXTURE_ROOT,...input,table:`native_tx_${attemptId.slice(0,16)}`}
  writeJson(configPath,config)
  const hashes = sourceHashes()
  writeJson(join(evidenceRoot,'source-hashes.json'),hashes)
  return {attemptId,evidenceRoot,configPath,hashes}
}
function unchanged(expected) {
  const actual = sourceHashes()
  need(Object.keys(expected).every((key) => actual[key] === expected[key]),'SOURCE_SNAPSHOT_CHANGED')
}
function buildEnvironment() {
  const env = {}
  for (const key of ['PATH','HOME','CARGO_HOME','RUSTUP_HOME','RUSTUP_TOOLCHAIN','SDKROOT','DEVELOPER_DIR','MACOSX_DEPLOYMENT_TARGET','TMPDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.RUST_BACKTRACE = '0'
  return env
}
function child(program, args, env, timeoutMs, root, prefix, collect = false) {
  const stdoutPath = join(root,`${prefix}.stdout.log`), stderrPath = join(root,`${prefix}.stderr.log`)
  const out = openSync(stdoutPath,'wx',0o600), err = openSync(stderrPath,'wx',0o600)
  file(stdoutPath,root,0); file(stderrPath,root,0)
  return new Promise((done) => {
    const proc = spawn(program,args,{cwd:ROOT,env,stdio:['ignore','pipe','pipe'],shell:false})
    let timedOut = false, oversized = false, spawnFailed = false, logFailed = false, closed = false, total = 0, captured = ''
    let escalation
    const terminate = () => {
      if (closed) return
      proc.kill('SIGTERM')
      escalation = setTimeout(() => { if (!closed) proc.kill('SIGKILL') },5000)
    }
    cancelOwnedChild = terminate
    const timer = setTimeout(() => { timedOut = true; terminate() },timeoutMs)
    const output = (fd, data, isStdout) => {
      total += data.length
      if (total <= 64 * 1024 * 1024) {
        try { writeSync(fd,data) } catch { logFailed = true; terminate() }
      } else if (!oversized) { oversized = true; terminate() }
      if (collect && isStdout && total <= 16 * 1024 * 1024) captured += data.toString('utf8')
    }
    proc.stdout.on('data',(data) => output(out,data,true)); proc.stderr.on('data',(data) => output(err,data,false))
    proc.on('error',() => { spawnFailed = true })
    proc.on('close',(code,signal) => {
      closed = true; clearTimeout(timer); if (escalation) clearTimeout(escalation)
      if (cancelOwnedChild === terminate) cancelOwnedChild = null
      try { closeSync(out) } catch { logFailed = true }
      try { closeSync(err) } catch { logFailed = true }
      done({code,signal,timedOut,oversized,spawnFailed,logFailed,stdout:captured})
    })
  })
}
function compiledBinary(output, target) {
  const artifacts = []
  for (const line of output.split('\n')) {
    let row; try { row = JSON.parse(line) } catch { continue }
    if (row.reason === 'compiler-artifact' && row.target?.name === 'mysql_acceptance_live'
      && row.target?.kind?.includes('test') && typeof row.executable === 'string') artifacts.push(row.executable)
  }
  need(artifacts.length === 1,'TEST_ARTIFACT_MISSING')
  const path = artifacts[0]
  need(dirname(path) === join(target,'debug','deps') && path.startsWith(join(target,'debug','deps','mysql_acceptance_live-'))
    && realpathSync(path) === path,'TEST_ARTIFACT_OUTSIDE_TARGET')
  const info = lstatSync(path)
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1,'TEST_ARTIFACT_INVALID')
  return path
}
function caseReport(root, caseId, execution) {
  const failure = (code) => ({caseId,actualExit:execution.code,outcome:'INFRA_FAILED',code,cleanupConfirmed:false,checks:{}})
  if (execution.timedOut || execution.oversized) return failure('CLEANUP_UNCONFIRMED')
  if (execution.spawnFailed || execution.logFailed || execution.signal || ![0,101].includes(execution.code)) return failure('TEST_PROCESS_FAILED')
  let report
  try {
    const path = join(root,`${caseId}.json`)
    file(path,root,16 * 1024); report = JSON.parse(readFileSync(path,'utf8'))
  } catch { return failure('TEST_WITNESS_MISSING') }
  if (report?.schemaVersion !== 1 || report.caseId !== caseId || !['PASS','KNOWN_GAP_RED','INFRA_FAILED'].includes(report.outcome)
    || !REPORT_CODES.has(report.code) || typeof report.cleanupConfirmed !== 'boolean' || !report.checks
    || Object.keys(report.checks).some((key) => !CHECK_KEYS.has(key) || typeof report.checks[key] !== 'boolean')) return failure('TEST_WITNESS_INVALID')
  if (!report.cleanupConfirmed) return failure('CLEANUP_UNCONFIRMED')
  if ((report.outcome === 'PASS') !== (execution.code === 0)) return failure('TEST_EXIT_WITNESS_MISMATCH')
  return {caseId,actualExit:execution.code,outcome:report.outcome,code:report.code,cleanupConfirmed:true,checks:report.checks}
}
function guardDocker(args, input) {
  try { return execFileSync('docker',args,{cwd:ROOT,input,encoding:'utf8',timeout:15000,
    stdio:['pipe','pipe','pipe'],maxBuffer:64*1024}).trim() }
  catch { throw new BaselineFailure('LOCK_TIMEOUT_GUARD_COMMAND_FAILED') }
}
function guardContainer() {
  const value=guardDocker(['inspect','--format','{{.Id}} {{index .Config.Labels "io.dbstudio.mysql-ui-acceptance"}} {{index .Config.Labels "io.dbstudio.fixture-owner"}} {{.Image}} {{.State.Running}}',CONTAINER])
  const fields=value.split(' ')
  need(fields.length===5&&fields[0]===CONTAINER&&fields[1]===RUN&&fields[2]==='dbstudio-mysql-parity-fixture-v1'
    &&fields[3]===IMAGE&&fields[4]==='true','LOCK_TIMEOUT_GUARD_OWNERSHIP_MISMATCH')
}
function adminStatement(sql) {
  // The only caller-generated value is a validated decimal timeout; no external SQL arguments.
  need(sql==='SELECT SUBSTRING_INDEX(CURRENT_USER(),\'@\',1)=\'root\',@@global.innodb_lock_wait_timeout,@@global.innodb_rollback_on_timeout;'
    || /^SET GLOBAL innodb_lock_wait_timeout=[0-9]+;$/.test(sql),'LOCK_TIMEOUT_GUARD_SQL_FORBIDDEN')
  guardContainer()
  return guardDocker(['exec','--interactive','--user','0:0',CONTAINER,'mysql',
    '--defaults-extra-file=/fixture/admin-client.cnf','--connect-timeout=3','--batch','--raw','--skip-column-names'],`${sql}\n`)
}
function readTimeoutGlobal() {
  const fields=adminStatement('SELECT SUBSTRING_INDEX(CURRENT_USER(),\'@\',1)=\'root\',@@global.innodb_lock_wait_timeout,@@global.innodb_rollback_on_timeout;').split('\t')
  need(fields.length===3&&fields[0]==='1'&&/^[0-9]+$/.test(fields[1])&&['0','1'].includes(fields[2]),'LOCK_TIMEOUT_GUARD_STATE_INVALID')
  const timeout=Number(fields[1])
  need(Number.isSafeInteger(timeout)&&timeout>=1&&timeout<=1073741824,'LOCK_TIMEOUT_GUARD_STATE_INVALID')
  return {timeout,rollbackOnTimeoutOff:fields[2]==='0'}
}
function setTimeoutGlobal(value) {
  need(Number.isSafeInteger(value)&&value>=1&&value<=1073741824,'LOCK_TIMEOUT_GUARD_VALUE_INVALID')
  readTimeoutGlobal() // Verify server-side root identity before every mutation, with a fresh private client.
  need(adminStatement(`SET GLOBAL innodb_lock_wait_timeout=${value};`)==='','LOCK_TIMEOUT_GUARD_SET_FAILED')
}
function timeoutLease(prepared) {
  const path=join(ROOT,'backups',`mysql-transaction-contract-service-lock-${RUN}`)
  need(dirname(path)===join(ROOT,'backups')&&realpathSync(dirname(path))===dirname(path),'LOCK_TIMEOUT_LEASE_PATH_INVALID')
  try {mkdirSync(path,{mode:0o700})} catch {throw new BaselineFailure('LOCK_TIMEOUT_GUARD_BUSY_OR_RETAINED')}
  directory(path)
  const owner=join(path,'owner.json')
  writeJson(owner,{runId:RUN,attemptId:prepared.attemptId})
  const identity=lstatSync(path)
  return {path,owner,ino:identity.ino,dev:identity.dev}
}
function retainReleasedLease(prepared,lease) {
  directory(lease.path);file(lease.owner,lease.path,1024)
  const owner=JSON.parse(readFileSync(lease.owner,'utf8'))
  const identity=lstatSync(lease.path)
  need(owner.runId===RUN&&owner.attemptId===prepared.attemptId&&identity.ino===lease.ino&&identity.dev===lease.dev,'LOCK_TIMEOUT_LEASE_OWNERSHIP_MISMATCH')
  directory(prepared.evidenceRoot)
  const target=join(prepared.evidenceRoot,'timeout-guard-lock-retained')
  need(dirname(target)===prepared.evidenceRoot&&realpathSync(dirname(target))===prepared.evidenceRoot,'LOCK_TIMEOUT_LEASE_PATH_INVALID')
  let absent=false
  try {lstatSync(target)} catch(error){if(error.code==='ENOENT')absent=true;else throw error}
  need(absent,'LOCK_TIMEOUT_LEASE_ARCHIVE_EXISTS')
  // Move only this verified owned lease. Nothing is deleted; stale/failing leases are never stolen.
  renameSync(lease.path,target)
}
async function timeoutGuard(prepared, runCase) {
  let original, lease, armed=false, interrupted=false, restored=false, proofWritten=false, result, failure
  const interrupt=()=>{interrupted=true;if(cancelOwnedChild)cancelOwnedChild()}
  process.on('SIGTERM',interrupt);process.on('SIGINT',interrupt)
  try {
    lease=timeoutLease(prepared)
    const before=readTimeoutGlobal()
    need(before.rollbackOnTimeoutOff,'ROLLBACK_ON_TIMEOUT_OFF_REQUIRED')
    original=before.timeout
    writeJson(join(prepared.evidenceRoot,'lock-timeout-global-before.json'),{schemaVersion:1,caseId:TIMEOUT_CASE,
      containerId:CONTAINER,originalTimeout:original,requestedTimeout:1,rollbackOnTimeoutOff:true})
    need(!interrupted,'LOCK_TIMEOUT_GUARD_INTERRUPTED')
    armed=true // Restore even if the following mutation returns an ambiguous client failure.
    setTimeoutGlobal(1)
    const active=readTimeoutGlobal()
    need(active.timeout===1&&active.rollbackOnTimeoutOff,'LOCK_TIMEOUT_GUARD_NOT_EFFECTIVE')
    need(!interrupted,'LOCK_TIMEOUT_GUARD_INTERRUPTED')
    result=await runCase()
    need(!interrupted,'LOCK_TIMEOUT_GUARD_INTERRUPTED')
  } catch(error) { failure=error instanceof BaselineFailure?error:new BaselineFailure('LOCK_TIMEOUT_GUARD_INTERNAL_ERROR') }
  finally {
    if(armed){
      try {
        // setTimeoutGlobal and this independent read each repeat immutable ownership/root checks.
        setTimeoutGlobal(original)
        const after=readTimeoutGlobal()
        restored=after.timeout===original&&after.rollbackOnTimeoutOff
      } catch { restored=false }
      try {
        writeJson(join(prepared.evidenceRoot,'lock-timeout-global-restored.json'),{schemaVersion:1,caseId:TIMEOUT_CASE,
          changeAttempted:true,globalTimeoutRestored:restored,independentReadbackVerified:restored})
        proofWritten=true
      } catch { proofWritten=false }
    }
    if(lease&&(!armed||(restored&&proofWritten))){
      try {retainReleasedLease(prepared,lease)} catch {failure=new BaselineFailure('LOCK_TIMEOUT_LEASE_RELEASE_UNCONFIRMED')}
    }
    process.removeListener('SIGTERM',interrupt);process.removeListener('SIGINT',interrupt)
  }
  if(armed&&(!restored||!proofWritten)) failure=new BaselineFailure('LOCK_TIMEOUT_GLOBAL_RESTORE_UNCONFIRMED')
  if(failure){failure.caseResult=result??null;failure.globalTimeoutRestored=armed&&restored&&proofWritten;throw failure}
  need(result&&armed&&restored&&proofWritten,'LOCK_TIMEOUT_GUARD_INCOMPLETE')
  return {...result,checks:{...result.checks,globalTimeoutRestored:true}}
}
export async function main(args = process.argv.slice(2)) {
  process.umask(0o077)
  need(args.length === 1 && ['--prepare-only','--run','--run-transactions','--run-explain'].includes(args[0]),'ARGUMENTS_INVALID')
  const transactionsOnly=args[0]==='--run-transactions'
  const explainOnly=args[0]==='--run-explain'
  const selectedCases=transactionsOnly?TRANSACTION_CASES:explainOnly?EXPLAIN_CASES:CASES
  const prepared = await prepare(transactionsOnly)
  if (args[0] === '--prepare-only') return {status:'NATIVE_INPUTS_PREPARED',runId:RUN,attemptId:prepared.attemptId,
    evidenceRoot:prepared.evidenceRoot,sourceHashes:prepared.hashes,allGreen:false,nativeExecuted:false,guiPassed:false}
  const target = join(prepared.evidenceRoot,'target')
  const build = await child('cargo',['test','--offline','--locked','-p','dbstudio-drivers','--test','mysql_acceptance_live',
    '--no-run','--message-format=json','--target-dir',target],buildEnvironment(),20*60*1000,prepared.evidenceRoot,'build',true)
  need(!build.timedOut && !build.oversized && !build.spawnFailed && !build.logFailed && build.code === 0,'NATIVE_BUILD_FAILED')
  unchanged(prepared.hashes)
  const binary = compiledBinary(build.stdout,target)
  const binarySha256 = sha(readFileSync(binary))
  writeJson(join(prepared.evidenceRoot,'artifact.json'),{binarySha256,testSourceSha256:prepared.hashes.test})
  const cases = []
  for (const caseId of selectedCases) {
    unchanged(prepared.hashes); await ownedLive()
    const runCase=async()=>{
      const execution = await child(binary,[caseId,'--ignored','--exact','--nocapture'],
        {DBSTUDIO_MYSQL_DRIVER_ACCEPTANCE_CONFIG:prepared.configPath,RUST_BACKTRACE:'0'},90000,prepared.evidenceRoot,caseId)
      return caseReport(prepared.evidenceRoot,caseId,execution)
    }
    let result
    if(caseId===TIMEOUT_CASE){
      try {result=await timeoutGuard(prepared,runCase)}
      catch(error){result={caseId,actualExit:error instanceof BaselineFailure?(error.caseResult?.actualExit??null):null,outcome:'INFRA_FAILED',code:error instanceof BaselineFailure?error.code:'LOCK_TIMEOUT_GUARD_INTERNAL_ERROR',cleanupConfirmed:false,checks:{...(error instanceof BaselineFailure?(error.caseResult?.checks??{}):{}),globalTimeoutRestored:error instanceof BaselineFailure&&error.globalTimeoutRestored===true}}}
    } else result=await runCase()
    cases.push(result)
    if (result.outcome === 'INFRA_FAILED') break
  }
  const allGreen = cases.length === selectedCases.length && cases.every((item) => item.outcome === 'PASS')
  const result = {status:allGreen?'NATIVE_BASELINE_ALL_GREEN':'NATIVE_BASELINE_HAS_GAPS',runId:RUN,attemptId:prepared.attemptId,
    evidenceRoot:prepared.evidenceRoot,binarySha256,scope:transactionsOnly?'transaction-contracts-3':explainOnly?'explain-api-1':'all-defined-native-cases',
    selectedCaseIds:[...selectedCases],totalDefinedCases:CASES.length,allGreen,cases,nativeExecuted:true,guiPassed:false}
  writeJson(join(prepared.evidenceRoot,'summary.json'),result)
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((result) => {
    console.log(JSON.stringify(result))
    if (!result.allGreen && result.nativeExecuted) process.exitCode = 1
  }).catch((error) => {
    console.error(JSON.stringify({status:'NATIVE_BASELINE_INFRA_FAILED',code:error instanceof BaselineFailure?error.code:'NATIVE_BASELINE_INTERNAL_ERROR',allGreen:false,guiPassed:false}))
    process.exitCode = 1
  })
}
