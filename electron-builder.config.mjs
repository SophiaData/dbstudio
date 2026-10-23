/**
 * electron-builder 打包配置。
 *
 * ===== 三个关键点，每个都对应一个真实的坑 =====
 *
 * 1. **`asarUnpack` 必须放出 driver-host 与它的运行时依赖**
 *    驱动宿主是一个被 `child_process.spawn` 拉起的独立 Node 脚本。
 *    app.asar 是个归档文件，**里面的文件不能被 spawn 执行**——
 *    不 unpack 的话，应用启动时 `resolveDriverHostScript()` 能找到路径，
 *    但 spawn 会报 ENOENT/EACCES，表现为"连不上任何数据库"。
 *    `src/main/DriverHostHandle.ts` 里已经预留了
 *    `app.asar.unpacked/out/driver-host/index.js` 这个候选路径，与此处对应。
 *
 *    同理，`node_modules` 也必须解包：驱动宿主从 `app.asar.unpacked`
 *    执行时，Node 的模块查找从**脚本真实路径**向上走；它不会自动跨回
 *    `app.asar` 里的 node_modules。实测只解包 driver-host 时，
 *    打包应用里的 `require("pg")` 仍是 MODULE_NOT_FOUND。
 *
 * 2. **只打包 out/ 与「外部化的运行时依赖」**
 *    electron-vite 已经把 main/preload/renderer 各自 bundle 成单文件，
 *    运行时不需要 src；`files` 白名单可以显著减小安装包体积。
 *
 *    ⚠️ 但驱动宿主**不是**完全自包含的：`build-driver-host.mjs` 只外置
 *    `node:` 内置模块与 electron，而 `pg` / `ssh2` 这类 CJS 依赖会被
 *    rollup 保留成 `require("pg")` / `require("ssh2")`。
 *    所以它们必须作为**运行时依赖**被真的打进包里——否则应用能启动、
 *    界面正常，但连不上任何数据库（PG 与 SSH 隧道都会 MODULE_NOT_FOUND）。
 *
 *    这正是 `files` 白名单的危险之处：写在 `package.json` 的 dependencies
 *    不等于会进包。实测旧的 0.1.0 产物里 **既没有 pg 也没有 ssh2**，
 *    意味着当时打出来的安装在真机上根本连不了 PG。
 *    下面的 `node_modules/**` 只放行 node_modules，再靠 electron-builder
 *    自身"只打包生产依赖"的行为剔除 devDependencies。
 *
 * 3. **macOS 签名/公证：已就绪，但默认关闭**
 *    本机没有开发者证书（`security find-identity` 为 0），所以**默认不签名**：
 *    产物是"未签名"的，自己机器能直接跑，别人下载会被 Gatekeeper 拦，
 *    需要右键 → 打开（或 `xattr -dr com.apple.quarantine`）。
 *
 *    === 拿到 Apple Developer 账号后怎么启用 ===
 *    只需要在 CI/本机设置这几个环境变量（不需要改本文件）：
 *      CSC_LINK                        base64 的 .p12 证书
 *      CSC_KEY_PASSWORD                .p12 密码
 *      APPLE_ID                        你的 Apple ID
 *      APPLE_APP_SPECIFIC_PASSWORD     专用密码（不是登录密码）
 *      APPLE_TEAM_ID                   Team ID
 *    本文件检测到 CSC_LINK 时会自动切到签名+公证；没有就保持 identity: null。
 *
 *    为什么要用环境变量而不是写死在文件里：
 *    证书是敏感凭据（见项目 AGENTS.md 的 A4），绝不能进 git。
 *    electron-builder 原生就认这几个变量，写死反而要额外做 secret 注入。
 *
 * 4. **跳过 native rebuild：没有任何需要编译的运行时依赖**
 *    `ssh2` 把 `cpu-features` 声明为 optionalDependency，只用于加密加速；
 *    其源码包缺少 `deps/cpu_features` 子模块，在干净环境里 node-gyp
 *    必然失败（实测 `buildcheck.gypi not found`）。而 ssh2 在它不可用时会
 *    自动退回纯 JS 实现，功能完全一致（真实 sshd e2e 已验证）。
 *    `pg` 是纯 JS，也没有 native addon。因此打包时关掉 rebuild 是准确的，
 *    不是“绕过编译错误”：本应用根本没有要重建的原生模块。
 */

// 有证书（CSC_LINK）才签名。没有就保持未签名行为，与本轮之前完全一致。
const hasSigningIdentity = Boolean(process.env.CSC_LINK)

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'tools.dbstudio.app',
  productName: 'dbstudio',

  /*
   * 不执行 @electron/rebuild。
   *
   * 保留这条而不是删掉可选依赖，是因为 pnpm 的 lockfile 仍然会为 ssh2
   * 解析 cpu-features；只是不要求它在每个架构上都能编译。若将来真的加入
   * 原生驱动，必须删掉这行并为该驱动单独配置重建，不能默默复用此设置。
   */
  npmRebuild: false,

  // 产物目录（不进 git，见 .gitignore）
  directories: {
    output: 'release',
    buildResources: 'build'
  },

  // 只收构建产物与运行必需文件
  files: [
    'out/**/*',
    '!out/**/*.map', // sourcemap 在发行包里没意义，体积还不小
    'package.json',
    // 运行时依赖必须在包里：驱动宿主用 require() 在运行时加载它们。
    'node_modules/**/*'
  ],

  // ★ 关键：宿主与运行依赖都必须从 asar 解出来。
  // 只解宿主的后果见文件头第 1 点；这是实测过的路径问题。
  asarUnpack: ['out/driver-host/**', 'node_modules/**'],

  // 各平台产物
  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      // dmg：拖进 Applications 安装
      { target: 'dmg', arch: ['arm64', 'x64'] },
      // zip：给自动更新用，也方便直接下载
      { target: 'zip', arch: ['arm64', 'x64'] }
    ],
    icon: 'build/icon.png',
    // 有证书才签名；没有则 identity: null（与应用内 Gatekeeper 提示一致）。
    identity: hasSigningIdentity ? undefined : null,
    // 以下三项只在签名时才有意义（未签名时 electron-builder 会忽略）。
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    // 公证：electron-builder 检测到 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
    // APPLE_TEAM_ID 时会自动公证。这里显式声明意图，缺凭据时它自己会跳过。
    notarize: hasSigningIdentity
      ? {
          teamId: process.env.APPLE_TEAM_ID
        }
      : false
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png'
  },

  linux: {
    target: ['AppImage'],
    category: 'Development',
    icon: 'build/icon.png'
  },

  // GitHub Release 发布配置：让 `--publish always` 能直接上传到本仓库的 Release
  publish: [
    {
      provider: 'github',
      owner: 'SophiaData',
      repo: 'dbstudio'
    }
  ]
}
