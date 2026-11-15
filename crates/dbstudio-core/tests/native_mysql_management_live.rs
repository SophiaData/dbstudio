//! 走 `dbstudio_core::Application::call` 的真实 MySQL 验收。
//!
//! 这条测试刻意不直接调用驱动：Tauri 桌面端的唯一入口就是它，
//! 只有这里通了，界面按钮才能真正拿到数据。
//!
//! 连接参数来自环境变量；未配置时显式跳过。

use dbstudio_core::{Application, SecretStore};
use dbstudio_protocol::SecretMap;
use serde_json::{json, Value};
use std::sync::Arc;

struct MemorySecrets;

impl SecretStore for MemorySecrets {
    fn get(&self, _key: &str) -> Result<Option<SecretMap>, dbstudio_core::AppError> {
        Ok(None)
    }
    fn set(&self, _key: &str, _secret: &SecretMap) -> Result<(), dbstudio_core::AppError> {
        Ok(())
    }
    fn remove(&self, _key: &str) -> Result<(), dbstudio_core::AppError> {
        Ok(())
    }
}

/// 每次调用都拿到独立存储目录：同一目录下开两个
/// Application 会互相弄脏配置文件，导致偶发的 storage-failed。
fn application() -> Option<(Application, tempfile_like_dir)> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let host = std::env::var("PARTITION_TEST_HOST").ok()?;
    let slot = SEQUENCE.fetch_add(1, Ordering::SeqCst);
    let _ = host;
    let base = std::env::temp_dir().join(format!(
        "dbstudio-core-{}-{}-{}",
        std::process::id(),
        slot,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&base).ok()?;
    let app = Application::open(base.clone(), Arc::new(MemorySecrets)).ok()?;
    Some((app, tempfile_like_dir(base)))
}

struct tempfile_like_dir(std::path::PathBuf);
impl Drop for tempfile_like_dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn secret() -> Value {
    json!({"dbPassword": std::env::var("PARTITION_TEST_PASSWORD").unwrap_or_else(|_| "dbstudio".into())})
}

fn connected_application() -> Option<(Application, tempfile_like_dir, String)> {
    let (app, dir) = application()?;
    let config = json!({
        "dialectId": "mysql",
        "name": "native-core",
        "options": {
            "host": std::env::var("PARTITION_TEST_HOST").unwrap(),
            "port": std::env::var("PARTITION_TEST_PORT").unwrap_or_else(|_| "13306".into()),
            "database": std::env::var("PARTITION_TEST_DATABASE").unwrap_or_else(|_| "testdb".into()),
            "user": std::env::var("PARTITION_TEST_USER").unwrap_or_else(|_| "dbstudio".into()),
        }
    });
    let summary = app.call("addConnection", vec![config, secret()]).expect("addConnection 失败");
    assert_eq!(summary.get("connected").and_then(Value::as_bool), Some(true), "原生核心必须连上真实库：{summary}");
    let id = summary.get("id").and_then(Value::as_str).expect("连接摘要缺少 id").to_owned();
    Some((app, dir, id))
}

#[test]
fn native_core_reaches_partition_metadata_through_describe_table() {
    let Some((app, _dir, id)) = connected_application() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let connection = format!("connection:{id}");

    app.call("executeStatement", vec![json!(format!("{connection}|table:testdb.core_partition_demo")), json!("DROP TABLE IF EXISTS core_partition_demo")])
        .ok();
    app.call(
        "executeStatement",
        vec![
            json!("DROP TABLE IF EXISTS core_partition_demo"),
            json!({}),
        ],
    )
    .ok();
    // 建表走 executeStatement：它需要连接作用域节点。
    let created = app.call(
        "executeStatement",
        vec![
            json!(format!("{connection}|table:testdb.core_partition_demo")),
            json!("CREATE TABLE core_partition_demo (id INT NOT NULL, PRIMARY KEY (id)) PARTITION BY RANGE (id) (PARTITION p0 VALUES LESS THAN (100), PARTITION p1 VALUES LESS THAN (200))"),
        ],
    );
    let created = match created {
        Ok(value) => value,
        Err(error) => {
            // 连接作用域节点不可用时，直接判定为失败而不是静默跳过。
            panic!("原生核心执行建表失败：{error:?}");
        }
    };
    assert!(created.get("kind").is_some(), "建表结果缺少 kind：{created}");

    let described = app
        .call("describeTable", vec![json!(format!("{connection}|table:testdb.core_partition_demo"))])
        .expect("原生核心 describeTable 失败");
    let partitions = described.get("partitions").expect("原生核心必须返回 partitions");
    let items = partitions.get("items").and_then(Value::as_array).expect("items 必须是数组");
    let names: Vec<&str> = items
        .iter()
        .filter_map(|item| item.get("name").and_then(Value::as_str))
        .collect();
    assert_eq!(names, vec!["p0", "p1"], "分区必须与真实库一致：{partitions}");

    app.call(
        "executeStatement",
        vec![json!(format!("{connection}|table:testdb.core_partition_demo")), json!("DROP TABLE IF EXISTS core_partition_demo")],
    )
    .ok();
}

