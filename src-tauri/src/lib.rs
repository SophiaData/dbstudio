//! Tauri shell: one explicit IPC method table, OS ports and lifecycle only.
mod secrets;
#[cfg(feature = "test-hooks")]
mod smoke;
#[cfg(feature = "mysql-acceptance")]
mod mysql_acceptance;

const MYSQL_ACCEPTANCE_ENV: &[&str] = &[
    "DBSTUDIO_MYSQL_ACCEPTANCE_ROOT", "DBSTUDIO_MYSQL_ACCEPTANCE_RUN_ID",
    "DBSTUDIO_MYSQL_ACCEPTANCE_PHASE", "DBSTUDIO_MYSQL_ACCEPTANCE_MANIFEST",
    "DBSTUDIO_MYSQL_HOST", "DBSTUDIO_MYSQL_PORT", "DBSTUDIO_MYSQL_DATABASE",
    "DBSTUDIO_MYSQL_USER", "DBSTUDIO_MYSQL_PASSWORD", "DBSTUDIO_MYSQL_OBSERVER_PASSWORD", "DBSTUDIO_MYSQL_CA_FILE",
];
fn mysql_mode_environment_present() -> bool {
    MYSQL_ACCEPTANCE_ENV.iter().any(|name| std::env::var_os(name).is_some())
}

use dbstudio_core::{AppError, Application, SecretStore};
use serde_json::Value;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

struct DesktopState {
    application: Arc<Application>,
    exit_authorized: AtomicBool,
    #[cfg(feature = "test-hooks")]
    smoke: Option<smoke::SmokeRun>,
    #[cfg(feature = "mysql-acceptance")]
    mysql: Arc<mysql_acceptance::AcceptanceRun>,
    #[cfg(feature = "mysql-acceptance")]
    mysql_secrets: Arc<mysql_acceptance::AcceptanceSecrets>,
}

// Explicit native boundary. Unsupported core methods fail closed in the core as well.
const CORE_METHODS: &[&str] = &[
    "listDialects", "listConnections", "addConnection", "connectConnection",
    "disconnectConnection", "removeConnection", "testConnection", "listChildren",
    "describeTable", "captureSchemaSnapshot", "compareTableData", "runQuery",
    "executeStatement", "explain", "fetchResultPage", "closeCursor", "previewTable",
    "tableSelectSql", "applyEdits", "commitTransaction", "rollbackTransaction",
    "transactionState", "insertRow", "deleteRows", "countRows", "fetchCellValue",
    "createTable", "dropTable", "createView", "dropView", "renameTable", "cancelQuery",
    "updateConnection", "listSqlLibrary", "recordSqlHistory", "saveSql", "removeSavedSql",
    "clearSqlHistory", "migrationStatus", "startTransfer", "getTransferProgress", "cancelTransfer", "waitTransfer",
    "previewImport", "startImport", "getImportProgress", "cancelImport", "waitImport",
];

fn internal_error() -> AppError {
    AppError::new("internal", "原生后端调用失败")
}

fn export_filename(args: &[Value]) -> Result<String, AppError> {
    let name = match args {
        [] => "export.csv",
        [Value::String(name)] => name.as_str(),
        _ => return Err(AppError::invalid("导出文件名参数无效")),
    };
    if name.trim().is_empty() || name.len() > 255 || name == "." || name == ".."
        || name.chars().any(|c| c == '/' || c == '\\' || c.is_control())
    {
        return Err(AppError::invalid("导出建议名称必须是文件名"));
    }
    Ok(name.to_owned())
}

const MAX_TEXT_EXPORT_BYTES: usize = 16 * 1024 * 1024;

