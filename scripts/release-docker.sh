#!/usr/bin/env bash
# ============================================================
# 构建 SongFerry 镜像并推送到 Docker Hub
#
# 用法（需要 docker 权限，本机 docker 只允许 root，所以用 sudo）：
#   sudo bash scripts/release-docker.sh                      # 多架构 linux/amd64 + linux/arm64（默认）
#   sudo bash scripts/release-docker.sh --single             # 只构建当前机器架构（快，1-2 分钟）
#   sudo bash scripts/release-docker.sh <dockerhub用户名>     # 换命名空间
#   sudo bash scripts/release-docker.sh --arch=arm64          # 只重建/重推 arm64（另加 --with-proxy 可注入构建期代理）
#
# 首次使用请先登录（密码用 Docker Hub 的 Access Token，不是账号密码）：
#   sudo docker login -u libremk66
#
# 产出标签：<用户名>/songferry:latest、:<版本号>，以及两个架构专用标签
#          <用户名>/songferry:<版本号>-amd64 / -arm64（manifest 合并的来源，保留便于排查）
#
# 两个已知坑与对策（2026-09 实测）：
#   ① buildx 的 docker-container 驱动把 BuildKit 跑在独立容器里、不继承 dockerd 的代理，
#      拉基础镜像必 connection reset → 改用「经典构建 + docker manifest 合并」。
#   ② 经典构建里，BuildKit 的 registry 客户端**不认 HTTP_PROXY**（只认自己的直连），
#      所以构建期的 metadata 拉取会被墙 → 构建前先 docker pull 预拉基础镜像
#      （docker pull 走 dockerd 的下载器，认代理），build 时 metadata 命中本地不再联网。
#   arm64 由宿主已注册的 QEMU binfmt 模拟执行，且要现场编译 better-sqlite3，首次较慢。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SINGLE=""
ONLY_ARCH=""
WITH_PROXY=""
ARGS=()
for a in "$@"; do
  case "$a" in
    --single) SINGLE=1 ;;
    --arch=*) ONLY_ARCH="${a#--arch=}" ;;
    --with-proxy) WITH_PROXY=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
case "${ONLY_ARCH}" in
  ""|amd64|arm64) ;;
  *) echo "❌ --arch 只支持 amd64 / arm64（收到：${ONLY_ARCH}）"; exit 1 ;;
