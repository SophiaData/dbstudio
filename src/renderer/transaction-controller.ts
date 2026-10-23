import type { DbStudioApi } from '../core/api'
import type { TransactionState } from '../core/resultset'

export interface LocalDirtySummary {
  readonly rows: number
  readonly cells: number
}

/**
 * 控制器刻意只依赖一个很小的「参与者」接口，而不 import ResultGrid。
 *
 * 为什么要这样：事务归属是**连接级**的，而网格是**标签级**的实现细节。
 * 让控制器认识网格，等于把连接协调和具体渲染实现绑在一起，
 * 既容易形成渲染进程内部的循环依赖，也让「换掉网格」变成改连接层的事。
 */
export interface TransactionParticipant {
  readonly transactionParticipantId: string
  readonly connectionNodeId: string
  readonly transactionNodeId: string
  getLocalDirtySummary(): LocalDirtySummary
  applyLocalEditsFromController(): Promise<boolean>
  discardLocalEditsFromController(): void
  refreshFromTransactionController(): Promise<void>
  setTransactionStateFromController(state: TransactionState): void
  reportTransactionControllerStatus(text: string, isError?: boolean): void
}

type Decision =
  | 'apply'
  | 'discard'
  | 'apply-commit'
  | 'discard-rollback'
  | 'cancel'

interface DialogSpec {
  readonly title: string
  readonly message: string
  readonly buttons: readonly { action: Decision; label: string; kind?: 'primary' | 'danger' }[]
}

const controllers = new Map<string, TransactionController>()

/**
 * 每个连接一个控制器。
 *
 * 依据：数据库 adapter 在一个连接上只持有**一个**事务。所以一旦两个结果标签
 * 指向同一个连接，按网格各建一个控制器就必然是错的——它们会各自看到
 * 不同的「未提交」状态，用户在 A 标签提交却提交了 B 标签的改动。
 */
export class TransactionController {
  readonly connectionId: string
  #api: DbStudioApi | null = null
  readonly #participants = new Map<string, TransactionParticipant>()
  #state: TransactionState = { active: false, pendingAffected: 0 }
  #queue: Promise<unknown> = Promise.resolve()

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  register(api: DbStudioApi, participant: TransactionParticipant): () => void {
    this.#api = api
    this.#participants.set(participant.transactionParticipantId, participant)
    participant.setTransactionStateFromController(this.#state)

    return () => {
      this.#participants.delete(participant.transactionParticipantId)
      // 这里刻意**不回滚**。关闭一个标签绝不能影响同一连接上其他标签
      // 正在使用的事务——「关标签」不等于「放弃这个连接的事务」。
      if (this.#participants.size === 0) controllers.delete(this.connectionId)
    }
  }

  async refreshState(participant: TransactionParticipant): Promise<void> {
    await this.#enqueue(async () => {
      const state = await this.#readState(participant)
      this.#broadcastState(state)
    })
  }

