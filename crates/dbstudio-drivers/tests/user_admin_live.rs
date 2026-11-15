//! 真实 MySQL 的用户管理写操作验收：建号、授权、回收、删号与注入防护。
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
        name: "user-admin".into(),
        options,
    })
}

fn listed_users(driver: &mut Box<dyn dbstudio_protocol::Driver>) -> Vec<(String, String)> {
    let listed = driver.call("listUsers", vec![json!({})]).expect("读取用户失败");
    listed
        .get("users")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    (
                        item.get("user").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
                        item.get("host").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn user_management_creates_grants_revokes_and_drops_real_account() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");
    let account = format!("probe_user_{}", std::process::id() % 10000);

    driver
        .call("dropUser", vec![json!(account.as_str()), json!("%")])
        .ok();

    driver
        .call("createUser", vec![json!(account.as_str()), json!("%"), json!("Probe#Passw0rd1")])
        .expect("建号失败");
    let users = listed_users(&mut driver);
    assert!(
        users.iter().any(|(user, _)| user == &account),
        "新建账号必须出现在真实用户列表：{users:?}"
    );

    // 只给 testdb 的只读权限，必须真的生效。
    driver
        .call(
            "grantPrivilege",
            vec![
                json!(account.as_str()),
                json!("%"),
                json!(["SELECT"]),
                json!({"kind": "database", "database": "testdb"}),
                json!({}),
            ],
        )
        .expect("授权失败");

    let grants = driver
        .call("executeStatement", vec![json!(format!("SHOW GRANTS FOR '{account}'@'%'")), json!({})])
        .expect("读取授权失败");
    let rendered = grants.to_string();
    assert!(rendered.contains("SELECT"), "授权必须真实生效：{rendered}");
    assert!(rendered.contains("testdb"), "授权必须落在 testdb：{rendered}");

    driver
        .call(
            "revokePrivilege",
            vec![
                json!(account.as_str()),
                json!("%"),
                json!(["SELECT"]),
                json!({"kind": "database", "database": "testdb"}),
            ],
        )
        .expect("回收权限失败");
    let grants_after = driver
        .call("executeStatement", vec![json!(format!("SHOW GRANTS FOR '{account}'@'%'")), json!({})])
        .expect("读取授权失败");
    assert!(
        !grants_after.to_string().contains("SELECT"),
        "回收后不应再有 SELECT：{}",
        grants_after
    );

    driver
        .call("dropUser", vec![json!(account.as_str()), json!("%")])
        .expect("删号失败");
    assert!(
        !listed_users(&mut driver).iter().any(|(user, _)| user == &account),
        "删号后不应再出现在用户列表"
    );
}

#[test]
fn user_management_rejects_injection_and_unknown_privileges() {
    let Some(config) = test_config() else {
        eprintln!("跳过：未设置 PARTITION_TEST_HOST");
        return;
    };
    let mut driver = dbstudio_drivers::connect(&config, &secret_map()).expect("连接测试库失败");

    for user in ["bad`user", "bad user", "bad'; DROP USER x; --", ""] {
        driver
            .call("createUser", vec![json!(user), json!("%"), json!("x")])
            .expect_err(&format!("非法账号名必须被拒绝：{user}"));
    }
    for host in ["bad host", "host'quote", ""] {
        driver
            .call("createUser", vec![json!("ok_user"), json!(host), json!("x")])
            .expect_err(&format!("非法主机必须被拒绝：{host}"));
    }
    driver
        .call(
            "grantPrivilege",
            vec![
                json!("ok_user"),
                json!("%"),
                json!(["SELECT; DROP DATABASE testdb"]),
                json!({"kind": "global"}),
            ],
        )
        .expect_err("非法权限必须被拒绝");
    driver
        .call(
            "grantPrivilege",
            vec![
                json!("ok_user"),
                json!("%"),
                json!(["SELECT"]),
                json!({"kind": "unsupported"}),
            ],
        )
        .expect_err("非法授权范围必须被拒绝");
    driver
        .call(
            "grantPrivilege",
            vec![
                json!("ok_user"),
                json!("%"),
                json!(["SELECT"]),
                json!({"kind": "database", "database": "bad`db"}),
            ],
        )
        .expect_err("非法库名必须被拒绝");

    // 全库授权形态仍应可用（不实际授予，只用不存在的账号验证语句生成被拒绝）。
    driver
        .call(
            "grantPrivilege",
            vec![json!("nonexistent_probe_user"), json!("%"), json!(["SELECT"]), json!({"kind": "global"})],
        )
        .expect_err("不存在的账号授权应被 MySQL 拒绝");
}
