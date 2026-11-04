/**
 * 架构护栏：用可执行的规则锁住分层边界。
 *
 * ===== 为什么需要这份检查 =====
 *
 * 本项目的核心承诺是「驱动跑在独立进程里」。这条承诺不是靠注释维持的，
 * 而是靠两条不可见的边界：
 *
 *   1. renderer / backend 只能依赖 `core` 与 `backend-client`，不能碰
 *      Electron、Node 内置模块、主进程或驱动实现；
 *   2. 主进程只能读取驱动的**纯元数据**（`dialect-metadata` / `info`），
 *      绝不能顺着 `drivers/index` 把 adapter 打进主进程 bundle。
 *
 * 这两条一旦被破坏，代码依然能编译、测试依然能绿——只是隔离悄悄失效了。
 * 这类失败最难发现，所以必须变成显式的检查。
 *
 * ===== 为什么不用正则 =====
 *
 * 注释和字符串里出现 `import electron` 是合法的（本仓库大量注释在解释这些边界）。
 * 正则会把它们当成违规，制造假阳性；而为了让假阳性消失，人们会开始放宽规则，
 * 最终护栏形同虚设。这里用 TypeScript 自身的 AST，只看真正的 import 与属性访问。
 *
 * ===== 负例自检 =====
 *
 * 一个「永远返回 0」的检查器和没有检查器是一样的。所以脚本启动时先用
 * 合成源码跑一组负例：每条规则都必须能抓到它应该抓的东西，并且不能误伤
 * 合法写法（尤其是 `backend-client.ts` 的例外）。自检失败时直接退出 1，
 * 不进入真实扫描。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = resolve(ROOT, 'src')
const RENDERER = resolve(SRC, 'renderer')
const BACKEND = resolve(SRC, 'backend')
const MAIN = resolve(SRC, 'main')
const PRELOAD = resolve(SRC, 'preload')
const DRIVER_HOST = resolve(SRC, 'driver-host')
const DRIVERS = resolve(SRC, 'drivers')

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const NODE_BUILTINS = new Set(builtinModules)

/** renderer / backend 一律不可依赖的目录。 */
const RENDERER_FORBIDDEN_DIRS = [
  [MAIN, '主进程'],
  [PRELOAD, 'preload'],
  [DRIVER_HOST, '驱动宿主'],
  [DRIVERS, '驱动实现']
]

/**
 * 主进程允许 import 的驱动文件：只允许纯数据。
 *
 * 与 `src/drivers/dialect-metadata.ts` 的注释保持一致：
 *   - `dialect-metadata.ts` 是方言元数据的汇总出口；
 *   - 各驱动的 `info.ts` 是纯数据文件；
 *   - `index.ts` / `adapter.ts` / 驱动目录入口都带实现，一律禁止。
 */
const MAIN_DRIVER_DATA_ALLOWLIST = [/\/dialect-metadata(?:\.[^/]*)?$/, /\/info(?:\.[^/]*)?$/]

/** 把相对路径判断为「位于某目录内」，不依赖文件是否真实存在。 */
function isInside(child, parent) {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isNodeBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true
  return NODE_BUILTINS.has(specifier.split('/')[0])
}

/** 解析相对 import 或项目内 `@core` / `@drivers` 别名；包名返回 null。 */
function resolveSpecifier(filePath, specifier) {
  if (specifier.startsWith('.')) return resolve(dirname(filePath), specifier)
  if (specifier.startsWith('@core/')) return resolve(SRC, 'core', specifier.slice('@core/'.length))
  if (specifier.startsWith('@drivers/')) return resolve(SRC, 'drivers', specifier.slice('@drivers/'.length))
  return null
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

/** 收集所有静态 import / export-from / require / 动态 import 的模块说明符。 */
function collectModuleReferences(sourceFile) {
  const references = []
  const add = (node, specifier) => {
    if (typeof specifier === 'string' && specifier.length > 0) {
      references.push({ specifier, line: lineOf(sourceFile, node) })
    }
  }

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node, node.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node, node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node, node.moduleReference.expression.text)
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const [first] = node.arguments
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if ((isDynamicImport || isRequire) && ts.isStringLiteral(first)) {
        add(node, first.text)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return references
}

/** 去掉 `(...)`、`as`、`<...>`、`!`、`satisfies` 包装，拿到真正的表达式。 */
function unwrapExpression(node) {
  let current = node
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression
  }
  return current
}

