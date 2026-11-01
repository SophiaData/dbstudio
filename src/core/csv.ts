/**
 * CSV 导入的**解析与预览契约**（P2.3）。
 *
 * ===== 这一层负责什么 =====
 *
 * 只做四件事，且**只做这四件**：
 *   1. 字节 → 文本（严格 UTF-8，可选剥 BOM）；
 *   2. 文本 → 记录 / 字段（RFC 4180：双引号转义、引号内换行、引号内分隔符）；
 *   3. 结构校验（重复列名、缺列、多列、引号不合法）；
 *   4. 产出**有界**的预览（列 + 固定上限的样例行 + 带行号/列名的错误）。
 *
 * ===== 这一层明确不做什么 =====
 *
 *   - 不读文件、不持有文件句柄：输入是**已经读进来的字节**，
 *     读文件是 Task B（ImportManager）的事；
 *   - 不连数据库、不生成 SQL：目标表 / 列映射 / 类型转换是 Task C 的事；
 *   - 不把整份 CSV 留在内存里给 renderer：结果对象里只有
 *     `columns`（列数级）与 `sampleRows`（**固定上限**行），行数只以
 *     `totalRows` 计数存在。
 *
 * ===== 为什么这个文件不 import 任何 Node 内置模块 =====
 *
 * 因为 Task D 的导入向导在**渲染进程**里，而渲染进程没有 `node:buffer`。
 * 解码用的是 Web 标准的 `TextDecoder`（Node 与浏览器都有），
 * 字节扫描是手写循环——所以本文件可以同时被 main、preload、renderer 引用，
 * 不会出现"core 里有段代码 renderer 一 import 就炸"。
 *
 * ===== 为什么"空字符串"和"NULL"必须区分 =====
 *
 * 这是 CSV 导入里最容易**静默改数据**的地方：
 * 用户导出时写的是空字符串（`""`），导入时如果按"空 = NULL"处理，
 * 表里就多了一批 NULL；反过来，用户导出的 NULL（未加引号的空字段）
 * 如果按"空 = 空字符串"处理，NOT NULL 约束会直接拒绝，或者更糟——
 * 悄悄写进一串空字符串。
 *
 * 所以规则是**唯一且可预测**的：
 *   - 字段被引号包住 → 永远是**文本**（`""` → 空字符串，`"\N"` → 文本 `\N`）；
 *   - 字段没被引号包住，且文本**恰好等于** NULL 标记 → **NULL**；
 *   - 其余情况 → **文本**。
 *
 * 默认 NULL 标记是空串，于是"未加引号的空字段 = NULL"，
 * "加了引号的空字段 = 空字符串"——正好对应 RFC 4180 与大多数工具的默认行为。
 * 换成自定义标记（如 `\N`）后，未加引号的空字段回到"空字符串"语义。
 *
 * ===== 错误为什么要带行号和列名 =====
 *
 * 用户拿到的是"第 3 行、第 2 列有问题"这句话才能去改文件。
 * 只说"格式错误"的导入工具等于没用——用户不知道改哪儿，
 * 只能一行行数。而且这里要区分两种位置：
 *   - `line`：**物理行号**（文件里第几行）。引号内的换行会占掉物理行，
 *     所以同一个逻辑行的 line 可能比直觉上大；
 *   - `row`：**逻辑数据行号**（第几条数据）。表头不计入，空白行也不计入。
 *
 * 两者都给出，用户既可以按"第几行"去编辑器里定位，也可以按"第几条"去核对数据。
 *
 * ===== Task B 怎么用这一层 =====
 *
 * Task B 要把一个可能很大的文件流式喂进数据库，**不能**把整个文件读进来。
 * 所以这里除了有界的 `parseCsv` / `previewCsv`，还导出：
 *   - `createCsvRecordReader`：按文本块增量地产出记录（跨块不断行），
 *     Task B 用它边读边写，内存只与一个块有关；
 *   - `deriveCsvColumns`：从表头记录推出列（Task B 需要在写第一行前就知道列）；
 *   - `validateCsvRecordColumns`：逐行做缺列/多列校验；
 *   - `csvCellFromRaw`：记录字段 → 单元格（NULL/空字符串判定）。
 *
 * 三条路径共用**同一套** RFC 4180 扫描器与同一套列校验逻辑，
 * 所以"预览里显示的列名"和"真正导入时用的列名"不可能对不上——
 * 这正是导入工具最常见、也最难查的一类 bug。
 */

/** 默认分隔符（逗号）。 */
export const DEFAULT_CSV_DELIMITER = ','

