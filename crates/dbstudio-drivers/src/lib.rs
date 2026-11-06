//! Native database dispatch. No desktop shell or JavaScript runtime dependency.
use dbstudio_protocol::{ConnectionConfig, Driver, DriverError, DriverResult, SecretMap};
use serde_json::{json, Value};

pub mod sqlite;
pub mod postgresql;
pub mod mysql;
pub mod redis;
pub mod kafka;
pub mod network;
pub mod tls;
pub mod tunnel;

pub fn connect(config: &ConnectionConfig, secret: &SecretMap) -> DriverResult<Box<dyn Driver>> {
    match config.dialect_id.as_str() {
        "sqlite" => sqlite::connect(config, secret),
        "postgresql" => postgresql::connect(config, secret),
        "mysql" => mysql::connect(config, secret),
        "redis" => redis::connect(config, secret),
        "kafka" => kafka::connect(config, secret),
        _ => Err(DriverError::invalid("未知数据库方言")),
    }
}

pub fn dialects() -> Value {
    let rules = |dollar: bool, blocks: bool| json!({
        "lineCommentPrefixes":["--"],"blockComment":{"start":"/*","end":"*/"},
        "supportsDollarQuotedStrings":dollar,"supportsBeginEndBlocks":blocks,"statementTerminators":[";"]
    });
    let network_fields = |port: u16, user: bool| {
        let mut fields = vec![json!({"key":"host","label":"主机","kind":"text","required":true}),json!({"key":"port","label":"端口","kind":"number","required":true,"default":port})];
        if user { fields.extend([json!({"key":"database","label":"数据库","kind":"text","required":true}),json!({"key":"user","label":"用户名","kind":"text","required":true})]); }
        fields.push(json!({"key":"dbPassword","label":"密码","kind":"password","secretKey":"dbPassword","required":false}));
        if user {
            let modes = if port == 5432 { vec!["disable", "prefer", "require", "verify-ca", "verify-full"] } else { vec!["disable", "require", "verify-ca", "verify-full"] };
            fields.push(json!({"key":"sslmode","label":"TLS 模式","kind":"select","required":false,"default":if port == 5432 { "prefer" } else { "disable" },"choices":modes.into_iter().map(|value|json!({"value":value,"label":value})).collect::<Vec<_>>()}));
            fields.extend([
                json!({"key":"sslrootcert","label":"CA 证书文件","kind":"file","required":false}),
                json!({"key":"sshHost","label":"SSH 主机（留空禁用）","kind":"text","required":false}),
                json!({"key":"sshPort","label":"SSH 端口","kind":"number","required":false,"default":22}),
                json!({"key":"sshUser","label":"SSH 用户","kind":"text","required":false}),
                json!({"key":"sshPrivateKey","label":"SSH 私钥文件","kind":"file","required":false}),
                json!({"key":"sshHostKeySha256","label":"SSH SHA256 指纹","kind":"text","required":false}),
                json!({"key":"sshPassword","label":"SSH 密码","kind":"password","secretKey":"sshPassword","required":false}),
                json!({"key":"sshPassphrase","label":"私钥口令","kind":"password","secretKey":"sshPassphrase","required":false})
            ]);
        }
        fields
    };
    json!([
        {"id":"sqlite","name":"SQLite","fields":[{"key":"file","label":"数据库文件","kind":"file","required":true}],"quoting":{"open":"\"","close":"\"","escape":"double"},"scriptRules":rules(false,true)},
        {"id":"postgresql","name":"PostgreSQL","fields":network_fields(5432,true),"quoting":{"open":"\"","close":"\"","escape":"double"},"scriptRules":rules(true,false)},
        {"id":"mysql","name":"MySQL / MariaDB","fields":network_fields(3306,true),"quoting":{"open":"`","close":"`","escape":"double"},"scriptRules":rules(false,true)},
        {"id":"redis","name":"Redis（只浏览）","fields":[
            {"key":"host","label":"主机","kind":"text","required":true,"default":"127.0.0.1"},
            {"key":"port","label":"端口","kind":"number","required":true,"default":6379},
            {"key":"user","label":"用户名","kind":"text","required":false,"placeholder":"default"},
            {"key":"password","label":"密码","kind":"password","secretKey":"dbPassword","required":false},
            {"key":"tls","label":"TLS","kind":"select","required":false,"default":"off","choices":[{"value":"off","label":"关闭"},{"value":"on","label":"启用"}]},
            {"key":"keyPattern","label":"Key 匹配模式","kind":"text","required":false,"default":"*"}
        ],"quoting":{"open":"\"","close":"\"","escape":"double"},"scriptRules":rules(false,false)},
        {"id":"kafka","name":"Kafka（只浏览）","fields":[
            {"key":"brokers","label":"Brokers","kind":"text","required":true,"default":"127.0.0.1:9092","placeholder":"127.0.0.1:9092,host2:9092"},
            {"key":"clientId","label":"Client ID","kind":"text","required":false,"default":"dbstudio"},
            {"key":"ssl","label":"TLS","kind":"select","required":false,"default":"off","choices":[{"value":"off","label":"关闭"},{"value":"on","label":"启用"}]},
            {"key":"saslMechanism","label":"SASL","kind":"select","required":false,"default":"none","choices":[{"value":"none","label":"关闭"},{"value":"plain","label":"PLAIN"},{"value":"scram-sha-256","label":"SCRAM-SHA-256"},{"value":"scram-sha-512","label":"SCRAM-SHA-512"}]},
            {"key":"user","label":"用户名","kind":"text","required":false},
            {"key":"password","label":"密码","kind":"password","secretKey":"dbPassword","required":false}
        ],"quoting":{"open":"\"","close":"\"","escape":"double"},"scriptRules":rules(false,false)}
    ])
}
