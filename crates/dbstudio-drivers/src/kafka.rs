//! Native Kafka metadata and offsets only. No producer, consumer group, Fetch or commit APIs.
//! TLS and SASL use patched rskafka with verified system roots and auto-creation disabled.
//! Brokers unable to encode the read-only metadata flag fail closed; never silently downgrade.
//! Never load metadata for a named topic: Kafka brokers may auto-create it on that request.
use dbstudio_protocol::{ConnectionConfig, Driver, DriverError, DriverResult, SecretMap};
use kafka::client::{FetchOffset, KafkaClient};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use rskafka::client::{Client, ClientBuilder, Credentials, SaslConfig, partition::{OffsetAt, UnknownTopicHandling}};
use tokio::runtime::{Builder as RuntimeBuilder, Runtime};

const SECURE_TIMEOUT: Duration = Duration::from_secs(10);

pub fn capabilities() -> Value {
    json!({"supportsInlineEdit":false,"supportsServerPagination":false,"hasCatalog":false,
        "hasSchema":false,"supportsCancel":false})
}

fn option(config: &ConnectionConfig, key: &str, fallback: &str) -> DriverResult<String> {
    match config.options.get(key) {
        None => Ok(fallback.into()),
        Some(Value::String(value)) => Ok(value.trim().to_owned()),
        _ => Err(DriverError::invalid(format!("Kafka {key} 必须是字符串"))),
    }
}

pub fn parse_brokers(raw: &str) -> DriverResult<Vec<String>> {
    let brokers: Vec<String> = raw.split(',').map(str::trim).filter(|broker| !broker.is_empty()).map(str::to_owned).collect();
    if brokers.is_empty() { return Err(DriverError::invalid("Kafka Broker 列表不能为空")); }
    for broker in &brokers {
        let (host, port) = broker.rsplit_once(':').ok_or_else(|| DriverError::invalid("Kafka Broker 必须是 host:port"))?;
        if host.is_empty() || host.contains('/') || host.chars().any(char::is_whitespace) ||
            port.parse::<u16>().ok().filter(|port| *port != 0).is_none() {
            return Err(DriverError::invalid("Kafka Broker 地址或端口无效"));
        }
    }
    Ok(brokers)
}

fn kafka_error(_: kafka::error::Error) -> DriverError {
    DriverError::new("transport-failed", "Kafka 元数据操作失败，请检查连接、权限及服务状态")
}

pub fn connect(config: &ConnectionConfig, secret: &SecretMap) -> DriverResult<Box<dyn Driver>> {
    if config.dialect_id != "kafka" { return Err(DriverError::invalid("Kafka 方言不匹配")); }
    let tls = match option(config, "ssl", "off")?.as_str() {
        "off" | "" => false,
        "on" => true,
        _ => return Err(DriverError::invalid("Kafka TLS 选项无效")),
    };
    let mechanism = option(config, "saslMechanism", "none")?;
    let password = match secret.get("dbPassword") {
        None => String::new(),
        Some(Value::String(value)) => value.clone(),
        _ => return Err(DriverError::invalid("Kafka 凭据格式无效")),
    };
    let sasl = if mechanism.is_empty() || mechanism == "none" {
        if !password.is_empty() { return Err(DriverError::invalid("Kafka 凭据需要显式 SASL 机制")); }
        None
    } else {
        if !["plain", "scram-sha-256", "scram-sha-512"].contains(&mechanism.as_str()) {
            return Err(DriverError::invalid("Kafka SASL 机制无效"));
        }
        let user = option(config, "user", "")?;
        if user.is_empty() { return Err(DriverError::invalid("Kafka SASL 用户名不能为空")); }
        let credentials = Credentials::new(user, password);
        Some(match mechanism.as_str() {
            "plain" => SaslConfig::Plain(credentials),
            "scram-sha-256" => SaslConfig::ScramSha256(credentials),
            _ => SaslConfig::ScramSha512(credentials),
        })
    };
    let hosts = parse_brokers(&option(config, "brokers", "")?)?;
    if tls || sasl.is_some() {
        return connect_secure(config, hosts, tls, sasl);
    }
    let mut client = KafkaClient::new(hosts);
    let client_id = option(config, "clientId", "dbstudio")?;
    client.set_client_id(if client_id.is_empty() { "dbstudio".into() } else { client_id });
    client.set_retry_max_attempts(1);
    client.set_retry_backoff_time(Duration::from_millis(200));
    client.load_metadata_all().map_err(kafka_error)?;
    Ok(Box::new(KafkaDriver { client: Some(KafkaSession::Plaintext(client)) }))
}

