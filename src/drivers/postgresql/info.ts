/**
 * PostgreSQL 方言的展示信息：UI 的「新建连接」下拉框与动态表单用它。
 *
 * 与 SQLite 的 `info.ts` 同一职责（见那边文件头：单独一个叶子文件是为了
 * 打断 `index → adapter → index` 的循环导入）。
 *
 * ⚠️ 本文件只允许 import 纯数据（`DialectInfo` 类型 + 方言 id 常量），
 * **绝不能** import `adapter.ts` 或 `pg`——否则主进程 `dialect-metadata.ts`
 * 会顺着这里把整个 PG 实现（以及 `pg` 包）打进主进程 bundle，
 * 进程隔离当场失效（`dialect-metadata.ts` 文件头有实测证据）。
 */

import type { DialectInfo } from '../../core/driver'
import { POSTGRESQL_DIALECT_ID } from './dialect'

export const POSTGRESQL_INFO: DialectInfo = {
  id: POSTGRESQL_DIALECT_ID,
  name: 'PostgreSQL',
  /**
   * PG 是**服务端**数据库，连接需要网络地址与身份认证，与 SQLite 的"一个文件"完全不同。
   *
   * 字段设计取舍：
   *   - `host` / `port` / `database` / `user` 是必需的五元组（port 给默认 5432）。
   *   - `password` 标记为 `password` 类型 —— 但注意：**它不会被写进 `ConnectionConfig.options`**，
   *     密码走独立的 secret 通道（见 `core/driver.ts` 的 `SecretValue` 注释）。
   *     这里声明它只是为了让 UI 知道"这个方言需要密码框"。
   *   - 不提供 SSL 开关：本阶段用 `pg` 默认（不强制 SSL），SSL 属于后续阶段。
   */
  fields: [
    { key: 'host', label: '主机', kind: 'text', required: true, placeholder: '127.0.0.1', default: '127.0.0.1' },
    { key: 'port', label: '端口', kind: 'number', required: true, placeholder: '5432', default: 5432 },
    { key: 'database', label: '数据库', kind: 'text', required: true, placeholder: 'postgres' },
    { key: 'user', label: '用户名', kind: 'text', required: true, placeholder: 'postgres' },
    { key: 'password', label: '密码', kind: 'password', required: false, placeholder: '（可为空）' }
  ],
  /**
   * 引号规则，供主进程/UI 拼 SQL 时使用。
   *
   * 必须与 `dialect.ts` 的 `quoteIdentifier` **完全一致**（双引号 + 内部引号翻倍）。
   * 两处不一致会产生最难查的偏差：主进程拼的 SQL 与驱动拼的不是同一种写法，
   * 普通表名上看不出问题，一到含引号的标识符就炸，而且只在一侧炸。
   * （SQLite 与 PG 都是 `double`，但仍是各自的声明式描述，不是共享常量。）
   */
  quoting: { open: '"', close: '"', escape: 'double' }
}
