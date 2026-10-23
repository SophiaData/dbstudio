/**
 * 连接的持久化存储。
 *
 * ===== 这个模块存在的唯一理由：重启之后连接还在 =====
 *
 * 没有它时，用户每次启动都要重新填一遍主机名/端口/密码。但"存下来"这件事
 * 有一个绕不开的风险：**密码一旦落盘就可能被读走**。所以本模块的设计
 * 几乎全部围绕"让密码不以明文出现在任何文件里"展开。
 *
 * ===== 三条硬性设计（都不是可选项） =====
 *
 * 1. **配置与凭据分文件**（`connections.json` / `secrets.json`）。
 *    配置要能被日志、被 UI、被 issue 贴出来排查；密码不行。混在一个文件里，
 *    任何一次"顺手把配置打印出来"都会带上密文甚至明文。
 *    分文件的本质是**降低误用面**，而不是加密强度的需要。
 *
 * 2. **密码只以 cipher 产出的密文形式落盘**，且 cipher 由外部注入。
 *    生产用 Electron `safeStorage`（走 OS 钥匙串/DPAPI），测试用可逆假实现。
 *    这样 store 本身能被纯 Node 覆盖，而"真实加密"这件事留给 Electron 验证。
 *
 * 3. **cipher 不可用时拒绝保存密码**，绝不退化成明文。
 *    这条最容易在实现时"为了方便"绕过——但一旦发生一次，用户的所有
 *    生产密码就都躺在磁盘上了。宁可让功能降级（只存配置、每次手输密码），
 *    也不能偷偷存明文。
 *
 * ===== 为什么不复用 electron-store 之类 =====
 *
 * 它们解决的是"读写 JSON"，而这里的难点是**正确性契约**（原子写、坏文件降级、
 * 密码隔离、cipher 注入）。这些必须看得见、测得着，不能埋在一个第三方
 * 依赖的默认行为里。这个文件不到 300 行，自己写更可控。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConnectionConfig } from '../core/dialect'
import type { SecretInput, SecretMap } from '../core/driver'
import { isEmptySecret, normalizeSecret, SECRET_KEYS } from '../core/driver'

/** 当前配置文件格式版本。结构有不兼容变化时递增，并在 load 里做迁移。 */
export const CONNECTIONS_SCHEMA_VERSION = 1

const CONNECTIONS_FILE = 'connections.json'
const SECRETS_FILE = 'secrets.json'

/**
 * 密码加解密器。
 *
 * 由调用方注入，而不是本模块 import safeStorage：
 *   - 生产：`safeStorage` 包装（只在 Electron 主进程可用）
 *   - 测试：可逆假实现（纯 Node 可跑）
 *
 * 接口刻意用 `Buffer` 而不是 string：密文是二进制，转 base64 只是**落盘格式**，
 * 不该让加解密层也接受 base64——那样"谁负责编码"会变得模糊，
 * 典型后果是某处编码两次、另一处解码一次。
 */
export interface SecretCipher {
  encrypt(plain: string): Buffer
  decrypt(payload: Buffer): string
}

/**
 * cipher 不可用时的错误类型。
 *
 * 单独一个类而不是普通 Error，是为了让上层能**精确识别**这种情况并给出
 * 用户能理解的提示（"此系统不支持安全存储，密码未保存，请每次手动输入"），
 * 而不是把它和磁盘写失败混成一句"保存失败"。
 */
export class SecretStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretStorageUnavailableError'
  }
}

/** connections.json 里一条连接的落盘形态。 */
interface StoredConnection {
  readonly id: string
  readonly config: ConnectionConfig
}

interface ConnectionsFile {
  readonly schemaVersion: number
  readonly connections: readonly StoredConnection[]
}

/** 解密出来的具名凭据；没有存过任何凭据时为 undefined。 */
export type StoredSecret = SecretMap | undefined

/**
 * 新密文的明文载荷前缀。
 *
 * 为什么不能直接把 JSON 放进 cipher：`secrets.json` 里的 value 是密文，
 * 而**上一版已经存过纯字符串密码的密文**。升级后那些密文解密出来就是
 * `"hunter2"`，若直接 `JSON.parse` 会失败，老连接就全部读不到密码。
 *
 * 前缀让两种历史形态可以被无歧义地区分：
 *   - `dbstudio-secret-v1:{...}` → 具名 SecretMap
 *   - 其它任意字符串             → 旧版单密码，按 `{ dbPassword }` 解释
 *
 * 不用“尝试 JSON.parse，失败就当归一字符串”的原因：合法密码完全可以是
 * 一段 JSON 文本（例如某些自动化系统生成的 token），那样会被误判。
 */
