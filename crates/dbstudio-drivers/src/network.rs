//! Native driver shared input/JSON helpers. No shell or Node forwarding.
use base64::{engine::general_purpose::STANDARD, Engine};
use dbstudio_protocol::{ConnectionConfig, DriverError, DriverResult};
use serde_json::{json, Value};
use std::time::Duration;

pub fn option(config: &ConnectionConfig, key: &str, fallback: &str) -> String {
    config.options.get(key).and_then(|v| match v {
        Value::String(s) => Some(s.clone()), Value::Number(n) => Some(n.to_string()), _ => None
    }).unwrap_or_else(|| fallback.into())
}
pub fn port(config: &ConnectionConfig, key: &str, fallback: u16) -> DriverResult<u16> {
    let value = option(config, key, &fallback.to_string()).parse::<u16>()
        .map_err(|_| DriverError::invalid("端口必须是1到65535的整数"))?;
    if value == 0 { return Err(DriverError::invalid("端口必须是1到65535的整数")); }
    Ok(value)
}
pub fn timeout() -> Duration { Duration::from_secs(10) }
pub fn escape_id(value: &str) -> String { value.replace('\\', "\\\\").replace('.', "\\.") }
pub fn unescape_parts(value: &str) -> DriverResult<Vec<String>> {
    let mut parts = vec![String::new()]; let mut escaped = false;
    for c in value.chars() {
        if escaped { parts.last_mut().unwrap().push(c); escaped = false; }
        else if c == '\\' { escaped = true; }
        else if c == '.' { parts.push(String::new()); }
        else { parts.last_mut().unwrap().push(c); }
    }
    if escaped || parts.iter().any(String::is_empty) { return Err(DriverError::invalid("对象ID无效")); }
    Ok(parts)
}
pub fn table_id(value: &str) -> DriverResult<(String, String)> {
    let raw = value.strip_prefix("table:").or_else(|| value.strip_prefix("view:"))
        .ok_or_else(|| DriverError::invalid("需要表或视图ID"))?;
    let parts = unescape_parts(raw)?;
    if parts.len()!=2 { return Err(DriverError::invalid("对象ID无效")); }
    Ok((parts[0].clone(), parts[1].clone()))
}
/// 生成 MySQL 字符串字面量：单引号包裹，并转义反斜杠与单引号。
///
/// 反斜杠必须先转义：MySQL 默认 sql_mode 下它是转义符，
/// 否则 `a\b` 会被解释成退格，尾部反斜杠还会吞掉闭引号。
pub fn string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

pub fn quote(value: &str, mysql: bool) -> String {
    let q = if mysql { '`' } else { '"' };
    format!("{q}{}{q}", value.replace(q, &format!("{q}{q}")))
}
pub fn qualified(id: &str, mysql: bool) -> DriverResult<String> {
    let (schema, name) = table_id(id)?; Ok(format!("{}.{}", quote(&schema,mysql), quote(&name,mysql)))
}
pub fn node(id: String, kind: &str, name: &str, parent: Option<&str>, children: bool) -> Value {
    json!({"id":id,"kind":kind,"name":name,"parentId":parent,"hasChildren":children})
}
pub fn text_cell(text: &str, full: bool) -> Value {
    let length=text.encode_utf16().count();
    if !full && length>1000 {
        let mut units = 0;
        let preview: String = text.chars().take_while(|character| {
            units += character.len_utf16();
            units <= 1000
        }).collect();
        json!({"kind":"text","text":preview,"truncated":true,"fullLength":length})
    }
    else { json!({"kind":"text","text":text}) }
}
pub fn blob_cell(bytes: &[u8], full: bool) -> Value {
    let size=if full {bytes.len()} else {bytes.len().min(256)};
    json!({"kind":"blob","previewBase64":STANDARD.encode(&bytes[..size]),"length":bytes.len(),"truncated":size<bytes.len()})
}
pub fn cell_param(cell: &Value) -> DriverResult<Value> {
    if cell.get("truncated").and_then(Value::as_bool)==Some(true) { return Err(DriverError::invalid("不能写回截断值")); }
    match cell.get("kind").and_then(Value::as_str) {
        Some("null")=>Ok(Value::Null),
        Some("text")=>cell.get("text").filter(|v|v.is_string()).cloned().ok_or_else(||DriverError::invalid("文本值无效")),
        Some("number")=>cell.get("value").filter(|v|v.is_number()).cloned().ok_or_else(||DriverError::invalid("数值无效")),
        Some("boolean")=>cell.get("value").filter(|v|v.is_boolean()).cloned().ok_or_else(||DriverError::invalid("布尔值无效")),
        Some("blob")=>{ let s=cell.get("previewBase64").and_then(Value::as_str).ok_or_else(||DriverError::invalid("二进制值无效"))?; let bytes=STANDARD.decode(s).map_err(|_|DriverError::invalid("二进制值无效"))?; Ok(json!({"$binary":STANDARD.encode(bytes)})) },
        _=>Err(DriverError::invalid("单元格值无效"))
    }
}
pub fn page_options(options: &Value) -> (usize, usize) {
    (options.get("offset").and_then(Value::as_u64).unwrap_or(0).min(1_000_000_000) as usize,
     options.get("limit").and_then(Value::as_u64).unwrap_or(200).clamp(1,1000) as usize)
}

