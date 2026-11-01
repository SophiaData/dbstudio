/**
 * P2.3 CSV 导入的**解析与预览契约**测试（纯逻辑，不启 Electron、不连数据库）。
 *
 * ============================================================================
 * 这条测试防的是什么
 *
 * CSV 导入里最危险的失败模式不是"报错退出"，而是**看起来成功了但数据是错的**：
 *
 *   - BOM 没剥 → 第一列名变成 "﻿id"，映射到目标表时列对不上；
 *   - `""` 与空字段混为一谈 → 用户导入了 1000 行空字符串，表里却是 1000 个 NULL；
 *   - 引号里的换行算成新行 → 后面所有行的行号整体错位，用户按提示去改文件改错行；
 *   - 坏 UTF-8 被静默替换成 U+FFFD → 乱码数据写进表里，没人发现；
 *   - 预览把整份 CSV 读进内存 → 十万行的文件把 renderer 撑爆。
 *
 * 这些都靠"跑一次导入看结果"很难稳定复现，所以这里把解析器当成**纯函数**，
 * 在 Node 里直接喂字节、断言契约。
 *
 * 运行：node tests/e2e-import-validation.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')

// 用 vite 把 core 的纯逻辑打包出来在 Node 里跑。
// 为什么不用 tsx/ts-node：项目没有这两个依赖，而 vite 已经是既有工具
// （tests/e2e-sql-parameters-parser.mjs 用的是同一招），不引入新工具链。
const built = await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    write: false,
    target: 'node22',
    ssr: true,
    minify: false,
    lib: { entry: resolve(root, 'src/core/csv.ts'), formats: ['es'] }
  }
})

const outputs = Array.isArray(built)
  ? built.flatMap((result) => result.output ?? [])
  : (built.output ?? [])
const chunk = outputs.find((output) => output.type === 'chunk')
if (!chunk) throw new Error('Vite did not produce a CSV parser chunk')
const csv = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`)

/** 按 UTF-8 编码成字节。 */
const utf8 = (text) => Buffer.from(text, 'utf8')

/** 加上 UTF-8 BOM 的字节。 */
const withBom = (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])

/** 找出一条指定 code 的错误。 */
const errorOf = (result, code) => result.errors.find((error) => error.code === code)

/** 取列名数组。 */
const names = (result) => result.columns.map((column) => column.name)

test('UTF-8 BOM 被剥掉，首列名不带 BOM', () => {
  const result = csv.parseCsv(withBom('id,name\n1,张三\n'), {})
  assert.deepEqual(names(result), ['id', 'name'])
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
})

test('RFC4180 双引号转义：字段内的两个引号表示一个字面引号', () => {
  const result = csv.parseCsv(utf8('id,note\n1,"他说""你好"""\n'), {})
  assert.equal(csv.csvCellText(result.sampleRows[0].values[1]), '他说"你好"')
})

test('引号里的换行属于字段内容，且不会打乱后续行的行号', () => {
  const result = csv.parseCsv(utf8('id,note\n1,"第一行\n第二行"\n2,普通\n'), {})
  assert.equal(result.totalRows, 2)
  assert.equal(csv.csvCellText(result.sampleRows[0].values[1]), '第一行\n第二行')
  assert.equal(result.sampleRows[1].row, 2)
  // 逻辑行号不受引号内换行影响（还是第 2 条数据）；
  // 物理行号则如实反映"引号里的换行占掉了一行"——这正是两个行号都要给的原因。
  assert.equal(result.sampleRows[0].line, 2)
  assert.equal(result.sampleRows[1].line, 4)
})

test('逗号是默认分隔符，字段里的逗号必须加引号', () => {
  const result = csv.parseCsv(utf8('id,note\n1,"a,b"\n'), {})
  assert.deepEqual(names(result), ['id', 'note'])
  assert.equal(csv.csvCellText(result.sampleRows[0].values[1]), 'a,b')
})

test('重复列名被拒绝，并指出列名、列位置与所在行', () => {
  const result = csv.parseCsv(utf8('id,name,name\n1,a,b\n'), {})
  const error = errorOf(result, 'duplicate-column')
  assert.ok(error, '应当报告 duplicate-column')
  assert.equal(error.columnName, 'name')
  assert.equal(error.column, 3)
  assert.equal(error.line, 1)
  assert.equal(error.row, null)
  assert.equal(result.ok, false)
})

