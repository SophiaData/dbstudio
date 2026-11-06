//! Actual native SQLite fixtures. No Node, network database or generated SQL execution.
use dbstudio_core::{AppError, Application, SecretStore};
use dbstudio_protocol::SecretMap;
use serde_json::{json, Value};
use std::{fs::OpenOptions, path::PathBuf, sync::Arc};
use uuid::Uuid;

struct NoSecrets;
impl SecretStore for NoSecrets {
    fn get(&self, _: &str) -> Result<Option<SecretMap>, AppError> { Ok(None) }
    fn set(&self, _: &str, _: &SecretMap) -> Result<(), AppError> { Ok(()) }
    fn remove(&self, _: &str) -> Result<(), AppError> { Ok(()) }
}
struct Fixture {
    app: Application,
    source: String,
    target: String,
    _directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("dbstudio-native-compare-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let app = Application::open(directory.join("app"), Arc::new(NoSecrets)).unwrap();
        let connect = |label: &str| {
            let file = directory.join(format!("{label}.sqlite"));
            // Only a new, unique test fixture is created. No implicit SQLite file creation.
            OpenOptions::new().create_new(true).write(true).open(&file).unwrap();
            let summary = app.call("addConnection", vec![json!({"dialectId":"sqlite", "name":label, "options":{"file":file}})]).unwrap();
            assert_eq!(summary["connected"], true, "fixture must use the actual native SQLite driver");
            summary["id"].as_str().unwrap().to_owned()
        };
        let source = connect("source");
        let target = connect("target");
        Self { app, source, target, _directory: directory }
    }
    fn execute(&self, connection: &str, sql: &str) {
        self.app.call("executeStatement", vec![json!(format!("connection:{connection}")), json!(sql), json!({})]).unwrap();
    }
    fn commit(&self, connection: &str) {
        self.app.call("commitTransaction", vec![json!(format!("connection:{connection}"))]).unwrap();
    }
    fn compare(&self, source: &str, target: &str, options: Value) -> Result<Value, AppError> {
        let mut request = json!({
            "sourceTableNodeId": format!("connection:{}|table:{source}", self.source),
            "targetTableNodeId": format!("connection:{}|table:{target}", self.target),
        });
        for (key, value) in options.as_object().unwrap() { request[key] = value.clone(); }
        self.app.call("compareTableData", vec![request])
    }
    fn query(&self, connection: &str, sql: &str) -> Value {
        self.app.call("runQuery", vec![json!(format!("connection:{connection}")), json!(sql), json!({"keepCursor":false})]).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.app.close();
        // Fixtures are retained; this repository explicitly forbids file deletion.
    }
}
fn quoted_text(value: &str) -> String { format!("'{}'", value.replace('\'', "''")) }

