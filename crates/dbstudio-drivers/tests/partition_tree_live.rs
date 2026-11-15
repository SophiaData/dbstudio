//! 真实 MySQL 目录树中的分区节点验收。

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

/// 当前测试库名：本机与 CI 夹具不同，不能写死。
fn schema_name() -> String {
    std::env::var("PARTITION_TEST_DATABASE").unwrap_or_else(|_| "testdb".into())
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
        name: "partition-tree".into(),
        options,
    })
}

#[test]
fn tree_exposes_partition_nodes_before_columns() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let table = format!("table:{}.partition_tree_demo", schema_name());

    driver
        .call("executeStatement", vec![json!("DROP TABLE IF EXISTS partition_tree_demo"), json!({})])
        .unwrap();
    driver
        .call(
            "executeStatement",
            vec![
                json!("CREATE TABLE partition_tree_demo (id INT NOT NULL, PRIMARY KEY (id)) PARTITION BY RANGE (id) (PARTITION p0 VALUES LESS THAN (100), PARTITION p1 VALUES LESS THAN (200))"),
                json!({}),
            ],
        )
        .expect("建表失败");

    let children = driver.call("listChildren", vec![json!(table)]).expect("读取子节点失败");
    let nodes = children.as_array().expect("子节点必须是数组");
    let kinds: Vec<&str> = nodes.iter().filter_map(|node| node.get("kind").and_then(|v| v.as_str())).collect();
    assert_eq!(
        &kinds[..2],
        &["partition", "partition"],
        "分区节点必须排在列之前：{kinds:?}"
    );
    let names: Vec<String> = nodes
        .iter()
        .filter(|node| node.get("kind").and_then(|v| v.as_str()) == Some("partition"))
        .filter_map(|node| node.get("name").and_then(|v| v.as_str()).map(str::to_owned))
        .collect();
    assert_eq!(names, vec!["p0  (< 100)", "p1  (< 200)"], "分区名与边界必须可读");
    assert!(
        nodes.iter().any(|node| node.get("kind").and_then(|v| v.as_str()) == Some("column")),
        "列节点不能被分区节点挤掉"
    );

    driver
        .call("executeStatement", vec![json!("DROP TABLE IF EXISTS partition_tree_demo"), json!({})])
        .expect("清理失败");
}

#[test]
fn tree_has_no_partition_nodes_for_plain_tables() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let table = format!("table:{}.plain_tree_demo", schema_name());
    driver
        .call(
            "executeStatement",
            vec![json!("CREATE TABLE IF NOT EXISTS plain_tree_demo (id INT PRIMARY KEY)"), json!({})],
        )
        .expect("建表失败");

    let children = driver.call("listChildren", vec![json!(table)]).expect("读取子节点失败");
    let nodes = children.as_array().expect("子节点必须是数组");
    assert!(
        nodes.iter().all(|node| node.get("kind").and_then(|v| v.as_str()) != Some("partition")),
        "普通表不应出现分区节点"
    );

    driver
        .call("executeStatement", vec![json!("DROP TABLE IF EXISTS plain_tree_demo"), json!({})])
        .expect("清理失败");
}
