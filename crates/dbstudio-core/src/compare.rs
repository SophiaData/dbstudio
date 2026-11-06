//! Read-only native snapshots/data comparison. Generated SQL is review material only.
use crate::{session::Session, AppError, Application};
use serde_json::{json, Map, Value};
use std::{cmp::Ordering, collections::{BTreeMap, BTreeSet}, sync::Arc};

const PAGE_ROWS: usize = 256;
const MAX_ROWS: usize = 500_000;
const MAX_OBJECTS: usize = 10_000;
const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_CELL_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn dispatch(app: &Application, method: &str, args: Vec<Value>) -> Option<Result<Value, AppError>> {
    match method {
        "captureSchemaSnapshot" => Some(capture_snapshot(app, &args)),
        "compareTableData" => Some(compare_tables(app, &args)),
        _ => None,
    }
}

fn invalid(message: &str) -> AppError { AppError::invalid(message) }
fn call(session: &Session, method: &str, args: Vec<Value>) -> Result<Value, AppError> {
    session.call(method, args).map_err(crate::safe_error)
}
fn optional_metadata(session: &Session, method: &str, args: Vec<Value>) -> Result<Option<Value>, AppError> {
    match call(session, method, args) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code == "unsupported" => { active(session)?; Ok(None) }
        Err(error) => Err(error),
    }
}
fn exceeded() -> AppError { AppError::new("resource-limit", "比较超过行数、对象数或数据大小上限，请缩小范围") }
fn active(session: &Session) -> Result<(), AppError> {
    if session.is_active() { Ok(()) } else { Err(crate::session::stale()) }
}
fn sql_dialect(session: &Session) -> Result<&str, AppError> {
    match session.dialect_id.as_str() {
        "sqlite" | "postgresql" | "mysql" => Ok(&session.dialect_id),
        _ => Err(AppError::unsupported("比较只支持 SQLite、PostgreSQL 和 MySQL 数据源")),
    }
}
fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str, AppError> {
    value.as_str().filter(|s| !s.is_empty() && !s.contains('\0'))
        .ok_or_else(|| invalid(name))
}
fn raw_node(node: &str) -> Result<(&str, Option<&str>), AppError> {
    let rest = node.strip_prefix("connection:").ok_or_else(|| invalid("无法解析的节点 id"))?;
    let (connection, raw) = match rest.split_once('|') { Some((a, b)) => (a, Some(b)), None => (rest, None) };
    if connection.is_empty() || raw == Some("") { return Err(invalid("无法解析的节点 id")); }
    Ok((connection, raw))
}
fn account(value: &Value, bytes: &mut usize) -> Result<(), AppError> {
    *bytes = bytes.checked_add(serde_json::to_vec(value).map_err(|_| invalid("比较值无法编码"))?.len()).ok_or_else(exceeded)?;
    if *bytes > MAX_BYTES { return Err(exceeded()); }
    Ok(())
}

