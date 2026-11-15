//! 真实 MySQL 的会话进程管理验收：列表、当前会话标记与终止。
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

/// 当前测试账号：本机与 CI 夹具不同，不能写死。
fn account_name() -> String {
    std::env::var("PARTITION_TEST_USER").unwrap_or_else(|_| "dbstudio".into())
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
fn list_sessions_reports_real_processlist_and_marks_current() {
    let Some(config) = test_config("session-a") else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");

    let sessions = driver.call("listSessions", vec![]).expect("读取会话列表失败");
    let items = sessions.as_array().expect("会话列表必须是数组");
    assert!(!items.is_empty(), "至少应看到当前连接自己这一条会话");

    let current: Vec<&serde_json::Value> = items
        .iter()
        .filter(|item| item.get("current").and_then(|v| v.as_bool()) == Some(true))
        .collect();
    assert_eq!(current.len(), 1, "必须且只能标记一条当前会话");
    let me = current[0];
    assert!(me.get("id").and_then(|v| v.as_u64()).is_some(), "会话必须带数值 id");
    assert_eq!(
        me.get("user").and_then(|v| v.as_str()),
        Some(account_name().as_str()),
        "当前会话的 user 必须与连接账号一致"
    );
    assert!(
        me.get("host").and_then(|v| v.as_str()).is_some_and(|host| !host.is_empty()),
        "会话必须带来源 host"
    );
    assert_eq!(
        me.get("database").and_then(|v| v.as_str()),
        Some(schema_name().as_str()),
        "会话应报告当前库"
    );
}

#[test]
fn kill_session_terminates_another_connection_and_refuses_self() {
    let Some(config) = test_config("session-killer") else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut killer = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let mut victim = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");

    let self_id = killer
        .call("listSessions", vec![])
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item.get("current").and_then(|v| v.as_bool()) == Some(true))
        .and_then(|item| item.get("id").and_then(|v| v.as_u64()))
        .expect("必须能定位自身会话");

    killer
        .call("killSession", vec![json!(self_id)])
        .expect_err("终止自身会话必须被拒绝");

    let before = killer.call("listSessions", vec![]).unwrap().as_array().unwrap().len();
    assert!(before >= 2, "两个连接应产生至少两条会话：{before}");

    // 找出 victim 的会话：它一定不是 killer 自己的那条。
    let victim_id = killer
        .call("listSessions", vec![])
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item.get("current").and_then(|v| v.as_bool()) != Some(true))
        .filter_map(|item| item.get("id").and_then(|v| v.as_u64()))
        .max()
        .expect("必须能找到其它连接");

    killer
        .call("killSession", vec![json!(victim_id)])
        .expect("终止另一条连接失败");

    // victim 被杀后，下一次调用必须失败（真实库侧已断开）。
    let after = victim.call("listSessions", vec![]);
    assert!(after.is_err(), "被终止的连接不应还能正常工作");
}
