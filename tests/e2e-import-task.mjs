/**
 * P2.3 CSV 导入任务端到端验证。
 *
 * 覆盖：
 *   - 空 CSV、空批次、目标列映射数量/重复列的前置拒绝；
 *   - 驱动批次结果、commit/rollback 状态与 rowsImported 的失败收口；
 *   - 真实 SQLite + driver-host 的成功导入；
 *   - 多批次、NULL 与空字符串区分；
 *   - 重复列/缺列解析失败的位置；
 *   - 按位置映射目标列、目标列白名单与批次级错误定位；
 *   - NOT NULL 失败后整次导入回滚；
 *   - 已写入若干批次后取消仍回滚；
 *   - 导入活动期间普通 commit/rollback 被拒绝，断开时由导入任务完成回滚；
 *   - 导入活动期间 executeStatement/insertRow/applyEdits/deleteRows/DDL 等写入入口被拒绝，结束后恢复；
 *   - 用户写请求（DML/DDL/普通 commit/rollback）在途时 startImport 同步拒绝，用户事务不会被导入误回滚；
 *   - 导入完成后普通查询可用。
 *
 * PostgreSQL 分支只有设置 DBSTUDIO_PG_URL 才运行；未设置会输出明确的 SKIP，
 * 不会把“没跑”混进通过结果。
 */

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')
const workDir = mkdtempSync(join(tmpdir(), 'dbstudio-import-task-'))

const results = []

