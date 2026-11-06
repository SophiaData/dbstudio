use dbstudio_core::{AppError, Application, SecretStore};
use dbstudio_protocol::SecretMap;
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::PathBuf, sync::{Arc, Mutex}};
use uuid::Uuid;

#[derive(Default)]
struct FixtureSecrets(Mutex<HashMap<String, SecretMap>>);
impl SecretStore for FixtureSecrets {
    fn get(&self, key: &str) -> Result<Option<SecretMap>, AppError> { Ok(self.0.lock().unwrap().get(key).cloned()) }
    fn set(&self, key: &str, secret: &SecretMap) -> Result<(), AppError> { self.0.lock().unwrap().insert(key.into(), secret.clone()); Ok(()) }
    fn remove(&self, key: &str) -> Result<(), AppError> { self.0.lock().unwrap().remove(key); Ok(()) }
}
fn private_dir() -> PathBuf {
    let path = std::env::temp_dir().join(format!("dbstudio-native-core-test-{}", Uuid::new_v4()));
    let mut builder = fs::DirBuilder::new(); builder.recursive(true);
    #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    builder.create(&path).unwrap(); path
}
fn app(base: &PathBuf, secrets: Arc<FixtureSecrets>) -> Application { Application::open(base.clone(), secrets).unwrap() }
fn sqlite(app: &Application, base: &PathBuf, name: &str) -> Value {
    let file = base.join(format!("{name}.sqlite")); fs::write(&file, b"").unwrap();
    let summary = app.call("addConnection", vec![json!({"dialectId":"sqlite","name":name,"options":{"file":file}})]).unwrap();
    assert_eq!(summary["connected"], true); assert_eq!(summary["persisted"], true); summary
}
fn root(summary: &Value) -> String { format!("connection:{}", summary["id"].as_str().unwrap()) }
fn statement(app: &Application, node: &str, sql: &str) -> Value { app.call("executeStatement", vec![json!(node),json!(sql)]).unwrap() }

