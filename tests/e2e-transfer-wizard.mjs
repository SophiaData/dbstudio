/**
 * P2.2 导出向导的**契约测试**（纯逻辑，不启 Electron）。
 *
 * ============================================================================
 * 这条测试防的是什么
 * ============================================================================
 *
 * 向导是"用户输入 → 跨进程请求"的那道转换。这道转换里的每个判断都对应一个
 * 真实的坑：
 *
 *   - 批大小写成 `parseInt('12abc')` → 12：用户输入错了却**看起来生效**；
 *   - 相对路径交给主进程 → 相对于主进程工作目录解析，文件落到用户找不到的地方；
 *   - 自由 SQL + SQL INSERT → 凭空编一个表名，插到错的表上；
 *   - 给 sql-insert 传 nullText → 主进程显式报错（不是默默忽略）；
 *   - 筛选结果与原始结果集导出的**不是同一批数据** → 用户以为导了整表。
 *
 * 这些都是"不报错但结果错了"的类型，靠点界面很难稳定复现，
 * 所以把它们做成纯函数、在 Node 里直接单测。
 *
 * 运行：node tests/e2e-transfer-wizard.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-transfer-wizard-'))

/**
 * 用 vite 把 renderer 的纯逻辑打包出来在 Node 里跑。
 *
 * 为什么不用 tsx/ts-node：项目没有这两个依赖，而 vite 已经是 devDependencies
 * 里的既有工具（`tests/e2e-sql-script-parser.mjs` 用的是同一招），
 * 不引入新的工具链。
 */
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir,
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    ssr: true,
    rollupOptions: {
      external: [/^node:/],
      output: { entryFileNames: 'probe.cjs' }
    },
    lib: { entry: resolve(root, 'src/renderer/transfer-dialog.ts'), formats: ['cjs'] }
  }
})

const probe = await import(`file://${join(outDir, 'probe.cjs')}`)
const {
  validateTransferForm,
  wizardScopesForTab,
  wizardSourceFor,
  wizardSourceForTab,
  isAbsolutePath,
  directoryOfPath,
  pickDefaultFileName,
  suggestDestination,
  formatBytes,
  describeProgress,
  describeResult,
  describeConsistency,
  describeTransferStatus,
  isTerminalStatus,
  formatSupportsHeaderRow,
  describeHeaderRowOption,
  formatSupportsNullText,
  formatSupportsJsonIndent,
  formatRequiresTableSource,
  sourceSupportsInsert,
  describeIncompatibleSource,
  describeMissingParameters,
  inlineSqlParameters,
  sqlParameterToLiteral,
  renderPathHint,
  shouldBlockWizardClose,
  WIZARD_FORMATS
} = probe

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const TABLE_SOURCE = { kind: 'table', nodeId: 'connection:c1|table:users', name: 'users' }
const SQL_SOURCE = {
  kind: 'sql',
  connectionNodeId: 'connection:c1',
  sql: 'SELECT id FROM users',
  name: 'SELECT id FROM users'
}

/** 造一份合法的表单值。 */
const form = (overrides = {}) => ({
  format: 'csv',
  destinationPath: '/tmp/out.csv',
  batchSize: '200',
  includeHeader: true,
  nullText: '',
  newline: '\r\n',
  jsonIndent: '2',
  ...overrides
})

