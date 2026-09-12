#!/usr/bin/env bash
# 模板自检：这个项目的 Eta 不认 <%# 注释语法，写了会让整个模板解析失败（页面 500）。
# 踩过三次，固化成脚本。用法：bash scripts/check-templates.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if grep -rn "<%#" src/views/ 2>/dev/null; then
  echo ""
  echo "❌ 发现 <%# 注释 —— 请改成 HTML 注释 <!-- ... -->"
  exit 1
fi
echo "✅ 模板自检通过（无 <%# 注释）"
