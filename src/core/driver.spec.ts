import { describe, expect, test } from 'vitest'

import {
  DRIVER_API_VERSION,
  HANDSHAKE_PROTOCOL_VERSION,
  HandshakeValidationError,
  isEmptySecret,
  isHandshakeValidationError,
  isRpcResponse,
  mergeSecrets,
  normalizeSecret,
  quoteIdentifierWith,
  validateHandshake
} from './driver'

describe('机密值规范化', () => {
  test('未提供时得到空对象', () => {
    expect(normalizeSecret(undefined)).toEqual({})
  })

  test('裸字符串当作数据库口令', () => {
    expect(normalizeSecret('pw')).toEqual({ dbPassword: 'pw' })
    expect(normalizeSecret('')).toEqual({})
  })

  // 只收集白名单键，多余字段不能顺带流进机密结构。
  test('对象只保留白名单键，且丢弃空串与非字符串', () => {
    expect(normalizeSecret({ dbPassword: 'a', sshPassword: 'b' })).toEqual({ dbPassword: 'a', sshPassword: 'b' })
    expect(normalizeSecret({ dbPassword: '' })).toEqual({})
    expect(normalizeSecret({ dbPassword: 123 as never })).toEqual({})
    expect(normalizeSecret({ unknownKey: 'x' } as never)).toEqual({})
  })
})

describe('机密判空', () => {
  test('没有任何键才算空', () => {
    expect(isEmptySecret({})).toBe(true)
    expect(isEmptySecret({ dbPassword: 'x' })).toBe(false)
    // 判空只看键是否存在，不看值；规范化阶段已把空串过滤掉，正常流程不会走到这里。
    expect(isEmptySecret({ dbPassword: '' })).toBe(false)
  })
})

describe('机密合并', () => {
  // 编辑连接只改 SSH 口令时，数据库口令必须原样保留；否则用户改一个字段就丢另一类凭据。
  test('未提及的键保持不变', () => {
    const merged = mergeSecrets({ dbPassword: 'db', sshPassword: 'ssh' }, { sshPassword: 'new' })
    expect(merged).toEqual({ dbPassword: 'db', sshPassword: 'new' })
  })

  test('显式空串表示删除该键', () => {
    const merged = mergeSecrets({ dbPassword: 'db', sshPassword: 'ssh' }, { sshPassword: '' })
    expect(merged).toEqual({ dbPassword: 'db' })
  })

  test('patch 为 undefined 时结果等于保留 base', () => {
    expect(mergeSecrets({ dbPassword: 'db' }, undefined)).toEqual({ dbPassword: 'db' })
    expect(mergeSecrets({}, undefined)).toEqual({})
  })

  test('字符串 patch 只覆盖数据库口令，不动其它键', () => {
    expect(mergeSecrets({ dbPassword: 'old', sshPassword: 'ssh' }, 'new')).toEqual({
      dbPassword: 'new',
      sshPassword: 'ssh'
    })
    // 空串字符串 patch 不删除任何键，避免「留空即清空」的意外。
    expect(mergeSecrets({ dbPassword: 'old' }, '')).toEqual({ dbPassword: 'old' })
  })

  test('base 里的空串不会被带进结果', () => {
    expect(mergeSecrets({ dbPassword: '' }, undefined)).toEqual({})
  })
})

describe('标识符引用', () => {
  test('双写模式把内部闭引号重复一次', () => {
    const rules = { open: '"', close: '"', escape: 'double' } as const
    expect(quoteIdentifierWith('a"b', rules)).toBe('"a""b"')
    expect(quoteIdentifierWith('plain', rules)).toBe('"plain"')
  })

  test('反斜杠模式先转义反斜杠再转义引号', () => {
    const rules = { open: '`', close: '`', escape: 'backslash' } as const
    expect(quoteIdentifierWith('a`b', rules)).toBe('`a\\`b`')
    // 顺序很关键：若先转义引号再加反斜杠，会让反斜杠把转义自身加倍出错。
    expect(quoteIdentifierWith('a\\b', rules)).toBe('`a\\\\b`')
  })

  // MySQL 用反引号作开闭引号，标识符里出现反斜杠时必须双写，否则会被当成转义起始。
  test('含反斜杠的标识符在反斜杠模式下被正确保护', () => {
    const rules = { open: '`', close: '`', escape: 'backslash' } as const
    const quoted = quoteIdentifierWith('a\\`b', rules)
    expect(quoted.startsWith('`')).toBe(true)
    expect(quoted.endsWith('`')).toBe(true)
    expect(quoted).toBe('`a\\\\\\`b`')
  })
})

describe('握手校验', () => {
  test('拒绝非对象帧并抛出专用错误类型', () => {
    for (const frame of [null, undefined, 42, 'x', []]) {
      expect(() => validateHandshake(frame), String(frame)).toThrow(HandshakeValidationError)
    }
  })

  test('拒绝缺少版本字段的帧', () => {
    expect(() => validateHandshake({})).toThrow(HandshakeValidationError)
    expect(() => validateHandshake({ protocolVersion: 'x' })).toThrow(HandshakeValidationError)
  })

  test('错误可被类型判定函数识别', () => {
    const error = new HandshakeValidationError('malformed_handshake', 'x')
    expect(isHandshakeValidationError(error)).toBe(true)
    expect(isHandshakeValidationError(new Error('x'))).toBe(false)
    expect(isHandshakeValidationError('x')).toBe(false)
  })
})

describe('RPC 响应判定', () => {
  test('非对象一律不是响应', () => {
    for (const frame of [null, undefined, 1, 'x', true]) expect(isRpcResponse(frame)).toBe(false)
  })

  test('空对象不是响应', () => {
    expect(isRpcResponse({})).toBe(false)
  })
})

describe('版本常量', () => {
  // 这些常量跨进程/跨 SDK 比对，被改动会静默拒绝所有旧驱动。
  test('保持声明的协议版本', () => {
    expect(HANDSHAKE_PROTOCOL_VERSION).toBe(1)
    expect(DRIVER_API_VERSION).toBe(1)
  })
})