struct Snapshot<'a> {
    session: &'a Session,
    schema: Option<&'a str>,
    tables: Vec<Value>,
    views: Vec<Value>,
    visited: BTreeSet<String>,
    identities: BTreeSet<(String, String, String)>,
    objects: usize,
    bytes: usize,
    found_schema: bool,
}
impl Snapshot<'_> {
    fn walk(&mut self, parent: Option<&str>, schema: Option<&str>, depth: usize) -> Result<(), AppError> {
        if depth > 4 { return Err(AppError::new("resource-limit", "元数据层级超过快照上限")); }
        let visit_key = parent.unwrap_or("").to_owned();
        if !self.visited.insert(visit_key) { return Err(invalid("元数据遍历出现重复节点")); }
        let nodes = call(self.session, "listChildren", vec![json!(parent)])?;
        let nodes = nodes.as_array().ok_or_else(|| invalid("驱动返回的元数据列表无效"))?;
        self.objects = self.objects.checked_add(nodes.len()).ok_or_else(exceeded)?;
        if self.objects > MAX_OBJECTS { return Err(exceeded()); }
        for node in nodes {
            let id = text(&node["id"], "元数据节点缺少 id")?;
            let name = text(&node["name"], "元数据节点缺少名称")?;
            match node["kind"].as_str() {
                Some("schema") => {
                    if self.schema.is_some_and(|wanted| wanted != name) { continue; }
                    self.found_schema = true;
                    self.walk(Some(id), Some(name), depth + 1)?;
                }
                Some("folder" | "catalog") => self.walk(Some(id), schema, depth + 1)?,
                Some(kind @ ("table" | "view")) => {
                    let identity = (kind.to_owned(), schema.unwrap_or("").to_owned(), name.to_owned());
                    if !self.identities.insert(identity) { return Err(invalid("快照中的对象重复")); }
                    let value = if kind == "table" {
                        let description = call(self.session, "describeTable", vec![json!(id)])?;
                        if !description["columns"].is_array() { return Err(invalid("驱动返回的表结构无效")); }
                        let mut description = description.as_object().cloned().ok_or_else(|| invalid("驱动返回的表结构无效"))?;
                        description.insert("schema".into(), json!(schema));
                        description.insert("name".into(), json!(name));
                        Value::Object(description)
                    } else {
                        let definition = match optional_metadata(self.session, "viewDefinition", vec![json!(id)])? {
                            Some(value) if value.is_null() || value.is_string() => value,
                            Some(_) => return Err(invalid("驱动返回的视图定义无效")),
                            None => Value::Null,
                        };
                        json!({"schema": schema, "name": name, "definition": definition})
                    };
                    account(&value, &mut self.bytes)?;
                    if kind == "table" { self.tables.push(value); } else { self.views.push(value); }
                }
                _ => {}
            }
        }
        active(self.session)
    }
}
fn capture_snapshot(app: &Application, args: &[Value]) -> Result<Value, AppError> {
    let connection = text(args.first().ok_or_else(|| invalid("缺少连接 id"))?, "缺少连接 id")?;
    if connection.contains('|') { return Err(invalid("结构快照需要连接 id")); }
    let connection = connection.strip_prefix("connection:").unwrap_or(connection);
    let schema = match args.get(1) { None | Some(Value::Null) => None, Some(v) => Some(text(v, "schema 必须是非空字符串或 null")?) };
    let session = app.capture_session(&format!("connection:{connection}"))?;
    let dialect = sql_dialect(&session)?;
    if dialect == "sqlite" && schema.is_some_and(|s| s != "main") { return Err(invalid("SQLite 结构快照只支持 main schema")); }
    let mut snapshot = Snapshot {
        session: &session, schema, tables: Vec::new(), views: Vec::new(),
        visited: BTreeSet::new(), identities: BTreeSet::new(), objects: 0, bytes: 0,
        found_schema: dialect == "sqlite" || schema.is_none(),
    };
    snapshot.walk(None, None, 0)?;
    if !snapshot.found_schema { return Err(AppError::new("not-found", "指定的 schema 不存在")); }
    let mut routines = match optional_metadata(&session, "listRoutines", vec![json!({"schema": schema})])? {
        Some(Value::Array(values)) => values,
        Some(_) => return Err(invalid("驱动返回的例程列表无效")),
        None => Vec::new(),
    };
    routines.retain(|v| schema.is_none_or(|wanted| v["schema"].as_str() == Some(wanted)));
    if snapshot.objects + routines.len() > MAX_OBJECTS { return Err(exceeded()); }
    for routine in &routines { account(routine, &mut snapshot.bytes)?; }
    let order = |a: &Value, b: &Value| (a["schema"].as_str().unwrap_or(""), a["name"].as_str().unwrap_or(""))
        .cmp(&(b["schema"].as_str().unwrap_or(""), b["name"].as_str().unwrap_or("")));
    snapshot.tables.sort_by(order);
    snapshot.views.sort_by(order);
    routines.sort_by(|a, b| order(a, b).then_with(|| a.to_string().cmp(&b.to_string())));
    app.ensure_session(&session)?;
    Ok(json!({"source": {"connectionId": connection, "schema": schema}, "tables": snapshot.tables, "views": snapshot.views, "routines": routines}))
}

