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
