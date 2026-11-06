//! Native network fixtures. These are synthetic RESP/Kafka protocol peers, not service acceptance.
use dbstudio_drivers::{kafka, redis};
use dbstudio_protocol::{ConnectionConfig, SecretMap};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
    thread::{self, JoinHandle},
    time::Duration,
};

struct Fixture { port: u16, stop: Arc<AtomicBool>, thread: Option<JoinHandle<()>> }
impl Fixture {
    fn start(handler: impl Fn(TcpStream, Arc<AtomicBool>) + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let shutdown = stop.clone();
        let handler = Arc::new(handler);
        let thread = thread::spawn(move || {
            let mut workers = Vec::new();
            while !shutdown.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
                        stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
                        let handler = handler.clone();
                        let shutdown = shutdown.clone();
                        workers.push(thread::spawn(move || handler(stream, shutdown)));
                    },
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(2)),
                    Err(_) => break,
                }
            }
            for worker in workers { worker.join().unwrap(); }
        });
        Self { port, stop, thread: Some(thread) }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() { thread.join().unwrap(); }
    }
}

fn config(dialect: &str, options: Value) -> ConnectionConfig {
    ConnectionConfig { dialect_id: dialect.into(), name: "synthetic".into(), options: options.as_object().unwrap().clone() }
}
fn resp_bulk(value: &str) -> String { format!("${}\r\n{}\r\n", value.len(), value) }
fn read_resp(reader: &mut BufReader<TcpStream>) -> std::io::Result<Vec<String>> {
    let mut line = String::new();
    reader.read_line(&mut line)?;
    if line.is_empty() { return Err(std::io::ErrorKind::UnexpectedEof.into()); }
    let count: usize = line.trim().strip_prefix('*').unwrap().parse().unwrap();
    let mut values = Vec::new();
    for _ in 0..count {
        line.clear();
        reader.read_line(&mut line)?;
        let len: usize = line.trim().strip_prefix('$').unwrap().parse().unwrap();
        let mut data = vec![0; len + 2];
        reader.read_exact(&mut data)?;
        values.push(String::from_utf8(data[..len].to_vec()).unwrap());
    }
    Ok(values)
}
fn redis_fixture(keys: Vec<String>, commands: Arc<Mutex<Vec<String>>>, scans: Option<Arc<Mutex<Vec<Vec<String>>>>>) -> Fixture {
    Fixture::start(move |stream, stop| {
        let mut reader = BufReader::new(stream);
        while !stop.load(Ordering::SeqCst) {
            let args = match read_resp(&mut reader) {
                Ok(args) => args,
                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                Err(_) => break,
            };
            let command = args[0].to_uppercase();
            commands.lock().unwrap().push(command.clone());
            if command == "SCAN" {
                if let Some(scans) = &scans { scans.lock().unwrap().push(args.clone()); }
            }
            let reply = match command.as_str() {
                "AUTH" | "CLIENT" | "SELECT" => "+OK\r\n".into(),
                "PING" => "+PONG\r\n".into(),
                "INFO" => resp_bulk("# Keyspace\r\ndb2:keys=2,expires=1,avg_ttl=0\r\n"),
                "SCAN" => format!("*2\r\n{}*{}\r\n{}", resp_bulk("0"), keys.len(), keys.iter().map(|key| resp_bulk(key)).collect::<String>()),
                "TYPE" => "+string\r\n".into(),
                "PTTL" => ":1501\r\n".into(),
                _ => "-ERR disallowed command\r\n".into(),
            };
            if reader.get_mut().write_all(reply.as_bytes()).is_err() { break; }
        }
    })
}