/**
 * 默认 NULL 标记（空串）。
 *
 * 语义见文件头：未加引号的字段文本**恰好等于**它 → NULL。
 */
export const DEFAULT_CSV_NULL_TEXT = ''

/** 预览默认最多保留的样例行数。 */
export const DEFAULT_CSV_SAMPLE_ROWS = 50

/**
 * 预览样例行的**硬上限**。
 *
 * 这是"完整 CSV 不进 renderer 内存"的落地约束：即使调用方传了更大的值，
 * 也不接受——而不是静默 clamp（静默 clamp 会让人以为"我请求了 500 行，
 * 其实只有 200 行"却无人察觉）。
 */
export const MAX_CSV_SAMPLE_ROWS = 200

/**
 * 错误列表上限。
 *
 * 一个坏文件可能让每一行都报错；错误对象本身要进 renderer，
 * 所以必须有界。`errorCount` 记录**实际发生的错误总数**，
 * 与被截断后的 `errors.length` 分开，避免"只显示了前 100 条"被误读成
 * "只有 100 个错误"。
 */
export const MAX_CSV_ERRORS = 100

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单元格种类。`null` 与 `text` 必须能区分——见文件头。 */
export type CsvCellKind = 'null' | 'text'

/**
 * 解析后的单元格。
 *
 * `kind === 'null'` 时 `text` 恒为 null；
 * `kind === 'text'` 时 `text` 恒是字符串（**可能是空字符串**）。
 */
export interface CsvCell {
  readonly kind: CsvCellKind
  /** 文本值；kind 为 'null' 时是 null。 */
  readonly text: string | null
  /** 原始字段是否被双引号包住。用于诊断与"引号内换行"的解释。 */
  readonly quoted: boolean
}

/** 一列。`index` 从 1 开始。 */
export interface CsvColumn {
  /** 列位置，从 1 开始。 */
  readonly index: number
  /** 列名（表头原文；无表头时是 `column_1` 这种位置名）。 */
  readonly name: string
  /** 该列名是否与其它列重复。 */
  readonly duplicate: boolean
}

/** 一条样例行。 */
export interface CsvRow {
  /** 逻辑数据行号，从 1 开始（不含表头、不含空白行）。 */
  readonly row: number
  /** 物理行号：这条记录在文件里开始的行号。 */
  readonly line: number
  /** 单元格值。长度可能与列数不等（缺列/多列的行会如实反映）。 */
  readonly values: readonly CsvCell[]
}

/** 解析错误的种类。 */
export type CsvErrorCode =
  | 'empty-file'
  | 'invalid-encoding'
  | 'duplicate-column'
  | 'empty-header'
  | 'missing-column'
  | 'extra-column'
  | 'unterminated-quote'
  | 'malformed-quote'

/** 一条解析错误。位置字段为 null 表示"不适用"（例如文件级错误没有列）。 */
export interface CsvError {
  readonly code: CsvErrorCode
  /** 人类可读说明（中文，直接进 UI）。 */
  readonly message: string
  /** 逻辑数据行号；文件级/表头级错误为 null。 */
  readonly row: number | null
  /** 物理行号。 */
  readonly line: number | null
  /** 列位置（从 1 开始）。 */
  readonly column: number | null
  /** 列名（表头原文）。定位不到具体列时为 null。 */
  readonly columnName: string | null
}

/** 解析选项。 */
export interface CsvParseOptions {
  /** 字段分隔符，默认 `,`。必须是单个字符，且不是 `"` / CR / LF。 */
  readonly delimiter?: string
  /** NULL 标记文本，默认 `''`。 */
  readonly nullText?: string
  /** 是否有表头，默认 true。 */
  readonly hasHeader?: boolean
  /** 预览最多保留的样例行数，默认 50，上限 `MAX_CSV_SAMPLE_ROWS`。 */
  readonly sampleRowLimit?: number
}

/** 解析结果。 */
export interface CsvParseResult {
  /** 没有错误时为 true。 */
  readonly ok: boolean
  /** 列。空文件或编码错误时为空数组。 */
  readonly columns: readonly CsvColumn[]
  /** 样例行，**长度受 sampleRowLimit 约束**。 */
  readonly sampleRows: readonly CsvRow[]
  /** 错误列表（最多 `MAX_CSV_ERRORS` 条）。 */
  readonly errors: readonly CsvError[]
  /** 实际发生的错误总数（可能大于 errors.length）。 */
  readonly errorCount: number
  /** 数据行总数（不含表头与空白行）。 */
  readonly totalRows: number
  /** 是否有行没进预览（即行数超过样例上限）。 */
  readonly truncated: boolean
  /** 实际使用的分隔符。 */
  readonly delimiter: string
  /** 实际使用的 NULL 标记。 */
  readonly nullText: string
  /** 是否有表头。 */
  readonly hasHeader: boolean
}

