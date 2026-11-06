//! Native, bounded local CSV import and paged export. No JavaScript backend.
//! Partial exports are deliberately retained: publishing never replaces a user file.
use crate::{session::Session, with_export_destination_shared, AppError, Application};
use dbstudio_protocol::Driver;
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Condvar, Mutex},
    thread,
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, AppError>;
const MAX_FIELD: usize = 1024 * 1024;
const MAX_RECORD: usize = 4 * MAX_FIELD;
const MAX_COLUMNS: usize = 2048;
const MAX_TASKS: usize = 256;

fn lock<T>(value: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    value.lock().map_err(|_| AppError::new("internal", "任务状态锁不可用"))
}
fn io_error(_: std::io::Error) -> AppError { AppError::new("file-io", "无法读写本地任务文件") }
fn invalid(message: &str) -> AppError { AppError::invalid(message) }
fn driver_call(driver: &mut dyn Driver, method: &str, args: Vec<Value>) -> Result<Value> {
    driver.call(method, args).map_err(crate::safe_error)
}
fn cancelled() -> AppError { AppError::new("cancelled", "任务已取消，未发布导出或提交导入") }
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| invalid("缺少必需的字符串参数"))
}
fn bounded(value: Option<&Value>, default: u64, max: u64) -> Result<usize> {
    let n = match value { None => default, Some(v) => v.as_u64().ok_or_else(|| invalid("批大小或样例上限必须是整数"))? };
    if n > max || n == 0 { return Err(invalid("批大小或样例上限超出允许范围")) }
    Ok(n as usize)
}
fn absolute(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute() { return Err(invalid("文件路径必须为绝对路径")) }
    Ok(path)
}
fn terminal(status: &str) -> bool { matches!(status, "completed" | "failed" | "cancelled") }

#[derive(Clone, Copy, PartialEq)]
enum Kind { Import, Export }
struct Task {
    kind: Kind,
    id: String,
    session: Arc<Session>,
    cancel: AtomicBool,
    progress: Mutex<Value>,
    done: Condvar,
}
impl Task {
    fn check(&self) -> Result<()> {
        if self.cancel.load(Ordering::Acquire) || !self.session.is_active() { Err(cancelled()) } else { Ok(()) }
    }
    fn update(&self, update: impl FnOnce(&mut Value)) -> Result<()> {
        let mut progress = lock(&self.progress)?;
        update(&mut progress);
        Ok(())
    }
    fn committing(&self) -> Result<()> {
        let mut progress = lock(&self.progress)?;
        self.check()?;
        progress["status"] = json!("committing");
        Ok(())
    }
    fn finish(&self, result: Result<Value>) {
        if let Ok(mut progress) = self.progress.lock() {
            match result {
                Ok(extra) => {
                    progress["status"] = json!("completed");
                    if let Some(extra) = extra.as_object() {
                        for (key, value) in extra { progress[key] = value.clone(); }
                    }
                }
                Err(error) => {
                    progress["status"] = json!(if error.code == "cancelled" { "cancelled" } else { "failed" });
                    progress["code"] = json!(error.code);
                    progress["message"] = json!(error.message);
                }
            }
            self.done.notify_all();
        }
    }
}

#[derive(Default)]
pub(crate) struct TaskRegistry { tasks: Mutex<HashMap<String, Arc<Task>>> }
impl TaskRegistry {
    fn register(&self, task: Arc<Task>) -> Result<()> {
        let mut tasks = lock(&self.tasks)?;
        if tasks.len() >= MAX_TASKS { return Err(AppError::new("resource-limit", "任务记录已达上限，请重新打开应用")) }
        if tasks.values().any(|other| other.session.generation == task.session.generation &&
            other.progress.lock().map(|p| !terminal(p["status"].as_str().unwrap_or(""))).unwrap_or(true)) {
            return Err(AppError::new("conflict", "该连接已有导入或导出任务"));
        }
        tasks.insert(task.id.clone(), task);
        Ok(())
    }
    fn get(&self, id: &str, kind: Kind) -> Result<Option<Arc<Task>>> {
        Ok(lock(&self.tasks)?.get(id).filter(|task| task.kind == kind).cloned())
    }
    /// Call before disconnecting/closing sessions; workers roll back while holding their driver.
    pub(crate) fn cancel_all(&self) -> Result<()> {
        let tasks: Vec<_> = lock(&self.tasks)?.values().cloned().collect();
        for task in tasks {
            let progress = lock(&task.progress)?;
            if !terminal(progress["status"].as_str().unwrap_or("")) && progress["status"] != "committing" {
                task.cancel.store(true, Ordering::Release);
                drop(progress);
                let _ = task.session.cancel(Some(&task.id));
            }
        }
        Ok(())
    }
    pub(crate) fn wait_all(&self) -> Result<()> {
        let tasks: Vec<_> = lock(&self.tasks)?.values().cloned().collect();
        for task in tasks { wait(&task)?; }
        Ok(())
    }
}
fn wait(task: &Task) -> Result<Value> {
    let mut progress = lock(&task.progress)?;
    while !terminal(progress["status"].as_str().unwrap_or("")) {
        progress = task.done.wait(progress).map_err(|_| AppError::new("internal", "等待任务失败"))?;
    }
    Ok(progress.clone())
}

pub(crate) fn dispatch(app: &Application, method: &str, args: &[Value]) -> Option<Result<Value>> {
    let result = match method {
        "previewImport" => args.first().ok_or_else(|| invalid("缺少预览请求")).and_then(preview),
        "startTransfer" => args.first().ok_or_else(|| invalid("缺少导出请求")).and_then(|request| start_export(app, request)),
        "startImport" => args.first().ok_or_else(|| invalid("缺少导入请求")).and_then(|request| start_import(app, request)),
        "getTransferProgress" | "waitTransfer" | "cancelTransfer" | "getImportProgress" | "waitImport" | "cancelImport" => {
            let kind = if method.ends_with("Import") || method == "getImportProgress" { Kind::Import } else { Kind::Export };
            (|| {
                let id = args.first().and_then(Value::as_str).ok_or_else(|| invalid("缺少 taskId"))?;
                let task = app.tasks.get(id, kind)?;
                if method.starts_with("get") { return task.map(|task| Ok(lock(&task.progress)?.clone())).unwrap_or(Ok(Value::Null)) }
                if method.starts_with("cancel") {
                    let Some(task) = task else { return Ok(json!(false)) };
                    let progress = lock(&task.progress)?;
                    if terminal(progress["status"].as_str().unwrap_or("")) || progress["status"] == "committing" { return Ok(json!(false)) }
                    task.cancel.store(true, Ordering::Release);
                    drop(progress);
                    let _ = task.session.cancel(Some(&task.id));
                    return Ok(json!(true));
                }
                let task = task.ok_or_else(|| AppError::new("not-found", "任务不存在"))?;
                wait(task.as_ref())
            })()
        }
        _ => return None,
    };
    Some(result)
}

