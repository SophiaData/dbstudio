//! Native Redis metadata browsing only. No command execution, value reads or business writes.
//! TCP/TLS + ACL/password authentication. TLS always verifies system roots and hostnames.
use dbstudio_protocol::{ConnectionConfig, Driver, DriverError, DriverResult, SecretMap};
use redis::{Connection, ConnectionAddr, ConnectionInfo, RedisConnectionInfo};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, time::{Duration, Instant}};

pub const MAX_KEYS: usize = 500;
const TIMEOUT: Duration = Duration::from_secs(5);
const SCAN_ROUNDS: usize = 1000;

pub fn capabilities() -> Value {
    json!({"supportsInlineEdit":false,"supportsServerPagination":false,"hasCatalog":false,
        "hasSchema":false,"supportsCancel":false})
}

fn option(config: &ConnectionConfig, key: &str, fallback: &str) -> DriverResult<String> {
    match config.options.get(key) {
        None => Ok(fallback.into()),
        Some(Value::String(value)) => Ok(value.trim().to_owned()),
        _ => Err(DriverError::invalid(format!("Redis {key} 必须是字符串"))),
    }
}

fn redis_error(_: redis::RedisError) -> DriverError {
    // Server/URL errors can contain credentials or private values. Do not forward them.
    DriverError::new("transport-failed", "Redis 操作失败，请检查连接、权限及服务状态")
}

pub fn connect(config: &ConnectionConfig, secret: &SecretMap) -> DriverResult<Box<dyn Driver>> {
    if config.dialect_id != "redis" { return Err(DriverError::invalid("Redis 方言不匹配")); }
    let tls = match option(config, "tls", "off")?.as_str() {
        "off" | "" => false,
        "on" => true,
        _ => return Err(DriverError::invalid("Redis TLS 选项无效")),
    };
    let host = option(config, "host", "127.0.0.1")?;
    if host.is_empty() { return Err(DriverError::invalid("Redis 主机不能为空")); }
    let port = match config.options.get("port") {
        None => 6379,
        Some(value) => value.as_u64().or_else(|| value.as_str()?.parse().ok())
            .filter(|port| *port > 0 && *port <= 65535)
            .ok_or_else(|| DriverError::invalid("Redis 端口无效"))? as u16,
    };
    let user = option(config, "user", "")?;
    // MATCH patterns are data: whitespace is meaningful and must never broaden a scan.
    let pattern = match config.options.get("keyPattern") {
        None => "*".to_owned(),
        Some(Value::String(value)) if value.is_empty() => "*".to_owned(),
        Some(Value::String(value)) => value.clone(),
        _ => return Err(DriverError::invalid("Redis keyPattern 必须是字符串")),
    };
    let password = match secret.get("dbPassword") {
        None => None,
        Some(Value::String(value)) => Some(value.clone()),
        _ => return Err(DriverError::invalid("Redis 凭据格式无效")),
    };
    let info = ConnectionInfo {
        addr: if tls {
            ConnectionAddr::TcpTls { host, port, insecure: false, tls_params: None }
        } else {
            ConnectionAddr::Tcp(host, port)
        },
        redis: RedisConnectionInfo {
            db: 0,
            username: if user.is_empty() { None } else { Some(user) },
            password,
            ..Default::default()
        },
    };
    let client = redis::Client::open(info).map_err(redis_error)?;
    let mut connection = client.get_connection_with_timeout(TIMEOUT).map_err(redis_error)?;
    connection.set_read_timeout(Some(TIMEOUT)).map_err(redis_error)?;
    connection.set_write_timeout(Some(TIMEOUT)).map_err(redis_error)?;
    let _: String = redis::cmd("PING").query(&mut connection).map_err(redis_error)?;
    Ok(Box::new(RedisDriver { connection: Some(connection), pattern }))
}

/// Parse INFO keyspace without exposing arbitrary server text.
pub fn parse_keyspace(info: &str) -> Vec<(u32, u64)> {
    let mut dbs = BTreeMap::new();
    for line in info.lines() {
        let Some((db, fields)) = line.trim().split_once(':') else { continue };
        let Some(db) = db.strip_prefix("db").and_then(|db| db.parse::<u32>().ok()) else { continue };
        if let Some(keys) = fields.split(',').find_map(|field| field.strip_prefix("keys=").and_then(|count| count.parse::<u64>().ok())) {
            dbs.insert(db, keys);
        }
    }
    dbs.entry(0).or_insert(0);
    dbs.into_iter().collect()
}

