//! 真实 MySQL 的多语句脚本执行：作为 .sql 文件执行的核心链路。
//!
//! 连接参数来自环境变量；未配置时显式跳过。

use dbstudio_protocol::{ConnectionConfig, SecretMap};
use serde_json::json;

fn secret_map() -> SecretMap {
    let mut map = SecretMap::new();
    map.insert(
        "dbPassword".to_owned(),
        json!(std::env::var("PARTITION_TEST_PASSWORD").unwrap_or_else(|_| "dbstudio".into())),
    );
    map
}

fn test_config() -> Option<ConnectionConfig> {
    std::env::var("PARTITION_TEST_HOST").ok()?;
    let mut options = serde_json::Map::new();
    for (key, env, fallback) in [
        ("host", "PARTITION_TEST_HOST", "127.0.0.1"),
        ("port", "PARTITION_TEST_PORT", "13306"),
        ("database", "PARTITION_TEST_DATABASE", "testdb"),
        ("user", "PARTITION_TEST_USER", "dbstudio"),
    ] {
        options.insert(key.into(), json!(std::env::var(env).unwrap_or_else(|_| fallback.into())));
    }
    Some(ConnectionConfig {
        dialect_id: "mysql".into(),
        name: "script-exec".into(),
        options,
    })
}

#[test]
fn use_changes_only_session_database_and_preserves_managed_transaction() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let database = config.options["database"].as_str().unwrap();
    let restore = format!("USE `{}`", database.replace('`', "``"));
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接失败");
    let mut observer = dbstudio_drivers::connect(&config, &secret_map()).expect("观察连接失败");
    let idle = driver.call("transactionState", vec![]).unwrap();
    assert_eq!(idle["active"], false);
    assert_eq!(idle["pendingAffected"], 0);
    // Warm the exact same prepared query before USE, as the UI session probe does.
    let before = driver.call("runQuery", vec![json!("SELECT DATABASE() AS db"), json!({"keepCursor":false})]).unwrap();
    assert_eq!(before["rows"][0]["cells"][0]["text"], database);
    let use_result = driver.call("executeStatement", vec![json!("/* session */ USE information_schema"), json!({})]).unwrap();
    assert_eq!(use_result["transactionState"], idle);
    let current = driver.call("runQuery", vec![json!("SELECT DATABASE() AS db"), json!({"keepCursor":false})]).unwrap();
    assert_eq!(current["rows"][0]["cells"][0]["text"], "information_schema");
    let observed = observer.call("runQuery", vec![json!("SELECT DATABASE() AS db"), json!({"keepCursor":false})]).unwrap();
    assert_eq!(observed["rows"][0]["cells"][0]["text"], database);
    assert!(driver.call("executeStatement", vec![json!("USE dbstudio_context_missing"), json!({})]).is_err());
    assert_eq!(driver.call("transactionState", vec![]).unwrap(), idle);
    driver.call("executeStatement", vec![json!(restore), json!({})]).unwrap();
    let after_restore = driver.call("runQuery", vec![json!("SELECT DATABASE() AS db"), json!({"keepCursor":false})]).unwrap();
    assert_eq!(after_restore["rows"][0]["cells"][0]["text"], database);

    // 临时表随测试连接关闭释放；回滚后的计数可检测 USE 意外提交事务。
    driver.call("executeStatement", vec![json!("CREATE TEMPORARY TABLE context_transaction_probe (id INT PRIMARY KEY) ENGINE=InnoDB"), json!({})]).unwrap();
    let insert_sql = "INSERT INTO context_transaction_probe VALUES (:id)";
    driver.call("executeStatement", vec![json!(insert_sql), json!({"parameters":[{"name":"id","value":1}]})]).unwrap();
    let active = driver.call("transactionState", vec![]).unwrap();
    assert_eq!(active["active"], true);
    assert_eq!(active["pendingAffected"], 1);
    let count_sql = "SELECT COUNT(*) AS total FROM context_transaction_probe";
    let pending_rows = driver.call("runQuery", vec![json!(count_sql), json!({"keepCursor":false})]).unwrap();
    assert_eq!(pending_rows["rows"][0]["cells"][0], json!({"kind":"number","value":1}));
    assert_eq!(pending_rows["executedSql"], count_sql);
    let switched = driver.call("executeStatement", vec![json!("USE information_schema"), json!({})]).unwrap();
    assert_eq!(switched["transactionState"], active);
    assert!(driver.call("runQuery", vec![json!(count_sql), json!({"keepCursor":false})]).is_err(), "不能复用旧库的预处理语句读取未限定表名");
    assert!(driver.call("executeStatement", vec![json!(insert_sql), json!({"parameters":[{"name":"id","value":2}]})]).is_err(), "不能复用旧库的预处理写语句");
    assert_eq!(driver.call("transactionState", vec![]).unwrap(), active);
    assert!(driver.call("executeStatement", vec![json!("USE dbstudio_context_missing"), json!({})]).is_err());
    assert_eq!(driver.call("transactionState", vec![]).unwrap(), active);
    let after_failure = driver.call("runQuery", vec![json!("SELECT DATABASE() AS db"), json!({"keepCursor":false})]).unwrap();
    assert_eq!(after_failure["rows"][0]["cells"][0]["text"], "information_schema");
    let restored = driver.call("executeStatement", vec![json!(restore), json!({})]).unwrap();
    assert_eq!(restored["transactionState"], active);
    driver.call("rollbackTransaction", vec![]).unwrap();
    let rolled_back = driver.call("runQuery", vec![json!(count_sql), json!({"keepCursor":false})]).unwrap();
    assert_eq!(rolled_back["rows"][0]["cells"][0], json!({"kind":"number","value":0}));
    assert_eq!(driver.call("transactionState", vec![]).unwrap(), idle);
}