/// Bind PostgreSQL $N / MySQL ? parameters without touching literals or comments.
/// Multiple statements and unterminated lexical constructs are rejected before dispatch.
pub fn bind_named(sql: &str, options: &Value, pg: bool) -> DriverResult<(String, Vec<Value>)> {
    let mut supplied=std::collections::BTreeMap::new();
    if let Some(params)=options.get("parameters") {
        for param in params.as_array().ok_or_else(||DriverError::invalid("parameters必须是数组"))? {
            let name=param.get("name").and_then(Value::as_str).ok_or_else(||DriverError::invalid("参数名无效"))?;
            if name.trim().is_empty(){return Err(DriverError::invalid("参数名无效"));}
            let mut value=param.get("value").cloned().ok_or_else(||DriverError::invalid("缺少参数值"))?;
            if let Some(bytes)=value.get("data").and_then(Value::as_array).filter(|_|value.get("type").and_then(Value::as_str)==Some("dbstudio-sql-bytes")){
                let bytes:Vec<u8>=bytes.iter().map(|v|v.as_u64().filter(|n|*n<=255).map(|n|n as u8).ok_or_else(||DriverError::invalid("二进制参数无效"))).collect::<DriverResult<_>>()?;value=json!({"$binary":STANDARD.encode(bytes)});
            }
            if !value.is_null()&&!value.is_string()&&!value.is_boolean()&&!value.is_number()&&value.get("$binary").and_then(Value::as_str).is_none(){return Err(DriverError::invalid("SQL参数类型无效"));}
            if supplied.insert(name.trim().to_string(),value).is_some(){return Err(DriverError::invalid("参数名重复"));}
        }
    }
    let chars:Vec<char>=sql.chars().collect(); let mut i=0; let mut out=String::new(); let mut values=vec![]; let mut used=std::collections::BTreeSet::new();
    let mut ended=false;let mut anonymous=0;let mut max_pg=0;
    while i<chars.len() {
        let c=chars[i];
        if c.is_whitespace() {out.push(c);i+=1;continue;}
        if (c=='-'&&chars.get(i+1)==Some(&'-')&&(pg||chars.get(i+2).is_some_and(|c|c.is_whitespace()||c.is_control())))||(!pg&&c=='#') {while i<chars.len()&&chars[i]!='\n'{i+=1;}out.push('\n');continue;}
        if c=='/'&&chars.get(i+1)==Some(&'*') {
            if !pg&&chars.get(i+2)==Some(&'!'){return Err(DriverError::unsupported("暂不支持MySQL可执行版本注释"));}
            let mut depth=1;i+=2;
            while i<chars.len()&&depth>0 {if chars[i]=='/'&&chars.get(i+1)==Some(&'*'){depth+=1;i+=2;}else if chars[i]=='*'&&chars.get(i+1)==Some(&'/'){depth-=1;i+=2;}else {i+=1;}}
            if depth!=0{return Err(DriverError::invalid("SQL注释未闭合"));}out.push(' ');continue;
        }
        if ended {return Err(DriverError::unsupported("一次只能执行一条SQL语句"));}
        if c==';' {ended=true;i+=1;continue;}
        if c=='\''||c=='"'||c=='`' {
            let q=c;let backslash=!pg||(q=='\''&&i>0&&matches!(chars[i-1],'e'|'E')&&(i<2||!chars[i-2].is_ascii_alphanumeric()));out.push(c);i+=1;let mut closed=false;
            while i<chars.len(){let x=chars[i];out.push(x);i+=1;if x==q {if chars.get(i)==Some(&q){out.push(q);i+=1;}else{closed=true;break;}}else if x=='\\'&&backslash&&i<chars.len(){out.push(chars[i]);i+=1;}}
            if !closed{return Err(DriverError::invalid("SQL引号未闭合"));}continue;
        }
        if pg&&c=='$'&&chars.get(i+1).is_some_and(char::is_ascii_digit){
            let start=i;i+=1;while i<chars.len()&&chars[i].is_ascii_digit(){i+=1;}
            let name:String=chars[start..i].iter().collect();let position=name[1..].parse::<usize>().map_err(|_|DriverError::invalid("PG参数位置无效"))?;
            if position==0||position>65535||name.as_bytes()[1]==b'0'{return Err(DriverError::invalid("PG参数位置无效"));}
            if !supplied.contains_key(&name){return Err(DriverError::invalid("缺少SQL绑定参数"));}used.insert(name.clone());max_pg=max_pg.max(position);out.push_str(&name);continue;
        }
        if !pg&&c=='?' {
            anonymous+=1;let name=format!("?{anonymous}");let value=supplied.get(&name).ok_or_else(||DriverError::invalid("缺少SQL绑定参数"))?;values.push(value.clone());used.insert(name);out.push('?');i+=1;continue;
        }
        if pg&&c=='$' {
            let start=i;let mut end=i+1;
            while end<chars.len()&&(chars[end].is_ascii_alphanumeric()||chars[end]=='_'){end+=1;}
            if chars.get(end)==Some(&'$') {
                let tag:Vec<char>=chars[start..=end].to_vec();i=end+1;out.extend(tag.iter());let mut closed=false;
                while i<chars.len(){if chars[i..].starts_with(&tag){out.extend(tag.iter());i+=tag.len();closed=true;break;}out.push(chars[i]);i+=1;}
                if !closed{return Err(DriverError::invalid("SQL dollar引号未闭合"));}continue;
            }
        }
        if c==':'&&chars.get(i+1)==Some(&':'){out.push_str("::");i+=2;continue;}
        if c==':'&&chars.get(i+1).is_some_and(|x|x.is_ascii_alphabetic()||*x=='_') {
            return Err(DriverError::unsupported("PG只支持$N占位符；MySQL只支持?占位符"));
        }
        out.push(c);i+=1;
    }
    if supplied.keys().any(|k|!used.contains(k)){return Err(DriverError::invalid("存在多余SQL绑定参数"));}
    if pg{for position in 1..=max_pg{values.push(supplied.get(&format!("${position}")).ok_or_else(||DriverError::invalid("PG参数位置不能有空缺"))?.clone());}}
    if out.trim().is_empty(){return Err(DriverError::invalid("SQL不能为空"));}
    Ok((out.trim().to_string(),values))
}
pub fn transaction_state(active: bool, affected: u64) -> Value { json!({"active":active,"pendingAffected":affected}) }

