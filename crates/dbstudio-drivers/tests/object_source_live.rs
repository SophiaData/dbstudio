//! 真实 MySQL 的建库与对象源码读取验收。
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
        name: "source-admin".into(),
        options,
    })
}

#[test]
fn create_database_creates_real_database_and_rejects_injection() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let name = format!("dbstudio_probe_{}", std::process::id() % 100000);

    for spec in [
        json!("bad-name`; DROP DATABASE testdb; --"),
        json!("has space"),
        json!(""),
        json!("bad.name"),
    ] {
        driver
            .call("createDatabase", vec![spec.clone()])
            .expect_err(&format!("非法库名必须被拒绝：{spec}"));
    }

    driver
        .call("createDatabase", vec![json!(name), json!({})])
        .expect("建库失败");

    // 从真实库确认库已存在。
    let schemas = driver.call("listChildren", vec![json!(null)]).expect("列库失败");
    assert!(schemas.is_array(), "根节点必须是数组");
    let described = driver
        .call("executeStatement", vec![json!(format!("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '{name}'")), json!({})]);
    assert!(described.is_ok(), "核对建库结果失败：{described:?}");

    // 清理：只删本次新建的库。
    driver
        .call("executeStatement", vec![json!(format!("DROP DATABASE IF EXISTS `{name}`")), json!({})])
        .expect("清理失败");
}

#[test]
fn object_source_reads_real_routine_view_and_trigger_text() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");

    for sql in [
        "DROP VIEW IF EXISTS source_view_demo",
        "DROP TRIGGER IF EXISTS source_trigger_demo",
        "DROP PROCEDURE IF EXISTS source_routine_demo",
        "DROP TABLE IF EXISTS source_table_demo",
        "CREATE TABLE source_table_demo (id INT NOT NULL PRIMARY KEY, value INT)",
        "CREATE VIEW source_view_demo AS SELECT id FROM source_table_demo WHERE value > 0",
        "CREATE TRIGGER source_trigger_demo BEFORE INSERT ON source_table_demo FOR EACH ROW SET NEW.value = COALESCE(NEW.value, 0)",
        "CREATE PROCEDURE source_routine_demo() SELECT COUNT(*) FROM source_table_demo",
    ] {
        driver
            .call("executeStatement", vec![json!(sql), json!({})])
            .expect(&format!("准备对象失败：{sql}"));
    }

    let view = driver
        .call("objectSource", vec![json!("view:testdb.source_view_demo")])
        .expect("读取视图源码失败");
    let view_sql = view.get("sql").and_then(|v| v.as_str()).unwrap_or_default();
    assert!(view_sql.contains("source_table_demo"), "视图源码必须来自真实库：{view_sql}");

    let routine = driver
        .call("objectSource", vec![json!("routine:testdb.PROCEDURE.source_routine_demo")])
        .expect("读取例程源码失败");
    let definition = routine.get("definition").and_then(|v| v.as_str()).unwrap_or_default();
    assert!(definition.contains("COUNT"), "例程源码必须来自真实库：{definition}");
    assert_eq!(routine.get("routineType").and_then(|v| v.as_str()), Some("PROCEDURE"));

    let trigger = driver
        .call("objectSource", vec![json!("trigger:testdb.source_trigger_demo")])
        .expect("读取触发器源码失败");
    assert_eq!(trigger.get("timing").and_then(|v| v.as_str()), Some("BEFORE"));
    assert_eq!(trigger.get("event").and_then(|v| v.as_str()), Some("INSERT"));
    assert!(
        trigger.get("statement").and_then(|v| v.as_str()).is_some_and(|text| text.contains("NEW.value")),
        "触发器语句必须来自真实库：{trigger:?}"
    );

    // 不存在的对象必须明确报错，不能返回空源码。
    driver
        .call("objectSource", vec![json!("routine:testdb.PROCEDURE.not_exists")])
        .expect_err("不存在的例程必须报错");

    for sql in [
        "DROP TRIGGER IF EXISTS source_trigger_demo",
        "DROP VIEW IF EXISTS source_view_demo",
        "DROP PROCEDURE IF EXISTS source_routine_demo",
        "DROP TABLE IF EXISTS source_table_demo",
    ] {
        driver
            .call("executeStatement", vec![json!(sql), json!({})])
            .expect("清理失败");
    }
}
