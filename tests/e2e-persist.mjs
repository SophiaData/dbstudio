/**
 * 连接持久化与凭据加密的专项端到端验证。
 *
 * ===== 这个文件最大的风险：把"安全"测成假绿 =====
 *
 * 持久化测试最容易写成"看起来在验安全，其实永远为真"：
 *   - 只断言"调用了 encrypt"，不断言文件里真的没有明文 → 加解密写错也过
 *   - 明文用 `secret` 变量名而不是真实字符串 → 断言的是变量名不是内容
 *   - 坏文件测试只断言"没崩"，不断言"原内容还在备份里" → 数据被删也过
 *
 * 所以本文件的明文断言是**真的读文件字节、真的做 substring 匹配**，
 * 并且用一个足够独特、不可能在别处偶然出现的密码字符串。
 * 同样，损坏文件测试会打开 `.corrupt-*` 备份，确认原始内容还在。
 *
 * ===== 为什么用假 cipher 而不是真 safeStorage =====
 *
 * safeStorage 依赖 Electron 运行时 + 系统钥匙串，纯 Node 里不存在。
 * 这里注入一个**可逆、且密文与明文明显不同**的假 cipher：
 *   - 可逆：能验证"存进去能读回来"的完整链路
 *   - 非平凡：密文不是明文本身，所以"文件里没明文"这条断言有区分度
 *     （如果假 cipher 直接返回原文，明文断言就会误报泄漏——那反而是好事，
 *      说明它能抓到问题；但会让正确实现也失败，所以必须让假 cipher 真的变换一下）
 *
 * 真实 safeStorage 的可用性由 Electron 里的 GUI 自检（SMOKE_RESULT）负责，
 * 那份不在本文件覆盖范围内。
 *
 * 运行：node tests/e2e-persist.mjs
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 断言框架
// ---------------------------------------------------------------------------

const results = []

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

function skip(name, reason) {
  results.push({ name, passed: true, skipped: true, detail: reason })
  console.log(`SKIP  ${name}`)
  console.log(`      ↳ ${reason}`)
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
// 假 cipher
// ---------------------------------------------------------------------------

/**
 * 可逆假 cipher。
 *
 * 变换方式：每个字节 XOR 0x5A，再前后加一个固定标记。
 * 为什么不是恒等函数：恒等会让"文件里没有明文"这条断言**必然失败**，
 * 那样测试与实现就绑死了。而一个真的做了变换的假 cipher，
 * 既能让明文断言有区分度，又不需要真加密。
 *
 * 标记的作用：让"这确实是密文而不是明文"在字节层面可辨别，
 * 也让 decrypt 能识别"这不是我产出的密文"（篡改用例要用到）。
 */
const FAKE_MAGIC = Buffer.from('DBSTUDIOFAKE')
class FakeCipher {
  encrypt(plain) {
    const body = Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)
    return Buffer.concat([FAKE_MAGIC, body])
  }
  decrypt(payload) {
    if (!payload.subarray(0, FAKE_MAGIC.length).equals(FAKE_MAGIC)) {
      throw new Error('密文头不匹配：不是本 cipher 产物或已被篡改')
    }
    const body = payload.subarray(FAKE_MAGIC.length).map((b) => b ^ 0x5a)
    return body.toString('utf8')
  }
}

/** 一个"加密不可用"的 cipher 代表：传 null 即表示该环境不支持安全存储。 */

// ---------------------------------------------------------------------------
// 载入被测模块
// ---------------------------------------------------------------------------

/**
 * 用 vite 把 **tests/probe-entry.ts** 打进 out/ 再 import。
 *
 * 为什么入口是 probe-entry 而不是直接 ConnectionStore.ts：
 *   - 大部分用例只需要 ConnectionStore（纯 store 逻辑）；
 *   - 但 `secretStored` 三态用例需要 ConnectionManager（判定逻辑在它里面），
 *     并且需要一个**带 password 字段的假方言**，这只能通过注入构造参数做到。
 * probe-entry 同时导出 ConnectionStore / ConnectionManager / createManagerWithInjected，
 * 一个产物覆盖全部需求，不必打两次。
 *
 * 为什么不直接 import .ts：Node 不认 TS。项目没有 tsx/ts-node，
 * 而 vite 是直接依赖。打包目标不 import electron，系统 node 可直接跑。
 */
