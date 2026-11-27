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
            "runQuery" | "countRows" => {
                if args[0] == "BLOCK" || (method == "countRows" && args[0] == "table:fixture") {
                    if let Some(entered) = self.blocker.entered.lock().unwrap().take() { let _ = entered.send(()); }
                    let mut interrupted = self.blocker.interrupted.lock().unwrap();
                    while !*interrupted {
                        let next = self.blocker.changed.wait_timeout(interrupted, Duration::from_secs(5)).unwrap();
                        interrupted = next.0;
                        if next.1.timed_out() { return Err(AppError::new("timeout", "synthetic-private-target")) }
                    }
                    return Err(AppError::new("cancelled", "synthetic-sensitive-query"))
                }
                if method == "countRows" {
                    if args[0] == "table:error" { return Err(AppError::new("driver-error", "synthetic-private-count")) }
                    return Ok(json!(7))
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
fn count_rows_cancellation_is_scoped_and_optional_options_are_compatible() {
    for options in [None, Some(json!({})), Some(json!({"signalId":"count-only"}))] {
        let (app, blocker, entered) = fixture();
        let id = add(&app, "count"); let node = format!("connection:{id}");
        let mut args = vec![json!(format!("{node}|table:fixture"))];
        let scoped = options.as_ref().is_some_and(|value| value.get("signalId").is_some());
        if let Some(options) = options { args.push(options); }
        let running = app.clone();
        let count = thread::spawn(move || running.call("countRows", args));
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        let cancel_app = app.clone(); let cancel_node = node.clone();
        let (sent, received) = mpsc::channel();
        let cancellation = thread::spawn(move || {
            // Validation must fail even while COUNT owns the driver mutex.
            let invalid = cancel_app.call("countRows", vec![json!(format!("{cancel_node}|table:ready")), json!({"signalId":false})]);
            let wrong = cancel_app.call("cancelQuery", vec![json!(cancel_node), json!("wrong-count")]);
            let mut correct = vec![json!(cancel_node)];
            if scoped { correct.push(json!("count-only")); }
            let correct = cancel_app.call("cancelQuery", correct);
            let _ = sent.send((invalid, wrong, correct));
        });
        let outcome = received.recv_timeout(Duration::from_secs(2));
        *blocker.interrupted.lock().unwrap() = true; blocker.changed.notify_all();
        let (invalid, wrong, correct) = outcome.unwrap();
        assert_eq!(invalid.unwrap_err().code, "invalid-argument");
        assert_eq!(wrong.unwrap(), false); assert_eq!(correct.unwrap(), true);
        assert_eq!(count.join().unwrap().unwrap_err().code, "cancelled");
        cancellation.join().unwrap();
        assert_eq!(app.call("cancelQuery", vec![json!(node)]).unwrap(), false);
        assert_eq!(app.call("countRows", vec![json!(format!("{node}|table:ready"))]).unwrap(), 7);

        // The old COUNT signal must not interrupt a later active query.
        *blocker.interrupted.lock().unwrap() = false;
        let (sent, next_entered) = mpsc::channel();
        *blocker.entered.lock().unwrap() = Some(sent);
        let next_app = app.clone(); let next_node = node.clone();
        let next = thread::spawn(move || next_app.call("runQuery", vec![json!(next_node), json!("BLOCK"), json!({"signalId":"next-query"})]));
        next_entered.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(app.call("cancelQuery", vec![json!(node), json!("count-only")]).unwrap(), false);
        assert!(!*blocker.interrupted.lock().unwrap());
        assert_eq!(app.call("cancelQuery", vec![json!(node), json!("next-query")]).unwrap(), true);
        assert_eq!(next.join().unwrap().unwrap_err().code, "cancelled");
        app.close().unwrap();
    }
}

#[test]
fn count_rows_validates_arguments_and_forwards_optional_signal() {
    struct EchoCount;
    impl Driver for EchoCount {
        fn dialect_id(&self) -> &str { "sqlite" }
        fn capabilities(&self) -> Value { json!({}) }
        fn call(&mut self, method: &str, args: Vec<Value>) -> DriverResult<Value> {
            assert_eq!(method, "countRows"); Ok(json!(args))
        }
    }
    let app = Application::open_with_factory(base_dir(), Arc::new(MemorySecretStore::default()),
        Arc::new(|_, _| Ok(Box::new(EchoCount)))).unwrap();
    let id = add(&app, "count-arguments"); let node = format!("connection:{id}|table:fixture");
    for options in [None, Some(json!({})), Some(json!({"signalId":"count-123"}))] {
        let mut args = vec![json!(node)]; let mut expected = vec![json!("table:fixture")];
        if let Some(options) = options { args.push(options.clone()); expected.push(options); }
        assert_eq!(app.call("countRows", args).unwrap(), json!(expected));
    }
    for options in [json!(null), json!(true), json!(42), json!("signal"), json!([]),
        json!({"signalId":null}), json!({"signalId":false}), json!({"signalId":42}),
        json!({"signalId":[]}), json!({"signalId":{}}), json!({"signalId":""}), json!({"signalId":" \t\n"})] {
        assert_eq!(app.call("countRows", vec![json!(node), options]).unwrap_err().code, "invalid-argument");
    }
    for args in [vec![], vec![json!(null)], vec![json!(42)], vec![json!("")],
        vec![json!(format!("connection:{id}"))], vec![json!(format!("connection:{id}|folder:tables"))],
        vec![json!(node), json!({}), json!({"signalId":"extra"})]] {
        assert_eq!(app.call("countRows", args).unwrap_err().code, "invalid-argument");
    }
    assert_eq!(app.call("cancelQuery", vec![json!(format!("connection:{id}"))]).unwrap(), false);
    app.close().unwrap();
}

#[test]
fn count_rows_error_clears_running_signal() {
    let (app, blocker, _) = fixture(); let id = add(&app, "count-error"); let node = format!("connection:{id}");
    let error = app.call("countRows", vec![json!(format!("{node}|table:error")), json!({"signalId":"failed-count"})]).unwrap_err();
    assert_eq!(error.code, "driver-failed"); assert!(!error.message.contains("synthetic-private"));
    assert_eq!(app.call("cancelQuery", vec![json!(node), json!("failed-count")]).unwrap(), false);
    assert_eq!(app.call("cancelQuery", vec![json!(node)]).unwrap(), false);
    assert!(!*blocker.interrupted.lock().unwrap());
    assert_eq!(app.call("countRows", vec![json!(format!("{node}|table:ready")), json!({"signalId":"new-count"})]).unwrap(), 7);
    assert!(app.call("runQuery", vec![json!(node), json!("SELECT 1")]).is_ok());
    app.close().unwrap();
}

#[test]
fn next_query_waits_for_in_flight_cancellation_on_the_same_session() {
    struct DelayedCancelDriver {
        first_started: mpsc::Sender<()>,
        finish_first: mpsc::Receiver<()>,
        next_started: mpsc::Sender<()>,
        cancel: CancelHandle,
    }
    impl Driver for DelayedCancelDriver {
        fn dialect_id(&self) -> &str { "mysql" }
        fn capabilities(&self) -> Value { json!({"supportsCancel":true}) }
        fn cancel_handle(&self) -> CancelHandle { self.cancel.clone() }
        fn call(&mut self, _: &str, args: Vec<Value>) -> DriverResult<Value> {
            if args.last().unwrap()["signalId"] == "first" {
                self.first_started.send(()).unwrap();
                self.finish_first.recv_timeout(Duration::from_secs(5)).unwrap();
            } else {
                self.next_started.send(()).unwrap();
            }
            Ok(Value::Null)
        }
    }

    for first_method in ["runQuery", "countRows"] {
    let (first_started, wait_for_first) = mpsc::channel();
    let (finish_first, first_finished) = mpsc::channel();
    let (next_started, wait_for_next) = mpsc::channel();
    let (cancel_started, wait_for_cancel) = mpsc::channel();
    let (finish_cancel, cancel_finished) = mpsc::channel();
    let cancel_finished = Mutex::new(cancel_finished);
    let session = Session::new("fixture".into(), Box::new(DelayedCancelDriver {
        first_started,
        finish_first: first_finished,
        next_started,
        cancel: Arc::new(move || {
            cancel_started.send(()).unwrap();
            cancel_finished.lock().unwrap().recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(true)
        }),
    }));

    thread::scope(|scope| {
        let queries = scope.spawn(|| {
            session.call(first_method, vec![json!("table:fixture"), json!({"signalId":"first"})]).unwrap();
            session.call("runQuery", vec![json!({"signalId":"next"})]).unwrap();
        });
        wait_for_first.recv_timeout(Duration::from_secs(2)).unwrap();
        let cancellation = scope.spawn(|| session.cancel(Some("first")));
        wait_for_cancel.recv_timeout(Duration::from_secs(2)).unwrap();
        finish_first.send(()).unwrap();

        let next_while_cancelling = wait_for_next.recv_timeout(Duration::from_secs(1));
        finish_cancel.send(()).unwrap();
        assert!(cancellation.join().unwrap().unwrap());
        queries.join().unwrap();
        assert_eq!(next_while_cancelling, Err(mpsc::RecvTimeoutError::Timeout),
            "the next query reached the driver before the previous cancellation completed");
        wait_for_next.try_recv().unwrap();
    });
    }
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

#[test]
fn mysql_deadlock_error_redaction_is_exact_and_closed() {
    let exact = "MySQL操作失败(SQLSTATE 40001, code 1213)";
    let generic = "数据库操作失败，请检查连接或查询配置";
    let cases = [
        ("mysql", "driver-error", exact, "driver-error", exact),
        ("postgresql", "driver-error", exact, "driver-failed", generic),
        ("sqlite", "driver-error", exact, "driver-failed", generic),
        ("mariadb", "driver-error", exact, "driver-failed", generic),
        ("mysql", "network", exact, "driver-failed", generic),
        ("mysql", "driver-failed", exact, "driver-failed", generic),
        ("mysql", "unsupported", exact, "unsupported", "当前驱动不支持此操作"),
        ("mysql", "cancelled", exact, "cancelled", "操作已取消"),
        ("mysql", "driver-error", " MySQL操作失败(SQLSTATE 40001, code 1213)", "driver-failed", generic),
        ("mysql", "driver-error", "MySQL操作失败(SQLSTATE 40001, code 1213) ", "driver-failed", generic),
        ("mysql", "driver-error", "\nMySQL操作失败(SQLSTATE 40001, code 1213)", "driver-failed", generic),
        ("mysql", "driver-error", "MySQL操作失败(SQLSTATE 40001, code 1213)\n", "driver-failed", generic),
        ("mysql", "driver-error", "synthetic-query[MySQL操作失败(SQLSTATE 40001, code 1213)]synthetic-private", "driver-failed", generic),
        ("mysql", "driver-error", "MySQL操作失败(SQLSTATE 40001, code 1213) synthetic-private", "driver-failed", generic),
        ("mysql", "driver-error", "MySQL操作失败(SQLSTATE HY000, code 1213)", "driver-failed", generic),
        ("mysql", "driver-error", "MySQL操作失败(SQLSTATE 40001, code 1062)", "driver-failed", generic),
        ("mysql", "driver-error", "MySQL操作失败(SQLSTATE 23000, code 1062)", "driver-failed", generic),
        ("mysql", "driver-error", "MySQL操作失败(SQLSTATE HY000, code 1205)", "driver-failed", generic),
        ("mysql", "driver-error", "MySQL操作失败(SQLSTATE 42S22, code 1054)", "driver-failed", generic),
    ];
    for (dialect, code, message, expected_code, expected_message) in cases {
        let actual = safe_driver_error(dialect, AppError::new(code, message));
        assert_eq!(actual.code, expected_code); assert_eq!(actual.message, expected_message);
    }
    let unchanged_default = safe_error(AppError::new("driver-error", exact));
    assert_eq!(unchanged_default.code, "driver-failed"); assert_eq!(unchanged_default.message, generic);
}
#[test]
fn mysql_deadlock_error_redaction_binds_actual_session_driver() {
    struct ErrorDriver { dialect: &'static str }
    impl Driver for ErrorDriver {
        fn dialect_id(&self) -> &str { self.dialect }
        fn capabilities(&self) -> Value { json!({}) }
        fn cancel_handle(&self) -> CancelHandle { Arc::new(|| Ok(false)) }
        fn call(&mut self, _: &str, _: Vec<Value>) -> DriverResult<Value> {
            Err(AppError::new("driver-error", "MySQL操作失败(SQLSTATE 40001, code 1213)"))
        }
        fn disconnect(&mut self) -> DriverResult<()> { Ok(()) }
    }
    let (app, _, _) = fixture();
    let id = Uuid::new_v4().to_string();
    for dialect in ["mysql", "postgresql", "sqlite"] {
        let session = Session::new(id.clone(), Box::new(ErrorDriver { dialect }));
        lock(&app.state).unwrap().sessions.insert(id.clone(), session);
        // A claimed SQL/argument dialect must not override the actual Session driver dialect.
        let claimed = if dialect == "mysql" { "sqlite" } else { "mysql" };
        let actual = app.driver_call(&format!("connection:{id}"), "applyEdits", vec![json!({"dialectId":claimed})]).unwrap_err();
        if dialect == "mysql" {
            assert_eq!(actual.code, "driver-error"); assert_eq!(actual.message, "MySQL操作失败(SQLSTATE 40001, code 1213)");
        } else {
            assert_eq!(actual.code, "driver-failed"); assert_eq!(actual.message, "数据库操作失败，请检查连接或查询配置");
        }
    }
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

#[test]
fn node_id_parsing_accepts_connection_and_scoped_forms() {
    // 裸连接 id：没有作用域后缀，也不是 connection: 前缀形式。
    assert_eq!(parse_node_or_connection("c-1").unwrap(), ("c-1", None));
    // scoped 形式必须带 | 分开的节点路径。
    assert_eq!(parse_node_or_connection("connection:c-1").unwrap(), ("c-1", None));
    assert_eq!(parse_node_or_connection("connection:c-1|table:testdb.t").unwrap(),
        ("c-1", Some("table:testdb.t")));
}

#[test]
fn node_id_parsing_rejects_ambiguous_and_empty_forms() {
    // 含 | 但不带 connection: 前缀时无法判定作用域，必须拒绝。
    assert!(parse_node_or_connection("c-1|table:t").is_err());
    assert_eq!(parse_node_or_connection("").unwrap_err().code, "invalid-argument");
    // 空连接 id 与空作用域都无效。
    assert!(parse_node_or_connection("connection:").is_err());
    assert!(parse_node_or_connection("connection:|table:t").is_err());
    assert!(parse_node_or_connection("connection:c-1|").is_err());
}

#[test]
fn node_id_parsing_keeps_escaped_dots_inside_scope() {
    // 节点路径里的转义点不能被当成作用域分隔符。
    let (connection, scope) = parse_node_or_connection("connection:c-1|table:testdb.a\\.b").unwrap();
    assert_eq!(connection, "c-1");
    assert_eq!(scope, Some("table:testdb.a\\.b"));
}
