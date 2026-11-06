//! Native SQLite fixtures only. Fixture directories are retained; no user data is read.
use dbstudio_core::{AppError, Application, SecretStore};
use dbstudio_protocol::SecretMap;
use serde_json::{json, Value};
use std::{collections::HashMap, fs::{self, File}, io::Write, path::PathBuf, sync::{Arc, Mutex}};
use uuid::Uuid;

#[derive(Default)]
struct FixtureSecrets(Mutex<HashMap<String, SecretMap>>);
impl SecretStore for FixtureSecrets {
    fn get(&self, key: &str) -> Result<Option<SecretMap>, AppError> { Ok(self.0.lock().unwrap().get(key).cloned()) }
    fn set(&self, key: &str, secret: &SecretMap) -> Result<(), AppError> { self.0.lock().unwrap().insert(key.into(), secret.clone()); Ok(()) }
    fn remove(&self, key: &str) -> Result<(), AppError> { self.0.lock().unwrap().remove(key); Ok(()) }
}
struct Fixture { app: Application, dir: PathBuf, id: String }
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("dbstudio-native-data-tasks-{}", Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let database = dir.join("fixture.sqlite");
        File::options().write(true).create_new(true).open(&database).unwrap();
        let app = Application::open(dir.join("state"), Arc::new(FixtureSecrets::default())).unwrap();
        let connection = app.call("addConnection", vec![json!({"dialectId":"sqlite","name":"native-fixture","options":{"file":database}})]).unwrap();
        assert_eq!(connection["connected"], true);
        Self { id: connection["id"].as_str().unwrap().into(), app, dir }
    }
    fn node(&self) -> String { format!("connection:{}", self.id) }
    fn table(&self, name: &str) -> String { format!("{}|table:{name}", self.node()) }
    fn sql(&self, sql: &str) -> Value { self.app.call("executeStatement", vec![json!(self.node()),json!(sql)]).unwrap() }
    fn query(&self, sql: &str) -> Value { self.app.call("runQuery",vec![json!(self.node()),json!(sql),json!({"keepCursor":false})]).unwrap() }
    fn file(&self, name: &str, content: &str) -> PathBuf {
        let path = self.dir.join(name);
        let mut file = File::options().create_new(true).write(true).open(&path).unwrap();
        file.write_all(content.as_bytes()).unwrap(); path
    }
    fn import(&self, source: &PathBuf, table: &str, columns: &[&str], batch: usize) -> Value {
        let task = self.app.call("startImport",vec![json!({"targetNodeId":self.table(table),"sourcePath":source,
            "delimiter":",","nullText":"","hasHeader":true,"targetColumns":columns,"batchSize":batch})]).unwrap();
        self.app.call("waitImport",vec![task["taskId"].clone()]).unwrap()
    }
    fn export(&self, name: &str, format: &str, source: Value, batch: usize) -> Value {
        let task = self.app.call("startTransfer",vec![json!({"source":source,"format":format,"destinationPath":self.dir.join(name),"options":{"batchSize":batch}})]).unwrap();
        self.app.call("waitTransfer",vec![task["taskId"].clone()]).unwrap()
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = self.app.close(); } }

#[test]
fn preview_preserves_quoted_null_empty_multiline_unicode_and_has_bounded_samples() {
    let fixture = Fixture::new();
    let source = fixture.file("quoted.csv", "\u{feff}name§note\r\n甲§\r\n乙§\"\"\r\n丙§\"a\r\nb\"\r\n丁§\"x§y\"\r\n");
    let result = fixture.app.call("previewImport",vec![json!({"sourcePath":source,"delimiter":"§","nullText":"","hasHeader":true,"sampleRowLimit":3})]).unwrap();
    assert_eq!(result["errorCount"], 0);
    assert_eq!(result["totalRows"], 4);
    assert_eq!(result["sampleRows"].as_array().unwrap().len(), 3);
    assert_eq!(result["truncated"], true);
    assert_eq!(result["sampleRows"][0]["values"][1]["kind"], "null");
    assert_eq!(result["sampleRows"][1]["values"][1]["text"], "");
    assert_eq!(result["sampleRows"][1]["values"][1]["quoted"], true);
    assert_eq!(result["sampleRows"][2]["values"][1]["text"], "a\r\nb");
}

