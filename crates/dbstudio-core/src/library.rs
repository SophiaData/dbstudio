use crate::{session::lock, storage, AppError, Application};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64 }
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, AppError> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| AppError::invalid("SQL历史字段无效"))
}
impl Application {
    pub(crate) fn library_call(&self, method: &str, args: &[Value]) -> Option<Result<Value, AppError>> {
        if !["listSqlLibrary", "recordSqlHistory", "saveSql", "removeSavedSql", "clearSqlHistory"].contains(&method) { return None }
        Some((|| {
            let mut state = lock(&self.state)?;
            if state.closed { return Err(crate::closed()) }
            if method == "listSqlLibrary" { return serde_json::to_value(&state.library).map_err(|_| storage::storage_error()) }
            let mut library = state.library.clone();
            let result = match method {
                "recordSqlHistory" => {
                    let input = args.first().filter(|value| value.is_object()).ok_or_else(|| AppError::invalid("缺少SQL历史"))?;
                    let sql = text(input, "sql")?.trim();
                    let connection_id = text(input, "connectionId")?;
                    let dialect_id = text(input, "dialectId")?;
                    let status = text(input, "status")?;
                    let elapsed = input.get("elapsedMs").and_then(Value::as_f64).filter(|value| value.is_finite() && *value >= 0.0).ok_or_else(|| AppError::invalid("执行耗时无效"))?;
                    if sql.is_empty() || !["success", "error"].contains(&status) { return Err(AppError::invalid("SQL历史无效")) }
                    let returned = match input.get("returnedRows") { None | Some(Value::Null) => Value::Null,
                        Some(value) if value.as_u64().is_some() => value.clone(), _ => return Err(AppError::invalid("返回行数无效")) };
                    let name = state.connections.iter().find(|item| item.id == connection_id).map(|item| item.config.name.as_str()).unwrap_or("已移除的连接");
                    let entry = json!({"id": Uuid::new_v4().to_string(), "sql": sql, "connectionId":connection_id,
                        "connectionName":name, "dialectId":dialect_id, "startedAt":now(), "elapsedMs":elapsed.round(),
                        "status":status, "error":if status == "error" { json!("SQL执行失败") } else { Value::Null },
                        "returnedRows":if status == "success" { returned } else { Value::Null }});
                    library.history.insert(0, entry.clone()); library.history.truncate(500); entry
                },
                "saveSql" => {
                    let id = match args.first() { Some(Value::Null) => None, Some(Value::String(id)) => Some(id.clone()), _ => return Err(AppError::invalid("收藏ID无效")) };
                    let name = crate::str_arg(args, 1)?.trim(); let sql = crate::str_arg(args, 2)?.trim();
                    if name.is_empty() || sql.is_empty() { return Err(AppError::invalid("收藏名称与SQL不能为空")) }
                    if let Some(id) = &id {
                        if !library.saved.iter().any(|entry| entry.get("id").and_then(Value::as_str) == Some(id)) { return Err(AppError::new("not-found", "收藏不存在")) }
                        library.saved.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id));
                    }
                    let entry = json!({"id":id.unwrap_or_else(|| Uuid::new_v4().to_string()),"name":name,"sql":sql,"updatedAt":now()});
                    library.saved.insert(0, entry.clone()); entry
                },
                "removeSavedSql" => { let id = crate::str_arg(args, 0)?; library.saved.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id)); Value::Null },
                "clearSqlHistory" => { library.history.clear(); Value::Null },
                _ => unreachable!(),
            };
            storage::save_library(&self.base_dir, &library)?;
            state.library = library;
            Ok(result)
        })())
    }
}
