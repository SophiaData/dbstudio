//! Test artifact isolation only. No database implementation, UI automation or secret export.
use dbstudio_core::{AppError, SecretStore};
use dbstudio_protocol::SecretMap;
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex}};

pub const ENV_NAMES: &[&str] = &[
    "DBSTUDIO_MYSQL_ACCEPTANCE_ROOT", "DBSTUDIO_MYSQL_ACCEPTANCE_RUN_ID",
    "DBSTUDIO_MYSQL_ACCEPTANCE_PHASE", "DBSTUDIO_MYSQL_ACCEPTANCE_MANIFEST",
];
const HOST_MANIFEST: &str = "host-manifest.json";
const MAX_MANIFEST: u64 = 65536;
fn invalid() -> AppError { AppError::invalid("MySQL 验收隔离配置无效；未打开生产数据") }
fn storage_error() -> AppError { AppError::new("secret-storage-unavailable", "独立测试系统凭据存储不可用") }
fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str, AppError> { value.get(name).and_then(Value::as_str).ok_or_else(invalid) }
fn private_metadata(path: &Path, directory: bool) -> Result<(), AppError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| invalid())?;
    if metadata.file_type().is_symlink() || (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) { return Err(invalid()) }
    #[cfg(unix)] {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let mode = metadata.permissions().mode() & 0o777;
        if mode != if directory { 0o700 } else { 0o600 } || (!directory && metadata.nlink() != 1) { return Err(invalid()) }
    }
    Ok(())
}
fn read_private_json(path: &Path) -> Result<Value, AppError> {
    private_metadata(path, false)?;
    let file = File::open(path).map_err(|_| invalid())?;
    if file.metadata().map_err(|_| invalid())?.len() > MAX_MANIFEST { return Err(invalid()) }
    let mut bytes = Vec::new(); file.take(MAX_MANIFEST + 1).read_to_end(&mut bytes).map_err(|_| invalid())?;
    if bytes.len() as u64 > MAX_MANIFEST { return Err(invalid()) }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}
fn create_private_json(path: &Path, value: &Value) -> Result<(), AppError> {
    let mut options = OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(path).map_err(|_| invalid())?;
    file.write_all(&serde_json::to_vec(value).map_err(|_| invalid())?).and_then(|_| file.sync_all()).map_err(|_| invalid())
}
fn create_private_dir(path: &Path) -> Result<(), AppError> {
    let mut options = fs::DirBuilder::new();
    #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; options.mode(0o700); }
    options.create(path).map_err(|_| invalid())
}
fn identifier(value: &str) -> bool { !value.is_empty() && value.len() <= 64 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') }
fn store_id(run_id: &str) -> Result<[u8; 16], AppError> {
    if run_id.len() != 32 || !run_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) || run_id.bytes().all(|b| b == b'0') { return Err(invalid()) }
    let mut output = [0; 16];
    for (index, byte) in output.iter_mut().enumerate() { *byte = u8::from_str_radix(&run_id[index*2..index*2+2],16).map_err(|_| invalid())?; }
    Ok(output)
}

const COMMIT_STEPS:&[&str]=&["baseline","pending","committed"];
#[derive(Default)]
struct CommitHandshake {published:[Option<Value>;3],confirmed:[bool;3]}
#[derive(Clone,Copy)]
enum CommitFile {Checkpoint,Ack,DeadlockCheckpoint,DeadlockAck,DuplicateCheckpoint,DuplicateAck,TimeoutCheckpoint,TimeoutAck,PrecisionCheckpoint,PrecisionAck,TextCheckpoint,TextAck,SessionTimezoneCheckpoint,SessionTimezoneAck,TimeCheckpoint,TimeAck,CrosszoneCheckpoint,CrosszoneAck,BinaryCheckpoint,BinaryAck}
const TIME_STEPS:&[&str]=&["baseline","draft","applied","committed"];
#[derive(Default)]
struct TimeHandshake {published:[Option<Value>;4],confirmed:[bool;4],native:[Option<Value>;4]}
#[derive(Default)]
struct TimeObservation {last_apply:Option<Value>,last_transaction:Option<Value>}
fn time_step(request:&Value,checkpoint:bool)->Result<usize,AppError>{
    if serde_json::to_vec(request).map_err(|_|invalid())?.len()>2048{return Err(invalid())}if checkpoint{exact_fields(request,&["schemaVersion","step","uiActive","uiPendingAffected","dirtyRows","valuesSha256","witnessConnectionId","witnessProjectionSha256"])?;}else{exact_fields(request,&["schemaVersion","step"])?;}
    if request["schemaVersion"]!=1{return Err(invalid())}let step=TIME_STEPS.iter().position(|step|Some(*step)==request["step"].as_str()).ok_or_else(invalid)?;
    if checkpoint{let active=request["uiActive"].as_bool().ok_or_else(invalid)?;let pending=integer(&request["uiPendingAffected"],1000)?;let dirty=integer(&request["dirtyRows"],1000)?;hash_string(&request["valuesSha256"])?;positive_connection_id(&request["witnessConnectionId"])?;hash_string(&request["witnessProjectionSha256"])?;if step==0&&(active||pending!=0||dirty!=0){return Err(invalid())}}Ok(step)
}
fn time_small_string(value:&Value)->Result<(),AppError>{let raw=value.as_str().ok_or_else(invalid)?;if raw.encode_utf16().count()>64||raw.chars().any(char::is_control){return Err(invalid())}Ok(())}
fn time_stage(stage:&Value)->Result<(),AppError>{
    exact_fields(stage,&["values","columnTypes","valuesSha256","witnessConnectionId","witnessProjection","witnessProjectionSha256","uiActive","uiPendingAffected","dirtyRows"])?;positive_connection_id(&stage["witnessConnectionId"])?;hash_string(&stage["valuesSha256"])?;hash_string(&stage["witnessProjectionSha256"])?;stage["uiActive"].as_bool().ok_or_else(invalid)?;integer(&stage["uiPendingAffected"],1000)?;integer(&stage["dirtyRows"],1000)?;
    for(name,length)in[("values",6),("witnessProjection",11)]{let values=stage[name].as_array().ok_or_else(invalid)?;if values.len()!=length{return Err(invalid())}for value in values{if !value.is_null(){time_small_string(value)?;}}}
    let types=stage["columnTypes"].as_array().ok_or_else(invalid)?;if types.len()!=6{return Err(invalid())}for kind in types{if !["integer","real","text","blob","null","boolean","date","unknown"].contains(&kind.as_str().ok_or_else(invalid)?){return Err(invalid())}}Ok(())
}
fn time_apply_scalars(value:&Value)->Option<Value>{
    let ok=value["ok"].as_bool()?;let affected=integer(&value["affected"],1000).ok()?;let transaction=value["inTransaction"].as_bool()?;let outcomes=value["outcomes"].as_array()?;if outcomes.len()>1000{return None}let mut failed=0;for outcome in outcomes{let error=outcome.get("error")?;if !error.is_null(){if !error.is_string(){return None}failed+=1;}}
    Some(json!({"ok":ok,"affected":affected,"inTransaction":transaction,"outcomeCount":outcomes.len(),"failedOutcomeCount":failed,"errorClass":if ok&&failed==0{"none"}else{"other"}}))
}
fn time_expected_values(edited:bool)->Value{if edited{json!(["1","2025-12-31","2025-12-31 23:59:58.999999","2025-12-31 23:59:58.654321","49:03:04.999998","-02:03:04.999997"])}else{json!(["1","2024-02-29","2024-02-29 12:34:56.000001","2024-02-29 12:34:56.123456","-25:02:03.000002","01:02:03.000003"])}}
fn time_expected_projection(edited:bool)->Value{if edited{json!(["+00:00","2025-12-31","2025-12-31 23:59:58.999999","2025-12-31 23:59:58.654321","49:03:04.999998","-02:03:04.999997","999999","654321","999998","999997","1767225598.654321"])}else{json!(["+00:00","2024-02-29","2024-02-29 12:34:56.000001","2024-02-29 12:34:56.123456","-25:02:03.000002","01:02:03.000003","1","123456","2","3","1709210096.123456"])}}
const CROSSZONE_STEPS:&[&str]=&["baseline","shifted","restored"];
// Closed header categories; the observed TIME header class stays actual and is never pre-corrected.
const CROSSZONE_CATEGORIES:&[&str]=&["integer","real","text","blob","null","boolean","date","unknown"];
#[derive(Default)]
struct CrosszoneHandshake {published:[Option<Value>;3],confirmed:[bool;3],native:[Option<Value>;3]}
fn crosszone_step(request:&Value,checkpoint:bool)->Result<usize,AppError>{
    if serde_json::to_vec(request).map_err(|_|invalid())?.len()>2048{return Err(invalid())}
    if checkpoint{exact_fields(request,&["schemaVersion","step","uiActive","uiPendingAffected","dirtyRows","valuesSha256","witnessConnectionId","witnessProjectionSha256","sessionTimezone","resultTabsBefore","resultTabsAfter","activeTabGeneration","activeTabOwned","nativeExecuteCount"])?;}else{exact_fields(request,&["schemaVersion","step"])?;}
    if request["schemaVersion"]!=1{return Err(invalid())}let step=CROSSZONE_STEPS.iter().position(|step|Some(*step)==request["step"].as_str()).ok_or_else(invalid)?;
    // Shape only: the displayed values are never compared with the expected truth here, so a real red stays publishable.
    if checkpoint{
        request["uiActive"].as_bool().ok_or_else(invalid)?;
        integer(&request["uiPendingAffected"],1000)?;
        integer(&request["dirtyRows"],1000)?;
        hash_string(&request["valuesSha256"])?;
        positive_connection_id(&request["witnessConnectionId"])?;
        hash_string(&request["witnessProjectionSha256"])?;
        time_small_string(&request["sessionTimezone"])?;
        integer(&request["resultTabsBefore"],1000)?;
        integer(&request["resultTabsAfter"],1000)?;
        integer(&request["activeTabGeneration"],1000)?;
        request["activeTabOwned"].as_bool().ok_or_else(invalid)?;
        integer(&request["nativeExecuteCount"],10000)?;
    }
    Ok(step)
}
fn crosszone_stage(stage:&Value)->Result<(),AppError>{
    exact_fields(stage,&["values","columnTypes","valuesSha256","witnessConnectionId","witnessProjection","witnessProjectionSha256","uiActive","uiPendingAffected","dirtyRows","sessionTimezone","resultTabsBefore","resultTabsAfter","activeTabGeneration","activeTabOwned","nativeExecuteCount"])?;
    hash_string(&stage["valuesSha256"])?;positive_connection_id(&stage["witnessConnectionId"])?;hash_string(&stage["witnessProjectionSha256"])?;
    stage["uiActive"].as_bool().ok_or_else(invalid)?;integer(&stage["uiPendingAffected"],1000)?;integer(&stage["dirtyRows"],1000)?;time_small_string(&stage["sessionTimezone"])?;
    integer(&stage["resultTabsBefore"],1000)?;integer(&stage["resultTabsAfter"],1000)?;integer(&stage["activeTabGeneration"],1000)?;stage["activeTabOwned"].as_bool().ok_or_else(invalid)?;integer(&stage["nativeExecuteCount"],10000)?;
    let values=stage["values"].as_array().ok_or_else(invalid)?;if values.len()!=6{return Err(invalid())}for value in values{if !value.is_null(){time_small_string(value)?;}}
    let types=stage["columnTypes"].as_array().ok_or_else(invalid)?;if types.len()!=6{return Err(invalid())}for kind in types{if !CROSSZONE_CATEGORIES.contains(&kind.as_str().ok_or_else(invalid)?){return Err(invalid())}}
    let projection=stage["witnessProjection"].as_array().ok_or_else(invalid)?;if projection.len()!=11{return Err(invalid())}for value in projection{if !value.is_null(){time_small_string(value)?;}}
    Ok(())
}
fn crosszone_expected_values(shifted:bool)->Value{if shifted{json!(["1","2024-02-29","2024-02-29 12:34:56.000001","2024-02-29 20:34:56.123456","-25:02:03.000002","01:02:03.000003"])}else{json!(["1","2024-02-29","2024-02-29 12:34:56.000001","2024-02-29 12:34:56.123456","-25:02:03.000002","01:02:03.000003"])}}
fn crosszone_expected_projection(shifted:bool)->Value{if shifted{json!(["+08:00","2024-02-29","2024-02-29 12:34:56.000001","2024-02-29 20:34:56.123456","-25:02:03.000002","01:02:03.000003","1","123456","2","3","1709210096.123456"])}else{json!(["+00:00","2024-02-29","2024-02-29 12:34:56.000001","2024-02-29 12:34:56.123456","-25:02:03.000002","01:02:03.000003","1","123456","2","3","1709210096.123456"])}}
fn crosszone_expected_timezone(step:usize)->&'static str{if step==1{"+08:00"}else{"+00:00"}}
fn crosszone_green_native(snapshot:&Value,step:usize)->Result<(),AppError>{
    if step>=3{return Err(invalid())}
    for(method,success)in[("executeStatement",6+3*step as u64),("commitTransaction",1),("applyEdits",0),("rollbackTransaction",0),("fetchCellValue",0),("insertRow",0),("deleteRows",0)]{if snapshot["methods"][method]["success"].as_u64().unwrap_or(0)!=success||snapshot["methods"][method]["failure"].as_u64().unwrap_or(0)!=0{return Err(invalid())}}
    if snapshot["crosszone"]["lastObservedTransactionState"]!=json!({"active":false,"pendingAffected":0}){return Err(invalid())}
    if !snapshot["crosszone"]["lastApplyResult"].is_null(){return Err(invalid())}
    Ok(())
}
const SESSION_TIMEZONE_STEPS:&[&str]=&["baseline","offset","restored"];
#[derive(Default)]
struct SessionTimezoneHandshake {published:[Option<Value>;3],confirmed:[bool;3],native:[Option<Value>;3]}
fn session_timezone_step(request:&Value,checkpoint:bool)->Result<usize,AppError>{
    if serde_json::to_vec(request).map_err(|_|invalid())?.len()>2048{return Err(invalid())}
    if checkpoint{exact_fields(request,&["schemaVersion","step","uiActive","uiPendingAffected","projectionSha256","connectionId","setFailed","autocommit"])?;}else{exact_fields(request,&["schemaVersion","step"])?;}
    if request["schemaVersion"]!=1{return Err(invalid())}let step=SESSION_TIMEZONE_STEPS.iter().position(|step|Some(*step)==request["step"].as_str()).ok_or_else(invalid)?;
    if checkpoint{let active=request["uiActive"].as_bool().ok_or_else(invalid)?;let pending=integer(&request["uiPendingAffected"],1000)?;hash_string(&request["projectionSha256"])?;positive_connection_id(&request["connectionId"])?;let failed=request["setFailed"].as_bool().ok_or_else(invalid)?;let autocommit=request["autocommit"].as_bool().ok_or_else(invalid)?;if step==0&&(active||pending!=0||failed||!autocommit){return Err(invalid())}}
    Ok(step)
}
fn session_timezone_stage(stage:&Value)->Result<(),AppError>{
    exact_fields(stage,&["connectionId","sessionTimezone","systemTimezone","autocommit","epochText","projectionSha256","setFailed","uiActive","uiPendingAffected"])?;positive_connection_id(&stage["connectionId"])?;hash_string(&stage["projectionSha256"])?;integer(&stage["uiPendingAffected"],1000)?;
    for name in ["sessionTimezone","systemTimezone","epochText"]{let observed=text(stage,name)?;if observed.encode_utf16().count()>64||observed.chars().any(char::is_control){return Err(invalid())}}
    for name in ["autocommit","setFailed","uiActive"]{stage[name].as_bool().ok_or_else(invalid)?;}Ok(())
}
const TEXT_STEPS:&[&str]=&["baseline","draft","applied","committed"];
#[derive(Default)]
struct TextHandshake {published:[Option<Value>;4],confirmed:[bool;4],native:[Option<Value>;4]}
#[derive(Default)]
struct TextObservation {last_apply:Option<Value>,last_transaction:Option<Value>}
fn text_step(request:&Value,checkpoint:bool)->Result<usize,AppError>{
    if serde_json::to_vec(request).map_err(|_|invalid())?.len()>2048{return Err(invalid())}
    if checkpoint{exact_fields(request,&["schemaVersion","step","uiActive","uiPendingAffected","dirtyRows","valuesSha256","witnessConnectionId","witnessProjectionSha256"])?;}else{exact_fields(request,&["schemaVersion","step"])?;}
    if request["schemaVersion"]!=1{return Err(invalid())}let step=TEXT_STEPS.iter().position(|step|Some(*step)==request["step"].as_str()).ok_or_else(invalid)?;
    if checkpoint{let active=request["uiActive"].as_bool().ok_or_else(invalid)?;let pending=integer(&request["uiPendingAffected"],1000)?;let dirty=integer(&request["dirtyRows"],1)?;hash_string(&request["valuesSha256"])?;
        if !request["witnessConnectionId"].is_null(){positive_connection_id(&request["witnessConnectionId"])?;}if !request["witnessProjectionSha256"].is_null(){hash_string(&request["witnessProjectionSha256"])?;}
        if step==0&&(active||pending!=0||dirty!=0||!request["witnessConnectionId"].is_null()||!request["witnessProjectionSha256"].is_null()){return Err(invalid())}
        if step==3&&(active||pending!=0||dirty!=0||request["witnessConnectionId"].is_null()||request["witnessProjectionSha256"].is_null()){return Err(invalid())}
    }Ok(step)
}
fn text_apply_scalars(value:&Value)->Option<Value>{
    let ok=value["ok"].as_bool()?;let affected=integer(&value["affected"],1000).ok()?;let transaction=value["inTransaction"].as_bool()?;let outcomes=value["outcomes"].as_array()?;if outcomes.len()>1000{return None}let mut failed=0;for outcome in outcomes{let error=outcome.get("error")?;if !error.is_null(){if !error.is_string(){return None}failed+=1;}}
    Some(json!({"ok":ok,"affected":affected,"inTransaction":transaction,"outcomeCount":outcomes.len(),"failedOutcomeCount":failed,"errorClass":if ok&&failed==0{"none"}else{"other"}}))
}
fn text_preview_pair(value:&Value,green:bool)->Result<(),AppError>{
    let pair=value.as_array().ok_or_else(invalid)?;if pair.len()!=2{return Err(invalid())}for preview in pair{exact_fields(preview,&["prefixSha256","prefixCodePoints","ellipsis"])?;hash_string(&preview["prefixSha256"])?;let length=integer(&preview["prefixCodePoints"],16000)?;let ellipsis=preview["ellipsis"].as_bool().ok_or_else(invalid)?;if green&&(!ellipsis||length==0){return Err(invalid())}}Ok(())
}
const PRECISION_STEPS:&[&str]=&["baseline","draft","applied","committed"];
#[derive(Default)]
struct PrecisionHandshake {published:[Option<Value>;4],confirmed:[bool;4],applied_native:Option<Value>}
#[derive(Default)]
struct PrecisionObservation {last_apply:Option<Value>,last_transaction:Option<Value>}
fn precision_step(request:&Value,checkpoint:bool)->Result<usize,AppError>{
    if serde_json::to_vec(request).map_err(|_|invalid())?.len()>2048{return Err(invalid())}
    if checkpoint{exact_fields(request,&["schemaVersion","step","uiActive","uiPendingAffected","dirtyRows","rowsSha256","witnessConnectionId","witnessProjectionSha256"])?;}else{exact_fields(request,&["schemaVersion","step"])?;}
    if request["schemaVersion"]!=1{return Err(invalid())}
    let step=PRECISION_STEPS.iter().position(|step|Some(*step)==request["step"].as_str()).ok_or_else(invalid)?;
    if checkpoint{
        let active=request["uiActive"].as_bool().ok_or_else(invalid)?;let pending=integer(&request["uiPendingAffected"],1000)?;let dirty=integer(&request["dirtyRows"],1)?;hash_string(&request["rowsSha256"])?;
        if !request["witnessConnectionId"].is_null(){positive_connection_id(&request["witnessConnectionId"])?;}if !request["witnessProjectionSha256"].is_null(){hash_string(&request["witnessProjectionSha256"])?;}
        if step==0&&(active||pending!=0||dirty!=0||!request["witnessConnectionId"].is_null()||!request["witnessProjectionSha256"].is_null()){return Err(invalid())}
        if step==3&&(active||pending!=0||dirty!=0||request["witnessConnectionId"].is_null()||request["witnessProjectionSha256"].is_null()){return Err(invalid())}
    }Ok(step)
}
fn precision_apply_scalars(value:&Value)->Option<Value>{
    let ok=value["ok"].as_bool()?;let affected=integer(&value["affected"],1000).ok()?;let transaction=value["inTransaction"].as_bool()?;let outcomes=value["outcomes"].as_array()?;if outcomes.len()>1000{return None}
    let mut failed=0;for outcome in outcomes{let error=outcome.get("error")?;if !error.is_null(){if !error.is_string(){return None}failed+=1;}}
    Some(json!({"ok":ok,"affected":affected,"inTransaction":transaction,"outcomeCount":outcomes.len(),"failedOutcomeCount":failed,"errorClass":if ok&&failed==0{"none"}else{"other"}}))
}
const TIMEOUT_STEPS:&[&str]=&["marker","failed","rolled-back"];
#[derive(Default)]
struct TimeoutHandshake {published:[Option<Value>;3],confirmed:[bool;3],failed_native:Option<Value>}
#[derive(Default)]
struct TimeoutObservation {last_apply:Option<Value>,last_transaction:Option<Value>}
fn timeout_step(request:&Value,checkpoint:bool)->Result<usize,AppError>{
    if serde_json::to_vec(request).map_err(|_|invalid())?.len()>2048{return Err(invalid())}
    if checkpoint{exact_fields(request,&["schemaVersion","step","uiActive","uiPendingAffected","dirtyRows","row1Value","row3Value","original1205","witnessConnectionId","witnessMarkerValue","sessionTimeoutSeconds","rollbackOnTimeout"])?;}else{exact_fields(request,&["schemaVersion","step"])?;}
    if request["schemaVersion"]!=1{return Err(invalid())}
    let step=TIMEOUT_STEPS.iter().position(|step|Some(*step)==request["step"].as_str()).ok_or_else(invalid)?;
    if checkpoint{
        let active=request["uiActive"].as_bool().ok_or_else(invalid)?;let pending=integer(&request["uiPendingAffected"],1000)?;let dirty=integer(&request["dirtyRows"],1)?;let row1=integer(&request["row1Value"],1)?;let row3=integer(&request["row3Value"],7)?;if ![0,7].contains(&row3){return Err(invalid())}
        let original=request["original1205"].as_bool().ok_or_else(invalid)?;
        if !request["witnessConnectionId"].is_null(){positive_connection_id(&request["witnessConnectionId"])?;}
        if !request["witnessMarkerValue"].is_null()&&![0,7].contains(&integer(&request["witnessMarkerValue"],7)?){return Err(invalid())}
        if !request["sessionTimeoutSeconds"].is_null(){let seconds=integer(&request["sessionTimeoutSeconds"],3600)?;if seconds==0{return Err(invalid())}}
        if !request["rollbackOnTimeout"].is_null()&&!request["rollbackOnTimeout"].is_boolean(){return Err(invalid())}
        if step==0&&(!active||pending!=1||dirty!=0||row1!=0||row3!=7||original||request["witnessConnectionId"].is_null()||request["witnessMarkerValue"]!=7||request["sessionTimeoutSeconds"]!=5||request["rollbackOnTimeout"]!=false){return Err(invalid())}
        if step==2&&(active||pending!=0||dirty!=0||row1!=0||row3!=0||!original||request["witnessConnectionId"].is_null()||request["witnessMarkerValue"]!=0||request["sessionTimeoutSeconds"]!=5||request["rollbackOnTimeout"]!=false){return Err(invalid())}
    }Ok(step)
}
fn timeout_apply_scalars(value:&Value)->Option<Value>{
    let ok=value["ok"].as_bool()?;let affected=integer(&value["affected"],1000).ok()?;let transaction=value["inTransaction"].as_bool()?;let outcomes=value["outcomes"].as_array()?;if outcomes.len()>1000{return None}
    let mut failed=0;let mut class="none";
    for outcome in outcomes{let error=outcome.get("error")?;if error.is_null(){continue}let message=error.as_str()?;failed+=1;let tokens:Vec<_>=message.split(|character:char|!character.is_ascii_alphanumeric()).collect();if tokens.contains(&"1205")&&tokens.contains(&"HY000"){class="1205"}else if class!="1205"{class="other"}}
    if !ok&&failed==0{class="other"}
    Some(json!({"ok":ok,"affected":affected,"inTransaction":transaction,"outcomeCount":outcomes.len(),"failedOutcomeCount":failed,"errorClass":class}))
}
const DUPLICATE_STEPS:&[&str]=&["baseline","failed","rolled-back"];
#[derive(Default)]
struct DuplicateHandshake {published:[Option<Value>;3],confirmed:[bool;3],failed_native:Option<Value>}
#[derive(Default)]
struct DuplicateObservation {last_apply:Option<Value>,last_transaction:Option<Value>}
fn duplicate_step(request:&Value,checkpoint:bool)->Result<usize,AppError> {
    if serde_json::to_vec(request).map_err(|_|invalid())?.len()>2048{return Err(invalid())}
    if checkpoint {exact_fields(request,&["schemaVersion","step","uiActive","uiPendingAffected","dirtyRows","row1Unique","row3Value","original1062","witnessConnectionId","witnessMarkerValue"])?;}else{exact_fields(request,&["schemaVersion","step"])?;}
    if request["schemaVersion"]!=1{return Err(invalid())}
    let step=DUPLICATE_STEPS.iter().position(|step|Some(*step)==request["step"].as_str()).ok_or_else(invalid)?;
    if checkpoint {
        let active=request["uiActive"].as_bool().ok_or_else(invalid)?;let pending=integer(&request["uiPendingAffected"],1000)?;let dirty=integer(&request["dirtyRows"],1)?;
        let unique=integer(&request["row1Unique"],2)?;let marker=integer(&request["row3Value"],7)?;if unique==0||![0,7].contains(&marker){return Err(invalid())}
        let original=request["original1062"].as_bool().ok_or_else(invalid)?;
        if !request["witnessConnectionId"].is_null(){positive_connection_id(&request["witnessConnectionId"])?;}
        if !request["witnessMarkerValue"].is_null()&&![0,7].contains(&integer(&request["witnessMarkerValue"],7)?){return Err(invalid())}
        if step==0&&(active||pending!=0||dirty!=0||unique!=1||marker!=0||original||!request["witnessConnectionId"].is_null()||!request["witnessMarkerValue"].is_null()){return Err(invalid())}
        if step==2&&(active||pending!=0||dirty!=0||unique!=1||marker!=0||!original||request["witnessConnectionId"].is_null()||request["witnessMarkerValue"]!=0){return Err(invalid())}
    }Ok(step)
}
fn positive_connection_id(value:&Value)->Result<u64,AppError>{let id=integer(value,9007199254740991)?;if id==0{return Err(invalid())}Ok(id)}
fn duplicate_apply_scalars(value:&Value)->Option<Value> {
    let ok=value["ok"].as_bool()?;let affected=integer(&value["affected"],1000).ok()?;let transaction=value["inTransaction"].as_bool()?;
    let outcomes=value["outcomes"].as_array()?;if outcomes.len()>1000{return None}
    let mut failed=0;let mut class="none";
    for outcome in outcomes {
        let error=outcome.get("error")?;if error.is_null(){continue}
        let message=error.as_str()?;failed+=1;
        let tokens:Vec<_>=message.split(|character:char|!character.is_ascii_alphanumeric()).collect();
        if tokens.contains(&"1062")&&tokens.contains(&"23000"){class="1062"}else if class!="1062"{class="other"}
    }
    if !ok&&failed==0{class="other"}
    Some(json!({"ok":ok,"affected":affected,"inTransaction":transaction,"outcomeCount":outcomes.len(),"failedOutcomeCount":failed,"errorClass":class}))
}
const DEADLOCK_STEPS:&[&str]=&["baseline","marker","observed"];
#[derive(Default)]
struct DeadlockHandshake {published:[Option<Value>;3],confirmed:[bool;3]}
struct DeadlockObservation {last_apply_failure:&'static str,last_transaction:Option<Value>}
fn deadlock_step(request:&Value,checkpoint:bool)->Result<usize,AppError> {
    if serde_json::to_vec(request).map_err(|_|invalid())?.len()>2048 {return Err(invalid())}
    if checkpoint {exact_fields(request,&["schemaVersion","step","uiActive","uiPendingAffected","dirtyRows","row1Value","row3Value","original1213","rollbackNotice"])?;}else{exact_fields(request,&["schemaVersion","step"])?;}
    if request["schemaVersion"]!=1 {return Err(invalid())}
    let step=DEADLOCK_STEPS.iter().position(|step|Some(*step)==request["step"].as_str()).ok_or_else(invalid)?;
    if checkpoint {
        let active=request["uiActive"].as_bool().ok_or_else(invalid)?;let pending=integer(&request["uiPendingAffected"],1000)?;
        let dirty=integer(&request["dirtyRows"],1)?;let row1=integer(&request["row1Value"],7)?;let row3=integer(&request["row3Value"],7)?;
        let original=request["original1213"].as_bool().ok_or_else(invalid)?;let notice=request["rollbackNotice"].as_bool().ok_or_else(invalid)?;
        if step<2 && (active!=(step==1)||pending!=if step==1{1}else{0}||dirty!=0||row1!=0||row3!=if step==1{7}else{0}||original||notice){return Err(invalid())}
    }Ok(step)
}
fn deadlock_failure_class(code:&str,message:&str)->&'static str {
    // Inspect only the real returned safe diagnostic; retain a closed class, never the text.
    let tokens:Vec<_>=message.split(|character:char|!character.is_ascii_alphanumeric()).collect();
    if code=="1213" || (tokens.contains(&"1213")&&tokens.contains(&"40001")){"1213"}
    else if code=="1305" || (tokens.contains(&"1305")&&tokens.contains(&"42000")){"1305"}else{"other"}
}
fn commit_step(request:&Value,checkpoint:bool)->Result<usize,AppError> {
    if serde_json::to_vec(request).map_err(|_|invalid())?.len()>1024 {return Err(invalid())}
    if checkpoint {exact_fields(request,&["schemaVersion","step","bodySha256","active","pendingAffected"])?;}
    else {exact_fields(request,&["schemaVersion","step"])?;}
    if request["schemaVersion"]!=1 {return Err(invalid())}
    let step=COMMIT_STEPS.iter().position(|step|Some(*step)==request["step"].as_str()).ok_or_else(invalid)?;
    if checkpoint {
        hash_string(&request["bodySha256"])?;
        if request["active"].as_bool()!=Some(step==1) || integer(&request["pendingAffected"],1)?!=if step==1 {1}else{0} {return Err(invalid())}
    }
    Ok(step)
}
fn owned_evidence(root:&Path)->Result<PathBuf,AppError> {
    if !root.is_absolute() {return Err(invalid())}
    private_metadata(root,true)?;
    let evidence=root.join("evidence");private_metadata(&evidence,true)?;
    let canonical_root=root.canonicalize().map_err(|_|invalid())?;
    let canonical=evidence.canonicalize().map_err(|_|invalid())?;
    if canonical!=canonical_root.join("evidence") {return Err(invalid())}
    #[cfg(unix)] {use std::os::unix::fs::MetadataExt;if fs::metadata(root).map_err(|_|invalid())?.uid()!=fs::metadata(&evidence).map_err(|_|invalid())?.uid(){return Err(invalid())}}
    Ok(canonical)
}
fn commit_paths(root:&Path,kind:CommitFile,step:usize)->Result<(PathBuf,PathBuf),AppError> {
    let (steps,prefix)=match kind {CommitFile::Checkpoint=>(COMMIT_STEPS,"commit-checkpoint"),CommitFile::Ack=>(COMMIT_STEPS,"commit-ack"),CommitFile::DeadlockCheckpoint=>(DEADLOCK_STEPS,"deadlock-checkpoint"),CommitFile::DeadlockAck=>(DEADLOCK_STEPS,"deadlock-ack"),CommitFile::DuplicateCheckpoint=>(DUPLICATE_STEPS,"duplicate-checkpoint"),CommitFile::DuplicateAck=>(DUPLICATE_STEPS,"duplicate-ack"),CommitFile::TimeoutCheckpoint=>(TIMEOUT_STEPS,"timeout-checkpoint"),CommitFile::TimeoutAck=>(TIMEOUT_STEPS,"timeout-ack"),CommitFile::PrecisionCheckpoint=>(PRECISION_STEPS,"precision-checkpoint"),CommitFile::PrecisionAck=>(PRECISION_STEPS,"precision-ack"),CommitFile::TextCheckpoint=>(TEXT_STEPS,"text-checkpoint"),CommitFile::TextAck=>(TEXT_STEPS,"text-ack"),CommitFile::SessionTimezoneCheckpoint=>(SESSION_TIMEZONE_STEPS,"session-timezone-checkpoint"),CommitFile::SessionTimezoneAck=>(SESSION_TIMEZONE_STEPS,"session-timezone-ack"),CommitFile::TimeCheckpoint=>(TIME_STEPS,"time-checkpoint"),CommitFile::TimeAck=>(TIME_STEPS,"time-ack"),CommitFile::CrosszoneCheckpoint=>(CROSSZONE_STEPS,"crosszone-checkpoint"),CommitFile::CrosszoneAck=>(CROSSZONE_STEPS,"crosszone-ack"),CommitFile::BinaryCheckpoint=>(BINARY_STEPS,"binary-checkpoint"),CommitFile::BinaryAck=>(BINARY_STEPS,"binary-ack")};
    let step=steps.get(step).ok_or_else(invalid)?;
    let evidence=owned_evidence(root)?;
    let target=evidence.join(format!("{prefix}-{}-{step}.json",std::process::id()));
    let pending=evidence.join(format!("{prefix}-{}-{step}.json.pending",std::process::id()));
    Ok((pending,target))
}
fn ensure_absent(path:&Path)->Result<(),AppError> {
    match fs::symlink_metadata(path) {Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Ok(()),_=>Err(invalid())}
}
fn check_owned_open_file(path:&Path,file:&File,evidence:&Path,max:u64)->Result<(),AppError> {
    private_metadata(path,false)?;
    if !path.is_absolute() || path.parent()!=Some(evidence) || path.canonicalize().map_err(|_|invalid())?!=path {return Err(invalid())}
    let named=fs::symlink_metadata(path).map_err(|_|invalid())?;let opened=file.metadata().map_err(|_|invalid())?;
    if !opened.is_file() || opened.len()>max {return Err(invalid())}
    #[cfg(unix)] {
        use std::os::unix::fs::{MetadataExt,PermissionsExt};
        if named.dev()!=opened.dev() || named.ino()!=opened.ino() || opened.nlink()!=1 || opened.permissions().mode()&0o777!=0o600 || opened.uid()!=fs::metadata(evidence).map_err(|_|invalid())?.uid() {return Err(invalid())}
    }
    Ok(())
}
fn publish_commit_json(root:&Path,kind:CommitFile,step:usize,value:&Value)->Result<(),AppError> {
    let (pending,target)=commit_paths(root,kind,step)?;
    ensure_absent(&pending)?;ensure_absent(&target)?;
    let bytes=serde_json::to_vec(value).map_err(|_|invalid())?;if bytes.len()>16384{return Err(invalid())}
    let mut options=OpenOptions::new();options.write(true).create_new(true);
    #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
    let mut file=options.open(&pending).map_err(|_|invalid())?;
    file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|_|invalid())?;
    // Verify both resolved absolute paths immediately before the sole permitted owned rename.
    let expected=commit_paths(root,kind,step)?;
    if expected!=(pending.clone(),target.clone()) || !pending.is_absolute() || !target.is_absolute() {return Err(invalid())}
    let evidence=owned_evidence(root)?;check_owned_open_file(&pending,&file,&evidence,16384)?;
    ensure_absent(&target)?;
    fs::rename(&pending,&target).map_err(|_|invalid())
}
fn read_commit_ack(root:&Path,step:usize)->Result<Option<Value>,AppError> {
    let (_,path)=commit_paths(root,CommitFile::Ack,step)?;
    match fs::symlink_metadata(&path) {Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(invalid()),Ok(_)=>{}}
    private_metadata(&path,false)?;
    let file=File::open(&path).map_err(|_|invalid())?;let evidence=owned_evidence(root)?;
    check_owned_open_file(&path,&file,&evidence,1024)?;
    let mut bytes=Vec::new();file.take(1025).read_to_end(&mut bytes).map_err(|_|invalid())?;if bytes.len()>1024{return Err(invalid())}
    serde_json::from_slice(&bytes).map(Some).map_err(|_|invalid())
}

fn read_deadlock_ack(root:&Path,step:usize)->Result<Option<Value>,AppError> {
    let (_,path)=commit_paths(root,CommitFile::DeadlockAck,step)?;
    match fs::symlink_metadata(&path) {Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(invalid()),Ok(_)=>{}}
    private_metadata(&path,false)?;let file=File::open(&path).map_err(|_|invalid())?;let evidence=owned_evidence(root)?;
    check_owned_open_file(&path,&file,&evidence,2048)?;
    let mut bytes=Vec::new();file.take(2049).read_to_end(&mut bytes).map_err(|_|invalid())?;if bytes.len()>2048{return Err(invalid())}
    serde_json::from_slice(&bytes).map(Some).map_err(|_|invalid())
}

fn read_duplicate_ack(root:&Path,step:usize)->Result<Option<Value>,AppError> {
    let (_,path)=commit_paths(root,CommitFile::DuplicateAck,step)?;
    match fs::symlink_metadata(&path){Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(invalid()),Ok(_)=>{}}
    private_metadata(&path,false)?;let file=File::open(&path).map_err(|_|invalid())?;let evidence=owned_evidence(root)?;check_owned_open_file(&path,&file,&evidence,2048)?;
    let mut bytes=Vec::new();file.take(2049).read_to_end(&mut bytes).map_err(|_|invalid())?;if bytes.len()>2048{return Err(invalid())}serde_json::from_slice(&bytes).map(Some).map_err(|_|invalid())
}

fn read_timeout_ack(root:&Path,step:usize)->Result<Option<Value>,AppError>{
    let(_,path)=commit_paths(root,CommitFile::TimeoutAck,step)?;
    match fs::symlink_metadata(&path){Err(error)if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(invalid()),Ok(_)=>{}}
    private_metadata(&path,false)?;let file=File::open(&path).map_err(|_|invalid())?;let evidence=owned_evidence(root)?;check_owned_open_file(&path,&file,&evidence,2048)?;let mut bytes=Vec::new();file.take(2049).read_to_end(&mut bytes).map_err(|_|invalid())?;if bytes.len()>2048{return Err(invalid())}serde_json::from_slice(&bytes).map(Some).map_err(|_|invalid())
}

fn read_precision_ack(root:&Path,step:usize)->Result<Option<Value>,AppError>{
    let(_,path)=commit_paths(root,CommitFile::PrecisionAck,step)?;
    match fs::symlink_metadata(&path){Err(error)if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(invalid()),Ok(_)=>{}}
    private_metadata(&path,false)?;let file=File::open(&path).map_err(|_|invalid())?;let evidence=owned_evidence(root)?;check_owned_open_file(&path,&file,&evidence,2048)?;let mut bytes=Vec::new();file.take(2049).read_to_end(&mut bytes).map_err(|_|invalid())?;if bytes.len()>2048{return Err(invalid())}serde_json::from_slice(&bytes).map(Some).map_err(|_|invalid())
}

fn read_text_ack(root:&Path,step:usize)->Result<Option<Value>,AppError>{
    let(_,path)=commit_paths(root,CommitFile::TextAck,step)?;match fs::symlink_metadata(&path){Err(error)if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(invalid()),Ok(_)=>{}}
    private_metadata(&path,false)?;let file=File::open(&path).map_err(|_|invalid())?;let evidence=owned_evidence(root)?;check_owned_open_file(&path,&file,&evidence,2048)?;let mut bytes=Vec::new();file.take(2049).read_to_end(&mut bytes).map_err(|_|invalid())?;if bytes.len()>2048{return Err(invalid())}serde_json::from_slice(&bytes).map(Some).map_err(|_|invalid())
}

fn read_session_timezone_ack(root:&Path,step:usize)->Result<Option<Value>,AppError>{
    let(_,path)=commit_paths(root,CommitFile::SessionTimezoneAck,step)?;match fs::symlink_metadata(&path){Err(error)if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(invalid()),Ok(_)=>{}}
    private_metadata(&path,false)?;let file=File::open(&path).map_err(|_|invalid())?;let evidence=owned_evidence(root)?;check_owned_open_file(&path,&file,&evidence,2048)?;let mut bytes=Vec::new();file.take(2049).read_to_end(&mut bytes).map_err(|_|invalid())?;if bytes.len()>2048{return Err(invalid())}serde_json::from_slice(&bytes).map(Some).map_err(|_|invalid())
}

fn read_time_ack(root:&Path,step:usize)->Result<Option<Value>,AppError>{
    let(_,path)=commit_paths(root,CommitFile::TimeAck,step)?;match fs::symlink_metadata(&path){Err(error)if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(invalid()),Ok(_)=>{}}
    private_metadata(&path,false)?;let file=File::open(&path).map_err(|_|invalid())?;let evidence=owned_evidence(root)?;check_owned_open_file(&path,&file,&evidence,2048)?;let mut bytes=Vec::new();file.take(2049).read_to_end(&mut bytes).map_err(|_|invalid())?;if bytes.len()>2048{return Err(invalid())}serde_json::from_slice(&bytes).map(Some).map_err(|_|invalid())
}

fn read_crosszone_ack(root:&Path,step:usize)->Result<Option<Value>,AppError>{
    let(_,path)=commit_paths(root,CommitFile::CrosszoneAck,step)?;match fs::symlink_metadata(&path){Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(invalid()),Ok(_)=>{}}
    private_metadata(&path,false)?;let file=File::open(&path).map_err(|_|invalid())?;let evidence=owned_evidence(root)?;check_owned_open_file(&path,&file,&evidence,2048)?;let mut bytes=Vec::new();file.take(2049).read_to_end(&mut bytes).map_err(|_|invalid())?;if bytes.len()>2048{return Err(invalid())}serde_json::from_slice(&bytes).map(Some).map_err(|_|invalid())
}
// Grid bit/blob phase. The host only knows bounded shapes and stage consistency; it never fills in an expected value.
const BINARY_STEPS:&[&str]=&["baseline","draft","applied","committed"];
const BINARY_CATEGORIES:&[&str]=&["integer","real","text","blob","null","boolean","date","unknown"];
// The independent witness keeps exactly seven string aliases; no connection id and no type ever joins them.
#[allow(dead_code)]
const BINARY_WITNESS_ALIASES:&[&str]=&["b1_hex","b1_dec","b64_hex","b64_dec","bin_hex","bin_len","bin_null"];
const BINARY_CHECKS:&[&str]=&["storage_marker","persisted_connection","credential_reconnect","fixture_created","table_open","column_categories_read","baseline_rows_read","bit_readonly_observed","blob_editable_entry","local_edits","apply_succeeded","committed_reload_verified"];
const BINARY_FAILURES:&[&str]=&["NONE","ISOLATION","CONNECTION","FIXTURE_OPEN","TABLE_OPEN","NATIVE_BRIDGE","CHECKPOINT","TIMEOUT","BINARY_READ_FAILED","READ_ONLY_BINARY","BIT_EDIT_ENTRY","EDITOR_VALUE_LOSS","APPLY_REJECTED","COMMIT_FAILED","BLOB_VALUE_MISMATCH","BIT_VALUE_MISMATCH"];
#[derive(Default)]
struct BinaryHandshake {published:[Option<Value>;4],confirmed:[bool;4],native:[Option<Value>;4]}
#[derive(Default)]
struct BinaryObservation {last_apply:Option<Value>,last_transaction:Option<Value>}
fn binary_categories(value:&Value)->Result<(),AppError>{
    let categories=value.as_array().ok_or_else(invalid)?;
    if categories.len()!=4{return Err(invalid())}
    for kind in categories{if !BINARY_CATEGORIES.contains(&kind.as_str().ok_or_else(invalid)?){return Err(invalid())}}
    Ok(())
}
// Uppercase hex without a prefix, an even number of digits and a hard length bound.
fn binary_hex(value:&Value,max:usize)->Result<(),AppError>{
    if value.is_null(){return Ok(())}
    let raw=value.as_str().ok_or_else(invalid)?;
    if raw.len()>max||raw.len()%2!=0{return Err(invalid())}
    if !raw.bytes().all(|byte|byte.is_ascii_digit()||(b'A'..=b'F').contains(&byte)){return Err(invalid())}
    Ok(())
}
// An unsigned decimal string; a JSON number never represents a BIT value.
fn binary_decimal(value:&Value)->Result<(),AppError>{
    if value.is_null(){return Ok(())}
    let raw=value.as_str().ok_or_else(invalid)?;
    if raw.is_empty()||raw.len()>40||!raw.bytes().all(|byte|byte.is_ascii_digit()){return Err(invalid())}
    Ok(())
}
fn binary_row(row:&Value)->Result<(),AppError>{
    exact_fields(row,&["id","b1Hex","b1Decimal","b64Hex","b64Decimal","binHex","binByteLength","binIsNull"])?;
    if integer(&row["id"],4)?==0{return Err(invalid())}
    binary_hex(&row["b1Hex"],512)?;binary_hex(&row["b64Hex"],512)?;binary_hex(&row["binHex"],512)?;
    binary_decimal(&row["b1Decimal"])?;binary_decimal(&row["b64Decimal"])?;
    if !row["binByteLength"].is_null(){integer(&row["binByteLength"],256)?;}
    row["binIsNull"].as_bool().ok_or_else(invalid)?;
    Ok(())
}
// The green path alone demands a self-consistent blob: the null flag, the hex and the byte length agree.
fn binary_row_self_consistent(row:&Value)->Result<(),AppError>{
    let is_null=row["binIsNull"].as_bool().ok_or_else(invalid)?;
    if is_null{if !row["binHex"].is_null()||!row["binByteLength"].is_null(){return Err(invalid())}return Ok(())}
    let hex=row["binHex"].as_str().ok_or_else(invalid)?;
    let length=row["binByteLength"].as_u64().ok_or_else(invalid)?;
    if length!=hex.len() as u64 /2{return Err(invalid())}
    Ok(())
}
fn binary_gap(gap:&Value)->Result<(),AppError>{
    exact_fields(gap,&["viewerOpened","viewerTitle","viewerHex","editorDialogPresent","inlineErrorText"])?;
    gap["viewerOpened"].as_bool().ok_or_else(invalid)?;
    gap["editorDialogPresent"].as_bool().ok_or_else(invalid)?;
    for(name,max)in[("viewerTitle",64),("viewerHex",128),("inlineErrorText",64)]{
        if !gap[name].is_null(){let raw=gap[name].as_str().ok_or_else(invalid)?;if raw.encode_utf16().count()>max||raw.chars().any(char::is_control){return Err(invalid())}}
    }
    Ok(())
}
fn binary_editor(editor:&Value)->Result<(),AppError>{
    exact_fields(editor,&["raw","isNull","valueDisabled","nullDisabled"])?;
    if !editor["raw"].is_null(){let raw=editor["raw"].as_str().ok_or_else(invalid)?;if raw.encode_utf16().count()>64||raw.chars().any(char::is_control){return Err(invalid())}}
    editor["isNull"].as_bool().ok_or_else(invalid)?;
    editor["valueDisabled"].as_bool().ok_or_else(invalid)?;
    editor["nullDisabled"].as_bool().ok_or_else(invalid)?;
    Ok(())
}
// A stage that never reached the independent read keeps its witness empty; only the green path demands it.
fn binary_stage(stage:&Value)->Result<(),AppError>{
    exact_fields(stage,&["rows","rowsSha256","targetRowId","targetBinHex","targetBinIsNull","columnCategories","blobEditableEntry","uiActive","uiPendingAffected","dirtyRows","witnessConnectionId","witnessProjectionSha256"])?;
    if integer(&stage["targetRowId"],4)?!=1{return Err(invalid())}
    binary_hex(&stage["targetBinHex"],512)?;
    stage["targetBinIsNull"].as_bool().ok_or_else(invalid)?;
    binary_categories(&stage["columnCategories"])?;
    stage["blobEditableEntry"].as_bool().ok_or_else(invalid)?;
    stage["uiActive"].as_bool().ok_or_else(invalid)?;
    integer(&stage["uiPendingAffected"],1000)?;
    integer(&stage["dirtyRows"],1000)?;
    if !stage["witnessConnectionId"].is_null(){positive_connection_id(&stage["witnessConnectionId"])?;}
    if !stage["witnessProjectionSha256"].is_null(){hash_string(&stage["witnessProjectionSha256"])?;}
    if !stage["rows"].is_null(){let rows=stage["rows"].as_array().ok_or_else(invalid)?;if rows.len()!=4{return Err(invalid())}for row in rows{binary_row(row)?;}}
    if !stage["rowsSha256"].is_null(){hash_string(&stage["rowsSha256"])?;}
    Ok(())
}
// The checkpoint request carries shape and ranges only; no expected value is ever compared here.
fn binary_step(request:&Value,checkpoint:bool)->Result<usize,AppError>{
    if serde_json::to_vec(request).map_err(|_|invalid())?.len()>2048{return Err(invalid())}
    if checkpoint{exact_fields(request,&["schemaVersion","step","uiActive","uiPendingAffected","dirtyRows","rowsSha256","witnessConnectionId","witnessProjectionSha256","columnCategories","blobEditableEntry"])?;}
    else{exact_fields(request,&["schemaVersion","step"])?;}
    if request["schemaVersion"]!=1{return Err(invalid())}
    let step=BINARY_STEPS.iter().position(|step|Some(*step)==request["step"].as_str()).ok_or_else(invalid)?;
    if checkpoint{
        request["uiActive"].as_bool().ok_or_else(invalid)?;
        integer(&request["uiPendingAffected"],1000)?;
        integer(&request["dirtyRows"],1000)?;
        hash_string(&request["rowsSha256"])?;
        positive_connection_id(&request["witnessConnectionId"])?;
        hash_string(&request["witnessProjectionSha256"])?;
        binary_categories(&request["columnCategories"])?;
        request["blobEditableEntry"].as_bool().ok_or_else(invalid)?;
    }
    Ok(step)
}
// The planned native counts of the phase: two seed statements plus one witness read per completed stage.
fn binary_green_native(snapshot:&Value,step:usize)->Result<(),AppError>{
    if step>=4{return Err(invalid())}
    let completed=(step+1)as u64;
    for(method,success)in[("executeStatement",2+completed),("commitTransaction",if completed==4{2}else{1}),("applyEdits",if completed>=3{1}else{0}),("rollbackTransaction",0),("fetchCellValue",0),("insertRow",0),("deleteRows",0)]{
        if snapshot["methods"][method]["success"].as_u64().unwrap_or(0)!=success||snapshot["methods"][method]["failure"].as_u64().unwrap_or(0)!=0{return Err(invalid())}
    }
    if snapshot["binary"]["lastObservedTransactionState"]!=json!({"active":step==2,"pendingAffected":if step==2{1}else{0}}){return Err(invalid())}
    if step<2{if !snapshot["binary"]["lastApplyResult"].is_null(){return Err(invalid())}}
    else if snapshot["binary"]["lastApplyResult"]!=json!({"ok":true,"affected":1,"inTransaction":true,"outcomeCount":1,"failedOutcomeCount":0,"errorClass":"none"}){return Err(invalid())}
    Ok(())
}
fn read_binary_ack(root:&Path,step:usize)->Result<Option<Value>,AppError>{
    let(_,path)=commit_paths(root,CommitFile::BinaryAck,step)?;
    match fs::symlink_metadata(&path){Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(invalid()),Ok(_)=>{}}
    private_metadata(&path,false)?;let file=File::open(&path).map_err(|_|invalid())?;let evidence=owned_evidence(root)?;check_owned_open_file(&path,&file,&evidence,2048)?;
    let mut bytes=Vec::new();file.take(2049).read_to_end(&mut bytes).map_err(|_|invalid())?;if bytes.len()>2048{return Err(invalid())}
    serde_json::from_slice(&bytes).map(Some).map_err(|_|invalid())
}

const FRONTEND_STAGES:&[&str]=&["main_enter","preflight_passed","app_import_enter","app_import_passed","app_mount_enter","app_mounted","listener_enter","listener_passed","boot_enter","boot_passed","dom_enter","main_failed","mounted_failed"];
fn semantic_phase(profile:&str)->&str {if profile=="restart-attempt" {"restart"}else{profile}}
fn ui_report_filename(profile:&str)->Result<String,AppError> {
    match profile {"initial"=>Ok("ui-initial.json".into()),"restart"=>Ok("ui-restart.json".into()),"restart-attempt"=>Ok(format!("ui-restart-{}.json",std::process::id())),"explain"=>Ok(format!("ui-explain-{}.json",std::process::id())),"commit"=>Ok(format!("ui-commit-{}.json",std::process::id())),"grid-deadlock"=>Ok(format!("ui-grid-deadlock-{}.json",std::process::id())),"grid-duplicate"=>Ok(format!("ui-grid-duplicate-{}.json",std::process::id())),"grid-timeout"=>Ok(format!("ui-grid-timeout-{}.json",std::process::id())),"grid-precision"=>Ok(format!("ui-grid-precision-{}.json",std::process::id())),"grid-text"=>Ok(format!("ui-grid-text-{}.json",std::process::id())),"session-timezone"=>Ok(format!("ui-session-timezone-{}.json",std::process::id())),"grid-time"=>Ok(format!("ui-grid-time-{}.json",std::process::id())),"grid-time-crosszone"=>Ok(format!("ui-grid-time-crosszone-{}.json",std::process::id())),"grid-bit-blob"=>Ok(format!("ui-grid-bit-blob-{}.json",std::process::id())),_=>Err(invalid())}
}
fn frontend_trace_stage(request:&Value)->Result<&str,AppError> {
    if serde_json::to_vec(request).map_err(|_|invalid())?.len()>1024 {return Err(invalid())}
    exact_fields(request,&["schemaVersion","stage"])?;
    let stage=text(request,"stage")?;
    if request["schemaVersion"]!=1 || !FRONTEND_STAGES.contains(&stage) {return Err(invalid())}Ok(stage)
}
fn native_method_group(method:&str)->&'static str {
    match method {"listDialects"=>"listDialects","listConnections"=>"listConnections","migrationStatus"=>"migrationStatus",_=>"other"}
}
const KEYRING_SET_FAILURE_CLASSES:&[&str]=&["serialize_failed","key_rejected","entry_init_no_storage_access","entry_init_platform_failure","entry_init_other","password_write_no_storage_access","password_write_platform_failure","password_write_other"];
// Typed OSStatus stage; only a canonical i32 literal may be its method.
const KEYRING_OSSTATUS_STAGE:&str="keyring_platform_osstatus";
fn canonical_os_status_method(method:&str)->bool { match method.parse::<i32>() {Ok(value)=>value.to_string()==method,Err(_)=>false} }
// Typed platform status observation: only the numeric OSStatus code of a known platform error type is ever read.
#[cfg(target_os = "macos")]
fn platform_os_status(error:&keyring::Error)->Option<i32> {
    match error {
        keyring::Error::PlatformFailure(inner)|keyring::Error::NoStorageAccess(inner)=>inner.downcast_ref::<security_framework::base::Error>().map(|value|value.code()),
        _=>None,
    }
}
#[cfg(not(target_os = "macos"))]
fn platform_os_status(_error:&keyring::Error)->Option<i32> {None}
struct StartupTrace {file:File,seq:u64,bytes:usize}
impl StartupTrace {
    fn create(evidence:&Path)->Result<Self,AppError> {Self::create_named(evidence,false)}
    // The initial host phase shares the evidence directory with later same-pid phases; a distinct file keeps every create exclusive.
    fn create_initial(evidence:&Path)->Result<Self,AppError> {Self::create_named(evidence,true)}
    fn create_named(evidence:&Path,initial:bool)->Result<Self,AppError> {
        private_metadata(evidence,true)?;
        let mut options=OpenOptions::new();options.append(true).create_new(true);
        #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
        let name=if initial {format!("startup-trace-initial-{}.jsonl",std::process::id())}else{format!("startup-trace-{}.jsonl",std::process::id())};
        let file=options.open(evidence.join(name)).map_err(|_|invalid())?;
        Ok(Self{file,seq:0,bytes:0})
    }
    fn append(&mut self,stage:&str,method:&str)->Result<(),AppError> {
        let native=["native_enter","native_returned","native_failed"].contains(&stage);
        let keyring=["keyring_get_enter","keyring_get_returned","keyring_get_failed"].contains(&stage);
        let keyring_set_failed=stage=="keyring_set_failed";
        let keyring_set=["keyring_set_enter","keyring_set_returned"].contains(&stage);
        let osstatus=stage==KEYRING_OSSTATUS_STAGE;
        if (!native && !keyring && !keyring_set && !keyring_set_failed && !osstatus && !FRONTEND_STAGES.contains(&stage))
            || (!native && !keyring_set_failed && !osstatus && method!="none") || (native && !["listDialects","listConnections","migrationStatus","other"].contains(&method))
            || (keyring_set_failed && !KEYRING_SET_FAILURE_CLASSES.contains(&method))
            || (osstatus && !canonical_os_status_method(method))
            || self.seq>=128 {return Err(invalid())}
        let mut line=serde_json::to_vec(&json!({"schemaVersion":1,"seq":self.seq+1,"stage":stage,"method":method})).map_err(|_|invalid())?;
        line.push(b'\n');
        if self.bytes+line.len()>32768 {return Err(invalid())}
        self.file.write_all(&line).and_then(|_|self.file.sync_data()).map_err(|_|invalid())?;
        self.seq+=1;self.bytes+=line.len();Ok(())
    }
}

pub struct AcceptanceRun {
    pub root: PathBuf,
    pub store_id: [u8; 16],
    pub phase: String,
    run_id: String,
    manifest_path: PathBuf,
    context: Value,
    app_secret: PathBuf,
    fixture_root: PathBuf,
    observations: Mutex<BTreeMap<String, Value>>,
    startup_trace: Arc<Mutex<Option<StartupTrace>>>,
    commit_handshake: Mutex<CommitHandshake>,
    deadlock_handshake: Mutex<DeadlockHandshake>,
    deadlock_observation: Mutex<DeadlockObservation>,
    duplicate_handshake: Mutex<DuplicateHandshake>,
    duplicate_observation: Mutex<DuplicateObservation>,
    timeout_handshake: Mutex<TimeoutHandshake>,
    timeout_observation: Mutex<TimeoutObservation>,
    precision_handshake: Mutex<PrecisionHandshake>,
    precision_observation: Mutex<PrecisionObservation>,
    text_handshake: Mutex<TextHandshake>,
    text_observation: Mutex<TextObservation>,
    session_timezone_handshake: Mutex<SessionTimezoneHandshake>,
    session_timezone_transaction: Mutex<Option<Value>>,
    time_handshake: Mutex<TimeHandshake>,
    time_observation: Mutex<TimeObservation>,
    crosszone_handshake: Mutex<CrosszoneHandshake>,
    crosszone_transaction: Mutex<Option<Value>>,
    binary_handshake: Mutex<BinaryHandshake>,
    binary_observation: Mutex<BinaryObservation>,
}
impl AcceptanceRun {
    /// Required for every mysql-acceptance binary, even when no mode env was supplied.
    pub fn from_environment() -> Result<Self, AppError> {
        if std::env::var_os("DBSTUDIO_NATIVE_SMOKE_ROOT").is_some() { return Err(invalid()) }
        // Reject duplicate endpoint/inline-secret configuration; there is one manifest source.
        for name in ["DBSTUDIO_MYSQL_HOST", "DBSTUDIO_MYSQL_PORT", "DBSTUDIO_MYSQL_DATABASE", "DBSTUDIO_MYSQL_USER", "DBSTUDIO_MYSQL_PASSWORD", "DBSTUDIO_MYSQL_OBSERVER_PASSWORD", "DBSTUDIO_MYSQL_CA_FILE"] {
            if std::env::var_os(name).is_some() { return Err(invalid()) }
        }
        let read = |name| std::env::var(name).map_err(|_| invalid());
        let root = PathBuf::from(read(ENV_NAMES[0])?);
        let run_id = read(ENV_NAMES[1])?;
        let phase = read(ENV_NAMES[2])?;
        let manifest = PathBuf::from(read(ENV_NAMES[3])?);
        Self::prepare(root, run_id, phase, manifest, &std::env::temp_dir(), Path::new(env!("CARGO_MANIFEST_DIR")).parent().ok_or_else(invalid)?)
    }
    fn prepare(root: PathBuf, run_id: String, phase: String, manifest_path: PathBuf, temp: &Path, repository: &Path) -> Result<Self, AppError> {
        let store_id = store_id(&run_id)?;
        if !["initial", "restart", "restart-probe", "restart-attempt", "explain", "commit", "grid-deadlock", "grid-duplicate", "grid-timeout", "grid-precision", "grid-text", "session-timezone", "grid-time", "grid-time-crosszone", "grid-bit-blob", "soak"].contains(&phase.as_str()) { return Err(invalid()) }
        let temp = temp.canonicalize().map_err(|_| invalid())?;
        if !root.is_absolute() || root.file_name().and_then(|n|n.to_str()) != Some(&format!("dbstudio-mysql-acceptance-{run_id}")) || root.parent().ok_or_else(invalid)?.canonicalize().map_err(|_| invalid())? != temp { return Err(invalid()) }
        // Canonicalize only explicit test-owned paths, never user application/config locations.
        let backups = repository.join("backups");
        if fs::symlink_metadata(&backups).map_err(|_| invalid())?.file_type().is_symlink() { return Err(invalid()) }
        let fixture = backups.join(format!("mysql-parity-fixture-{run_id}"));
        private_metadata(&fixture,true)?;
        let expected_manifest = fixture.join("manifest.ready.json");
        if !manifest_path.is_absolute() || manifest_path != expected_manifest { return Err(invalid()) }
        let fixture_manifest = read_private_json(&manifest_path)?;
        if fixture_manifest["ready"] != true || fixture_manifest["schemaVersion"] != 1 || text(&fixture_manifest,"runId")? != run_id || Path::new(text(&fixture_manifest,"hostRoot")?) != root || Path::new(text(&fixture_manifest,"fixtureRoot")?) != fixture { return Err(invalid()) }
        if text(&fixture_manifest,"host")? != "127.0.0.1" || !fixture_manifest["port"].as_u64().is_some_and(|port|(1..=65535).contains(&port)) || !identifier(text(&fixture_manifest,"database")?) { return Err(invalid()) }
        let app = fixture_manifest.get("app").ok_or_else(invalid)?;
        if !identifier(text(app,"user")?) { return Err(invalid()) }
        let secret_file = PathBuf::from(text(app,"secretFilePath")?);
        if secret_file != fixture.join("app.secret") { return Err(invalid()) }
        // Metadata only: passwords and observer credentials never enter this host context.
        private_metadata(&secret_file,false)?;
        for source in [&fixture_manifest, app] {
            for key in ["password", "dbPassword", "secret", "secretValue"] { if source.get(key).is_some() { return Err(invalid()) } }
        }
        let public_manifest = json!({"schemaVersion":1,"runId":run_id,"storeId":store_id,"keyringNamespace":format!("io.dbstudio.acceptance.mysql.{run_id}"),"fixtureManifest":manifest_path});
        if phase == "initial" {
            create_private_dir(&root)?;
            create_private_json(&root.join(HOST_MANIFEST),&public_manifest)?;
            create_private_dir(&root.join("data"))?;
            create_private_dir(&root.join("evidence"))?;
        } else {
            private_metadata(&root,true)?;
            if read_private_json(&root.join(HOST_MANIFEST))? != public_manifest { return Err(invalid()) }
            private_metadata(&root.join("data"),true)?;
            private_metadata(&root.join("evidence"),true)?;
        }
        let context = json!({"runId":run_id,"phase":semantic_phase(&phase),"isolated":true,"host":"127.0.0.1","port":fixture_manifest["port"],"database":fixture_manifest["database"],"user":app["user"],"storeConfigured":true,"legacyDisabled":true,"sslmode":"require","tables":{"paging":"items_805","precision":"precision_values","composite":"composite_rows","import":"import_empty"}});
        let startup_trace=if ["initial","restart-attempt","explain","commit","grid-deadlock","grid-duplicate","grid-timeout","grid-precision","grid-text","session-timezone","grid-time","grid-time-crosszone","grid-bit-blob"].contains(&phase.as_str()) {Some(if phase=="initial" {StartupTrace::create_initial(&root.join("evidence"))?}else{StartupTrace::create(&root.join("evidence"))?})}else{None};
        Ok(Self{root,store_id,phase,run_id,manifest_path,context,app_secret:secret_file,fixture_root:fixture,observations:Mutex::new(BTreeMap::new()),startup_trace:Arc::new(Mutex::new(startup_trace)),commit_handshake:Mutex::new(CommitHandshake::default()),deadlock_handshake:Mutex::new(DeadlockHandshake::default()),deadlock_observation:Mutex::new(DeadlockObservation{last_apply_failure:"none",last_transaction:None}),duplicate_handshake:Mutex::new(DuplicateHandshake::default()),duplicate_observation:Mutex::new(DuplicateObservation::default()),timeout_handshake:Mutex::new(TimeoutHandshake::default()),timeout_observation:Mutex::new(TimeoutObservation::default()),precision_handshake:Mutex::new(PrecisionHandshake::default()),precision_observation:Mutex::new(PrecisionObservation::default()),text_handshake:Mutex::new(TextHandshake::default()),text_observation:Mutex::new(TextObservation::default()),session_timezone_handshake:Mutex::new(SessionTimezoneHandshake::default()),session_timezone_transaction:Mutex::new(None),time_handshake:Mutex::new(TimeHandshake::default()),time_observation:Mutex::new(TimeObservation::default()),crosszone_handshake:Mutex::new(CrosszoneHandshake::default()),crosszone_transaction:Mutex::new(None),binary_handshake:Mutex::new(BinaryHandshake::default()),binary_observation:Mutex::new(BinaryObservation::default())})
    }
    pub fn password_script(&self) -> Result<String,AppError> {
        let password=read_app_password(&self.phase,&self.fixture_root,&self.app_secret)?;
        password_dom_script(&self.context,&password)
    }
    pub fn retain_ui_report(&self,report:&Value,secrets:&AcceptanceSecrets)->Result<bool,AppError> {
        let reported_success=validate_ui_report(report,&self.run_id,semantic_phase(&self.phase))?;
        if self.phase=="commit" && reported_success {
            let state=self.commit_handshake.lock().map_err(|_|invalid())?;
            if !state.confirmed.iter().all(|confirmed|*confirmed) {return Err(invalid())}
            for (index,field) in ["baselineSha256","pendingSha256","committedSha256"].iter().enumerate() {
                if state.published[index].as_ref().ok_or_else(invalid)?["bodySha256"]!=report["row"][*field] {return Err(invalid())}
            }
        }
        if self.phase=="grid-deadlock" && reported_success {
            let state=self.deadlock_handshake.lock().map_err(|_|invalid())?;
            if !state.confirmed.iter().all(|confirmed|*confirmed){return Err(invalid())}
            let observed=self.deadlock_observation.lock().map_err(|_|invalid())?;
            if observed.last_apply_failure!="1213"||observed.last_transaction.as_ref()!=Some(&json!({"active":false,"pendingAffected":0})){return Err(invalid())}
            let payload=state.published[2].as_ref().ok_or_else(invalid)?;
            if payload["uiActive"]!=report["proof"]["uiActiveAfterError"]||payload["uiPendingAffected"]!=report["proof"]["uiPendingAffectedAfterError"]||payload["dirtyRows"]!=report["proof"]["dirtyRowsAfterError"]||payload["original1213"]!=true||payload["rollbackNotice"]!=true{return Err(invalid())}
        }
        if self.phase=="grid-duplicate"&&reported_success{
            let state=self.duplicate_handshake.lock().map_err(|_|invalid())?;
            if !state.confirmed.iter().all(|confirmed|*confirmed){return Err(invalid())}
            let failed=state.failed_native.as_ref().ok_or_else(invalid)?;
            if failed["duplicate"]["lastApplyResult"]!=json!({"ok":false,"affected":0,"inTransaction":true,"outcomeCount":1,"failedOutcomeCount":1,"errorClass":"1062"})||failed["duplicate"]["lastObservedTransactionState"]!=json!({"active":true,"pendingAffected":1}){return Err(invalid())}
            for (method,success) in [("applyEdits",2),("executeStatement",3),("commitTransaction",1)]{if failed["methods"][method]["success"]!=success||failed["methods"][method]["failure"]!=0{return Err(invalid())}}
            for counter in ["success","failure"]{if failed["methods"]["rollbackTransaction"][counter].as_u64().unwrap_or(0)!=0{return Err(invalid())}}
            let current=self.snapshot(secrets)?;
            if current["duplicate"]["lastObservedTransactionState"]!=json!({"active":false,"pendingAffected":0})||current["methods"]["rollbackTransaction"]["success"]!=1||current["methods"]["rollbackTransaction"]["failure"]!=0{return Err(invalid())}
            let failed_ui=state.published[1].as_ref().ok_or_else(invalid)?;let rolled=state.published[2].as_ref().ok_or_else(invalid)?;let proof=&report["proof"];
            if failed_ui["uiActive"]!=proof["uiActiveAfterError"]||failed_ui["uiPendingAffected"]!=proof["uiPendingAffectedAfterError"]||failed_ui["dirtyRows"]!=proof["dirtyRowsAfterError"]||failed_ui["original1062"]!=true||failed_ui["row1Unique"]!=2||failed_ui["row3Value"]!=7||failed_ui["witnessConnectionId"]!=proof["witnessConnectionId"]||rolled["witnessConnectionId"]!=proof["witnessConnectionId"]||failed_ui["witnessMarkerValue"]!=proof["markerValueAfterError"]||rolled["witnessMarkerValue"]!=proof["markerValueAfterRollback"]{return Err(invalid())}
        }
        if self.phase=="grid-timeout"&&reported_success{
            let state=self.timeout_handshake.lock().map_err(|_|invalid())?;if !state.confirmed.iter().all(|confirmed|*confirmed){return Err(invalid())}let failed=state.failed_native.as_ref().ok_or_else(invalid)?;
            if failed["timeout"]["lastApplyResult"]!=json!({"ok":false,"affected":0,"inTransaction":true,"outcomeCount":1,"failedOutcomeCount":1,"errorClass":"1205"})||failed["timeout"]["lastObservedTransactionState"]!=json!({"active":true,"pendingAffected":1}){return Err(invalid())}
            for(method,success)in[("applyEdits",2),("executeStatement",4),("commitTransaction",1)]{if failed["methods"][method]["success"]!=success||failed["methods"][method]["failure"]!=0{return Err(invalid())}}for counter in ["success","failure"]{if failed["methods"]["rollbackTransaction"][counter].as_u64().unwrap_or(0)!=0{return Err(invalid())}}
            let current=self.snapshot(secrets)?;if current["timeout"]["lastObservedTransactionState"]!=json!({"active":false,"pendingAffected":0})||current["methods"]["rollbackTransaction"]["success"]!=1||current["methods"]["rollbackTransaction"]["failure"]!=0{return Err(invalid())}
            let marker=state.published[0].as_ref().ok_or_else(invalid)?;let failed_ui=state.published[1].as_ref().ok_or_else(invalid)?;let rolled=state.published[2].as_ref().ok_or_else(invalid)?;let proof=&report["proof"];
            if failed_ui["uiActive"]!=proof["uiActiveAfterError"]||failed_ui["uiPendingAffected"]!=proof["uiPendingAffectedAfterError"]||failed_ui["dirtyRows"]!=proof["dirtyRowsAfterError"]||failed_ui["original1205"]!=true||failed_ui["row1Value"]!=1||failed_ui["row3Value"]!=7{return Err(invalid())}
            for payload in [marker,failed_ui,rolled]{if payload["witnessConnectionId"]!=proof["witnessConnectionId"]||payload["sessionTimeoutSeconds"]!=proof["sessionTimeoutSeconds"]||payload["rollbackOnTimeout"]!=proof["rollbackOnTimeout"]{return Err(invalid())}}
            if marker["witnessMarkerValue"]!=7||failed_ui["witnessMarkerValue"]!=proof["markerValueAfterError"]||rolled["witnessMarkerValue"]!=proof["markerValueAfterRollback"]{return Err(invalid())}
        }
        if self.phase=="grid-precision"&&reported_success{
            let state=self.precision_handshake.lock().map_err(|_|invalid())?;if !state.confirmed.iter().all(|confirmed|*confirmed){return Err(invalid())}let applied=state.applied_native.as_ref().ok_or_else(invalid)?;
            if applied["precision"]["lastApplyResult"]!=json!({"ok":true,"affected":1,"inTransaction":true,"outcomeCount":1,"failedOutcomeCount":0,"errorClass":"none"})||applied["precision"]["lastObservedTransactionState"]!=json!({"active":true,"pendingAffected":1}){return Err(invalid())}
            for(method,success)in[("applyEdits",1),("executeStatement",3),("commitTransaction",1)]{if applied["methods"][method]["success"]!=success||applied["methods"][method]["failure"]!=0{return Err(invalid())}}
            let current=self.snapshot(secrets)?;if current["precision"]["lastObservedTransactionState"]!=json!({"active":false,"pendingAffected":0}){return Err(invalid())}
            for(method,success)in[("applyEdits",1),("executeStatement",3),("commitTransaction",2)]{if current["methods"][method]["success"]!=success||current["methods"][method]["failure"]!=0{return Err(invalid())}}
            for snapshot in [applied,&current]{for counter in ["success","failure"]{if snapshot["methods"]["rollbackTransaction"][counter].as_u64().unwrap_or(0)!=0{return Err(invalid())}}}
            let proof=&report["proof"];for(index,field)in["baselineRowsSha256","draftRowsSha256","appliedRowsSha256","committedRowsSha256"].iter().enumerate(){if state.published[index].as_ref().ok_or_else(invalid)?["rowsSha256"]!=proof[*field]{return Err(invalid())}}
            let draft=state.published[1].as_ref().ok_or_else(invalid)?;let applied_ui=state.published[2].as_ref().ok_or_else(invalid)?;let committed=state.published[3].as_ref().ok_or_else(invalid)?;
            if draft["uiActive"]!=false||draft["uiPendingAffected"]!=0||draft["dirtyRows"]!=proof["dirtyRowsBeforeApply"]||applied_ui["uiActive"]!=proof["uiActiveAfterApply"]||applied_ui["uiPendingAffected"]!=proof["uiPendingAffectedAfterApply"]||applied_ui["dirtyRows"]!=proof["dirtyRowsAfterApply"]||applied_ui["witnessConnectionId"]!=proof["witnessConnectionId"]||committed["witnessConnectionId"]!=proof["witnessConnectionId"]||applied_ui["witnessProjectionSha256"]!=proof["uncommittedProjectionSha256"]||committed["witnessProjectionSha256"]!=proof["committedProjectionSha256"]{return Err(invalid())}
        }
        if self.phase=="grid-text"&&reported_success{
            let state=self.text_handshake.lock().map_err(|_|invalid())?;if !state.confirmed.iter().all(|confirmed|*confirmed){return Err(invalid())}for step in 0..4{text_green_native(state.native[step].as_ref().ok_or_else(invalid)?,step)?;}text_green_native(&self.snapshot(secrets)?,3)?;
            let proof=&report["proof"];for(index,field)in["baselineValuesSha256","draftValuesSha256","appliedValuesSha256","committedValuesSha256"].iter().enumerate(){if state.published[index].as_ref().ok_or_else(invalid)?["valuesSha256"]!=proof[*field]{return Err(invalid())}}
            let draft=state.published[1].as_ref().ok_or_else(invalid)?;let applied=state.published[2].as_ref().ok_or_else(invalid)?;let committed=state.published[3].as_ref().ok_or_else(invalid)?;
            if draft["uiActive"]!=false||draft["uiPendingAffected"]!=0||draft["dirtyRows"]!=proof["dirtyRowsBeforeApply"]||applied["uiActive"]!=proof["uiActiveAfterApply"]||applied["uiPendingAffected"]!=proof["uiPendingAffectedAfterApply"]||applied["dirtyRows"]!=proof["dirtyRowsAfterApply"]||applied["witnessConnectionId"]!=proof["witnessConnectionId"]||committed["witnessConnectionId"]!=proof["witnessConnectionId"]||applied["witnessProjectionSha256"]!=proof["uncommittedProjectionSha256"]||committed["witnessProjectionSha256"]!=proof["committedProjectionSha256"]{return Err(invalid())}
        }
        if self.phase=="session-timezone"&&reported_success{
            let state=self.session_timezone_handshake.lock().map_err(|_|invalid())?;if !state.confirmed.iter().all(|confirmed|*confirmed){return Err(invalid())}
            for(step,name)in SESSION_TIMEZONE_STEPS.iter().enumerate(){session_timezone_green_native(state.native[step].as_ref().ok_or_else(invalid)?,step)?;let published=state.published[step].as_ref().ok_or_else(invalid)?;let stage=&report["proof"][*name];for field in ["uiActive","uiPendingAffected","projectionSha256","connectionId","setFailed","autocommit"]{if published[field]!=stage[field]{return Err(invalid())}}}session_timezone_green_native(&self.snapshot(secrets)?,2)?;
        }
        if self.phase=="grid-time"&&reported_success{
            let state=self.time_handshake.lock().map_err(|_|invalid())?;if !state.confirmed.iter().all(|confirmed|*confirmed){return Err(invalid())}for(step,name)in TIME_STEPS.iter().enumerate(){time_green_native(state.native[step].as_ref().ok_or_else(invalid)?,step)?;let published=state.published[step].as_ref().ok_or_else(invalid)?;let stage=&report["proof"]["stages"][*name];for field in ["uiActive","uiPendingAffected","dirtyRows","valuesSha256","witnessConnectionId","witnessProjectionSha256"]{if published[field]!=stage[field]{return Err(invalid())}}}time_green_native(&self.snapshot(secrets)?,3)?;
        }
        if self.phase=="grid-time-crosszone"&&reported_success{
            let state=self.crosszone_handshake.lock().map_err(|_|invalid())?;if !state.confirmed.iter().all(|confirmed|*confirmed){return Err(invalid())}for(step,name)in CROSSZONE_STEPS.iter().enumerate(){crosszone_green_native(state.native[step].as_ref().ok_or_else(invalid)?,step)?;let published=state.published[step].as_ref().ok_or_else(invalid)?;let stage=&report["proof"]["stages"][*name];for field in ["uiActive","uiPendingAffected","dirtyRows","valuesSha256","witnessConnectionId","witnessProjectionSha256","sessionTimezone","resultTabsBefore","resultTabsAfter","activeTabGeneration","activeTabOwned","nativeExecuteCount"]{if published[field]!=stage[field]{return Err(invalid())}}if published["nativeExecuteCount"].as_u64()!=Some(6+3*step as u64){return Err(invalid())}}crosszone_green_native(&self.snapshot(secrets)?,2)?;
        }
        if self.phase=="grid-bit-blob"&&reported_success{
            let state=self.binary_handshake.lock().map_err(|_|invalid())?;
            if !state.confirmed.iter().all(|confirmed|*confirmed){return Err(invalid())}
            for(step,name)in BINARY_STEPS.iter().enumerate(){
                binary_green_native(state.native[step].as_ref().ok_or_else(invalid)?,step)?;
                let published=state.published[step].as_ref().ok_or_else(invalid)?;
                let stage=&report["proof"]["stages"][*name];
                for field in ["uiActive","uiPendingAffected","dirtyRows","witnessConnectionId","witnessProjectionSha256"]{if published[field]!=stage[field]{return Err(invalid())}}
            }
            let current=self.snapshot(secrets)?;
            binary_green_native(&current,3)?;
            if current["methods"]["connectConnection"]["success"].as_u64().unwrap_or(0)<1{return Err(invalid())}
            if current["keyringGets"].as_u64().unwrap_or(0)<1||current["keyringHits"].as_u64().unwrap_or(0)<1||current["keyringSets"].as_u64().unwrap_or(0)!=0{return Err(invalid())}
        }
        private_metadata(&self.root,true)?;
        private_metadata(&self.root.join("evidence"),true)?;
        let envelope=json!({"schemaVersion":1,"report":report,"observations":self.snapshot(secrets)?});
        let filename=ui_report_filename(&self.phase)?;
        create_private_json(&self.root.join("evidence").join(filename),&envelope)?;
        Ok(reported_success)
    }
    pub fn commit_checkpoint(&self,request:&Value,secrets:&AcceptanceSecrets)->Result<(),AppError> {
        if self.phase!="commit" {return Err(invalid())}
        let step=commit_step(request,true)?;
        let mut state=self.commit_handshake.lock().map_err(|_|invalid())?;
        if let Some(published)=&state.published[step] {return if published==request {Ok(())}else{Err(invalid())}}
        if step>0 && !state.confirmed[step-1] {return Err(invalid())}
        let publication=json!({"schemaVersion":1,"runId":self.run_id,"phase":"commit","pid":std::process::id(),"step":COMMIT_STEPS[step],"bodySha256":request["bodySha256"],"active":request["active"],"pendingAffected":request["pendingAffected"],"observations":self.snapshot(secrets)?});
        publish_commit_json(&self.root,CommitFile::Checkpoint,step,&publication)?;
        state.published[step]=Some(request.clone());Ok(())
    }
    pub fn commit_continue(&self,request:&Value)->Result<Value,AppError> {
        if self.phase!="commit" {return Err(invalid())}
        let step=commit_step(request,false)?;
        let mut state=self.commit_handshake.lock().map_err(|_|invalid())?;
        let published=state.published[step].as_ref().ok_or_else(invalid)?;
        if state.confirmed[step] {return Ok(json!({"ready":true,"verified":true}))}
        let Some(ack)=read_commit_ack(&self.root,step)? else {return Ok(json!({"ready":false,"verified":false}))};
        exact_fields(&ack,&["schemaVersion","runId","phase","pid","step","bodySha256","verified"])?;
        if ack["schemaVersion"]!=1 || text(&ack,"runId")?!=self.run_id || text(&ack,"phase")?!="commit" || ack["pid"].as_u64()!=Some(std::process::id()as u64) || text(&ack,"step")?!=COMMIT_STEPS[step] || hash_string(&ack["bodySha256"])?!=hash_string(&published["bodySha256"])? {return Err(invalid())}
        let verified=ack["verified"].as_bool().ok_or_else(invalid)?;
        if verified {state.confirmed[step]=true;}
        Ok(json!({"ready":true,"verified":verified}))
    }
    pub fn deadlock_checkpoint(&self,request:&Value,secrets:&AcceptanceSecrets)->Result<(),AppError> {
        if self.phase!="grid-deadlock" {return Err(invalid())}
        let step=deadlock_step(request,true)?;let mut state=self.deadlock_handshake.lock().map_err(|_|invalid())?;
        if let Some(published)=&state.published[step] {return if published==request{Ok(())}else{Err(invalid())}}
        if step>0&&!state.confirmed[step-1]{return Err(invalid())}
        let publication=json!({"schemaVersion":1,"runId":self.run_id,"phase":"grid-deadlock","pid":std::process::id(),"report":request,"observations":self.snapshot(secrets)?});
        publish_commit_json(&self.root,CommitFile::DeadlockCheckpoint,step,&publication)?;state.published[step]=Some(request.clone());Ok(())
    }
    pub fn deadlock_continue(&self,request:&Value)->Result<Value,AppError> {
        if self.phase!="grid-deadlock" {return Err(invalid())}
        let step=deadlock_step(request,false)?;let mut state=self.deadlock_handshake.lock().map_err(|_|invalid())?;
        let published=state.published[step].as_ref().ok_or_else(invalid)?;
        if state.confirmed[step]{return Ok(json!({"ready":true,"verified":true}))}
        let Some(ack)=read_deadlock_ack(&self.root,step)? else{return Ok(json!({"ready":false,"verified":false}))};
        exact_fields(&ack,&["schemaVersion","runId","phase","pid","step","proof","verified"])?;
        if ack["schemaVersion"]!=1||text(&ack,"runId")?!=self.run_id||text(&ack,"phase")?!="grid-deadlock"||ack["pid"].as_u64()!=Some(std::process::id()as u64)||text(&ack,"step")?!=DEADLOCK_STEPS[step]||ack["proof"]!=*published{return Err(invalid())}
        let verified=ack["verified"].as_bool().ok_or_else(invalid)?;if verified{state.confirmed[step]=true;}
        Ok(json!({"ready":true,"verified":verified}))
    }
    pub fn duplicate_checkpoint(&self,request:&Value,secrets:&AcceptanceSecrets)->Result<(),AppError> {
        if self.phase!="grid-duplicate"{return Err(invalid())}
        let step=duplicate_step(request,true)?;let mut state=self.duplicate_handshake.lock().map_err(|_|invalid())?;
        if let Some(published)=&state.published[step]{return if published==request{Ok(())}else{Err(invalid())}}
        if step>0&&!state.confirmed[step-1]{return Err(invalid())}
        let observations=self.snapshot(secrets)?;let publication=json!({"schemaVersion":1,"runId":self.run_id,"phase":"grid-duplicate","pid":std::process::id(),"report":request,"observations":observations});
        publish_commit_json(&self.root,CommitFile::DuplicateCheckpoint,step,&publication)?;
        if step==1{state.failed_native=Some(observations);}
        state.published[step]=Some(request.clone());Ok(())
    }
    pub fn duplicate_continue(&self,request:&Value)->Result<Value,AppError> {
        if self.phase!="grid-duplicate"{return Err(invalid())}
        let step=duplicate_step(request,false)?;let mut state=self.duplicate_handshake.lock().map_err(|_|invalid())?;let published=state.published[step].as_ref().ok_or_else(invalid)?;
        if state.confirmed[step]{return Ok(json!({"ready":true,"verified":true}))}
        let Some(ack)=read_duplicate_ack(&self.root,step)?else{return Ok(json!({"ready":false,"verified":false}))};
        exact_fields(&ack,&["schemaVersion","runId","phase","pid","step","proof","verified"])?;
        if ack["schemaVersion"]!=1||text(&ack,"runId")?!=self.run_id||text(&ack,"phase")?!="grid-duplicate"||ack["pid"].as_u64()!=Some(std::process::id()as u64)||text(&ack,"step")?!=DUPLICATE_STEPS[step]||ack["proof"]!=*published{return Err(invalid())}
        let verified=ack["verified"].as_bool().ok_or_else(invalid)?;if verified{state.confirmed[step]=true;}Ok(json!({"ready":true,"verified":verified}))
    }
    pub fn timeout_checkpoint(&self,request:&Value,secrets:&AcceptanceSecrets)->Result<(),AppError>{
        if self.phase!="grid-timeout"{return Err(invalid())}let step=timeout_step(request,true)?;let mut state=self.timeout_handshake.lock().map_err(|_|invalid())?;
        if let Some(published)=&state.published[step]{return if published==request{Ok(())}else{Err(invalid())}}
        if step>0&&!state.confirmed[step-1]{return Err(invalid())}
        let observations=self.snapshot(secrets)?;let publication=json!({"schemaVersion":1,"runId":self.run_id,"phase":"grid-timeout","pid":std::process::id(),"report":request,"observations":observations});publish_commit_json(&self.root,CommitFile::TimeoutCheckpoint,step,&publication)?;if step==1{state.failed_native=Some(observations);}state.published[step]=Some(request.clone());Ok(())
    }
    pub fn timeout_continue(&self,request:&Value)->Result<Value,AppError>{
        if self.phase!="grid-timeout"{return Err(invalid())}let step=timeout_step(request,false)?;let mut state=self.timeout_handshake.lock().map_err(|_|invalid())?;let published=state.published[step].as_ref().ok_or_else(invalid)?;
        if state.confirmed[step]{return Ok(json!({"ready":true,"verified":true}))}
        let Some(ack)=read_timeout_ack(&self.root,step)?else{return Ok(json!({"ready":false,"verified":false}))};exact_fields(&ack,&["schemaVersion","runId","phase","pid","step","proof","verified"])?;
        if ack["schemaVersion"]!=1||text(&ack,"runId")?!=self.run_id||text(&ack,"phase")?!="grid-timeout"||ack["pid"].as_u64()!=Some(std::process::id()as u64)||text(&ack,"step")?!=TIMEOUT_STEPS[step]||ack["proof"]!=*published{return Err(invalid())}let verified=ack["verified"].as_bool().ok_or_else(invalid)?;if verified{state.confirmed[step]=true;}Ok(json!({"ready":true,"verified":verified}))
    }
    pub fn precision_checkpoint(&self,request:&Value,secrets:&AcceptanceSecrets)->Result<(),AppError>{
        if self.phase!="grid-precision"{return Err(invalid())}let step=precision_step(request,true)?;let mut state=self.precision_handshake.lock().map_err(|_|invalid())?;if let Some(published)=&state.published[step]{return if published==request{Ok(())}else{Err(invalid())}}if step>0&&!state.confirmed[step-1]{return Err(invalid())}
        let observations=self.snapshot(secrets)?;let publication=json!({"schemaVersion":1,"runId":self.run_id,"phase":"grid-precision","pid":std::process::id(),"report":request,"observations":observations});publish_commit_json(&self.root,CommitFile::PrecisionCheckpoint,step,&publication)?;if step==2{state.applied_native=Some(observations);}state.published[step]=Some(request.clone());Ok(())
    }
    pub fn precision_continue(&self,request:&Value)->Result<Value,AppError>{
        if self.phase!="grid-precision"{return Err(invalid())}let step=precision_step(request,false)?;let mut state=self.precision_handshake.lock().map_err(|_|invalid())?;let published=state.published[step].as_ref().ok_or_else(invalid)?;if state.confirmed[step]{return Ok(json!({"ready":true,"verified":true}))}let Some(ack)=read_precision_ack(&self.root,step)?else{return Ok(json!({"ready":false,"verified":false}))};exact_fields(&ack,&["schemaVersion","runId","phase","pid","step","proof","verified"])?;
        if ack["schemaVersion"]!=1||text(&ack,"runId")?!=self.run_id||text(&ack,"phase")?!="grid-precision"||ack["pid"].as_u64()!=Some(std::process::id()as u64)||text(&ack,"step")?!=PRECISION_STEPS[step]||ack["proof"]!=*published{return Err(invalid())}let verified=ack["verified"].as_bool().ok_or_else(invalid)?;if verified{state.confirmed[step]=true;}Ok(json!({"ready":true,"verified":verified}))
    }
    pub fn text_checkpoint(&self,request:&Value,secrets:&AcceptanceSecrets)->Result<(),AppError>{
        if self.phase!="grid-text"{return Err(invalid())}let step=text_step(request,true)?;let mut state=self.text_handshake.lock().map_err(|_|invalid())?;if let Some(published)=&state.published[step]{return if published==request{Ok(())}else{Err(invalid())}}if step>0&&!state.confirmed[step-1]{return Err(invalid())}let observations=self.snapshot(secrets)?;let publication=json!({"schemaVersion":1,"runId":self.run_id,"phase":"grid-text","pid":std::process::id(),"report":request,"observations":observations});publish_commit_json(&self.root,CommitFile::TextCheckpoint,step,&publication)?;state.native[step]=Some(observations);state.published[step]=Some(request.clone());Ok(())
    }
    pub fn text_continue(&self,request:&Value)->Result<Value,AppError>{
        if self.phase!="grid-text"{return Err(invalid())}let step=text_step(request,false)?;let mut state=self.text_handshake.lock().map_err(|_|invalid())?;let published=state.published[step].as_ref().ok_or_else(invalid)?;if state.confirmed[step]{return Ok(json!({"ready":true,"verified":true}))}let Some(ack)=read_text_ack(&self.root,step)?else{return Ok(json!({"ready":false,"verified":false}))};exact_fields(&ack,&["schemaVersion","runId","phase","pid","step","proof","verified"])?;
        if ack["schemaVersion"]!=1||text(&ack,"runId")?!=self.run_id||text(&ack,"phase")?!="grid-text"||ack["pid"].as_u64()!=Some(std::process::id()as u64)||text(&ack,"step")?!=TEXT_STEPS[step]||ack["proof"]!=*published{return Err(invalid())}let verified=ack["verified"].as_bool().ok_or_else(invalid)?;if verified{state.confirmed[step]=true;}Ok(json!({"ready":true,"verified":verified}))
    }
    pub fn session_timezone_checkpoint(&self,request:&Value,secrets:&AcceptanceSecrets)->Result<(),AppError>{
        if self.phase!="session-timezone"{return Err(invalid())}let step=session_timezone_step(request,true)?;let mut state=self.session_timezone_handshake.lock().map_err(|_|invalid())?;if let Some(published)=&state.published[step]{return if published==request{Ok(())}else{Err(invalid())}}if step>0&&!state.confirmed[step-1]{return Err(invalid())}let observations=self.snapshot(secrets)?;let publication=json!({"schemaVersion":1,"runId":self.run_id,"phase":"session-timezone","pid":std::process::id(),"report":request,"observations":observations});publish_commit_json(&self.root,CommitFile::SessionTimezoneCheckpoint,step,&publication)?;state.native[step]=Some(observations);state.published[step]=Some(request.clone());Ok(())
    }
    pub fn session_timezone_continue(&self,request:&Value)->Result<Value,AppError>{
        if self.phase!="session-timezone"{return Err(invalid())}let step=session_timezone_step(request,false)?;let mut state=self.session_timezone_handshake.lock().map_err(|_|invalid())?;let published=state.published[step].as_ref().ok_or_else(invalid)?;if state.confirmed[step]{return Ok(json!({"ready":true,"verified":true}))}let Some(ack)=read_session_timezone_ack(&self.root,step)?else{return Ok(json!({"ready":false,"verified":false}))};exact_fields(&ack,&["schemaVersion","runId","phase","pid","step","proof","verified"])?;
        if ack["schemaVersion"]!=1||text(&ack,"runId")?!=self.run_id||text(&ack,"phase")?!="session-timezone"||ack["pid"].as_u64()!=Some(std::process::id()as u64)||text(&ack,"step")?!=SESSION_TIMEZONE_STEPS[step]||ack["proof"]!=*published{return Err(invalid())}let verified=ack["verified"].as_bool().ok_or_else(invalid)?;if verified{state.confirmed[step]=true;}Ok(json!({"ready":true,"verified":verified}))
    }
    pub fn time_checkpoint(&self,request:&Value,secrets:&AcceptanceSecrets)->Result<(),AppError>{
        if self.phase!="grid-time"{return Err(invalid())}let step=time_step(request,true)?;let mut state=self.time_handshake.lock().map_err(|_|invalid())?;if let Some(published)=&state.published[step]{return if published==request{Ok(())}else{Err(invalid())}}if step>0&&!state.confirmed[step-1]{return Err(invalid())}let observations=self.snapshot(secrets)?;let publication=json!({"schemaVersion":1,"runId":self.run_id,"phase":"grid-time","pid":std::process::id(),"report":request,"observations":observations});publish_commit_json(&self.root,CommitFile::TimeCheckpoint,step,&publication)?;state.native[step]=Some(observations);state.published[step]=Some(request.clone());Ok(())
    }
    pub fn time_continue(&self,request:&Value)->Result<Value,AppError>{
        if self.phase!="grid-time"{return Err(invalid())}let step=time_step(request,false)?;let mut state=self.time_handshake.lock().map_err(|_|invalid())?;let published=state.published[step].as_ref().ok_or_else(invalid)?;if state.confirmed[step]{return Ok(json!({"ready":true,"verified":true}))}let Some(ack)=read_time_ack(&self.root,step)?else{return Ok(json!({"ready":false,"verified":false}))};exact_fields(&ack,&["schemaVersion","runId","phase","pid","step","proof","verified"])?;
        if ack["schemaVersion"]!=1||text(&ack,"runId")?!=self.run_id||text(&ack,"phase")?!="grid-time"||ack["pid"].as_u64()!=Some(std::process::id()as u64)||text(&ack,"step")?!=TIME_STEPS[step]||ack["proof"]!=*published{return Err(invalid())}let verified=ack["verified"].as_bool().ok_or_else(invalid)?;if verified{state.confirmed[step]=true;}Ok(json!({"ready":true,"verified":verified}))
    }
    pub fn crosszone_checkpoint(&self,request:&Value,secrets:&AcceptanceSecrets)->Result<(),AppError>{
        if self.phase!="grid-time-crosszone"{return Err(invalid())}let step=crosszone_step(request,true)?;let mut state=self.crosszone_handshake.lock().map_err(|_|invalid())?;
        // No step skipping and no replay of an already superseded step.
        if state.published.iter().skip(step+1).any(|published|published.is_some()){return Err(invalid())}
        if let Some(published)=&state.published[step]{return if published==request{Ok(())}else{Err(invalid())}}
        if step>0&&!state.confirmed[step-1]{return Err(invalid())}
        // Freshness of the counted evidence only; the displayed values are never compared with the expected truth.
        if request["resultTabsAfter"].as_u64()!=request["resultTabsBefore"].as_u64().map(|before|before+1){return Err(invalid())}
        if request["activeTabGeneration"]!=request["resultTabsAfter"]{return Err(invalid())}
        if request["activeTabOwned"]!=json!(true){return Err(invalid())}
        let native=integer(&request["nativeExecuteCount"],10000)?;
        if native<3{return Err(invalid())}
        if step>0{let previous=integer(&state.published[step-1].as_ref().ok_or_else(invalid)?["nativeExecuteCount"],10000)?;if native<=previous{return Err(invalid())}}
        let observations=self.snapshot(secrets)?;let publication=json!({"schemaVersion":1,"runId":self.run_id,"phase":"grid-time-crosszone","pid":std::process::id(),"report":request,"observations":observations});publish_commit_json(&self.root,CommitFile::CrosszoneCheckpoint,step,&publication)?;state.native[step]=Some(observations);state.published[step]=Some(request.clone());Ok(())
    }
    pub fn crosszone_continue(&self,request:&Value)->Result<Value,AppError>{
        if self.phase!="grid-time-crosszone"{return Err(invalid())}let step=crosszone_step(request,false)?;let mut state=self.crosszone_handshake.lock().map_err(|_|invalid())?;let published=state.published[step].as_ref().ok_or_else(invalid)?;if state.confirmed[step]{return Ok(json!({"ready":true,"verified":true}))}let Some(ack)=read_crosszone_ack(&self.root,step)?else{return Ok(json!({"ready":false,"verified":false}))};exact_fields(&ack,&["schemaVersion","runId","phase","pid","step","proof","verified"])?;
        if ack["schemaVersion"]!=1||text(&ack,"runId")?!=self.run_id||text(&ack,"phase")?!="grid-time-crosszone"||ack["pid"].as_u64()!=Some(std::process::id()as u64)||text(&ack,"step")?!=CROSSZONE_STEPS[step]||ack["proof"]!=*published{return Err(invalid())}let verified=ack["verified"].as_bool().ok_or_else(invalid)?;if verified{state.confirmed[step]=true;}Ok(json!({"ready":true,"verified":verified}))
    }
    pub fn binary_checkpoint(&self,request:&Value,secrets:&AcceptanceSecrets)->Result<(),AppError>{
        if self.phase!="grid-bit-blob"{return Err(invalid())}
        let step=binary_step(request,true)?;let mut state=self.binary_handshake.lock().map_err(|_|invalid())?;
        // A step that a later step already covered can never be published or replayed again.
        if state.published.iter().skip(step+1).any(|published|published.is_some()){return Err(invalid())}
        if let Some(published)=&state.published[step]{return if published==request{Ok(())}else{Err(invalid())}}
        if step>0&&!state.confirmed[step-1]{return Err(invalid())}
        let observations=self.snapshot(secrets)?;let publication=json!({"schemaVersion":1,"runId":self.run_id,"phase":"grid-bit-blob","pid":std::process::id(),"report":request,"observations":observations});
        publish_commit_json(&self.root,CommitFile::BinaryCheckpoint,step,&publication)?;state.native[step]=Some(observations);state.published[step]=Some(request.clone());Ok(())
    }
    pub fn binary_continue(&self,request:&Value)->Result<Value,AppError>{
        if self.phase!="grid-bit-blob"{return Err(invalid())}
        let step=binary_step(request,false)?;let mut state=self.binary_handshake.lock().map_err(|_|invalid())?;let published=state.published[step].as_ref().ok_or_else(invalid)?;
        if state.confirmed[step]{return Ok(json!({"ready":true,"verified":true}))}
        let Some(ack)=read_binary_ack(&self.root,step)? else{return Ok(json!({"ready":false,"verified":false}))};exact_fields(&ack,&["schemaVersion","runId","phase","pid","step","proof","verified"])?;
        if ack["schemaVersion"]!=1||text(&ack,"runId")?!=self.run_id||text(&ack,"phase")?!="grid-bit-blob"||ack["pid"].as_u64()!=Some(std::process::id()as u64)||text(&ack,"step")?!=BINARY_STEPS[step]||ack["proof"]!=*published{return Err(invalid())}
        let verified=ack["verified"].as_bool().ok_or_else(invalid)?;if verified{state.confirmed[step]=true;}Ok(json!({"ready":true,"verified":verified}))
    }
    pub fn frontend_startup_trace(&self,request:&Value)->Result<(),AppError> {
        let stage=frontend_trace_stage(request)?;
        if self.phase=="restart-probe" {return Err(invalid())}
        self.append_startup_trace(stage,"none")
    }
    pub fn native_startup_trace(&self,stage:&str,method:&str)->Result<(),AppError> {
        if !["native_enter","native_returned","native_failed"].contains(&stage) {return Err(invalid())}
        self.append_startup_trace(stage,native_method_group(method))
    }
    fn append_startup_trace(&self,stage:&str,method:&str)->Result<(),AppError> {
        if !["initial","restart-attempt","explain","commit","grid-deadlock","grid-duplicate","grid-timeout","grid-precision","grid-text","session-timezone","grid-time","grid-time-crosszone","grid-bit-blob"].contains(&self.phase.as_str()) {return Ok(())}
        let mut trace=self.startup_trace.lock().map_err(|_|invalid())?;
        trace.as_mut().ok_or_else(invalid)?.append(stage,method)
    }
    pub fn probe_method_allowed(&self,method:&str)->bool {
        self.phase!="restart-probe" || ["mysqlAcceptanceContext","mysqlAcceptanceProbeReport"].contains(&method)
    }
    pub fn retain_probe_checkpoint(&self,label:&str,url:&str)->Result<bool,AppError> {
        if self.phase!="restart-probe" {return Err(invalid())}
        private_metadata(&self.root,true)?;private_metadata(&self.root.join("evidence"),true)?;
        let allowed=bridge_window_allowed(label,url);
        let checkpoint=json!({"window":label=="main","page":true,"originAllowed":allowed});
        create_private_json(&self.root.join("evidence").join(format!("host-probe-{}.json",std::process::id())),&checkpoint)?;
        Ok(allowed)
    }
    pub fn probe_script(&self)->Result<String,AppError> {
        if self.phase!="restart-probe" {return Err(invalid())}
        const SCRIPT:&str=r#"function(runId){setTimeout(async()=>{
          const checks={storageAccessible:false,markerMatched:false,nonemptyStore:false,startupFailureVisible:false};
          try{
            const matched=localStorage.getItem('dbstudio:mysql-parity:'+runId)===runId;
            const nonempty=localStorage.length>=1;
            checks.storageAccessible=true;checks.markerMatched=matched;checks.nonemptyStore=nonempty;
          }catch{}
          checks.startupFailureVisible=document.getElementById('app')?.textContent==='应用启动预检失败';
          try{await window.__TAURI_INTERNALS__.invoke('backend_call',{method:'mysqlAcceptanceProbeReport',args:[{schemaVersion:1,checks}]});}catch{}
        },500)}"#;
        Ok(format!("({SCRIPT})({});",javascript_json(&json!(self.run_id))?))
    }
    pub fn retain_probe_report(&self,report:&Value,secrets:&AcceptanceSecrets)->Result<(),AppError> {
        validate_probe_report(report,&self.phase)?;
        let observations=self.snapshot(secrets)?;
        if !observations["methods"].as_object().is_some_and(|methods|methods.is_empty())
            || ["keyringGets","keyringHits","keyringSets"].iter().any(|key|observations[*key]!=0) {return Err(invalid())}
        private_metadata(&self.root,true)?;private_metadata(&self.root.join("evidence"),true)?;
        let envelope=json!({"schemaVersion":1,"scope":"restart-storage-probe","runId":self.run_id,"phase":"restart-probe","checks":report["checks"],"observations":observations,"productionReady":false,"restartVerified":false});
        create_private_json(&self.root.join("evidence").join(format!("probe-restart-{}.json",std::process::id())),&envelope)
    }
    pub fn context(&self) -> Value { self.context.clone() }
    pub fn namespace(&self) -> String { format!("io.dbstudio.acceptance.mysql.{}",self.run_id) }
    pub fn record(&self, method:&str, success:bool, elapsed_ms:u128) {
        // Called only after the shell's CORE_METHODS whitelist; no args, rows or raw errors.
        if let Ok(mut observations)=self.observations.lock() {
            let entry=observations.entry(method.to_owned()).or_insert_with(||json!({"success":0,"failure":0,"totalElapsedMs":0}));
            let counter=if success {"success"}else{"failure"};
            entry[counter]=json!(entry[counter].as_u64().unwrap_or(0).saturating_add(1));
            entry["totalElapsedMs"]=json!(entry["totalElapsedMs"].as_u64().unwrap_or(0).saturating_add(elapsed_ms.min(u64::MAX as u128) as u64));
        }
    }
    pub fn record_deadlock_result(&self,method:&str,result:&Result<Value,AppError>) {
        if self.phase!="grid-deadlock" {return}
        if let Ok(mut observed)=self.deadlock_observation.lock() {
            if method=="applyEdits" {
                observed.last_apply_failure=match result {
                    Err(error)=>deadlock_failure_class(&error.code,&error.message),
                    Ok(value) if value["ok"]==false=>value["outcomes"].as_array().and_then(|outcomes|outcomes.iter().filter_map(|outcome|outcome["error"].as_str()).map(|message|deadlock_failure_class("",message)).find(|class|*class!="other")).unwrap_or("other"),
                    Ok(_)=>"none"
                };
            }
            if ["transactionState","commitTransaction","rollbackTransaction"].contains(&method) {
                if let Ok(value)=result {if let (Some(active),Some(pending))=(value["active"].as_bool(),value["pendingAffected"].as_u64()){observed.last_transaction=Some(json!({"active":active,"pendingAffected":pending}));}}
            }
        }
    }
    pub fn record_duplicate_result(&self,method:&str,result:&Result<Value,AppError>) {
        if self.phase!="grid-duplicate"{return}
        if let Ok(value)=result {if let Ok(mut observed)=self.duplicate_observation.lock(){
            if method=="applyEdits"{observed.last_apply=duplicate_apply_scalars(value);}
            if ["transactionState","commitTransaction","rollbackTransaction"].contains(&method){if let(Some(active),Some(pending))=(value["active"].as_bool(),value["pendingAffected"].as_u64()){observed.last_transaction=Some(json!({"active":active,"pendingAffected":pending}));}}
        }}
    }
    pub fn record_timeout_result(&self,method:&str,result:&Result<Value,AppError>){
        if self.phase!="grid-timeout"{return}
        if let Ok(value)=result{if let Ok(mut observed)=self.timeout_observation.lock(){if method=="applyEdits"{observed.last_apply=timeout_apply_scalars(value);}if ["transactionState","commitTransaction","rollbackTransaction"].contains(&method){if let(Some(active),Some(pending))=(value["active"].as_bool(),value["pendingAffected"].as_u64()){observed.last_transaction=Some(json!({"active":active,"pendingAffected":pending}));}}}}
    }
    pub fn record_precision_result(&self,method:&str,result:&Result<Value,AppError>){
        if self.phase!="grid-precision"{return}if let Ok(value)=result{if let Ok(mut observed)=self.precision_observation.lock(){if method=="applyEdits"{observed.last_apply=precision_apply_scalars(value);}if ["transactionState","commitTransaction","rollbackTransaction"].contains(&method){if let(Some(active),Some(pending))=(value["active"].as_bool(),value["pendingAffected"].as_u64()){observed.last_transaction=Some(json!({"active":active,"pendingAffected":pending}));}}}}
    }
    pub fn record_text_result(&self,method:&str,result:&Result<Value,AppError>){
        if self.phase!="grid-text"{return}if let Ok(value)=result{if let Ok(mut observed)=self.text_observation.lock(){if method=="applyEdits"{observed.last_apply=text_apply_scalars(value);}if ["transactionState","commitTransaction","rollbackTransaction"].contains(&method){if let(Some(active),Some(pending))=(value["active"].as_bool(),value["pendingAffected"].as_u64()){observed.last_transaction=Some(json!({"active":active,"pendingAffected":pending}));}}}}
    }
    pub fn record_session_timezone_result(&self,method:&str,result:&Result<Value,AppError>){
        if self.phase!="session-timezone"||method!="transactionState"{return}if let Ok(value)=result{if let(Some(active),Some(pending))=(value["active"].as_bool(),value["pendingAffected"].as_u64()){if let Ok(mut observed)=self.session_timezone_transaction.lock(){*observed=Some(json!({"active":active,"pendingAffected":pending}));}}}
    }
    pub fn record_time_result(&self,method:&str,result:&Result<Value,AppError>){
        if self.phase!="grid-time"{return}if let Ok(value)=result{if let Ok(mut observed)=self.time_observation.lock(){if method=="applyEdits"{observed.last_apply=time_apply_scalars(value);}if ["transactionState","commitTransaction","rollbackTransaction"].contains(&method){if let(Some(active),Some(pending))=(value["active"].as_bool(),value["pendingAffected"].as_u64()){observed.last_transaction=Some(json!({"active":active,"pendingAffected":pending}));}}}}
    }
    pub fn record_crosszone_result(&self,method:&str,result:&Result<Value,AppError>){
        if self.phase!="grid-time-crosszone"||method!="transactionState"{return}if let Ok(value)=result{if let(Some(active),Some(pending))=(value["active"].as_bool(),value["pendingAffected"].as_u64()){if let Ok(mut observed)=self.crosszone_transaction.lock(){*observed=Some(json!({"active":active,"pendingAffected":pending}));}}}
    }
    pub fn record_binary_result(&self,method:&str,result:&Result<Value,AppError>){
        if self.phase!="grid-bit-blob"{return}
        if let Ok(value)=result{if let Ok(mut observed)=self.binary_observation.lock(){
            if method=="applyEdits"{observed.last_apply=time_apply_scalars(value);}
            if ["transactionState","commitTransaction","rollbackTransaction"].contains(&method){if let(Some(active),Some(pending))=(value["active"].as_bool(),value["pendingAffected"].as_u64()){observed.last_transaction=Some(json!({"active":active,"pendingAffected":pending}));}}
        }}
    }
    pub fn snapshot(&self, secrets:&AcceptanceSecrets) -> Result<Value,AppError> {
        let mut snapshot=json!({"scope":"test-host-observation-only","runId":self.run_id,"phase":semantic_phase(&self.phase),"methods":*self.observations.lock().map_err(|_|invalid())?,"keyringGets":secrets.gets.load(Ordering::Relaxed),"keyringHits":secrets.hits.load(Ordering::Relaxed),"keyringSets":secrets.sets.load(Ordering::Relaxed),"guiVerified":false,"mysqlVerified":false,"storePersistenceVerified":false});
        if self.phase=="grid-deadlock" {let observed=self.deadlock_observation.lock().map_err(|_|invalid())?;snapshot["deadlock"]=json!({"lastApplyFailureClass":observed.last_apply_failure,"lastObservedTransactionState":observed.last_transaction});}
        if self.phase=="grid-duplicate"{let observed=self.duplicate_observation.lock().map_err(|_|invalid())?;snapshot["duplicate"]=json!({"lastApplyResult":observed.last_apply,"lastObservedTransactionState":observed.last_transaction});}
        if self.phase=="grid-timeout"{let observed=self.timeout_observation.lock().map_err(|_|invalid())?;snapshot["timeout"]=json!({"lastApplyResult":observed.last_apply,"lastObservedTransactionState":observed.last_transaction});}
        if self.phase=="grid-precision"{let observed=self.precision_observation.lock().map_err(|_|invalid())?;snapshot["precision"]=json!({"lastApplyResult":observed.last_apply,"lastObservedTransactionState":observed.last_transaction});}
        if self.phase=="grid-text"{let observed=self.text_observation.lock().map_err(|_|invalid())?;snapshot["text"]=json!({"lastApplyResult":observed.last_apply,"lastObservedTransactionState":observed.last_transaction});}
        if self.phase=="session-timezone"{let observed=self.session_timezone_transaction.lock().map_err(|_|invalid())?;snapshot["sessionTimezone"]=json!({"lastObservedTransactionState":*observed});}
        if self.phase=="grid-time"{let observed=self.time_observation.lock().map_err(|_|invalid())?;snapshot["temporal"]=json!({"lastApplyResult":observed.last_apply,"lastObservedTransactionState":observed.last_transaction});}
        if self.phase=="grid-time-crosszone"{let observed=self.crosszone_transaction.lock().map_err(|_|invalid())?;snapshot["crosszone"]=json!({"lastApplyResult":Value::Null,"lastObservedTransactionState":*observed});}
        if self.phase=="grid-bit-blob"{let observed=self.binary_observation.lock().map_err(|_|invalid())?;snapshot["binary"]=json!({"lastApplyResult":observed.last_apply,"lastObservedTransactionState":observed.last_transaction});}
        Ok(snapshot)
    }
    pub fn retain_snapshot(&self,secrets:&AcceptanceSecrets)->Result<(),AppError> {
        // A timestamped new file preserves all earlier checkpoints. No overwrite or cleanup.
        let nonce=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|invalid())?.as_nanos();
        let _=&self.manifest_path;
        create_private_json(&self.root.join("evidence").join(format!("host-{}-{nonce}.json",self.phase)),&self.snapshot(secrets)?)
    }
}

/// Bridge-only origin check; no dev server, remote pages, alternate windows or URL payloads.
pub fn bridge_window_allowed(label:&str,url:&str)->bool {
    let Ok(url)=tauri::Url::parse(url) else {return false};
    label=="main" && url.username().is_empty() && url.password().is_none() && url.port().is_none()
        && url.query().is_none() && url.fragment().is_none()
        && ["/", "/index.html", ""].contains(&url.path())
        && ((url.scheme()=="tauri" && url.host_str()==Some("localhost"))
            || (["http","https"].contains(&url.scheme()) && url.host_str()==Some("tauri.localhost")))
}
fn read_app_password(phase:&str,fixture:&Path,path:&Path)->Result<String,AppError> {
    // Phase gate precedes even metadata access, so restart cannot reacquire the fixture credential.
    if phase!="initial" {return Err(AppError::unsupported("此阶段不允许重新填充测试密码"))}
    private_metadata(fixture,true)?;
    if path!=fixture.join("app.secret") {return Err(invalid())}
    private_metadata(path,false)?;
    let before=fs::symlink_metadata(path).map_err(|_|invalid())?;
    let file=File::open(path).map_err(|_|invalid())?;
    let opened=file.metadata().map_err(|_|invalid())?;
    #[cfg(unix)] {
        use std::os::unix::fs::{MetadataExt,PermissionsExt};
        if before.dev()!=opened.dev() || before.ino()!=opened.ino() || opened.nlink()!=1 || opened.permissions().mode()&0o777!=0o600 {return Err(invalid())}
    }
    if !opened.is_file() || opened.len()==0 || opened.len()>4097 {return Err(invalid())}
    let mut bytes=Vec::new();file.take(4098).read_to_end(&mut bytes).map_err(|_|invalid())?;
    if bytes.len()>4097 {return Err(invalid())}
    let value=String::from_utf8(bytes).map_err(|_|invalid())?;
    let password=value.strip_suffix('\n').unwrap_or(&value);
    if password.is_empty() || password.len()>4096 || password.contains(['\0','\n','\r']) {return Err(invalid())}
    Ok(password.to_owned())
}
fn javascript_json(value:&Value)->Result<String,AppError> {
    Ok(serde_json::to_string(value).map_err(|_|invalid())?.replace('<',"\\u003c").replace('\u{2028}',"\\u2028").replace('\u{2029}',"\\u2029"))
}
fn password_dom_script(context:&Value,password:&str)->Result<String,AppError> {
    let expected=json!({"host":text(context,"host")?,"port":context["port"],"database":text(context,"database")?,"user":text(context,"user")?});
    // Constants only; all runtime strings are separate JSON arguments, never source substitutions.
    const ACTOR:&str=r#"function(expected,password){
      const status='__DBSTUDIO_MYSQL_ACCEPTANCE_PASSWORD_STATUS__';
      window[status]='pending';
      try{
        const originOk=!location.port&&!location.search&&!location.hash&&['','/','/index.html'].includes(location.pathname)&&((location.protocol==='tauri:'&&location.hostname==='localhost')||((location.protocol==='http:'||location.protocol==='https:')&&location.hostname==='tauri.localhost'));
        const visible=element=>element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
        const dialogs=[...document.querySelectorAll('.connection-dialog[role="dialog"]')].filter(visible);
        if(!originOk||dialogs.length!==1){window[status]='target-mismatch';return;}
        const dialog=dialogs[0];
        const dialect=dialog.querySelectorAll('#f-dialect');
        if(dialect.length!==1||dialect[0].value!=='mysql'){window[status]='target-mismatch';return;}
        for(const name of ['host','port','database','user']){
          const fields=dialog.querySelectorAll('[data-key="'+name+'"]');
          if(fields.length!==1||!visible(fields[0])||fields[0].disabled||fields[0].value!==String(expected[name])){window[status]='target-mismatch';return;}
        }
        const inputs=[...document.querySelectorAll('input[data-secret-key="dbPassword"]')].filter(element=>visible(element)&&!element.disabled&&!element.readOnly&&element.type==='password');
        if(inputs.length!==1||!dialog.contains(inputs[0])){window[status]='target-mismatch';return;}
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
        if(!setter){window[status]='unavailable';return;}
        setter.call(inputs[0],password);
        inputs[0].dispatchEvent(new Event('input',{bubbles:true}));
        window[status]='filled';
      }catch{window[status]='unavailable';}
    }"#;
    Ok(format!("({ACTOR})({},{});",javascript_json(&expected)?,javascript_json(&json!(password))?))
}
fn exact_fields<'a>(value:&'a Value,fields:&[&str])->Result<&'a serde_json::Map<String,Value>,AppError> {
    let object=value.as_object().ok_or_else(invalid)?;
    if object.len()!=fields.len() || fields.iter().any(|name|!object.contains_key(*name)) {return Err(invalid())}
    Ok(object)
}
fn integer(value:&Value,max:u64)->Result<u64,AppError> {value.as_u64().filter(|number|*number<=max).ok_or_else(invalid)}
fn elapsed(value:&Value)->Result<(),AppError> {
    if !value.as_f64().is_some_and(|number|number.is_finite()&&number>=0.0&&number<=3600000.0) {return Err(invalid())}Ok(())
}
fn validate_ui_report(report:&Value,run_id:&str,phase:&str)->Result<bool,AppError> {
    match phase {"initial"=>validate_initial_report(report,run_id,phase),"restart"=>validate_restart_report(report,run_id),"explain"=>validate_explain_report(report,run_id),"commit"=>validate_commit_report(report,run_id),"grid-deadlock"=>validate_deadlock_report(report,run_id),"grid-duplicate"=>validate_duplicate_report(report,run_id),"grid-timeout"=>validate_timeout_report(report,run_id),"grid-precision"=>validate_precision_report(report,run_id),"grid-text"=>validate_text_report(report,run_id),"session-timezone"=>validate_session_timezone_report(report,run_id),"grid-time"=>validate_time_report(report,run_id),"grid-time-crosszone"=>validate_crosszone_report(report,run_id),"grid-bit-blob"=>validate_binary_report(report,run_id),_=>Err(invalid())}
}
fn validate_initial_report(report:&Value,run_id:&str,phase:&str)->Result<bool,AppError> {
    if phase!="initial" || serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384 {return Err(invalid())}
    exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","pages","actions","elapsedMs","failureCode"])?;
    if report["schemaVersion"]!=1 || text(report,"runId")?!=run_id || text(report,"phase")?!="initial" || text(report,"actionDriver")?!="native-dom-synthetic" {return Err(invalid())}
    const CHECKS:&[&str]=&["storage_preflight","connection_form","sql_select41","page_first","page_next","page_back"];
    let checks=exact_fields(&report["checks"],CHECKS)?;
    if checks.values().any(|value|!value.is_boolean()) {return Err(invalid())}
    let all_checks=checks.values().all(|value|value==&Value::Bool(true));
    let code=text(report,"failureCode")?;
    if !["NONE","ISOLATION","CONNECTION","QUERY","PAGING","TIMEOUT","DOM_FAILED","NATIVE_BRIDGE"].contains(&code) || (code=="NONE"&&!all_checks) {return Err(invalid())}
    elapsed(&report["elapsedMs"])?;
    let actions=exact_fields(&report["actions"],&["click","input","keydown"])?;
    for count in actions.values() {integer(count,10000)?;}
    let pages=exact_fields(&report["pages"],&["first","next","back"])?;
    for (name,expected_offset,first,last) in [("first",0,1,200),("next",200,201,400),("back",0,1,200)] {
        let page=&pages[name];let checked=checks[&format!("page_{name}")]==true;
        if page.is_null() {if checked{return Err(invalid())}continue;}
        exact_fields(page,&["offset","count","firstId","lastId","idsSha256","visibleMs"])?;
        let offset=integer(&page["offset"],805)?;let count=integer(&page["count"],200)?;
        let first_id=integer(&page["firstId"],805)?;let last_id=integer(&page["lastId"],805)?;
        let hash=text(page,"idsSha256")?;
        if hash.len()!=64 || !hash.bytes().all(|byte|byte.is_ascii_digit()||(b'a'..=b'f').contains(&byte)) {return Err(invalid())}
        elapsed(&page["visibleMs"])?;
        if checked && (offset!=expected_offset || count!=200 || first_id!=first || last_id!=last) {return Err(invalid())}
    }
    Ok(code=="NONE"&&all_checks)
}

fn validate_probe_report(report:&Value,phase:&str)->Result<(),AppError> {
    if phase!="restart-probe" || serde_json::to_vec(report).map_err(|_|invalid())?.len()>1024 {return Err(invalid())}
    exact_fields(report,&["schemaVersion","checks"])?;
    if report["schemaVersion"]!=1 {return Err(invalid())}
    let checks=exact_fields(&report["checks"],&["storageAccessible","markerMatched","nonemptyStore","startupFailureVisible"])?;
    if checks.values().any(|value|!value.is_boolean()) {return Err(invalid())}Ok(())
}
fn hash_string(value:&Value)->Result<&str,AppError> {
    let hash=value.as_str().ok_or_else(invalid)?;
    if hash.len()!=64 || !hash.bytes().all(|byte|byte.is_ascii_digit()||(b'a'..=b'f').contains(&byte)) {return Err(invalid())}
    Ok(hash)
}
fn time_green_native(snapshot:&Value,step:usize)->Result<(),AppError>{
    if step>=4{return Err(invalid())}for(method,success)in[("executeStatement",if step<2{4}else{5}),("commitTransaction",if step==3{2}else{1}),("applyEdits",if step<2{0}else{1}),("rollbackTransaction",0),("fetchCellValue",0),("insertRow",0),("deleteRows",0)]{if snapshot["methods"][method]["success"].as_u64().unwrap_or(0)!=success||snapshot["methods"][method]["failure"].as_u64().unwrap_or(0)!=0{return Err(invalid())}}
    if snapshot["temporal"]["lastObservedTransactionState"]!=json!({"active":step==2,"pendingAffected":if step==2{1}else{0}}){return Err(invalid())}if step<2{if !snapshot["temporal"]["lastApplyResult"].is_null(){return Err(invalid())}}else if snapshot["temporal"]["lastApplyResult"]!=json!({"ok":true,"affected":1,"inTransaction":true,"outcomeCount":1,"failedOutcomeCount":0,"errorClass":"none"}){return Err(invalid())}Ok(())
}
fn validate_time_report(report:&Value,run_id:&str)->Result<bool,AppError>{
    if serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384{return Err(invalid())}exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","proof","actions","elapsedMs","failureCode"])?;if report["schemaVersion"]!=1||text(report,"runId")?!=run_id||text(report,"phase")?!="grid-time"||text(report,"actionDriver")?!="native-dom-synthetic"{return Err(invalid())}
    let checks=exact_fields(&report["checks"],&["storage_marker","persisted_connection","credential_reconnect","fixture_created","session_utc_verified","table_open","baseline_exact","editor_raw_exact","local_edits","apply_succeeded","uncommitted_transaction","same_session_witness","normal_commit","reloaded_exact_values","transaction_ended","temporal_types"])?;if checks.values().any(|value|!value.is_boolean()){return Err(invalid())}let all_checks=checks.values().all(|value|value==&Value::Bool(true));let code=text(report,"failureCode")?;
    if !["NONE","ISOLATION","CONNECTION","FIXTURE_OPEN","SESSION_UTC_FAILED","TABLE_OPEN","BASELINE_MISMATCH","EDITOR_VALUE_LOSS","DIRTY_VALUES_MISMATCH","APPLY_REJECTED","TRANSACTION_STALE","WITNESS_FAILED","COMMIT_FAILED","RELOADED_VALUES_MISMATCH","CHECKPOINT","TIMEOUT","NATIVE_BRIDGE"].contains(&code)||(code=="NONE"&&!all_checks){return Err(invalid())}
    integer(&report["elapsedMs"],3600000)?;let actions=exact_fields(&report["actions"],&["click","input","keydown","dblclick"])?;let click=integer(&actions["click"],10000)?;let input=integer(&actions["input"],10000)?;let keydown=integer(&actions["keydown"],10000)?;let double=integer(&actions["dblclick"],10000)?;let proof=&report["proof"];
    if !proof.is_null(){exact_fields(proof,&["rowCount","columnCount","editorOriginals","stages"])?;if integer(&proof["rowCount"],1)?!=1||integer(&proof["columnCount"],5)?!=5{return Err(invalid())}let originals=proof["editorOriginals"].as_array().ok_or_else(invalid)?;if originals.len()!=5{return Err(invalid())}for editor in originals{if !editor.is_null(){exact_fields(editor,&["raw","isNull","valueDisabled","nullDisabled"])?;time_small_string(&editor["raw"])?;for field in ["isNull","valueDisabled","nullDisabled"]{editor[field].as_bool().ok_or_else(invalid)?;}}}
        exact_fields(&proof["stages"],TIME_STEPS)?;if proof["stages"]["baseline"].is_null(){return Err(invalid())}for name in TIME_STEPS{if !proof["stages"][*name].is_null(){time_stage(&proof["stages"][*name])?;}}
    }
    if code=="NONE"{
        if proof.is_null()||click<12||input!=10||double!=6||keydown!=0{return Err(invalid())}let stages=&proof["stages"];let baseline=&stages["baseline"];
        for(step,name)in TIME_STEPS.iter().enumerate(){let stage=&stages[*name];if stage.is_null()||stage["values"]!=time_expected_values(step>0)||stage["columnTypes"]!=json!(["integer","date","date","date","text","text"])||stage["witnessConnectionId"]!=baseline["witnessConnectionId"]||stage["witnessProjection"]!=time_expected_projection(step>=2)||stage["uiActive"]!=(step==2)||stage["uiPendingAffected"]!=if step==2{1}else{0}||stage["dirtyRows"]!=if step==1{1}else{0}{return Err(invalid())}}
        for(index,editor)in proof["editorOriginals"].as_array().ok_or_else(invalid)?.iter().enumerate(){if editor.is_null()||editor["raw"]!=baseline["values"][index+1]||editor["isNull"]!=false||editor["valueDisabled"]!=false||editor["nullDisabled"]!=false{return Err(invalid())}}
        if baseline["valuesSha256"]==stages["draft"]["valuesSha256"]||stages["draft"]["valuesSha256"]!=stages["applied"]["valuesSha256"]||stages["applied"]["valuesSha256"]!=stages["committed"]["valuesSha256"]||baseline["witnessProjectionSha256"]!=stages["draft"]["witnessProjectionSha256"]||baseline["witnessProjectionSha256"]==stages["applied"]["witnessProjectionSha256"]||stages["applied"]["witnessProjectionSha256"]!=stages["committed"]["witnessProjectionSha256"]{return Err(invalid())}
    }Ok(code=="NONE"&&all_checks)
}
fn validate_crosszone_report(report:&Value,run_id:&str)->Result<bool,AppError>{
    if serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384{return Err(invalid())}
    exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","proof","actions","elapsedMs","failureCode"])?;
    if report["schemaVersion"]!=1||text(report,"runId")?!=run_id||text(report,"phase")?!="grid-time-crosszone"||text(report,"actionDriver")?!="native-dom-synthetic"{return Err(invalid())}
    const CHECKS:&[&str]=&["storage_marker","persisted_connection","credential_reconnect","fixture_created","baseline_utc_display","shifted_plus08_display","restored_utc_display","non_ts_unchanged","epoch_invariant","microsecond_invariant","session_readback","same_connection","transaction_unchanged","observer_row_unchanged","session_restored"];
    let checks=exact_fields(&report["checks"],CHECKS)?;if checks.values().any(|value|!value.is_boolean()){return Err(invalid())}let all_checks=checks.values().all(|value|value==&Value::Bool(true));let code=text(report,"failureCode")?;
    if !["NONE","ISOLATION","CONNECTION","FIXTURE_OPEN","SET_REJECTED","SESSION_READBACK_MISMATCH","TABLE_OPEN","DISPLAY_VALUE_MISMATCH","DISPLAY_TYPE_MISMATCH","NON_TS_MUTATED","EPOCH_MICROSECOND_LOST","CONNECTION_CHANGED","TRANSACTION_STARTED","SESSION_NOT_RESTORED","OBSERVER_MISMATCH","CHECKPOINT","TIMEOUT","NATIVE_BRIDGE"].contains(&code)||(code=="NONE"&&!all_checks){return Err(invalid())}
    integer(&report["elapsedMs"],3600000)?;let actions=exact_fields(&report["actions"],&["click","input","keydown","dblclick"])?;for name in ["click","input","keydown","dblclick"]{integer(&actions[name],10000)?;}
    let proof=&report["proof"];
    // A partial failure keeps the reached actual stages; only the reached ones are validated.
    if !proof.is_null(){
        exact_fields(proof,&["rowCount","columnCount","stages"])?;
        if integer(&proof["rowCount"],1)?!=1||integer(&proof["columnCount"],5)?!=5{return Err(invalid())}
        exact_fields(&proof["stages"],CROSSZONE_STEPS)?;
        for name in CROSSZONE_STEPS{if !proof["stages"][*name].is_null(){crosszone_stage(&proof["stages"][*name])?;}}
    }
    if code=="NONE"{
        if proof.is_null(){return Err(invalid())}let stages=&proof["stages"];
        for(step,name)in CROSSZONE_STEPS.iter().enumerate(){
            let stage=&stages[*name];if stage.is_null(){return Err(invalid())}
            if stage["values"]!=crosszone_expected_values(step==1)||stage["columnTypes"]!=json!(["integer","date","date","date","text","text"])||stage["witnessProjection"]!=crosszone_expected_projection(step==1){return Err(invalid())}
            if stage["sessionTimezone"]!=crosszone_expected_timezone(step)||stage["uiActive"]!=false||stage["uiPendingAffected"]!=0||stage["dirtyRows"]!=0||stage["activeTabOwned"]!=true{return Err(invalid())}
            if stage["resultTabsAfter"].as_u64()!=stage["resultTabsBefore"].as_u64().map(|before|before+1)||stage["activeTabGeneration"]!=stage["resultTabsAfter"]{return Err(invalid())}
            if stage["nativeExecuteCount"].as_u64()!=Some(6+3*step as u64){return Err(invalid())}
        }
        if stages["baseline"]["witnessConnectionId"]!=stages["shifted"]["witnessConnectionId"]||stages["shifted"]["witnessConnectionId"]!=stages["restored"]["witnessConnectionId"]{return Err(invalid())}
        if stages["baseline"]["valuesSha256"]!=stages["restored"]["valuesSha256"]||stages["baseline"]["valuesSha256"]==stages["shifted"]["valuesSha256"]{return Err(invalid())}
        if stages["baseline"]["witnessProjectionSha256"]!=stages["restored"]["witnessProjectionSha256"]||stages["baseline"]["witnessProjectionSha256"]==stages["shifted"]["witnessProjectionSha256"]{return Err(invalid())}
    }
    Ok(code=="NONE"&&all_checks)
}
fn validate_binary_report(report:&Value,run_id:&str)->Result<bool,AppError>{
    if serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384{return Err(invalid())}
    exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","proof","actions","elapsedMs","failureCode"])?;
    if report["schemaVersion"]!=1||text(report,"runId")?!=run_id||text(report,"phase")?!="grid-bit-blob"||text(report,"actionDriver")?!="native-dom-synthetic"{return Err(invalid())}
    let checks=exact_fields(&report["checks"],BINARY_CHECKS)?;
    if checks.values().any(|value|!value.is_boolean()){return Err(invalid())}
    let all_checks=checks.values().all(|value|value==&Value::Bool(true));
    let code=text(report,"failureCode")?;
    // A closed failure set only; a product red stays publishable with partial checks and unreached stages.
    if !BINARY_FAILURES.contains(&code){return Err(invalid())}
    if code=="NONE"&&!all_checks{return Err(invalid())}
    integer(&report["elapsedMs"],3600000)?;
    let actions=exact_fields(&report["actions"],&["click","input","keydown","dblclick"])?;
    for name in ["click","input","keydown","dblclick"]{integer(&actions[name],10000)?;}
    let green=code=="NONE";
    let proof=&report["proof"];
    if proof.is_null(){if green{return Err(invalid())}}
    else{
        exact_fields(proof,&["rowCount","columnCount","rows","rowsSha256","columnCategories","readonlyGap","editorOriginal","stages"])?;
        if integer(&proof["rowCount"],4)?!=4||integer(&proof["columnCount"],3)?!=3{return Err(invalid())}
        if !proof["rows"].is_null(){let rows=proof["rows"].as_array().ok_or_else(invalid)?;if rows.len()!=4{return Err(invalid())}for row in rows{binary_row(row)?;}}
        if !proof["rowsSha256"].is_null(){hash_string(&proof["rowsSha256"])?;}
        if !proof["columnCategories"].is_null(){binary_categories(&proof["columnCategories"])?;}
        if !proof["readonlyGap"].is_null(){binary_gap(&proof["readonlyGap"])?;}
        if !proof["editorOriginal"].is_null(){binary_editor(&proof["editorOriginal"])?;}
        exact_fields(&proof["stages"],BINARY_STEPS)?;
        for name in BINARY_STEPS{if !proof["stages"][*name].is_null(){binary_stage(&proof["stages"][*name])?;}}
        if green{
            // Only the all green report must be complete; a product red may keep unreached stages null.
            if proof["rows"].is_null()||proof["rowsSha256"].is_null()||proof["columnCategories"].is_null()||proof["readonlyGap"].is_null()||proof["editorOriginal"].is_null(){return Err(invalid())}
            for name in BINARY_STEPS{if proof["stages"][*name].is_null(){return Err(invalid())}}
            let rows=proof["rows"].as_array().ok_or_else(invalid)?;
            for(index,row)in rows.iter().enumerate(){if integer(&row["id"],4)?!=index as u64+1{return Err(invalid())}}
            for row in rows{binary_row_self_consistent(row)?;}
            let stages=&proof["stages"];
            for(step,name)in BINARY_STEPS.iter().enumerate(){
                let stage=&stages[*name];
                if stage["targetRowId"]!=1||stage["blobEditableEntry"]!=true{return Err(invalid())}
                if stage["rows"].is_null()||stage["rowsSha256"].is_null()||stage["witnessConnectionId"].is_null()||stage["witnessProjectionSha256"].is_null(){return Err(invalid())}
                for row in stage["rows"].as_array().ok_or_else(invalid)?{binary_row_self_consistent(row)?;}
                let active=step==2;let pending=if step==2{1}else{0};let dirty=if step==1{1}else{0};
                if stage["uiActive"]!=active||stage["uiPendingAffected"]!=pending||stage["dirtyRows"]!=dirty{return Err(invalid())}
            }
            let cid=&stages["baseline"]["witnessConnectionId"];
            for name in BINARY_STEPS{if &stages[*name]["witnessConnectionId"]!=cid{return Err(invalid())}}
        }
    }
    Ok(code=="NONE"&&all_checks)
}
fn session_timezone_green_native(snapshot:&Value,step:usize)->Result<(),AppError>{
    if step>=3||snapshot["methods"]["executeStatement"]["success"].as_u64()!=Some(1+2*step as u64)||snapshot["methods"]["executeStatement"]["failure"]!=0||snapshot["sessionTimezone"]["lastObservedTransactionState"]!=json!({"active":false,"pendingAffected":0}){return Err(invalid())}
    for method in ["commitTransaction","rollbackTransaction","applyEdits","insertRow","deleteRows","fetchCellValue"]{for counter in ["success","failure"]{if snapshot["methods"][method][counter].as_u64().unwrap_or(0)!=0{return Err(invalid())}}}Ok(())
}
fn validate_session_timezone_report(report:&Value,run_id:&str)->Result<bool,AppError>{
    if serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384{return Err(invalid())}exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","proof","actions","elapsedMs","failureCode"])?;
    if report["schemaVersion"]!=1||text(report,"runId")?!=run_id||text(report,"phase")?!="session-timezone"||text(report,"actionDriver")?!="native-dom-synthetic"{return Err(invalid())}
    let checks=exact_fields(&report["checks"],&["storage_marker","persisted_connection","credential_reconnect","baseline_observed","offset_set","offset_readback","restored_set","restored_readback","same_connection","transaction_unchanged"])?;if checks.values().any(|value|!value.is_boolean()){return Err(invalid())}let all_checks=checks.values().all(|value|value==&Value::Bool(true));let code=text(report,"failureCode")?;
    if !["NONE","ISOLATION","CONNECTION","BASELINE_FAILED","SET_REJECTED","SESSION_MISMATCH","AUTOCOMMIT_CHANGED","EPOCH_LOSS","CONNECTION_CHANGED","TRANSACTION_CHANGED","CHECKPOINT","TIMEOUT","NATIVE_BRIDGE"].contains(&code)||(code=="NONE"&&!all_checks){return Err(invalid())}
    integer(&report["elapsedMs"],3600000)?;let actions=exact_fields(&report["actions"],&["click","input","keydown","dblclick"])?;let click=integer(&actions["click"],10000)?;let input=integer(&actions["input"],10000)?;let keydown=integer(&actions["keydown"],10000)?;let double=integer(&actions["dblclick"],10000)?;let proof=&report["proof"];
    if !proof.is_null(){exact_fields(proof,&["rowCount","baseline","offset","restored"])?;if integer(&proof["rowCount"],1)?!=1{return Err(invalid())}session_timezone_stage(&proof["baseline"])?;for name in ["offset","restored"]{if !proof[name].is_null(){session_timezone_stage(&proof[name])?;}}}
    if code=="NONE"{
        if proof.is_null()||proof["offset"].is_null()||proof["restored"].is_null()||click<5||input!=5||keydown!=0||double!=0{return Err(invalid())}
        for(index,name)in SESSION_TIMEZONE_STEPS.iter().enumerate(){let stage=&proof[*name];if stage["connectionId"]!=proof["baseline"]["connectionId"]||stage["sessionTimezone"]!=if index==1{"+08:00"}else{"+00:00"}||stage["systemTimezone"]!="UTC"||stage["autocommit"]!=true||stage["setFailed"]!=false||stage["uiActive"]!=false||stage["uiPendingAffected"]!=0||stage["epochText"]!=if index==1{"1709181296.123456"}else{"1709210096.123456"}{return Err(invalid())}}
        if proof["baseline"]["projectionSha256"]!=proof["restored"]["projectionSha256"]||proof["baseline"]["projectionSha256"]==proof["offset"]["projectionSha256"]{return Err(invalid())}
    }Ok(code=="NONE"&&all_checks)
}
fn text_green_native(snapshot:&Value,step:usize)->Result<(),AppError>{
    if step>=4{return Err(invalid())}for(method,success)in[("executeStatement",if step<2{2}else{3}),("commitTransaction",if step==3{2}else{1}),("applyEdits",if step<2{0}else{1}),("fetchCellValue",(step+1)as u64*2),("rollbackTransaction",0)]{if snapshot["methods"][method]["success"].as_u64().unwrap_or(0)!=success||snapshot["methods"][method]["failure"].as_u64().unwrap_or(0)!=0{return Err(invalid())}}
    if snapshot["text"]["lastObservedTransactionState"]!=json!({"active":step==2,"pendingAffected":if step==2{1}else{0}}){return Err(invalid())}
    if step<2{if !snapshot["text"]["lastApplyResult"].is_null(){return Err(invalid())}}else if snapshot["text"]["lastApplyResult"]!=json!({"ok":true,"affected":1,"inTransaction":true,"outcomeCount":1,"failedOutcomeCount":0,"errorClass":"none"}){return Err(invalid())}Ok(())
}
fn validate_text_report(report:&Value,run_id:&str)->Result<bool,AppError>{
    if serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384{return Err(invalid())}exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","proof","actions","elapsedMs","failureCode"])?;
    if report["schemaVersion"]!=1||text(report,"runId")?!=run_id||text(report,"phase")?!="grid-text"||text(report,"actionDriver")?!="native-dom-synthetic"{return Err(invalid())}
    const CHECKS:&[&str]=&["storage_marker","persisted_connection","credential_reconnect","fixture_created","table_open","preview_truncated","baseline_full","editor_full","local_edits","draft_full","apply_succeeded","uncommitted_transaction","applied_full","same_session_witness","normal_commit","committed_full","reloaded_exact_values","transaction_ended","json_integer_exact"];
    let checks=exact_fields(&report["checks"],CHECKS)?;if checks.values().any(|value|!value.is_boolean()){return Err(invalid())}let all_checks=checks.values().all(|value|value==&Value::Bool(true));let code=text(report,"failureCode")?;
    if !["NONE","ISOLATION","CONNECTION","SETUP","TREE","FULL_VALUE","EDIT","CHECKPOINT","BASELINE_MISMATCH","VALUE_LOSS","JSON_LOSS","PREVIEW","APPLY_FAILED","TRANSACTION_LOST","WITNESS_FAILED","COMMIT_FAILED","TIMEOUT","NATIVE_BRIDGE"].contains(&code)||(code=="NONE"&&!all_checks){return Err(invalid())}
    integer(&report["elapsedMs"],3600000)?;let actions=exact_fields(&report["actions"],&["click","input","keydown","dblclick"])?;let click=integer(&actions["click"],10000)?;let input=integer(&actions["input"],10000)?;let keydown=integer(&actions["keydown"],10000)?;let double=integer(&actions["dblclick"],10000)?;let proof=&report["proof"];
    if !proof.is_null(){
        exact_fields(proof,&["rowCount","editedColumns","baselineLongSha256","baselineJsonSha256","draftLongSha256","draftJsonSha256","appliedLongSha256","appliedJsonSha256","committedLongSha256","committedJsonSha256","baselineValuesSha256","draftValuesSha256","appliedValuesSha256","committedValuesSha256","uncommittedProjectionSha256","committedProjectionSha256","witnessConnectionId","uiActiveAfterApply","uiPendingAffectedAfterApply","dirtyRowsBeforeApply","dirtyRowsAfterApply","baselinePreview","appliedPreview","committedPreview"])?;
        if integer(&proof["rowCount"],1)?!=1||integer(&proof["editedColumns"],2)?!=2{return Err(invalid())}
        for name in ["baselineLongSha256","baselineJsonSha256","baselineValuesSha256"]{hash_string(&proof[name])?;}
        for name in ["draftLongSha256","draftJsonSha256","appliedLongSha256","appliedJsonSha256","committedLongSha256","committedJsonSha256","draftValuesSha256","appliedValuesSha256","committedValuesSha256","uncommittedProjectionSha256","committedProjectionSha256"]{if !proof[name].is_null(){hash_string(&proof[name])?;}}
        if !proof["witnessConnectionId"].is_null(){positive_connection_id(&proof["witnessConnectionId"])?;}if !proof["uiActiveAfterApply"].is_null()&&!proof["uiActiveAfterApply"].is_boolean(){return Err(invalid())}if !proof["uiPendingAffectedAfterApply"].is_null(){integer(&proof["uiPendingAffectedAfterApply"],1000)?;}for name in ["dirtyRowsBeforeApply","dirtyRowsAfterApply"]{if !proof[name].is_null(){integer(&proof[name],1)?;}}
        text_preview_pair(&proof["baselinePreview"],false)?;for name in ["appliedPreview","committedPreview"]{if !proof[name].is_null(){text_preview_pair(&proof[name],false)?;}}
    }
    if code=="NONE"{
        if proof.is_null()||proof.as_object().ok_or_else(invalid)?.values().any(Value::is_null)||click<30||input!=5||double!=3||keydown!=0{return Err(invalid())}
        for name in ["baselinePreview","appliedPreview","committedPreview"]{text_preview_pair(&proof[name],true)?;}
        if proof["baselinePreview"][0]["prefixCodePoints"].as_u64().ok_or_else(invalid)?>=1610||proof["appliedPreview"][0]["prefixCodePoints"].as_u64().ok_or_else(invalid)?>=1810||proof["committedPreview"][0]["prefixCodePoints"].as_u64().ok_or_else(invalid)?>=1810{return Err(invalid())}
        if proof["uiActiveAfterApply"]!=true||proof["uiPendingAffectedAfterApply"]!=1||proof["dirtyRowsBeforeApply"]!=1||proof["dirtyRowsAfterApply"]!=0{return Err(invalid())}
        if proof["draftLongSha256"]==proof["baselineLongSha256"]||proof["draftLongSha256"]!=proof["appliedLongSha256"]||proof["appliedLongSha256"]!=proof["committedLongSha256"]||proof["appliedJsonSha256"]==proof["baselineJsonSha256"]||proof["appliedJsonSha256"]!=proof["committedJsonSha256"]||proof["draftValuesSha256"]==proof["baselineValuesSha256"]||proof["appliedValuesSha256"]==proof["baselineValuesSha256"]||proof["appliedValuesSha256"]!=proof["committedValuesSha256"]||proof["uncommittedProjectionSha256"]!=proof["committedProjectionSha256"]{return Err(invalid())}
    }Ok(code=="NONE"&&all_checks)
}
fn validate_precision_report(report:&Value,run_id:&str)->Result<bool,AppError>{
    if serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384{return Err(invalid())}exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","proof","actions","elapsedMs","failureCode"])?;
    if report["schemaVersion"]!=1||text(report,"runId")?!=run_id||text(report,"phase")?!="grid-precision"||text(report,"actionDriver")?!="native-dom-synthetic"{return Err(invalid())}
    const CHECKS:&[&str]=&["storage_marker","persisted_connection","credential_reconnect","fixture_created","table_open","exact_baseline","editor_exact","local_edits","null_empty_distinct","apply_succeeded","uncommitted_transaction","same_session_witness","normal_commit","reloaded_exact_values","transaction_ended"];
    let checks=exact_fields(&report["checks"],CHECKS)?;if checks.values().any(|value|!value.is_boolean()){return Err(invalid())}let checked=|name:&str|checks[name]==true;let all_checks=checks.values().all(|value|value==&Value::Bool(true));let code=text(report,"failureCode")?;
    if !["NONE","ISOLATION","CONNECTION","SETUP","TREE","EDIT","CHECKPOINT","BASELINE_MISMATCH","VALUE_LOSS","NULL_EMPTY_LOST","APPLY_FAILED","TRANSACTION_LOST","WITNESS_FAILED","COMMIT_FAILED","TIMEOUT","NATIVE_BRIDGE"].contains(&code)||(code=="NONE"&&!all_checks){return Err(invalid())}
    integer(&report["elapsedMs"],3600000)?;let actions=exact_fields(&report["actions"],&["click","input","keydown","dblclick"])?;let click=integer(&actions["click"],10000)?;let input=integer(&actions["input"],10000)?;let keydown=integer(&actions["keydown"],10000)?;let double=integer(&actions["dblclick"],10000)?;let proof=&report["proof"];
    if proof.is_null(){if ["exact_baseline","local_edits","apply_succeeded","uncommitted_transaction","same_session_witness","normal_commit","reloaded_exact_values"].iter().any(|name|checked(name)){return Err(invalid())}}
    else{
        exact_fields(proof,&["rowCount","editedColumns","baselineRowsSha256","draftRowsSha256","appliedRowsSha256","committedRowsSha256","baselineProjectionSha256","uncommittedProjectionSha256","committedProjectionSha256","witnessConnectionId","uiActiveAfterApply","uiPendingAffectedAfterApply","dirtyRowsAfterApply","dirtyRowsBeforeApply"])?;
        if integer(&proof["rowCount"],1)?!=1||integer(&proof["editedColumns"],6)?!=6{return Err(invalid())}let baseline=hash_string(&proof["baselineRowsSha256"])?;let base_projection=hash_string(&proof["baselineProjectionSha256"])?;
        for name in ["draftRowsSha256","appliedRowsSha256","committedRowsSha256","uncommittedProjectionSha256","committedProjectionSha256"]{if !proof[name].is_null(){hash_string(&proof[name])?;}}
        if !proof["witnessConnectionId"].is_null(){positive_connection_id(&proof["witnessConnectionId"])?;}if !proof["uiActiveAfterApply"].is_null()&&!proof["uiActiveAfterApply"].is_boolean(){return Err(invalid())}if !proof["uiPendingAffectedAfterApply"].is_null(){integer(&proof["uiPendingAffectedAfterApply"],1000)?;}
        for name in ["dirtyRowsBeforeApply","dirtyRowsAfterApply"]{if !proof[name].is_null(){integer(&proof[name],1)?;}}
        if checked("local_edits")&&(proof["draftRowsSha256"].is_null()||proof["dirtyRowsBeforeApply"]!=1){return Err(invalid())}
        if checked("apply_succeeded")&&(proof["appliedRowsSha256"].is_null()||proof["dirtyRowsAfterApply"]!=0){return Err(invalid())}
        if checked("uncommitted_transaction")&&(proof["uiActiveAfterApply"]!=true||proof["uiPendingAffectedAfterApply"]!=1){return Err(invalid())}
        if checked("same_session_witness")&&(proof["witnessConnectionId"].is_null()||proof["uncommittedProjectionSha256"].is_null()){return Err(invalid())}
        if checked("normal_commit")&&(proof["committedRowsSha256"].is_null()||proof["committedProjectionSha256"].is_null()){return Err(invalid())}
        if checked("reloaded_exact_values"){
            if proof["draftRowsSha256"].is_null()||proof["appliedRowsSha256"].is_null()||proof["committedRowsSha256"].is_null()||proof["uncommittedProjectionSha256"].is_null()||proof["committedProjectionSha256"].is_null(){return Err(invalid())}
            if hash_string(&proof["draftRowsSha256"])?==baseline||proof["draftRowsSha256"]!=proof["appliedRowsSha256"]||proof["appliedRowsSha256"]!=proof["committedRowsSha256"]||hash_string(&proof["uncommittedProjectionSha256"])?==base_projection||proof["uncommittedProjectionSha256"]!=proof["committedProjectionSha256"]{return Err(invalid())}
        }
    }
    if code=="NONE"&&(proof.is_null()||click<20||input!=8||double!=7||keydown!=0){return Err(invalid())}Ok(code=="NONE"&&all_checks)
}
fn validate_timeout_report(report:&Value,run_id:&str)->Result<bool,AppError>{
    if serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384{return Err(invalid())}exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","proof","actions","elapsedMs","failureCode"])?;
    if report["schemaVersion"]!=1||text(report,"runId")?!=run_id||text(report,"phase")?!="grid-timeout"||text(report,"actionDriver")?!="native-dom-synthetic"{return Err(invalid())}
    const CHECKS:&[&str]=&["storage_marker","persisted_connection","credential_reconnect","fixture_created","table_open","marker_applied","session_settings","actor_held","local_draft","original_1205","transaction_preserved","draft_preserved","same_session_witness","rollback_cancel_preserved","normal_rollback","reloaded_baseline"];
    let checks=exact_fields(&report["checks"],CHECKS)?;if checks.values().any(|value|!value.is_boolean()){return Err(invalid())}let checked=|name:&str|checks[name]==true;let all_checks=checks.values().all(|value|value==&Value::Bool(true));let code=text(report,"failureCode")?;
    if !["NONE","ISOLATION","CONNECTION","SETUP","TREE","EDIT","CHECKPOINT","SESSION_SETTINGS","MYSQL_ERROR_DETAILS_LOST","TRANSACTION_LOST","DRAFT_LOST","WITNESS_FAILED","RECOVERY","TIMEOUT","DOM_FAILED","NATIVE_BRIDGE"].contains(&code)||(code=="NONE"&&!all_checks){return Err(invalid())}
    integer(&report["elapsedMs"],3600000)?;let actions=exact_fields(&report["actions"],&["click","input","keydown","dblclick"])?;let click=integer(&actions["click"],10000)?;let input=integer(&actions["input"],10000)?;let keydown=integer(&actions["keydown"],10000)?;let double=integer(&actions["dblclick"],10000)?;let proof=&report["proof"];
    if proof.is_null(){if ["marker_applied","session_settings","original_1205","transaction_preserved","draft_preserved","same_session_witness","normal_rollback","reloaded_baseline"].iter().any(|name|checked(name)){return Err(invalid())}}
    else{
        exact_fields(proof,&["rowCount","baselineRowsSha256","markerRowsSha256","faultRowsSha256","restoredRowsSha256","uiActiveAfterError","uiPendingAffectedAfterError","dirtyRowsAfterError","originalErrorClass","witnessConnectionId","markerValueAfterError","markerValueAfterRollback","sessionTimeoutSeconds","rollbackOnTimeout"])?;
        if integer(&proof["rowCount"],4)?!=4{return Err(invalid())}let baseline=hash_string(&proof["baselineRowsSha256"])?;let marker=hash_string(&proof["markerRowsSha256"])?;
        for name in ["faultRowsSha256","restoredRowsSha256"]{if !proof[name].is_null(){hash_string(&proof[name])?;}}
        if !proof["uiActiveAfterError"].is_null()&&!proof["uiActiveAfterError"].is_boolean(){return Err(invalid())}if !proof["uiPendingAffectedAfterError"].is_null(){integer(&proof["uiPendingAffectedAfterError"],1000)?;}if !proof["dirtyRowsAfterError"].is_null(){integer(&proof["dirtyRowsAfterError"],1)?;}
        if !proof["originalErrorClass"].is_null()&&!["1205","other"].contains(&text(proof,"originalErrorClass")?){return Err(invalid())}if !proof["witnessConnectionId"].is_null(){positive_connection_id(&proof["witnessConnectionId"])?;}
        for name in ["markerValueAfterError","markerValueAfterRollback"]{if !proof[name].is_null()&&![0,7].contains(&integer(&proof[name],7)?){return Err(invalid())}}
        if !proof["sessionTimeoutSeconds"].is_null()&&integer(&proof["sessionTimeoutSeconds"],3600)?==0{return Err(invalid())}if !proof["rollbackOnTimeout"].is_null()&&!proof["rollbackOnTimeout"].is_boolean(){return Err(invalid())}
        if checked("marker_applied")&&baseline==marker{return Err(invalid())}if checked("session_settings")&&(proof["sessionTimeoutSeconds"]!=5||proof["rollbackOnTimeout"]!=false){return Err(invalid())}
        if checked("original_1205")&&proof["originalErrorClass"]!="1205"{return Err(invalid())}if checked("transaction_preserved")&&(proof["uiActiveAfterError"]!=true||proof["uiPendingAffectedAfterError"]!=1){return Err(invalid())}
        if checked("draft_preserved")&&(proof["dirtyRowsAfterError"]!=1||proof["faultRowsSha256"].is_null()){return Err(invalid())}if checked("same_session_witness")&&(proof["witnessConnectionId"].is_null()||proof["markerValueAfterError"]!=7){return Err(invalid())}if checked("normal_rollback")&&proof["markerValueAfterRollback"]!=0{return Err(invalid())}
        if checked("reloaded_baseline")&&(proof["restoredRowsSha256"].is_null()||hash_string(&proof["restoredRowsSha256"])?!=baseline){return Err(invalid())}
    }
    if code=="NONE"&&(proof.is_null()||click<16||input!=6||double!=3||keydown!=0){return Err(invalid())}Ok(code=="NONE"&&all_checks)
}
fn validate_duplicate_report(report:&Value,run_id:&str)->Result<bool,AppError> {
    if serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384{return Err(invalid())}
    exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","proof","actions","elapsedMs","failureCode"])?;
    if report["schemaVersion"]!=1||text(report,"runId")?!=run_id||text(report,"phase")?!="grid-duplicate"||text(report,"actionDriver")?!="native-dom-synthetic"{return Err(invalid())}
    const CHECKS:&[&str]=&["storage_marker","persisted_connection","credential_reconnect","fixture_created","table_open","marker_applied","local_draft","original_1062","transaction_preserved","draft_preserved","same_session_witness","rollback_cancel_preserved","normal_rollback","reloaded_baseline"];
    let checks=exact_fields(&report["checks"],CHECKS)?;if checks.values().any(|value|!value.is_boolean()){return Err(invalid())}
    let checked=|name:&str|checks[name]==true;let all_checks=checks.values().all(|value|value==&Value::Bool(true));let code=text(report,"failureCode")?;
    if !["NONE","ISOLATION","CONNECTION","SETUP","TREE","EDIT","CHECKPOINT","MYSQL_ERROR_DETAILS_LOST","TRANSACTION_LOST","DRAFT_LOST","WITNESS_FAILED","RECOVERY","TIMEOUT","DOM_FAILED","NATIVE_BRIDGE"].contains(&code)||(code=="NONE"&&!all_checks){return Err(invalid())}
    integer(&report["elapsedMs"],3600000)?;let actions=exact_fields(&report["actions"],&["click","input","keydown","dblclick"])?;
    let click=integer(&actions["click"],10000)?;let input=integer(&actions["input"],10000)?;let keydown=integer(&actions["keydown"],10000)?;let double=integer(&actions["dblclick"],10000)?;
    let proof=&report["proof"];
    if proof.is_null(){if ["marker_applied","original_1062","transaction_preserved","draft_preserved","same_session_witness","normal_rollback","reloaded_baseline"].iter().any(|name|checked(name)){return Err(invalid())}}
    else{
        exact_fields(proof,&["rowCount","baselineRowsSha256","markerRowsSha256","faultRowsSha256","restoredRowsSha256","uiActiveAfterError","uiPendingAffectedAfterError","dirtyRowsAfterError","originalErrorClass","witnessConnectionId","markerValueAfterError","markerValueAfterRollback"])?;
        if integer(&proof["rowCount"],4)?!=4{return Err(invalid())}
        let baseline=hash_string(&proof["baselineRowsSha256"])?;let marker=hash_string(&proof["markerRowsSha256"])?;
        for name in ["faultRowsSha256","restoredRowsSha256"]{if !proof[name].is_null(){hash_string(&proof[name])?;}}
        if !proof["uiActiveAfterError"].is_null()&&!proof["uiActiveAfterError"].is_boolean(){return Err(invalid())}
        if !proof["uiPendingAffectedAfterError"].is_null(){integer(&proof["uiPendingAffectedAfterError"],1000)?;}
        if !proof["dirtyRowsAfterError"].is_null(){integer(&proof["dirtyRowsAfterError"],1)?;}
        if !proof["originalErrorClass"].is_null()&&!["1062","other"].contains(&text(proof,"originalErrorClass")?){return Err(invalid())}
        if !proof["witnessConnectionId"].is_null(){positive_connection_id(&proof["witnessConnectionId"])?;}
        for name in ["markerValueAfterError","markerValueAfterRollback"]{if !proof[name].is_null()&&![0,7].contains(&integer(&proof[name],7)?){return Err(invalid())}}
        if checked("marker_applied")&&baseline==marker{return Err(invalid())}
        if checked("original_1062")&&proof["originalErrorClass"]!="1062"{return Err(invalid())}
        if checked("transaction_preserved")&&(proof["uiActiveAfterError"]!=true||proof["uiPendingAffectedAfterError"]!=1){return Err(invalid())}
        if checked("draft_preserved")&&(proof["dirtyRowsAfterError"]!=1||proof["faultRowsSha256"].is_null()){return Err(invalid())}
        if checked("same_session_witness")&&(proof["witnessConnectionId"].is_null()||proof["markerValueAfterError"]!=7){return Err(invalid())}
        if checked("normal_rollback")&&proof["markerValueAfterRollback"]!=0{return Err(invalid())}
        if checked("reloaded_baseline")&&(proof["restoredRowsSha256"].is_null()||hash_string(&proof["restoredRowsSha256"])?!=baseline){return Err(invalid())}
    }
    if code=="NONE"&&(proof.is_null()||click<14||input<5||double<3||keydown!=0){return Err(invalid())}
    Ok(code=="NONE"&&all_checks)
}
fn validate_deadlock_report(report:&Value,run_id:&str)->Result<bool,AppError> {
    if serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384{return Err(invalid())}
    exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","proof","actions","elapsedMs","failureCode"])?;
    if report["schemaVersion"]!=1||text(report,"runId")?!=run_id||text(report,"phase")?!="grid-deadlock"||text(report,"actionDriver")?!="native-dom-synthetic"{return Err(invalid())}
    const CHECKS:&[&str]=&["storage_marker","persisted_connection","credential_reconnect","fixture_created","table_open","marker_applied","actor_waited","local_draft","original_1213","transaction_state_correct","draft_preserved","rollback_notice","recovery_guard_cancel","reloaded_baseline"];
    let checks=exact_fields(&report["checks"],CHECKS)?;if checks.values().any(|value|!value.is_boolean()){return Err(invalid())}
    let checked=|name:&str|checks[name]==true;let all_checks=checks.values().all(|value|value==&Value::Bool(true));
    let code=text(report,"failureCode")?;
    if !["NONE","ISOLATION","CONNECTION","SETUP","TREE","EDIT","CHECKPOINT","DEADLOCK_NOT_OBSERVED","MYSQL_ERROR_DETAILS_LOST","DEADLOCK_TX_STATE_STALE","ROLLBACK_NOTICE_MISSING","RECOVERY","TIMEOUT","DOM_FAILED","NATIVE_BRIDGE"].contains(&code)||(code=="NONE"&&!all_checks){return Err(invalid())}
    integer(&report["elapsedMs"],3600000)?;let actions=exact_fields(&report["actions"],&["click","input","keydown","dblclick"])?;
    let click=integer(&actions["click"],10000)?;let input=integer(&actions["input"],10000)?;let keydown=integer(&actions["keydown"],10000)?;let double=integer(&actions["dblclick"],10000)?;
    let proof=&report["proof"];
    if proof.is_null(){
        if ["marker_applied","original_1213","transaction_state_correct","draft_preserved","recovery_guard_cancel","reloaded_baseline"].iter().any(|name|checked(name)){return Err(invalid())}
    }else{
        exact_fields(proof,&["rowCount","baselineRowsSha256","markerRowsSha256","faultRowsSha256","reloadedRowsSha256","uiActiveAfterError","uiPendingAffectedAfterError","dirtyRowsAfterError","originalErrorClass"])?;
        if integer(&proof["rowCount"],132)?!=132{return Err(invalid())}
        let baseline=hash_string(&proof["baselineRowsSha256"])?;let marker=hash_string(&proof["markerRowsSha256"])?;
        for name in ["faultRowsSha256","reloadedRowsSha256"]{if !proof[name].is_null(){hash_string(&proof[name])?;}}
        if !proof["uiActiveAfterError"].is_null()&&!proof["uiActiveAfterError"].is_boolean(){return Err(invalid())}
        if !proof["uiPendingAffectedAfterError"].is_null(){integer(&proof["uiPendingAffectedAfterError"],1000)?;}
        if !proof["dirtyRowsAfterError"].is_null(){integer(&proof["dirtyRowsAfterError"],1)?;}
        if !proof["originalErrorClass"].is_null()&&! ["1213","1305","other"].contains(&text(proof,"originalErrorClass")?){return Err(invalid())}
        if checked("marker_applied")&&baseline==marker{return Err(invalid())}
        if checked("original_1213")&&proof["originalErrorClass"]!="1213"{return Err(invalid())}
        if checked("transaction_state_correct")&&(proof["uiActiveAfterError"]!=false||proof["uiPendingAffectedAfterError"]!=0){return Err(invalid())}
        if checked("draft_preserved")&&(proof["dirtyRowsAfterError"]!=1||proof["faultRowsSha256"].is_null()){return Err(invalid())}
        if checked("reloaded_baseline")&&(proof["reloadedRowsSha256"].is_null()||hash_string(&proof["reloadedRowsSha256"])?!=baseline){return Err(invalid())}
    }
    if code=="NONE"&&(proof.is_null()||click<12||input!=4||keydown!=0||double!=3){return Err(invalid())}
    Ok(code=="NONE"&&all_checks)
}
fn validate_commit_report(report:&Value,run_id:&str)->Result<bool,AppError> {
    if serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384 {return Err(invalid())}
    exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","row","actions","elapsedMs","failureCode"])?;
    if report["schemaVersion"]!=1 || text(report,"runId")?!=run_id || text(report,"phase")?!="commit" || text(report,"actionDriver")?!="native-dom-synthetic" {return Err(invalid())}
    const CHECKS:&[&str]=&["storage_marker","persisted_connection","credential_reconnect","table_created","baseline_committed","baseline_observed","pending_visible","pending_isolated","commit_clicked","result_refreshed","committed_observed","nontransactional"];
    let checks=exact_fields(&report["checks"],CHECKS)?;
    if checks.values().any(|value|!value.is_boolean()) {return Err(invalid())}
    let checked=|name:&str|checks[name]==true;
    let all_checks=checks.values().all(|value|value==&Value::Bool(true));
    let code=text(report,"failureCode")?;
    if !["NONE","ISOLATION","CONNECTION","QUERY","TIMEOUT","DOM_FAILED","NATIVE_BRIDGE","CHECKPOINT","COMMIT"].contains(&code) || (code=="NONE"&&!all_checks) {return Err(invalid())}
    integer(&report["elapsedMs"],3600000)?;
    let actions=exact_fields(&report["actions"],&["click","input","keydown"])?;
    let click=integer(&actions["click"],10000)?;let input=integer(&actions["input"],10000)?;let keydown=integer(&actions["keydown"],10000)?;
    let row=&report["row"];
    if row.is_null() {
        if ["baseline_observed","pending_visible","pending_isolated","result_refreshed","committed_observed"].iter().any(|name|checked(name)) {return Err(invalid())}
    }else{
        exact_fields(row,&["id","baselineSha256","pendingSha256","committedSha256"])?;
        if integer(&row["id"],1)?!=1 {return Err(invalid())}
        let baseline=hash_string(&row["baselineSha256"])?;
        for name in ["pendingSha256","committedSha256"] {if !row[name].is_null(){hash_string(&row[name])?;}}
        if checked("pending_visible")||checked("pending_isolated") {
            if row["pendingSha256"].is_null()||hash_string(&row["pendingSha256"])?==baseline {return Err(invalid())}
        }
        if checked("result_refreshed")||checked("committed_observed") {
            if row["pendingSha256"].is_null()||row["committedSha256"].is_null()||hash_string(&row["committedSha256"])?!=hash_string(&row["pendingSha256"])?||hash_string(&row["pendingSha256"])?==baseline {return Err(invalid())}
        }
    }
    if code=="NONE" && (row.is_null()||click<8||input!=5||keydown!=0) {return Err(invalid())}
    Ok(code=="NONE"&&all_checks)
}
fn validate_explain_report(report:&Value,run_id:&str)->Result<bool,AppError> {
    if serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384 {return Err(invalid())}
    exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","plan","actions","elapsedMs","failureCode"])?;
    if report["schemaVersion"]!=1 || text(report,"runId")?!=run_id || text(report,"phase")?!="explain" || text(report,"actionDriver")?!="native-dom-synthetic" {return Err(invalid())}
    const CHECKS:&[&str]=&["storage_marker","persisted_connection","credential_reconnect","query_result","explain_open","plan_content","plan_refresh","return_results","nontransactional"];
    let checks=exact_fields(&report["checks"],CHECKS)?;
    if checks.values().any(|value|!value.is_boolean()) {return Err(invalid())}
    let checked=|name:&str|checks[name]==true;
    let all_checks=checks.values().all(|value|value==&Value::Bool(true));
    let code=text(report,"failureCode")?;
    if !["NONE","ISOLATION","CONNECTION","QUERY","TIMEOUT","DOM_FAILED","NATIVE_BRIDGE"].contains(&code) || (code=="NONE"&&!all_checks) {return Err(invalid())}
    integer(&report["elapsedMs"],3600000)?;
    let actions=exact_fields(&report["actions"],&["click","input","keydown"])?;
    let click=integer(&actions["click"],10000)?;let input=integer(&actions["input"],10000)?;
    let keydown=integer(&actions["keydown"],10000)?;
    let plan=&report["plan"];
    if plan.is_null() {
        if checked("plan_content")||checked("plan_refresh") {return Err(invalid())}
    }else{
        exact_fields(plan,&["rowCount","columnCount","firstPlanSha256","refreshedPlanSha256","executedSqlSha256"])?;
        if integer(&plan["rowCount"],1)?!=1 || integer(&plan["columnCount"],12)?!=12 {return Err(invalid())}
        let first=hash_string(&plan["firstPlanSha256"])?;
        hash_string(&plan["executedSqlSha256"])?;
        if !plan["refreshedPlanSha256"].is_null() {hash_string(&plan["refreshedPlanSha256"])?;}
        if checked("plan_refresh") && (plan["refreshedPlanSha256"].is_null() || hash_string(&plan["refreshedPlanSha256"])?!=first) {return Err(invalid())}
    }
    if code=="NONE" && (plan.is_null()||click<5||input<1||keydown!=0) {return Err(invalid())}
    Ok(code=="NONE"&&all_checks)
}
fn validate_restart_report(report:&Value,run_id:&str)->Result<bool,AppError> {
    if serde_json::to_vec(report).map_err(|_|invalid())?.len()>16384 {return Err(invalid())}
    exact_fields(report,&["schemaVersion","runId","phase","actionDriver","checks","row","actions","elapsedMs","failureCode"])?;
    if report["schemaVersion"]!=1 || text(report,"runId")?!=run_id || text(report,"phase")?!="restart" || text(report,"actionDriver")?!="native-dom-synthetic" {return Err(invalid())}
    const CHECKS:&[&str]=&["storage_marker","persisted_connection","credential_reconnect","sql_select41","table_open","local_edit","dirty_guard_cancel","applied_pending","rollback_restored"];
    let checks=exact_fields(&report["checks"],CHECKS)?;
    if checks.values().any(|value|!value.is_boolean()) {return Err(invalid())}
    let checked=|name:&str| checks[name]==true;
    let all_checks=checks.values().all(|value|value==&Value::Bool(true));
    let code=text(report,"failureCode")?;
    if !["NONE","ISOLATION","CONNECTION","QUERY","TREE","EDIT","ROLLBACK","TIMEOUT","DOM_FAILED","NATIVE_BRIDGE"].contains(&code) || (code=="NONE"&&!all_checks) {return Err(invalid())}
    elapsed(&report["elapsedMs"])?;
    let actions=exact_fields(&report["actions"],&["click","input","keydown","dblclick"])?;
    for count in actions.values() {integer(count,10000)?;}
    let row=&report["row"];
    if row.is_null() {
        if ["local_edit","dirty_guard_cancel","applied_pending","rollback_restored"].iter().any(|name|checked(name)) {return Err(invalid())}
    } else {
        exact_fields(row,&["id","beforeSha256","localSha256","appliedSha256","rolledBackSha256"])?;
        if row["id"]!=1 {return Err(invalid())}
        let before=hash_string(&row["beforeSha256"])?;let local=hash_string(&row["localSha256"])?;
        for name in ["appliedSha256","rolledBackSha256"] {if !row[name].is_null(){hash_string(&row[name])?;}}
        if (checked("local_edit")||checked("dirty_guard_cancel")) && before==local {return Err(invalid())}
        if checked("applied_pending") && (row["appliedSha256"].is_null()||hash_string(&row["appliedSha256"])?!=local) {return Err(invalid())}
        if checked("rollback_restored") && (row["rolledBackSha256"].is_null()||hash_string(&row["rolledBackSha256"])?!=before) {return Err(invalid())}
    }
    // Observe only. The runner must independently verify fresh keyring hits/zero sets and DB rollback.
    Ok(code=="NONE"&&all_checks)
}

pub struct AcceptanceSecrets { namespace:String, gets:AtomicU64, hits:AtomicU64, sets:AtomicU64, startup_trace:Option<Arc<Mutex<Option<StartupTrace>>>>, capture_platform_status:bool }
impl AcceptanceSecrets {
    pub fn new(run:&AcceptanceRun)->Self { Self{namespace:run.namespace(),gets:AtomicU64::new(0),hits:AtomicU64::new(0),sets:AtomicU64::new(0),startup_trace:if ["initial","restart-attempt","explain","commit","grid-deadlock","grid-duplicate","grid-timeout","grid-precision","grid-text","session-timezone","grid-time","grid-time-crosszone","grid-bit-blob"].contains(&run.phase.as_str()) {Some(run.startup_trace.clone())}else{None},capture_platform_status:run.phase=="initial"} }
    fn trace_get(&self,stage:&str) {
        if let Some(sink)=&self.startup_trace {
            if let Ok(mut guard)=sink.lock() {if let Some(trace)=guard.as_mut() {let _=trace.append(stage,"none");}}
        }
    }
    // Best-effort set diagnostics only; a trace write failure can never change the set result.
    fn trace_set(&self,stage:&str,class:&str) {
        if let Some(sink)=&self.startup_trace {
            if let Ok(mut guard)=sink.lock() {if let Some(trace)=guard.as_mut() {let _=trace.append(stage,class);}}
        }
    }
    fn entry(&self,key:&str)->Result<keyring::Entry,AppError> { self.checked_entry(key).map_err(|(error,_)|error) }
    // Minimal checked-entry helper that only preserves the reached stage and a static failure class; get keeps the old storage_error mapping.
    fn checked_entry(&self,key:&str)->Result<keyring::Entry,(AppError,&'static str)> {
        if key.is_empty() || key.len()>200 || !key.bytes().all(|b|b.is_ascii_alphanumeric() || b"-_:".contains(&b)) {return Err((storage_error(),"key_rejected"))}
        keyring::Entry::new(&self.namespace,key).map_err(|error|(storage_error(),Self::entry_init_class(&error)))
    }
    // Static classes from public keyring variants only; never format Display/Debug/source or any payload.
    fn entry_init_class(error:&keyring::Error)->&'static str {
        match error {keyring::Error::NoStorageAccess(_)=>"entry_init_no_storage_access",keyring::Error::PlatformFailure(_)=>"entry_init_platform_failure",_=>"entry_init_other"}
    }
    fn password_write_class(error:&keyring::Error)->&'static str {
        match error {keyring::Error::NoStorageAccess(_)=>"password_write_no_storage_access",keyring::Error::PlatformFailure(_)=>"password_write_platform_failure",_=>"password_write_other"}
    }
    fn set_stages(&self,key:&str,value:&SecretMap)->Result<(),(AppError,&'static str,Option<keyring::Error>)> {
        let encoded=serde_json::to_string(value).map_err(|_|(storage_error(),"serialize_failed",None))?;
        let entry=self.checked_entry(key).map_err(|(error,class)|(error,class,None))?;
        entry.set_password(&encoded).map_err(|error|{let class=Self::password_write_class(&error);(storage_error(),class,Some(error))})?;
        Ok(())
    }
    // Best-effort typed OSStatus observation for the initial phase only; the underlying error is never formatted.
    fn trace_platform_osstatus(&self,error:&keyring::Error) {
        if !self.capture_platform_status {return;}
        let Some(code)=platform_os_status(error) else {return};
        let method=code.to_string();
        if let Some(sink)=&self.startup_trace {
            if let Ok(mut guard)=sink.lock() {if let Some(trace)=guard.as_mut() {let _=trace.append(KEYRING_OSSTATUS_STAGE,&method);}}
        }
    }
}
impl SecretStore for AcceptanceSecrets {
    fn get(&self,key:&str)->Result<Option<SecretMap>,AppError> {
        self.gets.fetch_add(1,Ordering::Relaxed);
        self.trace_get("keyring_get_enter");
        let result=(|| {
            match self.entry(key)?.get_password() {
                Ok(encoded)=>{let value=serde_json::from_str(&encoded).map_err(|_|storage_error())?;self.hits.fetch_add(1,Ordering::Relaxed);Ok(Some(value))},
                Err(keyring::Error::NoEntry)=>Ok(None),Err(_)=>Err(storage_error())
            }
        })();
        self.trace_get(if result.is_ok(){"keyring_get_returned"}else{"keyring_get_failed"});
        result
    }
    fn set(&self,key:&str,value:&SecretMap)->Result<(),AppError> {
        self.trace_set("keyring_set_enter","none");
        match self.set_stages(key,value) {
            Ok(())=>{self.sets.fetch_add(1,Ordering::Relaxed);self.trace_set("keyring_set_returned","none");Ok(())}
            Err((error,class,source))=>{self.trace_set("keyring_set_failed",class);if let Some(source)=source {self.trace_platform_osstatus(&source);} Err(error)}
        }
    }
    fn remove(&self,_:&str)->Result<(),AppError> {Err(AppError::unsupported("本轮合成系统凭据只创建保留，不执行删除"))}
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture_with_secret(run:&str,secret:&[u8],mutate:impl FnOnce(&mut Value))->(PathBuf,PathBuf,PathBuf,PathBuf) {
        let nonce=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let repo=std::env::temp_dir().join(format!("mysql-host-negative-{}-{nonce}",std::process::id()));
        create_private_dir(&repo).unwrap();create_private_dir(&repo.join("backups")).unwrap();
        let temp=repo.join("temp");create_private_dir(&temp).unwrap();
        let fixture=repo.join("backups").join(format!("mysql-parity-fixture-{run}"));create_private_dir(&fixture).unwrap();
        let root=temp.join(format!("dbstudio-mysql-acceptance-{run}"));let manifest=fixture.join("manifest.ready.json");
        let mut options=OpenOptions::new();options.create_new(true).write(true);
        #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
        options.open(fixture.join("app.secret")).unwrap().write_all(secret).unwrap();
        let mut content=json!({"schemaVersion":1,"ready":true,"runId":run,"hostRoot":root,"fixtureRoot":fixture,"host":"127.0.0.1","port":3306,"database":"synthetic","app":{"user":"fixture_app","secretFilePath":fixture.join("app.secret")}});
        mutate(&mut content);
        create_private_json(&manifest,&content).unwrap();
        (repo,temp,root,manifest)
    }
    fn fixture_with(run:&str,mutate:impl FnOnce(&mut Value))->(PathBuf,PathBuf,PathBuf,PathBuf) {fixture_with_secret(run,b"synthetic-password\n",mutate)}
    fn fixture(run:&str)->(PathBuf,PathBuf,PathBuf,PathBuf) { fixture_with(run, |_| {}) }
    const RUN:&str="1234567890abcdef1234567890abcdef";
    fn successful_report()->Value {
        let page=|offset,first,last|json!({"offset":offset,"count":200,"firstId":first,"lastId":last,"idsSha256":"a".repeat(64),"visibleMs":1.25});
        json!({"schemaVersion":1,"runId":RUN,"phase":"initial","actionDriver":"native-dom-synthetic",
            "checks":{"storage_preflight":true,"connection_form":true,"sql_select41":true,"page_first":true,"page_next":true,"page_back":true},
            "pages":{"first":page(0,1,200),"next":page(200,201,400),"back":page(0,1,200)},
            "actions":{"click":7,"input":9,"keydown":0},"elapsedMs":100.5,"failureCode":"NONE"})
    }
    fn time_fixture()->AcceptanceRun{let(repo,temp,root,manifest)=fixture(RUN);AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();AcceptanceRun::prepare(root,RUN.into(),"grid-time".into(),manifest,&temp,&repo).unwrap()}
    fn time_stage_payload(step:usize)->Value{json!({"values":time_expected_values(step>0),"columnTypes":["integer","date","date","date","text","text"],"valuesSha256":if step==0{"a".repeat(64)}else{"b".repeat(64)},"witnessConnectionId":123,"witnessProjection":time_expected_projection(step>=2),"witnessProjectionSha256":if step<2{"c".repeat(64)}else{"d".repeat(64)},"uiActive":step==2,"uiPendingAffected":if step==2{1}else{0},"dirtyRows":if step==1{1}else{0}})}
    fn time_payload_from_stage(step:usize,stage:&Value)->Value{json!({"schemaVersion":1,"step":TIME_STEPS[step],"uiActive":stage["uiActive"],"uiPendingAffected":stage["uiPendingAffected"],"dirtyRows":stage["dirtyRows"],"valuesSha256":stage["valuesSha256"],"witnessConnectionId":stage["witnessConnectionId"],"witnessProjectionSha256":stage["witnessProjectionSha256"]})}
    fn time_payload(step:usize)->Value{time_payload_from_stage(step,&time_stage_payload(step))}
    fn time_continue_payload(step:usize)->Value{json!({"schemaVersion":1,"step":TIME_STEPS[step]})}
    fn time_ack(run:&AcceptanceRun,step:usize,payload:&Value,verified:bool)->Value{json!({"schemaVersion":1,"runId":run.run_id,"phase":"grid-time","pid":std::process::id(),"step":TIME_STEPS[step],"proof":payload,"verified":verified})}
    fn time_editor_originals()->Value{let values=time_expected_values(false);let originals:Vec<_>=values.as_array().unwrap().iter().skip(1).map(|value|json!({"raw":value,"isNull":false,"valueDisabled":false,"nullDisabled":false})).collect();json!(originals)}
    fn mock_time_stage(run:&AcceptanceRun,step:usize){
        if step==0{for _ in 0..4{run.record("executeStatement",true,0);}run.record("commitTransaction",true,0);}
        if step==2{run.record("executeStatement",true,0);run.record("applyEdits",true,0);run.record_time_result("applyEdits",&Ok(json!({"ok":true,"affected":1,"inTransaction":true,"outcomes":[{"error":null,"sql":"synthetic-template-not-retained"}]})));}
        if step==3{run.record("commitTransaction",true,0);}run.record_time_result("transactionState",&Ok(json!({"active":step==2,"pendingAffected":if step==2{1}else{0}})));
    }
    fn successful_time_report()->Value{json!({"schemaVersion":1,"runId":RUN,"phase":"grid-time","actionDriver":"native-dom-synthetic","checks":{"storage_marker":true,"persisted_connection":true,"credential_reconnect":true,"fixture_created":true,"session_utc_verified":true,"table_open":true,"baseline_exact":true,"editor_raw_exact":true,"local_edits":true,"apply_succeeded":true,"uncommitted_transaction":true,"same_session_witness":true,"normal_commit":true,"reloaded_exact_values":true,"transaction_ended":true,"temporal_types":true},"proof":{"rowCount":1,"columnCount":5,"editorOriginals":time_editor_originals(),"stages":{"baseline":time_stage_payload(0),"draft":time_stage_payload(1),"applied":time_stage_payload(2),"committed":time_stage_payload(3)}},"actions":{"click":12,"input":10,"keydown":0,"dblclick":6},"elapsedMs":600,"failureCode":"NONE"})}
    #[test] fn mysql_host_time_phase_password_origin_and_snapshot_scope(){
        let(repo,temp,root,manifest)=fixture(RUN);assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"grid-time".into(),manifest.clone(),&temp,&repo).is_err());let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();assert!(initial.time_checkpoint(&time_payload(0),&AcceptanceSecrets::new(&initial)).is_err());assert!(initial.time_continue(&time_continue_payload(0)).is_err());initial.record_time_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));assert!(initial.snapshot(&AcceptanceSecrets::new(&initial)).unwrap().get("temporal").is_none());
        let mut run=AcceptanceRun::prepare(root,RUN.into(),"grid-time".into(),manifest,&temp,&repo).unwrap();run.app_secret=repo.join("missing-not-read.secret");assert_eq!(run.password_script().unwrap_err().code,"unsupported");assert_eq!(run.context()["phase"],"grid-time");assert_eq!(run.store_id,initial.store_id);assert_eq!(run.namespace(),initial.namespace());let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert!(exact_fields(&snapshot["temporal"],&["lastApplyResult","lastObservedTransactionState"]).is_ok());assert!(snapshot["temporal"]["lastApplyResult"].is_null());let mut probe=initial;probe.phase="restart-probe".into();for method in ["mysqlAcceptanceTimeCheckpoint","mysqlAcceptanceTimeContinue"]{assert!(!probe.probe_method_allowed(method));}assert!(!bridge_window_allowed("other","tauri://localhost/"));
    }
    #[test] fn mysql_host_time_payload_baseline_state_and_positive_witness(){
        for step in 0..4{assert_eq!(time_step(&time_payload(step),true).unwrap(),step);assert_eq!(time_step(&time_continue_payload(step),false).unwrap(),step);}for(key,value)in[("uiActive",json!(true)),("uiPendingAffected",json!(1)),("dirtyRows",json!(1)),("extra",json!(1))]{let mut payload=time_payload(0);payload[key]=value;assert!(time_step(&payload,true).is_err());}
        for step in 1..4{let mut partial=time_payload(step);partial["uiActive"]=json!(true);partial["uiPendingAffected"]=json!(1000);partial["dirtyRows"]=json!(1000);partial["valuesSha256"]=json!("e".repeat(64));assert!(time_step(&partial,true).is_ok());}let mut payload=time_payload(0);payload["valuesSha256"]=json!("e".repeat(64));assert!(time_step(&payload,true).is_ok());payload["witnessConnectionId"]=Value::Null;assert!(time_step(&payload,true).is_err());
    }
    #[test] fn mysql_host_time_four_step_idempotency_wrapper_and_ack_equality(){
        let run=time_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.time_checkpoint(&time_payload(1),&secrets).is_err());run.time_checkpoint(&time_payload(0),&secrets).unwrap();run.time_checkpoint(&time_payload(0),&secrets).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::TimeCheckpoint,0).unwrap();assert!(exact_fields(&read_private_json(&path).unwrap(),&["schemaVersion","runId","phase","pid","report","observations"]).is_ok());let mut changed=time_payload(0);changed["valuesSha256"]=json!("e".repeat(64));assert!(run.time_checkpoint(&changed,&secrets).is_err());assert_eq!(run.time_continue(&time_continue_payload(0)).unwrap(),json!({"ready":false,"verified":false}));publish_commit_json(&run.root,CommitFile::TimeAck,0,&time_ack(&run,0,&time_payload(0),false)).unwrap();assert_eq!(run.time_continue(&time_continue_payload(0)).unwrap(),json!({"ready":true,"verified":false}));assert!(run.time_checkpoint(&time_payload(1),&secrets).is_err());
        for wrong in [true,false]{let run=time_fixture();let payload=time_payload(0);run.time_checkpoint(&payload,&AcceptanceSecrets::new(&run)).unwrap();let mut ack=time_ack(&run,0,&payload,true);if wrong{ack["proof"]["witnessConnectionId"]=json!(456);}publish_commit_json(&run.root,CommitFile::TimeAck,0,&ack).unwrap();if wrong{assert!(run.time_continue(&time_continue_payload(0)).is_err());}else{for _ in 0..2{assert_eq!(run.time_continue(&time_continue_payload(0)).unwrap(),json!({"ready":true,"verified":true}));}run.time_checkpoint(&time_payload(1),&AcceptanceSecrets::new(&run)).unwrap();}}
    }
    #[test] fn mysql_host_time_actual_ok_false_and_err_metadata_no_sql_body(){
        let run=time_fixture();let result=Ok(json!({"ok":false,"affected":0,"inTransaction":false,"outcomes":[{"error":"synthetic-error-not-retained","sql":"synthetic-template-not-retained"}]}));run.record("applyEdits",result.is_ok(),0);run.record_time_result("applyEdits",&result);run.record_time_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));let before=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert_eq!(before["temporal"]["lastApplyResult"],json!({"ok":false,"affected":0,"inTransaction":false,"outcomeCount":1,"failedOutcomeCount":1,"errorClass":"other"}));assert_eq!(before["methods"]["applyEdits"]["success"],1);assert_eq!(before["methods"]["applyEdits"]["failure"],0);run.record("applyEdits",false,0);run.record_time_result("applyEdits",&Err(AppError::new("driver-failed","synthetic")));assert_eq!(run.snapshot(&AcceptanceSecrets::new(&run)).unwrap()["temporal"],before["temporal"]);let encoded=serde_json::to_string(&before).unwrap();assert!(!encoded.contains("synthetic-error"));assert!(!encoded.contains("synthetic-template"));
    }
    #[test] fn mysql_host_time_schema_arrays_categories_editors_and_green_values(){
        let report=successful_time_report();assert!(validate_ui_report(&report,RUN,"grid-time").unwrap());assert!(validate_ui_report(&report,RUN,"grid-text").is_err());let mut stage=time_stage_payload(0);stage["values"][1]=json!("2024-02-29 00:00:00.000000");stage["values"][5]=json!("1:02:03.000003");stage["columnTypes"][4]=json!("blob");stage["columnTypes"][5]=json!("unknown");assert!(time_stage(&stage).is_ok());stage["values"][0]=Value::Null;assert!(time_stage(&stage).is_ok());stage["columnTypes"][4]=json!("time");assert!(time_stage(&stage).is_err());stage=time_stage_payload(0);stage["witnessProjection"]=json!(["short"]);assert!(time_stage(&stage).is_err());
        for(pointer,value)in[("/proof",Value::Null),("/proof/stages/baseline/values/1",json!("2024-02-29 00:00:00.000000")),("/proof/stages/baseline/values/5",json!("1:02:03.000003")),("/proof/stages/applied/columnTypes/4",json!("blob")),("/proof/editorOriginals/0/raw",json!("wrong")),("/proof/editorOriginals/0/nullDisabled",json!(true)),("/proof/editorOriginals/0/valueDisabled",json!(true)),("/proof/editorOriginals/0/isNull",json!(true)),("/proof/stages/applied/witnessProjection/10",json!("1767225598.654320")),("/proof/stages/committed/witnessConnectionId",json!(456)),("/actions/input",json!(9)),("/actions/dblclick",json!(5)),("/actions/click",json!(11)),("/elapsedMs",json!(0.5))]{let mut changed=report.clone();*changed.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&changed,RUN,"grid-time").is_err());}
    }
    #[test] fn mysql_host_time_one_ack_bad_baseline_header_and_raw_values_retained(){
        let run=time_fixture();let secrets=AcceptanceSecrets::new(&run);mock_time_stage(&run,0);let mut stage=time_stage_payload(0);stage["values"][1]=json!("2024-02-29 00:00:00.000000");stage["values"][5]=json!("1:02:03.000003");stage["columnTypes"][4]=json!("blob");stage["valuesSha256"]=json!("e".repeat(64));let payload=time_payload_from_stage(0,&stage);run.time_checkpoint(&payload,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::TimeAck,0,&time_ack(&run,0,&payload,true)).unwrap();run.time_continue(&time_continue_payload(0)).unwrap();let mut report=successful_time_report();for value in report["checks"].as_object_mut().unwrap().values_mut(){*value=json!(false);}report["failureCode"]=json!("BASELINE_MISMATCH");report["proof"]["stages"]["baseline"]=stage;for name in ["draft","applied","committed"]{report["proof"]["stages"][name]=Value::Null;}report["proof"]["editorOriginals"]=json!([null,null,null,null,null]);report["actions"]["input"]=json!(4);assert!(!run.retain_ui_report(&report,&secrets).unwrap());let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-time-{}.json",std::process::id()))).unwrap();assert_eq!(saved["report"]["proof"]["stages"]["baseline"]["columnTypes"][4],"blob");assert_eq!(saved["report"]["proof"]["stages"]["baseline"]["values"][5],"1:02:03.000003");assert!(!run.time_handshake.lock().unwrap().confirmed[1]);
    }
    #[test] fn mysql_host_time_partial_editor_apply_and_commit_failures_preserved(){
        for count in 2..=4{let run=time_fixture();let secrets=AcceptanceSecrets::new(&run);let mut report=successful_time_report();for value in report["checks"].as_object_mut().unwrap().values_mut(){*value=json!(false);}report["failureCode"]=json!(if count==2{"EDITOR_VALUE_LOSS"}else if count==3{"APPLY_REJECTED"}else{"COMMIT_FAILED"});
            for step in 0..count{let mut stage=time_stage_payload(step);if step+1==count&&count==3{run.record("executeStatement",true,0);let result=Ok(json!({"ok":false,"affected":0,"inTransaction":false,"outcomes":[{"error":"synthetic"}]}));run.record("applyEdits",result.is_ok(),0);run.record_time_result("applyEdits",&result);run.record_time_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));stage["uiActive"]=json!(false);stage["uiPendingAffected"]=json!(0);stage["dirtyRows"]=json!(1);stage["witnessProjection"]=time_expected_projection(false);stage["witnessProjectionSha256"]=json!("c".repeat(64));}else if step+1==count&&count==4{run.record("commitTransaction",false,0);run.record_time_result("commitTransaction",&Err(AppError::new("driver-failed","synthetic")));stage["uiActive"]=json!(true);stage["uiPendingAffected"]=json!(1);}else{mock_time_stage(&run,step);}report["proof"]["stages"][TIME_STEPS[step]]=stage.clone();let payload=time_payload_from_stage(step,&stage);run.time_checkpoint(&payload,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::TimeAck,step,&time_ack(&run,step,&payload,true)).unwrap();run.time_continue(&time_continue_payload(step)).unwrap();}
            for step in count..4{report["proof"]["stages"][TIME_STEPS[step]]=Value::Null;}if count==2{report["proof"]["editorOriginals"][0]["raw"]=json!("observed-wrong-editor");report["proof"]["editorOriginals"][0]["valueDisabled"]=json!(true);}assert!(!run.retain_ui_report(&report,&secrets).unwrap());}
    }
    #[test] fn mysql_host_time_none_requires_four_cached_native_and_final_current_state(){
        let run=time_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.retain_ui_report(&successful_time_report(),&secrets).is_err());for step in 0..4{mock_time_stage(&run,step);let snapshot=run.snapshot(&secrets).unwrap();time_green_native(&snapshot,step).unwrap();let mut bad=snapshot.clone();bad["methods"]["fetchCellValue"]=json!({"success":1,"failure":0});assert!(time_green_native(&bad,step).is_err());let payload=time_payload(step);run.time_checkpoint(&payload,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::TimeAck,step,&time_ack(&run,step,&payload,true)).unwrap();run.time_continue(&time_continue_payload(step)).unwrap();}let mut wrong=successful_time_report();for name in TIME_STEPS{wrong["proof"]["stages"][*name]["witnessConnectionId"]=json!(456);}assert!(run.retain_ui_report(&wrong,&secrets).is_err());run.record_time_result("transactionState",&Ok(json!({"active":true,"pendingAffected":1})));assert!(run.retain_ui_report(&successful_time_report(),&secrets).is_err());run.record_time_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));assert!(run.retain_ui_report(&successful_time_report(),&secrets).unwrap());assert!(run.retain_ui_report(&successful_time_report(),&secrets).is_err());let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-time-{}.json",std::process::id()))).unwrap();assert_eq!(saved["observations"]["temporal"]["lastApplyResult"]["inTransaction"],true);assert_eq!(saved["observations"]["temporal"]["lastObservedTransactionState"]["active"],false);
    }
    #[test] fn mysql_host_time_files_reject_links_bounds_and_preserve_existing(){
        let run=time_fixture();let(pending,target)=commit_paths(&run.root,CommitFile::TimeCheckpoint,0).unwrap();create_private_json(&target,&json!({"retained":true})).unwrap();let bytes=fs::read(&target).unwrap();assert!(run.time_checkpoint(&time_payload(0),&AcceptanceSecrets::new(&run)).is_err());assert_eq!(fs::read(&target).unwrap(),bytes);assert!(!pending.exists());
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;for mode in 0..4{let run=time_fixture();run.time_checkpoint(&time_payload(0),&AcceptanceSecrets::new(&run)).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::TimeAck,0).unwrap();let evidence=owned_evidence(&run.root).unwrap();match mode{0=>{create_private_json(&path,&time_ack(&run,0,&time_payload(0),true)).unwrap();fs::set_permissions(&path,fs::Permissions::from_mode(0o644)).unwrap();},1=>{create_private_json(&path,&json!({"large":"x".repeat(2049)})).unwrap();},2=>{let target=evidence.join("owned-target");create_private_json(&target,&json!({})).unwrap();assert!(fs::symlink_metadata(&target).unwrap().is_file());ensure_absent(&path).unwrap();std::os::unix::fs::symlink(target,&path).unwrap();},_=>{create_private_json(&path,&json!({})).unwrap();let alias=evidence.join("owned-alias");ensure_absent(&alias).unwrap();assert!(fs::symlink_metadata(&path).unwrap().is_file());fs::hard_link(&path,alias).unwrap();}}assert!(run.time_continue(&time_continue_payload(0)).is_err());}}
    }
    fn crosszone_fixture()->AcceptanceRun{let(repo,temp,root,manifest)=fixture(RUN);AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();AcceptanceRun::prepare(root,RUN.into(),"grid-time-crosszone".into(),manifest,&temp,&repo).unwrap()}
    fn crosszone_payload(step:usize)->Value{json!({"schemaVersion":1,"step":CROSSZONE_STEPS[step],"uiActive":false,"uiPendingAffected":0,"dirtyRows":0,"valuesSha256":if step==1{"b".repeat(64)}else{"a".repeat(64)},"witnessConnectionId":123,"witnessProjectionSha256":if step==1{"d".repeat(64)}else{"c".repeat(64)},"sessionTimezone":crosszone_expected_timezone(step),"resultTabsBefore":5+3*step as u64,"resultTabsAfter":6+3*step as u64,"activeTabGeneration":6+3*step as u64,"activeTabOwned":true,"nativeExecuteCount":6+3*step as u64})}
    fn crosszone_continue_payload(step:usize)->Value{json!({"schemaVersion":1,"step":CROSSZONE_STEPS[step]})}
    fn crosszone_ack(run:&AcceptanceRun,step:usize,payload:&Value,verified:bool)->Value{json!({"schemaVersion":1,"runId":run.run_id,"phase":"grid-time-crosszone","pid":std::process::id(),"step":CROSSZONE_STEPS[step],"proof":payload,"verified":verified})}
    fn crosszone_stage_payload(step:usize)->Value{json!({"values":crosszone_expected_values(step==1),"columnTypes":["integer","date","date","date","text","text"],"valuesSha256":if step==1{"b".repeat(64)}else{"a".repeat(64)},"witnessConnectionId":123,"witnessProjection":crosszone_expected_projection(step==1),"witnessProjectionSha256":if step==1{"d".repeat(64)}else{"c".repeat(64)},"uiActive":false,"uiPendingAffected":0,"dirtyRows":0,"sessionTimezone":crosszone_expected_timezone(step),"resultTabsBefore":5+3*step as u64,"resultTabsAfter":6+3*step as u64,"activeTabGeneration":6+3*step as u64,"activeTabOwned":true,"nativeExecuteCount":6+3*step as u64})}
    fn mock_crosszone_stage(run:&AcceptanceRun,step:usize){
        for _ in 0..(if step==0{6}else{3}){run.record("executeStatement",true,0);}
        if step==0{run.record("commitTransaction",true,0);}
        run.record("transactionState",true,0);
        run.record_crosszone_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));
    }
    fn successful_crosszone_report()->Value{json!({"schemaVersion":1,"runId":RUN,"phase":"grid-time-crosszone","actionDriver":"native-dom-synthetic","checks":{"storage_marker":true,"persisted_connection":true,"credential_reconnect":true,"fixture_created":true,"baseline_utc_display":true,"shifted_plus08_display":true,"restored_utc_display":true,"non_ts_unchanged":true,"epoch_invariant":true,"microsecond_invariant":true,"session_readback":true,"same_connection":true,"transaction_unchanged":true,"observer_row_unchanged":true,"session_restored":true},"proof":{"rowCount":1,"columnCount":5,"stages":{"baseline":crosszone_stage_payload(0),"shifted":crosszone_stage_payload(1),"restored":crosszone_stage_payload(2)}},"actions":{"click":9,"input":0,"keydown":0,"dblclick":0},"elapsedMs":600,"failureCode":"NONE"})}
    #[test] fn mysql_host_crosszone_phase_password_origin_snapshot_scope(){
        let(repo,temp,root,manifest)=fixture(RUN);assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"grid-time-crosszone".into(),manifest.clone(),&temp,&repo).is_err());let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();assert!(initial.crosszone_checkpoint(&crosszone_payload(0),&AcceptanceSecrets::new(&initial)).is_err());assert!(initial.crosszone_continue(&crosszone_continue_payload(0)).is_err());initial.record_crosszone_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));assert!(initial.snapshot(&AcceptanceSecrets::new(&initial)).unwrap().get("crosszone").is_none());
        let mut run=AcceptanceRun::prepare(root,RUN.into(),"grid-time-crosszone".into(),manifest,&temp,&repo).unwrap();run.app_secret=repo.join("missing-not-read.secret");assert_eq!(run.password_script().unwrap_err().code,"unsupported");assert_eq!(run.context()["phase"],"grid-time-crosszone");assert_eq!(run.store_id,initial.store_id);assert_eq!(run.namespace(),initial.namespace());let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert!(exact_fields(&snapshot["crosszone"],&["lastApplyResult","lastObservedTransactionState"]).is_ok());assert!(snapshot["crosszone"]["lastApplyResult"].is_null());assert!(snapshot["crosszone"]["lastObservedTransactionState"].is_null());let mut probe=initial;probe.phase="restart-probe".into();for method in ["mysqlAcceptanceCrosszoneCheckpoint","mysqlAcceptanceCrosszoneContinue"]{assert!(!probe.probe_method_allowed(method));}assert!(!bridge_window_allowed("other","tauri://localhost/"));
    }
    #[test] fn mysql_host_crosszone_payload_exact_shape_and_bounds(){
        for step in 0..3{assert_eq!(crosszone_step(&crosszone_payload(step),true).unwrap(),step);assert_eq!(crosszone_step(&crosszone_continue_payload(step),false).unwrap(),step);}
        for(key,value)in[("schemaVersion",json!(2)),("step",json!("unknown")),("uiActive",json!(1)),("uiPendingAffected",json!(1001)),("dirtyRows",json!(1001)),("valuesSha256",json!("g".repeat(64))),("valuesSha256",json!("A".repeat(64))),("witnessConnectionId",json!(0)),("witnessConnectionId",Value::Null),("witnessProjectionSha256",json!("z".repeat(64))),("sessionTimezone",json!("+08:00\n")),("sessionTimezone",json!("差".repeat(65))),("resultTabsBefore",json!(1001)),("resultTabsAfter",json!(1001)),("activeTabGeneration",json!(1001)),("activeTabOwned",json!(1)),("nativeExecuteCount",json!(10001)),("extra",json!(1))]{let mut payload=crosszone_payload(0);payload[key]=value;assert!(crosszone_step(&payload,true).is_err(),"{key}");}
        let mut missing=crosszone_payload(0);missing.as_object_mut().unwrap().remove("sessionTimezone");assert!(crosszone_step(&missing,true).is_err());let mut extra=crosszone_continue_payload(0);extra["extra"]=json!(1);assert!(crosszone_step(&extra,false).is_err());
        let mut wide=crosszone_payload(0);wide["sessionTimezone"]=json!("差".repeat(64));assert!(crosszone_step(&wide,true).is_ok());let mut empty=crosszone_payload(0);empty["sessionTimezone"]=json!("");assert!(crosszone_step(&empty,true).is_ok());
        // A wrong display is still a shape-valid request; the checkpoint never compares a value with the expected truth.
        let mut red=crosszone_payload(0);red["valuesSha256"]=json!("e".repeat(64));red["dirtyRows"]=json!(1);red["uiActive"]=json!(true);red["uiPendingAffected"]=json!(1);assert!(crosszone_step(&red,true).is_ok());
    }
    #[test] fn mysql_host_crosszone_step_order_idempotency_and_ack_equality(){
        let run=crosszone_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.crosszone_checkpoint(&crosszone_payload(1),&secrets).is_err());run.crosszone_checkpoint(&crosszone_payload(0),&secrets).unwrap();run.crosszone_checkpoint(&crosszone_payload(0),&secrets).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::CrosszoneCheckpoint,0).unwrap();assert!(exact_fields(&read_private_json(&path).unwrap(),&["schemaVersion","runId","phase","pid","report","observations"]).is_ok());let mut changed=crosszone_payload(0);changed["valuesSha256"]=json!("e".repeat(64));assert!(run.crosszone_checkpoint(&changed,&secrets).is_err());assert_eq!(run.crosszone_continue(&crosszone_continue_payload(0)).unwrap(),json!({"ready":false,"verified":false}));
        {
            // A false ack never unlocks the next step.
            let run=crosszone_fixture();let secrets=AcceptanceSecrets::new(&run);run.crosszone_checkpoint(&crosszone_payload(0),&secrets).unwrap();publish_commit_json(&run.root,CommitFile::CrosszoneAck,0,&crosszone_ack(&run,0,&crosszone_payload(0),false)).unwrap();assert_eq!(run.crosszone_continue(&crosszone_continue_payload(0)).unwrap(),json!({"ready":true,"verified":false}));assert!(run.crosszone_checkpoint(&crosszone_payload(1),&secrets).is_err());
        }
        {
            // The host never accepts a proof it did not publish itself.
            let run=crosszone_fixture();let secrets=AcceptanceSecrets::new(&run);run.crosszone_checkpoint(&crosszone_payload(0),&secrets).unwrap();let mut forged=crosszone_ack(&run,0,&crosszone_payload(0),true);forged["proof"]["witnessConnectionId"]=json!(456);publish_commit_json(&run.root,CommitFile::CrosszoneAck,0,&forged).unwrap();assert!(run.crosszone_continue(&crosszone_continue_payload(0)).is_err());
        }
        {
            let run=crosszone_fixture();let secrets=AcceptanceSecrets::new(&run);run.crosszone_checkpoint(&crosszone_payload(0),&secrets).unwrap();publish_commit_json(&run.root,CommitFile::CrosszoneAck,0,&crosszone_ack(&run,0,&crosszone_payload(0),true)).unwrap();for _ in 0..2{assert_eq!(run.crosszone_continue(&crosszone_continue_payload(0)).unwrap(),json!({"ready":true,"verified":true}));}run.crosszone_checkpoint(&crosszone_payload(1),&secrets).unwrap();assert!(run.crosszone_checkpoint(&crosszone_payload(0),&secrets).is_err());
        }
    }
    #[test] fn mysql_host_crosszone_stage_schema_and_canonical_values(){
        let stage=crosszone_stage_payload(1);assert!(crosszone_stage(&stage).is_ok());assert_eq!(stage["values"],crosszone_expected_values(true));assert_eq!(stage["witnessProjection"],crosszone_expected_projection(true));assert_eq!(crosszone_expected_projection(true)[0],"+08:00");assert_eq!(crosszone_expected_projection(false)[0],"+00:00");assert_eq!(crosszone_expected_projection(false)[10],"1709210096.123456");assert_eq!(crosszone_expected_projection(true)[10],"1709210096.123456");assert_eq!(crosszone_expected_values(true)[3],"2024-02-29 20:34:56.123456");assert_eq!(crosszone_expected_values(false)[3],"2024-02-29 12:34:56.123456");
        let mut wrong=stage.clone();wrong["values"]=json!(["1","2024-02-29"]);assert!(crosszone_stage(&wrong).is_err());wrong=stage.clone();wrong["witnessProjection"]=json!(["short"]);assert!(crosszone_stage(&wrong).is_err());wrong=stage.clone();wrong["columnTypes"]=json!(["integer","date","date","date","text","time"]);assert!(crosszone_stage(&wrong).is_err());wrong=stage.clone();wrong["valuesSha256"]=json!("E".repeat(64));assert!(crosszone_stage(&wrong).is_err());wrong=stage.clone();wrong["witnessConnectionId"]=json!(0);assert!(crosszone_stage(&wrong).is_err());wrong=stage.clone();wrong["sessionTimezone"]=json!("+08:00\t");assert!(crosszone_stage(&wrong).is_err());wrong=stage.clone();wrong.as_object_mut().unwrap().remove("nativeExecuteCount");assert!(crosszone_stage(&wrong).is_err());
        // The observed header class stays actual: a closed but unexpected category is retained, never pre-corrected.
        let mut actual=stage.clone();actual["columnTypes"]=json!(["integer","date","date","date","blob","blob"]);assert!(crosszone_stage(&actual).is_ok());
    }
    #[test] fn mysql_host_crosszone_partial_red_retained_without_promotion(){
        let run=crosszone_fixture();let secrets=AcceptanceSecrets::new(&run);mock_crosszone_stage(&run,0);let mut stage=crosszone_stage_payload(0);stage["values"][3]=json!("2024-02-29 00:00:00.123456");stage["columnTypes"][4]=json!("blob");stage["valuesSha256"]=json!("e".repeat(64));let mut payload=crosszone_payload(0);payload["valuesSha256"]=stage["valuesSha256"].clone();run.crosszone_checkpoint(&payload,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::CrosszoneAck,0,&crosszone_ack(&run,0,&payload,true)).unwrap();run.crosszone_continue(&crosszone_continue_payload(0)).unwrap();
        let mut report=successful_crosszone_report();for value in report["checks"].as_object_mut().unwrap().values_mut(){*value=json!(false);}report["failureCode"]=json!("DISPLAY_VALUE_MISMATCH");report["proof"]["stages"]["baseline"]=stage;report["proof"]["stages"]["shifted"]=Value::Null;report["proof"]["stages"]["restored"]=Value::Null;assert!(!run.retain_ui_report(&report,&secrets).unwrap());let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-time-crosszone-{}.json",std::process::id()))).unwrap();assert_eq!(saved["report"]["proof"]["stages"]["baseline"]["values"][3],"2024-02-29 00:00:00.123456");assert_eq!(saved["report"]["proof"]["stages"]["baseline"]["columnTypes"][4],"blob");assert_eq!(saved["report"]["failureCode"],"DISPLAY_VALUE_MISMATCH");assert!(!run.crosszone_handshake.lock().unwrap().confirmed[1]);assert!(!run.crosszone_handshake.lock().unwrap().confirmed[2]);
    }
    #[test] fn mysql_host_crosszone_none_requires_three_native_snapshots(){
        let run=crosszone_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.retain_ui_report(&successful_crosszone_report(),&secrets).is_err());
        for step in 0..3{mock_crosszone_stage(&run,step);let snapshot=run.snapshot(&secrets).unwrap();crosszone_green_native(&snapshot,step).unwrap();let mut wrong=snapshot.clone();wrong["methods"]["fetchCellValue"]=json!({"success":1,"failure":0});assert!(crosszone_green_native(&wrong,step).is_err());let mut wrong=snapshot.clone();wrong["crosszone"]["lastObservedTransactionState"]=json!({"active":true,"pendingAffected":1});assert!(crosszone_green_native(&wrong,step).is_err());let payload=crosszone_payload(step);run.crosszone_checkpoint(&payload,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::CrosszoneAck,step,&crosszone_ack(&run,step,&payload,true)).unwrap();run.crosszone_continue(&crosszone_continue_payload(step)).unwrap();}
        let mut wrong=successful_crosszone_report();for name in CROSSZONE_STEPS{wrong["proof"]["stages"][*name]["witnessConnectionId"]=json!(456);}assert!(run.retain_ui_report(&wrong,&secrets).is_err());let mut wrong=successful_crosszone_report();wrong["proof"]["stages"]["restored"]["nativeExecuteCount"]=json!(11);assert!(run.retain_ui_report(&wrong,&secrets).is_err());assert!(run.retain_ui_report(&successful_crosszone_report(),&secrets).unwrap());let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-time-crosszone-{}.json",std::process::id()))).unwrap();assert_eq!(saved["observations"]["crosszone"]["lastObservedTransactionState"],json!({"active":false,"pendingAffected":0}));assert_eq!(saved["observations"]["methods"]["executeStatement"]["success"],12);assert_eq!(saved["observations"]["methods"]["commitTransaction"]["success"],1);
    }
    #[test] fn mysql_host_crosszone_files_reject_links_bounds_and_preserve_existing(){
        let run=crosszone_fixture();let(pending,target)=commit_paths(&run.root,CommitFile::CrosszoneCheckpoint,0).unwrap();create_private_json(&target,&json!({"retained":true})).unwrap();let bytes=fs::read(&target).unwrap();assert!(run.crosszone_checkpoint(&crosszone_payload(0),&AcceptanceSecrets::new(&run)).is_err());assert_eq!(fs::read(&target).unwrap(),bytes);assert!(!pending.exists());
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;for mode in 0..4{let run=crosszone_fixture();run.crosszone_checkpoint(&crosszone_payload(0),&AcceptanceSecrets::new(&run)).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::CrosszoneAck,0).unwrap();let evidence=owned_evidence(&run.root).unwrap();match mode{0=>{create_private_json(&path,&crosszone_ack(&run,0,&crosszone_payload(0),true)).unwrap();fs::set_permissions(&path,fs::Permissions::from_mode(0o644)).unwrap();},1=>{create_private_json(&path,&json!({"large":"x".repeat(2049)})).unwrap();},2=>{let target=evidence.join("owned-target");create_private_json(&target,&json!({})).unwrap();assert!(fs::symlink_metadata(&target).unwrap().is_file());ensure_absent(&path).unwrap();std::os::unix::fs::symlink(target,&path).unwrap();},_=>{create_private_json(&path,&json!({})).unwrap();let alias=evidence.join("owned-alias");ensure_absent(&alias).unwrap();assert!(fs::symlink_metadata(&path).unwrap().is_file());fs::hard_link(&path,alias).unwrap();}}assert!(run.crosszone_continue(&crosszone_continue_payload(0)).is_err());}}
    }
    #[test] fn mysql_host_crosszone_actual_native_snapshot_not_replaced_by_expected(){
        let run=crosszone_fixture();run.record("executeStatement",false,0);run.record_crosszone_result("transactionState",&Ok(json!({"active":true,"pendingAffected":1})));let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert_eq!(snapshot["crosszone"]["lastObservedTransactionState"],json!({"active":true,"pendingAffected":1}));assert_eq!(snapshot["methods"]["executeStatement"]["failure"],1);assert_eq!(snapshot["methods"]["executeStatement"]["success"],0);assert!(snapshot["crosszone"]["lastApplyResult"].is_null());assert!(crosszone_green_native(&snapshot,0).is_err());
        run.record_crosszone_result("transactionState",&Err(AppError::new("driver-failed","synthetic-error-not-retained")));let after=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert_eq!(after["crosszone"],snapshot["crosszone"]);let encoded=serde_json::to_string(&after).unwrap();assert!(!encoded.contains("synthetic-error"));
        mock_crosszone_stage(&run,0);let mut stage=crosszone_stage_payload(0);stage["values"][3]=json!("2024-02-29 00:00:00.123456");let mut payload=crosszone_payload(0);payload["valuesSha256"]=json!("e".repeat(64));run.crosszone_checkpoint(&payload,&AcceptanceSecrets::new(&run)).unwrap();publish_commit_json(&run.root,CommitFile::CrosszoneAck,0,&crosszone_ack(&run,0,&payload,true)).unwrap();run.crosszone_continue(&crosszone_continue_payload(0)).unwrap();let mut report=successful_crosszone_report();for value in report["checks"].as_object_mut().unwrap().values_mut(){*value=json!(false);}report["failureCode"]=json!("DISPLAY_VALUE_MISMATCH");report["proof"]["stages"]["baseline"]=stage;report["proof"]["stages"]["shifted"]=Value::Null;report["proof"]["stages"]["restored"]=Value::Null;assert!(!run.retain_ui_report(&report,&AcceptanceSecrets::new(&run)).unwrap());let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-time-crosszone-{}.json",std::process::id()))).unwrap();assert_eq!(saved["report"]["proof"]["stages"]["baseline"]["values"][3],"2024-02-29 00:00:00.123456");
    }
    fn binary_fixture()->AcceptanceRun{let(repo,temp,root,manifest)=fixture(RUN);AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();AcceptanceRun::prepare(root,RUN.into(),"grid-bit-blob".into(),manifest,&temp,&repo).unwrap()}
    fn binary_row(id:u64,bin_hex:Value,bin_len:Value,is_null:bool)->Value{json!({"id":id,"b1Hex":if id%2==1{"01"}else{"00"},"b1Decimal":if id%2==1{"1"}else{"0"},"b64Hex":if id==1{"FFFFFFFFFFFFFFFF"}else{"0000000000000001"},"b64Decimal":if id==1{"18446744073709551615"}else{"1"},"binHex":bin_hex,"binByteLength":bin_len,"binIsNull":is_null})}
    fn binary_rows()->Value{json!([binary_row(1,json!("00FFE4B8AD"),json!(5),false),binary_row(2,json!("00"),json!(1),false),binary_row(3,json!(""),json!(0),false),binary_row(4,Value::Null,Value::Null,true)])}
    fn binary_request(step:usize)->Value{json!({"schemaVersion":1,"step":BINARY_STEPS[step],"uiActive":step==2,"uiPendingAffected":if step==2{1}else{0},"dirtyRows":if step==1{1}else{0},"rowsSha256":if step<2{"a".repeat(64)}else{"b".repeat(64)},"witnessConnectionId":123,"witnessProjectionSha256":if step<2{"c".repeat(64)}else{"d".repeat(64)},"columnCategories":["integer","blob","blob","blob"],"blobEditableEntry":true})}
    fn binary_continue_request(step:usize)->Value{json!({"schemaVersion":1,"step":BINARY_STEPS[step]})}
    fn binary_ack(run:&AcceptanceRun,step:usize,payload:&Value,verified:bool)->Value{json!({"schemaVersion":1,"runId":run.run_id,"phase":"grid-bit-blob","pid":std::process::id(),"step":BINARY_STEPS[step],"proof":payload,"verified":verified})}
    fn binary_stage(step:usize)->Value{json!({"rows":binary_rows(),"rowsSha256":if step<2{"a".repeat(64)}else{"b".repeat(64)},"targetRowId":1,"targetBinHex":"00FFE4B8AD","targetBinIsNull":false,"columnCategories":["integer","blob","blob","blob"],"blobEditableEntry":true,"uiActive":step==2,"uiPendingAffected":if step==2{1}else{0},"dirtyRows":if step==1{1}else{0},"witnessConnectionId":123,"witnessProjectionSha256":if step<2{"c".repeat(64)}else{"d".repeat(64)}})}
    fn binary_gap()->Value{json!({"viewerOpened":true,"viewerTitle":"只读完整值","viewerHex":"0x00FFE4B8AD","editorDialogPresent":false,"inlineErrorText":"二进制单元格只读"})}
    fn binary_editor()->Value{json!({"raw":"00FFE4B8AD","isNull":false,"valueDisabled":false,"nullDisabled":false})}
    fn successful_binary_report()->Value{json!({"schemaVersion":1,"runId":RUN,"phase":"grid-bit-blob","actionDriver":"native-dom-synthetic",
        "checks":{"storage_marker":true,"persisted_connection":true,"credential_reconnect":true,"fixture_created":true,"table_open":true,"column_categories_read":true,"baseline_rows_read":true,"bit_readonly_observed":true,"blob_editable_entry":true,"local_edits":true,"apply_succeeded":true,"committed_reload_verified":true},
        "proof":{"rowCount":4,"columnCount":3,"rows":binary_rows(),"rowsSha256":"a".repeat(64),"columnCategories":["integer","blob","blob","blob"],"readonlyGap":binary_gap(),"editorOriginal":binary_editor(),"stages":{"baseline":binary_stage(0),"draft":binary_stage(1),"applied":binary_stage(2),"committed":binary_stage(3)}},
        "actions":{"click":12,"input":2,"keydown":0,"dblclick":4},"elapsedMs":600,"failureCode":"NONE"})}
    fn mock_binary_stage(run:&AcceptanceRun,step:usize){
        for _ in 0..(if step==0{3}else{1}){run.record("executeStatement",true,0);}
        if step==0||step==3{run.record("commitTransaction",true,0);}
        if step==2{run.record("applyEdits",true,0);run.record_binary_result("applyEdits",&Ok(json!({"ok":true,"affected":1,"inTransaction":true,"outcomes":[{"error":null,"sql":"synthetic-template-not-retained"}]})));}
        run.record_binary_result("transactionState",&Ok(json!({"active":step==2,"pendingAffected":if step==2{1}else{0}})));
    }
    #[test] fn mysql_host_binary_phase_password_origin_and_snapshot_scope(){
        let(repo,temp,root,manifest)=fixture(RUN);
        assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"grid-bit-blob".into(),manifest.clone(),&temp,&repo).is_err());
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        assert!(initial.binary_checkpoint(&binary_request(0),&AcceptanceSecrets::new(&initial)).is_err());
        assert!(initial.binary_continue(&binary_continue_request(0)).is_err());
        initial.record_binary_result("applyEdits",&Ok(json!({"ok":true,"affected":1,"inTransaction":true,"outcomes":[{"error":null}]})));
        assert!(initial.snapshot(&AcceptanceSecrets::new(&initial)).unwrap().get("binary").is_none());
        let mut run=AcceptanceRun::prepare(root,RUN.into(),"grid-bit-blob".into(),manifest,&temp,&repo).unwrap();
        run.app_secret=repo.join("missing-not-read.secret");
        assert_eq!(run.password_script().unwrap_err().code,"unsupported");
        assert_eq!(run.context()["phase"],"grid-bit-blob");
        assert_eq!(run.store_id,initial.store_id);
        assert_eq!(run.namespace(),initial.namespace());
        let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();
        assert!(exact_fields(&snapshot["binary"],&["lastApplyResult","lastObservedTransactionState"]).is_ok());
        assert!(snapshot["binary"]["lastApplyResult"].is_null());
        assert!(snapshot["binary"]["lastObservedTransactionState"].is_null());
        assert_eq!(snapshot.as_object().unwrap().len(),11);
        let mut probe=initial;probe.phase="restart-probe".into();
        for method in ["mysqlAcceptanceBinaryCheckpoint","mysqlAcceptanceBinaryContinue"]{assert!(!probe.probe_method_allowed(method));}
        assert!(!bridge_window_allowed("other","tauri://localhost/"));
    }
    #[test] fn mysql_host_binary_request_exact_ten_fields_and_ranges(){
        for step in 0..4{assert_eq!(binary_step(&binary_request(step),true).unwrap(),step);assert_eq!(binary_step(&binary_continue_request(step),false).unwrap(),step);}
        for(key,value)in[("schemaVersion",json!(2)),("step",json!("unknown")),("uiActive",json!(1)),("uiPendingAffected",json!(1001)),("dirtyRows",json!(1001)),("rowsSha256",json!("A".repeat(64))),("witnessConnectionId",json!(0)),("witnessConnectionId",Value::Null),("witnessProjectionSha256",json!("g".repeat(64))),("blobEditableEntry",json!("true")),("extra",json!(1))]{
            let mut request=binary_request(0);request[key]=value;assert!(binary_step(&request,true).is_err(),"{key}");
        }
        let mut missing=binary_request(0);missing.as_object_mut().unwrap().remove("columnCategories");assert!(binary_step(&missing,true).is_err());
        let mut extra=binary_continue_request(0);extra["extra"]=json!(1);assert!(binary_step(&extra,false).is_err());
        let mut wide=binary_request(0);wide["columnCategories"]=json!(["integer","blob","blob","blob","blob"]);assert!(binary_step(&wide,true).is_err());
        let mut unknown=binary_request(0);unknown["columnCategories"]=json!(["integer","blob","blob","time"]);assert!(binary_step(&unknown,true).is_err());
        let mut payload=binary_request(0);payload["sql"]=json!("SELECT 1");assert!(binary_step(&payload,true).is_err());
        let mut huge=binary_request(0);huge["rowsSha256"]=json!("a".repeat(4096));assert!(binary_step(&huge,true).is_err());
        // The witness projection keeps seven fixed string aliases and never a connection id.
        assert_eq!(BINARY_WITNESS_ALIASES.len(),7);
        assert_eq!(BINARY_WITNESS_ALIASES[0],"b1_hex");
        assert_eq!(BINARY_WITNESS_ALIASES[6],"bin_null");
    }
    #[test] fn mysql_host_binary_request_carries_no_sql_path_or_expected(){
        let run=binary_fixture();let secrets=AcceptanceSecrets::new(&run);
        run.binary_checkpoint(&binary_request(0),&secrets).unwrap();
        let(_,path)=commit_paths(&run.root,CommitFile::BinaryCheckpoint,0).unwrap();
        let wrapper=read_private_json(&path).unwrap();
        assert!(exact_fields(&wrapper,&["schemaVersion","runId","phase","pid","report","observations"]).is_ok());
        let report=wrapper["report"].as_object().unwrap();
        assert_eq!(report.len(),10);
        for forbidden in ["sql","query","path","expected","expectedValue","table","database","value"]{assert!(!report.contains_key(forbidden));}
        let encoded=serde_json::to_string(&wrapper).unwrap();
        for forbidden in ["SELECT","INSERT","/Users","mysql_accept_","gui_bin_","password"]{assert!(!encoded.contains(forbidden),"{forbidden}");}
        assert!(encoded.len()<=16384);
    }
    #[test] fn mysql_host_binary_step_order_idempotency_and_covered_replay(){
        let run=binary_fixture();let secrets=AcceptanceSecrets::new(&run);
        assert!(run.binary_checkpoint(&binary_request(1),&secrets).is_err());
        run.binary_checkpoint(&binary_request(0),&secrets).unwrap();
        run.binary_checkpoint(&binary_request(0),&secrets).unwrap();
        let mut changed=binary_request(0);changed["rowsSha256"]=json!("e".repeat(64));assert!(run.binary_checkpoint(&changed,&secrets).is_err());
        assert!(run.binary_checkpoint(&binary_request(1),&secrets).is_err());
        publish_commit_json(&run.root,CommitFile::BinaryAck,0,&binary_ack(&run,0,&binary_request(0),true)).unwrap();
        run.binary_continue(&binary_continue_request(0)).unwrap();
        run.binary_checkpoint(&binary_request(1),&secrets).unwrap();
        // A step that a later step already covered can never be replayed again.
        assert!(run.binary_checkpoint(&binary_request(0),&secrets).is_err());
        assert!(run.binary_checkpoint(&binary_request(2),&secrets).is_err());
    }
    #[test] fn mysql_host_binary_ack_equality_forgery_and_false_verified(){
        let run=binary_fixture();let secrets=AcceptanceSecrets::new(&run);
        let payload=binary_request(0);run.binary_checkpoint(&payload,&secrets).unwrap();
        let mut forged=binary_ack(&run,0,&payload,true);forged["proof"]["witnessConnectionId"]=json!(456);
        publish_commit_json(&run.root,CommitFile::BinaryAck,0,&forged).unwrap();
        assert!(run.binary_continue(&binary_continue_request(0)).is_err());
        assert!(!run.binary_handshake.lock().unwrap().confirmed[0]);
        let run=binary_fixture();let secrets=AcceptanceSecrets::new(&run);
        let payload=binary_request(0);run.binary_checkpoint(&payload,&secrets).unwrap();
        publish_commit_json(&run.root,CommitFile::BinaryAck,0,&binary_ack(&run,0,&payload,false)).unwrap();
        assert_eq!(run.binary_continue(&binary_continue_request(0)).unwrap(),json!({"ready":true,"verified":false}));
        assert!(run.binary_checkpoint(&binary_request(1),&AcceptanceSecrets::new(&run)).is_err());
        for(key,value)in[("runId",json!("ffffffffffffffffffffffffffffffff")),("phase",json!("grid-time")),("pid",json!(0)),("step",json!("draft")),("verified",json!(1)),("extra",json!(true))]{
            let run=binary_fixture();let secrets=AcceptanceSecrets::new(&run);run.binary_checkpoint(&binary_request(0),&secrets).unwrap();
            let mut ack=binary_ack(&run,0,&binary_request(0),true);ack[key]=value;publish_commit_json(&run.root,CommitFile::BinaryAck,0,&ack).unwrap();
            assert!(run.binary_continue(&binary_continue_request(0)).is_err());
            assert!(!run.binary_handshake.lock().unwrap().confirmed[0]);
        }
    }
    #[test] fn mysql_host_binary_continue_returns_exact_ready_verified(){
        let run=binary_fixture();let secrets=AcceptanceSecrets::new(&run);
        assert!(run.binary_continue(&binary_continue_request(0)).is_err());
        run.binary_checkpoint(&binary_request(0),&secrets).unwrap();
        let ready=run.binary_continue(&binary_continue_request(0)).unwrap();
        assert!(exact_fields(&ready,&["ready","verified"]).is_ok());
        assert_eq!(ready,json!({"ready":false,"verified":false}));
        let mut extra=binary_continue_request(0);extra["extra"]=json!(1);assert!(run.binary_continue(&extra).is_err());
        let mut wrong=binary_continue_request(0);wrong["schemaVersion"]=json!(2);assert!(run.binary_continue(&wrong).is_err());
        let mut unknown=binary_continue_request(0);unknown["step"]=json!("unknown");assert!(run.binary_continue(&unknown).is_err());
    }
    #[test] fn mysql_host_binary_read_only_red_keeps_one_stage_and_actual_rows(){
        let run=binary_fixture();let secrets=AcceptanceSecrets::new(&run);
        mock_binary_stage(&run,0);
        let payload=binary_request(0);run.binary_checkpoint(&payload,&secrets).unwrap();
        publish_commit_json(&run.root,CommitFile::BinaryAck,0,&binary_ack(&run,0,&payload,true)).unwrap();
        run.binary_continue(&binary_continue_request(0)).unwrap();
        let mut report=successful_binary_report();
        for name in ["blob_editable_entry","local_edits","apply_succeeded","committed_reload_verified"]{report["checks"][name]=json!(false);}
        report["failureCode"]=json!("READ_ONLY_BINARY");
        report["proof"]["stages"]=json!({"baseline":binary_stage(0),"draft":Value::Null,"applied":Value::Null,"committed":Value::Null});
        report["proof"]["editorOriginal"]=Value::Null;
        report["proof"]["readonlyGap"]["editorDialogPresent"]=json!(false);
        assert!(!run.retain_ui_report(&report,&secrets).unwrap());
        let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-bit-blob-{}.json",std::process::id()))).unwrap();
        assert_eq!(saved["report"]["failureCode"],"READ_ONLY_BINARY");
        assert_eq!(saved["report"]["proof"]["rows"][0]["binHex"],"00FFE4B8AD");
        assert_eq!(saved["report"]["proof"]["rows"][3]["binIsNull"],true);
        assert!(saved["report"]["proof"]["stages"]["draft"].is_null());
        assert!(saved["report"]["proof"]["stages"]["applied"].is_null());
        assert!(saved["report"]["proof"]["stages"]["committed"].is_null());
        assert!(!run.binary_handshake.lock().unwrap().confirmed[1]);
    }
    #[test] fn mysql_host_binary_null_empty_and_zero_byte_stay_distinct(){
        let report=successful_binary_report();
        assert!(validate_ui_report(&report,RUN,"grid-bit-blob").unwrap());
        let rows=report["proof"]["rows"].as_array().unwrap();
        assert_eq!(rows[1]["binHex"],"00");assert_eq!(rows[1]["binByteLength"],1);assert_eq!(rows[1]["binIsNull"],false);
        assert_eq!(rows[2]["binHex"],"");assert_eq!(rows[2]["binByteLength"],0);assert_eq!(rows[2]["binIsNull"],false);
        assert!(rows[3]["binHex"].is_null());assert!(rows[3]["binByteLength"].is_null());assert_eq!(rows[3]["binIsNull"],true);
        for(pointer,value)in[("/proof/rows/1/binHex",json!("0")),("/proof/rows/1/binHex",json!("00ff")),("/proof/rows/1/binByteLength",json!(257)),("/proof/rows/1/binByteLength",json!(-1)),("/proof/rows/1/binIsNull",json!("true")),("/proof/rows/2/binHex",Value::Null)]{
            let mut changed=report.clone();*changed.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&changed,RUN,"grid-bit-blob").is_err(),"{pointer}");
        }
        // The green report must agree with itself: the null flag, the hex and the byte length.
        let mut null_flag=report.clone();null_flag["proof"]["rows"][3]["binHex"]=json!("");null_flag["proof"]["rows"][3]["binByteLength"]=json!(0);assert!(validate_ui_report(&null_flag,RUN,"grid-bit-blob").is_err());
        let mut wrong_length=report.clone();wrong_length["proof"]["rows"][1]["binByteLength"]=json!(2);assert!(validate_ui_report(&wrong_length,RUN,"grid-bit-blob").is_err());
        let mut wrong_stage=report.clone();wrong_stage["proof"]["stages"]["committed"]["rows"][1]["binByteLength"]=json!(2);assert!(validate_ui_report(&wrong_stage,RUN,"grid-bit-blob").is_err());
        // The retained evidence keeps the null, the empty blob and the zero byte blob apart.
        let run=binary_fixture();let secrets=AcceptanceSecrets::new(&run);
        let mut red=successful_binary_report();
        for name in ["blob_editable_entry","local_edits","apply_succeeded","committed_reload_verified"]{red["checks"][name]=json!(false);}
        red["failureCode"]=json!("READ_ONLY_BINARY");
        red["proof"]["stages"]=json!({"baseline":binary_stage(0),"draft":Value::Null,"applied":Value::Null,"committed":Value::Null});
        assert!(!run.retain_ui_report(&red,&secrets).unwrap());
        let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-bit-blob-{}.json",std::process::id()))).unwrap();
        assert_eq!(saved["report"]["proof"]["rows"][1]["binHex"],"00");
        assert_eq!(saved["report"]["proof"]["rows"][2]["binHex"],"");
        assert_eq!(saved["report"]["proof"]["rows"][2]["binByteLength"],0);
        assert!(saved["report"]["proof"]["rows"][3]["binHex"].is_null());
        assert_eq!(saved["report"]["proof"]["rows"][3]["binIsNull"],true);
    }
    #[test] fn mysql_host_binary_bit_values_stay_unsigned_decimal_strings(){
        let report=successful_binary_report();
        let rows=report["proof"]["rows"].as_array().unwrap();
        for row in rows{
            assert!(row["b1Decimal"].is_string());assert!(row["b64Decimal"].is_string());
            assert!(row["b1Decimal"].as_str().unwrap().bytes().all(|byte|byte.is_ascii_digit()));
            assert!(row["b64Decimal"].as_str().unwrap().bytes().all(|byte|byte.is_ascii_digit()));
        }
        assert_eq!(rows[0]["b64Hex"],"FFFFFFFFFFFFFFFF");
        assert_eq!(rows[0]["b64Decimal"],"18446744073709551615");
        let mut number=report.clone();number["proof"]["rows"][0]["b64Decimal"]=json!(18446744073709551615u64);assert!(validate_ui_report(&number,RUN,"grid-bit-blob").is_err());
        let mut negative=report.clone();negative["proof"]["rows"][0]["b64Decimal"]=json!("-1");assert!(validate_ui_report(&negative,RUN,"grid-bit-blob").is_err());
        let mut long=report.clone();long["proof"]["rows"][0]["b64Decimal"]=json!("1".repeat(41));assert!(validate_ui_report(&long,RUN,"grid-bit-blob").is_err());
        let mut empty=report.clone();empty["proof"]["rows"][0]["b64Decimal"]=json!("");assert!(validate_ui_report(&empty,RUN,"grid-bit-blob").is_err());
    }
    #[test] fn mysql_host_binary_none_requires_four_stages_and_native_counts(){
        let run=binary_fixture();let secrets=AcceptanceSecrets::new(&run);
        secrets.gets.store(1,Ordering::Relaxed);secrets.hits.store(1,Ordering::Relaxed);
        run.record("connectConnection",true,0);
        assert!(run.retain_ui_report(&successful_binary_report(),&secrets).is_err());
        for step in 0..4{
            mock_binary_stage(&run,step);
            let snapshot=run.snapshot(&secrets).unwrap();
            binary_green_native(&snapshot,step).unwrap();
            let mut wrong=snapshot.clone();wrong["methods"]["executeStatement"]["success"]=json!(99);assert!(binary_green_native(&wrong,step).is_err());
            let payload=binary_request(step);run.binary_checkpoint(&payload,&secrets).unwrap();
            publish_commit_json(&run.root,CommitFile::BinaryAck,step,&binary_ack(&run,step,&payload,true)).unwrap();
            run.binary_continue(&binary_continue_request(step)).unwrap();
        }
        let mut wrong=successful_binary_report();wrong["proof"]["stages"]["committed"]["witnessConnectionId"]=json!(456);assert!(run.retain_ui_report(&wrong,&secrets).is_err());
        let mut missing=successful_binary_report();missing["proof"]["stages"]["draft"]=Value::Null;assert!(run.retain_ui_report(&missing,&secrets).is_err());
        assert!(run.retain_ui_report(&successful_binary_report(),&secrets).unwrap());
        assert!(run.retain_ui_report(&successful_binary_report(),&secrets).is_err());
        let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-bit-blob-{}.json",std::process::id()))).unwrap();
        assert_eq!(saved["observations"]["binary"]["lastApplyResult"]["affected"],1);
        assert_eq!(saved["observations"]["binary"]["lastObservedTransactionState"],json!({"active":false,"pendingAffected":0}));
        assert_eq!(saved["observations"]["methods"]["executeStatement"]["success"],6);
        assert_eq!(saved["observations"]["methods"]["commitTransaction"]["success"],2);
        assert_eq!(saved["observations"]["methods"]["applyEdits"]["success"],1);
    }
    #[test] fn mysql_host_binary_native_counts_are_never_pre_rejected(){
        let run=binary_fixture();let secrets=AcceptanceSecrets::new(&run);
        for _ in 0..7{run.record("executeStatement",true,0);}
        run.record("applyEdits",true,0);
        run.record("fetchCellValue",true,0);
        let mut report=successful_binary_report();
        for name in ["blob_editable_entry","local_edits","apply_succeeded","committed_reload_verified"]{report["checks"][name]=json!(false);}
        report["failureCode"]=json!("READ_ONLY_BINARY");
        report["proof"]["stages"]=json!({"baseline":binary_stage(0),"draft":Value::Null,"applied":Value::Null,"committed":Value::Null});
        assert!(!run.retain_ui_report(&report,&secrets).unwrap());
        let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-bit-blob-{}.json",std::process::id()))).unwrap();
        assert_eq!(saved["observations"]["methods"]["executeStatement"]["success"],7);
        assert_eq!(saved["observations"]["methods"]["fetchCellValue"]["success"],1);
        // The real count of the first run stays the planned one for the capability red.
        let run=binary_fixture();let secrets=AcceptanceSecrets::new(&run);
        mock_binary_stage(&run,0);
        let snapshot=run.snapshot(&secrets).unwrap();
        assert_eq!(snapshot["methods"]["executeStatement"]["success"],3);
        assert_eq!(snapshot["methods"]["commitTransaction"]["success"],1);
        // The method was never called, so the snapshot keeps no applyEdits entry at all.
        assert!(snapshot["methods"].get("applyEdits").is_none());
        binary_green_native(&snapshot,0).unwrap();
    }
    #[test] fn mysql_host_binary_files_reject_links_bounds_and_preserve_existing(){
        let run=binary_fixture();let(pending,target)=commit_paths(&run.root,CommitFile::BinaryCheckpoint,0).unwrap();
        create_private_json(&target,&json!({"retained":true})).unwrap();let bytes=fs::read(&target).unwrap();
        assert!(run.binary_checkpoint(&binary_request(0),&AcceptanceSecrets::new(&run)).is_err());
        assert_eq!(fs::read(&target).unwrap(),bytes);assert!(!pending.exists());
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;
            for mode in 0..4{
                let run=binary_fixture();run.binary_checkpoint(&binary_request(0),&AcceptanceSecrets::new(&run)).unwrap();
                let(_,path)=commit_paths(&run.root,CommitFile::BinaryAck,0).unwrap();let evidence=owned_evidence(&run.root).unwrap();
                match mode{
                    0=>{create_private_json(&path,&binary_ack(&run,0,&binary_request(0),true)).unwrap();fs::set_permissions(&path,fs::Permissions::from_mode(0o644)).unwrap();},
                    1=>{create_private_json(&path,&json!({"large":"x".repeat(2049)})).unwrap();},
                    2=>{let owned=evidence.join("owned-target");create_private_json(&owned,&json!({})).unwrap();ensure_absent(&path).unwrap();std::os::unix::fs::symlink(owned,&path).unwrap();},
                    _=>{create_private_json(&path,&json!({})).unwrap();let alias=evidence.join("owned-alias");ensure_absent(&alias).unwrap();fs::hard_link(&path,alias).unwrap();},
                }
                assert!(run.binary_continue(&binary_continue_request(0)).is_err());
                assert!(!run.binary_handshake.lock().unwrap().confirmed[0]);
            }
        }
    }
    #[test] fn mysql_host_binary_actual_is_never_replaced_by_expected(){
        let run=binary_fixture();let secrets=AcceptanceSecrets::new(&run);
        let result=Ok(json!({"ok":false,"affected":0,"inTransaction":true,"outcomes":[{"error":"synthetic-error-not-retained","sql":"synthetic-template-not-retained"}]}));
        run.record("applyEdits",result.is_ok(),0);run.record_binary_result("applyEdits",&result);
        run.record_binary_result("transactionState",&Ok(json!({"active":true,"pendingAffected":1})));
        let snapshot=run.snapshot(&secrets).unwrap();
        assert_eq!(snapshot["binary"]["lastApplyResult"],json!({"ok":false,"affected":0,"inTransaction":true,"outcomeCount":1,"failedOutcomeCount":1,"errorClass":"other"}));
        assert_eq!(snapshot["binary"]["lastObservedTransactionState"],json!({"active":true,"pendingAffected":1}));
        assert_eq!(snapshot["methods"]["applyEdits"]["success"],1);
        let encoded=serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("synthetic-error"));assert!(!encoded.contains("synthetic-template"));
        run.record_binary_result("applyEdits",&Err(AppError::new("driver-failed","synthetic")));
        assert_eq!(run.snapshot(&secrets).unwrap()["binary"],snapshot["binary"]);
        // The expected green shape never overwrites the observed red.
        assert!(binary_green_native(&snapshot,0).is_err());
        // A product red keeps its actual blob fields even when they disagree with each other.
        let red_run=binary_fixture();let red_secrets=AcceptanceSecrets::new(&red_run);
        let mut red=successful_binary_report();
        for name in ["blob_editable_entry","local_edits","apply_succeeded","committed_reload_verified"]{red["checks"][name]=json!(false);}
        red["failureCode"]=json!("BLOB_VALUE_MISMATCH");
        red["proof"]["rows"][2]["binHex"]=Value::Null;
        assert!(!red_run.retain_ui_report(&red,&red_secrets).unwrap());
        let saved=read_private_json(&red_run.root.join("evidence").join(format!("ui-grid-bit-blob-{}.json",std::process::id()))).unwrap();
        assert_eq!(saved["report"]["failureCode"],"BLOB_VALUE_MISMATCH");
        assert!(saved["report"]["proof"]["rows"][2]["binHex"].is_null());
        assert_eq!(saved["report"]["proof"]["rows"][2]["binIsNull"],false);
        assert_eq!(saved["report"]["proof"]["rows"][2]["binByteLength"],0);
    }
    #[test] fn mysql_host_binary_proof_stage_gap_editor_and_failure_bounds(){
        let report=successful_binary_report();
        assert!(validate_ui_report(&report,RUN,"grid-bit-blob").unwrap());
        assert!(validate_ui_report(&report,RUN,"grid-time").is_err());
        for(pointer,value)in[("/proof",Value::Null),("/proof/rowCount",json!(3)),("/proof/columnCount",json!(4)),("/proof/rows",json!([binary_row(1,json!("00"),json!(1),false)])),("/proof/rowsSha256",json!("A".repeat(64))),("/proof/columnCategories",json!(["integer","blob","blob"])),("/proof/readonlyGap",json!({"viewerOpened":true})),("/proof/editorOriginal",json!({"raw":"00"})),("/proof/stages",json!({"baseline":binary_stage(0)})),("/proof/stages/baseline/targetRowId",json!(2)),("/proof/stages/baseline/uiPendingAffected",json!(1001)),("/proof/stages/baseline/witnessConnectionId",json!(0)),("/proof/stages/baseline/blobEditableEntry",json!(1)),("/checks/blob_editable_entry",json!(1)),("/actions/click",json!(10001)),("/actions/dblclick",json!(10001)),("/failureCode",json!("UNKNOWN")),("/phase",json!("grid-time"))]{
            let mut changed=report.clone();*changed.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&changed,RUN,"grid-bit-blob").is_err(),"{pointer}");
        }
        for code in BINARY_FAILURES{let mut changed=report.clone();changed["failureCode"]=json!(code);assert!(validate_ui_report(&changed,RUN,"grid-bit-blob").is_ok(),"{code}");}
        let mut extra=report;extra["proof"]["extra"]=json!(1);assert!(validate_ui_report(&extra,RUN,"grid-bit-blob").is_err());
        assert_eq!(BINARY_CHECKS.len(),12);
        assert_eq!(BINARY_FAILURES.len(),16);
    }
    fn session_timezone_fixture()->AcceptanceRun{let(repo,temp,root,manifest)=fixture(RUN);AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();AcceptanceRun::prepare(root,RUN.into(),"session-timezone".into(),manifest,&temp,&repo).unwrap()}
    fn session_timezone_payload(step:usize)->Value{json!({"schemaVersion":1,"step":SESSION_TIMEZONE_STEPS[step],"uiActive":false,"uiPendingAffected":0,"projectionSha256":if step==1{"b".repeat(64)}else{"a".repeat(64)},"connectionId":123,"setFailed":false,"autocommit":true})}
    fn session_timezone_continue_payload(step:usize)->Value{json!({"schemaVersion":1,"step":SESSION_TIMEZONE_STEPS[step]})}
    fn session_timezone_ack(run:&AcceptanceRun,step:usize,payload:&Value,verified:bool)->Value{json!({"schemaVersion":1,"runId":run.run_id,"phase":"session-timezone","pid":std::process::id(),"step":SESSION_TIMEZONE_STEPS[step],"proof":payload,"verified":verified})}
    fn session_timezone_stage_payload(step:usize)->Value{json!({"connectionId":123,"sessionTimezone":if step==1{"+08:00"}else{"+00:00"},"systemTimezone":"UTC","autocommit":true,"epochText":if step==1{"1709181296.123456"}else{"1709210096.123456"},"projectionSha256":if step==1{"b".repeat(64)}else{"a".repeat(64)},"setFailed":false,"uiActive":false,"uiPendingAffected":0})}
    fn mock_session_timezone_stage(run:&AcceptanceRun,step:usize){for _ in 0..(if step==0{1}else{2}){run.record("executeStatement",true,0);}run.record("transactionState",true,0);run.record_session_timezone_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));}
    fn successful_session_timezone_report()->Value{json!({"schemaVersion":1,"runId":RUN,"phase":"session-timezone","actionDriver":"native-dom-synthetic","checks":{"storage_marker":true,"persisted_connection":true,"credential_reconnect":true,"baseline_observed":true,"offset_set":true,"offset_readback":true,"restored_set":true,"restored_readback":true,"same_connection":true,"transaction_unchanged":true},"proof":{"rowCount":1,"baseline":session_timezone_stage_payload(0),"offset":session_timezone_stage_payload(1),"restored":session_timezone_stage_payload(2)},"actions":{"click":5,"input":5,"keydown":0,"dblclick":0},"elapsedMs":500,"failureCode":"NONE"})}
    #[test] fn mysql_host_session_timezone_phase_password_origin_snapshot_scope(){
        let(repo,temp,root,manifest)=fixture(RUN);assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"session-timezone".into(),manifest.clone(),&temp,&repo).is_err());let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();assert!(initial.session_timezone_checkpoint(&session_timezone_payload(0),&AcceptanceSecrets::new(&initial)).is_err());assert!(initial.session_timezone_continue(&session_timezone_continue_payload(0)).is_err());initial.record_session_timezone_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));assert!(initial.snapshot(&AcceptanceSecrets::new(&initial)).unwrap().get("sessionTimezone").is_none());
        let mut run=AcceptanceRun::prepare(root,RUN.into(),"session-timezone".into(),manifest,&temp,&repo).unwrap();run.app_secret=repo.join("missing-not-read.secret");assert_eq!(run.password_script().unwrap_err().code,"unsupported");assert_eq!(run.context()["phase"],"session-timezone");assert_eq!(run.store_id,initial.store_id);assert_eq!(run.namespace(),initial.namespace());let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert!(exact_fields(&snapshot["sessionTimezone"],&["lastObservedTransactionState"]).is_ok());assert!(snapshot["sessionTimezone"]["lastObservedTransactionState"].is_null());let mut probe=initial;probe.phase="restart-probe".into();for method in ["mysqlAcceptanceSessionTimezoneCheckpoint","mysqlAcceptanceSessionTimezoneContinue"]{assert!(!probe.probe_method_allowed(method));}assert!(!bridge_window_allowed("other","tauri://localhost/"));
    }
    #[test] fn mysql_host_session_timezone_payload_baseline_hard_later_wide(){
        for step in 0..3{assert_eq!(session_timezone_step(&session_timezone_payload(step),true).unwrap(),step);assert_eq!(session_timezone_step(&session_timezone_continue_payload(step),false).unwrap(),step);}
        for(key,value)in[("uiActive",json!(true)),("uiPendingAffected",json!(1)),("autocommit",json!(false)),("setFailed",json!(true)),("extra",json!(true))]{let mut payload=session_timezone_payload(0);payload[key]=value;assert!(session_timezone_step(&payload,true).is_err());}
        for step in [1,2]{let mut payload=session_timezone_payload(step);payload["connectionId"]=json!(456);payload["setFailed"]=json!(true);payload["autocommit"]=json!(false);payload["uiActive"]=json!(true);payload["uiPendingAffected"]=json!(1);payload["projectionSha256"]=json!("f".repeat(64));assert!(session_timezone_step(&payload,true).is_ok());}let mut bad=session_timezone_payload(1);bad["autocommit"]=json!(1);assert!(session_timezone_step(&bad,true).is_err());bad=session_timezone_payload(1);bad["connectionId"]=json!(0);assert!(session_timezone_step(&bad,true).is_err());
    }
    #[test] fn mysql_host_session_timezone_order_idempotency_wrapper_and_ack(){
        let run=session_timezone_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.session_timezone_checkpoint(&session_timezone_payload(1),&secrets).is_err());run.session_timezone_checkpoint(&session_timezone_payload(0),&secrets).unwrap();run.session_timezone_checkpoint(&session_timezone_payload(0),&secrets).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::SessionTimezoneCheckpoint,0).unwrap();assert!(exact_fields(&read_private_json(&path).unwrap(),&["schemaVersion","runId","phase","pid","report","observations"]).is_ok());let mut changed=session_timezone_payload(0);changed["projectionSha256"]=json!("f".repeat(64));assert!(run.session_timezone_checkpoint(&changed,&secrets).is_err());assert_eq!(run.session_timezone_continue(&session_timezone_continue_payload(0)).unwrap(),json!({"ready":false,"verified":false}));publish_commit_json(&run.root,CommitFile::SessionTimezoneAck,0,&session_timezone_ack(&run,0,&session_timezone_payload(0),false)).unwrap();assert_eq!(run.session_timezone_continue(&session_timezone_continue_payload(0)).unwrap(),json!({"ready":true,"verified":false}));assert!(run.session_timezone_checkpoint(&session_timezone_payload(1),&secrets).is_err());
        for wrong in [true,false]{let run=session_timezone_fixture();let payload=session_timezone_payload(0);run.session_timezone_checkpoint(&payload,&AcceptanceSecrets::new(&run)).unwrap();let mut ack=session_timezone_ack(&run,0,&payload,true);if wrong{ack["proof"]["connectionId"]=json!(456);}publish_commit_json(&run.root,CommitFile::SessionTimezoneAck,0,&ack).unwrap();if wrong{assert!(run.session_timezone_continue(&session_timezone_continue_payload(0)).is_err());}else{for _ in 0..2{assert_eq!(run.session_timezone_continue(&session_timezone_continue_payload(0)).unwrap(),json!({"ready":true,"verified":true}));}run.session_timezone_checkpoint(&session_timezone_payload(1),&AcceptanceSecrets::new(&run)).unwrap();}}
    }
    #[test] fn mysql_host_session_timezone_actual_successful_state_only(){
        let run=session_timezone_fixture();run.record_session_timezone_result("executeStatement",&Ok(json!({"active":true,"pendingAffected":1})));assert!(run.snapshot(&AcceptanceSecrets::new(&run)).unwrap()["sessionTimezone"]["lastObservedTransactionState"].is_null());run.record_session_timezone_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));let before=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();run.record_session_timezone_result("transactionState",&Err(AppError::new("driver-failed","synthetic-error-not-retained")));run.record_session_timezone_result("commitTransaction",&Ok(json!({"active":true,"pendingAffected":1})));run.record_session_timezone_result("transactionState",&Ok(json!({"active":"bad","pendingAffected":1})));assert_eq!(run.snapshot(&AcceptanceSecrets::new(&run)).unwrap()["sessionTimezone"],before["sessionTimezone"]);run.record("executeStatement",false,0);assert_eq!(run.snapshot(&AcceptanceSecrets::new(&run)).unwrap()["methods"]["executeStatement"]["failure"],1);
    }
    #[test] fn mysql_host_session_timezone_stage_schema_strings_and_green_epoch(){
        let report=successful_session_timezone_report();assert!(validate_ui_report(&report,RUN,"session-timezone").unwrap());assert!(validate_ui_report(&report,RUN,"grid-text").is_err());let mut stage=session_timezone_stage_payload(1);stage["sessionTimezone"]=json!("");stage["systemTimezone"]=json!("差".repeat(64));stage["epochText"]=json!("not-an-expected-epoch");stage["connectionId"]=json!(456);stage["setFailed"]=json!(true);assert!(session_timezone_stage(&stage).is_ok());stage["epochText"]=json!("\n");assert!(session_timezone_stage(&stage).is_err());
        for(pointer,value)in[("/proof",Value::Null),("/proof/offset",Value::Null),("/proof/offset/connectionId",json!(456)),("/proof/offset/sessionTimezone",json!("+00:00")),("/proof/offset/epochText",json!("1709210096.123456")),("/proof/offset/autocommit",json!(false)),("/proof/restored/setFailed",json!(true)),("/proof/offset/uiActive",json!(true)),("/proof/baseline/systemTimezone",json!("SYSTEM")),("/actions/input",json!(4)),("/actions/dblclick",json!(1)),("/actions/click",json!(4)),("/elapsedMs",json!(0.5))]{let mut changed=report.clone();*changed.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&changed,RUN,"session-timezone").is_err());}
    }
    #[test] fn mysql_host_session_timezone_two_ack_set_rejected_readback_retained(){
        let run=session_timezone_fixture();let secrets=AcceptanceSecrets::new(&run);mock_session_timezone_stage(&run,0);let base=session_timezone_payload(0);run.session_timezone_checkpoint(&base,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::SessionTimezoneAck,0,&session_timezone_ack(&run,0,&base,true)).unwrap();run.session_timezone_continue(&session_timezone_continue_payload(0)).unwrap();run.record("executeStatement",false,0);run.record("executeStatement",true,0);run.record_session_timezone_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));let mut payload=session_timezone_payload(1);payload["setFailed"]=json!(true);payload["projectionSha256"]=base["projectionSha256"].clone();run.session_timezone_checkpoint(&payload,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::SessionTimezoneAck,1,&session_timezone_ack(&run,1,&payload,true)).unwrap();run.session_timezone_continue(&session_timezone_continue_payload(1)).unwrap();let mut report=successful_session_timezone_report();report["failureCode"]=json!("SET_REJECTED");for name in ["offset_set","offset_readback","restored_set","restored_readback"]{report["checks"][name]=json!(false);}report["proof"]["offset"]=session_timezone_stage_payload(0);report["proof"]["offset"]["setFailed"]=json!(true);report["proof"]["restored"]=Value::Null;report["actions"]["input"]=json!(3);assert!(!run.retain_ui_report(&report,&secrets).unwrap());let saved=read_private_json(&run.root.join("evidence").join(format!("ui-session-timezone-{}.json",std::process::id()))).unwrap();assert_eq!(saved["observations"]["methods"]["executeStatement"]["success"],2);assert_eq!(saved["observations"]["methods"]["executeStatement"]["failure"],1);assert_eq!(saved["report"]["proof"]["offset"]["epochText"],"1709210096.123456");assert!(!run.session_timezone_handshake.lock().unwrap().confirmed[2]);
    }
    #[test] fn mysql_host_session_timezone_none_requires_three_native_caches_no_writes(){
        let run=session_timezone_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.retain_ui_report(&successful_session_timezone_report(),&secrets).is_err());for step in 0..3{mock_session_timezone_stage(&run,step);let snapshot=run.snapshot(&secrets).unwrap();session_timezone_green_native(&snapshot,step).unwrap();for method in ["commitTransaction","rollbackTransaction","applyEdits","insertRow","deleteRows","fetchCellValue"]{let mut wrong=snapshot.clone();wrong["methods"][method]=json!({"success":1,"failure":0});assert!(session_timezone_green_native(&wrong,step).is_err());}let payload=session_timezone_payload(step);run.session_timezone_checkpoint(&payload,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::SessionTimezoneAck,step,&session_timezone_ack(&run,step,&payload,true)).unwrap();run.session_timezone_continue(&session_timezone_continue_payload(step)).unwrap();}
        let mut wrong=successful_session_timezone_report();for name in SESSION_TIMEZONE_STEPS{wrong["proof"][*name]["connectionId"]=json!(456);}assert!(run.retain_ui_report(&wrong,&secrets).is_err());run.record_session_timezone_result("transactionState",&Ok(json!({"active":true,"pendingAffected":1})));assert!(run.retain_ui_report(&successful_session_timezone_report(),&secrets).is_err());run.record_session_timezone_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));assert!(run.retain_ui_report(&successful_session_timezone_report(),&secrets).unwrap());assert!(run.retain_ui_report(&successful_session_timezone_report(),&secrets).is_err());
    }
    #[test] fn mysql_host_session_timezone_files_reject_links_bounds_preserve_existing(){
        let run=session_timezone_fixture();let(pending,target)=commit_paths(&run.root,CommitFile::SessionTimezoneCheckpoint,0).unwrap();create_private_json(&target,&json!({"retained":true})).unwrap();let bytes=fs::read(&target).unwrap();assert!(run.session_timezone_checkpoint(&session_timezone_payload(0),&AcceptanceSecrets::new(&run)).is_err());assert_eq!(fs::read(&target).unwrap(),bytes);assert!(!pending.exists());
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;for mode in 0..4{let run=session_timezone_fixture();run.session_timezone_checkpoint(&session_timezone_payload(0),&AcceptanceSecrets::new(&run)).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::SessionTimezoneAck,0).unwrap();let evidence=owned_evidence(&run.root).unwrap();match mode{0=>{create_private_json(&path,&session_timezone_ack(&run,0,&session_timezone_payload(0),true)).unwrap();fs::set_permissions(&path,fs::Permissions::from_mode(0o644)).unwrap();},1=>{create_private_json(&path,&json!({"large":"x".repeat(2049)})).unwrap();},2=>{let target=evidence.join("owned-target");create_private_json(&target,&json!({})).unwrap();assert!(fs::symlink_metadata(&target).unwrap().is_file());ensure_absent(&path).unwrap();std::os::unix::fs::symlink(target,&path).unwrap();},_=>{create_private_json(&path,&json!({})).unwrap();let alias=evidence.join("owned-alias");ensure_absent(&alias).unwrap();assert!(fs::symlink_metadata(&path).unwrap().is_file());fs::hard_link(&path,alias).unwrap();}}assert!(run.session_timezone_continue(&session_timezone_continue_payload(0)).is_err());}}
    }
    fn text_fixture()->AcceptanceRun{let(repo,temp,root,manifest)=fixture(RUN);AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();AcceptanceRun::prepare(root,RUN.into(),"grid-text".into(),manifest,&temp,&repo).unwrap()}
    fn text_payload(step:usize)->Value{json!({"schemaVersion":1,"step":TEXT_STEPS[step],"uiActive":step==2,"uiPendingAffected":if step==2{1}else{0},"dirtyRows":if step==1{1}else{0},"valuesSha256":if step==0{"a".repeat(64)}else if step==1{"b".repeat(64)}else{"c".repeat(64)},"witnessConnectionId":if step>=2{json!(123)}else{Value::Null},"witnessProjectionSha256":if step>=2{json!("f".repeat(64))}else{Value::Null}})}
    fn text_continue_payload(step:usize)->Value{json!({"schemaVersion":1,"step":TEXT_STEPS[step]})}
    fn text_ack(run:&AcceptanceRun,step:usize,payload:&Value,verified:bool)->Value{json!({"schemaVersion":1,"runId":run.run_id,"phase":"grid-text","pid":std::process::id(),"step":TEXT_STEPS[step],"proof":payload,"verified":verified})}
    fn text_pair()->Value{json!([{"prefixSha256":"a".repeat(64),"prefixCodePoints":1000,"ellipsis":true},{"prefixSha256":"b".repeat(64),"prefixCodePoints":1000,"ellipsis":true}])}
    fn mock_text_stage(run:&AcceptanceRun,step:usize){
        if step==0{for _ in 0..2{run.record("executeStatement",true,0);}run.record("commitTransaction",true,0);run.record_text_result("commitTransaction",&Ok(json!({"active":false,"pendingAffected":0})));}
        if step==2{run.record("executeStatement",true,0);run.record("applyEdits",true,0);run.record_text_result("applyEdits",&Ok(json!({"ok":true,"affected":1,"inTransaction":true,"outcomes":[{"error":null,"sql":"synthetic-template-not-retained"}]})));run.record_text_result("transactionState",&Ok(json!({"active":true,"pendingAffected":1})));}
        if step==3{run.record("commitTransaction",true,0);run.record_text_result("commitTransaction",&Ok(json!({"active":false,"pendingAffected":0})));}for _ in 0..2{run.record("fetchCellValue",true,0);}
    }
    fn successful_text_report()->Value{json!({"schemaVersion":1,"runId":RUN,"phase":"grid-text","actionDriver":"native-dom-synthetic",
        "checks":{"storage_marker":true,"persisted_connection":true,"credential_reconnect":true,"fixture_created":true,"table_open":true,"preview_truncated":true,"baseline_full":true,"editor_full":true,"local_edits":true,"draft_full":true,"apply_succeeded":true,"uncommitted_transaction":true,"applied_full":true,"same_session_witness":true,"normal_commit":true,"committed_full":true,"reloaded_exact_values":true,"transaction_ended":true,"json_integer_exact":true},
        "proof":{"rowCount":1,"editedColumns":2,"baselineLongSha256":"a".repeat(64),"baselineJsonSha256":"b".repeat(64),"draftLongSha256":"c".repeat(64),"draftJsonSha256":"d".repeat(64),"appliedLongSha256":"c".repeat(64),"appliedJsonSha256":"e".repeat(64),"committedLongSha256":"c".repeat(64),"committedJsonSha256":"e".repeat(64),"baselineValuesSha256":"a".repeat(64),"draftValuesSha256":"b".repeat(64),"appliedValuesSha256":"c".repeat(64),"committedValuesSha256":"c".repeat(64),"uncommittedProjectionSha256":"f".repeat(64),"committedProjectionSha256":"f".repeat(64),"witnessConnectionId":123,"uiActiveAfterApply":true,"uiPendingAffectedAfterApply":1,"dirtyRowsBeforeApply":1,"dirtyRowsAfterApply":0,"baselinePreview":text_pair(),"appliedPreview":text_pair(),"committedPreview":text_pair()},"actions":{"click":30,"input":5,"keydown":0,"dblclick":3},"elapsedMs":600,"failureCode":"NONE"})}
    #[test] fn mysql_host_text_phase_password_origin_and_snapshot_scope(){
        let(repo,temp,root,manifest)=fixture(RUN);assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"grid-text".into(),manifest.clone(),&temp,&repo).is_err());let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();assert!(initial.text_checkpoint(&text_payload(0),&AcceptanceSecrets::new(&initial)).is_err());assert!(initial.text_continue(&text_continue_payload(0)).is_err());initial.record_text_result("applyEdits",&Ok(json!({"ok":false})));assert!(initial.snapshot(&AcceptanceSecrets::new(&initial)).unwrap().get("text").is_none());
        let mut run=AcceptanceRun::prepare(root,RUN.into(),"grid-text".into(),manifest,&temp,&repo).unwrap();run.app_secret=repo.join("missing-not-read.secret");assert_eq!(run.password_script().unwrap_err().code,"unsupported");assert_eq!(run.context()["phase"],"grid-text");assert_eq!(run.store_id,initial.store_id);assert_eq!(run.namespace(),initial.namespace());let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert!(exact_fields(&snapshot["text"],&["lastApplyResult","lastObservedTransactionState"]).is_ok());assert!(snapshot["text"]["lastApplyResult"].is_null());let mut probe=initial;probe.phase="restart-probe".into();for method in ["mysqlAcceptanceTextCheckpoint","mysqlAcceptanceTextContinue"]{assert!(!probe.probe_method_allowed(method));}assert!(!bridge_window_allowed("other","tauri://localhost/"));
    }
    #[test] fn mysql_host_text_payload_values_hash_fixed_ends_and_wide_red(){
        for step in 0..4{assert_eq!(text_step(&text_payload(step),true).unwrap(),step);assert_eq!(text_step(&text_continue_payload(step),false).unwrap(),step);}for step in [1,2]{let mut payload=text_payload(step);payload["valuesSha256"]=json!("e".repeat(64));payload["uiActive"]=json!(false);payload["uiPendingAffected"]=json!(0);payload["dirtyRows"]=json!(1);payload["witnessConnectionId"]=Value::Null;payload["witnessProjectionSha256"]=Value::Null;assert!(text_step(&payload,true).is_ok());}
        for(key,value)in[("rowsSha256",json!("a".repeat(64))),("witnessConnectionId",json!(123)),("dirtyRows",json!(1))]{let mut payload=text_payload(0);payload[key]=value;assert!(text_step(&payload,true).is_err());}let mut committed=text_payload(3);committed["witnessProjectionSha256"]=Value::Null;assert!(text_step(&committed,true).is_err());
    }
    #[test] fn mysql_host_text_four_step_idempotency_wrapper_and_ack_equality(){
        let run=text_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.text_checkpoint(&text_payload(1),&secrets).is_err());run.text_checkpoint(&text_payload(0),&secrets).unwrap();run.text_checkpoint(&text_payload(0),&secrets).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::TextCheckpoint,0).unwrap();let wrapper=read_private_json(&path).unwrap();assert!(exact_fields(&wrapper,&["schemaVersion","runId","phase","pid","report","observations"]).is_ok());let mut changed=text_payload(0);changed["valuesSha256"]=json!("b".repeat(64));assert!(run.text_checkpoint(&changed,&secrets).is_err());assert_eq!(run.text_continue(&text_continue_payload(0)).unwrap(),json!({"ready":false,"verified":false}));publish_commit_json(&run.root,CommitFile::TextAck,0,&text_ack(&run,0,&text_payload(0),false)).unwrap();assert_eq!(run.text_continue(&text_continue_payload(0)).unwrap(),json!({"ready":true,"verified":false}));assert!(run.text_checkpoint(&text_payload(1),&secrets).is_err());
        for wrong in [true,false]{let run=text_fixture();let payload=text_payload(0);run.text_checkpoint(&payload,&AcceptanceSecrets::new(&run)).unwrap();let mut ack=text_ack(&run,0,&payload,true);if wrong{ack["proof"]["valuesSha256"]=json!("f".repeat(64));}publish_commit_json(&run.root,CommitFile::TextAck,0,&ack).unwrap();if wrong{assert!(run.text_continue(&text_continue_payload(0)).is_err());}else{for _ in 0..2{assert_eq!(run.text_continue(&text_continue_payload(0)).unwrap(),json!({"ready":true,"verified":true}));}run.text_checkpoint(&text_payload(1),&AcceptanceSecrets::new(&run)).unwrap();}}
    }
    #[test] fn mysql_host_text_actual_ok_false_metadata_never_copies_sql_or_error(){
        let run=text_fixture();let result=Ok(json!({"ok":false,"affected":0,"inTransaction":false,"outcomes":[{"error":"synthetic-error-not-retained","sql":"synthetic-template-not-retained"}]}));run.record("applyEdits",result.is_ok(),0);run.record_text_result("applyEdits",&result);run.record_text_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert_eq!(snapshot["text"]["lastApplyResult"],json!({"ok":false,"affected":0,"inTransaction":false,"outcomeCount":1,"failedOutcomeCount":1,"errorClass":"other"}));assert_eq!(snapshot["methods"]["applyEdits"]["success"],1);assert_eq!(snapshot["methods"]["applyEdits"]["failure"],0);let encoded=serde_json::to_string(&snapshot).unwrap();assert!(!encoded.contains("synthetic-error"));assert!(!encoded.contains("synthetic-template"));run.record_text_result("applyEdits",&Err(AppError::new("driver-failed","synthetic")));assert_eq!(run.snapshot(&AcceptanceSecrets::new(&run)).unwrap()["text"],snapshot["text"]);
    }
    #[test] fn mysql_host_text_preview_pairs_boundaries_allow_actual_bad_prefix(){
        let pair=text_pair();assert!(text_preview_pair(&pair,true).is_ok());for(key,value)in[("prefixCodePoints",json!(16001)),("prefixCodePoints",json!(0.5)),("prefixSha256",json!("A".repeat(64))),("ellipsis",json!(1)),("extra",json!(true))]{let mut changed=pair.clone();changed[0][key]=value;assert!(text_preview_pair(&changed,false).is_err());}let mut bad=pair;bad[0]["prefixCodePoints"]=json!(0);bad[0]["ellipsis"]=json!(false);assert!(text_preview_pair(&bad,false).is_ok());assert!(text_preview_pair(&bad,true).is_err());
    }
    #[test] fn mysql_host_text_final_schema_allows_compact_canonical_difference(){
        let report=successful_text_report();assert_ne!(report["proof"]["draftJsonSha256"],report["proof"]["appliedJsonSha256"]);assert_ne!(report["proof"]["draftValuesSha256"],report["proof"]["appliedValuesSha256"]);assert!(validate_ui_report(&report,RUN,"grid-text").unwrap());assert!(validate_ui_report(&report,RUN,"grid-precision").is_err());
        for(pointer,value)in[("/proof",Value::Null),("/proof/committedLongSha256",json!("d".repeat(64))),("/proof/committedJsonSha256",json!("d".repeat(64))),("/proof/uiActiveAfterApply",json!(false)),("/proof/witnessConnectionId",json!(0)),("/proof/appliedPreview/0/prefixCodePoints",json!(1810)),("/proof/baselinePreview/1/ellipsis",json!(false)),("/actions/input",json!(4)),("/actions/dblclick",json!(2)),("/actions/click",json!(29)),("/elapsedMs",json!(0.5))]{let mut changed=report.clone();*changed.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&changed,RUN,"grid-text").is_err());}let mut extra=report;extra["proof"]["extra"]=json!(1);assert!(validate_ui_report(&extra,RUN,"grid-text").is_err());
    }
    #[test] fn mysql_host_text_partial_one_to_four_ack_bad_preview_and_calls_preserved(){
        for count in 1..=4{let run=text_fixture();let secrets=AcceptanceSecrets::new(&run);for step in 0..count{let mut payload=text_payload(step);if step==2{payload["uiActive"]=json!(false);payload["uiPendingAffected"]=json!(0);payload["valuesSha256"]=json!("e".repeat(64));payload["witnessConnectionId"]=Value::Null;payload["witnessProjectionSha256"]=Value::Null;}run.text_checkpoint(&payload,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::TextAck,step,&text_ack(&run,step,&payload,true)).unwrap();run.text_continue(&text_continue_payload(step)).unwrap();}run.record("fetchCellValue",false,0);let mut report=successful_text_report();for value in report["checks"].as_object_mut().unwrap().values_mut(){*value=json!(false);}report["failureCode"]=json!("PREVIEW");report["proof"]["baselinePreview"][0]["prefixCodePoints"]=json!(0);report["proof"]["baselinePreview"][0]["ellipsis"]=json!(false);assert!(!run.retain_ui_report(&report,&secrets).unwrap());let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-text-{}.json",std::process::id()))).unwrap();assert_eq!(saved["report"]["proof"]["baselinePreview"][0]["ellipsis"],false);assert_eq!(saved["observations"]["methods"]["fetchCellValue"]["failure"],1);}
    }
    #[test] fn mysql_host_text_none_requires_four_native_fetch_snapshots_and_commit(){
        let run=text_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.retain_ui_report(&successful_text_report(),&secrets).is_err());for step in 0..4{mock_text_stage(&run,step);let snapshot=run.snapshot(&secrets).unwrap();text_green_native(&snapshot,step).unwrap();let mut wrong=snapshot.clone();wrong["methods"]["fetchCellValue"]["success"]=json!(0);assert!(text_green_native(&wrong,step).is_err());run.text_checkpoint(&text_payload(step),&secrets).unwrap();publish_commit_json(&run.root,CommitFile::TextAck,step,&text_ack(&run,step,&text_payload(step),true)).unwrap();run.text_continue(&text_continue_payload(step)).unwrap();}let mut wrong=successful_text_report();wrong["proof"]["witnessConnectionId"]=json!(456);assert!(run.retain_ui_report(&wrong,&secrets).is_err());assert!(run.retain_ui_report(&successful_text_report(),&secrets).unwrap());assert!(run.retain_ui_report(&successful_text_report(),&secrets).is_err());let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-text-{}.json",std::process::id()))).unwrap();assert_eq!(saved["observations"]["text"]["lastApplyResult"]["inTransaction"],true);assert_eq!(saved["observations"]["text"]["lastObservedTransactionState"]["active"],false);
    }
    #[test] fn mysql_host_text_files_reject_links_bounds_and_preserve_existing(){
        let run=text_fixture();let(pending,target)=commit_paths(&run.root,CommitFile::TextCheckpoint,0).unwrap();create_private_json(&target,&json!({"retained":true})).unwrap();let bytes=fs::read(&target).unwrap();assert!(run.text_checkpoint(&text_payload(0),&AcceptanceSecrets::new(&run)).is_err());assert_eq!(fs::read(&target).unwrap(),bytes);assert!(!pending.exists());
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;for mode in 0..4{let run=text_fixture();run.text_checkpoint(&text_payload(0),&AcceptanceSecrets::new(&run)).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::TextAck,0).unwrap();let evidence=owned_evidence(&run.root).unwrap();match mode{0=>{create_private_json(&path,&text_ack(&run,0,&text_payload(0),true)).unwrap();fs::set_permissions(&path,fs::Permissions::from_mode(0o644)).unwrap();},1=>{create_private_json(&path,&json!({"large":"x".repeat(2049)})).unwrap();},2=>{let target=evidence.join("owned-target");create_private_json(&target,&json!({})).unwrap();assert!(fs::symlink_metadata(&target).unwrap().is_file());ensure_absent(&path).unwrap();std::os::unix::fs::symlink(target,&path).unwrap();},_=>{create_private_json(&path,&json!({})).unwrap();let alias=evidence.join("owned-alias");ensure_absent(&alias).unwrap();assert!(fs::symlink_metadata(&path).unwrap().is_file());fs::hard_link(&path,alias).unwrap();}}assert!(run.text_continue(&text_continue_payload(0)).is_err());}}
    }
    fn precision_fixture()->AcceptanceRun{let(repo,temp,root,manifest)=fixture(RUN);AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();AcceptanceRun::prepare(root,RUN.into(),"grid-precision".into(),manifest,&temp,&repo).unwrap()}
    fn precision_payload(step:usize)->Value{json!({"schemaVersion":1,"step":PRECISION_STEPS[step],"uiActive":step==2,"uiPendingAffected":if step==2{1}else{0},"dirtyRows":if step==1{1}else{0},"rowsSha256":if step==0{"a".repeat(64)}else{"b".repeat(64)},"witnessConnectionId":if step>=2{json!(123)}else{Value::Null},"witnessProjectionSha256":if step>=2{json!("d".repeat(64))}else{Value::Null}})}
    fn precision_continue_payload(step:usize)->Value{json!({"schemaVersion":1,"step":PRECISION_STEPS[step]})}
    fn precision_ack(run:&AcceptanceRun,step:usize,payload:&Value,verified:bool)->Value{json!({"schemaVersion":1,"runId":run.run_id,"phase":"grid-precision","pid":std::process::id(),"step":PRECISION_STEPS[step],"proof":payload,"verified":verified})}
    fn precision_result(ok:bool,transaction:bool)->Value{json!({"ok":ok,"affected":if ok{1}else{0},"inTransaction":transaction,"outcomes":[{"error":if ok{Value::Null}else{json!("synthetic-error-not-retained")},"sql":"synthetic-template-not-retained"}]})}
    fn mock_precision_applied_native(run:&AcceptanceRun,ok:bool,transaction:bool){for _ in 0..3{run.record("executeStatement",true,0);}run.record("commitTransaction",true,0);let result=Ok(precision_result(ok,transaction));run.record("applyEdits",result.is_ok(),0);run.record_precision_result("applyEdits",&result);run.record_precision_result("transactionState",&Ok(json!({"active":transaction,"pendingAffected":if transaction{1}else{0}})));}
    fn successful_precision_report()->Value{json!({"schemaVersion":1,"runId":RUN,"phase":"grid-precision","actionDriver":"native-dom-synthetic",
        "checks":{"storage_marker":true,"persisted_connection":true,"credential_reconnect":true,"fixture_created":true,"table_open":true,"exact_baseline":true,"editor_exact":true,"local_edits":true,"null_empty_distinct":true,"apply_succeeded":true,"uncommitted_transaction":true,"same_session_witness":true,"normal_commit":true,"reloaded_exact_values":true,"transaction_ended":true},
        "proof":{"rowCount":1,"editedColumns":6,"baselineRowsSha256":"a".repeat(64),"draftRowsSha256":"b".repeat(64),"appliedRowsSha256":"b".repeat(64),"committedRowsSha256":"b".repeat(64),"baselineProjectionSha256":"c".repeat(64),"uncommittedProjectionSha256":"d".repeat(64),"committedProjectionSha256":"d".repeat(64),"witnessConnectionId":123,"uiActiveAfterApply":true,"uiPendingAffectedAfterApply":1,"dirtyRowsAfterApply":0,"dirtyRowsBeforeApply":1},"actions":{"click":20,"input":8,"keydown":0,"dblclick":7},"elapsedMs":600,"failureCode":"NONE"})}
    #[test] fn mysql_host_precision_phase_password_origin_and_snapshot_scope(){
        let(repo,temp,root,manifest)=fixture(RUN);assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"grid-precision".into(),manifest.clone(),&temp,&repo).is_err());let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();assert!(initial.precision_checkpoint(&precision_payload(0),&AcceptanceSecrets::new(&initial)).is_err());assert!(initial.precision_continue(&precision_continue_payload(0)).is_err());initial.record_precision_result("applyEdits",&Ok(precision_result(false,false)));assert!(initial.snapshot(&AcceptanceSecrets::new(&initial)).unwrap().get("precision").is_none());
        let mut run=AcceptanceRun::prepare(root,RUN.into(),"grid-precision".into(),manifest,&temp,&repo).unwrap();run.app_secret=repo.join("missing-no-metadata-read.secret");assert_eq!(run.password_script().unwrap_err().code,"unsupported");assert_eq!(run.context()["phase"],"grid-precision");assert_eq!(run.store_id,initial.store_id);assert_eq!(run.namespace(),initial.namespace());let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert!(exact_fields(&snapshot["precision"],&["lastApplyResult","lastObservedTransactionState"]).is_ok());assert!(snapshot["precision"]["lastApplyResult"].is_null());let mut probe=initial;probe.phase="restart-probe".into();for method in ["mysqlAcceptancePrecisionCheckpoint","mysqlAcceptancePrecisionContinue"]{assert!(!probe.probe_method_allowed(method));}assert!(!bridge_window_allowed("other","tauri://localhost/"));
    }
    #[test] fn mysql_host_precision_payload_fixed_ends_and_partial_red_allowed(){
        for step in 0..4{assert_eq!(precision_step(&precision_payload(step),true).unwrap(),step);assert_eq!(precision_step(&precision_continue_payload(step),false).unwrap(),step);}
        for step in [1,2]{let mut partial=precision_payload(step);partial["uiActive"]=json!(false);partial["uiPendingAffected"]=json!(0);partial["dirtyRows"]=json!(1);partial["rowsSha256"]=json!("f".repeat(64));partial["witnessConnectionId"]=Value::Null;partial["witnessProjectionSha256"]=Value::Null;assert!(precision_step(&partial,true).is_ok());}
        for(key,value)in[("witnessConnectionId",json!(123)),("uiActive",json!(true)),("dirtyRows",json!(1)),("extra",json!(1))]{let mut payload=precision_payload(0);payload[key]=value;assert!(precision_step(&payload,true).is_err());}
        for(key,value)in[("witnessConnectionId",Value::Null),("witnessProjectionSha256",Value::Null),("uiPendingAffected",json!(1))]{let mut payload=precision_payload(3);payload[key]=value;assert!(precision_step(&payload,true).is_err());}
        let mut payload=precision_payload(2);payload["rowsSha256"]=json!("A".repeat(64));assert!(precision_step(&payload,true).is_err());
    }
    #[test] fn mysql_host_precision_four_step_order_idempotency_and_ack_gate(){
        let run=precision_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.precision_checkpoint(&precision_payload(1),&secrets).is_err());run.precision_checkpoint(&precision_payload(0),&secrets).unwrap();run.precision_checkpoint(&precision_payload(0),&secrets).unwrap();assert_eq!(run.precision_continue(&precision_continue_payload(0)).unwrap(),json!({"ready":false,"verified":false}));publish_commit_json(&run.root,CommitFile::PrecisionAck,0,&precision_ack(&run,0,&precision_payload(0),false)).unwrap();assert_eq!(run.precision_continue(&precision_continue_payload(0)).unwrap(),json!({"ready":true,"verified":false}));assert!(run.precision_checkpoint(&precision_payload(1),&secrets).is_err());
        for wrong in [true,false]{let run=precision_fixture();let payload=precision_payload(0);run.precision_checkpoint(&payload,&AcceptanceSecrets::new(&run)).unwrap();let mut ack=precision_ack(&run,0,&payload,true);if wrong{ack["proof"]["rowsSha256"]=json!("f".repeat(64));}publish_commit_json(&run.root,CommitFile::PrecisionAck,0,&ack).unwrap();if wrong{assert!(run.precision_continue(&precision_continue_payload(0)).is_err());}else{for _ in 0..2{assert_eq!(run.precision_continue(&precision_continue_payload(0)).unwrap(),json!({"ready":true,"verified":true}));}assert!(run.precision_checkpoint(&precision_payload(2),&AcceptanceSecrets::new(&run)).is_err());run.precision_checkpoint(&precision_payload(1),&AcceptanceSecrets::new(&run)).unwrap();}}
    }
    #[test] fn mysql_host_precision_actual_apply_metadata_no_text_or_state_synthesis(){
        let run=precision_fixture();mock_precision_applied_native(&run,false,false);let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert_eq!(snapshot["precision"]["lastApplyResult"],json!({"ok":false,"affected":0,"inTransaction":false,"outcomeCount":1,"failedOutcomeCount":1,"errorClass":"other"}));assert_eq!(snapshot["methods"]["applyEdits"]["success"],1);assert_eq!(snapshot["methods"]["applyEdits"]["failure"],0);assert_eq!(snapshot["precision"]["lastObservedTransactionState"],json!({"active":false,"pendingAffected":0}));let encoded=serde_json::to_string(&snapshot).unwrap();assert!(!encoded.contains("synthetic-error"));assert!(!encoded.contains("synthetic-template"));run.record_precision_result("applyEdits",&Err(AppError::new("driver-failed","synthetic")));assert_eq!(run.snapshot(&AcceptanceSecrets::new(&run)).unwrap()["precision"],snapshot["precision"]);
    }
    #[test] fn mysql_host_precision_files_reject_links_bounds_and_preserve_existing(){
        let run=precision_fixture();let(pending,target)=commit_paths(&run.root,CommitFile::PrecisionCheckpoint,0).unwrap();create_private_json(&target,&json!({"retained":true})).unwrap();let bytes=fs::read(&target).unwrap();assert!(run.precision_checkpoint(&precision_payload(0),&AcceptanceSecrets::new(&run)).is_err());assert_eq!(fs::read(&target).unwrap(),bytes);assert!(!pending.exists());
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;for mode in 0..4{let run=precision_fixture();run.precision_checkpoint(&precision_payload(0),&AcceptanceSecrets::new(&run)).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::PrecisionAck,0).unwrap();let evidence=owned_evidence(&run.root).unwrap();match mode{0=>{create_private_json(&path,&precision_ack(&run,0,&precision_payload(0),true)).unwrap();fs::set_permissions(&path,fs::Permissions::from_mode(0o644)).unwrap();},1=>{create_private_json(&path,&json!({"large":"x".repeat(2049)})).unwrap();},2=>{let target=evidence.join("owned-target");create_private_json(&target,&json!({})).unwrap();assert!(fs::symlink_metadata(&target).unwrap().is_file());ensure_absent(&path).unwrap();std::os::unix::fs::symlink(target,&path).unwrap();},_=>{create_private_json(&path,&json!({})).unwrap();let alias=evidence.join("owned-alias");ensure_absent(&alias).unwrap();assert!(fs::symlink_metadata(&path).unwrap().is_file());fs::hard_link(&path,alias).unwrap();}}assert!(run.precision_continue(&precision_continue_payload(0)).is_err());}}
    }
    #[test] fn mysql_host_precision_final_schema_hash_witness_actions_bounds(){
        let report=successful_precision_report();assert!(validate_ui_report(&report,RUN,"grid-precision").unwrap());assert!(validate_ui_report(&report,RUN,"grid-timeout").is_err());
        for(pointer,value)in[("/proof",Value::Null),("/proof/editedColumns",json!(5)),("/proof/draftRowsSha256",json!("a".repeat(64))),("/proof/appliedRowsSha256",json!("e".repeat(64))),("/proof/committedProjectionSha256",json!("f".repeat(64))),("/proof/uiActiveAfterApply",json!(false)),("/proof/uiPendingAffectedAfterApply",json!(0)),("/proof/dirtyRowsAfterApply",json!(1)),("/proof/dirtyRowsBeforeApply",json!(0)),("/proof/witnessConnectionId",json!(0)),("/actions/input",json!(7)),("/actions/dblclick",json!(6)),("/actions/click",json!(19)),("/elapsedMs",json!(0.5))]{let mut changed=report.clone();*changed.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&changed,RUN,"grid-precision").is_err());}let mut extra=report;extra["proof"]["extra"]=json!(1);assert!(validate_ui_report(&extra,RUN,"grid-precision").is_err());
    }
    #[test] fn mysql_host_precision_three_ack_bad_values_partial_report_preserved(){
        let run=precision_fixture();let secrets=AcceptanceSecrets::new(&run);for step in 0..3{let mut payload=precision_payload(step);if step==2{payload["uiActive"]=json!(false);payload["uiPendingAffected"]=json!(0);payload["dirtyRows"]=json!(1);payload["rowsSha256"]=json!("e".repeat(64));payload["witnessConnectionId"]=Value::Null;payload["witnessProjectionSha256"]=Value::Null;mock_precision_applied_native(&run,false,false);}run.precision_checkpoint(&payload,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::PrecisionAck,step,&precision_ack(&run,step,&payload,true)).unwrap();run.precision_continue(&precision_continue_payload(step)).unwrap();}
        let mut report=successful_precision_report();for name in ["apply_succeeded","uncommitted_transaction","same_session_witness","normal_commit","reloaded_exact_values","transaction_ended"]{report["checks"][name]=json!(false);}report["failureCode"]=json!("VALUE_LOSS");report["proof"]["appliedRowsSha256"]=json!("e".repeat(64));report["proof"]["uiActiveAfterApply"]=json!(false);report["proof"]["uiPendingAffectedAfterApply"]=json!(0);report["proof"]["dirtyRowsAfterApply"]=json!(1);report["proof"]["witnessConnectionId"]=Value::Null;report["proof"]["uncommittedProjectionSha256"]=Value::Null;report["proof"]["committedProjectionSha256"]=Value::Null;report["proof"]["committedRowsSha256"]=Value::Null;assert!(!run.retain_ui_report(&report,&secrets).unwrap());assert!(!run.precision_handshake.lock().unwrap().confirmed[3]);
    }
    #[test] fn mysql_host_precision_none_requires_four_ack_applied_native_and_commit(){
        let run=precision_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.retain_ui_report(&successful_precision_report(),&secrets).is_err());for step in 0..4{if step==2{mock_precision_applied_native(&run,true,true);}run.precision_checkpoint(&precision_payload(step),&secrets).unwrap();publish_commit_json(&run.root,CommitFile::PrecisionAck,step,&precision_ack(&run,step,&precision_payload(step),true)).unwrap();run.precision_continue(&precision_continue_payload(step)).unwrap();}assert!(run.retain_ui_report(&successful_precision_report(),&secrets).is_err());run.record("commitTransaction",true,0);run.record_precision_result("commitTransaction",&Ok(json!({"active":false,"pendingAffected":0})));let mut wrong=successful_precision_report();wrong["proof"]["witnessConnectionId"]=json!(456);assert!(run.retain_ui_report(&wrong,&secrets).is_err());assert!(run.retain_ui_report(&successful_precision_report(),&secrets).unwrap());assert!(run.retain_ui_report(&successful_precision_report(),&secrets).is_err());let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-precision-{}.json",std::process::id()))).unwrap();assert!(exact_fields(&saved,&["schemaVersion","report","observations"]).is_ok());assert_eq!(saved["observations"]["precision"]["lastApplyResult"]["inTransaction"],true);assert_eq!(saved["observations"]["precision"]["lastObservedTransactionState"]["active"],false);
    }
    fn timeout_fixture()->AcceptanceRun{let(repo,temp,root,manifest)=fixture(RUN);AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();AcceptanceRun::prepare(root,RUN.into(),"grid-timeout".into(),manifest,&temp,&repo).unwrap()}
    fn timeout_payload(step:usize)->Value{json!({"schemaVersion":1,"step":TIMEOUT_STEPS[step],"uiActive":step<2,"uiPendingAffected":if step<2{1}else{0},"dirtyRows":if step==1{1}else{0},"row1Value":if step==1{1}else{0},"row3Value":if step<2{7}else{0},"original1205":step>0,"witnessConnectionId":123,"witnessMarkerValue":if step<2{7}else{0},"sessionTimeoutSeconds":5,"rollbackOnTimeout":false})}
    fn timeout_continue_payload(step:usize)->Value{json!({"schemaVersion":1,"step":TIMEOUT_STEPS[step]})}
    fn timeout_ack(run:&AcceptanceRun,step:usize,payload:&Value,verified:bool)->Value{json!({"schemaVersion":1,"runId":run.run_id,"phase":"grid-timeout","pid":std::process::id(),"step":TIMEOUT_STEPS[step],"proof":payload,"verified":verified})}
    fn timeout_result(ok:bool,transaction:bool)->Value{json!({"ok":ok,"affected":if ok{1}else{0},"inTransaction":transaction,"outcomes":[{"error":if ok{Value::Null}else{json!("MySQL SQLSTATE HY000 code 1205")},"sql":"synthetic-private-template-not-retained"}]})}
    fn mock_timeout_failed_native(run:&AcceptanceRun,transaction:bool){for _ in 0..4{run.record("executeStatement",true,0);}run.record("commitTransaction",true,0);for ok in [true,false]{let result=Ok(timeout_result(ok,transaction));run.record("applyEdits",result.is_ok(),0);run.record_timeout_result("applyEdits",&result);}run.record_timeout_result("transactionState",&Ok(json!({"active":transaction,"pendingAffected":if transaction{1}else{0}})));}
    fn successful_timeout_report()->Value{json!({"schemaVersion":1,"runId":RUN,"phase":"grid-timeout","actionDriver":"native-dom-synthetic",
        "checks":{"storage_marker":true,"persisted_connection":true,"credential_reconnect":true,"fixture_created":true,"table_open":true,"marker_applied":true,"session_settings":true,"actor_held":true,"local_draft":true,"original_1205":true,"transaction_preserved":true,"draft_preserved":true,"same_session_witness":true,"rollback_cancel_preserved":true,"normal_rollback":true,"reloaded_baseline":true},
        "proof":{"rowCount":4,"baselineRowsSha256":"a".repeat(64),"markerRowsSha256":"b".repeat(64),"faultRowsSha256":"c".repeat(64),"restoredRowsSha256":"a".repeat(64),"uiActiveAfterError":true,"uiPendingAffectedAfterError":1,"dirtyRowsAfterError":1,"originalErrorClass":"1205","witnessConnectionId":123,"markerValueAfterError":7,"markerValueAfterRollback":0,"sessionTimeoutSeconds":5,"rollbackOnTimeout":false},"actions":{"click":16,"input":6,"keydown":0,"dblclick":3},"elapsedMs":600,"failureCode":"NONE"})}
    #[test] fn mysql_host_timeout_phase_password_origin_and_snapshot_scope(){
        let(repo,temp,root,manifest)=fixture(RUN);assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"grid-timeout".into(),manifest.clone(),&temp,&repo).is_err());let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();assert!(initial.timeout_checkpoint(&timeout_payload(0),&AcceptanceSecrets::new(&initial)).is_err());assert!(initial.timeout_continue(&timeout_continue_payload(0)).is_err());initial.record_timeout_result("applyEdits",&Ok(timeout_result(false,false)));assert!(initial.snapshot(&AcceptanceSecrets::new(&initial)).unwrap().get("timeout").is_none());
        let mut run=AcceptanceRun::prepare(root,RUN.into(),"grid-timeout".into(),manifest,&temp,&repo).unwrap();run.app_secret=repo.join("missing-no-metadata-read.secret");assert_eq!(run.password_script().unwrap_err().code,"unsupported");assert_eq!(run.context()["phase"],"grid-timeout");assert_eq!(run.store_id,initial.store_id);assert_eq!(run.namespace(),initial.namespace());let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert!(exact_fields(&snapshot["timeout"],&["lastApplyResult","lastObservedTransactionState"]).is_ok());assert!(snapshot["timeout"]["lastApplyResult"].is_null());let mut probe=initial;probe.phase="restart-probe".into();for method in ["mysqlAcceptanceTimeoutCheckpoint","mysqlAcceptanceTimeoutContinue"]{assert!(!probe.probe_method_allowed(method));}assert!(!bridge_window_allowed("other","tauri://localhost/"));
    }
    #[test] fn mysql_host_timeout_marker_settings_hard_gate_failed_bad_state_allowed(){
        for step in 0..3{assert_eq!(timeout_step(&timeout_payload(step),true).unwrap(),step);assert_eq!(timeout_step(&timeout_continue_payload(step),false).unwrap(),step);}
        for(key,value)in[("sessionTimeoutSeconds",json!(50)),("rollbackOnTimeout",json!(true)),("witnessConnectionId",Value::Null),("witnessMarkerValue",json!(0)),("uiActive",json!(false)),("dirtyRows",json!(1)),("extra",json!(true))]{let mut payload=timeout_payload(0);payload[key]=value;assert!(timeout_step(&payload,true).is_err());}
        let mut failed=timeout_payload(1);failed["uiActive"]=json!(false);failed["uiPendingAffected"]=json!(0);failed["witnessMarkerValue"]=json!(0);failed["sessionTimeoutSeconds"]=json!(50);failed["rollbackOnTimeout"]=json!(true);failed["original1205"]=json!(false);assert!(timeout_step(&failed,true).is_ok());
        for(key,value)in[("sessionTimeoutSeconds",json!(0)),("sessionTimeoutSeconds",json!(3601)),("witnessConnectionId",json!(0)),("row1Value",json!(2)),("row3Value",json!(1)),("rollbackOnTimeout",json!(1))]{let mut payload=timeout_payload(1);payload[key]=value;assert!(timeout_step(&payload,true).is_err());}
    }
    #[test] fn mysql_host_timeout_order_idempotency_missing_wrong_and_false_ack(){
        let run=timeout_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.timeout_checkpoint(&timeout_payload(1),&secrets).is_err());run.timeout_checkpoint(&timeout_payload(0),&secrets).unwrap();run.timeout_checkpoint(&timeout_payload(0),&secrets).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::TimeoutCheckpoint,0).unwrap();assert!(exact_fields(&read_private_json(&path).unwrap(),&["schemaVersion","runId","phase","pid","report","observations"]).is_ok());assert_eq!(run.timeout_continue(&timeout_continue_payload(0)).unwrap(),json!({"ready":false,"verified":false}));publish_commit_json(&run.root,CommitFile::TimeoutAck,0,&timeout_ack(&run,0,&timeout_payload(0),false)).unwrap();assert_eq!(run.timeout_continue(&timeout_continue_payload(0)).unwrap(),json!({"ready":true,"verified":false}));assert!(run.timeout_checkpoint(&timeout_payload(1),&secrets).is_err());
        for wrong in [true,false]{let run=timeout_fixture();let payload=timeout_payload(0);run.timeout_checkpoint(&payload,&AcceptanceSecrets::new(&run)).unwrap();let mut ack=timeout_ack(&run,0,&payload,true);if wrong{ack["proof"]["sessionTimeoutSeconds"]=json!(50);}publish_commit_json(&run.root,CommitFile::TimeoutAck,0,&ack).unwrap();if wrong{assert!(run.timeout_continue(&timeout_continue_payload(0)).is_err());}else{for _ in 0..2{assert_eq!(run.timeout_continue(&timeout_continue_payload(0)).unwrap(),json!({"ready":true,"verified":true}));}run.timeout_checkpoint(&timeout_payload(1),&AcceptanceSecrets::new(&run)).unwrap();}}
    }
    #[test] fn mysql_host_timeout_actual_ok_false_scalars_and_stale_state_retained(){
        let run=timeout_fixture();mock_timeout_failed_native(&run,false);let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();let apply=&snapshot["timeout"]["lastApplyResult"];assert_eq!(*apply,json!({"ok":false,"affected":0,"inTransaction":false,"outcomeCount":1,"failedOutcomeCount":1,"errorClass":"1205"}));assert_eq!(snapshot["methods"]["applyEdits"]["success"],2);assert_eq!(snapshot["methods"]["applyEdits"]["failure"],0);assert_eq!(snapshot["timeout"]["lastObservedTransactionState"],json!({"active":false,"pendingAffected":0}));let encoded=serde_json::to_string(&snapshot).unwrap();assert!(!encoded.contains("synthetic-private-template"));assert!(!encoded.contains("SQLSTATE"));run.record_timeout_result("applyEdits",&Err(AppError::new("driver-failed","synthetic")));assert_eq!(run.snapshot(&AcceptanceSecrets::new(&run)).unwrap()["timeout"]["lastApplyResult"],*apply);
    }
    #[test] fn mysql_host_timeout_files_reject_links_bounds_and_preserve_existing(){
        let run=timeout_fixture();let(pending,target)=commit_paths(&run.root,CommitFile::TimeoutCheckpoint,0).unwrap();create_private_json(&target,&json!({"retained":true})).unwrap();let bytes=fs::read(&target).unwrap();assert!(run.timeout_checkpoint(&timeout_payload(0),&AcceptanceSecrets::new(&run)).is_err());assert_eq!(fs::read(&target).unwrap(),bytes);assert!(!pending.exists());
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;for mode in 0..4{let run=timeout_fixture();run.timeout_checkpoint(&timeout_payload(0),&AcceptanceSecrets::new(&run)).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::TimeoutAck,0).unwrap();let evidence=owned_evidence(&run.root).unwrap();match mode{0=>{create_private_json(&path,&timeout_ack(&run,0,&timeout_payload(0),true)).unwrap();fs::set_permissions(&path,fs::Permissions::from_mode(0o644)).unwrap();},1=>{create_private_json(&path,&json!({"large":"x".repeat(2049)})).unwrap();},2=>{let target=evidence.join("owned-target");create_private_json(&target,&json!({})).unwrap();assert!(fs::symlink_metadata(&target).unwrap().is_file());ensure_absent(&path).unwrap();std::os::unix::fs::symlink(target,&path).unwrap();},_=>{create_private_json(&path,&json!({})).unwrap();let alias=evidence.join("owned-alias");ensure_absent(&alias).unwrap();assert!(fs::symlink_metadata(&path).unwrap().is_file());fs::hard_link(&path,alias).unwrap();}}assert!(run.timeout_continue(&timeout_continue_payload(0)).is_err());}}
    }
    #[test] fn mysql_host_timeout_final_schema_settings_proof_actions_bounds(){
        let report=successful_timeout_report();assert!(validate_ui_report(&report,RUN,"grid-timeout").unwrap());assert!(validate_ui_report(&report,RUN,"grid-duplicate").is_err());
        for(pointer,value)in[("/proof",Value::Null),("/proof/rowCount",json!(3)),("/proof/originalErrorClass",json!("other")),("/proof/uiActiveAfterError",json!(false)),("/proof/uiPendingAffectedAfterError",json!(0)),("/proof/dirtyRowsAfterError",json!(0)),("/proof/witnessConnectionId",json!(0)),("/proof/markerValueAfterError",json!(0)),("/proof/markerValueAfterRollback",json!(7)),("/proof/sessionTimeoutSeconds",json!(50)),("/proof/rollbackOnTimeout",json!(true)),("/actions/input",json!(5)),("/actions/dblclick",json!(2)),("/actions/click",json!(15)),("/elapsedMs",json!(0.5))]{let mut changed=report.clone();*changed.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&changed,RUN,"grid-timeout").is_err());}let mut extra=report;extra["proof"]["extra"]=json!(1);assert!(validate_ui_report(&extra,RUN,"grid-timeout").is_err());
    }
    #[test] fn mysql_host_timeout_two_ack_bad_state_and_settings_partial_preserved(){
        let run=timeout_fixture();let secrets=AcceptanceSecrets::new(&run);for step in 0..2{let mut payload=timeout_payload(step);if step==1{payload["uiActive"]=json!(false);payload["uiPendingAffected"]=json!(0);payload["witnessMarkerValue"]=json!(0);payload["sessionTimeoutSeconds"]=json!(50);payload["rollbackOnTimeout"]=json!(true);mock_timeout_failed_native(&run,false);}run.timeout_checkpoint(&payload,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::TimeoutAck,step,&timeout_ack(&run,step,&payload,true)).unwrap();run.timeout_continue(&timeout_continue_payload(step)).unwrap();}
        let mut report=successful_timeout_report();for name in ["session_settings","transaction_preserved","same_session_witness","rollback_cancel_preserved","normal_rollback","reloaded_baseline"]{report["checks"][name]=json!(false);}report["failureCode"]=json!("SESSION_SETTINGS");report["proof"]["uiActiveAfterError"]=json!(false);report["proof"]["uiPendingAffectedAfterError"]=json!(0);report["proof"]["markerValueAfterError"]=json!(0);report["proof"]["markerValueAfterRollback"]=Value::Null;report["proof"]["restoredRowsSha256"]=Value::Null;report["proof"]["sessionTimeoutSeconds"]=json!(50);report["proof"]["rollbackOnTimeout"]=json!(true);assert!(!run.retain_ui_report(&report,&secrets).unwrap());assert!(!run.timeout_handshake.lock().unwrap().confirmed[2]);
    }
    #[test] fn mysql_host_timeout_none_requires_native_witness_settings_and_rollback(){
        let run=timeout_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.retain_ui_report(&successful_timeout_report(),&secrets).is_err());for step in 0..3{if step==1{mock_timeout_failed_native(&run,true);}run.timeout_checkpoint(&timeout_payload(step),&secrets).unwrap();publish_commit_json(&run.root,CommitFile::TimeoutAck,step,&timeout_ack(&run,step,&timeout_payload(step),true)).unwrap();run.timeout_continue(&timeout_continue_payload(step)).unwrap();}assert!(run.retain_ui_report(&successful_timeout_report(),&secrets).is_err());run.record("rollbackTransaction",true,0);run.record_timeout_result("rollbackTransaction",&Ok(json!({"active":false,"pendingAffected":0})));let mut wrong=successful_timeout_report();wrong["proof"]["witnessConnectionId"]=json!(456);assert!(run.retain_ui_report(&wrong,&secrets).is_err());assert!(run.retain_ui_report(&successful_timeout_report(),&secrets).unwrap());assert!(run.retain_ui_report(&successful_timeout_report(),&secrets).is_err());let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-timeout-{}.json",std::process::id()))).unwrap();assert!(exact_fields(&saved,&["schemaVersion","report","observations"]).is_ok());assert_eq!(saved["observations"]["timeout"]["lastApplyResult"]["ok"],false);
    }
    fn duplicate_fixture()->AcceptanceRun{let(repo,temp,root,manifest)=fixture(RUN);AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();AcceptanceRun::prepare(root,RUN.into(),"grid-duplicate".into(),manifest,&temp,&repo).unwrap()}
    fn duplicate_payload(step:usize)->Value{json!({"schemaVersion":1,"step":DUPLICATE_STEPS[step],"uiActive":step==1,"uiPendingAffected":if step==1{1}else{0},"dirtyRows":if step==1{1}else{0},"row1Unique":if step==1{2}else{1},"row3Value":if step==1{7}else{0},"original1062":step>0,"witnessConnectionId":if step>0{json!(123)}else{Value::Null},"witnessMarkerValue":if step==1{json!(7)}else if step==2{json!(0)}else{Value::Null}})}
    fn duplicate_continue_payload(step:usize)->Value{json!({"schemaVersion":1,"step":DUPLICATE_STEPS[step]})}
    fn duplicate_ack(run:&AcceptanceRun,step:usize,payload:&Value,verified:bool)->Value{json!({"schemaVersion":1,"runId":run.run_id,"phase":"grid-duplicate","pid":std::process::id(),"step":DUPLICATE_STEPS[step],"proof":payload,"verified":verified})}
    fn duplicate_result(ok:bool,transaction:bool)->Value{json!({"ok":ok,"affected":if ok{1}else{0},"inTransaction":transaction,"outcomes":[{"index":0,"affected":if ok{1}else{0},"error":if ok{Value::Null}else{json!("MySQL SQLSTATE 23000 code 1062")},"sql":"synthetic-template-not-retained"}]})}
    fn mock_duplicate_failed_native(run:&AcceptanceRun,transaction:bool){
        for _ in 0..3{run.record("executeStatement",true,0);}run.record("commitTransaction",true,0);
        for ok in [true,false]{let result=Ok(duplicate_result(ok,transaction));run.record("applyEdits",result.is_ok(),0);run.record_duplicate_result("applyEdits",&result);}
        run.record_duplicate_result("transactionState",&Ok(json!({"active":transaction,"pendingAffected":if transaction{1}else{0}})));
    }
    fn successful_duplicate_report()->Value{json!({"schemaVersion":1,"runId":RUN,"phase":"grid-duplicate","actionDriver":"native-dom-synthetic",
        "checks":{"storage_marker":true,"persisted_connection":true,"credential_reconnect":true,"fixture_created":true,"table_open":true,"marker_applied":true,"local_draft":true,"original_1062":true,"transaction_preserved":true,"draft_preserved":true,"same_session_witness":true,"rollback_cancel_preserved":true,"normal_rollback":true,"reloaded_baseline":true},
        "proof":{"rowCount":4,"baselineRowsSha256":"a".repeat(64),"markerRowsSha256":"b".repeat(64),"faultRowsSha256":"c".repeat(64),"restoredRowsSha256":"a".repeat(64),"uiActiveAfterError":true,"uiPendingAffectedAfterError":1,"dirtyRowsAfterError":1,"originalErrorClass":"1062","witnessConnectionId":123,"markerValueAfterError":7,"markerValueAfterRollback":0},"actions":{"click":14,"input":5,"keydown":0,"dblclick":3},"elapsedMs":500,"failureCode":"NONE"})}
    #[test] fn mysql_host_duplicate_phase_scope_password_and_origin_gates(){
        let(repo,temp,root,manifest)=fixture(RUN);assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"grid-duplicate".into(),manifest.clone(),&temp,&repo).is_err());let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();assert!(initial.duplicate_checkpoint(&duplicate_payload(0),&AcceptanceSecrets::new(&initial)).is_err());assert!(initial.duplicate_continue(&duplicate_continue_payload(0)).is_err());
        initial.record_duplicate_result("applyEdits",&Ok(duplicate_result(false,false)));assert!(initial.snapshot(&AcceptanceSecrets::new(&initial)).unwrap().get("duplicate").is_none());
        let mut run=AcceptanceRun::prepare(root,RUN.into(),"grid-duplicate".into(),manifest,&temp,&repo).unwrap();run.app_secret=repo.join("missing-not-read.secret");assert_eq!(run.password_script().unwrap_err().code,"unsupported");assert_eq!(run.context()["phase"],"grid-duplicate");assert_eq!(run.store_id,initial.store_id);assert_eq!(run.namespace(),initial.namespace());let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert!(exact_fields(&snapshot["duplicate"],&["lastApplyResult","lastObservedTransactionState"]).is_ok());assert!(snapshot["duplicate"]["lastApplyResult"].is_null());
        let mut probe=initial;probe.phase="restart-probe".into();for method in ["mysqlAcceptanceDuplicateCheckpoint","mysqlAcceptanceDuplicateContinue"]{assert!(!probe.probe_method_allowed(method));}assert!(!bridge_window_allowed("other","tauri://localhost/"));
    }
    #[test] fn mysql_host_duplicate_payload_fixed_steps_allow_bad_failed_state(){
        for step in 0..3{assert_eq!(duplicate_step(&duplicate_payload(step),true).unwrap(),step);assert_eq!(duplicate_step(&duplicate_continue_payload(step),false).unwrap(),step);}
        let mut failed=duplicate_payload(1);failed["uiActive"]=json!(false);failed["uiPendingAffected"]=json!(0);failed["witnessMarkerValue"]=json!(0);failed["original1062"]=json!(false);assert!(duplicate_step(&failed,true).is_ok());
        for (key,value) in [("extra",json!(true)),("row1Unique",json!(0)),("row3Value",json!(1)),("witnessConnectionId",json!(0)),("witnessMarkerValue",json!(1)),("dirtyRows",json!(2)),("uiPendingAffected",json!(1001))]{let mut payload=duplicate_payload(1);payload[key]=value;assert!(duplicate_step(&payload,true).is_err());}
        let mut base=duplicate_payload(0);base["witnessConnectionId"]=json!(123);assert!(duplicate_step(&base,true).is_err());let mut rolled=duplicate_payload(2);rolled["witnessMarkerValue"]=json!(7);assert!(duplicate_step(&rolled,true).is_err());
    }
    #[test] fn mysql_host_duplicate_order_idempotency_missing_wrong_and_false_ack(){
        let run=duplicate_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.duplicate_checkpoint(&duplicate_payload(1),&secrets).is_err());run.duplicate_checkpoint(&duplicate_payload(0),&secrets).unwrap();run.duplicate_checkpoint(&duplicate_payload(0),&secrets).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::DuplicateCheckpoint,0).unwrap();let wrapper=read_private_json(&path).unwrap();assert!(exact_fields(&wrapper,&["schemaVersion","runId","phase","pid","report","observations"]).is_ok());
        assert_eq!(run.duplicate_continue(&duplicate_continue_payload(0)).unwrap(),json!({"ready":false,"verified":false}));publish_commit_json(&run.root,CommitFile::DuplicateAck,0,&duplicate_ack(&run,0,&duplicate_payload(0),false)).unwrap();assert_eq!(run.duplicate_continue(&duplicate_continue_payload(0)).unwrap(),json!({"ready":true,"verified":false}));assert!(run.duplicate_checkpoint(&duplicate_payload(1),&secrets).is_err());
        for wrong in [true,false]{let run=duplicate_fixture();let payload=duplicate_payload(0);run.duplicate_checkpoint(&payload,&AcceptanceSecrets::new(&run)).unwrap();let mut ack=duplicate_ack(&run,0,&payload,true);if wrong{ack["proof"]["uiActive"]=json!(true);}publish_commit_json(&run.root,CommitFile::DuplicateAck,0,&ack).unwrap();if wrong{assert!(run.duplicate_continue(&duplicate_continue_payload(0)).is_err());}else{for _ in 0..2{assert_eq!(run.duplicate_continue(&duplicate_continue_payload(0)).unwrap(),json!({"ready":true,"verified":true}));}run.duplicate_checkpoint(&duplicate_payload(1),&AcceptanceSecrets::new(&run)).unwrap();}}
    }
    #[test] fn mysql_host_duplicate_actual_ok_false_scalars_preserve_rpc_semantics(){
        let run=duplicate_fixture();mock_duplicate_failed_native(&run,false);let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();let apply=&snapshot["duplicate"]["lastApplyResult"];assert!(exact_fields(apply,&["ok","affected","inTransaction","outcomeCount","failedOutcomeCount","errorClass"]).is_ok());assert_eq!(*apply,json!({"ok":false,"affected":0,"inTransaction":false,"outcomeCount":1,"failedOutcomeCount":1,"errorClass":"1062"}));assert_eq!(snapshot["methods"]["applyEdits"]["success"],2);assert_eq!(snapshot["methods"]["applyEdits"]["failure"],0);assert_eq!(snapshot["duplicate"]["lastObservedTransactionState"],json!({"active":false,"pendingAffected":0}));let encoded=serde_json::to_string(&snapshot).unwrap();assert!(!encoded.contains("synthetic-template-not-retained"));assert!(!encoded.contains("SQLSTATE"));
        run.record_duplicate_result("applyEdits",&Err(AppError::new("driver-failed","synthetic")));assert_eq!(run.snapshot(&AcceptanceSecrets::new(&run)).unwrap()["duplicate"]["lastApplyResult"],*apply);
    }
    #[test] fn mysql_host_duplicate_files_reject_links_bounds_and_preserve_existing(){
        let run=duplicate_fixture();let(pending,target)=commit_paths(&run.root,CommitFile::DuplicateCheckpoint,0).unwrap();create_private_json(&target,&json!({"retained":true})).unwrap();let bytes=fs::read(&target).unwrap();assert!(run.duplicate_checkpoint(&duplicate_payload(0),&AcceptanceSecrets::new(&run)).is_err());assert_eq!(fs::read(target).unwrap(),bytes);assert!(!pending.exists());
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;for mode in 0..4{let run=duplicate_fixture();run.duplicate_checkpoint(&duplicate_payload(0),&AcceptanceSecrets::new(&run)).unwrap();let(_,path)=commit_paths(&run.root,CommitFile::DuplicateAck,0).unwrap();let evidence=owned_evidence(&run.root).unwrap();match mode{0=>{create_private_json(&path,&duplicate_ack(&run,0,&duplicate_payload(0),true)).unwrap();fs::set_permissions(&path,fs::Permissions::from_mode(0o644)).unwrap();},1=>{create_private_json(&path,&json!({"large":"x".repeat(2049)})).unwrap();},2=>{let target=evidence.join("owned-target");create_private_json(&target,&json!({})).unwrap();assert!(fs::symlink_metadata(&target).unwrap().is_file());ensure_absent(&path).unwrap();std::os::unix::fs::symlink(target,&path).unwrap();},_=>{create_private_json(&path,&json!({})).unwrap();let alias=evidence.join("owned-alias");ensure_absent(&alias).unwrap();assert!(fs::symlink_metadata(&path).unwrap().is_file());fs::hard_link(&path,alias).unwrap();}}assert!(run.duplicate_continue(&duplicate_continue_payload(0)).is_err());}}
    }
    #[test] fn mysql_host_duplicate_final_schema_proof_actions_and_phase_bounds(){
        let report=successful_duplicate_report();assert!(validate_ui_report(&report,RUN,"grid-duplicate").unwrap());assert!(validate_ui_report(&report,RUN,"grid-deadlock").is_err());
        for(pointer,value)in[("/proof",Value::Null),("/proof/rowCount",json!(3)),("/proof/originalErrorClass",json!("other")),("/proof/uiActiveAfterError",json!(false)),("/proof/uiPendingAffectedAfterError",json!(0)),("/proof/dirtyRowsAfterError",json!(0)),("/proof/witnessConnectionId",json!(0)),("/proof/markerValueAfterError",json!(0)),("/proof/markerValueAfterRollback",json!(7)),("/proof/restoredRowsSha256",json!("d".repeat(64))),("/actions/input",json!(4)),("/actions/click",json!(13)),("/actions/dblclick",json!(2)),("/elapsedMs",json!(0.5))]{let mut value_report=report.clone();*value_report.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&value_report,RUN,"grid-duplicate").is_err());}
        let mut extra=report;extra["proof"]["extra"]=json!(1);assert!(validate_ui_report(&extra,RUN,"grid-duplicate").is_err());
    }
    #[test] fn mysql_host_duplicate_two_ack_bad_state_partial_report_retained(){
        let run=duplicate_fixture();let secrets=AcceptanceSecrets::new(&run);for step in 0..2{let mut payload=duplicate_payload(step);if step==1{payload["uiActive"]=json!(false);payload["uiPendingAffected"]=json!(0);payload["witnessMarkerValue"]=json!(0);mock_duplicate_failed_native(&run,false);}run.duplicate_checkpoint(&payload,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::DuplicateAck,step,&duplicate_ack(&run,step,&payload,true)).unwrap();run.duplicate_continue(&duplicate_continue_payload(step)).unwrap();}
        let mut report=successful_duplicate_report();for name in ["transaction_preserved","same_session_witness","rollback_cancel_preserved","normal_rollback","reloaded_baseline"]{report["checks"][name]=json!(false);}report["failureCode"]=json!("TRANSACTION_LOST");report["proof"]["uiActiveAfterError"]=json!(false);report["proof"]["uiPendingAffectedAfterError"]=json!(0);report["proof"]["markerValueAfterError"]=json!(0);report["proof"]["markerValueAfterRollback"]=Value::Null;report["proof"]["restoredRowsSha256"]=Value::Null;assert!(!run.retain_ui_report(&report,&secrets).unwrap());assert!(!run.duplicate_handshake.lock().unwrap().confirmed[2]);
    }
    #[test] fn mysql_host_duplicate_none_requires_native_witness_rollback_and_three_ack(){
        let run=duplicate_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.retain_ui_report(&successful_duplicate_report(),&secrets).is_err());
        for step in 0..3{if step==1{mock_duplicate_failed_native(&run,true);}run.duplicate_checkpoint(&duplicate_payload(step),&secrets).unwrap();publish_commit_json(&run.root,CommitFile::DuplicateAck,step,&duplicate_ack(&run,step,&duplicate_payload(step),true)).unwrap();run.duplicate_continue(&duplicate_continue_payload(step)).unwrap();}
        assert!(run.retain_ui_report(&successful_duplicate_report(),&secrets).is_err());run.record("rollbackTransaction",true,0);run.record_duplicate_result("rollbackTransaction",&Ok(json!({"active":false,"pendingAffected":0})));let mut wrong=successful_duplicate_report();wrong["proof"]["witnessConnectionId"]=json!(456);assert!(run.retain_ui_report(&wrong,&secrets).is_err());
        assert!(run.retain_ui_report(&successful_duplicate_report(),&secrets).unwrap());assert!(run.retain_ui_report(&successful_duplicate_report(),&secrets).is_err());let saved=read_private_json(&run.root.join("evidence").join(format!("ui-grid-duplicate-{}.json",std::process::id()))).unwrap();assert!(exact_fields(&saved,&["schemaVersion","report","observations"]).is_ok());assert_eq!(saved["observations"]["duplicate"]["lastApplyResult"]["ok"],false);
    }
    fn deadlock_fixture()->AcceptanceRun {
        let(repo,temp,root,manifest)=fixture(RUN);AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        AcceptanceRun::prepare(root,RUN.into(),"grid-deadlock".into(),manifest,&temp,&repo).unwrap()
    }
    fn deadlock_payload(step:usize)->Value {json!({"schemaVersion":1,"step":DEADLOCK_STEPS[step],"uiActive":step>0,"uiPendingAffected":if step>0{1}else{0},"dirtyRows":if step==2{1}else{0},"row1Value":if step==2{1}else{0},"row3Value":if step>0{7}else{0},"original1213":step==2,"rollbackNotice":false})}
    fn deadlock_ack(run:&AcceptanceRun,step:usize,payload:&Value,verified:bool)->Value {json!({"schemaVersion":1,"runId":run.run_id,"phase":"grid-deadlock","pid":std::process::id(),"step":DEADLOCK_STEPS[step],"proof":payload,"verified":verified})}
    fn deadlock_continue_payload(step:usize)->Value {json!({"schemaVersion":1,"step":DEADLOCK_STEPS[step]})}
    fn successful_deadlock_report()->Value {
        json!({"schemaVersion":1,"runId":RUN,"phase":"grid-deadlock","actionDriver":"native-dom-synthetic",
        "checks":{"storage_marker":true,"persisted_connection":true,"credential_reconnect":true,"fixture_created":true,"table_open":true,"marker_applied":true,"actor_waited":true,"local_draft":true,"original_1213":true,"transaction_state_correct":true,"draft_preserved":true,"rollback_notice":true,"recovery_guard_cancel":true,"reloaded_baseline":true},
        "proof":{"rowCount":132,"baselineRowsSha256":"a".repeat(64),"markerRowsSha256":"b".repeat(64),"faultRowsSha256":"c".repeat(64),"reloadedRowsSha256":"a".repeat(64),"uiActiveAfterError":false,"uiPendingAffectedAfterError":0,"dirtyRowsAfterError":1,"originalErrorClass":"1213"},
        "actions":{"click":12,"input":4,"keydown":0,"dblclick":3},"elapsedMs":600,"failureCode":"NONE"})
    }
    #[test] fn mysql_host_deadlock_phase_password_source_and_snapshot_scope() {
        let(repo,temp,root,manifest)=fixture(RUN);assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"grid-deadlock".into(),manifest.clone(),&temp,&repo).is_err());
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();assert!(initial.deadlock_checkpoint(&deadlock_payload(0),&AcceptanceSecrets::new(&initial)).is_err());assert!(initial.deadlock_continue(&deadlock_continue_payload(0)).is_err());
        assert!(initial.snapshot(&AcceptanceSecrets::new(&initial)).unwrap().get("deadlock").is_none());
        let mut run=AcceptanceRun::prepare(root,RUN.into(),"grid-deadlock".into(),manifest,&temp,&repo).unwrap();assert_eq!(run.context()["phase"],"grid-deadlock");assert_eq!(run.store_id,initial.store_id);assert_eq!(run.namespace(),initial.namespace());
        run.app_secret=repo.join("missing-not-read.secret");assert_eq!(run.password_script().unwrap_err().code,"unsupported");let snapshot=run.snapshot(&AcceptanceSecrets::new(&run)).unwrap();assert!(exact_fields(&snapshot["deadlock"],&["lastApplyFailureClass","lastObservedTransactionState"]).is_ok());assert_eq!(snapshot["deadlock"]["lastApplyFailureClass"],"none");assert!(snapshot["deadlock"]["lastObservedTransactionState"].is_null());
        let mut probe=initial;probe.phase="restart-probe".into();for method in ["mysqlAcceptanceDeadlockCheckpoint","mysqlAcceptanceDeadlockContinue"]{assert!(!probe.probe_method_allowed(method));}
        assert!(!bridge_window_allowed("other","tauri://localhost/"));assert!(!bridge_window_allowed("main","https://external.invalid/"));
    }
    #[test] fn mysql_host_deadlock_checkpoint_schema_keeps_observed_red() {
        for step in 0..3 {assert_eq!(deadlock_step(&deadlock_payload(step),true).unwrap(),step);assert_eq!(deadlock_step(&deadlock_continue_payload(step),false).unwrap(),step);}
        let mut observed=deadlock_payload(2);observed["original1213"]=json!(false);assert!(deadlock_step(&observed,true).is_ok());observed["uiPendingAffected"]=json!(1000);assert!(deadlock_step(&observed,true).is_ok());
        for (key,value) in [("extra",json!(true)),("uiActive",json!(true)),("uiPendingAffected",json!(1)),("dirtyRows",json!(1)),("row3Value",json!(7)),("original1213",json!(true)),("rollbackNotice",json!(true)),("schemaVersion",json!(2))] {let mut payload=deadlock_payload(0);payload[key]=value;assert!(deadlock_step(&payload,true).is_err());}
        for (key,value) in [("uiPendingAffected",json!(1001)),("row1Value",json!(8)),("dirtyRows",json!(2)),("rollbackNotice",json!(0)),("step",json!("unknown"))] {let mut payload=deadlock_payload(2);payload[key]=value;assert!(deadlock_step(&payload,true).is_err());}
    }
    #[test] fn mysql_host_deadlock_order_payload_idempotency_and_wrapper() {
        let run=deadlock_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.deadlock_checkpoint(&deadlock_payload(1),&secrets).is_err());run.deadlock_checkpoint(&deadlock_payload(0),&secrets).unwrap();
        let (_,path)=commit_paths(&run.root,CommitFile::DeadlockCheckpoint,0).unwrap();let bytes=fs::read(&path).unwrap();run.deadlock_checkpoint(&deadlock_payload(0),&secrets).unwrap();assert_eq!(fs::read(&path).unwrap(),bytes);
        let wrapper=read_private_json(&path).unwrap();assert!(exact_fields(&wrapper,&["schemaVersion","runId","phase","pid","report","observations"]).is_ok());assert_eq!(wrapper["report"],deadlock_payload(0));
        assert_eq!(run.deadlock_continue(&deadlock_continue_payload(0)).unwrap(),json!({"ready":false,"verified":false}));assert!(run.deadlock_checkpoint(&deadlock_payload(1),&secrets).is_err());
        publish_commit_json(&run.root,CommitFile::DeadlockAck,0,&deadlock_ack(&run,0,&deadlock_payload(0),true)).unwrap();for _ in 0..2{assert_eq!(run.deadlock_continue(&deadlock_continue_payload(0)).unwrap(),json!({"ready":true,"verified":true}));}
        assert!(run.deadlock_checkpoint(&deadlock_payload(2),&secrets).is_err());run.deadlock_checkpoint(&deadlock_payload(1),&secrets).unwrap();
        let mut changed=deadlock_payload(1);changed["uiPendingAffected"]=json!(0);assert!(run.deadlock_checkpoint(&changed,&secrets).is_err());
    }
    #[test] fn mysql_host_deadlock_wrong_proof_and_false_ack_do_not_advance() {
        for wrong in [true,false] {let run=deadlock_fixture();let payload=deadlock_payload(0);run.deadlock_checkpoint(&payload,&AcceptanceSecrets::new(&run)).unwrap();let mut ack=deadlock_ack(&run,0,&payload,!wrong);if wrong{ack["proof"]["row1Value"]=json!(1);}publish_commit_json(&run.root,CommitFile::DeadlockAck,0,&ack).unwrap();
            if wrong{assert!(run.deadlock_continue(&deadlock_continue_payload(0)).is_err());}else{assert_eq!(run.deadlock_continue(&deadlock_continue_payload(0)).unwrap(),json!({"ready":true,"verified":true}));}
        }
        let run=deadlock_fixture();run.deadlock_checkpoint(&deadlock_payload(0),&AcceptanceSecrets::new(&run)).unwrap();publish_commit_json(&run.root,CommitFile::DeadlockAck,0,&deadlock_ack(&run,0,&deadlock_payload(0),false)).unwrap();assert_eq!(run.deadlock_continue(&deadlock_continue_payload(0)).unwrap(),json!({"ready":true,"verified":false}));assert!(run.deadlock_checkpoint(&deadlock_payload(1),&AcceptanceSecrets::new(&run)).is_err());assert!(!run.deadlock_handshake.lock().unwrap().confirmed[0]);
    }
    #[test] fn mysql_host_deadlock_ack_identity_links_modes_and_bounds_rejected() {
        for (key,value) in [("runId",json!("wrong")),("phase",json!("commit")),("pid",json!(0)),("step",json!("marker")),("extra",json!(true)),("verified",json!(1))] {let run=deadlock_fixture();run.deadlock_checkpoint(&deadlock_payload(0),&AcceptanceSecrets::new(&run)).unwrap();let mut ack=deadlock_ack(&run,0,&deadlock_payload(0),true);ack[key]=value;publish_commit_json(&run.root,CommitFile::DeadlockAck,0,&ack).unwrap();assert!(run.deadlock_continue(&deadlock_continue_payload(0)).is_err());}
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;
            for mode in 0..4 {let run=deadlock_fixture();run.deadlock_checkpoint(&deadlock_payload(0),&AcceptanceSecrets::new(&run)).unwrap();let (_,path)=commit_paths(&run.root,CommitFile::DeadlockAck,0).unwrap();let evidence=owned_evidence(&run.root).unwrap();
                match mode {0=>{create_private_json(&path,&deadlock_ack(&run,0,&deadlock_payload(0),true)).unwrap();fs::set_permissions(&path,fs::Permissions::from_mode(0o644)).unwrap();},1=>{create_private_json(&path,&json!({"large":"x".repeat(2049)})).unwrap();},2=>{let target=evidence.join("owned-target");create_private_json(&target,&json!({})).unwrap();assert!(fs::symlink_metadata(&target).unwrap().is_file());ensure_absent(&path).unwrap();std::os::unix::fs::symlink(target,&path).unwrap();},_=>{create_private_json(&path,&json!({})).unwrap();let alias=evidence.join("owned-hardlink");assert!(fs::symlink_metadata(&path).unwrap().is_file());ensure_absent(&alias).unwrap();fs::hard_link(&path,alias).unwrap();}}
                assert!(run.deadlock_continue(&deadlock_continue_payload(0)).is_err());assert!(!run.deadlock_handshake.lock().unwrap().confirmed[0]);
            }
        }
    }
    #[test] fn mysql_host_deadlock_actual_result_recorder_never_synthesizes_state() {
        let run=deadlock_fixture();let secrets=AcceptanceSecrets::new(&run);
        run.record_deadlock_result("transactionState",&Ok(json!({"active":true,"pendingAffected":1})));run.record_deadlock_result("applyEdits",&Err(AppError::new("driver-failed","数据库操作失败，请检查连接或查询配置")));
        let snapshot=run.snapshot(&secrets).unwrap();assert_eq!(snapshot["deadlock"]["lastApplyFailureClass"],"other");assert_eq!(snapshot["deadlock"]["lastObservedTransactionState"],json!({"active":true,"pendingAffected":1}));
        run.record_deadlock_result("applyEdits",&Err(AppError::new("driver-failed","SQLSTATE 40001 code 1213")));assert_eq!(run.snapshot(&secrets).unwrap()["deadlock"]["lastApplyFailureClass"],"1213");
        run.record_deadlock_result("transactionState",&Err(AppError::new("driver-failed","synthetic")));assert_eq!(run.snapshot(&secrets).unwrap()["deadlock"]["lastObservedTransactionState"],json!({"active":true,"pendingAffected":1}));
        run.record_deadlock_result("rollbackTransaction",&Ok(json!({"active":false,"pendingAffected":0})));assert_eq!(run.snapshot(&secrets).unwrap()["deadlock"]["lastObservedTransactionState"],json!({"active":false,"pendingAffected":0}));
        assert_eq!(deadlock_failure_class("","SQLSTATE 42000 code 1305"),"1305");assert_eq!(deadlock_failure_class("","arbitrary row1213"),"other");assert!(run.snapshot(&secrets).unwrap()["methods"].as_object().unwrap().is_empty());
    }
    #[test] fn mysql_host_deadlock_final_schema_bounds_and_green_requirements() {
        let report=successful_deadlock_report();assert!(validate_ui_report(&report,RUN,"grid-deadlock").unwrap());assert!(validate_ui_report(&report,RUN,"commit").is_err());
        for (pointer,value) in [("/checks/unknown",json!(true)),("/proof/extra",json!(0)),("/sql",json!("forbidden"))] {let mut value_report=report.clone();let parts:Vec<_>=pointer.trim_start_matches('/').split('/').collect();let mut target=&mut value_report;for part in &parts[..parts.len()-1]{target=&mut target[*part];}target[parts[parts.len()-1]]=value;assert!(validate_ui_report(&value_report,RUN,"grid-deadlock").is_err());}
        for (pointer,value) in [("/proof",Value::Null),("/proof/rowCount",json!(131)),("/proof/markerRowsSha256",json!("a".repeat(64))),("/proof/faultRowsSha256",Value::Null),("/proof/uiActiveAfterError",json!(true)),("/proof/uiPendingAffectedAfterError",json!(1)),("/proof/dirtyRowsAfterError",json!(0)),("/proof/originalErrorClass",json!("1305")),("/proof/reloadedRowsSha256",json!("d".repeat(64))),("/actions/input",json!(3)),("/actions/dblclick",json!(2)),("/actions/click",json!(11)),("/elapsedMs",json!(1.5))] {let mut changed=report.clone();*changed.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&changed,RUN,"grid-deadlock").is_err());}
    }
    #[test] fn mysql_host_deadlock_partial_stale_and_other_error_report_retained() {
        let run=deadlock_fixture();let mut report=successful_deadlock_report();report["failureCode"]=json!("MYSQL_ERROR_DETAILS_LOST");for name in ["original_1213","transaction_state_correct","rollback_notice","recovery_guard_cancel","reloaded_baseline"]{report["checks"][name]=json!(false);}
        report["proof"]["originalErrorClass"]=json!("other");report["proof"]["uiActiveAfterError"]=json!(true);report["proof"]["uiPendingAffectedAfterError"]=json!(1);report["proof"]["reloadedRowsSha256"]=Value::Null;
        run.record_deadlock_result("transactionState",&Ok(json!({"active":true,"pendingAffected":1})));run.record_deadlock_result("applyEdits",&Err(AppError::new("driver-failed","generic")));
        assert!(!run.retain_ui_report(&report,&AcceptanceSecrets::new(&run)).unwrap());let retained=read_private_json(&run.root.join("evidence").join(format!("ui-grid-deadlock-{}.json",std::process::id()))).unwrap();assert_eq!(retained["report"]["proof"]["uiActiveAfterError"],true);assert_eq!(retained["observations"]["deadlock"]["lastApplyFailureClass"],"other");assert_eq!(retained["observations"]["guiVerified"],false);
    }
    #[test] fn mysql_host_deadlock_green_requires_three_ack_and_actual_native_state() {
        let run=deadlock_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.retain_ui_report(&successful_deadlock_report(),&secrets).is_err());
        for step in 0..3 {let mut payload=deadlock_payload(step);if step==2{payload["uiActive"]=json!(false);payload["uiPendingAffected"]=json!(0);payload["rollbackNotice"]=json!(true);}run.deadlock_checkpoint(&payload,&secrets).unwrap();publish_commit_json(&run.root,CommitFile::DeadlockAck,step,&deadlock_ack(&run,step,&payload,true)).unwrap();assert_eq!(run.deadlock_continue(&deadlock_continue_payload(step)).unwrap(),json!({"ready":true,"verified":true}));}
        assert!(run.retain_ui_report(&successful_deadlock_report(),&secrets).is_err());run.record_deadlock_result("applyEdits",&Err(AppError::new("1213","synthetic")));run.record_deadlock_result("transactionState",&Ok(json!({"active":true,"pendingAffected":1})));assert!(run.retain_ui_report(&successful_deadlock_report(),&secrets).is_err());
        run.record_deadlock_result("transactionState",&Ok(json!({"active":false,"pendingAffected":0})));assert!(run.retain_ui_report(&successful_deadlock_report(),&secrets).unwrap());assert!(run.retain_ui_report(&successful_deadlock_report(),&secrets).is_err());
    }
    #[test] fn mysql_host_deadlock_atomic_files_preserve_old_and_other_phase_snapshots() {
        let run=deadlock_fixture();let (pending,target)=commit_paths(&run.root,CommitFile::DeadlockCheckpoint,0).unwrap();create_private_json(&target,&json!({"retained":true})).unwrap();let before=fs::read(&target).unwrap();assert!(run.deadlock_checkpoint(&deadlock_payload(0),&AcceptanceSecrets::new(&run)).is_err());assert_eq!(fs::read(&target).unwrap(),before);assert!(!pending.exists());
        let(repo,temp,root,manifest)=fixture(RUN);let initial=AcceptanceRun::prepare(root,RUN.into(),"initial".into(),manifest,&temp,&repo).unwrap();initial.record_deadlock_result("applyEdits",&Err(AppError::new("1213","synthetic")));let snapshot=initial.snapshot(&AcceptanceSecrets::new(&initial)).unwrap();assert!(exact_fields(&snapshot,&["scope","runId","phase","methods","keyringGets","keyringHits","keyringSets","guiVerified","mysqlVerified","storePersistenceVerified"]).is_ok());
    }
    fn commit_fixture()->AcceptanceRun {
        let(repo,temp,root,manifest)=fixture(RUN);
        AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        AcceptanceRun::prepare(root,RUN.into(),"commit".into(),manifest,&temp,&repo).unwrap()
    }
    fn commit_payload(step:usize)->Value {json!({"schemaVersion":1,"step":COMMIT_STEPS[step],"bodySha256":if step==0 {"a".repeat(64)}else{"b".repeat(64)},"active":step==1,"pendingAffected":if step==1{1}else{0}})}
    fn continue_payload(step:usize)->Value {json!({"schemaVersion":1,"step":COMMIT_STEPS[step]})}
    fn ack_payload(run:&AcceptanceRun,step:usize,verified:bool)->Value {json!({"schemaVersion":1,"runId":run.run_id,"phase":"commit","pid":std::process::id(),"step":COMMIT_STEPS[step],"bodySha256":commit_payload(step)["bodySha256"],"verified":verified})}
    fn successful_commit_report()->Value {
        json!({"schemaVersion":1,"runId":RUN,"phase":"commit","actionDriver":"native-dom-synthetic",
            "checks":{"storage_marker":true,"persisted_connection":true,"credential_reconnect":true,"table_created":true,"baseline_committed":true,"baseline_observed":true,"pending_visible":true,"pending_isolated":true,"commit_clicked":true,"result_refreshed":true,"committed_observed":true,"nontransactional":true},
            "row":{"id":1,"baselineSha256":"a".repeat(64),"pendingSha256":"b".repeat(64),"committedSha256":"b".repeat(64)},"actions":{"click":8,"input":5,"keydown":0},"elapsedMs":500,"failureCode":"NONE"})
    }
    #[test] fn mysql_host_commit_phase_source_and_password_gate() {
        let(repo,temp,root,manifest)=fixture(RUN);assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"commit".into(),manifest.clone(),&temp,&repo).is_err());assert!(!root.exists());
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        assert!(initial.commit_checkpoint(&commit_payload(0),&AcceptanceSecrets::new(&initial)).is_err());assert!(initial.commit_continue(&continue_payload(0)).is_err());
        let mut run=AcceptanceRun::prepare(root,RUN.into(),"commit".into(),manifest,&temp,&repo).unwrap();assert_eq!(run.context()["phase"],"commit");assert_eq!(run.store_id,initial.store_id);assert_eq!(run.namespace(),initial.namespace());
        run.app_secret=repo.join("missing-no-metadata-read.secret");assert_eq!(run.password_script().unwrap_err().code,"unsupported");let secrets=AcceptanceSecrets::new(&run);assert!(secrets.startup_trace.is_some());assert_eq!(run.snapshot(&secrets).unwrap()["phase"],"commit");
        assert!(!bridge_window_allowed("other","tauri://localhost/"));assert!(!bridge_window_allowed("main","https://external.invalid/"));
        let mut probe=initial;probe.phase="restart-probe".into();for method in ["mysqlAcceptanceCommitCheckpoint","mysqlAcceptanceCommitContinue"]{assert!(!probe.probe_method_allowed(method));}
    }
    #[test] fn mysql_host_commit_checkpoint_schema_and_fixed_states() {
        for step in 0..3 {assert_eq!(commit_step(&commit_payload(step),true).unwrap(),step);assert_eq!(commit_step(&continue_payload(step),false).unwrap(),step);}
        for (key,value) in [("extra",json!(true)),("active",json!(true)),("pendingAffected",json!(1)),("bodySha256",json!("A".repeat(64))),("step",json!("unknown")),("schemaVersion",json!(2))] {let mut payload=commit_payload(0);payload[key]=value;assert!(commit_step(&payload,true).is_err());}
        let mut payload=commit_payload(1);payload["pendingAffected"]=json!(0.5);assert!(commit_step(&payload,true).is_err());payload["bodySha256"]=json!("x".repeat(1025));assert!(commit_step(&payload,true).is_err());
        let mut request=continue_payload(0);request["path"]=json!("forbidden");assert!(commit_step(&request,false).is_err());
    }
    #[test] fn mysql_host_commit_order_idempotency_and_missing_ack() {
        let run=commit_fixture();let secrets=AcceptanceSecrets::new(&run);
        assert!(run.commit_checkpoint(&commit_payload(1),&secrets).is_err());assert!(run.commit_continue(&continue_payload(0)).is_err());
        run.commit_checkpoint(&commit_payload(0),&secrets).unwrap();let (_,path)=commit_paths(&run.root,CommitFile::Checkpoint,0).unwrap();let bytes=fs::read(&path).unwrap();
        run.commit_checkpoint(&commit_payload(0),&secrets).unwrap();assert_eq!(fs::read(&path).unwrap(),bytes);
        let publication=read_private_json(&path).unwrap();assert!(exact_fields(&publication,&["schemaVersion","runId","phase","pid","step","bodySha256","active","pendingAffected","observations"]).is_ok());
        let mut changed=commit_payload(0);changed["bodySha256"]=json!("c".repeat(64));assert!(run.commit_checkpoint(&changed,&secrets).is_err());assert_eq!(run.commit_continue(&continue_payload(0)).unwrap(),json!({"ready":false,"verified":false}));assert!(run.commit_checkpoint(&commit_payload(1),&secrets).is_err());
        publish_commit_json(&run.root,CommitFile::Ack,0,&ack_payload(&run,0,true)).unwrap();for _ in 0..2 {assert_eq!(run.commit_continue(&continue_payload(0)).unwrap(),json!({"ready":true,"verified":true}));}
        assert!(run.commit_checkpoint(&commit_payload(2),&secrets).is_err());run.commit_checkpoint(&commit_payload(1),&secrets).unwrap();
    }
    #[test] fn mysql_host_commit_false_ack_never_unlocks_next_step() {
        let run=commit_fixture();let secrets=AcceptanceSecrets::new(&run);run.commit_checkpoint(&commit_payload(0),&secrets).unwrap();publish_commit_json(&run.root,CommitFile::Ack,0,&ack_payload(&run,0,false)).unwrap();
        for _ in 0..2 {assert_eq!(run.commit_continue(&continue_payload(0)).unwrap(),json!({"ready":true,"verified":false}));}
        assert!(!run.commit_handshake.lock().unwrap().confirmed[0]);assert!(run.commit_checkpoint(&commit_payload(1),&secrets).is_err());assert!(run.retain_ui_report(&successful_commit_report(),&secrets).is_err());
    }
    #[test] fn mysql_host_commit_wrong_ack_identity_hash_and_fields_rejected() {
        for (key,value) in [("runId",json!("ffffffffffffffffffffffffffffffff")),("phase",json!("restart")),("pid",json!(0)),("step",json!("pending")),("bodySha256",json!("c".repeat(64))),("verified",json!(1)),("extra",json!(true)),("schemaVersion",json!(2))] {
            let run=commit_fixture();run.commit_checkpoint(&commit_payload(0),&AcceptanceSecrets::new(&run)).unwrap();let mut ack=ack_payload(&run,0,true);ack[key]=value;publish_commit_json(&run.root,CommitFile::Ack,0,&ack).unwrap();
            assert!(run.commit_continue(&continue_payload(0)).is_err());assert!(!run.commit_handshake.lock().unwrap().confirmed[0]);assert!(run.commit_checkpoint(&commit_payload(1),&AcceptanceSecrets::new(&run)).is_err());
        }
    }
    #[test] fn mysql_host_commit_ack_rejects_links_permissions_bounds_and_wrong_inode() {
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            for mode in [0,1,2,3,4] {
                let run=commit_fixture();run.commit_checkpoint(&commit_payload(0),&AcceptanceSecrets::new(&run)).unwrap();let (_,path)=commit_paths(&run.root,CommitFile::Ack,0).unwrap();let evidence=owned_evidence(&run.root).unwrap();
                match mode {
                    0=>{create_private_json(&path,&ack_payload(&run,0,true)).unwrap();fs::set_permissions(&path,fs::Permissions::from_mode(0o644)).unwrap();},
                    1=>{create_private_json(&path,&ack_payload(&run,0,true)).unwrap();let alias=evidence.join("owned-hardlink");assert!(fs::symlink_metadata(&path).unwrap().is_file());ensure_absent(&alias).unwrap();fs::hard_link(&path,alias).unwrap();},
                    2=>{let target=evidence.join("owned-symlink-target");create_private_json(&target,&ack_payload(&run,0,true)).unwrap();assert!(fs::symlink_metadata(&target).unwrap().is_file());ensure_absent(&path).unwrap();std::os::unix::fs::symlink(target,&path).unwrap();},
                    3=>{create_private_json(&path,&json!({"oversize":"x".repeat(1025)})).unwrap();},
                    _=>{create_private_json(&path,&ack_payload(&run,0,true)).unwrap();let other=evidence.join("other-opened-file");create_private_json(&other,&json!({})).unwrap();assert!(check_owned_open_file(&path,&File::open(other).unwrap(),&evidence,1024).is_err());continue;}
                }
                assert!(run.commit_continue(&continue_payload(0)).is_err());assert!(!run.commit_handshake.lock().unwrap().confirmed[0]);
            }
        }
    }
    #[test] fn mysql_host_commit_atomic_publication_preserves_existing_files() {
        let run=commit_fixture();let (pending,target)=commit_paths(&run.root,CommitFile::Checkpoint,0).unwrap();create_private_json(&target,&json!({"retained":true})).unwrap();let retained=fs::read(&target).unwrap();
        assert!(run.commit_checkpoint(&commit_payload(0),&AcceptanceSecrets::new(&run)).is_err());assert_eq!(fs::read(&target).unwrap(),retained);assert!(!pending.exists());
        assert!(run.commit_handshake.lock().unwrap().published[0].is_none());
        let (pending,_)=commit_paths(&run.root,CommitFile::Checkpoint,1).unwrap();create_private_json(&pending,&json!({"retained":true})).unwrap();let bytes=fs::read(&pending).unwrap();assert!(publish_commit_json(&run.root,CommitFile::Checkpoint,1,&json!({})).is_err());assert_eq!(fs::read(&pending).unwrap(),bytes);
        #[cfg(unix)] {let (pending,target)=commit_paths(&run.root,CommitFile::Checkpoint,2).unwrap();assert!(fs::symlink_metadata(&pending).is_err());assert!(fs::symlink_metadata(&target).is_err());std::os::unix::fs::symlink(&run.root,&pending).unwrap();assert!(publish_commit_json(&run.root,CommitFile::Checkpoint,2,&json!({})).is_err());assert!(fs::symlink_metadata(&pending).unwrap().file_type().is_symlink());}
    }
    #[test] fn mysql_host_commit_final_report_strict_schema_hashes_and_actions() {
        let report=successful_commit_report();assert!(validate_ui_report(&report,RUN,"commit").unwrap());assert!(validate_ui_report(&report,RUN,"restart").is_err());
        for (pointer,value) in [("/checks/unknown",json!(true)),("/row/extra",json!(1)),("/actions/dblclick",json!(0)),("/sql",json!("forbidden"))] {
            let mut changed=report.clone();let parts:Vec<_>=pointer.trim_start_matches('/').split('/').collect();let mut target=&mut changed;for part in &parts[..parts.len()-1]{target=&mut target[*part];}target[parts[parts.len()-1]]=value;assert!(validate_ui_report(&changed,RUN,"commit").is_err());
        }
        for (pointer,value) in [("/row",Value::Null),("/row/id",json!(2)),("/row/pendingSha256",Value::Null),("/row/committedSha256",json!("c".repeat(64))),("/row/baselineSha256",json!("b".repeat(64))),("/row/baselineSha256",json!("A".repeat(64))),("/actions/click",json!(7)),("/actions/input",json!(6)),("/actions/keydown",json!(1)),("/actions/input",json!(0.5)),("/elapsedMs",json!(3600001)),("/checks/committed_observed",json!(false)),("/failureCode",json!("unknown"))] {let mut changed=report.clone();*changed.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&changed,RUN,"commit").is_err());}
    }
    #[test] fn mysql_host_commit_partial_failure_retained_without_ack_promotion() {
        let run=commit_fixture();let secrets=AcceptanceSecrets::new(&run);assert!(run.retain_ui_report(&successful_commit_report(),&secrets).is_err());
        let mut report=successful_commit_report();for check in report["checks"].as_object_mut().unwrap().values_mut(){*check=json!(false);}report["row"]=Value::Null;report["failureCode"]=json!("CHECKPOINT");
        assert!(!run.retain_ui_report(&report,&secrets).unwrap());let retained=read_private_json(&run.root.join("evidence").join(format!("ui-commit-{}.json",std::process::id()))).unwrap();assert_eq!(retained["observations"]["guiVerified"],false);
    }
    #[test] fn mysql_host_commit_three_ack_report_pid_preserves_history() {
        let run=commit_fixture();let secrets=AcceptanceSecrets::new(&run);let initial_path=run.root.join("evidence/ui-initial.json");create_private_json(&initial_path,&json!({"retained":true})).unwrap();let bytes=fs::read(&initial_path).unwrap();
        for step in 0..3 {run.commit_checkpoint(&commit_payload(step),&secrets).unwrap();publish_commit_json(&run.root,CommitFile::Ack,step,&ack_payload(&run,step,true)).unwrap();assert_eq!(run.commit_continue(&continue_payload(step)).unwrap(),json!({"ready":true,"verified":true}));}
        let mut wrong=successful_commit_report();wrong["row"]["baselineSha256"]=json!("c".repeat(64));assert!(run.retain_ui_report(&wrong,&secrets).is_err());
        assert!(run.retain_ui_report(&successful_commit_report(),&secrets).unwrap());assert!(run.retain_ui_report(&successful_commit_report(),&secrets).is_err());
        let path=run.root.join("evidence").join(format!("ui-commit-{}.json",std::process::id()));let report=read_private_json(&path).unwrap();assert!(exact_fields(&report,&["schemaVersion","report","observations"]).is_ok());assert_eq!(report["observations"]["phase"],"commit");assert_eq!(report["observations"]["keyringGets"],0);assert_eq!(fs::read(initial_path).unwrap(),bytes);
    }
    fn successful_explain_report()->Value {
        json!({"schemaVersion":1,"runId":RUN,"phase":"explain","actionDriver":"native-dom-synthetic",
            "checks":{"storage_marker":true,"persisted_connection":true,"credential_reconnect":true,"query_result":true,"explain_open":true,"plan_content":true,"plan_refresh":true,"return_results":true,"nontransactional":true},
            "plan":{"rowCount":1,"columnCount":12,"firstPlanSha256":"a".repeat(64),"refreshedPlanSha256":"a".repeat(64),"executedSqlSha256":"b".repeat(64)},
            "actions":{"click":5,"input":1,"keydown":0},"elapsedMs":200,"failureCode":"NONE"})
    }
    #[test] fn mysql_host_explain_phase_requires_existing_root_and_rejects_password() {
        let(repo,temp,root,manifest)=fixture(RUN);
        assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"explain".into(),manifest.clone(),&temp,&repo).is_err());
        assert!(!root.exists());
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        let mut explain=AcceptanceRun::prepare(root,RUN.into(),"explain".into(),manifest,&temp,&repo).unwrap();
        assert_eq!(explain.phase,"explain");assert_eq!(explain.context()["phase"],"explain");assert_eq!(explain.store_id,initial.store_id);assert_eq!(explain.namespace(),initial.namespace());
        explain.app_secret=repo.join("missing-must-not-be-read.secret");assert_eq!(explain.password_script().unwrap_err().code,"unsupported");
        assert!(explain.probe_method_allowed("mysqlAcceptanceReport"));assert!(explain.probe_script().is_err());
        let secrets=AcceptanceSecrets::new(&explain);assert!(secrets.startup_trace.is_some());assert_eq!(explain.snapshot(&secrets).unwrap()["phase"],"explain");
    }
    #[test] fn mysql_host_explain_report_rejects_extra_fields_phase_and_types() {
        let report=successful_explain_report();assert!(validate_ui_report(&report,RUN,"explain").unwrap());
        for phase in ["initial","restart","restart-probe","restart-attempt","soak"] {assert!(validate_ui_report(&report,RUN,phase).is_err());}
        assert!(validate_ui_report(&report,"ffffffffffffffffffffffffffffffff","explain").is_err());
        for (pointer,value) in [("/sql",json!("forbidden")),("/checks/unknown",json!(true)),("/plan/columns",json!([])),("/actions/dblclick",json!(0))] {
            let mut report=report.clone();let parts:Vec<_>=pointer.trim_start_matches('/').split('/').collect();let mut target=&mut report;
            for part in &parts[..parts.len()-1]{target=&mut target[*part];}target[parts[parts.len()-1]]=value;assert!(validate_ui_report(&report,RUN,"explain").is_err());
        }
        for (pointer,value) in [("/checks/query_result",json!(1)),("/phase",json!("restart")),("/failureCode",json!("TREE")),("/actionDriver",json!("controller")),("/schemaVersion",json!(2))] {
            let mut report=report.clone();*report.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&report,RUN,"explain").is_err());
        }
        let mut oversized=report;oversized["failureCode"]=json!("x".repeat(16384));assert!(validate_ui_report(&oversized,RUN,"explain").is_err());
    }
    #[test] fn mysql_host_explain_report_plan_counts_hashes_and_null_gates() {
        for (pointer,value) in [("/plan",Value::Null),("/plan/rowCount",json!(2)),("/plan/columnCount",json!(11)),("/plan/firstPlanSha256",Value::Null),("/plan/executedSqlSha256",json!("A".repeat(64))),("/plan/refreshedPlanSha256",Value::Null),("/plan/refreshedPlanSha256",json!("c".repeat(64)))] {
            let mut report=successful_explain_report();*report.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&report,RUN,"explain").is_err());
        }
    }
    #[test] fn mysql_host_explain_report_action_and_elapsed_bounds() {
        for (pointer,value) in [("/actions/click",json!(4)),("/actions/input",json!(0)),("/actions/keydown",json!(1)),("/actions/click",json!(10001)),("/actions/input",json!(0.5)),("/elapsedMs",json!(-1)),("/elapsedMs",json!(0.5)),("/elapsedMs",json!(3600001))] {
            let mut report=successful_explain_report();*report.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&report,RUN,"explain").is_err());
        }
        let mut report=successful_explain_report();report["checks"]["nontransactional"]=json!(false);assert!(validate_ui_report(&report,RUN,"explain").is_err());
    }
    #[test] fn mysql_host_explain_report_partial_failure_not_promoted() {
        let mut report=successful_explain_report();for check in report["checks"].as_object_mut().unwrap().values_mut(){*check=json!(false);}
        report["failureCode"]=json!("CONNECTION");report["plan"]=Value::Null;report["actions"]=json!({"click":0,"input":0,"keydown":0});assert!(!validate_ui_report(&report,RUN,"explain").unwrap());
        report["checks"]["plan_content"]=json!(true);assert!(validate_ui_report(&report,RUN,"explain").is_err());
        let mut partial=successful_explain_report();partial["failureCode"]=json!("DOM_FAILED");partial["checks"]["plan_refresh"]=json!(false);partial["plan"]["refreshedPlanSha256"]=Value::Null;assert!(!validate_ui_report(&partial,RUN,"explain").unwrap());
    }
    #[test] fn mysql_host_explain_pid_report_preserves_history_and_trace_contract() {
        let(repo,temp,root,manifest)=fixture(RUN);
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        initial.retain_ui_report(&successful_report(),&AcceptanceSecrets::new(&initial)).unwrap();
        let restart=AcceptanceRun::prepare(root.clone(),RUN.into(),"restart".into(),manifest.clone(),&temp,&repo).unwrap();restart.retain_ui_report(&successful_restart_report(),&AcceptanceSecrets::new(&restart)).unwrap();
        let initial_bytes=fs::read(root.join("evidence/ui-initial.json")).unwrap();let restart_bytes=fs::read(root.join("evidence/ui-restart.json")).unwrap();let host_bytes=fs::read(root.join(HOST_MANIFEST)).unwrap();
        let explain=AcceptanceRun::prepare(root.clone(),RUN.into(),"explain".into(),manifest,&temp,&repo).unwrap();let secrets=AcceptanceSecrets::new(&explain);
        explain.frontend_startup_trace(&json!({"schemaVersion":1,"stage":"dom_enter"})).unwrap();explain.native_startup_trace("native_enter","explain").unwrap();secrets.trace_get("keyring_get_returned");explain.native_startup_trace("native_returned","explain").unwrap();
        let trace=fs::read_to_string(root.join("evidence").join(format!("startup-trace-{}.jsonl",std::process::id()))).unwrap();
        let records:Vec<Value>=trace.lines().map(|line|serde_json::from_str(line).unwrap()).collect();assert_eq!(records.len(),4);assert_eq!(records[1]["method"],"other");assert_eq!(records[2]["method"],"none");
        assert!(explain.retain_ui_report(&successful_report(),&secrets).is_err());assert!(explain.retain_ui_report(&successful_restart_report(),&secrets).is_err());
        assert!(explain.retain_ui_report(&successful_explain_report(),&secrets).unwrap());assert!(explain.retain_ui_report(&successful_explain_report(),&secrets).is_err());
        let path=root.join("evidence").join(format!("ui-explain-{}.json",std::process::id()));let report=read_private_json(&path).unwrap();assert!(exact_fields(&report,&["schemaVersion","report","observations"]).is_ok());
        assert_eq!(report["report"]["phase"],"explain");assert_eq!(report["observations"]["phase"],"explain");assert_eq!(report["observations"]["guiVerified"],false);
        assert_eq!(fs::read(root.join("evidence/ui-initial.json")).unwrap(),initial_bytes);assert_eq!(fs::read(root.join("evidence/ui-restart.json")).unwrap(),restart_bytes);assert_eq!(fs::read(root.join(HOST_MANIFEST)).unwrap(),host_bytes);
    }
    #[test] fn mysql_host_attempt_phase_maps_restart_and_preserves_reports() {
        let(repo,temp,root,manifest)=fixture(RUN);
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        initial.retain_ui_report(&successful_report(),&AcceptanceSecrets::new(&initial)).unwrap();
        let restart=AcceptanceRun::prepare(root.clone(),RUN.into(),"restart".into(),manifest.clone(),&temp,&repo).unwrap();
        restart.retain_ui_report(&successful_restart_report(),&AcceptanceSecrets::new(&restart)).unwrap();
        let initial_bytes=fs::read(root.join("evidence/ui-initial.json")).unwrap();let old_restart=fs::read(root.join("evidence/ui-restart.json")).unwrap();let host=fs::read(root.join(HOST_MANIFEST)).unwrap();
        let attempt=AcceptanceRun::prepare(root.clone(),RUN.into(),"restart-attempt".into(),manifest,&temp,&repo).unwrap();
        let secrets=AcceptanceSecrets::new(&attempt);
        assert_eq!(attempt.phase,"restart-attempt");assert_eq!(attempt.context()["phase"],"restart");assert_eq!(attempt.snapshot(&secrets).unwrap()["phase"],"restart");
        assert_eq!(attempt.store_id,initial.store_id);assert_eq!(attempt.namespace(),initial.namespace());assert_eq!(attempt.password_script().unwrap_err().code,"unsupported");
        assert!(attempt.retain_ui_report(&successful_report(),&secrets).is_err());
        assert!(attempt.retain_ui_report(&successful_restart_report(),&secrets).unwrap());assert!(attempt.retain_ui_report(&successful_restart_report(),&secrets).is_err());
        let path=root.join("evidence").join(format!("ui-restart-{}.json",std::process::id()));let report=read_private_json(&path).unwrap();
        assert!(exact_fields(&report,&["schemaVersion","report","observations"]).is_ok());assert_eq!(report["report"]["phase"],"restart");assert_eq!(report["observations"]["phase"],"restart");assert_eq!(report["observations"]["guiVerified"],false);
        assert_eq!(fs::read(root.join("evidence/ui-initial.json")).unwrap(),initial_bytes);assert_eq!(fs::read(root.join("evidence/ui-restart.json")).unwrap(),old_restart);assert_eq!(fs::read(root.join(HOST_MANIFEST)).unwrap(),host);
    }
    #[test] fn mysql_host_attempt_frontend_trace_schema_phase_and_noop() {
        for stage in FRONTEND_STAGES {assert!(frontend_trace_stage(&json!({"schemaVersion":1,"stage":stage})).is_ok());}
        for request in [json!({"schemaVersion":1,"stage":"native_enter"}),json!({"schemaVersion":1,"stage":"keyring_get_enter"}),json!({"schemaVersion":1,"stage":"main_enter","method":"none"}),json!({"schemaVersion":1,"stage":true}),json!({"schemaVersion":2,"stage":"main_enter"}),json!({"schemaVersion":1,"stage":"x".repeat(1025)})] {assert!(frontend_trace_stage(&request).is_err());}
        let(repo,temp,root,manifest)=fixture(RUN);let request=json!({"schemaVersion":1,"stage":"main_enter"});
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        initial.frontend_startup_trace(&request).unwrap();assert!(AcceptanceSecrets::new(&initial).startup_trace.is_some());
        let restart=AcceptanceRun::prepare(root.clone(),RUN.into(),"restart".into(),manifest.clone(),&temp,&repo).unwrap();restart.frontend_startup_trace(&request).unwrap();
        let probe=AcceptanceRun::prepare(root.clone(),RUN.into(),"restart-probe".into(),manifest,&temp,&repo).unwrap();assert!(!probe.probe_method_allowed("mysqlAcceptanceStartupTrace"));assert!(probe.frontend_startup_trace(&request).is_err());
        assert!(!root.join("evidence").join(format!("startup-trace-{}.jsonl",std::process::id())).exists());
    }
    #[test] fn mysql_host_attempt_trace_owned_append_sequence_and_record_cap() {
        let(repo,temp,root,manifest)=fixture(RUN);AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest,&temp,&repo).unwrap();
        let evidence=root.join("evidence");let mut trace=StartupTrace::create(&evidence).unwrap();
        for stage in FRONTEND_STAGES {trace.append(stage,"none").unwrap();}
        while trace.seq<128 {trace.append("native_returned","other").unwrap();}
        assert!(trace.append("main_enter","none").is_err());assert!(StartupTrace::create(&evidence).is_err());
        let path=evidence.join(format!("startup-trace-{}.jsonl",std::process::id()));private_metadata(&path,false).unwrap();let bytes=fs::read(&path).unwrap();assert!(bytes.len()<=32768);
        let records:Vec<Value>=std::str::from_utf8(&bytes).unwrap().lines().map(|line|serde_json::from_str(line).unwrap()).collect();assert_eq!(records.len(),128);
        for (index,record) in records.iter().enumerate() {assert!(exact_fields(record,&["schemaVersion","seq","stage","method"]).is_ok());assert_eq!(record["seq"],(index+1)as u64);}
    }
    #[test] fn mysql_host_attempt_trace_rejects_unknown_pairs_and_byte_cap() {
        let(repo,temp,root,manifest)=fixture(RUN);AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest,&temp,&repo).unwrap();
        let mut trace=StartupTrace::create(&root.join("evidence")).unwrap();
        for (stage,method) in [("unknown","none"),("main_enter","listConnections"),("native_enter","none"),("native_failed","arbitrary"),("keyring_get_enter","other")] {assert!(trace.append(stage,method).is_err());}
        assert_eq!(trace.seq,0);trace.bytes=32768;assert!(trace.append("main_enter","none").is_err());assert_eq!(trace.seq,0);assert_eq!(trace.file.metadata().unwrap().len(),0);
    }
    #[test] fn mysql_host_attempt_native_method_classification_is_closed() {
        for method in ["listDialects","listConnections","migrationStatus"] {assert_eq!(native_method_group(method),method);}
        assert_eq!(native_method_group("not-recorded-arbitrary-input"),"other");
        let(repo,temp,root,manifest)=fixture(RUN);AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        let attempt=AcceptanceRun::prepare(root.clone(),RUN.into(),"restart-attempt".into(),manifest,&temp,&repo).unwrap();
        for stage in ["native_enter","native_returned","native_failed"] {attempt.native_startup_trace(stage,"not-recorded-arbitrary-input").unwrap();}
        assert!(attempt.native_startup_trace("main_enter","listConnections").is_err());
        let lines=fs::read_to_string(root.join("evidence").join(format!("startup-trace-{}.jsonl",std::process::id()))).unwrap();assert!(!lines.contains("not-recorded-arbitrary-input"));
        for line in lines.lines() {let record:Value=serde_json::from_str(line).unwrap();assert_eq!(record["method"],"other");}
    }
    #[test] fn mysql_host_attempt_keyring_mock_trace_shares_sequence_without_vault() {
        let(repo,temp,root,manifest)=fixture(RUN);let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        let ordinary=AcceptanceSecrets::new(&initial);ordinary.trace_get("keyring_get_enter");assert!(ordinary.startup_trace.is_some());
        let attempt=AcceptanceRun::prepare(root.clone(),RUN.into(),"restart-attempt".into(),manifest,&temp,&repo).unwrap();let secrets=AcceptanceSecrets::new(&attempt);
        attempt.frontend_startup_trace(&json!({"schemaVersion":1,"stage":"boot_enter"})).unwrap();attempt.native_startup_trace("native_enter","listConnections").unwrap();
        for stage in ["keyring_get_enter","keyring_get_returned","keyring_get_failed"] {secrets.trace_get(stage);}
        attempt.native_startup_trace("native_returned","listConnections").unwrap();
        let lines=fs::read_to_string(root.join("evidence").join(format!("startup-trace-{}.jsonl",std::process::id()))).unwrap();let records:Vec<Value>=lines.lines().map(|line|serde_json::from_str(line).unwrap()).collect();assert_eq!(records.len(),6);
        for (index,record) in records.iter().enumerate() {assert_eq!(record["seq"],(index+1)as u64);if (2..5).contains(&index){assert_eq!(record["method"],"none");}}
        let observations=attempt.snapshot(&secrets).unwrap();for key in ["keyringGets","keyringHits","keyringSets"]{assert_eq!(observations[key],0);}assert!(observations["methods"].as_object().unwrap().is_empty());
    }
    #[test] fn mysql_host_initial_keyring_set_trace_is_closed_and_secret_free(){
        struct PanicPayload;
        impl std::fmt::Debug for PanicPayload {fn fmt(&self,_:&mut std::fmt::Formatter)->std::fmt::Result {panic!("synthetic payload debug must never be called")}}
        impl std::fmt::Display for PanicPayload {fn fmt(&self,_:&mut std::fmt::Formatter)->std::fmt::Result {panic!("synthetic payload display must never be called")}}
        impl std::error::Error for PanicPayload {}
        let boxed=||Box::new(PanicPayload) as Box<dyn std::error::Error+Send+Sync>;
        assert_eq!(AcceptanceSecrets::entry_init_class(&keyring::Error::NoStorageAccess(boxed())),"entry_init_no_storage_access");
        assert_eq!(AcceptanceSecrets::entry_init_class(&keyring::Error::PlatformFailure(boxed())),"entry_init_platform_failure");
        assert_eq!(AcceptanceSecrets::entry_init_class(&keyring::Error::NoEntry),"entry_init_other");
        assert_eq!(AcceptanceSecrets::password_write_class(&keyring::Error::NoStorageAccess(boxed())),"password_write_no_storage_access");
        assert_eq!(AcceptanceSecrets::password_write_class(&keyring::Error::PlatformFailure(boxed())),"password_write_platform_failure");
        assert_eq!(AcceptanceSecrets::password_write_class(&keyring::Error::NoEntry),"password_write_other");
        let(repo,temp,root,manifest)=fixture(RUN);
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest,&temp,&repo).unwrap();
        let secrets=AcceptanceSecrets::new(&initial);
        assert!(secrets.startup_trace.is_some());
        let sentinel=format!("synthetic-set-sentinel-{RUN}");
        let mut secret_map=SecretMap::new();secret_map.insert("dbPassword".into(),Value::String(sentinel.clone()));
        assert_eq!(secrets.set("bad/key",&secret_map).unwrap_err().code,"secret-storage-unavailable");
        assert_eq!(secrets.gets.load(Ordering::Relaxed),0);assert_eq!(secrets.hits.load(Ordering::Relaxed),0);assert_eq!(secrets.sets.load(Ordering::Relaxed),0);
        let path=root.join("evidence").join(format!("startup-trace-initial-{}.jsonl",std::process::id()));
        private_metadata(&path,false).unwrap();
        let raw=fs::read_to_string(&path).unwrap();
        assert!(!raw.contains(&sentinel));assert!(!raw.contains("bad/key"));assert!(!raw.contains("dbPassword"));
        let records:Vec<Value>=raw.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        assert_eq!(records.len(),2);
        for (index,record) in records.iter().enumerate() {assert!(exact_fields(record,&["schemaVersion","seq","stage","method"]).is_ok());assert_eq!(record["seq"],(index+1)as u64);}
        assert_eq!(records[0]["stage"],"keyring_set_enter");assert_eq!(records[0]["method"],"none");
        assert_eq!(records[1]["stage"],"keyring_set_failed");assert_eq!(records[1]["method"],"key_rejected");
    }
    #[test] fn mysql_host_initial_keyring_diagnostics_keep_snapshot_and_failure_contract(){
        let(repo,temp,root,manifest)=fixture(RUN);
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest,&temp,&repo).unwrap();
        let secrets=AcceptanceSecrets::new(&initial);
        assert!(secrets.startup_trace.is_some());
        for key in [String::new(),"x".repeat(201),"bad/key".to_owned(),"space key".to_owned(),"excl!".to_owned()] {
            assert_eq!(secrets.entry(&key).unwrap_err().code,"secret-storage-unavailable");
            let classified=secrets.checked_entry(&key).unwrap_err();
            assert_eq!(classified.0.code,"secret-storage-unavailable");
            assert_eq!(classified.1,"key_rejected");
        }
        initial.record("runQuery",true,3);initial.record("runQuery",false,1);
        for _ in 0..128 {secrets.trace_get("keyring_get_enter");}
        let mut secret_map=SecretMap::new();secret_map.insert("dbPassword".into(),Value::String("synthetic-set-sentinel-not-traced".into()));
        assert_eq!(secrets.set("bad/key",&secret_map).unwrap_err().code,"secret-storage-unavailable");
        assert_eq!(secrets.sets.load(Ordering::Relaxed),0);
        let snapshot=initial.snapshot(&secrets).unwrap();
        assert!(exact_fields(&snapshot,&["scope","runId","phase","methods","keyringGets","keyringHits","keyringSets","guiVerified","mysqlVerified","storePersistenceVerified"]).is_ok());
        assert_eq!(snapshot["phase"],"initial");
        assert_eq!(snapshot["methods"]["runQuery"]["success"],1);assert_eq!(snapshot["methods"]["runQuery"]["failure"],1);assert_eq!(snapshot["methods"]["runQuery"]["totalElapsedMs"],4);
        assert_eq!(snapshot["keyringGets"],0);assert_eq!(snapshot["keyringHits"],0);assert_eq!(snapshot["keyringSets"],0);
        let initial_trace=root.join("evidence").join(format!("startup-trace-initial-{}.jsonl",std::process::id()));
        let raw=fs::read_to_string(&initial_trace).unwrap();assert_eq!(raw.lines().count(),128);
        assert!(!raw.contains("keyring_set"));assert!(!raw.contains("synthetic-set-sentinel-not-traced"));
        let mut trace=StartupTrace::create(&root.join("evidence")).unwrap();
        for (stage,method) in [("arbitrary-stage","none"),("keyring_set_enter","key_rejected"),("keyring_set_failed","none"),("keyring_set_failed","arbitrary-class"),("keyring_set_failed","listDialects"),("keyring_set_returned","key_rejected")] {assert!(trace.append(stage,method).is_err());}
        assert_eq!(trace.seq,0);
        trace.bytes=32768;assert!(trace.append("keyring_set_enter","none").is_err());assert!(trace.append("keyring_set_failed","key_rejected").is_err());assert_eq!(trace.seq,0);assert_eq!(trace.file.metadata().unwrap().len(),0);
        trace.bytes=0;
        for class in KEYRING_SET_FAILURE_CLASSES {assert!(trace.append("keyring_set_failed",class).is_ok());assert!(trace.append("keyring_set_enter","none").is_ok());assert!(trace.append("keyring_set_returned","none").is_ok());}
        while trace.seq<128 {trace.append("keyring_get_enter","none").unwrap();}
        assert!(trace.append("keyring_set_failed","key_rejected").is_err());assert!(trace.append("keyring_set_returned","none").is_err());
        let path=root.join("evidence").join(format!("startup-trace-{}.jsonl",std::process::id()));
        let bytes=fs::read(&path).unwrap();assert!(bytes.len()<=32768);
        let records:Vec<Value>=std::str::from_utf8(&bytes).unwrap().lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        assert_eq!(records.len(),128);
        for (index,record) in records.iter().enumerate() {assert!(exact_fields(record,&["schemaVersion","seq","stage","method"]).is_ok());assert_eq!(record["seq"],(index+1)as u64);}
    }
    #[test] fn mysql_host_platform_osstatus_downcast_is_typed_and_secret_free() {
        struct PanicPayload;
        impl std::fmt::Debug for PanicPayload {fn fmt(&self,_:&mut std::fmt::Formatter)->std::fmt::Result {panic!("synthetic payload debug must never be called")}}
        impl std::fmt::Display for PanicPayload {fn fmt(&self,_:&mut std::fmt::Formatter)->std::fmt::Result {panic!("synthetic payload display must never be called")}}
        impl std::error::Error for PanicPayload {}
        let unknown=||Box::new(PanicPayload) as Box<dyn std::error::Error+Send+Sync>;
        #[cfg(target_os="macos")]
        {
            // A synthetic, nonzero platform status; no keychain, database or network access is performed.
            let typed=||Box::new(security_framework::base::Error::from_code(-50)) as Box<dyn std::error::Error+Send+Sync>;
            assert_eq!(platform_os_status(&keyring::Error::PlatformFailure(typed())),Some(-50));
            assert_eq!(platform_os_status(&keyring::Error::NoStorageAccess(typed())),Some(-50));
        }
        // An unknown payload type yields no status and is never formatted.
        assert_eq!(platform_os_status(&keyring::Error::PlatformFailure(unknown())),None);
        assert_eq!(platform_os_status(&keyring::Error::NoStorageAccess(unknown())),None);
        assert_eq!(platform_os_status(&keyring::Error::NoEntry),None);
    }
    #[test] fn mysql_host_initial_platform_osstatus_trace_is_canonical_and_phase_bounded() {
        let(repo,temp,root,manifest)=fixture(RUN);
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        let secrets=AcceptanceSecrets::new(&initial);
        assert!(secrets.startup_trace.is_some());
        assert!(secrets.capture_platform_status);
        let probe_dir=repo.join("osstatus-probe");create_private_dir(&probe_dir).unwrap();
        let mut probe=StartupTrace::create(&probe_dir).unwrap();
        for method in ["sentinel","+5","007","-0","1.5","1e3","2147483648","-2147483649"," 5","5 ","none","key_rejected","listDialects",""] {assert!(probe.append(KEYRING_OSSTATUS_STAGE,method).is_err());}
        assert!(probe.append(KEYRING_OSSTATUS_STAGE,"-50").is_ok());
        assert!(probe.append(KEYRING_OSSTATUS_STAGE,"25300").is_ok());
        for class in KEYRING_SET_FAILURE_CLASSES {assert!(probe.append("keyring_set_failed",class).is_ok());}
        assert!(probe.append("keyring_set_failed","arbitrary-class").is_err());
        assert!(probe.append("native_enter","listDialects").is_ok());
        assert!(probe.append("native_enter","other").is_ok());
        assert!(probe.append("native_enter","none").is_err());
        assert!(probe.append("main_enter","none").is_ok());
        assert!(probe.append("main_enter","listConnections").is_err());
        let caps=repo.join("osstatus-caps");create_private_dir(&caps).unwrap();
        let mut bounded=StartupTrace::create(&caps).unwrap();
        while bounded.seq<128 {bounded.append("keyring_get_enter","none").unwrap();}
        assert!(bounded.append(KEYRING_OSSTATUS_STAGE,"-50").is_err());
        assert!(bounded.append("keyring_set_failed","key_rejected").is_err());
        let cap_bytes=fs::read(caps.join(format!("startup-trace-{}.jsonl",std::process::id()))).unwrap();
        assert!(cap_bytes.len()<=32768);
        // Only the initial phase may observe a typed platform status.
        let attempt=AcceptanceRun::prepare(root.clone(),RUN.into(),"restart-attempt".into(),manifest.clone(),&temp,&repo).unwrap();
        let attempt_secrets=AcceptanceSecrets::new(&attempt);
        assert!(!attempt_secrets.capture_platform_status);
        #[cfg(target_os="macos")]
        {
            let typed=keyring::Error::PlatformFailure(Box::new(security_framework::base::Error::from_code(-50)) as Box<dyn std::error::Error+Send+Sync>);
            attempt_secrets.trace_platform_osstatus(&typed);
            let initial_secrets=AcceptanceSecrets::new(&initial);
            initial_secrets.trace_platform_osstatus(&typed);
        }
        let initial_trace=root.join("evidence").join(format!("startup-trace-initial-{}.jsonl",std::process::id()));
        private_metadata(&initial_trace,false).unwrap();
        let initial_raw=fs::read_to_string(&initial_trace).unwrap();
        let initial_records:Vec<Value>=initial_raw.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        #[cfg(target_os="macos")]
        {
            assert_eq!(initial_records.len(),1);
            assert_eq!(initial_records[0]["stage"],KEYRING_OSSTATUS_STAGE);
            assert_eq!(initial_records[0]["method"],"-50");
            assert_eq!(initial_records[0]["seq"],1);
        }
        #[cfg(not(target_os="macos"))]
        assert!(initial_records.is_empty());
        for record in &initial_records {assert!(exact_fields(record,&["schemaVersion","seq","stage","method"]).is_ok());}
        let attempt_trace=root.join("evidence").join(format!("startup-trace-{}.jsonl",std::process::id()));
        private_metadata(&attempt_trace,false).unwrap();
        let attempt_raw=fs::read_to_string(&attempt_trace).unwrap();
        assert!(!attempt_raw.contains(KEYRING_OSSTATUS_STAGE));
        assert!(!attempt_raw.contains("-50"));
    }
    #[test] fn mysql_host_probe_schema_phase_source_and_business_gate() {
        let report=json!({"schemaVersion":1,"checks":{"storageAccessible":false,"markerMatched":false,"nonemptyStore":false,"startupFailureVisible":true}});
        assert!(validate_probe_report(&report,"restart-probe").is_ok());
        for phase in ["initial","restart","soak"] {assert!(validate_probe_report(&report,phase).is_err());}
        for (pointer,value) in [("/extra",json!(true)),("/checks/value",json!("forbidden")),("/checks/markerMatched",json!(1))] {
            let mut changed=report.clone();let parts:Vec<_>=pointer.trim_start_matches('/').split('/').collect();let mut target=&mut changed;
            for part in &parts[..parts.len()-1]{target=&mut target[*part];}target[parts[parts.len()-1]]=value;
            assert!(validate_probe_report(&changed,"restart-probe").is_err());
        }
        let(repo,temp,root,manifest)=fixture(RUN);
        AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        let probe=AcceptanceRun::prepare(root,RUN.into(),"restart-probe".into(),manifest,&temp,&repo).unwrap();
        assert!(probe.probe_method_allowed("mysqlAcceptanceContext"));assert!(probe.probe_method_allowed("mysqlAcceptanceProbeReport"));
        for method in ["runQuery","addConnection","listConnections","mysqlAcceptanceFillAppPassword","mysqlAcceptanceReport","mysqlAcceptanceObservations","confirmExit"] {assert!(!probe.probe_method_allowed(method));}
        assert_eq!(probe.password_script().unwrap_err().code,"unsupported");
        assert!(!bridge_window_allowed("other","tauri://localhost/"));assert!(!bridge_window_allowed("main","https://remote.invalid/"));
        let script=probe.probe_script().unwrap();assert_eq!(script.matches("localStorage.getItem(").count(),1);assert_eq!(script.matches("localStorage.length").count(),1);
        for forbidden in ["setItem(","localStorage.key(","Workbench","FillAppPassword","console."] {assert!(!script.contains(forbidden));}
    }
    #[test] fn mysql_host_probe_retains_unique_boolean_report_and_zero_observations() {
        let(repo,temp,root,manifest)=fixture(RUN);
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        initial.retain_ui_report(&successful_report(),&AcceptanceSecrets::new(&initial)).unwrap();
        let initial_bytes=fs::read(root.join("evidence/ui-initial.json")).unwrap();
        let probe=AcceptanceRun::prepare(root.clone(),RUN.into(),"restart-probe".into(),manifest.clone(),&temp,&repo).unwrap();
        assert!(!probe.retain_probe_checkpoint("main","https://remote.invalid/").unwrap());
        assert!(probe.retain_probe_checkpoint("main","tauri://localhost/").is_err());
        let checkpoint=read_private_json(&root.join("evidence").join(format!("host-probe-{}.json",std::process::id()))).unwrap();
        assert!(exact_fields(&checkpoint,&["window","page","originAllowed"]).is_ok());assert_eq!(checkpoint["originAllowed"],false);
        let report=json!({"schemaVersion":1,"checks":{"storageAccessible":true,"markerMatched":false,"nonemptyStore":false,"startupFailureVisible":true}});
        let secrets=AcceptanceSecrets::new(&probe);probe.retain_probe_report(&report,&secrets).unwrap();assert!(probe.retain_probe_report(&report,&secrets).is_err());
        let retained=read_private_json(&root.join("evidence").join(format!("probe-restart-{}.json",std::process::id()))).unwrap();
        assert!(exact_fields(&retained,&["schemaVersion","scope","runId","phase","checks","observations","productionReady","restartVerified"]).is_ok());
        assert_eq!(retained["checks"]["markerMatched"],false);assert_eq!(retained["restartVerified"],false);
        assert_eq!(fs::read(root.join("evidence/ui-initial.json")).unwrap(),initial_bytes);
        let second=AcceptanceRun::prepare(root,RUN.into(),"restart-probe".into(),manifest,&temp,&repo).unwrap();
        let dirty_secrets=AcceptanceSecrets::new(&second);dirty_secrets.gets.store(1,Ordering::Relaxed);
        assert!(second.retain_probe_report(&report,&dirty_secrets).is_err());
        second.record("runQuery",true,0);assert!(second.retain_probe_report(&report,&AcceptanceSecrets::new(&second)).is_err());
    }
    fn successful_restart_report()->Value {
        json!({"schemaVersion":1,"runId":RUN,"phase":"restart","actionDriver":"native-dom-synthetic",
            "checks":{"storage_marker":true,"persisted_connection":true,"credential_reconnect":true,"sql_select41":true,"table_open":true,"local_edit":true,"dirty_guard_cancel":true,"applied_pending":true,"rollback_restored":true},
            "row":{"id":1,"beforeSha256":"a".repeat(64),"localSha256":"b".repeat(64),"appliedSha256":"b".repeat(64),"rolledBackSha256":"a".repeat(64)},
            "actions":{"click":9,"input":2,"keydown":0,"dblclick":2},"elapsedMs":200.5,"failureCode":"NONE"})
    }
    #[test] fn mysql_host_restart_report_success_strict_schema() {
        let report=successful_restart_report();assert!(validate_ui_report(&report,RUN,"restart").unwrap());
        assert!(validate_ui_report(&report,RUN,"initial").is_err());
        assert!(validate_ui_report(&successful_report(),RUN,"restart").is_err());
        assert!(validate_ui_report(&report,RUN,"soak").is_err());
        assert!(validate_ui_report(&report,"ffffffffffffffffffffffffffffffff","restart").is_err());
    }
    #[test] fn mysql_host_restart_report_rejects_extra_fields_and_wrong_types() {
        for (pointer,value) in [("/message",json!("arbitrary")),("/pages",json!({})),("/checks/unknown",json!(true)),("/row/extra",json!(0)),("/actions/extra",json!(0))] {
            let mut report=successful_restart_report();let parts:Vec<_>=pointer.trim_start_matches('/').split('/').collect();
            let mut target=&mut report;for part in &parts[..parts.len()-1]{target=&mut target[*part];}target[parts[parts.len()-1]]=value;
            assert!(validate_ui_report(&report,RUN,"restart").is_err());
        }
        for (pointer,value) in [("/checks/storage_marker",json!(1)),("/phase",json!("initial")),("/failureCode",json!("SQL arbitrary")),("/row/id",json!(2)),("/actions/dblclick",json!(-1)),("/actions/input",json!(0.5)),("/elapsedMs",json!(3600001))] {
            let mut report=successful_restart_report();*report.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&report,RUN,"restart").is_err());
        }
    }
    #[test] fn mysql_host_restart_report_rejects_missing_row_and_required_hashes() {
        for pointer in ["/row","/row/beforeSha256","/row/localSha256","/row/appliedSha256","/row/rolledBackSha256"] {
            let mut report=successful_restart_report();*report.pointer_mut(pointer).unwrap()=Value::Null;assert!(validate_ui_report(&report,RUN,"restart").is_err());
        }
        for pointer in ["/row/beforeSha256","/row/localSha256","/row/appliedSha256","/row/rolledBackSha256"] {
            let mut report=successful_restart_report();*report.pointer_mut(pointer).unwrap()=json!("G".repeat(64));assert!(validate_ui_report(&report,RUN,"restart").is_err());
        }
    }
    #[test] fn mysql_host_restart_report_rejects_inconsistent_stage_hashes() {
        for (pointer,value) in [("/row/localSha256","a".repeat(64)),("/row/appliedSha256","c".repeat(64)),("/row/rolledBackSha256","d".repeat(64))] {
            let mut report=successful_restart_report();*report.pointer_mut(pointer).unwrap()=json!(value);assert!(validate_ui_report(&report,RUN,"restart").is_err());
        }
        let mut report=successful_restart_report();report["checks"]["rollback_restored"]=json!(false);assert!(validate_ui_report(&report,RUN,"restart").is_err());
    }
    #[test] fn mysql_host_restart_report_partial_failure_allows_unreached_nulls() {
        let mut report=successful_restart_report();report["failureCode"]=json!("ISOLATION");
        for check in report["checks"].as_object_mut().unwrap().values_mut(){*check=json!(false);}
        report["row"]=Value::Null;
        assert!(!validate_ui_report(&report,RUN,"restart").unwrap());
        report["checks"]["local_edit"]=json!(true);assert!(validate_ui_report(&report,RUN,"restart").is_err());
        let mut report=successful_restart_report();report["failureCode"]=json!("ROLLBACK");report["checks"]["rollback_restored"]=json!(false);report["row"]["rolledBackSha256"]=Value::Null;
        assert!(!validate_ui_report(&report,RUN,"restart").unwrap());
    }
    #[test] fn mysql_host_restart_reports_keep_initial_and_restart_exclusive() {
        let(repo,temp,root,manifest)=fixture(RUN);
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        initial.retain_ui_report(&successful_report(),&AcceptanceSecrets::new(&initial)).unwrap();
        let initial_bytes=fs::read(root.join("evidence/ui-initial.json")).unwrap();
        let restart=AcceptanceRun::prepare(root.clone(),RUN.into(),"restart".into(),manifest,&temp,&repo).unwrap();
        let secrets=AcceptanceSecrets::new(&restart);assert!(restart.retain_ui_report(&successful_restart_report(),&secrets).unwrap());
        assert!(restart.retain_ui_report(&successful_restart_report(),&secrets).is_err());
        assert!(initial.retain_ui_report(&successful_report(),&AcceptanceSecrets::new(&initial)).is_err());
        assert_eq!(fs::read(root.join("evidence/ui-initial.json")).unwrap(),initial_bytes);
        let retained=read_private_json(&root.join("evidence/ui-restart.json")).unwrap();
        assert!(exact_fields(&retained,&["schemaVersion","report","observations"]).is_ok());
        assert_eq!(retained["report"]["phase"],"restart");assert_eq!(retained["observations"]["phase"],"restart");
        assert_eq!(retained["observations"]["keyringSets"],0);assert_eq!(retained["observations"]["guiVerified"],false);
    }
    #[test] fn mysql_host_restart_wrong_phase_never_creates_report() {
        let(repo,temp,root,manifest)=fixture(RUN);
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        assert!(initial.retain_ui_report(&successful_restart_report(),&AcceptanceSecrets::new(&initial)).is_err());
        let restart=AcceptanceRun::prepare(root.clone(),RUN.into(),"restart".into(),manifest,&temp,&repo).unwrap();
        assert!(restart.retain_ui_report(&successful_report(),&AcceptanceSecrets::new(&restart)).is_err());
        assert!(!root.join("evidence/ui-initial.json").exists());assert!(!root.join("evidence/ui-restart.json").exists());
    }
    #[test] fn mysql_host_restart_password_script_rejected_before_secret_metadata() {
        let(repo,temp,root,manifest)=fixture(RUN);
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        let mut restart=AcceptanceRun::prepare(root,RUN.into(),"restart".into(),manifest,&temp,&repo).unwrap();
        assert_eq!(initial.store_id,restart.store_id);assert_eq!(initial.namespace(),restart.namespace());
        restart.app_secret=repo.join("must-not-be-opened-missing-app.secret");
        assert_eq!(restart.password_script().unwrap_err().code,"unsupported");
        assert_eq!(restart.context()["phase"],"restart");
    }
    #[test] fn mysql_host_bridge_origin_rejects_remote_dev_and_nonmain() {
        assert!(bridge_window_allowed("main","tauri://localhost/index.html"));
        assert!(bridge_window_allowed("main","http://tauri.localhost/"));
        for (label,url) in [("other","tauri://localhost/"),("main","https://example.com/"),("main","http://127.0.0.1:1420/"),("main","tauri://localhost/other.html"),("main","tauri://localhost/?secret=forbidden"),("main","tauri://user@localhost/")] {assert!(!bridge_window_allowed(label,url));}
    }
    #[test] fn mysql_host_bridge_password_phase_precedes_file_access() {
        let missing=Path::new("/nonexistent-owned-fixture-not-opened");
        for phase in ["restart","soak","unknown"] {assert_eq!(read_app_password(phase,missing,&missing.join("app.secret")).unwrap_err().code,"unsupported");}
    }
    #[test] fn mysql_host_bridge_password_reads_only_app_and_strips_one_lf() {
        let(_repo,_temp,_root,manifest)=fixture(RUN);let base=manifest.parent().unwrap();
        assert!(read_app_password("initial",base,&base.join("app.secret")).is_ok_and(|value|value=="synthetic-password"));
        assert!(read_app_password("initial",base,&base.join("observer.secret")).is_err());
    }
    #[test] fn mysql_host_bridge_password_rechecks_permissions_and_hardlinks() {
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let(_repo,_temp,_root,manifest)=fixture(RUN);let base=manifest.parent().unwrap();let secret=base.join("app.secret");
            fs::set_permissions(&secret,fs::Permissions::from_mode(0o644)).unwrap();
            assert!(read_app_password("initial",base,&secret).is_err());
            let(_repo,_temp,_root,manifest)=fixture(RUN);let base=manifest.parent().unwrap();let secret=base.join("app.secret");
            assert!(fs::symlink_metadata(&secret).unwrap().is_file());
            let alias=base.join("owned-alias");assert!(!alias.exists());fs::hard_link(&secret,alias).unwrap();
            assert!(read_app_password("initial",base,&secret).is_err());
        }
    }
    #[test] fn mysql_host_bridge_password_rejects_symlink_without_reading() {
        #[cfg(unix)] {
            let(_repo,_temp,_root,manifest)=fixture(RUN);let base=manifest.parent().unwrap();let directory=base.join("link-case");create_private_dir(&directory).unwrap();
            let target=base.join("app.secret");assert!(fs::symlink_metadata(&target).unwrap().is_file());
            std::os::unix::fs::symlink(target,directory.join("app.secret")).unwrap();
            assert!(read_app_password("initial",&directory,&directory.join("app.secret")).is_err());
        }
    }
    #[test] fn mysql_host_bridge_password_rejects_encoding_size_and_multiline() {
        for content in [vec![0xff],vec![b'x';4098],Vec::new(),b"one\ntwo\n".to_vec(),b"nul\0value\n".to_vec()] {
            let(_repo,_temp,_root,manifest)=fixture_with_secret(RUN,&content,|_|{});let base=manifest.parent().unwrap();
            assert!(read_app_password("initial",base,&base.join("app.secret")).is_err());
        }
    }
    #[test] fn mysql_host_bridge_password_script_escapes_and_guards_target() {
        let(repo,temp,root,manifest)=fixture(RUN);let run=AcceptanceRun::prepare(root,RUN.into(),"initial".into(),manifest,&temp,&repo).unwrap();
        let synthetic="quote\" backslash\\ </script> \u{2028} end";
        let script=password_dom_script(&run.context(),synthetic).unwrap();
        assert!(!script.contains("</script>"));assert!(!script.contains('\u{2028}'));assert!(script.contains("\\u003c/script>"));
        assert!(script.contains("dialogs.length!==1"));assert!(script.contains("inputs.length!==1"));
        assert!(script.contains("['host','port','database','user']"));assert!(script.contains("value!=='mysql'"));
        assert!(script.contains("new Event('input',{bubbles:true})"));assert!(!script.contains("console."));
    }
    #[test] fn mysql_host_bridge_report_success_exact_envelope_is_exclusive() {
        let(repo,temp,root,manifest)=fixture(RUN);let run=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest,&temp,&repo).unwrap();
        let secrets=AcceptanceSecrets::new(&run);let report=successful_report();
        assert!(run.retain_ui_report(&report,&secrets).unwrap());assert!(run.retain_ui_report(&report,&secrets).is_err());
        let retained=read_private_json(&root.join("evidence/ui-initial.json")).unwrap();
        assert!(exact_fields(&retained,&["schemaVersion","report","observations"]).is_ok());
        assert_eq!(retained["report"],report);assert_eq!(retained["observations"]["guiVerified"],false);
        assert_eq!(retained["observations"]["keyringGets"],0);
    }
    #[test] fn mysql_host_bridge_report_rejects_unknown_fields_checks_and_messages() {
        for (pointer,value) in [("/sql",json!("SELECT forbidden")),("/checks/unknown",json!(true)),("/actions/extra",json!(0)),("/pages/first/html",json!("<div>"))] {
            let mut report=successful_report();let parts:Vec<_>=pointer.trim_start_matches('/').split('/').collect();
            let mut target=&mut report;for part in &parts[..parts.len()-1] {target=&mut target[*part];}target[parts[parts.len()-1]]=value;
            assert!(validate_ui_report(&report,RUN,"initial").is_err());
        }
        let mut report=successful_report();report["failureCode"]=json!("arbitrary error text");assert!(validate_ui_report(&report,RUN,"initial").is_err());
    }
    #[test] fn mysql_host_bridge_report_rejects_bad_numbers_hashes_and_pages() {
        for (pointer,value) in [("/actions/click",json!(-1)),("/actions/input",json!(1.5)),("/elapsedMs",json!(-0.1)),("/pages/first/count",json!(201)),("/pages/next/offset",json!(806)),("/pages/first/idsSha256",json!("A".repeat(64))),("/pages/first/firstId",json!(2))] {
            let mut report=successful_report();*report.pointer_mut(pointer).unwrap()=value;assert!(validate_ui_report(&report,RUN,"initial").is_err());
        }
    }
    #[test] fn mysql_host_bridge_report_failure_retained_but_not_promoted() {
        let mut report=successful_report();
        for check in report["checks"].as_object_mut().unwrap().values_mut() {*check=json!(false);}
        report["pages"]=json!({"first":null,"next":null,"back":null});report["failureCode"]=json!("ISOLATION");
        assert!(!validate_ui_report(&report,RUN,"initial").unwrap());
        assert!(validate_ui_report(&report,"ffffffffffffffffffffffffffffffff","initial").is_err());
        assert!(validate_ui_report(&report,RUN,"restart").is_err());
        report["failureCode"]=json!("NONE");assert!(validate_ui_report(&report,RUN,"initial").is_err());
    }
    #[test] fn mysql_host_negative_run_id_and_phase_fail_before_root_creation() {
        let(repo,temp,root,manifest)=fixture(RUN);
        for run in ["", "../outside", "1234567890ABCDEF1234567890ABCDEF", "00000000000000000000000000000000"] {
            assert!(AcceptanceRun::prepare(root.clone(),run.into(),"initial".into(),manifest.clone(),&temp,&repo).is_err());assert!(!root.exists());
        }
        assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"unknown".into(),manifest,&temp,&repo).is_err());assert!(!root.exists());
    }
    #[test] fn mysql_host_negative_wrong_root_manifest_and_restart_fail_closed() {
        let(repo,temp,root,manifest)=fixture(RUN);
        assert!(AcceptanceRun::prepare(repo.join("wrong-root"),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).is_err());
        assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),repo.join("other-manifest.json"),&temp,&repo).is_err());
        assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"restart".into(),manifest,&temp,&repo).is_err());assert!(!root.exists());
    }
    #[test] fn mysql_host_initial_restart_keep_store_and_namespace_without_vault_access() {
        let(repo,temp,root,manifest)=fixture(RUN);
        let initial=AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).unwrap();
        assert_eq!(initial.namespace(),format!("io.dbstudio.acceptance.mysql.{RUN}"));
        assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest.clone(),&temp,&repo).is_err());
        let restart=AcceptanceRun::prepare(root,RUN.into(),"restart".into(),manifest,&temp,&repo).unwrap();
        assert_eq!(initial.store_id,restart.store_id);
        let secrets=AcceptanceSecrets::new(&restart);
        assert_eq!(secrets.remove("synthetic").unwrap_err().code,"unsupported");
        restart.record("runQuery",true,3);restart.retain_snapshot(&secrets).unwrap();
        assert_eq!(restart.snapshot(&secrets).unwrap()["methods"]["runQuery"]["success"],1);
        assert!(restart.context().get("secretFilePath").is_none());assert!(restart.context().get("password").is_none());
    }
    #[test] fn mysql_host_negative_prepared_not_ready_manifest_rejected() {
        let(repo,temp,root,manifest)=fixture_with(RUN,|value|{value["ready"]=json!(false);});
        assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest,&temp,&repo).is_err());assert!(!root.exists());
    }
    #[test] fn mysql_host_negative_zero_port_rejected_when_ready() {
        let(repo,temp,root,manifest)=fixture_with(RUN,|value|{value["port"]=json!(0);});
        assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest,&temp,&repo).is_err());assert!(!root.exists());
    }
    #[test] fn mysql_host_negative_manifest_permissions_rejected() {
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let(repo,temp,root,manifest)=fixture(RUN);
            fs::set_permissions(&manifest,fs::Permissions::from_mode(0o644)).unwrap();
            assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest,&temp,&repo).is_err());assert!(!root.exists());
        }
    }
    #[test] fn mysql_host_negative_app_secret_permissions_rejected_without_read() {
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let(repo,temp,root,manifest)=fixture(RUN);
            let secret=manifest.parent().unwrap().join("app.secret");
            fs::set_permissions(secret,fs::Permissions::from_mode(0o644)).unwrap();
            assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest,&temp,&repo).is_err());assert!(!root.exists());
        }
    }
    #[test] fn mysql_host_negative_manifest_hardlink_rejected() {
        let(repo,temp,root,manifest)=fixture(RUN);
        // Both source and new link are regular, newly-created files in this exact synthetic fixture.
        assert!(fs::symlink_metadata(&manifest).unwrap().is_file());
        let alias=manifest.parent().unwrap().join("owned-manifest-alias.json");assert!(!alias.exists());
        fs::hard_link(&manifest,alias).unwrap();
        assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest,&temp,&repo).is_err());assert!(!root.exists());
    }
    #[test] fn mysql_host_negative_app_secret_hardlink_rejected_without_read() {
        let(repo,temp,root,manifest)=fixture(RUN);
        let secret=manifest.parent().unwrap().join("app.secret");
        assert!(fs::symlink_metadata(&secret).unwrap().is_file());
        let alias=manifest.parent().unwrap().join("owned-secret-alias");assert!(!alias.exists());
        fs::hard_link(&secret,alias).unwrap();
        assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),manifest,&temp,&repo).is_err());assert!(!root.exists());
    }
    #[test] fn mysql_host_negative_manifest_symlink_rejected_without_following() {
        #[cfg(unix)] {
            let(repo,temp,root,manifest)=fixture_with(RUN,|value|{
                let destination=Path::new(value["fixtureRoot"].as_str().unwrap()).join("owned-alternate-manifest.json");
                create_private_json(&destination,&json!({"synthetic":true})).unwrap();
            });
            // Keep the existing manifest intact; use a fresh independent fixture to create the link.
            let link_root=temp.join("link-case");create_private_dir(&link_root).unwrap();
            let link_repo=link_root.join("repo");create_private_dir(&link_repo).unwrap();create_private_dir(&link_repo.join("backups")).unwrap();
            let fixture=link_repo.join("backups").join(format!("mysql-parity-fixture-{RUN}"));create_private_dir(&fixture).unwrap();
            let target=manifest.parent().unwrap().join("owned-alternate-manifest.json");
            assert!(fs::symlink_metadata(&target).unwrap().is_file());
            let link=fixture.join("manifest.ready.json");assert!(!link.exists());
            std::os::unix::fs::symlink(target,&link).unwrap();
            assert!(AcceptanceRun::prepare(root.clone(),RUN.into(),"initial".into(),link,&temp,&link_repo).is_err());assert!(!root.exists());
            let _=repo;
        }
    }
    #[test] fn mysql_host_negative_symlink_root_rejected_without_touching_target() {
        #[cfg(unix)] {
            let(repo,temp,root,manifest)=fixture(RUN);let target=temp.join("owned-target");create_private_dir(&target).unwrap();
            std::os::unix::fs::symlink(&target,&root).unwrap();
            assert!(AcceptanceRun::prepare(root,RUN.into(),"restart".into(),manifest,&temp,&repo).is_err());assert!(!target.join("data").exists());
        }
    }
}