const SECRET_PAYLOAD_PREFIX = 'dbstudio-secret-v1:'

export interface ConnectionStoreOptions {
  /** 落盘目录。生产传 `app.getPath('userData')`，测试传临时目录。 */
  readonly baseDir: string
  /** 加解密器。为 null 表示当前环境不支持安全存储（此时拒绝保存密码）。 */
  readonly cipher: SecretCipher | null
  /** 日志出口，默认静默（store 是基础设施，不该往 stdout 乱写）。 */
  readonly onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/**
 * `ConnectionStore`：只管"读写磁盘状态"，不管连接生命周期。
 *
 * 这个边界很重要：把它和 ConnectionManager 分开，才能用纯 Node 测试
 * "存了什么、读回什么、坏文件怎么办"，而不必启动 Electron 或子进程。
 */
export class ConnectionStore {
  readonly #baseDir: string
  readonly #cipher: SecretCipher | null
  readonly #onLog: (level: 'info' | 'warn' | 'error', message: string) => void

  /** 内存中的配置清单，作为磁盘状态的镜像，避免每次读都碰 IO。 */
  #connections: StoredConnection[] = []
  /** 内存中的密文（connectionId → base64）。 */
  #secrets: Record<string, string> = {}

  constructor(options: ConnectionStoreOptions) {
    this.#baseDir = options.baseDir
    this.#cipher = options.cipher
    this.#onLog = options.onLog ?? (() => {})
    // 构造即载入：调用方拿到的 store 已经是"可用的"。
    // 载入失败不会抛——坏文件降级为空清单（见 #loadConnections）。
    this.#loadConnections()
    this.#loadSecrets()
  }

  // -------------------------------------------------------------------------
  // 路径
  // -------------------------------------------------------------------------

