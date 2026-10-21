/**
 * 驱动宿主进程（driver host）——「一个连接 = 一个子进程」的落地实现。
 *
 * ===== 为什么是独立进程，而不是主进程里的一个对象 =====
 *
 * 剖析报告「陷阱 1」给出的事实：DBeaver 给每个驱动一个 `URLClassLoader`
 * （`DriverClassLoader.java`，parent-first），解决的是「两个驱动依赖同一个库的
 * 不同版本，在同一 JVM 里必然打架」。
 *
 * Node 没有 ClassLoader，`require` 缓存是进程级全局的，同一进程内无法并存两个
 * 版本的同一个包。所以这里的做法不是「模拟 ClassLoader」，而是**用进程边界
 * 换取隔离**：一个连接一个宿主进程，驱动崩溃 / 版本冲突 / 内存泄漏都被限制在
 * 那一个进程里，主进程与其他连接不受影响。
 *
 * 代价也如实写在这里：跨进程只能传可结构化克隆的纯数据，adapter 对象、
 * 连接句柄、函数都**不能**越过这条边界——这也是 `DriverAdapter` 的回传值
 * 全部是 `ObjectRef` / `TableDescription` 这类纯数据的原因。
 *
 * ===== 三条硬性约束（改代码前先读） =====
 *
 * 1. **禁止 import electron**。本文件必须能被 Electron 的内置 Node
 *    （`ELECTRON_RUN_AS_NODE=1`）和系统 node 同时直接跑；可测性全押在这一条上
 *    （`tests/e2e.mjs` 就是用系统 node 拉起它的）。
 * 2. **stdout 只许写协议帧**，一行一个 JSON。任何日志、任何调试输出都走 stderr。
 *    一个意外的 `console.log` 就能污染协议流，让主进程收到半截 JSON。
 * 3. **每个请求必须回一帧响应**，哪怕处理时抛了异常。宁可回 `internal` 错误，
 *    也不能让调用方等到超时——超时会让「驱动有问题」和「宿主挂了」变得无法区分。
 *
 * 传输格式选 NDJSON over stdio 的理由见 `src/core/driver.ts` 的 `RpcRequest`
 * 注释；这里只补充一个实现层面的理由：stdin 是流，天然支持逐行增量解析，
 * 不需要自己维护消息长度前缀。
 */

import { createInterface } from 'node:readline'

import type { ConnectionConfig } from '../core/dialect'
import type {
  DriverAdapter,
  RpcError,
  RpcErrorCode,
  RpcHandshake,
  RpcMethod,
  RpcRequest,
  RpcResponse,
  TestConnectionResult
} from '../core/driver'
import { isRpcResponse, RPC_METHODS } from '../core/driver'
import type { DriverCapabilities, ObjectRef, TableDescription } from '../core/model'
import { DriverRegistry } from '../core/registry'
import type {
  EditApplyResult,
  QueryOptions,
  QueryResult,
  ResultPage,
  RowUpdate,
  TransactionState
} from '../core/resultset'
import type { CellValue } from '../core/resultset'
import { registerBuiltinDrivers } from '../drivers'

/**
 * adapter 实现版本，随协议不兼容变更递增。
 * 主进程会拿它与自己的期望值比对，避免「协议对不上却静默乱跑」。
 */
const ADAPTER_VERSION = '0.1.0'

/** 唯一会写 stdout 的函数。整份文件只有它碰 `process.stdout`，便于审计。 */
function writeFrame(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

/**
 * 日志：一律写 stderr。
 * 特意不做级别过滤与格式化——宿主是基础设施，日志越简单越不容易出岔子。
 */
function log(level: 'info' | 'warn' | 'error', message: string): void {
  process.stderr.write(`[driver-host] ${level}: ${message}\n`)
}

/** 带错误码的内部异常。adapter 抛普通 Error 时由 `toRpcError` 兜底成 `internal`。 */
class RpcFailure extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'RpcFailure'
  }
}

