//! Real, disposable SQLite files exercised only through the native Driver contract.
//! Fixtures are retained in the OS temporary directory; no user files are opened.
use dbstudio_protocol::{ConnectionConfig, Driver, SecretMap};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::atomic::{AtomicU64, Ordering}, time::{SystemTime, UNIX_EPOCH}};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
fn fixture_path() -> PathBuf {
    std::env::temp_dir().join(format!("dbstudio-native-sqlite-{}-{}-{}.db", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(), SEQUENCE.fetch_add(1, Ordering::Relaxed)))
}
fn fixture(sql: &str) -> (Box<dyn Driver>, PathBuf) {
    let path = fixture_path();
    let db = Connection::open(&path).unwrap();
    db.execute_batch(sql).unwrap();
    drop(db);
    let config: ConnectionConfig = serde_json::from_value(json!({
        "dialectId":"sqlite", "name":"native fixture", "options":{"file":path.to_str().unwrap()}
    })).unwrap();
    (dbstudio_drivers::sqlite::connect(&config, &SecretMap::new()).unwrap(), path)
}
fn call(driver: &mut dyn Driver, method: &str, args: Value) -> Value {
    driver.call(method, args.as_array().unwrap().clone()).unwrap()
}

#[test]
fn missing_database_is_rejected_without_creating_a_file() {
    let path = fixture_path();
    let config: ConnectionConfig = serde_json::from_value(json!({
        "dialectId":"sqlite", "name":"missing", "options":{"file":path.to_str().unwrap()}
    })).unwrap();
    assert!(dbstudio_drivers::sqlite::connect(&config, &SecretMap::new()).is_err());
    assert!(!path.exists(), "opening a connection must never silently create an empty database");
}

#[test]
fn native_query_preserves_duplicate_columns_parameters_and_random_pages() {
    let (mut driver, _) = fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,note TEXT); INSERT INTO items VALUES(1,'a'),(2,'b'),(3,'c');");
    let page = call(driver.as_mut(), "query", json!(["SELECT id AS dup, note AS dup FROM items WHERE id >= :min ORDER BY id", {
        "parameters":[{"name":"min","value":1}], "limit":1
    }]));
    assert_eq!(page["columns"].as_array().unwrap().len(), 2);
    assert_eq!(page["rows"][0]["cells"], json!([{"kind":"number","value":1},{"kind":"text","text":"a"}]));
    let cursor = page["cursorId"].as_str().unwrap().to_owned();
    let later = call(driver.as_mut(), "fetchResultPage", json!([cursor, 2, 1]));
    assert_eq!(later["rows"][0]["index"], 2);
    assert_eq!(later["rows"][0]["cells"][0]["value"], 3);
    let first = call(driver.as_mut(), "fetchResultPage", json!([cursor, 0, 1]));
    assert_eq!(first["rows"][0]["cells"][1]["text"], "a");
    call(driver.as_mut(), "closeCursor", json!([cursor]));
    assert!(driver.call("fetchResultPage", vec![json!(cursor), json!(0), json!(1)]).is_err());
    assert!(driver.call("query", vec![json!("DELETE FROM items")]).is_err());
    assert!(driver.call("executeStatement", vec![json!("SELECT 1; DELETE FROM items")]).is_err());
    assert_eq!(call(driver.as_mut(), "countRows", json!(["table:items"])), 3);
}

#[test]
fn edits_use_complete_primary_keys_and_remain_uncommitted_until_explicit_commit() {
    let (mut driver, path) = fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,note TEXT); INSERT INTO items VALUES(1,'original'),(2,'other');");
    let observer = Connection::open(&path).unwrap();
    let result = call(driver.as_mut(), "applyEdits", json!(["table:items", [{
        "keyValues":{"id":{"kind":"number","value":1}}, "changes":{"note":{"kind":"text","text":"changed"}}
    }]]));
    assert_eq!(result["ok"], true);
    assert_eq!(result["inTransaction"], true);
    assert_eq!(observer.query_row("SELECT note FROM items WHERE id=1", [], |row| row.get::<_, String>(0)).unwrap(), "original");
    call(driver.as_mut(), "rollbackTransaction", json!([]));
    assert_eq!(call(driver.as_mut(), "query", json!(["SELECT note FROM items WHERE id=1", {"keepCursor":false}]))["rows"][0]["cells"][0]["text"], "original");
    let injected = call(driver.as_mut(), "applyEdits", json!(["table:items", [{
        "keyValues":{"id":{"kind":"text","text":"1 OR 1=1"}}, "changes":{"note":{"kind":"text","text":"unsafe"}}
    }]]));
    assert_eq!(injected["affected"], 0);
    call(driver.as_mut(), "rollbackTransaction", json!([]));
    call(driver.as_mut(), "executeStatement", json!(["UPDATE items SET note = :note WHERE id=1", {"parameters":[{"name":"note","value":"committed"}]}]));
    assert_eq!(call(driver.as_mut(), "transactionState", json!([]))["active"], true);
    call(driver.as_mut(), "commitTransaction", json!([]));
    assert_eq!(observer.query_row("SELECT note FROM items WHERE id=1", [], |row| row.get::<_, String>(0)).unwrap(), "committed");
    assert!(driver.call("commitTransaction", vec![]).is_err());
}

