//! Dedicated synthetic SQL TLS/SSH acceptance. Never targets a user database.
//! Only scripts/native-sql-secure-fixture.mjs supplies the guarded environment.
//! Each test is exact/ignored so a passing plain suite cannot imply secure acceptance.
use dbstudio_protocol::{ConnectionConfig, Driver, DriverError, DriverResult, SecretMap};
use serde_json::{json, Value};
use std::{env, path::{Path, PathBuf}, sync::mpsc, thread, time::{Duration, Instant}};

const PREFIX: &str = "DBSTUDIO_NATIVE_SECURE_";
fn setting(name: &str) -> String {
    env::var(format!("{PREFIX}{name}")).expect("dedicated secure fixture environment is required")
}
fn positive_port(name: &str) -> u16 {
    let port = setting(name).parse::<u16>().expect("dedicated fixture port must be valid");
    assert!(port > 0, "dedicated fixture port must be positive");
    port
}
struct Fixture {
    run_id: String,
    database: String,
    user: String,
    password: String,
    ssh_user: String,
    ssh_password: String,
    ssh_pin: String,
    ca: String,
    wrong_ca: String,
}
impl Fixture {
    fn load() -> Self {
        let run_id = setting("RUN_ID");
        assert!(run_id.len() == 32 && run_id.bytes().all(|c| c.is_ascii_hexdigit()), "fixture run id invalid");
        assert!(setting("ENABLED") == run_id, "fixture invocation guard missing");
        let expected = format!("native_secure_{}", &run_id[..16]);
        assert!(setting("DATABASE") == expected, "only the dedicated synthetic database is allowed");
        let user = format!("fx_{}", &run_id[..12]);
        assert!(setting("USER") == user, "only the synthetic fixture user is allowed");
        let ssh_user = format!("sx_{}", &run_id[..12]);
        assert!(setting("SSH_USER") == ssh_user, "only the synthetic SSH user is allowed");
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("workspace path required");
        let directory = workspace.join("backups").join(format!("native-sql-secure-{run_id}"));
        assert!(PathBuf::from(setting("DIR")) == directory, "fixture path must be this run's dedicated evidence directory");
        let ca = directory.join("tls/ca.crt");
        let wrong_ca = directory.join("tls/wrong-ca.crt");
        for (key, path) in [("CA_FILE", &ca), ("WRONG_CA_FILE", &wrong_ca)] {
            assert!(PathBuf::from(setting(key)) == *path, "only generated fixture certificate paths are allowed");
            let metadata = path.symlink_metadata().expect("fixture public certificate required");
            assert!(metadata.is_file() && !metadata.file_type().is_symlink(), "fixture certificate must be a regular file");
        }
        let password = setting("PASSWORD");
        let ssh_password = setting("SSH_PASSWORD");
        assert!(password.len() == 64 && password.bytes().all(|c| c.is_ascii_hexdigit()), "fixture password format invalid");
        assert!(ssh_password.len() == 64 && ssh_password.bytes().all(|c| c.is_ascii_hexdigit()), "SSH fixture password format invalid");
        let ssh_pin = setting("SSH_PIN");
        assert!(ssh_pin.starts_with("SHA256:") && ssh_pin.len() == 50, "explicit synthetic host key pin is required");
        Self { run_id, database: expected, user, password, ssh_user, ssh_password, ssh_pin,
            ca: ca.to_string_lossy().into_owned(), wrong_ca: wrong_ca.to_string_lossy().into_owned() }
    }
    fn config(&self, dialect: &str, ssh: bool) -> (ConnectionConfig, SecretMap) {
        let pg = dialect == "postgresql";
        let host = if ssh { if pg { "pg-tls" } else { "mysql-ssh" } } else { "127.0.0.1" };
        let port = if ssh { if pg { 5432 } else { 3306 } } else { positive_port(if pg { "PG_TLS_PORT" } else { "MYSQL_TLS_PORT" }) };
        let mut options = json!({"host":host,"port":port,"database":self.database,"user":self.user,
            "sslmode":if ssh && !pg { "disable" } else { "verify-full" },"sslrootcert":self.ca});
        let mut secrets = SecretMap::new();
        secrets.insert("dbPassword".into(), json!(self.password));
        if ssh {
            options["sshHost"] = json!("127.0.0.1");
            options["sshPort"] = json!(positive_port("SSH_PORT"));
            options["sshUser"] = json!(self.ssh_user);
            options["sshHostKeySha256"] = json!(self.ssh_pin);
            secrets.insert("sshPassword".into(), json!(self.ssh_password));
        }
        let config = serde_json::from_value(json!({"dialectId":dialect,"name":"dedicated secure native fixture","options":options})).expect("static fixture config is valid");
        (config, secrets)
    }
    fn safe_error(&self, error: &DriverError) {
        assert!(!error.message.contains(&self.password) && !error.message.contains(&self.ssh_password), "driver error must not expose fixture credentials");
    }
}
fn connect(fixture: &Fixture, config: &ConnectionConfig, secrets: &SecretMap) -> Box<dyn Driver> {
    dbstudio_drivers::connect(config, secrets).unwrap_or_else(|error| {
        fixture.safe_error(&error);
        panic!("secure native connection failed with code {}", error.code)
    })
}
fn rejected(fixture: &Fixture, config: &ConnectionConfig, secrets: &SecretMap, codes: &[&str]) {
    match dbstudio_drivers::connect(config, secrets) {
        Ok(mut driver) => { let _ = driver.disconnect(); panic!("invalid secure connection unexpectedly succeeded"); },
        Err(error) => {
            fixture.safe_error(&error);
            assert!(codes.contains(&error.code.as_str()), "negative secure case returned an unexpected safe error code");
        }
    }
}
fn call(driver: &mut dyn Driver, method: &str, args: Vec<Value>) -> Value {
    driver.call(method, args).unwrap_or_else(|error| panic!("native secure {method} failed with code {}", error.code))
}
fn scalar(cell: &Value) -> Value {
    match cell["kind"].as_str() {
        Some("number") | Some("boolean") => cell["value"].clone(),
        Some("text") => cell["text"].clone(),
        _ => Value::Null,
    }
}
fn exact_small_integer(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse().ok())).or_else(|| {
        value.as_f64().filter(|number| number.is_finite() && *number >= 0.0 && *number <= 9_007_199_254_740_991.0 && number.fract() == 0.0).map(|number| number as u64)
    })
}
fn query_scalar(driver: &mut dyn Driver, sql: &str, column: usize) -> Value {
    let result = call(driver, "runQuery", vec![json!(sql), json!({"keepCursor":false,"limit":1})]);
    scalar(&result["rows"][0]["cells"][column])
}
fn assert_transport(driver: &mut dyn Driver, pg: bool, tls: bool) {
    if pg {
        assert_eq!(query_scalar(driver, "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()", 0), json!(tls), "server must attest this connection uses TLS");
    } else {
        let cipher = query_scalar(driver, "SELECT VARIABLE_VALUE FROM performance_schema.session_status WHERE VARIABLE_NAME='Ssl_cipher'", 0);
        let cipher = cipher.as_str().expect("MySQL TLS cipher status must be text");
        assert_eq!(!cipher.is_empty(), tls, "MySQL must attest the expected TLS state");
        let required = query_scalar(driver, "SELECT @@global.require_secure_transport", 0);
        assert!(matches!(required, Value::Number(_) | Value::Bool(_)), "secure transport policy must be readable");
        assert_eq!(exact_small_integer(&required) == Some(1) || required == json!(true), tls, "direct TLS fixture and SSH-only fixture have separate policies");
    }
}
fn transaction_smoke(fixture: &Fixture, driver: &mut dyn Driver, pg: bool, ssh: bool) {
    let name = format!("secure_{}_{}_{}", if pg { "pg" } else { "mysql" }, if ssh { "ssh" } else { "tls" }, &fixture.run_id[..12]);
    let schema = if pg { "public" } else { fixture.database.as_str() };
    let raw = format!("table:{schema}.{name}");
    call(driver, "createTable", vec![json!({"name":format!("{schema}.{name}"),"columns":[
        {"name":"id","typeName":"INTEGER","primaryKeyOrdinal":1}, {"name":"note","typeName":"VARCHAR(64)"}
    ]})]);
    call(driver, "insertRow", vec![json!(raw), json!({"id":{"kind":"number","value":1},"note":{"kind":"text","text":"secure fixture only"}})]);
    assert_eq!(call(driver, "transactionState", vec![])["active"], true);
    call(driver, "rollbackTransaction", vec![]);
    assert_eq!(call(driver, "countRows", vec![json!(raw)]), 0);
    // SQL objects, data directories and containers are retained as run evidence.
}
fn cancellation(fixture: &Fixture, config: &ConnectionConfig, secrets: &SecretMap, pg: bool) {
    let mut driver = connect(fixture, config, secrets);
    assert_eq!(driver.capabilities()["supportsCancel"], true);
    let identity = query_scalar(driver.as_mut(), if pg { "SELECT pg_backend_pid()" } else { "SELECT CONNECTION_ID()" }, 0);
    let identity = exact_small_integer(&identity).expect("server connection identity must be an exact small integer");
    let cancel = driver.cancel_handle();
    let (start_tx, start_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        let _ = start_tx.send(());
        let sql = if pg { "SELECT 1 AS value FROM pg_sleep(20)" } else { "SELECT SLEEP(20) AS value" };
        let result: DriverResult<Value> = driver.call("runQuery", vec![json!(sql),json!({"keepCursor":false})]);
        let _ = driver.disconnect();
        let _ = finish_tx.send(result);
    });
    start_rx.recv_timeout(Duration::from_secs(2)).expect("native secure worker must start");
    let started = Instant::now();
    // Observe the actual server operation before cancelling. A client running flag alone
    // can race the first query packet, especially when cancellation opens a TLS channel.
    let mut observer = connect(fixture, config, secrets);
    let observe_sql = if pg {
        format!("SELECT COUNT(*)::integer FROM pg_stat_activity WHERE pid={identity} AND state='active' AND query LIKE '%pg_sleep(20)%'")
    } else {
        format!("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID={identity} AND COMMAND IN ('Query','Execute') AND INFO LIKE '%SLEEP(20)%'")
    };
    let mut observed = false;
    while started.elapsed() < Duration::from_secs(4) {
        let count = query_scalar(observer.as_mut(), &observe_sql, 0);
        if exact_small_integer(&count) == Some(1) { observed = true; break; }
        thread::sleep(Duration::from_millis(25));
    }
    observer.disconnect().expect("secure observer disconnect must succeed");
    drop(observer);
    let mut requested = false;
    let mut request_failed = false;
    while observed && started.elapsed() < Duration::from_secs(8) {
        match cancel() {
            Ok(true) => { requested = true; break; },
            Ok(false) => thread::sleep(Duration::from_millis(25)),
            Err(error) => { fixture.safe_error(&error); request_failed = true; break; },
        }
    }
    let outcome = finish_rx.recv_timeout(Duration::from_secs(25)).expect("secure query worker exceeded bounded fixture deadline");
    worker.join().expect("secure query worker must not panic");
    assert!(observed, "server must attest the long operation was running before cancellation");
    assert!(!request_failed && requested, "independent native cancel channel must reach the running query");
    match outcome {
        Err(error) => { fixture.safe_error(&error); assert_eq!(error.code, "cancelled"); },
        Ok(value) => {
            assert!(!pg, "PostgreSQL cancelled query must report cancelled");
            assert_eq!(exact_small_integer(&scalar(&value["rows"][0]["cells"][0])), Some(1), "MySQL SLEEP must attest interruption");
        }
    }
    assert!(started.elapsed() < Duration::from_secs(15), "cancel must finish before the 20-second query");
}
fn direct_tls(pg: bool) {
    let fixture = Fixture::load();
    let (config, secrets) = fixture.config(if pg { "postgresql" } else { "mysql" }, false);
    println!("NATIVE_SECURE_STAGE=positive_connect");
    let mut driver = connect(&fixture, &config, &secrets);
    println!("NATIVE_SECURE_STAGE=transport_attestation");
    assert_transport(driver.as_mut(), pg, true);
    println!("NATIVE_SECURE_STAGE=transaction");
    transaction_smoke(&fixture, driver.as_mut(), pg, false);
    driver.disconnect().expect("secure fixture disconnect must succeed");
    println!("NATIVE_SECURE_STAGE=wrong_ca");
    let mut wrong_ca = config.clone(); wrong_ca.options.insert("sslrootcert".into(),json!(fixture.wrong_ca));
    rejected(&fixture, &wrong_ca, &secrets, &["connection_failed"]);
    println!("NATIVE_SECURE_STAGE=system_roots");
    let mut system_roots = config.clone(); system_roots.options.remove("sslrootcert");
    rejected(&fixture, &system_roots, &secrets, &["connection_failed"]);
    // Same endpoint with a reachable name deliberately absent from the trusted certificate.
    // A require control proves that DNS/IPv6/forwarding failure cannot make this negative pass.
    let mut wrong_name = config.clone(); wrong_name.options.insert("host".into(), json!("localhost"));
    let mut reachable = wrong_name.clone(); reachable.options.insert("sslmode".into(), json!("require"));
    println!("NATIVE_SECURE_STAGE=hostname_reachability");
    let mut control = connect(&fixture, &reachable, &secrets);
    assert_transport(control.as_mut(), pg, true);
    control.disconnect().expect("hostname control disconnect must succeed");
    println!("NATIVE_SECURE_STAGE=hostname_rejection");
    rejected(&fixture, &wrong_name, &secrets, &["connection_failed"]);
    println!("NATIVE_SECURE_STAGE=cancellation");
    cancellation(&fixture, &config, &secrets, pg);
}
fn pinned_ssh(pg: bool) {
    let fixture = Fixture::load();
    let (config, secrets) = fixture.config(if pg { "postgresql" } else { "mysql" }, true);
    println!("NATIVE_SECURE_STAGE=missing_pin");
    let mut missing_pin = config.clone(); missing_pin.options.remove("sshHostKeySha256");
    rejected(&fixture, &missing_pin, &secrets, &["ssh_host_key_required"]);
    println!("NATIVE_SECURE_STAGE=wrong_pin");
    let mut wrong_pin = config.clone(); wrong_pin.options.insert("sshHostKeySha256".into(), json!("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    rejected(&fixture, &wrong_pin, &secrets, &["ssh_host_key_mismatch"]);
    println!("NATIVE_SECURE_STAGE=positive_connect");
    let mut driver = connect(&fixture, &config, &secrets);
    println!("NATIVE_SECURE_STAGE=transport_attestation");
    assert_transport(driver.as_mut(), pg, pg);
    println!("NATIVE_SECURE_STAGE=transaction");
    transaction_smoke(&fixture, driver.as_mut(), pg, true);
    driver.disconnect().expect("SSH fixture disconnect must succeed");
    if pg {
        println!("NATIVE_SECURE_STAGE=wrong_ca");
        let mut wrong_ca = config.clone(); wrong_ca.options.insert("sslrootcert".into(), json!(fixture.wrong_ca));
        rejected(&fixture, &wrong_ca, &secrets, &["connection_failed"]);
        let mut wrong_name = config.clone(); wrong_name.options.insert("host".into(), json!("pg-wrong-name"));
        let mut reachable = wrong_name.clone(); reachable.options.insert("sslmode".into(), json!("require"));
        println!("NATIVE_SECURE_STAGE=hostname_reachability");
        let mut control = connect(&fixture, &reachable, &secrets);
        assert_transport(control.as_mut(), true, true);
        control.disconnect().expect("SSH hostname control disconnect must succeed");
        println!("NATIVE_SECURE_STAGE=hostname_rejection");
        rejected(&fixture, &wrong_name, &secrets, &["connection_failed"]);
    }
    if !pg {
        // This is an explicit limitation assertion, not a TLS success or downgrade.
        let mut combined = config.clone(); combined.options.insert("sslmode".into(),json!("verify-full"));
        rejected(&fixture, &combined, &secrets, &["unsupported"]);
    }
    println!("NATIVE_SECURE_STAGE=cancellation");
    cancellation(&fixture, &config, &secrets, pg);
}
#[test]
#[ignore = "requires dedicated synthetic PostgreSQL TLS fixture; execute exact via native-sql-secure-fixture"]
fn postgresql_native_verify_full_live() { direct_tls(true); }
#[test]
#[ignore = "requires dedicated synthetic MySQL TLS fixture; execute exact via native-sql-secure-fixture"]
fn mysql_native_verify_full_live() { direct_tls(false); }
#[test]
#[ignore = "requires pinned synthetic SSH + PostgreSQL verify-full fixture; execute exact via native-sql-secure-fixture"]
fn postgresql_native_ssh_verify_full_live() { pinned_ssh(true); }
#[test]
#[ignore = "SSH-only synthetic MySQL fixture; combined verify-full is explicitly unsupported"]
fn mysql_native_ssh_pinned_live() { pinned_ssh(false); }