#[test]
fn native_core_exposes_sessions_events_and_users() {
    let Some((app, _dir, id)) = connected_application() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let connection = format!("connection:{id}");

    let sessions = app.call("listSessions", vec![json!(connection)]).expect("原生核心 listSessions 失败");
    let items = sessions.as_array().expect("会话列表必须是数组");
    assert!(!items.is_empty(), "会话列表不应为空");
    assert_eq!(
        items.iter().filter(|item| item.get("current").and_then(Value::as_bool) == Some(true)).count(),
        1,
        "必须且只能标记一条当前会话"
    );

    let events = app.call("listEvents", vec![json!(connection), json!({"schema": "testdb"})]).expect("原生核心 listEvents 失败");
    assert!(events.get("items").and_then(Value::as_array).is_some(), "事件结果必须带 items：{events}");
    assert!(events.get("scheduler").is_some(), "事件结果必须带调度器状态：{events}");

    let users = app.call("listUsers", vec![json!(connection)]).expect("原生核心 listUsers 失败");
    assert!(users.get("users").and_then(Value::as_array).is_some(), "用户结果必须带 users：{users}");
    assert!(users.get("privileges").and_then(Value::as_array).is_some(), "用户结果必须带 privileges：{users}");
}


/// 通过原生核心入口执行分区与索引写操作，并核对真实库结果。
#[test]
fn native_core_applies_partition_and_index_changes() {
    let Some((app, _dir, id)) = connected_application() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let connection = format!("connection:{id}");
    let table = format!("{connection}|table:testdb.core_admin_demo");

    app.call("executeStatement", vec![json!(table.as_str()), json!("DROP TABLE IF EXISTS core_admin_demo")])
        .ok();
    app.call(
        "executeStatement",
        vec![
            json!(table.as_str()),
            json!("CREATE TABLE core_admin_demo (id INT NOT NULL, created DATE NOT NULL, a INT, b INT, PRIMARY KEY (id, created)) PARTITION BY RANGE (YEAR(created)) (PARTITION p2024 VALUES LESS THAN (2025))"),
        ],
    )
    .expect("建表失败");

    // 分区：追加 MAXVALUE 分区，结果必须能从真实库读回。
    app.call(
        "partitionTable",
        vec![json!(table.as_str()), json!({"action": "add", "name": "pmax", "lessThan": "MAXVALUE"})],
    )
    .expect("原生核心新增分区失败");
    let described = app.call("describeTable", vec![json!(table.as_str())]).expect("读取表结构失败");
    let names: Vec<&str> = described
        .get("partitions")
        .and_then(|value| value.get("items"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.get("name").and_then(Value::as_str)).collect())
        .unwrap_or_default();
    assert_eq!(names, vec!["p2024", "pmax"], "分区必须真实生效：{names:?}");

    // 索引：新增后必须出现在 describeTable 里。
    app.call(
        "indexTable",
        vec![json!(table.as_str()), json!({"action": "add", "name": "idx_a", "columns": ["a"]})],
    )
    .expect("原生核心新增索引失败");
    let described = app.call("describeTable", vec![json!(table.as_str())]).expect("读取表结构失败");
    let indexes: Vec<&str> = described
        .get("indexes")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.get("name").and_then(Value::as_str)).collect())
        .unwrap_or_default();
    assert!(indexes.contains(&"idx_a"), "索引必须真实生效：{indexes:?}");

    app.call("executeStatement", vec![json!(table.as_str()), json!("DROP TABLE IF EXISTS core_admin_demo")])
        .expect("清理失败");
}

/// 通过原生核心入口终止另一条真实连接。
#[test]
fn native_core_kills_another_real_session() {
    let Some((killer_app, _dir, killer_id)) = connected_application() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let Some((victim_app, _victim_dir, _victim_id)) = connected_application() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let killer = format!("connection:{killer_id}");

    let sessions = killer_app
        .call("listSessions", vec![json!(killer.as_str())])
        .expect("读取会话失败");
    let items = sessions.as_array().expect("会话列表必须是数组");
    assert!(items.len() >= 2, "两条连接应产生至少两条会话：{}", items.len());

    let victim_session = items
        .iter()
        .filter(|item| item.get("current").and_then(Value::as_bool) != Some(true))
        .filter_map(|item| item.get("id").and_then(Value::as_u64))
        .max()
        .expect("找不到其它会话");

    killer_app
        .call("killSession", vec![json!(killer.as_str()), json!(victim_session)])
        .expect("终止其它会话失败");

    // 被终止的连接不能再正常工作。
    let victim_connection = format!("connection:{}", summary_id(&victim_app));
    assert!(
        victim_app.call("listSessions", vec![json!(victim_connection)]).is_err(),
        "被终止的连接不应还能读取会话"
    );
}

