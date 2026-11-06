//! Host-independent contracts shared by native drivers, application core and shells.
//! The v1 JSON method/argument/result shapes follow the existing desktop API.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{fmt, sync::Arc};

pub type DriverResult<T> = Result<T, DriverError>;
pub type SecretMap = Map<String, Value>;
pub type CancelHandle = Arc<dyn Fn() -> DriverResult<bool> + Send + Sync>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionConfig {
    pub dialect_id: String,
    pub name: String,
    #[serde(default)]
    pub options: Map<String, Value>,
}

// Configuration can contain private targets. Debug output deliberately omits its values.
impl fmt::Debug for ConnectionConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectionConfig").field("dialect_id", &self.dialect_id).finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct DriverError {
    pub code: String,
    pub message: String,
}
impl DriverError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
    pub fn invalid(message: impl Into<String>) -> Self { Self::new("invalid-argument", message) }
    pub fn unsupported(message: impl Into<String>) -> Self { Self::new("unsupported", message) }
}

/// Each instance owns one database session and its native cursors/transaction.
/// Shells execute blocking calls on worker threads; cancel handles are independently callable.
pub trait Driver: Send {
    fn dialect_id(&self) -> &str;
    fn capabilities(&self) -> Value;
    /// Driver method arguments use unscoped native object/cursor IDs.
    fn call(&mut self, method: &str, args: Vec<Value>) -> DriverResult<Value>;
    fn cancel_handle(&self) -> CancelHandle { Arc::new(|| Ok(false)) }
    fn disconnect(&mut self) -> DriverResult<()> { Ok(()) }
}

pub fn argument<'a>(args: &'a [Value], index: usize, name: &str) -> DriverResult<&'a Value> {
    args.get(index).ok_or_else(|| DriverError::invalid(format!("缺少参数 {name}")))
}
pub fn string_argument<'a>(args: &'a [Value], index: usize, name: &str) -> DriverResult<&'a str> {
    argument(args, index, name)?.as_str().ok_or_else(|| DriverError::invalid(format!("{name} 必须是字符串")))
}

/// V1 credentials stay separate from serializable connection configuration.
pub fn normalize_secret(value: Option<&Value>) -> DriverResult<SecretMap> {
    let mut result = Map::new();
    match value {
        None | Some(Value::Null) => {},
        Some(Value::String(password)) => { if !password.is_empty() { result.insert("dbPassword".into(), Value::String(password.clone())); } },
        Some(Value::Object(values)) => {
            for (key, value) in values {
                if !["dbPassword", "sshPassword", "sshPassphrase"].contains(&key.as_str()) || !value.is_string() {
                    return Err(DriverError::invalid("凭据字段无效"));
                }
                if value.as_str() != Some("") { result.insert(key.clone(), value.clone()); }
            }
        },
        _ => return Err(DriverError::invalid("凭据格式无效")),
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn secret_normalization_preserves_named_channels_without_debugging_values() {
        assert_eq!(normalize_secret(Some(&json!("fixture"))).unwrap(), json!({"dbPassword":"fixture"}).as_object().unwrap().clone());
        assert!(normalize_secret(Some(&json!({"unknown":"fixture"}))).is_err());
        assert!(normalize_secret(Some(&json!({"dbPassword":42}))).is_err());
    }
    #[test]
    fn config_debug_cannot_reveal_options_or_display_name() {
        let config: ConnectionConfig = serde_json::from_value(json!({"dialectId":"sqlite","name":"private-name","options":{"file":"private-path"}})).unwrap();
        let text = format!("{config:?}");
        assert!(!text.contains("private-name") && !text.contains("private-path"));
    }
}