  async apply(participant: TransactionParticipant): Promise<boolean> {
    return this.#enqueue(async () => {
      const applied = await participant.applyLocalEditsFromController()
      if (!applied) return false
      await this.#broadcast({ reload: true, source: participant })
      return true
    })
  }

  async commit(participant: TransactionParticipant): Promise<boolean> {
    return this.#enqueue(async () => {
      const state = await this.#readState(participant)
      const dirty = this.#dirtyParticipants()

      if (dirty.length > 0) {
        const choice = await this.#ask(this.#commitSpec(dirty))
        if (choice === 'cancel') return false
        if (choice === 'discard-rollback') {
          for (const item of dirty) item.discardLocalEditsFromController()
        } else if (choice === 'apply-commit') {
          if (!(await this.#applyParticipants(dirty))) return false
        } else {
          return false
        }
      }

      const api = this.#requireApi()
      try {
        // 提交是**连接级**的。node id 在这里只用于告诉主进程「是哪个连接」。
        const next = state.active || dirty.length > 0
          ? await api.commitTransaction(participant.transactionNodeId)
          : { active: false, pendingAffected: 0 }
        this.#broadcastState(next)
        this.#broadcastRefresh()
        participant.reportTransactionControllerStatus('已提交（当前连接）')
        return true
      } catch (e) {
        participant.reportTransactionControllerStatus(`提交失败：${errText(e)}`, true)
        return false
      }
    })
  }

  async rollback(participant: TransactionParticipant): Promise<boolean> {
    return this.#enqueue(async () => {
      const state = await this.#readState(participant)
      const dirty = this.#dirtyParticipants()
      if (state.active || dirty.length > 0) {
        const choice = await this.#ask(this.#rollbackSpec(dirty, state.active))
        if (choice !== 'discard-rollback') return false
      }

      for (const item of dirty) item.discardLocalEditsFromController()
      try {
        const next = state.active
          ? await this.#requireApi().rollbackTransaction(participant.transactionNodeId)
          : { active: false, pendingAffected: 0 }
        this.#broadcastState(next)
        this.#broadcastRefresh()
        participant.reportTransactionControllerStatus('已回滚（当前连接）')
        return true
      } catch (e) {
        participant.reportTransactionControllerStatus(`回滚失败：${errText(e)}`, true)
        return false
      }
    })
  }

  /**
   * 关闭标签前的守卫。
   *
   * 两种状态必须分开对待：
   *   - 本地未应用编辑（`#dirty`）属于**这个标签**，丢弃它不影响别人；
   *   - 已应用进数据库的事务属于**整个连接**，丢弃它会回滚别人的改动。
   */
  async prepareToLeave(participant: TransactionParticipant, action: string): Promise<boolean> {
    return this.#enqueue(async () => {
      const dirty = participant.getLocalDirtySummary()
      if (dirty.rows > 0) {
        const choice = await this.#ask(this.#leaveSpec(participant, action, dirty))
        if (choice === 'cancel') return false
        if (choice === 'apply') {
          if (!(await participant.applyLocalEditsFromController())) return false
        } else {
          participant.discardLocalEditsFromController()
        }
      }

      // 已应用的编辑属于整个连接。若这是最后一个还开着的结果标签，
      // 必须强制让用户明确选择提交还是回滚——否则这个事务会变成
      // 「没人持有、也没人看得见」的状态：用户既看不到它，也关不掉它。
      if (this.#participants.size !== 1) return true
      const state = await this.#readState(participant)
      if (!state.active) return true
      const choice = await this.#ask(this.#globalLeaveSpec(action, [], true))
      if (choice === 'cancel') return false
      try {
        const next =
          choice === 'apply-commit'
            ? await this.#requireApi().commitTransaction(participant.transactionNodeId)
            : await this.#requireApi().rollbackTransaction(participant.transactionNodeId)
        this.#broadcastState(next)
        return true
      } catch (e) {
        participant.reportTransactionControllerStatus(
          `${choice === 'apply-commit' ? '提交' : '回滚'}失败：${errText(e)}`,
          true
        )
        return false
      }
    })
  }

  /**
   * 用户主动触发的重新加载前的守卫。
   *
   * 事务内部的刷新走 `refreshFromTransactionController`，不经过这里——
   * 否则一次提交会弹两次框。
   */
  async prepareToReload(participant: TransactionParticipant): Promise<boolean> {
    return this.#enqueue(async () => {
      const dirty = participant.getLocalDirtySummary()
      if (dirty.rows === 0) return true
      const choice = await this.#ask({
        title: '重新加载结果',
        message:
          `当前标签有 ${dirty.rows} 行、${dirty.cells} 处尚未应用的编辑。` +
          '重新加载会丢弃这些编辑，请选择如何处理。',
        buttons: [
          { action: 'apply', label: '应用后重新加载', kind: 'primary' },
          { action: 'discard', label: '丢弃本标签编辑' },
          { action: 'cancel', label: '取消' }
        ]
      })
      if (choice === 'cancel') return false
      if (choice === 'apply') return participant.applyLocalEditsFromController()
      participant.discardLocalEditsFromController()
      return true
    })
  }

  /**
   * 供 main/index 的生命周期钩子调用（此时相关网格都已注册）。
   * 决定永远是**连接级**的：提交或回滚会作用于该连接的所有标签。
   */
  async guardAll(action: string): Promise<boolean> {
    return this.#enqueue(async () => {
      const participant = this.#firstParticipant()
      if (!participant) return true
      const state = await this.#readState(participant)
      const dirty = this.#dirtyParticipants()
      if (!state.active && dirty.length === 0) return true

      const choice = await this.#ask(this.#globalLeaveSpec(action, dirty, state.active))
      if (choice === 'cancel') return false
      if (choice === 'apply-commit') {
        if (!(await this.#applyParticipants(dirty))) return false
        try {
          const next = await this.#requireApi().commitTransaction(participant.transactionNodeId)
          this.#broadcastState(next)
          this.#broadcastRefresh()
          return true
        } catch (e) {
          participant.reportTransactionControllerStatus(`提交失败：${errText(e)}`, true)
          return false
        }
      }

      for (const item of dirty) item.discardLocalEditsFromController()
      if (state.active) {
        try {
          const next = await this.#requireApi().rollbackTransaction(participant.transactionNodeId)
          this.#broadcastState(next)
          this.#broadcastRefresh()
        } catch (e) {
          participant.reportTransactionControllerStatus(`回滚失败：${errText(e)}`, true)
          return false
        }
      }
      return true
    })
  }

  /**
   * 插入/删除已经由既有的结构化 API 应用到连接事务上了。
   * 这里只需刷新一次所有已注册的结果网格。
   */
  async notifyMutation(participant: TransactionParticipant): Promise<void> {
    await this.#enqueue(async () => {
      await this.#broadcast({ reload: true, source: participant })
    })
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task)
    this.#queue = next.then(() => undefined, () => undefined)
    return next
  }

  async #applyParticipants(participants: readonly TransactionParticipant[]): Promise<boolean> {
    for (const item of participants) {
      if (!(await item.applyLocalEditsFromController())) return false
    }
    return true
  }

  async #broadcast(options: { reload: boolean; source: TransactionParticipant }): Promise<void> {
    const state = await this.#readState(options.source)
    this.#broadcastState(state)
    if (options.reload) this.#broadcastRefresh()
  }

  #broadcastState(state: TransactionState): void {
    this.#state = { active: state.active, pendingAffected: state.pendingAffected }
    for (const participant of this.#participants.values()) {
      participant.setTransactionStateFromController(this.#state)
    }
  }

  #broadcastRefresh(): void {
    for (const participant of this.#participants.values()) {
      void participant.refreshFromTransactionController().catch((e) => {
        participant.reportTransactionControllerStatus(`刷新结果失败：${errText(e)}`, true)
      })
    }
  }

  async #readState(participant: TransactionParticipant): Promise<TransactionState> {
    try {
      const state = await this.#requireApi().transactionState(participant.transactionNodeId)
      this.#state = state
      return state
    } catch (e) {
      participant.reportTransactionControllerStatus(`读取事务状态失败：${errText(e)}`, true)
      return this.#state
    }
  }

  #requireApi(): DbStudioApi {
    if (!this.#api) throw new Error('事务控制器尚未绑定 API')
    return this.#api
  }

  #firstParticipant(): TransactionParticipant | null {
    return this.#participants.values().next().value ?? null
  }

  #dirtyParticipants(): TransactionParticipant[] {
    return [...this.#participants.values()].filter(
      (participant) => participant.getLocalDirtySummary().rows > 0
    )
  }

  #commitSpec(dirty: readonly TransactionParticipant[]): DialogSpec {
    return {
      title: '提交连接事务',
      message:
        `当前连接有 ${dirty.length} 个标签包含尚未应用的编辑。` +
        '提交操作作用于整个连接；请选择是否先应用所有相关标签的编辑。',
      buttons: [
        { action: 'apply-commit', label: '应用全部并提交', kind: 'primary' },
        { action: 'discard-rollback', label: '丢弃未应用后提交' },
        { action: 'cancel', label: '取消' }
      ]
    }
  }

  #rollbackSpec(dirty: readonly TransactionParticipant[], active: boolean): DialogSpec {
    return {
      title: '回滚连接事务',
      message:
        `回滚作用于整个连接，将丢弃 ${dirty.length} 个标签的未应用编辑` +
        (active ? '，并撤销已应用但未提交的数据库改动。' : '。'),
      buttons: [
        { action: 'discard-rollback', label: '丢弃全部并回滚', kind: 'danger' },
        { action: 'cancel', label: '取消' }
      ]
    }
  }

  #leaveSpec(
    participant: TransactionParticipant,
    action: string,
    dirty: LocalDirtySummary
  ): DialogSpec {
    return {
      title: `离开前处理编辑（${action}）`,
      message:
        `当前标签有 ${dirty.rows} 行、${dirty.cells} 处尚未应用的编辑。` +
        '应用会把改动留在当前连接事务中；丢弃只影响当前标签，不会回滚其他标签的事务。',
      buttons: [
        { action: 'apply', label: '应用并离开', kind: 'primary' },
        { action: 'discard', label: '丢弃当前标签编辑' },
        { action: 'cancel', label: '取消' }
      ]
    }
  }

  #globalLeaveSpec(
    action: string,
    dirty: readonly TransactionParticipant[],
    active: boolean
  ): DialogSpec {
    const dirtyCells = dirty.reduce(
      (total, participant) => total + participant.getLocalDirtySummary().cells,
      0
    )
    return {
      title: `离开应用前处理连接事务（${action}）`,
      message:
        `当前连接有 ${dirty.length} 个标签、${dirtyCells} 处尚未应用的编辑` +
        (active ? '，并有已应用但未提交的数据库改动。' : '。') +
        '这里的提交或回滚都会影响该连接的所有标签。',
      buttons: [
        { action: 'apply-commit', label: '应用全部并提交', kind: 'primary' },
        { action: 'discard-rollback', label: '丢弃全部并回滚', kind: 'danger' },
        { action: 'cancel', label: '取消' }
      ]
    }
  }

  #ask(spec: DialogSpec): Promise<Decision> {
    if (typeof document === 'undefined') return Promise.resolve('cancel')

    const dialog = document.createElement('dialog')
    dialog.id = 'dbstudio-transaction-dialog'
    dialog.className = 'transaction-dialog'
    const body = document.createElement('div')
    body.className = 'transaction-dialog-body'
    const title = document.createElement('h2')
    title.textContent = spec.title
    const message = document.createElement('p')
    message.textContent = spec.message
    const menu = document.createElement('menu')
    for (const buttonSpec of spec.buttons) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset['transactionAction'] = buttonSpec.action
      button.textContent = buttonSpec.label
      if (buttonSpec.kind === 'primary') button.className = 'is-primary'
      if (buttonSpec.kind === 'danger') button.className = 'is-danger'
      menu.appendChild(button)
    }
    body.append(title, message, menu)
    dialog.appendChild(body)
    document.body.appendChild(dialog)

    return new Promise((resolve) => {
      let settled = false
      const finish = (decision: Decision): void => {
        if (settled) return
        settled = true
        dialog.close()
        dialog.remove()
        resolve(decision)
      }
      for (const button of menu.querySelectorAll('button')) {
        button.addEventListener('click', () => {
          finish((button.dataset['transactionAction'] ?? 'cancel') as Decision)
        })
      }
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault()
        finish('cancel')
      })
      dialog.addEventListener('close', () => finish('cancel'))
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    })
  }
}

export function getTransactionController(connectionId: string): TransactionController {
  let controller = controllers.get(connectionId)
  if (!controller) {
    controller = new TransactionController(connectionId)
    controllers.set(connectionId, controller)
  }
  return controller
}

/** Guard all registered connections for a main/index lifecycle action. */
export async function guardAllTransactions(action: string): Promise<boolean> {
  for (const controller of controllers.values()) {
    if (!(await controller.guardAll(action))) return false
  }
  return true
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