/**
 * 协议里合法的错误码集合。
 *
 * 为什么要有这张表：adapter 会抛带 `code` 的异常（例如 SQLite 适配器的
 * `SqliteAdapterError`，写操作被拒绝时是 `query_failed`）。协议要求把这些码
 * **原样透传**给主进程——UI 靠 `query_failed` 决定「提示 SQL 有错」，
 * 靠 `internal` 决定「报 bug」。若宿主把 adapter 的码一律吞成 `internal`，
 * 这条区分就没了，用户看到的会是「内部错误」而不是可理解的 SQL 报错。
 *
 * 同时必须**校验**：adapter 若是抛了个协议里不存在的码（比如手滑打错），
 * 直接透传会让主进程拿到一个它不认识的值。所以这里做白名单收窄。
 */
const RPC_ERROR_CODES: ReadonlySet<string> = new Set<RpcErrorCode>([
  'not_connected',
  'already_connected',
  'unsupported_method',
  'bad_params',
  'connection_failed',
  'query_failed',
  'object_not_found',
  'internal'
])

/** 从异常里取出合法的协议错误码；不是合法码则返回 null。 */
function pickErrorCode(err: unknown): RpcErrorCode | null {
  if (typeof err !== 'object' || err === null) return null
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && RPC_ERROR_CODES.has(code)) return code as RpcErrorCode
  return null
}

/**
 * 把任意异常翻译成协议错误。
 *
 * 映射规则（与任务约定一致）：
 *   - 我们自己抛的 `RpcFailure`            → 用它的 code
 *   - adapter 抛的、带合法 `code` 的异常    → **原样透传该 code**
 *   - 其余一切                              → `internal`
 *
 * 注意 `connection_failed` 不由这里推断：只有 `connect` / `testConnection`
 * 这两个「建连」语义的方法才会在 catch 里显式改判（见 `dispatch`），
 * 避免把 adapter 里的任意 bug 都说成「连不上」而误导排查。
 */
function toRpcError(err: unknown): RpcError {
  if (err instanceof RpcFailure) {
    return { code: err.code, message: err.message }
  }
  const code = pickErrorCode(err)
  if (code !== null) {
    return { code, message: describe(err) }
  }
  if (err instanceof Error) {
    return { code: 'internal', message: err.message || err.name }
  }
  return { code: 'internal', message: String(err) }
}

// ---------------------------------------------------------------------------
// 参数校验
//
// 为什么不用 zod 之类：宿主进程要尽可能少的依赖，且这份 schema 只有 6 个方法。
// 更重要的是——这里校验的**不只是类型，还有协议语义**（比如 `parentId` 允许
// `null` 但不允许 `undefined`），手写比通用库更容易把「为什么」写清楚。
// ---------------------------------------------------------------------------

type Params = Record<string, unknown>

/** 取出 params 对象；缺失或不是对象时报 `bad_params`。 */
function requireParams(raw: unknown, method: RpcMethod): Params {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcFailure('bad_params', `${method}: params 必须是对象`)
  }
  return raw as Params
}

/**
 * 校验 `ConnectionConfig`。
 *
 * 只校验本宿主真正依赖的字段（`dialectId`、`options`），其余字段的**业务规则**
 * 属于 adapter（例如 SQLite 必须有 `file`）。这里多管一步会导致
 * 「宿主拒绝了一个 adapter 其实能处理的配置」，把错误信息也弄得更远。
 */
function parseConnectionConfig(raw: unknown, method: RpcMethod): ConnectionConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RpcFailure('bad_params', `${method}: config 必须是对象`)
  }
  const cfg = raw as Params
  if (typeof cfg.dialectId !== 'string' || cfg.dialectId.length === 0) {
    throw new RpcFailure('bad_params', `${method}: config.dialectId 必须是非空字符串`)
  }
  const options = cfg.options
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new RpcFailure('bad_params', `${method}: config.options 必须是对象`)
  }
  const name = typeof cfg.name === 'string' ? cfg.name : cfg.dialectId
  return {
    dialectId: cfg.dialectId,
    name,
    options: options as ConnectionConfig['options']
  }
}

/** `secret` 只允许 string / undefined；不允许 null，避免 undefined 与 null 两套语义。 */
function parseSecret(raw: unknown, method: RpcMethod): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') {
    throw new RpcFailure('bad_params', `${method}: secret 必须是字符串或省略`)
  }
  return raw
}

