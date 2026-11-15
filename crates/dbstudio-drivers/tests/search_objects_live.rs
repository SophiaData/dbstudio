//! 真实 MySQL 的模式搜索验收：跨库查表/视图/列/例程/触发器，含通配符转义与边界。
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
        name: "search".into(),
        options,
    })
}

fn items(result: &serde_json::Value) -> Vec<&serde_json::Value> {
    result
        .get("items")
        .and_then(|value| value.as_array())
        .map(|list| list.iter().collect())
        .unwrap_or_default()
}

#[test]
fn search_finds_real_tables_views_columns_and_routines() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let token = format!("zqsearch{}", std::process::id() % 10000);

    for sql in [
        format!("DROP VIEW IF EXISTS {token}_view"),
        format!("DROP PROCEDURE IF EXISTS {token}_proc"),
        format!("DROP TABLE IF EXISTS {token}_table"),
        format!("CREATE TABLE {token}_table (id INT NOT NULL PRIMARY KEY, {token}_col VARCHAR(16))"),
        format!("CREATE VIEW {token}_view AS SELECT id FROM {token}_table"),
        format!("CREATE PROCEDURE {token}_proc() SELECT 1"),
    ] {
        driver
            .call("executeStatement", vec![json!(sql), json!({})])
            .unwrap_or_else(|error| panic!("准备失败：{sql} -> {error:?}"));
    }

    // 表与视图。
    let found = driver
        .call("searchObjects", vec![json!({"keyword": token})])
        .expect("搜索失败");
    let found_items = items(&found);
    let names: Vec<&str> = found_items
        .iter()
        .filter_map(|item| item.get("name").and_then(|value| value.as_str()))
        .collect();
    assert!(names.contains(&format!("{token}_table").as_str()), "必须搜到表：{names:?}");
    assert!(names.contains(&format!("{token}_view").as_str()), "必须搜到视图：{names:?}");
    assert!(names.contains(&format!("{token}_proc").as_str()), "必须搜到例程：{names:?}");
    let kinds: Vec<&str> = found_items
        .iter()
        .filter_map(|item| item.get("kind").and_then(|value| value.as_str()))
        .collect();
    assert!(kinds.contains(&"view"), "视图必须被标记为 view：{kinds:?}");
    assert!(kinds.contains(&"routine"), "例程必须被标记为 routine：{kinds:?}");

    // 只搜列。
    let columns_only = driver
        .call("searchObjects", vec![json!({"keyword": format!("{token}_col"), "kinds": ["column"]})])
        .expect("列搜索失败");
    let column_items = items(&columns_only);
    assert_eq!(column_items.len(), 1, "应只命中一列：{column_items:?}");
    assert_eq!(column_items[0].get("kind").and_then(|v| v.as_str()), Some("column"));
    assert_eq!(column_items[0].get("table").and_then(|v| v.as_str()), Some(format!("{token}_table").as_str()));
    assert!(column_items[0].get("nodeId").is_some(), "列结果必须带可跳转的 nodeId");

    // 库过滤：指定不存在的库应查无结果。
    let scoped = driver
        .call("searchObjects", vec![json!({"keyword": token, "schema": "mysql"})])
        .expect("按库过滤失败");
    assert!(items(&scoped).is_empty(), "限定库后不应命中 testdb 的对象");

    for sql in [
        format!("DROP VIEW IF EXISTS {token}_view"),
        format!("DROP PROCEDURE IF EXISTS {token}_proc"),
        format!("DROP TABLE IF EXISTS {token}_table"),
    ] {
        driver
            .call("executeStatement", vec![json!(sql), json!({})])
            .unwrap_or_else(|error| panic!("清理失败：{sql} -> {error:?}"));
    }
}

