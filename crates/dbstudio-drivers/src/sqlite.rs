//! One native SQLite session. Cursors retain SQL and bindings, never whole result sets.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use dbstudio_protocol::{argument, string_argument, ConnectionConfig, Driver, DriverError, DriverResult, SecretMap};
use rusqlite::{params_from_iter, types::{Value as SqlValue, ValueRef}, Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, HashMap, HashSet}, ffi::CString, path::Path, sync::atomic::{AtomicU64, Ordering}, time::{Duration, Instant}};

static SESSION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

const PAGE_SIZE: usize = 200;
const MAX_PAGE_SIZE: usize = 1000;
const MAX_TEXT: usize = 1000;
const MAX_BLOB: usize = 256;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub fn connect(config: &ConnectionConfig, _secret: &SecretMap) -> DriverResult<Box<dyn Driver>> {
    let file = config.options.get("file").and_then(Value::as_str).unwrap_or("").trim();
    let path = Path::new(file);
    if file.is_empty() || !path.is_absolute() {
        return Err(DriverError::new("connection_failed", "SQLite 数据库必须是已存在文件的绝对路径"));
    }
    if !path.is_file() {
        return Err(DriverError::new("connection_failed", "SQLite 数据库文件不存在或不是普通文件"));
    }
    // Deliberately omit SQLITE_OPEN_CREATE, including after the preflight file check.
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| DriverError::new("connection_failed", format!("无法打开 SQLite 数据库: {e}")))?;
    db.busy_timeout(Duration::from_secs(5)).map_err(db_error)?;
    db.pragma_update(None, "foreign_keys", true).map_err(db_error)?;
    db.query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))
        .map_err(|e| DriverError::new("connection_failed", format!("不是有效的 SQLite 数据库: {e}")))?;
    Ok(Box::new(SqliteDriver { db: Some(db), file: file.to_owned(), session: SESSION_SEQUENCE.fetch_add(1, Ordering::Relaxed), cursors: HashMap::new(), next_cursor: 0, pending: 0, import_active: false }))
}

fn db_error(error: rusqlite::Error) -> DriverError { DriverError::new("query_failed", error.to_string()) }
fn invalid(message: impl Into<String>) -> DriverError { DriverError::invalid(message) }
fn object_error(message: impl Into<String>) -> DriverError { DriverError::new("object_not_found", message) }
fn quote(name: &str) -> DriverResult<String> {
    if name.is_empty() || name.contains('\0') { return Err(invalid("标识符不能为空或包含 NUL")); }
    Ok(format!("\"{}\"", name.replace('"', "\"\"")))
}
fn record<'a>(value: &'a Value, label: &str) -> DriverResult<&'a Map<String, Value>> {
    value.as_object().ok_or_else(|| invalid(format!("{label} 必须是对象")))
}
fn array<'a>(value: &'a Value, label: &str) -> DriverResult<&'a Vec<Value>> {
    value.as_array().ok_or_else(|| invalid(format!("{label} 必须是数组")))
}
fn text<'a>(value: &'a Value, label: &str) -> DriverResult<&'a str> {
    value.as_str().ok_or_else(|| invalid(format!("{label} 必须是字符串")))
}
fn page_size(value: Option<&Value>) -> usize {
    value.and_then(Value::as_f64).filter(|n| n.is_finite()).map(|n| n.floor().clamp(1.0, MAX_PAGE_SIZE as f64) as usize).unwrap_or(PAGE_SIZE)
}
fn offset(value: Option<&Value>) -> usize {
    value.and_then(Value::as_f64).filter(|n| n.is_finite()).map(|n| n.floor().clamp(0.0, MAX_SAFE_INTEGER as f64) as usize).unwrap_or(0)
}

#[derive(Clone)]
struct Cursor { sql: String, params: Vec<SqlValue> }
struct SqliteDriver {
    db: Option<Connection>,
    file: String,
    session: u64,
    cursors: HashMap<String, Cursor>,
    next_cursor: u64,
    pending: u64,
    import_active: bool,
}
#[derive(Clone)]
struct Column {
    name: String, kind: String, not_null: bool, default: Option<String>, pk: i64, hidden: i64,
}
#[derive(Clone)]
struct Target { name: String, columns: Vec<Column>, keys: Vec<String> }

impl Driver for SqliteDriver {
    fn dialect_id(&self) -> &str { "sqlite" }
    fn capabilities(&self) -> Value {
        json!({"hasCatalog":false,"hasSchema":false,"supportsServerPagination":true,"supportsCancel":false,
            "supportsInlineEdit":true,"metadata":{"foreignKeys":true,"indexes":true,"uniqueConstraints":true,"checkConstraints":true,"triggers":true}})
    }
    fn call(&mut self, method: &str, args: Vec<Value>) -> DriverResult<Value> {
        match method {
            "transactionState" => Ok(self.transaction_state()),
            "rollbackTransaction" => { self.rollback()?; Ok(self.transaction_state()) },
            "disconnect" => { self.disconnect()?; Ok(Value::Null) },
            "cancelQuery" => Ok(json!(false)),
            "closeCursor" => { self.cursors.remove(string_argument(&args, 0, "cursorId")?); Ok(Value::Null) },
            "runQuery" | "query" => self.query(string_argument(&args, 0, "sql")?, args.get(1)),
            "executeStatement" => self.execute_statement(string_argument(&args, 0, "sql")?, args.get(1)),
            "fetchResultPage" | "fetchPage" => {
                let cursor = self.cursor(string_argument(&args, 0, "cursorId")?)?;
                self.page(&cursor.sql, &cursor.params, offset(args.get(1)), page_size(args.get(2)), false).map(|(v, _)| v)
            },
            "fetchCellValue" => self.full_cell(string_argument(&args, 0, "cursorId")?, argument(&args, 1, "rowIndex")?, argument(&args, 2, "columnIndex")?),
            "listChildren" => self.list_children(argument(&args, 0, "parentId")?),
            "describeTable" => self.describe_table(string_argument(&args, 0, "tableId")?),
            "viewDefinition" => self.view_definition(string_argument(&args, 0, "viewId")?),
            "listRoutines" => { self.db()?; Ok(json!([])) },
            "tableSelectSql" => Ok(json!(self.select_sql(string_argument(&args, 0, "nodeId")?)?)),
            "resolveTransferSource" => {
                let id = string_argument(&args, 0, "nodeId")?;
                let (kind, name) = relation(id)?;
                Ok(json!({"sql":self.select_sql(id)?,"target":{"schema":null,"table":name,"kind":kind},"sqliteFile":self.file}))
            },
            "countRows" => {
                let target = self.target(string_argument(&args, 0, "tableId")?, false)?;
                let count: i64 = self.db()?.query_row(&format!("SELECT COUNT(*) FROM {}", quote(&target.name)?), [], |r| r.get(0)).map_err(db_error)?;
                Ok(json!(count))
            },
            "commitTransaction" => {
                if self.db()?.is_autocommit() { return Err(invalid("当前没有未提交事务，无法提交")); }
                self.db()?.execute_batch("COMMIT").map_err(db_error)?;
                self.pending = 0; self.import_active = false;
                Ok(self.transaction_state())
            },
            "applyEdits" => self.edit_rows(string_argument(&args, 0, "tableId")?, array(argument(&args, 1, "updates")?, "updates")?, false),
            "deleteRows" => self.edit_rows(string_argument(&args, 0, "tableId")?, array(argument(&args, 1, "keys")?, "keys")?, true),
            "insertRow" => self.insert_row(string_argument(&args, 0, "tableId")?, record(argument(&args, 1, "values")?, "values")?),
            "importBatch" => self.import_batch(string_argument(&args, 0, "tableId")?, argument(&args, 1, "batch")?),
            "explain" => {
                let sql = single_statement(string_argument(&args, 0, "sql")?)?;
                let plan = if keyword(&sql) == "explain" { sql } else { format!("EXPLAIN QUERY PLAN {sql}") };
                let mut result = self.query(&plan, Some(&json!({"keepCursor":false})))?;
                let object = result.as_object_mut().ok_or_else(|| invalid("无执行计划结果"))?;
                object.insert("dialectId".into(), json!("sqlite")); object.insert("format".into(), json!("tabular"));
                for key in ["cursorId", "offset", "returned", "hasMore", "elapsedMs"] { object.remove(key); }
                Ok(result)
            },
            "createTable" => { self.create_table(argument(&args, 0, "spec")?)?; Ok(Value::Null) },
            "dropTable" => { let (_, name) = relation_kind(string_argument(&args, 0, "tableId")?, "table")?; self.ddl(&format!("DROP TABLE {}", quote(name)?))?; Ok(Value::Null) },
            "createView" => {
                let name = string_argument(&args, 0, "name")?;
                let select = single_statement(string_argument(&args, 1, "sql")?)?;
                let stmt = self.db()?.prepare(&select).map_err(db_error)?;
                if !stmt.readonly() || !["select", "values"].contains(&keyword(&select).as_str()) { return Err(invalid("视图定义必须是单条只读 SELECT")); }
                drop(stmt);
                self.ddl(&format!("CREATE VIEW {} AS {select}", quote(name)?))?; Ok(Value::Null)
            },
            "dropView" => { let (_, name) = relation_kind(string_argument(&args, 0, "viewId")?, "view")?; self.ddl(&format!("DROP VIEW {}", quote(name)?))?; Ok(Value::Null) },
            "renameTable" => {
                let (_, name) = relation_kind(string_argument(&args, 0, "tableId")?, "table")?;
                self.ddl(&format!("ALTER TABLE {} RENAME TO {}", quote(name)?, quote(string_argument(&args, 1, "newName")?)?))?;
                Ok(Value::Null)
            },
            _ => Err(DriverError::unsupported(format!("SQLite 不支持方法 {method}"))),
        }
    }
    fn disconnect(&mut self) -> DriverResult<()> {
        self.rollback()?;
        self.cursors.clear();
        if let Some(db) = self.db.take() { db.close().map_err(|(_, e)| db_error(e))?; }
        Ok(())
    }
}

