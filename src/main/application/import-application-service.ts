/**
 * 导入用例服务：CSV 预览、导入任务生命周期与导入事务所有权。
 *
 * ===== 为什么从 ConnectionManager 里抽出来 =====
 *
 * 导入这一组方法看起来只是「转发给 ImportManager」，但它们共享三条必须
 * 在同一处保持的时序：
 *
 *   1. **预览的同步校验**：对象、`sourcePath` 绝对路径、单字符分隔符、
 *      `nullText`、`hasHeader` 必须在 `readFile` 之前判完，错误文案是 UI
 *      直接展示的契约；
 *   2. **启动前守卫**：`startImport` 必须先同步解析目标连接、检查连接是否
 *      正在关闭、检查该连接上是否有在途外部写，然后才调用 `ImportManager.start`。
 *      这些检查必须发生在**首个 await 之前**，否则「用户写请求在途」与
 *      「导入预检」之间会重新出现竞态窗口（见 `connection-activity-guard`）；
 *   3. **导入事务所有权**：任务内部的 `writeBatch` / `commit` / `rollback` /
 *      `transactionState` 只能直接走 `resolver.resolveConnection` + `conn.host`，
 *      **不能**经过普通的 `MutationApplicationService`。普通写入口带有导入互斥
 *      守卫与在途写租约，导入自己的事务控制一旦走那条路就会被自己的守卫拒绝，
 *      或者被计入外部写租约，破坏「导入事务只由 ImportManager 提交/回滚」的
 *      所有权模型。
 *
 * 把这三件事集中到本模块后，`ConnectionManager` 只保留兼容 facade，
 * 导入路径也可以被独立阅读，不会因为会话/目录的改动被牵连。
 *
 * ===== 边界 =====
 *
 * 本模块**不** import `ConnectionManager`、electron、`src/drivers` 或任何具体
 * adapter。它只认识：
 *
 *   - `ConnectionResolver`：节点/连接 id → 活动会话；
 *   - `isClosing`：连接是否正在断开（会话服务的最小能力）；
 *   - `getActivity`：在途外部写计数（活动守卫的最小能力）；
 *   - `ImportManager`：导入任务编排（本模块负责创建并持有它）。
 *
 * `LiveConnection.host` 只以类型出现（经 `types.ts` 的 `import type`），
 * 因此本模块没有额外的运行时依赖会顺着宿主句柄进入 driver-host 之外的地方。
 *
 * ===== 构造顺序 =====
 *
 * `ConnectionManager` 的构造顺序是「传输 → 导入 → 会话 → 解析器 → 活动守卫」：
 * 会话服务需要导入任务组的 `cancelByConnection` / `waitByConnection`，
 * 活动守卫又需要导入任务组的 `activeTaskByConnection`。因此这里用 getter /
 * 回调注入，而不是在构造时直接持有那些实例——回调真正执行时它们已经就绪。
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { NodeId } from '../../core/api'
import { previewCsv } from '../../core/csv'
import type { TransactionState } from '../../core/resultset'
import type {
  ImportBatch,
  ImportBatchResult,
  ImportPreview,
  ImportPreviewRequest,
  ImportProgress,
  ImportRequest,
  ImportResult
} from '../../core/transfer'
import { ImportManager } from '../ImportManager'
import type { ConnectionActivityGuard } from './connection-activity-guard'
import type { ConnectionResolver } from './connection-resolver'
import type { ConnectionLogger } from './types'

/** 导入用例服务的外部依赖。全部是最小能力注入，避免反向依赖 ConnectionManager。 */
export interface ImportApplicationContext {
  /** 惰性读取统一的连接解析器（构造顺序上晚于本服务）。 */
  readonly getResolver: () => ConnectionResolver
  /** 该连接是否有正在进行的断开流程。startImport 在首个 await 前同步查询。 */
  readonly isClosing: (connectionId: string) => boolean
  /** 惰性读取活动守卫（构造顺序上晚于本服务）。 */
  readonly getActivity: () => ConnectionActivityGuard
  readonly onLog: ConnectionLogger
}

export class ImportApplicationService {
  readonly #ctx: ImportApplicationContext
  readonly #manager: ImportManager

