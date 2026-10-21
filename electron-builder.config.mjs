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
 * 3. **macOS 不做签名公证**
 *    本机没有开发者证书（`security find-identity` 为 0）。
 *    产物是"未签名"的：自己机器能直接跑，别人下载会被 Gatekeeper 拦，
 *    需要右键 → 打开（或 `xattr -dr com.apple.quarantine`）。
 *    这是刻意接受的取舍——拿到苹果开发者账号（$99/年）后加 `notarize` 即可。
 */

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
    // 未签名（见文件头第 3 点）
    identity: null
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
