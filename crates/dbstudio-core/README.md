# dbstudio-core

宿主无关的原生 Rust 应用核心。依赖 dbstudio-protocol 和 dbstudio-drivers，不依赖 Tauri、Electron、Node 或旧 JavaScript 后端。Tauri shell 应使用 `Arc<Application>`，在 blocking worker 中调用同步接口；不要再给整个 Application 加互斥锁。

```rust
Application::open(base_dir: PathBuf, secrets: Arc<dyn SecretStore>) -> Result<Application, AppError>
Application::open_with_legacy(base_dir: PathBuf, secrets: Arc<dyn SecretStore>, legacy_dir: Option<PathBuf>) -> Result<Application, AppError>
Application::call(&self, method: &str, args: Vec<serde_json::Value>) -> Result<serde_json::Value, AppError>
Application::validate_export_destination(&self, path: &Path) -> Result<(), AppError>
Application::with_export_destination<T>(&self, path: &Path, publish: impl FnOnce() -> Result<T, AppError>) -> Result<T, AppError>
Application::close(&self) -> Result<(), AppError>
```

`AppError` 为协议 `DriverError` 的公开别名，只有 code/message。驱动异常进入公开调用边界时转换为固定安全错误；不记录 SQL、密码、目标或底层异常原文。

`SecretStore: Send + Sync` 的精确方法为 `get(&str) -> Result<Option<SecretMap>, AppError>`、`set(&str, &SecretMap) -> Result<(), AppError>`、`remove(&str) -> Result<(), AppError>`。生产由 shell 注入 OS keyring；MemorySecretStore 仅在单元测试或显式 `fixture-memory-secrets` feature 中提供，不能作为生产回退。

## 配置与迁移

`open` 不发现或读取旧目录；宿主通过 `open_with_legacy` 显式提供旧目录。核心读已知 schemaVersion=1 的 connections.json，只把非机密配置导入独立 connections-v2.json。旧 connections.json、secrets.json、sql-history.json 和 saved-sql.json 均不覆盖、不移动、不删除。旧 secrets.json 只检查存在性，不读取密文；Electron safeStorage 密文无法跨框架解开。相关连接在 migrationStatus 与 summary warnings 中明确要求重新录入，不能静默认为没有密码。

`migrationStatus` 返回 `{ legacyConfigImported, legacySecretsRequireReentry, legacySqlHistoryImported, legacySavedSqlImported, warnings }`。无旧数据时为 false/false/空列表。重新录入凭据成功后清除该连接的重录标记。

新凭据只进入 SecretStore；JSON 只保存独立随机 key。临时密码只保留内存，关闭应用即清除。凭据更新采用新 key 暂存、配置原子提交后回收旧 key；配置提交失败保留旧配置和旧 key。连接删除先提交配置，再清理旧 key；清理失败明确报告连接已移除而凭据清理未完成。

新 SQL 历史/收藏使用 sql-library-v2.json，旧文件只读。历史最多 500 条，收藏由用户显式维护。所有 JSON 读写统一最多 8 MiB，超限拒绝提交，不产生成功写入后无法重启的文件。原子写使用同目录私有临时文件，失败临时文件保留，不做删除清理。

## 会话与游标

每个连接具有独立生命周期 gate 和 driver mutex。全局状态锁只用于短时间查询和发布配置、会话、游标账本，不覆盖数据库请求。独立 CancelHandle 不取 driver mutex，长查询不阻塞取消。`signalId` 可限定被取消的查询。

每个会话有随机 generation。公开节点沿用 `connection:<id>|<native-id>`，公开游标由核心生成并登记为会话绑定的 opaque ID。断开、配置更新和重新连接会清理旧游标，使旧任务与旧结果失效。重复关闭已清理的游标幂等成功；旧游标分页/取值返回 not-found。

后台任务可捕获同一 `Arc<Session>`；整任务的 `with_task_driver` 保持 driver lease，避免前台 SQL 插进导入事务或导出游标序列。关闭应用先阻止新调用，再取消/等待任务回滚，最后关闭会话，等待过程不持全局状态锁。

## 能力表

| API | 原生核心状态 |
| --- | --- |
| listDialects/listConnections、连接 add/update/test/connect/disconnect/remove | 已实现，驱动由 Rust factory 创建 |
| listChildren/describeTable、query/statement/explain、preview/tableSelectSql | 已实现作用域转发；具体支持程度由各原生驱动声明 |
| cursor fetch/close/full-cell、行 CRUD、事务 state/commit/rollback、DDL | 已实现会话绑定转发；驱动不支持时明确返回 unsupported |
| SQL history/saved SQL | 已实现独立 v2 本地持久化 |
| migrationStatus | 已实现，明确旧密文重录要求 |
| CSV import/export tasks | data_tasks 模块提供原生实现，由独立任务维护；不回退 JavaScript |
| captureSchemaSnapshot/compareTableData | compare 模块提供只读原生实现；生成同步 SQL 不自动执行 |
| validate_export_destination / with_export_destination | 统一保护私有应用目录、源 SQLite 与附属文件；解析悬空/相对符号链接链并按 Unicode 规范化/大小写折叠保守比较；with 在同一状态临界区校验当前连接并执行 create_new/hard_link |
| chooseImportFile / saveTextExport | 属于宿主 shell 的授权文件对话框，核心不执行系统对话框 |
| 未登记的方法、尚无原生实现的插件/能力 | 明确 unsupported，不返回伪造空结果 |

## 验证

由 Team Lead 统一运行 Cargo，避免同一 workspace 争抢锁：

```sh
cargo test -p dbstudio-core
```

直属测试覆盖真实临时 SQLite 的配置重启、节点与游标隔离、旧配置/密文保留、SQL library、读写容量边界，以及合成阻塞 driver 的并行连接、独立取消、会话失效、凭据更新/删除写入失败和 keyring 读取失败。所有测试仅使用唯一私有临时目录及合成凭据，不读取真实用户数据；临时文件保留，不执行本机删除。
