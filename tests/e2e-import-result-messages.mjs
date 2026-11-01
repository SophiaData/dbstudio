/**
 * 导入**终态结果文案**的纯函数回归（不启 Electron、不连数据库）。
 *
 * ============================================================================
 * 这条测试防的是什么
 * ============================================================================
 *
 * 导入失败时的文案是**安全属性**，不是措辞偏好：
 *
 *   - 提交结果未知（`COMMIT_OUTCOME_UNKNOWN:`）时，事务**可能已经提交**。
 *     这时若文案说"已回滚、目标表没有留下数据"，用户会以为表是干净的，
 *     于是**再导一次**——写进两份数据。这是最坏的一类错误。
 *   - 驱动宿主被终止（`HOST_TERMINATED_TIMEOUT:`）时，未提交事务是
 *     **由数据库在连接断开时回滚**的，那是"将来时"，不是"已回滚"。
 *     说成"已回滚"就是虚构了一个从未发生的确认动作。
 *   - 普通失败/取消可能发生在**任何写入之前**（解析拒绝、目标连接上已有
 *     未提交事务……），所以也不能笼统说"本次导入已回滚"。
 *
 * 所以文案必须按后端给的**稳定前缀**分类，不能只看 `status`。
 *
 * ============================================================================
 * 为什么用 vite 打包而不是直接 import
 * ============================================================================
 *
 * 被测文件是 TypeScript，且 `import-dialog.ts` 里混着 DOM 装配代码。
 * vite 的 lib + ssr 构建可以把**纯逻辑区**单独打成可在 Node 里 import 的
 * ESM chunk（与 tests/e2e-import-validation.mjs 同一招），不引入新工具链。
 *
 * `write: false` —— 产物只在内存里，**不落盘、不碰 out/**。
 *
 * 运行：node tests/e2e-import-result-messages.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')

const built = await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    write: false,
    target: 'node22',
    ssr: true,
    minify: false,
    lib: { entry: resolve(root, 'src/renderer/import-dialog.ts'), formats: ['es'] }
  }
})

const outputs = Array.isArray(built)
  ? built.flatMap((result) => result.output ?? [])
  : (built.output ?? [])
const chunk = outputs.find((output) => output.type === 'chunk')
if (!chunk) throw new Error('Vite did not produce an import-dialog chunk')
const dialog = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`)

/** 构造一个 ImportResult，省掉与被测行为无关的字段。 */
const result = (overrides) => ({
  taskId: 'task-1',
  status: 'failed',
  totalRows: 2,
  rowsImported: 0,
  batches: 1,
  sourcePath: '/tmp/data.csv',
  targetNodeId: 'connection:c1|table:people',
  ...overrides
})

// ---------------------------------------------------------------------------
// 1. 提交结果未知
// ---------------------------------------------------------------------------

test('提交结果未知：保留 rowsImported，且不允许出现"已回滚"断言', () => {
  const summary = dialog.describeImportResult(
    result({
      status: 'failed',
      rowsImported: 2,
      message:
        'COMMIT_OUTCOME_UNKNOWN: 提交结果未知，可能已提交，核实目标表后勿重复导入。驱动错误：提交事务超时'
    })
  )
  // 分类正确
  assert.equal(
    dialog.classifyImportOutcome(
      result({ rowsImported: 2, message: 'COMMIT_OUTCOME_UNKNOWN: 提交结果未知' })
    ),
    'commit-outcome-unknown'
  )
  // 明确告知"可能已提交"
  assert.match(summary, /可能已提交/)
  assert.match(summary, /提交结果/)
  // 提示核实目标表、不要重复导入
  assert.match(summary, /核实目标表/)
  assert.match(summary, /勿重复导入|不要重复导入|再决定是否重新导入/)
  // **绝不能**出现"已回滚"或"没有留下数据"这类断言
  assert.doesNotMatch(summary, /已回滚/)
  assert.doesNotMatch(summary, /没有留下/)
  assert.doesNotMatch(summary, /没有部分数据/)
  // rowsImported 必须体现出来（用户据此判断"可能已有多少行进去了"）
  assert.match(summary, /2 行/)
})

test('提交结果未知：即使 message 里出现"回滚"字样，也不能按普通失败处理', () => {
  // 后端把驱动原文拼在后面，驱动原文里可能带"回滚"字样。
  // 稳定前缀优先：这类消息绝不能被降级成"已回滚、没有部分数据"。
  const summary = dialog.describeImportResult(
    result({
      rowsImported: 3,
      message:
        'COMMIT_OUTCOME_UNKNOWN: 提交结果未知，可能已提交，核实目标表后勿重复导入。驱动错误：回滚事务也失败'
    })
  )
  assert.doesNotMatch(summary, /已回滚/)
  assert.match(summary, /可能已提交/)
})

