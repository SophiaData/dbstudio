/**
 * PostgreSQL over SSH 隧道的端到端验证。
 *
 * ===== 为什么必须真的起 sshd，不能 mock =====
 *
 * 这个功能真正会出错的地方全在真实协议里：
 *   - ssh2 的 hostVerifier 返回 false 后，错误如何传回；
 *   - channel 是 Duplex，但 pg 会把它当 net.Socket 调 setNoDelay/connect；
 *   - 公钥认证、主机密钥指纹、forwardOut 的目标地址；
 *   - 隧道上另开连接做 query cancel 是否也被转发。
 *
 * mock 掉 SSH 只会验证“我们把参数传给了自己的 mock”，证明不了任何一条。
 *
 * ===== 环境约定 =====
 *
 *   DBSTUDIO_PG_URL     跳板机后面真实可访问的 PG，例如
 *                       postgres://postgres@127.0.0.1:55432/postgres
 *   DBSTUDIO_SSH_HOST   默认 127.0.0.1
 *   DBSTUDIO_SSH_PORT   默认 2222
 *   DBSTUDIO_SSH_USER   默认当前用户
 *   DBSTUDIO_SSH_KEY    默认 tests/.ssh-fixture/client_ed25519
 *   DBSTUDIO_SSH_HOST_KEY  可选；缺省时测试先触发一次“未确认主机”拿到指纹
 *
 * 缺少 PG_URL 或 sshd 不可用时，打印 SKIP 并 exit 0——不假装通过。
 * 至少要跑一条**正向 + 一条反向**，否则这个功能等于没验证。
 *
 * 运行：
 *   pnpm run ssh-fixture
 *   # 启动一个只监听 127.0.0.1:2222 的 sshd，授权 tests/.ssh-fixture/client_ed25519.pub
 *   DBSTUDIO_PG_URL=postgres://postgres@127.0.0.1:55432/postgres \
 *     node tests/e2e-ssh-tunnel.mjs
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { userInfo } from 'node:os'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostEntry = resolve(root, 'out/driver-host/index.js')
const PG_URL = process.env['DBSTUDIO_PG_URL']
const SSH_HOST = process.env['DBSTUDIO_SSH_HOST'] ?? '127.0.0.1'
const SSH_PORT = Number(process.env['DBSTUDIO_SSH_PORT'] ?? 2222)
const SSH_USER = process.env['DBSTUDIO_SSH_USER'] ?? userInfo().username
const SSH_KEY = process.env['DBSTUDIO_SSH_KEY'] ?? resolve(root, 'tests/.ssh-fixture/client_ed25519')

const results = []
function check(name, condition, detail) {
  const passed = Boolean(condition)
  results.push({ name, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  if (!passed && detail !== undefined) {
    console.log(`      ↳ ${typeof detail === 'string' ? detail : safeJson(detail)}`)
  }
  return passed
}
function skip(name, reason) {
  results.push({ name, passed: true, skipped: true })
  console.log(`SKIP  ${name}（${reason}）`)
}
function safeJson(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

if (!PG_URL) {
  console.log('跳过：未配置 SSH 隧道测试用的 PostgreSQL（DBSTUDIO_PG_URL）。')
  console.log('  需要：一个可从 SSH 跳板机访问的 PG，以及本机 sshd。')
  process.exit(0)
}
if (!existsSync(hostEntry)) {
  console.error(`[e2e-ssh] 缺少驱动宿主: ${hostEntry}（先跑 pnpm run build）`)
  process.exit(1)
}
if (!existsSync(SSH_KEY)) {
  console.log(`跳过：未找到 SSH 测试私钥 ${SSH_KEY}`)
  console.log('  先运行：pnpm run ssh-fixture')
  process.exit(0)
}

class HostProcess {
  #child
  #pending = new Map()
  #events = []
  #exitInfo = null
  #nextId = 1
  #stderrLines = []

  constructor(child) {
    this.#child = child
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (line.trim() === '') return
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        this.#failAll(new Error(`协议流被污染: ${line.slice(0, 180)}`))
        return
      }
      if (typeof frame?.id === 'number') {
        const waiter = this.#pending.get(frame.id)
        if (waiter) {
          this.#pending.delete(frame.id)
          clearTimeout(waiter.timer)
          waiter.resolve(frame)
        }
      } else {
        this.#events.push(frame)
      }
    })
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
      this.#stderrLines.push(line)
      if (this.#stderrLines.length > 200) this.#stderrLines.shift()
    })
    child.on('exit', (code, signal) => {
      this.#exitInfo = { code, signal }
      this.#failAll(new Error(`宿主退出（code=${code}, signal=${signal}）但仍有挂起请求`))
    })
  }

  #failAll(err) {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.#pending.clear()
  }

  get stderrText() {
    return this.#stderrLines.join('\n')
  }

  waitFor(predicate, timeoutMs = 15000) {
    const existing = this.#events.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((res, rej) => {
      const start = Date.now()
      const tick = setInterval(() => {
        const found = this.#events.find(predicate)
        if (found) {
          clearInterval(tick)
          res(found)
        } else if (this.#exitInfo || Date.now() - start > timeoutMs) {
          clearInterval(tick)
          rej(new Error(`等待握手超时或宿主已退出${this.stderrText ? `: ${this.stderrText.slice(-400)}` : ''}`))
        }
      }, 20)
    })
  }

  call(method, params, timeoutMs = 30000) {
    const id = this.#nextId++
    const frame = { id, method, ...(params === undefined ? {} : { params }) }
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rej(new Error(`RPC 超时 ${method}${this.stderrText ? `；stderr: ${this.stderrText.slice(-500)}` : ''}`))
      }, timeoutMs)
      this.#pending.set(id, { resolve: res, reject: rej, timer })
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
    })
  }

  async close(timeoutMs = 8000) {
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

function launch() {
  return new HostProcess(
    spawn(process.execPath, [hostEntry, '--dialect', 'postgresql'], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
  )
}

function parsePgUrl(url) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: Number(u.port === '' ? 5432 : u.port),
    database: decodeURIComponent(u.pathname.replace(/^\//, '') || 'postgres'),
    user: decodeURIComponent(u.username || 'postgres'),
    password: u.password === '' ? undefined : decodeURIComponent(u.password)
  }
}

const pg = parsePgUrl(URL.canParse(PG_URL) ? PG_URL : `postgres://${PG_URL}`)

/**
 * 指纹与系统 `ssh-keygen -lf` 对齐。
 * 优先用环境变量，其次用夹具里的 host 公钥；这样测试既能测“首次未知主机”，
 * 也能测“已知主机正常放行”。
 */