#[test]
fn redis_native_browses_raw_ids_and_never_reads_values_or_runs_commands() {
    let commands = Arc::new(Mutex::new(Vec::new()));
    let fixture = redis_fixture(vec!["alpha".into(), "key:beta".into()], commands.clone(), None);
    let mut driver = redis::connect(&config("redis", json!({"host":"127.0.0.1","port":fixture.port})), &SecretMap::new()).unwrap();
    assert_eq!(driver.capabilities()["supportsInlineEdit"], false);
    assert_eq!(driver.capabilities()["supportsCancel"], false);
    let root = driver.call("listChildren", vec![Value::Null]).unwrap();
    assert_eq!(root[0]["id"], "db:0");
    assert_eq!(root[1]["meta"]["keys"], 2);
    let keys = driver.call("listChildren", vec![json!("db:2")]).unwrap();
    assert_eq!(keys[1]["id"], "key:2:key:beta");
    assert_eq!(keys[0]["meta"]["ttl"], "2 秒");
    assert_eq!(driver.call("listChildren", vec![json!("key:2:key:beta")]).unwrap(), json!([]));
    let before = commands.lock().unwrap().len();
    for method in ["runQuery", "executeStatement", "applyEdits", "insertRow", "deleteRows", "createTable", "commitTransaction"] {
        assert_eq!(driver.call(method, vec![json!("SET forbidden 1")]).unwrap_err().code, "unsupported");
    }
    assert_eq!(commands.lock().unwrap().len(), before);
    assert!(commands.lock().unwrap().iter().all(|command| ["CLIENT", "AUTH", "PING", "INFO", "SELECT", "SCAN", "TYPE", "PTTL"].contains(&command.as_str())));
    driver.disconnect().unwrap();
    assert_eq!(driver.call("listChildren", vec![Value::Null]).unwrap_err().code, "backend-unavailable");
}

#[test]
fn redis_native_caps_key_browsing_and_reports_truncation() {
    let fixture = redis_fixture((0..601).map(|i| format!("key-{i:04}")).collect(), Arc::new(Mutex::new(Vec::new())), None);
    let mut driver = redis::connect(&config("redis", json!({"host":"localhost","port":fixture.port})), &SecretMap::new()).unwrap();
    let nodes = driver.call("listChildren", vec![json!("db:0")]).unwrap();
    assert_eq!(nodes.as_array().unwrap().len(), redis::MAX_KEYS + 1);
    assert_eq!(nodes[redis::MAX_KEYS]["id"], "more:0");
    assert_eq!(nodes[redis::MAX_KEYS]["meta"]["truncated"], true);
    driver.disconnect().unwrap();
}

#[test]
fn redis_native_scan_match_preserves_pattern_whitespace() {
    assert_eq!(redis::connect(&config("redis", json!({"keyPattern":42})), &SecretMap::new()).err().unwrap().code, "invalid-argument");
    for (pattern, expected) in [
        (None, "*"),
        (Some(json!("")), "*"),
        (Some(json!(" ")), " "),
        (Some(json!(" tenant:* ")), " tenant:* "),
    ] {
        let scans = Arc::new(Mutex::new(Vec::new()));
        let fixture = redis_fixture(Vec::new(), Arc::new(Mutex::new(Vec::new())), Some(scans.clone()));
        let mut options = json!({"host":"127.0.0.1","port":fixture.port});
        if let Some(pattern) = pattern { options["keyPattern"] = pattern; }
        let mut driver = redis::connect(&config("redis", options), &SecretMap::new()).unwrap();
        driver.call("listChildren", vec![json!("db:0")]).unwrap();
        assert_eq!(*scans.lock().unwrap(), vec![vec!["SCAN", "0", "MATCH", expected, "COUNT", "200"]]);
        driver.disconnect().unwrap();
    }
}

#[test]
fn native_nosql_validates_security_configuration_before_connecting() {
    for sasl in ["plain", "scram-sha-256", "scram-sha-512", "unknown"] {
        assert_eq!(kafka::connect(&config("kafka", json!({"saslMechanism":sasl})), &SecretMap::new()).err().unwrap().code, "invalid-argument");
    }
    assert_eq!(redis::connect(&config("redis", json!({"tls":"invalid"})), &SecretMap::new()).err().unwrap().code, "invalid-argument");
    assert_eq!(kafka::connect(&config("kafka", json!({"ssl":"invalid"})), &SecretMap::new()).err().unwrap().code, "invalid-argument");
    assert_eq!(redis::parse_keyspace("db9:keys=3,expires=0\r\nbogus\r\ndb2:keys=1"), vec![(0,0),(2,1),(9,3)]);
    assert!(kafka::parse_brokers("localhost:9092,127.0.0.1:19092").is_ok());
    for broker in ["", "host", "host:0", "host:65536", "host:no"] { assert!(kafka::parse_brokers(broker).is_err()); }
}