test('缺列的行被拒绝，并指出缺的是哪一列', () => {
  const result = csv.parseCsv(utf8('id,name,age\n1,张三\n'), {})
  const error = errorOf(result, 'missing-column')
  assert.ok(error, '应当报告 missing-column')
  assert.equal(error.row, 1)
  assert.equal(error.line, 2)
  assert.equal(error.column, 3)
  assert.equal(error.columnName, 'age')
})

test('多列的行被拒绝，并指出多出来的列位置', () => {
  const result = csv.parseCsv(utf8('id,name\n1,张三,多出来的\n'), {})
  const error = errorOf(result, 'extra-column')
  assert.ok(error, '应当报告 extra-column')
  assert.equal(error.row, 1)
  assert.equal(error.line, 2)
  assert.equal(error.column, 3)
  assert.equal(error.columnName, null)
})

test('默认 NULL 文本为空串：未加引号的空字段是 NULL，加引号的是空字符串', () => {
  const result = csv.parseCsv(utf8('a,b,c\n1,"",\n'), {})
  const cells = result.sampleRows[0].values
  assert.deepEqual(cells.map(csv.csvCellKind), ['text', 'text', 'null'])
  assert.equal(csv.csvCellText(cells[1]), '')
  assert.equal(csv.csvCellText(cells[2]), null)
})

test('自定义 NULL 文本：只有未加引号且文本完全相等的字段才是 NULL', () => {
  const result = csv.parseCsv(utf8('a,b,c\n\\N,"\\N",\n'), { nullText: '\\N' })
  const cells = result.sampleRows[0].values
  assert.equal(csv.csvCellKind(cells[0]), 'null')
  assert.equal(csv.csvCellText(cells[1]), '\\N')
  assert.equal(csv.csvCellKind(cells[2]), 'text')
  assert.equal(csv.csvCellText(cells[2]), '')
})

test('坏 UTF-8 直接失败，并给出出错行号', () => {
  const bytes = Buffer.concat([
    Buffer.from('id,name\n', 'utf8'),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('\n', 'utf8')
  ])
  const result = csv.parseCsv(bytes, {})
  assert.equal(result.ok, false)
  const error = errorOf(result, 'invalid-encoding')
  assert.ok(error, '应当报告 invalid-encoding')
  assert.equal(error.line, 2)
  // 编码不可信时不再给出列与样例行，避免给出误导性的预览
  assert.equal(result.columns.length, 0)
  assert.equal(result.sampleRows.length, 0)
})

test('样例行有固定上限，超出的行数只计数不进预览', () => {
  const body = Array.from({ length: 100 }, (_, index) => `${index},row`).join('\n')
  const result = csv.parseCsv(utf8(`id,v\n${body}\n`), { sampleRowLimit: 5 })
  assert.equal(result.sampleRows.length, 5)
  assert.equal(result.totalRows, 100)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.sampleRows.map((row) => row.row), [1, 2, 3, 4, 5])
})

test('样例行上限是硬约束：越界参数直接拒绝，而不是静默截断', () => {
  assert.throws(
    () => csv.parseCsv(utf8('id\n1\n'), { sampleRowLimit: csv.MAX_CSV_SAMPLE_ROWS + 1 }),
    /样例|上限/
  )
  assert.throws(() => csv.parseCsv(utf8('id\n1\n'), { sampleRowLimit: 1.5 }), /样例|上限/)
})

test('没有表头时按位置生成列名，首行算作数据行', () => {
  const result = csv.parseCsv(utf8('1,张三\n2,李四\n'), { hasHeader: false })
  assert.deepEqual(names(result), ['column_1', 'column_2'])
  assert.equal(result.totalRows, 2)
  assert.equal(result.sampleRows[0].row, 1)
})

test('引号未闭合、闭合引号后有多余字符都会被指出来', () => {
  const unterminated = csv.parseCsv(utf8('id,note\n1,"没关\n'), {})
  const first = errorOf(unterminated, 'unterminated-quote')
  assert.ok(first, '应当报告 unterminated-quote')
  assert.equal(first.row, 1)
  assert.equal(first.line, 2)

  const malformed = csv.parseCsv(utf8('id,note\n1,"abc"def\n'), {})
  const second = errorOf(malformed, 'malformed-quote')
  assert.ok(second, '应当报告 malformed-quote')
  assert.equal(second.row, 1)
  assert.equal(second.column, 2)
})