test('提交结果未知：rowsImported 为 0 时不编造"本次写入 N 行"', () => {
  const summary = dialog.describeImportResult(
    result({ rowsImported: 0, message: 'COMMIT_OUTCOME_UNKNOWN: 提交结果未知，可能已提交' })
  )
  assert.doesNotMatch(summary, /本次写入 0 行/)
  assert.match(summary, /可能已提交/)
})

// ---------------------------------------------------------------------------
// 2. 驱动宿主被终止
// ---------------------------------------------------------------------------

test('宿主终止：说明未提交事务将由连接断开时回滚，但不虚构"已确认回滚"', () => {
  const summary = dialog.describeImportResult(
    result({
      status: 'failed',
      rowsImported: 0,
      message:
        'HOST_TERMINATED_TIMEOUT: 第 2 批写入时驱动宿主已终止，本次导入未提交；未提交事务由数据库在连接断开时自动回滚。驱动错误：导入批次写入超时。请重新连接后核对目标表。'
    })
  )
  assert.equal(
    dialog.classifyImportOutcome(
      result({ message: 'HOST_TERMINATED_TIMEOUT: 驱动宿主已终止' })
    ),
    'host-terminated'
  )
  // 必须说明"连接断开时由数据库回滚"（将来时）
  assert.match(summary, /连接断开/)
  assert.match(summary, /回滚/)
  // 必须要求重新连接并核对目标表
  assert.match(summary, /重新连接/)
  assert.match(summary, /核对目标表|核实目标表/)
  // **绝不能**说成"已回滚 / 已确认回滚 / 没有留下数据"
  assert.doesNotMatch(summary, /已回滚/)
  assert.doesNotMatch(summary, /已确认回滚/)
  assert.doesNotMatch(summary, /没有留下/)
  assert.doesNotMatch(summary, /没有部分数据/)
})

test('宿主终止：rowsImported 为 0，不声称写入了任何行', () => {
  const summary = dialog.describeImportResult(
    result({ rowsImported: 0, message: 'HOST_TERMINATED_TIMEOUT: 驱动宿主已终止' })
  )
  assert.doesNotMatch(summary, /本次写入 \d+ 行/)
})

// ---------------------------------------------------------------------------
// 3. 回滚失败
// ---------------------------------------------------------------------------

test('回滚失败：说明事务可能仍未结束，要求断开连接并核实数据', () => {
  const summary = dialog.describeImportResult(
    result({
      status: 'failed',
      message:
        '导入第 1 批第 3 行写入列「email」失败：NOT NULL constraint failed: guarded.email；回滚也失败：连接已断开。数据库提示事务可能仍未结束，请断开连接以强制回滚。'
    })
  )
  assert.equal(
    dialog.classifyImportOutcome(result({ message: '；回滚也失败：连接已断开' })),
    'rollback-failed'
  )
  assert.match(summary, /回滚失败/)
  assert.match(summary, /事务可能仍未结束/)
  assert.match(summary, /断开连接/)
  assert.match(summary, /核实目标表/)
})

test('回滚失败：取消态也走同一套回滚失败文案', () => {
  const summary = dialog.describeImportResult(
    result({
      status: 'cancelled',
      message: '导入已取消；回滚也失败：连接已断开。数据库提示事务可能仍未结束，请断开连接以强制回滚。'
    })
  )
  assert.match(summary, /回滚失败/)
  assert.match(summary, /断开连接/)
  assert.doesNotMatch(summary, /已回滚，/)
})

// ---------------------------------------------------------------------------
// 4. 普通失败 / 取消（没有回滚结论）
// ---------------------------------------------------------------------------

test('普通失败：不谎称"已回滚"，保留后端原文并要求核实目标表', () => {
  const summary = dialog.describeImportResult(
    result({
      status: 'failed',
      message: '导入第 1 批第 3 行（CSV 数据第 3 行）写入列「email」失败：NOT NULL constraint failed'
    })
  )
  assert.equal(
    dialog.classifyImportOutcome(result({ message: '导入第 1 批失败' })),
    'failed'
  )
  // 后端原文必须保留（行号、列名都在里面）
  assert.match(summary, /第 3 行/)
  assert.match(summary, /email/)
  assert.match(summary, /NOT NULL constraint failed/)
  // 不允许笼统声称已回滚
  assert.doesNotMatch(summary, /已回滚/)
  assert.doesNotMatch(summary, /没有留下部分数据/)
  // 必须提示核实
  assert.match(summary, /核实目标表/)
})

