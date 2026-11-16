//! Native synchronous MySQL/MariaDB driver. No JS/Node forwarding.
use dbstudio_protocol::{CancelHandle,ConnectionConfig,Driver,DriverError,DriverResult,SecretMap,string_argument};
use mysql::{Conn,Opts,OptsBuilder,Params,Row,SslOpts,Value as MValue,prelude::Queryable};
use serde_json::{json,Value};
use base64::{engine::general_purpose::STANDARD,Engine};
use crate::{network as n,tls::{self,TlsMode},tunnel::{self,SshTunnel}};
use std::{collections::HashMap,net::{IpAddr,Ipv4Addr,Ipv6Addr,SocketAddr,ToSocketAddrs},sync::{Arc,atomic::{AtomicBool,Ordering}},time::Instant};

/// CREATE/DROP EVENT 需要库名限定：未带库名时
/// 按当前连接的库补齐，否则真实 MySQL 会以 1044 拒绝。
fn qualify_event_ddl(sql:&str,keyword:&str,object_kind:&str,current_db:&str)->Option<String>{
    let trimmed=sql.trim_start();
    let mut parts=trimmed.splitn(4,char::is_whitespace);
    let first=parts.next()?;let second=parts.next()?;let name=parts.next()?;let tail=parts.next().unwrap_or("");
    if !first.eq_ignore_ascii_case(keyword)||!second.eq_ignore_ascii_case(object_kind){return None;}
    if name.contains('.')||current_db.is_empty(){return None;}
    let bare=name.trim_matches('`');
    if bare.is_empty(){return None;}
    Some(format!("{} {} {}.{} {}",keyword,object_kind,n::quote(current_db,true),n::quote(bare,true),tail).trim_end().to_owned())
}
fn error(error:mysql::Error)->DriverError{
    match error {
        mysql::Error::MySqlError(e)=>{
            if e.code==1317{return DriverError::new("cancelled","MySQL操作已取消");}
            DriverError::new("driver-error",format!("MySQL操作失败(SQLSTATE {}, code {})",e.state,e.code))
        },_=>DriverError::new("connection_failed","MySQL连接或协议操作失败")
    }
}
// InnoDB 1213 (deadlock) rolls back the whole transaction on the server; 1205
// (lock wait timeout) and 1062 (duplicate entry) roll back only the failing
// statement, so a transaction the driver owns remains valid for those codes.
const MYSQL_ER_LOCK_DEADLOCK:u16=1213;
fn error_aborts_transaction(error:&mysql::Error)->bool{
    matches!(error,mysql::Error::MySqlError(e)if e.code==MYSQL_ER_LOCK_DEADLOCK)
}
fn transaction_state_after_error(active:bool,pending:u64,error:&mysql::Error)->(bool,u64){
    if error_aborts_transaction(error){(false,0)}else{(active,pending)}
}
fn retryable_connect_error(error:&mysql::Error)->bool{
    matches!(error,mysql::Error::DriverError(mysql::DriverError::CouldNotConnect(_)|mysql::DriverError::ConnectTimeout))
}
fn family_binds(addresses:impl IntoIterator<Item=SocketAddr>)->Vec<SocketAddr>{
    let mut binds=vec![];
    for address in addresses{
        let bind=SocketAddr::new(if address.is_ipv4(){IpAddr::V4(Ipv4Addr::UNSPECIFIED)}else{IpAddr::V6(Ipv6Addr::UNSPECIFIED)},0);
        if !binds.contains(&bind){binds.push(bind);}
    }
    binds
}
fn connect_options(opts:&Opts)->mysql::Result<Conn>{
    let host_cow=opts.get_ip_or_hostname();let host=host_cow.as_ref();
    let host=host.strip_prefix('[').and_then(|value|value.strip_suffix(']')).unwrap_or(host);
    let addresses=(host,opts.get_tcp_port()).to_socket_addrs()?.collect::<Vec<_>>();
    let mut last_error=None;
    for bind in family_binds(addresses){
        let candidate=OptsBuilder::from_opts(opts.clone()).bind_address(Some(bind));
        match Conn::new(candidate){
            Ok(conn)=>return Ok(conn),
            Err(error)if retryable_connect_error(&error)=>last_error=Some(error),
            Err(error)=>return Err(error)
        }
    }
    match last_error{Some(error)=>Err(error),None=>Conn::new(opts.clone())}
}
fn param(value:&Value)->DriverResult<MValue>{
    Ok(match value {
        Value::Null=>MValue::NULL,Value::Bool(v)=>MValue::Int(i64::from(*v)),
        Value::Number(v)=>if let Some(n)=v.as_i64(){MValue::Int(n)}else if let Some(n)=v.as_u64(){MValue::UInt(n)}else{MValue::Double(v.as_f64().ok_or_else(||DriverError::invalid("数值参数无效"))?)},
        Value::String(v)=>MValue::Bytes(v.as_bytes().to_vec()),
        Value::Object(map)if map.contains_key("$binary")=>MValue::Bytes(STANDARD.decode(map["$binary"].as_str().ok_or_else(||DriverError::invalid("二进制参数无效"))?).map_err(|_|DriverError::invalid("二进制参数无效"))?),
        _=>return Err(DriverError::unsupported("MySQL参数类型尚未迁移"))
    })
}
fn params(values:&[Value])->DriverResult<Params>{Ok(Params::Positional(values.iter().map(param).collect::<DriverResult<Vec<_>>>()?))}
fn is_session_timezone_offset_statement(sql:&str)->bool{
    let body=sql.trim();let body=body.strip_suffix(';').unwrap_or(body).trim_end();
    let Some((left,right))=body.split_once('=')else{return false};
    let words=left.split_whitespace().collect::<Vec<_>>();
    if words.len()!=3||!words[0].eq_ignore_ascii_case("set")||!words[1].eq_ignore_ascii_case("session")||!words[2].eq_ignore_ascii_case("time_zone"){return false;}
    let value=right.trim().as_bytes();
    value.len()==8&&value[0]==b'\''&&matches!(value[1],b'+'|b'-')&&value[2..4].iter().all(u8::is_ascii_digit)&&value[4]==b':'&&value[5..7].iter().all(u8::is_ascii_digit)&&value[7]==b'\''
}
fn cell(value:&MValue,column:&mysql::Column,full:bool)->DriverResult<Value>{
    let number=|v:f64|if v.is_finite(){json!({"kind":"number","value":v})}else{n::text_cell(&v.to_string(),full)};
    Ok(match value {
        MValue::NULL=>json!({"kind":"null"}),
        MValue::Int(v)=>if v.unsigned_abs()>9_007_199_254_740_991{n::text_cell(&v.to_string(),full)}else{json!({"kind":"number","value":v})},
        MValue::UInt(v)=>if *v>9_007_199_254_740_991{n::text_cell(&v.to_string(),full)}else{json!({"kind":"number","value":v})},
        MValue::Float(v)=>number(*v as f64),MValue::Double(v)=>number(*v),
        MValue::Bytes(v)=>if column.character_set()==63&&!matches!(column.column_type(),mysql::consts::ColumnType::MYSQL_TYPE_DECIMAL|mysql::consts::ColumnType::MYSQL_TYPE_NEWDECIMAL|mysql::consts::ColumnType::MYSQL_TYPE_JSON){n::blob_cell(v,full)}else{n::text_cell(std::str::from_utf8(v).map_err(|_|DriverError::unsupported("文本编码不是UTF8"))?,full)},
        MValue::Date(y,m,d,h,min,s,micros)=>if column.column_type()==mysql::consts::ColumnType::MYSQL_TYPE_DATE{
            n::text_cell(&format!("{y:04}-{m:02}-{d:02}"),full)
        }else{n::text_cell(&format!("{y:04}-{m:02}-{d:02} {h:02}:{min:02}:{s:02}.{micros:06}"),full)},
        MValue::Time(neg,days,h,m,s,micros)=>n::text_cell(&format!("{}{:02}:{m:02}:{s:02}.{micros:06}",if *neg{"-"}else{""},(*days as u64)*24+*h as u64),full)
    })
}
const MANAGEMENT_MAX_ROWS:usize=10_000;
const MANAGEMENT_MAX_BYTES:usize=8*1024*1024;
const MANAGEMENT_CONNECTION_BYTES:usize=32*1024*1024;
const MANAGEMENT_MAX_CURSORS:usize=16;
// A query cursor keeps the raw rows of one execution so paging and full-value reads never re-run the
// statement. Beyond either budget the cursor falls back to live re-query and reports stable=false.
const SNAPSHOT_MAX_ROWS:usize=5_000;
const SNAPSHOT_MAX_BYTES:usize=16*1024*1024;
// Budgets cover retained encoded cells/metadata, not allocator RSS or drained wire rows.
struct ManagementSnapshot {columns:Vec<Value>,rows:Vec<Vec<Value>>,bytes:usize}
struct Snapshot{columns:Vec<mysql::Column>,rows:Vec<Vec<MValue>>}
enum Cursor {Query{sql:String,values:Vec<Value>,snapshot:Option<Snapshot>},Management(ManagementSnapshot)}
fn management_limit()->DriverError{DriverError::new("resource-limit","管理结果超过快照保留上限，请缩小范围或关闭已有管理结果")}
fn management_retention(count:usize,retained:usize,additional:usize)->DriverResult<()>{
    if count>=MANAGEMENT_MAX_CURSORS||retained.saturating_add(additional)>MANAGEMENT_CONNECTION_BYTES{return Err(management_limit());}Ok(())
}
fn management_statement(sql:&str)->DriverResult<bool>{
    let mut words=sql.split_whitespace();let first=words.next().unwrap_or("").to_ascii_lowercase();
    let second=words.next().unwrap_or("").to_ascii_lowercase();
    match first.as_str(){
            // SHOW 只放行元数据类只读语句；GRANTS/USERS 等用于用户管理面板。
            "show"=>if second=="tables"||(second=="create"&&words.next().is_some_and(|w|w.eq_ignore_ascii_case("table")))||matches!(second.as_str(),"grants"|"databases"|"status"|"variables"|"processlist"|"events"|"triggers"|"full"){Ok(true)}else{Err(DriverError::unsupported("当前管理查询只支持限定的 SHOW 语句"))},
        "describe"|"desc"=>Ok(true),
        "explain"=>if second=="select"{Ok(true)}else{Err(DriverError::unsupported("当前只支持EXPLAIN SELECT；ANALYZE会执行查询，尚未开放"))},
        "call"=>Err(DriverError::unsupported("CALL及多结果集尚未支持")),
        _=>Ok(false)
    }
}
fn management_columns(columns:&[mysql::Column])->Vec<Value>{
    columns.iter().map(|c|json!({"name":c.name_str(),"type":match c.column_type(){
        mysql::consts::ColumnType::MYSQL_TYPE_TINY|mysql::consts::ColumnType::MYSQL_TYPE_SHORT|mysql::consts::ColumnType::MYSQL_TYPE_LONG|mysql::consts::ColumnType::MYSQL_TYPE_INT24=>"integer",
        mysql::consts::ColumnType::MYSQL_TYPE_FLOAT|mysql::consts::ColumnType::MYSQL_TYPE_DOUBLE=>"real",
        mysql::consts::ColumnType::MYSQL_TYPE_DATE|mysql::consts::ColumnType::MYSQL_TYPE_DATETIME|mysql::consts::ColumnType::MYSQL_TYPE_TIMESTAMP=>"date",
        mysql::consts::ColumnType::MYSQL_TYPE_DECIMAL|mysql::consts::ColumnType::MYSQL_TYPE_NEWDECIMAL|mysql::consts::ColumnType::MYSQL_TYPE_LONGLONG|mysql::consts::ColumnType::MYSQL_TYPE_JSON|mysql::consts::ColumnType::MYSQL_TYPE_TIME=>"text",
        _=>if c.character_set()==63{"blob"}else{"text"}
    }})).collect()
}
fn management_real(bytes:&[u8],float32:bool)->DriverResult<MValue>{
    let text=std::str::from_utf8(bytes).map_err(|_|DriverError::unsupported("管理结果浮点数无效"))?;
    if float32{text.parse::<f32>().map(MValue::Float).map_err(|_|DriverError::unsupported("管理结果浮点数无效"))}
    else{text.parse::<f64>().map(MValue::Double).map_err(|_|DriverError::unsupported("管理结果浮点数无效"))}
}
fn management_cell(value:&MValue,column:&mysql::Column)->DriverResult<Value>{
    // COM_QUERY represents numeric fields as Bytes; COM_STMT_EXECUTE uses typed values.
    if let MValue::Bytes(bytes)=value{
        use mysql::consts::ColumnType::*;
        match column.column_type(){
            MYSQL_TYPE_TINY|MYSQL_TYPE_SHORT|MYSQL_TYPE_LONG|MYSQL_TYPE_INT24|MYSQL_TYPE_LONGLONG=>{
                let text=std::str::from_utf8(bytes).map_err(|_|DriverError::unsupported("管理结果数值编码无效"))?;
                if let Ok(v)=text.parse::<i64>(){return cell(&MValue::Int(v),column,true);}
                let v=text.parse::<u64>().map_err(|_|DriverError::unsupported("管理结果整数无效"))?;return cell(&MValue::UInt(v),column,true);
            },
            MYSQL_TYPE_FLOAT|MYSQL_TYPE_DOUBLE=>return cell(&management_real(bytes,column.column_type()==MYSQL_TYPE_FLOAT)?,column,true),
            _=>{}
        }
    }
    cell(value,column,true)
}
fn management_preview(full:&Value)->DriverResult<Value>{
    match full.get("kind").and_then(Value::as_str){
        Some("text")=>Ok(n::text_cell(full.get("text").and_then(Value::as_str).ok_or_else(||DriverError::invalid("管理快照文本无效"))?,false)),
        Some("blob")=>{let bytes=STANDARD.decode(full.get("previewBase64").and_then(Value::as_str).ok_or_else(||DriverError::invalid("管理快照二进制无效"))?).map_err(|_|DriverError::invalid("管理快照二进制无效"))?;Ok(n::blob_cell(&bytes,false))},
        _=>Ok(full.clone())
    }
}
impl ManagementSnapshot{
    fn new(columns:Vec<Value>)->DriverResult<Self>{
        let bytes=serde_json::to_vec(&columns).map_err(|_|DriverError::invalid("管理结果列无效"))?.len().saturating_add(2);
        if bytes>MANAGEMENT_MAX_BYTES{return Err(management_limit());}Ok(Self{columns,rows:vec![],bytes})
    }
    fn push(&mut self,cells:Vec<Value>)->DriverResult<()>{
        let bytes=self.bytes.saturating_add(serde_json::to_vec(&cells).map_err(|_|DriverError::invalid("管理结果行无效"))?.len()).saturating_add(1);
        if self.rows.len()>=MANAGEMENT_MAX_ROWS||bytes>MANAGEMENT_MAX_BYTES{return Err(management_limit());}
        self.bytes=bytes;self.rows.push(cells);Ok(())
    }
    fn page(&self,offset:usize,limit:usize)->DriverResult<Value>{
        let rows:DriverResult<Vec<Value>>=self.rows.iter().skip(offset).take(limit).enumerate().map(|(i,cells)|{
            let cells:DriverResult<Vec<_>>=cells.iter().map(management_preview).collect();Ok(json!({"index":offset+i,"cells":cells?}))
        }).collect();let rows=rows?;
        Ok(json!({"columns":self.columns,"returned":rows.len(),"rows":rows,"offset":offset,"hasMore":offset.saturating_add(limit)<self.rows.len()}))
    }
    fn full_cell(&self,row:usize,column:usize)->DriverResult<Value>{
        self.rows.get(row).ok_or_else(||DriverError::new("not-found","行不存在"))?.get(column).cloned().ok_or_else(||DriverError::invalid("列下标越界"))
    }
}
fn management_snapshot<T:mysql::prelude::Protocol>(mut stream:mysql::QueryResult<'_, '_, '_,T>)->DriverResult<ManagementSnapshot>{
    let columns=stream.columns().as_ref().to_vec();
    if columns.is_empty(){return Err(DriverError::unsupported("管理查询没有返回列"));}
    let mut snapshot=ManagementSnapshot::new(management_columns(&columns))?;
    {
        let set=stream.iter().ok_or_else(||DriverError::unsupported("管理查询没有结果集"))?;
        for row in set{
            let row=row.map_err(error)?;
            if row.len()!=columns.len(){return Err(DriverError::invalid("管理结果列数发生变化"));}
            let cells:DriverResult<Vec<_>>=(0..row.len()).map(|i|management_cell(row.as_ref(i).unwrap(),&columns[i])).collect();
            snapshot.push(cells?)?;
        }
    }
    if stream.iter().is_some(){return Err(DriverError::unsupported("管理查询多结果集尚未支持"));}
    Ok(snapshot)
}
fn page_columns(columns:&[mysql::Column])->Vec<Value>{
    columns.iter().map(|c|json!({"name":c.name_str(),"type":match c.column_type(){
        mysql::consts::ColumnType::MYSQL_TYPE_TINY|mysql::consts::ColumnType::MYSQL_TYPE_SHORT|mysql::consts::ColumnType::MYSQL_TYPE_LONG|mysql::consts::ColumnType::MYSQL_TYPE_INT24=>"integer",
        mysql::consts::ColumnType::MYSQL_TYPE_FLOAT|mysql::consts::ColumnType::MYSQL_TYPE_DOUBLE=>"real",
        mysql::consts::ColumnType::MYSQL_TYPE_DATE|mysql::consts::ColumnType::MYSQL_TYPE_DATETIME|mysql::consts::ColumnType::MYSQL_TYPE_TIMESTAMP=>"date",
        mysql::consts::ColumnType::MYSQL_TYPE_DECIMAL|mysql::consts::ColumnType::MYSQL_TYPE_NEWDECIMAL|mysql::consts::ColumnType::MYSQL_TYPE_LONGLONG|mysql::consts::ColumnType::MYSQL_TYPE_JSON|mysql::consts::ColumnType::MYSQL_TYPE_TIME=>"text",
        _=>if c.character_set()==63{"blob"}else{"text"}
    }})).collect()
}
/// Raw byte estimate charged by the snapshot budget; NULL and fixed-size scalar values count as constants.
fn value_bytes(value:&MValue)->usize{
    match value{
        MValue::NULL=>0,
        MValue::Int(_)|MValue::UInt(_)|MValue::Float(_)|MValue::Double(_)=>8,
        MValue::Date(..)|MValue::Time(..)=>16,
        MValue::Bytes(bytes)=>bytes.len()
    }
}
fn values_bytes(values:&[MValue])->usize{values.iter().fold(0usize,|total,value|total.saturating_add(value_bytes(value)))}
/// A cursor only attempts the snapshot when the first page fits the row budget; otherwise the page
/// stays on the existing live re-query path. `keepCursor=false` never retains a snapshot.
fn snapshot_page_supported(keep:bool,offset:usize,limit:usize)->bool{
    keep&&offset.saturating_add(limit)<=SNAPSHOT_MAX_ROWS
}
/// Retains one raw row while both budgets allow it. A rejected row releases the retained rows so the
/// cursor keeps the live re-query path instead of serving inconsistent slices.
fn retain_snapshot_row(snapshot:&mut Option<Vec<Vec<MValue>>>,bytes:&mut usize,values:Vec<MValue>)->bool{
    let row_bytes=values_bytes(&values);
    let fits=match snapshot.as_ref(){Some(rows)=>rows.len()<SNAPSHOT_MAX_ROWS&&(*bytes).saturating_add(row_bytes)<=SNAPSHOT_MAX_BYTES,None=>false};
    if fits{
        *bytes=(*bytes).saturating_add(row_bytes);
        if let Some(rows)=snapshot.as_mut(){rows.push(values);}
        true
    }else{*snapshot=None;false}
}
fn snapshot_page(snapshot:&Snapshot,offset:usize,limit:usize)->DriverResult<Value>{
    let rows:DriverResult<Vec<Value>>=snapshot.rows.iter().skip(offset).take(limit).enumerate().map(|(index,values)|{
        let cells:DriverResult<Vec<_>>=values.iter().enumerate().map(|(column,value)|cell(value,snapshot.columns.get(column).ok_or_else(||DriverError::invalid("列下标越界"))?,false)).collect();
        Ok(json!({"index":offset+index,"cells":cells?}))
    }).collect();let rows=rows?;
    Ok(json!({"columns":page_columns(&snapshot.columns),"returned":rows.len(),"rows":rows,"offset":offset,"hasMore":offset.saturating_add(limit)<snapshot.rows.len()}))
}
fn snapshot_full_cell(snapshot:&Snapshot,row:usize,column:usize)->DriverResult<Value>{
    let values=snapshot.rows.get(row).ok_or_else(||DriverError::new("not-found","行不存在"))?;
    let value=values.get(column).ok_or_else(||DriverError::invalid("列下标越界"))?;
    cell(value,snapshot.columns.get(column).ok_or_else(||DriverError::invalid("列下标越界"))?,true)
}
fn query_page_payload(page:&mut Value,cursor:Value,executed_sql:&str,elapsed_ms:u64,stable:bool)->DriverResult<()>{
    let object=page.as_object_mut().ok_or_else(||DriverError::invalid("查询结果无效"))?;
    object.insert("cursorId".into(),cursor);object.insert("executedSql".into(),json!(executed_sql));
    object.insert("elapsedMs".into(),json!(elapsed_ms));object.insert("stable".into(),json!(stable));Ok(())
}
fn row_outcome(index:usize,affected:u64,error:Option<String>,sql:&str)->Value{
    json!({"index":index,"affected":affected,"error":error,"sql":sql})
}
fn edit_result(total:u64,outcomes:Vec<Value>,in_transaction:bool)->Value{
    let ok=outcomes.iter().all(|outcome|outcome["error"].is_null());
    json!({"affected":total,"ok":ok,"outcomes":outcomes,"inTransaction":in_transaction})
}
pub struct MysqlDriver {conn:Conn,cursors:HashMap<String,Cursor>,sequence:u64,active:bool,pending:u64,import_active:bool,import_failed:bool,import_next:u64,import_target:Option<String>,running:Arc<AtomicBool>,cancel:CancelHandle,_tunnel:Option<SshTunnel>,database:String}
pub fn connect(config:&ConnectionConfig,secrets:&SecretMap)->DriverResult<Box<dyn Driver>>{
    let host=n::option(config,"host","127.0.0.1");let port=n::port(config,"port",3306)?;
    let database=n::option(config,"database","");if database.is_empty(){return Err(DriverError::invalid("缺少数据库名"));}
    let mode=tls::mode(config,false)?;let tunnel=tunnel::open(config,secrets,&host,port)?;
    if tunnel.is_some()&&mode==TlsMode::VerifyFull{return Err(DriverError::unsupported("MySQL SSH隧道下verify-full的原始主机名校验尚未迁移"));}
    let ssl=if mode==TlsMode::Disable{None}else{
        let ca=n::option(config,"sslrootcert","");
        let mut opts=SslOpts::default().with_danger_accept_invalid_certs(mode==TlsMode::Require).with_danger_skip_domain_validation(mode==TlsMode::Require||mode==TlsMode::VerifyCa);
        if !ca.is_empty(){let info=std::fs::metadata(&ca).map_err(|_|DriverError::new("connection_failed","无法读取TLS CA文件"))?;if !info.is_file()||info.len()>1024*1024{return Err(DriverError::invalid("TLS CA必须是最多1MiB的普通文件"));}opts=opts.with_root_cert_path(Some(std::path::PathBuf::from(ca)));}Some(opts)
    };
    let opts=Opts::from(OptsBuilder::default().ip_or_hostname(Some(if tunnel.is_some(){"127.0.0.1".into()}else{host})).tcp_port(tunnel.as_ref().map(|t|t.port).unwrap_or(port))
        .user(Some(n::option(config,"user","root"))).pass(secrets.get("dbPassword").and_then(Value::as_str).map(str::to_owned))
        .db_name(Some(database.clone())).ssl_opts(ssl).tcp_connect_timeout(Some(n::timeout())).read_timeout(Some(n::timeout())).write_timeout(Some(n::timeout())).prefer_socket(false));
    let mut conn=connect_options(&opts).map_err(error)?;conn.query_drop("SET NAMES utf8mb4").map_err(error)?;
    let id=conn.connection_id();let running=Arc::new(AtomicBool::new(false));let flag=running.clone();
    let cancel:CancelHandle=Arc::new(move||{
        if !flag.load(Ordering::SeqCst){return Ok(false);}let mut control=connect_options(&opts).map_err(error)?;
        control.query_drop(format!("KILL QUERY {id}")).map_err(error)?;Ok(true)
    });
    Ok(Box::new(MysqlDriver{conn,cursors:HashMap::new(),sequence:0,active:false,pending:0,import_active:false,import_failed:false,import_next:0,import_target:None,running,cancel,_tunnel:tunnel,database:database.clone()}))
}
impl MysqlDriver {
    /// Single error→transaction-state mapping shared by every MySQL execution
    /// path, so a server-side deadlock rollback cannot leave a stale
    /// `active`/`pending` pair behind.
    fn note_mysql_error<T>(&mut self,result:&mysql::Result<T>){
        if let Err(error)=result{
            let(active,pending)=transaction_state_after_error(self.active,self.pending,error);
            self.active=active;self.pending=pending;
        }
    }
    fn query(&mut self,sql:&str,values:&[Value])->DriverResult<Vec<Row>>{
        let params=params(values)?;self.running.store(true,Ordering::SeqCst);let result=self.conn.exec(sql,params);self.running.store(false,Ordering::SeqCst);self.note_mysql_error(&result);result.map_err(error)
    }
    fn execute(&mut self,sql:&str,values:&[Value])->DriverResult<u64>{
        let params=params(values)?;self.running.store(true,Ordering::SeqCst);
        // COM_STMT_PREPARE does not support all transaction/savepoint control statements.
        // Values remain bound with exec_drop; static/control SQL uses COM_QUERY.
        let result=if values.is_empty(){self.conn.query_drop(sql)}else{self.conn.exec_drop(sql,params)};
        self.running.store(false,Ordering::SeqCst);
        self.note_mysql_error(&result);
        result.map_err(error)?;Ok(self.conn.affected_rows())
    }
    fn begin(&mut self)->DriverResult<()>{if !self.active{self.execute("START TRANSACTION",&[])?;self.active=true;self.pending=0;}Ok(())}
    fn page(&mut self,sql:&str,values:&[Value],offset:usize,limit:usize)->DriverResult<Value>{
        let stmt=self.conn.prep(sql).map_err(error)?;if stmt.columns().is_empty(){return Err(DriverError::unsupported("分页查询只接受有返回列的查询语句"));}let columns=stmt.columns().to_vec();let args=params(values)?;
        self.running.store(true,Ordering::SeqCst);
        // Original column names may repeat: a derived-table wrapper would reject valid SQL.
        // Keep only a page in memory; QueryResult drains the remaining wire rows on drop.
        let result=(||->mysql::Result<Vec<Row>>{
            let mut stream=self.conn.exec_iter(&stmt,args)?;
            for _ in 0..offset{match stream.next(){Some(row)=>{row?;},None=>return Ok(vec![])}}
            let mut rows=vec![];for _ in 0..=limit{match stream.next(){Some(row)=>rows.push(row?),None=>break}}Ok(rows)
        })();self.running.store(false,Ordering::SeqCst);self.note_mysql_error(&result);let rows=result.map_err(error)?;
        let has_more=rows.len()>limit;
        let result:DriverResult<Vec<Value>>=rows.iter().take(limit).enumerate().map(|(ix,row)|{
            let cells:DriverResult<Vec<_>>=(0..row.len()).map(|i|cell(row.as_ref(i).unwrap(),&columns[i],false)).collect();Ok(json!({"index":offset+ix,"cells":cells?}))
        }).collect();let rows=result?;
        Ok(json!({"columns":page_columns(&columns),"returned":rows.len(),"rows":rows,"offset":offset,"hasMore":has_more}))
    }
    /// Streams one execution of the statement, rendering the requested page and retaining the raw
    /// rows in a bounded snapshot. A rejected row releases the snapshot so later pages and full-value
    /// reads keep the existing live re-query path.
    fn page_with_snapshot(&mut self,sql:&str,values:&[Value],offset:usize,limit:usize)->DriverResult<(Value,Option<Snapshot>)>{
        let stmt=self.conn.prep(sql).map_err(error)?;if stmt.columns().is_empty(){return Err(DriverError::unsupported("分页查询只接受有返回列的查询语句"));}let columns=stmt.columns().to_vec();let args=params(values)?;
        self.running.store(true,Ordering::SeqCst);
        // Original column names may repeat: a derived-table wrapper would reject valid SQL.
        let result=(||->mysql::Result<(Vec<DriverResult<Vec<Value>>>,Option<Vec<Vec<MValue>>>,usize)>{
            let mut stream=self.conn.exec_iter(&stmt,args)?;
            let mut page=vec![];let mut snapshot=Some(vec![]);let mut bytes=0usize;let mut read=0usize;
            loop{
                let Some(row)=stream.next()else{break};let row=row?;
                if read>=offset&&page.len()<limit{
                    let cells:DriverResult<Vec<_>>=(0..row.len()).map(|i|cell(row.as_ref(i).unwrap(),&columns[i],false)).collect();page.push(cells);
                }
                if snapshot.is_some(){
                    let values=row.unwrap_raw().into_iter().map(|value|value.unwrap_or(MValue::NULL)).collect::<Vec<_>>();
                    retain_snapshot_row(&mut snapshot,&mut bytes,values);
                }
                read+=1;
                if snapshot.is_none()&&read>offset.saturating_add(limit){break;}
            }
            Ok((page,snapshot,read))
        })();self.running.store(false,Ordering::SeqCst);self.note_mysql_error(&result);let(page,snapshot,read)=result.map_err(error)?;
        let has_more=match &snapshot{Some(rows)=>offset.saturating_add(limit)<rows.len(),None=>read>offset.saturating_add(limit)};
        let rows:DriverResult<Vec<_>>=page.into_iter().enumerate().map(|(index,cells)|Ok(json!({"index":offset+index,"cells":cells?}))).collect();let rows=rows?;
        let page=json!({"columns":page_columns(&columns),"returned":rows.len(),"rows":rows,"offset":offset,"hasMore":has_more});
        Ok((page,snapshot.map(|rows|Snapshot{columns,rows})))
    }
    fn management_query(&mut self,sql:String,values:Vec<Value>,options:&Value,started:Instant)->DriverResult<Value>{
        let keep=options.get("keepCursor").and_then(Value::as_bool)!=Some(false);
        let(count,retained)=self.cursors.values().fold((0usize,0usize),|(count,bytes),cursor|match cursor{Cursor::Management(s)=>(count+1,bytes.saturating_add(s.bytes)),_=>(count,bytes)});
        if keep{management_retention(count,retained,0)?;}
        self.running.store(true,Ordering::SeqCst);
        let snapshot=(||{
            if values.is_empty(){management_snapshot(self.conn.query_iter(&sql).map_err(error)?)}
            else{management_snapshot(self.conn.exec_iter(&sql,params(&values)?).map_err(error)?)}
        })();
        self.running.store(false,Ordering::SeqCst);let snapshot=snapshot?;
        if keep{management_retention(count,retained,snapshot.bytes)?;}
        let(offset,limit)=n::page_options(options);let mut page=snapshot.page(offset,limit)?;
        let cursor=if keep{self.sequence+=1;let id=format!("mysql-cur-{}",self.sequence);self.cursors.insert(id.clone(),Cursor::Management(snapshot));json!(id)}else{Value::Null};
        query_page_payload(&mut page,cursor,&sql,started.elapsed().as_millis()as u64,true)?;Ok(page)
    }
    fn explain(&mut self,sql:&str)->DriverResult<Value>{
        let(sql,values)=n::bind_named(sql,&Value::Null,false)?;
        if !values.is_empty()||!sql.split_whitespace().next().is_some_and(|word|word.eq_ignore_ascii_case("select")){
            return Err(DriverError::unsupported("执行计划只接受单条无绑定SELECT；ANALYZE、CALL和其他计划格式尚未开放"));
        }
        let executed_sql=format!("EXPLAIN {sql}");
        self.running.store(true,Ordering::SeqCst);
        let snapshot=(||management_snapshot(self.conn.query_iter(&executed_sql).map_err(error)?))();
        self.running.store(false,Ordering::SeqCst);let snapshot=snapshot?;
        // Dedicated ExplainResult has no cursor/full-cell channel: return bounded complete cells.
        let rows:Vec<Value>=snapshot.rows.into_iter().enumerate().map(|(index,cells)|json!({"index":index,"cells":cells})).collect();
        Ok(json!({"dialectId":"mysql","format":"tabular","executedSql":executed_sql,"columns":snapshot.columns,"rows":rows}))
    }
    fn run_query(&mut self,sql:&str,options:&Value)->DriverResult<Value>{
        let started=Instant::now();let(sql,values)=n::bind_named(sql,options,false)?;
        if management_statement(&sql)?{return self.management_query(sql,values,options,started);}
        let first=sql.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
        if !["select","with"].contains(&first.as_str()){return Err(DriverError::unsupported("分页查询只接受单条查询语句"));}
        let(offset,limit)=n::page_options(options);let keep=options.get("keepCursor").and_then(Value::as_bool)!=Some(false);
        // One execution feeds both the first page and the bounded snapshot. A first page beyond the
        // row budget skips the snapshot attempt and keeps the live path.
        let(mut page,snapshot)=if snapshot_page_supported(keep,offset,limit){self.page_with_snapshot(&sql,&values,offset,limit)?}else{(self.page(&sql,&values,offset,limit)?,None)};
        let stable=snapshot.is_some();
        let cursor=if keep{self.sequence+=1;let id=format!("mysql-cur-{}",self.sequence);self.cursors.insert(id.clone(),Cursor::Query{sql:sql.clone(),values,snapshot});json!(id)}else{Value::Null};
        query_page_payload(&mut page,cursor,&sql,started.elapsed().as_millis()as u64,stable)?;Ok(page)
    }
    fn describe(&mut self,id:&str)->DriverResult<Value>{
        let(schema,table)=n::table_id(id)?;
        let rows=self.query("SELECT c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE,c.COLUMN_DEFAULT,COALESCE(k.ORDINAL_POSITION,0),c.EXTRA FROM information_schema.COLUMNS c LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON k.TABLE_SCHEMA=c.TABLE_SCHEMA AND k.TABLE_NAME=c.TABLE_NAME AND k.COLUMN_NAME=c.COLUMN_NAME AND k.CONSTRAINT_NAME='PRIMARY' WHERE c.TABLE_SCHEMA=? AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION",&[json!(schema),json!(table)])?;
        if rows.is_empty(){return Err(DriverError::new("not-found","表不存在"));}
        let columns:Vec<_>=rows.iter().map(|r|{let ordinal:u64=r.get(4).unwrap_or(0);let extra:String=r.get(5).unwrap_or_default();json!({"name":r.get::<String,_>(0).unwrap_or_default(),"typeName":r.get::<String,_>(1).unwrap_or_default(),"nullable":r.get::<String,_>(2).unwrap_or_default()=="YES","defaultValue":r.get::<Option<String>,_>(3).flatten(),"primaryKeyOrdinal":if ordinal==0{Value::Null}else{json!(ordinal)},"generated":if extra.to_ascii_lowercase().contains("virtual generated"){json!("virtual")}else if extra.to_ascii_lowercase().contains("stored generated"){json!("stored")}else{Value::Null},"identity":if extra.to_ascii_lowercase().contains("auto_increment"){json!("by-default")}else{Value::Null},"autoIncrement":extra.to_ascii_lowercase().contains("auto_increment"),"requiredOnInsert":r.get::<String,_>(2).unwrap_or_default()=="NO"&&r.get::<Option<String>,_>(3).flatten().is_none()&&!extra.contains("auto_increment")&&!extra.contains("GENERATED")})}).collect();
        let mut keys:Vec<_>=rows.iter().filter(|r|r.get::<u64,_>(4).unwrap_or(0)>0).collect();keys.sort_by_key(|r|r.get::<u64,_>(4).unwrap_or(0));let keys:Vec<String>=keys.into_iter().map(|r|r.get(0).unwrap_or_default()).collect();
        let mut result=json!({"id":id,"columns":columns,"primaryKey":keys,"hasUniqueKey":!keys.is_empty()});
        // MySQL partitions are invisible in the column/index metadata above: a partitioned
        // table reads exactly like a plain one. Read information_schema.PARTITIONS so the
        // tree and the DDL dialog can show partitioning instead of silently dropping it.
        if let Ok(rows)=self.query("SELECT PARTITION_NAME,PARTITION_METHOD,PARTITION_EXPRESSION,PARTITION_DESCRIPTION,SUBPARTITION_METHOD,SUBPARTITION_EXPRESSION,TABLE_ROWS,PARTITION_ORDINAL_POSITION FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY PARTITION_ORDINAL_POSITION",&[json!(schema),json!(table)]){
            let mut partitions:Vec<Value>=Vec::new();let mut method=None;let mut expression=None;let mut sub_method=None;let mut sub_expression=None;
            for row in rows{
                let name:Option<String>=row.get::<Option<String>,_>(0).flatten();
                let row_method:Option<String>=row.get::<Option<String>,_>(1).flatten();
                let row_expression:Option<String>=row.get::<Option<String>,_>(2).flatten();
                let description:Option<String>=row.get::<Option<String>,_>(3).flatten();
                let row_sub_method:Option<String>=row.get::<Option<String>,_>(4).flatten();
                let row_sub_expression:Option<String>=row.get::<Option<String>,_>(5).flatten();
                let table_rows:Option<u64>=row.get::<Option<u64>,_>(6).flatten();
                if method.is_none(){method=row_method.clone();}
                if expression.is_none(){expression=row_expression.clone();}
                if sub_method.is_none(){sub_method=row_sub_method.clone();}
                if sub_expression.is_none(){sub_expression=row_sub_expression.clone();}
                // A non-partitioned table still yields one row with a NULL partition name.
                if let Some(name)=name{
                    // 子分区表在信息架构里每个子分区一行：同一个分区会出现多次。
                    // 按分区名聚合，行数相加，否则目录树会出现重复节点。
                    if let Some(existing)=partitions.iter_mut().find(|item|item.get("name").and_then(Value::as_str)==Some(name.as_str())){
                        let merged=existing.get("rows").and_then(Value::as_u64).unwrap_or(0)+table_rows.unwrap_or(0);
                        existing["rows"]=json!(merged);
                        existing["subpartitionCount"]=json!(existing.get("subpartitionCount").and_then(Value::as_u64).unwrap_or(1)+1);
                    }else{
                        partitions.push(json!({"name":name,"method":row_method,"expression":row_expression,"description":description,"subpartitionMethod":row_sub_method,"subpartitionExpression":row_sub_expression,"rows":table_rows,"subpartitionCount":1}));
                    }
                }
            }
            if !partitions.is_empty(){
                result["partitions"]=json!({"method":method,"expression":expression,"subpartitionMethod":sub_method,"subpartitionExpression":sub_expression,"items":partitions});
            }
        }
        if let Ok(rows)=self.query("SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX",&[json!(schema),json!(table)]){
            let mut groups:std::collections::BTreeMap<String,Value>=std::collections::BTreeMap::new();let mut has_expression=false;
            for row in rows{let name:String=row.get(0).unwrap_or_default();let non_unique:u64=row.get(1).unwrap_or(1);let col:Option<String>=row.get::<Option<String>,_>(3).flatten();
                let index=groups.entry(name.clone()).or_insert_with(||json!({"name":name,"unique":non_unique==0,"columns":[],"expression":null,"predicate":null}));
                if let Some(col)=col{index["columns"].as_array_mut().unwrap().push(json!(col));}else{has_expression=true;}
            }
            if has_expression{
                if let Ok(expressions)=self.query("SELECT INDEX_NAME,EXPRESSION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND EXPRESSION IS NOT NULL ORDER BY INDEX_NAME,SEQ_IN_INDEX",&[json!(schema),json!(table)]){
                    for row in expressions{let name:String=row.get(0).unwrap_or_default();let expr:String=row.get(1).unwrap_or_default();if let Some(index)=groups.get_mut(&name){let old=index["expression"].as_str().unwrap_or("");index["expression"]=json!(if old.is_empty(){expr}else{format!("{old}, {expr}")});}}
                    result["indexes"]=json!(groups.into_values().collect::<Vec<_>>());
                }
            }else{result["indexes"]=json!(groups.into_values().collect::<Vec<_>>());}
        }
        if let Ok(rows)=self.query("SELECT t.CONSTRAINT_NAME,k.COLUMN_NAME FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND k.TABLE_NAME=t.TABLE_NAME AND k.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=? AND t.TABLE_NAME=? AND t.CONSTRAINT_TYPE='UNIQUE' ORDER BY t.CONSTRAINT_NAME,k.ORDINAL_POSITION",&[json!(schema),json!(table)]){
            let mut groups:std::collections::BTreeMap<String,Vec<String>>=std::collections::BTreeMap::new();for row in rows{groups.entry(row.get(0).unwrap_or_default()).or_default().push(row.get(1).unwrap_or_default());}result["uniqueConstraints"]=json!(groups.into_iter().map(|(name,columns)|json!({"name":name,"columns":columns})).collect::<Vec<_>>());
        }
        if let Ok(rows)=self.query("SELECT k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA=? AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION",&[json!(schema),json!(table)]){
            let mut groups:std::collections::BTreeMap<String,Value>=std::collections::BTreeMap::new();for row in rows{
                let name:String=row.get(0).unwrap_or_default();let fk=groups.entry(name.clone()).or_insert_with(||json!({"name":name,"columns":[],"referencedSchema":row.get::<String,_>(2).unwrap_or_default(),"referencedTable":row.get::<String,_>(3).unwrap_or_default(),"referencedColumns":[],"onUpdate":row.get::<String,_>(5).unwrap_or_default(),"onDelete":row.get::<String,_>(6).unwrap_or_default()}));
                fk["columns"].as_array_mut().unwrap().push(json!(row.get::<String,_>(1).unwrap_or_default()));fk["referencedColumns"].as_array_mut().unwrap().push(json!(row.get::<String,_>(4).unwrap_or_default()));
            }result["foreignKeys"]=json!(groups.into_values().collect::<Vec<_>>());
        }
        if let Ok(rows)=self.query("SELECT t.CONSTRAINT_NAME,c.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=? AND t.TABLE_NAME=? AND t.CONSTRAINT_TYPE='CHECK' ORDER BY t.CONSTRAINT_NAME",&[json!(schema),json!(table)]){
            result["checks"]=json!(rows.iter().map(|r|json!({"name":r.get::<String,_>(0).unwrap_or_default(),"expression":r.get::<String,_>(1).unwrap_or_default()})).collect::<Vec<_>>());
        }
        if let Ok(rows)=self.query("SELECT TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=? ORDER BY TRIGGER_NAME",&[json!(schema),json!(table)]){
            result["triggers"]=json!(rows.iter().map(|r|json!({"name":r.get::<String,_>(0).unwrap_or_default(),"timing":r.get::<String,_>(1).unwrap_or_default(),"event":r.get::<String,_>(2).unwrap_or_default(),"statement":r.get::<String,_>(3).unwrap_or_default(),"enabled":true,"when":null})).collect::<Vec<_>>());
        }
        Ok(result)
    }
    fn children(&mut self,id:Option<&str>)->DriverResult<Value>{
        let Some(id)=id else{return Ok(json!([n::node("folder:schemas".into(),"folder","Schemas",None,true)]));};
        if id=="folder:schemas"{
            let rows=self.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY SCHEMA_NAME",&[])?;
            return Ok(json!(rows.iter().map(|r|{let s:String=r.get(0).unwrap_or_default();n::node(format!("schema:{}",n::escape_id(&s)),"schema",&s,Some(id),true)}).collect::<Vec<_>>()));
        }
        if let Some(raw)=id.strip_prefix("schema:"){
            let parts=n::unescape_parts(raw)?;if parts.len()!=1{return Err(DriverError::invalid("schema ID无效"));}let schema=&parts[0];
            return Ok(json!([n::node(format!("folder:{}|tables",n::escape_id(schema)),"folder","Tables",Some(id),true),n::node(format!("folder:{}|views",n::escape_id(schema)),"folder","Views",Some(id),true)]));
        }
        if let Some(raw)=id.strip_prefix("folder:"){
            let(schema,kind)=raw.rsplit_once('|').ok_or_else(||DriverError::invalid("分组ID无效"))?;let parts=n::unescape_parts(schema)?;if parts.len()!=1{return Err(DriverError::invalid("schema ID无效"));}
            let view=match kind{"tables"=>false,"views"=>true,_=>return Err(DriverError::invalid("分组ID无效"))};
            let rows=self.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE=? ORDER BY TABLE_NAME",&[json!(parts[0]),json!(if view{"VIEW"}else{"BASE TABLE"})])?;
            return Ok(json!(rows.iter().map(|r|{let name:String=r.get(0).unwrap_or_default();n::node(format!("{}:{}.{}",if view{"view"}else{"table"},n::escape_id(&parts[0]),n::escape_id(&name)),if view{"view"}else{"table"},&name,Some(id),true)}).collect::<Vec<_>>()));
        }
        let desc=self.describe(id)?;let(schema,table)=n::table_id(id)?;
        let mut nodes:Vec<Value>=Vec::new();
        // 分区节点放在列之前：分区是表级结构，不属于列。
        if let Some(items)=desc.get("partitions").and_then(|p|p.get("items")).and_then(|v|v.as_array()){
            let method=desc.get("partitions").and_then(|p|p.get("method")).and_then(|v|v.as_str()).unwrap_or("PARTITION");
            for item in items{
                let name=item.get("name").and_then(|v|v.as_str()).unwrap_or("");
                if name.is_empty(){continue;}
                let bound=item.get("description").and_then(|v|v.as_str()).unwrap_or("-");
                nodes.push(n::node(format!("partition:{}.{}.{}",n::escape_id(&schema),n::escape_id(&table),n::escape_id(name)),"partition",&format!("{name}  (< {bound})"),Some(id),false));
            }
            let _=method;
        }
        nodes.extend(desc["columns"].as_array().unwrap().iter().map(|c|{let name=c["name"].as_str().unwrap_or("");n::node(format!("column:{}.{}.{}",n::escape_id(&schema),n::escape_id(&table),n::escape_id(name)),"column",name,Some(id),false)}));
        Ok(json!(nodes))
    }
    fn require_transactional_table(&mut self,id:&str)->DriverResult<()>{
        if !id.starts_with("table:"){return Err(DriverError::unsupported("事务编辑只接受表"));}
        let(schema,table)=n::table_id(id)?;
        let rows=self.query("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND TABLE_TYPE='BASE TABLE'",&[json!(schema),json!(table)])?;
        let engine=rows.first().and_then(|r|r.get::<Option<String>,_>(0).flatten());
        // Only the transactional engine covered by our savepoint/rollback contract is supported.
        if !engine.is_some_and(|s|s.eq_ignore_ascii_case("InnoDB")){return Err(DriverError::unsupported("原子导入与网格编辑仅支持InnoDB表；该表引擎无法保证回滚"));}
        Ok(())
    }
    fn import_batch(&mut self,id:&str,batch:&Value)->DriverResult<Value>{
        if !id.starts_with("table:"){return Err(DriverError::invalid("导入目标必须是表"));}
        if self.import_failed{return Err(DriverError::invalid("导入已失败，请先回滚"));}
        if self.active&&!self.import_active{return Err(DriverError::invalid("已有用户事务，不能开始导入"));}
        self.require_transactional_table(id)?;
        let description=self.describe(id)?;let plan=n::import_plan(batch,&description)?;
        if plan.batch_index!=self.import_next{return Err(DriverError::invalid("导入批次必须从0开始并连续执行"));}
        if self.import_target.as_deref().is_some_and(|target|target!=id){return Err(DriverError::invalid("导入事务不能切换目标表"));}
        if !self.import_active{self.begin()?;self.import_active=true;self.import_target=Some(id.into());}
        let sql=format!("INSERT INTO {} ({}) VALUES ({})",n::qualified(id,true)?,plan.columns.iter().map(|c|n::quote(c,true)).collect::<Vec<_>>().join(","),vec!["?";plan.columns.len()].join(","));
        let mut imported=0u64;
        for(row_number,values)in plan.rows{
            match self.execute(&sql,&values){
                Ok(1)=>{imported+=1;self.pending+=1;},
                Ok(_)=>{self.import_failed=true;return Err(DriverError::new("driver-error",format!("CSV第{row_number}行实际写入行数不为1，必须回滚")));},
                Err(e)=>{self.import_failed=true;return Err(DriverError::new(e.code,format!("CSV第{row_number}行写入失败；{}",e.message)));}
            }
        }
        self.import_next+=1;Ok(json!({"rowsImported":imported,"inTransaction":true}))
    }
    fn insert_row(&mut self,id:&str,input:&Value)->DriverResult<Value>{
        if self.import_active{return Err(DriverError::invalid("导入事务期间不能混入网格编辑"));}
        if !id.starts_with("table:"){return Err(DriverError::unsupported("视图不能插入行"));}
        self.require_transactional_table(id)?;
        let description=self.describe(id)?;let values=input.as_object().ok_or_else(||DriverError::invalid("插入值无效"))?;
        let mut columns=vec![];let mut params=vec![];
        for(name,value)in values{let metadata=description["columns"].as_array().unwrap().iter().find(|c|c["name"]==name.as_str()).ok_or_else(||DriverError::invalid("未知列"))?;
            if metadata["generated"].is_string(){return Err(DriverError::invalid("不能写入生成列"));}columns.push(n::quote(name,true));params.push(n::cell_param(value)?);
        }
        let sql=format!("INSERT INTO {} ({}) VALUES ({})",n::qualified(id,true)?,columns.join(","),vec!["?";params.len()].join(","));self.begin()?;
        let affected=self.execute(&sql,&params)?;let last_id=self.conn.last_insert_id();let mut key_values=serde_json::Map::new();
        for key in description["primaryKey"].as_array().unwrap(){let name=key.as_str().unwrap();if let Some(value)=values.get(name){key_values.insert(name.into(),value.clone());}else if last_id>0&&description["columns"].as_array().unwrap().iter().any(|c|c["name"]==name&&c["autoIncrement"].as_bool()==Some(true)){key_values.insert(name.into(),if last_id>9_007_199_254_740_991{n::text_cell(&last_id.to_string(),true)}else{json!({"kind":"number","value":last_id})});}}
        self.pending+=affected;Ok(json!({"affected":affected,"keyValues":key_values}))
    }
    fn keys(&mut self,id:&str,input:&Value)->DriverResult<(String,Vec<Value>)>{
        if !id.starts_with("table:"){return Err(DriverError::unsupported("视图不能执行主键编辑"));}let desc=self.describe(id)?;let keys=desc["primaryKey"].as_array().unwrap();
        if keys.is_empty(){return Err(DriverError::unsupported("表缺少主键，禁止按行编辑"));}let supplied=input.as_object().ok_or_else(||DriverError::invalid("缺少主键值"))?;
        if supplied.len()!=keys.len(){return Err(DriverError::invalid("必须提供全部且仅有主键列"));}
        let mut clauses=vec![];let mut values=vec![];
        for key in keys{let name=key.as_str().unwrap();let val=n::cell_param(supplied.get(name).ok_or_else(||DriverError::invalid("缺少主键值"))?)?;if val.is_null(){return Err(DriverError::invalid("主键不能为NULL"));}values.push(val);clauses.push(format!("{}=?",n::quote(name,true)));}
        Ok((clauses.join(" AND "),values))
    }
    fn edit(&mut self,method:&str,id:&str,input:&Value)->DriverResult<Value>{
        self.require_transactional_table(id)?;
        let target=n::qualified(id,true)?;let mut outcomes=vec![];let mut total=0;
        let rows=if method=="applyEdits"||method=="deleteRows"{input.as_array().ok_or_else(||DriverError::invalid("需要行数组"))?.clone()}else{vec![input.clone()]};self.begin()?;
        for(index,item)in rows.iter().enumerate(){
            // Validation runs per row: earlier rows may already have executed, so a
            // late bad row must land in its own outcome instead of aborting the call
            // and leaving the reported state behind the real transaction.
            let prepared=(||->DriverResult<(String,Vec<Value>)>{
                if method=="insertRow"{
                    let values=item.as_object().ok_or_else(||DriverError::invalid("插入值无效"))?;let desc=self.describe(id)?;let mut cols=vec![];let mut params=vec![];
                    for(name,value)in values{if !desc["columns"].as_array().unwrap().iter().any(|c|c["name"]==name.as_str()){return Err(DriverError::invalid("未知列"));}cols.push(n::quote(name,true));params.push(n::cell_param(value)?);}
                    Ok((format!("INSERT INTO {target} ({}) VALUES ({})",cols.join(","),vec!["?";params.len()].join(",")),params))
                }else{
                    let keys=if method=="applyEdits"{&item["keyValues"]}else{item};let(where_sql,key_values)=self.keys(id,keys)?;
                    if method=="deleteRows"{Ok((format!("DELETE FROM {target} WHERE {where_sql}"),key_values))}else{
                        let changes=item["changes"].as_object().ok_or_else(||DriverError::invalid("缺少修改列"))?;if changes.is_empty(){return Err(DriverError::invalid("修改列不能为空"));}
                        let desc=self.describe(id)?;let mut set=vec![];let mut values=vec![];
                        for(name,value)in changes{if !desc["columns"].as_array().unwrap().iter().any(|c|c["name"]==name.as_str()){return Err(DriverError::invalid("未知列"));}values.push(n::cell_param(value)?);set.push(format!("{}=?",n::quote(name,true)));}
                        values.extend(key_values);Ok((format!("UPDATE {target} SET {} WHERE {where_sql}",set.join(",")),values))
                    }
                }
            })();
            let(sql,values)=match prepared{
                Ok(prepared)=>prepared,
                Err(error)=>{outcomes.push(row_outcome(index,0,Some(error.message),""));continue;}
            };
            self.execute("SAVEPOINT dbstudio_edit",&[])?;
            match self.execute(&sql,&values){
                Ok(n)if method=="insertRow"||n<=1=>{
                    self.execute("RELEASE SAVEPOINT dbstudio_edit",&[])?;
                    total+=n;self.pending+=n;
                    outcomes.push(row_outcome(index,n,None,&sql));
                },
                Err(error)if !self.active=>return Err(error),
                result=>{
                    self.execute("ROLLBACK TO SAVEPOINT dbstudio_edit",&[])?;self.execute("RELEASE SAVEPOINT dbstudio_edit",&[])?;
                    let message=match result{Err(error)=>error.message,_=>"主键编辑影响多行，已回滚该行".into()};
                    outcomes.push(row_outcome(index,0,Some(message),&sql));
                }
            }
        }
        Ok(edit_result(total,outcomes,self.active))
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    fn address(value:&str)->SocketAddr{value.parse().unwrap()}
    #[test]
    fn management_float_text_binary_consistent(){
        let text=management_real(b"0.1",true).unwrap();
        assert_eq!(text,MValue::Float(0.1_f32));
        let MValue::Float(value)=text else{panic!("FLOAT metadata must retain f32 precision")};
        assert_eq!(value as f64,0.1_f32 as f64);assert_ne!(value as f64,0.1_f64);
        assert_eq!(management_real(b"0.1",false).unwrap(),MValue::Double(0.1_f64));
        let column=mysql::Column::new(mysql::consts::ColumnType::MYSQL_TYPE_FLOAT);
        assert_eq!(management_cell(&MValue::Bytes(b"0.1".to_vec()),&column).unwrap(),management_cell(&MValue::Float(0.1_f32),&column).unwrap());
    }
    #[test]
    fn integer_cells_keep_full_precision_beyond_double_range(){
        use mysql::consts::ColumnType;
        // 超过 2^53 的整数转 f64 会失真，必须降级成文本而不是静默改值。
        let column=mysql::Column::new(ColumnType::MYSQL_TYPE_LONGLONG);
        for (value,text) in [
            (MValue::Int(9_007_199_254_740_991),None),
            (MValue::Int(9_007_199_254_740_992),Some("9007199254740992")),
            (MValue::Int(-9_007_199_254_740_992),Some("-9007199254740992")),
            (MValue::UInt(18_446_744_073_709_551_615),Some("18446744073709551615")),
        ]{
            let out=cell(&value,&column,true).unwrap();
            match text{
                None=>assert_eq!(out,json!({"kind":"number","value":9_007_199_254_740_991_i64}),
                    "边界内的整数应保持 number 形态"),
                Some(expected)=>assert_eq!(out,json!({"kind":"text","text":expected}),
                    "越界整数必须原样保留为文本：{value:?}"),
            }
        }
    }

    #[test]
    fn non_finite_floats_degrade_to_text_instead_of_invalid_json(){
        use mysql::consts::ColumnType;
        // NaN / Infinity 不是合法 JSON 数字，直接序列化会得到 null 或直接报错。
        let column=mysql::Column::new(ColumnType::MYSQL_TYPE_DOUBLE);
        for (value,expected) in [
            (MValue::Double(f64::NAN),"NaN"),
            (MValue::Double(f64::INFINITY),"inf"),
            (MValue::Double(f64::NEG_INFINITY),"-inf"),
        ]{
            let out=cell(&value,&column,true).unwrap();
            assert_eq!(out.get("kind").and_then(Value::as_str),Some("text"),"{expected} 应降级为文本");
            assert_eq!(out.get("text").and_then(Value::as_str),Some(expected));
        }
        assert_eq!(cell(&MValue::Double(1.5),&column,true).unwrap(),json!({"kind":"number","value":1.5}));
    }

    #[test]
    fn bytes_column_is_binary_only_for_binary_charset_and_non_numeric_types(){
        use mysql::consts::ColumnType;
        let bytes=MValue::Bytes(vec![0xff,0x00,0x01]);
        // 二进制字符集 + 非数值类型 → blob。
        let blob=mysql::Column::new(ColumnType::MYSQL_TYPE_BLOB).with_character_set(63);
        assert_eq!(cell(&bytes,&blob,true).unwrap().get("kind").and_then(Value::as_str),Some("blob"));
        // 二进制字符集但类型是 DECIMAL → 仍是文本，不能被当成二进制。
        for kind in [ColumnType::MYSQL_TYPE_DECIMAL,ColumnType::MYSQL_TYPE_NEWDECIMAL,ColumnType::MYSQL_TYPE_JSON]{
            let column=mysql::Column::new(kind).with_character_set(63);
            assert!(cell(&bytes,&column,true).is_err()||
                cell(&bytes,&column,true).unwrap().get("kind").and_then(Value::as_str)==Some("text"),
                "{kind:?} 不应被当作二进制");
        }
        // 文本字符集 → 文本；非法 UTF-8 必须报错而不是产生损坏字符串。
        let text_column=mysql::Column::new(ColumnType::MYSQL_TYPE_VAR_STRING).with_character_set(45);
        assert_eq!(cell(&MValue::Bytes(b"ok".to_vec()),&text_column,true).unwrap(),json!({"kind":"text","text":"ok"}));
        assert!(cell(&bytes,&text_column,true).is_err(),"非法 UTF-8 必须报错");
    }

    #[test]
    fn management_cell_parses_com_query_text_into_typed_values(){
        // COM_QUERY 把数值列返回成 Bytes，管理面必须还原成与预处理路径一致的结果。
        use mysql::consts::ColumnType::*;
        for kind in [MYSQL_TYPE_TINY,MYSQL_TYPE_SHORT,MYSQL_TYPE_LONG,MYSQL_TYPE_INT24,MYSQL_TYPE_LONGLONG]{
            let column=mysql::Column::new(kind);
            assert_eq!(management_cell(&MValue::Bytes(b"42".to_vec()),&column).unwrap(),
                json!({"kind":"number","value":42}),"{kind:?} 的文本数值应还原为 number");
            // 超出 i64 的取值走无符号解析。
            assert_eq!(management_cell(&MValue::Bytes(b"18446744073709551615".to_vec()),&column).unwrap(),
                json!({"kind":"text","text":"18446744073709551615"}));
        }
        let column=mysql::Column::new(MYSQL_TYPE_LONG);
        assert!(management_cell(&MValue::Bytes(b"not-a-number".to_vec()),&column).is_err());
        assert!(management_cell(&MValue::Bytes(vec![0xff]),&column).is_err());
    }
    #[test]
    fn management_snapshot_retained_budgets_are_enforced(){
        let mut snapshot=ManagementSnapshot::new(vec![json!({"name":"x","type":"text"})]).unwrap();
        for _ in 0..10_000{snapshot.push(vec![json!({"kind":"null"})]).unwrap();}
        assert_eq!(snapshot.push(vec![json!({"kind":"null"})]).err().unwrap().code,"resource-limit");
        let mut large=ManagementSnapshot::new(vec![]).unwrap();
        assert_eq!(large.push(vec![json!({"kind":"text","text":"a".repeat(8*1024*1024)})]).err().unwrap().code,"resource-limit");
        assert!(large.rows.is_empty());
        assert!(management_retention(15,32*1024*1024-1,1).is_ok());
        assert_eq!(management_retention(15,32*1024*1024,1).err().unwrap().code,"resource-limit");
        assert_eq!(management_retention(16,0,0).err().unwrap().code,"resource-limit");
    }
    #[test]
    fn management_snapshot_page_preview_and_full_cell_are_distinct(){
        let mut snapshot=ManagementSnapshot::new(vec![json!({"name":"ddl","type":"text"})]).unwrap();
        let text="ddl".repeat(600);snapshot.push(vec![n::text_cell(&text,true)]).unwrap();
        let first=snapshot.page(0,1).unwrap();assert_eq!(first["hasMore"],false);assert_eq!(first["rows"][0]["cells"][0]["truncated"],true);
        assert_eq!(snapshot.full_cell(0,0).unwrap()["text"],text);
        let last=snapshot.page(1,1).unwrap();assert_eq!(last["returned"],0);assert_eq!(last["offset"],1);assert_eq!(last["hasMore"],false);
    }
    #[test]
    fn management_statement_policy_does_not_enable_execution_variants(){
        for sql in ["SHOW TABLES","SHOW CREATE TABLE t","DESCRIBE t","EXPLAIN SELECT id FROM t"]{assert!(management_statement(sql).unwrap());}
        for sql in ["EXPLAIN ANALYZE SELECT 1","EXPLAIN FORMAT=JSON SELECT 1","EXPLAIN WITH x AS(SELECT 1) SELECT * FROM x","CALL p()"]{
            assert_eq!(management_statement(sql).err().unwrap().code,"unsupported");
        }
        assert!(!management_statement("SELECT 1").unwrap());
    }
    #[test]
    fn address_family_binds_follow_resolver_order_and_dedupe(){
        assert_eq!(family_binds([address("[::1]:3306"),address("127.0.0.1:3306"),address("[::2]:3306"),address("127.0.0.2:3306")]),vec![address("[::]:0"),address("0.0.0.0:0")]);
        assert_eq!(family_binds([address("127.0.0.1:3306"),address("[::1]:3306")]),vec![address("0.0.0.0:0"),address("[::]:0")]);
        assert_eq!(family_binds([address("[::1]:3306"),address("[::2]:3306")]),vec![address("[::]:0")]);
    }
    #[test]
    fn only_tcp_connect_failures_are_retryable(){
        assert!(retryable_connect_error(&mysql::Error::DriverError(mysql::DriverError::ConnectTimeout)));
        assert!(retryable_connect_error(&mysql::Error::DriverError(mysql::DriverError::CouldNotConnect(Some(("localhost:3306".into(),"refused".into(),std::io::ErrorKind::ConnectionRefused))))));
        assert!(!retryable_connect_error(&mysql::Error::DriverError(mysql::DriverError::TlsNotSupported)));
        assert!(!retryable_connect_error(&mysql::Error::MySqlError(mysql::MySqlError{state:"28000".into(),code:1045,message:"access denied".into()})));
        assert!(!retryable_connect_error(&mysql::Error::IoError(std::io::Error::new(std::io::ErrorKind::InvalidData,"handshake failed"))));
    }
    #[test]
    fn family_binds_preserve_original_hostname_and_port(){
        let opts=Opts::from(OptsBuilder::default().ip_or_hostname(Some("db.fixture")).tcp_port(3306));
        for bind in family_binds([address("[::1]:3306"),address("127.0.0.1:3306")]){
            let candidate=Opts::from(OptsBuilder::from_opts(opts.clone()).bind_address(Some(bind)));
            assert_eq!(candidate.get_ip_or_hostname().as_ref(),"db.fixture");
            assert_eq!(candidate.get_tcp_port(),3306);
        }
    }
    #[test]
    fn deadlock_aborts_transaction_but_statement_errors_preserve_it(){
        let stream_error=|state:&str,code:u16|mysql::Error::MySqlError(mysql::MySqlError{state:state.into(),code,message:"statement failed".into()});
        let deadlock=stream_error("40001",1213);
        assert!(error_aborts_transaction(&deadlock));
        assert_eq!(transaction_state_after_error(true,7,&deadlock),(false,0));
        assert_eq!(transaction_state_after_error(false,0,&deadlock),(false,0));
        // 1205 lock wait timeout and 1062 duplicate key only roll back the failed
        // statement; the transaction the driver owns stays usable.
        for(state,code)in [("HY000",1205_u16),("23000",1062)]{
            let statement_error=stream_error(state,code);
            assert!(!error_aborts_transaction(&statement_error),"{code}");
            assert_eq!(transaction_state_after_error(true,7,&statement_error),(true,7),"{code}");
        }
        let io_error=mysql::Error::IoError(std::io::Error::new(std::io::ErrorKind::UnexpectedEof,"closed"));
        assert!(!error_aborts_transaction(&io_error));
        assert_eq!(transaction_state_after_error(true,7,&io_error),(true,7));
    }
    #[test]
    fn edit_outcomes_report_each_row_and_aggregate_consistently(){
        let outcomes=vec![
            row_outcome(0,1,None,"UPDATE `s`.`t` SET `a`=? WHERE `id`=?"),
            row_outcome(1,0,Some("未知列".into()),""),
            row_outcome(2,0,Some("主键编辑影响多行，已回滚该行".into()),"DELETE FROM `s`.`t` WHERE `id`=?"),
        ];
        let result=edit_result(1,outcomes,true);
        assert_eq!(result["affected"],1);
        assert_eq!(result["ok"],false);
        assert_eq!(result["inTransaction"],true);
        let outcomes=result["outcomes"].as_array().unwrap();
        assert_eq!(outcomes.len(),3);
        assert_eq!(outcomes[0]["error"],Value::Null);
        assert_eq!(outcomes[0]["affected"],1);
        assert_eq!(outcomes[1]["index"],1);
        assert_eq!(outcomes[1]["affected"],0);
        assert_eq!(outcomes[1]["error"],"未知列");
        assert_eq!(outcomes[2]["error"],"主键编辑影响多行，已回滚该行");
        let clean=edit_result(2,vec![row_outcome(0,2,None,"DELETE FROM `s`.`t` WHERE `id`=?")],false);
        assert_eq!(clean["ok"],true);
        assert_eq!(clean["affected"],2);
        let empty=edit_result(0,vec![],true);
        assert_eq!(empty["ok"],true);
        assert_eq!(empty["affected"],0);
    }
    fn snapshot_fixture(rows:Vec<Vec<MValue>>)->Snapshot{
        Snapshot{columns:vec![mysql::Column::new(mysql::consts::ColumnType::MYSQL_TYPE_LONG)],rows}
    }
    #[test]
    fn snapshot_page_slices_rows_offsets_and_has_more(){
        let snapshot=snapshot_fixture((0..4).map(|value|vec![MValue::Int(value)]).collect());
        let first=snapshot_page(&snapshot,0,2).unwrap();
        assert_eq!(first["returned"],2);
        assert_eq!(first["hasMore"],true,"a page followed by more rows must report hasMore");
        assert_eq!(first["rows"][0]["index"],0);
        assert_eq!(first["rows"][1]["index"],1);
        assert_eq!(first["rows"][1]["cells"][0],json!({"kind":"number","value":1}));
        let last=snapshot_page(&snapshot,2,2).unwrap();
        assert_eq!(last["returned"],2);
        assert_eq!(last["hasMore"],false,"a full final page must report no more rows");
        assert_eq!(last["rows"][1]["index"],3);
        let beyond=snapshot_page(&snapshot,4,2).unwrap();
        assert_eq!(beyond["returned"],0);
        assert_eq!(beyond["hasMore"],false);
        assert!(beyond["rows"].as_array().unwrap().is_empty());
        let overlap=snapshot_page(&snapshot,1,2).unwrap();
        assert_eq!(overlap["rows"][0],first["rows"][1]);
        assert_eq!(overlap["rows"][1],last["rows"][0]);
    }
    #[test]
    fn snapshot_full_cell_keeps_raw_value_for_preview_and_full_reads(){
        let text="值".repeat(1200);
        let snapshot=Snapshot{columns:vec![mysql::Column::new(mysql::consts::ColumnType::MYSQL_TYPE_VAR_STRING)],rows:vec![vec![MValue::Bytes(text.as_bytes().to_vec())]]};
        let page=snapshot_page(&snapshot,0,1).unwrap();
        assert_eq!(page["rows"][0]["cells"][0]["truncated"],true);
        assert_eq!(page["rows"][0]["cells"][0]["fullLength"],1200);
        assert_eq!(snapshot_full_cell(&snapshot,0,0).unwrap(),json!({"kind":"text","text":text}));
        assert_eq!(snapshot_full_cell(&snapshot,1,0).err().unwrap().code,"not-found");
        assert_eq!(snapshot_full_cell(&snapshot,0,1).err().unwrap().code,"invalid-argument");
        let blob=Snapshot{columns:vec![mysql::Column::new(mysql::consts::ColumnType::MYSQL_TYPE_BLOB).with_character_set(63)],rows:vec![vec![MValue::Bytes(vec![1,2,3])]]};
        assert_eq!(snapshot_full_cell(&blob,0,0).unwrap(),json!({"kind":"blob","previewBase64":STANDARD.encode([1,2,3]),"length":3,"truncated":false}));
    }
    #[test]
    fn snapshot_budget_rejects_over_budget_rows_and_releases_the_snapshot(){
        assert_eq!(value_bytes(&MValue::NULL),0);
        assert_eq!(value_bytes(&MValue::Int(7)),8);
        assert_eq!(value_bytes(&MValue::Bytes(b"abc".to_vec())),3);
        let mut snapshot=Some(Vec::new());let mut bytes=0usize;
        for _ in 0..SNAPSHOT_MAX_ROWS{assert!(retain_snapshot_row(&mut snapshot,&mut bytes,vec![MValue::Int(1)]));}
        assert_eq!(bytes,SNAPSHOT_MAX_ROWS*8);
        assert!(!retain_snapshot_row(&mut snapshot,&mut bytes,vec![MValue::Int(1)]),"the row budget must reject one more row");
        assert!(snapshot.is_none(),"rejecting a row must release the retained rows");
        let mut snapshot=Some(Vec::new());let mut bytes=0usize;
        assert!(retain_snapshot_row(&mut snapshot,&mut bytes,vec![MValue::Bytes(vec![0;SNAPSHOT_MAX_BYTES-8]),MValue::Int(1)]));
        assert_eq!(bytes,SNAPSHOT_MAX_BYTES);
        assert!(!retain_snapshot_row(&mut snapshot,&mut bytes,vec![MValue::Bytes(vec![1])]));
        assert!(snapshot.is_none());
        let mut snapshot=Some(Vec::new());let mut bytes=SNAPSHOT_MAX_BYTES;
        assert!(!retain_snapshot_row(&mut snapshot,&mut bytes,vec![MValue::Bytes(vec![1])]));
        assert!(snapshot.is_none());
    }
    #[test]
    fn query_page_payload_marks_stable_only_for_snapshot_paths(){
        let mut stable_page=json!({"columns":[],"rows":[],"returned":0,"offset":0,"hasMore":false});
        query_page_payload(&mut stable_page,json!("mysql-cur-1"),"SELECT NOW()",3,true).unwrap();
        assert_eq!(stable_page["stable"],true);
        assert_eq!(stable_page["cursorId"],"mysql-cur-1");
        assert_eq!(stable_page["executedSql"],"SELECT NOW()");
        assert_eq!(stable_page["elapsedMs"],3);
        let mut live_page=json!({});
        query_page_payload(&mut live_page,Value::Null,"SELECT NOW()",4,false).unwrap();
        assert_eq!(live_page["stable"],false);
        assert_eq!(live_page["cursorId"],Value::Null);
    }
    #[test]
    fn snapshot_gate_keeps_live_path_for_keep_cursor_off_and_oversized_pages(){
        assert!(!snapshot_page_supported(false,0,200),"keepCursor=false must not retain a snapshot");
        assert!(snapshot_page_supported(true,0,200));
        assert!(snapshot_page_supported(true,SNAPSHOT_MAX_ROWS-200,200),"a page ending exactly at the row budget is supported");
        assert!(!snapshot_page_supported(true,SNAPSHOT_MAX_ROWS-199,200),"a page beyond the row budget keeps the live path");
        assert!(!snapshot_page_supported(true,1_000_000,200));
    }
}
impl Driver for MysqlDriver {
    fn dialect_id(&self)->&str{"mysql"}
    fn capabilities(&self)->Value{json!({"hasCatalog":false,"hasSchema":true,"supportsServerPagination":true,"supportsCancel":true,"supportsInlineEdit":true,"metadata":{"foreignKeys":true,"indexes":true,"uniqueConstraints":true,"checkConstraints":true,"triggers":true}})}
    fn cancel_handle(&self)->CancelHandle{self.cancel.clone()}
    fn disconnect(&mut self)->DriverResult<()>{self.cursors.clear();if self.active{self.execute("ROLLBACK",&[])?;self.active=false;self.pending=0;}self.import_active=false;self.import_failed=false;self.import_next=0;self.import_target=None;Ok(())}
    fn call(&mut self,method:&str,args:Vec<Value>)->DriverResult<Value>{
        if self.import_active&&!["importBatch","transactionState","commitTransaction","rollbackTransaction","cancelQuery"].contains(&method){return Err(DriverError::invalid("导入事务期间不能混入其他操作"));}
        match method{
            "listChildren"=>self.children(args.first().and_then(Value::as_str)),
            "describeTable"=>self.describe(string_argument(&args,0,"tableId")?),
            "explain"=>{if args.len()!=1{return Err(DriverError::invalid("执行计划仅接受SQL，不接受绑定或尾随选项"));}self.explain(string_argument(&args,0,"sql")?)},
            "runQuery"|"query"=>self.run_query(string_argument(&args,0,"sql")?,args.get(1).unwrap_or(&Value::Null)),
            "previewTable"=>{let sql=format!("SELECT * FROM {}",n::qualified(string_argument(&args,0,"tableId")?,true)?);self.run_query(&sql,&json!({"limit":args.get(1).and_then(Value::as_u64).unwrap_or(200)}))},
            "fetchResultPage"|"fetchPage"=>{let id=string_argument(&args,0,"cursorId")?;let c=self.cursors.get(id).ok_or_else(||DriverError::new("not-found","游标不存在"))?;let offset=args.get(1).and_then(Value::as_u64).unwrap_or(0)as usize;let limit=args.get(2).and_then(Value::as_u64).unwrap_or(200).clamp(1,1000)as usize;let(sql,values)=match c{Cursor::Management(snapshot)=>return snapshot.page(offset,limit),Cursor::Query{sql,values,snapshot}=>{if let Some(snapshot)=snapshot{return snapshot_page(snapshot,offset,limit);}(sql.clone(),values.clone())}};self.page(&sql,&values,offset,limit)},
            "closeCursor"=>{self.cursors.remove(string_argument(&args,0,"cursorId")?);Ok(Value::Null)},
            "fetchCellValue"=>{
                let id=string_argument(&args,0,"cursorId")?;let c=self.cursors.get(id).ok_or_else(||DriverError::new("not-found","游标不存在"))?;
                let row=args.get(1).and_then(Value::as_u64).ok_or_else(||DriverError::invalid("行下标无效"))?;let column=args.get(2).and_then(Value::as_u64).ok_or_else(||DriverError::invalid("列下标无效"))? as usize;
                let(sql,values)=match c{Cursor::Management(snapshot)=>return snapshot.full_cell(usize::try_from(row).map_err(|_|DriverError::invalid("行下标无效"))?,column),Cursor::Query{sql,values,snapshot}=>{if let Some(snapshot)=snapshot{return snapshot_full_cell(snapshot,usize::try_from(row).map_err(|_|DriverError::invalid("行下标无效"))?,column);}(sql.clone(),values.clone())}};
                self.running.store(true,Ordering::SeqCst);
                let result=(||->DriverResult<Value>{let args=params(&values)?;let stmt=self.conn.prep(&sql).map_err(error)?;if stmt.columns().is_empty(){return Err(DriverError::unsupported("分页查询只接受有返回列的查询语句"));}let mut stream=self.conn.exec_iter(&stmt,args).map_err(error)?;
                    for _ in 0..row{match stream.next(){Some(row)=>{row.map_err(error)?;},None=>return Err(DriverError::new("not-found","行不存在"))}}
                    let r=stream.next().ok_or_else(||DriverError::new("not-found","行不存在"))?.map_err(error)?;
                    if column>=r.len(){return Err(DriverError::invalid("列下标越界"));}cell(r.as_ref(column).unwrap(),&r.columns_ref()[column],true)
                })();self.running.store(false,Ordering::SeqCst);result
            },
            "viewDefinition"=>{let(schema,name)=n::table_id(string_argument(&args,0,"viewId")?)?;let rows=self.query("SELECT VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",&[json!(schema),json!(name)])?;Ok(rows.first().and_then(|r|r.get::<Option<String>,_>(0).flatten()).map(Value::String).unwrap_or(Value::Null))},
            "listRoutines"=>{
                let schema=args.first().and_then(|v|v.get("schema")).and_then(Value::as_str);
                let rows=self.query("SELECT ROUTINE_SCHEMA,ROUTINE_NAME,ROUTINE_TYPE,ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE (? IS NULL OR ROUTINE_SCHEMA=?) AND ROUTINE_SCHEMA NOT IN ('mysql','sys','information_schema','performance_schema') ORDER BY ROUTINE_SCHEMA,ROUTINE_NAME",&[schema.map(|s|json!(s)).unwrap_or(Value::Null),schema.map(|s|json!(s)).unwrap_or(Value::Null)])?;
                Ok(json!(rows.iter().map(|r|json!({"schema":r.get::<String,_>(0).unwrap_or_default(),"name":r.get::<String,_>(1).unwrap_or_default(),"kind":if r.get::<String,_>(2).unwrap_or_default()=="PROCEDURE"{"procedure"}else{"function"},"definition":r.get::<Option<String>,_>(3).flatten()})).collect::<Vec<_>>()))
            },
            "executeStatement"=>{
                let original=string_argument(&args,0,"sql")?;let options=args.get(1).unwrap_or(&Value::Null);let(sql,values)=n::bind_named(original,options,false)?;let started=Instant::now();
                if management_statement(&sql)?{return Ok(json!({"kind":"rows","result":self.management_query(sql,values,options,started)?}));}
                // Session timezone offsets do not begin or end the managed transaction.
                if values.is_empty()&&is_session_timezone_offset_statement(&sql){
                    let affected=self.execute(&sql,&values)?;
                    return Ok(json!({"kind":"affected","affected":affected,"inTransaction":self.active,"transactionState":n::transaction_state(self.active,self.pending),"executedSql":sql,"elapsedMs":started.elapsed().as_millis()as u64}));
                }
                let keyword=sql.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                // 部分 MySQL 语句（例如 CREATE/DROP EVENT）不支持预处理语句协议（错误 1295）。
                // 这类语句直接走文本协议，不再用 prep 做列探测。
                // CREATE/DROP EVENT 与 CREATE/DROP TRIGGER 都不支持预处理语句协议
                // （错误 1295），这类语句必须走文本协议。
                let text_protocol_only=["event","trigger","procedure","function"];let second=sql.split_whitespace().nth(1).unwrap_or("").to_ascii_lowercase();let text_only=text_protocol_only.contains(&second.as_str())||text_protocol_only.contains(&keyword.as_str());
                if !text_only{
                    let stmt=self.conn.prep(&sql).map_err(error)?;
                    if !stmt.columns().is_empty(){return Ok(json!({"kind":"rows","result":self.run_query(original,options)?}));}
                }
                if ["begin","start","commit","rollback","savepoint","release","set"].contains(&keyword.as_str()){return Err(DriverError::unsupported("请使用事务API控制事务"));}
                let ddl=["create","drop","alter","truncate","rename","grant","revoke"].contains(&keyword.as_str());
                if ddl&&self.active{return Err(DriverError::unsupported("MySQL DDL会隐式提交，请先提交或回滚当前事务"));}
                if !ddl{self.begin()?;}let affected=self.execute(&sql,&values)?;if !ddl{self.pending+=affected;}
                Ok(if ddl{json!({"kind":"ddl","summary":"SQL已执行","affected":affected,"committed":true,"executedSql":sql,"elapsedMs":started.elapsed().as_millis()as u64})}else{json!({"kind":"affected","affected":affected,"inTransaction":self.active,"transactionState":n::transaction_state(self.active,self.pending),"executedSql":sql,"elapsedMs":started.elapsed().as_millis()as u64})})
            },
            "transactionState"=>Ok(n::transaction_state(self.active,self.pending)),
            "commitTransaction"|"rollbackTransaction"=>{
                if method=="commitTransaction"&&self.import_failed{return Err(DriverError::invalid("导入失败后禁止提交，必须回滚"));}
                if self.active{self.execute(if method=="commitTransaction"{"COMMIT"}else{"ROLLBACK"},&[])?;self.active=false;self.pending=0;}
                self.import_active=false;self.import_failed=false;self.import_next=0;self.import_target=None;Ok(n::transaction_state(self.active,self.pending))
            },
            "importBatch"=>{let result=self.import_batch(string_argument(&args,0,"tableId")?,args.get(1).ok_or_else(||DriverError::invalid("缺少导入批次"))?);if result.is_err()&&self.import_active{self.import_failed=true;}result},
            "resolveTransferSource"=>n::transfer_source(string_argument(&args,0,"nodeId")?,true),
            "insertRow"=>self.insert_row(string_argument(&args,0,"tableId")?,args.get(1).ok_or_else(||DriverError::invalid("缺少插入值"))?),
            "applyEdits"|"deleteRows"=>self.edit(method,string_argument(&args,0,"tableId")?,args.get(1).ok_or_else(||DriverError::invalid("缺少编辑值"))?),
            "countRows"=>{let sql=format!("SELECT COUNT(*) FROM {}",n::qualified(string_argument(&args,0,"tableId")?,true)?);let rows=self.query(&sql,&[])?;Ok(json!(rows[0].get::<u64,_>(0).ok_or_else(||DriverError::unsupported("计数超出范围"))?))},
            "tableSelectSql"=>Ok(json!(format!("SELECT * FROM {}",n::qualified(string_argument(&args,0,"tableId")?,true)?))),
            "createTable"|"createView"|"dropTable"|"dropView"|"renameTable"=>{
                if self.active{return Err(DriverError::unsupported("MySQL DDL会隐式提交，请先提交或回滚当前事务"));}
                let sql=match method{
                    "createTable"=>n::create_table_sql(args.first().ok_or_else(||DriverError::invalid("缺少建表规格"))?,true)?,
                    "createView"=>{let name=n::qualified_name(string_argument(&args,0,"viewName")?,true)?;let(sql,_)=n::bind_named(string_argument(&args,1,"sql")?,&Value::Null,false)?;if !["select","with"].contains(&sql.split_whitespace().next().unwrap_or("").to_ascii_lowercase().as_str()){return Err(DriverError::invalid("视图定义必须是查询"));}format!("CREATE VIEW {name} AS {sql}")},
                    "dropTable"|"dropView"=>{let id=string_argument(&args,0,"objectId")?;if (method=="dropTable"&&!id.starts_with("table:"))||(method=="dropView"&&!id.starts_with("view:")){return Err(DriverError::invalid("对象种类不匹配"));}format!("DROP {} {}",if method=="dropTable"{"TABLE"}else{"VIEW"},n::qualified(id,true)?)},
                    _=>{let id=string_argument(&args,0,"tableId")?;if !id.starts_with("table:"){return Err(DriverError::invalid("需要表ID"));}let(schema,_)=n::table_id(id)?;let name=string_argument(&args,1,"newName")?;if name.is_empty()||name.contains('\0'){return Err(DriverError::invalid("表名无效"));}format!("RENAME TABLE {} TO {}.{}",n::qualified(id,true)?,n::quote(&schema,true),n::quote(name,true))}
                };self.execute(&sql,&[])?;self.cursors.clear();Ok(Value::Null)
            },
            "indexTable"=>{
                // 索引变更也是 ALTER TABLE，同样会隐式提交事务。
                if self.active{return Err(DriverError::unsupported("MySQL DDL会隐式提交，请先提交或回滚当前事务"));}
                let id=string_argument(&args,0,"tableId")?;
                if !id.starts_with("table:"){return Err(DriverError::invalid("需要表ID"));}
                let sql=n::index_ddl(&id,args.get(1).ok_or_else(||DriverError::invalid("缺少索引变更规格"))?)?;
                self.execute(&sql,&[])?;self.cursors.clear();
                Ok(json!({"executedSql":sql,"committed":true}))
            },
            "partitionTable"=>{
                // Partition DDL is ALTER TABLE, so it shares the implicit-commit rule:
                // never run it inside a managed transaction.
                if self.active{return Err(DriverError::unsupported("MySQL DDL会隐式提交，请先提交或回滚当前事务"));}
                let id=string_argument(&args,0,"tableId")?;
                if !id.starts_with("table:"){return Err(DriverError::invalid("需要表ID"));}
                let sql=n::partition_ddl(&id,args.get(1).ok_or_else(||DriverError::invalid("缺少分区变更规格"))?)?;
                self.execute(&sql,&[])?;self.cursors.clear();
                Ok(json!({"executedSql":sql,"committed":true}))
            },
            "createDatabase"=>{
                // 建库是 DDL：隐式提交事务，所以与存在事务时拒绝。
                if self.active{return Err(DriverError::unsupported("MySQL DDL会隐式提交，请先提交或回滚当前事务"));}
                let name=string_argument(&args,0,"database")?;
                let name=n::database_name(name)?;
                let if_not_exists=args.get(1).and_then(Value::as_bool).unwrap_or(false);
                let sql=if if_not_exists{format!("CREATE DATABASE IF NOT EXISTS {}",n::quote(&name,true))}else{format!("CREATE DATABASE {}",n::quote(&name,true))};
                self.execute(&sql,&[])?;
                Ok(json!({"executedSql":sql,"committed":true}))
            },
            "createUser"=>{
                // 用户管理写操作：账号名与主机走白名单，只接受合法标识符，不接受任何嵌入片段。
                if self.active{return Err(DriverError::unsupported("MySQL DDL会隐式提交，请先提交或回滚当前事务"));}
                let user=string_argument(&args,0,"user")?;
                let host=args.get(1).and_then(Value::as_str).unwrap_or("%");
                let user=n::account_name(user)?;
                let host=n::account_host(host)?;
                let password=args.get(2).and_then(Value::as_str).unwrap_or("");
                let account=format!("{}@{}",n::quote(&user,true),n::quote(&host,true));
                let mut sql=format!("CREATE USER {account}");
                if !password.is_empty(){sql.push_str(&format!(" IDENTIFIED BY {}",n::string_literal(password)));}
                self.execute(&sql,&[])?;
                Ok(json!({"executedSql":format!("CREATE USER {account}"),"committed":true}))
            },
            "dropUser"=>{
                if self.active{return Err(DriverError::unsupported("MySQL DDL会隐式提交，请先提交或回滚当前事务"));}
                let user=string_argument(&args,0,"user")?;
                let host=args.get(1).and_then(Value::as_str).unwrap_or("%");
                let account=format!("{}@{}",n::quote(&n::account_name(user)?,true),n::quote(&n::account_host(host)?,true));
                let sql=format!("DROP USER IF EXISTS {account}");
                self.execute(&sql,&[])?;
                Ok(json!({"executedSql":format!("DROP USER IF EXISTS {account}"),"committed":true}))
            },
            "grantPrivilege"=>{
                if self.active{return Err(DriverError::unsupported("MySQL DDL会隐式提交，请先提交或回滚当前事务"));}
                let user=string_argument(&args,0,"user")?;
                let host=args.get(1).and_then(Value::as_str).unwrap_or("%");
                let privileges=args.get(2).ok_or_else(||DriverError::invalid("缺少权限列表"))?;
                let scope=args.get(3).ok_or_else(||DriverError::invalid("缺少授权范围"))?;
                let account=format!("{}@{}",n::quote(&n::account_name(user)?,true),n::quote(&n::account_host(host)?,true));
                let list=n::privilege_list(privileges)?;
                let target=n::privilege_target(scope)?;
                let mut sql=format!("GRANT {list} ON {target} TO {account}");
                if args.get(4).and_then(Value::as_bool).unwrap_or(false){sql.push_str(" WITH GRANT OPTION");}
                self.execute(&sql,&[])?;
                Ok(json!({"executedSql":sql,"committed":true}))
            },
            "revokePrivilege"=>{
                if self.active{return Err(DriverError::unsupported("MySQL DDL会隐式提交，请先提交或回滚当前事务"));}
                let user=string_argument(&args,0,"user")?;
                let host=args.get(1).and_then(Value::as_str).unwrap_or("%");
                let privileges=args.get(2).ok_or_else(||DriverError::invalid("缺少权限列表"))?;
                let scope=args.get(3).ok_or_else(||DriverError::invalid("缺少授权范围"))?;
                let account=format!("{}@{}",n::quote(&n::account_name(user)?,true),n::quote(&n::account_host(host)?,true));
                let list=n::privilege_list(privileges)?;
                let target=n::privilege_target(scope)?;
                let sql=format!("REVOKE {list} ON {target} FROM {account}");
                self.execute(&sql,&[])?;
                Ok(json!({"executedSql":sql,"committed":true}))
            },
            "lineageEvidence"=>{
                // 字段血缘的证据来源：外键、列清单、视图定义，全部只读。
                // 只取与目标表相关的对象，避免在大库上做全量拉取。
                let request = args.first().cloned().unwrap_or_else(|| json!({}));
                let table = request.get("table").and_then(Value::as_str).unwrap_or("").trim();
                let column = request.get("column").and_then(Value::as_str).unwrap_or("").trim();
                if table.is_empty() || column.is_empty() {
                    return Err(DriverError::invalid("缺少表名或列名"));
                }
                let schema = request.get("schema").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
                if let Some(name) = schema {
                    n::database_name(name)?;
                }
                let scope_arg = schema.map(|value| json!(value)).unwrap_or(Value::Null);
                let text_at = |row: &Row, index: usize| -> Option<String> {
                    let raw = row.as_ref(index)?;
                    let column = &row.columns_ref()[index];
                    match cell(raw, column, false).ok()? {
                        Value::String(text) => Some(text),
                        Value::Null => None,
                        other => other
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .or_else(|| other.get("value").map(|value| value.to_string())),
                    }
                };

                // 1) 外键：先找当前列作为子列的出边，再找作为父列的入边。
                let mut foreign_keys: Vec<Value> = Vec::new();
                let outgoing = self.query(
                    "SELECT TABLE_SCHEMA,TABLE_NAME,CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,\
                            REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
                     WHERE REFERENCED_TABLE_NAME IS NOT NULL \
                       AND (? IS NULL OR TABLE_SCHEMA = ?) AND TABLE_NAME = ? AND COLUMN_NAME = ?",
                    &[scope_arg.clone(), scope_arg.clone(), json!(table), json!(column)],
                )?;
                for row in &outgoing {
                    foreign_keys.push(json!({
                        "direction": "outgoing",
                        "schema": text_at(row, 0).unwrap_or_default(),
                        "table": text_at(row, 1).unwrap_or_default(),
                        "name": text_at(row, 2).unwrap_or_default(),
                        "column": text_at(row, 3).unwrap_or_default(),
                        "refSchema": text_at(row, 4).unwrap_or_default(),
                        "refTable": text_at(row, 5).unwrap_or_default(),
                        "refColumn": text_at(row, 6).unwrap_or_default(),
                    }));
                }
                let incoming = self.query(
                    "SELECT TABLE_SCHEMA,TABLE_NAME,CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,\
                            REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
                     WHERE REFERENCED_TABLE_NAME IS NOT NULL \
                       AND (? IS NULL OR REFERENCED_TABLE_SCHEMA = ?) AND REFERENCED_TABLE_NAME = ? AND REFERENCED_COLUMN_NAME = ?",
                    &[scope_arg.clone(), scope_arg.clone(), json!(table), json!(column)],
                )?;
                for row in &incoming {
                    foreign_keys.push(json!({
                        "direction": "incoming",
                        "schema": text_at(row, 0).unwrap_or_default(),
                        "table": text_at(row, 1).unwrap_or_default(),
                        "name": text_at(row, 2).unwrap_or_default(),
                        "column": text_at(row, 3).unwrap_or_default(),
                        "refSchema": text_at(row, 4).unwrap_or_default(),
                        "refTable": text_at(row, 5).unwrap_or_default(),
                        "refColumn": text_at(row, 6).unwrap_or_default(),
                    }));
                }

                // 2) 全部表的列清单：只取列名，用于同名推测与视图范围判断。
                let columns = self.query(
                    "SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys') \
                       AND (? IS NULL OR TABLE_SCHEMA = ?) \
                     ORDER BY TABLE_SCHEMA,TABLE_NAME,ORDINAL_POSITION LIMIT 5000",
                    &[scope_arg.clone(), scope_arg.clone()],
                )?;
                let mut tables: Vec<Value> = Vec::new();
                let mut current: Option<(String, String, Vec<String>)> = None;
                for row in &columns {
                    let schema_name = text_at(row, 0).unwrap_or_default();
                    let table_name = text_at(row, 1).unwrap_or_default();
                    let column_name = text_at(row, 2).unwrap_or_default();
                    match current.take() {
                        Some((open_schema, open_table, mut list))
                            if open_schema == schema_name && open_table == table_name =>
                        {
                            list.push(column_name);
                            current = Some((open_schema, open_table, list));
                        }
                        Some((open_schema, open_table, list)) => {
                            tables.push(json!({"schema": open_schema, "name": open_table, "columns": list}));
                            current = Some((schema_name, table_name, vec![column_name]));
                        }
                        None => current = Some((schema_name, table_name, vec![column_name])),
                    }
                }
                if let Some((open_schema, open_table, list)) = current {
                    tables.push(json!({"schema": open_schema, "name": open_table, "columns": list}));
                }
                // 把外键挂回各自的表。
                for table_item in tables.iter_mut() {
                    let schema_name = table_item["schema"].as_str().unwrap_or_default().to_owned();
                    let table_name = table_item["name"].as_str().unwrap_or_default().to_owned();
                    let keys: Vec<Value> = foreign_keys
                        .iter()
                        .filter(|key| key["schema"] == json!(schema_name) && key["table"] == json!(table_name))
                        .cloned()
                        .collect();
                    if !keys.is_empty() {
                        table_item["foreignKeys"] = json!(keys);
                    }
                }

                // 3) 视图定义：只取当前库或指定库的视图。
                let view_rows = self.query(
                    "SELECT TABLE_SCHEMA,TABLE_NAME,VIEW_DEFINITION FROM information_schema.VIEWS \
                     WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys') \
                       AND (? IS NULL OR TABLE_SCHEMA = ?) \
                     ORDER BY TABLE_SCHEMA,TABLE_NAME LIMIT 1000",
                    &[scope_arg.clone(), scope_arg.clone()],
                )?;
                let views: Vec<Value> = view_rows
                    .iter()
                    .map(|row| {
                        json!({
                            "schema": text_at(row, 0).unwrap_or_default(),
                            "name": text_at(row, 1).unwrap_or_default(),
                            "ddl": text_at(row, 2).unwrap_or_default(),
                        })
                    })
                    .filter(|view| !view["ddl"].as_str().unwrap_or_default().is_empty())
                    .collect();

                Ok(json!({
                    "target": {"schema": schema, "table": table, "column": column},
                    "tables": tables,
                    "views": views,
                    "foreignKeys": foreign_keys,
                }))
            },
            "searchObjects"=>{
                // 信息架构的文本列可能以 Bytes 返回，统一走 cell() 取文本。
                let text_at = |row: &Row, index: usize| -> Option<String> {
                    let raw = row.as_ref(index)?;
                    let column = &row.columns_ref()[index];
                    // 源码与定义类字段必须取全量，否则超长文本会被截断。
                    match cell(raw, column, true).ok()? {
                        Value::String(text) => Some(text),
                        Value::Null => None,
                        other => other
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .or_else(|| other.get("value").map(|value| value.to_string())),
                    }
                };
                // 模式搜索：每条查询都带 LIMIT，避免在信息架构上做无界扫描；
                // 关键字与库名一律走绑定参数，不拼进 SQL 文本。
                let request = args.first().cloned().unwrap_or_else(|| json!({}));
                let keyword = request.get("keyword").and_then(Value::as_str).unwrap_or("").trim();
                if keyword.is_empty() {
                    return Err(DriverError::invalid("请输入搜索关键字"));
                }
                if keyword.len() > 128 {
                    return Err(DriverError::invalid("搜索关键字过长"));
                }
                let limit = request.get("limit").and_then(Value::as_u64).unwrap_or(200).clamp(1, 500);
                let requested: Vec<String> = request
                    .get("kinds")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect())
                    .unwrap_or_else(|| vec!["table".to_owned(), "view".to_owned(), "column".to_owned(), "routine".to_owned(), "trigger".to_owned()]);
                for kind in &requested {
                    if !matches!(kind.as_str(), "table" | "view" | "column" | "routine" | "trigger") {
                        return Err(DriverError::invalid("不支持的搜索对象类型"));
                    }
                }
                let wants = |kind: &str| requested.iter().any(|item| item == kind);
                let schema = request.get("schema").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
                if let Some(name) = schema {
                    n::database_name(name)?;
                }
                // LIKE 通配符转义：用户输入的 % 与 _ 按字面量搜索。
                let escaped = keyword.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
                let pattern = format!("%{escaped}%");
                let scope_arg = schema.map(|value| json!(value)).unwrap_or(Value::Null);
                let mut items: Vec<Value> = Vec::new();
                // 任一类查询拿满 limit 就说明可能还有更多结果。
                let mut counts_hit_limit = false;

                if wants("table") || wants("view") {
                    let rows = self.query(
                        "SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES \
                         WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys') \
                           AND (? IS NULL OR TABLE_SCHEMA = ?) AND TABLE_NAME LIKE ? \
                         ORDER BY TABLE_SCHEMA,TABLE_NAME LIMIT ?",
                        &[scope_arg.clone(), scope_arg.clone(), json!(pattern), json!(limit)],
                    )?;
                    if rows.len() >= limit as usize { counts_hit_limit = true; }
                    for row in &rows {
                        let schema_name = text_at(row, 0).unwrap_or_default();
                        let name = text_at(row, 1).unwrap_or_default();
                        let is_view = text_at(row, 2).unwrap_or_default().to_ascii_uppercase().contains("VIEW");
                        if is_view != wants("view") && !is_view {
                            if !wants("table") { continue; }
                        }
                        if is_view && !wants("view") { continue; }
                        let kind = if is_view { "view" } else { "table" };
                        items.push(json!({
                            "kind": kind,
                            "schema": schema_name,
                            "name": name,
                            "nodeId": format!("{kind}:{}.{}", n::escape_id(&schema_name), n::escape_id(&name)),
                        }));
                    }
                }

                if wants("column") {
                    let rows = self.query(
                        "SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS \
                         WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys') \
                           AND (? IS NULL OR TABLE_SCHEMA = ?) AND COLUMN_NAME LIKE ? \
                         ORDER BY TABLE_SCHEMA,TABLE_NAME,ORDINAL_POSITION LIMIT ?",
                        &[scope_arg.clone(), scope_arg.clone(), json!(pattern), json!(limit)],
                    )?;
                    if rows.len() >= limit as usize { counts_hit_limit = true; }
                    // 列所属对象可能是视图，不能一律标成 table。
                    let view_keys: Vec<(String, String)> = self
                        .query(
                            "SELECT TABLE_SCHEMA,TABLE_NAME FROM information_schema.TABLES WHERE TABLE_TYPE = 'VIEW' AND (? IS NULL OR TABLE_SCHEMA = ?) LIMIT 5000",
                            &[scope_arg.clone(), scope_arg.clone()],
                        )
                        .map(|rows| {
                            rows.iter()
                                .map(|row| (text_at(row, 0).unwrap_or_default(), text_at(row, 1).unwrap_or_default()))
                                .collect()
                        })
                        .unwrap_or_default();
                    for row in &rows {
                        let schema_name = text_at(row, 0).unwrap_or_default();
                        let table = text_at(row, 1).unwrap_or_default();
                        let owner_kind = if view_keys.iter().any(|(s, t)| s == &schema_name && t == &table) { "view" } else { "table" };
                        items.push(json!({
                            "kind": "column",
                            "schema": schema_name,
                            "table": table,
                            "name": text_at(row, 2).unwrap_or_default(),
                            "columnType": text_at(row, 3).unwrap_or_default(),
                            "nodeId": format!("{owner_kind}:{}.{}", n::escape_id(&schema_name), n::escape_id(&table)),
                        }));
                    }
                }

                if wants("routine") {
                    let rows = self.query(
                        "SELECT ROUTINE_SCHEMA,ROUTINE_NAME,ROUTINE_TYPE FROM information_schema.ROUTINES \
                         WHERE (? IS NULL OR ROUTINE_SCHEMA = ?) AND ROUTINE_NAME LIKE ? \
                         ORDER BY ROUTINE_SCHEMA,ROUTINE_NAME LIMIT ?",
                        &[scope_arg.clone(), scope_arg.clone(), json!(pattern), json!(limit)],
                    )?;
                    if rows.len() >= limit as usize { counts_hit_limit = true; }
                    for row in &rows {
                        let schema_name = text_at(row, 0).unwrap_or_default();
                        let name = text_at(row, 1).unwrap_or_default();
                        let routine_type = text_at(row, 2).unwrap_or_else(|| "PROCEDURE".to_owned());
                        items.push(json!({
                            "kind": "routine",
                            "schema": schema_name,
                            "name": name,
                            "routineType": routine_type.clone(),
                            "nodeId": format!("routine:{}.{}.{}", n::escape_id(&schema_name), routine_type, n::escape_id(&name)),
                        }));
                    }
                }

                if wants("trigger") {
                    let rows = self.query(
                        "SELECT TRIGGER_SCHEMA,TRIGGER_NAME,EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS \
                         WHERE (? IS NULL OR TRIGGER_SCHEMA = ?) AND TRIGGER_NAME LIKE ? \
                         ORDER BY TRIGGER_SCHEMA,TRIGGER_NAME LIMIT ?",
                        &[scope_arg.clone(), scope_arg.clone(), json!(pattern), json!(limit)],
                    )?;
                    if rows.len() >= limit as usize { counts_hit_limit = true; }
                    for row in &rows {
                        let schema_name = text_at(row, 0).unwrap_or_default();
                        let name = text_at(row, 1).unwrap_or_default();
                        items.push(json!({
                            "kind": "trigger",
                            "schema": schema_name,
                            "name": name,
                            "table": text_at(row, 2).unwrap_or_default(),
                            "nodeId": format!("trigger:{}.{}", n::escape_id(&schema_name), n::escape_id(&name)),
                        }));
                    }
                }

                let truncated = items.len() > limit as usize || counts_hit_limit;
                items.truncate(limit as usize);
                Ok(json!({"keyword": keyword, "items": items, "truncated": truncated}))
            },
            "objectSource"=>{
                // 信息架构的文本列可能以 Bytes 返回，直接转字符串会 panic；
                // 所以先经驱动的 cell() 转成 JSON再取文本。
                let text_at=|row:&Row,index:usize|->Option<String>{let raw=row.as_ref(index)?;let column=&row.columns_ref()[index];match cell(raw,column,true).ok()?{Value::String(text)=>Some(text),Value::Null=>None,other=>other.get("text").and_then(Value::as_str).map(str::to_owned).or_else(||other.get("value").map(|v|v.to_string()))}};
                // 对象源码只读：视图、例程、触发器各自读对应的 information_schema 列。
                let node=string_argument(&args,0,"nodeId")?;
                let(kind,rest)=node.split_once(':').ok_or_else(||DriverError::invalid("对象ID无效"))?;
                let parts=n::unescape_parts(rest)?;
                match kind{
                    "view"=>{
                        if parts.len()!=2{return Err(DriverError::invalid("视图ID无效"));}
                        let rows=self.query("SELECT VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",&[json!(parts[0]),json!(parts[1])])?;
                        let sql:Option<String>=rows.first().and_then(|row|text_at(row,0));
                        let sql=sql.ok_or_else(||DriverError::new("not-found","视图不存在或无权限读取定义"))?;
                        Ok(json!({"kind":"view","schema":parts[0],"name":parts[1],"sql":format!("CREATE VIEW {}.{} AS {}",n::quote(&parts[0],true),n::quote(&parts[1],true),sql)}))
                    }
                    "routine"=>{
                        if parts.len()!=3{return Err(DriverError::invalid("例程ID无效"));}
                        let rows=self.query("SELECT ROUTINE_TYPE,ROUTINE_DEFINITION,IS_DETERMINISTIC,SQL_DATA_ACCESS,SECURITY_TYPE,DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? AND ROUTINE_NAME=? AND ROUTINE_TYPE=?",&[json!(parts[0]),json!(parts[2]),json!(parts[1].to_ascii_uppercase())])?;
                        let row=rows.first().ok_or_else(||DriverError::new("not-found","例程不存在"))?;
                        let definition:Option<String>=text_at(row,1);
                        let definition=definition.ok_or_else(||DriverError::new("not-found","无权限读取例程源码"))?;
                        Ok(json!({"kind":"routine","schema":parts[0],"routineType":text_at(row,0),"name":parts[2],"deterministic":text_at(row,2),"dataAccess":text_at(row,3),"security":text_at(row,4),"definer":text_at(row,5),"definition":definition}))
                    }
                    "trigger"=>{
                        if parts.len()!=2{return Err(DriverError::invalid("触发器ID无效"));}
                        let rows=self.query("SELECT ACTION_TIMING,EVENT_MANIPULATION,ACTION_ORDER,ACTION_STATEMENT,EVENT_OBJECT_TABLE,DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? AND TRIGGER_NAME=?",&[json!(parts[0]),json!(parts[1])])?;
                        let row=rows.first().ok_or_else(||DriverError::new("not-found","触发器不存在"))?;
                        Ok(json!({"kind":"trigger","schema":parts[0],"name":parts[1],"timing":text_at(row,0),"event":text_at(row,1),"order":text_at(row,2),"statement":text_at(row,3),"table":text_at(row,4),"definer":row.get::<Option<String>,_>(5).flatten()}))
                    }
                    _=>Err(DriverError::unsupported("不支持读取该对象类型的源码")),
                }
            },
            "listSessions"=>{
                // 会话管理是只读操作：只返回 PROCESSLIST 内容，不披露其他库的敏感信息。
                let rows=self.query("SELECT ID,USER,HOST,DB,COMMAND,TIME,STATE,INFO FROM information_schema.PROCESSLIST ORDER BY ID",&[])?;
                let current:u64=u64::from(self.conn.connection_id());
                // 信息架构的文本列可能以 Bytes 返回，直接转 String 会 panic；走 cell() 取文本。
                let text_at=|row:&Row,index:usize|->Option<String>{let raw=row.as_ref(index)?;let column=&row.columns_ref()[index];match cell(raw,column,true).ok()?{Value::String(text)=>Some(text),Value::Null=>None,other=>other.get("text").and_then(Value::as_str).map(str::to_owned).or_else(||other.get("value").map(|value|value.to_string()))}};
                Ok(json!(rows.iter().map(|row|{
                    let id:u64=row.get(0).unwrap_or(0);
                    json!({"id":id,"user":text_at(row,1).unwrap_or_default(),"host":text_at(row,2).unwrap_or_default(),"database":text_at(row,3),"command":text_at(row,4).unwrap_or_default(),"seconds":row.get::<Option<u64>,_>(5).flatten().unwrap_or(0),"state":text_at(row,6),"info":text_at(row,7),"current":id==current})
                }).collect::<Vec<_>>()))
            },
            "killSession"=>{
                let target=args.first().and_then(Value::as_u64).ok_or_else(||DriverError::invalid("会话 ID 无效"))?;
                // 不允许终止当前连接：那会让调用方把自己掉下去，而是真正想停的查询可能在另一个连接上。
                let current=u64::from(self.conn.connection_id());
                if target==current{return Err(DriverError::invalid("不能终止当前会话"));}
                self.execute(&format!("KILL {}",target),&[])?;
                Ok(json!({"killed":target}))
            },
            "listEvents"=>{
                // EVENT 是 MySQL 的调度对象：DBeaver 有对应节点，这里只读元数据，不执行写。
                let schema=args.first().and_then(|v|v.get("schema")).and_then(Value::as_str);
                let rows=self.query("SELECT EVENT_SCHEMA,EVENT_NAME,STATUS,EVENT_TYPE,INTERVAL_VALUE,INTERVAL_FIELD,LAST_EXECUTED,STARTS,ENDS,EVENT_DEFINITION FROM information_schema.EVENTS WHERE (? IS NULL OR EVENT_SCHEMA=?) ORDER BY EVENT_SCHEMA,EVENT_NAME",&[schema.map(|s|json!(s)).unwrap_or(Value::Null),schema.map(|s|json!(s)).unwrap_or(Value::Null)])?;
                // INTERVAL_VALUE 在真实库里是数值类型，直接按字符串取会崩溃。
                // 所以先取原值再统一转成字符串，对外保持字符串形态不变。
                let as_text=|value:Option<Value>|value.map(|v|match v{Value::String(s)=>s,Value::Null=>String::new(),other=>other.to_string()}).filter(|s|!s.is_empty());
                // information_schema.EVENTS 的部分列（例如 INTERVAL_FIELD）会以
                // Bytes 类型返回，直接转 Option<Value> 会 panic。所以走驱动
                // 已有的 cell() 转换，再从 JSON 里取文本。
                let text_of=|row:&Row,index:usize|->Option<String>{
                    let raw=row.as_ref(index)?;
                    let column=&row.columns_ref()[index];
                    match cell(raw,column,true).ok()?{
                        Value::String(text)=>Some(text),
                        Value::Null=>None,
                        other=>{let text=other.get("text").and_then(Value::as_str).map(str::to_owned).or_else(||other.get("value").map(|v|v.to_string()));text}
                    }
                };
                let scheduler:Option<String>=self.query("SELECT @@global.event_scheduler",&[]).ok().and_then(|rows|rows.first().and_then(|row|row.get::<Option<String>,_>(0).flatten()));
                Ok(json!({"scheduler":scheduler,"items":rows.iter().map(|row|json!({
                    "schema":text_of(row,0).unwrap_or_default(),
                    "name":text_of(row,1).unwrap_or_default(),
                    "status":text_of(row,2),
                    "eventType":text_of(row,3),
                    "intervalValue":text_of(row,4),
                    "intervalField":text_of(row,5),
                    "lastExecuted":text_of(row,6),
                    "starts":text_of(row,7),
                    "ends":text_of(row,8),
                    "definition":text_of(row,9),
                })).collect::<Vec<_>>()}))
            },
            "listUsers"=>{
                // 用户列表不返回口令或密码哈希，只给账号与权限摘要。
                let users=self.query("SELECT User,Host,account_locked,plugin,password_expired FROM mysql.user ORDER BY User,Host",&[])?;
                let privileges=self.query("SELECT GRANTEE,PRIVILEGE_TYPE,IS_GRANTABLE FROM information_schema.USER_PRIVILEGES ORDER BY GRANTEE,PRIVILEGE_TYPE",&[])?;
                // 用户与权限表的文本列同样可能以 Bytes 返回，统一走 cell()。
                let text_at=|row:&Row,index:usize|->Option<String>{let raw=row.as_ref(index)?;let column=&row.columns_ref()[index];match cell(raw,column,true).ok()?{Value::String(text)=>Some(text),Value::Null=>None,other=>other.get("text").and_then(Value::as_str).map(str::to_owned).or_else(||other.get("value").map(|value|value.to_string()))}};
                Ok(json!({
                    "users":users.iter().map(|row|json!({
                        "user":text_at(row,0).unwrap_or_default(),
                        "host":text_at(row,1).unwrap_or_default(),
                        "locked":text_at(row,2).as_deref()==Some("Y"),
                        "plugin":text_at(row,3),
                        "passwordExpired":text_at(row,4).as_deref()==Some("Y"),
                    })).collect::<Vec<_>>(),
                    "privileges":privileges.iter().map(|row|json!({
                        "grantee":text_at(row,0).unwrap_or_default(),
                        "privilege":text_at(row,1).unwrap_or_default(),
                        "grantable":text_at(row,2).as_deref()==Some("YES"),
                    })).collect::<Vec<_>>(),
                }))
            },
            "cancelQuery"=>Ok(json!((self.cancel)()?)),
            _=>Err(DriverError::unsupported("MySQL方法尚未迁移到Rust"))
        }
    }
}