#[test]
fn search_escapes_wildcards_and_rejects_invalid_input() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let token = format!("zqesc{}", std::process::id() % 10000);

    driver
        .call(
            "executeStatement",
            vec![json!(format!("CREATE TABLE {token}_100 (id INT PRIMARY KEY)")), json!({})],
        )
        .expect("建表失败");
    // 对照表：名字里的 _ 位置是数字 7。若下方用模式通配符而非字面量，
    // 它会把这张表也命中，从而暴露转义失效。
    driver
        .call(
            "executeStatement",
            vec![json!(format!("CREATE TABLE {token}7100 (id INT PRIMARY KEY)")), json!({})],
        )
        .expect("建对照表失败");

    // `_` 是 LIKE 通配符；按字面量搜索时不应命中 `{token}X100` 这类名字。
    let underscore = driver
        .call("searchObjects", vec![json!({"keyword": format!("{token}_100")})])
        .expect("搜索失败");
    let names: Vec<&str> = items(&underscore)
        .iter()
        .filter_map(|item| item.get("name").and_then(|value| value.as_str()))
        .collect();
    assert!(names.contains(&format!("{token}_100").as_str()), "按字面量必须命中：{names:?}");
    assert!(
        !names.contains(&format!("{token}7100").as_str()),
        "_ 必须按字面量处理，不能当通配符：{names:?}"
    );

    // 空关键字与非法类型必须被拒绝。
    driver.call("searchObjects", vec![json!({"keyword": "   "})]).expect_err("空关键字必须被拒绝");
    driver
        .call("searchObjects", vec![json!({"keyword": "x", "kinds": ["fk_column"]})])
        .expect_err("非法对象类型必须被拒绝");
    driver
        .call("searchObjects", vec![json!({"keyword": "x", "schema": "bad`schema"})])
        .expect_err("非法库名必须被拒绝");

    // 结果上限生效。
    let limited = driver
        .call("searchObjects", vec![json!({"keyword": "a", "limit": 5})])
        .expect("限量搜索失败");
    assert!(items(&limited).len() <= 5, "结果不得超过 limit");

    for sql in [
        format!("DROP TABLE IF EXISTS {token}_100"),
        format!("DROP TABLE IF EXISTS {token}7100"),
    ] {
        driver
            .call("executeStatement", vec![json!(sql), json!({})])
            .expect("清理失败");
    }
}

/// 搜索结果的 nodeId 必须能被 unescape_parts 还原：
/// 名字里带点或反斜杠时，未转义的 nodeId 会被拆成多段。
#[test]
fn search_node_ids_survive_dots_in_identifiers() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let token = format!("zqdot{}", std::process::id() % 10000);
    // MySQL 允许引号包裹的名字含点；_id 属于视图时必须标成 view。
    let table = format!("{token}.table");

    for sql in [
        format!("DROP TABLE IF EXISTS `{table}`"),
        format!("DROP VIEW IF EXISTS `{token}.view`"),
        format!("CREATE TABLE `{table}` (id INT NOT NULL PRIMARY KEY, {token}_col INT)"),
        format!("CREATE VIEW `{token}.view` AS SELECT id, {token}_col FROM `{table}`"),
    ] {
        driver
            .call("executeStatement", vec![json!(sql), json!({})])
            .unwrap_or_else(|error| panic!("准备失败：{sql} -> {error:?}"));
    }

    let found = driver
        .call("searchObjects", vec![json!({"keyword": token})])
        .expect("搜索失败");
    let items = found.get("items").and_then(|value| value.as_array()).cloned().unwrap_or_default();

    let table_item = items
        .iter()
        .find(|item| item.get("kind").and_then(|v| v.as_str()) == Some("table"))
        .expect("必须搜到表");
    assert_eq!(
        table_item.get("nodeId").and_then(|v| v.as_str()),
        Some(format!("table:{}.{}", schema_name(), table.replace('.', "\\.")).as_str()),
        "表 nodeId 必须转义名字里的点：{table_item:?}"
    );

    let column_item = items
        .iter()
        .find(|item| item.get("kind").and_then(|v| v.as_str()) == Some("column")
            && item.get("name").and_then(|v| v.as_str()) == Some(format!("{token}_col").as_str()))
        .expect("必须搜到列");
    let column_node = column_item.get("nodeId").and_then(|v| v.as_str()).unwrap_or_default();
    assert!(
        column_node.starts_with("table:"),
        "表的列 nodeId 应指向 table：{column_node}"
    );

    // 视图的列必须标成 view。
    let view_found = driver
        .call("searchObjects", vec![json!({"keyword": "view", "kinds": ["column"], "schema": schema_name()})])
        .expect("搜索失败");
    let view_columns = view_found.get("items").and_then(|value| value.as_array()).cloned().unwrap_or_default();
    assert!(
        view_columns
            .iter()
            .filter(|item| item.get("table").and_then(|v| v.as_str()) == Some(format!("{token}.view").as_str()))
            .all(|item| item.get("nodeId").and_then(|v| v.as_str()).is_some_and(|id| id.starts_with("view:"))),
        "视图的列 nodeId 必须以 view: 开头：{view_columns:?}"
    );

    for sql in [
        format!("DROP VIEW IF EXISTS `{token}.view`"),
        format!("DROP TABLE IF EXISTS `{table}`"),
    ] {
        driver
            .call("executeStatement", vec![json!(sql), json!({})])
            .unwrap_or_else(|error| panic!("清理失败：{sql} -> {error:?}"));
    }
}
