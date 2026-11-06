//! Compiled only with test-hooks. Never touches production paths or the OS vault.
use dbstudio_core::{AppError, SecretStore};
use dbstudio_protocol::SecretMap;
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, fs::OpenOptions, io::Write, path::PathBuf, sync::Mutex};

#[derive(Default)]
pub struct FixtureSecrets(Mutex<HashMap<String, SecretMap>>);
impl SecretStore for FixtureSecrets {
    fn get(&self, key: &str) -> Result<Option<SecretMap>, AppError> {
        Ok(self.0.lock().map_err(|_| failure())?.get(key).cloned())
    }
    fn set(&self, key: &str, value: &SecretMap) -> Result<(), AppError> {
        self.0.lock().map_err(|_| failure())?.insert(key.into(), value.clone());
        Ok(())
    }
    fn remove(&self, key: &str) -> Result<(), AppError> {
        self.0.lock().map_err(|_| failure())?.remove(key);
        Ok(())
    }
}

fn failure() -> AppError { AppError::new("internal", "原生测试回执失败") }

const REQUIRED_NATIVE_METHODS: &[&str] = &[
    "addConnection", "executeStatement", "runQuery", "fetchResultPage",
    "applyEdits", "commitTransaction", "rollbackTransaction",
];

pub struct SmokeRun {
    pub root: PathBuf,
    successful_methods: Mutex<HashSet<String>>,
}
impl SmokeRun {
    /// Root must be a NEW immediate child of OS temp, never an existing user directory.
    pub fn from_environment() -> Result<Option<Self>, AppError> {
        let Some(path) = std::env::var_os("DBSTUDIO_NATIVE_SMOKE_ROOT") else { return Ok(None) };
        let root = PathBuf::from(path);
        let temp = std::env::temp_dir().canonicalize().map_err(|_| failure())?;
        let parent = root.parent().ok_or_else(failure)?.canonicalize().map_err(|_| failure())?;
        if !root.is_absolute() || parent != temp || root.file_name().is_none() {
            return Err(failure());
        }
        std::fs::create_dir(&root).map_err(|_| failure())?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).map_err(|_| failure())?;
        }
        let fixture_db = rusqlite::Connection::open(root.join("fixture.sqlite")).map_err(|_| failure())?;
        fixture_db.execute_batch(
            "CREATE TABLE native_smoke_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\
             INSERT INTO native_smoke_fixture (id, value) VALUES (1, 'native-fixture');"
        ).map_err(|_| failure())?;
        fixture_db.close().map_err(|_| failure())?;
        let mut csv = OpenOptions::new().write(true).create_new(true)
            .open(root.join("import.csv")).map_err(|_| failure())?;
        csv.write_all(b"id,value\n901,native-import\n902,native-import-2\n").map_err(|_| failure())?;
        csv.sync_all().map_err(|_| failure())?;
        Ok(Some(Self {
            root: root.canonicalize().map_err(|_| failure())?,
            successful_methods: Mutex::new(HashSet::new()),
        }))
    }

    pub fn context(&self) -> Value {
        json!({
            "databasePath": self.root.join("fixture.sqlite"),
            "importPath": self.root.join("import.csv"),
            "exportPath": self.root.join("export.csv"),
            "isolated": true
        })
    }

    pub fn record_success(&self, method: &str) -> Result<(), AppError> {
        self.successful_methods.lock().map_err(|_| failure())?.insert(method.to_owned());
        Ok(())
    }

    /// Only bounded boolean diagnostics are accepted; no SQL, paths, cells or secrets.
    pub fn report(&self, value: &Value) -> Result<bool, AppError> {
        let record = value.as_object().ok_or_else(failure)?;
        if record.len() != 2 { return Err(failure()); }
        let ok = record.get("ok").and_then(Value::as_bool).ok_or_else(failure)?;
        let checks = record.get("checks").and_then(Value::as_object).ok_or_else(failure)?;
        if checks.is_empty() || checks.len() > 64 || checks.iter().any(|(name, value)| {
            name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') || !value.is_boolean()
        }) { return Err(failure()); }
        if ok && checks.values().any(|value| value != &Value::Bool(true)) { return Err(failure()); }
        let observed = self.successful_methods.lock().map_err(|_| failure())?;
        let native_ok = REQUIRED_NATIVE_METHODS.iter().all(|method| observed.contains(*method));
        let mut checks = checks.clone();
        for method in REQUIRED_NATIVE_METHODS {
            // Host-owned entries overwrite any similarly named frontend assertion.
            checks.insert(format!("native_{method}"), Value::Bool(observed.contains(*method)));
        }
        let passed = ok && native_ok;
        let report = json!({ "ok": passed, "checks": checks });
        let mut output = OpenOptions::new().write(true).create_new(true)
            .open(self.root.join("report.json")).map_err(|_| failure())?;
        output.write_all(serde_json::to_string(&report).map_err(|_| failure())?.as_bytes()).map_err(|_| failure())?;
        output.sync_all().map_err(|_| failure())?;
        Ok(passed)
    }
}

/// Called only after the real local WKWebView page loads; business calls remain real invoke.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_secret_store_is_explicitly_memory_only() {
        let store = FixtureSecrets::default();
        let secret = json!({"dbPassword": "synthetic-fixture"}).as_object().unwrap().clone();
        store.set("fixture-id", &secret).unwrap();
        assert!(store.get("fixture-id").unwrap().is_some());
        store.remove("fixture-id").unwrap();
        assert!(store.get("fixture-id").unwrap().is_none());
    }

    #[test]
    fn frontend_pass_cannot_replace_observed_native_calls() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("dbstudio-smoke-report-test-{}-{unique}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let fixture = SmokeRun { root: root.clone(), successful_methods: Mutex::new(HashSet::new()) };
        let accepted = fixture.report(&json!({"ok": true, "checks": {"frontend_query": true, "native_runQuery": true}})).unwrap();
        assert!(!accepted);
        let report: Value = serde_json::from_slice(&std::fs::read(root.join("report.json")).unwrap()).unwrap();
        assert_eq!(report["ok"], false);
        assert_eq!(report["checks"]["native_runQuery"], false);
        // Retain the isolated synthetic report; never delete files in this test.
    }

    #[test]
    fn report_rejects_data_fields_and_inconsistent_pass_before_writing() {
        let fixture = SmokeRun {
            root: PathBuf::from("/not-a-report-target"),
            successful_methods: Mutex::new(HashSet::new()),
        };
        for value in [
            json!({"ok": true, "checks": {"query": false}}),
            json!({"ok": true, "checks": {"query": "sensitive-result"}}),
            json!({"ok": true, "checks": {}, "path": "arbitrary"}),
            json!({"ok": true, "checks": {"invalid/path": true}}),
        ] {
            assert!(fixture.report(&value).is_err());
        }
    }
}

pub const RUN_SCRIPT: &str = r#"
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  let attempts = 0;
  while (typeof window.__DBSTUDIO_NATIVE_SMOKE__ !== 'function' && attempts++ < 300) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  let result;
  try {
    if (typeof window.__DBSTUDIO_NATIVE_SMOKE__ !== 'function') throw new Error('hook unavailable');
    result = await window.__DBSTUDIO_NATIVE_SMOKE__();
  } catch (_) {
    result = { ok: false, checks: { native_smoke_completed: false } };
  }
  await invoke('backend_call', { method: 'smokeReport', args: [result] });
})();
"#;