impl SqliteDriver {
    fn db(&self) -> DriverResult<&Connection> { self.db.as_ref().ok_or_else(|| DriverError::new("not_connected", "SQLite 已断开")) }
    fn transaction_state(&self) -> Value {
        let active = self.db.as_ref().map(|db| !db.is_autocommit()).unwrap_or(false);
        json!({"active":active,"pendingAffected":if active { self.pending } else { 0 }})
    }
    fn begin(&mut self) -> DriverResult<bool> {
        if self.db()?.is_autocommit() { self.db()?.execute_batch("BEGIN IMMEDIATE").map_err(db_error)?; self.pending = 0; Ok(true) } else { Ok(false) }
    }
    fn rollback(&mut self) -> DriverResult<()> {
        if let Some(db) = &self.db { if !db.is_autocommit() { db.execute_batch("ROLLBACK").map_err(db_error)?; } }
        self.pending = 0; self.import_active = false; Ok(())
    }
    fn cursor(&self, id: &str) -> DriverResult<Cursor> { self.cursors.get(id).cloned().ok_or_else(|| object_error("结果集游标不存在或已关闭")) }
    fn query(&mut self, sql: &str, options: Option<&Value>) -> DriverResult<Value> {
        let sql = single_statement(sql)?;
        let params = bind_parameters(self.db()?, &sql, options)?;
        let limit = page_size(options.and_then(|v| v.get("limit")));
        let start = offset(options.and_then(|v| v.get("offset")));
        let timer = Instant::now();
        let (mut page, executed) = self.page(&sql, &params, start, limit, false)?;
        let cursor = if options.and_then(|v| v.get("keepCursor")).and_then(Value::as_bool) == Some(false) { Value::Null } else {
            self.next_cursor += 1;
            let id = format!("cur-{}-{}", self.session, self.next_cursor);
            self.cursors.insert(id.clone(), Cursor { sql, params }); json!(id)
        };
        let object = page.as_object_mut().ok_or_else(|| invalid("查询结果无效"))?;
        object.insert("cursorId".into(), cursor); object.insert("executedSql".into(), json!(executed));
        object.insert("elapsedMs".into(), json!(timer.elapsed().as_millis() as u64));
        Ok(page)
    }
    fn page(&self, sql: &str, params: &[SqlValue], start: usize, limit: usize, full: bool) -> DriverResult<(Value, String)> {
        let db = self.db()?;
        let original = db.prepare(sql).map_err(db_error)?;
        if !original.readonly() { return Err(DriverError::new("query_failed", "分页查询只允许只读语句，请使用 executeStatement")); }
        let names: Vec<String> = original.column_names().iter().map(|s| (*s).to_owned()).collect();
        let paginate = ["select", "values"].contains(&keyword(sql).as_str());
        let executed = if paginate { format!("SELECT * FROM (\n{sql}\n) LIMIT {limit} OFFSET {start}") } else { sql.to_owned() };
        drop(original);
        let mut statement = db.prepare(&executed).map_err(db_error)?;
        let mut rows = statement.query(params_from_iter(params.iter())).map_err(db_error)?;
        let mut output = Vec::new();
        let mut kinds = vec!["unknown"; names.len()];
        let mut skipped = 0;
        while output.len() < limit {
            let Some(row) = rows.next().map_err(db_error)? else { break };
            if !paginate && skipped < start { skipped += 1; continue; }
            let mut cells = Vec::with_capacity(names.len());
            for (index, kind) in kinds.iter_mut().enumerate() {
                let value = row.get_ref(index).map_err(db_error)?;
                if *kind == "unknown" || *kind == "null" { *kind = value_type(value); }
                cells.push(cell(value, full)?);
            }
            output.push(json!({"index":start + output.len(),"cells":cells}));
        }
        let count = output.len();
        let columns: Vec<Value> = names.into_iter().zip(kinds).map(|(name, kind)| json!({"name":name,"type":kind})).collect();
        Ok((json!({"columns":columns,"rows":output,"offset":start,"returned":count,"hasMore":count == limit}), executed))
    }
    fn full_cell(&self, cursor_id: &str, row: &Value, column: &Value) -> DriverResult<Value> {
        let row = row.as_u64().ok_or_else(|| invalid("rowIndex 必须是非负整数"))? as usize;
        let column = column.as_u64().ok_or_else(|| invalid("columnIndex 必须是非负整数"))? as usize;
        let cursor = self.cursor(cursor_id)?;
        let (page, _) = self.page(&cursor.sql, &cursor.params, row, 1, true)?;
        page.get("rows").and_then(|v| v.get(0)).and_then(|v| v.get("cells")).and_then(|v| v.get(column)).cloned()
            .ok_or_else(|| object_error("单元格不存在，结果集可能已变化"))
    }
    fn execute_statement(&mut self, raw: &str, options: Option<&Value>) -> DriverResult<Value> {
        let sql = single_statement(raw)?;
        let params = bind_parameters(self.db()?, &sql, options)?;
        let key = keyword(&sql);
        let statement = self.db()?.prepare(&sql).map_err(db_error)?;
        let columns = statement.column_count();
        let readonly = statement.readonly();
        drop(statement);
        if readonly && columns > 0 { return Ok(json!({"kind":"rows","result":self.query(&sql, options)?})); }
        let started = Instant::now();
        if ["insert", "update", "delete", "replace"].contains(&key.as_str()) {
            if columns > 0 { return Err(DriverError::unsupported("带 RETURNING 的写语句尚不支持分页；请分开执行写入与 SELECT")); }
            if self.import_active { return Err(invalid("导入事务期间不能执行普通写入")); }
            let own = self.begin()?;
            let result = self.db()?.execute(&sql, params_from_iter(params.iter()));
            let affected = match result { Ok(n) => n, Err(error) => { if own { self.rollback()?; } return Err(db_error(error)); } };
            self.pending += affected as u64;
            return Ok(json!({"kind":"affected","affected":affected,"inTransaction":!self.db()?.is_autocommit(),
                "transactionState":self.transaction_state(),"executedSql":sql,"elapsedMs":started.elapsed().as_millis() as u64}));
        }
        if !params.is_empty() { return Err(invalid("DDL 和事务命令不支持参数绑定")); }
        // A typed transaction method is authoritative; SQL equivalents use the same counters.
        if key == "commit" || key == "end" { return self.call("commitTransaction", vec![]).map(|_| json!({"kind":"ddl","summary":"COMMIT 已完成","committed":true,"executedSql":sql,"elapsedMs":started.elapsed().as_millis() as u64})); }
        if key == "rollback" && sql_words(&sql).iter().all(|w| w.word != "to") { self.rollback()?; }
        else { self.db()?.execute_batch(&sql).map_err(db_error)?; }
        if self.db()?.is_autocommit() { self.pending = 0; self.import_active = false; }
        Ok(json!({"kind":"ddl","summary":format!("{} 已完成", sql.chars().take(50).collect::<String>()),
            "committed":self.db()?.is_autocommit(),"executedSql":sql,"elapsedMs":started.elapsed().as_millis() as u64}))
    }
    fn columns(&self, name: &str) -> DriverResult<Vec<Column>> {
        let mut stmt = self.db()?.prepare("SELECT name,type,\"notnull\",dflt_value,pk,hidden FROM pragma_table_xinfo(?1)").map_err(db_error)?;
        let columns = stmt.query_map([name], |row| Ok(Column { name: row.get(0)?, kind: row.get(1)?, not_null: row.get::<_, i64>(2)? != 0,
            default: row.get(3)?, pk: row.get(4)?, hidden: row.get(5)? })).map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
        if columns.is_empty() { return Err(object_error("表或视图不存在，或没有可读列")); }
        Ok(columns)
    }
    fn target(&self, id: &str, require_key: bool) -> DriverResult<Target> {
        let (_, name) = relation_kind(id, "table")?;
        let exists: i64 = self.db()?.query_row("SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name=?1 COLLATE NOCASE", [name], |row| row.get(0)).map_err(db_error)?;
        if exists == 0 { return Err(object_error("编辑目标不是存在的表")); }
        let columns = self.columns(name)?;
        let mut keys: Vec<_> = columns.iter().filter(|c| c.pk > 0).collect();
        keys.sort_by_key(|c| c.pk);
        let keys = keys.into_iter().map(|c| c.name.clone()).collect::<Vec<_>>();
        if require_key && keys.is_empty() { return Err(object_error("No unique key defined：没有完整主键，不能定位待修改行")); }
        Ok(Target { name: name.to_owned(), columns, keys })
    }
    fn select_sql(&self, id: &str) -> DriverResult<String> { let (_, name) = relation(id)?; Ok(format!("SELECT * FROM {}", quote(name)?)) }
    fn list_children(&self, parent: &Value) -> DriverResult<Value> {
        self.db()?;
        if parent.is_null() { return Ok(json!([
            {"id":"folder:tables","kind":"folder","name":"表","parentId":null,"hasChildren":true},
            {"id":"folder:views","kind":"folder","name":"视图","parentId":null,"hasChildren":true}
        ])); }
        let id = text(parent, "parentId")?;
        if id == "folder:tables" || id == "folder:views" {
            let kind = if id == "folder:tables" { "table" } else { "view" };
            let mut stmt = self.db()?.prepare("SELECT name FROM sqlite_schema WHERE type=?1 AND name NOT GLOB 'sqlite_*' ORDER BY name COLLATE NOCASE").map_err(db_error)?;
            let names = stmt.query_map([kind], |r| r.get::<_, String>(0)).map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
            return Ok(json!(names.into_iter().map(|name| json!({"id":format!("{kind}:{name}"),"kind":kind,"name":name,"parentId":id,"hasChildren":true})).collect::<Vec<_>>()));
        }
        if id.starts_with("column:") { return Ok(json!([])); }
        let (_, name) = relation(id)?;
        let rows = self.columns(name)?.into_iter().filter(|c| c.hidden != 1).map(|c| {
            json!({"id":format!("column:{}.{}", escape_part(name), escape_part(&c.name)),"kind":"column","name":c.name,"parentId":id,"hasChildren":false,
                "meta":{"type":c.kind,"nullable":!c.not_null,"primaryKey":c.pk > 0,"primaryKeyOrdinal":if c.pk > 0 { json!(c.pk) } else { Value::Null }}})
        }).collect::<Vec<_>>();
        Ok(json!(rows))
    }
    fn view_definition(&self, id: &str) -> DriverResult<Value> {
        let (_, name) = relation_kind(id, "view")?;
        let mut stmt = self.db()?.prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name=?1").map_err(db_error)?;
        let mut rows = stmt.query([name]).map_err(db_error)?;
        match rows.next().map_err(db_error)? { Some(row) => Ok(json!(row.get::<_, Option<String>>(0).map_err(db_error)?)), None => Ok(Value::Null) }
    }
    fn ddl(&mut self, sql: &str) -> DriverResult<()> {
        if !self.db()?.is_autocommit() { return Err(invalid("连接上有未提交事务，请先提交或回滚再执行结构操作")); }
        self.db()?.execute_batch(sql).map_err(db_error)?;
        self.cursors.clear(); Ok(())
    }
}