#[test]
fn preview_counts_errors_beyond_the_retained_error_limit_and_rejects_invalid_utf8() {
    let fixture = Fixture::new();
    let mut content = String::from("a,b\n");
    for _ in 0..250 { content.push_str("x\n"); }
    let source = fixture.file("bad-width.csv", &content);
    let result = fixture.app.call("previewImport",vec![json!({"sourcePath":source,"delimiter":",","nullText":"","hasHeader":true,"sampleRowLimit":2})]).unwrap();
    assert_eq!(result["errorCount"], 250);
    assert_eq!(result["errors"].as_array().unwrap().len(), 100);
    assert_eq!(result["sampleRows"].as_array().unwrap().len(), 2);
    assert_eq!(result["totalRows"], 250);
    let path = fixture.dir.join("invalid-utf8.csv");
    File::options().create_new(true).write(true).open(&path).unwrap().write_all(&[b'a', b'\n', 0xFF]).unwrap();
    let result = fixture.app.call("previewImport",vec![json!({"sourcePath":path,"delimiter":",","nullText":"","hasHeader":true})]).unwrap();
    assert_eq!(result["errors"][0]["code"], "invalid-encoding");
}

#[test]
fn csv_import_is_native_atomic_paged_and_supports_generated_and_identity_columns() {
    let fixture = Fixture::new();
    fixture.sql("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, note TEXT, folded TEXT GENERATED ALWAYS AS (upper(label)) STORED)");
    let mut content = String::from("label,note\n");
    for n in 0..257 { content.push_str(&format!("item-{n},{}\n", if n == 0 { "\"\"" } else { "" })); }
    let source = fixture.file("items.csv", &content);
    let result = fixture.import(&source,"items",&["label","note"],17);
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(result["rowsImported"], 257);
    assert_eq!(result["totalRows"], 257);
    assert_eq!(result["batches"], 16);
    assert_eq!(fixture.query("SELECT COUNT(*) FROM items")["rows"][0]["cells"][0]["value"], 257);
    let first = fixture.query("SELECT id,note,folded FROM items ORDER BY id LIMIT 2");
    assert_eq!(first["rows"][0]["cells"][0]["value"], 1);
    assert_eq!(first["rows"][0]["cells"][1]["text"], "");
    assert_eq!(first["rows"][1]["cells"][1]["kind"], "null");
    assert_eq!(first["rows"][0]["cells"][2]["text"], "ITEM-0");
}

#[test]
fn later_batch_failure_rolls_back_all_prior_batches_without_touching_existing_rows() {
    let fixture = Fixture::new();
    fixture.sql("CREATE TABLE unique_items (name TEXT NOT NULL UNIQUE)");
    fixture.sql("INSERT INTO unique_items VALUES ('existing')");
    fixture.app.call("commitTransaction",vec![json!(fixture.node())]).unwrap();
    let source = fixture.file("duplicate.csv", "name\na\nb\nc\na\n");
    let result = fixture.import(&source,"unique_items",&["name"],2);
    assert_eq!(result["status"], "failed");
    assert_eq!(result["rowsImported"], 0);
    assert_eq!(fixture.query("SELECT COUNT(*) FROM unique_items")["rows"][0]["cells"][0]["value"], 1);
    assert_eq!(fixture.query("SELECT name FROM unique_items")["rows"][0]["cells"][0]["text"], "existing");
    assert_eq!(fixture.app.call("transactionState",vec![json!(fixture.node())]).unwrap()["active"],false);
}