fn write_text_export(application: &Application, path: &std::path::Path, content: &str) -> Result<Value, AppError> {
    use std::io::Write;
    if content.len() > MAX_TEXT_EXPORT_BYTES { return Err(AppError::invalid("文本导出超过16MiB上限")); }
    let mut output = application.with_export_destination(path, || {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        options.open(path).map_err(|_| AppError::new("file-io", "无法创建导出文件，请选择尚未存在的新文件"))
    })?;
    output.write_all(content.as_bytes()).and_then(|_| output.sync_all())
        .map_err(|_| AppError::new("file-io", "导出写入失败，部分文件已保留"))?;
    Ok(Value::String(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn backend_call(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    method: String,
    args: Vec<Value>,
) -> Result<Value, AppError> {
    if window.label() != "main" {
        return Err(AppError::new("unauthorized", "此窗口无权调用后端"));
    }
    let argument_limit = if method == "saveTextExport" { 32 * 1024 * 1024 + 4096 } else { 1024 * 1024 };
    if args.len() > 32 || serde_json::to_vec(&args).map_err(|_| internal_error())?.len() > argument_limit {
        return Err(AppError::invalid("后端参数超过大小上限"));
    }
    #[cfg(feature = "mysql-acceptance")]
    if !state.mysql.probe_method_allowed(&method) {
        return Err(AppError::unsupported("存储探针阶段禁止业务与凭据操作"));
    }
    #[cfg(feature = "mysql-acceptance")]
    if method.starts_with("mysqlAcceptance") {
        let url=window.url().map_err(|_|AppError::new("unauthorized","无法确认测试窗口来源"))?;
        if !mysql_acceptance::bridge_window_allowed(window.label(),url.as_str()) {
            return Err(AppError::new("unauthorized","测试桥仅限本轮本地主窗口"));
        }
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceTimeCheckpoint" || method == "mysqlAcceptanceTimeContinue" {
        if args.len()!=1{return Err(AppError::invalid("时间网格检查点只接受一个对象"));}
        if method=="mysqlAcceptanceTimeCheckpoint"{state.mysql.time_checkpoint(&args[0],&state.mysql_secrets)?;return Ok(Value::Null);}
        return state.mysql.time_continue(&args[0]);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceBinaryCheckpoint" || method == "mysqlAcceptanceBinaryContinue" {
        if args.len()!=1{return Err(AppError::invalid("二进制检查点只接受一个对象"));}
        if method=="mysqlAcceptanceBinaryCheckpoint"{state.mysql.binary_checkpoint(&args[0],&state.mysql_secrets)?;return Ok(Value::Null);}
        return state.mysql.binary_continue(&args[0]);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceCrosszoneCheckpoint" || method == "mysqlAcceptanceCrosszoneContinue" {
        if args.len()!=1{return Err(AppError::invalid("跨时区检查点只接受一个对象"));}
        if method=="mysqlAcceptanceCrosszoneCheckpoint"{state.mysql.crosszone_checkpoint(&args[0],&state.mysql_secrets)?;return Ok(Value::Null);}
        return state.mysql.crosszone_continue(&args[0]);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceSessionTimezoneCheckpoint" || method == "mysqlAcceptanceSessionTimezoneContinue" {
        if args.len()!=1{return Err(AppError::invalid("会话时区检查点只接受一个对象"));}
        if method=="mysqlAcceptanceSessionTimezoneCheckpoint"{state.mysql.session_timezone_checkpoint(&args[0],&state.mysql_secrets)?;return Ok(Value::Null);}
        return state.mysql.session_timezone_continue(&args[0]);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceTextCheckpoint" || method == "mysqlAcceptanceTextContinue" {
        if args.len()!=1{return Err(AppError::invalid("全文检查点只接受一个对象"));}
        if method=="mysqlAcceptanceTextCheckpoint"{state.mysql.text_checkpoint(&args[0],&state.mysql_secrets)?;return Ok(Value::Null);}
        return state.mysql.text_continue(&args[0]);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptancePrecisionCheckpoint" || method == "mysqlAcceptancePrecisionContinue" {
        if args.len()!=1{return Err(AppError::invalid("精确值检查点只接受一个对象"));}
        if method=="mysqlAcceptancePrecisionCheckpoint"{state.mysql.precision_checkpoint(&args[0],&state.mysql_secrets)?;return Ok(Value::Null);}
        return state.mysql.precision_continue(&args[0]);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceTimeoutCheckpoint" || method == "mysqlAcceptanceTimeoutContinue" {
        if args.len()!=1{return Err(AppError::invalid("锁等待检查点只接受一个对象"));}
        if method=="mysqlAcceptanceTimeoutCheckpoint"{state.mysql.timeout_checkpoint(&args[0],&state.mysql_secrets)?;return Ok(Value::Null);}
        return state.mysql.timeout_continue(&args[0]);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceDuplicateCheckpoint" || method == "mysqlAcceptanceDuplicateContinue" {
        if args.len()!=1{return Err(AppError::invalid("唯一键检查点只接受一个对象"));}
        if method=="mysqlAcceptanceDuplicateCheckpoint"{state.mysql.duplicate_checkpoint(&args[0],&state.mysql_secrets)?;return Ok(Value::Null);}
        return state.mysql.duplicate_continue(&args[0]);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceDeadlockCheckpoint" || method == "mysqlAcceptanceDeadlockContinue" {
        if args.len()!=1 {return Err(AppError::invalid("网格故障检查点只接受一个对象"));}
        if method=="mysqlAcceptanceDeadlockCheckpoint" {state.mysql.deadlock_checkpoint(&args[0],&state.mysql_secrets)?;return Ok(Value::Null);}
        return state.mysql.deadlock_continue(&args[0]);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceCommitCheckpoint" || method == "mysqlAcceptanceCommitContinue" {
        if args.len()!=1 {return Err(AppError::invalid("提交检查点只接受一个对象"));}
        if method=="mysqlAcceptanceCommitCheckpoint" {
            state.mysql.commit_checkpoint(&args[0],&state.mysql_secrets)?;
            return Ok(Value::Null);
        }
        return state.mysql.commit_continue(&args[0]);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceStartupTrace" {
        if args.len()!=1 {return Err(AppError::invalid("启动追踪只接受一个对象"));}
        state.mysql.frontend_startup_trace(&args[0])?;
        return Ok(Value::Null);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceProbeReport" {
        if args.len()!=1 {return Err(AppError::invalid("存储探针只接受一个对象"));}
        state.mysql.retain_probe_report(&args[0],&state.mysql_secrets)?;
        let application=state.application.clone();
        tauri::async_runtime::spawn_blocking(move||application.close()).await.map_err(|_|internal_error())??;
        state.exit_authorized.store(true,Ordering::SeqCst);
        app.exit(0);
        return Ok(Value::Null);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceFillAppPassword" {
        if !args.is_empty() {return Err(AppError::invalid("密码控件桥不接受参数"));}
        let script=state.mysql.password_script()?;
        window.eval(&script).map_err(|_|AppError::new("internal","密码控件脚本未能排队"))?;
        return Ok(serde_json::json!({"scheduled":true}));
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceReport" {
        if args.len()!=1 {return Err(AppError::invalid("验收报告只接受一个对象"));}
        let reported_success=state.mysql.retain_ui_report(&args[0],&state.mysql_secrets)?;
        let application=state.application.clone();
        let closed=tauri::async_runtime::spawn_blocking(move||application.close()).await.map_err(|_|internal_error())?;
        state.exit_authorized.store(true,Ordering::SeqCst);
        app.exit(if reported_success&&closed.is_ok(){0}else{1});
        return Ok(Value::Null);
    }
    #[cfg(feature = "mysql-acceptance")]
    if method == "mysqlAcceptanceContext" || method == "mysqlAcceptanceObservations" {
        if !args.is_empty() { return Err(AppError::invalid("验收观察接口不接受参数")); }
        return if method == "mysqlAcceptanceContext" { Ok(state.mysql.context()) }
            else { state.mysql.snapshot(&state.mysql_secrets) };
    }
    if method == "confirmExit" {
        if !args.is_empty() { return Err(AppError::invalid("confirmExit 不接受参数")); }
        let application = state.application.clone();
        tauri::async_runtime::spawn_blocking(move || application.close()).await.map_err(|_| internal_error())??;
        #[cfg(feature = "mysql-acceptance")]
        state.mysql.retain_snapshot(&state.mysql_secrets)?;
        state.exit_authorized.store(true, Ordering::SeqCst);
        app.exit(0);
        return Ok(Value::Null);
    }
    if method == "chooseImportFile" {
        if !args.is_empty() { return Err(AppError::invalid("文件选择不接受路径参数")); }
        return tauri::async_runtime::spawn_blocking(move || {
            let selected = app.dialog().file().set_parent(&window)
                .set_title("选择导入文件").add_filter("数据文件", &["csv", "tsv", "json", "xlsx"])
                .blocking_pick_file();
            match selected {
                None => Ok(Value::Null),
                Some(path) => path.into_path().map(|path| Value::String(path.to_string_lossy().into_owned()))
                    .map_err(|_| AppError::invalid("所选文件不是本地文件")),
            }
        }).await.map_err(|_| internal_error())?;
    }
    if method == "chooseExportFile" {
        let suggested_name = export_filename(&args)?;
        return tauri::async_runtime::spawn_blocking(move || {
            let selected = app.dialog().file().set_parent(&window)
                .set_title("保存导出文件").set_file_name(suggested_name)
                .add_filter("CSV 文件", &["csv"]).blocking_save_file();
            match selected {
                None => Ok(Value::Null),
                Some(path) => path.into_path().map(|path| Value::String(path.to_string_lossy().into_owned()))
                    .map_err(|_| AppError::invalid("所选文件不是本地文件")),
            }
        }).await.map_err(|_| internal_error())?;
    }
    if method == "saveTextExport" {
        if args.len() != 1 { return Err(AppError::invalid("缺少文本导出参数")); }
        let request = args[0].as_object().ok_or_else(|| AppError::invalid("文本导出参数无效"))?;
        if request.len() != 2 { return Err(AppError::invalid("文本导出参数无效")); }
        let suggested_name = export_filename(&[request.get("suggestedName").cloned().ok_or_else(|| AppError::invalid("缺少建议文件名"))?])?;
        let content = request.get("content").and_then(Value::as_str).ok_or_else(|| AppError::invalid("导出内容必须是文本"))?;
        if content.len() > MAX_TEXT_EXPORT_BYTES { return Err(AppError::invalid("文本导出超过16MiB上限")); }
        let content = content.to_owned();
        let application = state.application.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let selected = app.dialog().file().set_parent(&window)
                .set_title("保存文本导出（请选择新文件）").set_file_name(suggested_name).blocking_save_file();
            let Some(selected) = selected else { return Ok(Value::Null) };
            let path = selected.into_path().map_err(|_| AppError::invalid("所选文件不是本地文件"))?;
            write_text_export(&application, &path, &content)
        }).await.map_err(|_| internal_error())?;
    }
    #[cfg(feature = "test-hooks")]
    if method == "smokeFixture" || method == "smokeReport" {
        let fixture = state.smoke.as_ref().ok_or_else(|| AppError::unsupported("未启用原生测试会话"))?;
        if method == "smokeFixture" {
            if !args.is_empty() { return Err(AppError::invalid("smokeFixture 不接受参数")); }
            return Ok(fixture.context());
        }
        if args.len() != 1 { return Err(AppError::invalid("缺少原生测试报告")); }
        let ok = fixture.report(&args[0])?;
        let application = state.application.clone();
        tauri::async_runtime::spawn_blocking(move || application.close()).await.map_err(|_| internal_error())??;
        state.exit_authorized.store(true, Ordering::SeqCst);
        app.exit(if ok { 0 } else { 1 });
        return Ok(Value::Null);
    }
    if !CORE_METHODS.contains(&method.as_str()) {
        return Err(AppError::unsupported("未注册的后端方法"));
    }
    let application = state.application.clone();
    #[cfg(feature = "test-hooks")]
    let observed_method = method.clone();
    #[cfg(feature = "mysql-acceptance")]
    let observed_started = std::time::Instant::now();
    #[cfg(feature = "mysql-acceptance")]
    let _=state.mysql.native_startup_trace("native_enter",&method);
    let joined = tauri::async_runtime::spawn_blocking(move || application.call(&method, args)).await;
    #[cfg(feature = "mysql-acceptance")]
    let _=state.mysql.native_startup_trace(if matches!(&joined,Ok(Ok(_))) {"native_returned"}else{"native_failed"},&observed_method);
    let result=joined.map_err(|_|internal_error())?;
    #[cfg(feature = "mysql-acceptance")]
    state.mysql.record(&observed_method, result.is_ok(), observed_started.elapsed().as_millis());
    #[cfg(feature = "mysql-acceptance")]
    state.mysql.record_deadlock_result(&observed_method,&result);
    #[cfg(feature = "mysql-acceptance")]
    state.mysql.record_duplicate_result(&observed_method,&result);
    #[cfg(feature = "mysql-acceptance")]
    state.mysql.record_timeout_result(&observed_method,&result);
    #[cfg(feature = "mysql-acceptance")]
    state.mysql.record_precision_result(&observed_method,&result);
    #[cfg(feature = "mysql-acceptance")]
    state.mysql.record_text_result(&observed_method,&result);
    #[cfg(feature = "mysql-acceptance")]
    state.mysql.record_session_timezone_result(&observed_method,&result);
    #[cfg(feature = "mysql-acceptance")]
    state.mysql.record_time_result(&observed_method,&result);
    #[cfg(feature = "mysql-acceptance")]
    state.mysql.record_crosszone_result(&observed_method,&result);
    #[cfg(feature = "mysql-acceptance")]
    state.mysql.record_binary_result(&observed_method,&result);
    #[cfg(feature = "test-hooks")]
    if result.is_ok() {
        if let Some(fixture) = &state.smoke {
            fixture.record_success(&observed_method)?;
        }
    }
    result
}

pub fn run() {
    // Reject test-mode environment before Tauri can create any configured window or read app data.
    #[cfg(not(feature = "mysql-acceptance"))]
    if mysql_mode_environment_present() {
        eprintln!("MySQL acceptance environment requires its dedicated test artifact");
        std::process::exit(2);
    }
    #[cfg(not(feature = "test-hooks"))]
    if std::env::var_os("DBSTUDIO_NATIVE_SMOKE_ROOT").is_some() {
        eprintln!("Native smoke environment requires a test artifact");
        std::process::exit(2);
    }
    let context = tauri::generate_context!();
    #[cfg(feature = "mysql-acceptance")]
    let mysql = {
        if context.config().identifier != "io.dbstudio.mysql-acceptance" || !context.config().app.windows.is_empty() {
            eprintln!("MySQL acceptance requires a dedicated config with no automatic windows");
            std::process::exit(2);
        }
        match mysql_acceptance::AcceptanceRun::from_environment() {
            Ok(run) => Arc::new(run),
            Err(_) => { eprintln!("MySQL acceptance isolation preflight rejected"); std::process::exit(2); }
        }
    };
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![backend_call])
        .setup(move |app| {
            #[cfg(feature = "test-hooks")]
            let smoke = smoke::SmokeRun::from_environment()?;
            #[cfg(not(feature = "test-hooks"))]
            if std::env::var_os("DBSTUDIO_NATIVE_SMOKE_ROOT").is_some() {
                return Err("此构建未启用原生测试入口".into());
            }
            #[cfg(feature = "mysql-acceptance")]
            let mysql_secrets = Arc::new(mysql_acceptance::AcceptanceSecrets::new(&mysql));
            #[cfg(feature = "mysql-acceptance")]
            let (base_dir, secrets): (_, Arc<dyn SecretStore>) = (mysql.root.join("data"), mysql_secrets.clone());
            #[cfg(all(feature = "test-hooks", not(feature = "mysql-acceptance")))]
            let (base_dir, secrets): (_, Arc<dyn SecretStore>) = match &smoke {
                Some(fixture) => (fixture.root.join("data"), Arc::new(smoke::FixtureSecrets::default())),
                None => (app.path().app_data_dir()?, Arc::new(secrets::OsSecretStore)),
            };
            #[cfg(not(feature = "test-hooks"))]
            let (base_dir, secrets): (_, Arc<dyn SecretStore>) =
                (app.path().app_data_dir()?, Arc::new(secrets::OsSecretStore));
            // Test-hook builds never inspect legacy user configuration, even without a smoke run.
            #[cfg(feature = "test-hooks")]
            let legacy_dir = None;
            #[cfg(not(feature = "test-hooks"))]
            let legacy_dir = Some(app.path().config_dir()?.join("dbstudio"));
            let application = Arc::new(Application::open_with_legacy(base_dir, secrets, legacy_dir)?);
            app.manage(DesktopState {
                application,
                exit_authorized: AtomicBool::new(false),
                #[cfg(feature = "test-hooks")]
                smoke,
                #[cfg(feature = "mysql-acceptance")]
                mysql: mysql.clone(),
                #[cfg(feature = "mysql-acceptance")]
                mysql_secrets,
            });
            #[cfg(feature = "mysql-acceptance")]
            {
                #[cfg(not(target_os = "macos"))]
                return Err("This isolation slice requires macOS 14+ WKWebView data stores".into());
                #[cfg(target_os = "macos")]
                {
                    let version = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output()?;
                    let major = std::str::from_utf8(&version.stdout).ok().and_then(|value| value.trim().split('.').next()).and_then(|value| value.parse::<u32>().ok());
                    if !version.status.success() || !major.is_some_and(|value| value >= 14) { return Err("WKWebView store isolation requires macOS 14+".into()); }
                    // No configured window exists. Configure the store before any Vue/localStorage access.
                    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                        .title("dbstudio · isolated MySQL acceptance")
                        .inner_size(1180.0, 760.0)
                        .data_store_identifier(mysql.store_id)
                        .build()?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<DesktopState>();
                if !state.exit_authorized.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.emit("dbstudio:exit-requested", ());
                }
            }
        });
    #[cfg(feature = "test-hooks")]
    let builder = builder.on_page_load(|webview, payload| {
        #[cfg(feature = "mysql-acceptance")]
        if matches!(payload.event(),tauri::webview::PageLoadEvent::Finished) {
            if let Some(state)=webview.try_state::<DesktopState>() {
                if state.mysql.phase=="restart-probe" {
                    let allowed=webview.url().ok().and_then(|url|state.mysql.retain_probe_checkpoint(webview.label(),url.as_str()).ok()).unwrap_or(false);
                    if allowed {if let Ok(script)=state.mysql.probe_script(){let _=webview.eval(&script);}}
                    return;
                }
            }
        }
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            && webview.try_state::<DesktopState>().is_some_and(|state| state.smoke.is_some())
        {
            let _ = webview.eval(smoke::RUN_SCRIPT);
        }
    });
    let app = builder.build(context).expect("无法初始化 dbstudio 桌面宿主");
    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let state = handle.state::<DesktopState>();
            if !state.exit_authorized.load(Ordering::SeqCst) {
                api.prevent_exit();
                let _ = handle.emit("dbstudio:exit-requested", ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn core_whitelist_is_unique_and_excludes_shell_and_test_methods() {
        let unique: std::collections::HashSet<_> = CORE_METHODS.iter().collect();
        assert_eq!(unique.len(), CORE_METHODS.len());
        for method in ["confirmExit", "chooseImportFile", "chooseExportFile", "saveTextExport", "smokeFixture", "smokeReport", "shell", "eval"] {
            assert!(!CORE_METHODS.contains(&method));
        }
        assert!(CORE_METHODS.contains(&"runQuery"));
        assert!(CORE_METHODS.contains(&"commitTransaction"));
    }

    #[test]
    fn text_export_writes_real_fixture_and_enforces_cap_and_no_overwrite() {
        struct NoSecrets;
        impl SecretStore for NoSecrets {
            fn get(&self, _: &str) -> Result<Option<dbstudio_protocol::SecretMap>, AppError> { Ok(None) }
            fn set(&self, _: &str, _: &dbstudio_protocol::SecretMap) -> Result<(), AppError> { unreachable!() }
            fn remove(&self, _: &str) -> Result<(), AppError> { unreachable!() }
        }
        let root = std::env::temp_dir().join(format!("dbstudio-text-export-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();
        let application = Application::open(root.join("state"), Arc::new(NoSecrets)).unwrap();
        let path = root.join("fixture.svg");
        let content = "<svg><text>fixture-列</text></svg>";
        assert!(write_text_export(&application, &path, content).is_ok());
        assert_eq!(std::fs::read(&path).unwrap(), content.as_bytes());
        assert!(write_text_export(&application, &path, "replacement").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), content.as_bytes());
        let oversized_path = root.join("oversized.txt");
        assert!(write_text_export(&application, &oversized_path, &"x".repeat(MAX_TEXT_EXPORT_BYTES + 1)).is_err());
        assert!(!oversized_path.exists());
        assert!(write_text_export(&application, std::path::Path::new("relative.txt"), "fixture").is_err());
        application.close().unwrap();
        // Retain fixture evidence; never delete temporary files.
    }

    #[test]
    fn text_export_guard_rejects_live_saved_database_sidecars_and_case_aliases() {
        struct NoSecrets;
        impl SecretStore for NoSecrets {
            fn get(&self, _: &str) -> Result<Option<dbstudio_protocol::SecretMap>, AppError> { Ok(None) }
            fn set(&self, _: &str, _: &dbstudio_protocol::SecretMap) -> Result<(), AppError> { unreachable!() }
            fn remove(&self, _: &str) -> Result<(), AppError> { unreachable!() }
        }
        let root = std::env::temp_dir().join(format!("dbstudio-text-export-guard-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();
        let application = Application::open(root.join("state"), Arc::new(NoSecrets)).unwrap();
        let database = root.join("Foo.sqlite");
        std::fs::write(&database, b"").unwrap();
        let added = application.call("addConnection", vec![serde_json::json!({
            "dialectId":"sqlite","name":"text-export-fixture","options":{"file":database}
        })]).unwrap();
        assert_eq!(added["connected"], true);
        for name in ["foo.sqlite-wal", "FOO.SQLITE-JOURNAL"] {
            let destination = root.join(name);
            let error = write_text_export(&application, &destination, "fixture").unwrap_err();
            assert_eq!(error.code, "database-path");
            assert!(!destination.exists());
        }
        application.close().unwrap();
        // Retain fixture evidence; never delete temporary files.
    }

    #[test]
    fn export_suggestion_cannot_supply_a_path() {
        assert_eq!(export_filename(&[]).unwrap(), "export.csv");
        assert_eq!(export_filename(&[Value::String("table.csv".into())]).unwrap(), "table.csv");
        for name in ["", "..", "../table.csv", "/tmp/table.csv", "C:\\table.csv", "table\n.csv"] {
            assert!(export_filename(&[Value::String(name.into())]).is_err());
        }
    }
}
