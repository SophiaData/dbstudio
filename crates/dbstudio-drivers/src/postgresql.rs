//! Native synchronous PostgreSQL driver; all I/O uses the Rust postgres protocol stack.
use dbstudio_protocol::{CancelHandle,ConnectionConfig,Driver,DriverError,DriverResult,SecretMap,string_argument};
use postgres::{Client,Config,NoTls,Row,types::{FromSql,ToSql,Type,IsNull,Format}};
use postgres_native_tls::MakeTlsConnector;
use postgres::fallible_iterator::FallibleIterator;
use serde_json::{json,Value};
use std::{collections::HashMap,sync::{Arc,atomic::{AtomicBool,Ordering}},time::Instant};
use crate::{network as n,tls::{self,TlsMode},tunnel::{self,SshTunnel}};
use base64::{engine::general_purpose::STANDARD,Engine};

fn error(error:postgres::Error)->DriverError{
    if let Some(db)=error.as_db_error(){
        if db.code().code()=="57014"{return DriverError::new("cancelled","PostgreSQL操作已取消");}
        return DriverError::new("driver-error",format!("PostgreSQL操作失败(SQLSTATE {})",db.code().code()));
    }
    DriverError::new("connection_failed","PostgreSQL连接或协议操作失败")
}
#[derive(Debug)]
struct Param(Value);
impl ToSql for Param {
    fn to_sql(&self,_ty:&Type,out:&mut bytes::BytesMut)->Result<IsNull,Box<dyn std::error::Error+Sync+Send>>{
        if self.0.is_null(){return Ok(IsNull::Yes);}
        let text=match &self.0{
            Value::String(s)=>s.clone(),Value::Bool(v)=>v.to_string(),Value::Number(v)=>v.to_string(),
            Value::Object(map)if map.contains_key("$binary")=>{
                let raw=STANDARD.decode(map["$binary"].as_str().ok_or("invalid binary")?)?;
                format!("\\x{}",raw.iter().map(|b|format!("{b:02x}")).collect::<String>())
            },_=>return Err("unsupported parameter type".into())
        };out.extend_from_slice(text.as_bytes());Ok(IsNull::No)
    }
    fn accepts(_ty:&Type)->bool{true}
    fn encode_format(&self,_ty:&Type)->Format{Format::Text}
    postgres::types::to_sql_checked!();
}
struct Raw(Vec<u8>);
impl<'a> FromSql<'a> for Raw {
    fn from_sql(_ty:&Type,raw:&'a[u8])->Result<Self,Box<dyn std::error::Error+Sync+Send>>{Ok(Self(raw.to_vec()))}
    fn accepts(_ty:&Type)->bool{true}
}
fn params(values:&[Value])->Vec<Param>{values.iter().cloned().map(Param).collect()}
fn refs(params:&[Param])->Vec<&(dyn ToSql+Sync)>{params.iter().map(|p|p as &(dyn ToSql+Sync)).collect()}
fn cell(row:&Row,i:usize,full:bool)->DriverResult<Value>{
    let raw:Option<Raw>=row.try_get(i).map_err(|_|DriverError::unsupported("PostgreSQL字段类型无法解码"))?;
    let Some(raw)=raw else{return Ok(json!({"kind":"null"}));};let bytes=raw.0;
    let ty=row.columns()[i].type_();
    let numeric=|v:f64|if v.is_finite(){json!({"kind":"number","value":v})}else{n::text_cell(&v.to_string(),full)};
    Ok(match *ty {
        Type::BOOL=>json!({"kind":"boolean","value":bytes.first()==Some(&1)}),
        Type::INT2=>numeric(i16::from_be_bytes(bytes.try_into().map_err(|_|DriverError::invalid("数值编码错误"))?) as f64),
        Type::INT4=>numeric(i32::from_be_bytes(bytes.try_into().map_err(|_|DriverError::invalid("数值编码错误"))?) as f64),
        Type::INT8=>n::text_cell(&i64::from_be_bytes(bytes.try_into().map_err(|_|DriverError::invalid("数值编码错误"))?).to_string(),full),
        Type::FLOAT4=>numeric(f32::from_be_bytes(bytes.try_into().map_err(|_|DriverError::invalid("数值编码错误"))?) as f64),
        Type::FLOAT8=>numeric(f64::from_be_bytes(bytes.try_into().map_err(|_|DriverError::invalid("数值编码错误"))?)),
        Type::BYTEA=>n::blob_cell(&bytes,full),
        Type::JSON=>n::text_cell(std::str::from_utf8(&bytes).map_err(|_|DriverError::invalid("JSON编码错误"))?,full),
        Type::JSONB=>n::text_cell(std::str::from_utf8(bytes.get(1..).unwrap_or(&[])).map_err(|_|DriverError::invalid("JSON编码错误"))?,full),
        Type::DATE=>{let v:chrono::NaiveDate=row.try_get(i).map_err(|_|DriverError::unsupported("日期超出范围"))?;n::text_cell(&v.to_string(),full)},
        Type::TIMESTAMP=>{let v:chrono::NaiveDateTime=row.try_get(i).map_err(|_|DriverError::unsupported("日期超出范围"))?;n::text_cell(&v.to_string(),full)},
        Type::TIMESTAMPTZ=>{let v:chrono::DateTime<chrono::Utc>=row.try_get(i).map_err(|_|DriverError::unsupported("日期超出范围"))?;n::text_cell(&v.to_rfc3339(),full)},
        Type::NUMERIC=>n::text_cell(&decimal(&bytes)?,full),
        Type::UUID=>{if bytes.len()!=16{return Err(DriverError::invalid("UUID编码错误"));}let hex:Vec<_>=bytes.iter().map(|b|format!("{b:02x}")).collect();n::text_cell(&format!("{}-{}-{}-{}-{}",hex[0..4].join(""),hex[4..6].join(""),hex[6..8].join(""),hex[8..10].join(""),hex[10..16].join("")),full)},
        Type::TEXT|Type::VARCHAR|Type::BPCHAR|Type::NAME|Type::UNKNOWN=>n::text_cell(std::str::from_utf8(&bytes).map_err(|_|DriverError::invalid("文本编码错误"))?,full),
        _=>return Err(DriverError::unsupported("PostgreSQL字段类型尚未迁移，请显式CAST为text"))
    })
}
fn decimal(bytes:&[u8])->DriverResult<String>{
    if bytes.len()<8{return Err(DriverError::invalid("numeric编码错误"));}
    let word=|i|u16::from_be_bytes([bytes[i],bytes[i+1]]);
    let count=word(0)as usize;let weight=word(2)as i16 as i32;let sign=word(4);let scale=word(6)as usize;
    if bytes.len()!=8+count*2{return Err(DriverError::invalid("numeric编码错误"));}
    if sign==0xC000{return Ok("NaN".into());}if sign==0xD000{return Ok("Infinity".into());}if sign==0xF000{return Ok("-Infinity".into());}
    let group=|position:i32|->u16{let ix=weight-position;if ix<0||ix as usize>=count{0}else{word(8+ix as usize*2)}};
    let mut out=if sign==0x4000{"-".to_string()}else{String::new()};
    if weight<0{out.push('0');}else{for position in(0..=weight).rev(){let v=group(position);if position==weight{out.push_str(&v.to_string());}else{out.push_str(&format!("{v:04}"));}}}
    if scale>0{out.push('.');let mut fraction=String::new();for position in 1..=(scale.div_ceil(4)){fraction.push_str(&format!("{:04}",group(-(position as i32))));}out.push_str(&fraction[..scale]);}
    Ok(out)
}
struct Cursor {sql:String,values:Vec<Value>,snapshot:Option<(Vec<Value>,Vec<Row>)>}
fn snapshot_page(columns:&[Value],rows:&[Row],offset:usize,limit:usize)->DriverResult<Value>{
    let page:DriverResult<Vec<_>>=rows.iter().skip(offset).take(limit).enumerate().map(|(i,row)|{let cells:DriverResult<Vec<_>>=(0..row.len()).map(|column|cell(row,column,false)).collect();Ok(json!({"index":offset+i,"cells":cells?}))}).collect();
    let page=page?;Ok(json!({"columns":columns,"offset":offset,"returned":page.len(),"rows":page,"hasMore":rows.len()>offset.saturating_add(limit)}))
}
pub struct PostgresDriver {client:Client,cursors:HashMap<String,Cursor>,sequence:u64,active:bool,pending:u64,transaction_failed:bool,statement_recovered:bool,import_active:bool,import_failed:bool,import_next:u64,import_target:Option<String>,running:Arc<AtomicBool>,cancel:CancelHandle,_tunnel:Option<SshTunnel>}

pub fn connect(config:&ConnectionConfig,secrets:&SecretMap)->DriverResult<Box<dyn Driver>>{
    let host=n::option(config,"host","127.0.0.1");let port=n::port(config,"port",5432)?;
    let database=n::option(config,"database","");if database.is_empty(){return Err(DriverError::invalid("缺少数据库名"));}
    let mode=tls::mode(config,true)?;
    let tunnel=tunnel::open(config,secrets,&host,port)?;
    let mut cfg=Config::new();cfg.host(&host).port(tunnel.as_ref().map(|t|t.port).unwrap_or(port)).dbname(&database).user(&n::option(config,"user","postgres")).connect_timeout(n::timeout());
    if let Some(p)=secrets.get("dbPassword").and_then(Value::as_str){cfg.password(p);}
    if tunnel.is_some(){cfg.hostaddr(std::net::Ipv4Addr::LOCALHOST.into());}
    let mut client=if mode==TlsMode::Disable{cfg.ssl_mode(postgres::config::SslMode::Disable).connect(NoTls).map_err(error)?}
        else{cfg.ssl_mode(if mode==TlsMode::Prefer{postgres::config::SslMode::Prefer}else{postgres::config::SslMode::Require}).connect(MakeTlsConnector::new(tls::connector(config,mode)?)).map_err(error)?};
    client.simple_query("SELECT 1").map_err(error)?;
    let token=client.cancel_token();let connector=if mode==TlsMode::Disable{None}else{Some(tls::connector(config,mode)?)};
    let running=Arc::new(AtomicBool::new(false));let flag=running.clone();
    let cancel:CancelHandle=Arc::new(move||{if !flag.load(Ordering::SeqCst){return Ok(false);}if let Some(tls)=&connector{token.cancel_query(MakeTlsConnector::new(tls.clone())).map_err(error)?;}else{token.cancel_query(NoTls).map_err(error)?;}Ok(true)});
    Ok(Box::new(PostgresDriver{client,cursors:HashMap::new(),sequence:0,active:false,pending:0,transaction_failed:false,statement_recovered:false,import_active:false,import_failed:false,import_next:0,import_target:None,running,cancel,_tunnel:tunnel}))
}
impl PostgresDriver {
    fn query(&mut self,sql:&str,values:&[Value])->DriverResult<Vec<Row>>{
        let args=params(values);self.running.store(true,Ordering::SeqCst);let result=self.client.query(sql,&refs(&args)).map_err(error);self.running.store(false,Ordering::SeqCst);result
    }
    fn execute(&mut self,sql:&str,values:&[Value])->DriverResult<u64>{let args=params(values);self.running.store(true,Ordering::SeqCst);let result=self.client.execute(sql,&refs(&args)).map_err(error);self.running.store(false,Ordering::SeqCst);result}
    fn query_snapshot(&mut self,sql:&str,values:&[Value])->DriverResult<Vec<Row>>{
        self.execute("SAVEPOINT dbstudio_returning",&[])?;
        let args=params(values);self.running.store(true,Ordering::SeqCst);
        let result=(||->DriverResult<Vec<Row>>{
            let mut stream=self.client.query_raw(sql,refs(&args)).map_err(error)?;let mut rows=vec![];let mut bytes=0usize;
            while let Some(row)=stream.next().map_err(error)?{
                for index in 0..row.len(){let raw:Option<Raw>=row.try_get(index).map_err(|_|DriverError::unsupported("返回字段无法解码"))?;bytes=bytes.saturating_add(raw.map_or(0,|v|v.0.len()));}
                if rows.len()>=10_000||bytes>16*1024*1024{return Err(DriverError::unsupported("写语句返回快照超过10000行或16MiB，已回滚本次语句；请缩小RETURNING结果"));}rows.push(row);
            }
            for row in &rows{for index in 0..row.len(){cell(row,index,true)?;}}
            Ok(rows)
        })();self.running.store(false,Ordering::SeqCst);
        match result{Ok(rows)=>{self.execute("RELEASE SAVEPOINT dbstudio_returning",&[])?;Ok(rows)},Err(e)=>{
            if let Err(recovery)=self.execute("ROLLBACK TO SAVEPOINT dbstudio_returning",&[]){self.transaction_failed=true;return Err(recovery);}
            if let Err(recovery)=self.execute("RELEASE SAVEPOINT dbstudio_returning",&[]){self.transaction_failed=true;return Err(recovery);}
            let recovered=e.code!="connection_failed";let statement_failed=e.code=="driver-error";self.statement_recovered=recovered;
            Err(if statement_failed{DriverError::new("statement-failed","语句执行失败，已回滚到语句保存点；事务可继续")}else{e})
        }}
    }
    fn begin(&mut self)->DriverResult<()>{if !self.active{self.execute("BEGIN",&[])?;self.active=true;self.pending=0;}Ok(())}
    fn page(&mut self,sql:&str,values:&[Value],offset:usize,limit:usize)->DriverResult<Value>{
        let stmt=self.client.prepare(sql).map_err(error)?;
        let columns:Vec<_>=stmt.columns().iter().map(|c|json!({"name":c.name(),"type":match *c.type_(){Type::BOOL=>"boolean",Type::INT2|Type::INT4=>"integer",Type::FLOAT4|Type::FLOAT8=>"real",Type::BYTEA=>"blob",_=>"text"}})).collect();
        let paged=format!("SELECT * FROM ({sql}) AS dbstudio_page LIMIT {} OFFSET {offset}",limit+1);
        let rows=self.query(&paged,values)?;let has_more=rows.len()>limit;
        let result:DriverResult<Vec<Value>>=rows.iter().take(limit).enumerate().map(|(ix,row)|{
            let cells:DriverResult<Vec<_>>=(0..row.len()).map(|i|cell(row,i,false)).collect();Ok(json!({"index":offset+ix,"cells":cells?}))
        }).collect();
        let rows=result?;Ok(json!({"columns":columns,"returned":rows.len(),"rows":rows,"offset":offset,"hasMore":has_more}))
    }
    fn run_query(&mut self,sql:&str,options:&Value)->DriverResult<Value>{
        let started=Instant::now();let(sql,values)=n::bind_named(sql,options,true)?;
        let first=sql.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
        if !["select","with","values","table"].contains(&first.as_str()){return Err(DriverError::unsupported("分页查询只接受单条查询语句"));}
        let(offset,limit)=n::page_options(options);let mut page=self.page(&sql,&values,offset,limit)?;
        let cursor=if options.get("keepCursor").and_then(Value::as_bool)==Some(false){Value::Null}else{
            self.sequence+=1;let id=format!("pg-cur-{}",self.sequence);self.cursors.insert(id.clone(),Cursor{sql:sql.clone(),values,snapshot:None});json!(id)};
        page["cursorId"]=cursor;page["executedSql"]=json!(sql);page["elapsedMs"]=json!(started.elapsed().as_millis() as u64);Ok(page)
    }
    fn describe(&mut self,id:&str)->DriverResult<Value>{
        let(schema,table)=n::table_id(id)?;
        let rows=self.query("SELECT c.column_name,CASE WHEN c.character_maximum_length IS NOT NULL THEN c.data_type||'('||c.character_maximum_length::text||')' ELSE c.data_type END,c.is_nullable,c.column_default,coalesce(p.ordinal_position,0)::int4,c.is_identity,c.identity_generation,c.is_generated FROM information_schema.columns c LEFT JOIN (SELECT k.column_name,k.ordinal_position FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k ON k.constraint_name=t.constraint_name AND k.constraint_schema=t.constraint_schema AND k.table_name=t.table_name WHERE t.constraint_type='PRIMARY KEY' AND t.table_schema=$1 AND t.table_name=$2) p ON p.column_name=c.column_name WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position",&[json!(schema),json!(table)])?;
        if rows.is_empty(){return Err(DriverError::new("not-found","表不存在"));}
        let columns:Vec<_>=rows.iter().map(|r|json!({"name":r.get::<_,String>(0),"typeName":r.get::<_,String>(1),"nullable":r.get::<_,String>(2)=="YES","defaultValue":r.get::<_,Option<String>>(3),"primaryKey":r.get::<_,i32>(4)>0,"primaryKeyOrdinal":if r.get::<_,i32>(4)==0{Value::Null}else{json!(r.get::<_,i32>(4))},"generated":if r.get::<_,String>(7)=="ALWAYS"{json!("stored")}else{Value::Null},"identity":match r.get::<_,Option<String>>(6).as_deref(){Some("ALWAYS")=>json!("always"),Some("BY DEFAULT")=>json!("by-default"),_=>Value::Null},"identityGeneration":match r.get::<_,Option<String>>(6).as_deref(){Some("ALWAYS")=>json!("always"),Some("BY DEFAULT")=>json!("by-default"),_=>Value::Null},"autoIncrement":r.get::<_,String>(5)=="YES"||r.get::<_,Option<String>>(3).is_some_and(|s|s.starts_with("nextval(")),"requiredOnInsert":r.get::<_,String>(2)=="NO"&&r.get::<_,Option<String>>(3).is_none()&&r.get::<_,String>(5)!="YES"&&r.get::<_,String>(7)!="ALWAYS"})).collect();
        let mut keys:Vec<_>=rows.iter().filter(|r|r.get::<_,i32>(4)>0).collect();keys.sort_by_key(|r|r.get::<_,i32>(4));let keys:Vec<String>=keys.into_iter().map(|r|r.get(0)).collect();
        let mut result=json!({"id":id,"columns":columns,"primaryKey":keys,"hasUniqueKey":!keys.is_empty()});
        let indexes=self.query("SELECT ic.relname,i.indisunique,i.indisprimary,pg_get_indexdef(i.indexrelid),pg_get_expr(i.indpred,i.indrelid),coalesce((SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum),'[]'::jsonb),pg_get_expr(i.indexprs,i.indrelid) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class ic ON ic.oid=i.indexrelid WHERE n.nspname=$1 AND t.relname=$2 ORDER BY ic.relname",&[json!(schema),json!(table)])?;
        result["indexes"]=json!(indexes.iter().map(|r|json!({"name":r.get::<_,String>(0),"unique":r.get::<_,bool>(1),"expression":r.get::<_,Option<String>>(6),"predicate":r.get::<_,Option<String>>(4),"columns":r.get::<_,Value>(5)})).collect::<Vec<_>>());
        let constraints=self.query("SELECT c.conname,c.contype::text,pg_get_constraintdef(c.oid),rn.nspname,rt.relname,coalesce((SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum),'[]'::jsonb),coalesce((SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum),'[]'::jsonb),c.confupdtype::text,c.confdeltype::text FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace LEFT JOIN pg_class rt ON rt.oid=c.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rt.relnamespace WHERE n.nspname=$1 AND t.relname=$2 ORDER BY c.conname",&[json!(schema),json!(table)])?;
        result["uniqueConstraints"]=json!(constraints.iter().filter(|r|r.get::<_,String>(1)=="u").map(|r|json!({"name":r.get::<_,String>(0),"columns":r.get::<_,Value>(5)})).collect::<Vec<_>>());
        result["checks"]=json!(constraints.iter().filter(|r|r.get::<_,String>(1)=="c").map(|r|json!({"name":r.get::<_,String>(0),"expression":r.get::<_,String>(2)})).collect::<Vec<_>>());
        let action=|code:String|match code.as_str(){"a"=>"NO ACTION","r"=>"RESTRICT","c"=>"CASCADE","n"=>"SET NULL","d"=>"SET DEFAULT",_=>"NO ACTION"};
        result["foreignKeys"]=json!(constraints.iter().filter(|r|r.get::<_,String>(1)=="f").map(|r|json!({"name":r.get::<_,String>(0),"columns":r.get::<_,Value>(5),"referencedSchema":r.get::<_,Option<String>>(3),"referencedTable":r.get::<_,Option<String>>(4),"referencedColumns":r.get::<_,Value>(6),"onUpdate":action(r.get(7)),"onDelete":action(r.get(8))})).collect::<Vec<_>>());
        let triggers=self.query("SELECT tg.tgname,pg_get_triggerdef(tg.oid),tg.tgenabled::text,tg.tgtype::int4,pg_get_expr(tg.tgqual,tg.tgrelid) FROM pg_trigger tg JOIN pg_class t ON t.oid=tg.tgrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2 AND NOT tg.tgisinternal ORDER BY tg.tgname",&[json!(schema),json!(table)])?;
        result["triggers"]=json!(triggers.iter().flat_map(|r|{
            let bits:i32=r.get(3);[(4,"INSERT"),(8,"DELETE"),(16,"UPDATE"),(32,"TRUNCATE")].into_iter().filter(move|(mask,_)|bits&mask!=0).map(move|(_,event)|json!({"name":r.get::<_,String>(0),"timing":if bits&64!=0{"INSTEAD OF"}else if bits&2!=0{"BEFORE"}else{"AFTER"},"event":event,"statement":r.get::<_,String>(1),"enabled":r.get::<_,String>(2)!="D","when":r.get::<_,Option<String>>(4)}))
        }).collect::<Vec<_>>());
        Ok(result)
    }
    fn children(&mut self,id:Option<&str>)->DriverResult<Value>{
        let Some(id)=id else{return Ok(json!([n::node("folder:schemas".into(),"folder","Schemas",None,true)]));};
        if id=="folder:schemas"{
            let rows=self.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','pg_catalog') AND schema_name NOT LIKE 'pg_toast%' ORDER BY schema_name",&[])?;
            return Ok(json!(rows.iter().map(|r|{let s:String=r.get(0);n::node(format!("schema:{}",n::escape_id(&s)),"schema",&s,Some(id),true)}).collect::<Vec<_>>()));
        }
        if let Some(raw)=id.strip_prefix("schema:"){
            let parts=n::unescape_parts(raw)?;if parts.len()!=1{return Err(DriverError::invalid("schema ID无效"));}let schema=&parts[0];
            return Ok(json!([n::node(format!("folder:{}|tables",n::escape_id(schema)),"folder","Tables",Some(id),true),n::node(format!("folder:{}|views",n::escape_id(schema)),"folder","Views",Some(id),true)]));
        }
        if let Some(raw)=id.strip_prefix("folder:"){
            let(schema,kind)=raw.rsplit_once('|').ok_or_else(||DriverError::invalid("分组ID无效"))?;let parts=n::unescape_parts(schema)?;if parts.len()!=1{return Err(DriverError::invalid("schema ID无效"));}
            let view=match kind{"tables"=>false,"views"=>true,_=>return Err(DriverError::invalid("分组ID无效"))};
            let rows=self.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type=$2 ORDER BY table_name",&[json!(parts[0]),json!(if view{"VIEW"}else{"BASE TABLE"})])?;
            return Ok(json!(rows.iter().map(|r|{let name:String=r.get(0);n::node(format!("{}:{}.{}",if view{"view"}else{"table"},n::escape_id(&parts[0]),n::escape_id(&name)),if view{"view"}else{"table"},&name,Some(id),true)}).collect::<Vec<_>>()));
        }
        let desc=self.describe(id)?;let(schema,table)=n::table_id(id)?;
        Ok(json!(desc["columns"].as_array().unwrap().iter().map(|c|{let name=c["name"].as_str().unwrap_or("");n::node(format!("column:{}.{}.{}",n::escape_id(&schema),n::escape_id(&table),n::escape_id(name)),"column",name,Some(id),false)}).collect::<Vec<_>>()))
    }
    fn import_batch(&mut self,id:&str,batch:&Value)->DriverResult<Value>{
        if !id.starts_with("table:"){return Err(DriverError::invalid("导入目标必须是表"));}
        if self.import_failed{return Err(DriverError::invalid("导入已失败，请先回滚"));}
        if self.active&&!self.import_active{return Err(DriverError::invalid("已有用户事务，不能开始导入"));}
        let description=self.describe(id)?;let plan=n::import_plan(batch,&description)?;
        if plan.batch_index!=self.import_next{return Err(DriverError::invalid("导入批次必须从0开始并连续执行"));}
        if self.import_target.as_deref().is_some_and(|target|target!=id){return Err(DriverError::invalid("导入事务不能切换目标表"));}
        if !self.import_active{self.begin()?;self.import_active=true;self.import_target=Some(id.into());}
        let sql=format!("INSERT INTO {} ({}) VALUES ({})",n::qualified(id,false)?,plan.columns.iter().map(|c|n::quote(c,false)).collect::<Vec<_>>().join(","),(1..=plan.columns.len()).map(|i|format!("${i}")).collect::<Vec<_>>().join(","));
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
        let description=self.describe(id)?;let values=input.as_object().ok_or_else(||DriverError::invalid("插入值无效"))?;
        let mut columns=vec![];let mut params=vec![];
        for(name,value)in values{let metadata=description["columns"].as_array().unwrap().iter().find(|c|c["name"]==name.as_str()).ok_or_else(||DriverError::invalid("未知列"))?;
            if metadata["generated"].is_string()||metadata["identity"].as_str()==Some("always"){return Err(DriverError::invalid("不能写入生成列"));}columns.push(n::quote(name,false));params.push(n::cell_param(value)?);
        }
        let target=n::qualified(id,false)?;let mut sql=if columns.is_empty(){format!("INSERT INTO {target} DEFAULT VALUES")}else{format!("INSERT INTO {target} ({}) VALUES ({})",columns.join(","),(1..=params.len()).map(|i|format!("${i}")).collect::<Vec<_>>().join(","))};
        let keys=description["primaryKey"].as_array().unwrap();self.begin()?;
        let mut key_values=serde_json::Map::new();let affected=if keys.is_empty(){self.execute(&sql,&params)?}else{
            sql.push_str(" RETURNING ");sql.push_str(&keys.iter().map(|k|n::quote(k.as_str().unwrap(),false)).collect::<Vec<_>>().join(","));
            let rows=self.query(&sql,&params)?;if let Some(row)=rows.first(){for(index,key)in keys.iter().enumerate(){key_values.insert(key.as_str().unwrap().into(),cell(row,index,true)?);}}rows.len()as u64
        };
        self.pending+=affected;Ok(json!({"affected":affected,"keyValues":key_values}))
    }
    fn keys(&mut self,id:&str,key_values:&Value)->DriverResult<(String,Vec<Value>)>{
        if !id.starts_with("table:"){return Err(DriverError::unsupported("视图不能执行主键编辑"));}
        let desc=self.describe(id)?;let keys=desc["primaryKey"].as_array().unwrap();if keys.is_empty(){return Err(DriverError::unsupported("表缺少主键，禁止按行编辑"));}
        let supplied=key_values.as_object().ok_or_else(||DriverError::invalid("缺少主键值"))?;
        if supplied.len()!=keys.len(){return Err(DriverError::invalid("必须提供全部且仅有主键列"));}
        let mut clauses=vec![];let mut values=vec![];
        for key in keys{let name=key.as_str().unwrap();let val=n::cell_param(supplied.get(name).ok_or_else(||DriverError::invalid("缺少主键值"))?)?;if val.is_null(){return Err(DriverError::invalid("主键不能为NULL"));}values.push(val);clauses.push(format!("{}=${}",n::quote(name,false),values.len()));}
        Ok((clauses.join(" AND "),values))
    }
    fn edit(&mut self,method:&str,id:&str,input:&Value)->DriverResult<Value>{
        let target=n::qualified(id,false)?;let mut outcomes=vec![];let mut total=0;
        let rows=if method=="applyEdits"||method=="deleteRows"{input.as_array().ok_or_else(||DriverError::invalid("需要行数组"))?.clone()}else{vec![input.clone()]};
        self.begin()?;
        for(index,item)in rows.iter().enumerate(){
            let (sql,values)=if method=="insertRow"{
                let values=item.as_object().ok_or_else(||DriverError::invalid("插入值无效"))?;let desc=self.describe(id)?;
                let mut cols=vec![];let mut params=vec![];
                for(name,value)in values{if !desc["columns"].as_array().unwrap().iter().any(|c|c["name"]==name.as_str()){return Err(DriverError::invalid("未知列"));}cols.push(n::quote(name,false));params.push(n::cell_param(value)?);}
                (if cols.is_empty(){format!("INSERT INTO {target} DEFAULT VALUES")}else{format!("INSERT INTO {target} ({}) VALUES ({})",cols.join(","),(1..=params.len()).map(|i|format!("${i}")).collect::<Vec<_>>().join(","))},params)
            }else{
                let keys=if method=="applyEdits"{&item["keyValues"]}else{item};let(where_sql,mut values)=self.keys(id,keys)?;
                if method=="deleteRows"{(format!("DELETE FROM {target} WHERE {where_sql}"),values)}else{
                    let changes=item["changes"].as_object().ok_or_else(||DriverError::invalid("缺少修改列"))?;if changes.is_empty(){return Err(DriverError::invalid("修改列不能为空"));}
                    let desc=self.describe(id)?;let mut set=vec![];
                    for(name,value)in changes{if !desc["columns"].as_array().unwrap().iter().any(|c|c["name"]==name.as_str()){return Err(DriverError::invalid("未知列"));}values.push(n::cell_param(value)?);set.push(format!("{}=${}",n::quote(name,false),values.len()));}
                    (format!("UPDATE {target} SET {} WHERE {where_sql}",set.join(",")),values)
                }
            };
            self.execute("SAVEPOINT dbstudio_edit",&[])?;
            match self.execute(&sql,&values){Ok(n)if method=="insertRow"||n<=1=>{self.execute("RELEASE SAVEPOINT dbstudio_edit",&[])?;total+=n;outcomes.push(json!({"index":index,"affected":n,"error":null,"sql":sql}));},result=>{
                self.execute("ROLLBACK TO SAVEPOINT dbstudio_edit",&[])?;self.execute("RELEASE SAVEPOINT dbstudio_edit",&[])?;
                let message=match result{Err(e)=>e.message,_=>"主键编辑影响多行，已回滚该行".into()};outcomes.push(json!({"index":index,"affected":0,"error":message,"sql":sql}));
            }}
        }
        self.pending+=total;Ok(json!({"affected":total,"ok":outcomes.iter().all(|v|v["error"].is_null()),"outcomes":outcomes,"inTransaction":self.active}))
    }
}
impl Driver for PostgresDriver {
    fn dialect_id(&self)->&str{"postgresql"}
    fn capabilities(&self)->Value{json!({"hasCatalog":true,"hasSchema":true,"supportsServerPagination":true,"supportsCancel":true,"supportsInlineEdit":true,"metadata":{"foreignKeys":true,"indexes":true,"uniqueConstraints":true,"checkConstraints":true,"triggers":true}})}
    fn cancel_handle(&self)->CancelHandle{self.cancel.clone()}
    fn disconnect(&mut self)->DriverResult<()>{self.cursors.clear();if self.active{self.execute("ROLLBACK",&[])?;self.active=false;self.pending=0;}self.transaction_failed=false;self.import_active=false;self.import_failed=false;self.import_next=0;self.import_target=None;Ok(())}
    fn call(&mut self,method:&str,args:Vec<Value>)->DriverResult<Value>{
        if self.transaction_failed&&!["transactionState","commitTransaction","rollbackTransaction","cancelQuery"].contains(&method){return Err(DriverError::new("transaction-failed","PostgreSQL事务已失败，必须先回滚"));}
        self.statement_recovered=false;
        let result=self.call_inner(method,args);
        if !self.statement_recovered&&result.as_ref().err().is_some_and(|e|self.active&&["driver-error","connection_failed","cancelled"].contains(&e.code.as_str())){self.transaction_failed=true;}
        result
    }
}
impl PostgresDriver {
    fn call_inner(&mut self,method:&str,args:Vec<Value>)->DriverResult<Value>{
        if self.import_active&&!["importBatch","transactionState","commitTransaction","rollbackTransaction","cancelQuery"].contains(&method){return Err(DriverError::invalid("导入事务期间不能混入其他操作"));}
        match method{
            "listChildren"=>self.children(args.first().and_then(Value::as_str)),
            "describeTable"=>self.describe(string_argument(&args,0,"tableId")?),
            "runQuery"|"query"=>self.run_query(string_argument(&args,0,"sql")?,args.get(1).unwrap_or(&Value::Null)),
            "previewTable"=>{let sql=format!("SELECT * FROM {}",n::qualified(string_argument(&args,0,"tableId")?,false)?);self.run_query(&sql,&json!({"limit":args.get(1).and_then(Value::as_u64).unwrap_or(200)}))},
            "fetchResultPage"|"fetchPage"=>{let id=string_argument(&args,0,"cursorId")?;let cursor=self.cursors.get(id).ok_or_else(||DriverError::new("not-found","游标不存在"))?;let(sql,values)=(cursor.sql.clone(),cursor.values.clone());let offset=args.get(1).and_then(Value::as_u64).unwrap_or(0)as usize;let limit=args.get(2).and_then(Value::as_u64).unwrap_or(200).clamp(1,1000)as usize;if let Some((columns,rows))=&cursor.snapshot{return snapshot_page(columns,rows,offset,limit);}self.page(&sql,&values,offset,limit)},
            "closeCursor"=>{self.cursors.remove(string_argument(&args,0,"cursorId")?);Ok(Value::Null)},
            "fetchCellValue"=>{
                let id=string_argument(&args,0,"cursorId")?;let c=self.cursors.get(id).ok_or_else(||DriverError::new("not-found","游标不存在"))?;let(sql,values)=(c.sql.clone(),c.values.clone());
                let row=args.get(1).and_then(Value::as_u64).ok_or_else(||DriverError::invalid("行下标无效"))?;let column=args.get(2).and_then(Value::as_u64).ok_or_else(||DriverError::invalid("列下标无效"))? as usize;
                if let Some((_,rows))=&c.snapshot{let r=rows.get(row as usize).ok_or_else(||DriverError::new("not-found","行不存在"))?;if column>=r.len(){return Err(DriverError::invalid("列下标越界"));}return cell(r,column,true);}
                let rows=self.query(&format!("SELECT * FROM ({sql}) AS dbstudio_cell LIMIT 1 OFFSET {row}"),&values)?;let r=rows.first().ok_or_else(||DriverError::new("not-found","行不存在"))?;
                if column>=r.len(){return Err(DriverError::invalid("列下标越界"));}cell(r,column,true)
            },
            "viewDefinition"=>{let(schema,name)=n::table_id(string_argument(&args,0,"viewId")?)?;let rows=self.query("SELECT view_definition FROM information_schema.views WHERE table_schema=$1 AND table_name=$2",&[json!(schema),json!(name)])?;Ok(rows.first().map(|r|json!(r.get::<_,Option<String>>(0))).unwrap_or(Value::Null))},
            "listRoutines"=>{
                let schema=args.first().and_then(|v|v.get("schema")).and_then(Value::as_str);
                let rows=self.query("SELECT routine_schema,routine_name,routine_type,routine_definition,specific_name FROM information_schema.routines WHERE ($1::text IS NULL OR routine_schema=$1) AND routine_schema NOT IN ('pg_catalog','information_schema') ORDER BY routine_schema,routine_name,specific_name",&[schema.map(|s|json!(s)).unwrap_or(Value::Null)])?;
                Ok(json!(rows.iter().map(|r|json!({"schema":r.get::<_,String>(0),"name":r.get::<_,String>(1),"kind":if r.get::<_,String>(2)=="PROCEDURE"{"procedure"}else{"function"},"definition":r.get::<_,Option<String>>(3)})).collect::<Vec<_>>()))
            },
            "explain"=>{
                let(sql,values)=n::bind_named(string_argument(&args,0,"sql")?,args.get(1).unwrap_or(&Value::Null),true)?;
                let rows=self.query(&format!("EXPLAIN (FORMAT JSON) {sql}"),&values)?;let result:DriverResult<Vec<_>>=rows.iter().enumerate().map(|(index,r)|Ok(json!({"index":index,"cells":[cell(r,0,true)?]}))).collect();
                Ok(json!({"dialectId":"postgresql","columns":[{"name":"QUERY PLAN","type":"text"}],"rows":result?,"format":"json","executedSql":format!("EXPLAIN (FORMAT JSON) {sql}")}))
            },
            "executeStatement"=>{
                let original=string_argument(&args,0,"sql")?;let options=args.get(1).unwrap_or(&Value::Null);let(sql,values)=n::bind_named(original,options,true)?;let started=Instant::now();let stmt=self.client.prepare(&sql).map_err(error)?;
                if !stmt.columns().is_empty(){
                    let keyword=sql.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                    // WITH may contain data-changing CTEs. Execute original SQL once, never through a paging wrapper.
                    if ["insert","update","delete","merge","with"].contains(&keyword.as_str()){
                        self.begin()?;let rows=self.query_snapshot(&sql,&values)?;
                        let columns:Vec<_>=stmt.columns().iter().map(|c|json!({"name":c.name(),"type":match *c.type_(){Type::BOOL=>"boolean",Type::INT2|Type::INT4=>"integer",Type::FLOAT4|Type::FLOAT8=>"real",Type::BYTEA=>"blob",_=>"text"}})).collect();
                        if keyword!="with"{self.pending+=rows.len()as u64;}
                        let(offset,limit)=n::page_options(options);let mut result=snapshot_page(&columns,&rows,offset,limit)?;
                        result["cursorId"]=if options.get("keepCursor").and_then(Value::as_bool)==Some(false){Value::Null}else{self.sequence+=1;let id=format!("pg-cur-{}",self.sequence);self.cursors.insert(id.clone(),Cursor{sql:sql.clone(),values,snapshot:Some((columns,rows))});json!(id)};
                        result["executedSql"]=json!(sql);result["elapsedMs"]=json!(started.elapsed().as_millis()as u64);
                        return Ok(json!({"kind":"rows","result":result}));
                    }
                    return Ok(json!({"kind":"rows","result":self.run_query(original,options)?}));
                }
                let keyword=sql.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                if ["begin","start","commit","rollback","savepoint","release","end"].contains(&keyword.as_str()){return Err(DriverError::unsupported("请使用事务API控制事务"));}
                let ddl=["create","drop","alter","truncate","comment","grant","revoke"].contains(&keyword.as_str());
                if !ddl{self.begin()?;}let affected=self.execute(&sql,&values)?;if !ddl{self.pending+=affected;}
                Ok(if ddl{json!({"kind":"ddl","summary":"SQL已执行","affected":affected,"committed":!self.active,"executedSql":sql,"elapsedMs":started.elapsed().as_millis()as u64})}else{json!({"kind":"affected","affected":affected,"inTransaction":self.active,"transactionState":n::transaction_state(self.active,self.pending),"executedSql":sql,"elapsedMs":started.elapsed().as_millis()as u64})})
            },
            "transactionState"=>Ok(n::transaction_state(self.active,self.pending)),
            "commitTransaction"|"rollbackTransaction"=>{
                if method=="commitTransaction"&&self.transaction_failed{return Err(DriverError::new("transaction-failed","PostgreSQL事务已失败，不能提交；请回滚"));}
                if method=="commitTransaction"&&self.import_failed{return Err(DriverError::invalid("导入失败后禁止提交，必须回滚"));}
                if self.active{self.execute(if method=="commitTransaction"{"COMMIT"}else{"ROLLBACK"},&[])?;self.active=false;self.pending=0;}
                self.transaction_failed=false;self.import_active=false;self.import_failed=false;self.import_next=0;self.import_target=None;Ok(n::transaction_state(self.active,self.pending))
            },
            "importBatch"=>{let result=self.import_batch(string_argument(&args,0,"tableId")?,args.get(1).ok_or_else(||DriverError::invalid("缺少导入批次"))?);if result.is_err()&&self.import_active{self.import_failed=true;}result},
            "resolveTransferSource"=>n::transfer_source(string_argument(&args,0,"nodeId")?,false),
            "insertRow"=>self.insert_row(string_argument(&args,0,"tableId")?,args.get(1).ok_or_else(||DriverError::invalid("缺少插入值"))?),
            "applyEdits"|"deleteRows"=>self.edit(method,string_argument(&args,0,"tableId")?,args.get(1).ok_or_else(||DriverError::invalid("缺少编辑值"))?),
            "countRows"=>{let sql=format!("SELECT COUNT(*)::text FROM {}",n::qualified(string_argument(&args,0,"tableId")?,false)?);let rows=self.query(&sql,&[])?;let count:String=rows[0].get(0);Ok(json!(count.parse::<u64>().map_err(|_|DriverError::unsupported("计数超出范围"))?))},
            "tableSelectSql"=>Ok(json!(format!("SELECT * FROM {}",n::qualified(string_argument(&args,0,"tableId")?,false)?))),
            "createTable"=>{let sql=n::create_table_sql(args.first().ok_or_else(||DriverError::invalid("缺少建表规格"))?,false)?;self.execute(&sql,&[])?;self.cursors.clear();Ok(Value::Null)},
            "createView"=>{
                let name=n::qualified_name(string_argument(&args,0,"viewName")?,false)?;let(sql,_)=n::bind_named(string_argument(&args,1,"sql")?,&Value::Null,true)?;
                if !["select","with","values","table"].contains(&sql.split_whitespace().next().unwrap_or("").to_ascii_lowercase().as_str()){return Err(DriverError::invalid("视图定义必须是查询"));}
                self.execute(&format!("CREATE VIEW {name} AS {sql}"),&[])?;self.cursors.clear();Ok(Value::Null)
            },
            "dropTable"|"dropView"=>{let id=string_argument(&args,0,"objectId")?;if (method=="dropTable"&&!id.starts_with("table:"))||(method=="dropView"&&!id.starts_with("view:")){return Err(DriverError::invalid("对象种类不匹配"));}let target=n::qualified(id,false)?;self.execute(&format!("DROP {} {target}",if method=="dropTable"{"TABLE"}else{"VIEW"}),&[])?;self.cursors.clear();Ok(Value::Null)},
            "renameTable"=>{let id=string_argument(&args,0,"tableId")?;if !id.starts_with("table:"){return Err(DriverError::invalid("需要表ID"));}let name=string_argument(&args,1,"newName")?;if name.is_empty()||name.contains('\0'){return Err(DriverError::invalid("表名无效"));}self.execute(&format!("ALTER TABLE {} RENAME TO {}",n::qualified(id,false)?,n::quote(name,false)),&[])?;self.cursors.clear();Ok(Value::Null)},
            "cancelQuery"=>Ok(json!((self.cancel)()?)),
            _=>Err(DriverError::unsupported("PostgreSQL方法尚未迁移到Rust"))
        }
    }
}
