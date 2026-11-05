/**
 * 验证清单的**唯一真相**。
 *
 * ===== 为什么需要这一份 =====
 *
 * 早先验证步骤散落在两处：
 *   - `package.json` 的 `verify` 脚本（一长串 `&&`）
 *   - `.github/workflows/verify.yml`（一份手抄的步骤列表）
 *
 * 两份手抄的清单必然漂移：加了一个测试只改了一边，CI 就在「绿」的状态下
 * 漏跑它——而且**看不出任何异常**。这类失败最危险，因为它不报错，
 * 只是悄悄不再验证某件事。
 *
 * 所以清单只能有一份，本文件就是它。`package.json` 与 CI 都从这里派生。
 *
 * ===== 分组约定 =====
 *
 * - `node`：纯 Node 跑得动的测试（不需要显示器）。
 * - `gui`：需要真实 Electron 窗口。Linux CI 需要 xvfb。
 * - `external`：需要外部服务（PG / sshd）。本地没环境时**跳过**并明确标注，
 *   CI 里则必须提供，否则应判失败。
 *
 * 之所以区分 `external`：早先的 CI 虽然调用了 `pnpm run test:postgres`，
 * 却没设 `DBSTUDIO_PG_URL`，于是每次走「缺环境→exit 0」的跳过分支——
 * CI 全绿，但 **PG 驱动从来没在 CI 里被真正验证过**。
 * 绿得没有说服力的 CI 比没有 CI 更危险。
 */

/**
 * @typedef {object} Step
 * @property {string} id           package.json 里的脚本名。
 * @property {string} title        人类可读的说明（用于日志与 README 同步）。
 * @property {'node'|'gui'|'external'} group 分组。
 * @property {string[]} [env]      必需的环境变量。缺任一个 → 跳过（external 组）。
 */