#[test]
fn native_nosql_tls_sends_client_hello_and_never_plaintext_credentials() {
    for dialect in ["redis", "kafka"] {
        let hellos = Arc::new(Mutex::new(Vec::new()));
        let observed = hellos.clone();
        let fixture = Fixture::start(move |mut stream, _stop| {
            let mut prefix = [0u8; 5];
            if stream.read_exact(&mut prefix).is_ok() { observed.lock().unwrap().push(prefix); }
            // Abort TLS negotiation; a client must return an error, never reconnect plaintext.
            let _ = stream.shutdown(std::net::Shutdown::Both);
        });
        let secret = json!({"dbPassword":"synthetic-must-not-be-plaintext"}).as_object().unwrap().clone();
        let result = if dialect == "redis" {
            redis::connect(&config("redis", json!({"host":"127.0.0.1","port":fixture.port,"tls":"on"})), &secret)
        } else {
            kafka::connect(&config("kafka", json!({"brokers":format!("127.0.0.1:{}", fixture.port),"ssl":"on","saslMechanism":"plain","user":"synthetic"})), &secret)
        };
        let error = result.err().expect("incomplete TLS must fail");
        assert!(["transport-failed", "timeout"].contains(&error.code.as_str()));
        assert!(!error.message.contains("synthetic"));
        let hellos = hellos.lock().unwrap();
        assert!(!hellos.is_empty(), "TLS-enabled connection must reach ClientHello");
        assert!(hellos.iter().all(|hello| hello[0] == 22 && hello[1] == 3), "every attempt must be TLS, never AUTH/SASL plaintext");
    }
}

#[test]
fn redis_native_does_not_echo_server_error_or_credentials() {
    let fixture = Fixture::start(|stream, stop| {
        let mut reader = BufReader::new(stream);
        while !stop.load(Ordering::SeqCst) {
            match read_resp(&mut reader) {
                Ok(_) => {
                    if reader.get_mut().write_all(b"-ERR synthetic-private-server-detail\r\n").is_err() { break; }
                },
                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                Err(_) => break,
            }
        }
    });
    let secret = json!({"dbPassword":"synthetic-private-credential"}).as_object().unwrap().clone();
    let error = redis::connect(&config("redis", json!({"host":"127.0.0.1","port":fixture.port})), &secret).err().unwrap();
    assert_eq!(error.code, "transport-failed");
    assert!(!error.message.contains("synthetic-private"));
}

// Real secure-service acceptance is deliberately opt-in, never a synthetic pass.
// Supply process-scoped SSL_CERT_FILE if the fixture CA is not in the system trust store.
// Do not put credentials into broker URLs or connection options.
#[test]
#[ignore = "requires externally provisioned readonly Redis TLS service and trusted CA"]
fn redis_native_tls_live_readonly() {
    let host = std::env::var("DBSTUDIO_REDIS_TLS_HOST").expect("set DBSTUDIO_REDIS_TLS_HOST");
    let port: u16 = std::env::var("DBSTUDIO_REDIS_TLS_PORT").expect("set DBSTUDIO_REDIS_TLS_PORT").parse().expect("invalid TLS port");
    let user = std::env::var("DBSTUDIO_REDIS_TLS_USER").unwrap_or_default();
    let password = std::env::var("DBSTUDIO_REDIS_TLS_PASSWORD").expect("set DBSTUDIO_REDIS_TLS_PASSWORD");
    let secret = json!({"dbPassword":password}).as_object().unwrap().clone();
    let mut driver = redis::connect(&config("redis", json!({"host":host,"port":port,"user":user,"tls":"on"})), &secret).unwrap();
    assert_eq!(driver.capabilities()["supportsInlineEdit"], false);
    assert!(driver.call("listChildren", vec![Value::Null]).unwrap().is_array());
    assert_eq!(driver.call("executeStatement", vec![json!("forbidden")]).unwrap_err().code, "unsupported");
    driver.disconnect().unwrap();
}