pub struct ImportPlan {
    pub batch_index:u64,
    pub columns:Vec<String>,
    pub rows:Vec<(u64,Vec<Value>)>,
}
/// Validate an entire batch before opening a transaction or writing its first row.
pub fn import_plan(batch:&Value,description:&Value)->DriverResult<ImportPlan>{
    let batch_index=batch.get("batchIndex").and_then(Value::as_u64).ok_or_else(||DriverError::invalid("导入批次序号无效"))?;
    let requested=batch.get("columns").and_then(Value::as_array).filter(|v|!v.is_empty()).ok_or_else(||DriverError::invalid("导入批次缺少目标列"))?;
    let available=description.get("columns").and_then(Value::as_array).ok_or_else(||DriverError::invalid("目标列元数据无效"))?;
    let mut columns=vec![];let mut metadata=vec![];let mut seen=std::collections::BTreeSet::new();
    for column in requested{
        let name=column.as_str().ok_or_else(||DriverError::invalid("导入列名无效"))?;
        let exact=available.iter().find(|c|c["name"].as_str()==Some(name));
        let fallback:Vec<_>=available.iter().filter(|c|c["name"].as_str().is_some_and(|s|s.eq_ignore_ascii_case(name))).collect();
        let col=exact.or_else(||if fallback.len()==1{Some(fallback[0])}else{None}).ok_or_else(||DriverError::invalid("导入目标列不存在或大小写有歧义"))?;
        let canonical=col["name"].as_str().ok_or_else(||DriverError::invalid("目标列元数据无效"))?;
        if !seen.insert(canonical.to_string()){return Err(DriverError::invalid("导入目标列重复"));}
        if col["generated"].is_string()||col["hidden"].as_bool()==Some(true)||col["identity"].as_str()==Some("always")||col["identityGeneration"].as_str()==Some("always"){return Err(DriverError::invalid("不能映射生成列或ALWAYS身份列"));}
        columns.push(canonical.to_string());metadata.push(col);
    }
    for col in available{if col["requiredOnInsert"].as_bool()==Some(true)&&!seen.contains(col["name"].as_str().unwrap_or("")){return Err(DriverError::invalid("导入缺少必须提供的目标列"));}}
    let raw_rows=batch.get("rows").and_then(Value::as_array).filter(|rows|!rows.is_empty()&&rows.len()<=10_000).ok_or_else(||DriverError::invalid("导入批次行数必须是1到10000"))?;
    let mut rows=vec![];
    for(index,row)in raw_rows.iter().enumerate(){
        let row_number=row.get("rowNumber").and_then(Value::as_u64).filter(|n|*n>0).ok_or_else(||DriverError::invalid("CSV数据行号无效"))?;
        let values=row.get("values").and_then(Value::as_array).filter(|v|v.len()==columns.len()).ok_or_else(||DriverError::invalid(format!("导入批次第{}行与目标列数不匹配",index+1)))?;
        let mut params=vec![];for(column,value)in values.iter().enumerate(){let value=cell_param(value).map_err(|_|DriverError::invalid(format!("CSV第{row_number}行第{}列值无效",column+1)))?;
            if value.is_null()&&metadata[column]["nullable"].as_bool()==Some(false){return Err(DriverError::invalid(format!("CSV第{row_number}行第{}列不能为NULL",column+1)));}params.push(value);
        }rows.push((row_number,params));
    }
    Ok(ImportPlan{batch_index,columns,rows})
}
pub fn transfer_source(id:&str,mysql:bool)->DriverResult<Value>{
    let(schema,name)=table_id(id)?;
    Ok(json!({"sql":format!("SELECT * FROM {}",qualified(id,mysql)?),"target":{"schema":schema,"name":name,"table":name,"kind":if id.starts_with("view:"){"view"}else{"table"}}}))
}

