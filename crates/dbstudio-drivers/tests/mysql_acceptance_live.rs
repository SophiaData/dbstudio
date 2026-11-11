//! Retain-only native MySQL baseline. Run only through scripts/mysql-driver-acceptance.mjs.
//! All cases are deliberately ignored in ordinary suites. No GUI or performance claim.
use dbstudio_protocol::{ConnectionConfig, Driver, DriverError, SecretMap};
use mysql::{prelude::Queryable, Conn, OptsBuilder, Row, SslOpts};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::mpsc,
    thread::{self, JoinHandle},
    time::Duration,
};

const RUN: &str = "b51c7485c6364ad1b6a4cc52f09619de";
const MANIFEST_SHA: &str = "ad80c6250022db8bb165c76d0955727624bf2c41ed9ab9dae6153b88ea6833a9";
const CONTAINER: &str = "e5db8a8460a876df9cb2b9b89b2978772ab6366c74765fa7b0c997bb3ab63d46";
type Check<T> = Result<T, Fault>;
#[derive(Clone, Copy)]
struct Fault { code: &'static str, gap: bool }
fn infra(code: &'static str) -> Fault { Fault { code, gap: false } }
fn gap(code: &'static str) -> Fault { Fault { code, gap: true } }
fn require(condition: bool, code: &'static str) -> Check<()> {
    if condition { Ok(()) } else { Err(infra(code)) }
}
fn contract(condition: bool, code: &'static str) -> Check<()> {
    if condition { Ok(()) } else { Err(gap(code)) }
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Role { user: String, secret_file_path: PathBuf }
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Context {
    schema_version: u8, run_id: String, attempt_id: String,
    manifest_sha256: String, container_id: String,
    evidence_root: PathBuf, fixture_root: PathBuf,
    host: String, port: u16, database: String,
    app: Role, observer: Role, table: String,
}
fn workspace() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf()
}
fn private_directory(path: &Path) -> Check<()> {
    let info = fs::symlink_metadata(path).map_err(|_| infra("PRIVATE_DIRECTORY_INVALID"))?;
    require(info.is_dir() && !info.file_type().is_symlink() && info.permissions().mode() & 0o777 == 0o700,
        "PRIVATE_DIRECTORY_INVALID")?;
    require(fs::canonicalize(path).map_err(|_| infra("PRIVATE_DIRECTORY_INVALID"))? == path, "PRIVATE_DIRECTORY_ALIAS")
}
fn private_file(path: &Path, root: &Path, maximum: u64) -> Check<Vec<u8>> {
    require(path.parent() == Some(root), "PRIVATE_FILE_OUTSIDE_ROOT")?;
    let info = fs::symlink_metadata(path).map_err(|_| infra("PRIVATE_FILE_INVALID"))?;
    require(info.is_file() && !info.file_type().is_symlink() && info.nlink() == 1
        && info.permissions().mode() & 0o777 == 0o600 && info.len() <= maximum, "PRIVATE_FILE_INVALID")?;
    require(fs::canonicalize(path).map_err(|_| infra("PRIVATE_FILE_INVALID"))? == path, "PRIVATE_FILE_ALIAS")?;
    fs::read(path).map_err(|_| infra("PRIVATE_FILE_READ_FAILED"))
}
fn context() -> Check<Context> {
    let path = PathBuf::from(std::env::var_os("DBSTUDIO_MYSQL_DRIVER_ACCEPTANCE_CONFIG")
        .ok_or_else(|| infra("PRIVATE_INPUT_REQUIRED"))?);
    let root = path.parent().ok_or_else(|| infra("PRIVATE_INPUT_PATH_INVALID"))?;
    let name = root.file_name().and_then(|v| v.to_str()).ok_or_else(|| infra("PRIVATE_INPUT_PATH_INVALID"))?;
    let attempt = name.strip_prefix("mysql-driver-acceptance-").or_else(||name.strip_prefix("mysql-transaction-contract-")).ok_or_else(|| infra("PRIVATE_INPUT_PATH_INVALID"))?;
    require(hex(attempt, 32) && root.parent() == Some(workspace().join("backups").as_path())
        && path.file_name().and_then(|v| v.to_str()) == Some("config.json"), "PRIVATE_INPUT_PATH_INVALID")?;
    private_directory(root)?;
    let ctx: Context = serde_json::from_slice(&private_file(&path, root, 16 * 1024)?)
        .map_err(|_| infra("PRIVATE_INPUT_INVALID"))?;
    require(ctx.schema_version == 1 && ctx.attempt_id == attempt && ctx.evidence_root == root
        && ctx.run_id == RUN && ctx.manifest_sha256 == MANIFEST_SHA && ctx.container_id == CONTAINER,
        "PRIVATE_INPUT_IDENTITY_MISMATCH")?;
    let expected_fixture = workspace().join("backups").join(format!("mysql-parity-fixture-{RUN}"));
    require(ctx.fixture_root == expected_fixture && ctx.host == "127.0.0.1" && ctx.port > 0
        && ctx.database == format!("mysql_accept_{}", &RUN[..16])
        && ctx.table == format!("native_tx_{}", &ctx.attempt_id[..16]), "PRIVATE_INPUT_SERVICE_MISMATCH")?;
    private_directory(&ctx.fixture_root)?;
    for (name, role) in [("app", &ctx.app), ("observer", &ctx.observer)] {
        require(role.user == format!("{name}_{}", &RUN[..12])
            && role.secret_file_path == ctx.fixture_root.join(format!("{name}.secret")), "ROLE_IDENTITY_MISMATCH")?;
        // Only the test process reads generated credentials, after root/path/mode validation.
        let bytes = private_file(&role.secret_file_path, &ctx.fixture_root, 128)?;
        let value = std::str::from_utf8(&bytes).map_err(|_| infra("GENERATED_SECRET_INVALID"))?.trim();
        require(hex(value, 64), "GENERATED_SECRET_INVALID")?;
    }
    Ok(ctx)
}
fn password(ctx: &Context, role: &Role) -> Check<String> {
    let bytes = private_file(&role.secret_file_path, &ctx.fixture_root, 128)?;
    let value = std::str::from_utf8(&bytes).map_err(|_| infra("GENERATED_SECRET_INVALID"))?.trim();
    require(hex(value, 64), "GENERATED_SECRET_INVALID")?;
    Ok(value.to_owned())
}
fn native_driver(ctx: &Context) -> Check<Box<dyn Driver>> {
    let config: ConnectionConfig = serde_json::from_value(json!({"dialectId":"mysql","name":"native-acceptance",
        "options":{"host":ctx.host,"port":ctx.port,"database":ctx.database,"user":ctx.app.user,"sslmode":"require"}}))
        .map_err(|_| infra("DRIVER_CONFIG_INVALID"))?;
    let mut secrets = SecretMap::new();
    secrets.insert("dbPassword".into(), json!(password(ctx, &ctx.app)?));
    dbstudio_drivers::connect(&config, &secrets).map_err(|_| infra("NATIVE_CONNECT_FAILED"))
}
fn raw_connection(ctx: &Context, observer: bool) -> Check<Conn> {
    let role = if observer { &ctx.observer } else { &ctx.app };
    let opts = OptsBuilder::default().ip_or_hostname(Some("127.0.0.1")).tcp_port(ctx.port)
        .user(Some(role.user.clone())).pass(Some(password(ctx, role)?)).db_name(Some(ctx.database.clone()))
        .prefer_socket(false).bind_address(Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0)))
        .tcp_connect_timeout(Some(Duration::from_secs(5))).read_timeout(Some(Duration::from_secs(5)))
        .write_timeout(Some(Duration::from_secs(5)))
        .ssl_opts(Some(SslOpts::default().with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true)));
    let mut conn = Conn::new(opts).map_err(|_| infra("INDEPENDENT_CONNECT_FAILED"))?;
    for sql in ["SET NAMES utf8mb4", "SET SESSION time_zone='+00:00'", "SET SESSION autocommit=1",
        "SET SESSION innodb_lock_wait_timeout=3"] {
        conn.query_drop(sql).map_err(|_| infra("INDEPENDENT_SESSION_FAILED"))?;
    }
    if observer { conn.query_drop("SET SESSION TRANSACTION READ ONLY").map_err(|_| infra("OBSERVER_READ_ONLY_FAILED"))?; }
    Ok(conn)
}
fn observer_rows(ctx: &Context, sql: &str) -> Check<Vec<Row>> {
    raw_connection(ctx, true)?.query(sql).map_err(|_| infra("OBSERVER_QUERY_FAILED"))
}
fn gui_baseline(ctx: &Context) -> Check<()> {
    let rows = observer_rows(ctx, "SELECT COUNT(*)=805,MIN(id)=1,MAX(id)=805,SUM(big_value=9007199254740993)=805,SUM(default_text='fixture-default')=805,SUM(generated_text=CONCAT(body,'-computed'))=805,SUM(nullable_text IS NULL)=403,SUM(nullable_text='')=402 FROM items_805")?;
    require(rows.len() == 1 && (0..8).all(|i| rows[0].get::<u64, _>(i) == Some(1)), "GUI_BASELINE_CHANGED")
}
fn call(driver: &mut dyn Driver, method: &str, args: Vec<Value>) -> Check<Value> {
    driver.call(method, args).map_err(|_| infra("NATIVE_CALL_FAILED"))
}
fn finish_driver(driver: &mut dyn Driver) -> bool {
    let rollback = driver.call("rollbackTransaction", vec![]).ok()
        .is_some_and(|v| v["active"] == false && v["pendingAffected"] == 0);
    let disconnected = driver.disconnect().is_ok();
    rollback && disconnected
}
fn text(cell: &Value) -> Option<&str> { cell.get("text").and_then(Value::as_str) }
fn id(cell: &Value) -> Option<u64> { cell.get("value").and_then(Value::as_u64) }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u8, case_id: &'static str, outcome: &'static str, code: &'static str,
    cleanup_confirmed: bool, checks: BTreeMap<&'static str, bool>,
}
fn report(case_id: &'static str, result: Check<()>, cleanup: bool, checks: BTreeMap<&'static str, bool>) -> Report {
    let result = if cleanup { result } else { Err(infra("CLEANUP_UNCONFIRMED")) };
    let (outcome, code) = match result { Ok(()) => ("PASS", "OK"), Err(e) if e.gap => ("KNOWN_GAP_RED", e.code), Err(e) => ("INFRA_FAILED", e.code) };
    Report { schema_version: 1, case_id, outcome, code, cleanup_confirmed: cleanup, checks }
}
fn select_pages(ctx: &Context, case_id: &'static str) -> Report {
    let mut checks = BTreeMap::new();
    let mut driver = match native_driver(ctx) { Ok(d) => d, Err(e) => return report(case_id, Err(e), true, checks) };
    let mut cursors = Vec::new();
    let result = (|| {
        gui_baseline(ctx)?;
        let first = call(&mut *driver, "runQuery", vec![json!("SELECT id AS repeated,body AS repeated FROM items_805 ORDER BY id"), json!({"limit":200})])?;
        let cursor = first["cursorId"].as_str().ok_or_else(|| infra("CURSOR_MISSING"))?.to_owned();
        cursors.push(cursor.clone());
        contract(first["columns"][0]["name"] == "repeated" && first["columns"][1]["name"] == "repeated", "DUPLICATE_COLUMN_CONTRACT")?;
        checks.insert("duplicateColumnsPreserved", true);
        let mut seen = Vec::new();
        for offset in [0u64, 200, 400, 600, 800] {
            let page = if offset == 0 { first.clone() } else { call(&mut *driver, "fetchResultPage", vec![json!(cursor), json!(offset), json!(200)])? };
            let rows = page["rows"].as_array().ok_or_else(|| infra("ROWS_SHAPE_INVALID"))?;
            contract(rows.len() == if offset == 800 { 5 } else { 200 }
                && page["offset"] == offset && page["hasMore"] == (offset < 800), "PAGE_WINDOW_CONTRACT")?;
            for row in rows {
                let expected = seen.len() as u64 + 1;
                contract(id(&row["cells"][0]) == Some(expected) && row["index"] == expected - 1
                    && text(&row["cells"][1]) == Some(format!("样本-{expected:07}").as_str()), "PAGE_ROW_CONTRACT")?;
                seen.push(expected);
            }
        }
        contract(seen.len() == 805, "PAGE_COUNT_CONTRACT")?;
        checks.insert("allFivePagesOrdered", true);
        let limited = call(&mut *driver, "runQuery", vec![json!("SELECT id FROM items_805 ORDER BY id LIMIT 3 OFFSET 10"), json!({"limit":2})])?;
        let cursor = limited["cursorId"].as_str().ok_or_else(|| infra("CURSOR_MISSING"))?.to_owned(); cursors.push(cursor.clone());
        contract(limited["rows"].as_array().is_some_and(|r| r.len() == 2)
            && id(&limited["rows"][0]["cells"][0]) == Some(11) && id(&limited["rows"][1]["cells"][0]) == Some(12)
            && limited["hasMore"] == true, "ORIGINAL_LIMIT_CONTRACT")?;
        let last = call(&mut *driver, "fetchResultPage", vec![json!(cursor), json!(2), json!(2)])?;
        contract(last["rows"].as_array().is_some_and(|r| r.len() == 1) && id(&last["rows"][0]["cells"][0]) == Some(13)
            && last["hasMore"] == false, "ORIGINAL_LIMIT_CONTRACT")?;
        checks.insert("originalLimitWindowPreserved", true);
        Ok(())
    })();
    let cursors_closed = cursors.into_iter().all(|c| driver.call("closeCursor", vec![json!(c)]).is_ok());
    let cleaned = finish_driver(&mut *driver);
    let baseline = gui_baseline(ctx).is_ok(); checks.insert("guiBaselinePreserved", baseline);
    report(case_id, result, cursors_closed && cleaned && baseline, checks)
}
fn management(ctx: &Context, case_id: &'static str, kind: &str) -> Report {
    let mut checks = BTreeMap::new();
    let sql = match kind {
        "tables" => "SHOW TABLES".to_owned(),
        "create" => format!("SHOW CREATE TABLE `{}`.`items_805`", ctx.database),
        "describe" => format!("DESCRIBE `{}`.`items_805`", ctx.database),
        _ => format!("EXPLAIN SELECT id FROM `{}`.`items_805` WHERE id=1", ctx.database),
    };
    let mut driver = match native_driver(ctx) { Ok(d) => d, Err(e) => return report(case_id, Err(e), true, checks) };
    let mut cursor = None;
    let result = (|| {
        let reference = observer_rows(ctx, &sql)?;
        require(!reference.is_empty(), "SERVER_REFERENCE_EMPTY")?;
        checks.insert("independentServerReferenceRows", true);
        let response = driver.call("executeStatement", vec![json!(sql),json!({"limit":200})]);
        let value = match response {
            Ok(value) => value,
            Err(error) if error.code == "unsupported" => {
                checks.insert("driverReturnedUnsupported", true);
                return Err(gap("MANAGEMENT_ROWS_UNSUPPORTED"));
            },
            Err(_) => return Err(infra("MANAGEMENT_CALL_FAILED")),
        };
        cursor = value["result"]["cursorId"].as_str().map(str::to_owned);
        let result = &value["result"];
        contract(value["kind"] == "rows" && result["columns"].as_array().is_some_and(|v| !v.is_empty())
            && result["rows"].as_array().is_some_and(|v| !v.is_empty()), "MANAGEMENT_ROWS_CONTRACT")?;
        let rows = result["rows"].as_array().ok_or_else(|| infra("ROWS_SHAPE_INVALID"))?;
        let valid = match kind {
            "tables" => rows.iter().any(|r| text(&r["cells"][0]) == Some("items_805")),
            "create" => rows.iter().any(|r| text(&r["cells"][1]).is_some_and(|s| s.contains("CREATE TABLE"))),
            "describe" => rows.iter().any(|r| text(&r["cells"][0]) == Some("id")),
            _ => result["columns"].as_array().unwrap().iter().any(|c| c["name"] == "select_type"),
        };
        contract(valid, "MANAGEMENT_CONTENT_CONTRACT")?;
        checks.insert("nativeManagementRows", true);
        let state = call(&mut *driver,"transactionState",vec![])?;
        contract(state["active"] == false && state["pendingAffected"] == 0,"MANAGEMENT_NONTRANSACTIONAL_CONTRACT")?;
        checks.insert("managementRemainsNontransactional",true);
        Ok(())
    })();
    let closed = cursor.is_none_or(|c| driver.call("closeCursor",vec![json!(c)]).is_ok());
    let cleaned = finish_driver(&mut *driver);
    let baseline = gui_baseline(ctx).is_ok(); checks.insert("guiBaselinePreserved", baseline);
    report(case_id, result, closed && cleaned && baseline, checks)
}
fn management_cursor(page:&Value,cursors:&mut Vec<String>)->Check<String>{
    let cursor=page["cursorId"].as_str().ok_or_else(||infra("CURSOR_MISSING"))?.to_owned();
    cursors.push(cursor.clone());Ok(cursor)
}
fn management_names(page:&Value)->Check<Vec<String>>{
    page["rows"].as_array().ok_or_else(||infra("ROWS_SHAPE_INVALID"))?.iter().map(|r|
        text(&r["cells"][0]).map(str::to_owned).ok_or_else(||infra("ROWS_SHAPE_INVALID"))).collect()
}
fn snapshot_management(ctx:&Context,case_id:&'static str)->Report{
    let mut checks=BTreeMap::new();
    let mut driver=match native_driver(ctx){Ok(d)=>d,Err(e)=>return report(case_id,Err(e),true,checks)};
    let mut cursors=Vec::new();let mut mutator:Option<Conn>=None;let mut created=false;
    let name=format!("native_mgmt_{}",&ctx.attempt_id[..16]);
    let table=format!("`{}`.`{name}`",ctx.database);
    let result=(||{
        gui_baseline(ctx)?;
        let reference:Check<Vec<String>>=observer_rows(ctx,"SHOW TABLES")?.iter().map(|r|r.get::<String,_>(0).ok_or_else(||infra("SERVER_REFERENCE_EMPTY"))).collect();
        let reference=reference?;
        let first=call(&mut *driver,"runQuery",vec![json!("SHOW TABLES"),json!({"limit":1})])?;
        let list_cursor=management_cursor(&first,&mut cursors)?;
        mutator=Some(raw_connection(ctx,false)?);
        let comment_a="A".repeat(1800);let comment_b="B".repeat(1800);
        mutator.as_mut().unwrap().query_drop(format!("CREATE TABLE {table}(id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB COMMENT='{comment_a}'"))
            .map_err(|_|infra("MANAGEMENT_FIXTURE_DDL_FAILED"))?;created=true;
        let mut names=management_names(&first)?;let mut offset=names.len();let mut more=first["hasMore"]==true;
        while more{
            require(offset<10_000,"MANAGEMENT_PAGE_NO_PROGRESS")?;
            let page=call(&mut *driver,"fetchResultPage",vec![json!(list_cursor),json!(offset),json!(1)])?;
            let next=management_names(&page)?;
            contract(page["offset"]==offset&&page["returned"]==next.len()&&next.len()==1
                &&page["rows"][0]["index"]==offset,"MANAGEMENT_SNAPSHOT_CONTRACT")?;
            offset+=next.len();names.extend(next);more=page["hasMore"]==true;
        }
        contract(names==reference&&!names.contains(&name),"MANAGEMENT_SNAPSHOT_CONTRACT")?;
        checks.insert("snapshotPagingDidNotReplay",true);
        let fresh=call(&mut *driver,"runQuery",vec![json!(format!("SHOW TABLES LIKE '{name}'")),json!({"keepCursor":false,"limit":1})])?;
        contract(fresh["cursorId"].is_null()&&management_names(&fresh)?.contains(&name),"MANAGEMENT_SNAPSHOT_CONTRACT")?;
        checks.insert("keepCursorFalseRespected",true);
        let show=format!("SHOW CREATE TABLE {table}");
        let ddl_reference=observer_rows(ctx,&show)?.first().and_then(|r|r.get::<String,_>(1)).ok_or_else(||infra("SERVER_REFERENCE_EMPTY"))?;
        let ddl=call(&mut *driver,"executeStatement",vec![json!(show),json!({"limit":1})])?;
        contract(ddl["kind"]=="rows"&&ddl["result"]["rows"][0]["cells"][1]["truncated"]==true,"MANAGEMENT_LONG_VALUE_CONTRACT")?;
        let ddl_cursor=management_cursor(&ddl["result"],&mut cursors)?;
        let full=call(&mut *driver,"fetchCellValue",vec![json!(ddl_cursor),json!(0),json!(1)])?;
        contract(text(&full)==Some(ddl_reference.as_str())&&text(&full).is_some_and(|s|s.contains(&comment_a)),"MANAGEMENT_LONG_VALUE_CONTRACT")?;
        mutator.as_mut().unwrap().query_drop(format!("ALTER TABLE {table} COMMENT='{comment_b}'"))
            .map_err(|_|infra("MANAGEMENT_FIXTURE_DDL_FAILED"))?;
        let after=call(&mut *driver,"fetchCellValue",vec![json!(ddl_cursor),json!(0),json!(1)])?;
        contract(after==full,"MANAGEMENT_LONG_VALUE_CONTRACT")?;
        let current_reference=observer_rows(ctx,&show)?.first().and_then(|r|r.get::<String,_>(1)).ok_or_else(||infra("SERVER_REFERENCE_EMPTY"))?;
        require(current_reference!=ddl_reference&&current_reference.contains(&comment_b),"MANAGEMENT_MUTATION_NOT_OBSERVED")?;
        let current=call(&mut *driver,"runQuery",vec![json!(show),json!({"limit":1})])?;
        let current_cursor=management_cursor(&current,&mut cursors)?;
        let current_full=call(&mut *driver,"fetchCellValue",vec![json!(current_cursor),json!(0),json!(1)])?;
        contract(text(&current_full)==Some(current_reference.as_str()),"MANAGEMENT_LONG_VALUE_CONTRACT")?;
        checks.insert("longDdlSnapshotExactAfterMutation",true);
        // Existing cursor count is known to this case; fill to the public retained-cursor cap.
        while cursors.len()<16{
            let page=call(&mut *driver,"runQuery",vec![json!(format!("SHOW TABLES LIKE '{name}'")),json!({"limit":1})])?;
            management_cursor(&page,&mut cursors)?;
        }
        let overflow=driver.call("runQuery",vec![json!(format!("SHOW TABLES LIKE '{name}'")),json!({"limit":1})]);
        contract(overflow.as_ref().err().is_some_and(|e|e.code=="resource-limit"),"MANAGEMENT_CURSOR_LIMIT_CONTRACT")?;
        let closed=cursors.pop().unwrap();call(&mut *driver,"closeCursor",vec![json!(closed)])?;
        contract(driver.call("fetchResultPage",vec![json!(closed),json!(0),json!(1)]).as_ref().err().is_some_and(|e|e.code=="not-found")
            &&driver.call("fetchCellValue",vec![json!(closed),json!(0),json!(0)]).as_ref().err().is_some_and(|e|e.code=="not-found"),"MANAGEMENT_CURSOR_CLOSE_CONTRACT")?;
        let replacement=call(&mut *driver,"runQuery",vec![json!(format!("SHOW TABLES LIKE '{name}'")),json!({"limit":1})])?;
        management_cursor(&replacement,&mut cursors)?;
        checks.insert("cursorCloseReleasesCapacity",true);
        let state=call(&mut *driver,"transactionState",vec![])?;
        contract(state["active"]==false&&state["pendingAffected"]==0,"MANAGEMENT_NONTRANSACTIONAL_CONTRACT")?;
        checks.insert("managementRemainsNontransactional",true);Ok(())
    })();
    let mut cleanup=true;
    for cursor in cursors{cleanup&=driver.call("closeCursor",vec![json!(cursor)]).is_ok();}
    cleanup&=finish_driver(&mut *driver);
    if let Some(conn)=mutator.as_mut(){cleanup&=conn.query_drop("ROLLBACK").is_ok();}
    if created{cleanup&=observer_rows(ctx,&format!("SELECT COUNT(*) FROM {table}")).ok().and_then(|r|r.first().and_then(|r|r.get::<u64,_>(0)))==Some(0);}
    let baseline=gui_baseline(ctx).is_ok();checks.insert("guiBaselinePreserved",baseline);cleanup&=baseline;
    report(case_id,result,cleanup,checks)
}
fn explain_policy(ctx:&Context,case_id:&'static str)->Report{
    let mut checks=BTreeMap::new();let mut cursors=Vec::new();
    let mut driver=match native_driver(ctx){Ok(d)=>d,Err(e)=>return report(case_id,Err(e),true,checks)};
    let result=(||{
        let text_result=call(&mut *driver,"executeStatement",vec![json!("EXPLAIN SELECT id FROM items_805 WHERE id=1"),json!({"limit":1})])?;
        let bound_result=call(&mut *driver,"executeStatement",vec![json!("EXPLAIN SELECT id FROM items_805 WHERE id=?"),json!({"limit":1,"parameters":[{"name":"?1","value":1}]})])?;
        management_cursor(&text_result["result"],&mut cursors)?;management_cursor(&bound_result["result"],&mut cursors)?;
        let mut ids=Vec::new();
        for response in [&text_result,&bound_result]{
            contract(response["kind"]=="rows","MANAGEMENT_BOUND_RESULT_CONTRACT")?;
            let result=&response["result"];let index=result["columns"].as_array().and_then(|c|c.iter().position(|c|c["name"]=="id")).ok_or_else(||infra("ROWS_SHAPE_INVALID"))?;
            let value=&result["rows"][0]["cells"][index];
            contract(value["kind"]=="number"&&id(value)==Some(1),"MANAGEMENT_BOUND_RESULT_CONTRACT")?;
            ids.push(value.clone());
        }
        contract(ids[0]==ids[1],"MANAGEMENT_BOUND_RESULT_CONTRACT")?;
        checks.insert("textAndBinaryNumericResultsAgree",true);
        for sql in ["EXPLAIN ANALYZE SELECT id FROM items_805 WHERE id=1","EXPLAIN FORMAT=JSON SELECT id FROM items_805","CALL acceptance_unsupported_procedure()"]{
            let rejected=driver.call("executeStatement",vec![json!(sql),json!({})]);
            contract(rejected.as_ref().err().is_some_and(|e|e.code=="unsupported"),"MANAGEMENT_EXPLAIN_POLICY_CONTRACT")?;
        }
        checks.insert("explainExecutionVariantsRejected",true);
        let state=call(&mut *driver,"transactionState",vec![])?;
        contract(state["active"]==false&&state["pendingAffected"]==0,"MANAGEMENT_NONTRANSACTIONAL_CONTRACT")?;
        checks.insert("managementRemainsNontransactional",true);Ok(())
    })();
    let mut cleanup=true;for cursor in cursors{cleanup&=driver.call("closeCursor",vec![json!(cursor)]).is_ok();}
    cleanup&=finish_driver(&mut *driver);
    let baseline=gui_baseline(ctx).is_ok();checks.insert("guiBaselinePreserved",baseline);cleanup&=baseline;
    report(case_id,result,cleanup,checks)
}
struct Actor {
    which: u8, driver: Box<dyn Driver>,
    cross: Result<Value, DriverError>, snapshot: Check<Value>,
}
fn spawn_actor(which: u8, mut driver: Box<dyn Driver>, table: String,
    release: mpsc::Receiver<()>, done: mpsc::Sender<Actor>) -> JoinHandle<()> {
    thread::spawn(move || {
        let cross = if release.recv_timeout(Duration::from_secs(3)).is_ok() {
            driver.call("executeStatement", vec![json!(format!("UPDATE {table} SET v=v+1 WHERE id={}",if which == 1 {2}else{1})),json!({})])
        } else { Err(DriverError::new("acceptance-timeout", "ACTOR_RELEASE_TIMEOUT")) };
        let snapshot = call(&mut *driver,"transactionState",vec![]);
        // If the receiver is gone, dropping the returned driver closes its native session.
        let _ = done.send(Actor { which, driver, cross, snapshot });
    })
}
fn transaction_baseline(ctx: &Context, table: &str) -> Check<()> {
    let rows = observer_rows(ctx, &format!("SELECT COUNT(*)=4,SUM(v=0)=4 FROM {table}"))?;
    require(rows.len() == 1 && rows[0].get::<u64,_>(0) == Some(1) && rows[0].get::<u64,_>(1) == Some(1), "TRANSACTION_BASELINE_CHANGED")
}
fn marker_unlocked(ctx: &Context, table: &str, marker: u8) -> Check<()> {
    let mut probe = raw_connection(ctx, false)?;
    probe.query_drop("START TRANSACTION").map_err(|_| infra("LOCK_PROBE_START_FAILED"))?;
    let queried = probe.query::<Row,_>(format!("SELECT id,v FROM {table} WHERE id={marker} FOR UPDATE NOWAIT"));
    let rolled_back = probe.query_drop("ROLLBACK").is_ok();
    require(rolled_back, "LOCK_PROBE_ROLLBACK_FAILED")?;
    let rows = queried.map_err(|_| infra("VICTIM_MARKER_STILL_LOCKED"))?;
    require(rows.len() == 1 && rows[0].get::<u64,_>(0) == Some(marker as u64)
        && rows[0].get::<u64,_>(1) == Some(0), "VICTIM_MARKER_NOT_BASELINE")
}
fn deadlock(ctx: &Context, case_id: &'static str) -> Report {
    let mut checks = BTreeMap::new();
    let table = format!("`{}`.`{}`",ctx.database,ctx.table);
    let mut setup: Option<Box<dyn Driver>> = None;
    let mut unstarted: Vec<Box<dyn Driver>> = Vec::new();
    let mut actors: Vec<Actor> = Vec::new();
    let mut handles = Vec::new();
    let (done_tx, done_rx) = mpsc::channel();
    let mut seeded = false;
    let result = (|| {
        gui_baseline(ctx)?;
        let settings = observer_rows(ctx,"SELECT @@global.innodb_deadlock_detect")?;
        require(settings.len() == 1 && settings[0].get::<u64,_>(0) == Some(1), "DEADLOCK_DETECTION_REQUIRED")?;
        setup = Some(native_driver(ctx)?);
        let d = setup.as_mut().unwrap();
        call(&mut **d,"executeStatement",vec![json!(format!("CREATE TABLE {table} (id INT NOT NULL PRIMARY KEY,v INT NOT NULL DEFAULT 0) ENGINE=InnoDB")),json!({})])?;
        call(&mut **d,"executeStatement",vec![json!(format!("INSERT INTO {table}(id,v) VALUES(1,0),(2,0),(3,0),(4,0)")),json!({})])?;
        let committed = call(&mut **d,"commitTransaction",vec![])?;
        require(committed["active"] == false && committed["pendingAffected"] == 0,"BASELINE_COMMIT_UNCONFIRMED")?;
        seeded = true; transaction_baseline(ctx,&table)?;
        unstarted.push(native_driver(ctx)?); unstarted.push(native_driver(ctx)?);
        // Establish disjoint marker and key locks before either cross-update can start.
        for (index, d) in unstarted.iter_mut().enumerate() {
            let key = index + 1; let marker = index + 3;
            for row in [marker,key] {
                call(&mut **d,"executeStatement",vec![json!(format!("UPDATE {table} SET v=v+1 WHERE id={row}")),json!({})])?;
            }
        }
        let b = unstarted.pop().unwrap(); let a = unstarted.pop().unwrap();
        let (a_tx,a_rx) = mpsc::channel(); let (b_tx,b_rx) = mpsc::channel();
        handles.push(spawn_actor(1,a,table.clone(),a_rx,done_tx.clone()));
        handles.push(spawn_actor(2,b,table.clone(),b_rx,done_tx.clone()));
        a_tx.send(()).map_err(|_|infra("ACTOR_RELEASE_FAILED"))?;
        b_tx.send(()).map_err(|_|infra("ACTOR_RELEASE_FAILED"))?;
        for _ in 0..2 {
            actors.push(done_rx.recv_timeout(Duration::from_secs(15)).map_err(|_|infra("ACTOR_RESULT_TIMEOUT"))?);
        }
        let victims: Vec<usize> = actors.iter().enumerate().filter_map(|(i,a)| a.cross.as_ref().err()
            .filter(|e|e.code == "driver-error" && e.message.contains("SQLSTATE 40001, code 1213")).map(|_|i)).collect();
        require(victims.len() == 1 && actors.iter().filter(|a|a.cross.is_ok()).count() == 1,"ACTUAL_DEADLOCK_NOT_OBSERVED")?;
        checks.insert("actualDeadlock1213Observed",true);
        let victim = victims[0]; let survivor = 1-victim;
        let state = actors[victim].snapshot.as_ref().map_err(|e|*e)?.clone();
        require(state["active"].is_boolean() && state["pendingAffected"].as_u64().is_some(), "TRANSACTION_STATE_SHAPE_INVALID")?;
        let survivor_state = call(&mut *actors[survivor].driver,"rollbackTransaction",vec![])?;
        require(survivor_state["active"] == false && survivor_state["pendingAffected"] == 0,"SURVIVOR_ROLLBACK_UNCONFIRMED")?;
        // Victim gets no transaction control until after server/observer evidence is captured.
        transaction_baseline(ctx,&table)?;
        checks.insert("observerConfirmedWholeRollback",true);
        marker_unlocked(ctx,&table,if actors[victim].which == 1 {3}else{4})?;
        checks.insert("victimMarkerUnlockedBeforeCleanup",true);
        checks.insert("victimCachedActive",state["active"].as_bool().unwrap_or(true));
        checks.insert("victimCachedPendingNonzero",state["pendingAffected"].as_u64().is_some_and(|v|v>0));
        contract(state["active"] == false && state["pendingAffected"] == 0,"DEADLOCK_TRANSACTION_STATE_STALE")?;
        checks.insert("transactionStateMatchesServer",true);
        Ok(())
    })();
    // Never assert before rollback, worker collection and fresh independent readback finish.
    let mut cleanup = true;
    for handle in handles { cleanup &= handle.join().is_ok(); }
    while let Ok(actor) = done_rx.try_recv() { actors.push(actor); }
    for actor in &mut actors { cleanup &= finish_driver(&mut *actor.driver); }
    for driver in &mut unstarted { cleanup &= finish_driver(&mut **driver); }
    if let Some(driver) = setup.as_mut() { cleanup &= finish_driver(&mut **driver); }
    if seeded { cleanup &= transaction_baseline(ctx,&table).is_ok(); }
    let baseline = gui_baseline(ctx).is_ok(); checks.insert("guiBaselinePreserved",baseline);
    cleanup &= baseline; checks.insert("allSessionsRolledBack",cleanup);
    report(case_id,result,cleanup,checks)
}
fn contract_table(ctx:&Context,kind:&str)->String{
    format!("`{}`.`native_tx_contract_{kind}_{}`",ctx.database,&ctx.attempt_id[..16])
}
fn seed_contract(driver:&mut dyn Driver,table:&str)->Check<()>{
    call(driver,"executeStatement",vec![json!(format!("CREATE TABLE {table}(id INT NOT NULL PRIMARY KEY,v INT NOT NULL DEFAULT 0) ENGINE=InnoDB")),json!({})])?;
    call(driver,"executeStatement",vec![json!(format!("INSERT INTO {table}(id,v) VALUES(1,0),(2,0)")),json!({})])?;
    let committed=call(driver,"commitTransaction",vec![])?;
    require(committed["active"]==false&&committed["pendingAffected"]==0,"BASELINE_COMMIT_UNCONFIRMED")
}
fn contract_observer(ctx:&Context,table:&str,first:u64,second:u64)->Check<()>{
    let rows=observer_rows(ctx,&format!("SELECT COUNT(*)=2,SUM(id=1 AND v={first})=1,SUM(id=2 AND v={second})=1 FROM {table}"))?;
    require(rows.len()==1&&(0..3).all(|i|rows[0].get::<u64,_>(i)==Some(1)),"TRANSACTION_CONTRACT_OBSERVER_MISMATCH")
}
fn own_number(driver:&mut dyn Driver,sql:String)->Check<u64>{
    let result=call(driver,"runQuery",vec![json!(sql),json!({"limit":1,"keepCursor":false})])?;
    result["rows"].as_array().filter(|r|r.len()==1).and_then(|r|id(&r[0]["cells"][0])).ok_or_else(||infra("ROWS_SHAPE_INVALID"))
}
fn marker_still_locked(ctx:&Context,table:&str,marker:u8)->Check<()>{
    let mut probe=raw_connection(ctx,false)?;
    probe.query_drop("START TRANSACTION").map_err(|_|infra("LOCK_PROBE_START_FAILED"))?;
    let locked=probe.query::<Row,_>(format!("SELECT id,v FROM {table} WHERE id={marker} FOR UPDATE NOWAIT"));
    let restored=probe.query_drop("ROLLBACK").is_ok();
    require(restored,"LOCK_PROBE_ROLLBACK_FAILED")?;
    require(matches!(locked,Err(mysql::Error::MySqlError(ref e))if e.code==3572),"PRIOR_MARKER_LOCK_NOT_OBSERVED")
}
fn commit_visibility(ctx:&Context,case_id:&'static str)->Report{
    let mut checks=BTreeMap::new();
    let mut driver=match native_driver(ctx){Ok(d)=>d,Err(e)=>return report(case_id,Err(e),true,checks)};
    let table=contract_table(ctx,"commit");let mut seeded=false;let mut committed=false;
    let result=(||{
        gui_baseline(ctx)?;seed_contract(&mut *driver,&table)?;seeded=true;
        contract_observer(ctx,&table,0,0)?;
        call(&mut *driver,"executeStatement",vec![json!(format!("UPDATE {table} SET v=7 WHERE id=1")),json!({})])?;
        let pending=call(&mut *driver,"transactionState",vec![])?;
        contract(pending["active"]==true&&pending["pendingAffected"]==1,"COMMIT_VISIBILITY_STATE_CONTRACT")?;
        contract(own_number(&mut *driver,format!("SELECT v FROM {table} WHERE id=1"))?==7,"COMMIT_VISIBILITY_STATE_CONTRACT")?;
        contract_observer(ctx,&table,0,0)?;checks.insert("uncommittedWriteInvisibleToFreshObserver",true);
        let state=call(&mut *driver,"commitTransaction",vec![])?;
        contract(state["active"]==false&&state["pendingAffected"]==0,"COMMIT_VISIBILITY_STATE_CONTRACT")?;committed=true;
        contract_observer(ctx,&table,7,0)?;checks.insert("committedWriteVisibleToFreshObserver",true);
        checks.insert("commitClearsPendingState",true);Ok(())
    })();
    let mut cleanup=finish_driver(&mut *driver);
    if seeded{cleanup&=contract_observer(ctx,&table,if committed{7}else{0},0).is_ok();}
    let baseline=gui_baseline(ctx).is_ok();checks.insert("guiBaselinePreserved",baseline);cleanup&=baseline;
    checks.insert("committedEvidenceRetained",committed&&cleanup);
    report(case_id,result,cleanup,checks)
}
fn statement_error_contract(ctx:&Context,case_id:&'static str,timeout:bool)->Report{
    let mut checks=BTreeMap::new();let table=contract_table(ctx,if timeout{"timeout"}else{"duplicate"});
    let mut driver=match native_driver(ctx){Ok(d)=>d,Err(e)=>return report(case_id,Err(e),true,checks)};
    let mut blocker:Option<Conn>=None;let mut seeded=false;
    let result=(||{
        gui_baseline(ctx)?;
        if timeout{
            // Fail before any held-row attempt unless the runner's bounded global guard is effective.
            require(own_number(&mut *driver,"SELECT @@session.innodb_lock_wait_timeout".into())?==1,"LOCK_TIMEOUT_INHERITANCE_REQUIRED")?;
            require(own_number(&mut *driver,"SELECT @@global.innodb_rollback_on_timeout".into())?==0,"ROLLBACK_ON_TIMEOUT_OFF_REQUIRED")?;
            checks.insert("oneSecondTimeoutInherited",true);checks.insert("rollbackOnTimeoutOff",true);
        }
        seed_contract(&mut *driver,&table)?;seeded=true;contract_observer(ctx,&table,0,0)?;
        if timeout{
            blocker=Some(raw_connection(ctx,false)?);
            let holder=blocker.as_mut().unwrap();holder.query_drop("START TRANSACTION").map_err(|_|infra("TIMEOUT_BLOCKER_FAILED"))?;
            holder.query_drop(format!("UPDATE {table} SET v=9 WHERE id=1")).map_err(|_|infra("TIMEOUT_BLOCKER_FAILED"))?;
        }
        call(&mut *driver,"executeStatement",vec![json!(format!("UPDATE {table} SET v=7 WHERE id=2")),json!({})])?;
        let before=call(&mut *driver,"transactionState",vec![])?;
        require(before["active"]==true&&before["pendingAffected"]==1,"TRANSACTION_STATE_SHAPE_INVALID")?;
        let sql=if timeout{format!("UPDATE {table} SET v=99 WHERE id=1")}else{format!("INSERT INTO {table}(id,v) VALUES(3,99),(1,99)")};
        let failure=driver.call("executeStatement",vec![json!(sql),json!({})]);
        let expected=if timeout{"SQLSTATE HY000, code 1205"}else{"SQLSTATE 23000, code 1062"};
        require(failure.as_ref().err().is_some_and(|e|e.code=="driver-error"&&e.message.contains(expected)),if timeout{"ACTUAL_LOCK_TIMEOUT_NOT_OBSERVED"}else{"ACTUAL_DUPLICATE_NOT_OBSERVED"})?;
        checks.insert(if timeout{"actualLockWait1205Observed"}else{"actualDuplicate1062Observed"},true);
        checks.insert("originalStatementErrorCodePreserved",true);
        let after=call(&mut *driver,"transactionState",vec![])?;
        contract(after==before,"STATEMENT_ERROR_TRANSACTION_STATE_CONTRACT")?;
        contract(own_number(&mut *driver,format!("SELECT v FROM {table} WHERE id=2"))?==7,"PRIOR_TRANSACTION_WRITE_LOST")?;
        if !timeout{
            contract(own_number(&mut *driver,format!("SELECT COUNT(*) FROM {table} WHERE id=3"))?==0,"FAILED_STATEMENT_NOT_ROLLED_BACK")?;
            checks.insert("failedStatementRowsRolledBack",true);
        }
        marker_still_locked(ctx,&table,2)?;checks.insert("priorMarkerLockPreserved",true);
        contract_observer(ctx,&table,0,0)?;checks.insert("uncommittedWriteInvisibleToFreshObserver",true);
        checks.insert("priorTransactionWritePreserved",true);checks.insert("pendingStatePreservedAfterStatementError",true);Ok(())
    })();
    // Every path rolls back both participants before reporting, including unexpected error/timeout codes.
    let mut cleanup=finish_driver(&mut *driver);
    if let Some(holder)=blocker.as_mut(){cleanup&=holder.query_drop("ROLLBACK").is_ok();}
    if seeded{cleanup&=contract_observer(ctx,&table,0,0).is_ok();if cleanup{cleanup&=marker_unlocked(ctx,&table,2).is_ok();}}
    let baseline=gui_baseline(ctx).is_ok();checks.insert("guiBaselinePreserved",baseline);cleanup&=baseline;
    checks.insert("allContractWritesRolledBack",cleanup);
    report(case_id,result,cleanup,checks)
}
fn explain_reference_cell(value:&mysql::Value,column:&mysql::Column)->Check<Value>{
    use mysql::consts::ColumnType::*;
    match value{
        mysql::Value::NULL=>Ok(json!({"kind":"null"})),
        mysql::Value::Bytes(bytes)=>{
            let text=std::str::from_utf8(bytes).map_err(|_|infra("EXPLAIN_REFERENCE_VALUE_INVALID"))?;
            match column.column_type(){
                MYSQL_TYPE_TINY|MYSQL_TYPE_SHORT|MYSQL_TYPE_LONG|MYSQL_TYPE_INT24|MYSQL_TYPE_LONGLONG=>{
                    if let Ok(v)=text.parse::<i64>(){if v.unsigned_abs()<=9_007_199_254_740_991{return Ok(json!({"kind":"number","value":v}));}}
                    else if let Ok(v)=text.parse::<u64>(){if v<=9_007_199_254_740_991{return Ok(json!({"kind":"number","value":v}));}}
                    Ok(json!({"kind":"text","text":text}))
                },
                MYSQL_TYPE_FLOAT=>{let v=text.parse::<f32>().map_err(|_|infra("EXPLAIN_REFERENCE_VALUE_INVALID"))?;Ok(json!({"kind":"number","value":v as f64}))},
                MYSQL_TYPE_DOUBLE=>{let v=text.parse::<f64>().map_err(|_|infra("EXPLAIN_REFERENCE_VALUE_INVALID"))?;Ok(json!({"kind":"number","value":v}))},
                _=>Ok(json!({"kind":"text","text":text}))
            }
        },
        _=>Err(infra("EXPLAIN_REFERENCE_VALUE_INVALID"))
    }
}
fn explain_reference(ctx:&Context,sql:&str)->Check<Value>{
    use mysql::consts::ColumnType::*;
    let reference=observer_rows(ctx,&format!("EXPLAIN {sql}"))?;
    require(!reference.is_empty(),"SERVER_REFERENCE_EMPTY")?;
    let metadata=reference[0].columns_ref();
    let columns:Vec<Value>=metadata.iter().map(|c|json!({"name":c.name_str(),"type":match c.column_type(){
        MYSQL_TYPE_TINY|MYSQL_TYPE_SHORT|MYSQL_TYPE_LONG|MYSQL_TYPE_INT24=>"integer",
        MYSQL_TYPE_FLOAT|MYSQL_TYPE_DOUBLE=>"real",
        MYSQL_TYPE_DECIMAL|MYSQL_TYPE_NEWDECIMAL|MYSQL_TYPE_LONGLONG|MYSQL_TYPE_JSON=>"text",
        _=>if c.character_set()==63{"blob"}else{"text"}
    }})).collect();
    let rows:Check<Vec<Value>>=reference.iter().enumerate().map(|(index,row)|{
        let cells:Check<Vec<_>>=(0..row.len()).map(|i|explain_reference_cell(row.as_ref(i).ok_or_else(||infra("EXPLAIN_REFERENCE_VALUE_INVALID"))?,&metadata[i])).collect();
        Ok(json!({"index":index,"cells":cells?}))
    }).collect();
    Ok(json!({"columns":columns,"rows":rows?}))
}
fn explain_complete_result(value:&Value,reference:&Value,executed_sql:&str)->Check<()>{
    let object=value.as_object().ok_or_else(||gap("EXPLAIN_API_RESULT_CONTRACT"))?;
    let mut keys:Vec<&str>=object.keys().map(String::as_str).collect();keys.sort_unstable();
    contract(keys==vec!["columns","dialectId","executedSql","format","rows"]
        &&value["dialectId"]=="mysql"&&value["format"]=="tabular"&&value["executedSql"]==executed_sql,
        "EXPLAIN_API_RESULT_CONTRACT")?;
    contract(value["columns"]==reference["columns"]&&value["rows"]==reference["rows"],"EXPLAIN_API_REFERENCE_CONTRACT")?;
    let columns=value["columns"].as_array().ok_or_else(||gap("EXPLAIN_API_RESULT_CONTRACT"))?;
    let rows=value["rows"].as_array().ok_or_else(||gap("EXPLAIN_API_RESULT_CONTRACT"))?;
    for (index,row) in rows.iter().enumerate(){
        contract(row["index"]==index,"EXPLAIN_API_RESULT_CONTRACT")?;
        let cells=row["cells"].as_array().ok_or_else(||gap("EXPLAIN_API_RESULT_CONTRACT"))?;
        contract(cells.len()==columns.len(),"EXPLAIN_API_RESULT_CONTRACT")?;
        for cell in cells{contract(cell["truncated"]!=true,"EXPLAIN_API_COMPLETE_VALUE_CONTRACT")?;}
    }
    Ok(())
}
fn explain_api(ctx:&Context,case_id:&'static str)->Report{
    let mut checks=BTreeMap::new();
    let mut driver=match native_driver(ctx){Ok(d)=>d,Err(e)=>return report(case_id,Err(e),true,checks)};
    let result=(||{
        gui_baseline(ctx)?;
        let sql=format!("SELECT id,body FROM `{}`.`items_805` WHERE id=1",ctx.database);
        let reference=explain_reference(ctx,&sql)?;
        checks.insert("independentExplainReferenceRows",true);
        let response=driver.call("explain",vec![json!(sql)]);
        let plan=match response{
            Ok(plan)=>plan,
            Err(e)if e.code=="unsupported"=>{checks.insert("explainApiUnsupported",true);return Err(gap("EXPLAIN_API_UNSUPPORTED"));},
            Err(_)=>return Err(infra("EXPLAIN_API_CALL_FAILED"))
        };
        explain_complete_result(&plan,&reference,&format!("EXPLAIN {sql}"))?;
        checks.insert("explainFiveFieldContract",true);checks.insert("explainCellsMatchIndependentReference",true);
        checks.insert("explainHasNoCursorOrPageFields",true);
        // Exceed the query default page without creating any SQL object or executing its SELECT body.
        let large_sql=(0..205).map(|i|format!("SELECT id,body FROM `{}`.`items_805` WHERE id={}",ctx.database,i+1)).collect::<Vec<_>>().join(" UNION ALL ");
        let large_reference=explain_reference(ctx,&large_sql)?;
        require(large_reference["rows"].as_array().is_some_and(|r|r.len()>200),"EXPLAIN_REFERENCE_TOO_SMALL")?;
        let large=call(&mut *driver,"explain",vec![json!(large_sql)])?;
        explain_complete_result(&large,&large_reference,&format!("EXPLAIN {large_sql}"))?;
        checks.insert("explainAllPlanRowsReturned",true);
        let counter="@dbstudio_native_explain_counter";
        require(own_number(&mut *driver,format!("SELECT {counter}:=0 AS counter"))?==0,"EXPLAIN_COUNTER_SETUP_FAILED")?;
        let dangerous=[
            format!("EXPLAIN ANALYZE SELECT ({counter}:={counter}+1)"),
            format!("ANALYZE SELECT ({counter}:={counter}+1)"),
            "CALL native_acceptance_unsupported_procedure()".to_owned(),
            format!("SELECT ({counter}:={counter}+1); SELECT 1"),
            "EXPLAIN FORMAT=JSON SELECT 1".to_owned(),
            "WITH x AS (SELECT 1) SELECT * FROM x".to_owned(),
            "SELECT id FROM items_805 WHERE id=?".to_owned(),
        ];
        for rejected in dangerous{
            let response=driver.call("explain",vec![json!(rejected)]);
            contract(response.as_ref().err().is_some_and(|e|e.code=="unsupported"||e.code=="invalid-argument"),"EXPLAIN_API_INPUT_POLICY_CONTRACT")?;
            contract(own_number(&mut *driver,format!("SELECT {counter} AS counter"))?==0,"EXPLAIN_API_INPUT_EXECUTED")?;
        }
        for options in [json!({}),json!({"parameters":[{"name":"?1","value":1}]})]{
            let response=driver.call("explain",vec![json!(sql),options]);
            contract(response.as_ref().err().is_some_and(|e|e.code=="invalid-argument"||e.code=="unsupported"),"EXPLAIN_API_ARGUMENT_CONTRACT")?;
        }
        checks.insert("explainDangerousInputsRejectedWithoutExecution",true);
        let invalid=format!("SELECT native_explain_missing_column FROM `{}`.`items_805`",ctx.database);
        let error=driver.call("explain",vec![json!(invalid)]);
        contract(error.as_ref().err().is_some_and(|e|e.code=="driver-error"&&e.message.contains("SQLSTATE 42S22, code 1054")),"EXPLAIN_API_ORIGINAL_ERROR_CONTRACT")?;
        checks.insert("explainOriginalServerErrorPreserved",true);
        let state=call(&mut *driver,"transactionState",vec![])?;
        contract(state["active"]==false&&state["pendingAffected"]==0,"EXPLAIN_API_NONTRANSACTIONAL_CONTRACT")?;
        checks.insert("explainRemainsNontransactional",true);
        // Dedicated API calls must not allocate raw management cursors: all 16 slots remain available.
        let mut cursors=Vec::new();let mut capacity=true;
        for _ in 0..16{
            match driver.call("runQuery",vec![json!("SHOW TABLES LIKE 'items_805'"),json!({"limit":1})]){
                Ok(page)=>match page["cursorId"].as_str(){Some(id)=>cursors.push(id.to_owned()),None=>{capacity=false;break;}},
                Err(_)=>{capacity=false;break;}
            }
        }
        for cursor in cursors{capacity&=driver.call("closeCursor",vec![json!(cursor)]).is_ok();}
        contract(capacity,"EXPLAIN_API_CURSOR_LEAK_CONTRACT")?;
        checks.insert("explainAllocatesNoHiddenCursor",true);Ok(())
    })();
    let mut cleanup=finish_driver(&mut *driver);
    let baseline=gui_baseline(ctx).is_ok();checks.insert("guiBaselinePreserved",baseline);cleanup&=baseline;
    report(case_id,result,cleanup,checks)
}
fn run(case_id: &'static str, body: impl FnOnce(&Context, &'static str) -> Report) {
    let ctx = context().unwrap_or_else(|_|panic!("MYSQL_ACCEPTANCE_PRIVATE_INPUT_FAILED"));
    let report = std::panic::catch_unwind(std::panic::AssertUnwindSafe(||body(&ctx,case_id)))
        .unwrap_or_else(|_|report(case_id,Err(infra("UNEXPECTED_TEST_PANIC")),false,BTreeMap::new()));
    let path = ctx.evidence_root.join(format!("{case_id}.json"));
    let encoded = serde_json::to_vec(&report).unwrap_or_else(|_|panic!("MYSQL_ACCEPTANCE_REPORT_FAILED"));
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)
        .unwrap_or_else(|_|panic!("MYSQL_ACCEPTANCE_REPORT_FAILED"));
    file.write_all(&encoded).and_then(|_|file.sync_all()).unwrap_or_else(|_|panic!("MYSQL_ACCEPTANCE_REPORT_FAILED"));
    assert!(report.outcome == "PASS", "MYSQL_ACCEPTANCE_CASE_NOT_PASSED");
}
#[test]
#[ignore = "dedicated retain-only MySQL fixture; use mysql-driver-acceptance runner"]
fn mysql_select_duplicate_columns_and_pages() { run("mysql_select_duplicate_columns_and_pages",select_pages); }
#[test]
#[ignore = "dedicated retain-only MySQL fixture; use mysql-driver-acceptance runner"]
fn mysql_show_tables_returns_rows() { run("mysql_show_tables_returns_rows",|c,id|management(c,id,"tables")); }
#[test]
#[ignore = "dedicated retain-only MySQL fixture; use mysql-driver-acceptance runner"]
fn mysql_show_create_table_returns_rows() { run("mysql_show_create_table_returns_rows",|c,id|management(c,id,"create")); }
#[test]
#[ignore = "dedicated retain-only MySQL fixture; use mysql-driver-acceptance runner"]
fn mysql_describe_returns_rows() { run("mysql_describe_returns_rows",|c,id|management(c,id,"describe")); }
#[test]
#[ignore = "dedicated retain-only MySQL fixture; use mysql-driver-acceptance runner"]
fn mysql_explain_returns_rows() { run("mysql_explain_returns_rows",|c,id|management(c,id,"explain")); }
#[test]
#[ignore = "dedicated retain-only MySQL fixture; use mysql-driver-acceptance runner"]
fn mysql_deadlock_reconciles_transaction_state() { run("mysql_deadlock_reconciles_transaction_state",deadlock); }
#[test]
#[ignore = "dedicated retain-only MySQL fixture; use mysql-driver-acceptance runner"]
fn mysql_management_snapshot_pages_full_values_and_close() { run("mysql_management_snapshot_pages_full_values_and_close",snapshot_management); }
#[test]
#[ignore = "dedicated retain-only MySQL fixture; use mysql-driver-acceptance runner"]
fn mysql_management_explain_bound_results_and_policy() { run("mysql_management_explain_bound_results_and_policy",explain_policy); }
#[test]
#[ignore = "dedicated retain-only MySQL fixture; use mysql-driver-acceptance runner"]
fn mysql_commit_visibility_to_fresh_observer() { run("mysql_commit_visibility_to_fresh_observer",commit_visibility); }
#[test]
#[ignore = "dedicated retain-only MySQL fixture; use mysql-driver-acceptance runner"]
fn mysql_duplicate_key_preserves_prior_transaction() { run("mysql_duplicate_key_preserves_prior_transaction",|ctx,id|statement_error_contract(ctx,id,false)); }
#[test]
#[ignore = "dedicated retain-only MySQL fixture; use mysql-driver-acceptance runner"]
fn mysql_lock_wait_timeout_preserves_prior_transaction() { run("mysql_lock_wait_timeout_preserves_prior_transaction",|ctx,id|statement_error_contract(ctx,id,true)); }
#[test]
#[ignore = "dedicated retain-only MySQL fixture; use mysql-driver-acceptance runner"]
fn mysql_explain_api_returns_complete_plan() { run("mysql_explain_api_returns_complete_plan",explain_api); }