/** 原始字段（还没做 NULL/空字符串判定）。 */
export interface CsvRawField {
  readonly value: string
  /** 字段是否被双引号包住。 */
  readonly quoted: boolean
}

/** 记录级别的引号错误。 */
export interface CsvRawRecordError {
  readonly code: 'unterminated-quote' | 'malformed-quote'
  readonly message: string
  /** 出错的列位置（从 1 开始）。 */
  readonly column: number
}

/** 一条原始记录（还没做列数校验）。 */
export interface CsvRawRecord {
  /** 物理行号：这条记录在文件里开始的行号。 */
  readonly line: number
  readonly fields: readonly CsvRawField[]
  /** 引号层面的错误（如果有）。 */
  readonly error: CsvRawRecordError | null
}

/**
 * 增量记录读取器。
 *
 * Task B 用它把文件按块喂进来：内存占用与**块大小**有关，与文件总行数无关。
 */
export interface CsvRecordReader {
  /** 喂入一段文本，产出其中已经完整的记录。 */
  push(text: string): readonly CsvRawRecord[]
  /** 文件读完，产出剩余记录（含可能未闭合引号的最后一条）。 */
  flush(): readonly CsvRawRecord[]
}

// ---------------------------------------------------------------------------
// 内部结构
// ---------------------------------------------------------------------------

interface RawField {
  readonly value: string
  readonly quoted: boolean
}

interface RawRecord {
  readonly fields: readonly RawField[]
  /** 这条记录开始时的物理行号。 */
  readonly line: number
  readonly error: RawRecordError | null
}

interface RawRecordError {
  readonly code: 'unterminated-quote' | 'malformed-quote'
  readonly message: string
  /** 出错的列位置（从 1 开始）。 */
  readonly column: number
}

interface RecordScan {
  readonly record: RawRecord
  readonly nextPos: number
  readonly nextLine: number
  /**
   * true 表示扫描是因为**输入耗尽**而结束的，而不是遇到了记录终止符。
   * 非 final 模式下这意味着"这条记录还没读完，得等下一块"。
   */
  readonly exhausted: boolean
}

// ---------------------------------------------------------------------------
// UTF-8 严格解码
// ---------------------------------------------------------------------------

function isContinuation(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf
}

/**
 * 找出第一处非法 UTF-8 字节的偏移；全部合法时返回 -1。
 *
 * ===== 为什么要自己扫，而不是直接 `TextDecoder(fatal: true)` =====
 *
 * `TextDecoder` 在 fatal 模式下抛出的异常**不带位置信息**：
 * 只有一个 "The encoded data was not valid" 的错误，
 * 我们拿不到"坏在第几行"。而错误行号是这份契约的核心要求之一，
 * 所以这里自己扫一遍字节。
 *
 * 顺带好处：能明确区分**代理区码点**（0xED 0xA0..0xBF）
 * 与**超长编码**（0xC0/0xC1、0xE0 0x80..、0xF0 0x80..）——
 * 这些 UTF-8 解码器都会拒绝，但手写解码器常常放过，
 * 结果就是"看起来解出来了，实际是乱码"。
 */