#[test]
fn import_refuses_required_generated_duplicate_mapping_and_existing_user_transaction() {
    let fixture = Fixture::new();
    fixture.sql("CREATE TABLE guarded (id INTEGER PRIMARY KEY, required TEXT NOT NULL, optional TEXT, derived TEXT GENERATED ALWAYS AS (upper(required)) VIRTUAL)");
    let single = fixture.file("one.csv","field\nx\n");
    for columns in [&["optional"][..], &["derived"][..]] {
        let result = fixture.import(&single,"guarded",columns,1);
        assert_eq!(result["status"], "failed");
        assert_eq!(fixture.query("SELECT COUNT(*) FROM guarded")["rows"][0]["cells"][0]["value"],0);
    }
    let two = fixture.file("two.csv","a,b\nx,y\n");
    assert_eq!(fixture.import(&two,"guarded",&["required","REQUIRED"],1)["status"],"failed");
    fixture.sql("INSERT INTO guarded(required) VALUES ('user-uncommitted')");
    let rejected = fixture.import(&single,"guarded",&["required"],1);
    assert_eq!(rejected["status"], "failed");
    assert_eq!(rejected["code"], "conflict");
    assert_eq!(fixture.app.call("transactionState",vec![json!(fixture.node())]).unwrap()["active"],true);
    assert_eq!(fixture.query("SELECT required FROM guarded")["rows"][0]["cells"][0]["text"],"user-uncommitted");
    fixture.app.call("rollbackTransaction",vec![json!(fixture.node())]).unwrap();
}

#[test]
fn four_export_formats_stream_all_pages_and_report_real_bytes_and_live_paged() {
    let fixture = Fixture::new();
    fixture.sql("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, note TEXT, data BLOB)");
    fixture.sql("INSERT INTO items VALUES (1,'a,b','',X'0001FF'), (2,'quote''s',NULL,X'')");
    fixture.app.call("commitTransaction",vec![json!(fixture.node())]).unwrap();
    let source = json!({"nodeId":fixture.table("items")});
    for (file, format) in [("out.csv","csv"),("out.json","json"),("out.jsonl","jsonl"),("out.sql","sql-insert")] {
        let result = fixture.export(file,format,source.clone(),1);
        assert_eq!(result["status"],"completed","{result}");
        assert_eq!(result["rowsRead"],2);
        assert_eq!(result["consistency"],"live-paged");
        let content = fs::read_to_string(fixture.dir.join(file)).unwrap();
        assert_eq!(result["bytesWritten"].as_u64().unwrap(),content.len() as u64);
        match format {
            "csv" => { assert!(content.contains("\"a,b\"")); assert!(content.contains(",\"\",0x0001FF")); },
            "json" => { let rows: Value = serde_json::from_str(&content).unwrap(); assert_eq!(rows.as_array().unwrap().len(),2); assert_eq!(rows[0]["data"],"0x0001FF"); assert!(rows[1]["note"].is_null()); },
            "jsonl" => { assert_eq!(content.lines().count(),2); for line in content.lines() { serde_json::from_str::<Value>(line).unwrap(); } },
            _ => { assert!(content.contains("INSERT INTO \"main\".\"items\"")); assert!(content.contains("'quote''s'")); assert!(content.contains("X'0001FF'")); },
        }
    }
    // A single short first page must not be dropped when hasMore is false.
    let short = fixture.export("short.json","json",source,200);
    assert_eq!(short["rowsRead"],2);
    let empty = fixture.export("empty.json","json",json!({"connectionId":fixture.id,"sql":"SELECT id FROM items WHERE 0"}),10);
    assert_eq!(empty["status"],"completed");
    assert_eq!(serde_json::from_str::<Value>(&fs::read_to_string(fixture.dir.join("empty.json")).unwrap()).unwrap(),json!([]));
}

