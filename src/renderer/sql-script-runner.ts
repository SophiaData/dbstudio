import type { SqlScriptStatement } from '../core/sql-script'

export interface ScriptRunState {
  readonly status: 'idle' | 'running' | 'cancelled' | 'failed' | 'completed'
  readonly completed: number
  readonly total: number
  readonly current?: SqlScriptStatement
}

export type ScriptStateListener = (state: ScriptRunState) => void

/**
 * 顺序执行脚本并集中维护进度状态。
 *
 * 语句执行本身由调用方注入，这样 runner 不需要知道 IPC、结果标签或事务控制器。
 * 失败时保留当前语句，调用方可以直接使用 parser 给出的源码行号。
 */
export class SqlScriptRunner {
  #state: ScriptRunState = { status: 'idle', completed: 0, total: 0 }
  #cancelRequested = false
  readonly #onState?: ScriptStateListener

  constructor(onState?: ScriptStateListener) {
    this.#onState = onState
  }

  get state(): ScriptRunState {
    return this.#state
  }

  cancel(): void {
    if (this.#state.status !== 'running') return
    this.#cancelRequested = true
  }

  async run(
    statements: readonly SqlScriptStatement[],
    execute: (statement: SqlScriptStatement) => Promise<void>
  ): Promise<void> {
    if (this.#state.status === 'running') {
      throw new Error('已有 SQL 脚本正在执行')
    }
    this.#cancelRequested = false
    this.#setState({ status: 'running', completed: 0, total: statements.length })

    for (const statement of statements) {
      if (this.#cancelRequested) {
        this.#setState({ status: 'cancelled', completed: this.#state.completed, total: statements.length })
        return
      }
      this.#setState({
        status: 'running',
        completed: this.#state.completed,
        total: statements.length,
        current: statement
      })
      try {
        await execute(statement)
      } catch (error) {
        this.#setState({
          status: 'failed',
          completed: this.#state.completed,
          total: statements.length,
          current: statement
        })
        throw error
      }
      this.#setState({
        status: 'running',
        completed: this.#state.completed + 1,
        total: statements.length,
        current: statement
      })
    }

    this.#setState({
      status: 'completed',
      completed: statements.length,
      total: statements.length
    })
  }

  #setState(state: ScriptRunState): void {
    this.#state = state
    this.#onState?.(state)
  }
}
