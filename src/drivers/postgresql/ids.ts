/**
 * PostgreSQL 对象 id 的编码 / 解析。
 *
 * ===== 与 SQLite 的 `ids.ts` 最大的差别：PG 有 schema 层 =====
 *
 * 同一个表名可以同时存在于多个 schema（`public.users` 与 `audit.users` 是两张表），
 * 所以对象 id **必须带 schema**，否则解析回来就是"打开的表不是那张表"——
 * 这是 `core/model.ts` 里明确点名的、比报错更严重的错误。
 *
 * 编码规则（沿用 SQLite 那套"最小转义"的思路，见 sqlite/ids.ts 的说明）：
 *   folder:schemas                          schema 分组（根层的唯一分组）
 *   schema:<name>                           一个 schema 节点
 *   folder:<schema>|tables                  某 schema 下的表分组
 *   folder:<schema>|views                   某 schema 下的视图分组
 *   table:<schema>.<name>                   表（schema 与表名用未转义点号分隔）
 *   view:<schema>.<name>                    视图
 *   column:<schema>.<table>.<column>        列
 *
 * 转义规则与 SQLite 完全相同：`\` → `\\`，`.` → `\.`，切分时"第一个未转义点号"。
 * 为什么不直接复用 sqlite/ids.ts：那是另一个驱动的私有编码（且不带 schema 维度），
 * 跨驱动 import 会让两个方言的实现纠缠，违反"每个方言自治"的边界。
 * 需要的只是同一套**规则**，不是同一份代码。
 */

/** 根层（`parentId === null`）唯一的子节点：schema 分组。 */
export const SCHEMAS_FOLDER_ID = 'folder:schemas'

/** 一个 schema 内部的子分组。 */
export type SchemaFolder = 'tables' | 'views'

/** 解析结果。调用方必须 switch 穷尽，不允许"猜" id 的含义。 */
export type ParsedObjectId =
  | { readonly kind: 'schemas-folder' }
  | { readonly kind: 'schema'; readonly schema: string }
  | { readonly kind: 'folder'; readonly schema: string; readonly folder: SchemaFolder }
  | { readonly kind: 'table'; readonly schema: string; readonly name: string }
  | { readonly kind: 'view'; readonly schema: string; readonly name: string }
  | { readonly kind: 'column'; readonly schema: string; readonly table: string; readonly column: string }

function escapePart(part: string): string {
  return part.replace(/\\/g, '\\\\').replace(/\./g, '\\.')
}

/**
 * 把 payload 按"第一个未被转义的点号"切成两段并各自反转义。
 * 返回 null 表示 payload 不是本模块生成的（多于一个未转义点号、悬空转义符、缺分隔符）。
 */
function splitEscapedPair(payload: string): readonly [string, string] | null {
  let head = ''
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload.charAt(i)
    if (ch === '\\') {
      const next = payload.charAt(i + 1)
      if (next === '') return null
      head += next
      i += 1
      continue
    }
    if (ch === '.') {
      const tail = unescapeTail(payload, i + 1)
      return tail === null ? null : [head, tail]
    }
    head += ch
  }
  return null
}

/** 反转义分隔符之后的剩余部分；再出现未转义点号即视为损坏。 */
function unescapeTail(payload: string, start: number): string | null {
  let out = ''
  for (let i = start; i < payload.length; i += 1) {
    const ch = payload.charAt(i)
    if (ch === '\\') {
      const next = payload.charAt(i + 1)
      if (next === '') return null
      out += next
      i += 1
      continue
    }
    if (ch === '.') return null
    out += ch
  }
  return out
}

/** 把 payload 按"第一个未转义点号"切成**两段**（不要求尾部再无点号），用于三段式 column id。 */
function splitFirstEscaped(payload: string): readonly [string, string] | null {
  let head = ''
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload.charAt(i)
    if (ch === '\\') {
      const next = payload.charAt(i + 1)
      if (next === '') return null
      head += next
      i += 1
      continue
    }
    if (ch === '.') {
      let tail = ''
      for (let j = i + 1; j < payload.length; j += 1) tail += payload.charAt(j)
      return [head, tail]
    }
    head += ch
  }
  return null
}

export function schemaObjectId(schema: string): string {
  return `schema:${escapePart(schema)}`
}

export function schemaFolderId(schema: string, folder: SchemaFolder): string {
  return `folder:${escapePart(schema)}|${folder}`
}

export function tableObjectId(schema: string, name: string): string {
  return `table:${escapePart(schema)}.${escapePart(name)}`
}

export function viewObjectId(schema: string, name: string): string {
  return `view:${escapePart(schema)}.${escapePart(name)}`
}

export function columnObjectId(schema: string, table: string, column: string): string {
  return `column:${escapePart(schema)}.${escapePart(table)}.${escapePart(column)}`
}

/**
 * 解析 id；认识就返回结构化结果，不认识就返回 null（由调用方决定怎么报错）。
 *
 * 注意 `folder:` 前缀有两种 payload：裸 `schemas`（根分组）与 `<schema>|tables`。
 * `|` 只出现在 folder 编码里，所以对 folder 单独处理。
 */
export function parseObjectId(id: string): ParsedObjectId | null {
  const separator = id.indexOf(':')
  if (separator <= 0) return null
  const prefix = id.slice(0, separator)
  const payload = id.slice(separator + 1)
  if (payload === '') return null

  if (prefix === 'folder') {
    if (payload === 'schemas') return { kind: 'schemas-folder' }
    const bar = payload.indexOf('|')
    if (bar === -1) return null
    const schema = unescapeTail(payload.slice(0, bar), 0)
    const folder = payload.slice(bar + 1)
    if (schema === null || (folder !== 'tables' && folder !== 'views')) return null
    return { kind: 'folder', schema, folder }
  }

  if (prefix === 'schema') {
    const schema = unescapeTail(payload, 0)
    return schema === null ? null : { kind: 'schema', schema }
  }

  if (prefix === 'table' || prefix === 'view') {
    const pair = splitEscapedPair(payload)
    if (pair === null) return null
    const [schema, name] = pair
    if (schema === '' || name === '') return null
    return prefix === 'table' ? { kind: 'table', schema, name } : { kind: 'view', schema, name }
  }

  if (prefix === 'column') {
    const first = splitFirstEscaped(payload)
    if (first === null) return null
    const [schema, rest] = first
    const second = splitEscapedPair(rest)
    if (second === null) return null
    const [table, column] = second
    if (schema === '' || table === '' || column === '') return null
    return { kind: 'column', schema, table, column }
  }

  return null
}