#[cfg(test)]
mod session_timezone_tests {
    use super::is_session_timezone_offset_statement;

    #[test]
    fn accepts_explicit_session_timezone_offset_literals(){
        for sql in ["SET SESSION time_zone = '+08:00'","set session TIME_ZONE='-05:30'","  SeT\tSESSION\ntime_zone = '+00:00' ;  "]{
            assert!(is_session_timezone_offset_statement(sql),"{sql}");
        }
    }
    #[test]
    fn retains_other_set_and_transaction_guards(){
        for sql in ["SET GLOBAL time_zone = '+08:00'","SET @@session.time_zone = '+08:00'","SET time_zone = '+08:00'","SET SESSION autocommit = 0","SET autocommit = 1","SET NAMES utf8mb4","BEGIN","COMMIT","ROLLBACK","SET SESSION time_zone = ?","SET SESSION time_zone = 'Asia/Shanghai'"]{
            assert!(!is_session_timezone_offset_statement(sql),"{sql}");
        }
    }
    #[test]
    fn rejects_extra_statements_tokens_and_malformed_literals(){
        for sql in ["SET SESSION time_zone = '+08:00'; COMMIT","SET SESSION time_zone = '+08:00';;","SET SESSION time_zone = '+08:00' -- suffix","SET SESSION time_zone = '+08:00', autocommit = 0","SET SESSION time_zone = '+08:00' OR 1","SET SESSION time_zone = '+8:00'","SET SESSION time_zone = '+08:0x'","SET SESSION time_zone = '+08:00\\'x'","SET SESSION time_zone = \"+08:00\"","SET /* comment */ SESSION time_zone = '+08:00'"]{
            assert!(!is_session_timezone_offset_statement(sql),"{sql}");
        }
    }
}