  get connectionsPath(): string {
    return join(this.#baseDir, CONNECTIONS_FILE)
  }

  get secretsPath(): string {
    return join(this.#baseDir, SECRETS_FILE)
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  /** 当前保存的所有连接配置（按落盘顺序）。 */
  listConnections(): StoredConnection[] {
    // 复制一层：调用方拿到的数组不该能反向修改 store 内部状态。
    return this.#connections.map((c) => ({ id: c.id, config: c.config }))
  }

  getConnection(id: string): StoredConnection | undefined {
    return this.#connections.find((c) => c.id === id)
  }

  /**
   * 读取某连接的具名凭据。
   *
   * 三个失败都被**降级为 undefined**而不是抛错：
   *   - 没存过凭据
   *   - cipher 不可用
   *   - 密文被篡改/解密失败
   *
   * 为什么统一降级：密码读不出来时，正确的用户路径是"提示重输密码"，
   * 而不是让整个连接列表加载失败。一个连接的密码坏了不该拖垮其它连接。
   * 解密失败会写一条 warn 日志，保证它**不是完全静默**的。
   */
  getSecret(id: string): StoredSecret {
    const encoded = this.#secrets[id]
    if (encoded === undefined) return undefined
    if (this.#cipher === null) {
      this.#onLog('warn', `[store] 无法读取连接 ${id} 的凭据：当前环境不支持安全存储`)
      return undefined
    }
    try {
      const payload = Buffer.from(encoded, 'base64')
      const plain = this.#cipher.decrypt(payload)
      return decodeSecretPayload(plain)
    } catch (err) {
      this.#onLog(
        'warn',
        `[store] 连接 ${id} 的凭据解密失败（可能被篡改），按"未保存密码"处理: ${describeThrown(err)}`
      )
      return undefined
    }
  }

  /** 该环境是否支持安全存储密码。UI 据此决定密码框是否提示"不会被保存"。 */
  get canStoreSecrets(): boolean {
    return this.#cipher !== null
  }

  /**
   * 该连接**是否存有密文**——不解密，只看有没有那条记录。
   *
   * ===== 为什么不能复用 `getSecret(id) !== undefined` =====
   *
   * 两个原因：
   *   1. `getSecret` 会真的解密。调用方（如 list() 拼摘要）只是想回答
   *      "存没存"，没必要为此付出一次解密开销，更没必要让明文在内存里多待一会儿。
   *   2. **cipher 不可用时 `getSecret` 一律返回 undefined**（它解密不了），
   *      于是"有密文但本机现在解不开"和"根本没存过"会被混成同一个结果。
   *      而 UI 需要区分这两种情况：前者密码其实存着（换台机器/恢复 keyring 还能用），
   *      后者是真的没有。所以单独一个只看存储状态的查询更准确。
   */
  hasSecret(id: string): boolean {
    return typeof this.#secrets[id] === 'string' && this.#secrets[id].length > 0
  }

  // -------------------------------------------------------------------------
  // 写入
  // -------------------------------------------------------------------------

  /**
   * 保存或更新一条连接配置。
   *
   * 只处理配置，**不碰密码**——密码走 `setSecret`，两者物理隔离。
   * 这是刻意的：配置写入是高频、低风险操作，不该被迫和凭据绑定。
   */
  saveConnection(id: string, config: ConnectionConfig): void {
    const index = this.#connections.findIndex((c) => c.id === id)
    const entry: StoredConnection = { id, config }
    if (index === -1) {
      this.#connections = [...this.#connections, entry]
    } else {
      // 保持原位置替换，避免"改一次配置顺序就变"造成的 UI 抖动。
      this.#connections = [
        ...this.#connections.slice(0, index),
        entry,
        ...this.#connections.slice(index + 1)
      ]
    }
    this.#flushConnections()
  }

  /**
   * 保存具名凭据（加密后）。
   *
   * `input` 为字符串时按数据库口令处理（兼容旧调用方）；
   * 为对象时支持多个独立机密（数据库 / SSH 登录 / SSH 私钥口令）。
   *
   * 空字符串、空对象、undefined 都表示"清除该连接的全部凭据"。
   * 注意这里**不做跨 key 合并**——合并是 ConnectionManager 的职责，
   * 因为只有它知道这次更新是“用户只改了 SSH 口令”还是“要重置整个凭据”。
   *
   * ===== cipher 不可用时抛错而不是静默跳过 =====
   *
   * 静默跳过会让 UI 显示"已保存"，而用户重启后发现密码没了——
   * 且更糟的是，如果这里改成"存明文"，就彻底违背了本模块的初衷。
   * 抛 `SecretStorageUnavailableError` 让上层能给出准确提示。
   */
  setSecret(id: string, input: SecretInput): void {
    const secret = normalizeSecret(input)
    if (isEmptySecret(secret)) {
      this.deleteSecret(id)
      return
    }
    if (this.#cipher === null) {
      throw new SecretStorageUnavailableError(
        '当前系统不支持安全存储（safeStorage 不可用），为避免明文落盘，密码不会被保存。' +
          '请在每次连接时手动输入密码。'
      )
    }
    const payload = this.#cipher.encrypt(encodeSecretPayload(secret))
    this.#secrets = { ...this.#secrets, [id]: payload.toString('base64') }
    this.#flushSecrets()
  }

  /** 删除某连接的密文。不存在时静默返回（幂等）。 */
  deleteSecret(id: string): void {
    if (!(id in this.#secrets)) return
    const next = { ...this.#secrets }
    delete next[id]
    this.#secrets = next
    this.#flushSecrets()
  }

  /**
   * 删除一条连接（配置 + 凭据）。
   *
   * 顺序：先删配置再删凭据。若中途崩溃，最坏情况是"配置没了、密文还在"——
   * 那是一段没人引用的孤儿密文（无法被解密成有用信息，且下次同 id 会被覆盖），
   * 比反过来的"密文没了、配置还在"（用户重启后看到一个连不上的连接）要好。
   */
  deleteConnection(id: string): void {
    const before = this.#connections.length
    this.#connections = this.#connections.filter((c) => c.id !== id)
    if (this.#connections.length !== before) this.#flushConnections()
    this.deleteSecret(id)
  }

  // -------------------------------------------------------------------------
  // 载入（含坏文件降级）
  // -------------------------------------------------------------------------

  #loadConnections(): void {
    const path = this.connectionsPath
    if (!existsSync(path)) {
      this.#connections = []
      return
    }

    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (err) {
      // 读不了（权限/IO 错误）也降级为空，但不改名——文件本身可能是好的。
      this.#onLog('warn', `[store] 无法读取连接配置，按空清单处理: ${describeThrown(err)}`)
      this.#connections = []
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      // ★ 坏 JSON：**改名备份而不是删除**。用户的配置可能是手工编辑时
      // 少了个逗号，改回来就能救；直接删等于把人家的连接全弄丢了。
      this.#quarantineConnectionsFile(`JSON 解析失败: ${describeThrown(err)}`)
      this.#connections = []
      return
    }

    const file = parsed as Partial<ConnectionsFile>
    if (
      typeof file !== 'object' ||
      file === null ||
      typeof file.schemaVersion !== 'number' ||
      !Array.isArray(file.connections)
    ) {
      // 结构不符合预期（可能是旧版本或手工改坏）——同样隔离备份。
      this.#quarantineConnectionsFile('文件结构不符合预期（缺 schemaVersion 或 connections）')
      this.#connections = []
      return
    }

    if (file.schemaVersion !== CONNECTIONS_SCHEMA_VERSION) {
      // ★ 未知版本：不崩、不猜、不覆盖。备份后降级为空清单。
      // 为什么不当场"升级"：我们不认识未来格式，硬改可能毁掉用户数据。
      // 备份 + 空清单至少让用户能手工把老文件捞回来。
      this.#quarantineConnectionsFile(
        `schemaVersion ${file.schemaVersion} 与当前 ${CONNECTIONS_SCHEMA_VERSION} 不匹配`
      )
      this.#connections = []
      return
    }

    // 逐条校验而不是整体信任：一条坏数据不该让整个清单作废。
    const valid: StoredConnection[] = []
    for (const item of file.connections) {
      const candidate = item as Partial<StoredConnection>
      if (
        typeof candidate?.id === 'string' &&
        candidate.id.length > 0 &&
        typeof candidate.config === 'object' &&
        candidate.config !== null &&
        typeof candidate.config.dialectId === 'string'
      ) {
        valid.push({ id: candidate.id, config: candidate.config as ConnectionConfig })
      } else {
        this.#onLog('warn', '[store] 跳过一条格式非法的连接记录')
      }
    }
    this.#connections = valid
  }

  #loadSecrets(): void {
    const path = this.secretsPath
    if (!existsSync(path)) {
      this.#secrets = {}
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('secrets.json 顶层不是对象')
      }
      // 只保留值是字符串的条目，防止坏数据把后面的类型推断搞乱。
      const clean: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') clean[k] = v
      }
      this.#secrets = clean
    } catch (err) {
      // 凭据文件坏了：更不该抛——大不了所有密码都"未保存"，用户重输即可。
      // 同样隔离备份，给人工救援留机会。
      this.#quarantineFile(path, `secrets.json 解析失败: ${describeThrown(err)}`)
      this.#secrets = {}
    }
  }

