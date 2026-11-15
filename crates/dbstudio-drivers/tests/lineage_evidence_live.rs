//! 真实 MySQL 的字段血缘证据验收：外键、列清单与视图定义必须来自真实库。
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
        name: "lineage".into(),
        options,
    })
}

#[test]
fn lineage_evidence_reports_real_foreign_keys_columns_and_views() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let token = format!("zqlin{}", std::process::id() % 10000);
    let parent = format!("{token}_parent");
    let child = format!("{token}_child");

    for sql in [
        format!("DROP VIEW IF EXISTS {token}_view"),
        format!("DROP TABLE IF EXISTS {child}"),
        format!("DROP TABLE IF EXISTS {parent}"),
        format!("CREATE TABLE {parent} (id INT NOT NULL PRIMARY KEY, code VARCHAR(16), {token}_col INT)"),
        format!(
            "CREATE TABLE {child} (id INT NOT NULL PRIMARY KEY, parent_id INT, CONSTRAINT fk_{token} \
             FOREIGN KEY (parent_id) REFERENCES {parent} (id))"
        ),
        format!("CREATE VIEW {token}_view AS SELECT id, parent_id FROM {child}"),
    ] {
        driver
            .call("executeStatement", vec![json!(sql), json!({})])
            .unwrap_or_else(|error| panic!("准备失败：{sql} -> {error:?}"));
    }

    // 子列方向：child.parent_id -> parent.id 必须是出边外键。
    let child_evidence = driver
        .call(
            "lineageEvidence",
            vec![json!({"schema": schema_name(), "table": child, "column": "parent_id"})],
        )
        .expect("读取血缘证据失败");
    let keys = child_evidence
        .get("foreignKeys")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    assert!(
        keys.iter().any(|key| key["direction"] == json!("outgoing")
            && key["refTable"] == json!(parent)
            && key["refColumn"] == json!("id")),
        "必须报告出边外键：{keys:?}"
    );

    // 父列方向：parent.id 必须被识别为入边外键目标。
    let parent_evidence = driver
        .call(
            "lineageEvidence",
            vec![json!({"schema": schema_name(), "table": parent, "column": "id"})],
        )
        .expect("读取父表血缘失败");
    let parent_keys = parent_evidence
        .get("foreignKeys")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    assert!(
        parent_keys.iter().any(|key| key["direction"] == json!("incoming") && key["table"] == json!(child)),
        "必须报告入边外键：{parent_keys:?}"
    );

    // 视图定义必须来自真实库且包含目标表。
    let views = parent_evidence
        .get("views")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    assert!(
        views.iter().any(|view| view["name"] == json!(format!("{token}_view"))
            && view["ddl"].as_str().is_some_and(|ddl| ddl.contains(&child))),
        "视图定义必须来自真实库：{views:?}"
    );

    // 列清单必须覆盖两张表。
    let tables = parent_evidence
        .get("tables")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    assert!(tables.iter().any(|table| table["name"] == json!(parent)), "必须包含父表列清单");
    assert!(tables.iter().any(|table| table["name"] == json!(child)), "必须包含子表列清单");

    for sql in [
        format!("DROP VIEW IF EXISTS {token}_view"),
        format!("DROP TABLE IF EXISTS {child}"),
        format!("DROP TABLE IF EXISTS {parent}"),
    ] {
        driver
            .call("executeStatement", vec![json!(sql), json!({})])
            .unwrap_or_else(|error| panic!("清理失败：{sql} -> {error:?}"));
    }
}

#[test]
fn lineage_evidence_rejects_missing_or_injected_input() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");

    driver.call("lineageEvidence", vec![json!({})]).expect_err("缺表名列名必须被拒绝");
    driver
        .call("lineageEvidence", vec![json!({"table": "g2"})])
        .expect_err("缺列名必须被拒绝");
    driver
        .call(
            "lineageEvidence",
            vec![json!({"schema": "bad`schema", "table": "g2", "column": "id"})],
        )
        .expect_err("非法库名必须被拒绝");
}
