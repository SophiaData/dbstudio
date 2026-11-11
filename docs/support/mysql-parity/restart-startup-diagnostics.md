# 正常重启启动阶段诊断与独立尝试

2026-11-07。已实测restart-probe：storageAccessible/markerMatched/nonemptyStore均true，window/page/originAllowed均true；业务调用与keyring计数为零，正常exit0。marker没有丢失。第一次restart实际失败仍为180s超时/缺ui报告，不能从probe推断App或凭据根因。

## 最小新profile

只新增现有四环境变量内phase=`restart-attempt`，复用相同合法run/root/store/ns与合成连接。host内部保留profile识别，Context和业务观察snapshot中的**语义phase映射为restart**；原有frontend九checks与report schema不变，正常marker gate/密码initial-only门槛不变。此profile走正常工作台，不是零业务probe。

每次只由parent追踪本次spawn PID，并使用：

- `evidence/startup-trace-<pid>.jsonl`：host按本进程PID创建wx600，最多128条/32KiB固定记录，保留打开文件句柄后追加；不是任意路径接口，不输出参数/结果/异常文本。
- `evidence/ui-restart-<pid>.json`：原精确三字段UI封套，严格restart九checks/row/actions，wx600。
- `evidence/real-ui-restart-<pid>.json`：parent联合报告，wx600。保留旧ui-initial、real-ui-report、旧失败real-ui-restart-report与hostmanifest原字节。

`--run-restart-attempt`新CLI，原`--run-restart`对已使用固定报告的拒绝保留。新CLI复用严格artifact/source/live/合法hoststore/initial3件门槛；允许第一次失败报告存在，但前后计算它的哈希不变，不读取secret/legacy文件。timeout60s，仅终止本次child；即使失败仍新observer核所有合成body/其他素材并保独立失败报告。报告成功仍必须全部九DOMchecks、当前进程native方法、keyringSets0/hits>=1、正常exit和fresh两observer，不能以trace完整或exit0代替。

## 固定阶段与记录schema

```ts
// 每条只这四键；seq为host单调1起，文件名PID为自身PID。
interface TraceRecord {
 schemaVersion: 1
 seq: number
 stage: 'main_enter' | 'preflight_passed' | 'app_import_enter' | 'app_import_passed' |
  'app_mount_enter' | 'app_mounted' | 'listener_enter' | 'listener_passed' |
  'boot_enter' | 'boot_passed' | 'dom_enter' | 'main_failed' | 'mounted_failed' |
  'native_enter' | 'native_returned' | 'native_failed' |
  'keyring_get_enter' | 'keyring_get_returned' | 'keyring_get_failed'
 method: 'none' | 'listDialects' | 'listConnections' | 'migrationStatus' | 'other'
}
```

不接收pid/path/SQL/字符串错误/DOM/storage内容。stage是closed enum。非native stage的method必须none；native method由host从既有method名分类，未知一律other，不复制任意入参字符串。

frontend RPC=`mysqlAcceptanceStartupTrace`，唯一arg精确`{schemaVersion:1,stage:<非native阶段>}`，1KiB最大。main+localorigin gate；probe阶段仍早拒；非restart-attempt的普通initial/restart test profile可返回null但不写trace，生产无此接口。host启动restart-attempt时预创建trace文件，API只追加固定记录。原生业务call在spawn_blocking前记录native_enter，成功/错误返回后相应记录returned/failed（含join failure），不记录参数或结果。

frontend仅VITE_MYSQL_PARITY=1的guard里调用trace辅助，失败不得泄漏或额外修复产品行为。main在preflight前main_enter、通过后preflight_passed、App动态import前后、mount前；maincatch记录main_failed且保原固定文案。App onMounted在开始、listen前后、boot前后、DOM入口记录。mounted异常只记录mounted_failed，不把listen/boot异常静默写成成功。无更多storage读取，也不写默认用户store。

## 写域和验证

- http-production-entry：唯一改main.ts、App.vue、mysql-parity-dom.ts trace辅助及runner。先备份，保普通产品事件路径与initial/restart用例。runner读本次精确PID文件，验证closed trace结构/seq/条数，仅脱敏输出阶段；不能扫描目录/读raw日志。报告不把pending native_enter自动叫keychain错误。
- remote-db-policy：唯一改mysql_acceptance.rs/lib.rs/buildscript，phase语义映射、trace严格门控和独立文件、新pure负例。旧32项保留；准确新testnames/count交Lead。先备份，不runCargo/GUI/vault，不变业务core/drivers/凭据。
- Lead统一D2、同源编译和真实attempt。诊断先得事实再决定产品修复，不凭当前markertrue猜boot、keyring或监听失败。
