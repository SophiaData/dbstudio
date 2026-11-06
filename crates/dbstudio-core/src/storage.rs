use crate::AppError;
use dbstudio_protocol::ConnectionConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fs::{self, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SavedConnection {
    pub id: String,
    pub config: ConnectionConfig,
    pub secret_key: String,
    #[serde(default)] pub legacy_secret_requires_reentry: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectionsFile {
    pub schema_version: u32,
    pub connections: Vec<SavedConnection>,
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Library {
    pub history: Vec<Value>,
    pub saved: Vec<Value>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LibraryFile { schema_version: u32, library: Library }

pub(crate) fn storage_error() -> AppError { AppError::new("storage-failed", "无法安全读取或保存应用数据；原文件保持保留") }
fn regular_file(path: &Path) -> Result<bool, AppError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(storage_error()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(storage_error()),
    }
}
pub(crate) fn read_json(path: &Path) -> Result<Option<Value>, AppError> {
    if !regular_file(path)? { return Ok(None) }
    let file = fs::File::open(path).map_err(|_| storage_error())?;
    if file.metadata().map_err(|_| storage_error())?.len() > 8 * 1024 * 1024 { return Err(storage_error()) }
    let mut bytes = Vec::new();
    file.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| storage_error())?;
    if bytes.len() > 8 * 1024 * 1024 { return Err(storage_error()) }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| storage_error())
}
pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), AppError> {
    regular_file(path)?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| storage_error())?;
    if bytes.len().saturating_add(1) > 8 * 1024 * 1024 { return Err(AppError::new("resource-limit", "应用数据超过8MiB上限，原文件和内存状态保持不变")) }
    let parent = path.parent().ok_or_else(storage_error)?;
    let temp: PathBuf = parent.join(format!(".dbstudio-{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&temp).map_err(|_| storage_error())?;
    file.write_all(&bytes).and_then(|_| file.write_all(b"\n")).and_then(|_| file.sync_all()).map_err(|_| storage_error())?;
    // temp 与目标都在核心控制的同一目录；不删除旧版文件或失败后的临时文件。
    fs::rename(&temp, path).map_err(|_| storage_error())?;
    Ok(())
}
pub(crate) fn validate_config(config: &ConnectionConfig) -> Result<(), AppError> {
    if config.name.trim().is_empty() || config.dialect_id.trim().is_empty() || config.name.len() > 1024 {
        return Err(AppError::invalid("连接名称或方言无效"))
    }
    for (key, value) in &config.options {
        let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
        if ["password", "dbpassword", "sshpassword", "sshpassphrase", "token", "accesstoken", "apikey", "secret", "privatekeydata"].contains(&normalized.as_str()) {
            return Err(AppError::invalid("机密参数必须使用独立凭据通道"))
        }
        if !value.is_string() && !value.is_number() && !value.is_boolean() { return Err(AppError::invalid("连接参数必须是字符串、数字或布尔值")) }
    }
    Ok(())
}
/// Validate the legacy path only when a loader actually needs to import from it.
/// Existing native v2 files do not depend on an obsolete framework directory staying accessible.
fn migration_source<'a>(base: &'a Path, legacy_dir: Option<&'a Path>) -> Result<&'a Path, AppError> {
    let Some(path) = legacy_dir else { return Ok(base) };
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => Err(storage_error()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(storage_error()),
        _ => Ok(path),
    }
}
pub(crate) fn load_connections(base: &Path, legacy_dir: Option<&Path>) -> Result<(Vec<SavedConnection>, Value), AppError> {
    let v2 = base.join("connections-v2.json");
    if let Some(value) = read_json(&v2)? {
        let file: ConnectionsFile = serde_json::from_value(value).map_err(|_| storage_error())?;
        if file.schema_version != 2 { return Err(storage_error()) }
        let mut seen = HashSet::new();
        for item in &file.connections {
            validate_config(&item.config)?;
            if item.id.is_empty() || item.id.contains('|') || item.secret_key.is_empty() || !seen.insert(item.id.clone()) { return Err(storage_error()) }
        }
        let legacy = file.connections.iter().any(|item| item.legacy_secret_requires_reentry);
        return Ok((file.connections, migration_status(false, legacy)))
    }
    let source = migration_source(base, legacy_dir)?;
    let Some(value) = read_json(&source.join("connections.json"))? else {
        return Ok((Vec::new(), migration_status(false, false)))
    };
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) { return Err(storage_error()) }
    let entries = value.get("connections").and_then(Value::as_array).ok_or_else(storage_error)?;
    // 仅检查旧密文文件存在，不读取其内容，也绝不尝试跨框架解密。
    let has_old_secrets = regular_file(&source.join("secrets.json"))?;
    let mut seen = HashSet::new();
    let mut connections = Vec::new();
    for entry in entries {
        let id = entry.get("id").and_then(Value::as_str).filter(|id| !id.is_empty() && !id.contains('|')).ok_or_else(storage_error)?;
        if !seen.insert(id.to_owned()) { return Err(storage_error()) }
        let config: ConnectionConfig = serde_json::from_value(entry.get("config").cloned().ok_or_else(storage_error)?).map_err(|_| storage_error())?;
        validate_config(&config)?;
        let legacy_secret_requires_reentry = has_old_secrets && config.dialect_id != "sqlite";
        connections.push(SavedConnection { id: id.into(), config, secret_key: format!("dbstudio-native-{}", Uuid::new_v4()), legacy_secret_requires_reentry });
    }
    let legacy = connections.iter().any(|item| item.legacy_secret_requires_reentry);
    write_json(&v2, &ConnectionsFile { schema_version: 2, connections: connections.clone() })?;
    Ok((connections, migration_status(true, legacy)))
}
fn migration_status(imported: bool, legacy: bool) -> Value {
    json!({"legacyConfigImported": imported, "legacySecretsRequireReentry": legacy,
        "warnings": if legacy { vec!["旧版Electron密文无法由原生核心解密，请重新录入凭据；旧文件已保留"] } else { Vec::<&str>::new() }})
}
pub(crate) fn save_connections(base: &Path, connections: &[SavedConnection]) -> Result<(), AppError> {
    write_json(&base.join("connections-v2.json"), &ConnectionsFile { schema_version: 2, connections: connections.to_vec() })
}
pub(crate) fn load_library(base: &Path, legacy_dir: Option<&Path>) -> Result<(Library, bool, bool), AppError> {
    if let Some(value) = read_json(&base.join("sql-library-v2.json"))? {
        let file: LibraryFile = serde_json::from_value(value).map_err(|_| storage_error())?;
        if file.schema_version != 2 { return Err(storage_error()) }
        validate_library(&file.library)?;
        return Ok((file.library, false, false))
    }
    let source = migration_source(base, legacy_dir)?;
    let mut library = Library::default();
    let mut history_imported = false;
    let mut saved_imported = false;
    for (name, history) in [("sql-history.json", true), ("saved-sql.json", false)] {
        if let Some(value) = read_json(&source.join(name))? {
            if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) { return Err(storage_error()) }
            let entries = value.get("entries").and_then(Value::as_array).ok_or_else(storage_error)?.clone();
            if history { library.history = entries.into_iter().take(500).collect(); history_imported = true; }
            else { library.saved = entries; saved_imported = true; }
        }
    }
    validate_library(&library)?;
    if history_imported || saved_imported { save_library(base, &library)?; }
    Ok((library, history_imported, saved_imported))
}
fn validate_library(library: &Library) -> Result<(), AppError> {
    for entry in &library.saved {
        let object = entry.as_object().ok_or_else(storage_error)?;
        if object.keys().any(|key| !["id", "name", "sql", "updatedAt"].contains(&key.as_str())) ||
            ["id", "name", "sql"].iter().any(|key| !entry.get(*key).and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty())) ||
            entry.get("updatedAt").and_then(Value::as_u64).is_none() { return Err(storage_error()) }
    }
    for entry in &library.history {
        let object = entry.as_object().ok_or_else(storage_error)?;
        if object.keys().any(|key| !["id", "sql", "connectionId", "connectionName", "dialectId", "startedAt", "elapsedMs", "status", "error", "returnedRows"].contains(&key.as_str())) ||
            ["id", "sql", "connectionId", "connectionName", "dialectId"].iter().any(|key| entry.get(*key).and_then(Value::as_str).is_none()) ||
            !entry.get("sql").and_then(Value::as_str).is_some_and(|sql| !sql.trim().is_empty()) ||
            entry.get("startedAt").and_then(Value::as_u64).is_none() ||
            !entry.get("elapsedMs").and_then(Value::as_f64).is_some_and(|elapsed| elapsed.is_finite() && elapsed >= 0.0) ||
            !entry.get("status").and_then(Value::as_str).is_some_and(|status| ["success", "error"].contains(&status)) ||
            !entry.get("error").is_some_and(|error| error.is_null() || error.is_string()) ||
            !entry.get("returnedRows").is_some_and(|rows| rows.is_null() || rows.as_u64().is_some()) { return Err(storage_error()) }
    }
    Ok(())
}
pub(crate) fn save_library(base: &Path, library: &Library) -> Result<(), AppError> {
    write_json(&base.join("sql-library-v2.json"), &LibraryFile { schema_version: 2, library: library.clone() })
}
