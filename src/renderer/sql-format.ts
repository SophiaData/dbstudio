/**
 * SQL 格式化与多语句切分——**纯函数**（不碰 DOM、不碰 IPC）。
 *
 * 为什么单独一个文件、且必须是纯函数：
 *   这两个能力是最容易出静默 bug 的地方（"格式化把字符串内容改了"、
 *   "切分把字符串里的分号当语句边界"），而静默 bug 最怕的是"看不出来"。
 *   把它们做成纯函数，就能用最便宜的 node 脚本直接断言"输出必须满足某性质"，
 *   不需要起 Electron、不需要 mock 任何东西。
 *
 * 两条贯穿全文件的**不变量**（也就是自检要证明的东西）：
 *
 *   I1. 格式化不得改变语义：`stripAllWhitespace(formatSql(s)) === stripAllWhitespace(s)`。
 *       注意是"去掉**所有**空白字符后比较"，不是每个字符串内部原样保留——
 *       所以格式化**只能在词与词之间**插入/调整空白，绝不能改动
 *       字符串字面量、注释、数字、标识符本身的内容。
 *
 *   I2. 切分不得在字符串/注释/引用标识符内部断开：
 *       判断"这里是不是语句结束"时必须先知道自己在不在引号/注释里。
 *
 * 实现策略：一个**字符级状态机**。因为两条不变量都要求"逐字符知道当前上下文"，
 * 而这正好是正则做不到的事（正则无法正确处理 `'It''s'` 这种双写转义，
 * 也无法可靠地跳过嵌套/跨行注释）。状态机里明确区分 5 种上下文：
 *   normal / string(') / quotedIdent(") / lineComment(--) / blockComment。
 */

import { isSqlKeyword } from './sql-keywords'

/** 去掉**所有**空白字符（含换行、制表）。用于"语义不变"自检。 */
export function stripAllWhitespace(sql: string): string {
  return sql.replace(/\s+/g, '')
}

/** 光标/切分都要用到的"当前位置处于什么上下文"。 */
type ScanState = 'normal' | 'string' | 'quotedIdent' | 'lineComment' | 'blockComment'

/**
 * 逐字符扫描，产出每个字符所属的上下文（长度与输入等长）。
 *
 * 为什么产出"每字符上下文"而不是只返回切分点：
 *   格式化与切分是两种用途，各自需要的边界信息不同，但都要"每个字符在不在引号里"。
 *   扫一遍、存一张表，两边复用，也保证两者对"引号/注释"的理解**绝对一致**
 *   （否则会出现"格式化认为在字符串里、切分认为在字符串外"这种鬼故事）。
 *
 * 转义规则（按 SQL 标准/常见方言）：
 *   - 单引号字符串内，`''` 表示一个字面单引号（两个单引号）；这是重点：
 *     遇到 `''` 必须**一并跳过两个字符**，否则会把字符串提前闭合。
 *   - 双引号标识符内，`""` 表示一个字面双引号，同上处理。
 *   - `--` 到行尾是行注释；`/* ... *\/` 是块注释（不处理嵌套，符合主流实现）。
 *   - 反斜杠转义（MySQL 风格 `\'`）不在本函数处理：本项目只面向 SQLite，
 *     SQLite 默认不启用反斜杠转义；若要支持别的方言，应在此集中加分支。
 */
export function scanContexts(sql: string): ScanState[] {
  const result: ScanState[] = new Array(sql.length)
  let state: ScanState = 'normal'
  let i = 0
  while (i < sql.length) {
    const ch = sql[i] as string
    const next = i + 1 < sql.length ? (sql[i + 1] as string) : ''

    if (state === 'normal') {
      if (ch === "'") {
        state = 'string'
        result[i] = 'string'
        i += 1
        continue
      }
      if (ch === '"') {
        state = 'quotedIdent'
        result[i] = 'quotedIdent'
        i += 1
        continue
      }
      if (ch === '-' && next === '-') {
        // 行注释：把两个 '-' 都标成 lineComment
        result[i] = 'lineComment'
        if (i + 1 < sql.length) result[i + 1] = 'lineComment'
        state = 'lineComment'
        i += 2
        continue
      }
      if (ch === '/' && next === '*') {
        result[i] = 'blockComment'
        if (i + 1 < sql.length) result[i + 1] = 'blockComment'
        state = 'blockComment'
        i += 2
        continue
      }
      result[i] = 'normal'
      i += 1
      continue
    }

    if (state === 'string') {
      result[i] = 'string'
      if (ch === "'") {
        if (next === "'") {
          // `''` 转义：两个字符都属于字符串
          if (i + 1 < sql.length) result[i + 1] = 'string'
          i += 2
          continue
        }
        state = 'normal'
        i += 1
        continue
      }
      i += 1
      continue
    }

    if (state === 'quotedIdent') {
      result[i] = 'quotedIdent'
      if (ch === '"') {
        if (next === '"') {
          if (i + 1 < sql.length) result[i + 1] = 'quotedIdent'
          i += 2
          continue
        }
        state = 'normal'
        i += 1
        continue
      }
      i += 1
      continue
    }

    if (state === 'lineComment') {
      result[i] = 'lineComment'
      if (ch === '\n') {
        state = 'normal'
        // 换行本身标记为 normal（它是行注释的终止符，不属于注释内容）
        result[i] = 'normal'
      }
      i += 1
      continue
    }

    // blockComment
    result[i] = 'blockComment'
    if (ch === '*' && next === '/') {
      if (i + 1 < sql.length) result[i + 1] = 'blockComment'
      state = 'normal'
      i += 2
      continue
    }
    i += 1
  }
  return result
}