#[test]
fn multi_statement_script_runs_each_statement_against_real_database() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let table = format!("script_demo_{}", std::process::id() % 10000);

    // 一个典型 .sql 文件的内容：建表、插入、更新、查询，含注释与分号。
    let script = format!(
        "-- 这是注释，不应被执行\n\
         DROP TABLE IF EXISTS {table};\n\
         CREATE TABLE {table} (id INT NOT NULL PRIMARY KEY, note VARCHAR(32));\n\
         INSERT INTO {table} VALUES (1, 'a'), (2, 'b');\n\
         UPDATE {table} SET note = 'c' WHERE id = 2;\n\
         SELECT COUNT(*) AS total FROM {table};\n"
    );

    let mut executed = 0;
    // 按真实文件的形态逐行拆：先去掉注释行，再按分号切。
    let cleaned: String = script
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    for statement in cleaned.split(';').map(str::trim).filter(|item| !item.is_empty()) {
        let statement = statement.split_whitespace().collect::<Vec<_>>().join(" ");
        driver
            .call("executeStatement", vec![json!(statement.as_str()), json!({})])
            .unwrap_or_else(|error| panic!("语句执行失败：{statement} -> {error:?}"));
        executed += 1;
    }
    assert_eq!(executed, 5, "五条有效语句都应被执行");

    // 用真实库确认脚本效果。
    let checked = driver
        .call(
            "executeStatement",
            vec![json!(format!("SELECT id, note FROM {table} ORDER BY id")), json!({})],
        )
        .expect("核对脚本结果失败");
    let rendered = checked.to_string();
    assert!(rendered.contains("\"text\":\"c\""), "更新必须生效：{rendered}");
    assert!(rendered.contains("\"returned\":2"), "查询必须返回两行：{rendered}");

    // 查询会保留一个游标，同连接上的 DDL 会被拒绝；用新连接清理。
    drop(driver);
    let mut fresh = dbstudio_drivers::connect(&config, &secret_map()).expect("重连失败");
    fresh
        .call("executeStatement", vec![json!(format!("DROP TABLE IF EXISTS {table}")), json!({})])
        .expect("清理失败");
}

#[test]
fn script_stops_on_first_failure_and_leaves_database_unchanged() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let table = format!("script_fail_{}", std::process::id() % 10000);

    driver
        .call("executeStatement", vec![json!(format!("DROP TABLE IF EXISTS {table}")), json!({})])
        .ok();
    driver
        .call(
            "executeStatement",
            vec![json!(format!("CREATE TABLE {table} (id INT NOT NULL PRIMARY KEY)")), json!({})],
        )
        .expect("建表失败");

    // 第二条插入重复主键，必须失败并且不能把第一条的成功掩盖掉。
    let failing = driver
        .call("executeStatement", vec![json!(format!("INSERT INTO {table} VALUES (1), (1)")), json!({})]);
    assert!(failing.is_err(), "重复主键必须报错");

    let count = driver
        .call(
            "executeStatement",
            vec![json!(format!("SELECT COUNT(*) FROM {table}")), json!({})],
        )
        .expect("核对失败");
    // 直接断言计数为 0：不能写成恒真条件。
    let rendered_count = count.to_string();
    assert!(
        rendered_count.contains("\"value\":0") || rendered_count.contains("\"text\":\"0\""),
        "失败的插入不应留下部分数据：{count}"
    );

    // 一条语句失败后连接会停在未提交事务里，此时 DDL 会被拒绝；
    // 用新连接清理，顺便证明"DDL 拒绝" 是事务态而不是永久损坏。
    drop(driver);
    let mut cleanup = dbstudio_drivers::connect(&config, &secret_map()).expect("重连失败");
    cleanup
        .call("executeStatement", vec![json!(format!("DROP TABLE IF EXISTS {table}")), json!({})])
        .expect("清理失败");
}
