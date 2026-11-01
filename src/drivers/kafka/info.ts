/**
 * Kafka 方言元数据（纯数据，主进程可安全 import）。
 */
import type { DialectInfo } from '../../core/driver'
import { NO_SQL_SCRIPT_RULES } from '../nosql-base'

export const KAFKA_DIALECT_ID = 'kafka'

export const KAFKA_INFO: DialectInfo = {
  id: KAFKA_DIALECT_ID,
  name: 'Kafka（只浏览）',
  fields: [
    {
      key: 'brokers',
      label: 'Broker 列表',
      kind: 'text',
      required: true,
      placeholder: '127.0.0.1:9092,host2:9092',
      default: '127.0.0.1:9092'
    },
    { key: 'clientId', label: 'Client ID', kind: 'text', required: false, placeholder: 'dbstudio', default: 'dbstudio' },
    {
      key: 'ssl',
      label: 'TLS',
      kind: 'select',
      required: false,
      default: 'off',
      choices: [
        { value: 'off', label: '不使用 TLS' },
        { value: 'on', label: '使用 TLS（校验证书）' }
      ]
    },
    {
      key: 'saslMechanism',
      label: 'SASL 机制',
      kind: 'select',
      required: false,
      default: 'none',
      choices: [
        { value: 'none', label: '不认证' },
        { value: 'plain', label: 'PLAIN' },
        { value: 'scram-sha-256', label: 'SCRAM-SHA-256' },
        { value: 'scram-sha-512', label: 'SCRAM-SHA-512' }
      ]
    },
    { key: 'user', label: 'SASL 用户名', kind: 'text', required: false },
    { key: 'password', label: 'SASL 密码', kind: 'password', secretKey: 'dbPassword', required: false }
  ],
  // 只浏览方言从不拼 SQL，这里的 quoting 只是满足 DialectInfo 的形状。
  // 但**取值不能随便填**：渲染进程的 pickQuotingRules 要求所有方言的引号规则
  // 完全一致，否则整个应用都拿不到引号规则（实测会导致表格排序被禁用）。
  // 因此这里与 SQL 方言保持一致。
  quoting: { open: '"', close: '"', escape: 'double' },
  scriptRules: NO_SQL_SCRIPT_RULES
}
