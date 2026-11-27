//! 仅使用既有 loopback fixture；密码只进入 MemorySecretStore，不写文件或日志。
//! 需要 fixture-memory-secrets 和 DBSTUDIO_NATIVE_{PG,MYSQL}_{PORT,PASSWORD}。
//! 显式 --ignored --test-threads=1；保留随机表、应用状态目录和隔离容器，不删除对象。
#![cfg(feature = "fixture-memory-secrets")]

use dbstudio_core::{AppError, Application, MemorySecretStore};
use serde_json::{json, Value};
use std::{
    panic::{catch_unwind, resume_unwind, AssertUnwindSafe},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

static LIVE_TEST: Mutex<()> = Mutex::new(());
const WAIT: Duration = Duration::from_secs(10);

fn call(app: &Application, method: &str, args: Vec<Value>) -> Value {
    app.call(method, args).unwrap_or_else(|error| {
        // 只输出核心错误码，不附带配置、SQL、环境变量值或底层诊断。
        panic!("fixture {method} 失败，错误码 {}", error.code)
    })
}

fn query(app: &Application, node: &str, sql: &str) -> Value {
    call(app, "runQuery", vec![json!(node), json!(sql), json!({"keepCursor":false,"limit":10})])
}

fn session_id(app: &Application, node: &str, dialect: &str) -> u64 {
    let sql = if dialect == "postgresql" { "SELECT pg_backend_pid()::text" }
        else { "SELECT CAST(CONNECTION_ID() AS CHAR)" };
    query(app, node, sql)["rows"][0]["cells"][0]["text"].as_str()
        .expect("fixture 会话 ID 必须是文本").parse().expect("fixture 会话 ID 必须是整数")
}

fn pending_sql(dialect: &str, id: u64, table: &str, operation: &str) -> String {
    // 只查询本测试已取得的会话 ID 和随机表名，返回存在性，不读取其它会话 SQL。
    if dialect == "postgresql" {
        format!("SELECT 1 FROM pg_stat_activity WHERE pid = {id} AND datname = 'fixture' \
            AND usename = 'fixture' AND state = 'active' AND wait_event_type = 'Lock' \
            AND query LIKE '%{table}%' AND UPPER(query) LIKE '%{operation}%'")
    } else {
        format!("SELECT 1 FROM information_schema.PROCESSLIST WHERE ID = {id} AND DB = 'fixture' \
            AND USER = 'fixture' AND COMMAND <> 'Sleep' AND STATE = 'Waiting for table metadata lock' \
            AND INFO LIKE '%{table}%' AND UPPER(INFO) LIKE '%{operation}%'")
    }
}

fn wait_pending(app: &Application, observer: &str, sql: &str) {
    let deadline = Instant::now() + WAIT;
    loop {
        if query(app, observer, sql)["returned"].as_u64() == Some(1) { return; }
        assert!(Instant::now() < deadline, "未观察到指定 fixture 请求在服务端等锁");
        thread::sleep(Duration::from_millis(25));
    }
}

fn assert_cancelled(result: Result<Value, AppError>) {
    let error = result.expect_err("COUNT 必须在释放锁之前被取消");
    // 现有 PG 57014 和 MySQL 1317 都由原生驱动映射为 cancelled。
    assert_eq!(error.code, "cancelled");
}

fn blocked_round(
    app: &Arc<Application>, dialect: &str, nodes: &[String], ids: &[u64],
    table: &str, qualified: &str, table_node: &str, old_signal: &str, count: bool,
) {
    let target = &nodes[0]; let holder = &nodes[1]; let observer = &nodes[2];
    let signal = if count { old_signal.to_owned() } else { format!("{old_signal}-next-query") };
    thread::scope(|scope| {
        let mut ddl = None;
        let mut worker = None;
        let (sent, received) = mpsc::channel();
        let checked = catch_unwind(AssertUnwindSafe(|| {
            if dialect == "postgresql" {
                // executeStatement 为 LOCK 自动开启事务，回滚负责释放 ACCESS EXCLUSIVE。
                call(app, "executeStatement", vec![json!(holder), json!(format!("LOCK TABLE {qualified} IN ACCESS EXCLUSIVE MODE"))]);
            } else {
                // InnoDB 行锁不阻塞一致性 COUNT。未提交 INSERT 持有元数据锁，
                // 排队的 ALTER 请求独占元数据锁，后来的 COUNT/SELECT 必须等待。
                call(app, "executeStatement", vec![json!(holder), json!(format!("INSERT INTO {qualified} (id) VALUES (99)"))]);
                let ddl_app = app.clone(); let ddl_node = nodes[3].clone();
                let column = if count { "count_probe" } else { "next_probe" };
                let sql = format!("ALTER TABLE {qualified} ADD COLUMN {column} INTEGER NULL");
                ddl = Some(scope.spawn(move || ddl_app.call("executeStatement", vec![json!(ddl_node), json!(sql)])));
                wait_pending(app, observer, &pending_sql(dialect, ids[3], table, "ALTER TABLE"));
            }

            let request_app = app.clone();
            let method = if count { "countRows" } else { "runQuery" };
            let args = if count {
                vec![json!(table_node), json!({"signalId":signal})]
            } else {
                vec![json!(target), json!(format!("SELECT id FROM {qualified}")),
                    json!({"signalId":signal,"keepCursor":false,"limit":10})]
            };
            worker = Some(scope.spawn(move || { let _ = sent.send(request_app.call(method, args)); }));
            let active_sql = pending_sql(dialect, ids[0], table, if count { "COUNT(" } else { "SELECT" });
            wait_pending(app, observer, &active_sql);

            let wrong = if count { format!("{old_signal}-wrong") } else { old_signal.to_owned() };
            assert_eq!(call(app, "cancelQuery", vec![json!(target), json!(wrong)]), false);
            assert!(matches!(received.try_recv(), Err(mpsc::TryRecvError::Empty)),
                "错误或旧 signal 不应使等待中的请求结束");
            // 错 ID 后再次从服务端确认请求仍在等待，避免仅凭 false 自证。
            wait_pending(app, observer, &active_sql);
            if count {
                assert_eq!(call(app, "cancelQuery", vec![json!(target), json!(signal)]), true);
                assert_cancelled(received.recv_timeout(WAIT).expect("COUNT 取消未及时返回"));
                assert_eq!(call(app, "cancelQuery", vec![json!(target), json!(old_signal)]), false);
            }
        }));

        // 先释放独立连接的锁再等待工作线程；断言失败也走同一释放路径。
        let unlocked = app.call("rollbackTransaction", vec![json!(holder)]);
        if unlocked.is_err() {
            let id = holder.strip_prefix("connection:").expect("fixture 连接作用域");
            let _ = app.call("disconnectConnection", vec![json!(id)]);
        }
        let ddl_result = ddl.map(|handle| handle.join());
        let worker_result = worker.map(|handle| handle.join());
        if let Err(payload) = checked { resume_unwind(payload); }
        assert!(unlocked.is_ok(), "fixture 持锁事务回滚失败");
        if let Some(result) = ddl_result { assert!(result.expect("fixture ALTER 线程失败").is_ok(), "fixture ALTER 未完成"); }
        worker_result.expect("fixture 请求线程未启动").expect("fixture 请求线程失败");
        if !count {
            let result = received.recv_timeout(WAIT).expect("后续查询未及时返回")
                .expect("旧 COUNT signal 不得取消后续查询");
            assert_eq!(result["returned"], 3);
        }
    });
}

fn run(dialect: &str) {
    let _serial = LIVE_TEST.lock().unwrap();
    let prefix = if dialect == "postgresql" { "DBSTUDIO_NATIVE_PG" } else { "DBSTUDIO_NATIVE_MYSQL" };
    let port = std::env::var(format!("{prefix}_PORT")).expect("需要既有 fixture PORT")
        .parse::<u16>().expect("fixture PORT 无效");
    assert!(port > 0, "fixture PORT 不能为零");
    let password = std::env::var(format!("{prefix}_PASSWORD"))
        .unwrap_or_else(|_| panic!("需要有效的既有 fixture PASSWORD"));
    assert!(!password.is_empty(), "fixture PASSWORD 不能为空");
    let nonce = Uuid::new_v4().simple().to_string();
    let base = std::env::temp_dir().join(format!("dbstudio-count-cancel-{nonce}"));
    let app = Arc::new(Application::open(base, Arc::new(MemorySecretStore::default())).expect("fixture 应用初始化失败"));
    let checked = catch_unwind(AssertUnwindSafe(|| {
        let mut nodes = Vec::new(); let mut ids = Vec::new();
        for role in ["target", "holder", "observer", "ddl"] {
            let summary = call(&app, "addConnection", vec![json!({
                "dialectId":dialect,"name":format!("count-cancel-{role}"),
                "options":{"host":"127.0.0.1","port":port,"database":"fixture","user":"fixture","sslmode":"disable"}
            }), json!({"dbPassword":password})]);
            assert_eq!(summary["connected"], true, "必须连接到指定 loopback fixture");
            let node = format!("connection:{}", summary["id"].as_str().expect("fixture 连接 ID 缺失"));
            if dialect == "postgresql" {
                query(&app, &node, "SELECT set_config('statement_timeout', '60000', false)");
            }
            ids.push(session_id(&app, &node, dialect)); nodes.push(node);
        }
        let table = format!("count_cancel_{nonce}");
        let qualified = if dialect == "postgresql" { format!("\"public\".\"{table}\"") }
            else { format!("`fixture`.`{table}`") };
        let schema = if dialect == "postgresql" { "public" } else { "fixture" };
        let table_node = format!("{}|table:{schema}.{table}", nodes[0]);
        let engine = if dialect == "mysql" { " ENGINE=InnoDB" } else { "" };
        call(&app, "executeStatement", vec![json!(nodes[0]), json!(format!("CREATE TABLE {qualified} (id INTEGER PRIMARY KEY){engine}"))]);
        call(&app, "executeStatement", vec![json!(nodes[0]), json!(format!("INSERT INTO {qualified} (id) VALUES (1), (2), (3)"))]);
        call(&app, "commitTransaction", vec![json!(nodes[0])]);
        let signal = format!("count-{nonce}");
        blocked_round(&app, dialect, &nodes, &ids, &table, &qualified, &table_node, &signal, true);
        // 同一真实会话在取消后仍可完成无 options COUNT 和后续 SELECT。
        assert_eq!(call(&app, "countRows", vec![json!(table_node)]), 3);
        let selected = query(&app, &nodes[0], "SELECT 1");
        assert_eq!(selected["returned"], 1);
        assert_eq!(selected["rows"][0]["cells"][0]["value"].as_f64(), Some(1.0));
        blocked_round(&app, dialect, &nodes, &ids, &table, &qualified, &table_node, &signal, false);
        assert_eq!(call(&app, "countRows", vec![json!(table_node), json!({"signalId":format!("{signal}-fresh")})]), 3);
        assert_eq!(call(&app, "cancelQuery", vec![json!(nodes[0]), json!(signal)]), false);
    }));
    let closed = app.close();
    if let Err(payload) = checked { resume_unwind(payload); }
    assert!(closed.is_ok(), "fixture 会话关闭失败");
}

#[test]
#[ignore = "需要既有 PostgreSQL loopback fixture；仅显式单线程运行"]
fn postgresql_count_cancel_live() { run("postgresql"); }

#[test]
#[ignore = "需要既有 MySQL loopback fixture；仅显式单线程运行"]
fn mysql_count_cancel_live() { run("mysql"); }
