//! 真实 MySQL 的分区管理验收：读取、追加、拆分与删除分区。
//!
//! 连接参数来自环境变量；未配置时显式跳过。每一步都断言真实库的 information_schema
//! 结果，而不是只看驱动自己的回显。

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
        name: "partition-admin".into(),
        options,
    })
}

fn partition_names(described: &serde_json::Value) -> Vec<String> {
    described
        .get("partitions")
        .and_then(|partitions| partitions.get("items"))
        .and_then(|items| items.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("name").and_then(|value| value.as_str()).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn partition_ddl_adds_reorganizes_and_drops_real_partitions() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let table = "table:testdb.partition_admin_demo";

    driver
        .call("executeStatement", vec![json!("DROP TABLE IF EXISTS partition_admin_demo"), json!({})])
        .expect("清理旧表失败");
    driver
        .call(
            "executeStatement",
            vec![
                json!("CREATE TABLE partition_admin_demo (id INT NOT NULL, created DATE NOT NULL, PRIMARY KEY (id, created)) PARTITION BY RANGE (YEAR(created)) (PARTITION p2024 VALUES LESS THAN (2025))"),
                json!({}),
            ],
        )
        .expect("建立分区表失败");
    assert_eq!(
        partition_names(&driver.call("describeTable", vec![json!(table)]).unwrap()),
        vec!["p2024"]
    );

    // 此时没有 MAXVALUE 尾分区，真实 MySQL 允许直接追加。
    driver
        .call(
            "partitionTable",
            vec![json!(table), json!({"action": "add", "name": "pmax", "lessThan": "MAXVALUE"})],
        )
        .expect("追加 MAXVALUE 分区失败");
    assert_eq!(
        partition_names(&driver.call("describeTable", vec![json!(table)]).unwrap()),
        vec!["p2024", "pmax"]
    );

    // MySQL 语义：已有 MAXVALUE 尾分区时不能再直接 ADD，只能 REORGANIZE 拆分。
    driver
        .call(
            "partitionTable",
            vec![json!(table), json!({"action": "add", "name": "p2025", "lessThan": "2026"})],
        )
        .expect_err("已有 MAXVALUE 尾分区时追加必须被真实 MySQL 拒绝");

    driver
        .call(
            "partitionTable",
            vec![
                json!(table),
                json!({"action": "reorganize", "name": "pmax", "into": [
                    {"name": "p2025", "lessThan": "2026"},
                    {"name": "pmax", "lessThan": "MAXVALUE"}
                ]}),
            ],
        )
        .expect("拆分分区失败");
    assert_eq!(
        partition_names(&driver.call("describeTable", vec![json!(table)]).unwrap()),
        vec!["p2024", "p2025", "pmax"]
    );

    driver
        .call("partitionTable", vec![json!(table), json!({"action": "drop", "name": "p2025"})])
        .expect("删除分区失败");
    assert_eq!(
        partition_names(&driver.call("describeTable", vec![json!(table)]).unwrap()),
        vec!["p2024", "pmax"]
    );

    driver
        .call("executeStatement", vec![json!("DROP TABLE IF EXISTS partition_admin_demo"), json!({})])
        .expect("清理分区表失败");
}

#[test]
fn partition_ddl_rejects_injected_names_and_bounds() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let table = "table:testdb.partition_injection_demo";
    driver
        .call(
            "executeStatement",
            vec![
                json!("CREATE TABLE IF NOT EXISTS partition_injection_demo (id INT NOT NULL, PRIMARY KEY (id)) PARTITION BY RANGE (id) (PARTITION p0 VALUES LESS THAN (100))"),
                json!({}),
            ],
        )
        .expect("建立分区表失败");

    for spec in [
        json!({"action": "add", "name": "p1) ; DROP TABLE users; --", "lessThan": "200"}),
        json!({"action": "add", "name": "p1", "lessThan": "200); DROP TABLE users; --"}),
        json!({"action": "add", "name": "p1", "lessThan": "1 OR 1=1"}),
        json!({"action": "unknown", "name": "p1", "lessThan": "200"}),
    ] {
        driver
            .call("partitionTable", vec![json!(table), spec.clone()])
            .expect_err(&format!("注入规格必须被拒绝：{spec}"));
    }

    // 合法请求仍然可用，证明拒绝不是把所有请求都挡掉。
    driver
        .call(
            "partitionTable",
            vec![json!(table), json!({"action": "add", "name": "p1", "lessThan": "200"})],
        )
        .expect("合法分区追加应成功");

    driver
        .call("executeStatement", vec![json!("DROP TABLE IF EXISTS partition_injection_demo"), json!({})])
        .expect("清理失败");
}
