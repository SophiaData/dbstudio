//! 真实 MySQL 的分区元数据验收。
//!
//! 只验证一件事：`describeTable` 必须把真实的表分区信息带回来，而不是把分区表
//! 读成普通表。连接参数来自环境变量；未配置时显式跳过，绝不静默通过。

use dbstudio_protocol::{ConnectionConfig, SecretMap};
use serde_json::{json, Value};

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
    options.insert(
        "host".into(),
        json!(std::env::var("PARTITION_TEST_HOST").unwrap()),
    );
    options.insert(
        "port".into(),
        json!(std::env::var("PARTITION_TEST_PORT").unwrap_or_else(|_| "13306".into())),
    );
    options.insert(
        "database".into(),
        json!(std::env::var("PARTITION_TEST_DATABASE").unwrap_or_else(|_| "testdb".into())),
    );
    options.insert(
        "user".into(),
        json!(std::env::var("PARTITION_TEST_USER").unwrap_or_else(|_| "dbstudio".into())),
    );
    Some(ConnectionConfig {
        dialect_id: "mysql".into(),
        name: "partition-metadata".into(),
        options,
    })
}

#[test]
fn describe_table_reports_real_mysql_partitions() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");

    for sql in [
        "DROP TABLE IF EXISTS partition_meta_demo",
        "CREATE TABLE partition_meta_demo (id INT NOT NULL, created DATE NOT NULL, PRIMARY KEY (id, created)) PARTITION BY RANGE (YEAR(created)) (PARTITION p2024 VALUES LESS THAN (2025), PARTITION p2025 VALUES LESS THAN (2026), PARTITION pmax VALUES LESS THAN MAXVALUE)",
    ] {
        driver
            .call("executeStatement", vec![json!(sql), json!({})])
            .expect("建立分区表失败");
    }

    let described = driver
        .call("describeTable", vec![json!("table:testdb.partition_meta_demo")])
        .expect("读取分区表元数据失败");
    let partitions = described.get("partitions").expect("分区表必须返回 partitions");
    assert_eq!(
        partitions.get("method").and_then(|value| value.as_str()),
        Some("RANGE"),
        "分区方法应为 RANGE：{partitions}"
    );
    let items = partitions
        .get("items")
        .and_then(|value| value.as_array())
        .expect("partitions.items 必须是数组");
    let names: Vec<&str> = items
        .iter()
        .filter_map(|item| item.get("name").and_then(|value| value.as_str()))
        .collect();
    assert_eq!(names, vec!["p2024", "p2025", "pmax"], "分区名与顺序必须与真实库一致");
    let pmax = items
        .iter()
        .find(|item| item.get("name").and_then(|value| value.as_str()) == Some("pmax"))
        .expect("缺少 pmax 分区");
    assert_eq!(
        pmax.get("description").and_then(|value| value.as_str()),
        Some("MAXVALUE"),
        "pmax 的边界应为 MAXVALUE"
    );

    for sql in [
        "DROP TABLE IF EXISTS partition_meta_plain",
        "CREATE TABLE partition_meta_plain (id INT PRIMARY KEY) ENGINE=InnoDB",
    ] {
        driver
            .call("executeStatement", vec![json!(sql), json!({})])
            .expect("建立普通表失败");
    }
    let plain = driver
        .call("describeTable", vec![json!("table:testdb.partition_meta_plain")])
        .expect("读取普通表元数据失败");
    assert!(
        plain.get("partitions").is_none(),
        "非分区表不应伪造 partitions：{plain}"
    );

    for sql in [
        "DROP TABLE IF EXISTS partition_meta_demo",
        "DROP TABLE IF EXISTS partition_meta_plain",
    ] {
        let _ = driver.call("executeStatement", vec![json!(sql), json!({})]);
    }
}

/// 子分区表在信息架构里每个子分区一行，
/// 分区列表必须按分区名去重，否则目录树会出现重复节点。
#[test]
fn subpartitioned_table_reports_each_partition_once() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let table = format!("sub_demo_{}", std::process::id() % 10000);

    for sql in [
        format!("DROP TABLE IF EXISTS {table}"),
        format!(
            "CREATE TABLE {table} (id INT, d DATE) PARTITION BY RANGE (YEAR(d)) \
             SUBPARTITION BY HASH (id) SUBPARTITIONS 2 (PARTITION p2024 VALUES LESS THAN (2025))"
        ),
    ] {
        driver
            .call("executeStatement", vec![json!(sql), json!({})])
            .unwrap_or_else(|error| panic!("准备失败：{sql} -> {error:?}"));
    }

    let described = driver
        .call("describeTable", vec![json!(format!("table:testdb.{table}"))])
        .expect("读取表结构失败");
    let items = described
        .get("partitions")
        .and_then(|value| value.get("items"))
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let names: Vec<&str> = items.iter().filter_map(|item| item.get("name").and_then(Value::as_str)).collect();
    assert_eq!(names, vec!["p2024"], "分区必须只出现一次：{names:?}");
    assert_eq!(
        items[0].get("subpartitionCount").and_then(Value::as_u64),
        Some(2),
        "必须记录子分区个数：{items:?}"
    );

    driver
        .call("executeStatement", vec![json!(format!("DROP TABLE IF EXISTS {table}")), json!({})])
        .expect("清理失败");
}