#[test]
fn large_values_nul_and_i64_are_lossless_and_previews_are_explicit() {
    let (mut driver, _) = fixture("CREATE TABLE payload(id INTEGER PRIMARY KEY,body TEXT,data BLOB); INSERT INTO payload VALUES(1,replace(hex(zeroblob(900)),'0','x') || char(0) || 'tail',randomblob(1024));");
    let page = call(driver.as_mut(), "runQuery", json!(["SELECT body,data,9223372036854775807 AS huge FROM payload"]));
    let cursor = page["cursorId"].as_str().unwrap();
    assert_eq!(page["rows"][0]["cells"][0]["truncated"], true);
    assert_eq!(page["rows"][0]["cells"][0]["fullLength"], 1805);
    assert_eq!(page["rows"][0]["cells"][1]["truncated"], true);
    assert_eq!(page["rows"][0]["cells"][1]["length"], 1024);
    assert_eq!(page["rows"][0]["cells"][2], json!({"kind":"text","text":"9223372036854775807"}));
    let full = call(driver.as_mut(), "fetchCellValue", json!([cursor,0,0]));
    let body = full["text"].as_str().unwrap();
    assert_eq!(body.len(), 1805);
    assert_eq!(&body[1800..], "\0tail");
    assert!(full.get("truncated").is_none());
    let blob = call(driver.as_mut(), "fetchCellValue", json!([cursor,0,1]));
    assert_eq!(blob["truncated"], false);
    assert_eq!(blob["length"], 1024);
    let bad = driver.call("applyEdits", vec![json!("table:payload"), json!([{
        "keyValues":{"id":{"kind":"number","value":1}}, "changes":{"body":page["rows"][0]["cells"][0]}
    }])]);
    assert!(bad.is_err());
    assert_eq!(call(driver.as_mut(), "transactionState", json!([]))["active"], false);
}