/** @type {Step[]} */
export const STEPS = [
  // ---- 准备 ----
  { id: 'typecheck', title: 'TypeScript 类型检查', group: 'node' },
  { id: 'test:architecture', title: '架构护栏：跨层 import 与 renderer 后端直连', group: 'node' },
  { id: 'build', title: '构建宿主 + main/preload/renderer', group: 'node' },
  { id: 'check:bundle-boundaries', title: '构建产物边界：驱动实现与 Node 运行时隔离', group: 'node' },
  { id: 'fixture', title: '生成测试夹具', group: 'node' },

  // ---- 纯 Node e2e ----
  { id: 'test', title: '元数据 / 连接 e2e', group: 'node' },
  { id: 'test:resultset', title: '结果集 e2e（查询/分页/游标）', group: 'node' },
  { id: 'test:edit', title: '在线编辑与事务 e2e', group: 'node' },
  { id: 'test:persist', title: '持久化与凭据 e2e', group: 'node' },
  { id: 'test:mutations', title: '增删改与完整取值 e2e', group: 'node' },
  { id: 'test:ddl', title: 'DDL 与编辑连接 e2e', group: 'node' },
  { id: 'test:ddl-preview', title: '结构化 DDL 预览与风险契约', group: 'node' },
  { id: 'test:connection-lifecycle', title: '连接故障恢复与并发建连', group: 'node' },
  { id: 'test:driver-host-stress', title: '驱动宿主连续启动与退出压力', group: 'node' },
  { id: 'test:sql-script-parser', title: '方言级 SQL 脚本切分与源码位置', group: 'node' },
  { id: 'test:postgres-edits', title: 'PostgreSQL 编辑列名与组合主键契约', group: 'node' },
  { id: 'test:sql-library', title: 'SQL 历史与收藏存储', group: 'node' },
  { id: 'test:statement-execution', title: '语句执行契约与三态结果 e2e', group: 'node' },
  { id: 'test:explain', title: 'SQLite 执行计划 RPC 与错误恢复', group: 'node' },
  { id: 'test:verify-manifest', title: '验证清单自身的一致性', group: 'node' },
  { id: 'test:backend-contract', title: 'Renderer 后端契约：缺失降级、可读错误与注入 identity', group: 'node' },
  { id: 'test:backend-client-selection', title: '客户端连接签名、动态认证与非幂等请求单次发送', group: 'node' },
  { id: 'test:transaction-refresh', title: '事务变更按连接串行刷新所有标签', group: 'node' },
  { id: 'test:renderer-remote-config', title: 'preload 远程 endpoint 与运行时认证注入', group: 'node' },
  { id: 'test:driver-env', title: '驱动子进程不继承服务认证环境', group: 'node' },
  { id: 'test:http-transport', title: 'HTTP transport：wire codec、manifest 路由、取消/超时与 dispatcher', group: 'node' },
  { id: 'test:http-server-composition', title: 'HTTP server composition：principal、owner scope 与 remote capability', group: 'node' },
  { id: 'test:http-server-handler', title: 'HTTP server handler：body/response 限制、并发与断连取消', group: 'node' },
  { id: 'test:http-server', title: 'HTTP server listener：localhost 往返与优雅关闭', group: 'node' },
  { id: 'test:http-server-config', title: 'HTTP server 启动配置与认证 resolver 边界', group: 'node' },
  { id: 'test:http-auth', title: 'HTTP JWT 验签与认证异常脱敏', group: 'node' },
  { id: 'test:http-cors', title: 'HTTP 显式 origin 预检与认证隔离', group: 'node' },
  { id: 'test:http-server-runtime', title: '独立 Node HTTP 启动、数据目录、加密与关闭', group: 'node' },
  { id: 'test:http-owner-governance', title: 'HTTP owner 请求配额、生命周期与审计', group: 'node' },
  { id: 'test:http-artifacts', title: 'HTTP artifact 上传、下载与 owner 隔离', group: 'node' },
  { id: 'test:artifact-contract', title: '远程文件 artifact handle 与 ticket 契约', group: 'node' },
  { id: 'test:remote-contract', title: '远程连接 DTO 与出站目标 allowlist', group: 'node' },
  { id: 'test:remote-connection-contract', title: '远程 connection control route contract', group: 'node' },
  { id: 'test:http-connection-routes', title: 'owner-scoped connection HTTP routes', group: 'node' },
  { id: 'test:remote-connection-failure-recovery', title: '远程 connection quota 与失败恢复', group: 'node' },
  { id: 'test:remote-connection-flow', title: '远程连接 add/test/update 安全流程', group: 'node' },
  { id: 'test:owner-connection-lease', title: 'owner 连接租约生命周期与配额释放', group: 'node' },
  { id: 'test:api-surface', title: '公开 API surface golden snapshot', group: 'node' },
  { id: 'test:verify-runner', title: '验证 CLI 参数与真实子进程执行', group: 'node' },
  { id: 'test:cancel-sqlite', title: 'SQLite 取消能力声明与行为', group: 'node' },
  { id: 'test:sql-parameters-parser', title: 'SQL 参数扫描边界与值校验', group: 'node' },
  { id: 'test:sql-params', title: '参数化 SQL 与绑定安全 e2e', group: 'node' },
  { id: 'test:transfer-task', title: '流式导出任务与文件清理 e2e', group: 'node' },
  { id: 'test:transfer-boundaries', title: '导出取消与文件保全边界', group: 'node' },
  { id: 'test:transfer-wizard', title: '导出向导的校验与范围契约', group: 'node' },
  { id: 'test:import-validation', title: 'CSV 导入解析与预览契约', group: 'node' },
  { id: 'test:import-preview', title: 'CSV 有界预览与解析诊断', group: 'node' },
  { id: 'test:column-identity-contract', title: '列 identity 与 generated 元数据契约', group: 'node' },
  { id: 'test:import-required-columns', title: '导入必填列与 requiredOnInsert 契约', group: 'node' },
  { id: 'test:import-file-dialog', title: '原生 CSV 文件选择器与 IPC 白名单契约', group: 'node' },
  // --pure 在 GUI 初始化前退出，不启 Electron、不创建夹具。
  { id: 'test:import-form', title: 'CSV 导入表单与映射纯函数校验', group: 'node' },
  // SQLite 是 node 组的固定覆盖；PG 分支由测试内的 DBSTUDIO_PG_URL 可选启用，
  // 因而 --require-external 不会强制这层内嵌分支。
  { id: 'test:import-task', title: 'CSV 导入任务、SQLite 事务与回滚 e2e（PG 可选）', group: 'node' },
  // 以下三条是导入链路的**安全回归**：SQLite 走真实 node:sqlite，
  // PostgreSQL 走内存打包 + **假 pg Client**，因此属于 node 组、**不构成真 PG 证据**；
  // 真 PG 的导入成功/回滚仍需 `test:import-task` 配合 `DBSTUDIO_PG_URL`。
  { id: 'test:import-driver-safety', title: '导入驱动安全：影响行数、CRLF 与错误脱敏（模拟 PG）', group: 'node' },
  { id: 'test:import-rpc-safety', title: '导入 RPC 超时竞态：宿主隔离、在途拒绝与 commit 结果未知', group: 'node' },
  { id: 'test:import-pg-transaction-state', title: 'PG 事务控制语句与内部状态同步（模拟 pg Client）', group: 'node' },
  // 纯函数回归：不启 Electron、不连数据库，只锁「导入终态文案」的措辞安全——
  // 提交结果未知 / 宿主被终止 / 回滚失败 三类都不得谎称"已回滚"。
  { id: 'test:import-result-messages', title: '导入终态结果文案分类：提交结果未知/宿主终止/回滚失败', group: 'node' },
  { id: 'test:metadata-contract', title: '结构元数据跨进程契约', group: 'node' },
  { id: 'test:sqlite-metadata', title: 'SQLite 外键、索引、CHECK 与触发器读取', group: 'node' },
  { id: 'test:er-relations', title: 'ER 外键关系纯逻辑契约', group: 'node' },
  { id: 'test:er-layout', title: 'ER 布局 key 与布局 JSON 纯逻辑契约', group: 'node' },
  { id: 'test:structure-compare', title: '结构快照确定性比较与同步 SQL', group: 'node' },
  { id: 'test:data-compare', title: '按唯一键的数据比较与同步计划', group: 'node' },
  { id: 'test:compare-live', title: '真实 SQLite 连接上的结构快照与数据比较（只读）', group: 'node' },
  { id: 'test:nosql-drivers', title: 'Redis / Kafka 只浏览驱动契约', group: 'node' },
  { id: 'test:bench-resultset', title: '结果集性能基线（首屏 / 分页 p95 / 深分页）', group: 'node' },
  { id: 'test:bench-transfer', title: '导出性能基线（吞吐与峰值内存线性度）', group: 'node' },
  { id: 'test:bench-metadata', title: '元数据性能基线（懒加载与读取次数）', group: 'node' },
  { id: 'test:upgrade-compat', title: '配置升级 / 降级兼容（隔离备份，不覆盖）', group: 'node' },
  { id: 'test:release-gate', title: '发布门禁与 draft 附件校验', group: 'node' },
  { id: 'test:packaged-smoke', title: '打包冒烟脚本的离线回归', group: 'node' },
  // 注意：这条跑在 Electron 里，但用 ELECTRON_RUN_AS_NODE 起进程，
 // **不创建窗口**，所以不需要显示器——归在 node 组。
  { id: 'test:electron', title: 'Electron 内置 Node 运行时验收', group: 'node' },
  { id: 'build:sdk', title: '构建 SDK 发布产物', group: 'node' },
  { id: 'test:sdk', title: 'SDK e2e（从 dist 产物导入）', group: 'node' },
  { id: 'test:sdk-contract', title: 'SDK 驱动契约矩阵（版本化能力 + 12 类能力）', group: 'node' },
  { id: 'test:handshake-contract', title: '握手 / 版本兼容性（SDK 与主进程双侧校验）', group: 'node' },
  { id: 'test:sdk-package', title: 'SDK 包外安装与使用', group: 'node' },

  // ---- 需要真实 Electron 窗口 ----
  { id: 'test:gui', title: 'GUI 冒烟（DOM / API 注入 / safeStorage）', group: 'gui' },
  { id: 'test:gui-layout', title: '布局持久化 GUI', group: 'gui' },
  { id: 'test:gui-hidden', title: '后台 GUI 模式', group: 'gui' },
  { id: 'test:gui-compare', title: '结构 / 数据比较面板 GUI（只生成 SQL）', group: 'gui' },
  { id: 'test:gui-flow', title: 'GUI 真实交互（全流程）', group: 'gui' },
  { id: 'test:gui-remote-connection', title: '远程连接表单与生命周期 GUI（模拟 HTTP）', group: 'gui' },
  { id: 'test:gui-features', title: '新功能 GUI（搜索/排序/统计/增删行）', group: 'gui' },
  { id: 'test:gui-round3', title: '第三轮 GUI（多标签/DDL/编辑连接）', group: 'gui' },
  { id: 'test:gui-sql', title: 'SQL 编辑器 GUI', group: 'gui' },
  { id: 'test:gui-explain', title: 'SQLite 执行计划 GUI 与断线恢复', group: 'gui' },
  { id: 'test:gui-ssl-form', title: 'SSL 表单 GUI', group: 'gui' },
  { id: 'test:gui-ssh-form', title: 'SSH 表单 GUI', group: 'gui' },
  { id: 'test:gui-sql-library', title: 'SQL 历史与收藏 GUI', group: 'gui' },
  { id: 'test:gui-tab-context', title: '多标签上下文 GUI（导出/筛选跟随）', group: 'gui' },
  { id: 'test:gui-export-integrity', title: '导出完整性 GUI（截断拒绝导出）', group: 'gui' },
  { id: 'test:gui-export-wizard', title: '导出向导 GUI（真实落盘与来源规则）', group: 'gui' },
  { id: 'test:gui-import', title: 'CSV 导入向导 GUI（真实入库与失败回滚）', group: 'gui' },
  { id: 'test:gui-er-relations', title: 'ER 图真实外键关系 GUI', group: 'gui' },
  { id: 'test:gui-er-selection-export', title: 'ER 图选择、布局隔离与 SVG 导出 GUI', group: 'gui' },
  { id: 'test:gui-transaction-lifecycle', title: '事务生命周期 GUI（离开保护/提交/回滚）', group: 'gui' },
  { id: 'test:gui-mutation-transaction', title: '增删改的事务归属 GUI（跨标签同步）', group: 'gui' },
  { id: 'test:gui-grid-lifecycle', title: '网格真实查询、分页与销毁竞争', group: 'gui' },

  { id: 'test:gui-app-close-guard', title: '真实窗口关闭、退出与崩溃保护', group: 'gui' },
  { id: 'test:gui-connection-guard', title: '连接断开、删除和更新的事务保护', group: 'gui' },
  { id: 'test:gui-sql-transaction', title: 'SQL 工作台写操作与连接事务联动 GUI', group: 'gui' },
  { id: 'test:gui-sql-workbench-results', title: '工作台结果形态卡片 (Affected / DDL) GUI', group: 'gui' },
  { id: 'test:gui-sql-script-execution', title: '多语句脚本顺序执行与错误中断 GUI', group: 'gui' },
  { id: 'test:gui-sql-draft', title: 'SQL 编辑器按连接草稿恢复 GUI', group: 'gui' },
  { id: 'test:gui-sql-cancel', title: 'SQL 工作台参数面板与取消状态 GUI', group: 'gui' },

  // ---- 需要外部服务 ----
  {
    id: 'test:compare-cross-dialect',
    title: '比较的拒绝规则（跨方言 / 只浏览数据源）',
    group: 'external',
    env: ['DBSTUDIO_PG_URL']
  },
  {
    id: 'test:nosql-external',
    title: 'Redis / Kafka 真实服务器浏览（只读）',
    group: 'external',
    env: ['DBSTUDIO_REDIS_URL', 'DBSTUDIO_KAFKA_BROKERS']
  },
  {
    id: 'test:sql-params-postgres',
    title: 'PostgreSQL 参数绑定与执行身份取消',
    group: 'external',
    env: ['DBSTUDIO_PG_URL']
  },
  {
    id: 'test:gui-sql-cancel-postgres',
    title: 'PostgreSQL 工作台真实取消与连接切换 GUI（需要显示器）',
    group: 'external',
    env: ['DBSTUDIO_PG_URL']
  },
  {
    id: 'test:postgres',
    title: 'PostgreSQL 驱动 e2e',
    group: 'external',
    env: ['DBSTUDIO_PG_URL']
  },
  {
    id: 'test:mysql-contract',
    title: 'MySQL 驱动契约（真实 MySQL：查询/写入/比较/DDL/TLS）',
    group: 'external',
    env: ['MYSQL_HOST']
  },
  {
    id: 'test:postgresql-metadata',
    title: 'PostgreSQL 外键、索引、CHECK 与触发器读取',
    group: 'external',
    env: ['DBSTUDIO_PG_URL']
  },
  {
    id: 'test:cancel',
    title: '查询取消能力（PG 真取消 / SQLite 如实不支持）',
    group: 'external',
    env: ['DBSTUDIO_PG_URL']
  },
  {
    id: 'test:explain-postgres',
    title: 'PostgreSQL JSON 执行计划 RPC',
    group: 'external',
    env: ['DBSTUDIO_PG_URL']
  },
  {
    id: 'test:gui-explain-postgres',
    title: 'PostgreSQL 执行计划 GUI 与断线恢复（需要显示器）',
    group: 'external',
    env: ['DBSTUDIO_PG_URL']
  },
  {
    id: 'test:postgres-ssl',
    title: 'PostgreSQL SSL/TLS 语义',
    group: 'external',
    env: ['DBSTUDIO_PG_SSL_URL', 'DBSTUDIO_PG_PLAIN_URL']
  },
  {
    id: 'test:ssh-tunnel',
    title: 'SSH 隧道（真实 sshd + PG）',
    group: 'external',
    env: ['DBSTUDIO_PG_URL']
  }
]