impl SqliteDriver {
    fn schema_sql(&self, name: &str) -> DriverResult<Option<String>> {
        let mut stmt = self.db()?.prepare("SELECT sql FROM sqlite_schema WHERE name=?1 AND type IN ('table','view','index','trigger')").map_err(db_error)?;
        let mut rows = stmt.query([name]).map_err(db_error)?;
        match rows.next().map_err(db_error)? { Some(row) => row.get(0).map_err(db_error), None => Ok(None) }
    }
    fn rowid_alias(&self, name: &str, columns: &[Column]) -> DriverResult<Option<String>> {
        let keys: Vec<_> = columns.iter().filter(|c| c.pk > 0).collect();
        if keys.len() != 1 || !keys[0].kind.trim().eq_ignore_ascii_case("INTEGER") { return Ok(None); }
        let sql = self.schema_sql(name)?.unwrap_or_default();
        if sql_words(&sql).windows(2).any(|words| words[0].word == "without" && words[1].word == "rowid") { return Ok(None); }
        let pk_index: i64 = self.db()?.query_row("SELECT COUNT(*) FROM pragma_index_list(?1) WHERE origin='pk'", [name], |r| r.get(0)).map_err(db_error)?;
        Ok(if pk_index == 0 { Some(keys[0].name.clone()) } else { None })
    }
    fn describe_table(&self, id: &str) -> DriverResult<Value> {
        let (kind, name) = relation(id)?;
        let columns = self.columns(name)?;
        let alias = if kind == "table" { self.rowid_alias(name, &columns)? } else { None };
        let output = columns.iter().map(|c| {
            let generated = match c.hidden { 2 => json!("virtual"), 3 => json!("stored"), _ => Value::Null };
            let required = c.hidden == 0 && c.default.is_none() && alias.as_deref() != Some(c.name.as_str()) && (c.not_null || c.pk > 0);
            json!({"name":c.name,"typeName":c.kind,"nullable":!c.not_null,"primaryKeyOrdinal":if c.pk > 0 { json!(c.pk) } else { Value::Null },
                "defaultValue":c.default,"generated":generated,"hidden":c.hidden == 1,"requiredOnInsert":required})
        }).collect::<Vec<_>>();
        let mut description = json!({"id":id,"columns":output,"hasUniqueKey":columns.iter().any(|c| c.pk > 0)});
        let (indexes, unique) = self.indexes(name)?;
        let foreign = self.foreign_keys(name)?;
        let sql = self.schema_sql(name)?.unwrap_or_default();
        let checks = check_expressions(&sql).into_iter().map(|expression| json!({"name":null,"expression":expression})).collect::<Vec<_>>();
        let triggers = self.triggers(name)?;
        let object = description.as_object_mut().ok_or_else(|| invalid("结构结果无效"))?;
        object.insert("indexes".into(), json!(indexes)); object.insert("uniqueConstraints".into(), json!(unique));
        object.insert("foreignKeys".into(), json!(foreign)); object.insert("checks".into(), json!(checks)); object.insert("triggers".into(), json!(triggers));
        Ok(description)
    }
    fn indexes(&self, table: &str) -> DriverResult<(Vec<Value>, Vec<Value>)> {
        let mut stmt = self.db()?.prepare("SELECT name,\"unique\",origin,partial FROM pragma_index_list(?1) ORDER BY seq").map_err(db_error)?;
        let rows = stmt.query_map([table], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0, r.get::<_, String>(2)?, r.get::<_, i64>(3)? != 0)))
            .map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
        let mut indexes = Vec::new(); let mut unique_constraints = Vec::new();
        for (name, unique, origin, partial) in rows {
            let mut info = self.db()?.prepare("SELECT name,cid FROM pragma_index_xinfo(?1) WHERE \"key\"=1 ORDER BY seqno").map_err(db_error)?;
            let terms = info.query_map([&name], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?))).map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
            let columns = terms.iter().filter_map(|(name, _)| name.clone()).collect::<Vec<_>>();
            let sql = self.schema_sql(&name)?.unwrap_or_default();
            let words = sql_words(&sql);
            let predicate = if partial { words.iter().find(|w| w.depth == 0 && w.word == "where").map(|w| sql[w.end..].trim().trim_end_matches(';').to_owned()) } else { None };
            let expression = if terms.iter().any(|(_, cid)| *cid == -2) { first_parenthesized(&sql).map(|(start, end)| sql[start + 1..end].trim().to_owned()) } else { None };
            if origin == "u" || origin == "pk" { unique_constraints.push(json!({"name":null,"columns":columns})); }
            indexes.push(json!({"name":name,"unique":unique,"columns":columns,"predicate":predicate,"expression":expression}));
        }
        Ok((indexes, unique_constraints))
    }
    fn foreign_keys(&self, table: &str) -> DriverResult<Vec<Value>> {
        let mut stmt = self.db()?.prepare("SELECT id,seq,\"table\",\"from\",\"to\",on_update,on_delete FROM pragma_foreign_key_list(?1) ORDER BY id,seq").map_err(db_error)?;
        let rows = stmt.query_map([table], |r| Ok((r.get::<_, i64>(0)?,r.get::<_, usize>(1)?,r.get::<_, String>(2)?,r.get::<_, String>(3)?,r.get::<_, Option<String>>(4)?,r.get::<_, String>(5)?,r.get::<_, String>(6)?)))
            .map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
        let mut groups: BTreeMap<i64, Value> = BTreeMap::new();
        for (id, seq, referenced, column, explicit, on_update, on_delete) in rows {
            let target_column = match explicit {
                Some(value) => value,
                None => {
                    let mut keys = self.columns(&referenced)?.into_iter().filter(|c| c.pk > 0).collect::<Vec<_>>();
                    keys.sort_by_key(|c| c.pk);
                    keys.get(seq).map(|c| c.name.clone()).ok_or_else(|| object_error("无法解析省略列名的外键主键"))?
                }
            };
            let group = groups.entry(id).or_insert_with(|| json!({"name":null,"columns":[],"referencedSchema":null,"referencedTable":referenced,
                "referencedColumns":[],"onUpdate":on_update,"onDelete":on_delete}));
            group["columns"].as_array_mut().ok_or_else(|| invalid("外键列无效"))?.push(json!(column));
            group["referencedColumns"].as_array_mut().ok_or_else(|| invalid("引用列无效"))?.push(json!(target_column));
        }
        Ok(groups.into_values().collect())
    }
    fn triggers(&self, table: &str) -> DriverResult<Vec<Value>> {
        let mut stmt = self.db()?.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?1 ORDER BY name").map_err(db_error)?;
        let rows = stmt.query_map([table], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
        rows.into_iter().map(|(name, sql)| {
            let words = sql_words(&sql);
            let begin = words.iter().find(|w| w.depth == 0 && w.word == "begin").ok_or_else(|| object_error("无法读取触发器主体"))?;
            let end = words.iter().rev().find(|w| w.depth == 0 && w.word == "end").ok_or_else(|| object_error("无法读取触发器结束位置"))?;
            let header = words.iter().filter(|w| w.start < begin.start).collect::<Vec<_>>();
            let event = header.iter().find(|w| ["insert","update","delete"].contains(&w.word.as_str())).ok_or_else(|| object_error("无法识别触发器事件"))?;
            let timing = if header.iter().any(|w| w.word == "instead") { "INSTEAD OF" } else if header.iter().any(|w| w.word == "after") { "AFTER" } else { "BEFORE" };
            let when = header.iter().find(|w| w.word == "when").map(|w| sql[w.end..begin.start].trim().to_owned());
            let mut update_of = Vec::new();
            if event.word == "update" {
                if let Some(of) = header.iter().find(|w| w.start >= event.end && w.word == "of") {
                    if let Some(on) = header.iter().find(|w| w.start > of.end && w.word == "on") {
                        update_of = split_identifiers(&sql[of.end..on.start]);
                    }
                }
            }
            Ok(json!({"name":name,"timing":timing,"event":event.word.to_ascii_uppercase(),"statement":sql[begin.end..end.start].trim(),
                "updateOf":update_of,"when":when,"enabled":true}))
        }).collect()
    }
    fn edit_rows(&mut self, id: &str, updates: &[Value], deleting: bool) -> DriverResult<Value> {
        if self.import_active { return Err(invalid("导入期间不能执行普通编辑或删除")); }
        if deleting && updates.is_empty() { return Err(invalid("没有要删除的行")); }
        let target = self.target(id, true)?;
        // Validate the whole request before opening a transaction. Values are always bound.
        let mut writes = Vec::new();
        for update in updates {
            let (keys, changes) = if deleting { (record(update,"keyValues")?, None) } else {
                (record(update.get("keyValues").ok_or_else(|| invalid("缺少 keyValues"))?, "keyValues")?,
                 Some(record(update.get("changes").ok_or_else(|| invalid("缺少 changes"))?, "changes")?))
            };
            let key_values = normalize_columns(&target, keys)?;
            let mut params = Vec::new(); let mut predicates = Vec::new();
            let mut assignments = Vec::new();
            if let Some(changes) = changes {
                if changes.is_empty() { return Err(invalid("更新必须包含要修改的列")); }
                for (name, value) in normalize_columns(&target, changes)? {
                    if target.columns.iter().any(|c| c.name == name && c.hidden != 0) { return Err(invalid("生成列或隐藏列不能直接编辑")); }
                    assignments.push(format!("{} = ?", quote(&name)?)); params.push(value);
                }
            }
            for key in &target.keys {
                let value = key_values.iter().find(|(name, _)| name == key).ok_or_else(|| invalid(format!("缺少完整主键列 {key}")))?;
                predicates.push(format!("{} = ?", quote(key)?)); params.push(value.1.clone());
            }
            let sql = if deleting { format!("DELETE FROM {} WHERE {}", quote(&target.name)?, predicates.join(" AND ")) }
                else { format!("UPDATE {} SET {} WHERE {}", quote(&target.name)?, assignments.join(", "), predicates.join(" AND ")) };
            writes.push((sql, params));
        }
        if writes.is_empty() { return Ok(json!({"affected":0,"outcomes":[],"ok":true,"inTransaction":!self.db()?.is_autocommit()})); }
        self.begin()?;
        let mut total = 0usize; let mut outcomes = Vec::new(); let mut ok = true;
        for (index, (sql, params)) in writes.into_iter().enumerate() {
            self.db()?.execute_batch("SAVEPOINT dbstudio_row_edit").map_err(db_error)?;
            let result = self.db()?.execute(&sql, params_from_iter(params.iter()));
            let (affected, error) = match result {
                Ok(1) => (1usize, Value::Null),
                Ok(0) => (0, json!("目标行不存在或已被修改")),
                Ok(_) => (0, json!("主键未唯一定位一行，本条操作已撤销")),
                Err(error) => (0, json!(error.to_string())),
            };
            if !error.is_null() {
                ok = false;
                if !self.db()?.is_autocommit() { self.db()?.execute_batch("ROLLBACK TO dbstudio_row_edit; RELEASE dbstudio_row_edit").map_err(db_error)?; }
            } else { self.db()?.execute_batch("RELEASE dbstudio_row_edit").map_err(db_error)?; }
            total += affected; outcomes.push(json!({"index":index,"affected":affected,"error":error,"sql":sql}));
            if self.db()?.is_autocommit() { break; }
        }
        if !self.db()?.is_autocommit() { self.pending += total as u64; } else { total = 0; self.pending = 0; }
        Ok(json!({"affected":total,"outcomes":outcomes,"ok":ok,"inTransaction":!self.db()?.is_autocommit()}))
    }
    fn insert_row(&mut self, id: &str, values: &Map<String, Value>) -> DriverResult<Value> {
        if self.import_active { return Err(invalid("导入期间不能执行普通插入")); }
        let target = self.target(id, false)?;
        let normalized = normalize_columns(&target, values)?;
        if normalized.is_empty() { return Err(invalid("插入必须至少提供一列；全默认行请使用 INSERT DEFAULT VALUES")); }
        if normalized.iter().any(|(name, _)| target.columns.iter().any(|c| c.name == *name && c.hidden != 0)) { return Err(invalid("不能写入生成列或隐藏列")); }
        let columns = normalized.iter().map(|(name, _)| quote(name)).collect::<DriverResult<Vec<_>>>()?;
        let mut sql = format!("INSERT INTO {} ({}) VALUES ({})", quote(&target.name)?, columns.join(", "), vec!["?"; columns.len()].join(", "));
        if !target.keys.is_empty() { sql.push_str(&format!(" RETURNING {}", target.keys.iter().map(|name| quote(name)).collect::<DriverResult<Vec<_>>>()?.join(", "))); }
        let own = self.begin()?;
        if let Err(error) = self.db()?.execute_batch("SAVEPOINT dbstudio_insert_row") {
            if own { self.rollback()?; }
            return Err(db_error(error));
        }
        let result = (|| -> DriverResult<Value> {
            let mut key_values = Map::new();
            let params = normalized.iter().map(|(_, value)| value);
            if target.keys.is_empty() {
                if self.db()?.execute(&sql, params_from_iter(params)).map_err(db_error)? != 1 { return Err(DriverError::new("query_failed", "数据库没有插入一行")); }
            } else {
                let mut stmt = self.db()?.prepare(&sql).map_err(db_error)?;
                let mut rows = stmt.query(params_from_iter(params)).map_err(db_error)?;
                let row = rows.next().map_err(db_error)?.ok_or_else(|| DriverError::new("query_failed", "数据库没有插入一行"))?;
                for (index, name) in target.keys.iter().enumerate() { key_values.insert(name.clone(), cell(row.get_ref(index).map_err(db_error)?, true)?); }
                if rows.next().map_err(db_error)?.is_some() { return Err(DriverError::new("query_failed", "插入返回了多行")); }
            }
            self.db()?.execute_batch("RELEASE dbstudio_insert_row").map_err(db_error)?;
            Ok(json!({"affected":1,"keyValues":key_values}))
        })();
        match result {
            Ok(value) => { self.pending += 1; Ok(value) },
            Err(error) => {
                // RAISE(FAIL) can retain the inserted row and AFTER-trigger writes.
                // Revert this operation without discarding earlier uncommitted work.
                if !self.db()?.is_autocommit() {
                    self.db()?.execute_batch("ROLLBACK TO dbstudio_insert_row; RELEASE dbstudio_insert_row").map_err(db_error)?;
                } else {
                    // RAISE(ROLLBACK) has already ended the whole transaction.
                    self.pending = 0;
                    self.import_active = false;
                }
                if own { self.rollback()?; }
                Err(error)
            }
        }
    }
    fn import_batch(&mut self, id: &str, batch: &Value) -> DriverResult<Value> {
        let target = self.target(id, false)?;
        let batch = record(batch, "ImportBatch")?;
        let batch_index = batch.get("batchIndex").and_then(Value::as_u64).ok_or_else(|| invalid("batchIndex 必须是非负整数"))?;
        let requested = array(batch.get("columns").ok_or_else(|| invalid("缺少导入 columns"))?, "columns")?;
        if requested.is_empty() { return Err(invalid("导入列不能为空")); }
        let mut columns = Vec::new(); let mut seen = HashSet::new();
        for name in requested {
            let name = text(name, "导入列名")?;
            let canonical = target.columns.iter().find(|c| c.name.eq_ignore_ascii_case(name)).ok_or_else(|| invalid("导入列不存在"))?;
            if canonical.hidden != 0 || !seen.insert(canonical.name.clone()) { return Err(invalid("导入列重复或是生成/隐藏列")); }
            columns.push(canonical.name.clone());
        }
        let rows = array(batch.get("rows").ok_or_else(|| invalid("缺少导入 rows"))?, "rows")?;
        if rows.is_empty() || rows.len() > 1000 { return Err(invalid("导入批次必须有1至1000行")); }
        let mut converted = Vec::new();
        for row in rows {
            let row_number = row.get("rowNumber").and_then(Value::as_u64).filter(|n| *n > 0).ok_or_else(|| invalid("rowNumber 必须是正整数"))?;
            let line_number = match row.get("lineNumber") { None => None, Some(value) => Some(value.as_u64().filter(|n| *n > 0).ok_or_else(|| invalid("lineNumber 必须是正整数"))?) };
            let values = array(row.get("values").ok_or_else(|| invalid("缺少导入行 values"))?, "values")?;
            if values.len() != columns.len() { return Err(invalid("导入行值数与目标列数不一致")); }
            let values = values.iter().map(cell_bind).collect::<DriverResult<Vec<_>>>()?;
            converted.push((row_number, line_number, values));
        }
        if self.import_active {
            if self.db()?.is_autocommit() { return Err(DriverError::new("query_failed", "导入事务已意外结束")); }
        } else {
            if !self.db()?.is_autocommit() { return Err(invalid("连接已有未提交事务，请先提交或回滚再导入")); }
            self.begin()?; self.import_active = true;
        }
        let names = columns.iter().map(|name| quote(name)).collect::<DriverResult<Vec<_>>>()?;
        let sql = format!("INSERT INTO {} ({}) VALUES ({})", quote(&target.name)?, names.join(", "), vec!["?"; names.len()].join(", "));
        let mut imported = 0usize;
        for (index, (row_number, line_number, values)) in converted.iter().enumerate() {
            let result = self.db()?.execute(&sql, params_from_iter(values.iter()));
            let location = format!("导入第 {} 批第 {} 行（CSV数据第 {} 行，物理行 {}）", batch_index + 1, index + 1, row_number, line_number.map(|n| n.to_string()).unwrap_or_else(|| "未知".into()));
            match result {
                Ok(1) => { imported += 1; self.pending += 1; },
                Ok(_) => return Err(DriverError::new("query_failed", format!("{location}：数据库没有准确写入一行；请回滚整个导入"))),
                Err(error) => {
                    // Trigger error text can contain transformed CSV values: never expose it.
                    let category = match error.sqlite_error_code() {
                        Some(rusqlite::ErrorCode::ConstraintViolation) => "写入违反数据库约束或被触发器拒绝",
                        Some(rusqlite::ErrorCode::TypeMismatch) => "写入值类型不匹配",
                        Some(rusqlite::ErrorCode::TooBig) => "写入值超过数据库长度限制",
                        _ => "数据库拒绝了这次写入",
                    };
                    return Err(DriverError::new("query_failed", format!("{location}，目标列 {}：{category}；请回滚整个导入", columns.join("、"))));
                }
            }
        }
        Ok(json!({"rowsImported":imported,"inTransaction":!self.db()?.is_autocommit()}))
    }
    fn create_table(&mut self, spec: &Value) -> DriverResult<()> {
        let name = text(spec.get("name").ok_or_else(|| invalid("缺少表名"))?, "表名")?;
        let columns = array(spec.get("columns").ok_or_else(|| invalid("缺少列定义"))?, "columns")?;
        if columns.is_empty() { return Err(invalid("建表至少需要一列")); }
        let mut names = HashSet::new(); let mut keys = Vec::new(); let mut ordinals = HashSet::new();
        for column in columns {
            let name = text(column.get("name").ok_or_else(|| invalid("缺少列名"))?, "列名")?;
            quote(name)?;
            if !names.insert(name.to_ascii_lowercase()) { return Err(invalid("列名重复")); }
            if let Some(value) = column.get("primaryKeyOrdinal").filter(|v| !v.is_null()) {
                let ordinal = value.as_u64().filter(|n| *n > 0).ok_or_else(|| invalid("主键序号必须是正整数"))?;
                if !ordinals.insert(ordinal) { return Err(invalid("主键序号重复")); }
                keys.push((ordinal, name.to_owned()));
            }
        }
        keys.sort_by_key(|(ordinal, _)| *ordinal);
        let mut definitions = Vec::new();
        for column in columns {
            let column_name = text(&column["name"], "列名")?;
            let kind = normalize_type(text(column.get("typeName").ok_or_else(|| invalid("缺少类型"))?, "typeName")?)?;
            let primary = column.get("primaryKeyOrdinal").is_some_and(|v| !v.is_null());
            let auto = column.get("autoIncrement").map(|value| value.as_bool().ok_or_else(|| invalid("autoIncrement 必须是布尔值"))).transpose()?;
            if auto == Some(true) && !(keys.len() == 1 && primary && kind == "INTEGER") { return Err(invalid("AUTOINCREMENT 仅支持单列 INTEGER 主键")); }
            let mut definition = format!("{} {kind}", quote(column_name)?);
            if primary && keys.len() == 1 {
                definition.push_str(" PRIMARY KEY");
                if kind == "INTEGER" && auto.unwrap_or(true) { definition.push_str(" AUTOINCREMENT"); }
            }
            if column.get("nullable").is_some_and(|v| v == &Value::Bool(false)) { definition.push_str(" NOT NULL"); }
            if let Some(default) = column.get("defaultValue").filter(|v| !v.is_null()) {
                definition.push_str(&format!(" DEFAULT {}", default_literal(text(default, "defaultValue")?)?));
            }
            definitions.push(definition);
        }
        if keys.len() > 1 { definitions.push(format!("PRIMARY KEY ({})", keys.iter().map(|(_, name)| quote(name)).collect::<DriverResult<Vec<_>>>()?.join(", "))); }
        self.ddl(&format!("CREATE TABLE {} ({})", quote(name)?, definitions.join(", ")))
    }
}