#[derive(Clone)]
struct CsvOptions { path: PathBuf, delimiter: char, null_text: String, header: bool, sample: usize }
impl CsvOptions {
    fn parse(value: &Value) -> Result<Self> {
        let path = absolute(text(value, "sourcePath")?)?;
        let delimiter = text(value, "delimiter")?;
        let mut chars = delimiter.chars();
        let delimiter = chars.next().filter(|c| !matches!(c, '"' | '\r' | '\n' | '\0')).ok_or_else(|| invalid("CSV 分隔符无效"))?;
        if chars.next().is_some() { return Err(invalid("CSV 分隔符必须是单个字符")) }
        Ok(Self { path, delimiter, null_text: text(value, "nullText")?.to_owned(),
            header: value.get("hasHeader").and_then(Value::as_bool).ok_or_else(|| invalid("hasHeader 必须是布尔值"))?,
            sample: bounded(value.get("sampleRowLimit"), 50, 200)? })
    }
}
#[derive(Clone)]
struct Field { value: String, quoted: bool }
struct Record { fields: Vec<Field>, line: u64, issue: Option<(&'static str, usize)> }
struct CsvReader {
    reader: BufReader<File>, delimiter: char, line: u64, previous_cr: bool, first: bool,
    skip_lf: bool, eof: bool,
}
impl CsvReader {
    fn new(file: File, delimiter: char) -> Self {
        Self { reader: BufReader::new(file), delimiter, line: 1, previous_cr: false, first: true, skip_lf: false, eof: false }
    }
    fn character(&mut self) -> Result<Option<char>> {
        let mut bytes = [0u8; 4];
        if self.reader.read(&mut bytes[..1]).map_err(io_error)? == 0 { return Ok(None) }
        let length = match bytes[0] { 0..=127 => 1, 194..=223 => 2, 224..=239 => 3, 240..=244 => 4,
            _ => return Err(AppError::new("invalid-encoding", "CSV 必须使用有效 UTF-8 编码")) };
        self.reader.read_exact(&mut bytes[1..length]).map_err(|_| AppError::new("invalid-encoding", "CSV 含不完整 UTF-8 字符"))?;
        let c = std::str::from_utf8(&bytes[..length]).map_err(|_| AppError::new("invalid-encoding", "CSV 必须使用有效 UTF-8 编码"))?.chars().next().unwrap();
        if self.first { self.first = false; if c == '\u{feff}' { return self.character() } }
        if c == '\r' || (c == '\n' && !self.previous_cr) { self.line += 1; }
        self.previous_cr = c == '\r';
        Ok(Some(c))
    }
    fn next(&mut self) -> Result<Option<Record>> {
        if self.eof { return Ok(None) }
        let mut fields = Vec::new();
        let mut value = String::new();
        let mut quoted = false;
        let mut mode = 0; // 0 unquoted, 1 quoted, 2 closing quote
        let mut issue = None;
        let mut line = self.line;
        let mut bytes = 0;
        let mut any = false;
        loop {
            let character = self.character()?;
            if self.skip_lf {
                self.skip_lf = false;
                if character == Some('\n') { line = self.line; continue }
            }
            let Some(c) = character else {
                self.eof = true;
                if !any && fields.is_empty() && value.is_empty() { return Ok(None) }
                if mode == 1 { issue = Some(("unterminated-quote", fields.len() + 1)); }
                fields.push(Field { value, quoted });
                return Ok(Some(Record { fields, line, issue }));
            };
            any = true;
            bytes += c.len_utf8();
            if bytes > MAX_RECORD || value.len() > MAX_FIELD || fields.len() >= MAX_COLUMNS {
                return Err(AppError::new("resource-limit", "CSV 单字段、记录或列数超出安全上限"));
            }
            if mode == 1 {
                if c == '"' { mode = 2; } else { value.push(c); }
                continue;
            }
            if mode == 2 && c == '"' { value.push('"'); mode = 1; continue }
            if c == self.delimiter {
                fields.push(Field { value: std::mem::take(&mut value), quoted });
                quoted = false; mode = 0;
            } else if c == '\r' || c == '\n' {
                self.skip_lf = c == '\r';
                fields.push(Field { value, quoted });
                return Ok(Some(Record { fields, line, issue }));
            } else if c == '"' && mode == 0 && value.is_empty() {
                quoted = true; mode = 1;
            } else {
                if c == '"' || mode == 2 { issue.get_or_insert(("malformed-quote", fields.len() + 1)); }
                value.push(c); mode = 0;
            }
        }
    }
}
fn blank(record: &Record) -> bool {
    record.issue.is_none() && record.fields.len() == 1 && !record.fields[0].quoted && record.fields[0].value.is_empty()
}
fn issue(code: &str, row: Option<u64>, line: Option<u64>, column: Option<usize>, name: Option<&str>) -> Value {
    json!({"code":code,"message":match code {
        "empty-file"=>"CSV 文件为空", "duplicate-column"=>"CSV 列名重复", "empty-header"=>"CSV 列名为空",
        "missing-column"=>"CSV 缺少列", "extra-column"=>"CSV 包含多余列", "unterminated-quote"=>"CSV 引号未闭合",
        "malformed-quote"=>"CSV 引号格式错误", "invalid-encoding"=>"CSV 必须为 UTF-8", _=>"CSV 读取失败"},
        "row":row,"line":line,"column":column,"columnName":name})
}
fn field_value(field: &Field, null_text: &str) -> Value {
    if !field.quoted && field.value == null_text { json!({"kind":"null"}) }
    else { json!({"kind":"text","text":field.value}) }
}
fn preview_scan(file: File, options: &CsvOptions, cancelled_check: impl Fn() -> Result<()>) -> Result<Value> {
    let mut reader = CsvReader::new(file, options.delimiter);
    let mut names: Vec<String> = Vec::new();
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut errors = Vec::new();
    let mut error_count = 0;
    let mut total = 0u64;
    let mut first = true;
    loop {
        cancelled_check()?;
        let record = match reader.next() {
            Ok(Some(record)) => record, Ok(None) => break,
            Err(error) => {
                error_count += 1;
                if errors.len() < 100 { errors.push(issue(&error.code, None, Some(reader.line), None, None)); }
                break;
            }
        };
        if blank(&record) { continue }
        let header = first && options.header;
        if first {
            names = record.fields.iter().enumerate().map(|(index, field)| if options.header { field.value.clone() } else { format!("column_{}", index + 1) }).collect();
            for (index, name) in names.iter().enumerate() {
                let duplicate = names.iter().filter(|other| *other == name).count() > 1;
                columns.push(json!({"index":index+1,"name":name,"duplicate":duplicate}));
                for code in [if duplicate { Some("duplicate-column") } else { None }, if name.trim().is_empty() { Some("empty-header") } else { None }].into_iter().flatten() {
                    error_count += 1;
                    if errors.len() < 100 { errors.push(issue(code, None, Some(record.line), Some(index + 1), Some(name))); }
                }
            }
            first = false;
        }
        if !header { total += 1; }
        if let Some((code, column)) = record.issue {
            error_count += 1;
            if errors.len() < 100 { errors.push(issue(code, if header { None } else { Some(total) }, Some(record.line), Some(column), names.get(column - 1).map(String::as_str))); }
        }
        if header { continue }
        if record.fields.len() != names.len() {
            error_count += 1;
            let column = record.fields.len().min(names.len()) + 1;
            if errors.len() < 100 { errors.push(issue(if record.fields.len() < names.len() { "missing-column" } else { "extra-column" }, Some(total), Some(record.line), Some(column), names.get(column - 1).map(String::as_str))); }
        }
        if rows.len() < options.sample {
            let values: Vec<Value> = record.fields.iter().map(|field| {
                let mut value = field_value(field, &options.null_text);
                value["text"] = if value["kind"] == "null" { Value::Null } else { json!(field.value) };
                value["quoted"] = json!(field.quoted); value
            }).collect();
            rows.push(json!({"row":total,"line":record.line,"values":values}));
        }
    }
    if first { error_count += 1; if errors.len() < 100 { errors.push(issue("empty-file", None, None, None, None)); } }
    Ok(json!({"sourcePath":options.path,"ok":error_count==0,"columns":columns,"sampleRows":rows,"errors":errors,
        "errorCount":error_count,"totalRows":total,"truncated":total > rows.len() as u64,
        "delimiter":options.delimiter.to_string(),"nullText":options.null_text,"hasHeader":options.header}))
}
fn source_file(path: &Path) -> Result<File> {
    let file = File::open(path).map_err(io_error)?;
    if !file.metadata().map_err(io_error)?.is_file() { return Err(invalid("CSV 来源必须是普通文件")) }
    Ok(file)
}
fn preview(request: &Value) -> Result<Value> {
    let options = CsvOptions::parse(request)?;
    preview_scan(source_file(&options.path)?, &options, || Ok(()))
}

fn split_node(node: &str) -> Result<(&str, Option<&str>)> {
    let scoped = node.strip_prefix("connection:").ok_or_else(|| invalid("节点缺少连接作用域"))?;
    let (connection, raw) = scoped.split_once('|').map(|(id, raw)| (id, Some(raw))).unwrap_or((scoped, None));
    if connection.is_empty() || raw == Some("") { return Err(invalid("节点标识无效")) }
    Ok((connection, raw))
}
fn fingerprint(file: &File) -> Result<(u64, Option<std::time::SystemTime>)> {
    let metadata = file.metadata().map_err(io_error)?;
    Ok((metadata.len(), metadata.modified().ok()))
}
fn spawn_task(app: &Application, kind: Kind, session: Arc<Session>, mut progress: Value,
    operation: impl FnOnce(&Task, &mut dyn Driver) -> Result<Value> + Send + 'static) -> Result<Value> {
    let id = Uuid::new_v4().to_string();
    progress["taskId"] = json!(id);
    let task = Arc::new(Task { id, kind, session, cancel: AtomicBool::new(false), progress: Mutex::new(progress.clone()), done: Condvar::new() });
    app.with_task_registration(|| app.tasks.register(task.clone()))?;
    let worker = task.clone();
    if thread::Builder::new().name("dbstudio-data-task".into()).spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            worker.session.with_task_driver(&worker.id, |driver| {
                worker.check()?;
                worker.update(|p| p["status"] = json!("running"))?;
                operation(&worker, driver)
            })
        })).unwrap_or_else(|_| Err(AppError::new("internal", "原生任务异常终止，请核对目标")));
        worker.finish(result);
    }).is_err() {
        task.finish(Err(AppError::new("resource-limit", "无法启动原生任务线程")));
        return Err(AppError::new("resource-limit", "无法启动原生任务线程"));
    }
    Ok(progress)
}