/**
 * 列出某个分组的步骤 id。
 *
 * @param {'node'|'gui'|'external'} group
 * @returns {string[]}
 */
export function stepIds(group) {
  return STEPS.filter((step) => step.group === group).map((step) => step.id)
}

/**
 * 检查某步的必需环境变量是否齐备。
 *
 * @param {Step} step
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function checkEnv(step, env) {
  const missing = (step.env ?? []).filter((name) => !env[name])
  return { ok: missing.length === 0, missing }
}

/**
 * 发布门禁：tag 与声明版本必须一致。
 *
 * ===== 为什么需要 =====
 *
 * 早先发布流程是「推 tag v0.4.0 → 打包 → 上传」，而 `package.json` 里的
 * `version` 是**另一个人手工维护**的。两边漂移时，产物的真实版本与 tag 不符，
 * 而且**没有任何报错**——用户拿到的是「v0.4.0」的 tag，装的却是别的东西。
 *
 * 版本号只有一个真相来源：`package.json`。tag 只是它的镜像，
 * 所以这里断言两者必须相等。
 *
 * @param {string} tag 形如 `v0.4.0` 或 `0.4.0`
 * @param {string} version `package.json` 的 version
 */
export function checkVersionMatch(tag, version) {
  const normalized = tag.startsWith('v') ? tag.slice(1) : tag
  return { ok: normalized === version, tag: normalized, version }
}

