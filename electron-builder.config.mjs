/**
 * electron-builder 打包配置。
 *
 * ===== 三个关键点，每个都对应一个真实的坑 =====
 *
 * 1. **`asarUnpack` 必须放出 driver-host**
 *    驱动宿主是一个被 `child_process.spawn` 拉起的独立 Node 脚本。
 *    app.asar 是个归档文件，**里面的文件不能被 spawn 执行**——
 *    不 unpack 的话，应用启动时 `resolveDriverHostScript()` 能找到路径，
 *    但 spawn 会报 ENOENT/EACCES，表现为"连不上任何数据库"。
 *    `src/main/DriverHostHandle.ts` 里已经预留了
 *    `app.asar.unpacked/out/driver-host/index.js` 这个候选路径，与此处对应。
 *
 * 2. **只打包 out/，不打包 src/ 与 node_modules 里的开发依赖**
 *    electron-vite 已经把 main/preload/renderer 各自 bundle 成单文件，
 *    运行时不需要 src；`files` 白名单可以显著减小安装包体积。
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
 */

// 有证书（CSC_LINK）才签名。没有就保持未签名行为，与本轮之前完全一致。
const hasSigningIdentity = Boolean(process.env.CSC_LINK)

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'tools.dbstudio.app',
  productName: 'dbstudio',

  // 产物目录（不进 git，见 .gitignore）
  directories: {
    output: 'release',
    buildResources: 'build'
  },

  // 只收构建产物与运行必需文件
  files: [
    'out/**/*',
    '!out/**/*.map', // sourcemap 在发行包里没意义，体积还不小
    'package.json'
  ],

  // ★ 关键：把驱动宿主从 asar 里解出来，否则无法被 spawn
  asarUnpack: ['out/driver-host/**'],

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