#[test]
fn native_sqlite_application_roundtrip_and_session_cursor_isolation() {
    let base = private_dir(); let secrets = Arc::new(FixtureSecrets::default());
    let application = app(&base, secrets.clone());
    let a = sqlite(&application, &base, "a"); let b = sqlite(&application, &base, "b");
    let node = root(&a); let bnode = root(&b); let id = a["id"].as_str().unwrap();
    statement(&application, &node, "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    statement(&application, &node, "INSERT INTO users(id,name) VALUES(1,'native')");
    application.call("commitTransaction", vec![json!(node)]).unwrap();
    let query = application.call("runQuery", vec![json!(node),json!("SELECT id,name FROM users"),json!({"limit":1})]).unwrap();
    assert_eq!(query["returned"], 1);
    let cursor = query["cursorId"].as_str().unwrap(); assert!(cursor.starts_with(&format!("{node}|cursor:")));
    assert_eq!(application.call("fetchResultPage", vec![json!(cursor),json!(0),json!(1)]).unwrap()["returned"], 1);
    assert!(application.call("fetchResultPage", vec![json!(cursor.replacen(&node, &bnode, 1)),json!(0),json!(1)]).is_err());
    let children = application.call("listChildren", vec![json!(node)]).unwrap();
    assert!(children.as_array().unwrap().iter().all(|item| item["id"].as_str().unwrap().starts_with(&format!("{node}|"))));
    application.call("disconnectConnection", vec![json!(id)]).unwrap();
    assert_eq!(application.call("fetchResultPage", vec![json!(cursor),json!(0),json!(1)]).unwrap_err().code, "not-found");
    assert!(application.call("closeCursor", vec![json!(cursor)]).unwrap().is_null());
    application.call("connectConnection", vec![json!(id)]).unwrap();
    let requery = application.call("runQuery", vec![json!(node),json!("SELECT name FROM users"),json!({"keepCursor":false})]).unwrap();
    assert_eq!(requery["rows"][0]["cells"][0]["text"], "native");
    application.close().unwrap(); application.close().unwrap();
    assert!(application.call("listConnections", vec![]).is_err());
    let reopened = app(&base, secrets);
    let saved = reopened.call("listConnections", vec![]).unwrap();
    assert_eq!(saved.as_array().unwrap().len(), 2); assert_eq!(saved[0]["connected"], false);
    reopened.call("connectConnection", vec![json!(id)]).unwrap();
    assert_eq!(reopened.call("runQuery", vec![json!(node),json!("SELECT COUNT(*) FROM users"),json!({"keepCursor":false})]).unwrap()["returned"], 1);
    reopened.close().unwrap();
}

#[test]
fn legacy_config_migration_preserves_originals_and_reports_credential_reentry() {
    let base = private_dir(); let secrets = Arc::new(FixtureSecrets::default());
    let original = json!({"schemaVersion":1,"connections":[{"id":"c1","config":{"dialectId":"postgresql","name":"fixture","options":{"host":"fixture.invalid","port":5432}}}]});
    let original_text = serde_json::to_vec(&original).unwrap();
    fs::write(base.join("connections.json"), &original_text).unwrap();
    let ciphertext_fixture = b"fixture-opaque-electron-ciphertext-not-for-native-decryption";
    fs::write(base.join("secrets.json"), ciphertext_fixture).unwrap();
    let application = app(&base, secrets.clone());
    let status = application.call("migrationStatus", vec![]).unwrap();
    assert_eq!(status["legacyConfigImported"], true); assert_eq!(status["legacySecretsRequireReentry"], true);
    let summary = application.call("listConnections", vec![]).unwrap();
    assert_eq!(summary[0]["secretStored"], false); assert!(!summary[0]["warnings"].as_array().unwrap().is_empty());
    assert_eq!(application.call("connectConnection", vec![json!("c1")]).unwrap_err().code, "secret-reentry-required");
    assert_eq!(fs::read(base.join("connections.json")).unwrap(), original_text);
    assert_eq!(fs::read(base.join("secrets.json")).unwrap(), ciphertext_fixture);
    assert!(base.join("connections-v2.json").exists());
    application.call("updateConnection", vec![json!("c1"),json!({"name":"reentered"}),json!({"dbPassword":"synthetic-reentry"})]).unwrap();
    assert_eq!(application.call("migrationStatus", vec![]).unwrap()["legacySecretsRequireReentry"], false);
    let persisted = fs::read_to_string(base.join("connections-v2.json")).unwrap();
    assert!(!persisted.contains("synthetic-reentry"));
    application.close().unwrap();
    let reopened = app(&base, secrets);
    assert_eq!(reopened.call("migrationStatus", vec![]).unwrap()["legacySecretsRequireReentry"], false);
    reopened.close().unwrap();
}

#[test]
fn sql_library_is_persisted_in_separate_v2_files_and_unsupported_is_explicit() {
    let base = private_dir(); let secrets = Arc::new(FixtureSecrets::default());
    let application = app(&base, secrets.clone());
    assert_eq!(application.call("migrationStatus", vec![]).unwrap(), json!({"legacyConfigImported":false,"legacySecretsRequireReentry":false,"legacySqlHistoryImported":false,"legacySavedSqlImported":false,"warnings":[]}));
    let saved = application.call("saveSql", vec![Value::Null,json!("one"),json!("SELECT 1")]).unwrap();
    application.call("saveSql", vec![saved["id"].clone(),json!("updated"),json!("SELECT 2")]).unwrap();
    application.call("recordSqlHistory", vec![json!({"connectionId":"removed","dialectId":"sqlite","sql":"SELECT 1","elapsedMs":2,"status":"success","returnedRows":1})]).unwrap();
    let snapshot = application.call("listSqlLibrary", vec![]).unwrap();
    assert_eq!(snapshot["saved"][0]["name"], "updated"); assert_eq!(snapshot["history"].as_array().unwrap().len(), 1);
    assert_eq!(application.call("chooseImportFile", vec![]).unwrap_err().code, "unsupported");
    assert_eq!(application.call("unknownNativeMethod", vec![]).unwrap_err().code, "unsupported");
    application.close().unwrap();
    let reopened = app(&base, secrets);
    assert_eq!(reopened.call("listSqlLibrary", vec![]).unwrap(), snapshot);
    reopened.call("clearSqlHistory", vec![]).unwrap();
    assert_eq!(reopened.call("listSqlLibrary", vec![]).unwrap()["saved"].as_array().unwrap().len(), 1);
    reopened.call("removeSavedSql", vec![saved["id"].clone()]).unwrap();
    assert_eq!(reopened.call("listSqlLibrary", vec![]).unwrap()["saved"].as_array().unwrap().len(), 0);
    reopened.close().unwrap();
}

#[test]
fn unrecognized_config_is_not_overwritten_and_inline_password_is_rejected() {
    let base = private_dir(); let text = b"{\"schemaVersion\":999,\"connections\":[]}";
    fs::write(base.join("connections-v2.json"), text).unwrap();
    let result = Application::open(base.clone(), Arc::new(FixtureSecrets::default()));
    assert!(result.is_err()); assert_eq!(fs::read(base.join("connections-v2.json")).unwrap(), text);
    let clean = private_dir(); let application = app(&clean, Arc::new(FixtureSecrets::default()));
    assert!(application.call("addConnection", vec![json!({"dialectId":"sqlite","name":"unsafe","options":{"file":"fixture","password":"synthetic"}})]).is_err());
    assert!(!clean.join("connections-v2.json").exists());
    application.close().unwrap();
}

#[test]
fn oversized_library_write_fails_without_breaking_restart_or_existing_saved_sql() {
    let base = private_dir(); let secrets = Arc::new(FixtureSecrets::default());
    let application = app(&base, secrets.clone());
    application.call("saveSql", vec![Value::Null,json!("keep"),json!("SELECT 1")]).unwrap();
    let original = fs::read(base.join("sql-library-v2.json")).unwrap();
    let snapshot = application.call("listSqlLibrary", vec![]).unwrap();
    let oversized = "x".repeat(8 * 1024 * 1024);
    assert_eq!(application.call("saveSql", vec![Value::Null,json!("too-large"),json!(oversized)]).unwrap_err().code, "resource-limit");
    assert_eq!(fs::read(base.join("sql-library-v2.json")).unwrap(), original);
    assert_eq!(application.call("listSqlLibrary", vec![]).unwrap(), snapshot);
    application.close().unwrap();
    let reopened = app(&base, secrets);
    assert_eq!(reopened.call("listSqlLibrary", vec![]).unwrap(), snapshot);
    reopened.close().unwrap();
}

#[test]
fn explicit_separate_legacy_directory_imports_typed_config_and_sql_library_once() {
    let base = private_dir(); let legacy = private_dir(); let secrets = Arc::new(FixtureSecrets::default());
    let configs = serde_json::to_vec(&json!({"schemaVersion":1,"connections":[{"id":"c-legacy","config":{"dialectId":"postgresql","name":"legacy-fixture","options":{"host":"fixture.invalid","port":5432}}}]})).unwrap();
    let history = serde_json::to_vec(&json!({"schemaVersion":1,"entries":[{"id":"h1","sql":"SELECT 1","connectionId":"c-legacy","connectionName":"legacy-fixture","dialectId":"postgresql","startedAt":1,"elapsedMs":2,"status":"success","error":null,"returnedRows":1}]})).unwrap();
    let favorites = serde_json::to_vec(&json!({"schemaVersion":1,"entries":[{"id":"s1","name":"legacy-saved","sql":"SELECT 2","updatedAt":1}]})).unwrap();
    fs::write(legacy.join("connections.json"), &configs).unwrap();
    fs::write(legacy.join("sql-history.json"), &history).unwrap();
    fs::write(legacy.join("saved-sql.json"), &favorites).unwrap();
    // Invalid UTF-8 is deliberate: the native core must never parse or copy old ciphertext.
    let opaque_ciphertext = [0xff, 0x00, 0xfe, 0x80];
    fs::write(legacy.join("secrets.json"), opaque_ciphertext).unwrap();
    let application = Application::open_with_legacy(base.clone(), secrets.clone(), Some(legacy.clone())).unwrap();
    let status = application.call("migrationStatus", vec![]).unwrap();
    assert_eq!(status["legacyConfigImported"], true); assert_eq!(status["legacySecretsRequireReentry"], true);
    assert_eq!(status["legacySqlHistoryImported"], true); assert_eq!(status["legacySavedSqlImported"], true);
    let connections = application.call("listConnections", vec![]).unwrap();
    assert_eq!(connections[0]["id"], "c-legacy"); assert_eq!(connections[0]["connected"], false);
    assert_eq!(application.call("connectConnection", vec![json!("c-legacy")]).unwrap_err().code, "secret-reentry-required");
    let library = application.call("listSqlLibrary", vec![]).unwrap();
    assert_eq!(library["history"][0]["id"], "h1"); assert_eq!(library["saved"][0]["id"], "s1");
    assert!(base.join("connections-v2.json").exists()); assert!(base.join("sql-library-v2.json").exists());
    assert!(!base.join("secrets.json").exists()); assert!(!base.join("connections.json").exists());
    for (name, expected) in [("connections.json", &configs), ("sql-history.json", &history), ("saved-sql.json", &favorites)] {
        assert_eq!(fs::read(legacy.join(name)).unwrap(), *expected);
    }
    assert_eq!(fs::read(legacy.join("secrets.json")).unwrap(), opaque_ciphertext);
    application.close().unwrap();
    // Existing v2 data must win even if the old directory later becomes invalid or has new rows.
    fs::write(legacy.join("connections.json"), b"{\"schemaVersion\":999,\"connections\":[]}").unwrap();
    fs::write(legacy.join("saved-sql.json"), b"invalid-old-json-must-not-be-read").unwrap();
    let reopened = Application::open_with_legacy(base.clone(), secrets, Some(legacy)).unwrap();
    let status = reopened.call("migrationStatus", vec![]).unwrap();
    assert_eq!(status["legacyConfigImported"], false); assert_eq!(status["legacySqlHistoryImported"], false); assert_eq!(status["legacySavedSqlImported"], false);
    assert_eq!(reopened.call("listConnections", vec![]).unwrap(), connections);
    assert_eq!(reopened.call("listSqlLibrary", vec![]).unwrap(), library);
    reopened.close().unwrap();
}

#[test]
fn separate_legacy_future_schema_and_inline_secrets_are_rejected_without_new_v2() {
    for bad_config in [
        json!({"schemaVersion":999,"connections":[]}),
        json!({"schemaVersion":1,"connections":[{"id":"old","config":{"dialectId":"postgresql","name":"legacy","options":{"password":"synthetic-inline"}}}]}),
        json!({"schemaVersion":1,"connections":[{"id":"old","config":{"dialectId":"postgresql","name":"legacy","options":{},"rawSecret":"synthetic-inline"}}]})
    ] {
        let base = private_dir(); let legacy = private_dir(); let source = serde_json::to_vec(&bad_config).unwrap();
        fs::write(legacy.join("connections.json"), &source).unwrap();
        assert!(Application::open_with_legacy(base.clone(), Arc::new(FixtureSecrets::default()), Some(legacy.clone())).is_err());
        assert_eq!(fs::read(legacy.join("connections.json")).unwrap(), source);
        assert!(!base.join("connections-v2.json").exists());
    }
    let base = private_dir(); let legacy = private_dir(); let future = b"{\"schemaVersion\":999,\"connections\":[]}";
    fs::write(base.join("connections-v2.json"), future).unwrap();
    fs::write(legacy.join("connections.json"), b"{\"schemaVersion\":1,\"connections\":[]}").unwrap();
    assert!(Application::open_with_legacy(base.clone(), Arc::new(FixtureSecrets::default()), Some(legacy)).is_err());
    assert_eq!(fs::read(base.join("connections-v2.json")).unwrap(), future);
}

#[test]
fn explicit_legacy_library_rejects_unknown_fields_and_future_versions() {
    for invalid in [
        json!({"schemaVersion":999,"entries":[]}),
        json!({"schemaVersion":1,"entries":[{"id":"s1","name":"legacy","sql":"SELECT 1","updatedAt":1,"rawSecret":"synthetic-inline"}]})
    ] {
        let base = private_dir(); let legacy = private_dir(); let original = serde_json::to_vec(&invalid).unwrap();
        fs::write(legacy.join("saved-sql.json"), &original).unwrap();
        assert!(Application::open_with_legacy(base.clone(), Arc::new(FixtureSecrets::default()), Some(legacy.clone())).is_err());
        assert_eq!(fs::read(legacy.join("saved-sql.json")).unwrap(), original);
        assert!(!base.join("sql-library-v2.json").exists());
    }
}

#[test]
fn absent_explicit_legacy_directory_is_empty_and_none_never_discovers_other_directories() {
    let base = private_dir(); let legacy_parent = private_dir(); let absent = legacy_parent.join("does-not-exist");
    let application = Application::open_with_legacy(base.clone(), Arc::new(FixtureSecrets::default()), Some(absent.clone())).unwrap();
    assert_eq!(application.call("listConnections", vec![]).unwrap(), json!([]));
    assert_eq!(application.call("migrationStatus", vec![]).unwrap()["legacyConfigImported"], false);
    application.close().unwrap(); assert!(!absent.exists());
    let isolated = Application::open_with_legacy(private_dir(), Arc::new(FixtureSecrets::default()), None).unwrap();
    assert_eq!(isolated.call("listConnections", vec![]).unwrap(), json!([])); isolated.close().unwrap();
}

fn write_empty_native_v2(base: &PathBuf) {
    fs::write(base.join("connections-v2.json"), b"{\"schemaVersion\":2,\"connections\":[]}").unwrap();
    fs::write(base.join("sql-library-v2.json"), b"{\"schemaVersion\":2,\"library\":{\"history\":[],\"saved\":[]}}").unwrap();
}

#[test]
fn valid_native_v2_ignores_legacy_path_that_is_no_longer_a_directory() {
    let base = private_dir(); write_empty_native_v2(&base);
    let old_parent = private_dir(); let obsolete_path = old_parent.join("old-app-path");
    fs::write(&obsolete_path, b"not-a-directory").unwrap();
    let before_connections = fs::read(base.join("connections-v2.json")).unwrap();
    let before_library = fs::read(base.join("sql-library-v2.json")).unwrap();
    let application = Application::open_with_legacy(base.clone(), Arc::new(FixtureSecrets::default()), Some(obsolete_path.clone())).unwrap();
    assert_eq!(application.call("listConnections", vec![]).unwrap(), json!([]));
    assert_eq!(application.call("listSqlLibrary", vec![]).unwrap(), json!({"history":[],"saved":[]}));
    application.close().unwrap();
    assert_eq!(fs::read(base.join("connections-v2.json")).unwrap(), before_connections);
    assert_eq!(fs::read(base.join("sql-library-v2.json")).unwrap(), before_library);
    // A missing v2 file still requires a safe legacy directory; no fallback through a file.
    assert!(Application::open_with_legacy(private_dir(), Arc::new(FixtureSecrets::default()), Some(obsolete_path)).is_err());
}

#[cfg(unix)]
#[test]
fn valid_native_v2_ignores_legacy_symlink_but_actual_import_rejects_it() {
    use std::os::unix::fs::symlink;
    let base = private_dir(); write_empty_native_v2(&base);
    let old_parent = private_dir(); let old_target = private_dir();
    fs::write(old_target.join("connections.json"), b"{\"schemaVersion\":1,\"connections\":[]}").unwrap();
    let link = old_parent.join("old-app-link");
    assert!(link.is_absolute() && link.parent() == Some(old_parent.as_path()));
    symlink(&old_target, &link).unwrap();
    let application = Application::open_with_legacy(base, Arc::new(FixtureSecrets::default()), Some(link.clone())).unwrap();
    assert_eq!(application.call("listConnections", vec![]).unwrap(), json!([])); application.close().unwrap();
    let fallback_base = private_dir();
    assert!(Application::open_with_legacy(fallback_base.clone(), Arc::new(FixtureSecrets::default()), Some(link.clone())).is_err());
    assert!(!fallback_base.join("connections-v2.json").exists());
    // Independently exercise the SQL library fallback after a valid native connections file.
    let library_fallback = private_dir();
    fs::write(library_fallback.join("connections-v2.json"), b"{\"schemaVersion\":2,\"connections\":[]}").unwrap();
    assert!(Application::open_with_legacy(library_fallback.clone(), Arc::new(FixtureSecrets::default()), Some(link)).is_err());
    assert!(!library_fallback.join("sql-library-v2.json").exists());
}

#[test]
fn public_export_guard_allows_only_new_external_targets_and_protects_application_data() {
    let base = private_dir(); let output = private_dir();
    let application = app(&base, Arc::new(FixtureSecrets::default()));
    let destination = output.join("native-export.svg");
    application.validate_export_destination(&destination).unwrap();
    assert!(!destination.exists(), "validation must not create or reserve a file");
    let existing = output.join("existing.svg"); fs::write(&existing, b"existing-fixture").unwrap();
    assert_eq!(application.validate_export_destination(&existing).unwrap_err().code, "destination-exists");
    assert_eq!(fs::read(&existing).unwrap(), b"existing-fixture");
    assert!(application.validate_export_destination(std::path::Path::new("relative.svg")).is_err());
    let internal = base.join("not-yet-created.json");
    assert_eq!(application.validate_export_destination(&internal).unwrap_err().code, "application-data-path");
    assert!(!internal.exists());
    let nested = base.join("internal"); fs::create_dir(&nested).unwrap();
    assert_eq!(application.validate_export_destination(&nested.join("new.svg")).unwrap_err().code, "application-data-path");
    application.close().unwrap();
    assert_eq!(application.validate_export_destination(&destination).unwrap_err().code, "backend-unavailable");
}

#[test]
fn export_guard_conservatively_folds_case_and_normalization_for_saved_database_targets() {
    let base = private_dir(); let databases = private_dir();
    let application = app(&base, Arc::new(FixtureSecrets::default()));
    let foo = databases.join("Foo.sqlite"); fs::write(&foo, b"").unwrap();
    let foo_connection = application.call("addConnection", vec![json!({"dialectId":"sqlite","name":"case fixture","options":{"file":foo}})]).unwrap();
    assert_eq!(foo_connection["connected"], true);
    // Folding is deliberately conservative on case-sensitive volumes too, so this
    // deterministic check does not depend on whether the host volume ignores case.
    for name in ["foo.sqlite-wal", "FOO.SQLITE-JOURNAL", "Foo.SQLite-SHM"] {
        let destination = databases.join(name);
        assert!(!destination.exists());
        assert_eq!(application.validate_export_destination(&destination).unwrap_err().code, "database-path");
        assert!(!destination.exists());
    }
    let cafe = databases.join("Café.sqlite"); fs::write(&cafe, b"").unwrap();
    let cafe_connection = application.call("addConnection", vec![json!({"dialectId":"sqlite","name":"unicode fixture","options":{"file":cafe}})]).unwrap();
    assert_eq!(cafe_connection["connected"], true);
    for name in ["cafe\u{301}.sqlite-wal", "CAFÉ.SQLITE-WAL"] {
        let destination = databases.join(name);
        assert!(!destination.exists());
        assert_eq!(application.validate_export_destination(&destination).unwrap_err().code, "database-path");
        assert!(!destination.exists());
    }
    let safe = databases.join("ordinary-safe-export.csv");
    application.validate_export_destination(&safe).unwrap();
    assert!(!safe.exists());
    application.close().unwrap();
}

#[cfg(unix)]
#[test]
fn export_guard_fails_closed_for_non_utf8_destination_paths() {
    use std::os::unix::ffi::OsStringExt;
    let base = private_dir(); let output = private_dir();
    let application = app(&base, Arc::new(FixtureSecrets::default()));
    let destination = output.join(std::ffi::OsString::from_vec(b"invalid-\xff.svg".to_vec()));
    assert!(application.validate_export_destination(&destination).is_err());
    assert!(!destination.exists());
    application.close().unwrap();
}

#[cfg(unix)]
#[test]
fn public_export_guard_protects_saved_sqlite_real_sidecars_and_appdata_aliases() {
    use std::os::unix::fs::symlink;
    let base = private_dir(); let databases = private_dir(); let aliases = private_dir();
    let application = app(&base, Arc::new(FixtureSecrets::default()));
    let real_database = databases.join("fixture.sqlite"); fs::write(&real_database, b"").unwrap();
    let alias = aliases.join("saved-alias.sqlite");
    assert!(alias.is_absolute() && alias.parent() == Some(aliases.as_path()));
    symlink(&real_database, &alias).unwrap();
    let summary = application.call("addConnection", vec![json!({"dialectId":"sqlite","name":"fixture","options":{"file":alias}})]).unwrap();
    assert_eq!(summary["connected"], true);
    for file in [&real_database, &alias] {
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut sidecar = file.as_os_str().to_os_string(); sidecar.push(suffix);
            let destination = PathBuf::from(sidecar);
            assert!(!destination.exists());
            assert_eq!(application.validate_export_destination(&destination).unwrap_err().code, "database-path");
            assert!(!destination.exists());
        }
    }
    let data_alias = aliases.join("private-data-alias");
    assert!(data_alias.is_absolute() && data_alias.parent() == Some(aliases.as_path()));
    symlink(&base, &data_alias).unwrap();
    let internal = data_alias.join("new-v2-file.json");
    assert_eq!(application.validate_export_destination(&internal).unwrap_err().code, "application-data-path");
    assert!(!internal.exists());
    application.close().unwrap();
}

