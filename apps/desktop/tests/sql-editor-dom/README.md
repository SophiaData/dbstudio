# SQL 编辑器真实 DOM 回归

范围：真实 `SqlEditor.vue` SFC 模板与浏览器 textarea/listbox/button 事件；父夹具仅传合成 refs，并把正常 execute 事件显示为 DOM 日志。没有生产 App、useWorkbench 初始化、真实 localStorage、Tauri、MySQL 或系统剪贴板调用。DOM 键盘事件不等同 OS 全局快捷键验收。

## 启动独立服务

从仓库根目录运行并交给受管理后台 job：

```sh
node apps/desktop/tests/sql-editor-dom/server.mjs
```

启动器使用 `configFile:false`、`envFile:false`，先向 OS 申请 loopback 动态端口，再用 Vite strictPort 启动；不会替换 1420 或 DSH 62032。默认排他创建 `backups/mysql-editor-dom-<run>/`，打印真实 fixture URL 和 evidence directory，Vite cache 和证据都留在该目录。

可传 `--evidence-dir <本轮直接新建的backups/mysql-editor-dom-目录>`，其 screenshots 子目录必须尚不存在；拒绝链接目录，不覆盖旧 server JSON。服务收到 SIGINT/SIGTERM 时关闭；结束测试后由 job 所有者停止，不做文件清理。

## DOM 自动化

浏览器可直接打开打印的 `/fixture.html`，以角色/标签操作 SQL 编辑器和按钮。父页面 `[data-testid=execute-count]` 和 `[data-testid=execute-sql]` 为合成事件证据，禁止直接调用组件 setup/keydown/execute 代替键盘。

已有可用 Chromium 环境时，可用当前安装的 playwright-core 独立执行：

```sh
node apps/desktop/tests/sql-editor-dom/run.mjs \
  --url http://127.0.0.1:<动态端口>/fixture.html \
  --evidence-dir backups/mysql-editor-dom-<run> \
  --phase green
```

必要时通过 `--executable <明确已存在的Chromium路径>` 指定浏览器；脚本不会安装或搜索浏览器。一次 phase 的 JSON 和 screenshots 目录排他创建；重跑选择全新 run/phase，不覆盖证据。

本轮实际验证使用 Playwright 浏览器工具对真实 DOM 执行 fill/press/click，红 D01–D05 为 0/5、修复后 D01–D15 为 15/15。独立 Node runner 在本轮仅通过语法检查，未执行；不能把工具实测说成该命令已跑。工具拒绝读取工作区脚本的文件入口后已停止该入口；后续仅使用允许的独立 DOM 动作与默认托管截图，未绕过文件权限。结构化结果记录截图的工具托管路径和 SHA-256。

## 用例

| ID | 真实 DOM 动作与预期 |
| --- | --- |
| D01–D02 | 补全可见，Ctrl/Meta+Enter：当前语句仅执行一次，SQL 不变且列表关闭 |
| D03–D05 | 补全可见，Ctrl/Meta+Shift+Enter、Shift+Enter：整个脚本仅执行一次 |
| D06 | 真实选中第一条语句后 Ctrl+Enter，仅执行选区一次 |
| D07 | 选中第一条后 Meta+Shift+Enter，仍执行全部一次 |
| D08–D09 | 普通 Enter/Tab 接受 `sel` → `SELECT`，不执行 SQL |
| D10 | Escape 只关列表；下一次 Ctrl+Enter 正常执行一次 |
| D11–D12 | 点击“执行当前”/“执行全部”，各只执行一次 |
| D13 | 勾选禁用后 textarea/执行按钮禁用，快捷键不执行 |
| D14 | 没有补全列表时 Meta+Enter 仍执行当前一次 |
| D15 | 真实选中第二条后点击“执行当前”，只执行第二条 |

光标和选择使用普通方向键，避免 Ctrl+Home 在不同浏览器平台上的含义差异；只读 DOM selectionStart/selectionEnd 用于确认位置，不由脚本直接设置选区。

保存结果包含实际 case IDs/count 和页面日志。成功与失败都保留截图/JSON；不删除 profile、缓存、素材或证据。后续 Lead 单独接入 package/CI 和真实 Tauri→MySQL 链路，当前测试不提升这些层的状态。
