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
   *   - `host` / `port` / `database` / `user` 是必需的四元组（port 给默认 5432）。
   *   - `password` 标记为 `password` 类型 —— 但注意：**它不会被写进 `ConnectionConfig.options`**，
   *     密码走独立的 secret 通道（见 `core/driver.ts` 的 `SecretValue` 注释）。
   *     这里声明它只是为了让 UI 知道"这个方言需要密码框"。
   *
   * ===== SSL 三个字段的来历与语义（重要，别简化） =====
   *
   * 云数据库（Supabase / Neon / RDS / 云厂商托管 PG）几乎都**强制 SSL**，
   * 没有这几个字段就一个都连不上。所以它们不是"锦上添花"。
   *
   * `sslmode` 的取值直接沿用 libpq 的名字（`disable` / `allow` / `prefer` /
   * `require` / `verify-ca` / `verify-full`）——用户从 psql、DBeaver 带过来的认知
   * 在这里是**可迁移**的，不需要学一套新词。
   *
   * 但必须知道一个**与 libpq 不同的地方**（实测得出，见 adapter.ts 的 ssl.ts 注释）：
   * `pg` 这个 Node 驱动**没有** `prefer` 的优雅降级能力，而且它的 `ssl: true`
   * **会校验证书**（libpq 的 `require` 不校验）。所以取值到 `pg` 的映射
   * 由我们这一层显式实现，而不是直接把字符串丢给 `pg`。
   *
   * 默认值取 `prefer`：对绝大多数库（本机/内网/云）都能连上，
   * 且与 psql 不带参数时的默认行为一致——用户不该因为升级了本客户端就连不上库。
   */
  fields: [
    { key: 'host', label: '主机', kind: 'text', required: true, placeholder: '127.0.0.1', default: '127.0.0.1' },
    { key: 'port', label: '端口', kind: 'number', required: true, placeholder: '5432', default: 5432 },
    { key: 'database', label: '数据库', kind: 'text', required: true, placeholder: 'postgres' },
    { key: 'user', label: '用户名', kind: 'text', required: true, placeholder: 'postgres' },
    { key: 'password', label: '密码', kind: 'password', required: false, placeholder: '（可为空）' },
    {
      key: 'sslmode',
      label: 'SSL 模式',
      kind: 'select',
      required: false,
      default: 'prefer',
      choices: [
        { value: 'disable', label: 'disable — 不使用 SSL' },
        { value: 'allow', label: 'allow — 优先明文，服务端要求时才用 SSL' },
        { value: 'prefer', label: 'prefer — 优先 SSL，服务端不支持则回退明文（默认）' },
        { value: 'require', label: 'require — 必须 SSL，但不校验证书' },
        { value: 'verify-ca', label: 'verify-ca — 必须 SSL，且证书须由指定 CA 签发' },
        { value: 'verify-full', label: 'verify-full — 必须 SSL，且校验 CA 与主机名' }
      ]
    },
    {
      /**
       * CA 证书路径。只在 `verify-ca` / `verify-full` 下被读取。
       *
       * 为什么是路径而不是把证书内容粘进来：证书是多行 PEM（几 KB），
       * 粘进表单既难维护也会进 `connections.json`；路径更符合"引用本机文件"的直觉。
       * 代价是配置文件**不可移植**（换台机器路径就失效）——这是有意的取舍，
       * 换机时用户需要重新选一次 CA，比默默用错的证书更安全。
       */
      key: 'sslrootcert',
      label: 'CA 证书路径',
      kind: 'file',
      required: false,
      placeholder: 'verify-ca / verify-full 时需要，如 /path/to/ca.pem'
    }
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