/// ç´¢å¼åç½ååæ ¡éªï¼ç´¢å¼åä¼åæ ·è¿å¥ DDL è¯­å¥ææ¬ã
fn index_name(raw: &str) -> DriverResult<String> {
    let name = raw.trim();
    if name.is_empty() || name.len() > 64 { return Err(DriverError::invalid("ç´¢å¼åæ æ")); }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
        return Err(DriverError::invalid("ç´¢å¼ååªæ¥åå­æ¯ãæ°å­ãä¸åçº¿ä¸ $ "));
    }
    Ok(name.to_owned())
}

/// ç±åååè¡¨çæ (col1, col2) å½¢å¼çç´¢å¼åæ®µï¼ååèµ°ç½ååæ ¡éªã
fn index_columns(spec: &Value) -> DriverResult<String> {
    let items = spec.get("columns").and_then(Value::as_array).ok_or_else(|| DriverError::invalid("ç¼ºå°ç´¢å¼å"))?;
    if items.is_empty() || items.len() > 16 { return Err(DriverError::invalid("ç´¢å¼åæ°éè¶é")); }
    let mut rendered = Vec::with_capacity(items.len());
    for item in items {
        let name = item.as_str().ok_or_else(|| DriverError::invalid("ç´¢å¼ååå¿é¡»æ¯å­ç¬¦ä¸²"))?;
        let name = name.trim();
        if name.is_empty() || name.len() > 64 || name.contains('`') || name.contains('\0') {
            return Err(DriverError::invalid("ç´¢å¼ååæ æ"));
        }
        rendered.push(format!("`{name}`"));
    }
    Ok(rendered.join(", "))
}