  /**
   * 把坏文件改名成 `.corrupt-<时间戳>`。
   *
   * 用 rename 而不是复制+删除：rename 是原子的，且**绝不丢失内容**。
   * 时间戳用 `Date.now()` 而不是格式化日期——这里不给人看，只求唯一。
   * 同名冲突时（极端情况同毫秒两次）退化为加序号，保证不覆盖已有备份。
   */
  #quarantineFile(path: string, reason: string): void {
    if (!existsSync(path)) return
    const stamp = Date.now()
    let target = `${path}.corrupt-${stamp}`
    let n = 1
    while (existsSync(target)) {
      target = `${path}.corrupt-${stamp}-${n}`
      n += 1
    }
    try {
      renameSync(path, target)
      this.#onLog(
        'warn',
        `[store] 配置文件损坏，已隔离备份（未删除）→ ${target.split('/').pop()}（原因: ${reason}）`
      )
    } catch (err) {
      // 改名都失败时，至少不要删原文件、也不要抛崩启动。
      this.#onLog('error', `[store] 无法隔离损坏的配置文件 ${path}: ${describeThrown(err)}`)
    }
  }

  #quarantineConnectionsFile(reason: string): void {
    this.#quarantineFile(this.connectionsPath, reason)
  }

  // -------------------------------------------------------------------------
  // 原子写
  // -------------------------------------------------------------------------

  /**
   * 原子写一个 JSON 文件。
   *
   * ===== 为什么必须 temp + rename =====
   *
   * 直接 `writeFileSync(path)` 在断电/崩溃时会留下**半个文件**——
   * 下次启动解析失败，用户的连接就全没了。而 rename 在同一文件系统内
   * 是原子的：要么旧文件完整、要么新文件完整，不存在中间态。
   *
   * 临时文件名带 pid + 时间戳：多实例同时写时不会互相踩对方的 temp。
   * 写完后 temp 会被 rename 掉，不会残留——这一点由 e2e 断言把关。
   *
   * 权限 0600：配置与凭据只有本用户可读。这挡不住 root，但能挡住
   * 同机其它用户/误同步到共享目录的场景，成本又是零。
   */
  #atomicWriteJson(path: string, data: unknown): void {
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    const text = `${JSON.stringify(data, null, 2)}\n`

    // 先写临时文件。用 try/finally 保证**失败时也清理 temp**，
    // 否则一次写失败会在目录里留下一个垃圾 .tmp（e2e 会抓这个）。
    let wrote = false
    try {
      writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
      wrote = true
      renameSync(tmp, path)
    } catch (err) {
      if (!wrote || existsSync(tmp)) {
        try {
          // 清理失败就忽略：真正的错误是下面要抛的那个。
          rmQuietly(tmp)
        } catch {
          /* ignore */
        }
      }
      throw new Error(`原子写入失败（${path}）：${describeThrown(err)}`)
    }
  }

  #flushConnections(): void {
    const file: ConnectionsFile = {
      schemaVersion: CONNECTIONS_SCHEMA_VERSION,
      connections: this.#connections
    }
    this.#atomicWriteJson(this.connectionsPath, file)
  }

  #flushSecrets(): void {
    // secrets.json 只有 base64 密文，**不含明文**。
    this.#atomicWriteJson(this.secretsPath, this.#secrets)
  }

  /** 诊断用：文件是否已存在及其大小（0 表示不存在）。测试与排查会用到。 */
  debugFileSizes(): { connections: number; secrets: number } {
    const size = (p: string): number => (existsSync(p) ? statSync(p).size : 0)
    return { connections: size(this.connectionsPath), secrets: size(this.secretsPath) }
  }
}

