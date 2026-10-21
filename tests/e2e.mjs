/**
 * 端到端验证：主进程 ↔ 驱动宿主进程（NDJSON over stdio）。
 *
 * ===== 这个脚本验证的是「架构结论」，不是「某个函数能跑」 =====
 *
 * 剖析报告「陷阱 1」的结论是：Node 没有 ClassLoader，多驱动版本只能靠**进程隔离**。
 * 这个结论没法用单元测试证明——它只有把宿主真的作为一个子进程拉起来、
 * 真的用管道对话，才能验证「跨进程边界是否真的能承载 adapter 的完整能力」。
 *
 * 所以这里刻意**不用系统 node 的 inline 能力**，而是：
 *   - 用 `process.execPath`（系统 node）当可执行文件拉起 `out/driver-host/index.js`；
 *     宿主不 import electron，所以这一条同时验证了「宿主是纯 Node 脚本」这个前提。
 *   - 只经 stdout/stdin 说话，不 import 任何 src/ 下的模块。
 *     测试若直接 import adapter，就绕过了被验证的那条边界，等于没测。
 *
 * ===== 为什么必须处处有超时 =====
 *
 * 子进程协议最典型的故障是「不回复也不退出」——宿主挂了、或忘了回帧。
 * 没有超时的测试脚本会**挂死 CI**，而这恰恰是最难在 CI 日志里复盘的一种失败。
 * 这里每一条 RPC 都带 10s 超时，进程退出等待也带超时；超时即判失败并 kill。
 *
 * 运行：node tests/e2e.mjs
 * 前置：node scripts/make-fixture.mjs && node scripts/build-driver-host.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')
const fixtureDb = resolve(root, 'tests/fixtures/sample.db')

/** 单条 RPC 的超时。给足 10s：CI 上首次加载 SQLite 可能慢，但不能无限等。 */
const RPC_TIMEOUT_MS = 10_000
/** 拉起进程到收到 handshake 帧的超时。 */
const HANDSHAKE_TIMEOUT_MS = 10_000
/** 关 stdin 后等待进程退出的超时。 */
const EXIT_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// 极简断言框架：每条断言独立记 PASS/FAIL，失败也继续跑完，便于一次看全问题
// ---------------------------------------------------------------------------

const results = []

/**
 * 记录一条断言。
 * 注意：`detail` 只在失败时才需要人看，所以只在 FAIL 时打印——避免输出噪音
 * 掩盖真正的失败。
 */
function check(name, condition, detail) {
  const passed = Boolean(condition)
  results.push({ name, passed, detail })
  if (passed) {
    console.log(`PASS  ${name}`)
  } else {
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log(`      ↳ ${formatDetail(detail)}`)
  }
  return passed
}