/**
 * 多语句切分。
 *
 * 规则：
 *   - 只在 **normal 上下文**里、遇到 `;` 才视为语句边界。
 *   - 字符串里的 `;`（`SELECT 'a;b'`）、注释里的 `;`（`-- 注释;`）、
 *     双引号标识符里的 `;`（`SELECT "a;b"`）都**不切**。
 *   - 不保留分隔符；自动 trim；丢弃纯空白/纯注释产生的空片段。
 *   - 末尾没有分号的最后一段也算一条（`SELECT 1` → ["SELECT 1"]）。
 */
export function splitStatements(sql: string): string[] {
  const contexts = scanContexts(sql)
  const parts: string[] = []
  let start = 0
  for (let i = 0; i < sql.length; i += 1) {
    if (sql[i] === ';' && contexts[i] === 'normal') {
      pushIfMeaningful(parts, sql.slice(start, i))
      start = i + 1
    }
  }
  pushIfMeaningful(parts, sql.slice(start))
  return parts
}

/** 去掉注释后若仍无任何"可见字符"，就不算一条语句。 */
function pushIfMeaningful(out: string[], raw: string): void {
  const text = raw.trim()
  if (text.length === 0) return
  // 纯注释（例如末尾只剩 `-- done`）不算语句
  if (stripComments(text).trim().length === 0) return
  out.push(text)
}

/** 把注释替换为空（用于判断"是否只剩注释"）。保留字符串内容。 */
export function stripComments(sql: string): string {
  const contexts = scanContexts(sql)
  let out = ''
  for (let i = 0; i < sql.length; i += 1) {
    const ctx = contexts[i]
    if (ctx === 'lineComment' || ctx === 'blockComment') {
      // 行注释用换行保位（避免把两行拼一起改变词距），块注释用空格
      if (ctx === 'lineComment' && sql[i] === '\n') out += '\n'
      else out += ' '
      continue
    }
    out += sql[i]
  }
  return out
}

/** 主子句（格式化时"另起一行"的词）。顺序无关，仅作集合。 */
const CLAUSE_HEADS: ReadonlySet<string> = new Set([
  'select', 'from', 'where', 'group', 'having', 'order', 'limit', 'offset',
  'insert', 'values', 'update', 'set', 'delete', 'union', 'join',
  'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'create', 'alter',
  'drop', 'returning'
])

/** 不需要在其前面断行的"续接词"（避免 `ORDER BY` 被拆成两行）。 */
const NO_BREAK_BEFORE: ReadonlySet<string> = new Set(['with', 'by', 'all', 'distinct'])

/**
 * 把 SQL 格式化（关键字大写、主子句前换行 + 两空格缩进、逗号后换行）。
 *
 * ===== 核心保证：只动"词与词之间的空白" =====
 * 实现方式是**先切词、再拼装**：
 *   1. 用 `scanContexts` + 词法规则把输入切成 token 序列（每个 token 记原文与类别）；
 *      字符串/注释/引号标识符整体作为一个 token，原文**一字不改**。
 *   2. 只在 token 之间决定"放什么空白"（空格/换行/换行+缩进）。
 * 于是 I1 不变量自动成立：因为 token 的字符序列没变，只是拼接用的空白变了，
 * 而 `stripAllWhitespace` 抹掉的正好就是这些空白。
 *
 * ===== 为什么不做"缩进层级递增" =====
 * 真正的层级缩进需要认识括号/子查询嵌套，那已经是解析器范畴。
 * 本函数刻意保持"每行一个主子句、两空格固定缩进"，宁可朴素也不要错——
 * 一个把关卡写错的格式化器比不格式化更糟（用户会以为 SQL 结构坏掉）。
 */
