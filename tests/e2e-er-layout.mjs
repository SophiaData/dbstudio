/**
 * ER 布局纯逻辑契约：不启动 Electron，不碰 DOM，只验证
 * 「布局 key 怎么拼」与「布局 JSON 怎么信」。
 *
 * ===== 这条测试防的是什么 =====
 *
 * 布局只有两个出口：写进 localStorage 的那份 JSON，和当作 key 的那串字符串。
 * 两处都可能出问题，而且症状都很隐蔽：
 *
 *   - **key 漏了 schema 集合** → 换一组 schema 打开 ER 图，
 *     上一张图的坐标残留下来，图挤成一团。用户会以为"布局功能有 bug"，
 *     而真实原因是"这份偏好根本不该被复用"。
 *   - **key 依赖点选顺序** → 同一批表换个顺序再打开，布局就丢了。
 *   - **解析时信了坏数据** → 存了 `NaN` / 负数 / 手改过的 JSON，
 *     SVG 的 width 变成天文数字，**整张图打不开**。
 *
 * 布局是"锦上添花"的偏好，为它让 ER 图打不开是不可接受的，
 * 所以这些边界必须在纯逻辑层被钉死。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dbstudio-er-layout-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir: work,
    target: 'node22',
    ssr: true,
    minify: false,
    lib: { entry: resolve(root, 'src/renderer/er-layout.ts'), formats: ['cjs'] },
    rollupOptions: { output: { entryFileNames: 'er-layout.cjs' } }
  }
})

const layout = await import(pathToFileURL(join(work, 'er-layout.cjs')).href)

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------------------ *
 * 1. schema 去重与排序：key 只能由"集合"决定
 * ------------------------------------------------------------------ */

const dupes = layout.normalizeErLayoutSchemas(['public', 'audit', 'public'])
check('重复 schema 被去重', dupes.length === 2, dupes)
check('schema 排序后顺序稳定', JSON.stringify(dupes) === JSON.stringify(['audit', 'public']), dupes)

const withNull = layout.normalizeErLayoutSchemas([null, 'public', null])
check(
  'null schema 与字符串 schema 同时存在时都被保留',
  withNull.length === 2 && withNull[0] === null && withNull[1] === 'public',
  withNull
)

check('空集合得到空数组', layout.normalizeErLayoutSchemas([]).length === 0)
check('undefined 集合不会抛错', layout.normalizeErLayoutSchemas(undefined).length === 0)

/* ------------------------------------------------------------------ *
 * 2. buildErLayoutKey：不同 schema 集合必须隔离
 * ------------------------------------------------------------------ */

const keyPublic = layout.buildErLayoutKey('connection:c1', ['public'])
const keyAudit = layout.buildErLayoutKey('connection:c1', ['audit'])
check('不同 schema 集合的布局 key 不同', keyPublic !== keyAudit, { keyPublic, keyAudit })

const keyMixed = layout.buildErLayoutKey('connection:c1', ['public', 'audit'])
check('多 schema 集合与单 schema 集合不同', keyMixed !== keyPublic && keyMixed !== keyAudit)

const keyEmpty = layout.buildErLayoutKey('connection:c1', [])
check('空 schema 集合与 public 集合不同', keyEmpty !== keyPublic)

const keyNoSchema = layout.buildErLayoutKey('connection:c1', [null])
check(
  '无 schema 方言（null）与有 schema 方言不同',
  keyNoSchema !== keyPublic && keyNoSchema !== keyEmpty,
  { keyNoSchema, keyPublic, keyEmpty }
)

/* ------------------------------------------------------------------ *
 * 3. buildErLayoutKey：去重、顺序无关
 * ------------------------------------------------------------------ */

const keyA = layout.buildErLayoutKey('connection:c1', ['public', 'audit'])
const keyB = layout.buildErLayoutKey('connection:c1', ['audit', 'public'])
check('schema 顺序不同但 key 相同', keyA === keyB, { keyA, keyB })

const keyDupes = layout.buildErLayoutKey('connection:c1', ['public', 'public', 'audit'])
check('重复 schema 不影响 key', keyDupes === keyA, { keyDupes, keyA })

const keyConn1 = layout.buildErLayoutKey('connection:c1', ['public'])
const keyConn2 = layout.buildErLayoutKey('connection:c2', ['public'])
check('不同连接的布局 key 不同', keyConn1 !== keyConn2)

