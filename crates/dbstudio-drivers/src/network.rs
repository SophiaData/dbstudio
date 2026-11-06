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
    if !full && length>1000 { json!({"kind":"text","text":text.chars().take(1000).collect::<String>(),"truncated":true,"fullLength":length}) }
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

pub fn qualified_name(name:&str,mysql:bool)->DriverResult<String>{
    let parts=unescape_parts(name)?;
    if parts.len()>2||parts.iter().any(|p|p.contains('\0')){return Err(DriverError::invalid("对象名称无效"));}
    Ok(parts.iter().map(|p|quote(p,mysql)).collect::<Vec<_>>().join("."))
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
