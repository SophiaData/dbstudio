/**
 * 结果集读取契约。
 *
 * ===== 这一层的核心矛盾：主进程不能一次性把十万行塞给渲染进程 =====
 *
 * DBeaver 在单进程内直接持有 `ResultSet`，网格要哪一段就 `seek` 到哪一段，
 * 没有跨进程成本。它的解法是「滚动条以行为单位、总数就是已加载行数」——
 * 控件从不需要知道结果集究竟有多少行（见剖析报告 04：
 * `LightGrid.java#L1057` 的 `getItemCount() = gridRows.length`，
 * `#L2581-L2589` 的 `max = getItemCount() + 1`）。
 *
 * 我们在 Electron 里多了一段 IPC，所以必须额外设计**游标**：
 *   - 一次 `query` 只取一页（默认 200 行），返回游标 id + 是否还有更多
 *   - 后续分页用 `fetchPage(cursorId, offset)` 拉任意页
 *   - 网格虚拟滚动到可见区时按需要数据，而不是「先全拿下来再滚」
 *
 * **为什么不复用 DBeaver 的"总数 = 已加载数"做法**：
 * 那是单进程内的偷懒（数据已经在内存里，翻到底只是换个下标）。
 * 跨进程时若照抄，用户滚到第 5 屏就要求我们持有前 1000 行，
 * 而这些数据在渲染进程里其实是 garbage——白占内存还拖慢 IPC。
 * 所以这里显式支持**按偏移量随机取页**，让渲染进程只保留可视区附近的窗口。
 */

/** 一列的结果集元信息（区别于 `ColumnDescription`——这里不含主键语义）。 */
export interface ResultColumn {
  readonly name: string
  /**
   * 值的类型类别。UI 据此决定对齐方式与渲染器，
   * 但不据此做格式转换（格式化属于展示层）。
   */
  readonly type: ResultValueType
}

export type ResultValueType =
  | 'integer'
  | 'real'
  | 'text'
  | 'blob'
  | 'null'
  | 'boolean'
  | 'date'
  | 'unknown'

/**
 * 单元格值的线上表示。
 *
 * 关键约束：**必须能结构化克隆**，且不能让单个值撑爆 IPC。
 * 所以：
 *   - 大文本 / BLOB **不传全文**，只传长度与截断后的预览（`truncated: true`）
 *   - 二进制一律走 base64 短预览，完整内容要用额外接口单独取
 *
 * 依据：DBeaver 用 `MAX_CELL_TEXT_LENGTH = 1000` / `MAX_TOOLTIP_LENGTH = 250`
 * 做三层截断来保护渲染（剖析报告 04 问题 7，`LightGrid.java#L54-L55`）。
 * 这里把截断**前移到数据通道**——跨进程传输时，截断比在 UI 层截断收益更大，
 * 因为它直接减少了序列化与 IPC 体积。
 */
export type CellValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'text'; readonly text: string; readonly truncated?: boolean; readonly fullLength?: number }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'blob'; readonly previewBase64: string; readonly length: number; readonly truncated: boolean }

/** 单文本值的传输上限（字符）。超出则截断并标记。 */
export const MAX_CELL_TEXT_CHARS = 1000
/** 单 BLOB 预览的字节上限。 */
export const MAX_BLOB_PREVIEW_BYTES = 256

export interface ResultRow {
  /** 行在结果集中的绝对下标（0 起），用于把服务端行映射回 UI 的虚拟滚动位置。 */
  readonly index: number
  readonly cells: readonly CellValue[]
}

export interface ResultPage {
  /** 列元信息。每页都带，让渲染进程不必额外记一份元数据。 */
  readonly columns: readonly ResultColumn[]
  readonly rows: readonly ResultRow[]
  /** 这一页的起始绝对下标。 */
  readonly offset: number
  /** 本页实际取到的行数——可能小于请求的 `limit`（说明已到末尾）。 */
  readonly returned: number
  /**
   * 是否还有更多行。
   *
   * ⚠️ 这是**推断**，不是 `COUNT(*)`。
   * 依据：DBeaver 的 `hasMoreData` 也是「本次拉回的行数 ≥ 请求上限」来推断，
   * 并不查总数（剖析报告 04 问题 2，`ResultSetDataReceiver.java#L186`）。
   * 查总数在大表上是全表扫描，代价不可接受；真正需要总数是一个**显式动作**。
   */
  readonly hasMore: boolean
}

export interface QueryOptions {
  /** 本次请求的页大小，服务端会 clamp 到合理范围。 */
  readonly limit?: number
  /** 起始偏移（默认 0）。 */
  readonly offset?: number
  /**
   * 是否把这次查询与已打开的游标一起保留，以便后续随机取页。
   * 一次性查询（比如 SELECT COUNT）可以传 false，避免占着句柄。
   */
  readonly keepCursor?: boolean
}

export interface QueryResult extends ResultPage {
  /** 游标 id。为空表示这次查询没有保留游标（`keepCursor: false`）。 */
  readonly cursorId: string | null
  /** 服务端实际执行的 SQL（用户可能只写了语句片段，UI 需要回显）。 */
  readonly executedSql: string
  /** 查询耗时（毫秒），UI 可直接展示。 */
  readonly elapsedMs: number
}

/** 方言生成的执行计划，保持计划格式与原始 SQL 一起可追溯。 */
export interface ExplainResult {
  readonly dialectId: string
  readonly columns: readonly ResultColumn[]
  readonly rows: readonly ResultRow[]
  readonly format: 'tabular' | 'text' | 'json'
  readonly executedSql: string
}