/* ------------------------------------------------------------------ *
 * 4. buildErLayoutKey：null 与名为 "null" 的 schema 不撞车
 * ------------------------------------------------------------------ */

const keyNullSchema = layout.buildErLayoutKey('connection:c1', [null])
const keyStringNull = layout.buildErLayoutKey('connection:c1', ['null'])
check(
  '名为 "null" 的 schema 与 null（无 schema 概念）不撞成同一个 key',
  keyNullSchema !== keyStringNull,
  { keyNullSchema, keyStringNull }
)

/* ------------------------------------------------------------------ *
 * 5. buildErLayoutKey：分隔符不会造成歧义
 * ------------------------------------------------------------------ */

const keyTrickyA = layout.buildErLayoutKey('connection:c1', ['public'])
const keyTrickyB = layout.buildErLayoutKey('connection:c1.public', [])
check(
  '连接 id 含分隔符时不会与 schema 指纹混淆',
  keyTrickyA !== keyTrickyB,
  { keyTrickyA, keyTrickyB }
)

const keyDottedSchema = layout.buildErLayoutKey('connection:c1', ['a.b'])
const keySplitSchema = layout.buildErLayoutKey('connection:c1', ['a', 'b'])
check(
  'schema 名含 "." 时不会与两个 schema 混淆',
  keyDottedSchema !== keySplitSchema,
  { keyDottedSchema, keySplitSchema }
)

const keyUnicode = layout.buildErLayoutKey('connection:c1', ['公共'])
check(
  'schema 名含非 ASCII 字符时被百分号编码，不泄漏原始字符',
  keyUnicode.includes('s:%516C%5171') && !keyUnicode.includes('公'),
  keyUnicode
)

const keyPercent = layout.buildErLayoutKey('connection:c1', ['a%b'])
check(
  'schema 名含 "%" 时被转义，不会与编码本身混淆',
  keyPercent.includes('s:a%0025b'),
  keyPercent
)

check(
  'key 前缀与渲染层使用的一致',
  layout.buildErLayoutKey('c1', []).startsWith(layout.ER_LAYOUT_STORAGE_PREFIX + '.'),
  layout.ER_LAYOUT_STORAGE_PREFIX
)

/* ------------------------------------------------------------------ *
 * 6. parseErLayout：只接受 Record<nodeId, {x, y}>
 * ------------------------------------------------------------------ */

const parsed = layout.parseErLayout('{"n1":{"x":10,"y":20}}')
check('合法布局被解析出来', parsed.n1?.x === 10 && parsed.n1?.y === 20, parsed)
check('合法布局只保留 x 与 y', Object.keys(parsed.n1 ?? {}).length === 2, parsed.n1)

check('非法 JSON 字符串返回空布局', Object.keys(layout.parseErLayout('{oops')).length === 0)
check('null 返回空布局', Object.keys(layout.parseErLayout(null)).length === 0)
check('undefined 返回空布局', Object.keys(layout.parseErLayout(undefined)).length === 0)
check('空字符串返回空布局', Object.keys(layout.parseErLayout('')).length === 0)
check('数组顶层返回空布局', Object.keys(layout.parseErLayout('[{"x":1,"y":2}]')).length === 0)
check('数字顶层返回空布局', Object.keys(layout.parseErLayout('42')).length === 0)
check('字符串顶层返回空布局', Object.keys(layout.parseErLayout('"hello"')).length === 0)
check('null 顶层返回空布局', Object.keys(layout.parseErLayout('null')).length === 0)

/* ------------------------------------------------------------------ *
 * 7. 坐标过滤：非有限数、负数、类型错误
 * ------------------------------------------------------------------ */

const filtered = layout.parseErLayout(
  JSON.stringify({
    good: { x: 5, y: 6 },
    nan: { x: NaN, y: 0 },
    infinity: { x: 0, y: Infinity },
    negX: { x: -1, y: 0 },
    negY: { x: 0, y: -1 },
    strX: { x: '12', y: 0 },
    boolX: { x: true, y: 0 },
    nullXY: { x: null, y: null },
    missingY: { x: 3 },
    notObject: 'nope'
  })
)
check('只保留坐标合法的项', Object.keys(filtered).length === 1, filtered)
check('合法项的坐标原样保留', filtered.good?.x === 5 && filtered.good?.y === 6, filtered)