fn summary_id(app: &Application) -> String {
    app.call("listConnections", vec![])
        .ok()
        .and_then(|value| value.as_array().and_then(|items| items.first().cloned()))
        .and_then(|item| item.get("id").and_then(Value::as_str).map(str::to_owned))
        .expect("读取连接 id 失败")
}

/// 通过原生核心入口搜索对象：断言真实命中，而不只是"没报错"。
#[test]
fn native_core_search_and_lineage_use_forwarded_request() {
    let Some((app, _dir, id)) = connected_application() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let connection = format!("connection:{id}");
    let table = format!("{connection}|table:testdb.core_search_demo");

    app.call("executeStatement", vec![json!(table.as_str()), json!("DROP TABLE IF EXISTS core_search_demo")]).ok();
    app.call(
        "executeStatement",
        vec![json!(table.as_str()), json!("CREATE TABLE core_search_demo (id INT NOT NULL PRIMARY KEY, parent_id INT)")],
    )
    .expect("建表失败");

    // 搜索：关键字必须真的送到驱动，否则会报"请输入搜索关键字"。
    let found = app
        .call(
            "searchObjects",
            vec![json!(connection.as_str()), json!({"keyword": "core_search_demo"})],
        )
        .expect("原生核心搜索失败");
    let names: Vec<&str> = found
        .get("items")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.get("name").and_then(Value::as_str)).collect())
        .unwrap_or_default();
    assert!(names.contains(&"core_search_demo"), "必须搜到刚建的表：{names:?}");

    // 血缘：请求体必须真的送到驱动，否则会报"缺少表名或列名"。
    let evidence = app
        .call(
            "lineageEvidence",
            vec![json!(connection.as_str()), json!({"schema": "testdb", "table": "core_search_demo", "column": "parent_id"})],
        )
        .expect("原生核心血缘证据失败");
    assert_eq!(
        evidence.get("target").and_then(|t| t.get("column")).and_then(Value::as_str),
        Some("parent_id"),
        "证据必须围绕请求的列：{evidence}"
    );
    let tables = evidence.get("tables").and_then(Value::as_array).cloned().unwrap_or_default();
    assert!(
        tables.iter().any(|item| item.get("name").and_then(Value::as_str) == Some("core_search_demo")),
        "证据必须包含目标表的列清单：{tables:?}"
    );

    app.call("executeStatement", vec![json!(table.as_str()), json!("DROP TABLE IF EXISTS core_search_demo")])
        .expect("清理失败");
}

/// 页面上的"对象源码"面板走的就是这条路径：
/// 必须能通过原生核心读到真实库里的源码。
#[test]
fn native_core_reads_object_source_for_view_and_routine() {
    let Some((app, _dir, id)) = connected_application() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let connection = format!("connection:{id}");
    let table = format!("{connection}|table:testdb.core_src_demo");

    for sql in [
        "DROP VIEW IF EXISTS core_src_view",
        "DROP PROCEDURE IF EXISTS core_src_proc",
        "DROP TABLE IF EXISTS core_src_demo",
        "CREATE TABLE core_src_demo (id INT NOT NULL PRIMARY KEY, val INT)",
        "CREATE VIEW core_src_view AS SELECT id, val FROM core_src_demo WHERE val > 0",
        "CREATE PROCEDURE core_src_proc() SELECT COUNT(*) FROM core_src_demo",
    ] {
        app.call("executeStatement", vec![json!(table.as_str()), json!(sql)])
            .unwrap_or_else(|error| panic!("准备失败：{sql} -> {error:?}"));
    }

    let view = app
        .call("objectSource", vec![json!(format!("{connection}|view:testdb.core_src_view"))])
        .expect("原生核心读取视图源码失败");
    let view_sql = view.get("sql").and_then(Value::as_str).unwrap_or_default();
    assert!(view_sql.contains("core_src_demo"), "视图源码必须来自真实库：{view_sql}");

    let routine = app
        .call("objectSource", vec![json!(format!("{connection}|routine:testdb.PROCEDURE.core_src_proc"))])
        .expect("原生核心读取例程源码失败");
    let definition = routine.get("definition").and_then(Value::as_str).unwrap_or_default();
    assert!(definition.contains("COUNT"), "例程源码必须来自真实库：{definition}");

    for sql in [
        "DROP VIEW IF EXISTS core_src_view",
        "DROP PROCEDURE IF EXISTS core_src_proc",
        "DROP TABLE IF EXISTS core_src_demo",
    ] {
        app.call("executeStatement", vec![json!(table.as_str()), json!(sql)])
            .unwrap_or_else(|error| panic!("清理失败：{sql} -> {error:?}"));
    }
}
