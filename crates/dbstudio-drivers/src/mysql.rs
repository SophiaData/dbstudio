//! Native synchronous MySQL/MariaDB driver. No JS/Node forwarding.
use dbstudio_protocol::{CancelHandle,ConnectionConfig,Driver,DriverError,DriverResult,SecretMap,string_argument};
use mysql::{Conn,Opts,OptsBuilder,Params,Row,SslOpts,Value as MValue,prelude::Queryable};
use serde_json::{json,Value};
use base64::{engine::general_purpose::STANDARD,Engine};
use crate::{network as n,tls::{self,TlsMode},tunnel::{self,SshTunnel}};
use std::{collections::HashMap,net::{IpAddr,Ipv4Addr,Ipv6Addr,SocketAddr,ToSocketAddrs},sync::{Arc,atomic::{AtomicBool,Ordering}},time::Instant};

fn error(error:mysql::Error)->DriverError{
    match error {
        mysql::Error::MySqlError(e)=>{
            if e.code==1317{return DriverError::new("cancelled","MySQL操作已取消");}
            DriverError::new("driver-error",format!("MySQL操作失败(SQLSTATE {}, code {})",e.state,e.code))
        },_=>DriverError::new("connection_failed","MySQL连接或协议操作失败")
    }
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
fn cell(value:&MValue,column:&mysql::Column,full:bool)->DriverResult<Value>{
    let number=|v:f64|if v.is_finite(){json!({"kind":"number","value":v})}else{n::text_cell(&v.to_string(),full)};
    Ok(match value {
        MValue::NULL=>json!({"kind":"null"}),
        MValue::Int(v)=>if v.unsigned_abs()>9_007_199_254_740_991{n::text_cell(&v.to_string(),full)}else{json!({"kind":"number","value":v})},
        MValue::UInt(v)=>if *v>9_007_199_254_740_991{n::text_cell(&v.to_string(),full)}else{json!({"kind":"number","value":v})},
        MValue::Float(v)=>number(*v as f64),MValue::Double(v)=>number(*v),
        MValue::Bytes(v)=>if column.character_set()==63&&!matches!(column.column_type(),mysql::consts::ColumnType::MYSQL_TYPE_DECIMAL|mysql::consts::ColumnType::MYSQL_TYPE_NEWDECIMAL|mysql::consts::ColumnType::MYSQL_TYPE_JSON){n::blob_cell(v,full)}else{n::text_cell(std::str::from_utf8(v).map_err(|_|DriverError::unsupported("文本编码不是UTF8"))?,full)},
        MValue::Date(y,m,d,h,min,s,micros)=>n::text_cell(&format!("{y:04}-{m:02}-{d:02} {h:02}:{min:02}:{s:02}.{micros:06}"),full),
        MValue::Time(neg,days,h,m,s,micros)=>n::text_cell(&format!("{}{}:{m:02}:{s:02}.{micros:06}",if *neg{"-"}else{""},(*days as u64)*24+*h as u64),full)
    })
}
struct Cursor {sql:String,values:Vec<Value>}
pub struct MysqlDriver {conn:Conn,cursors:HashMap<String,Cursor>,sequence:u64,active:bool,pending:u64,import_active:bool,import_failed:bool,import_next:u64,import_target:Option<String>,running:Arc<AtomicBool>,cancel:CancelHandle,_tunnel:Option<SshTunnel>}
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
        .db_name(Some(database)).ssl_opts(ssl).tcp_connect_timeout(Some(n::timeout())).read_timeout(Some(n::timeout())).write_timeout(Some(n::timeout())).prefer_socket(false));
    let mut conn=connect_options(&opts).map_err(error)?;conn.query_drop("SET NAMES utf8mb4").map_err(error)?;
    let id=conn.connection_id();let running=Arc::new(AtomicBool::new(false));let flag=running.clone();
    let cancel:CancelHandle=Arc::new(move||{
        if !flag.load(Ordering::SeqCst){return Ok(false);}let mut control=connect_options(&opts).map_err(error)?;
        control.query_drop(format!("KILL QUERY {id}")).map_err(error)?;Ok(true)
    });
    Ok(Box::new(MysqlDriver{conn,cursors:HashMap::new(),sequence:0,active:false,pending:0,import_active:false,import_failed:false,import_next:0,import_target:None,running,cancel,_tunnel:tunnel}))
}
impl MysqlDriver {
    fn query(&mut self,sql:&str,values:&[Value])->DriverResult<Vec<Row>>{
        let params=params(values)?;self.running.store(true,Ordering::SeqCst);let result=self.conn.exec(sql,params).map_err(error);self.running.store(false,Ordering::SeqCst);result
    }
    fn execute(&mut self,sql:&str,values:&[Value])->DriverResult<u64>{
        let params=params(values)?;self.running.store(true,Ordering::SeqCst);
        // COM_STMT_PREPARE does not support all transaction/savepoint control statements.
        // Values remain bound with exec_drop; static/control SQL uses COM_QUERY.
        let result=if values.is_empty(){self.conn.query_drop(sql)}else{self.conn.exec_drop(sql,params)}.map_err(error);
        self.running.store(false,Ordering::SeqCst);result?;Ok(self.conn.affected_rows())
    }
    fn begin(&mut self)->DriverResult<()>{if !self.active{self.execute("START TRANSACTION",&[])?;self.active=true;self.pending=0;}Ok(())}
    fn page(&mut self,sql:&str,values:&[Value],offset:usize,limit:usize)->DriverResult<Value>{
        let stmt=self.conn.prep(sql).map_err(error)?;if stmt.columns().is_empty(){return Err(DriverError::unsupported("分页查询只接受有返回列的查询语句"));}let columns=stmt.columns().to_vec();let args=params(values)?;
        self.running.store(true,Ordering::SeqCst);
        // Original column names may repeat: a derived-table wrapper would reject valid SQL.
        // Keep only a page in memory; QueryResult drains the remaining wire rows on drop.
        let result=(||->DriverResult<Vec<Row>>{
            let mut stream=self.conn.exec_iter(&stmt,args).map_err(error)?;
            for _ in 0..offset{match stream.next(){Some(row)=>{row.map_err(error)?;},None=>return Ok(vec![])}}
            let mut rows=vec![];for _ in 0..=limit{match stream.next(){Some(row)=>rows.push(row.map_err(error)?),None=>break}}Ok(rows)
        })();self.running.store(false,Ordering::SeqCst);let rows=result?;
        let has_more=rows.len()>limit;
        let result:DriverResult<Vec<Value>>=rows.iter().take(limit).enumerate().map(|(ix,row)|{
            let cells:DriverResult<Vec<_>>=(0..row.len()).map(|i|cell(row.as_ref(i).unwrap(),&columns[i],false)).collect();Ok(json!({"index":offset+ix,"cells":cells?}))
        }).collect();let rows=result?;
        let columns:Vec<_>=columns.iter().map(|c|json!({"name":c.name_str(),"type":match c.column_type(){
            mysql::consts::ColumnType::MYSQL_TYPE_TINY|mysql::consts::ColumnType::MYSQL_TYPE_SHORT|mysql::consts::ColumnType::MYSQL_TYPE_LONG|mysql::consts::ColumnType::MYSQL_TYPE_INT24=>"integer",
            mysql::consts::ColumnType::MYSQL_TYPE_FLOAT|mysql::consts::ColumnType::MYSQL_TYPE_DOUBLE=>"real",
            mysql::consts::ColumnType::MYSQL_TYPE_DATE|mysql::consts::ColumnType::MYSQL_TYPE_DATETIME|mysql::consts::ColumnType::MYSQL_TYPE_TIMESTAMP=>"date",
            mysql::consts::ColumnType::MYSQL_TYPE_DECIMAL|mysql::consts::ColumnType::MYSQL_TYPE_NEWDECIMAL|mysql::consts::ColumnType::MYSQL_TYPE_LONGLONG|mysql::consts::ColumnType::MYSQL_TYPE_JSON=>"text",
            _=>if c.character_set()==63{"blob"}else{"text"}
        }})).collect();
        Ok(json!({"columns":columns,"returned":rows.len(),"rows":rows,"offset":offset,"hasMore":has_more}))
    }
    fn run_query(&mut self,sql:&str,options:&Value)->DriverResult<Value>{
        let started=Instant::now();let(sql,values)=n::bind_named(sql,options,false)?;
        let first=sql.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
        if !["select","with"].contains(&first.as_str()){return Err(DriverError::unsupported("分页查询只接受单条查询语句"));}
        let(offset,limit)=n::page_options(options);let mut page=self.page(&sql,&values,offset,limit)?;
        let cursor=if options.get("keepCursor").and_then(Value::as_bool)==Some(false){Value::Null}else{
            self.sequence+=1;let id=format!("mysql-cur-{}",self.sequence);self.cursors.insert(id.clone(),Cursor{sql:sql.clone(),values});json!(id)};
        page["cursorId"]=cursor;page["executedSql"]=json!(sql);page["elapsedMs"]=json!(started.elapsed().as_millis()as u64);Ok(page)
    }
    fn describe(&mut self,id:&str)->DriverResult<Value>{
        let(schema,table)=n::table_id(id)?;
        let rows=self.query("SELECT c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE,c.COLUMN_DEFAULT,COALESCE(k.ORDINAL_POSITION,0),c.EXTRA FROM information_schema.COLUMNS c LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON k.TABLE_SCHEMA=c.TABLE_SCHEMA AND k.TABLE_NAME=c.TABLE_NAME AND k.COLUMN_NAME=c.COLUMN_NAME AND k.CONSTRAINT_NAME='PRIMARY' WHERE c.TABLE_SCHEMA=? AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION",&[json!(schema),json!(table)])?;
        if rows.is_empty(){return Err(DriverError::new("not-found","表不存在"));}
        let columns:Vec<_>=rows.iter().map(|r|{let ordinal:u64=r.get(4).unwrap_or(0);let extra:String=r.get(5).unwrap_or_default();json!({"name":r.get::<String,_>(0).unwrap_or_default(),"typeName":r.get::<String,_>(1).unwrap_or_default(),"nullable":r.get::<String,_>(2).unwrap_or_default()=="YES","defaultValue":r.get::<Option<String>,_>(3).flatten(),"primaryKeyOrdinal":if ordinal==0{Value::Null}else{json!(ordinal)},"generated":if extra.contains("VIRTUAL GENERATED"){json!("virtual")}else if extra.contains("STORED GENERATED"){json!("stored")}else{Value::Null},"autoIncrement":extra.contains("auto_increment"),"requiredOnInsert":r.get::<String,_>(2).unwrap_or_default()=="NO"&&r.get::<Option<String>,_>(3).flatten().is_none()&&!extra.contains("auto_increment")&&!extra.contains("GENERATED")})}).collect();
        let mut keys:Vec<_>=rows.iter().filter(|r|r.get::<u64,_>(4).unwrap_or(0)>0).collect();keys.sort_by_key(|r|r.get::<u64,_>(4).unwrap_or(0));let keys:Vec<String>=keys.into_iter().map(|r|r.get(0).unwrap_or_default()).collect();
        let mut result=json!({"id":id,"columns":columns,"primaryKey":keys,"hasUniqueKey":!keys.is_empty()});
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
        Ok(json!(desc["columns"].as_array().unwrap().iter().map(|c|{let name=c["name"].as_str().unwrap_or("");n::node(format!("column:{}.{}.{}",n::escape_id(&schema),n::escape_id(&table),n::escape_id(name)),"column",name,Some(id),false)}).collect::<Vec<_>>()))
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
            let(sql,values)=if method=="insertRow"{
                let values=item.as_object().ok_or_else(||DriverError::invalid("插入值无效"))?;let desc=self.describe(id)?;let mut cols=vec![];let mut params=vec![];
                for(name,value)in values{if !desc["columns"].as_array().unwrap().iter().any(|c|c["name"]==name.as_str()){return Err(DriverError::invalid("未知列"));}cols.push(n::quote(name,true));params.push(n::cell_param(value)?);}
                (format!("INSERT INTO {target} ({}) VALUES ({})",cols.join(","),vec!["?";params.len()].join(",")),params)
            }else{
                let keys=if method=="applyEdits"{&item["keyValues"]}else{item};let(where_sql,key_values)=self.keys(id,keys)?;
                if method=="deleteRows"{(format!("DELETE FROM {target} WHERE {where_sql}"),key_values)}else{
                    let changes=item["changes"].as_object().ok_or_else(||DriverError::invalid("缺少修改列"))?;if changes.is_empty(){return Err(DriverError::invalid("修改列不能为空"));}
                    let desc=self.describe(id)?;let mut set=vec![];let mut values=vec![];
                    for(name,value)in changes{if !desc["columns"].as_array().unwrap().iter().any(|c|c["name"]==name.as_str()){return Err(DriverError::invalid("未知列"));}values.push(n::cell_param(value)?);set.push(format!("{}=?",n::quote(name,true)));}
                    values.extend(key_values);(format!("UPDATE {target} SET {} WHERE {where_sql}",set.join(",")),values)
                }
            };
            self.execute("SAVEPOINT dbstudio_edit",&[])?;
            match self.execute(&sql,&values){Ok(n)if method=="insertRow"||n<=1=>{self.execute("RELEASE SAVEPOINT dbstudio_edit",&[])?;total+=n;outcomes.push(json!({"index":index,"affected":n,"error":null,"sql":sql}));},result=>{
                self.execute("ROLLBACK TO SAVEPOINT dbstudio_edit",&[])?;self.execute("RELEASE SAVEPOINT dbstudio_edit",&[])?;let message=match result{Err(e)=>e.message,_=>"主键编辑影响多行，已回滚该行".into()};outcomes.push(json!({"index":index,"affected":0,"error":message,"sql":sql}));
            }}
        }
        self.pending+=total;Ok(json!({"affected":total,"ok":outcomes.iter().all(|v|v["error"].is_null()),"outcomes":outcomes,"inTransaction":self.active}))
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    fn address(value:&str)->SocketAddr{value.parse().unwrap()}
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
            "runQuery"|"query"=>self.run_query(string_argument(&args,0,"sql")?,args.get(1).unwrap_or(&Value::Null)),
            "previewTable"=>{let sql=format!("SELECT * FROM {}",n::qualified(string_argument(&args,0,"tableId")?,true)?);self.run_query(&sql,&json!({"limit":args.get(1).and_then(Value::as_u64).unwrap_or(200)}))},
            "fetchResultPage"|"fetchPage"=>{let id=string_argument(&args,0,"cursorId")?;let c=self.cursors.get(id).ok_or_else(||DriverError::new("not-found","游标不存在"))?;let(sql,values)=(c.sql.clone(),c.values.clone());let offset=args.get(1).and_then(Value::as_u64).unwrap_or(0)as usize;let limit=args.get(2).and_then(Value::as_u64).unwrap_or(200).clamp(1,1000)as usize;self.page(&sql,&values,offset,limit)},
            "closeCursor"=>{self.cursors.remove(string_argument(&args,0,"cursorId")?);Ok(Value::Null)},
            "fetchCellValue"=>{
                let id=string_argument(&args,0,"cursorId")?;let c=self.cursors.get(id).ok_or_else(||DriverError::new("not-found","游标不存在"))?;let(sql,values)=(c.sql.clone(),c.values.clone());
                let row=args.get(1).and_then(Value::as_u64).ok_or_else(||DriverError::invalid("行下标无效"))?;let column=args.get(2).and_then(Value::as_u64).ok_or_else(||DriverError::invalid("列下标无效"))? as usize;
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
                let original=string_argument(&args,0,"sql")?;let options=args.get(1).unwrap_or(&Value::Null);let(sql,values)=n::bind_named(original,options,false)?;let started=Instant::now();let stmt=self.conn.prep(&sql).map_err(error)?;
                if !stmt.columns().is_empty(){return Ok(json!({"kind":"rows","result":self.run_query(original,options)?}));}
                let keyword=sql.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
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
            "cancelQuery"=>Ok(json!((self.cancel)()?)),
            _=>Err(DriverError::unsupported("MySQL方法尚未迁移到Rust"))
        }
    }
}