test('空白行被忽略，不会变成缺列错误', () => {
  const result = csv.parseCsv(utf8('id,name\n1,张三\n\n2,李四\n'), {})
  assert.equal(result.totalRows, 2)
  assert.deepEqual(result.errors, [])
})

test('支持自定义分隔符', () => {
  const result = csv.parseCsv(utf8('id;name\n1;张三\n'), { delimiter: ';' })
  assert.deepEqual(names(result), ['id', 'name'])
  assert.equal(csv.csvCellText(result.sampleRows[0].values[1]), '张三')
})

test('空文件明确报错，而不是静默"成功导入 0 行"', () => {
  const result = csv.parseCsv(utf8(''), {})
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'empty-file')
})

test('只有空白行的文件也算空文件，不返回"成功但 0 行"', () => {
  const result = csv.parseCsv(utf8('\n\n   \n'), {})
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'empty-file')
})

test('错误条数超过上限：errorCount 记总数，errors 只保留上限条数', () => {
  const errorTotal = csv.MAX_CSV_ERRORS + 5
  const body = Array.from({ length: errorTotal }, () => '1').join('\n')
  const result = csv.parseCsv(utf8(`a,b\n${body}\n`), {})
  assert.ok(errorTotal > csv.MAX_CSV_ERRORS, '测试输入必须真正越过错误上限')
  // 每一行都缺 b 列 → errorCount 记全部错误，errors 只保留最早的上限条数。
  assert.equal(result.ok, false)
  assert.equal(result.totalRows, errorTotal)
  assert.equal(result.errorCount, errorTotal)
  assert.equal(result.errors.length, csv.MAX_CSV_ERRORS)
  assert.deepEqual(
    result.errors.map((error) => error.code),
    Array.from({ length: csv.MAX_CSV_ERRORS }, () => 'missing-column')
  )
  assert.deepEqual(
    result.errors.map((error) => error.row),
    Array.from({ length: csv.MAX_CSV_ERRORS }, (_, index) => index + 1)
  )
})

test('坏编码时不再给出列与样例，避免给出误导性的预览', () => {
  const bytes = Buffer.concat([Buffer.from('id,name\n', 'utf8'), Buffer.from([0xc3, 0x28])])
  const result = csv.parseCsv(bytes, {})
  assert.equal(result.ok, false)
  assert.equal(errorOf(result, 'invalid-encoding') !== undefined, true)
  assert.equal(result.columns.length, 0)
  assert.equal(result.sampleRows.length, 0)
  assert.equal(result.totalRows, 0)
})

test('preview 与 parse 是同一份契约，列名/样例/错误一致', () => {
  const input = utf8('id,name,name\n1,张三\n')
  const parsed = csv.parseCsv(input)
  const preview = csv.previewCsv(input)
  assert.deepEqual(preview.columns, parsed.columns)
  assert.deepEqual(preview.sampleRows, parsed.sampleRows)
  assert.deepEqual(preview.errors, parsed.errors)
  assert.equal(preview.errorCount, parsed.errorCount)
  assert.equal(parsed.errorCount, 2)
  assert.deepEqual(
    preview.errors.map((error) => ({
      code: error.code,
      row: error.row,
      line: error.line,
      column: error.column,
      columnName: error.columnName
    })),
    [
      {
        code: 'duplicate-column',
        row: null,
        line: 1,
        column: 3,
        columnName: 'name'
      },
      {
        code: 'missing-column',
        row: 1,
        line: 2,
        column: 3,
        columnName: 'name'
      }
    ]
  )
  assert.equal(preview.ok, parsed.ok)
  assert.equal(preview.ok, false)
})

// ---------------------------------------------------------------------------
// 增量读取器（Task B 的流式导入要用）
// ---------------------------------------------------------------------------

/** 把一整份文本按固定长度切块，喂给增量读取器。 */
const readInChunks = (text, size) => {
  const reader = csv.createCsvRecordReader({})
  const records = []
  for (let index = 0; index < text.length; index += size) {
    records.push(...reader.push(text.slice(index, index + size)))
  }
  records.push(...reader.flush())
  return records
}

/** 在指定位置把文本拆成两次 push，锁定块尾 CR 的真实分块边界。 */
const readInTwoPushes = (text, splitAt) => {
  const reader = csv.createCsvRecordReader({})
  return [
    ...reader.push(text.slice(0, splitAt)),
    ...reader.push(text.slice(splitAt)),
    ...reader.flush()
  ]
}