#[cfg(test)]
mod temporal_cell_tests {
    use super::{cell,MValue};
    use mysql::consts::ColumnType;
    use serde_json::json;

    #[test]
    fn date_cell_preserves_date_only_and_datetime_microseconds(){
        for full in [false,true]{
            for kind in [ColumnType::MYSQL_TYPE_DATETIME,ColumnType::MYSQL_TYPE_TIMESTAMP]{
                let column=mysql::Column::new(kind);
                assert_eq!(cell(&MValue::Date(2024,2,29,12,34,56,1),&column,full).unwrap(),json!({"kind":"text","text":"2024-02-29 12:34:56.000001"}));
            }
            let column=mysql::Column::new(ColumnType::MYSQL_TYPE_DATE);
            assert_eq!(cell(&MValue::Date(2024,2,29,0,0,0,0),&column,full).unwrap(),json!({"kind":"text","text":"2024-02-29"}));
        }
    }
    #[test]
    fn time_cell_preserves_hour_padding_sign_days_and_microseconds(){
        let column=mysql::Column::new(ColumnType::MYSQL_TYPE_TIME);
        for full in [false,true]{
            for (value,text) in [
                (MValue::Time(true,1,1,2,3,2),"-25:02:03.000002"),
                (MValue::Time(false,2,1,3,4,999998),"49:03:04.999998"),
                (MValue::Time(false,0,1,2,3,3),"01:02:03.000003"),
                (MValue::Time(true,0,2,3,4,999997),"-02:03:04.999997"),
                (MValue::Time(false,0,0,0,0,1),"00:00:00.000001")
            ]{
                assert_eq!(cell(&value,&column,full).unwrap(),json!({"kind":"text","text":text}));
            }
        }
    }
}

#[cfg(test)]
mod column_type_metadata_tests {
    use super::management_columns;
    use mysql::consts::ColumnType;
    use serde_json::json;

    fn metadata_type(column_type:ColumnType,character_set:u16)->serde_json::Value{
        let column=mysql::Column::new(column_type).with_character_set(character_set);
        management_columns(&[column])[0]["type"].clone()
    }

    #[test]
    fn time_result_metadata_is_text_without_weakening_binary_columns(){
        assert_eq!(metadata_type(ColumnType::MYSQL_TYPE_TIME,63),json!("text"));
        assert_eq!(metadata_type(ColumnType::MYSQL_TYPE_BLOB,63),json!("blob"));
        assert_eq!(metadata_type(ColumnType::MYSQL_TYPE_VAR_STRING,63),json!("blob"));
        assert_eq!(metadata_type(ColumnType::MYSQL_TYPE_VAR_STRING,45),json!("text"));
        for kind in [ColumnType::MYSQL_TYPE_DATE,ColumnType::MYSQL_TYPE_DATETIME,ColumnType::MYSQL_TYPE_TIMESTAMP]{
            assert_eq!(metadata_type(kind,63),json!("date"));
        }
    }
}
