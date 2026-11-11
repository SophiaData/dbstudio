# MySQL 事务正确性真实验收

日期：2026-11-07。MySQL 8.0.46，专用合成实例。结论：本轮新增3项原生事务对照通过，未执行GUI提交/错误恢复验收，完整生产与对标目标仍进行中。

## 实际结果

[当前版本原始结果](evidence/transaction-summary-e83b5c0a.json)共选择3项，定义列表中原8项保留，合计11项定义；本次没有重跑原8项，不称“11项全套本轮通过”。

| 用例 | 真实数据库证据 | 结果 |
| --- | --- | --- |
| 提交可见性 | driver将新专用表id1从0改7，自身可见7，新autocommit/read-only observer仍见0；commit后active=false/pending=0，另一次新observer见7 | 通过，已提交值保留 |
| 1062重复键 | 先在同事务更新marker2=7，再多行INSERT先插入id3、后碰撞id1，实际1062/23000；id3也已语句回滚，先前marker写入与active/pending1保持，NOWAIT3572证明其锁未释放；外部仍见0，最终rollback后恢复0 | 通过 |
| 1205锁等待超时 | 原生连接继承1秒timeout，服务器rollback_on_timeout=0；另一会话锁住id1，原生事务先改marker2再更新id1，实际1205/HY000；此前写入、锁及pending1仍保持，最终两会话rollback恢复0 | 通过，限定当前OFF配置 |

三个用例均实际退出0、PASS、cleanupConfirmed=true，原805行与其他GUI素材保持。所有测试仅新增本轮native_tx_contract_*表，表和提交用例的v7均保留为证据；cleanupConfirmed指会话/事务收尾和合同后验，不表示删除表或撤销已成功提交的值。

这些结果验证此前1213补丁没有将1062/1205错误一概当作整事务回滚。没有新增driver修复：产品driver源码仍为3fc1085f9cfb3dfbd63b00b149c9c10351490a7bf07a1cdff528a126be5c9261。

## 超时故障注入与恢复

[只读提示探针](evidence/lock-timeout-hint-8.0.46.json)实测SET_VAR提示后会话值仍50，并有警告3637，未据此宣称已触发1205。实际用例由单一parent runner在编译完成后，对固定owned容器临时设置global timeout=1，新连接再核继承值；不修改本机、其他容器或已有GUI素材。

[修改前记录](evidence/transaction-timeout-before-e83b5c0a.json)为原值50、请求1、rollback_on_timeout OFF。[恢复记录](evidence/transaction-timeout-restored-e83b5c0a.json)确认finally恢复原值并以独立连接回读。真实1205路径验证通过，globalTimeoutRestored=true。

每次管理SQL前验证固定容器ID、run/owner标签、镜像、running与root身份；mysql进程内部使用本run生成的私有defaults配置，外部证据不包含密码或原始命令错误正文。

当前runner使用固定服务目录的排他mkdir租约；正常恢复确认后核归属，将租约移动保留到本轮私有证据目录。parent已实测归档目录存在、固定锁已释放，未删除文件。此次是串行成功路径，没有执行真实双runner争抢测试，也不保证外部管理员并发写入或父进程自身SIGKILL后的finally恢复；恢复未知时保留锁并拒绝后续自动重入。

## 版本与验证范围

[当前版本证明](evidence/transaction-version-e83b5c0a.json)记录parent在运行前后核对的三个来源摘要，以及正常租约归档/释放观察：

- runner：047cb75f26aa4a9a1f5ae2e52e8072a0e129ee5a36afce277fcf2063e51776b4。
- 测试：46d84b6de9b2a53ff1db025713846dc8640375c11719f7e52589a87657f99fa9。
- driver：3fc1085f9cfb3dfbd63b00b149c9c10351490a7bf07a1cdff528a126be5c9261。
- 本轮原生测试二进制：cbe86f4677ffb488e10e43ef2a116ee65d15b20e2926154c560c246354f03475。

执行为offline/locked、全新私有target、精确3个ignored测试，退出0；测试源码、runner/global guard及随后lease改动分别完成独立只读D2。旧[串行版本首次结果](../../../backups/mysql-transaction-contract-576e42f3aad541919b52b9b59f8b1591/summary.json)也保留；其通过仅归旧runner4e4版本，没有代替当前租约版本验证。两次运行的3项不是6个不同场景。

## 尚未证明

- GUI提交前后独立observer可见性、GUI1062/1205和保存点死锁失败恢复。
- rollback_on_timeout=ON、COMMIT网络故障导致结果未知、断网取消、进程崩溃与长期稳定性。
- 跨构建凭据恢复，仍保留先前真实失败；此次没有读取或修改系统凭据策略。
- 本次事务记录时点专用EXPLAIN API尚未分派；后续已实现并通过新候选的真实打开/刷新/返回链，见[EXPLAIN实证](explain-acceptance.md)。参数、其他格式和GUI错误体验仍有差距，不将已过SQL EXPLAIN SELECT与专用面板验收混同。

其余范围及既有同二进制真实GUI回滚证据见[总体验收记录](real-acceptance-results.md)与[进度](progress.md)。
