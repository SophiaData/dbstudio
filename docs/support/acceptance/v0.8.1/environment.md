# v0.8.1 首轮验收环境与基线

执行日期：2026-11-07。基线提交：`7fadb00d6f9ee2cbf87949e9f908517c508a2956`。本报告记录本轮实际执行；不将已有 CI 成绩当作新增安装验收。

## 设备与测试层级

| 项目 | 本轮结果 |
| --- | --- |
| 可用主机 | macOS 27.2、arm64、8 个逻辑 CPU、16 GiB 内存 |
| 基础工具 | Python 3.9.23，Docker 与 Xcode 命令入口存在；入口存在不代表所有平台环境可用 |
| Mac 干净 OS 账户 | 尚未提供。当前生产应用会使用 OS 应用数据与旧配置目录，不在现有账户启动它 |
| Windows 实机 | 由 Windows 分平台报告记录；本机的 Mac 结果不能代替 Windows 验收 |
| 本轮安全可用层级 | 发布附件静态核验、合成数据库、隔离 Rust Application 核心回归与基线 |
| 尚不能据此通过 | 已安装生产 GUI、系统保存框/剪贴板/凭据重启、全应用 WebView 内存、8 小时已安装应用观察 |

## 正式发布附件重新下载

本轮从 [v0.8.1 Release](https://github.com/SophiaData/dbstudio/releases/tag/v0.8.1) 下载到新的专用验收目录，没有覆盖此前附件。独立读取发布验收记录和 SHA256SUMS，并重新计算两个文件的 SHA-256。

| 文件 | 字节数 | SHA-256 | 本轮状态 |
| --- | ---: | --- | --- |
| dbstudio_0.8.1_aarch64.dmg | 7859717 | `88fc058cbdc44504f7001818c1366d8bbc2b6417a6f2265417959aa8461a5de7` | 通过：实际下载与两个校验记录一致 |
| dbstudio_0.8.1_x64-setup.exe | 5056090 | `41403e3117aaade4dd8c9b9eb433684cb2bc925da8a489e89d726e1c6e9da292` | 通过：实际下载与两个校验记录一致 |

发布记录的版本为 0.8.1，源码 SHA 与本报告基线相同。原公开 `installerAcceptance: unverified` 保持不变。

## 合成数据准备

执行[计划](../../../superpowers/plans/2026-11-07-native-product-readiness-plan.md)附录 A 中的完整 Python 代码；脚本及生成结果只保留在本轮项目根 backups 专用目录，未加入发布附件。未清理或覆盖已有文件。

| 数据集 | 已校验行数 | 文件字节数 | 校验内容 |
| --- | ---: | ---: | --- |
| sqlite-805.db / sample | 805 | 2220032 | id=1 的 big_value 精确为 9007199254740993 |
| sqlite-100000.db / sample | 100000 | 8364032 | 同上 |
| sqlite-1000000.db / sample | 1000000 | 83783680 | 同上 |
| compare-source.db / compare_rows | 3（生成记录） | 未作为性能样本统计 | 源端独有索引；1相同、2独有、3值不同 |
| compare-target.db / compare_rows | 3（生成记录） | 未作为性能样本统计 | 1相同、3值不同、4独有 |

805 行数据库中，`import_small`、`import_large`、`import_cancel`、`import_failed`、`import_perf_1`、`import_perf_2`、`import_perf_3` 均通过 SQL COUNT 校验为 0。另生成 small.csv（3 行）、large.csv（100000 行）、duplicate-key.csv 及长文本/外键样本。后续写入测试使用成员自己的新副本，避免改变这份基础数据。

## T0 结论

**部分完成。** 版本、下载来源、校验和和合成数据已就绪。干净 Mac GUI 账户、Windows 11 x64 实机入口及人工系统交互仍是平台安装验收的前置条件；不能将这些条件标成通过。真实数据库回归由核心成员另外报告，测试脚本结束后停止的服务不用于人工 GUI 连接。
