#!/usr/bin/env bash
# 模板自检：两个"静默炸"的写法（都实际踩过）
#   ① <%# 不是 Eta 的注释语法 → 整个模板解析失败，页面 500（踩过 3 次）
#   ② HTML 注释忘闭合（结尾写成 */ 而不是 -->）→ 浏览器把后面整段 HTML 当注释吃掉，
#      DOM 结构错乱、元素点不到（2026-09-16 日期按钮就是这么坏的，排查花了很久）
# 用法：bash scripts/check-templates.sh
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

if grep -rn "<%#" src/views/ 2>/dev/null; then
  echo ""
  echo "❌ 发现 <%# 注释 —— 请改成 HTML 注释 <!-- ... -->"
  fail=1
fi

# <!-- 开头却以 */ 收尾 = 典型的手滑（写成了 C 风格注释结尾），注释不会闭合
bad=$(grep -rn '<!--.*\*/[[:space:]]*$' src/views/ 2>/dev/null || true)
if [ -n "$bad" ]; then
  echo ""
  echo "❌ HTML 注释以 */ 结尾（应为 -->），会导致注释不闭合、后面整段 HTML 被吃掉："
  echo "$bad"
  fail=1
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "✅ 模板自检通过（无 <%# 注释、无未闭合的 <!--）"