function findInvalidUtf8(bytes: Uint8Array): number {
  let index = 0
  const length = bytes.length
  while (index < length) {
    const byte = bytes[index] as number
    if (byte <= 0x7f) {
      index += 1
      continue
    }
    if (byte >= 0xc2 && byte <= 0xdf) {
      if (index + 1 >= length || !isContinuation(bytes[index + 1] as number)) return index
      index += 2
      continue
    }
    if (byte === 0xe0) {
      if (index + 2 >= length) return index
      const second = bytes[index + 1] as number
      const third = bytes[index + 2] as number
      if (second < 0xa0 || second > 0xbf || !isContinuation(third)) return index
      index += 3
      continue
    }
    if (byte === 0xed) {
      if (index + 2 >= length) return index
      const second = bytes[index + 1] as number
      const third = bytes[index + 2] as number
      // 0xED 0xA0..0xBF 编码的是 UTF-16 代理区码点，不是合法 UTF-8。
      if (second < 0x80 || second > 0x9f || !isContinuation(third)) return index
      index += 3
      continue
    }
    if (byte >= 0xe1 && byte <= 0xec) {
      if (index + 2 >= length) return index
      if (!isContinuation(bytes[index + 1] as number)) return index
      if (!isContinuation(bytes[index + 2] as number)) return index
      index += 3
      continue
    }
    if (byte === 0xee || byte === 0xef) {
      if (index + 2 >= length) return index
      if (!isContinuation(bytes[index + 1] as number)) return index
      if (!isContinuation(bytes[index + 2] as number)) return index
      index += 3
      continue
    }
    if (byte === 0xf0) {
      if (index + 3 >= length) return index
      const second = bytes[index + 1] as number
      if (second < 0x90 || second > 0xbf) return index
      if (!isContinuation(bytes[index + 2] as number)) return index
      if (!isContinuation(bytes[index + 3] as number)) return index
      index += 4
      continue
    }
    if (byte === 0xf4) {
      if (index + 3 >= length) return index
      const second = bytes[index + 1] as number
      if (second < 0x80 || second > 0x8f) return index
      if (!isContinuation(bytes[index + 2] as number)) return index
      if (!isContinuation(bytes[index + 3] as number)) return index
      index += 4
      continue
    }
    if (byte >= 0xf1 && byte <= 0xf3) {
      if (index + 3 >= length) return index
      if (!isContinuation(bytes[index + 1] as number)) return index
      if (!isContinuation(bytes[index + 2] as number)) return index
      if (!isContinuation(bytes[index + 3] as number)) return index
      index += 4
      continue
    }
    // 0x80..0xC1、0xF5..0xFF：任何情况下都不是合法的 UTF-8 起始字节。
    return index
  }
  return -1
}

interface DecodedText {
  readonly ok: boolean
  readonly text: string
  /** 非法字节所在（或之后第一个）的物理行号。 */
  readonly line: number
  /** 非法字节偏移。 */
  readonly offset: number
}

/**
 * 严格解码 UTF-8，并剥掉开头的 BOM。
 *
 * ===== 为什么坏编码要**失败**而不是替换成 U+FFFD =====
 *
 * `TextDecoder` 默认用 U+FFFD 替换非法字节。这对"显示一段乱码"是无害的，
 * 对"把数据写进数据库"是**有毒的**：乱码会被原样写进表里，
 * 用户看到导入成功、条数正确，直到某天查出来是乱码才发现。
 *
 * 导入是**写操作**，宁可当场失败并指出行号，也不要静默写入坏数据。
 */
function decodeUtf8Strict(bytes: Uint8Array): DecodedText {
  const invalidOffset = findInvalidUtf8(bytes)
  if (invalidOffset >= 0) {
    // 前缀一定是合法 UTF-8，所以可以安全解码，用它来数行号。
    const prefix = decodeUtf8Chunk(bytes.subarray(0, invalidOffset))
    let line = 1
    for (let index = 0; index < prefix.length; index += 1) {
      if (prefix.charCodeAt(index) === 10) line += 1
    }
    return { ok: false, text: '', line, offset: invalidOffset }
  }
  let text = decodeUtf8Chunk(bytes)
  // 剥掉 UTF-8 BOM（U+FEFF）。
  // 不剥的话第一列名会变成 "﻿id"，映射到目标表时列对不上。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { ok: true, text, line: 1, offset: -1 }
}

/**
 * 用 Web 标准的 `TextDecoder` 解一段**已知合法**的 UTF-8 字节。
 *
 * 用标准 API 而不是手写解码循环，是为了不重复实现 UTF-8 解码本身
 * （手写最容易在代理区码点上出错）；合法性由 `findInvalidUtf8` 负责把关。
 */
