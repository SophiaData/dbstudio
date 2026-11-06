//! Native factory integration against Lead-managed dedicated loopback fixtures.
//! Run explicitly with --ignored; no Node forwarding, container management or user data.
//! Required env: DBSTUDIO_NATIVE_{PG,MYSQL}_{PORT,PASSWORD}; DB/user are fixed to fixture.
use dbstudio_protocol::{ConnectionConfig,Driver,DriverError,DriverResult,SecretMap};
use serde_json::{json,Value};
use std::{panic::{catch_unwind,AssertUnwindSafe},sync::mpsc,thread,time::{Duration,Instant,SystemTime,UNIX_EPOCH}};

fn fixture(dialect:&str)->(ConnectionConfig,SecretMap){
    let prefix=if dialect=="postgresql"{"DBSTUDIO_NATIVE_PG"}else{"DBSTUDIO_NATIVE_MYSQL"};
    let port=std::env::var(format!("{prefix}_PORT")).expect("dedicated fixture PORT is required").parse::<u16>().expect("fixture PORT must be valid");
    assert!(port>0,"fixture port must be positive");
    let password=std::env::var(format!("{prefix}_PASSWORD")).expect("dedicated fixture PASSWORD is required");assert!(!password.is_empty(),"fixture password must not be empty");
    let config:ConnectionConfig=serde_json::from_value(json!({"dialectId":dialect,"name":"native-fixture","options":{"host":"127.0.0.1","port":port,"database":"fixture","user":"fixture","sslmode":"disable"}})).unwrap();
    let mut secrets=SecretMap::new();secrets.insert("dbPassword".into(),Value::String(password));(config,secrets)
}
fn call(driver:&mut dyn Driver,method:&str,args:Vec<Value>)->Value{driver.call(method,args).unwrap_or_else(|e|panic!("{method}: {}: {}",e.code,e.message))}
fn scalar(cell:&Value)->Value{match cell["kind"].as_str(){Some("number")=>cell["value"].clone(),Some("text")=>cell["text"].clone(),Some("boolean")=>cell["value"].clone(),_=>Value::Null}}
fn key(id:i64)->Value{json!({"id":{"kind":"number","value":id}})}
fn run(dialect:&str){
    let(config,secrets)=fixture(dialect);let mut driver=dbstudio_drivers::connect(&config,&secrets).unwrap_or_else(|e|panic!("native connect: {}",e.message));
    let nonce=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();let name=format!("native_{nonce:x}");let schema=if dialect=="postgresql"{"public"}else{"fixture"};let raw=format!("table:{schema}.{name}");
    let qualified=dbstudio_drivers::network::qualified(&raw,dialect=="mysql").unwrap();let view_name=format!("{name}_view");let view_raw=format!("view:{schema}.{view_name}");let myisam_raw=format!("table:{schema}.{name}_myisam");
    let result=catch_unwind(AssertUnwindSafe(||{
        let capabilities=driver.capabilities();assert_eq!(capabilities["supportsCancel"],true);
        let schemas=call(&mut *driver,"listChildren",vec![json!("folder:schemas")]);assert!(schemas.as_array().unwrap().iter().any(|s|s["name"]==schema));
        call(&mut *driver,"createTable",vec![json!({"name":format!("{schema}.{name}"),"columns":[{"name":"id","typeName":"INTEGER","primaryKeyOrdinal":1},{"name":"body","typeName":"TEXT","nullable":false},{"name":"big","typeName":"BIGINT"}]})]);
        let metadata=call(&mut *driver,"describeTable",vec![json!(raw)]);assert_eq!(metadata["id"],raw);assert_eq!(metadata["hasUniqueKey"],true);assert_eq!(metadata["columns"][0]["primaryKeyOrdinal"],1);assert!(metadata["columns"][0]["typeName"].is_string());
        let listing=call(&mut *driver,"listChildren",vec![json!(format!("folder:{schema}|tables"))]);assert!(listing.as_array().unwrap().iter().any(|n|n["id"]==raw));
        let body="native-值".repeat(300);
        for id in 1..=3{
            let row=call(&mut *driver,"insertRow",vec![json!(raw),json!({"id":{"kind":"number","value":id},"body":{"kind":"text","text":body},"big":{"kind":"text","text":"9007199254740993"}})]);
            assert_eq!(row["affected"],1);assert_eq!(scalar(&row["keyValues"]["id"]).as_f64(),Some(id as f64));
        }
        assert_eq!(call(&mut *driver,"transactionState",vec![])["active"],true);
        // A bulk import may never absorb or commit unrelated pending user edits.
        assert!(driver.call("importBatch",vec![json!(raw),json!({"batchIndex":0,"columns":["id","body"],"rows":[{"rowNumber":1,"values":[{"kind":"number","value":99},{"kind":"text","text":"rejected"}]}]})]).is_err());
        call(&mut *driver,"commitTransaction",vec![]);
        let placeholder=if dialect=="postgresql"{"$1"}else{"?"};let parameter=if dialect=="postgresql"{"$1"}else{"?1"};
        let sql=format!("SELECT id,body,big FROM {qualified} WHERE id >= {placeholder} ORDER BY id");
        let first=call(&mut *driver,"runQuery",vec![json!(sql),json!({"limit":1,"parameters":[{"name":parameter,"value":1}]})]);
        assert_eq!(first["returned"],1);assert_eq!(first["hasMore"],true);assert_eq!(first["rows"][0]["cells"][1]["truncated"],true);assert_eq!(scalar(&first["rows"][0]["cells"][2]),"9007199254740993");
        let cursor=first["cursorId"].clone();let next=call(&mut *driver,"fetchResultPage",vec![cursor.clone(),json!(1),json!(1)]);assert_eq!(scalar(&next["rows"][0]["cells"][0]).as_f64(),Some(2.0)); // TS number has no separate integer/floating JSON representation.
        let full=call(&mut *driver,"fetchCellValue",vec![cursor.clone(),json!(0),json!(1)]);assert_eq!(full["text"],body);assert_ne!(full["truncated"],true);
        call(&mut *driver,"closeCursor",vec![cursor]);
        let edit=call(&mut *driver,"applyEdits",vec![json!(raw),json!([{"keyValues":key(1),"changes":{"body":{"kind":"text","text":"rolled back"}}}])]);assert_eq!(edit["affected"],1);call(&mut *driver,"rollbackTransaction",vec![]);
        let check=call(&mut *driver,"runQuery",vec![json!(format!("SELECT body FROM {qualified} WHERE id=1")),json!({"keepCursor":false})]);assert_eq!(check["rows"][0]["cells"][0]["truncated"],true);
        let deleted=call(&mut *driver,"deleteRows",vec![json!(raw),json!([key(3)])]);assert_eq!(deleted["affected"],1);call(&mut *driver,"commitTransaction",vec![]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),2);
        let affected=call(&mut *driver,"executeStatement",vec![json!(format!("UPDATE {qualified} SET body='native updated' WHERE id=2")),json!({})]);assert_eq!(affected["kind"],"affected");assert_eq!(affected["affected"],1);call(&mut *driver,"rollbackTransaction",vec![]);
        if dialect=="postgresql"{
            let returning=call(&mut *driver,"executeStatement",vec![json!(format!("INSERT INTO {qualified} (id,body) VALUES (30,'returning-a'),(31,'returning-b') RETURNING id,body")),json!({"limit":1})]);
            assert_eq!(returning["kind"],"rows");assert_eq!(returning["result"]["returned"],1);assert_eq!(returning["result"]["hasMore"],true);
            let cursor=returning["result"]["cursorId"].clone();let second=call(&mut *driver,"fetchResultPage",vec![cursor.clone(),json!(1),json!(1)]);assert_eq!(scalar(&second["rows"][0]["cells"][0]).as_f64(),Some(31.0));
            assert_eq!(call(&mut *driver,"fetchCellValue",vec![cursor.clone(),json!(1),json!(1)])["text"],"returning-b");call(&mut *driver,"closeCursor",vec![cursor]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),4);
            let cte=call(&mut *driver,"executeStatement",vec![json!(format!("WITH changed AS (UPDATE {qualified} SET body=body || '-once' WHERE id IN (30,31) RETURNING id,body) SELECT * FROM changed ORDER BY id")),json!({"limit":1})]);
            let cursor=cte["result"]["cursorId"].clone();assert_eq!(call(&mut *driver,"fetchResultPage",vec![cursor.clone(),json!(1),json!(1)])["rows"][0]["cells"][1]["text"],"returning-b-once");
            assert_eq!(call(&mut *driver,"fetchCellValue",vec![cursor.clone(),json!(0),json!(1)])["text"],"returning-a-once");call(&mut *driver,"closeCursor",vec![cursor]);
            let once=call(&mut *driver,"runQuery",vec![json!(format!("SELECT body FROM {qualified} WHERE id=30")),json!({"keepCursor":false})]);assert_eq!(once["rows"][0]["cells"][0]["text"],"returning-a-once");
            call(&mut *driver,"rollbackTransaction",vec![]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),2);
            let overflow=driver.call("executeStatement",vec![json!(format!("INSERT INTO {qualified} (id,body) SELECT n,'bounded returning' FROM generate_series(100,10100) n RETURNING id")),json!({"limit":1})]).expect_err("oversized returning must rollback its statement");assert_eq!(overflow.code,"unsupported");assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),2);call(&mut *driver,"rollbackTransaction",vec![]);
            call(&mut *driver,"insertRow",vec![json!(raw),json!({"id":{"kind":"number","value":20},"body":{"kind":"text","text":"must rollback"}})]);
            assert!(driver.call("executeStatement",vec![json!(format!("INSERT INTO {qualified} (id,body) VALUES (1,'duplicate')")),json!({})]).is_err());
            let commit=driver.call("commitTransaction",vec![]).expect_err("aborted PostgreSQL transaction must not report successful commit");assert_eq!(commit.code,"transaction-failed");
            call(&mut *driver,"rollbackTransaction",vec![]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),2);
            call(&mut *driver,"insertRow",vec![json!(raw),json!({"id":{"kind":"number","value":40},"body":{"kind":"text","text":"array prior"}})]);
            let array=driver.call("executeStatement",vec![json!(format!("INSERT INTO {qualified} (id,body) VALUES (41,'array failed') RETURNING ARRAY[id]")),json!({"limit":1})]).expect_err("unsupported RETURNING type must rollback inside its savepoint");assert_eq!(array.code,"unsupported");
            assert_eq!(call(&mut *driver,"transactionState",vec![])["active"],true);call(&mut *driver,"commitTransaction",vec![]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),3);
            let prior=call(&mut *driver,"runQuery",vec![json!(format!("SELECT body FROM {qualified} WHERE id=40")),json!({"keepCursor":false})]);assert_eq!(prior["rows"][0]["cells"][0]["text"],"array prior");
            let failed=call(&mut *driver,"runQuery",vec![json!(format!("SELECT id FROM {qualified} WHERE id=41")),json!({"keepCursor":false})]);assert_eq!(failed["returned"],0);
            call(&mut *driver,"deleteRows",vec![json!(raw),json!([key(40)])]);call(&mut *driver,"commitTransaction",vec![]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),2);
            call(&mut *driver,"insertRow",vec![json!(raw),json!({"id":{"kind":"number","value":50},"body":{"kind":"text","text":"late prior"}})]);
            let late=driver.call("executeStatement",vec![json!(format!("INSERT INTO {qualified} (id,body) SELECT n::int,'late decode' FROM generate_series(60,61) n RETURNING id,CASE WHEN id=61 THEN 'infinity'::date ELSE DATE '2024-01-01' END")),json!({"limit":1})]).expect_err("all pages must be decoded inside the savepoint");assert_eq!(late.code,"unsupported");
            call(&mut *driver,"commitTransaction",vec![]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),3);
            let late_failed=call(&mut *driver,"runQuery",vec![json!(format!("SELECT id FROM {qualified} WHERE id IN (60,61)")),json!({"keepCursor":false})]);assert_eq!(late_failed["returned"],0);
            call(&mut *driver,"deleteRows",vec![json!(raw),json!([key(50)])]);call(&mut *driver,"commitTransaction",vec![]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),2);
            call(&mut *driver,"insertRow",vec![json!(raw),json!({"id":{"kind":"number","value":70},"body":{"kind":"text","text":"statement prior"}})]);
            let duplicate_returning=driver.call("executeStatement",vec![json!(format!("INSERT INTO {qualified} (id,body) VALUES (1,'duplicate returning') RETURNING id,body")),json!({"limit":1})]).expect_err("duplicate key must fail only its statement");assert_eq!(duplicate_returning.code,"statement-failed");assert_eq!(duplicate_returning.message,"语句执行失败，已回滚到语句保存点；事务可继续");
            assert_eq!(call(&mut *driver,"transactionState",vec![])["active"],true);call(&mut *driver,"commitTransaction",vec![]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),3);
            let prior=call(&mut *driver,"runQuery",vec![json!(format!("SELECT body FROM {qualified} WHERE id=70")),json!({"keepCursor":false})]);assert_eq!(prior["rows"][0]["cells"][0]["text"],"statement prior");
            let duplicate_rows=call(&mut *driver,"runQuery",vec![json!(format!("SELECT id FROM {qualified} WHERE body='duplicate returning'")),json!({"keepCursor":false})]);assert_eq!(duplicate_rows["returned"],0);
            call(&mut *driver,"deleteRows",vec![json!(raw),json!([key(70)])]);call(&mut *driver,"commitTransaction",vec![]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),2);
        }else{
            let duplicate=call(&mut *driver,"runQuery",vec![json!(format!("SELECT id AS same,body AS same FROM {qualified} ORDER BY id")),json!({"limit":1})]);
            assert_eq!(duplicate["columns"][0]["name"],"same");assert_eq!(duplicate["columns"][1]["name"],"same");assert_eq!(duplicate["hasMore"],true);
            let cursor=duplicate["cursorId"].clone();let page=call(&mut *driver,"fetchResultPage",vec![cursor.clone(),json!(1),json!(1)]);assert_eq!(scalar(&page["rows"][0]["cells"][0]).as_f64(),Some(2.0));assert_eq!(page["columns"][1]["name"],"same");
            assert_eq!(call(&mut *driver,"fetchCellValue",vec![cursor.clone(),json!(0),json!(1)])["text"],body);call(&mut *driver,"closeCursor",vec![cursor]);
            let before=call(&mut *driver,"runQuery",vec![json!(format!("SELECT COUNT(*) AS row_count,MAX(big) AS max_big FROM {qualified}")),json!({"keepCursor":false})]);
            let rejected=driver.call("runQuery",vec![json!(format!("WITH c AS (SELECT 1) UPDATE {qualified} SET big=big+1")),json!({"keepCursor":false})]).expect_err("write CTE must be rejected before execution");assert_eq!(rejected.code,"unsupported");
            let after=call(&mut *driver,"runQuery",vec![json!(format!("SELECT COUNT(*) AS row_count,MAX(big) AS max_big FROM {qualified}")),json!({"keepCursor":false})]);assert_eq!(after["rows"],before["rows"]);
            assert_eq!(scalar(&after["rows"][0]["cells"][0]).as_f64(),Some(2.0));assert_eq!(scalar(&after["rows"][0]["cells"][1]),"9007199254740993");
            let target=dbstudio_drivers::network::qualified(&myisam_raw,true).unwrap();
            call(&mut *driver,"executeStatement",vec![json!(format!("CREATE TABLE {target} (id INT PRIMARY KEY,body TEXT) ENGINE=MyISAM")),json!({})]);
            let batch=json!({"batchIndex":0,"columns":["id","body"],"rows":[{"rowNumber":1,"values":[{"kind":"number","value":1},{"kind":"text","text":"first"}]},{"rowNumber":2,"values":[{"kind":"number","value":1},{"kind":"text","text":"duplicate"}]}]});
            assert_eq!(driver.call("importBatch",vec![json!(myisam_raw),batch]).expect_err("nontransactional import must be rejected before writing").code,"unsupported");
            assert_eq!(driver.call("insertRow",vec![json!(myisam_raw),json!({"id":{"kind":"number","value":2}})]).expect_err("nontransactional grid insert must be rejected").code,"unsupported");
            assert_eq!(driver.call("applyEdits",vec![json!(myisam_raw),json!([{"keyValues":key(1),"changes":{"body":{"kind":"text","text":"blocked"}}}])]).expect_err("nontransactional grid update must be rejected").code,"unsupported");
            assert_eq!(driver.call("deleteRows",vec![json!(myisam_raw),json!([key(1)])]).expect_err("nontransactional grid delete must be rejected").code,"unsupported");
            assert_eq!(call(&mut *driver,"transactionState",vec![])["active"],false);assert_eq!(call(&mut *driver,"countRows",vec![json!(myisam_raw)]),0);
            let arithmetic=call(&mut *driver,"runQuery",vec![json!("SELECT 1--2 AS value"),json!({"keepCursor":false})]);assert_eq!(scalar(&arithmetic["rows"][0]["cells"][0]).as_f64(),Some(3.0));
        }
        let source=call(&mut *driver,"resolveTransferSource",vec![json!(raw)]);assert_eq!(source["target"]["schema"],schema);assert_eq!(source["target"]["name"],name);assert_eq!(source["target"]["table"],name);assert_eq!(source["sql"],format!("SELECT * FROM {qualified}"));
        let batch=|batch_index,id|json!({"batchIndex":batch_index,"columns":["id","body"],"rows":[{"rowNumber":id,"lineNumber":id+1,"values":[{"kind":"number","value":id},{"kind":"text","text":"native import"}]}]});
        assert_eq!(call(&mut *driver,"importBatch",vec![json!(raw),batch(0,10)])["rowsImported"],1);
        assert_eq!(call(&mut *driver,"importBatch",vec![json!(raw),batch(1,11)])["rowsImported"],1);
        assert_eq!(call(&mut *driver,"transactionState",vec![])["active"],true);call(&mut *driver,"rollbackTransaction",vec![]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),2);
        call(&mut *driver,"importBatch",vec![json!(raw),batch(0,10)]);
        assert!(driver.call("importBatch",vec![json!(raw),batch(1,10)]).is_err());assert!(driver.call("commitTransaction",vec![]).is_err());call(&mut *driver,"rollbackTransaction",vec![]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),2);
        call(&mut *driver,"importBatch",vec![json!(raw),batch(0,10)]);call(&mut *driver,"commitTransaction",vec![]);assert_eq!(call(&mut *driver,"countRows",vec![json!(raw)]),3);
        call(&mut *driver,"createView",vec![json!(format!("{schema}.{view_name}")),json!(format!("SELECT id FROM {qualified}"))]);assert!(call(&mut *driver,"viewDefinition",vec![json!(view_raw)]).is_string());
    }));
    // Finally: only this run's nonce SQL objects. The fixture DB/container/data remain intact.
    let _=driver.call("rollbackTransaction",vec![]);let _=driver.call("dropView",vec![json!(view_raw)]);let _=driver.call("dropTable",vec![json!(raw)]);if dialect=="mysql"{let _=driver.call("dropTable",vec![json!(myisam_raw)]);}let _=driver.disconnect();
    if let Err(panic)=result{std::panic::resume_unwind(panic);}

    // Independent cancel handle must work while the worker owns the driver, without its mutex.
    let mut worker_driver=dbstudio_drivers::connect(&config,&secrets).unwrap_or_else(|e|panic!("cancel fixture connect: {}",e.message));let cancel=worker_driver.cancel_handle();let(started_tx,started_rx)=mpsc::channel();
    let worker=thread::spawn(move||->DriverResult<Value>{started_tx.send(()).unwrap();let sql=if dialect_is_pg(&worker_driver){"SELECT 1 AS value FROM pg_sleep(10)"}else{"SELECT SLEEP(10) AS value"};worker_driver.call("runQuery",vec![json!(sql),json!({"keepCursor":false})])});
    started_rx.recv_timeout(Duration::from_secs(2)).expect("native worker did not start");let started=Instant::now();let mut requested=false;
    while started.elapsed()<Duration::from_secs(3){match cancel(){Ok(true)=>{requested=true;break;},Ok(false)=>thread::sleep(Duration::from_millis(20)),Err(e)=>panic!("cancel request failed: {}",e.message)}}
    assert!(requested,"native cancellation did not observe a running query");let outcome=worker.join().expect("native query worker panicked");
    match outcome {Err(DriverError{code,..})=>assert_eq!(code,"cancelled"),Ok(value)=>{assert_eq!(dialect,"mysql");assert_eq!(scalar(&value["rows"][0]["cells"][0]),1);}}
    assert!(started.elapsed()<Duration::from_secs(5),"query cancellation was not prompt");
}
fn dialect_is_pg(driver:&Box<dyn Driver>)->bool{driver.dialect_id()=="postgresql"}
#[test]
#[ignore = "requires Lead-managed PostgreSQL fixture and explicit port/password env"]
fn postgresql_native_factory_lifecycle(){run("postgresql");}
#[test]
#[ignore = "requires Lead-managed MySQL fixture and explicit port/password env"]
fn mysql_native_factory_lifecycle(){run("mysql");}
