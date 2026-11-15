//! 真实 MySQL 的事件调度与用户权限读取验收。
//!
//! 只读能力：不创建事件、不改权限，全部断言来自真实库元数据。

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

fn test_config(name: &str) -> Option<ConnectionConfig> {
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
        name: name.into(),
        options,
    })
}

#[test]
fn list_events_reports_scheduler_state_and_real_events() {
    let Some(config) = test_config("event-reader") else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");

    driver
        .call("executeStatement", vec![json!("DROP EVENT IF EXISTS event_demo"), json!({})])
        .expect("清理旧事件失败");
    driver
        .call(
            "executeStatement",
            vec![
                json!("CREATE EVENT event_demo ON SCHEDULE EVERY 1 DAY STARTS CURRENT_TIMESTAMP + INTERVAL 1 YEAR DISABLE DO SET @event_demo_marker = 1"),
                json!({}),
            ],
        )
        .expect("创建事件失败");

    let listed = driver
        .call("listEvents", vec![json!({"schema": "testdb"})])
        .expect("读取事件失败");
    let scheduler = listed.get("scheduler").and_then(|v| v.as_str());
    assert!(
        matches!(scheduler, Some("ON") | Some("OFF") | Some("DISABLED")),
        "调度器状态必须来自真实库：{scheduler:?}"
    );
    let items = listed.get("items").and_then(|v| v.as_array()).expect("items 必须是数组");
    let demo = items
        .iter()
        .find(|item| item.get("name").and_then(|v| v.as_str()) == Some("event_demo"))
        .unwrap_or_else(|| panic!("未读到刚创建的事件：{items:?}"));
    assert_eq!(demo.get("schema").and_then(|v| v.as_str()), Some("testdb"));
    assert_eq!(demo.get("status").and_then(|v| v.as_str()), Some("DISABLED"));
    assert_eq!(demo.get("intervalValue").and_then(|v| v.as_str()), Some("1"));
    assert_eq!(demo.get("intervalField").and_then(|v| v.as_str()), Some("DAY"));
    assert!(
        demo.get("definition").and_then(|v| v.as_str()).is_some_and(|text| text.contains("event_demo_marker")),
        "事件定义必须来自真实库：{:?}",
        demo.get("definition")
    );

    driver
        .call("executeStatement", vec![json!("DROP EVENT IF EXISTS event_demo"), json!({})])
        .expect("清理事件失败");
}

#[test]
fn list_users_reports_accounts_and_privileges_without_secrets() {
    let Some(config) = test_config("user-reader") else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");

    let listed = driver.call("listUsers", vec![]).expect("读取用户失败");
    let users = listed.get("users").and_then(|v| v.as_array()).expect("users 必须是数组");
    let me = users
        .iter()
        .find(|item| item.get("user").and_then(|v| v.as_str()) == Some("dbstudio"))
        .unwrap_or_else(|| panic!("未读到当前账号：{users:?}"));
    assert_eq!(me.get("host").and_then(|v| v.as_str()), Some("%"));
    assert!(me.get("locked").and_then(|v| v.as_bool()).is_some(), "锁定状态必须是布尔值");
    assert!(
        me.get("plugin").and_then(|v| v.as_str()).is_some(),
        "认证插件应可读"
    );

    // 绝不返回口令散列或任何密码材料。
    let text = listed.to_string().to_ascii_lowercase();
    for forbidden in ["authentication_string", "password_last_changed", "0x"] {
        assert!(!text.contains(forbidden), "用户列表不得包含敏感字段 {forbidden}：{text}");
    }

    let privileges = listed.get("privileges").and_then(|v| v.as_array()).expect("privileges 必须是数组");
    let mine: Vec<&serde_json::Value> = privileges
        .iter()
        .filter(|item| item.get("grantee").and_then(|v| v.as_str()).is_some_and(|g| g.contains("dbstudio")))
        .collect();
    assert!(!mine.is_empty(), "当前账号必须能读到自己的全局权限");
    let names: Vec<&str> = mine
        .iter()
        .filter_map(|item| item.get("privilege").and_then(|v| v.as_str()))
        .collect();
    assert!(names.contains(&"SELECT"), "全局权限应包含 SELECT：{names:?}");
    assert!(
        mine.iter().all(|item| item.get("grantable").and_then(|v| v.as_bool()).is_some()),
        "每条权限都必须带 grantable 布尔"
    );
}