async function loadStoreModule() {
  const { build } = await import('vite')
  const outDir = resolve(root, 'out/.persist-probe')
  await build({
    configFile: false,
    root,
    logLevel: 'error',
    build: {
      outDir,
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      ssr: true,
      rollupOptions: {
        external: [/^node:/, 'electron'],
        output: { entryFileNames: 'store.cjs' }
      },
      lib: { entry: resolve(root, 'tests/probe-entry.ts'), formats: ['cjs'] }
    }
  })
  const entry = resolve(outDir, 'store.cjs')
  if (!existsSync(entry)) {
    throw new Error(`vite 未产出 ${entry}`)
  }
  return import(`file://${entry}`)
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 一个足够独特、绝不可能在其它地方偶然出现的密码。
 *
 * 用随机后缀而不是固定字符串：如果这个字符串在文件里出现，就**一定**是
 * 我们不希望的那次泄漏，而不是碰巧撞上某个常量/注释。
 */
function makeUniqueSecret(tag) {
  return `PLAINTEXT_MUST_NOT_LEAK_${tag}_${Math.random().toString(36).slice(2, 12)}`
}

function makeConfig(name, file) {
  return {
    dialectId: 'sqlite',
    name,
    options: { file }
  }
}

/** 建一个干净的临时目录（每次用 mkdtemp，避免测试间互相干扰）。 */
function freshDir(tag) {
  return mkdtempSync(join(tmpdir(), `dbstudio-persist-${tag}-`))
}

function listFiles(dir) {
  return existsSync(dir) ? readdirSync(dir) : []
}

/** 断言某目录下没有 `.tmp` 残留。原子写的失败模式就是留下这个。 */
function findTmpFiles(dir) {
  return listFiles(dir).filter((f) => f.endsWith('.tmp'))
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function main() {
  let mod
  try {
    mod = await loadStoreModule()
  } catch (err) {
    console.error('[e2e-persist] 无法构建/加载 ConnectionStore:', err)
    process.exit(1)
  }
  const { ConnectionStore, SecretStorageUnavailableError } = mod
  if (typeof ConnectionStore !== 'function') {
    console.error('[e2e-persist] 模块未导出 ConnectionStore，导出项:', Object.keys(mod))
    process.exit(1)
  }

  console.log('='.repeat(70))
  console.log('dbstudio 端到端验证：连接持久化与凭据加密')
  console.log(`node: ${process.version}`)
  console.log('='.repeat(70))

  // ===== 用例 1：往返（存 3 条 → 新 store 读回） =====
  {
    console.log('\n── 用例 1：配置往返 ──')
    const dir = freshDir('roundtrip')
    const cipher = new FakeCipher()
    const store = new ConnectionStore({ baseDir: dir, cipher })
    const configs = [
      makeConfig('本地库', '/tmp/a.db'),
      makeConfig('生产库', '/srv/b.db'),
      makeConfig('测试库', '/var/tmp/c.db')
    ]
    const ids = ['c1', 'c2', 'c3']
    ids.forEach((id, i) => store.saveConnection(id, configs[i]))

    // ★ 关键：**新建一个 store 实例**读回，而不是复用内存里那份。
    // 复用就只测了内存，没测"真的落到磁盘并重新解析"。
    const reopened = new ConnectionStore({ baseDir: dir, cipher })
    const loaded = reopened.listConnections()

    check('1. 读回的连接数量为 3', loaded.length === 3, formatDetail(loaded.length))
    let allMatch = true
    const mismatches = []
    for (let i = 0; i < ids.length; i += 1) {
      const back = reopened.getConnection(ids[i])
      const expected = configs[i]
      const ok =
        back !== undefined &&
        back.config.name === expected.name &&
        back.config.dialectId === expected.dialectId &&
        back.config.options.file === expected.options.file
      if (!ok) {
        allMatch = false
        mismatches.push({ id: ids[i], expected, actual: back })
      }
    }
    check('2. 每条配置逐字段一致（name/dialectId/options.file）', allMatch, formatDetail(mismatches))
    check(
      '3. 配置文件带 schemaVersion',
      (() => {
        try {
          const raw = JSON.parse(readFileSync(reopened.connectionsPath, 'utf8'))
          return raw.schemaVersion === 1
        } catch {
          return false
        }
      })(),
      (() => {
        try {
          return readFileSync(reopened.connectionsPath, 'utf8')
        } catch (e) {
          return String(e)
        }
      })()
    )
  }

  // ===== 用例 2：★ 明文不落盘（本任务最重要） =====
  {
    console.log('\n── 用例 2：★ 配置文件里绝不出现密码明文 ──')
    const dir = freshDir('noleak')
    const cipher = new FakeCipher()
    const store = new ConnectionStore({ baseDir: dir, cipher })

    const secret = makeUniqueSecret('CORE')
    store.saveConnection('c1', makeConfig('带密码的连接', '/tmp/x.db'))
    store.setSecret('c1', secret)

    // 真的读字节，不是看变量。
    const connectionsText = readFileSync(store.connectionsPath, 'utf8')
    const secretsText = readFileSync(store.secretsPath, 'utf8')

    check(
      '4. ★ connections.json 不含密码明文',
      !connectionsText.includes(secret),
      `明文 "${secret.slice(0, 20)}…" 泄露在 connections.json`
    )
    check(
      '5. ★ secrets.json 不含密码明文（只有 base64 密文）',
      !secretsText.includes(secret),
      `明文泄露在 secrets.json`
    )
    // 反向确认断言有区分度：把明文塞进一个字符串里，这套 includes 必须能抓到。
    // 若这里为 false，说明 includes 本身写坏了（比如比较了两个变量）。
    check(
      '6. [自检] 明文检测机制本身有效（构造一个含明文的串必须被判为"含明文"）',
      `${secret}`.includes(secret) && !connectionsText.includes(secret),
      '明文检测逻辑失效'
    )

    // 配置里也不该出现 secret 字段名——防止"把密码塞进 config.options"。
    check(
      '7. connections.json 里没有 secret/password 字段',
      !/"secret"\s*:|"password"\s*:|"passwd"\s*:/i.test(connectionsText),
      connectionsText.slice(0, 400)
    )

    // 密文必须真的能解回来（否则"没明文"可能只是"什么都没存"）。
    check(
      '8. 密文可解回原文（证明密码确实以密文形式保存了）',
      store.getSecret('c1')?.dbPassword === secret,
      `实际取回: ${store.getSecret('c1')}`
    )

    // 密文不是明文本身（确保假 cipher 真的做了变换，断言才有意义）。
    const secretsObj = JSON.parse(secretsText)
    const storedCipherText = Buffer.from(secretsObj['c1'], 'base64').toString('utf8')
    check(
      '9. secrets.json 里存的是变换后的密文（非原文）',
      storedCipherText !== secret && storedCipherText.length > 0,
      `密文内容: ${storedCipherText.slice(0, 40)}`
    )
  }

  // ===== 用例 3：原子写无 .tmp 残留 =====
  {
    console.log('\n── 用例 3：原子写，无 .tmp 残留 ──')
    const dir = freshDir('atomic')
    const store = new ConnectionStore({ baseDir: dir, cipher: new FakeCipher() })
    for (let i = 1; i <= 5; i += 1) {
      store.saveConnection(`c${i}`, makeConfig(`conn${i}`, `/tmp/${i}.db`))
      store.setSecret(`c${i}`, makeSecretFor(`c${i}`))
    }
    const tmps = findTmpFiles(dir)
    check('10. 写入后目录无残留 .tmp 文件', tmps.length === 0, formatDetail(tmps))
    check(
      '11. 目录只有预期的两个 JSON 文件',
      (() => {
        const files = listFiles(dir).filter((f) => !f.startsWith('.'))
        return files.length === 2 && files.includes('connections.json') && files.includes('secrets.json')
      })(),
      formatDetail(listFiles(dir))
    )
  }

  // ===== 用例 4：损坏文件（坏 JSON） =====
  {
    console.log('\n── 用例 4：坏文件不崩，改名备份（不删除） ──')
    const dir = freshDir('corrupt')
    const cipher = new FakeCipher()
    const store = new ConnectionStore({ baseDir: dir, cipher })
    store.saveConnection('c1', makeConfig('先有的一条', '/tmp/ok.db'))

    // 把 connections.json 写成坏 JSON，并记下它的原内容用于事后核对。
    const broken = '{invalid'
    writeFileSync(store.connectionsPath, broken, 'utf8')

    let reopened
    let constructError = null
    try {
      reopened = new ConnectionStore({ baseDir: dir, cipher })
    } catch (err) {
      constructError = err
    }
    check('12. 遇到坏 JSON 时构造 store 不抛错', constructError === null, String(constructError))
    check(
      '13. 坏文件时降级为空清单',
      reopened !== undefined && reopened.listConnections().length === 0,
      formatDetail(reopened?.listConnections?.())
    )

    const corruptFiles = listFiles(dir).filter((f) => f.includes('.corrupt-'))
    check('14. 生成了 .corrupt-* 备份文件', corruptFiles.length === 1, formatDetail(listFiles(dir)))
    check(
      '15. ★ 坏文件的原内容仍在备份里（不是被删/被清空）',
      corruptFiles.length === 1 &&
        readFileSync(join(dir, corruptFiles[0]), 'utf8') === broken,
      corruptFiles.length === 1
        ? `备份内容: ${readFileSync(join(dir, corruptFiles[0]), 'utf8')}`
        : '没有备份文件'
    )
    check(
      '16. 原文件名已不存在（已被改名而非复制）',
      !existsSync(store.connectionsPath),
      '原 connections.json 仍然存在'
    )
  }

  // ===== 用例 5：未知 schemaVersion =====
  {
    console.log('\n── 用例 5：未知 schemaVersion 降级不崩 ──')
    const dir = freshDir('schema')
    const cipher = new FakeCipher()
    const store = new ConnectionStore({ baseDir: dir, cipher })
    store.saveConnection('c1', makeConfig('x', '/tmp/x.db'))

    const future = JSON.stringify({
      schemaVersion: 999,
      connections: [{ id: 'c1', config: makeConfig('未来的', '/tmp/f.db') }]
    })
    writeFileSync(store.connectionsPath, future, 'utf8')

    let reopened
    let err = null
    try {
      reopened = new ConnectionStore({ baseDir: dir, cipher })
    } catch (e) {
      err = e
    }
    check('17. 未知版本时构造不抛错', err === null, String(err))
    check(
      '18. 未知版本降级为空清单',
      reopened !== undefined && reopened.listConnections().length === 0,
      formatDetail(reopened?.listConnections?.())
    )
    const corrupt = listFiles(dir).filter((f) => f.includes('.corrupt-'))
    check('19. 未知版本文件也被备份', corrupt.length === 1, formatDetail(listFiles(dir)))
    check(
      '20. ★ 未知版本文件内容完整保留在备份里（未来数据没被毁）',
      corrupt.length === 1 && readFileSync(join(dir, corrupt[0]), 'utf8') === future,
      corrupt.length === 1 ? '内容不一致' : '无备份'
    )
  }

  // ===== 用例 6：删除连接清掉配置与凭据 =====
  {
    console.log('\n── 用例 6：删除连接 → 配置与凭据都清除 ──')
    const dir = freshDir('delete')
    const cipher = new FakeCipher()
    const store = new ConnectionStore({ baseDir: dir, cipher })
    store.saveConnection('c1', makeConfig('要删的', '/tmp/d.db'))
    store.setSecret('c1', makeUniqueSecret('DEL'))
    store.saveConnection('c2', makeConfig('要留的', '/tmp/k.db'))
    store.setSecret('c2', 'keep-me-password')

    store.deleteConnection('c1')

    const reopened = new ConnectionStore({ baseDir: dir, cipher })
    check(
      '21. 删除后配置清单只剩 c2',
      reopened.listConnections().length === 1 && reopened.listConnections()[0].id === 'c2',
      formatDetail(reopened.listConnections())
    )
    check('22. 被删连接的凭据消失', reopened.getSecret('c1') === undefined, formatDetail(reopened.getSecret('c1')))
    const secretsObj = JSON.parse(readFileSync(reopened.secretsPath, 'utf8'))
    check('23. secrets.json 里已无 c1 的条目', !('c1' in secretsObj), formatDetail(Object.keys(secretsObj)))
    check(
      '24. 保留的连接凭据仍可读',
      reopened.getSecret('c2')?.dbPassword === 'keep-me-password',
      formatDetail(reopened.getSecret('c2'))
    )
  }

  // ===== 用例 7：凭据被篡改（decrypt 失败不崩） =====
  {
    console.log('\n── 用例 7：凭据被篡改 → 不崩，且不影响其它连接 ──')
    const dir = freshDir('tamper')
    const cipher = new FakeCipher()
    const store = new ConnectionStore({ baseDir: dir, cipher })
    const goodSecret = makeUniqueSecret('GOOD')
    store.saveConnection('c1', makeConfig('被破坏的', '/tmp/t.db'))
    store.setSecret('c1', goodSecret)
    store.saveConnection('c2', makeConfig('好的', '/tmp/g.db'))
    store.setSecret('c2', 'healthy-password')

    // 篡改 c1 的密文：破坏 magic 头，decrypt 会抛。
    const secretsObj = JSON.parse(readFileSync(store.secretsPath, 'utf8'))
    const brokenPayload = Buffer.from('TAMPERED_NOT_A_REAL_CIPHER', 'utf8')
    secretsObj['c1'] = brokenPayload.toString('base64')
    writeFileSync(store.secretsPath, JSON.stringify(secretsObj), 'utf8')

    const reopened = new ConnectionStore({ baseDir: dir, cipher })
    let readError = null
    let tamperedSecret
    try {
      tamperedSecret = reopened.getSecret('c1')
    } catch (e) {
      readError = e
    }
    check('25. 读取被篡改的凭据不抛错', readError === null, String(readError))
    check('26. 被篡改的凭据返回 undefined（按"未保存密码"处理）', tamperedSecret === undefined, formatDetail(tamperedSecret))
    check(
      '27. 其它连接的凭据仍能正常读取（坏一个不拖垮全部）',
      reopened.getSecret('c2')?.dbPassword === 'healthy-password',
      formatDetail(reopened.getSecret('c2'))
    )
    check('28. 坏凭据不影响配置清单加载', reopened.listConnections().length === 2, formatDetail(reopened.listConnections().length))
  }

  // ===== 用例 8：cipher 不可用 → 拒绝保存密码，且不写明文 =====
  {
    console.log('\n── 用例 8：★ cipher 不可用时拒绝保存密码（不退化成明文） ──')
    const dir = freshDir('nocipher')
    const secret = makeUniqueSecret('NOCIPHER')
    const store = new ConnectionStore({ baseDir: dir, cipher: null })

    store.saveConnection('c1', makeConfig('无加密环境', '/tmp/n.db'))
    let thrown = null
    try {
      store.setSecret('c1', secret)
    } catch (err) {
      thrown = err
    }
    check('29. ★ cipher 为 null 时 setSecret 抛错', thrown !== null, '未抛错（可能静默存了明文）')
    check(
      '30. ★ 抛出的是 SecretStorageUnavailableError（上层可精确识别）',
      thrown !== null && thrown.name === 'SecretStorageUnavailableError',
      formatDetail(thrown?.name)
    )
    check(
      '31. [自检] SecretStorageUnavailableError 导出且可 instanceof',
      typeof SecretStorageUnavailableError === 'function' && thrown instanceof SecretStorageUnavailableError,
      formatDetail(typeof SecretStorageUnavailableError)
    )

    // ★ 最关键：拒绝保存时，磁盘上**绝对不能**出现明文。
    const allText = listFiles(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')
    check(
      '32. ★ 拒绝保存密码后，磁盘上任何文件都不含该明文',
      !allText.includes(secret),
      '明文出现在了磁盘文件里'
    )
    check(
      '33. cipher 不可用时配置仍能保存（只降级密码，不降级配置）',
      new ConnectionStore({ baseDir: dir, cipher: null }).listConnections().length === 1,
      '配置未保存'
    )
    check(
      '34. canStoreSecrets 如实反映不可用',
      store.canStoreSecrets === false,
      formatDetail(store.canStoreSecrets)
    )
  }

  // ===== 用例 9：空密码/清除密码 =====
  {
    console.log('\n── 用例 9：清除密码 ──')
    const dir = freshDir('clear')
    const cipher = new FakeCipher()
    const store = new ConnectionStore({ baseDir: dir, cipher })
    store.saveConnection('c1', makeConfig('x', '/tmp/x.db'))
    store.setSecret('c1', 'temp-password')
    check(
      '35. 先存密码可读回',
      store.getSecret('c1')?.dbPassword === 'temp-password',
      formatDetail(store.getSecret('c1'))
    )
    store.setSecret('c1', undefined)
    check('36. setSecret(undefined) 清除密码', store.getSecret('c1') === undefined, formatDetail(store.getSecret('c1')))
    store.deleteSecret('c1')
    check('37. deleteSecret 幂等（重复删除不抛）', true)
  }

  // ===== 用例 9b：具名密钥与旧版密文迁移 =====
  //
  // SSH 隧道引入了三个独立机密。这里重点钉住两件事：
  //   1. 多密钥按 key 保存，不会互相覆盖；
  //   2. 升级前存的单密码密文，仍能被识别为数据库口令。
  // 第 2 条必须**直接构造旧格式密文**，而不是用新 API 写一遍——
  // 否则测的是“新格式能读新格式”，完全没覆盖升级路径。
  {
    console.log('\n── 用例 9b：★ 具名密钥 / 旧密文兼容 ──')
    const dir = freshDir('named-secret')
    const cipher = new FakeCipher()
    const store = new ConnectionStore({ baseDir: dir, cipher })
    store.saveConnection('c1', makeConfig('SSH 连接', '/tmp/x.db'))

    store.setSecret('c1', {
      dbPassword: 'pg-pass',
      sshPassword: 'ssh-login-pass',
      sshPassphrase: 'ssh-key-pass'
    })
    const named = store.getSecret('c1')
    check(
      '37a. ★ 三个具名机密同时保存且互不覆盖',
      named?.dbPassword === 'pg-pass' &&
        named?.sshPassword === 'ssh-login-pass' &&
        named?.sshPassphrase === 'ssh-key-pass',
      formatDetail(named)
    )
    const namedText = readFileSync(store.secretsPath, 'utf8')
    check(
      '37b. ★ 三个明文都没有出现在 secrets.json',
      !namedText.includes('pg-pass') &&
        !namedText.includes('ssh-login-pass') &&
        !namedText.includes('ssh-key-pass'),
      namedText.slice(0, 300)
    )

    // 手工写一条旧版格式：secrets.json 的 value 是“对原始密码字符串加密”。
    const oldDir = freshDir('old-secret')
    const oldCipher = new FakeCipher()
    const oldStore = new ConnectionStore({ baseDir: oldDir, cipher: oldCipher })
    oldStore.saveConnection('c1', makeConfig('旧连接', '/tmp/old.db'))
    writeFileSync(
      oldStore.secretsPath,
      JSON.stringify({ c1: oldCipher.encrypt('legacy-password').toString('base64') }),
      'utf8'
    )
    const migrated = new ConnectionStore({ baseDir: oldDir, cipher: oldCipher }).getSecret('c1')
    check(
      '37c. ★ 旧版单密码密文按 dbPassword 读出',
      migrated?.dbPassword === 'legacy-password' && migrated?.sshPassword === undefined,
      formatDetail(migrated)
    )

    // 反向断言：如果密码本身恰好是一段 JSON，也不能被误判成新格式。
    const jsonLike = '{"dbPassword":"should-not-be-parsed"}'
    const jsonDir = freshDir('json-secret')
    const jsonCipher = new FakeCipher()
    const jsonStore = new ConnectionStore({ baseDir: jsonDir, cipher: jsonCipher })
    jsonStore.saveConnection('c1', makeConfig('JSON 密码', '/tmp/json.db'))
    writeFileSync(
      jsonStore.secretsPath,
      JSON.stringify({ c1: jsonCipher.encrypt(jsonLike).toString('base64') }),
      'utf8'
    )
    check(
      '37d. ★ 形如 JSON 的旧密码不会被误解析',
      new ConnectionStore({ baseDir: jsonDir, cipher: jsonCipher }).getSecret('c1')?.dbPassword ===
        jsonLike,
      formatDetail(new ConnectionStore({ baseDir: jsonDir, cipher: jsonCipher }).getSecret('c1'))
    )

    store.setSecret('c1', { sshPassword: 'ssh-only' })
    check(
      '37e. setSecret 是整组替换（合并策略属于 Manager，不偷偷保留旧 dbPassword）',
      store.getSecret('c1')?.dbPassword === undefined &&
        store.getSecret('c1')?.sshPassword === 'ssh-only',
      formatDetail(store.getSecret('c1'))
    )
  }

  // ===== 用例 9c：按 key 合并（编辑连接不能误删另一类凭据） =====
  {
    console.log('\n── 用例 9c：具名密钥合并 ──')
    const { mergeSecrets } = mod
    if (typeof mergeSecrets !== 'function') {
      skip('46 及之后的密钥合并断言', 'probe-entry 未导出 mergeSecrets')
    } else {
      const base = {
        dbPassword: 'pg-pass',
        sshPassword: 'ssh-pass',
        sshPassphrase: 'key-pass'
      }
      const changed = mergeSecrets(base, { sshPassword: 'new-ssh-pass' })
      check(
        '46. ★ 只改 SSH 口令时，数据库口令与私钥口令都保留',
        changed.dbPassword === 'pg-pass' &&
          changed.sshPassword === 'new-ssh-pass' &&
          changed.sshPassphrase === 'key-pass',
        formatDetail(changed)
      )
      const cleared = mergeSecrets(base, { sshPassword: '' })
      check(
        '46a. ★ 显式空串只删除对应 key，不误删数据库口令',
        cleared.dbPassword === 'pg-pass' &&
          cleared.sshPassword === undefined &&
          cleared.sshPassphrase === 'key-pass',
        formatDetail(cleared)
      )
      const dbOnly = mergeSecrets(base, 'new-pg-pass')
      check(
        '46b. 字符串补丁只替换 dbPassword，SSH 机密保留',
        dbOnly.dbPassword === 'new-pg-pass' &&
          dbOnly.sshPassword === 'ssh-pass' &&
          dbOnly.sshPassphrase === 'key-pass',
        formatDetail(dbOnly)
      )
      const untouched = mergeSecrets(base, undefined)
      check(
        '46c. 不传补丁时整组保留（编辑仅改配置的路径）',
        JSON.stringify(untouched) === JSON.stringify(base),
        formatDetail(untouched)
      )
    }
  }

  // ===== 用例 10：多实例并发写不互相踩（temp 名唯一） =====
  {
    console.log('\n── 用例 10：同一目录两个 store 实例不互相破坏 ──')
    const dir = freshDir('concurrent')
    const cipher = new FakeCipher()
    const a = new ConnectionStore({ baseDir: dir, cipher })
    const b = new ConnectionStore({ baseDir: dir, cipher })
    a.saveConnection('c1', makeConfig('A 的', '/tmp/a.db'))
    b.saveConnection('c2', makeConfig('B 的', '/tmp/b.db'))
    // 两个实例各自只知道自己写的那条——这是"内存镜像"的已知语义，
    // 关键不是它俩能合并，而是**文件不会被写坏**、且没有 .tmp 残留。
    const reopened = new ConnectionStore({ baseDir: dir, cipher })
    let parseOk = true
    try {
      JSON.parse(readFileSync(reopened.connectionsPath, 'utf8'))
    } catch {
      parseOk = false
    }
    check('38. 并发写后文件仍是合法 JSON（没被写坏）', parseOk, '文件解析失败')
    check('39. 并发写后无 .tmp 残留', findTmpFiles(dir).length === 0, formatDetail(findTmpFiles(dir)))
    check(
      '40. 最后一次写入生效（后写者的内容被完整保存）',
      reopened.getConnection('c2') !== undefined,
      formatDetail(reopened.listConnections())
    )
  }

  // ===== 用例 11：secretStored 三态（null / true / false） =====
  //
  // 这个字段的取值取决于「方言是否有 password 字段」+「密文是否真的存下来了」。
  // 单测一种取值没有意义：必须三种都出现，才能证明判定逻辑真的在起作用，
  // 而不是恰好某个分支写死成了常量。
  {
    console.log('\n── 用例 11：★ secretStored 三态（null / true / false） ──')

    const createManagerWithInjected = mod.createManagerWithInjected
    if (typeof createManagerWithInjected !== 'function') {
      skip('41 及之后的 secretStored 断言', 'probe-entry 未导出 createManagerWithInjected')
    } else {
      const quoting = { open: '"', close: '"', escape: 'double' }

      // 一个**带 password 字段**的假方言（真实 SQLite 没有，故必须自造）。
      const passwordDialect = {
        id: 'fake-pw',
        name: 'FakePasswordDb',
        fields: [
          { key: 'host', label: '主机', kind: 'text', required: true },
          { key: 'password', label: '密码', kind: 'password', required: false }
        ],
        quoting
      }
      // 一个**没有 password 字段**的方言，模拟 SQLite 文件库。
      const noPasswordDialect = {
        id: 'fake-nopw',
        name: 'FakeFileDb',
        fields: [{ key: 'file', label: '文件', kind: 'file', required: true }],
        quoting
      }

      const cipherFor = () => new FakeCipher()
      const pwConfig = (name) => ({
        dialectId: 'fake-pw',
        name,
        options: { host: 'db.example.com' }
      })
      const fileConfig = (name) => ({
        dialectId: 'fake-nopw',
        name,
        options: { file: '/tmp/x.db' }
      })

      // ---- A. 无 password 字段的方言 → null ----
      {
        const dir = freshDir('ss-null')
        const store = new ConnectionStore({ baseDir: dir, cipher: cipherFor() })
        const mgr = createManagerWithInjected([noPasswordDialect], store)
        // 不真连（假方言没有真宿主），直接落配置后看 list()。
        // add 会尝试 spawn 宿主并失败，但配置已存 → 正好验证"失败但 persisted"。
        const summary = await mgr.add(fileConfig('文件库'))
        check(
          '41. 无 password 字段的方言 → secretStored === null',
          summary.secretStored === null,
          formatDetail(summary.secretStored)
        )
        check(
          '41a. 同上 list() 里也返回 null（两条路径一致）',
          mgr.list().find((s) => s.id === summary.id)?.secretStored === null,
          formatDetail(mgr.list())
        )
        await mgr.disposeAll().catch(() => undefined)
      }

      // ---- B. 有 password 字段 + cipher 可用 + 密码存下了 → true ----
      {
        const dir = freshDir('ss-true')
        const store = new ConnectionStore({ baseDir: dir, cipher: cipherFor() })
        const mgr = createManagerWithInjected([passwordDialect], store)
        const summary = await mgr.add(pwConfig('带密码库'), 'hunter2')
        check(
          '42. ★ 有 password 字段 + cipher 可用 → secretStored === true',
          summary.secretStored === true,
          formatDetail(summary.secretStored)
        )
        check(
          '42a. 配置同时 persisted === true（两者独立）',
          summary.persisted === true,
          formatDetail(summary.persisted)
        )
        // 重新载入（模拟重启）：密文还在 → 仍为 true。
        const store2 = new ConnectionStore({ baseDir: dir, cipher: cipherFor() })
        const mgr2 = createManagerWithInjected([passwordDialect], store2)
        check(
          '42b. ★ 重启后（新 store 载入）secretStored 仍为 true',
          mgr2.list()[0]?.secretStored === true,
          formatDetail(mgr2.list())
        )
        await mgr.disposeAll().catch(() => undefined)
      }

      // ---- C. 有 password 字段 + cipher 不可用 → false，但 persisted 仍 true ----
      {
        const dir = freshDir('ss-false')
        // cipher: null = 系统不支持安全存储
        const store = new ConnectionStore({ baseDir: dir, cipher: null })
        const mgr = createManagerWithInjected([passwordDialect], store)
        const summary = await mgr.add(pwConfig('无加密环境'), 'hunter2')
        check(
          '43. ★ 有 password 字段 + cipher 不可用 → secretStored === false',
          summary.secretStored === false,
          formatDetail(summary.secretStored)
        )
        check(
          '43a. ★ 此时配置仍 persisted === true（"存了配置但没存密码"这个状态）',
          summary.persisted === true,
          formatDetail(summary.persisted)
        )
        // 关键：磁盘上不该有明文（cipher 不可用 + 拒绝保存）。
        const allText = listFiles(dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => readFileSync(join(dir, f), 'utf8'))
          .join('\n')
        check(
          '43b. ★ cipher 不可用时密码明文未落盘',
          !allText.includes('hunter2'),
          '明文出现在磁盘文件里'
        )
        await mgr.disposeAll().catch(() => undefined)
      }

      // ---- D. listChildren 的 connection meta 必须带上两个字段 ----
      // 这是 Lead 指出的 UI 契约漏洞：漏传会让 UI 永远显示"未保存"。
      {
        const dir = freshDir('ss-meta')
        const store = new ConnectionStore({ baseDir: dir, cipher: null })
        const mgr = createManagerWithInjected([passwordDialect], store)
        const summary = await mgr.add(pwConfig('meta 检查'), 'x')
        const children = await mgr.listChildren(null)
        const node = children.find((n) => n.id === `connection:${summary.id}`)
        check(
          '44. ★ listChildren 的 connection 节点 meta 含 persisted 字段',
          node !== undefined && node.meta !== undefined && 'persisted' in node.meta,
          formatDetail(node?.meta)
        )
        check(
          '44a. ★ meta.persisted === true（UI 据此显示"已保存"）',
          node?.meta?.['persisted'] === true,
          formatDetail(node?.meta?.['persisted'])
        )
        check(
          '44b. ★ meta.secretStored === false（cipher 不可用；UI 据此告警）',
          node?.meta?.['secretStored'] === false,
          formatDetail(node?.meta?.['secretStored'])
        )
        // meta 的值必须可跨进程（结构化克隆）：只允许 string|number|boolean|null。
        check(
          '44c. meta 里所有值都是可序列化的原始类型',
          node?.meta !== undefined &&
            Object.values(node.meta).every(
              (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
            ),
          formatDetail(node?.meta)
        )
        await mgr.disposeAll().catch(() => undefined)
      }

      // ---- E. 三态齐全自检 ----
      // 单独一条：确认这一组用例真的覆盖了三种取值，而不是三个都测了个 null。
      {
        const seen = new Set()
        const dirA = freshDir('ss-cover-a')
        const sA = new ConnectionStore({ baseDir: dirA, cipher: cipherFor() })
        const mA = createManagerWithInjected([noPasswordDialect], sA)
        seen.add((await mA.add(fileConfig('a'))).secretStored)
        await mA.disposeAll().catch(() => undefined)

        const dirB = freshDir('ss-cover-b')
        const sB = new ConnectionStore({ baseDir: dirB, cipher: cipherFor() })
        const mB = createManagerWithInjected([passwordDialect], sB)
        seen.add((await mB.add(pwConfig('b'), 'pw')).secretStored)
        await mB.disposeAll().catch(() => undefined)

        const dirC = freshDir('ss-cover-c')
        const sC = new ConnectionStore({ baseDir: dirC, cipher: null })
        const mC = createManagerWithInjected([passwordDialect], sC)
        seen.add((await mC.add(pwConfig('c'), 'pw')).secretStored)
        await mC.disposeAll().catch(() => undefined)

        check(
          '45. [自检] 三态取值 {null,true,false} 全部出现过（不是只测一种）',
          seen.has(null) && seen.has(true) && seen.has(false),
          `实际观测到的取值集合: ${formatDetail([...seen])}`
        )
      }
    }
  }

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.passed)
  const skipped = results.filter((r) => r.skipped)
  const passed = results.length - failed.length
  console.log('\n' + '='.repeat(70))
  console.log(`汇总: ${passed}/${results.length} PASS, ${failed.length} FAIL, ${skipped.length} SKIP`)
  if (skipped.length > 0) {
    console.log('跳过项:')
    for (const s of skipped) console.log(`  ⚠ ${s.name} — ${formatDetail(s.detail)}`)
  }
  if (failed.length > 0) {
    console.log('失败项:')
    for (const f of failed)
      console.log(`  ✗ ${f.name}${f.detail !== undefined ? ` — ${formatDetail(f.detail)}` : ''}`)
  }
  console.log('='.repeat(70))

  process.exit(failed.length === 0 ? 0 : 1)
}

function makeSecretFor(id) {
  return `secret-for-${id}-${Math.random().toString(36).slice(2, 8)}`
}

main().catch((err) => {
  console.error('[e2e-persist] 未捕获的顶层异常:', err)
  process.exit(1)
})
