//! 真实 MySQL 的索引管理验收：新增、修改（DROP+ADD 单语句）与删除索引。
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
        name: "index-admin".into(),
        options,
    })
}

fn index_names(driver: &mut Box<dyn dbstudio_protocol::Driver>, table: &str) -> Vec<(String, Vec<String>)> {
    let described = driver.call("describeTable", vec![json!(table)]).expect("读取表结构失败");
    described
        .get("indexes")
        .and_then(|value| value.as_array())
        .map(|indexes| {
            indexes
                .iter()
                .map(|index| {
                    (
                        index.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
                        index
                            .get("columns")
                            .and_then(|v| v.as_array())
                            .map(|cols| cols.iter().filter_map(|c| c.as_str().map(str::to_owned)).collect())
                            .unwrap_or_default(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn index_ddl_adds_replaces_and_drops_real_indexes() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let table = "table:testdb.index_admin_demo";

    driver
        .call("executeStatement", vec![json!("DROP TABLE IF EXISTS index_admin_demo"), json!({})])
        .expect("清理旧表失败");
    driver
        .call(
            "executeStatement",
            vec![json!("CREATE TABLE index_admin_demo (id INT NOT NULL PRIMARY KEY, a INT, b INT, c INT)"), json!({})],
        )
        .expect("建表失败");

    // 新增复合索引。
    driver
        .call(
            "indexTable",
            vec![json!(table), json!({"action": "add", "name": "idx_a", "columns": ["a"]})],
        )
        .expect("新增索引失败");
    assert!(
        index_names(&mut driver, table).iter().any(|(name, columns)| name == "idx_a" && columns == &vec!["a".to_owned()]),
        "idx_a 必须出现在真实索引里"
    );

    // 修改既有索引：单语句 DROP+ADD，中间不出现无索引窗口。
    let replaced = driver
        .call(
            "indexTable",
            vec![json!(table), json!({"action": "replace", "name": "idx_a", "newName": "idx_ab", "columns": ["a", "b"]})],
        )
        .expect("修改索引失败");
    let executed = replaced.get("executedSql").and_then(|v| v.as_str()).unwrap_or_default();
    assert!(
        executed.contains("DROP INDEX") && executed.contains("ADD INDEX"),
        "修改必须是单条 ALTER：{executed}"
    );
    let after = index_names(&mut driver, table);
    assert!(after.iter().any(|(name, columns)| name == "idx_ab" && columns == &vec!["a".to_owned(), "b".to_owned()]), "idx_ab 必须存在：{after:?}");
    assert!(!after.iter().any(|(name, _)| name == "idx_a"), "旧索引必须已删除：{after:?}");

    // 删除索引。
    driver
        .call("indexTable", vec![json!(table), json!({"action": "drop", "name": "idx_ab"})])
        .expect("删除索引失败");
    assert!(!index_names(&mut driver, table).iter().any(|(name, _)| name == "idx_ab"), "idx_ab 应已删除");

    driver
        .call("executeStatement", vec![json!("DROP TABLE IF EXISTS index_admin_demo"), json!({})])
        .expect("清理失败");
}

#[test]
fn index_ddl_rejects_injected_names_columns_and_unknown_actions() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let table = "table:testdb.index_injection_demo";
    driver
        .call(
            "executeStatement",
            vec![json!("CREATE TABLE IF NOT EXISTS index_injection_demo (id INT PRIMARY KEY, a INT)"), json!({})],
        )
        .expect("建表失败");

    for spec in [
        json!({"action": "add", "name": "idx`) ; DROP TABLE x; --", "columns": ["a"]}),
        json!({"action": "add", "name": "idx_ok", "columns": ["a`) ; DROP TABLE x; --"]}),
        json!({"action": "add", "name": "idx_ok", "columns": []}),
        json!({"action": "add", "name": "idx_ok"}),
        json!({"action": "truncate", "name": "idx_ok", "columns": ["a"]}),
    ] {
        driver
            .call("indexTable", vec![json!(table), spec.clone()])
            .expect_err(&format!("注入或非法规格必须被拒绝：{spec}"));
    }

    // 合法请求仍然可用，证明拒绝不是一刀切。
    driver
        .call(
            "indexTable",
            vec![json!(table), json!({"action": "add", "name": "idx_ok", "columns": ["a"]})],
        )
        .expect("合法索引新增应成功");

    driver
        .call("executeStatement", vec![json!("DROP TABLE IF EXISTS index_injection_demo"), json!({})])
        .expect("清理失败");
}