function isGlobalBackendRoot(node) {
  const expression = unwrapExpression(node)
  return (
    expression &&
    ts.isIdentifier(expression) &&
    (expression.text === 'window' || expression.text === 'globalThis')
  )
}

/** 收集 `window.dbstudio` / `window['dbstudio']` / `globalThis.dbstudio`。 */
function collectDirectBackendReads(sourceFile) {
  const reads = []
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'dbstudio' &&
      isGlobalBackendRoot(node.expression)
    ) {
      reads.push({ line: lineOf(sourceFile, node) })
    } else if (ts.isElementAccessExpression(node) && isGlobalBackendRoot(node.expression)) {
      const [argument] = node.argumentExpression ? [node.argumentExpression] : []
      if (
        argument &&
        (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
        argument.text === 'dbstudio'
      ) {
        reads.push({ line: lineOf(sourceFile, node) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return reads
}

/** `backend-client.ts` 是唯一允许直接访问 transport 的文件。 */
function isBackendClient(filePath) {
  return resolve(filePath) === resolve(BACKEND, 'backend-client.ts')
}

function forbiddenImportReason(layer, filePath, specifier) {
  if (specifier === 'electron') {
    return `${layer} 不得依赖 electron（桌面能力必须经 backend-client 暴露）`
  }
  if (isNodeBuiltin(specifier)) {
    return `${layer} 不得依赖 Node 内置模块 ${specifier}（渲染进程没有 Node 运行时）`
  }
  const resolved = resolveSpecifier(filePath, specifier)
  if (!resolved) return null
  for (const [dir, label] of RENDERER_FORBIDDEN_DIRS) {
    if (isInside(resolved, dir)) return `${layer} 不得依赖${label}（${relative(ROOT, dir)}）`
  }
  return null
}

/**
 * 分析一段源码。
 *
 * 之所以把「文件内容」作为入参，而不是直接读磁盘：自检要用合成源码
 * 验证规则本身，真实扫描与自检必须走完全相同的代码路径，否则自检证明不了什么。
 */
export function analyzeSource(filePath, content) {
  const absolute = resolve(filePath)
  const sourceFile = ts.createSourceFile(
    absolute,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const violations = []
  const inRenderer = isInside(absolute, RENDERER)
  const inBackend = isInside(absolute, BACKEND)
  const inMain = isInside(absolute, MAIN)
  const inDriverHost = isInside(absolute, DRIVER_HOST)

  const push = (line, rule, message) => {
    violations.push({ file: absolute, line, rule, message })
  }

  for (const { specifier, line } of collectModuleReferences(sourceFile)) {
    if (inRenderer || inBackend) {
      const layer = inRenderer ? 'renderer' : 'backend'
      const reason = forbiddenImportReason(layer, absolute, specifier)
      if (reason) push(line, `${layer}/forbidden-import`, `${reason}：import '${specifier}'`)
    }
    if (inMain) {
      const resolved = resolveSpecifier(absolute, specifier)
      if (resolved && isInside(resolved, DRIVERS)) {
        const isPureData = MAIN_DRIVER_DATA_ALLOWLIST.some((pattern) => pattern.test(resolved))
        if (!isPureData) {
          push(
            line,
            'main/driver-implementation-import',
            `主进程只能 import 驱动纯元数据（dialect-metadata / info），` +
              `不得 import 驱动实现：import '${specifier}'。` +
              `否则 adapter 会被打进主进程 bundle，进程隔离失效。`
          )
        }
      }
    }
    if (inDriverHost && specifier === 'electron') {
      push(
        line,
        'driver-host/electron-import',
        `驱动宿主不得 import electron：它必须以独立 Node 进程运行（import '${specifier}'）`
      )
    }
  }

  if ((inRenderer || inBackend) && !isBackendClient(absolute)) {
    for (const { line } of collectDirectBackendReads(sourceFile)) {
      push(
        line,
        'renderer/direct-backend-access',
        '不得直接读取 window/globalThis.dbstudio；请通过 backend-client 的 resolveBackendClient()'
      )
    }
  }

  return violations
}

/** 递归收集需要检查的源码文件。 */
function collectFiles(directory) {
  const files = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        visit(full)
      } else if (CODE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
        if (entry.name.endsWith('.d.ts')) continue
        files.push(full)
      }
    }
  }
  visit(directory)
  return files.sort()
}

/**
 * 负例自检：每条规则都必须能抓到违规，也必须放过合法写法。
 *
 * 这里的文件路径刻意使用真实目录前缀（src/renderer/...），
 * 因为规则按目录分层；但文件本身不需要真实存在。
 */
export function runSelfTest() {
  const cases = [
    {
      name: 'renderer 直接访问 window.dbstudio 会被抓出',
      file: resolve(RENDERER, '__fixture-direct-window.ts'),
      content: `const api = window.dbstudio\n`,
      rules: ['renderer/direct-backend-access'],
      count: 1
    },
    {
      name: 'renderer 经 as 断言访问 globalThis.dbstudio 也会被抓出',
      file: resolve(RENDERER, '__fixture-direct-global.ts'),
      content: `const api = (globalThis as unknown as Record<string, unknown>).dbstudio\n`,
      rules: ['renderer/direct-backend-access'],
      count: 1
    },
    {
      name: 'renderer 的 window.dbstudioGuardTransactions 不是违规',
      file: resolve(RENDERER, '__fixture-other-property.ts'),
      content: `window.dbstudioGuardTransactions = async () => true\n`,
      rules: [],
      count: 0
    },
    {
      name: 'backend-client.ts 允许直接访问 transport',
      file: resolve(BACKEND, 'backend-client.ts'),
      content: `const api = (globalThis as unknown as { dbstudio?: unknown }).dbstudio\n`,
      rules: [],
      count: 0
    },
    {
      name: 'renderer import electron 会被抓出',
      file: resolve(RENDERER, '__fixture-electron.ts'),
      content: `import { ipcRenderer } from 'electron'\n`,
      rules: ['renderer/forbidden-import'],
      count: 1
    },
    {
      name: 'renderer import Node 内置模块会被抓出',
      file: resolve(RENDERER, '__fixture-node.ts'),
      content: `import { readFileSync } from 'node:fs'\n`,
      rules: ['renderer/forbidden-import'],
      count: 1
    },
    {
      name: 'renderer import 驱动实现会被抓出',
      file: resolve(RENDERER, '__fixture-driver.ts'),
      content: `import '../drivers/index'\n`,
      rules: ['renderer/forbidden-import'],
      count: 1
    },
    {
      name: 'backend 动态 import 主进程会被抓出',
      file: resolve(BACKEND, '__fixture-main.ts'),
      content: `void import('../main/ConnectionManager')\n`,
      rules: ['backend/forbidden-import'],
      count: 1
    },
    {
      name: 'main import 驱动 adapter 会被抓出',
      file: resolve(MAIN, '__fixture-driver-impl.ts'),
      content: `import { createSqliteAdapter } from '../drivers/sqlite/adapter'\n`,
      rules: ['main/driver-implementation-import'],
      count: 1
    },
    {
      name: 'main import drivers/index 会被抓出',
      file: resolve(MAIN, '__fixture-driver-index.ts'),
      content: `import { registerBuiltinDrivers } from '../drivers'\n`,
      rules: ['main/driver-implementation-import'],
      count: 1
    },
    {
      name: 'main import 驱动纯元数据是允许的',
      file: resolve(MAIN, '__fixture-driver-metadata.ts'),
      content: `import { BUILTIN_DIALECT_METADATA } from '../drivers/dialect-metadata'\nimport { SQLITE_INFO } from '../drivers/sqlite/info'\n`,
      rules: [],
      count: 0
    },
    {
      name: 'driver-host import electron 会被抓出',
      file: resolve(DRIVER_HOST, '__fixture-electron.ts'),
      content: `const { app } = require('electron')\n`,
      rules: ['driver-host/electron-import'],
      count: 1
    },
    {
      name: '注释里的 import 与 window.dbstudio 不会误报',
      file: resolve(RENDERER, '__fixture-comment.ts'),
      content: `// import { app } from 'electron'\n// const api = window.dbstudio\nconst value = 'window.dbstudio'\n`,
      rules: [],
      count: 0
    }
  ]

  const failures = []
  for (const testCase of cases) {
    const violations = analyzeSource(testCase.file, testCase.content)
    const matchedRules = new Set(violations.map((violation) => violation.rule))
    const expectedOk = testCase.rules.every((rule) => matchedRules.has(rule))
    const countOk = violations.length === testCase.count
    const noUnexpectedRule = [...matchedRules].every((rule) => testCase.rules.includes(rule))
    if (!expectedOk || !countOk || !noUnexpectedRule) {
      failures.push(
        `${testCase.name}：期望 ${testCase.rules.join(', ') || '无违规'} × ${testCase.count}，` +
          `实际 ${[...matchedRules].join(', ') || '无违规'} × ${violations.length}`
      )
    }
  }
  return { total: cases.length, failures }
}

/** 扫描真实源码。 */
export function scanArchitecture() {
  const files = [
    ...collectFiles(RENDERER),
    ...collectFiles(BACKEND),
    ...collectFiles(MAIN),
    ...collectFiles(DRIVER_HOST)
  ]
  const violations = []
  for (const file of files) {
    for (const violation of analyzeSource(file, readFileSync(file, 'utf8'))) {
      violations.push({ ...violation, relative: relative(ROOT, violation.file) })
    }
  }
  return { files, violations }
}

function printViolation(violation) {
  console.error(`  ✗ ${violation.relative}:${violation.line} [${violation.rule}]`)
  console.error(`    ${violation.message}`)
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMainModule) {
  console.log('架构检查\n')

  console.log('[1] 规则自检（负例）')
  const selfTest = runSelfTest()
  if (selfTest.failures.length > 0) {
    console.error(`  ✗ ${selfTest.failures.length}/${selfTest.total} 个自检用例失败`)
    for (const failure of selfTest.failures) console.error(`    ${failure}`)
    console.error('\n架构检查中止：规则本身已失效，真实扫描结果不可信。')
    process.exit(1)
  }
  console.log(`  ✅ ${selfTest.total} 个规则自检用例全部通过\n`)

  console.log('[2] 真实源码扫描')
  const { files, violations } = scanArchitecture()
  console.log(`  扫描 ${files.length} 个文件：src/renderer、src/backend、src/main、src/driver-host\n`)

  if (violations.length > 0) {
    console.error(`  ✗ 发现 ${violations.length} 处架构违规：\n`)
    for (const violation of violations) printViolation(violation)
    console.error('\n架构检查失败。')
    process.exit(1)
  }

  console.log('  ✅ renderer / backend 未依赖 electron、Node 内置模块、主进程或驱动实现')
  console.log('  ✅ renderer 未直接读取 window/globalThis.dbstudio（backend-client.ts 为唯一出口）')
  console.log('  ✅ main 未 import 驱动实现（仅允许 dialect-metadata / info 纯数据）')
  console.log('  ✅ driver-host 未 import electron')
  console.log(`\n架构检查通过（${files.length} 个文件）`)
}