#[test]
#[ignore = "requires externally provisioned readonly Kafka TLS service with PLAIN and both SCRAM mechanisms, trusted CA and an existing topic"]
fn kafka_native_tls_sasl_live_readonly() {
    let brokers = std::env::var("DBSTUDIO_KAFKA_TLS_BROKERS").expect("set DBSTUDIO_KAFKA_TLS_BROKERS");
    let user = std::env::var("DBSTUDIO_KAFKA_TLS_USER").expect("set DBSTUDIO_KAFKA_TLS_USER");
    let password = std::env::var("DBSTUDIO_KAFKA_TLS_PASSWORD").expect("set DBSTUDIO_KAFKA_TLS_PASSWORD");
    let topic = std::env::var("DBSTUDIO_KAFKA_TLS_TOPIC").expect("set DBSTUDIO_KAFKA_TLS_TOPIC to an existing topic");
    let secret = json!({"dbPassword":password}).as_object().unwrap().clone();
    for mechanism in ["plain", "scram-sha-256", "scram-sha-512"] {
        let mut driver = kafka::connect(&config("kafka", json!({"brokers":brokers,"user":user,"ssl":"on","saslMechanism":mechanism})), &secret).unwrap();
        assert_eq!(driver.capabilities()["supportsInlineEdit"], false);
        assert!(driver.call("listChildren", vec![Value::Null]).unwrap().is_array());
        let partitions = driver.call("listChildren", vec![json!(format!("topic:{topic}"))]).unwrap();
        assert!(partitions.as_array().is_some_and(|nodes| !nodes.is_empty()));
        assert!(partitions.as_array().unwrap().iter().all(|node| node["meta"]["highOffset"].is_string()));
        assert_eq!(driver.call("executeStatement", vec![]).unwrap_err().code, "unsupported");
        driver.disconnect().unwrap();
    }
}

fn secure_api_versions(correlation: i32, version: i16, metadata_version: i16) -> Vec<u8> {
    let mut data = Vec::new();
    int(&mut data, correlation);
    data.extend_from_slice(&0i16.to_be_bytes());
    let apis = [(18i16, 0i16, 3i16), (17, 1, 1), (36, 0, 1), (3, 0, metadata_version), (2, 0, 1)];
    if version >= 3 { data.push(apis.len() as u8 + 1); } else { int(&mut data, apis.len() as i32); }
    for (api, min, max) in apis {
        data.extend_from_slice(&api.to_be_bytes()); data.extend_from_slice(&min.to_be_bytes()); data.extend_from_slice(&max.to_be_bytes());
        if version >= 3 { data.push(0); }
    }
    if version >= 1 { int(&mut data, 0); }
    if version >= 3 { data.push(0); }
    data
}

fn secure_metadata(correlation: i32, port: u16) -> Vec<u8> {
    let mut data = Vec::new();
    int(&mut data, correlation); int(&mut data, 0); int(&mut data, 1); int(&mut data, 7);
    string(&mut data, "127.0.0.1"); int(&mut data, i32::from(port)); data.extend_from_slice(&(-1i16).to_be_bytes());
    data.extend_from_slice(&(-1i16).to_be_bytes()); int(&mut data, 7); int(&mut data, 1);
    data.extend_from_slice(&0i16.to_be_bytes()); string(&mut data, "orders"); data.push(0); int(&mut data, 1);
    data.extend_from_slice(&0i16.to_be_bytes()); int(&mut data, 0); int(&mut data, 7);
    int(&mut data, 1); int(&mut data, 7); int(&mut data, 1); int(&mut data, 7);
    data
}

fn scram_hash(mechanism: &str, data: &[u8]) -> Vec<u8> {
    use sha2::Digest;
    if mechanism == "SCRAM-SHA-512" { sha2::Sha512::digest(data).to_vec() } else { sha2::Sha256::digest(data).to_vec() }
}
fn scram_hmac(mechanism: &str, key: &[u8], data: &[u8]) -> Vec<u8> {
    let block = if mechanism == "SCRAM-SHA-512" { 128 } else { 64 };
    let mut key = if key.len() > block { scram_hash(mechanism, key) } else { key.to_vec() };
    key.resize(block, 0);
    let mut inner: Vec<u8> = key.iter().map(|byte| byte ^ 0x36).collect();
    inner.extend_from_slice(data);
    let mut outer: Vec<u8> = key.iter().map(|byte| byte ^ 0x5c).collect();
    outer.extend_from_slice(&scram_hash(mechanism, &inner));
    scram_hash(mechanism, &outer)
}
fn scram_salted(mechanism: &str) -> Vec<u8> {
    let mut salt = b"synthetic-salt".to_vec();
    salt.extend_from_slice(&1u32.to_be_bytes());
    let mut u = scram_hmac(mechanism, b"synthetic-password", &salt);
    let mut result = u.clone();
    for _ in 1..4096 {
        u = scram_hmac(mechanism, b"synthetic-password", &u);
        for (sum, byte) in result.iter_mut().zip(&u) { *sum ^= byte; }
    }
    result
}

