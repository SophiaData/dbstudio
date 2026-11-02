/**
 * MySQL / MariaDB 方言的展示信息：新建连接表单、SQL 引号规则等。
 * 单独成文件，避免 adapter ↔ index 的循环导入（与其它方言同因）。
 */

import type { DialectInfo } from '../../core/driver'
import { MYSQL_DIALECT_ID, MYSQL_SCRIPT_RULES } from './dialect'

export const MYSQL_INFO: DialectInfo = {
  id: MYSQL_DIALECT_ID,
  name: 'MySQL / MariaDB',
  fields: [
    { key: 'host', label: '主机', kind: 'text', required: true, placeholder: '127.0.0.1', default: '127.0.0.1' },
    { key: 'port', label: '端口', kind: 'number', required: true, placeholder: '3306', default: 3306 },
    { key: 'database', label: '数据库', kind: 'text', required: true, placeholder: 'testdb' },
    { key: 'user', label: '用户名', kind: 'text', required: true, placeholder: 'root', default: 'root' },
    {
      key: 'password',
      label: '密码',
      kind: 'password',
      secretKey: 'dbPassword',
      required: false,
      placeholder: '（可为空）'
    }
  ],
  /** 与 dialect.ts 的 quoteIdentifier 完全一致：反引号 + 内部翻倍。 */
  quoting: { open: '`', close: '`', escape: 'double' },
  scriptRules: MYSQL_SCRIPT_RULES
}