fn secure_error() -> DriverError {
    DriverError::new("transport-failed", "Kafka 安全连接或元数据操作失败，请检查证书、凭据、权限与服务状态")
}

fn connect_secure(config: &ConnectionConfig, hosts: Vec<String>, tls: bool, sasl: Option<SaslConfig>) -> DriverResult<Box<dyn Driver>> {
    let mut builder = ClientBuilder::new(hosts).max_message_size(8 * 1024 * 1024);
    let client_id = option(config, "clientId", "dbstudio")?;
    builder = builder.client_id(if client_id.is_empty() { "dbstudio".into() } else { client_id });
    if tls {
        let mut roots = rustls::RootCertStore::empty();
        let certificates = rustls_native_certs::load_native_certs();
        for certificate in certificates.certs { roots.add(certificate).map_err(|_| secure_error())?; }
        if roots.is_empty() { return Err(secure_error()); }
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions().map_err(|_| secure_error())?
            .with_root_certificates(roots).with_no_client_auth();
        builder = builder.tls_config(Arc::new(tls));
    }
    if let Some(sasl) = sasl { builder = builder.sasl_config(sasl); }
    // The synchronous Driver contract runs on application worker threads. The private runtime
    // keeps rskafka background IO alive between calls; each operation has a total deadline.
    let runtime = RuntimeBuilder::new_current_thread().enable_all().build().map_err(|_| secure_error())?;
    let client = runtime.block_on(async {
        tokio::time::timeout(SECURE_TIMEOUT, builder.build()).await
            .map_err(|_| DriverError::new("timeout", "Kafka 安全连接超时"))?
            .map_err(|_| secure_error())
    })?;
    Ok(Box::new(KafkaDriver { client: Some(KafkaSession::Authenticated { runtime, client }) }))
}

enum KafkaSession {
    Plaintext(KafkaClient),
    Authenticated { runtime: Runtime, client: Client },
}

pub struct KafkaDriver { client: Option<KafkaSession> }

fn secure_children(runtime: &Runtime, client: &Client, parent: Option<&str>) -> DriverResult<Value> {
    runtime.block_on(async {
        tokio::time::timeout(SECURE_TIMEOUT, async {
            // Existence is checked against all topics before selecting a partition. The pinned
            // local rskafka patch also disables auto-creation on every named metadata request.
            let mut topics = client.list_topics().await.map_err(|_| secure_error())?;
            topics.retain(|topic| !topic.name.starts_with("__"));
            topics.sort_by(|left, right| left.name.cmp(&right.name));
            let Some(parent) = parent else {
                return Ok(Value::Array(topics.into_iter().map(|topic| json!({
                    "id":format!("topic:{}", topic.name),"name":topic.name,"kind":"schema",
                    "parentId":null,"hasChildren":true
                })).collect()));
            };
            let name = parent.strip_prefix("topic:").ok_or_else(|| DriverError::new("not-found", "Kafka 节点不存在"))?;
            let topic = topics.into_iter().find(|topic| topic.name == name)
                .ok_or_else(|| DriverError::new("not-found", "Kafka topic 不存在"))?;
            let mut nodes = Vec::new();
            for partition in topic.partitions {
                let partition_client = client.partition_client(name, partition, UnknownTopicHandling::Error)
                    .await.map_err(|_| secure_error())?;
                let low = partition_client.get_offset(OffsetAt::Earliest).await.map_err(|_| secure_error())?;
                let high = partition_client.get_offset(OffsetAt::Latest).await.map_err(|_| secure_error())?;
                nodes.push(json!({
                    "id":format!("partition:{partition}:{name}"),"name":format!("分区 {partition}"),
                    "kind":"folder","parentId":parent,"hasChildren":false,"meta":{
                        "leader":null,"replicas":null,"isr":null,
                        "lowOffset":low.to_string(),"highOffset":high.to_string(),
                        "metadataLimit":"leader/replicas/isr 尚待原生迁移；offset以字符串保留64位精度"
                    }
                }));
            }
            Ok(Value::Array(nodes))
        }).await.map_err(|_| DriverError::new("timeout", "Kafka 安全元数据操作超时"))?
    })
}