function decodeUtf8Chunk(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

// ---------------------------------------------------------------------------
// 记录扫描（RFC 4180）
// ---------------------------------------------------------------------------

/**
 * 是否是"看不见后继字符的 CR"：分块模式（`final=false`）下 CR 正好落在当前
 * 输入末尾，无法判断下一块以 LF 开头（一个 CRLF）还是别的内容（孤立 CR）。
 * 这时**不能靠猜终止记录**——提前终止会把一次换行当两次，
 * 产出假空行并让后续行号整体错位。返回 true 表示这条记录要等下一块重扫。
 * 文件末尾（`final=true`）时 CR 后面必然什么都没有，正常终止。
 */
function pendingCarriageReturn(ch: string, index: number, text: string, final: boolean): boolean {
  return ch === '\r' && !final && index + 1 >= text.length
}

/**
 * 从 `pos` 开始读一条记录。
 *
 * ===== RFC 4180 的要点在这里怎么落地 =====
 *
 *   - 字段可以用双引号包住；包住之后里面的一切（分隔符、换行）都是字面量；
 *   - 引号内部的双引号写两个（`""`）表示一个字面引号；
 *   - 闭引号之后只能跟分隔符、行结束或文件结束——
 *     跟了别的东西就是 `malformed-quote`（很多 CSV 文件真的这么写，
 *     必须明确报错而不是默默吃掉后面的内容）。
 *
 * 记录边界有歧义时**不猜**：一律报错并带上位置。
 *
 * `final` 表示"输入到此为止"。非 final 时如果扫描因为输入耗尽而结束，
 * 结果里的 `exhausted` 为 true，调用方应当**等下一块**再重新扫描——
 * 这是分块读取时最容易搞错的地方（把块边界当成行边界会少读/多读字段）。
 */
function readNextRecord(
  text: string,
  pos: number,
  line: number,
  delimiter: string,
  final: boolean
): RecordScan {
  const fields: RawField[] = []
  let value = ''
  let quoted = false
  let inQuotes = false
  let afterQuote = false
  let error: RawRecordError | null = null
  const startLine = line
  let index = pos

  const pushField = (): void => {
    fields.push({ value, quoted })
    value = ''
    quoted = false
  }

  while (index < text.length) {
    const ch = text.charAt(index)

    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(index + 1) === '"') {
          value += '"'
          index += 2
          continue
        }
        inQuotes = false
        afterQuote = true
        index += 1
        continue
      }
      if (ch === '\n') line += 1
      value += ch
      index += 1
      continue
    }

    if (afterQuote) {
      if (ch === delimiter) {
        pushField()
        afterQuote = false
        index += 1
        continue
      }
      if (ch === '\r' || ch === '\n') {
        if (pendingCarriageReturn(ch, index, text, final)) {
          // CR 落在当前输入末尾（分块场景）：还不知道它是 CRLF 的一半还是孤立 CR。
          // 把这条记录当作"没读完"交回，等下一块从记录起点重扫——
          // 绝不在看不到后继字符时就终止，否则下一块开头的 LF 会被当成第二次换行。
          return { record: { fields, line: startLine, error }, nextPos: index, nextLine: line, exhausted: true }
        }
        pushField()
        index += 1
        if (ch === '\r' && text.charAt(index) === '\n') index += 1
        line += 1
        return { record: { fields, line: startLine, error }, nextPos: index, nextLine: line, exhausted: false }
      }
      if (error === null) {
        error = {
          code: 'malformed-quote',
          message: '闭合的双引号后面出现了其它字符；请把字段整体用双引号包住',
          column: fields.length + 1
        }
      }
      // 跳过这条记录剩下的内容，落到下一个分隔符/行尾。
      index += 1
      while (index < text.length) {
        const skip = text.charAt(index)
        if (skip === delimiter || skip === '\r' || skip === '\n') break
        index += 1
      }
      continue
    }

    if (ch === '"') {
      if (value !== '') {
        if (error === null) {
          error = {
            code: 'malformed-quote',
            message: '字段中间出现未转义的双引号；字段里的双引号必须写成两个',
            column: fields.length + 1
          }
        }
        index += 1
        while (index < text.length) {
          const skip = text.charAt(index)
          if (skip === delimiter || skip === '\r' || skip === '\n') break
          index += 1
        }
        continue
      }
      inQuotes = true
      quoted = true
      index += 1
      continue
    }

    if (ch === delimiter) {
      pushField()
      index += 1
      continue
    }

    if (ch === '\r' || ch === '\n') {
      if (pendingCarriageReturn(ch, index, text, final)) {
        // 同上：块尾的 CR 无法前瞻，记录保持未完成，等下一块重扫。
        return { record: { fields, line: startLine, error }, nextPos: index, nextLine: line, exhausted: true }
      }
      pushField()
      index += 1
      if (ch === '\r' && text.charAt(index) === '\n') index += 1
      line += 1
      return { record: { fields, line: startLine, error }, nextPos: index, nextLine: line, exhausted: false }
    }

    value += ch
    index += 1
  }

  if (inQuotes) {
    if (final) {
      if (error === null) {
        error = {
          code: 'unterminated-quote',
          message: '双引号没有闭合；含分隔符或换行的字段必须整体用双引号包住',
          column: fields.length + 1
        }
      }
    }
    // 非 final：引号还没闭合，说明这块文本还没读完 —— exhausted 保持 true。
  }
  pushField()
  return { record: { fields, line: startLine, error }, nextPos: index, nextLine: line, exhausted: true }
}