check(
  '超出坐标上限的值被丢弃',
  Object.keys(
    layout.parseErLayout(
      JSON.stringify({ huge: { x: 1e12, y: 0 }, ok: { x: 1, y: 1 } })
    )
  ).length === 1
)

/* ------------------------------------------------------------------ *
 * 8. sanitizeErLayout：未知节点被过滤
 * ------------------------------------------------------------------ */

const known = ['connection:c1|table:public.users', 'connection:c1|table:public.orders']
const sanitized = layout.sanitizeErLayout(
  {
    'connection:c1|table:public.users': { x: 1, y: 2 },
    'connection:c1|table:public.ghost': { x: 3, y: 4 },
    'connection:c1|table:public.orders': { x: 5, y: 6 }
  },
  known
)
check('当前图里不存在的节点被丢弃', Object.keys(sanitized).length === 2, sanitized)
check('已知节点的坐标保留', sanitized['connection:c1|table:public.users']?.x === 1, sanitized)

const noFilter = layout.sanitizeErLayout({
  'connection:c1|table:public.users': { x: 1, y: 2 }
})
check('不传节点集合时不做节点过滤', Object.keys(noFilter).length === 1, noFilter)

check('顶层非对象时 sanitize 返回空', Object.keys(layout.sanitizeErLayout([1, 2])).length === 0)

/* ------------------------------------------------------------------ *
 * 9. 序列化：只有节点 id 与坐标，绝不含数据库内容
 * ------------------------------------------------------------------ */

const serialized = layout.serializeErLayout({
  'connection:c1|table:public.users': { x: 10.4, y: 20.6 }
})
check('序列化结果只含 x 与 y', serialized === '{"connection:c1|table:public.users":{"x":10,"y":21}}', serialized)
check(
  '序列化结果不含列名 / 外键等数据库内容',
  !/column|foreign|referenc/i.test(serialized),
  serialized
)

const orderA = layout.serializeErLayout({ b: { x: 1, y: 1 }, a: { x: 2, y: 2 } })
const orderB = layout.serializeErLayout({ a: { x: 2, y: 2 }, b: { x: 1, y: 1 } })
check('节点顺序不影响序列化结果', orderA === orderB, { orderA, orderB })

const mapSerialized = layout.serializeErLayout(
  new Map([['connection:c1|table:public.users', { x: 7, y: 8 }]])
)
check(
  'Map 输入也能正确序列化（渲染层用 Map 传坐标）',
  mapSerialized === '{"connection:c1|table:public.users":{"x":7,"y":8}}',
  mapSerialized
)

const protoSerialized = layout.serializeErLayout(
  Object.fromEntries([['__proto__', { x: 1, y: 2 }]])
)
check(
  '__proto__ 节点不会污染 Object.prototype',
  ({}).x === undefined && Object.getOwnPropertyNames(JSON.parse(protoSerialized)).includes('__proto__'),
  protoSerialized
)

/* ------------------------------------------------------------------ *
 * 10. 存取往返 + 坏存储容错
 * ------------------------------------------------------------------ */

const memory = new Map()
const storage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, value)
}

const savedKey = layout.buildErLayoutKey('connection:c1', ['public'])
layout.saveErLayout(storage, savedKey, {
  'connection:c1|table:public.users': { x: 12, y: 34 }
})
const restored = layout.loadErLayout(storage, savedKey, known)
check(
  '存取往返后坐标不变',
  restored['connection:c1|table:public.users']?.x === 12 &&
    restored['connection:c1|table:public.users']?.y === 34,
  restored
)
check(
  '存进去的内容只有节点 id 与坐标',
  Object.keys(JSON.parse(memory.get(savedKey))).length === 1 &&
    Object.keys(JSON.parse(memory.get(savedKey))['connection:c1|table:public.users']).length === 2,
  memory.get(savedKey)
)

const throwingStorage = {
  getItem: () => {
    throw new Error('quota')
  },
  setItem: () => {
    throw new Error('quota')
  }
}
check('存储读取抛错时返回空布局', Object.keys(layout.loadErLayout(throwingStorage, 'k')).length === 0)
check('存储写入抛错时返回 false', layout.saveErLayout(throwingStorage, 'k', {}) === false)

console.log(`\nER 布局纯逻辑契约：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
