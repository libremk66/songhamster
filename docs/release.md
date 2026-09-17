# 发版流程与多架构构建（维护者备忘）

> 给未来的自己：这份文档只关心"怎么把一个版本发出去"。用户怎么部署见 [README](../README.md) 的「快速开始」。

## 一、发一版，按这个顺序

```bash
cd /home/hxsy/VIBECODING/SongHamster

# 1) 改版本号（镜像标签就是从它来的）
#    package.json 的 "version"
#    版本语义：新功能 → 中间位 +1（0.3.0 → 0.4.0）；只修 bug → 末位 +1

# 2) 补 CHANGELOG.md（新版本写在最上面）
#    格式照抄已有条目：标题、分了哪几块、每块几条

# 3) 提交并推 GitHub
git add -A && git commit -m "chore: 版本号 x.y.z（本版要点）"
#    推送要带 token（本机没配 git 凭据，见 memory/github-songhamster-push）

# 4) 构建并推送镜像（需要 sudo，docker 只允许 root）
sudo bash scripts/release-docker.sh

# 5) 验证：从 Docker Hub API 看两个架构是否都上去了（不需要 sudo）
curl -s "https://hub.docker.com/v2/repositories/libremk66/songhamster/tags?page_size=25" \
  | python3 -c "import json,sys;[print(t['name'], sorted({i['architecture'] for i in t.get('images',[])})) for t in json.load(sys.stdin)['results']]"

# 6) 打 tag + 发 Release（⚠️ tag 必须打在**构建镜像的那个提交**上，见第六节）
git tag -a v0.5.0 594eef0 -m "v0.5.0 — 一句话要点"   # 提交号 = 构建镜像时的 HEAD
git push origin v0.5.0                                # 推送要带 token（同第 3 步）
#    正文直接复用 CHANGELOG 对应段落：网页 Draft a new release，或走 API：
#    curl -X POST -H "Authorization: token $TOKEN" --data @/tmp/release.json \
#      https://api.github.com/repos/libremk66/songhamster/releases
#    （body 字段放 CHANGELOG 段落即可；draft/prerelease 都填 false）
```

脚本最后会**冒烟验证**：拉远端镜像起临时容器打 `/healthz`，通了才打印 🎉。

## 二、标签策略

| 标签 | 含义 |
|---|---|
| `x.y.z`（如 `0.4.0`） | **多架构 manifest**（amd64 + arm64），用户应该用这个 |
| `latest` | 同一个 manifest 的别名，指向最新发布的那版 |
| `x.y.z-amd64` / `x.y.z-arm64` | 单架构镜像，**manifest 的来源**，留着便于排查（用户不用管） |

- **不要改已发布版本号的内容**：要修就发新的 `x.y.z+1`（改了内容、标签没变，等于偷偷换货）
- 用户 `docker pull libremk66/songhamster:latest` 时，Docker 会**按机器架构自动选**对应的那一份
- **Docker Hub 不支持仓库重命名**：改名只能新建仓库（首次 push 时自动创建），老仓库要么留着、要么在网页上删

## 三、多架构构建踩过的坑（三个"代理盲区"）

本机在中国大陆、走 `127.0.0.1:7897` 的代理。麻烦在于 **docker 的四个角色各自认不认代理都不一样**：

| # | 谁在联网 | 认不认 dockerd 代理 | 现象 / 对策 |
|---|---|---|---|
| 1 | **dockerd** 自己（`docker pull/push`） | ✅ 认（systemd 里配了） | 正常 |
| 2 | **buildx 的 docker-container 驱动** | ❌ 不继承 | 拉基础镜像必 `connection reset` → **改用经典构建 + manifest 合并** |
| 3 | **BuildKit 解析基础镜像 tag** | ❌ 不认 | `load metadata ... connection reset` → 构建前**先 `docker pull` 把基础镜像拉进本地**（脚本里的 `prepull_base`） |
| 4 | **docker CLI**（`manifest create/push`、`login`） | ❌ 不认 | `error pinging v2 registry: connection reset` → 脚本把 dockerd 的代理 **export 给自己** |

> 判断"某个失败是哪一类"的窍门：**看它是守护进程干的活、还是 CLI 自己发的请求**。
> `pull/push` 是守护进程（吃 dockerd 的代理）；`manifest`/`login`/`buildx` 是 CLI 或独立容器（只吃环境变量）。

## 四、常见失败与对策

| 报错 | 原因 | 怎么办 |
|---|---|---|
| `failed to fetch oauth token ... connection reset`（构建期） | 基础镜像没在本地、BuildKit 直连被墙（坑 3） | 脚本已内置预拉；若仍出现，先手动 `sudo docker pull --platform linux/arm64 node:22-bookworm-slim` 再跑 |
| 同上（`manifest` 阶段） | CLI 没走代理（坑 4） | 脚本已 export；确认 `systemctl show docker --property=Environment` 里有 `HTTPS_PROXY` |
| `npm error Exit handler never called!` | 给构建**注入了宿主机代理**（容器里的 `127.0.0.1` 指向容器自己） | 别注入！脚本默认不注入（需要时用 `--with-proxy`，它会把地址换算成网桥网关） |
| arm64 构建很慢 | QEMU 模拟执行，`tsc` 也要模拟 | 正常，几分钟到十几分钟；层缓存命中后会快很多 |
| 只想重试挂掉的架构 | — | `sudo bash scripts/release-docker.sh --arch=arm64`（另加 `--with-proxy` 才注入构建期代理） |
| 冒烟失败 `/healthz` 无响应 | 容器起不来 | `docker logs songhamster-smoke` 看日志；脚本失败时会自动打印尾部日志 |

## 五、首次启动会做数据库迁移

新镜像第一次起来时会自动迁移老库（例如 0.4.0 给 `history_batch` 去外键、补任务名快照）。
无损、且只在检测到旧结构时才执行；介意的话先备份 `data/songhamster.db`（含 `-wal`/`-shm`）。

## 六、GitHub Release：发版即打 tag（2026-09-17 起）

交付物是**镜像**，但 GitHub 上也要有对应的 **tag + Release** —— 否则会出现"Docker Hub 有 0.5.0、
仓库里一个版本都没有"的对不上账：别人看仓库以为项目没版本，自己回退也没有锚点。

**规矩（三条）**

1. **tag 打在构建镜像的那个提交上** —— 不是"当前 HEAD"：构建完又提交了别的东西的话，
   `git checkout v0.5.0` 拿到的代码就和镜像里的不一致了
   （实操上最省心的顺序：**先提交完 → 再构建镜像 → 立刻打 tag**）
2. **已发布的 tag 不许移动**（跟"不许偷换已发布镜像"同理）；要改就发 `x.y.z+1`
3. **Release 正文复用 `CHANGELOG.md` 对应段落**，别另写一份

**什么时候发**

- ✅ 推了新的 `x.y.z` 镜像 → 顺手打（成本 1 分钟）
- ✅ 有别人开始用（哪怕只有一个朋友）→ "版本可追溯"立刻刚需
- ✅ **破坏性变更**（配置结构变 / 数据库迁移）→ release notes 是唯一能写清楚的地方，最刚需
- ❌ 一天推十次的开发期、纯内部重构、改错别字 —— 不必

**别等"很稳定"**：那个条件永远等不到。用上面这些可判定的触发条件代替。
