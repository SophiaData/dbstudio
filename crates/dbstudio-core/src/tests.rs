use super::*;
use dbstudio_protocol::{CancelHandle, DriverResult};
use std::{sync::{atomic::{AtomicBool, Ordering}, mpsc, Condvar}, thread, time::Duration};

struct Blocker { entered: Mutex<Option<mpsc::Sender<()>>>, interrupted: Mutex<bool>, changed: Condvar }
struct FixtureDriver { dialect: String, blocker: Arc<Blocker> }
impl Driver for FixtureDriver {
    fn dialect_id(&self) -> &str { &self.dialect }
    fn capabilities(&self) -> Value { json!({"supportsInlineEdit":true,"supportsServerPagination":true,"supportsCancel":true,"hasCatalog":false,"hasSchema":false}) }
    fn cancel_handle(&self) -> CancelHandle {
        let blocker = self.blocker.clone();
        Arc::new(move || { *blocker.interrupted.lock().unwrap() = true; blocker.changed.notify_all(); Ok(true) })
    }
    fn call(&mut self, method: &str, args: Vec<Value>) -> DriverResult<Value> {
        match method {
            "runQuery" => {
                if args[0] == "BLOCK" {
                    if let Some(entered) = self.blocker.entered.lock().unwrap().take() { let _ = entered.send(()); }
                    let mut interrupted = self.blocker.interrupted.lock().unwrap();
                    while !*interrupted {
                        let next = self.blocker.changed.wait_timeout(interrupted, Duration::from_secs(5)).unwrap();
                        interrupted = next.0;
                        if next.1.timed_out() { return Err(AppError::new("timeout", "synthetic-private-target")) }
                    }
                    return Err(AppError::new("cancelled", "synthetic-sensitive-query"))
                }
                Ok(json!({"cursorId":"raw-native-cursor","columns":[],"rows":[],"offset":0,"returned":0,"hasMore":false,"executedSql":"SELECT 1","elapsedMs":0}))
            },
            "listChildren" => Ok(json!([{"id":"table:fixture","parentId":null,"kind":"table","name":"fixture","hasChildren":true}])),
            "fetchResultPage" => Ok(json!({"columns":[],"rows":[],"offset":args[1],"returned":0,"hasMore":false})),
            "closeCursor" => Ok(Value::Null),
            "transactionState" | "rollbackTransaction" | "commitTransaction" => Ok(json!({"active":false,"pendingAffected":0})),
            _ => Err(AppError::unsupported("synthetic-sensitive-driver-detail")),
        }
    }
}
fn base_dir() -> PathBuf {
    let path = std::env::temp_dir().join(format!("dbstudio-native-state-test-{}", Uuid::new_v4()));
    let mut builder = std::fs::DirBuilder::new(); builder.recursive(true);
    #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    builder.create(&path).unwrap(); path
}
fn fixture() -> (Arc<Application>, Arc<Blocker>, mpsc::Receiver<()>) {
    let (entered, received) = mpsc::channel();
    let blocker = Arc::new(Blocker { entered:Mutex::new(Some(entered)),interrupted:Mutex::new(false),changed:Condvar::new() });
    let control = blocker.clone();
    let app = Application::open_with_factory(base_dir(), Arc::new(MemorySecretStore::default()), Arc::new(move |config, _| {
        Ok(Box::new(FixtureDriver { dialect:config.dialect_id.clone(), blocker:control.clone() }))
    })).unwrap();
    (Arc::new(app), blocker, received)
}
fn add(app: &Application, name: &str) -> String {
    let summary = app.call("addConnection", vec![json!({"dialectId":"sqlite","name":name,"options":{"file":"synthetic"}})]).unwrap();
    assert_eq!(summary["connected"], true); summary["id"].as_str().unwrap().to_owned()
}