fn normalize_columns(target: &Target, values: &Map<String, Value>) -> DriverResult<Vec<(String, SqlValue)>> {
    let mut seen = HashSet::new(); let mut output = Vec::new();
    for (name, value) in values {
        let column = target.columns.iter().find(|c| c.name.eq_ignore_ascii_case(name)).ok_or_else(|| invalid(format!("列不存在: {name}")))?;
        if !seen.insert(column.name.clone()) { return Err(invalid("列名大小写重复")); }
        output.push((column.name.clone(), cell_bind(value)?));
    }
    Ok(output)
}
fn normalize_type(raw: &str) -> DriverResult<String> {
    let kind = raw.trim().to_ascii_uppercase();
    if ["INTEGER","INT","BIGINT","SMALLINT","TINYINT","REAL","DOUBLE","FLOAT","TEXT","CLOB","BLOB","NUMERIC","DECIMAL","BOOLEAN","BOOL","DATE","DATETIME","TIMESTAMP","JSON"].contains(&kind.as_str()) { return Ok(kind); }
    if let Some((name, arguments)) = kind.split_once('(') {
        let name = name.trim();
        if ["VARCHAR","CHAR","DECIMAL","NUMERIC"].contains(&name) && arguments.ends_with(')') {
            let arguments = &arguments[..arguments.len() - 1];
            let values = arguments.split(',').map(|s| s.trim().parse::<u32>()).collect::<Result<Vec<_>, _>>();
            if let Ok(values) = values {
                if !values.is_empty() && values.len() <= if name == "VARCHAR" || name == "CHAR" { 1 } else { 2 } {
                    return Ok(format!("{name}({})", values.iter().map(ToString::to_string).collect::<Vec<_>>().join(",")));
                }
            }
        }
    }
    Err(invalid("类型名不在 SQLite 建表白名单中"))
}
fn default_literal(raw: &str) -> DriverResult<String> {
    let value = raw.trim();
    if value.is_empty() { return Err(invalid("默认值不能为空")); }
    if ["NULL","CURRENT_TIMESTAMP","CURRENT_DATE","CURRENT_TIME"].contains(&value.to_ascii_uppercase().as_str()) { return Ok(value.to_ascii_uppercase()); }
    if value.parse::<f64>().is_ok_and(f64::is_finite) && value.chars().all(|c| c.is_ascii_digit() || "+-.eE".contains(c)) { return Ok(value.to_owned()); }
    if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 && quoted_end(value.as_bytes(), 0) == value.len() { return Ok(value.to_owned()); }
    Err(invalid("默认值只允许数字、单个字符串字面量、NULL 或 CURRENT_TIMESTAMP/DATE/TIME"))
}
fn matching_paren(sql: &str, start: usize) -> Option<usize> {
    let bytes = sql.as_bytes(); let mut i = start; let mut depth = 0usize;
    while i < bytes.len() {
        let next = trivia(bytes, i); if next != i { i = next; continue; }
        match bytes[i] {
            b'\'' | b'"' | b'`' | b'[' => i = quoted_end(bytes, i),
            b'(' => { depth += 1; i += 1; },
            b')' => { depth = depth.checked_sub(1)?; if depth == 0 { return Some(i); } i += 1; },
            _ => i += 1,
        }
    }
    None
}
fn first_parenthesized(sql: &str) -> Option<(usize, usize)> {
    let bytes = sql.as_bytes(); let mut i = 0;
    while i < bytes.len() {
        let next = trivia(bytes, i); if next != i { i = next; continue; }
        if [b'\'', b'"', b'`', b'['].contains(&bytes[i]) { i = quoted_end(bytes, i); }
        else if bytes[i] == b'(' { return matching_paren(sql, i).map(|end| (i, end)); }
        else { i += 1; }
    }
    None
}
fn check_expressions(sql: &str) -> Vec<String> {
    sql_words(sql).into_iter().filter(|word| word.word == "check").filter_map(|word| {
        let start = trivia(sql.as_bytes(), word.end);
        if sql.as_bytes().get(start) != Some(&b'(') { return None; }
        matching_paren(sql, start).map(|end| sql[start + 1..end].trim().to_owned())
    }).collect()
}
fn split_identifiers(raw: &str) -> Vec<String> {
    let bytes = raw.as_bytes(); let mut start = 0; let mut i = 0; let mut output = Vec::new();
    while i <= bytes.len() {
        if i == bytes.len() || bytes[i] == b',' {
            let item = raw[start..i].trim();
            if item.len() >= 2 && item.starts_with('"') && item.ends_with('"') { output.push(item[1..item.len()-1].replace("\"\"", "\"")); }
            else if item.len() >= 2 && item.starts_with('`') && item.ends_with('`') { output.push(item[1..item.len()-1].replace("``", "`")); }
            else if item.len() >= 2 && item.starts_with('[') && item.ends_with(']') { output.push(item[1..item.len()-1].to_owned()); }
            else if !item.is_empty() { output.push(item.to_owned()); }
            start = i + 1; i += 1;
        } else if [b'\'', b'"', b'`', b'['].contains(&bytes[i]) { i = quoted_end(bytes, i); } else { i += 1; }
    }
    output
}