function parseParentId(raw: unknown, method: RpcMethod): string | null {
  if (raw === null) return null
  if (typeof raw === 'string') return raw
  throw new RpcFailure('bad_params', `${method}: parentId 必须是字符串或 null`)
}

function parseObjectId(raw: unknown, method: RpcMethod, field = 'id'): string {
  if (typeof raw === 'string' && raw.length > 0) return raw
  throw new RpcFailure('bad_params', `${method}: ${field} 必须是非空字符串`)
}

/** SQL 必须是非空字符串。空 SQL 交给 adapter 只会换来一句语法错误，不如在这里挡掉。 */
function parseSql(raw: unknown, method: RpcMethod): string {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw
  throw new RpcFailure('bad_params', `${method}: sql 必须是非空字符串`)
}

/** 非负整数（offset 用）。拒绝 NaN / 小数 / 负数，因为它们会变成非法 SQL OFFSET。 */
function parseNonNegativeInt(raw: unknown, field: string, method: RpcMethod): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new RpcFailure('bad_params', `${method}: ${field} 必须是非负整数，收到 ${String(raw)}`)
  }
  return raw
}

/** 正整数（limit 用）。0 或负数没有语义，挡在协议层比让 SQL 报错更早更清楚。 */
function parsePositiveInt(raw: unknown, field: string, method: RpcMethod): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new RpcFailure('bad_params', `${method}: ${field} 必须是正整数，收到 ${String(raw)}`)
  }
  return raw
}

/**
 * 校验 `QueryOptions`。
 *
 * 三个字段都是可选的，所以「缺失」是合法输入；只校验**给了的值**是否合法。
 * 这里刻意不在宿主侧做上限 clamp（比如把 limit 压到 200）——
 * 页大小策略属于 adapter/上层，宿主越权 clamp 会让「UI 要 500 行却拿到 200 行」
 * 变成一个没有任何日志的静默行为。
 */
function parseQueryOptions(raw: unknown, method: RpcMethod): QueryOptions {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcFailure('bad_params', `${method}: options 必须是对象`)
  }
  const o = raw as Params
  const out: { limit?: number; offset?: number; keepCursor?: boolean } = {}
  if (o.limit !== undefined) out.limit = parsePositiveInt(o.limit, 'options.limit', method)
  if (o.offset !== undefined) out.offset = parseNonNegativeInt(o.offset, 'options.offset', method)
  if (o.keepCursor !== undefined) {
    if (typeof o.keepCursor !== 'boolean') {
      throw new RpcFailure('bad_params', `${method}: options.keepCursor 必须是布尔值`)
    }
    out.keepCursor = o.keepCursor
  }
  return out
}

// ---------------------------------------------------------------------------
// 命令行参数
// ---------------------------------------------------------------------------

/**
 * 校验一个 `CellValue` 的形状。
 *
 * ===== 为什么宿主只校验「形状」，不校验「业务可写性」 =====
 *
 * 宿主是协议层：它要保证「进到 adapter 手里的东西不会让 adapter 崩」。
 * 至于某个值能不能写（截断的 blob/text 不能回写、类型是否匹配列），
 * 那是 adapter 的职责——`cellValueToSqlParam` 已经把这些规则钉在 core 里了。
 *
 * 这里如果越权做业务校验，就会出现「宿主放行了但 adapter 拒绝」和
 * 「宿主拒绝了 adapter 其实能处理的值」两套规则打架的情况。
 */
function parseCellValue(raw: unknown, method: RpcMethod, where: string): CellValue {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RpcFailure('bad_params', `${method}: ${where} 必须是 CellValue 对象`)
  }
  const v = raw as { kind?: unknown }
  switch (v.kind) {
    case 'null':
      return { kind: 'null' }
    case 'number':
      if (typeof (raw as { value?: unknown }).value !== 'number') {
        throw new RpcFailure('bad_params', `${method}: ${where}.value 必须是 number`)
      }
      return raw as CellValue
    case 'boolean':
      if (typeof (raw as { value?: unknown }).value !== 'boolean') {
        throw new RpcFailure('bad_params', `${method}: ${where}.value 必须是 boolean`)
      }
      return raw as CellValue
    case 'text': {
      if (typeof (raw as { text?: unknown }).text !== 'string') {
        throw new RpcFailure('bad_params', `${method}: ${where}.text 必须是字符串`)
      }
      return raw as CellValue
    }
    case 'blob': {
      if (typeof (raw as { previewBase64?: unknown }).previewBase64 !== 'string') {
        throw new RpcFailure('bad_params', `${method}: ${where}.previewBase64 必须是字符串`)
      }
      return raw as CellValue
    }
    default:
      throw new RpcFailure(
        'bad_params',
        `${method}: ${where}.kind 非法（收到 ${String(v.kind)}），允许: null/number/boolean/text/blob`
      )
  }
}