#[test]
fn native_snapshots_capture_real_table_constraints_views_and_stable_order() {
    let f = Fixture::new();
    f.execute(&f.source, "CREATE TABLE z_table(id INTEGER PRIMARY KEY, note TEXT UNIQUE)");
    f.execute(&f.source, "CREATE TABLE a_table(id INTEGER PRIMARY KEY, note TEXT NOT NULL DEFAULT 'original')");
    f.execute(&f.source, "CREATE VIEW selected_notes AS SELECT note FROM a_table");
    f.execute(&f.target, "CREATE TABLE a_table(id INTEGER PRIMARY KEY, note INTEGER)");
    let source = f.app.call("captureSchemaSnapshot", vec![json!(f.source), Value::Null]).unwrap();
    let target = f.app.call("captureSchemaSnapshot", vec![json!(f.target)]).unwrap();
    assert_eq!(source["source"], json!({"connectionId":f.source,"schema":null}));
    assert_eq!(source["tables"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect::<Vec<_>>(), vec!["a_table", "z_table"]);
    assert_eq!(source["views"][0]["name"], "selected_notes");
    assert!(source["views"][0]["definition"].as_str().unwrap().contains("SELECT note"));
    assert_eq!(source["routines"], json!([]));
    let source_note = source["tables"][0]["columns"].as_array().unwrap().iter().find(|c| c["name"] == "note").unwrap();
    let target_note = target["tables"][0]["columns"].as_array().unwrap().iter().find(|c| c["name"] == "note").unwrap();
    assert_ne!(source_note["typeName"], target_note["typeName"]);
    assert_eq!(source_note["nullable"], false);
    assert_eq!(source, f.app.call("captureSchemaSnapshot", vec![json!(f.source), Value::Null]).unwrap());
    assert!(f.app.call("captureSchemaSnapshot", vec![json!(f.source), json!("not-main")]).is_err());
}

#[test]
fn native_data_diff_preserves_null_large_integer_and_actual_target_name_without_writes() {
    let f = Fixture::new();
    f.execute(&f.source, "CREATE TABLE source_items(id INTEGER PRIMARY KEY, note TEXT, payload BLOB)");
    f.execute(&f.target, "CREATE TABLE \"target\"\"items\"(id INTEGER PRIMARY KEY, note TEXT, payload BLOB, extra TEXT DEFAULT 'keep')");
    f.execute(&f.source, "INSERT INTO source_items VALUES (1,NULL,X'00'), (2,'source-only',X'01'), (9007199254740992,'source large',X'02'), (9007199254740993,'same',X'03'), (9223372036854775807,'same max',X'04')");
    f.execute(&f.target, "INSERT INTO \"target\"\"items\"(id,note,payload) VALUES (1,'',X'ff'), (3,'target-only',X'ff'), (9007199254740992,'target large',X'ff'), (9007199254740993,'same',X'ff'), (9223372036854775807,'same max',X'ff')");
    f.commit(&f.source);
    f.commit(&f.target);
    let before_source = f.query(&f.source, "SELECT id,note,hex(payload) FROM source_items ORDER BY id")["rows"].clone();
    let before_target = f.query(&f.target, "SELECT id,note,hex(payload),extra FROM \"target\"\"items\" ORDER BY id")["rows"].clone();
    let result = f.compare("source_items", "target\"items", json!({})).unwrap();
    assert_eq!(result["keyColumns"], json!(["id"]));
    assert_eq!(result["plan"]["insertCount"], 1);
    assert_eq!(result["plan"]["updateCount"], 2);
    assert_eq!(result["plan"]["deleteCount"], 1);
    assert_eq!(result["plan"]["destructive"], true);
    let rows = result["rows"].as_array().unwrap();
    assert_eq!(rows.iter().find(|r| r["key"]["id"] == "9007199254740992").unwrap()["status"], "different");
    assert_eq!(rows.iter().find(|r| r["key"]["id"] == "9007199254740993").unwrap()["status"], "same");
    assert_eq!(rows.iter().find(|r| r["key"]["id"] == "9223372036854775807").unwrap()["status"], "same");
    let null_change = &rows.iter().find(|r| r["key"]["id"] == 1).unwrap()["valueChanges"][0];
    assert_eq!(null_change["source"], "NULL");
    assert_eq!(null_change["target"], "");
    let sql = result["plan"]["statements"].as_array().unwrap();
    assert!(sql.iter().all(|s| s.as_str().unwrap().contains("\"target\"\"items\"")));
    assert!(sql.iter().any(|s| s.as_str().unwrap().contains("SET \"note\" = NULL WHERE \"id\" = 1")));
    assert!(sql.iter().any(|s| s.as_str().unwrap().contains("9007199254740992")));
    let warnings = result["plan"]["warnings"].to_string();
    assert!(warnings.contains("二进制列") && warnings.contains("payload") && warnings.contains("extra"));
    // The generated INSERT/UPDATE/DELETE plan has never been executed.
    assert_eq!(before_source, f.query(&f.source, "SELECT id,note,hex(payload) FROM source_items ORDER BY id")["rows"]);
    assert_eq!(before_target, f.query(&f.target, "SELECT id,note,hex(payload),extra FROM \"target\"\"items\" ORDER BY id")["rows"]);
}

#[test]
fn long_text_compares_full_value_not_identical_preview_and_only_summarizes_ui_changes() {
    let f = Fixture::new();
    for id in [&f.source, &f.target] { f.execute(id, "CREATE TABLE texts(id INTEGER PRIMARY KEY, body TEXT)"); }
    let prefix = "水😀".repeat(1200);
    let source = format!("{prefix}left's\\tail");
    let target = format!("{prefix}right");
    f.execute(&f.source, &format!("INSERT INTO texts VALUES (1,{})", quoted_text(&source)));
    f.execute(&f.target, &format!("INSERT INTO texts VALUES (1,{})", quoted_text(&target)));
    f.commit(&f.source);
    f.commit(&f.target);
    let result = f.compare("texts", "texts", json!({})).unwrap();
    assert_eq!(result["plan"]["updateCount"], 1);
    assert_eq!(result["rows"][0]["columns"], json!(["body"]));
    let change = &result["rows"][0]["valueChanges"][0];
    assert!(change["source"].as_str().unwrap().contains("fnv1a:"));
    assert!(change["source"].as_str().unwrap().len() < 100);
    assert_ne!(change["source"], change["target"]);
    assert!(result["plan"]["statements"][0].as_str().unwrap().contains("left''s\\tail"));
    assert_eq!(f.query(&f.target, "SELECT length(body) FROM texts")["rows"][0]["cells"][0]["value"], target.chars().count());
}

#[test]
fn max_rows_is_a_hard_limit_and_rejected_comparisons_release_their_cursors() {
    let f = Fixture::new();
    for id in [&f.source, &f.target] { f.execute(id, "CREATE TABLE limited(id INTEGER PRIMARY KEY, body TEXT)"); }
    f.execute(&f.source, "INSERT INTO limited VALUES(1,'a'),(2,'b'),(3,'c')");
    f.commit(&f.source);
    for _ in 0..80 {
        let error = f.compare("limited", "limited", json!({"maxRows":1})).unwrap_err();
        assert_eq!(error.code, "resource-limit");
    }
    let result = f.compare("limited", "limited", json!({"maxRows":3})).unwrap();
    assert_eq!(result["plan"]["insertCount"], 3);
    assert!(f.compare("limited", "limited", json!({"maxRows":0})).is_err());
    assert!(f.compare("limited", "limited", json!({"maxRows":500001})).is_err());
    assert!(f.compare("limited", "limited", json!({"maxRows":1.5})).is_err());
}

#[test]
fn paginated_native_compare_does_not_stop_at_the_first_page_or_compare_row_positions() {
    let f = Fixture::new();
    for id in [&f.source, &f.target] { f.execute(id, "CREATE TABLE pages(id INTEGER PRIMARY KEY, body TEXT)"); }
    let values = (1..=301).map(|i| format!("({i},'same')")).collect::<Vec<_>>().join(",");
    f.execute(&f.source, &format!("INSERT INTO pages VALUES {values}"));
    f.execute(&f.target, &format!("INSERT INTO pages VALUES {values}"));
    f.execute(&f.source, "UPDATE pages SET body='last page difference' WHERE id=301");
    f.commit(&f.source);
    f.commit(&f.target);
    let result = f.compare("pages", "pages", json!({"maxRows":301})).unwrap();
    assert_eq!(result["rows"].as_array().unwrap().len(), 301);
    assert_eq!(result["plan"]["updateCount"], 1);
    assert_eq!(result["rows"][300]["key"]["id"], 301);
    assert_eq!(result["rows"][300]["status"], "different");
    assert!(f.compare("pages", "pages", json!({"maxRows":300})).is_err());
}

#[test]
fn missing_duplicate_and_binary_keys_fail_without_generating_a_sync_plan() {
    let f = Fixture::new();
    for id in [&f.source, &f.target] { f.execute(id, "CREATE TABLE no_key(code TEXT, body TEXT, bin BLOB)"); }
    f.execute(&f.source, "INSERT INTO no_key VALUES('repeat','one',X'01'),('repeat','two',X'02')");
    f.commit(&f.source);
    assert_eq!(f.compare("no_key", "no_key", json!({})).unwrap_err().code, "invalid-argument");
    assert_eq!(f.compare("no_key", "no_key", json!({"keyColumns":["code"]})).unwrap_err().code, "invalid-argument");
    assert_eq!(f.compare("no_key", "no_key", json!({"keyColumns":["bin"]})).unwrap_err().code, "unsupported");
    assert!(f.compare("no_key", "no_key", json!({"keyColumns":["missing"]})).is_err());
    assert!(f.compare("no_key", "no_key", json!({"keyColumns":["code","code"]})).is_err());
    assert_eq!(f.query(&f.source, "SELECT COUNT(*) FROM no_key")["rows"][0]["cells"][0]["value"], 2);
}

#[test]
fn explicit_composite_keys_include_null_and_compare_values_by_name() {
    let f = Fixture::new();
    f.execute(&f.source, "CREATE TABLE composite(a TEXT, b INTEGER, body TEXT)");
    f.execute(&f.target, "CREATE TABLE composite(body TEXT, b INTEGER, a TEXT)");
    f.execute(&f.source, "INSERT INTO composite VALUES(NULL,1,'left'),('x',2,'same')");
    f.execute(&f.target, "INSERT INTO composite VALUES('right',1,NULL),('same',2,'x')");
    f.commit(&f.source);
    f.commit(&f.target);
    let result = f.compare("composite", "composite", json!({"keyColumns":["a","b"]})).unwrap();
    assert_eq!(result["plan"]["updateCount"], 1);
    assert_eq!(result["plan"]["insertCount"], 0);
    assert_eq!(result["plan"]["deleteCount"], 0);
    assert_eq!(result["rows"][0]["key"], json!({"a":null,"b":1}));
    assert!(result["plan"]["statements"][0].as_str().unwrap().contains("\"a\" IS NULL AND \"b\" = 1"));
}

#[test]
fn sqlite_integer_and_identical_text_are_different_values_and_generate_typed_literals() {
    let f = Fixture::new();
    for id in [&f.source, &f.target] {
        // No declared affinity: SQLite must preserve both storage classes as inserted.
        f.execute(id, "CREATE TABLE typed_values(id INTEGER PRIMARY KEY, value)");
    }
    f.execute(&f.source, "INSERT INTO typed_values VALUES (1,9007199254740993),(2,'9007199254740993')");
    f.execute(&f.target, "INSERT INTO typed_values VALUES (1,'9007199254740993'),(2,9007199254740993)");
    f.commit(&f.source);
    f.commit(&f.target);
    let before = f.query(&f.target, "SELECT id,typeof(value),CAST(value AS TEXT) FROM typed_values ORDER BY id")["rows"].clone();
    let result = f.compare("typed_values", "typed_values", json!({})).unwrap();
    assert_eq!(result["plan"]["updateCount"], 2);
    assert!(result["rows"].as_array().unwrap().iter().all(|r| r["status"] == "different"));
    let sql = result["plan"]["statements"].as_array().unwrap();
    assert!(sql.iter().any(|s| s == "UPDATE \"typed_values\" SET \"value\" = 9007199254740993 WHERE \"id\" = 1"));
    assert!(sql.iter().any(|s| s == "UPDATE \"typed_values\" SET \"value\" = '9007199254740993' WHERE \"id\" = 2"));
    assert_eq!(before, f.query(&f.target, "SELECT id,typeof(value),CAST(value AS TEXT) FROM typed_values ORDER BY id")["rows"]);
}

#[test]
fn sqlite_large_integer_and_text_keys_remain_distinct_without_false_duplicates() {
    let f = Fixture::new();
    for id in [&f.source, &f.target] {
        f.execute(id, "CREATE TABLE typed_keys(key, body TEXT)");
    }
    f.execute(&f.source, "INSERT INTO typed_keys VALUES (9007199254740993,'integer source'),('9007199254740993','text source')");
    f.execute(&f.target, "INSERT INTO typed_keys VALUES (9007199254740993,'integer target'),('9007199254740993','text target')");
    f.commit(&f.source);
    f.commit(&f.target);
    let result = f.compare("typed_keys", "typed_keys", json!({"keyColumns":["key"]})).unwrap();
    assert_eq!(result["rows"].as_array().unwrap().len(), 2);
    assert_eq!(result["plan"]["updateCount"], 2);
    assert_eq!(result["plan"]["insertCount"], 0);
    assert_eq!(result["plan"]["deleteCount"], 0);
    let sql = result["plan"]["statements"].as_array().unwrap();
    assert!(sql.iter().any(|s| s == "UPDATE \"typed_keys\" SET \"body\" = 'integer source' WHERE \"key\" = 9007199254740993"));
    assert!(sql.iter().any(|s| s == "UPDATE \"typed_keys\" SET \"body\" = 'text source' WHERE \"key\" = '9007199254740993'"));
    // Outbound JSON keeps unsafe integers JS-safe, after typed key matching/SQL generation.
    assert!(result["rows"].as_array().unwrap().iter().all(|r| r["key"]["key"] == "9007199254740993"));
}

#[test]
fn closed_sessions_and_non_table_nodes_fail_instead_of_returning_an_empty_diff() {
    let f = Fixture::new();
    for id in [&f.source, &f.target] { f.execute(id, "CREATE TABLE alive(id INTEGER PRIMARY KEY)"); }
    f.app.call("disconnectConnection", vec![json!(f.source)]).unwrap();
    assert!(f.compare("alive", "alive", json!({})).is_err());
    assert!(f.app.call("captureSchemaSnapshot", vec![json!(f.source)]).is_err());
    f.app.call("connectConnection", vec![json!(f.source)]).unwrap();
    let request = json!({"sourceTableNodeId":format!("connection:{}",f.source),"targetTableNodeId":format!("connection:{}|table:alive",f.target)});
    assert!(f.app.call("compareTableData", vec![request]).is_err());
}