  constructor(context: ImportApplicationContext) {
    this.#ctx = context
    this.#manager = new ImportManager({
      /**
       * 导入写入与事务控制**直接走宿主**，不经过 MutationApplicationService。
       *
       * 原因见文件头第 3 条：普通变更入口的守卫与租约是为「外部写」设计的，
       * 导入自己拥有事务，必须走无守卫的内部通道。
       */
      writeBatch: (targetNodeId, batch) => this.#writeImportBatch(targetNodeId, batch),
      commit: (targetNodeId) => this.#commitImport(targetNodeId),
      rollback: (targetNodeId) => this.#rollbackImport(targetNodeId),
      transactionState: (targetNodeId) => this.#importTransactionState(targetNodeId),
      // 连接归属只在节点 id 的前缀里；与拆分前一致，解析失败返回 undefined。
      resolveConnectionId: (targetNodeId) => NodeId.parse(targetNodeId)?.connectionId,
      onLog: (level, msg) => this.#ctx.onLog(level, msg)
    })
  }

  /**
   * 任务组本身。
   *
   * 会话服务只需要 `cancelByConnection` / `waitByConnection`，活动守卫只需要
   * `activeTaskByConnection`。暴露管理器而不是复制这些方法，避免出现第二份
   * 「哪些任务属于该连接」的判断。
   */
  get manager(): ImportManager {
    return this.#manager
  }

  /**
   * 在主进程读取 CSV 并返回有界预览；完整文件内容不会经过 IPC。
   *
   * 校验顺序与文案逐字保留（对象 → sourcePath 存在 → 绝对路径 → 分隔符 →
   * nullText → hasHeader），全部在 `readFile` 之前完成。
   */
  async previewImport(request: ImportPreviewRequest): Promise<ImportPreview> {
    if (typeof request !== 'object' || request === null) {
      throw new Error('预览请求必须是对象')
    }
    if (typeof request.sourcePath !== 'string' || request.sourcePath.trim() === '') {
      throw new Error('预览请求缺少 sourcePath')
    }
    if (!isAbsolute(request.sourcePath)) {
      throw new Error(`CSV 文件路径必须是绝对路径：${request.sourcePath}`)
    }
    if (typeof request.delimiter !== 'string' || request.delimiter.length !== 1) {
      throw new Error('CSV 分隔符必须是单个字符')
    }
    if (typeof request.nullText !== 'string') {
      throw new Error('CSV NULL 标记必须是字符串')
    }
    if (typeof request.hasHeader !== 'boolean') {
      throw new Error('CSV hasHeader 必须是布尔值')
    }
    const bytes = await readFile(request.sourcePath)
    const parsed = previewCsv(bytes, {
      delimiter: request.delimiter,
      nullText: request.nullText,
      hasHeader: request.hasHeader,
      sampleRowLimit: request.sampleRowLimit
    })
    return { sourcePath: request.sourcePath, ...parsed }
  }

  /**
   * 启动一个导入任务。
   *
   * ===== 顺序不能变 =====
   *
   * 1. **同步解析目标连接**：避免先拿到 taskId 再发现连接根本不存在；
   * 2. **同步拒绝正在关闭的连接**：断开流程会取消该连接上的导入，此时
   *    再建新任务只会立刻被取消；
   * 3. **同步拒绝在途外部写**：连接上还有写请求没结束（用户事务尚未建立）时，
   *    导入的预检可能恰好跑在空窗里而放行，随后 `importBatch` 撞上用户事务，
   *    ImportManager 会把自己当成事务所有者把用户事务回滚掉。必须在同一同步段
   *    内拒绝；等写操作 `finally` 释放租约后用户可重试；
   * 4. 最后才调用 `ImportManager.start`，保证任务不会在拒绝前先被建出来。
   *
   * 前三步都在首个 await 之前完成（本方法没有 await），因此 JS 单线程下
   * 与 `beginWrite` 的登记之间没有让出点，二者的先后顺序是确定的。
   */
  startImport(request: ImportRequest): ImportProgress {
    const { conn } = this.#ctx.getResolver().resolveConnection(request.targetNodeId)
    if (this.#ctx.isClosing(conn.id)) {
      throw new Error(`连接 ${conn.id} 正在断开，不能再启动导入任务。`)
    }
    const pendingWrites = this.#ctx.getActivity().pendingWriteCount(conn.id)
    if (pendingWrites > 0) {
      throw new Error(
        `连接 ${conn.id} 上还有 ${pendingWrites} 个写操作正在进行，已拒绝启动导入。` +
          '请等待这些写操作完成（或先提交/回滚）后重试，以免导入事务与用户事务交叉。'
      )
    }
    return this.#manager.start(request)
  }

  /** 取导入任务进度。未知 id 返回 undefined。 */
  getImportProgress(taskId: string): ImportProgress | undefined {
    return this.#manager.get(taskId)
  }

  /** 取消导入任务。返回 false 表示任务不存在、已结束或已进入不可取消的提交阶段。 */
  cancelImport(taskId: string): boolean {
    return this.#manager.cancel(taskId)
  }

  /** 等待导入任务结束，返回终态结果。 */
  async waitImport(taskId: string): Promise<ImportResult> {
    return this.#manager.wait(taskId)
  }

  /** 应用退出时收尾所有导入任务（取消未结束任务并等待其回滚完成）。 */
  dispose(): Promise<void> {
    return this.#manager.dispose()
  }

  /**
   * 导入批次写入。
   *
   * 目标必须是具体表：连接节点没有可写入的 adapterId，沿用拆分前的原错误文案。
   * `adapterId` 原样交给宿主——驱动自己认识 `table:<name>`，主进程不解析驱动
   * 私有的 id 编码。
   */
  #writeImportBatch(targetNodeId: string, batch: ImportBatch): Promise<ImportBatchResult> {
    const { conn, adapterId } = this.#ctx.getResolver().resolveConnection(targetNodeId)
    if (adapterId === null) {
      return Promise.reject(new Error('连接节点不能作为导入目标，请选择具体的表'))
    }
    return conn.host.importBatch(adapterId, batch)
  }

  /**
   * 提交导入事务。
   *
   * 只解析连接，不检查 adapterId：事务是连接级状态，`resolveConnection`
   * 对连接节点同样返回会话。这里**不**走普通事务服务，否则会被导入互斥守卫拒绝。
   */
  #commitImport(targetNodeId: string): Promise<TransactionState> {
    const { conn } = this.#ctx.getResolver().resolveConnection(targetNodeId)
    return conn.host.commitTransaction()
  }

  /** 回滚导入事务。幂等性由宿主保证；同样绕开普通事务服务。 */
  #rollbackImport(targetNodeId: string): Promise<TransactionState> {
    const { conn } = this.#ctx.getResolver().resolveConnection(targetNodeId)
    return conn.host.rollbackTransaction()
  }

  /** 写入前的事务状态预检；同样直接走宿主。 */
  #importTransactionState(targetNodeId: string): Promise<TransactionState> {
    const { conn } = this.#ctx.getResolver().resolveConnection(targetNodeId)
    return conn.host.transactionState()
  }
}