function formatDetail(detail) {
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

// ---------------------------------------------------------------------------
// 宿主进程客户端
// ---------------------------------------------------------------------------

class HostProcess {
  #child
  #pending = new Map() // id → { resolve, reject, timer }
  #events = [] // 非响应帧（handshake / log），按到达顺序
  #exitInfo = null // { code, signal }
  #nextId = 1
  #stderrLines = []
  /** 收到的合法协议帧总数，用于「脏数据不该产生响应帧」这类断言。 */
  #frameCount = 0
  /** 被判定为非法（污染协议流）的 stdout 行数。必须为 0。 */
  #badFrames = 0

  constructor(child) {
    this.#child = child

    // stdout 只承载协议帧：一行一个 JSON。
    // 若这里解析失败，说明宿主污染了协议流（比如误用了 console.log），
    // 这是本架构最致命的一类 bug，必须当作测试失败而不是静默忽略。
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (line.trim().length === 0) return
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        this.#badFrames += 1
        this.#failAll(new Error(`宿主往 stdout 写了非协议内容（协议流被污染）: ${line.slice(0, 200)}`))
        return
      }
      this.#frameCount += 1
      this.#onFrame(frame)
    })

    const errRl = createInterface({ input: child.stderr, crlfDelay: Infinity })
    errRl.on('line', (line) => {
      this.#stderrLines.push(line)
      if (this.#stderrLines.length > 200) this.#stderrLines.shift()
    })

    child.on('exit', (code, signal) => {
      this.#exitInfo = { code, signal }
      // 进程退出时仍有在途请求，说明宿主没回帧就死了——立刻让等待者失败，
      // 而不是让它们各自等到超时（那样会拖慢失败路径，也丢失真实原因）。
      this.#failAll(
        new Error(`宿主进程已退出（code=${code}, signal=${signal}）但仍有未完成的请求`)
      )
    })
  }

  #onFrame(frame) {
    if (typeof frame !== 'object' || frame === null) return
    if (typeof frame.id === 'number') {
      const waiter = this.#pending.get(frame.id)
      if (!waiter) return // 迟到的响应（可能已超时），忽略
      this.#pending.delete(frame.id)
      clearTimeout(waiter.timer)
      waiter.resolve(frame)
      return
    }
    // 无 id 的帧是事件帧（handshake / log）
    this.#events.push(frame)
  }

  #failAll(err) {
    for (const [id, waiter] of this.#pending) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
      this.#pending.delete(id)
    }
  }

  get pid() {
    return this.#child.pid
  }

  get exitInfo() {
    return this.#exitInfo
  }

  get stderrText() {
    return this.#stderrLines.join('\n')
  }

  /** 已收到的合法协议帧总数。 */
  get protonCount() {
    return this.#frameCount
  }

  /** 非法 stdout 行数（污染协议流计数），正常必须为 0。 */
  get badFrameCount() {
    return this.#badFrames
  }

  /** 取第一个满足条件的事件帧（用于拿启动时的 handshake）。 */
  findEvent(predicate) {
    return this.#events.find(predicate) ?? null
  }

  /** 等到某个事件帧出现。超时抛错，避免挂死。 */
  waitForEvent(predicate, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    const existing = this.findEvent(predicate)
    if (existing) return Promise.resolve(existing)

    return new Promise((resolvePromise, rejectPromise) => {
      const startedAt = Date.now()
      const tick = setInterval(() => {
        const found = this.findEvent(predicate)
        if (found) {
          clearInterval(tick)
          resolvePromise(found)
        } else if (this.#exitInfo) {
          clearInterval(tick)
          rejectPromise(
            new Error(
              `等待事件帧时宿主已退出（code=${this.#exitInfo.code}）` +
                (this.stderrText ? `；stderr: ${this.stderrText.slice(-500)}` : '')
            )
          )
        } else if (Date.now() - startedAt > timeoutMs) {
          clearInterval(tick)
          rejectPromise(new Error(`等待事件帧超时（${timeoutMs}ms）`))
        }
      }, 20)
    })
  }

  /** 发一条 RPC 并等待同 id 的响应帧。超时或进程退出都会 reject。 */
  call(method, params) {
    const id = this.#nextId++
    const frame = { id, method }
    if (params !== undefined) frame.params = params

    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rejectPromise(
          new Error(
            `RPC 超时（${RPC_TIMEOUT_MS}ms）: ${method} id=${id}` +
              (this.stderrText ? `；宿主 stderr 末段: ${this.stderrText.slice(-500)}` : '')
          )
        )
      }, RPC_TIMEOUT_MS)

      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
    })
  }

  /** 往 stdin 直接写一行原始文本（用于注入脏数据）。 */
  writeRaw(line) {
    this.#child.stdin.write(`${line}\n`)
  }

  /** 调 RPC 并断言成功，返回 `result`。失败时返回 undefined（断言已记录）。 */
  async callOk(label, method, params) {
    const res = await this.call(method, params)
    if (res.ok !== true) {
      check(label, false, `期望成功，实际收到错误帧: ${formatDetail(res.error)}`)
      return undefined
    }
    check(label, true)
    return res.result
  }

  /** 关闭 stdin，等宿主优雅退出。返回退出码。 */
  async close(timeoutMs = EXIT_TIMEOUT_MS) {
    if (this.#exitInfo) return this.#exitInfo.code
    this.#child.stdin.end()
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        // 优雅退出超时 → 强杀，否则测试自己会挂住。
        this.#child.kill('SIGKILL')
        resolvePromise('timeout')
      }, timeoutMs)
      this.#child.once('exit', (code) => {
        clearTimeout(timer)
        resolvePromise(code)
      })
    })
  }

  kill() {
    if (!this.#exitInfo) this.#child.kill('SIGKILL')
  }
}

