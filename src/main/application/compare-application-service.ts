/**
 * 数据比较用例服务：按唯一键比较两张表，并生成同步计划。
 *
 * ===== 为什么从 ConnectionManager 里抽出来 =====
 *
 * `compareTableData` 是一条**跨越读写两侧**的只读用例：它先解析两张表所属的
 * 会话、读结构（describeTable），再用查询服务分页取数，最后交给纯 core
 * 比较器生成差异。它本身不持有任何状态，只负责把顺序、守卫与降级规则固定下来。
 *
 * 把这段逻辑单独放进来，`ConnectionManager` 就只剩兼容 facade；而比较路径
 * 可以被独立阅读与测试，也不会再因为会话生命周期或任务编排的改动被牵连。
 *
 * ===== 边界 =====
 *
 * 本模块**不** import `ConnectionManager`、electron、`src/drivers` 或任何具体
 * adapter。它只认识：
 *
 *   - `ConnectionResolver`：节点 id → 活动会话（跨方言拒绝与表名还原要用）；
 *   - `MetadataApplicationService`：`describeTable`；
 *   - `QueryApplicationService`：`runQuery` / `fetchResultPage` /
 *     `fetchCellValue` / `closeCursor`；
 *   - core 的纯比较函数（`compareDataRows`）。
 *
 * ===== 必须保持的顺序与契约 =====
 *
 * 1. **方言守卫最先跑**：跨方言无论如何都不支持，先报这件事，用户才不会
 *    先看到「缺少比较键列」这类由误配表引起的次生错误。
 * 2. **跨方言必须拒绝**：两边值类型映射不同（如 PG 的 int8 当文本、SQLite
 *    当 number），按键对齐后每个键都会被判成「源端独有 + 目标端独有」，
 *    生成一张全表 DELETE + 全表 INSERT 的错误计划。
 * 3. **maxRows 是硬上限**：超过即拒绝，绝不截断后给出「看起来没差异」的结论。
 * 4. **二进制列剔除并告警**：比较键是二进制列时直接拒绝；其余二进制列
 *    不参与比较，但必须在 warnings 里说明。
 * 5. **游标必须 finally 关闭**：即使读取中途抛错，也不能把宿主游标留在那里。
 * 6. **错误文案逐字保留**：所有用户可见消息与拆分前一致。
 */

import {
  compareDataRows,
  type CompareDialect,
  type DataCompareRequest,
  type DataCompareResult,
  type DataCompareRow
} from '../../core/compare'
import { quoteIdentifierWith } from '../../core/driver'
import type { CellValue, ResultPage } from '../../core/resultset'
import type { ConnectionResolver } from './connection-resolver'
import type { MetadataApplicationService } from './metadata-application-service'
import type { QueryApplicationService } from './query-application-service'

/**
 * 数据比较用例服务的外部依赖。
 *
 * `metadata` 与 `queries` 都是已经抽出的用例服务；本模块不再重复实现
 * 连接解析、结构读取或分页取数，避免同一规则出现第二份实现。
 */
export interface CompareApplicationContext {
  readonly resolver: ConnectionResolver
  readonly metadata: MetadataApplicationService
  readonly queries: QueryApplicationService
}

export class CompareApplicationService {
  readonly #ctx: CompareApplicationContext

  constructor(context: CompareApplicationContext) {
    this.#ctx = context
  }