fn relation(id: &str) -> DriverResult<(&str, &str)> {
    let (kind, name) = id.split_once(':').ok_or_else(|| object_error("无法识别的对象 id"))?;
    if !["table", "view"].contains(&kind) || name.is_empty() || name.contains('\0') { return Err(object_error("必须提供表或视图的原生对象 id")); }
    Ok((kind, name))
}
fn relation_kind<'a>(id: &'a str, expected: &str) -> DriverResult<(&'a str, &'a str)> {
    let (kind, name) = relation(id)?;
    if kind != expected { return Err(invalid(format!("此操作只接受 {expected} 节点"))); }
    Ok((kind, name))
}
fn escape_part(text: &str) -> String { text.replace('\\', "\\\\").replace('.', "\\.") }
fn value_type(value: ValueRef<'_>) -> &'static str {
    match value { ValueRef::Null => "null", ValueRef::Integer(_) => "integer", ValueRef::Real(_) => "real", ValueRef::Text(_) => "text", ValueRef::Blob(_) => "blob" }
}
fn cell(value: ValueRef<'_>, full: bool) -> DriverResult<Value> {
    Ok(match value {
        ValueRef::Null => json!({"kind":"null"}),
        ValueRef::Integer(n) if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n) => json!({"kind":"number","value":n}),
        ValueRef::Integer(n) => json!({"kind":"text","text":n.to_string()}),
        ValueRef::Real(n) if n.is_finite() => json!({"kind":"number","value":n}),
        ValueRef::Real(n) => json!({"kind":"text","text":n.to_string()}),
        ValueRef::Text(bytes) => {
            let text = std::str::from_utf8(bytes).map_err(|_| DriverError::new("query_failed", "TEXT 含无效 UTF-8，请用 hex() 检查原始字节"))?;
            let length = text.encode_utf16().count();
            if !full && length > MAX_TEXT {
                let mut units = 0;
                let preview = text.chars().take_while(|c| { units += c.len_utf16(); units <= MAX_TEXT }).collect::<String>();
                json!({"kind":"text","text":preview,"truncated":true,"fullLength":length})
            } else { json!({"kind":"text","text":text}) }
        },
        ValueRef::Blob(bytes) => {
            let length = bytes.len(); let preview = if full { bytes } else { &bytes[..length.min(MAX_BLOB)] };
            json!({"kind":"blob","previewBase64":BASE64.encode(preview),"length":length,"truncated":preview.len() < length})
        }
    })
}
fn parameter_value(value: &Value) -> DriverResult<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(v) => SqlValue::Integer(i64::from(*v)),
        Value::String(v) => SqlValue::Text(v.clone()),
        Value::Number(n) => if let Some(i) = n.as_i64() { SqlValue::Integer(i) } else {
            let f = n.as_f64().filter(|n| n.is_finite()).ok_or_else(|| invalid("数字超出 SQLite 参数范围"))?;
            if n.is_u64() { return Err(invalid("整数超出 SQLite 有符号64位范围，请明确使用文本")); }
            SqlValue::Real(f)
        },
        Value::Array(bytes) => SqlValue::Blob(bytes.iter().map(|v| v.as_u64().filter(|n| *n <= 255).map(|n| n as u8).ok_or_else(|| invalid("二进制参数必须是字节"))).collect::<DriverResult<Vec<_>>>()?),
        Value::Object(v) if v.get("type").and_then(Value::as_str) == Some("dbstudio-sql-bytes") => {
            let bytes = array(v.get("data").ok_or_else(|| invalid("缺少二进制参数 data"))?, "data")?;
            SqlValue::Blob(bytes.iter().map(|v| v.as_u64().filter(|n| *n <= 255).map(|n| n as u8).ok_or_else(|| invalid("二进制参数必须是字节"))).collect::<DriverResult<Vec<_>>>()?)
        },
        _ => return Err(invalid("参数必须是字符串、数值、布尔、null 或二进制字节对象")),
    })
}
fn cell_bind(value: &Value) -> DriverResult<SqlValue> {
    let item = record(value, "CellValue")?;
    if item.get("truncated").and_then(Value::as_bool) == Some(true) { return Err(invalid("不能把截断的文本或二进制预览写回数据库")); }
    match item.get("kind").and_then(Value::as_str) {
        Some("null") => Ok(SqlValue::Null),
        Some("text") => Ok(SqlValue::Text(text(item.get("text").ok_or_else(|| invalid("缺少文本"))?, "text")?.to_owned())),
        Some("number") | Some("boolean") => parameter_value(item.get("value").ok_or_else(|| invalid("缺少 value"))?),
        Some("blob") => {
            let encoded = text(item.get("previewBase64").ok_or_else(|| invalid("缺少 base64"))?, "previewBase64")?;
            let bytes = BASE64.decode(encoded).map_err(|_| invalid("无效的 base64 二进制值"))?;
            if item.get("length").and_then(Value::as_u64).is_some_and(|len| len != bytes.len() as u64) { return Err(invalid("二进制长度不完整")); }
            Ok(SqlValue::Blob(bytes))
        },
        _ => Err(invalid("未知 CellValue 类型")),
    }
}