try {
  console.log('\n[1] 合法表单 → 正确的跨进程请求')
  {
    const result = validateTransferForm(TABLE_SOURCE, form())
    check('校验通过', result.ok === true, JSON.stringify(result))
    if (result.ok) {
      check('格式正确', result.request.format === 'csv')
      check('目标路径原样传递', result.request.destinationPath === '/tmp/out.csv')
      check('来源是 nodeId', result.request.source.nodeId === 'connection:c1|table:users')
      check('表来源不带 sql', result.request.source.sql === undefined)
      check('批大小转成数字', result.request.options.batchSize === 200)
      check('表头默认开', result.request.options.includeHeader === true)
      check('行分隔符原样', result.request.options.newline === '\r\n')
    }
  }

  console.log('\n[2] 空批大小 → 用默认值（不是 0）')
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ batchSize: '' }))
    check('校验通过', result.ok === true)
    if (result.ok) {
      check('批大小是默认值 200', result.request.options.batchSize === 200, String(result.request.options.batchSize))
    }
  }

  console.log('\n[3] 批大小必须是合法整数（"12abc" 不能变成 12）')
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ batchSize: '12abc' }))
    check('★ 拒绝 "12abc"', result.ok === false)
    if (!result.ok) {
      check('错误落在 batchSize 字段', result.errors.some((e) => e.field === 'batchSize'), JSON.stringify(result.errors))
    }
  }
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ batchSize: '0' }))
    check('★ 拒绝 0（下限是 1）', result.ok === false)
  }
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ batchSize: '1001' }))
    check('★ 拒绝 1001（上限是 1000）', result.ok === false)
  }
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ batchSize: '1' }))
    check('接受 1（边界值）', result.ok === true)
  }

  console.log('\n[4] 目标路径必须绝对')
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ destinationPath: 'out.csv' }))
    check('★ 拒绝相对路径', result.ok === false)
    if (!result.ok) {
      check(
        '错误落在 destinationPath 字段',
        result.errors.some((e) => e.field === 'destinationPath'),
        JSON.stringify(result.errors)
      )
    }
  }
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ destinationPath: '   ' }))
    check('★ 拒绝空白路径', result.ok === false)
  }
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ destinationPath: 'C:\\tmp\\out.csv' }))
    check('接受 Windows 绝对路径', result.ok === true)
  }

  console.log('\n[5] SQL INSERT 需要表来源')
  {
    const result = validateTransferForm(SQL_SOURCE, form({ format: 'sql-insert' }))
    check('★ 自由 SQL + SQL INSERT 被拒绝', result.ok === false)
    if (!result.ok) {
      check(
        '错误落在 source 字段',
        result.errors.some((e) => e.field === 'source'),
        JSON.stringify(result.errors)
      )
    }
  }
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ format: 'sql-insert' }))
    check('表来源 + SQL INSERT 通过', result.ok === true)
    if (result.ok) {
      check(
        '★ 不传 nullText（主进程会对 sql-insert+nullText 显式报错）',
        result.request.options.nullText === undefined,
        JSON.stringify(result.request.options)
      )
    }
  }

  console.log('\n[6] 给 sql-insert 填 NULL 文本要当场报错')
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ format: 'sql-insert', nullText: 'NULL' }))
    check('★ 拒绝 nullText', result.ok === false)
    if (!result.ok) {
      check(
        '错误落在 nullText 字段',
        result.errors.some((e) => e.field === 'nullText'),
        JSON.stringify(result.errors)
      )
    }
  }

  console.log('\n[7] JSON 缩进只在 json 格式下校验')
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ format: 'json', jsonIndent: '99' }))
    check('★ json 格式拒绝缩进 99', result.ok === false)
  }
  {
    // csv 不看缩进，写了非法值也不该报错——那个控件是禁用的。
    const result = validateTransferForm(TABLE_SOURCE, form({ format: 'csv', jsonIndent: '99' }))
    check('csv 不校验 JSON 缩进', result.ok === true)
  }
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ format: 'json', jsonIndent: 'abc' }))
    check('★ json 拒绝非数字缩进', result.ok === false)
  }

  console.log('\n[8] 未知格式被拒绝')
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ format: 'xlsx' }))
    check('★ 拒绝未知格式', result.ok === false)
    if (!result.ok) {
      check(
        '错误落在 format 字段',
        result.errors.some((e) => e.field === 'format'),
        JSON.stringify(result.errors)
      )
    }
  }
  check('四种格式都受支持', WIZARD_FORMATS.length === 4, JSON.stringify(WIZARD_FORMATS))

  console.log('\n[9] 行分隔符只接受 CRLF / LF')
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ newline: '\r' }))
    check('★ 拒绝裸 CR', result.ok === false)
  }
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ newline: '\n' }))
    check('接受 LF', result.ok === true)
  }

  console.log('\n[10] 格式能力矩阵')
  /**
   * ★ 这里断言的是「**表头行**」而不是「includeHeader 参数」。
   *
   * 早先的向导对 csv/jsonl/json 一律返回 true，理由是 core/transfer.ts
   * 的契约注释写着「CSV / JSONL / JSON 是否写表头」。
   * 但那条注释说的是**参数形状**（这三个格式都接受 includeHeader），
   * 不是**实际效果**：
   *   - CSV   —— includeHeader 决定有没有第一行列名；
   *   - JSONL —— 没有表头行，列名通过每行的**对象键**表达，永远都在；
   *   - JSON  —— 同上。
   *
   * 所以对 JSONL / JSON 那个复选框是个**假开关**：取消勾选，文件一模一样。
   * 实测确认过（导出的两份 jsonl 字节相同）。
   */
  check('csv 有表头行', formatSupportsHeaderRow('csv') === true)
  check('★ jsonl 没有表头行（取消勾选也没用）', formatSupportsHeaderRow('jsonl') === false)
  check('★ json 没有表头行（取消勾选也没用）', formatSupportsHeaderRow('json') === false)
  check('sql-insert 无表头', formatSupportsHeaderRow('sql-insert') === false)
  check(
    '★ 表头行说明解释了为什么 jsonl 不能取消',
    describeHeaderRowOption('jsonl').includes('始终包含列名'),
    describeHeaderRowOption('jsonl')
  )
  check('sql-insert 不支持 nullText', formatSupportsNullText('sql-insert') === false)
  check('csv 支持 nullText', formatSupportsNullText('csv') === true)
  check('只有 json 支持缩进', formatSupportsJsonIndent('json') === true && formatSupportsJsonIndent('csv') === false)
  check('只有 sql-insert 需要表来源', formatRequiresTableSource('sql-insert') === true && formatRequiresTableSource('csv') === false)

  console.log('\n[10b] 运行中的任务禁止关闭向导')
  check('空闲向导允许关闭', shouldBlockWizardClose(null) === false)
  check('运行中任务阻止关闭', shouldBlockWizardClose('t1') === true)
  check('启动中的任务阻止关闭', shouldBlockWizardClose(null, true) === true)

  console.log('\n[11] 绝对路径判定')
  check('/tmp/x 是绝对路径', isAbsolutePath('/tmp/x') === true)
  check('x 是相对路径', isAbsolutePath('x') === false)
  check('./x 是相对路径', isAbsolutePath('./x') === false)
  check('C:\\x 是绝对路径', isAbsolutePath('C:\\x') === true)
  check('c:/x 是绝对路径', isAbsolutePath('c:/x') === true)
  check('\\\\server\\share 是绝对路径', isAbsolutePath('\\\\server\\share') === true)
  check('空串不是绝对路径', isAbsolutePath('') === false)

  console.log('\n[12] 默认文件名与目录推断')
  {
    const name = pickDefaultFileName('csv', 'dbstudio-export', new Date('2026-10-29T01:02:03.000Z'))
    check('CSV 默认文件名带时间戳与扩展名', /^dbstudio-export-.*\.csv$/.test(name), name)
  }
  {
    const name = pickDefaultFileName('sql-insert', 'dbstudio-export', new Date('2026-10-29T01:02:03.000Z'))
    check('SQL INSERT 默认扩展名是 .sql', name.endsWith('.sql'), name)
  }
  check('目录推断（POSIX）', directoryOfPath('/tmp/out.csv') === '/tmp')
  check('目录推断（Windows）', directoryOfPath('C:\\tmp\\out.csv') === 'C:\\tmp')
  {
    const suggested = suggestDestination('/tmp/existing.csv', 'json', new Date('2026-10-29T01:02:03.000Z'))
    check('★ 建议路径保留目录', suggested.startsWith('/tmp/'), suggested)
    check('★ 建议路径换扩展名', suggested.endsWith('.json'), suggested)
  }
  {
    const suggested = suggestDestination('', 'csv', new Date('2026-10-29T01:02:03.000Z'))
    check('空路径时给出纯文件名', !suggested.includes('/'), suggested)
  }

  console.log('\n[13] 字节数格式化')
  check('0 B', formatBytes(0) === '0 B')
  check('512 B', formatBytes(512) === '512 B')
  check('1024 → KiB', formatBytes(1024) === '1.0 KiB')
  check('1 MiB', formatBytes(1024 * 1024) === '1.0 MiB')
  check('负数显示占位', formatBytes(-1) === '—')
  check('NaN 显示占位', formatBytes(Number.NaN) === '—')

  console.log('\n[14] 进度与结果文案')
  {
    const progress = {
      taskId: 't1',
      status: 'running',
      rowsRead: 1200,
      bytesWritten: 4096,
      batches: 6,
      destinationPath: '/tmp/out.csv',
      consistency: 'live-paged'
    }
    const text = describeProgress(progress, 1000)
    check('进度含状态', text.includes('导出中'), text)
    check('进度含行数', text.includes('1,200'), text)
    check('进度含字节数', text.includes('4.0 KiB'), text)
    check('进度含批次数', text.includes('6 批'), text)
    check('进度含速度', text.includes('/s'), text)
  }
  check('一致性声明明说不是快照', describeConsistency('live-paged').includes('不是数据库快照'))
  check('状态标签', describeTransferStatus('committing') === '正在写入最终文件')
  check('终态判定', isTerminalStatus('completed') && isTerminalStatus('failed') && isTerminalStatus('cancelled'))
  check('非终态判定', isTerminalStatus('running') === false && isTerminalStatus('committing') === false)
  {
    const result = {
      taskId: 't1',
      status: 'failed',
      rowsRead: 10,
      bytesWritten: 0,
      destinationPath: '/tmp/out.csv',
      message: '源表被截断'
    }
    const text = describeResult(result)
    check('★ 失败文案说明目标文件保持原样', text.includes('保持原样'), text)
    check('★ 失败文案带出原因', text.includes('源表被截断'), text)
  }
  {
    const result = {
      taskId: 't1',
      status: 'cancelled',
      rowsRead: 10,
      bytesWritten: 0,
      destinationPath: '/tmp/out.csv'
    }
    const text = describeResult(result)
    check('★ 取消文案说明目标文件保持原样', text.includes('保持原样'), text)
  }
  {
    const result = {
      taskId: 't1',
      status: 'completed',
      rowsRead: 100,
      bytesWritten: 2048,
      destinationPath: '/tmp/out.csv',
      committedPath: '/tmp/out.csv'
    }
    const text = describeResult(result)
    check('★ 完成文案含行数与目标路径', text.includes('100') && text.includes('/tmp/out.csv'), text)
  }

  console.log('\n[15] 导出范围：筛选结果 vs 原始结果集')
  {
    const tableTab = {
      source: { kind: 'table', ref: { id: 'connection:c1|table:users', name: 'users' } },
      baseSource: { kind: 'table', ref: { id: 'connection:c1|table:users', name: 'users' } },
      filterText: ''
    }
    const scopes = wizardScopesForTab(tableTab)
    check('没有筛选时只有一个范围', scopes.length === 1, JSON.stringify(scopes))
    check('范围来源是表', scopes[0].source.kind === 'table')
  }
  {
    const filteredTab = {
      source: { kind: 'sql', nodeId: 'connection:c1', sql: 'SELECT * FROM users WHERE id > 1' },
      baseSource: { kind: 'table', ref: { id: 'connection:c1|table:users', name: 'users' } },
      filterText: 'id > 1'
    }
    const scopes = wizardScopesForTab(filteredTab)
    check('★ 筛选后有两个范围', scopes.length === 2, JSON.stringify(scopes))
    check('★ 第一个范围是筛选结果', scopes[0].id === 'current' && scopes[0].source.kind === 'sql')
    check('★ 第二个范围是原始结果集', scopes[1].id === 'base' && scopes[1].source.kind === 'table')
    check(
      '★ 两个范围指向不同的来源（不是同一批数据）',
      scopes[0].source.kind !== scopes[1].source.kind ||
        JSON.stringify(scopes[0].source) !== JSON.stringify(scopes[1].source)
    )
  }
  {
    const source = wizardSourceFor({ kind: 'sql', nodeId: 'connection:c1', sql: 'SELECT 1' })
    check('SQL 来源保留 nodeId 与 sql', source.kind === 'sql' && source.connectionNodeId === 'connection:c1')
  }
  {
    const source = wizardSourceForTab({
      source: { kind: 'sql', nodeId: 'connection:c1', sql: 'SELECT 1' },
      filterText: 'x = 1'
    })
    check('★ 旧签名在名字上标出"筛选结果"', source.name.includes('筛选结果'), source.name)
  }

  console.log('\n[16] 校验失败时错误列表非空')
  {
    const result = validateTransferForm(TABLE_SOURCE, form({ destinationPath: '', batchSize: 'x', format: 'nope' }))
    check('三个问题都被报出来', result.ok === false && result.errors.length === 3, JSON.stringify(result.errors))
  }

  console.log('\n[17] 视图不能生成 INSERT（向导层就拦，不等主进程报错）')
  {
    const VIEW_SOURCE = { kind: 'view', nodeId: 'connection:c1|view:v_users', name: 'v_users' }
    check('★ 视图不支持 INSERT', sourceSupportsInsert(VIEW_SOURCE) === false)
    check('★ 表支持 INSERT', sourceSupportsInsert(TABLE_SOURCE) === true)
    const issue = describeIncompatibleSource(VIEW_SOURCE, 'sql-insert')
    check('★ 给出拒绝理由', issue !== null && issue.includes('视图'), String(issue))
    check('★ 理由提到"没有可插入的落点"', issue !== null && issue.includes('落点'), String(issue))
    // ★ 视图用其它格式是允许的。
    check('★ 视图导出 CSV 允许', describeIncompatibleSource(VIEW_SOURCE, 'csv') === null)
    // ★ 校验层同样拦得住。
    const result = validateTransferForm(VIEW_SOURCE, form({ format: 'sql-insert' }))
    check('★ 校验拒绝 视图 + SQL INSERT', result.ok === false)
    if (!result.ok) {
      check('★ 错误落在 source 字段', result.errors.some((e) => e.field === 'source'), JSON.stringify(result.errors))
    }
  }
  {
    // ★ 自由 SQL 与视图的拒绝理由必须不同，否则用户不知道该怎么改。
    const viewIssue = describeIncompatibleSource(
      { kind: 'view', nodeId: 'connection:c1|view:v', name: 'v' },
      'sql-insert'
    )
    const sqlIssue = describeIncompatibleSource(SQL_SOURCE, 'sql-insert')
    check('★ 视图与自由 SQL 的理由不同', viewIssue !== sqlIssue, `${viewIssue} vs ${sqlIssue}`)
  }

  console.log('\n[18] 参数化 SQL：参数必须跟着来源走（缺参数导出必然失败）')
  {
    // ★ 这是实测发现的缺陷：向导把来源降级成 { nodeId, sql }，
    // 丢掉了 parameters，于是导出带 :id 的查询时报"缺少参数 id"，
    // 而界面上显示的来源还是那句带占位符的 SQL。
    const parameterized = {
      kind: 'sql',
      connectionNodeId: 'connection:c1',
      sql: 'SELECT id FROM users WHERE id = :id',
      name: 'SELECT id FROM users WHERE id = :id',
      parameters: [{ name: 'id', value: 1 }],
      dialect: 'sqlite'
    }
    const result = validateTransferForm(parameterized, form())
    check('★ 带参数且参数齐全时校验通过', result.ok === true, JSON.stringify(result))
    if (result.ok) {
      check(
        '★ 参数已被内联进 SQL（不再有占位符）',
        !result.request.source.sql.includes(':id'),
        result.request.source.sql
      )
      check(
        '★ 内联结果是合法 SQL 文本',
        result.request.source.sql === 'SELECT id FROM users WHERE id = 1',
        result.request.source.sql
      )
    }
  }
  {
    // ★ 缺参数必须当场报错，而不是启动一个注定失败的任务。
    const missing = {
      kind: 'sql',
      connectionNodeId: 'connection:c1',
      sql: 'SELECT id FROM users WHERE id = :id',
      name: 'x',
      dialect: 'sqlite'
    }
    const issue = describeMissingParameters(missing.sql, undefined, 'sqlite')
    check('★ 报出缺少参数', issue !== null && issue.includes('id'), String(issue))
    const result = validateTransferForm(missing, form())
    check('★ 校验拒绝缺参数的查询', result.ok === false)
    if (!result.ok) {
      check('★ 错误落在 parameters 字段', result.errors.some((e) => e.field === 'parameters'), JSON.stringify(result.errors))
    }
  }
  {
    // ★ 多余参数同样要拦（驱动会拒绝多余绑定）。
    const extra = {
      kind: 'sql',
      connectionNodeId: 'connection:c1',
      sql: 'SELECT 1',
      name: 'x',
      parameters: [{ name: 'unused', value: 1 }],
      dialect: 'sqlite'
    }
    const issue = describeMissingParameters(extra.sql, extra.parameters, 'sqlite')
    check('★ 报出多余参数', issue !== null && issue.includes('unused'), String(issue))
  }

  console.log('\n[19] 参数内联：转义必须按方言来')
  {
    check(
      'SQLite 字符串用普通引号',
      sqlParameterToLiteral('abc', 'sqlite') === "'abc'",
      sqlParameterToLiteral('abc', 'sqlite')
    )
    check(
      '★ SQLite 字符串里的单引号翻倍',
      sqlParameterToLiteral("O'Brien", 'sqlite') === "'O''Brien'",
      sqlParameterToLiteral("O'Brien", 'sqlite')
    )
    check(
      '★ PG 用 E\'...\' 并转义反斜杠',
      sqlParameterToLiteral('a\\b', 'postgresql') === "E'a\\\\b'",
      sqlParameterToLiteral('a\\b', 'postgresql')
    )
    check('★ PG 布尔写 TRUE/FALSE', sqlParameterToLiteral(true, 'postgresql') === 'TRUE')
    check('★ SQLite 布尔写 1/0', sqlParameterToLiteral(true, 'sqlite') === '1')
    check('NULL 就是 NULL', sqlParameterToLiteral(null, 'sqlite') === 'NULL')
    check(
      '★ BLOB 用 X\'..\'（SQLite）',
      sqlParameterToLiteral(new Uint8Array([0xde, 0xad]), 'sqlite') === "X'DEAD'",
      sqlParameterToLiteral(new Uint8Array([0xde, 0xad]), 'sqlite')
    )
    check(
      '★ BLOB 用 E\'\\x..\'（PG）',
      sqlParameterToLiteral(new Uint8Array([0xde, 0xad]), 'postgresql') === "E'\\xDEAD'",
      sqlParameterToLiteral(new Uint8Array([0xde, 0xad]), 'postgresql')
    )
  }
  {
    // ★ NUL 必须拒绝：PG 服务器端不接受，SQLite 读回时会被当字符串结束符。
    let threw = false
    try {
      sqlParameterToLiteral('a\u0000b', 'sqlite')
    } catch {
      threw = true
    }
    check('★ NUL 被拒绝', threw)
  }
  {
    // ★ 内联不能碰字符串字面量里的冒号。
    const sql = "SELECT ':id' FROM t WHERE x = :id"
    const out = inlineSqlParameters(sql, [{ name: 'id', value: 5 }], 'sqlite')
    check(
      '★ 字符串字面量里的冒号不被当成占位符',
      out === "SELECT ':id' FROM t WHERE x = 5",
      out
    )
  }
  {
    // ★ 注释里的占位符也不该被替换。
    const sql = 'SELECT 1 -- :id\nFROM t WHERE x = :id'
    const out = inlineSqlParameters(sql, [{ name: 'id', value: 5 }], 'sqlite')
    check('★ 注释里的占位符不被替换', out.includes('-- :id'), out)
  }
  {
    // ★ 位置型占位符（SQLite 的 ?）按顺序取值。
    const out = inlineSqlParameters(
      'SELECT * FROM t WHERE a = ? AND b = ?',
      [{ name: '?1', value: 1 }, { name: '?2', value: 'x' }],
      'sqlite'
    )
    check(
      '★ 位置型占位符按顺序内联',
      out === "SELECT * FROM t WHERE a = 1 AND b = 'x'",
      out
    )
  }

  console.log('\n[20] 目标路径提示：没有默认目录时要说清"必须绝对路径"')
  {
    const withDir = renderPathHint('/tmp')
    check('有默认目录时显示目录', withDir.includes('/tmp'), withDir)
    const withoutDir = renderPathHint(null)
    check('★ 没有默认目录时强调绝对路径', withoutDir.includes('绝对路径'), withoutDir)
    check('★ 说明相对路径会被拒绝', withoutDir.includes('相对路径'), withoutDir)
  }
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`\n===== 导出向导契约测试：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) process.exit(1)
