#!/usr/bin/env bash
# 检查 out/ 产物是否比 src/ 新——GUI 测试跑的是 out/renderer 产物，
# 如果改了 src 但没重新 `pnpm run build`，测试实际验证的是**旧代码**。
#
# 这个坑真实踩过：改了 renderer 后只跑了 `build:driver-host`，
# GUI 测试"通过"了，但其实跑的是上一次的产物。
#
# 用法：在跑任何 GUI 测试前 source 或直接执行它。

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d out/renderer ]; then
  echo "❌ out/renderer 不存在，请先 pnpm run build"
  exit 1
fi

# 找 src/renderer 下最新的文件与 out/renderer 下最新的产物比时间
newest_src=$(find src/renderer -newer out/renderer/index.html -type f 2>/dev/null | head -1)
if [ -n "$newest_src" ]; then
  echo "⚠️  检测到 renderer 源码比构建产物新：$newest_src"
  echo "    GUI 测试会跑旧产物。请先执行： pnpm run build"
  exit 1
fi

newest_src_host=$(find src/driver-host src/drivers src/core -newer out/driver-host/index.js -type f 2>/dev/null | head -1)
if [ -n "$newest_src_host" ]; then
  echo "⚠️  检测到驱动侧源码比产物新：$newest_src_host"
  echo "    请先执行： pnpm run build"
  exit 1
fi

echo "✅ 构建产物是最新的"