fn secure_kafka_fixture(mechanism: &'static str, metadata_version: i16, requests: Arc<Mutex<Vec<i16>>>) -> Fixture {
    use base64::{Engine, engine::general_purpose::STANDARD};
    Fixture::start(move |mut stream, stop| {
        let port = stream.local_addr().unwrap().port();
        let mut scram_state: Option<(String, String)> = None;
        while !stop.load(Ordering::SeqCst) {
            let mut size = [0; 4];
            match stream.read_exact(&mut size) {
                Ok(()) => {},
                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                Err(_) => break,
            }
            let size = i32::from_be_bytes(size);
            assert!((10..65536).contains(&size));
            let mut request = vec![0; size as usize]; stream.read_exact(&mut request).unwrap();
            let api = i16::from_be_bytes(request[..2].try_into().unwrap());
            let version = i16::from_be_bytes(request[2..4].try_into().unwrap());
            let correlation = i32::from_be_bytes(request[4..8].try_into().unwrap());
            requests.lock().unwrap().push(api);
            let client_len = i16::from_be_bytes(request[8..10].try_into().unwrap()) as usize;
            let body = &request[10+client_len..];
            let response = match api {
                18 => secure_api_versions(correlation, version, metadata_version),
                17 => {
                    assert_eq!(&body[2..], mechanism.as_bytes());
                    let mut data = correlation.to_be_bytes().to_vec(); data.extend_from_slice(&0i16.to_be_bytes());
                    int(&mut data, 1); string(&mut data, mechanism); data
                },
                36 => {
                    let len = i32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
                    let auth = &body[4..4+len];
                    let reply = if mechanism == "PLAIN" {
                        assert!(auth == b"\0synthetic-user\0synthetic-password", "PLAIN fixture credentials did not match");
                        Vec::new()
                    } else if let Some((first, server_first)) = scram_state.take() {
                        let final_message = std::str::from_utf8(auth).unwrap();
                        let (without_proof, proof) = final_message.rsplit_once(",p=").unwrap();
                        let message = format!("{first},{server_first},{without_proof}");
                        let salted = scram_salted(mechanism);
                        let client_key = scram_hmac(mechanism, &salted, b"Client Key");
                        let signature = scram_hmac(mechanism, &scram_hash(mechanism, &client_key), message.as_bytes());
                        let expected: Vec<u8> = client_key.iter().zip(signature).map(|(left, right)| left ^ right).collect();
                        assert!(STANDARD.decode(proof).unwrap() == expected, "SCRAM fixture client proof mismatch");
                        let server_key = scram_hmac(mechanism, &salted, b"Server Key");
                        format!("v={}", STANDARD.encode(scram_hmac(mechanism, &server_key, message.as_bytes()))).into_bytes()
                    } else {
                        let first = std::str::from_utf8(auth).unwrap().strip_prefix("n,,").unwrap().to_owned();
                        let nonce = first.split(',').find_map(|field| field.strip_prefix("r=")).unwrap();
                        let response = format!("r={nonce}fixture,s={},i=4096", STANDARD.encode(b"synthetic-salt"));
                        scram_state = Some((first, response.clone())); response.into_bytes()
                    };
                    let mut data = correlation.to_be_bytes().to_vec(); data.extend_from_slice(&0i16.to_be_bytes());
                    data.extend_from_slice(&(-1i16).to_be_bytes()); int(&mut data, reply.len() as i32); data.extend_from_slice(&reply);
                    if version >= 1 { data.extend_from_slice(&0i64.to_be_bytes()); }
                    data
                },
                3 => {
                    let topics = i32::from_be_bytes(body[..4].try_into().unwrap());
                    if topics >= 0 {
                        assert!(version >= 4, "old protocol must fail closed before named metadata reaches broker");
                        assert_eq!(body.last(), Some(&0), "named metadata must disable auto-creation");
                    }
                    secure_metadata(correlation, port)
                },
                2 => {
                    assert_eq!(version, 1);
                    let timestamp = i64::from_be_bytes(request[request.len()-8..].try_into().unwrap());
                    let mut data = correlation.to_be_bytes().to_vec(); int(&mut data, 1); string(&mut data, "orders"); int(&mut data, 1);
                    int(&mut data, 0); data.extend_from_slice(&0i16.to_be_bytes()); data.extend_from_slice(&(-1i64).to_be_bytes());
                    data.extend_from_slice(&(if timestamp == -1 { 9_007_199_254_740_993i64 } else { 10 }).to_be_bytes()); data
                },
                _ => panic!("secure read-only browser issued prohibited Kafka API"),
            };
            if stream.write_all(&(response.len() as i32).to_be_bytes()).is_err() { break; }
            if stream.write_all(&response).is_err() { break; }
        }
    })
}