// ---------------------------------------------------------------------------
// 选项校验
// ---------------------------------------------------------------------------

interface NormalizedOptions {
  readonly delimiter: string
  readonly nullText: string
  readonly hasHeader: boolean
  readonly sampleRowLimit: number
}

function normalizeOptions(options: CsvParseOptions): NormalizedOptions {
  const delimiter = options.delimiter ?? DEFAULT_CSV_DELIMITER
  if (typeof delimiter !== 'string' || delimiter.length !== 1) {
    throw new Error(`CSV 分隔符必须是单个字符，收到 ${JSON.stringify(delimiter)}`)
  }
  if (delimiter === '"' || delimiter === '\r' || delimiter === '\n') {
    throw new Error(`CSV 分隔符不能是引号或换行符，收到 ${JSON.stringify(delimiter)}`)
  }

  const nullText = options.nullText ?? DEFAULT_CSV_NULL_TEXT
  if (typeof nullText !== 'string') {
    throw new Error('CSV 的 NULL 标记必须是字符串')
  }

  const hasHeader = options.hasHeader ?? true
  if (typeof hasHeader !== 'boolean') {
    throw new Error('CSV 的 hasHeader 必须是布尔值')
  }

  const sampleRowLimit = options.sampleRowLimit ?? DEFAULT_CSV_SAMPLE_ROWS
  if (
    typeof sampleRowLimit !== 'number' ||
    !Number.isInteger(sampleRowLimit) ||
    sampleRowLimit < 1 ||
    sampleRowLimit > MAX_CSV_SAMPLE_ROWS
  ) {
    throw new Error(
      `CSV 预览的样例行上限必须在 1 ~ ${MAX_CSV_SAMPLE_ROWS} 之间，收到 ${String(sampleRowLimit)}`
    )
  }

  return { delimiter, nullText, hasHeader, sampleRowLimit }
}

// ---------------------------------------------------------------------------
// 单元格
// ---------------------------------------------------------------------------

/**
 * 把原始字段变成单元格。
 *
 * 唯一规则：**没加引号**且文本**恰好等于** NULL 标记 → NULL；
 * 其它一律是文本（包括加引号的空串 `""` → 空字符串）。
 */
function makeCell(field: RawField, nullText: string): CsvCell {
  if (!field.quoted && field.value === nullText) {
    return { kind: 'null', text: null, quoted: false }
  }
  return { kind: 'text', text: field.value, quoted: field.quoted }
}

/**
 * 原始字段 → 单元格（NULL / 空字符串判定）。
 *
 * 导出给 Task B 用：**和预览用的是同一套判定**，
 * 所以预览里显示的 NULL 与真正写进表里的 NULL 必然一致。
 */
export function csvCellFromRaw(field: CsvRawField, nullText: string = DEFAULT_CSV_NULL_TEXT): CsvCell {
  return makeCell(field, nullText)
}

/** 取单元格种类（`'null'` 或 `'text'`）。 */
export function csvCellKind(cell: CsvCell): CsvCellKind {
  return cell.kind
}

/**
 * 取单元格文本。
 *
 * NULL 返回 null，**空字符串返回 `''`**——两者不能混。
 */
export function csvCellText(cell: CsvCell): string | null {
  return cell.text
}

// ---------------------------------------------------------------------------
// 列
// ---------------------------------------------------------------------------

/** 由表头记录推出的列 + 相关错误。 */
export interface CsvColumnDerivation {
  readonly columns: readonly CsvColumn[]
  readonly errors: readonly CsvError[]
}

/**
 * 从表头记录推出列。
 *
 * 重复列名在这里被识别——因为**列映射**要求目标列唯一，
 * 两个同名列没法决定映射到哪一列。与其让下游"随便挑一个"，
 * 不如在这里明确报错并指出两列的位置。
 */