#[test]
fn metadata_reads_real_composite_foreign_keys_indexes_checks_triggers_and_generated_columns() {
    let (mut driver, _) = fixture("CREATE TABLE parent(a INTEGER,b TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID;
        CREATE TABLE child(id INTEGER PRIMARY KEY,a INTEGER,b TEXT,note TEXT NOT NULL DEFAULT 'x',upper_note TEXT GENERATED ALWAYS AS (upper(note)) STORED,
            FOREIGN KEY(a,b) REFERENCES parent ON DELETE CASCADE,CHECK(length(note)>0));
        CREATE UNIQUE INDEX child_note ON child(note) WHERE a IS NOT NULL;
        CREATE INDEX child_expr ON child(lower(note));
        CREATE TRIGGER child_audit AFTER UPDATE OF note ON child WHEN NEW.note != OLD.note BEGIN SELECT 1; END;
        CREATE VIEW child_view AS SELECT id,note FROM child;");
    let roots = call(driver.as_mut(), "listChildren", json!([null]));
    assert_eq!(roots[0]["id"], "folder:tables");
    let tables = call(driver.as_mut(), "listChildren", json!(["folder:tables"]));
    assert_eq!(tables.as_array().unwrap().len(), 2);
    assert!(!tables.as_array().unwrap().iter().any(|t| t["name"] == "sqlite_sequence"));
    let desc = call(driver.as_mut(), "describeTable", json!(["table:child"]));
    assert_eq!(desc["hasUniqueKey"], true);
    let columns = desc["columns"].as_array().unwrap();
    assert_eq!(columns.iter().find(|c| c["name"] == "id").unwrap()["requiredOnInsert"], false);
    let generated = columns.iter().find(|c| c["name"] == "upper_note").unwrap();
    assert_eq!(generated["generated"], "stored");
    assert_eq!(generated["requiredOnInsert"], false);
    assert_eq!(desc["foreignKeys"][0]["columns"], json!(["a","b"]));
    assert_eq!(desc["foreignKeys"][0]["referencedColumns"], json!(["a","b"]));
    assert_eq!(desc["foreignKeys"][0]["onDelete"], "CASCADE");
    assert_eq!(desc["checks"][0]["expression"], "length(note)>0");
    let indexes = desc["indexes"].as_array().unwrap();
    assert_eq!(indexes.iter().find(|i| i["name"] == "child_note").unwrap()["predicate"], "a IS NOT NULL");
    assert_eq!(indexes.iter().find(|i| i["name"] == "child_expr").unwrap()["expression"], "lower(note)");
    assert_eq!(desc["triggers"][0]["timing"], "AFTER");
    assert_eq!(desc["triggers"][0]["event"], "UPDATE");
    assert_eq!(desc["triggers"][0]["updateOf"], json!(["note"]));
    assert_eq!(desc["triggers"][0]["statement"], "SELECT 1;");
    let parent = call(driver.as_mut(), "describeTable", json!(["table:parent"]));
    assert!(parent["columns"].as_array().unwrap().iter().all(|c| c["requiredOnInsert"] == true));
    assert!(call(driver.as_mut(), "viewDefinition", json!(["view:child_view"])).as_str().unwrap().contains("CREATE VIEW"));
    assert_eq!(call(driver.as_mut(), "listRoutines", json!([])), json!([]));
}

#[test]
fn ddl_quotes_identifiers_validates_structure_and_explain_is_read_only() {
    let (mut driver, _) = fixture("");
    call(driver.as_mut(), "createTable", json!([{"name":"a.b\";not sql","columns":[
        {"name":"id","typeName":"INTEGER","primaryKeyOrdinal":1},
        {"name":"note","typeName":"VARCHAR(64)","nullable":false,"defaultValue":"'safe''value'"}
    ]}]));
    let id = "table:a.b\";not sql";
    assert_eq!(call(driver.as_mut(), "tableSelectSql", json!([id])), "SELECT * FROM \"a.b\"\";not sql\"");
    call(driver.as_mut(), "insertRow", json!([id,{"note":{"kind":"text","text":"v"}}]));
    call(driver.as_mut(), "commitTransaction", json!([]));
    let plan = call(driver.as_mut(), "explain", json!(["SELECT * FROM \"a.b\"\";not sql\""]));
    assert_eq!(plan["dialectId"], "sqlite");
    assert_eq!(plan["format"], "tabular");
    assert!(!plan["rows"].as_array().unwrap().is_empty());
    assert!(driver.call("createTable", vec![json!({"name":"bad","columns":[{"name":"x","typeName":"TEXT); DROP TABLE x;--"}]})]).is_err());
    assert!(driver.call("createTable", vec![json!({"name":"bad","columns":[{"name":"x","typeName":"TEXT","defaultValue":"'x'; SELECT 1"}]})]).is_err());
    call(driver.as_mut(), "createView", json!(["v", "SELECT id FROM \"a.b\"\";not sql\""]));
    assert!(call(driver.as_mut(), "viewDefinition", json!(["view:v"])).as_str().unwrap().contains("CREATE VIEW"));
    call(driver.as_mut(), "dropView", json!(["view:v"]));
    call(driver.as_mut(), "renameTable", json!([id,"renamed"]));
    let source = call(driver.as_mut(), "resolveTransferSource", json!(["table:renamed"]));
    assert_eq!(source["target"]["table"], "renamed");
    assert!(source["sqliteFile"].as_str().unwrap().starts_with(std::env::temp_dir().to_str().unwrap()));
    call(driver.as_mut(), "dropTable", json!(["table:renamed"]));
    assert!(driver.call("describeTable", vec![json!("table:renamed")]).is_err());
}

#[test]
fn import_requires_its_own_transaction_rejects_ignored_rows_and_can_be_fully_rolled_back() {
    let (mut driver, path) = fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,note TEXT UNIQUE); CREATE TRIGGER skip BEFORE INSERT ON items WHEN NEW.note='skip' BEGIN SELECT RAISE(IGNORE); END;");
    let observer = Connection::open(path).unwrap();
    let batch = |index: u64, id: i64, note: &str| json!({"batchIndex":index,"columns":["id","note"],"rows":[{"rowNumber":index+1,"lineNumber":index+2,"values":[{"kind":"number","value":id},{"kind":"text","text":note}]}]});
    call(driver.as_mut(), "insertRow", json!(["table:items",{"note":{"kind":"text","text":"ordinary"}}]));
    assert!(driver.call("importBatch", vec![json!("table:items"),batch(0,2,"import")]).is_err());
    call(driver.as_mut(), "rollbackTransaction", json!([]));
    let imported = call(driver.as_mut(), "importBatch", json!(["table:items",batch(0,1,"first")]));
    assert_eq!(imported, json!({"rowsImported":1,"inTransaction":true}));
    assert_eq!(observer.query_row("SELECT count(*) FROM items", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert!(driver.call("executeStatement", vec![json!("UPDATE items SET note='other'")]).is_err());
    let ignored = driver.call("importBatch", vec![json!("table:items"),batch(1,2,"skip")]);
    assert!(ignored.is_err(), "RAISE(IGNORE) cannot be counted as imported");
    call(driver.as_mut(), "rollbackTransaction", json!([]));
    assert_eq!(call(driver.as_mut(), "countRows", json!(["table:items"])), 0);
    call(driver.as_mut(), "importBatch", json!(["table:items",batch(0,1,"a")]));
    call(driver.as_mut(), "importBatch", json!(["table:items",batch(1,2,"b")]));
    call(driver.as_mut(), "commitTransaction", json!([]));
    assert_eq!(observer.query_row("SELECT count(*) FROM items", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
}

#[test]
fn import_error_does_not_echo_values_in_trigger_messages() {
    let (mut driver, _) = fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,note TEXT); CREATE TRIGGER reject BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'fixture-value-fragment'); END;");
    let error = driver.call("importBatch", vec![json!("table:items"),json!({"batchIndex":0,"columns":["note"],"rows":[{
        "rowNumber":9,"lineNumber":12,"values":[{"kind":"text","text":"fixture-value-fragment"}]
    }]})]).unwrap_err();
    assert!(!error.message.contains("fixture-value-fragment"));
    assert!(error.message.contains('9') && error.message.contains("12"));
    call(driver.as_mut(), "rollbackTransaction", json!([]));
}

#[test]
fn primary_key_variants_and_unkeyed_tables_are_handled_conservatively() {
    let (mut driver, _) = fixture("CREATE TABLE composite(a INTEGER,b TEXT,note TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID;
        INSERT INTO composite VALUES(1,'b','old'); CREATE TABLE no_key(note TEXT); CREATE TABLE descending(id INTEGER PRIMARY KEY DESC,note TEXT);");
    assert!(driver.call("applyEdits", vec![json!("table:composite"),json!([{"keyValues":{"a":{"kind":"number","value":1}},"changes":{"note":{"kind":"text","text":"wrong"}}}])]).is_err());
    assert_eq!(call(driver.as_mut(), "transactionState", json!([]))["active"], false);
    let changed = call(driver.as_mut(), "applyEdits", json!(["table:composite",[{
        "keyValues":{"A":{"kind":"number","value":1},"B":{"kind":"text","text":"b"}},"changes":{"NOTE":{"kind":"text","text":"new"}}
    }]]));
    assert_eq!(changed["affected"], 1);
    call(driver.as_mut(), "rollbackTransaction", json!([]));
    assert!(driver.call("deleteRows", vec![json!("table:no_key"),json!([{}])]).is_err());
    let inserted = call(driver.as_mut(), "insertRow", json!(["table:no_key",{"note":{"kind":"text","text":"allowed"}}]));
    assert_eq!(inserted["affected"], 1);
    assert_eq!(inserted["keyValues"], json!({}));
    call(driver.as_mut(), "rollbackTransaction", json!([]));
    let desc = call(driver.as_mut(), "describeTable", json!(["table:descending"]));
    assert_eq!(desc["columns"][0]["requiredOnInsert"], true, "INTEGER PRIMARY KEY DESC is not an auto-generated rowid alias");
}

#[test]
fn failed_insert_rolls_back_only_its_savepoint_inside_an_existing_transaction() {
    let (mut driver, path) = fixture("CREATE TABLE prior(id INTEGER PRIMARY KEY,note TEXT);
        CREATE TABLE failing(id INTEGER PRIMARY KEY,note TEXT); CREATE TABLE audit(id INTEGER);
        CREATE TRIGGER fail_after AFTER INSERT ON failing BEGIN INSERT INTO audit VALUES(NEW.id); SELECT RAISE(FAIL,'fixture insert failure'); END;");
    call(driver.as_mut(), "insertRow", json!(["table:prior",{"note":{"kind":"text","text":"keep earlier work"}}]));
    assert_eq!(call(driver.as_mut(), "transactionState", json!([]))["pendingAffected"], 1);
    let failed = driver.call("insertRow", vec![json!("table:failing"),json!({"note":{"kind":"text","text":"must not remain"}})]);
    assert!(failed.is_err());
    assert_eq!(call(driver.as_mut(), "countRows", json!(["table:failing"])), 0, "failed insert must leave no target row");
    assert_eq!(call(driver.as_mut(), "countRows", json!(["table:audit"])), 0, "AFTER trigger side effects must be reverted");
    assert_eq!(call(driver.as_mut(), "countRows", json!(["table:prior"])), 1, "earlier uncommitted work must survive");
    assert_eq!(call(driver.as_mut(), "transactionState", json!([])), json!({"active":true,"pendingAffected":1}));
    call(driver.as_mut(), "commitTransaction", json!([]));
    let observer = Connection::open(path).unwrap();
    assert_eq!(observer.query_row("SELECT count(*) FROM prior",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(observer.query_row("SELECT count(*) FROM failing",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(observer.query_row("SELECT count(*) FROM audit",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    let fresh_failure = driver.call("insertRow", vec![json!("table:failing"),json!({"note":{"kind":"text","text":"fresh transaction failure"}})]);
    assert!(fresh_failure.is_err());
    assert_eq!(call(driver.as_mut(), "transactionState", json!([])), json!({"active":false,"pendingAffected":0}), "a failed insert that opened its own transaction must clean it up");
    assert_eq!(call(driver.as_mut(), "countRows", json!(["table:failing"])), 0);
    assert_eq!(call(driver.as_mut(), "countRows", json!(["table:audit"])), 0);
    assert_eq!(call(driver.as_mut(), "countRows", json!(["table:prior"])), 1);
}

#[test]
fn reconnect_never_reuses_old_result_cursor_ids() {
    let (mut first, path) = fixture("CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(1);");
    let old = call(first.as_mut(), "runQuery", json!(["SELECT * FROM items"]))["cursorId"].as_str().unwrap().to_owned();
    first.disconnect().unwrap();
    let config: ConnectionConfig = serde_json::from_value(json!({"dialectId":"sqlite","name":"reconnect","options":{"file":path.to_str().unwrap()}})).unwrap();
    let mut second = dbstudio_drivers::sqlite::connect(&config, &SecretMap::new()).unwrap();
    let current = call(second.as_mut(), "runQuery", json!(["SELECT * FROM items"]))["cursorId"].as_str().unwrap().to_owned();
    assert_ne!(old, current);
    assert!(second.call("fetchResultPage",vec![json!(old),json!(0),json!(1)]).is_err());
}

#[test]
fn pages_are_clamped_parameters_are_checked_and_disconnect_rolls_back() {
    let (mut driver, path) = fixture("CREATE TABLE values_table(id INTEGER PRIMARY KEY); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1500) INSERT INTO values_table SELECT x FROM n;");
    let page = call(driver.as_mut(), "runQuery", json!(["SELECT * FROM values_table",{"limit":999999,"keepCursor":false}]));
    assert_eq!(page["returned"], 1000);
    assert_eq!(page["cursorId"], Value::Null);
    assert!(driver.call("runQuery", vec![json!("SELECT :value")]).is_err());
    assert!(driver.call("runQuery", vec![json!("SELECT 1"),json!({"parameters":[{"name":"unused","value":1}]})]).is_err());
    let positional = call(driver.as_mut(), "query", json!(["SELECT ? + ?",{"parameters":[{"name":"?1","value":2},{"name":"?2","value":3}]}]));
    assert_eq!(positional["rows"][0]["cells"][0]["value"], 5);
    call(driver.as_mut(), "executeStatement", json!(["DELETE FROM values_table WHERE id=1"]));
    driver.disconnect().unwrap();
    driver.disconnect().unwrap();
    assert_eq!(call(driver.as_mut(), "transactionState", json!([]))["active"], false);
    let observer = Connection::open(path).unwrap();
    assert_eq!(observer.query_row("SELECT count(*) FROM values_table",[],|r|r.get::<_,i64>(0)).unwrap(),1500);
}