fn validate_mapping(description: &Value, target_columns: &[String]) -> Result<Vec<String>> {
    let columns = description["columns"].as_array().ok_or_else(|| invalid("驱动没有返回表结构"))?;
    let mut mapped = Vec::new();
    for wanted in target_columns {
        let column = columns.iter().find(|column| column["name"].as_str() == Some(wanted))
            .or_else(|| columns.iter().find(|column| column["name"].as_str().map(|name| name.eq_ignore_ascii_case(wanted)).unwrap_or(false)))
            .ok_or_else(|| invalid("导入映射包含未知目标列"))?;
        if column["generated"].as_bool() == Some(true) || column["generated"].as_str().is_some_and(|s| !s.is_empty()) ||
            column["hidden"].as_bool() == Some(true) || column["isGenerated"].as_bool() == Some(true) || column["identityGeneration"].as_str() == Some("always") {
            return Err(invalid("导入映射不能写入生成列或 ALWAYS identity 列"));
        }
        let name = text(column, "name")?.to_owned();
        if mapped.contains(&name) { return Err(invalid("导入映射包含重复目标列")) }
        mapped.push(name);
    }
    for column in columns {
        let name = text(column, "name")?;
        let generated = column["generated"].as_bool() == Some(true) || column["isGenerated"].as_bool() == Some(true) ||
            column["generated"].as_str().is_some_and(|s| !s.is_empty());
        let identity = column["identity"].as_bool() == Some(true) || column["isIdentity"].as_bool() == Some(true) ||
            column["autoIncrement"].as_bool() == Some(true) || column["identityGeneration"].as_str().is_some();
        let default = column.get("defaultValue").or_else(|| column.get("defaultExpression")).is_some_and(|v| !v.is_null());
        let required = column["requiredOnInsert"].as_bool().unwrap_or(column["nullable"].as_bool() == Some(false) && !generated && !identity && !default);
        if required && !mapped.iter().any(|mapped| mapped == name) {
            return Err(invalid("导入映射遗漏无默认值的必填列"));
        }
    }
    Ok(mapped)
}
fn start_import(app: &Application, request: &Value) -> Result<Value> {
    let options = CsvOptions::parse(request)?;
    let node = text(request, "targetNodeId")?.to_owned();
    let (_, raw) = split_node(&node)?;
    let raw = raw.ok_or_else(|| invalid("导入目标必须是具体表"))?.to_owned();
    let session = app.capture_session(&node)?;
    let target_columns: Vec<String> = request["targetColumns"].as_array().filter(|v| !v.is_empty()).ok_or_else(|| invalid("导入必须指定列映射"))?
        .iter().map(|v| v.as_str().filter(|s| !s.trim().is_empty()).map(str::to_owned).ok_or_else(|| invalid("导入列映射必须是非空字符串"))).collect::<Result<_>>()?;
    let batch_size = bounded(request.get("batchSize"), 200, 1000)?;
    let file = source_file(&options.path)?;
    let progress = json!({"status":"queued","totalRows":0,"rowsImported":0,"batches":0,"sourcePath":options.path,"targetNodeId":node});
    spawn_task(app, Kind::Import, session, progress, move |task, driver| {
        // Pre-existing user transactions are never adopted or rolled back by an import.
        let state = driver_call(driver, "transactionState", vec![])?;
        if state["active"].as_bool() != Some(false) { return Err(AppError::new("conflict", "连接存在未提交事务，已拒绝导入")) }
        let description = driver_call(driver, "describeTable", vec![json!(raw)])?;
        let columns = validate_mapping(&description, &target_columns)?;
        let before = fingerprint(&file)?;
        let mut scan_options = options.clone(); scan_options.sample = 0;
        let parsed = preview_scan(file.try_clone().map_err(io_error)?, &scan_options, || task.check())?;
        if parsed["errorCount"].as_u64() != Some(0) {
            if let Some(first) = parsed["errors"].as_array().and_then(|v| v.first()) {
                task.update(|p| { for key in ["row", "line", "column", "columnName"] { if !first[key].is_null() { p[key] = first[key].clone(); } } })?;
            }
            return Err(AppError::new("invalid-csv", "CSV 结构校验失败，未写入目标"));
        }
        if parsed["columns"].as_array().map(Vec::len) != Some(columns.len()) { return Err(invalid("CSV 列数与目标映射长度不一致")) }
        let total = parsed["totalRows"].as_u64().unwrap_or(0);
        task.update(|p| p["totalRows"] = json!(total))?;
        let mut file = file; file.seek(SeekFrom::Start(0)).map_err(io_error)?;
        if fingerprint(&file)? != before { return Err(AppError::new("source-changed", "CSV 文件在校验期间发生变化")) }
        let mut reader = CsvReader::new(file, options.delimiter);
        let mut row_number = 0u64;
        let mut first = true;
        let mut batch = Vec::with_capacity(batch_size);
        let mut batches = 0u64;
        let mut owns_transaction = false;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            loop {
                task.check()?;
                let record = match reader.next()? { Some(record) => record, None => break };
                if blank(&record) { continue }
                if first { first = false; if options.header { continue } }
                row_number += 1;
                if record.issue.is_some() || record.fields.len() != columns.len() { return Err(AppError::new("source-changed", "CSV 在导入期间出现结构变化")) }
                batch.push(json!({"rowNumber":row_number,"lineNumber":record.line,"values":record.fields.iter().map(|f| field_value(f,&options.null_text)).collect::<Vec<_>>()}));
                if batch.len() == batch_size {
                    task.check()?;
                    owns_transaction = true;
                    let result = driver_call(driver, "importBatch", vec![json!(raw), json!({"batchIndex":batches,"columns":columns,"rows":batch})])?;
                    if result["rowsImported"].as_u64() != Some(batch.len() as u64) || result["inTransaction"].as_bool() != Some(true) { return Err(AppError::new("driver-contract", "驱动未确认完整批次与未提交事务")) }
                    batches += 1; batch.clear();
                    task.update(|p| { p["rowsImported"] = json!(row_number); p["batches"] = json!(batches); })?;
                }
            }
            if !batch.is_empty() {
                task.check()?; owns_transaction = true;
                let result = driver_call(driver, "importBatch", vec![json!(raw), json!({"batchIndex":batches,"columns":columns,"rows":batch})])?;
                if result["rowsImported"].as_u64() != Some(batch.len() as u64) || result["inTransaction"].as_bool() != Some(true) { return Err(AppError::new("driver-contract", "驱动未确认完整批次与未提交事务")) }
                batches += 1;
                task.update(|p| { p["rowsImported"] = json!(row_number); p["batches"] = json!(batches); })?;
            }
            if row_number != total || fingerprint(reader.reader.get_ref())? != before { return Err(AppError::new("source-changed", "CSV 在导入期间发生变化，已停止提交")) }
            task.committing()?;
            if owns_transaction {
                let result = driver_call(driver, "commitTransaction", vec![]).map_err(|_| AppError::new("commit-outcome-unknown", "提交结果未知，请核对目标后再重试"))?;
                if result["active"].as_bool() != Some(false) { return Err(AppError::new("commit-outcome-unknown", "提交结果未确认，请核对目标后再重试")) }
                owns_transaction = false;
            }
            Ok(json!({"rowsImported":row_number,"batches":batches}))
        })).unwrap_or_else(|_| Err(AppError::new("internal", "导入任务异常，已尝试回滚")));
        match outcome {
            Ok(value) => Ok(value),
            Err(error) => {
                // A failed COMMIT can already have reached the database; never claim rollback then.
                if error.code == "commit-outcome-unknown" { return Err(error) }
                if owns_transaction {
                    match driver_call(driver, "rollbackTransaction", vec![]) {
                        Ok(value) if value["active"].as_bool() == Some(false) => { task.update(|p| p["rowsImported"] = json!(0))?; },
                        _ => return Err(AppError::new("rollback-failed", "无法确认导入回滚，请断开连接后核对目标")),
                    }
                }
                if task.cancel.load(Ordering::Acquire) || !task.session.is_active() { Err(cancelled()) } else { Err(error) }
            }
        }
    })
}

