/**
 * 生成 **SSL 测试用的 PostgreSQL 夹具**：自签证书 + 一个配置好的数据目录。
 *
 * ===== 为什么这个脚本只造"材料"，不负责启动数据库 =====
 *
 * SSL 的验证需要**同一个 PG 跑两种形态**：
 *   - 开了 SSL 的（验证 require / verify-ca / verify-full 真加密）
 *   - 没开 SSL 的（验证 prefer 真的回退明文，而不是假成功）
 *
 * 而且 CI 里我们会用 docker 起服务端（证书挂在容器里），本地则用 brew 的
 * initdb/pg_ctl。两种方式差别很大，所以这里只做**跨平台一致的那部分**：
 * 生成一对证书，并输出它们的路径。启动与编排留给调用方（测试脚本 / CI）。
 *
 * ===== 为什么证书用自签，而不是连真实 CA =====
 *
 * 我们要验证的语义是"**校不校验证书链**"，而不是"某个特定 CA 能不能用"。
 * 自签证书恰好让这条边界变得可观测：
 *   - `require`  → 必须连上（不校验证书）
 *   - `verify-ca`/`verify-full` + 这个自签证书当 CA → 必须连上
 *   - `verify-full` + 换一个**不匹配**的主机名 → 必须连不上
 *
 * 如果用一个公共受信任的证书，第二条就失去区分度（它本来就会被系统信任）。
 *
 * 用法：
 *   node scripts/make-ssl-fixture.mjs <输出目录>
 * 产物：
 *   <输出目录>/server.crt   服务端证书（同时用作测试里的"正确 CA"）
 *   <输出目录>/server.key   服务端私钥（chmod 600）
 *   <输出目录>/wrong-ca.pem 一张**无关**的自签证书，用于反证"链校验真的生效"
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const outDir = resolve(process.argv[2] ?? 'tests/.ssl-fixture')
const crt = resolve(outDir, 'server.crt')
const key = resolve(outDir, 'server.key')
const wrongCa = resolve(outDir, 'wrong-ca.pem')

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true })
}

/**
 * SAN 里同时放 `localhost` 与 `127.0.0.1`：
 * 测试要用两者各连一次，确认 verify-full 的"主机名匹配"是**逐字**判断，
 * 而不是"反正能解析就行"。
 */
execFileSync(
  'openssl',
  [
    'req',
    '-new',
    '-x509',
    '-days',
    '2',
    '-nodes',
    '-out',
    crt,
    '-keyout',
    key,
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
)

// PG 拒绝使用权限过宽的私钥（"private key file has group or world access"），必须 600。
chmodSync(key, 0o600)

/**
 * 再生成一张**无关的**自签证书，当作"错误 CA"。
 *
 * 为什么需要它：`verify-*` 的测试若只断言"给了不存在的路径会失败"，
 * 那验的只是文件读取，不是证书链校验。用一张能正常解析、但不是签发者的
 * 证书去连，才能真正逼出 `rejectUnauthorized: true` 的行为——
 * 若实现偷懒把校验关掉了，这条会连上，测试立刻变红。
 */
execFileSync(
  'openssl',
  [
    'req',
    '-new',
    '-x509',
    '-days',
    '2',
    '-nodes',
    '-out',
    wrongCa,
    '-keyout',
    resolve(outDir, 'wrong-ca.key'),
    '-subj',
    '/CN=definitely-not-the-server',
    '-addext',
    'subjectAltName=DNS:definitely-not-the-server'
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
)

console.log(`[make-ssl-fixture] 证书已生成：${crt}`)
console.log(`[make-ssl-fixture] 私钥已生成：${key}`)
console.log(`[make-ssl-fixture] 对照 CA 已生成：${wrongCa}`)
