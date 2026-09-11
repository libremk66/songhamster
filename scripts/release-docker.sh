#!/usr/bin/env bash
# ============================================================
# 构建 SongFerry 镜像并推送到 Docker Hub
#
# 用法（需要 docker 权限，本机 docker 只允许 root，所以用 sudo）：
#   sudo bash scripts/release-docker.sh                      # 多架构 linux/amd64,linux/arm64
#   sudo bash scripts/release-docker.sh --single             # 只构建当前机器架构（快，约 1-2 分钟）
#   sudo bash scripts/release-docker.sh <dockerhub用户名>     # 换命名空间
#
# 首次使用请先登录（密码用 Docker Hub 的 Access Token，不是账号密码）：
#   sudo docker login -u libremk66
#
# 推送两个标签：<用户名>/songferry:latest 和 :<package.json 版本号>
#
# 多架构说明：arm64 那一路靠 QEMU 模拟编译（better-sqlite3 原生模块要现场编译），
# 首次构建较慢（可能 10~30 分钟），之后有层缓存会快很多。
# 只想更新 amd64（比如只改了几行前端）用 --single。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SINGLE=""
ARGS=()
for a in "$@"; do
  case "$a" in
    --single) SINGLE=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
DOCKERHUB_USER="${ARGS[0]:-libremk66}"
IMAGE="${DOCKERHUB_USER}/songferry"
VERSION="$(grep -m1 '"version"' package.json | sed 's/.*: *"\([^"]*\)".*/\1/')"
PLATFORMS="linux/amd64,linux/arm64"

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

if [ -n "${SINGLE}" ]; then
  # ---------- 单架构：经典 build + push（最快，产出当前机器架构） ----------
  echo "==> 单架构构建（$(docker version -f '{{.Server.Arch}}')）…"
  docker build -t "${IMAGE}:latest" -t "${IMAGE}:${VERSION}" .
  docker push "${IMAGE}:latest"
  docker push "${IMAGE}:${VERSION}"
else
  # ---------- 多架构：buildx + QEMU，构建并直接推送 ----------
  if ! docker buildx version >/dev/null 2>&1; then
    echo "❌ 没有 docker buildx（Docker 19.03+ 自带，请检查安装）"; exit 1
  fi
  if ! docker buildx inspect multiarch >/dev/null 2>&1; then
    echo "==> 创建多架构构建器 multiarch…"
    docker buildx create --name multiarch --driver docker-container >/dev/null
  fi
  docker buildx use multiarch >/dev/null
  # QEMU binfmt：让 x86 机器能跑 arm64 的构建步骤（幂等，已装会直接返回）
  if ! docker buildx inspect multiarch | grep -qi 'linux/arm64'; then
    echo "==> 安装 QEMU（arm64 模拟）…"
    docker run --privileged --rm tonistiigi/binfmt --install arm64
    docker buildx inspect --bootstrap multiarch >/dev/null
  fi
  echo "==> 多架构构建并推送（${PLATFORMS}）—— arm64 一路是模拟编译，首次较慢…"
  docker buildx build \
    --platform "${PLATFORMS}" \
    -t "${IMAGE}:latest" -t "${IMAGE}:${VERSION}" \
    --provenance=false \
    --push .
fi

# 3) 冒烟验证（拉远端镜像起临时容器，验证推送结果真的可用）
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
[ -n "${SINGLE}" ] && echo "   本次仅推了当前机器架构；需要 arm64 请再跑一次不带 --single 的多架构构建"
exit 0