#[test]
fn application_is_send_sync_and_cancel_does_not_wait_for_query_mutex() {
    fn send_sync<T: Send + Sync>() {} send_sync::<Application>();
    let (app, blocker, entered) = fixture(); let a = add(&app, "a"); let b = add(&app, "b");
    let node = format!("connection:{a}"); let running = app.clone(); let query_node = node.clone();
    let query = thread::spawn(move || running.call("runQuery", vec![json!(query_node),json!("BLOCK"),json!({"signalId":"only-this-query"})]));
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    // A second connection can resolve and call its driver while A is blocked.
    let other = app.clone(); let (sent, received) = mpsc::channel();
    let metadata = thread::spawn(move || { let result = other.call("listChildren", vec![json!(format!("connection:{b}"))]); let _ = sent.send(result); });
    let metadata_result = received.recv_timeout(Duration::from_secs(2));
    let cancel_app = app.clone(); let (sent, received) = mpsc::channel();
    let cancel = thread::spawn(move || {
        let wrong = cancel_app.call("cancelQuery", vec![json!(node),json!("different-signal")]);
        let correct = cancel_app.call("cancelQuery", vec![json!(node),json!("only-this-query")]);
        let _ = sent.send((wrong, correct));
    });
    let cancellation = received.recv_timeout(Duration::from_secs(2));
    // Release the fixture even when an assertion would fail, so no test worker remains blocked.
    *blocker.interrupted.lock().unwrap() = true; blocker.changed.notify_all();
    assert!(metadata_result.unwrap().is_ok());
    let (wrong, correct) = cancellation.unwrap(); assert_eq!(wrong.unwrap(), false); assert_eq!(correct.unwrap(), true);
    assert_eq!(query.join().unwrap().unwrap_err().code, "cancelled");
    metadata.join().unwrap(); cancel.join().unwrap(); app.close().unwrap();
}

#[test]
fn disconnect_invalidates_result_and_native_cursor_generation() {
    let (app, blocker, entered) = fixture(); let id = add(&app, "a"); let node = format!("connection:{id}");
    let query = app.call("runQuery", vec![json!(node),json!("SELECT 1")]).unwrap();
    let old_cursor = query["cursorId"].clone();
    let running = app.clone(); let query_node = node.clone();
    let worker = thread::spawn(move || running.call("runQuery", vec![json!(query_node),json!("BLOCK")]));
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    let disconnecting = app.clone(); let disconnect_id = id.clone();
    let disconnector = thread::spawn(move || disconnecting.call("disconnectConnection", vec![json!(disconnect_id)]));
    let result = worker.join().unwrap();
    *blocker.interrupted.lock().unwrap() = true; blocker.changed.notify_all();
    assert_eq!(result.unwrap_err().code, "not-found");
    assert_eq!(disconnector.join().unwrap().unwrap()["connected"], false);
    app.call("connectConnection", vec![json!(id)]).unwrap();
    assert_eq!(app.call("fetchResultPage", vec![old_cursor,json!(0),json!(5)]).unwrap_err().code, "not-found");
    app.close().unwrap();
}

struct UnavailableSecrets;
impl SecretStore for UnavailableSecrets {
    fn get(&self, _: &str) -> Result<Option<SecretMap>, AppError> { Err(AppError::new("secret-storage-unavailable", "synthetic-secret-provider-detail")) }
    fn set(&self, _: &str, _: &SecretMap) -> Result<(), AppError> { Err(AppError::new("secret-storage-unavailable", "synthetic-secret-provider-detail")) }
    fn remove(&self, _: &str) -> Result<(), AppError> { Err(AppError::new("secret-storage-unavailable", "synthetic-secret-provider-detail")) }
}
#[test]
fn unavailable_os_store_keeps_temporary_secret_only_in_memory() {
    let base = base_dir(); let saw_secret = Arc::new(AtomicBool::new(false)); let captured = saw_secret.clone();
    let app = Application::open_with_factory(base.clone(), Arc::new(UnavailableSecrets), Arc::new(move |_, secret| {
        captured.store(secret.get("dbPassword").and_then(Value::as_str) == Some("synthetic-temporary"), Ordering::Release);
        Err(AppError::new("network", "synthetic-sensitive-connection-detail"))
    })).unwrap();
    let summary = app.call("addConnection", vec![json!({"dialectId":"postgresql","name":"fixture","options":{"host":"fixture.invalid","port":5432}}),json!({"dbPassword":"synthetic-temporary"})]).unwrap();
    assert!(saw_secret.load(Ordering::Acquire)); assert_eq!(summary["connected"], false); assert_eq!(summary["persisted"], true); assert_eq!(summary["secretStored"], false);
    let persisted = std::fs::read_to_string(base.join("connections-v2.json")).unwrap();
    assert!(!persisted.contains("synthetic-temporary") && !persisted.contains("synthetic-secret-provider-detail"));
    assert!(!serde_json::to_string(&summary).unwrap().contains("synthetic-secret-provider-detail"));
    app.close().unwrap();
}

