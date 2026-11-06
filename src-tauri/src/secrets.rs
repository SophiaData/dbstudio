use dbstudio_core::{AppError, SecretStore};
use dbstudio_protocol::SecretMap;

/// OS vault only. No plaintext file or application-owned encryption-key fallback.
pub struct OsSecretStore;

fn unavailable() -> AppError {
    AppError::new("secret-storage-unavailable", "系统凭据存储不可用，凭据未保存")
}

impl OsSecretStore {
    fn entry(key: &str) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new("io.dbstudio.desktop", key).map_err(|_| unavailable())
    }
}

impl SecretStore for OsSecretStore {
    fn get(&self, key: &str) -> Result<Option<SecretMap>, AppError> {
        match Self::entry(key)?.get_password() {
            Ok(encoded) => serde_json::from_str(&encoded)
                .map(Some)
                .map_err(|_| unavailable()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(unavailable()),
        }
    }

    fn set(&self, key: &str, secret: &SecretMap) -> Result<(), AppError> {
        let encoded = serde_json::to_string(secret).map_err(|_| unavailable())?;
        Self::entry(key)?.set_password(&encoded).map_err(|_| unavailable())
    }

    fn remove(&self, key: &str) -> Result<(), AppError> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(unavailable()),
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod acceptance {
    use super::*;

    #[test]
    #[ignore = "explicit OS keyring acceptance; creates and retains one synthetic credential"]
    fn os_keyring_roundtrip_retains_only_a_synthetic_entry() {
        assert!(std::env::var("DBSTUDIO_NATIVE_KEYRING_TEST").as_deref() == Ok("1"), "keyring acceptance requires explicit opt-in");
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("system time required").as_nanos();
        let key = format!("native-acceptance-retained-{}-{nonce}", std::process::id());
        let store = OsSecretStore;
        assert!(store.get(&key).unwrap_or_else(|_| panic!("OS keyring preflight failed")).is_none(), "synthetic key must be unused");
        let mut value = SecretMap::new();
        value.insert("dbPassword".into(), serde_json::json!("public-synthetic-native-acceptance-value"));
        store.set(&key, &value).unwrap_or_else(|_| panic!("OS keyring synthetic write failed"));
        let actual = OsSecretStore.get(&key).unwrap_or_else(|_| panic!("OS keyring synthetic read failed"));
        assert!(actual.as_ref() == Some(&value), "OS keyring must preserve the synthetic value across adapter instances");
        // Retain this uniquely named synthetic entry; never inspect or delete user credentials.
    }
}
