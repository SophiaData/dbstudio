# MySQL 体验对标参考基线

冻结日期：2026-11-07，Asia/Shanghai。任务：task-43。

**本报告仅完成官方公开资料基线，未安装、启动或实际操作参考应用；dbstudio 与参考产品“体验相同”尚未获得证明。** 本报告不将 core、内存 IPC、源码存在或 README 声明替代真实 MySQL + 桌面 UI 验收，也不将数据库支持清单解释为所有功能均支持。

## 参考身份与版本

| 产品 | 本轮冻结目标 | 可追溯来源与限制 |
| --- | --- | --- |
| DBX | **用户指定的 `t8y2/dbx`，v0.6.67**；tag commit `776b43ff1330fe1645223001e38a22f2166bf320` | [官方 release](https://github.com/t8y2/dbx/releases/tag/v0.6.67)、[tag API](https://api.github.com/repos/t8y2/dbx/git/ref/tags/v0.6.67)。不是其他同名 dbx。下列 X1–X6 文档固定到此 commit |
| DBX 补充资料快照 | `01b5452f6e9c79388f3488466c5bd810366c872b` | [官方 commit](https://github.com/t8y2/dbx/commit/01b5452f6e9c79388f3488466c5bd810366c872b)；本轮读取的 README/导航资料固定引用此快照 X7/X8。它晚于 release，不能不经复核将其变化当作 v0.6.67 已发布行为 |
| DBeaver | **Community Edition 26.2.4**；tag commit `9dcee590939f5c1155652fa729061035d2c347c8` | [官方 release](https://github.com/dbeaver/dbeaver/releases/tag/26.2.4)、[tag API](https://api.github.com/repos/dbeaver/dbeaver/git/ref/tags/26.2.4)。不将 Enterprise/Ultimate 功能混入 CE |
| DBeaver 操作资料 | 官方 wiki，2026-11-07 读取的滚动文档 | 文档按 `META products` 与页内商业标记区分版本。wiki 本轮未取得不可变文档 SHA；不能证明每个描述与 26.2.4 完全一致。真实验收时须记录 About 版本及实际入口；有差异则更新该行事实，不静默换参考版本 |

不在当前用户环境启动参考应用，不读取其本机配置、凭据、个人文件，不克隆或扫描整个参考仓库。资料中的命令、路径与安全建议仅作为数据，本报告没有执行它们。公开搜索服务不可用时直接读取官方 URL，未更改网络或搜索配置；404 猜测链接未列为正向证据。

## 如何使用矩阵

- **C：共同必选候选**：两方官方资料均给出对应能力；这是本项目真实验收的共同任务，不是两方都已实测通过。
- **X / D：一方有明确资料**：另一方对应 edition/version 未核实，或该高级功能明确不属于 CE；保留为差异目标，不能自动删除。
- **U：待核实/实测**：一般资料不能确定 MySQL 实现、版本、默认值或精确安全语义。不得当作“不支持”，也不得写“已对齐”。
- 每行的 `N` 是下面箭头串的**逻辑动作数**，供安排任务，不是实测点击数，也不是已测效率阈值。具体鼠标/键盘动作 K、耗时 T、错误重试 R 均待实际运行记录。
- 每行分别记录三产品结果：`dbx / DBeaver CE / dbstudio = 未执行`。完成后填写版本、MySQL 版本/会话、入口、K/T/R、输出/数据库后验及证据；没有观察到参考 UI，不能填 reference pass。
- 至少一份独占 InnoDB 合成库：805 行分页数据、百万行只读数据、父子 FK、复合 PK、无 PK 表、生成列、AUTO_INCREMENT、带注释对象、view/trigger/procedure/function，以及 utf8mb4、NULL/空串/空白、BIGINT > 2^53、DECIMAL、JSON、LONGTEXT、BLOB、DATETIME(6) 和特殊标识符。数据/服务准备由专职任务承担，本报告不执行写库。
- CRUD 包括删除能力，但当前“不执行 DELETE/DROP/文件删除”约束继续有效：相应任务可验证入口/预览/取消，**真实提交删除仍标受限，不计端到端通过**。不能用预览代替真实删除，也不能因约束从清单删除高级项。

## 可观察任务矩阵

下列全部为待执行任务。预期结果是应观察并对照的验收点；不同产品事务或导出语义不能被强行改成相同，先记录差异，再由 Lead 判定本项目目标。

### 连接、认证与网络

| ID / 类别 | 原生 UI 任务与逻辑动作数 | 应观察的结果 | 资料 |
| --- | --- | --- | --- |
| M01 / C | N=5：新连接→MySQL→填写专用地址/数据库/认证→Test→保存并展开 | 清楚显示目标/端口/数据库；test 成败可区分；保存后连接可展开；不得将 Test 当成已保存 | [X1] [D1] |
| M02 / C+U | N=4：编辑现有连接→仅改名称→保存→断开重连 | 未填写的新密码不应意外清掉原凭据；错误密码可纠正后重试；保存与再次认证各自状态明确。具体凭据保留行为待测 | [X1] [D1] |
| M03 / C+U | N=4：启用 SSL→选专用 CA/身份验证配置→Test→查询连接信息 | 正确 CA/名称能连接；错误 CA 与错误名称各自失败且不自动降为 insecure。不能把“TLS on”当成 verify-full；精确模式和 MySQL 驱动属性待测 | [X1] [D1] [D2] |
| M04 / C+U | N=5：添加 SSH→专用跳板/认证→测试隧道→测试 MySQL→保存连接 | 隧道与 DB 失败应可区分；SSH 密码/密钥、口令入口明确；host-key pin/known-host、隧道与 SSL 名称校验组合均须单独实测 | [X2] [D3] |
| M05 / D+U | N=4：选择 agent/jump server 或共享 tunnel→配置→Test→两连接重连 | DBeaver 文档明确 agent、jump servers、共享隧道；DBX 文档明确共享 profile/多层传输，不能据此假设 agent 完全相同。重连不得混用目标 | [X2] [D3] |
| M06 / C+U | N=4：提交错误地址/认证→查看错误→修正→重试 | 无 secret 回显；错误能定位配置层；重试无需重建全部连接；错误后 UI 不永久 busy。认证插件、public-key-retrieval 默认行为须记录 | [X1] [D1] |

### 浏览、对象与结构管理

| ID / 类别 | 原生 UI 任务与逻辑动作数 | 应观察的结果 | 资料 |
| --- | --- | --- | --- |
| M07 / C | N=4：展开连接→选择 database→打开 tables/views→打开列/索引信息 | MySQL database/catalog 层级、活动库、对象注释/类型明确；多库不串名；刷新可见变更 | [X7] [D1] |
| M08 / C+U | N=4：搜索对象/列→定位→打开→刷新 | 搜索范围与是否只搜索已加载对象可见；同名不同库对象正确；查不到不能伪报为空库；具体 search/pin/cache 实测 | [X7] [D1] |
| M09 / C | N=5：新建表→填列/主键/默认值/注释→预览 DDL→确认创建→刷新结构 | 类型/标识符/NULL/default/AUTO_INCREMENT 正确，执行失败可修正；不是只能写 SQL 才“拥有可视建表” | [XT] [D1] |
| M10 / C+U | N=5：打开结构→修改列类型/注释/顺序→预览 ALTER→应用→重新打开 | MySQL charset/collation、精度、物理列序与本地显示序分清；DDL 隐式提交风险不假装可回滚；权限错误保留草稿 | [XT] [D1] |
| M11 / C+U | N=5：打开 indexes/FK→新增组合索引或 FK 草稿→预览→取消或获准创建→刷新 | 组合列顺序、unique、引用库表与更新规则可检查；无入口不得以 metadata read 替代编辑能力；删除仅预览/取消 | [XT] [D1] |
| M12 / C+U | N=5：选择 view/trigger/procedure/function→查看源码→编辑草稿→预览→取消或获准新建独占对象 | 多语句 routine body/DELIMITER、definer、权限与对象刷新正确；MySQL 不能 ALTER 的对象不得伪装原子替换；真实旧对象 DROP 不执行 | [XT] [X7] [D1] |
| M13 / C+U | N=4：切到另一连接/库→打开同名对象→执行只读查询→切回 | 编辑器/结果/DDL明确所属连接库，不被侧栏选择误改；USE/默认 database 的同步行为待测 | [X1] [X4] [D1] [D4] |

### SQL 编辑、执行与参数

| ID / 类别 | 原生 UI 任务与逻辑动作数 | 应观察的结果 | 资料 |
| --- | --- | --- | --- |
| M14 / C | N=4：打开 SQL→输入别名/表名前缀→触发补全→接受并执行 | 关键字、当前库表列、别名上下文正确；不同连接候选不串库；打开候选后执行快捷键仍可执行，具体热键以平台实测 | [X4] [D5] |
| M15 / C | N=4：写两条 SQL→选中其中一条→执行→检查结果标签 | 只执行选区/当前语句；整脚本入口与单语句入口区分，错误行号与结果对应 | [X4] [D4] |
| M16 / C+U | N=5：写参数 SQL→输入类型和值→执行→修改选区→重新绑定执行 | 位置/命名参数不能跨语句错位；NULL/整数/引号字符串不靠不安全拼接；缺参在执行前提示；实际支持语法逐项记录 | [X4] [D4] |
| M17 / C+U | N=4：多语句含字符串分号/注释/routine→执行脚本→中间制造错误→再执行 SELECT 1 | 分割不破坏语义；前后语句状态、错误策略、结果保留与恢复明确；不要求复制另一产品并发执行策略 | [X4] [D4] |
| M18 / C+U | N=4：执行只读慢查询→取消→检查终态→执行 SELECT 1 | 区分请求已接受/无法取消/执行完成；busy 必清；连接可继续用。记实际取消耗时，不用 UI 消失推断服务器已停 | [X4] [D4] |
| M19 / C | N=4：运行查询→打开 history→收藏/保存→重开并恢复 | 文本、目标连接与参数敏感值边界明确，保存失败不会伪成功；不把历史内存状态当重启持久化 | [X4] [D4] |
| M20 / C+U | N=4：格式化 SQL→打开 EXPLAIN→定位对象→回编辑器 | 格式化不改字面量；EXPLAIN 是结果而非执行危险 DML；计划树/文本与 MySQL 权限匹配；专用计划可视化深度待测 | [X4] [D1] [D4] |

### 结果网格、完整值与编辑

| ID / 类别 | 原生 UI 任务与逻辑动作数 | 应观察的结果 | 资料 |
| --- | --- | --- | --- |
| M21 / C+U | N=5：按唯一键打开 805 行表→设页大小→连续翻页→返回→执行带 LIMIT 查询 | 无漏重、页 offset/hasMore/结果上限清楚；LIMIT 总数不能误作全表总数；可配页大小/跳页/增量读取方式分别记录 | [X5] [D6] |
| M22 / C+U | N=5：服务器 WHERE→服务器 ORDER BY→跨页→局部搜索→清除条件 | 明确服务器过滤/全结果排序与已加载页过滤/排序的区别；重载不误保留旧数据；条件可组合程度与 NULL 条件需记录 | [X5] [D6] |
| M23 / C+U | N=4：拖列宽/列序→冻结/隐藏列→转置或详情→重开 | 宽表可导航；设置是否按表/查询持久化明确；不能用“有表格”代替该效率能力。两方精确控制项待逐项操作 | [X5] [D6] |
| M24 / C+U | N=5：打开 LONGTEXT/JSON/BLOB→读完整值→切换另一个单元格→复制/另存→校验 | >预览阈值文本、NUL、hex、NULL/空串、BIGINT/DECIMAL无静默损失；迟到响应不覆盖新草稿；read-only仍可看完整值 | [X5] [D6] |
| M25 / C+U | N=5：选择单元格矩形→复制 TSV/JSON/INSERT→粘贴合成新行→检查草稿→取消 | 列偏移/隐藏列/换行/引号处理准确；主键排除和列名选择明确；批量 paste/clone/SQL preview 不自动简化成单单元格能力 | [X5] [D6] |
| M26 / C+U | N=5：编辑普通值→设 NULL/默认→预览 SQL→保存到事务→独立只读验证 | 行身份准确，生成列不可错误写入；no-PK/join 不可安全编辑时给原因；唯一/外键失败不清草稿或伪成功 | [X5] [D6] [D7] |
| M27 / C+U | N=4：新增行填值→触发脏稿守卫→取消→再次打开 | 默认值/生成值/遗漏必填列提示；取消保留草稿，未发送插入；保存成功才关闭/刷新。clone 和连续新增效率另记 | [X5] [D6] |
| M28 / C+U | N=4：标记待删除行→查看目标/SQL→取消→检查 DB 未变化 | CRUD 删除入口和精确 key 可观察；本轮只验证预览取消，不提交 DELETE，真实删除能力保持未验证 | [X5] [D6] |
| M29 / X+U | N=4：查看 FK 单元格→导航关联记录→返回→确认过滤上下文 | DBX 明确 FK record navigation；DBeaver CE 精确入口本轮未取得直接正文，列待实测，不当作不存在 | [X5] [D1] |

### 事务、失败恢复与效率

| ID / 类别 | 原生 UI 任务与逻辑动作数 | 应观察的结果 | 资料 |
| --- | --- | --- | --- |
| M30 / C+U | N=5：确认事务模式→修改两行→查看 pending→rollback→另一会话验证 | 区分 UI dirty、应用到 DB 未提交、最终提交；rollback 不误回滚别连接。DBeaver 有 manual/auto/smart；DBX 精确默认模式需现场核实 | [X4] [X5] [D7] |
| M31 / C+U | N=5：两标签同连接各有草稿→切标签/翻页/关闭→选择取消→apply后commit→重查 | 操作归属清楚；取消不丢稿；apply 后 offset 400 失败翻 600，再试仍请求 600；跨标签同连接事务影响必须说明 | [X5] [D6] [D7] |
| M32 / C+U | N=5：执行错误 SQL/触发超时→看原错误→读事务状态→改错→SELECT 1 | 原错误不被二次状态失败覆盖；缓存 active/pending 与真实状态同步；MySQL deadlock/连接丢失/implicit commit 分开观测，不能伪造原生复现 | [X4] [D4] [D7] |
| M33 / C+U | N=4：切换断开的连接→重新连接→刷新 metadata/result→继续编辑 | 旧 cursor/结果不被拿到新会话；断连后 draft/重试策略可解释；不得把重连成功当查询已重放成功 | [X1] [X4] [D1] |

### 导入导出、ER 与比较

| ID / 类别 | 原生 UI 任务与逻辑动作数 | 应观察的结果 | 资料 |
| --- | --- | --- | --- |
| M34 / C | N=6：从空表Import→选择CSV→预览/编码/NULL规则→映射→确认执行→查询后验 | 源列到目标列唯一且生成/必填列合理；中文/逗号/换行/NULL/空串/日期精度正确；小样本与10万行计数均准确 | [X6] [D8] |
| M35 / X+U | N=5：选择XLSX/JSON/SQL或多文件→选sheet/shape→预览→映射→只在获准新表执行 | DBX 明确多格式/多sheet建表；DBeaver文档有XLSX/XML参数但本轮未核完整格式edition表，CE实际format入口待确认，不统称共同支持 | [X6] [D8] |
| M36 / C+U | N=5：开始大导入→中途取消或触发重复键→看终态→查询已写行→重试独占新目标 | 成功/取消/部分写入/未知提交不混淆。DBX文档不保证已提交批次回滚；DBeaver依load/commit设置；本项目原子性是独立要求，不为相同体验降低安全性 | [X6] [D8] |
| M37 / C | N=6：从查询/全表发起Export→选scope/columns→选格式→新目标→执行→独立验证文件 | 已加载/选中/全查询三种范围清楚；CSV/JSON/SQL/Markdown等实际格式分别记录；不能用 a.download 点击或success toast代替文件内容核验；自动换格式需清旧扩展名 | [X5] [D9] |
| M38 / C+U | N=5：跨连接复制表或导出到DB→选结构/数据模式→preview→取消或获准新目标→校验 | source/target、映射、DDL/索引/default保留情况明确；append与overwrite分开。覆盖路径含DELETE，本轮不执行；不是静态CSV导出的同义项 | [XX] [D9] |
| M39 / D+U | N=5：从schema/table打开ER→显示列/FK→调整布局→导出可用格式→验证 | DBeaver CE有浏览/布局/PNG等导出；官方SVG明确PRO，不能当CE必选。DBX README宣传ER但本轮未核精确release入口/格式，待核实；本项目SVG任务可独立验 | [X8] [D10] |
| M40 / X | N=6：选schema source/target→选对象→比较→看DDL/依赖→导出→确认无写库 | DBX文档明确schema diff（含view/index/trigger/routine等依能力）；DBeaver正式Schema Compare文档标EE/UE。CE是否另有简单metadata compare待核，不把二者等同 | [X3] [D11] |
| M41 / X | N=6：选两表→选可靠复合键→比较→看缺失/多余/变更→生成SQL→确认未执行 | DBX data compare明确可选syncSQL；DBeaver Data Compare标EE/UE，非CE共同；大整数/NULL/键类型、方向、容量/不完整结果必须明确 | [X3] [D12] |
| M42 / D+U | N=5：选MySQL原生脚本/backup入口→确认本机工具需求→生成计划→取消危险restore→只核验输出范围 | DBeaver支持native MySQL client script/backup；DBX也宣传SQL导入与DB export但精确dump路径本轮未查。保留高级项，restore/删除动作不执行 | [X6] [D1] [D4] |

## 效率对照与通过方式

以上 42 行全部保留，不以“高级”“不常用”默认豁免。Lead 可先推进 M01/M07/M14–M18/M21–M28/M30–M37 的真实 MySQL 主链，M03/M04 与对象管理同样保持必需项，不由基础链通过自动解除。

每个任务对三个产品使用同一个合成库状态、同一服务器版本、同样网络路径与等价事务/页大小配置，记录：首次找到入口时间、首次成功总耗时、逻辑步骤 N 与实际操作 K、是否需手写 SQL 绕过、错误恢复次数 R、正确结果、草稿/事务保留，以及可观察截图或脱敏事件。参考应用也必须执行；本阶段没有任何实测 K/T 数值。DBeaver 文档给出的 Ctrl+Enter/Ctrl+Space 等快捷键需按目标平台实际映射记录，不能直接把 Windows 键位当 macOS 成绩。

建议单行结果拆为 correctness / safety / workflow availability / efficiency 四列，取 `通过 / 部分 / 失败 / 未执行 / 受限`。缺少参考实测或本项目只跑 mocks 时，不能填“体验对齐”；产品明确较安全的差异可记录优于基线，不强制复制另一个产品可能部分提交的行为。C 行目标是共同工作流，X/D 行目标是保留高级差异及明确路线，不把CE无此商业功能当成项目永远可忽略它的理由。

已知重要参考差异：DBeaver Data Compare 和完整 Schema Compare 页明确商业版；ER SVG标PRO。DBX导入默认可把空串视为NULL、取消不保证回滚已提交批次，必须记录配置和实际残留行数。DBX v0.6.67 release还修复了MySQL LIMIT行数/分页统计、对象注释加载与手动事务中断后busy恢复问题；这些是应实际挑战的场景，不是reference本次已通过证明。

## 官方证据索引

X 链接为冻结 commit 文档（X7/X8 已另标补充snapshot）；D 链接为本轮读取的官方滚动wiki，edition标记优先于一般feature宣传。未实测版本一致性的行维持待核实。

[X1]: https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/docs/content/docs/getting-started.mdx
[X2]: https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/docs/content/docs/ssh-tunnel.mdx
[X3]: https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/docs/content/docs/schema-diff.mdx
[X4]: https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/docs/content/docs/query-editor.mdx
[X5]: https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/docs/content/docs/data-grid.mdx
[X6]: https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/docs/content/docs/table-import.mdx
[XT]: https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/docs/content/docs/table-structure.mdx
[XX]: https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/docs/content/docs/data-transfer.mdx
[X7]: https://github.com/t8y2/dbx/blob/01b5452f6e9c79388f3488466c5bd810366c872b/docs/content/docs/schema-browser.mdx
[X8]: https://github.com/t8y2/dbx/blob/01b5452f6e9c79388f3488466c5bd810366c872b/README.md
[D1]: https://github.com/dbeaver/dbeaver/wiki/Database-driver-MySQL
[D2]: https://github.com/dbeaver/dbeaver/wiki/SSL-Configuration
[D3]: https://github.com/dbeaver/dbeaver/wiki/SSH-Configuration
[D4]: https://github.com/dbeaver/dbeaver/wiki/SQL-Execution
[D5]: https://github.com/dbeaver/dbeaver/wiki/SQL-Assist-and-Auto-Complete
[D6]: https://github.com/dbeaver/dbeaver/wiki/Data-Editor
[D7]: https://github.com/dbeaver/dbeaver/wiki/Auto-and-Manual-Commit-Modes
[D8]: https://github.com/dbeaver/dbeaver/wiki/Data-import
[D9]: https://github.com/dbeaver/dbeaver/wiki/Data-export
[D10]: https://github.com/dbeaver/dbeaver/wiki/ER-Diagrams
[D11]: https://github.com/dbeaver/dbeaver/wiki/Schema-compare
[D12]: https://github.com/dbeaver/dbeaver/wiki/Data-compare

- [X1]：DBX连接建立、测试保存、凭据与desktop/web路径边界。
- [X2]：DBX SSH与共享多层transport。
- [X3]：DBX结构/数据比较、方向、范围、DDL与syncSQL。
- [X4]：DBX执行、参数、补全、EXPLAIN、history、恢复说明。
- [X5]：DBX网格、完整值、编辑、SQL preview、范围与导出。
- [X6]：DBX导入格式、映射、默认空串处理、失败/取消边界。
- [X7]、[X8]：DBX导航与宣传能力补充，不作为旧release精确行为证明。
- [DBX表结构编辑器](https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/docs/content/docs/table-structure.mdx)：M09–M12的列/索引/FK/trigger与MySQL物理列序证据。
- [DBX数据传输](https://github.com/t8y2/dbx/blob/776b43ff1330fe1645223001e38a22f2166bf320/docs/content/docs/data-transfer.mdx)：M38的跨库、结构保留、append/overwrite与事务边界证据。
- D1–D12按上述命名对应官方MySQL/SSL/SSH/SQL/网格/事务/导入导出/ER/比较页面；其中D11/D12明确EE/UE-only，D10的SVG明确PRO。D6正文抓取受站点导航截断影响，本轮仅确认官方Data Editor入口，不将具体grid细节当26.2.4 CE精确已证，相关细节均带U或以真实验证任务表达。

本轮交付为参考资料冻结与验收脚本，不含任何参考应用或dbstudio的新增实机通过结果。