fn normalize_path(path: &Path) -> Result<PathBuf> {
    if path.exists() { return fs::canonicalize(path).map_err(io_error) }
    let name = path.file_name().ok_or_else(|| invalid("目标文件名无效"))?;
    Ok(fs::canonicalize(path.parent().ok_or_else(|| invalid("目标父目录无效"))?).map_err(io_error)?.join(name))
}
fn normalize_protected_path(path: &Path, depth: usize) -> Result<PathBuf> {
    if depth > 16 { return Err(invalid("数据库附属文件链接无法安全解析")) }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let target = fs::read_link(path).map_err(io_error)?;
            let target = if target.is_absolute() { target } else { path.parent().ok_or_else(|| invalid("附属文件父目录无效"))?.join(target) };
            normalize_protected_path(&target, depth + 1)
        },
        Ok(_) => normalize_path(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => normalize_path(path),
        Err(error) => Err(io_error(error)),
    }
}
fn fold_path_key(path: &Path) -> Result<String> {
    let value = path.to_str().ok_or_else(|| invalid("导出目标路径必须是有效 UTF-8"))?;
    let normalized: String = value.nfkc().collect();
    let mut folded = String::with_capacity(normalized.len());
    for character in normalized.chars() {
        match character {
            '\u{00df}' | '\u{1e9e}' => folded.push_str("ss"),
            '\u{03c2}' => folded.push('\u{03c3}'),
            _ => folded.extend(character.to_lowercase()),
        }
    }
    Ok(folded.as_str().nfkc().collect())
}
fn folded_starts_with(child: &str, parent: &str) -> bool {
    child == parent
        || parent.ends_with(std::path::MAIN_SEPARATOR) && child.starts_with(parent)
        || child.strip_prefix(parent).is_some_and(|rest| rest.starts_with(std::path::MAIN_SEPARATOR))
}
pub(crate) fn destination_allowed(path: &Path, databases: &[PathBuf], protected_root: &Path) -> Result<()> {
    // Existing files, dangling symlinks and hard links are all rejected before any write.
    if fs::symlink_metadata(path).is_ok() { return Err(AppError::new("destination-exists", "目标已存在，禁止覆盖用户文件")) }
    let destination = normalize_path(path)?;
    // Conservative on every platform: case-sensitive volumes may reject an
    // otherwise distinct case-only target, but never allow a protected alias.
    let destination_key = fold_path_key(&destination)?;
    let application_data = fs::canonicalize(protected_root).map_err(io_error)?;
    if folded_starts_with(&destination_key, &fold_path_key(&application_data)?) {
        return Err(AppError::new("application-data-path", "导出目标不能位于应用私有数据目录内"))
    }
    for database in databases {
        // Resolve the main file before deriving sidecars: an alias's real -wal may not exist yet.
        let real_database = normalize_path(database)?;
        for base in [database, &real_database] {
            for suffix in ["", "-wal", "-shm", "-journal"] {
                let mut name = base.as_os_str().to_os_string();
                name.push(suffix);
                if fold_path_key(&normalize_protected_path(&PathBuf::from(name), 0)?)? == destination_key {
                    return Err(AppError::new("database-path", "导出目标是 SQLite 数据库或其附属文件"))
                }
            }
        }
    }
    Ok(())
}
fn quote_identifier(name: &str, dialect: &str) -> Result<String> {
    if name.is_empty() || name.contains('\0') { return Err(invalid("SQL 标识符为空或含 NUL")) }
    match dialect {
        "sqlite" | "postgresql" => Ok(format!("\"{}\"", name.replace('"', "\"\""))),
        "mysql" => Ok(format!("`{}`", name.replace('`', "``"))),
        _ => Err(AppError::unsupported("当前方言不支持 SQL INSERT 导出")),
    }
}
fn insert_target(target: &Value, dialect: &str) -> Result<String> {
    if target["kind"] != "table" { return Err(invalid("SQL INSERT 导出必须来源于具体表")) }
    let schema = if dialect == "sqlite" { "main" } else { text(target, "schema")? };
    let table = target.get("table").or_else(|| target.get("name")).and_then(Value::as_str).ok_or_else(|| invalid("INSERT 目标没有表名"))?;
    Ok(format!("{}.{}", quote_identifier(schema, dialect)?, quote_identifier(table, dialect)?))
}
fn cell_json(cell: &Value) -> Result<Value> {
    if cell["truncated"].as_bool() == Some(true) { return Err(AppError::new("truncated-cell", "导出遇到截断值，已拒绝写入不完整数据")) }
    match cell["kind"].as_str() {
        Some("null") => Ok(Value::Null),
        Some("text") => Ok(json!(text(cell, "text")?)),
        Some("number") if cell["value"].is_number() => Ok(cell["value"].clone()),
        Some("boolean") if cell["value"].is_boolean() => Ok(cell["value"].clone()),
        Some("blob") => Ok(json!(format!("0x{}", blob_hex(text(cell, "previewBase64")?)?))),
        _ => Err(AppError::new("driver-contract", "驱动返回了不支持的单元格类型")),
    }
}
fn blob_hex(encoded: &str) -> Result<String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if encoded.len() % 4 != 0 { return Err(invalid("BLOB 编码无效")) }
    let mut output = String::with_capacity(encoded.len() * 2);
    for (index, chunk) in encoded.as_bytes().chunks(4).enumerate() {
        let mut bits = 0u32;
        let mut padding = 0;
        for (i, byte) in chunk.iter().enumerate() {
            if *byte == b'=' {
                if i < 2 { return Err(invalid("BLOB 编码无效")) }
                padding += 1;
            } else {
                if padding != 0 { return Err(invalid("BLOB 编码无效")) }
                bits |= (ALPHABET.iter().position(|v| v == byte).ok_or_else(|| invalid("BLOB 编码无效"))? as u32) << (18 - i * 6);
            }
        }
        if padding > 0 && index + 1 != encoded.len() / 4 { return Err(invalid("BLOB 编码无效")) }
        for i in 0..(3-padding) { output.push_str(&format!("{:02X}", (bits >> (16 - i * 8)) & 255)); }
    }
    Ok(output)
}
fn cell_sql(cell: &Value, dialect: &str) -> Result<String> {
    let value = cell_json(cell)?;
    if value.is_null() { return Ok("NULL".into()) }
    if cell["kind"] == "blob" {
        let hex = value.as_str().unwrap().trim_start_matches("0x");
        return Ok(if dialect == "postgresql" { format!("E'\\\\x{hex}'") } else { format!("X'{hex}'") });
    }
    if let Some(boolean) = value.as_bool() { return Ok(if dialect == "postgresql" { if boolean { "TRUE" } else { "FALSE" } } else if boolean { "1" } else { "0" }.into()) }
    if value.is_number() { return Ok(value.to_string()) }
    let text = value.as_str().unwrap();
    if text.contains('\0') { return Err(invalid("SQL INSERT 文本含 NUL，无法安全导出")) }
    let escaped = if dialect == "postgresql" || dialect == "mysql" { text.replace('\\', "\\\\").replace('\'', "''") } else { text.replace('\'', "''") };
    Ok(format!("{}'{escaped}'", if dialect == "postgresql" { "E" } else { "" }))
}
fn csv_field(text: &str, force: bool) -> String {
    if force || text.contains([',', '"', '\r', '\n']) { format!("\"{}\"", text.replace('"', "\"\"")) } else { text.to_owned() }
}
fn emit(writer: &mut BufWriter<File>, written: &mut u64, value: &str) -> Result<()> {
    writer.write_all(value.as_bytes()).map_err(io_error)?;
    *written += value.len() as u64;
    Ok(())
}
fn start_export(app: &Application, request: &Value) -> Result<Value> {
    let destination = absolute(text(request, "destinationPath")?)?;
    app.validate_export_destination(&destination)?;
    let protected_root = app.base_dir.clone();
    let state = app.state.clone();
    let format = text(request, "format")?.to_owned();
    if !["csv", "json", "jsonl", "sql-insert"].contains(&format.as_str()) { return Err(invalid("不支持的导出格式")) }
    let source = request.get("source").filter(|v| v.is_object()).ok_or_else(|| invalid("缺少导出来源"))?;
    let node = source.get("nodeId").map(|v| v.as_str().ok_or_else(|| invalid("nodeId 必须是字符串"))).transpose()?;
    let parsed = node.map(split_node).transpose()?;
    let explicit = source.get("connectionId").map(|v| v.as_str().ok_or_else(|| invalid("connectionId 必须是字符串"))).transpose()?;
    if let (Some((id, _)), Some(explicit)) = (parsed, explicit) { if id != explicit { return Err(invalid("导出来源的连接归属不一致")) } }
    let connection = parsed.map(|(id, _)| id).or(explicit).ok_or_else(|| invalid("导出来源缺少连接"))?;
    let session = app.capture_session(&format!("connection:{connection}"))?;
    let raw = parsed.and_then(|(_, raw)| raw).map(str::to_owned);
    let sql = source.get("sql").map(|v| v.as_str().filter(|s| !s.trim().is_empty()).map(str::to_owned).ok_or_else(|| invalid("sql 必须是非空字符串"))).transpose()?;
    if sql.is_none() && raw.is_none() { return Err(invalid("导出来源必须是表、视图或 SQL 查询")) }
    if format == "sql-insert" && sql.is_some() { return Err(invalid("查询来源没有明确 INSERT 目标")) }
    let options = request.get("options").cloned().unwrap_or_else(|| json!({}));
    if !options.is_object() { return Err(invalid("导出 options 必须是对象")) }
    let batch_size = bounded(options.get("batchSize"), 200, 1000)?;
    let header = match options.get("includeHeader") { Some(v) => v.as_bool().ok_or_else(|| invalid("includeHeader 必须为布尔值"))?, None => true };
    let null_text = match options.get("nullText") { Some(v) => v.as_str().ok_or_else(|| invalid("nullText 必须为字符串"))?.to_owned(), None => String::new() };
    let newline = options.get("newline").and_then(Value::as_str).unwrap_or("\r\n").to_owned();
    if newline != "\r\n" && newline != "\n" { return Err(invalid("换行符只能为 LF 或 CRLF")) }
    let json_indent = match options.get("jsonIndent") {
        Some(indent) => indent.as_u64().filter(|n| *n <= 8).ok_or_else(|| invalid("JSON 缩进必须为 0 到 8"))? as usize,
        None => 2,
    };
    if format == "csv" && null_text.contains([',', '"', '\r', '\n']) { return Err(invalid("CSV NULL 标记不能包含分隔符、引号或换行")) }
    let progress = json!({"status":"queued","rowsRead":0,"bytesWritten":0,"batches":0,"destinationPath":destination,"consistency":"live-paged"});
    spawn_task(app, Kind::Export, session, progress, move |task, driver| {
        let dialect = driver.dialect_id().to_owned();
        let resolution = if sql.is_none() { driver_call(driver, "resolveTransferSource", vec![json!(raw)])? } else { Value::Null };
        let sql = sql.unwrap_or_else(|| resolution["sql"].as_str().unwrap_or("").to_owned());
        if sql.trim().is_empty() { return Err(AppError::new("driver-contract", "驱动未解析导出来源")) }
        let target = if format == "sql-insert" { Some(insert_target(&resolution["target"], &dialect)?) } else { None };
        with_export_destination_shared(&state, &protected_root, &destination, || { task.check()?; Ok(()) })?;
        let partial = destination.parent().unwrap().join(format!(".dbstudio-{}-export.partial", task.id));
        let mut open = OpenOptions::new(); open.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; open.mode(0o600); }
        let mut writer = BufWriter::new(open.open(&partial).map_err(io_error)?);
        task.update(|p| p["partialPath"] = json!(partial))?;
        let mut cursor: Option<Value> = None;
        let mut written = 0u64;
        let mut rows_read = 0u64;
        let mut batches = 0u64;
        let mut first_row = true;
        let mut column_names: Vec<String> = Vec::new();
        let result = (|| {
            task.check()?;
            let mut page = driver_call(driver, "runQuery", vec![json!(sql),json!({"limit":batch_size,"signalId":task.id})])?;
            cursor = page.get("cursorId").filter(|v| !v.is_null()).cloned();
            let columns = page["columns"].as_array().ok_or_else(|| AppError::new("driver-contract", "导出缺少列元数据"))?;
            column_names = columns.iter().map(|v| text(v,"name").map(str::to_owned)).collect::<Result<_>>()?;
            if column_names.len() > MAX_COLUMNS { return Err(AppError::new("resource-limit", "导出列数过多")) }
            let unique: HashSet<_> = column_names.iter().collect();
            if (format == "json" || format == "jsonl") && header && unique.len() != column_names.len() { return Err(invalid("JSON 对象导出不允许重复列名")) }
            if format == "csv" && header { emit(&mut writer, &mut written, &(column_names.iter().map(|s| csv_field(s,false)).collect::<Vec<_>>().join(",") + &newline))?; }
            if format == "json" { emit(&mut writer, &mut written, "[\n")?; }
            loop {
                task.check()?;
                let page_columns = page["columns"].as_array().ok_or_else(|| AppError::new("driver-contract", "导出页缺少列元数据"))?;
                if page_columns.iter().map(|v| v["name"].as_str()).collect::<Vec<_>>() != column_names.iter().map(|v| Some(v.as_str())).collect::<Vec<_>>() { return Err(AppError::new("source-changed", "导出过程中列结构发生变化")) }
                let rows = page["rows"].as_array().ok_or_else(|| AppError::new("driver-contract", "驱动未返回分页行"))?;
                if rows.len() > batch_size { return Err(AppError::new("driver-contract", "驱动返回的分页超过批大小")) }
                for row in rows {
                    task.check()?;
                    let cells = row["cells"].as_array().ok_or_else(|| AppError::new("driver-contract", "导出行单元格无效"))?;
                    if cells.len() != column_names.len() { return Err(AppError::new("driver-contract", "导出行列数不一致")) }
                    let line = if format == "sql-insert" {
                        format!("INSERT INTO {} ({}) VALUES ({});{}",target.as_ref().unwrap(), column_names.iter().map(|v| quote_identifier(v,&dialect)).collect::<Result<Vec<_>>>()?.join(", "),cells.iter().map(|v| cell_sql(v,&dialect)).collect::<Result<Vec<_>>>()?.join(", "),newline)
                    } else {
                        let values = cells.iter().map(cell_json).collect::<Result<Vec<_>>>()?;
                        if format == "csv" {
                            if values.len() == 1 && values[0].is_null() && null_text.is_empty() { return Err(invalid("单列 NULL 使用空标记会产生空白记录，请指定非空 nullText")) }
                            let fields: Vec<_> = values.iter().map(|value| {
                                if value.is_null() { null_text.clone() } else {
                                    let value = value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string());
                                    csv_field(&value, value.is_empty() || value == null_text)
                                }
                            }).collect();
                            fields.join(",") + &newline
                        } else {
                            let value = if header {
                                Value::Object(column_names.iter().cloned().zip(values).collect())
                            } else { Value::Array(values) };
                            if format == "jsonl" {
                                serde_json::to_string(&value).map_err(|_| AppError::new("serialization", "导出 JSON 编码失败"))? + "\n"
                            } else {
                                use serde::Serialize;
                                let mut buffer = Vec::new();
                                if json_indent == 0 {
                                    value.serialize(&mut serde_json::Serializer::new(&mut buffer)).map_err(|_| AppError::new("serialization", "导出 JSON 编码失败"))?;
                                } else {
                                    let indent = vec![b' '; json_indent];
                                    value.serialize(&mut serde_json::Serializer::with_formatter(&mut buffer, serde_json::ser::PrettyFormatter::with_indent(&indent))).map_err(|_| AppError::new("serialization", "导出 JSON 编码失败"))?;
                                }
                                let encoded = String::from_utf8(buffer).map_err(|_| AppError::new("serialization", "导出 JSON 编码失败"))?;
                                let indent = " ".repeat(json_indent);
                                format!("{}{}{}",if first_row { "" } else { ",\n" },indent,encoded.replace('\n', &format!("\n{indent}")))
                            }
                        }
                    };
                    emit(&mut writer, &mut written, &line)?;
                    first_row = false; rows_read += 1;
                }
                batches += 1;
                // End the writer borrow before publishing real byte counters.
                task.update(|p| { p["rowsRead"] = json!(rows_read); p["bytesWritten"] = json!(written); p["batches"] = json!(batches); })?;
                let more = page["hasMore"].as_bool().ok_or_else(|| AppError::new("driver-contract", "驱动未提供分页终止标记"))?;
                if !more { break }
                if rows.is_empty() { return Err(AppError::new("driver-contract", "分页无进展，已停止导出")) }
                task.check()?;
                page = driver_call(driver, "fetchResultPage",vec![cursor.clone().ok_or_else(|| AppError::new("driver-contract", "导出分页游标缺失"))?,json!(rows_read),json!(batch_size)])?;
            }
            if format == "json" { emit(&mut writer, &mut written, "\n]\n")?; }
            writer.flush().map_err(io_error)?;
            writer.get_ref().sync_all().map_err(io_error)?;
            task.committing()?;
            with_export_destination_shared(&state, &protected_root, &destination, || {
                task.check()?;
                fs::hard_link(&partial, &destination).map_err(io_error)
            })?;
            Ok(json!({"rowsRead":rows_read,"bytesWritten":written,"batches":batches,"committedPath":destination}))
        })();
        if let Some(cursor) = cursor { let _ = driver_call(driver, "closeCursor",vec![cursor]); }
        match result {
            Err(_) if task.cancel.load(Ordering::Acquire) || !task.session.is_active() => Err(cancelled()),
            result => result,
        }
    })
}

