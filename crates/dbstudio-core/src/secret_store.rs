use crate::{AppError, SecretStore};
use dbstudio_protocol::SecretMap;
use std::{collections::HashMap, sync::Mutex};

/// Test fixtures only. Production shells must inject an OS-backed SecretStore.
#[derive(Default)]
pub struct MemorySecretStore { values: Mutex<HashMap<String, SecretMap>> }
impl SecretStore for MemorySecretStore {
    fn get(&self, key: &str) -> Result<Option<SecretMap>, AppError> {
        Ok(self.values.lock().map_err(|_| AppError::new("secret-storage-unavailable", "测试凭据存储不可用"))?.get(key).cloned())
    }
    fn set(&self, key: &str, secret: &SecretMap) -> Result<(), AppError> {
        self.values.lock().map_err(|_| AppError::new("secret-storage-unavailable", "测试凭据存储不可用"))?.insert(key.into(), secret.clone());
        Ok(())
    }
    fn remove(&self, key: &str) -> Result<(), AppError> {
        self.values.lock().map_err(|_| AppError::new("secret-storage-unavailable", "测试凭据存储不可用"))?.remove(key);
        Ok(())
    }
}