#[derive(Clone)]
struct Word { word: String, start: usize, end: usize, depth: usize }
fn trivia(bytes: &[u8], mut i: usize) -> usize {
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
        if bytes.get(i..i + 2) == Some(b"--") { while i < bytes.len() && bytes[i] != b'\n' { i += 1; } }
        else if bytes.get(i..i + 2) == Some(b"/*") {
            i += 2; while i + 1 < bytes.len() && bytes.get(i..i + 2) != Some(b"*/") { i += 1; } i = (i + 2).min(bytes.len());
        } else { return i; }
    }
}
fn quoted_end(bytes: &[u8], start: usize) -> usize {
    let end_quote = if bytes[start] == b'[' { b']' } else { bytes[start] };
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == end_quote { if bytes.get(i + 1) == Some(&end_quote) { i += 2; } else { return i + 1; } } else { i += 1; }
    }
    bytes.len()
}
fn sql_words(sql: &str) -> Vec<Word> {
    let bytes = sql.as_bytes(); let mut i = 0; let mut depth = 0usize; let mut words = Vec::new();
    while i < bytes.len() {
        let next = trivia(bytes, i); if next != i { i = next; continue; }
        match bytes[i] {
            b'\'' | b'"' | b'`' | b'[' => { i = quoted_end(bytes, i); },
            b'(' => { depth += 1; i += 1; }, b')' => { depth = depth.saturating_sub(1); i += 1; },
            b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                let start = i; i += 1;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') { i += 1; }
                words.push(Word { word: sql[start..i].to_ascii_lowercase(), start, end: i, depth });
            },
            _ => i += 1,
        }
    }
    words
}
fn keyword(sql: &str) -> String {
    let words = sql_words(sql); let top = words.iter().filter(|w| w.depth == 0).collect::<Vec<_>>();
    if top.first().is_some_and(|w| w.word == "with") {
        top.iter().skip(1).find(|w| ["select", "values", "insert", "update", "delete", "replace"].contains(&w.word.as_str())).map(|w| w.word.clone()).unwrap_or_default()
    } else { top.first().map(|w| w.word.clone()).unwrap_or_default() }
}
fn single_statement(raw: &str) -> DriverResult<String> {
    if raw.trim().is_empty() || raw.contains('\0') { return Err(invalid("SQL 不能为空或包含 NUL")); }
    let bytes = raw.as_bytes(); let mut i = 0;
    while i < bytes.len() {
        let next = trivia(bytes, i); if next != i { i = next; continue; }
        match bytes[i] {
            b'\'' | b'"' | b'`' | b'[' => i = quoted_end(bytes, i),
            b';' => {
                let prefix = CString::new(&raw[..=i]).map_err(|_| invalid("SQL 含 NUL"))?;
                // sqlite3_complete recognizes trigger BEGIN/END blocks without executing SQL.
                let complete = unsafe { rusqlite::ffi::sqlite3_complete(prefix.as_ptr()) != 0 };
                if complete {
                    if trivia(bytes, i + 1) < bytes.len() { return Err(invalid("一次只能执行一条 SQL 语句")); }
                    return Ok(raw[..i].trim().to_owned());
                }
                i += 1;
            },
            _ => i += 1,
        }
    }
    if trivia(bytes, 0) == bytes.len() { return Err(invalid("没有可执行的 SQL")); }
    Ok(raw.trim().to_owned())
}
fn bind_parameters(db: &Connection, sql: &str, options: Option<&Value>) -> DriverResult<Vec<SqlValue>> {
    if options.is_some_and(|v| !v.is_object() && !v.is_null()) { return Err(invalid("QueryOptions 必须是对象")); }
    let mut supplied = HashMap::new();
    if let Some(parameters) = options.and_then(|v| v.get("parameters")) {
        for entry in array(parameters, "parameters")? {
            let name = text(entry.get("name").ok_or_else(|| invalid("参数缺少 name"))?, "参数名")?.trim().trim_start_matches(':').to_owned();
            if name.is_empty() || supplied.insert(name, parameter_value(entry.get("value").ok_or_else(|| invalid("参数缺少 value"))?)?).is_some() { return Err(invalid("参数名为空或重复")); }
        }
    }
    let stmt = db.prepare(sql).map_err(db_error)?;
    let mut params = Vec::new(); let mut used = HashSet::new(); let mut anonymous = 0;
    for index in 1..=stmt.parameter_count() {
        let name = match stmt.parameter_name(index) {
            Some(name) if name.starts_with(':') => name[1..].to_owned(),
            Some(_) => return Err(invalid("SQLite 参数请使用 ? 或 :name，不支持数字编号、@ 或 $ 参数")),
            None => { anonymous += 1; format!("?{anonymous}") },
        };
        params.push(supplied.get(&name).cloned().ok_or_else(|| invalid(format!("缺少参数 {name}")))?); used.insert(name);
    }
    if supplied.keys().any(|key| !used.contains(key)) { return Err(invalid("提供了没有对应占位符的参数")); }
    Ok(params)
}