#[test]
fn export_rejects_truncated_values_instead_of_silently_writing_previews() {
    let fixture = Fixture::new();
    let result = fixture.export("truncated.json","json",json!({"connectionId":fixture.id,"sql":"SELECT printf('%.*c', 2000, 'x') AS large_text"}),10);
    assert_eq!(result["status"],"failed");
    assert_eq!(result["code"],"truncated-cell");
    assert!(!fixture.dir.join("truncated.json").exists());
    assert!(result["partialPath"].as_str().map(|p| PathBuf::from(p).is_file()).unwrap_or(false));
}

#[test]
fn export_protects_existing_files_database_sidecars_and_source_scope() {
    let fixture = Fixture::new();
    fixture.sql("CREATE TABLE t (id INTEGER)");
    let existing = fixture.file("existing.csv","original user content");
    let source = json!({"nodeId":fixture.table("t")});
    let start = |path: PathBuf, source: Value| fixture.app.call("startTransfer",vec![json!({"source":source,"format":"csv","destinationPath":path})]);
    assert!(start(existing.clone(),source.clone()).is_err());
    assert_eq!(fs::read_to_string(existing).unwrap(),"original user content");
    for suffix in ["", "-wal", "-shm", "-journal"] { assert!(start(fixture.dir.join(format!("fixture.sqlite{suffix}")),source.clone()).is_err()); }
    assert!(start(fixture.dir.join("wrong-scope.csv"),json!({"nodeId":fixture.table("t"),"connectionId":"other-connection"})).is_err());
    #[cfg(unix)] {
        let alias = fixture.dir.join("db-alias.sqlite");
        std::os::unix::fs::symlink(fixture.dir.join("fixture.sqlite"),&alias).unwrap();
        assert!(start(alias,source).is_err());
    }
}

#[test]
fn task_kinds_are_isolated_and_unknown_wait_cancel_are_honest() {
    let fixture = Fixture::new();
    assert_eq!(fixture.app.call("getImportProgress",vec![json!("missing")]).unwrap(),Value::Null);
    assert_eq!(fixture.app.call("cancelTransfer",vec![json!("missing")]).unwrap(),false);
    assert!(fixture.app.call("waitImport",vec![json!("missing")]).is_err());
    fixture.sql("CREATE TABLE t (id INTEGER)");
    let result = fixture.export("isolated.csv","csv",json!({"nodeId":fixture.table("t")}),1);
    assert_eq!(fixture.app.call("getImportProgress",vec![result["taskId"].clone()]).unwrap(),Value::Null);
    assert_eq!(fixture.app.call("cancelTransfer",vec![result["taskId"].clone()]).unwrap(),false);
}

#[test]
fn json_indent_and_header_options_have_exact_output_bytes_and_boolean_indent_is_rejected() {
    let fixture = Fixture::new();
    for (name, format, options, expected) in [
        ("compact.json","json",json!({"jsonIndent":0,"includeHeader":true}),"[\n{\"n\":1}\n]\n"),
        ("indented.json","json",json!({"jsonIndent":4,"includeHeader":true}),"[\n    {\n        \"n\": 1\n    }\n]\n"),
        ("array.json","json",json!({"jsonIndent":0,"includeHeader":false}),"[\n[1]\n]\n"),
        ("object.jsonl","jsonl",json!({"jsonIndent":4,"includeHeader":true}),"{\"n\":1}\n"),
        ("array.jsonl","jsonl",json!({"includeHeader":false}),"[1]\n"),
        ("header.csv","csv",json!({"includeHeader":true}),"n\r\n1\r\n"),
        ("no-header.csv","csv",json!({"includeHeader":false}),"1\r\n"),
    ] {
        let task = fixture.app.call("startTransfer",vec![json!({"source":{"connectionId":fixture.id,"sql":"SELECT 1 AS n"},"format":format,
            "destinationPath":fixture.dir.join(name),"options":options})]).unwrap();
        let result = fixture.app.call("waitTransfer",vec![task["taskId"].clone()]).unwrap();
        assert_eq!(result["status"],"completed","{result}");
        assert_eq!(fs::read(fixture.dir.join(name)).unwrap(),expected.as_bytes());
        assert_eq!(result["bytesWritten"].as_u64().unwrap(),expected.len() as u64);
    }
    for indent in [json!(true),json!(false),json!(-1),json!(9)] {
        assert!(fixture.app.call("startTransfer",vec![json!({"source":{"connectionId":fixture.id,"sql":"SELECT 1"},"format":"json",
            "destinationPath":fixture.dir.join("invalid-indent.json"),"options":{"jsonIndent":indent}})]).is_err());
    }
}

