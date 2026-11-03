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
    },

    // ---- TLS（可选）----
    //
    // 默认 disable：与添加这些字段之前的行为保持一致，不让升级后的老连接
    // 因为多了一个默认 SSL 而突然连不上。云数据库用户需要显式选择。
    {
      key: 'sslmode',
      label: 'SSL 模式',
      kind: 'select',
      required: false,
      default: 'disable',
      choices: [
        { value: 'disable', label: 'disable — 不使用 SSL（默认）' },
        { value: 'require', label: 'require — 必须 SSL，但不校验证书' },
        { value: 'verify-ca', label: 'verify-ca — 必须 SSL，且证书须由指定 CA 签发' },
        { value: 'verify-full', label: 'verify-full — 必须 SSL，且校验 CA 与主机名' }
      ]
    },
    {
      key: 'sslrootcert',
      label: 'CA 证书路径',
      kind: 'file',
      required: false,
      placeholder: 'verify-ca / verify-full 时需要，如 /path/to/ca.pem'
    },

    // ---- SSH 隧道（可选）----
    // 与 PostgreSQL 相同的字段与语义：sshHost 留空即不启用。
    {
      key: 'sshHost',
      label: 'SSH 主机（留空=不使用隧道）',
      kind: 'text',
      required: false,
      placeholder: '例如 jump.example.com'
    },
    { key: 'sshPort', label: 'SSH 端口', kind: 'number', required: false, default: 22 },
    { key: 'sshUser', label: 'SSH 用户名', kind: 'text', required: false, placeholder: '例如 deploy' },
    {
      key: 'sshPrivateKey',
      label: 'SSH 私钥路径（与口令二选一）',
      kind: 'file',
      required: false,
      placeholder: '例如 ~/.ssh/id_ed25519（需填绝对路径）'
    },
    {
      key: 'sshPassword',
      label: 'SSH 登录口令',
      kind: 'password',
      secretKey: 'sshPassword',
      required: false,
      placeholder: '使用私钥时可留空'
    },
    {
      key: 'sshPassphrase',
      label: 'SSH 私钥口令',
      kind: 'password',
      secretKey: 'sshPassphrase',
      required: false,
      placeholder: '私钥未加密时留空'
    },
    {
      key: 'sshHostKeySha256',
      label: 'SSH 主机密钥指纹',
      kind: 'text',
      required: false,
      placeholder: '首次连接后按错误提示填入 SHA256:...'
    },
    {
      key: 'sshTargetHost',
      label: '隧道目标主机（留空=数据库主机）',
      kind: 'text',
      required: false,
      placeholder: '例如 10.0.1.5'
    },
    {
      key: 'sshTargetPort',
      label: '隧道目标端口（留空=数据库端口）',
      kind: 'number',
      required: false,
      placeholder: '例如 3306'
    }
  ],
  /** 与 dialect.ts 的 quoteIdentifier 完全一致：反引号 + 内部翻倍。 */
  quoting: { open: '`', close: '`', escape: 'double' },
  scriptRules: MYSQL_SCRIPT_RULES
}
