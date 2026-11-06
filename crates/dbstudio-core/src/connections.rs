use crate::{parse_node_or_connection, safe_error, session::{lock, Session}, storage::{self, SavedConnection}, AppError, Application};
use dbstudio_protocol::{normalize_secret, ConnectionConfig, SecretMap};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{Arc, Mutex}, time::Instant};
use uuid::Uuid;

fn secret_error() -> AppError { AppError::new("secret-storage-unavailable", "安全凭据存储不可用，请重新录入；不会明文保存") }
impl Application {
    pub(crate) fn connection_call(&self, method: &str, args: &[Value]) -> Option<Result<Value, AppError>> {
        if !["listConnections", "addConnection", "connectConnection", "disconnectConnection", "removeConnection", "testConnection", "updateConnection"].contains(&method) { return None }
        Some((|| match method {
            "listConnections" => Ok(Value::Array(self.summaries()?)),
            "addConnection" => {
                let config = self.read_config(args.first().cloned().ok_or_else(|| AppError::invalid("缺少连接配置"))?)?;
                let secret = normalize_secret(args.get(1))?;
                let id = format!("c-{}", Uuid::new_v4());
                let record = SavedConnection { id: id.clone(), config, secret_key: format!("dbstudio-native-{}", Uuid::new_v4()), legacy_secret_requires_reentry: false };
                {
                    let mut state = lock(&self.state)?;
                    if state.closed { return Err(crate::closed()) }
                    let mut next = state.connections.clone(); next.push(record.clone());
                    storage::save_connections(&self.base_dir, &next)?;
                    state.connections = next;
                    if !secret.is_empty() { state.temporary_secrets.insert(id.clone(), secret.clone()); }
                }
                if !secret.is_empty() { let _ = self.secrets.set(&record.secret_key, &secret); }
                // 配置先保存。连接失败保留配置，并返回明确的disconnected summary。
                let _ = self.connect(&id);
                self.summary(&id)
            },
            "connectConnection" => { let id = connection_arg(args)?; self.connect(id) },
            "disconnectConnection" => {
                let id = connection_arg(args)?; let gate = self.gate(id)?; let _guard = lock(&gate)?;
                self.disconnect_session(id)?; self.summary(id)
            },
            "removeConnection" => {
                let id = connection_arg(args)?; let gate = self.gate(id)?; let _guard = lock(&gate)?;
                self.disconnect_session(id)?;
                let record = self.record(id)?;
                {
                    let mut state = lock(&self.state)?;
                    let next = state.connections.iter().filter(|item| item.id != id).cloned().collect::<Vec<_>>();
                    storage::save_connections(&self.base_dir, &next)?;
                    state.connections = next; state.temporary_secrets.remove(id);
                }
                if self.secrets.remove(&record.secret_key).is_err() {
                    return Err(AppError::new("secret-cleanup-failed", "连接已移除，但旧凭据未能清理，请检查系统凭据存储"))
                }
                Ok(Value::Null)
            },
            "testConnection" => {
                let config = self.read_config(args.first().cloned().ok_or_else(|| AppError::invalid("缺少连接配置"))?)?;
                let secret = normalize_secret(args.get(1))?;
                let started = Instant::now();
                let result = (self.factory)(&config, &secret);
                let elapsed = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                match result {
                    Ok(mut driver) => { driver.disconnect().map_err(safe_error)?; Ok(json!({"ok":true,"elapsedMs":elapsed})) },
                    Err(_) => Ok(json!({"ok":false,"elapsedMs":elapsed,"error":"连接测试失败，请检查连接与凭据配置"})),
                }
            },
            "updateConnection" => self.update_connection(args),
            _ => unreachable!(),
        })())
    }
    fn read_config(&self, value: Value) -> Result<ConnectionConfig, AppError> {
        let config: ConnectionConfig = serde_json::from_value(value).map_err(|_| AppError::invalid("连接配置格式无效"))?;
        storage::validate_config(&config)?;
        let dialects = dbstudio_drivers::dialects();
        if !dialects.as_array().is_some_and(|items| items.iter().any(|item| item.get("id").and_then(Value::as_str) == Some(config.dialect_id.as_str()))) {
            return Err(AppError::unsupported("该方言尚未接入原生驱动"))
        }
        Ok(config)
    }
    fn record(&self, id: &str) -> Result<SavedConnection, AppError> {
        let state = lock(&self.state)?;
        if state.closed { return Err(crate::closed()) }
        state.connections.iter().find(|item| item.id == id).cloned().ok_or_else(|| AppError::new("not-found", "连接不存在"))
    }
    fn gate(&self, id: &str) -> Result<Arc<Mutex<()>>, AppError> {
        let mut state = lock(&self.state)?;
        if state.closed { return Err(crate::closed()) }
        if !state.connections.iter().any(|item| item.id == id) { return Err(AppError::new("not-found", "连接不存在")) }
        Ok(state.gates.entry(id.into()).or_insert_with(|| Arc::new(Mutex::new(()))).clone())
    }
    fn load_secret(&self, record: &SavedConnection) -> Result<SecretMap, AppError> {
        if let Some(secret) = lock(&self.state)?.temporary_secrets.get(&record.id).cloned() { return Ok(secret) }
        if record.legacy_secret_requires_reentry { return Err(AppError::new("secret-reentry-required", "旧版Electron密文无法在原生核心解密，请重新录入凭据；旧文件已保留")) }
        if record.config.dialect_id == "sqlite" { return Ok(SecretMap::new()) }
        self.secrets.get(&record.secret_key).map(|value| value.unwrap_or_default()).map_err(|_| secret_error())
    }
    fn connect(&self, id: &str) -> Result<Value, AppError> {
        let gate = self.gate(id)?; let _guard = lock(&gate)?;
        self.connect_locked(id)
    }
    fn connect_locked(&self, id: &str) -> Result<Value, AppError> {
        let record = self.record(id)?;
        let already_connected = lock(&self.state)?.sessions.get(id).is_some_and(|session| session.is_active());
        if already_connected { return self.summary(id) }
        let secret = self.load_secret(&record)?;
        let driver = (self.factory)(&record.config, &secret).map_err(safe_error)?;
        let session = Session::new(id.into(), driver);
        {
            let mut state = lock(&self.state)?;
            if state.closed || !state.connections.iter().any(|item| item.id == id) {
                drop(state); let _ = session.disconnect(); return Err(crate::closed())
            }
            state.sessions.insert(id.into(), session);
        }
        self.summary(id)
    }
    fn disconnect_session(&self, id: &str) -> Result<(), AppError> {
        let session = {
            let mut state = lock(&self.state)?;
            if !state.connections.iter().any(|item| item.id == id) { return Err(AppError::new("not-found", "连接不存在")) }
            let session = state.sessions.remove(id);
            state.cursors.retain(|_, cursor| cursor.connection_id != id);
            if let Some(session) = &session { session.mark_inactive() }
            session
        };
        if let Some(session) = session { session.disconnect().map_err(safe_error)? }
        Ok(())
    }
    fn update_connection(&self, args: &[Value]) -> Result<Value, AppError> {
        let id = connection_arg(args)?; let gate = self.gate(id)?; let _guard = lock(&gate)?;
        let old = self.record(id)?;
        let patch = args.get(1).and_then(Value::as_object).ok_or_else(|| AppError::invalid("连接更新必须是对象"))?;
        if patch.keys().any(|key| !["dialectId", "name", "options"].contains(&key.as_str())) { return Err(AppError::invalid("连接更新字段无效")) }
        let mut config = serde_json::to_value(&old.config).map_err(|_| storage::storage_error())?;
        for (key, value) in patch {
            if key == "options" {
                let options = value.as_object().ok_or_else(|| AppError::invalid("连接参数无效"))?;
                let target = config.get_mut("options").and_then(Value::as_object_mut).ok_or_else(storage::storage_error)?;
                for (name, option) in options { target.insert(name.clone(), option.clone()); }
            } else { config[key] = value.clone() }
        }
        let config = self.read_config(config)?;
        let mut record = SavedConnection { config, ..old.clone() };
        let secret_patch = args.get(2).filter(|value| !value.is_null());
        let next_secret = if let Some(patch) = secret_patch {
            normalize_secret(Some(patch))?;
            let mut secret = if old.legacy_secret_requires_reentry { SecretMap::new() } else { self.load_secret(&old)? };
            match patch {
                Value::String(value) => { if value.is_empty() { secret.remove("dbPassword"); } else { secret.insert("dbPassword".into(), json!(value)); } },
                Value::Object(values) => for (key, value) in values {
                    if value.as_str() == Some("") { secret.remove(key); } else { secret.insert(key.clone(), value.clone()); }
                },
                _ => return Err(AppError::invalid("凭据更新格式无效")),
            }
            // Stage credentials under a new key. The old config/key pair remains valid until disk commit.
            record.secret_key = format!("dbstudio-native-{}", Uuid::new_v4());
            if !secret.is_empty() { self.secrets.set(&record.secret_key, &secret).map_err(|_| secret_error())?; }
            record.legacy_secret_requires_reentry = false;
            Some(secret)
        } else { None };
        let staged_key = secret_patch.map(|_| record.secret_key.clone());
        let committed = (|| {
            let mut state = lock(&self.state)?;
            if state.closed { return Err(crate::closed()) }
            let mut next = state.connections.clone();
            let target = next.iter_mut().find(|item| item.id == id).ok_or_else(|| AppError::new("not-found", "连接不存在"))?;
            *target = record;
            storage::save_connections(&self.base_dir, &next)?;
            state.connections = next;
            if let Some(secret) = next_secret { state.temporary_secrets.insert(id.into(), secret); }
            let session = state.sessions.remove(id);
            state.cursors.retain(|_, cursor| cursor.connection_id != id);
            if let Some(session) = &session { session.mark_inactive() }
            Ok::<_, AppError>(session)
        })();
        let session = match committed {
            Ok(session) => session,
            Err(error) => {
                if let Some(key) = staged_key { let _ = self.secrets.remove(&key); }
                return Err(error)
            }
        };
        let reconnect = session.is_some();
        if let Some(session) = session { session.disconnect().map_err(safe_error)? }
        let cleanup_failed = staged_key.is_some() && self.secrets.remove(&old.secret_key).is_err();
        if reconnect { let _ = self.connect_locked(id); }
        let mut summary = self.summary(id)?;
        if cleanup_failed {
            summary["warnings"].as_array_mut().map(|warnings| warnings.push(json!("连接已更新，但旧凭据未能清理")));
            if summary.get("warnings").and_then(Value::as_array).is_none() { summary["warnings"] = json!(["连接已更新，但旧凭据未能清理"]) }
        }
        Ok(summary)
    }
    pub(crate) fn summaries(&self) -> Result<Vec<Value>, AppError> {
        let ids = lock(&self.state)?.connections.iter().map(|item| item.id.clone()).collect::<Vec<_>>();
        ids.iter().map(|id| self.summary(id)).collect()
    }
    fn summary(&self, id: &str) -> Result<Value, AppError> {
        let (record, session) = {
            let state = lock(&self.state)?;
            let record = state.connections.iter().find(|item| item.id == id).cloned().ok_or_else(|| AppError::new("not-found", "连接不存在"))?;
            (record, state.sessions.get(id).filter(|session| session.is_active()).cloned())
        };
        let (stored, secret_unavailable) = match self.secrets.get(&record.secret_key) { Ok(secret) => (secret.is_some_and(|secret| !secret.is_empty()), false), Err(_) => (false, true) };
        let secret_stored = if record.config.dialect_id == "sqlite" { Value::Null } else { json!(stored) };
        let mut summary = json!({"id":record.id,"name":record.config.name,"dialectId":record.config.dialect_id,
            "connected":session.is_some(),"capabilities":session.as_ref().map(|session| session.capabilities.clone()),
            "persisted":true,"secretStored":secret_stored,"options":record.config.options});
        let mut warnings = Vec::new();
        if record.legacy_secret_requires_reentry { warnings.push("旧版Electron凭据需要重新录入，旧文件已保留"); }
        if secret_unavailable { warnings.push("安全凭据存储不可用，不会明文保存"); }
        if !warnings.is_empty() { summary["warnings"] = json!(warnings) }
        Ok(summary)
    }
    pub(crate) fn sqlite_database_paths(&self) -> Result<Vec<PathBuf>, AppError> {
        let state = lock(&self.state)?;
        if state.closed { return Err(crate::closed()) }
        Ok(crate::sqlite_database_paths_in(&state))
    }
}
fn connection_arg(args: &[Value]) -> Result<&str, AppError> {
    let value = crate::str_arg(args, 0)?;
    let (id, _) = parse_node_or_connection(value)?;
    Ok(id)
}
