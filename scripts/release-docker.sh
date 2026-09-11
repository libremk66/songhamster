#!/usr/bin/env bash
# ============================================================
# 构建 SongFerry 镜像并推送到 Docker Hub
#
# 用法（需要 docker 权限，本机 docker 只允许 root，所以用 sudo）：
#   sudo bash scripts/release-docker.sh                 # 默认推 libremk66/songferry
#   sudo bash scripts/release-docker.sh <dockerhub用户名>
#
# 首次使用请先登录（用 Docker Hub 的 Access Token 当密码，不是账号密码）：
#   sudo docker login -u <用户名>
#
# 推送两个标签：<用户名>/songferry:latest 和 :<package.json 版本号>
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

DOCKERHUB_USER="${1:-libremk66}"
IMAGE="${DOCKERHUB_USER}/songferry"
VERSION="$(grep -m1 '"version"' package.json | sed 's/.*: *"\([^"]*\)".*/\1/')"

echo "==> 目标镜像：${IMAGE}:latest 与 ${IMAGE}:${VERSION}"

# 1) docker 可用性
command -v docker >/dev/null || { echo "❌ 找不到 docker 命令"; exit 1; }
docker info >/dev/null 2>&1 || { echo "❌ 连不上 docker daemon（需要 sudo？）"; exit 1; }

# 2) 登录状态
LOGGED_IN="$(docker info 2>/dev/null | sed -n 's/^ *Username: //p' | head -1 || true)"
if [ -z "${LOGGED_IN}" ]; then
  echo "⚠️  未登录 Docker Hub —— 请先执行：docker login -u ${DOCKERHUB_USER}（密码填 Access Token）"
  exit 1
fi
echo "==> 已登录为：${LOGGED_IN}"

# 3) 构建（复用缓存；改代码后只需几十秒）
echo "==> 构建中…"
docker build -t "${IMAGE}:latest" -t "${IMAGE}:${VERSION}" .

# 4) 推送
echo "==> 推送 latest…"
docker push "${IMAGE}:latest"
echo "==> 推送 ${VERSION}…"
docker push "${IMAGE}:${VERSION}"

# 5) 冒烟验证（临时容器，只验证能起来 + /healthz）
echo "==> 冒烟验证…"
docker rm -f songferry-smoke >/dev/null 2>&1 || true
docker run -d --name songferry-smoke -p 8936:8935 \
  -e SONGFERRY_AUTH_USER=admin -e SONGFERRY_AUTH_PASSWORD=change-me \
  "${IMAGE}:${VERSION}" >/dev/null
sleep 6
if curl -sf -m 10 http://127.0.0.1:8936/healthz; then
  echo ""
  echo "✅ 冒烟通过"
else
  echo "❌ /healthz 未响应 —— 查看日志：docker logs songferry-smoke"
  docker logs --tail 30 songferry-smoke || true
fi
docker rm -f songferry-smoke >/dev/null 2>&1 || true

echo ""
echo "🎉 完成：https://hub.docker.com/r/${DOCKERHUB_USER}/songferry"
echo "   拉取：docker pull ${IMAGE}:latest"