/// MySQL ç´¢å¼ç®¡çï¼æ°å¢ãå é¤ä¸ä¿®æ¹æ¢æç´¢å¼ã
///
/// ä¿®æ¹èµ°åæ¡ ALTER TABLEä¸ç DROP+ADDï¼ä¸­éä¸ä¼åºç°âæ§ç´¢å¼å·²å ãæ°ç´¢å¼æ²¡å»ºâççªå£ã
pub fn index_ddl(id: &str, spec: &Value) -> DriverResult<String> {
    let table = qualified(id, true)?;
    match spec.get("action").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("ç¼ºå°ç´¢å¼æä½"))? {
        "add" => {
            let name = index_name(spec.get("name").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("ç¼ºå°ç´¢å¼å"))?)?;
            let columns = index_columns(spec)?;
            let unique = if spec.get("unique").and_then(Value::as_bool).unwrap_or(false) { "UNIQUE " } else { "" };
            Ok(format!("ALTER TABLE {table} ADD {unique}INDEX `{name}` ({columns})"))
        }
        "drop" => {
            let name = index_name(spec.get("name").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("ç¼ºå°ç´¢å¼å"))?)?;
            Ok(format!("ALTER TABLE {table} DROP INDEX `{name}`"))
        }
        "replace" => {
            let old_name = index_name(spec.get("name").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("ç¼ºå°åç´¢å¼å"))?)?;
            let new_name = index_name(spec.get("newName").and_then(Value::as_str).unwrap_or(&old_name))?;
            let columns = index_columns(spec)?;
            let unique = if spec.get("unique").and_then(Value::as_bool).unwrap_or(false) { "UNIQUE " } else { "" };
            Ok(format!("ALTER TABLE {table} DROP INDEX `{old_name}`, ADD {unique}INDEX `{new_name}` ({columns})"))
        }
        _ => Err(DriverError::unsupported("ä¸æ¯æçç´¢å¼æä½")),
    }
}
/// åºåç½ååæ ¡éªï¼åºåä¼åæ ·è¿å¥ CREATE DATABASE è¯­å¥ã
/// MySQL åºååè®¸ `$` ä¸ä¸åçº¿ï¼ä¸åè®¸åå¼å·ãåéç¬¦ä¸ç©ºå­ã
/// 账号名白名单：会原样进入 CREATE USER / GRANT 语句。
pub fn account_name(raw: &str) -> DriverResult<String> {
    let name = raw.trim();
    if name.is_empty() || name.len() > 32 { return Err(DriverError::invalid("账号名无效")); }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') {
        return Err(DriverError::invalid("账号名只接受字母、数字、下划线、短横线与点"));
    }
    Ok(name.to_owned())
}

/// 主机白名单：支持 % 通配符与常见主机字符，拒绝引号与空格。
pub fn account_host(raw: &str) -> DriverResult<String> {
    let host = raw.trim();
    if host.is_empty() || host.len() > 255 { return Err(DriverError::invalid("主机无效")); }
    if !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' || c == '%' || c == ':') {
        return Err(DriverError::invalid("主机只接受字母、数字、点、下划线、短横线、冒号与 % "));
    }
    Ok(host.to_owned())
}