/** 只保留记录定位与字段内容，便于跨分块比较。 */
const recordShape = (record) => ({
  line: record.line,
  fields: record.fields.map((field) => ({ value: field.value, quoted: field.quoted })),
  error: record.error
})

test('增量读取器在任意分块下都产出同样的记录（块边界不等于行边界）', () => {
  const text = 'id,note\n1,"a,b"\n2,"line1\nline2"\n3,普通\n'
  const reference = readInChunks(text, text.length)
  // 1 条表头 + 3 条数据
  assert.equal(reference.length, 4)
  for (let size = 1; size <= text.length; size += 1) {
    const records = readInChunks(text, size)
    assert.equal(records.length, 4, `分块 ${size} 字节时记录数不对`)
    assert.deepEqual(
      records.map((record) => record.fields.map((field) => field.value)),
      [
        ['id', 'note'],
        ['1', 'a,b'],
        ['2', 'line1\nline2'],
        ['3', '普通']
      ],
      `分块 ${size} 字节时字段内容不对`
    )
  }
})

test('CRLF 被拆成两次 push 时不产生假记录：覆盖引号内外、空行与 EOF 独立 CR', () => {
  const cases = [
    {
      name: '引号外的记录终止 CRLF',
      text: 'a,b\r\nc,d\r\n',
      splitAt: 4,
      expected: [
        { line: 1, fields: [{ value: 'a', quoted: false }, { value: 'b', quoted: false }], error: null },
        { line: 2, fields: [{ value: 'c', quoted: false }, { value: 'd', quoted: false }], error: null }
      ]
    },
    {
      name: '引号内的字段内容 CRLF',
      text: 'a,b\r\n1,"x\r\ny"\r\n2,z\r\n',
      splitAt: 10,
      expected: [
        { line: 1, fields: [{ value: 'a', quoted: false }, { value: 'b', quoted: false }], error: null },
        { line: 2, fields: [{ value: '1', quoted: false }, { value: 'x\r\ny', quoted: true }], error: null },
        { line: 4, fields: [{ value: '2', quoted: false }, { value: 'z', quoted: false }], error: null }
      ]
    },
    {
      name: '空行的 CRLF',
      text: 'a,b\r\n\r\nc,d\r\n',
      splitAt: 6,
      expected: [
        { line: 1, fields: [{ value: 'a', quoted: false }, { value: 'b', quoted: false }], error: null },
        { line: 2, fields: [{ value: '', quoted: false }], error: null },
        { line: 3, fields: [{ value: 'c', quoted: false }, { value: 'd', quoted: false }], error: null }
      ]
    },
    {
      name: 'EOF 前的独立 CR',
      text: 'a,b\r\nc,d\r',
      splitAt: 8,
      expected: [
        { line: 1, fields: [{ value: 'a', quoted: false }, { value: 'b', quoted: false }], error: null },
        { line: 2, fields: [{ value: 'c', quoted: false }, { value: 'd', quoted: false }], error: null }
      ]
    }
  ]

  for (const item of cases) {
    const records = readInTwoPushes(item.text, item.splitAt)
    assert.deepEqual(records.map(recordShape), item.expected, item.name)
  }
})

test('增量读取器在 CRLF 文本的任意分块下都产出同样的记录（块尾 CR 不得前瞻失败当两次换行）', () => {
  // 缺陷原型：块尾正好落在 CR（ImportManager 按 64KiB 切片时真实存在），
  // 旧的 lookahead 看不到下一块的 LF，会把一个 CRLF 当两次换行——
  // 多列时产出假空行且后续行号偏移，单列时直接产出假 NULL 行。
  const text = 'id,note\r\n1,"a,b"\r\n2,"l1\r\nl2"\r\n3,ok\r\n'
  const whole = readInChunks(text, text.length)
  for (let size = 1; size <= text.length; size += 1) {
    const records = readInChunks(text, size)
    assert.deepEqual(
      records.map((record) => ({
        line: record.line,
        fields: record.fields.map((field) => field.value)
      })),
      whole.map((record) => ({
        line: record.line,
        fields: record.fields.map((field) => field.value)
      })),
      `分块 ${size} 字节时记录与整份文本不一致`
    )
  }
})