#[cfg(test)]
mod cancellation_fixtures {
    use super::*;
    use crate::MemorySecretStore;
    use dbstudio_protocol::{CancelHandle, ConnectionConfig, SecretMap};
    use std::time::Duration;

    #[derive(Default)]
    struct Gate { state: Mutex<(bool, bool)>, changed: Condvar }
    impl Gate {
        fn pause(&self) {
            let mut state = self.state.lock().unwrap();
            state.0 = true; self.changed.notify_all();
            while !state.1 { state = self.changed.wait(state).unwrap(); }
        }
        fn reached(&self) {
            let state = self.state.lock().unwrap();
            let (state, timeout) = self.changed.wait_timeout_while(state, Duration::from_secs(10), |s| !s.0).unwrap();
            assert!(!timeout.timed_out() && state.0, "native worker did not reach the batch gate");
        }
        fn release(&self) { self.state.lock().unwrap().1 = true; self.changed.notify_all(); }
    }
    struct GatedNative { inner: Box<dyn Driver>, gate: Arc<Gate>, import: bool }
    impl Driver for GatedNative {
        fn dialect_id(&self) -> &str { self.inner.dialect_id() }
        fn capabilities(&self) -> Value { self.inner.capabilities() }
        fn cancel_handle(&self) -> CancelHandle { self.inner.cancel_handle() }
        fn disconnect(&mut self) -> Result<()> { self.inner.disconnect() }
        fn call(&mut self, method: &str, args: Vec<Value>) -> Result<Value> {
            if (self.import && method == "importBatch" && args.get(1).map(|v| v["batchIndex"] == 1).unwrap_or(false)) ||
                (!self.import && method == "fetchResultPage") { self.gate.pause(); }
            self.inner.call(method,args)
        }
    }
    fn fixture(import: bool) -> (Application, PathBuf, String, Arc<Gate>) {
        let dir = std::env::temp_dir().join(format!("dbstudio-native-cancel-{}",Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let database = dir.join("fixture.sqlite");
        File::options().write(true).create_new(true).open(&database).unwrap();
        let gate = Arc::new(Gate::default());
        let worker_gate = gate.clone();
        let factory = Arc::new(move |config: &ConnectionConfig, secrets: &SecretMap| -> Result<Box<dyn Driver>> {
            Ok(Box::new(GatedNative { inner:dbstudio_drivers::connect(config,secrets)?,gate:worker_gate.clone(),import }))
        });
        let app = Application::open_with_factory(dir.join("state"),Arc::new(MemorySecretStore::default()),factory).unwrap();
        let summary = app.call("addConnection",vec![json!({"dialectId":"sqlite","name":"cancel-fixture","options":{"file":database}})]).unwrap();
        let node = format!("connection:{}",summary["id"].as_str().unwrap());
        app.call("executeStatement",vec![json!(node),json!("CREATE TABLE items (name TEXT NOT NULL)")]).unwrap();
        (app,dir,node,gate)
    }
    #[test]
    fn cancellation_after_first_native_import_batch_rolls_back_and_does_not_block_on_driver_lock() {
        let (app,dir,node,gate) = fixture(true);
        app.call("executeStatement",vec![json!(node),json!("INSERT INTO items VALUES ('untouched')")]).unwrap();
        app.call("commitTransaction",vec![json!(node)]).unwrap();
        let source = dir.join("input.csv");
        File::options().write(true).create_new(true).open(&source).unwrap().write_all(b"name\na\nb\nc\nd\n").unwrap();
        let task = app.call("startImport",vec![json!({"targetNodeId":format!("{node}|table:items"),"sourcePath":source,
            "delimiter":",","nullText":"","hasHeader":true,"targetColumns":["name"],"batchSize":2})]).unwrap();
        gate.reached();
        let progress = app.call("getImportProgress",vec![task["taskId"].clone()]).unwrap();
        let cancellation = app.call("cancelImport",vec![task["taskId"].clone()]);
        gate.release();
        assert_eq!(progress["rowsImported"],2);
        assert_eq!(cancellation.unwrap(),true);
        let result = app.call("waitImport",vec![task["taskId"].clone()]).unwrap();
        assert_eq!(result["status"],"cancelled");
        assert_eq!(result["rowsImported"],0);
        let rows = app.call("runQuery",vec![json!(node),json!("SELECT name FROM items"),json!({"keepCursor":false})]).unwrap();
        assert_eq!(rows["rows"].as_array().unwrap().len(),1);
        assert_eq!(rows["rows"][0]["cells"][0]["text"],"untouched");
        app.close().unwrap();
    }
    #[test]
    fn export_cancellation_after_first_page_does_not_publish_partial_file() {
        let (app,dir,node,gate) = fixture(false);
        app.call("executeStatement",vec![json!(node),json!("INSERT INTO items VALUES ('a'),('b'),('c')")]).unwrap();
        app.call("commitTransaction",vec![json!(node)]).unwrap();
        let destination = dir.join("export.csv");
        let task = app.call("startTransfer",vec![json!({"source":{"nodeId":format!("{node}|table:items")},"format":"csv","destinationPath":destination,"options":{"batchSize":1}})]).unwrap();
        gate.reached();
        let progress = app.call("getTransferProgress",vec![task["taskId"].clone()]).unwrap();
        let cancellation = app.call("cancelTransfer",vec![task["taskId"].clone()]);
        gate.release();
        assert_eq!(progress["rowsRead"],1);
        assert_eq!(cancellation.unwrap(),true);
        let result = app.call("waitTransfer",vec![task["taskId"].clone()]).unwrap();
        assert_eq!(result["status"],"cancelled");
        assert!(!destination.exists());
        assert!(Path::new(result["partialPath"].as_str().unwrap()).is_file());
        app.close().unwrap();
    }
    #[test]
    fn export_revalidates_live_connections_and_rejects_a_sidecar_added_during_export() {
        let (app,dir,node,gate) = fixture(false);
        app.call("executeStatement",vec![json!(node),json!("INSERT INTO items VALUES ('a'),('b')")]).unwrap();
        app.call("commitTransaction",vec![json!(node)]).unwrap();
        let late_database = dir.join("late.sqlite");
        File::options().write(true).create_new(true).open(&late_database).unwrap();
        let destination = dir.join("late.sqlite-wal");
        let task = app.call("startTransfer",vec![json!({"source":{"nodeId":format!("{node}|table:items")},
            "format":"csv","destinationPath":destination,"options":{"batchSize":1}})]).unwrap();
        gate.reached();
        let added = app.call("addConnection",vec![json!({"dialectId":"sqlite","name":"late-fixture","options":{"file":late_database}})]).unwrap();
        assert_eq!(added["connected"],true);
        assert!(!destination.exists());
        gate.release();
        let result = app.call("waitTransfer",vec![task["taskId"].clone()]).unwrap();
        assert_eq!(result["status"],"failed");
        assert_eq!(result["code"],"database-path");
        assert!(!destination.exists());
        assert!(Path::new(result["partialPath"].as_str().unwrap()).is_file());
        app.close().unwrap();
    }
    #[test]
    fn close_between_capture_and_registration_rejects_new_task_without_spawning_worker() {
        let (app,_dir,node,_driver_gate) = fixture(false);
        let app = Arc::new(app);
        let gate = Arc::new(Gate::default());
        let ran = Arc::new(AtomicBool::new(false));
        let worker_app = app.clone();
        let worker_gate = gate.clone();
        let worker_ran = ran.clone();
        let attempt = thread::spawn(move || {
            let session = worker_app.capture_session(&node)?;
            worker_gate.pause();
            spawn_task(&worker_app,Kind::Export,session,json!({"status":"queued"}),move |_,_| {
                worker_ran.store(true,Ordering::Release);
                Ok(Value::Null)
            })
        });
        gate.reached();
        let closed = app.close();
        gate.release();
        closed.unwrap();
        let result = attempt.join().unwrap();
        assert_eq!(result.unwrap_err().code,"backend-unavailable");
        assert!(!ran.load(Ordering::Acquire));
        assert!(app.tasks.tasks.lock().unwrap().is_empty());
    }
}
