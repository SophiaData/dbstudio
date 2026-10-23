/**
 * 生成一个**只监听本机**的 SSH 测试跳板机所需的密钥材料。
 *
 * ===== 为什么不复用用户自己的 ~/.ssh =====
 *
 * 测试必须可重复、不能读取或改动用户的私钥；更不能假设本机已经为
 * 当前用户配置了 authorized_keys。这里生成一套临时密钥：
 *   - host_ed25519    跳板机主机密钥（用于验证首次连接返回的指纹）
 *   - client_ed25519  测试客户端私钥（用于公钥认证）
 *
 * 没有密码短语的私钥是**测试夹具**，只放在 tests/.ssh-fixture 且被 gitignore；
 * 生产代码仍然只读取用户指定的私钥文件，绝不自造密钥。
 *
 * 用法：
 *   node scripts/make-ssh-fixture.mjs tests/.ssh-fixture
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { userInfo } from 'node:os'

const outDir = resolve(process.argv[2] ?? 'tests/.ssh-fixture')
mkdirSync(outDir, { recursive: true, mode: 0o700 })

function ensureKey(path, comment) {
  if (existsSync(path) && existsSync(`${path}.pub`)) return
  // -N ''：测试密钥不加口令，便于自动化；私钥文件仍强制 0600。
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', path], {
    stdio: 'ignore'
  })
  chmodSync(path, 0o600)
}

const hostKey = join(outDir, 'host_ed25519')
const clientKey = join(outDir, 'client_ed25519')
ensureKey(hostKey, 'dbstudio-test-host')
ensureKey(clientKey, 'dbstudio-test-client')

// authorized_keys 的权限由 sshd StrictModes 管；这里显式给最小权限。
const authorized = join(outDir, 'authorized_keys')
writeFileSync(
  authorized,
  // sshd 会检查 authorized_keys 指定的文件必须由**目标登录用户**持有。
  // 在 CI 里测试以 root 跑、用户是 runner，若不改属主会直接 Permission denied。
  execFileSync('cat', [`${clientKey}.pub`], { encoding: 'utf8' }),
  { mode: 0o600 }
)
chmodSync(authorized, 0o600)

console.log(`[ssh-fixture] ✅ ${outDir}`)
console.log(`  host key   ${hostKey}`)
console.log(`  client key ${clientKey}`)

/**
 * 指纹用 ssh-keygen 计算，而不是在脚本里重写 sha256：测试要验证的正是
 * 我们算出来的格式与系统工具是否**逐字一致**（见 hostKeyFingerprint）。
 */
const fingerprintLine = execFileSync('ssh-keygen', ['-lf', `${hostKey}.pub`], {
  encoding: 'utf8'
}).trim()
console.log(`  ${fingerprintLine}`)

/**
 * 生成一份可直接给 `sshd -f` 的配置。
 *
 * 关键约束：
 *   - 只监听 127.0.0.1，测试跳板机绝不暴露到局域网；
 *   - PasswordAuthentication no，验证的是私钥路径而不是口令；
 *   - AllowTcpForwarding yes，否则 forwardOut 一定失败；
 *   - StrictModes no：fixture 目录通常带临时路径/权限差异，严格属主检查
 *     会让合法夹具也被拒（生产用户的 sshd 不会用这份配置）。
 */
const sshdConfig = join(outDir, 'sshd_config')
writeFileSync(
  sshdConfig,
  [
    'Port 2222',
    'ListenAddress 127.0.0.1',
    `HostKey ${hostKey}`,
    `PidFile ${join(outDir, 'sshd.pid')}`,
    `AuthorizedKeysFile ${authorized}`,
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'UsePAM no',
    'StrictModes no',
    'AllowTcpForwarding yes',
    'PermitRootLogin no',
    'X11Forwarding no',
    `AllowUsers ${userInfo().username}`,
    'LogLevel VERBOSE'
  ].join('\n') + '\n',
  { mode: 0o600 }
)
console.log(`  sshd config ${sshdConfig}`)
console.log(`  启动：/usr/sbin/sshd -f ${sshdConfig}`)