export function formatSql(sql: string): string {
  const tokens = tokenize(sql)
  const out: string[] = []
  let lineHasContent = false
  let pendingCommaBreak = false
  // `(` 之后的下一个 token 不插前导空格（`COUNT(o.id)` 而不是 `COUNT( o.id)`）
  let inParenNoLeadingSpace = false

  const newlineIndent = (): void => {
    out.push('\n  ')
    lineHasContent = false
    pendingCommaBreak = false
  }

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const tok = tokens[idx] as Token
    const prev = idx > 0 ? (tokens[idx - 1] as Token) : null

    // 注释与字符串：原样输出，但保证与前一 token 之间有空格（除非行首/紧邻标点）
    if (tok.kind === 'lineComment') {
      if (lineHasContent) out.push(' ')
      out.push(tok.text)
      newlineIndent()
      continue
    }
    if (tok.kind === 'blockComment') {
      if (lineHasContent) out.push(' ')
      out.push(tok.text)
      out.push(' ')
      continue
    }

    const lower = tok.kind === 'word' ? tok.text.toLowerCase() : ''
    const isClauseHead = tok.kind === 'word' && CLAUSE_HEADS.has(lower)
    const suppressBreak = tok.kind === 'word' && NO_BREAK_BEFORE.has(lower)

    /**
     * ===== 关键：包围标点的空白必须"对称且中性" =====
     *
     * 这里必须保证 `formatSql` 的输出去掉空白后**与输入逐字符相同**（不变量 I1）。
     * 早先有个隐蔽 bug：遇到 `(` 或 `)` 时在它两边之一加了空格、另一边没加，
     * 于是 `count()` 变成 `count ()` 或 `( 1` —— 去掉空白后字符序列没变，但
     * 更糟的是把 `IN (1,2,3)` 的逗号换行后拼出 `(  1,\n  2 )` 之类不对称形态。
     * 现在统一规则：**括号类标点两侧都不加额外空格**，逗号只"贴左断右"，
     * 其余标点两侧留空格（与运算符一致）。这样任意标点组合的去空白结果都稳定。
     */
    if (tok.kind === 'punct') {
      if (tok.text === ',') {
        // 逗号：贴在前一 token 后（去掉我们刚加的"待定空格"），然后换行
        if (out.length > 0 && out[out.length - 1] === ' ') out.pop()
        out.push(',')
        newlineIndent()
        continue
      }
      if (tok.text === '.' || tok.text === ';') {
        // 点号/分号：紧贴前一个 token（`u.id`、`t;`），自身后不加空格；
        // 同时记下"上一个输出是点号"，供下一个 token 判断是否需要前置空格。
        if (out.length > 0 && out[out.length - 1] === ' ') out.pop()
        out.push(tok.text)
        lineHasContent = true
        pendingCommaBreak = false
        continue
      }
      if (tok.text === '(') {
        // 左括号紧贴前面的函数名/关键字（`COUNT(`、`IN(`），自身后不加空格
        if (out.length > 0 && out[out.length - 1] === ' ') out.pop()
        out.push('(')
        // 关键：把"括号内不插前导空格"记成一个标记，供下一个 token 判断。
        // 早先没这个标记，`COUNT(o.id)` 输出成 `COUNT( o.id)`——虽然去空白后
        // 序列不变（不变量 I1 仍成立），但观感上是错的，用户会以为 SQL 坏了。
        inParenNoLeadingSpace = true
        lineHasContent = true
        pendingCommaBreak = false
        continue
      }
      if (tok.text === ')') {
        // 右括号紧贴前面的内容（`COUNT(o.id)`），自身后不加空格
        if (out.length > 0 && out[out.length - 1] === ' ') out.pop()
        out.push(')')
        lineHasContent = true
        pendingCommaBreak = false
        continue
      }
      // 其它标点/运算符：两侧各一个空格（下一次迭代会再加左空格，这里只压右）
      if (lineHasContent) out.push(' ')
      out.push(tok.text)
      lineHasContent = true
      pendingCommaBreak = false
      continue
    }

    // 主子句前换行（但 `ORDER BY` 这种由 BY 续接的不换行；也不在已知续接词前换）
    if (isClauseHead && !suppressBreak && lineHasContent) {
      // 如果上一 token 已经是这些"介词类"，就不断开

      const prevLower = prev && prev.kind === 'word' ? prev.text.toLowerCase() : ''
      const joinWords = prevLower === 'left' || prevLower === 'right' || prevLower === 'inner'
        || prevLower === 'outer' || prevLower === 'full' || prevLower === 'cross'
      if (!joinWords) newlineIndent()
    }

    // 前一个输出若是点号结尾（`u.`）或刚输出了 `(`，不插空格——限定名/函数调用必须紧贴
    const prevEndsWithDot = out.length > 0 && (out[out.length - 1] as string).endsWith('.')
    if (lineHasContent && !prevEndsWithDot && !inParenNoLeadingSpace) {
      out.push(' ')
    }
    inParenNoLeadingSpace = false
    // 关键字/函数名大写（字符串、注释、引号标识符不动）
    if (tok.kind === 'word' && isSqlKeyword(tok.text)) {
      out.push(tok.text.toUpperCase())
    } else {
      out.push(tok.text)
    }
    lineHasContent = true
    pendingCommaBreak = false
  }

  // 收尾：去掉行尾多余空白，保证幂等
  return out
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim()
}

