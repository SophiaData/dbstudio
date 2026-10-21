/**
 * 对象 id 的编码 / 解析。
 *
 * ===== 为什么值得单独一个模块 =====
 *
 * `ObjectRef.id` 是**跨进程、可持久化**的稳定标识（见 `core/model.ts` 的注释）：
 * 它会被序列化、可能在下次启动时再解析回真实对象。
 * 一旦编码有歧义，症状不是报错而是"打开的表不是那张表"——
 * 所以规则必须确定、可逆，且解析失败要能被显式识别（返回 null，由调用方报 object_not_found）。
 *
 * 编码规则（与 task-13 规格一致）：
 *   folder:tables                  固定分组，无参数
 *   folder:views
 *   table:<name>                   只切**第一个**冒号，名字原样保留 → 无歧义
 *   view:<name>
 *   column:<table>.<column>
 *
 * ===== 为什么 column 要做转义，而不是规格里提的"从右往左切" =====
 *
 * 右切只能解决"表名带点号"这一个方向，列名带点时依然二义：
 *   `column:a.b.c` 无法判断是 table=`a.b` + column=`c`，还是 table=`a` + column=`b.c`
 * 而 SQLite 用双引号可以给任何东西起名（`CREATE TABLE "a.b" ("c.d" TEXT)` 完全合法），
 * 所以"名字里不会有奇怪字符"这个前提不成立。
 *
 * 这里改用**最小转义**：`\` → `\\`，`.` → `\.`。
 * 好处是普通名字（绝大多数）产出的 id 与规格字面完全一致（`column:users.id`），
 * 只有名字里真的含点号/反斜杠时才出现转义符；
 * 解析时从左到右扫描，遇到的第一个**未被转义的**点号就是分隔符，不存在歧义。
 */

/** 分组文件夹 id：与规格给定的字面量一致，UI 侧可能有硬编码引用，不要随意改。 */
export const TABLES_FOLDER_ID = 'folder:tables'
export const VIEWS_FOLDER_ID = 'folder:views'

/** 分组名。用联合类型而不是 string，避免解析出规格之外的分组。 */
export type GroupFolder = 'tables' | 'views'

/** 解析结果。调用方必须 switch 穷尽，不允许"猜" id 的含义。 */
export type ParsedObjectId =
  | { readonly kind: 'folder'; readonly folder: GroupFolder }
  | { readonly kind: 'table'; readonly name: string }
  | { readonly kind: 'view'; readonly name: string }
  | { readonly kind: 'column'; readonly ownerName: string; readonly columnName: string }

/** 转义一个参与 `列名.表名` 拼接的名字片段。 */
function escapePart(part: string): string {
  return part.replace(/\\/g, '\\\\').replace(/\./g, '\\.')
}

/**
 * 把 payload 按"第一个未被转义的点号"切成两段，并各自反转义。
 * 返回 null 表示 payload 不是本模块生成的（多于一个未转义点号、悬空转义符、缺分隔符）。
 */
function splitEscapedPair(payload: string): readonly [string, string] | null {
  let head = ''
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload.charAt(i)
    if (ch === '\\') {
      const next = payload.charAt(i + 1)
      // charAt 越界返回 ''，正好当作"悬空转义符"的哨兵：id 被外部改坏了
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
  return null // 一个点号都没有：不是合法的 column id
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
    if (ch === '.') return null // 分隔符只应出现一次
    out += ch
  }
  return out
}

export function tableObjectId(name: string): string {
  return `table:${name}`
}

export function viewObjectId(name: string): string {
  return `view:${name}`
}

export function columnObjectId(ownerName: string, columnName: string): string {
  return `column:${escapePart(ownerName)}.${escapePart(columnName)}`
}

/** 解析 id；认识就返回结构化结果，不认识就返回 null（由调用方决定怎么报错）。 */
export function parseObjectId(id: string): ParsedObjectId | null {
  const separator = id.indexOf(':')
  if (separator <= 0) return null
  const prefix = id.slice(0, separator)
  // 只切第一个冒号：这样 `table:a:b` 的表名就是 `a:b`，名字里的冒号不需要转义
  const payload = id.slice(separator + 1)

  if (prefix === 'folder') {
    if (payload === 'tables') return { kind: 'folder', folder: 'tables' }
    if (payload === 'views') return { kind: 'folder', folder: 'views' }
    return null
  }

  // 空名字不是合法对象：SQLite 不允许空标识符，所以这里可以直接拒掉，避免向后拼出坏 SQL
  if (payload === '') return null

  if (prefix === 'table') return { kind: 'table', name: payload }
  if (prefix === 'view') return { kind: 'view', name: payload }

  if (prefix === 'column') {
    const pair = splitEscapedPair(payload)
    if (pair === null) return null
    const [ownerName, columnName] = pair
    if (ownerName === '' || columnName === '') return null
    return { kind: 'column', ownerName, columnName }
  }

  return null
}