/** 校验「列名 → CellValue」的映射，并拒绝会破坏 SQL 语义的空列名或原型污染键。 */
function parseCellValueRecord(
  raw: unknown,
  method: RpcMethod,
  where: string
): Record<string, CellValue> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RpcFailure('bad_params', `${method}: ${where} 必须是对象`)
  }
  const out: Record<string, CellValue> = Object.create(null)
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0) {
      throw new RpcFailure('bad_params', `${method}: ${where} 里出现空列名`)
    }
    // `__proto__` 这类键虽然经 JSON.parse 后是普通属性，但下游若用
    // Object.assign/展开合并就可能污染原型。协议层直接挡掉最省事。
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new RpcFailure('bad_params', `${method}: ${where} 里出现保留键名 "${key}"`)
    }
    out[key] = parseCellValue(value, method, `${where}.${key}`)
  }
  return out
}

/**
 * 校验 `RowUpdate[]`。
 *
 * 两个关键约束，都不是形式主义：
 *
 * 1. **`changes` 不能为空**。空 SET 会生成 `UPDATE t SET WHERE pk=?` 这种
 *    语法坏掉的语句；而且"什么都没改"本来就不该走到提交路径。
 * 2. **`keyValues` 不能为空**。没有 WHERE 条件的 UPDATE 会改整张表——
 *    这是比 SQL 注入更危险的、纯属协议误用就能造成的全表覆写。
 *    所以宁可在这里硬拒，也不让它有一丝机会到 adapter。
 */
function parseRowUpdates(raw: unknown, method: RpcMethod): RowUpdate[] {
  if (!Array.isArray(raw)) {
    throw new RpcFailure('bad_params', `${method}: updates 必须是数组`)
  }
  if (raw.length === 0) {
    throw new RpcFailure('bad_params', `${method}: updates 不能为空数组（没有要提交的修改）`)
  }
  return raw.map((item: unknown, i: number) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new RpcFailure('bad_params', `${method}: updates[${i}] 必须是对象`)
    }
    const u = item as { keyValues?: unknown; changes?: unknown }
    const keyValues = parseCellValueRecord(u.keyValues, method, `updates[${i}].keyValues`)
    const changes = parseCellValueRecord(u.changes, method, `updates[${i}].changes`)
    if (Object.keys(keyValues).length === 0) {
      throw new RpcFailure(
        'bad_params',
        `${method}: updates[${i}].keyValues 不能为空——没有 WHERE 条件的 UPDATE 会改整张表`
      )
    }
    if (Object.keys(changes).length === 0) {
      throw new RpcFailure(
        'bad_params',
        `${method}: updates[${i}].changes 不能为空——空 SET 会生成非法 SQL`
      )
    }
    return { keyValues, changes }
  })
}