  /**
   * 按唯一键比较两张表的数据，返回差异与同步计划。
   *
   * 只读：两侧都只跑 SELECT（runQuery），同步 SQL 只生成不执行。
   * 超过 maxRows 直接拒绝，而不是截断后给出「看起来没差异」的错误结论。
   */
  async compareTableData(request: DataCompareRequest): Promise<DataCompareResult> {
    // 方言守卫必须**最先**跑：跨方言比较无论如何都不支持，先报这件事，
    // 用户才不会先看到「缺少比较键列」这类由误配表引起的次生错误。
    const source = this.#ctx.resolver.resolveConnection(request.sourceTableNodeId)
    const target = this.#ctx.resolver.resolveConnection(request.targetTableNodeId)
    const dialect = target.conn.config.dialectId
    const sourceDialect = source.conn.config.dialectId
    for (const [label, id] of [
      ['源', sourceDialect],
      ['目标', dialect]
    ] as const) {
      if (id !== 'sqlite' && id !== 'postgresql' && id !== 'mysql') {
        throw new Error(`数据比较暂不支持方言：${label} ${id}`)
      }
    }
    // 跨方言比较必须拒绝：两边对同一列的值映射不同（PostgreSQL 把 int8/numeric
    // 当文本返回，SQLite 当 number），按键对齐后每行都会被判成「源端独有+目标端独有」，
    // 于是生成一张全表 DELETE + 全表 INSERT 的「同步计划」——看起来合理，实则灾难。
    if (sourceDialect !== dialect) {
      throw new Error(
        `跨方言数据比较暂不支持（源 ${sourceDialect} → 目标 ${dialect}）：` +
          '两边的值类型映射不同，按行比较会产生假差异。请改用结构比较，或先迁移到同一方言。'
      )
    }
    const maxRows = Math.min(Math.max(request.maxRows ?? 50_000, 1), 500_000)
    const sourceDesc = await this.#ctx.metadata.describeTable(request.sourceTableNodeId)
    const targetDesc = await this.#ctx.metadata.describeTable(request.targetTableNodeId)
    const primary = sourceDesc.columns
      .filter((c) => c.primaryKeyOrdinal !== null)
      .sort((a, b) => (a.primaryKeyOrdinal ?? 0) - (b.primaryKeyOrdinal ?? 0))
      .map((c) => c.name)
    const keyColumns =
      request.keyColumns && request.keyColumns.length > 0 ? [...request.keyColumns] : primary
    if (keyColumns.length === 0) {
      throw new Error('源表没有主键，请指定一组唯一列作为比较键（不支持按行号比较）')
    }
    for (const [label, desc] of [
      ['源表', sourceDesc],
      ['目标表', targetDesc]
    ] as const) {
      const names = new Set(desc.columns.map((c) => c.name))
      const missing = keyColumns.filter((c) => !names.has(c))
      if (missing.length > 0) throw new Error(`${label}缺少比较键列：${missing.join(', ')}`)
    }
    const sharedColumns = sourceDesc.columns
      .map((c) => c.name)
      .filter((name) => targetDesc.columns.some((t) => t.name === name))
    if (sharedColumns.length === 0) throw new Error('两张表没有同名列，无法比较数据')
    /*
     * 二进制列不参与数据比较（BLOB / BYTEA / BINARY 等）：
     * 把二进制内容按文本比较既不可靠，也会把整块数据搬进内存。
     * 这与文档里的语义一致——这里显式剔除并告警，而不是读到该列时才抛错。
     */
    const isBinaryType = (typeName: string): boolean =>
      /(^|\W)(blob|tinyblob|mediumblob|longblob|bytea|binary|varbinary|image)(\W|$)/i.test(typeName)
    const binaryColumns = sharedColumns.filter((name) => {
      const sourceColumn = sourceDesc.columns.find((c) => c.name === name)
      const targetColumn = targetDesc.columns.find((c) => c.name === name)
      return (
        isBinaryType(sourceColumn?.typeName ?? '') || isBinaryType(targetColumn?.typeName ?? '')
      )
    })
    const keyBinary = keyColumns.filter((name) => binaryColumns.includes(name))
    if (keyBinary.length > 0) {
      throw new Error(`比较键不能是二进制列：${keyBinary.join(', ')}`)
    }
    const comparableColumns = sharedColumns.filter((name) => !binaryColumns.includes(name))
    if (comparableColumns.length === 0) {
      throw new Error('两张表没有可比的非二进制列，无法比较数据')
    }
    const sourceRows = await this.#readRowsForCompare(
      request.sourceTableNodeId,
      comparableColumns,
      keyColumns,
      maxRows
    )
    const targetRows = await this.#readRowsForCompare(
      request.targetTableNodeId,
      comparableColumns,
      keyColumns,
      maxRows
    )
    const name = tableNameFromAdapterId(target.adapterId, dialect)
    const result = compareDataRows(
      sourceRows,
      targetRows,
      { columns: keyColumns },
      dialect as CompareDialect,
      name
    )
    // 只比列交集：目标端缺的列不会被比较，必须说出来，否则用户会以为那一列也一致。
    const sourceOnly = sourceDesc.columns
      .map((c) => c.name)
      .filter((n) => !targetDesc.columns.some((t) => t.name === n))
    const targetOnly = targetDesc.columns
      .map((c) => c.name)
      .filter((n) => !sourceDesc.columns.some((t) => t.name === n))
    const warnings = [...result.plan.warnings]
    if (binaryColumns.length > 0) {
      warnings.push(`二进制列不参与数据比较：${binaryColumns.join(', ')}。`)
    }
    if (sourceOnly.length > 0) {
      warnings.push(`源表独有列未参与比较：${sourceOnly.join(', ')}（需要先同步结构）。`)
    }
    if (targetOnly.length > 0) {
      warnings.push(`目标表独有列未参与比较：${targetOnly.join(', ')}（需要先同步结构）。`)
    }
    return { keyColumns, ...result, plan: { ...result.plan, warnings } }
  }

  async #readRowsForCompare(
    tableNodeId: string,
    columns: readonly string[],
    keyColumns: readonly string[],
    maxRows: number
  ): Promise<DataCompareRow[]> {
    const { conn, adapterId } = this.#ctx.resolver.resolveConnection(tableNodeId)
    const { schema, name } = tableNameFromAdapterId(adapterId, conn.config.dialectId)
    const q = (value: string) => quoteIdentifierWith(value, conn.info.quoting)
    const from = schema ? `${q(schema)}.${q(name)}` : q(name)
    const sql = `SELECT ${columns.map(q).join(', ')} FROM ${from} ORDER BY ${keyColumns.map(q).join(', ')}`
    const pageSize = 1000
    const first = await this.#ctx.queries.runQuery(tableNodeId, sql, {
      limit: pageSize,
      keepCursor: true
    })
    const rows: DataCompareRow[] = []
    try {
      let page: ResultPage = first
      let offset = 0
      for (;;) {
        for (const row of page.rows) {
          if (rows.length >= maxRows) {
            throw new Error(`表 ${name} 超过 ${maxRows} 行，已停止比较；请缩小范围或调大上限`)
          }
          const values: Record<string, string | number | boolean | null> = {}
          for (let i = 0; i < columns.length; i += 1) {
            let cell = row.cells[i] ?? { kind: 'null' as const }
            if (cell.kind === 'text' && cell.truncated && first.cursorId !== null) {
              cell = await this.#ctx.queries.fetchCellValue(first.cursorId, row.index, i)
            }
            values[columns[i] as string] = compareValueOf(cell, name, columns[i] as string)
          }
          const key: Record<string, string | number | boolean | null> = {}
          for (const column of keyColumns) key[column] = values[column] ?? null
          rows.push({ key, values })
        }
        offset += page.returned
        if (!page.hasMore || first.cursorId === null) break
        page = await this.#ctx.queries.fetchResultPage(first.cursorId, offset, pageSize)
      }
    } finally {
      if (first.cursorId !== null) {
        await this.#ctx.queries.closeCursor(first.cursorId).catch(() => undefined)
      }
    }
    return rows
  }
}