export function deriveCsvColumns(fields: readonly CsvRawField[], line: number): CsvColumnDerivation {
  const errors: CsvError[] = []
  const seen = new Map<string, number>()
  const built: CsvColumn[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const name = (fields[index] as CsvRawField).value
    built.push({ index: index + 1, name, duplicate: false })
    const previous = seen.get(name)
    if (previous === undefined) {
      seen.set(name, index + 1)
    } else {
      const target = built[previous - 1] as CsvColumn
      built[index] = { index: index + 1, name, duplicate: true }
      built[previous - 1] = { ...target, duplicate: true }
      errors.push({
        code: 'duplicate-column',
        message: `表头里的列名「${name}」重复（第 ${previous} 列与第 ${index + 1} 列）。列名必须唯一。`,
        row: null,
        line,
        column: index + 1,
        columnName: name
      })
    }
  }
  for (let index = 0; index < built.length; index += 1) {
    const column = built[index] as CsvColumn
    if (column.name.trim() === '') {
      errors.push({
        code: 'empty-header',
        message: `表头第 ${column.index} 列没有列名，无法映射到目标表的列。`,
        row: null,
        line,
        column: column.index,
        columnName: ''
      })
    }
  }
  return { columns: built, errors }
}

/**
 * 校验一条数据行的列数。
 *
 * 返回缺列 / 多列的错误（没有问题时返回空数组）。
 * 错误带**逻辑行号**与**列名**——用户据此就能定位到具体是哪个字段。
 */
export function validateCsvRecordColumns(
  fields: readonly CsvRawField[],
  columns: readonly CsvColumn[],
  rowNumber: number,
  line: number
): readonly CsvError[] {
  const errors: CsvError[] = []
  const expected = columns.length
  if (fields.length < expected) {
    const missingIndex = fields.length
    errors.push({
      code: 'missing-column',
      message:
        `第 ${rowNumber} 行只有 ${fields.length} 个字段，` +
        `比表头的 ${expected} 列少了「${columns[missingIndex]?.name ?? ''}」。`,
      row: rowNumber,
      line,
      column: missingIndex + 1,
      columnName: columns[missingIndex]?.name ?? null
    })
  } else if (fields.length > expected) {
    errors.push({
      code: 'extra-column',
      message:
        `第 ${rowNumber} 行有 ${fields.length} 个字段，` +
        `比表头的 ${expected} 列多了第 ${expected + 1} 列的值。`,
      row: rowNumber,
      line,
      column: expected + 1,
      columnName: null
    })
  }
  return errors
}

// ---------------------------------------------------------------------------
// 增量记录读取器
// ---------------------------------------------------------------------------

/**
 * 创建一个增量记录读取器。
 *
 * ===== 分块读取最容易错在哪 =====
 *
 * 块边界不等于行边界。块结尾正好落在"一行还没写完"的位置时，
 * 如果把块边界当成行边界，就会把一行拆成两行——导入时多出一行、
 * 且那一行的列数不对。
 *
 * 所以这里的规则是：**只有真的遇到了记录终止符（或确认是文件末尾），
 * 才算一条记录读完**。块边界只是"输入暂时没了"，不是"记录结束了"。
 *
 * 用法：
 * ```ts
 * const reader = createCsvRecordReader({})
 * for await (const chunk of readChunks()) {
 *   for (const record of reader.push(chunk)) { ... }
 * }
 * for (const record of reader.flush()) { ... }
 * ```
 */