/** 极简参数解析：只认 `--dialect <id>` 与 `--dialect=<id>`。 */
function parseDialectArg(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--dialect') {
      const next = argv[i + 1]
      return typeof next === 'string' && next.length > 0 ? next : null
    }
    if (arg.startsWith('--dialect=')) {
      const value = arg.slice('--dialect='.length)
      return value.length > 0 ? value : null
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 宿主主体
// ---------------------------------------------------------------------------

/** 一个宿主进程只服务一个连接，所以 adapter 与「是否已连」都是单例状态。 */
class DriverHost {
  #adapter: DriverAdapter
  /** `connect` 成功后才为 true。`disconnect` 后回落为 false，允许再连。 */
  #connected = false
  /** 优雅退出时兜底调用，保证幂等（adapter 契约要求 disconnect 幂等）。 */
  #disposed = false

  constructor(adapter: DriverAdapter) {
    this.#adapter = adapter
  }

  #handshake(): RpcHandshake {
    return {
      kind: 'handshake',
      dialectId: this.#adapter.dialect.id,
      adapterVersion: ADAPTER_VERSION,
      pid: process.pid,
      nodeVersion: process.versions.node,
      platform: process.platform
    }
  }

  /** 握手帧既可主动推送，也可被 `handshake` 方法索取——测试用后者做「就绪确认」。 */
  announce(): void {
    writeFrame(this.#handshake())
  }

  async handle(req: RpcRequest): Promise<RpcResponse> {
    try {
      const result = await this.#dispatch(req)
      return { id: req.id, ok: true, result }
    } catch (err) {
      return { id: req.id, ok: false, error: toRpcError(err) }
    }
  }

  async #dispatch(req: RpcRequest): Promise<unknown> {
    const params = requireParams(req.params, req.method)

    switch (req.method) {
      case 'handshake':
        return this.#handshake()

      case 'connect': {
        // 一个宿主一个连接：重复 connect 大概率是主进程侧的状态机写错了，
        // 静默覆盖会让「旧连接泄漏」永远查不出来（旧句柄没人再持有，也不会被关）。
        if (this.#connected) {
          throw new RpcFailure('already_connected', '本宿主已有活动连接，请先 disconnect')
        }
        const config = parseConnectionConfig(params.config, req.method)
        const secret = parseSecret(params.secret, req.method)
        try {
          const caps: DriverCapabilities = await this.#adapter.connect(config, secret)
          this.#connected = true
          return caps
        } catch (err) {
          // 建连失败在这里被「定性」为 connection_failed，而不是笼统的 internal：
          // UI 对这个码的处理是「提示用户检查连接信息」，对 internal 是「报 bug」。
          throw new RpcFailure('connection_failed', describe(err))
        }
      }

      case 'disconnect': {
        // 即使从未连上也照常调 adapter.disconnect()：契约要求它幂等，
        // 而 adapter 可能在 connect 半途失败时已经申请了部分资源。
        await this.#adapter.disconnect()
        this.#connected = false
        return null
      }

      case 'testConnection': {
        const config = parseConnectionConfig(params.config, req.method)
        const secret = parseSecret(params.secret, req.method)
        try {
          const result: TestConnectionResult = await this.#adapter.testConnection(config, secret)
          return result
        } catch (err) {
          // 契约是返回 TestConnectionResult 而不是抛错，但 adapter 抛了就说明是真故障；
          // 仍然包成 connection_failed，语义比 internal 更准确。
          throw new RpcFailure('connection_failed', describe(err))
        }
      }

      case 'listChildren': {
        this.#requireConnected(req.method)
        const parentId = parseParentId(params.parentId, req.method)
        const children: ObjectRef[] = await this.#adapter.listChildren(parentId)
        return children
      }

      case 'describeTable': {
        this.#requireConnected(req.method)
        const id = parseObjectId(params.id, req.method)
        const desc: TableDescription = await this.#adapter.describeTable(id)
        return desc
      }

      // ---- 结果集（第二阶段） ----

      case 'query': {
        this.#requireConnected(req.method)
        const sql = parseSql(params.sql, req.method)
        const options = parseQueryOptions(params.options, req.method)
        const result: QueryResult = await this.#adapter.query(sql, options)
        return result
      }

      case 'fetchResultPage': {
        this.#requireConnected(req.method)
        const cursorId = parseObjectId(params.cursorId, req.method, 'cursorId')
        const offset = parseNonNegativeInt(params.offset, 'offset', req.method)
        const limit = parsePositiveInt(params.limit, 'limit', req.method)
        const page: ResultPage = await this.#adapter.fetchResultPage(cursorId, offset, limit)
        return page
      }

      case 'closeCursor': {
        // 与 disconnect 同理：即使从未连上也照常调用，因为 adapter 契约要求幂等，
        // 而且「关一个已经不存在的东西」不该报错——网格关闭时会无条件调用它。
        // 刻意**不**做 requireConnected：连接刚断时 UI 仍可能来关游标，
        // 那时报 not_connected 会变成一个没人处理的噪音错误。
        const cursorId = parseObjectId(params.cursorId, req.method, 'cursorId')
        await this.#adapter.closeCursor(cursorId)
        return null
      }

      // ---- 在线编辑与事务（第三阶段） ----

      case 'applyEdits': {
        this.#requireConnected(req.method)
        const tableId = parseObjectId(params.tableId, req.method, 'tableId')
        const updates = parseRowUpdates(params.updates, req.method)
        const result: EditApplyResult = await this.#adapter.applyEdits(tableId, updates)
        return result
      }

      case 'commitTransaction': {
        this.#requireConnected(req.method)
        const state: TransactionState = await this.#adapter.commitTransaction()
        return state
      }

      case 'rollbackTransaction': {
        // 与 closeCursor 同一考虑：契约要求幂等，而且**关连接时的清理路径**
        // 会无条件调它（见 ConnectionManager.remove）。
        // 若这里在未连接时报 not_connected，那条清理路径就得多吞一个噪音错误，
        // 还要多判一次状态——而 adapter 的 rollbackTransaction 本来就要能
        // 安全处理「本来就没有事务」。所以这里刻意不 requireConnected。
        const state: TransactionState = await this.#adapter.rollbackTransaction()
        return state
      }

      case 'transactionState': {
        this.#requireConnected(req.method)
        const state: TransactionState = await this.#adapter.transactionState()
        return state
      }

      default: {
        // 未知方法返回错误帧而不是静默丢弃：静默丢弃等于让调用方等到超时。
        // 用 never 断言是因为协议方法清单可能被主进程侧扩过，而宿主没跟上。
        const unknownMethod: never = req.method
        throw new RpcFailure(
          'unsupported_method',
          `不支持的 RPC 方法: ${String(unknownMethod)}（支持: ${RPC_METHODS.join(', ')}）`
        )
      }
    }
  }

  #requireConnected(method: RpcMethod): void {
    if (!this.#connected) {
      throw new RpcFailure('not_connected', `${method}: 尚未 connect，宿主没有可用连接`)
    }
  }

  /** 进程退出前的收尾。**永不抛错**，否则退出码会变成非 0，掩盖真正的退出原因。 */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    try {
      await this.#adapter.disconnect()
    } catch (err) {
      log('warn', `退出前 disconnect 失败（忽略）: ${describe(err)}`)
    }
    this.#connected = false
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// 请求帧解析
// ---------------------------------------------------------------------------