/**
 * 从 adapter 表 id 还原 schema 与表名（数据比较拼 SELECT 用）。
 *
 * 两种内置编码：SQLite `table:<name>`（名字原样）；PostgreSQL / MySQL
 * `table:<schema>.<name>`，两段内 `\` 转义、以第一个未转义点号分隔。
 * 无法识别时拒绝，而不是猜一个名字去拼 SQL。
 */
export function tableNameFromAdapterId(
  adapterId: string | null,
  dialectId: string
): { schema: string | null; name: string } {
  if (adapterId === null || !adapterId.startsWith('table:')) {
    throw new Error(`数据比较只接受表节点，收到: ${adapterId ?? '连接节点'}`)
  }
  const payload = adapterId.slice('table:'.length)
  if (payload === '') throw new Error(`无法识别的表 id: ${adapterId}`)
  if (dialectId === 'sqlite') return { schema: null, name: payload }
  if (dialectId !== 'postgresql' && dialectId !== 'mysql') {
    throw new Error(`数据比较暂不支持方言：${dialectId}`)
  }
  let head = ''
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload.charAt(i)
    if (ch === '\\') {
      head += payload.charAt(i + 1)
      i += 1
      continue
    }
    if (ch === '.') {
      let tail = ''
      for (let j = i + 1; j < payload.length; j += 1) {
        const c = payload.charAt(j)
        if (c === '\\') {
          tail += payload.charAt(j + 1)
          j += 1
        } else tail += c
      }
      if (head === '' || tail === '') break
      return { schema: head, name: tail }
    }
    head += ch
  }
  throw new Error(`无法识别的 PostgreSQL 表 id: ${adapterId}`)
}

/** 把单元格值折成比较器可消费的标量；截断 / 二进制值直接拒绝，避免假差异。 */
export function compareValueOf(
  cell: CellValue,
  table: string,
  column: string
): string | number | boolean | null {
  switch (cell.kind) {
    case 'null':
      return null
    case 'number':
    case 'boolean':
      return cell.value
    case 'text':
      if (cell.truncated) throw new Error(`${table}.${column} 的长文本无法取全文，已停止比较`)
      return cell.text
    case 'blob':
      throw new Error(`${table}.${column} 是二进制列，暂不支持数据比较`)
  }
}