/** 拉起一个宿主进程。 */
function launchHost(args) {
  const child = spawn(process.execPath, [hostEntry, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // 刻意不继承 electron 相关环境变量：宿主必须能在纯 Node 下工作。
    env: { ...process.env }
  })
  return new HostProcess(child)
}

// ---------------------------------------------------------------------------
// 断言链
// ---------------------------------------------------------------------------

async function runMainChain() {
  console.log('─'.repeat(70))
  console.log(`拉起驱动宿主: ${process.execPath} ${hostEntry} --dialect sqlite`)
  console.log('─'.repeat(70))

  const host = launchHost(['--dialect', 'sqlite'])
  try {
    // ---- 断言 1：启动后立即收到 handshake 帧 ----
    let handshake = null
    try {
      handshake = await host.waitForEvent((f) => f.kind === 'handshake')
    } catch (err) {
      check('1. 收到 handshake 帧', false, err.message)
      return
    }
    check('1. 收到 handshake 帧', true)
    check(
      "1a. handshake.dialectId === 'sqlite'",
      handshake.dialectId === 'sqlite',
      `实际: ${formatDetail(handshake.dialectId)}`
    )
    check(
      "1b. handshake.adapterVersion === '0.1.0'",
      handshake.adapterVersion === '0.1.0',
      `实际: ${formatDetail(handshake.adapterVersion)}`
    )
    check(
      '1c. handshake 携带 pid / nodeVersion / platform',
      typeof handshake.pid === 'number' &&
        typeof handshake.nodeVersion === 'string' &&
        typeof handshake.platform === 'string',
      formatDetail(handshake)
    )
    check(
      '1d. handshake.pid 与子进程 pid 一致（确认帧来自该进程）',
      handshake.pid === host.pid,
      `handshake.pid=${handshake.pid} spawn.pid=${host.pid}`
    )

    // ---- 断言 0（前置）：未连接时 listChildren 必须报 not_connected ----
    // 放在 connect 之前：这条顺带验证了「错误映射」的一半，
    // 而且它是纯宿主逻辑，不依赖 adapter，adapter 出问题时这条仍然会给出有效信号。
    const preRes = await host.call('listChildren', { parentId: null })
    check(
      '0. 未连接时 listChildren 返回 code=not_connected（且不是超时）',
      preRes.ok === false && preRes.error?.code === 'not_connected',
      formatDetail(preRes)
    )

    // ---- 断言 2：connect 到 fixture ----
    const connectRes = await host.call('connect', {
      config: {
        dialectId: 'sqlite',
        name: 'e2e-fixture',
        options: { file: fixtureDb }
      }
    })
    if (connectRes.ok !== true) {
      check('2. connect 成功', false, `connect 失败: ${formatDetail(connectRes.error)}`)
      // 连不上就没法继续后面的链，但要把已知信息全部抛出来。
      return
    }
    check('2. connect 成功', true)
    const caps = connectRes.result
    check(
      '2a. capabilities.hasCatalog === false',
      caps?.hasCatalog === false,
      `实际: ${formatDetail(caps?.hasCatalog)}`
    )
    check(
      '2b. capabilities 字段齐全（supportsInlineEdit / supportsServerPagination / hasSchema / supportsCancel）',
      typeof caps?.supportsInlineEdit === 'boolean' &&
        typeof caps?.supportsServerPagination === 'boolean' &&
        typeof caps?.hasSchema === 'boolean' &&
        typeof caps?.supportsCancel === 'boolean',
      formatDetail(caps)
    )

    // ---- 断言 9 的前置：重复 connect 必须被拒绝 ----
    const dupRes = await host.call('connect', {
      config: { dialectId: 'sqlite', name: 'dup', options: { file: fixtureDb } }
    })
    check(
      '10. 重复 connect 返回 code=already_connected（不静默覆盖）',
      dupRes.ok === false && dupRes.error?.code === 'already_connected',
      formatDetail(dupRes)
    )

    // ---- 断言 3：根层恰好 2 个 folder ----
    const rootChildren = await host.callOk('3. listChildren(null) 成功', 'listChildren', {
      parentId: null
    })
    if (Array.isArray(rootChildren)) {
      const folders = rootChildren.filter((n) => n.kind === 'folder')
      const ids = rootChildren.map((n) => n.id)
      check(
        '3a. 根层恰好 2 个节点且都是 folder',
        rootChildren.length === 2 && folders.length === 2,
        `实际 ${rootChildren.length} 个: ${formatDetail(ids)}`
      )
      check(
        '3b. 根层 folder id 为 folder:tables / folder:views',
        ids.includes('folder:tables') && ids.includes('folder:views'),
        formatDetail(ids)
      )
      // hasChildren 是在「不展开」时决定要不要画箭头的唯一依据，
      // 撒谎为 true 会让用户展开出一个空节点——这是 model.ts 里点名的问题。
      check(
        '3c. 两个 folder 都声明 hasChildren === true',
        folders.every((f) => f.hasChildren === true),
        formatDetail(folders.map((f) => ({ id: f.id, hasChildren: f.hasChildren })))
      )
    } else {
      check('3a. 根层返回数组', false, `实际: ${formatDetail(rootChildren)}`)
    }

    // ---- 断言 4：tables 分组 ----
    const tables = await host.callOk(
      "4. listChildren('folder:tables') 成功",
      'listChildren',
      { parentId: 'folder:tables' }
    )
    if (Array.isArray(tables)) {
      const names = tables.map((n) => n.name)
      const ids = tables.map((n) => n.id)
      check(
        '4a. tables 含 users 与 audit_log',
        names.includes('users') && names.includes('audit_log'),
        formatDetail(names)
      )
      check(
        '4b. tables 不含任何 sqlite_ 内部表（sqlite_sequence 必须被过滤）',
        !names.some((n) => String(n).startsWith('sqlite_')) &&
          !ids.some((id) => String(id).includes('sqlite_')),
        formatDetail(names)
      )
      check(
        '4c. 表节点 kind === table',
        tables.every((n) => n.kind === 'table'),
        formatDetail(tables.map((n) => ({ name: n.name, kind: n.kind })))
      )
      check(
        '4d. 表节点都声明 hasChildren === true（列在下一层懒加载）',
        tables.every((n) => n.hasChildren === true),
        formatDetail(tables.map((n) => ({ name: n.name, hasChildren: n.hasChildren })))
      )
    } else {
      check('4a. tables 返回数组', false, `实际: ${formatDetail(tables)}`)
    }

    // ---- 断言 5：views 分组 ----
    const views = await host.callOk(
      "5. listChildren('folder:views') 成功",
      'listChildren',
      { parentId: 'folder:views' }
    )
    if (Array.isArray(views)) {
      check(
        '5a. views 含 active_users',
        views.some((n) => n.name === 'active_users'),
        formatDetail(views.map((n) => n.name))
      )
      check(
        '5b. 视图节点 kind === view',
        views.every((n) => n.kind === 'view'),
        formatDetail(views.map((n) => ({ name: n.name, kind: n.kind })))
      )
    } else {
      check('5a. views 返回数组', false, `实际: ${formatDetail(views)}`)
    }

    // ---- 断言 6：有主键表 ----
    const usersDesc = await host.callOk(
      "6. describeTable('table:users') 成功",
      'describeTable',
      { id: 'table:users' }
    )
    if (usersDesc) {
      check(
        '6a. users.hasUniqueKey === true',
        usersDesc.hasUniqueKey === true,
        `实际: ${formatDetail(usersDesc.hasUniqueKey)}`
      )
      const idCol = Array.isArray(usersDesc.columns)
        ? usersDesc.columns.find((c) => c.name === 'id')
        : undefined
      check(
        '6b. users 的列 id 存在',
        idCol !== undefined,
        formatDetail(usersDesc.columns?.map?.((c) => c.name))
      )
      check(
        '6c. users.id 的 primaryKeyOrdinal === 1',
        idCol?.primaryKeyOrdinal === 1,
        `实际: ${formatDetail(idCol?.primaryKeyOrdinal)}`
      )
      check(
        '6d. users 三列齐全（id / email / created_at）',
        Array.isArray(usersDesc.columns) &&
          usersDesc.columns.length === 3 &&
          ['id', 'email', 'created_at'].every((n) =>
            usersDesc.columns.some((c) => c.name === n)
          ),
        formatDetail(usersDesc.columns?.map?.((c) => c.name))
      )
      check(
        '6e. users.email 声明 NOT NULL（nullable === false）',
        usersDesc.columns?.find?.((c) => c.name === 'email')?.nullable === false,
        formatDetail(usersDesc.columns?.find?.((c) => c.name === 'email'))
      )
      // 非主键列的 primaryKeyOrdinal 必须是 null，不能是 0——
      // 0 会被下游当成「序号 0 的主键」，这是经典的 off-by-one 坑。
      const createdCol = usersDesc.columns?.find?.((c) => c.name === 'created_at')
      check(
        '6f. 非主键列 created_at 的 primaryKeyOrdinal === null',
        createdCol !== undefined && createdCol.primaryKeyOrdinal === null,
        `实际: ${formatDetail(createdCol?.primaryKeyOrdinal)}`
      )
    }

    // ---- 断言 7：无主键表 ----
    const auditDesc = await host.callOk(
      "7. describeTable('table:audit_log') 成功",
      'describeTable',
      { id: 'table:audit_log' }
    )
    if (auditDesc) {
      check(
        '7a. audit_log.hasUniqueKey === false（对应 "No unique key defined" 不可编辑规则）',
        auditDesc.hasUniqueKey === false,
        `实际: ${formatDetail(auditDesc.hasUniqueKey)}`
      )
      check(
        '7b. audit_log 所有列的 primaryKeyOrdinal 均为 null',
        Array.isArray(auditDesc.columns) &&
          auditDesc.columns.every((c) => c.primaryKeyOrdinal === null),
        formatDetail(auditDesc.columns?.map?.((c) => [c.name, c.primaryKeyOrdinal]))
      )
    }

    // ---- 断言 11：handler 级错误映射（不依赖 adapter 的正确性） ----
    const badParams = await host.call('listChildren', { parentId: 123 })
    check(
      '11. 非法参数返回 code=bad_params（且立刻回帧，不是超时）',
      badParams.ok === false && badParams.error?.code === 'bad_params',
      formatDetail(badParams)
    )

    const unknownMethod = await host.call('nosuchMethod', {})
    check(
      '12. 未知方法返回 code=unsupported_method',
      unknownMethod.ok === false && unknownMethod.error?.code === 'unsupported_method',
      formatDetail(unknownMethod)
    )

    // ---- 断言 14：协议流抗污染（架构核心风险点） ----
    // 一行脏数据不应杀掉一个连接，也不应让后续请求失去响应；
    // 同时它绝不能以「半截 JSON」的形式出现在 stdout 上——
    // 那会让客户端的行解析器把后面所有帧一起吃掉。
    const beforeDirty = host.protonCount
    host.writeRaw('this is not json')
    host.writeRaw('{"id":"not-a-number","method":"handshake"}')
    host.writeRaw('{"kind":"log","level":"info","message":"宿主不该收到事件帧"}')
    // 用一条正常 RPC 作为「脏数据之后仍然工作」的探针。
    const probe = await host.call('handshake', {})
    check(
      '14. 脏请求行不杀进程，后续 RPC 仍正常响应',
      probe.ok === true && probe.result?.dialectId === 'sqlite',
      formatDetail(probe)
    )
    check(
      '14a. 脏请求行未产生非法响应帧（stdout 协议流保持纯净）',
      host.badFrameCount === 0,
      `非法帧数: ${host.badFrameCount}；stderr: ${host.stderrText.slice(-300)}`
    )
    check(
      '14b. 脏请求行只产出 1 帧响应（3 行脏数据都不应回帧）',
      host.protonCount - beforeDirty === 1,
      `实际新增帧数: ${host.protonCount - beforeDirty}`
    )

    // ---- 断言 13：disconnect 幂等 ----
    const d1 = await host.call('disconnect', {})
    const d2 = await host.call('disconnect', {})
    check(
      '13. disconnect 幂等（连调两次都成功）',
      d1.ok === true && d2.ok === true,
      formatDetail({ first: d1, second: d2 })
    )
    const afterDisconnect = await host.call('listChildren', { parentId: null })
    check(
      '13a. disconnect 之后 listChildren 回到 not_connected',
      afterDisconnect.ok === false && afterDisconnect.error?.code === 'not_connected',
      formatDetail(afterDisconnect)
    )

    // ---- 断言 9：关闭 stdin，宿主应优雅退出且退出码 0 ----
    const exitCode = await host.close()
    check(
      '9. 关闭 stdin 后宿主优雅退出，退出码 === 0',
      exitCode === 0,
      `实际退出码: ${formatDetail(exitCode)}${host.stderrText ? `；stderr: ${host.stderrText.slice(-400)}` : ''}`
    )
  } finally {
    // 无论上面哪条断言炸了，都不留下僵尸进程。
    host.kill()
  }
}