/// 权限清单白名单：只接受固定枚举，避免权限位成为注入入口。
pub fn privilege_list(spec: &Value) -> DriverResult<String> {
    const ALLOWED: &[&str] = &[
        "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX",
        "REFERENCES", "CREATE VIEW", "SHOW VIEW", "CREATE ROUTINE", "ALTER ROUTINE",
        "EXECUTE", "EVENT", "TRIGGER", "CREATE TEMPORARY TABLES", "LOCK TABLES",
        "CREATE USER", "PROCESS", "RELOAD", "REPLICATION CLIENT", "REPLICATION SLAVE",
        "SHOW DATABASES", "ALL PRIVILEGES",
    ];
    let items = spec.as_array().ok_or_else(|| DriverError::invalid("权限必须是数组"))?;
    if items.is_empty() { return Err(DriverError::invalid("权限不能为空")); }
    let mut rendered = Vec::with_capacity(items.len());
    for item in items {
        let name = item.as_str().ok_or_else(|| DriverError::invalid("权限名必须是字符串"))?;
        let upper = name.trim().to_ascii_uppercase();
        if !ALLOWED.contains(&upper.as_str()) {
            return Err(DriverError::invalid(format!("不支持的权限：{name}")));
        }
        rendered.push(upper);
    }
    Ok(rendered.join(", "))
}

/// 授权范围：*.* / db.* / db.table 三种形态，逐段白名单校验。
pub fn privilege_target(spec: &Value) -> DriverResult<String> {
    let kind = spec.get("kind").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("缺少授权范围"))?;
    match kind {
        "global" => Ok("*.*".to_owned()),
        "database" => {
            let db = spec.get("database").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("缺少库名"))?;
            Ok(format!("{}.*", quote(&database_name(db)?, true)))
        }
        "table" => {
            let db = spec.get("database").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("缺少库名"))?;
            let table = spec.get("table").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("缺少表名"))?;
            if table.is_empty() || table.len() > 64 || table.contains('`') { return Err(DriverError::invalid("表名无效")); }
            Ok(format!("{}.{}", quote(&database_name(db)?, true), quote(table, true)))
        }
        _ => Err(DriverError::invalid("不支持的授权范围")),
    }
}
pub fn database_name(raw: &str) -> DriverResult<String> {
    let name = raw.trim();
    if name.is_empty() || name.len() > 64 { return Err(DriverError::invalid("åºåæ æ")); }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
        return Err(DriverError::invalid("åºååªæ¥åå­æ¯ãæ°å­ãä¸åçº¿ä¸ $ "));
    }
    Ok(name.to_owned())
}
pub fn qualified_name(name:&str,mysql:bool)->DriverResult<String>{
    let parts=unescape_parts(name)?;
    if parts.len()>2||parts.iter().any(|p|p.contains('\0')){return Err(DriverError::invalid("对象名称无效"));}
    Ok(parts.iter().map(|p|quote(p,mysql)).collect::<Vec<_>>().join("."))
}
/// 分区 DDL 的名称与边界校验。
///
/// 分区名会原样进入 ALTER TABLE 的语句文本，边界值允许 MAXVALUE 与整数/引号字面量，
/// 因此这里对两者都做白名单校验，绝不让调用方拼接任意 SQL 片段。
fn partition_name(raw: &str) -> DriverResult<String> {
    let name = raw.trim();
    let valid = !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        && !name.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(true);
    if !valid { return Err(DriverError::invalid("分区名无效")); }
    Ok(name.to_owned())
}

fn partition_bound(raw: &str) -> DriverResult<String> {
    let bound = raw.trim();
    let upper = bound.to_ascii_uppercase();
    if upper == "MAXVALUE" { return Ok(upper); }
    let numeric = !bound.is_empty()
        && bound.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '.')
        && bound.chars().filter(|c| *c == '.').count() <= 1
        && bound.chars().next().map(|c| c.is_ascii_digit() || c == '-').unwrap_or(false);
    if numeric { return Ok(bound.to_owned()); }
    let quoted = bound.len() >= 2
        && bound.starts_with('\'')
        && bound.ends_with('\'')
        && !bound[1..bound.len() - 1].contains('\'');
    if quoted { return Ok(bound.to_owned()); }
    Err(DriverError::invalid("分区边界只接受 MAXVALUE、数字或单引号字符串"))
}