#[test]
fn kafka_native_sasl_plain_scram_and_safe_offsets_use_real_protocol() {
    for (setting, mechanism) in [("plain", "PLAIN"), ("scram-sha-256", "SCRAM-SHA-256"), ("scram-sha-512", "SCRAM-SHA-512")] {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let fixture = secure_kafka_fixture(mechanism, 4, requests.clone());
        let secret = json!({"dbPassword":"synthetic-password"}).as_object().unwrap().clone();
        let mut driver = kafka::connect(&config("kafka", json!({"brokers":format!("127.0.0.1:{}",fixture.port),"saslMechanism":setting,"user":"synthetic-user"})), &secret).unwrap();
        assert_eq!(driver.call("listChildren", vec![Value::Null]).unwrap()[0]["id"], "topic:orders");
        let partitions = driver.call("listChildren", vec![json!("topic:orders")]).unwrap();
        assert_eq!(partitions[0]["meta"]["lowOffset"], "10");
        assert_eq!(partitions[0]["meta"]["highOffset"], "9007199254740993");
        let before = requests.lock().unwrap().len();
        assert_eq!(driver.call("executeStatement", vec![json!("forbidden")]).unwrap_err().code, "unsupported");
        assert_eq!(requests.lock().unwrap().len(), before);
        assert!(requests.lock().unwrap().iter().all(|api| [18,17,36,3,2].contains(api)));
        driver.disconnect().unwrap();
    }
}

#[test]
fn kafka_native_old_metadata_protocol_cannot_auto_create_topics() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let fixture = secure_kafka_fixture("PLAIN", 3, requests.clone());
    let secret = json!({"dbPassword":"synthetic-password"}).as_object().unwrap().clone();
    let mut driver = kafka::connect(&config("kafka", json!({"brokers":format!("127.0.0.1:{}",fixture.port),"saslMechanism":"plain","user":"synthetic-user"})), &secret).unwrap();
    assert!(driver.call("listChildren", vec![Value::Null]).is_ok());
    let started = std::time::Instant::now();
    assert_eq!(driver.call("listChildren", vec![json!("topic:orders")]).unwrap_err().code, "transport-failed");
    assert!(started.elapsed() < Duration::from_secs(3), "local protocol incompatibility must fail promptly, not wait for the 10s request deadline");
    let observed = requests.lock().unwrap();
    assert!(!observed.contains(&2));
    assert_eq!(observed.iter().filter(|api| **api == 3).count(), 3, "only initial/root/expansion all-topic metadata may reach the broker; named metadata and its retries must stay local");
    drop(observed);
    driver.disconnect().unwrap();
}

fn string(data: &mut Vec<u8>, text: &str) { data.extend_from_slice(&(text.len() as i16).to_be_bytes()); data.extend_from_slice(text.as_bytes()); }
fn int(data: &mut Vec<u8>, value: i32) { data.extend_from_slice(&value.to_be_bytes()); }
fn metadata(correlation: i32, port: u16) -> Vec<u8> {
    let mut data = Vec::new();
    int(&mut data, correlation); int(&mut data, 1); int(&mut data, 7);
    string(&mut data, "127.0.0.1"); int(&mut data, i32::from(port));
    int(&mut data, 2);
    for topic in ["__internal", "orders"] {
        data.extend_from_slice(&0i16.to_be_bytes()); string(&mut data, topic); int(&mut data, 1);
        data.extend_from_slice(&0i16.to_be_bytes()); int(&mut data, 0); int(&mut data, 7);
        int(&mut data, 1); int(&mut data, 7); int(&mut data, 1); int(&mut data, 7);
    }
    data
}
fn offsets(correlation: i32, high: bool) -> Vec<u8> {
    let mut data = Vec::new();
    int(&mut data, correlation); int(&mut data, 1); string(&mut data, "orders"); int(&mut data, 1);
    int(&mut data, 0); data.extend_from_slice(&0i16.to_be_bytes()); int(&mut data, 1);
    data.extend_from_slice(&(if high { 9_007_199_254_740_993i64 } else { 10i64 }).to_be_bytes());
    data
}