function check(name, condition, detail) {
  const passed = Boolean(condition)
  results.push({ name, passed, skipped: false, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  if (!passed && detail !== undefined) console.log(`      ↳ ${formatDetail(detail)}`)
  return passed
}

function skip(name, reason) {
  results.push({ name, passed: true, skipped: true, detail: reason })
  console.log(`SKIP  ${name}`)
  console.log(`      ↳ ${reason}`)
}

function formatDetail(detail) {
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

/**
 * 把 DriverHostHandle 原型上的某个方法临时包成“调用即挂起，等 release 才真正执行”。
 * 用来在测试里制造可控的交错点：先让用户写请求停在“已发起但尚未建立事务”的状态。
 * 返回的 restore 必须放 finally。
 */
function gatePrototypeMethod(proto, name) {
  const original = proto[name]
  let release = () => {}
  let markRequested = () => {}
  const requested = new Promise((resolve) => {
    markRequested = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  proto[name] = async function (...args) {
    markRequested()
    await gate
    return original.apply(this, args)
  }
  return {
    requested,
    release: () => release(),
    restore: () => {
      proto[name] = original
    }
  }
}

function cellValue(cell) {
  if (cell === undefined) return undefined
  switch (cell.kind) {
    case 'null':
      return null
    case 'text':
      return cell.text
    case 'number':
      return cell.value
    case 'boolean':
      return cell.value
    default:
      return cell
  }
}

async function ensureDriverHost() {
  if (existsSync(hostEntry)) return
  const child = spawn(process.execPath, [resolve(root, 'scripts/build-driver-host.mjs')], {
    stdio: 'inherit'
  })
  const code = await new Promise((res) => child.on('exit', res))
  if (code !== 0 || !existsSync(hostEntry)) throw new Error('构建 driver-host 失败')
}

async function loadModules() {
  const { build } = await import('vite')
  const outDir = resolve(root, 'out/.import-probe')
  const entryDir = resolve(outDir, 'src')
  mkdirSync(entryDir, { recursive: true })
  const entry = resolve(entryDir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export { ImportManager } from ${JSON.stringify(resolve(root, 'src/main/ImportManager.ts'))}`,
      `export { ConnectionManager } from ${JSON.stringify(resolve(root, 'src/main/ConnectionManager.ts'))}`,
      `export { ConnectionStore } from ${JSON.stringify(resolve(root, 'src/main/ConnectionStore.ts'))}`,
      `export { DriverHostHandle } from ${JSON.stringify(resolve(root, 'src/main/DriverHostHandle.ts'))}`,
      ''
    ].join('\n'),
    'utf8'
  )
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
        external: [/^node:/, 'electron'],
        output: { entryFileNames: 'probe.cjs' }
      },
      lib: { entry, formats: ['cjs'] }
    }
  })
  return import(`file://${resolve(outDir, 'probe.cjs')}`)
}

function makeDb() {
  const file = join(workDir, 'import.db')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE imported_users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      note TEXT
    );
    CREATE TABLE multi_batch (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE nullability (
      id INTEGER PRIMARY KEY,
      note TEXT
    );
    CREATE TABLE guarded (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      note TEXT
    );
    CREATE TABLE cancel_target (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE transaction_owner_guard (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE disconnect_import (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE write_entry_guard (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE inflight_write_guard (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE inflight_entry_guard (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  db.close()
  return file
}

function sqliteMetadata() {
  return [
    {
      id: 'sqlite',
      name: 'SQLite',
      fields: [{ key: 'file', label: '数据库文件', kind: 'file', required: true }],
      quoting: { open: '"', close: '"', escape: 'double' },
      scriptRules: { statements: [], delimiters: [] }
    }
  ]
}

function importRequest(targetNodeId, sourcePath, targetColumns, batchSize = 200) {
  return {
    targetNodeId,
    sourcePath,
    delimiter: ',',
    nullText: '',
    hasHeader: true,
    targetColumns,
    batchSize
  }
}

function transactionState(active = false) {
  return { active, pendingAffected: 0 }
}

function makeImportManager(ImportManager, overrides = {}) {
  const calls = { write: 0, commit: 0, rollback: 0, transactionState: 0 }
  const writeBatch =
    overrides.writeBatch ??
    (async (_targetNodeId, batch) => ({
      rowsImported: batch.rows.length,
      inTransaction: true
    }))
  const commit = overrides.commit ?? (async () => transactionState(false))
  const rollback = overrides.rollback ?? (async () => transactionState(false))
  const transactionStateFn =
    overrides.transactionState ?? (async () => transactionState(false))
  const manager = new ImportManager({
    writeBatch: async (targetNodeId, batch) => {
      calls.write += 1
      return writeBatch(targetNodeId, batch)
    },
    commit: async (targetNodeId) => {
      calls.commit += 1
      return commit(targetNodeId)
    },
    rollback: async (targetNodeId) => {
      calls.rollback += 1
      return rollback(targetNodeId)
    },
    transactionState: async (targetNodeId) => {
      calls.transactionState += 1
      return transactionStateFn(targetNodeId)
    },
    resolveConnectionId: () => 'contract-connection'
  })
  return { manager, calls }
}

async function runImportManagerContractBranch(modules) {
  const { ImportManager } = modules
  const targetNodeId = 'connection:contract|table:test'
  const request = (sourcePath, targetColumns, batchSize = 2) =>
    importRequest(targetNodeId, sourcePath, targetColumns, batchSize)
  const run = async (sourcePath, targetColumns, batchSize = 2, overrides = {}) => {
    const { manager, calls } = makeImportManager(ImportManager, overrides)
    const progress = manager.start(request(sourcePath, targetColumns, batchSize))
    const result = await manager.wait(progress.taskId)
    await manager.dispose()
    return { result, calls }
  }

  const emptyPath = join(workDir, 'manager-empty.csv')
  writeFileSync(emptyPath, '', 'utf8')
  const empty = await run(emptyPath, ['id'], 1)
  check(
    'ImportManager 空 CSV 失败且不写库/开启提交',
    empty.result.status === 'failed' &&
      empty.result.totalRows === 0 &&
      empty.result.rowsImported === 0 &&
      empty.calls.write === 0 &&
      empty.calls.commit === 0 &&
      empty.calls.rollback === 0,
    empty.result
  )

  const headerOnlyPath = join(workDir, 'manager-header-only.csv')
  writeFileSync(headerOnlyPath, 'id,value\n', 'utf8')
  const headerOnly = await run(headerOnlyPath, ['id', 'value'], 1)
  check(
    'ImportManager 只有表头时明确失败',
    headerOnly.result.status === 'failed' &&
      headerOnly.result.rowsImported === 0 &&
      /没有数据行/.test(headerOnly.result.message ?? '') &&
      headerOnly.calls.write === 0 &&
      headerOnly.calls.commit === 0,
    headerOnly.result
  )

  const mappingPath = join(workDir, 'manager-mapping.csv')
  writeFileSync(mappingPath, 'source_id,source_value\n1,a\n', 'utf8')
  const mapping = await run(mappingPath, ['id'], 1)
  check(
    '目标列映射数量不足时指出首个未映射 CSV 列',
    mapping.result.status === 'failed' &&
      mapping.result.column === 2 &&
      mapping.result.columnName === 'source_value' &&
      mapping.calls.write === 0,
    mapping.result
  )

  const duplicateManager = makeImportManager(ImportManager).manager
  let duplicateTargetError = null
  try {
    duplicateManager.start(request(mappingPath, ['id', 'id'], 1))
  } catch (error) {
    duplicateTargetError = error
  }
  check(
    '重复目标列在任务启动前被拒绝',
    duplicateTargetError instanceof Error && /重复/.test(duplicateTargetError.message),
    duplicateTargetError instanceof Error ? duplicateTargetError.message : duplicateTargetError
  )
  await duplicateManager.dispose()

  const validPath = join(workDir, 'manager-valid.csv')
  writeFileSync(validPath, 'id,value\n1,a\n2,b\n', 'utf8')

  const noTransaction = await run(validPath, ['id', 'value'], 1, {
    writeBatch: async (_targetNodeId, batch) => ({
      rowsImported: batch.rows.length,
      inTransaction: false
    })
  })
  check(
    '驱动写完后未保持事务时任务失败且不提交',
    noTransaction.result.status === 'failed' &&
      noTransaction.result.rowsImported === 0 &&
      noTransaction.calls.commit === 0 &&
      noTransaction.calls.rollback === 1 &&
      /事务/.test(noTransaction.result.message ?? ''),
    noTransaction.result
  )

  const wrongCount = await run(validPath, ['id', 'value'], 1, {
    writeBatch: async (_targetNodeId, batch) => ({
      rowsImported: batch.rows.length + 1,
      inTransaction: true
    })
  })
  check(
    '驱动返回行数与批次不一致时任务失败而不是报告虚高成功数',
    wrongCount.result.status === 'failed' &&
      wrongCount.result.rowsImported === 0 &&
      wrongCount.calls.commit === 0 &&
      wrongCount.calls.rollback === 1 &&
      (wrongCount.result.message ?? '').includes('有 1 行，但驱动报告写入了 2 行'),
    wrongCount.result
  )

  const commitOutcomeUnknown = await run(validPath, ['id', 'value'], 2, {
    commit: async () => {
      throw Object.assign(new Error('COMMIT_OUTCOME_UNKNOWN: simulated commit loss'), {
        code: 'commit_outcome_unknown'
      })
    }
  })
  check(
    '提交结果未知时不回滚、不归零，并明确提示核实目标表',
    commitOutcomeUnknown.result.status === 'failed' &&
      commitOutcomeUnknown.result.rowsImported === 2 &&
      commitOutcomeUnknown.result.batches === 1 &&
      commitOutcomeUnknown.calls.commit === 1 &&
      commitOutcomeUnknown.calls.rollback === 0 &&
      (commitOutcomeUnknown.result.message ?? '').includes(
        '提交结果未知，可能已提交，核实目标表后勿重复导入'
      ),
    commitOutcomeUnknown.result
  )

  const hostTerminated = await run(validPath, ['id', 'value'], 1, {
    writeBatch: async (_targetNodeId, batch) => {
      if (batch.batchIndex === 1) {
        throw Object.assign(
          new Error(
            'HOST_TERMINATED_TIMEOUT: 导入批次超时；' +
              '第 2 批第 1 行（CSV 数据第 2 行）写入列「value」失败'
          ),
          { code: 'driver_host_timeout', hostTerminated: true }
        )
      }
      return { rowsImported: batch.rows.length, inTransaction: true }
    }
  })
  check(
    '批次写入遇宿主终止时不回滚、不保留成功行数且保留行列定位',
    hostTerminated.result.status === 'failed' &&
      hostTerminated.result.rowsImported === 0 &&
      hostTerminated.result.row === 2 &&
      hostTerminated.result.line === 3 &&
      hostTerminated.result.column === 2 &&
      hostTerminated.result.columnName === 'value' &&
      hostTerminated.calls.commit === 0 &&
      hostTerminated.calls.rollback === 0 &&
      (hostTerminated.result.message ?? '').includes('HOST_TERMINATED_TIMEOUT') &&
      (hostTerminated.result.message ?? '').includes('第 2 批') &&
      !(hostTerminated.result.message ?? '').includes('已回滚'),
    hostTerminated.result
  )

  const commitStillActive = await run(validPath, ['id', 'value'], 1, {
    commit: async () => transactionState(true)
  })
  check(
    '提交返回仍活动事务时不把任务标成完成',
    commitStillActive.result.status === 'failed' &&
      commitStillActive.result.rowsImported === 0 &&
      commitStillActive.calls.commit === 1 &&
      commitStillActive.calls.rollback === 1 &&
      /提交后事务仍/.test(commitStillActive.result.message ?? ''),
    commitStillActive.result
  )

  const rollbackStillActive = await run(validPath, ['id', 'value'], 1, {
    writeBatch: async (_targetNodeId, batch) => {
      if (batch.batchIndex === 1) {
        throw new Error('导入第 2 批第 1 行（CSV 数据第 2 行）写入列「value」失败：boom')
      }
      return { rowsImported: batch.rows.length, inTransaction: true }
    },
    rollback: async () => transactionState(true)
  })
  check(
    '回滚后事务仍活动时明确报告失败且不保留成功行数',
    rollbackStillActive.result.status === 'failed' &&
      rollbackStillActive.result.rowsImported === 0 &&
      rollbackStillActive.result.row === 2 &&
      rollbackStillActive.result.line === 3 &&
      rollbackStillActive.result.column === 2 &&
      rollbackStillActive.result.columnName === 'value' &&
      /回滚也失败/.test(rollbackStillActive.result.message ?? ''),
    rollbackStillActive.result
  )

  let releaseRollback = () => {}
  let markRollbackStarted = () => {}
  const rollbackStarted = new Promise((resolve) => {
    markRollbackStarted = resolve
  })
  const rollbackGate = new Promise((resolve) => {
    releaseRollback = resolve
  })
  const { manager: finalizingManager, calls: finalizingCalls } = makeImportManager(
    ImportManager,
    {
      writeBatch: async () => {
        throw new Error('CSV 数据第 1 行写入列「value」失败：boom')
      },
      rollback: async () => {
        markRollbackStarted()
        await rollbackGate
        return transactionState(false)
      }
    }
  )
  const finalizingProgress = finalizingManager.start(request(validPath, ['id', 'value'], 1))
  await rollbackStarted
  const cancelDuringRollback = finalizingManager.cancel(finalizingProgress.taskId)
  releaseRollback()
  const finalizingResult = await finalizingManager.wait(finalizingProgress.taskId)
  check(
    '失败进入回滚后不再接受取消请求',
    cancelDuringRollback === false &&
      finalizingResult.status === 'failed' &&
      finalizingCalls.rollback === 1,
    { cancelDuringRollback, result: finalizingResult }
  )
  await finalizingManager.dispose()
}

async function runQuery(manager, connectionId, sql) {
  const result = await manager.runQuery(`connection:${connectionId}`, sql, { keepCursor: false })
  return result.rows.map((row) => row.cells.map(cellValue))
}

async function runSqliteBranch(modules) {
  const { ConnectionManager, ConnectionStore, DriverHostHandle, ImportManager } = modules
  const dbFile = makeDb()
  const manager = new ConnectionManager(
    sqliteMetadata(),
    new ConnectionStore({
      baseDir: join(workDir, 'sqlite-store'),
      cipher: {
        encrypt: (plain) => Buffer.from(plain, 'utf8'),
        decrypt: (payload) => payload.toString('utf8')
      }
    })
  )
  const summary = await manager.add(
    { dialectId: 'sqlite', name: 'import-sqlite', options: { file: dbFile } },
    undefined
  )
  const connectionId = summary.id
  const target = (table) => `connection:${connectionId}|table:${table}`
  if (summary.connected !== true) {
    check('SQLite 连接真实建立成功', false, summary)
    return
  }
  check('SQLite 连接真实建立成功', true)

  // 1) 成功导入 + 导入后普通查询
  const successPath = join(workDir, 'success.csv')
  writeFileSync(successPath, 'id,email,note\n1,a@example.com,alpha\n2,b@example.com,beta\n', 'utf8')
  const success = manager.startImport(
    importRequest(target('imported_users'), successPath, ['id', 'email', 'note'], 2)
  )
  const successResult = await manager.waitImport(success.taskId)
  check('SQLite 成功导入完成', successResult.status === 'completed', successResult)
  check('SQLite 成功导入行数正确', successResult.rowsImported === 2, successResult)
  const imported = await runQuery(
    manager,
    connectionId,
    'SELECT id, email, note FROM imported_users ORDER BY id'
  )
  check(
    '导入完成后普通查询可用且数据正确',
    imported.length === 2 &&
      imported[0]?.[0] === 1 &&
      imported[0]?.[1] === 'a@example.com' &&
      imported[1]?.[2] === 'beta',
    imported
  )

  // 1a) CSV 表头名不参与自动猜测；写入位置只由 targetColumns 决定。
  const mappedPath = join(workDir, 'renamed-headers.csv')
  writeFileSync(
    mappedPath,
    'source_pk,source_mail,source_note\n4,d@example.com,delta\n',
    'utf8'
  )
  const mapped = manager.startImport(
    importRequest(target('imported_users'), mappedPath, ['id', 'email', 'note'], 1)
  )
  const mappedResult = await manager.waitImport(mapped.taskId)
  const mappedRows = await runQuery(
    manager,
    connectionId,
    'SELECT id, email, note FROM imported_users WHERE id = 4'
  )
  check('CSV 表头与目标列名不同时仍按 targetColumns 位置映射', mappedResult.status === 'completed', mappedResult)
  check(
    'targetColumns 位置映射写入正确目标列',
    mappedRows[0]?.[0] === 4 &&
      mappedRows[0]?.[1] === 'd@example.com' &&
      mappedRows[0]?.[2] === 'delta',
    mappedRows
  )

  // 1b) CSV 值只能作为参数，不能成为 SQL 文本
  const injectionPath = join(workDir, 'injection.csv')
  writeFileSync(
    injectionPath,
    "id,email,note\n3,c@example.com,x'); DROP TABLE imported_users; --\n",
    'utf8'
  )
  const injection = manager.startImport(
    importRequest(target('imported_users'), injectionPath, ['id', 'email', 'note'])
  )
  const injectionResult = await manager.waitImport(injection.taskId)
  const injectionRows = await runQuery(
    manager,
    connectionId,
    'SELECT note FROM imported_users WHERE id = 3'
  )
  check('含 SQL 片段的 CSV 值导入成功', injectionResult.status === 'completed', injectionResult)
  check(
    'CSV 值按参数保存且目标表未被注入删除',
    injectionRows[0]?.[0] === "x'); DROP TABLE imported_users; --",
    injectionRows
  )

  // 1c) 导入任务活动期间，普通连接事务入口不得提交/回滚导入事务。
  const originalImportBatch = DriverHostHandle.prototype.importBatch
  let releaseOwnerBatch = () => {}
  let markOwnerBatchWritten = () => {}
  const ownerBatchWritten = new Promise((resolve) => {
    markOwnerBatchWritten = resolve
  })
  const ownerBatchGate = new Promise((resolve) => {
    releaseOwnerBatch = resolve
  })
  let heldOwnerBatch = false
  DriverHostHandle.prototype.importBatch = async function (...args) {
    const result = await originalImportBatch.apply(this, args)
    if (!heldOwnerBatch) {
      heldOwnerBatch = true
      markOwnerBatchWritten()
      await ownerBatchGate
    }
    return result
  }
  try {
    const ownerPath = join(workDir, 'transaction-owner.csv')
    writeFileSync(ownerPath, 'id,value\n1,first\n2,second\n', 'utf8')
    const ownerTask = manager.startImport(
      importRequest(target('transaction_owner_guard'), ownerPath, ['id', 'value'], 1)
    )
    await ownerBatchWritten

    let ownerCommitError = null
    let ownerRollbackError = null
    try {
      await manager.commitTransaction(`connection:${connectionId}`)
    } catch (error) {
      ownerCommitError = error
    }
    try {
      await manager.rollbackTransaction(`connection:${connectionId}`)
    } catch (error) {
      ownerRollbackError = error
    }
    check(
      '导入任务活动时普通 commit/rollback 均被拒绝',
      ownerCommitError instanceof Error &&
        ownerRollbackError instanceof Error &&
        /导入任务/.test(ownerCommitError.message) &&
        /导入任务/.test(ownerRollbackError.message),
      {
        commit: ownerCommitError instanceof Error ? ownerCommitError.message : ownerCommitError,
        rollback:
          ownerRollbackError instanceof Error ? ownerRollbackError.message : ownerRollbackError
      }
    )

    releaseOwnerBatch()
    const ownerResult = await manager.waitImport(ownerTask.taskId)
    const ownerRows = await runQuery(
      manager,
      connectionId,
      'SELECT COUNT(*) FROM transaction_owner_guard'
    )
    check(
      '拒绝普通事务后导入任务仍可自行完成提交',
      ownerResult.status === 'completed' && ownerRows[0]?.[0] === 2,
      { result: ownerResult, rows: ownerRows }
    )
  } finally {
    releaseOwnerBatch()
    DriverHostHandle.prototype.importBatch = originalImportBatch
  }

  // 1d) 导入任务活动期间，其它写入入口也不得加入同一连接事务。
  //     驱动的 executeStatement(DML)/insertRow/applyEdits/deleteRows/DDL 在
  //     已有事务时都会复用该事务，若不拒绝就会混入并随导入一起提交，必须提前挡掉。
  let releaseWriteGuardBatch = () => {}
  let markWriteGuardBatchWritten = () => {}
  const writeGuardBatchWritten = new Promise((resolve) => {
    markWriteGuardBatchWritten = resolve
  })
  const writeGuardBatchGate = new Promise((resolve) => {
    releaseWriteGuardBatch = resolve
  })
  let heldWriteGuardBatch = false
  DriverHostHandle.prototype.importBatch = async function (...args) {
    const result = await originalImportBatch.apply(this, args)
    if (!heldWriteGuardBatch) {
      heldWriteGuardBatch = true
      markWriteGuardBatchWritten()
      await writeGuardBatchGate
    }
    return result
  }
  try {
    const writeGuardPath = join(workDir, 'write-entry-guard.csv')
    writeFileSync(writeGuardPath, 'id,value\n1,first\n2,second\n', 'utf8')
    const writeGuardTask = manager.startImport(
      importRequest(target('write_entry_guard'), writeGuardPath, ['id', 'value'], 1)
    )
    await writeGuardBatchWritten

    const writeGuardErrors = {}
    const attemptWrite = async (name, fn) => {
      try {
        await fn()
        writeGuardErrors[name] = null
      } catch (error) {
        writeGuardErrors[name] = error
      }
    }
    await attemptWrite('executeStatement', () =>
      manager.executeStatement(
        `connection:${connectionId}`,
        "INSERT INTO write_entry_guard (id, value) VALUES (100, 'x')"
      )
    )
    await attemptWrite('insertRow', () =>
      manager.insertRow(target('write_entry_guard'), {
        id: { kind: 'number', value: 101 },
        value: { kind: 'text', text: 'x' }
      })
    )
    await attemptWrite('applyEdits', () =>
      manager.applyEdits(target('write_entry_guard'), [
        {
          keyValues: { id: { kind: 'number', value: 1 } },
          changes: { value: { kind: 'text', text: 'hijacked' } }
        }
      ])
    )
    await attemptWrite('deleteRows', () =>
      manager.deleteRows(target('write_entry_guard'), [{ id: { kind: 'number', value: 1 } }])
    )
    // DDL 也复用同一连接事务，放在最后尝试（若守卫失效会改结构，影响面最大）。
    await attemptWrite('renameTable', () =>
      manager.renameTable(target('write_entry_guard'), 'should_not_rename')
    )

    const writeGuardEntries = Object.entries(writeGuardErrors)
    check(
      '导入任务活动时 executeStatement/insertRow/applyEdits/deleteRows/renameTable 均被拒绝',
      writeGuardEntries.length === 5 &&
        writeGuardEntries.every(
          ([, error]) => error instanceof Error && /导入任务/.test(error.message)
        ),
      Object.fromEntries(
        writeGuardEntries.map(([name, error]) => [
          name,
          error instanceof Error ? error.message : error
        ])
      )
    )

    releaseWriteGuardBatch()
    const writeGuardResult = await manager.waitImport(writeGuardTask.taskId)
    const writeGuardRows = await runQuery(
      manager,
      connectionId,
      'SELECT id, value FROM write_entry_guard ORDER BY id'
    )
    check(
      '无关写入被拒后导入仍完整提交且数据未被污染',
      writeGuardResult.status === 'completed' &&
        writeGuardRows.length === 2 &&
        writeGuardRows[0]?.[0] === 1 &&
        writeGuardRows[0]?.[1] === 'first' &&
        writeGuardRows[1]?.[0] === 2 &&
        writeGuardRows[1]?.[1] === 'second',
      { result: writeGuardResult, rows: writeGuardRows }
    )

    let postImportInsertError = null
    try {
      await manager.insertRow(target('write_entry_guard'), {
        id: { kind: 'number', value: 200 },
        value: { kind: 'text', text: 'after-import' }
      })
    } catch (error) {
      postImportInsertError = error
    }
    let postImportRollbackError = null
    try {
      await manager.rollbackTransaction(`connection:${connectionId}`)
    } catch (error) {
      postImportRollbackError = error
    }
    check(
      '导入结束后写入入口恢复可用',
      postImportInsertError === null && postImportRollbackError === null,
      {
        insert:
          postImportInsertError instanceof Error
            ? postImportInsertError.message
            : postImportInsertError,
        rollback:
          postImportRollbackError instanceof Error
            ? postImportRollbackError.message
            : postImportRollbackError
      }
    )
  } finally {
    releaseWriteGuardBatch()
    DriverHostHandle.prototype.importBatch = originalImportBatch
  }

  // 1e) 用户写请求在导入启动前已在途：startImport 必须同步拒绝。
  //     否则会先在「用户事务尚未建立」的空窗里放过预检，随后 importBatch 撞上
  //     用户事务被驱动拒绝，ImportManager 的通用 rollback 会把**用户事务**误回滚。
  //     本用例用可控 barrier 精确制造该交错：用户写停在“已发起、未执行”处。
  {
    const baseInsertRow = DriverHostHandle.prototype.insertRow
    const baseImportBatch = DriverHostHandle.prototype.importBatch
    let releaseUserWrite = () => {}
    let markUserWriteRequested = () => {}
    const userWriteRequested = new Promise((resolve) => {
      markUserWriteRequested = resolve
    })
    const userWriteGate = new Promise((resolve) => {
      releaseUserWrite = resolve
    })
    let markUserWriteApplied = () => {}
    const userWriteApplied = new Promise((resolve) => {
      markUserWriteApplied = resolve
    })
    let importBatchInvoked = false
    DriverHostHandle.prototype.insertRow = async function (...args) {
      markUserWriteRequested()
      await userWriteGate
      try {
        return await baseInsertRow.apply(this, args)
      } finally {
        markUserWriteApplied()
      }
    }
    DriverHostHandle.prototype.importBatch = async function (...args) {
      importBatchInvoked = true
      // 旧实现：startImport 放行后导入会走到这里。先放行用户写并等它建立事务，
      // 制造确定性交错，再让 baseImportBatch 因用户事务拒绝，触发误回滚。
      releaseUserWrite()
      await userWriteApplied
      return baseImportBatch.apply(this, args)
    }
    try {
      const inflightPath = join(workDir, 'inflight-write.csv')
      writeFileSync(inflightPath, 'id,value\n10,in-flight\n', 'utf8')
      let userWriteError = null
      const userWritePromise = manager
        .insertRow(target('inflight_write_guard'), {
          id: { kind: 'number', value: 10 },
          value: { kind: 'text', text: 'user-pending' }
        })
        .then(
          () => undefined,
          (error) => {
            userWriteError = error
          }
        )
      await userWriteRequested

      let startError = null
      let startProgress = null
      try {
        startProgress = manager.startImport(
          importRequest(target('inflight_write_guard'), inflightPath, ['id', 'value'], 1)
        )
      } catch (error) {
        startError = error
      }
      // 修复后同步拒绝、不会调用 importBatch，需要自己放行用户写；
      // 旧实现放行导入，由上面的 importBatch 包装器放行以制造交错。
      if (startError !== null) releaseUserWrite()
      await userWritePromise
      if (startProgress !== null) await manager.waitImport(startProgress.taskId)

      const inflightState = await manager.transactionState(`connection:${connectionId}`)
      const inflightRows = await runQuery(
        manager,
        connectionId,
        'SELECT id, value FROM inflight_write_guard ORDER BY id'
      )
      check(
        '在途用户写时 startImport 同步拒绝',
        startError instanceof Error && /写操作|正在进行|在途/.test(startError.message),
        startError === null ? 'startImport 未抛错（导入被放行）' : startError.message
      )
      check('拒绝在途写时未创建导入任务', startProgress === null, startProgress)
      check('拒绝在途写时未触发 importBatch', importBatchInvoked === false)
      check(
        '在途用户写本身成功',
        userWriteError === null,
        userWriteError === null ? undefined : String(userWriteError)
      )
      check('用户事务未被导入误回滚', inflightState.active === true, inflightState)
      check(
        '用户写入的行仍在事务中可见',
        inflightRows.length === 1 &&
          inflightRows[0]?.[0] === 10 &&
          inflightRows[0]?.[1] === 'user-pending',
        inflightRows
      )

      await manager.commitTransaction(`connection:${connectionId}`)
      const persistedRows = await runQuery(
        manager,
        connectionId,
        'SELECT id, value FROM inflight_write_guard ORDER BY id'
      )
      check(
        '提交后用户数据持久化',
        persistedRows.length === 1 &&
          persistedRows[0]?.[0] === 10 &&
          persistedRows[0]?.[1] === 'user-pending',
        persistedRows
      )
    } finally {
      releaseUserWrite()
      DriverHostHandle.prototype.insertRow = baseInsertRow
      DriverHostHandle.prototype.importBatch = baseImportBatch
      await manager.rollbackTransaction(`connection:${connectionId}`).catch(() => undefined)
    }
  }

  // 1f) 在途的 DML / DDL / 普通 commit / 普通 rollback 也必须让 startImport 同步拒绝，
  //     否则同样会出现“导入误回滚用户事务”。这里逐一在写入口挂起后尝试启动导入。
  {
    const entryCsv = join(workDir, 'inflight-entry.csv')
    writeFileSync(entryCsv, 'id,value\n1,x\n', 'utf8')
    const expectStartRejected = async (label, methodName, operation) => {
      const gate = gatePrototypeMethod(DriverHostHandle.prototype, methodName)
      try {
        const op = operation().catch(() => undefined)
        await gate.requested
        let startError = null
        let startProgress = null
        try {
          startProgress = manager.startImport(
            importRequest(target('inflight_entry_guard'), entryCsv, ['id', 'value'], 1)
          )
        } catch (error) {
          startError = error
        }
        gate.release()
        await op
        check(
          `${label}在途时 startImport 同步拒绝`,
          startError instanceof Error && /写操作|正在进行|在途/.test(startError.message),
          startError === null ? 'startImport 未抛错' : startError.message
        )
        check(`${label}在途时未创建导入任务`, startProgress === null, startProgress)
      } finally {
        gate.restore()
        await manager.rollbackTransaction(`connection:${connectionId}`).catch(() => undefined)
      }
    }

    await expectStartRejected('executeStatement(DML)', 'executeStatement', () =>
      manager.executeStatement(
        `connection:${connectionId}`,
        "INSERT INTO inflight_entry_guard (id, value) VALUES (101, 'dml')"
      )
    )
    await expectStartRejected('createTable(DDL)', 'createTable', () =>
      manager.createTable(`connection:${connectionId}`, {
        name: 'inflight_ddl_tmp',
        columns: [{ name: 'id', typeName: 'INTEGER' }]
      })
    )
    await manager.insertRow(target('inflight_entry_guard'), {
      id: { kind: 'number', value: 202 },
      value: { kind: 'text', text: 'for-commit' }
    })
    await expectStartRejected('commit', 'commitTransaction', () =>
      manager.commitTransaction(`connection:${connectionId}`)
    )
    await manager.insertRow(target('inflight_entry_guard'), {
      id: { kind: 'number', value: 203 },
      value: { kind: 'text', text: 'for-rollback' }
    })
    await expectStartRejected('rollback', 'rollbackTransaction', () =>
      manager.rollbackTransaction(`connection:${connectionId}`)
    )
  }

  // 2) 多批次
  const multiPath = join(workDir, 'multi.csv')
  writeFileSync(
    multiPath,
    ['id,value', ...[1, 2, 3, 4, 5].map((id) => `${id},v${id}`)].join('\n') + '\n',
    'utf8'
  )
  const multi = manager.startImport(importRequest(target('multi_batch'), multiPath, ['id', 'value'], 2))
  const multiResult = await manager.waitImport(multi.taskId)
  const multiProgress = manager.getImportProgress(multi.taskId)
  check('多批次导入完成', multiResult.status === 'completed', multiResult)
  check('多批次导入 5 行', multiResult.rowsImported === 5, multiResult)
  check('多批次共执行 3 批', multiProgress?.batches === 3, multiProgress)
  const multiCount = await runQuery(manager, connectionId, 'SELECT COUNT(*) FROM multi_batch')
  check('多批次最终行数 = 5', multiCount[0]?.[0] === 5, multiCount)

  // 3) NULL 与空字符串
  const nullPath = join(workDir, 'null-empty.csv')
  writeFileSync(nullPath, 'id,note\n1,""\n2,\n3,value\n', 'utf8')
  const nullTask = manager.startImport(importRequest(target('nullability'), nullPath, ['id', 'note']))
  const nullResult = await manager.waitImport(nullTask.taskId)
  const nullRows = await runQuery(
    manager,
    connectionId,
    "SELECT id, note, note IS NULL, note = '' FROM nullability ORDER BY id"
  )
  check('NULL/空字符串导入完成', nullResult.status === 'completed', nullResult)
  check('加引号的空字段写成空字符串', nullRows[0]?.[1] === '' && nullRows[0]?.[3] === 1, nullRows)
  check('未加引号的空字段写成 NULL', nullRows[1]?.[1] === null && nullRows[1]?.[2] === 1, nullRows)

  // 4) 重复列解析失败
  const duplicatePath = join(workDir, 'duplicate.csv')
  writeFileSync(duplicatePath, 'id,email,email\n1,a,b\n', 'utf8')
  const duplicate = manager.startImport(
    importRequest(target('guarded'), duplicatePath, ['id', 'email', 'email_2'])
  )
  const duplicateResult = await manager.waitImport(duplicate.taskId)
  check('重复 CSV 列解析失败', duplicateResult.status === 'failed', duplicateResult)
  check(
    '重复列错误带行/列/列名',
    duplicateResult.line === 1 && duplicateResult.column === 3 && duplicateResult.columnName === 'email',
    duplicateResult
  )

  // 5) 缺列解析失败
  const missingPath = join(workDir, 'missing.csv')
  writeFileSync(missingPath, 'id,email,note\n1,a@example.com\n', 'utf8')
  const missing = manager.startImport(
    importRequest(target('guarded'), missingPath, ['id', 'email', 'note'])
  )
  const missingResult = await manager.waitImport(missing.taskId)
  check('缺列解析失败', missingResult.status === 'failed', missingResult)
  check(
    '缺列错误带数据行、物理行、列名',
    missingResult.row === 1 &&
      missingResult.line === 2 &&
      missingResult.column === 3 &&
      missingResult.columnName === 'note',
    missingResult
  )

  // 6) NOT NULL 失败后整次回滚（第一批已成功写入两行）
  const rollbackPath = join(workDir, 'not-null.csv')
  writeFileSync(rollbackPath, 'id,email,note\n1,a@example.com,ok\n2,b@example.com,ok\n3,,bad\n', 'utf8')
  const rollback = manager.startImport(
    importRequest(target('guarded'), rollbackPath, ['id', 'email', 'note'], 2)
  )
  const rollbackResult = await manager.waitImport(rollback.taskId)
  const guarded = await runQuery(manager, connectionId, 'SELECT COUNT(*) FROM guarded')
  const transaction = await manager.transactionState(`connection:${connectionId}`)
  check('NOT NULL 失败时任务失败', rollbackResult.status === 'failed', rollbackResult)
  check(
    'NOT NULL 错误带 CSV 行和列名',
    rollbackResult.row === 3 &&
      rollbackResult.line === 4 &&
      rollbackResult.column === 2 &&
      /email/.test(rollbackResult.columnName ?? rollbackResult.message ?? ''),
    rollbackResult
  )
  check('NOT NULL 失败后整表无部分导入', guarded[0]?.[0] === 0, guarded)
  check('NOT NULL 失败后事务已回滚', transaction.active === false, transaction)
  check('回滚后失败结果不把写入行数算作成功', rollbackResult.rowsImported === 0, rollbackResult)

  // 7) 目标列白名单
  const unknownPath = join(workDir, 'unknown-column.csv')
  writeFileSync(unknownPath, 'id,email,note,evil\n1,a@example.com,ok,x\n', 'utf8')
  const unknown = manager.startImport(
    importRequest(target('guarded'), unknownPath, ['id', 'email', 'note', 'evil'])
  )
  const unknownResult = await manager.waitImport(unknown.taskId)
  check('未知目标列被驱动白名单拒绝', unknownResult.status === 'failed', unknownResult)
  check(
    '白名单错误包含未知列名',
    /evil/.test(unknownResult.message ?? ''),
    unknownResult.message
  )
  check(
    '批次级目标列错误不伪造首行位置',
    unknownResult.row === undefined && unknownResult.line === undefined,
    unknownResult
  )

  // 8) 连接上已有用户未提交事务时拒绝导入，绝不替用户提交或回滚它。
  await manager.insertRow(target('multi_batch'), {
    id: { kind: 'number', value: 999 },
    value: { kind: 'text', text: 'pending-user-edit' }
  })
  const guardPath = join(workDir, 'active-user-transaction.csv')
  writeFileSync(guardPath, 'id,email,note\n9,guard@example.com,ok\n', 'utf8')
  const guardTask = manager.startImport(
    importRequest(target('imported_users'), guardPath, ['id', 'email', 'note'])
  )
  const guardResult = await manager.waitImport(guardTask.taskId)
  const userTransaction = await manager.transactionState(`connection:${connectionId}`)
  check('已有用户事务时导入失败', guardResult.status === 'failed', guardResult)
  check(
    '拒绝原因说明未提交事务',
    /未提交事务/.test(guardResult.message ?? ''),
    guardResult.message
  )
  check('用户未提交事务仍保持活动', userTransaction.active === true, userTransaction)
  await manager.rollbackTransaction(`connection:${connectionId}`)

  // 9) 已有批次后取消，仍回滚整次导入。
  // 这里直接使用 DriverHostHandle + ImportManager，并在每个批次返回前延迟，
  // 确保测试能观察到 rowsImported > 0 后再发取消，而不是碰运气抢时序。
  const host = new DriverHostHandle({ dialectId: 'sqlite' })
  try {
    await host.handshake
    await host.connect(
      { dialectId: 'sqlite', name: 'cancel-host', options: { file: dbFile } },
      {}
    )
    let emptyBatchError = null
    try {
      await host.importBatch('table:cancel_target', {
        batchIndex: 0,
        columns: ['id', 'value'],
        rows: []
      })
    } catch (error) {
      emptyBatchError = error
    }
    const emptyBatchState = await host.transactionState()
    check(
      'SQLite 空批次被明确拒绝',
      emptyBatchError instanceof Error && /空/.test(emptyBatchError.message),
      emptyBatchError instanceof Error ? emptyBatchError.message : emptyBatchError
    )
    check('空批次不会启动导入事务', emptyBatchState.active === false, emptyBatchState)
    const cancelManager = new ImportManager({
      writeBatch: async (_targetNodeId, batch) => {
        const written = await host.importBatch('table:cancel_target', batch)
        await new Promise((res) => setTimeout(res, 50))
        return written
      },
      commit: () => host.commitTransaction(),
      rollback: () => host.rollbackTransaction(),
      transactionState: () => host.transactionState()
    })
    const cancelPath = join(workDir, 'cancel.csv')
    const body = ['id,value', ...Array.from({ length: 40 }, (_, i) => `${i + 1},v${i + 1}`)].join('\n')
    writeFileSync(cancelPath, `${body}\n`, 'utf8')
    const cancelTask = cancelManager.start({
      ...importRequest('table:cancel_target', cancelPath, ['id', 'value'], 2)
    })
    let cancelProgress = cancelManager.get(cancelTask.taskId)
    const deadline = Date.now() + 5_000
    while (
      cancelProgress !== undefined &&
      cancelProgress.status === 'running' &&
      cancelProgress.rowsImported === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((res) => setTimeout(res, 5))
      cancelProgress = cancelManager.get(cancelTask.taskId)
    }
    const cancelAccepted = cancelManager.cancel(cancelTask.taskId)
    const cancelResult = await cancelManager.wait(cancelTask.taskId)
    check('观察到已写入批次后才发起取消', cancelProgress?.rowsImported > 0, cancelProgress)
    check('取消请求被接受', cancelAccepted === true)
    check('取消后任务进入 cancelled 终态', cancelResult.status === 'cancelled', cancelResult)
    check('取消后已写入行数归零', cancelResult.rowsImported === 0, cancelResult)
    const cancelledRows = await runQuery(manager, connectionId, 'SELECT COUNT(*) FROM cancel_target')
    check('取消后整次导入已回滚', cancelledRows[0]?.[0] === 0, cancelledRows)
  } finally {
    await host.close()
  }

  // 10) 断开连接先取消并等待 ImportManager 回滚，不能让通用清理抢先结束导入事务。
  let releaseDisconnectBatch = () => {}
  let markDisconnectBatchWritten = () => {}
  const disconnectBatchWritten = new Promise((resolve) => {
    markDisconnectBatchWritten = resolve
  })
  const disconnectBatchGate = new Promise((resolve) => {
    releaseDisconnectBatch = resolve
  })
  let heldDisconnectBatch = false
  DriverHostHandle.prototype.importBatch = async function (...args) {
    const result = await originalImportBatch.apply(this, args)
    if (!heldDisconnectBatch) {
      heldDisconnectBatch = true
      markDisconnectBatchWritten()
      await disconnectBatchGate
    }
    return result
  }
  try {
    const disconnectPath = join(workDir, 'disconnect-import.csv')
    writeFileSync(disconnectPath, 'id,value\n1,first\n2,second\n', 'utf8')
    const disconnectTask = manager.startImport(
      importRequest(target('disconnect_import'), disconnectPath, ['id', 'value'], 1)
    )
    await disconnectBatchWritten
    const disconnectPromise = manager.disconnectConnection(connectionId)
    releaseDisconnectBatch()
    const disconnectResult = await manager.waitImport(disconnectTask.taskId)
    await disconnectPromise

    const reader = new DatabaseSync(dbFile)
    let disconnectRows
    try {
      disconnectRows = reader.prepare('SELECT COUNT(*) AS count FROM disconnect_import').get().count
    } finally {
      reader.close()
    }
    check(
      '断开连接时由 ImportManager 完成取消回滚并等待任务收尾',
      disconnectResult.status === 'cancelled' &&
        /已回滚本任务写入/.test(disconnectResult.message ?? '') &&
        !/回滚也失败/.test(disconnectResult.message ?? '') &&
        disconnectRows === 0 &&
        manager.list().find((item) => item.id === connectionId)?.connected === false,
      { result: disconnectResult, disconnectRows }
    )
  } finally {
    releaseDisconnectBatch()
    DriverHostHandle.prototype.importBatch = originalImportBatch
  }

  await manager.disposeAll()
}

function pgConnectionOptions(pgUrl) {
  const url = new URL(pgUrl)
  return {
    options: {
      host: url.hostname,
      port: url.port === '' ? '5432' : url.port,
      database: decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres'),
      user: decodeURIComponent(url.username || 'postgres')
    },
    password: url.password === '' ? undefined : decodeURIComponent(url.password)
  }
}

async function runPostgresBranch(modules, pgUrl) {
  const { ConnectionManager, ConnectionStore } = modules
  const { options, password } = pgConnectionOptions(pgUrl)
  const metadata = [
    {
      id: 'postgresql',
      name: 'PostgreSQL',
      fields: [
        { key: 'host', label: '主机', kind: 'text', required: true },
        { key: 'port', label: '端口', kind: 'number', required: true },
        { key: 'database', label: '数据库', kind: 'text', required: true },
        { key: 'user', label: '用户名', kind: 'text', required: true },
        { key: 'password', label: '密码', kind: 'password', secretKey: 'dbPassword', required: false }
      ],
      quoting: { open: '"', close: '"', escape: 'double' },
      scriptRules: { statements: [], delimiters: [] }
    }
  ]
  const manager = new ConnectionManager(
    metadata,
    new ConnectionStore({
      baseDir: join(workDir, 'pg-store'),
      cipher: {
        encrypt: (plain) => Buffer.from(plain, 'utf8'),
        decrypt: (payload) => payload.toString('utf8')
      }
    })
  )
  const summary = await manager.add(
    { dialectId: 'postgresql', name: 'import-pg', options },
    password
  )
  if (summary.connected !== true) {
    check('PostgreSQL 导入连接真实建立成功', false, summary)
    await manager.disposeAll()
    return
  }
  check('PostgreSQL 导入连接真实建立成功', true)

  const connectionId = summary.id
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`
  const okTable = `import_ok_${suffix}`
  const rollbackTable = `import_rollback_${suffix}`
  await manager.executeStatement(
    `connection:${connectionId}`,
    `CREATE TABLE public.${okTable} (id integer PRIMARY KEY, email text NOT NULL)`
  )
  await manager.executeStatement(
    `connection:${connectionId}`,
    `CREATE TABLE public.${rollbackTable} (id integer PRIMARY KEY, email text NOT NULL)`
  )
  try {
    const okPath = join(workDir, 'pg-ok.csv')
    writeFileSync(okPath, 'id,email\n1,a@example.com\n2,b@example.com\n', 'utf8')
    const okTask = manager.startImport(
      importRequest(`connection:${connectionId}|table:public.${okTable}`, okPath, ['id', 'email'], 1)
    )
    const okResult = await manager.waitImport(okTask.taskId)
    check('PostgreSQL CSV 导入成功', okResult.status === 'completed', okResult)
    const okCount = await runQuery(manager, connectionId, `SELECT COUNT(*)::int FROM public.${okTable}`)
    check('PostgreSQL 导入数据行数正确', okCount[0]?.[0] === 2, okCount)

    const failPath = join(workDir, 'pg-fail.csv')
    writeFileSync(failPath, 'id,email\n1,a@example.com\n2,\n', 'utf8')
    const failTask = manager.startImport(
      importRequest(
        `connection:${connectionId}|table:public.${rollbackTable}`,
        failPath,
        ['id', 'email'],
        1
      )
    )
    const failResult = await manager.waitImport(failTask.taskId)
    const rollbackCount = await runQuery(
      manager,
      connectionId,
      `SELECT COUNT(*)::int FROM public.${rollbackTable}`
    )
    check('PostgreSQL NOT NULL 导入失败', failResult.status === 'failed', failResult)
    check('PostgreSQL 失败后整表回滚', rollbackCount[0]?.[0] === 0, rollbackCount)
  } finally {
    await manager.executeStatement(`connection:${connectionId}`, `DROP TABLE IF EXISTS public.${okTable}`)
    await manager.executeStatement(
      `connection:${connectionId}`,
      `DROP TABLE IF EXISTS public.${rollbackTable}`
    )
    await manager.disposeAll()
  }
}

async function main() {
  try {
    await ensureDriverHost()
    const modules = await loadModules()
    await runImportManagerContractBranch(modules)
    await runSqliteBranch(modules)
    const pgUrl = process.env.DBSTUDIO_PG_URL
    if (pgUrl === undefined || pgUrl.trim() === '') {
      skip(
        'PostgreSQL CSV 导入',
        'DBSTUDIO_PG_URL 未设置；PostgreSQL 分支明确跳过（SQLite 覆盖仍已执行）'
      )
    } else {
      await runPostgresBranch(modules, pgUrl)
    }
  } catch (error) {
    console.error('[e2e-import-task] 测试准备失败:', error)
    results.push({ name: '测试准备', passed: false })
  }

  const failed = results.filter((result) => !result.passed)
  const skipped = results.filter((result) => result.skipped)
  console.log(
    `\nSUMMARY: ${results.length - failed.length - skipped.length} passed, ` +
      `${failed.length} failed, ${skipped.length} skipped`
  )
  if (failed.length > 0) {
    console.error(`失败断言: ${failed.map((result) => result.name).join(' / ')}`)
    process.exitCode = 1
  }
  rmSync(workDir, { recursive: true, force: true })
}

await main()
