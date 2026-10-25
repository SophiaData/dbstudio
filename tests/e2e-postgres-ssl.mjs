/**
 * PostgreSQL SSL/TLS 的端到端验证。
 *
 * ===== 这个文件要证明的，不是"能连上"，而是"语义是对的" =====
 *
 * SSL 功能最容易出的问题是**假成功**：
 * 配置里写着 `verify-full`，实际却根本没校验证书；
 * 写着 `require`，实际却走了明文。这类 bug 不会报错，只会静默降低安全性——
 * 比崩溃危险得多。所以本文件刻意配了**正反两组**断言：
 *
 *   正向（必须连上）：disable / prefer / require / verify-ca / verify-full
 *   反向（必须连不上）：verify-* 给错 CA、给不匹配的主机名、非法模式
 *
 * 每条正向断言都**回读 `pg_stat_ssl`**，确认这一次会话真的是加密的——
 * 只看"connect 返回 ok"是不够的：明文连接同样会返回 ok。
 *
 * ===== 为什么需要两个 PG 实例 =====
 *
 *   - 开 SSL 的实例：验证 require / verify-* 的加密与校验
 *   - 关 SSL 的实例：验证 `prefer` **真的回退明文**（而不是报错或假成功）
 *
 * `pg` 驱动本身没有 `prefer` 的降级能力（实测见 drivers/postgresql/ssl.ts），
 * 回退是我们自己实现的——所以必须有一条测试盯着它，否则将来有人"简化"
 * 掉回退逻辑时，只有连老式内网库的用户会发现问题。
 *
 * ===== 环境约定（缺环境就跳过，不硬失败）=====
 *
 *   DBSTUDIO_PG_SSL_URL      开 SSL 的 PG，如 postgres://postgres@127.0.0.1:55433/postgres
 *   DBSTUDIO_PG_PLAIN_URL    未开 SSL 的 PG，如 postgres://postgres@127.0.0.1:55432/postgres
 *   DBSTUDIO_PG_SSL_CA       该 SSL 实例所用证书（当作"正确 CA"），默认 tests/.ssl-fixture/server.crt
 *
 * 两项都缺失 → 打印说明并 exit 0（与其它 PG 测试同约定）。
 * 只缺其中一项 → 仍跑能跑的那部分，并把缺的部分明确标成 SKIP，不假装通过。
 *
 * 运行：
 *   node scripts/make-ssl-fixture.mjs tests/.ssl-fixture
 *   DBSTUDIO_PG_SSL_URL=... DBSTUDIO_PG_PLAIN_URL=... node tests/e2e-postgres-ssl.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')

const SSL_URL = process.env['DBSTUDIO_PG_SSL_URL']
const PLAIN_URL = process.env['DBSTUDIO_PG_PLAIN_URL']
const CA_PATH = process.env['DBSTUDIO_PG_SSL_CA'] ?? resolve(root, 'tests/.ssl-fixture/server.crt')

if (!SSL_URL && !PLAIN_URL) {
  console.log('跳过：未配置 SSL 测试用的 PostgreSQL。')
  console.log('  需要：DBSTUDIO_PG_SSL_URL（开 SSL）和/或 DBSTUDIO_PG_PLAIN_URL（未开 SSL）')
  console.log('  例：')
  console.log('    node scripts/make-ssl-fixture.mjs tests/.ssl-fixture')
  console.log('    DBSTUDIO_PG_SSL_URL=postgres://postgres@127.0.0.1:55433/postgres \\')
  console.log('    DBSTUDIO_PG_PLAIN_URL=postgres://postgres@127.0.0.1:55432/postgres \\')
  console.log('    node tests/e2e-postgres-ssl.mjs')
  process.exit(0)
}

if (!existsSync(hostEntry)) {
  console.error(`[e2e-postgres-ssl] 前置条件缺失: 驱动宿主不存在: ${hostEntry}（先跑 node scripts/build-driver-host.mjs）`)
  process.exit(1)
}

const RPC_TIMEOUT_MS = 20_000
const HANDSHAKE_TIMEOUT_MS = 15_000
const EXIT_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// 断言框架（与其它 e2e 同构）
// ---------------------------------------------------------------------------

const results = []

function check(name, condition, detail) {
  const passed = Boolean(condition)
  results.push({ name, passed })
  if (passed) console.log(`PASS  ${name}`)
  else {
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log(`      ↳ ${typeof detail === 'string' ? detail : safeJson(detail)}`)
  }
  return passed
}

function skip(name, reason) {
  results.push({ name, passed: true, skipped: true })
  console.log(`SKIP  ${name}（${reason}）`)
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// 宿主客户端
// ---------------------------------------------------------------------------

class HostProcess {
  #child
  #pending = new Map()
  #events = []
  #exitInfo = null
  #nextId = 1
  #stderrLines = []

  constructor(child) {
    this.#child = child
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (line.trim().length === 0) return
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        this.#failAll(new Error(`协议流被污染: ${line.slice(0, 200)}`))
        return
      }
      if (typeof frame === 'object' && frame !== null && typeof frame.id === 'number') {
        const waiter = this.#pending.get(frame.id)
        if (waiter) {
          this.#pending.delete(frame.id)
          clearTimeout(waiter.timer)
          waiter.resolve(frame)
        }
        return
      }
      this.#events.push(frame)
    })
    const errRl = createInterface({ input: child.stderr, crlfDelay: Infinity })
    errRl.on('line', (line) => {
      this.#stderrLines.push(line)
      if (this.#stderrLines.length > 200) this.#stderrLines.shift()
    })
    child.on('exit', (code, signal) => {
      this.#exitInfo = { code, signal }
      this.#failAll(new Error(`宿主进程已退出（code=${code}, signal=${signal}）但仍有未完成请求`))
    })
  }

  #failAll(err) {
    for (const [id, waiter] of this.#pending) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
      this.#pending.delete(id)
    }
  }

  get stderrText() {
    return this.#stderrLines.join('\n')
  }

  waitForEvent(predicate, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    const existing = this.#events.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((res, rej) => {
      const startedAt = Date.now()
      const tick = setInterval(() => {
        const found = this.#events.find(predicate)
        if (found) {
          clearInterval(tick)
          res(found)
        } else if (this.#exitInfo) {
          clearInterval(tick)
          rej(new Error(`等待事件帧时宿主已退出（code=${this.#exitInfo.code}）`))
        } else if (Date.now() - startedAt > timeoutMs) {
          clearInterval(tick)
          rej(new Error(`等待事件帧超时（${timeoutMs}ms）`))
        }
      }, 20)
    })
  }

  call(method, params) {
    const id = this.#nextId++
    const frame = { id, method }
    if (params !== undefined) frame.params = params
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rej(
          new Error(
            `RPC 超时（${RPC_TIMEOUT_MS}ms）: ${method} id=${id}` +
              (this.stderrText ? `；stderr: ${this.stderrText.slice(-400)}` : '')
          )
        )
      }, RPC_TIMEOUT_MS)
      this.#pending.set(id, { resolve: res, reject: rej, timer })
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
    })
  }

  async close(timeoutMs = EXIT_TIMEOUT_MS) {
    if (this.#exitInfo) return this.#exitInfo.code
    this.#child.stdin.end()
    return new Promise((res) => {
      const timer = setTimeout(() => {
        this.#child.kill('SIGKILL')
        res('timeout')
      }, timeoutMs)
      this.#child.once('exit', (code) => {
        clearTimeout(timer)
        res(code)
      })
    })
  }
}

function launchHost() {
  return new HostProcess(
    spawn(process.execPath, [hostEntry, '--dialect', 'postgresql'], { stdio: ['pipe', 'pipe', 'pipe'] })
  )
}

function parsePgUrl(url) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: u.port === '' ? '5432' : u.port,
    database: decodeURIComponent(u.pathname.replace(/^\//, '') || 'postgres'),
    user: decodeURIComponent(u.username || 'postgres'),
    password: u.password === '' ? undefined : decodeURIComponent(u.password)
  }
}

/**
 * 用指定 sslmode 连一次，返回 { ok, encrypted, value, error }。
 *
 * 每个用例都**新起一个宿主进程**：一个宿主 = 一个连接（架构约束），
 * 复用同一个宿主就得先 disconnect，而 disconnect 失败时的状态残留
 * 会污染下一条断言——隔离进程比清理状态可靠。
 */
