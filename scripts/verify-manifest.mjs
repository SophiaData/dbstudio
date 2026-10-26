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
  { id: 'build', title: '构建宿主 + main/preload/renderer', group: 'node' },
  { id: 'fixture', title: '生成测试夹具', group: 'node' },

  // ---- 纯 Node e2e ----
  { id: 'test', title: '元数据 / 连接 e2e', group: 'node' },
  { id: 'test:resultset', title: '结果集 e2e（查询/分页/游标）', group: 'node' },
  { id: 'test:edit', title: '在线编辑与事务 e2e', group: 'node' },
  { id: 'test:persist', title: '持久化与凭据 e2e', group: 'node' },
  { id: 'test:mutations', title: '增删改与完整取值 e2e', group: 'node' },
  { id: 'test:ddl', title: 'DDL 与编辑连接 e2e', group: 'node' },
  { id: 'test:connection-lifecycle', title: '连接故障恢复与并发建连', group: 'node' },
  { id: 'test:driver-host-stress', title: '驱动宿主连续启动与退出压力', group: 'node' },
  { id: 'test:sql-script-parser', title: '方言级 SQL 脚本切分与源码位置', group: 'node' },
  { id: 'test:postgres-edits', title: 'PostgreSQL 编辑列名与组合主键契约', group: 'node' },
  { id: 'test:sql-library', title: 'SQL 历史与收藏存储', group: 'node' },
  { id: 'test:statement-execution', title: '语句执行契约与三态结果 e2e', group: 'node' },
  { id: 'test:explain', title: 'SQLite 执行计划 RPC 与错误恢复', group: 'node' },
  { id: 'test:verify-manifest', title: '验证清单自身的一致性', group: 'node' },
  { id: 'test:verify-runner', title: '验证 CLI 参数与真实子进程执行', group: 'node' },
  { id: 'test:cancel-sqlite', title: 'SQLite 取消能力声明与行为', group: 'node' },
  { id: 'test:sql-parameters-parser', title: 'SQL 参数扫描边界与值校验', group: 'node' },
  { id: 'test:sql-params', title: '参数化 SQL 与绑定安全 e2e', group: 'node' },
  { id: 'test:release-gate', title: '发布门禁与 draft 附件校验', group: 'node' },
  { id: 'test:packaged-smoke', title: '打包冒烟脚本的离线回归', group: 'node' },
  // 注意：这条跑在 Electron 里，但用 ELECTRON_RUN_AS_NODE 起进程，
 // **不创建窗口**，所以不需要显示器——归在 node 组。
  { id: 'test:electron', title: 'Electron 内置 Node 运行时验收', group: 'node' },
  { id: 'build:sdk', title: '构建 SDK 发布产物', group: 'node' },
  { id: 'test:sdk', title: 'SDK e2e（从 dist 产物导入）', group: 'node' },
  { id: 'test:sdk-package', title: 'SDK 包外安装与使用', group: 'node' },

  // ---- 需要真实 Electron 窗口 ----
  { id: 'test:gui', title: 'GUI 冒烟（DOM / API 注入 / safeStorage）', group: 'gui' },
  { id: 'test:gui-layout', title: '布局持久化 GUI', group: 'gui' },
  { id: 'test:gui-hidden', title: '后台 GUI 模式', group: 'gui' },
  { id: 'test:gui-flow', title: 'GUI 真实交互（全流程）', group: 'gui' },
  { id: 'test:gui-features', title: '新功能 GUI（搜索/排序/统计/增删行）', group: 'gui' },
  { id: 'test:gui-round3', title: '第三轮 GUI（多标签/DDL/编辑连接）', group: 'gui' },
  { id: 'test:gui-sql', title: 'SQL 编辑器 GUI', group: 'gui' },
  { id: 'test:gui-explain', title: 'SQLite 执行计划 GUI 与断线恢复', group: 'gui' },
  { id: 'test:gui-ssl-form', title: 'SSL 表单 GUI', group: 'gui' },
  { id: 'test:gui-ssh-form', title: 'SSH 表单 GUI', group: 'gui' },
  { id: 'test:gui-sql-library', title: 'SQL 历史与收藏 GUI', group: 'gui' },
  { id: 'test:gui-tab-context', title: '多标签上下文 GUI（导出/筛选跟随）', group: 'gui' },
  { id: 'test:gui-export-integrity', title: '导出完整性 GUI（截断拒绝导出）', group: 'gui' },
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