/// 由表 ID 与规格生成一条 ALTER TABLE 分区语句。
///
/// 支持 add（RANGE 追加分区）、drop（删除分区）与 reorganize（把一个分区按新的边界拆开）；
/// 其它请求一律拒绝，不做猜测性翻译。
pub fn partition_ddl(id: &str, spec: &Value) -> DriverResult<String> {
    let table = qualified(id, true)?;
    let action = spec.get("action").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("缺少分区操作"))?;
    match action {
        "add" => {
            let name = partition_name(spec.get("name").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("缺少分区名"))?)?;
            let bound = partition_bound(spec.get("lessThan").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("缺少分区边界"))?)?;
            Ok(format!("ALTER TABLE {table} ADD PARTITION (PARTITION {} VALUES LESS THAN ({}))", quote(&name, true), bound))
        }
        "drop" => {
            let name = partition_name(spec.get("name").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("缺少分区名"))?)?;
            Ok(format!("ALTER TABLE {table} DROP PARTITION {}", quote(&name, true)))
        }
        "reorganize" => {
            let source = partition_name(spec.get("name").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("缺少原分区名"))?)?;
            let items = spec.get("into").and_then(Value::as_array).ok_or_else(|| DriverError::invalid("缺少拆分后的分区列表"))?;
            if items.len() < 2 { return Err(DriverError::invalid("拆分至少需要两个分区")); }
            let mut rendered = Vec::with_capacity(items.len());
            for item in items {
                let name = partition_name(item.get("name").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("缺少分区名"))?)?;
                let bound = partition_bound(item.get("lessThan").and_then(Value::as_str).ok_or_else(|| DriverError::invalid("缺少分区边界"))?)?;
                rendered.push(format!("PARTITION {} VALUES LESS THAN ({})", quote(&name, true), bound));
            }
            Ok(format!("ALTER TABLE {table} REORGANIZE PARTITION {} INTO ({})", quote(&source, true), rendered.join(", ")))
        }
        _ => Err(DriverError::unsupported("不支持的分区操作")),
    }
}
fn ddl_type(raw:&str,mysql:bool)->DriverResult<String>{
    let name=raw.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase();
    let pg=["SMALLINT","INTEGER","INT","BIGINT","INT2","INT4","INT8","SERIAL","BIGSERIAL","SMALLSERIAL","REAL","DOUBLE PRECISION","FLOAT4","FLOAT8","NUMERIC","DECIMAL","MONEY","BOOLEAN","BOOL","TEXT","VARCHAR","CHAR","CHARACTER","CHARACTER VARYING","BYTEA","DATE","TIME","TIMETZ","TIMESTAMP","TIMESTAMPTZ","INTERVAL","UUID","JSON","JSONB","XML","INET","CIDR","MACADDR"];
    let my=["TINYINT","SMALLINT","MEDIUMINT","INT","INTEGER","BIGINT","FLOAT","DOUBLE","REAL","DECIMAL","NUMERIC","BOOLEAN","BOOL","TEXT","TINYTEXT","MEDIUMTEXT","LONGTEXT","BLOB","TINYBLOB","MEDIUMBLOB","LONGBLOB","JSON","DATE","TIME","DATETIME","TIMESTAMP","YEAR"];
    if (if mysql{&my[..]}else{&pg[..]}).contains(&name.as_str()){return Ok(name);}
    if let Some((base,tail))=name.split_once('('){
        let base=base.trim();let allowed=if mysql{&["VARCHAR","CHAR","VARBINARY","BINARY","NUMERIC","DECIMAL"][..]}else{&["VARCHAR","CHAR","NUMERIC","DECIMAL"][..]};
        if allowed.contains(&base)&&tail.ends_with(')'){
            let digits=&tail[..tail.len()-1];let values:Result<Vec<u32>,_>=digits.split(',').map(|s|s.trim().parse::<u32>()).collect();
            if let Ok(values)=values{if !values.is_empty()&&values.len()<=2&&values[0]>0&&values[0]<=65535&&(values.len()==1||(["NUMERIC","DECIMAL"].contains(&base)&&values[1]<=values[0])){return Ok(format!("{}({})",base,values.iter().map(u32::to_string).collect::<Vec<_>>().join(",")));}}
        }
    }
    Err(DriverError::unsupported("DDL列类型不在已迁移白名单中"))
}
fn ddl_default(raw:&str)->DriverResult<String>{
    let raw=raw.trim();let upper=raw.to_ascii_uppercase();
    if ["NULL","TRUE","FALSE","CURRENT_DATE","CURRENT_TIME","CURRENT_TIMESTAMP","CURRENT_USER","SESSION_USER","LOCALTIMESTAMP","LOCALTIME"].contains(&upper.as_str()){return Ok(upper);}
    if raw.parse::<f64>().is_ok_and(f64::is_finite)&&!raw.is_empty(){return Ok(raw.into());}
    if raw.starts_with('\'')&&raw.ends_with('\'')&&raw.len()>=2{
        let mut chars=raw[1..raw.len()-1].chars().peekable();let mut valid=true;
        while let Some(c)=chars.next(){if c=='\\'||c=='\0'{valid=false;break;}if c=='\''&&chars.next()!=Some('\''){valid=false;break;}}
        if valid{return Ok(raw.into());}
    }
    Err(DriverError::unsupported("DDL默认值只支持安全字面量或标准时间常量"))
}
pub fn create_table_sql(spec:&Value,mysql:bool)->DriverResult<String>{
    let name=spec.get("name").and_then(Value::as_str).ok_or_else(||DriverError::invalid("缺少表名"))?;
    let columns=spec.get("columns").and_then(Value::as_array).filter(|v|!v.is_empty()).ok_or_else(||DriverError::invalid("表必须有列"))?;
    let mut defs=vec![];let mut keys=vec![];let mut names=std::collections::BTreeSet::new();
    for col in columns{
        let name=col.get("name").and_then(Value::as_str).filter(|s|!s.is_empty()&&!s.contains('\0')).ok_or_else(||DriverError::invalid("列名无效"))?;
        if !names.insert(name){return Err(DriverError::invalid("列名重复"));}
        let ty=ddl_type(col.get("typeName").and_then(Value::as_str).ok_or_else(||DriverError::invalid("缺少列类型"))?,mysql)?;
        let ordinal=col.get("primaryKeyOrdinal").and_then(Value::as_u64).unwrap_or(0);if ordinal>0{keys.push((ordinal,name));}
        let mut def=format!("{} {}",quote(name,mysql),ty);
        if col.get("nullable").and_then(Value::as_bool)==Some(false)||ordinal>0{def.push_str(" NOT NULL");}
        if col.get("autoIncrement").and_then(Value::as_bool)==Some(true){
            if !["INT","INTEGER","SMALLINT","BIGINT","TINYINT","MEDIUMINT"].contains(&ty.as_str()){return Err(DriverError::unsupported("自增只支持整数列"));}
            def.push_str(if mysql{" AUTO_INCREMENT"}else{" GENERATED BY DEFAULT AS IDENTITY"});
        }
        if let Some(default)=col.get("defaultValue").and_then(Value::as_str){def.push_str(" DEFAULT ");def.push_str(&ddl_default(default)?);}
        defs.push(def);
    }
    keys.sort_by_key(|k|k.0);if !keys.is_empty(){for(i,(ordinal,_))in keys.iter().enumerate(){if *ordinal!=(i+1)as u64{return Err(DriverError::invalid("主键序号必须连续且不重复"));}}defs.push(format!("PRIMARY KEY ({})",keys.iter().map(|(_,name)|quote(name,mysql)).collect::<Vec<_>>().join(",")));}
    Ok(format!("CREATE TABLE {} ({})",qualified_name(name,mysql)?,defs.join(", ")))
}
