import { describe, expect, test } from 'vitest'

import {
  ER_LAYOUT_MAX_COORDINATE,
  ER_LAYOUT_STORAGE_PREFIX,
  buildErLayoutKey,
  loadErLayout,
  normalizeErLayoutSchemas,
  parseErLayout,
  sanitizeErLayout,
  saveErLayout,
  serializeErLayout
} from './er-layout'
import type { ErLayoutStorage } from './er-layout'

function memoryStorage(initial: Record<string, string> = {}): ErLayoutStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    }
  }
}

describe('schema 集合规范化', () => {
  test('去重后按码位排序，null 固定在最前', () => {
    expect(normalizeErLayoutSchemas(['public', 'audit', 'public'])).toEqual(['audit', 'public'])
    expect(normalizeErLayoutSchemas(['public', null, 'audit'])).toEqual([null, 'audit', 'public'])
  })

  // key 只能由集合决定；用 localeCompare 会让同一份数据在不同机器上排出不同顺序。
  test('与元素出现顺序无关，两次不同顺序得到同一结果', () => {
    expect(normalizeErLayoutSchemas(['b', 'a'])).toEqual(normalizeErLayoutSchemas(['a', 'b']))
  })

  test('非字符串元素被丢弃，空输入得到空数组', () => {
    expect(normalizeErLayoutSchemas([1, {}, true] as never)).toEqual([])
    expect(normalizeErLayoutSchemas(null)).toEqual([])
    expect(normalizeErLayoutSchemas(undefined)).toEqual([])
    expect(normalizeErLayoutSchemas([])).toEqual([])
  })
})

describe('布局 key 构造', () => {
  test('前缀与版本固定，改它会让旧布局静默读不到', () => {
    expect(ER_LAYOUT_STORAGE_PREFIX).toBe('dbstudio.er-layout.v1')
    expect(buildErLayoutKey('c1', [])).toBe(`${ER_LAYOUT_STORAGE_PREFIX}.c1.empty`)
  })

  test('同一连接下不同 schema 集合得到不同 key', () => {
    expect(buildErLayoutKey('c1', ['public'])).not.toBe(buildErLayoutKey('c1', ['audit']))
    expect(buildErLayoutKey('c1', [])).not.toBe(buildErLayoutKey('c1', ['public']))
  })

  test('schema 顺序与重复不影响 key', () => {
    expect(buildErLayoutKey('c1', ['b', 'a', 'b'])).toBe(buildErLayoutKey('c1', ['a', 'b']))
  })

  // 连接 id 真实形态是 `connection:<uuid>`，含分隔符；若不编码，
  // 「连接 A + schema B」与「连接 A.B + 空 schema」会撞成同一个 key。
  test('连接 id 里的 `.` 与 `:` 会被编码，不与 schema 分隔符歧义', () => {
    const a = buildErLayoutKey('conn', ['a.b'])
    const b = buildErLayoutKey('conn.a', ['b'])
    expect(a).not.toBe(b)
    expect(buildErLayoutKey('connection:abc', [])).toContain('connection%003Aabc')
  })

  // PG 里 "null" 是合法 schema 名，不能与「没有 schema」撞 key。
  test('字符串 schema "null" 与真正的 null 得到不同 key', () => {
    expect(buildErLayoutKey('c1', ['null'])).not.toBe(buildErLayoutKey('c1', [null]))
  })

  test('非字符串连接 id 按字符串处理而不是抛错', () => {
    expect(buildErLayoutKey(42 as never, [])).toBe(`${ER_LAYOUT_STORAGE_PREFIX}.42.empty`)
  })
})

describe('布局 JSON 解析', () => {
  // 布局是锦上添花的偏好；为它让整张 ER 图打不开不可接受。
  test('坏 JSON 与非字符串输入一律得到空布局，不抛错', () => {
    expect(parseErLayout('{')).toEqual({})
    expect(parseErLayout('not json')).toEqual({})
    expect(parseErLayout('')).toEqual({})
    expect(parseErLayout('   ')).toEqual({})
    expect(parseErLayout(null)).toEqual({})
    expect(parseErLayout(undefined)).toEqual({})
    expect(parseErLayout(42 as never)).toEqual({})
  })

  test('合法 JSON 保留坐标', () => {
    expect(parseErLayout('{"n1":{"x":1,"y":2}}')).toEqual({ n1: { x: 1, y: 2 } })
  })

  test('顶层是数组或标量时得到空布局', () => {
    expect(parseErLayout('[1,2]')).toEqual({})
    expect(parseErLayout('"str"')).toEqual({})
    expect(parseErLayout('null')).toEqual({})
  })
})