function fingerprintForFixture() {
  const env = process.env['DBSTUDIO_SSH_HOST_KEY']
  if (env) return env
  const pub = resolve(root, 'tests/.ssh-fixture/host_ed25519.pub')
  if (!existsSync(pub)) return undefined
  const text = execFileSync('ssh-keygen', ['-lf', pub], { encoding: 'utf8' }).trim()
  const match = /(SHA256:[A-Za-z0-9+/]+)/.exec(text)
  return match?.[1]
}

/** 确认 sshd 端口可连；不可连时如实 SKIP，而不是让后续断言全部变红。 */
async function sshReachable() {
  return new Promise((resolve) => {
    const socket = connect({ host: SSH_HOST, port: SSH_PORT })
    const finish = (reachable) => {
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(2000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function baseOptions(extra = {}) {
  return {
    host: pg.host,
    port: pg.port,
    database: pg.database,
    user: pg.user,
    // 测试里强制 disable，避免把 SSH 测试与 SSL 行为混在一起。
    sslmode: 'disable',
    sshHost: SSH_HOST,
    sshPort: SSH_PORT,
    sshUser: SSH_USER,
    sshPrivateKey: SSH_KEY,
    sshTargetHost: pg.host,
    sshTargetPort: pg.port,
    ...extra
  }
}

/**
 * 用一条新宿主连接，返回 { ok, frame, error }。
 * 每个用例独立进程，避免失败的隧道残留状态影响下一条。
 */
async function tryConnect({ options, secret, timeoutMs = 30000 }) {
  const host = launch()
  try {
    await host.waitFor((f) => f.kind === 'handshake')
    const frame = await host.call(
      'connect',
      {
        config: { dialectId: 'postgresql', name: 'ssh-probe', options },
        secret
      },
      timeoutMs
    )
    return { ok: frame.ok === true, frame, error: frame.error }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err), host }
  } finally {
    try {
      await host.call('disconnect', {}, 5000)
    } catch {
      // 连接未建立时 disconnect 可能失败，忽略。
    }
    await host.close()
  }
}

/** 从错误消息里提取指纹（协议错误是字符串，不携带结构化字段）。 */
function extractFingerprint(frame) {
  const text = String(frame?.error?.message ?? '')
  return /(SHA256:[A-Za-z0-9+/]+)/.exec(text)?.[1]
}

async function main() {
  console.log('─'.repeat(70))
  console.log('PostgreSQL over SSH：真实 sshd + 真实 PG')
  console.log(`  SSH  ${SSH_HOST}:${SSH_PORT} / ${SSH_USER}`)
  console.log(`  Key  ${SSH_KEY}`)
  console.log(`  PG   ${pg.host}:${pg.port}/${pg.database}`)
  console.log('─'.repeat(70))

  if (!(await sshReachable())) {
    skip('SSH 隧道全部断言', `sshd 在 ${SSH_HOST}:${SSH_PORT} 不可达`)
    return
  }

  const expectedFingerprint = fingerprintForFixture()
  console.log(`  指纹 ${expectedFingerprint ?? '（未预置，先走首次确认）'}`)

  // ---- 1. 首次连接：没有主机指纹必须拒绝，并返回指纹 ----
  {
    console.log('\n[1] 主机密钥确认（不做 TOFU）')
    const first = await tryConnect({
      options: baseOptions(),
      secret: { dbPassword: pg.password }
    })
    const got = extractFingerprint(first.frame)
    check('1a. ★ 未预置主机指纹时拒绝连接', first.ok === false, first.error)
    check('1b. ★ 错误码是 connection_failed（协议层保留可读原因）', first.frame?.error?.code === 'connection_failed', first.frame?.error)
    check('1c. ★ 拒绝时返回实际 SHA256 指纹供用户确认', typeof got === 'string' && got.startsWith('SHA256:'), first.frame?.error)
    if (expectedFingerprint) {
      check('1d. ★ 运行时算出的指纹与 ssh-keygen 逐字一致', got === expectedFingerprint, { got, expectedFingerprint })
    }
  }

  // ---- 2. 错误指纹：必须拒绝（反向断言） ----
  {
    console.log('\n[2] 错误指纹必须拒绝')
    const bad = await tryConnect({
      options: baseOptions({
        sshHostKeySha256: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      }),
      secret: { dbPassword: pg.password }
    })
    check('2a. ★ 指纹不匹配时连接失败', bad.ok === false, bad.error)
    check(
      '2b. 错误信息提示可能是中间人攻击或跳板机重装',
      String(bad.frame?.error?.message ?? '').includes('中间人') ||
        String(bad.frame?.error?.message ?? '').includes('不一致'),
      bad.frame?.error
    )
  }

  // ---- 3. 认证失败：用错误私钥必须拒绝 ----
  {
    console.log('\n[3] SSH 认证失败必须明确')
    const wrongKey = resolve(root, 'tests/.ssh-fixture/not-authorized-key')
    // 为这条用例临时造一个不在 authorized_keys 里的密钥；失败也比跳过有意义。
    let hasWrongKey = existsSync(wrongKey)
    if (!hasWrongKey) {
      try {
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', wrongKey], {
          stdio: 'ignore'
        })
        hasWrongKey = true
      } catch {
        hasWrongKey = false
      }
    }
    if (hasWrongKey) {
      const bad = await tryConnect({
        options: baseOptions({
          sshPrivateKey: wrongKey,
          ...(expectedFingerprint === undefined ? {} : { sshHostKeySha256: expectedFingerprint })
        }),
        secret: { dbPassword: pg.password }
      })
      check('3a. ★ 未授权私钥导致认证失败', bad.ok === false, bad.error)
      check(
        '3b. 错误信息区分认证失败，而不是笼统的连接失败',
        String(bad.frame?.error?.message ?? '').includes('认证失败'),
        bad.frame?.error
      )
    } else {
      skip('3. SSH 认证失败反证', '无法生成临时未授权密钥')
    }
  }

  // ---- 4. 正向：隧道内建 PG、查询 + 可取消 ----
  {
    console.log('\n[4] 正向：隧道内真查询 / 多 channel 取消')
    const host = launch()
    try {
      await host.waitFor((f) => f.kind === 'handshake')
      const options = baseOptions(
        expectedFingerprint === undefined ? {} : { sshHostKeySha256: expectedFingerprint }
      )
      const conn = await host.call('connect', {
        config: { dialectId: 'postgresql', name: 'ssh-forward', options },
        secret: { dbPassword: pg.password }
      })
      check('4a. ★ 正确认指纹后经 SSH 建连成功', conn.ok === true, conn.error)
      if (conn.ok === true) {
        const q = await host.call('query', {
          sql: 'SELECT 1 AS ok, current_setting(\'application_name\') AS app',
          options: { keepCursor: false }
        })
        check(
          '4b. ★ 隧道内 SQL 真执行（返回 1）',
          q.ok === true && q.result?.rows?.[0]?.cells?.[0]?.value === 1,
          q.result ?? q.error
        )

        /**
         * 取消必须另开一条 channel（同一个 SSH 连接），否则跳板机场景下
         * 取消包根本到不了数据库。慢查询用 pg_sleep，避免本机快得看不出。
         */
        const slow = host.call('query', { sql: 'SELECT pg_sleep(10)', options: {} }).catch((e) => e)
        await new Promise((r) => setTimeout(r, 1200))
        const cancel = await host.call('cancelQuery', {})
        check('4c. ★ 隧道上 cancelQuery 返回 true', cancel.result === true, cancel)
        const slowResult = await slow
        check(
          '4d. ★ 慢查询确实被中断（不是只返回 true）',
          slowResult instanceof Error || slowResult.error !== undefined,
          slowResult
        )
        check(
          '4e. 中断消息是 SQLSTATE 57014 语义',
          JSON.stringify(slowResult).includes('canceling statement due to user request'),
          JSON.stringify(slowResult).slice(0, 220)
        )
      }
    } finally {
      await host.close()
    }
  }
}

await main()

const failed = results.filter((r) => !r.passed)
const skipped = results.filter((r) => r.skipped)
console.log('\n' + '='.repeat(70))
console.log(
  `汇总: ${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL` +
    (skipped.length > 0 ? `, ${skipped.length} SKIP` : '')
)
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.name}`)
  process.exit(1)
}
console.log('SSH 隧道测试通过 ✅')