async function tryConnect({ url, sslmode, sslrootcert, host: hostOverride, extraOptions }) {
  const info = parsePgUrl(url)
  const host = launchHost()
  try {
    await host.waitForEvent((f) => f.kind === 'handshake')
    const options = {
      host: info.host,
      port: info.port,
      database: info.database,
      user: info.user,
      ...(hostOverride === undefined ? {} : { host: hostOverride }),
      ...(sslmode === undefined ? {} : { sslmode }),
      ...(sslrootcert === undefined ? {} : { sslrootcert }),
      ...(extraOptions ?? {})
    }
    const frame = await host.call('connect', {
      config: { dialectId: 'postgresql', name: 'ssl-probe', options },
      secret: info.password
    })
    if (frame.error || frame.result?.ok === false) {
      return { ok: false, error: frame.error ?? frame.result?.error }
    }
    // 关键：回读服务端视角的加密状态，而不是相信客户端自己的说法。
    const q = await host.call('query', {
      sql: 'SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
      options: {}
    })
    const row = q.result?.rows?.[0]?.cells
    return {
      ok: true,
      encrypted: row?.[0]?.value === true,
      // CellValue 是判别联合：文本在 `.text`，布尔/数字在 `.value`（见 core/resultset.ts）。
      tlsVersion: row?.[1]?.kind === 'text' ? row[1].text : null
    }
  } catch (thrown) {
    return { ok: false, error: String(thrown instanceof Error ? thrown.message : thrown) }
  } finally {
    try {
      await host.call('disconnect', {})
    } catch {
      // 连接没建立时 disconnect 会报错，忽略
    }
    await host.close()
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log('─'.repeat(70))
  console.log('PG SSL/TLS：sslmode 语义验证')
  if (SSL_URL) console.log(`  SSL 实例   ${SSL_URL.replace(/:[^:@/]*@/, ':****@')}`)
  else console.log('  SSL 实例   （未配置）')
  if (PLAIN_URL) console.log(`  明文实例   ${PLAIN_URL.replace(/:[^:@/]*@/, ':****@')}`)
  else console.log('  明文实例   （未配置）')
  console.log(`  CA 证书    ${CA_PATH}`)
  console.log('─'.repeat(70))

  // ---- 1. 无 SSL：默认(prefer)与 disable 都应走明文 ----
  if (PLAIN_URL) {
    console.log('\n[1] 未开 SSL 的实例：prefer 必须优雅回退明文')
    const prefer = await tryConnect({ url: PLAIN_URL, sslmode: 'prefer' })
    check('1a. prefer：连接成功', prefer.ok === true, prefer.error)
    check('1b. prefer：★ 回退为明文（encrypted === false）', prefer.ok === true && prefer.encrypted === false, prefer)

    const noMode = await tryConnect({ url: PLAIN_URL })
    check('1c. 不填 sslmode：默认 prefer，同样回退明文', noMode.ok === true && noMode.encrypted === false, noMode)

    const disabled = await tryConnect({ url: PLAIN_URL, sslmode: 'disable' })
    check('1d. disable：明文连接成功', disabled.ok === true && disabled.encrypted === false, disabled)

    const required = await tryConnect({ url: PLAIN_URL, sslmode: 'require' })
    check('1e. ★ require：必须失败（服务端不支持 SSL，不能降级）', required.ok === false, required)
  } else {
    skip('1. 未开 SSL 实例的回退行为', '未配置 DBSTUDIO_PG_PLAIN_URL')
  }

  // ---- 2. SSL 实例：各模式的正向行为 ----
  if (SSL_URL) {
    console.log('\n[2] 开 SSL 的实例：加密真的生效')
    const disabled = await tryConnect({ url: SSL_URL, sslmode: 'disable' })
    check('2a. disable：连接成功但不是加密的', disabled.ok === true && disabled.encrypted === false, disabled)

    const required = await tryConnect({ url: SSL_URL, sslmode: 'require' })
    check('2b. require：★ 加密成功', required.ok === true && required.encrypted === true, required)
    check('2c. require：TLS 版本可读（说明真握手）', typeof required.tlsVersion === 'string', required)

    const defaulted = await tryConnect({ url: SSL_URL })
    check('2d. 不填 sslmode：默认 prefer，对 SSL 实例应是加密的', defaulted.ok === true && defaulted.encrypted === true, defaulted)

    const allow = await tryConnect({ url: SSL_URL, sslmode: 'allow' })
    check('2e. allow：服务端允许明文，因此先走明文', allow.ok === true && allow.encrypted === false, allow)

    const verifyCa = await tryConnect({ url: SSL_URL, sslmode: 'verify-ca', sslrootcert: CA_PATH })
    check('2f. verify-ca + 正确 CA：加密成功', verifyCa.ok === true && verifyCa.encrypted === true, verifyCa)

    const verifyFull = await tryConnect({ url: SSL_URL, sslmode: 'verify-full', sslrootcert: CA_PATH })
    check('2g. verify-full + 正确 CA：加密成功', verifyFull.ok === true && verifyFull.encrypted === true, verifyFull)

    // ---- 3. 反向：这些必须失败，否则等于"以为校验了、其实没有" ----
    console.log('\n[3] 安全反证：配置错了必须连不上')

    const badCa = await tryConnect({ url: SSL_URL, sslmode: 'verify-ca', sslrootcert: '/nonexistent/ca.pem' })
    check('3a. ★ verify-ca 给了不存在的 CA：必须失败', badCa.ok === false, badCa)
    check(
      '3b. 错误信息点明是 CA 文件问题（不是含糊的"连接失败"）',
      badCa.ok === false && String(badCa.error?.message ?? '').includes('CA 证书文件不存在'),
      badCa
    )

    const noCa = await tryConnect({ url: SSL_URL, sslmode: 'verify-full' })
    check('3c. ★ verify-full 没给 CA：必须失败', noCa.ok === false, noCa)

    /**
     * 用**另一个 CA 文件**（把服务端证书内容改掉）验证链校验真的生效。
     * 这是最容易被写成假绿的一条：如果实现只是"读了文件就当成通过"，
     * 换一个无关的 PEM 也照样连上——那种实现等于没有校验。
     */
    const wrongCa = await tryConnect({
      url: SSL_URL,
      sslmode: 'verify-full',
      sslrootcert: process.env['DBSTUDIO_PG_SSL_WRONG_CA'] ?? resolve(root, 'tests/.ssl-fixture/wrong-ca.pem')
    })
    check('3d. ★ verify-full 用无关 CA：必须失败（证明真的在校验链）', wrongCa.ok === false, wrongCa)

    /**
     * 主机名不匹配：用 `127.0.0.1` 能连、但把 host 改成一个**在 DNS 里
     * 解析到本机却不在证书 SAN 里**的名字是环境相关的，不可移植。
     * 改用更可靠的方式：直接验证 `verify-ca` 与 `verify-full` 的差别——
     * 证书里 SAN 有 127.0.0.1，所以两者都该成功；这条断言用来钉住
     * "verify-ca 不要顺手把主机名校验也做掉"（那会让它在 IP 场景下莫名失败）。
     */
    const verifyCaOnIp = await tryConnect({ url: SSL_URL, sslmode: 'verify-ca', sslrootcert: CA_PATH })
    check('3e. verify-ca 对 IP 直连不因主机名校验失败', verifyCaOnIp.ok === true, verifyCaOnIp)

    const illegal = await tryConnect({ url: SSL_URL, sslmode: 'verify_full' })
    check('3f. ★ 非法 sslmode 值：必须明确报错', illegal.ok === false, illegal)
    check(
      '3g. 错误信息列出合法取值（帮用户改正，而不是只说"不支持"）',
      illegal.ok === false && String(illegal.error?.message ?? '').includes('verify-ca'),
      illegal
    )
  } else {
    skip('2/3. SSL 实例上的加密与校验断言', '未配置 DBSTUDIO_PG_SSL_URL')
  }

  // ---- 4. 取消查询必须复用同一套 SSL 策略 ----
  if (SSL_URL) {
    console.log('\n[4] 取消查询：在 SSL 连接上同样要能取消')
    /**
     * 这条断言防的是一个很容易漏的实现细节：取消查询要**另开一条连接**，
     * 若那条连接忘了带 SSL，会被 pg_hba 拒绝 → 表现为"取消按钮点了没反应"。
     * 而且这个 bug **只在远端 SSL 库上出现**，本机测试永远发现不了。
     */
    const info = parsePgUrl(SSL_URL)
    const host = launchHost()
    try {
      await host.waitForEvent((f) => f.kind === 'handshake')
      const conn = await host.call('connect', {
        config: {
          dialectId: 'postgresql',
          name: 'ssl-cancel',
          options: {
            host: info.host,
            port: info.port,
            database: info.database,
            user: info.user,
            sslmode: 'require'
          }
        },
        secret: info.password
      })
      check('4a. SSL 连接建立成功', conn.result?.ok !== false && !conn.error, conn.error)

      // 起一条长查询（不 await，留在飞行中），然后取消它。
      const slow = host.call('query', { sql: 'SELECT pg_sleep(10)', options: {} }).catch((e) => e)
      await new Promise((r) => setTimeout(r, 1200))
      const cancel = await host.call('cancelQuery', {})
      check('4b. ★ SSL 连接上的 cancelQuery 返回 true', cancel.result === true, cancel)
      const slowResult = await slow
      check(
        '4c. ★ 慢查询确实被中断（不是只返回了 true）',
        slowResult instanceof Error || slowResult.error !== undefined,
        slowResult
      )
      const msg = JSON.stringify(slowResult)
      check('4d. 中断错误是 SQLSTATE 57014 语义', msg.includes('canceling statement due to user request'), msg.slice(0, 200))
    } catch (thrown) {
      check('4. SSL 连接上的查询取消', false, String(thrown))
    } finally {
      await host.close()
    }
  } else {
    skip('4. SSL 连接上的查询取消', '未配置 DBSTUDIO_PG_SSL_URL')
  }
}

main()
  .catch((thrown) => {
    console.error('未捕获异常:', thrown)
    results.push({ name: '未捕获异常', passed: false })
  })
  .finally(() => {
    const failed = results.filter((r) => !r.passed)
    const skipped = results.filter((r) => r.skipped)
    console.log('\n' + '='.repeat(70))
    console.log(
      `汇总: ${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL` +
        (skipped.length > 0 ? `, ${skipped.length} SKIP` : '')
    )
    if (failed.length > 0) {
      console.log('失败项：')
      for (const f of failed) console.log(`  - ${f.name}`)
      process.exit(1)
    }
    console.log('SSL 测试通过 ✅')
  })