describe('布局清洗', () => {
  test('丢弃非法项但保留其余项', () => {
    const cleaned = sanitizeErLayout({
      keep: { x: 1, y: 2 },
      negative: { x: -1, y: 2 },
      notFinite: { x: Number.POSITIVE_INFINITY, y: 1 },
      nan: { x: Number.NaN, y: 1 },
      stringCoords: { x: '1', y: '2' },
      missingY: { x: 1 },
      notObject: 5,
      tooBig: { x: ER_LAYOUT_MAX_COORDINATE + 1, y: 1 }
    })
    expect(cleaned).toEqual({ keep: { x: 1, y: 2 } })
  })

  test('坐标上限被强制，防止 SVG 尺寸被撑到天文数字', () => {
    expect(sanitizeErLayout({ n: { x: ER_LAYOUT_MAX_COORDINATE, y: ER_LAYOUT_MAX_COORDINATE } })).toEqual({
      n: { x: ER_LAYOUT_MAX_COORDINATE, y: ER_LAYOUT_MAX_COORDINATE }
    })
    expect(sanitizeErLayout({ n: { x: ER_LAYOUT_MAX_COORDINATE + 1, y: 0 } })).toEqual({})
  })

  test('只保留 x 与 y，多余键被丢掉', () => {
    expect(sanitizeErLayout({ n: { x: 1, y: 2, color: 'red', url: 'http://x' } })).toEqual({ n: { x: 1, y: 2 } })
  })

  test('给出已知节点集合时丢弃未知节点', () => {
    const stored = { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } }
    expect(sanitizeErLayout(stored, ['a'])).toEqual({ a: { x: 1, y: 1 } })
    expect(sanitizeErLayout(stored, [])).toEqual({})
  })

  test('空字符串节点 id 被丢弃', () => {
    expect(sanitizeErLayout({ '': { x: 1, y: 1 } })).toEqual({})
  })

  // 赋值写法会触发 Object.prototype 的 setter，把布局变成原型污染载体。
  test('__proto__ 键不污染 Object.prototype', () => {
    const cleaned = sanitizeErLayout({ __proto__: { x: 1, y: 1 } } as never)
    expect(({} as Record<string, unknown>)['x']).toBeUndefined()
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype)
  })

  test('顶层不是普通对象时得到空布局', () => {
    expect(sanitizeErLayout([] as never)).toEqual({})
    expect(sanitizeErLayout(null)).toEqual({})
    expect(sanitizeErLayout('x' as never)).toEqual({})
    expect(sanitizeErLayout(3 as never)).toEqual({})
  })

  // Map 满足 typeof object 且不是数组；若不排除会被 Object.entries 读成空对象，
  // 表现为「拖了半天位置全丢且不报错」。
  test('Map 不会被误判成普通对象而静默清空', () => {
    const map = new Map([['n1', { x: 1, y: 2 }]])
    expect(sanitizeErLayout(map as never)).toEqual({})
    expect(serializeErLayout(map)).toBe('{"n1":{"x":1,"y":2}}')
  })

  test('不修改入参，返回新对象', () => {
    const input = { n: { x: 1, y: 2 } }
    const cleaned = sanitizeErLayout(input)
    expect(cleaned).not.toBe(input)
    expect(cleaned['n']).not.toBe(input.n)
  })
})

describe('布局序列化', () => {
  test('坐标取整，节点 id 排序，同样内容永远得到同样字符串', () => {
    const a = serializeErLayout({ b: { x: 1.6, y: 2.4 }, a: { x: 3, y: 4 } })
    expect(a).toBe('{"a":{"x":3,"y":4},"b":{"x":2,"y":2}}')
    expect(serializeErLayout({ a: { x: 3, y: 4 }, b: { x: 1.6, y: 2.4 } })).toBe(a)
  })

  test('非法项在序列化时同样被丢弃', () => {
    expect(serializeErLayout({ ok: { x: 1, y: 1 }, bad: { x: -1, y: 0 } })).toBe('{"ok":{"x":1,"y":1}}')
  })

  test('空布局序列化成空对象字符串', () => {
    expect(serializeErLayout({})).toBe('{}')
  })

  test('序列化结果可被 parseErLayout 还原', () => {
    const positions = { n1: { x: 10, y: 20 } }
    expect(parseErLayout(serializeErLayout(positions))).toEqual(positions)
  })
})

describe('布局存取', () => {
  test('存取往返一致', () => {
    const storage = memoryStorage()
    expect(saveErLayout(storage, 'k', { n1: { x: 5, y: 6 } })).toBe(true)
    expect(loadErLayout(storage, 'k')).toEqual({ n1: { x: 5, y: 6 } })
  })

  test('读取时按当前节点集合再清洗一次', () => {
    const storage = memoryStorage({ k: '{"gone":{"x":1,"y":1},"here":{"x":2,"y":2}}' })
    expect(loadErLayout(storage, 'k', ['here'])).toEqual({ here: { x: 2, y: 2 } })
  })

  // 隐私模式下访问 localStorage 会直接抛；布局偏好不该让功能崩掉。
  test('存储抛错时读返回空布局、写返回 false，都不向上抛', () => {
    const throwing: ErLayoutStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      }
    }
    expect(loadErLayout(throwing, 'k')).toEqual({})
    expect(saveErLayout(throwing, 'k', { n: { x: 1, y: 1 } })).toBe(false)
  })

  test('缺失的 key 读成空布局', () => {
    expect(loadErLayout(memoryStorage(), 'absent')).toEqual({})
  })
})