type TokenKind = 'word' | 'string' | 'quotedIdent' | 'number' | 'punct' | 'lineComment' | 'blockComment'

interface Token {
  readonly kind: TokenKind
  readonly text: string
}

/**
 * 词法切分（格式化专用）。与 scanContexts 共用同一套引号/注释理解。
 * 关键：字符串/注释/引号标识符作为**整体 token**，其内部绝不拆开、绝不改写。
 */
export function tokenize(sql: string): Token[] {
  const contexts = scanContexts(sql)
  const tokens: Token[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i] as string
    const ctx = contexts[i]

    if (ctx === 'lineComment') {
      let j = i
      while (j < sql.length && contexts[j] === 'lineComment' && sql[j] !== '\n') j += 1
      tokens.push({ kind: 'lineComment', text: sql.slice(i, j) })
      i = j
      continue
    }
    if (ctx === 'blockComment') {
      let j = i
      while (j < sql.length && contexts[j] === 'blockComment') j += 1
      tokens.push({ kind: 'blockComment', text: sql.slice(i, j) })
      i = j
      continue
    }
    if (ctx === 'string' || ctx === 'quotedIdent') {
      // 找到闭合引号（contexts 已经帮我们标好了边界）
      let j = i
      while (j < sql.length && contexts[j] === ctx) j += 1
      tokens.push({ kind: ctx === 'string' ? 'string' : 'quotedIdent', text: sql.slice(i, j) })
      i = j
      continue
    }

    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '.' && i + 1 < sql.length && /[0-9]/.test(sql[i + 1] as string))) {
      let j = i + 1
      while (j < sql.length && /[0-9.eE+\-]/.test(sql[j] as string)) {
        // 避免把 `1-2` 的减号吃进数字：只有在 e/E 之后才允许 +/- 号
        const c = sql[j] as string
        if ((c === '+' || c === '-') && !/[eE]/.test(sql[j - 1] as string)) break
        // 点号后面若紧跟非数字，说明这是 `数字.标识符` 的限定名形态（如 `2024.id`），
        // 点号应留给 punct 处理，不能吃进数字 token，否则格式化会在点号后插空格。
        if (c === '.' && !(j + 1 < sql.length && /[0-9]/.test(sql[j + 1] as string)) && !/[eE]/.test(sql[j - 1] as string)) break
        j += 1
      }
      tokens.push({ kind: 'number', text: sql.slice(i, j) })
      i = j
      continue
    }
    if (/[A-Za-z_\u0080-\uFFFF]/.test(ch)) {
      let j = i + 1
      while (j < sql.length && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[j] as string)) j += 1
      tokens.push({ kind: 'word', text: sql.slice(i, j) })
      i = j
      continue
    }
    /**
     * 标点/运算符：**最长匹配**合并多字符运算符。
     *
     * 为什么要合并：早先逐字符切分会把 `>=` 拆成 `>` 和 `=`，格式化输出变成
     * `u.created > = '2024-01-01'`（中间多一个空格），语义上仍是同一个比较，
     * 但显示成两个运算符是明显的错误观感。合并成单个 token 后，格式化的
     * "词与词之间加空格"就不会插进运算符内部。
     *
     * 注意：这里只做**词法级**的最长匹配，不区分运算符与括号——两者都当 punct，
     * 由输出阶段决定要不要贴边。
     */
    const multi = MULTI_CHAR_PUNCT.find((op) => sql.startsWith(op, i))
    if (multi !== undefined) {
      tokens.push({ kind: 'punct', text: multi })
      i += multi.length
      continue
    }
    tokens.push({ kind: 'punct', text: ch })
    i += 1
  }
  return tokens
}

/**
 * 需要合并的多字符运算符/标点，按长度降序（最长优先），保证 `>=` 不被 `>` 抢先匹配。
 * 只列 SQL 里常见的；不追求完备（格式化器不需要理解所有方言运算符）。
 */
const MULTI_CHAR_PUNCT: readonly string[] = [
  '<=>', '->>', '!~~*', '!~~',
  '<>', '!=', '<=', '>=', '||', '::', '->', '=>', ':=', '~~', '!~'
]