pub struct RedisDriver { connection: Option<Connection>, pattern: String }

impl RedisDriver {
    fn list_children(&mut self, parent: Option<&str>) -> DriverResult<Value> {
        let connection = self.connection.as_mut().ok_or_else(|| DriverError::new("backend-unavailable", "Redis 已断开"))?;
        let Some(parent) = parent else {
            let info: String = redis::cmd("INFO").arg("keyspace").query(connection).map_err(redis_error)?;
            return Ok(Value::Array(parse_keyspace(&info).into_iter().map(|(db, keys)| json!({
                "id":format!("db:{db}"),"kind":"schema","name":format!("db{db}"),
                "parentId":null,"hasChildren":keys > 0,"meta":{"keys":keys,"pattern":self.pattern}
            })).collect()));
        };
        if let Some(rest) = parent.strip_prefix("key:") {
            if rest.split_once(':').and_then(|(db, _)| db.parse::<u32>().ok()).is_some() { return Ok(json!([])); }
        }
        if parent.strip_prefix("more:").and_then(|db| db.parse::<u32>().ok()).is_some() { return Ok(json!([])); }
        let db = parent.strip_prefix("db:").and_then(|db| db.parse::<u32>().ok())
            .ok_or_else(|| DriverError::new("not-found", "Redis 节点不存在"))?;
        let _: () = redis::cmd("SELECT").arg(db).query(connection).map_err(redis_error)?;
        let started = Instant::now();
        let mut keys = BTreeSet::<String>::new();
        let mut cursor = 0u64;
        let mut truncated = false;
        for round in 0..SCAN_ROUNDS {
            let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN").arg(cursor)
                .arg("MATCH").arg(&self.pattern).arg("COUNT").arg(200)
                .query(connection).map_err(redis_error)?;
            cursor = next;
            for key in batch {
                if keys.contains(&key) { continue; }
                if keys.len() == MAX_KEYS { truncated = true; break; }
                keys.insert(key);
            }
            if truncated || cursor == 0 { break; }
            if round + 1 == SCAN_ROUNDS || started.elapsed() >= TIMEOUT { truncated = true; break; }
        }
        let mut refs = Vec::new();
        // A synchronous &mut Driver serializes SELECT and the complete scan/metadata sequence.
        for key in keys {
            let kind: String = redis::cmd("TYPE").arg(&key).query(connection).map_err(redis_error)?;
            let ttl: i64 = redis::cmd("PTTL").arg(&key).query(connection).map_err(redis_error)?;
            let ttl = if ttl == -1 { "永久".to_owned() } else if ttl < 0 { "已过期".to_owned() }
                else { format!("{} 秒", ttl / 1000 + i64::from(ttl % 1000 != 0)) };
            refs.push(json!({"id":format!("key:{db}:{key}"),"kind":"folder","name":key,
                "parentId":parent,"hasChildren":false,"meta":{"type":kind,"ttl":ttl}}));
        }
        if truncated {
            refs.push(json!({"id":format!("more:{db}"),"kind":"folder",
                "name":format!("…仅显示前 {MAX_KEYS} 个 key，请缩小键过滤范围"),
                "parentId":parent,"hasChildren":false,"meta":{"truncated":true}}));
        }
        Ok(Value::Array(refs))
    }
}

impl Driver for RedisDriver {
    fn dialect_id(&self) -> &str { "redis" }
    fn capabilities(&self) -> Value { capabilities() }
    fn call(&mut self, method: &str, args: Vec<Value>) -> DriverResult<Value> {
        match method {
            "listChildren" => {
                let parent = match args.first() {
                    Some(Value::Null) => None,
                    Some(Value::String(parent)) => Some(parent.as_str()),
                    _ => return Err(DriverError::invalid("parentId 必须是字符串或 null")),
                };
                self.list_children(parent)
            },
            _ => Err(DriverError::unsupported("Redis 仅支持只读元数据浏览")),
        }
    }
    fn disconnect(&mut self) -> DriverResult<()> {
        // Drop closes TCP directly, with no business command or reconnect.
        self.connection.take();
        Ok(())
    }
}
