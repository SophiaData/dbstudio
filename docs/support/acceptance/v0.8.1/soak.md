# v0.8.1 native core 短循环补充记录

2026-11-07，测量范围 `native_core_source`；macOS arm64 本地源码 Application harness，依赖基线 `7fadb00d6f9ee2cbf87949e9f908517c508a2956` / 0.8.1。不是已安装 App、Tauri、WebView 或 Windows 验收。设备口径由 lead 的 [environment.md](environment.md) 提供，未通过代码常量冒充实测环境。详细计时见 [performance.csv](performance.csv) 和 [performance-notes.md](performance-notes.md)。

| 用例 | 状态 | 实际操作与证据 |
| --- | --- | --- |
| native core 30 轮完整操作 | 通过 | 每轮：805 行合成库有序查询首 100 行 → offset 100 后续 100 行 → 独立长值结果取完整单元格 → 3 行 CSV 导出 → 关闭两个显式游标；关闭后分页拒绝。30/30 操作完成；完整值每次验证为 700000 个“长”（UTF-8 2100000 字节），小 CSV 内容另行逐行核对。 |
| 导出内容联合 gate | 通过 | Rust 首轮 exit 0 + Python validator exit 0；30 份小 CSV、3 份 100000 行 CSV，每个字段与顺序均核对。原始 pending 状态保留，公开 CSV 才写最终内容通过。 |
| 5×10 结果打开/关闭 | 通过（操作子项） | 同一 805 行查询每轮打开 10 个 cursor 再全部关闭，共 5 轮。每轮 100ms 仅收尾观察，不构成稳定回收等待。 |
| RSS 与内存增长门槛 | 受阻 | 只查询自身 harness PID；`/bin/ps` spawn PermissionDenied。停止该采集，不替换系统入口。CSV RSS 空值，不能宣称无泄漏、增长不线性或符合 100 MiB/20% 门槛；也未取得主进程+WebView 合计。 |
| 合成查询失败后恢复 | 通过 | 查询专用不存在表得到 `driver-failed`；下一次正常 COUNT=805。不是外部服务掉线测试。 |
| SQLite 查询取消支持边界 | 通过（限制提示） | `cancelQuery` 返回 false；随后正常查询 COUNT=805。SQLite 查询取消能力仍不支持，不能写“取消功能已实现/通过”。 |
| 断开/重连与旧 cursor | 通过 | 旧 cursor 在 disconnect 后不可分页；connect 后 COUNT=805；后续正常 close。不是 OS 进程崩溃恢复或网络服务重启。 |
| 100000 行三次独立导入 | 通过（PERSIST fixture） | 全新第二轮副本实际 Application 连接先设置 PERSIST，再普通 SELECT 明确读回 persist。分别向三个原本空表导入，计数/每行 body/大整数均验证；不执行删除或覆盖，原始素材保留。 |
| 合成导入失败原子性 | 通过（PERSIST fixture） | 两行相同主键、batchSize=1；终态 failed、目标 0 行，正常关闭。仅此合成 SQLite 场景。 |
| 合成导入取消 | 通过（PERSIST fixture） | 请求接受，最终 cancelled，目标 0 行；未将 completed 竞态记作取消成功。本次立即取消不证明 GUI 中途取消交互、任意时间点或任意数据库取消。 |
| 正常 Application 关闭 | 通过 | 两个隔离 harness 都正常 close、退出码 0；已收集进程输出。未启动产品 GUI，不据此宣称无残留 WebView/产品进程。 |
| 专用外部服务暂不可用后恢复 | 未执行 | 本任务没有启动外部服务或真实网络故障。 |
| 未应用草稿关闭并取消 | 未执行 | 未运行产品 GUI。 |
| 8 小时持续观察 | 未执行 | 首轮实际运行 4.884816 秒，写入专项 2.341835 秒；两段短执行不能相加冒充 8 小时或持续连接观察。 |
| 8 小时后查询/编辑回滚/导出/退出 | 未执行 | 未执行前置 8 小时观察，不能用短循环或构建成功替代。 |
| Windows / 产品进程组资源 | 未执行 | 无本任务对应的已安装 Windows App/WebView/资源采样。 |

本次 PERSIST 是保留 journal 的 fixture 策略，影响写入/提交成本，不是产品默认配置或默认写性能承诺。首轮 journal 读回失败时所有写入均跳过；第二轮用新目录/新素材，仅补可确认的写入专项，未覆盖第一轮结果。没有修改 core、driver、protocol、主 Cargo/lock、Tauri 或计划文件，没有执行 SQL DELETE/DROP、文件删除或清理。

证据位置：

- [首轮摘要](../../../../backups/perf-readiness-aeqfz0ye/results/summary.json)、[首轮事件](../../../../backups/perf-readiness-aeqfz0ye/results/events.jsonl)、[首轮 raw CSV](../../../../backups/perf-readiness-aeqfz0ye/results/raw-performance.csv)。
- [33 份导出逐行验证](../../../../backups/perf-readiness-aeqfz0ye/results/export-validation.json)。
- [独立写入专项摘要](../../../../backups/perf-readiness-255v7ns0/results/summary.json)、[专项事件](../../../../backups/perf-readiness-255v7ns0/results/events.jsonl)、[专项 raw CSV](../../../../backups/perf-readiness-255v7ns0/results/raw-performance.csv)。

私有素材与导出仅保留于本轮目录，不加入 Git 或发布附件。本轮没有发现需修改 runtime 的已确认缺陷；RSS 受限与 API 调用读回选择只作为执行条件/测量边界记录。短循环通过不提升 T5 长期观察或平台安装状态。
