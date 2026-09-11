#!/usr/bin/env bash
# ============================================================
# 构建 SongFerry 镜像并推送到 Docker Hub
#
# 用法（需要 docker 权限，本机 docker 只允许 root，所以用 sudo）：
#   sudo bash scripts/release-docker.sh                      # 多架构 linux/amd64 + linux/arm64（默认）
#   sudo bash scripts/release-docker.sh --single             # 只构建当前机器架构（快，1-2 分钟）
#   sudo bash scripts/release-docker.sh <dockerhub用户名>     # 换命名空间
#
# 首次使用请先登录（密码用 Docker Hub 的 Access Token，不是账号密码）：
#   sudo docker login -u libremk66
#
# 产出标签：<用户名>/songferry:latest、:<版本号>，以及两个架构专用标签
#          <用户名>/songferry:<版本号>-amd64 / -arm64（manifest 合并的来源，保留便于排查）
#
# 为什么不用 docker buildx？
#   buildx 的 docker-container 驱动会把 BuildKit 跑在**独立容器**里，
#   它不继承 dockerd 的 systemd 代理设置（HTTP_PROXY），且走 docker bridge 网络，
#   结果是拉基础镜像时 connection reset by peer。
#   本脚本改用「经典构建（走 dockerd 的网络/代理，已验证可用）+ docker manifest 合并」，
#   多架构效果与 buildx 相同。arm64 由宿主已注册的 QEMU binfmt 模拟执行。
#   arm64 那一路要现场编译 better-sqlite3，首次较慢（约 10~30 分钟）。
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

build_and_push_arch() {
  local arch="$1"
  echo "==> 构建 linux/${arch} …"
  docker build --platform "linux/${arch}" -t "${IMAGE}:${VERSION}-${arch}" .
  echo "==> 推送 ${VERSION}-${arch} …"
  docker push "${IMAGE}:${VERSION}-${arch}"
}

if [ -n "${SINGLE}" ]; then
  # ---------- 单架构：经典构建 + push（最快） ----------
  HOST_ARCH="$(docker version -f '{{.Server.Arch}}' 2>/dev/null || uname -m)"
  echo "==> 单架构构建（linux/${HOST_ARCH}）…"
  docker build -t "${IMAGE}:latest" -t "${IMAGE}:${VERSION}" .
  docker push "${IMAGE}:latest"
  docker push "${IMAGE}:${VERSION}"
else
  # ---------- 多架构：两架构分别经典构建，再用 manifest 合并 ----------
  # QEMU binfmt 注册（幂等；arm64 构建要靠它模拟执行）
  if ! ls /proc/sys/fs/binfmt_misc/qemu-aarch64 >/dev/null 2>&1; then
    echo "==> 注册 QEMU binfmt（arm64 模拟）…"
    docker run --privileged --rm tonistiigi/binfmt --install arm64
  else
    echo "==> QEMU binfmt 已就绪"
  fi
  build_and_push_arch amd64
  build_and_push_arch arm64

  for tag in "${VERSION}" latest; do
    echo "==> 合并多架构标签 ${tag} …"
    docker manifest rm "${IMAGE}:${tag}" >/dev/null 2>&1 || true
    docker manifest create "${IMAGE}:${tag}" \
      "${IMAGE}:${VERSION}-amd64" "${IMAGE}:${VERSION}-arm64"
    docker manifest push --purge "${IMAGE}:${tag}"
  done
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
[ -n "${SINGLE}" ] && echo "   本次仅推了当前机器架构；要补 arm64 请再跑一次不带 --single 的完整构建"
exit 0