esac
DOCKERHUB_USER="${ARGS[0]:-libremk66}"
IMAGE="${DOCKERHUB_USER}/songferry"
VERSION="$(grep -m1 '"version"' package.json | sed 's/.*: *"\([^"]*\)".*/\1/')"

echo "==> 目标镜像：${IMAGE}:latest 与 ${IMAGE}:${VERSION}"

# 失败时指认卡在哪一步（arm64 那步可能要跑 10~30 分钟，静默退出最难受）
CURRENT_STEP="初始化"
trap 'rc=$?; if [ "$rc" -ne 0 ]; then echo ""; echo "❌ 失败于：${CURRENT_STEP}（退出码 ${rc}）" >&2; echo "   把这段输出发给 AI 即可定位" >&2; fi' EXIT

# 客户端侧代理（manifest 合并 / login 这类 docker CLI 自己发请求的命令）：
# ⚠️ 又踩一次——dockerd 的代理只覆盖它自己干的活（pull/push），而
#    `docker manifest create/push` 是 docker CLI **自己**直连 registry-1.docker.io 的，
#    加上 sudo 会剥掉环境变量 → 直连被墙（实测 "error pinging v2 registry: connection reset"）。
#    这里把 dockerd 配的代理 export 给脚本自身：客户端命令跑在宿主机上，
#    127.0.0.1 就是宿主机，地址无需换算。
DAEMON_PROXY_RAW="$(systemctl show docker --property=Environment 2>/dev/null | sed 's/^Environment=//' | tr ' ' '\n' | sed -n 's/^\(HTTPS_PROXY\|https_proxy\)=//p' | head -1 || true)"
if [ -z "${HTTPS_PROXY:-}" ] && [ -n "${DAEMON_PROXY_RAW}" ]; then
  export HTTPS_PROXY="${DAEMON_PROXY_RAW}" HTTP_PROXY="${DAEMON_PROXY_RAW}"
  export NO_PROXY="localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,::1"
  export no_proxy="${NO_PROXY}"
  echo "==> 客户端代理（manifest 合并用）：${DAEMON_PROXY_RAW}"
fi

# 构建期代理（默认关闭）：
# ⚠️ 教训——曾经默认注入 dockerd 的代理，结果 npm ci 直接崩（"Exit handler never called!"）：
#    dockerd 配的是 127.0.0.1:7897，那是**宿主机**的代理，而 RUN 步骤跑在容器网络里，
#    容器里的 127.0.0.1 是它自己 → 所有请求指向死地址，重试到崩。
# npm 直连 registry.npmjs.org 本来就是通的（本地/CI 多次验证），所以默认不注入。
# 确实需要时加 --with-proxy：把 127.0.0.1 换算成容器可达的网桥网关（如 172.17.0.1）。
BUILD_PROXY_ARGS=()
if [ -n "${WITH_PROXY}" ]; then
  DAEMON_ENV="$(systemctl show docker --property=Environment 2>/dev/null | sed 's/^Environment=//' || true)"
  RAW_PROXY="$(printf '%s\n' "${DAEMON_ENV}" | tr ' ' '\n' | sed -n 's/^\(HTTPS_PROXY\|https_proxy\)=//p' | head -1)"
  [ -z "${RAW_PROXY}" ] && RAW_PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
  if [ -z "${RAW_PROXY}" ]; then
    echo "⚠️  --with-proxy：没检测到代理，按直连构建"
  else
    GW="$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || echo 172.17.0.1)"
    PORT="$(printf '%s' "${RAW_PROXY}" | sed -n 's#.*:\([0-9]\+\)/*$#\1#p')"
    CONTAINER_PROXY="$(printf '%s' "${RAW_PROXY}" | sed "s#127.0.0.1#${GW}#; s#localhost#${GW}#")"
    [ -z "${PORT}" ] && CONTAINER_PROXY="${RAW_PROXY}"
    BUILD_PROXY_ARGS=(--build-arg "HTTP_PROXY=${CONTAINER_PROXY}" --build-arg "HTTPS_PROXY=${CONTAINER_PROXY}"
                      --build-arg "NO_PROXY=localhost,127.0.0.1,${GW},192.168.0.0/16,10.0.0.0/8,172.16.0.0/12")
    echo "==> 构建期代理：${CONTAINER_PROXY}（宿主机 ${RAW_PROXY} 换算成容器可达地址；仅注入 RUN 步骤，不写进镜像）"
  fi
fi

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

# Dockerfile 里的基础镜像（第一行 FROM 的镜像名）
BASE_IMAGE="$(grep -m1 '^FROM ' Dockerfile | awk '{print $2}')"

# 预拉基础镜像：docker pull 走 dockerd 的下载器（认 HTTP_PROXY），
# 拉好后 build 的 metadata 直接命中本地 → 绕开「BuildKit 直连被墙」
prepull_base() {
  local arch="$1"
  echo "==> 预拉基础镜像 ${BASE_IMAGE} (linux/${arch}) —— 走 dockerd 代理 …"
  if ! docker pull --platform "linux/${arch}" "${BASE_IMAGE}"; then
    echo "❌ 预拉失败：检查 dockerd 的代理设置（systemctl show docker --property=Environment）"
    exit 1
  fi
}

build_and_push_arch() {
  local arch="$1"
  CURRENT_STEP="预拉基础镜像 linux/${arch}"
  prepull_base "${arch}"
  CURRENT_STEP="构建 linux/${arch}（arm64 是 QEMU 模拟，10~30 分钟属正常）"
  echo "==> 构建 linux/${arch} …"
  docker build --platform "linux/${arch}" "${BUILD_PROXY_ARGS[@]}" -t "${IMAGE}:${VERSION}-${arch}" .
  CURRENT_STEP="推送 ${VERSION}-${arch}"
  echo "==> 推送 ${VERSION}-${arch} …"
  docker push "${IMAGE}:${VERSION}-${arch}"
}

if [ -n "${ONLY_ARCH}" ]; then
  # ---------- 只重建/重推单个架构（arm64 挂掉后单独重试用；不合并 manifest） ----------
  echo "==> 单架构模式：只处理 linux/${ONLY_ARCH}"
  if [ "${ONLY_ARCH}" = "arm64" ] && ! ls /proc/sys/fs/binfmt_misc/qemu-aarch64 >/dev/null 2>&1; then
    CURRENT_STEP="安装 QEMU binfmt"
    echo "==> 注册 QEMU binfmt（arm64 模拟）…"
    docker run --privileged --rm tonistiigi/binfmt --install arm64
  fi
  build_and_push_arch "${ONLY_ARCH}"
  CURRENT_STEP="完成"
  echo ""
  echo "✅ linux/${ONLY_ARCH} 已推送：${IMAGE}:${VERSION}-${ONLY_ARCH}"
  echo "   两个架构都齐了之后，再跑一次不带 --arch 的完整脚本即可合并出多架构 ${VERSION} / latest"
  exit 0
fi

if [ -n "${SINGLE}" ]; then
  # ---------- 单架构：经典构建 + push（最快） ----------
  HOST_ARCH="$(docker version -f '{{.Server.Arch}}' 2>/dev/null || uname -m)"
  prepull_base "${HOST_ARCH}"
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
    CURRENT_STEP="合并多架构标签 ${tag}（两个架构镜像已在仓库，重跑本脚本即可接续）"
    echo "==> 合并多架构标签 ${tag} …"
    docker manifest rm "${IMAGE}:${tag}" >/dev/null 2>&1 || true
    docker manifest create "${IMAGE}:${tag}" \
      "${IMAGE}:${VERSION}-amd64" "${IMAGE}:${VERSION}-arm64"
    docker manifest push --purge "${IMAGE}:${tag}"
  done
fi

# 3) 冒烟验证（拉远端镜像起临时容器，验证推送结果真的可用）
CURRENT_STEP="冒烟验证"
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
