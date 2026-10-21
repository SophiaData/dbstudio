/**
 * 结果集导出的四种格式：CSV / JSON / INSERT SQL / Markdown。
 *
 * 设计原则：**纯函数**（输入 列名 + 行数据，输出字符串），不碰 DOM、不碰 API。
 * 这样做有两个直接好处：
 *   1. 可以在 Node 里直接单测（不需要 Electron/DOM），转义这类"一字之差错全表"
 *      的逻辑必须能被反复验证；
 *   2. 将来若要加"导出到主进程写文件"的通道，这套生成逻辑可直接复用。
 *
 * 关于 BOM：CSV 的 BOM（`\uFEFF`）由**调用方**决定是否加——因为纯函数不该知道
 * 目标平台是 Excel 还是别的。grid.ts 现有行为是加 BOM（Excel 中文不乱码）。
 */

import { csvEscape } from './grid'
import type { CellValue } from '../core/resultset'

/** 导出用的列描述（只要名字；导出不关心类型名，值的形态由 CellValue 表达）。 */
export interface ExportColumn {
  readonly name: string
}

/** 一行数据：与 columns 等长的 CellValue 数组。 */
export type ExportRow = readonly CellValue[]

// ============================================================================
// 值 → 文本（各格式共享的基础）
// ============================================================================

/**
 * NULL 判定。
 *
 * 为什么单独一个函数：`NULL` 与空字符串 `''` 在数据库里是**两回事**
 * （前者是"没有值"，后者是"值是空串"）。导出时必须区分：写 CSV 时都变空，
 * 但写 JSON 时一个是 `null`、一个是 `""`；写 INSERT 时一个是 `NULL`、
 * 一个是 `''`。若把两者混为一谈，导出的数据在语义上就错了。
 */
function isNull(cell: CellValue | undefined): cell is undefined | { readonly kind: 'null' } {
  return !cell || cell.kind === 'null'
}

/** BLOB 的十六进制文本（不带前缀）。CellValue 里带的是 base64 预览，需还原字节。 */
function blobHex(cell: Extract<CellValue, { kind: 'blob' }>): string {
  // previewBase64 是 base64 编码的预览字节（见 core/resultset.ts）。
  // Node 环境用 Buffer；浏览器环境用 atob。两条都实现，保持纯函数可双端运行。
  let bytes: Uint8Array
  const b64 = cell.previewBase64
  if (typeof Buffer !== 'undefined') {
    // eslint-disable-next-line no-undef
    bytes = Uint8Array.from(Buffer.from(b64, 'base64'))
  } else {
    const bin = atob(b64)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  }
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0').toUpperCase()
  return out
}

/** 值 → 普通文本（用于 CSV / Markdown）。NULL 返回 null 由调用方决定怎么写。 */
function cellToText(cell: CellValue | undefined): string | null {
  if (isNull(cell)) return null
  switch (cell.kind) {
    case 'text':
      return cell.text
    case 'number':
      return String(cell.value)
    case 'boolean':
      return cell.value ? 'true' : 'false'
    case 'blob':
      return '0x' + blobHex(cell)
    default:
      return null
  }
}

// ============================================================================
// CSV
// ============================================================================

/**
 * 导出 CSV。
 *
 * 复用 `grid.ts` 的 `csvEscape`（RFC 4180：含 `,` `"` CR LF 的字段整体加双引号，
 * 内部双引号翻倍）——**不复制**那份逻辑，避免两处规则漂移。
 *
 * BOM 由调用方加（见文件头）。行分隔用 `\r\n`，与 grid.ts 现有行为一致。
 */
