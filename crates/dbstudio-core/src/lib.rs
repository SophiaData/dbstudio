//! Portable application owner: no Tauri, Node, Electron or JavaScript fallback.
mod connections;
mod compare;
mod data_tasks;
mod library;
mod session;
mod storage;
#[cfg(test)]
mod tests;
#[cfg(any(test, feature = "fixture-memory-secrets"))]
mod secret_store;
#[cfg(any(test, feature = "fixture-memory-secrets"))]
pub use secret_store::MemorySecretStore;

use dbstudio_protocol::{ConnectionConfig, Driver, SecretMap};
use serde_json::{json, Value};
use session::{lock, stale, Session};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use storage::{Library, SavedConnection};
use uuid::Uuid;

pub use dbstudio_protocol::DriverError as AppError;

/// Production shells inject their OS credential store. Keys are opaque core-owned IDs.
pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<SecretMap>, AppError>;
    fn set(&self, key: &str, secret: &SecretMap) -> Result<(), AppError>;
    fn remove(&self, key: &str) -> Result<(), AppError>;
}
type DriverFactory = dyn Fn(&ConnectionConfig, &SecretMap) -> Result<Box<dyn Driver>, AppError> + Send + Sync;
struct Cursor { connection_id: String, generation: String, raw_id: String }
struct State {
    connections: Vec<SavedConnection>,
    sessions: HashMap<String, Arc<Session>>,
    gates: HashMap<String, Arc<Mutex<()>>>,
    cursors: HashMap<String, Cursor>,
    temporary_secrets: HashMap<String, SecretMap>,
    library: Library,
    migration: Value,
    closed: bool,
}