#[cfg(unix)]
#[test]
fn export_guard_follows_dangling_sidecar_targets_and_relative_link_chains() {
    use std::os::unix::fs::symlink;
    let base = private_dir(); let databases = private_dir(); let output = private_dir();
    let application = app(&base, Arc::new(FixtureSecrets::default()));
    let database = databases.join("dangling.sqlite"); fs::write(&database, b"").unwrap();
    let summary = application.call("addConnection", vec![json!({"dialectId":"sqlite","name":"dangling fixture","options":{"file":database}})]).unwrap();
    assert_eq!(summary["connected"], true);
    for (suffix, relative) in [("-wal", false), ("-shm", true), ("-journal", false)] {
        let sidecar = databases.join(format!("dangling.sqlite{suffix}"));
        let target = if relative { databases.join("relative-export-target") } else { output.join(format!("export{suffix}")) };
        assert!(sidecar.is_absolute() && sidecar.parent() == Some(databases.as_path()));
        assert!(fs::symlink_metadata(&sidecar).is_err() && fs::symlink_metadata(&target).is_err());
        if suffix == "-wal" {
            let intermediate = databases.join("wal-forward-link");
            assert!(fs::symlink_metadata(&intermediate).is_err());
            symlink(&target, &intermediate).unwrap();
            symlink("wal-forward-link", &sidecar).unwrap();
        } else if relative { symlink(target.file_name().unwrap(), &sidecar).unwrap(); }
        else { symlink(&target, &sidecar).unwrap(); }
        assert!(sidecar.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(application.validate_export_destination(&target).unwrap_err().code, "database-path");
        assert!(!target.exists(), "guard must not create a dangling sidecar target");
    }
    application.validate_export_destination(&output.join("unrelated-safe-export.svg")).unwrap();
    application.close().unwrap();
}