export function toCsv(columns: readonly ExportColumn[], rows: readonly ExportRow[]): string {
  const header = columns.map((c) => csvEscape(c.name)).join(',')
  const lines = [header]
  for (const cells of rows) {
    const texts = columns.map((_, i) => csvEscape(cellToText(cells[i]) ?? ''))
    lines.push(texts.join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

// ============================================================================
// JSON
// ============================================================================

/**
 * 导出 JSON：行对象数组，key 是列名。
 *
 * 类型映射（这是本函数最容易做错的地方）：
 *   - `{kind:'null'}`  → `null`（**不是**字符串 "null"，也不是空串）
 *   - `{kind:'number'}`→ 数字（**不加引号**，保持 number 类型；否则下游算加总会变成字符串拼接）
 *   - `{kind:'boolean'}`→ true/false
 *   - `{kind:'text'}`  → 字符串
 *   - `{kind:'blob'}`  → `"0x.."` 十六进制字符串（JSON 没有二进制类型）
 *
 * 用 `JSON.stringify` 而不是手拼：它会正确处理字符串里的引号、换行、Unicode。
 * 手拼 JSON 是"看着能跑、遇到引号就崩"的典型。
 */
export function toJson(columns: readonly ExportColumn[], rows: readonly ExportRow[]): string {
  const objects: Record<string, unknown>[] = rows.map((cells) => {
    const obj: Record<string, unknown> = {}
    columns.forEach((col, i) => {
      const cell = cells[i]
      if (isNull(cell)) {
        obj[col.name] = null
        return
      }
      switch (cell.kind) {
        case 'number':
          obj[col.name] = cell.value
          break
        case 'boolean':
          obj[col.name] = cell.value
          break
        case 'blob':
          obj[col.name] = '0x' + blobHex(cell)
          break
        case 'text':
        default:
          obj[col.name] = cell.text
          break
      }
    })
    return obj
  })
  return JSON.stringify(objects, null, 2)
}

// ============================================================================
// INSERT SQL
// ============================================================================

/**
 * 把一个 SQL 字面量值转成文本（**这是本文件最需要小心的地方**）。
 *
 * 规则（与任务要求逐条对应）：
 *   - NULL → 关键字 `NULL`（无引号）
 *   - 数字 → 原样（无引号）
 *   - 布尔 → 1 / 0（SQLite 没有真正的 BOOLEAN 字面量；用整数最稳）
 *   - 字符串 → 单引号包裹，**内部单引号翻倍**（`O'Brien` → `'O''Brien'`）。
 *              这是 SQL 字符串字面量的唯一正确转义方式——不是反斜杠转义
 *              （反斜杠在标准 SQL 里不特殊，且 SQLite 默认不启用它）。
 *   - BLOB → `X'ABCDEF'` 十六进制字面量。
 *
 * ⚠️ 安全边界：这里**只做字符串转义，不做标识符转义**。表名/列名由调用方
 * 用方言的 quote 函数处理（见 `toInsertSql` 的 `quote` 参数）。把标识符和
 * 字面量混为一谈是另一个常见错误——两者转义规则完全不同。
 */
export function sqlLiteral(cell: CellValue | undefined): string {
  if (isNull(cell)) return 'NULL'
  switch (cell.kind) {
    case 'number':
      // NaN / Infinity 不是合法 SQL 数字，写成 NULL 更安全（否则 `NaN` 会让整条语句报错）。
      return Number.isFinite(cell.value) ? String(cell.value) : 'NULL'
    case 'boolean':
      return cell.value ? '1' : '0'
    case 'blob':
      return `X'${blobHex(cell)}'`
    case 'text':
    default: {
      const escaped = cell.text.replace(/'/g, "''")
      return `'${escaped}'`
    }
  }
}

/**
 * 导出 INSERT 语句：每行一条 `INSERT INTO <t> (<cols>) VALUES (<vals>);`。
 *
 * @param tableName 表名（裸名）。
 * @param quote     标识符引用函数（由调用方按方言提供）。表名与列名都经它转义。
 *                  为什么必须外部传入：不同方言的引用符不同（`"` / `` ` `` / `[]`），
 *                  且引用符内部的转义规则也不同——硬编码一种必然在某些方言上错。
 * @param columns   列描述。
 * @param rows      行数据。
 */
export function toInsertSql(
  tableName: string,
  columns: readonly ExportColumn[],
  rows: readonly ExportRow[],
  quote: (name: string) => string
): string {
  if (columns.length === 0) return ''
  const table = quote(tableName)
  const colList = columns.map((c) => quote(c.name)).join(', ')
  const statements: string[] = []
  for (const cells of rows) {
    const values = columns.map((_, i) => sqlLiteral(cells[i])).join(', ')
    statements.push(`INSERT INTO ${table} (${colList}) VALUES (${values});`)
  }
  return statements.join('\n')
}

// ============================================================================
// Markdown
// ============================================================================

/**
 * Markdown 表格。
 *
 * 单元格内要处理 `|`（会破坏表格结构）与换行（Markdown 表格不支持多行单元格）。
 * 处理方式：`|` 转义为 `\|`，换行替换成 `<br>`——这是 GitHub/多数渲染器都认的写法。
 * NULL 用空单元格表示（Markdown 表格里没有 NULL 概念，与 CSV 同理）。
 */
export function toMarkdown(
  columns: readonly ExportColumn[],
  rows: readonly ExportRow[]
): string {
  const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const header = '| ' + columns.map((c) => esc(c.name)).join(' | ') + ' |'
  const sep = '| ' + columns.map(() => '---').join(' | ') + ' |'
  const lines = [header, sep]
  for (const cells of rows) {
    const texts = columns.map((_, i) => {
      const t = cellToText(cells[i])
      return t === null ? '' : esc(t)
    })
    lines.push('| ' + texts.join(' | ') + ' |')
  }
  return lines.join('\n') + '\n'
}

// ============================================================================
// 文件名
// ============================================================================

/** 生成带时间戳的导出文件名，如 `dbstudio-2026-10-22T01-25-30-000Z.json`。 */
export function buildExportFileName(ext: string, now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, '-')
  return `dbstudio-${iso}.${ext}`
}