#[derive(Clone)]
struct Table {
    session: Arc<Session>,
    schema: Option<String>,
    name: String,
    raw: String,
}
fn table(app: &Application, node: &str) -> Result<Table, AppError> {
    let (_, raw) = raw_node(node)?;
    let raw = raw.filter(|raw| raw.starts_with("table:")).ok_or_else(|| invalid("数据比较只接受表节点"))?;
    let session = app.capture_session(node)?;
    let dialect = sql_dialect(&session)?;
    let payload = raw.strip_prefix("table:").unwrap_or("");
    let (schema, name) = if dialect == "sqlite" {
        (None, payload.to_owned())
    } else {
        let mut head = String::new();
        let mut tail = String::new();
        let mut separator = false;
        let mut chars = payload.chars();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                let next = chars.next().ok_or_else(|| invalid("表 id 的转义不完整"))?;
                if separator { tail.push(next); } else { head.push(next); }
            } else if ch == '.' && !separator { separator = true; }
            else if separator { tail.push(ch); } else { head.push(ch); }
        }
        if !separator || head.is_empty() || tail.is_empty() { return Err(invalid("无法识别的 schema 表 id")); }
        (Some(head), tail)
    };
    if name.is_empty() || name.contains('\0') || schema.as_ref().is_some_and(|s| s.contains('\0')) { return Err(invalid("表名称无效")); }
    Ok(Table { session, schema, name, raw: raw.to_owned() })
}
fn columns(description: &Value) -> Result<Vec<Value>, AppError> {
    let columns = description["columns"].as_array().ok_or_else(|| invalid("表结构缺少列列表"))?;
    if columns.len() > MAX_OBJECTS { return Err(exceeded()); }
    let mut seen = BTreeSet::new();
    for column in columns {
        let name = text(&column["name"], "列名称无效")?;
        if !seen.insert(name) { return Err(invalid("表结构中列名称重复")); }
    }
    Ok(columns.clone())
}
fn binary(column: &Value) -> bool {
    column["typeName"].as_str().unwrap_or("").to_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .any(|part| ["blob", "tinyblob", "mediumblob", "longblob", "bytea", "binary", "varbinary", "image"].contains(&part))
}
fn quote(name: &str, dialect: &str) -> String {
    if dialect == "mysql" { format!("`{}`", name.replace('`', "``")) } else { format!("\"{}\"", name.replace('"', "\"\"")) }
}
fn qualified(table: &Table) -> String {
    let dialect = table.session.dialect_id.as_str();
    match &table.schema { Some(schema) => format!("{}.{}", quote(schema, dialect), quote(&table.name, dialect)), None => quote(&table.name, dialect) }
}
#[derive(Clone)]
struct Row { key: Map<String, Value>, values: Map<String, Value> }
type Rows = BTreeMap<String, Row>;