#[test]
fn failed_config_commit_keeps_old_vault_key_and_cleans_staged_credentials() {
    let (app, _, _) = fixture();
    let summary = app.call("addConnection", vec![json!({"dialectId":"postgresql","name":"fixture","options":{"host":"fixture.invalid","port":5432}}),json!({"dbPassword":"synthetic-original","sshPassword":"synthetic-ssh"})]).unwrap();
    let id = summary["id"].as_str().unwrap();
    let old_key = lock(&app.state).unwrap().connections.iter().find(|item| item.id == id).unwrap().secret_key.clone();
    let old_secret = app.secrets.get(&old_key).unwrap();
    let original = std::fs::read(app.base_dir.join("connections-v2.json")).unwrap();
    let oversized = "x".repeat(8 * 1024 * 1024);
    let error = app.call("updateConnection", vec![json!(id),json!({"options":{"database":oversized}}),json!({"dbPassword":"synthetic-new"})]).unwrap_err();
    assert_eq!(error.code, "resource-limit");
    assert_eq!(app.secrets.get(&old_key).unwrap(), old_secret);
    assert_eq!(std::fs::read(app.base_dir.join("connections-v2.json")).unwrap(), original);
    assert_eq!(lock(&app.state).unwrap().connections[0].secret_key, old_key);
    app.call("updateConnection", vec![json!(id),json!({"name":"updated"}),json!({"dbPassword":"synthetic-new"})]).unwrap();
    let new_key = lock(&app.state).unwrap().connections[0].secret_key.clone();
    assert_ne!(old_key, new_key); assert!(app.secrets.get(&old_key).unwrap().is_none());
    assert_eq!(app.secrets.get(&new_key).unwrap().unwrap().get("sshPassword"), Some(&json!("synthetic-ssh")));
    app.close().unwrap();
}

#[test]
fn failed_delete_commit_preserves_vault_and_saved_connection() {
    let (app, _, _) = fixture();
    let summary = app.call("addConnection", vec![json!({"dialectId":"postgresql","name":"fixture","options":{"host":"fixture.invalid","port":5432}}),json!({"dbPassword":"synthetic-original"})]).unwrap();
    let id = summary["id"].as_str().unwrap();
    let key = lock(&app.state).unwrap().connections[0].secret_key.clone();
    let config = app.base_dir.join("connections-v2.json");
    let backup = app.base_dir.join("connections-fixture-backup.json");
    let blocked = app.base_dir.join("blocked-config-fixture");
    // All rename targets are checked private fixture children; nothing is deleted.
    assert!(config.is_absolute() && backup.parent() == Some(app.base_dir.as_path()) && blocked.parent() == Some(app.base_dir.as_path()));
    std::fs::rename(&config, &backup).unwrap(); std::fs::create_dir(&config).unwrap();
    let result = app.call("removeConnection", vec![json!(id)]);
    assert!(result.is_err()); assert!(app.secrets.get(&key).unwrap().is_some());
    assert_eq!(lock(&app.state).unwrap().connections.len(), 1);
    std::fs::rename(&config, &blocked).unwrap(); std::fs::rename(&backup, &config).unwrap();
    app.close().unwrap();
}

struct ReadFailureSecrets { values: Mutex<HashMap<String, SecretMap>>, fail: AtomicBool }
impl SecretStore for ReadFailureSecrets {
    fn get(&self, key: &str) -> Result<Option<SecretMap>, AppError> {
        if self.fail.load(Ordering::Acquire) { return Err(AppError::new("secret-storage-unavailable", "synthetic-private-provider-error")) }
        Ok(self.values.lock().unwrap().get(key).cloned())
    }
    fn set(&self, key: &str, secret: &SecretMap) -> Result<(), AppError> { self.values.lock().unwrap().insert(key.into(), secret.clone()); Ok(()) }
    fn remove(&self, key: &str) -> Result<(), AppError> { self.values.lock().unwrap().remove(key); Ok(()) }
}
#[test]
fn partial_secret_update_does_not_treat_vault_read_failure_as_empty() {
    let secrets = Arc::new(ReadFailureSecrets { values:Mutex::new(HashMap::new()), fail:AtomicBool::new(false) });
    let app = Application::open_with_factory(base_dir(), secrets.clone(), Arc::new(|_, _| Err(AppError::new("network", "synthetic-private")))).unwrap();
    let summary = app.call("addConnection", vec![json!({"dialectId":"postgresql","name":"fixture","options":{"host":"fixture.invalid","port":5432}}),json!({"dbPassword":"synthetic-original","sshPassword":"synthetic-ssh"})]).unwrap();
    let id = summary["id"].as_str().unwrap();
    lock(&app.state).unwrap().temporary_secrets.clear();
    let before = secrets.values.lock().unwrap().clone(); secrets.fail.store(true, Ordering::Release);
    let error = app.call("updateConnection", vec![json!(id),json!({}),json!({"sshPassword":"synthetic-new"})]).unwrap_err();
    assert_eq!(error.code, "secret-storage-unavailable"); assert!(!error.message.contains("synthetic-private"));
    assert_eq!(*secrets.values.lock().unwrap(), before); app.close().unwrap();
}