pub struct Application {
    base_dir: PathBuf,
    secrets: Arc<dyn SecretStore>,
    state: Arc<Mutex<State>>,
    factory: Arc<DriverFactory>,
    pub(crate) tasks: data_tasks::TaskRegistry,
}
fn sqlite_database_paths_in(state: &State) -> Vec<PathBuf> {
    state.connections.iter().filter(|item| item.config.dialect_id == "sqlite")
        .filter_map(|item| item.config.options.get("file").and_then(Value::as_str))
        .filter(|file| *file != ":memory:").map(PathBuf::from).collect()
}
fn checked_export_destination(state: &State, path: &Path, protected_root: &Path) -> Result<(), AppError> {
    if !path.is_absolute() { return Err(AppError::invalid("导出目标必须是绝对路径")) }
    data_tasks::destination_allowed(path, &sqlite_database_paths_in(state), protected_root)
}
/// Validate and perform the destination-creating filesystem operation under one
/// state lock. Background workers use this same helper with their captured state.
pub(crate) fn with_export_destination_shared<T>(
    state: &Arc<Mutex<State>>,
    protected_root: &Path,
    path: &Path,
    publish: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let state = lock(state)?;
    if state.closed { return Err(closed()) }
    checked_export_destination(&state, path, protected_root)?;
    let value = publish()?;
    drop(state);
    Ok(value)
}
pub(crate) fn closed() -> AppError { AppError::new("backend-unavailable", "应用核心已关闭") }
pub(crate) fn str_arg(args: &[Value], index: usize) -> Result<&str, AppError> {
    args.get(index).and_then(Value::as_str).ok_or_else(|| AppError::invalid("缺少有效字符串参数"))
}
pub(crate) fn safe_error(error: AppError) -> AppError {
    let (code, message) = match error.code.as_str() {
        "cancelled" => ("cancelled", "操作已取消"),
        "timeout" => ("timeout", "数据库操作超时"),
        "unsupported" => ("unsupported", "当前驱动不支持此操作"),
        "invalid-argument" => ("invalid-argument", "数据库操作参数无效"),
        "not-found" => ("not-found", "数据库对象或会话不存在"),
        "conflict" => ("conflict", "数据库操作与当前状态冲突"),
        "commit-outcome-unknown" | "commit_outcome_unknown" => ("commit-outcome-unknown", "事务提交结果未知，请重新连接后核对数据库"),
        _ => ("driver-failed", "数据库操作失败，请检查连接或查询配置"),
    };
    AppError::new(code, message)
}
impl Application {
    pub fn open(base_dir: PathBuf, secrets: Arc<dyn SecretStore>) -> Result<Self, AppError> {
        Self::open_with_legacy(base_dir, secrets, None)
    }
    /// The shell explicitly supplies the old framework's directory. The core never searches user directories.
    pub fn open_with_legacy(base_dir: PathBuf, secrets: Arc<dyn SecretStore>, legacy_dir: Option<PathBuf>) -> Result<Self, AppError> {
        Self::open_internal(base_dir, secrets, legacy_dir, Arc::new(dbstudio_drivers::connect))
    }
    #[cfg(test)]
    fn open_with_factory(base_dir: PathBuf, secrets: Arc<dyn SecretStore>, factory: Arc<DriverFactory>) -> Result<Self, AppError> {
        Self::open_internal(base_dir, secrets, None, factory)
    }
    fn open_internal(base_dir: PathBuf, secrets: Arc<dyn SecretStore>, legacy_dir: Option<PathBuf>, factory: Arc<DriverFactory>) -> Result<Self, AppError> {
        if !base_dir.is_absolute() || legacy_dir.as_ref().is_some_and(|path| !path.is_absolute()) { return Err(AppError::invalid("应用与旧版数据目录必须是绝对路径")) }
        if let Ok(meta) = std::fs::symlink_metadata(&base_dir) {
            if !meta.is_dir() || meta.file_type().is_symlink() { return Err(storage::storage_error()) }
        } else {
            let mut builder = std::fs::DirBuilder::new(); builder.recursive(true);
            #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
            builder.create(&base_dir).map_err(|_| storage::storage_error())?;
        }
        let (connections, mut migration) = storage::load_connections(&base_dir, legacy_dir.as_deref())?;
        let (library, history_imported, saved_imported) = storage::load_library(&base_dir, legacy_dir.as_deref())?;
        migration["legacySqlHistoryImported"] = json!(history_imported);
        migration["legacySavedSqlImported"] = json!(saved_imported);
        Ok(Self { base_dir, secrets, factory, tasks: data_tasks::TaskRegistry::default(), state: Arc::new(Mutex::new(State {
            connections, migration, library, sessions: HashMap::new(), gates: HashMap::new(),
            cursors: HashMap::new(), temporary_secrets: HashMap::new(), closed: false,
        })) })
    }
    /// Shared preflight for native save dialogs. This method never writes or reserves a file.
    /// Callers that create a destination must use `with_export_destination`.
    pub fn validate_export_destination(&self, path: &Path) -> Result<(), AppError> {
        if lock(&self.state)?.closed { return Err(closed()) }
        if !path.is_absolute() { return Err(AppError::invalid("导出目标必须是绝对路径")) }
        data_tasks::destination_allowed(path, &self.sqlite_database_paths()?, &self.base_dir)
    }
    /// Keep live destination validation and the atomic create/link in the same
    /// state critical section. The closure is shell-controlled and must only
    /// create the reserved target (or publish the completed partial file).
    pub fn with_export_destination<T>(
        &self,
        path: &Path,
        publish: impl FnOnce() -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        with_export_destination_shared(&self.state, &self.base_dir, path, publish)
    }
    pub fn call(&self, method: &str, args: Vec<Value>) -> Result<Value, AppError> {
        if lock(&self.state)?.closed { return Err(closed()) }
        if let Some(result) = self.connection_call(method, &args) { return result }
        if let Some(result) = self.library_call(method, &args) { return result }
        if let Some(result) = data_tasks::dispatch(self, method, &args) { return result }
        if matches!(method, "captureSchemaSnapshot" | "compareTableData") {
            return compare::dispatch(self, method, args).unwrap_or_else(|| Err(AppError::unsupported("比较接口尚未迁移")))
        }
        match method {
            "listDialects" => Ok(dbstudio_drivers::dialects()),
            "migrationStatus" => {
                let state = lock(&self.state)?;
                let mut status = state.migration.clone();
                let requires_reentry = state.connections.iter().any(|item| item.legacy_secret_requires_reentry);
                status["legacySecretsRequireReentry"] = json!(requires_reentry);
                status["warnings"] = if requires_reentry { json!(["旧版Electron密文无法由原生核心解密，请重新录入凭据；旧文件已保留"]) } else { json!([]) };
                Ok(status)
            },
            "listChildren" => self.list_children(args.first()),
            "cancelQuery" => {
                let session = self.capture_session(str_arg(&args, 0)?)?;
                let signal = args.get(1).filter(|value| !value.is_null()).map(|value| value.as_str().ok_or_else(|| AppError::invalid("signalId无效"))).transpose()?;
                session.cancel(signal).map(json_bool).map_err(safe_error)
            },
            "fetchResultPage" | "fetchCellValue" | "closeCursor" => self.cursor_call(method, &args),
            "runQuery" | "executeStatement" | "explain" => {
                let node = str_arg(&args, 0)?;
                str_arg(&args, 1)?;
                let session = self.capture_session(node)?;
                let mut result = session.call(method, args[1..].to_vec()).map_err(safe_error)?;
                self.ensure_session(&session)?;
                if method == "runQuery" { self.scope_query(&session, &mut result)? }
                if method == "executeStatement" && result.get("kind").and_then(Value::as_str) == Some("rows") {
                    self.scope_query(&session, result.get_mut("result").ok_or_else(|| AppError::new("internal", "驱动结果格式无效"))?)?;
                }
                Ok(result)
            },
            "previewTable" => {
                let node = str_arg(&args, 0)?;
                let (_, raw) = parse_node(node)?;
                let raw = raw.ok_or_else(|| AppError::invalid("请选择表或视图"))?;
                if !raw.starts_with("table:") && !raw.starts_with("view:") { return Err(AppError::invalid("只能预览表或视图")) }
                let limit = args.get(1).and_then(Value::as_u64).unwrap_or(200).clamp(1, 10_000);
                let session = self.capture_session(node)?;
                let sql = session.call("tableSelectSql", vec![json!(raw)]).map_err(safe_error)?;
                let mut result = session.call("runQuery", vec![sql, json!({"limit":limit})]).map_err(safe_error)?;
                self.ensure_session(&session)?;
                if result.get("returned").and_then(Value::as_u64).unwrap_or(0) > limit { return Err(AppError::new("internal", "驱动结果超出请求限制")) }
                self.scope_query(&session, &mut result)?; Ok(result)
            },
            "transactionState" | "commitTransaction" | "rollbackTransaction" => self.driver_call(str_arg(&args, 0)?, method, Vec::new()),
            "createTable" | "createView" => self.driver_call(str_arg(&args, 0)?, method, args[1..].to_vec()),
            "describeTable" | "tableSelectSql" | "applyEdits" | "insertRow" | "deleteRows" | "countRows" | "dropTable" | "dropView" | "renameTable" => {
                let node = str_arg(&args, 0)?;
                let (_, raw) = parse_node(node)?;
                let raw = raw.ok_or_else(|| AppError::invalid("请选择具体数据库对象"))?;
                let mut forwarded = vec![json!(raw)]; forwarded.extend_from_slice(&args[1..]);
                let mut result = self.driver_call(node, method, forwarded)?;
                if method == "describeTable" { result["id"] = json!(node) }
                Ok(result)
            },
            _ => Err(AppError::unsupported("此接口尚未迁移到原生核心")),
        }
    }
    pub fn close(&self) -> Result<(), AppError> {
        let sessions = {
            let mut state = lock(&self.state)?;
            if state.closed { return Ok(()) }
            state.closed = true;
            state.cursors.clear(); state.temporary_secrets.clear();
            let sessions = state.sessions.drain().map(|(_, session)| session).collect::<Vec<_>>();
            sessions
        };
        // Wait outside the global state lock so workers can finish their rollback/close paths.
        let mut failed = self.tasks.cancel_all().is_err();
        if self.tasks.wait_all().is_err() { failed = true }
        for session in sessions { session.mark_inactive(); if session.disconnect().is_err() { failed = true } }
        if failed { Err(AppError::new("driver-failed", "部分数据库会话关闭失败")) } else { Ok(()) }
    }
    /// Linearize registration with close(): keep the state -> task registry lock order.
    /// The closure must only register; it must not call back into Application or run a worker.
    pub(crate) fn with_task_registration<T>(
        &self,
        register: impl FnOnce() -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let state = lock(&self.state)?;
        if state.closed { return Err(closed()) }
        let result = register();
        drop(state);
        result
    }
    pub(crate) fn capture_session(&self, node_id: &str) -> Result<Arc<Session>, AppError> {
        let (id, _) = parse_node_or_connection(node_id)?;
        let state = lock(&self.state)?;
        if state.closed { return Err(closed()) }
        state.sessions.get(id).filter(|session| session.is_active()).cloned().ok_or_else(stale)
    }
    pub(crate) fn ensure_session(&self, session: &Arc<Session>) -> Result<(), AppError> {
        let state = lock(&self.state)?;
        if state.closed || !session.is_active() || !state.sessions.get(&session.connection_id).is_some_and(|current| Arc::ptr_eq(current, session)) { return Err(stale()) }
        Ok(())
    }
    pub(crate) fn driver_call(&self, node_id: &str, method: &str, args: Vec<Value>) -> Result<Value, AppError> {
        let session = self.capture_session(node_id)?;
        let result = session.call(method, args).map_err(safe_error)?;
        self.ensure_session(&session)?;
        Ok(result)
    }
    fn list_children(&self, node: Option<&Value>) -> Result<Value, AppError> {
        if node.is_none() || node == Some(&Value::Null) {
            return Ok(Value::Array(self.summaries()?.iter().map(|item| json!({
                "id":format!("connection:{}", item["id"].as_str().unwrap_or("")), "kind":"connection", "name":item["name"],
                "parentId":null, "hasChildren":item["connected"], "meta":{"dialectId":item["dialectId"],"connected":item["connected"]}
            })).collect()))
        }
        let node = node.and_then(Value::as_str).ok_or_else(|| AppError::invalid("节点ID无效"))?;
        let (id, raw) = parse_node(node)?;
        let result = self.driver_call(node, "listChildren", vec![raw.map_or(Value::Null, |id| json!(id))])?;
        let nodes = result.as_array().ok_or_else(|| AppError::new("internal", "驱动元数据格式无效"))?;
        let mut scoped = Vec::new();
        for item in nodes {
            let mut item = item.clone();
            let raw_id = item.get("id").and_then(Value::as_str).ok_or_else(|| AppError::new("internal", "驱动元数据ID无效"))?.to_owned();
            let parent = item.get("parentId").and_then(Value::as_str).map(|parent| format!("connection:{id}|{parent}")).unwrap_or_else(|| format!("connection:{id}"));
            item["id"] = json!(format!("connection:{id}|{raw_id}")); item["parentId"] = json!(parent); scoped.push(item);
        }
        Ok(Value::Array(scoped))
    }
    fn scope_query(&self, session: &Arc<Session>, result: &mut Value) -> Result<(), AppError> {
        let Some(raw) = result.get("cursorId").and_then(Value::as_str).map(str::to_owned) else { return Ok(()) };
        let mut state = lock(&self.state)?;
        if state.closed || !session.is_active() || !state.sessions.get(&session.connection_id).is_some_and(|current| Arc::ptr_eq(current, session)) { return Err(stale()) }
        let scoped = format!("connection:{}|cursor:{}", session.connection_id, Uuid::new_v4());
        state.cursors.insert(scoped.clone(), Cursor { connection_id:session.connection_id.clone(), generation:session.generation.clone(), raw_id:raw });
        result["cursorId"] = json!(scoped); Ok(())
    }
    fn cursor_call(&self, method: &str, args: &[Value]) -> Result<Value, AppError> {
        let id = str_arg(args, 0)?;
        let resolved = {
            let mut state = lock(&self.state)?;
            let Some(cursor) = state.cursors.get(id) else { return if method == "closeCursor" { Ok(Value::Null) } else { Err(stale()) } };
            let session = state.sessions.get(&cursor.connection_id).filter(|session| session.generation == cursor.generation && session.is_active()).cloned().ok_or_else(stale)?;
            let raw = cursor.raw_id.clone();
            if method == "closeCursor" { state.cursors.remove(id); }
            (session, raw)
        };
        let mut forwarded = vec![json!(resolved.1)]; forwarded.extend_from_slice(&args[1..]);
        let result = resolved.0.call(method, forwarded).map_err(safe_error)?;
        self.ensure_session(&resolved.0)?; Ok(result)
    }
}
fn json_bool(value: bool) -> Value { json!(value) }
pub(crate) fn parse_node(value: &str) -> Result<(&str, Option<&str>), AppError> {
    let rest = value.strip_prefix("connection:").ok_or_else(|| AppError::invalid("节点缺少连接作用域"))?;
    let (connection, raw) = rest.split_once('|').map_or((rest, None), |(id, raw)| (id, Some(raw)));
    if connection.is_empty() || raw == Some("") { return Err(AppError::invalid("节点作用域无效")) }
    Ok((connection, raw))
}
pub(crate) fn parse_node_or_connection(value: &str) -> Result<(&str, Option<&str>), AppError> {
    if value.starts_with("connection:") { parse_node(value) }
    else if !value.is_empty() && !value.contains('|') { Ok((value, None)) }
    else { Err(AppError::invalid("连接ID无效")) }
}