test('64KiB 边界落在 CRLF 之间：多列无假空行、行号不偏移', () => {
  const chunk = 64 * 1024
  const header = 'id,name\r\n'
  const pad = chunk - header.length - 2 - 1 // 让第一条数据行的 CR 正好落在块尾
  const text = header + '1,' + 'x'.repeat(pad) + '\r\n' + '2,b\r\n' + '3,c\r\n'
  assert.equal(text[chunk - 1], '\r', '测试构造必须让块尾正好是 CR')
  assert.equal(text[chunk], '\n', '测试构造必须让下一块以 LF 开头')
  const records = readInChunks(text, chunk)
  const isBlank = (record) =>
    record.error === null &&
    record.fields.length === 1 &&
    !record.fields[0].quoted &&
    record.fields[0].value === ''
  assert.equal(records.filter(isBlank).length, 0, '不该有假空行记录')
  assert.equal(records.length, 4)
  assert.deepEqual(records.map((record) => record.line), [1, 2, 3, 4])
})

test('64KiB 边界落在 CRLF 之间：单列不产生假 NULL 行，行数与预览一致', () => {
  const chunk = 64 * 1024
  const header = 'v\r\n'
  const pad = chunk - header.length - 1
  const text = header + 'a'.repeat(pad) + '\r\n' + 'b\r\n' + 'c\r\n'
  assert.equal(text[chunk - 1], '\r', '测试构造必须让块尾正好是 CR')
  const records = readInChunks(text, chunk)
  // 单列表里"未加引号的空行"是合法 NULL 数据行（ImportManager 不会跳），
  // 所以跨块 CRLF 多产出的那条空记录会直接变成假 NULL 行写进表。
  assert.equal(records.length - 1, csv.parseCsv(Buffer.from(text, 'utf8'), {}).totalRows)
})

test('文件末尾的孤立 CR 跨块时只终止一次记录', () => {
  const reader = csv.createCsvRecordReader({})
  assert.deepEqual([...reader.push('a\rb'), ...reader.push('\r'), ...reader.flush()].map((r) => r.fields[0].value), ['a', 'b'])
})

test('增量读取器与预览路径给出同样的列与 NULL 判定', () => {
  const text = 'id,name\n1,""\n2,\n'
  const records = readInChunks(text, 3)
  const header = records[0]
  const derived = csv.deriveCsvColumns(header.fields, header.line)
  assert.deepEqual(
    derived.columns.map((column) => column.name),
    ['id', 'name']
  )
  assert.deepEqual(derived.errors, [])

  const quotedEmpty = records[1].fields[1]
  const unquotedEmpty = records[2].fields[1]
  assert.equal(csv.csvCellKind(csv.csvCellFromRaw(quotedEmpty, '')), 'text')
  assert.equal(csv.csvCellText(csv.csvCellFromRaw(quotedEmpty, '')), '')
  assert.equal(csv.csvCellKind(csv.csvCellFromRaw(unquotedEmpty, '')), 'null')
  assert.equal(csv.csvCellText(csv.csvCellFromRaw(unquotedEmpty, '')), null)
})

test('增量读取器在文件末尾报告未闭合引号，并带上行号', () => {
  const reader = csv.createCsvRecordReader({})
  // 第二条记录还没读完（非文件末尾时不能当成一条完整记录）
  const partial = reader.push('id,note\n1,"没关\n')
  assert.equal(partial.length, 1)
  const records = reader.flush()
  assert.equal(records.length, 1)
  const last = records[0]
  assert.ok(last.error, '应当报告引号错误')
  assert.equal(last.error.code, 'unterminated-quote')
  assert.equal(last.line, 2)
})

test('列数校验给出缺列/多列错误，并复用预览路径的判定', () => {
  const derived = csv.deriveCsvColumns(
    [
      { value: 'id', quoted: false },
      { value: 'name', quoted: false }
    ],
    1
  )
  const missing = csv.validateCsvRecordColumns(
    [{ value: '1', quoted: false }],
    derived.columns,
    1,
    2
  )
  assert.equal(missing.length, 1)
  assert.equal(missing[0].code, 'missing-column')
  assert.equal(missing[0].columnName, 'name')
  assert.equal(missing[0].row, 1)

  const extra = csv.validateCsvRecordColumns(
    [
      { value: '1', quoted: false },
      { value: 'a', quoted: false },
      { value: 'b', quoted: false }
    ],
    derived.columns,
    3,
    4
  )
  assert.equal(extra.length, 1)
  assert.equal(extra[0].code, 'extra-column')
  assert.equal(extra[0].column, 3)
})