/**
 * 网格编辑契约。
 *
 * 一条规则：**没有唯一键就不能改**。
 * 依据：DBeaver 的 `ResultSetPersister.checkEntityIdentifiers` 在缺
 * `DBDRowIdentifier` 时直接抛 "No unique key defined"（剖析报告 04 问题 5）。
 * 我们把这条规则提前到 `TableDescription.hasUniqueKey`，
 * UI 在用户动手之前就能提示，而不是等提交时才报错。
 */

/**
 * 要提交的一次行修改。
 *
 * ===== 为什么用主键值而不是 rowIndex 定位行（这里推翻了我的初版设计）=====
 *
 * 初版把 `rowIndex`（行在结果集中的下标）当作行标识，那是错的：
 *
 *   1. **拼不出 WHERE**。UPDATE 语句需要 `WHERE pk = ?`，
 *      而下标根本不存在于数据库里。
 *   2. **下标会漂移**。用户重排序、重新查询、并发插入之后，
 *      第 5 行早已不是当初那行——用它去改数据就是改错行，且无声无息。
 *   3. 这正是 DBeaver 要求 `DBDRowIdentifier` 的原因：
 *      它要的是「能唯一定位一行的那组列值」，不是位置。
 *
 * 所以这里改成携带**主键列的值**。`keyValues` 的每个值都来自结果集本身，
 * 由 adapter 转成 SQL 参数进 WHERE；`changes` 进 SET。
 */
export interface RowUpdate {
  /** 主键列名 → 该行对应列的原值。WHERE 子句的全部内容。 */
  readonly keyValues: Readonly<Record<string, CellValue>>
  /** 要改的列名 → 新值。只含被改的列。 */
  readonly changes: Readonly<Record<string, CellValue>>
}

/** 单行更新的结果。批量里某一行失败不影响其它行（在事务里统一回滚）。 */
export interface RowEditOutcome {
  /** 这条更新对应的是第几条（从 0 起，对应入参数组下标），便于 UI 定位。 */
  readonly index: number
  readonly affected: number
  /** 失败原因；成功时为 null。 */
  readonly error: string | null
  /** 实际执行的参数化 SQL 模板（`?` 占位），用于「SQL 日志」与排查。 */
  readonly sql: string
}

export interface EditApplyResult {
  /** 全部更新的总影响行数。 */
  readonly affected: number
  /** 逐行结果。任何一行失败时，其余行仍会出现在这里，但整体要回滚。 */
  readonly outcomes: readonly RowEditOutcome[]
  /** 是否全部成功。false 时调用方应决定 rollback 还是人工处理。 */
  readonly ok: boolean
  /**
   * 是否仍在事务中（未提交）。
   * DBeaver 的 `ResultSetPersister` 构造时即 `autocommit = false`（剖析报告 04 问题 5），
   * 这里沿用：applyEdits 之后**不会自动提交**，必须显式 commit。
   */
  readonly inTransaction: boolean
}

/**
 * 语句执行的统一结果。
 *
 * 为什么必须是 Discriminated Union 而不是把所有字段塞进一个扁平对象：
 * 1. 查询返回结果集与游标，供网格分页展示；
 * 2. DML 返回受影响行数与当前事务状态；
 * 3. DDL 返回变更摘要与提交标志。
 * 绝不能把 affected 塞进 QueryResult.rows（那会让返回 0 行与影响 0 行混淆）。
 */
export type StatementResult =
  | {
      readonly kind: 'rows'
      readonly result: QueryResult
    }
  | {
      readonly kind: 'affected'
      readonly affected: number
      readonly inTransaction: boolean
      readonly transactionState: TransactionState
      readonly executedSql: string
      readonly elapsedMs: number
    }
  | {
      readonly kind: 'ddl'
      readonly summary: string
      readonly affected?: number
      readonly committed: boolean
      readonly executedSql: string
      readonly elapsedMs: number
    }

/** 事务状态。UI 用它决定「应用」按钮是否可用、要不要提示未提交改动。 */
export interface TransactionState {
  readonly active: boolean
  /** 已在本事务中累计影响的行数，供 UI 提示。 */
  readonly pendingAffected: number
}

/**
 * 把 `CellValue` 还原成可以绑定到 SQL 参数的值。
 *
 * 放在 core 而不是各 adapter 里，因为**测试也要用同一套转换**——
 * 如果测试自己写一份，就会出现「测试通过但真实写入是错的」这类假绿。
 *
 * 注意：`blob` 只还原预览段（`previewBase64`）。若原值被截断过，
 * 用它回写会**写坏数据**，所以这里对截断的 blob 直接抛错，
 * 而不是静默写一个残缺值。
 */
export function cellValueToSqlParam(value: CellValue): string | number | boolean | null | Uint8Array {
  switch (value.kind) {
    case 'null':
      return null
    case 'number':
      return value.value
    case 'boolean':
      return value.value
    case 'text':
      if (value.truncated) {
        throw new Error(
          '不能把被截断的文本写回数据库：页面只持有前若干字符，回写会破坏原值。' +
            '请先完整读取该单元格再编辑。'
        )
      }
      return value.text
    case 'blob':
      if (value.truncated) {
        throw new Error(
          '不能把被截断的二进制预览写回数据库：会写坏原值。' +
            '大字段编辑属于后续阶段。'
        )
      }
      return Uint8Array.from(Buffer.from(value.previewBase64, 'base64'))
    default: {
      const never: never = value
      throw new Error(`无法转换的单元格值: ${JSON.stringify(never)}`)
    }
  }
}