// ---------------------------------------------------------------------------
// 断言 8：错误路径——未知方言必须快速失败，不能挂死
// ---------------------------------------------------------------------------

async function runUnknownDialectCase() {
  console.log('─'.repeat(70))
  console.log('错误路径：--dialect nosuch')
  console.log('─'.repeat(70))

  const host = launchHost(['--dialect', 'nosuch'])
  try {
    // 等退出码；退出超时（挂死）记为一个具体的失败值，而不是让脚本一起挂住。
    const code = await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        host.kill()
        resolvePromise('timeout')
      }, HANDSHAKE_TIMEOUT_MS)
      hostWaitExit(host, resolvePromise, timer)
    })

    check(
      '8. 未知方言：进程非零退出（不能挂死）',
      typeof code === 'number' && code !== 0,
      `实际退出码: ${formatDetail(code)}；stderr: ${host.stderrText.slice(-400)}`
    )
    check(
      '8a. 未知方言：stderr 给出一条 error 事件说明原因',
      /error/i.test(host.stderrText) && /nosuch/.test(host.stderrText),
      `stderr: ${host.stderrText.slice(-400) || '(空)'}`
    )
    check(
      '8b. 未知方言：不向 stdout 输出任何协议帧（启动失败时不该握手）',
      host.findEvent(() => true) === null,
      formatDetail(host.findEvent(() => true))
    )
  } finally {
    host.kill()
  }
}

