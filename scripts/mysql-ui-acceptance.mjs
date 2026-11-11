// Initial MySQL real UI chain. No HTTP server, Docker enumeration, or secret/manifest reads.
// --status is read-only; --check-only validates the final build receipt without launching.
// --run may be used only after the Lead's explicit integrated-test instruction.
import { main as fixture } from './mysql-ui-acceptance-fixture.mjs'
import { verifyStorageReceipt } from './mysql-acceptance-storage.mjs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync, writeFileSync, readdirSync, openSync, writeSync, fsyncSync, closeSync, fstatSync, renameSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PINNED_IMAGE_SHA = 'sha256:b7e118f56c5963e079252e0d6e2978c9c010eb7fc7aaaec100e367796b5dd08f'
function loadFixturePin(path) {
  const requirePin=(condition)=>{if(!condition)throw new Error('FIXTURE_PIN_INVALID')}
  requirePin(typeof path==='string'&&path===resolve(path)&&basename(path)==='runner-public-pins.json')
  const directory=dirname(path),match=/^mysql-parity-fixture-([a-f0-9]{32})$/.exec(basename(directory))
  requirePin(match&&dirname(directory)===join(ROOT,'backups'))
  const dir=lstatSync(directory)
  requirePin(dir.isDirectory()&&!dir.isSymbolicLink()&&(dir.mode&0o777)===0o700&&realpathSync(directory)===directory)
  const info=lstatSync(path)
  requirePin(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&(info.mode&0o777)===0o600&&info.size<=4096&&realpathSync(path)===path)
  const bytes=readFileSync(path);requirePin(bytes.length<=4096);const value=JSON.parse(bytes.toString('utf8'))
  requirePin(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===['schemaVersion','runId','manifestSha256','containerId','imageSha256'].sort().join(','))
  requirePin(value.schemaVersion===1&&value.runId===match[1]&&value.runId!=='b51c7485c6364ad1b6a4cc52f09619de'
    &&typeof value.manifestSha256==='string'&&/^[a-f0-9]{64}$/.test(value.manifestSha256)
    &&typeof value.containerId==='string'&&/^[a-f0-9]{64}$/.test(value.containerId)&&value.imageSha256===PINNED_IMAGE_SHA)
  return Object.freeze({...value,pinSha256:createHash('sha256').update(bytes).digest('hex')})
}
function createRunner(pin = null) {
const RUN = pin?.runId ?? 'b51c7485c6364ad1b6a4cc52f09619de'
const READY = join(ROOT, 'backups', `mysql-parity-fixture-${RUN}`, 'manifest.ready.json')
const MANIFEST_SHA = pin?.manifestSha256 ?? 'ad80c6250022db8bb165c76d0955727624bf2c41ed9ab9dae6153b88ea6833a9'
const CONTAINER = pin?.containerId ?? 'e5db8a8460a876df9cb2b9b89b2978772ab6366c74765fa7b0c997bb3ab63d46'
const IMAGE_SHA = PINNED_IMAGE_SHA
const FIXTURE_SHA = 'cc946c63a5a51f391bac46b2fe740fbe4b421b0fe381be7b2a233dbed076e34d'
const CHECKS = ['storage_preflight', 'connection_form', 'sql_select41', 'page_first', 'page_next', 'page_back']
const SOURCES = ['apps/desktop/src/main.ts', 'apps/desktop/src/App.vue', 'apps/desktop/src/mysql-parity-dom.ts', 'apps/desktop/src/components/ConnectionDialog.vue', 'apps/desktop/src/components/SqlEditor.vue', 'apps/desktop/src/components/ResultGrid.vue', 'apps/desktop/src/workbench.ts', 'apps/desktop/src/backend.ts', 'src-tauri/src/lib.rs', 'src-tauri/src/mysql_acceptance.rs', 'src-tauri/Cargo.toml', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.mysql-acceptance.conf.json', 'src-tauri/capabilities/main.json', 'scripts/build-mysql-acceptance.mjs', 'Cargo.lock', 'crates/dbstudio-drivers/src/mysql.rs', 'crates/dbstudio-core/src/lib.rs', 'apps/desktop/src/components/CellViewer.vue', 'apps/desktop/src/result-export.ts', 'crates/dbstudio-drivers/src/network.rs', 'src/core/resultset.ts']
const hash = (value) => createHash('sha256').update(value).digest('hex')
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
class RunFailure extends Error { constructor(code) { super(code); this.code = code } }
const need = (condition, code) => { if (!condition) throw new RunFailure(code) }
function exact(value, keys, code) { need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','), code) }
function integer(n, max = 3_600_000) { return Number.isSafeInteger(n) && n >= 0 && n <= max }
function file(path, max, privateMode = false) {
  const info = lstatSync(path)
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= max && realpathSync(path) === path, 'FILE_INVALID')
  if (privateMode) need((info.mode & 0o777) === 0o600, 'FILE_INVALID')
  return readFileSync(path)
}
const RUNNER_SHA=pin?hash(file(fileURLToPath(import.meta.url),1024*1024)):null
function pairProvenance(checked){
  if(!pin)return {}
  need(hash(file(fileURLToPath(import.meta.url),1024*1024))===RUNNER_SHA,'RUNNER_SOURCE_CHANGED')
  need(hash(file(join(dirname(READY),'runner-public-pins.json'),4096,true))===pin.pinSha256,'FIXTURE_PIN_CHANGED')
  return {runnerSourceSha256:RUNNER_SHA,fixturePinSha256:pin.pinSha256,artifactReceiptSha256:checked.receiptSha256}
}
function jsonFile(path, max = 256 * 1024) { return JSON.parse(file(path, max, true).toString('utf8')) }
function writeEvidence(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }) }
async function live(imageSha) {
  need(imageSha === IMAGE_SHA, 'EXPECTED_IMAGE_REQUIRED')
  need(hash(file(join(ROOT, 'scripts/mysql-ui-acceptance-fixture.mjs'), 256 * 1024)) === FIXTURE_SHA, 'FIXTURE_SOURCE_MISMATCH')
  const status = await fixture(['--status', READY])
  exact(status, ['status','runId','containerId','ownershipVerified','running','healthy','loopbackBindingVerified','serverVersion','manifestSha256','imageSha256','fixtureSourceSha256','ready','guiPassed'], 'STATUS_SCHEMA')
  need(status.status === 'OWNED_SERVICE_LIVE' && status.runId === RUN && status.containerId === CONTAINER
    && status.manifestSha256 === MANIFEST_SHA && status.imageSha256 === imageSha && status.fixtureSourceSha256 === FIXTURE_SHA
    && status.serverVersion === '8.0.46' && status.guiPassed === false
    && ['ownershipVerified','running','healthy','loopbackBindingVerified','ready'].every((key) => status[key] === true), 'SERVICE_NOT_VERIFIED')
  return status
}
function sourceSnapshot() {
  const head = execFileSync('git', ['rev-parse','HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout:10000 }).trim()
  need(/^[a-f0-9]{40}$/.test(head), 'SOURCE_INVALID')
  const files = Object.fromEntries(SOURCES.map((path) => [path, hash(file(join(ROOT, path), 2 * 1024 * 1024))]))
  const diff = execFileSync('git', ['diff','--binary','HEAD','--',...SOURCES], { cwd: ROOT, stdio: ['ignore','pipe','pipe'], timeout:10000, maxBuffer:4*1024*1024 })
  return { head, files, diffSha256:hash(diff), cargoLockSha256:hash(file(join(ROOT,'Cargo.lock'), 4*1024*1024)) }
}
// A final test-build receipt must bind the binary and frontend to the exact reviewed sources.
// The host owner supplies this nonsecret receipt after the final build, not the older task48 artifact.
function artifact(path, expectedSha) {
  need(typeof path === 'string' && hex(expectedSha), 'ARTIFACT_REQUIRED')
  const abs = resolve(path);const artifactRoot=dirname(abs)
  need(path===abs&&basename(abs)==='build-report.json'&&dirname(artifactRoot)===join(ROOT,'backups')
    && /^mysql-acceptance-host-build-[a-f0-9]{32}$/.test(basename(artifactRoot)), 'ARTIFACT_PATH_INVALID')
  const rootInfo=lstatSync(artifactRoot)
  need(rootInfo.isDirectory()&&!rootInfo.isSymbolicLink()&&(rootInfo.mode&0o777)===0o700&&realpathSync(artifactRoot)===artifactRoot,'ARTIFACT_DIRECTORY_INVALID')
  const bytes = file(abs, 256 * 1024, true); need(hash(bytes) === expectedSha, 'ARTIFACT_RECEIPT_MISMATCH')
  const receipt = JSON.parse(bytes.toString('utf8'))
  need(receipt.scope === 'compile-only-debug-mysql-acceptance-host' && receipt.feature === 'mysql-acceptance' && receipt.profile === 'debug'
    && receipt.passed === true && receipt.guiLaunched === false && receipt.mysqlConnected === false && receipt.productionArtifact === false
    && receipt.testHooks === 0 && receipt.mysqlParity === 1 && hex(receipt.binarySha256) && hex(receipt.frontendIndexSha256), 'ARTIFACT_MODE_INVALID')
  verifyStorageReceipt(receipt, basename(artifactRoot).slice('mysql-acceptance-host-build-'.length))
  const current = sourceSnapshot()
  need(receipt.cargoLockSha256 === current.cargoLockSha256, 'ARTIFACT_LOCK_MISMATCH')
  need(receipt.sourceFiles && typeof receipt.sourceFiles === 'object' && !Array.isArray(receipt.sourceFiles)
    && Object.keys(receipt.sourceFiles).length <= 100 && Object.values(receipt.sourceFiles).every(hex), 'ARTIFACT_SOURCE_MISSING')
  exact(receipt.sourceFiles, SOURCES, 'ARTIFACT_SOURCE_SCHEMA')
  need(SOURCES.every((path) => receipt.sourceFiles[path] === current.files[path]), 'ARTIFACT_SOURCE_MISMATCH')
  const entries = Object.entries(receipt.sourceFiles).sort(([a],[b]) => a.localeCompare(b))
  need(receipt.sourceSnapshotSha256 === hash(JSON.stringify(entries)), 'ARTIFACT_SOURCE_SNAPSHOT_MISMATCH')
  const expectedBinary=join(artifactRoot,'target','debug',process.platform==='win32'?'dbstudio-desktop.exe':'dbstudio-desktop')
  need(receipt.binary===expectedBinary, 'BINARY_PATH_INVALID')
  need(hash(file(receipt.binary, 512*1024*1024)) === receipt.binarySha256, 'BINARY_MISMATCH')
  need(receipt.frontendAssets && typeof receipt.frontendAssets === 'object' && !Array.isArray(receipt.frontendAssets)
    && Object.keys(receipt.frontendAssets).length > 1 && Object.keys(receipt.frontendAssets).length <= 200, 'FRONTEND_ASSETS_MISSING')
  need(receipt.evidenceDirectory === dirname(abs), 'ARTIFACT_DIRECTORY_MISMATCH')
  const frontendRoot = join(dirname(abs),'frontend');const discovered=[]
  function walk(relative='',depth=0){
    need(depth<=8&&discovered.length<=200,'FRONTEND_ASSET_LIMIT')
    const directory=join(frontendRoot,relative);need(realpathSync(directory)===directory&&!lstatSync(directory).isSymbolicLink(),'FRONTEND_DIRECTORY_INVALID')
    const children=readdirSync(directory);need(children.length<=200,'FRONTEND_ASSET_LIMIT')
    for(const name of children){need(/^[a-zA-Z0-9_.-]+$/.test(name)&&name!=='.'&&name!=='..','FRONTEND_ASSET_INVALID');const child=relative?`${relative}/${name}`:name;const info=lstatSync(join(frontendRoot,child));need(!info.isSymbolicLink(),'FRONTEND_ASSET_INVALID');if(info.isDirectory())walk(child,depth+1);else{need(info.isFile()&&discovered.length<200,'FRONTEND_ASSET_INVALID');discovered.push(child)}}
  }
  walk();need(discovered.sort().join(',')===Object.keys(receipt.frontendAssets).sort().join(','),'FRONTEND_ASSET_SET_MISMATCH')
  for (const [path,sha] of Object.entries(receipt.frontendAssets)) {
    need(/^[a-zA-Z0-9_.\/-]+$/.test(path) && path.split('/').every((p) => p !== '' && p !== '.' && p !== '..') && hex(sha), 'FRONTEND_ASSET_INVALID')
    need(hash(file(join(frontendRoot,path),32*1024*1024)) === sha, 'FRONTEND_ASSET_MISMATCH')
  }
  need(receipt.frontendAssets['index.html'] === receipt.frontendIndexSha256, 'FRONTEND_INDEX_MISMATCH')
  return { receipt, current, receiptSha256: expectedSha }
}
function verifyUi(value) {
  exact(value, ['schemaVersion','report','observations'], 'HOST_REPORT_SCHEMA')
  need(value.schemaVersion === 1, 'HOST_REPORT_SCHEMA')
  const ui = value.report
  exact(ui, ['schemaVersion','runId','phase','actionDriver','checks','pages','actions','elapsedMs','failureCode'], 'UI_REPORT_SCHEMA')
  need(ui.schemaVersion === 1 && ui.runId === RUN && ui.phase === 'initial' && ui.actionDriver === 'native-dom-synthetic' && ui.failureCode === 'NONE' && integer(ui.elapsedMs), 'UI_NOT_PASSED')
  exact(ui.checks, CHECKS, 'UI_CHECK_SCHEMA'); need(CHECKS.every((key) => ui.checks[key] === true), 'UI_NOT_PASSED')
  exact(ui.actions, ['click','input','keydown'], 'UI_ACTION_SCHEMA')
  need(Object.values(ui.actions).every((n) => integer(n,10000)) && ui.actions.click >= 7 && ui.actions.input >= 9, 'UI_ACTION_MISSING')
  exact(ui.pages, ['first','next','back'], 'UI_PAGE_SCHEMA')
  for (const [name, offset] of [['first',0],['next',200],['back',0]]) {
    const page = ui.pages[name]; exact(page, ['offset','count','firstId','lastId','idsSha256','visibleMs'], 'UI_PAGE_SCHEMA')
    const ids = Array.from({length:200},(_,i) => offset+i+1)
    need(page.offset === offset && page.count === 200 && page.firstId === offset+1 && page.lastId === offset+200 && page.idsSha256 === hash(ids.join(',')) && integer(page.visibleMs), 'UI_PAGE_MISMATCH')
  }
  const n = value.observations
  exact(n, ['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified'], 'NATIVE_SCHEMA')
  need(n.scope === 'test-host-observation-only' && n.runId === RUN && n.phase === 'initial' && n.guiVerified === false && n.mysqlVerified === false && n.storePersistenceVerified === false, 'NATIVE_SCHEMA')
  need(n.methods && typeof n.methods === 'object' && !Array.isArray(n.methods), 'NATIVE_SCHEMA')
  for (const metric of Object.values(n.methods)) { exact(metric,['success','failure','totalElapsedMs'],'NATIVE_METRIC_SCHEMA'); need(Object.values(metric).every((v) => integer(v,100_000_000)), 'NATIVE_METRIC_SCHEMA') }
  for (const [name, count] of [['testConnection',1],['addConnection',1],['executeStatement',2],['fetchResultPage',2]]) need(n.methods[name]?.success >= count && n.methods[name].failure === 0, 'NATIVE_METHOD_MISSING')
  need([n.keyringGets,n.keyringHits,n.keyringSets].every((v) => integer(v,10000)) && n.keyringSets >= 1, 'KEYRING_EVIDENCE_MISSING')
  return {ui,native:n}
}
const RESTART_CHECKS=['storage_marker','persisted_connection','credential_reconnect','sql_select41','table_open','local_edit','dirty_guard_cancel','applied_pending','rollback_restored']
function verifyRestart(value) {
  exact(value,['schemaVersion','report','observations'],'HOST_REPORT_SCHEMA');need(value.schemaVersion===1,'HOST_REPORT_SCHEMA')
  const ui=value.report;exact(ui,['schemaVersion','runId','phase','actionDriver','checks','row','actions','elapsedMs','failureCode'],'RESTART_REPORT_SCHEMA')
  need(ui.schemaVersion===1&&ui.runId===RUN&&ui.phase==='restart'&&ui.actionDriver==='native-dom-synthetic'&&ui.failureCode==='NONE'&&integer(ui.elapsedMs),'RESTART_NOT_PASSED')
  exact(ui.checks,RESTART_CHECKS,'RESTART_CHECK_SCHEMA');need(RESTART_CHECKS.every((k)=>ui.checks[k]===true),'RESTART_NOT_PASSED')
  exact(ui.actions,['click','input','keydown','dblclick'],'RESTART_ACTION_SCHEMA');need(Object.values(ui.actions).every((v)=>integer(v,10000))&&ui.actions.click>=10&&ui.actions.input===2&&ui.actions.dblclick===2,'RESTART_ACTION_MISSING')
  exact(ui.row,['id','beforeSha256','localSha256','appliedSha256','rolledBackSha256'],'RESTART_ROW_SCHEMA')
  const before=hash('样本-0000001'),local=hash(`界面回滚验收-${RUN}`)
  need(ui.row.id===1&&ui.row.beforeSha256===before&&ui.row.localSha256===local&&ui.row.appliedSha256===local&&ui.row.rolledBackSha256===before,'RESTART_ROW_MISMATCH')
  const n=value.observations
  exact(n,['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified'],'NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='restart'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false,'NATIVE_SCHEMA')
  need(n.methods&&typeof n.methods==='object'&&!Array.isArray(n.methods),'NATIVE_SCHEMA')
  for(const metric of Object.values(n.methods)){exact(metric,['success','failure','totalElapsedMs'],'NATIVE_METRIC_SCHEMA');need(Object.values(metric).every((v)=>integer(v,100_000_000)),'NATIVE_METRIC_SCHEMA')}
  for(const name of ['connectConnection','executeStatement','describeTable','tableSelectSql','runQuery','applyEdits','rollbackTransaction'])need(n.methods[name]?.success>=1&&n.methods[name].failure===0,'RESTART_NATIVE_MISSING')
  for(const name of ['testConnection','addConnection','updateConnection'])need(!n.methods[name]||(n.methods[name].success===0&&n.methods[name].failure===0),'RESTART_CREDENTIAL_WRITE')
  need([n.keyringGets,n.keyringHits,n.keyringSets].every((v)=>integer(v,10000))&&n.keyringSets===0&&n.keyringHits>=1&&n.keyringGets>=1,'RESTART_KEYRING_MISSING')
  return {ui,native:n}
}
function privateDirectory(path) {const info=lstatSync(path);need(info.isDirectory()&&!info.isSymbolicLink()&&(info.mode&0o777)===0o700&&realpathSync(path)===path,'HOST_DIRECTORY_INVALID')}
function absent(path){try{lstatSync(path);return false}catch(e){if(e.code==='ENOENT')return true;throw new RunFailure('PATH_INSPECTION_FAILED')}}
function restartPreflight(hostRoot, probe = false, checked) {
  privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
  const manifest=jsonFile(join(hostRoot,'host-manifest.json'),16*1024)
  exact(manifest,['schemaVersion','runId','storeId','keyringNamespace','fixtureManifest'],'HOST_MANIFEST_SCHEMA')
  const storeId=Array.from(Buffer.from(RUN,'hex'))
  need(manifest.schemaVersion===1&&manifest.runId===RUN&&JSON.stringify(manifest.storeId)===JSON.stringify(storeId)
    &&manifest.keyringNamespace===`io.dbstudio.acceptance.mysql.${RUN}`&&manifest.fixtureManifest===READY,'HOST_STORE_MISMATCH')
  // Only the fixed nonsecret host manifest and public acceptance reports are read. No vault/fixture manifest reads.
  const initialPath=join(hostRoot,'evidence','real-ui-report.json');const initialBytes=file(initialPath,256*1024,true);const initial=JSON.parse(initialBytes.toString('utf8'))
  need(initial.schemaVersion===1&&initial.scope==='mysql-initial-real-ui-chain'&&initial.runId===RUN&&initial.phase==='initial'&&initial.chainPassed===true&&initial.productionReady===false
    &&initial.provenance?.manifestSha256===MANIFEST_SHA&&initial.provenance?.containerId===CONTAINER&&initial.provenance?.imageSha256===IMAGE_SHA,'INITIAL_PROOF_REQUIRED')
  if(pin){
    need(checked&&initial.provenance.binarySha256===checked.receipt.binarySha256
      &&initial.provenance.frontendIndexSha256===checked.receipt.frontendIndexSha256
      &&initial.provenance.frontendAssetsSha256===hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b))))
      &&initial.provenance.artifactReceiptSha256===checked.receiptSha256
      &&initial.provenance.fixturePinSha256===pin.pinSha256
      &&initial.provenance.runnerSourceSha256===RUNNER_SHA, 'PAIR_ARTIFACT_MISMATCH')
  }
  const initialUi=join(hostRoot,'evidence','ui-initial.json');const initialUiBytes=file(initialUi,256*1024,true);verifyUi(JSON.parse(initialUiBytes.toString('utf8')))
  if (!probe) need(absent(join(hostRoot,'evidence','ui-restart.json'))&&absent(join(hostRoot,'evidence','real-ui-restart-report.json')),'RESTART_REPORT_ALREADY_EXISTS')
  return {hostManifestSha256:hash(file(join(hostRoot,'host-manifest.json'),16*1024,true)),initialReportSha256:hash(initialBytes),initialUiSha256:hash(initialUiBytes)}
}
function verifyRollbackObserver(o){
  exact(o,['status','runId','counts','baselineBodyRows','firstBodySha256','autocommit','readOnly','guiPassed'],'ROLLBACK_OBSERVER_SCHEMA');exact(o.counts,['paging'],'ROLLBACK_OBSERVER_SCHEMA')
  need(o.status==='ROLLBACK_BASELINE_VERIFIED'&&o.runId===RUN&&o.counts.paging===805&&o.baselineBodyRows===805&&o.firstBodySha256===hash('样本-0000001')&&o.autocommit===true&&o.readOnly===true&&o.guiPassed===false,'ROLLBACK_OBSERVER_MISMATCH')
}
function verifyObserver(o) {
  exact(o,['status','runId','counts','autocommit','readOnly','precisionChecks','pagingChecks','independentConnections','guiPassed'],'OBSERVER_SCHEMA')
  exact(o.counts,['paging','precision','composite','import'],'OBSERVER_SCHEMA')
  need(o.status === 'OBSERVER_READBACK_OK' && o.runId === RUN && o.counts.paging === 805 && o.counts.precision === 1 && o.counts.composite === 2 && o.counts.import === 0 && o.autocommit === true && o.readOnly === true && o.precisionChecks === 11 && o.pagingChecks === 9 && o.independentConnections === 3 && o.guiPassed === false, 'OBSERVER_MISMATCH')
}
async function runChild(binary, hostRoot, phase = 'initial', progressHook = null) {
  // Retain normal OS environment (including HOME), but remove every legacy test/secret alias.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/DBSTUDIO|VITE_|MYSQL|PASSWORD|SECRET|TOKEN|DATABASE_URL/i.test(key)))
  Object.assign(env, {DBSTUDIO_MYSQL_ACCEPTANCE_ROOT:hostRoot,DBSTUDIO_MYSQL_ACCEPTANCE_RUN_ID:RUN,DBSTUDIO_MYSQL_ACCEPTANCE_PHASE:phase,DBSTUDIO_MYSQL_ACCEPTANCE_MANIFEST:READY})
  return await new Promise((resolveResult,reject) => {
    const child=spawn(binary,[],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']}); let stdoutBytes=0,stderrBytes=0,timedOut=false
    child.stdout.on('data',(b)=>{stdoutBytes+=b.length});child.stderr.on('data',(b)=>{stderrBytes+=b.length})
    let closed=false
    const progressStop=progressHook?new AbortController():null
    const deadline=Date.now()+(phase==='grid-timeout'||phase==='grid-time-crosszone'?120000:['commit','grid-deadlock','grid-duplicate','grid-precision','grid-text','session-timezone','grid-time'].includes(phase)?90000:phase==='restart-probe'?30000:['restart-attempt','explain'].includes(phase)?60000:180000)
    const alive=()=>{if(closed||timedOut||Date.now()>=deadline||child.exitCode!==null||child.signalCode!==null)return false;try{process.kill(child.pid,0);return true}catch{return false}}
    const progress=progressHook?Promise.resolve().then(()=>progressHook(child,alive,progressStop.signal)).catch(()=>({steps:[],failureCode:'WATCHER_FAILED'})):null
    const timeoutMs=phase==='grid-timeout'||phase==='grid-time-crosszone'?120000:['commit','grid-deadlock','grid-duplicate','grid-precision','grid-text','session-timezone','grid-time'].includes(phase)?90000:phase==='restart-probe'?30000:['restart-attempt','explain'].includes(phase)?60000:180000
    const timer=setTimeout(()=>{timedOut=true;progressStop?.abort();child.kill('SIGTERM')},timeoutMs)
    const force=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL')},timeoutMs+5000)
    child.once('error',()=>{progressStop?.abort();clearTimeout(timer);clearTimeout(force);reject(new RunFailure('CHILD_START_FAILED'))})
    child.once('close',async(code)=>{closed=true;progressStop?.abort();clearTimeout(timer);clearTimeout(force);const watched=progress?await progress:null;resolveResult({...(['restart-probe','restart-attempt','explain','commit','grid-deadlock','grid-duplicate','grid-timeout','grid-precision','grid-text','session-timezone','grid-time','grid-time-crosszone','grid-bit-blob'].includes(phase)?{pid:child.pid}:{}),...(progress?{progress:watched}:{}),exitCode:code,stdoutBytes,stderrBytes,timedOut})})
  })
}
async function runRestart(checked,status,hostRoot,imageSha){
  const prior=restartPreflight(hostRoot,false,checked)
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'restart')
  let finalObserverVerified=false
  try {
    await live(imageSha)
    const observation=await fixture(['--observe',READY]);verifyObserver(observation)
    const rollback=await fixture(['--observe-rollback',READY]);verifyRollbackObserver(rollback);finalObserverVerified=true
    need(!lifecycle.timedOut&&lifecycle.exitCode===0,'RESTART_CHILD_NOT_PASSED')
    privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
    const verified=verifyRestart(jsonFile(join(hostRoot,'evidence','ui-restart.json')))
    need(hash(file(join(hostRoot,'host-manifest.json'),16*1024,true))===prior.hostManifestSha256
      &&hash(file(join(hostRoot,'evidence','real-ui-report.json'),256*1024,true))===prior.initialReportSha256
      &&hash(file(join(hostRoot,'evidence','ui-initial.json'),256*1024,true))===prior.initialUiSha256,'INITIAL_MATERIAL_CHANGED')
    need(JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'SOURCE_CHANGED_DURING_RUN')
    const report={schemaVersion:1,scope:'mysql-restart-edit-real-ui-chain',runId:RUN,phase:'restart',actionDriver:'native-dom-synthetic',chainPassed:true,productionReady:false,
      credentialRestartVerified:true,rollbackVerified:true,preCommitObserverVisibilityVerified:false,commitVerified:false,osTrustedKeyboardVerified:false,soakVerified:false,referenceProductOperated:false,mysql84Verified:false,windowsVerified:false,
      checks:verified.ui.checks,row:verified.ui.row,actions:verified.ui.actions,elapsedMs:verified.ui.elapsedMs,native:verified.native,lifecycle,
      observer:{counts:observation.counts,autocommit:true,readOnly:true,precisionChecks:11,pagingChecks:9,independentConnections:3},rollbackObserver:rollback,
      provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,
        binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}}
    writeEvidence(join(hostRoot,'evidence','real-ui-restart-report.json'),report)
    return {status:'RESTART_CHAIN_VERIFIED',runId:RUN,chainPassed:true,productionReady:false,stdoutBytes:lifecycle.stdoutBytes,stderrBytes:lifecycle.stderrBytes}
  }catch{
    try{privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'));writeEvidence(join(hostRoot,'evidence','real-ui-restart-report.json'),{schemaVersion:1,scope:'mysql-restart-edit-real-ui-chain',runId:RUN,phase:'restart',chainPassed:false,productionReady:false,failureCode:'JOINT_VALIDATION_FAILED',finalObserverVerified,lifecycle})}catch{/* Keep every existing file. Never reset a used restart attempt. */}
    throw new RunFailure('JOINT_VALIDATION_FAILED')
  }
}
const FRONTEND_TRACE=['main_enter','preflight_passed','app_import_enter','app_import_passed','app_mount_enter','app_mounted','listener_enter','listener_passed','boot_enter','boot_passed','dom_enter','main_failed','mounted_failed']
const NATIVE_TRACE=['native_enter','native_returned','native_failed']
const KEYRING_TRACE=['keyring_get_enter','keyring_get_returned','keyring_get_failed']
function startupTrace(path){
  const bytes=file(path,32*1024,true);const lines=bytes.toString('utf8').trimEnd().split('\n')
  need(lines.length>=1&&lines.length<=128,'STARTUP_TRACE_LIMIT')
  const records=lines.map((line,index)=>{
    const r=JSON.parse(line);exact(r,['schemaVersion','seq','stage','method'],'STARTUP_TRACE_SCHEMA')
    need(r.schemaVersion===1&&r.seq===index+1&&(FRONTEND_TRACE.includes(r.stage)||NATIVE_TRACE.includes(r.stage)||KEYRING_TRACE.includes(r.stage)),'STARTUP_TRACE_SCHEMA')
    need((FRONTEND_TRACE.includes(r.stage)||KEYRING_TRACE.includes(r.stage))?r.method==='none':['listDialects','listConnections','migrationStatus','other'].includes(r.method),'STARTUP_TRACE_SCHEMA')
    return r
  });return {records,sha256:hash(bytes)}
}
function attemptMaterials(hostRoot,prior,failed){
  return hash(file(join(hostRoot,'host-manifest.json'),16*1024,true))===prior.hostManifestSha256
    &&hash(file(join(hostRoot,'evidence','real-ui-report.json'),256*1024,true))===prior.initialReportSha256
    &&hash(file(join(hostRoot,'evidence','ui-initial.json'),256*1024,true))===prior.initialUiSha256
    &&(failed===null?absent(join(hostRoot,'evidence','real-ui-restart-report.json')):hash(file(join(hostRoot,'evidence','real-ui-restart-report.json'),256*1024,true))===failed)
}
async function runRestartAttempt(checked,status,hostRoot,imageSha){
  const prior=restartPreflight(hostRoot,true,checked)
  const failedPath=join(hostRoot,'evidence','real-ui-restart-report.json')
  const failedSha=absent(failedPath)?null:hash(file(failedPath,256*1024,true))
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'restart-attempt')
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'ATTEMPT_CHILD_PID_INVALID')
  const evidence=join(hostRoot,'evidence'),output=join(evidence,`real-ui-restart-${lifecycle.pid}.json`)
  let trace=null,observation=null,rollback=null,finalObserverVerified=false,materialsPreserved=false
  try{
    privateDirectory(hostRoot);privateDirectory(evidence)
    await live(imageSha)
    // Always request both fresh readbacks, even when the child timed out or produced no UI report.
    const readbacks=await Promise.allSettled([fixture(['--observe',READY]),fixture(['--observe-rollback',READY])])
    if(readbacks[0].status==='fulfilled'){verifyObserver(readbacks[0].value);observation=readbacks[0].value}
    if(readbacks[1].status==='fulfilled'){verifyRollbackObserver(readbacks[1].value);rollback=readbacks[1].value}
    finalObserverVerified=observation!==null&&rollback!==null
    materialsPreserved=attemptMaterials(hostRoot,prior,failedSha)
    trace=startupTrace(join(evidence,`startup-trace-${lifecycle.pid}.jsonl`))
    need(finalObserverVerified&&materialsPreserved,'ATTEMPT_FINAL_STATE_UNVERIFIED')
    need(!lifecycle.timedOut&&lifecycle.exitCode===0,'RESTART_ATTEMPT_CHILD_FAILED')
    const verified=verifyRestart(jsonFile(join(evidence,`ui-restart-${lifecycle.pid}.json`)))
    need(JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'SOURCE_CHANGED_DURING_RUN')
    const report={schemaVersion:1,scope:'mysql-restart-edit-real-ui-attempt',runId:RUN,phase:'restart',actionDriver:'native-dom-synthetic',chainPassed:true,productionReady:false,
      credentialRestartVerified:true,rollbackVerified:true,preCommitObserverVisibilityVerified:false,commitVerified:false,osTrustedKeyboardVerified:false,soakVerified:false,referenceProductOperated:false,mysql84Verified:false,windowsVerified:false,
      checks:verified.ui.checks,row:verified.ui.row,actions:verified.ui.actions,elapsedMs:verified.ui.elapsedMs,native:verified.native,lifecycle,trace,observer:observation,rollbackObserver:rollback,
      provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,failedRestartSha256:failedSha,
        binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}}
    writeEvidence(output,report)
    return {status:'RESTART_ATTEMPT_CHAIN_VERIFIED',runId:RUN,chainPassed:true,productionReady:false,lifecycle,trace}
  }catch{
    try{privateDirectory(hostRoot);privateDirectory(evidence);materialsPreserved=attemptMaterials(hostRoot,prior,failedSha);writeEvidence(output,{schemaVersion:1,scope:'mysql-restart-edit-real-ui-attempt',runId:RUN,phase:'restart',chainPassed:false,productionReady:false,failureCode:'JOINT_VALIDATION_FAILED',finalObserverVerified,materialsPreserved,failedRestartSha256:failedSha,lifecycle,trace})}catch{/* Retain all existing failed attempt and initial files. */}
    return {status:'RESTART_ATTEMPT_FAILED',runId:RUN,chainPassed:false,productionReady:false,finalObserverVerified,materialsPreserved,lifecycle,trace}
  }
}
const EXPLAIN_CHECKS=['storage_marker','persisted_connection','credential_reconnect','query_result','explain_open','plan_content','plan_refresh','return_results','nontransactional']
const EXPLAIN_COLUMNS=['id','select_type','table','partitions','type','possible_keys','key','key_len','ref','rows','filtered','Extra']
function explainSql(){return `SELECT id,body FROM \`mysql_accept_${RUN.slice(0,16)}\`.\`items_805\` WHERE id=1`}
function verifyExplain(value){
  exact(value,['schemaVersion','report','observations'],'HOST_REPORT_SCHEMA');need(value.schemaVersion===1,'HOST_REPORT_SCHEMA')
  const ui=value.report;exact(ui,['schemaVersion','runId','phase','actionDriver','checks','plan','actions','elapsedMs','failureCode'],'EXPLAIN_REPORT_SCHEMA')
  need(ui.schemaVersion===1&&ui.runId===RUN&&ui.phase==='explain'&&ui.actionDriver==='native-dom-synthetic'&&ui.failureCode==='NONE'&&integer(ui.elapsedMs),'EXPLAIN_NOT_PASSED')
  exact(ui.checks,EXPLAIN_CHECKS,'EXPLAIN_CHECK_SCHEMA');need(EXPLAIN_CHECKS.every((k)=>ui.checks[k]===true),'EXPLAIN_NOT_PASSED')
  exact(ui.actions,['click','input','keydown'],'EXPLAIN_ACTION_SCHEMA')
  need(Object.values(ui.actions).every((v)=>integer(v,10000))&&ui.actions.click>=5&&ui.actions.input>=1&&ui.actions.keydown===0,'EXPLAIN_ACTION_MISSING')
  exact(ui.plan,['rowCount','columnCount','firstPlanSha256','refreshedPlanSha256','executedSqlSha256'],'EXPLAIN_PLAN_SCHEMA')
  need(ui.plan.rowCount===1&&ui.plan.columnCount===12&&hex(ui.plan.firstPlanSha256)&&ui.plan.firstPlanSha256===ui.plan.refreshedPlanSha256
    &&ui.plan.executedSqlSha256===hash(`EXPLAIN ${explainSql()}`),'EXPLAIN_PLAN_MISMATCH')
  const n=value.observations
  exact(n,['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified'],'NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='explain'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false,'NATIVE_SCHEMA')
  need(n.methods&&typeof n.methods==='object'&&!Array.isArray(n.methods),'NATIVE_SCHEMA')
  for(const metric of Object.values(n.methods)){exact(metric,['success','failure','totalElapsedMs'],'NATIVE_METRIC_SCHEMA');need(Object.values(metric).every((v)=>integer(v,100_000_000)),'NATIVE_METRIC_SCHEMA')}
  for(const name of ['connectConnection','executeStatement'])need(n.methods[name]?.success>=1&&n.methods[name].failure===0,'EXPLAIN_NATIVE_MISSING')
  need(n.methods.explain?.success===2&&n.methods.explain.failure===0,'EXPLAIN_NATIVE_COUNT')
  for(const name of ['testConnection','addConnection','updateConnection','applyEdits','insertRow','deleteRows','commitTransaction'])need(!n.methods[name]||(n.methods[name].success===0&&n.methods[name].failure===0),'EXPLAIN_UNEXPECTED_WRITE')
  need([n.keyringGets,n.keyringHits,n.keyringSets].every((v)=>integer(v,10000))&&n.keyringSets===0&&n.keyringHits>=1&&n.keyringGets>=1,'EXPLAIN_KEYRING_MISSING')
  return {ui,native:n}
}
async function explainReference(imageSha){
  await live(imageSha)
  const query=`SET SESSION autocommit=1; SET SESSION TRANSACTION READ ONLY; SELECT @@session.autocommit AS observer_autocommit,@@session.transaction_read_only AS observer_read_only; EXPLAIN ${explainSql()}`
  let bytes
  try{bytes=execFileSync('docker',['exec','--user','0:0',CONTAINER,'mysql','--defaults-extra-file=/fixture/observer-client.cnf','--connect-timeout=5','--batch','--raw','--column-names','--execute',query],{cwd:ROOT,stdio:['ignore','pipe','pipe'],timeout:15000,maxBuffer:64*1024})}
  catch{throw new RunFailure('EXPLAIN_REFERENCE_FAILED')}
  need(bytes.length<=16*1024,'EXPLAIN_REFERENCE_LIMIT')
  const text=bytes.toString('utf8');need(!text.includes('\r')&&!text.includes('\u0000'),'EXPLAIN_REFERENCE_FORMAT')
  const lines=text.endsWith('\n')?text.slice(0,-1).split('\n'):text.split('\n')
  need(lines.length===4&&lines[0]==='observer_autocommit\tobserver_read_only'&&lines[1]==='1\t1','EXPLAIN_REFERENCE_SESSION')
  const columns=lines[2].split('\t'),row=lines[3].split('\t')
  need(columns.length===12&&columns.every((name,i)=>name===EXPLAIN_COLUMNS[i])&&row.length===12,'EXPLAIN_REFERENCE_FORMAT')
  for(const index of [0,9,10]){need(/^[0-9]+(?:\.[0-9]+)?$/.test(row[index])&&Number.isFinite(Number(row[index])),'EXPLAIN_REFERENCE_NUMBER');row[index]=String(Number(row[index]))}
  const rows=[row]
  return {columns,rows,planSha256:hash(JSON.stringify({columns,rows})),executedSqlSha256:hash(`EXPLAIN ${explainSql()}`),autocommit:true,readOnly:true}
}
async function runExplain(checked,status,hostRoot,imageSha){
  need(pin,'EXPLAIN_FIXTURE_PIN_REQUIRED')
  const prior=restartPreflight(hostRoot,true,checked)
  const failedPath=join(hostRoot,'evidence','real-ui-restart-report.json'),failedSha=absent(failedPath)?null:hash(file(failedPath,256*1024,true))
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'explain')
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'EXPLAIN_CHILD_PID_INVALID')
  const evidence=join(hostRoot,'evidence'),output=join(evidence,`real-ui-explain-${lifecycle.pid}.json`)
  let trace=null,observation=null,reference=null,finalObserverVerified=false,materialsPreserved=false
  try{
    privateDirectory(hostRoot);privateDirectory(evidence)
    await live(imageSha)
    const readbacks=await Promise.allSettled([fixture(['--observe',READY]),explainReference(imageSha)])
    if(readbacks[0].status==='fulfilled'){verifyObserver(readbacks[0].value);observation=readbacks[0].value;finalObserverVerified=true}
    if(readbacks[1].status==='fulfilled')reference=readbacks[1].value
    materialsPreserved=attemptMaterials(hostRoot,prior,failedSha)
    trace=startupTrace(join(evidence,`startup-trace-${lifecycle.pid}.jsonl`))
    need(finalObserverVerified&&reference!==null&&materialsPreserved,'EXPLAIN_FINAL_STATE_UNVERIFIED')
    need(!lifecycle.timedOut&&lifecycle.exitCode===0,'EXPLAIN_CHILD_FAILED')
    const verified=verifyExplain(jsonFile(join(evidence,`ui-explain-${lifecycle.pid}.json`),16*1024))
    need(verified.ui.plan.firstPlanSha256===reference.planSha256&&verified.ui.plan.refreshedPlanSha256===reference.planSha256&&verified.ui.plan.executedSqlSha256===reference.executedSqlSha256,'EXPLAIN_REFERENCE_MISMATCH')
    need(JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'SOURCE_CHANGED_DURING_RUN')
    const report={schemaVersion:1,scope:'mysql-explain-real-ui-chain',runId:RUN,phase:'explain',actionDriver:'native-dom-synthetic',chainPassed:true,productionReady:false,
      explainPanelVerified:true,independentReferenceVerified:true,commitVerified:false,preCommitObserverVisibilityVerified:false,osTrustedKeyboardVerified:false,soakVerified:false,referenceProductOperated:false,mysql84Verified:false,windowsVerified:false,
      checks:verified.ui.checks,plan:verified.ui.plan,actions:verified.ui.actions,elapsedMs:verified.ui.elapsedMs,native:verified.native,lifecycle,trace,observer:observation,reference,
      provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,failedRestartSha256:failedSha,
        binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}}
    writeEvidence(output,report)
    return {status:'EXPLAIN_CHAIN_VERIFIED',runId:RUN,chainPassed:true,productionReady:false,lifecycle}
  }catch{
    try{privateDirectory(hostRoot);privateDirectory(evidence);materialsPreserved=attemptMaterials(hostRoot,prior,failedSha);writeEvidence(output,{schemaVersion:1,scope:'mysql-explain-real-ui-chain',runId:RUN,phase:'explain',chainPassed:false,productionReady:false,failureCode:'JOINT_VALIDATION_FAILED',finalObserverVerified,materialsPreserved,failedRestartSha256:failedSha,lifecycle,trace})}catch{/* Keep every prior initial, restart, and explain evidence file. */}
    return {status:'EXPLAIN_CHAIN_FAILED',runId:RUN,chainPassed:false,productionReady:false,finalObserverVerified,materialsPreserved,lifecycle,trace}
  }
}
const COMMIT_STEPS=['baseline','pending','committed']
const COMMIT_CHECKS=['storage_marker','persisted_connection','credential_reconnect','table_created','baseline_committed','baseline_observed','pending_visible','pending_isolated','commit_clicked','result_refreshed','committed_observed','nontransactional']
function commitNative(n,execCount,commitCount){
  exact(n,['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified'],'COMMIT_NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='commit'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false,'COMMIT_NATIVE_SCHEMA')
  need(n.methods&&typeof n.methods==='object'&&!Array.isArray(n.methods),'COMMIT_NATIVE_SCHEMA')
  for(const metric of Object.values(n.methods)){exact(metric,['success','failure','totalElapsedMs'],'COMMIT_NATIVE_SCHEMA');need(Object.values(metric).every((v)=>integer(v,100_000_000)),'COMMIT_NATIVE_SCHEMA')}
  need(n.methods.connectConnection?.success>=1&&n.methods.connectConnection.failure===0,'COMMIT_CONNECTION_MISSING')
  for(const [name,count]of [['executeStatement',execCount],['commitTransaction',commitCount]])need(n.methods[name]?.success===count&&n.methods[name].failure===0,'COMMIT_NATIVE_COUNT')
  for(const name of ['rollbackTransaction','applyEdits','testConnection','addConnection','updateConnection','insertRow','deleteRows'])need(!n.methods[name]||(n.methods[name].success===0&&n.methods[name].failure===0),'COMMIT_UNEXPECTED_METHOD')
  need([n.keyringGets,n.keyringHits,n.keyringSets].every((v)=>integer(v,10000))&&n.keyringSets===0&&n.keyringGets>=1&&n.keyringHits>=1,'COMMIT_KEYRING_MISSING')
}
function verifyCommit(value){
  exact(value,['schemaVersion','report','observations'],'HOST_REPORT_SCHEMA');need(value.schemaVersion===1,'HOST_REPORT_SCHEMA')
  const ui=value.report;exact(ui,['schemaVersion','runId','phase','actionDriver','checks','row','actions','elapsedMs','failureCode'],'COMMIT_REPORT_SCHEMA')
  need(ui.schemaVersion===1&&ui.runId===RUN&&ui.phase==='commit'&&ui.actionDriver==='native-dom-synthetic'&&ui.failureCode==='NONE'&&integer(ui.elapsedMs),'COMMIT_NOT_PASSED')
  exact(ui.checks,COMMIT_CHECKS,'COMMIT_CHECK_SCHEMA');need(COMMIT_CHECKS.every((k)=>ui.checks[k]===true),'COMMIT_NOT_PASSED')
  exact(ui.actions,['click','input','keydown'],'COMMIT_ACTION_SCHEMA');need(Object.values(ui.actions).every((v)=>integer(v,10000))&&ui.actions.click>=8&&ui.actions.input===5&&ui.actions.keydown===0,'COMMIT_ACTION_MISSING')
  exact(ui.row,['id','baselineSha256','pendingSha256','committedSha256'],'COMMIT_ROW_SCHEMA')
  need(ui.row.id===1&&ui.row.baselineSha256===hash(`baseline-${RUN}`)&&ui.row.pendingSha256===hash(`committed-${RUN}`)&&ui.row.committedSha256===ui.row.pendingSha256&&ui.row.baselineSha256!==ui.row.pendingSha256,'COMMIT_ROW_MISMATCH')
  commitNative(value.observations,5,2);return {ui,native:value.observations}
}
async function commitLive(imageSha,signal){
  need(imageSha===IMAGE_SHA&&hash(file(join(ROOT,'scripts/mysql-ui-acceptance-fixture.mjs'),256*1024))===FIXTURE_SHA,'COMMIT_FIXTURE_SOURCE_MISMATCH')
  const text=await new Promise((resolveText,reject)=>{
    execFile(process.execPath,[join(ROOT,'scripts/mysql-ui-acceptance-fixture.mjs'),'--status',READY],{cwd:ROOT,encoding:'utf8',timeout:15000,maxBuffer:16*1024,signal},(error,stdout)=>{if(error)reject(new RunFailure('COMMIT_LIVE_FAILED'));else resolveText(stdout)})
  })
  need(Buffer.byteLength(text)<=4096,'COMMIT_LIVE_FORMAT');const status=JSON.parse(text)
  exact(status,['status','runId','containerId','ownershipVerified','running','healthy','loopbackBindingVerified','serverVersion','manifestSha256','imageSha256','fixtureSourceSha256','ready','guiPassed'],'COMMIT_LIVE_SCHEMA')
  need(status.status==='OWNED_SERVICE_LIVE'&&status.runId===RUN&&status.containerId===CONTAINER&&status.manifestSha256===MANIFEST_SHA&&status.imageSha256===IMAGE_SHA&&status.fixtureSourceSha256===FIXTURE_SHA
    &&status.serverVersion==='8.0.46'&&status.guiPassed===false&&['ownershipVerified','running','healthy','loopbackBindingVerified','ready'].every((k)=>status[k]===true),'COMMIT_LIVE_MISMATCH')
}
async function commitReference(imageSha,signal){
  need(!signal?.aborted,'COMMIT_OBSERVATION_STOPPED');await commitLive(imageSha,signal);need(!signal?.aborted,'COMMIT_OBSERVATION_STOPPED')
  const table=`\`mysql_accept_${RUN.slice(0,16)}\`.\`ui_tx_${RUN}\``
  const sql=`SET SESSION autocommit=1; SET SESSION TRANSACTION READ ONLY; SELECT @@session.autocommit AS observer_autocommit,@@session.transaction_read_only AS observer_read_only; SELECT COUNT(*) AS row_count,COALESCE(MIN(id),0) AS first_id,COALESCE(MAX(id),0) AS last_id,COALESCE(MIN(LOWER(SHA2(body,256))),'') AS body_sha FROM ${table}`
  const text=await new Promise((resolveText,reject)=>{
    execFile('docker',['exec','--user','0:0',CONTAINER,'mysql','--defaults-extra-file=/fixture/observer-client.cnf','--connect-timeout=5','--batch','--raw','--column-names','--execute',sql],{cwd:ROOT,encoding:'utf8',timeout:15000,maxBuffer:16*1024,signal},(error,stdout)=>{if(error)reject(new RunFailure('COMMIT_REFERENCE_FAILED'));else resolveText(stdout)})
  })
  need(Buffer.byteLength(text)<=4096&&!text.includes('\r')&&!text.includes('\u0000'),'COMMIT_REFERENCE_FORMAT')
  const lines=(text.endsWith('\n')?text.slice(0,-1):text).split('\n')
  need(lines.length===4&&lines[0]==='observer_autocommit\tobserver_read_only'&&lines[1]==='1\t1'&&lines[2]==='row_count\tfirst_id\tlast_id\tbody_sha','COMMIT_REFERENCE_SESSION')
  const fields=lines[3].split('\t')
  need(fields.length===4&&fields[0]==='1'&&fields[1]==='1'&&fields[2]==='1'&&hex(fields[3]),'COMMIT_REFERENCE_ROW')
  return {rowCount:1,firstId:1,lastId:1,bodySha256:fields[3],autocommit:true,readOnly:true}
}
function commitOwner(path){const info=lstatSync(path);need(typeof process.getuid!=='function'||info.uid===process.getuid(),'COMMIT_OWNER_MISMATCH')}
function publishCommitAck(hostRoot,pid,step,bodySha256,verified,alive){
  need(integer(pid,2_147_483_647)&&pid>0&&COMMIT_STEPS.includes(step)&&hex(bodySha256)&&typeof verified==='boolean','COMMIT_ACK_SCHEMA')
  const evidence=join(hostRoot,'evidence'),target=join(evidence,`commit-ack-${pid}-${step}.json`),source=`${target}.pending`
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(hostRoot);commitOwner(evidence)
  need(resolve(source)===source&&resolve(target)===target&&dirname(source)===evidence&&dirname(target)===evidence&&absent(target)&&alive(),'COMMIT_ACK_PATH_INVALID')
  const ack={schemaVersion:1,runId:RUN,phase:'commit',pid,step,bodySha256,verified},bytes=Buffer.from(`${JSON.stringify(ack)}\n`)
  const handle=openSync(source,'wx',0o600);let owned
  try{let offset=0;while(offset<bytes.length){const written=writeSync(handle,bytes,offset,bytes.length-offset);need(written>0,'COMMIT_ACK_WRITE');offset+=written}fsyncSync(handle);owned=fstatSync(handle);need(owned.isFile()&&owned.nlink===1&&(owned.mode&0o777)===0o600&&owned.size===bytes.length,'COMMIT_ACK_FILE_INVALID')}
  finally{closeSync(handle)}
  privateDirectory(hostRoot);privateDirectory(evidence)
  const actual=lstatSync(source);commitOwner(hostRoot);commitOwner(evidence);commitOwner(source)
  need(actual.isFile()&&!actual.isSymbolicLink()&&actual.nlink===1&&(actual.mode&0o777)===0o600&&actual.dev===owned.dev&&actual.ino===owned.ino&&realpathSync(source)===source
    &&resolve(source)===join(evidence,`commit-ack-${pid}-${step}.json.pending`)&&resolve(target)===join(evidence,`commit-ack-${pid}-${step}.json`)&&absent(target)&&alive(),'COMMIT_ACK_FILE_INVALID')
  // Both absolute paths were checked above; this single owned writer publishes only its own pending file.
  renameSync(source,target)
  return ack
}
async function commitPause(signal){
  if(signal.aborted)return
  await new Promise((done)=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);done()};const timer=setTimeout(finish,60);signal.addEventListener('abort',finish,{once:true});if(signal.aborted)finish()})
}
async function watchCommit(child,alive,signal,hostRoot,imageSha){
  const steps=[];const pid=child.pid
  try{
    need(integer(pid,2_147_483_647)&&pid>0,'COMMIT_CHILD_PID_INVALID')
    for(const step of COMMIT_STEPS){
      const path=join(hostRoot,'evidence',`commit-checkpoint-${pid}-${step}.json`)
      while(absent(path)){need(alive()&&!signal.aborted,'COMMIT_WATCH_STOPPED');await commitPause(signal)}
      need(alive()&&!signal.aborted,'COMMIT_WATCH_STOPPED');privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
      const checkpoint=jsonFile(path,16*1024)
      exact(checkpoint,['schemaVersion','runId','phase','pid','step','bodySha256','active','pendingAffected','observations'],'COMMIT_CHECKPOINT_SCHEMA')
      const expected=hash(`${step==='baseline'?'baseline':'committed'}-${RUN}`)
      need(checkpoint.schemaVersion===1&&checkpoint.runId===RUN&&checkpoint.phase==='commit'&&checkpoint.pid===pid&&checkpoint.step===step&&checkpoint.bodySha256===expected
        &&checkpoint.active===(step==='pending')&&checkpoint.pendingAffected===(step==='pending'?1:0),'COMMIT_CHECKPOINT_MISMATCH')
      commitNative(checkpoint.observations,step==='baseline'?3:5,step==='committed'?2:1)
      const record={step,checkpointSha256:hash(file(path,16*1024,true)),checkpoint,reference:null,ack:null};steps.push(record)
      let verified=false
      try{record.reference=await commitReference(imageSha,signal);verified=record.reference.bodySha256===hash(`${step==='committed'?'committed':'baseline'}-${RUN}`)}catch{/* A failed reference may publish only a negative ack while this child is still alive. */}
      await new Promise((done)=>setImmediate(done))
      need(alive()&&!signal.aborted,'COMMIT_WATCH_STOPPED')
      record.ack=publishCommitAck(hostRoot,pid,step,checkpoint.bodySha256,verified,alive)
      if(!verified)return {steps,failureCode:'COMMIT_OBSERVATION_MISMATCH'}
    }
    return {steps,failureCode:'NONE'}
  }catch{return {steps,failureCode:'COMMIT_WATCH_FAILED'}}
}
async function runCommit(checked,status,hostRoot,imageSha){
  need(pin,'COMMIT_FIXTURE_PIN_REQUIRED')
  const prior=restartPreflight(hostRoot,true,checked)
  const failedPath=join(hostRoot,'evidence','real-ui-restart-report.json'),failedSha=absent(failedPath)?null:hash(file(failedPath,256*1024,true))
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'commit',(child,alive,signal)=>watchCommit(child,alive,signal,hostRoot,imageSha))
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'COMMIT_CHILD_PID_INVALID')
  const evidence=join(hostRoot,'evidence'),output=join(evidence,`real-ui-commit-${lifecycle.pid}.json`)
  let trace=null,observation=null,reference=null,finalObserverVerified=false,materialsPreserved=false
  try{
    privateDirectory(hostRoot);privateDirectory(evidence);await live(imageSha)
    const readbacks=await Promise.allSettled([fixture(['--observe',READY]),commitReference(imageSha)])
    if(readbacks[0].status==='fulfilled'){verifyObserver(readbacks[0].value);observation=readbacks[0].value;finalObserverVerified=true}
    if(readbacks[1].status==='fulfilled')reference=readbacks[1].value
    materialsPreserved=attemptMaterials(hostRoot,prior,failedSha)
    trace=startupTrace(join(evidence,`startup-trace-${lifecycle.pid}.jsonl`))
    need(finalObserverVerified&&reference!==null&&reference.bodySha256===hash(`committed-${RUN}`)&&materialsPreserved,'COMMIT_FINAL_STATE_UNVERIFIED')
    need(!lifecycle.timedOut&&lifecycle.exitCode===0,'COMMIT_CHILD_FAILED')
    const progress=lifecycle.progress
    need(progress?.failureCode==='NONE'&&progress.steps.length===3&&progress.steps.every((r,i)=>r.step===COMMIT_STEPS[i]&&r.ack?.verified===true),'COMMIT_CHECKPOINTS_INCOMPLETE')
    for(const record of progress.steps){
      const step=record.step,checkpoint=join(evidence,`commit-checkpoint-${lifecycle.pid}-${step}.json`),ack=join(evidence,`commit-ack-${lifecycle.pid}-${step}.json`)
      need(hash(file(checkpoint,16*1024,true))===record.checkpointSha256&&JSON.stringify(jsonFile(ack,1024))===JSON.stringify(record.ack),'COMMIT_STAGE_CHANGED')
    }
    const verified=verifyCommit(jsonFile(join(evidence,`ui-commit-${lifecycle.pid}.json`),16*1024))
    need(JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'SOURCE_CHANGED_DURING_RUN')
    const report={schemaVersion:1,scope:'mysql-gui-commit-real-ui-chain',runId:RUN,phase:'commit',actionDriver:'native-dom-synthetic',chainPassed:true,productionReady:false,
      preCommitObserverVisibilityVerified:true,commitVerified:true,osTrustedKeyboardVerified:false,crossBuildCredentialVerified:false,errorRecoveryVerified:false,soakVerified:false,referenceProductOperated:false,mysql84Verified:false,windowsVerified:false,
      checks:verified.ui.checks,row:verified.ui.row,actions:verified.ui.actions,elapsedMs:verified.ui.elapsedMs,native:verified.native,lifecycle,trace,observer:observation,finalTableReference:reference,
      provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,failedRestartSha256:failedSha,
        binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}}
    writeEvidence(output,report)
    return {status:'COMMIT_CHAIN_VERIFIED',runId:RUN,chainPassed:true,productionReady:false,lifecycle}
  }catch{
    try{privateDirectory(hostRoot);privateDirectory(evidence);materialsPreserved=attemptMaterials(hostRoot,prior,failedSha);writeEvidence(output,{schemaVersion:1,scope:'mysql-gui-commit-real-ui-chain',runId:RUN,phase:'commit',chainPassed:false,productionReady:false,failureCode:'JOINT_VALIDATION_FAILED',finalObserverVerified,materialsPreserved,finalTableReference:reference,finalTableStateVerified:reference!==null,failedRestartSha256:failedSha,lifecycle,trace})}catch{/* Never overwrite previous evidence or undo a committed row. */}
    return {status:'COMMIT_CHAIN_FAILED',runId:RUN,chainPassed:false,productionReady:false,finalObserverVerified,finalTableStateVerified:reference!==null,materialsPreserved,lifecycle,trace}
  }
}
const DEADLOCK_IDS=[1,2,3,4,...Array.from({length:128},(_,i)=>101+i)]
const DEADLOCK_STEPS=['baseline','marker','observed']
const DEADLOCK_CHECKS=['storage_marker','persisted_connection','credential_reconnect','fixture_created','table_open','marker_applied','actor_waited','local_draft','original_1213','transaction_state_correct','draft_preserved','rollback_notice','recovery_guard_cancel','reloaded_baseline']
const DEADLOCK_FAILURES=['NONE','ISOLATION','CONNECTION','SETUP','TREE','EDIT','CHECKPOINT','DEADLOCK_NOT_OBSERVED','MYSQL_ERROR_DETAILS_LOST','DEADLOCK_TX_STATE_STALE','ROLLBACK_NOTICE_MISSING','RECOVERY','TIMEOUT','DOM_FAILED','NATIVE_BRIDGE']
function deadlockRowsHash(kind){const rows=DEADLOCK_IDS.map((id)=>[String(id),String(id),String(kind==='baseline'?0:kind==='marker'&&id===3?7:kind==='fault'&&id===3?7:kind==='fault'&&id===1?1:0)]);return hash(JSON.stringify({columns:['id','u','v'],rows}))}
function deadlockPayload(r){
  exact(r,['schemaVersion','step','uiActive','uiPendingAffected','dirtyRows','row1Value','row3Value','original1213','rollbackNotice'],'DEADLOCK_CHECKPOINT_SCHEMA')
  need(r.schemaVersion===1&&DEADLOCK_STEPS.includes(r.step)&&typeof r.uiActive==='boolean'&&integer(r.uiPendingAffected,1000)&&integer(r.dirtyRows,1)&&integer(r.row1Value,7)&&integer(r.row3Value,7)&&typeof r.original1213==='boolean'&&typeof r.rollbackNotice==='boolean','DEADLOCK_CHECKPOINT_SCHEMA')
  if(r.step!=='observed')need(r.uiActive===(r.step==='marker')&&r.uiPendingAffected===(r.step==='marker'?1:0)&&r.dirtyRows===0&&r.row1Value===0&&r.row3Value===(r.step==='marker'?7:0)&&!r.original1213&&!r.rollbackNotice,'DEADLOCK_CHECKPOINT_MISMATCH')
}
function deadlockNative(n,step){
  exact(n,['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified','deadlock'],'DEADLOCK_NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='grid-deadlock'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false,'DEADLOCK_NATIVE_SCHEMA')
  need(n.methods&&typeof n.methods==='object'&&!Array.isArray(n.methods),'DEADLOCK_NATIVE_SCHEMA')
  for(const metric of Object.values(n.methods)){exact(metric,['success','failure','totalElapsedMs'],'DEADLOCK_NATIVE_SCHEMA');need(Object.values(metric).every((v)=>integer(v,100_000_000)),'DEADLOCK_NATIVE_SCHEMA')}
  need(n.methods.executeStatement?.success===2&&n.methods.executeStatement.failure===0&&n.methods.commitTransaction?.success===1&&n.methods.commitTransaction.failure===0&&n.methods.connectConnection?.success>=1&&n.methods.connectConnection.failure===0,'DEADLOCK_NATIVE_COUNT')
  if(step==='baseline')need(!n.methods.applyEdits||(n.methods.applyEdits.success===0&&n.methods.applyEdits.failure===0),'DEADLOCK_NATIVE_COUNT')
  else need(n.methods.applyEdits?.success===1&&n.methods.applyEdits.failure===(step==='marker'?0:1),'DEADLOCK_NATIVE_COUNT')
  for(const name of ['rollbackTransaction','addConnection','updateConnection','testConnection','insertRow','deleteRows'])need(!n.methods[name]||(n.methods[name].success===0&&n.methods[name].failure===0),'DEADLOCK_UNEXPECTED_METHOD')
  need([n.keyringGets,n.keyringHits,n.keyringSets].every((v)=>integer(v,10000))&&n.keyringSets===0&&n.keyringGets>=1&&n.keyringHits>=1,'DEADLOCK_KEYRING_MISSING')
  exact(n.deadlock,['lastApplyFailureClass','lastObservedTransactionState'],'DEADLOCK_NATIVE_SCHEMA')
  need(['none','1213','1305','other'].includes(n.deadlock.lastApplyFailureClass),'DEADLOCK_NATIVE_SCHEMA')
  const state=n.deadlock.lastObservedTransactionState
  if(state!==null){exact(state,['active','pendingAffected'],'DEADLOCK_NATIVE_SCHEMA');need(typeof state.active==='boolean'&&integer(state.pendingAffected,1_000_000),'DEADLOCK_NATIVE_SCHEMA')}
}
async function deadlockSql(role,sql,imageSha,signal){
  need(['observer','admin'].includes(role),'DEADLOCK_ROLE_INVALID');need(!signal?.aborted,'DEADLOCK_OBSERVATION_STOPPED');await commitLive(imageSha,signal)
  need(!signal?.aborted,'DEADLOCK_OBSERVATION_STOPPED')
  return await new Promise((resolveText,reject)=>execFile('docker',['exec','--user','0:0',CONTAINER,'mysql',`--defaults-extra-file=/fixture/${role}-client.cnf`,'--connect-timeout=5','--batch','--raw','--skip-column-names','--execute',`SET SESSION autocommit=1; SET SESSION TRANSACTION READ ONLY; SELECT @@session.autocommit,@@session.transaction_read_only; ${sql}`],{cwd:ROOT,encoding:'utf8',timeout:15000,maxBuffer:32*1024,signal},(error,stdout)=>{if(error)reject(new RunFailure('DEADLOCK_REFERENCE_FAILED'));else resolveText(stdout)}))
}
function deadlockLines(text){need(Buffer.byteLength(text)<=16*1024&&!text.includes('\r')&&!text.includes('\u0000'),'DEADLOCK_REFERENCE_FORMAT');const lines=(text.endsWith('\n')?text.slice(0,-1):text).split('\n');need(lines.shift()==='1\t1','DEADLOCK_REFERENCE_SESSION');return lines}
async function deadlockReference(imageSha,signal){
  const table=`\`mysql_accept_${RUN.slice(0,16)}\`.\`gui_dl_${RUN}\``
  const lines=deadlockLines(await deadlockSql('observer',`SELECT id,u,v FROM ${table} ORDER BY id`,imageSha,signal))
  const rows=lines.map((line)=>line.split('\t'))
  need(rows.length===132&&rows.every((r,i)=>r.length===3&&r[0]===String(DEADLOCK_IDS[i])&&r[1]===String(DEADLOCK_IDS[i])&&r[2]==='0'),'DEADLOCK_BASELINE_MISMATCH')
  return {rowCount:132,rowsSha256:hash(JSON.stringify({columns:['id','u','v'],rows})),autocommit:true,readOnly:true}
}
async function startDeadlockActor(imageSha){
  await commitLive(imageSha)
  const table=`\`mysql_accept_${RUN.slice(0,16)}\`.\`gui_dl_${RUN}\``
  const batch=`SET SESSION innodb_lock_wait_timeout=20; START TRANSACTION; UPDATE ${table} SET v=v+1 WHERE id BETWEEN 101 AND 228; UPDATE ${table} SET v=v+1 WHERE id=1; SELECT 'HELD',CONNECTION_ID(); UPDATE ${table} SET v=v+1 WHERE id=3; SELECT 'CROSSED'; ROLLBACK; SELECT 'ROLLED_BACK';\n`
  const child=spawn('docker',['exec','-i','--user','0:0',CONTAINER,'mysql','--defaults-extra-file=/fixture/app-client.cnf','--connect-timeout=5','--batch','--raw','--skip-column-names','--unbuffered'],{cwd:ROOT,stdio:['pipe','pipe','pipe']})
  let stdoutBytes=0,stderrBytes=0,buffer='',badOutput=false,timedOut=false,actorId=null,crossed=false,rolledBack=false,settled=false,resolveHeld,resolveDone
  const held=new Promise((done)=>{resolveHeld=done}),done=new Promise((finish)=>{resolveDone=finish})
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM')},35000)
  const force=setTimeout(()=>{if(!settled)child.kill('SIGKILL')},40000)
  child.stdout.on('data',(bytes)=>{stdoutBytes+=bytes.length;if(stdoutBytes>1024){badOutput=true;child.kill('SIGTERM');return}buffer+=bytes.toString('utf8');let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);const match=/^HELD\t([1-9][0-9]*)$/.exec(line);if(match&&actorId===null&&!crossed){actorId=Number(match[1]);if(Number.isSafeInteger(actorId))resolveHeld(actorId);else badOutput=true}else if(line==='CROSSED'&&actorId!==null&&!crossed&&!rolledBack)crossed=true;else if(line==='ROLLED_BACK'&&crossed&&!rolledBack)rolledBack=true;else badOutput=true}})
  child.stderr.on('data',(bytes)=>{stderrBytes+=bytes.length})
  child.stdin.on('error',()=>{})
  const finish=(code)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(force);resolveHeld(actorId);resolveDone({actorId,exitCode:code,timedOut,crossed,rolledBack,outputValid:!badOutput&&buffer==='',stdoutBytes,stderrBytes})}
  child.once('error',()=>finish(null));child.once('close',finish);child.stdin.end(batch)
  return {held,done,finished:()=>settled}
}
async function deadlockWait(actorId,imageSha,alive,signal){
  need(Number.isSafeInteger(actorId)&&actorId>0,'DEADLOCK_ACTOR_ID_INVALID')
  const db=`mysql_accept_${RUN.slice(0,16)}`,table=`gui_dl_${RUN}`,end=Date.now()+8000
  const sql=`SELECT COUNT(*),COALESCE(MIN(b.PROCESSLIST_ID),0),@@global.innodb_deadlock_detect FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks r ON r.ENGINE=w.ENGINE AND r.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID JOIN performance_schema.data_locks l ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.BLOCKING_ENGINE_LOCK_ID JOIN performance_schema.threads a ON a.THREAD_ID=w.REQUESTING_THREAD_ID JOIN performance_schema.threads b ON b.THREAD_ID=w.BLOCKING_THREAD_ID WHERE a.PROCESSLIST_ID=${actorId} AND r.OBJECT_SCHEMA='${db}' AND r.OBJECT_NAME='${table}' AND r.INDEX_NAME='PRIMARY' AND r.LOCK_TYPE='RECORD' AND r.LOCK_DATA='3' AND l.OBJECT_SCHEMA='${db}' AND l.OBJECT_NAME='${table}' AND l.INDEX_NAME='PRIMARY' AND l.LOCK_DATA='3'`
  while(Date.now()<end){need(alive()&&!signal.aborted,'DEADLOCK_WAIT_STOPPED');const lines=deadlockLines(await deadlockSql('admin',sql,imageSha,signal));need(lines.length===1,'DEADLOCK_WAIT_FORMAT');const fields=lines[0].split('\t');need(fields.length===3&&fields.every((v)=>/^\d+$/.test(v))&&fields[2]==='1','DEADLOCK_DETECTION_DISABLED');if(fields[0]==='1'&&Number(fields[1])>0){need(Date.now()<=end&&alive(),'DEADLOCK_WAIT_TIMEOUT');return {actorId,guiConnectionId:Number(fields[1]),waitObserved:true,deadlockDetect:true}}need(fields[0]==='0','DEADLOCK_WAIT_AMBIGUOUS');await commitPause(signal)}
  throw new RunFailure('DEADLOCK_WAIT_TIMEOUT')
}
async function deadlockServerError(guiId,imageSha,signal){
  need(Number.isSafeInteger(guiId)&&guiId>0,'DEADLOCK_GUI_ID_INVALID')
  const lines=deadlockLines(await deadlockSql('admin',`SELECT e.MYSQL_ERRNO,e.RETURNED_SQLSTATE FROM performance_schema.events_statements_history e JOIN performance_schema.threads t ON t.THREAD_ID=e.THREAD_ID WHERE t.PROCESSLIST_ID=${guiId} AND e.MYSQL_ERRNO<>0 ORDER BY e.EVENT_ID DESC LIMIT 1`,imageSha,signal))
  need(lines.length===1&&lines[0]==='1213\t40001','DEADLOCK_SERVER_EVENT_UNVERIFIED')
  return {code:1213,sqlState:'40001'}
}
async function deadlockTransactionEnded(guiId,imageSha,signal){
  need(Number.isSafeInteger(guiId)&&guiId>0,'DEADLOCK_GUI_ID_INVALID')
  const lines=deadlockLines(await deadlockSql('admin',`SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id=${guiId}`,imageSha,signal))
  need(lines.length===1&&lines[0]==='0','DEADLOCK_GUI_TRANSACTION_ACTIVE');return true
}
function publishDeadlockAck(hostRoot,pid,step,proof,verified,alive){
  need(integer(pid,2_147_483_647)&&pid>0&&DEADLOCK_STEPS.includes(step)&&typeof verified==='boolean','DEADLOCK_ACK_SCHEMA');deadlockPayload(proof);need(proof.step===step,'DEADLOCK_ACK_SCHEMA')
  const evidence=join(hostRoot,'evidence'),target=join(evidence,`deadlock-ack-${pid}-${step}.json`),source=`${target}.pending`
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(hostRoot);commitOwner(evidence)
  need(resolve(source)===source&&resolve(target)===target&&dirname(source)===evidence&&dirname(target)===evidence&&absent(target)&&alive(),'DEADLOCK_ACK_PATH_INVALID')
  const ack={schemaVersion:1,runId:RUN,phase:'grid-deadlock',pid,step,proof,verified},bytes=Buffer.from(`${JSON.stringify(ack)}\n`);need(bytes.length<=2048,'DEADLOCK_ACK_LIMIT')
  const fd=openSync(source,'wx',0o600);let owned
  try{let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);need(n>0,'DEADLOCK_ACK_WRITE');at+=n}fsyncSync(fd);owned=fstatSync(fd);need(owned.isFile()&&owned.nlink===1&&(owned.mode&0o777)===0o600&&owned.size===bytes.length,'DEADLOCK_ACK_FILE_INVALID')}finally{closeSync(fd)}
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(source);const actual=lstatSync(source)
  need(actual.isFile()&&!actual.isSymbolicLink()&&actual.nlink===1&&actual.dev===owned.dev&&actual.ino===owned.ino&&(actual.mode&0o777)===0o600&&realpathSync(source)===source
    &&resolve(source)===join(evidence,`deadlock-ack-${pid}-${step}.json.pending`)&&resolve(target)===join(evidence,`deadlock-ack-${pid}-${step}.json`)&&absent(target)&&alive(),'DEADLOCK_ACK_FILE_INVALID')
  // Both resolved absolute paths were checked above; only this stage's owned pending file is published.
  renameSync(source,target);return ack
}
async function watchDeadlock(child,alive,signal,hostRoot,imageSha){
  const pid=child.pid,steps=[];let actor=null,actorResult=null,waitProof=null,serverError=null,guiTransactionEnded=false,failureCode='NONE'
  try{
    need(integer(pid,2_147_483_647)&&pid>0,'DEADLOCK_CHILD_PID_INVALID')
    for(const step of DEADLOCK_STEPS){
      const path=join(hostRoot,'evidence',`deadlock-checkpoint-${pid}-${step}.json`)
      while(absent(path)){need(alive()&&!signal.aborted,'DEADLOCK_WATCH_STOPPED');await commitPause(signal)}
      need(alive()&&!signal.aborted,'DEADLOCK_WATCH_STOPPED');privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
      const checkpoint=jsonFile(path,16*1024);exact(checkpoint,['schemaVersion','runId','phase','pid','report','observations'],'DEADLOCK_CHECKPOINT_SCHEMA')
      need(checkpoint.schemaVersion===1&&checkpoint.runId===RUN&&checkpoint.phase==='grid-deadlock'&&checkpoint.pid===pid&&checkpoint.report?.step===step,'DEADLOCK_CHECKPOINT_MISMATCH');deadlockPayload(checkpoint.report);deadlockNative(checkpoint.observations,step)
      const record={step,checkpointSha256:hash(file(path,16*1024,true)),checkpoint,reference:null,ack:null};steps.push(record)
      let verified=false
      try{
        if(step==='observed'){
          need(actor&&waitProof,'DEADLOCK_ACTOR_MISSING');actorResult=await actor.done
          need(actorResult.exitCode===0&&!actorResult.timedOut&&actorResult.crossed&&actorResult.rolledBack&&actorResult.outputValid,'DEADLOCK_ACTOR_CLEANUP_UNKNOWN')
          serverError=await deadlockServerError(waitProof.guiConnectionId,imageSha,signal)
          guiTransactionEnded=await deadlockTransactionEnded(waitProof.guiConnectionId,imageSha,signal)
        }
        record.reference=await deadlockReference(imageSha,signal);verified=true
        if(step==='marker'){actor=await startDeadlockActor(imageSha);const actorId=await actor.held;need(actorId&&!actor.finished(),'DEADLOCK_ACTOR_NOT_HELD');waitProof=await deadlockWait(actorId,imageSha,alive,signal)}
      }catch{verified=false}
      await new Promise((done)=>setImmediate(done));need(alive()&&!signal.aborted,'DEADLOCK_WATCH_STOPPED');record.ack=publishDeadlockAck(hostRoot,pid,step,checkpoint.report,verified,alive)
      if(!verified){failureCode='DEADLOCK_STAGE_UNVERIFIED';break}
    }
  }catch{failureCode='DEADLOCK_WATCH_FAILED'}
  finally{if(actor&&!actorResult)actorResult=await actor.done}
  return {steps,actor:actorResult,waitProof,serverError,serverEventVerified:serverError!==null,guiTransactionEnded,failureCode}
}
function verifyDeadlock(value){
  exact(value,['schemaVersion','report','observations'],'HOST_REPORT_SCHEMA');need(value.schemaVersion===1,'HOST_REPORT_SCHEMA')
  const ui=value.report;exact(ui,['schemaVersion','runId','phase','actionDriver','checks','proof','actions','elapsedMs','failureCode'],'DEADLOCK_REPORT_SCHEMA')
  need(ui.schemaVersion===1&&ui.runId===RUN&&ui.phase==='grid-deadlock'&&ui.actionDriver==='native-dom-synthetic'&&DEADLOCK_FAILURES.includes(ui.failureCode)&&integer(ui.elapsedMs),'DEADLOCK_REPORT_SCHEMA')
  exact(ui.checks,DEADLOCK_CHECKS,'DEADLOCK_CHECK_SCHEMA');need(Object.values(ui.checks).every((v)=>typeof v==='boolean'),'DEADLOCK_CHECK_SCHEMA')
  exact(ui.actions,['click','input','keydown','dblclick'],'DEADLOCK_ACTION_SCHEMA');need(Object.values(ui.actions).every((v)=>integer(v,10000)),'DEADLOCK_ACTION_SCHEMA')
  if(ui.proof!==null){const p=ui.proof;exact(p,['rowCount','baselineRowsSha256','markerRowsSha256','faultRowsSha256','reloadedRowsSha256','uiActiveAfterError','uiPendingAffectedAfterError','dirtyRowsAfterError','originalErrorClass'],'DEADLOCK_PROOF_SCHEMA');need(p.rowCount===132&&hex(p.baselineRowsSha256)&&hex(p.markerRowsSha256)&&(p.faultRowsSha256===null||hex(p.faultRowsSha256))&&(p.reloadedRowsSha256===null||hex(p.reloadedRowsSha256))&&(p.uiActiveAfterError===null||typeof p.uiActiveAfterError==='boolean')&&(p.uiPendingAffectedAfterError===null||integer(p.uiPendingAffectedAfterError,1000))&&(p.dirtyRowsAfterError===null||integer(p.dirtyRowsAfterError,1))&&(p.originalErrorClass===null||['1213','1305','other'].includes(p.originalErrorClass)),'DEADLOCK_PROOF_SCHEMA')}
  deadlockNative(value.observations,'observed');return {ui,native:value.observations}
}
async function runGridDeadlock(checked,status,hostRoot,imageSha){
  need(pin,'DEADLOCK_FIXTURE_PIN_REQUIRED');const prior=restartPreflight(hostRoot,true,checked)
  const failedPath=join(hostRoot,'evidence','real-ui-restart-report.json'),failedSha=absent(failedPath)?null:hash(file(failedPath,256*1024,true))
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'grid-deadlock',(child,alive,signal)=>watchDeadlock(child,alive,signal,hostRoot,imageSha))
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'DEADLOCK_CHILD_PID_INVALID')
  const evidence=join(hostRoot,'evidence'),output=join(evidence,`real-ui-grid-deadlock-${lifecycle.pid}.json`)
  let trace=null,observation=null,reference=null,materialsPreserved=false,classification='INFRA_ERROR',failureCode='JOINT_VALIDATION_FAILED',verified=null
  try{
    privateDirectory(hostRoot);privateDirectory(evidence);await live(imageSha)
    const readbacks=await Promise.allSettled([fixture(['--observe',READY]),deadlockReference(imageSha)])
    if(readbacks[0].status==='fulfilled'){verifyObserver(readbacks[0].value);observation=readbacks[0].value}
    if(readbacks[1].status==='fulfilled')reference=readbacks[1].value
    materialsPreserved=attemptMaterials(hostRoot,prior,failedSha);trace=startupTrace(join(evidence,`startup-trace-${lifecycle.pid}.jsonl`))
    need(observation&&reference&&materialsPreserved&&JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'DEADLOCK_FINAL_STATE_UNVERIFIED')
    const progress=lifecycle.progress
    need(progress?.failureCode==='NONE'&&progress.steps.length===3&&progress.steps.every((r,i)=>r.step===DEADLOCK_STEPS[i]&&r.ack?.verified===true)&&progress.waitProof?.waitObserved===true&&progress.guiTransactionEnded===true&&progress.serverEventVerified===true&&progress.serverError?.code===1213&&progress.serverError.sqlState==='40001','DEADLOCK_CHECKPOINTS_INCOMPLETE')
    need(progress.actor?.exitCode===0&&!progress.actor.timedOut&&progress.actor.crossed&&progress.actor.rolledBack&&progress.actor.outputValid,'DEADLOCK_ACTOR_CLEANUP_UNKNOWN')
    for(const r of progress.steps){need(hash(file(join(evidence,`deadlock-checkpoint-${lifecycle.pid}-${r.step}.json`),16*1024,true))===r.checkpointSha256&&JSON.stringify(jsonFile(join(evidence,`deadlock-ack-${lifecycle.pid}-${r.step}.json`),2048))===JSON.stringify(r.ack),'DEADLOCK_STAGE_CHANGED')}
    verified=verifyDeadlock(jsonFile(join(evidence,`ui-grid-deadlock-${lifecycle.pid}.json`),16*1024))
    const ui=verified.ui,p=ui.proof,marker=progress.steps[1].checkpoint.observations,observed=progress.steps[2].checkpoint
    need(p&&p.baselineRowsSha256===deadlockRowsHash('baseline')&&p.markerRowsSha256===deadlockRowsHash('marker')&&p.faultRowsSha256===deadlockRowsHash('fault')&&p.dirtyRowsAfterError===1,'DEADLOCK_DOM_PROOF_MISMATCH')
    need(DEADLOCK_CHECKS.slice(0,8).every((k)=>ui.checks[k])&&ui.checks.draft_preserved&&!lifecycle.timedOut,'DEADLOCK_GUI_STEPS_UNVERIFIED')
    if(ui.failureCode==='MYSQL_ERROR_DETAILS_LOST'){
      need(lifecycle.exitCode===1&&!ui.checks.original_1213&&p.originalErrorClass==='other'&&!observed.report.original1213&&observed.observations.deadlock.lastApplyFailureClass==='other'&&verified.native.deadlock.lastApplyFailureClass==='other','DEADLOCK_ERROR_LOSS_UNVERIFIED')
      classification='KNOWN_GAP_RED';failureCode='MYSQL_ERROR_DETAILS_LOST'
    }else{
    need(ui.checks.original_1213&&p.originalErrorClass==='1213'&&observed.report.original1213===true&&observed.observations.deadlock.lastApplyFailureClass==='1213'&&verified.native.deadlock.lastApplyFailureClass==='1213','DEADLOCK_NOT_OBSERVED')
    if(ui.failureCode==='DEADLOCK_TX_STATE_STALE'&&lifecycle.exitCode===1&&p.uiActiveAfterError===true&&p.uiPendingAffectedAfterError>0){classification='KNOWN_GAP_RED';failureCode='DEADLOCK_TX_STATE_STALE'}
    else if(ui.failureCode==='NONE'){
      const last=observed.observations.deadlock.lastObservedTransactionState
      need(lifecycle.exitCode===0&&DEADLOCK_CHECKS.every((k)=>ui.checks[k])&&p.uiActiveAfterError===false&&p.uiPendingAffectedAfterError===0&&p.reloadedRowsSha256===p.baselineRowsSha256
        &&ui.actions.click>=12&&ui.actions.input===4&&ui.actions.keydown===0&&ui.actions.dblclick===3&&observed.observations.methods.transactionState?.success>=(marker.methods.transactionState?.success??0)+1&&last?.active===false&&last.pendingAffected===0,'DEADLOCK_GREEN_NOT_VERIFIED')
      classification='VERIFIED';failureCode='NONE'
    }else if(ui.failureCode==='ROLLBACK_NOTICE_MISSING'){classification='KNOWN_GAP_RED';failureCode='ROLLBACK_NOTICE_MISSING'}
    else throw new RunFailure('DEADLOCK_NOT_VERIFIED')
    }
  }catch{/* Retain the actual UI/progress proof in an independent closed failure report. */}
  const chainPassed=classification==='VERIFIED'
  try{privateDirectory(hostRoot);privateDirectory(evidence);writeEvidence(output,{schemaVersion:1,scope:'mysql-grid-deadlock-real-ui-chain',runId:RUN,phase:'grid-deadlock',classification,failureCode,chainPassed,productionReady:false,deadlockRecoveryVerified:chainPassed,duplicateKeyVerified:false,lockTimeoutVerified:false,osTrustedKeyboardVerified:false,crossBuildCredentialVerified:false,
    ui:verified?.ui??null,native:verified?.native??null,transactionStateStale:verified?.ui.proof?.uiActiveAfterError===true&&(verified?.ui.proof?.uiPendingAffectedAfterError??0)>0&&lifecycle.progress?.guiTransactionEnded===true,lifecycle,trace,observer:observation,finalTableReference:reference,materialsPreserved,
    provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,failedRestartSha256:failedSha,binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}})}catch{classification='INFRA_ERROR'}
  return {status:classification==='VERIFIED'?'GRID_DEADLOCK_VERIFIED':classification==='KNOWN_GAP_RED'?'GRID_DEADLOCK_KNOWN_GAP_RED':'GRID_DEADLOCK_INFRA_ERROR',runId:RUN,chainPassed:classification==='VERIFIED',productionReady:false,classification,failureCode,lifecycle}
}
async function timeoutAdminRaw(sql,signal){
  need(!signal?.aborted,'TIMEOUT_ADMIN_ABORTED');await commitLive(IMAGE_SHA,signal);need(!signal?.aborted,'TIMEOUT_ADMIN_ABORTED')
  const text=await new Promise((done,reject)=>execFile('docker',['exec','--user','0:0',CONTAINER,'mysql','--defaults-extra-file=/fixture/admin-client.cnf','--connect-timeout=5','--batch','--raw','--skip-column-names','--execute',`SELECT SUBSTRING_INDEX(CURRENT_USER(),'@',1)='root'; ${sql}`],{cwd:ROOT,encoding:'utf8',timeout:15000,maxBuffer:16*1024,signal},(error,stdout)=>error?reject(new RunFailure('TIMEOUT_ADMIN_FAILED')):done(stdout)))
  need(Buffer.byteLength(text)<=8192&&!text.includes('\r')&&!text.includes('\u0000'),'TIMEOUT_ADMIN_FORMAT');const lines=(text.endsWith('\n')?text.slice(0,-1):text).split('\n');need(lines.shift()==='1','TIMEOUT_ROOT_REQUIRED');return lines
}
async function timeoutGlobal(signal){const lines=await timeoutAdminRaw('SELECT @@global.innodb_lock_wait_timeout,@@global.innodb_rollback_on_timeout',signal);need(lines.length===1,'TIMEOUT_GLOBAL_FORMAT');const f=lines[0].split('\t');need(f.length===2&&/^[1-9][0-9]*$/.test(f[0])&&Number.isSafeInteger(Number(f[0]))&&Number(f[0])<=1073741824&&['0','1'].includes(f[1]),'TIMEOUT_GLOBAL_FORMAT');return {timeout:Number(f[0]),rollbackOnTimeout:f[1]==='1'}}
async function timeoutSetGlobal(value,signal){need(Number.isSafeInteger(value)&&value>0&&value<=1073741824,'TIMEOUT_GLOBAL_VALUE_INVALID');await timeoutGlobal(signal);const lines=await timeoutAdminRaw(`SET GLOBAL innodb_lock_wait_timeout=${value}`,signal);need(lines.length===0,'TIMEOUT_SET_FORMAT')}
function timeoutLease(){
  const path=join(ROOT,'backups',`mysql-transaction-contract-service-lock-${RUN}`),attemptId=randomBytes(16).toString('hex')
  need(resolve(path)===path&&dirname(path)===join(ROOT,'backups')&&realpathSync(dirname(path))===dirname(path),'TIMEOUT_LEASE_PATH_INVALID')
  try{mkdirSync(path,{mode:0o700})}catch{throw new RunFailure('TIMEOUT_SERVICE_LEASE_BUSY')}
  privateDirectory(path);commitOwner(path);const owner={runId:RUN,parentPID:process.pid,attemptId};writeEvidence(join(path,'owner.json'),owner);const identity=lstatSync(path)
  return {path,owner,ino:identity.ino,dev:identity.dev,ownerSha256:hash(timeoutFile(join(path,'owner.json'),2048))}
}
async function restoreTimeoutGuard(guard,beforeFault=false){
  if(guard.original===null)return false
  const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),45000)
  try{
    const current=await timeoutGlobal(stop.signal);need(!current.rollbackOnTimeout,'TIMEOUT_ROLLBACK_POLICY_CHANGED')
    need(current.timeout===5||current.timeout===guard.original,'TIMEOUT_GLOBAL_RESTORE_CONFLICT')
    if(current.timeout!==guard.original){need(guard.mutationAttempted,'TIMEOUT_GUARD_NOT_ARMED');await timeoutSetGlobal(guard.original,stop.signal)}
    const readback=await timeoutGlobal(stop.signal);need(readback.timeout===guard.original&&!readback.rollbackOnTimeout,'TIMEOUT_RESTORE_UNVERIFIED')
    guard.restored=readback.timeout;guard.independentReadback=true;if(beforeFault)guard.restoredBeforeFault=true;return true
  }catch{guard.restoreFailure='TIMEOUT_RESTORE_UNVERIFIED';return false}finally{clearTimeout(timer)}
}
async function timeoutFinalGlobal(guard){const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),30000);try{const final=await timeoutGlobal(stop.signal);guard.finalVerified=final.timeout===guard.original&&!final.rollbackOnTimeout;return guard.finalVerified}catch{return false}finally{clearTimeout(timer)}}
function retainTimeoutLease(guard,hostRoot,pid){
  const lease=guard.lease,path=lease.path,evidence=join(hostRoot,'evidence'),target=join(evidence,`timeout-guard-lock-retained-${pid}`)
  need(guard.finalVerified&&Number.isSafeInteger(pid)&&pid>0,'TIMEOUT_LEASE_RELEASE_UNCONFIRMED');privateDirectory(path);commitOwner(path);privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(evidence)
  const identity=lstatSync(path);need(identity.ino===lease.ino&&identity.dev===lease.dev&&hash(timeoutFile(join(path,'owner.json'),2048))===lease.ownerSha256&&JSON.stringify(JSON.parse(timeoutFile(join(path,'owner.json'),2048)))===JSON.stringify(lease.owner),'TIMEOUT_LEASE_OWNERSHIP_MISMATCH')
  need(resolve(path)===join(ROOT,'backups',`mysql-transaction-contract-service-lock-${RUN}`)&&realpathSync(dirname(path))===join(ROOT,'backups')&&resolve(target)===join(evidence,`timeout-guard-lock-retained-${pid}`)&&realpathSync(dirname(target))===evidence&&absent(target),'TIMEOUT_LEASE_PATH_INVALID')
  // Both absolute paths and the lease inode/owner were checked above; preserve this owned lease only.
  renameSync(path,target);guard.leaseRetained=true
}
async function startTimeoutActor(imageSha){
  await commitLive(imageSha)
  const table=`\`mysql_accept_${RUN.slice(0,16)}\`.\`gui_to_${RUN}\``
  const child=spawn('docker',['exec','-i','--user','0:0',CONTAINER,'mysql','--defaults-extra-file=/fixture/app-client.cnf','--connect-timeout=5','--batch','--raw','--skip-column-names','--unbuffered'],{cwd:ROOT,stdio:['pipe','pipe','pipe']})
  let stdoutBytes=0,stderrBytes=0,buffer='',actorId=null,rolledBack=false,bad=false,timedOut=false,finished=false,released=false,resolveHeld,resolveDone
  const held=new Promise((done)=>{resolveHeld=done}),done=new Promise((finish)=>{resolveDone=finish})
  const release=()=>{if(released)return;released=true;if(!finished&&!child.stdin.destroyed)child.stdin.end("ROLLBACK; SELECT 'ROLLED_BACK';\n")}
  const timer=setTimeout(()=>{timedOut=true;release()},45000),force=setTimeout(()=>{if(!finished)child.kill('SIGKILL')},50000)
  child.stdout.on('data',(bytes)=>{stdoutBytes+=bytes.length;if(stdoutBytes>1024){bad=true;release();return}buffer+=bytes.toString('utf8');let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);const match=/^HELD\t([1-9][0-9]*)$/.exec(line);if(match&&actorId===null&&!rolledBack){actorId=Number(match[1]);if(Number.isSafeInteger(actorId))resolveHeld(actorId);else bad=true}else if(line==='ROLLED_BACK'&&actorId!==null&&released&&!rolledBack)rolledBack=true;else bad=true}})
  child.stderr.on('data',(bytes)=>{stderrBytes+=bytes.length});child.stdin.on('error',()=>{})
  const finish=(code)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(force);resolveHeld(actorId);resolveDone({actorId,exitCode:code,timedOut,released,rolledBack,outputValid:!bad&&buffer==='',stdoutBytes,stderrBytes})}
  child.once('error',()=>finish(null));child.once('close',finish);child.stdin.write(`START TRANSACTION; UPDATE ${table} SET v=v+1 WHERE id=1; SELECT 'HELD',CONNECTION_ID();\n`)
  return {held,done,release,finished:()=>finished}
}
async function timeoutActorLock(actorId,signal){need(Number.isSafeInteger(actorId)&&actorId>0,'TIMEOUT_ACTOR_ID_INVALID');const lines=await timeoutAdminRaw(`SELECT COUNT(*) FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID=l.THREAD_ID WHERE t.PROCESSLIST_ID=${actorId} AND l.OBJECT_SCHEMA='mysql_accept_${RUN.slice(0,16)}' AND l.OBJECT_NAME='gui_to_${RUN}' AND l.INDEX_NAME='PRIMARY' AND l.LOCK_DATA='1' AND l.LOCK_STATUS='GRANTED' AND l.LOCK_MODE IN ('X','X,REC_NOT_GAP')`,signal);need(lines.length===1&&lines[0]==='1','TIMEOUT_ACTOR_LOCK_MISSING');return true}
async function timeoutWait(guiId,actorId,alive,signal){
  need([guiId,actorId].every((n)=>Number.isSafeInteger(n)&&n>0),'TIMEOUT_WAIT_ID_INVALID');const end=Date.now()+8000,stop=new AbortController(),cancel=()=>stop.abort(),timer=setTimeout(cancel,8000);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()
  try{do{need(alive()&&!stop.signal.aborted,'TIMEOUT_WAIT_ABORTED');const db=`mysql_accept_${RUN.slice(0,16)}`,table=`gui_to_${RUN}`
    const lines=await timeoutAdminRaw(`SELECT COUNT(*) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks r ON r.ENGINE=w.ENGINE AND r.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID JOIN performance_schema.data_locks l ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.BLOCKING_ENGINE_LOCK_ID JOIN performance_schema.threads g ON g.THREAD_ID=w.REQUESTING_THREAD_ID JOIN performance_schema.threads a ON a.THREAD_ID=w.BLOCKING_THREAD_ID WHERE g.PROCESSLIST_ID=${guiId} AND a.PROCESSLIST_ID=${actorId} AND r.OBJECT_SCHEMA='${db}' AND r.OBJECT_NAME='${table}' AND r.INDEX_NAME='PRIMARY' AND r.LOCK_DATA='1' AND l.OBJECT_SCHEMA='${db}' AND l.OBJECT_NAME='${table}' AND l.INDEX_NAME='PRIMARY' AND l.LOCK_DATA='1'`,stop.signal)
    need(lines.length===1&&['0','1'].includes(lines[0]),'TIMEOUT_WAIT_AMBIGUOUS');if(lines[0]==='1'){need(Date.now()<=end&&alive(),'TIMEOUT_WAIT_ABORTED');return {guiConnectionId:guiId,actorId,waitObserved:true}}await commitPause(stop.signal)
  }while(Date.now()<end);throw new RunFailure('TIMEOUT_WAIT_MISSING')}finally{clearTimeout(timer);signal.removeEventListener('abort',cancel)}
}
const TIMEOUT_STEPS=['marker','failed','rolled-back']
const TIMEOUT_CHECKS=['storage_marker','persisted_connection','credential_reconnect','fixture_created','table_open','marker_applied','session_settings','actor_held','local_draft','original_1205','transaction_preserved','draft_preserved','same_session_witness','rollback_cancel_preserved','normal_rollback','reloaded_baseline']
const TIMEOUT_FAILURES=['NONE','ISOLATION','CONNECTION','SETUP','TREE','EDIT','CHECKPOINT','SESSION_SETTINGS','MYSQL_ERROR_DETAILS_LOST','TRANSACTION_LOST','DRAFT_LOST','WITNESS_FAILED','RECOVERY','TIMEOUT','DOM_FAILED','NATIVE_BRIDGE']
function timeoutHash(kind){return hash(JSON.stringify({columns:['id','u','v'],rows:[1,2,3,4].map((id)=>[String(id),String(id),String(kind==='fault'&&id===1?1:kind!=='baseline'&&id===3?7:0)])}))}
function timeoutFile(path,max){
  need(resolve(path)===path&&realpathSync(path)===path,'TIMEOUT_FILE_INVALID');const before=lstatSync(path)
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&(before.mode&0o777)===0o600&&before.size<=max,'TIMEOUT_FILE_INVALID');commitOwner(path)
  const fd=openSync(path,'r')
  try{const opened=fstatSync(fd);need(opened.dev===before.dev&&opened.ino===before.ino&&opened.uid===before.uid&&opened.isFile()&&opened.nlink===1&&(opened.mode&0o777)===0o600&&opened.size<=max,'TIMEOUT_FILE_INVALID');const bytes=readFileSync(fd),after=lstatSync(path),last=fstatSync(fd);need(bytes.length<=max&&last.size===bytes.length&&after.dev===opened.dev&&after.ino===opened.ino&&after.uid===opened.uid&&last.nlink===1&&(last.mode&0o777)===0o600&&realpathSync(path)===path,'TIMEOUT_FILE_CHANGED');return bytes}finally{closeSync(fd)}
}
function timeoutPayload(r){
  exact(r,['schemaVersion','step','uiActive','uiPendingAffected','dirtyRows','row1Value','row3Value','original1205','witnessConnectionId','witnessMarkerValue','sessionTimeoutSeconds','rollbackOnTimeout'],'TIMEOUT_CHECKPOINT_SCHEMA')
  need(r.schemaVersion===1&&TIMEOUT_STEPS.includes(r.step)&&typeof r.uiActive==='boolean'&&integer(r.uiPendingAffected,1000)&&integer(r.dirtyRows,1)&&[0,1].includes(r.row1Value)&&[0,7].includes(r.row3Value)&&typeof r.original1205==='boolean'
    &&(r.witnessConnectionId===null||(Number.isSafeInteger(r.witnessConnectionId)&&r.witnessConnectionId>0))&&(r.witnessMarkerValue===null||[0,7].includes(r.witnessMarkerValue))&&(r.sessionTimeoutSeconds===null||(integer(r.sessionTimeoutSeconds,3600)&&r.sessionTimeoutSeconds>0))&&(r.rollbackOnTimeout===null||typeof r.rollbackOnTimeout==='boolean'),'TIMEOUT_CHECKPOINT_SCHEMA')
  if(r.step==='marker')need(r.uiActive&&r.uiPendingAffected===1&&r.dirtyRows===0&&r.row1Value===0&&r.row3Value===7&&!r.original1205&&r.witnessConnectionId>0&&r.witnessMarkerValue===7&&r.sessionTimeoutSeconds===5&&r.rollbackOnTimeout===false,'TIMEOUT_CHECKPOINT_MISMATCH')
  if(r.step==='rolled-back')need(!r.uiActive&&r.uiPendingAffected===0&&r.dirtyRows===0&&r.row1Value===0&&r.row3Value===0&&r.original1205&&r.witnessConnectionId>0&&r.witnessMarkerValue===0&&r.sessionTimeoutSeconds===5&&r.rollbackOnTimeout===false,'TIMEOUT_CHECKPOINT_MISMATCH')
}
function timeoutNative(n,step){
  exact(n,['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified','timeout'],'TIMEOUT_NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='grid-timeout'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false&&n.methods&&typeof n.methods==='object'&&!Array.isArray(n.methods),'TIMEOUT_NATIVE_SCHEMA')
  for(const metric of Object.values(n.methods)){exact(metric,['success','failure','totalElapsedMs'],'TIMEOUT_NATIVE_SCHEMA');need(Object.values(metric).every((v)=>integer(v,100_000_000)),'TIMEOUT_NATIVE_SCHEMA')}
  need(n.methods.connectConnection?.success>=1&&n.methods.connectConnection.failure===0&&n.methods.executeStatement?.success===(step==='marker'?3:4)&&n.methods.executeStatement.failure===0&&n.methods.commitTransaction?.success===1&&n.methods.commitTransaction.failure===0,'TIMEOUT_NATIVE_COUNT')
  if(step==='marker')need(n.methods.applyEdits?.success===1&&n.methods.applyEdits.failure===0,'TIMEOUT_NATIVE_COUNT')
  else need(n.methods.applyEdits?.success===2&&n.methods.applyEdits.failure===0,'TIMEOUT_NATIVE_COUNT')
  need((n.methods.rollbackTransaction?.success??0)===(step==='rolled-back'?1:0)&&(n.methods.rollbackTransaction?.failure??0)===0,'TIMEOUT_NATIVE_COUNT')
  for(const name of ['addConnection','updateConnection','testConnection','insertRow','deleteRows'])need(!n.methods[name]||(n.methods[name].success===0&&n.methods[name].failure===0),'TIMEOUT_UNEXPECTED_METHOD')
  need([n.keyringGets,n.keyringHits,n.keyringSets].every((v)=>integer(v,10000))&&n.keyringSets===0&&n.keyringGets>=1&&n.keyringHits>=1,'TIMEOUT_KEYRING_MISSING')
  exact(n.timeout,['lastApplyResult','lastObservedTransactionState'],'TIMEOUT_NATIVE_SCHEMA')
  const result=n.timeout.lastApplyResult,state=n.timeout.lastObservedTransactionState
  if(result!==null){exact(result,['ok','affected','inTransaction','outcomeCount','failedOutcomeCount','errorClass'],'TIMEOUT_NATIVE_SCHEMA');need(typeof result.ok==='boolean'&&integer(result.affected,1000)&&typeof result.inTransaction==='boolean'&&integer(result.outcomeCount,1000)&&integer(result.failedOutcomeCount,1000)&&['none','1205','other'].includes(result.errorClass),'TIMEOUT_NATIVE_SCHEMA')}
  if(state!==null){exact(state,['active','pendingAffected'],'TIMEOUT_NATIVE_SCHEMA');need(typeof state.active==='boolean'&&integer(state.pendingAffected,1_000_000),'TIMEOUT_NATIVE_SCHEMA')}
}
function timeoutResultVerified(n){const r=n.timeout.lastApplyResult;return r?.ok===false&&r.affected===0&&r.outcomeCount===1&&r.failedOutcomeCount===1&&r.errorClass==='1205'}
async function timeoutReference(imageSha,signal){
  const lines=deadlockLines(await deadlockSql('observer',`SELECT id,u,v FROM \`mysql_accept_${RUN.slice(0,16)}\`.\`gui_to_${RUN}\` ORDER BY id`,imageSha,signal)),rows=lines.map((line)=>line.split('\t'))
  need(rows.length===4&&rows.every((r,i)=>r.length===3&&r[0]===String(i+1)&&r[1]===String(i+1)&&r[2]==='0'),'TIMEOUT_BASELINE_MISMATCH')
  return {rowCount:4,rowsSha256:hash(JSON.stringify({columns:['id','u','v'],rows})),autocommit:true,readOnly:true}
}
async function timeoutServerError(guiId,imageSha,signal){
  need(Number.isSafeInteger(guiId)&&guiId>0,'TIMEOUT_GUI_ID_INVALID')
  const lines=await timeoutAdminRaw(`SELECT e.MYSQL_ERRNO,e.RETURNED_SQLSTATE FROM performance_schema.events_statements_history e JOIN performance_schema.threads t ON t.THREAD_ID=e.THREAD_ID WHERE t.PROCESSLIST_ID=${guiId} AND e.MYSQL_ERRNO<>0 ORDER BY e.EVENT_ID DESC LIMIT 1`,signal)
  need(lines.length===1&&lines[0]==='1205\tHY000','TIMEOUT_SERVER_EVENT_UNVERIFIED');return {code:1205,sqlState:'HY000'}
}
async function timeoutTransaction(guiId,imageSha,signal,expected){
  need(Number.isSafeInteger(guiId)&&guiId>0,'TIMEOUT_GUI_ID_INVALID')
  const db=`mysql_accept_${RUN.slice(0,16)}`,table=`gui_to_${RUN}`,end=Date.now()+3000
  let result=null
  const stop=new AbortController(),cancel=()=>stop.abort(),timer=setTimeout(cancel,3000)
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel()
  try{
    do{
      const sql=`SELECT (SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id=${guiId}),(SELECT COUNT(*) FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID=l.THREAD_ID WHERE t.PROCESSLIST_ID=${guiId} AND l.OBJECT_SCHEMA='${db}' AND l.OBJECT_NAME='${table}' AND l.INDEX_NAME='PRIMARY' AND l.LOCK_DATA='3' AND l.LOCK_STATUS='GRANTED' AND l.LOCK_MODE IN ('X','X,REC_NOT_GAP'))`
      const lines=await timeoutAdminRaw(sql,stop.signal);need(lines.length===1,'TIMEOUT_TRANSACTION_FORMAT');const f=lines[0].split('\t');need(f.length===2&&f.every((v)=>/^\d+$/.test(v))&&Number(f[0])<=1&&Number.isSafeInteger(Number(f[1])),'TIMEOUT_TRANSACTION_FORMAT')
      result={transactionCount:Number(f[0]),markerLockCount:Number(f[1]),transactionActive:f[0]==='1',markerLockRetained:Number(f[1])>0}
      if(expected==='ended'?!result.transactionActive&&!result.markerLockRetained:result.transactionActive&&result.markerLockRetained)break
      if(Date.now()>=end)break;await commitPause(stop.signal)
    }while(!stop.signal.aborted&&Date.now()<end)
  }catch{need(result&&!signal?.aborted&&Date.now()>=end,'TIMEOUT_TRANSACTION_UNVERIFIED')}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel)}
  need(result&&!signal?.aborted,'TIMEOUT_TRANSACTION_UNVERIFIED');return result
}
function publishTimeoutAck(hostRoot,pid,step,proof,verified,alive){
  need(integer(pid,2_147_483_647)&&pid>0&&TIMEOUT_STEPS.includes(step)&&typeof verified==='boolean','TIMEOUT_ACK_SCHEMA');timeoutPayload(proof);need(proof.step===step,'TIMEOUT_ACK_SCHEMA')
  const evidence=join(hostRoot,'evidence'),target=join(evidence,`timeout-ack-${pid}-${step}.json`),source=`${target}.pending`
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(hostRoot);commitOwner(evidence)
  need(resolve(source)===source&&resolve(target)===target&&dirname(source)===evidence&&dirname(target)===evidence&&absent(target)&&alive(),'TIMEOUT_ACK_PATH_INVALID')
  const ack={schemaVersion:1,runId:RUN,phase:'grid-timeout',pid,step,proof,verified},bytes=Buffer.from(`${JSON.stringify(ack)}\n`);need(bytes.length<=2048,'TIMEOUT_ACK_LIMIT')
  const fd=openSync(source,'wx',0o600);let owned
  try{let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);need(n>0,'TIMEOUT_ACK_WRITE');at+=n}fsyncSync(fd);owned=fstatSync(fd);need(owned.isFile()&&owned.nlink===1&&(owned.mode&0o777)===0o600&&owned.size===bytes.length,'TIMEOUT_ACK_FILE_INVALID')}finally{closeSync(fd)}
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(source);const actual=lstatSync(source)
  need(actual.isFile()&&!actual.isSymbolicLink()&&actual.nlink===1&&actual.dev===owned.dev&&actual.ino===owned.ino&&(actual.mode&0o777)===0o600&&realpathSync(source)===source&&resolve(source)===join(evidence,`timeout-ack-${pid}-${step}.json.pending`)&&resolve(target)===join(evidence,`timeout-ack-${pid}-${step}.json`)&&absent(target)&&alive(),'TIMEOUT_ACK_FILE_INVALID')
  // Absolute source and target above identify only this PID/step's pending and final files.
  renameSync(source,target);return ack
}
async function watchTimeout(child,alive,signal,hostRoot,imageSha,guard){
  const pid=child.pid,steps=[];let actor=null,actorResult=null,waitProof=null,failureCode='NONE';guard.child=child
  const cleanActor=async()=>{if(actor){actor.release();if(!actorResult)actorResult=await actor.done}return actorResult?.exitCode===0&&!actorResult.timedOut&&actorResult.released&&actorResult.rolledBack&&actorResult.outputValid}
  try{
    need(integer(pid,2_147_483_647)&&pid>0,'TIMEOUT_CHILD_PID_INVALID')
    for(const step of TIMEOUT_STEPS){
      const path=join(hostRoot,'evidence',`timeout-checkpoint-${pid}-${step}.json`)
      while(absent(path)){if(!alive()||signal.aborted){if(step==='rolled-back'&&steps.length===2&&steps[1].ack?.verified===true){failureCode='PARTIAL_UI_FAILURE';return {steps,actor:actorResult,waitProof,failureCode}}throw new RunFailure('TIMEOUT_WATCH_STOPPED')}await commitPause(signal)}
      need(alive()&&!signal.aborted,'TIMEOUT_WATCH_STOPPED');privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
      const bytes=timeoutFile(path,16*1024),checkpoint=JSON.parse(bytes.toString('utf8'));exact(checkpoint,['schemaVersion','runId','phase','pid','report','observations'],'TIMEOUT_CHECKPOINT_SCHEMA')
      need(checkpoint.schemaVersion===1&&checkpoint.runId===RUN&&checkpoint.phase==='grid-timeout'&&checkpoint.pid===pid&&checkpoint.report?.step===step,'TIMEOUT_CHECKPOINT_MISMATCH');timeoutPayload(checkpoint.report);timeoutNative(checkpoint.observations,step)
      const record={step,checkpointSha256:hash(bytes),checkpoint,reference:null,serverError:null,transaction:null,ack:null};steps.push(record);let verified=false
      try{
        const id=checkpoint.report.witnessConnectionId;need(id>0,'TIMEOUT_WITNESS_ID_MISSING')
        if(step==='failed'){need(waitProof?.waitObserved,'TIMEOUT_ACTUAL_WAIT_MISSING');record.serverError=await timeoutServerError(id,imageSha,signal)}
        record.transaction=await timeoutTransaction(id,imageSha,signal,step==='rolled-back'?'ended':'retained');record.reference=await timeoutReference(imageSha,signal)
        if(step==='marker'){
          need(record.transaction.transactionActive&&record.transaction.markerLockRetained,'TIMEOUT_MARKER_TRANSACTION_MISSING')
          need(await restoreTimeoutGuard(guard,true),'TIMEOUT_RESTORE_BEFORE_FAULT_FAILED');need(alive()&&!signal.aborted,'TIMEOUT_WATCH_STOPPED')
          actor=await startTimeoutActor(imageSha);const actorId=await actor.held;need(actorId&&!actor.finished(),'TIMEOUT_ACTOR_NOT_HELD');await timeoutActorLock(actorId,signal)
        }else if(step==='failed'){need(await cleanActor(),'TIMEOUT_ACTOR_CLEANUP_UNKNOWN')}
        else {need(!record.transaction.transactionActive&&!record.transaction.markerLockRetained,'TIMEOUT_ROLLBACK_UNVERIFIED');const global=await timeoutGlobal(signal);need(global.timeout===guard.original&&!global.rollbackOnTimeout,'TIMEOUT_FINAL_GLOBAL_CHANGED')}
        verified=true
      }catch{verified=false}
      await new Promise((done)=>setImmediate(done));need(alive()&&!signal.aborted,'TIMEOUT_WATCH_STOPPED');record.ack=publishTimeoutAck(hostRoot,pid,step,checkpoint.report,verified,alive)
      if(!verified){failureCode='TIMEOUT_STAGE_UNVERIFIED';break}
      if(step==='marker')waitProof=await timeoutWait(checkpoint.report.witnessConnectionId,await actor.held,alive,signal)
    }
  }catch{failureCode='TIMEOUT_WATCH_FAILED'}
  finally{await cleanActor()}
  return {steps,actor:actorResult,waitProof,failureCode}
}
function verifyTimeout(value){
  exact(value,['schemaVersion','report','observations'],'HOST_REPORT_SCHEMA');need(value.schemaVersion===1,'HOST_REPORT_SCHEMA')
  const ui=value.report;exact(ui,['schemaVersion','runId','phase','actionDriver','checks','proof','actions','elapsedMs','failureCode'],'TIMEOUT_REPORT_SCHEMA')
  need(ui.schemaVersion===1&&ui.runId===RUN&&ui.phase==='grid-timeout'&&ui.actionDriver==='native-dom-synthetic'&&TIMEOUT_FAILURES.includes(ui.failureCode)&&integer(ui.elapsedMs),'TIMEOUT_REPORT_SCHEMA')
  exact(ui.checks,TIMEOUT_CHECKS,'TIMEOUT_CHECK_SCHEMA');need(Object.values(ui.checks).every((v)=>typeof v==='boolean'),'TIMEOUT_CHECK_SCHEMA')
  exact(ui.actions,['click','input','keydown','dblclick'],'TIMEOUT_ACTION_SCHEMA');need(Object.values(ui.actions).every((v)=>integer(v,10000)),'TIMEOUT_ACTION_SCHEMA')
  if(ui.proof!==null){const p=ui.proof;exact(p,['rowCount','baselineRowsSha256','markerRowsSha256','faultRowsSha256','restoredRowsSha256','uiActiveAfterError','uiPendingAffectedAfterError','dirtyRowsAfterError','originalErrorClass','witnessConnectionId','markerValueAfterError','markerValueAfterRollback','sessionTimeoutSeconds','rollbackOnTimeout'],'TIMEOUT_PROOF_SCHEMA');need(p.rowCount===4&&hex(p.baselineRowsSha256)&&hex(p.markerRowsSha256)&&(p.faultRowsSha256===null||hex(p.faultRowsSha256))&&(p.restoredRowsSha256===null||hex(p.restoredRowsSha256))&&(p.uiActiveAfterError===null||typeof p.uiActiveAfterError==='boolean')&&(p.uiPendingAffectedAfterError===null||integer(p.uiPendingAffectedAfterError,1000))&&(p.dirtyRowsAfterError===null||integer(p.dirtyRowsAfterError,1))&&(p.originalErrorClass===null||['1205','other'].includes(p.originalErrorClass))&&(p.witnessConnectionId===null||(Number.isSafeInteger(p.witnessConnectionId)&&p.witnessConnectionId>0))&&(p.markerValueAfterError===null||[0,7].includes(p.markerValueAfterError))&&(p.markerValueAfterRollback===null||[0,7].includes(p.markerValueAfterRollback))&&(p.sessionTimeoutSeconds===null||(integer(p.sessionTimeoutSeconds,3600)&&p.sessionTimeoutSeconds>0))&&(p.rollbackOnTimeout===null||typeof p.rollbackOnTimeout==='boolean'),'TIMEOUT_PROOF_SCHEMA')}
  timeoutNative(value.observations,ui.failureCode==='NONE'?'rolled-back':'failed');return {ui,native:value.observations}
}
const TIME_STEPS=['baseline','draft','applied','committed']
const TIME_COLUMNS=['id','date_value','datetime_value','timestamp_value','time_wide','time_short']
const TIME_TYPES=['integer','date','date','date','text','text'],TIME_CATEGORIES=['integer','real','text','blob','null','boolean','date','unknown']
const TIME_PROJECTION=['session_timezone','date_text','datetime_text','timestamp_text','time_wide_text','time_short_text','datetime_microsecond','timestamp_microsecond','time_wide_microsecond','time_short_microsecond','timestamp_epoch']
const TIME_BASELINE=['2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 12:34:56.123456','-25:02:03.000002','01:02:03.000003']
const TIME_EDITED=['2025-12-31','2025-12-31 23:59:58.999999','2025-12-31 23:59:58.654321','49:03:04.999998','-02:03:04.999997']
const TIME_CHECKS=['storage_marker','persisted_connection','credential_reconnect','fixture_created','session_utc_verified','table_open','baseline_exact','editor_raw_exact','local_edits','apply_succeeded','uncommitted_transaction','same_session_witness','normal_commit','reloaded_exact_values','transaction_ended','temporal_types']
const TIME_FAILURES=['NONE','ISOLATION','CONNECTION','FIXTURE_OPEN','SESSION_UTC_FAILED','TABLE_OPEN','BASELINE_MISMATCH','EDITOR_VALUE_LOSS','DIRTY_VALUES_MISMATCH','APPLY_REJECTED','TRANSACTION_STALE','WITNESS_FAILED','COMMIT_FAILED','RELOADED_VALUES_MISMATCH','CHECKPOINT','TIMEOUT','NATIVE_BRIDGE']
const timeText=(v)=>typeof v==='string'&&v.length<=64&&!/[\u0000-\u001f\u007f]/.test(v)
const timeSame=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
const timeValuesHash=(values,types)=>hash(JSON.stringify({columns:TIME_COLUMNS,types,rows:[values]}))
const timeProjectionHash=(row)=>hash(JSON.stringify({columns:TIME_PROJECTION,rows:[row]}))
function timePayload(r){
  exact(r,['schemaVersion','step','uiActive','uiPendingAffected','dirtyRows','valuesSha256','witnessConnectionId','witnessProjectionSha256'],'TIME_CHECKPOINT_SCHEMA')
  need(r.schemaVersion===1&&TIME_STEPS.includes(r.step)&&typeof r.uiActive==='boolean'&&integer(r.uiPendingAffected,1000)&&integer(r.dirtyRows,1000)&&hex(r.valuesSha256)&&Number.isSafeInteger(r.witnessConnectionId)&&r.witnessConnectionId>0&&hex(r.witnessProjectionSha256),'TIME_CHECKPOINT_SCHEMA')
  if(r.step==='baseline')need(!r.uiActive&&r.uiPendingAffected===0&&r.dirtyRows===0,'TIME_CHECKPOINT_MISMATCH')
}
function timeStage(r){
  exact(r,['values','columnTypes','valuesSha256','witnessConnectionId','witnessProjection','witnessProjectionSha256','uiActive','uiPendingAffected','dirtyRows'],'TIME_STAGE_SCHEMA')
  need(Array.isArray(r.values)&&r.values.length===6&&r.values.every((v)=>v===null||timeText(v))&&Array.isArray(r.columnTypes)&&r.columnTypes.length===6&&r.columnTypes.every((v)=>TIME_CATEGORIES.includes(v))&&hex(r.valuesSha256)&&r.valuesSha256===timeValuesHash(r.values,r.columnTypes)&&Number.isSafeInteger(r.witnessConnectionId)&&r.witnessConnectionId>0&&Array.isArray(r.witnessProjection)&&r.witnessProjection.length===11&&r.witnessProjection.every((v)=>v===null||timeText(v))&&hex(r.witnessProjectionSha256)&&r.witnessProjectionSha256===timeProjectionHash(r.witnessProjection)&&typeof r.uiActive==='boolean'&&integer(r.uiPendingAffected,1000)&&integer(r.dirtyRows,1000),'TIME_STAGE_SCHEMA')
}
function verifyTime(value){
  exact(value,['schemaVersion','report','observations'],'HOST_REPORT_SCHEMA');need(value.schemaVersion===1,'HOST_REPORT_SCHEMA');const ui=value.report
  exact(ui,['schemaVersion','runId','phase','actionDriver','checks','proof','actions','elapsedMs','failureCode'],'TIME_REPORT_SCHEMA');need(ui.schemaVersion===1&&ui.runId===RUN&&ui.phase==='grid-time'&&ui.actionDriver==='native-dom-synthetic'&&TIME_FAILURES.includes(ui.failureCode)&&integer(ui.elapsedMs,3600000),'TIME_REPORT_SCHEMA')
  exact(ui.checks,TIME_CHECKS,'TIME_CHECK_SCHEMA');need(Object.values(ui.checks).every((v)=>typeof v==='boolean'),'TIME_CHECK_SCHEMA');exact(ui.actions,['click','input','keydown','dblclick'],'TIME_ACTION_SCHEMA');need(Object.values(ui.actions).every((v)=>integer(v,10000)),'TIME_ACTION_SCHEMA')
  if(ui.proof!==null){const p=ui.proof;exact(p,['rowCount','columnCount','editorOriginals','stages'],'TIME_PROOF_SCHEMA');need(p.rowCount===1&&p.columnCount===5&&Array.isArray(p.editorOriginals)&&p.editorOriginals.length===5,'TIME_PROOF_SCHEMA');for(const e of p.editorOriginals){if(e===null)continue;exact(e,['raw','isNull','valueDisabled','nullDisabled'],'TIME_EDITOR_SCHEMA');need(timeText(e.raw)&&typeof e.isNull==='boolean'&&typeof e.valueDisabled==='boolean'&&typeof e.nullDisabled==='boolean','TIME_EDITOR_SCHEMA')}exact(p.stages,TIME_STEPS,'TIME_PROOF_SCHEMA');need(p.stages.baseline!==null,'TIME_PROOF_SCHEMA');for(const step of TIME_STEPS)if(p.stages[step]!==null)timeStage(p.stages[step])}
  timeNative(value.observations);return {ui,native:value.observations}
}
async function timeSql(role,sql,imageSha,signal,tz='+00:00'){
  need(['app','observer'].includes(role)&&/^[+-]\d{2}:\d{2}$/.test(tz)&&!signal?.aborted,'TIME_CLIENT_ROLE_OR_ABORT');await commitLive(imageSha,signal);need(!signal?.aborted,'TIME_CLIENT_ABORTED')
  const prefix=`SET SESSION autocommit=1; SET SESSION TRANSACTION READ ONLY; SET SESSION time_zone = '${tz}'; SELECT @@session.autocommit,@@session.transaction_read_only; `
  const text=await new Promise((done,reject)=>execFile('docker',['exec','--user','0:0',CONTAINER,'mysql',`--defaults-extra-file=/fixture/${role}-client.cnf`,'--connect-timeout=5','--batch','--raw','--skip-column-names','--execute',prefix+sql],{cwd:ROOT,encoding:'utf8',timeout:15000,maxBuffer:16*1024,signal},(error,stdout)=>error?reject(new RunFailure('TIME_CLIENT_FAILED')):done(stdout)))
  return deadlockLines(text)
}
async function timeOracle(imageSha,signal){
  const literal=(row)=>{const date=`CAST('${row[0]}' AS DATE)`,dt=`CAST('${row[1]}' AS DATETIME(6))`,ts=`CAST('${row[2]}' AS DATETIME(6))`,wide=`CAST('${row[3]}' AS TIME(6))`,short=`CAST('${row[4]}' AS TIME(6))`;return `SELECT @@session.time_zone,CAST(${date} AS CHAR),DATE_FORMAT(${dt},'%Y-%m-%d %H:%i:%s.%f'),DATE_FORMAT(${ts},'%Y-%m-%d %H:%i:%s.%f'),CAST(${wide} AS CHAR),CAST(${short} AS CHAR),CAST(MICROSECOND(${dt}) AS CHAR),CAST(MICROSECOND(${ts}) AS CHAR),CAST(MICROSECOND(${wide}) AS CHAR),CAST(MICROSECOND(${short}) AS CHAR),CAST(UNIX_TIMESTAMP(${ts}) AS CHAR),@@system_time_zone,@@session.autocommit,@@session.transaction_read_only`}
  const lines=await timeSql('app',`${literal(TIME_BASELINE)}; ${literal(TIME_EDITED)}`,imageSha,signal);need(lines.length===2,'TIME_ORACLE_ROWS');const rows=lines.map((line)=>line.split('\t'))
  need(rows.every((row)=>row.length===14&&row.every(timeText)&&row.slice(11).join('\t')==='UTC\t1\t1'),'TIME_ORACLE_FORMAT')
  const baseline=rows[0].slice(0,11),edited=rows[1].slice(0,11)
  need(timeSame(baseline,['+00:00',...TIME_BASELINE,'1','123456','2','3','1709210096.123456'])&&timeSame(edited,['+00:00',...TIME_EDITED,'999999','654321','999998','999997','1767225598.654321']),'TIME_ORACLE_VALUES')
  return {baseline,edited,baselineProjectionSha256:timeProjectionHash(baseline),editedProjectionSha256:timeProjectionHash(edited),systemTimezone:'UTC',autocommit:true,readOnly:true}
}
function timeProjectionSql(){return 'SELECT @@session.time_zone,CAST(date_value AS CHAR),DATE_FORMAT(datetime_value,\'%Y-%m-%d %H:%i:%s.%f\'),DATE_FORMAT(timestamp_value,\'%Y-%m-%d %H:%i:%s.%f\'),CAST(time_wide AS CHAR),CAST(time_short AS CHAR),CAST(MICROSECOND(datetime_value) AS CHAR),CAST(MICROSECOND(timestamp_value) AS CHAR),CAST(MICROSECOND(time_wide) AS CHAR),CAST(MICROSECOND(time_short) AS CHAR),CAST(UNIX_TIMESTAMP(timestamp_value) AS CHAR)'}
async function timeReference(imageSha,signal){
  const table=`\`mysql_accept_${RUN.slice(0,16)}\`.\`gui_time_${RUN}\``,lines=await timeSql('observer',`${timeProjectionSql()} FROM ${table} ORDER BY id`,imageSha,signal)
  need(lines.length===1,'TIME_REFERENCE_ROWS');const projection=lines[0].split('\t').map((v)=>v==='NULL'?null:v);need(projection.length===11&&projection.every((v)=>v===null||timeText(v)),'TIME_REFERENCE_FORMAT')
  return {rowCount:1,projection,projectionSha256:timeProjectionHash(projection),autocommit:true,readOnly:true}
}
async function timeColumns(imageSha,signal){
  const lines=await timeSql('observer',`SELECT COLUMN_NAME,DATA_TYPE,IS_NULLABLE,DATETIME_PRECISION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='mysql_accept_${RUN.slice(0,16)}' AND TABLE_NAME='gui_time_${RUN}' ORDER BY ORDINAL_POSITION`,imageSha,signal);need(lines.length===6,'TIME_COLUMNS_ROWS')
  const columns=lines.map((line)=>{const fields=line.split('\t');need(fields.length===4&&fields.slice(0,3).every(timeText)&&(fields[3]==='NULL'||/^[0-9]+$/.test(fields[3])&&integer(Number(fields[3]),1000)),'TIME_COLUMNS_FORMAT');return {name:fields[0],dataType:fields[1],nullable:fields[2],datetimePrecision:fields[3]==='NULL'?null:Number(fields[3])}})
  const types=['int','date','datetime','timestamp','time','time'];return {columns,matches:columns.every((c,i)=>c.name===TIME_COLUMNS[i]&&c.dataType===types[i]&&c.nullable==='NO'&&(i<2||c.datetimePrecision===6))}
}
function timeNativeShape(n,index){
  const m=n.methods,count=(name)=>((m[name]?.success??0)+(m[name]?.failure??0))
  return m.connectConnection?.success>=1&&m.connectConnection.failure===0&&m.executeStatement?.success===(index<2?4:5)&&m.executeStatement.failure===0&&m.commitTransaction?.success>=1&&count('commitTransaction')===(index===3?2:1)&&count('applyEdits')===(index>=2?1:0)
}
function timeNativePassed(n,index){
  const m=n.methods,count=(name,success)=>(m[name]?.success??0)===success&&(m[name]?.failure??0)===0,r=n.temporal.lastApplyResult,s=n.temporal.lastObservedTransactionState
  return timeNativeShape(n,index)&&count('commitTransaction',index===3?2:1)&&count('applyEdits',index>=2?1:0)&&count('fetchCellValue',0)&&s?.active===(index===2)&&s.pendingAffected===(index===2?1:0)&&(index<2||(r?.ok===true&&r.affected===1&&r.inTransaction===true&&r.outcomeCount===1&&r.failedOutcomeCount===0&&r.errorClass==='none'))
}
async function watchTime(child,alive,signal,hostRoot,imageSha,oracle){
  const pid=child.pid,steps=[];let failureCode='NONE'
  try{
    need(integer(pid,2_147_483_647)&&pid>0,'TIME_CHILD_PID_INVALID')
    for(const step of TIME_STEPS){const path=join(hostRoot,'evidence',`time-checkpoint-${pid}-${step}.json`)
      while(absent(path)){if(!alive()||signal.aborted){if(steps.length>=1&&steps.every((r)=>r.ack?.verified===true))return {steps,failureCode:'PARTIAL_UI_FAILURE'};throw new RunFailure('TIME_WATCH_STOPPED')}await commitPause(signal)}
      need(alive()&&!signal.aborted,'TIME_WATCH_STOPPED');privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
      const bytes=timeFile(path,16*1024),checkpoint=JSON.parse(bytes.toString('utf8'));exact(checkpoint,['schemaVersion','runId','phase','pid','report','observations'],'TIME_CHECKPOINT_SCHEMA');need(checkpoint.schemaVersion===1&&checkpoint.runId===RUN&&checkpoint.phase==='grid-time'&&checkpoint.pid===pid&&checkpoint.report?.step===step,'TIME_CHECKPOINT_MISMATCH');timePayload(checkpoint.report);timeNative(checkpoint.observations)
      const record={step,checkpointSha256:hash(bytes),checkpoint,reference:null,columns:null,session:null,ack:null};steps.push(record)
      const reads=await Promise.allSettled([oracle.value?Promise.resolve(oracle.value):timeOracle(imageSha,signal),timeReference(imageSha,signal),timeColumns(imageSha,signal),sessionTimezoneReference(checkpoint.report.witnessConnectionId,imageSha,signal)])
      if(reads[0].status==='fulfilled')oracle.value=reads[0].value;if(reads[1].status==='fulfilled')record.reference=reads[1].value;if(reads[2].status==='fulfilled')record.columns=reads[2].value;if(reads[3].status==='fulfilled')record.session=reads[3].value
      const verified=reads.every((r)=>r.status==='fulfilled');await new Promise((done)=>setImmediate(done));need(alive()&&!signal.aborted,'TIME_WATCH_STOPPED');record.ack=publishTimeAck(hostRoot,pid,step,checkpoint.report,verified,alive);if(!verified)return {steps,failureCode:'TIME_STAGE_UNVERIFIED'}
    }
  }catch{failureCode='TIME_WATCH_FAILED'}return {steps,failureCode}
}
function timeFile(path,max){
  need(resolve(path)===path&&realpathSync(path)===path,'TIME_FILE_INVALID');const before=lstatSync(path)
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&(before.mode&0o777)===0o600&&before.size<=max,'TIME_FILE_INVALID');commitOwner(path)
  const fd=openSync(path,'r')
  try{const opened=fstatSync(fd);need(opened.dev===before.dev&&opened.ino===before.ino&&opened.uid===before.uid&&opened.isFile()&&opened.nlink===1&&(opened.mode&0o777)===0o600&&opened.size<=max,'TIME_FILE_INVALID');const bytes=readFileSync(fd),after=lstatSync(path),last=fstatSync(fd);need(bytes.length<=max&&last.size===bytes.length&&after.dev===opened.dev&&after.ino===opened.ino&&after.uid===opened.uid&&last.nlink===1&&(last.mode&0o777)===0o600&&realpathSync(path)===path,'TIME_FILE_CHANGED');return bytes}finally{closeSync(fd)}
}
function publishTimeAck(hostRoot,pid,step,proof,verified,alive){
  need(integer(pid,2_147_483_647)&&pid>0&&TIME_STEPS.includes(step)&&typeof verified==='boolean','TIME_ACK_SCHEMA');timePayload(proof);need(proof.step===step,'TIME_ACK_SCHEMA')
  const evidence=join(hostRoot,'evidence'),target=join(evidence,`time-ack-${pid}-${step}.json`),source=`${target}.pending`
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(hostRoot);commitOwner(evidence)
  need(resolve(source)===source&&resolve(target)===target&&dirname(source)===evidence&&dirname(target)===evidence&&absent(target)&&alive(),'TIME_ACK_PATH_INVALID')
  const ack={schemaVersion:1,runId:RUN,phase:'grid-time',pid,step,proof,verified},bytes=Buffer.from(`${JSON.stringify(ack)}\n`);need(bytes.length<=2048,'TIME_ACK_LIMIT')
  const fd=openSync(source,'wx',0o600);let owned
  try{let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);need(n>0,'TIME_ACK_WRITE');at+=n}fsyncSync(fd);owned=fstatSync(fd);need(owned.isFile()&&owned.nlink===1&&(owned.mode&0o777)===0o600&&owned.size===bytes.length,'TIME_ACK_FILE_INVALID')}finally{closeSync(fd)}
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(source);const actual=lstatSync(source)
  need(actual.isFile()&&!actual.isSymbolicLink()&&actual.nlink===1&&actual.dev===owned.dev&&actual.ino===owned.ino&&(actual.mode&0o777)===0o600&&realpathSync(source)===source&&resolve(source)===join(evidence,`time-ack-${pid}-${step}.json.pending`)&&resolve(target)===join(evidence,`time-ack-${pid}-${step}.json`)&&absent(target)&&alive(),'TIME_ACK_FILE_INVALID')
  // Absolute source and target above identify only this PID/step's pending and final files.
  renameSync(source,target);return ack
}
function timeNative(n){
  exact(n,['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified','temporal'],'TIME_NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='grid-time'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false&&n.methods&&typeof n.methods==='object'&&!Array.isArray(n.methods),'TIME_NATIVE_SCHEMA')
  for(const metric of Object.values(n.methods)){exact(metric,['success','failure','totalElapsedMs'],'TIME_NATIVE_SCHEMA');need(Object.values(metric).every((v)=>integer(v,100_000_000)),'TIME_NATIVE_SCHEMA')}
  for(const name of ['rollbackTransaction','addConnection','updateConnection','testConnection','insertRow','deleteRows'])need(!n.methods[name]||(n.methods[name].success===0&&n.methods[name].failure===0),'TIME_UNEXPECTED_METHOD')
  need([n.keyringGets,n.keyringHits,n.keyringSets].every((v)=>integer(v,10000))&&n.keyringSets===0&&n.keyringGets>=1&&n.keyringHits>=1,'TIME_KEYRING_MISSING')
  exact(n.temporal,['lastApplyResult','lastObservedTransactionState'],'TIME_NATIVE_SCHEMA')
  const result=n.temporal.lastApplyResult,state=n.temporal.lastObservedTransactionState
  if(result!==null){exact(result,['ok','affected','inTransaction','outcomeCount','failedOutcomeCount','errorClass'],'TIME_NATIVE_SCHEMA');need(typeof result.ok==='boolean'&&integer(result.affected,1000)&&typeof result.inTransaction==='boolean'&&integer(result.outcomeCount,1000)&&integer(result.failedOutcomeCount,1000)&&['none','other'].includes(result.errorClass),'TIME_NATIVE_SCHEMA')}
  if(state!==null){exact(state,['active','pendingAffected'],'TIME_NATIVE_SCHEMA');need(typeof state.active==='boolean'&&integer(state.pendingAffected,1_000_000),'TIME_NATIVE_SCHEMA')}
}
const CROSSZONE_STEPS=['baseline','shifted','restored']
const CROSSZONE_COLUMNS=['id','date_value','datetime_value','timestamp_value','time_wide','time_short']
const CROSSZONE_TYPES=['integer','date','date','date','text','text'],CROSSZONE_CATEGORIES=['integer','real','text','blob','null','boolean','date','unknown']
const CROSSZONE_PROJECTION=['session_timezone','date_text','datetime_text','timestamp_text','time_wide_text','time_short_text','datetime_microsecond','timestamp_microsecond','time_wide_microsecond','time_short_microsecond','timestamp_epoch']
const CROSSZONE_TZ=['+00:00','+08:00','+00:00']
const CROSSZONE_VALUES=[['1','2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 12:34:56.123456','-25:02:03.000002','01:02:03.000003'],['1','2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 20:34:56.123456','-25:02:03.000002','01:02:03.000003'],['1','2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 12:34:56.123456','-25:02:03.000002','01:02:03.000003']]
const CROSSZONE_PROJECTIONS=[['+00:00','2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 12:34:56.123456','-25:02:03.000002','01:02:03.000003','1','123456','2','3','1709210096.123456'],['+08:00','2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 20:34:56.123456','-25:02:03.000002','01:02:03.000003','1','123456','2','3','1709210096.123456'],['+00:00','2024-02-29','2024-02-29 12:34:56.000001','2024-02-29 12:34:56.123456','-25:02:03.000002','01:02:03.000003','1','123456','2','3','1709210096.123456']]
const CROSSZONE_TABS_BEFORE=[5,8,11],CROSSZONE_TABS_AFTER=[6,9,12],CROSSZONE_EXEC=[6,9,12]
const CROSSZONE_CHECKS=['storage_marker','persisted_connection','credential_reconnect','fixture_created','baseline_utc_display','shifted_plus08_display','restored_utc_display','non_ts_unchanged','epoch_invariant','microsecond_invariant','session_readback','same_connection','transaction_unchanged','observer_row_unchanged','session_restored']
const CROSSZONE_FAILURES=['NONE','ISOLATION','CONNECTION','FIXTURE_OPEN','SET_REJECTED','SESSION_READBACK_MISMATCH','TABLE_OPEN','DISPLAY_VALUE_MISMATCH','DISPLAY_TYPE_MISMATCH','NON_TS_MUTATED','EPOCH_MICROSECOND_LOST','CONNECTION_CHANGED','TRANSACTION_STARTED','SESSION_NOT_RESTORED','OBSERVER_MISMATCH','CHECKPOINT','TIMEOUT','NATIVE_BRIDGE']
const CROSSZONE_BUSINESS=['SESSION_READBACK_MISMATCH','DISPLAY_VALUE_MISMATCH','DISPLAY_TYPE_MISMATCH','NON_TS_MUTATED','EPOCH_MICROSECOND_LOST','CONNECTION_CHANGED','TRANSACTION_STARTED','SESSION_NOT_RESTORED','OBSERVER_MISMATCH']
const CROSSZONE_NATIVE_BASE=['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified']
const crosszoneSafeText=(value)=>typeof value==='string'&&value.length<=64&&!/[\u0000-\u001f\u007f]/.test(value)
const crosszoneSame=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
const crosszoneValuesHash=(values,types)=>hash(JSON.stringify({columns:CROSSZONE_COLUMNS,types,rows:[values]}))
const crosszoneProjectionHash=(row)=>hash(JSON.stringify({columns:CROSSZONE_PROJECTION,rows:[row]}))
function crosszonePayload(r){
  exact(r,['schemaVersion','step','uiActive','uiPendingAffected','dirtyRows','valuesSha256','witnessConnectionId','witnessProjectionSha256','sessionTimezone','resultTabsBefore','resultTabsAfter','activeTabGeneration','activeTabOwned','nativeExecuteCount'],'CROSSZONE_CHECKPOINT_SCHEMA')
  need(r.schemaVersion===1&&CROSSZONE_STEPS.includes(r.step)&&typeof r.uiActive==='boolean'&&integer(r.uiPendingAffected,1000)&&integer(r.dirtyRows,1000)&&hex(r.valuesSha256)&&Number.isSafeInteger(r.witnessConnectionId)&&r.witnessConnectionId>0&&hex(r.witnessProjectionSha256)&&crosszoneSafeText(r.sessionTimezone)&&integer(r.resultTabsBefore,1000)&&integer(r.resultTabsAfter,1000)&&r.resultTabsAfter===r.resultTabsBefore+1&&integer(r.activeTabGeneration,1000)&&typeof r.activeTabOwned==='boolean'&&integer(r.nativeExecuteCount,10000),'CROSSZONE_CHECKPOINT_SCHEMA')
}
function crosszoneStage(r){
  exact(r,['values','columnTypes','valuesSha256','witnessConnectionId','witnessProjection','witnessProjectionSha256','uiActive','uiPendingAffected','dirtyRows','sessionTimezone','resultTabsBefore','resultTabsAfter','activeTabGeneration','activeTabOwned','nativeExecuteCount'],'CROSSZONE_STAGE_SCHEMA')
  need(Array.isArray(r.values)&&r.values.length===6&&r.values.every((v)=>v===null||crosszoneSafeText(v))&&Array.isArray(r.columnTypes)&&r.columnTypes.length===6&&r.columnTypes.every((v)=>CROSSZONE_CATEGORIES.includes(v))&&hex(r.valuesSha256)&&r.valuesSha256===crosszoneValuesHash(r.values,r.columnTypes)&&Number.isSafeInteger(r.witnessConnectionId)&&r.witnessConnectionId>0&&Array.isArray(r.witnessProjection)&&r.witnessProjection.length===11&&r.witnessProjection.every((v)=>v===null||crosszoneSafeText(v))&&hex(r.witnessProjectionSha256)&&r.witnessProjectionSha256===crosszoneProjectionHash(r.witnessProjection)&&typeof r.uiActive==='boolean'&&integer(r.uiPendingAffected,1000)&&integer(r.dirtyRows,1000)&&crosszoneSafeText(r.sessionTimezone)&&integer(r.resultTabsBefore,1000)&&integer(r.resultTabsAfter,1000)&&r.resultTabsAfter===r.resultTabsBefore+1&&integer(r.activeTabGeneration,1000)&&typeof r.activeTabOwned==='boolean'&&integer(r.nativeExecuteCount,10000),'CROSSZONE_STAGE_SCHEMA')
}
function crosszoneNative(n){
  exact(n,[...CROSSZONE_NATIVE_BASE,'crosszone'],'CROSSZONE_NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='grid-time-crosszone'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false&&n.methods&&typeof n.methods==='object'&&!Array.isArray(n.methods),'CROSSZONE_NATIVE_SCHEMA')
  for(const metric of Object.values(n.methods)){exact(metric,['success','failure','totalElapsedMs'],'CROSSZONE_NATIVE_SCHEMA');need(Object.values(metric).every((v)=>integer(v,100_000_000)),'CROSSZONE_NATIVE_SCHEMA')}
  for(const name of ['rollbackTransaction','applyEdits','fetchCellValue','insertRow','deleteRows','addConnection','updateConnection','testConnection'])need(!n.methods[name]||(n.methods[name].success===0&&n.methods[name].failure===0),'CROSSZONE_UNEXPECTED_METHOD')
  need(n.methods.connectConnection?.success>=1&&n.methods.connectConnection.failure===0&&[n.keyringGets,n.keyringHits,n.keyringSets].every((v)=>integer(v,10000))&&n.keyringGets>=1&&n.keyringHits>=1&&n.keyringSets===0,'CROSSZONE_KEYRING_OR_CONNECTION_MISSING')
  const section=n.crosszone;need(section&&typeof section==='object'&&!Array.isArray(section),'CROSSZONE_NATIVE_SCHEMA')
  exact(section,['lastApplyResult','lastObservedTransactionState'],'CROSSZONE_NATIVE_SCHEMA')
  need(section.lastApplyResult===null,'CROSSZONE_NATIVE_SCHEMA')
  const state=section.lastObservedTransactionState
  need(state&&typeof state==='object'&&!Array.isArray(state),'CROSSZONE_NATIVE_SCHEMA')
  exact(state,['active','pendingAffected'],'CROSSZONE_NATIVE_SCHEMA')
  need(typeof state.active==='boolean'&&integer(state.pendingAffected,1_000_000),'CROSSZONE_NATIVE_SCHEMA')
  return state
}
function crosszoneNativeShape(n,index){
  const m=n.methods,count=(name)=>((m[name]?.success??0)+(m[name]?.failure??0))
  return m.connectConnection?.success>=1&&m.connectConnection.failure===0&&m.executeStatement?.success===CROSSZONE_EXEC[index]&&m.executeStatement.failure===0&&m.commitTransaction?.success===1&&m.commitTransaction.failure===0&&count('applyEdits')===0&&count('rollbackTransaction')===0&&count('fetchCellValue')===0&&count('insertRow')===0&&count('deleteRows')===0
}
function verifyCrosszone(value){
  exact(value,['schemaVersion','report','observations'],'HOST_REPORT_SCHEMA');need(value.schemaVersion===1,'HOST_REPORT_SCHEMA');const ui=value.report
  exact(ui,['schemaVersion','runId','phase','actionDriver','checks','proof','actions','elapsedMs','failureCode'],'CROSSZONE_REPORT_SCHEMA')
  need(ui.schemaVersion===1&&ui.runId===RUN&&ui.phase==='grid-time-crosszone'&&ui.actionDriver==='native-dom-synthetic'&&CROSSZONE_FAILURES.includes(ui.failureCode)&&integer(ui.elapsedMs,3600000),'CROSSZONE_REPORT_SCHEMA')
  exact(ui.checks,CROSSZONE_CHECKS,'CROSSZONE_CHECK_SCHEMA');need(Object.values(ui.checks).every((v)=>typeof v==='boolean'),'CROSSZONE_CHECK_SCHEMA')
  exact(ui.actions,['click','input','keydown','dblclick'],'CROSSZONE_ACTION_SCHEMA');need(Object.values(ui.actions).every((v)=>integer(v,10000)),'CROSSZONE_ACTION_SCHEMA')
  if(ui.proof!==null){const p=ui.proof;exact(p,['rowCount','columnCount','stages'],'CROSSZONE_PROOF_SCHEMA');need(p.rowCount===1&&p.columnCount===5,'CROSSZONE_PROOF_SCHEMA');exact(p.stages,CROSSZONE_STEPS,'CROSSZONE_PROOF_SCHEMA');need(p.stages.baseline!==null,'CROSSZONE_PROOF_SCHEMA');for(const step of CROSSZONE_STEPS)if(p.stages[step]!==null)crosszoneStage(p.stages[step])}
  crosszoneNative(value.observations);return {ui,native:value.observations}
}
const crosszoneTable=`\`mysql_accept_${RUN.slice(0,16)}\`.\`gui_time_crosszone_${RUN}\``
async function crosszoneOracle(imageSha,signal,index){
  need(Number.isInteger(index)&&index>=0&&index<CROSSZONE_STEPS.length,'CROSSZONE_ORACLE_INDEX')
  const lines=await timeSql('app',`${timeProjectionSql()} FROM ${crosszoneTable} WHERE id=1`,imageSha,signal,CROSSZONE_TZ[index])
  need(lines.length===1,'CROSSZONE_ORACLE_ROWS');const projection=lines[0].split('\t').map((v)=>v==='NULL'?null:v)
  need(projection.length===11&&projection.every((v)=>v===null||crosszoneSafeText(v)),'CROSSZONE_ORACLE_FORMAT')
  return {rowCount:1,projection,projectionSha256:crosszoneProjectionHash(projection),sessionTimezone:CROSSZONE_TZ[index]}
}
async function crosszoneObserver(imageSha,signal){
  const lines=await timeSql('observer',`${timeProjectionSql()} FROM ${crosszoneTable} WHERE id=1`,imageSha,signal)
  need(lines.length===1,'CROSSZONE_OBSERVER_ROWS');const projection=lines[0].split('\t').map((v)=>v==='NULL'?null:v)
  need(projection.length===11&&projection.every((v)=>v===null||crosszoneSafeText(v)),'CROSSZONE_OBSERVER_FORMAT')
  return {rowCount:1,projection,projectionSha256:crosszoneProjectionHash(projection),sessionTimezone:'+00:00'}
}
function publishCrosszoneAck(hostRoot,pid,step,proof,verified,alive){
  need(integer(pid,2_147_483_647)&&pid>0&&CROSSZONE_STEPS.includes(step)&&typeof verified==='boolean','CROSSZONE_ACK_SCHEMA');crosszonePayload(proof);need(proof.step===step,'CROSSZONE_ACK_SCHEMA')
  const evidence=join(hostRoot,'evidence'),target=join(evidence,`crosszone-ack-${pid}-${step}.json`),source=`${target}.pending`
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(hostRoot);commitOwner(evidence)
  need(resolve(source)===source&&resolve(target)===target&&dirname(source)===evidence&&dirname(target)===evidence&&absent(target)&&alive(),'CROSSZONE_ACK_PATH_INVALID')
  const ack={schemaVersion:1,runId:RUN,phase:'grid-time-crosszone',pid,step,proof,verified},bytes=Buffer.from(`${JSON.stringify(ack)}\n`);need(bytes.length<=2048,'CROSSZONE_ACK_LIMIT')
  const fd=openSync(source,'wx',0o600);let owned
  try{let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);need(n>0,'CROSSZONE_ACK_WRITE');at+=n}fsyncSync(fd);owned=fstatSync(fd);need(owned.isFile()&&owned.nlink===1&&(owned.mode&0o777)===0o600&&owned.size===bytes.length,'CROSSZONE_ACK_FILE_INVALID')}finally{closeSync(fd)}
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(source);const actual=lstatSync(source)
  need(actual.isFile()&&!actual.isSymbolicLink()&&actual.nlink===1&&actual.dev===owned.dev&&actual.ino===owned.ino&&(actual.mode&0o777)===0o600&&realpathSync(source)===source&&resolve(source)===join(evidence,`crosszone-ack-${pid}-${step}.json.pending`)&&resolve(target)===join(evidence,`crosszone-ack-${pid}-${step}.json`)&&absent(target)&&alive(),'CROSSZONE_ACK_FILE_INVALID')
  // Absolute source and target above identify only this PID/step's pending and final files.
  renameSync(source,target);return ack
}
async function watchCrosszone(child,alive,signal,hostRoot,imageSha){
  const pid=child.pid,steps=[];let failureCode='NONE'
  try{
    need(integer(pid,2_147_483_647)&&pid>0,'CROSSZONE_CHILD_PID_INVALID')
    for(const step of CROSSZONE_STEPS){
      const path=join(hostRoot,'evidence',`crosszone-checkpoint-${pid}-${step}.json`)
      while(absent(path)){if(!alive()||signal.aborted){if(steps.length>=1&&steps.every((r)=>r.ack?.verified===true))return {steps,failureCode:'PARTIAL_UI_FAILURE'};throw new RunFailure('CROSSZONE_WATCH_STOPPED')}await commitPause(signal)}
      need(alive()&&!signal.aborted,'CROSSZONE_WATCH_STOPPED');privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
      const bytes=timeFile(path,16*1024),checkpoint=JSON.parse(bytes.toString('utf8'));exact(checkpoint,['schemaVersion','runId','phase','pid','report','observations'],'CROSSZONE_CHECKPOINT_SCHEMA')
      need(checkpoint.schemaVersion===1&&checkpoint.runId===RUN&&checkpoint.phase==='grid-time-crosszone'&&checkpoint.pid===pid&&checkpoint.report?.step===step,'CROSSZONE_CHECKPOINT_MISMATCH');crosszonePayload(checkpoint.report);crosszoneNative(checkpoint.observations)
      const record={step,checkpointSha256:hash(bytes),checkpoint,oracle:null,observer:null,session:null,ack:null};steps.push(record)
      const index=CROSSZONE_STEPS.indexOf(step)
      // Every independent read happens inside this checkpoint window, before the single-writer ack.
      const reads=await Promise.allSettled([crosszoneOracle(imageSha,signal,index),crosszoneObserver(imageSha,signal),sessionTimezoneReference(checkpoint.report.witnessConnectionId,imageSha,signal)])
      if(reads[0].status==='fulfilled')record.oracle=reads[0].value;if(reads[1].status==='fulfilled')record.observer=reads[1].value;if(reads[2].status==='fulfilled')record.session=reads[2].value
      const verified=reads.every((r)=>r.status==='fulfilled')
      await new Promise((done)=>setImmediate(done));need(alive()&&!signal.aborted,'CROSSZONE_WATCH_STOPPED')
      record.ack=publishCrosszoneAck(hostRoot,pid,step,checkpoint.report,verified,alive);if(!verified)return {steps,failureCode:'CROSSZONE_STAGE_UNVERIFIED'}
    }
  }catch{failureCode='CROSSZONE_WATCH_FAILED'}return {steps,failureCode}
}
const TEXT_BASELINE_LONG='长😀'.repeat(800)+'|BASE-END|',TEXT_EDITED_LONG='改🚀'.repeat(900)+'|EDIT-END|'
const TEXT_BASELINE_JSON='{"largeInteger":9007199254740993,"message":"你好😀","nested":{"flag":true,"items":[1,"x",null]},"padding":"'+'J'.repeat(1200)+'"}'
const TEXT_EDITED_JSON='{"largeInteger":9007199254740995,"message":"改后🚀","nested":{"flag":false,"items":[2,"y",null]},"padding":"'+'K'.repeat(1300)+'"}'
const TEXT_STEPS=['baseline','draft','applied','committed']
const TEXT_CHECKS=['storage_marker','persisted_connection','credential_reconnect','fixture_created','table_open','preview_truncated','baseline_full','editor_full','local_edits','draft_full','apply_succeeded','uncommitted_transaction','applied_full','same_session_witness','normal_commit','committed_full','reloaded_exact_values','transaction_ended','json_integer_exact']
const TEXT_FAILURES=['NONE','ISOLATION','CONNECTION','SETUP','TREE','FULL_VALUE','EDIT','CHECKPOINT','BASELINE_MISMATCH','VALUE_LOSS','JSON_LOSS','PREVIEW','APPLY_FAILED','TRANSACTION_LOST','WITNESS_FAILED','COMMIT_FAILED','TIMEOUT','NATIVE_BRIDGE']
const TEXT_PROJECTION_COLUMNS=['long_chars','long_bytes','long_sha256','json_sha256','json_large_integer','json_integer_type','json_message_hex','json_exact_match']
const textProjectionHash=(row)=>hash(JSON.stringify({columns:TEXT_PROJECTION_COLUMNS,rows:[row]}))
const textValuesHash=(long,json)=>hash(JSON.stringify({columns:['id','long_text_sha256','json_text_sha256'],rows:[['1',long,json]]}))
function textExpectedProjection(json,edited){return [edited?'1810':'1610',edited?'6310':'5610',hash(edited?TEXT_EDITED_LONG:TEXT_BASELINE_LONG),hash(json),edited?'9007199254740995':'9007199254740993','UNSIGNED INTEGER',Buffer.from(edited?'改后🚀':'你好😀','utf8').toString('hex').toUpperCase(),edited?'1':'0']}
async function textOracle(imageSha,signal){
  const sql=`SELECT CAST(CAST('${TEXT_BASELINE_JSON}' AS JSON) AS CHAR),CAST(CAST('${TEXT_EDITED_JSON}' AS JSON) AS CHAR)`
  const lines=deadlockLines(await deadlockSql('observer',sql,imageSha,signal));need(lines.length===1,'TEXT_ORACLE_FORMAT');const values=lines[0].split('\t');need(values.length===2&&values.every((v)=>Buffer.byteLength(v)>1000&&Buffer.byteLength(v)<=8192&&!/[\u0000-\u001f]/.test(v)),'TEXT_ORACLE_FORMAT')
  need(/"largeInteger"\s*:\s*9007199254740993(?=\s*[,}])/.test(values[0])&&/"largeInteger"\s*:\s*9007199254740995(?=\s*[,}])/.test(values[1]),'TEXT_ORACLE_INTEGER')
  return {baselineJson:values[0],editedJson:values[1],baselineLongSha256:hash(TEXT_BASELINE_LONG),editedLongSha256:hash(TEXT_EDITED_LONG),baselineJsonSha256:hash(values[0]),editedJsonSha256:hash(values[1]),draftJsonSha256:hash(TEXT_EDITED_JSON),baselineValuesSha256:textValuesHash(hash(TEXT_BASELINE_LONG),hash(values[0])),draftValuesSha256:textValuesHash(hash(TEXT_EDITED_LONG),hash(TEXT_EDITED_JSON)),editedValuesSha256:textValuesHash(hash(TEXT_EDITED_LONG),hash(values[1])),baselineProjectionSha256:textProjectionHash(textExpectedProjection(values[0],false)),editedProjectionSha256:textProjectionHash(textExpectedProjection(values[1],true))}
}
async function textReference(imageSha,signal){
  const table=`\`mysql_accept_${RUN.slice(0,16)}\`.\`gui_txt_${RUN}\``
  const sql=`SELECT CHAR_LENGTH(long_text),OCTET_LENGTH(long_text),SHA2(long_text,256),SHA2(CAST(json_value AS CHAR),256),CAST(JSON_EXTRACT(json_value,'$.largeInteger') AS CHAR),JSON_TYPE(JSON_EXTRACT(json_value,'$.largeInteger')),HEX(JSON_UNQUOTE(JSON_EXTRACT(json_value,'$.message'))),SHA2(CAST(json_value AS CHAR),256)=SHA2(CAST(CAST('${TEXT_EDITED_JSON}' AS JSON) AS CHAR),256) AS json_exact_match FROM ${table} ORDER BY id`
  const lines=deadlockLines(await deadlockSql('observer',sql,imageSha,signal));need(lines.length===1,'TEXT_REFERENCE_ROWS');const row=lines[0].split('\t')
  need(row.length===8&&row.every((v)=>Buffer.byteLength(v)<=1024)&&/^[0-9]+$/.test(row[0])&&/^[0-9]+$/.test(row[1])&&hex(row[2])&&hex(row[3])&&!/[\u0000-\u001f]/.test(row[4])&&row[5].length>0&&/^(?:[0-9A-F]{2})*$/.test(row[6])&&['0','1'].includes(row[7]),'TEXT_REFERENCE_FORMAT')
  return {rowCount:1,projection:row,projectionSha256:textProjectionHash(row),autocommit:true,readOnly:true}
}
function textPreview(pair){need(Array.isArray(pair)&&pair.length===2,'TEXT_PREVIEW_SCHEMA');for(const p of pair){exact(p,['prefixSha256','prefixCodePoints','ellipsis'],'TEXT_PREVIEW_SCHEMA');need(hex(p.prefixSha256)&&integer(p.prefixCodePoints,16000)&&typeof p.ellipsis==='boolean','TEXT_PREVIEW_SCHEMA')}}
function textPreviewMatches(pair,full){if(!pair)return false;return pair.every((p,i)=>{const chars=Array.from(full[i]);return p.ellipsis&&p.prefixCodePoints>0&&p.prefixCodePoints<chars.length&&p.prefixSha256===hash(chars.slice(0,p.prefixCodePoints).join(''))})}
function verifyText(value){
  exact(value,['schemaVersion','report','observations'],'HOST_REPORT_SCHEMA');need(value.schemaVersion===1,'HOST_REPORT_SCHEMA');const ui=value.report
  exact(ui,['schemaVersion','runId','phase','actionDriver','checks','proof','actions','elapsedMs','failureCode'],'TEXT_REPORT_SCHEMA');need(ui.schemaVersion===1&&ui.runId===RUN&&ui.phase==='grid-text'&&ui.actionDriver==='native-dom-synthetic'&&TEXT_FAILURES.includes(ui.failureCode)&&integer(ui.elapsedMs),'TEXT_REPORT_SCHEMA')
  exact(ui.checks,TEXT_CHECKS,'TEXT_CHECK_SCHEMA');need(Object.values(ui.checks).every((v)=>typeof v==='boolean'),'TEXT_CHECK_SCHEMA');exact(ui.actions,['click','input','keydown','dblclick'],'TEXT_ACTION_SCHEMA');need(Object.values(ui.actions).every((v)=>integer(v,10000)),'TEXT_ACTION_SCHEMA')
  if(ui.proof!==null){const p=ui.proof;exact(p,['rowCount','editedColumns','baselineLongSha256','baselineJsonSha256','draftLongSha256','draftJsonSha256','appliedLongSha256','appliedJsonSha256','committedLongSha256','committedJsonSha256','baselineValuesSha256','draftValuesSha256','appliedValuesSha256','committedValuesSha256','uncommittedProjectionSha256','committedProjectionSha256','witnessConnectionId','uiActiveAfterApply','uiPendingAffectedAfterApply','dirtyRowsBeforeApply','dirtyRowsAfterApply','baselinePreview','appliedPreview','committedPreview'],'TEXT_PROOF_SCHEMA')
    need(p.rowCount===1&&p.editedColumns===2&&hex(p.baselineLongSha256)&&hex(p.baselineJsonSha256)&&hex(p.baselineValuesSha256)&&['draftLongSha256','draftJsonSha256','appliedLongSha256','appliedJsonSha256','committedLongSha256','committedJsonSha256','draftValuesSha256','appliedValuesSha256','committedValuesSha256','uncommittedProjectionSha256','committedProjectionSha256'].every((key)=>p[key]===null||hex(p[key]))&&(p.witnessConnectionId===null||(Number.isSafeInteger(p.witnessConnectionId)&&p.witnessConnectionId>0))&&(p.uiActiveAfterApply===null||typeof p.uiActiveAfterApply==='boolean')&&(p.uiPendingAffectedAfterApply===null||integer(p.uiPendingAffectedAfterApply,1000))&&[p.dirtyRowsBeforeApply,p.dirtyRowsAfterApply].every((v)=>v===null||integer(v,1)),'TEXT_PROOF_SCHEMA');textPreview(p.baselinePreview);if(p.appliedPreview!==null)textPreview(p.appliedPreview);if(p.committedPreview!==null)textPreview(p.committedPreview)
  }
  textNative(value.observations);return {ui,native:value.observations}
}
const SESSION_TIMEZONE_STEPS=['baseline','offset','restored']
const SESSION_TIMEZONE_COLUMNS=['session_timezone','system_timezone','autocommit','wall_epoch']
const SESSION_TIMEZONE_CHECKS=['storage_marker','persisted_connection','credential_reconnect','baseline_observed','offset_set','offset_readback','restored_set','restored_readback','same_connection','transaction_unchanged']
const SESSION_TIMEZONE_FAILURES=['NONE','ISOLATION','CONNECTION','BASELINE_FAILED','SET_REJECTED','SESSION_MISMATCH','AUTOCOMMIT_CHANGED','EPOCH_LOSS','CONNECTION_CHANGED','TRANSACTION_CHANGED','CHECKPOINT','TIMEOUT','NATIVE_BRIDGE']
const sessionTimezoneHash=(row)=>hash(JSON.stringify({columns:SESSION_TIMEZONE_COLUMNS,rows:[row]}))
const sessionTimezoneSafeText=(value)=>typeof value==='string'&&value.length<=64&&!/[\u0000-\u001f\u007f]/.test(value)
function sessionTimezonePayload(r){
  exact(r,['schemaVersion','step','uiActive','uiPendingAffected','projectionSha256','connectionId','setFailed','autocommit'],'SESSION_TIMEZONE_CHECKPOINT_SCHEMA')
  need(r.schemaVersion===1&&SESSION_TIMEZONE_STEPS.includes(r.step)&&typeof r.uiActive==='boolean'&&integer(r.uiPendingAffected,1000)&&hex(r.projectionSha256)&&Number.isSafeInteger(r.connectionId)&&r.connectionId>0&&typeof r.setFailed==='boolean'&&typeof r.autocommit==='boolean','SESSION_TIMEZONE_CHECKPOINT_SCHEMA')
  if(r.step==='baseline')need(!r.setFailed&&!r.uiActive&&r.uiPendingAffected===0&&r.autocommit,'SESSION_TIMEZONE_CHECKPOINT_MISMATCH')
}
function sessionTimezoneNative(n){
  exact(n,['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified','sessionTimezone'],'SESSION_TIMEZONE_NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='session-timezone'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false&&n.methods&&typeof n.methods==='object'&&!Array.isArray(n.methods),'SESSION_TIMEZONE_NATIVE_SCHEMA')
  for(const metric of Object.values(n.methods)){exact(metric,['success','failure','totalElapsedMs'],'SESSION_TIMEZONE_NATIVE_SCHEMA');need(Object.values(metric).every((v)=>integer(v,100_000_000)),'SESSION_TIMEZONE_NATIVE_SCHEMA')}
  for(const name of ['commitTransaction','rollbackTransaction','applyEdits','insertRow','deleteRows','fetchCellValue','addConnection','updateConnection','testConnection'])need(!n.methods[name]||(n.methods[name].success===0&&n.methods[name].failure===0),'SESSION_TIMEZONE_UNEXPECTED_METHOD')
  need(n.methods.connectConnection?.success>=1&&n.methods.connectConnection.failure===0&&[n.keyringGets,n.keyringHits,n.keyringSets].every((v)=>integer(v,10000))&&n.keyringGets>=1&&n.keyringHits>=1&&n.keyringSets===0,'SESSION_TIMEZONE_KEYRING_OR_CONNECTION_MISSING')
  exact(n.sessionTimezone,['lastObservedTransactionState'],'SESSION_TIMEZONE_NATIVE_SCHEMA');const state=n.sessionTimezone.lastObservedTransactionState
  if(state!==null){exact(state,['active','pendingAffected'],'SESSION_TIMEZONE_NATIVE_SCHEMA');need(typeof state.active==='boolean'&&integer(state.pendingAffected,1_000_000),'SESSION_TIMEZONE_NATIVE_SCHEMA')}
}
function sessionTimezoneNativePassed(n,index){const state=n.sessionTimezone.lastObservedTransactionState;return n.methods.executeStatement?.success===1+2*index&&n.methods.executeStatement.failure===0&&state?.active===false&&state.pendingAffected===0}
async function sessionTimezoneOracle(imageSha,signal){
  need(!signal?.aborted,'SESSION_TIMEZONE_ORACLE_ABORTED');await commitLive(imageSha,signal);need(!signal?.aborted,'SESSION_TIMEZONE_ORACLE_ABORTED')
  const epoch="CAST(UNIX_TIMESTAMP(CAST('2024-02-29 12:34:56.123456' AS DATETIME(6))) AS CHAR)"
  const sql=`SET SESSION autocommit=1; SET SESSION TRANSACTION READ ONLY; SELECT @@global.time_zone,@@session.time_zone,@@system_time_zone,@@global.autocommit,@@session.autocommit,${epoch},@@session.transaction_read_only; SET SESSION time_zone = '+08:00'; SELECT @@session.time_zone,@@system_time_zone,@@session.autocommit,${epoch},@@session.transaction_read_only; SET SESSION time_zone = '+00:00'; SELECT @@session.time_zone,@@system_time_zone,@@session.autocommit,${epoch},@@session.transaction_read_only`
  const text=await new Promise((done,reject)=>execFile('docker',['exec','--user','0:0',CONTAINER,'mysql','--defaults-extra-file=/fixture/app-client.cnf','--connect-timeout=5','--batch','--raw','--skip-column-names','--execute',sql],{cwd:ROOT,encoding:'utf8',timeout:15000,maxBuffer:16*1024,signal},(error,stdout)=>error?reject(new RunFailure('SESSION_TIMEZONE_ORACLE_FAILED')):done(stdout)))
  need(Buffer.byteLength(text)<=4096&&!text.includes('\r')&&!text.includes('\u0000'),'SESSION_TIMEZONE_ORACLE_FORMAT');const lines=(text.endsWith('\n')?text.slice(0,-1):text).split('\n');need(lines.length===3,'SESSION_TIMEZONE_ORACLE_FORMAT')
  const first=lines[0].split('\t'),offset=lines[1].split('\t'),restored=lines[2].split('\t')
  need(first.length===7&&first[0]==='+00:00'&&first[1]==='+00:00'&&first[2]==='UTC'&&first[3]==='1'&&first[4]==='1'&&first[5]==='1709210096.123456'&&first[6]==='1','SESSION_TIMEZONE_ORACLE_BASELINE')
  need(offset.length===5&&offset.join('\t')==='+08:00\tUTC\t1\t1709181296.123456\t1'&&restored.length===5&&restored.join('\t')==='+00:00\tUTC\t1\t1709210096.123456\t1','SESSION_TIMEZONE_ORACLE_OFFSETS')
  return {globalTimezone:first[0],globalAutocommit:true,baseline:first.slice(1,3).concat(first.slice(4,6)),offset:offset.slice(0,4),restored:restored.slice(0,4),readOnly:true,offsetSetVerified:true,restoreSetVerified:true}
}
async function sessionTimezoneReference(id,imageSha,signal){
  need(Number.isSafeInteger(id)&&id>0,'SESSION_TIMEZONE_GUI_ID_INVALID');const db=`mysql_accept_${RUN.slice(0,16)}`
  const sql=`SELECT t.PROCESSLIST_ID,v.VARIABLE_NAME,v.VARIABLE_VALUE FROM performance_schema.threads t JOIN performance_schema.variables_by_thread v ON v.THREAD_ID=t.THREAD_ID WHERE t.PROCESSLIST_ID=${id} AND t.PROCESSLIST_DB='${db}' AND t.PROCESSLIST_ID<>CONNECTION_ID() AND v.VARIABLE_NAME IN ('time_zone','autocommit') ORDER BY v.VARIABLE_NAME; SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id=${id}; SELECT @@system_time_zone`
  const lines=deadlockLines(await deadlockSql('admin',sql,imageSha,signal));need(lines.length===4,'SESSION_TIMEZONE_REFERENCE_MISSING')
  const ac=lines[0].split('\t'),tz=lines[1].split('\t')
  need(ac.length===3&&tz.length===3&&ac[0]===String(id)&&tz[0]===String(id)&&ac[1]==='autocommit'&&tz[1]==='time_zone'&&['ON','OFF'].includes(ac[2])&&sessionTimezoneSafeText(tz[2])&&/^[0-9]+$/.test(lines[2])&&Number.isSafeInteger(Number(lines[2]))&&sessionTimezoneSafeText(lines[3]),'SESSION_TIMEZONE_REFERENCE_FORMAT')
  return {connectionId:id,sessionTimezone:tz[2],systemTimezone:lines[3],autocommit:ac[2]==='ON',autocommitVariable:ac[2],transactionCount:Number(lines[2]),ownedDatabaseVerified:true}
}
async function sessionTimezoneEnded(ids,imageSha){
  need(Array.isArray(ids)&&ids.length>0&&ids.length<=3&&ids.every((id)=>Number.isSafeInteger(id)&&id>0),'SESSION_TIMEZONE_KNOWN_IDS_INVALID')
  const list=ids.join(','),lines=deadlockLines(await deadlockSql('admin',`SELECT COUNT(*) FROM performance_schema.threads WHERE PROCESSLIST_ID IN (${list}); SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id IN (${list})`,imageSha))
  need(lines.length===2&&lines[0]==='0'&&lines[1]==='0','SESSION_TIMEZONE_FINAL_SESSIONS_ACTIVE');return {knownConnectionIds:ids,threadCount:0,transactionCount:0,ended:true}
}
async function watchSessionTimezone(child,alive,signal,hostRoot,imageSha,oracle){
  const pid=child.pid,steps=[];let failureCode='NONE'
  try{
    need(integer(pid,2_147_483_647)&&pid>0,'SESSION_TIMEZONE_CHILD_PID_INVALID')
    for(const step of SESSION_TIMEZONE_STEPS){const path=join(hostRoot,'evidence',`session-timezone-checkpoint-${pid}-${step}.json`)
      while(absent(path)){if(!alive()||signal.aborted){if(step==='restored'&&steps.length===2&&steps.every((r)=>r.ack?.verified===true))return {steps,failureCode:'PARTIAL_UI_FAILURE'};throw new RunFailure('SESSION_TIMEZONE_WATCH_STOPPED')}await commitPause(signal)}
      need(alive()&&!signal.aborted,'SESSION_TIMEZONE_WATCH_STOPPED');privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
      const bytes=sessionTimezoneFile(path,16*1024),checkpoint=JSON.parse(bytes.toString('utf8'));exact(checkpoint,['schemaVersion','runId','phase','pid','report','observations'],'SESSION_TIMEZONE_CHECKPOINT_SCHEMA')
      need(checkpoint.schemaVersion===1&&checkpoint.runId===RUN&&checkpoint.phase==='session-timezone'&&checkpoint.pid===pid&&checkpoint.report?.step===step,'SESSION_TIMEZONE_CHECKPOINT_MISMATCH');sessionTimezonePayload(checkpoint.report);sessionTimezoneNative(checkpoint.observations)
      const record={step,checkpointSha256:hash(bytes),checkpoint,reference:null,ack:null};steps.push(record);let verified=false
      try{if(!oracle.value)oracle.value=await sessionTimezoneOracle(imageSha,signal);record.reference=await sessionTimezoneReference(checkpoint.report.connectionId,imageSha,signal);verified=true}catch{/* Reference failure never authorizes the next normal SET. */}
      await new Promise((done)=>setImmediate(done));need(alive()&&!signal.aborted,'SESSION_TIMEZONE_WATCH_STOPPED');record.ack=publishSessionTimezoneAck(hostRoot,pid,step,checkpoint.report,verified,alive);if(!verified)return {steps,failureCode:'SESSION_TIMEZONE_STAGE_UNVERIFIED'}
    }
  }catch{failureCode='SESSION_TIMEZONE_WATCH_FAILED'}return {steps,failureCode}
}
function verifySessionTimezone(value){
  exact(value,['schemaVersion','report','observations'],'HOST_REPORT_SCHEMA');need(value.schemaVersion===1,'HOST_REPORT_SCHEMA');const ui=value.report
  exact(ui,['schemaVersion','runId','phase','actionDriver','checks','proof','actions','elapsedMs','failureCode'],'SESSION_TIMEZONE_REPORT_SCHEMA');need(ui.schemaVersion===1&&ui.runId===RUN&&ui.phase==='session-timezone'&&ui.actionDriver==='native-dom-synthetic'&&SESSION_TIMEZONE_FAILURES.includes(ui.failureCode)&&integer(ui.elapsedMs),'SESSION_TIMEZONE_REPORT_SCHEMA')
  exact(ui.checks,SESSION_TIMEZONE_CHECKS,'SESSION_TIMEZONE_CHECK_SCHEMA');need(Object.values(ui.checks).every((v)=>typeof v==='boolean'),'SESSION_TIMEZONE_CHECK_SCHEMA');exact(ui.actions,['click','input','keydown','dblclick'],'SESSION_TIMEZONE_ACTION_SCHEMA');need(Object.values(ui.actions).every((v)=>integer(v,10000)),'SESSION_TIMEZONE_ACTION_SCHEMA')
  if(ui.proof!==null){exact(ui.proof,['rowCount','baseline','offset','restored'],'SESSION_TIMEZONE_PROOF_SCHEMA');need(ui.proof.rowCount===1&&ui.proof.baseline!==null,'SESSION_TIMEZONE_PROOF_SCHEMA')
    for(const step of SESSION_TIMEZONE_STEPS){const stage=ui.proof[step];if(stage===null){need(step!=='baseline','SESSION_TIMEZONE_PROOF_SCHEMA');continue}exact(stage,['connectionId','sessionTimezone','systemTimezone','autocommit','epochText','projectionSha256','setFailed','uiActive','uiPendingAffected'],'SESSION_TIMEZONE_STAGE_SCHEMA');need(Number.isSafeInteger(stage.connectionId)&&stage.connectionId>0&&[stage.sessionTimezone,stage.systemTimezone,stage.epochText].every(sessionTimezoneSafeText)&&typeof stage.autocommit==='boolean'&&hex(stage.projectionSha256)&&typeof stage.setFailed==='boolean'&&typeof stage.uiActive==='boolean'&&integer(stage.uiPendingAffected,1000)&&stage.projectionSha256===sessionTimezoneHash([stage.sessionTimezone,stage.systemTimezone,stage.autocommit?'1':'0',stage.epochText]),'SESSION_TIMEZONE_STAGE_SCHEMA')}
  }
  sessionTimezoneNative(value.observations);return {ui,native:value.observations}
}
function sessionTimezoneFile(path,max){
  need(resolve(path)===path&&realpathSync(path)===path,'SESSION_TIMEZONE_FILE_INVALID');const before=lstatSync(path)
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&(before.mode&0o777)===0o600&&before.size<=max,'SESSION_TIMEZONE_FILE_INVALID');commitOwner(path)
  const fd=openSync(path,'r')
  try{const opened=fstatSync(fd);need(opened.dev===before.dev&&opened.ino===before.ino&&opened.uid===before.uid&&opened.isFile()&&opened.nlink===1&&(opened.mode&0o777)===0o600&&opened.size<=max,'SESSION_TIMEZONE_FILE_INVALID');const bytes=readFileSync(fd),after=lstatSync(path),last=fstatSync(fd);need(bytes.length<=max&&last.size===bytes.length&&after.dev===opened.dev&&after.ino===opened.ino&&after.uid===opened.uid&&last.nlink===1&&(last.mode&0o777)===0o600&&realpathSync(path)===path,'SESSION_TIMEZONE_FILE_CHANGED');return bytes}finally{closeSync(fd)}
}
function publishSessionTimezoneAck(hostRoot,pid,step,proof,verified,alive){
  need(integer(pid,2_147_483_647)&&pid>0&&SESSION_TIMEZONE_STEPS.includes(step)&&typeof verified==='boolean','SESSION_TIMEZONE_ACK_SCHEMA');sessionTimezonePayload(proof);need(proof.step===step,'SESSION_TIMEZONE_ACK_SCHEMA')
  const evidence=join(hostRoot,'evidence'),target=join(evidence,`session-timezone-ack-${pid}-${step}.json`),source=`${target}.pending`
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(hostRoot);commitOwner(evidence)
  need(resolve(source)===source&&resolve(target)===target&&dirname(source)===evidence&&dirname(target)===evidence&&absent(target)&&alive(),'SESSION_TIMEZONE_ACK_PATH_INVALID')
  const ack={schemaVersion:1,runId:RUN,phase:'session-timezone',pid,step,proof,verified},bytes=Buffer.from(`${JSON.stringify(ack)}\n`);need(bytes.length<=2048,'SESSION_TIMEZONE_ACK_LIMIT')
  const fd=openSync(source,'wx',0o600);let owned
  try{let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);need(n>0,'SESSION_TIMEZONE_ACK_WRITE');at+=n}fsyncSync(fd);owned=fstatSync(fd);need(owned.isFile()&&owned.nlink===1&&(owned.mode&0o777)===0o600&&owned.size===bytes.length,'SESSION_TIMEZONE_ACK_FILE_INVALID')}finally{closeSync(fd)}
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(source);const actual=lstatSync(source)
  need(actual.isFile()&&!actual.isSymbolicLink()&&actual.nlink===1&&actual.dev===owned.dev&&actual.ino===owned.ino&&(actual.mode&0o777)===0o600&&realpathSync(source)===source&&resolve(source)===join(evidence,`session-timezone-ack-${pid}-${step}.json.pending`)&&resolve(target)===join(evidence,`session-timezone-ack-${pid}-${step}.json`)&&absent(target)&&alive(),'SESSION_TIMEZONE_ACK_FILE_INVALID')
  // Absolute source and target above identify only this PID/step's pending and final files.
  renameSync(source,target);return ack
}
function textFile(path,max){
  need(resolve(path)===path&&realpathSync(path)===path,'TEXT_FILE_INVALID');const before=lstatSync(path)
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&(before.mode&0o777)===0o600&&before.size<=max,'TEXT_FILE_INVALID');commitOwner(path)
  const fd=openSync(path,'r')
  try{const opened=fstatSync(fd);need(opened.dev===before.dev&&opened.ino===before.ino&&opened.uid===before.uid&&opened.isFile()&&opened.nlink===1&&(opened.mode&0o777)===0o600&&opened.size<=max,'TEXT_FILE_INVALID');const bytes=readFileSync(fd),after=lstatSync(path),last=fstatSync(fd);need(bytes.length<=max&&last.size===bytes.length&&after.dev===opened.dev&&after.ino===opened.ino&&after.uid===opened.uid&&last.nlink===1&&(last.mode&0o777)===0o600&&realpathSync(path)===path,'TEXT_FILE_CHANGED');return bytes}finally{closeSync(fd)}
}
function publishTextAck(hostRoot,pid,step,proof,verified,alive){
  need(integer(pid,2_147_483_647)&&pid>0&&TEXT_STEPS.includes(step)&&typeof verified==='boolean','TEXT_ACK_SCHEMA');textPayload(proof);need(proof.step===step,'TEXT_ACK_SCHEMA')
  const evidence=join(hostRoot,'evidence'),target=join(evidence,`text-ack-${pid}-${step}.json`),source=`${target}.pending`
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(hostRoot);commitOwner(evidence)
  need(resolve(source)===source&&resolve(target)===target&&dirname(source)===evidence&&dirname(target)===evidence&&absent(target)&&alive(),'TEXT_ACK_PATH_INVALID')
  const ack={schemaVersion:1,runId:RUN,phase:'grid-text',pid,step,proof,verified},bytes=Buffer.from(`${JSON.stringify(ack)}\n`);need(bytes.length<=2048,'TEXT_ACK_LIMIT')
  const fd=openSync(source,'wx',0o600);let owned
  try{let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);need(n>0,'TEXT_ACK_WRITE');at+=n}fsyncSync(fd);owned=fstatSync(fd);need(owned.isFile()&&owned.nlink===1&&(owned.mode&0o777)===0o600&&owned.size===bytes.length,'TEXT_ACK_FILE_INVALID')}finally{closeSync(fd)}
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(source);const actual=lstatSync(source)
  need(actual.isFile()&&!actual.isSymbolicLink()&&actual.nlink===1&&actual.dev===owned.dev&&actual.ino===owned.ino&&(actual.mode&0o777)===0o600&&realpathSync(source)===source&&resolve(source)===join(evidence,`text-ack-${pid}-${step}.json.pending`)&&resolve(target)===join(evidence,`text-ack-${pid}-${step}.json`)&&absent(target)&&alive(),'TEXT_ACK_FILE_INVALID')
  // Absolute source and target above identify only this PID/step's pending and final files.
  renameSync(source,target);return ack
}
function textPayload(r){
  exact(r,['schemaVersion','step','uiActive','uiPendingAffected','dirtyRows','valuesSha256','witnessConnectionId','witnessProjectionSha256'],'TEXT_CHECKPOINT_SCHEMA')
  need(r.schemaVersion===1&&TEXT_STEPS.includes(r.step)&&typeof r.uiActive==='boolean'&&integer(r.uiPendingAffected,1000)&&integer(r.dirtyRows,1)&&hex(r.valuesSha256)&&(r.witnessConnectionId===null||(Number.isSafeInteger(r.witnessConnectionId)&&r.witnessConnectionId>0))&&(r.witnessProjectionSha256===null||hex(r.witnessProjectionSha256)),'TEXT_CHECKPOINT_SCHEMA')
  if(r.step==='baseline')need(!r.uiActive&&r.uiPendingAffected===0&&r.dirtyRows===0&&r.witnessConnectionId===null&&r.witnessProjectionSha256===null,'TEXT_CHECKPOINT_MISMATCH')
  if(r.step==='committed')need(!r.uiActive&&r.uiPendingAffected===0&&r.dirtyRows===0&&r.witnessConnectionId>0&&hex(r.witnessProjectionSha256),'TEXT_CHECKPOINT_MISMATCH')
}
function textNative(n){
  exact(n,['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified','text'],'TEXT_NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='grid-text'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false&&n.methods&&typeof n.methods==='object'&&!Array.isArray(n.methods),'TEXT_NATIVE_SCHEMA')
  for(const metric of Object.values(n.methods)){exact(metric,['success','failure','totalElapsedMs'],'TEXT_NATIVE_SCHEMA');need(Object.values(metric).every((v)=>integer(v,100_000_000)),'TEXT_NATIVE_SCHEMA')}
  for(const name of ['rollbackTransaction','addConnection','updateConnection','testConnection','insertRow','deleteRows'])need(!n.methods[name]||(n.methods[name].success===0&&n.methods[name].failure===0),'TEXT_UNEXPECTED_METHOD')
  need([n.keyringGets,n.keyringHits,n.keyringSets].every((v)=>integer(v,10000))&&n.keyringSets===0&&n.keyringGets>=1&&n.keyringHits>=1,'TEXT_KEYRING_MISSING')
  exact(n.text,['lastApplyResult','lastObservedTransactionState'],'TEXT_NATIVE_SCHEMA')
  const result=n.text.lastApplyResult,state=n.text.lastObservedTransactionState
  if(result!==null){exact(result,['ok','affected','inTransaction','outcomeCount','failedOutcomeCount','errorClass'],'TEXT_NATIVE_SCHEMA');need(typeof result.ok==='boolean'&&integer(result.affected,1000)&&typeof result.inTransaction==='boolean'&&integer(result.outcomeCount,1000)&&integer(result.failedOutcomeCount,1000)&&['none','other'].includes(result.errorClass),'TEXT_NATIVE_SCHEMA')}
  if(state!==null){exact(state,['active','pendingAffected'],'TEXT_NATIVE_SCHEMA');need(typeof state.active==='boolean'&&integer(state.pendingAffected,1_000_000),'TEXT_NATIVE_SCHEMA')}
}
function textBaselineBusinessPassed(n){
  const methods=n.methods,state=n.text.lastObservedTransactionState
  return methods.connectConnection?.success>=1&&methods.connectConnection.failure===0&&methods.executeStatement?.success===2&&methods.executeStatement.failure===0&&methods.commitTransaction?.success===1&&methods.commitTransaction.failure===0
    &&(methods.applyEdits?.success??0)===0&&(methods.applyEdits?.failure??0)===0&&(methods.rollbackTransaction?.success??0)===0&&(methods.rollbackTransaction?.failure??0)===0
    &&state?.active===false&&state.pendingAffected===0&&n.keyringGets>=1&&n.keyringHits>=1&&n.keyringSets===0
}
function textNativePassed(n,step){
  const count=(name,success)=>n.methods[name]?.success===success&&n.methods[name].failure===0
  const applied=['applied','committed'].includes(step),r=n.text.lastApplyResult,state=n.text.lastObservedTransactionState
  if(!count('fetchCellValue',(TEXT_STEPS.indexOf(step)+1)*2))return false
  return n.methods.connectConnection?.success>=1&&n.methods.connectConnection.failure===0&&count('executeStatement',applied?3:2)&&count('commitTransaction',step==='committed'?2:1)
    &&(applied?count('applyEdits',1):(!n.methods.applyEdits||(n.methods.applyEdits.success===0&&n.methods.applyEdits.failure===0)))
    &&(!applied||(r?.ok===true&&r.affected===1&&r.inTransaction===true&&r.outcomeCount===1&&r.failedOutcomeCount===0&&r.errorClass==='none'))
    &&state?.active===(step==='applied')&&state?.pendingAffected===(step==='applied'?1:0)
}
async function textTransactionEnded(id,imageSha,signal){need(Number.isSafeInteger(id)&&id>0,'TEXT_GUI_ID_INVALID');const lines=deadlockLines(await deadlockSql('admin',`SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id=${id}`,imageSha,signal));need(lines.length===1&&lines[0]==='0','TEXT_FINAL_TRANSACTION_ACTIVE');return true}
async function textDatabaseEnded(imageSha){
  const db=`mysql_accept_${RUN.slice(0,16)}`,table=`gui_txt_${RUN}`,stop=new AbortController(),end=Date.now()+3000,timer=setTimeout(()=>stop.abort(),3000);let observed=null
  try{do{
    const sql=`SELECT (SELECT COUNT(*) FROM performance_schema.threads t WHERE t.TYPE='FOREGROUND' AND t.PROCESSLIST_DB='${db}' AND t.PROCESSLIST_ID<>CONNECTION_ID()),(SELECT COUNT(*) FROM information_schema.innodb_trx x JOIN performance_schema.threads t ON t.PROCESSLIST_ID=x.trx_mysql_thread_id WHERE t.PROCESSLIST_DB='${db}' AND t.PROCESSLIST_ID<>CONNECTION_ID()),(SELECT COUNT(*) FROM performance_schema.data_locks l WHERE l.OBJECT_SCHEMA='${db}' AND l.OBJECT_NAME='${table}')`
    const lines=deadlockLines(await deadlockSql('admin',sql,imageSha,stop.signal));need(lines.length===1,'TEXT_DB_CLEANUP_FORMAT');const fields=lines[0].split('\t');need(fields.length===3&&fields.every((v)=>/^[0-9]+$/.test(v)&&Number.isSafeInteger(Number(v))),'TEXT_DB_CLEANUP_FORMAT')
    observed={scope:'owned-db-no-known-id',foregroundSessions:Number(fields[0]),inTransactionSessions:Number(fields[1]),tableLocks:Number(fields[2]),ended:fields.every((v)=>v==='0')}
    if(observed.ended)return observed;await commitPause(stop.signal)
  }while(!stop.signal.aborted&&Date.now()<end)}catch{/* Unknown or nonzero cleanup observations cannot promote a real-red claim. */}finally{clearTimeout(timer)}
  return observed??{scope:'owned-db-no-known-id',foregroundSessions:null,inTransactionSessions:null,tableLocks:null,ended:false}
}
async function watchText(child,alive,signal,hostRoot,imageSha,oracle){
  const pid=child.pid,steps=[];let failureCode='NONE'
  try{
    need(integer(pid,2_147_483_647)&&pid>0,'TEXT_CHILD_PID_INVALID')
    for(const step of TEXT_STEPS){const path=join(hostRoot,'evidence',`text-checkpoint-${pid}-${step}.json`)
      while(absent(path)){if(!alive()||signal.aborted){if(steps.length>=1&&steps.every((r)=>r.ack?.verified===true))return {steps,failureCode:'PARTIAL_UI_FAILURE'};throw new RunFailure('TEXT_WATCH_STOPPED')}await commitPause(signal)}
      need(alive()&&!signal.aborted,'TEXT_WATCH_STOPPED');privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
      const bytes=textFile(path,16*1024),checkpoint=JSON.parse(bytes.toString('utf8'));exact(checkpoint,['schemaVersion','runId','phase','pid','report','observations'],'TEXT_CHECKPOINT_SCHEMA')
      need(checkpoint.schemaVersion===1&&checkpoint.runId===RUN&&checkpoint.phase==='grid-text'&&checkpoint.pid===pid&&checkpoint.report?.step===step,'TEXT_CHECKPOINT_MISMATCH');textPayload(checkpoint.report);textNative(checkpoint.observations)
      const record={step,checkpointSha256:hash(bytes),checkpoint,reference:null,ack:null};steps.push(record);let verified=false
      try{if(!oracle.value)oracle.value=await textOracle(imageSha,signal);record.reference=await textReference(imageSha,signal);verified=true}catch{/* Unknown observation publishes only a negative ack. */}
      await new Promise((done)=>setImmediate(done));need(alive()&&!signal.aborted,'TEXT_WATCH_STOPPED');record.ack=publishTextAck(hostRoot,pid,step,checkpoint.report,verified,alive);if(!verified)return {steps,failureCode:'TEXT_STAGE_UNVERIFIED'}
    }
  }catch{failureCode='TEXT_WATCH_FAILED'}return {steps,failureCode}
}
const PRECISION_COLUMNS=['id','unsigned_big','signed_big','exact_decimal','utf8_text','nullable_text','empty_text']
const PRECISION_PROJECTION=['unsigned_big','signed_big','exact_decimal','utf8_hex','nullable_is_null','nullable_hex','empty_is_null','empty_hex']
const PRECISION_BASELINE=['1','18446744073709551615','-9223372036854775808','12345678901234567890123456789012345.123456789012345678901234567890','种子-你好-😀',null,'']
const PRECISION_EDITED=['1','18446744073709551614','-9223372036854775807','-98765432109876543210987654321012345.987654321098765432109876543210','编辑-你好-🚀','',null]
const PRECISION_STEPS=['baseline','draft','applied','committed']
const PRECISION_CHECKS=['storage_marker','persisted_connection','credential_reconnect','fixture_created','table_open','exact_baseline','editor_exact','local_edits','null_empty_distinct','apply_succeeded','uncommitted_transaction','same_session_witness','normal_commit','reloaded_exact_values','transaction_ended']
const PRECISION_FAILURES=['NONE','ISOLATION','CONNECTION','SETUP','TREE','EDIT','CHECKPOINT','BASELINE_MISMATCH','VALUE_LOSS','NULL_EMPTY_LOST','APPLY_FAILED','TRANSACTION_LOST','WITNESS_FAILED','COMMIT_FAILED','TIMEOUT','NATIVE_BRIDGE']
const precisionHash=(columns,row)=>hash(JSON.stringify({columns,rows:[row]}))
function precisionProjection(row){return [row[1],row[2],row[3],Buffer.from(row[4],'utf8').toString('hex').toUpperCase(),row[5]===null?'1':'0',Buffer.from(row[5]??'','utf8').toString('hex').toUpperCase(),row[6]===null?'1':'0',Buffer.from(row[6]??'','utf8').toString('hex').toUpperCase()]}
const PRECISION_BASELINE_SHA=precisionHash(PRECISION_COLUMNS,PRECISION_BASELINE),PRECISION_EDITED_SHA=precisionHash(PRECISION_COLUMNS,PRECISION_EDITED)
const PRECISION_BASELINE_PROJECTION=precisionHash(PRECISION_PROJECTION,precisionProjection(PRECISION_BASELINE)),PRECISION_EDITED_PROJECTION=precisionHash(PRECISION_PROJECTION,precisionProjection(PRECISION_EDITED))
function precisionPayload(r){
  exact(r,['schemaVersion','step','uiActive','uiPendingAffected','dirtyRows','rowsSha256','witnessConnectionId','witnessProjectionSha256'],'PRECISION_CHECKPOINT_SCHEMA')
  need(r.schemaVersion===1&&PRECISION_STEPS.includes(r.step)&&typeof r.uiActive==='boolean'&&integer(r.uiPendingAffected,1000)&&integer(r.dirtyRows,1)&&hex(r.rowsSha256)&&(r.witnessConnectionId===null||(Number.isSafeInteger(r.witnessConnectionId)&&r.witnessConnectionId>0))&&(r.witnessProjectionSha256===null||hex(r.witnessProjectionSha256)),'PRECISION_CHECKPOINT_SCHEMA')
  if(r.step==='baseline')need(!r.uiActive&&r.uiPendingAffected===0&&r.dirtyRows===0&&r.witnessConnectionId===null&&r.witnessProjectionSha256===null,'PRECISION_CHECKPOINT_MISMATCH')
  if(r.step==='committed')need(!r.uiActive&&r.uiPendingAffected===0&&r.dirtyRows===0&&r.witnessConnectionId>0&&hex(r.witnessProjectionSha256),'PRECISION_CHECKPOINT_MISMATCH')
}
function precisionNative(n){
  exact(n,['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified','precision'],'PRECISION_NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='grid-precision'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false&&n.methods&&typeof n.methods==='object'&&!Array.isArray(n.methods),'PRECISION_NATIVE_SCHEMA')
  for(const metric of Object.values(n.methods)){exact(metric,['success','failure','totalElapsedMs'],'PRECISION_NATIVE_SCHEMA');need(Object.values(metric).every((v)=>integer(v,100_000_000)),'PRECISION_NATIVE_SCHEMA')}
  for(const name of ['rollbackTransaction','addConnection','updateConnection','testConnection','insertRow','deleteRows'])need(!n.methods[name]||(n.methods[name].success===0&&n.methods[name].failure===0),'PRECISION_UNEXPECTED_METHOD')
  need([n.keyringGets,n.keyringHits,n.keyringSets].every((v)=>integer(v,10000))&&n.keyringSets===0&&n.keyringGets>=1&&n.keyringHits>=1,'PRECISION_KEYRING_MISSING')
  exact(n.precision,['lastApplyResult','lastObservedTransactionState'],'PRECISION_NATIVE_SCHEMA')
  const result=n.precision.lastApplyResult,state=n.precision.lastObservedTransactionState
  if(result!==null){exact(result,['ok','affected','inTransaction','outcomeCount','failedOutcomeCount','errorClass'],'PRECISION_NATIVE_SCHEMA');need(typeof result.ok==='boolean'&&integer(result.affected,1000)&&typeof result.inTransaction==='boolean'&&integer(result.outcomeCount,1000)&&integer(result.failedOutcomeCount,1000)&&['none','other'].includes(result.errorClass),'PRECISION_NATIVE_SCHEMA')}
  if(state!==null){exact(state,['active','pendingAffected'],'PRECISION_NATIVE_SCHEMA');need(typeof state.active==='boolean'&&integer(state.pendingAffected,1_000_000),'PRECISION_NATIVE_SCHEMA')}
}
function precisionNativePassed(n,step){
  const count=(name,success)=>n.methods[name]?.success===success&&n.methods[name].failure===0
  const applied=['applied','committed'].includes(step),r=n.precision.lastApplyResult,state=n.precision.lastObservedTransactionState
  return n.methods.connectConnection?.success>=1&&n.methods.connectConnection.failure===0&&count('executeStatement',applied?3:2)&&count('commitTransaction',step==='committed'?2:1)
    &&(applied?count('applyEdits',1):(!n.methods.applyEdits||(n.methods.applyEdits.success===0&&n.methods.applyEdits.failure===0)))
    &&(!applied||(r?.ok===true&&r.affected===1&&r.inTransaction===true&&r.outcomeCount===1&&r.failedOutcomeCount===0&&r.errorClass==='none'))
    &&state?.active===(step==='applied')&&state?.pendingAffected===(step==='applied'?1:0)
}
async function precisionReference(imageSha,signal){
  const table=`\`mysql_accept_${RUN.slice(0,16)}\`.\`gui_px_${RUN}\``
  const sql=`SELECT CAST(unsigned_big AS CHAR),CAST(signed_big AS CHAR),CAST(exact_decimal AS CHAR),HEX(utf8_text),nullable_text IS NULL,HEX(COALESCE(nullable_text,'')),empty_text IS NULL,HEX(COALESCE(empty_text,'')) FROM ${table} ORDER BY id`
  // Remove only the single terminating LF; trailing TAB encodes the eighth empty string.
  const lines=deadlockLines(await deadlockSql('observer',sql,imageSha,signal));need(lines.length===1,'PRECISION_REFERENCE_ROWS');const row=lines[0].split('\t')
  need(row.length===8&&row.every((v)=>typeof v==='string')&&row.every((v)=>Buffer.byteLength(v)<=512)&&/^[0-9]+$/.test(row[0])&&/^-?[0-9]+$/.test(row[1])&&/^-?[0-9]+\.[0-9]{30}$/.test(row[2])&&/^(?:[0-9A-F]{2})*$/.test(row[3])&&['0','1'].includes(row[4])&&/^(?:[0-9A-F]{2})*$/.test(row[5])&&['0','1'].includes(row[6])&&/^(?:[0-9A-F]{2})*$/.test(row[7]),'PRECISION_REFERENCE_FORMAT')
  return {rowCount:1,projectionSha256:precisionHash(PRECISION_PROJECTION,row),projection:row,autocommit:true,readOnly:true}
}
async function precisionTransactionEnded(id,imageSha,signal){need(Number.isSafeInteger(id)&&id>0,'PRECISION_GUI_ID_INVALID');const lines=deadlockLines(await deadlockSql('admin',`SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id=${id}`,imageSha,signal));need(lines.length===1&&lines[0]==='0','PRECISION_FINAL_TRANSACTION_ACTIVE');return true}
async function precisionDatabaseEnded(imageSha){
  const db=`mysql_accept_${RUN.slice(0,16)}`,table=`gui_px_${RUN}`,stop=new AbortController(),end=Date.now()+3000,timer=setTimeout(()=>stop.abort(),3000);let observed=null
  try{do{
    const sql=`SELECT (SELECT COUNT(*) FROM performance_schema.threads t WHERE t.TYPE='FOREGROUND' AND t.PROCESSLIST_DB='${db}' AND t.PROCESSLIST_ID<>CONNECTION_ID()),(SELECT COUNT(*) FROM information_schema.innodb_trx x JOIN performance_schema.threads t ON t.PROCESSLIST_ID=x.trx_mysql_thread_id WHERE t.PROCESSLIST_DB='${db}' AND t.PROCESSLIST_ID<>CONNECTION_ID()),(SELECT COUNT(*) FROM performance_schema.data_locks l WHERE l.OBJECT_SCHEMA='${db}' AND l.OBJECT_NAME='${table}')`
    const lines=deadlockLines(await deadlockSql('admin',sql,imageSha,stop.signal));need(lines.length===1,'PRECISION_DB_CLEANUP_FORMAT');const fields=lines[0].split('\t');need(fields.length===3&&fields.every((v)=>/^[0-9]+$/.test(v)&&Number.isSafeInteger(Number(v))),'PRECISION_DB_CLEANUP_FORMAT')
    observed={scope:'owned-db-no-known-id',foregroundSessions:Number(fields[0]),inTransactionSessions:Number(fields[1]),tableLocks:Number(fields[2]),ended:fields.every((v)=>v==='0')}
    if(observed.ended)return observed;await commitPause(stop.signal)
  }while(!stop.signal.aborted&&Date.now()<end)}catch{/* Unknown or nonzero cleanup observations cannot promote a real-red claim. */}finally{clearTimeout(timer)}
  return observed??{scope:'owned-db-no-known-id',foregroundSessions:null,inTransactionSessions:null,tableLocks:null,ended:false}
}
async function watchPrecision(child,alive,signal,hostRoot,imageSha){
  const pid=child.pid,steps=[];let failureCode='NONE'
  try{
    need(integer(pid,2_147_483_647)&&pid>0,'PRECISION_CHILD_PID_INVALID')
    for(const step of PRECISION_STEPS){const path=join(hostRoot,'evidence',`precision-checkpoint-${pid}-${step}.json`)
      while(absent(path)){if(!alive()||signal.aborted){if(steps.length>=2&&steps.every((r)=>r.ack?.verified===true))return {steps,failureCode:'PARTIAL_UI_FAILURE'};if(steps.length===1&&step==='draft'&&steps[0].ack?.verified===true)return {steps,failureCode:'PARTIAL_BASELINE_FAILURE'};throw new RunFailure('PRECISION_WATCH_STOPPED')}await commitPause(signal)}
      need(alive()&&!signal.aborted,'PRECISION_WATCH_STOPPED');privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
      const bytes=precisionFile(path,16*1024),checkpoint=JSON.parse(bytes.toString('utf8'));exact(checkpoint,['schemaVersion','runId','phase','pid','report','observations'],'PRECISION_CHECKPOINT_SCHEMA')
      need(checkpoint.schemaVersion===1&&checkpoint.runId===RUN&&checkpoint.phase==='grid-precision'&&checkpoint.pid===pid&&checkpoint.report?.step===step,'PRECISION_CHECKPOINT_MISMATCH');precisionPayload(checkpoint.report);precisionNative(checkpoint.observations)
      const record={step,checkpointSha256:hash(bytes),checkpoint,reference:null,ack:null};steps.push(record);let verified=false
      try{record.reference=await precisionReference(imageSha,signal);verified=true}catch{/* Unknown observation publishes only a negative ack. */}
      await new Promise((done)=>setImmediate(done));need(alive()&&!signal.aborted,'PRECISION_WATCH_STOPPED');record.ack=publishPrecisionAck(hostRoot,pid,step,checkpoint.report,verified,alive);if(!verified)return {steps,failureCode:'PRECISION_STAGE_UNVERIFIED'}
    }
  }catch{failureCode='PRECISION_WATCH_FAILED'}return {steps,failureCode}
}
function verifyPrecision(value){
  exact(value,['schemaVersion','report','observations'],'HOST_REPORT_SCHEMA');need(value.schemaVersion===1,'HOST_REPORT_SCHEMA');const ui=value.report
  exact(ui,['schemaVersion','runId','phase','actionDriver','checks','proof','actions','elapsedMs','failureCode'],'PRECISION_REPORT_SCHEMA')
  need(ui.schemaVersion===1&&ui.runId===RUN&&ui.phase==='grid-precision'&&ui.actionDriver==='native-dom-synthetic'&&PRECISION_FAILURES.includes(ui.failureCode)&&integer(ui.elapsedMs),'PRECISION_REPORT_SCHEMA')
  exact(ui.checks,PRECISION_CHECKS,'PRECISION_CHECK_SCHEMA');need(Object.values(ui.checks).every((v)=>typeof v==='boolean'),'PRECISION_CHECK_SCHEMA');exact(ui.actions,['click','input','keydown','dblclick'],'PRECISION_ACTION_SCHEMA');need(Object.values(ui.actions).every((v)=>integer(v,10000)),'PRECISION_ACTION_SCHEMA')
  if(ui.proof!==null){const p=ui.proof;exact(p,['rowCount','editedColumns','baselineRowsSha256','draftRowsSha256','appliedRowsSha256','committedRowsSha256','baselineProjectionSha256','uncommittedProjectionSha256','committedProjectionSha256','witnessConnectionId','uiActiveAfterApply','uiPendingAffectedAfterApply','dirtyRowsAfterApply','dirtyRowsBeforeApply'],'PRECISION_PROOF_SCHEMA');need(p.rowCount===1&&p.editedColumns===6&&hex(p.baselineRowsSha256)&&hex(p.baselineProjectionSha256)&&['draftRowsSha256','appliedRowsSha256','committedRowsSha256','uncommittedProjectionSha256','committedProjectionSha256'].every((key)=>p[key]===null||hex(p[key]))&&(p.witnessConnectionId===null||(Number.isSafeInteger(p.witnessConnectionId)&&p.witnessConnectionId>0))&&(p.uiActiveAfterApply===null||typeof p.uiActiveAfterApply==='boolean')&&(p.uiPendingAffectedAfterApply===null||integer(p.uiPendingAffectedAfterApply,1000))&&(p.dirtyRowsAfterApply===null||integer(p.dirtyRowsAfterApply,1))&&(p.dirtyRowsBeforeApply===null||integer(p.dirtyRowsBeforeApply,1)),'PRECISION_PROOF_SCHEMA')}
  precisionNative(value.observations);return {ui,native:value.observations}
}
function precisionFile(path,max){
  need(resolve(path)===path&&realpathSync(path)===path,'PRECISION_FILE_INVALID');const before=lstatSync(path)
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&(before.mode&0o777)===0o600&&before.size<=max,'PRECISION_FILE_INVALID');commitOwner(path)
  const fd=openSync(path,'r')
  try{const opened=fstatSync(fd);need(opened.dev===before.dev&&opened.ino===before.ino&&opened.uid===before.uid&&opened.isFile()&&opened.nlink===1&&(opened.mode&0o777)===0o600&&opened.size<=max,'PRECISION_FILE_INVALID');const bytes=readFileSync(fd),after=lstatSync(path),last=fstatSync(fd);need(bytes.length<=max&&last.size===bytes.length&&after.dev===opened.dev&&after.ino===opened.ino&&after.uid===opened.uid&&last.nlink===1&&(last.mode&0o777)===0o600&&realpathSync(path)===path,'PRECISION_FILE_CHANGED');return bytes}finally{closeSync(fd)}
}
function publishPrecisionAck(hostRoot,pid,step,proof,verified,alive){
  need(integer(pid,2_147_483_647)&&pid>0&&PRECISION_STEPS.includes(step)&&typeof verified==='boolean','PRECISION_ACK_SCHEMA');precisionPayload(proof);need(proof.step===step,'PRECISION_ACK_SCHEMA')
  const evidence=join(hostRoot,'evidence'),target=join(evidence,`precision-ack-${pid}-${step}.json`),source=`${target}.pending`
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(hostRoot);commitOwner(evidence)
  need(resolve(source)===source&&resolve(target)===target&&dirname(source)===evidence&&dirname(target)===evidence&&absent(target)&&alive(),'PRECISION_ACK_PATH_INVALID')
  const ack={schemaVersion:1,runId:RUN,phase:'grid-precision',pid,step,proof,verified},bytes=Buffer.from(`${JSON.stringify(ack)}\n`);need(bytes.length<=2048,'PRECISION_ACK_LIMIT')
  const fd=openSync(source,'wx',0o600);let owned
  try{let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);need(n>0,'PRECISION_ACK_WRITE');at+=n}fsyncSync(fd);owned=fstatSync(fd);need(owned.isFile()&&owned.nlink===1&&(owned.mode&0o777)===0o600&&owned.size===bytes.length,'PRECISION_ACK_FILE_INVALID')}finally{closeSync(fd)}
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(source);const actual=lstatSync(source)
  need(actual.isFile()&&!actual.isSymbolicLink()&&actual.nlink===1&&actual.dev===owned.dev&&actual.ino===owned.ino&&(actual.mode&0o777)===0o600&&realpathSync(source)===source&&resolve(source)===join(evidence,`precision-ack-${pid}-${step}.json.pending`)&&resolve(target)===join(evidence,`precision-ack-${pid}-${step}.json`)&&absent(target)&&alive(),'PRECISION_ACK_FILE_INVALID')
  // Absolute source and target above identify only this PID/step's pending and final files.
  renameSync(source,target);return ack
}
const DUPLICATE_STEPS=['baseline','failed','rolled-back']
const DUPLICATE_CHECKS=['storage_marker','persisted_connection','credential_reconnect','fixture_created','table_open','marker_applied','local_draft','original_1062','transaction_preserved','draft_preserved','same_session_witness','rollback_cancel_preserved','normal_rollback','reloaded_baseline']
const DUPLICATE_FAILURES=['NONE','ISOLATION','CONNECTION','SETUP','TREE','EDIT','CHECKPOINT','MYSQL_ERROR_DETAILS_LOST','TRANSACTION_LOST','DRAFT_LOST','WITNESS_FAILED','RECOVERY','TIMEOUT','DOM_FAILED','NATIVE_BRIDGE']
function duplicateHash(kind){return hash(JSON.stringify({columns:['id','u','v'],rows:[1,2,3,4].map((id)=>[String(id),String(kind==='fault'&&id===1?2:id),String(kind!=='baseline'&&id===3?7:0)])}))}
function duplicateFile(path,max){
  need(resolve(path)===path&&realpathSync(path)===path,'DUPLICATE_FILE_INVALID');const before=lstatSync(path)
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&(before.mode&0o777)===0o600&&before.size<=max,'DUPLICATE_FILE_INVALID');commitOwner(path)
  const fd=openSync(path,'r')
  try{const opened=fstatSync(fd);need(opened.dev===before.dev&&opened.ino===before.ino&&opened.uid===before.uid&&opened.isFile()&&opened.nlink===1&&(opened.mode&0o777)===0o600&&opened.size<=max,'DUPLICATE_FILE_INVALID');const bytes=readFileSync(fd),after=lstatSync(path),last=fstatSync(fd);need(bytes.length<=max&&last.size===bytes.length&&after.dev===opened.dev&&after.ino===opened.ino&&after.uid===opened.uid&&last.nlink===1&&(last.mode&0o777)===0o600&&realpathSync(path)===path,'DUPLICATE_FILE_CHANGED');return bytes}finally{closeSync(fd)}
}
function duplicatePayload(r){
  exact(r,['schemaVersion','step','uiActive','uiPendingAffected','dirtyRows','row1Unique','row3Value','original1062','witnessConnectionId','witnessMarkerValue'],'DUPLICATE_CHECKPOINT_SCHEMA')
  need(r.schemaVersion===1&&DUPLICATE_STEPS.includes(r.step)&&typeof r.uiActive==='boolean'&&integer(r.uiPendingAffected,1000)&&integer(r.dirtyRows,1)&&[1,2].includes(r.row1Unique)&&[0,7].includes(r.row3Value)&&typeof r.original1062==='boolean'
    &&(r.witnessConnectionId===null||(Number.isSafeInteger(r.witnessConnectionId)&&r.witnessConnectionId>0))&&(r.witnessMarkerValue===null||[0,7].includes(r.witnessMarkerValue)),'DUPLICATE_CHECKPOINT_SCHEMA')
  if(r.step==='baseline')need(!r.uiActive&&r.uiPendingAffected===0&&r.dirtyRows===0&&r.row1Unique===1&&r.row3Value===0&&!r.original1062&&r.witnessConnectionId===null&&r.witnessMarkerValue===null,'DUPLICATE_CHECKPOINT_MISMATCH')
  if(r.step==='rolled-back')need(!r.uiActive&&r.uiPendingAffected===0&&r.dirtyRows===0&&r.row1Unique===1&&r.row3Value===0&&r.original1062&&r.witnessConnectionId>0&&r.witnessMarkerValue===0,'DUPLICATE_CHECKPOINT_MISMATCH')
}
function duplicateNative(n,step){
  exact(n,['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified','duplicate'],'DUPLICATE_NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='grid-duplicate'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false&&n.methods&&typeof n.methods==='object'&&!Array.isArray(n.methods),'DUPLICATE_NATIVE_SCHEMA')
  for(const metric of Object.values(n.methods)){exact(metric,['success','failure','totalElapsedMs'],'DUPLICATE_NATIVE_SCHEMA');need(Object.values(metric).every((v)=>integer(v,100_000_000)),'DUPLICATE_NATIVE_SCHEMA')}
  need(n.methods.connectConnection?.success>=1&&n.methods.connectConnection.failure===0&&n.methods.executeStatement?.success===(step==='baseline'?2:3)&&n.methods.executeStatement.failure===0&&n.methods.commitTransaction?.success===1&&n.methods.commitTransaction.failure===0,'DUPLICATE_NATIVE_COUNT')
  if(step==='baseline')need(!n.methods.applyEdits||(n.methods.applyEdits.success===0&&n.methods.applyEdits.failure===0),'DUPLICATE_NATIVE_COUNT')
  else need(n.methods.applyEdits?.success===2&&n.methods.applyEdits.failure===0,'DUPLICATE_NATIVE_COUNT')
  need((n.methods.rollbackTransaction?.success??0)===(step==='rolled-back'?1:0)&&(n.methods.rollbackTransaction?.failure??0)===0,'DUPLICATE_NATIVE_COUNT')
  for(const name of ['addConnection','updateConnection','testConnection','insertRow','deleteRows'])need(!n.methods[name]||(n.methods[name].success===0&&n.methods[name].failure===0),'DUPLICATE_UNEXPECTED_METHOD')
  need([n.keyringGets,n.keyringHits,n.keyringSets].every((v)=>integer(v,10000))&&n.keyringSets===0&&n.keyringGets>=1&&n.keyringHits>=1,'DUPLICATE_KEYRING_MISSING')
  exact(n.duplicate,['lastApplyResult','lastObservedTransactionState'],'DUPLICATE_NATIVE_SCHEMA')
  const result=n.duplicate.lastApplyResult,state=n.duplicate.lastObservedTransactionState
  if(result!==null){exact(result,['ok','affected','inTransaction','outcomeCount','failedOutcomeCount','errorClass'],'DUPLICATE_NATIVE_SCHEMA');need(typeof result.ok==='boolean'&&integer(result.affected,1000)&&typeof result.inTransaction==='boolean'&&integer(result.outcomeCount,1000)&&integer(result.failedOutcomeCount,1000)&&['none','1062','other'].includes(result.errorClass),'DUPLICATE_NATIVE_SCHEMA')}
  if(state!==null){exact(state,['active','pendingAffected'],'DUPLICATE_NATIVE_SCHEMA');need(typeof state.active==='boolean'&&integer(state.pendingAffected,1_000_000),'DUPLICATE_NATIVE_SCHEMA')}
}
function duplicateResultVerified(n){const r=n.duplicate.lastApplyResult;return r?.ok===false&&r.affected===0&&r.outcomeCount===1&&r.failedOutcomeCount===1&&r.errorClass==='1062'}
async function duplicateReference(imageSha,signal){
  const lines=deadlockLines(await deadlockSql('observer',`SELECT id,u,v FROM \`mysql_accept_${RUN.slice(0,16)}\`.\`gui_uq_${RUN}\` ORDER BY id`,imageSha,signal)),rows=lines.map((line)=>line.split('\t'))
  need(rows.length===4&&rows.every((r,i)=>r.length===3&&r[0]===String(i+1)&&r[1]===String(i+1)&&r[2]==='0'),'DUPLICATE_BASELINE_MISMATCH')
  return {rowCount:4,rowsSha256:hash(JSON.stringify({columns:['id','u','v'],rows})),autocommit:true,readOnly:true}
}
async function duplicateServerError(guiId,imageSha,signal){
  need(Number.isSafeInteger(guiId)&&guiId>0,'DUPLICATE_GUI_ID_INVALID')
  const lines=deadlockLines(await deadlockSql('admin',`SELECT e.MYSQL_ERRNO,e.RETURNED_SQLSTATE FROM performance_schema.events_statements_history e JOIN performance_schema.threads t ON t.THREAD_ID=e.THREAD_ID WHERE t.PROCESSLIST_ID=${guiId} AND e.MYSQL_ERRNO<>0 ORDER BY e.EVENT_ID DESC LIMIT 1`,imageSha,signal))
  need(lines.length===1&&lines[0]==='1062\t23000','DUPLICATE_SERVER_EVENT_UNVERIFIED');return {code:1062,sqlState:'23000'}
}
async function duplicateTransaction(guiId,imageSha,signal,expected){
  need(Number.isSafeInteger(guiId)&&guiId>0,'DUPLICATE_GUI_ID_INVALID')
  const db=`mysql_accept_${RUN.slice(0,16)}`,table=`gui_uq_${RUN}`,end=Date.now()+3000
  let result=null
  const stop=new AbortController(),cancel=()=>stop.abort(),timer=setTimeout(cancel,3000)
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel()
  try{
    do{
      const sql=`SELECT (SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id=${guiId}),(SELECT COUNT(*) FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID=l.THREAD_ID WHERE t.PROCESSLIST_ID=${guiId} AND l.OBJECT_SCHEMA='${db}' AND l.OBJECT_NAME='${table}' AND l.INDEX_NAME='PRIMARY' AND l.LOCK_DATA='3' AND l.LOCK_STATUS='GRANTED' AND l.LOCK_MODE IN ('X','X,REC_NOT_GAP'))`
      const lines=deadlockLines(await deadlockSql('admin',sql,imageSha,stop.signal));need(lines.length===1,'DUPLICATE_TRANSACTION_FORMAT');const f=lines[0].split('\t');need(f.length===2&&f.every((v)=>/^\d+$/.test(v))&&Number(f[0])<=1&&Number.isSafeInteger(Number(f[1])),'DUPLICATE_TRANSACTION_FORMAT')
      result={transactionCount:Number(f[0]),markerLockCount:Number(f[1]),transactionActive:f[0]==='1',markerLockRetained:Number(f[1])>0}
      if(expected==='ended'?!result.transactionActive&&!result.markerLockRetained:result.transactionActive&&result.markerLockRetained)break
      if(Date.now()>=end)break;await commitPause(stop.signal)
    }while(!stop.signal.aborted&&Date.now()<end)
  }catch{need(result&&!signal?.aborted&&Date.now()>=end,'DUPLICATE_TRANSACTION_UNVERIFIED')}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel)}
  need(result&&!signal?.aborted,'DUPLICATE_TRANSACTION_UNVERIFIED');return result
}
function publishDuplicateAck(hostRoot,pid,step,proof,verified,alive){
  need(integer(pid,2_147_483_647)&&pid>0&&DUPLICATE_STEPS.includes(step)&&typeof verified==='boolean','DUPLICATE_ACK_SCHEMA');duplicatePayload(proof);need(proof.step===step,'DUPLICATE_ACK_SCHEMA')
  const evidence=join(hostRoot,'evidence'),target=join(evidence,`duplicate-ack-${pid}-${step}.json`),source=`${target}.pending`
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(hostRoot);commitOwner(evidence)
  need(resolve(source)===source&&resolve(target)===target&&dirname(source)===evidence&&dirname(target)===evidence&&absent(target)&&alive(),'DUPLICATE_ACK_PATH_INVALID')
  const ack={schemaVersion:1,runId:RUN,phase:'grid-duplicate',pid,step,proof,verified},bytes=Buffer.from(`${JSON.stringify(ack)}\n`);need(bytes.length<=2048,'DUPLICATE_ACK_LIMIT')
  const fd=openSync(source,'wx',0o600);let owned
  try{let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);need(n>0,'DUPLICATE_ACK_WRITE');at+=n}fsyncSync(fd);owned=fstatSync(fd);need(owned.isFile()&&owned.nlink===1&&(owned.mode&0o777)===0o600&&owned.size===bytes.length,'DUPLICATE_ACK_FILE_INVALID')}finally{closeSync(fd)}
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(source);const actual=lstatSync(source)
  need(actual.isFile()&&!actual.isSymbolicLink()&&actual.nlink===1&&actual.dev===owned.dev&&actual.ino===owned.ino&&(actual.mode&0o777)===0o600&&realpathSync(source)===source&&resolve(source)===join(evidence,`duplicate-ack-${pid}-${step}.json.pending`)&&resolve(target)===join(evidence,`duplicate-ack-${pid}-${step}.json`)&&absent(target)&&alive(),'DUPLICATE_ACK_FILE_INVALID')
  // Absolute source and target above identify only this PID/step's pending and final files.
  renameSync(source,target);return ack
}
async function watchDuplicate(child,alive,signal,hostRoot,imageSha){
  const pid=child.pid,steps=[];let failureCode='NONE'
  try{
    need(integer(pid,2_147_483_647)&&pid>0,'DUPLICATE_CHILD_PID_INVALID')
    for(const step of DUPLICATE_STEPS){
      const path=join(hostRoot,'evidence',`duplicate-checkpoint-${pid}-${step}.json`)
      while(absent(path)){if(!alive()||signal.aborted){if(step==='rolled-back'&&steps.length===2&&steps[1].ack?.verified===true)return {steps,failureCode:'PARTIAL_UI_FAILURE'};throw new RunFailure('DUPLICATE_WATCH_STOPPED')}await commitPause(signal)}
      need(alive()&&!signal.aborted,'DUPLICATE_WATCH_STOPPED');privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
      const checkpointBytes=duplicateFile(path,16*1024),checkpoint=JSON.parse(checkpointBytes.toString('utf8'));exact(checkpoint,['schemaVersion','runId','phase','pid','report','observations'],'DUPLICATE_CHECKPOINT_SCHEMA');need(checkpoint.schemaVersion===1&&checkpoint.runId===RUN&&checkpoint.phase==='grid-duplicate'&&checkpoint.pid===pid&&checkpoint.report?.step===step,'DUPLICATE_CHECKPOINT_MISMATCH');duplicatePayload(checkpoint.report);duplicateNative(checkpoint.observations,step)
      const record={step,checkpointSha256:hash(checkpointBytes),checkpoint,reference:null,serverError:null,transaction:null,ack:null};steps.push(record)
      let verified=false
      try{
        if(step!=='baseline'){need(checkpoint.report.witnessConnectionId>0,'DUPLICATE_WITNESS_ID_MISSING');if(step==='failed')record.serverError=await duplicateServerError(checkpoint.report.witnessConnectionId,imageSha,signal);record.transaction=await duplicateTransaction(checkpoint.report.witnessConnectionId,imageSha,signal,step==='failed'?'retained':'ended')}
        record.reference=await duplicateReference(imageSha,signal);verified=true
      }catch{verified=false}
      await new Promise((done)=>setImmediate(done));need(alive()&&!signal.aborted,'DUPLICATE_WATCH_STOPPED');record.ack=publishDuplicateAck(hostRoot,pid,step,checkpoint.report,verified,alive)
      if(!verified)return {steps,failureCode:'DUPLICATE_STAGE_UNVERIFIED'}
    }
  }catch{failureCode='DUPLICATE_WATCH_FAILED'}
  return {steps,failureCode}
}
function verifyDuplicate(value){
  exact(value,['schemaVersion','report','observations'],'HOST_REPORT_SCHEMA');need(value.schemaVersion===1,'HOST_REPORT_SCHEMA')
  const ui=value.report;exact(ui,['schemaVersion','runId','phase','actionDriver','checks','proof','actions','elapsedMs','failureCode'],'DUPLICATE_REPORT_SCHEMA')
  need(ui.schemaVersion===1&&ui.runId===RUN&&ui.phase==='grid-duplicate'&&ui.actionDriver==='native-dom-synthetic'&&DUPLICATE_FAILURES.includes(ui.failureCode)&&integer(ui.elapsedMs),'DUPLICATE_REPORT_SCHEMA')
  exact(ui.checks,DUPLICATE_CHECKS,'DUPLICATE_CHECK_SCHEMA');need(Object.values(ui.checks).every((v)=>typeof v==='boolean'),'DUPLICATE_CHECK_SCHEMA')
  exact(ui.actions,['click','input','keydown','dblclick'],'DUPLICATE_ACTION_SCHEMA');need(Object.values(ui.actions).every((v)=>integer(v,10000)),'DUPLICATE_ACTION_SCHEMA')
  if(ui.proof!==null){const p=ui.proof;exact(p,['rowCount','baselineRowsSha256','markerRowsSha256','faultRowsSha256','restoredRowsSha256','uiActiveAfterError','uiPendingAffectedAfterError','dirtyRowsAfterError','originalErrorClass','witnessConnectionId','markerValueAfterError','markerValueAfterRollback'],'DUPLICATE_PROOF_SCHEMA');need(p.rowCount===4&&hex(p.baselineRowsSha256)&&hex(p.markerRowsSha256)&&(p.faultRowsSha256===null||hex(p.faultRowsSha256))&&(p.restoredRowsSha256===null||hex(p.restoredRowsSha256))&&(p.uiActiveAfterError===null||typeof p.uiActiveAfterError==='boolean')&&(p.uiPendingAffectedAfterError===null||integer(p.uiPendingAffectedAfterError,1000))&&(p.dirtyRowsAfterError===null||integer(p.dirtyRowsAfterError,1))&&(p.originalErrorClass===null||['1062','other'].includes(p.originalErrorClass))&&(p.witnessConnectionId===null||(Number.isSafeInteger(p.witnessConnectionId)&&p.witnessConnectionId>0))&&(p.markerValueAfterError===null||[0,7].includes(p.markerValueAfterError))&&(p.markerValueAfterRollback===null||[0,7].includes(p.markerValueAfterRollback)),'DUPLICATE_PROOF_SCHEMA')}
  duplicateNative(value.observations,ui.failureCode==='NONE'?'rolled-back':'failed');return {ui,native:value.observations}
}
function timeoutGuardProof(g){return {before:g.original,temporary:g.temporary,restored:g.restored,mutationAttempted:g.mutationAttempted,restoredBeforeFault:g.restoredBeforeFault,independentReadback:g.independentReadback,finalVerified:g.finalVerified,leaseRetained:g.leaseRetained,restoreFailure:g.restoreFailure}}
async function runGridTimeout(checked,status,hostRoot,imageSha){
  need(pin,'TIMEOUT_FIXTURE_PIN_REQUIRED');const prior=restartPreflight(hostRoot,true,checked),oldFailure=join(hostRoot,'evidence','real-ui-restart-report.json'),oldFailureSha=absent(oldFailure)?null:hash(file(oldFailure,256*1024,true))
  const guard={lease:null,child:null,original:null,temporary:null,restored:null,mutationAttempted:false,restoredBeforeFault:false,independentReadback:false,finalVerified:false,leaseRetained:false,restoreFailure:null};let lifecycle=null,interrupted=false
  const interrupt=()=>{interrupted=true;if(guard.child?.exitCode===null)guard.child.kill('SIGTERM')};process.on('SIGTERM',interrupt);process.on('SIGINT',interrupt)
  try{
    guard.lease=timeoutLease();const before=await timeoutGlobal();need(!before.rollbackOnTimeout,'TIMEOUT_OFF_REQUIRED');guard.original=before.timeout
    need(!interrupted,'TIMEOUT_PARENT_INTERRUPTED');guard.mutationAttempted=true;await timeoutSetGlobal(5);const armed=await timeoutGlobal();guard.temporary=armed.timeout;need(armed.timeout===5&&!armed.rollbackOnTimeout&&!interrupted,'TIMEOUT_GUARD_NOT_ARMED')
    lifecycle=await runChild(checked.receipt.binary,hostRoot,'grid-timeout',(child,alive,signal)=>watchTimeout(child,alive,signal,hostRoot,imageSha,guard))
  }catch{/* Always attempt an independent restoration after any possibly applied SET. */}
  finally{
    if(guard.original!==null){const restored=await restoreTimeoutGuard(guard);if(restored)await timeoutFinalGlobal(guard)}
    if(lifecycle?.pid&&guard.finalVerified){try{retainTimeoutLease(guard,hostRoot,lifecycle.pid)}catch{guard.leaseRetained=false}}
    process.removeListener('SIGTERM',interrupt);process.removeListener('SIGINT',interrupt)
  }
  if(!lifecycle)return {status:'GRID_TIMEOUT_INFRA_ERROR',runId:RUN,chainPassed:false,productionReady:false,classification:'INFRA_ERROR',failureCode:'TIMEOUT_GUARD_OR_CHILD_FAILED',guard:timeoutGuardProof(guard)}
  return await finishGridTimeout(checked,status,hostRoot,imageSha,lifecycle,guard,prior,oldFailureSha)
}
async function finishGridTimeout(checked,status,hostRoot,imageSha,lifecycle,guard,prior,oldFailureSha){
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'TIMEOUT_CHILD_PID_INVALID')
  const evidence=join(hostRoot,'evidence'),output=join(evidence,`real-ui-grid-timeout-${lifecycle.pid}.json`)
  let observation=null,reference=null,transaction=null,trace=null,verified=null,classification='INFRA_ERROR',failureCode='JOINT_VALIDATION_FAILED',materialsPreserved=false
  try{
    privateDirectory(hostRoot);privateDirectory(evidence);await live(imageSha)
    const progress=lifecycle.progress,failed=progress?.steps?.find((r)=>r.step==='failed'),guiId=failed?.checkpoint.report.witnessConnectionId
    const reads=await Promise.allSettled([fixture(['--observe',READY]),timeoutReference(imageSha),guiId>0?timeoutTransaction(guiId,imageSha,undefined,'ended'):Promise.resolve(null)])
    if(reads[0].status==='fulfilled'){verifyObserver(reads[0].value);observation=reads[0].value}
    if(reads[1].status==='fulfilled')reference=reads[1].value
    if(reads[2].status==='fulfilled')transaction=reads[2].value
    materialsPreserved=attemptMaterials(hostRoot,prior,oldFailureSha);trace=startupTrace(join(evidence,`startup-trace-${lifecycle.pid}.jsonl`))
    need(observation&&reference&&transaction&&!transaction.transactionActive&&!transaction.markerLockRetained&&materialsPreserved&&!lifecycle.timedOut&&JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'TIMEOUT_FINAL_STATE_UNVERIFIED')
    need(progress&&['NONE','PARTIAL_UI_FAILURE'].includes(progress.failureCode)&&progress.steps.length>=2&&progress.steps.every((r,i)=>r.step===TIMEOUT_STEPS[i]&&r.ack?.verified===true)&&progress.waitProof?.waitObserved===true&&progress.actor?.exitCode===0&&!progress.actor.timedOut&&progress.actor.rolledBack&&progress.actor.outputValid&&guard.restoredBeforeFault&&guard.independentReadback&&guard.finalVerified&&guard.leaseRetained,'TIMEOUT_CHECKPOINTS_INCOMPLETE')
    for(const r of progress.steps){need(hash(timeoutFile(join(evidence,`timeout-checkpoint-${lifecycle.pid}-${r.step}.json`),16*1024))===r.checkpointSha256&&JSON.stringify(JSON.parse(timeoutFile(join(evidence,`timeout-ack-${lifecycle.pid}-${r.step}.json`),2048).toString('utf8')))===JSON.stringify(r.ack),'TIMEOUT_STAGE_CHANGED')}
    need(failed.serverError?.code===1205&&failed.serverError.sqlState==='HY000'&&timeoutResultVerified(failed.checkpoint.observations)&&progress.steps[0].checkpoint.report.witnessConnectionId===guiId&&progress.waitProof.guiConnectionId===guiId,'TIMEOUT_TRIGGER_UNVERIFIED')
    verified=verifyTimeout(JSON.parse(timeoutFile(join(evidence,`ui-grid-timeout-${lifecycle.pid}.json`),16*1024).toString('utf8')));const ui=verified.ui,p=ui.proof
    need(p&&p.baselineRowsSha256===timeoutHash('baseline')&&p.markerRowsSha256===timeoutHash('marker')&&p.witnessConnectionId===guiId&&timeoutResultVerified(verified.native),'TIMEOUT_PROOF_MISMATCH')
    const failedProof=failed.checkpoint.report,lastFailed=failed.checkpoint.observations.timeout.lastObservedTransactionState
    if(ui.failureCode==='NONE'&&lifecycle.exitCode===0&&(!failed.transaction.transactionActive||!failed.transaction.markerLockRetained||failed.checkpoint.observations.timeout.lastApplyResult.inTransaction!==true||lastFailed?.active!==true||lastFailed.pendingAffected!==1)){
      classification='KNOWN_GAP_RED';failureCode='TRANSACTION_LOST'
    }else if(ui.failureCode==='NONE'){
      const rolled=progress.steps[2],last=verified.native.timeout.lastObservedTransactionState
      need(lifecycle.exitCode===0&&progress.failureCode==='NONE'&&progress.steps.length===3&&TIMEOUT_CHECKS.every((k)=>ui.checks[k])&&p.faultRowsSha256===timeoutHash('fault')&&p.restoredRowsSha256===p.baselineRowsSha256&&p.uiActiveAfterError===true&&p.uiPendingAffectedAfterError===1&&p.dirtyRowsAfterError===1&&p.originalErrorClass==='1205'&&p.markerValueAfterError===7&&p.markerValueAfterRollback===0&&p.sessionTimeoutSeconds===5&&p.rollbackOnTimeout===false
        &&ui.actions.click>=16&&ui.actions.input===6&&ui.actions.keydown===0&&ui.actions.dblclick===3&&failedProof.uiActive&&failedProof.uiPendingAffected===1&&failedProof.dirtyRows===1&&failedProof.row1Value===1&&failedProof.row3Value===7&&failedProof.original1205&&failedProof.witnessMarkerValue===7&&failedProof.sessionTimeoutSeconds===5&&failedProof.rollbackOnTimeout===false&&failed.checkpoint.observations.timeout.lastApplyResult.inTransaction===true&&verified.native.timeout.lastApplyResult.inTransaction===true&&failed.transaction.transactionActive&&failed.transaction.markerLockRetained&&lastFailed?.active===true&&lastFailed.pendingAffected===1
        &&rolled.checkpoint.report.witnessConnectionId===guiId&&rolled.checkpoint.report.witnessMarkerValue===0&&rolled.checkpoint.report.sessionTimeoutSeconds===5&&rolled.checkpoint.report.rollbackOnTimeout===false&&!rolled.transaction.transactionActive&&!rolled.transaction.markerLockRetained&&last?.active===false&&last.pendingAffected===0,'TIMEOUT_GREEN_NOT_VERIFIED')
      classification='VERIFIED';failureCode='NONE'
    }else if(lifecycle.exitCode===1&&['MYSQL_ERROR_DETAILS_LOST','TRANSACTION_LOST','DRAFT_LOST','WITNESS_FAILED','SESSION_SETTINGS'].includes(ui.failureCode)){
      const loss=ui.failureCode==='MYSQL_ERROR_DETAILS_LOST'?p.originalErrorClass==='other':ui.failureCode==='TRANSACTION_LOST'?(!p.uiActiveAfterError||p.uiPendingAffectedAfterError!==1||!failed.transaction.transactionActive||!failed.transaction.markerLockRetained):ui.failureCode==='DRAFT_LOST'?(p.dirtyRowsAfterError!==1||p.faultRowsSha256!==timeoutHash('fault')):ui.failureCode==='SESSION_SETTINGS'?(failedProof.sessionTimeoutSeconds!==5||failedProof.rollbackOnTimeout!==false):p.markerValueAfterError!==7
      need(loss,'TIMEOUT_RED_UNVERIFIED');classification='KNOWN_GAP_RED';failureCode=ui.failureCode
    }else throw new RunFailure('TIMEOUT_NOT_VERIFIED')
  }catch{/* Retain partial UI proof and real independent cleanup state; never undo or fabricate a transaction. */}
  try{privateDirectory(hostRoot);privateDirectory(evidence);writeEvidence(output,{schemaVersion:1,scope:'mysql-grid-timeout-real-ui-chain',runId:RUN,phase:'grid-timeout',classification,failureCode,chainPassed:classification==='VERIFIED',productionReady:false,timeoutRecoveryVerified:classification==='VERIFIED',lockTimeoutVerified:classification==='VERIFIED',rollbackOnTimeoutOnVerified:false,osTrustedKeyboardVerified:false,crossBuildCredentialVerified:false,
    ui:verified?.ui??null,native:verified?.native??null,lifecycle,trace,observer:observation,finalTableReference:reference,finalTransaction:transaction,guard:timeoutGuardProof(guard),materialsPreserved,
    provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,failedRestartSha256:oldFailureSha,binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}})}catch{classification='INFRA_ERROR'}
  return {status:classification==='VERIFIED'?'GRID_TIMEOUT_VERIFIED':classification==='KNOWN_GAP_RED'?'GRID_TIMEOUT_KNOWN_GAP_RED':'GRID_TIMEOUT_INFRA_ERROR',runId:RUN,chainPassed:classification==='VERIFIED',productionReady:false,classification,failureCode,lifecycle}
}
function timeTypedMatches(stage,projection){return timeSame(stage.values,['1',...projection.slice(1,6)])&&timeSame(stage.columnTypes,TIME_TYPES)}
function timeSessionMatches(ref,transactions){return ref?.ownedDatabaseVerified===true&&ref.sessionTimezone==='+00:00'&&ref.systemTimezone==='UTC'&&ref.autocommitVariable==='ON'&&ref.autocommit===true&&ref.transactionCount===transactions}
function timeEditorsMatch(editors,baseline){return editors.every((e,i)=>e!==null&&e.raw===baseline.values[i+1]&&!e.isNull&&!e.valueDisabled&&!e.nullDisabled)}
async function runGridTime(checked,status,hostRoot,imageSha){
  need(pin,'TIME_FIXTURE_PIN_REQUIRED');const prior=restartPreflight(hostRoot,true,checked),oldFailure=join(hostRoot,'evidence','real-ui-restart-report.json'),oldFailureSha=absent(oldFailure)?null:hash(file(oldFailure,256*1024,true)),oracle={value:null}
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'grid-time',(child,alive,signal)=>watchTime(child,alive,signal,hostRoot,imageSha,oracle))
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'TIME_CHILD_PID_INVALID');const evidence=join(hostRoot,'evidence'),output=join(evidence,`real-ui-grid-time-${lifecycle.pid}.json`)
  let observation=null,reference=null,cleanup=null,trace=null,verified=null,materialsPreserved=false,classification='INFRA_ERROR',failureCode='JOINT_VALIDATION_FAILED'
  try{
    privateDirectory(hostRoot);privateDirectory(evidence);await live(imageSha)
    const reportPath=join(evidence,`ui-grid-time-${lifecycle.pid}.json`);if(!absent(reportPath)){try{verified=verifyTime(JSON.parse(timeFile(reportPath,16*1024).toString('utf8')))}catch{/* Still collect independent observer, final table and known-session cleanup. */}}
    const reads=await Promise.allSettled([fixture(['--observe',READY]),timeReference(imageSha),oracle.value?Promise.resolve(oracle.value):timeOracle(imageSha)])
    if(reads[0].status==='fulfilled'){try{verifyObserver(reads[0].value);observation=reads[0].value}catch{/* Invalid observer cannot promote a red or green. */}}if(reads[1].status==='fulfilled')reference=reads[1].value;if(reads[2].status==='fulfilled')oracle.value=reads[2].value
    const progress=lifecycle.progress,ids=Array.from(new Set((progress?.steps??[]).map((r)=>r.checkpoint.report.witnessConnectionId)))
    // runChild has collected its watcher, and all final oracle/observer readers above have settled.
    if(ids.length){try{cleanup=await sessionTimezoneEnded(ids,imageSha)}catch{cleanup={knownConnectionIds:ids,ended:false}}}
    materialsPreserved=attemptMaterials(hostRoot,prior,oldFailureSha);trace=startupTrace(join(evidence,`startup-trace-${lifecycle.pid}.jsonl`))
    need(observation&&reference&&oracle.value&&cleanup?.ended&&materialsPreserved&&!lifecycle.timedOut&&JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'TIME_FINAL_STATE_UNVERIFIED')
    need(progress&&['NONE','PARTIAL_UI_FAILURE'].includes(progress.failureCode)&&progress.steps.length>=1&&progress.steps.every((r,i)=>r.step===TIME_STEPS[i]&&r.ack?.verified===true&&r.reference&&r.columns?.matches===true&&r.session?.ownedDatabaseVerified===true),'TIME_CHECKPOINTS_INCOMPLETE')
    for(const r of progress.steps){need(hash(timeFile(join(evidence,`time-checkpoint-${lifecycle.pid}-${r.step}.json`),16*1024))===r.checkpointSha256&&JSON.stringify(JSON.parse(timeFile(join(evidence,`time-ack-${lifecycle.pid}-${r.step}.json`),2048).toString('utf8')))===JSON.stringify(r.ack),'TIME_STAGE_CHANGED')}
    need(verified?.ui.proof,'TIME_UI_PROOF_MISSING');const ui=verified.ui,p=ui.proof,steps=progress.steps,stages=steps.map((r)=>p.stages[r.step]),o=oracle.value,baseline=p.stages.baseline
    for(let i=0;i<TIME_STEPS.length;i++)need((p.stages[TIME_STEPS[i]]!==null)===(i<steps.length),'TIME_STAGE_SEQUENCE_MISMATCH')
    for(let i=0;i<steps.length;i++){
      const actual=stages[i],request=steps[i].checkpoint.report;need(actual&&actual.valuesSha256===request.valuesSha256&&actual.witnessConnectionId===request.witnessConnectionId&&actual.witnessProjectionSha256===request.witnessProjectionSha256&&actual.uiActive===request.uiActive&&actual.uiPendingAffected===request.uiPendingAffected&&actual.dirtyRows===request.dirtyRows&&steps[i].session.connectionId===actual.witnessConnectionId&&timeNativeShape(steps[i].checkpoint.observations,i),'TIME_ACTUAL_PROOF_MISMATCH')
    }
    need(timeNativeShape(verified.native,stages.length-1),'TIME_FINAL_NATIVE_COUNTS_MISMATCH')
    need(timeSame(baseline.witnessProjection,o.baseline)&&baseline.witnessProjectionSha256===o.baselineProjectionSha256&&steps[0].reference.projectionSha256===o.baselineProjectionSha256&&timeSessionMatches(steps[0].session,0)&&timeNativePassed(steps[0].checkpoint.observations,0),'TIME_BASELINE_WITNESS_UNVERIFIED')
    if(ui.failureCode==='NONE'){
      need(lifecycle.exitCode===0&&progress.failureCode==='NONE'&&steps.length===4&&TIME_CHECKS.every((k)=>ui.checks[k])&&ui.actions.input===10&&ui.actions.dblclick===6&&ui.actions.keydown===0&&ui.actions.click>=12&&timeEditorsMatch(p.editorOriginals,baseline),'TIME_GREEN_NOT_VERIFIED')
      need(steps.every((r,i)=>timeTypedMatches(stages[i],i===0?o.baseline:o.edited)&&timeSame(stages[i].witnessProjection,i<2?o.baseline:o.edited)&&stages[i].witnessConnectionId===baseline.witnessConnectionId&&stages[i].uiActive===(i===2)&&stages[i].uiPendingAffected===(i===2?1:0)&&stages[i].dirtyRows===(i===1?1:0)&&r.reference.projectionSha256===(i<3?o.baselineProjectionSha256:o.editedProjectionSha256)&&timeSessionMatches(r.session,i===2?1:0)&&timeNativePassed(r.checkpoint.observations,i))&&timeNativePassed(verified.native,3)&&reference.projectionSha256===o.editedProjectionSha256,'TIME_GREEN_REFERENCES_MISMATCH')
      classification='VERIFIED';failureCode='NONE'
    }else if(ui.failureCode==='BASELINE_MISMATCH'){
      need(lifecycle.exitCode===1&&progress.failureCode==='PARTIAL_UI_FAILURE'&&steps.length===1&&!timeTypedMatches(baseline,o.baseline)&&p.editorOriginals.every((e)=>e===null)&&!baseline.uiActive&&baseline.uiPendingAffected===0&&baseline.dirtyRows===0&&timeNativePassed(verified.native,0)&&reference.projectionSha256===o.baselineProjectionSha256,'TIME_BASELINE_RED_UNVERIFIED')
      classification='KNOWN_GAP_RED';failureCode='BASELINE_MISMATCH'
    }else if(lifecycle.exitCode===1&&steps.length>=2&&['EDITOR_VALUE_LOSS','DIRTY_VALUES_MISMATCH','APPLY_REJECTED','TRANSACTION_STALE','WITNESS_FAILED','COMMIT_FAILED','RELOADED_VALUES_MISMATCH'].includes(ui.failureCode)){
      need(timeTypedMatches(baseline,o.baseline)&&steps.slice(0,Math.min(3,steps.length)).every((r)=>r.reference.projectionSha256===o.baselineProjectionSha256),'TIME_NEGATIVE_BASELINE_OR_VISIBILITY_UNVERIFIED')
      const i=steps.length-1,actual=stages[i],native=verified.native,batch=native.temporal.lastApplyResult,state=native.temporal.lastObservedTransactionState,session=steps[i].session
      const editorDifference=p.editorOriginals.some((e,j)=>e!==null&&(e.raw!==baseline.values[j+1]||e.isNull||e.valueDisabled||e.nullDisabled))
      const typedDifference=!timeTypedMatches(actual,o.edited),witnessDifference=!timeSame(actual.witnessProjection,i<2?o.baseline:o.edited)||actual.witnessConnectionId!==baseline.witnessConnectionId
      let actualDifference=false
      if(ui.failureCode==='EDITOR_VALUE_LOSS')actualDifference=i===1&&editorDifference
      else if(ui.failureCode==='DIRTY_VALUES_MISMATCH')actualDifference=i===1&&(typedDifference||actual.dirtyRows!==1||actual.uiActive||actual.uiPendingAffected!==0)
      else if(ui.failureCode==='APPLY_REJECTED')actualDifference=i===2&&((native.methods.applyEdits?.failure??0)>0||batch?.ok===false)
      else if(ui.failureCode==='TRANSACTION_STALE')actualDifference=i>=2&&(actual.uiActive!==(i===2)||actual.uiPendingAffected!==(i===2?1:0)||actual.dirtyRows!==0||session.transactionCount!==(i===2?1:0)||state?.active!==(i===2)||state?.pendingAffected!==(i===2?1:0))
      else if(ui.failureCode==='WITNESS_FAILED')actualDifference=i>=2&&witnessDifference
      else if(ui.failureCode==='COMMIT_FAILED')actualDifference=i===3&&((native.methods.commitTransaction?.failure??0)>0||actual.uiActive||actual.uiPendingAffected>0)
      else if(ui.failureCode==='RELOADED_VALUES_MISMATCH')actualDifference=i>=2&&(typedDifference||witnessDifference)
      need(actualDifference,'TIME_NEGATIVE_NO_ACTUAL_DIFFERENCE')
      if(i<3)need(reference.projectionSha256===o.baselineProjectionSha256,'TIME_UNCOMMITTED_NEGATIVE_NOT_PRESERVED')
      classification='KNOWN_GAP_RED';failureCode=ui.failureCode
    }else throw new RunFailure('TIME_NOT_VERIFIED')
  }catch{/* Keep actual arrays, types, originals and server references; no corrective writes or resets. */}
  try{privateDirectory(hostRoot);privateDirectory(evidence);writeEvidence(output,{schemaVersion:1,scope:'mysql-grid-time-real-ui-chain',runId:RUN,phase:'grid-time',classification,failureCode,chainPassed:classification==='VERIFIED',productionReady:false,utcFiveTemporalFieldsVerified:classification==='VERIFIED',crossTimezoneTimestampRowsVerified:false,fullTemporalMatrixVerified:false,fullTypeMatrixVerified:false,osTrustedKeyboardVerified:false,crossBuildCredentialVerified:false,
    ui:verified?.ui??null,native:verified?.native??null,lifecycle,trace,oracle:oracle.value,observer:observation,finalTableReference:reference,finalSessionCleanup:cleanup,materialsPreserved,
    provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,failedRestartSha256:oldFailureSha,binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}})}catch{classification='INFRA_ERROR'}
  return {status:classification==='VERIFIED'?'GRID_TIME_VERIFIED':classification==='KNOWN_GAP_RED'?'GRID_TIME_KNOWN_GAP_RED':'GRID_TIME_INFRA_ERROR',runId:RUN,chainPassed:classification==='VERIFIED',productionReady:false,classification,failureCode,lifecycle}
}
async function runGridTimeCrosszone(checked,status,hostRoot,imageSha){
  need(pin,'CROSSZONE_FIXTURE_PIN_REQUIRED');const prior=restartPreflight(hostRoot,true,checked),oldFailure=join(hostRoot,'evidence','real-ui-restart-report.json'),oldFailureSha=absent(oldFailure)?null:hash(file(oldFailure,256*1024,true))
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'grid-time-crosszone',(child,alive,signal)=>watchCrosszone(child,alive,signal,hostRoot,imageSha))
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'CROSSZONE_CHILD_PID_INVALID');const evidence=join(hostRoot,'evidence'),output=join(evidence,`real-ui-grid-time-crosszone-${lifecycle.pid}.json`)
  let observation=null,reference=null,cleanup=null,trace=null,verified=null,materialsPreserved=false,classification='INFRA_ERROR',failureCode='JOINT_VALIDATION_FAILED'
  try{
    privateDirectory(hostRoot);privateDirectory(evidence);await live(imageSha)
    const reportPath=join(evidence,`ui-grid-time-crosszone-${lifecycle.pid}.json`);if(!absent(reportPath)){try{verified=verifyCrosszone(JSON.parse(timeFile(reportPath,16*1024).toString('utf8')))}catch{/* Still collect the independent observer, final table and known-session state. */}}
    const reads=await Promise.allSettled([fixture(['--observe',READY]),crosszoneObserver(imageSha)])
    if(reads[0].status==='fulfilled'){try{verifyObserver(reads[0].value);observation=reads[0].value}catch{/* An invalid observer cannot promote a red or a green. */}}
    if(reads[1].status==='fulfilled')reference=reads[1].value
    const progress=lifecycle.progress,ids=Array.from(new Set((progress?.steps??[]).map((r)=>r.checkpoint.report.witnessConnectionId)))
    // Known GUI sessions are only observed after the child exited; nothing is disconnected or removed.
    if(ids.length){try{cleanup=await sessionTimezoneEnded(ids,imageSha)}catch{cleanup={knownConnectionIds:ids,ended:false}}}
    materialsPreserved=attemptMaterials(hostRoot,prior,oldFailureSha);trace=startupTrace(join(evidence,`startup-trace-${lifecycle.pid}.jsonl`))
    need(observation&&reference&&cleanup?.ended&&materialsPreserved&&!lifecycle.timedOut&&JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'CROSSZONE_FINAL_STATE_UNVERIFIED')
    need(progress&&['NONE','PARTIAL_UI_FAILURE'].includes(progress.failureCode)&&progress.steps.length>=1&&progress.steps.every((r,i)=>r.step===CROSSZONE_STEPS[i]&&r.ack?.verified===true&&r.oracle&&r.observer&&r.session?.ownedDatabaseVerified===true),'CROSSZONE_CHECKPOINTS_INCOMPLETE')
    for(const r of progress.steps){need(hash(timeFile(join(evidence,`crosszone-checkpoint-${lifecycle.pid}-${r.step}.json`),16*1024))===r.checkpointSha256&&JSON.stringify(JSON.parse(timeFile(join(evidence,`crosszone-ack-${lifecycle.pid}-${r.step}.json`),2048).toString('utf8')))===JSON.stringify(r.ack),'CROSSZONE_STAGE_CHANGED')}
    need(verified?.ui.proof,'CROSSZONE_UI_PROOF_MISSING');const ui=verified.ui,p=ui.proof,steps=progress.steps,stages=steps.map((r)=>p.stages[r.step])
    for(let i=0;i<steps.length;i++){
      const actual=stages[i],request=steps[i].checkpoint.report
      need(actual&&actual.valuesSha256===request.valuesSha256&&actual.witnessConnectionId===request.witnessConnectionId&&actual.witnessProjectionSha256===request.witnessProjectionSha256&&actual.uiActive===request.uiActive&&actual.uiPendingAffected===request.uiPendingAffected&&actual.dirtyRows===request.dirtyRows&&actual.sessionTimezone===request.sessionTimezone&&actual.resultTabsBefore===request.resultTabsBefore&&actual.resultTabsAfter===request.resultTabsAfter&&actual.activeTabGeneration===request.activeTabGeneration&&actual.activeTabOwned===request.activeTabOwned&&actual.nativeExecuteCount===request.nativeExecuteCount&&steps[i].session.connectionId===actual.witnessConnectionId&&crosszoneNativeShape(steps[i].checkpoint.observations,i),'CROSSZONE_ACTUAL_PROOF_MISMATCH')
    }
    need(crosszoneNativeShape(verified.native,stages.length-1),'CROSSZONE_FINAL_NATIVE_COUNTS_MISMATCH')
    const observerChanged=steps.some((r)=>r.observer.projectionSha256!==steps[0].observer.projectionSha256)
    if(CROSSZONE_BUSINESS.includes(ui.failureCode)){
      const i=steps.length-1,actual=stages[i],record=steps[i],expected=CROSSZONE_VALUES[i]
      need(actual&&actual.resultTabsAfter===actual.resultTabsBefore+1&&actual.activeTabGeneration===actual.resultTabsAfter&&actual.activeTabOwned===true&&actual.nativeExecuteCount===CROSSZONE_EXEC[i],'CROSSZONE_RED_FRESH_CONDITION_MISSING')
      const nativeState=crosszoneNative(verified.native),stepState=crosszoneNative(record.checkpoint.observations)
      const nativeTx=nativeState.active===true||nativeState.pendingAffected>0||stepState.active===true||stepState.pendingAffected>0
      const uiTx=actual.uiActive===true||actual.uiPendingAffected>0||stages.some((s)=>s.uiActive===true||s.uiPendingAffected>0)
      const psTx=record.session.transactionCount>0
      let actualDifference=false
      if(ui.failureCode==='DISPLAY_VALUE_MISMATCH')actualDifference=actual.values[3]!==expected[3]
      else if(ui.failureCode==='DISPLAY_TYPE_MISMATCH')actualDifference=!crosszoneSame(actual.columnTypes,CROSSZONE_TYPES)
      else if(ui.failureCode==='NON_TS_MUTATED')actualDifference=actual.values[0]!==expected[0]||actual.values[1]!==expected[1]||actual.values[2]!==expected[2]||actual.values[4]!==expected[4]||actual.values[5]!==expected[5]
      else if(ui.failureCode==='EPOCH_MICROSECOND_LOST')actualDifference=actual.witnessProjection[10]!=='1709210096.123456'||actual.witnessProjection[6]!=='1'||actual.witnessProjection[7]!=='123456'||actual.witnessProjection[8]!=='2'||actual.witnessProjection[9]!=='3'||!String(actual.values[3]??'').endsWith('.123456')
      else if(ui.failureCode==='SESSION_READBACK_MISMATCH')actualDifference=actual.sessionTimezone!==CROSSZONE_TZ[i]||actual.witnessProjection[0]!==CROSSZONE_TZ[i]||record.session.sessionTimezone!==CROSSZONE_TZ[i]
      else if(ui.failureCode==='CONNECTION_CHANGED')actualDifference=stages.some((s)=>s.witnessConnectionId!==stages[0].witnessConnectionId)
      else if(ui.failureCode==='TRANSACTION_STARTED')actualDifference=uiTx||nativeTx
      else if(ui.failureCode==='SESSION_NOT_RESTORED')actualDifference=actual.sessionTimezone!=='+00:00'||record.session.sessionTimezone!=='+00:00'
      let code=ui.failureCode
      if(nativeTx&&!['SESSION_READBACK_MISMATCH','CONNECTION_CHANGED','TRANSACTION_STARTED','OBSERVER_MISMATCH'].includes(code)&&(uiTx||psTx)){actualDifference=true;code='TRANSACTION_STARTED'}
      if(code===ui.failureCode&&observerChanged&&['EPOCH_MICROSECOND_LOST','NON_TS_MUTATED','DISPLAY_TYPE_MISMATCH','DISPLAY_VALUE_MISMATCH'].includes(code))code='OBSERVER_MISMATCH'
      need(actualDifference,'CROSSZONE_RED_UNVERIFIED');classification='KNOWN_GAP_RED';failureCode=code
    }else if(ui.failureCode==='NONE'&&observerChanged){
      need(steps[0].observer.projectionSha256===crosszoneProjectionHash(CROSSZONE_PROJECTIONS[0]),'CROSSZONE_OBSERVER_BASELINE_UNVERIFIED')
      classification='KNOWN_GAP_RED';failureCode='OBSERVER_MISMATCH'
    }else if(ui.failureCode==='NONE'){
      need(lifecycle.exitCode===0&&progress.failureCode==='NONE'&&steps.length===3&&CROSSZONE_CHECKS.every((k)=>ui.checks[k])&&ui.actions.keydown===0&&ui.actions.dblclick===0,'CROSSZONE_GREEN_NOT_VERIFIED')
      const finalState=crosszoneNative(verified.native)
      need(finalState.active===false&&finalState.pendingAffected===0,'CROSSZONE_GREEN_NATIVE_TRANSACTION_ACTIVE')
      need(steps.every((r,i)=>{const s=stages[i],ns=crosszoneNative(r.checkpoint.observations);return crosszoneSame(s.values,CROSSZONE_VALUES[i])&&crosszoneSame(s.columnTypes,CROSSZONE_TYPES)&&crosszoneSame(s.witnessProjection,CROSSZONE_PROJECTIONS[i])&&crosszoneSame(r.oracle.projection,CROSSZONE_PROJECTIONS[i])&&crosszoneSame(r.observer.projection,CROSSZONE_PROJECTIONS[0])&&s.witnessConnectionId===stages[0].witnessConnectionId&&s.uiActive===false&&s.uiPendingAffected===0&&s.dirtyRows===0&&s.sessionTimezone===CROSSZONE_TZ[i]&&s.resultTabsBefore===CROSSZONE_TABS_BEFORE[i]&&s.resultTabsAfter===CROSSZONE_TABS_AFTER[i]&&s.activeTabGeneration===CROSSZONE_TABS_AFTER[i]&&s.activeTabOwned===true&&s.nativeExecuteCount===CROSSZONE_EXEC[i]&&r.session.connectionId===s.witnessConnectionId&&r.session.sessionTimezone===CROSSZONE_TZ[i]&&r.session.autocommitVariable==='ON'&&r.session.autocommit===true&&r.session.transactionCount===0&&ns.active===false&&ns.pendingAffected===0&&crosszoneNativeShape(r.checkpoint.observations,i)}),'CROSSZONE_GREEN_REFERENCES_MISMATCH')
      need(reference.projectionSha256===crosszoneProjectionHash(CROSSZONE_PROJECTIONS[0]),'CROSSZONE_FINAL_OBSERVER_CHANGED')
      classification='VERIFIED';failureCode='NONE'
    }else throw new RunFailure('CROSSZONE_NOT_VERIFIED')
  }catch{/* Keep the actual values, hashes and server references; no corrective SET or write is issued. */}
  try{privateDirectory(hostRoot);privateDirectory(evidence);writeEvidence(output,{schemaVersion:1,scope:'mysql-grid-time-crosszone-real-ui-chain',runId:RUN,phase:'grid-time-crosszone',classification,failureCode,chainPassed:classification==='VERIFIED',productionReady:false,utcTimestampCrosszoneVerified:classification==='VERIFIED',crossTimezoneTimestampRowsVerified:classification==='VERIFIED',fullTemporalMatrixVerified:false,fullTypeMatrixVerified:false,osTrustedKeyboardVerified:false,crossBuildCredentialVerified:false,referenceProductOperated:false,mysql84Verified:false,windowsVerified:false,soakVerified:false,
    ui:verified?.ui??null,native:verified?.native??null,lifecycle,trace,observer:observation,finalTableReference:reference,finalSessionCleanup:cleanup,materialsPreserved,
    provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,failedRestartSha256:oldFailureSha,binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}})}catch{classification='INFRA_ERROR'}
  return {status:classification==='VERIFIED'?'GRID_TIME_CROSSZONE_VERIFIED':classification==='KNOWN_GAP_RED'?'GRID_TIME_CROSSZONE_KNOWN_GAP_RED':'GRID_TIME_CROSSZONE_INFRA_ERROR',runId:RUN,chainPassed:classification==='VERIFIED',productionReady:false,classification,failureCode,lifecycle}
}
function sessionTimezoneExecutionCounts(n,stages,index){
  let success=1,failure=0;for(let i=1;i<=index;i++){success+=stages[i].setFailed?1:2;failure+=stages[i].setFailed?1:0}
  return n.methods.executeStatement?.success===success&&n.methods.executeStatement.failure===failure
}
function sessionTimezoneComparison(stage,reference,oracle){
  const row=stage.sessionTimezone==='+00:00'?oracle.baseline:stage.sessionTimezone==='+08:00'?oracle.offset:null
  return {sessionVariableMatches:stage.sessionTimezone===reference.sessionTimezone,systemVariableMatches:stage.systemTimezone===reference.systemTimezone,autocommitVariableMatches:stage.autocommit===reference.autocommit,epochMatchesKnownOffset:row===null?null:stage.epochText===row[3],knownOffset:row!==null}
}
async function runSessionTimezone(checked,status,hostRoot,imageSha){
  need(pin,'SESSION_TIMEZONE_FIXTURE_PIN_REQUIRED');const prior=restartPreflight(hostRoot,true,checked),oldFailure=join(hostRoot,'evidence','real-ui-restart-report.json'),oldFailureSha=absent(oldFailure)?null:hash(file(oldFailure,256*1024,true)),oracle={value:null}
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'session-timezone',(child,alive,signal)=>watchSessionTimezone(child,alive,signal,hostRoot,imageSha,oracle))
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'SESSION_TIMEZONE_CHILD_PID_INVALID');const evidence=join(hostRoot,'evidence'),output=join(evidence,`real-ui-session-timezone-${lifecycle.pid}.json`)
  let observation=null,cleanup=null,trace=null,verified=null,materialsPreserved=false,comparisons=null,classification='INFRA_ERROR',failureCode='JOINT_VALIDATION_FAILED'
  try{
    privateDirectory(hostRoot);privateDirectory(evidence);await live(imageSha)
    const reportPath=join(evidence,`ui-session-timezone-${lifecycle.pid}.json`);if(!absent(reportPath)){try{verified=verifySessionTimezone(JSON.parse(sessionTimezoneFile(reportPath,16*1024).toString('utf8')))}catch{/* Independent final observer and owned-session cleanup still run. */}}
    const reads=await Promise.allSettled([fixture(['--observe',READY]),oracle.value?Promise.resolve(oracle.value):sessionTimezoneOracle(imageSha)])
    if(reads[0].status==='fulfilled'){verifyObserver(reads[0].value);observation=reads[0].value}if(reads[1].status==='fulfilled')oracle.value=reads[1].value
    const progress=lifecycle.progress,ids=Array.from(new Set((progress?.steps??[]).map((r)=>r.checkpoint.report.connectionId)))
    // Every owned oracle/observer CLI is collected before final counts for the known GUI IDs.
    if(ids.length){try{cleanup=await sessionTimezoneEnded(ids,imageSha)}catch{cleanup={knownConnectionIds:ids,ended:false}}}
    materialsPreserved=attemptMaterials(hostRoot,prior,oldFailureSha);trace=startupTrace(join(evidence,`startup-trace-${lifecycle.pid}.jsonl`))
    need(observation&&oracle.value&&cleanup?.ended&&materialsPreserved&&!lifecycle.timedOut&&JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'SESSION_TIMEZONE_FINAL_STATE_UNVERIFIED')
    need(progress&&['NONE','PARTIAL_UI_FAILURE'].includes(progress.failureCode)&&progress.steps.length>=2&&progress.steps.every((r,i)=>r.step===SESSION_TIMEZONE_STEPS[i]&&r.ack?.verified===true&&r.reference?.ownedDatabaseVerified===true),'SESSION_TIMEZONE_CHECKPOINTS_INCOMPLETE')
    for(const r of progress.steps){need(hash(sessionTimezoneFile(join(evidence,`session-timezone-checkpoint-${lifecycle.pid}-${r.step}.json`),16*1024))===r.checkpointSha256&&JSON.stringify(JSON.parse(sessionTimezoneFile(join(evidence,`session-timezone-ack-${lifecycle.pid}-${r.step}.json`),2048).toString('utf8')))===JSON.stringify(r.ack),'SESSION_TIMEZONE_STAGE_CHANGED')}
    need(verified?.ui.proof,'SESSION_TIMEZONE_PROOF_MISSING');const ui=verified.ui,p=ui.proof,steps=progress.steps,stages=steps.map((r)=>p[r.step]),o=oracle.value
    for(let i=0;i<steps.length;i++){
      const stage=stages[i],request=steps[i].checkpoint.report;need(stage&&stage.connectionId===request.connectionId&&stage.projectionSha256===request.projectionSha256&&stage.setFailed===request.setFailed&&stage.autocommit===request.autocommit&&stage.uiActive===request.uiActive&&stage.uiPendingAffected===request.uiPendingAffected&&sessionTimezoneExecutionCounts(steps[i].checkpoint.observations,stages,i),'SESSION_TIMEZONE_ACTUAL_PROOF_MISMATCH')
    }
    need(sessionTimezoneExecutionCounts(verified.native,stages,stages.length-1),'SESSION_TIMEZONE_NATIVE_COUNT_MISMATCH')
    comparisons=steps.map((r,i)=>sessionTimezoneComparison(stages[i],r.reference,o))
    const baseline=p.baseline
    need(baseline.projectionSha256===sessionTimezoneHash(o.baseline)&&!baseline.setFailed&&!baseline.uiActive&&baseline.uiPendingAffected===0&&baseline.autocommit&&sessionTimezoneNativePassed(steps[0].checkpoint.observations,0)&&comparisons[0].sessionVariableMatches&&comparisons[0].systemVariableMatches&&comparisons[0].autocommitVariableMatches&&steps[0].reference.transactionCount===0,'SESSION_TIMEZONE_BASELINE_UNVERIFIED')
    if(ui.failureCode==='NONE'){
      need(lifecycle.exitCode===0&&progress.failureCode==='NONE'&&steps.length===3&&p.offset&&p.restored&&SESSION_TIMEZONE_CHECKS.every((k)=>ui.checks[k])&&ui.actions.input===5&&ui.actions.click>=5&&ui.actions.keydown===0&&ui.actions.dblclick===0,'SESSION_TIMEZONE_GREEN_NOT_VERIFIED')
      need(steps.every((r,i)=>!stages[i].setFailed&&stages[i].connectionId===baseline.connectionId&&stages[i].projectionSha256===sessionTimezoneHash(o[r.step])&&!stages[i].uiActive&&stages[i].uiPendingAffected===0&&stages[i].autocommit&&sessionTimezoneNativePassed(r.checkpoint.observations,i)&&r.reference.transactionCount===0&&comparisons[i].sessionVariableMatches&&comparisons[i].systemVariableMatches&&comparisons[i].autocommitVariableMatches&&comparisons[i].epochMatchesKnownOffset===true)&&sessionTimezoneNativePassed(verified.native,2),'SESSION_TIMEZONE_GREEN_REFERENCES_MISMATCH')
      classification='VERIFIED';failureCode='NONE'
    }else if(lifecycle.exitCode===1&&['SET_REJECTED','SESSION_MISMATCH','AUTOCOMMIT_CHANGED','EPOCH_LOSS','CONNECTION_CHANGED','TRANSACTION_CHANGED'].includes(ui.failureCode)){
      const index=stages.length-1,stage=stages[index],ref=steps[index].reference,previous=stages[index-1],native=steps[index].checkpoint.observations,state=native.sessionTimezone.lastObservedTransactionState,comparison=comparisons[index],expected=o[steps[index].step]
      let actualDifference=false
      if(ui.failureCode==='SET_REJECTED'){
        const priorRow=previous.sessionTimezone==='+00:00'?o.baseline:previous.sessionTimezone==='+08:00'?o.offset:null
        actualDifference=stage.setFailed&&stage.connectionId===previous.connectionId&&priorRow!==null&&stage.sessionTimezone===priorRow[0]&&stage.systemTimezone===priorRow[1]&&stage.autocommit&&stage.epochText===priorRow[3]&&ref.sessionTimezone===previous.sessionTimezone&&ref.systemTimezone==='UTC'&&ref.autocommitVariable==='ON'&&ref.transactionCount===0&&!stage.uiActive&&stage.uiPendingAffected===0&&state?.active===false&&state.pendingAffected===0&&o.offsetSetVerified&&o.restoreSetVerified&&(native.methods.executeStatement?.failure??0)>0
      }else if(ui.failureCode==='SESSION_MISMATCH')actualDifference=stage.sessionTimezone!==expected[0]||stage.systemTimezone!==expected[1]||ref.sessionTimezone!==expected[0]||ref.systemTimezone!==expected[1]
      else if(ui.failureCode==='AUTOCOMMIT_CHANGED')actualDifference=!stage.autocommit||!ref.autocommit
      else if(ui.failureCode==='EPOCH_LOSS')actualDifference=comparison.knownOffset&&comparison.epochMatchesKnownOffset===false
      else if(ui.failureCode==='CONNECTION_CHANGED')actualDifference=stage.connectionId!==baseline.connectionId
      else if(ui.failureCode==='TRANSACTION_CHANGED')actualDifference=stage.uiActive||stage.uiPendingAffected>0||ref.transactionCount>0||state?.active===true||(state?.pendingAffected??0)>0
      need(actualDifference,'SESSION_TIMEZONE_RED_UNVERIFIED');classification='KNOWN_GAP_RED';failureCode=ui.failureCode
    }else throw new RunFailure('SESSION_TIMEZONE_NOT_VERIFIED')
  }catch{/* Preserve raw stage strings and actual references; never issue a corrective GUI SET. */}
  try{privateDirectory(hostRoot);privateDirectory(evidence);writeEvidence(output,{schemaVersion:1,scope:'mysql-session-timezone-real-ui-chain',runId:RUN,phase:'session-timezone',classification,failureCode,chainPassed:classification==='VERIFIED',productionReady:false,sessionTimezoneVerified:classification==='VERIFIED',typedTemporalGridVerified:false,osTrustedKeyboardVerified:false,crossBuildCredentialVerified:false,
    ui:verified?.ui??null,native:verified?.native??null,lifecycle,trace,oracle:oracle.value,comparisons,observer:observation,finalSessionCleanup:cleanup,materialsPreserved,
    provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,failedRestartSha256:oldFailureSha,binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}})}catch{classification='INFRA_ERROR'}
  return {status:classification==='VERIFIED'?'SESSION_TIMEZONE_VERIFIED':classification==='KNOWN_GAP_RED'?'SESSION_TIMEZONE_KNOWN_GAP_RED':'SESSION_TIMEZONE_INFRA_ERROR',runId:RUN,chainPassed:classification==='VERIFIED',productionReady:false,classification,failureCode,lifecycle}
}
async function runGridText(checked,status,hostRoot,imageSha){
  need(pin,'TEXT_FIXTURE_PIN_REQUIRED');const prior=restartPreflight(hostRoot,true,checked),oldFailure=join(hostRoot,'evidence','real-ui-restart-report.json'),oldFailureSha=absent(oldFailure)?null:hash(file(oldFailure,256*1024,true)),oracle={value:null}
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'grid-text',(child,alive,signal)=>watchText(child,alive,signal,hostRoot,imageSha,oracle))
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'TEXT_CHILD_PID_INVALID');const evidence=join(hostRoot,'evidence'),output=join(evidence,`real-ui-grid-text-${lifecycle.pid}.json`)
  let observation=null,reference=null,transactionEnded=false,cleanup=null,trace=null,verified=null,materialsPreserved=false,classification='INFRA_ERROR',failureCode='JOINT_VALIDATION_FAILED'
  try{
    privateDirectory(hostRoot);privateDirectory(evidence);await live(imageSha)
    const reportPath=join(evidence,`ui-grid-text-${lifecycle.pid}.json`);if(!absent(reportPath)){try{verified=verifyText(JSON.parse(textFile(reportPath,16*1024).toString('utf8')))}catch{/* Final fresh observations still run after an invalid report. */}}
    const id=verified?.ui.proof?.witnessConnectionId??lifecycle.progress?.steps?.find((r)=>r.step==='applied')?.checkpoint.report.witnessConnectionId
    const reads=await Promise.allSettled([fixture(['--observe',READY]),textReference(imageSha),oracle.value?Promise.resolve(oracle.value):textOracle(imageSha)])
    if(reads[0].status==='fulfilled'){verifyObserver(reads[0].value);observation=reads[0].value}if(reads[1].status==='fulfilled')reference=reads[1].value;if(reads[2].status==='fulfilled')oracle.value=reads[2].value
    // Every owned observer/live process has closed before this scope count excludes only itself.
    if(id>0){try{transactionEnded=await textTransactionEnded(id,imageSha);cleanup={scope:'known-gui-id',guiConnectionId:id,ended:transactionEnded}}catch{cleanup={scope:'known-gui-id',guiConnectionId:id,ended:false}}}else if(lifecycle.exitCode===1&&!lifecycle.timedOut){cleanup=await textDatabaseEnded(imageSha);transactionEnded=cleanup.ended}
    materialsPreserved=attemptMaterials(hostRoot,prior,oldFailureSha);trace=startupTrace(join(evidence,`startup-trace-${lifecycle.pid}.jsonl`))
    need(observation&&reference&&oracle.value&&transactionEnded&&materialsPreserved&&!lifecycle.timedOut&&JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'TEXT_FINAL_STATE_UNVERIFIED')
    const progress=lifecycle.progress,o=oracle.value
    need(progress&&['NONE','PARTIAL_UI_FAILURE'].includes(progress.failureCode)&&progress.steps.length>=1&&progress.steps.every((r,i)=>r.step===TEXT_STEPS[i]&&r.ack?.verified===true),'TEXT_CHECKPOINTS_INCOMPLETE')
    for(const r of progress.steps){need(hash(textFile(join(evidence,`text-checkpoint-${lifecycle.pid}-${r.step}.json`),16*1024))===r.checkpointSha256&&JSON.stringify(JSON.parse(textFile(join(evidence,`text-ack-${lifecycle.pid}-${r.step}.json`),2048).toString('utf8')))===JSON.stringify(r.ack),'TEXT_STAGE_CHANGED')}
    need(verified?.ui.proof,'TEXT_UI_PROOF_MISSING');const ui=verified.ui,p=ui.proof,steps=progress.steps
    const pairKeys=['baselineValuesSha256','draftValuesSha256','appliedValuesSha256','committedValuesSha256'],longKeys=['baselineLongSha256','draftLongSha256','appliedLongSha256','committedLongSha256'],jsonKeys=['baselineJsonSha256','draftJsonSha256','appliedJsonSha256','committedJsonSha256']
    for(let i=0;i<steps.length;i++)need(hex(p[longKeys[i]])&&hex(p[jsonKeys[i]])&&p[pairKeys[i]]===textValuesHash(p[longKeys[i]],p[jsonKeys[i]])&&steps[i].checkpoint.report.valuesSha256===p[pairKeys[i]],'TEXT_ACTUAL_PAIR_MISMATCH')
    if(steps[2])need(steps[2].checkpoint.report.witnessConnectionId===p.witnessConnectionId&&steps[2].checkpoint.report.witnessProjectionSha256===p.uncommittedProjectionSha256,'TEXT_WITNESS_PROOF_MISMATCH')
    if(steps[3])need(steps[3].checkpoint.report.witnessConnectionId===p.witnessConnectionId&&steps[3].checkpoint.report.witnessProjectionSha256===p.committedProjectionSha256,'TEXT_WITNESS_PROOF_MISMATCH')
    const expectedPairs=[o.baselineValuesSha256,o.draftValuesSha256,o.editedValuesSha256,o.editedValuesSha256]
    const previewResults=[textPreviewMatches(p.baselinePreview,[TEXT_BASELINE_LONG,o.baselineJson]),p.appliedPreview===null?null:textPreviewMatches(p.appliedPreview,[TEXT_EDITED_LONG,o.editedJson]),p.committedPreview===null?null:textPreviewMatches(p.committedPreview,[TEXT_EDITED_LONG,o.editedJson])]
    if(ui.failureCode==='NONE'){
      need(lifecycle.exitCode===0&&progress.failureCode==='NONE'&&steps.length===4&&TEXT_CHECKS.every((k)=>ui.checks[k])&&ui.actions.click>=30&&ui.actions.input===5&&ui.actions.keydown===0&&ui.actions.dblclick===3,'TEXT_GREEN_NOT_VERIFIED')
      need(steps.every((r,i)=>p[pairKeys[i]]===expectedPairs[i]&&r.reference.projectionSha256===(i<3?o.baselineProjectionSha256:o.editedProjectionSha256)&&textNativePassed(r.checkpoint.observations,r.step))&&textNativePassed(verified.native,'committed')&&previewResults.every((v)=>v===true),'TEXT_FULL_VALUE_NOT_VERIFIED')
      const draft=steps[1].checkpoint.report,applied=steps[2].checkpoint.report,committed=steps[3].checkpoint.report
      need(p.dirtyRowsBeforeApply===1&&p.dirtyRowsAfterApply===0&&p.uiActiveAfterApply===true&&p.uiPendingAffectedAfterApply===1&&!draft.uiActive&&draft.uiPendingAffected===0&&draft.dirtyRows===1&&applied.uiActive&&applied.uiPendingAffected===1&&applied.dirtyRows===0&&p.witnessConnectionId>0&&p.uncommittedProjectionSha256===o.editedProjectionSha256&&p.committedProjectionSha256===o.editedProjectionSha256&&committed.witnessConnectionId===p.witnessConnectionId&&reference.projectionSha256===o.editedProjectionSha256,'TEXT_COMMIT_NOT_VERIFIED')
      classification='VERIFIED';failureCode='NONE'
    }else if(lifecycle.exitCode===1&&['BASELINE_MISMATCH','PREVIEW','JSON_LOSS','FULL_VALUE','VALUE_LOSS','APPLY_FAILED','TRANSACTION_LOST','WITNESS_FAILED','COMMIT_FAILED'].includes(ui.failureCode)){
      need(steps[0].reference.projectionSha256===o.baselineProjectionSha256,'TEXT_BASELINE_UNVERIFIED')
      if(steps.length===1)need(['BASELINE_MISMATCH','PREVIEW','JSON_LOSS','FULL_VALUE'].includes(ui.failureCode)&&textBaselineBusinessPassed(steps[0].checkpoint.observations)&&textBaselineBusinessPassed(verified.native),'TEXT_SINGLE_STEP_RED_FORBIDDEN')
      const valueLoss=steps.some((r,i)=>p[pairKeys[i]]!==expectedPairs[i]),previewLoss=previewResults.some((v)=>v===false),projectionLoss=p.uncommittedProjectionSha256!==null&&p.uncommittedProjectionSha256!==o.editedProjectionSha256||p.committedProjectionSha256!==null&&p.committedProjectionSha256!==o.editedProjectionSha256
      const fetchFailure=(verified.native.methods.fetchCellValue?.failure??0)>0,applyFailure=(verified.native.methods.applyEdits?.failure??0)>0||verified.native.text.lastApplyResult?.ok===false,commitFailure=(verified.native.methods.commitTransaction?.failure??0)>0
      const nativeBasics=verified.native.methods.executeStatement?.success>=2&&verified.native.methods.commitTransaction?.success>=1
      const actualDifference=ui.failureCode==='PREVIEW'?previewLoss:ui.failureCode==='APPLY_FAILED'?applyFailure:ui.failureCode==='COMMIT_FAILED'?commitFailure:ui.failureCode==='TRANSACTION_LOST'?(p.uiActiveAfterApply===false||p.uiPendingAffectedAfterApply!==1):ui.failureCode==='FULL_VALUE'?(fetchFailure||valueLoss):valueLoss||projectionLoss
      need(nativeBasics&&actualDifference,'TEXT_RED_UNVERIFIED');classification='KNOWN_GAP_RED';failureCode=ui.failureCode
    }else throw new RunFailure('TEXT_NOT_VERIFIED')
  }catch{/* Keep actual observed hashes and final server values; never reset or commit corrective values. */}
  const o=oracle.value,oracleProof=o?{baselineJsonSha256:o.baselineJsonSha256,editedJsonSha256:o.editedJsonSha256,draftJsonSha256:o.draftJsonSha256,baselineValuesSha256:o.baselineValuesSha256,draftValuesSha256:o.draftValuesSha256,editedValuesSha256:o.editedValuesSha256,baselineProjectionSha256:o.baselineProjectionSha256,editedProjectionSha256:o.editedProjectionSha256}:null
  try{privateDirectory(hostRoot);privateDirectory(evidence);writeEvidence(output,{schemaVersion:1,scope:'mysql-grid-text-real-ui-chain',runId:RUN,phase:'grid-text',classification,failureCode,chainPassed:classification==='VERIFIED',productionReady:false,longTextJsonVerified:classification==='VERIFIED',fullTypeMatrixVerified:false,osTrustedKeyboardVerified:false,crossBuildCredentialVerified:false,
    ui:verified?.ui??null,native:verified?.native??null,lifecycle,trace,oracle:oracleProof,observer:observation,finalTableReference:reference,finalTransactionEnded:transactionEnded,finalTransactionCleanup:cleanup,materialsPreserved,
    provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,failedRestartSha256:oldFailureSha,binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}})}catch{classification='INFRA_ERROR'}
  return {status:classification==='VERIFIED'?'GRID_TEXT_VERIFIED':classification==='KNOWN_GAP_RED'?'GRID_TEXT_KNOWN_GAP_RED':'GRID_TEXT_INFRA_ERROR',runId:RUN,chainPassed:classification==='VERIFIED',productionReady:false,classification,failureCode,lifecycle}
}
async function runGridPrecision(checked,status,hostRoot,imageSha){
  need(pin,'PRECISION_FIXTURE_PIN_REQUIRED');const prior=restartPreflight(hostRoot,true,checked),oldFailure=join(hostRoot,'evidence','real-ui-restart-report.json'),oldFailureSha=absent(oldFailure)?null:hash(file(oldFailure,256*1024,true))
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'grid-precision',(child,alive,signal)=>watchPrecision(child,alive,signal,hostRoot,imageSha))
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'PRECISION_CHILD_PID_INVALID');const evidence=join(hostRoot,'evidence'),output=join(evidence,`real-ui-grid-precision-${lifecycle.pid}.json`)
  let observation=null,reference=null,transactionEnded=false,cleanup=null,trace=null,verified=null,materialsPreserved=false,classification='INFRA_ERROR',failureCode='JOINT_VALIDATION_FAILED'
  try{
    privateDirectory(hostRoot);privateDirectory(evidence);await live(imageSha)
    const reportPath=join(evidence,`ui-grid-precision-${lifecycle.pid}.json`)
    if(!absent(reportPath)){try{verified=verifyPrecision(JSON.parse(precisionFile(reportPath,16*1024).toString('utf8')))}catch{/* Final independent observations still run after an invalid UI report. */}}
    const id=verified?.ui.proof?.witnessConnectionId??lifecycle.progress?.steps?.find((r)=>r.step==='applied')?.checkpoint.report.witnessConnectionId
    const reads=await Promise.allSettled([fixture(['--observe',READY]),precisionReference(imageSha)])
    if(reads[0].status==='fulfilled'){verifyObserver(reads[0].value);observation=reads[0].value}
    if(reads[1].status==='fulfilled')reference=reads[1].value
    // Every owned observer/live promise is collected before the scope count excludes only itself.
    if(id>0){try{transactionEnded=await precisionTransactionEnded(id,imageSha);cleanup={scope:'known-gui-id',guiConnectionId:id,ended:transactionEnded}}catch{cleanup={scope:'known-gui-id',guiConnectionId:id,ended:false}}}
    else if(lifecycle.exitCode===1&&!lifecycle.timedOut){cleanup=await precisionDatabaseEnded(imageSha);transactionEnded=cleanup.ended}
    materialsPreserved=attemptMaterials(hostRoot,prior,oldFailureSha);trace=startupTrace(join(evidence,`startup-trace-${lifecycle.pid}.jsonl`))
    need(observation&&reference&&transactionEnded&&materialsPreserved&&!lifecycle.timedOut&&JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'PRECISION_FINAL_STATE_UNVERIFIED')
    const progress=lifecycle.progress
    need(progress&&['NONE','PARTIAL_UI_FAILURE','PARTIAL_BASELINE_FAILURE'].includes(progress.failureCode)&&progress.steps.length>=1&&progress.steps.every((r,i)=>r.step===PRECISION_STEPS[i]&&r.ack?.verified===true),'PRECISION_CHECKPOINTS_INCOMPLETE')
    for(const r of progress.steps){need(hash(precisionFile(join(evidence,`precision-checkpoint-${lifecycle.pid}-${r.step}.json`),16*1024))===r.checkpointSha256&&JSON.stringify(JSON.parse(precisionFile(join(evidence,`precision-ack-${lifecycle.pid}-${r.step}.json`),2048).toString('utf8')))===JSON.stringify(r.ack),'PRECISION_STAGE_CHANGED')}
    need(verified?.ui.proof,'PRECISION_UI_PROOF_MISSING');const ui=verified.ui,p=ui.proof,steps=progress.steps
    need(steps[0].checkpoint.report.rowsSha256===p.baselineRowsSha256,'PRECISION_UI_PROOF_MISMATCH')
    if(steps[1])need(steps[1].checkpoint.report.rowsSha256===p.draftRowsSha256,'PRECISION_UI_PROOF_MISMATCH')
    if(steps[2])need(steps[2].checkpoint.report.witnessConnectionId===p.witnessConnectionId&&steps[2].checkpoint.report.witnessProjectionSha256===p.uncommittedProjectionSha256,'PRECISION_UI_PROOF_MISMATCH')
    if(ui.failureCode==='BASELINE_MISMATCH'){
      need(lifecycle.exitCode===1&&progress.failureCode==='PARTIAL_BASELINE_FAILURE'&&steps.length===1&&p.baselineRowsSha256!==PRECISION_BASELINE_SHA&&steps[0].reference.projectionSha256===PRECISION_BASELINE_PROJECTION&&reference.projectionSha256===PRECISION_BASELINE_PROJECTION&&precisionNativePassed(steps[0].checkpoint.observations,'baseline')&&precisionNativePassed(verified.native,'baseline'),'PRECISION_BASELINE_RED_UNVERIFIED')
      classification='KNOWN_GAP_RED';failureCode='BASELINE_MISMATCH'
    }else if(ui.failureCode==='NONE'){
      const applied=steps[2]?.checkpoint.report,committed=steps[3]?.checkpoint.report,state=verified.native.precision.lastObservedTransactionState
      need(lifecycle.exitCode===0&&progress.failureCode==='NONE'&&steps.length===4&&PRECISION_CHECKS.every((k)=>ui.checks[k])&&ui.actions.click>=20&&ui.actions.input===8&&ui.actions.keydown===0&&ui.actions.dblclick===7,'PRECISION_GREEN_NOT_VERIFIED')
      need(p.baselineRowsSha256===PRECISION_BASELINE_SHA&&p.baselineProjectionSha256===PRECISION_BASELINE_PROJECTION&&p.draftRowsSha256===PRECISION_EDITED_SHA&&p.appliedRowsSha256===PRECISION_EDITED_SHA&&p.committedRowsSha256===PRECISION_EDITED_SHA
        &&p.uncommittedProjectionSha256===PRECISION_EDITED_PROJECTION&&p.committedProjectionSha256===PRECISION_EDITED_PROJECTION&&p.witnessConnectionId>0&&p.uiActiveAfterApply===true&&p.uiPendingAffectedAfterApply===1&&p.dirtyRowsAfterApply===0&&p.dirtyRowsBeforeApply===1,'PRECISION_VALUE_NOT_VERIFIED')
      need(steps.every((r,i)=>r.reference.projectionSha256===(i<3?PRECISION_BASELINE_PROJECTION:PRECISION_EDITED_PROJECTION)&&r.checkpoint.report.rowsSha256===(i===0?PRECISION_BASELINE_SHA:PRECISION_EDITED_SHA)&&precisionNativePassed(r.checkpoint.observations,r.step))&&precisionNativePassed(verified.native,'committed'),'PRECISION_NATIVE_OR_REFERENCE_MISMATCH')
      need(!steps[1].checkpoint.report.uiActive&&steps[1].checkpoint.report.uiPendingAffected===0&&steps[1].checkpoint.report.dirtyRows===1&&applied.uiActive&&applied.uiPendingAffected===1&&applied.dirtyRows===0&&committed.rowsSha256===p.committedRowsSha256&&committed.witnessConnectionId===p.witnessConnectionId&&committed.witnessProjectionSha256===p.committedProjectionSha256&&state?.active===false&&state.pendingAffected===0&&reference.projectionSha256===PRECISION_EDITED_PROJECTION,'PRECISION_COMMIT_NOT_VERIFIED')
      classification='VERIFIED';failureCode='NONE'
    }else if(lifecycle.exitCode===1&&['VALUE_LOSS','NULL_EMPTY_LOST','APPLY_FAILED','TRANSACTION_LOST','WITNESS_FAILED','COMMIT_FAILED'].includes(ui.failureCode)){
      need(steps.length>=2&&progress.failureCode!=='PARTIAL_BASELINE_FAILURE'&&steps[0].reference.projectionSha256===PRECISION_BASELINE_PROJECTION&&p.baselineRowsSha256===PRECISION_BASELINE_SHA&&p.baselineProjectionSha256===PRECISION_BASELINE_PROJECTION,'PRECISION_BASELINE_UNVERIFIED')
      const appliedNative=steps[2]?.checkpoint.observations,hasValueLoss=steps.some((r,i)=>i>0&&r.checkpoint.report.rowsSha256!==PRECISION_EDITED_SHA)||p.draftRowsSha256!==null&&p.draftRowsSha256!==PRECISION_EDITED_SHA||p.appliedRowsSha256!==null&&p.appliedRowsSha256!==PRECISION_EDITED_SHA||p.uncommittedProjectionSha256!==null&&p.uncommittedProjectionSha256!==PRECISION_EDITED_PROJECTION||p.committedRowsSha256!==null&&p.committedRowsSha256!==PRECISION_EDITED_SHA||p.committedProjectionSha256!==null&&p.committedProjectionSha256!==PRECISION_EDITED_PROJECTION
      const loss=['VALUE_LOSS','NULL_EMPTY_LOST','WITNESS_FAILED'].includes(ui.failureCode)?hasValueLoss:ui.failureCode==='APPLY_FAILED'?((appliedNative?.methods.applyEdits?.failure??0)>0||appliedNative?.precision.lastApplyResult?.ok===false):ui.failureCode==='TRANSACTION_LOST'?(p.uiActiveAfterApply===false||p.uiPendingAffectedAfterApply!==1):((verified.native.methods.commitTransaction?.failure??0)>0)
      need(loss,'PRECISION_RED_UNVERIFIED');classification='KNOWN_GAP_RED';failureCode=ui.failureCode
    }else throw new RunFailure('PRECISION_NOT_VERIFIED')
  }catch{/* Preserve the actual projection and UI proof; no reset, rollback or corrective commit is issued. */}
  try{privateDirectory(hostRoot);privateDirectory(evidence);writeEvidence(output,{schemaVersion:1,scope:'mysql-grid-precision-real-ui-chain',runId:RUN,phase:'grid-precision',classification,failureCode,chainPassed:classification==='VERIFIED',productionReady:false,precisionSixFieldVerified:classification==='VERIFIED',fullTypeMatrixVerified:false,osTrustedKeyboardVerified:false,crossBuildCredentialVerified:false,
    ui:verified?.ui??null,native:verified?.native??null,lifecycle,trace,observer:observation,finalTableReference:reference,finalTransactionEnded:transactionEnded,finalTransactionCleanup:cleanup,materialsPreserved,
    provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,failedRestartSha256:oldFailureSha,binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}})}catch{classification='INFRA_ERROR'}
  return {status:classification==='VERIFIED'?'GRID_PRECISION_VERIFIED':classification==='KNOWN_GAP_RED'?'GRID_PRECISION_KNOWN_GAP_RED':'GRID_PRECISION_INFRA_ERROR',runId:RUN,chainPassed:classification==='VERIFIED',productionReady:false,classification,failureCode,lifecycle}
}
async function runGridDuplicate(checked,status,hostRoot,imageSha){
  need(pin,'DUPLICATE_FIXTURE_PIN_REQUIRED');const prior=restartPreflight(hostRoot,true,checked)
  const oldFailure=join(hostRoot,'evidence','real-ui-restart-report.json'),oldFailureSha=absent(oldFailure)?null:hash(file(oldFailure,256*1024,true))
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'grid-duplicate',(child,alive,signal)=>watchDuplicate(child,alive,signal,hostRoot,imageSha))
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'DUPLICATE_CHILD_PID_INVALID')
  const evidence=join(hostRoot,'evidence'),output=join(evidence,`real-ui-grid-duplicate-${lifecycle.pid}.json`)
  let observation=null,reference=null,transaction=null,trace=null,verified=null,classification='INFRA_ERROR',failureCode='JOINT_VALIDATION_FAILED',materialsPreserved=false
  try{
    privateDirectory(hostRoot);privateDirectory(evidence);await live(imageSha)
    const progress=lifecycle.progress,failed=progress?.steps?.find((r)=>r.step==='failed'),guiId=failed?.checkpoint.report.witnessConnectionId
    const reads=await Promise.allSettled([fixture(['--observe',READY]),duplicateReference(imageSha),guiId>0?duplicateTransaction(guiId,imageSha,undefined,'ended'):Promise.resolve(null)])
    if(reads[0].status==='fulfilled'){verifyObserver(reads[0].value);observation=reads[0].value}
    if(reads[1].status==='fulfilled')reference=reads[1].value
    if(reads[2].status==='fulfilled')transaction=reads[2].value
    materialsPreserved=attemptMaterials(hostRoot,prior,oldFailureSha);trace=startupTrace(join(evidence,`startup-trace-${lifecycle.pid}.jsonl`))
    need(observation&&reference&&transaction&&!transaction.transactionActive&&!transaction.markerLockRetained&&materialsPreserved&&!lifecycle.timedOut&&JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'DUPLICATE_FINAL_STATE_UNVERIFIED')
    need(progress&&['NONE','PARTIAL_UI_FAILURE'].includes(progress.failureCode)&&progress.steps.length>=2&&progress.steps.every((r,i)=>r.step===DUPLICATE_STEPS[i]&&r.ack?.verified===true),'DUPLICATE_CHECKPOINTS_INCOMPLETE')
    for(const r of progress.steps){need(hash(duplicateFile(join(evidence,`duplicate-checkpoint-${lifecycle.pid}-${r.step}.json`),16*1024))===r.checkpointSha256&&JSON.stringify(JSON.parse(duplicateFile(join(evidence,`duplicate-ack-${lifecycle.pid}-${r.step}.json`),2048).toString('utf8')))===JSON.stringify(r.ack),'DUPLICATE_STAGE_CHANGED')}
    need(failed.serverError?.code===1062&&failed.serverError.sqlState==='23000'&&duplicateResultVerified(failed.checkpoint.observations),'DUPLICATE_TRIGGER_UNVERIFIED')
    verified=verifyDuplicate(JSON.parse(duplicateFile(join(evidence,`ui-grid-duplicate-${lifecycle.pid}.json`),16*1024).toString('utf8')));const ui=verified.ui,p=ui.proof
    need(p&&p.baselineRowsSha256===duplicateHash('baseline')&&p.markerRowsSha256===duplicateHash('marker')&&p.witnessConnectionId===guiId&&duplicateResultVerified(verified.native),'DUPLICATE_PROOF_MISMATCH')
    const failedProof=failed.checkpoint.report,lastFailed=failed.checkpoint.observations.duplicate.lastObservedTransactionState
    if(ui.failureCode==='NONE'&&lifecycle.exitCode===0&&(!failed.transaction.transactionActive||!failed.transaction.markerLockRetained||failed.checkpoint.observations.duplicate.lastApplyResult.inTransaction!==true||lastFailed?.active!==true||lastFailed.pendingAffected!==1)){
      classification='KNOWN_GAP_RED';failureCode='TRANSACTION_LOST'
    }else if(ui.failureCode==='NONE'){
      const rolled=progress.steps[2],last=verified.native.duplicate.lastObservedTransactionState
      need(lifecycle.exitCode===0&&progress.failureCode==='NONE'&&progress.steps.length===3&&DUPLICATE_CHECKS.every((k)=>ui.checks[k])&&p.faultRowsSha256===duplicateHash('fault')&&p.restoredRowsSha256===p.baselineRowsSha256&&p.uiActiveAfterError===true&&p.uiPendingAffectedAfterError===1&&p.dirtyRowsAfterError===1&&p.originalErrorClass==='1062'&&p.markerValueAfterError===7&&p.markerValueAfterRollback===0
        &&ui.actions.click>=14&&ui.actions.input===5&&ui.actions.keydown===0&&ui.actions.dblclick===3&&failedProof.uiActive&&failedProof.uiPendingAffected===1&&failedProof.dirtyRows===1&&failedProof.row1Unique===2&&failedProof.row3Value===7&&failedProof.original1062&&failedProof.witnessMarkerValue===7&&failed.checkpoint.observations.duplicate.lastApplyResult.inTransaction===true&&verified.native.duplicate.lastApplyResult.inTransaction===true&&failed.transaction.transactionActive&&failed.transaction.markerLockRetained&&lastFailed?.active===true&&lastFailed.pendingAffected===1
        &&rolled.checkpoint.report.witnessConnectionId===guiId&&rolled.checkpoint.report.witnessMarkerValue===0&&!rolled.transaction.transactionActive&&!rolled.transaction.markerLockRetained&&last?.active===false&&last.pendingAffected===0,'DUPLICATE_GREEN_NOT_VERIFIED')
      classification='VERIFIED';failureCode='NONE'
    }else if(lifecycle.exitCode===1&&['MYSQL_ERROR_DETAILS_LOST','TRANSACTION_LOST','DRAFT_LOST','WITNESS_FAILED'].includes(ui.failureCode)){
      const loss=ui.failureCode==='MYSQL_ERROR_DETAILS_LOST'?p.originalErrorClass==='other':ui.failureCode==='TRANSACTION_LOST'?(!p.uiActiveAfterError||p.uiPendingAffectedAfterError!==1||!failed.transaction.transactionActive||!failed.transaction.markerLockRetained):ui.failureCode==='DRAFT_LOST'?(p.dirtyRowsAfterError!==1||p.faultRowsSha256!==duplicateHash('fault')):p.markerValueAfterError!==7
      need(loss,'DUPLICATE_RED_UNVERIFIED');classification='KNOWN_GAP_RED';failureCode=ui.failureCode
    }else throw new RunFailure('DUPLICATE_NOT_VERIFIED')
  }catch{/* Retain partial UI proof and real independent cleanup state; never undo or fabricate a transaction. */}
  try{privateDirectory(hostRoot);privateDirectory(evidence);writeEvidence(output,{schemaVersion:1,scope:'mysql-grid-duplicate-real-ui-chain',runId:RUN,phase:'grid-duplicate',classification,failureCode,chainPassed:classification==='VERIFIED',productionReady:false,duplicateRecoveryVerified:classification==='VERIFIED',lockTimeoutVerified:false,osTrustedKeyboardVerified:false,crossBuildCredentialVerified:false,
    ui:verified?.ui??null,native:verified?.native??null,lifecycle,trace,observer:observation,finalTableReference:reference,finalTransaction:transaction,materialsPreserved,
    provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,failedRestartSha256:oldFailureSha,binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}})}catch{classification='INFRA_ERROR'}
  return {status:classification==='VERIFIED'?'GRID_DUPLICATE_VERIFIED':classification==='KNOWN_GAP_RED'?'GRID_DUPLICATE_KNOWN_GAP_RED':'GRID_DUPLICATE_INFRA_ERROR',runId:RUN,chainPassed:classification==='VERIFIED',productionReady:false,classification,failureCode,lifecycle}
}
async function runRestartProbe(checked,hostRoot,imageSha){
  const prior=restartPreflight(hostRoot,true,checked)
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'restart-probe')
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'PROBE_CHILD_PID_INVALID')
  privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
  const checkpointPath=join(hostRoot,'evidence',`host-probe-${lifecycle.pid}.json`)
  let checkpoint=null
  if(!absent(checkpointPath)){
    checkpoint=jsonFile(checkpointPath,1024);exact(checkpoint,['window','page','originAllowed'],'PROBE_CHECKPOINT_SCHEMA')
    need(Object.values(checkpoint).every((v)=>typeof v==='boolean'),'PROBE_CHECKPOINT_SCHEMA')
  }
  const reportPath=join(hostRoot,'evidence',`probe-restart-${lifecycle.pid}.json`)
  if(absent(reportPath))return {status:'RESTART_PROBE_INCOMPLETE',runId:RUN,probeCompleted:false,chainPassed:false,productionReady:false,restartVerified:false,checkpoint,lifecycle}
  const report=jsonFile(reportPath,16*1024)
  exact(report,['schemaVersion','scope','runId','phase','checks','observations','productionReady','restartVerified'],'PROBE_SCHEMA')
  need(report.schemaVersion===1&&report.scope==='restart-storage-probe'&&report.runId===RUN&&report.phase==='restart-probe'&&report.productionReady===false&&report.restartVerified===false,'PROBE_SCHEMA')
  exact(report.checks,['storageAccessible','markerMatched','nonemptyStore','startupFailureVisible'],'PROBE_CHECK_SCHEMA')
  need(Object.values(report.checks).every((v)=>typeof v==='boolean'),'PROBE_CHECK_SCHEMA')
  const n=report.observations
  exact(n,['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified'],'PROBE_NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='restart-probe'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false
    &&n.keyringGets===0&&n.keyringHits===0&&n.keyringSets===0,'PROBE_NATIVE_SCHEMA');exact(n.methods,[],'PROBE_BUSINESS_METHOD_FORBIDDEN')
  need(!lifecycle.timedOut&&lifecycle.exitCode===0,'PROBE_CHILD_NOT_COMPLETED')
  await live(imageSha)
  need(hash(file(join(hostRoot,'host-manifest.json'),16*1024,true))===prior.hostManifestSha256
    &&hash(file(join(hostRoot,'evidence','real-ui-report.json'),256*1024,true))===prior.initialReportSha256
    &&hash(file(join(hostRoot,'evidence','ui-initial.json'),256*1024,true))===prior.initialUiSha256,'INITIAL_MATERIAL_CHANGED')
  need(JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'SOURCE_CHANGED_DURING_PROBE')
  return {status:'RESTART_PROBE_COMPLETED',runId:RUN,probeCompleted:true,chainPassed:false,productionReady:false,restartVerified:false,checks:report.checks,checkpoint,lifecycle}
}
const BINARY_STEPS=['baseline','draft','applied','committed']
const BINARY_COLUMNS=['id','b1','b64','bin']
const BINARY_CATEGORIES=['integer','real','text','blob','null','boolean','date','unknown']
const BINARY_PROJECTION=['b1_hex','b1_dec','b64_hex','b64_dec','bin_hex','bin_len','bin_null']
const BINARY_CHECKS=['storage_marker','persisted_connection','credential_reconnect','fixture_created','table_open','column_categories_read','baseline_rows_read','bit_readonly_observed','blob_editable_entry','local_edits','apply_succeeded','committed_reload_verified']
const BINARY_FAILURES=['NONE','ISOLATION','CONNECTION','FIXTURE_OPEN','TABLE_OPEN','NATIVE_BRIDGE','CHECKPOINT','TIMEOUT','BINARY_READ_FAILED','READ_ONLY_BINARY','BIT_EDIT_ENTRY','EDITOR_VALUE_LOSS','APPLY_REJECTED','COMMIT_FAILED','BLOB_VALUE_MISMATCH','BIT_VALUE_MISMATCH']
// The priority order of the contract; NONE stays last and never wins by list index.
const BINARY_PRIORITY=['ISOLATION','CONNECTION','FIXTURE_OPEN','TABLE_OPEN','NATIVE_BRIDGE','CHECKPOINT','TIMEOUT','BINARY_READ_FAILED','READ_ONLY_BINARY','BIT_EDIT_ENTRY','EDITOR_VALUE_LOSS','APPLY_REJECTED','COMMIT_FAILED','BLOB_VALUE_MISMATCH','BIT_VALUE_MISMATCH','NONE']
const BINARY_NATIVE_BASE=['scope','runId','phase','methods','keyringGets','keyringHits','keyringSets','guiVerified','mysqlVerified','storePersistenceVerified']
const BINARY_ROW_KEYS=['id','b1Hex','b1Decimal','b64Hex','b64Decimal','binHex','binByteLength','binIsNull']
const BINARY_EDIT_HEX='00FF004142'
// Independent database truth of the seeded rows. The BIT hex width is deliberately not part of it.
const BINARY_SEED_SEMANTIC=[['1','18446744073709551615','00FFE4B8AD','5','0'],['0','1','00','1','0'],['1','1','','0','0'],['0','1','NULL','NULL','1']]
const binaryHex=(value)=>value===null||(typeof value==='string'&&/^[0-9A-F]*$/.test(value)&&value.length%2===0&&value.length<=512)
const binaryDecimal=(value)=>value===null||(typeof value==='string'&&/^[0-9]{1,40}$/.test(value))
const binaryProjectionHash=(rows)=>hash(JSON.stringify({columns:BINARY_PROJECTION,rows}))
function binaryRowsHash(rows){return hash(JSON.stringify({rows:rows.map((r)=>({id:r.id,b1Hex:r.b1Hex,b1Decimal:r.b1Decimal,b64Hex:r.b64Hex,b64Decimal:r.b64Decimal,binHex:r.binHex,binByteLength:r.binByteLength,binIsNull:r.binIsNull}))}))}
function binaryRow(r){
  exact(r,BINARY_ROW_KEYS,'BINARY_ROW_SCHEMA')
  need(Number.isSafeInteger(r.id)&&r.id>=1&&r.id<=4,'BINARY_ROW_SCHEMA')
  need(binaryHex(r.b1Hex)&&binaryDecimal(r.b1Decimal)&&binaryHex(r.b64Hex)&&binaryDecimal(r.b64Decimal)&&binaryHex(r.binHex),'BINARY_ROW_SCHEMA')
  need(r.binByteLength===null||(Number.isSafeInteger(r.binByteLength)&&r.binByteLength>=0&&r.binByteLength<=256),'BINARY_ROW_SCHEMA')
  need(typeof r.binIsNull==='boolean','BINARY_ROW_SCHEMA')
  need((r.b1Hex===null)===(r.b1Decimal===null)&&(r.b64Hex===null)===(r.b64Decimal===null),'BINARY_ROW_SCHEMA')
  need(r.binIsNull===(r.binHex===null)&&r.binIsNull===(r.binByteLength===null),'BINARY_ROW_SCHEMA')
}
function binaryRows(rows){
  need(Array.isArray(rows)&&rows.length===4,'BINARY_ROWS_SCHEMA')
  for(const r of rows)binaryRow(r)
  need(rows.every((r,i)=>r.id===i+1),'BINARY_ROWS_SCHEMA')
}
function binaryStage(s){
  exact(s,['rows','rowsSha256','targetRowId','targetBinHex','targetBinIsNull','columnCategories','blobEditableEntry','uiActive','uiPendingAffected','dirtyRows','witnessConnectionId','witnessProjectionSha256'],'BINARY_STAGE_SCHEMA')
  binaryRows(s.rows);need(hex(s.rowsSha256)&&s.rowsSha256===binaryRowsHash(s.rows),'BINARY_STAGE_SCHEMA')
  need(s.targetRowId===1&&binaryHex(s.targetBinHex)&&typeof s.targetBinIsNull==='boolean'&&s.targetBinIsNull===(s.targetBinHex===null),'BINARY_STAGE_SCHEMA')
  need(Array.isArray(s.columnCategories)&&s.columnCategories.length===4&&s.columnCategories.every((v)=>BINARY_CATEGORIES.includes(v)),'BINARY_STAGE_SCHEMA')
  need(typeof s.blobEditableEntry==='boolean'&&typeof s.uiActive==='boolean'&&integer(s.uiPendingAffected,1000)&&integer(s.dirtyRows,1000),'BINARY_STAGE_SCHEMA')
  need(Number.isSafeInteger(s.witnessConnectionId)&&s.witnessConnectionId>0&&hex(s.witnessProjectionSha256),'BINARY_STAGE_SCHEMA')
}
function binaryPayload(r){
  exact(r,['schemaVersion','step','uiActive','uiPendingAffected','dirtyRows','rowsSha256','witnessConnectionId','witnessProjectionSha256','columnCategories','blobEditableEntry'],'BINARY_CHECKPOINT_SCHEMA')
  need(r.schemaVersion===1&&BINARY_STEPS.includes(r.step)&&typeof r.uiActive==='boolean'&&integer(r.uiPendingAffected,1000)&&integer(r.dirtyRows,1000)&&hex(r.rowsSha256),'BINARY_CHECKPOINT_SCHEMA')
  need(Number.isSafeInteger(r.witnessConnectionId)&&r.witnessConnectionId>0&&hex(r.witnessProjectionSha256),'BINARY_CHECKPOINT_SCHEMA')
  need(Array.isArray(r.columnCategories)&&r.columnCategories.length===4&&r.columnCategories.every((v)=>BINARY_CATEGORIES.includes(v))&&typeof r.blobEditableEntry==='boolean','BINARY_CHECKPOINT_SCHEMA')
  if(r.step==='baseline')need(!r.uiActive&&r.uiPendingAffected===0&&r.dirtyRows===0,'BINARY_CHECKPOINT_MISMATCH')
}
function binaryNative(n){
  exact(n,[...BINARY_NATIVE_BASE,'binary'],'BINARY_NATIVE_SCHEMA')
  need(n.scope==='test-host-observation-only'&&n.runId===RUN&&n.phase==='grid-bit-blob'&&n.guiVerified===false&&n.mysqlVerified===false&&n.storePersistenceVerified===false,'BINARY_NATIVE_SCHEMA')
  need(n.methods&&typeof n.methods==='object'&&!Array.isArray(n.methods),'BINARY_NATIVE_SCHEMA')
  for(const metric of Object.values(n.methods)){exact(metric,['success','failure','totalElapsedMs'],'BINARY_NATIVE_SCHEMA');need(Object.values(metric).every((v)=>integer(v,100_000_000)),'BINARY_NATIVE_SCHEMA')}
  for(const name of ['rollbackTransaction','addConnection','updateConnection','testConnection','insertRow','deleteRows','fetchCellValue'])need(!n.methods[name]||(n.methods[name].success===0&&n.methods[name].failure===0),'BINARY_UNEXPECTED_METHOD')
  need(n.methods.connectConnection?.success>=1&&n.methods.connectConnection.failure===0,'BINARY_CONNECTION_MISSING')
  need([n.keyringGets,n.keyringHits,n.keyringSets].every((v)=>integer(v,10000))&&n.keyringGets>=1&&n.keyringHits>=1&&n.keyringSets===0,'BINARY_KEYRING_MISSING')
  exact(n.binary,['lastApplyResult','lastObservedTransactionState'],'BINARY_NATIVE_SCHEMA')
  const result=n.binary.lastApplyResult,state=n.binary.lastObservedTransactionState
  if(result!==null){exact(result,['ok','affected','inTransaction','outcomeCount','failedOutcomeCount','errorClass'],'BINARY_NATIVE_SCHEMA');need(typeof result.ok==='boolean'&&integer(result.affected,1000)&&typeof result.inTransaction==='boolean'&&integer(result.outcomeCount,1000)&&integer(result.failedOutcomeCount,1000)&&['none','other'].includes(result.errorClass),'BINARY_NATIVE_SCHEMA')}
  if(state!==null){exact(state,['active','pendingAffected'],'BINARY_NATIVE_SCHEMA');need(typeof state.active==='boolean'&&integer(state.pendingAffected,1_000_000),'BINARY_NATIVE_SCHEMA')}
  return {result,state}
}
/** The plan is fixed by the contract: seed 2 statements plus one witness select per completed stage. */
function binaryNativeCounts(n,k){
  const m=n.methods,count=(name)=>((m[name]?.success??0)+(m[name]?.failure??0))
  need(Number.isInteger(k)&&k>=1&&k<=4,'BINARY_NATIVE_COUNTS_INVALID')
  return m.connectConnection?.success>=1&&m.connectConnection.failure===0
    &&m.executeStatement?.success===(2+k)&&m.executeStatement.failure===0
    &&m.commitTransaction?.success===(k===4?2:1)&&m.commitTransaction.failure===0
    &&count('applyEdits')===(k>=3?1:0)&&count('rollbackTransaction')===0
    &&count('fetchCellValue')===0&&count('insertRow')===0&&count('deleteRows')===0
}
const binaryTable=`\`mysql_accept_${RUN.slice(0,16)}\`.\`gui_bin_${RUN}\``
function binaryProjectionSql(){return "HEX(b1),CAST(b1 AS UNSIGNED),HEX(b64),CAST(b64 AS UNSIGNED),IF(bin IS NULL,'NULL',HEX(bin)),IF(bin IS NULL,'NULL',CAST(OCTET_LENGTH(bin) AS CHAR)),CAST(bin IS NULL AS CHAR)"}
/** Independent observer projection: the same seven columns without any connection id. */
async function binaryObserver(imageSha,signal){
  const lines=deadlockLines(await deadlockSql('observer',`SELECT ${binaryProjectionSql()} FROM ${binaryTable} ORDER BY id`,imageSha,signal))
  need(lines.length===4,'BINARY_OBSERVER_ROWS')
  const rows=lines.map((line)=>line.split('\t'))
  need(rows.every((r)=>r.length===7&&r.every((v)=>v.length<=512)),'BINARY_OBSERVER_FORMAT')
  return {rows,projectionSha256:binaryProjectionHash(rows),rowCount:4}
}
/** Owned connection view of the performance schema; the observer's own id is never used here. */
async function binaryOwnedSession(id,imageSha,signal){
  need(Number.isSafeInteger(id)&&id>0,'BINARY_GUI_ID_INVALID')
  const db=`mysql_accept_${RUN.slice(0,16)}`
  const sql=`SELECT t.PROCESSLIST_ID,t.PROCESSLIST_DB FROM performance_schema.threads t WHERE t.PROCESSLIST_ID=${id} AND t.PROCESSLIST_DB='${db}' AND t.PROCESSLIST_ID<>CONNECTION_ID(); SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id=${id}`
  const lines=deadlockLines(await deadlockSql('admin',sql,imageSha,signal))
  need(lines.length===2,'BINARY_OWNED_SESSION_MISSING')
  const thread=lines[0].split('\t')
  need(thread.length===2&&thread[0]===String(id)&&thread[1]===db,'BINARY_OWNED_SESSION_FORMAT')
  need(/^[0-9]+$/.test(lines[1])&&Number.isSafeInteger(Number(lines[1])),'BINARY_OWNED_SESSION_FORMAT')
  return {connectionId:id,ownedDatabaseVerified:true,transactionCount:Number(lines[1])}
}
async function binaryColumns(imageSha,signal){
  const lines=deadlockLines(await deadlockSql('observer',`SELECT COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='mysql_accept_${RUN.slice(0,16)}' AND TABLE_NAME='gui_bin_${RUN}' ORDER BY ORDINAL_POSITION`,imageSha,signal))
  need(lines.length===4,'BINARY_COLUMNS_ROWS')
  const columns=lines.map((line)=>{const fields=line.split('\t');need(fields.length===2&&fields.every((v)=>v.length<=64),'BINARY_COLUMNS_FORMAT');return {name:fields[0],columnType:fields[1]}})
  return {columns,matches:columns[0].name==='id'&&columns[0].columnType==='int'&&columns[1].columnType==='bit(1)'&&columns[2].columnType==='bit(64)'&&columns[3].columnType==='blob'}
}
async function binaryEnded(ids,imageSha){
  need(Array.isArray(ids)&&ids.length>0&&ids.length<=4&&ids.every((id)=>Number.isSafeInteger(id)&&id>0),'BINARY_KNOWN_IDS_INVALID')
  const list=ids.join(',')
  const lines=deadlockLines(await deadlockSql('admin',`SELECT COUNT(*) FROM performance_schema.threads WHERE PROCESSLIST_ID IN (${list}); SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id IN (${list})`,imageSha))
  need(lines.length===2&&lines[0]==='0'&&lines[1]==='0','BINARY_FINAL_SESSIONS_ACTIVE')
  return {knownConnectionIds:ids,threadCount:0,transactionCount:0,ended:true}
}
/** The edited projection is derived from the independent truth plus the contract edit target only. */
function binaryEditedProjection(base){
  need(Array.isArray(base)&&base.length===4,'BINARY_PROJECTION_INVALID')
  return base.map((row,i)=>i===0?[row[0],row[1],row[2],row[3],BINARY_EDIT_HEX,String(BINARY_EDIT_HEX.length/2),row[6]]:row)
}
function binarySeedSemantics(projection){
  return Array.isArray(projection)&&projection.length===4&&projection.every((row,i)=>row[1]===BINARY_SEED_SEMANTIC[i][0]&&row[3]===BINARY_SEED_SEMANTIC[i][1]&&row[4]===BINARY_SEED_SEMANTIC[i][2]&&row[5]===BINARY_SEED_SEMANTIC[i][3]&&row[6]===BINARY_SEED_SEMANTIC[i][4])
}
function binaryRowsMatchProjection(rows,projection){
  if(!Array.isArray(rows)||!Array.isArray(projection)||rows.length!==projection.length)return false
  return rows.every((r,i)=>{
    const w=projection[i];if(!w)return false
    const isNull=w[4]==='NULL'
    return r.b1Decimal===w[1]&&r.b64Decimal===w[3]
      &&r.binHex===(isNull?null:w[4])
      &&r.binByteLength===(isNull?null:Number(w[5]))
      &&r.binIsNull===isNull
  })
}
function binaryPriority(codes){
  for(const code of BINARY_PRIORITY)if(codes.includes(code))return code
  return 'NONE'
}
function binaryFile(path,max){
  need(resolve(path)===path&&realpathSync(path)===path,'BINARY_FILE_INVALID');const before=lstatSync(path)
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&(before.mode&0o777)===0o600&&before.size<=max,'BINARY_FILE_INVALID');commitOwner(path)
  const fd=openSync(path,'r')
  try{const opened=fstatSync(fd);need(opened.dev===before.dev&&opened.ino===before.ino&&opened.uid===before.uid&&opened.isFile()&&opened.nlink===1&&(opened.mode&0o777)===0o600&&opened.size<=max,'BINARY_FILE_INVALID');const bytes=readFileSync(fd),after=lstatSync(path),last=fstatSync(fd);need(bytes.length<=max&&last.size===bytes.length&&after.dev===opened.dev&&after.ino===opened.ino&&after.uid===opened.uid&&last.nlink===1&&(last.mode&0o777)===0o600&&realpathSync(path)===path,'BINARY_FILE_CHANGED');return bytes}finally{closeSync(fd)}
}
function publishBinaryAck(hostRoot,pid,step,proof,verified,alive){
  need(integer(pid,2_147_483_647)&&pid>0&&BINARY_STEPS.includes(step)&&typeof verified==='boolean','BINARY_ACK_SCHEMA');binaryPayload(proof);need(proof.step===step,'BINARY_ACK_SCHEMA')
  const evidence=join(hostRoot,'evidence'),target=join(evidence,`binary-ack-${pid}-${step}.json`),source=`${target}.pending`
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(hostRoot);commitOwner(evidence)
  need(resolve(source)===source&&resolve(target)===target&&dirname(source)===evidence&&dirname(target)===evidence&&absent(target)&&alive(),'BINARY_ACK_PATH_INVALID')
  const ack={schemaVersion:1,runId:RUN,phase:'grid-bit-blob',pid,step,proof,verified},bytes=Buffer.from(`${JSON.stringify(ack)}\n`);need(bytes.length<=2048,'BINARY_ACK_LIMIT')
  const fd=openSync(source,'wx',0o600);let owned
  try{let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);need(n>0,'BINARY_ACK_WRITE');at+=n}fsyncSync(fd);owned=fstatSync(fd);need(owned.isFile()&&owned.nlink===1&&(owned.mode&0o777)===0o600&&owned.size===bytes.length,'BINARY_ACK_FILE_INVALID')}finally{closeSync(fd)}
  privateDirectory(hostRoot);privateDirectory(evidence);commitOwner(source);const actual=lstatSync(source)
  need(actual.isFile()&&!actual.isSymbolicLink()&&actual.nlink===1&&actual.dev===owned.dev&&actual.ino===owned.ino&&(actual.mode&0o777)===0o600&&realpathSync(source)===source&&resolve(source)===join(evidence,`binary-ack-${pid}-${step}.json.pending`)&&resolve(target)===join(evidence,`binary-ack-${pid}-${step}.json`)&&absent(target)&&alive(),'BINARY_ACK_FILE_INVALID')
  // Absolute source and target above identify only this PID/step's pending and final files.
  renameSync(source,target);return ack
}
async function watchBinary(child,alive,signal,hostRoot,imageSha){
  const pid=child.pid,steps=[];let failureCode='NONE'
  try{
    need(integer(pid,2_147_483_647)&&pid>0,'BINARY_CHILD_PID_INVALID')
    for(const step of BINARY_STEPS){
      const path=join(hostRoot,'evidence',`binary-checkpoint-${pid}-${step}.json`)
      while(absent(path)){if(!alive()||signal.aborted){if(steps.length>=1&&steps.every((r)=>r.ack?.verified===true))return {steps,failureCode:'PARTIAL_UI_FAILURE'};throw new RunFailure('BINARY_WATCH_STOPPED')}await commitPause(signal)}
      need(alive()&&!signal.aborted,'BINARY_WATCH_STOPPED');privateDirectory(hostRoot);privateDirectory(join(hostRoot,'evidence'))
      const bytes=binaryFile(path,16*1024),checkpoint=JSON.parse(bytes.toString('utf8'));exact(checkpoint,['schemaVersion','runId','phase','pid','report','observations'],'BINARY_CHECKPOINT_SCHEMA')
      need(checkpoint.schemaVersion===1&&checkpoint.runId===RUN&&checkpoint.phase==='grid-bit-blob'&&checkpoint.pid===pid&&checkpoint.report?.step===step,'BINARY_CHECKPOINT_MISMATCH');binaryPayload(checkpoint.report);binaryNative(checkpoint.observations)
      const record={step,checkpointSha256:hash(bytes),checkpoint,observer:null,session:null,columns:null,ack:null};steps.push(record)
      // Every independent read happens inside this checkpoint window, before the single-writer ack.
      const reads=await Promise.allSettled([binaryObserver(imageSha,signal),binaryOwnedSession(checkpoint.report.witnessConnectionId,imageSha,signal),binaryColumns(imageSha,signal)])
      if(reads[0].status==='fulfilled')record.observer=reads[0].value;if(reads[1].status==='fulfilled')record.session=reads[1].value;if(reads[2].status==='fulfilled')record.columns=reads[2].value
      const verified=reads.every((r)=>r.status==='fulfilled')
      await new Promise((done)=>setImmediate(done));need(alive()&&!signal.aborted,'BINARY_WATCH_STOPPED')
      record.ack=publishBinaryAck(hostRoot,pid,step,checkpoint.report,verified,alive);if(!verified)return {steps,failureCode:'BINARY_STAGE_UNVERIFIED'}
    }
  }catch{failureCode='BINARY_WATCH_FAILED'}return {steps,failureCode}
}
function verifyBinary(value){
  exact(value,['schemaVersion','report','observations'],'HOST_REPORT_SCHEMA');need(value.schemaVersion===1,'HOST_REPORT_SCHEMA');const ui=value.report
  exact(ui,['schemaVersion','runId','phase','actionDriver','checks','proof','actions','elapsedMs','failureCode'],'BINARY_REPORT_SCHEMA')
  need(ui.schemaVersion===1&&ui.runId===RUN&&ui.phase==='grid-bit-blob'&&ui.actionDriver==='native-dom-synthetic'&&BINARY_FAILURES.includes(ui.failureCode)&&integer(ui.elapsedMs,3600000),'BINARY_REPORT_SCHEMA')
  exact(ui.checks,BINARY_CHECKS,'BINARY_CHECK_SCHEMA');need(Object.values(ui.checks).every((v)=>typeof v==='boolean'),'BINARY_CHECK_SCHEMA')
  exact(ui.actions,['click','input','keydown','dblclick'],'BINARY_ACTION_SCHEMA');need(Object.values(ui.actions).every((v)=>integer(v,10000)),'BINARY_ACTION_SCHEMA')
  if(ui.proof!==null){
    const p=ui.proof;exact(p,['rowCount','columnCount','rows','rowsSha256','columnCategories','readonlyGap','editorOriginal','stages'],'BINARY_PROOF_SCHEMA')
    need(p.rowCount===4&&p.columnCount===3,'BINARY_PROOF_SCHEMA');binaryRows(p.rows)
    need(hex(p.rowsSha256)&&p.rowsSha256===binaryRowsHash(p.rows),'BINARY_PROOF_SCHEMA')
    need(Array.isArray(p.columnCategories)&&p.columnCategories.length===4&&p.columnCategories.every((v)=>BINARY_CATEGORIES.includes(v)),'BINARY_PROOF_SCHEMA')
    if(p.readonlyGap!==null){const g=p.readonlyGap;exact(g,['viewerOpened','viewerTitle','viewerHex','editorDialogPresent','inlineErrorText'],'BINARY_GAP_SCHEMA');need(typeof g.viewerOpened==='boolean'&&(g.viewerTitle===null||(typeof g.viewerTitle==='string'&&g.viewerTitle.length<=64)),'BINARY_GAP_SCHEMA');need(g.viewerHex===null||(typeof g.viewerHex==='string'&&g.viewerHex.length<=128),'BINARY_GAP_SCHEMA');need(typeof g.editorDialogPresent==='boolean'&&(g.inlineErrorText===null||(typeof g.inlineErrorText==='string'&&g.inlineErrorText.length<=64)),'BINARY_GAP_SCHEMA')}
    if(p.editorOriginal!==null){const e=p.editorOriginal;exact(e,['raw','isNull','valueDisabled','nullDisabled'],'BINARY_EDITOR_SCHEMA');need(e.raw===null||(typeof e.raw==='string'&&e.raw.length<=64),'BINARY_EDITOR_SCHEMA');need(typeof e.isNull==='boolean'&&typeof e.valueDisabled==='boolean'&&typeof e.nullDisabled==='boolean','BINARY_EDITOR_SCHEMA')}
    exact(p.stages,BINARY_STEPS,'BINARY_PROOF_SCHEMA')
    for(const step of BINARY_STEPS){const s=p.stages[step];if(s===null)continue;binaryStage(s)}
  }
  binaryNative(value.observations);return {ui,native:value.observations}
}
async function runGridBitBlob(checked,status,hostRoot,imageSha){
  need(pin,'BINARY_FIXTURE_PIN_REQUIRED')
  const prior=restartPreflight(hostRoot,true,checked),oldFailure=join(hostRoot,'evidence','real-ui-restart-report.json'),oldFailureSha=absent(oldFailure)?null:hash(file(oldFailure,256*1024,true))
  const lifecycle=await runChild(checked.receipt.binary,hostRoot,'grid-bit-blob',(child,alive,signal)=>watchBinary(child,alive,signal,hostRoot,imageSha))
  need(integer(lifecycle.pid,2_147_483_647)&&lifecycle.pid>0,'BINARY_CHILD_PID_INVALID')
  const evidence=join(hostRoot,'evidence'),output=join(evidence,`real-ui-grid-bit-blob-${lifecycle.pid}.json`)
  let observation=null,reference=null,cleanup=null,trace=null,verified=null,materialsPreserved=false,classification='INFRA_ERROR',failureCode='JOINT_VALIDATION_FAILED',columns=null
  try{
    privateDirectory(hostRoot);privateDirectory(evidence);await live(imageSha)
    const reportPath=join(evidence,`ui-grid-bit-blob-${lifecycle.pid}.json`)
    if(!absent(reportPath)){try{verified=verifyBinary(JSON.parse(binaryFile(reportPath,16*1024).toString('utf8')))}catch{/* Still collect the independent observer, final table and known-session state. */}}
    const reads=await Promise.allSettled([fixture(['--observe',READY]),binaryObserver(imageSha),binaryColumns(imageSha)])
    if(reads[0].status==='fulfilled'){try{verifyObserver(reads[0].value);observation=reads[0].value}catch{/* An invalid observer cannot promote a red or a green. */}}
    if(reads[1].status==='fulfilled')reference=reads[1].value
    if(reads[2].status==='fulfilled')columns=reads[2].value
    const progress=lifecycle.progress,ids=Array.from(new Set((progress?.steps??[]).map((r)=>r.checkpoint.report.witnessConnectionId)))
    // Known GUI sessions are only observed after the child exited; nothing is disconnected or removed.
    if(ids.length){try{cleanup=await binaryEnded(ids,imageSha)}catch{cleanup={knownConnectionIds:ids,ended:false}}}
    materialsPreserved=attemptMaterials(hostRoot,prior,oldFailureSha);trace=startupTrace(join(evidence,`startup-trace-${lifecycle.pid}.jsonl`))
    need(observation&&reference&&cleanup?.ended&&materialsPreserved&&!lifecycle.timedOut&&JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'BINARY_FINAL_STATE_UNVERIFIED')
    need(progress&&['NONE','PARTIAL_UI_FAILURE'].includes(progress.failureCode)&&progress.steps.length>=1&&progress.steps.every((r,i)=>r.step===BINARY_STEPS[i]&&r.ack?.verified===true&&r.observer&&r.session&&r.columns),'BINARY_CHECKPOINTS_INCOMPLETE')
    for(const r of progress.steps){need(hash(binaryFile(join(evidence,`binary-checkpoint-${lifecycle.pid}-${r.step}.json`),16*1024))===r.checkpointSha256&&JSON.stringify(JSON.parse(binaryFile(join(evidence,`binary-ack-${lifecycle.pid}-${r.step}.json`),2048).toString('utf8')))===JSON.stringify(r.ack),'BINARY_STAGE_CHANGED')}
    need(verified?.ui.proof,'BINARY_UI_PROOF_MISSING')
    const ui=verified.ui,p=ui.proof,steps=progress.steps,stages=steps.map((r)=>p.stages[r.step])
    for(let i=0;i<BINARY_STEPS.length;i++)need((p.stages[BINARY_STEPS[i]]!==null)===(i<steps.length),'BINARY_STAGE_SEQUENCE_MISMATCH')
    for(let i=0;i<steps.length;i++){
      const actual=stages[i],request=steps[i].checkpoint.report
      need(actual&&actual.rowsSha256===request.rowsSha256&&actual.witnessConnectionId===request.witnessConnectionId&&actual.witnessProjectionSha256===request.witnessProjectionSha256&&actual.uiActive===request.uiActive&&actual.uiPendingAffected===request.uiPendingAffected&&actual.dirtyRows===request.dirtyRows&&JSON.stringify(actual.columnCategories)===JSON.stringify(request.columnCategories)&&actual.blobEditableEntry===request.blobEditableEntry&&steps[i].session.connectionId===actual.witnessConnectionId,'BINARY_ACTUAL_PROOF_MISMATCH')
    }
    const baselineProjection=steps[0].observer.rows
    need(binarySeedSemantics(baselineProjection),'BINARY_BASELINE_TRUTH_UNVERIFIED')
    const editedProjection=binaryEditedProjection(baselineProjection)
    const expectedObserver=[baselineProjection,baselineProjection,baselineProjection,editedProjection]
    const expectedWitness=[baselineProjection,baselineProjection,editedProjection,editedProjection]
    const expectedRows=[baselineProjection,editedProjection,editedProjection,editedProjection]
    if(ui.failureCode==='NONE'){
      need(lifecycle.exitCode===0&&progress.failureCode==='NONE'&&steps.length===4&&BINARY_CHECKS.every((k)=>ui.checks[k]),'BINARY_GREEN_NOT_VERIFIED')
      need(binaryNativeCounts(verified.native,4),'BINARY_FINAL_NATIVE_COUNTS_MISMATCH')
      for(let i=0;i<steps.length;i++){
        const actual=stages[i],record=steps[i]
        need(actual&&binaryRowsMatchProjection(actual.rows,expectedRows[i])&&actual.rowsSha256===binaryRowsHash(actual.rows),'BINARY_GREEN_ROWS_MISMATCH')
        need(actual.targetBinHex===(expectedRows[i][0][4]==='NULL'?null:expectedRows[i][0][4])&&actual.targetBinIsNull===(expectedRows[i][0][4]==='NULL'),'BINARY_GREEN_TARGET_MISMATCH')
        need(actual.witnessProjectionSha256===binaryProjectionHash(expectedWitness[i]),'BINARY_GREEN_WITNESS_MISMATCH')
        need(record.observer.projectionSha256===binaryProjectionHash(expectedObserver[i]),'BINARY_GREEN_OBSERVER_MISMATCH')
        need(actual.witnessConnectionId===stages[0].witnessConnectionId,'BINARY_GREEN_CONNECTION_MISMATCH')
        need(actual.uiActive===(i===2)&&actual.uiPendingAffected===(i===2?1:0)&&actual.dirtyRows===(i===1?1:0),'BINARY_GREEN_TRANSACTION_MISMATCH')
        need(record.session.transactionCount===(i===2?1:0)&&record.session.ownedDatabaseVerified===true,'BINARY_GREEN_SESSION_MISMATCH')
        need(record.columns.matches===true,'BINARY_GREEN_COLUMN_TYPES_MISMATCH')
        need(binaryNativeCounts(record.checkpoint.observations,i+1),'BINARY_GREEN_NATIVE_COUNTS_MISMATCH')
      }
      need(reference.projectionSha256===binaryProjectionHash(editedProjection),'BINARY_FINAL_OBSERVER_CHANGED')
      classification='VERIFIED';failureCode='NONE'
    }else if(ui.failureCode==='READ_ONLY_BINARY'){
      need(lifecycle.exitCode===1&&progress.failureCode==='PARTIAL_UI_FAILURE'&&steps.length===1,'BINARY_READ_ONLY_SHAPE_UNVERIFIED')
      need(p.readonlyGap&&p.readonlyGap.viewerOpened===true&&p.readonlyGap.editorDialogPresent===false&&p.editorOriginal===null,'BINARY_READ_ONLY_GAP_MISSING')
      need(p.stages.draft===null&&p.stages.applied===null&&p.stages.committed===null,'BINARY_READ_ONLY_LATE_STAGE_PRESENT')
      need(stages[0]&&binaryRowsMatchProjection(stages[0].rows,baselineProjection)&&stages[0].rowsSha256===binaryRowsHash(stages[0].rows),'BINARY_READ_ONLY_ROWS_UNVERIFIED')
      need(stages[0].witnessProjectionSha256===binaryProjectionHash(baselineProjection),'BINARY_READ_ONLY_WITNESS_UNVERIFIED')
      need(steps[0].session.transactionCount===0&&steps[0].session.ownedDatabaseVerified===true,'BINARY_READ_ONLY_SESSION_UNVERIFIED')
      need(steps[0].columns.matches===true,'BINARY_READ_ONLY_COLUMN_TYPE_UNVERIFIED')
      need(binaryNativeCounts(verified.native,1),'BINARY_READ_ONLY_NATIVE_COUNTS_MISMATCH')
      // The final independent observer is read after the child exited; a known gap may only be declared while the table still holds A.
      need(reference.projectionSha256===binaryProjectionHash(baselineProjection),'BINARY_READ_ONLY_FINAL_OBSERVER_CHANGED')
      classification='KNOWN_GAP_RED';failureCode='READ_ONLY_BINARY'
    }else if(['BINARY_READ_FAILED','BIT_EDIT_ENTRY','EDITOR_VALUE_LOSS','APPLY_REJECTED','COMMIT_FAILED','BLOB_VALUE_MISMATCH','BIT_VALUE_MISMATCH'].includes(ui.failureCode)){
      const candidates=[]
      if(ui.failureCode==='BIT_EDIT_ENTRY'){need(steps.length===1&&ui.checks.bit_readonly_observed===false,'BINARY_PRODUCT_RED_UNVERIFIED');candidates.push('BIT_EDIT_ENTRY')}
      else if(ui.failureCode==='EDITOR_VALUE_LOSS'){const editor=p.editorOriginal;need(editor!==null&&(editor.raw!=='00FFE4B8AD'||editor.isNull||editor.valueDisabled||editor.nullDisabled),'BINARY_PRODUCT_RED_UNVERIFIED');candidates.push('EDITOR_VALUE_LOSS')}
      else if(ui.failureCode==='APPLY_REJECTED'){const native=binaryNative(verified.native);need((native.result&&native.result.ok===false)||(verified.native.methods.applyEdits?.failure??0)>0,'BINARY_PRODUCT_RED_UNVERIFIED');candidates.push('APPLY_REJECTED')}
      else if(ui.failureCode==='COMMIT_FAILED'){const native=binaryNative(verified.native);need((verified.native.methods.commitTransaction?.failure??0)>0||(native.state&&native.state.active===true),'BINARY_PRODUCT_RED_UNVERIFIED');candidates.push('COMMIT_FAILED')}
      else if(ui.failureCode==='BLOB_VALUE_MISMATCH'){const last=stages[steps.length-1];need(last&&!binaryRowsMatchProjection(last.rows,editedProjection),'BINARY_PRODUCT_RED_UNVERIFIED');candidates.push('BLOB_VALUE_MISMATCH')}
      else if(ui.failureCode==='BIT_VALUE_MISMATCH'){const last=stages[steps.length-1];need(last&&last.rows.some((r,i)=>r.b64Decimal!==baselineProjection[i][3]||r.b1Decimal!==baselineProjection[i][1]),'BINARY_PRODUCT_RED_UNVERIFIED');candidates.push('BIT_VALUE_MISMATCH')}
      else {
        // A driver read failure without actual rows stays an infra diagnosis and never becomes a product red.
        const base=stages[0]
        if(base&&binaryRowsMatchProjection(base.rows,baselineProjection))candidates.push('BINARY_READ_FAILED')
        else{classification='INFRA_ERROR';failureCode='BINARY_READ_FAILED'}
      }
      if(classification!=='INFRA_ERROR'){classification='KNOWN_GAP_RED';failureCode=binaryPriority(candidates)}
    }else throw new RunFailure('BINARY_NOT_VERIFIED')
  }catch{
    // Keep the actual rows, hex, lengths, NULL flags and server references; no corrective write is issued.
    const uiCode=verified?.ui?.failureCode
    // Keep the real typed UI failure code; the classification stays INFRA_ERROR and is never promoted to a product red here.
    if(uiCode&&uiCode!=='NONE'&&BINARY_FAILURES.includes(uiCode))failureCode=uiCode
  }
  try{privateDirectory(hostRoot);privateDirectory(evidence);writeEvidence(output,{schemaVersion:1,scope:'mysql-grid-bit-blob-real-ui-chain',runId:RUN,phase:'grid-bit-blob',classification,failureCode,chainPassed:classification==='VERIFIED',productionReady:false,bitReadonlyVerified:classification==='VERIFIED',blobEditableEntryVerified:classification==='VERIFIED',fullTypeMatrixVerified:false,fullParityVerified:false,referenceProductOperated:false,mysql84Verified:false,windowsVerified:false,osTrustedKeyboardVerified:false,soakVerified:false,crossBuildCredentialVerified:false,
    ui:verified?.ui??null,native:verified?.native??null,lifecycle,trace,observer:observation,finalTableReference:reference,finalSessionCleanup:cleanup,materialsPreserved,columns,
    provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,hostManifestSha256:prior.hostManifestSha256,initialReportSha256:prior.initialReportSha256,initialUiSha256:prior.initialUiSha256,failedRestartSha256:oldFailureSha,binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}})}catch{classification='INFRA_ERROR'}
  return {status:classification==='VERIFIED'?'GRID_BIT_BLOB_VERIFIED':classification==='KNOWN_GAP_RED'?'GRID_BIT_BLOB_KNOWN_GAP_RED':'GRID_BIT_BLOB_INFRA_ERROR',runId:RUN,chainPassed:classification==='VERIFIED',productionReady:false,classification,failureCode,lifecycle}
}
async function run(args) {
  need(['--status','--check-only','--run','--run-restart','--probe-restart','--run-restart-attempt','--run-explain','--run-commit','--run-grid-deadlock','--run-grid-duplicate','--run-grid-timeout','--run-grid-precision','--run-grid-text','--run-session-timezone','--run-grid-time','--run-grid-time-crosszone','--run-grid-bit-blob'].includes(args[0]),'ARGUMENTS_INVALID')
  const opts={};for(let i=1;i<args.length;i+=2){need(['--image-sha256','--artifact','--artifact-sha256'].includes(args[i])&&typeof args[i+1]==='string'&&!(args[i] in opts),'ARGUMENTS_INVALID');opts[args[i]]=args[i+1]}
  if(args[0]==='--run-explain')need(pin,'EXPLAIN_FIXTURE_PIN_REQUIRED')
  if(args[0]==='--run-commit')need(pin,'COMMIT_FIXTURE_PIN_REQUIRED')
  if(args[0]==='--run-grid-deadlock')need(pin,'DEADLOCK_FIXTURE_PIN_REQUIRED')
  if(args[0]==='--run-grid-duplicate')need(pin,'DUPLICATE_FIXTURE_PIN_REQUIRED')
  if(args[0]==='--run-grid-timeout')need(pin,'TIMEOUT_FIXTURE_PIN_REQUIRED')
  if(args[0]==='--run-grid-precision')need(pin,'PRECISION_FIXTURE_PIN_REQUIRED')
  if(args[0]==='--run-grid-text')need(pin,'TEXT_FIXTURE_PIN_REQUIRED')
  if(args[0]==='--run-session-timezone')need(pin,'SESSION_TIMEZONE_FIXTURE_PIN_REQUIRED')
  if(args[0]==='--run-grid-time')need(pin,'TIME_FIXTURE_PIN_REQUIRED')
  if(args[0]==='--run-grid-time-crosszone')need(pin,'CROSSZONE_FIXTURE_PIN_REQUIRED')
  if(args[0]==='--run-grid-bit-blob')need(pin,'BINARY_FIXTURE_PIN_REQUIRED')
  const status=await live(opts['--image-sha256'])
  if(args[0]==='--status')return {status:'OWNED_SERVICE_LIVE',runId:RUN,ownershipVerified:true,running:true,healthy:true,loopbackBindingVerified:true,manifestSha256:status.manifestSha256,imageSha256:status.imageSha256,containerId:status.containerId,serverVersion:status.serverVersion,guiPassed:false}
  const checked=artifact(opts['--artifact'],opts['--artifact-sha256'])
  if(args[0]==='--check-only')return {status:'SOURCE_ARTIFACT_VERIFIED',runId:RUN,launchPerformed:false,guiPassed:false}
  const hostRoot=join(realpathSync(tmpdir()),`dbstudio-mysql-acceptance-${RUN}`)
  if(args[0]==='--run-grid-bit-blob')return await runGridBitBlob(checked,status,hostRoot,opts['--image-sha256'])
  if(args[0]==='--run-grid-time')return await runGridTime(checked,status,hostRoot,opts['--image-sha256'])
  if(args[0]==='--run-grid-time-crosszone')return await runGridTimeCrosszone(checked,status,hostRoot,opts['--image-sha256'])
  if(args[0]==='--run-session-timezone')return await runSessionTimezone(checked,status,hostRoot,opts['--image-sha256'])
  if(args[0]==='--run-grid-text')return await runGridText(checked,status,hostRoot,opts['--image-sha256'])
  if(args[0]==='--run-grid-precision')return await runGridPrecision(checked,status,hostRoot,opts['--image-sha256'])
  if(args[0]==='--run-grid-timeout')return await runGridTimeout(checked,status,hostRoot,opts['--image-sha256'])
  if(args[0]==='--run-grid-duplicate')return await runGridDuplicate(checked,status,hostRoot,opts['--image-sha256'])
  if(args[0]==='--run-grid-deadlock')return await runGridDeadlock(checked,status,hostRoot,opts['--image-sha256'])
  if(args[0]==='--run-commit')return await runCommit(checked,status,hostRoot,opts['--image-sha256'])
  if(args[0]==='--run-explain')return await runExplain(checked,status,hostRoot,opts['--image-sha256'])
  if(args[0]==='--run-restart-attempt')return await runRestartAttempt(checked,status,hostRoot,opts['--image-sha256'])
  if(args[0]==='--probe-restart')return await runRestartProbe(checked,hostRoot,opts['--image-sha256'])
  if(args[0]==='--run-restart')return await runRestart(checked,status,hostRoot,opts['--image-sha256'])
  try { lstatSync(hostRoot); throw new RunFailure('INITIAL_ROOT_ALREADY_EXISTS') } catch(error) { if(error.code!=='ENOENT')throw error }
  const lifecycle=await runChild(checked.receipt.binary,hostRoot)
  try {
  // End-of-run ownership is checked again before the independent readback.
  await live(opts['--image-sha256']);const observation=await fixture(['--observe',READY]);verifyObserver(observation)
  need(!lifecycle.timedOut&&lifecycle.exitCode===0,'CHILD_NOT_PASSED')
  const reportPath=join(hostRoot,'evidence','ui-initial.json');const verified=verifyUi(jsonFile(reportPath))
  need(JSON.stringify(sourceSnapshot())===JSON.stringify(checked.current),'SOURCE_CHANGED_DURING_RUN')
  const report={schemaVersion:1,scope:'mysql-initial-real-ui-chain',runId:RUN,phase:'initial',actionDriver:'native-dom-synthetic',chainPassed:true,productionReady:false,osTrustedKeyboardVerified:false,restartVerified:false,soakVerified:false,referenceProductOperated:false,mysql84Verified:false,windowsVerified:false,
    checks:verified.ui.checks,pages:verified.ui.pages,actions:verified.ui.actions,elapsedMs:verified.ui.elapsedMs,native:verified.native,observer:{counts:observation.counts,autocommit:true,readOnly:true,precisionChecks:11,pagingChecks:9,independentConnections:3},lifecycle,
    provenance:{...pairProvenance(checked),manifestSha256:MANIFEST_SHA,containerId:CONTAINER,imageSha256:status.imageSha256,fixtureSourceSha256:FIXTURE_SHA,binarySha256:checked.receipt.binarySha256,frontendIndexSha256:checked.receipt.frontendIndexSha256,frontendAssetsSha256:hash(JSON.stringify(Object.entries(checked.receipt.frontendAssets).sort(([a],[b])=>a.localeCompare(b)))),source:checked.current}}
  writeEvidence(join(hostRoot,'evidence','real-ui-report.json'),report)
  return {status:'INITIAL_CHAIN_VERIFIED',runId:RUN,chainPassed:true,productionReady:false,stdoutBytes:lifecycle.stdoutBytes,stderrBytes:lifecycle.stderrBytes}
  } catch {
    // Only this run's already-created evidence directory; never create/reset the initial host root.
    try {
      const evidence=join(hostRoot,'evidence');const info=lstatSync(evidence)
      need(info.isDirectory()&&!info.isSymbolicLink()&&realpathSync(evidence)===evidence&&(info.mode&0o777)===0o700,'EVIDENCE_DIRECTORY_INVALID')
      writeEvidence(join(evidence,'real-ui-report.json'),{schemaVersion:1,scope:'mysql-initial-real-ui-chain',runId:RUN,phase:'initial',chainPassed:false,productionReady:false,failureCode:'JOINT_VALIDATION_FAILED',lifecycle})
    } catch { /* Retain existing host materials; never overwrite a prior report. */ }
    throw new RunFailure('JOINT_VALIDATION_FAILED')
  }
}
return { main: run }
}
export async function main(args=process.argv.slice(2)) {
  const index=args.indexOf('--fixture-pin')
  if(index===-1)return await createRunner().main(args)
  if(index<1||index!==args.lastIndexOf('--fixture-pin')||typeof args[index+1]!=='string'||args[index+1].startsWith('--'))throw new Error('FIXTURE_PIN_ARGUMENT_INVALID')
  const pin=loadFixturePin(args[index+1])
  return await createRunner(pin).main([...args.slice(0,index),...args.slice(index+2)])
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then((v)=>{console.log(JSON.stringify(v));if(v.probeCompleted===false||v.status==='RESTART_ATTEMPT_FAILED'||v.status==='EXPLAIN_CHAIN_FAILED'||v.status==='COMMIT_CHAIN_FAILED'||v.status==='GRID_DEADLOCK_KNOWN_GAP_RED'||v.status==='GRID_DEADLOCK_INFRA_ERROR'||v.status==='GRID_DUPLICATE_KNOWN_GAP_RED'||v.status==='GRID_DUPLICATE_INFRA_ERROR'||v.status==='GRID_TIMEOUT_KNOWN_GAP_RED'||v.status==='GRID_TIMEOUT_INFRA_ERROR'||v.status==='GRID_PRECISION_KNOWN_GAP_RED'||v.status==='GRID_PRECISION_INFRA_ERROR'||v.status==='GRID_TEXT_KNOWN_GAP_RED'||v.status==='GRID_TEXT_INFRA_ERROR'||v.status==='SESSION_TIMEZONE_KNOWN_GAP_RED'||v.status==='SESSION_TIMEZONE_INFRA_ERROR'||v.status==='GRID_TIME_KNOWN_GAP_RED'||v.status==='GRID_TIME_INFRA_ERROR'||v.status==='GRID_TIME_CROSSZONE_KNOWN_GAP_RED'||v.status==='GRID_TIME_CROSSZONE_INFRA_ERROR'||v.status==='GRID_BIT_BLOB_KNOWN_GAP_RED'||v.status==='GRID_BIT_BLOB_INFRA_ERROR')process.exitCode=1}).catch(()=>{console.error(JSON.stringify({status:'MYSQL_UI_ACCEPTANCE_FAILED',chainPassed:false,productionReady:false}));process.exitCode=1})