struct Cursor<'a> { session: &'a Session, id: Option<String> }
impl Drop for Cursor<'_> {
    fn drop(&mut self) { if let Some(id) = &self.id { let _ = call(self.session, "closeCursor", vec![json!(id)]); } }
}
fn scalar(cell: &Value) -> Result<Value, AppError> {
    match cell["kind"].as_str() {
        Some("null") => Ok(Value::Null),
        Some("number") if cell["value"].is_number() => {
            let value = &cell["value"];
            // Keep exact integers typed through key matching, value comparison and SQL generation.
            // JS-safe display conversion belongs only at the outbound row.key boundary.
            if value.is_i64() || value.is_u64() { Ok(value.clone()) }
            else if let Some(number) = value.as_f64().filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0) {
                Ok(json!(number as i64))
            } else { Ok(value.clone()) }
        }
        Some("boolean") if cell["value"].is_boolean() => Ok(cell["value"].clone()),
        Some("text") if cell["truncated"] != true => {
            let value = cell["text"].as_str().ok_or_else(|| invalid("文本单元格格式无效"))?;
            if value.len() > MAX_CELL_BYTES { return Err(exceeded()); }
            Ok(json!(value))
        }
        Some("text") => Err(invalid("长文本无法取全文，已停止比较")),
        Some("blob") => Err(AppError::unsupported("二进制单元格不参与数据比较")),
        _ => Err(invalid("驱动返回的比较单元格无效")),
    }
}
fn sqlite_scalar(cell: &Value, storage_type: &Value) -> Result<Value, AppError> {
    // The SQLite wire encoder represents unsafe INTEGERs as text. Column declarations do not
    // identify SQLite's per-row storage class, so use typeof() from the very same SELECT row.
    let kind = if storage_type["kind"] == "text" { storage_type["text"].as_str() } else { None }
        .ok_or_else(|| invalid("SQLite 比较缺少存储类型"))?;
    if kind == "integer" {
        let integer = match cell["kind"].as_str() {
            Some("number") => cell["value"].as_i64(),
            Some("text") if cell["truncated"] != true => cell["text"].as_str().and_then(|s| s.parse::<i64>().ok()),
            _ => None,
        }.ok_or_else(|| invalid("SQLite 整数无法精确读取"))?;
        return Ok(json!(integer));
    }
    if !["null", "real", "text", "blob"].contains(&kind) { return Err(invalid("SQLite 比较存储类型无效")); }
    scalar(cell)
}
fn display_key(key: &Map<String, Value>) -> Map<String, Value> {
    key.iter().map(|(name, value)| {
        let unsafe_integer = value.as_i64().is_some_and(|n| n.unsigned_abs() > 9_007_199_254_740_991)
            || value.as_u64().is_some_and(|n| n > 9_007_199_254_740_991);
        (name.clone(), if unsafe_integer { json!(value.to_string()) } else { value.clone() })
    }).collect()
}
fn read_rows(table: &Table, columns: &[String], keys: &[String], max_rows: usize, bytes: &mut usize) -> Result<Rows, AppError> {
    let dialect = table.session.dialect_id.as_str();
    let mut projection = columns.iter().map(|c| quote(c, dialect)).collect::<Vec<_>>();
    let mut result_names = columns.to_vec();
    if dialect == "sqlite" {
        for (index, column) in columns.iter().enumerate() {
            let alias = format!("__dbstudio_compare_type_{index}");
            projection.push(format!("typeof({}) AS {}", quote(column, dialect), quote(&alias, dialect)));
            result_names.push(alias);
        }
    }
    let sql = format!("SELECT {} FROM {} ORDER BY {} LIMIT {}",
        projection.join(", "), qualified(table),
        keys.iter().map(|c| quote(c, dialect)).collect::<Vec<_>>().join(", "), max_rows + 1);
    let first = call(&table.session, "runQuery", vec![json!(sql), json!({"limit": PAGE_ROWS, "keepCursor": true})])?;
    let cursor = Cursor { session: &table.session, id: first["cursorId"].as_str().map(str::to_owned) };
    let mut page = first;
    let mut offset = 0usize;
    let mut indexed = Rows::new();
    loop {
        let result_columns = page["columns"].as_array().ok_or_else(|| invalid("比较查询缺少结果列"))?;
        if result_columns.len() != result_names.len() || result_columns.iter().zip(&result_names).any(|(actual, expected)| actual["name"].as_str() != Some(expected.as_str())) {
            return Err(invalid("比较查询结果列与请求不一致"));
        }
        let rows = page["rows"].as_array().ok_or_else(|| invalid("比较查询缺少结果行"))?;
        if rows.len() > PAGE_ROWS { return Err(exceeded()); }
        let returned = page["returned"].as_u64().ok_or_else(|| invalid("比较分页行数无效"))? as usize;
        if returned != rows.len() || page["offset"].as_u64() != Some(offset as u64) { return Err(invalid("比较分页偏移无效")); }
        for (local, row) in rows.iter().enumerate() {
            if indexed.len() >= max_rows { return Err(exceeded()); }
            let index = row["index"].as_u64().ok_or_else(|| invalid("比较结果行下标无效"))?;
            if index != (offset + local) as u64 { return Err(invalid("比较结果行下标与分页不一致")); }
            let cells = row["cells"].as_array().filter(|c| c.len() == result_names.len()).ok_or_else(|| invalid("比较结果单元格数无效"))?;
            let mut values = Map::new();
            for (column_index, (column, cell)) in columns.iter().zip(cells).enumerate() {
                let full;
                let cell = if cell["kind"] == "text" && cell["truncated"] == true {
                    if cell["fullLength"].as_u64().is_some_and(|length| length > MAX_CELL_BYTES as u64) { return Err(exceeded()); }
                    let id = cursor.id.as_ref().ok_or_else(|| invalid("长文本缺少可读取的游标"))?;
                    full = call(&table.session, "fetchCellValue", vec![json!(id), json!(index), json!(column_index)])?;
                    &full
                } else { cell };
                let value = if dialect == "sqlite" {
                    sqlite_scalar(cell, &cells[columns.len() + column_index])?
                } else { scalar(cell)? };
                values.insert(column.clone(), value);
            }
            account(&Value::Object(values.clone()), bytes)?;
            let mut key = Map::new();
            let mut tuple = Vec::new();
            for column in keys {
                let value = values.get(column).ok_or_else(|| invalid("结果缺少比较键列"))?.clone();
                tuple.push(value.clone());
                key.insert(column.clone(), value);
            }
            let encoded = serde_json::to_string(&tuple).map_err(|_| invalid("比较键无法编码"))?;
            if indexed.insert(encoded, Row { key, values }).is_some() { return Err(invalid("比较键重复，不能按非唯一列比较")); }
        }
        let has_more = page["hasMore"].as_bool().ok_or_else(|| invalid("比较分页状态无效"))?;
        if !has_more { break; }
        if returned == 0 { return Err(invalid("比较游标没有向前推进")); }
        offset = offset.checked_add(returned).ok_or_else(exceeded)?;
        let id = cursor.id.as_ref().ok_or_else(|| invalid("未读完的比较结果缺少游标"))?;
        page = call(&table.session, "fetchResultPage", vec![json!(id), json!(offset), json!(PAGE_ROWS)])?;
    }
    active(&table.session)?;
    Ok(indexed)
}

