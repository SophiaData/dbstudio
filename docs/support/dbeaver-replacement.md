# DBeaver 替代验收

以本机的 DBeaver Community 26.2.3 为对标对象，按真实日常任务逐项验收。DBStudio 基线为 `b9344c1`。本机版本已核对，具体连接类型和常用工作流待逐项确认。MySQL 细项沿用[既有验收台账](mysql-parity/coverage-map.md)。

## 第一阶段 · Windows 和 MySQL

使用同一份 GitHub Actions 候选安装包和专用 MySQL 合成数据。记录构建提交、运行编号、安装包 SHA-256，以及每个场景在实际桌面入口的结果。

| 用户任务 | 通过条件 | 当前证据 |
| --- | --- | --- |
| 全新安装和启动 | 安装后打开工作台与新建连接表单 | [已在 Windows 托管 runner 实测](https://github.com/SophiaData/dbstudio/actions/runs/44756068629/attempts/2) |
| 保存连接、查询和重启 | 保存专用连接，完整退出，同一安装包重启后无需重录凭据即可查询 | `ad72a03` Windows 候选包已通过。首次运行在启动时未找到连接表单，第二次在新 runner 上用同一安装包完成初次查询、退出、新进程重连与新查询。[Windows 重启验收](https://github.com/SophiaData/dbstudio/actions/runs/44782064834/attempts/2) · [macOS 测试构建](mysql-parity/public/real-acceptance-results.md#同二进制重启编辑守卫与回滚实际通过) |
| 查询、分页和多行复制 | 独立连接确认分页顺序与结果。选中当前页多行后核对系统剪贴板的列名、行序、长文本与精确值 | [Windows 候选包通过 MySQL 查询和系统剪贴板核对](https://github.com/SophiaData/dbstudio/actions/runs/44777573723)，分页待验 |
| 网格编辑和事务 | 独立连接验证未提交不可见、回滚恢复，以及提交后值保持精确。覆盖 BIGINT、DECIMAL、UTF-8、NULL 和空串 | [macOS 测试构建有部分类型和事务证据](mysql-parity/public/real-acceptance-results.md#首组六字段精确网格编辑与应用后提交真实通过)，Windows 候选包待验 |
| CSV 导入导出 | 通过桌面入口导出 CSV，再导入专用表。独立解析文件并回读行数、值与编码，覆盖引号、换行、NULL 和空串 | [SQLite 原生桌面及 SQL 驱动有分层实测](native-migration-matrix.md)，Windows MySQL 候选包待验 |

这组测试覆盖全新安装后的日常使用。跨版本凭据恢复使用可启动的历史基线另行验证。

## 后续阶段

1. **SQL 工作台和大结果**。多脚本标签、别名补全、常用快捷键、可调页大小与跳页、多结果集、批量编辑。用专用大表测深分页、导出与取消。
2. **连接和迁移**。核对 PostgreSQL、MySQL/MariaDB、SQLite 和实际使用的其他驱动。按使用场景验证 TLS、SSH 和权限。DBeaver 连接元数据迁移使用明确选择的文件，凭据由使用者重新录入。
3. **对象管理与工具**。验索引、约束、权限与其他常用对象的查看和修改。补需要的备份恢复。验证结构和数据比较、ER、历史与收藏，保留独立回读证据。
4. **切换验收**。在本机 Community 26.2.3 上复核实际任务和必要的交互习惯。按工作流切换，全部通过后再移除旧工具。安装包留在内部测试流程，正式发布另行决定。

## Agent Note · 第一批多行复制

**状态** 已在 Windows 托管 runner 上使用实际候选安装包验证。

**问题** 结果网格已有单元格和整行复制，当前页勾选多行后需要一个批量复制入口。

**决定** 复用结果网格行选择、全文读取和剪贴板路径。输出含表头的 TSV，按网格原有顺序保留精度及暂存修改。全文取值全部成功后写入剪贴板。取值期间刷新或切换结果会取消此次复制，刷新继续管理自身的忙碌状态。

**备选方案** 矩形选择、跨页复制和批量粘贴分开实现，以便分别验证行列选区、数据规模和事务副作用。

**验收** 组件回归覆盖多行列序、TSV 引号、长文本、精确数值、过期结果及取值失败。Windows 托管 runner 从 `ad72a03` 候选 EXE 全新安装，通过连接表单保存专用 MySQL 连接并执行查询，再逆序勾选两行。独立 MySQL 查询生成预期值，系统剪贴板逐字匹配表头、显示顺序、精确整数和长文本。安装包 SHA-256 为 `e5c20d2bc3a6427878ed98c7ddb7beb26e1cb344f543ae75147ec4483ba08dc2`。[候选包构建](https://github.com/SophiaData/dbstudio/actions/runs/44771568587) · [验收报告](https://github.com/SophiaData/dbstudio/actions/runs/44777573723)