test('普通失败：写入前的校验拒绝同样不得声称已回滚', () => {
  // 解析拒绝 / 目标连接上已有未提交事务：一次写入都没发生。
  const summary = dialog.describeImportResult(
    result({ status: 'failed', message: '目标连接上已有未提交事务。请先提交或回滚，再开始导入' })
  )
  assert.doesNotMatch(summary, /已回滚/)
  assert.match(summary, /已有未提交事务/)
  assert.match(summary, /核实目标表/)
})

test('普通取消：后端原文保留，不谎称已回滚', () => {
  const summary = dialog.describeImportResult(
    result({ status: 'cancelled', message: '导入已取消' })
  )
  assert.equal(dialog.classifyImportOutcome(result({ status: 'cancelled', message: '导入已取消' })), 'cancelled')
  assert.match(summary, /已取消/)
  assert.doesNotMatch(summary, /已回滚/)
  assert.doesNotMatch(summary, /没有留下/)
})

test('取消且后端明确说已回滚：此时可以断言目标表没有留下数据', () => {
  // 后端 ImportManager 在"取消且确实回滚过"时才写"已回滚本任务写入"。
  const summary = dialog.describeImportResult(
    result({ status: 'cancelled', message: '导入已取消，已回滚本任务写入' })
  )
  assert.equal(
    dialog.classifyImportOutcome(result({ status: 'cancelled', message: '导入已取消，已回滚本任务写入' })),
    'rolled-back'
  )
  assert.match(summary, /已回滚/)
  assert.match(summary, /没有留下本次导入的数据/)
})

// ---------------------------------------------------------------------------
// 5. 成功
// ---------------------------------------------------------------------------

test('成功：文案与行数保持原样，不受分类改动影响', () => {
  const summary = dialog.describeImportResult(
    result({
      status: 'completed',
      totalRows: 2,
      rowsImported: 2,
      batches: 1
    })
  )
  assert.equal(
    dialog.classifyImportOutcome(result({ status: 'completed', rowsImported: 2 })),
    'completed'
  )
  assert.equal(summary, '导入完成：2 行已写入「connection:c1|table:people」')
  assert.doesNotMatch(summary, /回滚/)
})

test('失败位置仍然出现在摘要里', () => {
  const summary = dialog.describeImportResult(
    result({
      status: 'failed',
      message: '写入列「email」失败',
      row: 3,
      line: 4,
      column: 2,
      columnName: 'email'
    })
  )
  assert.match(summary, /数据第 3 行/)
  assert.match(summary, /列「email」/)
})

// ---------------------------------------------------------------------------
// 6. 分类优先级本身
// ---------------------------------------------------------------------------

test('分类优先级：稳定前缀 > 回滚失败 > 明确已回滚 > 普通失败/取消', () => {
  const cases = [
    ['COMMIT_OUTCOME_UNKNOWN: 提交结果未知', 'commit-outcome-unknown'],
    ['HOST_TERMINATED_TIMEOUT: 宿主已终止', 'host-terminated'],
    ['导入失败；回滚也失败：连接已断开', 'rollback-failed'],
    ['导入已取消，已回滚本任务写入', 'rolled-back'],
    ['导入第 1 批失败', 'failed']
  ]
  for (const [message, expected] of cases) {
    assert.equal(
      dialog.classifyImportOutcome(result({ message })),
      expected,
      `message=${message}`
    )
  }
  // 取消态没有特殊前缀时归到 cancelled
  assert.equal(
    dialog.classifyImportOutcome(result({ status: 'cancelled', message: '导入已取消' })),
    'cancelled'
  )
})

test('hasImportRollbackFailure 与 hasImportRollbackConfirmed 互不误判', () => {
  assert.equal(dialog.hasImportRollbackFailure('；回滚也失败：连接已断开'), true)
  assert.equal(dialog.hasImportRollbackFailure('事务可能仍未结束'), true)
  assert.equal(dialog.hasImportRollbackFailure('导入已取消，已回滚本任务写入'), false)
  assert.equal(dialog.hasImportRollbackFailure(undefined), false)

  assert.equal(dialog.hasImportRollbackConfirmed('导入已取消，已回滚本任务写入'), true)
  assert.equal(dialog.hasImportRollbackConfirmed('；回滚也失败：连接已断开'), false)
  assert.equal(dialog.hasImportRollbackConfirmed(undefined), false)
})
