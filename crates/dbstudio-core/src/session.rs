use crate::AppError;
use dbstudio_protocol::{CancelHandle, Driver};
use serde_json::Value;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, MutexGuard};
use uuid::Uuid;

pub(crate) fn lock<T>(value: &Mutex<T>) -> Result<MutexGuard<'_, T>, AppError> {
    value.lock().map_err(|_| AppError::new("internal", "应用状态不可用"))
}
pub(crate) fn stale() -> AppError { AppError::new("not-found", "连接会话或游标已经失效，请重新连接或执行查询") }

pub(crate) struct Session {
    pub(crate) generation: String,
    pub(crate) connection_id: String,
    pub(crate) dialect_id: String,
    pub(crate) capabilities: Value,
    active: AtomicBool,
    driver: Mutex<Box<dyn Driver>>,
    cancel: CancelHandle,
    running: Mutex<Option<Option<String>>>,
}
impl Session {
    pub(crate) fn new(connection_id: String, driver: Box<dyn Driver>) -> Arc<Self> {
        Arc::new(Self {
            generation: Uuid::new_v4().to_string(), connection_id,
            dialect_id: driver.dialect_id().to_owned(), capabilities: driver.capabilities(), cancel: driver.cancel_handle(),
            driver: Mutex::new(driver), active: AtomicBool::new(true), running: Mutex::new(None),
        })
    }
    pub(crate) fn is_active(&self) -> bool { self.active.load(Ordering::Acquire) }
    pub(crate) fn call(&self, method: &str, args: Vec<Value>) -> Result<Value, AppError> {
        let mut driver = lock(&self.driver)?;
        if !self.is_active() { return Err(stale()) }
        let query = matches!(method, "runQuery" | "query" | "executeStatement" | "explain");
        if query {
            let signal = args.last().and_then(|value| value.get("signalId")).and_then(Value::as_str).map(str::to_owned);
            *lock(&self.running)? = Some(signal);
        }
        let result = driver.call(method, args);
        if query { *lock(&self.running)? = None; }
        if !self.is_active() { return Err(stale()) }
        result
    }
    /// Keep a complete task on one native session; foreground calls wait until its transaction/cursors finish.
    pub(crate) fn with_task_driver(
        &self,
        signal_id: &str,
        operation: impl FnOnce(&mut dyn Driver) -> Result<Value, AppError>,
    ) -> Result<Value, AppError> {
        let mut driver = lock(&self.driver)?;
        if !self.is_active() { return Err(stale()) }
        *lock(&self.running)? = Some(Some(signal_id.to_owned()));
        let result = operation(driver.as_mut());
        *lock(&self.running)? = None;
        if !self.is_active() { return Err(stale()) }
        result
    }
    /// No driver mutex is acquired here: a blocked query cannot block cancellation.
    pub(crate) fn cancel(&self, signal_id: Option<&str>) -> Result<bool, AppError> {
        if !self.is_active() { return Ok(false) }
        let running = lock(&self.running)?.clone();
        let Some(active_signal) = running else { return Ok(false) };
        if let Some(wanted) = signal_id {
            if active_signal.as_deref() != Some(wanted) { return Ok(false) }
        }
        (self.cancel)()
    }
    pub(crate) fn mark_inactive(&self) { self.active.store(false, Ordering::Release); }
    pub(crate) fn invalidate(&self) {
        self.mark_inactive();
        let _ = (self.cancel)();
    }
    pub(crate) fn disconnect(&self) -> Result<(), AppError> {
        self.invalidate();
        lock(&self.driver)?.disconnect()
    }
}