/**
 * 等待宿主退出并在退出后把 resolve 交付出去。
 * 单抽成函数是因为需要在 setup 超时定时器之后再挂监听，
 * 避免「监听挂了但定时器没清」的泄漏。
 */
function hostWaitExit(host, resolvePromise, timer) {
  // HostProcess 内部已经监听 exit；这里用一个轮询兜底读取退出码，
  // 既不改动 client 的封装，也不会错过「已经在超时前退出」的情况。
  const tick = setInterval(() => {
    if (host.exitInfo !== null) {
      clearInterval(tick)
      clearTimeout(timer)
      resolvePromise(host.exitInfo.code)
    }
  }, 20)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  // 前置条件自检：把「缺产物」和「实现有 bug」区分开，否则报错会误导人。
  const missing = []
  if (!existsSync(hostEntry)) missing.push(`宿主产物不存在: ${hostEntry}（先跑 node scripts/build-driver-host.mjs）`)
  if (!existsSync(fixtureDb)) missing.push(`夹具库不存在: ${fixtureDb}（先跑 node scripts/make-fixture.mjs）`)
  if (missing.length > 0) {
    for (const m of missing) console.error(`[e2e] 前置条件缺失: ${m}`)
    process.exit(1)
  }

  console.log('='.repeat(70))
  console.log('dbstudio 端到端验证：驱动宿主进程（NDJSON over stdio）')
  console.log(`node        : ${process.version}`)
  console.log(`宿主产物    : ${hostEntry}`)
  console.log(`夹具库      : ${fixtureDb}`)
  console.log('='.repeat(70))

  // 两条链互不依赖，但顺序跑更利于读日志（错误路径会快速退出，放后面）。
  try {
    await runMainChain()
  } catch (err) {
    check('主链路执行完成（未抛未捕获异常）', false, err instanceof Error ? err.message : String(err))
  }

  try {
    await runUnknownDialectCase()
  } catch (err) {
    check('错误路径执行完成（未抛未捕获异常）', false, err instanceof Error ? err.message : String(err))
  }

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.passed)
  const passed = results.length - failed.length
  console.log('='.repeat(70))
  console.log(`汇总: ${passed}/${results.length} PASS, ${failed.length} FAIL`)
  if (failed.length > 0) {
    console.log('失败项:')
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail !== undefined ? ` — ${formatDetail(f.detail)}` : ''}`)
  }
  console.log('='.repeat(70))

  // 显式退出：宿主子进程即便意外存活也不该阻止测试退出。
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[e2e] 未捕获的顶层异常:', err)
  process.exit(1)
})