/**
 * 把一行 stdin 文本解析成 `RpcRequest`。
 *
 * 协议之外的输入（空行、非 JSON、缺 id）无法回「带同一个 id 的响应」，
 * 只能记 stderr。这时**不退出进程**：一行脏数据不值得杀掉一个连接，
 * 主进程那边会因为收不到响应而超时，超时信息比宿主直接退出更好排查。
 */
function parseRequest(line: string): RpcRequest | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null

  let frame: unknown
  try {
    frame = JSON.parse(trimmed)
  } catch {
    log('warn', `忽略非法的 JSON 请求行: ${truncate(trimmed)}`)
    return null
  }

  if (typeof frame !== 'object' || frame === null) {
    log('warn', '忽略非对象请求帧')
    return null
  }
  const candidate = frame as Partial<RpcRequest> & { kind?: unknown }
  // 事件帧（`kind` 存在）从宿主流向主进程，反向送来的直接忽略，
  // 防止两端把同一个字段当双向用。
  if ('kind' in candidate) {
    log('warn', `忽略事件帧（宿主只接受请求帧）: ${truncate(trimmed)}`)
    return null
  }
  if (typeof candidate.id !== 'number' || !Number.isFinite(candidate.id)) {
    log('warn', `请求缺少合法的数字 id: ${truncate(trimmed)}`)
    return null
  }
  if (typeof candidate.method !== 'string') {
    // 有 id 但没 method：可以回一帧错误，让调用方立刻失败而不是等超时。
    return { id: candidate.id, method: 'handshake' as RpcMethod, params: undefined }
  }
  return { id: candidate.id, method: candidate.method as RpcMethod, params: candidate.params }
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 方法名不在白名单时立刻失败——用一张表判定，避免 switch 的 default 兜底过晚。 */
const KNOWN_METHODS = new Set<string>(RPC_METHODS)

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

