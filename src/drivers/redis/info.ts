/**
 * Redis 方言元数据（纯数据，主进程可安全 import）。
 */
import type { DialectInfo } from '../../core/driver'
import { NO_SQL_SCRIPT_RULES } from '../nosql-base'

export const REDIS_DIALECT_ID = 'redis'

export const REDIS_INFO: DialectInfo = {
  id: REDIS_DIALECT_ID,
  name: 'Redis（只浏览）',
  fields: [
    { key: 'host', label: '主机', kind: 'text', required: true, placeholder: '127.0.0.1', default: '127.0.0.1' },
    { key: 'port', label: '端口', kind: 'number', required: true, placeholder: '6379', default: 6379 },
    { key: 'user', label: '用户名（ACL，可空）', kind: 'text', required: false, placeholder: 'default' },
    { key: 'password', label: '密码', kind: 'password', secretKey: 'dbPassword', required: false, placeholder: '（可为空）' },
    {
      key: 'tls',
      label: 'TLS',
      kind: 'select',
      required: false,
      default: 'off',
      choices: [
        { value: 'off', label: '不使用 TLS' },
        { value: 'on', label: '使用 TLS（校验证书）' }
      ]
    },
    { key: 'keyPattern', label: '键过滤（SCAN MATCH）', kind: 'text', required: false, placeholder: '*', default: '*' }
  ],
  // 只浏览方言从不拼 SQL，这里的 quoting 只是满足 DialectInfo 的形状。
  // 但**取值不能随便填**：渲染进程的 pickQuotingRules 要求所有方言的引号规则
  // 完全一致，否则整个应用都拿不到引号规则（实测会导致表格排序被禁用）。
  // 因此这里与 SQL 方言保持一致。
  quoting: { open: '"', close: '"', escape: 'double' },
  scriptRules: NO_SQL_SCRIPT_RULES
}