function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 把具名凭据编码成一段可加密的字符串。
 *
 * 只序列化白名单键，且丢弃空串：避免 UI 传进来的 `{ sshPassword: '' }`
 * 被存成一个“看起来有凭据、实际为空”的条目。
 */
function encodeSecretPayload(secret: SecretMap): string {
  const clean: Record<string, string> = {}
  for (const key of SECRET_KEYS) {
    const value = secret[key]
    if (value !== undefined && value !== '') clean[key] = value
  }
  return SECRET_PAYLOAD_PREFIX + JSON.stringify(clean)
}

/**
 * 解码历史密文。无前缀一律视为旧版单密码。
 *
 * 校验必须是严格的：坏 JSON / 非字符串值 / 未知键都按“读不出来”处理，
 * 不能把任意内容塞进 SecretMap 再带进驱动。未知键尤其危险——它会被
 * 误以为是自己认识的凭据，最终表现成很难查的认证失败。
 */
function decodeSecretPayload(plain: string): StoredSecret {
  if (!plain.startsWith(SECRET_PAYLOAD_PREFIX)) {
    return plain === '' ? undefined : { dbPassword: plain }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(plain.slice(SECRET_PAYLOAD_PREFIX.length))
  } catch {
    throw new Error('凭据载荷不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('凭据载荷不是对象')
  }
  const allowed = new Set<string>(SECRET_KEYS)
  const out: { dbPassword?: string; sshPassword?: string; sshPassphrase?: string } = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.has(key)) throw new Error(`凭据载荷含未知键 ${key}`)
    if (typeof value !== 'string') throw new Error(`凭据载荷 ${key} 不是字符串`)
    if (value !== '') out[key as keyof typeof out] = value
  }
  return isEmptySecret(out) ? undefined : out
}

/** 删除单个临时文件；失败不抛（调用方本来就在错误路径上）。 */
function rmQuietly(path: string): void {
  try {
    // 用 unlinkSync 而不是 rmSync：这里删的是我们自己刚写的 .tmp，
    // 不是用户文件。仍然通过 try/catch 保证不影响主流程。
    unlinkSync(path)
  } catch {
    /* ignore */
  }
}