export function createCsvRecordReader(options: CsvParseOptions = {}): CsvRecordReader {
  const { delimiter } = normalizeOptions(options)
  let buffer = ''
  let pos = 0
  let line = 1

  const compact = (): void => {
    if (pos > 0) {
      buffer = buffer.slice(pos)
      pos = 0
    }
  }

  const scan = (final: boolean): readonly CsvRawRecord[] => {
    const out: CsvRawRecord[] = []
    for (;;) {
      if (pos >= buffer.length) break
      const result = readNextRecord(buffer, pos, line, delimiter, final)
      if (!final && result.exhausted) {
        // 还没读完：等下一块，别把块边界当行边界。
        break
      }
      out.push(result.record)
      pos = result.nextPos
      line = result.nextLine
      if (final && result.exhausted) break
    }
    compact()
    return out
  }

  return {
    push(text: string): readonly CsvRawRecord[] {
      buffer += text
      return scan(false)
    },
    flush(): readonly CsvRawRecord[] {
      return scan(true)
    }
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 解析 CSV 字节，得到列、样例行与错误。
 *
 * 这是一个**纯函数**：不读文件、不连数据库、不生成 SQL、不持有任何句柄。
 * 同样的字节与选项永远得到同样的结果。
 */
export function parseCsv(bytes: Uint8Array, options: CsvParseOptions = {}): CsvParseResult {
  const { delimiter, nullText, hasHeader, sampleRowLimit } = normalizeOptions(options)

  const errors: CsvError[] = []
  let errorCount = 0

  const pushError = (error: CsvError): void => {
    errorCount += 1
    if (errors.length < MAX_CSV_ERRORS) errors.push(error)
  }

  const decoded = decodeUtf8Strict(bytes)
  if (!decoded.ok) {
    pushError({
      code: 'invalid-encoding',
      message:
        `文件不是合法的 UTF-8（在第 ${decoded.line} 行、字节偏移 ${decoded.offset} 处发现非法字节）。` +
        '请把文件另存为 UTF-8 后重试；导入不会替换成乱码继续写入。',
      row: null,
      line: decoded.line,
      column: null,
      columnName: null
    })
    return {
      ok: false,
      columns: [],
      sampleRows: [],
      errors,
      errorCount,
      totalRows: 0,
      truncated: false,
      delimiter,
      nullText,
      hasHeader
    }
  }

  const text = decoded.text
  if (text.trim() === '') {
    pushError({
      code: 'empty-file',
      message: '文件是空的，没有可导入的表头或数据行。',
      row: null,
      line: 1,
      column: null,
      columnName: null
    })
    return {
      ok: false,
      columns: [],
      sampleRows: [],
      errors,
      errorCount,
      totalRows: 0,
      truncated: false,
      delimiter,
      nullText,
      hasHeader
    }
  }

  let columns: readonly CsvColumn[] = []
  let sampleRows: CsvRow[] = []
  let totalRows = 0
  let expectedColumnCount = 0
  let headerSeen = false
  let pos = 0
  let line = 1

  while (pos < text.length) {
    const scan = readNextRecord(text, pos, line, delimiter, true)
    pos = scan.nextPos
    line = scan.nextLine
    const record = scan.record
    const fields = record.fields

    const first = fields[0]
    const isBlankLine =
      record.error === null &&
      fields.length === 1 &&
      first !== undefined &&
      !first.quoted &&
      first.value === ''
    // 只有一列的表里，空行是合法的 NULL 行，不能当空白行吃掉。
    if (isBlankLine && expectedColumnCount !== 1) continue

    if (hasHeader && !headerSeen) {
      headerSeen = true
      if (record.error !== null) {
        pushError({
          code: record.error.code,
          message: `表头：${record.error.message}`,
          row: null,
          line: record.line,
          column: record.error.column,
          columnName: null
        })
      }
      expectedColumnCount = fields.length
      const derived = deriveCsvColumns(fields, record.line)
      columns = derived.columns
      for (const error of derived.errors) pushError(error)
      continue
    }

    if (!hasHeader && expectedColumnCount === 0) {
      expectedColumnCount = fields.length
      columns = fields.map((_field, index) => ({
        index: index + 1,
        name: `column_${index + 1}`,
        duplicate: false
      }))
    }

    totalRows += 1
    const rowNumber = totalRows

    if (record.error !== null) {
      pushError({
        code: record.error.code,
        message: record.error.message,
        row: rowNumber,
        line: record.line,
        column: record.error.column,
        columnName: columns[record.error.column - 1]?.name ?? null
      })
    }

    for (const error of validateCsvRecordColumns(fields, columns, rowNumber, record.line)) {
      pushError(error)
    }

    if (sampleRows.length < sampleRowLimit) {
      sampleRows.push({
        row: rowNumber,
        line: record.line,
        values: fields.map((field) => makeCell(field, nullText))
      })
    }
  }

  // 文件里只有空白行（或表头行本身是空行）时，上面一条数据行都没读到。
  // 这时**必须**报错，不能返回"0 列 0 行、ok=true"——
  // 那会让导入看起来成功，实际上什么都没导。
  if (hasHeader && !headerSeen) {
    pushError({
      code: 'empty-file',
      message: '文件里没有找到表头行（整个文件都是空白）。',
      row: null,
      line: 1,
      column: null,
      columnName: null
    })
  }

  return {
    ok: errors.length === 0,
    columns,
    sampleRows,
    errors,
    errorCount,
    totalRows,
    truncated: totalRows > sampleRows.length,
    delimiter,
    nullText,
    hasHeader
  }
}

/**
 * 生成导入预览。
 *
 * 与 `parseCsv` 是同一份契约——因为解析结果**本来就是有界的**
 * （只保留固定上限的样例行），所以"预览"和"解析"没有两套语义，
 * 也就不会出现"预览显示的列名和真正导入时用的列名不一样"这种坑。
 *
 * 真正的"完整导入"由 Task B 的 ImportManager 负责流式读取，
 * 它会复用同一套列名与 NULL 规则（见 `createCsvRecordReader`）。
 */
export function previewCsv(bytes: Uint8Array, options: CsvParseOptions = {}): CsvParseResult {
  return parseCsv(bytes, options)
}
