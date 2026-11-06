import type { DialectField, SecretMap } from '../../../src/core/driver'

export interface CollectedConnectionFields {
  readonly options: Record<string, string | number | boolean>
  readonly secret: SecretMap
}

/**
 * 密码字段保留原始输入（包括首尾空格），只按“是否为空”决定是否更新。
 * 非密码字段仍按表单惯例 trim，未知 option 从现有连接配置原样继承。
 */
export function collectConnectionFields(input: {
  readonly fields: readonly DialectField[]
  readonly values: ReadonlyMap<string, string>
  readonly baseOptions: Readonly<Record<string, string | number | boolean>>
  readonly editing: boolean
}): CollectedConnectionFields {
  const options: Record<string, string | number | boolean> = { ...input.baseOptions }
  const secret: { dbPassword?: string; sshPassword?: string; sshPassphrase?: string } = {}
  for (const field of input.fields) {
    const value = input.values.get(field.key) ?? ''
    if (field.kind === 'password') {
      if (value !== '') secret[field.secretKey ?? 'dbPassword'] = value
      continue
    }
    const raw = value.trim()
    if (!raw && field.required) throw new Error(`请填写「${field.label}」`)
    if (!raw && field.kind === 'number') continue
    if (raw || input.editing) options[field.key] = field.kind === 'number' ? Number(raw) : raw
  }
  return { options, secret }
}