fn compare_tables(app: &Application, args: &[Value]) -> Result<Value, AppError> {
    let request = args.first().and_then(Value::as_object).ok_or_else(|| invalid("缺少数据比较请求"))?;
    let source_node = request.get("sourceTableNodeId").ok_or_else(|| invalid("缺少源表节点"))?;
    let target_node = request.get("targetTableNodeId").ok_or_else(|| invalid("缺少目标表节点"))?;
    let source = table(app, text(source_node, "缺少源表节点")?)?;
    let target = table(app, text(target_node, "缺少目标表节点")?)?;
    if source.session.dialect_id != target.session.dialect_id {
        return Err(AppError::unsupported("跨方言数据比较暂不支持：两边的值类型映射不同，请改用结构比较"));
    }
    let max_rows = match request.get("maxRows") {
        None => 50_000,
        Some(value) => value.as_u64().filter(|n| *n > 0 && *n <= MAX_ROWS as u64).ok_or_else(|| invalid("maxRows 必须是 1 到 500000 的整数"))? as usize,
    };
    let source_columns = columns(&call(&source.session, "describeTable", vec![json!(source.raw)])?)?;
    let target_columns = columns(&call(&target.session, "describeTable", vec![json!(target.raw)])?)?;
    let mut primary: Vec<_> = source_columns.iter().filter(|c| c["primaryKeyOrdinal"].as_u64().is_some_and(|ordinal| ordinal > 0)).collect();
    primary.sort_by_key(|c| c["primaryKeyOrdinal"].as_u64());
    let keys: Vec<String> = match request.get("keyColumns") {
        None | Some(Value::Null) => primary.iter().map(|c| c["name"].as_str().unwrap_or("").to_owned()).collect(),
        Some(Value::Array(values)) if values.is_empty() => primary.iter().map(|c| c["name"].as_str().unwrap_or("").to_owned()).collect(),
        Some(Value::Array(values)) => values.iter().map(|v| text(v, "比较键必须是非空列名").map(str::to_owned)).collect::<Result<_, _>>()?,
        _ => return Err(invalid("keyColumns 必须是列名数组")),
    };
    if keys.is_empty() { return Err(invalid("源表没有主键，请指定一组唯一列作为比较键（不支持按行号比较）")); }
    if keys.len() > MAX_OBJECTS || keys.iter().collect::<BTreeSet<_>>().len() != keys.len() { return Err(invalid("比较键列重复或过多")); }
    let source_names: BTreeSet<_> = source_columns.iter().map(|c| c["name"].as_str().unwrap_or("")).collect();
    let target_names: BTreeSet<_> = target_columns.iter().map(|c| c["name"].as_str().unwrap_or("")).collect();
    if keys.iter().any(|c| !source_names.contains(c.as_str()) || !target_names.contains(c.as_str())) { return Err(invalid("源表或目标表缺少比较键列")); }
    let shared: Vec<String> = source_columns.iter().filter_map(|c| {
        let name = c["name"].as_str()?;
        target_names.contains(name).then(|| name.to_owned())
    }).collect();
    let binary: Vec<String> = shared.iter().filter(|name| source_columns.iter().chain(&target_columns).any(|c| c["name"].as_str() == Some(name.as_str()) && binary(c))).cloned().collect();
    if keys.iter().any(|key| binary.contains(key)) { return Err(AppError::unsupported("比较键不能是二进制列")); }
    let comparable: Vec<_> = shared.into_iter().filter(|c| !binary.contains(c)).collect();
    if comparable.is_empty() { return Err(invalid("两张表没有可比的非二进制列")); }
    let mut bytes = 0;
    let source_rows = read_rows(&source, &comparable, &keys, max_rows, &mut bytes)?;
    let target_rows = read_rows(&target, &comparable, &keys, max_rows, &mut bytes)?;
    let mut result = diff_rows(&source_rows, &target_rows, &keys, &target)?;
    let warnings = result["plan"]["warnings"].as_array_mut().ok_or_else(|| invalid("比较计划无效"))?;
    if !binary.is_empty() { warnings.push(json!(format!("二进制列不参与数据比较：{}。", binary.join(", ")))); }
    let source_only = source_names.difference(&target_names).copied().collect::<Vec<_>>();
    let target_only = target_names.difference(&source_names).copied().collect::<Vec<_>>();
    if !source_only.is_empty() { warnings.push(json!(format!("源表独有列未参与比较：{}（需要先同步结构）。", source_only.join(", ")))); }
    if !target_only.is_empty() { warnings.push(json!(format!("目标表独有列未参与比较：{}（需要先同步结构）。", target_only.join(", ")))); }
    app.ensure_session(&source.session)?;
    app.ensure_session(&target.session)?;
    // Also bound the generated SQL/summary artifact, not just the input pages.
    let mut result_bytes = 0;
    account(&result, &mut result_bytes)?;
    Ok(result)
}
fn literal(value: &Value, dialect: &str) -> Result<String, AppError> {
    match value {
        Value::Null => Ok("NULL".into()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(v) => {
            let literal = if dialect == "postgresql" { if *v { "TRUE" } else { "FALSE" } } else if *v { "1" } else { "0" };
            Ok(literal.to_owned())
        },
        Value::String(text) => {
            // Hex literals avoid MySQL backslash/sql_mode ambiguity, including embedded NUL.
            if dialect == "mysql" {
                let hex = text.as_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>();
                Ok(format!("CONVERT(X'{hex}' USING utf8mb4)"))
            } else if dialect == "postgresql" {
                if text.contains('\0') { return Err(invalid("PostgreSQL 同步计划不能包含 NUL 文本")); }
                Ok(format!("E'{}'", text.replace('\\', "\\\\").replace('\'', "''")))
            } else if text.contains('\0') {
                let hex = text.as_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>();
                Ok(format!("CAST(X'{hex}' AS TEXT)"))
            } else { Ok(format!("'{}'", text.replace('\'', "''"))) }
        }
        _ => Err(invalid("同步计划只接受标量值")),
    }
}
fn where_sql(key: &Map<String, Value>, keys: &[String], dialect: &str) -> Result<String, AppError> {
    keys.iter().map(|column| {
        let value = key.get(column).ok_or_else(|| invalid("同步计划缺少比较键"))?;
        let column = quote(column, dialect);
        if value.is_null() { Ok(format!("{column} IS NULL")) } else { Ok(format!("{column} = {}", literal(value, dialect)?)) }
    }).collect::<Result<Vec<_>, _>>().map(|v| v.join(" AND "))
}
fn summary(value: &Value) -> String {
    if value.is_null() { return "NULL".into(); }
    let text = value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string());
    let units = text.encode_utf16().collect::<Vec<_>>();
    if units.len() <= 120 { return text; }
    let hash = units.iter().fold(0x811c9dc5u32, |hash, ch| (hash ^ u32::from(*ch)).wrapping_mul(0x01000193));
    format!("<{} 字符, fnv1a:{hash:08x}>", units.len())
}
fn order_keys(a: &Row, b: &Row, keys: &[String]) -> Ordering {
    for column in keys {
        let x = &a.key[column];
        let y = &b.key[column];
        if x == y { continue; }
        // A total type order keeps mixed SQLite INTEGER/TEXT keys distinct and sorting transitive.
        let rank = |value: &Value| match value {
            Value::Null => 0, Value::Number(_) => 1, Value::Bool(_) => 2, Value::String(_) => 3, _ => 4,
        };
        let type_order = rank(x).cmp(&rank(y));
        if type_order != Ordering::Equal { return type_order; }
        let order = if x.is_null() { Ordering::Less } else if y.is_null() { Ordering::Greater }
        else if let (Some(x), Some(y)) = (x.as_number(), y.as_number()) {
            match (x.as_i64(), y.as_i64()) {
                (Some(x), Some(y)) => x.cmp(&y),
                _ => x.as_f64().partial_cmp(&y.as_f64()).unwrap_or(Ordering::Equal),
            }
        } else {
            let display = |v: &Value| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string());
            display(x).cmp(&display(y))
        };
        if order != Ordering::Equal { return order; }
    }
    Ordering::Equal
}
fn diff_rows(source: &Rows, target: &Rows, keys: &[String], table: &Table) -> Result<Value, AppError> {
    let dialect = table.session.dialect_id.as_str();
    let name = qualified(table);
    let mut tuples = source.keys().chain(target.keys()).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>();
    tuples.sort_by(|a, b| order_keys(source.get(*a).or_else(|| target.get(*a)).unwrap(), source.get(*b).or_else(|| target.get(*b)).unwrap(), keys).then_with(|| a.cmp(b)));
    let mut rows = Vec::new();
    let mut statements = Vec::new();
    let (mut insert_count, mut update_count, mut delete_count) = (0, 0, 0);
    let mut bytes = 0;
    for tuple in tuples {
        let statement_count = statements.len();
        let row = match (source.get(tuple), target.get(tuple)) {
            (Some(left), None) => {
                insert_count += 1;
                let names = left.values.keys().collect::<Vec<_>>();
                let values = names.iter().map(|name| literal(&left.values[*name], dialect)).collect::<Result<Vec<_>, _>>()?;
                statements.push(format!("INSERT INTO {name} ({}) VALUES ({})", names.iter().map(|c| quote(c, dialect)).collect::<Vec<_>>().join(", "), values.join(", ")));
                json!({"status":"source-only", "key":display_key(&left.key), "columns":[]})
            }
            (None, Some(right)) => {
                delete_count += 1;
                statements.push(format!("DELETE FROM {name} WHERE {}", where_sql(&right.key, keys, dialect)?));
                json!({"status":"target-only", "key":display_key(&right.key), "columns":[]})
            }
            (Some(left), Some(right)) => {
                let changed = left.values.keys().filter(|name| left.values[*name] != right.values[*name]).cloned().collect::<Vec<_>>();
                if changed.is_empty() { json!({"status":"same", "key":display_key(&left.key), "columns":[]}) }
                else {
                    update_count += 1;
                    let assignments = changed.iter().map(|column| Ok(format!("{} = {}", quote(column, dialect), literal(&left.values[column], dialect)?))).collect::<Result<Vec<_>, AppError>>()?;
                    statements.push(format!("UPDATE {name} SET {} WHERE {}", assignments.join(", "), where_sql(&left.key, keys, dialect)?));
                    let changes = changed.iter().map(|column| json!({"column":column, "source":summary(&left.values[column]), "target":summary(&right.values[column])})).collect::<Vec<_>>();
                    json!({"status":"different", "key":display_key(&left.key), "columns":changed, "valueChanges":changes})
                }
            }
            (None, None) => unreachable!(),
        };
        account(&row, &mut bytes)?;
        if statements.len() > statement_count {
            bytes = bytes.checked_add(statements.last().map_or(0, String::len)).ok_or_else(exceeded)?;
        }
        if bytes > MAX_BYTES { return Err(exceeded()); }
        rows.push(row);
    }
    let warnings = if delete_count > 0 { vec![format!("同步会删除目标端 {delete_count} 行，执行前必须单独确认。")] } else { Vec::new() };
    Ok(json!({"keyColumns":keys, "rows":rows, "plan":{"insertCount":insert_count,"updateCount":update_count,"deleteCount":delete_count,"statements":statements,"destructive":delete_count > 0,"warnings":warnings}}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbstudio_protocol::{Driver, DriverResult};

    // Fault injection only: real database behavior remains covered by tests/compare.rs SQLite fixtures.
    struct MetadataFault { code: &'static str }
    impl Driver for MetadataFault {
        fn dialect_id(&self) -> &str { "sqlite" }
        fn capabilities(&self) -> Value { json!({}) }
        fn call(&mut self, method: &str, _: Vec<Value>) -> DriverResult<Value> {
            if method == "listChildren" {
                return Ok(json!([{"id":"view:fixture", "kind":"view", "name":"fixture"}]));
            }
            Err(AppError::new(self.code, "private-fixture-driver-detail"))
        }
    }

    #[test]
    fn metadata_faults_propagate_safe_errors_for_both_optional_methods() {
        for (code, expected) in [("timeout", "timeout"), ("cancelled", "cancelled"), ("query_failed", "driver-failed"), ("connection_failed", "driver-failed")] {
            for method in ["viewDefinition", "listRoutines"] {
                let session = Session::new("fixture".into(), Box::new(MetadataFault { code }));
                let error = optional_metadata(&session, method, vec![]).unwrap_err();
                assert_eq!(error.code, expected);
                assert!(!error.message.contains("private-fixture-driver-detail"));
            }
        }
    }

    #[test]
    fn only_explicit_unsupported_metadata_can_degrade_and_stale_sessions_still_fail() {
        for method in ["viewDefinition", "listRoutines"] {
            let session = Session::new("fixture".into(), Box::new(MetadataFault { code: "unsupported" }));
            assert_eq!(optional_metadata(&session, method, vec![]).unwrap(), None);
            session.invalidate();
            assert_eq!(optional_metadata(&session, method, vec![]).unwrap_err().code, "not-found");
        }
    }

    #[test]
    fn snapshot_view_capture_does_not_hide_timeout_cancellation_or_driver_failure() {
        for (code, expected) in [("timeout", "timeout"), ("cancelled", "cancelled"), ("query_failed", "driver-failed"), ("unsupported", "")] {
            let session = Session::new("fixture".into(), Box::new(MetadataFault { code }));
            let mut snapshot = Snapshot {
                session: &session, schema: None, tables: vec![], views: vec![],
                visited: BTreeSet::new(), identities: BTreeSet::new(), objects: 0, bytes: 0, found_schema: true,
            };
            let result = snapshot.walk(None, None, 0);
            if code == "unsupported" {
                result.unwrap();
                assert_eq!(snapshot.views, vec![json!({"schema":null,"name":"fixture","definition":null})]);
            } else {
                assert_eq!(result.unwrap_err().code, expected);
                assert!(snapshot.views.is_empty());
            }
        }
    }

    #[test]
    fn exact_native_numbers_remain_typed_until_the_outbound_json_key_boundary() {
        let integer = scalar(&json!({"kind":"number","value":9007199254740993i64})).unwrap();
        let text = scalar(&json!({"kind":"text","text":"9007199254740993"})).unwrap();
        assert_ne!(integer, text);
        assert_eq!(literal(&integer, "sqlite").unwrap(), "9007199254740993");
        assert_eq!(literal(&text, "sqlite").unwrap(), "'9007199254740993'");
        let key = Map::from_iter([("id".into(), integer)]);
        assert_eq!(display_key(&key)["id"], "9007199254740993");
        assert!(key["id"].is_number());
    }
}