#[test]
fn kafka_native_metadata_offsets_are_read_only_and_do_not_autocreate_topics() {
    let requests = Arc::new(Mutex::new(Vec::<i16>::new()));
    let recorded = requests.clone();
    let fixture = Fixture::start(move |mut stream, stop| {
        let port = stream.local_addr().unwrap().port();
        while !stop.load(Ordering::SeqCst) {
            let mut size = [0u8; 4];
            match stream.read_exact(&mut size) {
                Ok(()) => {},
                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                Err(_) => break,
            }
            let size = i32::from_be_bytes(size);
            assert!((10..65536).contains(&size));
            let mut request = vec![0u8; size as usize];
            stream.read_exact(&mut request).unwrap();
            let api = i16::from_be_bytes(request[0..2].try_into().unwrap());
            let correlation = i32::from_be_bytes(request[4..8].try_into().unwrap());
            recorded.lock().unwrap().push(api);
            let response = match api {
                3 => {
                    let client_len = i16::from_be_bytes(request[8..10].try_into().unwrap()) as usize;
                    let body = &request[10 + client_len..];
                    assert_eq!(i32::from_be_bytes(body[0..4].try_into().unwrap()), 0, "metadata must request all topics, never a supplied name");
                    metadata(correlation, port)
                },
                2 => {
                    // ListOffsets v0 ends in timestamp i64, max offsets i32.
                    let start = request.len() - 12;
                    let timestamp = i64::from_be_bytes(request[start..start+8].try_into().unwrap());
                    offsets(correlation, timestamp == -1)
                },
                _ => panic!("read-only browser issued prohibited Kafka API"),
            };
            stream.write_all(&(response.len() as i32).to_be_bytes()).unwrap();
            stream.write_all(&response).unwrap();
        }
    });
    let mut driver = kafka::connect(&config("kafka", json!({"brokers":format!("127.0.0.1:{}", fixture.port)})), &SecretMap::new()).unwrap();
    assert_eq!(driver.capabilities()["supportsInlineEdit"], false);
    let topics = driver.call("listChildren", vec![Value::Null]).unwrap();
    assert_eq!(topics, json!([{"id":"topic:orders","name":"orders","kind":"schema","parentId":null,"hasChildren":true}]));
    let partitions = driver.call("listChildren", vec![json!("topic:orders")]).unwrap();
    assert_eq!(partitions[0]["id"], "partition:0:orders");
    assert_eq!(partitions[0]["meta"]["leader"], 7);
    assert_eq!(partitions[0]["meta"]["lowOffset"], "10");
    assert_eq!(partitions[0]["meta"]["highOffset"], "9007199254740993");
    assert_eq!(partitions[0]["meta"]["replicas"], Value::Null, "unmigrated metadata must not be invented");
    assert_eq!(driver.call("listChildren", vec![json!("topic:missing")]).unwrap_err().code, "not-found");
    assert_eq!(driver.call("listChildren", vec![json!("partition:0:orders")]).unwrap(), json!([]));
    let before = requests.lock().unwrap().len();
    for method in ["runQuery", "executeStatement", "insertRow", "deleteRows", "createTable", "commitTransaction"] {
        assert_eq!(driver.call(method, vec![]).unwrap_err().code, "unsupported");
    }
    assert_eq!(requests.lock().unwrap().len(), before);
    assert!(requests.lock().unwrap().iter().all(|api| [2, 3].contains(api)));
    driver.disconnect().unwrap();
    assert_eq!(driver.call("listChildren", vec![Value::Null]).unwrap_err().code, "backend-unavailable");
}