#[test]
fn csv_export_refuses_null_markers_that_cannot_roundtrip_without_changing_values() {
    let fixture = Fixture::new();
    for marker in [",", "\"", "a\nb"] {
        assert!(fixture.app.call("startTransfer",vec![json!({"source":{"connectionId":fixture.id,"sql":"SELECT NULL AS n"},"format":"csv",
            "destinationPath":fixture.dir.join("invalid-null-marker.csv"),"options":{"nullText":marker}})]).is_err());
    }
    let result = fixture.export("single-null.csv","csv",json!({"connectionId":fixture.id,"sql":"SELECT NULL AS n"}),1);
    assert_eq!(result["status"],"failed");
    assert!(!fixture.dir.join("single-null.csv").exists());
}

#[test]
fn csv_single_empty_text_roundtrips_with_nonempty_null_marker() {
    let fixture = Fixture::new();
    let destination = fixture.dir.join("empty-text.csv");
    let task = fixture.app.call("startTransfer",vec![json!({
        "source":{"connectionId":fixture.id,"sql":"SELECT '' AS value"},"format":"csv","destinationPath":destination,
        "options":{"nullText":"NULL","includeHeader":true}
    })]).unwrap();
    let result = fixture.app.call("waitTransfer",vec![task["taskId"].clone()]).unwrap();
    assert_eq!(result["status"],"completed","{result}");
    assert_eq!(fs::read(&destination).unwrap(),b"value\r\n\"\"\r\n");
    let preview = fixture.app.call("previewImport",vec![json!({"sourcePath":destination,"delimiter":",","nullText":"NULL","hasHeader":true})]).unwrap();
    assert_eq!(preview["errorCount"],0);
    assert_eq!(preview["totalRows"],1);
    assert_eq!(preview["sampleRows"][0]["values"][0]["kind"],"text");
    assert_eq!(preview["sampleRows"][0]["values"][0]["text"],"");
    assert_eq!(preview["sampleRows"][0]["values"][0]["quoted"],true);
}

#[test]
#[cfg(unix)]
fn sqlite_alias_connection_protects_both_alias_and_real_not_yet_created_sidecars() {
    let fixture = Fixture::new();
    fixture.sql("CREATE TABLE alias_protection (id INTEGER)");
    let real = fixture.dir.join("fixture.sqlite");
    let alias = fixture.dir.join("configured-alias.sqlite");
    // Both paths are new fixture-owned paths; the link is never changed or removed.
    std::os::unix::fs::symlink(&real,&alias).unwrap();
    let app = Application::open(fixture.dir.join("alias-state"),Arc::new(FixtureSecrets::default())).unwrap();
    let connection = app.call("addConnection",vec![json!({"dialectId":"sqlite","name":"alias-only-fixture","options":{"file":alias}})]).unwrap();
    assert_eq!(connection["connected"],true);
    for base in [&alias,&real] {
        for suffix in ["-wal","-shm","-journal"] {
            let destination = PathBuf::from(format!("{}{suffix}",base.to_str().unwrap()));
            assert!(!destination.exists(),"fixture sidecar must not exist before the guard check");
            let result = app.call("startTransfer",vec![json!({"source":{"connectionId":connection["id"],"sql":"SELECT 1 AS value"},
                "format":"csv","destinationPath":destination})]);
            assert_eq!(result.unwrap_err().code,"database-path");
            assert!(!destination.exists());
        }
    }
    app.close().unwrap();
}