impl KafkaDriver {
    fn list_children(&mut self, parent: Option<&str>) -> DriverResult<Value> {
        let client = self.client.as_mut().ok_or_else(|| DriverError::new("backend-unavailable", "Kafka 已断开"))?;
        if let Some(parent) = parent {
            if let Some(rest) = parent.strip_prefix("partition:") {
                if rest.split_once(':').is_some_and(|(id, topic)| id.parse::<u32>().is_ok() && !topic.is_empty()) {
                    return Ok(json!([]));
                }
            }
            if !parent.starts_with("topic:") || parent.len() == "topic:".len() {
                return Err(DriverError::new("not-found", "Kafka 节点不存在"));
            }
        }
        let client = match client {
            KafkaSession::Plaintext(client) => client,
            KafkaSession::Authenticated { runtime, client } => return secure_children(runtime, client, parent),
        };
        // An empty topic list requests all topics and cannot auto-create a user-supplied name.
        client.load_metadata_all().map_err(kafka_error)?;
        let Some(parent) = parent else {
            let topics = client.topics();
            let mut names: Vec<String> = topics.names().filter(|name| !name.starts_with("__")).map(str::to_owned).collect();
            names.sort();
            return Ok(Value::Array(names.into_iter().map(|name| json!({
                "id":format!("topic:{name}"),"name":name,"kind":"schema","parentId":null,"hasChildren":true
            })).collect()));
        };
        let topic = &parent["topic:".len()..];
        let partitions: Vec<(i32, Option<i32>)> = {
            let topics = client.topics();
            let partitions = topics.partitions(topic).ok_or_else(|| DriverError::new("not-found", "Kafka topic 不存在"))?;
            partitions.into_iter().map(|partition| (partition.id(), partition.leader().map(|leader| leader.id()))).collect()
        };
        let low = client.fetch_topic_offsets(topic, FetchOffset::Earliest).map_err(kafka_error)?;
        let high = client.fetch_topic_offsets(topic, FetchOffset::Latest).map_err(kafka_error)?;
        let mut refs: Vec<Value> = partitions.into_iter().map(|(partition, leader)| {
            let low = low.iter().find(|offset| offset.partition == partition).map(|offset| offset.offset.to_string());
            let high = high.iter().find(|offset| offset.partition == partition).map(|offset| offset.offset.to_string());
            json!({"id":format!("partition:{partition}:{topic}"),"name":format!("分区 {partition}"),
                "kind":"folder","parentId":parent,"hasChildren":false,"meta":{
                    "leader":leader,"replicas":null,"isr":null,"lowOffset":low,"highOffset":high,
                    "metadataLimit":"replicas/isr 尚待原生迁移；offset 以字符串保留64位精度"
                }})
        }).collect();
        refs.sort_by_key(|node| node["id"].as_str().and_then(|id| id.split(':').nth(1)).and_then(|id| id.parse::<u32>().ok()).unwrap_or(0));
        Ok(Value::Array(refs))
    }
}

impl Driver for KafkaDriver {
    fn dialect_id(&self) -> &str { "kafka" }
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
            _ => Err(DriverError::unsupported("Kafka 仅支持 topic/partition 只读元数据浏览")),
        }
    }
    fn disconnect(&mut self) -> DriverResult<()> {
        self.client.take();
        Ok(())
    }
}