/** 未知方言 / 缺参数等「启动即失败」的情况统一从这里退出。 */
function fatalStartup(message: string): never {
  log('error', message)
  process.exit(1)
}

function main(): void {
  const dialectId = parseDialectArg(process.argv.slice(2))
  if (dialectId === null) {
    fatalStartup('缺少必填参数 --dialect <id>，例如：node out/driver-host/index.js --dialect sqlite')
  }

  // 注册表 + 内置驱动：清单只有 `src/drivers/index.ts` 一个出口，
  // 宿主、主进程、测试三方拿到的必然是同一份（见该文件头部注释）。
  const registry = new DriverRegistry()
  try {
    registerBuiltinDrivers(registry)
  } catch (err) {
    fatalStartup(`加载内置驱动失败: ${describe(err)}`)
  }

  if (!registry.has(dialectId)) {
    const available = registry.list().map((d) => d.id).join(', ') || '无'
    fatalStartup(`未知方言: ${dialectId}（已注册: ${available}）`)
  }

  let host: DriverHost
  try {
    host = new DriverHost(registry.create(dialectId))
  } catch (err) {
    fatalStartup(`创建方言 ${dialectId} 的 adapter 失败: ${describe(err)}`)
  }

  // ---- 进程级兜底：未捕获异常必须变成 stderr 日志 + exit(1) ----
  // 为什么必须退出而不是继续跑：异常发生后 adapter 的内部状态已经不可信，
  // 继续接受请求只会给出错误结果。让主进程看到退出、由它决定重连，才是可控的。
  process.on('uncaughtException', (err) => {
    log('error', `未捕获异常，进程退出: ${err.stack ?? describe(err)}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    log('error', `未处理的 Promise 拒绝，进程退出: ${detail}`)
    process.exit(1)
  })

  // ---- 握手：启动后立即推第一帧，主进程据此确认「这个进程是谁、支持什么」 ----
  host.announce()
  log('info', `方言 ${dialectId} 已加载，pid=${process.pid} node=${process.versions.node}`)

  // ---- 逐行读 stdin ----
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

  rl.on('line', (line) => {
    const req = parseRequest(line)
    if (req === null) return

    if (!KNOWN_METHODS.has(req.method)) {
      // 方法名不认识：立即回错误帧（带同一个 id），不要让调用方等超时。
      writeFrame({
        id: req.id,
        ok: false,
        error: {
          code: 'unsupported_method',
          message: `不支持的 RPC 方法: ${req.method}（支持: ${RPC_METHODS.join(', ')}）`
        }
      } satisfies RpcResponse)
      return
    }

    // 不 await：NDJSON 是流水线协议，多个请求可以并发在途，响应按 id 对应。
    // handle() 内部已经把一切异常收成失败帧，这里不需要 catch。
    void host.handle(req).then((res) => {
      writeFrame(res)
      // 断言一下回帧形状自洽，防止将来改坏了 isRpcResponse 的前置假设。
      if (!isRpcResponse(res)) log('error', `内部错误：产生了非法响应帧 ${JSON.stringify(res)}`)
    })
  })

  // ---- 优雅退出 ----
  // stdin EOF 意味着父进程关掉了管道：这是唯一正常的退出信号。
  // 先 disconnect 再 exit(0)——连接句柄必须真正释放（SQLite 不关会留下 -wal/-shm 文件）。
  let shuttingDown = false
  rl.on('close', () => {
    if (shuttingDown) return
    shuttingDown = true
    log('info', 'stdin 已关闭，开始优雅退出')
    void host.dispose().finally(() => {
      process.exit(0)
    })
  })

  // SIGTERM / SIGINT（主进程 force-kill、或 CI 发信号）：同样走优雅路径。
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return
      shuttingDown = true
      log('info', `收到 ${signal}，开始优雅退出`)
      void host.dispose().finally(() => {
        process.exit(0)
      })
    })
  }
}

main()
